/**
 * The far layer: the city that runs to the horizon.
 *
 * Everything in `streamer.ts` exists inside 1,800 m. Past that the pipeline's
 * output simply stopped, and two things followed from it that had nothing to do
 * with each other except the cause. From a street in Alexandria the CBD tower
 * cluster -- 4 km away, 263 m tall, and the single most recognisable object in
 * Sydney -- was **not drawn at all**. And the fabric ended in a hard edge:
 * buildings popped in at the streaming radius with bare ground beyond it, so the
 * world read as a disc of city on an empty plain rather than as a city.
 *
 * This is one system for both. Two files, loaded once beside `index.json` and
 * never evicted:
 *
 *   world/far.bin           every building over 10 m or 400 m2, as one convex
 *                           prism: 12,778 of the inner ring's 33,651, 759 kB
 *   world/far-terrain.bin   the whole extent's ground as one coarse heightfield,
 *                           145 x 145 posts at 62.5 m, 84 kB
 *
 * ---------------------------------------------------------------------------
 * When a slab is on screen, which is the whole of the visibility rule.
 *
 * **A slab draws exactly when the tile it belongs to is not resident in the
 * streamer.** One line, no distance of its own, no fade, no hysteresis. The
 * pipeline ships `far.bin` already partitioned by tile key, this file builds one
 * mesh per tile, and `TileStreamer` hides that mesh the instant the tile's GLB
 * joins the scene and shows it again the instant the tile is evicted. The real
 * building and its stand-in are therefore never both drawn and never both
 * absent, because the same event switches them.
 *
 * This file used to say -- at length -- that no visibility management was needed
 * at all, and the argument was that every slab was 3% smaller in plan than its
 * building and so hid inside the real walls. Two things were wrong with it.
 *
 *   - The slab was the footprint's minimum rotated *rectangle*, and a footprint
 *     does not fill its own rectangle. The Oxford Hotel in Darlinghurst is
 *     perfectly convex and fills 72% of its box; the rest of that box stood
 *     across Oxford Street as a flat unlit wall you could walk through. Over a
 *     40-tile sample the rectangles put 2.79% of the city's asphalt under a
 *     slab. The plan is now the footprint's **convex hull**, inset 0.4 m -- on a
 *     convex footprint that is the building's own outline, so the case above goes
 *     to zero by construction. The same sample now reads 1.06%, and two thirds of
 *     what is left is a slab standing where a *real* collision prism is also
 *     standing, which is a footprint defect and not this file's.
 *
 *   - Even where the plan was honest, "the depth buffer sorts it out" is not
 *     something a depth buffer can promise at a kilometre. `createSlabMaterial`
 *     carries that arithmetic. Its bias is still here and still earns its place,
 *     but it is now the backstop for the few frames between a tile being wanted
 *     and its GLB landing, rather than the mechanism.
 *
 * The load gap is deliberately left showing rather than culled away. A tile
 * takes a moment to fetch, and during it the slab is the only thing standing
 * where that building is -- which is the correct picture, now that the slab is
 * inside the footprint. Hiding slabs on a radius instead would open a band where
 * neither representation draws, and a hole in the skyline is worse than a
 * low-detail building in it.
 *
 * ---------------------------------------------------------------------------
 * What this is not, and what spec 3.2 eventually wants.
 *
 * The spec's 2,000 m+ band is an "impostor / merged block silhouette". A prism
 * per building is the honest first cut at that and nothing more: no per-building
 * texture, no block merging, no crossfade with the streamed tiles. A merged
 * silhouette would draw a Sydney block as one mass with one roofline, which is
 * cheaper and *better*, and it is a pipeline pass rather than a client one.
 * 187,981 triangles across 192 per-tile meshes buys the horizon today -- more
 * triangles than the boxes' 127,780 and fewer vertices than their 255,560, and
 * unlike the boxes they are frustum-culled per tile instead of submitted whole.
 */

import {
  Fn,
  attribute,
  float,
  mix,
  smoothstep,
  vec3,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type MeshStandardNodeMaterial,
} from 'three/webgpu';

import { fetchWorldAsset } from './cdn.ts';
import { MATERIALS } from './facade.ts';

/**
 * `far.bin`'s magic and the format this file can read. Both from
 * `tiles.FAR_MAGIC` / `tiles.FAR_VERSION`, and both are checked rather than
 * assumed: version 1 was the oriented box, seven floats at a fixed 32-byte
 * stride, and it is a *plausible* read as a version 2 file -- the count in its
 * first word would be taken as a magic, and everything after that would be
 * garbage geometry rather than an error. So a mismatch means no far layer, which
 * is the same answer this file gives for a 404.
 */
const FAR_MAGIC = 0x53524146; // "FARS", little-endian
const FAR_VERSION = 2;

/** Header, group record and slab record sizes. See `tiles.write_far`. */
const FAR_HEADER = 20;
const FAR_GROUP_STRIDE = 16;
const FAR_SLAB_STRIDE = 16;

/**
 * The far layer's contract, from `index.json`.
 *
 * Optional as a whole and with **no defaults**, unlike `TerrainContract`: an
 * index written before this pass describes no far layer, and there is nothing
 * sensible to stand in for a city on the horizon. Absent means the old flat far
 * plane, which `main.ts` falls back to.
 */
export interface FarContract {
  /** Slabs in `far.bin`. */
  count: number;
  /** `far.bin`'s format version. Absent on a world built before the hull plan. */
  version?: number;
  bytes: number;
  /** Plan vertices across the whole file, and the tile groups they are filed in. */
  plan_verts?: number;
  groups?: number;
  triangles?: number;
  vertices?: number;
  min_height_m: number;
  min_area_m2: number;
  /** Ceiling on a slab's plan vertices. See `tiles.FAR_MAX_PLAN_VERTS`. */
  max_plan_verts?: number;
  /** The z-fight inset, metres off every wall. See `tiles.FAR_INSET`. */
  inset_m?: number;
  /** Floor on the concavity-matching shrink. See `tiles.FAR_AREA_MATCH_FLOOR`. */
  concavity_floor: number;
  terrain: {
    /** Posts per edge of `far-terrain.bin`; the grid is square. */
    posts: number;
    post_m: number;
    /** The grid spans +/- this in world x and z, metres. */
    half_extent_m: number;
    /**
     * How far the coarse ground is pushed under the real one, metres.
     *
     * **Measured per build**, not chosen here -- see `tiles.build_far_terrain`.
     * It is the worst amount by which the coarse surface stands above the fine
     * one anywhere in the extent, plus half a metre, so a streamed tile's
     * ground always wins the depth test where the two overlap. At the 4 km
     * stage with 62.5 m posts that comes out at 2.96 m.
     */
    sink_m: number;
    bytes: number;
  };
}

/* ---------------------------------------------------------------------------
 * The tints.
 *
 * A slab is one flat colour standing in for a whole building, drawn **unlit**,
 * so its colour has to *be* the lit result rather than an albedo the renderer
 * will shade. Every value below was produced by running the chain documented at
 * the top of `sky/calibration.ts` -- irradiance, Lambert, exposure 0.62, Khronos
 * PBR Neutral, sRGB encode -- offline at the reference instant of 3 pm on 15
 * February, and the method is *checked* rather than asserted: with `facade.ts`'s
 * 0.87 eye-level joint/soiling modulation applied to the same `MATERIAL_LOOK`
 * albedos, it reproduces that file's published sunlit and shaded figures for
 * brick_red, brick_cream, sandstone, concrete_precast, render_painted and fibro
 * **exactly, to the code value, on all six**.
 *
 * Two choices went into turning a two-tone building into one number.
 *
 *   - **Half the visible facade is sunlit.** At 3 pm the sun is in the
 *     north-west, so of a box's four sides two are lit; a viewer sees two
 *     adjacent sides, and averaged over all approach bearings that is one lit
 *     and one shaded. A little roof goes in as well (12%), because a tower two
 *     kilometres off is seen from slightly below its own top.
 *
 *   - **The level is matched in DISPLAY space, not in linear.** This is the
 *     part that is not obvious. Neutral compresses hard above 0.76, so the
 *     linear average of a sunlit and a shaded wall tone maps *brighter* than the
 *     average of what those two walls display as, and the gap widens with the
 *     albedo: red brick 89 against 77, painted render **235 against 200**. A
 *     slab is judged as a mass, so each tint carries a gain (0.68-0.84, mean
 *     0.77) that puts it at the mean display luminance of the building it
 *     replaces. Without it the far city reads a stop bright and dissolves into
 *     the fog it is supposed to be standing in front of.
 *
 * Indices are `facade.MATERIALS` order, which is `mesh.MATERIALS` in the
 * pipeline. The six ground and trim slots at the end are never a building's wall
 * material and are filled with the concrete row so an out-of-range byte cannot
 * index off the end.
 * ------------------------------------------------------------------------- */

type Rgb = [number, number, number];

const FAR_TINT: readonly Rgb[] = [
  [0.4172, 0.1493, 0.1073], // brick_red         rgb(129,  66,  46) Y'  78
  [0.8236, 0.7008, 0.5152], // brick_cream       rgb(183, 169, 144) Y' 170
  [0.4162, 0.2810, 0.2042], // brick_brown       rgb(129, 102,  83) Y' 106
  [0.8408, 0.6512, 0.3867], // sandstone         rgb(184, 162, 123) Y' 164
  [0.5210, 0.5109, 0.4965], // concrete_precast  rgb(145, 144, 141) Y' 144
  [0.1193, 0.1985, 0.2132], // curtain_wall      rgb( 52,  81,  86) Y'  75
  [0.4585, 0.4777, 0.4916], // corrugated_steel  rgb(136, 138, 141) Y' 138
  [1.0176, 1.0013, 0.9396], // render_painted    rgb(202, 201, 194) Y' 201
  [0.8223, 0.8329, 0.8195], // fibro             rgb(182, 183, 182) Y' 183
  [0.3408, 0.1308, 0.0916], // roof_terracotta   rgb(116,  59,  39) Y'  70
  [0.3246, 0.3436, 0.3503], // roof_steel        rgb(112, 115, 117) Y' 115
  [0.5210, 0.5109, 0.4965], // road_asphalt      -- never a wall; concrete stands in
  [0.5210, 0.5109, 0.4965], // footpath_concrete
  [0.5210, 0.5109, 0.4965], // kerb_sandstone
  [0.5210, 0.5109, 0.4965], // park_grass
  [0.5210, 0.5109, 0.4965], // contact_ao
  [0.5210, 0.5109, 0.4965], // awning_fascia
  [0.5210, 0.5109, 0.4965], // fence_masonry    -- never a wall; concrete stands in
  [0.5210, 0.5109, 0.4965], // fence_iron
  [0.5210, 0.5109, 0.4965], // fence_timber
];

/**
 * The one place the tint table can be checked against the slot list, and it
 * costs an import-time comparison -- the same guard, for the same reason, that
 * `mesh.py` runs over `attributes.MATERIAL_MIX`.
 *
 * A slot appended to `MATERIALS` without a row here does not fail anywhere: the
 * decoder clamps the material byte to the table's length, so every building of
 * the new material would silently be painted whatever the last row happens to
 * be. This says so instead.
 */
if (FAR_TINT.length !== MATERIALS.length) {
  throw new Error(
    `FAR_TINT has ${FAR_TINT.length} rows against ${MATERIALS.length} material slots. ` +
      `Append a row for every new slot in facade.MATERIALS -- the order is the pipeline's.`,
  );
}

/** `curtain_wall`'s slot index, found by name rather than written down. */
const GLASS_SLOT = MATERIALS.indexOf('curtain_wall');

/**
 * `scene.fog`'s 0xd8e8fa as linear radiance. What the haze lift below mixes
 * toward, so a hazed slab and the fog in front of it are the same colour by
 * construction rather than by eye. It displays as rgb(167, 181, 196).
 */
const FOG_LINEAR: Rgb = [0.6867, 0.807, 0.956];

/**
 * The haze lift: how far a tall slab goes toward the fog colour, and over what
 * height it gets there.
 *
 * **Graded, and named as graded.** The range fog is measured to the fragment, so
 * it cannot tell the top of a tower from its base -- the two are the same
 * distance away -- yet a real 200 m tower is visibly paler than the 20 m fabric
 * at its feet, partly through more air and mostly because a dark mass seen
 * against a bright sky reads lighter. A slab has no sky behind it in the shader
 * and no way to know, so this stands in for both. 0.16 at 200 m takes a
 * curtain-wall tower from rgb(52, 81, 86) to rgb(88, 111, 118): still clearly a
 * dark glass tower, and no longer a black cut-out on the horizon.
 */
const HAZE_START_M = 40;
const HAZE_FULL_M = 200;
const HAZE_MAX = 0.16;

/**
 * The cool shift on glass, as a near-luminance-preserving multiplier
 * (0.2126*0.93 + 0.7152*0.99 + 0.0722*1.10 = 0.985, so this changes hue and
 * almost nothing else).
 *
 * It goes on `curtain_wall` *and* on everything classed `tower`, because at
 * range the two are the same read: a glass tower's colour is the sky it mirrors,
 * and the CBD cluster is the one place in this world where that is what decides
 * the silhouette. The near renderer gets this for free -- `facade.ts` reflects
 * the actual Preetham dome off the glazing -- and this is the cheapest possible
 * echo of it on a material that has no normal and no view vector.
 */
const GLASS_COOL: Rgb = [0.93, 0.99, 1.1];

/**
 * Per-slab value jitter, either side of the tint.
 *
 * The same argument as `facade.ts`'s `TINT_SPREAD`, and for the same reason it
 * is needed more here: the far layer has no window grid, no mortar and no paint
 * palette, so without this every render_painted slab in the extent is one
 * identical rectangle of one identical colour and a suburb at 3 km reads as a
 * single flat wash. +/-9% is narrower than the near city's +/-10 to 18 because
 * it is doing less work -- it only has to break the repeat.
 */
const JITTER = 0.09;

/**
 * The vertical gradient: what the base of a slab is multiplied by, and how far
 * up it takes to reach full.
 *
 * Fake AO, and it is the only thing keeping a slab from reading as a flat card.
 * A real building at range is darker at street level -- it stands in a canyon
 * that occludes half its sky -- and this is that, for nothing: one smoothstep on
 * an attribute the vertex already has.
 *
 * The ramp is in *normalised* height rather than metres, so a 260 m tower's
 * bottom 73 m is shaded where a 12 m terrace's bottom 3.4 m is. That is wrong in
 * principle -- occlusion depth is set by the neighbours, not by the building --
 * and it is invisible in practice, because the slab it is drawn on is 2 km away
 * and the whole effect is 20 code values from bottom to top. Reading absolute
 * metres would need the prism's height as a second vertex attribute for a
 * gradient nobody can measure.
 *
 * `SLAB_Y` is the attribute that carries it. A prism is world-space geometry
 * rather than a scaled unit box, so `positionGeometry.y` is now an AHD elevation
 * and says nothing about how far up a wall a fragment is: 0 at the bottom ring
 * and 1 at the top ring, interpolated by the rasteriser, is what replaces it.
 * One float a vertex, and it is what keeps the walls at two triangles each --
 * baking the ramp into the vertex colours instead would need a third ring of
 * vertices at 0.28 to reproduce the same curve.
 */
const BASE_SHADE = 0.8;
const BASE_SHADE_TOP = 0.28;
const SLAB_Y = 'slabY';

/** The far ground's outer apron reaches this far from the origin, metres. */
const APRON_HALF = 20000;

// --- Decode -------------------------------------------------------------------

/** One tile's run of slabs, which is also the unit visibility is decided in. */
export interface FarGroup {
  /** The streamer's tile key, `"tx_tz"`. */
  key: string;
  first: number;
  count: number;
}

export interface FarSlabs {
  count: number;
  /** The tile runs, in file order; `first` walks the slab arrays below. */
  groups: FarGroup[];
  /** World y of the prism's bottom. */
  baseY: Float32Array;
  /** The prism's own height, which is the building's plus its burial. */
  height: Float32Array;
  /** Where this slab's plan starts in `plan`, in vertices. */
  firstVert: Uint32Array;
  /** How many plan vertices it has: 3 to `tiles.FAR_MAX_PLAN_VERTS`. */
  vertCount: Uint8Array;
  material: Uint8Array;
  archetype: Uint8Array;
  /**
   * Every slab's plan ring, interleaved x, z in **world** metres -- x = east,
   * z = -north, the pipeline ships world and not ENU. Wound clockwise in (x, z),
   * which is what makes the extrusion in `buildFarSlabs` come out facing
   * outward with no sign to remember. See `tiles.write_far`.
   */
  plan: Float32Array;
}

/**
 * Decode a `far.bin`. Returns `null` for anything that is not one.
 *
 * Never throws and never fails the world: a missing, truncated, malformed or
 * *older-format* file means a world with no far layer, which is exactly what the
 * client did before this pass and still has to be able to do. The magic and the
 * version are checked first and for that reason -- a version 1 file is not
 * corrupt, it is a different thing, and reading it as this one would produce a
 * city rather than an error.
 */
export function decodeFar(buffer: ArrayBuffer): FarSlabs | null {
  if (buffer.byteLength < FAR_HEADER) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== FAR_MAGIC) return null;
  if (view.getUint32(4, true) !== FAR_VERSION) return null;
  const count = view.getUint32(8, true);
  const planVerts = view.getUint32(12, true);
  const groupCount = view.getUint32(16, true);
  if (count === 0 || planVerts === 0 || groupCount === 0) return null;

  const groupAt = FAR_HEADER;
  const slabAt = groupAt + groupCount * FAR_GROUP_STRIDE;
  const vertAt = slabAt + count * FAR_SLAB_STRIDE;
  if (buffer.byteLength < vertAt + planVerts * 8) return null;

  const groups: FarGroup[] = [];
  for (let g = 0; g < groupCount; g++) {
    const o = groupAt + g * FAR_GROUP_STRIDE;
    groups.push({
      key: `${view.getInt32(o, true)}_${view.getInt32(o + 4, true)}`,
      first: view.getUint32(o + 8, true),
      count: view.getUint32(o + 12, true),
    });
  }

  const out: FarSlabs = {
    count,
    groups,
    baseY: new Float32Array(count),
    height: new Float32Array(count),
    firstVert: new Uint32Array(count),
    vertCount: new Uint8Array(count),
    material: new Uint8Array(count),
    archetype: new Uint8Array(count),
    // A view rather than a copy: the block is 4-byte aligned by construction
    // (the header and both record strides are multiples of four) and this is
    // 570 kB that would otherwise be walked a float at a time.
    plan: new Float32Array(buffer, vertAt, planVerts * 2),
  };
  for (let i = 0; i < count; i++) {
    const o = slabAt + i * FAR_SLAB_STRIDE;
    out.baseY[i] = view.getFloat32(o, true);
    out.height[i] = view.getFloat32(o + 4, true);
    out.firstVert[i] = view.getUint32(o + 8, true);
    out.vertCount[i] = view.getUint8(o + 12);
    // Clamped rather than trusted: an out-of-range material would index off the
    // end of the tint table and paint that slab `undefined`.
    out.material[i] = Math.min(view.getUint8(o + 13), FAR_TINT.length - 1);
    out.archetype[i] = view.getUint8(o + 14);
  }
  return out;
}

// --- The slabs ----------------------------------------------------------------

/** Deterministic hash, for the per-slab value jitter. Author-time only. */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * The material every slab wears. One for the whole world, one pipeline compile
 * -- 192 meshes share it, and sharing it is what keeps that true.
 *
 * `MeshBasicNodeMaterial` because at the ranges this is *seen* at everything
 * arrives through fog anyway, and because an unlit material is the only one
 * whose output can be a measured display value rather than an albedo waiting for
 * a light. It also keeps the far city out of the lighting cost entirely: no N.L,
 * no hemisphere, no bounce, no shadow lookup.
 */
function createSlabMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.name = 'far-city';

  // `colorNode` is the base and the `color` attribute multiplies *into* it --
  // see `NodeMaterial.setupDiffuseColor` -- so the gradient goes here and the
  // tint comes per vertex. Splitting them this way is what keeps a tile's whole
  // run of buildings in one draw with one material.
  //
  // The ramp reads `SLAB_Y` rather than `positionGeometry.y`, and that swap is
  // forced by the geometry: these prisms are built in world space, so a
  // fragment's y is an AHD elevation and knows nothing about how far up its own
  // wall it is. See `SLAB_Y`.
  material.colorNode = Fn(() => {
    const shade = mix(
      float(BASE_SHADE),
      float(1.0),
      smoothstep(float(0.0), float(BASE_SHADE_TOP), attribute<'float'>(SLAB_Y, 'float')),
    );
    return vec3(shade, shade, shade);
  })();
  material.vertexColors = true;

  // Push every slab back in depth. This used to be the mechanism that made "the
  // streamed tiles occlude their own slabs" true; it is now the backstop behind
  // a mechanism, which is `FarCity.setTileResident` hiding a tile's slabs
  // outright the moment its GLB lands. What is left for the bias to cover is the
  // handful of frames between a tile being wanted and it arriving, and any tile
  // that fails to load at all -- both of which put a slab and a real wall in the
  // same view with nothing else deciding between them.
  //
  // The inset is 0.4 m per face. That is a *metric* margin and the depth
  // buffer's resolution is not: with a 0.1 m near plane and a 24 bit depth
  // attachment the smallest separation it can hold is about d^2 / (near * 2^24)
  // -- 9.5 cm at 400 m, 38 cm at 800 m, 1.9 m at the 1,800 m streaming radius.
  // So past about 800 m the slab face and the real wall it is hiding behind
  // occupy the same depth value, the `LessEqual` compare hands the pixel to
  // whichever drew last, and the winner changes both per pixel as the camera
  // moves and wholesale as the render list re-sorts. What that looks like is the
  // mid-distance city flashing between real facades and flat untextured blocks,
  // which is the "weird and flickery" this fixes.
  //
  // A bias is the right shape of fix for the same reason `ground.ts` gives: the
  // problem grows as d^2 and so does a constant bias in depth-format units. It
  // is also *free of side effects here* in a way it would not be elsewhere --
  // every slab takes the identical offset, so the far city's own front-to-back
  // ordering is untouched, and against everything else in the world the slab is
  // the representation that should lose. Four units is the same figure the
  // ground uses and is four times what breaking the tie strictly needs; the only
  // thing it can cost is the far ground eating the bottom of a slab it stands
  // on, which at 4 km is 38 m of ground seen 0.0002 degrees from edge-on -- far
  // under a pixel. No slope term: these faces are vertical and near enough
  // edge-on from a street that a slope-scaled bias would swing wildly.
  material.polygonOffset = true;
  material.polygonOffsetUnits = 4;
  material.polygonOffsetFactor = 0;

  // Forced on rather than left to the default, and this is the line the whole
  // feature would fail silently without. `scene.fog` is the aerial perspective:
  // 7% at the 1.8 km streaming radius, closing by 9 km, and it is *the* thing
  // that makes a slab at 4 km read as distance rather than as a grey box. The
  // sky dome in `sky.ts` deliberately sets `fog = false` -- a dome at 22 km
  // would otherwise render as a flat wash of the fog colour -- and the far layer
  // must not inherit that reasoning by imitation. `NodeMaterial` already
  // defaults this to true; it is written out so that nobody copying the sky's
  // line into here can do it without reading this paragraph.
  material.fog = true;
  return material;
}

/**
 * The far city: one mesh per tile, and the switch that hides one.
 *
 * A `Group` rather than the single `InstancedMesh` this used to be, and the
 * partition is not a cosmetic reorganisation -- it is what makes the visibility
 * rule at the top of this file expressible at all. Residency is decided per tile
 * by `TileStreamer`, so "hide the slabs whose building has arrived" is only one
 * assignment if the slabs are already grouped the way residency is. The pipeline
 * ships that grouping in the file for the same reason.
 *
 * Two things come free with it, both of which the single mesh could not have.
 * Frustum culling starts working: an `InstancedMesh` takes its bounding sphere
 * over every instance, so the far city's sphere was the entire extent and the
 * test could never reject it -- all 127,780 triangles were submitted from every
 * position and every bearing in the world. A per-tile mesh is a 500 m box and is
 * rejected on its own merits, which is most of them from any one view. And the
 * indices fit in 16 bits, because no tile carries 65,536 vertices.
 *
 * The cost is draw calls: about 45 in a street-level view once the near tiles
 * have hidden their own, against one. That is a good trade against a streamed
 * tile's own ten-odd slots times the fifty tiles inside the radius.
 */
export class FarCity extends Group {
  /**
   * Slabs and triangles resident. Reported by the debug overlay.
   *
   * **Accumulators rather than constants since the world was cut into hexes.**
   * A segmented world builds this empty and merges one hexagon's slabs into it
   * each time the player comes within `far_cut_m` of one, and drops them again
   * when they leave -- see `FarHexes`. On an unsegmented world exactly one
   * `buildFarSlabs` call ever runs and these are what they always were.
   */
  private slabCount = 0;
  private triangleCount = 0;
  /** Tile key -> its mesh. The map is the whole of the residency state. */
  private readonly byTile = new Map<string, Mesh>();
  /**
   * Which tiles the streamer currently has geometry for.
   *
   * Remembered rather than only acted on, and that is what makes a late-arriving
   * hexagon safe: `setTileResident` used to be an event with nowhere to record
   * itself, so a mesh added *after* its tile had already loaded would draw a
   * flat unlit box in front of a real facade until the tile was evicted. Now
   * `addTile` reads this set and starts the mesh in the right state.
   */
  private readonly residentTiles = new Set<string>();

  constructor(count = 0, triangles = 0) {
    super();
    this.name = 'far-city';
    this.slabCount = count;
    this.triangleCount = triangles;
  }

  get count(): number {
    return this.slabCount;
  }

  get triangles(): number {
    return this.triangleCount;
  }

  /** @internal Used by `buildFarSlabs`, which is the only thing that fills one. */
  addTile(key: string, mesh: Mesh): void {
    const existing = this.byTile.get(key);
    if (existing) this.dropMesh(key, existing);
    mesh.visible = !this.residentTiles.has(key);
    this.byTile.set(key, mesh);
    this.add(mesh);
  }

  /** @internal `buildFarSlabs`, adding one hexagon's worth to what is here. */
  addCounts(slabs: number, triangles: number): void {
    this.slabCount += slabs;
    this.triangleCount += triangles;
  }

  /** Which tile keys have a mesh, so a hex can take back exactly its own. */
  tileKeys(): string[] {
    return [...this.byTile.keys()];
  }

  /**
   * Drop a set of tiles' slabs and release their buffers.
   *
   * The GPU side of `far_cut_m`: a hexagon 25 km away contributes nothing a
   * camera can resolve and holds ~1 MB of vertex data for the session. The
   * geometry is disposed rather than merely detached, because `Group.remove`
   * leaves the buffers alive on the device and the whole point of the cut is
   * the memory. The material is **not** disposed -- it is shared by every slab
   * in the world and disposing it would take the far city down.
   */
  removeTiles(keys: Iterable<string>): void {
    for (const key of keys) {
      const mesh = this.byTile.get(key);
      if (mesh) this.dropMesh(key, mesh);
    }
  }

  /**
   * The counts come off `mesh.userData`, written by `buildFarSlabs` when the
   * mesh was made. Recomputing them from the geometry would work for the
   * triangles and not for the slabs -- a prism's triangle count depends on its
   * plan vertices, so the two are not derivable from one another.
   */
  private dropMesh(key: string, mesh: Mesh): void {
    this.remove(mesh);
    const held = mesh.userData as { farSlabs?: number; farTriangles?: number };
    this.slabCount = Math.max(0, this.slabCount - (held.farSlabs ?? 0));
    this.triangleCount = Math.max(0, this.triangleCount - (held.farTriangles ?? 0));
    mesh.geometry.dispose();
    this.byTile.delete(key);
  }

  /**
   * The visibility rule, in one line: a tile's slabs draw when the tile does
   * not.
   *
   * Called by `TileStreamer` on both edges -- once when a tile's GLB has been
   * added to the scene, once when it is evicted -- so there is no per-frame
   * query and no window in which both or neither is showing. A key with no slabs
   * (29 of the inner ring's 221 tiles have no building over 10 m or 400 m2) is
   * silently nothing to do.
   */
  setTileResident(key: string, resident: boolean): void {
    if (resident) this.residentTiles.add(key);
    else this.residentTiles.delete(key);
    const mesh = this.byTile.get(key);
    if (mesh) mesh.visible = !resident;
  }

  /**
   * Turn frustum culling off across every tile, for the warmup compile.
   *
   * `Renderer.compileAsync` walks the scene through the same per-object frustum
   * test `render` uses, so a culled mesh compiles nothing -- and setting the flag
   * on this group would do nothing at all, because culling is decided per mesh.
   * `main.ts` clears it, compiles, and puts it back.
   */
  setFrustumCulled(flag: boolean): void {
    for (const mesh of this.byTile.values()) mesh.frustumCulled = flag;
  }
}

/**
 * Build the far city from a decoded `far.bin`.
 *
 * Each slab becomes a prism: `n` wall quads and a cap fanned off the top ring,
 * `2n` vertices and `3n - 2` triangles, with the bottom face left off. The floor
 * is left off because it can only be seen from under the ground -- the pipeline
 * puts a slab's base two metres under whichever of the two ground surfaces is
 * lower specifically so that the one face this geometry does not have is the one
 * face nothing can look at.
 *
 * **The winding is inherited, not computed.** `tiles.write_far` ships each plan
 * ring clockwise in world (x, z), and with that in hand the wall quad
 * `b[i], b[j], t[j], t[i]` and the cap fan `t[0], t[i], t[i+1]` both come out
 * facing outward under three's default counter-clockwise front face. There is no
 * sign to choose here and no orientation test to run: if the pipeline's ring is
 * right the extrusion is right, and if it is wrong the city renders inside out,
 * which is not a subtle failure.
 *
 * No normals are written. The material is unlit and reads none, and a normal
 * buffer for this many vertices is 1.7 MB of upload that nothing samples. That
 * is a real difference from the box geometry this replaces, which carried them
 * because 20 vertices for the whole city made correctness free.
 */
export function buildFarSlabs(
  data: FarSlabs,
  towerArchetype: number,
  /**
   * An existing city to merge into, and the material it is already using.
   *
   * A segmented world calls this once per hexagon as the player approaches it,
   * and every one of those calls has to produce meshes the renderer treats as
   * the *same* draw as the ones already there -- which means the same material
   * instance, because a copy of a material has a different pipeline cache key
   * and would compile a fresh shader on the frame it is first drawn.
   * `TileStreamer`'s warm-up list makes exactly this argument about the tile
   * materials. Passing the pair together rather than reaching for the group's
   * first child makes it impossible to pass one without the other.
   */
  into?: { city: FarCity; material: MeshBasicNodeMaterial },
): FarCity {
  const material = into?.material ?? createSlabMaterial();
  const city = into?.city ?? new FarCity();
  city.addCounts(data.count, 3 * (data.plan.length / 2) - 2 * data.count);

  for (const group of data.groups) {
    let verts = 0;
    for (let i = group.first; i < group.first + group.count; i++) verts += 2 * data.vertCount[i];
    if (verts === 0) continue;

    const position = new Float32Array(verts * 3);
    const colour = new Float32Array(verts * 3);
    const slabY = new Float32Array(verts);
    // `2n` vertices and `3n - 2` triangles a prism, so `verts / 2` is the tile's
    // total plan vertices and three indices a triangle gives the length. Sized
    // exactly rather than pushed onto an array: an over-allocation would draw
    // triangles at the origin and an under-allocation would silently drop them,
    // because a write past a typed array's end is not an error.
    const indices = 3 * (3 * (verts / 2) - 2 * group.count);
    // 16 bits is enough by a factor of twenty on the densest tile in the CBD,
    // and it is chosen rather than assumed -- a build that changed the tile size
    // or the vertex cap must widen the index rather than wrap it.
    const index = verts > 65536 ? new Uint32Array(indices) : new Uint16Array(indices);

    let v = 0;
    let t = 0;
    for (let i = group.first; i < group.first + group.count; i++) {
      const n = data.vertCount[i];
      const base = data.baseY[i];
      const top = base + data.height[i];
      const fv = data.firstVert[i] * 2;
      const b0 = v;
      const t0 = v + n;

      for (let k = 0; k < n; k++) {
        const x = data.plan[fv + k * 2];
        const z = data.plan[fv + k * 2 + 1];
        position[(b0 + k) * 3] = x;
        position[(b0 + k) * 3 + 1] = base;
        position[(b0 + k) * 3 + 2] = z;
        position[(t0 + k) * 3] = x;
        position[(t0 + k) * 3 + 1] = top;
        position[(t0 + k) * 3 + 2] = z;
        slabY[b0 + k] = 0;
        slabY[t0 + k] = 1;
      }

      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        index[t++] = b0 + k;
        index[t++] = b0 + j;
        index[t++] = t0 + j;
        index[t++] = b0 + k;
        index[t++] = t0 + j;
        index[t++] = t0 + k;
      }
      for (let k = 1; k < n - 1; k++) {
        index[t++] = t0;
        index[t++] = t0 + k;
        index[t++] = t0 + k + 1;
      }

      const tint = FAR_TINT[data.material[i]];
      let r = tint[0];
      let g = tint[1];
      let b = tint[2];

      if (data.material[i] === GLASS_SLOT || data.archetype[i] === towerArchetype) {
        r *= GLASS_COOL[0];
        g *= GLASS_COOL[1];
        b *= GLASS_COOL[2];
      }

      const haze =
        HAZE_MAX *
        Math.min(Math.max((data.height[i] - HAZE_START_M) / (HAZE_FULL_M - HAZE_START_M), 0), 1);
      r += (FOG_LINEAR[0] - r) * haze;
      g += (FOG_LINEAR[1] - g) * haze;
      b += (FOG_LINEAR[2] - b) * haze;

      // Keyed off the position rather than an index, so a slab keeps its tone
      // across a rebuild that reorders the ledger. Metres are quantised first
      // because two adjacent buildings must land in different cells, and 1 m is
      // finer than any two centroids are close. The plan's first vertex stands in
      // for the centroid the box era used -- it is a point on the building, it is
      // stable across rebuilds for the same reason, and the hash only has to
      // break a repeat.
      const tone =
        1 - JITTER + 2 * JITTER * hash(Math.round(data.plan[fv]), Math.round(data.plan[fv + 1]));
      for (let k = 0; k < 2 * n; k++) {
        colour[(v + k) * 3] = r * tone;
        colour[(v + k) * 3 + 1] = g * tone;
        colour[(v + k) * 3 + 2] = b * tone;
      }
      v += 2 * n;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setAttribute('color', new BufferAttribute(colour, 3));
    geometry.setAttribute(SLAB_Y, new BufferAttribute(slabY, 1));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, material);
    mesh.name = `far-city-${group.key}`;
    // Neither casts nor receives. The sun's shadow volume is 220 m across, and a
    // tile that close is resident and has hidden its own slabs anyway -- so a
    // caster here could only ever fight the real building for the same texels,
    // and a receiver would be an unlit material paying for a shadow lookup whose
    // result it discards.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // What this mesh contributes, so `FarCity.removeTiles` can take back exactly
    // what was added when its hexagon goes out of range. See `dropMesh`.
    mesh.userData.farSlabs = group.count;
    mesh.userData.farTriangles = indices / 3;
    city.addTile(group.key, mesh);
  }
  return city;
}

// --- The far ground -----------------------------------------------------------

/**
 * The far ground: the coarse extent heightfield, with the old flat far plane
 * carried on its outer ring as an apron.
 *
 * **This replaces `ground.createFarGround` rather than sitting under it**, and
 * the reason is depth precision rather than tidiness. Two near-parallel ground
 * surfaces have to stay further apart than the depth buffer can resolve, and
 * with a 0.1 m near plane that resolution is d^2 / (near * 2^24): 1.9 m at the
 * streaming radius, 12 m at the 4.5 km edge of the extent. Over the harbour the
 * heightfield *is* sea level, so it would sit one metre off a plane placed at
 * sea level minus four -- and one metre at 4 km is a tenth of a depth step. The
 * whole middle of Sydney Harbour would shimmer. One surface, no fight.
 *
 * The apron is the same 40 km quad the far plane was, at the same sea level
 * minus four, joined to the heightfield's edge posts as one ring of cells. It is
 * what stops any camera angle finding sky under the world, and it turns what
 * would be a cliff at the edge of the data into a ramp: 24 m of drop spread over
 * 15.5 km is 0.09 degrees, under fog that is 46% closed. Ramping to sea level
 * rather than holding the edge height is the least-wrong continuation -- past
 * the extent Sydney is mostly water, and a 20 m plateau over Botany Bay is a
 * worse lie than a slope.
 *
 * The grid is walked exactly as `terrain.buildTerrainMesh` walks a tile: row 0
 * is the northern edge, rows advance south (+Z), and each cell splits north-west
 * to south-east. That split is not a detail -- `tiles.build_far_terrain` measures
 * this surface's overshoot against the real terrain through the same
 * triangulation to decide how far to sink it, so the two must agree.
 */
export function buildFarGround(
  grid: Float32Array,
  far: FarContract,
  seaLevelY: number,
  material: MeshStandardNodeMaterial,
): Mesh {
  const inner = far.terrain.posts;
  const half = far.terrain.half_extent_m;
  const step = far.terrain.post_m;
  const sink = far.terrain.sink_m;
  // The apron is one extra ring of posts around the heightfield, which is what
  // lets one triangulation loop produce the grid, the four edges and the four
  // corners with a single winding rule.
  const stride = inner + 2;
  const total = stride * stride;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  /** World x of a column, world z of a row. Ring 0 and ring inner+1 are apron. */
  const coord = (k: number): number =>
    k === 0 ? -APRON_HALF : k > inner ? APRON_HALF : -half + (k - 1) * step;
  // The apron sits at sea level minus four -- `ground.FAR_PLANE_SINK`, kept
  // exactly where the flat plane had it, because the apron is where the harbour
  // and the ocean are and four metres of water level is not a thing anyone can
  // see at a kilometre and a half through fog. The heightfield takes its own
  // measured sink instead, which is a different number for a different reason.
  const heightAt = (r: number, c: number): number =>
    r === 0 || c === 0 || r > inner || c > inner
      ? seaLevelY - 4
      : grid[(r - 1) * inner + (c - 1)] - sink;

  for (let r = 0; r < stride; r++) {
    for (let c = 0; c < stride; c++) {
      const i = r * stride + c;
      position[i * 3] = coord(c);
      position[i * 3 + 1] = heightAt(r, c);
      position[i * 3 + 2] = coord(r);

      // Central difference over the real post spacing where there is one on both
      // sides, one-sided at the edges -- the same construction `terrain.ts` uses,
      // so the far ground and a tile's ground are shaded by the same rule.
      const c0 = Math.max(c - 1, 0);
      const c1 = Math.min(c + 1, stride - 1);
      const r0 = Math.max(r - 1, 0);
      const r1 = Math.min(r + 1, stride - 1);
      const dhdx = (heightAt(r, c1) - heightAt(r, c0)) / (coord(c1) - coord(c0));
      const dhdz = (heightAt(r1, c) - heightAt(r0, c)) / (coord(r1) - coord(r0));
      const len = Math.hypot(-dhdx, 1, -dhdz);
      normal[i * 3] = -dhdx / len;
      normal[i * 3 + 1] = 1 / len;
      normal[i * 3 + 2] = -dhdz / len;

      uv[i * 2] = c / (stride - 1);
      uv[i * 2 + 1] = r / (stride - 1);
    }
  }

  const index: number[] = [];
  for (let r = 0; r < stride - 1; r++) {
    for (let c = 0; c < stride - 1; c++) {
      const nw = r * stride + c;
      const ne = nw + 1;
      const sw = nw + stride;
      const se = sw + 1;
      index.push(nw, se, ne, nw, sw, se);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setIndex(index);

  const mesh = new Mesh(geometry, material);
  mesh.name = 'far-ground';
  // Receives and never casts, exactly as the flat plane it replaces did: a
  // shadow on the far field is a shadow on the block interiors and the verges,
  // and putting a 40 km surface into the depth map would write a full-screen
  // layer at ground level and shadow everything standing on it.
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

// --- Loading ------------------------------------------------------------------

export interface FarLayer {
  /** The city. Null when there is no far layer to load. */
  slabs: FarCity | null;
  /** The ground. Null when there is none, and `main.ts` falls back to the plane. */
  ground: Mesh | null;
  /** Slabs resident, for the debug overlay. */
  count: number;
  /**
   * The per-hex skyline, on a segmented world. Null on every other world, and
   * `main.ts` simply never pumps it. See `FarHexes`.
   */
  hexes: FarHexes | null;
}

const EMPTY: FarLayer = { slabs: null, ground: null, count: 0, hexes: null };

/**
 * The far city, one hexagon at a time.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `far.bin`. The whole-world file is **3.08 MB, loaded at boot
 * and never evicted**, and at 60 km it is ~20 MB of skyline held for the
 * session. Nobody needs Penrith's rooflines from Bondi -- 45 km away, under
 * fog, behind the Blue Mountains foothills. So the slabs are cut with the same
 * hexagons everything else is (`world/hexes.ts`) and carried on a distance:
 * `far_cut_m`, 20 km, which is `far-terrain.bin`'s own half-extent and
 * therefore the distance past which there is no coarse ground for a prism to
 * stand on anyway.
 *
 * At the shipped 19.3 km radius that cut is a no-op in the only direction that
 * matters: the far city *is* the CBD cluster at the origin, and no point in the
 * build is more than 19.3 km from it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS DRAWN BEFORE IT IS COMPILED, which is the constraint that shapes
 * this class. A mesh entering the scene is a mesh whose pipeline is compiled on
 * the frame that first draws it -- a freeze, and precisely what `PipelineWatch`
 * asserts zero of. `TileStreamer.setPrecompiler` solved this for tiles by
 * holding a tile out of the picture until its shaders were built off-thread,
 * and this takes the same function and makes the same promise. A hexagon's
 * meshes are added hidden, compiled, and only then allowed to draw.
 *
 * The cost of being wrong about it is nil in the other direction: a far slab
 * that is late by a few hundred milliseconds is a building 20 km away that
 * appears a moment later than it might have.
 */
export class FarHexes {
  private readonly city: FarCity;
  private readonly material: MeshBasicNodeMaterial;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly towerArchetype: number;
  private readonly cut: number;
  private readonly dir: string;
  /** Hex id -> the tile keys its slabs are filed under, so eviction is exact. */
  private readonly resident = new Map<string, string[]>();
  private readonly inFlight = new Set<string>();
  private precompile: ((group: Group) => Promise<void>) | null = null;

  constructor(
    city: FarCity,
    material: MeshBasicNodeMaterial,
    options: {
      baseUrl: string;
      version: string;
      towerArchetype: number;
      cut: number;
      dir: string;
    },
  ) {
    this.city = city;
    this.material = material;
    this.baseUrl = options.baseUrl;
    this.version = options.version;
    this.towerArchetype = options.towerArchetype;
    this.cut = options.cut;
    this.dir = options.dir;
  }

  /** How many hexagons' slabs are in the city. For the debug overlay. */
  get residentHexes(): number {
    return this.resident.size;
  }

  /**
   * How far a hexagon's slabs are worth carrying, metres, from the world's own
   * contract. `main.ts` asks `hexes.hexesNear` for this radius rather than the
   * approach radius, so the skyline reaches five times further than the
   * manifests do -- which is the point: you can see a hexagon long before you
   * need to know what is in it.
   */
  get cutM(): number {
    return this.cut;
  }

  /**
   * The same compiler `TileStreamer.setPrecompiler` is given. Optional: without
   * one a hexagon's slabs are drawn as soon as they are built, which is what
   * the far layer did before it was segmented.
   */
  setPrecompiler(precompile: (group: Group) => Promise<void>): void {
    this.precompile = precompile;
  }

  /**
   * Bring the resident set in line with where the player is.
   *
   * Called once a frame from `main.ts` with the camera's position, on
   * `updateRegions`' terms. `entries` is whatever `hexes.hexesNear` hands back
   * for `far_cut_m`, so this class holds no model of the grid.
   */
  update(inRange: ReadonlyArray<{ id: string; far?: { bytes: number } }>): void {
    const wanted = new Set<string>();
    for (const entry of inRange) {
      if (!entry.far) continue;
      wanted.add(entry.id);
      if (this.resident.has(entry.id) || this.inFlight.has(entry.id)) continue;
      void this.load(entry.id);
    }
    for (const [id, keys] of this.resident) {
      if (wanted.has(id)) continue;
      this.city.removeTiles(keys);
      this.resident.delete(id);
    }
  }

  /** Await the hexagons in range now. The boot path, so the warm-up has meshes. */
  async ensure(inRange: ReadonlyArray<{ id: string; far?: { bytes: number } }>): Promise<void> {
    await Promise.all(
      inRange.filter((e) => e.far && !this.resident.has(e.id)).map((e) => this.load(e.id)),
    );
  }

  private async load(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      const resp = await fetchWorldAsset(this.baseUrl, `${this.dir}/${id}.far.bin`, this.version);
      if (!resp.ok) return;
      const data = decodeFar(await resp.arrayBuffer());
      if (data === null) return;
      // The keys are taken from the payload rather than from the city, so a
      // hexagon takes back exactly the tiles it put in even if two of them
      // somehow overlapped -- which they cannot, since a tile is assigned to
      // one hex by its centre, but eviction should not depend on that.
      // **Staged off the scene graph, compiled, and only then moved in.**
      //
      // Not "added hidden and compiled", which was the obvious first shape and
      // is wrong: `Renderer.compileAsync` walks the scene the same way `render`
      // does and skips anything with `visible === false`, so a hidden mesh
      // compiles nothing and the freeze lands on the frame it is shown. A
      // detached group is visible to the compiler and invisible to the renderer
      // at the same time, which is exactly the state this needs -- and it is
      // the same trick `main.ts` warms the tile stand-ins with.
      //
      // The staging city shares `this.material`, so the pipelines compiled here
      // are the ones the real city will draw with rather than lookalikes.
      const staged = buildFarSlabs(data, this.towerArchetype, {
        city: new FarCity(),
        material: this.material,
      });
      try {
        await this.precompile?.(staged);
      } catch {
        // A hexagon that would not compile is a hexagon that hitches once,
        // which is what the far layer did before this existed.
      }
      // `Group.add` reparents, so this empties the staging city rather than
      // copying out of it. Iterated over a snapshot for that reason.
      const keys: string[] = [];
      for (const key of staged.tileKeys()) {
        const mesh = staged.getObjectByName(`far-city-${key}`);
        if (!(mesh instanceof Mesh)) continue;
        const held = mesh.userData as { farSlabs?: number; farTriangles?: number };
        this.city.addTile(key, mesh);
        this.city.addCounts(held.farSlabs ?? 0, held.farTriangles ?? 0);
        keys.push(key);
      }
      this.resident.set(id, keys);
    } catch {
      // Counted by nothing and retried on the next frame that finds this
      // hexagon in range, on `world/hexes.ts`'s argument: a skyline that gives
      // up after one flaky request is a hole in the horizon for the session.
    } finally {
      this.inFlight.delete(id);
    }
  }
}

/**
 * Fetch and build the whole far layer, once, at startup.
 *
 * Both files are requested together and neither can fail the world: no `far`
 * block in the index, a 404, a truncated file or a bad length all end in the
 * same place, which is a client that renders exactly what it rendered before
 * this pass existed. That is not defensive habit -- the index and the tile
 * directory outlive any one pipeline run, and a world built yesterday has to
 * keep loading today.
 *
 * `archetypes` is `index.json`'s own list rather than a copy of it here, so the
 * one archetype this file cares about is found by name. A hard-coded 5 would
 * silently paint the wrong buildings blue the first time the pipeline inserts an
 * archetype ahead of `tower`.
 */
export async function loadFarLayer(
  baseUrl: string,
  far: FarContract | undefined,
  archetypes: string[],
  seaLevelY: number,
  groundMaterial: MeshStandardNodeMaterial,
  /** The build stamp, as a query suffix. See `world/version.ts`. */
  version = '',
  /**
   * The hex contract, when the world is segmented.
   *
   * Present means the slabs come one hexagon at a time out of
   * `hexes/<id>.far.bin` and `far.bin` is never fetched at all; absent means
   * the single 3.08 MB file, which is what every world before this pass has.
   * The **ground** is whole in both cases: `far-terrain.bin` is 104 kB for the
   * entire extent and is the surface every slab in the world stands on, so
   * cutting it up would buy a rounding error and cost a seam.
   */
  hexes?: { dir: string; far_cut_m: number } | null,
): Promise<FarLayer> {
  if (!far) return EMPTY;
  try {
    const [slabBuf, terrBuf] = await Promise.all([
      hexes
        ? Promise.resolve(null)
        : fetchWorldAsset(baseUrl, 'far.bin', version).then((r) => (r.ok ? r.arrayBuffer() : null)),
      fetchWorldAsset(baseUrl, 'far-terrain.bin', version).then((r) =>
        r.ok ? r.arrayBuffer() : null,
      ),
    ]);

    const tower = archetypes.indexOf('tower');
    let slabs: FarCity | null = null;
    let farHexes: FarHexes | null = null;
    if (hexes) {
      // Empty, and filled by `FarHexes.ensure` before the warm-up runs -- see
      // `main.ts`. An empty far city at warm-up time would leave the slab
      // pipeline uncompiled and put the compile on the first frame a hexagon
      // landed, which is the freeze `PipelineWatch` exists to have none of.
      slabs = new FarCity();
      farHexes = new FarHexes(slabs, createSlabMaterial(), {
        baseUrl,
        version,
        towerArchetype: tower,
        cut: hexes.far_cut_m,
        dir: hexes.dir,
      });
    } else if (slabBuf) {
      const data = decodeFar(slabBuf);
      if (data) slabs = buildFarSlabs(data, tower);
    }

    let ground: Mesh | null = null;
    const posts = far.terrain.posts;
    if (terrBuf && terrBuf.byteLength === posts * posts * 4) {
      ground = buildFarGround(new Float32Array(terrBuf), far, seaLevelY, groundMaterial);
    }

    return { slabs, ground, count: slabs?.count ?? 0, hexes: farHexes };
  } catch (err) {
    console.warn('far layer failed to load:', err);
    return EMPTY;
  }
}
