/**
 * Real cars, in the near field.
 *
 * `world/cars.ts` draws every car in Sydney as a lofted box -- 102 to 110
 * triangles, five silhouettes, and the whole argument for it is in that file's
 * header: at twenty metres a hatch with no boot and a ute with a tray is enough,
 * and the inner ring carries 23,020 of them. That argument is still true and
 * this file does not touch it. What it adds is the other end of the curve: the
 * dozen or so cars a player is actually *standing next to*, where a box is a box.
 *
 * So this is a LOD swap, and the three hard parts of one are identity, hysteresis
 * and suppression.
 *
 * ---------------------------------------------------------------------------
 * 1. IDENTITY, and why the model cannot be chosen where the car is drawn.
 *
 * A car in this world is not an object. It is a *lookup* -- `poseCar(route,
 * slot, now)` for the schedule fleet and a row of a `.cars.bin` for the parked
 * one -- evaluated fresh every frame, in every process, with nothing stored
 * anywhere between two evaluations. There is no field on a car to hang a model
 * choice off, and there is no moment at which a car is "created" and could be
 * given one.
 *
 * `CarPose.identity` and `staticCarIdentity` exist for exactly this. Both are
 * stable 32-bit hashes that never change across a car's life, are the same
 * number in every process, and survive a world rebuild -- `game/traffic.ts`
 * argues all three at length. So the model is
 *
 *     pool[identity % pool.length]
 *
 * over the manifest's own order, and that is the whole of the rule. Its three
 * consequences are the reason it is written this way rather than as a counter or
 * a round-robin over free instances:
 *
 *   - the same car is the same model in every stage of its life, so the thing
 *     that pulls out of a bay is the thing that pulls into the far one;
 *   - the same car is the same model for every observer, with no byte on the
 *     wire, because both sides are hashing the same number;
 *   - the same car is the same model *after it has been released and claimed
 *     again*, which is what stops a car you walked past twice being a hatch and
 *     then a ute.
 *
 * The manifest's file order is therefore a contract and not a convenience.
 * Sorting it differently re-models every car in Sydney. A model that fails to
 * load, or that this file refuses (see `PROPORTION_LIMIT`), **keeps its slot in
 * the pool as a hole** rather than being spliced out -- a shorter pool is a
 * different modulus and therefore a different city.
 *
 * ---------------------------------------------------------------------------
 * 2. HYSTERESIS, and why one radius would flicker.
 *
 * Claim inside `CLAIM_RADIUS`, release outside `RELEASE_RADIUS`, and the 20 m
 * between them is not a taste decision. A player on a bike does 8 m/s, and a
 * single radius means a car sitting within a few centimetres of it is claimed
 * and released on alternate frames as the rider's own head bob crosses it --
 * which is a box and a model alternating at 60 Hz, in the middle of the frame,
 * on the one car the player is looking at.
 *
 * The pair also has to survive the *sweep rate*. Assignment runs at 5 Hz rather
 * than per frame (section 4), so a car can travel 8 m/s x 0.2 s = 1.6 m between
 * two decisions, and an approaching car closes on the player at up to twice
 * that. Twenty metres is an order of magnitude more than the sweep can miss by.
 *
 * ---------------------------------------------------------------------------
 * 3. SUPPRESSION, and the two completely different lifecycles it has to serve.
 *
 * A claimed car must not also draw as a box, and the two fleets need opposite
 * mechanisms because one is rebuilt every frame and the other is built once.
 *
 *   - **The schedule fleet.** `TrafficMovers.update` refills its instance
 *     buffers from scratch every frame, so suppression is simply *not filling a
 *     slot*: it asks this file, once per car, inside the loop it is already
 *     running. That is deliberately the same shape as `CarLightSink` and for the
 *     identical reason `world/cars.ts` gives about the headlights -- this file
 *     needs a pose for every claimed car every frame, `TrafficMovers` is already
 *     computing exactly that pose, and a second pass that had to *agree* with it
 *     is the bug. The car you see as a model is the car that is there.
 *
 *   - **The parked fleet.** `buildTileCars` writes a tile's matrices once, at
 *     load, and never touches them again -- that is what makes 23,020 cars cost
 *     nothing per frame. There is no per-frame pass to skip, so a claimed parked
 *     car has its matrix overwritten with a **zero scale** and restored on
 *     release. Zero-scale rather than a count change because a tile's instances
 *     are not orderable: they are packed per body type in sidecar order and
 *     moving one would move somebody else's.
 *
 *     A zero-scaled instance still runs its vertex shader, and that is the price:
 *     110 wasted vertices per claimed car, against at most a couple of dozen
 *     claims. Reordering the tile to keep the drawn ones contiguous would save
 *     it and would mean rewriting a tile's whole matrix buffer on every claim.
 *
 *     **The matrix is a span of a shared mesh, not a mesh of the tile's own.**
 *     The parked fleet moved into `world/instancepool.ts` when its per-tile
 *     `InstancedMesh`es turned out to be compiling a pipeline each -- see
 *     `cars.buildTileCars` -- so what this file is handed is a `PooledSet` per
 *     body class and what it addresses is an instance *within a claim*. Three
 *     consequences worth stating, because each is a bug that was possible for an
 *     afternoon:
 *
 *       * the matrices in the buffer are **world-space**, since a pooled mesh
 *         sits at the origin and the pool folded the tile offset in on the way
 *         past. `consider` overwrites the plan position with the sweep's world
 *         one anyway, so nothing here changed; but the read-then-restore pair
 *         must go through `getMatrixAt`/`setWorldMatrixAt`, which do not touch
 *         the origin, or a hidden car reappears one tile east of its bay.
 *       * a write is not an upload. The pool marks its species dirty and
 *         `flush()` is what reaches the GPU, so every place that used to set
 *         `instanceMatrix.needsUpdate` now flushes.
 *       * the instance index is `binCarsByBody`'s, which is the same function
 *         the builder laid the span out with rather than a second loop that
 *         agrees with it.
 *
 *     **Eviction is the trap here.** A tile can stream out while one of its cars
 *     is claimed, and the streamer releases its claims back to the pool -- which
 *     zeroes them, and may hand the same instances to the next tile that arrives
 *     within the same frame. So the claim is dropped by `release(tileKey)`
 *     *without* restoring, because a restore after the release would write this
 *     tile's car into somebody else's suburb, and a restore before it is
 *     pointless work on a span about to be zeroed. `TileStreamer.dispose` calls
 *     `release` **first**, before `instancePool.release`, and that ordering is
 *     the whole of the safety argument: while this file still holds a claim, the
 *     span still belongs to the tile.
 *
 * ---------------------------------------------------------------------------
 * 4. COST, and where it is spent.
 *
 * Assignment is a sweep at `SWEEP_HZ`, not a per-frame pass. Deciding which cars
 * are near enough means posing every schedule car within the claim radius and
 * walking every parked car in the tiles that reach it, and neither answer can
 * change materially in 200 ms -- see the hysteresis argument above, which is
 * what buys the low rate. Measured at `sweepMs`; the budget is 0.5 ms.
 *
 * Per frame, the only work is the claimed *movers'* matrices, written from the
 * pose `TrafficMovers` already computed, at a couple of dozen cars. A claimed
 * parked car is written once, at the moment it is claimed, because a parked car
 * does not move. A schedule car in one of its parked stages is **not** in that
 * exception: it is stationary now and will pull out later, and detecting that
 * transition would cost exactly the per-frame pose that treating it as a mover
 * already pays for.
 *
 * ---------------------------------------------------------------------------
 * 5. THE ASSETS, and the two things this file does to them.
 *
 * `client/public/cars/manifest.json` names 19 normalised `.glb` files, of which
 * 15 are loaded. It named 38 until the 2026-09 real-cars round deleted the
 * nineteen stylised and generic stand-ins from it and from the directory, so
 * the five passenger classes carry real makes only and the four special bodies
 * keep the one mesh each that exists for them; `game/carlabels.ts` section 3
 * argues it and holds the table. They are
 * pre-normalised for length and ground plane -- the X extent is the body class's
 * own length out of `CAR_BODY_SIZE` and the lowest vertex is at y = 0 -- so
 * nothing here scales or lifts them. Two things it does do:
 *
 *   - **`YAW_CORRECTION`.** Five of the mapped files are authored nose-down-`-X`
 *     and render backwards. The correction is a table here rather than a
 *     reprocessed asset (the assets are shared with the pipeline and are not
 *     this renderer's to rewrite), and it is baked into the merged geometry at
 *     load rather than applied per instance, so it costs nothing per frame.
 *
 *   - **One geometry and one material per model, out of many.** Every file is a
 *     scene of separate nodes with their own transforms and up to thirteen
 *     materials -- `city_bus.glb` is 59 nodes over 11. An `InstancedMesh` is one
 *     geometry and one material, so the merge bakes each node's world matrix
 *     into its vertices and collapses every material into a **vertex colour**,
 *     which is precisely the trade `world/cars.ts` already made for the box
 *     fleet and for the same reason: `instanceColor` multiplies the whole
 *     object, so a second material slot would be tinted by the paint anyway and
 *     a second mesh would double the draw calls.
 *
 * The colour rule that falls out of that is the one subtle part, and section 6
 * is about it.
 *
 * ---------------------------------------------------------------------------
 * 6. PAINT: value from the asset, hue from the entity.
 *
 * A car's colour belongs to the *car*, not to the model: `PAINT[colour]` is
 * drawn from the same hash as the body type, it is what the box fleet is drawn
 * in, and a car that changed colour as you walked toward it would be the exact
 * "type switch at the boundary" this whole feature has to avoid. So the paint
 * has to survive the swap, which means the model may not bring a hue of its own.
 *
 * The naive reading of the manifest's `tint: "multiply"` is that these models
 * are white and the paint simply lands on them. Ten of them are (the Kenney kit
 * arrived here with its palette texture already flattened, so those files are
 * literally monochrome white). The rest are not: they carry an authored red or
 * blue body, and multiplying red paint into a blue body gives a colour that is
 * in neither palette.
 *
 * So a `multiply` model's materials are collapsed to a **greyscale value** and
 * the paint supplies all of the hue -- exactly the relationship `cars.TRIM` has
 * with `cars.PAINT`, where the glass and the tyres are dark *multipliers* on
 * whatever the car is painted. Two details make it work rather than merely
 * sound reasonable:
 *
 *   - The value is **V, the maximum channel**, not luminance. A saturated red
 *     body (`#f53f30`) has a luminance of 0.14 and a V of 0.91; under luminance
 *     every red or blue car in the set would have come out near black, which is
 *     the first thing this rule was tried with and the reason it is not that.
 *
 *   - It is **normalised against the model's own dominant surface** so the body
 *     panels reach 1.0 and take the paint at full strength. `DOMINANT_SHARE`
 *     defines which surfaces get a vote: a material has to cover at least that
 *     fraction of the model's triangles, which is what stops a twelve-triangle
 *     white headlight setting the exposure for the whole car.
 *
 * A `tint: "none"` model keeps its authored colours and is drawn white, which
 * today is exactly one file: the police car, whose livery is not a paint choice.
 */

import { Fn, instancedBufferAttribute, max, mix, texture, uv, vec4, vertexColor } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  forEachCarNear,
  type CarPose,
  type LaneObstacles,
  type LaneRoute,
  type TrafficField,
} from '../game/traffic.ts';
import { policeLiveried } from '../game/factions.ts';
import { CAR_FLEET } from '../game/carlabels.ts';
import { binCarsByBody } from '../game/staticcars.ts';
import { BODY_COUNT, CAR_LIVERY_WHITE, CAR_PAINT, crumpleScale, crumpleTone, type TileCars } from './cars.ts';
import type { PooledSet } from './instancepool.ts';

// --- The contract with the rest of the client -----------------------------------

/**
 * What `TrafficMovers` asks, once per car, inside the loop it already runs.
 *
 * Deliberately the same three-call shape as `nightlights.CarLightSink`, and for
 * the reason `world/cars.ts` gives about it: the pose a claimed car is drawn at
 * has to be the pose the box fleet computed, and the only way to guarantee that
 * is to be handed it rather than to go and find it again.
 */
export interface CarModelSink {
  /**
   * Start a frame. Returns false when nothing is claimed, and then `claimed` is
   * never called -- one comparison a frame rather than a map lookup a car, which
   * is what makes the far-from-anywhere case free.
   */
  begin(): boolean;
  /**
   * Is this car drawn as a model this frame? A true answer means the caller must
   * **not** draw its box, and means this call has already written the model's
   * matrix from the pose it was handed.
   */
  claimed(pose: CarPose): boolean;
  /**
   * The claimed model's own body box, for anything the box fleet draws *around*
   * a car rather than as one -- which today is the police chequer band.
   *
   * Without it a marked car within the claim radius would quietly lose its
   * markings, because the band is scaled from `CAR_BODY_SIZE` and a model is not
   * the same size as its hit box. Returns null for a car this file is not
   * drawing.
   */
  bandBox(identity: number): Readonly<CarModelBox> | null;
  /** Finish the frame: upload whatever moved. */
  end(): void;
}

/** The measured extent of a merged model, metres. */
export interface CarModelBox {
  length: number;
  width: number;
  height: number;
}

/**
 * How the streamer tells this file about a tile's parked cars.
 *
 * On `TileStreamer.setPowerupSink`'s terms exactly, and with the same division
 * of ownership: the streamer owns the meshes and this file owns nothing but a
 * reference to them, so `release` is a promise that the reference is dropped
 * before the mesh is disposed. See section 3 on eviction.
 */
export interface ParkedCarSink {
  /**
   * `sets` are the spans of the shared car meshes this tile claimed, as
   * `buildTileCars` returned them, and `originX`/`originZ` are the tile group's
   * translation -- the sidecar's coordinates are tile-local and every distance
   * this file measures is not.
   *
   * The claims are the *streamer's*, not this file's: they are released back to
   * the pool when the tile is evicted, and the promise `release` makes is that
   * every reference into them is dropped before that happens. See section 3 on
   * eviction, which is where that promise is spent.
   */
  adopt(
    tileKey: string,
    data: TileCars,
    sets: readonly PooledSet[],
    originX: number,
    originZ: number,
  ): void;
  release(tileKey: string): void;
}

// --- The numbers ----------------------------------------------------------------

/** Where a car becomes a model, metres. See section 2. */
export const CLAIM_RADIUS = 90;
/** Where it goes back to being a box. Never equal to the claim radius. */
export const RELEASE_RADIUS = 110;
/** Assignment sweeps a second. See section 4. */
export const SWEEP_HZ = 5;

/**
 * Instances per model file.
 *
 * **This paragraph used to be an estimate and it was wrong.** It said "a dozen
 * or so per model at the worst measured point", and 24 was twice that again.
 * The 2026-09 real-cars round measured it instead, over all 13,362 baked
 * `.cars.bin` sidecars -- 1,398,902 parked cars -- by standing at every car in
 * the sixty densest tiles, counting what falls inside `CLAIM_RADIUS`, and
 * taking `identity % pool.length` for each. The answer even *before* the
 * stand-ins were removed was **35 Corollas** at one point in the inner west,
 * against a ceiling of 24: this fleet has been quietly overflowing at its
 * densest points since it shipped, and an overflow is a car drawn as a box
 * among models.
 *
 * With the passenger classes cut to real makes only the worst point is **47**
 * (`toyota_corolla_2020`, tile `-61_36`, 179 parked cars inside 90 m), because
 * body 1 is now five parts Corolla to one part Golf. The runners-up are the
 * Tesla at 36 and the Camry at 34. To those add the schedule fleet and the
 * driven records, which claim out of the same pools -- counted in tens near the
 * player, spread over five classes -- so 64 is the measurement plus a third.
 *
 * It is a hard ceiling rather than a guideline: a car that finds its model full
 * simply is not claimed and draws as the box it already was, which is the
 * correct way for this feature to run out of room.
 *
 * An `InstancedMesh` costs its capacity in buffer bytes and its `count` in draw
 * work, so raising it from 24 buys nothing at frame time and costs buffer only:
 * 64 x 80 bytes x 15 loaded meshes = **77 kB**, up from 29 kB. The mesh count
 * fell from 24 to 15 in the same round, so the whole fleet is 48 kB dearer than
 * it was and a Corolla-lined street is no longer half boxes.
 */
const PER_MODEL_CAPACITY = 64;

/**
 * Files authored nose-toward `-X`, corrected by half a turn at merge time.
 *
 * **Empty since the 2026-09 round, and kept as a table so the next stale
 * entry has somewhere to be argued about.** `scripts/prep-car-models.mjs`
 * turns every file nose-to-`+X` before it ships (name cues, then the glass,
 * then a `nose` pinned by hand in its CATALOG), and `scripts/render-car-sheet.mjs`
 * draws every shipped file from off its `+X` end so a person can see the
 * grille. The five entries that used to live here were written against files
 * the prep had *not yet* turned; once it did, three of them -- the bus, the
 * garbage truck and `sedan_generic_a` -- were turned a second time here and
 * drove backwards for a day. One fact, one place: the prep owns the nose.
 */
const YAW_CORRECTION: Readonly<Record<string, number>> = {};

/**
 * How far out of proportion a model may be before this file refuses to draw it.
 *
 * The manifest normalises *length* and nothing else, so a file whose width or
 * height is wildly out of scale with its body class is not a stylised car -- it
 * is the wrong object. `suv_generic_b.glb` is the case that made this necessary:
 * it is a lunar rover with a dish antenna, 4.45 m tall and 4.17 m wide against
 * an SUV hit box of 1.70 x 1.90, and it cannot be rescued by scaling because
 * shrinking it to fit would make it a 2 m long SUV.
 *
 * 1.8x is deliberately generous. It was set against the Kenney kit, which is
 * chunky on purpose and lands between 1.3x and 1.5x. The kit and the rover both
 * left the manifest in the 2026-09 real-cars round, so **this test now rejects
 * nothing in the set** -- which is the right state for it to be in and not a
 * reason to delete it: the next `.glb` somebody drops into `client/public/cars/`
 * is the one it exists for, and a limit only tightened after a wrong object has
 * shipped is a limit that has already failed.
 *
 * A rejected model **keeps its slot in the pool** (section 1) -- `weight` slots,
 * one per point, so the modulus is the length it would have been -- so the
 * rejection cannot re-model the rest of the city. The cars that hash to it draw
 * as boxes.
 */
const PROPORTION_LIMIT = 1.8;

/**
 * The share of a model's triangles a material must cover to set its exposure.
 *
 * See section 6. Twelve triangles of white headlight are not what a car's paint
 * should be normalised against; a third of the body is.
 */
const DOMINANT_SHARE = 0.08;

/** Where the models live. Client assets, shipped with the build, not world data. */
const MODEL_DIR = '/cars/';

/** Body classes the box fleet draws, which is what a model can be mapped to. */
type BodyKey = number | 'police';

// --- The manifest ---------------------------------------------------------------

/** One row of `client/public/cars/manifest.json`. */
export interface CarModelEntry {
  file: string;
  /**
   * What a player is told they are sitting in. `game/carlabels.ts` owns the
   * table this duplicates and the guard in `loadCarModels` keeps the two
   * honest; it is repeated in the manifest because the manifest is the record
   * a person edits when a `.glb` arrives.
   */
  label?: string;
  /** `0`..`4` for the five body classes, or a named role. */
  body: number | 'police' | 'taxi' | 'bus' | 'garbage';
  tris: number;
  lengthM: number;
  tint: 'multiply' | 'none';
  /**
   * The model's share of its body class, in whole points: the pool repeats
   * it this many times, and `identity % pool.length` does the rest. The
   * Sydney mix's real cars carry the owner's road shares (a Ranger 8, a
   * Triton 4); a generic filler is 1. Absent means 1.
   */
  weight?: number;
  license: string;
  attribution: string;
}

/**
 * Which manifest roles this client has an entity for.
 *
 * `police` is mapped because `factions.policeLiveried` already decides which
 * schedule cars wear a livery, so there is a real car to put a police model on.
 * **`taxi`, `bus` and `garbage` are not loaded**, and that is a statement about
 * the game rather than about the assets: there is no taxi, bus or garbage-truck
 * entity in the traffic, and inventing one here -- by, say, promoting one sedan
 * in twenty to a taxi on a hash -- would be this renderer deciding what is on
 * Sydney's roads, which is `pipeline/sydney/lanes.py`'s call and not a
 * renderer's. Four files therefore never leave the disk. When those entities
 * exist, mapping them is one line each.
 */
function mappedBody(entry: CarModelEntry): BodyKey | null {
  if (typeof entry.body === 'number') {
    return entry.body >= 0 && entry.body < BODY_COUNT ? entry.body : null;
  }
  return entry.body === 'police' ? 'police' : null;
}

// --- Merging one file -----------------------------------------------------------

/** What the merge produced, or why it did not. */
interface MergedModel {
  /** The one map the prep packed for this file, or null for a flat-coloured model. */
  map: Texture | null;
  geometry: BufferGeometry;
  box: CarModelBox;
  /**
   * How far the file's own lowest vertex was from its origin, metres, before
   * this loader put it back on the road. Negative is a car that was sunk into
   * the carriageway and positive one that was hovering. Reported by
   * `sydney.carModelReport()` so the fix is a number rather than an opinion.
   */
  seat: number;
  triangles: number;
}

const _v = /*#__PURE__*/ new Vector3();
const _n = /*#__PURE__*/ new Vector3();
const _normalMatrix = /*#__PURE__*/ new Matrix3();
const _yawMatrix = /*#__PURE__*/ new Matrix4();
const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _scale = /*#__PURE__*/ new Vector3();
const _zero = /*#__PURE__*/ new Matrix4().makeScale(0, 0, 0);

/** One primitive's contribution, held while the two passes of the merge run. */
interface Piece {
  uvs: Float32Array;
  paint: Float32Array;
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex, before the value collapse. */
  colours: Float32Array;
  index: Uint32Array;
  triangles: number;
}


/**
 * Collapse a glTF scene into one geometry with a baked vertex colour.
 *
 * The two passes are not tidiness: the value normalisation in section 6 needs
 * every material's coverage and its own bright end before any final colour can
 * be written, and both are only known once the whole file has been walked.
 */
function mergeModel(root: Object3D, tint: 'multiply' | 'none', yaw: number): MergedModel {
  root.updateMatrixWorld(true);
  _yawMatrix.makeRotationY(yaw);

  // Collected before anything is read, on `landmarks.loadLandmarks`' own trap:
  // mutating the child array a `traverse` is walking runs it off the end.
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
  });

  const materials: Array<{ triangles: number; values: number[] }> = [];
  const materialIndex = new Map<unknown, number>();
  const pieces: Piece[] = [];
  let map: Texture | null = null;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) continue;
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const count = position.count;
    const triangles = (index?.count ?? count) / 3;

    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let slot = materialIndex.get(material);
    if (slot === undefined) {
      slot = materials.length;
      materialIndex.set(material, slot);
      materials.push({ triangles: 0, values: [] });
    }
    materials[slot].triangles += triangles;

    // The world matrix, and the yaw correction folded into it -- so a corrected
    // model is corrected once, here, and is an ordinary geometry forever after.
    _matrix.multiplyMatrices(_yawMatrix, mesh.matrixWorld);
    _normalMatrix.getNormalMatrix(_matrix);

    const base = (material as { color?: Color }).color ?? new Color(1, 1, 1);
    // The atlas, if the prep packed one. One per file by construction
    // (`bakeAtlas` joins every primitive onto it), so the first is the only.
    const ownMap = (material as { map?: Texture | null }).map ?? null;
    if (ownMap !== null && map === null) map = ownMap;
    // With an atlas the texels are sampled in the shader; without one the
    // model has no map. The per-vertex texture read-back that used to live
    // here is what made a Ranger look flat.
    // What the prep decided the paint lands on, per vertex; a file without the
    // attribute predates it and is painted all over, which is what it was.
    const paintAttr = geometry.getAttribute('_paint') ?? geometry.getAttribute('_PAINT');
    const colourAttr = geometry.getAttribute('color');

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const paint = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // `fromBufferAttribute` denormalises, which every file in this set needs:
      // they are authored with normalised int16 positions and a per-node scale.
      _v.fromBufferAttribute(position, i).applyMatrix4(_matrix);
      positions[i * 3] = _v.x;
      positions[i * 3 + 1] = _v.y;
      positions[i * 3 + 2] = _v.z;

      if (normal) {
        _n.fromBufferAttribute(normal, i).applyMatrix3(_normalMatrix).normalize();
      } else {
        _n.set(0, 1, 0);
      }
      normals[i * 3] = _n.x;
      normals[i * 3 + 1] = _n.y;
      normals[i * 3 + 2] = _n.z;

      let r = base.r;
      let g = base.g;
      let b = base.b;
      if (colourAttr) {
        r *= colourAttr.getX(i);
        g *= colourAttr.getY(i);
        b *= colourAttr.getZ(i);
      }
      if (uv) {
        uvs[i * 2] = uv.getX(i);
        uvs[i * 2 + 1] = uv.getY(i);
      }
      paint[i] = paintAttr ? paintAttr.getX(i) : 1;
      colours[i * 3] = r;
      colours[i * 3 + 1] = g;
      colours[i * 3 + 2] = b;
      // V, the maximum channel. See section 6 on why this is not luminance.
      // Only the painted vertices vote: a headlight the prep left alone must
      // not set the exposure for the panels, and is not normalised itself.
      if (paint[i] > 0.5 && ownMap === null) materials[slot].values.push(Math.max(r, g, b));
    }

    const source = index ? index.array : null;
    const merged = new Uint32Array(index ? index.count : count);
    if (source) {
      for (let i = 0; i < merged.length; i++) merged[i] = source[i] as number;
    } else {
      for (let i = 0; i < merged.length; i++) merged[i] = i;
    }
    pieces.push({ positions, normals, colours, uvs, paint, index: merged, triangles });
  }

  // --- The exposure. See section 6.
  let totalTriangles = 0;
  for (const m of materials) totalTriangles += m.triangles;
  let dominant = 0;
  for (const m of materials) {
    if (m.triangles < totalTriangles * DOMINANT_SHARE) continue;
    // The bright end of what this material actually paints, rather than its
    // mean. For a flat material every vertex is the same number and this is
    // simply that number; for a textured one it is the body panel rather than
    // the shadow the texture puts under the sills.
    const sorted = m.values.slice().sort((a, b) => a - b);
    dominant = Math.max(dominant, sorted[Math.floor(sorted.length * 0.95)] ?? 0);
  }
  // A model with no dominant surface at all -- every material below the share
  // threshold -- falls back to the brightest thing in it, and a model that is
  // uniformly black falls back to 1 so the guard below cannot divide by zero.
  if (dominant <= 0) {
    for (const m of materials) for (const v of m.values) dominant = Math.max(dominant, v);
  }
  const gain = dominant > 1e-4 ? 1 / dominant : 1;

  // --- Second pass: concatenate, with the final colours.
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const p of pieces) {
    vertexTotal += p.positions.length / 3;
    indexTotal += p.index.length;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  // Four wide: rgb and the paint mask in w, read as one `vertexColor()`.
  const colours = new Float32Array(vertexTotal * 4);
  const uvs = new Float32Array(vertexTotal * 2);
  const indices = new Uint32Array(indexTotal);
  let vOffset = 0;
  let iOffset = 0;
  for (const p of pieces) {
    positions.set(p.positions, vOffset * 3);
    normals.set(p.normals, vOffset * 3);
    uvs.set(p.uvs, vOffset * 2);
    const n = p.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const o = (vOffset + i) * 4;
      // A `none` model is drawn as authored everywhere: its mask is off.
      const painted = tint === 'multiply' && p.paint[i] > 0.5;
      colours[o + 3] = painted ? 1 : 0;
      if (painted && map === null) {
        // Flat colours: the value, exposed so the body reaches 1. With an atlas
        // the prep baked the gain into the texels and the vertex stays white.
        const value = Math.min(1, Math.max(p.colours[i * 3], p.colours[i * 3 + 1], p.colours[i * 3 + 2]) * gain);
        colours[o] = value;
        colours[o + 1] = value;
        colours[o + 2] = value;
      } else {
        colours[o] = p.colours[i * 3];
        colours[o + 1] = p.colours[i * 3 + 1];
        colours[o + 2] = p.colours[i * 3 + 2];
      }
    }
    for (let i = 0; i < p.index.length; i++) indices[iOffset + i] = p.index[i] + vOffset;
    vOffset += n;
    iOffset += p.index.length;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colours, 4));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const bounds = geometry.boundingBox!;

  // --- APPEARANCE FIX 1: put the tyres on the road.
  //
  // The header says these files are "pre-normalised for length and ground
  // plane", and for most of them that is true. It is not true for all of them,
  // and the failure is the most visible thing about the near field:
  // `CarModelFleet.consider` composes a claimed car's matrix from the *box*
  // car's, whose origin is its wheel contact patch because `world/cars.ts`
  // builds it that way -- so a model whose own lowest vertex sits under its
  // origin is drawn with its tyres in the carriageway, and one over it hovers.
  // From the footpath it reads as the road being soft.
  //
  // Trusting the author is what produced that, so this stops trusting them: the
  // merged geometry is translated so its lowest vertex is exactly y = 0, and the
  // matrix's own `CARRIAGEWAY_Y` clearance is then the only thing between a tyre
  // and the road.
  //
  // **Baked into the geometry, once, at load** -- exactly where `YAW_CORRECTION`
  // is baked and for its reason: it is a property of the file, it never changes,
  // and a per-instance translate would be an extra term on every matrix in the
  // near field for a constant.
  //
  // The lowest vertex is the contact patch on every body in this set. It would
  // not be on a model with a dropped exhaust under the axle line, and if one
  // ever arrives the error is a millimetre of hover -- the right direction for
  // this to be wrong in, and why this is a translate rather than a rejection.
  const seat = bounds.min.y;
  if (seat !== 0) {
    geometry.translate(0, -seat, 0);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }

  return {
    geometry,
    map,
    seat,
    box: {
      length: bounds.max.x - bounds.min.x,
      width: bounds.max.z - bounds.min.z,
      height: bounds.max.y - bounds.min.y,
    },
    triangles: indexTotal / 3,
  };
}


// --- One model, ready to draw ---------------------------------------------------

/** One instance's paint and crumple tone into the slot's buffer. See `ModelSlot.paint`. */
function writePaint(slot: ModelSlot, index: number, r: number, g: number, b: number, tone: number): void {
  const a = slot.paint.array as Float32Array;
  a[index * 4] = r;
  a[index * 4 + 1] = g;
  a[index * 4 + 2] = b;
  a[index * 4 + 3] = tone;
}

/** A loaded model file and the instances currently wearing it. */
interface ModelSlot {
  file: string;
  mesh: InstancedMesh;
  box: CarModelBox;
  /**
   * The paint per instance -- rgb, and the crumple tone in w -- read by the
   * material through `instancedBufferAttribute`. Not `instanceColor`, and the
   * difference is the whole of section 6's second half: `instanceColor` is
   * multiplied into every fragment by the node material, and a headlight, a
   * tyre and a number plate must not take the paint. The shader below reads
   * this where the prep's `_PAINT` mask says so and leaves the rest alone.
   */
  paint: InstancedBufferAttribute;
  /** Whether an instance takes the entity's paint. `tint: "multiply"`. */
  painted: boolean;
  /** Claims occupying instances `0 .. claims.length - 1`. Kept packed. */
  claims: Claim[];
  /** Whether a matrix or colour changed since the last upload. */
  dirty: boolean;
  triangles: number;
}

/** One car currently drawn as a model. */
interface Claim {
  identity: number;
  slot: ModelSlot;
  /** Instance within `slot.mesh`. Moves when a claim below it is released. */
  index: number;
  /** Where the car was last known to be, for the release test. */
  x: number;
  z: number;
  /** The parked car this hides, or null for a schedule mover. */
  parked: ParkedClaim | null;
  /** Sweep this claim was last confirmed on. */
  sweep: number;
  /** Frame a mover last posed on. A mover that stops posing has expired. */
  frame: number;
  /** The last matrix written, so a compaction can move it without a re-pose. */
  matrix: Matrix4;
  /**
   * The paint this instance was given, for the same reason. Linear, and
   * **undarkened**: the crash tone is applied on top of it by `claimed`, so a
   * car that is repaired -- or a compaction that moves this claim -- puts back
   * the colour the car actually is rather than the colour it was last drawn.
   */
  pr: number;
  pg: number;
  pb: number;
  /** The `CarPose.damage` this instance was last painted for. See `claimed`. */
  damage: number;
}

/**
 * The tile instance a claim has zero-scaled, and what to put back.
 *
 * `set` is the tile's span of the shared mesh for this car's body class and
 * `index` is the instance *within that span*, which is what makes the pair a
 * valid handle for exactly as long as the tile holds the claim. See section 3.
 */
interface ParkedClaim {
  tile: ParkedTile;
  set: PooledSet;
  index: number;
  restore: Matrix4;
}

/** One resident tile's parked cars, as this file needs them. */
interface ParkedTile {
  count: number;
  identity: Uint32Array;
  /** World metres: the sidecar's tile-local coordinates plus the group origin. */
  x: Float32Array;
  z: Float32Array;
  body: Uint8Array;
  colour: Uint8Array;
  /**
   * Which claimed span each car lives in, and where within it.
   *
   * Null for a body class this tile claimed no span for -- which is a pool that
   * refused (`InstancePool.refused`, counted and on the frame line) rather than
   * anything to do with the sidecar, since a body with cars in it always asks.
   * Those cars are drawn by nobody, so there is nothing to hide and no model to
   * put in front of them.
   */
  set: Array<PooledSet | null>;
  index: Uint16Array;
  /** Plan bounds, so a sweep can reject a whole tile with four comparisons. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Claims taken from this tile, so an eviction can drop them all. */
  claims: Set<Claim>;
}

// --- The fleet ------------------------------------------------------------------

/**
 * Every car model in the near field, as one `InstancedMesh` per file.
 *
 * Not parented to a tile, on `TrafficMovers`' own argument: a claimed car is
 * within 110 m of the camera and crosses tile boundaries constantly, and the
 * float32 question a world-space matrix raises is answered by the radius --
 * at 4 km from the origin a float32 still resolves half a millimetre.
 */
export class CarModelFleet implements CarModelSink, ParkedCarSink {
  /** Every instanced set, for the scene and the boot warm-up. */
  readonly meshes: InstancedMesh[] = [];
  /** The one material every model wears. See section 5. */
  /** Every material the fleet made, for disposal. Two graphs, N instances. */
  private readonly materials: MeshStandardNodeMaterial[] = [];

  /** Cars drawn as models right now. On the debug overlay. */
  claimedCount = 0;
  /** What the last assignment sweep cost, milliseconds. The budget is 0.5. */
  sweepMs = 0;
  /** Sweeps that found a model's capacity full. Should stay at zero. */
  overflows = 0;
  /**
   * Where to register the parked fleet as things traffic must not drive through,
   * or null.
   *
   * `traffic.TrafficField.obstacles`, handed over rather than reached for, and
   * this class is the one that does it for a reason that is entirely about
   * lifecycle: `adopt`/`release` here are already the only pair of calls in the
   * client that brackets a tile's parked cars exactly -- the streamer calls them
   * as a tile is built and as it is disposed -- and an obstacle registered on any
   * other clock would outlive the meshes it came from.
   *
   * Null is a client that never loaded the models, or a check. Then the traffic
   * does not go round the *static* fleet (the bays it always goes round, because
   * those come out of the sidecar in `TrafficField.adopt`), which is exactly the
   * behaviour that shipped before this round -- see
   * `traffic.LaneObstacles.adoptStatics` for why the static half is the client's
   * business alone.
   */
  obstacles: LaneObstacles | null = null;

  /** Files loaded, and files the manifest named but this refused or lost. */
  readonly loadedFiles: string[] = [];
  readonly skipped: Array<{ file: string; why: string }> = [];
  /**
   * Files whose ground plane was not where the manifest promised, and how far
   * this loader had to lift them, millimetres. Positive is a car that was sunk
   * into the road. See `mergeModel`.
   */
  readonly reseated: Array<{ file: string; byMm: number }> = [];

  /** Pools by body class, in manifest order, with holes. See section 1. */
  private readonly pools = new Map<BodyKey, Array<ModelSlot | null>>();
  private readonly byIdentity = new Map<number, Claim>();
  private readonly tiles = new Map<string, ParkedTile>();
  private readonly scratch: LaneRoute[] = [];
  private readonly pose: CarPose;
  private sweepNo = 0;
  /** One error, not one per frame. See `begin`. */
  private warnedNoEnd = false;
  /**
   * The frame number `end()` last ran on, or -1.
   *
   * The whole of the `end()` contract, as a number rather than as an inference
   * from a dirty flag -- see `begin()` on why the flag was the wrong question
   * and what it cost.
   */
  private endedAt = -1;
  /**
   * A cheap hash of the driven identity set, as `drivenSetChanged` last saw it.
   *
   * `-1` is "never asked", which is distinguishable from every real hash below
   * because the mix ends `>>> 0`.
   */
  private drivenHash = -1;
  private frameNo = 0;

  /**
   * Which ambient cars somebody has stolen. `world/cars.TrafficMovers.suppress`'s
   * twin, and it has to exist separately because this file runs its own sweep
   * over the same fleet.
   *
   * Without it a stolen car keeps its model claim from the sweep even though
   * `TrafficMovers` has stopped posing it, and the model sits at the kerb the
   * car was taken from for the two frames the release rule allows -- then
   * vanishes, which reads as the car being deleted and reappearing.
   *
   * Revoking an existing claim is **not** done here and does not need to be: a
   * suppressed car stops being considered, its `sweep` stamp goes stale, and the
   * release pass at the bottom of `sweep` revokes it on exactly the rule it
   * already had for a car that reached the end of its route.
   */
  suppress: ((identity: number) => boolean) | null = null;

  /**
   * Every car anybody in this room is driving, by identity. WORKSTREAM S.
   *
   * ---------------------------------------------------------------------------
   * WHY A SECOND FEED, WHEN `suppress` AND `drivenClaims` ARE ALREADY HERE.
   *
   * Suppressing a *schedule* car is the absence of an action: `poseCar` is a
   * lookup, so not asking it is the whole of the fix, and `suppress` above is a
   * predicate consulted inside a loop that was already running.
   *
   * A **parked** car is not a lookup. It is an instance matrix in the span a
   * tile claimed, written once by `buildTileCars` when the tile arrived, and
   * it keeps drawing until somebody writes over it. So the box of a car a player
   * has driven away has to be *un-drawn*, which is an action, which needs a
   * handle on the tile and the instance index -- and the only handle a driven
   * record carries is its identity.
   *
   * `drivenClaims` cannot serve: it is range-gated by
   * `drivencars.DrivenCarView.near` so that the draw loop does not pose four
   * hundred cars in Penrith, and a box that stopped being hidden when its driver
   * went out of range would reappear at the kerb *while somebody was driving it*.
   * This feed is every record in the field, ungated, and it is walked at
   * `SWEEP_HZ` over a list counted in ones.
   *
   * Default is "nobody is driving anything", which is what a check and a client
   * with no `CarField` wired up mean.
   */
  drivenIdentities: (visit: (identity: number) => void) => void = () => {};

  /**
   * Boxes currently folded flat because somebody is driving that car, and the
   * matrix each one had before it was.
   *
   * Keyed on identity, so the *restore* is exact: a car recycled back onto its
   * kerb (`driving.CarField.recycleFarthest`) has to come back at the height, the
   * heading, the grade pitch and the size jitter `buildTileCars` sampled for it,
   * and the only copy of those five facts is the matrix that was there. Read out
   * of the buffer at hide time rather than recomputed, which is exactly what
   * `ParkedClaim.restore` already does one screen up and for the same reason.
   */
  private readonly hiddenStatics = new Map<number, {
    tile: ParkedTile;
    set: PooledSet;
    index: number;
    restore: Matrix4;
  }>();

  /**
   * Identities this file has looked for and not found in any resident tile.
   *
   * The great majority of driven records are **schedule** cars, whose identities
   * come out of `traffic.carHash` and can never appear in a `.cars.bin`. Without
   * this set every one of them would cost a full scan of every resident tile
   * every sweep -- 23,000 comparisons times the number of stolen cars, five times
   * a second, to learn nothing.
   *
   * Cleared whenever the resident tile set changes, which is the only event that
   * can turn a miss into a hit: a car stolen by somebody else in a tile this
   * client had not built yet. That costs a re-scan per tile arrival over a list
   * of stolen cars counted in ones, and it is the difference between "the box
   * goes when you get close enough to see it" and "the box never goes".
   */
  private readonly notStatic = new Set<number>();

  /**
   * The cars a player is driving, so they can be models too.
   *
   * Set by the caller alongside `suppress` and walked at the end of the sweep.
   * A driven car is the *nearest* car in the world by construction -- you are
   * sitting in it -- so it is the one car in the city where drawing a box
   * instead of a model would be most obvious.
   */
  drivenClaims: (visit: (pose: CarPose) => void) => void = () => {};

  constructor(pose: CarPose) {
    this.pose = pose;
  }

  /**
   * One material per model, because the map and the paint buffer are the
   * model's own. Two shader graphs in the whole fleet -- with a map and
   * without -- so the pipeline count does not grow with the manifest.
   *
   * The colour rule, in one line of TSL: `base` is the atlas texel (or 1) times
   * the vertex colour; where the prep's mask is on, the entity's paint takes
   * the *value* of that base as its hue's brightness -- section 6's rule, in
   * the shader rather than baked -- and where it is off the authored colour
   * stands. The crumple tone rides in the paint's fourth component and darkens
   * both, so a wreck's headlights are as sooty as its panels.
   */
  private materialFor(map: Texture | null, paint: InstancedBufferAttribute, file: string): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.name = map === null ? 'car_model' : 'car_model_mapped';
    material.color = new Color(1, 1, 1);
    material.vertexColors = false;
    // The vertex colour is a vec4: rgb, and the prep's `_PAINT` mask in w.
    const atlas = map;
    material.colorNode = Fn(() => {
      const vc = vertexColor();
      // `TextureNode` is typed without swizzles in @types/three; it is a vec4.
      const texel = atlas === null ? null : (texture(atlas, uv()) as unknown as ReturnType<typeof vec4>);
      const base = texel === null ? vc.rgb : texel.rgb.mul(vc.rgb);
      const pc = instancedBufferAttribute(paint, 'vec4') as unknown as ReturnType<typeof vec4>;
      const value = max(base.r, max(base.g, base.b));
      const painted = pc.rgb.mul(value);
      return mix(base.mul(pc.w), painted.mul(pc.w), vc.w);
    })();
    // The same roughness and metalness as `car_paint`, and the same numbers
    // rather than a fresh judgement: `cars.PAINT` was lifted to compensate for
    // exactly this metalness moving energy out of the diffuse term, so a model
    // car drawn with different constants would be a different white from the box
    // car parked behind it. See `world/cars.ts` on the palette.
    material.roughness = 0.35;
    material.metalness = 0.4;
    // **Not** flat-shaded, which is the one place this diverges from the box
    // fleet. A box car is a polyhedron and smooth-shading one makes it read as a
    // melted version of itself; these carry authored normals, and a Kenney body
    // is faceted where the artist faceted it and rounded where they did not.
    material.flatShading = false;
    // **Two-sided.** A Sketchfab car is authored double-sided and half its
    // panels are wound inside-out -- the David_Holiday L200 and the 2021 HiLux
    // draw as a chassis with no body under a single-sided material, which is
    // the owner's "one of the cars is a weird mesh". Two dozen instances a
    // model is nothing to draw twice.
    material.side = DoubleSide;
    void file;
    return material;
  }

  /**
   * Add one model to the end of its body's pool.
   *
   * Called in manifest order, interleaved with `reserveHole`, because the order
   * of a pool *is* the model choice for every car in Sydney. See section 1.
   */
  addModel(entry: CarModelEntry, merged: MergedModel, body: BodyKey): void {
    const paint = new InstancedBufferAttribute(new Float32Array(PER_MODEL_CAPACITY * 4).fill(1), 4);
    paint.setUsage(DynamicDrawUsage);
    const material = this.materialFor(merged.map, paint, entry.file);
    this.materials.push(material);
    const mesh = new InstancedMesh(merged.geometry, material, PER_MODEL_CAPACITY);
    mesh.name = `carmodel_${keyOf(entry.file)}`;
    mesh.count = 0;
    // Culled by the claim radius rather than by the frustum, on exactly
    // `TrafficMovers`' argument: the bounding sphere of a set whose instances
    // change every frame would have to be recomputed every frame, and a radius
    // test the sweep is already doing is free. Every instance in here is within
    // 110 m of the camera by construction.
    mesh.frustumCulled = false;
    // Casts like the car it replaces and does not receive, on `TrafficMovers`'
    // terms: the shadow a car throws down the lane is worth more than the one it
    // catches, and these are the cars close enough for that shadow to be the
    // thing that sits them on the road.
    mesh.castShadow = true;
    // --- APPEARANCE FIX 2: and it catches the shadow it is standing in.
    //
    // `TrafficMovers` and `buildTileCars` both set this false on a stated trade
    // -- "the shadow a car throws down the lane is worth more than the one it
    // catches" -- and that trade is right for *them*: they draw up to 210 movers
    // and 400-odd parked boxes per tile, and a receiver samples the shadow map
    // per fragment.
    //
    // It is the wrong trade here and this is the one fleet where it is. These
    // are the two dozen cars inside `CLAIM_RADIUS` -- the ones a player is
    // standing next to -- and a car in the shade of a terrace lit as though it
    // were in full sun does not sit in the street, it is pasted on top of it.
    // It is also the half of "no shadow contact" that the casting flag cannot
    // fix: at midday a car's own shadow is a thin pool under the sills, and what
    // tells you the car is *in* the world is the building's shadow crossing its
    // roof.
    //
    // Bounded by `CLAIM_RADIUS` and `PER_MODEL_CAPACITY`: at most 24 instances
    // per model, all near the camera, all already inside the shadow volume the
    // buildings around them are being sampled for.
    mesh.receiveShadow = true;
    // Never owned by a tile, so an eviction must never free this geometry -- the
    // same flag the moving fleet carries for the same reason.
    mesh.userData.traffic = true;
    // No `setColorAt` here or anywhere: the paint is `slot.paint`, allocated
    // above at full capacity before the node graph is built, which is the
    // same order-of-construction rule `world/cars.ts` documents for
    // `instanceColor` and the reason the buffer is made before the material.
    this.meshes.push(mesh);

    const pool = this.pools.get(body) ?? [];
    const slot = {
      file: entry.file,
      mesh,
      box: merged.box,
      paint,
      painted: entry.tint === 'multiply',
      claims: [],
      dirty: false,
      triangles: merged.triangles,
    };
    // Weighted by repetition, so a Ranger is picked eight times as often as
    // a filler without a second lookup at claim time. See `CarModelEntry.weight`.
    const weight = Math.max(1, Math.min(16, Math.round(entry.weight ?? 1)));
    for (let i = 0; i < weight; i++) pool.push(slot);
    this.pools.set(body, pool);
    this.loadedFiles.push(entry.file);
    // Only the ones that were actually wrong, and only past a millimetre --
    // a list of 24 zeroes says nothing, and a list of the three files whose
    // tyres were in the road is the whole of the fix stated as data. See
    // `mergeModel`'s appearance fix 1.
    if (merged.seat > 0.001 || merged.seat < -0.001) {
      this.reseated.push({ file: entry.file, byMm: Math.round(-merged.seat * 1000) });
    }
  }

  /** Add a hole to a pool: a model the manifest names that this file will not draw. */
  reserveHole(body: BodyKey, file: string, why: string, weight = 1): void {
    const pool = this.pools.get(body) ?? [];
    // **`weight` holes, not one.** A model that failed to load has to take up
    // exactly the room it would have taken up loaded, or the pool is shorter,
    // the modulus is different and every car in the class is a different model
    // -- which is section 1's whole argument, and which a one-slot hole broke
    // for any entry whose weight is not 1. Every real make in the set has a
    // weight above 1, so before this the first failed fetch re-modelled a
    // suburb.
    const n = Math.max(1, Math.min(16, Math.round(weight)));
    for (let i = 0; i < n; i++) {
      this.holeFiles.set(`${String(body)}:${pool.length}`, file);
      pool.push(null);
    }
    this.pools.set(body, pool);
    this.skipped.push({ file, why });
  }

  /** How many models each body class can draw from, holes included. Diagnostics. */
  poolSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [body, pool] of this.pools) out[String(body)] = pool.length;
    return out;
  }

  /**
   * Every pool as file names, in order, with a hole named for what it was.
   *
   * The one thing `game/carlabels.carPool` has to agree with, and the only way
   * a check can hold the two against each other: the label is
   * `pool[identity % pool.length]` on this side and on that one, so a pool that
   * is a different length or a different order is a hero line that names the
   * wrong car -- silently, and only for the cars whose remainder happens to
   * differ. See `verifyCarModelLabels`.
   */
  poolFiles(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [body, pool] of this.pools) {
      out[String(body)] = pool.map((slot, i) => slot?.file ?? this.holeFiles.get(`${String(body)}:${i}`) ?? '');
    }
    return out;
  }

  /** Which file each hole in a pool stands for, so `poolFiles` can name it. */
  private readonly holeFiles = new Map<string, string>();

  // --- The per-frame half, as `TrafficMovers` sees it ---------------------------

  begin(): boolean {
    // A slot still dirty at the *start* of a frame means nobody called `end()`
    // at the finish of the last one, and that is silent catastrophe rather than
    // a glitch: `claimed()` writes matrices that are never uploaded, so every
    // claimed car draws at whatever the GPU last had -- all zeroes on a mesh
    // that has never uploaded, which is a point rather than a car -- while the
    // box fleet suppresses it precisely because it *was* claimed. The city's
    // near-field cars vanish, and nothing throws.
    //
    // It shipped exactly once, and it was invisible to every check: the sink is
    // a three.js object, so `integration-check.ts` cannot import it, and the
    // contract being broken lives in `main.ts`'s frame loop rather than in this
    // file. So the check lives here, costs one boolean per frame, and says the
    // whole sentence -- a console line nobody reads is worth nothing.
    //
    // **`endedAt`, not the dirty flag alone, and this is the 2026-09 fix.** The
    // test used to be "is any slot dirty at `begin()`", and that is not the
    // question: `sweep()` runs *before* `trafficMovers.update()` on purpose --
    // main.ts states the reason, a claim taken this frame has to be visible to
    // the box fleet on this frame -- and `consider` dirties a slot every time it
    // takes one. So the first sweep that claimed a car raised this error in
    // every session, on a frame whose `end()` was about to run four lines later
    // and upload everything correctly. The owner's console showed it and there
    // was nothing wrong. What actually means "nobody called `end()`" is that the
    // last frame did not end, so that is what is recorded and compared.
    if (!this.warnedNoEnd && this.frameNo > 1 && this.endedAt !== this.frameNo - 1) {
      for (const pool of this.pools.values()) {
        for (const slot of pool) {
          if (slot === null || !slot.dirty) continue;
          this.warnedNoEnd = true;
          // **Flush it, then say so.** The warning alone shipped, and while it
          // was true it was also useless to the player: their near-field cars
          // stayed gone until a reload. `begin()` has already found the dirty
          // slot and `end()` is four lines of `needsUpdate`, so upload it. The
          // car arrives one frame late instead of never, and that holds no
          // matter which path leaked -- the frame loop's own `update -> end`
          // window is clean, so whatever dirties a slot outside it is doing so
          // from a callback nobody has found yet. This turns a silent
          // catastrophe into a diagnostic, which is the correct shape for a
          // bug whose cause is still open.
          this.end();
          console.error(
            '[carlod] end() was not called last frame: claimed cars had matrices ' +
              'that were never uploaded and would have drawn as degenerate points ' +
              'with their boxes suppressed. Flushed them here, one frame late. ' +
              'Something is claiming or revoking outside the frame\'s ' +
              'trafficMovers.update() -> carModels.end() window.',
          );
          break;
        }
        if (this.warnedNoEnd) break;
      }
    }
    this.frameNo++;
    return this.byIdentity.size > 0;
  }

  claimed(pose: CarPose): boolean {
    const claim = this.byIdentity.get(pose.identity);
    // A parked car and a schedule car may hash alike -- `traffic.ts` says so
    // explicitly and calls it a coincidence rather than a bug -- so the kind is
    // checked as well as the number. The loser simply draws as a box.
    if (claim === undefined || claim.parked !== null) return false;
    claim.x = pose.x;
    claim.z = pose.z;
    claim.frame = this.frameNo;
    poseMatrix(pose, claim.matrix);
    claim.slot.mesh.setMatrixAt(claim.index, claim.matrix);
    // **The dent tone, repainted only when it moves.** The paint is written once
    // at `consider` and never again -- a parked car does not change colour --
    // and crash damage is the one thing that breaks that assumption. So it is
    // handled here, where the pose is, rather than by making `consider` run per
    // frame: the comparison is one float against a number already on the claim,
    // and the `setColorAt` happens on the two or three frames a session where a
    // car somebody is looking at actually crashed.
    if (pose.damage !== claim.damage) {
      claim.damage = pose.damage;
      writePaint(claim.slot, claim.index, claim.pr, claim.pg, claim.pb, crumpleTone(pose.damage));
    }
    claim.slot.dirty = true;
    return true;
  }

  /**
   * Fold the box of every stolen parked car flat, and put back the ones that came
   * home. WORKSTREAM S.
   *
   * ---------------------------------------------------------------------------
   * WHAT THIS IS FIXING, AND WHY IT IS NOT A PREDICATE.
   *
   * See `drivenIdentities`: a schedule car is suppressed by *not asking* a
   * lookup, and a parked car has to be un-drawn. `game/driving.ts` section 3 now
   * names this function as the one new consumer of `suppressed` the static fleet
   * needed -- everything else about suppression (the traffic obstacle roster, the
   * hit test, the model claim) was already a predicate in a loop.
   *
   * The failure it removes is unmistakable and would have shipped otherwise: you
   * press `E`, get into a car, drive off -- and the car is *also still parked
   * where it was*, because the instance matrix nobody rewrote is still in the
   * buffer. Two of your car, one of them furniture.
   *
   * ---------------------------------------------------------------------------
   * THE SCAN, AND WHY A LINEAR ONE IS THE RIGHT ANSWER.
   *
   * Locating an identity means finding a tile and an instance index, and the only
   * index that exists is the `Uint32Array` per tile. A `Map<identity, ...>` over
   * the resident ring would be 23,000 entries and a couple of megabytes of
   * browser heap held permanently, to serve a query that fires **once per theft**
   * -- a player steals a handful of cars a session. So: a full scan, about 20
   * microseconds, guarded by `notStatic` so the schedule fleet's identities do not
   * pay for it repeatedly. This is the same trade `sweep` itself makes with its
   * per-tile bounds rejection, one radius wider.
   *
   * O(driven + hidden) per sweep in the steady state, which is O(ones).
   */
  private syncSuppressedStatics(): void {
    // Who is driving what, this sweep. Reused rather than allocated: at 5 Hz a
    // fresh `Set` per call is 300 an hour for a list that is usually empty.
    const driving = this.drivingScratch;
    driving.clear();
    this.drivenIdentities((identity) => { driving.add(identity); });

    for (const identity of driving) {
      if (this.hiddenStatics.has(identity)) continue;
      if (this.notStatic.has(identity)) continue;
      if (!this.hideStatic(identity)) this.notStatic.add(identity);
    }

    // And the ones that came back: a record removed by `recycleFarthest`, or a
    // car whose driver's client left the room. The box goes back exactly as it
    // was, which is the whole of "the static car reappears in its bay" -- there
    // is no state to restore beyond this matrix.
    if (this.hiddenStatics.size === 0) return;
    for (const [identity, held] of [...this.hiddenStatics]) {
      if (driving.has(identity)) continue;
      // Verbatim, through the write that does *not* add the tile origin: this
      // matrix came out of the buffer already in world space. See
      // `InstancePool.getMatrixAt`.
      held.set.setWorldMatrixAt(held.index, held.restore);
      held.set.flush();
      this.hiddenStatics.delete(identity);
    }
  }

  /**
   * Find one parked car by identity and fold its instance flat. False if no
   * resident tile holds it.
   *
   * Any *parked* model claim on it is revoked first, restoring the real matrix
   * before this reads it -- otherwise the matrix in the buffer is `_zero`, which
   * `consider` wrote when it claimed the car, and the restore would put back
   * nothing. A **driven** claim (`parked === null`) is left alone: that is the
   * model of the car the player is now steering, which is the one car in the city
   * where a model rather than a box matters most.
   */
  private hideStatic(identity: number): boolean {
    for (const tile of this.tiles.values()) {
      for (let i = 0; i < tile.count; i++) {
        if (tile.identity[i] !== identity) continue;
        const set = tile.set[i];
        // A body with no claimed span: nothing was ever drawn here, so there is
        // nothing to hide -- but the car *is* a static one, so it must not go on
        // the `notStatic` list and be scanned for forever.
        if (set === null) return true;
        const existing = this.byIdentity.get(identity);
        if (existing !== undefined && existing.parked !== null) this.revoke(existing, true);
        const restore = new Matrix4();
        set.getMatrixAt(tile.index[i], restore);
        set.setWorldMatrixAt(tile.index[i], _zero);
        set.flush();
        this.hiddenStatics.set(identity, { tile, set, index: tile.index[i], restore });
        return true;
      }
    }
    return false;
  }

  /** Scratch for `syncSuppressedStatics`. See there on why it is not allocated per sweep. */
  private readonly drivingScratch = new Set<number>();

  bandBox(identity: number): Readonly<CarModelBox> | null {
    return this.byIdentity.get(identity)?.slot.box ?? null;
  }

  end(): void {
    // Only what changed. A model nobody claimed or moved this frame does not
    // need its whole instance buffer re-uploaded, which is the same rule
    // `TrafficMovers.update` applies to its own sets.
    for (const pool of this.pools.values()) {
      for (const slot of pool) {
        if (slot === null || !slot.dirty) continue;
        slot.mesh.instanceMatrix.needsUpdate = true;
        slot.paint.needsUpdate = true;
        slot.dirty = false;
      }
    }
    // The frame ended. See `begin()`: this, and not the dirty flag, is what
    // `end() was not called` actually means.
    this.endedAt = this.frameNo - 1;
  }

  /**
   * Has the set of cars somebody is driving changed since this was last asked?
   *
   * ---------------------------------------------------------------------------
   * THE JITTER GETTING INTO A CAR, AND WHY IT IS A FRAME-RATE QUESTION.
   *
   * The owner: *"theres a little weird jitter geting into vehicles atm"*.
   * Measured, on the real machinery with a real pool and a real fleet, the
   * mechanism is exact and has nothing to do with the camera:
   *
   *   - A parked car within `CLAIM_RADIUS` holds a **parked** claim. Its box is
   *     folded flat and the model is drawn from a matrix written once.
   *   - You press `E`. `predictTakeCar` makes a driven record on that frame.
   *     `claimed()` refuses the driven pose, because the claim it finds for that
   *     identity is a *parked* one -- so `TrafficMovers` draws the car you are
   *     sitting in as a **box**, at your body, while the **model** of the same
   *     car is still standing in the bay you took it from.
   *   - Nothing fixes that until the next `sweep`, and the sweep is at
   *     `SWEEP_HZ` = 5. Measured at 60 Hz the window is up to **11 frames**
   *     (183 ms); at 144 Hz it is 28. Then the model teleports onto the car.
   *
   * So: two coincident car bodies for a fifth of a second, one of them the
   * wrong shape and the other pulling away from it at up to 8 m/s, followed by
   * a silhouette pop on the car filling the screen. That is the jitter.
   *
   * The fix is not to sweep faster -- the sweep walks every parked car in the
   * ring and its budget is 0.5 ms -- but to sweep *when the answer has changed*,
   * which for this artefact is exactly when the driven set does. `main.ts` asks
   * this once a frame, immediately before the sweep's own 5 Hz gate, and a true
   * answer forces the sweep on that frame. The window closes to zero.
   *
   * **Cost: one walk of the driven records a frame**, which is the field's
   * `all()` -- up to `MAX_DRIVEN_CARS` = 400 records, one multiply and one add
   * each. That is under a microsecond and it is the same walk `drivenIdentities`
   * already does five times a second. It is deliberately *not* a callback from
   * the take, because the driven set also changes when a **remote** player takes
   * a car, when `recycleFarthest` retires one, and when a record arrives in
   * `MSG.CARS` -- four call sites that would each have had to remember, against
   * one question asked in one place.
   *
   * Order-insensitive on purpose: `CarField.all()` compacts on removal, so a
   * hash that depended on order would fire on every retirement anywhere in the
   * city. Sum and xor together separate the cases that matter -- one identity
   * in, one out -- without caring who moved.
   */
  drivenSetChanged(): boolean {
    let sum = 0;
    let xor = 0;
    let n = 0;
    this.drivenIdentities((identity) => {
      sum = (sum + identity) | 0;
      xor ^= identity;
      n++;
    });
    const hash = (((Math.imul(sum, 0x9e3779b1) ^ xor) + n) | 0) >>> 0;
    if (hash === this.drivenHash) return false;
    this.drivenHash = hash;
    return true;
  }

  // --- The sweep ----------------------------------------------------------------

  /**
   * Decide who is a model, at `SWEEP_HZ`. See section 4 on why not per frame.
   *
   * Order matters and is not incidental: claims are confirmed and taken first,
   * releases last, so a car that crossed from one side of the hysteresis band to
   * the other inside one sweep is never briefly neither.
   */
  sweep(field: TrafficField, tick: number, x: number, z: number): void {
    const at = performance.now();
    this.sweepNo++;

    // --- WORKSTREAM S, and it runs **first**, before any claim is taken.
    //
    // Order matters for one specific reason: hiding a box revokes whatever parked
    // claim was standing on it, and `drivenClaims` below is about to take a
    // *driven* claim for the same identity. Doing it the other way round would
    // revoke the claim that had just been taken.
    this.syncSuppressedStatics();

    // --- The schedule fleet, in every stage including the parked ones. A car
    // sitting in a kerb bay between runs is indistinguishable from the 23,020
    // already at that kerb and has to be drawn on the same terms, which is the
    // whole point of `game/traffic.ts`'s park stages.
    forEachCarNear(field, x, z, CLAIM_RADIUS, tick, this.scratch, this.pose, (p) => {
      if (this.suppress !== null && this.suppress(p.identity)) return;
      const body: BodyKey = policeLiveried(p.route, p.slot, p.x, p.z) ? 'police' : p.body;
      this.consider(p.identity, p.x, p.z, body, p.colour, null, 0, p);
    });

    // --- And the driven fleet, on the schedule fleet's own terms: keyed by the
    // same identity, claimed out of the same pools, released by the same rule.
    // No livery, because a car somebody stole is not a police car whatever it
    // was five minutes ago -- and a stolen squad car that kept its chequer would
    // be a *feature*, not this pass's.
    this.drivenClaims((p) => {
      this.consider(p.identity, p.x, p.z, p.body, p.colour, null, 0, p);
    });

    // --- And the parked fleet, tile by tile. The bounds test is what keeps this
    // inside its budget: a resident ring is up to 56 tiles and the claim radius
    // reaches four or nine of them, so all but a handful are rejected on four
    // comparisons rather than on a hundred distance tests each.
    const claimSq = CLAIM_RADIUS * CLAIM_RADIUS;
    for (const tile of this.tiles.values()) {
      if (
        tile.maxX < x - CLAIM_RADIUS || tile.minX > x + CLAIM_RADIUS ||
        tile.maxZ < z - CLAIM_RADIUS || tile.minZ > z + CLAIM_RADIUS
      ) continue;
      for (let i = 0; i < tile.count; i++) {
        const dx = tile.x[i] - x;
        const dz = tile.z[i] - z;
        if (dx * dx + dz * dz > claimSq) continue;
        // WORKSTREAM S: a parked car somebody has driven away is not standing
        // here, so it gets no model claim -- the same clause the schedule fleet's
        // loop above has carried since suppression existed. Its *box* is folded
        // flat by `syncSuppressedStatics`; this is the other half, and without it
        // the car would be drawn as a model at the kerb it left from.
        const identity = tile.identity[i];
        if (this.suppress !== null && this.suppress(identity)) continue;
        this.consider(identity, tile.x[i], tile.z[i], tile.body[i], tile.colour[i], tile, i, null);
      }
    }

    // --- Releases. A claim goes when it is beyond the outer radius, or -- for a
    // mover only -- when it has stopped posing, which is how a car that reached
    // the end of its route leaves. Two frames of grace rather than one because
    // `TrafficMovers.update` is what does the posing and a dropped frame must
    // not evict a car that is still there.
    for (const claim of [...this.byIdentity.values()]) {
      if (claim.sweep === this.sweepNo) continue;
      const dx = claim.x - x;
      const dz = claim.z - z;
      const gone = claim.parked === null && this.frameNo - claim.frame > 2;
      if (gone || dx * dx + dz * dz > RELEASE_RADIUS * RELEASE_RADIUS) this.revoke(claim, true);
    }

    this.claimedCount = this.byIdentity.size;
    this.sweepMs = performance.now() - at;
  }

  /**
   * Confirm or take a claim for one car.
   *
   * `pose` is passed for a schedule car so a claim taken this sweep is drawn at
   * the right place on this frame rather than at the origin until the next
   * `claimed` call; `tile`/`slotIndex` do the same job for a parked one.
   */
  private consider(
    identity: number,
    x: number,
    z: number,
    body: BodyKey,
    colour: number,
    tile: ParkedTile | null,
    tileIndex: number,
    pose: CarPose | null,
  ): void {
    const existing = this.byIdentity.get(identity);
    if (existing !== undefined) {
      // Only the owner refreshes it. An identity collision between the two
      // fleets must not let a parked car keep a mover's claim alive.
      const mine = tile === null ? existing.parked === null : existing.parked?.tile === tile;
      if (mine) {
        existing.sweep = this.sweepNo;
        if (tile !== null) {
          existing.x = x;
          existing.z = z;
        }
      }
      return;
    }

    const pool = this.pools.get(body);
    if (pool === undefined || pool.length === 0) return;
    // The rule. `identity` is already a well-mixed 32-bit number, so the low
    // bits are as good as any -- see `traffic.carHash`.
    const slot = pool[identity % pool.length];
    if (slot === null || slot === undefined) return;
    if (slot.claims.length >= PER_MODEL_CAPACITY) {
      this.overflows++;
      return;
    }

    let parked: ParkedClaim | null = null;
    if (tile !== null) {
      const set = tile.set[tileIndex];
      if (set === null) return;
      const index = tile.index[tileIndex];
      const restore = new Matrix4();
      set.getMatrixAt(index, restore);
      parked = { tile, set, index, restore };
    }

    const claim: Claim = {
      identity,
      slot,
      index: slot.claims.length,
      x,
      z,
      parked,
      sweep: this.sweepNo,
      frame: this.frameNo,
      matrix: new Matrix4(),
      pr: 1,
      pg: 1,
      pb: 1,
      // Undamaged until `claimed` says otherwise, which for a parked car is
      // never: the tile fleet has no crash damage and its claims are never
      // re-posed.
      damage: 0,
    };
    slot.claims.push(claim);
    this.byIdentity.set(identity, claim);
    slot.mesh.count = slot.claims.length;

    if (parked !== null) {
      // The plan position is replaced by the world one the sweep already
      // computed, and the height, heading and size jitter are kept exactly as
      // `buildTileCars` sampled them. That is what puts the model on the same
      // patch of camber, at the same angle, at the same 4 % of scale variation
      // as the box it is standing in for.
      //
      // The overwrite is why nothing here had to change when the parked fleet
      // moved into the pool: the buffer's matrices are world-space now rather
      // than tile-local, and the two coordinates that differ are the two this
      // replaces outright. The other three quantities were never offset.
      //
      // Written once and never again: a parked car does not move.
      parked.restore.decompose(_position, _quaternion, _scale);
      _position.x = tile!.x[tileIndex];
      _position.z = tile!.z[tileIndex];
      claim.matrix.compose(_position, _quaternion, _scale);
      // And the box it replaces, folded flat. See section 3.
      parked.set.setWorldMatrixAt(parked.index, _zero);
      parked.set.flush();
      tile!.claims.add(claim);
    } else if (pose !== null) {
      poseMatrix(pose, claim.matrix);
    }
    slot.mesh.setMatrixAt(claim.index, claim.matrix);

    // Paint. A `multiply` model takes the entity's own colour, which is the
    // colour its box was drawn in a frame ago -- see section 6. A liveried car
    // takes fleet white with no tonal jitter, on `world/cars.ts`' argument that
    // the thing which marks a police car is that it is the *same* white as the
    // one behind it.
    const paint = slot.painted
      ? (body === 'police' ? CAR_LIVERY_WHITE : (CAR_PAINT[colour] ?? CAR_PAINT[0]))
      : WHITE;
    claim.pr = paint[0];
    claim.pg = paint[1];
    claim.pb = paint[2];
    writePaint(slot, claim.index, paint[0], paint[1], paint[2], crumpleTone(claim.damage));
    slot.dirty = true;
  }

  /**
   * Give a claim's instance back.
   *
   * `restore` is false only when the tile that owned the box is being disposed,
   * in which case its span is about to go back to the pool and a write would
   * land in whichever tile is given those instances next. See section 3.
   */
  private revoke(claim: Claim, restore: boolean): void {
    const slot = claim.slot;
    const vacated = claim.index;
    const last = slot.claims.pop()!;
    if (last !== claim) {
      // Keep the instances packed, so `count` is the claim count and no vertex
      // shader ever runs an empty slot. Both the matrix and the paint move with
      // it, and both are rewritten *here* rather than left to the next frame,
      // because a parked claim has no next frame -- it is written once by
      // design, and a compaction is the one thing that can move one.
      last.index = vacated;
      slot.claims[vacated] = last;
      slot.mesh.setMatrixAt(vacated, last.matrix);
      // The crash tone travels with the claim. Without it, a wreck whose
      // neighbour in the instance buffer was released would be repainted in its
      // showroom colour and stay that way until it crashed again.
      writePaint(slot, vacated, last.pr, last.pg, last.pb, crumpleTone(last.damage));
    }
    slot.mesh.count = slot.claims.length;
    slot.dirty = true;
    this.byIdentity.delete(claim.identity);

    if (claim.parked !== null && restore) {
      claim.parked.set.setWorldMatrixAt(claim.parked.index, claim.parked.restore);
      claim.parked.set.flush();
    }
    if (claim.parked !== null) claim.parked.tile.claims.delete(claim);
  }

  // --- The parked fleet's lifecycle ---------------------------------------------

  adopt(
    tileKey: string,
    data: TileCars,
    sets: readonly PooledSet[],
    originX: number,
    originZ: number,
  ): void {
    // No identities means the sidecar was decoded without its tile key, and an
    // identity is the only thing this file can key a model off. Nothing to do.
    if (data.identity.length !== data.count) return;

    // Which span holds which body, by the pool key `buildTileCars` claims under.
    // Read out of the key on exactly the terms it used to be read out of the
    // mesh name, and for the same reason: `buildTileCars` keeps the signature
    // every other builder in the streamer has, and the alternative -- a parallel
    // array of body numbers threaded through the streamer -- is one more thing
    // to keep in step with the claim order. Checked below, because a silent
    // mismatch here would zero-scale the wrong car.
    const byBody = new Map<number, PooledSet>();
    for (const set of sets) {
      const match = /^cars_(\d+)$/.exec(set.claim.key);
      if (match) byBody.set(Number(match[1]), set);
    }

    const tile: ParkedTile = {
      count: data.count,
      identity: data.identity,
      x: new Float32Array(data.count),
      z: new Float32Array(data.count),
      body: data.body,
      colour: data.colour,
      set: new Array<PooledSet | null>(data.count).fill(null),
      index: new Uint16Array(data.count),
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
      claims: new Set(),
    };

    // The per-body running index is not re-derived any more: it is
    // `binCarsByBody`, the same call `buildTileCars` laid the spans out with, so
    // "instance `n` of a body's span is the n-th car of that body in sidecar
    // order" is one fact in one function rather than two loops that agree. See
    // that function on what a disagreement looked like.
    const bins = binCarsByBody(data.body, data.count, BODY_COUNT);
    for (let i = 0; i < data.count; i++) {
      const worldX = data.x[i] + originX;
      const worldZ = data.z[i] + originZ;
      tile.x[i] = worldX;
      tile.z[i] = worldZ;
      if (worldX < tile.minX) tile.minX = worldX;
      if (worldX > tile.maxX) tile.maxX = worldX;
      if (worldZ < tile.minZ) tile.minZ = worldZ;
      if (worldZ > tile.maxZ) tile.maxZ = worldZ;
      tile.index[i] = bins.slot[i];
      tile.set[i] = byBody.get(data.body[i]) ?? null;
    }
    // The check that keeps the *claim* honest, and it is worth more now than it
    // was: a span's length is the pool's answer rather than a constructor
    // argument this file can see, so a claim short of its bin -- a truncation, a
    // key collided with another builder's, a body binned twice -- would have
    // this file zero-scaling instances belonging to some other tile's cars. A
    // tile that disagrees is one this file refuses to touch rather than one it
    // corrupts.
    for (const [body, set] of byBody) {
      const binned = bins.members[body]?.length ?? 0;
      if (set.claim.count !== binned) {
        console.warn(
          `[carlod] tile ${tileKey} claimed ${set.claim.count} instances of body ${body} where the ` +
            `sidecar has ${binned}; its parked cars will not be modelled.`,
        );
        return;
      }
    }
    this.tiles.set(tileKey, tile);
    // WORKSTREAM S: a tile arriving can turn a miss into a hit -- somebody else's
    // stolen car may be parked in it. See `notStatic`.
    this.notStatic.clear();

    // --- And the same cars again, as obstacles the moving fleet steers round.
    //
    // The **height comes off the instance matrix** rather than out of a terrain
    // query, and that is the whole reason this is done here rather than in the
    // streamer: `buildTileCars` has already put every one of these cars on the
    // ground with the tile's own height grid, and element 13 of its matrix is
    // that answer. A second query would be a second opinion about where the road
    // is, on a fleet whose whole job is to be exactly where the road is -- and the
    // vertical gate in `traffic.resolveLaneShare` is what stops a car parked on
    // the Cahill Expressway pushing the traffic aside eight metres below it, so it
    // has to be the real number.
    if (this.obstacles !== null) {
      const y = new Float32Array(data.count);
      for (let i = 0; i < data.count; i++) {
        const set = tile.set[i];
        if (set === null) {
          // No claimed span for this body: nothing was drawn, so there is
          // nothing standing there to drive round either.
          y[i] = NaN;
          continue;
        }
        // Element 13 is the *height*, which is the one component of the
        // translation the pool does not touch -- it folds the tile origin into
        // 12 and 14 only. So this reads the same number it read when these
        // matrices were tile-local, and the vertical gate in
        // `traffic.resolveLaneShare` is still being given the real one.
        set.getMatrixAt(tile.index[i], _matrix);
        y[i] = _matrix.elements[13];
      }
      this.obstacles.adoptStatics(
        tileKey,
        data.count,
        data.x,
        data.z,
        y,
        data.body,
        data.seed,
        data.identity,
        originX,
        originZ,
      );
    }
  }

  release(tileKey: string): void {
    const tile = this.tiles.get(tileKey);
    if (tile === undefined) return;
    // Without restoring: the tile's spans go back to the pool the moment this
    // returns, and the pool may hand the same instances to the next tile that
    // streams in. See section 3 on why the streamer calls this *first*.
    for (const claim of [...tile.claims]) this.revoke(claim, false);
    // WORKSTREAM S: and any folded box in this tile is forgotten rather than
    // restored, for exactly the reason the claims above are -- writing into a
    // span that is about to be given away puts this car in another suburb. The
    // car is still suppressed and still driven; if the tile comes back, `syncSuppressedStatics`
    // folds the fresh instance flat again on the next sweep, which is what
    // clearing `notStatic` in `adopt` is for.
    for (const [identity, held] of [...this.hiddenStatics]) {
      if (held.tile === tile) this.hiddenStatics.delete(identity);
    }
    this.notStatic.clear();
    this.tiles.delete(tileKey);
    // The obstacles go with them. Keyed separately from the tile's *lanes* inside
    // `LaneObstacles`, because the two are held on different clocks -- see
    // `adoptStatics`.
    this.obstacles?.dropStatics(tileKey);
  }

  /**
   * Tiles whose parked cars this file can reach, and how many cars that is.
   *
   * The one number that separates "nothing is near enough" from "the streamer
   * never handed anything over", which are the same picture and completely
   * different bugs. Diagnostics only.
   */
  get parkedTiles(): { tiles: number; cars: number } {
    let cars = 0;
    for (const tile of this.tiles.values()) cars += tile.count;
    return { tiles: this.tiles.size, cars };
  }

  /** Triangles resident in the claimed instances right now. Diagnostics only. */
  get triangles(): number {
    let n = 0;
    for (const pool of this.pools.values()) {
      for (const slot of pool) if (slot) n += slot.triangles * slot.claims.length;
    }
    return n;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}

/** `tint: "none"` instances are drawn as authored. */
const WHITE: readonly [number, number, number] = [1, 1, 1];

/**
 * Compose a claimed mover's matrix from its pose.
 *
 * The heading is taken off the pose's unit direction with no `Math.atan2` in it,
 * on `TrafficMovers.update`'s own arithmetic and for its reason -- the car's
 * local +X is its nose, so the rotation sending +X to `(dx, 0, dz)` is a yaw of
 * `atan2(-dz, dx)`, whose half-angle quaternion is one square root rather than
 * three transcendentals. Duplicated rather than shared because factoring it out
 * would put a call in the middle of the hottest loop in the traffic for four
 * lines of arithmetic.
 */
function poseMatrix(pose: CarPose, out: Matrix4): void {
  _position.set(pose.x, pose.y, pose.z);
  const c = pose.dx;
  const s = -pose.dz;
  const w2 = (1 + c) * 0.5;
  if (w2 > 1e-12) {
    const w = Math.sqrt(w2);
    _quaternion.set(0, s / (2 * w), 0, w);
  } else {
    _quaternion.set(0, 1, 0, 0);
  }
  // **The dents, folded in here rather than at the caller.** `world/cars.ts`
  // owns the deformation (`crumpleScale`) and the near-field fleet has to apply
  // the identical one: a car that straightened itself out as the player walked
  // up to it and became a model would be the most visible possible failure of
  // the LOD swap, and is precisely the "type switch at the boundary" this file's
  // header says it has none of. Zero for every ambient car, which is all but two
  // or three of the claims in any frame.
  crumpleScale(pose, _scale);
  out.compose(_position, _quaternion, _scale);
}

// --- Loading --------------------------------------------------------------------

/**
 * Fetch the manifest and every model this client has an entity for.
 *
 * Failure is survivable at every step and lands in the same place: a client that
 * draws exactly the box fleet it drew before this pass existed. That is the same
 * contract `loadLandmarks` has, and here it is stronger -- a missing model is
 * not a missing feature, it is a car that stays a box, which is a picture this
 * game shipped for its whole life.
 *
 * `baseUrl` is the client's own asset root rather than the world's: these files
 * ship with the build and are not stamped by the world version, because a car
 * model is not a fact about Sydney's geometry.
 */
export async function loadCarModels(
  baseUrl = MODEL_DIR,
  pose: CarPose,
): Promise<CarModelFleet | null> {
  let manifest: CarModelEntry[];
  try {
    const response = await fetch(`${baseUrl}manifest.json`);
    if (!response.ok) throw new Error(`manifest.json: HTTP ${response.status}`);
    manifest = (await response.json()) as CarModelEntry[];
    if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('manifest is empty');
  } catch (err) {
    console.warn('[carlod] no car models; the near field stays boxes.', err);
    return null;
  }

  // --- The drift guard. See `game/carlabels.ts` section 2.
  //
  // `CAR_FLEET` is a second copy of four of this manifest's fields, held
  // three-free so the hero line and the boot checks can have them without a
  // fetch. Two copies of one fact need a moment where they are compared, and
  // this is the only moment in the game where both exist: the table is a module
  // and the manifest has just landed. A mismatch is not fatal -- the manifest
  // is still what gets drawn, so the city is right and only the *name* is stale
  // -- but it is loud, and it names the row rather than the fact of a
  // difference, because "the car table is out of date" without a row is a
  // twenty-minute diff.
  {
    const drift: string[] = [];
    for (let i = 0; i < Math.max(manifest.length, CAR_FLEET.length); i++) {
      const a = manifest[i];
      const b = CAR_FLEET[i];
      if (a === undefined) { drift.push(`manifest is missing ${b.file}`); continue; }
      if (b === undefined) { drift.push(`CAR_FLEET is missing ${a.file}`); continue; }
      if (a.file !== b.file) { drift.push(`row ${i}: manifest has ${a.file}, CAR_FLEET has ${b.file}`); continue; }
      if (a.body !== b.body) drift.push(`${a.file}: body ${String(a.body)} vs ${String(b.body)}`);
      if ((a.weight ?? 1) !== b.weight) drift.push(`${a.file}: weight ${a.weight ?? 1} vs ${b.weight}`);
      if (a.label !== undefined && a.label !== b.label) drift.push(`${a.file}: label "${a.label}" vs "${b.label}"`);
    }
    if (drift.length > 0) {
      console.error(
        '[carlod] `client/public/cars/manifest.json` and `game/carlabels.CAR_FLEET` disagree, so ' +
          'the hero line names a car the fleet does not draw. Fix the table: ' +
          drift.join('; '),
      );
    }
  }

  // One loader for the whole set, as `loadLandmarks` uses one for the landmark
  // file: bytes first and then `parseAsync`, so a CDN serving these gzipped is
  // not fetched twice.
  const loader = new GLTFLoader();
  const skipped: Array<{ file: string; why: string; body: BodyKey }> = [];

  // Fetched in parallel and merged in manifest order, because the order is the
  // contract and a promise race is not an order. 15 mapped files at ~100 kB.
  const wanted = manifest
    .map((entry) => ({ entry, body: mappedBody(entry) }))
    .filter((row): row is { entry: CarModelEntry; body: BodyKey } => row.body !== null);
  const bytes = await Promise.all(
    wanted.map(async (row) => {
      try {
        const response = await fetch(`${baseUrl}${row.entry.file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.arrayBuffer();
      } catch (err) {
        console.warn(`[carlod] ${row.entry.file} did not load:`, err);
        return null;
      }
    }),
  );

  const built: Array<{ entry: CarModelEntry; merged: MergedModel; body: BodyKey }> = [];
  for (let i = 0; i < wanted.length; i++) {
    const { entry, body } = wanted[i];
    const buffer = bytes[i];
    if (buffer === null) {
      skipped.push({ file: entry.file, why: 'fetch failed', body });
      continue;
    }
    try {
      const gltf = await loader.parseAsync(buffer, '');
      const merged = mergeModel(gltf.scene, entry.tint, YAW_CORRECTION[keyOf(entry.file)] ?? 0);
      const limits = bodyLimits(body);
      if (
        merged.box.height > limits.height * PROPORTION_LIMIT ||
        merged.box.width > limits.width * PROPORTION_LIMIT
      ) {
        merged.geometry.dispose();
        skipped.push({
          file: entry.file,
          why:
            `${merged.box.length.toFixed(1)} x ${merged.box.width.toFixed(1)} x ` +
            `${merged.box.height.toFixed(1)} m is not a car of this class ` +
            `(${limits.length} x ${limits.width} x ${limits.height})`,
          body,
        });
        continue;
      }
      built.push({ entry, merged, body });
    } catch (err) {
      console.warn(`[carlod] ${entry.file} would not parse:`, err);
      skipped.push({ file: entry.file, why: 'parse failed', body });
    }
  }

  if (built.length === 0) {
    console.warn('[carlod] every car model was unusable; the near field stays boxes.');
    return null;
  }

  // **One pass over `wanted`, in manifest order**, pushing either the model or
  // its hole. This loop is the contract from section 1: a pool's order is the
  // manifest's, and a file that failed leaves a gap rather than shortening the
  // modulus and re-modelling every car in Sydney.
  const surviving = new Map(built.map((b) => [b.entry.file, b]));
  const fleet = new CarModelFleet(pose);
  for (const { entry, body } of wanted) {
    const hit = surviving.get(entry.file);
    if (hit !== undefined) fleet.addModel(entry, hit.merged, body);
    else {
      fleet.reserveHole(
        body,
        entry.file,
        skipped.find((s) => s.file === entry.file)?.why ?? 'unavailable',
        entry.weight ?? 1,
      );
    }
  }

  return fleet;
}

/** The tile key a yaw correction is filed under: the file name without its suffix. */
function keyOf(file: string): string {
  return file.replace(/\.glb$/, '');
}

/**
 * What a car of this body class actually measures, for the proportion test.
 *
 * The five rows are `world/cars.BODY_SPEC`'s, which is also `CAR_BODY_SIZE`'s,
 * which is also the hit box's -- so a model this test accepts is one whose
 * silhouette agrees with the box that knocks you over. Restated here rather than
 * imported because `CAR_BODY_SIZE` is a flat list and this needs a police row
 * too, and the police car is not a sixth body class: it is a livery on whichever
 * body the schedule already drew.
 */
function bodyLimits(body: BodyKey): CarModelBox {
  switch (body) {
    case 0: return { length: 4.6, width: 1.8, height: 1.45 };
    case 1: return { length: 4.2, width: 1.75, height: 1.5 };
    case 2: return { length: 4.7, width: 1.9, height: 1.7 };
    case 3: return { length: 5.2, width: 1.85, height: 1.8 };
    case 4: return { length: 5.4, width: 1.9, height: 2.0 };
    // A marked car is a sedan or an SUV wearing a livery, so it is measured
    // against the taller of the two.
    default: return { length: 4.7, width: 1.9, height: 1.7 };
  }
}
