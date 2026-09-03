/**
 * People walking the footpaths.
 *
 * The user asked to "make some passive npcs that just walk around". This is the
 * rules half of that -- where a pedestrian is at a given instant, what they look
 * like, and what happens when you hit one. `world/people.ts` is the half that
 * draws them.
 *
 * ---------------------------------------------------------------------------
 * A PEDESTRIAN IS A LOOKUP, NOT A SIMULATION. Same design as the traffic, on
 * purpose, and the same three consequences.
 *
 * Nothing here is stepped. There is no velocity, no steering, no state that
 * survives a frame and no crowd. A walker's position is a pure function:
 *
 *     position(tick) = the point `speed * u` along footpath band B
 *
 * where `u` is where this walker is in its own repeating trip, and every term of
 * it comes out of an integer hash of `(way, side, slot)`. So:
 *
 *   1. **Zero bandwidth.** `net/protocol.ts` gained not one byte for this. Every
 *      client in a match watches the same people cross the same corners, because
 *      every client evaluates the same function of the same wall clock over the
 *      same `.lanes.bin` bytes.
 *   2. **Zero server cost.** The server does not tick a single pedestrian, and
 *      does not have to: when the police pass arrives and a ped-hit becomes a
 *      crime, the server can re-evaluate the identical function at the identical
 *      tick and agree about who was standing where without anything having been
 *      sent to it. See `onPedestrianStruck` at the foot of this file, which is
 *      the seam that pass subscribes to.
 *   3. **A struck ped can get back up without any bookkeeping.** Because
 *      `posePedestrian` is stateless, "resume the schedule" is a time offset --
 *      see `PedDown`.
 *
 * The determinism rules are `game/footy.ts`'s, restated by `game/traffic.ts`,
 * and this file obeys them exactly: integer `Math.imul` hashes, no `Math.sin`,
 * `Math.cos`, `Math.pow` or `Math.hypot` anywhere on the shared path, and
 * `Math.sqrt` -- which IEEE-754 specifies exactly -- only at band *build* time.
 * The browser's V8 and Bun's JavaScriptCore differ in the last place on the
 * transcendentals; `server/integration-check.ts`'s `checkPedestrians` asserts
 * the whole of this bit for bit over ten thousand ticks.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE FOOTPATHS COME FROM. THIS FILE ADDS NO GEOMETRY TO THE PIPELINE.
 *
 * `pipeline/sydney/tiles.write_lanes` emits a **ways block** beside the traffic
 * timetable -- the drivable network as reusable geometry, with the solved
 * ground height, the kerb-to-kerb half width and the footpath band width -- and
 * says in as many words that it exists so that a pass which wants people walking
 * the footpaths can derive them as
 *
 *     centreline +/- (halfWidth + KERB_WIDTH + footpathWidth / 2)
 *
 * rather than re-traversing the same OSM ways with a second set of width
 * constants that can drift from `streets.py`. That is what `buildBands` does,
 * through `traffic.decodeLanes` -- the same decoder, not a fork of it -- and it
 * is the entire source of pedestrian geometry in this project. The three width
 * and height constants below are `streets.py`'s own, and `index.json`'s `lanes`
 * block carries them so `verifyPedestrians` can assert the two have not drifted.
 *
 * **The sign is the thing that fails silently.** A band on the wrong side of the
 * kerb is people walking up the middle of Cleveland Street, which renders
 * perfectly and is invisible to any check that only asks whether pedestrians are
 * near roads. So `verifyPedestrians` asserts, against a synthetic way through
 * the real encoder, that every walker's perpendicular offset from the centreline
 * exceeds `halfWidth + KERB_WIDTH` -- that is, that they are standing on the
 * concrete and not on the asphalt -- and that the two bands of a two-way street
 * land on opposite sides of it.
 *
 * ---------------------------------------------------------------------------
 * PEDESTRIANS DO NOT CROSS ROADS, AND DO NOT INTERACT WITH THE TRAFFIC.
 *
 * A walker's band is one side of one way span, end to end. It never leaves the
 * footpath, so there is no crossing logic, no kerb decision and no reason for a
 * car to know this file exists. Where a band and a car route clip a corner, they
 * clip it -- the cars are trams on rails (`game/traffic.ts` says so) and at this
 * density nobody will ever see it happen.
 *
 * What a walker does at the end of its band is **stop existing for a few
 * seconds and then walk back**, which is the despawn/respawn churn rather than a
 * turn onto a connected footpath. Routing the continuation would need a
 * cross-tile adjacency graph that cannot be complete while the world is
 * streaming -- the next span is routinely in a tile that is not resident -- and
 * it buys nothing visible: way spans are whole OSM ways clipped to a tile, so
 * they are long, they butt end to end along a street, and a street reads as
 * continuous foot traffic because the *next* span has its own walkers on it.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS THE TRAFFIC'S CLOCK. Deliberately the same one.
 *
 * `traffic.trafficTick` is wall time since a fixed epoch, for the two reasons
 * its header gives -- the simulation tick is private to `net/client.ts` and it
 * restarts at zero on a deploy. Reusing it rather than declaring a second epoch
 * means the city has one clock: the cars and the people are in step, and there
 * is exactly one number in `index.json` that can be wrong.
 */

import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  CAST_RADIUS,
  REACH,
  segmentDistance,
  type CombatantState,
} from './combat.ts';
import {
  LANE_CLASSES,
  LANES_VERSION,
  carHash,
  decodeLanes,
  insertSorted,
  nextQueryStamp,
  removeSorted,
  trafficSeconds,
  type LaneWay,
  type TileLanes,
} from './traffic.ts';
import { UNIFORM_CROWD, crowdMultiplier } from './density.ts';

// --- The pipeline's own numbers ------------------------------------------------

/**
 * The exposed top of the kerb in plan, metres. `streets.KERB_WIDTH`.
 *
 * Restated rather than imported because the pipeline is Python. `index.json`'s
 * `lanes` block carries the build's own value and `verifyPedestrians` is handed
 * it, which is the same arrangement `verifyTraffic` has for the clock and exists
 * for the same reason: a world baked with a different kerb would put every
 * pedestrian in Sydney a few centimetres into the road, which renders perfectly.
 */
export const KERB_WIDTH = 0.15;

/** Footpath surface clearance over the terrain. `streets.FOOTPATH_Y`. */
export const FOOTPATH_Y = 0.15;

/** Carriageway clearance over the terrain. `streets.CARRIAGEWAY_Y`. */
export const CARRIAGEWAY_Y = 0.02;

/**
 * How far a footpath stands above the running surface the ways block's `y` is on.
 *
 * The ways block carries the *road's* solved height -- `write_lanes` says so and
 * a bridge deck is why it is absolute rather than tile-local -- and a footpath is
 * 13 cm higher than the asphalt beside it. Thirteen centimetres is under the
 * controller's 0.42 m step, so this is cosmetic and it is still worth having:
 * without it every pedestrian in the city stands with their soles level with the
 * road they are walking beside, which reads as people wading down the gutter.
 */
export const FOOTPATH_LIFT = FOOTPATH_Y - CARRIAGEWAY_Y;

// --- What a walker is ----------------------------------------------------------

/**
 * Walking pace, m/s. A comfortable Australian footpath speed and a small spread.
 *
 * 1.15 to 1.55 rather than a single number, and the spread is doing real work at
 * two scales: within a band it is what stops six people moving as a rigid block,
 * and across the city it is what makes the *arrival* of people at a corner
 * irregular. It is also below the rig's own `walk`/`run` crossover of 6 m/s by a
 * wide margin, so `CharacterActor` derives the walk clip with no pinning at all.
 */
export const WALK_SPEED_MIN = 1.15;
export const WALK_SPEED_SPAN = 0.4;

/**
 * The gap between one traversal of a band and the next, seconds.
 *
 * This is the despawn/respawn window, and it is what makes the population churn
 * rather than being a fixed cast walking laps forever. Long enough that the
 * disappearance happens off the end of the band where nobody is looking, short
 * enough that a street is never empty.
 */
const DWELL_MIN = 4;
const DWELL_SPAN = 16;

/**
 * Slots per metre of footpath band, indexed by the class byte in `.lanes.bin`.
 *
 * **Must be `LANE_CLASSES.length` long**, in that order. A slot is a walker who
 * exists for `trip / (trip + dwell)` of the time, so the *present* count on a
 * band is a little under its slot count -- see `posePedestrian`.
 *
 * Two decisions in this table rather than one.
 *
 * **Nobody strolls the Western Distributor.** Every motorway and every link ramp
 * is zero. The pipeline already agrees -- `streets.FOOTPATH_WIDTH` gives those
 * classes a 0 m band, so `buildBands` would reject them anyway -- and it is
 * stated twice on purpose, because the two tables are in different languages and
 * the failure is a person walking the shoulder of the Eastern Distributor.
 *
 * **The class byte is the retail signal.** The brief allowed for a cheap "denser
 * near the shops" input and there is one already in the data: in inner Sydney
 * the retail strips *are* the classified roads. King Street, Oxford Street,
 * Glebe Point Road, Crown Street and George Street are primary or secondary; the
 * streets behind them are residential. So weighting by class puts the crowd on
 * the strip and leaves the terraces quiet without needing the awning or cafe
 * data, neither of which reaches the client in a form this could read.
 *
 * The numbers themselves are set to land at the brief's "lively, not crowded":
 * order 10-25 people visible inside 120 m in the inner suburbs. At the CBD's
 * street density that radius holds about 1.8 km of band, which at the
 * residential 0.011 is 20 slots and about 17 present. `verifyPedestrians`
 * asserts the arithmetic against a synthetic grid and `checkPedestrians` reports
 * the real figure off the built world.
 */
export const SLOT_DENSITY: readonly number[] = [
  0,      // motorway
  0,      // motorway_link
  0.014,  // trunk
  0,      // trunk_link
  0.018,  // primary        -- Oxford St, George St: the busiest footpaths here
  0,      // primary_link
  0.016,  // secondary      -- King St, Glebe Point Rd
  0,      // secondary_link
  0.014,  // tertiary
  0,      // tertiary_link
  0.011,  // residential    -- the baseline the numbers above are multiples of
  0.011,  // unclassified
  0.014,  // living_street  -- shared zones are pedestrian by design
  0.005,  // service        -- laneways and driveways: somebody, occasionally
  0.008,  // other
];

/**
 * A band shorter than this carries nobody, metres.
 *
 * A way span is a whole OSM way clipped to a tile, so most are long -- but a
 * sliver where a way clips the corner of a tile is a few metres of concrete, and
 * a figure shuffling back and forth along four metres of it every twenty seconds
 * is the single most obviously artificial thing this feature could produce.
 */
export const MIN_BAND_M = 16;

/**
 * A footpath narrower than this gets one band, on the left of the way's
 * direction, rather than two.
 *
 * `streets.FOOTPATH_WIDTH` gives a `service` way 1.5 m and a `living_street`
 * 2.5 m, against the 3.0 m default. A metre and a half is a strip beside a
 * laneway, not a footpath on both sides of one, and two files of people passing
 * each other down a Surry Hills back lane reads as a bug. Gated on the *width*
 * rather than on `oneway`, because a one-way street in the CBD is an ordinary
 * street with ordinary footpaths on both sides of it.
 */
export const NARROW_FOOTPATH_M = 2.0;

/** How many kits a walker can be wearing. Must match `character.COLOURWAYS.length`. */
export const PEDESTRIAN_KIT_COUNT = 7;

/**
 * How long a clobbered pedestrian stays down, seconds -- the range, hashed per
 * hit so two people struck a second apart do not get up in unison.
 */
export const DOWN_MIN = 1.5;
export const DOWN_SPAN = 1.0;

// --- Being launched, and being killed ---------------------------------------------
//
// The owner: *"add simple physics for cars and ppl"* and *"add actual death
// mechanics for npc like hitting them at max car speed ... make em gib"*. A
// knockdown used to be a body dropping where it stood, at any speed. Now a
// car's hit carries its velocity into the record, the body flies with it --
// a ballistic hop and a slide that stops inside `LAUNCH_SECONDS` -- and past
// `GIB_SPEED` the walker is not knocked down but killed: the record lasts
// `DEAD_SECONDS`, and `world/people.ts` draws the six parts of the figure
// leaving in six directions rather than one body. All of it is arithmetic on
// the record the two ends already share, so the flight is the same on every
// screen and the police pass counts a corpse exactly as it counted a body.

/** The whole of a launched body's flight and slide, seconds. */
export const LAUNCH_SECONDS = 1.1;
/** The body's launch speed as a fraction of the car's: a 60 km/h hit throws you at 9 m/s. */
export const LAUNCH_SCALE = 0.55;
/** The vertical share of the launch, and its cap, m/s. */
export const LAUNCH_UP = 0.35;
export const LAUNCH_UP_MAX = 5;
/** Hit at this or faster, m/s, and the walker is killed rather than knocked down. 20 m/s is 72 km/h. */
export const GIB_SPEED = 20;
/** How long a killed walker is gone, seconds. Fifteen minutes: the street forgets before the player does. */
export const DEAD_SECONDS = 900;
/** How long the parts of a gibbed figure stay on the ground, seconds. */
export const GIB_SECONDS = 8;
const GRAVITY = 9.8;

// --- Decoded shapes ------------------------------------------------------------

/**
 * One side of one way span: the strip of concrete people actually walk on.
 *
 * Structure of arrays, and everything the runtime needs is precomputed here so
 * that `posePedestrian` is a binary search and two lerps. In particular the
 * per-segment unit direction is stored, which takes the only `Math.sqrt` in this
 * feature off the per-frame path entirely -- a band is built once when its tile
 * arrives and read a few hundred times a second thereafter.
 */
export interface PedBand {
  /** OSM way id, truncated to 32 bits by the pipeline. Zero when unknown. */
  osmId: number;
  /** 0 walks on the left of the way's direction of travel, 1 on the right. */
  side: number;
  /** Index into `LANE_CLASSES`. */
  klass: number;
  /** The hash seed every walker on this band comes out of. See `bandSeed`. */
  seed: number;
  count: number;
  /** World metres. `y` is absolute and already on the footpath surface. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Cumulative arc length to each point. `s[0]` is 0; `s[count-1]` is `length`. */
  s: Float32Array;
  /** Per-segment unit plan direction, `count - 1` long. */
  ux: Float32Array;
  uz: Float32Array;
  length: number;
  /**
   * How many walkers this band schedules. See `SLOT_DENSITY`.
   *
   * **May be zero, and a zero-slot band is still a band.** See `buildBand`: a
   * footpath in Dural is a footpath that nobody happens to be walking on, and
   * every consumer that reads this field to mean "is there a footpath here" --
   * the police lattice, the drunks outside a pub, the wildlife nests -- has to
   * keep seeing it. Only `forEachPedestrianNear` and the walker count care about
   * the number itself, and both handle zero by iterating nothing.
   */
  slots: number;
  /** Plan bounds, for the broadphase. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;

  /**
   * WORKSTREAM AB: scratch for `near`'s dedupe. Not data; see `near`.
   *
   * A band spans several broadphase cells, so the same one arrives from more
   * than one bucket and has to be dropped on the second sighting. That used to
   * be `out.indexOf`, which is quadratic in the answer's length: measured on a
   * CBD street, `near(x, z, 200)` returned 82 bands in 16.5 us and
   * `near(x, z, 320)` returned 180 in 80.5 us -- five times the work for twice
   * the bands. Stamping each
   * candidate with the id of the query that has already decided about it makes
   * the whole pass linear and produces the identical list in the identical
   * order -- first-encounter order either way.
   *
   * Set by `near` and read by nothing else. It is a number rather than a
   * boolean so it never has to be cleared: the next query has a different id.
   */
  mark: number;
}

/** Where one pedestrian is, and what they look like. Reused; never allocated per frame. */
export interface PedPose {
  /** Stable identity across tiles, evictions and processes. See `pedKey`. */
  key: number;
  osmId: number;
  side: number;
  slot: number;
  x: number;
  y: number;
  z: number;
  /** Unit heading in the world plan. */
  dx: number;
  dz: number;
  /** Index into `character.COLOURWAYS`. */
  kit: number;
  /** This walker's own pace, m/s. */
  speed: number;
  /** Metres walked on this traversal. Drives the impostor's stride phase. */
  along: number;
  /** True while this one is lying on the footpath. See `PedDown`. */
  down: boolean;
  /** Seconds since they went down, or 0. */
  downT: number;
  /** Seconds until they get up, or 0. */
  downLeft: number;
  /** The launch this body is flying or flew on, m/s. Zero for a plain knockdown. */
  vx: number;
  vz: number;
  /** Killed: the renderer draws parts, not a body. See `GIB_SPEED`. */
  gib: boolean;
}

export function createPedPose(): PedPose {
  return {
    key: 0, osmId: 0, side: 0, slot: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    kit: 0, speed: 0, along: 0, down: false, downT: 0, downLeft: 0,
    vx: 0, vz: 0, gib: false,
  };
}

/**
 * Where a launched body is, `t` seconds after the hit, relative to where it
 * stood: a hop under gravity and a slide that decelerates to rest at
 * `LAUNCH_SECONDS`. Pure arithmetic, no root, so both ends and every renderer
 * agree to the bit. Writes into `out` as [dx, dy, dz].
 */
export function launchOffset(vx: number, vz: number, t: number, out: Float64Array): void {
  const T = LAUNCH_SECONDS;
  const tt = t < 0 ? 0 : t > T ? T : t;
  // Distance under constant deceleration from v to 0 over T: v t - v t^2 / 2T.
  const k = tt - (tt * tt) / (2 * T);
  out[0] = vx * k;
  out[2] = vz * k;
  const speed2 = vx * vx + vz * vz;
  // The vertical share, capped; `Math.sqrt` is exact and allowed.
  let up = LAUNCH_UP * Math.sqrt(speed2);
  if (up > LAUNCH_UP_MAX) up = LAUNCH_UP_MAX;
  const y = up * tt - 0.5 * GRAVITY * tt * tt;
  out[1] = y > 0 ? y : 0;
}

const _launch = new Float64Array(3);

/**
 * One pedestrian who has been knocked over, and the whole of how they get back up.
 *
 * `offset` is the trick, and it is only possible because `posePedestrian` is
 * stateless. A walker is normally evaluated at `now`; a walker who has been
 * clobbered is evaluated at `now - offset`, and every knock adds its own downtime
 * to that offset. So at the exact instant they stand up,
 *
 *     now - offset = (struck + down) - (offsetBefore + down) = struck - offsetBefore
 *
 * which is the schedule time they were hit at -- they get up precisely where they
 * fell, facing the way they were going, and walk on. There is no re-attachment,
 * no path to re-plan and nothing to store but one number. While they are down
 * the pose is pinned at `frozen`, because the offset arithmetic runs the schedule
 * *backwards* through the down window and a ped who moonwalked while unconscious
 * would be a very odd thing to ship.
 */
export interface PedDown {
  /** Schedule time the hit landed at -- the pinned pose while they are down. */
  frozen: number;
  /** Wall-clock schedule seconds at which they stand up. */
  upAt: number;
  /** How long this knock puts them down for. `downSeconds(key, tick)`, or `DEAD_SECONDS`. */
  seconds: number;
  /** Total seconds this walker has ever spent on the ground. */
  offset: number;
  /** The launch, m/s in the plan. Zero for a bat, a ball or a slow car. See `LAUNCH_SECONDS`. */
  vx: number;
  vz: number;
  /** Killed rather than knocked down. See `GIB_SPEED`. */
  gib: boolean;
  /** The tick of the most recent hit. A hash input, and the police pass's cause. */
  tick: number;
  /** Where they were standing. Read only by `forgetDistant`; see there. */
  x: number;
  z: number;
}

// --- Building the bands --------------------------------------------------------

/**
 * The seed every walker on a band comes out of.
 *
 * Not the OSM id alone, and the reason is a real case rather than paranoia: one
 * OSM way crossing four tiles is written as four spans carrying the *same* id,
 * and a way with no id at all is written as zero. Either would give two bands
 * identical walker identities. Mixing in the band's own first point separates
 * them, and does it identically in every process, because the coordinate is an
 * f32 out of the same bytes and the quantisation is exact integer arithmetic.
 */
function bandSeed(osmId: number, side: number, x0: number, z0: number): number {
  const qx = Math.round(x0 * 4) | 0;
  const qz = Math.round(z0 * 4) | 0;
  return carHash(carHash(osmId, qx ^ ((qz << 8) | 0)), side);
}

/**
 * A walker's identity, stable across tile evictions, rebuilds and processes.
 *
 * Packed rather than a string because it is a `Map` key on the hot path and it
 * has to survive being compared millions of times. `osmId` is 32 bits, `side` is
 * one and `slot` fits in six -- `MAX_SLOTS` is 40 -- so the whole thing is 39
 * bits and exact in a double, with two orders of magnitude of headroom under
 * 2^53. A string key would allocate on every lookup.
 *
 * Two spans of one OSM way in different tiles collide here, and that is
 * deliberate: they are different bands with different lengths and different
 * geometry, so the pair never occupy the same footpath -- and the collision only
 * matters for the down registry, where the cost of one is that clobbering
 * somebody in Redfern would stand somebody else up in Alexandria a second early.
 * Widening the key to carry the band's seed would cost the exactness above for
 * that.
 */
export function pedKey(osmId: number, side: number, slot: number): number {
  return (osmId * 2 + side) * 64 + slot;
}

/** Hard ceiling on the walkers one band schedules. See `MAX_SLOTS`' use in `pedKey`. */
export const MAX_SLOTS = 40;

/**
 * Turn one tile's ways block into footpath bands.
 *
 * The whole of the pipeline contract lives in the eight lines that compute
 * `offset`, and the sign of it is asserted from the other end by
 * `verifyPedestrians`. Interior vertices are offset along the *average* of the
 * two adjacent segment directions, which is `lanes._offset_left`'s own rule and
 * is here for the same reason: a true offset blows up at a hairpin, and averaging
 * keeps the band continuous through a bend at the cost of narrowing it very
 * slightly on the inside of a tight corner.
 */
export function buildBands(
  tile: TileLanes,
  /**
   * How busy this part of Sydney is. Defaulted; every caller outside a
   * self-check takes the default. See `density.UNIFORM_CROWD`.
   */
  crowd: (x: number, z: number) => number = crowdMultiplier,
): PedBand[] {
  const out: PedBand[] = [];
  for (const way of tile.ways) {
    if (!(way.footpathWidth > 0)) continue;
    const base = SLOT_DENSITY[way.klass] ?? 0;
    if (!(base > 0)) continue;
    // How busy this part of Sydney is, from the census. One grid read per way,
    // at tile-decode time, and it is the same read on the client and on the
    // server because `game/density.ts` is a pure function of a baked table --
    // see that module's header for why the scaling lives here rather than in
    // the bake. The way's middle vertex is the sample point: a way span is
    // clipped to a 500 m tile, so any vertex on it is inside the same cell or
    // its neighbour, and the field is interpolated anyway.
    const density = base * crowd(way.x[way.count >> 1], way.z[way.count >> 1]);
    // One band or two. See `NARROW_FOOTPATH_M`.
    const sides = way.footpathWidth < NARROW_FOOTPATH_M ? 1 : 2;
    const offset = way.halfWidth + KERB_WIDTH + way.footpathWidth * 0.5;
    for (let side = 0; side < sides; side++) {
      const band = buildBand(way, side, offset, density);
      if (band !== null) out.push(band);
    }
  }
  return out;
}

/** Scratch for the averaged vertex directions. Grown, never shrunk; build-time only. */
let dirX = new Float64Array(64);
let dirZ = new Float64Array(64);

function buildBand(way: LaneWay, side: number, offset: number, density: number): PedBand | null {
  const n = way.count;
  if (n < 2) return null;
  if (dirX.length < n) {
    dirX = new Float64Array(n * 2);
    dirZ = new Float64Array(n * 2);
  }

  // Per-segment unit directions first, then the per-vertex average.
  for (let i = 0; i + 1 < n; i++) {
    const sx = way.x[i + 1] - way.x[i];
    const sz = way.z[i + 1] - way.z[i];
    const d2 = sx * sx + sz * sz;
    if (d2 < 1e-12) {
      // A repeated vertex. Carry the previous direction rather than dividing by
      // zero; the first segment falls back to +X, which cannot happen on a way
      // the pipeline emitted and would otherwise be a NaN band.
      dirX[i] = i > 0 ? dirX[i - 1] : 1;
      dirZ[i] = i > 0 ? dirZ[i - 1] : 0;
      continue;
    }
    const inv = 1 / Math.sqrt(d2);
    dirX[i] = sx * inv;
    dirZ[i] = sz * inv;
  }

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  // Sign: side 0 walks on the LEFT of the way's direction of travel, and left of
  // a heading (dx, dz) in renderer axes is (dz, -dx) -- the same statement
  // `traffic.carOverlaps` makes and the one `lanes._offset_left` makes in ENU.
  // Side 1 is the other one. `verifyPedestrians` asserts both from a synthetic
  // due-north way whose left is due west.
  const sign = side === 0 ? offset : -offset;
  for (let i = 0; i < n; i++) {
    let ax: number;
    let az: number;
    if (i === 0) {
      ax = dirX[0];
      az = dirZ[0];
    } else if (i === n - 1) {
      ax = dirX[n - 2];
      az = dirZ[n - 2];
    } else {
      ax = dirX[i - 1] + dirX[i];
      az = dirZ[i - 1] + dirZ[i];
      const m2 = ax * ax + az * az;
      // A perfect hairpin averages to nothing; keep the incoming direction.
      if (m2 < 1e-12) {
        ax = dirX[i - 1];
        az = dirZ[i - 1];
      } else {
        const inv = 1 / Math.sqrt(m2);
        ax *= inv;
        az *= inv;
      }
    }
    x[i] = way.x[i] + az * sign;
    z[i] = way.z[i] - ax * sign;
    // The footpath is 13 cm over the asphalt the ways block's height is on.
    y[i] = way.y[i] + FOOTPATH_LIFT;
  }

  // Arc length and the band's own segment directions, taken from the *offset*
  // polyline rather than from the centreline's -- on a bend the two differ, and
  // a walker facing along the road's direction while travelling along the
  // footpath's would be visibly skating through the corner.
  const s = new Float32Array(n);
  const ux = new Float32Array(n - 1);
  const uz = new Float32Array(n - 1);
  let total = 0;
  for (let i = 0; i + 1 < n; i++) {
    const sx = x[i + 1] - x[i];
    const sz = z[i + 1] - z[i];
    const d2 = sx * sx + sz * sz;
    if (d2 < 1e-12) {
      ux[i] = i > 0 ? ux[i - 1] : 1;
      uz[i] = i > 0 ? uz[i - 1] : 0;
    } else {
      const inv = 1 / Math.sqrt(d2);
      ux[i] = sx * inv;
      uz[i] = sz * inv;
      total += Math.sqrt(d2);
    }
    s[i + 1] = total;
  }
  if (!(total >= MIN_BAND_M)) return null;

  const seed = bandSeed(way.osmId, side, x[0], z[0]);
  // Rounded **stochastically**, on the band's own seed, rather than to nearest.
  //
  // Before `density.ts` this was `floor(want + 0.5)` and the arithmetic never
  // came near a half: the residential rate over a 300 m band is 3.3 slots, and
  // whether that lands on 3 is a detail. Once the census multiplier is in it,
  // Dural's residential bands want 0.17 of a walker each, and to-nearest turns
  // every one of them into exactly zero -- so the suburb is not quiet, it is
  // *sterile*, which is a worse lie and the one the brief is actually
  // complaining about in the other direction. Carrying the fraction as a
  // probability puts one walker on about one Dural band in six and leaves the
  // expected density exactly where the multiplier put it.
  //
  // The draw is `unit(carHash(seed, ...))`, so it is a pure function of the
  // band and the client and the server agree about which bands got the walker
  // without exchanging anything -- the same property `bandSeed` exists for.
  const want = total * density;
  let slots = Math.floor(want + unit(carHash(seed, 0x5107)));
  // **A band with nobody on it is still a band**, and dropping it here is the
  // one thing the census round got wrong.
  //
  // `slots <= 0 -> return null` predates `density.ts` and almost never fired:
  // under the uniform rates the only bands that rounded to zero were the very
  // shortest, so "the field holds a band" and "the field holds a walker" were
  // the same statement and four other features quietly came to rely on it.
  // `PedestrianField` is not only the ambient crowd -- it is **the only
  // description of where the footpaths are** that either end of the wire has,
  // and `factions.patrolBands`, `factions.catchmentBands`,
  // `streetlife.anchorBands` and the wildlife nest scan all read it as one.
  //
  // With the census multiplier in, the drop fired everywhere. Measured over a
  // 407-tile sample of the shipped world: 10,428 footpaths of buildable length,
  // 7,630 bands under the uniform rates, and **3,838 under the census** -- so
  // more than half the footpaths in Sydney disappeared from the field, and with
  // them the police lattice's guarantee ("a pair on every stretch of footpath",
  // task 62) and a fifth of the middle-ring pubs' frontage. Both showed up as
  // faction checks going red, and neither is a statement about how many people
  // live in the suburb.
  //
  // So the geometric gate above -- `total >= MIN_BAND_M` -- is the only thing
  // that decides whether a band exists, and the census decides only how many
  // walkers stand on it. The walkers are unchanged by this line: the sample's
  // slot total stays 5,453 against the uniform world's 15,874, which is the
  // density feature doing exactly what it was asked to do. What it costs is
  // band *records*: 10,428 against the 7,630 the uniform world shipped with,
  // +37% of the cheap half while the expensive half -- posed, drawn, hit-tested
  // walkers -- falls by two thirds.
  if (slots < 0) slots = 0;
  if (slots > MAX_SLOTS) slots = MAX_SLOTS;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (z[i] < minZ) minZ = z[i];
    if (z[i] > maxZ) maxZ = z[i];
  }

  return {
    osmId: way.osmId,
    side,
    klass: way.klass,
    seed,
    count: n,
    x, y, z, s, ux, uz,
    length: total,
    slots,
    minX, maxX, minZ, maxZ,
    // WORKSTREAM AB: no query has looked at this band yet. Stamps start at 1.
    mark: 0,
  };
}

// --- The resident world --------------------------------------------------------

/** Broadphase cell, metres. Half the traffic's, because a band is far shorter than a route. */
const CELL = 128;

/**
 * The canonical order of two bands. A pure function of what a band *is*.
 *
 * `compareRoutes`' argument, with the keys the rest of this project already
 * sorts bands by: `game/factions.catchmentBands`, `game/factions.patrolBands`,
 * `game/streetlife.anchorBands` and `game/wildlife`'s nest scan all end their
 * comparators with `osmId || side || minX`, precisely because `near` used to
 * return bands "in whatever order its grid buckets hold them -- streaming order
 * on a browser, `Promise.all` completion order on the server". Those four
 * sorts stay where they are; this one makes the thing they were defending
 * against stop happening, so that a query which does *not* sort -- and
 * `forEachPedestrianNear` is one -- is stable too.
 *
 * `osmId` is zero for a way OSM did not name, so the tail is not decoration:
 * the unnamed service lanes of one industrial estate would otherwise all
 * compare equal on the first two keys.
 */
export function compareBands(a: PedBand, b: PedBand): number {
  if (a === b) return 0;
  if (a.osmId !== b.osmId) return a.osmId < b.osmId ? -1 : 1;
  if (a.side !== b.side) return a.side < b.side ? -1 : 1;
  if (a.minX !== b.minX) return a.minX < b.minX ? -1 : 1;
  if (a.minZ !== b.minZ) return a.minZ < b.minZ ? -1 : 1;
  if (a.maxX !== b.maxX) return a.maxX < b.maxX ? -1 : 1;
  if (a.maxZ !== b.maxZ) return a.maxZ < b.maxZ ? -1 : 1;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a.count !== b.count) return a.count < b.count ? -1 : 1;
  if (a.seed !== b.seed) return a.seed < b.seed ? -1 : 1;
  if (a.klass !== b.klass) return a.klass < b.klass ? -1 : 1;
  return 0;
}

/**
 * Every footpath band currently loaded, indexed for "who is near this player".
 *
 * Adopt and drop by tile key, exactly as `TrafficField` and `PowerupField` are,
 * and told by the same `streamer.ts` call site. It holds no walker state at all
 * except the down registry -- a band is geometry, and a walker is a function --
 * so an eviction and a re-adoption put the identical people back on the
 * identical footpath.
 *
 * The index is maintained **per tile and in canonical order**, for the two
 * reasons `TrafficField`'s header sets out at length and does not repeat here.
 * This is the expensive half of that pair: a tile carries about eight routes and
 * about thirty bands, and the whole-world rebuild this replaced cost 11.12 ms
 * against traffic's 3.30 ms.
 */
export class PedestrianField {
  private readonly tiles = new Map<string, PedBand[]>();
  private flat: PedBand[] = [];
  private readonly grid = new Map<number, PedBand[]>();
  private flatDirty = true;
  /** Who is currently on the ground, and their accumulated offset. See `PedDown`. */
  private readonly downs = new Map<number, PedDown>();

  /**
   * Bumped every time the resident set changes.
   *
   * A **cache key for consumers**, and it exists because `near` is not free: it
   * walks a grid, rejects duplicates and returns a fresh answer every call. A
   * reader that wants the same query answered on every frame -- and
   * `game/factions.beatBand` is exactly that, for nineteen police stations --
   * has no other way to know whether its last answer is still good.
   * `flatDirty` above is the same fact and is private, because it is about
   * whether *this* object needs to rebuild; this is about whether anybody
   * else's derived thing is stale.
   *
   * Never decreases, so a consumer stores the number rather than comparing sets.
   *
   * **It bumps per tile, and a hexagon is up to 374 of them**, so a server
   * loading or evicting a hexagon invalidates every consumer's cache a few
   * hundred times over the half second the load takes. That is the correct
   * behaviour -- a beat chosen against half a hexagon is a beat that will be
   * wrong -- and it is cheap because each recomputation is one grid walk over
   * the stations within 940 m of somebody, memoised again immediately. Measured
   * at 100 players with the lane cap cycling: the `npc` phase is 0.487 ms
   * against 0.494 ms uncapped, which is noise. Do not "optimise" it into a
   * coarser key without re-running that pair.
   */
  get generation(): number {
    return this.gen;
  }

  private gen = 0;

  /** Told a tile's decoded lane sidecar; derives the bands itself. */
  adopt(tileKey: string, tile: TileLanes): void {
    const previous = this.tiles.get(tileKey);
    if (previous !== undefined) this.unindex(previous);
    const bands = buildBands(tile);
    this.tiles.set(tileKey, bands);
    this.index(bands);
    this.flatDirty = true;
    this.gen++;
  }

  drop(tileKey: string): void {
    const previous = this.tiles.get(tileKey);
    if (previous === undefined) return;
    this.tiles.delete(tileKey);
    this.unindex(previous);
    this.flatDirty = true;
    this.gen++;
  }

  /** Is this tile's lane sidecar already held? The residency's accounting asks. */
  hasTile(tileKey: string): boolean {
    return this.tiles.has(tileKey);
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Every band in a resident tile, in canonical order. Do not hold across a drop. */
  bands(): readonly PedBand[] {
    if (this.flatDirty) {
      this.flatDirty = false;
      this.flat = [];
      for (const bands of this.tiles.values()) for (const band of bands) this.flat.push(band);
      this.flat.sort(compareBands);
    }
    return this.flat;
  }

  /** Total scheduled slots across the resident set. Diagnostics only. */
  get slotCount(): number {
    let n = 0;
    for (const band of this.bands()) n += band.slots;
    return n;
  }

  /**
   * How many knockdowns are **remembered**, which is not how many people are on
   * the ground.
   *
   * A record outlives the two seconds its walker spends down, because the
   * schedule offset in it is what stops them teleporting when they stand up --
   * see `PedDown` and `forgetDistant`. So this number only falls when somebody
   * walks out of range, and reporting it as "down" was the first thing about
   * this feature to read wrong on the overlay: one bystander clobbered three
   * minutes ago showed as one person permanently lying on the footpath. Use
   * `lyingCount` for the picture and this for the registry's size.
   */
  get downCount(): number {
    return this.downs.size;
  }

  /** How many people are actually on the ground at `now`. What the overlay wants. */
  lyingCount(now: number): number {
    let n = 0;
    for (const record of this.downs.values()) if (now < record.upAt) n++;
    return n;
  }

  downOf(key: number): PedDown | undefined {
    return this.downs.get(key);
  }

  /**
   * Knock somebody over. Returns the record, or null if they are already down.
   *
   * The re-hit guard is `traffic.canBeRunDown`'s, in one line and with no new
   * state: somebody lying on the footpath cannot be hit again, which is what
   * stops a bat swung through a pile of bodies re-launching all of them every
   * tick it overlaps them.
   */
  knockDown(key: number, tick: number, now: number, x = 0, z = 0, vx = 0, vz = 0, gib = false): PedDown | null {
    const existing = this.downs.get(key);
    if (existing !== undefined && now < existing.upAt) return null;
    const offsetBefore = existing === undefined ? 0 : existing.offset;
    const seconds = gib ? DEAD_SECONDS : downSeconds(key, tick);
    const record: PedDown = {
      frozen: now - offsetBefore,
      upAt: now + seconds,
      seconds,
      offset: offsetBefore + seconds,
      tick,
      x,
      z,
      vx,
      vz,
      gib,
    };
    this.downs.set(key, record);
    return record;
  }

  /**
   * Forget the walkers who are far enough away that snapping them back onto
   * their schedule cannot be seen.
   *
   * The offset has to persist after somebody stands up or they would teleport
   * forward by the two seconds they spent on the ground -- so the registry only
   * ever grows, and over a long session that is a leak. Dropping a record moves
   * the walker by `offset * speed`, about three metres a knock, so it is dropped
   * only well beyond the far draw radius. Called by the renderer, which is the
   * only thing that knows where the camera is.
   *
   * The distance is measured to where they were *standing when they were hit*,
   * which is a proxy for where they are now and is deliberately the cheap one:
   * this runs every frame over every record, and looking the walker's band up to
   * get an exact answer would be a linear scan of thirteen thousand bands per
   * record. The error is bounded by the length of one band, which is why the
   * radius this is called with is a long way outside the one anything is drawn
   * at -- so even the worst case snaps somebody nobody can see.
   */
  forgetDistant(x: number, z: number, radius: number, now: number): void {
    if (this.downs.size === 0) return;
    const r2 = radius * radius;
    for (const [key, record] of this.downs) {
      if (now < record.upAt) continue;
      const dx = record.x - x;
      const dz = record.z - z;
      if (dx * dx + dz * dz > r2) this.downs.delete(key);
    }
  }

  /** Clear every knockdown. A respawn, a disconnect, or a check starting over. */
  clearDowns(): void {
    this.downs.clear();
  }

  /**
   * Bands whose plan bounds reach within `radius` of a point.
   *
   * `TrafficField.near`'s contract verbatim: appends into `out` and returns it,
   * so a caller in a 60 Hz loop allocates nothing, and the bounds test is loose
   * on purpose -- a false positive costs one schedule evaluation.
   */
  near(x: number, z: number, radius: number, out: PedBand[]): PedBand[] {
    out.length = 0;
    const stamp = nextQueryStamp();
    const c0 = Math.floor((x - radius) / CELL);
    const c1 = Math.floor((x + radius) / CELL);
    const r0 = Math.floor((z - radius) / CELL);
    const r1 = Math.floor((z + radius) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const bucket = this.grid.get(cellKey(cx, cz));
        if (bucket === undefined) continue;
        for (const band of bucket) {
          // WORKSTREAM AB: decided once per query, whichever cell it arrives
          // from. The stamp covers rejections as well as acceptances -- the
          // bounds test does not depend on the cell, so a band rejected here is
          // rejected everywhere and re-testing it is pure waste. See `mark`.
          if (band.mark === stamp) continue;
          band.mark = stamp;
          if (
            band.maxX < x - radius || band.minX > x + radius ||
            band.maxZ < z - radius || band.minZ > z + radius
          ) continue;
          out.push(band);
        }
      }
    }
    return out;
  }

  /** One tile's bands into the grid, each in its bucket's canonical place. */
  private index(bands: readonly PedBand[]): void {
    for (const band of bands) {
      const c0 = Math.floor(band.minX / CELL);
      const c1 = Math.floor(band.maxX / CELL);
      const r0 = Math.floor(band.minZ / CELL);
      const r1 = Math.floor(band.maxZ / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const k = cellKey(cx, cz);
          const bucket = this.grid.get(k);
          if (bucket === undefined) this.grid.set(k, [band]);
          else insertSorted(bucket, band, compareBands);
        }
      }
    }
  }

  /** And back out again. `TrafficField.unindex`'s note on recomputing the span. */
  private unindex(bands: readonly PedBand[]): void {
    for (const band of bands) {
      const c0 = Math.floor(band.minX / CELL);
      const c1 = Math.floor(band.maxX / CELL);
      const r0 = Math.floor(band.minZ / CELL);
      const r1 = Math.floor(band.maxZ / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const k = cellKey(cx, cz);
          const bucket = this.grid.get(k);
          if (bucket === undefined) continue;
          removeSorted(bucket, band, compareBands);
          if (bucket.length === 0) this.grid.delete(k);
        }
      }
    }
  }

  /** How many broadphase cells are occupied. Diagnostics, and the leak check. */
  get cellCount(): number {
    return this.grid.size;
  }
}

/** Two signed cell indices in one integer key. `TrafficField`'s, at half the cell. */
function cellKey(cx: number, cz: number): number {
  return ((cx + 0x4000) << 15) | ((cz + 0x4000) & 0x7fff);
}

// --- Evaluating a walker -------------------------------------------------------

function unit(h: number): number {
  return h / 4294967296;
}

/**
 * How long this hit puts this walker on the ground, seconds.
 *
 * A pure function of the key and the tick, which is what makes the whole
 * knockdown reproducible from the two numbers the police pass will put on the
 * wire -- it never has to send a duration, and the server never has to agree to
 * one. 1.5 to 2.5 s: long enough to read as a person getting up off the
 * pavement, short enough that a street does not fill with bodies.
 */
export function downSeconds(key: number, tick: number): number {
  return DOWN_MIN + DOWN_SPAN * unit(carHash(key | 0, tick | 0));
}

/**
 * Where walker `slot` of `band` is at `now` seconds, and what they look like.
 *
 * Returns false when that slot is in its dwell -- between two traversals -- which
 * is how the caller iterates: ask a band for its slot count, then pose each one.
 *
 * The whole schedule, in the order it is computed:
 *
 *   - `speed`, `dwell` and `phase` are hashed off `(band, slot)` and never
 *     change. `trip` is the band's length at that speed, `period` is one there
 *     and one dwell.
 *   - `cycle = floor((now - phase) / period)` is which traversal this is, and it
 *     is a floor of a division -- exact arithmetic, so two processes agree about
 *     the *set* of people on a street as well as about where each one is.
 *   - `u` is the position inside the period. Past `trip` the walker is in the
 *     dwell and does not exist.
 *   - the direction alternates with `cycle`, seeded off the walker, so somebody
 *     walks down the street and back rather than teleporting to the same end
 *     forever.
 *
 * No transcendental anywhere in it. The band lookup is a binary search over
 * precomputed arc lengths and a lerp, which is `traffic.poseCar`'s shape and is
 * the same argument: subtract, divide, multiply, add, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * **`onDuty` removes the dwell, and it is the difference between a passer-by
 * and a patrol.**
 *
 * The dwell is what makes an ambient crowd a crowd: a walker exists for one
 * traversal, vanishes for ten to thirty seconds, and comes back the other way.
 * Nobody watches one person, so nobody sees them go.
 *
 * A police pair is watched, and worse, is *counted*. `factions.patrolPairs`
 * promises `PATROL_BASE_PAIRS` on every stretch of footpath in every cell, and
 * a pair that spends a third of its cycle not existing does not deliver that
 * promise a third of the time -- measured at the spawn, 3 sample instants in
 * 240 had **no officer at all** within a cell's width, which is the shape of
 * task 62's original complaint ("I never saw any police") returning as a
 * flicker. It is also just wrong to look at: two officers on a beat walk to the
 * end of the block and walk back, they do not evaporate outside the pub.
 *
 * So a duty walker's period is the traversal alone. Same speed, same phase,
 * same alternating direction, same arithmetic on both ends -- one term dropped.
 * `factions.ts` is the only caller that passes it, and it passes it for both
 * the station beats and the lattice, because "on duty" is the same statement
 * about both.
 */
export function posePedestrian(
  band: PedBand,
  slot: number,
  now: number,
  down: PedDown | undefined,
  out: PedPose,
  onDuty = false,
): boolean {
  const key = pedKey(band.osmId, band.side, slot);
  let at = now;
  let isDown = false;
  let downT = 0;
  let downLeft = 0;
  if (down !== undefined) {
    if (now < down.upAt) {
      // Down. The schedule is pinned at the instant of the hit, because the
      // offset arithmetic runs it *backwards* through this window -- see
      // `PedDown` -- and somebody moonwalking while unconscious would be a very
      // odd thing to ship.
      isDown = true;
      downLeft = down.upAt - now;
      downT = down.seconds - downLeft;
      at = down.frozen;
    } else {
      at = now - down.offset;
    }
  }

  const h = carHash(band.seed, slot);
  const speed = WALK_SPEED_MIN + WALK_SPEED_SPAN * unit(h);
  const trip = band.length / speed;
  // The dwell, and the one term `onDuty` drops. The phase is still taken over
  // the *same* period either way -- a duty walker's phase is a fraction of a
  // trip rather than of a trip and a stand -- and everything downstream of `u`
  // is untouched, which is what keeps the two schedules one function.
  const dwell = onDuty ? 0 : DWELL_MIN + DWELL_SPAN * unit(carHash(h, 0x51a3));
  const period = trip + dwell;
  const age = at - unit(carHash(h, 0x9e37)) * period;
  const cycle = Math.floor(age / period);
  const u = age - cycle * period;
  if (u >= trip) return false;

  const along = u * speed;
  // Which way along the band this traversal runs. The walker's own bit decides
  // the first one and the cycle alternates it, so a person walks to the end of
  // the block and comes back rather than always appearing at the same corner.
  const back = ((carHash(h, 0x2f11) ^ cycle) & 1) !== 0;
  const d = back ? band.length - along : along;

  const s = band.s;
  let lo = 0;
  let hi = band.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = s[lo + 1] - s[lo];
  const t = span > 0 ? (d - s[lo]) / span : 0;

  out.key = key;
  out.osmId = band.osmId;
  out.side = band.side;
  out.slot = slot;
  out.x = band.x[lo] + t * (band.x[lo + 1] - band.x[lo]);
  out.y = band.y[lo] + t * (band.y[lo + 1] - band.y[lo]);
  out.z = band.z[lo] + t * (band.z[lo + 1] - band.z[lo]);
  out.dx = back ? -band.ux[lo] : band.ux[lo];
  out.dz = back ? -band.uz[lo] : band.uz[lo];
  out.kit = carHash(h, 0x1b0d) % PEDESTRIAN_KIT_COUNT;
  out.speed = isDown ? 0 : speed;
  out.along = along;
  out.down = isDown;
  out.downT = downT;
  out.downLeft = downLeft;
  out.vx = isDown && down !== undefined ? down.vx : 0;
  out.vz = isDown && down !== undefined ? down.vz : 0;
  out.gib = isDown && down !== undefined && down.gib;
  // The flight. A body a car threw is not where it stood; it is where the
  // launch put it, and the schedule stays pinned underneath so it gets up
  // where it landed only in the sense that it never gets up anywhere else.
  if (isDown && down !== undefined && (down.vx !== 0 || down.vz !== 0)) {
    launchOffset(down.vx, down.vz, downT, _launch);
    out.x += _launch[0];
    out.y += _launch[1];
    out.z += _launch[2];
  }
  return true;
}

/**
 * Every walker within `radius` of a point, at `tick`.
 *
 * The iteration order is fixed rather than incidental -- `near` returns bands in
 * bucket order and slots ascend within a band -- so two processes walking the
 * same resident set visit the same people in the same order. That matters for
 * the strike test, where the nearest wins and ties have to break the same way
 * everywhere.
 *
 * `tick` may be fractional: the renderer passes a frame fraction so a 144 Hz
 * display does not watch 60 Hz people, and the strike test passes a whole tick
 * so that this client and a future server ask the identical question.
 */
export function forEachPedestrianNear(
  field: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: PedBand[],
  pose: PedPose,
  visit: (pose: PedPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;
  for (const band of field.near(x, z, radius, scratch)) {
    for (let slot = 0; slot < band.slots; slot++) {
      const down = field.downOf(pedKey(band.osmId, band.side, slot));
      if (!posePedestrian(band, slot, now, down, pose)) continue;
      const dx = pose.x - x;
      const dz = pose.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (visit(pose) === true) return;
    }
  }
}

/** How many walkers are on the footpath within `radius` right now. Diagnostics only. */
export function countPedestriansNear(
  field: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: PedBand[],
  pose: PedPose,
): number {
  let n = 0;
  forEachPedestrianNear(field, x, z, radius, tick, scratch, pose, () => {
    n++;
  });
  return n;
}

// --- Getting clobbered ---------------------------------------------------------

/**
 * What a pedestrian who has just been hit reports to whoever is listening.
 *
 * **This is the seam the police pass subscribes to.** Everything in it is either
 * a schedule coordinate -- `key` and `tick`, from which any process can recover
 * the whole event by evaluating `posePedestrian` -- or a convenience the caller
 * would otherwise have to recompute. Nothing here is on the wire and nothing in
 * this module decides what it means; a knocked-over pedestrian is a cosmetic
 * event this wave and becomes a crime when something subscribes and says so.
 */
export interface PedestrianHit {
  key: number;
  osmId: number;
  side: number;
  slot: number;
  x: number;
  y: number;
  z: number;
  /** The whole tick the hit was adjudicated on. With `key`, this is the event. */
  tick: number;
  /** Seconds they will spend on the ground. `downSeconds(key, tick)`. */
  seconds: number;
  /** What hit them. Open for a future cause without changing the shape. */
  cause: 'bat' | 'footy' | 'car';
  /** The combatant id responsible, or 0 when nothing owns it. */
  attacker: number;
  /** The launch the record carries, and whether it killed. See `LAUNCH_SECONDS`, `GIB_SPEED`. */
  vx: number;
  vz: number;
  gib: boolean;
}

type PedestrianHitListener = (hit: PedestrianHit) => void;

const listeners: PedestrianHitListener[] = [];

/**
 * Be told when somebody knocks a pedestrian over. Returns an unsubscribe.
 *
 * The seam, named and exported before there is anything on the other end of it,
 * because the pass that needs it owns `net/protocol.ts` and this module must
 * never. Everything a server-authoritative version needs is in `PedestrianHit`:
 * the walker's stable key and the whole tick. A subscriber can send those two
 * bytes-worth of numbers, and the receiving end can reconstruct where that
 * person was standing, how long they will be down for and what they were wearing
 * by calling `posePedestrian` -- because it is a pure function of the world files
 * both ends already have.
 *
 * Module-level rather than per-field, on the argument `world/version.ts` makes
 * about the reload prompt: there is one player, one crowd and one set of
 * consequences in a session, and threading a subscription through the field
 * would mean every future consumer had to be handed the field to reach it.
 */
export function onPedestrianStruck(cb: PedestrianHitListener): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** For a check that has to start from nothing. Not called in play. */
export function clearPedestrianListeners(): void {
  listeners.length = 0;
}

function announce(hit: PedestrianHit): void {
  for (const cb of listeners) cb(hit);
}

/**
 * How far out the strike test looks, metres. The bat's reach plus a capsule.
 *
 * One number rather than one per candidate, for `traffic.HIT_QUERY_RADIUS`'s
 * reason: it is the broadphase radius, and a broadphase whose size changes per
 * candidate is not a broadphase.
 */
const STRIKE_QUERY_RADIUS = REACH + CAPSULE_RADIUS + CAST_RADIUS + 0.5;

/**
 * The bat, against the crowd.
 *
 * A parallel test rather than a call into `combat.hitTest`, and the reason is
 * that a pedestrian is not a `CombatantState` and should not become one. Making
 * them combatants would put them in the tick order, in the snapshot, in the
 * rewind buffer and in the roster -- for figures that have no health, take no
 * turns and cost nothing to run. So this borrows the two pieces of `combat.ts`
 * that are actually geometry -- `segmentDistance` and the three radii -- and
 * asks the identical question of a different subject. The cast, the reach, the
 * nearest-wins rule and the tie break are the swing's own, so a ped standing
 * beside a player is hit under exactly the conditions the player would have been.
 *
 * Returns the pose of whoever was hit, already knocked down, or null. Announces
 * on the seam. `pose` is the caller's scratch and is left holding the victim.
 */
export function strikePedestrian(
  field: PedestrianField,
  attacker: CombatantState,
  tick: number,
  scratch: PedBand[],
  pose: PedPose,
): PedPose | null {
  const body = attacker.body;
  // `combat.viewDirection`'s vector, without the `Vector3` -- three's types do
  // not reach this file and the two `Math.sin` calls here are off the shared
  // path entirely: this runs once per swing, on the machine that swung.
  const cp = Math.cos(body.pitch);
  const vx = -Math.sin(body.yaw) * cp;
  const vy = Math.sin(body.pitch);
  const vz = -Math.cos(body.yaw) * cp;
  const ax = body.position.x;
  const ay = body.position.y;
  const az = body.position.z;
  const bx = ax + vx * REACH;
  const by = ay + vy * REACH;
  const bz = az + vz * REACH;
  const overlap = CAST_RADIUS + CAPSULE_RADIUS;

  let bestPlan = Infinity;
  let bestKey = -1;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestOsm = 0;
  let bestSide = 0;
  let bestSlot = 0;

  forEachPedestrianNear(field, ax, az, STRIKE_QUERY_RADIUS, tick, scratch, pose, (p) => {
    // Somebody already on the footpath cannot be hit again. `traffic`'s re-hit
    // guard, and it needs no state here either.
    if (p.down) return;
    const dx = p.x - ax;
    const dz = p.z - az;
    const plan2 = dx * dx + dz * dz;
    if (plan2 > REACH * REACH) return;
    if (plan2 >= bestPlan) return;
    const d = segmentDistance(
      ax, ay, az, bx, by, bz,
      p.x, p.y + CAPSULE_RADIUS, p.z,
      p.x, p.y + CAPSULE_HEIGHT - CAPSULE_RADIUS, p.z,
    );
    if (d > overlap) return;
    bestPlan = plan2;
    bestKey = p.key;
    bestX = p.x;
    bestY = p.y;
    bestZ = p.z;
    bestOsm = p.osmId;
    bestSide = p.side;
    bestSlot = p.slot;
  });

  if (bestKey < 0) return null;
  return land(field, bestKey, bestOsm, bestSide, bestSlot, bestX, bestY, bestZ, tick, 'bat', attacker.id, scratch, pose);
}

/**
 * A football, against the crowd.
 *
 * The ball's own step is a segment from where it was to where it is, tested
 * against the same capsule -- which is exactly what `footy.stepFooty` does to a
 * combatant, using the same `segmentDistance`, so a ball that would have hit a
 * player hits a pedestrian standing in the same spot. The previous position is
 * reconstructed from the velocity rather than stored, which is what
 * `stepFooty` itself works with and is exact for the straight segment a ball
 * flies in one tick.
 */
export function strikePedestrianWithBall(
  field: PedestrianField,
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number; thrower: number },
  radius: number,
  dt: number,
  tick: number,
  scratch: PedBand[],
  pose: PedPose,
): PedPose | null {
  const ax = ball.x - ball.vx * dt;
  const ay = ball.y - ball.vy * dt;
  const az = ball.z - ball.vz * dt;
  const overlap = radius + CAPSULE_RADIUS;
  // The swept segment can be several metres long, so the query is centred on it.
  const cx = (ax + ball.x) * 0.5;
  const cz = (az + ball.z) * 0.5;
  const halfSpan = Math.max(Math.abs(ball.x - ax), Math.abs(ball.z - az)) * 0.5;

  let bestD = Infinity;
  let bestKey = -1;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestOsm = 0;
  let bestSide = 0;
  let bestSlot = 0;

  forEachPedestrianNear(field, cx, cz, halfSpan + overlap + 1, tick, scratch, pose, (p) => {
    if (p.down) return;
    const d = segmentDistance(
      ax, ay, az, ball.x, ball.y, ball.z,
      p.x, p.y + CAPSULE_RADIUS, p.z,
      p.x, p.y + CAPSULE_HEIGHT - CAPSULE_RADIUS, p.z,
    );
    if (d > overlap || d >= bestD) return;
    bestD = d;
    bestKey = p.key;
    bestX = p.x;
    bestY = p.y;
    bestZ = p.z;
    bestOsm = p.osmId;
    bestSide = p.side;
    bestSlot = p.slot;
  });

  if (bestKey < 0) return null;
  return land(field, bestKey, bestOsm, bestSide, bestSlot, bestX, bestY, bestZ, tick, 'footy', ball.thrower, scratch, pose);
}

/**
 * A **driven** car, against the crowd. `game/driving.ts`'s only reach into this
 * module.
 *
 * The third cause, and it is deliberately not routed through
 * `traffic.carHitting`: that function tests one `CombatantState` capsule against
 * the ambient fleet, and this tests the whole crowd against *one* box that a
 * player is steering. The geometry is `traffic.carOverlaps`' -- an oriented box
 * in plan, tested with the same `along`/`across` decomposition and the same
 * "left of a heading `(dx, dz)` is `(dz, -dx)`" convention `lanes.py` offsets a
 * lane by -- so somebody standing where an ambient car would have hit them is
 * hit by a driven car in the same spot.
 *
 * The **nearest** victim only, per call, on `strikePedestrian`'s rule: a car
 * through a bus queue that flattened nine people on one tick would be nine
 * `PedestrianHit` announcements in one frame and nine crimes reported for one
 * act. One a tick at 60 Hz is still a bus queue going down, over a fifth of a
 * second, which reads better anyway.
 *
 * Returns the victim's pose, already down, or null. The caller decides what it
 * costs -- `server/sim.ts` reports the crime; this module has never known what a
 * crime is.
 */
export function runDownPedestrian(
  field: PedestrianField,
  car: {
    x: number;
    y: number;
    z: number;
    /** Unit heading in the world plan, as `traffic.CarPose` carries it. */
    dx: number;
    dz: number;
    halfLength: number;
    halfWidth: number;
    height: number;
    /** Metres per second, as `CarPose.speed` carries it. Absent for a blast box: a shove with no launch. */
    speed?: number;
  },
  driver: number,
  tick: number,
  scratch: PedBand[],
  pose: PedPose,
): PedPose | null {
  // The broadphase, one number rather than one per candidate, on
  // `STRIKE_QUERY_RADIUS`' argument: a broadphase whose size changes per
  // candidate is not a broadphase. The half-diagonal of the longest body plus a
  // capsule covers every box this can be handed.
  const reach = car.halfLength + car.halfWidth + CAPSULE_RADIUS;

  let bestPlan = Infinity;
  let bestKey = -1;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestOsm = 0;
  let bestSide = 0;
  let bestSlot = 0;

  forEachPedestrianNear(field, car.x, car.z, reach, tick, scratch, pose, (p) => {
    // Already on the footpath. `traffic`'s re-hit guard, and it is what stops a
    // car parked on top of somebody re-flattening them sixty times a second.
    if (p.down) return;
    // The vertical gate, `traffic.carOverlaps`' and for its reason: without it a
    // car on the Cahill Expressway mows down the queue on Alfred Street eight
    // metres below.
    if (p.y > car.y + car.height) return;
    if (p.y + CAPSULE_HEIGHT < car.y) return;
    const rx = p.x - car.x;
    const rz = p.z - car.z;
    const along = rx * car.dx + rz * car.dz;
    if (along > car.halfLength + CAPSULE_RADIUS || along < -car.halfLength - CAPSULE_RADIUS) return;
    const across = rx * car.dz - rz * car.dx;
    if (across > car.halfWidth + CAPSULE_RADIUS || across < -car.halfWidth - CAPSULE_RADIUS) return;
    const plan2 = rx * rx + rz * rz;
    if (plan2 >= bestPlan) return;
    bestPlan = plan2;
    bestKey = p.key;
    bestX = p.x;
    bestY = p.y;
    bestZ = p.z;
    bestOsm = p.osmId;
    bestSide = p.side;
    bestSlot = p.slot;
  });

  if (bestKey < 0) return null;
  // The launch is the car's own velocity, scaled; the kill is its speed.
  const speed = car.speed ?? 0;
  const vx = car.dx * speed * LAUNCH_SCALE;
  const vz = car.dz * speed * LAUNCH_SCALE;
  return land(field, bestKey, bestOsm, bestSide, bestSlot, bestX, bestY, bestZ, tick, 'car', driver, scratch, pose, vx, vz, speed >= GIB_SPEED);
}

/** Put somebody on the ground, tell the listeners, and hand back their pose. */
function land(
  field: PedestrianField,
  key: number,
  osmId: number,
  side: number,
  slot: number,
  x: number,
  y: number,
  z: number,
  tick: number,
  cause: 'bat' | 'footy' | 'car',
  attacker: number,
  scratch: PedBand[],
  pose: PedPose,
  vx = 0,
  vz = 0,
  gib = false,
): PedPose | null {
  const now = trafficSeconds(tick);
  const record = field.knockDown(key, tick, now, x, z, vx, vz, gib);
  if (record === null) return null;
  // Re-pose so the caller is handed the walker as they now are -- down, pinned,
  // and with the clock the renderer reads off them.
  for (const band of field.near(x, z, 2, scratch)) {
    if (band.osmId !== osmId || band.side !== side) continue;
    if (posePedestrian(band, slot, now, record, pose)) break;
  }
  announce({
    key, osmId, side, slot, x, y, z,
    tick,
    seconds: record.seconds,
    cause,
    attacker,
    vx,
    vz,
    gib,
  });
  return pose;
}

// --- Self-check ----------------------------------------------------------------

/**
 * Everything about this module that fails by rendering a plausible city.
 *
 * There is no picture for any of it. **The offset sign** is the worst: a band
 * derived on the wrong side of the kerb is a crowd walking up the middle of
 * Cleveland Street, which looks like a deliberate stylistic choice from any
 * camera angle and is invisible to a check that only asks whether people are
 * near streets. A **schedule that is not deterministic** puts one player's
 * pedestrians somewhere else, which matters the moment the police pass makes a
 * ped-hit a crime -- you would be fined for hitting somebody who was not there.
 * **Density** that has drifted is either a ghost town or Pitt Street Mall on a
 * Saturday, and both read as taste. A **LOD cap** that is not enforced is a
 * frame-time cliff on the one street in the city dense enough to hit it. None of
 * them throws.
 *
 * `kitCount` is `character.COLOURWAYS.length`, handed in rather than imported --
 * `carBodySizes()`'s precedent, and for the identical reason: this module
 * compiles into the Bun server and must not drag the renderer in behind it.
 * `contract` is `index.json`'s `lanes` block. Both optional so the server can
 * run this before it has opened a file.
 */
export function verifyPedestrians(
  kitCount?: number,
  contract?: { kerb_width_m?: number; footpath_y_m?: number; carriageway_y_m?: number } | null,
  caps?: { rigs: number; impostors: number },
): string[] {
  const failures: string[] = [];

  if (kitCount !== undefined && kitCount !== PEDESTRIAN_KIT_COUNT) {
    failures.push(
      `The renderer has ${kitCount} kits and the walker hash picks from ${PEDESTRIAN_KIT_COUNT}; ` +
        'a pedestrian would change clothes at the LOD handoff.',
    );
  }
  if (SLOT_DENSITY.length !== LANE_CLASSES.length) {
    failures.push(
      `SLOT_DENSITY has ${SLOT_DENSITY.length} entries and there are ${LANE_CLASSES.length} lane classes.`,
    );
  }
  for (let i = 0; i < LANE_CLASSES.length; i++) {
    const name = LANE_CLASSES[i];
    if ((name === 'motorway' || name.endsWith('_link')) && (SLOT_DENSITY[i] ?? 0) !== 0) {
      failures.push(`Somebody is scheduled to stroll along a ${name}. Nobody walks the Western Distributor.`);
    }
  }

  // --- The pipeline's widths are this build's widths.
  if (contract) {
    if (contract.kerb_width_m !== undefined && contract.kerb_width_m !== KERB_WIDTH) {
      failures.push(
        `The world was baked with a ${contract.kerb_width_m} m kerb and this build derives footpaths ` +
          `from ${KERB_WIDTH} m; every pedestrian in the city would be off the concrete.`,
      );
    }
    if (contract.footpath_y_m !== undefined && contract.footpath_y_m !== FOOTPATH_Y) {
      failures.push(`The world's footpaths are ${contract.footpath_y_m} m over the ground and this build walks on ${FOOTPATH_Y} m.`);
    }
    if (contract.carriageway_y_m !== undefined && contract.carriageway_y_m !== CARRIAGEWAY_Y) {
      failures.push(`The world's carriageway sits at ${contract.carriageway_y_m} m and this build derives the footpath lift from ${CARRIAGEWAY_Y} m.`);
    }
  }

  // --- A synthetic tile, through the real encoder and the real decoder.
  //
  // 200 m due north, two-way, residential, 7.5 m kerb to kerb with a 3 m
  // footpath. Due north is -Z in renderer axes and the left of it is west, which
  // is -X -- the same construction `verifyTraffic` uses and for the same reason:
  // it makes every assertion below one about the shipped bytes rather than about
  // an object literal.
  const HALF = 3.75;
  const FOOT = 3.0;
  const WAY_Y = -12.5;
  const tile = syntheticTile(HALF, FOOT, WAY_Y, 10);
  if (tile === null) {
    failures.push('verifyPedestrians could not round-trip its own synthetic lane sidecar.');
    return failures;
  }
  // `UNIFORM_CROWD` throughout the geometry checks: they are about which side
  // of the kerb a band lands on and whether two decodes agree, and none of them
  // has an opinion about Dural. The census scaling has its own section below.
  const bands = buildBands(tile, UNIFORM_CROWD);
  if (bands.length !== 2) {
    failures.push(`A two-way street with a 3 m footpath produced ${bands.length} bands; it must produce two.`);
    return failures;
  }

  // --- SIDEDNESS. Both sides of the street, and neither of them on the road.
  {
    const expected = HALF + KERB_WIDTH + FOOT * 0.5;
    const left = bands.find((b) => b.side === 0);
    const right = bands.find((b) => b.side === 1);
    if (!left || !right) failures.push('The two bands are not one per side.');
    else {
      // The way runs due north (-Z). Left of that is west (-X).
      if (Math.abs(left.x[0] - -expected) > 1e-3) {
        failures.push(
          `The left-hand band of a due-north way sits at x = ${left.x[0].toFixed(3)}; left of north is ` +
            `west, so it must be at ${(-expected).toFixed(3)}. The footpath offset sign is inverted.`,
        );
      }
      if (Math.abs(right.x[0] - expected) > 1e-3) {
        failures.push(`The right-hand band sits at x = ${right.x[0].toFixed(3)}; it must be at ${expected.toFixed(3)}.`);
      }
      if (left.x[0] * right.x[0] >= 0) {
        failures.push('Both bands of a two-way street landed on the same side of it.');
      }
    }
  }

  // --- OUTSIDE THE KERB. Sampled off real walkers rather than off the band, so
  // this is an assertion about where a person actually stands.
  {
    const pose = createPedPose();
    const kerbEdge = HALF + KERB_WIDTH;
    let sampled = 0;
    let onTheRoad = 0;
    let onTheFootpath = 0;
    for (const band of bands) {
      for (let slot = 0; slot < band.slots; slot++) {
        for (let tick = 0; tick < 6000; tick += 37) {
          if (!posePedestrian(band, slot, trafficSeconds(tick), undefined, pose)) continue;
          sampled++;
          // The centreline is x = 0, so the perpendicular offset is |x|.
          const across = Math.abs(pose.x);
          if (across <= kerbEdge) onTheRoad++;
          // And inside the far edge of the concrete.
          if (across <= HALF + KERB_WIDTH + FOOT) onTheFootpath++;
          if (Math.abs(pose.y - (WAY_Y + FOOTPATH_LIFT)) > 1e-3) {
            failures.push(`A walker stands at y = ${pose.y}; the footpath beside a road at ${WAY_Y} is at ${WAY_Y + FOOTPATH_LIFT}.`);
            slot = band.slots;
            break;
          }
        }
      }
    }
    if (sampled === 0) failures.push('No pedestrian was on the synthetic street at any sampled tick.');
    if (onTheRoad > 0) {
      failures.push(
        `${onTheRoad} of ${sampled} sampled pedestrians were inside the kerb line, i.e. standing in ` +
          'the traffic. The footpath offset is too small or its sign is wrong.',
      );
    }
    if (onTheFootpath !== sampled) {
      failures.push(`${sampled - onTheFootpath} of ${sampled} sampled pedestrians were beyond the far edge of the footpath.`);
    }
  }

  // --- DETERMINISM. The same tick, twice, through two decodes of the same bytes.
  {
    const other = syntheticTile(HALF, FOOT, WAY_Y, 10);
    const otherBands = other === null ? [] : buildBands(other, UNIFORM_CROWD);
    if (otherBands.length !== bands.length) {
      failures.push('Two decodes of one sidecar produced different numbers of bands.');
    } else {
      const a = createPedPose();
      const b = createPedPose();
      outer: for (let tick = 0; tick < 40000; tick += 53) {
        const now = trafficSeconds(tick);
        for (let i = 0; i < bands.length; i++) {
          for (let slot = 0; slot < bands[i].slots; slot++) {
            const liveA = posePedestrian(bands[i], slot, now, undefined, a);
            const liveB = posePedestrian(otherBands[i], slot, now, undefined, b);
            if (liveA !== liveB) {
              failures.push(`Two copies of one band disagreed about whether walker ${slot} exists at tick ${tick}.`);
              break outer;
            }
            if (!liveA) continue;
            if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.dx !== b.dx || a.dz !== b.dz || a.kit !== b.kit) {
              failures.push(
                `Two copies of one band put walker ${slot} in different places at tick ${tick}: ` +
                  `(${a.x}, ${a.y}, ${a.z}) vs (${b.x}, ${b.y}, ${b.z}).`,
              );
              break outer;
            }
          }
        }
      }
    }
  }

  // --- CHURN. People come and go rather than walking laps forever, and the
  // street is never empty. Both halves matter: a dwell of zero is a fixed cast
  // and a dwell that swallowed the trip is a ghost town.
  {
    const band = bands[0];
    let present = 0;
    let absent = 0;
    let both = 0;
    const pose = createPedPose();
    for (let slot = 0; slot < band.slots; slot++) {
      let sawPresent = false;
      let sawAbsent = false;
      for (let tick = 0; tick < 30000; tick += 61) {
        if (posePedestrian(band, slot, trafficSeconds(tick), undefined, pose)) {
          present++;
          sawPresent = true;
        } else {
          absent++;
          sawAbsent = true;
        }
      }
      if (sawPresent && sawAbsent) both++;
    }
    if (absent === 0) failures.push('No walker on the synthetic band ever despawned; the population cannot churn.');
    if (present === 0) failures.push('No walker on the synthetic band was ever present.');
    if (both !== band.slots) {
      failures.push(`${band.slots - both} of ${band.slots} walkers never both appeared and disappeared.`);
    }
  }

  // --- THE CENSUS. The same eight-street grid, built at Redfern and again at
  // Dural, through the real `crowdMultiplier` rather than `UNIFORM_CROWD`.
  //
  // This is the negative control for the whole "weight people by density"
  // brief, and it is here rather than in `verifyDensity` because it tests the
  // *wiring*: a field that varies beautifully and a `buildBands` that forgot to
  // multiply by it produce a perfectly healthy `verifyDensity` and a city where
  // Dural still feels like Redfern. The two failures it separates are
  //
  //   - no scaling at all, which comes out as two identical slot totals, and
  //   - scaling so hard the fringe is sterile, which comes out as zero.
  //
  // Zero is a real risk and not a theoretical one: Dural's multiplier is 0.05,
  // a residential band wants 0.011 slots a metre, and a 300 m street therefore
  // wants 0.17 of a walker. Rounded to nearest that is nobody, on every street
  // in the suburb, forever. `buildBand` rounds stochastically on the band seed
  // instead, which is what this section is really guarding -- see there.
  {
    const REDFERN_X = -440.5;
    const REDFERN_Z = 2703.8;
    const DURAL_X = -15230.7;
    const DURAL_Z = -20051.7;
    const slotsAt = (x: number, z: number): number => {
      const g = syntheticGrid(x, z);
      if (g === null) return -1;
      let n = 0;
      for (const b of buildBands(g)) n += b.slots;
      return n;
    };
    const inner = slotsAt(REDFERN_X, REDFERN_Z);
    const fringe = slotsAt(DURAL_X, DURAL_Z);
    const flat = slotsAt(0, 0);
    if (inner < 0 || fringe < 0) {
      failures.push('verifyPedestrians could not build its synthetic grid at a named place.');
    } else {
      if (!(inner > fringe * 4)) {
        failures.push(
          `The same eight streets schedule ${inner} walkers at Redfern and ${fringe} at Dural. The ` +
            'census multiplier is not reaching `buildBands` -- the whole city is still uniform.',
        );
      }
      if (fringe === 0) {
        failures.push(
          'Eight streets at Dural schedule nobody at all. 0.05x is meant to be quiet, not sterile; ' +
            "`buildBand`'s stochastic rounding is what stops the fringe rounding to zero and it is " +
            'not working.',
        );
      }
      if (flat === inner && flat === fringe) {
        failures.push('The grid schedules the same walkers at Redfern, Dural and Town Hall.');
      }
    }
  }

  // --- DENSITY, against a synthetic grid rather than an assertion about one
  // band. Eight streets 200 m long on a 100 m pitch is roughly a CBD block
  // structure, and what is checked is the brief's own number: lively, not
  // crowded, inside 120 m. It sits at the world origin, which is Town Hall, so
  // the figure it reports is the CBD's -- the census multiplier applies here
  // like anywhere else, and the brief's "10-25 inside 120 m" was always a
  // statement about the inner city.
  {
    const grid = syntheticGrid();
    if (grid === null) failures.push('verifyPedestrians could not build its synthetic street grid.');
    else {
      const field = new PedestrianField();
      field.adopt('grid', grid);
      const scratch: PedBand[] = [];
      const pose = createPedPose();
      let total = 0;
      let samples = 0;
      let peak = 0;
      for (let tick = 0; tick < 24000; tick += 811) {
        const n = countPedestriansNear(field, 150, -150, 120, tick, scratch, pose);
        total += n;
        samples++;
        if (n > peak) peak = n;
      }
      const mean = total / samples;
      if (mean < 8) {
        failures.push(`Only ${mean.toFixed(1)} people are visible inside 120 m of a synthetic city block; the brief asks for 10-25.`);
      }
      if (mean > 34) {
        failures.push(`${mean.toFixed(1)} people are visible inside 120 m of a synthetic city block; that is a crowd, not a footpath.`);
      }
      if (peak > 60) {
        failures.push(`The synthetic block peaked at ${peak} people inside 120 m.`);
      }

      // --- THE LOD CAPS. The renderer's own two numbers, checked against what
      // this schedule can actually put in front of it. A cap that is never
      // reached is fine; a cap the renderer does not enforce is a frame-time
      // cliff, and that half is asserted by `world/people.ts` refusing to write
      // past its instance capacity -- this half asserts the caps are sane.
      if (caps) {
        if (!(caps.rigs > 0) || caps.rigs > 24) {
          failures.push(`The near tier is capped at ${caps.rigs} skinned rigs; that is outside the 1-24 this was budgeted for.`);
        }
        if (!(caps.impostors >= peak)) {
          failures.push(
            `The far tier holds ${caps.impostors} instances and a synthetic block put ${peak} people ` +
              'inside 120 m alone. People would vanish in the middle of the street.',
          );
        }
      }

      // --- The broadphase finds what the flat list has.
      const all = field.bands().length;
      if (all === 0) failures.push('The field holds no bands after adopting a tile full of streets.');
      field.drop('grid');
      if (field.bands().length !== 0) failures.push('Dropping a tile left its footpath bands in the field.');
      if (field.cellCount !== 0) failures.push(`Dropping the only tile left ${field.cellCount} broadphase cell(s) behind.`);

      // --- And the index's order does not depend on arrival order.
      //
      // `TrafficField`'s own self-check, on this side. The stakes are the same
      // shape: `forEachPedestrianNear` and `factions.forEachPoliceNear` both
      // take the *nearest* and break ties by iteration order, so a band pool
      // that reordered when a tile arrived early would put an officer on a
      // different street in two processes holding the identical city.
      {
        const forwards = new PedestrianField();
        const backwards = new PedestrianField();
        const cycled = new PedestrianField();
        const halves: TileLanes[] = [
          { ways: grid.ways.filter((_, i) => i % 2 === 0), routes: [] },
          { ways: grid.ways.filter((_, i) => i % 2 === 1), routes: [] },
        ];
        forwards.adopt('a', halves[0]);
        forwards.adopt('b', halves[1]);
        backwards.adopt('b', halves[1]);
        backwards.adopt('a', halves[0]);
        cycled.adopt('a', halves[0]);
        cycled.adopt('b', halves[1]);
        cycled.drop('a');
        cycled.adopt('a', halves[0]);
        const a: PedBand[] = [];
        const b: PedBand[] = [];
        const c: PedBand[] = [];
        forwards.near(0, 0, 400, a);
        backwards.near(0, 0, 400, b);
        cycled.near(0, 0, 400, c);
        if (a.length < 2) {
          failures.push(`The band order check only found ${a.length} band(s); it needs at least two.`);
        } else if (a.length !== b.length || a.length !== c.length) {
          failures.push(`Three load orders gave ${a.length}, ${b.length} and ${c.length} bands for one query.`);
        } else {
          for (let i = 0; i < a.length; i++) {
            // Content rather than identity: `buildBands` makes fresh objects on
            // every adopt, so the three fields hold three sets of them.
            if (
              a[i].osmId !== b[i].osmId || a[i].osmId !== c[i].osmId ||
              a[i].side !== b[i].side || a[i].side !== c[i].side ||
              a[i].seed !== b[i].seed || a[i].seed !== c[i].seed
            ) {
              failures.push(
                `The broadphase returned band ${i} of ${a.length} differently depending on the order ` +
                  'the tiles were adopted; the police pick the nearest officer and break ties by that ' +
                  'order, so two processes would put the same beat on different streets.',
              );
              break;
            }
          }
        }
      }
    }
  }

  // --- BEING LAUNCHED, AND BEING KILLED. See `LAUNCH_SECONDS` and `GIB_SPEED`.
  //
  // A car's hit throws the body along the car's own heading -- a hop and a
  // slide that is over inside `LAUNCH_SECONDS` -- and a hit past `GIB_SPEED`
  // keeps the walker down for `DEAD_SECONDS`. The flight is what the police
  // pass and every screen agree on, so it is checked as arithmetic here.
  {
    const field = new PedestrianField();
    field.adopt('synthetic', tile);
    const scratch: PedBand[] = [];
    const probe = createPedPose();
    let key = -1;
    let x0 = 0;
    let z0 = 0;
    let y0 = 0;
    const hitTick = 1200;
    forEachPedestrianNear(field, 250, 250, 900, hitTick, scratch, probe, (p) => {
      key = p.key;
      x0 = p.x;
      y0 = p.y;
      z0 = p.z;
      return true;
    });
    if (key < 0) failures.push('No walker to launch on the synthetic band.');
    else {
      const now = trafficSeconds(hitTick);
      const record = field.knockDown(key, hitTick, now, x0, z0, 8, 0, false);
      if (record === null) failures.push('A standing walker could not be launched.');
      else {
        const bandOf = field.near(x0, z0, 2, scratch).find((b) => pedKey(b.osmId, b.side, 0) <= key && key < pedKey(b.osmId, b.side, 0) + MAX_SLOTS);
        const slot = bandOf === undefined ? -1 : key - pedKey(bandOf.osmId, bandOf.side, 0);
        if (bandOf === undefined || slot < 0) failures.push('The launched walker\'s band could not be found again.');
        else {
          const mid = createPedPose();
          posePedestrian(bandOf, slot, now + 0.3, record, mid);
          const flown = Math.sqrt((mid.x - x0) ** 2 + (mid.z - z0) ** 2);
          if (!(flown > 1.5 && flown < 3)) failures.push(`0.3 s into an 8 m/s launch the body is ${flown.toFixed(2)} m from where it stood; it should be about 2.`);
          if (!(mid.y > y0 + 0.2)) failures.push(`0.3 s into a launch the body is ${(mid.y - y0).toFixed(2)} m up; a hop should have it off the ground.`);
          if (Math.abs(mid.vx - 8) > 1e-9 || mid.vz !== 0 || mid.gib) failures.push('The pose does not carry the launch it is flying.');
          const rest = createPedPose();
          posePedestrian(bandOf, slot, now + LAUNCH_SECONDS + 0.5, record, rest);
          const slid = Math.sqrt((rest.x - x0) ** 2 + (rest.z - z0) ** 2);
          const expect = 8 * LAUNCH_SECONDS / 2;
          if (Math.abs(slid - expect) > 0.05) failures.push(`After the launch the body lies ${slid.toFixed(2)} m from where it stood; a ${LAUNCH_SECONDS} s slide from 8 m/s is ${expect.toFixed(2)}.`);
          if (Math.abs(rest.y - y0) > 1e-6) failures.push('The body did not come back to the ground after its hop.');
          if (!rest.down) failures.push('The launched body is not down.');
          const later = createPedPose();
          posePedestrian(bandOf, slot, now + LAUNCH_SECONDS + 1.0, record, later);
          if (Math.abs(later.x - rest.x) > 1e-6 || Math.abs(later.z - rest.z) > 1e-6) failures.push('A landed body kept moving.');
        }
      }
      // And a kill. A fresh field, so the re-hit guard is not what answers.
      const morgue = new PedestrianField();
      morgue.adopt('synthetic', tile);
      const dead = morgue.knockDown(key, hitTick, now, x0, z0, 12, 3, true);
      if (dead === null) failures.push('A standing walker could not be killed.');
      else {
        if (dead.seconds !== DEAD_SECONDS || !dead.gib) failures.push(`A kill lasts ${dead.seconds} s and gib ${dead.gib}; it should be ${DEAD_SECONDS} s and true.`);
        if (morgue.knockDown(key, hitTick + 60, now + 1, x0, z0) !== null) failures.push('A killed walker was knocked down again.');
      }
    }
  }

  // --- WORKSTREAM AB: the broadphase dedupes, and it dedupes *completely*.
  //
  // `near` stamps each candidate with the id of the query that has already
  // decided about it, where it used to scan the output with `indexOf`. The two
  // failures a stamp can have are opposite and both silent:
  //
  //   - a band returned **twice** (the stamp never set, or reset between cells)
  //     is every pedestrian on that footpath drawn twice, at the same place, and
  //     counted twice against the impostor cap -- which reads as the far end of
  //     the street being empty.
  //   - a band returned **not at all** (the stamp set before the bounds test in
  //     a way that also swallows the accept) is a footpath with nobody on it,
  //     which is indistinguishable from a quiet street.
  //
  // A band spans several 128 m cells by construction -- a way is clipped to a
  // 500 m tile -- so the multi-cell case is the ordinary one rather than an edge
  // case to contrive.
  {
    const field = new PedestrianField();
    field.adopt('synthetic', tile);
    const all = field.bands();
    const out: PedBand[] = [];
    // A radius that certainly spans several cells and certainly reaches every
    // band in a 500 m synthetic tile.
    field.near(250, 250, 900, out);
    const seen = new Set<PedBand>();
    for (const band of out) {
      if (seen.has(band)) {
        failures.push(
          `The broadphase returned the same band twice out of ${out.length}. Every walker on it is drawn ` +
            'twice and counted twice against the impostor cap.',
        );
        break;
      }
      seen.add(band);
    }
    if (out.length !== all.length) {
      failures.push(
        `A query reaching the whole tile returned ${out.length} of ${all.length} bands; ` +
          'the dedupe stamp is swallowing bands the bounds test accepted.',
      );
    }
    // And two queries in a row give the same answer -- the stamp must not leave
    // a band looking "already decided" to the next query, which would empty the
    // street on every second frame.
    const again: PedBand[] = [];
    field.near(250, 250, 900, again);
    if (again.length !== out.length) {
      failures.push(
        `Two identical queries returned ${out.length} then ${again.length} bands; ` +
          'the query stamp is not advancing and the second frame sees nothing.',
      );
    }
  }

  // --- BEING CLOBBERED. The knockdown, the re-hit guard, and -- the one that
  // matters -- that getting up is continuous with the walk that was interrupted.
  {
    const field = new PedestrianField();
    field.adopt('synthetic', tile);
    const band = field.bands()[0];
    const pose = createPedPose();
    const before = createPedPose();
    const after = createPedPose();

    // Find a tick where slot 0 is on the footpath.
    let hitTick = -1;
    for (let tick = 0; tick < 6000; tick += 13) {
      if (posePedestrian(band, 0, trafficSeconds(tick), undefined, before)) {
        hitTick = tick;
        break;
      }
    }
    if (hitTick < 0) failures.push('No walker was ever present on the synthetic band; the knockdown check could not run.');
    else {
      const key = pedKey(band.osmId, band.side, 0);
      const seconds = downSeconds(key, hitTick);
      if (seconds < DOWN_MIN || seconds > DOWN_MIN + DOWN_SPAN) {
        failures.push(`A knockdown lasts ${seconds.toFixed(2)} s; it must be inside [${DOWN_MIN}, ${DOWN_MIN + DOWN_SPAN}].`);
      }
      if (downSeconds(key, hitTick) !== seconds) failures.push('The downtime is not a pure function of (key, tick).');

      const now = trafficSeconds(hitTick);
      const record = field.knockDown(key, hitTick, now);
      if (record === null) failures.push('A standing pedestrian could not be knocked down.');
      else {
        if (field.knockDown(key, hitTick + 1, trafficSeconds(hitTick + 1)) !== null) {
          failures.push('Somebody lying on the footpath was knocked down again; the re-hit guard is not working.');
        }
        // Pinned while down.
        const mid = now + seconds * 0.5;
        posePedestrian(band, 0, mid, record, pose);
        if (!pose.down) failures.push('A pedestrian halfway through their downtime was not reported as down.');
        if (Math.abs(pose.x - before.x) > 1e-6 || Math.abs(pose.z - before.z) > 1e-6) {
          failures.push('A pedestrian slid along the footpath while lying on it.');
        }
        // And continuous on the way back up. The whole point of the offset.
        posePedestrian(band, 0, record.upAt, record, after);
        if (after.down) failures.push('A pedestrian was still down at the instant they were due to stand up.');
        if (Math.abs(after.x - before.x) > 1e-4 || Math.abs(after.z - before.z) > 1e-4) {
          failures.push(
            `Getting up moved a pedestrian ${Math.abs(after.x - before.x).toFixed(3)} m; the schedule ` +
              'offset is wrong and they teleport when they stand.',
          );
        }
        if (after.dx !== before.dx || after.dz !== before.dz) {
          failures.push('A pedestrian got up facing a different way from the one they were knocked over in.');
        }
      }
    }
  }

  return failures;
}

/**
 * A tile carrying `count` copies of one 200 m due-north street, encoded and
 * decoded through the real format so the checks above test the shipped bytes.
 *
 * The streets are spaced 100 m apart in x and the whole set is repeated in z,
 * which makes `syntheticGrid` a two-line variation on it.
 */
function syntheticTile(half: number, foot: number, wayY: number, points: number): TileLanes | null {
  return encodeWays([{ x: 0, z: 0, dz: -200, half, foot, y: wayY, points, klass: 10 }]);
}

/** Eight 200 m streets on a 100 m pitch: four running north, four running east. */
/**
 * Eight streets 200 m long on a 100 m pitch: roughly a CBD block structure,
 * encoded and decoded through the real format.
 *
 * **Exported for the checks, not for the game**, on `traffic.syntheticTile`'s
 * terms and for its reason. `verifyCharacters` needs a `PedestrianField` with
 * real bands in it to prove that WORKSTREAM AA's pose gate refuses nobody the
 * ungated sweep would have found, and building the bytes a second time over
 * there would be a check whose fixture is a copy of the fixture.
 */
export function syntheticGrid(originX = 0, originZ = 0): TileLanes | null {
  const ways: SyntheticWay[] = [];
  for (let i = 0; i < 4; i++) {
    ways.push({ x: i * 100, z: 0, dz: -300, half: 3.75, foot: 3, y: 0, points: 4, klass: 10 });
    ways.push({ x: 0, z: -i * 100, dx: 300, half: 3.75, foot: 3, y: 0, points: 4, klass: 10 });
  }
  return encodeWays(ways, originX, originZ);
}

interface SyntheticWay {
  x: number;
  z: number;
  dx?: number;
  dz?: number;
  half: number;
  foot: number;
  y: number;
  points: number;
  klass: number;
}

/**
 * Write a ways-only `.lanes.bin` and read it back through `decodeLanes`.
 *
 * Ways-only: the route count is zero, which is a legal sidecar (a cul-de-sac
 * suburb with no traffic scheduled on it is common -- see `streamer.TileEntry`)
 * and is exactly the block this feature reads.
 */
function encodeWays(ways: SyntheticWay[], originX = 0, originZ = 0): TileLanes | null {
  let bytes = 16;
  for (const w of ways) bytes += 16 + w.points * 12;
  const buffer = new ArrayBuffer(bytes);
  const v = new DataView(buffer);
  v.setUint32(0, 0x454e414c, true); // 'LANE'
  // The version this build reads rather than a literal 1. The routes block is
  // where lanes v2 grew its park block, and this encoder writes none -- but a
  // decoder that refuses the version refuses the whole file, so a literal here
  // would have made every pedestrian check fail on a format bump that has
  // nothing to do with footpaths.
  v.setUint32(4, LANES_VERSION, true);
  v.setUint32(8, ways.length, true);
  v.setUint32(12, 0, true);
  let o = 16;
  for (const w of ways) {
    v.setUint32(o, 0, true);
    v.setUint8(o + 4, w.klass);
    v.setUint8(o + 5, 0);
    v.setUint16(o + 6, w.points, true);
    v.setFloat32(o + 8, w.half, true);
    v.setFloat32(o + 12, w.foot, true);
    o += 16;
    for (let i = 0; i < w.points; i++) {
      const t = i / (w.points - 1);
      v.setFloat32(o, w.x + (w.dx ?? 0) * t, true);
      v.setFloat32(o + 4, w.y, true);
      v.setFloat32(o + 8, w.z + (w.dz ?? 0) * t, true);
      o += 12;
    }
  }
  // The routes block is empty, so the crowd function is never consulted here --
  // the origin is what moves this street to Redfern or to Dural, and it is the
  // ways it moves. See the census section in `verifyPedestrians`.
  const tile = decodeLanes(buffer, originX, originZ);
  if (tile === null || tile.ways.length !== ways.length) return null;
  return tile;
}
