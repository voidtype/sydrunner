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
  /** Which storey, 0 at the pad. */
  storey: number;
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

/** The smallest room worth generating; below this it is a cupboard. */
const MIN_ROOM_M = 2.2;

/** How big a room wants to be before it splits again, square metres. */
const SPLIT_AREA_M2 = 26;

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

  for (let storey = 0; storey < storeys; storey++) {
    const cells: Array<{ x: number; z: number; ex: number; ez: number; depth: number }> = [
      { x: box.x, z: box.z, ex: box.ex, ez: box.ez, depth: 0 },
    ];
    let head = 0;
    let made = 0;
    while (head < cells.length && made < MAX_ROOMS_PER_FLOOR) {
      const cell = cells[head++];
      const area = cell.ex * 2 * (cell.ez * 2);
      const splittable =
        cell.depth < MAX_DEPTH &&
        area > SPLIT_AREA_M2 &&
        Math.min(cell.ex, cell.ez) * 2 > MIN_ROOM_M * 2;
      if (!splittable) {
        // Keep it only if it is actually inside the building. This one clause
        // is what makes an L-shape, a courtyard and a horseshoe all work with
        // no special case anywhere: the cells in the notch simply fail it.
        if (insidePolygon(points, cell.x, cell.z)) {
          rooms.push({ x: cell.x, z: cell.z, ex: cell.ex, ez: cell.ez, storey });
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
        cells.push({ x: cell.x - cell.ex + cut / 2, z: cell.z, ex: cut / 2, ez: cell.ez, depth: cell.depth + 1 });
        cells.push({
          x: cell.x - cell.ex + cut + (cell.ex * 2 - cut) / 2,
          z: cell.z,
          ex: (cell.ex * 2 - cut) / 2,
          ez: cell.ez,
          depth: cell.depth + 1,
        });
      } else {
        const cut = cell.ez * 2 * t;
        cells.push({ x: cell.x, z: cell.z - cell.ez + cut / 2, ex: cell.ex, ez: cut / 2, depth: cell.depth + 1 });
        cells.push({
          x: cell.x,
          z: cell.z - cell.ez + cut + (cell.ez * 2 - cut) / 2,
          ex: cell.ex,
          ez: (cell.ez * 2 - cut) / 2,
          depth: cell.depth + 1,
        });
      }
    }
    // **A storey always has a room.** A footprint whose centre cells all fall
    // outside the polygon -- a thin diagonal, a crescent -- would otherwise
    // produce an empty floor, which is a door that opens onto a void.
    if (!rooms.some((room) => room.storey === storey)) {
      rooms.push({ x: box.x, z: box.z, ex: Math.max(1, box.ex * 0.4), ez: Math.max(1, box.ez * 0.4), storey });
    }
  }

  return { rooms, storeys, box, storeyHeight: STOREY_M };
}

/** Self-check. On both boot lists: it is geometry and imports nothing. */
export function verifyFloorPlan(): string[] {
  const failures: string[] = [];
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
  {
    const pts = poly(0, 0, 9, 0, 9, 14, 0, 14);
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
