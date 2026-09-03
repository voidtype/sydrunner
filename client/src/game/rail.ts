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

/**
 * Must match `rail.BAKE_VERSION`.
 *
 * 2: the `vertexClearance` buffer, and `station.vertical` derived from the
 * measured clearance rather than from the OSM tags alone. See RAIL-VERTICAL.md.
 * 3: a station is one place. Every record now carries where its trains actually
 * stand (`siteX/siteZ/siteY` and the heading along the platform), the platform
 * decks OSM surveyed with their numbers and their island/side verdict, and the
 * access a body needs to reach the platform -- an entrance, a shaft depth, and
 * the box the platform sits in. `game/riding.StationBoxField` is the reason the
 * last of those exists.
 * 4: the `paving` buffer -- the foot paving near a corridor, as plan strips with
 * no height, so `world/road-deck.RoadDeck` can keep the ground under a footway
 * the way it already keeps it under a carriageway. See `rail.corridor_paving`
 * for why a strip carries no height and `RoadDeck.adoptPaving` for what reads
 * it. Exact, like every version before it: a cached rail.bin from before this
 * would decode as carrying no paving, which is the defect, silently.
 */
export const RAIL_VERSION = 4;

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
  /**
   * Derived at decode, on both ends: the highest calling platform's top at
   * this station, `CONCOURSE_OVER_RAIL_M` over the route's own height at the
   * stop. `siteY` is the *mean* of the anchors, and at North Ryde the two
   * platforms are 0.9 m apart, so a floor at the mean was a 0.44 m kerb onto
   * one and a 0.45 m drop onto the other -- a drop a body cannot climb back.
   * The floor is midway between the calling levels (`deriveConcourse`), and
   * a platform under it is under it. See `riding.concourseY` for who reads it.
   */
  concourseY?: number;
  groundY: number;
  vertical: 'surface' | 'elevated' | 'underground' | 'unknown';
  /**
   * `trackY - groundY`, metres, median over the platform length.
   *
   * `vertical` is *derived* from this (RAIL-VERTICAL.md section 2), so the two
   * can never contradict each other the way Chatswood's `elevated` contradicted
   * its own -6.9 m. `verifyRail` asserts it from this side of the file.
   */
  clearance: number;
  clearanceLo: number;
  clearanceHi: number;
  /** What OSM says is built here: 'tunnel' | 'bridge' | 'open'. */
  structure: string;
  /** Non-empty where the structure and the DEM disagree. Reported, not obeyed. */
  conflict: string;
  kind: string;
  platforms: number;
  tunnelShare: number;
  bridgeShare: number;

  // --- Where the trains actually stand (bake version 3) ----------------------
  //
  // `x, z` above is the OSM station *node*, which is wherever a mapper put a
  // dot -- 126 m from the platform at Central, and at Meadowbank it was the
  // reason two directions became two stations. This is the mean of every
  // calling anchor: the place a station box, a stair or a name board belongs.
  siteX: number;
  siteZ: number;
  siteY: number;
  /** The terrain over the site. `siteY` under this is a station in a hole. */
  siteGroundY: number;
  /** Unit heading of the track at the site. The platform runs along it. */
  siteDx: number;
  siteDz: number;
  /** How far apart the furthest two calling anchors are, metres. */
  siteSpread: number;
  /** How many `samePlatform` rectangles those anchors need. */
  siteFaces: number;
  /** Which directions call here: [0], [1] or [0, 1]. */
  servedDirs: number[];
  lines: string[];

  // --- What is inside the station, from OSM's own `railway=platform` polygons
  faces: RailPlatformFace[];
  /** Every platform number at this station, sorted. */
  refs: number[];
  islands: number;
  sides: number;
  platformLength: number;

  // --- Access, generated from the clearance profile (RAIL-VERTICAL.md §4) ----
  entranceX: number;
  entranceZ: number;
  entranceY: number;
  entranceSource: 'osm' | 'generated' | 'none';
  /** Metres of stair from the street to the platform surface. Positive down. */
  shaftDepth: number;
  /** Is the platform under the ground over it? Then it needs steps, by construction. */
  belowGrade: boolean;
  /** The platform surface, absolute metres: the floor of the station box. */
  boxFloorY: number;
  /** The terrain over it: the lid. */
  boxCeilY: number;
  boxHalfLength: number;
  boxHalfWidth: number;
}

/**
 * One platform deck, as OSM surveyed it.
 *
 * A real position, a real length and the number on the sign at the end of it --
 * `pipeline/sydney/rail._platform_axis` takes the minimum-area rotated
 * rectangle, so the length and heading are the shape that was drawn rather than
 * an axis-aligned box's opinion of it. `refs` has two entries on an island
 * platform (`ref=16;17` is one deck with a face and a number each way), and
 * `island` is measured off the track rather than read off that tagging.
 */
export interface RailPlatformFace {
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
  refs: number[];
  island: boolean;
  level: number | null;
  osmId: string;
}

export interface RailBake {
  version: number;
  epochMs: number;
  cycleS: number;
  lines: RailLine[];
  /**
   * Metres each vertex's train sits to the left of its own travel, per
   * direction vertex. Non-zero only on a **shared** segment -- one the bake
   * runs in both compass directions on one centreline, which is a single OSM
   * way carrying a double-track railway -- and zero within `SHARED_STOP_M` of
   * any calling stop, where the platform was built on the centreline. See
   * `computeLateral`: it is what stops opposite trains passing through each
   * other, which the owner watched happen under the CBD.
   */
  lateral: Float32Array;
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
  /**
   * `trackY - groundY` in metres per polyline vertex, parallel to `vertices`.
   *
   * Positive: a structure holds the track over the terrain, and reaching the
   * platform needs steps up. Negative: the terrain is over the track, and
   * something must be carved or the train renders buried. RAIL-VERTICAL.md's
   * one rule -- this number, and not a discrete class, is what geometry reads,
   * because a class cannot say "the first sixty metres of this platform are on
   * a deck and the rest is in a cutting", which is what Chatswood is.
   */
  vertexClearance: Float32Array;
  /**
   * The foot paving near a corridor, five floats a strip: `ax, az, bx, bz, half`
   * in world metres. **No height, deliberately** -- see `rail.corridor_paving`.
   *
   * `streets.py` draws standalone foot paving and `lanes.py` excludes it from the
   * ways block, so `world/road-deck.RoadDeck` -- which is built from that block --
   * never learned it existed, and the corridor carve took the ground out from
   * under every footway it crossed. This is that footprint, computed from the
   * same OSM extract by the one pass that already knows where the corridors are.
   */
  paving: Float32Array;
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
  'vertexClearance', 'paving',
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
/**
 * Derived at decode, never read from the bake: the track is buried deeper than
 * `DEEP_M` at this vertex by the pipeline's own measurement, whatever OSM
 * tagged the way. RAIL-VERTICAL.md's rule -- *measure the relationship, do not
 * classify it* -- applied to the one classification the carve still trusted.
 * Under Wynyard the ways carry no tunnel tag and the railhead is sixteen
 * metres down, so the carve dug a trench through the CBD and drew the city
 * from beneath. Both readers of a span's flags (`rail-cut.drawnAsTunnel` and
 * `rail-geo`) see this bit, so they agree per segment, which is what the
 * depth-free design was protecting.
 */
export const SPAN_DEEP = 64;
/**
 * Twelve, not eight. Measured over the bake: 360 untagged vertices are more
 * than 8 m under the DEM and 41 more than 12 m. The 8 m set is Newtown's
 * cutting, the Wolli Creek and Chatswood portal approaches and Waverton --
 * real open track that has to stay carved; the 12 m set is portals a few
 * metres late and nothing a player stands beside. Every tagged bore sits
 * deeper than 15 m and carries `SPAN_TUNNEL` anyway.
 */
export const DEEP_M = 12;
export const SPAN_EMBANKMENT = 8;
export const SPAN_ELECTRIFIED = 16;
export const SPAN_SUBWAY = 32;

function pad8(n: number): number {
  return (8 - (n % 8)) % 8;
}

/** The platform's height over the railhead: `rail-solids.PLATFORM_HEIGHT`, restated three-free. */
export const CONCOURSE_OVER_RAIL_M = 1.05;
/** The most a station's two levels are allowed to pull the concourse down from its highest railhead: half of this. */
export const CONCOURSE_SPREAD_MAX_M = 3.6;

/** The route's height at arc length `s` along a direction. */
export function heightAlong(bake: RailBake, dir: RailDirection, s: number): number {
  const c = bake.cum;
  let lo = dir.vertexOff;
  let hi = dir.vertexOff + dir.vertexCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
  const span = c[lo + 1] - c[lo];
  const u = span > 0 ? (s - c[lo]) / span : 0;
  const p = bake.vertices;
  return p[lo * 3 + 1] + (p[(lo + 1) * 3 + 1] - p[lo * 3 + 1]) * u;
}

/** `RailStation.concourseY` for every station with a calling stop. Idempotent. */
export function deriveConcourse(bake: RailBake): void {
  for (const st of bake.stations) {
    let top = -Infinity;
    let low = Infinity;
    for (const line of bake.lines) {
      if (st.lines && st.lines.length && !st.lines.includes(line.name) && !st.lines.includes(line.id)) continue;
      for (const dir of line.dirs) {
        if (st.servedDirs && st.servedDirs.length && !st.servedDirs.includes(dir.index)) continue;
        for (const stop of dir.stops) {
          if (!stop.calls || stop.name !== st.name) continue;
          const y = heightAlong(bake, dir, stop.s);
          if (y > top) top = y;
          if (y < low) low = y;
        }
      }
    }
    // One box, one floor, and Town Hall has two levels 2.7 m apart in it.
    // The floor sits midway between the highest and lowest calling railhead
    // (capped, so a station the bake gave one box and two very different
    // levels does not sink its upper trains out of reach), which keeps every
    // sill within `riding.BOARD_RISE_M` of a body on the concourse.
    if (top > -Infinity) st.concourseY = top - Math.min(top - low, CONCOURSE_SPREAD_MAX_M) / 2 + CONCOURSE_OVER_RAIL_M;
  }
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

  const bake: RailBake = {
    version,
    epochMs: meta.epochMs,
    cycleS: meta.solve?.cycle_s ?? 120,
    lines,
    stations: meta.stations,
    blockLength: Float64Array.from(meta.blocks.length as number[]),
    blockJunction: Uint8Array.from((meta.blocks.junction as boolean[]).map((b) => (b ? 1 : 0))),
    blockTracks: Int32Array.from(meta.blocks.tracks as number[]),
    vertices: arrays.vertices as Float32Array,
    lateral: computeLateral(lines, arrays.vertices as Float32Array, arrays.cum as Float64Array),
    cum: arrays.cum as Float64Array,
    phases: arrays.phases as Float64Array,
    stanchions: arrays.stanchions as Float32Array,
    stanchionKinds: arrays.stanchionKinds as Uint8Array,
    vertexFlags: deepen(arrays.vertexFlags as Uint8Array, arrays.vertexClearance as Float32Array, arrays.vertices as Float32Array, meta.stations as RailStation[]),
    vertexClearance: arrays.vertexClearance as Float32Array,
    paving: arrays.paving as Float32Array,
    physics: meta.physics,
    notes: meta.notes ?? [],
    degraded: meta.degraded ?? {},
    raw: meta,
  };
  deriveConcourse(bake);
  return bake;
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
 * Seconds a train stands at its origin, doors open, before it departs. A
 * caller sweeping trips with `tripIndexAt` starts at `j = -1` to include it.
 */
export const ORIGIN_STAND_S = 45;

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

/** How far a train on a shared segment sits off the centreline, metres. Left-hand running, so half a track pitch. */
export const SHARED_OFFSET_M = 2.0;
/** No offset this close to a calling stop: the platform there was built on the centreline. */
export const SHARED_STOP_M = 110;

/**
 * The lateral offsets: `SHARED_OFFSET_M` on every vertex whose outgoing segment
 * the bake also runs the other way, ramped to zero over the segment before and
 * after (the sampler interpolates between vertices) and held at zero near a
 * calling stop.
 *
 * A segment is keyed by its two endpoints rounded to the half metre, unordered
 * for identity and ordered for orientation; a key seen in both orientations is
 * shared. Every direction of every line is walked, so two lines sharing a
 * trunk agree. Integer keys and a `Map`, no trig, the same on both ends.
 */
/**
 * `SPAN_DEEP` on every vertex the pipeline measured as buried past `DEEP_M`,
 * and on every vertex inside a served underground station's box: a station
 * the bake classed as underground is a bore whatever the depth -- Cherrybrook
 * is a cut-and-cover room nine metres down, shallower than `DEEP_M` -- and a
 * trench drawn through its room is a wall across the concourse. The same
 * rectangle `world/rail-cut.RailCut` declines to carve over.
 */
export function deepen(flags: Uint8Array, clearance: Float32Array, vertices: Float32Array, stations: readonly RailStation[]): Uint8Array {
  const out = new Uint8Array(flags.length);
  const bores = stations.filter(
    (st) => st.vertical === 'underground' && st.belowGrade && st.servedDirs && st.servedDirs.length > 0 &&
      Number.isFinite(st.boxHalfLength) && Number.isFinite(st.boxHalfWidth),
  );
  for (let i = 0; i < flags.length; i++) {
    let deep = clearance[i] < -DEEP_M;
    if (!deep) {
      const x = vertices[i * 3];
      const z = vertices[i * 3 + 2];
      for (const st of bores) {
        const dx = x - st.siteX;
        const dz = z - st.siteZ;
        if (Math.abs(dx * st.siteDx + dz * st.siteDz) > st.boxHalfLength + BORE_APPROACH_M) continue;
        if (Math.abs(dx * -st.siteDz + dz * st.siteDx) > st.boxHalfWidth) continue;
        deep = true;
        break;
      }
    }
    out[i] = flags[i] | (deep ? SPAN_DEEP : 0);
  }
  return out;
}
/** How far past a bore station's box its approach spans count as the bore too; `RailCut` uses the same reach. */
export const BORE_APPROACH_M = 30;

export function computeLateral(lines: readonly RailLine[], vertices: Float32Array, cum: Float64Array): Float32Array {
  const n = vertices.length / 3;
  const lateral = new Float32Array(n);
  // Every segment's midpoint and unit heading, in a metre grid, so a segment
  // can find the ones drawn on top of it whatever way their endpoints were
  // rounded. Two OSM ways for one railway are rarely the same coordinates;
  // they are the same *place*, within a metre, running the other way.
  const CELL = 4;
  const grid = new Map<string, number[]>();
  const mids = new Float64Array(n * 2);
  const heads = new Float64Array(n * 2);
  const owner = new Int32Array(n).fill(-1);
  let segIndex = 0;
  const segs: Array<[number, number]> = []; // [vertex i, direction index]
  lines.forEach((line, li) => {
    line.dirs.forEach((dir, di) => {
      for (let i = dir.vertexOff; i + 1 < dir.vertexOff + dir.vertexCount; i++) {
        const ax = vertices[i * 3], az = vertices[i * 3 + 2];
        const bx = vertices[(i + 1) * 3], bz = vertices[(i + 1) * 3 + 2];
        const dx = bx - ax, dz = bz - az;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (!(len > 1e-6)) continue;
        mids[i * 2] = (ax + bx) / 2;
        mids[i * 2 + 1] = (az + bz) / 2;
        heads[i * 2] = dx / len;
        heads[i * 2 + 1] = dz / len;
        owner[i] = li * 2 + di;
        const key = `${Math.floor(mids[i * 2] / CELL)},${Math.floor(mids[i * 2 + 1] / CELL)}`;
        const list = grid.get(key);
        if (list) list.push(i); else grid.set(key, [i]);
        segs.push([i, li * 2 + di]);
        segIndex++;
      }
    });
  });
  void segIndex;
  const shared = new Uint8Array(n);
  for (const [i] of segs) {
    const mx = mids[i * 2], mz = mids[i * 2 + 1];
    const hx = heads[i * 2], hz = heads[i * 2 + 1];
    const cx = Math.floor(mx / CELL), cz = Math.floor(mz / CELL);
    let hit = false;
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
      for (let gz = cz - 1; gz <= cz + 1 && !hit; gz++) {
        const list = grid.get(`${gx},${gz}`);
        if (!list) continue;
        for (const j of list) {
          if (j === i || owner[j] === owner[i]) continue;
          // The same place, run the other way: within a track's width of each
          // other and antiparallel.
          const ox = mids[j * 2] - mx, oz = mids[j * 2 + 1] - mz;
          if (ox * ox + oz * oz > 1.2 * 1.2) continue;
          if (hx * heads[j * 2] + hz * heads[j * 2 + 1] > -0.9) continue;
          hit = true;
          break;
        }
      }
    }
    if (hit) shared[i] = 1;
  }
  for (const line of lines) {
    for (const dir of line.dirs) {
      const end = dir.vertexOff + dir.vertexCount;
      const nearStop = (i: number): boolean => {
        const s = cum[i];
        for (const st of dir.stops) if (st.calls && Math.abs(st.s - s) < SHARED_STOP_M) return true;
        return false;
      };
      for (let i = dir.vertexOff; i + 1 < end; i++) {
        if (!shared[i]) continue;
        if (nearStop(i) || nearStop(i + 1)) continue;
        lateral[i] = SHARED_OFFSET_M;
        lateral[i + 1] = SHARED_OFFSET_M;
      }
    }
  }
  return lateral;
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
  // Off the centreline on a shared segment: to the left of travel, blended
  // between the two vertices' values. The one deliberate change to the
  // arithmetic above, and it is additive after the heading is fixed, so the
  // heading, the height and the arc length are the bits they always were.
  // Optional on the type because the riding module's own checks hand this a
  // synthetic bake with no offsets, and a check that crashes the boot is a
  // check nobody ran.
  const L = bake.lateral;
  if (L !== undefined) {
    const lat = L[lo] + (L[lo + 1] - L[lo]) * u;
    if (lat !== 0) {
      out.x += -hz * lat;
      out.z += hx * lat;
    }
  }
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
  if (age < -ORIGIN_STAND_S || age > dir.duration || dir.vertexCount < 2) return false;
  // **Standing at the origin before it leaves.** A trip used to begin at the
  // instant of departure, so a terminus -- Bondi Junction, Olympic Park --
  // never had a train with its doors open and nobody could board there
  // (`server/underground-check.ts` found it). For `ORIGIN_STAND_S` before
  // departure the train sits at the first stop, doors open, the same object
  // the departing trip will be.
  if (age < 0) {
    sampleAlong(bake, dir, 0, out);
    out.speed = 0;
    out.s = 0;
    out.age = age;
    out.atStop = -1;
    out.doorsOpen = false;
    for (let k = 0; k < dir.stops.length; k++) {
      const st = dir.stops[k];
      if (!st.calls) continue;
      if (st.s < 40) {
        out.atStop = k;
        out.doorsOpen = true;
      }
      break;
    }
    out.identity = trainIdentity(dir, trip);
    return true;
  }

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
  // --- A train stands at its origin with its doors open before it leaves.
  {
    const pose = createTrainPose();
    let checked = 0;
    for (const line of bake.lines) {
      for (const dir of line.dirs) {
        if (dir.vertexCount < 2 || !dir.stops.length || !dir.stops[0].calls) continue;
        const t = dir.offset + 3 * line.period - 10;
        if (!poseTrain(bake, dir, 3, t, pose)) { bad.push(`${line.name} ${dir.index}: no train stands at the origin ten seconds before departure`); break; }
        if (!pose.doorsOpen || pose.s !== 0) bad.push(`${line.name} ${dir.index}: the standing train has its doors shut or is not at s=0`);
        if (poseTrain(bake, dir, 3, t - ORIGIN_STAND_S, pose)) bad.push(`${line.name} ${dir.index}: a train stands at the origin before its window`);
        checked++;
        break;
      }
      if (checked >= 3) break;
    }
  }
  // --- The buried spans are marked, and every served bore has a concourse.
  {
    let deep = 0;
    let marked = 0;
    for (let i = 0; i < bake.vertexFlags.length; i++) {
      if (bake.vertexClearance[i] < -DEEP_M) deep++;
      if (bake.vertexFlags[i] & SPAN_DEEP) marked++;
    }
    if (deep > 0 && marked < deep) bad.push(`${deep} vertices are buried past ${DEEP_M} m and ${marked} carry SPAN_DEEP; decode marks them`);
    for (const st of bake.stations) {
      if (st.vertical !== 'underground' || !st.belowGrade || !st.servedDirs || st.servedDirs.length === 0) continue;
      if (st.concourseY === undefined || !Number.isFinite(st.concourseY)) bad.push(`${st.name} is a served bore with no concourse height; deriveConcourse found no calling stop`);
    }
  }
  // --- Shared segments: two trains meeting on one centreline are a track
  // apart, and nobody is offset at a platform.
  {
    let shared = 0;
    let judged = 0;
    let apart = 0;
    let atStops = 0;
    const a = createTrainPose();
    const b = createTrainPose();
    for (const line of bake.lines) {
      const [d0, d1] = line.dirs;
      if (!d0 || !d1) continue;
      for (let i = d0.vertexOff; i + 1 < d0.vertexOff + d0.vertexCount; i++) {
        if (bake.lateral[i] === 0 || bake.lateral[i + 1] === 0) continue;
        shared++;
        // The same world point on the other direction's polyline, if it has it.
        const mx = (bake.vertices[i * 3] + bake.vertices[(i + 1) * 3]) / 2;
        const mz = (bake.vertices[i * 3 + 2] + bake.vertices[(i + 1) * 3 + 2]) / 2;
        // The other direction's segment on the same centreline, run the
        // *other* way: a loop line runs both its directions round the loop
        // the same way, and two trains going the same way on one rail are the
        // block solver's problem, not this offset's.
        let best = -1;
        let bestD = 1;
        const hx = bake.vertices[(i + 1) * 3] - bake.vertices[i * 3];
        const hz = bake.vertices[(i + 1) * 3 + 2] - bake.vertices[i * 3 + 2];
        for (let j = d1.vertexOff; j + 1 < d1.vertexOff + d1.vertexCount; j++) {
          const jx = (bake.vertices[j * 3] + bake.vertices[(j + 1) * 3]) / 2;
          const jz = (bake.vertices[j * 3 + 2] + bake.vertices[(j + 1) * 3 + 2]) / 2;
          const d = Math.abs(jx - mx) + Math.abs(jz - mz);
          if (d >= bestD) continue;
          const kx = bake.vertices[(j + 1) * 3] - bake.vertices[j * 3];
          const kz = bake.vertices[(j + 1) * 3 + 2] - bake.vertices[j * 3 + 2];
          if (hx * kx + hz * kz >= 0) continue;
          bestD = d;
          best = j;
        }
        if (best < 0) continue;
        judged++;
        sampleAlong(bake, d0, (bake.cum[i] + bake.cum[i + 1]) / 2, a);
        sampleAlong(bake, d1, (bake.cum[best] + bake.cum[best + 1]) / 2, b);
        const gap = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
        if (gap >= 2 * SHARED_OFFSET_M - 0.2) apart++;
        if (shared > 400) break;
      }
      // And at every calling stop, no offset: the platform is on the centreline.
      for (const dir of line.dirs) {
        for (const st of dir.stops) {
          if (!st.calls) continue;
          const c = bake.cum;
          let k = dir.vertexOff;
          while (k + 1 < dir.vertexOff + dir.vertexCount && c[k + 1] <= st.s) k++;
          if (bake.lateral[k] !== 0 || bake.lateral[Math.min(k + 1, dir.vertexOff + dir.vertexCount - 1)] !== 0) atStops++;
        }
      }
    }
    if (atStops > 0) bad.push(`${atStops} calling stops sit on an offset segment; the platform there is on the centreline`);
    if (judged > 0 && apart < judged * 0.9) {
      bad.push(`on ${judged} of ${shared} shared segments met head-on only ${apart} keep the two directions a track apart`);
    }
  }
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
  if (bake.vertexClearance.length * 3 !== bake.vertices.length) {
    bad.push(
      `${bake.vertexClearance.length} vertex clearances against ${bake.vertices.length / 3} vertices`,
    );
  }
  if (bake.stanchions.length !== bake.stanchionKinds.length * 5) {
    bad.push(
      `${bake.stanchions.length / 5} stanchion positions against ${bake.stanchionKinds.length} kinds`,
    );
  }
  // Five floats a strip, and **more than none of them**. An empty paving buffer
  // decodes cleanly and reads as "this city has no footway anywhere near a
  // railway", which is the shipped defect wearing the new format's clothes --
  // `rail.corridor_paving` returns exactly that when it is run with no roads.
  if (bake.paving.length % 5 !== 0) {
    bad.push(`${bake.paving.length} paving floats is not a whole number of 5-float strips`);
  } else if (bake.paving.length === 0) {
    bad.push('the bake carries no corridor paving at all; see rail.corridor_paving');
  }
  // RAIL-VERTICAL.md section 2, re-derived from the third reader. `elevated` is
  // the claim that a structure holds the track over the ground; a station whose
  // measured clearance is negative makes the opposite claim in the same record,
  // and Chatswood shipped exactly that -- `elevated` with the track 6.9 m under
  // the terrain grid, which then told the cutting carve not to dig.
  for (const st of bake.stations) {
    if (st.vertical === 'elevated' && !(st.clearance > 0)) {
      bad.push(`${st.name} is classed elevated with a measured clearance of ${st.clearance} m`);
    }
  }
  // --- A station is one place, re-derived from this side of the file.
  //
  // `rail.split_stations` asserts the same thing in Python and `checkRail` runs
  // this; two readers, no shared code, which is the rule TRAINS.md set for the
  // separation proof and which applies here for the same reason. The shipped
  // bake had 184 of 190 served station names resolving to more than one
  // platform site and nothing on either end ever said so.
  for (const st of bake.stations) {
    if (!st.servedDirs || st.servedDirs.length === 0) continue;
    if (st.servedDirs.length < 2) {
      bad.push(
        `${st.name} is served in ${st.servedDirs.length} direction of two -- ` +
        `a station is one place with a train each way`,
      );
    }
    // 160 m is `riding.PLATFORM_HALF_LENGTH_M` doubled: the length of the
    // platform that would have to hold every one of those services at once.
    // Lidcombe's Olympic Park bay is a real second place and is the one name
    // the pipeline excepts; 240 m leaves it alone and still catches
    // Meadowbank's 471 m.
    if (st.siteSpread > 240) {
      bad.push(
        `${st.name}'s calling services stand ${st.siteSpread.toFixed(0)} m apart, ` +
        `which is two stations under one name`,
      );
    }
    // The box has to contain the platform it is a box around, or a body inside
    // it is standing on a floor that is not there.
    if (st.belowGrade && !(st.boxCeilY > st.boxFloorY)) {
      bad.push(
        `${st.name} is below grade with its box lid at ${st.boxCeilY} m and its floor at ` +
        `${st.boxFloorY} m, which is inside out`,
      );
    }
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
