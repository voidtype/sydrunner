/**
 * Everything a tile's bytes have to be turned into, with nothing in it that
 * cannot run on a worker thread.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS. A tile arrives as a ~1.6 MB GLB and eight small
 * sidecars, and until this module existed every byte of it was turned into
 * objects on the main thread, inside one uninterruptible task. Measured on an
 * M-series Mac over the thirty-two heaviest tiles in the inner ring, four at a
 * time, which is what `TileStreamer.concurrency` actually does:
 *
 *     GLB parse (GLTFLoader)     p50  2.4 ms   p95 14.1 ms   worst 15.4 ms
 *     sidecar decode, all eight  ---- 0.37 ms per tile, total ----
 *     geometry + scene insertion p50  2.3 ms   p95  3.8 ms   worst  4.4 ms
 *
 * and, because a settled `Promise.all` continuation runs as a microtask inside
 * whichever task settled the last promise, those three add up into **one** task:
 * 17 tasks over 16 ms across 32 tiles, worst 48.7 ms. On a modest Windows
 * laptop -- four to six times slower per core -- that worst case is a quarter of
 * a second in which the game does not draw. That is the freeze being fixed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN HERE AND WHAT IS NOT. This module is the *decode*: bytes in,
 * plain data out. There is no `three` import and no DOM reference anywhere in
 * it, and both of those are load-bearing rather than tidiness --
 *
 *   - no `three`, because `decode.worker.ts` imports this file and a worker
 *     that dragged in the whole WebGPU renderer to read a 4 kB sidecar would
 *     be a second copy of three on the wire and a hundred milliseconds of
 *     module evaluation before the first tile could be decoded;
 *   - no DOM, because `server/world.ts` reaches two of these decoders through
 *     their old homes and `server/tsconfig.json` compiles that path with the
 *     DOM lib switched off on purpose.
 *
 * The construction half -- `BufferGeometry`, `InstancedMesh`, materials -- stays
 * where it was, in the modules that own the look of each thing. It cannot move:
 * it is GPU-resource construction and it has to happen where the renderer is.
 * `TileStreamer` runs it under a per-frame budget instead.
 *
 * ---------------------------------------------------------------------------
 * WHY A PURPOSE-BUILT GLB PARSER RATHER THAN `GLTFLoader` IN THE WORKER.
 *
 * `pipeline/sydney/tiles.py:write_glb` emits a deliberately narrow file: one
 * buffer, one BIN chunk, one scene, one node with no transform, one mesh, and
 * one primitive per material slot. No textures, no samplers, no images, no
 * skins, no animations, no morph targets, no extensions, no sparse accessors,
 * no interleaving, no Draco. Every accessor owns its own buffer view.
 *
 * `GLTFLoader` is 4,000 lines of the general case and reaches `THREE.Mesh` and
 * `THREE.MeshStandardMaterial` on the way, neither of which survives contact
 * with this client -- `streamer.ts` throws the materials away and reparents the
 * meshes. `parseTileGlb` reads the twelve fields that file actually contains and
 * hands back attribute arrays, which is the only part of the answer anybody
 * wanted. It is also the only version of the parse that can run off-thread.
 *
 * The arrays it produces are **byte-identical to GLTFLoader's**, down to the
 * lowercased `_bldidx` alias -- see `TILE_ATTRIBUTE_NAMES` -- because the
 * geometry cache key that decides which WebGPU pipeline a primitive draws with
 * reads attribute *names* and item sizes. `verifyTileGlbParse` in `streamer.ts`
 * runs both parsers over a real tile at boot in dev and compares, which is the
 * regression net for that claim.
 */

// --- The GLB container --------------------------------------------------------

/** `glTF`, little-endian. */
const GLB_MAGIC = 0x46546c67;
/** `JSON`, with a trailing space, as the chunk type. */
const CHUNK_JSON = 0x4e4f534a;
/** `BIN` and a NUL. */
const CHUNK_BIN = 0x004e4942;

const COMPONENT_BYTE = 5120;
const COMPONENT_UBYTE = 5121;
const COMPONENT_SHORT = 5122;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;
const COMPONENT_FLOAT = 5126;

/** Components per element, by glTF accessor `type`. */
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/**
 * glTF attribute semantic to the name three's geometry uses, which is also the
 * name TSL looks a vertex attribute up by.
 *
 * **This table is not a convenience; it is a pipeline cache key.** Three's
 * `RenderObject.getGeometryCacheKey` walks `Object.keys(geometry.attributes)`,
 * so a primitive whose position attribute were called `POSITION` would key
 * differently from the one `world/warmup.ts` compiled a pipeline for, and the
 * hitch this whole change exists to remove would come straight back on the
 * first tile. The mapping is exactly `GLTFLoader.ATTRIBUTES` plus its fallback
 * of lowercasing anything it does not recognise -- which is what turns the
 * pipeline's `_BLDIDX` into `_bldidx`.
 */
const ATTRIBUTE_NAMES: Record<string, string> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  TEXCOORD_2: 'uv2',
  TEXCOORD_3: 'uv3',
  COLOR_0: 'color',
  WEIGHTS_0: 'skinWeight',
  JOINTS_0: 'skinIndex',
};

/**
 * The facade parameter index, under the name GLTFLoader's lowercasing produces.
 *
 * Exported because `streamer.ts` sets the attribute under **both** this and
 * `_BLDIDX` -- see `normaliseBuildingIndexAttribute` there, and the note in
 * `warmup.warmupGeometry` that says why a stand-in carrying only one of the two
 * warms a pipeline nothing draws.
 */
export const BLDIDX_LOWER = '_bldidx';

/** One decoded vertex attribute, ready to be wrapped in a `BufferAttribute`. */
export interface GlbAttribute {
  /** Three's name for it: `position`, `normal`, `uv`, `color`, `_bldidx`. */
  name: string;
  array: Float32Array | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array;
  itemSize: number;
  /** Integers that stand for a 0..1 range -- the contact skirt's colour ramp. */
  normalized: boolean;
}

/** One material slot's geometry out of a tile GLB. */
export interface GlbPrimitive {
  /**
   * The slot's name, straight out of the file's material table.
   *
   * A name rather than an index because that is what the client keys its
   * twenty materials by, and because `write_glb` writes the whole of
   * `mesh.MATERIALS` into every tile whether the tile uses a slot or not --
   * so the index is a fact about the pipeline's list and the name is a fact
   * about this primitive.
   */
  material: string;
  attributes: GlbAttribute[];
  index: Uint32Array | Uint16Array;
}

export interface TileGlb {
  primitives: GlbPrimitive[];
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfJson {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  materials?: Array<{ name?: string }>;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }> }>;
}

const utf8 = new TextDecoder();

function componentBytes(componentType: number): number {
  switch (componentType) {
    case COMPONENT_BYTE:
    case COMPONENT_UBYTE:
      return 1;
    case COMPONENT_SHORT:
    case COMPONENT_USHORT:
      return 2;
    case COMPONENT_UINT:
    case COMPONENT_FLOAT:
      return 4;
    default:
      return 0;
  }
}

function makeArray(
  componentType: number,
  bytes: ArrayBuffer,
): GlbAttribute['array'] {
  switch (componentType) {
    case COMPONENT_BYTE:
      return new Int8Array(bytes);
    case COMPONENT_UBYTE:
      return new Uint8Array(bytes);
    case COMPONENT_SHORT:
      return new Int16Array(bytes);
    case COMPONENT_USHORT:
      return new Uint16Array(bytes);
    case COMPONENT_UINT:
      return new Uint32Array(bytes);
    default:
      return new Float32Array(bytes);
  }
}

/**
 * Read one accessor out of the BIN chunk, as its own `ArrayBuffer`.
 *
 * A copy rather than a view, and that is a deliberate match to what
 * `GLTFLoader` already did: it slices per buffer view, and since this pipeline
 * gives every accessor its own view the allocation profile is unchanged. A view
 * into the whole BIN chunk would be cheaper by one memcpy and would keep the
 * entire 1.6 MB payload alive for as long as the tile is resident, which across
 * a sixty-eight tile working set is a hundred megabytes of padding and indices
 * nothing reads.
 *
 * `slice` also removes the alignment question outright: the new buffer starts at
 * offset zero, so a `Float32Array` over it is always legal however the view was
 * placed in the file.
 */
function readAccessor(json: GltfJson, bin: ArrayBuffer, index: number): GlbAttribute['array'] {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`glb: no accessor ${index}`);
  if (accessor.bufferView === undefined) {
    // A view-less accessor is glTF's "all zeroes", which this pipeline never
    // emits. Refused rather than synthesised: silently handing back zeroes
    // would put a tile's worth of geometry at the origin.
    throw new Error(`glb: accessor ${index} has no bufferView`);
  }
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`glb: no bufferView ${accessor.bufferView}`);
  if (view.byteStride !== undefined && view.byteStride !== 0) {
    throw new Error('glb: interleaved bufferView, which this pipeline never writes');
  }
  const components = TYPE_COMPONENTS[accessor.type];
  const size = componentBytes(accessor.componentType);
  if (!components || !size) {
    throw new Error(`glb: accessor ${index} type ${accessor.type}/${accessor.componentType}`);
  }
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const length = accessor.count * components * size;
  if (start + length > bin.byteLength) throw new Error(`glb: accessor ${index} runs past the BIN chunk`);
  return makeArray(accessor.componentType, bin.slice(start, start + length));
}

/**
 * Parse one tile GLB into per-slot attribute arrays.
 *
 * `bldOffset` is the tile's row in the shared facade parameter atlas, folded
 * into `_BLDIDX` here rather than on the main thread. That fold is a pass over
 * every vertex of every building primitive in the tile -- up to a hundred
 * thousand floats -- and it is the one piece of the old build block that was
 * genuinely proportional to tile size. It can happen here because the atlas row
 * is allocated from the params sidecar, which lands before the decode is
 * dispatched. See `FacadeParamsAtlas.allocate` and `offsetBuildingIndices`,
 * whose loop this is.
 *
 * Throws on anything it does not recognise. A tile that fails to parse is
 * marked failed by the streamer and the world has a hole in it, which is a far
 * better symptom of a pipeline format change than a city of NaN vertices.
 */
export function parseTileGlb(buffer: ArrayBuffer, bldOffset: number): TileGlb {
  const head = new DataView(buffer);
  if (buffer.byteLength < 12 || head.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('glb: not a GLB');
  }
  const version = head.getUint32(4, true);
  if (version !== 2) throw new Error(`glb: version ${version}`);

  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  let at = 12;
  while (at + 8 <= buffer.byteLength) {
    const length = head.getUint32(at, true);
    const type = head.getUint32(at + 4, true);
    const body = at + 8;
    if (body + length > buffer.byteLength) throw new Error('glb: chunk runs past the file');
    if (type === CHUNK_JSON && json === null) {
      json = JSON.parse(utf8.decode(new Uint8Array(buffer, body, length))) as GltfJson;
    } else if (type === CHUNK_BIN && bin === null) {
      bin = buffer.slice(body, body + length);
    }
    // Chunks are four-byte aligned; the writer pads, so this is arithmetic
    // rather than a search.
    at = body + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('glb: no JSON chunk');
  if (!bin) throw new Error('glb: no BIN chunk');

  const materials = json.materials ?? [];
  const primitives: GlbPrimitive[] = [];
  // Every mesh in the file, though `write_glb` only ever writes one. Walking the
  // list rather than assuming index 0 costs nothing and means a second mesh
  // could never be silently dropped.
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      // Mode 4 is TRIANGLES, which is the only thing the pipeline emits. A
      // strip or a fan would draw as nonsense rather than fail, so it is
      // refused here.
      if (prim.mode !== undefined && prim.mode !== 4) {
        throw new Error(`glb: primitive mode ${prim.mode}`);
      }
      if (prim.indices === undefined) throw new Error('glb: non-indexed primitive');

      const attributes: GlbAttribute[] = [];
      for (const [semantic, accessorIndex] of Object.entries(prim.attributes ?? {})) {
        const accessor = json.accessors![accessorIndex];
        const array = readAccessor(json, bin, accessorIndex);
        const name = ATTRIBUTE_NAMES[semantic] ?? semantic.toLowerCase();
        if (name === BLDIDX_LOWER && bldOffset !== 0 && array instanceof Float32Array) {
          for (let i = 0; i < array.length; i++) array[i] += bldOffset;
        }
        attributes.push({
          name,
          array,
          itemSize: TYPE_COMPONENTS[accessor.type] ?? 1,
          normalized: accessor.normalized === true,
        });
      }

      const index = readAccessor(json, bin, prim.indices);
      if (!(index instanceof Uint32Array) && !(index instanceof Uint16Array)) {
        throw new Error('glb: index accessor is not an unsigned int');
      }
      primitives.push({
        material: materials[prim.material ?? -1]?.name ?? '',
        attributes,
        index,
      });
    }
  }
  return { primitives };
}

// --- The vegetation sidecar ---------------------------------------------------

/**
 * Species the client knows how to draw. Lives here rather than in
 * `vegetation.ts` because the decode clamps against it -- see below -- and the
 * clamp has to run where the decode runs. `vegetation.ts` re-exports it.
 */
export const SPECIES_COUNT = 6;

const VEG_STRIDE = 20;

/** One tile's instances, decoded from `<key>.veg.bin` as a structure of arrays. */
export interface TileVegetation {
  count: number;
  /** Tile-local metres, renderer axes. */
  x: Float32Array;
  z: Float32Array;
  height: Float32Array;
  radius: Float32Array;
  species: Uint8Array;
  seed: Uint8Array;
}

/**
 * Decode a `.veg.bin`. Returns `null` for anything that is not one, because a
 * tile with no trees must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodeVegetation(buffer: ArrayBuffer): TileVegetation | null {
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count === 0 || buffer.byteLength < 4 + count * VEG_STRIDE) return null;

  const out: TileVegetation = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    height: new Float32Array(count),
    radius: new Float32Array(count),
    species: new Uint8Array(count),
    seed: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const o = 4 + i * VEG_STRIDE;
    out.x[i] = view.getFloat32(o, true);
    out.z[i] = view.getFloat32(o + 4, true);
    out.height[i] = view.getFloat32(o + 8, true);
    out.radius[i] = view.getFloat32(o + 12, true);
    // Clamped rather than trusted: an out-of-range species index would read past
    // the geometry table and take the whole tile out with it.
    out.species[i] = Math.min(view.getUint8(o + 16), SPECIES_COUNT - 1);
    out.seed[i] = view.getUint8(o + 17);
  }
  return out;
}

// --- The power sidecar --------------------------------------------------------

/** Pole kinds: a plain one and a transformer. `power.ts` re-exports this. */
export const POLE_KIND_COUNT = 2;

const POLE_STRIDE = 20;
const WIRE_STRIDE = 24;

export interface TilePower {
  poleCount: number;
  /** Tile-local metres, renderer axes. */
  x: Float32Array;
  z: Float32Array;
  /** Absolute metres above the datum -- the terrain under the pole's foot. */
  groundY: Float32Array;
  /** Metres, ground to the top of the shaft. */
  height: Float32Array;
  kind: Uint8Array;
  tiltSeed: Uint8Array;
  wireCount: number;
  /**
   * Span endpoints, six floats each: ax, ay, az, bx, by, bz. X and Z are local
   * to *this* tile and Y is absolute, and one endpoint is routinely outside the
   * tile -- a span belongs to whichever tile holds its midpoint, so it reaches
   * up to half a span over the seam. Nothing here may clamp them.
   */
  wire: Float32Array;
}

/**
 * Decode a `.power.bin`. Returns `null` for anything that is not one, because a
 * tile with no poles must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodePower(buffer: ArrayBuffer): TilePower | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const poleCount = view.getUint32(0, true);
  const wireBase = 4 + poleCount * POLE_STRIDE;
  if (buffer.byteLength < wireBase + 4) return null;
  const wireCount = view.getUint32(wireBase, true);
  if (buffer.byteLength < wireBase + 4 + wireCount * WIRE_STRIDE) return null;
  if (poleCount === 0 && wireCount === 0) return null;

  const out: TilePower = {
    poleCount,
    x: new Float32Array(poleCount),
    z: new Float32Array(poleCount),
    groundY: new Float32Array(poleCount),
    height: new Float32Array(poleCount),
    kind: new Uint8Array(poleCount),
    tiltSeed: new Uint8Array(poleCount),
    wireCount,
    wire: new Float32Array(wireCount * 6),
  };
  for (let i = 0; i < poleCount; i++) {
    const o = 4 + i * POLE_STRIDE;
    out.x[i] = view.getFloat32(o, true);
    out.z[i] = view.getFloat32(o + 4, true);
    out.groundY[i] = view.getFloat32(o + 8, true);
    out.height[i] = view.getFloat32(o + 12, true);
    // Clamped rather than trusted: an out-of-range kind would read past the
    // geometry table and take the whole tile out with it.
    out.kind[i] = Math.min(view.getUint8(o + 16), POLE_KIND_COUNT - 1);
    out.tiltSeed[i] = view.getUint8(o + 17);
  }
  for (let i = 0; i < wireCount * 6; i++) {
    out.wire[i] = view.getFloat32(wireBase + 4 + i * 4, true);
  }
  return out;
}

// --- The street furniture sidecar ---------------------------------------------

/** Wheelie-bin lid colours. `furniture.ts` re-exports this. */
export const LID_COUNT = 3;
/** Signal lamp states: red, amber, green. `furniture.ts` re-exports this. */
export const LAMP_COUNT = 3;
/** Street-name blade styles: council green and RMS white. */
export const STYLE_COUNT = 2;

const FURN_MAGIC = 0x4e525546;
const FURN_VERSION = 2;
const BIN_STRIDE = 20;
const POST_HEADER = 16;
const SIGNAL_STRIDE = 20;
const MAX_BLADES = 2;
const MAX_NAME_BYTES = 128;

/** One tile's street furniture, decoded from `<key>.furn.bin`. */
export interface TileFurniture {
  binCount: number;
  /** Tile-local metres, renderer axes: x in [0, tileSize), z in (-tileSize, 0]. */
  binX: Float32Array;
  binZ: Float32Array;
  /** Absolute metres -- the **top of the footpath paving**, not the terrain. */
  binGroundY: Float32Array;
  binYaw: Float32Array;
  binLid: Uint8Array;

  postCount: number;
  postX: Float32Array;
  postZ: Float32Array;
  postGroundY: Float32Array;
  /** `STYLE_COS_GREEN` or `STYLE_RMS_WHITE`, per post. Both its blades share it. */
  postStyle: Uint8Array;

  /**
   * Blades, flattened across all posts with a parallel index back to the post
   * each belongs to.
   */
  bladeCount: number;
  bladePost: Uint32Array;
  /** Which blade this is on its own post: 0 is the upper one. Drives the stack. */
  bladeRank: Uint8Array;
  bladeYaw: Float32Array;
  /** The legend on each blade, in blade order. Empty strings for a v1 sidecar. */
  bladeName: string[];

  signalCount: number;
  signalX: Float32Array;
  signalZ: Float32Array;
  signalGroundY: Float32Array;
  signalYaw: Float32Array;
  signalLit: Uint8Array;
}

/**
 * Decode a `.furn.bin`. Returns `null` for anything that is not one, because a
 * tile with no furniture must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 *
 * The post block is the only variable-stride record in the build and so this is
 * the only decoder here that walks rather than indexes: each post is a 16-byte
 * header plus, per blade, a float yaw and a length-prefixed UTF-8 legend. Every
 * length is checked against the buffer before it is read, because a truncated
 * sidecar that decoded to a plausible count would produce NaN transforms rather
 * than a missing tile.
 *
 * **Two versions are read.** Version 2 opens on `FURN_MAGIC` and carries the
 * legends and the style; version 1 had no header at all and opened straight on
 * its bin count, so it is recognised by that first u32 *not* being the magic --
 * which is safe, because the magic is 1.3 billion and a bin count is capped at
 * 300 by `furniture.MAX_BINS_PER_TILE`. A v1 tile decodes to blank legends and
 * style 0, which is exactly the world it was written for.
 */
export function decodeFurniture(buffer: ArrayBuffer): TileFurniture | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  let o = 0;

  let version = 1;
  if (view.getUint32(0, true) === FURN_MAGIC) {
    version = view.getUint32(4, true);
    // An unknown *future* version is refused rather than guessed at. A newer
    // pipeline against an older client is a deployment mistake, and a tile with
    // no furniture is a far better symptom of it than a tile of NaN transforms.
    if (version !== FURN_VERSION) return null;
    o = 8;
  }

  const binCount = view.getUint32(o, true);
  o += 4;
  if (buffer.byteLength < o + binCount * BIN_STRIDE + 4) return null;
  const binBase = o;
  o += binCount * BIN_STRIDE;

  const postCount = view.getUint32(o, true);
  o += 4;
  // First walk: find where the post block ends and how many blades it holds.
  // Nothing is written yet, so a malformed block costs a scan and no allocation.
  const postBase = o;
  let bladeCount = 0;
  for (let i = 0; i < postCount; i++) {
    if (buffer.byteLength < o + POST_HEADER) return null;
    const blades = view.getUint8(o + 12);
    if (blades === 0 || blades > MAX_BLADES) return null;
    o += POST_HEADER;
    for (let k = 0; k < blades; k++) {
      // v1's blade record is the yaw and nothing else; v2 adds the length byte
      // and the bytes it counts.
      o += 4;
      if (version >= 2) {
        if (buffer.byteLength < o + 1) return null;
        const len = view.getUint8(o);
        if (len > MAX_NAME_BYTES) return null;
        o += 1 + len;
      }
      if (buffer.byteLength < o) return null;
    }
    bladeCount += blades;
  }

  if (buffer.byteLength < o + 4) return null;
  const signalCount = view.getUint32(o, true);
  o += 4;
  if (buffer.byteLength < o + signalCount * SIGNAL_STRIDE) return null;
  const signalBase = o;

  if (binCount === 0 && postCount === 0 && signalCount === 0) return null;

  const out: TileFurniture = {
    binCount,
    binX: new Float32Array(binCount),
    binZ: new Float32Array(binCount),
    binGroundY: new Float32Array(binCount),
    binYaw: new Float32Array(binCount),
    binLid: new Uint8Array(binCount),
    postCount,
    postX: new Float32Array(postCount),
    postZ: new Float32Array(postCount),
    postGroundY: new Float32Array(postCount),
    postStyle: new Uint8Array(postCount),
    bladeCount,
    bladePost: new Uint32Array(bladeCount),
    bladeRank: new Uint8Array(bladeCount),
    bladeYaw: new Float32Array(bladeCount),
    bladeName: new Array<string>(bladeCount).fill(''),
    signalCount,
    signalX: new Float32Array(signalCount),
    signalZ: new Float32Array(signalCount),
    signalGroundY: new Float32Array(signalCount),
    signalYaw: new Float32Array(signalCount),
    signalLit: new Uint8Array(signalCount),
  };

  for (let i = 0; i < binCount; i++) {
    const p = binBase + i * BIN_STRIDE;
    out.binX[i] = view.getFloat32(p, true);
    out.binZ[i] = view.getFloat32(p + 4, true);
    out.binGroundY[i] = view.getFloat32(p + 8, true);
    out.binYaw[i] = view.getFloat32(p + 12, true);
    // Clamped rather than trusted: an out-of-range lid would read past the
    // colour table and take the whole tile out with it.
    out.binLid[i] = Math.min(view.getUint8(p + 16), LID_COUNT - 1);
  }

  const bytes = new Uint8Array(buffer);

  let p = postBase;
  let b = 0;
  for (let i = 0; i < postCount; i++) {
    out.postX[i] = view.getFloat32(p, true);
    out.postZ[i] = view.getFloat32(p + 4, true);
    out.postGroundY[i] = view.getFloat32(p + 8, true);
    const blades = view.getUint8(p + 12);
    // Clamped rather than trusted, for the reason the lid and the lamp are: an
    // out-of-range style would read past the material table and take the tile
    // out with it.
    out.postStyle[i] = Math.min(view.getUint8(p + 13), STYLE_COUNT - 1);
    p += POST_HEADER;
    for (let k = 0; k < blades; k++) {
      out.bladePost[b] = i;
      out.bladeRank[b] = k;
      out.bladeYaw[b] = view.getFloat32(p, true);
      p += 4;
      if (version >= 2) {
        const len = view.getUint8(p);
        p += 1;
        if (len > 0) out.bladeName[b] = utf8.decode(bytes.subarray(p, p + len));
        p += len;
      }
      b++;
    }
  }

  for (let i = 0; i < signalCount; i++) {
    const q = signalBase + i * SIGNAL_STRIDE;
    out.signalX[i] = view.getFloat32(q, true);
    out.signalZ[i] = view.getFloat32(q + 4, true);
    out.signalGroundY[i] = view.getFloat32(q + 8, true);
    out.signalYaw[i] = view.getFloat32(q + 12, true);
    out.signalLit[i] = Math.min(view.getUint8(q + 16), LAMP_COUNT - 1);
  }
  return out;
}

// --- The powerup sidecar ------------------------------------------------------

/** Powerup kinds: a training bat and a flat white. `powerups.ts` re-exports it. */
export const POWERUP_KIND_COUNT = 2;

const POWERUP_STRIDE = 16;

/** One tile's powerups, decoded from `<key>.pow.bin`. */
export interface TilePowerupData {
  count: number;
  /** Tile-local metres, renderer axes: x in [0, tileSize), z in (-tileSize, 0]. */
  x: Float32Array;
  z: Float32Array;
  /** Absolute metres -- the top of the footpath paving, as the pipeline sampled it. */
  groundY: Float32Array;
  kind: Uint8Array;
}

/**
 * Decode a `.pow.bin`. Returns `null` for anything that is not one, because a
 * tile with no powerups must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodePowerups(buffer: ArrayBuffer): TilePowerupData | null {
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count === 0 || buffer.byteLength < 4 + count * POWERUP_STRIDE) return null;

  const out: TilePowerupData = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    groundY: new Float32Array(count),
    kind: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const p = 4 + i * POWERUP_STRIDE;
    out.x[i] = view.getFloat32(p, true);
    out.z[i] = view.getFloat32(p + 4, true);
    out.groundY[i] = view.getFloat32(p + 8, true);
    // Clamped rather than trusted: an out-of-range kind would read past the
    // colour table and take the whole tile out with it.
    out.kind[i] = Math.min(view.getUint8(p + 12), POWERUP_KIND_COUNT - 1);
  }
  return out;
}

// --- The street-name sidecar --------------------------------------------------

/** One continuous run of one named street. */
export interface NamedSegment {
  /**
   * The street's full display form -- 'King Street', never 'King St'.
   *
   * Shared by reference across every segment of the same street in a tile, out
   * of the file's own string table, so a name is one string however many runs
   * quote it. `postMessage` preserves that sharing: the structured clone
   * algorithm is defined over an object *graph*, so a name quoted by forty runs
   * crosses the thread boundary once.
   */
  readonly name: string;
  /** `[x0, z0, x1, z1, ...]`, at least two points. */
  readonly points: Float32Array;
  /** The run's own bounds, so the query rejects it without touching a point. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One tile's worth, held on the `LoadedTile` and dropped with it. */
export interface TileStreetNames {
  /** Distinct street names in this tile, in the file's table order. */
  readonly names: readonly string[];
  readonly segments: readonly NamedSegment[];
  /** Total points across every run. Reported; nothing reads it. */
  readonly pointCount: number;
}

/**
 * Decode one tile's `.names.bin`, or null if there is nothing usable in it.
 *
 * Returns tile-local coordinates. `translateStreetNames` is what makes them
 * world coordinates and must be called before the segments are queried.
 *
 * Defensive against a truncated file at every step rather than at the top,
 * because the record is variable-stride -- the point count is per segment -- so
 * there is no single length test that proves the file is whole. A short read
 * returns what was decoded up to that point instead of throwing: a tile with
 * three of its forty streets is a worse readout, and a tile that fails to load
 * is a hole in the city.
 */
export function decodeStreetNames(buffer: ArrayBuffer): TileStreetNames | null {
  if (buffer.byteLength < 3) return null;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let p = 0;

  const nameCount = view.getUint8(p);
  p += 1;
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) {
    if (p >= buffer.byteLength) return null;
    const len = view.getUint8(p);
    p += 1;
    if (p + len > buffer.byteLength) return null;
    names.push(utf8.decode(bytes.subarray(p, p + len)));
    p += len;
  }
  if (names.length === 0 || p + 2 > buffer.byteLength) return null;

  const segCount = view.getUint16(p, true);
  p += 2;
  const segments: NamedSegment[] = [];
  let pointCount = 0;
  for (let s = 0; s < segCount; s++) {
    if (p + 2 > buffer.byteLength) break;
    const nameIdx = view.getUint8(p);
    const n = view.getUint8(p + 1);
    p += 2;
    const need = n * 8;
    if (p + need > buffer.byteLength) break;
    // A name index past the table is a file this decoder does not understand,
    // and the run is dropped rather than clamped: clamping would put a piece of
    // some *other* street on the map under the wrong name, which is the one
    // failure a readout must not have.
    if (nameIdx >= names.length || n < 2) {
      p += need;
      continue;
    }
    const points = new Float32Array(n * 2);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = view.getFloat32(p + i * 8, true);
      const z = view.getFloat32(p + i * 8 + 4, true);
      points[i * 2] = x;
      points[i * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    p += need;
    segments.push({ name: names[nameIdx], points, minX, minZ, maxX, maxZ });
    pointCount += n;
  }
  if (segments.length === 0) return null;
  return { names, segments, pointCount };
}

/**
 * Lift a decoded tile from tile-local metres into world metres, in place.
 *
 * Called once per tile with the tile group's own translation, which is the same
 * `(minX, minZ + tileSize)` every other per-tile payload is offset by. Mutating
 * rather than copying is deliberate -- the arrays were allocated by the decode a
 * moment ago and have no other owner.
 *
 * Runs on the decode thread now: the streamer passes the tile origin down with
 * the bytes, so the segments cross the thread boundary already in world metres
 * and the main thread never walks them at all.
 */
export function translateStreetNames(tile: TileStreetNames, dx: number, dz: number): void {
  for (const seg of tile.segments) {
    const pts = seg.points;
    for (let i = 0; i < pts.length; i += 2) {
      pts[i] += dx;
      pts[i + 1] += dz;
    }
    seg.minX += dx;
    seg.maxX += dx;
    seg.minZ += dz;
    seg.maxZ += dz;
  }
}

// --- The water sidecar --------------------------------------------------------

/**
 * `.water.bin`'s header. **Must match `WATER_MAGIC` and `WATER_VERSION` in
 * `pipeline/sydney/tiles.py`.** Exported because `verifyWater` writes a
 * synthetic payload against them and a check that made up its own magic would
 * prove nothing about the file the pipeline emits.
 */
export const WATER_MAGIC = 0x52544157; // "WATR", little-endian
export const WATER_VERSION = 1;
/** Header and per-sheet header sizes, in bytes. See `tiles.write_water`. */
export const WATER_HEADER = 12;
export const SHEET_HEADER = 12;
/** x, z and depth, three floats a vertex. */
export const WATER_VERTEX_STRIDE = 12;

/** One flat run of water at a single surface height. */
export interface WaterSheet {
  /** World y of the surface. Absolute -- a tile's group sits at y = 0. */
  surface: number;
  /** Interleaved x, z, depth, three floats a vertex. */
  vertices: Float32Array;
  indices: Uint32Array;
  count: number;
}

export interface TileWater {
  sheets: WaterSheet[];
  /** Triangles across every sheet. Reported by the streamer, used by nothing. */
  triangles: number;
}

/**
 * Decode a `.water.bin` or `far-water.bin`. `null` for anything that is not one.
 *
 * Every length is checked against the buffer before it is read. A truncated
 * sidecar is what a rebuild interrupted mid-write leaves behind, and the failure
 * mode of trusting it is a `RangeError` thrown inside the streamer's tile load,
 * which takes the whole tile down.
 */
export function decodeWater(buffer: ArrayBuffer): TileWater | null {
  if (buffer.byteLength < WATER_HEADER) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== WATER_MAGIC) return null;
  if (view.getUint32(4, true) !== WATER_VERSION) return null;
  const sheetCount = view.getUint32(8, true);
  if (sheetCount === 0) return null;

  const sheets: WaterSheet[] = [];
  let triangles = 0;
  let at = WATER_HEADER;
  for (let s = 0; s < sheetCount; s++) {
    if (at + SHEET_HEADER > buffer.byteLength) return null;
    const surface = view.getFloat32(at, true);
    const vertexCount = view.getUint32(at + 4, true);
    const indexCount = view.getUint32(at + 8, true);
    at += SHEET_HEADER;
    const need = vertexCount * WATER_VERTEX_STRIDE + indexCount * 4;
    if (vertexCount === 0 || indexCount === 0 || at + need > buffer.byteLength) return null;
    // Copies rather than views. The offsets are 4-byte aligned by construction
    // -- every field in this format is a 4-byte word -- but a `Float32Array`
    // view would keep the whole payload alive for as long as the tile is
    // resident, which for the far sheet is the session.
    const vertices = new Float32Array(buffer.slice(at, at + vertexCount * WATER_VERTEX_STRIDE));
    at += vertexCount * WATER_VERTEX_STRIDE;
    const indices = new Uint32Array(buffer.slice(at, at + indexCount * 4));
    at += indexCount * 4;
    sheets.push({ surface, vertices, indices, count: vertexCount });
    triangles += indexCount / 3;
  }
  return { sheets, triangles };
}

// --- The whole job, as one function both threads run --------------------------

/**
 * One tile's bytes, as handed to whichever thread is going to decode them.
 *
 * The GLB and the six sidecars in here are the ones that go across; `.cars.bin`
 * and `.lanes.bin` are deliberately absent and `streamer.loadTile` says why.
 * `null` means the index said this tile has none, or the fetch failed -- the two
 * are the same answer to every consumer.
 */
export interface TileDecodeRequest {
  key: string;
  /** The tile's row in the shared parameter atlas, folded into `_BLDIDX`. */
  bldOffset: number;
  /** The tile group's world translation, folded into the street centrelines. */
  originX: number;
  originZ: number;
  glb: ArrayBuffer;
  veg: ArrayBuffer | null;
  power: ArrayBuffer | null;
  furn: ArrayBuffer | null;
  pow: ArrayBuffer | null;
  names: ArrayBuffer | null;
  water: ArrayBuffer | null;
}

/** What comes back. Every field is plain data; nothing here touches a GPU. */
export interface TileDecodeResult {
  key: string;
  glb: TileGlb;
  veg: TileVegetation | null;
  power: TilePower | null;
  furn: TileFurniture | null;
  pow: TilePowerupData | null;
  names: TileStreetNames | null;
  water: TileWater | null;
}

/**
 * Decode one tile, start to finish.
 *
 * **The single implementation both threads run.** `decode.worker.ts` calls it on
 * a worker; `TileDecoder` calls it inline on the main thread when a worker
 * cannot be created. That is what makes the fallback a fallback rather than a
 * second implementation waiting to disagree with the first, and it is also what
 * makes `verifyTileDecode` a check on the *message protocol* rather than on the
 * arithmetic -- the arithmetic is the same object code.
 *
 * The GLB is the only payload allowed to throw. Every sidecar answers a missing,
 * truncated or malformed file with `null`, which is exactly what the streamer
 * does with a tile the index says has none.
 */
export function decodeTilePayload(req: TileDecodeRequest): TileDecodeResult {
  const names = req.names === null ? null : safe(() => decodeStreetNames(req.names!));
  if (names !== null) translateStreetNames(names, req.originX, req.originZ);
  return {
    key: req.key,
    glb: parseTileGlb(req.glb, req.bldOffset),
    veg: req.veg === null ? null : safe(() => decodeVegetation(req.veg!)),
    power: req.power === null ? null : safe(() => decodePower(req.power!)),
    furn: req.furn === null ? null : safe(() => decodeFurniture(req.furn!)),
    pow: req.pow === null ? null : safe(() => decodePowerups(req.pow!)),
    names,
    water: req.water === null ? null : safe(() => decodeWater(req.water!)),
  };
}

/**
 * A decoder's answer, or null if it threw.
 *
 * The decoders above are written to return null rather than throw, and this is
 * the belt to that pair of braces: a sidecar must never be able to fail a tile,
 * because the world is older than most of these passes and a tile directory
 * from before one of them has to keep loading. See `streamer.loadVegetation`,
 * which is where this contract was written down first.
 */
function safe<T>(run: () => T | null): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

/**
 * Every `ArrayBuffer` in a result, for `postMessage`'s transfer list.
 *
 * Transferring rather than cloning is the difference between handing over a
 * pointer and copying 1.6 MB per tile back across the thread boundary, which
 * would put a good part of the cost this change exists to remove straight back
 * on the main thread -- structured cloning happens on the *sending* side for
 * the copy and the *receiving* side for the deserialise, and the receiving side
 * is the render thread.
 *
 * The buffers are dead in the worker the instant this returns, which is correct:
 * the worker holds no state between tiles.
 */
export function tileDecodeTransfers(result: TileDecodeResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const prim of result.glb.primitives) {
    for (const attr of prim.attributes) out.push(attr.array.buffer as ArrayBuffer);
    out.push(prim.index.buffer as ArrayBuffer);
  }
  const push = (a: ArrayBufferView | undefined): void => {
    if (a) out.push(a.buffer as ArrayBuffer);
  };
  const veg = result.veg;
  if (veg) for (const a of [veg.x, veg.z, veg.height, veg.radius, veg.species, veg.seed]) push(a);
  const power = result.power;
  if (power) {
    for (const a of [power.x, power.z, power.groundY, power.height, power.kind, power.tiltSeed, power.wire]) push(a);
  }
  const furn = result.furn;
  if (furn) {
    for (const a of [
      furn.binX, furn.binZ, furn.binGroundY, furn.binYaw, furn.binLid,
      furn.postX, furn.postZ, furn.postGroundY, furn.postStyle,
      furn.bladePost, furn.bladeRank, furn.bladeYaw,
      furn.signalX, furn.signalZ, furn.signalGroundY, furn.signalYaw, furn.signalLit,
    ]) push(a);
  }
  const pow = result.pow;
  if (pow) for (const a of [pow.x, pow.z, pow.groundY, pow.kind]) push(a);
  const names = result.names;
  if (names) for (const seg of names.segments) push(seg.points);
  const water = result.water;
  if (water) for (const sheet of water.sheets) { push(sheet.vertices); push(sheet.indices); }
  // A zero-length typed array shares the one detached-safe empty buffer in some
  // engines, and a transfer list may not name the same buffer twice.
  return [...new Set(out)].filter((b) => b.byteLength > 0);
}
