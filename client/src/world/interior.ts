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

import { floorPlan, STOREY_M, type FloorPlan, type OrientedBox, type Room } from './floorplan.ts';
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
 * that is merely *legal* is a spawn that shudders. It was 0.5, and is what
 * it is so that a body fits the 0.82 m corridor a terrace keeps beside its
 * stair (`CORE_SHELL_M`): 0.38 twice plus a wall's half thickness is 0.84.
 */
const BODY_CLEARANCE_M = 0.38;

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

// --- Storeys -------------------------------------------------------------------

/**
 * The most storeys a stair serves. Above this a building gets a lift.
 *
 * Six because that is where the walk stops being a walk: a flight is a storey
 * of ramp, and a body climbing eighteen metres of them to reach a room it
 * could not see from the bottom has stopped playing a game about hitting
 * people. Towers have cores with lifts and terraces have stairs -- the owner's
 * own guess, and every building in Sydney agrees with it.
 */
export const STAIR_MAX_STOREYS = 6;

/**
 * The core's width across, metres: two stair lanes, or one lift cab.
 *
 * 2.2 so that each lane is 1.1 less a wall's half thickness either side --
 * 1.02 m for a body 0.7 wide, a domestic stair -- and so that the core plus a
 * corridor `CORE_MARGIN_M` wide each side fits the 4.5 m room
 * `floorplan.MIN_ROOM_M` guarantees. A terrace is 4.5 m
 * wide, and a terrace with no way upstairs is most of a suburb.
 */
export const CORE_WIDTH_M = 2.2;

/** A flight's run, metres: a storey of rise over this. Never longer than the room leaves room around. */
export const CORE_RUN_MIN_M = 5.0;
export const CORE_RUN_MAX_M = 8.0;

/**
 * Room kept clear round the core on every level, metres.
 *
 * The core is placed this far from the room's walls and the shell on the
 * ground floor, and on every floor above it the partitions are cut back to
 * `CORE_CUT_M` of it -- so that the end a flight arrives at always opens onto a
 * corridor a body fits down, whatever the plan drew up there. A stair that
 * arrives in a 30 cm slot between its own wall and a partition is the one way
 * this design could strand somebody, and this is the rule that closes it.
 */
const CORE_MARGIN_M = 1.1;
const CORE_CUT_M = 1.0;

/**
 * The landing: room kept beyond each end of a flight, metres.
 *
 * More than `CORE_MARGIN_M`, because a body coming off the top of a flight
 * at seven metres a second needs somewhere to be before it turns, and a
 * corridor the width of the side margin is a wall in the face. Costs the
 * stair in rooms under 7.8 m long, which get a lift's worth of nothing.
 */
const CORE_LANDING_M = 1.4;

/**
 * And the least the core keeps from the shell, metres.
 *
 * Less than `CORE_MARGIN_M` by the shell's inset from the outline: a room at
 * the building's edge has its wall *on* the shell, and measuring the margin
 * to the outline would refuse the stair a terrace has room for. A corridor
 * this wide less a wall's half thickness is 0.82 m, and the arrival's elbow
 * room `BODY_CLEARANCE_M` is sized to settle in it.
 */
const CORE_SHELL_M = 0.9;

/**
 * How far under the next floor a body already counts as being on it, metres.
 *
 * The feet are the one vertical fact both ends agree on, so the level is read
 * from them. Most of the way up a flight a body is still "on" the lower
 * storey -- that storey's walls apply, its shut stair end is ahead and its open
 * end behind -- and past this much of the last part it is on the next, whose
 * shut end is now behind it. 0.6 clears any jump's apex, so a body hopping on
 * a landing never flickers between two storeys' walls.
 */
export const LEVEL_TOL_M = 0.6;

export const CORE = { STAIR: 1, LIFT: 2 } as const;
export type CoreKind = (typeof CORE)[keyof typeof CORE];

/**
 * The vertical core: one per building, on every level.
 *
 * A rectangle in world metres: a centre, the unit axis of its run, and two
 * half-extents. Across is `(-lz, lx)`, a quarter turn, no trig.
 *
 * A **stair** is two lanes of ramp side by side with a wall between them.
 * Flight `f` rises one storey along the run: even flights in the lane on the
 * `-across` side from the `-run` end, odd flights in the other lane from the
 * `+run` end. So storey `k` opens onto the core at the end the flight below
 * arrives at, walks the lane up, and comes out the far end a storey higher --
 * a dog-leg stair with the landing in the room, which is what a terrace has.
 * The ends are walled where a lane at that level is not at that level's
 * height, so nothing can step onto a flight two storeys up or into a hole.
 *
 * A **lift** is a cab: three walls and a floor at whichever level you are on.
 * Stand in it and press `E`.
 */
export interface Core {
  kind: CoreKind;
  x: number;
  z: number;
  lx: number;
  lz: number;
  /** Half the run, metres. */
  hr: number;
  /** Half the width. */
  hw: number;
}

/** One walkable level: its floor, and the walls a body on it is stepped against. */
export interface Level {
  /** Floor, world metres. */
  y: number;
  rooms: readonly Room[];
  /** Everything a body on this level collides with: partitions and the core's own walls. */
  walls: readonly InteriorWall[];
  /** Drawing only; see `Interior.headers`. */
  headers: readonly InteriorWall[];
}

/**
 * Buildings with a level the plan does not know about: an observation deck.
 *
 * Keyed by `doorway.buildingSeed`, which is the building's own geometry, so a
 * retile that moves one wall a centimetre renames it and the deck goes --
 * `checkInteriors` asserts the seed still stands within a hundred metres of the
 * landmark's anchor, so that is found by the gate and not by a player.
 *
 * Sydney Tower is three landmark prisms, every one `structural` (the shaft
 * starts on the podium roof, 28 m up), so it has no street door of its own.
 * The building that does is the podium under it. Its deck is at the turret's
 * floor, 218.1 m in the bake, plus a metre so the deck is a floor and not the
 * turret's underside; a lift with a stop at every podium floor and then that.
 */
export const DECKS: ReadonlyMap<number, number> = new Map([[2945680732, 219.1]]);

export interface Interior {
  /** `doorway.buildingSeed`. The building's name, and the plan's seed. */
  seed: number;
  /** Floor of the ground storey, world metres. */
  base: number;
  /** Where the ground storey's ceiling slab starts. */
  ceilingY: number;
  /** The whole plan, every storey, as generated. */
  plan: FloorPlan;
  /**
   * Every walkable level, ground first. `levels[0]` is what `rooms`, `walls`
   * and `headers` below alias, kept because the ground floor is the one the
   * door, the furniture and the arrival all belong to.
   */
  levels: readonly Level[];
  /** The stair or the lift, or null for a building with one level. See `Core`. */
  core: Core | null;
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
/** Which of these levels a body with its feet at `feetY` is on. See `LEVEL_TOL_M`. */
export function levelIndex(levels: readonly Level[], feetY: number): number {
  let k = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].y <= feetY + LEVEL_TOL_M) k = i;
    else break;
  }
  return k;
}

const NO_BOXES: readonly PlacedBox[] = [];

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
   * that carries it is the whole list. Ground floor only, as the furniture is.
   */
  private placed: readonly PlacedBox[] = [];

  constructor(
    private readonly planes: readonly ShellPlane[],
    private readonly levels: readonly Level[],
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
  clearance(x: number, z: number, feetY = this.levels[0].y): number {
    const k = levelIndex(this.levels, feetY);
    let least = Infinity;
    for (const p of this.planes) {
      const s = p.nx * x + p.nz * z - p.d;
      if (s < least) least = s;
    }
    for (const w of this.levels[k].walls) {
      const dx = w.bx - w.ax;
      const dz = w.bz - w.az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / len2)) : 0;
      const ex = x - (w.ax + dx * t);
      const ez = z - (w.az + dz * t);
      const s = Math.sqrt(ex * ex + ez * ez) - WALL_THICK_M / 2;
      if (s < least) least = s;
    }
    if (k === 0) {
      for (const b of this.placed) {
        const s = boxClearance(b, x, z);
        if (s < least) least = s;
      }
    }
    return least;
  }

  /**
   * The walls are the level's. `feetY` arrives from the controller as the feet
   * plus `STEP_HEIGHT`, which is fine: `LEVEL_TOL_M` is read against it, so a
   * body most of the way up a flight is stepped against the storey it is
   * about to arrive on -- whose shut end is behind it -- rather than the one
   * it left, whose shut end is the wall it would otherwise walk into at the
   * top. See `Core`.
   */
  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    radius: number,
    feetY: number,
    _headY?: number,
  ): { x: number; z: number; hit: boolean } {
    const k = levelIndex(this.levels, feetY);
    const walls = this.levels[k].walls;
    const placed = k === 0 ? this.placed : NO_BOXES;
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
      for (const w of walls) {
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
      for (const b of placed) {
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

// --- The core's arithmetic, shared by the resolver, the ground and the mesh ----

/** Position along (`r`) and across (`w`) the core, metres from its centre. */
export function coreLocal(core: Core, x: number, z: number): { r: number; w: number } {
  const dx = x - core.x;
  const dz = z - core.z;
  return { r: dx * core.lx + dz * core.lz, w: -dx * core.lz + dz * core.lx };
}

/** Is this point in the core's rectangle, grown by `slack` all round? */
export function inCore(core: Core, x: number, z: number, slack = 0): boolean {
  const { r, w } = coreLocal(core, x, z);
  return Math.abs(r) <= core.hr + slack && Math.abs(w) <= core.hw + slack;
}

/** The end of the core level `k` opens onto, as the sign of the run. */
export function coreOpenEnd(core: Core, k: number): -1 | 1 {
  if (core.kind === CORE.LIFT) return -1;
  return k & 1 ? 1 : -1;
}

/** The end flight `f` starts from, as the sign of the run. Even flights climb from `-run`. */
function flightStart(f: number): -1 | 1 {
  return f & 1 ? 1 : -1;
}

/** The ramp's height on flight `f` at `t` in [0, 1] along the run from the `-run` end. */
function flightY(levels: readonly Level[], f: number, t: number): number {
  const rise = levels[f + 1].y - levels[f].y;
  return levels[f].y + (f & 1 ? 1 - t : t) * rise;
}

/**
 * Does the lane on side `s` of the core stand at level `k`'s floor at end `e`?
 *
 * True when some flight of that lane's parity starts or arrives there at that
 * height. Where it is false, `buildInterior` walls that lane off at that end
 * on that level: it is the mouth of a flight two storeys up, or of nothing.
 */
function laneMeetsLevel(levels: readonly Level[], s: -1 | 1, k: number, e: -1 | 1): boolean {
  const parity = s < 0 ? 0 : 1;
  const y = levels[k].y;
  for (let f = 0; f + 1 < levels.length; f++) {
    if ((f & 1) !== parity) continue;
    const start = flightStart(f);
    if (start === e && levels[f].y === y) return true;
    if (start === -e && levels[f + 1].y === y) return true;
  }
  return false;
}

/**
 * What `CombatWorld.groundHeight` is while a body is in here.
 *
 * The level's floor everywhere but on a stair, where it is the ramp of the one
 * flight this lane carries between the level the feet are on and the one
 * below it. Nearest by height rather than by level, so a body that jumps on a
 * flight lands on the flight it jumped from and never on the one above.
 */
export function interiorGround(it: Interior, x: number, z: number, feetY: number): number {
  const levels = it.levels;
  const k = levelIndex(levels, feetY);
  const core = it.core;
  if (core === null || core.kind !== CORE.STAIR || !inCore(core, x, z, 0.05)) return levels[k].y;
  const { r, w } = coreLocal(core, x, z);
  const t = Math.max(0, Math.min(1, (r + core.hr) / (2 * core.hr)));
  const parity = w < 0 ? 0 : 1;
  const last = levels.length - 2;
  let best = levels[k].y;
  let bestD = Infinity;
  for (let f = Math.max(0, k - 1); f <= Math.min(k, last); f++) {
    if ((f & 1) !== parity) continue;
    const y = flightY(levels, f, t);
    const d = Math.abs(y - feetY);
    if (d < bestD) {
      bestD = d;
      best = y;
    }
  }
  return best;
}

// --- The generator -------------------------------------------------------------

/** The core's rectangle in the plan's own frame, for cutting partitions. */
interface CoreCut {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * One level's partitions and lintels from its rooms.
 *
 * Every contact between two rooms becomes a doorway, which is what makes
 * connectivity a property of the generator rather than something to check for
 * afterwards: two rooms that share a metre of wall share a way through it, so
 * the room graph *is* the contact graph and no part of a floor can be sealed
 * off. `MIN_CONTACT_M` and the jamb are sized so that this is always an
 * opening a body fits through -- see `contactsBetween`.
 *
 * The core's rectangle, grown by `CORE_CUT_M`, is cut out of every partition
 * the way a doorway is, without the lintel: the core brings its own walls, and
 * an apron round it is what guarantees a flight arrives into a corridor.
 */
function wallsFor(
  rooms: readonly Room[],
  box: OrientedBox,
  planes: readonly ShellPlane[],
  cut: CoreCut | null,
): { walls: InteriorWall[]; headers: InteriorWall[] } {
  const contacts = contactsBetween(rooms);
  const doorways: Span[] = [];
  for (const c of contacts) {
    const width = Math.min(DOOR_GAP_M, c.hi - c.lo - 0.1);
    const mid = (c.lo + c.hi) / 2;
    doorways.push({ axis: c.axis, coord: c.coord, lo: mid - width / 2, hi: mid + width / 2 });
  }

  // --- The walls: every edge of every room, unioned per line, with the
  // doorways and the core cut out of the union.
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
   * **collision** and a header must not be: you walk under it.
   */
  const headerSpans: Span[] = [];
  for (const span of merged) {
    let parts: Array<{ lo: number; hi: number }> = [{ lo: span.lo, hi: span.hi }];
    const gaps: Span[] = [];
    for (const gap of doorways) {
      if (gap.axis !== span.axis || Math.abs(gap.coord - span.coord) > 1e-3) continue;
      // Where this gap actually cuts *this* wall is where a header goes. A
      // doorway on a line with no wall along it needs none, and would be a
      // lintel standing on nothing. Not over the core's apron, where the wall
      // itself is about to be cut away.
      const lo = Math.max(gap.lo, span.lo);
      const hi = Math.min(gap.hi, span.hi);
      if (hi - lo > 0.05) {
        const mid = (lo + hi) / 2;
        const inCut =
          cut !== null &&
          (span.axis === 0
            ? span.coord > cut.u0 - CORE_CUT_M && span.coord < cut.u1 + CORE_CUT_M && mid > cut.v0 - CORE_CUT_M && mid < cut.v1 + CORE_CUT_M
            : span.coord > cut.v0 - CORE_CUT_M && span.coord < cut.v1 + CORE_CUT_M && mid > cut.u0 - CORE_CUT_M && mid < cut.u1 + CORE_CUT_M);
        if (!inCut) headerSpans.push({ axis: span.axis, coord: span.coord, lo, hi });
      }
      gaps.push(gap);
    }
    if (cut !== null) {
      const across = span.axis === 0 ? span.coord > cut.u0 - CORE_CUT_M && span.coord < cut.u1 + CORE_CUT_M
        : span.coord > cut.v0 - CORE_CUT_M && span.coord < cut.v1 + CORE_CUT_M;
      if (across) {
        gaps.push(
          span.axis === 0
            ? { axis: 0, coord: span.coord, lo: cut.v0 - CORE_CUT_M, hi: cut.v1 + CORE_CUT_M }
            : { axis: 1, coord: span.coord, lo: cut.u0 - CORE_CUT_M, hi: cut.u1 + CORE_CUT_M },
        );
      }
    }
    for (const gap of gaps) {
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
  return { walls, headers };
}

/**
 * Where the core goes, or null for a building that gets no way up.
 *
 * In the biggest ground-floor room it fits, against one of that room's walls
 * with `CORE_MARGIN_M` to spare, clear of the room's doorways and never
 * nearer the shell than the margin -- the shell is where the doors are, and a
 * door that opens onto a stairwell's side is a door `arrivalAt` has to walk
 * somebody round. Candidates are tried in a fixed order and the first that
 * passes is it, so both ends get the same core for the same building.
 */
function placeCore(
  ground: readonly Room[],
  box: OrientedBox,
  planes: readonly ShellPlane[],
  kind: CoreKind,
): { core: Core; cut: CoreCut } | null {
  const hw = CORE_WIDTH_M / 2;
  const contacts = contactsBetween(ground);
  const gates: Array<{ u: number; v: number; a: number; b: number }> = [];
  for (const c of contacts) {
    const mid = (c.lo + c.hi) / 2;
    gates.push(c.axis === 0 ? { u: c.coord, v: mid, a: c.a, b: c.b } : { u: mid, v: c.coord, a: c.a, b: c.b });
  }
  // Does the segment from (u0,v0) to (u1,v1) cross the box grown by `pad`?
  // Liang-Barsky, in the plan's own frame.
  const crosses = (u0: number, v0: number, u1: number, v1: number, cut: CoreCut, pad: number): boolean => {
    let t0 = 0;
    let t1 = 1;
    const du = u1 - u0;
    const dv = v1 - v0;
    const edges: Array<[number, number]> = [
      [-du, u0 - (cut.u0 - pad)],
      [du, cut.u1 + pad - u0],
      [-dv, v0 - (cut.v0 - pad)],
      [dv, cut.v1 + pad - v0],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return true;
  };
  // Biggest room first by its short side, then its long, then plan order --
  // three keys so that two rooms of one size cannot tie.
  const order = ground
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      Math.min(b.r.ex, b.r.ez) - Math.min(a.r.ex, a.r.ez) ||
      Math.max(b.r.ex, b.r.ez) - Math.max(a.r.ex, a.r.ez) ||
      a.i - b.i);
  for (const { r, i: index } of order) {
    const alongU = r.ex >= r.ez;
    const longHalf = Math.max(r.ex, r.ez);
    const shortHalf = Math.min(r.ex, r.ez);
    if (shortHalf * 2 < CORE_WIDTH_M + 2 * CORE_MARGIN_M) continue;
    const run = Math.min(CORE_RUN_MAX_M, longHalf * 2 - 2 * CORE_LANDING_M);
    if (run < CORE_RUN_MIN_M) continue;
    const hr = run / 2;
    const acrossPlay = shortHalf - CORE_MARGIN_M - hw;
    const runPlay = longHalf - CORE_LANDING_M - hr;
    for (const across of [-acrossPlay, acrossPlay, 0]) {
      for (const along of [0, -runPlay, runPlay]) {
        const cu = alongU ? r.u + along : r.u + across;
        const cv = alongU ? r.v + across : r.v + along;
        const eu = alongU ? hr : hw;
        const ev = alongU ? hw : hr;
        const cut: CoreCut = { u0: cu - eu, u1: cu + eu, v0: cv - ev, v1: cv + ev };
        // The margin to the shell, at the four corners grown by it. A convex
        // shell makes the corner test exact.
        let clear = true;
        for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const u = cu + du * (eu + CORE_SHELL_M);
          const v = cv + dv * (ev + CORE_SHELL_M);
          const x = u * box.ux - v * box.uz;
          const z = u * box.uz + v * box.ux;
          for (const pl of planes) {
            if (pl.nx * x + pl.nz * z - pl.d < 0) {
              clear = false;
              break;
            }
          }
          if (!clear) break;
        }
        if (!clear) continue;
        // And the doorways: none within a body's width of the core, and the
        // core never between the middle of its room and any of that room's
        // doors -- a stair you have to walk round to get to the next room is
        // a stair in the wrong place.
        for (const g of gates) {
          if (g.u > cut.u0 - 1.2 && g.u < cut.u1 + 1.2 && g.v > cut.v0 - 1.2 && g.v < cut.v1 + 1.2) {
            clear = false;
            break;
          }
          if ((g.a === index || g.b === index) && crosses(r.u, r.v, g.u, g.v, cut, 0.5)) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        const x = cu * box.ux - cv * box.uz;
        const z = cu * box.uz + cv * box.ux;
        const lx = alongU ? box.ux : -box.uz;
        const lz = alongU ? box.uz : box.ux;
        return { core: { kind, x, z, lx, lz, hr, hw }, cut };
      }
    }
  }
  return null;
}

/** The core's own walls on level `k`: its sides, its shut end, and any lane mouth shut at that level. */
function coreWalls(core: Core, levels: readonly Level[], k: number, out: InteriorWall[]): void {
  const ax = -core.lz;
  const az = core.lx;
  const at = (r: number, w: number): [number, number] => [
    core.x + core.lx * r + ax * w,
    core.z + core.lz * r + az * w,
  ];
  const seg = (a: [number, number], b: [number, number]): void => {
    out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1] });
  };
  seg(at(-core.hr, -core.hw), at(core.hr, -core.hw));
  seg(at(-core.hr, core.hw), at(core.hr, core.hw));
  const open = coreOpenEnd(core, k);
  seg(at(-open * core.hr, -core.hw), at(-open * core.hr, core.hw));
  if (core.kind !== CORE.STAIR) return;
  seg(at(-core.hr, 0), at(core.hr, 0));
  for (const s of [-1, 1] as const) {
    if (laneMeetsLevel(levels, s, k, open)) continue;
    seg(at(open * core.hr, s < 0 ? -core.hw : 0), at(open * core.hr, s < 0 ? 0 : core.hw));
  }
}


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
  // One storey's rooms, and only the part of it inside the shell.
  //
  // Two culls rather than one, because they answer different questions.
  // `floorPlan` already dropped the cells whose centres fall outside the
  // *polygon*, which is what makes an L-shape work. This drops the ones outside
  // the **walkable shell** -- the intersection of the outline's half-planes,
  // which for a convex hull is the outline inset by a wall and for anything
  // else is its convex core. Without it a concave footprint keeps rooms whose
  // walls are then clipped away to nothing, and the plan describes partitions
  // that do not exist.
  const roomsOn = (storey: number): Room[] =>
    plan.rooms.filter((r) => {
      if (r.storey !== storey) return false;
      for (const pl of planes) {
        if (pl.nx * r.x + pl.nz * r.z - pl.d < 0.05) return false;
      }
      return true;
    });
  const ground = roomsOn(0);

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
   * The fallback door, for a body restored from a save made before doors were
   * saved with the spot, and the door furniture keeps clear of when nobody is
   * in the room to ask. Derived from the footprint, so it is the same on every
   * machine. Ties go to the earlier edge so a square building still has one.
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

  /*
   * --- The levels.
   *
   * Every storey the plan drew is a level, if there is a core to reach it by;
   * a building the core will not fit in has its ground floor and nothing
   * else, and says so in `interiorLine`. A deck (`DECKS`) is one more level
   * above the top storey, with no rooms: the whole shell, windows all round.
   * It is dropped if it would not clear the top storey's ceiling, which a
   * retile that shortens the podium could do.
   */
  const deckY = DECKS.get(seed);
  const deck =
    deckY !== undefined && deckY > base + (plan.storeys - 1) * STOREY_M + CEILING_M ? deckY : undefined;
  const wanted = plan.storeys + (deck !== undefined ? 1 : 0);
  let core: Core | null = null;
  let cut: CoreCut | null = null;
  if (wanted >= 2) {
    const kind = wanted > STAIR_MAX_STOREYS || deck !== undefined ? CORE.LIFT : CORE.STAIR;
    const placed = placeCore(ground, box, planes, kind);
    if (placed !== null) {
      core = placed.core;
      cut = placed.cut;
    }
  }
  const count = core === null ? 1 : wanted;
  const levels: Array<{ y: number; rooms: readonly Room[]; walls: InteriorWall[]; headers: InteriorWall[] }> = [];
  for (let k = 0; k < count; k++) {
    const isDeck = deck !== undefined && k === count - 1;
    levels.push({
      y: isDeck ? deck : base + k * STOREY_M,
      rooms: k === 0 ? ground : isDeck ? [] : roomsOn(k),
      walls: [],
      headers: [],
    });
  }
  for (let k = 0; k < count; k++) {
    const made = wallsFor(levels[k].rooms, box, planes, cut);
    levels[k].walls = made.walls;
    levels[k].headers = made.headers;
    if (core !== null) coreWalls(core, levels, k, levels[k].walls);
  }

  const it: Interior = {
    seed,
    base,
    ceilingY: base + CEILING_M,
    plan,
    rooms: levels[0].rooms,
    walls: levels[0].walls,
    headers: levels[0].headers,
    levels,
    core,
    shell,
    planes,
    centreX,
    centreZ,
    door,
    placedBoxes: [],
    resolver: new InteriorResolver(planes, levels),
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
    const core = it.core;
    if (core !== null && inCore(core, x, z, 0.25)) {
      // In the stairwell, or in its wall. Out of it sideways, to the middle of
      // the corridor the core keeps beside itself, rather than toward the
      // centre -- which, in a terrace, is where the core is. The slack and the
      // push are both under the corridor's half width, so a body settled in
      // the corridor is not read as in the core and pushed back out of it.
      const { w } = coreLocal(core, x, z);
      const want = (w < 0 ? -1 : 1) * (core.hw + 0.5);
      x += -core.lz * (want - w);
      z += core.lx * (want - w);
      continue;
    }
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
  // Not on the stairs, or in the lift, or in the apron round them that
  // every level's partitions are cut back to.
  if (it.core !== null && inCore(it.core, p.x, p.z, Math.max(kind.hx, kind.hz) + CORE_CUT_M)) return false;
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
  const above = it.levels.length - 1;
  const drawn = Math.max(0, it.plan.storeys - 1);
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
  const floors = (n: number): string => (n === 1 ? 'a floor' : `${n} floors`);
  const upstairs =
    it.core === null
      ? drawn === 0 ? 'and no way up' : `with ${floors(drawn)} above you, shut`
      : it.core.kind === CORE.STAIR
        ? `with ${floors(above)} up the stairs`
        : DECKS.has(it.seed)
          ? `with a lift to ${floors(above - 1)} and the deck`
          : `with a lift to ${floors(above)}`;
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
  const scaled = (c: { r: number; g: number; b: number }, k: number): { r: number; g: number; b: number } => ({
    r: Math.min(1, c.r * k),
    g: Math.min(1, c.g * k),
    b: Math.min(1, c.b * k),
  });
  const levels = it.levels;
  const core = it.core;
  const top = levels.length - 1;
  // The level being drawn. Every helper below reads these, so the loop over
  // the levels only has to set them.
  let floorY = levels[0].y;
  let ceilY = floorY + CEILING_M;
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
  // A vertical quad from a to b, facing (nx, nz), shaded `lo` at the bottom
  // edge's triangle and `hi` at the top's.
  const wall = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, lo: number, hi: number,
    y0 = floorY, y1 = ceilY,
    rgb: { r: number; g: number; b: number } | null = null,
  ): void => {
    tri(ax, y0, az, bx, y0, bz, bx, y1, bz, nx, 0, nz, lo, rgb);
    tri(ax, y0, az, bx, y1, bz, ax, y1, az, nx, 0, nz, hi, rgb);
  };
  // A wall with its finish on: skirting, then paint, brick courses or panelling.
  const finishedWall = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, lo: number, hi: number,
  ): void => {
    const height = ceilY - floorY;
    const band = (y0: number, y1: number, shade: number): void => {
      if (y1 <= y0) return;
      wall(ax, az, bx, bz, nx, nz, shade, shade, floorY + y0, floorY + y1);
    };
    const skirt = Math.min(0.14, height * 0.06);
    band(0, skirt, lo * 0.62);
    if (finish.walls === WALLS.BRICK) {
      const COURSES = 8;
      const h = (height - skirt) / COURSES;
      for (let i = 0; i < COURSES; i++) {
        const k = i & 1 ? 0.94 : 1.04;
        const j = hash2(it.seed ^ Math.round(ax * 100), i * 37 + Math.round(az * 100)) * 0.06;
        band(skirt + i * h, skirt + (i + 1) * h, (lo + (hi - lo) * (i / COURSES)) * (k + j));
      }
      return;
    }
    if (finish.walls === WALLS.PANEL) {
      const rail = Math.min(1.0, height * 0.42);
      band(skirt, rail, lo * 0.9);
      band(rail, rail + 0.09, lo * 0.55);
      band(rail + 0.09, height - 0.1, hi);
      band(height - 0.1, height, hi * 0.72);
      return;
    }
    band(skirt, height - 0.1, (lo + hi) / 2);
    band(height - 0.1, height, hi * 0.78);
  };
  const finishedFrame = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, y0: number, y1: number, inset: number,
    rgb: { r: number; g: number; b: number },
  ): void => {
    wall(ax + nx * inset, az + nz * inset, bx + nx * inset, bz + nz * inset, nx, nz, 1, 1, y0, y1, rgb);
  };
  // A horizontal quad in the plan's frame, facing up or down.
  const box = it.plan.box;
  const flat = (
    u0: number, v0: number, u1: number, v1: number, y: number, up: boolean,
    shade: number, rgb: { r: number; g: number; b: number } | null = null,
  ): void => {
    const p00x = u0 * box.ux - v0 * box.uz;
    const p00z = u0 * box.uz + v0 * box.ux;
    const p10x = u1 * box.ux - v0 * box.uz;
    const p10z = u1 * box.uz + v0 * box.ux;
    const p11x = u1 * box.ux - v1 * box.uz;
    const p11z = u1 * box.uz + v1 * box.ux;
    const p01x = u0 * box.ux - v1 * box.uz;
    const p01z = u0 * box.uz + v1 * box.ux;
    if (up) {
      tri(p00x, y, p00z, p10x, y, p10z, p11x, y, p11z, 0, 1, 0, shade, rgb);
      tri(p00x, y, p00z, p11x, y, p11z, p01x, y, p01z, 0, 1, 0, shade, rgb);
    } else {
      tri(p00x, y, p00z, p11x, y, p11z, p10x, y, p10z, 0, -1, 0, shade, rgb);
      tri(p00x, y, p00z, p01x, y, p01z, p11x, y, p11z, 0, -1, 0, shade, rgb);
    }
  };

  // --- The floor covering's grid, laid out once in the plan's frame.
  //
  // Boards run along the building; carpet and tiles are square. The covering
  // is one quad per board or tile, which is what makes it read as a floor
  // rather than a colour -- bounded per building rather than per level so a
  // tower does not draw eighty floors of parquet: a level's share shrinks as
  // the levels go up, to a floor of 150 quads that still reads.
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
  const wide = finish.floor === FLOOR.BOARDS ? 0.16 : finish.floor === FLOOR.TILE ? 0.45 : 0.7;
  const longM = finish.floor === FLOOR.BOARDS ? 1.9 : wide;
  const budget = Math.min(MAX_FLOOR_QUADS, Math.max(150, Math.floor((MAX_FLOOR_QUADS * 3) / levels.length)));
  let grow = 1;
  while ((spanU / (wide * grow)) * (spanV / (longM * grow)) > budget) grow *= 1.25;
  const cu = wide * grow;
  const cv = longM * grow;
  const nu = Math.ceil(spanU / cu);
  const nv = Math.ceil(spanV / cv);
  // The grid, as cells inside the shell with their world centres, so each
  // level reads it rather than re-testing every cell against every plane.
  const cells: Array<{ i: number; j: number; u0: number; v0: number; u1: number; v1: number; x: number; z: number }> = [];
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
      if (inside) cells.push({ i, j, u0, v0, u1, v1, x: wx, z: wz });
    }
  }
  const covering = (y: number, skipCore: boolean): void => {
    for (const c of cells) {
      if (skipCore && core !== null && inCore(core, c.x, c.z, 0.02)) continue;
      let shade: number;
      if (finish.floor === FLOOR.BOARDS) {
        shade = 0.86 + hash2(it.seed ^ (c.i * 7919), c.j + ((c.i * 3) % 5)) * 0.28;
      } else if (finish.floor === FLOOR.CARPET) {
        shade = 0.70 + hash2(it.seed ^ (c.i * 131), c.j * 17) * 0.08;
      } else {
        shade = ((c.i + c.j) & 1 ? 0.98 : 0.86) + hash2(it.seed, c.i * 31 + c.j) * 0.04;
      }
      const gap = finish.floor === FLOOR.TILE ? 0.02 : finish.floor === FLOOR.BOARDS ? 0.012 : 0;
      const a0 = c.u0 + gap;
      const a1 = c.u1 - gap;
      const b0 = c.v0 + gap;
      const b1 = c.v1 - gap;
      if (a1 <= a0 || b1 <= b0) continue;
      const rgb = finish.floor === FLOOR.CARPET ? carpet : null;
      flat(a0, b0, a1, b1, y, true, shade, rgb === null ? null : scaled(rgb, shade));
    }
  };
  // A slab: the cells, with the core's cut through it or not, facing `up`.
  const slab = (y: number, up: boolean, skipCore: boolean, shade: number): void => {
    for (const c of cells) {
      if (skipCore && core !== null && inCore(core, c.x, c.z, 0.02)) continue;
      flat(c.u0, c.v0, c.u1, c.v1, y, up, shade);
    }
  };

  for (let k = 0; k <= top; k++) {
    floorY = levels[k].y;
    ceilY = floorY + CEILING_M;
    const level = levels[k];
    const holed = core !== null && k < top;

    // --- Floor and ceiling.
    //
    // The ground floor is a fan over the convex shell, which is exact and
    // cheap. Every floor above it has the core cut through it, and a fan
    // cannot have a hole, so those are the covering's own cells with the
    // core's cells left out -- the covering is laid over both anyway. The
    // ceiling is the underside of the slab above: cut wherever the floor
    // above is, solid over the top level.
    if (k === 0) {
      const n = it.shell.length >> 1;
      const ox = it.shell[0];
      const oz = it.shell[1];
      for (let i = 1; i + 1 < n; i++) {
        const ax = it.shell[i * 2];
        const az = it.shell[i * 2 + 1];
        const bx = it.shell[(i + 1) * 2];
        const bz = it.shell[(i + 1) * 2 + 1];
        tri(ox, floorY, oz, ax, floorY, az, bx, floorY, bz, 0, 1, 0, 1.0);
      }
    } else {
      slab(floorY, true, true, 1.0);
    }
    covering(floorY + 0.004, k > 0);
    slab(ceilY, false, holed, 0.45);

    // --- The shell's walls, with windows, and the slab's edge above them.
    {
      const n = it.shell.length >> 1;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = it.shell[j * 2];
        const az = it.shell[j * 2 + 1];
        const bx = it.shell[i * 2];
        const bz = it.shell[i * 2 + 1];
        let ex = bx - ax;
        let ez = bz - az;
        const len = Math.sqrt(ex * ex + ez * ez);
        if (!(len > 1e-6)) continue;
        ex /= len;
        ez /= len;
        const pl = it.planes[j] ?? it.planes[0];
        finishedWall(ax, az, bx, bz, pl.nx, pl.nz, 0.72, 0.86);
        if (k < top) wall(ax, az, bx, bz, pl.nx, pl.nz, 0.5, 0.5, ceilY, levels[k + 1].y);
        // A window every few metres, clear of the door: a frame, the glass set
        // deeper, and a sill. Under the ground floor's door on that level only;
        // the floors above have no door to keep clear of.
        const WINDOW_EVERY_M = 3.6;
        const WINDOW_W = 1.25;
        const WINDOW_H = 1.3;
        const SILL_M = 0.95;
        if (len >= WINDOW_W + 1.6 && ceilY - floorY > SILL_M + WINDOW_H + 0.25) {
          const count = Math.max(1, Math.floor(len / WINDOW_EVERY_M));
          const pitch = len / count;
          for (let w = 0; w < count; w++) {
            const t = (w + 0.5) * pitch;
            const wx = ax + ex * t;
            const wz = az + ez * t;
            if (
              k === 0 &&
              Math.sqrt((wx - doorX) * (wx - doorX) + (wz - doorZ) * (wz - doorZ)) < DOOR_GAP_M * 0.9 + WINDOW_W / 2
            ) {
              continue;
            }
            const half = WINDOW_W / 2;
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

    // --- The door, on the ground floor: a frame and a leaf, drawn just inside
    // the wall so they are in front of it rather than in it.
    if (k === 0) {
      const inX = -doorNX;
      const inZ = -doorNZ;
      const tx = -inZ;
      const tz = inX;
      const half = DOOR_GAP_M / 2;
      const frame = { r: 0.16, g: 0.13, b: 0.10 };
      const leaf = { r: 0.93, g: 0.78, b: 0.42 };
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

    // --- The partitions, and the core's walls, which are in the same list.
    for (const w of level.walls) {
      let ex = w.bx - w.ax;
      let ez = w.bz - w.az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (!(len > 1e-6)) continue;
      ex /= len;
      ez /= len;
      const nx = ez;
      const nz = -ex;
      const h = WALL_THICK_M / 2;
      finishedWall(w.ax + nx * h, w.az + nz * h, w.bx + nx * h, w.bz + nz * h, nx, nz, 0.66, 0.80);
      finishedWall(w.bx - nx * h, w.bz - nz * h, w.ax - nx * h, w.az - nz * h, -nx, -nz, 0.66, 0.80);
      // Through the slab above, so the core's walls read as one shaft rather
      // than a stack of storeys with a gap at each floor.
      if (k < top && core !== null) {
        wall(w.ax + nx * h, w.az + nz * h, w.bx + nx * h, w.bz + nz * h, nx, nz, 0.5, 0.5, ceilY, levels[k + 1].y);
        wall(w.bx - nx * h, w.bz - nz * h, w.ax - nx * h, w.az - nz * h, -nx, -nz, 0.5, 0.5, ceilY, levels[k + 1].y);
      }
      if (!onShell(it, w.ax, w.az)) {
        wall(w.ax - nx * h, w.az - nz * h, w.ax + nx * h, w.az + nz * h, -ex, -ez, 0.58, 0.62);
      }
      if (!onShell(it, w.bx, w.bz)) {
        wall(w.bx + nx * h, w.bz + nz * h, w.bx - nx * h, w.bz - nz * h, ex, ez, 0.58, 0.62);
      }
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

    // --- The furniture, on the ground floor, which is where it is allowed.
    if (k === 0) for (const b of it.placedBoxes) couchInto(pos, nor, col, b, floorY);

    // --- The lintels: the wall over each doorway, with its underside.
    for (const h of level.headers) {
      let ex = h.bx - h.ax;
      let ez = h.bz - h.az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (!(len > 1e-6)) continue;
      ex /= len;
      ez /= len;
      const nx = ez;
      const nz = -ex;
      const t = WALL_THICK_M / 2;
      const head = floorY + DOOR_HEAD_M;
      wall(h.ax + nx * t, h.az + nz * t, h.bx + nx * t, h.bz + nz * t, nx, nz, 0.70, 0.80, head + 0.06, ceilY);
      wall(h.bx - nx * t, h.bz - nz * t, h.ax - nx * t, h.az - nz * t, -nx, -nz, 0.70, 0.80, head + 0.06, ceilY);
      wall(h.ax + nx * t, h.az + nz * t, h.bx + nx * t, h.bz + nz * t, nx, nz, 0.44, 0.44, head, head + 0.06);
      wall(h.bx - nx * t, h.bz - nz * t, h.ax - nx * t, h.az - nz * t, -nx, -nz, 0.44, 0.44, head, head + 0.06);
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
      wall(h.ax - nx * t, h.az - nz * t, h.ax + nx * t, h.az + nz * t, -ex, -ez, 0.5, 0.5, floorY, head);
      wall(h.bx + nx * t, h.bz + nz * t, h.bx - nx * t, h.bz - nz * t, ex, ez, 0.5, 0.5, floorY, head);
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

    // --- The lift's floor at this level. The stair's flights are drawn once,
    // below, because a flight belongs to two levels.
    if (core !== null && core.kind === CORE.LIFT) {
      const ax = -core.lz;
      const az = core.lx;
      const c = (r: number, w: number): [number, number] => [core.x + core.lx * r + ax * w, core.z + core.lz * r + az * w];
      const y = floorY + 0.006;
      const p0 = c(-core.hr, -core.hw);
      const p1 = c(core.hr, -core.hw);
      const p2 = c(core.hr, core.hw);
      const p3 = c(-core.hr, core.hw);
      const cab = { r: 0.36, g: 0.36, b: 0.38 };
      tri(p0[0], y, p0[1], p1[0], y, p1[1], p2[0], y, p2[1], 0, 1, 0, 1, cab);
      tri(p0[0], y, p0[1], p2[0], y, p2[1], p3[0], y, p3[1], 0, 1, 0, 1, cab);
    }
  }

  // --- The flights.
  //
  // Each is a strip of quads along its lane at the ramp's own height, with a
  // skirt down each side so it reads as a solid stair rather than a floating
  // plank -- the same seven-boxes argument `couchInto` makes: nothing in here
  // is ever drawn from the street.
  if (core !== null && core.kind === CORE.STAIR) {
    const ax = -core.lz;
    const az = core.lx;
    const at = (r: number, w: number): [number, number] => [core.x + core.lx * r + ax * w, core.z + core.lz * r + az * w];
    const tread = { r: 0.50, g: 0.42, b: 0.30 };
    const SEGMENTS = 12;
    const SKIRT = 0.32;
    for (let f = 0; f + 1 < levels.length; f++) {
      const lane = f & 1 ? core.hw / 2 : -core.hw / 2;
      const w0 = lane - (core.hw / 2 - WALL_THICK_M / 2);
      const w1 = lane + (core.hw / 2 - WALL_THICK_M / 2);
      for (let s = 0; s < SEGMENTS; s++) {
        const t0 = s / SEGMENTS;
        const t1 = (s + 1) / SEGMENTS;
        const r0 = -core.hr + t0 * 2 * core.hr;
        const r1 = -core.hr + t1 * 2 * core.hr;
        const y0 = flightY(levels, f, t0);
        const y1 = flightY(levels, f, t1);
        const a = at(r0, w0);
        const b = at(r1, w0);
        const c = at(r1, w1);
        const d = at(r0, w1);
        const shade = 1 - (s & 1) * 0.08;
        tri(a[0], y0, a[1], b[0], y1, b[1], c[0], y1, c[1], 0, 1, 0, 1, scaled(tread, shade));
        tri(a[0], y0, a[1], c[0], y1, c[1], d[0], y0, d[1], 0, 1, 0, 1, scaled(tread, shade));
        // The skirts, facing out of the lane, and the underside so the flight
        // is not see-through from below.
        const dark = scaled(tread, 0.55);
        // Never below the floor the flight starts from.
        const s0 = Math.max(levels[f].y, y0 - SKIRT);
        const s1 = Math.max(levels[f].y, y1 - SKIRT);
        tri(a[0], y0, a[1], a[0], s0, a[1], b[0], s1, b[1], -ax, 0, -az, 1, dark);
        tri(a[0], y0, a[1], b[0], s1, b[1], b[0], y1, b[1], -ax, 0, -az, 1, dark);
        tri(d[0], y0, d[1], c[0], s1, c[1], d[0], s0, d[1], ax, 0, az, 1, dark);
        tri(d[0], y0, d[1], c[0], y1, c[1], c[0], s1, c[1], ax, 0, az, 1, dark);
        tri(a[0], s0, a[1], d[0], s0, d[1], c[0], s1, c[1], 0, -1, 0, 1, dark);
        tri(a[0], s0, a[1], c[0], s1, c[1], b[0], s1, b[1], 0, -1, 0, 1, dark);
      }
    }
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
        if (mesh.positions[i] > it.levels[it.levels.length - 1].y + CEILING_M + 0.02) above++;
        if (mesh.positions[i] < it.base - 0.02) below++;
      }
      if (above > 0 || below > 0) {
        failures.push(`${above + below} vertices fall outside the building (${it.base.toFixed(1)} to ${(it.levels[it.levels.length - 1].y + CEILING_M).toFixed(1)} m).`);
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
      if (mesh.triangles > (MAX_FLOOR_QUADS * 4 + 8000) * it.levels.length) {
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
        if (y > it.levels[it.levels.length - 1].y + CEILING_M + 0.02 || y < it.base - 0.02) low++;
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
    // One storey: this is the furniture's check, and a stair in the room would
    // be one more thing for a couch to be refused for.
    const it = southDoor(pts, 0, 3, 77);
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


  // --- Upstairs.
  //
  // A four-storey building gets a stair, and every flight of it can be
  // climbed by a body stepped the way the controller steps it: resolve against
  // the level's walls, then snap the feet to the ground. That walk is the
  // whole point of the core; a stair that looks right and cannot be walked is
  // a hole in the ceiling.
  // A body walked `dist` metres in a direction in the controller's own 8 cm
  // steps, resolved each. A single long step would tunnel through a wall,
  // which the controller never does and a check must not either.
  const nudge = (it: Interior, x: number, z: number, dx: number, dz: number, dist: number, feetY: number): { x: number; z: number } => {
    for (let gone = 0; gone < dist; gone += 0.08) {
      const r = it.resolver.resolve(x, z, x + dx * 0.08, z + dz * 0.08, 0.35, feetY);
      x = r.x;
      z = r.z;
    }
    return { x, z };
  };
  {
    const pts = poly(0, 0, 12, 0, 12, 20, 0, 20);
    const it = southDoor(pts, 0, 14, 21);
    if (it === null) failures.push('a 12 x 20 m, four-storey building generated no interior.');
    else if (it.core === null) failures.push('a 12 x 20 m, four-storey building got no stair.');
    else {
      const core = it.core;
      const ax = -core.lz;
      const az = core.lx;
      if (core.kind !== CORE.STAIR) failures.push('a four-storey building got a lift, not a stair.');
      if (it.levels.length !== 4) failures.push(`a four-storey building has ${it.levels.length} levels.`);
      const climb = (k: number): string => {
        const e = coreOpenEnd(core, k);
        const lane = k & 1 ? core.hw / 2 : -core.hw / 2;
        let x = core.x + core.lx * (e * (core.hr + 0.8)) + ax * lane;
        let z = core.z + core.lz * (e * (core.hr + 0.8)) + az * lane;
        let feet = it.levels[k].y;
        const dirX = -e * core.lx;
        const dirZ = -e * core.lz;
        for (let step = 0; step < 400; step++) {
          const r = it.resolver.resolve(x, z, x + dirX * 0.08, z + dirZ * 0.08, 0.35, feet + 0.42);
          x = r.x;
          z = r.z;
          feet = interiorGround(it, x, z, feet);
          if (-e * coreLocal(core, x, z).r > core.hr + 0.5) break;
        }
        const along = -e * coreLocal(core, x, z).r;
        if (along <= core.hr + 0.5) return `stopped ${along.toFixed(2)} m along the run`;
        if (Math.abs(feet - it.levels[k + 1].y) > 0.05) {
          return `came out at ${feet.toFixed(2)} m, not the next floor at ${it.levels[k + 1].y.toFixed(2)}`;
        }
        return '';
      };
      for (let k = 0; k + 1 < it.levels.length; k++) {
        const why = climb(k);
        if (why !== '') failures.push(`flight ${k} cannot be climbed: ${why}.`);
      }
      // The lanes are walled from each other.
      {
        const x = core.x + ax * (-core.hw / 2);
        const z = core.z + az * (-core.hw / 2);
        const feet = interiorGround(it, x, z, it.levels[0].y + 1.0);
        const r = nudge(it, x, z, ax, az, 1.5, feet + 0.42);
        if (coreLocal(core, r.x, r.z).w > -0.01) failures.push('a body stepped across the stair\'s divider mid-flight.');
      }
      // The other lane's mouth at the bottom is shut: it is the underside of a
      // flight two storeys up.
      {
        const e = coreOpenEnd(core, 0);
        const x0 = core.x + core.lx * (e * (core.hr + 0.6)) + ax * (core.hw / 2);
        const z0 = core.z + core.lz * (e * (core.hr + 0.6)) + az * (core.hw / 2);
        const r = nudge(it, x0, z0, -e * core.lx, -e * core.lz, 1.2, it.levels[0].y + 0.42);
        if (e * coreLocal(core, r.x, r.z).r < core.hr - 0.05) {
          failures.push('the bottom of the other lane is open; a body walked in under a flight two storeys up.');
        }
      }
      // Off the stair, every level's ground is its own floor.
      if (!inCore(core, it.centreX, it.centreZ, 0.5)) {
        for (let k = 0; k < it.levels.length; k++) {
          const g = interiorGround(it, it.centreX, it.centreZ, it.levels[k].y + 0.3);
          if (Math.abs(g - it.levels[k].y) > 1e-9) failures.push(`level ${k}'s ground off the stair is ${g}, not ${it.levels[k].y}.`);
        }
      }
      // Every landing is a corridor a body fits in.
      for (let k = 1; k < it.levels.length; k++) {
        const e = coreOpenEnd(core, k);
        const lane = (k - 1) & 1 ? core.hw / 2 : -core.hw / 2;
        const x = core.x + core.lx * (e * (core.hr + 0.7)) + ax * lane;
        const z = core.z + core.lz * (e * (core.hr + 0.7)) + az * lane;
        if (it.resolver.clearance(x, z, it.levels[k].y) < 0.35) failures.push(`level ${k}'s landing is not clear for a body.`);
      }
      if (placementFits(it, [], { kind: PLACEABLE.COUCH, x: core.x, z: core.z, turn: 0 })) {
        failures.push('a couch can be put on the stairs.');
      }
      const mesh = interiorMesh(it);
      let maxY = -Infinity;
      for (let i = 1; i < mesh.positions.length; i += 3) if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
      if (maxY < it.levels[3].y + CEILING_M - 0.01) failures.push('the mesh stops below the top floor\'s ceiling.');
      const line = interiorLine(it);
      if (!line.includes('stairs')) failures.push(`"${line}" does not mention the stairs.`);
    }
  }

  // --- A tower gets a lift: a cab with three walls and a floor at the level it was called to.
  {
    const it = southDoor(poly(0, 0, 30, 0, 30, 30, 0, 30), 0, 40, 22);
    if (it === null || it.core === null) failures.push('a 30 x 30 m, 40 m building got no core.');
    else {
      const c = it.core;
      if (c.kind !== CORE.LIFT) failures.push('a twelve-storey building got a stair, not a lift.');
      if (it.levels.length !== 12) failures.push(`a twelve-storey building has ${it.levels.length} levels.`);
      const ax = -c.lz;
      const az = c.lx;
      const feet = it.levels[7].y;
      if (Math.abs(interiorGround(it, c.x, c.z, feet + 0.2) - feet) > 1e-9) failures.push('the lift cab is not at the level it was called to.');
      const back = nudge(it, c.x, c.z, c.lx, c.lz, c.hr + 2, feet + 0.42);
      if (coreLocal(c, back.x, back.z).r > c.hr - 0.3) failures.push('the lift cab has no back wall.');
      const side = nudge(it, c.x, c.z, ax, az, c.hw + 2, feet + 0.42);
      if (Math.abs(coreLocal(c, side.x, side.z).w) > c.hw - 0.3) failures.push('the lift cab has no side wall.');
      const out = nudge(it, c.x, c.z, -c.lx, -c.lz, c.hr + 2, feet + 0.42);
      if (coreLocal(c, out.x, out.z).r > -c.hr - 0.5) failures.push('the lift cab cannot be walked out of.');
      if (!interiorLine(it).includes('lift')) failures.push('a tower does not mention its lift.');
    }
  }

  // --- The deck: one more level, no rooms, dropped if it would be under the roof.
  {
    const seed = [...DECKS.keys()][0];
    const deckY = DECKS.get(seed) ?? 0;
    const it = buildInterior(poly(0, 0, 30, 0, 30, 30, 0, 30), -3.3, 33.4, seed);
    if (it === null || it.core === null) failures.push('the podium under the tower got no core.');
    else {
      if (it.core.kind !== CORE.LIFT) failures.push('the deck is not reached by a lift.');
      const last = it.levels[it.levels.length - 1];
      if (last.y !== deckY) failures.push(`the top level is at ${last.y}, not the deck at ${deckY}.`);
      if (last.rooms.length !== 0) failures.push('the deck has rooms on it.');
      if (last.walls.length !== 3) failures.push(`the deck has ${last.walls.length} walls, not the lift's three.`);
      if (!interiorLine(it).includes('deck')) failures.push('the podium does not mention the deck.');
      const high = buildInterior(poly(0, 0, 30, 0, 30, 30, 0, 30), 300, 33.4, seed);
      if (high !== null && high.levels[high.levels.length - 1].y === deckY) failures.push('a deck under the building\'s own roof was kept.');
    }
  }

  // --- No room for a core: one level, and the line says the rest is shut.
  {
    const it = southDoor(poly(0, 0, 4, 0, 4, 5, 0, 5), 0, 7, 3);
    if (it !== null) {
      if (it.core !== null) failures.push('a 4 x 5 m building was given a stair.');
      if (it.levels.length !== 1) failures.push('a 4 x 5 m building has more than one level.');
      if (!interiorLine(it).includes('shut')) failures.push('a shut upstairs is not described as shut.');
    }
  }

  // --- The same building twice has the same walls on every level.
  {
    const a = southDoor(poly(0, 0, 12, 0, 12, 20, 0, 20), 0, 14, 21);
    const b = southDoor(poly(0, 0, 12, 0, 12, 20, 0, 20), 0, 14, 21);
    if (a !== null && b !== null) {
      for (let k = 0; k < a.levels.length; k++) {
        if (JSON.stringify(a.levels[k].walls) !== JSON.stringify(b.levels[k].walls)) failures.push(`level ${k} came out differently twice.`);
      }
    }
  }

  return failures;
}
