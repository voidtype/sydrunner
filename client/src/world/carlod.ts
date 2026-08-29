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
 *     car has its matrix in the tile's own `InstancedMesh` overwritten with a
 *     **zero scale** and restored on release. Zero-scale rather than a count
 *     change because a tile's instances are not orderable: they are packed per
 *     body type in sidecar order and moving one would move somebody else's.
 *
 *     A zero-scaled instance still runs its vertex shader, and that is the price:
 *     110 wasted vertices per claimed car, against at most a couple of dozen
 *     claims. Reordering the tile to keep the drawn ones contiguous would save
 *     it and would mean rewriting a tile's whole matrix buffer on every claim.
 *
 *     **Eviction is the trap here.** A tile can stream out while one of its cars
 *     is claimed, and its `InstancedMesh` is disposed with it. So the claim is
 *     dropped by `release(tileKey)` *without* restoring -- touching a disposed
 *     buffer is the failure this pairing exists to prevent -- and the tile's own
 *     matrices are rebuilt from the sidecar if it ever comes back, which puts the
 *     car back exactly where it was. See `TileStreamer.dispose`.
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
 * `client/public/cars/manifest.json` names 29 normalised `.glb` files. They are
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

import {
  BufferAttribute,
  BufferGeometry,
  Color,
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
import { BODY_COUNT, CAR_LIVERY_WHITE, CAR_PAINT, crumpleScale, crumpleTone, type TileCars } from './cars.ts';

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
   * `meshes` are the tile's own instanced sets as `buildTileCars` returned them,
   * and `originX`/`originZ` are the tile group's translation -- the sidecar's
   * coordinates are tile-local and every distance this file measures is not.
   */
  adopt(
    tileKey: string,
    data: TileCars,
    meshes: readonly InstancedMesh[],
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
 * The claim radius holds roughly 60 parked cars in a suburban street and about
 * 150 in the CBD, spread by `identity % pool.length` over the five to six models
 * of whichever body class -- so a dozen or so per model at the worst measured
 * point, and this is twice that again. It is a hard ceiling rather than a
 * guideline: a car that finds its model full simply is not claimed and draws as
 * the box it already was, which is the correct way for this feature to run out
 * of room.
 *
 * An `InstancedMesh` costs its capacity in buffer bytes and its `count` in draw
 * work, so the headroom is 24 x 80 bytes x 24 meshes = 46 kB and no frame time.
 */
const PER_MODEL_CAPACITY = 24;

/**
 * Files authored nose-toward `-X`, corrected by half a turn at merge time.
 *
 * **Established by rendering every file in the set from a camera parked off its
 * +X end**: a correctly authored model shows its grille and headlights there,
 * and these five showed a tailgate, a tray or a spare wheel. That test is worth
 * naming because the cheap proxies all fail -- a cabin-offset heuristic calls
 * every ute backwards and misses `nissan_terrano`, and a bounding box says
 * nothing at all.
 *
 * Note for whoever curates the manifest next: the four files flagged there as
 * low-confidence were `city_bus`, `hatch_micro`, `suv_generic_b` and
 * `vw_golf_mk`. Two of those four are fine (`hatch_micro` faces the right way,
 * and `suv_generic_b` is not a car at all -- see `PROPORTION_LIMIT`), and four
 * files nobody suspected are backwards. The flags were not a superset.
 *
 * Baked into the geometry rather than applied per instance: it is a property of
 * the file, it never changes, and a per-frame rotation would be a transcendental
 * per claimed car for a constant.
 */
const YAW_CORRECTION: Readonly<Record<string, number>> = {
  // Rear doors and the destination sign are at -X. Unmapped today; corrected so
  // that mapping a bus later does not start by rediscovering this.
  city_bus: Math.PI,
  // The hopper is at +X. Likewise unmapped.
  garbage_truck_kenney: Math.PI,
  // Tray and tail lights at +X, grille and badge at -X.
  mitsubishi_l200: Math.PI,
  // Spare wheel on the tailgate at +X.
  nissan_terrano: Math.PI,
  // Number plate and tail lights at +X; round headlights and a grille at -X.
  sedan_generic_a: Math.PI,
  // Open flatbed at +X, cab at -X.
  van_generic_a: Math.PI,
  // Hatchback tailgate at +X.
  vw_golf_mk: Math.PI,
};

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
 * 1.8x is deliberately generous. The Kenney kit is chunky on purpose and lands
 * between 1.3x and 1.5x, which is the toy-like direction `world/cars.ts` and
 * spec 8.1 already commit to; the only file in the set this rejects is the rover.
 *
 * A rejected model **keeps its slot in the pool** (section 1) so the rejection
 * cannot re-model the rest of the city. The cars that hash to it draw as boxes.
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
  /** `0`..`4` for the five body classes, or a named role. */
  body: number | 'police' | 'taxi' | 'bus' | 'garbage';
  tris: number;
  lengthM: number;
  tint: 'multiply' | 'none';
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
const _colour = /*#__PURE__*/ new Color();
const _zero = /*#__PURE__*/ new Matrix4().makeScale(0, 0, 0);

/** One primitive's contribution, held while the two passes of the merge run. */
interface Piece {
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex, before the value collapse. */
  colours: Float32Array;
  index: Uint32Array;
  triangles: number;
}

/**
 * sRGB to linear, for texels read off a canvas.
 *
 * Material colours arrive from `GLTFLoader` already in the working (linear)
 * space -- glTF's `baseColorFactor` is defined linear -- so only sampled texels
 * need this. Written out rather than reached for through `ColorManagement` so
 * that the one place a colour space is converted in this file is visible.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Every texel of a texture, once.
 *
 * Cached across models because two files in the set share `citybits_texture`,
 * and because a 1024 x 1024 read-back is the single most expensive thing this
 * module does at load.
 */
const texelCache = new Map<string, ImageData | null>();

function readTexels(texture: Texture): ImageData | null {
  const image = texture.image as
    | (CanvasImageSource & { width?: number; height?: number })
    | undefined;
  if (!image) return null;
  const key = texture.uuid;
  const hit = texelCache.get(key);
  if (hit !== undefined) return hit;
  let data: ImageData | null = null;
  try {
    const width = image.width ?? 0;
    const height = image.height ?? 0;
    if (width > 0 && height > 0) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        data = ctx.getImageData(0, 0, width, height);
      }
    }
  } catch (err) {
    // A texture that will not read back costs its model the texture's colours,
    // not the model. The material factor below still applies.
    console.warn('[carlod] could not read a model texture back:', err);
  }
  texelCache.set(key, data);
  return data;
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
    const map = (material as { map?: Texture | null }).map ?? null;
    const texels = map ? readTexels(map) : null;

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);

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
      if (texels && uv) {
        // glTF puts the UV origin at the image's top-left and `GLTFLoader`
        // carries that through as `flipY = false`, so `v` indexes rows from the
        // top with no flip. Nearest, wrapped: these are palette atlases and flat
        // per-island maps, where a filtered read would only blend two patches
        // that were never meant to meet.
        const px = wrapTexel(uv.getX(i), texels.width);
        const py = wrapTexel(uv.getY(i), texels.height);
        const o = (py * texels.width + px) * 4;
        r *= srgbToLinear(texels.data[o] / 255);
        g *= srgbToLinear(texels.data[o + 1] / 255);
        b *= srgbToLinear(texels.data[o + 2] / 255);
      }
      colours[i * 3] = r;
      colours[i * 3 + 1] = g;
      colours[i * 3 + 2] = b;
      // V, the maximum channel. See section 6 on why this is not luminance.
      materials[slot].values.push(Math.max(r, g, b));
    }

    const source = index ? index.array : null;
    const merged = new Uint32Array(index ? index.count : count);
    if (source) {
      for (let i = 0; i < merged.length; i++) merged[i] = source[i] as number;
    } else {
      for (let i = 0; i < merged.length; i++) merged[i] = i;
    }
    pieces.push({ positions, normals, colours, index: merged, triangles });
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
  const colours = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let vOffset = 0;
  let iOffset = 0;
  for (const p of pieces) {
    positions.set(p.positions, vOffset * 3);
    normals.set(p.normals, vOffset * 3);
    const n = p.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const o = (vOffset + i) * 3;
      if (tint === 'multiply') {
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
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
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
    seat,
    box: {
      length: bounds.max.x - bounds.min.x,
      width: bounds.max.z - bounds.min.z,
      height: bounds.max.y - bounds.min.y,
    },
    triangles: indexTotal / 3,
  };
}

/** Nearest texel on a wrapped axis. */
function wrapTexel(t: number, size: number): number {
  const i = Math.floor(t * size);
  return ((i % size) + size) % size;
}

// --- One model, ready to draw ---------------------------------------------------

/** A loaded model file and the instances currently wearing it. */
interface ModelSlot {
  file: string;
  mesh: InstancedMesh;
  box: CarModelBox;
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

/** The tile instance a claim has zero-scaled, and what to put back. */
interface ParkedClaim {
  tile: ParkedTile;
  mesh: InstancedMesh;
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
  /** Which instanced set each car lives in, and where within it. */
  mesh: Array<InstancedMesh | null>;
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
  readonly material: MeshStandardNodeMaterial;

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
   * A **parked** car is not a lookup. It is an instance matrix in a tile's
   * `InstancedMesh`, written once by `buildTileCars` when the tile arrived, and
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
    mesh: InstancedMesh;
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
    this.material = new MeshStandardNodeMaterial();
    this.material.name = 'car_model';
    // No `colorNode`, exactly as `CarAssets` has none: `NodeMaterial` already
    // multiplies the material colour by the geometry `color` attribute and then
    // by `instanceColor`, so the model's baked value and the entity's paint both
    // arrive through built-in multiplies and no shader graph at all.
    this.material.vertexColors = true;
    this.material.color = new Color(1, 1, 1);
    // The same roughness and metalness as `car_paint`, and the same numbers
    // rather than a fresh judgement: `cars.PAINT` was lifted to compensate for
    // exactly this metalness moving energy out of the diffuse term, so a model
    // car drawn with different constants would be a different white from the box
    // car parked behind it. See `world/cars.ts` on the palette.
    this.material.roughness = 0.35;
    this.material.metalness = 0.4;
    // **Not** flat-shaded, which is the one place this diverges from the box
    // fleet. A box car is a polyhedron and smooth-shading one makes it read as a
    // melted version of itself; these carry authored normals, and a Kenney body
    // is faceted where the artist faceted it and rounded where they did not.
    this.material.flatShading = false;
  }

  /**
   * Add one model to the end of its body's pool.
   *
   * Called in manifest order, interleaved with `reserveHole`, because the order
   * of a pool *is* the model choice for every car in Sydney. See section 1.
   */
  addModel(entry: CarModelEntry, merged: MergedModel, body: BodyKey): void {
    const mesh = new InstancedMesh(merged.geometry, this.material, PER_MODEL_CAPACITY);
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
    // **The paint buffer, allocated here and not by the first `setColorAt` in a
    // claim, and this line is load-bearing.** `InstancedMesh` allocates
    // `instanceColor` lazily and `NodeMaterial.setupDiffuseColor` multiplies by
    // it *only when the attribute exists at the moment the node graph is built*,
    // with nothing in the cache key to force a rebuild when it appears later.
    // The boot scene pass compiles these before a single car has been claimed,
    // so without this every model would draw in its base value and no paint at
    // all -- the exact bug `world/cars.ts` documents shipping once in the moving
    // fleet.
    mesh.setColorAt(0, _colour.setRGB(1, 1, 1));
    this.meshes.push(mesh);

    const pool = this.pools.get(body) ?? [];
    pool.push({
      file: entry.file,
      mesh,
      box: merged.box,
      painted: entry.tint === 'multiply',
      claims: [],
      dirty: false,
      triangles: merged.triangles,
    });
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
  reserveHole(body: BodyKey, file: string, why: string): void {
    const pool = this.pools.get(body) ?? [];
    pool.push(null);
    this.pools.set(body, pool);
    this.skipped.push({ file, why });
  }

  /** How many models each body class can draw from, holes included. Diagnostics. */
  poolSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [body, pool] of this.pools) out[String(body)] = pool.length;
    return out;
  }

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
    if (!this.warnedNoEnd && this.frameNo > 1) {
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
      const tone = crumpleTone(pose.damage);
      claim.slot.mesh.setColorAt(claim.index, _colour.setRGB(claim.pr * tone, claim.pg * tone, claim.pb * tone));
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
      held.mesh.setMatrixAt(held.index, held.restore);
      held.mesh.instanceMatrix.needsUpdate = true;
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
        const mesh = tile.mesh[i];
        // A body with no instanced set: nothing was ever drawn here, so there is
        // nothing to hide -- but the car *is* a static one, so it must not go on
        // the `notStatic` list and be scanned for forever.
        if (mesh === null) return true;
        const existing = this.byIdentity.get(identity);
        if (existing !== undefined && existing.parked !== null) this.revoke(existing, true);
        const restore = new Matrix4();
        mesh.getMatrixAt(tile.index[i], restore);
        mesh.setMatrixAt(tile.index[i], _zero);
        mesh.instanceMatrix.needsUpdate = true;
        this.hiddenStatics.set(identity, { tile, mesh, index: tile.index[i], restore });
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
    // need its 24-instance buffer re-uploaded, which is the same rule
    // `TrafficMovers.update` applies to its own sets.
    for (const pool of this.pools.values()) {
      for (const slot of pool) {
        if (slot === null || !slot.dirty) continue;
        slot.mesh.instanceMatrix.needsUpdate = true;
        if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
        slot.dirty = false;
      }
    }
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
      const mesh = tile.mesh[tileIndex];
      if (mesh === null) return;
      const index = tile.index[tileIndex];
      const restore = new Matrix4();
      mesh.getMatrixAt(index, restore);
      parked = { tile, mesh, index, restore };
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
      // The tile's matrix is *tile-local* -- its cars hang off the tile group and
      // inherit its translation -- and this fleet hangs off the scene, so the
      // plan position is replaced by the world one the sweep already computed
      // and the height, heading and size jitter are kept exactly as
      // `buildTileCars` sampled them. That is what puts the model on the same
      // patch of camber, at the same angle, at the same 4 % of scale variation
      // as the box it is standing in for.
      //
      // Written once and never again: a parked car does not move.
      parked.restore.decompose(_position, _quaternion, _scale);
      _position.x = tile!.x[tileIndex];
      _position.z = tile!.z[tileIndex];
      claim.matrix.compose(_position, _quaternion, _scale);
      // And the box it replaces, folded flat. See section 3.
      parked.mesh.setMatrixAt(parked.index, _zero);
      parked.mesh.instanceMatrix.needsUpdate = true;
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
    slot.mesh.setColorAt(claim.index, _colour.setRGB(paint[0], paint[1], paint[2]));
    slot.dirty = true;
  }

  /**
   * Give a claim's instance back.
   *
   * `restore` is false only when the tile that owned the box is being disposed,
   * in which case writing to its buffer is a use-after-free. See section 3.
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
      const tone = crumpleTone(last.damage);
      slot.mesh.setColorAt(vacated, _colour.setRGB(last.pr * tone, last.pg * tone, last.pb * tone));
    }
    slot.mesh.count = slot.claims.length;
    slot.dirty = true;
    this.byIdentity.delete(claim.identity);

    if (claim.parked !== null && restore) {
      claim.parked.mesh.setMatrixAt(claim.parked.index, claim.parked.restore);
      claim.parked.mesh.instanceMatrix.needsUpdate = true;
    }
    if (claim.parked !== null) claim.parked.tile.claims.delete(claim);
  }

  // --- The parked fleet's lifecycle ---------------------------------------------

  adopt(
    tileKey: string,
    data: TileCars,
    meshes: readonly InstancedMesh[],
    originX: number,
    originZ: number,
  ): void {
    // No identities means the sidecar was decoded without its tile key, and an
    // identity is the only thing this file can key a model off. Nothing to do.
    if (data.identity.length !== data.count) return;

    // Which instanced set holds which body, by the name `buildTileCars` gives
    // them. Re-derived rather than handed over so that `buildTileCars` keeps the
    // signature every other caller has -- and checked below, because a silent
    // mismatch here would zero-scale the wrong car.
    const byBody = new Map<number, InstancedMesh>();
    for (const mesh of meshes) {
      const match = /^cars_(\d+)$/.exec(mesh.name);
      if (match) byBody.set(Number(match[1]), mesh);
    }

    const tile: ParkedTile = {
      count: data.count,
      identity: data.identity,
      x: new Float32Array(data.count),
      z: new Float32Array(data.count),
      body: data.body,
      colour: data.colour,
      mesh: new Array<InstancedMesh | null>(data.count).fill(null),
      index: new Uint16Array(data.count),
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
      claims: new Set(),
    };

    // The per-body running index is exactly `buildTileCars`' own: it bins the
    // sidecar by body in index order and instance `n` of a body's set is the
    // n-th car of that body. One loop, the same order, no shared state.
    const seen = new Int32Array(BODY_COUNT);
    for (let i = 0; i < data.count; i++) {
      const worldX = data.x[i] + originX;
      const worldZ = data.z[i] + originZ;
      tile.x[i] = worldX;
      tile.z[i] = worldZ;
      if (worldX < tile.minX) tile.minX = worldX;
      if (worldX > tile.maxX) tile.maxX = worldX;
      if (worldZ < tile.minZ) tile.minZ = worldZ;
      if (worldZ > tile.maxZ) tile.maxZ = worldZ;
      const body = data.body[i];
      const mesh = byBody.get(body) ?? null;
      tile.index[i] = seen[body]++;
      tile.mesh[i] = mesh;
    }
    // The check the re-derivation earns its keep with: every set's capacity must
    // be exactly the number of cars binned into it. A tile that disagrees is one
    // this file refuses to touch rather than one it corrupts.
    for (const [body, mesh] of byBody) {
      if (mesh.count !== seen[body]) {
        console.warn(
          `[carlod] tile ${tileKey} has ${mesh.count} instances of body ${body} where the ` +
            `sidecar has ${seen[body]}; its parked cars will not be modelled.`,
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
        const mesh = tile.mesh[i];
        if (mesh === null) {
          // No instanced set for this body: nothing was drawn, so there is
          // nothing standing there to drive round either.
          y[i] = NaN;
          continue;
        }
        mesh.getMatrixAt(tile.index[i], _matrix);
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
    // Without restoring: the meshes are about to be disposed with the tile.
    for (const claim of [...tile.claims]) this.revoke(claim, false);
    // WORKSTREAM S: and any folded box in this tile is forgotten rather than
    // restored, for exactly the reason the claims above are -- writing to a
    // buffer that is about to be freed is a use-after-free. The car is still
    // suppressed and still driven; if the tile comes back, `syncSuppressedStatics`
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
    this.material.dispose();
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

  // One loader for the whole set, as `loadLandmarks` uses one for the landmark
  // file: bytes first and then `parseAsync`, so a CDN serving these gzipped is
  // not fetched twice.
  const loader = new GLTFLoader();
  const skipped: Array<{ file: string; why: string; body: BodyKey }> = [];

  // Fetched in parallel and merged in manifest order, because the order is the
  // contract and a promise race is not an order. 25 files at ~100 kB.
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
      );
    }
  }

  // Texture read-backs are per session and per texture, and nothing needs them
  // once every model is merged.
  texelCache.clear();
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
