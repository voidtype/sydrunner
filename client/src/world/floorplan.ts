/**
 * A floor plan for any building in the city, from what the building already is.
 *
 * ## Why this can exist at all
 *
 * Every building inside the streaming radius already arrives with its real
 * footprint: `player/collision.ts`'s `Prism` carries `points` -- the world-space
 * polygon, flattened x,z -- plus the pad's ground height and the building's
 * height. Nothing has to be baked, downloaded or chosen. A door can be opened on
 * *any* building because the shape of that building is already in memory, which
 * is the whole reason this is a runtime generator and not a content pipeline.
 *
 * The prisms are **convex hulls** (see `world/far.ts` on why the plan stopped
 * being a rotated rectangle), and that is load-bearing here: the minimum-area
 * enclosing rectangle of a convex polygon is exact over its own edge directions,
 * so a terrace's rooms line up with the terrace's walls rather than with north.
 *
 * ## The rule this file has to obey
 *
 * **Total.** There is no curated list of buildings and there never will be, so
 * this must return something sane for every footprint in Greater Sydney: a
 * two-metre shed, a 200 m tower, an L-shaped pub, a warehouse with a courtyard,
 * a polygon with three points and a polygon with forty. A generator that throws,
 * loops or returns nothing on some footprint is a door that opens onto a crash,
 * and the player found it by walking up to it.
 *
 * **Deterministic.** DESIGN.md's rule 5. The plan is a pure function of the
 * footprint and a seed, so two players opening the same door see the same rooms
 * with nothing on the wire, and the interior does not have to be stored to
 * survive a reload -- only what people *do* to it does.
 *
 * ## How
 *
 * Binary subdivision of the footprint's oriented box, keeping the cells whose
 * centre lies inside the polygon. That last clause is what makes it total: an
 * L-shaped building simply loses the cells in the notch, a courtyard loses the
 * ones in the hole, and nothing anywhere needs a special case. Rooms are
 * returned in the building's own frame with the rotation beside them, because
 * the caller wants to build walls along them and a rotated rectangle is two
 * numbers cheaper than four corners.
 */

/** A rectangle in the building's own frame: centre, half-extents. */
export interface Room {
  /** Centre, world metres. */
  x: number;
  z: number;
  /** Half-extents along the building's own axes, metres. */
  ex: number;
  ez: number;
  /**
   * The same centre in the building's own frame -- `u` along `OrientedBox.ux`,
   * `v` along the perpendicular -- as an absolute coordinate, not an offset
   * from the box centre. `worldFromLocal` is the pair of lines that converts.
   *
   * Carried rather than recomputed because every room in one building is
   * axis-aligned *in this frame and only in this frame*, and that is the whole
   * of what makes `world/interior.ts` able to say "these two rooms share a
   * wall" with a comparison instead of a polygon intersection. A reader that
   * derived it would be deriving it in a loop, and a reader that forgot to
   * would be asking about world-axis rectangles that do not exist.
   */
  u: number;
  v: number;
  /** Which storey, 0 at the pad. */
  storey: number;
  /**
   * The hallway down the building: one room the length of the long axis
   * that every other room on the floor opens onto. See `CORRIDOR_W`.
   */
  corridor?: boolean;
}

/** The oriented box a plan is laid out in. */
export interface OrientedBox {
  x: number;
  z: number;
  ex: number;
  ez: number;
  /** The building's own axis, as a unit vector. Rooms share it. */
  ux: number;
  uz: number;
}

export interface FloorPlan {
  /** Every room on every storey, in the building's own frame. */
  rooms: readonly Room[];
  /** Storeys, at least one. */
  storeys: number;
  /** The frame the rooms are in. */
  box: OrientedBox;
  /** Floor-to-floor, metres. */
  storeyHeight: number;
}

/**
 * Floor to floor, metres.
 *
 * Australian residential is about 2.7 m of ceiling on a 3.1 m floor plate, and
 * the number matters because it is what turns a height in the collision payload
 * into a count of storeys. A building whose height is not a whole number of
 * these -- almost all of them -- keeps the remainder as a taller top floor
 * rather than growing a 30 cm one nobody can stand in.
 */
export const STOREY_M = 3.1;

/**
 * The hallway. The owner: *"make default inside generation have a hallway
 * go down the building, and if lifts in building, past them with it clearly
 * saying 'lift'"*. A plan that was only a subdivision gave a big building a
 * maze of rooms each opening into the next; a building over `CORRIDOR_LONG_M`
 * long and `CORRIDOR_SHORT_M` wide now gets a strip `CORRIDOR_W` wide down
 * the middle of its long axis, and the rooms are cut on either side of it.
 * Every room along the strip shares a wall with it, which is exactly the
 * contact `world/interior.ts` turns into a doorway -- so the hallway is what
 * you walk down and every door is off it. The lift stands at its end; see
 * `interior.placeCore`.
 *
 * 2.6 m is a lift lobby's width and the width the cab needs (`CORE_WIDTH_M`)
 * with a little to spare; the two thresholds are what leaves a room of at
 * least `MIN_ROOM_M` on either side.
 */
export const CORRIDOR_W = 2.6;
export const CORRIDOR_LONG_M = 12;
export const CORRIDOR_SHORT_M = 2 * 4.0 + CORRIDOR_W;

/**
 * The smallest room worth generating, metres across.
 *
 * **4.5, and it was 2.2, which was the size of a real box room and the wrong
 * number entirely.** This is not an architecture generator: it is the floor of
 * a game in which a body is 0.7 m wide, sprints at seven metres a second and
 * swings a bat. A 2.2 m room is a cupboard you cannot turn around in, and a
 * house of them is a maze of cupboards — which is exactly what the owner
 * reported the first time he walked into one ("i need to be able to move around
 * inside"). Measured over 859 buildings near the spawn, the old numbers gave a
 * median room of 21 m² with a 3.8 m short side and 18% of rooms under 3 m
 * across.
 *
 * Real terraces do have 2.2 m rooms. They are not worth generating, because
 * nothing happens in them.
 */
const MIN_ROOM_M = 4.5;

/**
 * How big a room wants to be before it splits again, square metres.
 *
 * **110, and it was 26.** Same argument as `MIN_ROOM_M` above and the same
 * report: 26 m² splits a front room into two boxes. At 110 the split stops
 * while rooms are still 55–110 m², which is a bar, a lounge, a shop floor —
 * spaces two people can actually fight in.
 */
const SPLIT_AREA_M2 = 110;

/**
 * A bound on subdivision depth.
 *
 * Not a tuning knob -- a guarantee. A warehouse footprint is thousands of square
 * metres and the area rule alone would keep splitting it; this is what makes the
 * function terminate on *every* input rather than on the ones anybody tried.
 */
const MAX_DEPTH = 6;

/** Rooms per floor above which we stop, whatever the area says. */
const MAX_ROOMS_PER_FLOOR = 24;

/**
 * Integer hash, the same shape `vegetation.ts` and `power.ts` use.
 *
 * No `Math.sin` anywhere near it: DESIGN.md rule 5 and CLAUDE.md both rule out
 * the trig-based hash for anything two ends have to agree on, and an interior is
 * exactly that -- the server will one day need to know where the walls are.
 */
function hash(a: number, b: number): number {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Is `(x, z)` inside the flattened polygon? Ray cast, on the usual terms. */
export function insidePolygon(points: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = points.length >> 1;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const zi = points[i * 2 + 1];
    const xj = points[j * 2];
    const zj = points[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The minimum-area enclosing rectangle, over the polygon's own edge directions.
 *
 * Exact for a convex polygon, which is what the collision payload holds, and
 * that exactness is the difference between rooms that line up with a terrace's
 * party walls and rooms that line up with north. Degenerate input -- fewer than
 * three points, or every point in a line -- falls back to an axis-aligned box,
 * because returning nothing here would mean a door that opens onto nothing.
 */
export function orientedBox(points: Float32Array): OrientedBox {
  const n = points.length >> 1;
  if (n === 0) return { x: 0, z: 0, ex: 1, ez: 1, ux: 1, uz: 0 };

  let best: OrientedBox | null = null;
  let bestArea = Infinity;
  // Every edge is a candidate orientation. n is a hull and small -- the far
  // layer caps plan vertices -- so this is a few dozen iterations at worst.
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
      const px = points[k * 2];
      const pz = points[k * 2 + 1];
      const u = px * dx + pz * dz;
      const v = -px * dz + pz * dx;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        x: cu * dx - cv * dz,
        z: cu * dz + cv * dx,
        ex: (maxU - minU) / 2,
        ez: (maxV - minV) / 2,
        ux: dx,
        uz: dz,
      };
    }
  }
  if (best !== null) return best;

  // Every point collinear or coincident: an axis-aligned box around them.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const px = points[k * 2];
    const pz = points[k * 2 + 1];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    ex: Math.max(0.5, (maxX - minX) / 2),
    ez: Math.max(0.5, (maxZ - minZ) / 2),
    ux: 1,
    uz: 0,
  };
}

/** How many storeys a height buys. At least one, always. */
export function storeysFor(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1;
  return Math.max(1, Math.floor(height / STOREY_M));
}

/**
 * The plan.
 *
 * `seed` is the building's identity -- anything stable across sessions. The
 * same seed and the same footprint always give the same rooms, on any machine,
 * which is what lets two players stand in the same kitchen with nothing about
 * it on the wire.
 */
export function floorPlan(points: Float32Array, height: number, seed: number): FloorPlan {
  const box = orientedBox(points);
  const storeys = storeysFor(height);
  const rooms: Room[] = [];
  // The box centre in the box's own frame. Everything below subdivides in
  // *this* frame and converts back per cell.
  //
  // **It used to subdivide in world x and z**, using the oriented box's
  // extents, which is only right for a building whose walls happen to run
  // north-south. Every other building -- which is most of Sydney, and all of
  // the Rocks -- got a lattice of world-axis rectangles laid over a rotated
  // outline: rooms that poke through two walls and stop short of a third, and
  // `insidePolygon` culling the corners into a staircase. Nothing downstream
  // could have straightened that out, because `Room.ex`'s own documentation
  // says the extents are along the building's axes and they were not.
  const cu = box.x * box.ux + box.z * box.uz;
  const cv = -box.x * box.uz + box.z * box.ux;

  // The hallway, down the long axis, with a wing either side of it. See
  // `CORRIDOR_W`. The wings are the cells the subdivision starts from, so
  // nothing below knows the hallway is there; the hallway itself is a room
  // pushed whole, on every storey.
  const alongU = box.ex >= box.ez;
  const longHalf = alongU ? box.ex : box.ez;
  const shortHalf = alongU ? box.ez : box.ex;
  const hallway = longHalf * 2 >= CORRIDOR_LONG_M && shortHalf * 2 >= CORRIDOR_SHORT_M;
  const wingHalf = (shortHalf * 2 - CORRIDOR_W) / 4;
  const wingOff = CORRIDOR_W / 2 + wingHalf;

  for (let storey = 0; storey < storeys; storey++) {
    const cells: Array<{ x: number; z: number; ex: number; ez: number; depth: number; wing: boolean }> = hallway
      ? alongU
        ? [
            { x: cu, z: cv - wingOff, ex: box.ex, ez: wingHalf, depth: 1, wing: true },
            { x: cu, z: cv + wingOff, ex: box.ex, ez: wingHalf, depth: 1, wing: true },
          ]
        : [
            { x: cu - wingOff, z: cv, ex: wingHalf, ez: box.ez, depth: 1, wing: true },
            { x: cu + wingOff, z: cv, ex: wingHalf, ez: box.ez, depth: 1, wing: true },
          ]
      : [{ x: cu, z: cv, ex: box.ex, ez: box.ez, depth: 0, wing: false }];
    if (hallway) {
      const ex = alongU ? box.ex : CORRIDOR_W / 2;
      const ez = alongU ? CORRIDOR_W / 2 : box.ez;
      rooms.push({ x: box.x, z: box.z, ex, ez, u: cu, v: cv, storey, corridor: true });
    }
    let head = 0;
    // The hallway counts against the floor's cap like any room.
    let made = hallway ? 1 : 0;
    while (head < cells.length) {
      const cell = cells[head++];
      const area = cell.ex * 2 * (cell.ez * 2);
      // **The cap stops the splitting, not the walk.**
      //
      // It used to end the loop -- `made < MAX_ROOMS_PER_FLOOR` in the while --
      // which left whatever was still queued as no room at all. A 30 m block
      // came out as twenty-four rooms with holes between them where the queue
      // had been cut off, and `world/interior.ts` then found four rooms with no
      // neighbour to put a doorway to: islands in a floor that was never
      // finished. Splitting stops when keeping *everything still queued* would
      // breach the cap, so the plan is always a complete tiling of the box and a
      // building too big to subdivide finely gets larger rooms rather than a
      // partial floor.
      const ifKeptAll = made + 1 + (cells.length - head);
      // A wing beside the hallway is split *along* it into rooms of at least
      // `MIN_ROOM_M` across, whatever its depth -- the rooms off a hotel
      // corridor are the shape of their doors' spacing, not squares -- where
      // a room in the open plan must be `2 * MIN_ROOM_M` both ways before it
      // is cut, so nothing becomes a cupboard.
      const splittable =
        cell.depth < MAX_DEPTH &&
        (cell.wing
          ? Math.max(cell.ex, cell.ez) * 2 > MIN_ROOM_M * 2 && Math.min(cell.ex, cell.ez) * 2 >= MIN_ROOM_M * 0.85
          : area > SPLIT_AREA_M2 && Math.min(cell.ex, cell.ez) * 2 > MIN_ROOM_M * 2) &&
        ifKeptAll + 1 <= MAX_ROOMS_PER_FLOOR;
      if (!splittable) {
        // Back to world, because the polygon is in world metres and so is
        // everything that will draw this room.
        const wx = cell.x * box.ux - cell.z * box.uz;
        const wz = cell.x * box.uz + cell.z * box.ux;
        // Keep it only if it is actually inside the building. This one clause
        // is what makes an L-shape, a courtyard and a horseshoe all work with
        // no special case anywhere: the cells in the notch simply fail it.
        if (insidePolygon(points, wx, wz)) {
          rooms.push({ x: wx, z: wz, ex: cell.ex, ez: cell.ez, u: cell.x, v: cell.z, storey });
          made++;
        }
        continue;
      }
      // Split the long way, so rooms tend to squareness rather than to
      // corridors nobody can furnish. The position is hashed rather than
      // halved, so a terrace does not read as a spreadsheet.
      const r = hash(seed + storey * 7919, head * 31 + cell.depth);
      const t = 0.38 + r * 0.24;
      if (cell.ex >= cell.ez) {
        const cut = cell.ex * 2 * t;
        cells.push({ x: cell.x - cell.ex + cut / 2, z: cell.z, ex: cut / 2, ez: cell.ez, depth: cell.depth + 1, wing: cell.wing });
        cells.push({
          x: cell.x - cell.ex + cut + (cell.ex * 2 - cut) / 2,
          z: cell.z,
          ex: (cell.ex * 2 - cut) / 2,
          ez: cell.ez,
          depth: cell.depth + 1,
          wing: cell.wing,
        });
      } else {
        const cut = cell.ez * 2 * t;
        cells.push({ x: cell.x, z: cell.z - cell.ez + cut / 2, ex: cell.ex, ez: cut / 2, depth: cell.depth + 1, wing: cell.wing });
        cells.push({
          x: cell.x,
          z: cell.z - cell.ez + cut + (cell.ez * 2 - cut) / 2,
          ex: cell.ex,
          ez: (cell.ez * 2 - cut) / 2,
          depth: cell.depth + 1,
          wing: cell.wing,
        });
      }
    }
    // **A storey always has a room.** A footprint whose centre cells all fall
    // outside the polygon -- a thin diagonal, a crescent -- would otherwise
    // produce an empty floor, which is a door that opens onto a void.
    if (!rooms.some((room) => room.storey === storey)) {
      rooms.push({
        x: box.x,
        z: box.z,
        ex: Math.max(1, box.ex * 0.4),
        ez: Math.max(1, box.ez * 0.4),
        u: cu,
        v: cv,
        storey,
      });
    }
  }

  return { rooms, storeys, box, storeyHeight: STOREY_M };
}

/** Self-check. On both boot lists: it is geometry and imports nothing. */
export function verifyFloorPlan(): string[] {
  const failures: string[] = [];

  // --- The hallway. A 30 x 14 block gets one strip down its long axis that
  // every other room on the floor touches; a terrace gets none.
  {
    const plan = floorPlan(new Float32Array([0, 0, 30, 0, 30, 14, 0, 14]), 9, 7);
    const halls = plan.rooms.filter((r) => r.corridor && r.storey === 0);
    if (halls.length !== 1) failures.push(`A 30 x 14 block has ${halls.length} hallways on its ground floor, not one.`);
    else {
      const hall = halls[0];
      if (Math.abs(Math.max(hall.ex, hall.ez) * 2 - 30) > 0.01 || Math.abs(Math.min(hall.ex, hall.ez) * 2 - CORRIDOR_W) > 0.01) {
        failures.push(`The hallway is ${(hall.ex * 2).toFixed(1)} x ${(hall.ez * 2).toFixed(1)} m; it should run the 30 m and be ${CORRIDOR_W} m wide.`);
      }
      let off = 0;
      for (const r of plan.rooms) {
        if (r.storey !== 0 || r.corridor) continue;
        // Touching the hallway: the room's near edge on the hallway's line.
        const touch = hall.ex >= hall.ez
          ? Math.abs(Math.abs(r.v - hall.v) - (hall.ez + r.ez)) < 0.02
          : Math.abs(Math.abs(r.u - hall.u) - (hall.ex + r.ex)) < 0.02;
        if (!touch) off++;
      }
      if (off > 0) failures.push(`${off} rooms on the ground floor do not open onto the hallway.`);
    }
    const terrace = floorPlan(new Float32Array([0, 0, 6, 0, 6, 18, 0, 18]), 7.4, 3);
    if (terrace.rooms.some((r) => r.corridor)) failures.push('A 6 m terrace grew a hallway; there is no room for one.');
  }
  const poly = (...xz: number[]): Float32Array => new Float32Array(xz);

  /** Every footprint shape the city can actually hand this. */
  const cases: Array<{ name: string; points: Float32Array; height: number }> = [
    { name: 'a terrace', points: poly(0, 0, 6, 0, 6, 18, 0, 18), height: 7.4 },
    { name: 'a shed', points: poly(0, 0, 2.2, 0, 2.2, 2.4, 0, 2.4), height: 2.3 },
    { name: 'a tower', points: poly(0, 0, 38, 0, 38, 41, 0, 41), height: 214 },
    { name: 'a warehouse', points: poly(0, 0, 120, 0, 120, 64, 0, 64), height: 9 },
    { name: 'a triangle', points: poly(0, 0, 14, 0, 7, 12), height: 5 },
    { name: 'a diagonal terrace', points: poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8), height: 6.5 },
    { name: 'an L', points: poly(0, 0, 20, 0, 20, 8, 8, 8, 8, 20, 0, 20), height: 6 },
    { name: 'a courtyard block', points: poly(0, 0, 30, 0, 30, 30, 0, 30), height: 12 },
    { name: 'a sliver', points: poly(0, 0, 40, 0.4, 40, 1.2, 0, 0.8), height: 4 },
    { name: 'a forty-gon', points: (() => {
        const out: number[] = [];
        for (let i = 0; i < 40; i++) {
          // No Math.sin: a deterministic polygon from integer arithmetic, which
          // is the same rule the generator itself obeys.
          const t = i / 40;
          const q = t < 0.5 ? t * 4 - 1 : 3 - t * 4;
          const r = t < 0.25 || t >= 0.75 ? 1 : -1;
          out.push(12 * q, 12 * r * (1 - Math.abs(q)));
        }
        return new Float32Array(out);
      })(), height: 18 },
    { name: 'three points', points: poly(0, 0, 5, 0, 0, 5), height: 3 },
    { name: 'collinear points', points: poly(0, 0, 5, 0, 10, 0), height: 3 },
    { name: 'one point twice', points: poly(3, 3, 3, 3, 3, 3), height: 3 },
    { name: 'no points', points: poly(), height: 3 },
    { name: 'a negative height', points: poly(0, 0, 8, 0, 8, 8, 0, 8), height: -4 },
    { name: 'a NaN height', points: poly(0, 0, 8, 0, 8, 8, 0, 8), height: NaN },
  ];

  // --- **Total.** There is no curated list of buildings, so every footprint in
  // Greater Sydney reaches this. A shape that throws, hangs or returns nothing
  // is a door that opens onto a crash, found by a player walking up to it.
  for (const c of cases) {
    let plan: FloorPlan | null = null;
    try {
      plan = floorPlan(c.points, c.height, 12345);
    } catch (err) {
      failures.push(`${c.name} threw: ${String(err).slice(0, 80)}`);
      continue;
    }
    if (plan.storeys < 1) failures.push(`${c.name} produced ${plan.storeys} storeys.`);
    if (plan.rooms.length === 0) failures.push(`${c.name} produced no rooms at all -- a door onto nothing.`);
    for (let s = 0; s < plan.storeys; s++) {
      if (!plan.rooms.some((r) => r.storey === s)) failures.push(`${c.name} left storey ${s} empty.`);
    }
    for (const r of plan.rooms) {
      if (!Number.isFinite(r.x) || !Number.isFinite(r.z) || !Number.isFinite(r.ex) || !Number.isFinite(r.ez)) {
        failures.push(`${c.name} produced a room with a non-finite dimension.`);
        break;
      }
      if (r.ex <= 0 || r.ez <= 0) {
        failures.push(`${c.name} produced a room with no area.`);
        break;
      }
    }
    if (plan.rooms.length > MAX_ROOMS_PER_FLOOR * plan.storeys + plan.storeys) {
      failures.push(`${c.name} produced ${plan.rooms.length} rooms; the per-floor cap is not holding.`);
    }
  }

  // --- Deterministic, which is what lets two players share a kitchen for free.
  //
  // A building big enough to *have* a choice in it: the fixture used to be
  // 9 x 14 m, which was two rooms under the old `SPLIT_AREA_M2` and is one room
  // under the new one -- and one room is the same room whatever the seed, so
  // the check passed the first half and failed the second by measuring nothing.
  {
    const pts = poly(0, 0, 24, 0, 24, 30, 0, 30);
    const a = floorPlan(pts, 9.3, 777);
    const b = floorPlan(pts, 9.3, 777);
    if (JSON.stringify(a.rooms) !== JSON.stringify(b.rooms)) {
      failures.push('the same building generated two different plans; nothing could be shared without sending it.');
    }
    const c = floorPlan(pts, 9.3, 778);
    if (JSON.stringify(a.rooms) === JSON.stringify(c.rooms)) {
      failures.push('two different buildings generated an identical plan; the seed is doing nothing.');
    }
  }

  // --- Rooms are inside the building.
  //
  // A room whose centre is outside the footprint is a room hanging over the
  // street, which is the failure the polygon test exists to prevent.
  {
    const l = poly(0, 0, 20, 0, 20, 8, 8, 8, 8, 20, 0, 20);
    const plan = floorPlan(l, 6, 42);
    let outside = 0;
    for (const r of plan.rooms) if (!insidePolygon(l, r.x, r.z)) outside++;
    // One fallback room per storey is allowed to sit at the box centre.
    if (outside > plan.storeys) {
      failures.push(`${outside} rooms of an L-shaped building stand outside its own walls.`);
    }
  }

  // --- Storeys come from the height, and the ground floor always exists.
  {
    if (storeysFor(2.0) !== 1) failures.push(`a 2 m building has ${storeysFor(2.0)} storeys.`);
    if (storeysFor(0) !== 1) failures.push('a zero-height building has no ground floor.');
    if (storeysFor(-5) !== 1) failures.push('a negative height produced a bad storey count.');
    if (storeysFor(NaN) !== 1) failures.push('a NaN height produced a bad storey count.');
    if (storeysFor(9.4) !== 3) failures.push(`9.4 m is ${storeysFor(9.4)} storeys, not 3.`);
  }

  // --- The box follows the building, not the compass.
  //
  // A terrace at 45 degrees must get rooms along its party walls. Its own edge
  // direction is (1,1)/root 2, and the minimum-area rectangle over a convex
  // hull is exact, so this is a real assertion rather than a tolerance.
  {
    const diag = poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8);
    const box = orientedBox(diag);
    const axisAligned = Math.abs(box.ux) < 1e-3 || Math.abs(box.uz) < 1e-3;
    if (axisAligned) {
      failures.push('a diagonal building was given a north-aligned box; its rooms would cut across its walls.');
    }
    const len = Math.sqrt(box.ux * box.ux + box.uz * box.uz);
    if (Math.abs(len - 1) > 1e-6) failures.push(`the box axis is not a unit vector (${len}).`);
  }

  // --- **A storey is a complete tiling of the box.**
  //
  // The property the room cap used to break: it ended the subdivision walk, so
  // whatever was still queued became no room at all and a 30 m block came out
  // with holes in it. Two assertions over a rectangle, where the polygon culls
  // nothing: the rooms' areas add up to the box's, and no two of them overlap.
  // Either alone passes on a plan with a hole *and* a double-covered cell.
  {
    for (const [what, pts, height] of [
      ['a 30 m block', poly(0, 0, 30, 0, 30, 30, 0, 30), 6],
      ['a warehouse', poly(0, 0, 400, 0, 400, 260, 0, 260), 6],
      ['a terrace', poly(0, 0, 6, 0, 6, 18, 0, 18), 6],
    ] as Array<[string, Float32Array, number]>) {
      const plan = floorPlan(pts, height, 31337);
      const floor = plan.rooms.filter((r) => r.storey === 0);
      let area = 0;
      for (const r of floor) area += r.ex * 2 * (r.ez * 2);
      const boxArea = plan.box.ex * 2 * (plan.box.ez * 2);
      if (Math.abs(area - boxArea) > boxArea * 0.001) {
        failures.push(`${what}'s ground floor covers ${area.toFixed(0)} m2 of a ${boxArea.toFixed(0)} m2 box; the plan has holes in it.`);
      }
      let overlaps = 0;
      for (let i = 0; i < floor.length; i++) {
        for (let j = i + 1; j < floor.length; j++) {
          const a = floor[i];
          const b = floor[j];
          const du = Math.abs(a.u - b.u) - (a.ex + b.ex);
          const dv = Math.abs(a.v - b.v) - (a.ez + b.ez);
          if (du < -1e-3 && dv < -1e-3) overlaps++;
        }
      }
      if (overlaps > 0) failures.push(`${what} has ${overlaps} pairs of rooms standing in each other.`);
      if (floor.length > MAX_ROOMS_PER_FLOOR) {
        failures.push(`${what} produced ${floor.length} rooms on one floor; the cap is ${MAX_ROOMS_PER_FLOOR}.`);
      }
    }
  }

  // --- **The rooms are in the building's frame, not the compass's.**
  //
  // The one property `Room.u`/`Room.v` exists to make checkable, and the bug it
  // was written for: the subdivision ran in world x and z while claiming its
  // extents were along the building's own axes, so a rotated terrace got a
  // lattice of north-aligned rectangles laid over a diagonal outline. Two
  // assertions, because either alone passes on the broken version -- the local
  // centre must convert back to the world one, and the room's own corners in
  // the local frame must lie inside the oriented box.
  {
    const diag = poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8);
    const plan = floorPlan(diag, 6.5, 4242);
    const b = plan.box;
    const minU = b.x * b.ux + b.z * b.uz - b.ex;
    const maxU = b.x * b.ux + b.z * b.uz + b.ex;
    const minV = -b.x * b.uz + b.z * b.ux - b.ez;
    const maxV = -b.x * b.uz + b.z * b.ux + b.ez;
    let strayed = 0;
    let mismatched = 0;
    for (const r of plan.rooms) {
      const wx = r.u * b.ux - r.v * b.uz;
      const wz = r.u * b.uz + r.v * b.ux;
      if (Math.abs(wx - r.x) > 1e-3 || Math.abs(wz - r.z) > 1e-3) mismatched++;
      if (
        r.u - r.ex < minU - 1e-3 || r.u + r.ex > maxU + 1e-3 ||
        r.v - r.ez < minV - 1e-3 || r.v + r.ez > maxV + 1e-3
      ) {
        strayed++;
      }
    }
    if (mismatched > 0) failures.push(`${mismatched} rooms' local centres do not convert back to their world ones.`);
    if (strayed > 0) {
      failures.push(`${strayed} rooms of a diagonal terrace fall outside its own box; the plan is laid out on the compass.`);
    }
  }

  // --- Big buildings terminate.
  //
  // The area rule alone would subdivide a warehouse for ever; `MAX_DEPTH` is
  // what makes this a guarantee rather than a hope, and a hang here is the game
  // freezing on a door press.
  {
    const huge = poly(0, 0, 400, 0, 400, 260, 0, 260);
    const plan = floorPlan(huge, 40, 9);
    if (plan.rooms.length > MAX_ROOMS_PER_FLOOR * plan.storeys + plan.storeys) {
      failures.push(`a 400 x 260 m building produced ${plan.rooms.length} rooms; subdivision is not bounded.`);
    }
  }

  return failures;
}
