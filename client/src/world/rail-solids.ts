/**
 * The railway's solids, as arithmetic: the half of `world/rail-geo.ts` that is
 * not a renderer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `STATIONS.md` ends on one rule -- **a boundary may have many renderings and
 * exactly one definition** -- and names the shape the answer has to take:
 *
 * > This is not a new pattern here -- it is what `PlatformField` already does,
 * > and for the same stated reason: the drawn prisms exist only in a browser and
 * > only near the player, so the arithmetic version is the one the server can
 * > answer from. That worked. Generalise it rather than inventing something.
 *
 * Until this file, `PlatformField` was the *only* thing generalised. Everything
 * else the railway stands on -- a trench wall's coping, a viaduct deck, a pier,
 * a footbridge, a station building, a flight of access stairs, the head of a
 * subway shaft -- existed solely as a `CollisionWorld` prism written by
 * `rail-geo.buildChunk`, and `buildChunk` runs in a browser inside
 * `BUILD_RADIUS`. The server process has no renderer and therefore had no rail
 * geometry at all, so the two ends of the wire disagreed about where the ground
 * is at **54,293 of 670,437** points sampled over the station envelopes, worst
 * 14.0 m. Where they disagree the server wins and the player is corrected into
 * or out of geometry they can see.
 *
 * So the definition moves here, where both ends can evaluate it, and
 * `rail-geo.ts` becomes one of its two renderings:
 *
 *   - `RailSolidField.roofHeight` answers the ground query, on both ends, with
 *     exactly `CollisionWorld.roofHeight`'s semantics over exactly the boxes
 *     below;
 *   - `rail-geo` draws those same boxes and hands those same boxes to
 *     `CollisionWorld` for blocking. It does not re-measure one of them.
 *
 * **There is no epsilon and no agreement-by-diligence on that path.** The
 * client's prism and the server's arithmetic are the same numbers because they
 * come out of the same call, not because two functions were written to match.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOXES ARE IN A TRACK FRAME AND NOT WORLD POLYGONS
 *
 * Every solid the station kit builds is `frameBar`'s one primitive -- a box
 * between `t0..t1` along a frame and `o0..o1` across it, from `y0` to `y1` --
 * and that is what a `FrameSolid` is. A world polygon would be a *derived*
 * artifact of it, so storing one would be the second description this file
 * exists to abolish. `framePlan` derives the ring where a prism is wanted and
 * `frameBox` derives the six quads where a mesh is; the box itself is the fact.
 *
 * The one apparent exception, the subway shaft head, is axis aligned in world
 * space rather than in a track frame -- so it is carried in an identity frame,
 * which `framePoint` reduces to `[x + t, y, z + o]`. Same primitive, different
 * frame, no second code path.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTHING IS BUILT UNTIL IT IS ASKED FOR
 *
 * Memory, measured rather than guessed. `STATIONS.md`'s constraint read
 * forwards: an arithmetic form is cheap and a prism set is not. There are 361
 * stations carrying ~96 solids each and 22,390 segments carrying up to ten, so
 * building the lot at boot is six figures of `Float32Array` on a box with
 * `MemoryHigh` at 587 MB. Built where somebody stands, a whole-city sweep holds
 * 95,537 records and a process that never leaves the CBD holds a few hundred.
 * `RailSolidField` therefore indexes two grids at boot -- station anchors and
 * segment bounds, both integers -- and computes a solid the first time a query
 * lands on it.
 *
 * The companion rule is there for correctness rather than for memory: an answer
 * measured against terrain that had not arrived is **never** cached.
 * `StationPlan.measured` and `TrenchProfile.complete` already say which answers
 * are guesses, so `RailWorld.retryProvisional`'s rule costs one `if` here.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED HERE UNCHANGED, AND WHY THAT MATTERS
 *
 * `buildNetwork`, `planStation`, `trackClear`, the frame helpers and the
 * dimensions of a railway were `rail-geo.ts`'s and are byte for byte what they
 * were. They are here rather than there for one reason: `rail-geo.ts` imports
 * `three/webgpu` at module scope, and a server that imported it would pay for a
 * renderer to ask where the ground is. Nothing in this file imports anything a
 * headless process cannot have.
 */

import {
  SPAN_BRIDGE,
  SPAN_TUNNEL,
  type RailBake,
  type RailStation,
} from '../game/rail.ts';
import {
  STATION_HALF_WIDTH,
  TRENCH_MIN_DEPTH,
  drawnAsTunnel,
  type RailCut,
} from './rail-cut.ts';
import { pointInPolygon } from '../player/collision.ts';
import { DECK_THICKNESS_M } from './road-deck.ts';
import { RAIL_HALF_M } from './envelope.ts';
import { PLATFORM_OUTER_M, samePlatform } from '../game/riding.ts';

/**
 * What `world/rail-geo.ts` hands `CollisionWorld`, and what this file evaluates.
 *
 * The same two methods `rail-geo` has always taken, moved here with the boxes
 * they carry so the interface and its content are in one place.
 */
export interface RailSolids {
  addPrisms(key: string, prisms: ReadonlyArray<{ points: Float32Array; height: number; base: number }>): number;
  removeTile(key: string): number;
}

/** Ground height at a point, or `NaN` where no terrain is loaded. */
export type GroundAt = (x: number, z: number) => number;

// --- The dimensions of a railway ------------------------------------------------
//
// Standard gauge and the NSW loading gauge, in metres. The polyline's y is the
// **rail head**: everything below is measured down from it and everything above,
// up.

export const GAUGE_HALF = 0.7175;
export const RAIL_HALF_WIDTH = 0.035;
export const RAIL_HEIGHT = 0.17;
/** Ballast top, below the rail head: the sleeper is buried to its shoulders. */
export const BALLAST_TOP_DROP = 0.2;
export const BALLAST_DEPTH = 0.55;
export const BALLAST_TOP_HALF = 2.2;
export const BALLAST_BASE_HALF = 3.3;

export const SLEEPER_PITCH = 0.65;
export const SLEEPER_HALF_LENGTH = 1.3;
export const SLEEPER_HALF_WIDTH = 0.13;
export const SLEEPER_HEIGHT = 0.2;

/** Viaduct deck: the slab the ballast sits on, and how far its soffit is down. */
export const DECK_HALF_WIDTH = 3.9;
export const DECK_DEPTH = 1.15;
export const PIER_SPACING = 26;
export const PIER_HALF = 0.85;

/** Tunnel bore: a lining tube around the track and nothing else. See the brief. */
export const TUNNEL_RADIUS = 3.4;
export const TUNNEL_SIDES = 10;
/** Bore centre, above the rail head. */
export const TUNNEL_RISE = 1.9;
/** Portal headwall: how far it stands proud of the bore. */
export const PORTAL_MARGIN = 1.1;
export const PORTAL_THICKNESS = 0.9;

/**
 * The cutting. Where the ground has been taken away by `world/rail-cut.ts`,
 * this is what stands in the hole.
 *
 * `TRENCH_BATTER` is the lean of the retaining wall, horizontal over vertical.
 * A real cutting wall is between 1:4 and 1:8 depending on whether it is
 * sandstone, brick or sprayed concrete; 1:6 reads as a wall rather than as an
 * embankment and keeps a 13 m cutting's foot 2.2 m inboard of its top, which is
 * still clear of the ballast.
 *
 * `TRENCH_STEP_M` is how often the wall re-reads the terrain along the run. The
 * bake's segments average 40 m, which is longer than a DEM post, so a wall built
 * as one ruled quad per segment would leave its top a metre off the rim of the
 * hole in the middle of every span. Eight metres tracks the grid closely enough
 * that the two never part company by more than a few centimetres.
 */
export const TRENCH_BATTER = 1 / 6;
export const TRENCH_STEP_M = 8;
/** The coping: how far the wall's top laps *over* the rim of the hole. */
export const TRENCH_COPING = 0.5;
/** And how far it stands over the ground, so the lap is never a hairline. */
export const TRENCH_COPING_RISE = 0.12;
/** The wall foot never comes inboard of this, whatever the batter says. */
export const TRENCH_FOOT_MIN = BALLAST_BASE_HALF + 0.3;
/** Below this a wall is not worth its triangles; the track is at grade. */
export const TRENCH_MIN_HEIGHT = 0.45;

/** Overhead line. Contact wire at the regulated height above the rail head. */
export const CONTACT_HEIGHT = 5.1;
export const MESSENGER_HEIGHT = 6.35;
export const MAST_HEIGHT = 7.4;
export const MAST_OFFSET = 3.15;
export const MAST_RADIUS = 0.14;
export const GANTRY_HALF_SPAN = 9.5;

/** Platform: 160 m is an eight-car Tangara with a few metres in hand. */
export const PLATFORM_HALF_LENGTH = 80;
export const PLATFORM_WIDTH = 5.5;
export const PLATFORM_HEIGHT = 1.05;
/** Platform edge, from the track centre. Real NSW clearance is about 1.6 m. */
export const PLATFORM_INNER = 1.62;
export const CANOPY_HALF_LENGTH = 34;
export const CANOPY_HEIGHT = 3.9;
export const CANOPY_OVERHANG = 0.7;

/** Underground box: the room the platforms stand in. */
export const BOX_HALF_LENGTH = 88;
export const BOX_HALF_WIDTH = 13;
export const BOX_HEIGHT = 7.5;
export const SHAFT_HALF = 3.2;

/** Sign blade, in the street-sign spirit: a small plate on two posts. */
export const SIGN_WIDTH = 3.6;
export const SIGN_HEIGHT = 0.45;
export const SIGN_Y = 2.6;

/**
 * The street-level station board. See `writeStationBoard`.
 *
 * Bigger than the platform blade on both axes and higher off its own datum,
 * because the reader is further away and is looking for the station rather than
 * confirming which one they are standing in. 4.2 m at 3.4 m up subtends about
 * the same angle at 60 m that the blade does at 20.
 */
export const BOARD_WIDTH = 4.2;
export const BOARD_HEIGHT = 1.1;
export const BOARD_Y = 3.4;

// --- The corridor, past the ballast -------------------------------------------
//
// Everything between the track and the street, which before this round was
// nothing at all: the railway stopped at the toe of its own ballast and the
// suburb started, with no edge between them. Reported in those words -- *"rails
// painted on a car park"* -- and `RAIL-VERTICAL.md` section 6 names the fence as
// the mitigation for the one case no measurement can recover.

/** The boundary fence, from the track centre, where nothing else decides. */
export const FENCE_OFFSET = 6.4;
/** ...and how far outside a carved corridor rim it stands where there is one. */
export const FENCE_CLEAR = 0.9;
/**
 * A parallel track within this distance, on a side, means that side is **inside
 * the corridor** and gets no fence and no verge.
 *
 * The bake's polylines are one per *track*, not one per corridor: the up and
 * down roads of a double-track railway are separate OSM ways four metres apart
 * and `buildNetwork` deliberately does not merge them (see section 2). So a
 * naive fence per segment would run a fence **between the running lines** of
 * every double-track railway in Sydney, four metres from each rail, which is
 * both absurd and twice the geometry. `markCorridorEdges` decides once, at load,
 * which sides of which segments are the outside of the corridor.
 *
 * 8.2 m rather than `FENCE_OFFSET`: it must exceed the offset the fence would
 * have been built at, or a four-road corridor fences its two middle roads.
 */
export const CORRIDOR_NEIGHBOUR = 8.2;
/** How often the fence and the verge re-read the ground. `TRENCH_STEP_M`'s twin. */
export const VERGE_STEP_M = 8;
/** The verge never climbs or falls further than this from the formation. */
export const VERGE_RELIEF = 2.4;
/** Where the ballast's toe ends and the cess begins, from the track centre. */
export const CESS_INNER = BALLAST_BASE_HALF - 0.15;

// --- Access, which is generated and never looked up ----------------------------
//
// `RAIL-VERTICAL.md` section 4, in one sentence: **a station cannot lack access,
// because the same number that made it need access generates it.** Two reports
// -- *"im at roseville and cant get up to the platform"* and a player on the
// Chatswood plaza reading "doors 23 m away" with no way down to them -- are the
// same defect, and it is the defect of treating a staircase as content.
//
// So there is no lookup here and no OSM tag consulted. There is a measured drop
// from the ground beside a platform to the top of it, and a flight of steps
// whose length is that drop divided by a gradient.

/** Riser and going. The gradient is 0.61, which is a public stair. */
export const STAIR_RISE = 0.19;
export const STAIR_GOING = 0.31;
/**
 * A drop smaller than this is walked, not climbed, and no flight is built.
 *
 * **It is `controller.STEP_HEIGHT` and it has to be.** That constant is what
 * decides whether a body walks up a kerb or into it, so a station whose platform
 * stands 0.5 m over the ground is a station nobody can board while a stair
 * threshold set by eye at 0.8 m would have called it "at grade" and built
 * nothing. Duplicated rather than imported for `game/rail.ts`'s reason -- this
 * module must build in a process with no player in it -- and the integration
 * check is where the two are proved equal.
 */
export const STAIR_FLAT = 0.42;
/** Bounded, because a 40 m shaft is a switchback and this builder has no turn. */
export const STAIR_MAX_STEPS = 170;
/**
 * The flight's band, from the track centre: outside the platform's own face and
 * in to the rim of the carved corridor.
 *
 * The platform's outer face is at `PLATFORM_INNER + PLATFORM_WIDTH` = 7.12 m and
 * `rail-cut.STATION_HALF_WIDTH` is 9.4 m, so this is exactly the strip the carve
 * already opens at every platform site and nothing else wants. In a cutting the
 * flight is therefore *cut into the trench wall*, which is section 4's own
 * instruction and is also where a real one is; at grade and on an embankment it
 * is a free-standing stair against the platform's flank.
 */
export const STAIR_INNER = PLATFORM_INNER + PLATFORM_WIDTH + 0.12;
export const STAIR_OUTER = STATION_HALF_WIDTH;
/** Where the flight meets the platform, along it. Clear of the canopy. */
export const ACCESS_ALONG = 44;
/** How far the boundary fence opens at an entrance. See `writeVerge`. */
export const FENCE_GAP_RADIUS = 10;

/**
 * The footbridge deck, above the rail head.
 *
 * Over the overhead line and over the masts that carry it: `MAST_HEIGHT` is
 * 7.4 m and the messenger is at 6.35, so a soffit at 8.05 is the first height
 * that clears the electrification rather than passing through it.
 */
export const BRIDGE_CLEAR = 8.4;
export const BRIDGE_DECK = 0.35;
export const BRIDGE_ALONG = -50;
export const BRIDGE_RUN = 2.6;
export const BRIDGE_RAIL_H = 1.15;
/** Below this clearance over the ground the bridge is not built. See `writeFootbridge`. */
export const BRIDGE_MIN_OVER_GROUND = 2.5;

/** The station building at the street end: a brick box with an awning. */
export const HOUSE_LENGTH = 11;
export const HOUSE_WIDTH = 6.5;
export const HOUSE_HEIGHT = 3.9;
export const HOUSE_AWNING = 1.6;

/** Platform edge: the tactile strip and the coping it sits behind. */
export const TACTILE_INSET = 0.11;
export const TACTILE_WIDTH = 0.42;
/** How far the coping stands over the deck, so it takes a light and drops a line. */
export const COPING_RISE = 0.025;

// --- Chunking -------------------------------------------------------------------

export const CHUNK_M = 512;
/** Chunks whose box is inside this are built. */
export const BUILD_RADIUS = 1100;
/**
 * Chunks built per frame, and the reason this is not "all of them".
 *
 * Measured on the shipped build: a full ring reshape at a 512 m boundary is
 * **10-17 ms**, which is a dropped frame every 512 m walked and every 12 s on a
 * bike. Spread over frames it is under a millisecond each and the ring simply
 * fills in behind the player, which is what the tile streamer does with a much
 * larger payload for exactly this reason. Two per frame at 60 Hz fills a
 * fifteen-chunk ring in an eighth of a second.
 */
export const BUILDS_PER_FRAME = 2;
/**
 * And a millisecond ceiling across those two, because the count alone was not
 * the bound it reads as.
 *
 * The paragraph above sizes `BUILDS_PER_FRAME` against a *typical* chunk, and
 * for a typical chunk it is right: the median build is 2.4 ms. But the
 * distribution has a long tail — a chunk holding a station, a junction throat
 * or a viaduct is a different object from a chunk of plain double track, and
 * riding Emu Plains to Berowra measures **p95 26 ms and a worst frame of 85 ms**
 * (`client/src/perf-harness.ts --coverage` prints the run). Two of the bad ones
 * landing in the same frame is five frames dropped, and at 2.25 building frames
 * per kilometre a rider meets one about every fifteen seconds. That is the
 * "little freezes on the train" this constant exists to stop.
 *
 * **A check between builds, not a pre-emption** — the same shape, and the same
 * honesty about its limit, as `world/streamer.ts`' `BUILD_BUDGET_MS`: the first
 * chunk of a frame always runs, so a single expensive chunk is untouched by
 * this. What it removes is the second one queued behind it.
 *
 * **And measurement says that is the smaller half.** Re-running the ride with
 * this ceiling in place moved the worst frame not at all — 84.9 ms before,
 * 85.8 ms after, inside the noise — while building frames went 214 → 224, which
 * is the ceiling deferring work to later frames exactly as intended. Both
 * numbers together say the worst frame is **one** chunk, not two stacking: a
 * station throat or a junction is forty times the cost of plain double track
 * and no per-frame count can divide it. Cutting that tail means splitting a
 * single `buildChunk` across frames — its dozen `add(...)` calls are the
 * natural seam — which is a real restructuring and wants its own pass. This
 * constant is the cheap half, kept because it is correct and costs nothing.
 *
 * Deliberately under a frame at 60 Hz. The queue survives across frames — that
 * is what `pending` is — so nothing is lost by stopping early; the ring simply
 * fills a frame or two later, exactly as it already does behind a walking
 * player.
 */
export const RAIL_BUILD_BUDGET_MS = 8;
/** And disposed past this. The hysteresis is the streamer's own pattern. */
export const KEEP_RADIUS = 1500;
/** How many times a chunk is rebuilt waiting for terrain. See `retryProvisional`. */
export const PROVISIONAL_ATTEMPTS = 4;
/** Sleepers are geometry only this close; past it the ballast ribbon reads. */
export const SLEEPER_RADIUS = 165;
export const MAST_RADIUS_M = 520;
export const SLEEPER_CAPACITY = 7000;
export const CANTILEVER_CAPACITY = 700;
export const GANTRY_CAPACITY = 260;
/** The always-on corridor layer's cell, which is coarse because it never moves. */
export const FAR_CELL_M = 8192;
export const FAR_DROP = 0.3;
export const FAR_HALF_WIDTH = 1.8;

// --- The network index --------------------------------------------------------------

/** One length of track, after the twenty polylines have been deduplicated. */
export interface Segment {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  flags: number;
  /** Plan length, and the unit plan direction. Computed once. */
  len: number;
  ux: number; uz: number;
  /**
   * Is this side of this segment the **outside of the corridor**?
   *
   * `open[0]` is the `-1` side and `open[1]` the `+1` side, in the same
   * `(px, pz) = (-uz, ux)` frame every writer here uses. Set once by
   * `markCorridorEdges` and read only by `writeVerge`. See `CORRIDOR_NEIGHBOUR`
   * for what a false answer here would build.
   */
  open: [boolean, boolean];
}

/** A tunnel mouth: where the flags flip between one vertex and the next. */
export interface Portal {
  x: number; y: number; z: number;
  /** Unit plan direction, pointing **into** the tunnel. */
  ux: number; uz: number;
}

/**
 * A station as this file draws it: the bake's record, moved to where the trains
 * actually stop, with the track heading there and **the OSM node it came from**.
 *
 * `x, z` is the routed stopping anchor and `nodeX, nodeZ` is the station node,
 * and the two are as much as 248 m apart -- see `buildNetwork`, which spends a
 * page on why the platform goes at the first and not the second. `nodeX, nodeZ`
 * is kept because it is the only thing in the bake that says where the *street*
 * side of a station is: an OSM station node sits at the entrance, not on the
 * track, so the vector from the anchor to the node is the direction a passenger
 * arrives from. `writeStationHouse` is its one reader.
 */
export type PlacedStation = RailStation & {
  ux: number; uz: number;
  nodeX: number; nodeZ: number;
};

export interface Chunk {
  segments: number[];
  masts: number[];
  portals: number[];
  stations: number[];
}

/** Everything derived from the bake once, before a single triangle is built. */
export interface RailNetwork {
  bake: RailBake;
  segments: Segment[];
  portals: Portal[];
  /** Stations that sit on the heavy-rail network, with the track heading at each. */
  stations: PlacedStation[];
  chunks: Map<string, Chunk>;
  /** What the deduplication actually saved. Printed at boot. */
  directedSegments: number;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function chunkOf(x: number, z: number): string {
  return chunkKey(Math.floor(x / CHUNK_M), Math.floor(z / CHUNK_M));
}

export function bucket(chunks: Map<string, Chunk>, key: string): Chunk {
  let c = chunks.get(key);
  if (c === undefined) {
    c = { segments: [], masts: [], portals: [], stations: [] };
    chunks.set(key, c);
  }
  return c;
}

/**
 * Deduplicate the twenty polylines into a segment set, find the tunnel mouths,
 * orient the stations, and file everything by chunk.
 *
 * Runs once at load. The dedup key is described in section 2; the quantisation
 * is 25 mm, which is four orders of magnitude finer than any two distinct rails
 * in this city are apart and two orders coarser than f32 round-trip error at
 * 60 km from the origin.
 */
export function buildNetwork(bake: RailBake): RailNetwork {
  const segments: Segment[] = [];
  const seen = new Map<string, number>();
  const p = bake.vertices;
  const flags = bake.vertexFlags;
  let directed = 0;

  const q = (v: number): number => Math.round(v * 4);

  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        directed++;
        const ax = p[i * 3];
        const ay = p[i * 3 + 1];
        const az = p[i * 3 + 2];
        const bx = p[(i + 1) * 3];
        const by = p[(i + 1) * 3 + 1];
        const bz = p[(i + 1) * 3 + 2];
        // Canonical order, so a segment and its reverse hash the same.
        const forward = ax < bx || (ax === bx && az <= bz);
        const key = forward
          ? `${q(ax)},${q(ay)},${q(az)},${q(bx)},${q(by)},${q(bz)}`
          : `${q(bx)},${q(by)},${q(bz)},${q(ax)},${q(ay)},${q(az)}`;
        // A segment's flags are the union of both vertices': a run is a tunnel
        // if either end of it is, or the last few metres before a portal would
        // be open sky inside the hill.
        const f = flags[i] | flags[i + 1];
        const at = seen.get(key);
        if (at !== undefined) {
          segments[at].flags |= f;
          continue;
        }
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.05) continue;
        seen.set(key, segments.length);
        segments.push({
          ax, ay, az, bx, by, bz,
          flags: f,
          len,
          ux: dx / len,
          uz: dz / len,
          open: [true, true],
        });
      }
    }
  }

  markCorridorEdges(segments);

  // --- Portals: a flag transition along a direction's own polyline.
  const portals: Portal[] = [];
  const portalSeen = new Set<string>();
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        const a = (flags[i] & SPAN_TUNNEL) !== 0;
        const b = (flags[i + 1] & SPAN_TUNNEL) !== 0;
        if (a === b) continue;
        // The mouth is the vertex on the *surface* side of the transition, and
        // the direction points into the hill.
        const surface = a ? i + 1 : i;
        const under = a ? i : i + 1;
        const x = p[surface * 3];
        const y = p[surface * 3 + 1];
        const z = p[surface * 3 + 2];
        const key = `${q(x)},${q(z)}`;
        if (portalSeen.has(key)) continue;
        portalSeen.add(key);
        let ux = p[under * 3] - x;
        let uz = p[under * 3 + 2] - z;
        const len = Math.sqrt(ux * ux + uz * uz) || 1;
        portals.push({ x, y, z, ux: ux / len, uz: uz / len });
      }
    }
  }

  // --- Chunks. Segments by midpoint, everything else by its own position.
  const chunks = new Map<string, Chunk>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    bucket(chunks, chunkOf((s.ax + s.bx) / 2, (s.az + s.bz) / 2)).segments.push(i);
  }
  const st = bake.stanchions;
  for (let i = 0; i < bake.stanchionKinds.length; i++) {
    bucket(chunks, chunkOf(st[i * 5], st[i * 5 + 2])).masts.push(i);
  }
  for (let i = 0; i < portals.length; i++) {
    bucket(chunks, chunkOf(portals[i].x, portals[i].z)).portals.push(i);
  }

  // --- Stations, placed **where the trains actually stop**.
  //
  // This is the one place the bake has to be read against itself rather than at
  // face value, and getting it wrong is the loudest possible defect: a train
  // that dwells two hundred metres short of its own platform.
  //
  // `bake.stations[].x, z` is the OSM station *node*, and `dir.stops[k].s` is
  // the arc length the timetable brings a train to rest at -- the graph vertex
  // the router snapped the station to. Measured on the shipped bake, the two
  // differ by **225 m at Meadowbank and 248 m the other way**, because a station
  // node sits at the entrance and the routed anchor is wherever the platform's
  // way joins the running line. Building the platform at the node and stopping
  // the train at the arc length puts the two a rugby field apart.
  //
  // So a served station is positioned by evaluating its own stopping arc length
  // on the polyline of the first service that calls there, which also gives the
  // heading and the rail level for free and cannot disagree with `poseTrain` by
  // construction. A station **no line calls at** -- and 94 of the bake's 267 are
  // light-rail stops or closed platforms the network never reaches -- falls back
  // to the nearest segment within 60 m, and is dropped if there is not one.
  interface Anchor { name: string; x: number; y: number; z: number; ux: number; uz: number }
  const anchors: Anchor[] = [];
  const anchorAt = (dir: (typeof bake.lines)[number]['dirs'][number], at: number): Omit<Anchor, 'name'> => {
    const c = bake.cum;
    let lo = dir.vertexOff;
    let hi = dir.vertexOff + dir.vertexCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
    const span = c[lo + 1] - c[lo];
    const u = span > 0 ? (at - c[lo]) / span : 0;
    const ax = p[lo * 3];
    const ay = p[lo * 3 + 1];
    const az = p[lo * 3 + 2];
    const dx = p[(lo + 1) * 3] - ax;
    const dy = p[(lo + 1) * 3 + 1] - ay;
    const dz = p[(lo + 1) * 3 + 2] - az;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: ax + dx * u, y: ay + dy * u, z: az + dz * u, ux: dx / len, uz: dz / len };
  };
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      for (const stop of dir.stops) {
        if (!stop.calls) continue;
        const at = anchorAt(dir, stop.s);
        // Merge with an anchor of the same name whose platform this stop already
        // stands at: the up and down roads of one station are two ways a few
        // metres apart and their arc lengths land within a carriage of each
        // other, so they are one platform pair. What must *not* merge is a
        // station whose two directions the router anchored hundreds of metres
        // apart -- and the bake has those: Meadowbank's two are 471 m up the
        // corridor from each other -- nor two platforms of a big station lying
        // side by side across the formation, which a plain radius could not tell
        // from the first case at all. `riding.samePlatform` is the test and its
        // header is the argument; both readers of the bake use it.
        const near = anchors.find((a) => a.name === stop.name && samePlatform(a, at));
        if (near) continue;
        anchors.push({ name: stop.name, ...at });
      }
    }
  }

  const byName = new Map(bake.stations.map((s) => [s.name, s]));
  const stations: PlacedStation[] = [];
  const served = new Set<string>();
  for (const a of anchors) {
    const record = byName.get(a.name);
    if (!record) continue;
    served.add(a.name);
    const index = stations.length;
    stations.push({
      ...record,
      x: a.x, z: a.z, trackY: a.y, ux: a.ux, uz: a.uz,
      nodeX: record.x, nodeZ: record.z,
    });
    bucket(chunks, chunkOf(a.x, a.z)).stations.push(index);
  }

  // And the ones nothing calls at: 94 of the bake's 267 are light-rail stops or
  // closed platforms the modelled network never reaches. Kept when a rail is
  // within 60 m of them and dropped otherwise, because a platform built beside
  // no track is the one artefact a player would certainly notice.
  for (const station of bake.stations) {
    if (served.has(station.name)) continue;
    const cx = Math.floor(station.x / CHUNK_M);
    const cz = Math.floor(station.z / CHUNK_M);
    let best = -1;
    let bestD = 60 * 60;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const c = chunks.get(chunkKey(cx + ox, cz + oz));
        if (!c) continue;
        for (const si of c.segments) {
          const d = pointSegmentDistanceSquared(station.x, station.z, segments[si]);
          if (d < bestD) {
            bestD = d;
            best = si;
          }
        }
      }
    }
    if (best < 0) continue;
    const index = stations.length;
    stations.push({
      ...station,
      ux: segments[best].ux, uz: segments[best].uz,
      nodeX: station.x, nodeZ: station.z,
    });
    bucket(chunks, chunkOf(station.x, station.z)).stations.push(index);
  }

  return { bake, segments, portals, stations, chunks, directedSegments: directed };
}

/**
 * Decide, once, which sides of which segments are the outside of the corridor.
 *
 * ---------------------------------------------------------------------------
 * **The problem, which is not obvious until a fence exists.** The bake carries
 * one polyline per *track*: the up and down roads of a double-track railway are
 * two OSM ways four metres apart and `buildNetwork` deliberately keeps them
 * apart, because both are really there. Nothing before this round cared -- a
 * ballast prism per road is correct, and two of them 4 m apart simply overlap
 * into one formation, which is what a formation looks like. A *fence* per road
 * is not correct. It is a fence down the six-foot of every double-track railway
 * in Sydney, four metres from each rail, and a four-road corridor gets three of
 * them.
 *
 * So a side is fenced only when there is no other running rail on it within
 * `CORRIDOR_NEIGHBOUR`. Three samples per segment rather than one, because a
 * 40 m segment routinely has a neighbour beside half of it -- a loop, a turnout,
 * a platform road -- and the union is the safe direction: a side wrongly called
 * closed loses a fence, a side wrongly called open builds one in the six-foot.
 *
 * ---------------------------------------------------------------------------
 * The broad phase is a 16 m grid, and the containment argument is the one thing
 * in it worth stating: a segment is filed into every cell its plan bounding box
 * **grown by `CORRIDOR_NEIGHBOUR`** touches, so any segment within that distance
 * of a query point is filed in that point's own cell, and the query reads one
 * cell rather than nine. Same construction as `rail-cut.RailCut`'s broad phase
 * and for the same reason.
 *
 * One pass over 19,319 segments at load: about 230k cell insertions and 19,319
 * queries of a few dozen candidates each. Measured at 34 ms in the browser,
 * beside the 60 ms `buildNetwork` already spent, and it happens once.
 */
export function markCorridorEdges(segments: Segment[]): void {
  const CELL = 16;
  const cells = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // A bore has no surface expression and cannot close a side: the North Shore
    // line running into a tunnel beside an open cutting must not unfence it.
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    const x0 = Math.floor((Math.min(s.ax, s.bx) - CORRIDOR_NEIGHBOUR) / CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + CORRIDOR_NEIGHBOUR) / CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - CORRIDOR_NEIGHBOUR) / CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + CORRIDOR_NEIGHBOUR) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    const px = -s.uz;
    const pz = s.ux;
    for (const t of [0.15, 0.5, 0.85]) {
      const qx = s.ax + (s.bx - s.ax) * t;
      const qz = s.az + (s.bz - s.az) * t;
      const list = cells.get(key(Math.floor(qx / CELL), Math.floor(qz / CELL)));
      if (list === undefined) continue;
      for (const j of list) {
        if (j === i) continue;
        const o = segments[j];
        // Parallel, or it is a junction crossing rather than a second road, and
        // a crossing must not unfence the corridor it crosses.
        if (Math.abs(s.ux * o.ux + s.uz * o.uz) < 0.9) continue;
        // The neighbour's nearest point, and which side of us it is on.
        const ex = o.bx - o.ax;
        const ez = o.bz - o.az;
        const len2 = ex * ex + ez * ez;
        let u = 0;
        if (len2 > 1e-9) {
          u = ((qx - o.ax) * ex + (qz - o.az) * ez) / len2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
        }
        const lateral = (o.ax + ex * u - qx) * px + (o.az + ez * u - qz) * pz;
        // Half a metre of dead band, so a segment's own duplicate-in-all-but-
        // quantisation -- a bend where two chains meet at a shared vertex -- does
        // not read as a second road lying on top of this one.
        const a = Math.abs(lateral);
        if (a < 0.5 || a > CORRIDOR_NEIGHBOUR) continue;
        s.open[lateral < 0 ? 0 : 1] = false;
      }
    }
  }
}

export function pointSegmentDistanceSquared(x: number, z: number, s: Segment): number {
  const ex = s.bx - s.ax;
  const ez = s.bz - s.az;
  const len2 = ex * ex + ez * ez;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((x - s.ax) * ex + (z - s.az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = x - (s.ax + ex * t);
  const dz = z - (s.az + ez * t);
  return dx * dx + dz * dz;
}

// --- Collision, as a hook rather than an import ---------------------------------

/**
 * Where the solid parts of the railway go.
 *
 * A hook rather than a `CollisionWorld` import, on `world/cdn.ts`'s own argument
 * for `LocalAssetSource`: this module is about geometry, the collision world is
 * about the player, and the only thing they need to agree on is a prism with a
 * `base`. It also means the whole feature runs with the hook absent, which is
 * what a check or a headless build gets.
 */

/** Anything with a position and a unit heading: a station, or a segment's end. */
export interface TrackFrame {
  x: number; z: number; ux: number; uz: number;
}

export function framePoint(f: TrackFrame, t: number, o: number, y: number): [number, number, number] {
  return [f.x + f.ux * t - f.uz * o, y, f.z + f.uz * t + f.ux * o];
}

/** The plan rectangle of a frame box, as the ring `addPrisms` wants. */
export function framePlan(f: TrackFrame, t0: number, t1: number, o0: number, o1: number): Float32Array {
  const a = framePoint(f, t0, o0, 0);
  const b = framePoint(f, t1, o0, 0);
  const c = framePoint(f, t1, o1, 0);
  const d = framePoint(f, t0, o1, 0);
  return new Float32Array([a[0], a[2], b[0], b[2], c[0], c[2], d[0], d[2]]);
}

// --- What a station is, measured ---------------------------------------------------

/**
 * A station reduced to the numbers the geometry needs, **all of them measured**.
 *
 * `RAIL-VERTICAL.md` sections 1 and 4, applied: nothing below reads
 * `station.vertical` except to tell a bore from open air, because the label has
 * been wrong at every station anybody has complained about -- Chatswood is
 * `elevated` with its track 6.9 m *under* the terrain, and the geometry that
 * believed it built a platform slab floating in a hole with no legs and no way
 * in. What is read instead is `rawGround` beside the platform, on each side
 * separately, because the two sides of a corridor are routinely at different
 * levels and a single number per station cannot say so.
 */
export interface StationPlan {
  station: PlacedStation;
  /** Built into this chunk, rather than only consulted for its fence opening. */
  mine: boolean;
  /** The platform deck. */
  top: number;
  /** What the platform's skirt stands on. */
  base: number;
  /**
   * Is the track carried on a deck here? **Measured off the spans**, not off
   * `vertical`: a station whose own segments carry `SPAN_BRIDGE` stands on a
   * viaduct that is already built, and one that does not needs a skirt to the
   * ground however the bake labelled it.
   */
  onBridge: boolean;
  /**
   * Ground at the stair's landing, **by side and by end**: `[side][end]`, with
   * index 0 the `-1` side and index 0 the `+1` end of the run.
   *
   * ---------------------------------------------------------------------------
   * **Four numbers, and it was two.** `writeStationAccess` builds a flight at
   * each end of each platform, and both of a side's flights were sized from a
   * single reading of the terrain taken at `+ACCESS_ALONG + 8` -- one end. Where
   * the ground along a platform is not level, and it never is, the far flight
   * was built to the near flight's height: its bottom tread stopped short of the
   * ground by the difference, and a tread out of reach is a wall with a stair
   * drawn on it.
   *
   * Measured at Roseville, walking it: the flight at `t = +44` climbs 39.10 to
   * 41.93 in nineteen-centimetre risers and arrives; the flight at `t = -44`
   * stands on ground at 37.80 with its lowest tread at 39.09, which is a
   * 1.29 m step against a `STEP_HEIGHT` of 0.42. Reported as *"i can get up 1/3
   * sets of stairs at roseville"*.
   */
  landing: [[number, number], [number, number]];
  /** The flight's run in metres, by side and end. Zero where the deck is already walkable. */
  run: [[number, number], [number, number]];
  /**
   * Was every height in this plan actually measured?
   *
   * False where `rawGround` had no tile under the landing and the plan fell back
   * to the bake's own `groundY`. It matters more here than anywhere else in this
   * file: a station planned blind gets a flight sized from a height taken at the
   * OSM node, which at Roseville is 2.9 m out, and the result is a staircase
   * that stops short of the ground -- a station that is drawn as reachable and
   * is not. `buildChunk` turns this into `BuiltChunk.provisional` and the chunk
   * is planned again once its tiles land.
   */
  measured: boolean;
  /** Which side of the track the OSM station node is on, and where along it. */
  houseSide: number;
  houseAlong: number;
  /**
   * How far out the station building had to be pushed to get out of a track's
   * way, metres, and which side it ended on.
   *
   * See `clearOfTrack`. Zero at the overwhelming majority of stations.
   */
  housePush: number;
  /**
   * Which sides may carry a platform at all: `[-1 side, +1 side]`.
   *
   * **Reported as *"the roseville station is shown as a brick building which is
   * solid, that the train must pass through"*, and it is not the building.** A
   * platform is built 1.62 m off the anchor's centreline on *both* sides,
   * unconditionally, and an anchor on a four-road formation has running lines
   * four to seven metres away -- inside the slab. Measured at Roseville: rails
   * at -5, -3, -1, 0, +4, +5, +6 and +7 m from the platform axis, against a slab
   * that occupies 1.62 to 7.12 m on each side. The train passes through the
   * platform, and from a carriage window a platform is a solid box.
   *
   * So a side is built only where the strip it wants is clear of every *other*
   * track's loading gauge. Both sides blocked leaves the less-blocked one --
   * `writePlatforms` is where that tie is broken -- because a station with no
   * platform at all is a worse answer than a station with one that grazes.
   */
  sideClear: [boolean, boolean];
  /**
   * The terrain under the station building, sampled at the building rather than
   * at the stair.
   *
   * A separate reading and not `landing`, because it was one first and the
   * building hung in the air at Roseville: the landing is forty metres up the
   * platform and three metres in from the building, and on an embankment those
   * are different heights. Anything that stands on the ground has to have asked
   * the ground where it is.
   */
  houseGround: number;
}

export function planStation(
  net: RailNetwork,
  station: PlacedStation,
  rawGround: GroundAt,
  mine: boolean,
): StationPlan {
  const top = station.trackY + PLATFORM_HEIGHT;

  // Is there a deck under this? The station's own chunk holds every segment
  // whose midpoint is in it, which at 512 m is every span of the approach.
  let onBridge = false;
  const own = net.chunks.get(chunkOf(station.x, station.z));
  if (own) {
    for (const si of own.segments) {
      const s = net.segments[si];
      if ((s.flags & SPAN_BRIDGE) === 0) continue;
      if (pointSegmentDistanceSquared(station.x, station.z, s) < 45 * 45) {
        onBridge = true;
        break;
      }
    }
  }

  const landing: [[number, number], [number, number]] = [[top, top], [top, top]];
  const run: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  let measured = true;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const o = ((STAIR_INNER + STAIR_OUTER) / 2) * side;
    for (let e = 0; e < 2; e++) {
      const end = e === 0 ? 1 : -1;
      // Sampled at the middle of where *this* flight will be, which is a chicken
      // and an egg -- the run depends on the drop and the drop is sampled along
      // the run -- and is resolved by sampling at a fixed eight metres past the
      // stair head and letting the flight be as long as that one reading says. A
      // DEM post is 31 m, so every sample one flight could have taken is the
      // same post; the two *ends* of a 160 m platform are four posts apart, which
      // is the whole reason this loop has four iterations and not two.
      const p = framePoint(station, (ACCESS_ALONG + 8) * end, o, 0);
      let g = rawGround(p[0], p[2]);
      if (!Number.isFinite(g)) {
        measured = false;
        g = station.groundY;
      }
      if (!Number.isFinite(g)) g = top;
      landing[i][e] = g;
      const drop = Math.abs(top - g);
      // `STAIR_FLAT` is `controller.STEP_HEIGHT`: below it a body walks up
      // without being told, and a flight would be six centimetres of theatre.
      if (drop <= STAIR_FLAT) continue;
      const steps = Math.min(STAIR_MAX_STEPS, Math.round(drop / STAIR_RISE));
      run[i][e] = steps * STAIR_GOING;
    }
  }

  // The skirt. On a deck the viaduct is already there and the platform is a slab
  // on top of it; otherwise it runs to the ground, which on an embankment is the
  // retaining wall a real one has and in a cutting is a face against the trench.
  // Bounded at 14 m so a genuine viaduct station whose bridge flag went missing
  // is a tall platform rather than a 40 m blank wall.
  const groundish = Math.min(landing[0][0], landing[0][1], landing[1][0], landing[1][1], station.trackY);
  const base = onBridge ? top - 1.4 : Math.max(top - 14, groundish - 0.4);

  // Which way the street is. An OSM station node sits at the *entrance*, and
  // `buildNetwork` moved the platform to the stopping anchor without throwing
  // the node away for exactly this.
  const dx = station.nodeX - station.x;
  const dz = station.nodeZ - station.z;
  const along = dx * station.ux + dz * station.uz;
  const across = dx * -station.uz + dz * station.ux;
  const far = dx * dx + dz * dz > 250 * 250;
  let houseSide = !far && across < 0 ? -1 : 1;
  const houseAlong = far ? -18 : Math.max(-62, Math.min(62, along));

  // --- Nothing this station builds may stand in another track's way ----------
  //
  // See `StationPlan.sideClear`. The measurement that forced it is Roseville's:
  // an anchor with running lines four to seven metres off its own centreline,
  // and a platform slab that occupies exactly that strip on both sides.
  const sideClear: [boolean, boolean] = [
    trackClear(net, station, -L_PLATFORM, L_PLATFORM, PLATFORM_INNER, STAIR_OUTER, -1),
    trackClear(net, station, -L_PLATFORM, L_PLATFORM, PLATFORM_INNER, STAIR_OUTER, 1),
  ];

  // And the station building, which is the one thing here that can simply be
  // moved: it has no relationship to the platform beyond being beside it, so
  // where the strip it wants carries a track, it is pushed further out -- and
  // failing that, put on the other side. Reported as *"the actual roseville
  // station is shown as a brick building which is solid, that the train must
  // pass through"*, which at that anchor is a house at 13.85 m over rails at
  // 11, 13 and 14.
  let housePush = 0;
  const houseInner = STAIR_OUTER + 1.2;
  const houseFits = (side: number, push: number): boolean =>
    trackClear(
      net, station,
      houseAlong - HOUSE_LENGTH / 2 - 0.5, houseAlong + HOUSE_LENGTH / 2 + 0.5,
      houseInner + push, houseInner + push + HOUSE_WIDTH + HOUSE_AWNING, side,
    );
  if (!houseFits(houseSide, 0)) {
    let placed = false;
    for (const side of [houseSide, -houseSide]) {
      for (const push of [0, 3, 6, 9, 12]) {
        if (!houseFits(side, push)) continue;
        houseSide = side;
        housePush = push;
        placed = true;
        break;
      }
      if (placed) break;
    }
    // Nowhere clear within twelve metres of either side. Take the far side of
    // the formation anyway and push the full distance: a building a little way
    // off the forecourt is a nuisance, and one with a railway through it is the
    // bug. Named in `verifyRailGeometry`.
    if (!placed) housePush = 12;
  }

  const hp = framePoint(station, houseAlong, (houseInner + housePush + HOUSE_WIDTH / 2) * houseSide, 0);
  const hg = rawGround(hp[0], hp[2]);
  return {
    station, mine, top, base, onBridge, landing, run, measured,
    houseSide, houseAlong, housePush, sideClear,
    houseGround: Number.isFinite(hg) ? hg : landing[houseSide < 0 ? 0 : 1][0],
  };
}

/** `PLATFORM_HALF_LENGTH`, named for `planStation`'s own arithmetic. */
export const L_PLATFORM = PLATFORM_HALF_LENGTH;

/**
 * Is the strip `[t0, t1] x [o0, o1]` on `side` of this station clear of every
 * track but the station's own?
 *
 * ---------------------------------------------------------------------------
 * **`world/envelope.RAIL_HALF_M` is the width, and that is the point of this
 * function**: the loading gauge is the one statement in the build of how much
 * room a train needs, and a station is the place most likely to build something
 * inside it. The test is per rail segment rather than per envelope query because
 * what is being asked is not "is this point clear" but "is this whole rectangle
 * clear", and a rectangle against a swept strip is a handful of point-segment
 * distances where the point query would be a grid of them.
 *
 * A track is *this* station's own when it runs within `OWN_TRACK_M` of the
 * anchor's centreline: a platform is built against its own formation by
 * definition, and a test that counted it would refuse every platform in Sydney.
 */
export function trackClear(
  net: RailNetwork,
  f: TrackFrame & { x: number; z: number },
  t0: number, t1: number, o0: number, o1: number, side: number,
): boolean {
  const chunk = net.chunks.get(chunkOf(f.x, f.z));
  if (chunk === undefined) return true;
  // Sampled along the strip rather than solved: eight metres is a quarter of the
  // shortest segment in the bake and a tenth of what a platform is long.
  const steps = Math.max(2, Math.ceil((t1 - t0) / 8));
  for (const si of chunk.segments) {
    const s = net.segments[si];
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    // Its offset from this station's own axis, at its own midpoint.
    const mx = (s.ax + s.bx) / 2 - f.x;
    const mz = (s.az + s.bz) / 2 - f.z;
    const own = Math.abs(mx * -f.uz + mz * f.ux);
    if (own < OWN_TRACK_M) continue;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + ((t1 - t0) * i) / steps;
      for (const o of [o0, (o0 + o1) / 2, o1]) {
        const p = framePoint(f, t, o * side, 0);
        if (pointSegmentDistanceSquared(p[0], p[2], s) < RAIL_HALF_M * RAIL_HALF_M) return false;
      }
    }
  }
  return true;
}

/**
 * How far off a station's own centreline a rail is still the station's own.
 *
 * Two metres: a platform's inner face is at 1.62 m, so anything inside this is
 * the road the platform is built against and cannot be an obstruction to it.
 */
export const OWN_TRACK_M = 2.0;

// --- The solids, as one primitive ---------------------------------------------------

/**
 * What kind of thing a solid is.
 *
 * Emitted where the box is written rather than recovered from its shape, on
 * `Vessel.faceEdge`'s argument: *"a drawer has to know which face is the floor
 * and which is the coping. It must not work that out from the geometry."* Here
 * the drawer needs to know which buffer a box belongs in -- brick, concrete,
 * canopy -- and *"the low flat ones are platforms"* would be a second
 * description of the cross-section.
 */
export const SOLID_TRENCH_WALL = 0;
export const SOLID_VIADUCT_DECK = 1;
export const SOLID_VIADUCT_PIER = 2;
export const SOLID_PLATFORM_DECK = 3;
export const SOLID_STAIR = 4;
export const SOLID_LANDING = 5;
export const SOLID_FOOTBRIDGE_DECK = 6;
export const SOLID_FOOTBRIDGE_STAIR = 7;
export const SOLID_HOUSE = 8;
export const SOLID_BOX_PLATFORM = 9;
export const SOLID_SHAFT_HEAD = 10;

/** A prism as `CollisionWorld.addPrisms` takes one. */
export interface SolidPrism {
  points: Float32Array;
  height: number;
  base: number;
}

/**
 * A box between `t0..t1` along a frame, `o0..o1` across it, and `y0..y1` in
 * world y. **This is the definition of a rail solid**; the mesh and the prism
 * are both derived from it and neither is allowed to re-measure it.
 *
 * `y0` and `y1` are not ordered, because half the call sites naturally produce
 * them the other way round -- a stair tread's `baseY` is under the ground and a
 * platform's `base` is a skirt. `framePrism` sorts; nothing else needs to.
 */
export interface FrameSolid {
  f: TrackFrame;
  t0: number; t1: number;
  o0: number; o1: number;
  y0: number; y1: number;
  kind: number;
}

/** The prism a solid is, in world coordinates. */
export function framePrism(b: FrameSolid): SolidPrism {
  return {
    points: framePlan(b.f, b.t0, b.t1, b.o0, b.o1),
    height: Math.abs(b.y1 - b.y0),
    base: Math.min(b.y0, b.y1),
  };
}

/** The top of a solid, in world y. */
export function solidTop(b: FrameSolid): number {
  return Math.max(b.y0, b.y1);
}

/** The underside of a solid, in world y. */
export function solidBase(b: FrameSolid): number {
  return Math.min(b.y0, b.y1);
}

// --- The station kit, enumerated -----------------------------------------------------

/**
 * The platform deck, one box a side.
 *
 * `deckOuter` is `PLATFORM_OUTER_M` and not `PLATFORM_INNER + PLATFORM_WIDTH`,
 * and `writePlatforms` spends a paragraph on why: the carve opens to
 * `STATION_HALF_WIDTH` at a platform site, and a deck that stopped at the
 * platform's own width left 2.28 m of open trench down the back of every
 * platform in the city. The number the field stands bodies on, the number drawn
 * and the number carved are one number.
 */
export function platformDeckSolids(plan: StationPlan, out: FrameSolid[]): void {
  const f = plan.station;
  for (const side of platformSides(plan)) {
    out.push({
      f,
      t0: -PLATFORM_HALF_LENGTH, t1: PLATFORM_HALF_LENGTH,
      o0: PLATFORM_INNER * side, o1: PLATFORM_OUTER_M * side,
      y0: plan.base, y1: plan.top,
      kind: SOLID_PLATFORM_DECK,
    });
  }
}

/**
 * The treads of one flight, as boxes. `writeStairs`' arithmetic, with the
 * drawing taken out of it.
 *
 * Each tread's `base` is under the ground so `CollisionWorld.solidFor` reads it
 * as a kerb; the tread of a span is the higher of its two ends, which is what
 * makes a flight down into a cutting and a flight up an embankment the same
 * loop with no sign anywhere.
 */
export function stairSolids(
  f: TrackFrame,
  o0: number, o1: number,
  tA: number, yA: number,
  tB: number, yB: number,
  baseY: number,
  kind: number,
  out: FrameSolid[],
): number {
  const drop = Math.abs(yB - yA);
  if (drop <= STAIR_FLAT) return 0;
  const n = Math.min(STAIR_MAX_STEPS, Math.max(2, Math.round(drop / STAIR_RISE)));
  const dt = (tB - tA) / n;
  const dy = (yB - yA) / n;
  for (let k = 0; k < n; k++) {
    const t0 = tA + dt * k;
    const t1 = tA + dt * (k + 1);
    const tread = Math.max(yA + dy * k, yA + dy * (k + 1));
    out.push({ f, t0, t1, o0, o1, y0: baseY, y1: tread, kind });
  }
  return n;
}

/** The access flights and their landings. `writeStationAccess`' arithmetic. */
export function accessSolids(plan: StationPlan, out: FrameSolid[]): void {
  const f = plan.station;
  for (const side of platformSides(plan)) {
    const i = side < 0 ? 0 : 1;
    const o0 = STAIR_INNER * side;
    const o1 = STAIR_OUTER * side;
    for (const end of [1, -1]) {
      const e = end > 0 ? 0 : 1;
      const run = plan.run[i][e];
      const street = plan.landing[i][e];
      const baseY = Math.min(plan.top, street, plan.base) - 0.5;
      const head = ACCESS_ALONG * end;
      if (run <= 0) continue;
      const foot = head + run * end;
      stairSolids(f, o0, o1, head, plan.top, foot, street, baseY, SOLID_STAIR, out);
      out.push({ f, t0: foot, t1: foot + 2.6 * end, o0, o1, y0: baseY, y1: street, kind: SOLID_LANDING });
    }
  }
}

/**
 * The footbridge, where the station has one. `writeFootbridge`'s arithmetic.
 *
 * The deck solid's top is **0.6 m over the drawn deck** and that is deliberate
 * and old: the box is `BRIDGE_DECK + 0.6` tall from the soffit, so a body on the
 * bridge is held clear of its own balustrade. It is reproduced here exactly
 * because the point of this file is that the two ends answer the same number,
 * not that the number is the one a fresh design would pick.
 */
export function footbridgeSolids(plan: StationPlan, out: FrameSolid[]): void {
  if (plan.station.platforms < 2) return;
  const f = plan.station;
  const deck = plan.station.trackY + BRIDGE_CLEAR;
  const ground = Math.max(plan.landing[0][0], plan.landing[0][1], plan.landing[1][0], plan.landing[1][1]);
  if (deck - ground < BRIDGE_MIN_OVER_GROUND) return;
  const rise = deck - plan.top;
  if (rise <= STAIR_FLAT) return;
  const run = Math.min(STAIR_MAX_STEPS, Math.round(rise / STAIR_RISE)) * STAIR_GOING;
  const s1 = PLATFORM_INNER + PLATFORM_WIDTH - 0.4;
  const s0 = s1 - 2.0;
  out.push({
    f,
    t0: BRIDGE_ALONG, t1: BRIDGE_ALONG + BRIDGE_RUN,
    o0: -s1, o1: s1,
    y0: deck - BRIDGE_DECK, y1: deck + 0.6,
    kind: SOLID_FOOTBRIDGE_DECK,
  });
  for (const side of [-1, 1]) {
    stairSolids(
      f, s0 * side, s1 * side,
      BRIDGE_ALONG, deck, BRIDGE_ALONG - run, plan.top,
      plan.top - 0.2, SOLID_FOOTBRIDGE_STAIR, out,
    );
  }
}

/** The station building's brick box. `writeStationHouse`'s arithmetic. */
export function houseSolids(plan: StationPlan, out: FrameSolid[]): void {
  const f = plan.station;
  const side = plan.houseSide;
  const t = plan.houseAlong;
  const o = (STAIR_OUTER + 1.2 + plan.housePush + HOUSE_WIDTH / 2) * side;
  const y = plan.houseGround;
  out.push({
    f,
    t0: t - HOUSE_LENGTH / 2, t1: t + HOUSE_LENGTH / 2,
    o0: o - (HOUSE_WIDTH / 2) * side, o1: o + (HOUSE_WIDTH / 2) * side,
    y0: y - 2.5, y1: y + HOUSE_HEIGHT,
    kind: SOLID_HOUSE,
  });
}

/**
 * The two platforms in a station box and the head of its shaft.
 * `writeUndergroundStation`'s arithmetic.
 *
 * The shaft head is axis aligned in world space rather than in the track frame,
 * so it rides in an identity frame -- `framePoint` on `{ux: 1, uz: 0}` is
 * `[x + t, y, z + o]`, which is the same primitive and not a second code path.
 */
export function undergroundSolids(
  station: PlacedStation,
  out: FrameSolid[],
): void {
  const floor = station.trackY - 0.4;
  const roof = floor + BOX_HEIGHT;
  const top = station.trackY + PLATFORM_HEIGHT;
  const L = BOX_HALF_LENGTH;
  for (const side of [-1, 1]) {
    out.push({
      f: station,
      t0: -L + 6, t1: L - 6,
      o0: PLATFORM_INNER * side, o1: (PLATFORM_INNER + PLATFORM_WIDTH) * side,
      y0: floor, y1: top,
      kind: SOLID_BOX_PLATFORM,
    });
  }
  const street = station.groundY;
  if (!Number.isFinite(street) || street <= roof) return;
  const sx = station.x + station.ux * (L - 14);
  const sz = station.z + station.uz * (L - 14);
  out.push({
    f: { x: sx, z: sz, ux: 1, uz: 0 },
    t0: -SHAFT_HALF - 0.5, t1: SHAFT_HALF + 0.5,
    o0: -SHAFT_HALF - 0.5, o1: SHAFT_HALF + 0.5,
    y0: street + 3.2, y1: street + 3.5,
    kind: SOLID_SHAFT_HEAD,
  });
}

/**
 * Every solid one station stands on the world, in `buildChunk`'s own order.
 *
 * The dispatch on `vertical` is `buildChunk`'s, moved: an underground station
 * gets a box and a shaft and no surface kit at all.
 */
export function stationSolids(plan: StationPlan, out: FrameSolid[]): void {
  if (plan.station.vertical === 'underground') {
    undergroundSolids(plan.station, out);
    return;
  }
  platformDeckSolids(plan, out);
  accessSolids(plan, out);
  footbridgeSolids(plan, out);
  houseSolids(plan, out);
}

/**
 * Which sides may carry a platform. `writePlatforms`' `platformSides`, moved
 * here because the deck, the stair and the field all have to agree about it.
 *
 * See `StationPlan.sideClear`: the measurement is right, it is carried, and it
 * is deliberately not obeyed yet -- obeying it needs the *other* track's
 * platform to exist, which is a round of its own.
 */
export function platformSides(_plan: StationPlan): number[] {
  return [-1, 1];
}

// --- The corridor: the trench wall and the viaduct ------------------------------------

/**
 * One rib of one side of a trench wall. `writeTrench`'s own record, lifted out
 * of it so that the wall's mesh, the wall's prism and the ground query are three
 * readings of one measurement rather than three measurements.
 */
export interface TrenchRib {
  rim: number; foot: number; top: number; cess: number;
  cx: number; cz: number; vessel: boolean;
  /**
   * Is there still ground behind this rib to retain?
   *
   * False where the carve has already taken the ground away *outside* this
   * track's own rim -- which happens wherever a second track of the same
   * formation is near enough that its corridor swallows this one's edge. See
   * `trenchProfile`'s header: this is the whole of "a wall belongs to the
   * formation", and it is the carve's own answer rather than a second opinion
   * about which tracks are one formation.
   */
  stood: boolean;
  /**
   * How far out a platform deck reaches behind this rib, or zero.
   *
   * Carried on the rib rather than folded straight into `foot` because a prism
   * spans a rib *pair* and takes the inboard of the two feet: a panel straddling
   * the end of a platform would otherwise take the far rib's batter over the near
   * rib's deck. `trenchProfile`'s second pass is where the neighbours are read.
   */
  deck: number;
}

/** Both sides of one segment's trench, and whether every height in it was measured. */
export interface TrenchProfile {
  /** Index 0 is the `-1` side, index 1 the `+1`. */
  sides: [TrenchRib[], TrenchRib[]];
  anyWall: [boolean, boolean];
  /** False where `rawGround` had no tile: `buildChunk` turns this into `provisional`. */
  complete: boolean;
}

/**
 * How far out along a ray a **platform deck** still reaches from the point the
 * ray starts at, or zero where none does.
 *
 * The rectangle is `platformDeckSolids`' own -- `PLATFORM_HALF_LENGTH` along,
 * `PLATFORM_INNER` to `PLATFORM_OUTER_M` across, on both sides -- over the site
 * list `RailCut.eachSiteNear` hands out. Neither half is a restatement: the
 * boxes and this query read the same three constants, and the sites are the
 * ones `setStations` was given.
 *
 * Solved rather than sampled. Both bounds of a rectangle are linear in `o`, and
 * the number this returns is read by the wall's mesh, the wall's prism and the
 * server's ground query alike -- a quantised one would put all three of them a
 * sample step inside the deck.
 */
export function deckEdgeAlong(
  cut: RailCut,
  x: number, z: number,
  dx: number, dz: number,
  maxO: number,
): number {
  let edge = 0;
  cut.eachSiteNear(x, z, (sx, sz, sux, suz) => {
    const rx = x - sx;
    const rz = z - sz;
    // The ray in this site's own frame: `a` along the platform, `b` across it.
    const a0 = rx * sux + rz * suz;
    const au = dx * sux + dz * suz;
    const b0 = rx * -suz + rz * sux;
    const bu = dx * -suz + dz * sux;
    for (const s of [-1, 1]) {
      // `[lo, hi]` in `o`, cut down by each pair of parallel edges in turn.
      let lo = 0;
      let hi = maxO;
      if (Math.abs(au) < 1e-12) {
        if (Math.abs(a0) > PLATFORM_HALF_LENGTH) continue;
      } else {
        const t0 = (-PLATFORM_HALF_LENGTH - a0) / au;
        const t1 = (PLATFORM_HALF_LENGTH - a0) / au;
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      const c0 = s * b0;
      const cu = s * bu;
      if (Math.abs(cu) < 1e-12) {
        if (c0 < PLATFORM_INNER || c0 > PLATFORM_OUTER_M) continue;
      } else {
        const t0 = (PLATFORM_INNER - c0) / cu;
        const t1 = (PLATFORM_OUTER_M - c0) / cu;
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      if (hi > lo && hi > edge) edge = hi;
    }
  });
  return edge > maxO ? maxO : edge;
}

/**
 * The trench wall's ribs, measured. **`writeTrench`'s first two loops verbatim.**
 *
 * Nothing here draws and nothing here allocates a prism; it is the measurement
 * both of those are derived from. The comments that argued each number into
 * place -- the widest half-width between neighbouring ribs, the road abutment
 * stopping the wall at the soffit, the clamp at the cess where a cutting runs
 * out to grade -- stay with the arithmetic they are about.
 *
 * ---------------------------------------------------------------------------
 * **A RETAINING WALL BELONGS TO THE FORMATION, AT THE FORMATION'S OUTER EDGE.**
 *
 * `STATIONS.md` Phase 2b found this for the vessel path and fixed it there:
 * *"a four-track railway is one cutting carrying four tracks, not four trenches
 * that overlap; modelling it as four is why a coping is drawn across an open
 * trench, and no amount of per-vessel correctness fixes it because each vessel
 * is individually right."* Everything above and below was per **track**, and the
 * bake carries one polyline per track, so a four-road formation built eight
 * walls -- six of them standing inside the cutting they were supposed to retain,
 * over the other tracks and over the platform decks between them. Measured on
 * the shipping path before this: **557,885 of 7,354,752** points over a platform
 * rectangle in the city were covered by a corridor solid standing over the deck,
 * worst 13.18 m, at 109 of 190 stations. It is what made `checkRiding`'s Epping
 * instant put a rider down 868 mm off the platform they had just stepped onto.
 *
 * ---------------------------------------------------------------------------
 * **THE TEST IS NOT "WHICH TRACKS ARE ONE FORMATION". IT IS "IS THERE GROUND
 * HERE TO RETAIN".**
 *
 * That distinction is the whole design and it is worth being exact about, because
 * the obvious fix is a grouping and a grouping is what this project keeps getting
 * subtly wrong. Two candidates were available and both were rejected:
 *
 *   - **`markCorridorEdges`' `seg.open[k]`**, the flag the boundary fence is
 *     placed by. Its rule is a fixed `CORRIDOR_NEIGHBOUR` of 8.2 m, and a
 *     platform flares the corridor to 9.4 m, so two roads *fourteen* metres apart
 *     at a station -- one formation by any reading, and one of the biggest
 *     residues measured here -- are "open" to each other and each builds a wall
 *     across the other's platform. It is also *wrong in the other direction*: a
 *     cutting beside an embankment six metres away is called closed, and a
 *     cutting with no wall on one side is a hole.
 *
 *   - **`world/corridor.buildFormations`**, the vessel path's grouping. Its rule
 *     is the right one -- a track joins the formation where *its corridor
 *     overlaps the formation's* -- but it is a whole-network sweep over
 *     `corridorStrips`, a different segment set from this one, and it needs a
 *     ground-sampled spine. `RailSolidField` is lazy per segment on purpose (see
 *     its header) and `buildChunk` builds a 512 m ring; hanging either on a
 *     global formation build would undo both.
 *
 * What both of those are *proxies for* is available directly and exactly, at the
 * one place the question is actually asked: **`RailCut`**. The carve is the sole
 * authority on where the ground is, on both ends, and `rim` on the line above is
 * already `cut.halfWidthAt`. `buildFormations`' own rule -- corridors overlap --
 * is `RailCut.cutAt` evaluated at a point. So the rib asks the carve whether the
 * ground *outside its own coping* is still standing:
 *
 *   - standing, and this rib is at the edge of the formation, whatever else is
 *     in the formation. Build the wall.
 *   - taken away, and the rib is looking into the same hole it is standing in --
 *     another road of the same corridor, on the other side of a floor
 *     `writeFormation` has already drawn. Build nothing.
 *
 * No grouping is derived, no second notion exists to drift, and the answer is at
 * rib resolution rather than per segment, which is what a formation that gains
 * and loses tracks at a throat needs.
 *
 * ---------------------------------------------------------------------------
 * **AND THE FOOT NEVER LEANS IN OVER A PLATFORM DECK.**
 *
 * The batter is what puts a wall's foot inboard of its top, and at a platform the
 * rim *is* the deck's outer face -- `PLATFORM_OUTER_M` and `STATION_HALF_WIDTH`
 * are one constant -- so a five-metre wall's batter took the back 0.83 m of the
 * deck it was built behind. That happens on the **outermost** track of the
 * formation, where the rule above cannot help, because there the wall is the real
 * one and it has to stand. Clamped by `deckEdgeAlong`, it comes out vertical for
 * the length of the platform and battered again the moment the deck ends, which
 * is what a real station in a cutting is.
 *
 * ---------------------------------------------------------------------------
 * **NEITHER CLAUSE OPENS A WALK-THROUGH, AND THAT IS WHAT SHAPED BOTH.**
 *
 * The first drops a wall only where the carve says the ground behind it is
 * already gone -- so what is on the other side is the formation's own floor,
 * drawn by `writeFormation` (*"the one piece that is drawn wherever the ground
 * has come away"*, over the full `halfWidthAt` of every road in the corridor) and
 * answered by `RailCut.cutAt` in both ends' ground query. It is never the street.
 * The second moves a foot *outward*, so the prism narrows at the bottom and never
 * shortens: the barrier from cess to coping still stands its full height along
 * the whole platform.
 *
 * And nothing here stops a prism short of a face that is still drawn. Both
 * clauses land on the ribs, and the mesh in `writeTrench`, the prisms in
 * `trenchPrisms` and `RailSolidField`'s ground query are three readings of those
 * same ribs.
 */
export function trenchProfile(
  seg: Segment,
  cut: RailCut,
  rawGround: GroundAt,
  vesselled: (x: number, z: number) => boolean,
): TrenchProfile {
  const px = -seg.uz;
  const pz = seg.ux;
  const steps = Math.max(1, Math.round(seg.len / TRENCH_STEP_M));
  const ext = 0.5;
  let complete = true;

  interface Post { cx: number; cz: number; rail: number; cess: number; vessel: boolean }
  const line: Post[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = -ext + t * (seg.len + 2 * ext);
    const cx = seg.ax + seg.ux * along;
    const cz = seg.az + seg.uz * along;
    const rail = seg.ay + (seg.by - seg.ay) * t;
    line.push({
      cx, cz, rail,
      cess: rail - BALLAST_TOP_DROP - BALLAST_DEPTH,
      vessel: vesselled(cx, cz),
    });
  }

  const sides: [TrenchRib[], TrenchRib[]] = [[], []];
  const anyWall: [boolean, boolean] = [false, false];
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1;
    const ribs = sides[k];
    for (const st of line) {
      // **The widest the corridor gets between this rib and its neighbours**,
      // not the width at the rib itself: at a platform's flare a wall built to
      // the rib's own width sits inside the rim for most of the panel and leaves
      // a slot of daylight along it.
      const half = TRENCH_STEP_M / 2;
      const here = cut.halfWidthAt(st.cx, st.cz);
      const rim = Math.max(
        here,
        cut.halfWidthAt(st.cx - seg.ux * half, st.cz - seg.uz * half),
        cut.halfWidthAt(st.cx + seg.ux * half, st.cz + seg.uz * half),
      );
      const g = rawGround(st.cx + px * rim * side, st.cz + pz * rim * side);
      let top: number;
      if (Number.isFinite(g)) {
        top = g;
      } else {
        complete = false;
        top = st.rail + TRENCH_MIN_DEPTH;
      }
      // **And never up through a road**, which is the abutment case: the wall is
      // what holds the deck up and it stops at the soffit.
      const deck = cut.deckSurfaceAt(st.cx + px * rim * side, st.cz + pz * rim * side, g);
      if (Number.isFinite(deck) && deck - DECK_THICKNESS_M < top) top = deck - DECK_THICKNESS_M;
      // Never below the cess: where a cutting runs out to grade the wall goes to
      // nothing rather than turning inside out.
      if (top < st.cess) top = st.cess;
      const height = top - st.cess;
      // **Is there ground behind this rib to retain?** See the header: asked of
      // the carve at the outer edge of this wall's own coping, which is the first
      // point outside its own hole and therefore the first point that can only be
      // inside somebody else's. `NaN` means the DEM sheet is still there and this
      // rib is at the edge of the formation; a number means the ground has come
      // away and the rib is looking across the corridor it stands in.
      const lapX = st.cx + px * (rim + TRENCH_COPING) * side;
      const lapZ = st.cz + pz * (rim + TRENCH_COPING) * side;
      const stood = !Number.isFinite(cut.cutAt(lapX, lapZ, rawGround(lapX, lapZ)));
      if (height > TRENCH_MIN_HEIGHT && !st.vessel && stood) anyWall[k] = true;
      // The batter, and how far in it is allowed to reach. See the header: at a
      // platform the rim is the deck's own outer face, so an unclamped foot is a
      // wall standing on the back of the platform.
      const deckEdge = deckEdgeAlong(cut, st.cx, st.cz, px * side, pz * side, rim);
      // ...and no further out than the corridor's own edge **at this rib**, which
      // is `here` and not `rim`: `rim` is the widest of three samples so that a
      // panel never sits inside the hole it is retaining, and the difference
      // between the two is a shoulder of ground the carve never took away. A foot
      // outboard of that shoulder leaves it standing between the formation floor
      // and the wall, and a body walks up it and straight over the coping --
      // three of 110 did, at the taper of a station flare, when the deck clamp
      // first went in unbounded. The foot stands on the corridor floor.
      const foot = Math.min(
        Math.max(TRENCH_FOOT_MIN, deckEdge, rim - TRENCH_BATTER * height),
        Math.max(TRENCH_FOOT_MIN, here),
      );
      ribs.push({
        rim, foot, top, cess: st.cess, cx: st.cx, cz: st.cz,
        vessel: st.vessel, stood, deck: deckEdge,
      });
    }
    // **The neighbours' decks, adopted.** A prism spans a rib *pair* and takes
    // the inboard of the two feet (`trenchPrisms`), and the drawn wall rules its
    // face between the same two, so a panel that straddles the end of a platform
    // would take the batter of the rib past the end over the deck of the rib
    // before it. One pass, after the fact, because a rib cannot know what its
    // neighbour measured until the neighbour has measured it.
    for (let i = 0; i < ribs.length; i++) {
      const behind = Math.max(
        ribs[i].deck,
        i > 0 ? ribs[i - 1].deck : 0,
        i + 1 < ribs.length ? ribs[i + 1].deck : 0,
      );
      // Capped at `rim` and **not** at `here`, which is the one place the two
      // clamps above are deliberately not applied together. `here` keeps a
      // rib's own face on the corridor floor; a rib adopting a *neighbour's*
      // deck is by construction at the end of a platform, where its own `here`
      // has begun to taper and the deck it is covering for has not. Capping it
      // there as well pulls the foot back inside the deck: measured, 3,094
      // points of deck covered against 10,483, for the same 25 bodies out of
      // 1,040 either way.
      if (behind > ribs[i].foot) ribs[i].foot = Math.min(behind, ribs[i].rim);
    }
  }
  return { sides, anyWall, complete };
}

/**
 * The trench wall's collision, **one prism per rib pair**.
 *
 * `writeTrench`'s own loop, and its argument is worth keeping beside it: one box
 * per segment was a chord across a widening corridor and was as tall as the deep
 * end of a run-out along its whole length. Per rib pair, each prism spans
 * exactly the eight metres its two ribs do, at exactly their own feet and rims.
 */
export function trenchPrisms(
  seg: Segment,
  profile: TrenchProfile,
  visit: (prism: SolidPrism) => void,
): void {
  const px = -seg.uz;
  const pz = seg.ux;
  for (let k = 0; k < 2; k++) {
    if (!profile.anyWall[k]) continue;
    const side = k === 0 ? -1 : 1;
    const ribs = profile.sides[k];
    for (let i = 0; i < ribs.length - 1; i++) {
      const a = ribs[i];
      const b = ribs[i + 1];
      // `stood` beside `vessel`, and decided on the rib so that the mesh, the
      // prism and the field cannot disagree about which panels exist.
      //
      // **Both ribs, and the alternative was measured rather than argued.** A
      // panel spans two ribs and a formation gains and loses roads mid-segment,
      // so at every transition one rib stands and the other does not, and the
      // obvious worry is that dropping those panels leaves a `TRENCH_STEP_M` gap
      // in the wall at each one. Built both ways and driven at: keeping a panel
      // when either rib stands puts another 11,196 points of corridor solid over
      // the platforms and lets **26** of 1,040 bodies out of the cutting;
      // requiring both lets **25** out. The gap is not there, because the rib
      // whose ground has gone is looking at the formation and the formation's
      // floor is what is behind it.
      if (a.vessel || b.vessel || !a.stood || !b.stood) continue;
      const base = Math.min(a.cess, b.cess);
      const top = Math.max(a.top, b.top);
      if (top - base <= TRENCH_MIN_HEIGHT) continue;
      const foot = Math.min(a.foot, b.foot);
      visit({
        points: new Float32Array([
          a.cx + px * foot * side, a.cz + pz * foot * side,
          b.cx + px * foot * side, b.cz + pz * foot * side,
          b.cx + px * (b.rim + TRENCH_COPING) * side, b.cz + pz * (b.rim + TRENCH_COPING) * side,
          a.cx + px * (a.rim + TRENCH_COPING) * side, a.cz + pz * (a.rim + TRENCH_COPING) * side,
        ]),
        height: top + TRENCH_COPING_RISE - base,
        base,
      });
    }
  }
}

/** A viaduct deck's extents. `writeViaduct`'s first six lines, shared. */
export function viaductDeck(seg: Segment): {
  ax: number; az: number; bx: number; bz: number;
  px: number; pz: number; half: number; soffit: number; top: number;
} {
  const soffit = Math.min(seg.ay, seg.by) - BALLAST_TOP_DROP - 0.4 - DECK_DEPTH;
  return {
    ax: seg.ax - seg.ux * 0.5,
    az: seg.az - seg.uz * 0.5,
    bx: seg.bx + seg.ux * 0.5,
    bz: seg.bz + seg.uz * 0.5,
    px: -seg.uz,
    pz: seg.ux,
    half: DECK_HALF_WIDTH,
    soffit,
    top: soffit + DECK_DEPTH,
  };
}

/** The plan rectangle of a swept box, as the ring `addPrisms` wants. */
export function sweptRing(
  ax: number, az: number, bx: number, bz: number,
  px: number, pz: number, half: number,
): Float32Array {
  return new Float32Array([
    ax + px * half, az + pz * half,
    bx + px * half, bz + pz * half,
    bx - px * half, bz - pz * half,
    ax - px * half, az - pz * half,
  ]);
}

/**
 * What `RailSolidField` refuses with when its `ground` argument consults it.
 *
 * Exported so `checkGroundLayering` can assert that the refusal is *this* and
 * not a `RangeError` -- a named sentence on the first frame is a bug report, and
 * a stack overflow ten thousand frames deep with no viaduct anywhere in it is
 * what shipped.
 */
export const RE_ENTRY =
  'rail-solids: the ground function given to RailSolidField consulted the field itself. '
  + "A pier's foot cannot be defined by a query that needs the pier -- pass the composed "
  + 'ground minus the rail-solid layer (main.ts wildGround, server/world.ts wildGround).';

/**
 * A viaduct's solids: the deck, whose `base` is its soffit and whose box stands
 * a metre proud of the running surface for the parapets, and one pier per
 * `PIER_SPACING` of arc.
 *
 * `ground` rather than `rawGround`, exactly as `buildChunk` calls it, because a
 * pier inside a cutting stands on the **cut floor** and the raw DEM there is the
 * sheet the corridor was carved out of. What that `ground` may **not** be is a
 * query that consults the railway's own solids -- see `RailSolidField`'s
 * `ground` parameter for the recursion that cost, and for why the resolution is
 * a definition rather than a guard. See `RailSolidField` too for the one place
 * the two ends can still differ over it.
 */
export function viaductSolids(
  seg: Segment,
  ground: GroundAt,
  visit: (prism: SolidPrism, kind: number) => void,
): void {
  const d = viaductDeck(seg);
  visit(
    { points: sweptRing(d.ax, d.az, d.bx, d.bz, d.px, d.pz, d.half), height: DECK_DEPTH + 1.0, base: d.soffit },
    SOLID_VIADUCT_DECK,
  );
  const count = Math.max(1, Math.round(seg.len / PIER_SPACING));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const cx = seg.ax + (seg.bx - seg.ax) * t;
    const cz = seg.az + (seg.bz - seg.az) * t;
    const g = ground(cx, cz);
    const base = Number.isFinite(g) ? g - 0.6 : d.soffit - 8;
    if (base >= d.soffit - 0.4) continue;
    visit(
      {
        points: new Float32Array([
          cx - PIER_HALF, cz - PIER_HALF,
          cx + PIER_HALF, cz - PIER_HALF,
          cx + PIER_HALF, cz + PIER_HALF,
          cx - PIER_HALF, cz + PIER_HALF,
        ]),
        height: d.soffit - base,
        base,
      },
      SOLID_VIADUCT_PIER,
    );
  }
}

// --- The field: the same solids, answered without a renderer ---------------------------

/**
 * How far a station's kit reaches from its anchor: an 80 m half platform, a
 * flight running out past it, and a building pushed clear of the tracks.
 * Generous on purpose -- it is a broad phase, and the boxes decide.
 */
const STATION_REACH_M = 160;
/** The widest a corridor solid reaches from the centreline it hangs off. */
const SEGMENT_PAD_M = STATION_HALF_WIDTH + TRENCH_COPING + 2;
const STATION_CELL_M = 128;
const SEGMENT_CELL_M = 64;

function fieldCell(cx: number, cz: number): number {
  // Two 16-bit halves of one integer key, which is what a `Map<number, ...>`
  // wants: a string key here costs more than the lookup it serves.
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/**
 * A prism with its plan bounds and its roof precomputed.
 *
 * `CollisionWorld` keeps exactly these four extra numbers on a `Prism` and for
 * exactly this reason: `roofHeight` rejects on the box before it runs the
 * even-odd test, and without that reject a query beside a station walks forty
 * polygons. Measured over the suite's 670,437-sample lattice, adding it took a
 * query from 3.5 us to well under one.
 */
interface Indexed extends SolidPrism {
  top: number;
  minX: number; minZ: number; maxX: number; maxZ: number;
}

function indexed(p: SolidPrism): Indexed {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < p.points.length; v += 2) {
    if (p.points[v] < minX) minX = p.points[v];
    if (p.points[v] > maxX) maxX = p.points[v];
    if (p.points[v + 1] < minZ) minZ = p.points[v + 1];
    if (p.points[v + 1] > maxZ) maxZ = p.points[v + 1];
  }
  return { points: p.points, base: p.base, height: p.height, top: p.base + p.height, minX, minZ, maxX, maxZ };
}

interface StationSolids {
  prisms: Indexed[];
  /** `StationPlan.measured`: false means the terrain under it had not landed. */
  measured: boolean;
}

interface SegmentSolids {
  prisms: Indexed[];
  /** `TrenchProfile.complete`: false means a wall height was guessed. */
  complete: boolean;
}

/**
 * Every solid the railway stands on the world, evaluated rather than drawn.
 *
 * ---------------------------------------------------------------------------
 * **This is `CollisionWorld.roofHeight` over `rail-geo`'s prisms, computed from
 * the definition instead of from a browser.** The three clauses are
 * `collision.roofHeight`'s and the polygon test is *imported* from it, so a
 * boundary tie cannot land one way here and the other way there. What differs
 * is where the prisms come from: `rail-geo` has them because it just drew them
 * inside `BUILD_RADIUS`, and this has them because it can work them out
 * anywhere -- which is the whole point, since the server has no `BUILD_RADIUS`
 * and no browser.
 *
 * ---------------------------------------------------------------------------
 * **Nothing is built until it is asked for, and nothing measured against
 * missing terrain is kept.**
 *
 * Both halves matter and for different reasons. Laziness is the memory rule:
 * `STATIONS.md`'s constraint is that an arithmetic form is cheap and a prism set
 * is not, and a process that never walks the Blue Mountains must not pay for the
 * Blue Mountains. Twelve thousand trenched segments at ten prisms each is six
 * figures of `Float32Array` if it is all built at boot, and a few hundred
 * kilobytes if it is built where somebody stands.
 *
 * Refusing to cache an *unmeasured* answer is the correctness rule, and it is
 * `RailWorld.retryProvisional`'s rule said in one line instead of four. A
 * station planned before its terrain landed gets a flight sized from the bake's
 * own `groundY`; a wall measured where no tile is loaded is guessed to
 * `TRENCH_MIN_DEPTH`. On the server every tile is resident so this never fires;
 * in a browser it fires constantly, and caching it would freeze the guess in
 * place for the session. `StationPlan.measured` and `TrenchProfile.complete`
 * already say which answers are guesses, so the rule needs no new measurement.
 *
 * ---------------------------------------------------------------------------
 * **What can still differ between the two ends, said out loud.** A browser
 * whose terrain has not arrived answers this field from the terrain it has, and
 * the server answers from the terrain it has, and those are different terrains
 * for as long as the streaming takes. The same window governs `rail-geo`'s own
 * provisional chunks and has always been there. What is gone is the *permanent*
 * disagreement: a process with the same terrain now computes the same solids,
 * which was not true of anything above `PlatformField` before this file.
 */
export class RailSolidField {
  private readonly stationGrid = new Map<number, number[]>();
  private readonly stationCache: Array<StationSolids | null>;
  private readonly segmentGrid = new Map<number, number[]>();
  private readonly segmentCache: Array<SegmentSolids | null>;
  private heldStations = 0;
  private heldSegments = 0;
  private heldPrisms = 0;

  constructor(
    private readonly net: RailNetwork,
    private readonly cut: RailCut | null,
    private readonly rawGround: GroundAt,
    /**
     * The ground a pier's foot is set from, and it **must not consult this
     * field**.
     *
     * ---------------------------------------------------------------------------
     * This used to read *"`RailWorld`'s `ground`, not its `rawGround`: a pier's
     * foot is set from it and `buildChunk` passes the same distinction"*, and
     * that sentence was true when it was written and became false without
     * anybody editing it. `main.ts`' `wildGround` was the whole composed ground
     * query; the ground-parity round put `RailSolidField.roofHeight` **into**
     * that composition; and from that commit a pier's foot was defined by a
     * query that needs the pier:
     *
     *     groundHeightAt -> roofHeight -> segmentSolidsFor -> viaductSolids
     *       -> wildGround -> groundHeightAt -> ...
     *
     * which is an unbounded mutual recursion, and it threw
     * `RangeError: Maximum call stack size exceeded` inside the animation
     * callback at the **default spawn** of the shipped build. The server never
     * saw it: `server/world.ts` composes its own `wildGround` out of terrain,
     * station boxes and `RailCut` and has never had this field in it, so the
     * 1,147-check suite -- which exercises `groundFor`, not a browser's closure
     * -- could not reach the cycle. See `checkGroundLayering`.
     *
     * **The resolution is definitional and not a guard.** A guard would return
     * whichever half-built answer the stack was holding, which is two
     * descriptions of one thing. A pier's foot is instead the composed ground
     * *minus this layer* -- `main.ts`' `wildGround`, now `groundOn(..., null)`,
     * and the server's own `wildGround`, which already was that. It is not
     * `rawGround`, and the difference is real in one place: a pier inside a
     * cutting stands on the **cut floor**, which the composition supplies and
     * the raw DEM does not.
     *
     * The `RE_ENTRY` throw in `segmentSolidsFor` is the belt on top of that
     * brace. It does not choose an answer -- it refuses, by name, on the first
     * frame -- so it is a bug report rather than a second description.
     */
    private readonly ground: GroundAt,
    /** `buildChunk`'s `vesselled`, which is `() => false` with the flag down. */
    private readonly vesselled: (x: number, z: number) => boolean = () => false,
  ) {
    this.stationCache = new Array(net.stations.length).fill(null);
    this.segmentCache = new Array(net.segments.length).fill(null);
    for (let i = 0; i < net.stations.length; i++) {
      const st = net.stations[i];
      file(this.stationGrid, i, st.x - STATION_REACH_M, st.z - STATION_REACH_M,
        st.x + STATION_REACH_M, st.z + STATION_REACH_M, STATION_CELL_M);
    }
    for (let i = 0; i < net.segments.length; i++) {
      const s = net.segments[i];
      file(this.segmentGrid, i,
        Math.min(s.ax, s.bx) - SEGMENT_PAD_M, Math.min(s.az, s.bz) - SEGMENT_PAD_M,
        Math.max(s.ax, s.bx) + SEGMENT_PAD_M, Math.max(s.az, s.bz) + SEGMENT_PAD_M,
        SEGMENT_CELL_M);
    }
  }

  /**
   * Forget every cached corridor solid.
   *
   * For the one input that can change under a running field: `vesselled`. With
   * `?vessels=1` the corridor is re-swept as the player moves, and inside a
   * formation `writeTrench` stands down -- so a segment cached before the sweep
   * reached it would answer with a wall the renderer no longer draws. The
   * stations are untouched, because nothing about a formation moves a platform.
   */
  invalidateCorridor(): void {
    this.segmentCache.fill(null);
    this.heldSegments = 0;
    this.heldPrisms = 0;
  }

  /** What the lazy halves are holding. For the boot line and for the suite. */
  get residency(): { stations: number; segments: number; prisms: number; boxes: number } {
    let boxes = 0;
    for (const held of this.stationCache) if (held !== null) boxes += held.prisms.length;
    return { stations: this.heldStations, segments: this.heldSegments, prisms: this.heldPrisms, boxes };
  }

  private stationSolidsFor(i: number): StationSolids {
    const held = this.stationCache[i];
    if (held !== null) return held;
    const plan = planStation(this.net, this.net.stations[i], this.rawGround, true);
    const boxes: FrameSolid[] = [];
    stationSolids(plan, boxes);
    // Evaluated as the **prisms** `buildChunk` registers, not as the boxes: the
    // ring `framePrism` derives is the ring `CollisionWorld` is given, so the
    // even-odd test on this end is the even-odd test on that one over the same
    // eight floats.
    const built: StationSolids = { prisms: boxes.map((b) => indexed(framePrism(b))), measured: plan.measured };
    if (built.measured) {
      this.stationCache[i] = built;
      this.heldStations++;
    }
    return built;
  }

  /**
   * Is a segment's solids being built right now? See `RE_ENTRY`.
   *
   * One boolean, and it exists so that a `ground` argument which consults this
   * field fails **immediately and by name** rather than as a stack overflow ten
   * thousand frames deep. It is not the fix -- see the `ground` parameter's own
   * note for that -- and it can never fire on the shipped wiring, which
   * `checkGroundLayering` asserts over the spawn and over every viaduct in the
   * extent. Sequential calls from `roofHeight`'s loop clear it between segments;
   * only a nested one trips it.
   */
  private building = false;

  /**
   * `buildChunk`'s decision for one segment, and the prisms it produces.
   *
   * The two questions are asked in `buildChunk`'s own order and with
   * `buildChunk`'s own arguments -- `drawnAsTunnel(s.flags)` for the bore,
   * `RailCut.probeAlong` over `rawGround` for the trench, `SPAN_BRIDGE` for the
   * viaduct, and a bridge gets its deck whether or not it is also a bore,
   * because that `if` sits outside the `else`. A different order here would be a
   * different world.
   *
   * Split in two so the re-entry refusal wraps the *build* and not the cache
   * hit: a cached answer is a value and nothing about returning one can recurse.
   */
  private segmentSolidsFor(i: number): SegmentSolids {
    const held = this.segmentCache[i];
    if (held !== null) return held;
    if (this.building) throw new Error(RE_ENTRY);
    this.building = true;
    try {
      return this.buildSegmentSolids(i);
    } finally {
      this.building = false;
    }
  }

  private buildSegmentSolids(i: number): SegmentSolids {
    const s = this.net.segments[i];
    const prisms: Indexed[] = [];
    let complete = true;
    const tunnel = drawnAsTunnel(s.flags);
    const bridge = (s.flags & SPAN_BRIDGE) !== 0;
    if (!tunnel && this.cut !== null) {
      const probe = this.cut.probeAlong(s.ax, s.az, s.bx, s.bz, this.rawGround);
      if (probe.trench) {
        const profile = trenchProfile(s, this.cut, this.rawGround, this.vesselled);
        complete = profile.complete;
        trenchPrisms(s, profile, (p) => prisms.push(indexed(p)));
      }
    }
    if (bridge) viaductSolids(s, this.ground, (p) => prisms.push(indexed(p)));
    const built: SegmentSolids = { prisms, complete };
    if (complete) {
      this.segmentCache[i] = built;
      this.heldSegments++;
      this.heldPrisms += prisms.length;
    }
    return built;
  }

  /**
   * The highest **station** solid over a point: a platform deck, a flight, a
   * landing, a footbridge, a station building, a subway shaft head.
   *
   * The corridor half is deliberately not in it. Split out because a station's
   * kit stands *over* the corridor -- a platform deck spans the formation floor
   * it is built on -- and a check about the corridor's own continuity has to be
   * able to say so. `roofHeight` is the answer the ground query wants; this is
   * the answer "is one of these in the way" wants, and there is one enumeration
   * behind both.
   */
  stationRoofAt(x: number, z: number, feetY: number): number {
    const stations = this.stationGrid.get(
      fieldCell(Math.floor(x / STATION_CELL_M), Math.floor(z / STATION_CELL_M)),
    );
    if (stations === undefined) return -Infinity;
    let best = -Infinity;
    for (const i of stations) best = pick(this.stationSolidsFor(i).prisms, x, z, feetY, best);
    return best;
  }

  /**
   * The highest **corridor** solid over a point: a trench wall and its coping, a
   * viaduct deck, a pier.
   *
   * `stationRoofAt`'s other half, and it exists for the question that half
   * cannot ask. A trench wall belongs to the *formation* and a platform deck is
   * a thing the formation carries, so "is a wall standing over a platform" is a
   * claim about these prisms against those rectangles -- and asking it of
   * `roofHeight` would answer with the platform's own deck every time. See
   * `checkPlatformCover`, which is the assertion this method is for.
   */
  corridorRoofAt(x: number, z: number, feetY: number): number {
    const segments = this.segmentGrid.get(
      fieldCell(Math.floor(x / SEGMENT_CELL_M), Math.floor(z / SEGMENT_CELL_M)),
    );
    if (segments === undefined) return -Infinity;
    let best = -Infinity;
    for (const i of segments) best = pick(this.segmentSolidsFor(i).prisms, x, z, feetY, best);
    return best;
  }

  /**
   * The highest rail solid a body with its feet at `feetY` is standing on, or
   * `-Infinity`.
   *
   * `collision.roofHeight`'s three clauses, in its order, over prisms it does
   * not have: skip anything that cannot beat the best so far, refuse anything
   * whose soffit is above the asker -- which is what stops a player under a
   * viaduct being handed its deck as their floor -- and then the polygon.
   */
  roofHeight(x: number, z: number, feetY: number): number {
    let best = -Infinity;
    const stations = this.stationGrid.get(
      fieldCell(Math.floor(x / STATION_CELL_M), Math.floor(z / STATION_CELL_M)),
    );
    if (stations !== undefined) {
      for (const i of stations) best = pick(this.stationSolidsFor(i).prisms, x, z, feetY, best);
    }
    const segments = this.segmentGrid.get(
      fieldCell(Math.floor(x / SEGMENT_CELL_M), Math.floor(z / SEGMENT_CELL_M)),
    );
    if (segments !== undefined) {
      for (const i of segments) best = pick(this.segmentSolidsFor(i).prisms, x, z, feetY, best);
    }
    return best;
  }
}

/** `collision.roofHeight`'s loop, over one list. */
function pick(prisms: readonly Indexed[], x: number, z: number, feetY: number, best: number): number {
  for (const p of prisms) {
    if (p.top <= best) continue;
    if (feetY < p.base - 0.05) continue;
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPolygon(p.points, x, z)) best = p.top;
  }
  return best;
}

/** File one record into every cell of a grid its padded box touches. */
function file(
  grid: Map<number, number[]>, i: number,
  minX: number, minZ: number, maxX: number, maxZ: number, cell: number,
): void {
  for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
    for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz++) {
      const key = fieldCell(cx, cz);
      const list = grid.get(key);
      if (list === undefined) grid.set(key, [i]);
      else list.push(i);
    }
  }
}
