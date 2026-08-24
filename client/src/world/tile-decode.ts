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
 *
 * ---------------------------------------------------------------------------
 * THE PACKED ATTRIBUTES, which is the other half of `pipeline/sydney/meshpack.py`
 * and where most of the arithmetic in this file now lives.
 *
 * Tile geometry was 96% of a 613 MB world and every column of it was float32
 * holding values that did not need a float32. The pipeline now quantises
 * positions and metric UVs to uint16 per axis, narrows normals to int8 and
 * `_BLDIDX` and the indices to uint16, and delta-codes everything that is not
 * already one byte wide -- 2.25x off the raw bytes and 1.82x off the wire after
 * brotli. `meshpack`'s header carries the measurements and the schemes that
 * were tried and rejected.
 *
 * **What comes out of here is unchanged.** Positions, normals, UVs and
 * `_BLDIDX` are handed back as `Float32Array`, normals renormalised, colour
 * still normalised `Uint8Array`. That is not conservatism; it is the pipeline
 * cache key. Three's `getGeometryCacheKey` reads each attribute's name, item
 * size and `normalized` flag, and `world/warmup.ts` compiles a pipeline at boot
 * against stand-in geometry built from exactly those types -- see the note there
 * about the colour attribute. An int8 normal reaching the GPU would key
 * differently from the stand-in, and the first tile of the session would pay a
 * shader compile on the render thread, which is the precise hitch this whole
 * decode-thread architecture exists to remove. The bytes are saved on the wire,
 * where the problem was; the GPU sees what it always saw.
 *
 * The dequantisation is one multiply-add per component fused into the delta's
 * prefix sum, so it is a single pass over an array that is now less than half
 * the size it used to be -- the pass replaces a `slice` of twice the bytes.
 *
 * The atlas-offset fold into `_BLDIDX` happens in that same pass. `_BLDIDX` is
 * **exact**: it is a row number in the facade parameter atlas, it is stored as
 * an integer and widened to the float32 the pipeline wrote, and a value one off
 * is a terrace house drawn with a tower's window grammar. `verifyMeshPack`
 * below and `verifyStreaming` in `streamer.ts` both assert that separately from
 * everything else.
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

/**
 * How one accessor was packed, out of its glTF `extras`.
 *
 * `extras` is legal glTF that every other loader ignores, which is what lets a
 * packed tile still be read by `GLTFLoader` -- and therefore what keeps
 * `verifyTileGlbParse`'s comparison against `GLTFLoader` alive. **Must match
 * what `pipeline/sydney/meshpack.py` writes.**
 */
interface PackExtras {
  /** `[ox, oy, oz, sx, sy, sz]`: per-axis offset then per-axis scale. */
  q?: number[];
  /** Delta-coded along the vertex axis, per component. */
  d?: number;
  /** An integer column widened to float32 exactly -- `_BLDIDX`. */
  i?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  extras?: PackExtras;
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
/**
 * The stored column, as a *view* into the BIN chunk rather than a copy.
 *
 * A view where `readAccessor` slices, because every caller below is about to
 * write a freshly allocated output array anyway -- the copy would be a second
 * pass over the same bytes for nothing. `write_glb` pads the blob to four bytes
 * before every buffer view and gives each accessor its own view at offset zero,
 * so `start` is always a multiple of four and a typed-array view over it is
 * always legal. That is checked here rather than assumed, because the failure
 * of assuming it is a `RangeError` from a constructor, thrown inside the worker,
 * with nothing in the message about which tile it came from.
 */
function accessorView(
  json: GltfJson,
  bin: ArrayBuffer,
  index: number,
): { view: GlbAttribute['array']; accessor: GltfAccessor; components: number } {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`glb: no accessor ${index}`);
  if (accessor.bufferView === undefined) throw new Error(`glb: accessor ${index} has no bufferView`);
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`glb: no bufferView ${accessor.bufferView}`);
  if (bufferView.byteStride !== undefined && bufferView.byteStride !== 0) {
    throw new Error('glb: interleaved bufferView, which this pipeline never writes');
  }
  const components = TYPE_COMPONENTS[accessor.type];
  const size = componentBytes(accessor.componentType);
  if (!components || !size) {
    throw new Error(`glb: accessor ${index} type ${accessor.type}/${accessor.componentType}`);
  }
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const length = accessor.count * components * size;
  if (start + length > bin.byteLength) {
    throw new Error(`glb: accessor ${index} runs past the BIN chunk`);
  }
  if (start % size !== 0) throw new Error(`glb: accessor ${index} is misaligned at ${start}`);
  const count = accessor.count * components;
  let view: GlbAttribute['array'];
  switch (accessor.componentType) {
    case COMPONENT_BYTE:
      view = new Int8Array(bin, start, count);
      break;
    case COMPONENT_UBYTE:
      view = new Uint8Array(bin, start, count);
      break;
    case COMPONENT_SHORT:
      view = new Int16Array(bin, start, count);
      break;
    case COMPONENT_USHORT:
      view = new Uint16Array(bin, start, count);
      break;
    case COMPONENT_UINT:
      view = new Uint32Array(bin, start, count);
      break;
    default:
      view = new Float32Array(bin, start, count);
      break;
  }
  return { view, accessor, components };
}

/**
 * Undo the delta filter and the quantisation in one pass, into float32.
 *
 * `bias` is added to every value on the way out, which is how the atlas-row
 * fold into `_BLDIDX` rides along for free -- it used to be a separate pass
 * over every vertex of every building primitive in the tile.
 *
 * The prefix sum is modular in the stored width, exactly as
 * `meshpack.delta_encode` produced it, so a column that wraps reconstructs
 * without a special case. `mask` is the whole of that: `& 0xffff` for uint16
 * and `>>> 0` for uint32, and the accumulator never leaves the safe integer
 * range in between because both operands are below 2^32.
 */
function unpackToFloat(
  raw: GlbAttribute['array'],
  components: number,
  extras: PackExtras | undefined,
  bias: number,
): Float32Array {
  const n = raw.length;
  const out = new Float32Array(n);
  const q = extras?.q;
  const delta = extras?.d === 1;

  if (!delta && !q) {
    // A float column the pipeline left alone -- a UV span too long to quantise
    // within a centimetre, which is a handful of long kerb runs in the build --
    // or the whole of a tile written before this format existed.
    for (let i = 0; i < n; i++) out[i] = raw[i] + bias;
    return out;
  }

  // Offsets and scales in locals, not an array lookup per component. This is
  // the loop that runs over every vertex in the city and the difference is
  // measurable.
  const o0 = q ? q[0] : 0;
  const s0 = q ? q[components] : 1;

  // Three specialised loops rather than one general one, and the specialisation
  // is worth the repetition: `components` is a runtime value, so a general loop
  // carries a branch per component that the engine cannot hoist, and VEC3
  // position is 30% of every tile.
  if (delta && raw instanceof Uint16Array) {
    if (components === 3) {
      const o1 = q ? q[1] : 0;
      const o2 = q ? q[2] : 0;
      const s1 = q ? q[4] : 1;
      const s2 = q ? q[5] : 1;
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let i = 0; i < n; i += 3) {
        a0 = (a0 + raw[i]) & 0xffff;
        a1 = (a1 + raw[i + 1]) & 0xffff;
        a2 = (a2 + raw[i + 2]) & 0xffff;
        out[i] = a0 * s0 + o0 + bias;
        out[i + 1] = a1 * s1 + o1 + bias;
        out[i + 2] = a2 * s2 + o2 + bias;
      }
      return out;
    }
    if (components === 2) {
      const o1 = q ? q[1] : 0;
      const s1 = q ? q[3] : 1;
      let a0 = 0;
      let a1 = 0;
      for (let i = 0; i < n; i += 2) {
        a0 = (a0 + raw[i]) & 0xffff;
        a1 = (a1 + raw[i + 1]) & 0xffff;
        out[i] = a0 * s0 + o0 + bias;
        out[i + 1] = a1 * s1 + o1 + bias;
      }
      return out;
    }
    if (components === 1) {
      let a0 = 0;
      for (let i = 0; i < n; i++) {
        a0 = (a0 + raw[i]) & 0xffff;
        out[i] = a0 * s0 + o0 + bias;
      }
      return out;
    }
  }

  // The general case, for anything the fast paths above do not cover: a wider
  // stored width, more than three components, or a quantised column with no
  // delta filter. Correct rather than quick, because nothing in the build takes
  // it -- and it is here so that a format that grows one does not silently
  // decode to the wrong thing.
  const wide = raw instanceof Uint32Array;
  const acc = new Float64Array(components);
  for (let i = 0; i < n; i += components) {
    for (let c = 0; c < components; c++) {
      if (delta) {
        acc[c] = wide ? (acc[c] + raw[i + c]) >>> 0 : (acc[c] + raw[i + c]) & 0xffff;
      } else {
        acc[c] = raw[i + c];
      }
      const scale = q ? q[components + c] : 1;
      const offset = q ? q[c] : 0;
      out[i + c] = acc[c] * scale + offset + bias;
    }
  }
  return out;
}

/**
 * Undo the delta filter on an index buffer, keeping it an integer array.
 *
 * Separate from `unpackToFloat` because an index must never touch a float: at
 * 33,441 vertices it would survive one, but the type it comes back as is what
 * three binds the index buffer with, and `warmup.ts`'s stand-in geometry is
 * indexed with a `Uint16Array` -- which is now what a tile hands over too.
 */
function unpackIndex(raw: Uint16Array | Uint32Array, delta: boolean): Uint16Array | Uint32Array {
  if (!delta) return raw.slice();
  const n = raw.length;
  const wide = raw instanceof Uint32Array;
  const out = wide ? new Uint32Array(n) : new Uint16Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = wide ? (acc + raw[i]) >>> 0 : (acc + raw[i]) & 0xffff;
    out[i] = acc;
  }
  return out;
}

/**
 * int8 normals back to unit float32.
 *
 * Renormalised rather than just scaled: `q / 127` has a length within 0.6% of
 * one, which no lighting in this client can see, but the shader path is TSL and
 * whether every node on it normalises is not a thing this file should have to
 * know. One reciprocal square root per vertex settles it.
 *
 * A zero normal stays zero. The build has 13,648 of them out of 13.8 M, from
 * degenerate source triangles, and inventing a direction for one here would be
 * the decoder deciding how the city is lit.
 */
function unpackNormals(raw: Int8Array): Float32Array {
  const n = raw.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    const x = raw[i];
    const y = raw[i + 1];
    const z = raw[i + 2];
    const sq = x * x + y * y + z * z;
    if (sq > 0) {
      // One reciprocal square root and three multiplies. The 1/127 the encoder
      // divided by cancels out of a renormalisation, so it is not applied at
      // all -- the direction is what survives quantisation, and the length is
      // reconstructed rather than carried.
      const inv = 1 / Math.sqrt(sq);
      out[i] = x * inv;
      out[i + 1] = y * inv;
      out[i + 2] = z * inv;
    }
  }
  return out;
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
        const { view, accessor, components } = accessorView(json, bin, accessorIndex);
        const name = ATTRIBUTE_NAMES[semantic] ?? semantic.toLowerCase();

        // Colour is the one attribute the pipeline leaves alone -- it is already
        // one normalised byte a component -- and it is also the one the GPU
        // takes as an integer, so it is copied out as it stands. A copy rather
        // than the view, so the tile does not hold the whole BIN chunk alive
        // for as long as it is resident.
        if (semantic === 'COLOR_0') {
          attributes.push({
            name,
            array: view.slice() as GlbAttribute['array'],
            itemSize: components,
            normalized: accessor.normalized === true,
          });
          continue;
        }

        // Normals come off the wire as int8 and go to the GPU as float32. See
        // this file's header for why they are not left as int8: the geometry
        // cache key, and the pipeline `warmup.ts` compiled against it.
        if (semantic === 'NORMAL' && view instanceof Int8Array) {
          attributes.push({ name, array: unpackNormals(view), itemSize: 3, normalized: false });
          continue;
        }

        // Everything else -- position, metric UV, `_BLDIDX` -- comes back as
        // float32 with the delta and the quantisation undone in one pass, and
        // the atlas row folded into `_BLDIDX` on the way past.
        attributes.push({
          name,
          array: unpackToFloat(
            view,
            components,
            accessor.extras,
            name === BLDIDX_LOWER ? bldOffset : 0,
          ),
          itemSize: components,
          normalized: false,
        });
      }

      const packedIndex = accessorView(json, bin, prim.indices);
      if (
        !(packedIndex.view instanceof Uint32Array) &&
        !(packedIndex.view instanceof Uint16Array)
      ) {
        throw new Error('glb: index accessor is not an unsigned int');
      }
      const index = unpackIndex(packedIndex.view, packedIndex.accessor.extras?.d === 1);
      primitives.push({
        material: materials[prim.material ?? -1]?.name ?? '',
        attributes,
        index,
      });
    }
  }
  return { primitives };
}

// --- The pack format, checked against itself ----------------------------------

/**
 * The packing this decoder understands. **Must match `PACK_VERSION` in
 * `pipeline/sydney/meshpack.py`.**
 *
 * It rides in `index.json` as `geometry.pack`, and `streamer.verifyStreaming`
 * refuses a build that names a different one. A tile decoded by the wrong rules
 * is not a subtly wrong tile -- it is a city of noise -- so the failure has to
 * be loud and has to happen at boot rather than on the first tile that happens
 * to use whichever field changed.
 */
export const TILE_PACK_VERSION = 1;

/**
 * A packed GLB built from known values, parsed back, compared.
 *
 * **The bit-exact round trip.** It is here and not in the streamer because it
 * needs no network, no `three` and no DOM -- so `server/integration-check.ts`
 * runs it in the suite alongside every other pure check, and `verifyStreaming`
 * runs it in the browser against the same code. What it proves is the part of
 * the format that a comparison against `GLTFLoader` on a real tile *cannot*:
 * `GLTFLoader` hands back the stored integers, so comparing against it proves
 * the container was read correctly and says nothing about whether the
 * dequantisation is right. This proves the arithmetic.
 *
 * The three claims, one assertion each:
 *
 *   1. **`_BLDIDX` is exact.** Integers in, the same integers out, plus the
 *      atlas offset. Not "within a tolerance" -- equal. A row number one off is
 *      a building drawn with another building's facade grammar, and it is the
 *      one column in the file where quantisation would be a bug rather than a
 *      trade.
 *   2. **Indices are exact**, through the delta filter, including a wrap.
 *   3. **Positions and UVs come back inside the quantum.** The bound is the
 *      per-axis step the writer chose, which is what the error claim in
 *      `index.json`'s `geometry` block is denominated in.
 *
 * Returns a list of failures, like every other check in this client.
 */
export function verifyMeshPack(): string[] {
  const failures: string[] = [];

  // A primitive with a deliberately awkward shape: a 500 m x 40 m x 500 m
  // extent like a real tile, a degenerate axis (every vertex at the same v),
  // and an index buffer whose deltas go backwards.
  const count = 64;
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const bld = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    position[i * 3] = (i / (count - 1)) * 500;
    position[i * 3 + 1] = (i % 7) * 6.5;
    position[i * 3 + 2] = -((i / (count - 1)) * 500);
    uv[i * 2] = i * 3.25;
    uv[i * 2 + 1] = 12.5; // degenerate axis: span 0
    bld[i] = (i * 13) % 770;
  }
  const index = new Uint16Array(count * 3);
  for (let i = 0; i < count; i++) {
    index[i * 3] = (count - 1 - i) % count;
    index[i * 3 + 1] = i;
    index[i * 3 + 2] = (i * 31) % count;
  }

  const bias = 11;
  const glb = packSyntheticGlb(position, uv, bld, index);
  let parsed: TileGlb;
  try {
    parsed = parseTileGlb(glb, bias);
  } catch (err) {
    return [`verifyMeshPack could not parse its own GLB: ${String(err)}`];
  }
  if (parsed.primitives.length !== 1) {
    return [`verifyMeshPack: ${parsed.primitives.length} primitives, expected 1`];
  }
  const prim = parsed.primitives[0];
  const by = new Map(prim.attributes.map((a) => [a.name, a]));

  const gotBld = by.get(BLDIDX_LOWER)?.array;
  if (!(gotBld instanceof Float32Array)) {
    failures.push('_BLDIDX did not come back as a Float32Array');
  } else {
    for (let i = 0; i < count; i++) {
      if (gotBld[i] !== bld[i] + bias) {
        failures.push(
          `_BLDIDX[${i}] is ${gotBld[i]}, expected exactly ${bld[i] + bias}. ` +
            'The facade parameter index must survive packing bit for bit.',
        );
        break;
      }
    }
  }

  if (prim.index.length !== index.length) {
    failures.push(`index count ${prim.index.length}, expected ${index.length}`);
  } else {
    for (let i = 0; i < index.length; i++) {
      if (prim.index[i] !== index[i]) {
        failures.push(`index[${i}] is ${prim.index[i]}, expected ${index[i]} (delta filter)`);
        break;
      }
    }
  }

  // 500 m over 65,535 steps is a 7.6 mm quantum, so half of it is the bound;
  // a little slack for the float32 the value is stored back into.
  const bound = (500 / 65535) * 0.5 + 1e-4;
  const gotPos = by.get('position')?.array;
  if (!(gotPos instanceof Float32Array)) {
    failures.push('position did not come back as a Float32Array');
  } else {
    let worst = 0;
    for (let i = 0; i < position.length; i++) worst = Math.max(worst, Math.abs(gotPos[i] - position[i]));
    if (worst > bound) failures.push(`position error ${(worst * 1000).toFixed(3)} mm exceeds the quantum`);
  }
  const gotUv = by.get('uv')?.array;
  if (!(gotUv instanceof Float32Array)) {
    failures.push('uv did not come back as a Float32Array');
  } else {
    let worst = 0;
    for (let i = 0; i < uv.length; i++) worst = Math.max(worst, Math.abs(gotUv[i] - uv[i]));
    // The v column has zero span, so it must be reproduced exactly -- a
    // degenerate axis is where a scale of zero would show up as NaN.
    for (let i = 1; i < uv.length; i += 2) {
      if (gotUv[i] !== uv[i]) {
        failures.push(`uv v[${i}] is ${gotUv[i]}, expected exactly ${uv[i]} (degenerate axis)`);
        break;
      }
    }
    if (worst > (uv[uv.length - 2] / 65535) * 0.5 + 1e-3) {
      failures.push(`uv error ${(worst * 1000).toFixed(3)} mm exceeds the quantum`);
    }
  }

  return failures;
}

/**
 * The pipeline's writer, in miniature, for `verifyMeshPack` only.
 *
 * A deliberate second implementation rather than a fixture: a fixture would go
 * stale the moment `meshpack.py` changed and would fail as "the check is old"
 * rather than as "the format moved". This is small enough to read against
 * `meshpack.pack_*` line for line, and if the two ever disagree the round trip
 * above is what says so.
 */
function packSyntheticGlb(
  position: Float32Array,
  uv: Float32Array,
  bld: Float32Array,
  index: Uint16Array,
): ArrayBuffer {
  const bin: number[] = [];
  const views: Array<{ byteOffset: number; byteLength: number }> = [];
  const accessors: GltfAccessor[] = [];

  const push = (bytes: Uint8Array): number => {
    while (bin.length % 4) bin.push(0);
    const byteOffset = bin.length;
    for (const b of bytes) bin.push(b);
    views.push({ byteOffset, byteLength: bytes.length });
    return views.length - 1;
  };

  const quantise = (values: Float32Array, components: number): number[] => {
    const offset: number[] = [];
    const scale: number[] = [];
    for (let c = 0; c < components; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = c; i < values.length; i += components) {
        lo = Math.min(lo, values[i]);
        hi = Math.max(hi, values[i]);
      }
      offset.push(lo);
      scale.push(hi > lo ? (hi - lo) / 65535 : 1);
    }
    const codes = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const c = i % components;
      codes[i] = Math.round((values[i] - offset[c]) / scale[c]);
    }
    deltaInPlace(codes, components);
    push(new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength));
    return [...offset, ...scale];
  };

  const addQuantised = (values: Float32Array, components: number, type: string): number => {
    const q = quantise(values, components);
    accessors.push({
      bufferView: views.length - 1,
      componentType: COMPONENT_USHORT,
      count: values.length / components,
      type,
      extras: { q, d: 1 },
    });
    return accessors.length - 1;
  };

  const positionAccessor = addQuantised(position, 3, 'VEC3');
  const uvAccessor = addQuantised(uv, 2, 'VEC2');

  const bldCodes = new Uint16Array(bld.length);
  for (let i = 0; i < bld.length; i++) bldCodes[i] = bld[i];
  deltaInPlace(bldCodes, 1);
  push(new Uint8Array(bldCodes.buffer, bldCodes.byteOffset, bldCodes.byteLength));
  accessors.push({
    bufferView: views.length - 1,
    componentType: COMPONENT_USHORT,
    count: bld.length,
    type: 'SCALAR',
    extras: { i: 1, d: 1 },
  });
  const bldAccessor = accessors.length - 1;

  const indexCodes = index.slice();
  deltaInPlace(indexCodes, 1);
  push(new Uint8Array(indexCodes.buffer, indexCodes.byteOffset, indexCodes.byteLength));
  accessors.push({
    bufferView: views.length - 1,
    componentType: COMPONENT_USHORT,
    count: index.length,
    type: 'SCALAR',
    extras: { d: 1 },
  });
  const indexAccessor = accessors.length - 1;

  const json = JSON.stringify({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_mesh_quantization', 'SYD_mesh_pack'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ name: 'brick_red' }],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: positionAccessor,
              TEXCOORD_0: uvAccessor,
              _BLDIDX: bldAccessor,
            },
            indices: indexAccessor,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    accessors,
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    buffers: [{ byteLength: bin.length }],
  });

  const jsonBytes = new TextEncoder().encode(json);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) bytes[20 + jsonBytes.length + i] = 0x20;
  const binChunk = 20 + jsonBytes.length + jsonPad;
  view.setUint32(binChunk, bin.length + binPad, true);
  view.setUint32(binChunk + 4, 0x004e4942, true);
  bytes.set(new Uint8Array(bin), binChunk + 8);
  return out;
}

/** `meshpack.delta_encode`, in place, modular in the stored width. */
function deltaInPlace(values: Uint16Array, components: number): void {
  for (let i = values.length - components; i >= components; i -= components) {
    for (let c = 0; c < components; c++) {
      values[i + c] = (values[i + c] - values[i + c - components]) & 0xffff;
    }
  }
}

// --- The vegetation sidecar ---------------------------------------------------

/**
 * Species the client knows how to draw. Lives here rather than in
 * `vegetation.ts` because the decode clamps against it -- see below -- and the
 * clamp has to run where the decode runs. `vegetation.ts` re-exports it.
 *
 * Eight since the bushland round: `SHRUB` is index 6 and `BUSH_TREE` is 7. The
 * clamp is what makes that a safe direction to move in -- a client on the old
 * six reading a world that ships shrubs draws them as eucalypts, which is wrong
 * and is not a crash, and a client on eight reading an old world simply never
 * sees a 6 or a 7.
 */
export const SPECIES_COUNT = 8;

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

// --- One stem is not the tree beside it ---------------------------------------

/**
 * The species indices, and they live here for the same reason `SPECIES_COUNT`
 * does: the decode clamps against the count, the variation table below is keyed
 * by the index, and both of those run where there is no `three`.
 * `world/vegetation.ts` imports them rather than keeping a second copy, because
 * a second copy of an APPEND-ONLY wire enumeration is exactly the thing that
 * shipped `NOMINAL` two rows short.
 */
export const FIG = 0;
export const PLANE = 1;
export const JACARANDA = 2;
export const PAPERBARK = 3;
export const BRUSH_BOX = 4;
export const EUCALYPT = 5;
export const SHRUB = 6;
export const BUSH_TREE = 7;

/**
 * Deterministic hash, [0, 1). Integer parts only.
 *
 * Was `world/vegetation.ts`'s private author-time helper and is now shared,
 * because the per-instance path below wants exactly the same function and two
 * copies of a hash is two different worlds the first time one of them is
 * tuned. Still cheap enough for the per-instance path: a forest tile is ~2,500
 * stems and eight hashes each, which is twenty thousand `Math.imul` chains
 * against the same tile's 1.6 MB of GLB parse.
 */
export function stemHash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * Crown archetypes. A species with `crowns: 1` in `STEM_VARIETY` draws only
 * `CROWN_BROAD`, which for it means "the one silhouette `buildSpecies`
 * authored"; only `BUSH_TREE` has more than one, and the reason is in the
 * paragraph on cost below.
 */
export const CROWN_BROAD = 0;
export const CROWN_UPRIGHT = 1;
export const CROWN_SPREAD = 2;
export const CROWN_SPAR = 3;
export const CROWN_COUNT = 4;

/** How often each archetype is drawn, over the species that has all four. */
export const CROWN_SHARE = [0.4, 0.3, 0.25, 0.05] as const;

/**
 * Per-instance variation for one vegetation stem: everything that makes two
 * instances of one geometry read as two plants rather than as one stamped
 * twice.
 *
 * Here rather than in `world/vegetation.ts` for the reason everything in this
 * file is here -- it is arithmetic over the sidecar's own numbers, there is no
 * `three` in it, and that is what lets `verifyStemVariety` run in the server's
 * boot list as well as the browser's. That matters more than tidiness: the
 * dangerous failure in a per-instance variation is not that it looks wrong, it
 * is that it is *unbounded*, and a lean that can reach ninety degrees is a
 * fallen tree. A bound is only a bound if something asserts it, and the only
 * assertion that costs nothing to run is one that needs no GPU.
 *
 * ---------------------------------------------------------------------------
 * WHAT VARIES, IN THE ORDER OF WHAT IT COSTS.
 *
 * The report was a canopy at Chatswood West: near-identical dark octahedral
 * crowns, all about the same size, the same orientation and the same colour, on
 * thin bare trunks. It reads as one tree stamped a thousand times, which is
 * what it was -- nine stems in ten in a bushland stand are `BUSH_TREE`, one
 * fourteen-triangle geometry shared by every instance in the world.
 *
 * The budget essay in `pipeline/sydney/vegetation.py` is not negotiable, so
 * everything below is ordered by what it costs and the free things come first:
 *
 *   yaw       free, and it was **already applied** -- off `seed / 256`, which
 *             is a 256-value cycle over a forest tile's 2,500 stems, so one
 *             stem in ten was the same tree at the same bearing as the one you
 *             were looking at. Hashed with the stem's own position now, which
 *             is where the cycle goes away. An octahedral crown is also nearly
 *             four-fold symmetric about its axis, so yaw alone was never going
 *             to carry this: it is the cheapest variation and the weakest.
 *   aspect    free. `sx = sxz * a` and `sz = sxz / a`, so the plan **area** is
 *             preserved exactly and the pipeline's canopy-cover arithmetic is
 *             untouched -- only the shape moves, and a canopy of ellipses at
 *             random bearings stops reading as a canopy of circles.
 *   lean      free. A tilt off vertical about a hashed bearing, squared so the
 *             stand is mostly upright with a few leaners rather than uniformly
 *             drunk. Applied about the trunk base, so a leaning tree stays in
 *             the ground.
 *   tint      free, and the largest single win available. The foliage material
 *             already multiplies by `instanceColor` when the object has one --
 *             `world/vegetation.ts` says so in the comment on its missing
 *             `colorNode` -- so this is one built-in multiply, no shader graph,
 *             no new pipeline and no new attribute buffer beyond the one that
 *             was already being filled.
 *   crown     **not** free, and it is the only thing here that is not: an
 *             archetype is a second geometry and therefore a second
 *             `InstancedMesh` on any tile that draws it. Triangles per stem do
 *             not move -- see `CROWN_TRIANGLE_RULE` in `verifyVegetationCost` --
 *             but a bushland tile goes from one bush-tree draw to four. Over
 *             the streamer's 25 resident tiles that is +75 instanced draws on a
 *             frame which, by the same header's measurement, carries none of
 *             the CBD's 3,759 parked cars, none of its crowd and none of its
 *             street furniture. It is the cheapest frame in the world and it
 *             can afford three more binds a tile.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TINT IS TWO NUMBERS AND NOT THREE.
 *
 * The variation this replaced was three independent per-channel jitters, and
 * three independent channels is *hue noise*: it moves every instance somewhere
 * random in colour space, which at the amplitude that is visible reads as
 * chromatic aberration rather than as a stand of plants. A real eucalypt stand
 * varies along exactly one line -- grey-blue at one end (glaucous, wax-bloomed,
 * a stressed or a high-country gum), khaki-olive at the other (dusty, sun-hit,
 * end of summer) -- with brightness varying independently of it.
 *
 * So: a **value** term and a **hue** term. The hue term moves red up and blue a
 * long way down toward olive, and the reverse toward blue-grey, and leaves green
 * almost alone -- which is what keeps the whole range inside the palette rule
 * `world/vegetation.ts`'s header states and `verifyVegetationCost` now enforces
 * per instance rather than per species: **green over red and green over blue at
 * both extremes**. It is February and it is still not England at either end of
 * the axis.
 *
 * The same tint multiplies the trunk, which is correct and was correct before:
 * bark varies at least as much as foliage does, and a stem whose canopy went
 * khaki with a grey-blue trunk under it would be two plants.
 */
export interface StemVariation {
  /** Yaw about the vertical, in **turns**: [0, 1). Turns, so the bound is trivial. */
  yawTurns: number;
  /** Tilt off vertical, radians: [0, `LEAN_MAX`]. */
  lean: number;
  /** The bearing the crown leans toward, in turns: [0, 1). */
  leanTurns: number;
  /** Plan aspect: local x is multiplied by this and local z divided by it. */
  aspect: number;
  /** Per-instance colour multiplier, all three in [`TINT_MIN`, `TINT_MAX`]. */
  tintR: number;
  tintG: number;
  tintB: number;
  /** Which crown archetype: 0..`CROWN_COUNT` - 1. */
  crown: number;
}

/** How hard each variation blows on one species. */
export interface StemVarietyRow {
  /** Multiplier on the two tint amplitudes. 0 is one flat colour per species. */
  tint: number;
  /** Peak tilt off vertical, radians. */
  lean: number;
  /** Peak half-amplitude of the area-preserving plan aspect. */
  aspect: number;
  /** How many crown archetypes this species draws. 1 is the authored one. */
  crowns: number;
}

/** The two tint amplitudes at `tint: 1.0`. Value first, then the hue axis. */
const TINT_VALUE = 0.13;
const TINT_HUE_R = 0.085;
const TINT_HUE_G = 0.02;
const TINT_HUE_B = 0.3;

/** Dead wood is paler than living bark, and never blue. */
const SPAR_PALE = 1.1;

/** The bounds every row and every draw is asserted against. */
export const LEAN_MAX = 0.16;
export const ASPECT_MAX = 0.22;
export const TINT_SPREAD_MAX = 1.2;
export const TINT_MIN = 0.55;
export const TINT_MAX = 1.55;

/**
 * Per species, and **every species needs a row** -- the register `NOMINAL` set
 * on 2026-08-24 by shipping two rows short and taking every bushland tile in
 * the world down with `undefined is not iterable`. `verifyStemVariety` reads
 * each row rather than counting the object's keys, because a `Record<number, …>`
 * with a typo'd key counts fine.
 *
 * The spreads are not uniform across the eight and that is the whole content of
 * the table. A row of London planes down George Street genuinely *is* uniform:
 * they are one nursery clone, planted in one season, pruned to a ball by one
 * contractor, and staked straight. A stand of sandstone dry sclerophyll is the
 * opposite of all four. So the street broadleaves keep about half the
 * amplitude, the sclerophyll species get all of it, and the bush tree -- which
 * is nine stems in ten of every stand and the whole subject of the report --
 * gets all of it plus the four crown archetypes.
 */
export const STEM_VARIETY: Record<number, StemVarietyRow> = {
  // Park giants, and there are never many in a frame. A fig leans a little
  // because a fig on a harbour headland does.
  [FIG]: { tint: 0.5, lean: 0.03, aspect: 0.1, crowns: 1 },
  // The most uniform thing that grows in this city, and it should stay that way.
  [PLANE]: { tint: 0.4, lean: 0.015, aspect: 0.07, crowns: 1 },
  [JACARANDA]: { tint: 0.5, lean: 0.035, aspect: 0.12, crowns: 1 },
  // Melaleuca is a swamp tree with a hard glaucous leaf: more colour range than
  // a street broadleaf, and it leans out of a bank.
  [PAPERBARK]: { tint: 0.7, lean: 0.05, aspect: 0.1, crowns: 1 },
  [BRUSH_BOX]: { tint: 0.5, lean: 0.02, aspect: 0.09, crowns: 1 },
  // The full amplitude. A gum stand is the thing the hue axis was drawn for.
  [EUCALYPT]: { tint: 1.0, lean: 0.07, aspect: 0.16, crowns: 1 },
  // A wind-pruned heath shrub is splayed, asymmetric in plan and every colour
  // from grey to olive within one metre. The widest aspect of the eight, and
  // the least lean -- there is not enough of it above ground to lean.
  [SHRUB]: { tint: 1.0, lean: 0.04, aspect: 0.2, crowns: 1 },
  // 0.10 rad is 5.7 degrees at the peak and the square makes the median under
  // two. That is a stand with a few leaners in it, which is what a gully stand
  // is; it is nowhere near the `LEAN_MAX` that would be a fallen tree.
  [BUSH_TREE]: { tint: 1.0, lean: 0.1, aspect: 0.16, crowns: CROWN_COUNT },
};

/**
 * Which crown archetype a stem draws. Split out of `stemVariation` because
 * `buildTileTrees` needs it a whole tile ahead of the rest, to know how many
 * `InstancedMesh`es to make and how big -- and two functions that disagree
 * about it would bucket a stem into one mesh and transform it as another.
 */
export function stemCrown(species: number, seed: number, x: number, z: number): number {
  const row = STEM_VARIETY[species];
  if (!row || row.crowns <= 1) return CROWN_BROAD;
  let total = 0;
  for (let c = 0; c < row.crowns; c++) total += CROWN_SHARE[c];
  let acc = stemHash(seed, Math.round(x * 100) | 0, Math.round(z * 100) | 0, 5) * total;
  for (let c = 0; c < row.crowns; c++) {
    acc -= CROWN_SHARE[c];
    if (acc < 0) return c;
  }
  return row.crowns - 1;
}

/**
 * Everything that varies for one stem, written into `out` rather than returned,
 * because this runs 2,500 times a bushland tile and the module's other hot
 * paths keep their scratch the same way.
 *
 * **Deterministic in the sidecar and in nothing else.** The seed is one byte,
 * which is 256 distinct plants over a tile that holds ten times that, so the
 * stem's own tile-local position joins it -- quantised to the centimetre, so
 * the draw is a pure function of the two float32s the pipeline wrote and not of
 * anything the renderer decided along the way. Nothing here reads the instance
 * index, the tile key or the clock: two clients, and this process, get the same
 * forest.
 */
export function stemVariation(
  species: number,
  seed: number,
  x: number,
  z: number,
  out: StemVariation,
): void {
  const row = STEM_VARIETY[species] ?? STEM_VARIETY[BUSH_TREE];
  const qx = Math.round(x * 100) | 0;
  const qz = Math.round(z * 100) | 0;

  out.yawTurns = stemHash(seed, qx, qz, 1);

  // Squared, so the distribution piles up at vertical: the median lean is a
  // quarter of the peak and three stems in four are under half of it.
  const l = stemHash(seed, qx, qz, 2);
  out.lean = row.lean * l * l;
  out.leanTurns = stemHash(seed, qx, qz, 3);

  out.aspect = 1.0 + (stemHash(seed, qx, qz, 4) - 0.5) * 2.0 * row.aspect;

  const crown = stemCrown(species, seed, x, z);
  out.crown = crown;

  const value = 1.0 + (stemHash(seed, qx, qz, 6) - 0.5) * 2.0 * TINT_VALUE * row.tint;
  const hueAxis = (stemHash(seed, qx, qz, 7) - 0.5) * 2.0 * row.tint;
  // A spar carries no foliage at all, so the foliage axis is the wrong one for
  // it: weathered gum wood is silver-grey, a touch warmer than living bark and
  // never blue. Half the axis, folded to the warm side, and paler overall.
  const spar = crown === CROWN_SPAR;
  const hue = spar ? Math.abs(hueAxis) * 0.5 : hueAxis;
  const v = spar ? value * SPAR_PALE : value;
  out.tintR = v * (1.0 + TINT_HUE_R * hue);
  out.tintG = v * (1.0 - TINT_HUE_G * hue);
  out.tintB = v * (1.0 - TINT_HUE_B * hue);
}

/** A `StemVariation` with every field at its no-variation value. */
export function newStemVariation(): StemVariation {
  return {
    yawTurns: 0,
    lean: 0,
    leanTurns: 0,
    aspect: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    crown: CROWN_BROAD,
  };
}

/**
 * The three-free half of the tree-variety check, and it runs in **both** boot
 * lists -- `client/src/main.ts` and `server/index.ts`. Its sibling
 * `verifyVegetationCost` needs `three` to build a geometry and can only run in
 * the browser, so everything that can be asserted without one is asserted here
 * instead.
 *
 * Four questions, and the second is the one this exists for:
 *
 *   1. every species has a usable row, **read row by row**;
 *   2. every draw is inside its bound, over a sweep -- because an unbounded
 *      lean is a fallen tree and an unbounded aspect is a pancake, and both
 *      would ship looking like a data problem rather than like a code one;
 *   3. the draw is deterministic and is a function of the sidecar only;
 *   4. the 256-value seed cycle that made a forest repeat every tenth stem is
 *      actually gone -- which is a regression test with a screenshot behind it.
 */
export function verifyStemVariety(): string[] {
  const out: string[] = [];

  for (let s = 0; s < SPECIES_COUNT; s++) {
    const row = STEM_VARIETY[s];
    if (!row) {
      out.push(`STEM_VARIETY has no row for species ${s}`);
      continue;
    }
    if (!(row.tint >= 0) || row.tint > TINT_SPREAD_MAX) {
      out.push(`STEM_VARIETY[${s}].tint is ${row.tint}, outside [0, ${TINT_SPREAD_MAX}]`);
    }
    if (!(row.lean >= 0) || row.lean > LEAN_MAX) {
      out.push(
        `STEM_VARIETY[${s}].lean is ${row.lean} rad, outside [0, ${LEAN_MAX}] -- ` +
          'a stem that leans further than this is a fallen tree, not a plant',
      );
    }
    if (!(row.aspect >= 0) || row.aspect > ASPECT_MAX) {
      out.push(`STEM_VARIETY[${s}].aspect is ${row.aspect}, outside [0, ${ASPECT_MAX}]`);
    }
    if (!Number.isInteger(row.crowns) || row.crowns < 1 || row.crowns > CROWN_COUNT) {
      out.push(`STEM_VARIETY[${s}].crowns is ${row.crowns}, outside 1..${CROWN_COUNT}`);
    }
  }

  if (CROWN_SHARE.length !== CROWN_COUNT) {
    out.push(`CROWN_SHARE has ${CROWN_SHARE.length} rows against CROWN_COUNT ${CROWN_COUNT}`);
  }
  const shareSum = CROWN_SHARE.reduce((a, b) => a + b, 0);
  if (Math.abs(shareSum - 1) > 1e-9 || CROWN_SHARE.some((w) => !(w > 0))) {
    out.push(`CROWN_SHARE sums to ${shareSum} and must sum to 1 with every share positive`);
  }

  // The sweep. 8 seeds x 8 eastings x 8 northings a species is 512 draws, and
  // the whole thing is 4,096 -- under a millisecond, and it is the only way the
  // bounds above become facts about the output rather than about the table.
  const v = newStemVariation();
  const seen: number[] = new Array(CROWN_COUNT).fill(0);
  let bushDraws = 0;
  for (let s = 0; s < SPECIES_COUNT; s++) {
    const row = STEM_VARIETY[s];
    if (!row) continue;
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        for (let c = 0; c < 8; c++) {
          const seed = a * 31 + 7;
          const x = b * 61.3 - 240.0;
          const z = c * 57.9 - 210.0;
          stemVariation(s, seed, x, z, v);
          if (!(v.yawTurns >= 0 && v.yawTurns < 1)) {
            out.push(`species ${s} drew a yaw of ${v.yawTurns} turns, outside [0, 1)`);
          }
          if (!(v.leanTurns >= 0 && v.leanTurns < 1)) {
            out.push(`species ${s} drew a lean bearing of ${v.leanTurns} turns, outside [0, 1)`);
          }
          if (!(v.lean >= 0 && v.lean <= row.lean + 1e-12)) {
            out.push(`species ${s} drew a lean of ${v.lean} rad against a row peak of ${row.lean}`);
          }
          if (v.lean > LEAN_MAX) {
            out.push(`species ${s} drew a lean of ${v.lean} rad, past LEAN_MAX ${LEAN_MAX}`);
          }
          if (!(v.aspect >= 1 - ASPECT_MAX && v.aspect <= 1 + ASPECT_MAX) || !(v.aspect > 0)) {
            out.push(`species ${s} drew a plan aspect of ${v.aspect}, outside the bound`);
          }
          for (const [name, t] of [['red', v.tintR], ['green', v.tintG], ['blue', v.tintB]] as const) {
            if (!(t >= TINT_MIN && t <= TINT_MAX)) {
              out.push(`species ${s} drew a ${name} tint of ${t}, outside [${TINT_MIN}, ${TINT_MAX}]`);
            }
          }
          if (!Number.isInteger(v.crown) || v.crown < 0 || v.crown >= row.crowns) {
            out.push(`species ${s} drew crown ${v.crown} against a row of ${row.crowns}`);
          }
          if (v.crown !== stemCrown(s, seed, x, z)) {
            out.push(`species ${s} bucketed as crown ${stemCrown(s, seed, x, z)} and drew as ${v.crown}`);
          }
          if (s === BUSH_TREE) {
            seen[v.crown]++;
            bushDraws++;
          }
        }
      }
    }
  }

  // Every archetype authored has to be one the world actually draws, and near
  // the share it was given -- an archetype at 0.4% is a geometry compiled, a
  // pipeline warmed and a draw call spent on something nobody sees.
  for (let c = 0; c < CROWN_COUNT; c++) {
    const share = seen[c] / Math.max(bushDraws, 1);
    if (share < CROWN_SHARE[c] * 0.5 || share > CROWN_SHARE[c] * 1.6) {
      out.push(
        `crown archetype ${c} came out at ${(share * 100).toFixed(1)}% of bush stems ` +
          `against a designed ${(CROWN_SHARE[c] * 100).toFixed(0)}%`,
      );
    }
  }

  // Determinism, and it is worth asserting rather than assuming: the whole
  // draw reads the sidecar and the sidecar only, so the same stem is the same
  // plant on every client and on this process.
  const p = newStemVariation();
  const q = newStemVariation();
  stemVariation(BUSH_TREE, 137, 211.37, -88.02, p);
  stemVariation(BUSH_TREE, 137, 211.37, -88.02, q);
  for (const k of Object.keys(p) as Array<keyof StemVariation>) {
    if (p[k] !== q[k]) out.push(`stemVariation is not deterministic: ${k} came out ${p[k]} then ${q[k]}`);
  }

  // The regression the report was actually about. With the seed alone there
  // were 256 distinct trees in a world of forty million, so every tenth stem
  // on a tile was its neighbour's twin at its neighbour's bearing. Sixty-four
  // stems of one seed along one row must now be sixty-four different plants.
  {
    const yaws = new Set<number>();
    for (let i = 0; i < 64; i++) {
      stemVariation(BUSH_TREE, 42, i * 3.5, 17.25, p);
      yaws.add(p.yawTurns);
    }
    if (yaws.size < 60) {
      out.push(
        `64 bush stems of one seed drew only ${yaws.size} distinct yaws -- the seed cycle is back`,
      );
    }
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
