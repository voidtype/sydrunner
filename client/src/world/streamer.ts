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
 */

import {
  Box3,
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
  decodeFurniture,
  type TileFurniture,
} from './furniture.ts';
import { createGroundMaterial } from './ground.ts';
import {
  PowerupAssets,
  PowerupIcons,
  decodePowerups,
  type PowerupDrawState,
  type PowerupSink,
} from './powerups.ts';
import { FacadeParamsAtlas, offsetBuildingIndices } from './params-atlas.ts';
import {
  PowerAssets,
  buildTilePoles,
  buildTileWires,
  decodePower,
  type TilePower,
} from './power.ts';
import { createStreetMaterial } from './street.ts';
import {
  decodeStreetNames,
  translateStreetNames,
  type NamedSegment,
  type TileStreetNames,
} from './streetnames.ts';
import { fetchWorldAsset, fetchWorldBuffer } from './cdn.ts';
import { TerrainField, buildTerrainMesh, sampleTileGrid } from './terrain.ts';
import { worldVersionSuffix } from './version.ts';
import {
  buildWaterMeshes,
  createWaterClock,
  createWaterMaterial,
  decodeWater,
  waterPlanWorld,
  type TileWater,
  type WaterContract,
} from './water.ts';
import { warmupGeometry, type WarmupPart } from './warmup.ts';
import {
  VegetationAssets,
  buildTileTrees,
  createParkGrassMaterial,
  decodeVegetation,
  type TileVegetation,
} from './vegetation.ts';

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

interface LoadedTile {
  entry: TileEntry;
  group: Group;
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
}

export class TileStreamer {
  readonly root = new Group();

  private index: WorldIndex | null = null;
  private readonly loaded = new Map<string, LoadedTile>();
  private readonly loading = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly loader = new GLTFLoader();
  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();

  private readonly loadRadius: number;
  private readonly concurrency: number;
  private readonly budget: number;
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
   * The far city, or null before `main.ts` supplies one -- and null is a working
   * configuration, not a broken one: it means every slab draws always, which is
   * exactly what this world did before the far layer had a residency rule. See
   * `setFarCity`.
   */
  private farCity: FarCity | null = null;
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

  constructor(
    scene: Scene,
    globals: FacadeGlobals,
    opts: StreamerOptions = {},
  ) {
    this.loadRadius = opts.loadRadius ?? 1800;
    this.concurrency = opts.concurrency ?? 4;
    this.budget = opts.budget ?? 220;
    this.baseUrl = opts.baseUrl ?? '/world';
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
   * Hand the streamer whoever owns spec 8.3's powerup state.
   *
   * A setter, and for a stronger reason than `setSpawnGuard`'s: the sink
   * outlives every tile it is told about, so it cannot be constructed *from*
   * one, and the streamer must not own it. Without a sink the icons are still
   * built and still spin -- they are simply always present, which is the right
   * behaviour for a world with no game in it and is what makes the tile loader
   * testable on its own.
   */
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
    for (const key of this.loaded.keys()) city.setTileResident(key, true);
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

    // The terrain mesh, which wears the same material as the far ground and is
    // the only other thing `buildTerrainMesh` produces.
    parts.push({
      geometry: warmupGeometry({ normal: true, uv: true }),
      owned: true,
      material: this.groundMaterial,
      casts: false,
      receives: [true],
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

    // The instanced populations, with their real shared geometry -- so these
    // cannot drift out of layout even if the builders change.
    parts.push({ geometry: this.vegetation.geometry(0), material: this.vegetation.material, instanced: true });
    parts.push({ geometry: this.carAssets.geometry(0), material: this.carAssets.material, instanced: true });
    parts.push({ geometry: this.powerAssets.geometry(0), material: this.powerAssets.poleMaterial, instanced: true });
    // The wires are merged per tile rather than instanced, carry position and
    // nothing else, and are unlit and out of the depth pass entirely.
    parts.push({
      geometry: warmupGeometry({}),
      owned: true,
      material: this.powerAssets.wireMaterial,
      casts: false,
      receives: [false],
    });

    const furniture = this.furnitureAssets;
    for (const geometry of [furniture.binBody, furniture.binLid, furniture.namePost, furniture.signal]) {
      parts.push({ geometry, material: furniture.propMaterial, instanced: true });
    }
    // Both blade styles, and neither carries per-instance colour: `furniture.ts`
    // gives the two styles two materials precisely because `instanceColor` can
    // only multiply and the styles invert each other.
    for (const material of furniture.bladeMaterial) {
      parts.push({ geometry: furniture.blade, material, instanced: true, instanceColor: false });
    }
    parts.push({
      geometry: furniture.lamp,
      material: furniture.lampMaterial,
      instanced: true,
      casts: false,
      receives: [false],
    });
    // One street-name legend, which is enough for all of them: every legend is
    // its own material and its own canvas texture, but they generate identical
    // WGSL, so the shader module and the pipeline are shared and only the
    // binding differs. The cache evicts this on its own clock like any other.
    const legend = furniture.labels.acquire('Warm Up', 0);
    if (legend) {
      parts.push({
        geometry: furniture.bladeLabel,
        material: legend,
        casts: false,
        receives: [false],
      });
    }

    parts.push({ geometry: this.birdAssets.ibis, material: this.birdAssets.material, instanced: true });

    // Spec 8.3's icons: three passes over one geometry, none of them in the
    // depth map -- see `powerups.ts`'s `instanced`.
    for (const material of [
      this.powerupAssets.solidMaterial,
      this.powerupAssets.shellMaterial,
      this.powerupAssets.ghostMaterial,
    ]) {
      parts.push({
        geometry: this.powerupAssets.bolt,
        material,
        instanced: true,
        casts: false,
        receives: [false],
      });
    }

    return parts;
  }

  async loadIndex(): Promise<WorldIndex> {
    const resp = await fetch(`${this.baseUrl}/index.json`);
    if (!resp.ok) {
      throw new Error(
        `No world index at ${this.baseUrl}/index.json (${resp.status}). ` +
          `Run the pipeline first: cd pipeline && uv run python -m sydney build --stage inner`,
      );
    }
    this.index = (await resp.json()) as WorldIndex;
    // Before anything else is fetched, because everything else is fetched
    // *with* it. The index itself deliberately carries no suffix -- it is what
    // names the version, so it cannot be cached behind one.
    this.version = worldVersionSuffix(this.index);
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
      failed: this.failed.size,
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
  update(
    camera: Camera,
    shadowVolume: Frustum | null = null,
    sunAltitudeDeg: number = REFERENCE_ALTITUDE_DEG,
  ): void {
    if (!this.index) return;

    // Cheap enough to redo unconditionally -- two trig calls a frame against a
    // linear pass over a few thousand tile entries below it.
    this.receiveRange = sunReceiveRange(this.shadowRadius, sunAltitudeDeg);

    const cam = camera.position;
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

    for (const { entry, dist } of wanted) {
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
        tile.group.visible =
          this.frustum.intersectsBox(tile.box) ||
          (tile.casts && shadowVolume !== null && shadowVolume.intersectsBox(tile.box));
        continue;
      }
      if (
        this.loading.size < this.concurrency &&
        !this.loading.has(entry.key) &&
        !this.failed.has(entry.key)
      ) {
        void this.loadTile(entry);
      }
    }

    this.evict(cam, new Set(wanted.map((w) => w.entry.key)));
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

  private async loadTile(entry: TileEntry): Promise<void> {
    this.loading.add(entry.key);
    try {
      // The terrain grid is fetched here, alongside everything else, and that
      // ordering is the whole answer to a question that could have been a
      // lifecycle: trees and parked cars need to know where the ground is before
      // they can be placed on it, and nothing in this tile is built until all
      // five requests have landed. No placement can run early, so none has to be
      // corrected later.
      const [gltf, paramsBuffer, terrain, veg, parked, lines, props, picks, named, water, lanes] =
        await Promise.all([
          // Bytes first, then parse, because the bytes may arrive gzipped from
          // the release CDN and `loadAsync` would fetch them itself. The tiles
          // are self-contained GLB, so the parser needs no resource path.
          fetchWorldBuffer(this.baseUrl, `tiles/${entry.key}.glb`, this.version).then((buf) =>
            this.loader.parseAsync(buf, ''),
          ),
          fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.params.bin`, this.version).then((r) => {
            if (!r.ok) throw new Error(`params ${r.status}`);
            return r.arrayBuffer();
          }),
          this.terrainField ? this.terrainField.ensure(entry.key) : Promise.resolve(null),
          this.loadVegetation(entry),
          this.loadCars(entry),
          this.loadPower(entry),
          this.loadFurniture(entry),
          this.loadPowerups(entry),
          this.loadStreetNames(entry),
          this.loadWater(entry),
          this.loadLanes(entry),
        ]);

      const offset = this.atlas.allocate(entry.key, new Float32Array(paramsBuffer));
      if (offset === null) {
        // Atlas full. Not fatal and not permanent -- eviction frees rows, so this
        // tile is left unloaded and retried on a later frame.
        return;
      }

      const group = new Group();
      group.name = entry.key;

      const tileSize = this.index!.tile_size;
      const [minX, minZ] = entry.bounds;
      // Tile geometry is tile-local; its world offset is a node translation, which
      // is what keeps float32 vertex precision constant across the whole extent.
      group.position.set(minX, 0, minZ + tileSize);

      // The ground first, so it is the first thing drawn and the thing every
      // other primitive in the tile was placed against. Its heights are already
      // baked into the pipeline's geometry -- walls, roads and grass all arrive
      // draped -- so this is the only piece of the tile the client positions
      // vertically at all.
      const groundAt =
        terrain === null
          ? (): number => 0
          : (x: number, z: number): number =>
              sampleTileGrid(terrain, this.terrain.grid, tileSize, x, z);
      if (terrain !== null) {
        group.add(buildTerrainMesh(terrain, this.terrain.grid, tileSize, this.groundMaterial));
      }

      // And the water over it, second, for the same reason the ground is first:
      // it is the other half of the surface, it was cut against exactly this
      // tile's terrain by the pipeline, and everything else in the tile stands
      // on one or the other. Tile-local like the ground, so it inherits the
      // group's translation; the surface height in it is absolute, so it does
      // not.
      let waterTriangles = 0;
      let waterPlan: Float32Array | null = null;
      if (water !== null) {
        for (const mesh of buildWaterMeshes(water, this.waterMaterial)) group.add(mesh);
        waterTriangles = water.triangles;
        waterPlan = waterPlanWorld(water, minX, minZ + tileSize);
      }

      // Collect first, reparent after. Reparenting inside `traverse` mutates the
      // children array that traverse is indexing, which walks it off the end.
      const meshes: Mesh[] = [];
      gltf.scene.traverse((node) => {
        const mesh = node as Mesh;
        if (mesh.isMesh) meshes.push(mesh);
      });

      // The awning fascia, kept as it goes past. It is the only primitive in the
      // build that marks a retail strip exactly, and its vertices are already
      // standing over the footpath -- so it is what spec 7.7's "near bins" turns
      // into without a bin existing anywhere. Read here rather than re-fetched:
      // the buffer is in memory for this one loop and nothing else wants it.
      let awningPositions: Float32Array | null = null;
      let awningTriangles = 0;

      for (const mesh of meshes) {
        // A no-op on ground-surface primitives, which carry no `_BLDIDX` at all.
        normaliseBuildingIndexAttribute(mesh, offset);
        const slot = resolveMaterialName(mesh);
        const surface = isSurfaceMaterial(slot);
        if (slot === 'awning_fascia') {
          const attr = mesh.geometry.getAttribute('position');
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
          awningTriangles += (mesh.geometry.getIndex()?.count ?? 0) / 3;
        }
        mesh.material = this.materials.get(slot)!;
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
      }

      // Trees, from the sidecar. Added to the tile's own group so they inherit
      // its world translation and are hidden, shadowed and disposed with it --
      // there is no separate vegetation lifecycle to keep in step, which is the
      // one way this could have leaked geometry across a stream-out.
      let trees = 0;
      if (veg !== null) {
        for (const mesh of buildTileTrees(veg, this.vegetation, groundAt)) {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          group.add(mesh);
        }
        trees = veg.count;
      }

      // Parked cars, from their own sidecar, on exactly the same terms as the
      // trees: added to the tile's group so they inherit its translation and are
      // hidden, shadowed and disposed with it. A car casts and does not receive
      // at load time -- it is 1.5 m tall and standing on the road the shadow
      // lands on, so it is a caster of precisely the kind the rig was sized for,
      // and the shadow it throws across the footpath is worth more than the one
      // it catches.
      let cars = 0;
      if (parked !== null) {
        for (const mesh of buildTileCars(parked, this.carAssets, groundAt)) {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          group.add(mesh);
        }
        cars = parked.count;
      }

      // Power poles and the wires between them, again on the tile's own group.
      // Poles need no `groundAt`: unlike a tree or a car, a pole carries its own
      // terrain height in the sidecar, because the wire leaving it may be
      // anchored from a pole in the next tile and both ends have to have been
      // measured by the same code against the same ground.
      let poles = 0;
      let spans = 0;
      if (lines !== null) {
        for (const mesh of buildTilePoles(lines, this.powerAssets)) {
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
        poles = lines.poleCount;
        spans = lines.wireCount;
      }

      // Street furniture, on the tile's own group again and needing no
      // `groundAt` for the same reason the poles do not: the sidecar carries an
      // absolute height per instance. Unlike a pole it is the height of the
      // *paving* rather than of the terrain -- the pipeline has already added
      // the footpath's 15 cm, because a bin stands on the concrete where a pole
      // is set into a hole through it.
      //
      // Bins, posts and signal heads all cast and none receives, which is the
      // same call `cars.ts` gets and for the same reason: a 1.07 m bin on an
      // unbroken concrete surface throws the only shadow that surface has, and
      // the one it would catch is worth much less. The lit lamps are the
      // exception in the other direction and carry `userData.noShadow`.
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
      }

      // The named centrelines, lifted into world metres by the same translation
      // and for the same reason as the legends above them: the query that reads
      // them spans several tiles at once. Nothing is built and nothing is added
      // to the group -- this payload draws nothing at all, and its only lifecycle
      // is that it is dropped when the tile is. See `world/streetnames.ts`.
      if (named !== null) {
        translateStreetNames(named, group.position.x, group.position.z);
      }

      // Spec 8.3's powerups. The one streamed thing in the build whose *state*
      // does not belong to the tile: the icons go on the tile's group and are
      // disposed with it, but the "taken, back in 74 s" lives in the sink and
      // survives an eviction, which is what stops walking a block and back
      // resetting every respawn in the suburb.
      //
      // The sink is handed world metres rather than the tile-local ones in the
      // sidecar, because a powerup is tested against a player position that is
      // world-space and the conversion has to happen exactly once. It happens
      // here, where the tile's origin is already in hand.
      let powerupIcons: PowerupIcons | null = null;
      let powerupStates: readonly PowerupDrawState[] = [];
      if (picks !== null) {
        powerupIcons = new PowerupIcons(picks, this.powerupAssets);
        for (const mesh of powerupIcons.meshes) group.add(mesh);
        if (this.powerupSink !== null) {
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
          // Without it a tile re-streaming next to a powerup somebody took
          // twenty seconds ago shows it present for exactly one frame, which is
          // a flicker with no cause a player could work out.
          powerupIcons.update(powerupStates, 0);
        }
      }

      // The lane graph, and the cars driving it. Nothing is built and nothing is
      // added to the group -- like `.names.bin` this payload draws no geometry
      // of its own, and unlike `.names.bin` what it describes is not even in
      // this tile. A route belongs to the tile holding its *first* point and
      // runs up to 800 m out of it, and the fleet is drawn as one instanced set
      // for the whole visible world rather than per tile, because a car crosses
      // a seam every few seconds. So the field is simply told, and it is told in
      // world metres -- `decodeLanes` folded the group's translation in at
      // decode, which is the one place that conversion can happen exactly once.
      // ...and the people walking beside them, off the *same* decoded payload.
      // The routes block is the traffic and the ways block is the footpath
      // network; one fetch, one decode, two consumers, and no second sidecar --
      // which is what `tiles.write_lanes` designed the ways block for. See
      // `game/pedestrians.buildBands`, which derives the bands here rather than
      // holding the ways, because a band is what a walker is scheduled along.
      if (lanes !== null) {
        this.traffic?.adopt(entry.key, lanes);
        this.pedestrians?.adopt(entry.key, lanes);
      }

      // Ibises, derived from two things that are already in hand: the tree
      // sidecar decoded above, and the awning geometry collected on the way
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
      // They get a different ground function from the trees and the cars, and
      // it is the one thing about them that is not a copy of how those work. A
      // tree stands where the pipeline put it and never moves, so the tile's own
      // clamped grid answers it exactly. A bird spawns up to 12 m from its fig
      // and then runs 8-15 m from the player, so it routinely ends up over the
      // *next* tile -- where `sampleTileGrid` clamps to the edge post and
      // extends it flat, and the bird floats or sinks by the local gradient
      // times however far it strayed. On Crown Street that is two and a half
      // metres. The field query is the same one the player walks on and is
      // correct across a seam; it falls back to the tile grid only where the
      // neighbour has not loaded, which is a tile the bird cannot be seen from.
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

      if (group.children.length === 0) {
        this.atlas.release(entry.key);
        this.failed.set(entry.key, Date.now());
        return;
      }

      this.root.add(group);
      // Vertical extent of the tile's ground, from the grid itself rather than
      // from the index -- it is loaded either way, and the index rounds. Since
      // terrain arrived this is no longer a band around zero: a tile on the
      // Surry Hills ridge sits 40 m above one in Alexandria, and a box that
      // still assumed y = 0 would cull half the city the moment the player
      // walked downhill.
      let groundLo = 0;
      let groundHi = 0;
      if (terrain !== null) {
        groundLo = Infinity;
        groundHi = -Infinity;
        for (const h of terrain) {
          if (h < groundLo) groundLo = h;
          if (h > groundHi) groundHi = h;
        }
      }
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
      // The far layer's half of the same event. Here rather than a frame later
      // in `update`, and *after* `root.add(group)` rather than before it, so the
      // slabs go the moment the real buildings are in the scene and not one
      // frame either side of it -- a frame with neither is a hole in the city,
      // and a frame with both is a flat box in front of a facade.
      this.farCity?.setTileResident(entry.key, true);
      this.loaded.set(entry.key, {
        entry,
        group,
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
        bins,
        posts,
        signals,
        bladeLabels,
        streets: named,
        birds,
        powerups: powerupIcons,
        powerupStates,
      });
    } catch (err) {
      // A missing or corrupt tile must not stall the stream; record it and move
      // on, and let a later run of the pipeline fix it.
      this.failed.set(entry.key, Date.now());
      if (this.failed.size < 6) console.warn(`tile ${entry.key} failed:`, err);
    } finally {
      this.loading.delete(entry.key);
    }
  }

  /**
   * Fetch and decode one tile's trees.
   *
   * Never throws and never fails the tile. A missing, truncated or malformed
   * sidecar means a tile with no trees in it, which is a tile -- the world is
   * older than the vegetation pass and an index or a tile directory from before
   * it must still load. That is also why the index's `v` is consulted first:
   * the request is skipped entirely for a tile the pipeline said has none, so
   * the common case costs nothing at all rather than a 404.
   */
  private async loadVegetation(entry: TileEntry): Promise<TileVegetation | null> {
    if (!entry.v) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.veg.bin`, this.version);
      if (!resp.ok) return null;
      return decodeVegetation(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's parked cars. Same contract as
   * `loadVegetation`, down to the reason: never throws, never fails the tile,
   * and skipped entirely when the index says the tile has none.
   */
  private async loadCars(entry: TileEntry): Promise<TileCars | null> {
    if (!entry.c) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.cars.bin`, this.version);
      if (!resp.ok) return null;
      return decodeCars(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's power poles and wire spans. Same contract as
   * the two above, with one difference that matters: the fetch test is the
   * *union* of the two counts, not the poles alone. A span is filed under the
   * tile containing its midpoint, so a tile can own spans with both their poles
   * next door -- testing `p` on its own drops a wire at a seam, silently, and
   * only on the tiles where a street crosses a tile line.
   */
  private async loadPower(entry: TileEntry): Promise<TilePower | null> {
    if (!entry.p && !entry.w) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.power.bin`, this.version);
      if (!resp.ok) return null;
      return decodePower(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's street furniture. Same contract as the three
   * above: never throws, never fails the tile, skipped entirely when the index
   * says the tile has none.
   *
   * The test is the union of all three counts, like `loadPower`'s but with a
   * different reason behind it. Nothing here crosses a tile seam -- every bin,
   * post and head is filed under the tile it stands in -- so this is simply one
   * file holding three independent blocks, and a tile that has only signals must
   * still fetch it.
   */
  private async loadFurniture(entry: TileEntry): Promise<TileFurniture | null> {
    if (!entry.fb && !entry.fp && !entry.fs) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.furn.bin`, this.version);
      if (!resp.ok) return null;
      return decodeFurniture(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's powerups. Same contract as the four above --
   * never throws, never fails the tile, skipped entirely when the index says
   * the tile has none, which is 100 of the inner ring's 221.
   */
  private async loadPowerups(entry: TileEntry): Promise<ReturnType<typeof decodePowerups>> {
    if (!entry.pw) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.pow.bin`, this.version);
      if (!resp.ok) return null;
      return decodePowerups(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's named street centrelines. Same contract as the
   * five above -- never throws, never fails the tile, skipped entirely when the
   * index says the tile has none.
   *
   * The one difference is which way the common case falls. Every other sidecar
   * here is absent from most tiles and the index test is what saves the 404;
   * this one is present on nearly all of them, because a tile with no named
   * street on it is a park or the harbour. The test still earns its place on
   * those, and on an index written before this sidecar existed -- where `sn` is
   * absent everywhere and the whole feature quietly does not exist rather than
   * 404ing 221 times.
   */
  private async loadStreetNames(entry: TileEntry): Promise<TileStreetNames | null> {
    if (!entry.sn) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.names.bin`, this.version);
      if (!resp.ok) return null;
      return decodeStreetNames(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's lane graph. Same contract as the six above:
   * never throws, never fails the tile, skipped entirely when the index says the
   * tile has none -- and skipped outright when nothing is listening, so a world
   * with no traffic in it costs no requests at all.
   *
   * The one thing done here that no other loader does is apply the tile's world
   * translation, and it is done here on purpose. Every other sidecar's contents
   * go on the tile's group and inherit it; a route does not belong to a group at
   * all -- it runs out of its own tile and its cars are drawn in one set for the
   * whole world -- so the conversion has to happen exactly once, and this is the
   * only place that has both the bytes and the origin.
   */
  private async loadLanes(entry: TileEntry): Promise<ReturnType<typeof decodeLanes>> {
    // Two listeners now, and the test is the union: a world with pedestrians and
    // no traffic must still fetch this, which is what a build made before the
    // traffic pass would be.
    if (this.traffic === null && this.pedestrians === null) return null;
    if (!entry.lw && !entry.lr) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.lanes.bin`, this.version);
      if (!resp.ok) return null;
      const tileSize = this.index?.tile_size ?? 500;
      return decodeLanes(
        await resp.arrayBuffer(),
        entry.bounds[0],
        entry.bounds[1] + tileSize,
      );
    } catch {
      return null;
    }
  }

  /**
   * Fetch and decode one tile's water surface. Same contract as the six above:
   * never throws, never fails the tile, skipped entirely when the index says the
   * tile has none -- which is 213 of the inner ring's 221, since only the tiles
   * on the harbour and the two with a pond in them carry any.
   *
   * A tile that loses its water is a tile that draws none: the far sheet is
   * still under it, so the failure mode is the harbour at 35 cm lower and one
   * tile's worth of shoreline detail, not a hole.
   */
  private async loadWater(entry: TileEntry): Promise<TileWater | null> {
    if (!entry.wv) return null;
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${entry.key}.water.bin`, this.version);
      if (!resp.ok) return null;
      return decodeWater(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Drop tiles that are out of range, or the furthest ones if over budget. */
  private evict(cam: Vector3, keep: Set<string>): void {
    for (const [key, tile] of this.loaded) {
      if (!keep.has(key)) this.dispose(key, tile);
    }
    if (this.loaded.size <= this.budget) return;

    const byDistance = [...this.loaded.entries()].sort(
      (a, b) =>
        distanceToBounds(cam, b[1].entry.bounds) - distanceToBounds(cam, a[1].entry.bounds),
    );
    for (const [key, tile] of byDistance) {
      if (this.loaded.size <= this.budget) break;
      this.dispose(key, tile);
    }
  }

  private dispose(key: string, tile: LoadedTile): void {
    this.root.remove(tile.group);
    // And the far layer takes the tile back. Paired with the line in `loadTile`;
    // between them a building is drawn by exactly one of the two systems at
    // every instant, including the instant of the swap.
    this.farCity?.setTileResident(key, false);
    // Geometry is per tile and must go; materials are shared world-wide and must
    // not. Disposing a shared material here would blank every other tile.
    //
    // Trees, cars and poles invert that: their *geometry* is the shared thing --
    // six tree meshes, five car bodies and two pole kinds for the whole world --
    // and what is per tile is the instance matrix and colour buffers, which is
    // exactly what `InstancedMesh.dispose` releases. Calling `geometry.dispose()`
    // on one would delete the species out of every other tile at once, and the
    // symptom would be trees, or every silver hatchback in the city, vanishing
    // the first time the player walked far enough to evict a tile.
    //
    // The *wires* are not in that set and must not be: their geometry is merged
    // per tile from that tile's own spans, so it falls to the default branch and
    // is released here. Their material is shared and is not touched, same as
    // every other material in this loop.
    for (const child of tile.group.children) {
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
        mesh.userData.powerups === true
      ) {
        (mesh as InstancedMesh).dispose();
      } else {
        mesh.geometry.dispose();
      }
    }
    // The icons go with the tile; their *state* does not. The sink keeps the
    // points so a respawn clock started before the eviction is the same clock
    // still running when the tile comes back -- see `PowerupField`.
    this.powerupSink?.release(key);
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
    this.atlas.release(key);
    this.loaded.delete(key);
  }
}

/**
 * GLTFLoader lowercases vertex attribute names it does not recognise, so the
 * pipeline's `_BLDIDX` arrives as `_bldidx`. TSL looks it up by the name the
 * shader asks for, so alias it back.
 */
function normaliseBuildingIndexAttribute(mesh: Mesh, atlasOffset: number): void {
  const attrs = mesh.geometry.attributes as Record<string, unknown>;
  let name = attrs._BLDIDX ? '_BLDIDX' : Object.keys(attrs).find((k) => k.toLowerCase() === '_bldidx');
  if (!name) return;
  const attr = mesh.geometry.getAttribute(name);
  // Fold the tile's atlas row offset into the attribute, so the shader indexes
  // the shared parameter texture directly with no per-tile uniform.
  offsetBuildingIndices(attr.array as Float32Array, atlasOffset);
  if (name !== '_BLDIDX') mesh.geometry.setAttribute('_BLDIDX', attr);
  attr.needsUpdate = true;
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
    slot === 'awning_fascia' ||
    slot === 'fence_masonry' ||
    slot === 'fence_iron' ||
    slot === 'fence_timber';
  return { normal: true, uv: true, buildingIndexed: !plain };
}

/** Which material slot a loaded primitive belongs to. */
function resolveMaterialName(mesh: Mesh): MaterialName {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const name = (mat?.name ?? '') as MaterialName;
  return (MATERIALS as readonly string[]).includes(name) ? name : 'brick_red';
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
