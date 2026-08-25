/**
 * The harbour: the sidecar, the sheets, and the one material every drop of water
 * in the world wears.
 *
 * The pipeline emits `tiles/<key>.water.bin` for every tile with water on it and
 * `far-water.bin` once for the whole extent -- the same format at two scales, and
 * `pipeline/sydney/tiles.py`'s `write_water` is the authority on both. A sheet is
 * a flat triangulated run at one surface height, carrying **depth as a vertex
 * attribute** because a fragment has no way to ask the terrain how deep it is.
 *
 * ---------------------------------------------------------------------------
 * **One material for the whole world.** Not one per tile, not one for near and
 * one for far: `createWaterMaterial` is called exactly once, in the streamer's
 * constructor, and `main.ts` takes the same instance for the far sheet. Every
 * material in this client is shared for the same reason -- a material is a
 * pipeline compile, and this project's history is that per-tile materials are
 * what kills it -- but water has a second reason on top: the waves are a function
 * of world position and one clock, so two instances would be two clocks, and two
 * clocks a frame apart is a visible tear along every tile boundary in the
 * harbour.
 *
 * ---------------------------------------------------------------------------
 * The look, and where each of its four terms comes from.
 *
 * **Waves are analytic, not textured.** Two octaves of three directional sine
 * waves each -- a 9 m swell and a 1.6 m chop -- summed as a height field whose
 * gradient is closed-form, so the normal is exact and costs six sines and six
 * cosines with no texture fetch, no derivative and no hash. It also means the
 * *geometry* needs no tessellation at all: a full-water tile is 451 triangles
 * because that is what the shoreline costs, not because the waves want vertices.
 * Both octaves fade with distance for `ground.ts`'s reason, which applies far
 * harder here: a normal that goes sub-pixel does not average away, it sparkles.
 *
 * **Colour is a Fresnel blend and it is most of the look.** Water is not a
 * colour, it is a mirror with a dark thing behind it: looking straight down you
 * see the deep tint, and looking out across the harbour you see the sky, and the
 * crossover is Schlick's term at F0 = 0.02. That single expression is what makes
 * the far half of the harbour pale and the near half dark, why the sheet reads
 * as a *surface* rather than as a painted plane, and why a wave that tilts a
 * facet toward you goes dark against its own crest.
 *
 * **The sun's glitter is two terms and neither is the material's own specular.**
 * A broad aureole and a tight spike, both keyed on the mirror direction against
 * `FacadeGlobals.sunDirection` -- the same uniform the glass in `facade.ts`
 * reads, driven from `sky/calibration.ts`'s solar position, because a second
 * opinion about where the sun is would be a second sun. They are added into the
 * albedo, so they take the sun's own falloff and vanish at dusk with it.
 *
 * **Depth tints the shallows.** The vertex attribute is metres of water, and the
 * first two of them mix toward a green-brown that is the bed showing through. It
 * is what makes a shoreline read as a shoreline rather than as a cut edge.
 *
 * ---------------------------------------------------------------------------
 * Every colour here is an **albedo**, and the numbers only make sense with the
 * rest of the chain in hand. `sky/calibration.ts` puts 16.3 of horizontal
 * irradiance on an up-facing surface at 3 pm; `BRDF_Lambert` divides by pi and
 * `main.ts` exposes at 0.62 under Khronos PBR Neutral, so an albedo `a` lands at
 * roughly `3.2 a` of display-linear before the tone curve. The horizon
 * reflectance below is 0.20/0.245/0.30, which is rgb(207, 226, 249) on screen --
 * the fog colour, which is what water at the horizon has to be or the two meet
 * at a line.
 */

import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  dot,
  float,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  saturate,
  smoothstep,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  type Material,
} from 'three/webgpu';

import { fetchWorldAsset } from './cdn.ts';
import type { FacadeGlobals } from './facade.ts';
import { TerrainField } from './terrain.ts';
import { WaterLevels } from './wading.ts';

/**
 * `.water.bin`'s header. **Must match `WATER_MAGIC` and `WATER_VERSION` in
 * `pipeline/sydney/tiles.py`.**
 *
 * Both are checked rather than assumed, on `far.ts`'s argument: a mismatch means
 * *no water*, which is the same answer this file gives for a 404, and is far
 * better than a plausible misread -- the first word of a headerless payload
 * would decode as a sheet count and everything after it as geometry at random
 * heights.
 */
import {
  SHEET_HEADER,
  WATER_HEADER,
  WATER_MAGIC,
  WATER_VERSION,
  WATER_VERTEX_STRIDE,
  decodeWater,
  type TileWater,
  type WaterSheet,
} from './tile-decode.ts';

/**
 * The decode, the record types and the format constants live in
 * `world/tile-decode.ts`, which carries no `three` import and can therefore be
 * read on a worker thread -- and a harbour tile's `.water.bin` is 29 kB, the
 * largest sidecar in the build. Re-exported from here because this module is
 * what owns how water *looks*, and every caller should keep naming it.
 */
export { decodeWater };
export type { TileWater, WaterSheet };

/**
 * The water contract, from `index.json`.
 *
 * Optional as a whole and with no defaults, exactly like `FarContract`: an index
 * written before this pass describes a world whose harbour is dry ground, and
 * defaulting a sea level onto it would put a sheet through the middle of
 * Barangaroo. Absent means no water anywhere.
 */
export interface WaterContract {
  version: number;
  /** Where 0 m AHD sits in world y. The same number as `terrain.sea_level_y`. */
  surface_y: number;
  /** How far the bed was cut under open water, metres. Reported, never rendered. */
  depth_m: number;
  pond_depth_m?: number;
  shore_clearance_m?: number;
  area_m2?: number;
  tidal_area_m2?: number;
  bodies?: number;
  levels?: number;
  far?: {
    sheets: number;
    vertices: number;
    triangles: number;
    bytes: number;
    /** How far the far sheet sits under the streamed ones, metres. */
    sink_m: number;
    cell_m?: number;
  };
}

/**
 * Build **one mesh for the tile**, in the frame the payload was written in.
 *
 * One per sheet until the creeks arrived, and the change is theirs. A creek
 * cannot be one flat sheet -- it runs downhill -- so `pipeline/sydney/creeks.py`
 * cuts it into 10 m reaches and each reach is its own level, which is exactly
 * what `write_water`'s format was built to allow. A tile the creek crosses
 * diagonally carries about seventy of them. Seventy sheets was seventy meshes,
 * seventy draw calls and seventy render objects for perhaps five hundred
 * vertices, which is the cost model inverted.
 *
 * Merging is free here because of a decision already made below: the sheet's
 * level is **written into every vertex** rather than carried as a group offset,
 * so vertices from different levels sit in one buffer with nothing to
 * reconcile. Nothing else about a sheet differs -- one material for the whole
 * world, one attribute layout, one set of flags -- so the merge is a
 * concatenation and an index rebase, and the harbour tiles that used to carry a
 * bay and a pond as two meshes now carry one.
 *
 * Tile-local for a `.water.bin` and world metres for `far-water.bin`, which is
 * the same distinction `far.ts` makes and needs no flag here: the tile-local
 * meshes are added to a tile's group and the far one to the scene, and each
 * inherits the translation it should.
 *
 * The `y` is the sheet's own surface, written into every vertex rather than
 * carried as a group offset, because the mesh may be one of several at different
 * heights in the same tile and because an absolute y is what every other height
 * in this project's sidecars already is.
 *
 * Normals are `(0, 1, 0)` and the material replaces them per fragment. They are
 * written anyway rather than omitted: `MeshStandardNodeMaterial` builds a
 * tangent frame from the geometry's normal attribute for anything that needs one,
 * and an absent attribute is a shader compile that reads a stream that is not
 * there.
 */
export function buildWaterMeshes(data: TileWater, material: Material): Mesh[] {
  const out: Mesh[] = [];
  let count = 0;
  let indices = 0;
  for (const sheet of data.sheets) {
    count += sheet.count;
    indices += sheet.indices.length;
  }
  if (count > 0) {
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const depth = new Float32Array(count);
    const index = new Uint32Array(indices);
    let v = 0;
    let t = 0;
    for (const sheet of data.sheets) {
      for (let i = 0; i < sheet.count; i++) {
        const o = (v + i) * 3;
        position[o] = sheet.vertices[i * 3];
        position[o + 1] = sheet.surface;
        position[o + 2] = sheet.vertices[i * 3 + 1];
        normal[o + 1] = 1;
        depth[v + i] = sheet.vertices[i * 3 + 2];
      }
      for (let i = 0; i < sheet.indices.length; i++) index[t + i] = sheet.indices[i] + v;
      v += sheet.count;
      t += sheet.indices.length;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setAttribute('normal', new BufferAttribute(normal, 3));
    geometry.setAttribute('waterDepth', new BufferAttribute(depth, 1));
    geometry.setIndex(new BufferAttribute(index, 1));

    const mesh = new Mesh(geometry, material);
    mesh.name = 'water';
    // Receives and never casts, on exactly `terrain.ts`'s argument: its only
    // contribution to the depth map would be the surface itself, and every
    // fragment it wrote there is one the buildings have to fight for. What it
    // *receives* is worth having -- the shadow of a wharf, a bridge or the
    // Rocks lying across the water is most of what puts the water in the city
    // rather than beside it.
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // Read by `streamer.applyShadowRole` on every later frame, so the flags
    // above survive the first time the tile changes shadow band.
    mesh.userData.surface = true;
    mesh.userData.water = true;
    mesh.frustumCulled = false; // culled with its tile, like every other primitive
    out.push(mesh);
  }
  return out;
}

/**
 * One tile's water as a flat triangle soup in **world** metres, for the map.
 *
 * Expanded through the index rather than kept indexed, and de-indexing is the
 * point: `minimap.ts` walks this straight into a `Path2D` at 15 Hz and would
 * otherwise pay three array lookups a corner to do it. A full-water tile is 553
 * triangles, so 13 kB against the sidecar's 20 -- and it is held for exactly as
 * long as the tile is, so a player who never goes near the harbour holds none.
 *
 * **Every sheet, not just the biggest.** This took only the sheet with the most
 * triangles, on the argument that a tile with a bay and a pond on it would lose
 * a dot from the map and the alternative was a second loop for a case that does
 * not occur in this extent. The creeks are that case: a creek tile's sheets are
 * seventy 10 m reaches and no one of them is the tile's water, so the largest
 * would have drawn a single puddle. And a creek is worth more on a map than the
 * harbour is -- the harbour is the shape you navigate by, but the creek is the
 * thing you are looking for a way across. The second loop is a concatenation.
 */
export function waterPlanWorld(
  data: TileWater,
  originX: number,
  originZ: number,
): Float32Array | null {
  let corners = 0;
  for (const sheet of data.sheets) corners += sheet.indices.length;
  if (corners === 0) return null;
  const out = new Float32Array(corners * 2);
  let at = 0;
  for (const sheet of data.sheets) {
    for (let i = 0; i < sheet.indices.length; i++) {
      const v = sheet.indices[i] * 3;
      out[at * 2] = sheet.vertices[v] + originX;
      out[at * 2 + 1] = sheet.vertices[v + 1] + originZ;
      at++;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * The material.
 * ------------------------------------------------------------------------- */

/**
 * The two octaves, as (direction degrees, wavelength m, amplitude m, speed m/s).
 *
 * Three waves an octave rather than one, at directions that are not multiples of
 * each other, because a single sine is a corrugated roof and two is a plaid.
 * Three at 20-40 degrees apart never repeat inside a view.
 *
 * The **amplitudes are slopes, not heights** in everything that follows: only
 * the gradient of this field is used, and what the eye reads is the angle the
 * surface tilts. A 9 m swell at 4 cm gives a peak slope of `2*pi*A/L` = 2.8%,
 * which is a lazy harbour swell; the chop's 1.6 m at 6 mm is 2.4% on top of it.
 * Together they land at about 3.5 degrees of peak tilt, which against a Fresnel
 * term that moves fast near grazing is a great deal of visible motion.
 *
 * Bearings are in the renderer's frame -- x east, z south -- and they run
 * broadly from the north-east, which is the summer sea breeze Sydney gets its
 * afternoon chop from.
 */
const SWELL: Array<[number, number, number, number]> = [
  [200, 9.1, 0.042, 1.9],
  [232, 6.3, 0.030, 1.6],
  [176, 13.7, 0.036, 2.4],
];
const CHOP: Array<[number, number, number, number]> = [
  [214, 1.63, 0.0062, 0.9],
  [186, 1.11, 0.0044, 0.8],
  [243, 2.27, 0.0071, 1.1],
];

/**
 * Where each octave stops contributing, metres. See `ground.ts`'s distance fade,
 * which is the same measure for the same reason and a weaker version of it.
 *
 * A normal map that goes sub-pixel does not average to a flat surface -- it
 * averages to a *random* surface, and with a specular term on top of it that is
 * a field of white speckle crawling across the mid-field as the player walks.
 * The chop's 1.1 m wavelength is at a pixel by about 300 m at this project's
 * render scale, and the swell's 6.3 m at about 1.8 km, so each fades out over
 * the band before its own crossover.
 *
 * What is left past 3 km is a mirror-flat sheet, which is what a harbour looks
 * like from three kilometres away.
 */
const CHOP_FADE_NEAR = 60;
const CHOP_FADE_FAR = 320;
const SWELL_FADE_NEAR = 700;
const SWELL_FADE_FAR = 3200;

/**
 * Deep water, as an albedo. Display rgb(30, 66, 82) face-on before the sky term
 * is mixed in: dark, green-blue, and deliberately darker than anyone expects a
 * "blue" harbour to be, because everything that makes it read as blue is the
 * Fresnel reflection above it rather than the body colour under it.
 */
const DEEP = /*#__PURE__*/ vec3(0.010, 0.030, 0.040);

/**
 * The shallows, where the bed is showing through: a green-brown sand-and-weed
 * tint. Two metres is where it has faded out entirely -- see `SHALLOW_DEPTH_M`.
 */
const SHALLOW = /*#__PURE__*/ vec3(0.034, 0.055, 0.040);
const SHALLOW_DEPTH_M = 2.2;

/**
 * What the surface reflects at grazing incidence, as an albedo: rgb(207, 226,
 * 249) on screen, which is `main.ts`'s fog colour to within a code value.
 *
 * It has to be that, and not a sampled sky. The dome is a Preetham model whose
 * horizon band runs an order of magnitude brighter than its zenith, the fog
 * closes over the far half of the harbour, and what the eye checks is whether
 * the water and the sky meet at a *line* or at a seam. Matching the fog is what
 * makes it a line, at every hour, without a texture fetch.
 */
const HORIZON = /*#__PURE__*/ vec3(0.20, 0.245, 0.30);

/**
 * Water's normal-incidence reflectance. Not a knob: `((1.33 - 1)/(1.33 + 1))^2`
 * for an index of refraction of 1.33 is 0.0201, and every other number in the
 * Fresnel expression is derived from it.
 */
const WATER_F0 = 0.0201;

/**
 * The two glitter terms: (exponent, strength).
 *
 * The broad one is the sun's aureole, about 15 degrees wide, and it is what puts
 * a wide bright field on the water on the sun's side of the view. The tight one
 * is the disc itself at roughly a degree, and it is deliberately far over 1.0 --
 * the sun's reflection in water *is* blown out, and Khronos PBR Neutral
 * asymptotes to white rather than clipping, so it comes out as a hot core with a
 * graded edge rather than a flat white blob.
 *
 * Both are added into the albedo rather than being a specular lobe, which is
 * what makes them free of the roughness the diffuse term wants and what makes
 * them scale with the sun's own intensity -- at dusk they redden and go out with
 * it, and at night there is nothing to add.
 */
const AUREOLE = /*#__PURE__*/ vec3(1.0, 0.96, 0.88);
const AUREOLE_POWER = 26;
const AUREOLE_STRENGTH = 0.55;
const GLINT_POWER = 260;
const GLINT_STRENGTH = 7.0;

/**
 * The clock the waves scroll on. Seconds, advanced by the streamer once a frame
 * from the same clamped frame delta everything else in the world runs on -- so a
 * backgrounded tab issues no frames, advances no time, and comes back to a
 * harbour where it left it rather than to one that has run on for a minute.
 *
 * One uniform for the whole world, held here beside the material it drives.
 */
export function createWaterClock() {
  return uniform(0);
}

export type WaterClock = ReturnType<typeof createWaterClock>;

/**
 * The gradient of the wave field at a world point, as (dy/dx, dy/dz).
 *
 * Closed form, which is the whole reason the waves are sines: the height is
 * `sum A sin(k . p + w t)` and its gradient is `sum A k cos(k . p + w t)`, so
 * the normal is exact at every point rather than being differenced, and there is
 * no texture, no derivative and no hash anywhere in it.
 *
 * A plain TypeScript helper rather than a TSL `Fn`, so the loop unrolls at graph
 * build time and the six waves cost six sums instead of a function node.
 */
function waveSlope(p: any, t: any, waves: Array<[number, number, number, number]>, fade: any) {
  let dx: any = float(0);
  let dz: any = float(0);
  for (const [bearing, wavelength, amplitude, speed] of waves) {
    const a = (bearing * Math.PI) / 180;
    const k = (2 * Math.PI) / wavelength;
    const kx = Math.cos(a) * k;
    const kz = Math.sin(a) * k;
    // Angular frequency from the phase speed, so a wave's crests travel at the
    // metres per second it is named with rather than at a rate that changes
    // with its length.
    const omega = k * speed;
    const phase = p.x.mul(kx).add(p.y.mul(kz)).add(t.mul(omega));
    const c = cos(phase).mul(amplitude);
    dx = dx.add(c.mul(kx));
    dz = dz.add(c.mul(kz));
  }
  return vec2(dx.mul(fade), dz.mul(fade));
}

/**
 * The one water material in the world.
 *
 * `globals` is the streamer's `FacadeGlobals`: this reads `sunDirection` from it
 * and nothing else, and it is the same instance the facades read, which is what
 * stops there being two suns. `clock` is the wave time.
 *
 * A `MeshStandardNodeMaterial` rather than a basic one, because water in a city
 * is a *lit* surface: it takes the sun's colour as it reddens, it takes the
 * hemisphere fill at night, it is fogged by the same aerial perspective as the
 * suburb behind it, and -- the one that matters most in frame -- it takes the
 * shadow of the wharf it is lying against.
 */
export function createWaterMaterial(
  globals: FacadeGlobals,
  clock: WaterClock,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'water';

  // The perturbed normal, in **view space**, which is the space
  // `NodeMaterial.setupNormal` hands on: `material.normalNode` replaces
  // `normalView`, not the world normal. Building it in world space and
  // transforming once is what lets the waves be a function of world position --
  // a wave that was a function of a tile's local frame would restart at every
  // tile boundary in the harbour.
  const worldNormal = Fn(() => {
    const p: any = positionWorld.xz;
    const viewDistance = length(positionWorld.sub(cameraPosition));
    const chopFade = float(1).sub(
      smoothstep(float(CHOP_FADE_NEAR), float(CHOP_FADE_FAR), viewDistance),
    );
    const swellFade = float(1).sub(
      smoothstep(float(SWELL_FADE_NEAR), float(SWELL_FADE_FAR), viewDistance),
    );
    const swell = waveSlope(p, clock, SWELL, swellFade);
    const chop = waveSlope(p, clock, CHOP, chopFade);
    const slope: any = swell.add(chop);
    // The normal of a height field y = f(x, z) is (-df/dx, 1, -df/dz).
    return normalize(vec3(slope.x.negate(), float(1), slope.y.negate()));
  })();

  // `transformNormalToView` premultiplies by the model normal matrix, which for
  // these meshes is the identity: a tile's group carries a translation and
  // nothing else, and the far sheet carries no transform at all. So this is the
  // world normal put into view space and not an object-space one, which is what
  // the waves above are computed in.
  material.normalNode = transformNormalToView(worldNormal);

  material.colorNode = Fn(() => {
    const view: any = normalize(cameraPosition.sub(positionWorld));
    const n: any = worldNormal;

    // Schlick, with the exact F0 for water. `saturate` on the dot rather than
    // `abs`: a wave facet can turn far enough to face away from the camera at a
    // grazing view, and the reflection there is the horizon's, not a negative
    // one.
    const cosine = saturate(dot(n, view));
    const inv = float(1).sub(cosine);
    const inv2 = inv.mul(inv);
    const fresnel = float(WATER_F0).add(
      float(1 - WATER_F0).mul(inv2.mul(inv2).mul(inv)),
    );

    // The body colour, with the bed showing through the first two metres.
    const depth: any = attribute('waterDepth', 'float');
    const shallow = float(1).sub(smoothstep(float(0.0), float(SHALLOW_DEPTH_M), depth));
    const body = mix(DEEP, SHALLOW, shallow);

    // And the sky over it, which past about 70 degrees of incidence is nearly
    // all of what is seen.
    const surface = mix(body, HORIZON, fresnel);

    // The sun's own reflection, on the mirror direction. `reflect` takes the
    // *incident* direction, which is the view vector reversed.
    const mirror: any = reflect(view.negate(), n);
    const align = saturate(dot(mirror, globals.sunDirection));
    const glitter = AUREOLE.mul(
      pow(align, float(AUREOLE_POWER))
        .mul(AUREOLE_STRENGTH)
        .add(pow(align, float(GLINT_POWER)).mul(GLINT_STRENGTH)),
    );

    // The glitter is scaled by the same Fresnel term as the sky: a reflection
    // that ignored it would put the sun's disc on the water at full strength
    // looking straight down, where a real surface reflects two per cent of it.
    // Floored well under 1 rather than at F0, because the sun is the one thing
    // bright enough to be visible in that two per cent.
    return surface.add(glitter.mul(max(fresnel, float(0.08))));
  })();

  // Low, so the sun's own directional light draws a tight lobe on top of the
  // analytic glitter above -- and not *lower*, because the two together are
  // already at the top of the histogram and a mirror-smooth surface makes the
  // hemisphere fill disappear, which is what lights the water on the shaded side
  // of a wharf.
  material.roughnessNode = float(0.09);
  material.metalnessNode = float(0.0);
  return material;
}

/**
 * Fetch and build the always-resident far sheet. `null` when there is none.
 *
 * Same contract as `far.ts`'s loader and for the same reasons: never throws,
 * never fails the boot, and treats a missing contract as "this world has no
 * water" rather than defaulting anything. Losing this file costs the harbour
 * beyond the streaming radius -- which is most of it -- where losing the boot
 * costs the game.
 */
export async function loadFarWater(
  baseUrl: string,
  contract: WaterContract | undefined,
  material: Material,
  version = '',
): Promise<Mesh[]> {
  if (!contract?.far) return [];
  try {
    const resp = await fetchWorldAsset(baseUrl, 'far-water.bin', version);
    if (!resp.ok) return [];
    const data = decodeWater(await resp.arrayBuffer());
    if (!data) return [];
    const meshes = buildWaterMeshes(data, material);
    for (const mesh of meshes) mesh.name = 'far-water';
    return meshes;
  } catch (err) {
    console.warn('far water failed to load:', err);
    return [];
  }
}

/**
 * Self-check for the water rig, in the same spirit as `verifyLightRig`.
 *
 * Three of the four cases are about the *arithmetic between two files*, which is
 * where this feature can fail without a frame that says so:
 *
 *   1. **The decoder against the writer.** A stride or an offset out by a word
 *      produces geometry rather than an error -- triangles at plausible
 *      coordinates and impossible depths -- and the shore tint goes with it.
 *   2. **`WaterLevels` against `TerrainField`.** The wading rule keys tiles with
 *      its own copy of `floor(-z / tileSize)` because it may not import three.
 *      Get the sign wrong and the water level lands on the tile 500 m north of
 *      the water, so the player wades across a car park and runs across the
 *      harbour. This is the check that would say so, and it is here rather than
 *      in `wading.ts` because only this file may import the module it is checked
 *      against.
 *   3. **The wave field's own scale.** The waves are slopes, and a slope out by
 *      an order of magnitude either way is a mirror or a corrugated roof. Both
 *      look like a taste decision.
 */
export function verifyWater(): string[] {
  const failures: string[] = [];

  // --- 1. A round trip through the real decoder, from bytes laid out by hand
  // to `tiles.write_water`'s spec.
  const vertexCount = 3;
  const indexCount = 3;
  const bytes = new ArrayBuffer(
    WATER_HEADER + SHEET_HEADER + vertexCount * WATER_VERTEX_STRIDE + indexCount * 4,
  );
  const view = new DataView(bytes);
  view.setUint32(0, WATER_MAGIC, true);
  view.setUint32(4, WATER_VERSION, true);
  view.setUint32(8, 1, true);
  view.setFloat32(WATER_HEADER, -71.075, true);
  view.setUint32(WATER_HEADER + 4, vertexCount, true);
  view.setUint32(WATER_HEADER + 8, indexCount, true);
  const verts = [
    [0, 0, 3.5],
    [100, -20, 1.25],
    [50, -200, 0.05],
  ];
  let at = WATER_HEADER + SHEET_HEADER;
  for (const [x, z, d] of verts) {
    view.setFloat32(at, x, true);
    view.setFloat32(at + 4, z, true);
    view.setFloat32(at + 8, d, true);
    at += WATER_VERTEX_STRIDE;
  }
  for (let i = 0; i < indexCount; i++) {
    view.setUint32(at + i * 4, i, true);
  }
  const decoded = decodeWater(bytes);
  if (!decoded || decoded.sheets.length !== 1) {
    failures.push('decodeWater refused a payload written to the format it documents.');
  } else {
    const sheet = decoded.sheets[0];
    if (Math.abs(sheet.surface + 71.075) > 1e-3) {
      failures.push(`The sheet surface decoded as ${sheet.surface}, not -71.075.`);
    }
    if (sheet.count !== vertexCount || decoded.triangles !== 1) {
      failures.push(`Decoded ${sheet.count} vertices and ${decoded.triangles} triangles, wanted 3 and 1.`);
    }
    for (let i = 0; i < vertexCount; i++) {
      const got = [sheet.vertices[i * 3], sheet.vertices[i * 3 + 1], sheet.vertices[i * 3 + 2]];
      const want = verts[i];
      if (got.some((v, k) => Math.abs(v - want[k]) > 1e-4)) {
        failures.push(`Vertex ${i} decoded as (${got.join(', ')}), wanted (${want.join(', ')}).`);
      }
    }
  }
  // Truncation and a wrong magic must both be refused rather than half-read.
  if (decodeWater(bytes.slice(0, bytes.byteLength - 8)) !== null) {
    failures.push('decodeWater accepted a truncated payload; a short read is geometry at random depths.');
  }
  const wrongMagic = bytes.slice(0);
  new DataView(wrongMagic).setUint32(0, 0x12345678, true);
  if (decodeWater(wrongMagic) !== null) {
    failures.push('decodeWater accepted a payload with the wrong magic.');
  }

  // --- 1b. The merge, which the creeks made load-bearing.
  //
  // A tile's sheets are concatenated into one mesh and their indices rebased, and
  // a rebase that forgets its base is the classic version of this bug: it produces
  // a mesh, at plausible coordinates, whose second sheet's triangles all point at
  // the first sheet's vertices. On the harbour that is a fold in the water; on a
  // creek it is seventy reaches drawn on top of the first one. So this asserts the
  // two things a concatenation can get wrong -- that every vertex kept its own
  // sheet's level, and that every index still points at the vertex it was written
  // for.
  {
    const sheets: WaterSheet[] = [
      {
        surface: -71.075,
        count: 3,
        vertices: new Float32Array([0, 0, 3.5, 10, 0, 2, 0, -10, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      {
        surface: 12.5,
        count: 3,
        vertices: new Float32Array([100, -100, 0.4, 110, -100, 0.3, 100, -110, 0.2]),
        indices: new Uint32Array([0, 1, 2]),
      },
    ];
    const merged = buildWaterMeshes({ sheets } as TileWater, new MeshStandardNodeMaterial());
    if (merged.length !== 1) {
      failures.push(`two sheets built ${merged.length} meshes; a creek tile carries seventy of them`);
    } else {
      const geometry = merged[0].geometry;
      const position = geometry.getAttribute('position');
      const index = geometry.getIndex();
      if (position.count !== 6 || index === null || index.count !== 6) {
        failures.push('the merged mesh lost vertices or indices');
      } else {
        // Compared with a tolerance, because the buffers are f32 and the
        // literals above are f64: -71.075 is stored as -71.07499694824219 and an
        // exact test fails on a merge that is perfectly correct.
        const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
        if (!near(position.getY(0), -71.075) || !near(position.getY(3), 12.5)) {
          failures.push('the merge did not write each sheet its own level, so a creek runs at the harbour surface');
        }
        if (index.getX(3) !== 3 || index.getX(5) !== 5) {
          failures.push('the merge did not rebase the second sheet indices, so its triangles point at the first sheet');
        }
        if (!near(position.getX(3), 100) || !near(geometry.getAttribute('waterDepth').getX(3), 0.4)) {
          failures.push('the merge misplaced the second sheet vertices or their depths');
        }
      }
      geometry.dispose();
    }
  }

  // --- 2. The two tile lookups, against each other, in all four quadrants.
  const tileSize = 500;
  const flat = new Float32Array(9).fill(-71.075);
  const probes: Array<[number, number]> = [
    [10, -10],
    [-10, -10],
    [10, 10],
    [-10, 10],
    [1234, -2345],
    [-1234, 2345],
    [-0.5, 0.5],
    [499.9, -499.9],
  ];
  for (const [x, z] of probes) {
    const tx = Math.floor(x / tileSize);
    const tz = Math.floor(-z / tileSize);
    const key = `${tx}_${tz}`;
    // `TerrainField` answers `NO_GROUND` for a tile it does not hold and a real
    // height for one it does, so adopting exactly one key and probing turns its
    // private keying into something observable.
    const probe = new TerrainField(2, tileSize, '');
    probe.adopt(key, flat);
    if (!Number.isFinite(probe.height(x, z))) {
      failures.push(
        `TerrainField did not resolve (${x}, ${z}) to tile ${key}; the probe in ` +
          `water.verifyWater is wrong, or the tile keying has changed.`,
      );
      continue;
    }
    const one = WaterLevels.fromIndex([{ key, wy: -71.075 }], tileSize);
    if (!Number.isFinite(one.surfaceAt(x, z))) {
      failures.push(
        `WaterLevels put (${x}, ${z}) in a different tile from TerrainField, which holds ` +
          `${key}. The wading rule and the ground would disagree by up to a tile -- see ` +
          `world/wading.ts.`,
      );
    }
  }
  // And the negative: a table holding nothing must answer nothing, or the loop
  // above passes for a lookup that answers everything.
  if (Number.isFinite(new WaterLevels(tileSize).surfaceAt(0, 0))) {
    failures.push('An empty WaterLevels answered a query; the check above proves nothing.');
  }

  // --- 3. The wave field, evaluated on the CPU exactly as the graph does.
  let peak = 0;
  for (let i = 0; i < 512; i++) {
    const x = (i % 32) * 0.73;
    const z = Math.floor(i / 32) * 0.61;
    let dx = 0;
    let dz = 0;
    for (const [bearing, wavelength, amplitude, speed] of [...SWELL, ...CHOP]) {
      const a = (bearing * Math.PI) / 180;
      const k = (2 * Math.PI) / wavelength;
      const kx = Math.cos(a) * k;
      const kz = Math.sin(a) * k;
      const c = Math.cos(x * kx + z * kz + 3.7 * k * speed) * amplitude;
      dx += c * kx;
      dz += c * kz;
    }
    peak = Math.max(peak, Math.hypot(dx, dz));
  }
  const degrees = (Math.atan(peak) * 180) / Math.PI;
  if (degrees < 1.5 || degrees > 12) {
    failures.push(
      `The wave field tilts the surface by up to ${degrees.toFixed(1)} degrees, outside the ` +
        `1.5-12 degree window. Under it the harbour is a mirror and the Fresnel term never ` +
        `moves; over it the water reads as corrugated iron. Check the amplitudes in SWELL ` +
        `and CHOP -- they are slopes, and slope is 2*pi*A/L.`,
    );
  }

  return failures;
}
