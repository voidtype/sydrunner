/**
 * The train service: where every train in Sydney is, as a function of the clock.
 *
 * `pipeline/sydney/rail.py` bakes a rail graph, ten stopping patterns pathed
 * through it, a closed-form distance-time curve per line per direction, and a
 * set of integer phase offsets proved to keep every train out of every other
 * train's block section. This file is the only thing that reads that bake, and
 * `poseTrain` is the only thing that answers "where is it".
 *
 * ---------------------------------------------------------------------------
 * A TRAIN IS A LOOKUP, NOT A SIMULATION -- `traffic.ts`' design, one level up.
 *
 * `game/traffic.ts` says it first and says it best: nothing here is stepped,
 * there is no velocity and no state that survives a frame. A train's position
 * is a pure function of `(line, direction, tripIndex, t)`, so sixteen players
 * watch the same trains and `net/protocol.ts` gains not one byte; and when the
 * server decides a train hit somebody at tick T, the client evaluates the
 * identical function at T and applies the identical shove without waiting for
 * a round trip.
 *
 * What is different from traffic, and it is the whole reason the pipeline round
 * was worth doing: **a car's timetable only has to avoid the cars on its own
 * route, and a train's has to avoid nine other lines on shared rails.** That is
 * not a runtime problem here either. It was solved at bake time over the whole
 * repeating cycle and it is re-proved from *this* decoder by `checkRail`, which
 * shares no code with the Python that solved it.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC IS THE CONTRACT.
 *
 * `game/footy.ts` states the rule and `traffic.ts` repeats it: `Math.sin`,
 * `Math.cos`, `Math.pow` and `Math.hypot` are implementation-defined in
 * ECMAScript, and V8 in the browser and JavaScriptCore in Bun differ in the last
 * place. `Math.sqrt` is specified to IEEE-754 exactness. So the evaluator here
 * is:
 *
 *     dt = t - phase.t0
 *     s  = phase.s0 + phase.v0 * dt + 0.5 * phase.a * dt * dt
 *
 * -- three multiplies and two adds -- then a binary search over the polyline's
 * cumulative arc length, a lerp, and exactly one `Math.sqrt` to normalise the
 * heading. No trigonometry anywhere. Every number the search reads is a `f32`
 * or `f64` straight out of the file, and both widen into a double exactly, so
 * two engines handed the same bake and the same millisecond return the same
 * bits. `checkRail` asserts that across ten thousand sampled poses on two
 * separately-evaluated copies of this module.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing.** Not three, not `combat.ts`, not the loader.
 * `traffic.ts` imports `combat.ts` and pays for it; this one has no reason to,
 * and the Bun server compiles it to run the same separation proof the browser
 * does. A `Vector3` reaching here would drag the renderer into a process that
 * draws nothing.
 */

/** ASCII 'RAIL' little-endian. Must match `rail.RAIL_MAGIC`. */
export const RAIL_MAGIC = 0x4c494152;

/** Must match `rail.BAKE_VERSION`. */
export const RAIL_VERSION = 1;

/**
 * 2026-01-01T00:00:00Z. The same instant `traffic.ts` counts from.
 *
 * Shared by value and not by import, for the reason `traffic.ts` gives for its
 * own copy: the decoder needs it before it has read anything, and neither
 * system may drag the other's module into its process. The bake carries the
 * number too and `verifyRail` asserts the two agree, which is the guard that
 * makes the duplication safe rather than merely convenient.
 */
export const RAIL_EPOCH_MS = 1767225600000;

/** The shared clock, in seconds. One subtract and one divide, both exact. */
export function railSeconds(nowMs: number): number {
  return (nowMs - RAIL_EPOCH_MS) / 1000;
}

// --- What the bake says ----------------------------------------------------------

export interface RailStop {
  name: string;
  /** Arc length along this direction's polyline, metres. */
  s: number;
  /** False for a station the line runs through without stopping. */
  calls: boolean;
}

export interface RailBlockRun {
  /** Block section id, shared across every line that uses the same rails. */
  block: number;
  s0: number;
  s1: number;
  /** Which way the service runs through the block: 0 or 1. See `railKey`. */
  slot: number;
}

export interface RailDirection {
  index: number;
  label: string;
  /** Seconds. The first trip of this direction departs at `t = offset`. */
  offset: number;
  /** Seconds from departure to arrival at the far end. */
  duration: number;
  lengthM: number;
  vertexOff: number;
  vertexCount: number;
  phaseOff: number;
  phaseCount: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  stops: RailStop[];
  /** Arrival time at each *calling* station, seconds from departure. */
  arrivals: number[];
  blocks: RailBlockRun[];
  /** Back-reference, filled in by the decoder. */
  line: RailLine;
}

export interface RailLine {
  id: string;
  name: string;
  colour: number;
  metro: boolean;
  /** Seconds between departures, per direction. 120 unless the solver had to give. */
  period: number;
  dirs: RailDirection[];
}

export interface RailStation {
  name: string;
  x: number;
  z: number;
  trackY: number;
  groundY: number;
  vertical: 'surface' | 'elevated' | 'underground' | 'unknown';
  kind: string;
  platforms: number;
  tunnelShare: number;
  bridgeShare: number;
}

export interface RailBake {
  version: number;
  epochMs: number;
  cycleS: number;
  lines: RailLine[];
  stations: RailStation[];
  /** Per block section, indexed by block id. */
  blockLength: Float64Array;
  blockJunction: Uint8Array;
  blockTracks: Int32Array;
  /** (x, y, z) per polyline vertex, every direction concatenated. */
  vertices: Float32Array;
  /** Cumulative arc length per vertex, metres. */
  cum: Float64Array;
  /** (t0, s0, v0, a) per phase, every direction concatenated. */
  phases: Float64Array;
  /** (x, y, z, dx, dz) per catenary mast. Staged for the geometry round. */
  stanchions: Float32Array;
  /** 0 = cantilever left, 1 = cantilever right, 2 = portal gantry. */
  stanchionKinds: Uint8Array;
  /** `SPAN_*` bit flags per polyline vertex, parallel to `vertices`. */
  vertexFlags: Uint8Array;
  physics: {
    accel: number; brake: number; vLocal: number; vExpress: number;
    expressMinM: number; dwell: number;
    blockTargetM: number; sepS: number; sepJunctionS: number; maxGradient: number;
  };
  notes: string[];
  degraded: Record<string, string>;
  raw: Record<string, unknown>;
}

/**
 * The thing a train occupies: a rail, not a corridor.
 *
 * Must be `rail.BlockSet.key`. Two trains passing in opposite directions on a
 * double-track railway are on different rails and are not a conflict; two
 * services merging onto one rail run through the block the same way, get the
 * same slot, and are.
 */
export function railKey(block: number, slot: number): number {
  return block * 2 + slot;
}

// --- Decoding --------------------------------------------------------------------

/**
 * Where each array starts is derived, not recorded.
 *
 * The bake carries element counts, not byte offsets, and the arrays follow the
 * JSON in one fixed order at eight-byte alignment. Both this and
 * `rail.write_bake` walk the same rule, so there is nothing to keep in sync but
 * the order -- and putting offsets in the JSON would have made the JSON's own
 * length depend on numbers that depend on the JSON's own length.
 */
const BUFFER_ORDER = [
  'vertices', 'cum', 'phases', 'stanchions', 'stanchionKinds', 'vertexFlags',
] as const;

/**
 * What the track a vertex sits on is built as. Must match `rail.SPAN_*`.
 *
 * Carried per vertex rather than left to the geometry round to look up again,
 * and the reason is not convenience: re-deriving it there would mean matching
 * a polyline back onto the OSM extract, and every mismatch puts a tunnel portal
 * somewhere a train does not pass through one.
 */
export const SPAN_TUNNEL = 1;
export const SPAN_BRIDGE = 2;
export const SPAN_CUTTING = 4;
export const SPAN_EMBANKMENT = 8;
export const SPAN_ELECTRIFIED = 16;
export const SPAN_SUBWAY = 32;

function pad8(n: number): number {
  return (8 - (n % 8)) % 8;
}

export function decodeRail(buffer: ArrayBuffer): RailBake {
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== RAIL_MAGIC) {
    throw new Error(`rail.bin: magic is 0x${magic.toString(16)}, expected 0x${RAIL_MAGIC.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== RAIL_VERSION) {
    throw new Error(`rail.bin: version ${version}, this decoder reads ${RAIL_VERSION}`);
  }
  const jsonLen = view.getUint32(8, true);
  const text = new TextDecoder().decode(new Uint8Array(buffer, 16, jsonLen));
  const meta = JSON.parse(text) as Record<string, any>;

  let off = 16 + jsonLen;
  off += pad8(off);
  const arrays: Record<string, ArrayBufferView> = {};
  for (const name of BUFFER_ORDER) {
    const spec = meta.buffers[name] as { count: number; itemBytes: number };
    const bytes = spec.count * spec.itemBytes;
    if (name === 'stanchionKinds') {
      arrays[name] = new Uint8Array(buffer, off, spec.count);
    } else if (name === 'vertexFlags') {
      arrays[name] = new Uint8Array(buffer, off, spec.count);
    } else if (spec.itemBytes === 4) {
      arrays[name] = new Float32Array(buffer, off, spec.count);
    } else {
      arrays[name] = new Float64Array(buffer, off, spec.count);
    }
    off += bytes + pad8(bytes);
  }

  const lines: RailLine[] = [];
  for (const jl of meta.lines as any[]) {
    const line: RailLine = {
      id: jl.id,
      name: jl.name,
      colour: jl.colour,
      metro: !!jl.metro,
      period: jl.period,
      dirs: [],
    };
    for (const jd of jl.dirs as any[]) {
      line.dirs.push({
        index: jd.index,
        label: jd.label,
        offset: jd.offset,
        duration: jd.duration,
        lengthM: jd.lengthM,
        vertexOff: jd.vertexOff,
        vertexCount: jd.vertexCount,
        phaseOff: jd.phaseOff,
        phaseCount: jd.phaseCount,
        minX: jd.minX,
        maxX: jd.maxX,
        minZ: jd.minZ,
        maxZ: jd.maxZ,
        stops: jd.stops,
        arrivals: jd.arrivals,
        blocks: (jd.blocks as number[][]).map((b) => ({
          block: b[0], s0: b[1], s1: b[2], slot: b[3],
        })),
        line,
      });
    }
    lines.push(line);
  }

  return {
    version,
    epochMs: meta.epochMs,
    cycleS: meta.solve?.cycle_s ?? 120,
    lines,
    stations: meta.stations,
    blockLength: Float64Array.from(meta.blocks.length as number[]),
    blockJunction: Uint8Array.from((meta.blocks.junction as boolean[]).map((b) => (b ? 1 : 0))),
    blockTracks: Int32Array.from(meta.blocks.tracks as number[]),
    vertices: arrays.vertices as Float32Array,
    cum: arrays.cum as Float64Array,
    phases: arrays.phases as Float64Array,
    stanchions: arrays.stanchions as Float32Array,
    stanchionKinds: arrays.stanchionKinds as Uint8Array,
    vertexFlags: arrays.vertexFlags as Uint8Array,
    physics: meta.physics,
    notes: meta.notes ?? [],
    degraded: meta.degraded ?? {},
    raw: meta,
  };
}

// --- Where a train is ---------------------------------------------------------------

export interface TrainPose {
  /** World metres. */
  x: number;
  y: number;
  z: number;
  /** Unit heading in the XZ plane, pointing the way the train is going. */
  dx: number;
  dz: number;
  /** Metres per second. Zero during a dwell. */
  speed: number;
  /** Arc length travelled, metres. */
  s: number;
  /** Seconds since this trip departed. */
  age: number;
  /** True while the train is stopped at a platform with its doors open. */
  doorsOpen: boolean;
  /** Index into `dir.stops` of the station it is at, or -1. */
  atStop: number;
  /** Stable identity for this train across the whole of its run. */
  identity: number;
}

export function createTrainPose(): TrainPose {
  return {
    x: 0, y: 0, z: 0, dx: 1, dz: 0, speed: 0, s: 0, age: 0,
    doorsOpen: false, atStop: -1, identity: 0,
  };
}

/**
 * The one arithmetic kernel: arc length and speed at `age` seconds into a trip.
 *
 * The phase table is `(t0, s0, v0, a)` quadruples in strictly increasing `t0`,
 * so this is a binary search and a quadratic. A 15 s dwell is not a state
 * machine -- it is a phase with `v0 = 0` and `a = 0`, so the train is
 * stationary for free, which is `traffic.ts`' red-light trick with a longer
 * timer.
 */
function evalCurve(
  phases: Float64Array, off: number, count: number, age: number,
): { s: number; v: number } {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (phases[(off + mid) * 4] <= age) lo = mid;
    else hi = mid - 1;
  }
  const base = (off + lo) * 4;
  const t0 = phases[base];
  const s0 = phases[base + 1];
  const v0 = phases[base + 2];
  const a = phases[base + 3];
  let dt = age - t0;
  if (dt < 0) dt = 0;
  return { s: s0 + v0 * dt + 0.5 * a * dt * dt, v: v0 + a * dt };
}

/**
 * How long this trip has been stationary at `age` seconds, or 0 while moving.
 *
 * **For the doors, and it adds nothing to `poseTrain`.** A dwell is a phase with
 * `v0 = 0` and `a = 0` -- that is the whole of how a stop is represented here --
 * so "how far into the dwell" is `age` minus that phase's own `t0`, and a door
 * that opens over the first second and a half of a fifteen-second stand needs
 * exactly that number and nothing else.
 *
 * It is a second function rather than a field on `TrainPose` deliberately.
 * `poseTrain` is the function the server and every client agree bit-for-bit on
 * and the one `checkRail` sweeps ten thousand times; the doors are presentation,
 * only the near tier asks, and a pose struct that grew a field for them would
 * put a renderer's needs inside the determinism contract. Pure, allocation-free
 * and the same binary search, so nothing about it can disagree with the pose it
 * is asked alongside.
 */
export function dwellElapsed(bake: RailBake, dir: RailDirection, age: number): number {
  if (age < 0 || age > dir.duration) return 0;
  const phases = bake.phases;
  const off = dir.phaseOff;
  let lo = 0;
  let hi = dir.phaseCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (phases[(off + mid) * 4] <= age) lo = mid;
    else hi = mid - 1;
  }
  const base = (off + lo) * 4;
  if (phases[base + 2] !== 0 || phases[base + 3] !== 0) return 0;
  const dt = age - phases[base];
  return dt > 0 ? dt : 0;
}

/** How many trips of this direction can be running at once. */
export function liveTripCount(dir: RailDirection): number {
  return Math.floor(dir.duration / dir.line.period) + 2;
}

/**
 * Which departure is `j` steps behind the most recent one at time `t`.
 *
 * Trips are numbered by departure, forever, exactly as `traffic.ts` numbers its
 * slots: the index is an integer that grows without bound and is used as an
 * identity, never as an array index.
 */
export function tripIndexAt(dir: RailDirection, t: number, j: number): number {
  return Math.floor((t - dir.offset) / dir.line.period) - j;
}

/**
 * Where arc length `s` along a direction's polyline is, and which way it points.
 *
 * Lifted out of `poseTrain` **unchanged, statement for statement**, and the
 * reason it had to come out is a carriage: a train is eight vehicles over 163 m
 * of a curving, graded railway, and the renderer needs the position of each
 * bogie rather than of one point. Two samples a carriage and the vehicle can be
 * put on the rails properly instead of being hung off a single heading.
 *
 * It writes `x, y, z, dx, dz, s` and touches nothing else on the struct, which
 * is what lets `poseTrain` keep filling in the rest afterwards. The arithmetic
 * is untouched for the reason the file's header gives: two engines handed the
 * same bake and the same `s` must return the same bits, and reordering a single
 * add would be a thing to have to re-prove.
 */
export function sampleAlong(
  bake: RailBake, dir: RailDirection, s: number, out: TrainPose,
): void {
  // Locate `s` along the polyline. The cumulative array is non-decreasing by
  // construction, so this is the same binary search as the phase lookup.
  const c = bake.cum;
  let lo = dir.vertexOff;
  let hi = dir.vertexOff + dir.vertexCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
  const s0 = c[lo];
  const s1 = c[lo + 1];
  const span = s1 - s0;
  const u = span > 0 ? (s - s0) / span : 0;

  const p = bake.vertices;
  const i0 = lo * 3;
  const i1 = (lo + 1) * 3;
  const ax = p[i0];
  const ay = p[i0 + 1];
  const az = p[i0 + 2];
  const bx = p[i1];
  const by = p[i1 + 1];
  const bz = p[i1 + 2];

  out.x = ax + (bx - ax) * u;
  out.y = ay + (by - ay) * u;
  out.z = az + (bz - az) * u;
  let hx = bx - ax;
  let hz = bz - az;
  const d2 = hx * hx + hz * hz;
  if (d2 > 0) {
    const inv = 1 / Math.sqrt(d2);
    hx *= inv;
    hz *= inv;
  } else {
    hx = 1;
    hz = 0;
  }
  out.dx = hx;
  out.dz = hz;
  out.s = s;
}

/**
 * Pose of one trip at one instant. Returns false when that trip is not running.
 *
 * Pure, allocation-free, and the only `Math.sqrt` in the module is the heading
 * normalisation -- which is the same one `poseCar` takes, for the same reason,
 * and is the only root ECMAScript specifies exactly.
 */
export function poseTrain(
  bake: RailBake, dir: RailDirection, trip: number, t: number, out: TrainPose,
): boolean {
  const age = t - dir.offset - trip * dir.line.period;
  if (age < 0 || age > dir.duration || dir.vertexCount < 2) return false;

  const { s, v } = evalCurve(bake.phases, dir.phaseOff, dir.phaseCount, age);

  sampleAlong(bake, dir, s, out);
  out.speed = v;
  out.s = s;
  out.age = age;

  // Doors. A dwell is the only time the curve is stationary away from the ends,
  // so "stopped and not at a terminus" is the whole test -- no separate state,
  // which is the same argument the dwell phase itself rests on.
  out.atStop = -1;
  out.doorsOpen = false;
  if (v === 0 && age > 0 && age < dir.duration) {
    for (let k = 0; k < dir.stops.length; k++) {
      const st = dir.stops[k];
      if (!st.calls) continue;
      const ds = st.s - s;
      if (ds > -40 && ds < 40) {
        out.atStop = k;
        out.doorsOpen = true;
        break;
      }
    }
  }
  out.identity = trainIdentity(dir, trip);
  return true;
}

/**
 * A stable 32-bit name for one train, constant across the whole of its run.
 *
 * `Math.imul`, xor and unsigned shift -- exact 32-bit integer operations, so
 * every process names the same train the same thing. `traffic.ts`' `carHash`
 * with the same argument and the same shape.
 */
export function trainIdentity(dir: RailDirection, trip: number): number {
  let h = 0x9e3779b1;
  for (let i = 0; i < dir.line.id.length; i++) {
    h ^= Math.imul(dir.line.id.charCodeAt(i) | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  h ^= Math.imul((dir.index * 0x10001 + (trip | 0)) | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  return h >>> 0;
}

/**
 * Every train within `radius` of (x, z) at time `t`.
 *
 * Bounding-box rejected per direction before any pose is evaluated, which is
 * what keeps this cheap: a player in the CBD is inside the box of maybe six of
 * the twenty directions and the other fourteen cost one comparison each.
 */
export function trainsNear(
  bake: RailBake,
  x: number,
  z: number,
  radius: number,
  t: number,
  visit: (pose: TrainPose, dir: RailDirection, trip: number) => void,
  pose: TrainPose = createTrainPose(),
): number {
  let found = 0;
  const r2 = radius * radius;
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      if (
        x + radius < dir.minX || x - radius > dir.maxX ||
        z + radius < dir.minZ || z - radius > dir.maxZ
      ) continue;
      const live = liveTripCount(dir);
      for (let j = 0; j <= live; j++) {
        const trip = tripIndexAt(dir, t, j);
        if (!poseTrain(bake, dir, trip, t, pose)) continue;
        const ddx = pose.x - x;
        const ddz = pose.z - z;
        if (ddx * ddx + ddz * ddz > r2) continue;
        found++;
        visit(pose, dir, trip);
      }
    }
  }
  return found;
}

// --- The timetable, read the way a passenger reads it -------------------------------

export interface Arrival {
  line: RailLine;
  dir: RailDirection;
  /** Absolute time, seconds on the rail clock. */
  t: number;
  /** Seconds from now. */
  inSeconds: number;
  /** Where this train is going. */
  towards: string;
  trip: number;
}

/**
 * The next `count` arrivals at a station, soonest first.
 *
 * Every service is periodic, so an arrival is `offset + arrivals[k] + n*period`
 * for integer n and the answer is one `Math.ceil` per calling service rather
 * than a scan. That matters because the HUD asks for it every frame while the
 * player stands on a platform.
 */
export function nextArrivals(
  bake: RailBake, station: string, t: number, count = 4,
): Arrival[] {
  const out: Arrival[] = [];
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      let call = -1;
      for (let k = 0, c = 0; k < dir.stops.length; k++) {
        if (!dir.stops[k].calls) continue;
        if (dir.stops[k].name === station) { call = c; break; }
        c++;
      }
      if (call < 0 || call >= dir.arrivals.length) continue;
      const base = dir.offset + dir.arrivals[call];
      const n = Math.ceil((t - base) / line.period);
      for (let k = 0; k < 2; k++) {
        const at = base + (n + k) * line.period;
        if (at < t) continue;
        out.push({
          line,
          dir,
          t: at,
          inSeconds: at - t,
          towards: dir.stops[dir.stops.length - 1].name,
          trip: n + k,
        });
      }
    }
  }
  out.sort((a, b) => a.t - b.t || a.line.id.localeCompare(b.line.id) || a.dir.index - b.dir.index);
  return out.slice(0, count);
}

/** Which rail (block + slot) this direction is on at arc length `s`, or -1. */
export function railAt(dir: RailDirection, s: number): number {
  const runs = dir.blocks;
  let lo = 0;
  let hi = runs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid].s0 <= s) lo = mid;
    else hi = mid - 1;
  }
  const r = runs[lo];
  if (s < r.s0 || s > r.s1) return -1;
  return railKey(r.block, r.slot);
}

// --- The module's own self-check ---------------------------------------------------

/**
 * Everything about the bake that must be true before anything trusts it.
 *
 * Run by `checkRail` in the integration suite and by the browser at boot, for
 * the reason `verifyWildlife` and `verifyRaves` exist: a self-check nothing runs
 * is a self-check that rots, and the browser is not in CI.
 */
export function verifyRail(bake: RailBake): string[] {
  const bad: string[] = [];
  if (bake.epochMs !== RAIL_EPOCH_MS) {
    bad.push(`the bake counts from ${bake.epochMs} and this module from ${RAIL_EPOCH_MS}`);
  }
  if (bake.lines.length === 0) bad.push('the bake has no lines');
  for (const line of bake.lines) {
    if (line.dirs.length !== 2) bad.push(`${line.id} has ${line.dirs.length} directions, expected 2`);
    if (line.period <= 0) bad.push(`${line.id} has a period of ${line.period} s`);
    for (const dir of line.dirs) {
      if (dir.vertexCount < 2) bad.push(`${line.id} dir ${dir.index} has ${dir.vertexCount} vertices`);
      if (dir.phaseCount < 1) bad.push(`${line.id} dir ${dir.index} has no phases`);
      if (dir.duration <= 0) bad.push(`${line.id} dir ${dir.index} takes ${dir.duration} s`);
      if (dir.offset < 0 || dir.offset >= line.period) {
        bad.push(`${line.id} dir ${dir.index} has phase ${dir.offset} outside [0, ${line.period})`);
      }
      // The curve must reach the end of the polyline and no further. A train
      // past the buffers renders perfectly.
      const end = evalCurve(bake.phases, dir.phaseOff, dir.phaseCount, dir.duration);
      const total = bake.cum[dir.vertexOff + dir.vertexCount - 1];
      if (Math.abs(end.s - total) > 1) {
        bad.push(`${line.id} dir ${dir.index} ends at s=${end.s.toFixed(1)} on a ${total.toFixed(1)} m path`);
      }
      // Cumulative arc length must be non-decreasing, or the binary search in
      // `poseTrain` is meaningless.
      for (let i = dir.vertexOff + 1; i < dir.vertexOff + dir.vertexCount; i++) {
        if (bake.cum[i] < bake.cum[i - 1]) {
          bad.push(`${line.id} dir ${dir.index} has a backwards arc length at vertex ${i - dir.vertexOff}`);
          break;
        }
      }
      // And the phase table must be sorted in time.
      for (let k = 1; k < dir.phaseCount; k++) {
        if (bake.phases[(dir.phaseOff + k) * 4] < bake.phases[(dir.phaseOff + k - 1) * 4]) {
          bad.push(`${line.id} dir ${dir.index} has an out-of-order phase at ${k}`);
          break;
        }
      }
    }
  }
  if (bake.vertexFlags.length * 3 !== bake.vertices.length) {
    bad.push(
      `${bake.vertexFlags.length} vertex flags against ${bake.vertices.length / 3} vertices`,
    );
  }
  if (bake.stanchions.length !== bake.stanchionKinds.length * 5) {
    bad.push(
      `${bake.stanchions.length / 5} stanchion positions against ${bake.stanchionKinds.length} kinds`,
    );
  }
  return bad;
}

/**
 * Re-derive the separation invariant from this decoder, at `hz` over one cycle.
 *
 * Deliberately **not** the algorithm the pipeline used. `rail.py`'s solver
 * reasons about occupancy intervals in closed form and its audit sweeps the
 * clock in numpy; this walks the same clock through `poseTrain` -- the function
 * the game will actually call -- and asks which rail the answer lands on. Three
 * implementations of one invariant, which is the bays/hex precedent.
 */
export function separationSweep(
  bake: RailBake, hz = 10,
): { violations: number; samples: number; closest: number; worst: string } {
  const cycle = bake.cycleS;
  const steps = Math.round(cycle * hz);
  const pose = createTrainPose();
  const rows: { rail: number; t: number; who: number }[] = [];

  for (let k = 0; k < steps; k++) {
    const t = k / hz;
    for (let li = 0; li < bake.lines.length; li++) {
      const line = bake.lines[li];
      for (const dir of line.dirs) {
        const live = liveTripCount(dir);
        for (let j = 0; j <= live; j++) {
          const trip = tripIndexAt(dir, t, j);
          if (!poseTrain(bake, dir, trip, t, pose)) continue;
          const rail = railAt(dir, pose.s);
          if (rail < 0) continue;
          rows.push({
            rail,
            t,
            // A trip's identity for this sweep. `trainIdentity` would do, but a
            // hash can collide and a collision here would hide a violation
            // rather than report one, so this is the tuple itself.
            who: (li * 2 + dir.index) * 1_000_003 + (((trip % 100000) + 100000) % 100000),
          });
        }
      }
    }
  }

  rows.sort((a, b) => a.rail - b.rail || a.t - b.t || a.who - b.who);
  let violations = 0;
  let closest = Infinity;
  let worst = '';
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.rail !== b.rail || a.who === b.who) continue;
    const sep = bake.blockJunction[a.rail >> 1] ? bake.physics.sepJunctionS : bake.physics.sepS;
    const gap = b.t - a.t;
    if (gap < closest) closest = gap;
    if (gap < sep) {
      violations++;
      if (!worst) worst = `rail ${a.rail} (block ${a.rail >> 1}) at t=${a.t.toFixed(1)}s, gap ${gap.toFixed(1)}s < ${sep}s`;
    }
  }
  return {
    violations,
    samples: rows.length,
    closest: closest === Infinity ? 0 : closest,
    worst,
  };
}
