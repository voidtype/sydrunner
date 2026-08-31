/**
 * Which building you are standing at, and where its door is.
 *
 * The half of interiors that has to work before any of the rest can: a player
 * walks up to a wall anywhere in sixty kilometres of city and the game has to
 * answer *which building is this* and *where would its door be*, from data it
 * already has. `world/floorplan.ts` decides what is behind the door; this
 * decides that there is one.
 *
 * Everything here comes off `player/collision.ts`'s `Prism`: the real footprint
 * polygon in world metres, the pad's ground height, the building's height.
 * Nothing is authored, nothing is downloaded, and no building is special --
 * which is the whole point, because the brief is that *any* door lets you in.
 *
 * ## Why the nearest edge rather than a door in the data
 *
 * OSM has no door for a Sydney terrace and never will. But a building's own
 * outline says where a door goes better than a guess would: the wall you are
 * standing at is the wall you would knock on. So the door is the point on the
 * footprint's perimeter closest to the player, and it exists only when the
 * player is close to that perimeter and looking at it -- which is the same
 * shape of test `world/doormarker.ts` settled on for station entrances after a
 * player reported not being able to find one.
 *
 * The prisms are convex hulls, so "closest point on the perimeter" is exact and
 * cheap: a loop over a handful of edges, no sampling and no tolerance.
 */

/** The shape of the prisms this reads. `player/collision.ts` owns the real one. */
export interface DoorPrism {
  points: Float32Array;
  base: number;
  height: number;
  structural: boolean;
}

/** A door that could be opened, found on a real building. */
export interface DoorSite {
  /** The door's world position, on the building's wall. */
  x: number;
  z: number;
  /** Outward normal of the wall it sits in, unit length. */
  nx: number;
  nz: number;
  /** The building it belongs to. */
  prism: DoorPrism;
  /** How far the player is from the wall, metres. */
  distance: number;
}

/**
 * How close counts as "at the door".
 *
 * 2.6 m: close enough that you are plainly standing at this building and not the
 * one behind it, far enough that you do not have to be scraping the render.
 */
export const DOOR_REACH_M = 2.6;

/**
 * How square-on you have to be looking, as a dot product against the wall.
 *
 * 0.35 is about seventy degrees off straight-on, which is generous -- the test
 * is there to stop a door offering itself while you run *past* a terrace, not to
 * make you line up.
 */
const FACING_MIN = 0.35;

/**
 * The tallest thing that is not a building.
 *
 * Fences, planters and the deck volumes share the collision payload with real
 * buildings. Something under this has no inside worth generating, and offering a
 * door on a 1.2 m wall is the kind of thing that makes the whole feature feel
 * broken.
 */
const MIN_BUILDING_H = 2.4;

/** Closest point on a segment to a point, and how far away it is. */
function closestOnSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
): { x: number; z: number; d2: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  const x = ax + dx * t;
  const z = az + dz * t;
  const ex = px - x;
  const ez = pz - z;
  return { x, z, d2: ex * ex + ez * ez, t };
}

/**
 * The door on the building the player is at, or null.
 *
 * `yawX`/`yawZ` is the direction the player is looking, as a unit vector on the
 * ground plane. Null means "no door here", which is the answer almost everywhere
 * and has to be cheap: the loop is over prisms the caller already found nearby.
 */
export function doorAt(
  prisms: readonly DoorPrism[],
  px: number,
  pz: number,
  yawX: number,
  yawZ: number,
): DoorSite | null {
  let best: DoorSite | null = null;
  let bestD2 = DOOR_REACH_M * DOOR_REACH_M;

  for (const prism of prisms) {
    if (prism.height < MIN_BUILDING_H) continue;
    const pts = prism.points;
    const n = pts.length >> 1;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[j * 2];
      const az = pts[j * 2 + 1];
      const bx = pts[i * 2];
      const bz = pts[i * 2 + 1];
      const hit = closestOnSegment(ax, az, bx, bz, px, pz);
      if (hit.d2 >= bestD2) continue;
      // Outward normal. The hulls this reads wind consistently, but rather than
      // trust that, the normal is flipped to point away from the polygon's own
      // centroid -- which is right for a convex shape however it was wound, and
      // wrong for nothing this will ever be handed.
      let ex = bx - ax;
      let ez = bz - az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (!(len > 1e-6)) continue;
      ex /= len;
      ez /= len;
      let nx = ez;
      let nz = -ex;
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < n; k++) {
        cx += pts[k * 2];
        cz += pts[k * 2 + 1];
      }
      cx /= n;
      cz /= n;
      if ((hit.x - cx) * nx + (hit.z - cz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      // Looking at the wall, not past it: the player's gaze must oppose the
      // outward normal. Without this a door offers itself as you sprint along a
      // terrace row, and the prompt flickers between six houses.
      if (yawX * nx + yawZ * nz > -FACING_MIN) continue;
      bestD2 = hit.d2;
      best = { x: hit.x, z: hit.z, nx, nz, prism, distance: Math.sqrt(hit.d2) };
    }
  }
  return best;
}

/**
 * A stable identity for a building, from its own geometry.
 *
 * The seed `floorPlan` needs, and it has to be the same on every machine and
 * across every session with nothing stored -- otherwise two players open one
 * door onto two different houses. The footprint is that identity: it comes out
 * of the same baked payload for everybody, so hashing its rounded corners is a
 * name the building carries itself.
 *
 * Rounded to a centimetre before hashing, so a float that differs in its last
 * bit between two machines cannot rename the building.
 */
export function buildingSeed(prism: DoorPrism): number {
  const pts = prism.points;
  let h = 0x811c9dc5;
  for (let i = 0; i < pts.length; i++) {
    h ^= Math.round(pts[i] * 100) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  h ^= Math.round(prism.height * 100) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Self-check. On both boot lists: geometry, no imports. */
export function verifyDoorway(): string[] {
  const failures: string[] = [];
  const square = (s: number): Float32Array => new Float32Array([0, 0, s, 0, s, s, 0, s]);
  const house = (h = 7): DoorPrism => ({ points: square(10), base: 0, height: h, structural: true });

  // --- Standing at the south wall, looking north at it.
  {
    const p = house();
    const site = doorAt([p], 5, -1, 0, 1);
    if (site === null) failures.push('a player standing a metre off a wall and facing it was offered no door.');
    else {
      if (Math.abs(site.z) > 1e-6) failures.push(`the door landed at z=${site.z}, not on the wall.`);
      if (Math.abs(site.x - 5) > 1e-6) failures.push(`the door landed at x=${site.x}, not beside the player.`);
      if (site.nz > -0.9) failures.push(`the wall's outward normal points ${site.nx},${site.nz} -- it should face the player.`);
    }
  }

  // --- Facing away offers nothing.
  //
  // Without this the prompt flickers between six houses as you run down a
  // terrace row, which reads as the feature being broken rather than as a test.
  {
    const p = house();
    if (doorAt([p], 5, -1, 0, -1) !== null) failures.push('a door was offered to a player facing away from the wall.');
  }

  // --- Out of reach offers nothing.
  {
    const p = house();
    if (doorAt([p], 5, -DOOR_REACH_M - 0.5, 0, 1) !== null) failures.push('a door was offered from beyond the reach.');
    if (doorAt([p], 5, -DOOR_REACH_M + 0.3, 0, 1) === null) failures.push('a door was refused from inside the reach.');
  }

  // --- Low things are not buildings.
  {
    const fence: DoorPrism = { points: square(10), base: 0, height: 1.1, structural: false };
    if (doorAt([fence], 5, -1, 0, 1) !== null) failures.push('a 1.1 m fence offered a door.');
  }

  // --- The nearest building wins, not the first in the list.
  {
    const far: DoorPrism = { points: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), base: 0, height: 7, structural: true };
    const near: DoorPrism = { points: new Float32Array([0, -6, 10, -6, 10, -4, 0, -4]), base: 0, height: 7, structural: true };
    const site = doorAt([far, near], 5, -3.2, 0, -1);
    if (site === null) failures.push('two buildings and no door at all.');
    else if (site.prism !== near) failures.push('a further building won over a nearer one.');
  }

  // --- Degenerate footprints are refused rather than crashing.
  {
    const bad: DoorPrism[] = [
      { points: new Float32Array([]), base: 0, height: 7, structural: true },
      { points: new Float32Array([1, 1]), base: 0, height: 7, structural: true },
      { points: new Float32Array([1, 1, 1, 1, 1, 1]), base: 0, height: 7, structural: true },
    ];
    let threw = false;
    try {
      doorAt(bad, 1, 1, 0, 1);
    } catch {
      threw = true;
    }
    if (threw) failures.push('a degenerate footprint crashed the door search; a player found it by walking.');
  }

  // --- A building's name is its own, and stable.
  {
    const a = buildingSeed(house());
    const b = buildingSeed(house());
    if (a !== b) failures.push('the same building hashed to two different seeds; two players would see two houses.');
    const other = buildingSeed({ points: square(11), base: 0, height: 7, structural: true });
    if (a === other) failures.push('two different buildings share a seed; every house would be the same house.');
    const taller = buildingSeed(house(9));
    if (a === taller) failures.push('height does not change the seed; a shop and the flat above it would be identical.');
    if (!Number.isInteger(a) || a < 0) failures.push(`a building seed is not a non-negative integer (${a}).`);
  }

  return failures;
}
