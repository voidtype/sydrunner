/**
 * The four hero landmarks: the Harbour Bridge, the Opera House, Sydney Tower,
 * and Luna Park.
 *
 * Everything else in this client is *streamed*. A tile is fetched when it comes
 * near, evicted when it does not, and stood in for by a `far.bin` slab in
 * between. That is the right lifecycle for 33,651 buildings and it is the wrong
 * one for these four, for a reason that is not about draw calls:
 *
 *   **They are the skyline.** The bridge is read from Alexandria, the tower from
 *   every ridge in the extent, and the Opera House from the whole of the
 *   harbour. A landmark that streams is a landmark that pops out of the horizon
 *   as you walk away from it, which is the one thing about this city nobody
 *   would forgive.
 *
 *   Luna Park is the exception that proves it. Its face is nine metres across
 *   and is read from the wharf, not from Alexandria -- but it sits directly
 *   under the northern approach of the bridge, which is a place a player is
 *   *already* looking at a landmark from, and a park that faded in as you
 *   crossed would be worse there than anywhere else in the world.
 *
 * So `world/landmarks.glb` is a single file loaded once beside `far.bin`, added
 * to the scene, and never touched again. 29 k triangles for all four, which is
 * a sixth of what the far layer spends on the rest of the city.
 *
 * ---------------------------------------------------------------------------
 * Materials, and why there are ten rather than the twenty the tiles use.
 *
 * The pipeline gives the landmark set its own material namespace --
 * `landmarks.LANDMARK_MATERIALS`, not `mesh.MATERIALS` -- and names them in the
 * GLB, so this file looks them up **by name**. That is affordable here precisely
 * because there are ten: the tiles map by *index* because their material list is
 * baked into every primitive and into one byte per far slab, and a landmark file
 * has neither constraint.
 *
 * All ten are `MeshStandardNodeMaterial` on the one light rig in
 * `sky/calibration.ts`, and all ten cast and receive like a building does. Five
 * carry a procedural pattern and it is the same argument the facade grammar
 * makes: a flat colour on a 500 m arch, an 89 m pylon or 1.06 million roof tiles
 * is the thing that makes a model read as a model.
 *
 * The four **paint** slots are the exception, and deliberately so: they are flat
 * colour with nothing on them at all. A sideshow paint job is flat -- that is
 * what makes it read as paint over sheet metal rather than as a material -- and
 * the one thing that would ruin the Face is a procedural grain crawling over it.
 */

import {
  Fn,
  abs,
  dot,
  float,
  fract,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  vec2,
  vec3,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Group, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { fetchWorldBuffer } from './cdn.ts';

/**
 * The ten slots, in the pipeline's order. Order is not load-bearing -- the GLB
 * names its materials and this file resolves by name -- but it is checked
 * against `index.json` by `verifyLandmarks`, because a mismatch means the file
 * and the manifest came from different builds.
 */
export const LANDMARK_MATERIALS = [
  'landmark_steel',
  'landmark_granite',
  'landmark_shell',
  'landmark_glass',
  'landmark_gold',
  'landmark_asphalt',
  'landmark_paint_white',
  'landmark_paint_red',
  'landmark_paint_yellow',
  'landmark_paint_blue',
] as const;

/** What `index.json` carries about the landmark set. */
export interface LandmarkItem {
  name: string;
  anchor_enu: [number, number];
  anchor_world: [number, number, number];
  lat: number;
  lon: number;
  triangles: number;
  vertices: number;
  prisms: number;
  audit: Record<string, number>;
}

export interface LandmarkContract {
  version: number;
  file: string;
  materials: string[];
  sea_level_y: number;
  triangles: number;
  bytes?: number;
  items: LandmarkItem[];
  anchor_sources: Record<string, string>;
}

/**
 * One primitive of one landmark, kept so that something other than the renderer
 * can read it.
 *
 * The `owner` is recovered **before** reparenting -- see `loadLandmarks` -- and
 * without this list it is thrown away the moment the mesh is added to the group,
 * because after that every primitive's parent is the group and they all report
 * the same name. Nothing needed it until `world/bridgelights.ts` did: the
 * Harbour Bridge's night lighting is derived from the arch's own vertices rather
 * than from a baked sidecar, and `landmark_steel` under `harbour_bridge` is how
 * you ask for the arch.
 */
export interface LandmarkPart {
  /** The glTF node's name: `harbour_bridge`, `opera_house`, and so on. */
  owner: string;
  /** Which of `LANDMARK_MATERIALS` the primitive wears. */
  material: string;
  mesh: Mesh;
}

export interface LandmarkSet {
  /** The scene node, or null when there is no landmark set to load. */
  group: Group | null;
  /** Triangles resident, for the debug overlay. */
  triangles: number;
  /** Landmark node names actually built. */
  names: string[];
  /** Every primitive, by landmark and material. See `landmarkPositions`. */
  parts: LandmarkPart[];
}

const EMPTY: LandmarkSet = { group: null, triangles: 0, names: [], parts: [] };

/**
 * One landmark primitive's vertices, in **world** metres, or null when the set
 * has no such primitive.
 *
 * World rather than node-local because `loadLandmarks` bakes each node's
 * translation into its geometry -- the anchor is on the node above the mesh and
 * has to survive reparenting -- so by the time anything can call this, the
 * numbers are already where the bridge is. That matters to the one caller: a
 * lamp derived in node-local metres would be a lamp 1.8 km north of the bridge.
 *
 * Null rather than an empty array when the primitive is absent, so a caller has
 * to decide what an absent landmark means rather than quietly deriving nothing
 * from nothing.
 */
export function landmarkPositions(
  set: LandmarkSet,
  owner: string,
  material: string,
): Float32Array | null {
  for (const part of set.parts) {
    if (part.owner !== owner || part.material !== material) continue;
    const attribute = part.mesh.geometry.getAttribute('position');
    const array = attribute?.array;
    return array instanceof Float32Array ? array : null;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * The materials.
 * ------------------------------------------------------------------------ */

/**
 * "Harbour Grey", the bridge's own paint, and the greyest thing in this city
 * that is still not grey.
 *
 * The colour is warm rather than neutral on purpose: the bridge is repainted in
 * a lead-free grey with a green-brown cast, and against `calibration.ts`'s rig a
 * neutral value reads blue in shade -- the rig's hemisphere puts 1.6 parts blue
 * to one red on a shaded vertical surface, and the underside of the deck is the
 * largest shaded vertical surface in the world.
 */
const STEEL_TONE: [number, number, number] = [0.223, 0.229, 0.222];

/**
 * Trachyte, the Moruya granite the pylons and the approach piers are faced in.
 * Warm grey with a pink cast, and the same stone family as the CBD's sandstone
 * without its honey.
 */
const GRANITE_TONE: [number, number, number] = [0.365, 0.331, 0.290];

/** The two Opera House tiles: glazed white and matt cream. */
const TILE_GLOSS: [number, number, number] = [0.855, 0.845, 0.805];
const TILE_MATT: [number, number, number] = [0.735, 0.712, 0.640];

/** Gold anodised aluminium, the turret's cladding. */
const GOLD_TONE: [number, number, number] = [0.700, 0.478, 0.150];

/**
 * Luna Park's paint box: cream, and three primaries off it.
 *
 * Linear-space values, and they are quieter than the swatches a paint chart
 * would give for the same colours -- the rig in `sky/calibration.ts` puts a hard
 * sun on these surfaces, and a fully saturated red at 0.75 clips to a flat patch
 * the moment the sun is on it, which is the one thing that would make a painted
 * cutout read as an emissive decal.
 *
 * The cream is deliberately the same family as `TILE_GLOSS` above. The Opera
 * House and Luna Park are both off-white against Sydney sandstone, and having
 * them agree costs nothing and stops the harbour having two whites in it.
 */
const PAINT_WHITE: [number, number, number] = [0.845, 0.822, 0.760];
const PAINT_RED: [number, number, number] = [0.560, 0.082, 0.062];
const PAINT_YELLOW: [number, number, number] = [0.820, 0.575, 0.075];
const PAINT_BLUE: [number, number, number] = [0.075, 0.170, 0.520];

function createSteelMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_steel';
  material.colorNode = Fn(() => {
    // A vertical streak at a two-metre pitch: run-off staining down the chords
    // and the deck fascia, which is what fifty thousand tonnes of painted steel
    // over salt water actually looks like. Driven off world height so it is
    // continuous across the six tiles the deck crosses and does not restart at
    // a seam.
    const streak = fract(positionWorld.y.mul(0.5)).sub(0.5).abs().mul(0.09).add(0.955);
    // And the top surfaces a shade lighter, because they are the ones the sun
    // has bleached. `normalWorld.y` is exact on this geometry -- every face in
    // `landmarks.py` is emitted with its own computed normal -- so this is a
    // discriminator rather than a gradient.
    const facing = smoothstep(float(0.4), float(0.9), normalWorld.y).mul(0.07).add(1.0);
    return vec3(...STEEL_TONE).mul(streak).mul(facing);
  })();
  material.roughnessNode = float(0.58);
  material.metalnessNode = float(0.22);
  return material;
}

function createGraniteMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_granite';
  material.colorNode = Fn(() => {
    // The coursing, which is the whole reason this is not a flat colour. The
    // pylons are 89 m of dressed stone in courses about 1.1 m deep, and at that
    // pitch the course lines are what give the tower its scale from a kilometre
    // away -- without them a pylon is a smooth obelisk and reads as half its
    // height.
    const course = fract(positionWorld.y.div(1.12));
    const joint = smoothstep(float(0.0), float(0.045), course).mul(
      smoothstep(float(1.0), float(0.955), course),
    );
    const shade = joint.mul(0.16).add(0.84);
    // A coarse per-block variation across the course, so the stones are not
    // identical. Cheap: one fract on a diagonal of the horizontal position.
    const block = fract(
      dot(vec2(positionWorld.x, positionWorld.z), vec2(0.41, 0.29)).add(
        positionWorld.y.mul(0.9),
      ),
    )
      .sub(0.5)
      .mul(0.06)
      .add(1.0);
    return vec3(...GRANITE_TONE).mul(shade).mul(block);
  })();
  material.roughnessNode = float(0.86);
  material.metalnessNode = float(0.0);
  return material;
}

function createShellMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_shell';
  material.colorNode = Fn(() => {
    // THE CHEVRON, and it is the one procedural pattern in this file that is
    // not decoration.
    //
    // The Opera House roof is 1,056,006 tiles laid in a chevron: a glazed white
    // tile and a matt cream one, in V-shaped bands about a metre across, running
    // up each shell. That pattern is why the shells are never one value in a
    // photograph -- they self-shade at the scale of the tile lid and catch the
    // sun in stripes, and it is the difference between a white shell and a white
    // plastic shell.
    //
    // Approximated in world space rather than in the surface's own parameters,
    // and the approximation is honest about what it loses: the real chevrons
    // follow each rib, so they fan with the vault, where these run true. What it
    // keeps is the pitch and the two tones, which is what carries at any
    // distance a player will see this from.
    const v = positionWorld.y.mul(0.62);
    const u = abs(fract(positionWorld.x.mul(0.36)).sub(0.5)).mul(2.0);
    const band = fract(v.add(u.mul(0.55)));
    const tile = mix(vec3(...TILE_GLOSS), vec3(...TILE_MATT), step(float(0.5), band));
    // The lid joint: a fine dark line every band, which is the grout and the
    // reason the roof does not blow out to flat white under this rig's sun.
    const joint = smoothstep(float(0.0), float(0.06), band).mul(
      smoothstep(float(1.0), float(0.94), band),
    );
    return tile.mul(joint.mul(0.1).add(0.9));
  })();
  // Glazed ceramic over a matt one: low roughness so the sun leaves a hot band
  // on the shells, which spec 7.1's "blown highlights" is asking for and which
  // the shells are the single best surface in the world to deliver.
  material.roughnessNode = Fn(() => {
    const band = fract(positionWorld.y.mul(0.62));
    return mix(float(0.22), float(0.62), step(float(0.5), band));
  })();
  material.metalnessNode = float(0.0);
  return material;
}

function createGlassMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_glass';
  // Dark, and the darkness is the point: this slot is the glazed mouths under
  // the shells, the turret's observation band, and every shell's underside. All
  // three are surfaces a player sees *into shadow* through, and a light value
  // would make the Opera House's mouths read as white panels.
  material.colorNode = Fn(() => {
    // A mullion every 1.6 m across the glass walls. The mouths are the one place
    // a player gets close enough for the grid to matter, and it is what tells
    // you the wall is 20 m tall.
    const grid = max(
      smoothstep(float(0.0), float(0.035), fract(positionWorld.x.div(1.6))).oneMinus(),
      smoothstep(float(0.0), float(0.045), fract(positionWorld.y.div(2.4))).oneMinus(),
    );
    return mix(vec3(0.048, 0.058, 0.066), vec3(0.115, 0.112, 0.104), grid);
  })();
  material.roughnessNode = float(0.14);
  material.metalnessNode = float(0.28);
  return material;
}

function createGoldMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_gold';
  material.colorNode = Fn(() => {
    // The turret's horizontal banding: nine levels of anodised panels with a
    // shadow line between them. This is the only object in the world made of
    // this material, so the pattern can be specific to it -- a 2.6 m storey
    // pitch, which is the turret's own.
    const band = fract(positionWorld.y.div(2.6));
    const seam = smoothstep(float(0.0), float(0.06), band).mul(
      smoothstep(float(1.0), float(0.94), band),
    );
    return vec3(...GOLD_TONE).mul(seam.mul(0.2).add(0.8));
  })();
  // Anodised rather than polished: a broad specular lobe, which is what makes
  // the turret glow rather than mirror at 250 m.
  material.roughnessNode = float(0.34);
  material.metalnessNode = float(0.82);
  return material;
}

function createDeckMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'landmark_asphalt';
  material.colorNode = Fn(() => {
    // Sydney asphalt, the same family `street.ts` paints the city's roads in,
    // with a coarse aggregate mottle so 1.7 km of deck is not one value. The
    // pitch is deliberately large -- 3.4 m -- because this surface is only ever
    // seen either underfoot or at half a kilometre, and a fine noise at the
    // second distance is aliasing.
    const mottle = fract(
      dot(vec2(positionWorld.x, positionWorld.z), vec2(0.29, 0.19)),
    )
      .sub(0.5)
      .mul(0.07)
      .add(1.0);
    return vec3(0.052, 0.055, 0.058).mul(mottle);
  })();
  material.roughnessNode = float(0.9);
  material.metalnessNode = float(0.0);
  return material;
}

/**
 * One tin of paint, flat.
 *
 * No `colorNode` function, no pattern, no variation, and that is the decision
 * rather than the absence of one. Every other material in this file carries a
 * procedural term because it stands in for a surface with real texture at real
 * scale -- coursed stone, a million roof tiles, a mullion grid. Luna Park's
 * halls and its Face are painted sheet and rendered masonry, repainted every few
 * years, and the thing that makes them read as *paint* is that they are one
 * value from one side of the harbour to the other. A grain on the Face would
 * turn a nine-metre flat cutout into a nine-metre textured object, which is
 * exactly what it is not.
 *
 * 0.62 roughness and no metalness: enamel over steel, a broad soft highlight,
 * nothing mirror-like anywhere in a fairground.
 */
function createPaintMaterial(name: string, tone: [number, number, number]): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.colorNode = vec3(...tone);
  material.roughnessNode = float(0.62);
  material.metalnessNode = float(0.0);
  return material;
}

/** One instance of each, shared across every landmark. Built once, at load. */
export function createLandmarkMaterials(): Map<string, MeshStandardNodeMaterial> {
  return new Map<string, MeshStandardNodeMaterial>([
    ['landmark_steel', createSteelMaterial()],
    ['landmark_granite', createGraniteMaterial()],
    ['landmark_shell', createShellMaterial()],
    ['landmark_glass', createGlassMaterial()],
    ['landmark_gold', createGoldMaterial()],
    ['landmark_asphalt', createDeckMaterial()],
    ['landmark_paint_white', createPaintMaterial('landmark_paint_white', PAINT_WHITE)],
    ['landmark_paint_red', createPaintMaterial('landmark_paint_red', PAINT_RED)],
    ['landmark_paint_yellow', createPaintMaterial('landmark_paint_yellow', PAINT_YELLOW)],
    ['landmark_paint_blue', createPaintMaterial('landmark_paint_blue', PAINT_BLUE)],
  ]);
}

/* --------------------------------------------------------------------------
 * Loading.
 * ------------------------------------------------------------------------ */

/**
 * Fetch and build the landmark set, once, at startup.
 *
 * Failure is survivable at every step and lands in the same place: a client that
 * renders exactly what it rendered before this pass existed. No `landmarks`
 * block in the index, a 404, or a GLB that will not parse all return `EMPTY` --
 * which is not defensive habit but the same contract the far layer and the water
 * have, and for the same reason: the index and the world directory outlive any
 * one pipeline run, and a world built yesterday has to keep loading today.
 */
export async function loadLandmarks(
  baseUrl: string,
  contract: LandmarkContract | undefined,
  /** The build stamp, as a query suffix. See `world/version.ts`. */
  version = '',
): Promise<LandmarkSet> {
  if (!contract) return EMPTY;
  try {
    const loader = new GLTFLoader();
    // Bytes first, then parse: the release CDN serves this gzipped and
    // `loadAsync` would fetch it itself. Self-contained GLB, so no base path.
    const gltf = await loader.parseAsync(
      await fetchWorldBuffer(baseUrl, contract.file, version),
      '',
    );
    const materials = createLandmarkMaterials();

    const group = new Group();
    group.name = 'landmarks';
    const names: string[] = [];
    const parts: LandmarkPart[] = [];
    let triangles = 0;

    // Collected before reparenting: mutating the children array that `traverse`
    // is indexing walks it off the end. Same trap `streamer.loadTile` names.
    const meshes: Mesh[] = [];
    gltf.scene.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    for (const mesh of meshes) {
      // Which landmark this primitive belongs to, read **before** reparenting:
      // the glTF puts the mesh under a named node per landmark, and after
      // `group.add` its parent is this group and every primitive would report
      // the same name.
      const owner = (mesh.parent as { name?: string } | null)?.name;
      if (owner && !names.includes(owner)) names.push(owner);

      // The node's own translation is the landmark's anchor and must survive
      // reparenting: the GLB puts each landmark's vertices in metres about its
      // own centre so a 1.7 km bridge keeps millimetre resolution in float32,
      // and the anchor is on the node above the mesh. `updateWorldMatrix` then
      // `applyMatrix4` bakes it, so this group can be added to the scene at the
      // origin without carrying the glTF node hierarchy around.
      mesh.updateWorldMatrix(true, false);
      mesh.geometry.applyMatrix4(mesh.matrixWorld);
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.matrix.identity();
      mesh.matrixWorld.identity();

      const name = resolveMaterialName(mesh);
      // Recorded here, in the one place that still knows which landmark this
      // primitive came off. See `LandmarkPart`.
      if (owner) parts.push({ owner, material: name, mesh });
      mesh.material = materials.get(name) ?? materials.get('landmark_steel')!;
      // Cast and receive, like a building. The shadow system culls by distance
      // on its own -- `streamer.applyShadowRole` never sees these, because they
      // are not in any tile -- so what this costs is one depth-pass draw per
      // primitive while the landmark is inside the sun's 220 m volume, and
      // nothing at all outside it.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Never culled: the group is three objects and the bridge's own bounding
      // box is 1.7 km, so a per-object frustum test costs more than it saves and
      // gets the answer wrong at the edges of a box that large.
      mesh.frustumCulled = false;
      triangles += (mesh.geometry.getIndex()?.count ?? 0) / 3;
      group.add(mesh);
    }

    for (const item of contract.items) {
      if (!names.includes(item.name)) names.push(item.name);
    }
    return { group, triangles, names, parts };
  } catch (err) {
    console.warn('landmarks failed to load:', err);
    return EMPTY;
  }
}

/**
 * Which of the six slots a primitive wears.
 *
 * By name off the glTF material, with the mesh name as the fallback, because
 * the pipeline writes the name and nothing positional is promised across a
 * rebuild. An unknown name falls through to steel rather than throwing: a
 * primitive in the wrong grey is a defect, and a landmark that fails to load
 * over one is an outage.
 */
function resolveMaterialName(mesh: Mesh): string {
  const material = mesh.material as { name?: string } | Array<{ name?: string }>;
  const name = Array.isArray(material) ? material[0]?.name : material?.name;
  return typeof name === 'string' ? name : 'landmark_steel';
}

/* --------------------------------------------------------------------------
 * The self-check.
 * ------------------------------------------------------------------------ */

/**
 * Startup self-check, on `main.ts`'s criterion: the things this project gets
 * wrong are the ones that fail silently.
 *
 * Nothing here touches the network -- it is a check on the *contract*, run
 * before the fetch, and the three kinds of thing it guards all render:
 *
 *   - a material list that has drifted from the pipeline's, which paints the
 *     Opera House's shells in bridge steel and reads as a taste decision;
 *   - a landmark whose published height has been lost in the manifest, which is
 *     how a 309 m tower becomes a 30 m one with nothing in the frame to say so;
 *   - a sea level the manifest disagrees with the terrain about, which puts the
 *     bridge deck 70 m under the harbour or 70 m over it, and at 70 m over it
 *     the bridge still looks like a bridge.
 *
 * Returns a list of complaints, empty when correct. A world with no landmark
 * contract at all returns empty: that is a world built before this pass, not a
 * broken one.
 */
export function verifyLandmarks(
  contract: LandmarkContract | undefined,
  seaLevelY: number | undefined,
): string[] {
  const failures: string[] = [];
  if (!contract) return failures;

  const want = LANDMARK_MATERIALS.join(',');
  const got = (contract.materials ?? []).join(',');
  if (want !== got) {
    failures.push(
      `The landmark material list in index.json is [${got}] where this client ` +
        `expects [${want}]. The GLB names its materials and they are resolved by ` +
        `name, so a mismatch means the world and the client were built from ` +
        `different revisions -- every landmark primitive would fall through to steel.`,
    );
  }

  if (seaLevelY !== undefined && Math.abs(contract.sea_level_y - seaLevelY) > 0.01) {
    failures.push(
      `The landmark manifest puts sea level at y = ${contract.sea_level_y.toFixed(2)} ` +
        `where the terrain contract puts it at ${seaLevelY.toFixed(2)}. Every landmark ` +
        `height is measured from the datum, so the whole set is ` +
        `${Math.abs(contract.sea_level_y - seaLevelY).toFixed(1)} m out of the world it stands in.`,
    );
  }

  // The published dimensions, checked against the manifest rather than against
  // the geometry -- the geometry is `sydney landmark-audit`'s job and needs the
  // file. This catches a manifest that was written from a build where one of
  // them had been lost, which is silent in every frame.
  //
  // Luna Park's entry is the tower height rather than a height above the datum,
  // and that is the same point `landmarks.py` makes at length: the park's ground
  // in this world is a DEM cliff that is not there in Sydney, so its dimensions
  // are quoted above its own pad and an AHD assertion here would be asserting
  // the cliff.
  const expect: Array<[string, string, number, number]> = [
    ['harbour_bridge', 'arch_apex_ahd', 134.0, 0.05],
    ['harbour_bridge', 'deck_ahd', 49.0, 0.05],
    ['opera_house', 'shell_max_ahd', 67.0, 0.05],
    ['sydney_tower', 'height_m', 309.0, 0.05],
    ['luna_park', 'tower_height_m', 26.0, 0.05],
  ];
  for (const [name, key, target, tol] of expect) {
    const item = contract.items?.find((i) => i.name === name);
    if (!item) {
      failures.push(`The landmark manifest has no entry for ${name}.`);
      continue;
    }
    const value = item.audit?.[key];
    if (typeof value !== 'number' || Math.abs(value - target) / target > tol) {
      failures.push(
        `${name}.${key} is ${String(value)} in the manifest against a published ` +
          `${target}. Landmarks are built to real dimensions and this one is not.`,
      );
    }
  }
  return failures;
}
