/**
 * The trains themselves: two hero models, an impostor for everything else, and
 * doors that open for the fifteen-second dwell.
 *
 * `game/rail.ts` says where every train in Sydney is at any instant and this
 * file draws the handful of them anybody can see. Nothing here can reach
 * `poseTrain`; it reads it.
 *
 * ---------------------------------------------------------------------------
 * 1. TWO REAL MODELS, AND WHAT THEY ARRIVED AS.
 *
 * `scripts/prep-train-models.mjs` is the other half of this file and its header
 * carries the whole story. What matters here:
 *
 *   - `trains/tangara.glb` holds **four carriage templates** -- a driving car and
 *     an intermediate, each in the standard livery and in the Pride livery -- not
 *     one train. 4.79 MB.
 *   - `trains/metropolis.glb` holds **three**: a lead car, the pantograph car and
 *     a trailer. 5.68 MB.
 *   - Which meshes belong to which carriage is decided **by position**, against
 *     the boxes in `manifest.json`, and never by node name: three's `GLTFLoader`
 *     runs every name through `PropertyBinding.sanitizeNodeName` and then
 *     uniquifies whatever that collided, so `DoorLeftA.001` arrives as
 *     `DoorLeftA001` and a name-keyed lookup is a lookup that can drift.
 *
 * A consist is assembled from those templates: eight cars for a suburban
 * service, two four-car sets of driving-intermediate-intermediate-driving, and
 * six for the Metro. `TRAINS.md`'s numbers.
 *
 * ---------------------------------------------------------------------------
 * 2. THE LOD, WHICH IS THE CAR FLEET'S OWN ARGUMENT AT TWENTY TIMES THE SIZE.
 *
 * These are 190k-triangle assets. Eight carriages of one is 384k triangles for
 * a single train, which is fine for the one the player is standing beside and
 * ruinous for the eleven others inside the area of interest. So, exactly as
 * `world/carlod.ts` splits the traffic:
 *
 *   - within `MODEL_RADIUS`, the nearest `MAX_MODEL_TRAINS` are the real thing,
 *     merged down to one draw per material per carriage;
 *   - everything else out to `IMPOSTOR_RADIUS` is a **coloured box train** in one
 *     `InstancedMesh`, twelve triangles a carriage, one draw for the whole city.
 *
 * The impostor is not an apology. A train at 300 m is forty pixels tall and what
 * reads at that distance is a long articulated shape of the right colour moving
 * at the right speed along the right rails, which is precisely what a box train
 * is.
 *
 * ---------------------------------------------------------------------------
 * 3. A CARRIAGE IS PLACED FROM ITS TWO BOGIES, NOT FROM ONE POINT.
 *
 * `poseTrain` answers for a point. A carriage is 20 m of rigid steel on a
 * railway that curves and climbs, and hanging it off a single heading gives a
 * train whose ends float off the outside of every curve and whose body stays
 * level over a 3% grade. So each carriage is sampled at **both bogie centres**
 * -- two `sampleAlong` calls -- and its matrix is built from the basis those two
 * points define. That is also what makes a train on the Meadowbank bridge climb
 * and a train through Wynyard bank, for four extra multiplies a carriage.
 *
 * ---------------------------------------------------------------------------
 * 4. THE DOORS ARE THE ANIMATOR'S NUMBERS, DRIVEN WITHOUT A MIXER.
 *
 * The Tangara ships a 10.4 s, 250-key clip over 32 door leaves. It is one linear
 * slide per leaf and nothing else, so the prep script reads its **extremes** into
 * `manifest.doors` and this file interpolates between the shut pose and that
 * displacement. The motion is the clip's; the cost is one `position.set` per
 * leaf per frame instead of eight `AnimationMixer`s per train. The Metropolis has
 * no clip and its leaves fall through to the geometric derivation -- slide along
 * the carriage axis, away from the leaf's own origin, by the leaf's own width --
 * which agrees with the Tangara's clip to within 4 cm where both are available.
 *
 * `dwellElapsed` is what drives it, and it is why that function exists: a dwell
 * is a phase with `v0 = 0`, so "1.4 seconds into the stand at Redfern" is exact,
 * shared by every client, and needs no state here at all.
 *
 * **`game/rail-audio.ts` reads the same anchor and this file does not call it.**
 * The announcements are hung off `dir.arrivals[c]` -- the age the dwell phase
 * above begins at -- so the approach clip is counting down to the instant these
 * doors start opening, and the departure clip starts on it. The two agree
 * because they are the same number, not because anything here tells the sound
 * system when a door moved; and the source position agrees because that file
 * calls the same `riding.consistOffset` this one places carriages with. There is
 * deliberately no hook: a renderer that had to fire an audio event would be a
 * renderer a headless server could not run, and the whole schedule is
 * re-derived without one in `checkRailAnnouncements`.
 *
 * ---------------------------------------------------------------------------
 * 5. THE RENDERER RULES. The impostor's `InstancedMesh` calls
 * `setColorAt(0, white)` in its constructor, for the reason `world/rail-geo.ts`
 * and `world/cars.ts` both state. The model materials cannot be warmed by a
 * stand-in -- they come out of a GLB and there is nothing to stand in for -- so
 * `warm()` walks one instance of every carriage template through the same
 * `compileAsync` the tile streamer uses, before the first frame.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Object3D,
  Vector3,
  type Material,
  type Texture,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  createTrainPose,
  dwellElapsed,
  liveTripCount,
  poseTrain,
  tripIndexAt,
  type RailBake,
  type RailDirection,
  type TrainPose,
} from '../game/rail.ts';
import {
  METROPOLIS,
  TANGARA,
  carFrameAt,
  consistOf,
  consistOffset,
  createCarFrame,
  type ConsistCar,
} from '../game/riding.ts';

const MODEL_DIR = '/trains/';

/** Full models this close, and only for the nearest few. See section 2. */
const MODEL_RADIUS = 260;
const MAX_MODEL_TRAINS = 2;
/**
 * And the *second* train has to be closer than that.
 *
 * One 8-car Tangara is 112 draws and 383k triangles; two is 224 and 766k, which
 * is the whole of this feature's budget spent on one moment. That moment --
 * two trains at a platform together -- is worth having, and it is also the only
 * one worth 224 draws, so the second model tier is a platform's length rather
 * than a quarter of a kilometre. Everything past it is a box train.
 */
const SECOND_MODEL_RADIUS = 150;
/** Box trains this far out. Past it a train is under a pixel wide. */
const IMPOSTOR_RADIUS = 1700;
/** Carriages the impostor set can hold: about 110 trains, which the AOI never has. */
const IMPOSTOR_CAPACITY = 900;

/** How long a door takes to open, and to close again at the end of the dwell. */
const DOOR_SECONDS = 1.6;


// --- The manifest ------------------------------------------------------------------

interface CarBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface CarSpec {
  key: string;
  centreX: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  railY: number;
  box: CarBox;
  nodes: string[];
}

interface ModelSpec {
  file: string;
  pitch: number;
  cars: CarSpec[];
  doors: Record<string, [number, number, number]>;
}

interface TrainManifest {
  models: ModelSpec[];
  removed: unknown[];
}

// --- What a carriage is, once it has been merged -------------------------------------

interface DoorPart {
  geometry: BufferGeometry;
  material: Material;
  /** Local displacement from shut to fully open. */
  dx: number;
  dy: number;
  dz: number;
}

interface CarTemplate {
  key: string;
  lengthM: number;
  widthM: number;
  heightM: number;
  railY: number;
  /** One entry per material, everything that does not move. */
  body: Array<{ geometry: BufferGeometry; material: Material }>;
  /** One entry per (displacement, material). */
  doors: DoorPart[];
}

/** A carriage in the scene, pooled and reused. */
interface CarInstance {
  root: Group;
  doors: Array<{ object: Object3D; dx: number; dy: number; dz: number }>;
  template: CarTemplate;
}

// --- Loading -------------------------------------------------------------------------

const _v = /*#__PURE__*/ new Vector3();
const _normalMatrix = /*#__PURE__*/ new Matrix3();
const _matrix = /*#__PURE__*/ new Matrix4();
const _f = /*#__PURE__*/ new Vector3();
const _u = /*#__PURE__*/ new Vector3();
const _r = /*#__PURE__*/ new Vector3();
const _colour = /*#__PURE__*/ new Color();

/**
 * A mesh's geometry, in the carriage's own frame, as plain float32.
 *
 * Read through `getX/getY/getZ` rather than off the array, because
 * `prep-train-models.mjs` quantises POSITION and NORMAL to normalised integers
 * and puts the compensating scale on the node: the accessor's raw values are not
 * metres and only the attribute knows the conversion. Writing a transformed
 * position back into an `Int16Array` would truncate every carriage to the
 * nearest few centimetres, which is a train made of steps.
 */
function bakeGeometry(mesh: Mesh, toLocal: Matrix4): BufferGeometry {
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const count = position.count;

  _matrix.multiplyMatrices(toLocal, mesh.matrixWorld);
  _normalMatrix.getNormalMatrix(_matrix);

  const out = new BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    _v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(_matrix);
    pos[i * 3] = _v.x;
    pos[i * 3 + 1] = _v.y;
    pos[i * 3 + 2] = _v.z;
  }
  out.setAttribute('position', new BufferAttribute(pos, 3));

  const nrm = new Float32Array(count * 3);
  if (normal) {
    for (let i = 0; i < count; i++) {
      _v.set(normal.getX(i), normal.getY(i), normal.getZ(i)).applyMatrix3(_normalMatrix).normalize();
      nrm[i * 3] = _v.x;
      nrm[i * 3 + 1] = _v.y;
      nrm[i * 3 + 2] = _v.z;
    }
  } else {
    for (let i = 0; i < count; i++) nrm[i * 3 + 1] = 1;
  }
  out.setAttribute('normal', new BufferAttribute(nrm, 3));

  const tex = new Float32Array(count * 2);
  if (uv) for (let i = 0; i < count; i++) { tex[i * 2] = uv.getX(i); tex[i * 2 + 1] = uv.getY(i); }
  out.setAttribute('uv', new BufferAttribute(tex, 2));

  const index = source.getIndex();
  if (index) {
    const src = index;
    const dst = count > 65535 ? new Uint32Array(src.count) : new Uint16Array(src.count);
    for (let i = 0; i < src.count; i++) dst[i] = src.getX(i);
    out.setIndex(new BufferAttribute(dst, 1));
  }
  return out;
}

/** Concatenate same-layout geometries into one. Indexed, float32, three attributes. */
function mergeParts(parts: BufferGeometry[], name: string): BufferGeometry {
  let verts = 0;
  let indices = 0;
  for (const g of parts) {
    verts += g.getAttribute('position').count;
    indices += g.getIndex()?.count ?? g.getAttribute('position').count;
  }
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const index = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let vp = 0;
  let ip = 0;
  for (const g of parts) {
    const p = g.getAttribute('position').array as Float32Array;
    const n = g.getAttribute('normal').array as Float32Array;
    const t = g.getAttribute('uv').array as Float32Array;
    position.set(p, vp * 3);
    normal.set(n, vp * 3);
    uv.set(t, vp * 2);
    const gi = g.getIndex();
    const gc = g.getAttribute('position').count;
    if (gi) for (let i = 0; i < gi.count; i++) index[ip++] = vp + gi.getX(i);
    else for (let i = 0; i < gc; i++) index[ip++] = vp + i;
    vp += gc;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.name = name;
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * Is a material that says `alphaMode: BLEND` **actually** see-through?
 *
 * It has to be asked, because one of the two shipped models gets it wrong and
 * the cost of believing it is the whole interior. `metropolis.glb` declares its
 * `interior` material -- 36,179 triangles of grab poles, hanging straps, seats,
 * moquette and floor -- as `BLEND`, and its base-colour atlas is 94.6% fully
 * opaque: 14,117 of 262,144 texels have any alpha at all and the lowest is 73.
 * Those are anti-aliased decal edges in the atlas, not glass. `tangara.glb` has
 * the same interior as `OPAQUE`, which is the whole of why the Tangara never
 * showed the defect and the Metro did.
 *
 * Believing the flag put every one of those triangles in the transparent pass
 * with `depthWrite = false`, and the transparent pass sorts *objects*, not
 * triangles. The interior is one merged draw per material, so with no depth to
 * arbitrate, visibility inside the carriage fell to index order: the far end of
 * the train, drawn later in the buffer, painted over the seat and the pole a
 * metre from the player's face. Which is exactly what it looked like -- fittings
 * that swelled and vanished as you approached, refused to move against the
 * world outside the way their distance said they should, and let the ground show
 * through them.
 *
 * So the flag is checked against the texture rather than taken: the base colour
 * is drawn into a canvas of at most `ALPHA_PROBE` a side and its alpha counted,
 * and the material is only blended if most of what comes back is soft. The
 * downscale is **nearest-neighbour and nothing else** -- the default smoothing
 * bleeds one soft texel across every neighbour it lands between, which is how a
 * 5% atlas measures 40% and the fix undoes itself. Real glazing is not a near
 * miss at that threshold: `Glass` and all three Tangara window atlases are 100.0%
 * soft against the Metropolis interior's 5.4%, so the halfway line has an order
 * of magnitude of daylight either side of it.
 *
 * Unmeasurable is unchanged: no map, no 2D context, or a readback that throws
 * all fall back to believing the file, because the only material in either model
 * with no base-colour texture is `interior_light`, which is `OPAQUE` anyway.
 */
const SOFT_ALPHA = 250;
const TRANSLUCENT_SHARE = 0.5;
const ALPHA_PROBE = 256;

const translucentCache = new WeakMap<Texture, boolean>();

function isReallyTranslucent(map: Texture): boolean {
  const cached = translucentCache.get(map);
  if (cached !== undefined) return cached;
  let answer = true;
  const image = map.image as (CanvasImageSource & { width?: number; height?: number }) | null;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  if (image && w > 0 && h > 0) {
    try {
      const cw = Math.min(w, ALPHA_PROBE);
      const ch = Math.min(h, ALPHA_PROBE);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, cw, ch);
        const data = ctx.getImageData(0, 0, cw, ch).data;
        let soft = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] < SOFT_ALPHA) soft++;
        answer = soft > TRANSLUCENT_SHARE * cw * ch;
      }
    } catch {
      answer = true;
    }
  }
  translucentCache.set(map, answer);
  return answer;
}

/**
 * The GLB's own material, as a `MeshStandardNodeMaterial`.
 *
 * Converted explicitly rather than handed to the renderer's automatic path,
 * because the automatic path produces a material this file does not have a
 * reference to -- and a material nothing holds is a material `auditWarmup`
 * cannot name and `warm()` cannot compile. It also lets the alpha-blended
 * glazing be given `depthWrite = false` here rather than argued about later.
 *
 * The occlusion map is deliberately dropped: three samples `aoMap` from `uv1`,
 * these files put occlusion on TEXCOORD_0, and the map in both is the same image
 * as the metallic-roughness one -- so wiring it would mean carrying a second UV
 * set to darken what the roughness already darkens.
 */
const materialCache = new Map<Material, MeshStandardNodeMaterial>();

function convertMaterial(source: Material, label: string): MeshStandardNodeMaterial {
  const hit = materialCache.get(source);
  if (hit) return hit;
  const src = source as Material & {
    color?: Color;
    map?: Texture | null;
    normalMap?: Texture | null;
    roughnessMap?: Texture | null;
    metalnessMap?: Texture | null;
    emissiveMap?: Texture | null;
    emissive?: Color;
    roughness?: number;
    metalness?: number;
    transparent?: boolean;
    opacity?: number;
    alphaTest?: number;
    side?: number;
  };
  const m = new MeshStandardNodeMaterial();
  m.name = `train_${label}_${source.name || 'unnamed'}`;
  if (src.color) m.color = src.color.clone();
  if (src.map) m.map = src.map;
  if (src.normalMap) m.normalMap = src.normalMap;
  if (src.roughnessMap) m.roughnessMap = src.roughnessMap;
  if (src.metalnessMap) m.metalnessMap = src.metalnessMap;
  if (src.emissiveMap) m.emissiveMap = src.emissiveMap;
  if (src.emissive) m.emissive = src.emissive.clone();
  m.roughness = src.roughness ?? 0.7;
  m.metalness = src.metalness ?? 0.1;
  m.opacity = src.opacity ?? 1;
  if (src.alphaTest) m.alphaTest = src.alphaTest;
  // `BLEND` is a claim, not a measurement. A material the file calls blended is
  // only treated as blended if it is either uniformly faded (`opacity`, which is
  // the author saying so in a way no texture can contradict) or its base colour
  // is mostly soft. See `isReallyTranslucent` for the model that gets this wrong
  // and for what believing it cost.
  m.transparent =
    !!src.transparent && (m.opacity < 1 || !src.map || isReallyTranslucent(src.map));
  // Glazing: written into the depth buffer it would hide the interior behind it,
  // and this is the one asset in the game with a modelled interior to hide. It
  // is also the reason the test above has to be narrow -- the interior is what
  // the glazing is being kept out of the way *of*, so misclassifying it as
  // glazing deletes the thing the rule exists to protect.
  if (m.transparent) m.depthWrite = false;
  m.side = m.transparent ? DoubleSide : FrontSide;
  materialCache.set(source, m);
  return m;
}

/** `PropertyBinding.sanitizeNodeName`, matching what the loader did to the name. */
const DOOR_RE = /door/i;

/**
 * Split one loaded model into its carriage templates.
 *
 * Every mesh is assigned to the carriage whose manifest box contains its own
 * world-space centre; a mesh in none of them is reported rather than dropped
 * silently, because "one carriage is missing its roof" is the failure this
 * assignment can have and it is not one anybody would spot from the platform.
 */
function splitModel(
  scene: Object3D,
  spec: ModelSpec,
  warnings: string[],
): Map<string, CarTemplate> {
  scene.updateMatrixWorld(true);

  interface Bucket {
    body: Map<Material, BufferGeometry[]>;
    doors: Map<string, { part: DoorPart; parts: BufferGeometry[] }>;
  }
  const buckets = new Map<string, Bucket>();
  for (const car of spec.cars) buckets.set(car.key, { body: new Map(), doors: new Map() });

  const local = new Matrix4();
  const box = new Vector3();
  let orphans = 0;

  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    box.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
    box.applyMatrix4(mesh.matrixWorld);
    const car = spec.cars.find(
      (c) =>
        box.x >= c.box.minX - 0.5 && box.x <= c.box.maxX + 0.5 &&
        box.z >= c.box.minZ - 0.5 && box.z <= c.box.maxZ + 0.5,
    );
    if (!car) {
      orphans++;
      return;
    }
    const bucket = buckets.get(car.key)!;
    // The carriage's own frame: centre on the origin in X and Z, wheels on y=0.
    local.makeTranslation(-car.centreX, -car.railY, -(car.box.minZ + car.box.maxZ) / 2);
    const geometry = bakeGeometry(mesh, local);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const material = convertMaterial(materials[0], car.key);

    // A door leaf, and which way it slides. The clip's own displacement where
    // the prep script found one; otherwise out along the carriage axis away from
    // the leaf's own origin, by the leaf's own width. See section 4.
    const doorNode = findDoorAncestor(mesh);
    if (doorNode) {
      const clip = spec.doors[doorNode.name];
      let dx: number;
      let dz: number;
      if (clip) {
        dx = clip[0];
        dz = clip[2];
      } else {
        _v.setFromMatrixPosition(doorNode.matrixWorld);
        const wide = bb.max.x - bb.min.x;
        const deep = bb.max.z - bb.min.z;
        const span = Math.max(wide, deep);
        // The leaf extends one way from its node; it retracts the other way is
        // wrong -- it retracts *further* the way it already extends.
        dx = Math.sign(box.x - _v.x || 1) * (span - 0.06);
        dz = Math.sign(box.z - _v.z) * 0.05;
      }
      const key = `${dx.toFixed(3)},${dz.toFixed(3)},${material.name}`;
      let entry = bucket.doors.get(key);
      if (!entry) {
        entry = { part: { geometry: geometry, material, dx, dy: 0, dz }, parts: [] };
        bucket.doors.set(key, entry);
      }
      entry.parts.push(geometry);
      return;
    }

    const list = bucket.body.get(material);
    if (list) list.push(geometry);
    else bucket.body.set(material, [geometry]);
  });

  if (orphans > 0) warnings.push(`${spec.file}: ${orphans} mesh(es) fell outside every carriage box`);

  const out = new Map<string, CarTemplate>();
  for (const car of spec.cars) {
    const bucket = buckets.get(car.key)!;
    const body: CarTemplate['body'] = [];
    for (const [material, parts] of bucket.body) {
      body.push({ geometry: mergeParts(parts, `${car.key}_body`), material });
    }
    const doors: DoorPart[] = [];
    for (const entry of bucket.doors.values()) {
      doors.push({
        ...entry.part,
        geometry: mergeParts(entry.parts, `${car.key}_door`),
      });
    }
    if (body.length === 0) {
      warnings.push(`${spec.file}: carriage ${car.key} came out empty`);
      continue;
    }
    out.set(car.key, {
      key: car.key,
      lengthM: car.lengthM,
      widthM: car.widthM,
      heightM: car.heightM,
      railY: car.railY,
      body,
      doors,
    });
  }
  return out;
}

/** The nearest ancestor (or self) whose name says it is a door leaf. */
function findDoorAncestor(mesh: Object3D): Object3D | null {
  let node: Object3D | null = mesh;
  let depth = 0;
  while (node && depth < 4) {
    if (DOOR_RE.test(node.name)) return node;
    node = node.parent;
    depth++;
  }
  return null;
}

// --- The consist ---------------------------------------------------------------------

/**
 * What a service is made of, and where each carriage of it sits.
 *
 * **Both moved to `game/riding.ts`** and are imported back here rather than
 * copied, which is the whole reason the move happened: the carriage a passenger
 * is standing in has to be the carriage this file draws, on the client *and on
 * the server*, which has no renderer and no manifest. Two tables would be two
 * tables that drift, and the symptom of a drift is a rider standing in the gap
 * between carriages four and five with the doors of both open beside them.
 *
 * Template keys are namespaced by model, and that is not tidiness either. Both
 * files call their intermediate carriage `mid`. Filed under the bare key one
 * silently overwrites the other, and the symptom is a Tangara whose middle six
 * carriages are Sydney Metro single-deckers -- which is exactly what the first
 * build did, and it took a triangle count in the console to notice.
 */

/** Warm grey Tangara body and Metro blue, linear, for the box trains. */
const IMPOSTOR_SUBURBAN: readonly [number, number, number] = [0.2, 0.198, 0.19];
const IMPOSTOR_PRIDE: readonly [number, number, number] = [0.24, 0.12, 0.16];
const IMPOSTOR_METRO: readonly [number, number, number] = [0.06, 0.09, 0.15];

// --- The fleet -------------------------------------------------------------------------

export interface TrainFleetStats {
  /** Trains drawn as real models this frame. */
  modelTrains: number;
  /** Carriages in the impostor set this frame. */
  impostorCars: number;
  /** Draw calls the model tier is contributing. */
  modelDraws: number;
  /** Triangles in the model tier. Diagnostic; the number the LOD exists for. */
  modelTriangles: number;
  /** What the last update cost, milliseconds. */
  updateMs: number;
}

export class TrainFleet {
  readonly group = new Group();
  readonly stats: TrainFleetStats = {
    modelTrains: 0,
    impostorCars: 0,
    modelDraws: 0,
    modelTriangles: 0,
    updateMs: 0,
  };
  /** Anything the split or the load could not do. Printed once at boot. */
  readonly warnings: string[] = [];
  readonly impostorMaterial: MeshStandardNodeMaterial;

  private readonly templates = new Map<string, CarTemplate>();
  private readonly pool = new Map<string, CarInstance[]>();
  private readonly used = new Map<string, number>();
  private readonly impostor: InstancedMesh;
  private readonly pose: TrainPose = createTrainPose();
  private readonly pitches = new Map<string, number>();
  private readonly triangles = new Map<string, number>();

  /**
   * Built empty and filled by `load`, which is the shape `main.ts` needs rather
   * than a static factory: the box-train material and its one `InstancedMesh`
   * have to be in the scene before either warm-up pass runs, and the 10.5 MB of
   * models are fetched two hundred lines later beside the car models.
   */
  constructor() {
    this.group.name = 'trains';

    const material = new MeshStandardNodeMaterial();
    material.name = 'train_impostor';
    // No `colorNode`: `NodeMaterial` already multiplies the material colour by
    // `instanceColor`, so the livery arrives through one built-in multiply.
    material.color = new Color(1, 1, 1);
    material.roughness = 0.55;
    material.metalness = 0.15;
    material.flatShading = true;
    this.impostorMaterial = material;

    this.impostor = new InstancedMesh(buildImpostorCar(), material, IMPOSTOR_CAPACITY);
    this.impostor.name = 'train_impostors';
    this.impostor.count = 0;
    // Culled by radius, not by frustum: the bounding sphere of a set whose
    // instances are somewhere different every frame would have to be recomputed
    // every frame, and the radius test is already being done.
    this.impostor.frustumCulled = false;
    this.impostor.castShadow = true;
    this.impostor.receiveShadow = false;
    // The colour buffer, allocated before the scene pass builds the node graph.
    // Without it every box train draws white forever. See section 5.
    this.impostor.setColorAt(0, _colour.setRGB(1, 1, 1));
    this.group.add(this.impostor);
  }

  /**
   * Fetch and split both models.
   *
   * Never throws. A fleet whose models did not load still draws every train in
   * the city as a box, which is a worse picture and a working feature.
   */
  async load(baseUrl = MODEL_DIR): Promise<void> {
    let manifest: TrainManifest;
    try {
      const response = await fetch(`${baseUrl}manifest.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = (await response.json()) as TrainManifest;
    } catch (err) {
      this.warnings.push(`no train manifest (${String(err)}); every train is an impostor`);
      return;
    }

    const loader = new GLTFLoader();
    await Promise.all(
      manifest.models.map(async (spec) => {
        try {
          const response = await fetch(`${baseUrl}${spec.file}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const gltf = await loader.parseAsync(await response.arrayBuffer(), '');
          const templates = splitModel(gltf.scene, spec, this.warnings);
          const model = spec.file.replace(/\.glb$/, '');
          for (const [key, template] of templates) {
            this.templates.set(`${model}:${key}`, template);
            this.pitches.set(`${model}:${key}`, spec.pitch);
            let tris = 0;
            for (const part of template.body) tris += (part.geometry.getIndex()?.count ?? 0) / 3;
            for (const part of template.doors) tris += (part.geometry.getIndex()?.count ?? 0) / 3;
            this.triangles.set(`${model}:${key}`, tris);
          }
        } catch (err) {
          this.warnings.push(`${spec.file} did not load: ${String(err)}`);
        }
      }),
    );
  }

  /** True once at least one carriage template is available. */
  get hasModels(): boolean {
    return this.templates.size > 0;
  }

  /** Triangles per carriage template, for the report. */
  templateTriangles(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, n] of this.triangles) out[key] = n;
    return out;
  }

  /**
   * Compile every model material before the first frame.
   *
   * A stand-in cannot do this -- there is nothing to stand in for a material that
   * came out of a GLB with four textures on it -- so one instance of every
   * carriage template is built, made visible, walked by the caller's
   * `compileAsync` and hidden again. It is `TileStreamer.setPrecompiler`'s dance
   * and `main.ts` hands over the same function.
   */
  async warm(precompile: (group: Group) => Promise<void>): Promise<void> {
    const parked: CarInstance[] = [];
    for (const key of this.templates.keys()) {
      const instance = this.take(key);
      if (!instance) continue;
      instance.root.visible = true;
      // Under the world rather than at the origin: `compileAsync` rasterises
      // nothing, but the nested shadow render inside it does, and eight
      // carriages stacked on the spawn would be eight carriages in the sun's
      // depth map for the duration.
      instance.root.position.set(0, -4000, 0);
      parked.push(instance);
    }
    // The box train goes through the same pass, and it has to: an
    // `InstancedMesh` with `count = 0` is a draw the renderer can skip, and a
    // skipped draw is an uncompiled pipeline. One instance, parked with the
    // rest, is the whole of the fix.
    _matrix.makeTranslation(0, -4000, 0);
    this.impostor.setMatrixAt(0, _matrix);
    this.impostor.instanceMatrix.needsUpdate = true;
    this.impostor.count = 1;
    await precompile(this.group);
    // **And visible again**, which is not housekeeping. `precompileGroup` in
    // `main.ts` is written for a *tile*: it shows the group for the walk and
    // hides it afterwards, because the streamer is the thing that decides when a
    // tile appears. Nothing decides that for this group -- it is in the scene for
    // the session -- so handing it to that helper and walking away leaves every
    // train in Sydney drawn into a group whose `visible` is false. It shipped
    // exactly that way for an afternoon: the poses were right, the matrices were
    // right, `modelDraws` said 224, and the platform was empty.
    this.group.visible = true;
    this.impostor.count = 0;
    for (const instance of parked) instance.root.visible = false;
    this.release();
  }

  // --- The per-frame half ----------------------------------------------------------

  /**
   * Draw every train within reach of (x, z) at rail-clock second `t`.
   *
   * One pass over the timetable: bounding-box rejected per direction by
   * `trainsNear`'s own rule, then the nearest few promoted to models and the rest
   * written into the impostor buffer. No allocation and no clock of its own --
   * `t` comes from the caller, which is what makes a backgrounded tab free and
   * what keeps this agreeing with the server.
   */
  update(bake: RailBake, t: number, x: number, z: number): void {
    const started = performance.now();
    this.release();

    // Pass one: who is near, and how near. A fixed-size shortlist rather than a
    // sort, because the answer is "the two closest" and the list is tens long.
    let bestA = -1;
    let bestB = -1;
    let distA = MODEL_RADIUS * MODEL_RADIUS;
    let distB = SECOND_MODEL_RADIUS * SECOND_MODEL_RADIUS;
    const found = this.scratch;
    found.length = 0;
    const r2 = IMPOSTOR_RADIUS * IMPOSTOR_RADIUS;
    for (const line of bake.lines) {
      for (const dir of line.dirs) {
        if (
          x + IMPOSTOR_RADIUS < dir.minX || x - IMPOSTOR_RADIUS > dir.maxX ||
          z + IMPOSTOR_RADIUS < dir.minZ || z - IMPOSTOR_RADIUS > dir.maxZ
        ) continue;
        const live = liveTripCount(dir);
        for (let j = 0; j <= live; j++) {
          const trip = tripIndexAt(dir, t, j);
          // The head of the train, from the same function the server evaluates.
          // Everything after this is the consist hung off `pose.s`.
          if (!poseTrain(bake, dir, trip, t, this.pose)) continue;
          const dx = this.pose.x - x;
          const dz = this.pose.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          const at = found.length;
          found.push({ dir, trip, d2, s: this.pose.s, age: this.pose.age });
          if (d2 < distA) {
            distB = distA;
            bestB = bestA;
            distA = d2;
            bestA = at;
          } else if (d2 < distB) {
            distB = d2;
            bestB = at;
          }
        }
      }
    }

    const modelled = new Set<number>();
    if (this.hasModels) {
      if (bestA >= 0) modelled.add(bestA);
      if (bestB >= 0 && MAX_MODEL_TRAINS > 1) modelled.add(bestB);
    }

    let impostors = 0;
    let draws = 0;
    let triangles = 0;
    for (let i = 0; i < found.length; i++) {
      const row = found[i];
      const consist = this.consistFor(row.dir, row.trip);
      if (modelled.has(i)) {
        const built = this.drawModel(bake, row.dir, row.s, row.age, consist);
        draws += built.draws;
        triangles += built.triangles;
      } else {
        impostors = this.drawImpostor(bake, row.dir, row.s, consist, impostors);
      }
    }

    this.impostor.count = impostors;
    this.impostor.instanceMatrix.needsUpdate = true;
    if (this.impostor.instanceColor) this.impostor.instanceColor.needsUpdate = true;

    this.stats.modelTrains = modelled.size;
    this.stats.impostorCars = impostors;
    this.stats.modelDraws = draws;
    this.stats.modelTriangles = triangles;
    this.stats.updateMs = performance.now() - started;
  }

  private readonly scratch: Array<{
    dir: RailDirection;
    trip: number;
    d2: number;
    /** Arc length of the train's head, which is what the consist hangs off. */
    s: number;
    /** Seconds since this trip departed, which `dwellElapsed` reads. */
    age: number;
  }> = [];

  /** Which carriages this service is made of, and how far apart they sit. */
  private consistFor(
    dir: RailDirection,
    trip: number,
  ): { cars: readonly ConsistCar[]; pitch: number; pride: boolean; metro: boolean } {
    // `game/riding.consistOf` decides all four, including the Pride set's stable
    // one-in-sixteen over the train's own identity, because the server has to
    // agree about every one of them and cannot read a manifest.
    //
    // The manifest's pitch is still consulted, and it is a **check** rather than
    // a source: `riding.SUBURBAN_PITCH` is the manifest's own 20.4 restated, and
    // if a re-prepped model ever changes it this is where the two would part
    // company. Preferring the loaded value would put the renderer's carriages
    // 1.2 m from where every rider on the server thinks they are.
    const consist = consistOf(dir, trip);
    const loaded = consist.metro
      ? this.pitches.get(`${METROPOLIS}:lead`)
      : this.pitches.get(`${TANGARA}:cab`);
    if (loaded !== undefined && Math.abs(loaded - consist.pitch) > 0.01 && !this.pitchWarned) {
      this.pitchWarned = true;
      this.warnings.push(
        `manifest pitch ${loaded} m against game/riding.ts's ${consist.pitch} m; ` +
          'riders and carriages will not line up until the two agree',
      );
    }
    return consist;
  }

  private pitchWarned = false;

  /**
   * The namespaced key of the template this carriage should wear.
   *
   * The **key** rather than the template, because the pool is keyed by it and
   * `CarTemplate.key` is the bare name the manifest used -- `cab`, `mid` -- which
   * two models share. Returning the template and pooling by `template.key` is
   * exactly the bug that drew every train with no carriages at all: `take('cab')`
   * missed a map holding `tangara:cab` and quietly returned null eight times.
   */
  private templateKeyFor(car: ConsistCar, pride: boolean): string | null {
    if (pride && this.templates.has(`${car.key}_pride`)) return `${car.key}_pride`;
    return this.templates.has(car.key) ? car.key : null;
  }

  private drawModel(
    bake: RailBake,
    dir: RailDirection,
    s: number,
    age: number,
    consist: { cars: readonly ConsistCar[]; pitch: number; pride: boolean; metro: boolean },
  ): { draws: number; triangles: number } {
    const open = doorOpenness(dwellElapsed(bake, dir, age), bake.physics.dwell);
    let draws = 0;
    let triangles = 0;
    for (let k = 0; k < consist.cars.length; k++) {
      const car = consist.cars[k];
      const key = this.templateKeyFor(car, consist.pride);
      if (key === null) continue;
      const instance = this.take(key);
      if (!instance) continue;
      const centre = consistOffset(s, k, consist.cars.length, consist.pitch);
      if (centre < 0) {
        // The tail of a train that has only just left the platform is behind the
        // start of the line. Parked rather than clamped, because clamping would
        // stack four carriages on the buffers.
        instance.root.visible = false;
        continue;
      }
      placeCar(bake, dir, centre, instance.root, car.flip);
      instance.root.visible = true;
      for (const door of instance.doors) {
        door.object.position.set(door.dx * open, door.dy * open, door.dz * open);
      }
      draws += instance.root.children.length;
      triangles += this.triangles.get(key) ?? 0;
    }
    return { draws, triangles };
  }

  private drawImpostor(
    bake: RailBake,
    dir: RailDirection,
    s: number,
    consist: { cars: readonly ConsistCar[]; pitch: number; pride: boolean; metro: boolean },
    at: number,
  ): number {
    const tone = consist.metro
      ? IMPOSTOR_METRO
      : consist.pride
        ? IMPOSTOR_PRIDE
        : IMPOSTOR_SUBURBAN;
    _colour.setRGB(tone[0], tone[1], tone[2]);
    for (let k = 0; k < consist.cars.length; k++) {
      if (at >= IMPOSTOR_CAPACITY) return at;
      const centre = consistOffset(s, k, consist.cars.length, consist.pitch);
      if (centre < 0) continue;
      carMatrix(bake, dir, centre, consist.cars[k].flip, _matrix);
      // The box is built at unit length; the consist's own pitch scales it, so a
      // Metro car is 22 m and a Tangara 20.4 without a second geometry.
      _matrix.scale(_v.set(consist.pitch - 0.9, 1, 1));
      this.impostor.setMatrixAt(at, _matrix);
      this.impostor.setColorAt(at, _colour);
      at++;
    }
    return at;
  }

  // --- The instance pool -------------------------------------------------------------

  private take(key: string): CarInstance | null {
    const template = this.templates.get(key);
    if (!template) return null;
    let list = this.pool.get(key);
    if (!list) {
      list = [];
      this.pool.set(key, list);
    }
    const at = this.used.get(key) ?? 0;
    this.used.set(key, at + 1);
    if (at < list.length) return list[at];
    const instance = buildInstance(template);
    this.group.add(instance.root);
    list.push(instance);
    return instance;
  }

  /** Hide everything taken last frame. Cheaper than tracking what changed. */
  private release(): void {
    for (const [key, at] of this.used) {
      const list = this.pool.get(key);
      if (!list) continue;
      for (let i = 0; i < at && i < list.length; i++) list[i].root.visible = false;
    }
    this.used.clear();
  }
}

/**
 * Where each carriage of a consist sits: `game/riding.consistOffset`.
 *
 * Moved with the consist tables and imported back, and the argument that used
 * to live here moved with it: **the reference point is the middle of the train,
 * not its nose.** A 163 m train hung behind `poseTrain`'s single point puts its
 * rear four carriages out over the points at every platform in Sydney.
 */

/** How far open the doors are, given how long the train has been standing. */
function doorOpenness(stopped: number, dwell: number): number {
  if (stopped <= 0) return 0;
  if (stopped >= dwell) return 0;
  const opening = Math.min(stopped / DOOR_SECONDS, 1);
  const closing = Math.min((dwell - stopped) / DOOR_SECONDS, 1);
  return Math.max(0, Math.min(opening, closing));
}

/**
 * The matrix that puts a carriage centred at arc length `centre` on the rails.
 *
 * **The two-bogie sample and the basis it builds now live in
 * `game/riding.carFrameAt`**, and this is a nine-component copy of the answer
 * rather than a second derivation of it. That move is the point: a rider's
 * position is composed against exactly this frame on the server, in a process
 * with no three in it, and a renderer that built its own basis would draw the
 * carriage a few centimetres from where the person standing in it is. Section 3
 * of this file's header still describes what the frame is and why it takes two
 * samples; the arithmetic is over there now, unchanged statement for statement.
 */
function carMatrix(
  bake: RailBake, dir: RailDirection, centre: number, flip: boolean, out: Matrix4,
): void {
  carFrameAt(bake, dir, centre, flip, _frame);
  _f.set(_frame.fx, _frame.fy, _frame.fz);
  _u.set(_frame.ux, _frame.uy, _frame.uz);
  _r.set(_frame.rx, _frame.ry, _frame.rz);
  out.makeBasis(_f, _u, _r);
  out.setPosition(_frame.ox, _frame.oy, _frame.oz);
}

const _frame = /*#__PURE__*/ createCarFrame();

function placeCar(
  bake: RailBake, dir: RailDirection, centre: number, root: Object3D, flip: boolean,
): void {
  carMatrix(bake, dir, centre, flip, _matrix);
  _matrix.decompose(root.position, root.quaternion, root.scale);
}

/** One carriage's meshes, built from a template and reused forever after. */
function buildInstance(template: CarTemplate): CarInstance {
  const root = new Group();
  root.name = `train_${template.key}`;
  root.visible = false;
  const doors: CarInstance['doors'] = [];
  for (const part of template.body) {
    const mesh = new Mesh(part.geometry, part.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // Culled with the carriage rather than per mesh: the bounding sphere is
    // right, and every mesh of a carriage is in view exactly when the carriage
    // is. One test instead of thirteen.
    mesh.frustumCulled = true;
    root.add(mesh);
  }
  for (const part of template.doors) {
    const holder = new Group();
    const mesh = new Mesh(part.geometry, part.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    holder.add(mesh);
    root.add(holder);
    doors.push({ object: holder, dx: part.dx, dy: part.dy, dz: part.dz });
  }
  return { root, doors, template };
}

/**
 * The box train's one carriage: a unit-length body with a shouldered roof.
 *
 * Unit length in X so the consist's own pitch scales it, 3.05 m wide and 4.1 m
 * over the roof, sitting on y = 0 like the real models. Eighteen triangles: the
 * roof shoulder is the whole difference between a train and a shipping container
 * at four hundred metres, and it costs six of them.
 */
function buildImpostorCar(): BufferGeometry {
  const w = 1.52;
  const shoulder = 3.3;
  const roof = 4.15;
  const sill = 0.9;
  const rw = 1.1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const quad = (
    a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
  ): void => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx, ny, nz);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // The body is built on x in [-0.5, 0.5] so an instance scale of the pitch
  // gives the carriage its real length.
  const F = 0.5;
  const B = -0.5;
  quad([B, sill, -w], [F, sill, -w], [F, shoulder, -w], [B, shoulder, -w]);
  quad([F, sill, w], [B, sill, w], [B, shoulder, w], [F, shoulder, w]);
  quad([B, shoulder, -w], [F, shoulder, -w], [F, roof, -rw], [B, roof, -rw]);
  quad([F, shoulder, w], [B, shoulder, w], [B, roof, rw], [F, roof, rw]);
  quad([B, roof, -rw], [F, roof, -rw], [F, roof, rw], [B, roof, rw]);
  quad([B, sill, -w], [B, sill, w], [B, roof, rw], [B, roof, -rw]);
  quad([F, sill, w], [F, sill, -w], [F, roof, -rw], [F, roof, rw]);
  // The underframe, dark by being in its own shadow rather than its own colour.
  quad([B, 0.3, -w * 0.7], [F, 0.3, -w * 0.7], [F, sill, -w], [B, sill, -w]);
  quad([F, 0.3, w * 0.7], [B, 0.3, w * 0.7], [B, sill, w], [F, sill, w]);

  const g = new BufferGeometry();
  g.name = 'train_impostor';
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(new BufferAttribute(new Uint16Array(index), 1));
  g.computeBoundingSphere();
  return g;
}
