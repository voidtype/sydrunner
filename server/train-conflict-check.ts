/**
 * Do two trains ever occupy the same piece of Sydney at the same instant?
 *
 *     bun run server/train-conflict-check.ts
 *     bun run server/train-conflict-check.ts --soft --top 40      # measure, do not gate
 *     SYDNEY_RAIL=data/scratch/rail/rail.bin bun run server/train-conflict-check.ts
 *
 * ---------------------------------------------------------------------------
 * ## The report this exists to answer
 *
 * *"the trains going through each other"*. One sentence, and it is not the
 * question the bake already answers. `rail.solve_phases` proves a *timetable*
 * property -- no two services hold the same **rail key** (`block * 2 + slot`)
 * within the separation margin -- and `rail.separation_sweep`, `separationSweep`
 * and `checkRail` re-derive that same property from three implementations. All
 * three were green on the bake the report was filed against. The player was
 * still right, because the invariant everybody proved is about **a point on a
 * rail key** and what the player sees is **eight carriage bodies drawn in world
 * space**. Three ways those came apart:
 *
 *   1. **A train is 163 m long and occupancy was a point.** `occupancy` mapped
 *      the arc-length range of the *pose*, which is the consist's centre, so
 *      eighty metres of train hung off each end of every claim the timetable
 *      made. Twenty seconds between two centres is six hundred metres at line
 *      speed and nothing at all at a platform, where both trains are stopped.
 *      Fixed: `rail.occupancy` takes `consist_half` and the window now runs
 *      from the nose entering to the tail leaving.
 *   2. **A flat crossing is not a shared block.** Two routes that cross at a
 *      node without sharing a block section have no rail key in common, so the
 *      solver had nothing to constrain. Fixed: `rail.foul_sites` turns every
 *      such place into a synthetic occupancy site the solver reads exactly like
 *      a rail.
 *   3. **The `slot` is a claim about geometry that the geometry does not keep.**
 *      `BlockSet.key` puts the two directions of a corridor on different rails
 *      -- correctly, a double-track railway is what passing is for -- and
 *      `rail.compute_lateral` is what makes the claim true, shoving each
 *      direction `SHARED_OFFSET_M` off a shared centreline. It holds that offset
 *      at **zero within 110 m of a calling stop**, because `world/rail-solids`
 *      builds the platform 1.62 m off the anchor centreline *on both sides* and
 *      a train pushed sideways at a platform is a train drawn inside it. **Not
 *      fixed here, and the reason is measured rather than asserted** -- see
 *      `SHARED_BUDGET`.
 *
 * ---------------------------------------------------------------------------
 * ## The two tests
 *
 * **A. Occupancy over the whole consist.** The solver's own test -- same rail
 * key at the same instant -- asked of every carriage rather than of the centre
 * point. This is the honest version of the invariant the bake claims, and it is
 * the one that must be zero.
 *
 * **B. The geometric test, which is what the eye does.** Every carriage body of
 * every live train, as the segment it is drawn as: `sampleAlong` at the two ends
 * of the body, *including* `bake.lateral`, because the offset is the thing that
 * decides whether a pass is a pass. Two bodies whose centrelines come within
 * `NEAR_PLAN_M` in plan and `NEAR_HEIGHT_M` in height are inside each other: the
 * drawn body is `2 * CAR_BODY_HALF_M` = 3.1 m wide.
 *
 * Every hit is then classified by what the two *raw* centrelines were doing
 * there, because that is the difference between four different bugs with four
 * different owners -- see `Kind`. In particular a pass on a **parallel** track
 * drawn tighter than a car body is wide is not charged to the timetable: two
 * trains passing on a double-track railway is what the railway is for, and the
 * spacing is RAIL-CORRIDOR.md's lateral budget, ratcheted by
 * `server/rail-gauge-check.ts`.
 *
 * ---------------------------------------------------------------------------
 * ## The sweep
 *
 * One full cycle (`bake.cycleS`) at 1 Hz for the broad phase, refined to
 * `FINE_HZ` over any second in which a pair is within `NEAR_GATE_M`. The gate is
 * not a guess: the fastest closing speed on the network is two express trains
 * head-on at `2 * vExpress` = 133 m/s, so a pair more than 300 m apart at both
 * ends of a one-second window cannot have been inside 3 m during it.
 *
 * Every pose comes from `poseTrain`, through the decoder the browser and the
 * server both run. No pipeline code is imported: this reads the shipped bytes,
 * which is what makes it a second opinion rather than an echo.
 */

import {
  createTrainPose,
  decodeRail,
  liveTripCount,
  ORIGIN_STAND_S,
  poseTrain,
  railAt,
  sampleAlong,
  tripIndexAt,
  type RailBake,
  type RailDirection,
  type TrainPose,
} from '../client/src/game/rail.ts';
import {
  consistOffset,
  METRO,
  METRO_PITCH,
  SUBURBAN,
  SUBURBAN_PITCH,
} from '../client/src/game/riding.ts';
import { COINCIDENT_M, PARALLEL_COS } from '../client/src/world/track-atlas.ts';

// --- The thresholds ----------------------------------------------------------------

/**
 * How close two carriage centrelines may come in plan before they are inside
 * each other. `world/envelope.CAR_BODY_HALF_M` is 1.55, so two bodies touch at
 * 3.10 m of centreline separation; 3 m is that, rounded down, so nothing here
 * is a near miss reported as a hit.
 */
const NEAR_PLAN_M = 3.0;
/** ...and in height. A carriage is about 4 m tall; 3 m of vertical offset is still overlap. */
const NEAR_HEIGHT_M = 3.0;
/** Broad-phase gate on the pose centres, metres. See the header: 2*66.6 m/s closing. */
const NEAR_GATE_M = 300;
/** Refinement rate inside a flagged second. */
const FINE_HZ = 10;
/**
 * The gap between two carriage bodies, metres. `world/trains.COUPLER_GAP_M`,
 * restated because that module imports three and this process has none. A body
 * is `pitch - COUPLER_GAP_M` long, which is what the renderer scales it to.
 * `pipeline/sydney/rail.COUPLER_GAP_M` is the third copy and the assertion
 * below is what keeps the three honest.
 */
const COUPLER_GAP_M = 0.9;
/** How near a station has to be for a conflict to be filed under its name. */
const STATION_REACH_M = 400;

// --- What must be zero, and what is a named residue --------------------------------

/**
 * Two services drawn on **one alignment**, held apart by a `slot` the geometry
 * does not honour, and this is where the bake still puts two trains in one
 * place. Every one of them is within 110 m of a calling stop, which is where
 * `rail.compute_lateral` sets the offset to zero.
 *
 * **Why it is a budget and not a zero.** Two fixes were measured against the
 * 60 km bake and both were refused by the measurement:
 *
 *   * *Make the timetable separate them* -- give a shared-alignment site one
 *     occupancy for both directions, which is the obvious reading of "junction
 *     blocks that are genuinely shared get one occupancy". The solve does not
 *     survive it: the platform roads at Central, Strathfield and Regents Park
 *     come out 120-160% subscribed, the period ladder answers by putting nine
 *     of the eleven lines on a **six-minute** headway, and it *still* returns no
 *     assignment. A railway nobody can catch is a worse answer than a railway
 *     with a graphical fault, and TRAINS.md's whole point is the two-minute
 *     service.
 *   * *Make the geometry separate them* -- carry `SHARED_OFFSET_M` through the
 *     platform instead of zeroing it. `world/rail-solids` builds the platform
 *     deck from 1.62 m to 7.12 m off the anchor centreline **on both sides**,
 *     so a train two metres off the centreline at a platform is a train inside
 *     the platform, which is the *other* thing the owner has already reported
 *     ("*im passing thru platform all the time*").
 *
 * The alignment itself is the thing that is wrong, and moving it is
 * RAIL-CORRIDOR.md's **P5** -- "*synthetically offset the coincident direction
 * pairs by ±2 m so trains stop sharing rails head-on*" -- which is a geometry
 * round with platforms in it and eyes on the end of it. Until then this
 * ratchets: the number may fall and may never rise.
 */
const SHARED_BUDGET = 60;
/**
 * Two services on **two** alignments, running parallel, drawn closer than a car
 * body is wide. A legitimate pass on a neighbouring track at OSM's spacing --
 * the median gap between adjacent running lines in this extract is 4.05 m and
 * the tail of it is under three. Not the timetable's, by construction: no
 * offset the solver can choose changes where two parallel tracks are. It is
 * RAIL-CORRIDOR.md's lateral budget, and `server/rail-gauge-check.ts` is the
 * check that ratchets it down. Counted here so the number is not lost.
 */
const ADJACENT_BUDGET = 75;

// --- Arguments ---------------------------------------------------------------------

const flag = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const RAIL_PATH = process.env.SYDNEY_RAIL
  ?? flag('rail', new URL('../client/public/rail/rail.bin', import.meta.url).pathname);
const TOP = Number(flag('top', '25'));
/** Report only; do not gate. For measuring a tree before it is fixed. */
const SOFT = process.argv.includes('--soft');

const say = (s: string): void => console.log(s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

// --- The bake ----------------------------------------------------------------------

const began = performance.now();
const bake: RailBake = decodeRail(await Bun.file(RAIL_PATH).arrayBuffer());
const CYCLE = Math.round(bake.cycleS);

say(`--- train-conflict: ${RAIL_PATH}`);
say(
  `    bake v${bake.version}, cycle ${CYCLE} s, ${bake.lines.length} lines, ` +
    `${bake.blockLength.length} blocks (${bake.blockJunction.reduce((a, c) => a + c, 0)} junction), ` +
    `loaded in ${((performance.now() - began) / 1000).toFixed(1)} s`,
);
say(
  `    the test: carriage centrelines within ${NEAR_PLAN_M} m in plan and ` +
    `${NEAR_HEIGHT_M} m in height, over the whole consist, every ${1 / FINE_HZ} s a pair is near`,
);
say(
  `    periods: ${bake.lines.map((l) => `${l.id} ${l.period}s`).join('  ')}`,
);

// --- Do the two ends agree about what a train is? -----------------------------------
//
// The consist lives in TypeScript (`game/riding`) and the solver lives in
// Python, so the pipeline ships the numbers it used and this compares them. A
// solver that proved its invariant about a 163 m train against a renderer
// drawing a 132 m one would be exactly the class of bug this file exists for.
const contract: string[] = [];
{
  const sub = (SUBURBAN.length * SUBURBAN_PITCH - COUPLER_GAP_M) / 2;
  const met = (METRO.length * METRO_PITCH - COUPLER_GAP_M) / 2;
  const near = (a: number | undefined, b: number, what: string): void => {
    if (a === undefined) { contract.push(`the bake carries no ${what}`); return; }
    if (Math.abs(a - b) > 0.01) contract.push(`the bake solved against ${what} ${a} and this process draws ${b}`);
  };
  near(bake.physics.consistHalfM, sub, 'a suburban half-consist of');
  near(bake.physics.consistHalfMetroM, met, 'a Metro half-consist of');
  near(bake.physics.originStandS, ORIGIN_STAND_S, 'an origin stand of');
  say(
    `    the consist: ${SUBURBAN.length} x ${SUBURBAN_PITCH} m suburban (half ${sub.toFixed(2)} m), ` +
      `${METRO.length} x ${METRO_PITCH} m Metro (half ${met.toFixed(2)} m), ` +
      `${ORIGIN_STAND_S} s standing at the origin` +
      (contract.length === 0 ? ' -- and the bake solved against the same' : ''),
  );
  for (const c of contract) say(`    MISMATCH: ${c}`);
}

// --- Trains ------------------------------------------------------------------------

interface Unit {
  li: number;
  dir: RailDirection;
  /** `T4→` / `T4←` -- the way a service reads on a board. */
  tag: string;
  cars: number;
  pitch: number;
  bodyHalf: number;
}

const units: Unit[] = [];
bake.lines.forEach((line, li) => {
  for (const dir of line.dirs) {
    const cars = line.metro ? METRO.length : SUBURBAN.length;
    const pitch = line.metro ? METRO_PITCH : SUBURBAN_PITCH;
    units.push({
      li,
      dir,
      tag: `${line.id}${dir.index === 0 ? '→' : '←'}`,
      cars,
      pitch,
      bodyHalf: (pitch - COUPLER_GAP_M) / 2,
    });
  }
});

/** One train at one instant: the pose centre plus every carriage body as drawn. */
interface Train {
  unit: Unit;
  trip: number;
  /** Stable within the sweep. Two samples of one train must never look like two trains. */
  who: number;
  x: number;
  z: number;
  y: number;
  s: number;
  speed: number;
  /** 3 per car end: x, z, y -- the body centreline's two ends, as drawn. */
  bodyA: Float64Array;
  bodyB: Float64Array;
  /** Arc length of each carriage's centre, so a hit can be traced back. */
  carS: Float64Array;
  /** Rail key under each carriage centre. */
  carRail: Int32Array;
  /** Every rail key anywhere under the consist, for the occupancy test. */
  rails: Set<number>;
}

const _pose: TrainPose = createTrainPose();
const _end: TrainPose = createTrainPose();

function trainAt(u: Unit, trip: number, t: number): Train | null {
  if (!poseTrain(bake, u.dir, trip, t, _pose)) return null;
  const n = u.cars;
  const bodyA = new Float64Array(n * 3);
  const bodyB = new Float64Array(n * 3);
  const carS = new Float64Array(n);
  const carRail = new Int32Array(n);
  const rails = new Set<number>();
  for (let k = 0; k < n; k++) {
    const centre = consistOffset(_pose.s, k, n, u.pitch);
    carS[k] = centre;
    sampleAlong(bake, u.dir, centre - u.bodyHalf, _end);
    bodyA[k * 3] = _end.x; bodyA[k * 3 + 1] = _end.z; bodyA[k * 3 + 2] = _end.y;
    sampleAlong(bake, u.dir, centre + u.bodyHalf, _end);
    bodyB[k * 3] = _end.x; bodyB[k * 3 + 1] = _end.z; bodyB[k * 3 + 2] = _end.y;
    carRail[k] = railAt(u.dir, centre);
    // Three arc-length samples a carriage: the two ends of a 19.5 m body can
    // straddle a block boundary and the centre is the one the solver used.
    for (const s of [centre - u.bodyHalf, centre, centre + u.bodyHalf]) {
      const key = railAt(u.dir, s);
      if (key >= 0) rails.add(key);
    }
  }
  return {
    unit: u,
    trip,
    who: (u.li * 2 + u.dir.index) * 1_000_003 + (((trip % 100000) + 100000) % 100000),
    x: _pose.x, z: _pose.z, y: _pose.y, s: _pose.s, speed: _pose.speed,
    bodyA, bodyB, carS, carRail, rails,
  };
}

/** Every train running at `t`, deduped by trip. `j = -1` picks up the origin stand. */
function fleetAt(t: number): Train[] {
  const out: Train[] = [];
  for (const u of units) {
    const live = liveTripCount(u.dir);
    let last = Number.NaN;
    for (let j = -1; j <= live; j++) {
      const trip = tripIndexAt(u.dir, t, j);
      if (trip === last) continue;
      last = trip;
      const tr = trainAt(u, trip, t);
      if (tr) out.push(tr);
    }
  }
  return out;
}

// --- Geometry ----------------------------------------------------------------------

/**
 * Closest approach of two segments in plan, with the parameters, so the height
 * can be read where the two are actually closest rather than at a midpoint.
 * The standard clamped-parameter form; degenerate segments fall out of it
 * correctly because the denominators are floored.
 */
function segClosest(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): { d: number; u: number; v: number } {
  const ux = bx - ax, uz = bz - az;
  const vx = dx - cx, vz = dz - cz;
  const wx = ax - cx, wz = az - cz;
  const a = ux * ux + uz * uz;
  const b = ux * vx + uz * vz;
  const c = vx * vx + vz * vz;
  const d = ux * wx + uz * wz;
  const e = vx * wx + vz * wz;
  const den = a * c - b * b;
  let sN: number, sD = den, tN: number, tD = den;
  if (den < 1e-12) { sN = 0; sD = 1; tN = e; tD = c; }
  else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) { sN = 0; tN = e; tD = c; }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0; else if (-d + b > a) sN = sD; else { sN = -d + b; sD = a; }
  }
  const u = Math.abs(sD) < 1e-12 ? 0 : sN / sD;
  const v = Math.abs(tD) < 1e-12 ? 0 : tN / tD;
  const px = wx + u * ux - v * vx;
  const pz = wz + u * uz - v * vz;
  return { d: Math.hypot(px, pz), u, v };
}

/**
 * The **raw** centreline at an arc length: where the alignment is, with the
 * lateral offset taken back off.
 *
 * `sampleAlong` draws the train, and the drawn positions are what the eye
 * judges -- but the *classification* needs to know whether the two trains were
 * on one alignment or two, and that is a fact about the railway rather than
 * about the offset the bake chose. Same binary search, same interpolation, and
 * the offset undone with the same two lines that applied it.
 */
function rawAt(dir: RailDirection, s: number): { x: number; z: number; hx: number; hz: number } {
  const c = bake.cum;
  let lo = dir.vertexOff;
  let hi = dir.vertexOff + dir.vertexCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= s) lo = mid; else hi = mid - 1;
  }
  if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
  const span = c[lo + 1] - c[lo];
  const u = span > 0 ? (s - c[lo]) / span : 0;
  const p = bake.vertices;
  const ax = p[lo * 3], az = p[lo * 3 + 2];
  const bx = p[(lo + 1) * 3], bz = p[(lo + 1) * 3 + 2];
  let hx = bx - ax, hz = bz - az;
  const L = Math.hypot(hx, hz) || 1;
  hx /= L; hz /= L;
  const lat = bake.lateral[lo] + (bake.lateral[lo + 1] - bake.lateral[lo]) * u;
  return { x: ax + (bx - ax) * u + hz * lat, z: az + (bz - az) * u - hx * lat, hx, hz };
}

// --- Stations, for filing a conflict under a name ------------------------------------

const stations = bake.stations.filter((st) => Number.isFinite(st.siteX));
function nearestStation(x: number, z: number): string {
  let best = '';
  let bd = Infinity;
  for (const st of stations) {
    const dx = st.siteX - x;
    const dz = st.siteZ - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; best = st.name; }
  }
  return Math.sqrt(bd) <= STATION_REACH_M ? best : '(open line)';
}

// --- The record ---------------------------------------------------------------------

/**
 * What kind of place the two bodies met in, which is the difference between
 * four bugs with four owners.
 *
 *  * `same-rail` -- one alignment, **one rail key**. The block solver's own
 *    invariant, broken. Must be zero.
 *  * `crossing`  -- two alignments meeting at an angle. A flat junction the
 *    block model has nothing shared to constrain. Must be zero:
 *    `rail.foul_sites` is what makes it so.
 *  * `shared`    -- one alignment, two rail keys. The `slot` is a claim the
 *    geometry does not keep. `SHARED_BUDGET`.
 *  * `adjacent`  -- two alignments, parallel, drawn closer than a car body is
 *    wide. A legitimate pass at OSM's spacing. `ADJACENT_BUDGET`.
 */
type Kind = 'same-rail' | 'crossing' | 'shared' | 'adjacent';

const CHARGED: Kind[] = ['same-rail', 'crossing'];

interface Event {
  key: string;
  a: string;
  b: string;
  kind: Kind;
  t0: number;
  t1: number;
  minD: number;
  rawD: number;
  cos: number;
  x: number;
  z: number;
  y: number;
  station: string;
  railA: number;
  railB: number;
}

const events = new Map<string, Event>();
const occEvents = new Map<string, Event>();
let geomInstants = 0;
let occInstants = 0;

function classify(railA: number, railB: number, rawD: number, cos: number): Kind {
  if (rawD < COINCIDENT_M) {
    return railA >= 0 && railA === railB ? 'same-rail' : 'shared';
  }
  return Math.abs(cos) >= PARALLEL_COS ? 'adjacent' : 'crossing';
}

/** Test one pair at one instant. */
function testPair(A: Train, B: Train, t: number): void {
  let bestD = Infinity;
  let bx = 0, bz = 0, by = 0, brA = -1, brB = -1, bsA = 0, bsB = 0;
  for (let i = 0; i < A.unit.cars; i++) {
    const a0x = A.bodyA[i * 3], a0z = A.bodyA[i * 3 + 1], a0y = A.bodyA[i * 3 + 2];
    const a1x = A.bodyB[i * 3], a1z = A.bodyB[i * 3 + 1], a1y = A.bodyB[i * 3 + 2];
    for (let j = 0; j < B.unit.cars; j++) {
      const b0x = B.bodyA[j * 3], b0z = B.bodyA[j * 3 + 1], b0y = B.bodyA[j * 3 + 2];
      const b1x = B.bodyB[j * 3], b1z = B.bodyB[j * 3 + 1], b1y = B.bodyB[j * 3 + 2];
      const { d, u, v } = segClosest(a0x, a0z, a1x, a1z, b0x, b0z, b1x, b1z);
      if (d >= NEAR_PLAN_M) continue;
      const ya = a0y + (a1y - a0y) * u;
      const yb = b0y + (b1y - b0y) * v;
      if (Math.abs(ya - yb) >= NEAR_HEIGHT_M) continue;
      if (d < bestD) {
        bestD = d;
        bx = a0x + (a1x - a0x) * u;
        bz = a0z + (a1z - a0z) * u;
        by = ya;
        brA = A.carRail[i];
        brB = B.carRail[j];
        bsA = A.carS[i] + (u - 0.5) * 2 * A.unit.bodyHalf;
        bsB = B.carS[j] + (v - 0.5) * 2 * B.unit.bodyHalf;
      }
    }
  }
  if (bestD === Infinity) return;
  geomInstants++;

  const ra = rawAt(A.unit.dir, bsA);
  const rb = rawAt(B.unit.dir, bsB);
  const rawD = Math.hypot(ra.x - rb.x, ra.z - rb.z);
  const cos = ra.hx * rb.hx + ra.hz * rb.hz;

  const key = `${Math.min(A.who, B.who)}:${Math.max(A.who, B.who)}`;
  const first = A.who <= B.who ? A : B;
  const second = A.who <= B.who ? B : A;
  const railA = first === A ? brA : brB;
  const railB = first === A ? brB : brA;
  const prev = events.get(key);
  if (prev === undefined) {
    events.set(key, {
      key,
      a: `${first.unit.tag}#${first.trip}`,
      b: `${second.unit.tag}#${second.trip}`,
      kind: classify(railA, railB, rawD, cos),
      t0: t, t1: t, minD: bestD, rawD, cos, x: bx, z: bz, y: by,
      station: nearestStation(bx, bz), railA, railB,
    });
    return;
  }
  prev.t0 = Math.min(prev.t0, t);
  prev.t1 = Math.max(prev.t1, t);
  if (bestD < prev.minD) {
    prev.minD = bestD;
    prev.rawD = rawD;
    prev.cos = cos;
    prev.x = bx; prev.z = bz; prev.y = by;
    prev.station = nearestStation(bx, bz);
    prev.railA = railA; prev.railB = railB;
    prev.kind = classify(railA, railB, rawD, cos);
  }
}

/** The occupancy test: did the two consists want the same rail key at once? */
function testOccupancy(A: Train, B: Train, t: number): void {
  let shared = -1;
  const small = A.rails.size <= B.rails.size ? A.rails : B.rails;
  const big = small === A.rails ? B.rails : A.rails;
  for (const k of small) if (big.has(k)) { shared = k; break; }
  if (shared < 0) return;
  occInstants++;
  const key = `${Math.min(A.who, B.who)}:${Math.max(A.who, B.who)}`;
  const first = A.who <= B.who ? A : B;
  const second = A.who <= B.who ? B : A;
  const d = Math.hypot(A.x - B.x, A.z - B.z);
  const prev = occEvents.get(key);
  if (prev === undefined) {
    occEvents.set(key, {
      key,
      a: `${first.unit.tag}#${first.trip}`,
      b: `${second.unit.tag}#${second.trip}`,
      kind: 'same-rail',
      t0: t, t1: t, minD: d, rawD: 0, cos: 1,
      x: A.x, z: A.z, y: A.y,
      station: nearestStation(A.x, A.z), railA: shared, railB: shared,
    });
    return;
  }
  prev.t0 = Math.min(prev.t0, t);
  prev.t1 = Math.max(prev.t1, t);
  if (d < prev.minD) {
    prev.minD = d;
    prev.x = A.x; prev.z = A.z; prev.y = A.y;
    prev.station = nearestStation(A.x, A.z);
    prev.railA = shared;
    prev.railB = shared;
  }
}

// --- The sweep ----------------------------------------------------------------------

const swept = performance.now();
let fineSamples = 0;
let peakFleet = 0;

for (let sec = 0; sec < CYCLE; sec++) {
  const fleet = fleetAt(sec);
  if (fleet.length > peakFleet) peakFleet = fleet.length;

  // Broad phase over the pose centres: the fleet is a few hundred trains, so a
  // grid saves tens of thousands of distance tests a second and costs a map.
  const CELL = NEAR_GATE_M;
  const grid = new Map<number, number[]>();
  fleet.forEach((tr, i) => {
    const k = Math.floor(tr.x / CELL) * 100003 + Math.floor(tr.z / CELL);
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  });

  const near: Array<[number, number]> = [];
  const seen = new Set<number>();
  fleet.forEach((tr, i) => {
    const gx = Math.floor(tr.x / CELL);
    const gz = Math.floor(tr.z / CELL);
    for (let ax = gx - 1; ax <= gx + 1; ax++) {
      for (let az = gz - 1; az <= gz + 1; az++) {
        const list = grid.get(ax * 100003 + az);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const o = fleet[j];
          const dx = o.x - tr.x;
          const dz = o.z - tr.z;
          if (dx * dx + dz * dz > NEAR_GATE_M * NEAR_GATE_M) continue;
          const pk = i * 100000 + j;
          if (seen.has(pk)) continue;
          seen.add(pk);
          near.push([i, j]);
        }
      }
    }
  });
  if (near.length === 0) continue;

  // Refine. Every pair that came within the gate gets `FINE_HZ` samples over the
  // second, both trains re-posed at each.
  for (let f = 0; f < FINE_HZ; f++) {
    const t = sec + f / FINE_HZ;
    const cache = new Map<number, Train | null>();
    const at = (i: number): Train | null => {
      const c = cache.get(i);
      if (c !== undefined) return c;
      const tr = trainAt(fleet[i].unit, fleet[i].trip, t);
      cache.set(i, tr);
      return tr;
    };
    for (const [i, j] of near) {
      const A = at(i);
      const B = at(j);
      if (!A || !B) continue;
      const dx = A.x - B.x;
      const dz = A.z - B.z;
      if (dx * dx + dz * dz > NEAR_GATE_M * NEAR_GATE_M) continue;
      fineSamples++;
      testOccupancy(A, B, t);
      testPair(A, B, t);
    }
  }
}

const sweepS = (performance.now() - swept) / 1000;

// --- The report ---------------------------------------------------------------------

const all = [...events.values()].sort((a, b) => a.minD - b.minD);
const occ = [...occEvents.values()].sort((a, b) => a.minD - b.minD);
const of = (k: Kind): Event[] => all.filter((e) => e.kind === k);
const charged = all.filter((e) => CHARGED.includes(e.kind));

say('');
say('=== SWEEP ===');
say(
  `  ${CYCLE} coarse seconds, ${fineSamples.toLocaleString()} fine pair-samples at ${FINE_HZ} Hz, ` +
    `peak fleet ${peakFleet} trains, ${sweepS.toFixed(1)} s`,
);

say('');
say('=== A. OCCUPANCY OVER THE CONSIST (two trains claiming one rail key) ===');
say(`  ${occ.length} conflicting train pairs over the cycle, ${occInstants.toLocaleString()} instants`);
for (const e of occ.slice(0, TOP)) {
  say(
    `    ${padR(e.a, 10)} x ${padR(e.b, 10)} ${padL(e.minD.toFixed(0), 6)} m apart  ` +
      `t=${e.t0.toFixed(1)}..${e.t1.toFixed(1)}s  rail ${e.railA} (block ${e.railA >> 1}` +
      `${bake.blockJunction[e.railA >> 1] ? ', junction' : ''})  ${e.station}`,
  );
}

say('');
say(`=== B. GEOMETRIC (carriage bodies inside ${NEAR_PLAN_M} m plan / ${NEAR_HEIGHT_M} m height) ===`);
say(`  ${all.length} conflicting train pairs over the cycle, ${geomInstants.toLocaleString()} instants`);
say('');
say('  by what the two alignments were doing there:');
const legend: Record<Kind, string> = {
  'same-rail': 'ONE alignment, ONE rail key -- the block solver\'s own invariant, broken',
  crossing: 'TWO alignments crossing -- a flat junction with no block in common',
  shared: 'ONE alignment, two rail keys -- the slot the geometry does not keep',
  adjacent: 'TWO alignments, parallel, tighter than a car body -- a pass at OSM\'s spacing',
};
for (const k of ['same-rail', 'crossing', 'shared', 'adjacent'] as Kind[]) {
  const n = of(k).length;
  const budget = k === 'shared' ? SHARED_BUDGET : k === 'adjacent' ? ADJACENT_BUDGET : 0;
  say(`    ${padL(String(n), 5)}  ${padR(k, 10)} (budget ${budget})  ${legend[k]}`);
}

const tally = (rows: Event[], of_: (e: Event) => string): Array<[string, number, number]> => {
  const m = new Map<string, { n: number; d: number }>();
  for (const e of rows) {
    const k = of_(e);
    const cur = m.get(k) ?? { n: 0, d: Infinity };
    cur.n++;
    cur.d = Math.min(cur.d, e.minD);
    m.set(k, cur);
  }
  return [...m.entries()].map(([k, v]) => [k, v.n, v.d] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);
};
const lineOf = (tag: string): string => tag.replace(/[→←].*/, '');

for (const [title, rows] of [
  ['CHARGED (same-rail + crossing) -- must be zero', charged],
  ['SHARED ALIGNMENT -- the named residue', of('shared')],
  ['ADJACENT TRACK -- a legitimate pass, RAIL-CORRIDOR.md\'s budget', of('adjacent')],
] as Array<[string, Event[]]>) {
  say('');
  say(`  --- ${title}: ${rows.length} pairs`);
  if (rows.length === 0) { say('      (none)'); continue; }
  say('      by line pair:');
  for (const [k, n, d] of tally(rows, (e) => [lineOf(e.a), lineOf(e.b)].sort().join(' / ')).slice(0, TOP)) {
    say(`        ${padR(k, 14)} ${padL(String(n), 5)}   closest ${d.toFixed(2)} m`);
  }
  say('      by station:');
  for (const [k, n, d] of tally(rows, (e) => e.station).slice(0, TOP)) {
    say(`        ${padR(k, 26)} ${padL(String(n), 5)}   closest ${d.toFixed(2)} m`);
  }
  say('      worst:');
  for (const e of rows.slice(0, TOP)) {
    say(
      `        ${padR(e.a, 10)} x ${padR(e.b, 10)} ${padL(e.minD.toFixed(2), 6)} m ` +
        `(alignments ${e.rawD.toFixed(2)} m, cos ${e.cos.toFixed(2)})  ` +
        `t=${e.t0.toFixed(1)}..${e.t1.toFixed(1)}s  rails ${e.railA}/${e.railB}  ` +
        `E${e.x.toFixed(0)} N${(-e.z).toFixed(0)}  ${e.station}`,
    );
  }
}

// --- The gate -----------------------------------------------------------------------

const faults: string[] = [...contract];
if (occ.length) {
  faults.push(
    `${occ.length} train pairs claim one rail key at once: the solver's own invariant, ` +
      `over the whole consist rather than the centre point`,
  );
}
for (const k of CHARGED) {
  const n = of(k).length;
  if (n) faults.push(`${n} ${k} conflicts: ${legend[k]}`);
}
if (of('shared').length > SHARED_BUDGET) {
  faults.push(
    `${of('shared').length} shared-alignment conflicts against a budget of ${SHARED_BUDGET}. ` +
      `The budget ratchets down, never up -- see SHARED_BUDGET for why it is not zero`,
  );
}
if (of('adjacent').length > ADJACENT_BUDGET) {
  faults.push(
    `${of('adjacent').length} adjacent-track passes against a budget of ${ADJACENT_BUDGET}. ` +
      `RAIL-CORRIDOR.md's lateral budget got worse, not better`,
  );
}

say('');
if (faults.length === 0) {
  say(
    `--- train-conflict: PASSED. No two trains claim one rail, none crosses another's path, ` +
      `and the ${of('shared').length} shared-alignment and ${of('adjacent').length} adjacent-track ` +
      `pairs are inside their budgets.`,
  );
} else {
  for (const f of faults) say(`--- train-conflict: FAIL -- ${f}`);
}
process.exit(faults.length === 0 || SOFT ? 0 : 1);
