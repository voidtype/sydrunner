/**
 * Tile streaming and runtime LOD.
 *
 * Spec section 3.2 draws the distinction this module exists to honour: authoring
 * quality is uniform everywhere, and LOD is purely a *rendering* optimisation --
 * the identical asset drawn more cheaply when it is far away. Nothing here may
 * make a distant suburb a worse building than a near one; it may only draw the
 * same building with less work.
 *
 * Bands, from the spec:
 *    0-80 m     full material, parallax reveals, geometric detail
 *    80-400 m   flat facade plane, parallax windows, full material
 *    400-2000 m massing plus roof form, baked albedo, no parallax
 *    2000 m+    merged silhouette, single averaged colour
 *
 * Transitions use distance hysteresis so a tile sitting exactly on a boundary
 * cannot thrash between bands as the player steps back and forth.
 *
 * ---------------------------------------------------------------------------
 * HOW A TILE ARRIVES, AND WHY IT IS THREE PHASES RATHER THAN ONE.
 *
 * It used to be one. `loadTile` fetched eleven payloads with a `Promise.all`,
 * parsed all of them on the main thread, built every geometry and instanced set
 * for the tile, and inserted the lot into the scene -- and because a settled
 * `Promise.all` continuation runs as a microtask inside whatever task settled
 * the last promise, *all of that was one uninterruptible task*. Measured over
 * the thirty-two heaviest tiles in the inner ring, four at a time, which is what
 * `concurrency` actually does:
 *
 *     tasks over 16 ms    17 across 32 tiles, worst 48.7 ms, 360 ms total
 *     GLB parse           p50  2.4 ms   p95 14.1 ms
 *     build + insertion   p50  2.3 ms   p95  3.8 ms
 *
 * On the M-series Mac it was developed on that hides inside a 16.7 ms frame most
 * of the time. On a modest Windows laptop, four to six times slower per core, it
 * is a quarter of a second of a game that does not draw, every few seconds, for
 * as long as the player keeps walking into new city. That is the bug.
 *
 * So:
 *
 *   1. **Fetch, on the main thread.** `world/cdn.ts` decides where every byte
 *      comes from and holds the CDN's health -- one probe, one strike counter,
 *      one set of counters the HUD reads. A worker would get its own copy of all
 *      of that, so the fetch stays here and the *bytes* travel, not the URL.
 *   2. **Decode, on a worker.** `world/decode.worker.ts` turns the GLB and six
 *      sidecars into plain typed arrays and transfers them back. Nothing about
 *      this phase touches the main thread except the `postMessage` either side.
 *   3. **Construct, here, under a per-frame budget.** Wrapping a transferred
 *      `Float32Array` in a `BufferAttribute` is free; what is not free is the
 *      per-instance matrix loops and the scene insertion. Those are broken into
 *      steps and drained by `pumpBuilds` across however many frames it takes at
 *      `BUILD_BUDGET_MS` a frame. A tile appears two or three frames later than
 *      it used to, which nobody can see, instead of appearing at the far side of
 *      a dropped frame, which everybody can.
 *
 * Two payloads are deliberately still decoded on the main thread, in a budgeted
 * step of their own: `.cars.bin` and `.lanes.bin`. Their decoders live in
 * `world/cars.ts` and `game/traffic.ts`, both of which import `three`, so a
 * worker that called them would pull the entire WebGPU renderer onto a second
 * thread to read a sidecar. Measured, they are the two cheapest things in the
 * whole load -- 0.03 ms and 0.07 ms a tile against a 2.5 ms budget -- so they
 * cost a fraction of one step and buy nothing by moving.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING INVARIANT, which the budget must not break.
 *
 * **A tile's ground is answerable before the tile can be seen, and stays so
 * after it is gone.** `TerrainField.ensure` is still awaited in phase 1, before
 * a single geometry exists, and the field never evicts -- so the grid a player
 * stands on is in memory strictly earlier than the buildings standing on it, by
 * however many frames the build queue took. The queue can only ever make a tile
 * appear *later*, never earlier, which is the safe direction for this and for
 * collision alike (`main.ts` loads collision on its own 420 m radius, well
 * inside the 1,800 m the renderer streams, so a visible tile out at a kilometre
 * has always been an uncollidable one and still is).
 *
 * **Nothing outside the tile learns about it until it is whole.** The traffic
 * field, the pedestrian field, the powerup sink, the far layer and `loaded` are
 * all told in the final step, in the same task as `root.add`. A build abandoned
 * half way -- the player walked away, the atlas filled -- therefore has nothing
 * to undo but its own geometry and its atlas row. See `cancelBuild`.
 *
 * ---------------------------------------------------------------------------
 * AND THE OTHER END OF THE LIFETIME, which is where the invisible walls were.
 *
 * The paragraph above is about a tile arriving. Two things about a tile
 * *failing* and a tile *leaving* were wrong, and both of them manufacture the
 * one defect a player cannot diagnose: collision they are stopped by with
 * nothing drawn there.
 *
 *   1. **A tile that failed once was never asked for again.** `update` gated on
 *      a `failed` set that nothing emptied, so a single aborted fetch cost that
 *      tile's geometry for the whole session -- while `main.ts` went on
 *      fetching its 9 kB collision payload on a different radius, successfully,
 *      because a small request and a 1.6 MB one do not fail together. The set
 *      is now a `TileRetryLedger`: a 404 or 410 is a fact about the build and is
 *      suppressed and counted, and everything else is retried at 5 s, 15 s,
 *      45 s and then every two minutes, reset by a successful load.
 *   2. **Collision had no upper end to its lifetime at all.** `CollisionWorld`
 *      only ever grew; geometry is evicted the moment a tile leaves the 1,800 m
 *      radius. So a return trip was *guaranteed* to find tiles with prisms and
 *      no buildings -- 676 walls across 6 tiles on the shipped build, every lap,
 *      with no network fault in it. `dispose` now takes the prisms with the
 *      geometry, but only outside `COLLISION_KEEP_RADIUS_M`, because collision
 *      is safety and geometry is not; and a tile whose prisms *are* resident
 *      gets extra fetch concurrency and the head of the build queue, because it
 *      is a solid invisible block of city rather than a hole in the picture.
 *
 * The taxonomy, the backoff and the keep radius live in `world/tile-lifecycle.ts`
 * -- arithmetic with no scene graph in it, so it can be held still by a check on
 * either side of the wire. `world/invisible-walls.ts` is what draws the window
 * this closes.
 */

import { admits, blendHeading, cancels, priorityTiles, type SlotFacts } from './tilepriority.ts';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Vector3,
  type Camera,
  type MeshStandardNodeMaterial,
  type NodeMaterial,
  type Scene,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  MATERIALS,
  createFacadeMaterial,
  isStreetMaterial,
  isSurfaceMaterial,
  type FacadeGlobals,
  type MaterialName,
} from './facade.ts';
import { createAwningMaterial } from './awning.ts';
import {
  FENCE_IRON,
  FENCE_TIMBER,
  createFenceMasonryMaterial,
  createFenceOpenMaterial,
} from './fences.ts';
import {
  BirdAssets,
  GullFlocks,
  buildTileIbises,
  type SpawnGuard,
  type TileIbises,
} from './birds.ts';
import { CarAssets, buildTileCars, decodeCars, type TileCars } from './cars.ts';
import type { ParkedCarSink } from './carlod.ts';
// WORKSTREAM S: the same tile's parked cars, again, to the three-free field
// `game/driving.resolveTake` asks when a player presses E. A *second* sink rather
// than a second job for the model fleet, because that one is optional -- see
// `StaticCarSink`.
import type { StaticCarSink } from '../game/staticcars.ts';
import { decodeLanes, type TrafficField } from '../game/traffic.ts';
import type { PedestrianField } from '../game/pedestrians.ts';
import { createContactMaterial } from './contact.ts';
import type { FarCity, FarContract } from './far.ts';
import type { LandmarkContract } from './landmarks.ts';
import {
  type BladeLabelSite,
  BladeLabels,
  FurnitureAssets,
  buildTileBins,
  buildTilePosts,
  buildTileSignals,
  collectBladeLabels,
} from './furniture.ts';
import { createGroundMaterial } from './ground.ts';
// WORKSTREAM AJ: the arithmetic behind "the ground draws first", kept three-free
// so both boot lists can hold it still. The build-order table below is imported
// rather than described here for the reason its own header gives -- a sequence
// the builder drives from is a sequence a check can convict.
import {
  GROUND_FETCH_AHEAD,
  GROUND_REVEAL_RADIUS_M,
  coverage as groundRingCoverage,
  groundRing,
  stepOrder,
  type GroundCoverage,
  type TileBuildStep,
} from './ground-first.ts';
import {
  PowerupAssets,
  PowerupIcons,
  type PowerupDrawState,
  type PowerupSink,
} from './powerups.ts';
import { FacadeParamsAtlas } from './params-atlas.ts';
import {
  PowerAssets,
  buildTilePoles,
  buildTileWires,
  poleYaws,
} from './power.ts';
import {
  LAMP_RECORD_STRIDE,
  StreetLampAssets,
  buildTileColumnLamps,
  buildTileStreetLamps,
  deriveColumnLamps,
  type LampSource,
} from './nightlights.ts';
import { createStreetMaterial } from './street.ts';
import type { NamedSegment, TileStreetNames } from './streetnames.ts';
import { armCdn, fetchWorldAsset, fetchWorldBuffer, type CdnContract } from './cdn.ts';
import {
  addRegions,
  armRegions,
  updateRegions,
  verifyRegions,
  type RegionContract,
} from './regions.ts';
import {
  armHexes,
  ensureHexesNear,
  hexesArmed,
  hexesUsable,
  onHexTiles,
  updateHexes,
  verifyHexes,
  type HexContract,
} from './hexes.ts';
import { TileDecoder, verifyDecoderRoundTrip } from './decode-pool.ts';
import {
  BLDIDX_LOWER,
  TILE_PACK_VERSION,
  parseTileGlb,
  verifyMeshPack,
  type GlbPrimitive,
  type TileDecodeRequest,
  type TileDecodeResult,
  type TileVegetation,
} from './tile-decode.ts';
import { TerrainField, buildTerrainMesh, sampleTileGrid, type TileCut, type TileSeam } from './terrain.ts';
import type { SeamField } from './seam.ts';
import type { RailCut } from './rail-cut.ts';
import {
  carveUndercroft,
  emptyUndercroftTally,
  type UndercroftEnvelope,
  type UndercroftTally,
} from './undercroft.ts';
import {
  TileFetchError,
  TileRetryLedger,
  classifyTileFailure,
  mayEvictCollision,
} from './tile-lifecycle.ts';
import { worldVersionSuffix } from './version.ts';
import {
  buildWaterMeshes,
  createWaterClock,
  createWaterMaterial,
  waterPlanWorld,
  type WaterContract,
} from './water.ts';
import { warmupGeometry, type WarmupPart } from './warmup.ts';
import {
  VegetationAssets,
  buildTileTrees,
  createBushFloorMaterial,
  createParkGrassMaterial,
  createWetlandMudMaterial,
} from './vegetation.ts';
import { buildBudgetFor } from './buildbudget.ts';

export interface TileEntry {
  key: string;
  /** Building count. */
  b: number;
  /** Triangle count. */
  t: number;
  /** [minX, minZ, maxX, maxZ] in world metres. */
  bounds: [number, number, number, number];
  /** Tallest building, metres. */
  hmax: number;
  size: number;
  /**
   * Tree count in this tile's `.veg.bin`.
   *
   * Optional so an index written before vegetation existed still loads: absent
   * means zero, which means the sidecar is never fetched. Most tiles have trees
   * and a handful do not, and a 404 on a cold cache is not free.
   */
  v?: number;
  /** Parked car count in this tile's `.cars.bin`. Same contract as `v`. */
  c?: number;
  /**
   * Power poles standing in this tile, and wire spans *owned* by it.
   *
   * Two numbers because they are not the same set: a span is filed under the
   * tile containing its midpoint, so a tile can own spans whose poles are both
   * next door. Testing `p` alone would drop those spans at every seam, which is
   * why `loadPower` tests the union.
   */
  p?: number;
  w?: number;
  /**
   * Street furniture in this tile's `.furn.bin`: wheelie bins, street-name posts
   * and traffic signal heads.
   *
   * Three numbers sharing one sidecar, so the fetch test is their union -- but
   * they are kept apart because they are three different instanced meshes and a
   * single total would hide which. A tile with signals and no bins is common:
   * the signalised crossings are on the arterials, and bins want a house behind
   * the footpath.
   */
  fb?: number;
  fp?: number;
  fs?: number;
  /**
   * Spec 8.3's powerups in this tile's `.pow.bin` -- station entrances and
   * cafes, one number for both kinds.
   *
   * One rather than the furniture's three because the two kinds share a client
   * module as well as a sidecar: `PowerupIcons` decides which of its six
   * instanced sets to build from the decoded kinds, so the index only has to
   * answer "is there anything here".
   */
  pw?: number;
  /**
   * Named street centreline runs in this tile's `.names.bin`.
   *
   * Same fetch-test contract as everything above it, and the only one that is
   * non-zero on very nearly every tile in the build -- a tile with no named
   * street on it is a park, the harbour or an industrial edge. So this is the
   * count that decides almost nothing about *whether* to fetch and everything
   * about whether the readout can say anything at all in a given block.
   */
  sn?: number;
  /**
   * Vertices in this tile's `.water.bin`, and the level of its largest sheet.
   *
   * `wv` is the fetch test, like every count above it. `wy` is not a count at
   * all and is the only field in this record **gameplay** reads: it is the water
   * surface the wading rule is derived from, on this side and on the server's,
   * which is what lets the two agree without a protocol change. See
   * `world/wading.ts`.
   *
   * Both are absent on a dry tile rather than zero, and that matters for `wy`:
   * zero is a perfectly plausible water level -- 71 m above the datum's ground
   * -- so a dry tile carrying `wy: 0` would claim a lake at eye level over Surry
   * Hills.
   */
  wv?: number;
  wy?: number;
  /**
   * Way spans and car routes in this tile's `.lanes.bin`.
   *
   * The fetch test is the **union**, and unlike the furniture's three that is
   * not just tidiness: the two blocks in that sidecar are for different
   * consumers. `lr` is the traffic -- cars driving this tile's streets -- and
   * `lw` is the drivable network as reusable geometry, which a tile can carry
   * with no traffic scheduled on it at all (a cul-de-sac suburb, which is
   * common). Absent on a tile with no drivable street, like every count above.
   */
  lw?: number;
  lr?: number;
  /** Ground range over the tile, [min, max] metres. Absent on a pre-terrain index. */
  g?: [number, number];
}

/**
 * The ground contract, from `index.json`.
 *
 * Optional as a whole, so an index written before terrain existed still loads
 * and produces the flat world it described. `TERRAIN_DEFAULTS` is what stands in
 * for it, and it deliberately puts sea level at zero: with no terrain sidecars
 * anywhere, the far plane *is* the world and it belongs where the buildings are.
 */
export interface TerrainContract {
  /** Quads per tile edge; posts are one more. */
  grid: number;
  post_m: number;
  /** The AHD elevation world y = 0 sits at. Reported, never rendered. */
  datum_ahd: number;
  /** Where 0 m AHD is in world y. The far plane goes here. */
  sea_level_y: number;
}

const TERRAIN_DEFAULTS: TerrainContract = {
  grid: 16,
  post_m: 31.25,
  datum_ahd: 0,
  sea_level_y: 0,
};

export interface WorldIndex {
  version: number;
  /**
   * When the pipeline wrote this index, epoch seconds -- the build stamp every
   * asset URL carries as `?v=`. Optional because a world built before it existed
   * has none, in which case nothing is versioned and nothing breaks. See
   * `world/version.ts` for the whole argument, and note that this is *not*
   * `version` above: that is the payload format, and it changes when the
   * client's reader has to.
   */
  built?: number;
  /**
   * Where the immutable copy of *this* build lives, when one has been published:
   * a data-repo commit SHA that `scripts/publish-world.sh` stamps in after
   * pushing. Absent on any world that has not been published, which simply means
   * no CDN. See `world/cdn.ts` for why this pointer lives in the one world file
   * that is deliberately never cached.
   */
  cdn?: CdnContract;
  /**
   * The streaming bundles, when the pipeline wrote any: 2x2-tile region files
   * that hold every per-tile asset in a square kilometre behind one request.
   * Absent on a world built before they existed, which simply means every asset
   * is fetched on its own, exactly as it always was. See `world/regions.ts`.
   */
  regions?: RegionContract;
  /**
   * How this build's vertex attributes are packed, and the worst error that
   * cost. `pack` is the format version, and a build naming one this client does
   * not know is refused loudly by `verifyStreaming` rather than decoded into
   * noise. Absent on a world built before `meshpack` existed, whose tiles are
   * plain float32 and which `parseTileGlb` still reads.
   */
  geometry?: {
    pack?: number;
    max_position_error_mm?: number;
    max_uv_error_mm?: number;
    max_normal_error_deg?: number;
  };
  stage: string;
  radius_m: number;
  tile_size: number;
  origin: { lat: number; lon: number; crs: string };
  sun: { lat: number; lon: number; timezone: string };
  terrain?: TerrainContract;
  materials: string[];
  /**
   * Archetype names in the pipeline's own order, which is what a far slab's
   * archetype byte indexes. Optional because an index written before the far
   * layer existed carries it as an empty list.
   */
  archetypes?: string[];
  params_stride: number;
  /**
   * The far layer's contract. Absent means there is no far layer -- there is no
   * default for it and `main.ts` falls back to the flat far plane. Streaming
   * never reads it; it is here because this interface is the index.
   */
  far?: FarContract;
  /**
   * The water contract. Absent means this world has no water -- an index written
   * before the water pass describes a world whose harbour is dry ground, and
   * there is no default that could stand in for a sea level. `main.ts` reads it
   * for the far sheet; streaming never does, because a tile's own `wv` is the
   * whole of what streaming needs to know.
   */
  water?: WaterContract;
  /**
   * The hero landmark set's contract. Absent means this world has no
   * `landmarks.glb` -- a world built before the landmark pass, which has three
   * generic extrusions where the Harbour Bridge, the Opera House and Sydney
   * Tower should be and still loads. Streaming never reads it; `main.ts` does,
   * once, at boot. See `world/landmarks.ts`.
   */
  landmarks?: LandmarkContract;
  /**
   * The traffic contract. Absent means this world has no lane graph, no
   * `.lanes.bin` is ever fetched and nothing drives -- an index written before
   * the traffic pass, which still loads and is simply a city with parked cars
   * and no moving ones.
   *
   * What is in it that nothing else could supply is the *clock*: `hz` and
   * `epoch_ms` are what the baked timetables are denominated against, and a
   * build whose numbers disagree with `game/traffic.ts`'s would put every car in
   * the city somewhere plausible and wrong. `verifyTraffic` is handed this block
   * at boot for exactly that comparison.
   */
  lanes?: {
    version: number;
    hz: number;
    epoch_ms: number;
    routes: number;
    live_cars: number;
    route_length_m: number;
    signal_nodes: number;
    /**
     * The plan and height constants `streets.py` drew the surfaces with, and the
     * ones the *ways* block has to be read against.
     *
     * They are here for `hz` and `epoch_ms`' reason one block down: the ways
     * block is a centreline and two widths, and a consumer deriving footpaths
     * from it -- `game/pedestrians.ts` -- has to add the same kerb the pipeline
     * did or it puts everybody in Sydney a few centimetres into the traffic,
     * which renders perfectly. `verifyPedestrians` is handed this for exactly
     * that comparison. Optional because a world baked before they were written
     * still loads, and an absent number is simply not checked.
     */
    kerb_width_m?: number;
    carriageway_y_m?: number;
    footpath_y_m?: number;
  };
  /**
   * The hexagonal segments this world is cut into, from `root.json`.
   *
   * Present only on a segmented world, and its presence is what decides which
   * of the two boot paths `loadIndex` takes. Absent means every tile is already
   * in `tiles` because the client read `index.json` whole -- which is every
   * build before this pass, and what `?nohex` forces. See `world/hexes.ts`.
   */
  hexes?: HexContract;
  /**
   * The emitted tiles.
   *
   * **Grows during the session on a segmented world.** It starts empty and each
   * hex manifest pushes its own entries on as it lands, which is why every
   * consumer of it in this client either re-reads it (`update`'s pass,
   * `main.ts`'s `ensureGround`) or subscribes to `onHexTiles` for the delta
   * (`WaterLevels`, the offline bike plan). Nothing may snapshot it at boot and
   * assume it is the world.
   */
  tiles: TileEntry[];
  totals: Record<string, number>;
}

export type LodBand = 0 | 1 | 2 | 3;

/** Outer edge of each band, metres. Index is the band. */
const BAND_EDGES = [80, 400, 2000, Infinity];
/** Hysteresis: a tile must retreat this much further before dropping a band. */
const BAND_HYSTERESIS = 60;
/** Same idea for the shadow flags, which flip on their own distances. */
const SHADOW_HYSTERESIS = 40;

/**
 * The sun altitude the receive range is computed against, degrees, and the floor
 * under it.
 *
 * The shadow volume is a box in the *light's* frame, so the patch of ground it
 * covers is that box projected down the sun vector -- and that projection
 * stretches along the sun's bearing by `1 / sin(altitude)`. At the reference 3 pm
 * the sun is 57.1 degrees up and the stretch is 1.19; at 6 pm it is over three.
 * A range computed once at noon is therefore wrong every other hour of the day,
 * always in the direction of turning shadows off where there still are some.
 *
 * The floor stops that reaching for the horizon. Below 20 degrees the volume's
 * ground footprint is 640 m long and every texel in it covers 31 cm along the
 * bearing, so what is out there is a smear rather than a shadow, and paying five
 * texture compares a pixel over half the visible city to sample it is the wrong
 * trade. The beam is down to a fraction of noon by then anyway.
 */
const RECEIVE_ALTITUDE_FLOOR_DEG = 20;
/** Where the sun is when nobody has said. `calibration.REFERENCE_SOLAR`. */
const REFERENCE_ALTITUDE_DEG = 57.1;

/**
 * How close an ibis has to be before it is simulated at all, metres.
 *
 * Not a LOD band and not a shadow range -- a third distance, for a third
 * question, and it is set by the only thing that matters here: at 150 m a 0.84 m
 * bird is 0.32 degrees tall, which on a 1440-line display at this project's
 * 72-degree field and 0.75 render scale is **under two pixels**. A frozen bird
 * two pixels tall is indistinguishable from a walking one, so everything beyond
 * this is left exactly where it stood and never touched again.
 */
const LIFE_RADIUS = 150;

/**
 * How close a tile has to be for its powerup icons to be animated, metres.
 *
 * Spec 8.3's ghost pass reaches 60 m, and a tile is 500 m across, so a tile
 * whose near edge is 60 m away can hold a visible icon anywhere up to 560 m
 * from the camera along its diagonal -- but only the ones inside 60 m are drawn
 * at all, and the solid pass beyond that is the ordinary depth-tested object
 * which is a few pixels. 600 m is that plus margin, and what it saves is the
 * matrix loop on the fifty tiles a 1,800 m load radius holds that have nothing
 * on screen. An icon outside it freezes mid-spin, invisibly.
 */
const POWERUP_ANIMATE_RADIUS = 600;

/**
 * How far a tile's near edge may be and still be searched for street-name
 * legends, metres.
 *
 * A tile gate rather than the real test: `BladeLabels` does the per-blade one at
 * its own `LABEL_RADIUS`, and this only decides which tiles are worth handing
 * it. It has to be that radius plus enough slack that a blade in a tile whose
 * near edge is just outside cannot be inside -- which is zero, because
 * `distanceToBounds` measures to the near edge and a blade is never nearer than
 * its own tile. The margin is here anyway, at one tile's worth, so a future
 * change to how bounds are measured cannot silently drop the legend off the
 * corner the player is standing on.
 */
const BLADE_LABEL_RADIUS = 200;

/**
 * How long `pumpBuilds` may spend constructing GPU resources in one frame,
 * milliseconds.
 *
 * The number is chosen against the frame, not against the work. At 60 Hz the
 * budget is 16.7 ms and this client spends 6-9 ms of it rendering on the
 * machines that struggle; 2.5 ms is a sixth of the frame and comfortably inside
 * what is left, and it retires the queue far faster than the network can fill
 * it -- measured, a whole tile costs 2.2 ms of construction at the median, so a
 * 2.5 ms budget is roughly 68 tiles a second against four concurrent fetches of
 * 1.6 MB each, which not even a warm CDN gets close to. The queue is therefore
 * empty almost always and this constant almost never binds. It exists for the
 * case where it does: a teleport, or a first walk into the CBD.
 *
 * **It is a check between steps, not a pre-emption.** A step that starts inside
 * the budget runs to completion, so the real bound is `BUILD_BUDGET_MS` plus the
 * longest single step -- which is one instanced population of one tile, under
 * 1.5 ms on the worst tile in the build. Making the bound tighter would mean
 * splitting the per-instance matrix loops in `vegetation.ts`, `cars.ts` and
 * `furniture.ts`, which is a lot of API for a millisecond that is already inside
 * the frame.
 */
const BUILD_BUDGET_MS = 2.5;

/**
 * Primitives lifted into `BufferGeometry` before the builder yields.
 *
 * Higher than it looks like it should be because this step is genuinely cheap:
 * the arrays arrived from the worker already built, so a primitive costs a
 * `BufferGeometry`, three or four `BufferAttribute` wrappers and a `Mesh` --
 * tens of microseconds, no copying and no per-vertex work at all, since the
 * atlas offset was folded into `_BLDIDX` on the decode thread. A tile has around
 * twenty primitives, so this is two or three yields rather than twenty.
 */
const GLB_PRIMITIVES_PER_STEP = 8;

/**
 * Instanced tree meshes lifted before the builder yields.
 *
 * Lower than `GLB_PRIMITIVES_PER_STEP` because these steps are the opposite kind
 * of cheap: a GLB primitive is a few `BufferAttribute` wrappers over arrays the
 * decode thread already built, while a tree mesh is a matrix loop over every
 * stem in its bucket -- a position, a yaw, a lean and a scale each. Four keeps
 * the longest single step near what `BUILD_BUDGET_MS`'s own paragraph claims of
 * it, which stopped being true when the world went from 1.77 M trees to 17.4 M.
 */
const TREE_MESHES_PER_STEP = 4;

/**
 * A tile that has been fetched and decoded and is now being built, one budgeted
 * step at a time.
 *
 * The generator holds the half-built state as its own locals, which is the whole
 * reason it is a generator: the alternative is a hand-written state machine with
 * a dozen fields on this interface, every one of them nullable, and a `switch`
 * that has to be kept in step with them.
 */
interface PendingBuild {
  entry: TileEntry;
  /**
   * The build, suspended between steps.
   *
   * Abandoning one is `steps.return()`, which is not a detail: the builder wraps
   * its whole body in a `try/finally`, so the same clause releases the geometry
   * and the atlas row whether the build was cancelled, threw, or simply never
   * reached its commit. There is no second cleanup path to keep in step with the
   * first.
   */
  steps: Generator<void, void, void>;
}

/**
 * WORKSTREAM AJ: how long `pumpGround` may spend building ground sheets in one
 * frame, milliseconds.
 *
 * Its own budget rather than a share of `BUILD_BUDGET_MS`, and the split is the
 * point: the two queues are in a race the ground has to win, so taking the
 * ground's time out of the geometry's would be spending the fix on the thing it
 * is fixing. The number is small because the work is: `buildTerrainMesh` is 640
 * triangles over a grid already in memory, measured at 0.2-0.4 ms a tile, so
 * 1.0 ms retires two or three sheets a frame -- and the whole 600 m reveal ring
 * is eleven. Even a teleport, which invalidates every sheet at once, is a
 * fraction of a second at this rate.
 *
 * A check between steps rather than a pre-emption, exactly as
 * `BUILD_BUDGET_MS` is, so the real bound is this plus one sheet.
 */
const GROUND_BUDGET_MS = 1.0;

/**
 * How far the camera must move before the ground ring is recomputed, metres.
 *
 * A quarter of a tile. The ring is a set of 500 m rectangles tested against a
 * radius, so moving 125 m can add or drop at most the tiles already within
 * 125 m of the boundary -- which the radius' own margin covers -- and it turns a
 * per-frame pass over 18,113 index entries into one pass every few seconds of
 * walking. `prefetchAt` makes the same trade one level up for the same reason.
 */
const RING_CACHE_STEP_M = 125;

/**
 * One tile's ground, as a thing with a lifetime of its own.
 *
 * The `receives` flag is a copy of `LoadedTile.receives` and has to be, because
 * the sheet is no longer inside the group `applyShadowRole` walks -- and leaving
 * it permanently receiving is not the harmless simplification it looks like:
 * three keys the render pipeline on `receiveShadow`, so every sheet out at
 * 1,800 m would pay the shadow gathers to find out that the lookup lands outside
 * the map. The rule and the hysteresis are the tiles' own; see
 * `applyGroundShadowRole`.
 */
interface GroundSheet {
  entry: TileEntry;
  mesh: Mesh;
  receives: boolean;
}

interface LoadedTile {
  entry: TileEntry;
  group: Group;
  /**
   * Whether this tile's pipelines have been compiled, and therefore whether it
   * is allowed to be drawn at all.
   *
   * **The fix for the freeze on turning**, and the reason it is a per-tile flag
   * rather than something in `world/warmup.ts`. Three keys an instanced draw's
   * node-builder state on `object.uuid` -- `RenderObject.getMaterialCacheKey`
   * does it unconditionally for `isInstancedMesh`, with a TODO pointing at
   * three.js#29066 -- so **every `InstancedMesh` in the world gets its own
   * shader module and its own render pipeline**, whatever its geometry, its
   * material or its capacity. The generated WGSL is not even textually equal:
   * the instance matrix arrives as a uniform struct named `NodeBuffer_<node id>`
   * and the id is a fresh global counter per build.
   *
   * There are about thirteen instanced sets in a tile, so a resident ring is
   * over a thousand pipelines that no boot-time warm-up can ever pre-compile.
   * And `update` below flips `group.visible` from a **frustum test**, so the
   * frame they compile on is the frame the tile enters the view -- which is why
   * this presented as a freeze when the player turned on the spot, with nothing
   * loading and nothing moving. Measured: one 360-degree turn at 180 deg/s with
   * 56 tiles resident compiled 589 pipelines, p95 242 ms, worst frame 1,492 ms;
   * the same turn repeated compiled nothing and peaked at 62 ms.
   *
   * So a tile is compiled **once, asynchronously, when it is built** -- see
   * `setPrecompiler` -- and is not shown until that has landed. The compile is
   * off the main thread (`device.createRenderPipelineAsync`), it happens while
   * the tile is already streaming rather than at a moment the player chose, and
   * by the time anybody turns around there is nothing left to compile.
   *
   * True with no precompiler set, so a caller that never installs one gets the
   * old behaviour exactly.
   */
  warm: boolean;
  band: LodBand;
  /** Shadow flags, tracked separately from the band -- see `applyShadowRole`. */
  casts: boolean;
  receives: boolean;
  centre: Vector3;
  /** Half-diagonal plus tallest building, for frustum culling. */
  box: Box3;
  /** Trees resident in this tile. Reported, and used by nothing else. */
  trees: number;
  /** Water triangles resident in this tile. Likewise. */
  water: number;
  /**
   * This tile's water as a world-space triangle soup, or null, for the map.
   *
   * Held on the tile and dropped with it, on `bladeLabels`' terms and for the
   * same reason: the query that reads it spans several tiles and has to compare
   * in a frame they share, so the conversion happens once at load rather than
   * per redraw. 13 kB on a full-water tile and nothing at all on the 213 dry
   * ones. See `world/minimap.ts`'s figure-ground argument for why the map wants
   * it: without a fill of its own the harbour reads as an enormous plaza.
   */
  waterPlan: Float32Array | null;
  /** Parked cars resident in this tile. Likewise. */
  cars: number;
  /** Power poles resident in this tile, and wire spans owned by it. Likewise. */
  poles: number;
  spans: number;
  /**
   * Where this tile's luminaires hang, in **world** metres, four floats each --
   * x, y, z, and 1 for sodium.
   *
   * World rather than tile-local, unlike everything else a tile owns, and for
   * `bladeLabels`' reason: the thing that reads this is the night rig's four
   * real `PointLight`s, which are not in a tile and cannot be. Converted once at
   * load rather than per frame. Empty for the majority of tiles, which have no
   * poles at all.
   */
  lamps: Float32Array;
  /** Wheelie bins, street-name posts and signal heads resident here. Likewise. */
  bins: number;
  posts: number;
  signals: number;
  /**
   * Where this tile's named blades hang, in **world** metres.
   *
   * Converted out of the sidecar's tile-local frame once, here, at load: the
   * legend pool is one scene-wide set drawn from every resident tile, so it has
   * to compare distances in a frame all the tiles share, and doing the addition
   * at load rather than at each rebuild means it happens once per tile instead
   * of once a second per tile. Empty for a tile with no named corner, which is
   * most of them.
   */
  bladeLabels: BladeLabelSite[];
  /**
   * This tile's named street centrelines, in **world** metres, or null.
   *
   * Lifted out of the sidecar's tile-local frame once at load, for the reason
   * `bladeLabels` is: the query that reads them spans several tiles at once and
   * has to compare in a frame they share. Held on the tile and dropped with it
   * -- see `world/streetnames.ts` on why this one is deliberately *not* the
   * never-evicted session-wide index `TerrainField` keeps.
   */
  streets: TileStreetNames | null;
  /**
   * The tile's ibises, or null where there was nothing to hang one on.
   *
   * Held on the tile rather than in a list of its own because that is the whole
   * lifecycle: they load with the tile, they are hidden and shadowed with it,
   * and they are disposed with it. `updateLife` is the only thing that reaches
   * in here and it does so through the same distance the streamer already
   * computes for everything else.
   */
  birds: TileIbises | null;
  /**
   * Spec 8.3's icons, or null where the tile has none.
   *
   * Held on the tile for the reason the birds are: they load with it, they are
   * hidden and disposed with it, and `updateLife` is the only thing that
   * reaches in. Their *state* is not here and must not be -- that lives in the
   * `PowerupSink` and outlives the tile, which is what makes a respawn survive
   * an eviction.
   */
  powerups: PowerupIcons | null;
  /** The states the icons animate against, in sidecar order. Empty without a sink. */
  powerupStates: readonly PowerupDrawState[];
}

/**
 * The slice of `CollisionWorld` the streamer touches, and the whole of it.
 *
 * An interface rather than the class, for the reason every other handle in this
 * file is one: the streamer must not be able to *ask a collision question*. It
 * has no business knowing where a wall is; what it needs is the two facts that
 * pair a tile's prisms to its geometry -- whether they are resident, and the
 * ability to take them away when the geometry goes. Handing it the class would
 * put `resolve` within reach of a module whose job is drawing, and the parallel
 * question of what `resolve` means is somebody else's.
 */
export interface CollisionSink {
  hasTile(key: string): boolean;
  removeTile(key: string): number;
}

/**
 * Who holds the carriageways. `world/road-deck.RoadDeck`, structurally.
 *
 * `adopt` returns the plan box of what it took, grown by the margin asked for,
 * or `null` when the tile had no road on it -- which is what tells the streamer
 * how far to re-cut the ground for a road that arrived after its neighbours were
 * already standing.
 */
export interface RoadSink {
  adopt(
    key: string,
    ways: ReadonlyArray<{
      halfWidth: number;
      footpathWidth: number;
      count: number;
      x: Float32Array;
      y: Float32Array;
      z: Float32Array;
    }>,
    margin?: number,
  ): [number, number, number, number] | null;
  drop(key: string): void;
}

/**
 * How far past a new tile's roads the ground is re-cut, metres.
 *
 * A road is clipped to its own tile, so the only ground it can newly keep is
 * within its own paved half-width of itself -- and the widest carriageway in the
 * extract is `streets.MAX_ROAD_WIDTH` plus a footpath band, comfortably under
 * this. It is a bounding box grown by a constant rather than an exact reach
 * because the sweep it feeds costs one rectangle test per resident tile.
 */
const ROAD_RECUT_MARGIN_M = 24;

/**
 * Extra concurrent fetches a tile may have when its collision is already
 * resident.
 *
 * A tile with prisms and no geometry is, right now, a block of solid invisible
 * city. Everything else in the load radius is a hole in the picture. So the
 * hazard set jumps the queue, and two extra slots is what it takes to matter:
 * a revisit puts six or so tiles into that state at once, and four slots
 * retires them in two round trips of a 1.6 MB payload where six retires them in
 * one.
 *
 * Bounded, which is the reason it is safe. The hazard set is exactly the tiles
 * `main.ts` has collision for, which is its own 420 m ring -- nine tiles at the
 * absolute most -- so this cannot become an unbounded fan-out however far the
 * player teleports. Six concurrent fetches is also still inside the browser's
 * six-per-origin limit, so it costs no queueing anywhere else.
 */
const HAZARD_EXTRA_SLOTS = 2;

/**
 * Scratch for `nearestLamps`, which runs six times a second and must allocate
 * nothing. `_lampDistances` is squared distances parallel to the caller's output
 * array; sixteen slots is four times what the night rig asks for and the method
 * clamps against it.
 */
const _lampProbe = /*#__PURE__*/ new Vector3();
const _lampDistances = /*#__PURE__*/ new Float32Array(16);
/** Shared by every tile with no luminaires in it, which is most of them. */
const EMPTY_LAMPS = /*#__PURE__*/ new Float32Array(0);

export interface StreamerOptions {
  /** Tiles beyond this are not loaded at all. */
  loadRadius?: number;
  /** Maximum tiles fetched concurrently. */
  concurrency?: number;
  /** Maximum tiles to keep resident before evicting the furthest. */
  budget?: number;
  baseUrl?: string;
  /** Half-extent of the sun's shadow volume, metres. From `SydneySky`. */
  shadowRadius?: number;
  /**
   * Decode threads. Zero forces every decode onto the main thread, which is
   * what a headless tile-loading test wants and what a browser with no `Worker`
   * gets anyway -- see `TileDecoder`.
   */
  decodeWorkers?: number;
  /** Milliseconds a frame for GPU-resource construction. See `BUILD_BUDGET_MS`. */
  buildBudgetMs?: number;
}

/**
 * Where a tile's mushrooms go. Implemented by `world/mushrooms.MushroomField`.
 *
 * Declared here rather than imported so the streamer depends on the *shape* and
 * not on the feature -- the same arrangement `PowerupSink` has, and the reason
 * a client that never builds a field costs nothing but a null check.
 */
export interface MushroomSink {
  adopt(
    tileKey: string,
    veg: TileVegetation,
    originX: number,
    originZ: number,
    groundAt: (x: number, z: number) => number,
  ): void;
  release(tileKey: string): void;
}


export class TileStreamer implements LampSource {
  readonly root = new Group();

  private index: WorldIndex | null = null;
  private readonly loaded = new Map<string, LoadedTile>();
  private readonly loading = new Set<string>();
  /**
   * Which tiles failed, how, and when to ask again.
   *
   * This was a `Map<string, number>` called `failed` that nothing ever emptied,
   * and it is the first of the two defects this pass exists to close: one
   * aborted fetch and that tile's geometry was never requested again for the
   * session, while `main.ts` went on fetching its collision successfully every
   * half second on a different radius. A permanent invisible wall from a 200 ms
   * network blip. See `world/tile-lifecycle.ts` for the taxonomy and the
   * backoff.
   */
  private readonly ledger = new TileRetryLedger();
  /**
   * Fetches to fail on purpose, for `debugFailTile`. Empty in every session
   * nobody has typed into a console.
   */
  private readonly injectedFaults = new Map<string, { status: number; times: number }>();
  /**
   * Whether a failure should say so on the console.
   *
   * Off only while `verifyLifecycle` is deliberately breaking things. A boot
   * check that warned about the faults it injected on purpose would put two
   * lines in every dev session's console that look exactly like the real
   * failure they exist to detect, which is the one way a diagnostic can make a
   * diagnosis harder.
   */
  private logFailures = true;
  /**
   * The reference GLB parser, kept for exactly one caller.
   *
   * Nothing in the streaming path uses it any more -- `parseTileGlb` on the
   * decode thread does that job. It is here because `verifyTileGlbParse` runs
   * both parsers over a real tile and compares them attribute by attribute,
   * which is the only honest way to claim that a hand-written reader of a
   * pipeline-specific GLB agrees with the general one. It costs nothing in the
   * bundle: `world/landmarks.ts` imports `GLTFLoader` regardless.
   */
  private readonly loader = new GLTFLoader();
  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();

  /** Phase 2. Lazily useful: with no worker it decodes inline, and still works. */
  private readonly decoder: TileDecoder;
  /**
   * Phase 3's queue, in arrival order.
   *
   * Arrival rather than distance, deliberately. `update` already fetches the
   * nearest missing tile first, so the queue is very nearly in distance order by
   * construction, and re-sorting it every frame would let a tile that is one
   * step from being finished be overtaken forever by a stream of slightly nearer
   * ones -- the classic starvation, and it would present as a hole in the city
   * that never fills while the player walks.
   */
  private readonly buildQueue: PendingBuild[] = [];
  /** The same jobs by key, so `update` does not re-request a tile mid-build. */
  private readonly building = new Map<string, PendingBuild>();
  /** Steps drained and frames pumped, for the debug overlay. */
  private builtTiles = 0;
  /** Tiles whose collision went out with their geometry. See `dispose`. */
  private collisionEvictions = 0;
  /**
   * Geometry evictions that had to leave collision behind because the tile was
   * inside `COLLISION_KEEP_RADIUS_M`.
   *
   * The counter that says the parity rule is being *asked* to do something it
   * refuses to do. It should be zero for the life of a session: geometry is
   * only ever evicted out past the 1,800 m render radius or, in the budget
   * path, from the furthest tiles of a set that reaches no further than that,
   * and both are a long way outside 1,000 m. A number that climbs means the
   * radii have been changed into overlapping and the amber-on-revisit case is
   * back -- see `world/tile-lifecycle.ts`, part 2.
   */
  private parityHolds = 0;
  /** Rebuilds put at the head of the queue because collision was resident. */
  private priorityBuilds = 0;
  /**
   * One controller per in-flight tile, so a fetch can be asked to stand down.
   *
   * The streamer had no cancellation at all before this: the ranking was
   * recomputed every frame but the four concurrency slots were committed at the
   * moment a fetch started and held until the bytes landed. Three seconds of
   * driving and all four belonged to tiles chosen from where the player used to
   * be, while the ground under their feet queued behind a megabyte and a half of
   * city they had already left. See `world/tilepriority.ts`.
   */
  private readonly aborts = new Map<string, AbortController>();
  /**
   * Tiles that were the current-or-next pair when their fetch started.
   *
   * They keep their slot for the whole of its life. Without this, crossing a
   * boundary cancels the tile you have just left *while it is arriving*, and
   * wants it again a second later because it is still well inside the radius --
   * strictly worse than not cancelling, paid for in bytes.
   */
  private readonly startedPriority = new Set<string>();
  /** Fetches asked to stand down, for the overlay. */
  private cancelledLoads = 0;
  /** Where the camera was last frame, for a heading. */
  private lastCamX: number | null = null;
  private lastCamZ: number | null = null;
  /**
   * The smoothed heading, in metres per frame.
   *
   * One frame of a car on a rough surface swings several degrees, and the
   * nomination follows it -- which spends the one slot that outranks everything
   * on churn between two tiles. See `tilepriority.HEADING_BLEND`.
   */
  private headX = 0;
  private headZ = 0;

  private readonly loadRadius: number;
  private readonly concurrency: number;
  private readonly budget: number;
  private readonly buildBudgetMs: number;
  private readonly baseUrl: string;
  /**
   * The build stamp every asset URL carries, as a query suffix, or `''` until
   * the index has been read and for a world built before the pipeline stamped
   * one. Not readonly for that reason: `index.json` is where it comes from, and
   * the index is fetched by this class. See `world/version.ts`.
   */
  private version = '';
  private readonly castRange: number;
  private readonly shadowRadius: number;
  /**
   * Not readonly, unlike its neighbours: it is a function of where the sun is,
   * and the sun moves. Recomputed by `update` from the altitude it is handed.
   */
  private receiveRange: number;

  /** One parameter texture and one material per slot for the entire world. */
  private readonly atlas = new FacadeParamsAtlas();
  /**
   * Typed as the node base class rather than as `MeshStandardNodeMaterial`
   * because one slot is not a standard material and must not be: `contact_ao`
   * is a `MeshBasicNodeMaterial`, since occlusion is the absence of light and a
   * lit shadow is a contradiction. See `contact.ts`.
   */
  private readonly materials: Map<MaterialName, NodeMaterial>;
  /** Six tree geometries and one foliage material, likewise shared world-wide. */
  private readonly vegetation = new VegetationAssets();
  /** Five car bodies and one paint material, on the same terms. */
  private readonly carAssets = new CarAssets();

  /**
   * The five shared car bodies and the one paint material.
   *
   * Exposed so the moving traffic can be built from the identical geometry the
   * parked cars use -- one `CarAssets` for the whole game, which is what keeps a
   * driving Hilux and a parked one visibly the same object and, more to the
   * point, keeps the material count at one. A second `CarAssets` would be a
   * second WebGPU pipeline compiled on the main thread for an identical shader.
   */
  get cars(): CarAssets {
    return this.carAssets;
  }
  /** Two pole geometries, the timber material and the unlit wire material. */
  private readonly powerAssets = new PowerAssets();
  /**
   * One geometry and one material for every street lamp in the city -- and one
   * more pair for the columns that stand where there is no pole to hang one on.
   *
   * Owned here rather than by `world/nightlights.ts`'s `NightLights`, because a
   * luminaire's lifecycle is a *tile's* -- it is built off the same `power.bin`
   * sidecar as the pole it hangs on, it is hidden and shadowed with the tile,
   * and its instance buffers go when the tile does. Exactly the arrangement
   * `powerAssets` above has, for exactly the same reasons.
   *
   * **Public**, and it stopped being private for exactly one caller.
   * `world/giverlamp.ts` stands a column over a hero quest giver -- there are no
   * street lights in Sydney Park, measured, and the Ladmaster is meant to be
   * standing under one -- and the whole argument for that feature costing
   * nothing is that it draws with *these*: the same geometry, the same
   * material, therefore the same pipeline. A second `StreetLampAssets` would be
   * a second material, a second compile, and a lamp in a park that is a
   * different night from the lamp on the street beside it.
   *
   * Read-only from outside for the other half of that: it is the city's, and
   * `dispose`-ing it from a caller would put out every light in Sydney.
   */
  readonly streetLamps = new StreetLampAssets();
  /**
   * Whether the night geometry in the resident tiles is being drawn.
   *
   * Only ever moved by `setNightLightsVisible`, which is called once a frame
   * with the dusk level and returns immediately on all but the two frames a day
   * where it changes. It is remembered here rather than read from the sky
   * because a tile that lands *after* dusk has to arrive already switched on --
   * a tile built dark at midnight would stay dark until the next dawn.
   */
  private nightLightsVisible = false;
  /** Bin, blade, post and signal geometry, and the materials they wear. */
  private readonly furnitureAssets = new FurnitureAssets();
  /**
   * The near-field street-name legends, and the one piece of street furniture
   * that is *not* per tile.
   *
   * A legend cannot be instanced -- it wears its own texture -- so it is drawn
   * from a scene-wide pool bounded by distance and count rather than one set per
   * tile. It lives here for the same reason `gulls` does: the streamer is what
   * owns the shared furniture assets and what already runs once a frame with the
   * camera in hand. See `BladeLabels`.
   */
  readonly bladeLabels = new BladeLabels(this.furnitureAssets);
  /** One ibis, one gull, and one material for both. Declared before `gulls`. */
  private readonly birdAssets = new BirdAssets();
  /**
   * The gulls, and the one thing in this class that is *not* per tile.
   *
   * A flock follows the camera rather than the ground, so it is added to the
   * scene directly and never evicted. It lives here anyway because the streamer
   * is what owns the shared bird assets and what already runs once a frame with
   * the camera in hand.
   */
  readonly gulls = new GullFlocks(this.birdAssets);
  /**
   * The collision predicate an ibis spawn is checked against. Null until
   * `main.ts` supplies one, and a null guard means no rejection at all -- see
   * `SpawnGuard`, and note that a bird is only ever checked once it is close
   * enough to be simulated, by which time the prisms have long since landed.
   */
  private spawnGuard: SpawnGuard | null = null;
  /**
   * The prisms, as a residency handle, or null before `main.ts` supplies one --
   * and null is a working configuration: it is what a headless tile-loading
   * test is, and it means collision is never evicted and no rebuild is
   * prioritised, which is exactly what this class did before. See
   * `setCollisionSink`.
   */
  private collisionSink: CollisionSink | null = null;
  /** Two geometries and three materials for every powerup in the world. */
  private readonly powerupAssets = new PowerupAssets();
  /**
   * Who owns spec 8.3's per-point state, or null before `main.ts` says.
   *
   * Null is a working configuration rather than a broken one -- see
   * `setPowerupSink`.
   */
  private powerupSink: PowerupSink | null = null;
  /**
   * What grows under this tile's trees. Null on most clients for most of a
   * session: mushrooms exist in one three-kilometre circle of Sydney.
   */
  private mushroomSink: MushroomSink | null = null;
  /**
   * Whoever owns the moving traffic, told about each tile as it arrives and
   * leaves. Set the same way `powerupSink` is and for the same reason -- it
   * outlives every tile it is told about, so it cannot be constructed from one.
   *
   * Without one, `.lanes.bin` is never fetched and no car moves. That is a
   * working configuration rather than a broken one: it is what a world built
   * before the traffic pass is, and what a headless tile-loading test wants.
   */
  private traffic: TrafficField | null = null;
  /**
   * Whoever owns the pedestrians, told about each tile on exactly the traffic's
   * terms and from the same two call sites.
   *
   * The *same sidecar* feeds both, which is the whole reason the pedestrians
   * cost the pipeline nothing: `.lanes.bin` carries a routes block for the cars
   * and a ways block for the footpaths, and this class fetches it once and hands
   * the decoded pair to two consumers. See `tiles.write_lanes`, which says in as
   * many words that the ways block exists for this.
   *
   * Null is a working configuration, like the traffic's -- a world with people
   * in it and nobody drawing them is what a headless tile-loading test wants.
   */
  private pedestrians: PedestrianField | null = null;
  /**
   * Whoever draws the near-field car models, told about each tile's *parked*
   * cars on the traffic's terms and from the same two call sites.
   *
   * Different from the three above in one way that matters: it is handed the
   * tile's own `InstancedMesh`es, not just data, because the only way to stop a
   * parked box drawing under a parked model is to reach into the matrix buffer
   * the tile built. That makes `release` a hard requirement rather than
   * housekeeping -- it is what guarantees the reference is dropped before
   * `dispose` frees the buffer. See `world/carlod.ts` section 3.
   *
   * Null is a working configuration: it means every parked car stays a box,
   * which is what this client did before the model fleet existed.
   */
  private parkedCars: ParkedCarSink | null = null;
  /**
   * WORKSTREAM S: whoever holds the parked fleet as *takeable cars*.
   *
   * The same `TileCars` the sink above is handed and the same two call sites,
   * with none of the mesh coupling: this one gets data and an origin. Null is a
   * working configuration and means the browser's take prompt only ever offers a
   * schedule car, which is exactly what shipped before this workstream.
   *
   * Separate from `parkedCars` because that object is built behind a deadline and
   * may be null; see `game/staticcars.StaticCarSink`.
   */
  private staticCars: StaticCarSink | null = null;
  /**
   * The far city, or null before `main.ts` supplies one -- and null is a working
   * configuration, not a broken one: it means every slab draws always, which is
   * exactly what this world did before the far layer had a residency rule. See
   * `setFarCity`.
   */
  private farCity: FarCity | null = null;
  /** `performance.now()` at the last `pumpBuilds`, for the frame-aware budget. */
  private lastPumpAt = 0;

  /** What compiles a tile's shaders before it is drawn. See `setPrecompiler`. */
  private precompile: ((group: Group) => Promise<void>) | null = null;
  /** Tiles built and waiting to be compiled, nearest-first. See `warmTile`. */
  private readonly warmQueue: LoadedTile[] = [];
  private warming = false;
  /**
   * The unpaved-ground shading, worn by every tile's terrain mesh -- and, via
   * this handle, by the far plane as well, so the near ground and the far field
   * are one pipeline and one look rather than two of each.
   */
  readonly groundMaterial = createGroundMaterial();
  /**
   * The wave clock, and the one material every sheet of water in the world wears
   * -- every tile's, and `main.ts`'s far sheet, which takes this same instance.
   *
   * Shared for the reason every material here is shared and one more that is
   * specific to this one: the waves are a function of world position and this
   * clock, so a second instance would be a second clock, and two clocks a frame
   * apart tear along every tile boundary in the harbour. See `world/water.ts`.
   */
  readonly waterClock = createWaterClock();
  readonly waterMaterial: MeshStandardNodeMaterial;
  /**
   * Every loaded tile's height grid. Created on `loadIndex`, once the grid size
   * is known; null until then, which is also what a pre-terrain index leaves it
   * as. Owned here rather than in `main.ts` because the streamer is what fetches
   * a tile's sidecar, but it outlives any individual tile -- see `terrain.ts`.
   */
  private terrainField: TerrainField | null = null;
  /**
   * The rail corridor, once `main.ts` has a bake. Null means "draw the ground
   * as the DEM left it", which is every world built before the railway was.
   */
  private railCut: RailCut | null = null;
  /** The vessel rim the ground is triangulated to, or null. See `setSeam`. */
  private seam: SeamField | null = null;

  /* --- WORKSTREAM AJ: the ground layer ---------------------------------------
   *
   * The ground used to be a child of the tile group and therefore arrived with
   * the tile: 1,156 bytes waiting on 311 kB, and on a CBD tile 1.6 MB. It is now
   * a sheet of its own, built the moment its grid lands, and the tile's geometry
   * catches up through the budgeted queue as it always did. See
   * `world/ground-first.ts` for the payload arithmetic that makes this nearly
   * free and for what the player was actually seeing before it.
   *
   * `groundRoot` sits in the scene beside `root` rather than inside it, on the
   * gulls' and the blade labels' argument: `root` is the tiles and eviction
   * walks it. A sheet outlives no tile -- it is dropped with the same eviction,
   * one line further down `dispose` -- but it is not *of* one either, and
   * `setNightLightsVisible`'s walk over `root.children` would otherwise be
   * looking inside a mesh for lamps.
   */
  private readonly groundRoot = new Group();
  private readonly groundSheets = new Map<string, GroundSheet>();
  /**
   * Tiles whose ground is answered: a sheet is built, or the build does not
   * contain one.
   *
   * The second half is what stops every gate in this subject from hanging on a
   * hole in the pipeline's output. A `.terr.bin` that 404s is a fact about the
   * build -- `TerrainField` remembers it forever and will never fetch it again
   * -- so a coverage predicate that waited for it would wait for the session.
   * A *transient* failure is deliberately not in here: that one is coming back
   * on `RETRY_AFTER_MS`, and `GROUND_REVEAL_DEADLINE_MS` is what bounds the wait
   * if it does not.
   */
  private readonly groundSettled = new Set<string>();
  /**
   * The last ring computed at each radius, and where from.
   *
   * `groundRing` is a linear pass over `index.tiles`, which is 18,113 entries in
   * the shipped build -- fine once, ruinous at 60 Hz from a boot poller that has
   * nothing better to do. The ring can only change when the query point leaves
   * the cell it was in, so it is recomputed on a `RING_CACHE_STEP_M` grid and
   * reused in between. The camera does not move at all during the boot, so the
   * gate's whole life costs one pass.
   *
   * **Keyed by radius, and it has to be.** Two rings are live at once during the
   * reveal -- the fetch priority's 900 m and the gate's 600 m -- and a single
   * slot would have them evicting each other every frame, which is the pass this
   * cache exists to avoid, twice.
   */
  private ringCache = new Map<number, { x: number; z: number; ring: string[] }>();
  /** Ground sheets built this session. Monotonic; for the overlay. */
  private builtSheets = 0;
  /**
   * How many frames this streamer has been driven through.
   *
   * The client's own answer to "is the render loop running", and the boot's
   * reveal gate is the caller that needs it. `renderer.setAnimationLoop` is the
   * **last statement** of `main`, so everything the boot does -- the far layer,
   * the rail bake, the name prompt, the socket, the spawn, the scene shader pass
   * -- happens with nothing rendered and nothing streamed. A curtain that came
   * up before this was non-zero would be uncovering an empty canvas, which is
   * the defect the gate exists to close rather than a state to reveal into.
   *
   * Counted here rather than read off `renderer.info`, whose per-frame counters
   * are reset by the renderer itself and say nothing about whether a frame has
   * ever happened. This one only goes up.
   */
  private framesSeen = 0;

  constructor(
    scene: Scene,
    globals: FacadeGlobals,
    opts: StreamerOptions = {},
  ) {
    this.loadRadius = opts.loadRadius ?? 1800;
    this.concurrency = opts.concurrency ?? 4;
    this.budget = opts.budget ?? 220;
    this.buildBudgetMs = opts.buildBudgetMs ?? BUILD_BUDGET_MS;
    this.baseUrl = opts.baseUrl ?? '/world';
    this.decoder = new TileDecoder(opts.decodeWorkers ?? 2);
    this.root.name = 'tiles';

    // Shadow roles are distances, not LOD bands, and conflating the two is what
    // made the shadows disappear. A band answers "how expensively should this be
    // shaded"; casting and receiving answer "does this tile overlap the sun's
    // 220 m shadow volume", which is a different question with a different
    // number in it.
    //
    // Receive: a tile receives if any part of it is inside the volume. Outside
    // it the shadow lookup lands outside the map and the filter returns full
    // light -- `ShadowNode.setupShadowFilter` wraps the taps in
    // `frustumTest.select(shadowNode, 1.0)` -- but it still costs the gathers to
    // find that out, so this is a real saving, not tidiness.
    //
    // **The radius is not the answer to that question and used to be used as
    // it.** The volume is a box in the *light's* frame, and the ground it covers
    // is that box projected down the sun vector: half-extent R across the sun's
    // bearing, but R / sin(altitude) *along* it, so the far corner of the
    // footprint is R * hypot(1, 1 / sin(alt)) from the player -- 342 m at the
    // reference 3 pm against the 220 this was set to. Everything between those
    // two numbers is ground with a real shadow on it belonging to a tile that
    // has been told not to look, and since `distanceToBounds` is measured to a
    // 500 m tile's nearest edge, the flip takes the whole tile at once: a block
    // of the mid-field switching from shadowed to flat-lit in one frame as you
    // walk past 300 m of it. That is the "flickery" a player reports and it is
    // not the streaming, it is this line. `sunReceiveRange` below computes it.
    //
    // Cast: a caster has to be *up-sun* of the ground it darkens, so the casting
    // set reaches further than the volume. In light space the box is +/-220, a
    // point h metres up sits cos(alt)*h along the up axis and a point q metres
    // toward the sun sits -sin(alt)*q, so the two partly cancel and the reach is
    // q <= (220 + cos(alt)*h) / sin(alt) -- 262 m for a low building at 3 pm,
    // 432 m for a 263 m tower. Twice the radius covers everything up to about
    // 275 m tall, which is everything the pipeline emits.
    //
    // Left as a constant, unlike the receive range, and the numbers say why. Run
    // the same corner term over it -- hypot(R, (R + cos(alt)*h) / sin(alt)) --
    // and at 3 pm a 20 m terrace needs 352 m and Salesforce Tower needs 485 m,
    // against a flag that holds to 480 with the hysteresis. So the only caster
    // this cuts early is a 263 m tower at the very corner of the volume, by five
    // metres, where its shadow is one texel from running off the map anyway.
    // Nothing a player can see, against a depth pass that would otherwise grow
    // by the ring from 440 m to 485 m across every tile in the world.
    const shadowRadius = opts.shadowRadius ?? 220;
    this.shadowRadius = shadowRadius;
    this.receiveRange = sunReceiveRange(shadowRadius, REFERENCE_ALTITUDE_DEG);
    this.castRange = shadowRadius * 2;

    // Built once, up front. These are the only pipelines the renderer ever
    // compiles, which is what keeps tile loading from stalling the frame. Ground
    // surfaces take their own far simpler materials: they read neither the
    // parameter atlas nor `_BLDIDX`, and running road or park geometry through
    // the facade graph would cost a window grid nothing on either would use.
    // The contact skirt is simpler again -- it reads no light either, because
    // its shading is baked into its vertices.
    this.materials = new Map(
      MATERIALS.map((slot) => [
        slot,
        isStreetMaterial(slot)
          ? createStreetMaterial(slot)
          : slot === 'park_grass'
            ? createParkGrassMaterial()
            : // The two bushland ground slots, on `park_grass`' terms exactly:
              // flat, world-metre UVs, no atlas, no `_BLDIDX`. Which one a
              // patch of ground landed in is which cover class won it in the
              // pipeline, and the three are cut disjoint there so no two of
              // them are ever over the same square metre.
              slot === 'bush_floor'
              ? createBushFloorMaterial()
              : slot === 'wetland_mud'
                ? createWetlandMudMaterial()
                : slot === 'contact_ao'
              ? createContactMaterial()
              : // The awning fascia and soffit. A facade material by the one
                // test that matters -- it casts a shadow, and shading the
                // footpath is the entire point of an awning -- but it reads no
                // parameter atlas and no `_BLDIDX`, because its colour is per
                // shop rather than per building. See `world/awning.ts`.
                slot === 'awning_fascia'
                ? createAwningMaterial()
                : // The three front-fence styles, on the same terms again: they
                  // cast, they receive, and they read no atlas. Which style a
                  // building got is which slot its geometry landed in -- the
                  // pipeline chooses per building and a slot is how it says so.
                  // See `world/fences.ts` and `fences.py`.
                  slot === 'fence_masonry'
                  ? createFenceMasonryMaterial()
                  : slot === 'fence_iron'
                    ? createFenceOpenMaterial(FENCE_IRON)
                    : slot === 'fence_timber'
                      ? createFenceOpenMaterial(FENCE_TIMBER)
                      : createFacadeMaterial(slot, this.atlas.texture, globals),
      ]),
    );

    // Built here rather than as a field initialiser only because it needs the
    // constructor's `globals` -- it reads `sunDirection` off the same instance
    // the facades do, which is what keeps there being one sun.
    this.waterMaterial = createWaterMaterial(globals, this.waterClock);

    scene.add(this.root);
    // WORKSTREAM AJ. Not in `this.root` either, and see the field's header for
    // the two reasons: eviction walks that group, and so does the night-lights
    // pass, and a ground sheet is neither a tile nor inside one.
    this.groundRoot.name = 'ground';
    scene.add(this.groundRoot);
    // Not in `this.root`: that group is the tiles, and eviction walks it.
    scene.add(this.gulls.mesh);
    // Nor is this one, and for the same reason plus one more: a legend belongs
    // to a blade in some tile, but the pool that draws it is scene-wide and its
    // members are re-posed once a second from whichever tiles are near. Putting
    // it under a tile group would make an eviction walk delete meshes the pool
    // still owns.
    scene.add(this.bladeLabels.group);
  }

  /**
   * Every named centreline run within `radius` of a world point.
   *
   * The query `game/locator.ts` is built on, and the thing that made
   * `streetNameNear` below no longer the best answer available: it is the
   * street *network* rather than the blades standing on it, so a point halfway
   * down a block projects onto the street it is actually in.
   *
   * A sink array rather than a returned one, on `Minimap.mark`'s argument and
   * `CollisionWorld.prismsWithin`'s: this runs on a clock forever, the caller
   * owns one array for the life of the session, and nothing here allocates. The
   * segments handed back are the tiles' own records and must not be mutated --
   * they are live until the tile is evicted, which is exactly the lifetime the
   * caller needs and no longer.
   *
   * Two rejects before any point is touched. The tile's bounds against the disc
   * -- which also skips every tile with no `.names.bin` at all -- and then each
   * run's own bounds, which is what makes a 40 m query over a tile holding 139
   * runs cost four compares apiece for all but a handful. Both are the
   * axis-aligned box's *nearest corner* distance, so a run is never rejected
   * while any part of it is inside.
   */
  namedStreetsNear(
    x: number,
    z: number,
    radius: number,
    out: NamedSegment[],
  ): NamedSegment[] {
    out.length = 0;
    const r2 = radius * radius;
    for (const tile of this.loaded.values()) {
      const streets = tile.streets;
      if (streets === null) continue;
      const b = tile.entry.bounds;
      const tdx = Math.max(b[0] - x, 0, x - b[2]);
      const tdz = Math.max(b[1] - z, 0, z - b[3]);
      if (tdx * tdx + tdz * tdz > r2) continue;
      for (const seg of streets.segments) {
        const dx = Math.max(seg.minX - x, 0, x - seg.maxX);
        const dz = Math.max(seg.minZ - z, 0, z - seg.maxZ);
        if (dx * dx + dz * dz > r2) continue;
        out.push(seg);
      }
    }
    return out;
  }

  /**
   * Every resident tile's water plan within `radius` of a world point.
   *
   * A sink array on `namedStreetsNear`'s argument: this runs on the map's 15 Hz
   * clock forever, the caller owns one array for the life of the session, and
   * nothing here allocates. The soups handed back are the tiles' own arrays and
   * are live until the tile is evicted.
   *
   * The reject is the tile's bounds against the disc, which also skips every
   * tile with no water at all -- 213 of the inner ring's 221 -- so the common
   * case is four compares a tile and nothing else.
   */
  waterPlansNear(x: number, z: number, radius: number, out: Float32Array[]): Float32Array[] {
    out.length = 0;
    const r2 = radius * radius;
    for (const tile of this.loaded.values()) {
      const plan = tile.waterPlan;
      if (plan === null) continue;
      const b = tile.entry.bounds;
      const dx = Math.max(b[0] - x, 0, x - b[2]);
      const dz = Math.max(b[1] - z, 0, z - b[3]);
      if (dx * dx + dz * dz > r2) continue;
      out.push(plan);
    }
    return out;
  }

  /**
   * The street named by the nearest blade to a world point, or null.
   *
   * A read-only lookup over data the streamer is already holding for the
   * legends -- every resident tile's blades, in world metres, with the name the
   * pipeline signed them with. It was written when the blades were the only
   * place in the client that knew what any street was called.
   *
   * **`namedStreetsNear` above supersedes it for anything that wants to name
   * the street a player is standing on**, and this is kept for what it is
   * actually good at: naming the nearest *signed corner*, which is a different
   * question and is the one a kill feed or a rendezvous prompt asks.
   *
   * The nearest blade is a good answer to that and a poor one to the other: a
   * blade stands on a corner and names one of the two streets meeting there, so
   * a point in the middle of a long block gets the name of whichever corner it
   * is closer to, and a point *on* a corner gets one of two equally true
   * answers. The centreline sidecar is the structure that fixes it.
   *
   * `maxDistance` is squared once and compared squared; the walk is linear over
   * the blades of tiles within range, which is a few hundred at most.
   */
  streetNameNear(x: number, z: number, maxDistance = 60): string | null {
    let best: string | null = null;
    let bestD2 = maxDistance * maxDistance;
    for (const tile of this.loaded.values()) {
      if (tile.bladeLabels.length === 0) continue;
      const b = tile.entry.bounds;
      // The same near-edge gate the legend rebuild uses, so a tile whose
      // closest corner is already further than the cap is skipped whole.
      const dx = Math.max(b[0] - x, 0, x - b[2]);
      const dz = Math.max(b[1] - z, 0, z - b[3]);
      if (dx * dx + dz * dz > bestD2) continue;
      for (const site of tile.bladeLabels) {
        const ex = site.x - x;
        const ez = site.z - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = site.name;
        }
      }
    }
    return best;
  }

  /**
   * Hand the streamer the collision world, as a predicate.
   *
   * A setter rather than a constructor argument because the two are built in
   * the opposite order in `main.ts` -- the streamer has to exist before the
   * index is loaded, and the index is what says which tiles to fetch collision
   * for. Nothing breaks in the gap: a bird spawned before this arrives is
   * simply checked later, on the first frame it is close enough to matter.
   */
  setSpawnGuard(guard: SpawnGuard): void {
    this.spawnGuard = guard;
  }

  /**
   * Hand the streamer the collision world, so the two halves of a tile can have
   * one lifetime.
   *
   * **The second half of the invisible-wall fix**, and the one that is not
   * about failure at all. Before this the two were loaded on different radii by
   * different modules and unloaded by only one of them: `main.ts` fetched
   * prisms inside 420 m and never let them go, this class dropped geometry past
   * 1,800 m, and every return trip landed on tiles that had kept one and lost
   * the other. The invariant this establishes, in as many words:
   *
   *     a tile has resident collision only while its geometry is built,
   *     building, or the tile is inside the collision working set.
   *
   * Two things fall out of it and both are here rather than in `main.ts`,
   * because this class is the one that knows the moment a tile's geometry goes
   * and comes back:
   *
   *   - `dispose` drops the prisms with the geometry, but **only** outside
   *     `COLLISION_KEEP_RADIUS_M`. Collision is safety and geometry is not, so
   *     the rule is one-directional and its distance has a 580 m hysteresis
   *     band under it. See `world/tile-lifecycle.ts`, part 2.
   *   - a tile whose prisms *are* resident and whose geometry is not is an
   *     invisible wall this instant, so it is fetched with an extra
   *     concurrency slot and built at the head of the queue rather than behind
   *     whatever arrived first.
   *
   * A setter on `setSpawnGuard`'s terms -- `main.ts` builds the two in the
   * other order -- and null is a working configuration: without one, collision
   * is never evicted and no rebuild is prioritised, which is what this class
   * did before and what a headless tile-loading test wants.
   */
  setCollisionSink(sink: CollisionSink): void {
    this.collisionSink = sink;
  }

  /**
   * Fail this tile's next `n` fetches on purpose, with this status.
   *
   * The dev handle for the half of the lifecycle nobody can reproduce on
   * demand: `sydney.streamer.debugFailTile('5_-1', 503)` makes the next attempt
   * throw a transient error, so the retry, the backoff countdown on the HUD and
   * the tile arriving late can all be watched happening. A 404 demonstrates the
   * other branch -- suppressed for the session, counted, logged once.
   *
   * Only the *fetch* is faulted, before a byte is requested, so nothing is left
   * half-done and no atlas row is held. Cleared when it has fired `times`.
   */
  debugFailTile(key: string, status = 503, times = 1): void {
    this.injectedFaults.set(key, { status, times });
  }

  /**
   * Forget a tile's failures so the next frame asks for it again -- one key, or
   * every key when none is named.
   *
   * The console's counterpart to the suppression: a 404 that nothing can undo
   * is right for a session and wrong for a developer who has just re-run the
   * pipeline into a tab that is still open. It clears the permanent verdict as
   * well as the backoff, which is why it is here and not on the load path.
   */
  retryNow(key?: string): void {
    if (key === undefined) {
      for (const [absent] of this.ledger.permanentEntries()) this.ledger.forget(absent);
      for (const entry of this.index?.tiles ?? []) this.ledger.forget(entry.key);
      return;
    }
    this.ledger.forget(key);
  }

  /**
   * Hand the streamer whoever owns spec 8.3's powerup state.
   *
   * A setter, and for a stronger reason than `setSpawnGuard`'s: the sink
   * outlives every tile it is told about, so it cannot be constructed *from*
   * one, and the streamer must not own it. Without a sink the icons are still
   * built and still spin -- they are simply always present, which is the right
   * behaviour for a world with no game in it and is what makes the tile loader
   * testable on its own.
   */
  /**
   * Where the mushrooms go, on `setPowerupSink`'s terms exactly: the streamer
   * knows which trees a tile has and when it loses them, and knows nothing about
   * what grows under them. See `world/mushrooms.ts`.
   */
  setMushroomSink(sink: MushroomSink): void {
    this.mushroomSink = sink;
  }

  setPowerupSink(sink: PowerupSink): void {
    this.powerupSink = sink;
  }

  /**
   * Hand the streamer the traffic field, on exactly `setPowerupSink`'s terms.
   *
   * The one difference is what residency means. A powerup's *state* survives an
   * eviction because a respawn clock has to keep running; a lane graph has no
   * state at all -- a car's position is a pure function of the tick -- so
   * dropping a tile's routes drops nothing but the geometry, and re-adopting
   * them puts the identical cars back in the identical places. See
   * `game/traffic.ts`.
   */
  setTrafficField(field: TrafficField): void {
    this.traffic = field;
  }

  /**
   * Hand the streamer the pedestrian field, on exactly `setTrafficField`'s terms
   * -- including the one that matters, which is that a footpath carries no state
   * either. A walker's position is a pure function of the tick, so dropping a
   * tile drops nothing but geometry and re-adopting it puts the identical people
   * back on the identical concrete. See `game/pedestrians.ts`.
   */
  setPedestrianField(field: PedestrianField): void {
    this.pedestrians = field;
  }

  /**
   * Hand the streamer whoever draws the near-field car models.
   *
   * On `setPowerupSink`'s terms, with the powerups' own asymmetry inverted: a
   * powerup's state outlives its tile, and a parked car's model claim must
   * emphatically not. The tile owns the matrix buffer the claim reached into, so
   * `dispose` calls `release` and the claim goes with the geometry.
   */
  setParkedCarSink(sink: ParkedCarSink): void {
    this.parkedCars = sink;
  }

  /**
   * And whoever holds them as cars a player can get into. WORKSTREAM S.
   *
   * On `setParkedCarSink`'s terms exactly, minus its one asymmetry: this sink
   * holds no reference into the tile's buffers, so `drop` is bookkeeping rather
   * than a use-after-free guard. It is still called from `dispose`, because a
   * field holding a tile the streamer has thrown away would offer a take at a car
   * that is no longer drawn -- which the *server* would also grant (its residency
   * is far wider), so the car would be real and invisible.
   */
  setStaticCarSink(sink: StaticCarSink): void {
    this.staticCars = sink;
  }

  /**
   * Hand the streamer the far city, so a tile can take its own slabs off screen.
   *
   * This is the entirety of the far layer's visibility rule -- see the header of
   * `world/far.ts`. A slab is the low-detail stand-in for a building this class
   * is going to load the real version of, and the moment it does, the stand-in
   * has to stop drawing or it is a flat unlit box in front of a real facade. The
   * two switch on the same event rather than on two distances, so there is no
   * frame in which both draw and none in which neither does.
   *
   * A setter for `setSpawnGuard`'s reason and one more: the far layer is fetched
   * *after* the index, so tiles may already be resident by the time it arrives.
   * Those are caught up here rather than waited for.
   */
  setFarCity(city: FarCity): void {
    this.farCity = city;
    for (const tile of this.loaded.values()) {
      if (tile.warm) city.setTileResident(tile.entry.key, true);
    }
  }

  /**
   * Install the thing that compiles a tile's shaders before it is drawn.
   *
   * A function rather than the renderer, for the split this file keeps
   * everywhere else: `setCollisionSink` takes two facts about collision rather
   * than a `CollisionWorld`, and this takes "make this group drawable" rather
   * than a `WebGPURenderer`. The streamer never learns what a pipeline is.
   *
   * The contract is one line and the whole feature rests on it: **resolve when
   * every shader the group needs has been compiled.** It may take as long as it
   * likes -- the tile simply is not drawn until then, which is a tile that is
   * still streaming, and the far layer's slab stays up in its place. What it
   * must not do is compile on the main thread, because the entire point is to
   * take that work off the frame the player's own turn would otherwise put it
   * on. See `LoadedTile.warm`.
   *
   * Failure is not fatal and is not reported: a tile that could not be compiled
   * is shown anyway, which is exactly the behaviour this replaced.
   */
  setPrecompiler(precompile: (group: Group) => Promise<void>): void {
    this.precompile = precompile;
  }

  /**
   * Compile one tile, then let it be drawn.
   *
   * Serialised through `warming` rather than fired in parallel, and that is not
   * caution: `compileAsync` walks a scene, builds node graphs and awaits driver
   * promises with a yield to the main thread between each, so eight of them
   * interleaving would be eight scene walks competing for the same frames while
   * the streamer is already spending its build budget. One at a time drains the
   * queue in the order tiles were built, which is nearest-first.
   */
  private warmTile(tile: LoadedTile): void {
    this.warmQueue.push(tile);
    if (this.warming) return;
    this.warming = true;
    void (async () => {
      try {
        while (this.warmQueue.length > 0) {
          const next = this.warmQueue.shift() as LoadedTile;
          // Evicted while it was waiting. Its group has been emptied and its
          // geometry released, so compiling it would be work for nothing at
          // best and a walk over disposed buffers at worst.
          if (this.loaded.get(next.entry.key) !== next) continue;
          try {
            /*
             * **Both shadow roles, because the flags decide the pipeline.**
             *
             * A tile is built casting and *not* receiving -- `buildTile` says so
             * and gives the good reason: a tile that streams in at 1.5 km should
             * never compile a receiving variant it will never draw.
             * `applyShadowRole` then switches receiving **on** the first frame it
             * is close enough to be in the sun's reach.
             *
             * So this compiled the role a tile *arrives* in, and the other one --
             * the role every tile near the player ends up in -- was compiled
             * inside the frame it flipped on. `LoadedTile.warm`'s own note says
             * the freeze on turning was the frame a tile enters the view; the
             * instanced-uuid half of that was fixed here and this half was not,
             * so turning still paid for whatever crossed the shadow range.
             *
             * The arriving role first, so the tile is drawable as early as
             * possible, then the other, then put back. Both are off the frame --
             * this is already a queue that awaits -- and `warm` is still set only
             * after both have landed, so nothing is drawn in a role nothing has
             * compiled.
             */
            await this.precompile?.(next.group);
            const flipped: Mesh[] = [];
            for (const child of next.group.children) {
              const mesh = child as Mesh;
              if (!mesh.isMesh) continue;
              if (mesh.userData.noShadow === true) continue;
              mesh.receiveShadow = !mesh.receiveShadow;
              flipped.push(mesh);
            }
            if (flipped.length > 0) {
              await this.precompile?.(next.group);
              for (const mesh of flipped) mesh.receiveShadow = !mesh.receiveShadow;
            }
          } catch {
            // A tile that would not compile is a tile that hitches once, which
            // is what every tile did before this existed.
          }
          if (this.loaded.get(next.entry.key) !== next) continue;
          next.warm = true;
          // Paired with the moment the tile becomes drawable, for the reason
          // `buildTile` gives: the slab and the facade must never both draw and
          // must never both be missing.
          this.farCity?.setTileResident(next.entry.key, true);
        }
      } finally {
        this.warming = false;
      }
    })();
  }

  /**
   * Every pipeline a streamed tile will ever need, as a list of stand-ins.
   *
   * Here rather than in `warmup.ts` because this class is the one that owns the
   * materials, and the whole point of the exercise is that the warm-up compiles
   * **the shared instances** rather than lookalikes -- a copy of a material has
   * a different cache key and would warm a pipeline nothing ever draws. Building
   * the list anywhere else would mean either exposing thirteen asset objects or
   * duplicating the twenty-slot construction in the constructor above, and the
   * second of those is the bug that this whole pass exists to avoid.
   *
   * The shadow flags mirror `applyShadowRole` exactly, including its three
   * exceptions -- ground surfaces never cast, and anything carrying
   * `userData.noShadow` (the wires, the lit lamps, spec 8.3's icons) neither
   * casts nor receives. A flag combination warmed here that the streamer never
   * produces is a wasted compile; one it produces and this omits is a hitch left
   * in the game, which is the failure that matters.
   */
  warmupParts(): WarmupPart[] {
    const parts: WarmupPart[] = [];

    // The twenty slots. Geometry is synthesised rather than borrowed because
    // there is none until a tile lands, and `slotAttributes` is what makes that
    // safe: the pipeline cache key reads attribute names and item sizes, so a
    // stand-in with the wrong layout warms the wrong pipeline. See `tiles.py`,
    // which is where those layouts are decided.
    for (const [slot, material] of this.materials) {
      parts.push({
        geometry: warmupGeometry(slotAttributes(slot)),
        owned: true,
        material,
        // `applyShadowRole`: a surface is never a caster. It is still a
        // receiver, and the road under a terrace is most of what the shadows in
        // this game are for.
        casts: !isSurfaceMaterial(slot),
      });
    }

    /*
     * The terrain mesh, which wears the same material as the far ground and is
     * the only other thing `buildTerrainMesh` produces.
     *
     * **Both shadow roles, and this was `[true]`.** A ground sheet arrives
     * receiving and `applyGroundShadowRole` switches it off the first frame it
     * is out of the sun's reach -- and three keys the render pipeline on
     * `receiveShadow`, so the *off* variant was a pipeline nothing had ever
     * compiled. Every sheet crossing that threshold compiled one inside the
     * frame it crossed on, which is a stall felt while walking and while the
     * resident ring turns over around a player who is only looking about.
     *
     * The hysteresis in `applyGroundShadowRole` stops a sheet flapping across
     * the line; it does nothing about the *first* crossing, and the first
     * crossing is the one that pays.
     *
     * Two pipelines at boot, behind the curtain, against one stall per sheet for
     * the life of the session.
     */
    parts.push({
      geometry: warmupGeometry({ normal: true, uv: true }),
      owned: true,
      material: this.groundMaterial,
      casts: false,
      receives: [true, false],
    });

    // The water, which wears the same material as the far sheet. Warmed with a
    // stand-in carrying its own `waterDepth` attribute rather than the terrain's
    // uv, because the pipeline cache key reads attribute names and item sizes --
    // a stand-in with the wrong layout warms a pipeline nothing ever draws, and
    // the hitch stays in the game.
    //
    // Never casts, and **both** receive variants, which is the default: a sheet
    // arrives receiving and `applyShadowRole` switches it off when its tile
    // leaves the shadow volume, so a player walking away from the harbour would
    // otherwise trip a compile at the exact moment they turn around.
    parts.push({
      geometry: warmupGeometry({ normal: true, waterDepth: true }),
      owned: true,
      material: this.waterMaterial,
      casts: false,
    });

    // The wires are merged per tile rather than instanced, carry position and
    // nothing else, and are unlit and out of the depth pass entirely.
    parts.push({
      geometry: warmupGeometry({}),
      owned: true,
      material: this.powerAssets.wireMaterial,
      casts: false,
      receives: [false],
    });
    // One street-name legend, which is enough for all of them: every legend is
    // its own material and its own canvas texture, but they generate identical
    // WGSL, so the shader module and the pipeline are shared and only the
    // binding differs. The cache evicts this on its own clock like any other.
    const legend = this.furnitureAssets.labels.acquire('Warm Up', 0);
    if (legend) {
      parts.push({
        geometry: this.furnitureAssets.bladeLabel,
        material: legend,
        casts: false,
        receives: [false],
      });
    }

    // And **nothing instanced**, which is the change this list most needs
    // explaining.
    //
    // It used to carry a stand-in for every instanced population a tile holds --
    // the trees, the parked cars, the poles, the street lamps, the bins, the
    // blades, the signal lamps, the ibises, the powerup icons -- and not one of
    // them ever warmed a pipeline the game drew. Three keys an instanced draw's
    // node-builder state on `object.uuid` (`RenderObject.getMaterialCacheKey`,
    // unconditionally, with a TODO pointing at three.js#29066), so a stand-in
    // with a different uuid produces different WGSL and a different pipeline.
    // Measured: with all of those entries present, a 360-degree turn on the spot
    // over 56 resident tiles still compiled 589 pipelines and put a 1,492 ms
    // frame in the middle of it.
    //
    // What covers them instead is `setPrecompiler`, which compiles each tile's
    // **real** meshes when the tile is built and holds the tile out of the
    // picture until that lands. See `LoadedTile.warm` and `world/warmup.ts`.

    return parts;
  }

  /**
   * The world's manifest, and the two shapes it comes in.
   *
   * **`root.json` first.** On a segmented world it is 8.6 kB against
   * `index.json`'s 851 kB, and it is fetched uncached every session because it
   * is the version pivot -- so the 842 kB it does not carry is 842 kB nobody
   * pays for again. What it leaves out is the two lists that grow linearly with
   * the map: the tile entries and the region entries, which arrive per hex as
   * the player approaches. See `world/hexes.ts`.
   *
   * **`index.json` when there is no root**, which is every world built before
   * this pass and what `?nohex` produces. The tile list is complete on arrival
   * and nothing below this line behaves differently -- that is the same promise
   * `armCdn` and `armRegions` make, and it is what lets a world sit on a CDN
   * across a client deploy.
   *
   * `focus` is where the player is about to be. The hexes in range of it are
   * **awaited**, and they are the only hexes this client ever waits for: the
   * spawn search in `game/spawn.ts` reads `index.tiles` looking for buildable
   * ground, and an empty tile list is a world with nowhere to stand in it.
   */
  async loadIndex(focus: { x: number; z: number } = { x: 0, z: 0 }): Promise<WorldIndex> {
    let segmented: WorldIndex | null = null;
    try {
      // No `?v=` suffix, on `world/version.ts`'s rule: this is the file that
      // names the version, so caching it behind one would be using the answer
      // to find the question. `caddy/world-cache.Caddyfile` says so for both
      // pivots explicitly rather than by omission.
      const rootResp = await fetch(`${this.baseUrl}/root.json`);
      if (rootResp.ok) {
        const parsed = (await rootResp.json()) as WorldIndex;
        // A root index this client cannot use is not a root index. It carries
        // no tile list, so booting from one and then failing to arm -- a
        // half-written publish, a contract from a future pipeline, `?nohex` --
        // would give a world with no tiles in it and no way to get any. Asked
        // before committing rather than discovered afterwards, which is what
        // makes `?nohex` mean "the pre-segmentation client" rather than "an
        // empty world". See `hexes.hexesUsable`.
        if (hexesUsable(parsed)) {
          parsed.tiles = [];
          segmented = parsed;
        }
      }
    } catch {
      // Offline, a 404, a proxy that rewrote it. All of them mean "this world
      // is not segmented", which is a world that still loads.
      segmented = null;
    }

    if (segmented === null) {
      const resp = await fetch(`${this.baseUrl}/index.json`);
      if (!resp.ok) {
        throw new Error(
          `No world index at ${this.baseUrl}/index.json (${resp.status}). ` +
            `Run the pipeline first: cd pipeline && uv run python -m sydney build --stage inner`,
        );
      }
      this.index = (await resp.json()) as WorldIndex;
    } else {
      this.index = segmented;
    }
    // Before anything else is fetched, because everything else is fetched
    // *with* it. The index itself deliberately carries no suffix -- it is what
    // names the version, so it cannot be cached behind one.
    this.version = worldVersionSuffix(this.index);
    // And where those assets come from, decided in the same breath and for the
    // same reason: the index names both the version and, via its `cdn` block,
    // the immutable tree that holds that version. Arming here means every world
    // fetch after this line sees a decided CDN -- see `world/cdn.ts`.
    armCdn(this.index);
    // And *how* they are packaged, in the same breath and on the same terms: a
    // region bundle is a world asset like any other, so it needs the version and
    // the base URL, and arming it here means the first tile of the session
    // already costs one request for its whole square kilometre rather than
    // twelve for itself. An index with no `regions` block leaves this off and
    // the world loads exactly as it did before -- see `world/regions.ts`.
    armRegions(this.index, this.baseUrl, this.version);
    // And *which part* of it exists yet, last of the three, because a manifest
    // that lands hands its region entries to the module armed on the line above
    // and its tile entries to the array below. A world with no `hexes` block
    // leaves this off and `index.tiles` is already the whole world -- see
    // `world/hexes.ts`.
    armHexes(this.index, this.baseUrl, this.version);
    if (hexesArmed()) {
      const index = this.index;
      onHexTiles((manifest) => {
        index.tiles.push(...(manifest.tiles as unknown as TileEntry[]));
        addRegions(manifest.regions);
        // WORKSTREAM AJ: and the ground gate's cached ring, which is a linear
        // pass over an array that just grew and is therefore stale.
        this.noteIndexGrew();
      });
      await ensureHexesNear(focus.x, focus.z);
    }
    this.terrainField = new TerrainField(
      this.terrain.grid,
      this.index.tile_size,
      this.baseUrl,
      this.version,
    );
    return this.index;
  }

  /**
   * The query suffix world assets are fetched with, for the two things outside
   * this class that fetch one: the collision payloads in `main.ts` and the
   * suburb table in `game/locator.ts`. Empty until `loadIndex` has run.
   */
  get assetVersion(): string {
    return this.version;
  }

  get worldIndex(): WorldIndex | null {
    return this.index;
  }

  /** The ground contract, defaulted for an index written before terrain existed. */
  /** The tile pitch in metres, or 0 before the index lands. For the seam lattice. */
  get tileSize(): number {
    return this.index?.tile_size ?? 0;
  }

  get terrain(): TerrainContract {
    return this.index?.terrain ?? TERRAIN_DEFAULTS;
  }

  /**
   * The height field, for anything outside the streamer that needs to know
   * where the ground is -- which is the player, on a different radius and a
   * different lifetime. Null until `loadIndex` has run.
   */
  get ground(): TerrainField | null {
    return this.terrainField;
  }

  /**
   * Hand the streamer the rail corridor, so the ground stops being drawn across
   * the top of it. See `world/rail-cut.ts` for the whole argument.
   *
   * **Late is allowed, and this is the half of that which is not obvious.** The
   * bake is fetched at boot and in practice lands long before the first tile is
   * built, but "in practice" is how a tile ends up with an uncarved sheet over
   * the Bankstown line for the rest of the session -- a tile is built once, and
   * nothing would ever come back for it. So a corridor arriving after tiles are
   * already standing rebuilds their ground, and only their ground: the terrain
   * mesh is the one child of a tile group that this changes, everything else in
   * the tile was draped by the pipeline and is untouched.
   */
  /**
   * Who to tell about a tile's carriageways as they arrive and as they leave.
   *
   * Deliberately structural and not a type this file imports: what consumes it
   * is `world/road-deck.RoadDeck`, which `server/world.ts` builds too, and the
   * streamer is a browser object.
   *
   * **Both halves, and the second one is not symmetry for its own sake.** A
   * deck that was adopted and never dropped is a lid over the railway at a place
   * the player left an hour ago, and -- worse -- it is a lid the *server* does
   * not have, because the server's lane layer drops a hexagon when it goes out
   * of range. Two authorities disagreeing about where the ground is, which is
   * the whole class of bug this pairing exists to close.
   */
  private roadSink: RoadSink | null = null;

  setRoadSink(sink: RoadSink | null): void {
    this.roadSink = sink;
  }

  /**
   * The clearance envelope, so a building can be drawn with the tunnel its
   * collision already has.
   *
   * **This is not a collision question and the distinction is the whole reason
   * it is allowed here.** This file's own rule -- *"the streamer must not be
   * able to ask a collision question"* -- exists because collision and geometry
   * are loaded on different radii by different modules, so a build that consults
   * one produces a picture that depends on the other's lifecycle. The envelope
   * is not that: it is built once from the rail bake before the first tile is
   * fetched, it never changes for the life of the session, and it says where the
   * *railway* is rather than what is solid. Asking it during a build is the same
   * kind of question `setRailCut` already answers for the ground.
   *
   * Null is a working configuration and is exactly the build that shipped last
   * round: every building drawn whole, and a tunnel through some of them that
   * only the collision knows about. See `world/undercroft.ts`.
   */
  private undercroft: UndercroftEnvelope | null = null;
  readonly undercroftTally: UndercroftTally = emptyUndercroftTally();
  /** Lane sidecars the decoder refused this session. See the null branch at the decode. */
  lanesRefused = 0;

  setUndercroftEnvelope(env: UndercroftEnvelope | null): void {
    this.undercroft = env;
  }

  setRailCut(cut: RailCut | null): void {
    this.railCut = cut;
    if (cut === null) return;
    const recut = this.recutGround(null);
    if (recut > 0) console.debug(`[terrain] re-cut ${recut} resident tiles for the railway`);
  }

  /**
   * The rim the ground must be triangulated to. Phase 2a of `STATIONS.md`.
   *
   * Null unless `?vessels=1`, and null is the world that shipped. Where it is
   * set, it **replaces** the carve inside the corridor rather than adding to it
   * -- see `terrain.TileSeam`: two rules for where the ground stops is the
   * defect this is here to end, not the belt and braces.
   *
   * Re-cuts on the way in exactly as `setRailCut` does, and for the same reason:
   * a corridor that arrives after a tile is a tile drawing ground across a
   * railway until something asks it not to.
   */
  setSeam(seam: SeamField | null, box: readonly [number, number, number, number] | null = null): void {
    this.seam = seam;
    // Bounded to the corridor's own plan box where the caller knows it, on
    // `recutGround`'s own argument: a seam that covers 900 m of railway cannot
    // change the ground of a tile ten kilometres away, and rebuilding every
    // resident tile's mesh to find that out is the expensive half of a cheap
    // operation. `main.ts` refreshes this every time a terrain grid lands.
    const recut = this.recutGround(box);
    if (recut > 0) console.debug(`[terrain] re-cut ${recut} resident tiles for the vessel rim`);
  }

  /**
   * Rebuild the ground of resident tiles whose carve may have changed.
   *
   * `box` is a plan bounding box to limit the sweep to, or `null` for every
   * resident sheet. Only the ground is ever replaced -- everything else in a
   * tile was draped by the pipeline and is untouched.
   *
   * **WORKSTREAM AJ: it sweeps the ground layer now rather than the loaded
   * tiles**, and that is not a rename. A sheet is built when its 1,156-byte grid
   * lands, which is well before its tile's geometry does and sometimes instead
   * of it -- so the old sweep over `loaded` would have missed exactly the sheets
   * that are standing there uncarved while their bundle is still in flight. It
   * also picks up the one new window this pass opens: a sheet built before its
   * own `.lanes.bin` has been adopted does not know where the carriageways are,
   * so the corridor takes ground a road should have kept. `buildTile`'s commit
   * already calls this with the tile's road box for the *neighbours*' sake, and
   * that same call now corrects the tile itself.
   *
   * **Bounded, and that is the difference between this and the road half of
   * `world/envelope.ts`.** `server/world.ts` records at length why the roads were
   * never fed to the clearance envelope: a corridor arriving late means
   * re-offering every prism already resident near it, which took the whole-disc
   * load from 34 s to over ten minutes. Nothing of that applies here. A tile's
   * ways are clipped to its own tile, so a late road can only change the ground
   * of that tile and the eight around it; a terrain mesh is 512 triangles built
   * from a grid already in memory; and the swap is refused outright unless the
   * fresh mesh actually differs. The expensive thing was re-carving *solids*, and
   * no solid is touched here.
   */
  private recutGround(box: readonly [number, number, number, number] | null): number {
    if (this.railCut === null || this.groundSheets.size === 0) return 0;
    const tileSize = this.index?.tile_size ?? 0;
    if (tileSize <= 0 || this.terrainField === null) return 0;
    let recut = 0;
    for (const sheet of this.groundSheets.values()) {
      const b = sheet.entry.bounds;
      if (box !== null && (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3])) {
        continue;
      }
      const grid = this.terrainField.grid(sheet.entry.key);
      if (!grid) continue;
      const old = sheet.mesh;
      const fresh = buildTerrainMesh(
        grid,
        this.terrain.grid,
        tileSize,
        this.groundMaterial,
        this.tileCut(sheet.entry),
        this.tileSeam(sheet.entry),
      );
      const cutArea = fresh.userData.cutArea as number;
      const deckArea = fresh.userData.deckArea as number;
      const seamTriangles = fresh.userData.seamTriangles as number;
      // Nothing to swap for: either the corridor neither took ground from this
      // tile nor kept any under a road, or the fresh mesh made the identical two
      // decisions the standing one did.
      //
      // **Both areas, not just the carved one.** A tile where a wide street
      // roofs the corridor along its whole length loses no sub-quad at all --
      // `cutArea` is zero and `deckArea` is not -- and testing only the first
      // would refuse to give it the soffit it needs.
      if (
        (cutArea <= 0 && deckArea <= 0 && seamTriangles <= 0) ||
        (cutArea === (old.userData.cutArea as number) &&
          deckArea === (old.userData.deckArea as number) &&
          seamTriangles === ((old.userData.seamTriangles as number) ?? 0))
      ) {
        fresh.geometry.dispose();
        continue;
      }
      this.groundRoot.remove(old);
      old.geometry.dispose();
      sheet.mesh = fresh;
      this.placeSheetMesh(sheet);
      recut++;
    }
    return recut;
  }

  /* --- WORKSTREAM AJ: the ground layer ---------------------------------------
   *
   * A handful of short methods and one budgeted pass. Everything about *when* a
   * sheet is wanted is `pumpGround`; everything about what one is lives here.
   */

  /**
   * The index grew, so any ring computed from it is stale.
   *
   * A hex manifest pushes a square kilometre of tile entries onto `index.tiles`
   * mid-session, and `ringAt`'s whole premise is that a ring can only change
   * when the query point moves. It can also change when the *world* does, which
   * is this, and the correction is simply to drop the cache: the next query does
   * one pass and is right again.
   */
  private noteIndexGrew(): void {
    this.ringCache.clear();
  }

  /**
   * Put a freshly built mesh into a sheet's place in the world.
   *
   * One function for the two callers -- a sheet arriving and a sheet re-cut --
   * because the three things that must be done to every terrain mesh in this
   * layer are the three that were previously done to it by *being inside a tile
   * group*, and a rule written twice is a rule that ends up applied once.
   *
   *   - **The world offset**, which the tile group used to carry. The geometry is
   *     tile-local by design: it is what keeps float32 vertex precision constant
   *     across a 60 km extent, and it is why every other payload can inherit one
   *     translation instead of baking sixty thousand metres into every vertex.
   *   - **Frustum culling per mesh**, where a tile's children were culled per
   *     group. `buildTerrainMesh` sets `frustumCulled = false` and says why in a
   *     trailing comment -- "culled with its tile" -- which stops being true
   *     here. One sheet is one box test against whichever camera is rendering,
   *     which is *better* than the group test it replaces: the tile group's
   *     visibility is a hand-rolled union of the view frustum and the shadow
   *     volume, and three does that correctly per pass on its own.
   *   - **The shadow role**, carried over from whatever the sheet already held so
   *     a re-cut in the middle of a walk does not flip the pipeline.
   */
  private placeSheetMesh(sheet: GroundSheet): void {
    const tileSize = this.index?.tile_size ?? 0;
    const [minX, minZ] = sheet.entry.bounds;
    sheet.mesh.position.set(minX, 0, minZ + tileSize);
    sheet.mesh.frustumCulled = true;
    sheet.mesh.receiveShadow = sheet.receives;
    this.groundRoot.add(sheet.mesh);
  }

  /**
   * Build one tile's ground, if it is not built and the grid is in hand.
   *
   * Idempotent and cheap to call speculatively, which is what lets the commit
   * step call it as a last resort: **no tile group may enter the scene without
   * its ground already in it.** That is the invariant this whole workstream is
   * about, and making it a line of code in the one place a tile becomes visible
   * is worth more than any amount of ordering discipline elsewhere -- a future
   * pass that reorders the ground pass, or a caller that drives `loadTile`
   * directly with no `update` behind it, cannot get it wrong.
   *
   * Returns whether the tile's ground is now settled, which includes the tile
   * whose `.terr.bin` the build does not contain: nothing can ever be drawn
   * there and nothing should ever wait for it. See `groundSettled`.
   */
  private ensureGroundSheet(entry: TileEntry, grid: Float32Array | null = null): boolean {
    if (this.groundSheets.has(entry.key)) return true;
    const field = this.terrainField;
    const tileSize = this.index?.tile_size ?? 0;
    if (field === null || tileSize <= 0) return false;
    const heights = grid ?? field.grid(entry.key) ?? null;
    if (heights === null) {
      // Not a failure to record and not a thing to retry: `TerrainField` owns
      // both of those decisions and has already made them. All this reads is
      // the one it made permanently.
      if (field.absent(entry.key)) {
        this.groundSettled.add(entry.key);
        return true;
      }
      return false;
    }
    const sheet: GroundSheet = {
      entry,
      mesh: buildTerrainMesh(
        heights,
        this.terrain.grid,
        tileSize,
        this.groundMaterial,
        this.tileCut(entry),
        this.tileSeam(entry),
      ),
      // Arrives receiving, exactly as it did as a tile child -- `buildTerrainMesh`
      // sets the flag and the boot warm-up compiles that variant and only that
      // variant. `applyGroundShadowRole` switches it off on the first frame the
      // sheet is out of the sun's reach.
      receives: true,
    };
    this.placeSheetMesh(sheet);
    this.groundSheets.set(entry.key, sheet);
    this.groundSettled.add(entry.key);
    this.builtSheets++;
    return true;
  }

  /**
   * Take one tile's ground out of the world.
   *
   * On the same eviction as the tile it belongs to, and not on a longer lease,
   * even though a sheet is only about 20 kB of buffers and the grid it was built
   * from is kept forever anyway. The reason is the picture rather than the
   * memory: ground drawn a kilometre past where the buildings stop is a green
   * field with a city edge in the middle of it, which is a worse frame than the
   * far sheet the eviction hands back to.
   */
  private dropGroundSheet(key: string): void {
    const sheet = this.groundSheets.get(key);
    if (sheet === undefined) return;
    this.groundRoot.remove(sheet.mesh);
    sheet.mesh.geometry.dispose();
    this.groundSheets.delete(key);
    this.groundSettled.delete(key);
  }

  /**
   * `applyShadowRole` for a sheet, which is the same rule with one branch of it.
   *
   * Ground never casts at any distance -- its only contribution to the depth map
   * would be the ground itself, and every fragment it wrote there is a fragment
   * the buildings have to fight for -- so only the receiving half is left. The
   * hysteresis and the range are the tiles' own, deliberately: a sheet and the
   * tile standing on it flipping on different frames would be a block of city
   * whose shadows and whose ground disagree for as long as the gap lasts.
   */
  private applyGroundShadowRole(sheet: GroundSheet, dist: number): void {
    const receives = dist <= this.receiveRange + (sheet.receives ? SHADOW_HYSTERESIS : 0);
    if (receives === sheet.receives) return;
    sheet.receives = receives;
    sheet.mesh.receiveShadow = receives;
  }

  /**
   * The ring, cached. See `ringCache` for why this is not simply a call through
   * to `groundRing`.
   */
  private ringAt(x: number, z: number, radiusM: number): string[] {
    const cached = this.ringCache.get(radiusM);
    if (
      cached !== undefined &&
      Math.abs(cached.x - x) < RING_CACHE_STEP_M &&
      Math.abs(cached.z - z) < RING_CACHE_STEP_M
    ) {
      return cached.ring;
    }
    const ring = this.index === null ? [] : groundRing(this.index.tiles, x, z, radiusM);
    this.ringCache.set(radiusM, { x, z, ring });
    return ring;
  }

  /**
   * How much of the ground around a point is settled.
   *
   * The one query the loading screen's progress line, the boot's reveal gate and
   * the streamer's own fetch priority all read, so what the player is told and
   * what the curtain waits for cannot drift apart. Public because the gate lives
   * in `main.ts`; see `world/ground-first.ts` for the arithmetic and for the
   * radius.
   */
  groundCoverage(x: number, z: number, radiusM: number = GROUND_REVEAL_RADIUS_M): GroundCoverage {
    return groundRingCoverage(this.ringAt(x, z, radiusM), this.groundSettled);
  }

  /** Frames this streamer has been driven through. See `framesSeen`. */
  get frames(): number {
    return this.framesSeen;
  }

  /** Whether every tile whose ground a player at (x, z) could see nearby is built. */
  groundReady(x: number, z: number, radiusM: number = GROUND_REVEAL_RADIUS_M): boolean {
    return this.groundCoverage(x, z, radiusM).ready;
  }

  /**
   * Phase 0: the ground of every wanted tile, ahead of the geometry of any tile.
   *
   * Handed `update`'s own nearest-first ranking rather than computing a ring of
   * its own, which is not merely thrift: that array *is* the set of tiles the
   * streamer is willing to fetch and the order it is willing to fetch them in,
   * so a ground pass built from anything else would be answering about a
   * different world than the one below it.
   *
   * Two halves. The first asks for the ground of the nearest unsettled tiles --
   * **the nearest `GROUND_FETCH_AHEAD` of them and no more**, which is the one
   * thing here that is not obvious and is the difference between a nearest-first
   * order and a nearest-first *intention*. Firing all 57 at once hands the
   * ordering to the transport, and a headless drive over a real origin caught
   * exactly that: the eleven-tile reveal ring finishing after the first tile's
   * geometry had already landed. See the constant.
   *
   * The window slides on its own. `wanted` is sorted, everything nearer is
   * already settled once the boot is over, so in steady state the sixteen slots
   * sit precisely on the streaming frontier.
   *
   * The second half builds whatever has landed, nearest first, under
   * `GROUND_BUDGET_MS`. Building is not rationed by the window -- a grid in hand
   * costs 0.13 ms to turn into a sheet whether it is under the player or a
   * kilometre away, and refusing to spend it would leave ground undrawn for no
   * saving.
   *
   * Nothing is returned. The ordering this buys is enforced one tile at a time
   * in the fetch pass below -- see the `groundSettled` test there -- rather than
   * by a global flag, because a global flag is the shape of thing that wedges.
   */
  private pumpGround(wanted: ReadonlyArray<{ entry: TileEntry; dist: number }>): void {
    const field = this.terrainField;
    if (field === null || this.index === null) return;

    // Tapered on the same terms as `pumpBuilds`, and from the same measurement:
    // a frame that is already long should not also pay for ground sheets. The
    // floor keeps a struggling client building ground rather than standing on
    // nothing. See `world/buildbudget.ts`.
    const groundNow = performance.now();
    const deadline = groundNow + buildBudgetFor(GROUND_BUDGET_MS, this.lastPumpAt > 0 ? groundNow - this.lastPumpAt : 0);
    let budgetLeft = true;
    let waitingOn = 0;
    for (const { entry } of wanted) {
      if (this.groundSettled.has(entry.key)) continue;
      if (budgetLeft) {
        // The grid may have landed since the last frame, in which case this is
        // the sheet and the tile is settled before a request is considered.
        if (this.ensureGroundSheet(entry)) continue;
        budgetLeft = performance.now() < deadline;
      } else if (field.grid(entry.key) !== undefined) {
        // Grid in hand and only the build budget between it and a sheet. Not a
        // fetch, so it must not take one of the window's slots -- a return trip
        // finds every grid already held (the field never evicts) and would
        // otherwise fill the window with tiles that need no network at all.
        continue;
      }
      // Genuinely without ground: in flight, in a retry backoff, or about to be
      // asked for. Free when the request already exists; `TerrainField.ensure`
      // de-duplicates in flight and remembers forever, so this is a map lookup
      // on every frame after the first.
      void field.ensure(entry.key);
      if (++waitingOn >= GROUND_FETCH_AHEAD) return;
    }
  }

  /**
   * The corridor as one tile sees it: the same `RailCut`, plus where this tile's
   * local frame sits in the world. Null when there is no bake, which is a world
   * with an uncut ground and is exactly the world that shipped.
   */
  /** This tile's view of the rim, or null with no seam. See `setSeam`. */
  private tileSeam(entry: TileEntry): TileSeam | null {
    if (this.seam === null || this.index === null) return null;
    return {
      originX: entry.bounds[0],
      originZ: entry.bounds[1] + this.index.tile_size,
      field: this.seam,
    };
  }

  private tileCut(entry: TileEntry): TileCut | null {
    const cut = this.railCut;
    if (cut === null || this.index === null) return null;
    const tileSize = this.index.tile_size;
    return {
      originX: entry.bounds[0],
      originZ: entry.bounds[1] + tileSize,
      near: (x, z, pad) => cut.near(x, z, pad),
      cutAt: (x, z, groundY) => cut.cutAt(x, z, groundY),
      deckedAt: (x, z, groundY) => cut.deckedAt(x, z, groundY),
    };
  }

  /**
   * Which phase of the pipeline this tile's **geometry** is in.
   *
   * The one question `stats` cannot answer, because `stats` is aggregate and
   * this is per tile. It exists for `world/invisible-walls.ts`, whose whole
   * subject is the window between a tile's collision arriving and its geometry
   * being built: collision is fetched by `main.ts` on a 420 m radius as an 9 kB
   * `.bin`, and the geometry is a 1.6 MB GLB through the fetch, the worker
   * decode and the budgeted build queue. Inside that window every prism in the
   * tile stops the player and draws nothing, and there is no other way to see
   * it -- a hole in the city looks exactly like a park.
   *
   * **`'failed'` no longer means what it did, and the change is the point of
   * this pass.** It used to mean "threw once, and is therefore gone for the
   * session" -- `update` never retried it, so its collision was an invisible
   * wall permanently rather than for a second and a half. It now means
   * *retrying, next attempt in `retryInMs`* : a transient failure on a widening
   * backoff, which clears itself. The vocabulary is deliberately unchanged for
   * that case so no reader of this method has to be taught a new word for a
   * state that got better rather than different.
   *
   * `'missing'` is the new one, and it is the state that really is permanent: a
   * 404 or 410, meaning the pipeline did not emit this tile. Nothing will fix
   * it in this session and a reader should say so rather than promise a wait.
   * A tile in this state with collision resident is a **build defect** and is
   * worth showing as one -- see `world/invisible-walls.ts`.
   *
   * A pure read of five containers, allocating nothing -- it is called per map
   * redraw for a few dozen tiles.
   */
  tilePhase(key: string): 'built' | 'building' | 'loading' | 'failed' | 'missing' | 'absent' {
    if (this.loaded.has(key)) return 'built';
    if (this.building.has(key)) return 'building';
    if (this.loading.has(key)) return 'loading';
    if (this.ledger.isPermanent(key)) return 'missing';
    if (this.ledger.isRetrying(key)) return 'failed';
    return 'absent';
  }

  /**
   * How long until this tile is asked for again, seconds, or 0 if it may be now.
   *
   * The other half of what `'failed'` now means. A hazard readout that says
   * "failed" and nothing else is the old, hopeless message; one that says
   * "retrying in 12 s" is a wait with an end on it.
   */
  retryInSeconds(key: string): number {
    return this.ledger.nextRetryInMs(key, Date.now()) / 1000;
  }

  /**
   * What has failed, how, and what the parity rule has done about it -- for the
   * console and the HUD.
   *
   * `holds` is the one to watch and the one that should never move: see
   * `parityHolds`.
   */
  get lifecycleReport(): {
    retrying: number;
    missing: number;
    nextRetryS: number;
    collisionEvicted: number;
    holds: number;
    priorityBuilds: number;
    /** Fetches asked to stand down so the player's own tile could take the link. */
    cancelled: number;
    absent: Array<[string, string]>;
  } {
    const soonest = this.ledger.soonestRetryInMs(Date.now());
    return {
      retrying: this.ledger.retryingCount,
      missing: this.ledger.permanentCount,
      /** Seconds to the soonest retry, or `Infinity` when nothing is waiting. */
      nextRetryS: soonest === Infinity ? Infinity : soonest / 1000,
      collisionEvicted: this.collisionEvictions,
      holds: this.parityHolds,
      priorityBuilds: this.priorityBuilds,
      cancelled: this.cancelledLoads,
      absent: this.ledger.permanentEntries(),
    };
  }

  /**
   * Tiles built and ground sheets placed since boot, monotonic.
   *
   * Exposed for `game/stallring.ts`, which records the *delta* on a stalled
   * frame. `world/boundarylog.ts` explains why the streamer answers this rather
   * than the boundary log re-deriving it: whether a tile crossed 420 m of the
   * camera this frame is a fact this class already holds, and two answers to one
   * question is the failure mode every header in this file warns about.
   */
  get built(): { tiles: number; sheets: number } {
    return { tiles: this.builtTiles, sheets: this.builtSheets };
  }

  get stats() {
    let triangles = 0;
    let buildings = 0;
    let trees = 0;
    let water = 0;
    let cars = 0;
    let poles = 0;
    let spans = 0;
    let furniture = 0;
    let powerups = 0;
    let casting = 0;
    let receiving = 0;
    let birds = 0;
    let streetRuns = 0;
    const bands = [0, 0, 0, 0];
    for (const t of this.loaded.values()) {
      if (t.group.visible) {
        triangles += t.entry.t;
        buildings += t.entry.b;
        trees += t.trees;
        // Counted into the triangle total as well as on its own: the water is
        // real geometry in the frame, and a number that reported the buildings
        // and quietly left out a fifth of a harbour tile would be the wrong
        // number to size a frame budget with.
        triangles += t.water;
        water += t.water;
        cars += t.cars;
        poles += t.poles;
        spans += t.spans;
        // One number for all three kinds, unlike the index. What this counter is
        // for is the frame budget, and a bin, a name post and a signal head are
        // all the same size of thing to the renderer -- the split matters to the
        // build report and nowhere else.
        furniture += t.bins + t.posts + t.signals;
        // Icons visible in this frame. Counted as *icons* rather than as draws,
        // even though each is drawn three times: the number a reader wants
        // beside the furniture count is how much of spec 8.3 is on screen, and
        // the x3 is a constant of the technique rather than a thing that varies.
        powerups += t.powerups === null ? 0 : (t.entry.pw ?? 0);
      }
      // Counted resident rather than visible, unlike everything above it: the
      // number that matters for birds is how many are being *simulated*, and
      // that is a distance from the camera rather than a frustum test.
      birds += t.birds?.count ?? 0;
      // And the centreline runs, on exactly that argument taken one step
      // further: they are never visible at all. What this number is for is the
      // readout -- `namedStreetsNear` walks resident tiles, so a zero here with
      // tiles loaded is a readout that can only ever name the suburb.
      streetRuns += t.streets?.segments.length ?? 0;
      bands[t.band]++;
      // Counted only while visible, because an invisible tile is skipped by the
      // depth pass whatever its flags say -- which is precisely the bug these
      // two counters exist to make visible. Zero casters with tiles resident is
      // the signature.
      if (t.casts && t.group.visible) casting++;
      if (t.receives && t.group.visible) receiving++;
    }
    return {
      resident: this.loaded.size,
      loading: this.loading.size,
      /**
       * Fetches asked to stand down so the tile under the player could take the
       * link. On the overlay's stats rather than only the build report, because
       * this is the one number that says the priority pair is doing anything:
       * zero of them across a long drive means the hold-back never fired, which
       * is the whole feature not working. See `world/tilepriority.ts`.
       */
      cancelled: this.cancelledLoads,
      /**
       * WORKSTREAM AJ: ground sheets standing, and how many this session built.
       *
       * The pair says whether the ground is actually leading. `ground` should
       * run ahead of `resident` at all times and by a wide margin while the
       * player is moving into new country -- the two converging, or `resident`
       * overtaking, means the ground pass has stopped winning its race and the
       * first place to look is `GROUND_LEAD_SLOTS`.
       */
      ground: this.groundSheets.size,
      groundBuilt: this.builtSheets,
      /**
       * Tiles decoded and waiting on the frame budget to be built.
       *
       * The one number that says whether `BUILD_BUDGET_MS` is binding. It should
       * be zero or one nearly always -- construction retires far faster than
       * 1.6 MB tiles can be fetched -- and a queue that sits deep for seconds
       * means either the budget is too small for the machine or something in a
       * builder has grown a cost nobody measured.
       */
      building: this.building.size,
      /** Tiles this session has finished building. Monotonic; for the overlay. */
      built: this.builtTiles,
      decoder: this.decoder.stats,
      /**
       * Tiles whose last attempt failed transiently and which are waiting on a
       * backoff. **Not** a death sentence any more -- see `tilePhase`. Kept
       * under the old name because it is the same line on the same overlay and
       * the meaning got better rather than different.
       */
      failed: this.ledger.retryingCount,
      /** Seconds to the soonest of those, or `Infinity` when none is waiting. */
      nextRetryS: (() => {
        const ms = this.ledger.soonestRetryInMs(Date.now());
        return ms === Infinity ? Infinity : ms / 1000;
      })(),
      /**
       * Tiles the build does not contain: a 404 or 410. Permanent for the
       * session, and worth a number of its own rather than being folded into
       * the retries -- a tile in range that the pipeline never emitted is a
       * defect in the build, and one whose collision is resident is an
       * invisible wall that will never draw itself.
       */
      missing: this.ledger.permanentCount,
      /** Tiles whose prisms went out with their geometry. See `dispose`. */
      collisionEvicted: this.collisionEvictions,
      /** Evictions that had to keep collision for safety. Should stay zero. */
      collisionHeld: this.parityHolds,
      triangles,
      buildings,
      trees,
      water,
      cars,
      poles,
      spans,
      furniture,
      powerups,
      birds,
      streetRuns,
      gulls: this.gulls.count,
      bands,
      casting,
      receiving,
      atlasRows: this.atlas.usedRows,
      atlasCapacity: this.atlas.capacity,
    };
  }

  /**
   * Advance the ambient life. Called once a frame from `main.ts`, after
   * `update`, with the *clamped* frame delta.
   *
   * Split out of `update` rather than folded into it because the two answer
   * different questions on different radii: `update` is about which tiles exist
   * at all and runs on the 1,800 m streaming radius, and this is about which
   * birds are close enough to be worth stepping, which is 150 m. Keeping them
   * apart is also what makes this one line easy to time on its own.
   *
   * The per-tile gate is the same `distanceToBounds` the streamer already
   * trusts, so a frame touches the two or three tiles under the player and
   * skips the other sixty without looking at a single bird. Within a tile every
   * bird is tested again against its own distance, because a tile is 500 m
   * across and its near edge being close says nothing about a bird in its far
   * corner.
   *
   * Nothing here integrates a clock of its own. The render loop only runs on
   * `requestAnimationFrame`, so a hidden tab issues no frames and every bird
   * simply stops where it stood; the delta is clamped by the caller so the
   * frame the tab comes *back* advances the world by one step rather than by
   * however long it was away.
   */
  /**
   * Draw or hide every street lamp's glow in every resident tile.
   *
   * Called once a frame with `nightLevel > NIGHT_VISIBLE_LEVEL` and returning on
   * the first line on all but the two frames a day where the answer changes.
   * When it does change it walks the resident tiles once, which is a few dozen
   * groups of a few dozen children.
   *
   * **`visible` on a mesh, which is free, and never on a light, which is not.**
   * `world/nightlights.ts` spends a paragraph on the difference: three's
   * `_projectObject` skips an invisible object, so hiding a *light* takes it off
   * the render list, which changes `LightsNode`'s cache key, which rebuilds and
   * recompiles every pipeline in the scene. Hiding a mesh does nothing but skip
   * a draw.
   *
   * The alternative -- leaving the sprites drawn at zero opacity all day -- was
   * rejected on fill: a lamp's ground pool is 130 square metres of road and
   * there are several hundred resident, and an additive blend at alpha zero
   * still rasterises every one of those fragments.
   */
  setNightLightsVisible(visible: boolean): void {
    if (visible === this.nightLightsVisible) return;
    this.nightLightsVisible = visible;
    // `this.root`, not `this.loaded`, and the difference is a tile in flight. A
    // build adds its group to the root at the start and enters it in `loaded`
    // only when it commits, and the commit is several `yield`s later -- so a
    // tile that was mid-build when the sun went down would have had its lamps
    // created with the old flag and never seen this walk. It would then stay
    // dark until the next dawn *turned it on*, which is the funniest possible
    // version of this bug and was observed as exactly one unlit tile in thirty.
    for (const group of this.root.children) {
      for (const child of group.children) {
        if (child.userData.nightlights === true) child.visible = visible;
      }
    }
  }

  /**
   * The nearest luminaires to a point, for the night rig's four real lights.
   *
   * A linear pass over the lamp arrays of the resident tiles within `radius`,
   * with an insertion sort into a fixed `max`-long result -- which for a
   * `max` of four is faster than any structure that could be kept in sync, and
   * is called six times a second rather than sixty (see `LAMP_REPICK_INTERVAL`).
   * The tile-level test is the same `distanceToBounds` everything else in this
   * class trusts, so a search radius of 44 m touches the two or three tiles
   * under the player and skips the rest without reading a single lamp.
   *
   * Distances are measured in **3D**, not in plan, because the thing being
   * answered is "which lamps can light what I am standing next to" and Sydney is
   * not flat: a lamp on the road 8 m below a player on the Cahill Expressway is
   * not the nearest lamp in any sense that matters.
   */
  nearestLamps(
    x: number,
    y: number,
    z: number,
    radius: number,
    out: Float32Array,
    max: number,
  ): number {
    _lampProbe.set(x, y, z);
    let found = 0;
    // Parallel to `out`, so a candidate can be compared without recomputing.
    const best = _lampDistances;
    max = Math.min(max, best.length);
    for (const tile of this.loaded.values()) {
      if (tile.lamps.length === 0) continue;
      if (distanceToBounds(_lampProbe, tile.entry.bounds) > radius) continue;
      const lamps = tile.lamps;
      for (let i = 0; i < lamps.length; i += LAMP_RECORD_STRIDE) {
        const dx = lamps[i] - x;
        const dy = lamps[i + 1] - y;
        const dz = lamps[i + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > radius * radius) continue;
        if (found === max && d >= best[max - 1]) continue;
        // Insertion into a sorted list of at most `max`. The sort order is what
        // makes the six-hertz re-pick invisible: the light that gets dropped is
        // always the furthest, which is the one already at the edge of
        // `LAMP_DISTANCE` and contributing nothing.
        let slot = Math.min(found, max - 1);
        while (slot > 0 && best[slot - 1] > d) {
          best[slot] = best[slot - 1];
          const from = (slot - 1) * LAMP_RECORD_STRIDE;
          const to = slot * LAMP_RECORD_STRIDE;
          for (let k = 0; k < LAMP_RECORD_STRIDE; k++) out[to + k] = out[from + k];
          slot--;
        }
        best[slot] = d;
        const o = slot * LAMP_RECORD_STRIDE;
        out[o] = lamps[i];
        out[o + 1] = lamps[i + 1];
        out[o + 2] = lamps[i + 2];
        out[o + 3] = lamps[i + 3];
        if (found < max) found++;
      }
    }
    return found;
  }

  updateLife(dt: number, camera: Camera): void {
    const cam = camera.position;

    // The waves, on the same clock as the birds and for the same reason: it is
    // the *frame* delta rather than a wall clock, so a backgrounded tab issues
    // no frames, advances no phase, and comes back to the harbour where it left
    // it instead of to one that has run on for a minute. The clamp the caller
    // has already applied is what stops that frame arriving as a jump.
    //
    // Unclamped by `step` below, unlike the birds: nothing here integrates a
    // position, so a long delta is a phase jump in a sine and not a bird through
    // a wall.
    this.waterClock.value += dt;
    // A second clamp, tighter than the caller's 0.25 s. At 3 m/s a quarter of a
    // second is a 0.75 m step, which is wide enough for a fleeing bird to cross
    // a wall between two collision tests; 0.1 s is 30 cm, which is not.
    const step = Math.min(dt, 0.1);

    for (const tile of this.loaded.values()) {
      const near = distanceToBounds(cam, tile.entry.bounds);
      // Spec 8.3's icons spin, bob and pop, which makes them "life" in this
      // method's sense even though nothing about them is simulated. They get
      // their own radius rather than sharing `LIFE_RADIUS`, because the two
      // numbers answer different questions: 150 m is where an ibis stops being
      // two pixels, and `POWERUP_ANIMATE_RADIUS` is the through-wall range the
      // spec states plus the length of a tile, since a tile's near edge being
      // inside 60 m says nothing about an icon in its far corner.
      const icons = tile.powerups;
      if (icons !== null) {
        // The visibility test runs on every tile with icons and the animation
        // does not, because the two answer different questions: the first is
        // "would these draw anything", which has to be right for a tile that is
        // never animated, and the second is "is anyone close enough to see them
        // move".
        icons.setDepthFreeVisible(near);
        if (near <= POWERUP_ANIMATE_RADIUS) icons.update(tile.powerupStates, step);
      }
      const birds = tile.birds;
      if (birds === null) continue;
      if (near > LIFE_RADIUS) continue;
      birds.update(
        step,
        cam.x - tile.group.position.x,
        cam.y,
        cam.z - tile.group.position.z,
        LIFE_RADIUS,
        this.spawnGuard,
      );
    }

    this.gulls.update(step, cam.x, cam.y, cam.z);

    // The street-name legends, on their own clock inside `BladeLabels` -- it is
    // handed the *unclamped* frame delta, not `step`, because it is counting
    // seconds toward a rebuild rather than integrating motion, and clamping it
    // would make a stuttering frame rate rebuild slower than once a second.
    //
    // The gather runs only on the frames the clock fires, which is why it is a
    // callback: on the other fifty-nine this costs one addition. When it does
    // fire it walks the tiles by the same `distanceToBounds` everything else
    // here trusts, so a rebuild touches the two or three tiles under the player
    // and skips the rest without looking at a single blade.
    this.bladeLabels.update(dt, cam.x, cam.y, cam.z, () => {
      const sites: BladeLabelSite[] = [];
      for (const tile of this.loaded.values()) {
        if (tile.bladeLabels.length === 0) continue;
        if (distanceToBounds(cam, tile.entry.bounds) > BLADE_LABEL_RADIUS) continue;
        for (const site of tile.bladeLabels) sites.push(site);
      }
      return sites;
    });
  }

  /**
   * Called every frame. Cheap by design: a linear pass over the index, which is
   * a few thousand entries even at the 35 km stage and costs well under a
   * millisecond, so there is no spatial structure to keep in sync.
   *
   * `shadowVolume` is the sun's shadow camera frustum, from `SydneySky`. It is
   * not optional in any meaningful sense -- see the visibility test below -- but
   * it is nullable so the streamer stays usable without a sky.
   *
   * `sunAltitudeDeg` is `SydneySky.solar.altitude`, and it is here rather than
   * on a setter of its own because it is read exactly once a frame at exactly
   * this point, immediately after the sky has moved. Defaulted to the reference
   * 3 pm so a caller with no sky gets the geometry this rig was tuned against
   * rather than a shadow range of NaN.
   */
  /**
   * Warm the manifests and bundles for somewhere the player is not yet.
   *
   * The radial prefetch in `update` is a *guess*: it assumes the next 2,200 m
   * are as likely to be in one direction as another, which is true of somebody
   * walking and false of somebody on a train. A rider's next sixty seconds are
   * **known** -- the route is a polyline and the timetable is closed form -- so
   * `main.ts` samples where they will be and hands the point over here, and the
   * hexagons along the line are asked for instead of the disc around the player.
   *
   * Only the two long-lead layers, and deliberately: a hex manifest is the fact
   * that a square kilometre exists at all and a region bundle is its bytes, and
   * both are the things that cannot arrive in time if they are started late.
   * The tiles themselves stay on the radial `loadRadius`, because a tile is
   * 1.6 MB of geometry that is only worth building when it is about to be
   * visible -- and 1,800 m of radius is already 40 s of lead at 44 m/s.
   *
   * Cheap enough to call every frame: both functions are a hex-coordinate
   * conversion and a set membership, and both return immediately when the point
   * has not left the cell it was in last time. `update` calls them once for the
   * camera already.
   */
  prefetchAt(x: number, z: number): void {
    if (!this.index) return;
    updateHexes(x, z);
    updateRegions(x, z);
  }

  update(
    camera: Camera,
    shadowVolume: Frustum | null = null,
    sunAltitudeDeg: number = REFERENCE_ALTITUDE_DEG,
  ): void {
    // WORKSTREAM AJ: before the index test, deliberately. The count is about the
    // *loop*, not about the world, and the boot gate reads it to find out
    // whether frames are happening at all.
    this.framesSeen++;
    if (!this.index) return;

    // Phase 3, before anything else this frame.
    //
    // First rather than last, and the reason is one frame of correctness: a tile
    // finished here is in `loaded` by the time the pass below runs, so it gets
    // its band, its shadow role and a real frustum test on the same frame it
    // enters the scene. Pumping afterwards would leave it drawn for one frame
    // with `Group.visible` at its default and every primitive's
    // `frustumCulled` off, which is the whole tile rasterised whether or not the
    // camera is pointing at it.
    // The camera's own position, so the queue serves the tile the player is
    // standing on rather than the fetch that happened to resolve first. See
    // `nearestQueued`.
    this.pumpBuilds(camera.position.x, camera.position.z);

    // Cheap enough to redo unconditionally -- two trig calls a frame against a
    // linear pass over a few thousand tile entries below it.
    this.receiveRange = sunReceiveRange(this.shadowRadius, sunAltitudeDeg);

    // Wall clock rather than `performance.now`, because the retry schedule is
    // written in seconds a player waits and is read back by a HUD countdown --
    // and because `TileRetryLedger` is handed a `now` by its checks too, which
    // is easier to read against `Date.now` than against a page-load offset.
    // Read once a frame rather than per tile: sixty `Date.now` calls a frame
    // over a few thousand index entries is a measurable thing to do for an
    // answer that cannot change inside one pass.
    const now = Date.now();

    const cam = camera.position;

    // Prefetch, before the tile pass below decides what to fetch. The order is
    // load-bearing in one direction only: a bundle triggered this frame cannot
    // possibly have landed by the time the pass runs, so this is not about
    // serving *this* frame's tiles. It is about the region 2,200 m out being
    // started 400 m before its tiles enter the 1,800 m load radius, which at
    // 39.4 m/s is 10.2 seconds of lead. See `world/regions.ts`.
    // Hexes first, and on the same argument one level up: a region bundle is
    // the *bytes* of a square kilometre, a hex manifest is the fact that the
    // square kilometre exists at all. Neither can land in time to serve this
    // frame and neither is meant to -- the ordering only means a teleport is
    // acted on in the frame it happens rather than the frame after. The lead is
    // 2,200 m outside the load radius; see `world/hexes.ts`.
    updateHexes(cam.x, cam.z);
    updateRegions(cam.x, cam.z);

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // The coordinate system matters: WebGPU clips depth to [0, w] and WebGL to
    // [-w, w], and the near-plane extraction differs between them. Reading it
    // off the camera means this follows whatever the renderer set rather than
    // silently assuming WebGL, which is the default.
    this.frustum.setFromProjectionMatrix(this.projScreen, camera.coordinateSystem);

    // Rank candidates by distance so the nearest missing tile is always fetched
    // first -- the player notices a hole at their feet, not one at 1.5 km.
    const wanted: Array<{ entry: TileEntry; dist: number }> = [];
    for (const entry of this.index.tiles) {
      const dist = distanceToBounds(cam, entry.bounds);
      if (dist <= this.loadRadius) wanted.push({ entry, dist });
    }
    wanted.sort((a, b) => a.dist - b.dist);

    /*
     * --- The priority pair: the tile underfoot, and the one being driven into.
     *
     * The sort above is recomputed every frame; the four concurrency slots are
     * not. A slot is committed when a fetch starts and held until the bytes
     * land, so three seconds of driving leaves all four held by tiles chosen
     * from where the player *was* while the ground at their feet queues behind
     * a megabyte and a half of city they have already left. Ranking harder
     * cannot fix that -- nothing re-reads the ranking. `world/tilepriority.ts`
     * carries the argument and the rules; this is the wiring.
     *
     * The heading is the camera's own step since last frame rather than where
     * it is looking, because what the streamer needs is where the player is
     * *going*: in third person the eye trails the body, and a player reversing
     * down a street is looking at the tile they are leaving.
     */
    const stepX = this.lastCamX === null ? 0 : cam.x - this.lastCamX;
    const stepZ = this.lastCamZ === null ? 0 : cam.z - this.lastCamZ;
    this.lastCamX = cam.x;
    this.lastCamZ = cam.z;
    const blended = blendHeading(this.headX, this.headZ, stepX, stepZ);
    this.headX = blended.x;
    this.headZ = blended.z;
    // Metres per second off a nominal 60 Hz, because the streamer is handed a
    // camera and not a frame delta. Only the `MOVING_MPS` threshold reads it,
    // and a threshold does not need a better clock than that.
    const speed = Math.sqrt(stepX * stepX + stepZ * stepZ) * 60;
    /*
     * `loaded` is what makes the prediction *chain*. The march walks along the
     * heading and takes the first tile that is not here yet, so the moment one
     * lands the next one along is nominated on the same frame -- the owner's
     * "download the best next tile, and as soon as that's done, do the next"
     * -- with no queue to keep and nothing to drain. `building` counts as here:
     * a tile whose bytes have arrived and is waiting on the build budget does
     * not want asking for again.
     */
    const pair = priorityTiles(
      this.index.tiles,
      cam.x,
      cam.z,
      this.headX,
      this.headZ,
      speed,
      (key) => this.loaded.has(key) || this.building.has(key),
    );
    const outstanding = (key: string | null): boolean =>
      key !== null && !this.loaded.has(key) && !this.building.has(key);
    const priorityOutstanding = outstanding(pair.current) || outstanding(pair.next);
    if (priorityOutstanding) this.standDown(pair);

    // WORKSTREAM AJ: phase 0, and it is deliberately in front of everything that
    // asks for a tile's geometry.
    //
    // The ground of every wanted tile before the geometry of any of them, in the
    // ranking that was just computed. It is 57 map lookups and a millisecond of
    // mesh building, and what it buys is the difference between the player's
    // floor arriving in 1,156 bytes and arriving in 311 kB. See `pumpGround` and
    // `world/ground-first.ts`.
    this.pumpGround(wanted);

    for (const { entry, dist } of wanted) {
      // WORKSTREAM AJ: the ground first here as well, and for the reason the
      // whole pass exists -- a sheet is resident on its own terms and is not
      // reached by the tile branch below, which most of the time has no tile to
      // run over. Same rule, same ranges, same hysteresis as the tile's; see
      // `applyGroundShadowRole`.
      const sheet = this.groundSheets.get(entry.key);
      if (sheet !== undefined) this.applyGroundShadowRole(sheet, dist);
      const tile = this.loaded.get(entry.key);
      if (tile) {
        this.applyBand(tile, dist);
        this.applyShadowRole(tile, dist);
        // Visibility is a union of two frustums, and the second one is the whole
        // reason building shadows were missing.
        //
        // Three renders the shadow map by calling `renderer.render(scene,
        // shadowCamera)` on this same scene graph, and its object walk starts
        // with `if (object.visible === false) return`. A tile hidden here
        // because it is behind the player is therefore hidden from the *sun* as
        // well, and casts nothing. At 3 pm the sun is in the north-west, so the
        // casters for the ground in front of you are behind you for every view
        // that is not pointing roughly into the sun -- which is to say, almost
        // every view. The result was a scene with no cast shadows in it at all.
        //
        // Adding the shadow volume to the test costs the main pass a handful of
        // near tiles it cannot see. That is a few tens of thousands of triangles
        // of vertex work that clips away immediately, against the entire point
        // of the feature.
        //
        // And `tile.warm` in front of both, which is the freeze this pass
        // exists to remove: a tile whose pipelines have not been compiled is
        // not drawn at all, because the frame that first draws it is the frame
        // that compiles them -- thirteen of them, synchronously, on whichever
        // frame the player happened to turn. See `LoadedTile.warm`.
        tile.group.visible =
          tile.warm &&
          (this.frustum.intersectsBox(tile.box) ||
            (tile.casts && shadowVolume !== null && shadowVolume.intersectsBox(tile.box)));
        continue;
      }
      // A tile whose prisms are already resident is not a hole in the picture,
      // it is a solid invisible block of city -- so it gets two concurrency
      // slots nobody else can have. See `HAZARD_EXTRA_SLOTS` for why that set
      // is bounded and why the extra slots are the ones that matter.
      const hazard = this.collisionSink?.hasTile(entry.key) === true;
      const slots = hazard ? this.concurrency + HAZARD_EXTRA_SLOTS : this.concurrency;
      const facts: SlotFacts = {
        priority: entry.key === pair.current || entry.key === pair.next,
        startedAsPriority: this.startedPriority.has(entry.key),
        hazard,
      };
      if (
        // The slot count, the priority pair and the hold-back, in one call. A
        // priority tile ignores the count outright -- the same extra-slot
        // argument `HAZARD_EXTRA_SLOTS` makes, for the same reason.
        admits(facts, priorityOutstanding, this.loading.size, slots) &&
        !this.loading.has(entry.key) &&
        // WORKSTREAM AJ: **and this tile's own ground has settled.** The whole
        // cross-tile ordering, in one clause. `pumpGround` above asked for the
        // grid in this same frame and it is 270 times smaller than the bundle,
        // so this is a wait measured in one round trip on any link where the
        // bundle would have arrived at all.
        //
        // Per tile rather than a global throttle, and that is what makes it
        // safe: a slow grid delays its own tile and nothing else, a grid the
        // build does not contain counts as settled and never delays anything,
        // and the worst case -- a transient fetch failure -- is bounded by
        // `TerrainField`'s own five-second backoff rather than by anything here.
        //
        // A hazard tile is exempt. Its prisms are already resident, so it is not
        // a hole in the picture but a solid invisible block of city, and that
        // outranks every ordering preference in this file. See
        // `HAZARD_EXTRA_SLOTS` and `world/invisible-walls.ts`.
        //
        // And a streamer with no terrain field at all is exempt outright, which
        // is not defensiveness: `pumpGround` settles nothing without one, so
        // without this clause a world with no `terrain` block in its index --
        // every world built before the DEM existed -- would never load a single
        // tile. A gate whose failure mode is an empty city gets an explicit
        // pass-through rather than an implicit one.
        (hazard || this.terrainField === null || this.groundSettled.has(entry.key)) &&
        // Decoded and queued counts as "on its way": without this the tile
        // would be fetched again on every frame between the decode landing and
        // the budget getting round to building it, which at four concurrent
        // slots is the whole streamer wedged behind one tile.
        !this.building.has(entry.key) &&
        // Permanently absent from the build, or inside a retry backoff. This
        // used to be a set that nothing ever emptied, which is the whole of the
        // first defect -- see `TileRetryLedger`.
        this.ledger.ready(entry.key, now)
      ) {
        // Remembered *at the start*, not read at cancellation time: a tile that
        // was the player's own when it was asked for keeps its slot even after
        // they have driven off it. That is the owner's "unless it's previous
        // current and already downloading it".
        if (facts.priority) this.startedPriority.add(entry.key);
        void this.loadTile(entry);
      }
    }

    this.evict(cam, new Set(wanted.map((w) => w.entry.key)));
  }

  /**
   * Phase 3: build queued tiles until the frame budget runs out.
   *
   * The loop checks the clock *between* steps, so a step that starts inside the
   * budget finishes -- see `BUILD_BUDGET_MS` on why that is the right trade and
   * what the real bound is.
   *
   * A step that throws takes its own tile down and nothing else. That matters
   * more than it looks: the alternative is one malformed sidecar stopping the
   * queue, so a single bad tile in the build would freeze the city at whatever
   * had already loaded, which reads as "the world stopped streaming" and points
   * nowhere near the cause.
   */
  /**
   * The queued tile nearest the camera, by index.
   *
   * **This replaces `buildQueue[0]`, and the owner found the bug it fixes by
   * looking at the world:** *"it seems to be loading other tiles before my
   * tile?"*. They were right. The queue's own comment said "arrival order",
   * which means the order four concurrent HTTP fetches happened to resolve in --
   * so the tile a player is standing on was one of forty-four, with no more
   * claim on the next 2.5 ms than a tile eighteen hundred metres behind them.
   * At boot, where the frame rate is on the floor and the budget therefore
   * drains a few milliseconds every second, that is the difference between
   * standing on ground and standing on nothing for five seconds.
   *
   * A scan and not a sort, deliberately: the header's argument against
   * re-sorting the queue every frame is untouched and still right. This is one
   * linear pass over a queue that is a few dozen entries at its worst, run once
   * per build rather than once per frame, and it has a property a sort does not
   * -- **it re-prioritises for free as the player moves**, because it asks the
   * question again each time instead of freezing an answer at insertion.
   *
   * The collision-priority `unshift` above still means what it meant: those
   * tiles are usually the nearest anyway, and when they are not it is because
   * the player is being stopped by an invisible wall somewhere they have
   * already been, which is worth jumping for.
   */
  private nearestQueued(cx: number, cz: number): number {
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < this.buildQueue.length; i++) {
      const b = this.buildQueue[i].entry.bounds;
      // The tile's centre. A tile is 500 m square, so a corner test and a centre
      // test disagree by at most a third of a tile and never about which of two
      // tiles is the one under the player.
      const dx = (b[0] + b[2]) * 0.5 - cx;
      const dz = (b[1] + b[3]) * 0.5 - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  private pumpBuilds(cx: number, cz: number): void {
    if (this.buildQueue.length === 0) return;
    const now = performance.now();
    // The streamer's own frame spacing: `pumpBuilds` runs once per `update`, so
    // the gap since the last one *is* the last frame, and no caller has to
    // thread a delta in. See `world/buildbudget.ts` for why the budget bends.
    const frameMs = this.lastPumpAt > 0 ? now - this.lastPumpAt : 0;
    this.lastPumpAt = now;
    const deadline = now + buildBudgetFor(this.buildBudgetMs, frameMs);
    do {
      // Re-asked every build, not once per frame: a player who turns around
      // mid-drain should have the queue turn around with them.
      const at = this.nearestQueued(cx, cz);
      const job = this.buildQueue[at];
      let done = false;
      try {
        done = job.steps.next().done === true;
      } catch (err) {
        // The generator's own `finally` has already released the geometry and
        // the atlas row on its way out, so there is nothing to undo here.
        done = true;
        // Transient, always: a build that threw is a fact about these bytes and
        // this moment -- a truncated payload, a decode that produced something
        // the builder could not use, an atlas that filled -- and every one of
        // those is fixed by fetching the tile again. The backoff is what keeps
        // a genuinely unbuildable tile from re-fetching 1.6 MB every frame.
        const state = this.ledger.noteTransient(job.entry.key, Date.now(), `build: ${String(err)}`);
        if (state.attempts === 1) {
          console.warn(
            `tile ${job.entry.key} build failed (retrying in ${(this.ledger.nextRetryInMs(job.entry.key, Date.now()) / 1000).toFixed(0)} s):`,
            err,
          );
        }
      }
      if (done) {
        this.buildQueue.splice(at, 1);
        this.building.delete(job.entry.key);
      }
    } while (this.buildQueue.length > 0 && performance.now() < deadline);
  }

  /**
   * Abandon a queued build -- the player walked away before it finished.
   *
   * `return()` resumes the generator at its `finally`, which is where the
   * geometry and the atlas row are released. Everything else a finished tile
   * owns is handed out in the commit step, so a build that never got there has
   * told nobody anything and there is nothing else to take back.
   */
  private cancelBuild(job: PendingBuild): void {
    job.steps.return();
    // And the atlas row explicitly, because `return()` is **not** enough on its
    // own: a generator that has never been resumed has not entered its `try`, so
    // its `finally` does not run, and a tile queued and evicted inside one frame
    // -- which is exactly what a teleport does to four of them -- would leak its
    // block. `release` is idempotent, so the generator running its own `finally`
    // a moment later is harmless; a leak here is not, because the atlas reports
    // itself full long after the tiles that filled it are gone and the city
    // simply stops loading.
    this.atlas.release(job.entry.key);
    this.building.delete(job.entry.key);
    const at = this.buildQueue.indexOf(job);
    if (at >= 0) this.buildQueue.splice(at, 1);
  }

  /** Choose a LOD band for a tile, with hysteresis against its current one. */
  private applyBand(tile: LoadedTile, dist: number): void {
    let band: LodBand = 3;
    for (let i = 0; i < BAND_EDGES.length; i++) {
      // Widen the band the tile is already in, so a tile hovering on an edge
      // stays put instead of switching every frame.
      const edge = BAND_EDGES[i] + (tile.band === i ? BAND_HYSTERESIS : 0);
      if (dist <= edge) {
        band = i as LodBand;
        break;
      }
    }
    tile.band = band;

    // And that, for now, is all a band does: it is recorded and reported, and
    // nothing is switched by it. Worth stating plainly rather than leaving the
    // reader to infer it from an empty method. The two things a band is supposed
    // to drive are both still upstream of here -- the pipeline emits one mesh
    // per building at every distance, and the facade material is one shared
    // pipeline whose parallax cannot be switched off per tile without compiling
    // a second variant of all nine slots.
    //
    // It used to drive shadow casting, and that was the bug: 80 / 400 / 2000 m
    // are shading-cost thresholds and have nothing to do with where the sun's
    // 220 m shadow volume reaches. See `applyShadowRole`.
  }

  /**
   * Decide whether a tile casts into, and receives from, the sun's shadow map.
   *
   * Split out of `applyBand` deliberately. The LOD band is about shading cost
   * and its edges are 80 / 400 / 2000 m, none of which is the shadow volume's
   * 220 m. Driving `receiveShadow` off band 0 meant only the tile the player was
   * standing on could catch a shadow -- and driving `castShadow` off band 1
   * happened to be about right by accident rather than by construction. Both now
   * come from the distances the shadow rig actually implies -- the cast range in
   * the constructor, the receive range per frame from where the sun is.
   *
   * The hysteresis is deliberately on the *outside* of both ranges rather than
   * straddling them, and that is what makes the flips invisible rather than
   * merely infrequent. `receiveRange` is the exact far corner of the volume's
   * ground footprint, so a tile switching on at exactly that distance is
   * switching on where its shadow coverage is a single point, and one switching
   * off does so 40 m past the last texel of the map. The flag changes where the
   * answer it changes is already zero either way.
   */
  private applyShadowRole(tile: LoadedTile, dist: number): void {
    // Hysteresis in the direction the flag currently holds, so a tile parked on
    // a threshold does not rebuild its render pipeline every frame -- three
    // keys the pipeline cache on `receiveShadow`, so flipping it is not free.
    const casts = dist <= this.castRange + (tile.casts ? SHADOW_HYSTERESIS : 0);
    const receives = dist <= this.receiveRange + (tile.receives ? SHADOW_HYSTERESIS : 0);
    if (casts === tile.casts && receives === tile.receives) return;
    tile.casts = casts;
    tile.receives = receives;

    for (const child of tile.group.children) {
      if (!(child as Mesh).isMesh) continue;
      const mesh = child as Mesh;
      // Ground surfaces never cast at any distance: they are flat on the ground,
      // so their only contribution to the depth map would be the ground itself,
      // and every fragment they wrote would be a fragment the buildings have to
      // fight for. They are the surface the shadows land on, so they always
      // receive when they are inside the volume.
      //
      // Trees take the same flags as the buildings, from the same distances, and
      // that is the whole integration: a tree is a caster of exactly the kind
      // this rig was sized for -- 8 to 22 m tall, standing on the ground the
      // shadow lands on -- so nothing about it wants a second set of ranges. A
      // canopy shadow across a footpath is the most valuable shadow in the frame
      // and it costs the depth pass ~85 triangles.
      //
      // Parked cars take the same flags again, and this is where they earn their
      // triangles: a car is 1.5 m tall standing on a road that is otherwise a
      // flat unbroken surface, so the shadow it throws down the gutter is the
      // only thing giving the kerb line any relief at all. They are not marked
      // `userData.surface`, so they cast; they receive on the same range as
      // everything else.
      //
      // Power poles too -- they are 10 m tall and 30 cm across, so they are
      // almost free to rasterise into the depth map and the bar of shadow one
      // throws across a footpath is worth more than the whole pole. The *wires*
      // are the exception in the other direction and carry `userData.noShadow`:
      // a 35 mm ribbon writes a dotted line into a 2048-texel map covering
      // 440 m, which is aliasing rather than shadow. That flag is also why they
      // do not receive -- they are unlit, so a shadow lookup on them would be a
      // texture fetch whose result is discarded.
      //
      // Street furniture takes the flags on the same terms as the cars, and the
      // bins are where it pays: a 1.07 m box standing on a footpath that is
      // otherwise an unbroken flat surface throws the only shadow that surface
      // has. The lit signal lamps carry `userData.noShadow` for exactly the
      // wires' reason -- they are pure emission, so there is nothing for either
      // half of the shadow pass to do with them.
      //
      // The front fences are the one thing here that earns its *receiving* as
      // much as its casting. A fence stands three to eight metres out in a front
      // garden, which is exactly where the shadow of the house behind it and of
      // the street tree beside it falls at 3 pm -- so a fence with no shadow on
      // it is a bright strip across a dark garden. What it casts is a soft bar
      // rather than the stripe pattern its pickets imply, and `world/fences.ts`
      // works out why from the shadow map's 10.7 cm texel.
      const noShadow = mesh.userData.noShadow === true;
      mesh.castShadow = casts && !noShadow && mesh.userData.surface !== true;
      mesh.receiveShadow = receives && !noShadow;
    }
  }

  /**
   * Phase 1: fetch a tile's payloads, allocate its atlas row, and hand the bytes
   * to a decode thread. Nothing here builds anything.
   *
   * The eleven requests still go out together and the terrain grid is still one
   * of them, and that ordering is the whole answer to a question that could have
   * been a lifecycle: trees and parked cars need to know where the ground is
   * before they can be placed on it, and nothing in this tile is built until
   * every request has landed. No placement can run early, so none has to be
   * corrected later. It is also half of the invariant in this file's header --
   * the grid is in `TerrainField` before any geometry exists, and the field
   * never evicts.
   *
   * **The atlas row is allocated here rather than at build time**, which is the
   * one thing about this phase that is not obvious. The row number is what the
   * `_BLDIDX` attribute has to be offset by, and folding that offset in is a
   * pass over every vertex of every building primitive in the tile -- the only
   * genuinely size-proportional piece of the old build block. Allocating before
   * the decode is dispatched lets that pass happen on the decode thread. The
   * cost is that a row is held for a few milliseconds longer than it used to be,
   * and the risk is that a build abandoned before it commits has to give it
   * back, which is exactly what the builder's `finally` does.
   */
  /**
   * Ask every in-flight fetch that is not paying its way to stand down.
   *
   * Called only while a priority tile is outstanding, which is the only thing
   * that makes a cancellation worth its bytes: those bytes are gone and the
   * tile is still wanted, so the trade is only ever "the ground at the player's
   * feet, sooner". `world/tilepriority.cancels` holds the rules -- and holds
   * them where a check can reach them, which is why the decision is not written
   * out here.
   */
  private standDown(pair: { current: string | null; next: string | null }): void {
    for (const key of this.loading) {
      const facts: SlotFacts = {
        priority: key === pair.current || key === pair.next,
        startedAsPriority: this.startedPriority.has(key),
        hazard: this.collisionSink?.hasTile(key) === true,
      };
      if (!cancels(facts, true)) continue;
      const controller = this.aborts.get(key);
      if (controller === undefined) continue;
      this.aborts.delete(key);
      this.cancelledLoads++;
      controller.abort();
    }
  }

  private async loadTile(entry: TileEntry): Promise<void> {
    this.loading.add(entry.key);
    // Only the two big per-tile payloads carry the signal. Aborting either
    // rejects the `Promise.all` immediately, which is the whole point; the nine
    // sidecars behind it are small, finish on their own and have their results
    // dropped. Threading a signal through every one of them would buy back
    // kilobytes and cost a parameter on six call sites.
    const abort = new AbortController();
    this.aborts.set(entry.key, abort);
    try {
      // The console's fault injection, before a byte is asked for, so a faulted
      // attempt leaves nothing half-done and holds no atlas row. See
      // `debugFailTile`.
      const fault = this.injectedFaults.get(entry.key);
      if (fault !== undefined && fault.times > 0) {
        fault.times -= 1;
        if (fault.times <= 0) this.injectedFaults.delete(entry.key);
        throw new TileFetchError(`tiles/${entry.key}.glb (injected)`, fault.status);
      }

      const [glb, paramsBuffer, terrain, parked, lanes, veg, power, furn, pow, names, water] =
        await Promise.all([
          // Bytes rather than a `Response`, because they are about to be
          // transferred to another thread. The tiles are self-contained GLB, so
          // the parser needs no resource path.
          //
          // `fetchWorldAsset` rather than `fetchWorldBuffer`, and the two lines
          // that follow are what it buys: the *status* survives, as a number,
          // into `classifyTileFailure`. `fetchWorldBuffer` throws a message
          // with the code embedded in prose, which is a fine thing to read and
          // a poor thing to branch a session-long suppression on. Nothing about
          // the CDN changes -- this is the same one entry point, with the same
          // per-file fallback and the same strike counter behind it, and the
          // fallback has already happened by the time a status is seen here.
          fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.glb`, this.version, {
            signal: abort.signal,
          }).then((r) => {
            if (!r.ok) throw new TileFetchError(`tiles/${entry.key}.glb`, r.status);
            return r.arrayBuffer();
          }),
          fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.params.bin`, this.version, {
            signal: abort.signal,
          }).then((r) => {
            if (!r.ok) throw new TileFetchError(`tiles/${entry.key}.params.bin`, r.status);
            return r.arrayBuffer();
          }),
          this.terrainField ? this.terrainField.ensure(entry.key) : Promise.resolve(null),
          // Parked cars and the lane graph, kept on this side of the thread
          // boundary -- see this file's header for why, and note that between
          // them they are a tenth of a millisecond of the tile.
          this.loadSidecar(entry, 'cars.bin', Boolean(entry.c)),
          this.loadSidecar(
            entry,
            'lanes.bin',
            // Two listeners, and the test is their union: a world with
            // pedestrians and no traffic must still fetch this, which is what a
            // build made before the traffic pass would be. Skipped outright when
            // nothing is listening, so a world with no traffic in it costs no
            // requests at all.
            (this.traffic !== null || this.pedestrians !== null) && Boolean(entry.lw || entry.lr),
          ),
          this.loadSidecar(entry, 'veg.bin', Boolean(entry.v)),
          // The **union** of the two counts, not the poles alone. A span is
          // filed under the tile containing its midpoint, so a tile can own
          // spans with both their poles next door -- testing `p` on its own
          // drops a wire at a seam, silently, and only on the tiles where a
          // street crosses a tile line.
          this.loadSidecar(entry, 'power.bin', Boolean(entry.p || entry.w)),
          // The union of all three counts, for a different reason: nothing here
          // crosses a seam, this is simply one file holding three independent
          // blocks, and a tile that has only signals must still fetch it.
          this.loadSidecar(entry, 'furn.bin', Boolean(entry.fb || entry.fp || entry.fs)),
          this.loadSidecar(entry, 'pow.bin', Boolean(entry.pw)),
          this.loadSidecar(entry, 'names.bin', Boolean(entry.sn)),
          this.loadSidecar(entry, 'water.bin', Boolean(entry.wv)),
        ]);

      const offset = this.atlas.allocate(entry.key, new Float32Array(paramsBuffer));
      if (offset === null) {
        // Atlas full. Not fatal and not permanent -- eviction frees rows, so this
        // tile is left unloaded and retried on a later frame.
        return;
      }

      const tileSize = this.index!.tile_size;
      const request: TileDecodeRequest = {
        key: entry.key,
        bldOffset: offset,
        // The tile group's own translation, so the street centrelines come back
        // in world metres. Every other payload stays tile-local and inherits the
        // group; the centrelines cannot, because the query that reads them spans
        // several tiles at once.
        originX: entry.bounds[0],
        originZ: entry.bounds[1] + tileSize,
        glb,
        veg,
        power,
        furn,
        pow,
        names,
        water,
      };

      let decoded: TileDecodeResult;
      try {
        decoded = await this.decoder.decode(request);
      } catch (err) {
        // The row was allocated a moment ago and this tile will never use it.
        // Without this the atlas leaks a block per failed tile and eventually
        // reports itself full, at which point the city stops loading for a
        // reason with no connection to the tile that broke.
        this.atlas.release(entry.key);
        throw err;
      }

      const job: PendingBuild = {
        entry,
        steps: this.buildTile(entry, decoded, terrain, parked, lanes),
      };
      // Arrival order, except for the tiles that are stopping the player right
      // now. A tile whose prisms are resident and whose geometry is not is an
      // invisible wall for exactly as long as this queue takes to reach it, so
      // it goes to the head of it -- which is what turns a revisit from "amber
      // until the queue drains" into "amber for one build".
      //
      // This cannot starve the ordinary queue, and the bound is not a
      // convention: the priority set is the tiles `main.ts` has collision for,
      // which is its own 420 m ring, so at most a handful can ever be ahead --
      // and each of them is finite work that leaves the queue when it is done.
      // The header's argument against re-sorting by distance every frame is
      // untouched; this is a one-off placement at insertion, not an ordering.
      if (this.collisionSink?.hasTile(entry.key) === true) {
        this.buildQueue.unshift(job);
        this.priorityBuilds++;
      } else {
        this.buildQueue.push(job);
      }
      this.building.set(entry.key, job);
    } catch (err) {
      // A tile that would not load must not stall the stream -- but *how* it
      // failed decides whether it is ever asked for again, and getting that
      // wrong in the safe-looking direction is the bug this pass exists to fix.
      // A 404 is a fact about the build and is remembered; everything else is a
      // fact about one moment and comes back on a widening backoff. See
      // `world/tile-lifecycle.ts`.
      // **A tile we cancelled is not a tile that failed**, and the difference is
      // the first defect in this file's header seen from the other side: an
      // `AbortError` classifies as transient, and a transient failure buys a
      // five-second backoff. Standing a fetch down to clear the link and then
      // refusing to re-ask for that tile for five seconds is worse than never
      // standing it down at all. It goes back in the queue on the very next
      // frame, ranked by distance like everything else.
      if (abort.signal.aborted) return;
      const now = Date.now();
      if (classifyTileFailure(err) === 'permanent') {
        // Logged once, at `warn`, because a tile in range that the pipeline
        // never emitted is a defect in the build rather than a hiccup -- and
        // counted on the HUD for the same reason. The player cannot act on it;
        // whoever runs the pipeline can.
        if (this.ledger.notePermanent(entry.key, String(err)) && this.logFailures) {
          console.warn(`tile ${entry.key} is not in this build (suppressed for the session):`, err);
        }
      } else {
        const state = this.ledger.noteTransient(entry.key, now, String(err));
        // Once per tile, on the first failure only: the retry is the story and
        // it is already on the overlay, so a console line per attempt would be
        // noise proportional to how bad the network is.
        if (state.attempts === 1 && this.logFailures) {
          console.warn(
            `tile ${entry.key} failed (retrying in ${(retryWaitSeconds(state.nextAt, now)).toFixed(0)} s):`,
            err,
          );
        }
      }
    } finally {
      this.loading.delete(entry.key);
      this.aborts.delete(entry.key);
      // The grandfathering lasts exactly as long as the fetch it protects.
      this.startedPriority.delete(entry.key);
    }
  }

  /**
   * Phase 3: turn one decoded tile into scene objects, a step at a time.
   *
   * Every `yield` is a point at which `pumpBuilds` may stop for the frame. The
   * steps are grouped by what they build rather than by cost, because that is
   * what makes them readable, and the costs happen to be within a factor of
   * three of each other anyway -- the expensive ones are the per-instance matrix
   * loops, and there is one of those per population.
   *
   * The whole body is inside a `try/finally`. The `finally` is the *only*
   * cleanup path in this class for an unfinished tile, and it covers all three
   * ways a build can end early: `pumpBuilds` catching a throw, `evict` calling
   * `steps.return()` because the player walked away, and the generator being
   * dropped on the floor. It must therefore never release anything the commit
   * step has already handed out -- which is why `committed` gates it and why
   * every hand-out is in that one step.
   */
  private *buildTile(
    entry: TileEntry,
    decoded: TileDecodeResult,
    terrain: Float32Array | null,
    carsBuffer: ArrayBuffer | null,
    lanesBuffer: ArrayBuffer | null,
  ): Generator<void, void, void> {
    const group = new Group();
    group.name = entry.key;
    let committed = false;

    /**
     * WORKSTREAM AJ: the step the builder is on, checked against the table.
     *
     * `TILE_BUILD_ORDER` is a list in a three-free file that a boot check reads;
     * this is what makes it *the* order rather than a description of one. Every
     * step names itself, the index must go forwards, and a name not in the table
     * is a fault -- so a future pass that moves a block cannot quietly leave the
     * table behind, and the check that asserts "the ground is not one of these"
     * is asserting something about the code instead of about a comment.
     *
     * Steps are skipped all the time (a dry tile has no water, a CBD tile has no
     * power sidecar), so the test is monotonic rather than consecutive. It costs
     * an `indexOf` over eleven strings, eleven times a tile.
     */
    let stepAt = -1;
    const step = (name: TileBuildStep): void => {
      const at = stepOrder(name);
      if (at < 0) throw new Error(`tile build step "${name}" is not in TILE_BUILD_ORDER`);
      if (at <= stepAt) {
        throw new Error(
          `tile build ran "${name}" (${at}) after step ${stepAt}: the order table and the builder disagree`,
        );
      }
      stepAt = at;
    };

    try {
      const tileSize = this.index!.tile_size;
      const [minX, minZ] = entry.bounds;
      // Tile geometry is tile-local; its world offset is a node translation,
      // which is what keeps float32 vertex precision constant across the whole
      // extent.
      group.position.set(minX, 0, minZ + tileSize);

      // --- The lane sidecar, decoded **before the ground**, which is the one
      // ordering constraint in this whole function.
      //
      // The ways block is where the carriageways are, and `world/rail-cut.ts`
      // declines to carve the ground under one. A tile is built once and nothing
      // ever comes back for it, so a terrain mesh built before its own roads were
      // registered would have a hole in King Street for the life of the session.
      // The routes block is still adopted at the commit step below, with
      // everything else that outlives the tile -- this is the same decoded object
      // handed to a consumer that has to be told earlier, not a second decode.
      //
      // 0.07 ms a tile, measured, and it happens either way; all that changed is
      // where in the generator it happens.
      let lanes: ReturnType<typeof decodeLanes> = null;
      /** Where this tile's roads are, for the neighbour re-cut at the commit. */
      let roadBox: [number, number, number, number] | null = null;
      if (lanesBuffer !== null) {
        lanes = safeDecode(() =>
          decodeLanes(lanesBuffer, entry.bounds[0], entry.bounds[1] + tileSize),
        );
        if (lanes !== null) {
          roadBox = this.roadSink?.adopt(entry.key, lanes.ways, ROAD_RECUT_MARGIN_M) ?? null;
        } else {
          // **A refused sidecar is a world-integrity event, not a shrug.** The
          // decoder returns null on a version it does not read, and for one
          // production incident every lane sidecar in the session was a stale
          // v1 out of an edge-pinned region bundle -- 56 nulls in a row, in
          // silence. With no lanes there is no road deck; with no road deck the
          // rail carve eats the streets and the boundary fence marches across
          // them, which the player reported five times while every local check
          // stayed green. The cause was `cdnAssetUrl` dropping the `?v=`
          // suffix; this warning exists so the *next* systemic refusal is one
          // console line instead of a week. Counted, and shouted once at three
          // -- one null can be a corrupt fetch, three is a pattern.
          this.lanesRefused += 1;
          if (this.lanesRefused === 3) {
            console.warn(
              `[streaming] ${this.lanesRefused} lane sidecars refused by the decoder so far ` +
                `(latest ${entry.key}) -- likely a stale world cache serving an old LANES version. ` +
                `Roads will be missing from the deck and the rail carve will not spare them.`,
            );
          }
        }
        step('lanes');
        yield;
      }

      // --- WORKSTREAM AJ: **the ground is no longer built here, and that is the
      // change.**
      //
      // It used to be the first step of this generator, which was the right
      // ordering inside a tile and the wrong ordering across the world: nothing
      // in here runs until all eleven of the tile's payloads have landed, so a
      // 1,156-byte height grid was waiting on 311 kB of geometry -- 1.6 MB in the
      // CBD -- before a single triangle of floor could be drawn. The sheet is
      // built by `pumpGround` the moment its grid arrives, into the streamer's
      // own ground layer, and by the time this generator exists it is almost
      // always already standing. `ensureGroundSheet` is called again at the
      // commit below, as the last line of defence for the invariant that matters:
      // no tile group enters the scene without its ground already in it.
      //
      // What stays here is `groundAt` -- the tile-local height lookup the trees,
      // the parked cars and the column lamps are placed against. That was never
      // about the mesh; it reads the same grid the sheet was built from, and the
      // grid is in hand because phase 1 still awaits it.
      const groundAt =
        terrain === null
          ? (): number => 0
          : (x: number, z: number): number =>
              sampleTileGrid(terrain, this.terrain.grid, tileSize, x, z);

      // --- The water, which is now the first thing this generator builds: it is
      // the other half of the surface, it was cut against exactly this tile's
      // terrain by the pipeline, and everything else in the tile stands on one or
      // the other. Tile-local like the ground, so it inherits the group's
      // translation; the surface height in it is absolute, so it does not.
      let waterTriangles = 0;
      let waterPlan: Float32Array | null = null;
      const water = decoded.water;
      if (water !== null) {
        for (const mesh of buildWaterMeshes(water, this.waterMaterial)) group.add(mesh);
        waterTriangles = water.triangles;
        waterPlan = waterPlanWorld(water, minX, minZ + tileSize);
        step('water');
        yield;
      }

      // --- The buildings and the street surfaces, from the decoded GLB.
      //
      // The awning fascia is kept as it goes past. It is the only primitive in
      // the build that marks a retail strip exactly, and its vertices are
      // already standing over the footpath -- so it is what spec 7.7's "near
      // bins" turns into without a bin existing anywhere.
      let awningPositions: Float32Array | null = null;
      let awningTriangles = 0;
      const primitives = decoded.glb.primitives;
      for (let i = 0; i < primitives.length; i++) {
        let prim = primitives[i];
        const slot = resolveMaterialName(prim.material);
        const surface = isSurfaceMaterial(slot);
        // **The undercroft, before the geometry is built rather than after.**
        // A building standing across the railway has had a tunnel cut in its
        // collision since last round and has been drawn whole ever since, which
        // is the report *"i still pass through solid buildings on the train"*.
        // Surfaces are exempt: a road, a footpath and the contact shadow lie on
        // the ground, they are not what the train hits, and `world/rail-cut.ts`
        // is already the one rule for what happens to the ground under a
        // corridor. See `world/undercroft.ts` for the route and for why this is
        // not the collision question this class refuses to ask.
        if (this.undercroft !== null && !surface) {
          const opened = carveUndercroft(
            prim,
            group.position.x,
            group.position.z,
            this.undercroft,
            this.undercroftTally,
          );
          if (opened !== null) prim = opened;
        }
        if (slot === 'awning_fascia') {
          const attr = prim.attributes.find((a) => a.name === 'position');
          // Float32 and three-component, tested rather than assumed. The tiles
          // are uncompressed today, but the Draco-plus-quantisation pass the
          // README keeps naming would hand this int16 positions in a normalised
          // range -- at which point reading them as metres would scatter ibises
          // across the tile at random. Failing the test costs the tile its two
          // retail birds and nothing else.
          //
          // The copy is not optional either: the tile's geometry is disposed on
          // stream-out. 46 kB for the heaviest tile in the build, held exactly
          // as long as the tile is.
          if (!awningPositions && attr && attr.itemSize === 3 && attr.array instanceof Float32Array) {
            awningPositions = attr.array.slice();
          }
          awningTriangles += prim.index.length / 3;
        }
        const mesh = new Mesh(buildPrimitiveGeometry(prim), this.materials.get(slot)!);
        mesh.name = slot;
        mesh.userData.surface = surface;
        // The load-time defaults, corrected by `applyShadowRole` on the first
        // frame this tile is seen. Casting starts on so a tile that streams in
        // right beside the player is in the depth map immediately; receiving
        // starts off so a tile that streams in at 1.5 km never compiles the
        // receiving variant of its pipeline at all.
        mesh.castShadow = !surface;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false; // culled per tile instead, far cheaper
        group.add(mesh);
        if ((i + 1) % GLB_PRIMITIVES_PER_STEP === 0) yield;
      }
      step('buildings');
      yield;

      // --- Trees, from the sidecar. Added to the tile's own group so they
      // inherit its world translation and are hidden, shadowed and disposed with
      // it -- there is no separate vegetation lifecycle to keep in step, which is
      // the one way this could have leaked geometry across a stream-out.
      const veg = decoded.veg;
      let trees = 0;
      if (veg !== null) {
        let built = 0;
        for (const mesh of buildTileTrees(veg, this.vegetation, groundAt)) {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          group.add(mesh);
          // The budget's checkpoint, on `GLB_PRIMITIVES_PER_STEP`'s terms
          // exactly. `buildTileTrees` is a generator for this line's sake: it
          // used to hand back a finished array, so a tile's whole vegetation
          // was one step no budget could interrupt.
          if (++built % TREE_MESHES_PER_STEP === 0) yield;
        }
        trees = veg.count;
        // The mushrooms, from the same array the meshes were just built from.
        // After the build rather than before it, so a tile that throws while
        // building its trees leaves nothing growing under trees that are not
        // there. `adopt` rejects the whole city on a distance test first.
        // **The group's own position, not the bounds.** A tile group sits at
        // `(minX, 0, minZ + tileSize)` -- the Z origin is the *far* edge, which
        // is what keeps float32 vertex precision constant across the extent --
        // so `bounds[1]` is a tile out in Z and everything placed against it
        // lands in the neighbour. `groundAt` is tile-local for the same reason;
        // the trees above are placed the same way.
        this.mushroomSink?.adopt(entry.key, veg, group.position.x, group.position.z, groundAt);
        step('trees');
        yield;
      }

      // --- Parked cars, on exactly the same terms as the trees. A car casts and
      // does not receive at load time -- it is 1.5 m tall and standing on the
      // road the shadow lands on, so it is a caster of precisely the kind the rig
      // was sized for, and the shadow it throws across the footpath is worth more
      // than the one it catches.
      //
      // This is one of the two decodes still on the render thread, and it is here
      // rather than in phase 2 because `decodeCars` lives in `world/cars.ts`,
      // which imports `three`. It is 0.03 ms a tile.
      let cars = 0;
      // Held for the commit step below rather than adopted here, on the lane
      // graph's own rule: nothing outside the tile learns about it until it is
      // whole, so a build that is abandoned half-way never leaves a claim
      // pointing at a mesh that was thrown away.
      let parkedCars: TileCars | null = null;
      let parkedMeshes: InstancedMesh[] = [];
      if (carsBuffer !== null) {
        // The tile key goes in because a parked car's identity is derived from
        // it -- see `cars.staticCarIdentity`. The sidecar carries no id of its
        // own and does not need to: the file's own name plus the order the
        // bytes are in *is* the identity.
        const parked = safeDecode(() => decodeCars(carsBuffer, entry.key));
        if (parked !== null) {
          parkedMeshes = buildTileCars(parked, this.carAssets, groundAt);
          for (const mesh of parkedMeshes) {
            mesh.castShadow = true;
            mesh.receiveShadow = false;
            group.add(mesh);
          }
          cars = parked.count;
          parkedCars = parked;
        }
        step('cars');
        yield;
      }

      // --- Power poles and the wires between them. Poles need no `groundAt`:
      // unlike a tree or a car, a pole carries its own terrain height in the
      // sidecar, because the wire leaving it may be anchored from a pole in the
      // next tile and both ends have to have been measured by the same code
      // against the same ground.
      const lines = decoded.power;
      let poles = 0;
      let spans = 0;
      let lamps: Float32Array = EMPTY_LAMPS;
      if (lines !== null) {
        // Derived once and handed to both, because a luminaire reaches out along
        // the crossarm's own axis and a second derivation would disagree with
        // the pole on the eleven per cent that fall through `deriveYaw`'s
        // fallback. See `power.poleYaws`.
        const yaws = poleYaws(lines);
        for (const mesh of buildTilePoles(lines, this.powerAssets, yaws)) {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          group.add(mesh);
        }
        const wires = buildTileWires(lines, this.powerAssets);
        if (wires !== null) {
          wires.castShadow = false;
          wires.receiveShadow = false;
          group.add(wires);
        }
        // The street lamps on a hashed subset of those same poles. Built with
        // the tile and dropped with it; **visible only after dusk**, which is
        // read from the streamer's own remembered state rather than from the sky
        // so that a tile arriving at midnight is lit on the frame it lands.
        const lit = buildTileStreetLamps(
          lines,
          this.streetLamps,
          (i) => yaws[i],
          group.position.x,
          group.position.z,
        );
        if (lit.mesh !== null) {
          lit.mesh.visible = this.nightLightsVisible;
          lit.mesh.castShadow = false;
          lit.mesh.receiveShadow = false;
          group.add(lit.mesh);
        }
        lamps = lit.lamps;
        poles = lines.poleCount;
        spans = lines.wireCount;
        step('power');
        yield;
      }

      // --- Street furniture, needing no `groundAt` for the reason the poles do
      // not: the sidecar carries an absolute height per instance. Unlike a pole
      // it is the height of the *paving* rather than of the terrain -- the
      // pipeline has already added the footpath's 15 cm, because a bin stands on
      // the concrete where a pole is set into a hole through it.
      //
      // Bins, posts and signal heads all cast and none receives, which is the
      // same call `cars.ts` gets and for the same reason: a 1.07 m bin on an
      // unbroken concrete surface throws the only shadow that surface has, and
      // the one it would catch is worth much less. The lit lamps are the
      // exception in the other direction and carry `userData.noShadow`.
      const props = decoded.furn;
      let bins = 0;
      let posts = 0;
      let signals = 0;
      let bladeLabels: BladeLabelSite[] = [];
      if (props !== null) {
        for (const mesh of [
          ...buildTileBins(props, this.furnitureAssets),
          ...buildTilePosts(props, this.furnitureAssets),
          ...buildTileSignals(props, this.furnitureAssets),
        ]) {
          const noShadow = mesh.userData.noShadow === true;
          mesh.castShadow = !noShadow;
          mesh.receiveShadow = false;
          group.add(mesh);
        }
        bins = props.binCount;
        posts = props.postCount;
        signals = props.signalCount;
        // Where this tile's legends hang, lifted into world metres once. The
        // meshes that draw them are not built here and are not this tile's --
        // see `BladeLabels`, and `bladeLabels` on `LoadedTile`.
        bladeLabels = collectBladeLabels(props);
        for (const site of bladeLabels) {
          site.x += group.position.x;
          site.z += group.position.z;
        }
        step('furniture');
        yield;
      }

      // --- Spec 8.3's powerups. The one streamed thing in the build whose
      // *state* does not belong to the tile: the icons go on the tile's group and
      // are disposed with it, but the "taken, back in 74 s" lives in the sink and
      // survives an eviction, which is what stops walking a block and back
      // resetting every respawn in the suburb. The sink is not told until the
      // commit step -- see the invariant in this file's header.
      const picks = decoded.pow;
      let powerupIcons: PowerupIcons | null = null;
      if (picks !== null) {
        powerupIcons = new PowerupIcons(picks, this.powerupAssets);
        for (const mesh of powerupIcons.meshes) group.add(mesh);
        step('powerups');
        yield;
      }

      // --- The lane graph, and the cars driving it. Nothing is built and nothing
      // is added to the group -- like `.names.bin` this payload draws no geometry
      // of its own, and unlike `.names.bin` what it describes is not even in this
      // tile. A route belongs to the tile holding its *first* point and runs up
      // to 800 m out of it, and the fleet is drawn as one instanced set for the
      // whole visible world rather than per tile, because a car crosses a seam
      // every few seconds.
      //
      // Decoded here and adopted in the commit step, which is the second of the
      // two decodes still on the render thread: `decodeLanes` belongs to
      // `game/traffic.ts`, which imports `three`. 0.07 ms a tile. `decodeLanes`
      // folds the group's translation in itself, which is the one place that
      // conversion can happen exactly once.
      //
      // The routes block is the traffic and the ways block is the footpath
      // network; one fetch, one decode, two consumers, and no second sidecar --
      // which is what `tiles.write_lanes` designed the ways block for. See
      // `game/pedestrians.buildBands`.
      //
      // **Decoded up at the top of this function now**, before the ground, and
      // the reason is written down there: the ways block is also where the
      // carriageways are, and the terrain carve has to know about them before it
      // cuts. Still one decode and still one object.

      // --- And the third consumer of that ways block: the street lights on the
      // streets that have no power pole to hang one from.
      //
      // Here rather than up in the power block, because a CBD tile has **no
      // power sidecar at all** -- `decodePower` returns null when a tile has
      // neither a pole nor a span, which is the case for 353 of the 3,187 tiles
      // and for most of the city centre -- so the branch that builds pole lamps
      // is exactly the branch that can never run where these are needed. It is
      // also the first point in the build at which the ways are decoded.
      //
      // `world/nightlights.deriveColumnLamps` owns every decision about where
      // one goes and refuses outright in any tile with a pole line in it; what
      // is done here is only to turn its answer into two instanced sets and to
      // hand their luminaire positions to the same array the pole lamps fill.
      let columnLamps: Float32Array = EMPTY_LAMPS;
      if (lanes !== null && lanes.ways.length > 0) {
        const sites = deriveColumnLamps(
          lanes.ways,
          lines,
          group.position.x,
          group.position.z,
          // World in, terrain out. `groundAt` above is tile-local like
          // everything else the build places, and a way's coordinates are not.
          (x, z) => groundAt(x - group.position.x, z - group.position.z),
        );
        if (sites.length > 0) {
          const built = buildTileColumnLamps(sites, this.streetLamps, group.position.x, group.position.z);
          if (built.post !== null) group.add(built.post);
          if (built.glow !== null) {
            // Dusk-gated on the streamer's own remembered state, exactly as the
            // pole lamps are and for the same reason: a tile that lands at
            // midnight has to arrive already lit.
            built.glow.visible = this.nightLightsVisible;
            group.add(built.glow);
          }
          columnLamps = built.lamps;
        }
        step('column-lamps');
        yield;
      }

      // --- Ibises, derived from two things that are already in hand: the tree
      // sidecar decoded in phase 2, and the awning geometry collected on the way
      // past. Nothing is fetched for them and nothing was built for them --
      // spec 7.7's "scatter near bins and parks" turns out to be answerable
      // entirely from data the tile was already carrying. See `birds.ts`.
      //
      // They cast, and that is the whole reason a 0.84 m object is allowed into
      // the depth pass: the shadow map is 4096 over 440 m, so 10.7 cm a texel,
      // and a standing ibis at the 3 pm sun's 57 degrees throws about five
      // texels of shadow. Five texels is a small dark blob, and a bird with no
      // dark blob under it does not stand on the ground, it floats over it.
      //
      // They get a different ground function from the trees and the cars, and it
      // is the one thing about them that is not a copy of how those work. A tree
      // stands where the pipeline put it and never moves, so the tile's own
      // clamped grid answers it exactly. A bird spawns up to 12 m from its fig
      // and then runs 8-15 m from the player, so it routinely ends up over the
      // *next* tile -- where `sampleTileGrid` clamps to the edge post and extends
      // it flat, and the bird floats or sinks by the local gradient times however
      // far it strayed. On Crown Street that is two and a half metres. The field
      // query is the same one the player walks on and is correct across a seam;
      // it falls back to the tile grid only where the neighbour has not loaded,
      // which is a tile the bird cannot be seen from.
      const field = this.terrainField;
      const originZ = minZ + tileSize;
      const birdGround =
        field === null
          ? groundAt
          : (x: number, z: number): number => {
              const h = field.height(x + minX, z + originZ);
              return Number.isFinite(h) ? h : groundAt(x, z);
            };
      const birds = buildTileIbises(
        entry.key,
        minX,
        minZ,
        tileSize,
        veg,
        awningPositions,
        awningTriangles,
        this.birdAssets,
        birdGround,
      );
      if (birds !== null) {
        birds.mesh.castShadow = true;
        birds.mesh.receiveShadow = false;
        group.add(birds.mesh);
      }
      step('birds');
      yield;

      // --- The commit. One step, no `yield` inside it, and that is the point:
      // everything that outlives the tile is told about it here, in one task, so
      // there is no frame in which the traffic is driving through a tile the
      // scene has not got or the far layer has taken its slabs away from a tile
      // that is not there yet.
      step('commit');

      // WORKSTREAM AJ: **the invariant, in the one place it can be enforced.**
      //
      // No tile group enters the scene without its ground already standing. The
      // ground pass has almost certainly built this sheet several seconds ago --
      // that is the whole point of it -- and this call is a map lookup when it
      // has. It is here for the times it has not: a caller driving `loadTile`
      // with no `update` behind it, a grid that landed in the same frame as the
      // bundle, or some future reordering of the pass above. Making it a line of
      // code at the moment a tile becomes visible is worth more than any amount
      // of ordering discipline elsewhere.
      this.ensureGroundSheet(entry, terrain);

      if (group.children.length === 0) {
        // Permanent, not transient, and the distinction is the point of the
        // taxonomy: the payload arrived, decoded and produced nothing, which is
        // a fact about what the pipeline emitted for this tile. Re-fetching
        // 1.6 MB every two minutes to build nothing again would be the retry
        // machinery doing damage. Counted with the 404s, where it belongs.
        //
        // **This reaches one tile more than it used to**, and the extra one is
        // correct: a tile whose only content was its terrain used to have a
        // terrain mesh in this group and therefore counted as built. Its ground
        // is now a sheet in its own layer, drawn either way, so what is left
        // here is a 311 kB payload that produces nothing -- which is exactly
        // what this branch is for. The player sees the same ground and the
        // streamer stops asking for the rest of it.
        this.ledger.notePermanent(entry.key, 'built nothing');
        // The roads were adopted before the ground was built and this tile is
        // now never going to be `dispose`d, because it was never loaded. Give
        // them back here or the deck holds a tile nothing will ever drop.
        this.roadSink?.drop(entry.key);
        return;
      }

      const groundLo = terrain === null ? 0 : minOf(terrain);
      const groundHi = terrain === null ? 0 : maxOf(terrain);
      const centre = new Vector3(
        (entry.bounds[0] + entry.bounds[2]) / 2,
        groundHi + entry.hmax / 2,
        (entry.bounds[1] + entry.bounds[3]) / 2,
      );
      // A span belongs to the tile holding its midpoint and reaches up to half
      // its own length past the seam, so a tile that owns spans is wider than
      // its bounds by that much. Without this, walking down a street watches the
      // last wire of a block vanish the moment the tile it crosses into leaves
      // the frustum. 30 m is `power.MAX_SPAN / 2`; on a 500 m tile it is 6% more
      // tile-visible frames and nothing else.
      const reach = spans > 0 ? 30 : 0;
      const box = new Box3(
        // The floor takes the terrain skirt and the buildings' buried wall
        // skirt with it, so nothing hangs below the box.
        new Vector3(entry.bounds[0] - reach, groundLo - 3, entry.bounds[1] - reach),
        // A tile of low terraces has `hmax` around 8 m and its trees reach 22.
        // The box is what the frustum and the shadow volume are tested against,
        // so understating it pops the canopies out at the top of the screen when
        // the player looks up in a street the buildings are shorter than. A pole
        // is 11.5 m and stands on streets that are otherwise single storey, so
        // it needs the same treatment at its own smaller height.
        new Vector3(
          entry.bounds[2] + reach,
          groundHi + Math.max(entry.hmax, trees > 0 ? 25 : poles > 0 ? 14 : 6),
          entry.bounds[3] + reach,
        ),
      );

      this.root.add(group);
      // Not drawn until its pipelines exist. See `LoadedTile.warm`, which is the
      // whole of why this line is here: a tile shown before it is compiled
      // compiles thirteen pipelines inside whichever frame the player's own
      // turn brings it into the frustum.
      group.visible = false;

      let powerupStates: readonly PowerupDrawState[] = [];
      if (picks !== null && powerupIcons !== null && this.powerupSink !== null) {
        // The sink is handed world metres rather than the tile-local ones in the
        // sidecar, because a powerup is tested against a player position that is
        // world-space and the conversion has to happen exactly once.
        const worldX = new Float32Array(picks.count);
        const worldZ = new Float32Array(picks.count);
        for (let i = 0; i < picks.count; i++) {
          worldX[i] = picks.x[i] + group.position.x;
          worldZ[i] = picks.z[i] + group.position.z;
        }
        powerupStates = this.powerupSink.adopt(
          entry.key,
          picks.kind,
          worldX,
          // Already absolute -- the pipeline samples the footpath height, the
          // tile group sits at y = 0, and nothing here adds a bias. Passed as
          // the sidecar's own array rather than a copy for that reason.
          picks.groundY,
          worldZ,
        );
        // Pose once against the real states before the tile is ever drawn.
        // Without it a tile re-streaming next to a powerup somebody took twenty
        // seconds ago shows it present for exactly one frame, which is a flicker
        // with no cause a player could work out.
        powerupIcons.update(powerupStates, 0);
      }

      if (lanes !== null) {
        this.traffic?.adopt(entry.key, lanes);
        this.pedestrians?.adopt(entry.key, lanes);
        // And the ground of whatever was already standing when these roads
        // arrived. The deck itself was adopted at the top of this function, in
        // time for this tile's own carve; what could not be done then is the
        // *neighbours*, because a tile is built once and a tile built an hour ago
        // has a hole in it where this tile's street crosses the seam. Bounded to
        // the box the roads actually occupy -- see `recutGround`.
        if (roadBox !== null) this.recutGround(roadBox);
      }

      // And the parked cars, to whoever is drawing the near ones as models. The
      // group's translation goes with them because the sidecar's coordinates are
      // tile-local and the model fleet hangs off the scene -- the same
      // conversion `powerupSink` above is handed, and for the same reason.
      if (parkedCars !== null && this.parkedCars !== null) {
        this.parkedCars.adopt(
          entry.key,
          parkedCars,
          parkedMeshes,
          group.position.x,
          group.position.z,
        );
      }

      // --- WORKSTREAM S: and the same cars again, as cars a player can steal.
      //
      // Beside the model sink rather than inside it: the two have different
      // optionality (see `staticCars`) and the field must be fed even on a client
      // whose car models never loaded. The origin pair is the tile group's
      // translation, which is what turns the sidecar's tile-local metres into the
      // world metres the server's own copy of this field already holds -- the two
      // ends fold the identical offset into the identical bytes, which is what
      // makes a predicted take and an authoritative one the same car.
      if (parkedCars !== null) {
        this.staticCars?.adopt(entry.key, parkedCars, group.position.x, group.position.z);
      }

      // One array for both kinds of luminaire, because `nearestLamps` is asking
      // "what can light what I am standing next to" and a column and a pole lamp
      // are the same answer. Concatenated rather than kept as two lists so the
      // search stays one linear pass over one buffer per tile; almost every tile
      // has exactly one of the two, so the copy is a no-op on all but the fringe.
      if (columnLamps.length > 0) {
        if (lamps.length === 0) {
          lamps = columnLamps;
        } else {
          const both = new Float32Array(lamps.length + columnLamps.length);
          both.set(lamps, 0);
          both.set(columnLamps, lamps.length);
          lamps = both;
        }
      }

      const tile: LoadedTile = {
        entry,
        group,
        // No precompiler installed means the old behaviour: drawable at once.
        warm: this.precompile === null,
        band: 0,
        casts: true,
        receives: false,
        centre,
        box,
        trees,
        water: waterTriangles,
        waterPlan,
        cars,
        poles,
        spans,
        lamps,
        bins,
        posts,
        signals,
        bladeLabels,
        streets: decoded.names,
        birds,
        powerups: powerupIcons,
        powerupStates,
      };
      this.loaded.set(entry.key, tile);
      if (tile.warm) {
        // The far layer's half of the same event, and it stays paired with the
        // moment the real buildings become *drawable* rather than the moment
        // they enter the graph -- a frame with neither is a hole in the city and
        // a frame with both is a flat box in front of a facade. With a
        // precompiler installed that moment is `markWarm` below instead.
        this.farCity?.setTileResident(entry.key, true);
      } else {
        this.warmTile(tile);
      }
      this.builtTiles++;
      // The tile is here. Forget every failure it ever had, **including the
      // attempt count** -- a tile that hiccupped twice an hour ago and has
      // loaded a hundred times since must not wait 45 s on its next one. This
      // is the "reset on success" half of the backoff and it is the half that
      // is easy to leave out, because leaving it out is invisible until the
      // network is bad twice.
      this.ledger.clear(entry.key);
      committed = true;
    } finally {
      // The single cleanup path for every way a build can end without
      // committing: a throw, an eviction calling `steps.return()`, or the
      // group-was-empty return above. A committed tile owns its group and its
      // atlas row for as long as it is resident, so `dispose` -- not this -- is
      // what releases those.
      if (!committed) {
        this.root.remove(group);
        releaseGroupGeometry(group);
        group.clear();
        this.atlas.release(entry.key);
      }
    }
  }

  /**
   * Fetch one of a tile's sidecars as raw bytes, or null.
   *
   * **Never throws and never fails the tile.** A missing, truncated or malformed
   * sidecar means a tile without that thing in it, which is a tile -- the world
   * is older than most of these passes and an index or a tile directory from
   * before one of them must still load. That is also why the caller consults the
   * index count first: the request is skipped entirely for a tile the pipeline
   * said has none, so the common case costs nothing at all rather than a 404.
   * `.pow.bin` is absent from 100 of the inner ring's 221 tiles and `.water.bin`
   * from 213 of them, so this is most of the tiles most of the time.
   *
   * One method rather than the seven near-identical ones this replaces, now that
   * none of them decodes anything: what was different between them was which
   * index field to test, and that is the caller's business and is documented at
   * the call site where the union tests can be read against each other.
   */
  private async loadSidecar(
    entry: TileEntry,
    extension: string,
    present: boolean,
  ): Promise<ArrayBuffer | null> {
    if (!present) return null;
    try {
      const resp = await fetchWorldAsset(
        this.baseUrl,
        `tiles/${entry.key}.${extension}`,
        this.version,
      );
      if (!resp.ok) return null;
      return await resp.arrayBuffer();
    } catch {
      return null;
    }
  }

  /**
   * The streaming boot check: one real tile, decoded three ways, compared.
   *
   * It is the only check in this client that needs the *world* rather than
   * arithmetic, and it guards the two claims this whole pass rests on and
   * neither of which can be read off the source:
   *
   *   1. `parseTileGlb` produces what `GLTFLoader` produced, attribute for
   *      attribute and index for index, including the lowercased `_bldidx` the
   *      pipeline cache key is warmed against and including the atlas-offset
   *      fold that moved to the decode thread.
   *   2. A tile survives the worker boundary unchanged -- the transfer list, the
   *      structured clone and the reply shape.
   *
   * Every way either could be wrong is silent. A dropped `normalized` flag turns
   * the contact skirt's colour ramp from a 0..1 gradient into 0..255; a buffer
   * missing from the transfer list still arrives, just copied; a field forgotten
   * in the reply reads as "this tile has no trees".
   *
   * Chosen tile: the one the index says carries the most of everything, so the
   * check exercises all six worker-side sidecars rather than a park with nothing
   * on it. It costs one tile's bytes, which the player is about to stream
   * anyway, and it is meant to be called only in dev.
   *
   * Never throws, and returns a list of failures like every other check here.
   */
  async verifyStreaming(): Promise<string[]> {
    const index = this.index;
    if (!index) return ['verifyStreaming ran before loadIndex'];
    // The richest tile in the build: every optional sidecar present, so nothing
    // in the payload goes untested. Falls back to the first tile with a GLB.
    let pick: TileEntry | null = null;
    let best = -1;
    for (const entry of index.tiles) {
      const score =
        (entry.v ? 1 : 0) +
        (entry.p || entry.w ? 1 : 0) +
        (entry.fb || entry.fp || entry.fs ? 1 : 0) +
        (entry.pw ? 1 : 0) +
        (entry.sn ? 1 : 0) +
        (entry.wv ? 1 : 0);
      if (score > best) {
        best = score;
        pick = entry;
      }
    }
    if (!pick) return ['verifyStreaming found no tiles in the index'];
    const entry = pick;

    try {
      const [glb, veg, power, furn, pow, names, water] = await Promise.all([
        fetchWorldBuffer(this.baseUrl, `tiles/${entry.key}.glb`, this.version),
        this.loadSidecar(entry, 'veg.bin', Boolean(entry.v)),
        this.loadSidecar(entry, 'power.bin', Boolean(entry.p || entry.w)),
        this.loadSidecar(entry, 'furn.bin', Boolean(entry.fb || entry.fp || entry.fs)),
        this.loadSidecar(entry, 'pow.bin', Boolean(entry.pw)),
        this.loadSidecar(entry, 'names.bin', Boolean(entry.sn)),
        this.loadSidecar(entry, 'water.bin', Boolean(entry.wv)),
      ]);
      const failures = await this.verifyTileGlbParse(glb.slice(0));
      const roundTrip = await this.verifyDecodeRoundTrip({
        key: entry.key,
        bldOffset: 11,
        originX: entry.bounds[0],
        originZ: entry.bounds[1] + index.tile_size,
        glb,
        veg,
        power,
        furn,
        pow,
        names,
        water,
      });
      for (const f of roundTrip) failures.push(`worker round trip: ${f}`);
      const keyed = failures.map((f) => `${entry.key}: ${f}`);
      for (const f of await this.verifyLifecycle()) keyed.push(f);

      // --- The packing, three ways, because it is a two-repository format and
      // every way it can be wrong is silent.
      //
      // 1. The arithmetic, against known values with no network in it. This is
      //    the bit-exact round trip: `_BLDIDX` and the indices come back
      //    *equal*, not close. See `verifyMeshPack`.
      for (const f of verifyMeshPack()) keyed.push(`mesh pack: ${f}`);
      // 2. The version, so a client reading a build packed by different rules
      //    fails at boot rather than drawing a city of noise on the first tile
      //    that happens to use whichever field moved.
      const pack = index.geometry?.pack;
      if (pack !== undefined && pack !== TILE_PACK_VERSION) {
        keyed.push(
          `this world's geometry is packed to version ${pack} and this client reads ` +
            `${TILE_PACK_VERSION}. Rebuild the world, or check ` +
            '`PACK_VERSION` in `pipeline/sydney/meshpack.py` against `TILE_PACK_VERSION`.',
        );
      }
      // 3. The error the pipeline measured over the whole build, against the
      //    claim this pass rests on -- that the drift is below anything the eye
      //    can see. A centimetre is the line: the facade shader's window grid is
      //    denominated in metric UVs and the road surfaces sit a centimetre or so
      //    off the terrain, so a build that quietly moved past this is a build
      //    that could z-fight.
      const positionError = index.geometry?.max_position_error_mm ?? 0;
      const uvError = index.geometry?.max_uv_error_mm ?? 0;
      if (positionError > 10 || uvError > 10) {
        keyed.push(
          `the pipeline packed this world to ${positionError.toFixed(1)} mm of position error and ` +
            `${uvError.toFixed(1)} mm of UV error. Over 10 mm is past what the quantisation ` +
            'argument in `sydney/meshpack.py` covers.',
        );
      }

      // --- The region bundles: the format, the ownership arithmetic, and that
      // a miss falls back per-tile rather than leaving a hole.
      for (const f of verifyRegions()) keyed.push(`regions: ${f}`);
      for (const f of verifyHexes()) keyed.push(`hexes: ${f}`);
      for (const f of await this.verifyRegionFallback(entry)) keyed.push(`regions: ${f}`);
      return keyed;
    } catch (err) {
      return [`verifyStreaming could not read tile ${entry.key}: ${String(err)}`];
    }
  }

  /**
   * A region that is not there must cost one failed request and nothing else.
   *
   * The live half of the bundle check, and it earns its request the way
   * `verifyLifecycle`'s 404 probe does. Everything about regions is an
   * optimisation over a path that already worked, and the promise is that every
   * way it can go wrong lands back on that path -- so the thing worth proving
   * on a real origin is that a *missing* bundle still yields a tile.
   *
   * Driven by asking for a real tile's assets after pointing the cache at a
   * region key that cannot exist, which is what a publish that dropped a file,
   * a CDN that has not warmed the tree, or a bundle truncated mid-upload all
   * look like from here. The assertion is simply that the bytes still arrive.
   */
  private async verifyRegionFallback(entry: TileEntry): Promise<string[]> {
    const failures: string[] = [];
    try {
      const resp = await fetchWorldAsset(
        this.baseUrl,
        `regions/__no_such_region__.bin`,
        this.version,
      );
      if (resp.ok) {
        failures.push(
          'A region bundle that does not exist was answered 200. Every missing bundle would ' +
            "be parsed as garbage -- check the dev server's single-page fallback.",
        );
      }
    } catch {
      // Offline, or the origin is down. Not a failure of this rule.
    }
    try {
      // The tile's own GLB, which the bundle for this region either holds or
      // does not. Either way the bytes must arrive, because either way there is
      // a per-tile file behind them.
      const glb = await fetchWorldBuffer(this.baseUrl, `tiles/${entry.key}.glb`, this.version);
      if (glb.byteLength === 0) {
        failures.push(`tiles/${entry.key}.glb came back empty through the bundle path.`);
      }
    } catch (err) {
      failures.push(
        `tiles/${entry.key}.glb did not load: ${String(err)}. A region miss must degrade to a ` +
          'per-tile fetch, never to a hole in the city.',
      );
    }
    return failures;
  }

  /**
   * The other thing streaming can get wrong, and the one that used to be
   * permanent: what happens to a tile that *does not* load.
   *
   * `verifyTileLifecycle` holds the arithmetic still on its own -- the
   * taxonomy, the backoff, the safety radius -- and is run at boot with the
   * rest of the pure checks. What can only be asserted here is the **wiring**:
   * that this class's gate actually consults the ledger, that a transient
   * failure leaves the tile in a phase that says "wait, with an end on it", and
   * that a 404 leaves it in a phase that says "never, and here is a build to
   * fix". Every one of those is a two-line connection that would fail silently:
   * a tile that is quietly never retried looks exactly like a slow network.
   *
   * Driven through a **synthetic key**, so no tile in the real build is faulted
   * or suppressed by running this, and forgotten afterwards so the overlay's
   * counts are untouched. The fault is injected ahead of the fetch, so nothing
   * is requested, no atlas row is taken and the scene is not touched.
   *
   * The live half is the 404 probe, and it earns its request: a dev server that
   * answers 200 with an HTML shell for an unknown path -- which is what a
   * single-page fallback does -- would make every genuinely missing tile look
   * like a corrupt one and retry it forever. That is invisible from the source
   * of this file and is exactly what a boot check is for.
   */
  private async verifyLifecycle(): Promise<string[]> {
    const failures: string[] = [];
    const key = '__lifecycle_check__';
    const synthetic: TileEntry = { key, b: 0, t: 0, bounds: [0, 0, 0, 0], hmax: 0, size: 500 };

    // Quiet, because everything below is broken on purpose and the console
    // lines it would print are indistinguishable from the real failure they
    // exist to report.
    this.logFailures = false;
    try {
      // --- A transient failure: retried, with a countdown, and not suppressed.
      this.debugFailTile(key, 503, 1);
      await this.loadTile(synthetic);
      if (this.tilePhase(key) !== 'failed') {
        failures.push(
          `A 503 left the tile in phase '${this.tilePhase(key)}' rather than 'failed' (retrying). ` +
            'A transient failure that is not remembered as retryable is a permanent invisible wall.',
        );
      }
      const wait = this.retryInSeconds(key);
      if (!(wait > 4 && wait <= 5)) {
        failures.push(`The first retry is due in ${wait.toFixed(1)} s; the schedule says 5 s.`);
      }
      if (this.ledger.ready(key, Date.now())) {
        failures.push('A tile that failed a moment ago was ready to be fetched again immediately.');
      }
      if (!this.ledger.ready(key, Date.now() + 5_001)) {
        failures.push('A tile was still suppressed after its backoff elapsed -- the retry never happens.');
      }
      // And a success forgets it, which is what `buildTile`'s commit does.
      this.ledger.clear(key);
      if (this.tilePhase(key) !== 'absent') {
        failures.push('A tile that loaded is still reported as failed.');
      }

      // --- A 404: suppressed for the session, counted, and never retried.
      this.debugFailTile(key, 404, 1);
      await this.loadTile(synthetic);
      if (this.tilePhase(key) !== 'missing') {
        failures.push(
          `A 404 left the tile in phase '${this.tilePhase(key)}' rather than 'missing'. ` +
            'A tile the build does not contain would be re-fetched forever.',
        );
      }
      if (this.ledger.ready(key, Date.now() + 86_400_000)) {
        failures.push('A 404 tile was ready to be fetched again a day later.');
      }
    } finally {
      // Whatever happened above, this key leaves no trace: no injected fault,
      // no retry, no phantom absent tile on the overlay's count.
      this.injectedFaults.delete(key);
      this.ledger.forget(key);
      this.logFailures = true;
    }

    // --- The live half: does this origin really 404 a tile that is not there?
    try {
      const resp = await fetchWorldAsset(this.baseUrl, 'tiles/__no_such_tile__.glb', this.version);
      if (resp.ok) {
        failures.push(
          'A tile that does not exist was answered 200 by the origin. Every missing tile will be ' +
            'classified transient and re-fetched for the life of the session -- check the dev ' +
            "server's single-page fallback.",
        );
      } else if (classifyTileFailure(new TileFetchError('tiles/__no_such_tile__.glb', resp.status)) !== 'permanent') {
        failures.push(
          `A missing tile answers ${resp.status}, which this client retries rather than suppresses. ` +
            'See `PERMANENT_STATUS` in `world/tile-lifecycle.ts`.',
        );
      }
    } catch {
      // Offline, or the origin is down. Not a failure of this rule: what the
      // check is about is what a *reachable* origin says about a missing file.
    }

    return failures;
  }

  /**
   * Prove that the purpose-built GLB reader agrees with `GLTFLoader`, on a real
   * tile, including the atlas-offset fold.
   *
   * The check that makes `parseTileGlb` honest. It is a hand-written reader of
   * one pipeline's output standing in for four thousand lines of the general
   * case, and the ways it could be subtly wrong are all silent: an attribute
   * under the wrong name draws with the wrong pipeline (a compile hitch, which
   * is the bug this whole change exists to remove, reintroduced by the fix); a
   * `normalized` flag dropped turns the contact skirt's colour ramp from a 0..1
   * gradient into 0..255; an accessor read at the wrong offset is a building in
   * the harbour.
   *
   * Compared against `GLTFLoader` rather than against a fixture, because
   * `GLTFLoader` is the thing whose behaviour this has to match -- including its
   * lowercasing of `_BLDIDX`, which is in the geometry cache key `warmup.ts`
   * warms against.
   *
   * Dev only, on the first tile that loads, and never fatal: a failure is a
   * console warning because the game is playing correctly or it is not, and this
   * check cannot tell which. It is a signal to a developer.
   */
  async verifyTileGlbParse(buffer: ArrayBuffer, offset = 7): Promise<string[]> {
    const failures: string[] = [];
    // Two copies: `parseTileGlb` reads its input and `parseAsync` reads its own,
    // and the offset fold is destructive on whichever it is given.
    const gltf = await this.loader.parseAsync(buffer.slice(0), '');
    const mine = parseTileGlb(buffer.slice(0), offset);
    // And the file's own JSON, because `GLTFLoader` drops accessor `extras` and
    // the packing lives there. Reading it a third time is cheap -- the chunk is
    // a few tens of kilobytes -- and it is what lets the comparison below undo
    // the packing *independently* of the code being checked.
    const extras = readAccessorExtras(buffer);

    const reference: Mesh[] = [];
    gltf.scene.traverse((node) => {
      if ((node as Mesh).isMesh) reference.push(node as Mesh);
    });
    if (reference.length !== mine.primitives.length) {
      failures.push(`primitive count: GLTFLoader ${reference.length}, parseTileGlb ${mine.primitives.length}`);
      return failures;
    }

    for (let i = 0; i < reference.length && failures.length < 8; i++) {
      const want = reference[i].geometry;
      const got = mine.primitives[i];
      const slot = reference[i].material;
      const mat = Array.isArray(slot) ? slot[0] : slot;
      if ((mat?.name ?? '') !== got.material) {
        failures.push(`primitive ${i}: material ${mat?.name} vs ${got.material}`);
      }
      const wantNames = Object.keys(want.attributes).sort().join(',');
      const gotNames = got.attributes.map((a) => a.name).sort().join(',');
      if (wantNames !== gotNames) {
        failures.push(`primitive ${i}: attributes ${wantNames} vs ${gotNames}`);
        continue;
      }
      for (const attr of got.attributes) {
        const ref = want.getAttribute(attr.name);
        if (ref.itemSize !== attr.itemSize) {
          failures.push(`primitive ${i} ${attr.name}: itemSize ${ref.itemSize} vs ${attr.itemSize}`);
          break;
        }
        // Colour is the one attribute that reaches the GPU as an integer, so it
        // is the one whose `normalized` flag still has to survive verbatim --
        // it is in the geometry cache key, and `warmup.ts` compiled a pipeline
        // against it. Everything else is dequantised to float32 here on purpose
        // and comes back `normalized: false`; see `tile-decode.ts`'s header.
        const wantNormalized = attr.name === 'color' ? ref.normalized : false;
        if (wantNormalized !== attr.normalized) {
          failures.push(`primitive ${i} ${attr.name}: normalized ${wantNormalized} vs ${attr.normalized}`);
          break;
        }
        if (ref.array.length !== attr.array.length) {
          failures.push(`primitive ${i} ${attr.name}: length ${ref.array.length} vs ${attr.array.length}`);
          break;
        }
        // The reference is `GLTFLoader`'s **stored** column -- the file holds
        // quantised integers now, and `GLTFLoader` hands those back as they are
        // -- put through a second, deliberately separate implementation of the
        // unpacking. The fold into `_BLDIDX` is applied here too, so this
        // compares both halves of what the decode thread does.
        //
        // Bit-exact for everything except normals, and that is not slack: the
        // reference renormalises through a different intermediate from
        // `unpackNormals`, and two float64 routes to the same unit vector can
        // land a last bit apart in float32. A tenth of a degree is 1e-3; the
        // tolerance here is 1e-6.
        const bias = attr.name === BLDIDX_LOWER ? offset : 0;
        const expected = unpackReference(
          ref.array as ArrayLike<number>,
          attr.itemSize,
          extras.get(`${i}:${attr.name}`),
          attr.name === 'normal' && ref.normalized === true,
          bias,
        );
        const tolerance = attr.name === 'normal' ? 1e-6 : 0;
        for (let k = 0; k < expected.length; k++) {
          if (Math.abs(expected[k] - attr.array[k]) > tolerance) {
            failures.push(`primitive ${i} ${attr.name}[${k}]: ${expected[k]} vs ${attr.array[k]}`);
            break;
          }
        }
      }
      const wantIndex = want.getIndex();
      if (!wantIndex || wantIndex.count !== got.index.length) {
        failures.push(`primitive ${i}: index count ${wantIndex?.count} vs ${got.index.length}`);
        continue;
      }
      const wantIndexValues = unpackReference(
        wantIndex.array as ArrayLike<number>,
        1,
        extras.get(`${i}:index`),
        false,
        0,
      );
      for (let k = 0; k < got.index.length; k++) {
        if (wantIndexValues[k] !== got.index[k]) {
          failures.push(`primitive ${i} index[${k}]: ${wantIndexValues[k]} vs ${got.index[k]}`);
          break;
        }
      }
      want.dispose();
    }
    return failures;
  }

  /**
   * Prove that a tile crossing the worker boundary comes back unchanged.
   *
   * The other half of the regression net, and the half that is about the
   * *protocol* rather than the arithmetic: `decodeTilePayload` is one function
   * and both threads run it, so what can differ is the transfer list, the
   * structured clone and the shape of the reply. See `verifyDecoderRoundTrip`.
   */
  async verifyDecodeRoundTrip(request: TileDecodeRequest): Promise<string[]> {
    const copy = (buf: ArrayBuffer | null): ArrayBuffer | null => (buf === null ? null : buf.slice(0));
    const clone = (): TileDecodeRequest => ({
      ...request,
      glb: request.glb.slice(0),
      veg: copy(request.veg),
      power: copy(request.power),
      furn: copy(request.furn),
      pow: copy(request.pow),
      names: copy(request.names),
      water: copy(request.water),
    });
    return verifyDecoderRoundTrip(this.decoder, clone(), clone());
  }

  /**
   * Drop tiles that are out of range, or the furthest ones if over budget.
   *
   * Both paths hand `dispose` the camera, which is not tidiness: dropping a
   * tile's geometry is now also the moment its **collision** may go, and that
   * decision is a distance. See `dispose` and `setCollisionSink`.
   */
  private evict(cam: Vector3, keep: Set<string>): void {
    for (const [key, tile] of this.loaded) {
      if (!keep.has(key)) this.dispose(key, tile, cam);
    }
    // WORKSTREAM AJ: and the ground sheets, on one rule and only this one --
    // **a sheet lives exactly as long as its tile is wanted.** Not as long as
    // its tile is loaded, which is a different and shorter life: a sheet exists
    // for tiles whose geometry has not arrived, for tiles whose geometry never
    // will, and for tiles the budget below took back while they were still in
    // range. Every one of those is ground the player is standing on or looking
    // at, and `dispose` would take it from all three. See `dropGroundSheet` for
    // why the lease is not longer either.
    for (const key of [...this.groundSheets.keys()]) {
      if (!keep.has(key)) this.dropGroundSheet(key);
    }
    // The settled set outlives the sheets in exactly one direction, and that is
    // deliberate: a tile whose ground the build does not contain is settled with
    // no mesh, and that is permanent -- `TerrainField` will never fetch it
    // again. Forgetting it here would have the ground pass rediscover the same
    // 404 every time the player walked past. It cannot grow without bound in any
    // world that boots: the shipped build emits a `.terr.bin` for every one of
    // its 18,113 tiles, so this set holds nothing at all unless a publish went
    // wrong, which is the case it exists to survive rather than to hide.
    // Queued builds go the same way, and this is not merely tidiness: a teleport
    // moves the whole wanted set at once, and without this the queue would spend
    // the next several frames of its budget building tiles that are already four
    // kilometres behind the player -- delaying the ones under their feet by
    // exactly the time it took.
    for (const [key, job] of [...this.building]) {
      if (!keep.has(key)) this.cancelBuild(job);
    }
    if (this.loaded.size <= this.budget) return;

    // Furthest first -- `b - a` is descending, which is what makes the budget
    // path safe for the collision rule below: the tiles it takes are by
    // construction the ones the player is least near, so the distance test in
    // `dispose` is being asked about the far end of the set rather than a
    // random member of it.
    const byDistance = [...this.loaded.entries()].sort(
      (a, b) =>
        distanceToBounds(cam, b[1].entry.bounds) - distanceToBounds(cam, a[1].entry.bounds),
    );
    for (const [key, tile] of byDistance) {
      if (this.loaded.size <= this.budget) break;
      this.dispose(key, tile, cam);
    }
  }

  /**
   * Take one tile out of the scene -- and, if it is far enough away, take its
   * collision with it.
   *
   * The second clause is the fix for the amber-on-revisit case and it is the
   * one place in this client where prisms are removed. The rule, stated as the
   * invariant rather than as the code: *a tile has resident collision only
   * while its geometry is built, building, or the tile is inside the collision
   * working set.* Before this, collision had no upper end to its lifetime at
   * all and geometry did, so a return trip was guaranteed to find them
   * disagreeing.
   *
   * **The distance test is the safety argument, and it is deliberately not the
   * eviction's own radius.** `mayEvictCollision` is 1,000 m against the 420 m
   * ring `main.ts` re-fetches on, so the player would have to cross 580 m back
   * toward an evicted tile before a 9 kB request even starts, and another
   * 420 m before they could touch it. Geometry eviction only happens past
   * 1,800 m or to the furthest of a set bounded by it, so the test never
   * actually binds -- which is exactly why it is asserted rather than assumed.
   * A refusal is counted (`parityHolds`) precisely so that a future radius
   * change that makes it bind shows up as a number rather than as a bug report.
   */
  private dispose(key: string, tile: LoadedTile, cam: Vector3 | null = null): void {
    // **First**, before anything frees a buffer. The model fleet holds direct
    // references into this tile's parked-car instance matrices, and a claim
    // that outlived its mesh would write into a disposed buffer the next time
    // the car left the near field. See `world/carlod.ts` section 3.
    this.parkedCars?.release(key);
    // WORKSTREAM S. Order does not matter for this one -- it holds no buffer
    // reference -- but it is here beside its twin so the two lifecycles stay
    // visibly the same pair of calls.
    this.staticCars?.drop(key);
    this.root.remove(tile.group);
    // And the far layer takes the tile back. Paired with the line in `loadTile`;
    // between them a building is drawn by exactly one of the two systems at
    // every instant, including the instant of the swap.
    this.farCity?.setTileResident(key, false);
    releaseGroupGeometry(tile.group);
    // The icons go with the tile; their *state* does not. The sink keeps the
    // points so a respawn clock started before the eviction is the same clock
    // still running when the tile comes back -- see `PowerupField`.
    this.powerupSink?.release(key);
    // Its trees are going, so what grew under them goes too.
    this.mushroomSink?.release(key);
    // And the traffic. Unlike the powerups this releases *everything* the tile
    // contributed, because a lane graph carries no state: a car's position is a
    // pure function of the tick, so the identical cars reappear in the identical
    // places when the tile comes back. There is nothing to preserve across an
    // eviction and nothing that could get out of step while it is gone.
    this.traffic?.drop(key);
    // And the footpaths, on the same argument -- a walker is a function of the
    // tick, so there is nothing to preserve across an eviction. The one thing
    // that does survive is the knockdown registry, which is keyed by OSM way
    // rather than by tile precisely so that somebody you clobbered stays down
    // while the tile they are lying on streams out and back. See `PedDown`.
    this.pedestrians?.drop(key);
    // And the carriageways, on exactly the same argument: a road is a fact about
    // this tile's bytes and nothing about it survives the tile. Dropped rather
    // than kept because a deck nobody drops is a lid over a railway a thousand
    // metres behind the player -- and one the server, whose lane layer *does*
    // drop, would not have. See `RoadSink`.
    this.roadSink?.drop(key);
    this.atlas.release(key);
    this.loaded.delete(key);

    // And the prisms, last, once the tile is out of the scene in every other
    // sense -- so there is no window in which the collision is gone and the
    // geometry is still drawn, which would be the one direction of this that a
    // player could exploit.
    const sink = this.collisionSink;
    if (sink === null || !sink.hasTile(key)) return;
    // No camera means no distance and therefore no answer, so the safe reading
    // is "keep it". Only a caller outside `evict` can be in that position and
    // there is none today; the default exists so that a future one cannot drop
    // collision by omitting an argument.
    const far = cam !== null && mayEvictCollision(distanceToBounds(cam, tile.entry.bounds));
    if (far) {
      sink.removeTile(key);
      this.collisionEvictions++;
    } else {
      this.parityHolds++;
    }
  }
}

/**
 * Release every geometry a tile group owns, and nothing that is shared.
 *
 * One function for the two callers that must not disagree: `dispose`, for a
 * tile that streamed out, and the builder's `finally`, for a tile that was
 * abandoned half-built. A rule that lived in only one of them would leak the
 * *other* one's buffers, and a leak in the abandoned path is the one nobody
 * would find -- it happens on a teleport, which is a developer's key rather than
 * a player's.
 *
 * Geometry is per tile and must go; materials are shared world-wide and must
 * not. Disposing a shared material here would blank every other tile.
 *
 * Trees, cars and poles invert that: their *geometry* is the shared thing --
 * six tree meshes, five car bodies and two pole kinds for the whole world --
 * and what is per tile is the instance matrix and colour buffers, which is
 * exactly what `InstancedMesh.dispose` releases. Calling `geometry.dispose()`
 * on one would delete the species out of every other tile at once, and the
 * symptom would be trees, or every silver hatchback in the city, vanishing the
 * first time the player walked far enough to evict a tile.
 *
 * The *wires* are not in that set and must not be: their geometry is merged per
 * tile from that tile's own spans, so it falls to the default branch and is
 * released here. Their material is shared and is not touched, same as every
 * other material in this loop.
 */
function releaseGroupGeometry(group: Group): void {
  for (const child of group.children) {
    const mesh = child as Mesh;
    if (!mesh.isMesh) continue;
    if (
      mesh.userData.vegetation === true ||
      mesh.userData.cars === true ||
      mesh.userData.poles === true ||
      // Street furniture is in that set too: six geometries -- bin body, bin
      // lid, name post, blade, signal head, lamp -- shared by the whole world,
      // with the per-tile part being the instance buffers.
      mesh.userData.furniture === true ||
      // The ibises are in that set and not in the wires' one: their geometry
      // is the single shared bird mesh, so what is per tile is the instance
      // matrix and colour buffers -- exactly what `InstancedMesh.dispose`
      // releases. The gulls are in neither, because they are not in a tile.
      mesh.userData.birds === true ||
      // And spec 8.3's icons: two geometries -- the bolt and the cup -- shared
      // by the whole world, with the per-tile part being the instance
      // buffers. Disposing the geometry here would delete every station
      // marker in the city the first time a tile was evicted.
      mesh.userData.powerups === true ||
      // And the street lamps, on the poles' own terms: one glow geometry for
      // every luminaire in the city, with the per-tile part being the instance
      // matrix and the LED-or-sodium instance colour. Disposing it with a tile
      // would put out every street light in Sydney the first time the player
      // walked far enough to evict one.
      mesh.userData.nightlights === true ||
      // And the columns those lamps hang from where there is no pole. A separate
      // flag from `nightlights` because the *visibility* rules differ -- a
      // column is a physical object standing on the footpath at noon, where its
      // glow is switched off by `setNightLightsVisible` at dawn -- but the
      // release rule is identical: one shared geometry, per-tile instance
      // buffers. See `world/nightlights.buildTileColumnLamps`.
      mesh.userData.columns === true
    ) {
      (mesh as InstancedMesh).dispose();
    } else {
      mesh.geometry.dispose();
    }
  }
}

/**
 * One decoded primitive, wrapped in a `BufferGeometry`.
 *
 * The whole of what phase 3 has to do for the buildings, and it is deliberately
 * this cheap: the arrays came off the decode thread already built, already
 * offset, and already named the way TSL looks them up, so this allocates a few
 * wrapper objects and copies nothing at all.
 *
 * `_BLDIDX` is set **twice, under both spellings, sharing one attribute
 * object**, and that is not belt-and-braces. `GLTFLoader` lowercases custom
 * semantics, so the path this replaced reached the renderer with both names on
 * one buffer; three's `RenderObject.getGeometryCacheKey` walks
 * `Object.keys(geometry.attributes)`, so dropping the duplicate would change the
 * cache key and warm-up would have compiled a pipeline nothing draws -- putting
 * a shader compile back in the middle of a walk, which is the exact class of
 * hitch this change exists to remove. `warmup.warmupGeometry` sets both for the
 * same reason, and the two have to agree.
 */
function buildPrimitiveGeometry(prim: GlbPrimitive): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const attr of prim.attributes) {
    const buffer = new BufferAttribute(attr.array, attr.itemSize, attr.normalized);
    geometry.setAttribute(attr.name, buffer);
    if (attr.name === BLDIDX_LOWER) geometry.setAttribute('_BLDIDX', buffer);
  }
  geometry.setIndex(new BufferAttribute(prim.index, 1));
  return geometry;
}

/**
 * A decoder's answer, or null if it threw.
 *
 * The two sidecars still decoded on the render thread go through this, so they
 * keep the contract the other six have on the worker: a malformed sidecar is a
 * tile without that thing in it, never a tile that failed.
 */
function safeDecode<T>(run: () => T | null): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

/** Smallest value in a terrain grid. A loop, because `Math.min(...grid)` is a stack overflow at 289 posts and a real one at the far layer's size. */
function minOf(values: Float32Array): number {
  let lo = Infinity;
  for (const v of values) if (v < lo) lo = v;
  return lo === Infinity ? 0 : lo;
}

/** Largest value in a terrain grid. See `minOf`. */
function maxOf(values: Float32Array): number {
  let hi = -Infinity;
  for (const v of values) if (v > hi) hi = v;
  return hi === -Infinity ? 0 : hi;
}

/**
 * The vertex attributes a slot's primitives arrive with, for `warmupParts`.
 *
 * The authority is `pipeline/sydney/tiles.py`, which omits an attribute rather
 * than filling it with a constant -- "a column of zeroes over a million vertices
 * is a megabyte the player downloads to ignore" -- so the layouts genuinely
 * differ between slots and the difference is in the pipeline cache key.
 *
 * Three of them, and the split is the same one the constructor makes about
 * materials:
 *
 *   the eleven facade slots   position, normal, uv, and `_BLDIDX` -- the index
 *                             into the parameter atlas that only a building has
 *   streets, park, awning,    position, normal, uv. No building, so no atlas
 *   the three fences          fetch and no attribute to do it with
 *   the contact skirt         position and a baked colour ramp, and *no normal
 *                             and no uv at all*: it is drawn unlit, and those
 *                             twenty bytes a vertex are 16 MB over the inner ring
 *
 * The `_BLDIDX` test is written as "everything the constructor sends to
 * `createFacadeMaterial`" rather than as a list, so a new slot cannot be given
 * the facade material here and the plain layout there.
 */
function slotAttributes(slot: MaterialName): Parameters<typeof warmupGeometry>[0] {
  if (slot === 'contact_ao') return { colorU8x4: true };
  const plain =
    isStreetMaterial(slot) ||
    slot === 'park_grass' ||
    slot === 'bush_floor' ||
    slot === 'wetland_mud' ||
    slot === 'awning_fascia' ||
    slot === 'fence_masonry' ||
    slot === 'fence_iron' ||
    slot === 'fence_timber';
  return { normal: true, uv: true, buildingIndexed: !plain };
}

/**
 * Which material slot a decoded primitive belongs to.
 *
 * The name comes straight out of the GLB's material table now rather than off a
 * `MeshStandardMaterial` the loader built and this class immediately threw away.
 * The fallback is unchanged and is the important half: a slot this client does
 * not know draws as brick rather than not at all, because a world built by a
 * newer pipeline should look wrong in one material, not have holes in it.
 */
function resolveMaterialName(name: string): MaterialName {
  return (MATERIALS as readonly string[]).includes(name) ? (name as MaterialName) : 'brick_red';
}

/** Seconds between now and a scheduled retry, never negative. For the log line. */
function retryWaitSeconds(nextAt: number, now: number): number {
  return Math.max(0, nextAt - now) / 1000;
}

/**
 * One accessor's packing, keyed `<primitive>:<three attribute name>`, read
 * straight out of a tile's JSON chunk.
 *
 * `GLTFLoader` throws accessor `extras` away -- it keeps them only on nodes,
 * meshes and materials -- and the packing lives there, so `verifyTileGlbParse`
 * cannot get at it through the loader it is comparing against. Twelve lines of
 * chunk-walking gets it, and getting it is what turns that comparison from "the
 * two parsers read the same integers" back into "the two parsers produce the
 * same geometry", which is the claim that matters.
 */
function readAccessorExtras(buffer: ArrayBuffer): Map<string, PackReference | undefined> {
  const out = new Map<string, PackReference | undefined>();
  try {
    const head = new DataView(buffer);
    let at = 12;
    let json: {
      accessors?: Array<{ extras?: PackReference }>;
      meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number }> }>;
    } | null = null;
    while (at + 8 <= buffer.byteLength && json === null) {
      const length = head.getUint32(at, true);
      const type = head.getUint32(at + 4, true);
      if (type === 0x4e4f534a) {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, at + 8, length)));
      }
      at += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json) return out;
    let primitive = 0;
    for (const mesh of json.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) {
        for (const [semantic, index] of Object.entries(prim.attributes ?? {})) {
          const name = TILE_SEMANTIC_NAMES[semantic] ?? semantic.toLowerCase();
          out.set(`${primitive}:${name}`, json.accessors?.[index]?.extras);
        }
        if (prim.indices !== undefined) {
          out.set(`${primitive}:index`, json.accessors?.[prim.indices]?.extras);
        }
        primitive++;
      }
    }
  } catch {
    // A tile whose JSON will not parse is a tile `parseTileGlb` has already
    // thrown on, so the caller is not going to reach this comparison.
  }
  return out;
}

/** `GLTFLoader.ATTRIBUTES`, for the check's own reading of the JSON chunk. */
const TILE_SEMANTIC_NAMES: Record<string, string> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TEXCOORD_0: 'uv',
  COLOR_0: 'color',
};

/** What `pipeline/sydney/meshpack.py` writes into an accessor's `extras`. */
interface PackReference {
  q?: number[];
  d?: number;
  i?: number;
}

/**
 * Undo the packing, written out longhand, for `verifyTileGlbParse` only.
 *
 * **A deliberate second implementation**, and the whole value of the check is
 * that it is one: `tile-decode.ts`'s version is three specialised loops tuned
 * for a pass over every vertex in the city, and a check that shared them would
 * prove only that the code equals itself. This is the format as
 * `meshpack.unpack` states it, one component at a time, with no fast path.
 */
function unpackReference(
  raw: ArrayLike<number>,
  components: number,
  extras: PackReference | undefined,
  isNormal: boolean,
  bias: number,
): Float64Array {
  const out = new Float64Array(raw.length);
  const values = new Float64Array(raw.length);
  const delta = extras?.d === 1;
  const wide = raw instanceof Uint32Array;
  const acc = new Float64Array(components);
  for (let i = 0; i < raw.length; i += components) {
    for (let c = 0; c < components; c++) {
      acc[c] = delta
        ? wide
          ? (acc[c] + raw[i + c]) >>> 0
          : (acc[c] + raw[i + c]) & 0xffff
        : raw[i + c];
      values[i + c] = acc[c];
    }
  }
  if (extras?.q) {
    for (let i = 0; i < raw.length; i += components) {
      for (let c = 0; c < components; c++) {
        out[i + c] = Math.fround(
          values[i + c] * extras.q[components + c] + extras.q[c] + bias,
        );
      }
    }
    return out;
  }
  if (isNormal) {
    for (let i = 0; i < raw.length; i += 3) {
      const x = values[i] / 127;
      const y = values[i + 1] / 127;
      const z = values[i + 2] / 127;
      const len = Math.hypot(x, y, z);
      if (len > 0) {
        out[i] = Math.fround(x / len);
        out[i + 1] = Math.fround(y / len);
        out[i + 2] = Math.fround(z / len);
      }
    }
    return out;
  }
  for (let i = 0; i < raw.length; i++) out[i] = Math.fround(values[i] + bias);
  return out;
}

/** Distance from a point to an axis-aligned XZ box, zero if inside. */
function distanceToBounds(p: Vector3, b: [number, number, number, number]): number {
  const dx = Math.max(b[0] - p.x, 0, p.x - b[2]);
  const dz = Math.max(b[1] - p.z, 0, p.z - b[3]);
  return Math.hypot(dx, dz);
}

/**
 * How far from the player the sun's shadow map can still put a shadow on the
 * ground, metres. Exported so a self-check -- or a reader who does not believe
 * the number -- can evaluate it.
 *
 * The shadow camera is an orthographic box of half-extent `radius` in the
 * *light's* frame, looking down the sun vector. Take the light basis `sky.ts`
 * builds: `right` horizontal and across the sun's bearing, `up` = sun x right,
 * which has a horizontal part of magnitude `sin(altitude)` along the bearing and
 * a vertical part of `cos(altitude)`. A ground point offset `a` across the
 * bearing and `b` along it projects to `a` on the right axis and `-b*sin(alt)`
 * on the up axis, so the box's footprint on the ground is
 *
 *     |a| <= radius              and       |b| <= radius / sin(altitude)
 *
 * -- a rectangle, not a circle, and one that grows without bound as the sun
 * drops. `distanceToBounds` is a plain Euclidean distance, so what it has to be
 * compared against is that rectangle's *corner*:
 *
 *     radius * hypot(1, 1 / sin(altitude))
 *
 * At radius 220 that is 311 m with the sun overhead (the box's own diagonal, and
 * the smallest this can ever be), 342 m at the reference 3 pm, 381 m at 45
 * degrees, 492 m at 30, and 680 m at the 20-degree floor, where it is capped.
 * Below the floor -- and at night, where `sin` goes negative and this would
 * otherwise return nonsense -- it holds at the floor's value.
 */
export function sunReceiveRange(radius: number, altitudeDeg: number): number {
  const sin = Math.sin((Math.max(altitudeDeg, RECEIVE_ALTITUDE_FLOOR_DEG) * Math.PI) / 180);
  return radius * Math.hypot(1, 1 / sin);
}
