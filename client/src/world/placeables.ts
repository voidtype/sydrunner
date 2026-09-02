/**
 * Things people put in a room.
 *
 * `world/interior.ts` generates a building's inside *from* the building. This
 * is the half that is not derived: what a player has put in it, which is the
 * first thing in this whole feature that has to be **stored and sent**, because
 * nothing about it can be recomputed from a footprint.
 *
 * Three-free and pure, because `server/sim.ts` adjudicates every placement and
 * `server/interiors.ts` writes them to disk -- and because both ends have to
 * agree exactly about where a couch is and how big it is, or one player walks
 * through something the other is standing on.
 *
 * Named `placeables` rather than `furniture` because `world/furniture.ts` is
 * already the street's: wheelie bins, blade signs and traffic signals.
 *
 * ## The catalogue is a table, and it is one row long
 *
 * The owner's brief: *"just add a couch for now, well add walls and paint etc
 * later"*. So the shape is a **table** -- a kind id, a footprint, a height --
 * rather than a couch with its numbers inlined, because the second row is the
 * one that would otherwise be a rewrite. A table or a bed is a row here and a
 * case in the mesh builder.
 *
 * ## Quarter turns, in the building's frame
 *
 * A thing is placed at a quarter turn, and the turn is **relative to the
 * building's own axis** rather than to north. A room's walls run with the
 * building; furniture that snapped to the compass would sit askew in every
 * terrace in Sydney, which is the bug `floorplan.ts` had and the same fix.
 *
 * A quarter turn of `(x, z)` is `(-z, x)` -- integer arithmetic, no trig, so
 * the browser predicting a couch and the server holding it agree to the last
 * bit. DESIGN.md rule 5.
 *
 * ## Why a room can afford to be expensive
 *
 * The owner, on why an interior is its own instance: *"thats why we made the
 * inside its own instance instead of the live world :) so outside doesnt slow
 * down from expensive insides"*. Exactly so, and it is what licenses a couch
 * made of seven boxes rather than one: nothing in here is ever drawn, stepped
 * or streamed by anybody standing in the street.
 */

/** The kinds. One so far; see the header for why it is a table anyway. */
export const PLACEABLE = { COUCH: 0 } as const;

/** How many kinds exist. The wire and every validator bound against this. */
export const PLACEABLE_KINDS = 1;

/** What one kind is, physically. */
export interface PlaceableKind {
  name: string;
  /** Half-extents along its own axis and across it, metres. */
  hx: number;
  hz: number;
  /** How tall it stands. */
  height: number;
}

/**
 * The catalogue.
 *
 * A two-seater at 1.9 x 0.9 m, which is a real couch. The numbers matter twice
 * over: they are the collision box as well as the mesh, and a couch you can
 * stand inside is worse than no couch at all.
 */
export const PLACEABLES: readonly PlaceableKind[] = [
  { name: 'couch', hx: 0.95, hz: 0.45, height: 0.82 },
];

/**
 * One thing, placed. The unit of storage and of the wire.
 *
 * `x`/`z` are world metres -- the **centre** of the footprint -- and `turn` is
 * 0..3 quarter turns from the building's own axis.
 */
export interface Placement {
  kind: number;
  x: number;
  z: number;
  /** 0..3. See the header. */
  turn: number;
}

/**
 * How many things one building may hold.
 *
 * A cap rather than a policy, and it is doing two jobs: it bounds the disk and
 * the wire (64 x 10 bytes is a 640-byte frame), and while *anyone* can furnish
 * *any* building -- the owner's call for now, with a $20,000 claim to come --
 * it is the only thing standing between a pub and somebody who wants to fill it
 * with two thousand couches.
 */
export const MAX_PER_SPACE = 64;

/**
 * How far a body must stay from a placed thing, metres.
 *
 * `controller.PLAYER_RADIUS` restated rather than imported, on the terms
 * `game/spawn.ts` restates it: this file may not depend on the controller.
 *
 * **0.34, and it said 0.35 with a comment claiming a check kept it honest.**
 * No check did -- this file cannot import the controller to compare -- so the
 * comparison lives where `spawn.ts`'s does: `server/integration-check.ts`,
 * which can see both. The wrong value cost nothing (both ends used the same
 * wrong number) and the comment cost more than the value did.
 */
export const BODY_RADIUS_M = 0.34;

/** Is this a kind that exists? Everything off the wire goes through here. */
export function knownKind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= 0 && kind < PLACEABLE_KINDS;
}

/**
 * A placement off the wire or off disk, or null.
 *
 * `accounts.sanitiseLastPos`' discipline: a placement with a NaN in it is not a
 * placement, and one that came back as a couch at the origin would be a couch
 * in the middle of the harbour that everybody in the building can see.
 */
export function sanitisePlacement(raw: unknown): Placement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Partial<Placement>;
  const kind = Number(v.kind);
  const x = Number(v.x);
  const z = Number(v.z);
  const turn = Number(v.turn);
  if (!knownKind(kind)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) return null;
  if (!Number.isInteger(turn) || turn < 0 || turn > 3) return null;
  return { kind, x, z, turn };
}

/**
 * The axis a placement points along, from the building's own and a quarter turn.
 *
 * One quarter turn of `(x, z)` is `(-z, x)`: sign flips and swaps, so four of
 * them are bit-identical to none. No trig means no drift, which matters because
 * this runs on both ends over the same numbers.
 */
export function axisOf(ux: number, uz: number, turn: number): { ax: number; az: number } {
  let ax = ux;
  let az = uz;
  for (let i = 0; i < (turn & 3); i++) {
    const nx = -az;
    az = ax;
    ax = nx;
  }
  return { ax, az };
}

/** One placed thing's box, in the frame the collision test wants. */
export interface PlacedBox {
  x: number;
  z: number;
  ax: number;
  az: number;
  hx: number;
  hz: number;
  height: number;
}

/** Where a placement sits, physically. */
export function boxOf(p: Placement, ux: number, uz: number): PlacedBox {
  const kind = PLACEABLES[p.kind] ?? PLACEABLES[0];
  const { ax, az } = axisOf(ux, uz, p.turn);
  return { x: p.x, z: p.z, ax, az, hx: kind.hx, hz: kind.hz, height: kind.height };
}

/**
 * Push a circle out of a box, if it is in one.
 *
 * `CollisionWorld.resolve`'s shape, for `world/interior.ts` to fold into its
 * own. The point is taken into the box's frame, clamped to the box and taken
 * back -- exact for a rectangle at any angle, and four multiplies each way.
 *
 * A body **inside** the box entirely comes out through the shallowest face.
 * The server refuses a placement on top of somebody, but a client predicting a
 * frame early can still produce it, and pushing along a zero-length vector
 * would put them nowhere at all.
 */
export function pushOutOfBox(
  b: PlacedBox,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number; hit: boolean } {
  const dx = x - b.x;
  const dz = z - b.z;
  const u = dx * b.ax + dz * b.az;
  const v = -dx * b.az + dz * b.ax;
  const cu = Math.max(-b.hx, Math.min(b.hx, u));
  const cv = Math.max(-b.hz, Math.min(b.hz, v));
  let eu = u - cu;
  let ev = v - cv;
  let d = Math.sqrt(eu * eu + ev * ev);
  if (d > radius) return { x, z, hit: false };
  if (d < 1e-9) {
    // Inside it. Out through the nearest face, and `d` goes negative so the
    // push below carries the body all the way through that face and clear.
    const outU = b.hx - Math.abs(u);
    const outV = b.hz - Math.abs(v);
    if (outU < outV) {
      eu = u >= 0 ? 1 : -1;
      ev = 0;
      d = -outU;
    } else {
      eu = 0;
      ev = v >= 0 ? 1 : -1;
      d = -outV;
    }
  } else {
    eu /= d;
    ev /= d;
  }
  const push = radius - d;
  const wu = u + eu * push;
  const wv = v + ev * push;
  return { x: b.x + wu * b.ax - wv * b.az, z: b.z + wu * b.az + wv * b.ax, hit: true };
}

/** How far a point is from the outside of a box: negative inside it. */
export function boxClearance(b: PlacedBox, x: number, z: number): number {
  const dx = x - b.x;
  const dz = z - b.z;
  const u = dx * b.ax + dz * b.az;
  const v = -dx * b.az + dz * b.ax;
  const eu = Math.abs(u) - b.hx;
  const ev = Math.abs(v) - b.hz;
  if (eu <= 0 && ev <= 0) return Math.max(eu, ev);
  const pu = Math.max(0, eu);
  const pv = Math.max(0, ev);
  return Math.sqrt(pu * pu + pv * pv);
}

/** Do two placed boxes overlap? A separating axis over four; both are rectangles. */
export function boxesOverlap(a: PlacedBox, b: PlacedBox, slack = 0): boolean {
  const axes = [
    { x: a.ax, z: a.az },
    { x: -a.az, z: a.ax },
    { x: b.ax, z: b.az },
    { x: -b.az, z: b.ax },
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const axis of axes) {
    const t = Math.abs(dx * axis.x + dz * axis.z);
    const ra =
      Math.abs(a.hx * (a.ax * axis.x + a.az * axis.z)) +
      Math.abs(a.hz * (-a.az * axis.x + a.ax * axis.z));
    const rb =
      Math.abs(b.hx * (b.ax * axis.x + b.az * axis.z)) +
      Math.abs(b.hz * (-b.az * axis.x + b.ax * axis.z));
    if (t > ra + rb + slack) return false;
  }
  return true;
}

/** The four corners of a box, world metres, for a containment test. */
export function cornersOf(b: PlacedBox, out: number[] = []): number[] {
  out.length = 0;
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const u = su * b.hx;
      const v = sv * b.hz;
      out.push(b.x + u * b.ax - v * b.az, b.z + u * b.az + v * b.ax);
    }
  }
  return out;
}

/**
 * How far apart two placements have to be to count as different, metres.
 *
 * Used to find the one a player is pointing at, and to stop a double-click
 * putting two couches in the same spot when the first has not come back off the
 * wire yet.
 */
export const SAME_SPOT_M = 0.35;

/**
 * How far from the aim a thing can be and still be the one taken away, metres.
 *
 * Generous, because the aim is a point on the floor and a couch is a box: a
 * player pointing at the middle of a cushion is a metre from its edge. It was
 * `SAME_SPOT_M + 1.2` inline, which is a named constant hiding a magic one.
 */
export const REMOVE_REACH_M = 1.55;

/** Self-check. On both boot lists: it is arithmetic and imports nothing. */
export function verifyPlaceables(): string[] {
  const failures: string[] = [];
  const couch = (x: number, z: number, turn: number): Placement => ({ kind: PLACEABLE.COUCH, x, z, turn });

  // --- The catalogue is a table and the wire's bound matches it.
  {
    if (PLACEABLES.length !== PLACEABLE_KINDS) {
      failures.push(`${PLACEABLES.length} kinds in the table against a wire bound of ${PLACEABLE_KINDS}.`);
    }
    if (!knownKind(PLACEABLE.COUCH)) failures.push('the couch is not a known kind.');
    for (const bad of [-1, PLACEABLE_KINDS, 1.5, NaN, Infinity]) {
      if (knownKind(bad)) failures.push(`kind ${bad} was accepted.`);
    }
    for (const k of PLACEABLES) {
      if (!(k.hx > 0 && k.hz > 0 && k.height > 0)) failures.push(`"${k.name}" has no size.`);
      if (Math.max(k.hx, k.hz) < BODY_RADIUS_M) {
        failures.push(`"${k.name}" is smaller than the body that has to walk round it.`);
      }
    }
  }

  // --- Nothing off the wire is trusted.
  {
    if (sanitisePlacement(null) !== null) failures.push('null decoded as a placement.');
    if (sanitisePlacement({ kind: 0, x: NaN, z: 0, turn: 0 }) !== null) failures.push('a NaN placement was accepted.');
    if (sanitisePlacement({ kind: 9, x: 0, z: 0, turn: 0 }) !== null) failures.push('an unknown kind was accepted.');
    if (sanitisePlacement({ kind: 0, x: 0, z: 0, turn: 4 }) !== null) failures.push('a fifth quarter turn was accepted.');
    if (sanitisePlacement({ kind: 0, x: 0, z: 0, turn: -1 }) !== null) failures.push('a negative turn was accepted.');
    if (sanitisePlacement({ kind: 0, x: 1e9, z: 0, turn: 0 }) !== null) failures.push('a couch past the end of the world was accepted.');
    const ok = sanitisePlacement({ kind: 0, x: -2236.5, z: 4543.25, turn: 3 });
    if (ok === null || ok.turn !== 3 || ok.x !== -2236.5) failures.push('a good placement was refused.');
  }

  // --- Quarter turns come back round, and they are exact.
  //
  // Four turns of any axis must be **bit-identical** to where it started, or
  // two ends drift a couch a fraction of a millimetre per rotation and a player
  // ends up walking through the corner of one.
  {
    for (const [ux, uz] of [[1, 0], [0, 1], [0.6, 0.8], [-0.28734788556634544, 0.9578262852211514]]) {
      let a = { ax: ux, az: uz };
      for (let i = 0; i < 4; i++) a = axisOf(a.ax, a.az, 1);
      if (a.ax !== ux || a.az !== uz) failures.push(`four quarter turns of (${ux}, ${uz}) landed on (${a.ax}, ${a.az}).`);
      const one = axisOf(ux, uz, 1);
      if (Math.abs(one.ax * ux + one.az * uz) > 1e-12) failures.push('a quarter turn is not a right angle.');
      const two = axisOf(ux, uz, 2);
      if (Math.abs(two.ax + ux) > 1e-12 || Math.abs(two.az + uz) > 1e-12) failures.push('half a turn is not the opposite.');
    }
  }

  // --- A body is pushed out of a couch, from every direction, at every turn.
  //
  // A null move that starts clear must stay clear; a body driven into the
  // middle of one must come out **the way it went in** and be settled in a
  // single pass. A push that chose the wrong face would eject somebody through
  // the back of a couch and, against a wall, through the wall.
  {
    for (let turn = 0; turn < 4; turn++) {
      const box = boxOf(couch(10, 20, turn), 0.6, 0.8);
      for (let i = 0; i < 16; i++) {
        const q = i / 16;
        const dx = q < 0.5 ? 1 - q * 4 : q * 4 - 3;
        const dz = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
        const len = Math.sqrt((dx) * (dx) + (dz) * (dz)) || 1;
        const far = pushOutOfBox(box, 10 + (dx / len) * 6, 20 + (dz / len) * 6, BODY_RADIUS_M);
        if (far.hit) failures.push(`a body six metres from a couch was pushed (turn ${turn}).`);
        const into = pushOutOfBox(box, 10 + (dx / len) * 0.05, 20 + (dz / len) * 0.05, BODY_RADIUS_M);
        if (!into.hit) failures.push(`a body standing in a couch was not pushed out (turn ${turn}).`);
        const after = pushOutOfBox(box, into.x, into.z, BODY_RADIUS_M);
        if (Math.sqrt((after.x - into.x) * (after.x - into.x) + (after.z - into.z) * (after.z - into.z)) > 1e-6) {
          failures.push(`the push out of a couch did not settle in one pass (turn ${turn}).`);
        }
        if (boxClearance(box, into.x, into.z) < BODY_RADIUS_M - 1e-6) {
          failures.push(`a body pushed out of a couch is still inside its radius (turn ${turn}).`);
        }
      }
    }
  }

  // --- Two couches cannot stand in each other.
  {
    const a = boxOf(couch(0, 0, 0), 1, 0);
    if (!boxesOverlap(a, boxOf(couch(0.5, 0, 0), 1, 0))) failures.push('two couches half a metre apart did not overlap.');
    if (!boxesOverlap(a, boxOf(couch(0, 0, 1), 1, 0))) failures.push('a couch turned across another one did not overlap it.');
    if (boxesOverlap(a, boxOf(couch(4, 0, 0), 1, 0))) failures.push('two couches four metres apart overlapped.');
    // End to end, just clear: the tightest case the separating axis has to get
    // right, and the one a slack of zero must not reject.
    if (boxesOverlap(a, boxOf(couch(1.95, 0, 0), 1, 0))) failures.push('two couches standing end to end were called overlapping.');
  }

  // --- The corners are the corners.
  {
    const b = boxOf(couch(0, 0, 0), 1, 0);
    const c = cornersOf(b);
    if (c.length !== 8) failures.push(`a box has ${c.length / 2} corners.`);
    for (let i = 0; i < c.length; i += 2) {
      if (Math.abs(Math.abs(c[i]) - b.hx) > 1e-9 || Math.abs(Math.abs(c[i + 1]) - b.hz) > 1e-9) {
        failures.push('a corner is not at a half-extent.');
        break;
      }
    }
  }

  return failures;
}
