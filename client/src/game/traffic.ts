/**
 * Living traffic: cars that drive the streets, and what one does to you.
 *
 * The user asked to "make the cars drive around and knock u over". `cars.ts` had
 * 23,020 of them parked at the kerb; this is the half that moves, and the half
 * that hurts.
 *
 * ---------------------------------------------------------------------------
 * A CAR IS A LOOKUP, NOT A SIMULATION. THIS IS THE WHOLE DESIGN.
 *
 * Nothing here is stepped. There is no velocity, no integration and no state
 * that survives a frame. A car's position is a pure function:
 *
 *     position(tick) = the point on route R at time (tick/60 - departure)
 *
 * and every term of it was baked by `pipeline/sydney/lanes.py` into the
 * `.lanes.bin` the client already streams and the server already reads at boot.
 * Two consequences, and both of them are the feature:
 *
 *   1. **Zero bandwidth.** Sixteen players watch the same six thousand cars and
 *      `net/protocol.ts` gained not one byte. A simulated fleet would either be
 *      on the wire -- more traffic than the whole player protocol -- or private
 *      to each client, in which case no two players see the same street.
 *   2. **The knockdown is predictable and authoritative at the same time.** The
 *      server evaluates the hit at tick T and applies the damage; the client
 *      evaluates the *identical function* at the same T and applies the same
 *      shove on the frame it happens, so the shove is not waiting on a round
 *      trip. There is no handoff because there is nothing to hand off.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BAKED QUANTITY IS **TIME** AND NOT DISTANCE.
 *
 * The obvious sidecar is a polyline with arc lengths and a speed profile, which
 * makes `position(t)` an integral. Instead each route vertex carries the
 * cumulative *seconds* to reach it, with the class speed limit, the corner
 * slowdowns and the wait at every red light already folded in. So the lookup is
 * a binary search and a lerp:
 *
 *     find i with t[i] <= age < t[i+1];  u = (age - t[i]) / (t[i+1] - t[i])
 *
 * That is subtract, divide, multiply, add -- and **nothing else**, which is a
 * determinism argument before it is a performance one. `game/footy.ts`'s header
 * states the rule this obeys: `Math.sin`, `Math.cos`, `Math.pow` and `Math.hypot`
 * are implementation-defined in ECMAScript and the browser's V8 and Bun's
 * JavaScriptCore differ in the last place. `Math.sqrt` is specified to IEEE-754
 * exactness and is the only root here, used once per pose to normalise a
 * heading. `server/integration-check.ts`'s `checkTraffic` asserts the whole of
 * this bit for bit over ten thousand ticks.
 *
 * A red light is not a state machine either. It is two copies of the same vertex
 * with four seconds between their timestamps, so the lerp between them is a
 * stationary car, for free.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS UNIX TIME, AND THAT IS A DECISION.
 *
 * The natural clock is the server's simulation tick -- it is what every other
 * deterministic thing in this project is a function of. It is not used here for
 * two reasons. It is private to `net/client.ts` on the browser side and exposing
 * it means a protocol field, which is exactly what this feature exists to avoid;
 * and it restarts at zero when the server process does, which would teleport
 * every car in Sydney on a deploy.
 *
 * `Date.now()` has neither problem and both ends already have it. What it costs
 * is clock skew: two NTP-disciplined machines differ by tens of milliseconds,
 * which at 14 m/s is tens of centimetres of car. The failure is graceful in the
 * direction that matters -- the server decides whether a car hit you and the
 * client only predicts it, so a skewed clock costs a misprediction that
 * `net/client.ts`'s existing correction absorbs exactly as it absorbs any other.
 *
 * ---------------------------------------------------------------------------
 * CARS DO NOT COLLIDE WITH ANYTHING. THEY PLOUGH THROUGH.
 *
 * Not with each other, not with the player, not with a building. That is the
 * point rather than a shortcut: the thing the user asked for is *being knocked
 * over*, and a car that braked for you would never do it. Conceptually these are
 * trams on rails.
 *
 * Two cars never occupy the same place anyway, and it is the *pipeline* that
 * guarantees it rather than anything here: routes are an edge-disjoint
 * decomposition of the lane graph, so no two share a lane, and within one route
 * the departure headway is strictly greater than the longest red on it, which is
 * the condition for two cars on one timetable never to meet. See `lanes.py`.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing from three.** `game/footy.ts` set that precedent
 * and states it in the same words: the Bun server compiles this module, and a
 * `Vector3` reaching it would drag the whole renderer into a process that draws
 * nothing. It imports numbers and functions from `game/combat.ts` exactly as
 * `footy.ts` does, and like `footy.ts` it mutates a victim through `.set()`
 * rather than allocating anything.
 */

import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  FLINCH_LOCKOUT,
  HITSTOP,
  KO_SECONDS,
  createCombatant,
  feetY,
  isTargetable,
  type CombatantState,
} from './combat.ts';
import { EYE_HEIGHT } from '../player/controller.ts';

// --- The sidecar contract ------------------------------------------------------

/** ASCII 'LANE' little-endian. Must match `tiles.LANES_MAGIC`. */
export const LANES_MAGIC = 0x454e414c;
export const LANES_VERSION = 1;

/**
 * The class byte in `.lanes.bin`, in the pipeline's own order.
 *
 * **Append only.** An index in a file already on disk must keep meaning what it
 * meant, which is `mesh.MATERIALS`' rule and is here for the same reason: the
 * world is cached for a year and a reordered table renames every street in it.
 * Must match `lanes.LANE_CLASSES`.
 */
export const LANE_CLASSES = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'unclassified', 'living_street', 'service',
  'other',
] as const;

/** Ticks per second the baked timetable is denominated in. */
export const TRAFFIC_HZ = 60;

/**
 * 2026-01-01T00:00:00Z. Tick zero.
 *
 * Near the build rather than 1970 so the tick stays inside 2^31 for over a year,
 * which keeps every integer hash derived from it in exact `Math.imul` range.
 * Both numbers also travel in `index.json`'s `lanes` block; they are repeated
 * here because the *decoder* needs them before it has read anything, and
 * `verifyTraffic` is handed the index's copy to check the two agree.
 */
export const TRAFFIC_EPOCH_MS = 1767225600000;

/**
 * The shared clock, in ticks. See the header for why this is wall time.
 *
 * `Math.floor` of a double multiply: both are exactly specified, so two
 * processes handed the same millisecond produce the same integer.
 */
export function trafficTick(nowMs: number): number {
  return Math.floor((nowMs - TRAFFIC_EPOCH_MS) * (TRAFFIC_HZ / 1000));
}

/** Ticks to seconds. One divide, so the two ends cannot round differently. */
export function trafficSeconds(tick: number): number {
  return tick / TRAFFIC_HZ;
}

// --- What a car is -------------------------------------------------------------

/**
 * Body dimensions, metres, indexed by `cars.BODY_SPEC`'s own body ids.
 *
 * These are the numbers the *hit box* is built from, and `cars.ts` draws the
 * same five bodies at the same sizes. It is not shared by import because that
 * import runs the wrong way -- `cars.ts` pulls in three -- so `verifyTraffic`
 * takes the render table as an argument and asserts the two agree. A car that
 * knocks you over from a metre away, or drives through you, is exactly the kind
 * of failure that renders perfectly.
 */
export const CAR_BODY_SIZE: ReadonlyArray<{ length: number; width: number; height: number }> = [
  { length: 4.6, width: 1.8, height: 1.45 },  // sedan
  { length: 4.2, width: 1.75, height: 1.5 },  // hatch
  { length: 4.7, width: 1.9, height: 1.7 },   // SUV
  { length: 5.2, width: 1.85, height: 1.8 },  // ute
  { length: 5.4, width: 1.9, height: 2.0 },   // van
];

/**
 * How the fleet is mixed, as a cumulative table over `CAR_BODY_SIZE`.
 *
 * SUVs and utes are over-represented against a global car park and under it
 * against an Australian one -- 35% of new sales here are an SUV and the ute is
 * the country's best-selling vehicle -- and the van is deliberately rare because
 * it is the one body that reads as a *delivery* rather than as traffic.
 */
const BODY_MIX = [0.3, 0.55, 0.8, 0.94, 1.0];

/** Paint index count. Must match `cars.PAINT`'s length. */
export const CAR_PAINT_COUNT = 8;

/**
 * Paint mix, cumulative. The same distribution `parking.py` uses for the kerb --
 * white 30, silver 15, grey 10, black 15, blue 10, red 8, green 5, beige 7 --
 * because a street where the parked cars and the moving ones came from different
 * palettes reads as two different games.
 */
const PAINT_MIX = [0.3, 0.45, 0.55, 0.7, 0.8, 0.88, 0.93, 1.0];

// --- The knockdown -------------------------------------------------------------

/**
 * What a car does to you, m/s.
 *
 * Just under `combat.KNOCKBACK_HORIZONTAL` (11.0) on purpose, and higher in the
 * vertical than a punch's 5.5. The bat is still the weapon: a car should throw
 * you *further off your feet* than a punch and not further down the street, or
 * standing in traffic becomes a better way to cross Pitt Street than running.
 * The extra lift is what makes it read as being hit by a car rather than as
 * being shoved by one -- you go over the bonnet.
 */
export const CAR_KNOCKBACK_HORIZONTAL = 10.5;
export const CAR_KNOCKBACK_VERTICAL = 7.0;

/** One pip, the bat's damage exactly. A car is not a better weapon than a friend. */
export const CAR_DAMAGE = 1;

/**
 * How long being run down takes control away, seconds.
 *
 * Longer than `combat.FLINCH_LOCKOUT`'s 0.3, because 0.3 s is a punch and this
 * is a Hilux. It is spent **through the existing flinch phase** rather than
 * through a new field: `applyCarHit` starts the phase at a negative `phaseT`, so
 * `combat.advance`'s own `phaseT >= FLINCH_LOCKOUT` test ends it this many
 * seconds later and every consumer of `phase` -- the movement lock, the
 * animation, the snapshot byte -- keeps working with no change at all. Inventing
 * a second lockout channel would have meant a protocol field for a thing the
 * protocol already carries.
 */
export const CAR_STAGGER = 0.85;

/** Half the plan slack a hit box gets over the body's own footprint, metres. */
const HIT_MARGIN = 0.1;

// --- Decoded shapes ------------------------------------------------------------

/**
 * One drivable way, in world metres. **Nothing in this file reads it.**
 *
 * It is decoded and held because it is the reusable half of the sidecar: the
 * street network as geometry, with the two widths that let a consumer derive
 * anything that runs beside it -- a footpath is
 * `centreline +/- (halfWidth + kerb + footpathWidth/2)`. See
 * `tiles.write_lanes`, which is where that contract is written down.
 */
export interface LaneWay {
  osmId: number;
  klass: number;
  oneway: boolean;
  /** Centreline to kerb, metres. */
  halfWidth: number;
  /** The paved band beyond the kerb, metres. Zero on a motorway. */
  footpathWidth: number;
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}

/** One car route: a lane-offset polyline and the timetable along it. */
export interface LaneRoute {
  /** Stable across builds. The hash seed for every car that ever drives it. */
  rid: number;
  klass: number;
  /** Seconds between departures. */
  headway: number;
  /** Seconds, this route's own offset into the headway. */
  phase: number;
  /** Seconds for one traversal -- `t[count - 1]`. */
  duration: number;
  count: number;
  /** World metres. `y` is absolute and is already on the running surface. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Cumulative seconds from the route's start. Strictly increasing. */
  t: Float32Array;
  /** Plan bounds, for the broadphase. Derived at decode. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TileLanes {
  ways: LaneWay[];
  routes: LaneRoute[];
}

/** Where one car is, and what it looks like. Reused; never allocated per frame. */
export interface CarPose {
  route: number;
  /** Which departure this is. Grows forever; used only as a hash input. */
  slot: number;
  x: number;
  y: number;
  z: number;
  /** Unit heading in the world plan. */
  dx: number;
  dz: number;
  body: number;
  colour: number;
  scale: number;
  /** Half the hit box, already scaled. */
  halfLength: number;
  halfWidth: number;
  height: number;
}

export function createCarPose(): CarPose {
  return {
    route: 0, slot: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    body: 0, colour: 0, scale: 1, halfLength: 0, halfWidth: 0, height: 0,
  };
}

// --- Decoding ------------------------------------------------------------------

/**
 * Decode a `.lanes.bin` into world coordinates.
 *
 * `originX`/`originZ` are the tile group's world translation --
 * `(bounds[0], bounds[1] + tile_size)`, the same pair `server/world.ts` and
 * `streamer.ts` already compute for the collision prisms. Applied **here**, once
 * at load, rather than at every evaluation: a car crosses tiles constantly and
 * there is no tile group to inherit a translation from, because the moving
 * fleet is one instanced set for the whole visible world rather than one per
 * tile.
 *
 * Returns `null` for anything that is not a lane sidecar, so a tile with no
 * drivable street is indistinguishable from a tile whose file is missing -- the
 * contract every other decoder in this project has.
 */
export function decodeLanes(
  buffer: ArrayBuffer,
  originX: number,
  originZ: number,
): TileLanes | null {
  if (buffer.byteLength < 16) return null;
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== LANES_MAGIC) return null;
  if (v.getUint32(4, true) !== LANES_VERSION) return null;
  const wayCount = v.getUint32(8, true);
  const routeCount = v.getUint32(12, true);

  const ways: LaneWay[] = [];
  const routes: LaneRoute[] = [];
  let o = 16;
  for (let w = 0; w < wayCount; w++) {
    if (o + 16 > buffer.byteLength) return null;
    const osmId = v.getUint32(o, true);
    const klass = v.getUint8(o + 4);
    const flags = v.getUint8(o + 5);
    const n = v.getUint16(o + 6, true);
    const halfWidth = v.getFloat32(o + 8, true);
    const footpathWidth = v.getFloat32(o + 12, true);
    o += 16;
    if (n < 2 || o + n * 12 > buffer.byteLength) return null;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = v.getFloat32(o, true) + originX;
      y[i] = v.getFloat32(o + 4, true);
      z[i] = v.getFloat32(o + 8, true) + originZ;
      o += 12;
    }
    ways.push({ osmId, klass, oneway: (flags & 1) !== 0, halfWidth, footpathWidth, count: n, x, y, z });
  }

  for (let r = 0; r < routeCount; r++) {
    if (o + 16 > buffer.byteLength) return null;
    const rid = v.getUint32(o, true);
    const klass = v.getUint8(o + 4);
    const n = v.getUint16(o + 6, true);
    const headway = v.getFloat32(o + 8, true);
    const phase = v.getFloat32(o + 12, true);
    o += 16;
    if (n < 2 || o + n * 16 > buffer.byteLength) return null;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    const t = new Float32Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = v.getFloat32(o, true) + originX;
      const pz = v.getFloat32(o + 8, true) + originZ;
      x[i] = px;
      y[i] = v.getFloat32(o + 4, true);
      z[i] = pz;
      t[i] = v.getFloat32(o + 12, true);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
      o += 16;
    }
    // A route with a broken timetable would divide by zero in `poseCar`, and a
    // headway of zero would make the live-car count infinite. Both are dropped
    // rather than clamped: a car in the wrong place is a bug you can see, and a
    // hang is not.
    if (!(headway > 0) || !(t[n - 1] > 0)) continue;
    routes.push({
      rid, klass, headway, phase, duration: t[n - 1], count: n, x, y, z, t, minX, maxX, minZ, maxZ,
    });
  }
  return { ways, routes };
}

// --- The resident world --------------------------------------------------------

/** Broadphase cell, metres. See `TrafficField`. */
const CELL = 256;

/**
 * Every lane sidecar currently loaded, indexed for "what is near this player".
 *
 * Adopt/drop by tile key, exactly as `game/powerups.ts`'s `PowerupField` is --
 * the client's streamer calls both as a tile arrives and leaves, and the server
 * adopts every tile once at boot and never drops one. The flat route array and
 * the bucket grid are rebuilt only when the resident set changes, which on the
 * server is never after boot and on the client is a handful of times a minute.
 *
 * The grid exists because the alternative is measurable: the server tests every
 * combatant against every car in Sydney every tick, and at 6,200 cars and 16
 * players that is 100,000 evaluations at 60 Hz. Bucketed, a player sees the
 * routes whose plan bounds overlap their own 3x3 cells -- a few dozen.
 */
export class TrafficField {
  private readonly tiles = new Map<string, TileLanes>();
  private flat: LaneRoute[] = [];
  private grid = new Map<number, LaneRoute[]>();
  private dirty = true;

  adopt(tileKey: string, tile: TileLanes): void {
    this.tiles.set(tileKey, tile);
    this.dirty = true;
  }

  drop(tileKey: string): void {
    if (this.tiles.delete(tileKey)) this.dirty = true;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Every route in a resident tile. Rebuilt on demand; do not hold across a drop. */
  routes(): readonly LaneRoute[] {
    this.rebuild();
    return this.flat;
  }

  /** Every way in a resident tile -- the geometry block. Nothing here reads it. */
  ways(): LaneWay[] {
    const out: LaneWay[] = [];
    for (const tile of this.tiles.values()) out.push(...tile.ways);
    return out;
  }

  /** How many cars are live across the resident set at this tick. Diagnostics only. */
  liveCars(tick: number): number {
    const now = trafficSeconds(tick);
    let n = 0;
    for (const r of this.routes()) n += liveSlots(r, now, SLOT_RANGE);
    return n;
  }

  /**
   * Routes whose plan bounds reach within `radius` of a point.
   *
   * Appends into `out` and returns it, so a caller in a 60 Hz loop allocates
   * nothing. The bounds test is deliberately loose -- a route's box is up to
   * 800 m on a side and a diagonal one claims ground it never touches -- because
   * the cost of a false positive is one `poseCar` and the cost of a false
   * negative is a car that goes through you without knocking you over.
   */
  near(x: number, z: number, radius: number, out: LaneRoute[]): LaneRoute[] {
    this.rebuild();
    out.length = 0;
    const c0 = Math.floor((x - radius) / CELL);
    const c1 = Math.floor((x + radius) / CELL);
    const r0 = Math.floor((z - radius) / CELL);
    const r1 = Math.floor((z + radius) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const bucket = this.grid.get(cellKey(cx, cz));
        if (bucket === undefined) continue;
        for (const route of bucket) {
          if (
            route.maxX < x - radius || route.minX > x + radius ||
            route.maxZ < z - radius || route.minZ > z + radius
          ) continue;
          // A route spans several cells, so the same one arrives from more than
          // one bucket. Deduped by scanning `out`, which is a handful of entries
          // -- a Set here would allocate every frame for a list this short.
          if (out.indexOf(route) < 0) out.push(route);
        }
      }
    }
    return out;
  }

  private rebuild(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.flat = [];
    this.grid = new Map();
    for (const tile of this.tiles.values()) {
      for (const route of tile.routes) {
        this.flat.push(route);
        const c0 = Math.floor(route.minX / CELL);
        const c1 = Math.floor(route.maxX / CELL);
        const r0 = Math.floor(route.minZ / CELL);
        const r1 = Math.floor(route.maxZ / CELL);
        for (let cx = c0; cx <= c1; cx++) {
          for (let cz = r0; cz <= r1; cz++) {
            const key = cellKey(cx, cz);
            const bucket = this.grid.get(key);
            if (bucket === undefined) this.grid.set(key, [route]);
            else bucket.push(route);
          }
        }
      }
    }
  }
}

/** Two signed cell indices in one integer key. +/-16,384 cells is +/-4,194 km. */
function cellKey(cx: number, cz: number): number {
  return ((cx + 0x4000) << 15) | ((cz + 0x4000) & 0x7fff);
}

// --- Evaluating a car ----------------------------------------------------------

/**
 * The integer hash every per-car choice comes out of.
 *
 * `Math.imul`, xor and unsigned shift, which are exact 32-bit integer operations
 * on every engine -- `game/footy.ts`'s `bounceHash` makes the same argument and
 * this is deliberately the same shape. A float PRNG would need state, and state
 * is the thing this whole module does not have.
 */
export function carHash(a: number, b: number): number {
  let h = 0x811c9dc5;
  h ^= Math.imul(a | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= Math.imul(b | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

function unit(h: number): number {
  return h / 4294967296;
}

/** Scratch for `liveSlots`, so the range query allocates nothing. */
interface SlotRange { first: number; last: number }
const SLOT_RANGE: SlotRange = { first: 0, last: -1 };

/**
 * Which departures of a route are on the road right now.
 *
 * Slot `k` departs at `phase + k * headway` and is live for `duration` seconds
 * after that. Both bounds are floors of a division, which is exact arithmetic --
 * so the client and the server agree on the *set* of cars as well as on where
 * each one is. Returns the count and fills `range`.
 */
function liveSlots(route: LaneRoute, now: number, range: SlotRange): number {
  const since = now - route.phase;
  const last = Math.floor(since / route.headway);
  const first = Math.floor((since - route.duration) / route.headway) + 1;
  range.first = first;
  range.last = last;
  return last >= first ? last - first + 1 : 0;
}

/**
 * Where car `slot` of `route` is at `now` seconds, and what it looks like.
 *
 * Returns false when that slot is not on the road, which is how the caller
 * iterates: ask for the live range, then pose each one.
 *
 * The binary search is over `t`, which the pipeline guarantees is strictly
 * increasing -- see `lanes._dedupe` for the f32 argument behind that guarantee,
 * because a repeated timestamp here is a divide by zero.
 */
export function poseCar(route: LaneRoute, slot: number, now: number, out: CarPose): boolean {
  const age = now - route.phase - slot * route.headway;
  if (age < 0 || age >= route.duration) return false;

  const t = route.t;
  let lo = 0;
  let hi = route.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= age) lo = mid;
    else hi = mid;
  }
  const span = t[lo + 1] - t[lo];
  const u = span > 0 ? (age - t[lo]) / span : 0;

  const x0 = route.x[lo];
  const z0 = route.z[lo];
  const x1 = route.x[lo + 1];
  const z1 = route.z[lo + 1];
  out.route = route.rid;
  out.slot = slot;
  out.x = x0 + u * (x1 - x0);
  out.y = route.y[lo] + u * (route.y[lo + 1] - route.y[lo]);
  out.z = z0 + u * (z1 - z0);

  // The heading. A red light is two copies of one vertex, so the segment the car
  // is sitting on has no direction at all -- walk out to the nearest one that
  // does, forward first and then back, which is the direction the car is about
  // to travel in and the one it arrived on. Never `Math.hypot`, which is
  // implementation-defined; `Math.sqrt` is exact.
  let hx = x1 - x0;
  let hz = z1 - z0;
  let d2 = hx * hx + hz * hz;
  for (let step = lo + 1; d2 < 1e-12 && step < route.count - 1; step++) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  for (let step = lo - 1; d2 < 1e-12 && step >= 0; step--) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  if (d2 < 1e-12) {
    out.dx = 0;
    out.dz = 1;
  } else {
    const inv = 1 / Math.sqrt(d2);
    out.dx = hx * inv;
    out.dz = hz * inv;
  }

  // Identity. A pure function of (route, slot), so every process that evaluates
  // this car agrees about what it is without a byte on the wire.
  const h = carHash(route.rid, slot);
  const pick = unit(h);
  let body = BODY_MIX.length - 1;
  for (let i = 0; i < BODY_MIX.length; i++) {
    if (pick < BODY_MIX[i]) { body = i; break; }
  }
  const paint = unit(carHash(h, 0x9e37));
  let colour = PAINT_MIX.length - 1;
  for (let i = 0; i < PAINT_MIX.length; i++) {
    if (paint < PAINT_MIX[i]) { colour = i; break; }
  }
  const scale = 0.96 + 0.08 * unit(carHash(h, 0x2545));
  const size = CAR_BODY_SIZE[body];
  out.body = body;
  out.colour = colour;
  out.scale = scale;
  out.halfLength = size.length * 0.5 * scale + HIT_MARGIN;
  out.halfWidth = size.width * 0.5 * scale + HIT_MARGIN;
  out.height = size.height * scale;
  return true;
}

/**
 * Every live car within `radius` of a point, at `tick`.
 *
 * The one iteration order in this module, and it is fixed rather than incidental
 * -- `near` returns routes in bucket order and slots ascend within a route -- so
 * two processes walking the same resident set visit the same cars in the same
 * order. That matters for the hit test, where the *first* car found wins.
 */
export function forEachCarNear(
  field: TrafficField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
  visit: (pose: CarPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const range: SlotRange = { first: 0, last: -1 };
  for (const route of field.near(x, z, radius, scratch)) {
    liveSlots(route, now, range);
    for (let slot = range.first; slot <= range.last; slot++) {
      if (!poseCar(route, slot, now, pose)) continue;
      const dx = pose.x - x;
      const dz = pose.z - z;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (visit(pose) === true) return;
    }
  }
}

// --- Being run over ------------------------------------------------------------

/**
 * How far from a player a car has to be to be worth testing, metres.
 *
 * The longest car is 5.4 m and the widest hit box half-diagonal is under 3 m, so
 * anything past this cannot reach the capsule. Kept as one number rather than
 * derived per body because it is the *broadphase* radius and a broadphase that
 * changes size per candidate is not a broadphase.
 */
const HIT_QUERY_RADIUS = 6;

/**
 * Is this car on top of this combatant?
 *
 * The car is an oriented box and the player is their collision capsule, tested
 * as a box in plan -- generous by a few centimetres at the corners, which is the
 * direction this error has to fall. A car that visibly passes through somebody
 * without touching them is the version of this mistake players notice, and it is
 * the same call `combat.REACH` makes about the bat.
 *
 * The vertical test is what stops a car on the Cahill Expressway knocking over
 * somebody standing on Alfred Street underneath it -- the two are eight metres
 * apart and directly above one another, and without this the whole viaduct is a
 * moving hazard on the street below.
 */
export function carOverlaps(pose: CarPose, c: CombatantState): boolean {
  const feet = feetY(c);
  if (feet > pose.y + pose.height) return false;
  if (feet + CAPSULE_HEIGHT < pose.y) return false;
  const rx = c.body.position.x - pose.x;
  const rz = c.body.position.z - pose.z;
  const along = rx * pose.dx + rz * pose.dz;
  if (along > pose.halfLength + CAPSULE_RADIUS || along < -pose.halfLength - CAPSULE_RADIUS) {
    return false;
  }
  // The left component, in the same axes `lanes.py` offsets a lane along:
  // left of a heading (dx, dz) is (dz, -dx).
  const across = rx * pose.dz - rz * pose.dx;
  return across <= pose.halfWidth + CAPSULE_RADIUS && across >= -pose.halfWidth - CAPSULE_RADIUS;
}

/**
 * Can this combatant be run down right now?
 *
 * A knocked-out body cannot -- `isTargetable` says so and a ragdoll being
 * re-launched every tick it lies in the road is a bug, not a joke. Neither can
 * somebody already in a flinch, and that clause is doing real work: it is the
 * *re-hit guard*, and it needs no new state because a victim thrown by a car is
 * in the flinch this module put them in for the next 0.85 s, by which time the
 * car is thirty metres up the street.
 */
export function canBeRunDown(c: CombatantState): boolean {
  return isTargetable(c) && c.phase !== 'flinch';
}

/**
 * The car hitting this combatant at `tick`, or null.
 *
 * Pure: it decides nothing and applies nothing. The caller -- `server/sim.ts`
 * authoritatively, `main.ts` predictively -- is what turns it into damage, and
 * both evaluate this same function at the same tick, which is the whole of why
 * they agree.
 */
export function carHitting(
  field: TrafficField,
  c: CombatantState,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
): CarPose | null {
  if (!canBeRunDown(c)) return null;
  let hit = false;
  forEachCarNear(
    field,
    c.body.position.x,
    c.body.position.z,
    HIT_QUERY_RADIUS,
    tick,
    scratch,
    pose,
    (p) => {
      if (!carOverlaps(p, c)) return;
      hit = true;
      return true;
    },
  );
  return hit ? pose : null;
}

/**
 * One pip, one flight over the bonnet, and 0.85 s of not being in charge.
 *
 * The impulse is **set, not added**, which is `combat.applyHit`'s rule and is
 * here for the same reason: a sprinting victim clipped from behind would
 * otherwise arrive carrying their own 8 m/s and be thrown twenty metres. Setting
 * it makes every car throw you the same distance, which is what makes the
 * distance a thing a player learns.
 *
 * The direction is the car's heading, flattened, with no component toward the
 * player at all -- you go where the car was going. That is both what happens and
 * the comic read.
 *
 * Returns true if the hit was a knockout.
 */
export function applyCarHit(victim: CombatantState, pose: CarPose): boolean {
  victim.health = Math.max(0, victim.health - CAR_DAMAGE);
  // `combat.applyHit`'s femto-pip clamp, and it matters here for the same
  // reason: sums like 3 - 1.4 - 1 miss zero by a few times 1e-16.
  if (victim.health < 1e-9) victim.health = 0;
  victim.body.velocity.set(
    pose.dx * CAR_KNOCKBACK_HORIZONTAL,
    CAR_KNOCKBACK_VERTICAL,
    pose.dz * CAR_KNOCKBACK_HORIZONTAL,
  );
  // The line `combat.applyHit`'s header calls load-bearing: without it the first
  // tick after the hit charges the victim ground friction for a metre of flight
  // they spend in the air.
  victim.body.onGround = false;
  // And off the lime e-bike, exactly as `combat.applyHit` and
  // `footy.applyFootyHit` do it. This is the third of three parallel damage
  // paths in this codebase and the one where it is least avoidable: a cyclist
  // hit by a car is the canonical way to come off a bike. Clearing the field is
  // the whole of it -- `game/bikes.BikeField.follow` sweeps after every tick and
  // parks any bike whose rider has stopped riding, so nothing here needs to know
  // that class exists.
  victim.ridingBike = 0;

  const ko = victim.health <= 0;
  if (ko) {
    victim.phase = 'ko';
    victim.koT = 0;
    victim.respawnT = KO_SECONDS;
  } else {
    victim.phase = 'flinch';
    // The extended lockout, spent through the existing phase. See `CAR_STAGGER`.
    victim.phaseT = FLINCH_LOCKOUT - CAR_STAGGER;
  }
  // On the victim only. There is no attacker to freeze.
  victim.hitstopT = HITSTOP;
  return ko;
}

// --- Self-check ----------------------------------------------------------------

/**
 * Everything about this module that fails by rendering a plausible city.
 *
 * There is no picture for any of it. A schedule that is not deterministic puts
 * one player's cars somewhere else and tells them they were hit by nothing. A
 * left-hand rule with the sign flipped is a Sydney driving on the right, which
 * is invisible to every automated check that only asks whether cars are on
 * roads. A hit box that disagrees with the drawn body knocks you over from a
 * metre away. A clock that disagrees with the index's is a fleet an hour out of
 * step with the server's. None of them throws.
 *
 * `renderSizes` is `cars.ts`'s body table, passed in rather than imported
 * because the import would drag three into the Bun server -- see
 * `CAR_BODY_SIZE`. `contract` is `index.json`'s `lanes` block. Both are
 * optional so the server can run this before it has opened a file.
 */
export function verifyTraffic(
  renderSizes?: ReadonlyArray<{ length: number; width: number; height: number }>,
  contract?: { hz?: number; epoch_ms?: number; version?: number } | null,
): string[] {
  const failures: string[] = [];

  // --- The drawn car and the car that hits you are the same car.
  if (renderSizes) {
    if (renderSizes.length !== CAR_BODY_SIZE.length) {
      failures.push(
        `The renderer has ${renderSizes.length} body types and the hit box table has ${CAR_BODY_SIZE.length}.`,
      );
    }
    for (let i = 0; i < Math.min(renderSizes.length, CAR_BODY_SIZE.length); i++) {
      const a = renderSizes[i];
      const b = CAR_BODY_SIZE[i];
      if (a.length !== b.length || a.width !== b.width || a.height !== b.height) {
        failures.push(
          `Body ${i} is drawn ${a.length}x${a.width}x${a.height} and hits at ` +
            `${b.length}x${b.width}x${b.height}. A car must knock you over exactly where it looks.`,
        );
      }
    }
  }

  // --- The clock in the file is the clock in the code.
  if (contract) {
    if (contract.hz !== undefined && contract.hz !== TRAFFIC_HZ) {
      failures.push(`The world was baked at ${contract.hz} Hz and this build reads it at ${TRAFFIC_HZ}.`);
    }
    if (contract.epoch_ms !== undefined && contract.epoch_ms !== TRAFFIC_EPOCH_MS) {
      failures.push(
        `The world's traffic epoch is ${contract.epoch_ms} and this build's is ${TRAFFIC_EPOCH_MS}; ` +
          'every car in the city would be in the wrong place.',
      );
    }
    if (contract.version !== undefined && contract.version !== LANES_VERSION) {
      failures.push(`The lane sidecars are v${contract.version} and this build reads v${LANES_VERSION}.`);
    }
  }

  // --- A synthetic tile, through the real encoder and the real decoder.
  //
  // North-running, two-way, 200 m, at a known height, with the lane offset the
  // pipeline would give it. This is what makes the checks below assertions about
  // the shipped format rather than about an object literal.
  const NORTH_LANE_OFFSET = 1.875; // 7.5 m residential carriageway, quarter width
  const route = syntheticRoute(NORTH_LANE_OFFSET);
  const field = new TrafficField();
  field.adopt('synthetic', { ways: [], routes: [route] });

  // --- LEFT-HAND TRAFFIC. The one that is invisible without an assertion.
  //
  // The way runs due north, which in renderer axes is -Z. Left of north is west,
  // which is -X. So a car on this way must sit at negative x -- and the lane the
  // pipeline built is at exactly minus the offset.
  const pose = createCarPose();
  const scratch: LaneRoute[] = [];
  let sampled = 0;
  let onTheLeft = 0;
  for (let tick = 0; tick < 600; tick += 7) {
    if (!poseCar(route, 0, trafficSeconds(tick), pose)) continue;
    sampled++;
    if (pose.dz > -0.99) {
      failures.push(`A car on a due-north way is heading (${pose.dx}, ${pose.dz}); it must be (0, -1).`);
      break;
    }
    // Left of the heading is (dz, -dx). The offset from the centreline (x = 0)
    // projected onto it must be positive.
    if (pose.x * pose.dz - 0 * pose.dx > 0) onTheLeft++;
  }
  if (sampled === 0) failures.push('No car was live on the synthetic route at any sampled tick.');
  else if (onTheLeft !== sampled) {
    failures.push(
      `${sampled - onTheLeft} of ${sampled} sampled positions were on the RIGHT of the direction of ` +
        'travel. This is Australia; the lane offset sign is inverted.',
    );
  }

  // --- Determinism. The same tick, twice, through two decodes of the same bytes.
  {
    const other = syntheticRoute(NORTH_LANE_OFFSET);
    const a = createCarPose();
    const b = createCarPose();
    for (let tick = 0; tick < 4000; tick += 13) {
      const now = trafficSeconds(tick);
      for (let slot = 0; slot < 3; slot++) {
        const liveA = poseCar(route, slot, now, a);
        const liveB = poseCar(other, slot, now, b);
        if (liveA !== liveB) {
          failures.push(`Two copies of one route disagreed about whether car ${slot} exists at tick ${tick}.`);
          tick = 1e9;
          break;
        }
        if (!liveA) continue;
        if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.body !== b.body || a.colour !== b.colour) {
          failures.push(
            `Two copies of one route put car ${slot} in different places at tick ${tick}: ` +
              `(${a.x}, ${a.y}, ${a.z}) vs (${b.x}, ${b.y}, ${b.z}).`,
          );
          tick = 1e9;
          break;
        }
      }
    }
  }

  // --- The car stops at the red light. The dwell is two copies of one vertex,
  // and a lookup that interpolated *through* it would never be stationary.
  {
    const held = createCarPose();
    let stationary = 0;
    let lastX = NaN;
    let lastZ = NaN;
    for (let tick = 0; tick < 900; tick++) {
      if (!poseCar(route, 0, trafficSeconds(tick), held)) continue;
      if (held.x === lastX && held.z === lastZ) stationary++;
      lastX = held.x;
      lastZ = held.z;
    }
    if (stationary < 30) {
      failures.push(
        `The synthetic route has a ${SYNTHETIC_DWELL} s red light in it and the car was stationary for ` +
          `${stationary} of 900 ticks. A dwell must hold the car still, not slow it down.`,
      );
    }
  }

  // --- The knockdown, on a scripted victim standing in the lane.
  {
    const victim = syntheticVictim();
    // Put them exactly where the car will be at tick 300.
    const at = createCarPose();
    if (!poseCar(route, 0, trafficSeconds(300), at)) {
      failures.push('The synthetic car was not live at tick 300; the knockdown check could not run.');
    } else {
      victim.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      if (!carOverlaps(at, victim)) {
        failures.push('A combatant standing exactly on a car was not overlapped by it.');
      }
      const found = carHitting(field, victim, 300, scratch, pose);
      if (found === null) {
        failures.push('A combatant standing in the lane was not found by `carHitting`.');
      } else {
        const before = victim.health;
        applyCarHit(victim, found);
        if (victim.health !== before - CAR_DAMAGE) {
          failures.push(`A car took ${before - victim.health} pips; it must take ${CAR_DAMAGE}.`);
        }
        if (victim.phase !== 'flinch') {
          failures.push(`A survivable car hit left the victim in '${victim.phase}'; it must be 'flinch'.`);
        }
        if (victim.phaseT >= 0) {
          failures.push(
            'The car stagger did not extend the flinch. `phaseT` must start negative so ' +
              "`combat.advance`'s own lockout test ends it late.",
          );
        }
        const speed = Math.sqrt(
          victim.body.velocity.x * victim.body.velocity.x +
            victim.body.velocity.z * victim.body.velocity.z,
        );
        if (Math.abs(speed - CAR_KNOCKBACK_HORIZONTAL) > 1e-6) {
          failures.push(`A car launched the victim at ${speed.toFixed(2)} m/s; it must be ${CAR_KNOCKBACK_HORIZONTAL}.`);
        }
        if (victim.body.velocity.y <= 0) failures.push('A car did not launch the victim upward.');
        if (victim.body.onGround) failures.push('A launched victim was left on the ground and will be charged friction for their flight.');
        if (canBeRunDown(victim)) {
          failures.push('A victim in a car flinch can be run down again this instant; the re-hit guard is not working.');
        }
      }
    }
  }

  // --- Somebody under a viaduct is not hit by the traffic on it.
  {
    const under = syntheticVictim();
    const at = createCarPose();
    if (poseCar(route, 0, trafficSeconds(300), at)) {
      under.body.position.set(at.x, at.y - 8 + EYE_HEIGHT, at.z);
      if (carOverlaps(at, under)) {
        failures.push('A car eight metres overhead knocked over somebody on the street below.');
      }
    }
  }

  // --- The broadphase finds what the flat list has.
  {
    const all = field.routes();
    if (all.length !== 1) failures.push(`The field holds ${all.length} routes after adopting one tile with one route.`);
    const found = field.near(route.x[0], route.z[0], 20, scratch);
    if (found.length !== 1) failures.push(`The broadphase found ${found.length} routes at a point on the only route in the field.`);
    field.drop('synthetic');
    if (field.routes().length !== 0) failures.push('Dropping a tile left its routes in the field.');
  }

  return failures;
}

/** The red on the synthetic route, seconds. */
const SYNTHETIC_DWELL = 5;

/**
 * A 200 m two-way street running due north, encoded and decoded through the real
 * format so the checks above test the shipped bytes rather than an object.
 */
function syntheticRoute(offset: number): LaneRoute {
  // Five vertices, the middle one doubled for a red light. World axes: north is
  // -Z, so the lane runs from z = 0 to z = -200, and the left of that is -X.
  const pts: Array<[number, number, number, number]> = [];
  const speed = 11.1;
  const legs = [0, 50, 100, 100, 150, 200];
  let t = 0;
  for (let i = 0; i < legs.length; i++) {
    if (i > 0) {
      const gap = legs[i] - legs[i - 1];
      t += gap === 0 ? SYNTHETIC_DWELL : gap / speed;
    }
    pts.push([-offset, -12.5, -legs[i], t]);
  }

  const bytes = new ArrayBuffer(16 + 16 + pts.length * 16);
  const v = new DataView(bytes);
  v.setUint32(0, LANES_MAGIC, true);
  v.setUint32(4, LANES_VERSION, true);
  v.setUint32(8, 0, true);
  v.setUint32(12, 1, true);
  v.setUint32(16, 0x5eed, true);
  v.setUint8(20, 10); // residential
  v.setUint8(21, 0);
  v.setUint16(22, pts.length, true);
  v.setFloat32(24, 9, true); // headway, seconds
  v.setFloat32(28, 0, true); // phase
  let o = 32;
  for (const [x, y, z, at] of pts) {
    v.setFloat32(o, x, true);
    v.setFloat32(o + 4, y, true);
    v.setFloat32(o + 8, z, true);
    v.setFloat32(o + 12, at, true);
    o += 16;
  }
  const tile = decodeLanes(bytes, 0, 0);
  if (tile === null || tile.routes.length !== 1) {
    // Impossible unless the encoder above and the decoder have diverged, which
    // is exactly the thing this construction exists to catch. A throw here is
    // caught by the caller's own harness rather than being a silent zero.
    throw new Error('verifyTraffic could not round-trip its own synthetic lane sidecar');
  }
  return tile.routes[0];
}

/**
 * A victim to run over, from `combat.createCombatant` rather than from a literal.
 *
 * Written as an object literal first, which was wrong for a reason worth
 * recording: `CombatantState` grows -- it gained the powerup clocks, then the
 * ball supply -- and a literal here compiles until the day it does not, which is
 * a build break in a self-check rather than in the thing that changed. Asking
 * the module that owns the record to make one costs nothing and cannot rot.
 */
function syntheticVictim(): CombatantState {
  return createCombatant(1, 0, 0);
}
