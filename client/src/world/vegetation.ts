/**
 * Trees, and the grass they stand on.
 *
 * Spec section 7.5 says the quiet part out loud: **species matter more than
 * quality**, and *no oaks, no maples, no conifers -- they read American
 * instantly*. So nothing here is trying to be a good tree. Six silhouettes, each
 * unmistakable at fifty metres from its outline alone, at a triangle cost that
 * lets the city carry thirty thousand of them:
 *
 *   0 Moreton Bay fig   huge, multi-lobed, buttressed. Parks, and the odd giant
 *   1 plane             one dense round mass on a short pale trunk. The CBD
 *   2 jacaranda         low forking trunk, wide flat spreading crown
 *   3 paperbark         narrow, upright, near-white trunk showing its full height
 *   4 brush box         dense vertical oval. The default inner-suburb street tree
 *   5 eucalypt          a lean trunk you can see through two or three sparse lobes
 *   6 shrub             no trunk at all. Three low lumps. The heath layer
 *   7 bush tree         a stick and a lump. Nine trees in ten in a forest
 *
 * The seventh arrived with the bushland round and is the only one that is not a
 * tree. `pipeline/sydney/vegetation.py`'s header holds the argument at length;
 * the short of it is that heath and scrub are 33 km2 of the world, they are
 * what the Royal and the coastal clifftops actually are, and the two ways of
 * telling them without a shrub are both worse than the bare ground they
 * replace -- a 15 m eucalypt on a coastal heath is a lie about the landscape,
 * and a eucalypt scaled to 1.5 m is a doll's-house gum tree, which is the exact
 * distortion `vegetation-audit` exists to convict.
 *
 * It is also nearly the cheapest thing in the world file, at **24 triangles**
 * against the eucalypt's 100 and the fig's 162, and that is load-bearing rather
 * than incidental: the pipeline's per-tile bushland budget is spent in
 * triangles, and a heath is only affordable at 65 stems a hectare because each
 * of them is a quarter of a tree.
 *
 * The eighth is cheaper still, and it is the one that makes a forest possible at
 * all. `pipeline/sydney/vegetation.py`'s budget essay has the arithmetic and it
 * is one line long: a hundred canopy stems a hectare over a 25 ha tile is 2,500
 * stems, and 40,000 triangles over 2,500 stems is **16 triangles each**. Nothing
 * in the six above is within a factor of four of that, and no budget this frame
 * can carry makes them so. `BUSH_TREE` is 14 -- a three-sided trunk cone and one
 * octahedral crown -- and **nine stems in ten** in every bushland stand is drawn
 * with it, the tenth carrying whichever full silhouette the mix picked.
 *
 * That is a stochastic level of detail wearing a species slot, and it is not
 * pretending otherwise: the same stem draws cheap at four metres and at four
 * hundred, because the pipeline does not know where the camera will be and this
 * file has no distance tier. The impostor pass is what replaces it, behind the
 * seam named below, and when it lands `FOREST_MIX` collapses back to the four
 * real species.
 *
 * The jacaranda is **not flowering**. The world is set at 3 pm on 15 February and
 * jacarandas bloom in Sydney in late October and November; a purple one in
 * February is the same class of error as a northern-hemisphere sun.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and every display value beside it was
 * produced by running the shading chain documented at the top of
 * `sky/calibration.ts` -- irradiance, Lambert, exposure 0.62, Neutral tone
 * mapping, sRGB encode -- at the reference instant. The method is checked rather
 * than assumed: the same evaluation reproduces `street.ts`'s published footpath
 * (247,248,246), asphalt (131,137,148) and kerb (248,230,189) to within four
 * code values.
 *
 * The one rule the whole palette exists to enforce is that this is **February**.
 * Sydney foliage at the end of summer is olive, khaki and grey-green -- dusty,
 * desaturated, and closer to the dead grass underneath it than to anything that
 * would be called green in a nursery. Lush spring green is the fastest way to
 * make this city read as England, and it is the same mistake `ground.ts` names
 * about the dirt. So every foliage albedo here is green-dominant by only ~20
 * display values over red, and blue is pulled a long way down under both.
 *
 * ---------------------------------------------------------------------------
 * Cost, and the seam for the LOD that is not built yet.
 *
 * One geometry per species, built once for the whole game and shared by every
 * tile: 64-162 triangles and 48-122 vertices each, against the 300-triangle
 * ceiling this project set for a tree. One material, likewise shared. A tile's
 * trees are one `InstancedMesh` per species *present in that tile*, so a typical
 * inner-suburb tile is four draw calls for its ~157 trees.
 *
 * Measured at the spawn point, worst heading, using the streamer's own 1.8 km
 * load radius and frustum: 25 tiles visible, **5,519 trees, 483 k triangles and
 * 343 k vertices in 100 instanced draws**, against 232 k triangles of buildings
 * and streets in the same view. Nine tiles and 2,230 trees are inside the
 * shadow rig's 440 m casting range and are drawn a second time into the depth
 * map.
 *
 * That is a bigger number than this feature was scoped against, and the reason
 * is worth recording: the estimate assumed 2-4 k procedural street trees, and
 * the inner ring turns out to carry **33,467** -- because ~12,000 of them are
 * surveyed OSM nodes rather than anything this code invented, and the Domain and
 * the Botanic Gardens are mapped tree by tree. Nothing here is over-drawing; the
 * city is simply that leafy.
 *
 * What is deliberately missing is therefore the impostor. Spec 7.5 wants
 * billboards beyond 150 m and the measurement above is what now justifies them.
 * The seam is `VegetationAssets.geometry()` and `buildTileTrees`: the first is
 * the only place a species becomes a mesh, and the second is the only place
 * instances are bucketed. An impostor pass splits the bucket by distance and
 * asks the first for a second, flatter geometry. Nothing else in this file, and
 * nothing at all in `streamer.ts`, needs to know.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  dot,
  float,
  floor,
  fract,
  instanceIndex,
  mix,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  time,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

import { SPECIES_COUNT, decodeVegetation, type TileVegetation } from './tile-decode.ts';

/**
 * The sidecar half of this module lives in `world/tile-decode.ts`.
 *
 * Not a refactor for tidiness: that file has no `three` import in it, which is
 * what lets `world/decode.worker.ts` read a `.veg.bin` on a thread that is not
 * the render thread. Re-exported from here so every existing caller keeps
 * naming the module that owns what a tree *is*, which is this one.
 */
export { SPECIES_COUNT, decodeVegetation };
export type { TileVegetation };

const FIG = 0;
const PLANE = 1;
const JACARANDA = 2;
const PAPERBARK = 3;
const BRUSH_BOX = 4;
const EUCALYPT = 5;
const SHRUB = 6;
const BUSH_TREE = 7;

// --- The palette --------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Foliage albedo per species, linear.
 *
 * The display figures are for a canopy facet with the sun square on it and then
 * at the two angles most of a lobe actually presents. A canopy is a sphere, so
 * the middle row is what the eye reads as "the colour of the tree" and the first
 * is only its brightest facet.
 */
const FOLIAGE: Record<number, Rgb> = {
  // Darkest and deepest of the six -- a mature fig's canopy is close to black-
  // green in shade and never bright even in full sun. rho 0.062.
  //            N.L 1.0 rgb( 99, 124,  76)   0.8 rgb( 87, 111,  65)   0.55 rgb( 67, 90, 46)
  [FIG]: [0.048, 0.068, 0.03],
  // Plane leaves are big, thin and dusty by February, so this is the lightest
  // and the yellowest of the broadleaves. rho 0.084.
  //            N.L 1.0 rgb(124, 145,  93)   0.8 rgb(110, 130,  81)   0.55 rgb( 89, 107, 62)
  [PLANE]: [0.07, 0.09, 0.04],
  // Bipinnate and airy, so a touch more light gets through and back out. Plain
  // green: see the note about October above. rho 0.082.
  //            N.L 1.0 rgb(122, 143,  96)   0.8 rgb(108, 128,  84)   0.55 rgb( 87, 106, 65)
  [JACARANDA]: [0.068, 0.088, 0.042],
  // Greyer and bluer than the broadleaves -- melaleuca foliage is fine, hard and
  // slightly glaucous. rho 0.074.
  //            N.L 1.0 rgb(116, 134, 102)   0.8 rgb(102, 120,  90)   0.55 rgb( 82,  98, 70)
  [PAPERBARK]: [0.062, 0.078, 0.046],
  // Dense and dark; brush box holds its colour better than anything else on a
  // Sydney street, which is why the councils plant it. rho 0.069.
  //            N.L 1.0 rgb(108, 132,  82)   0.8 rgb( 95, 118,  70)   0.55 rgb( 75,  97, 51)
  [BRUSH_BOX]: [0.055, 0.076, 0.033],
  // The greyest, and the one that carries the whole "not England" argument:
  // eucalypt foliage is barely green at all -- 12 display values of green over
  // red and 20 over blue. It should look dusty and half-dead, because it is.
  // rho 0.079.
  //            N.L 1.0 rgb(126, 138, 113)   0.8 rgb(112, 123, 101)   0.55 rgb( 91, 101, 80)
  [EUCALYPT]: [0.072, 0.082, 0.055],
  // Sydney's sandstone shrub layer -- banksia, hakea, tea-tree, the pea
  // flowers -- is darker, harder and greyer than any canopy above it, because
  // it is small hard leaves held edge-on to a lot of sun. Darkest of the seven
  // on purpose: a heath seen across a headland reads as a dark olive mat with
  // the pale rock showing through it, and anything lighter turns the Royal into
  // a lawn. rho 0.058.
  //            N.L 1.0 rgb( 97, 111,  86)   0.8 rgb( 85,  99,  75)   0.55 rgb( 68,  80, 58)
  [SHRUB]: [0.048, 0.058, 0.036],
  // The same albedo as `EUCALYPT`, and it has to be: `BUSH_TREE` is a eucalypt
  // drawn cheap, standing in the same stand as the full-detail ones, and a
  // forest where nine trees in ten are a different green is a forest with a
  // level-of-detail seam painted across it.
  [BUSH_TREE]: [0.072, 0.082, 0.055],
};

/**
 * Bark albedo per species, linear. Display figures are for a trunk in sun --
 * a vertical cylinder takes `cos(57 deg)` of the beam on its lit side, which is
 * the `N.L 0.55` column above.
 */
const BARK: Record<number, Rgb> = {
  // Grey, smooth, enormous.                          -> rgb(144, 140, 130)
  [FIG]: [0.16, 0.145, 0.12],
  // Plane bark is the mottled cream-and-olive patchwork that gives the species
  // away from a block off, and it is much paler than any other trunk here.
  //                                                  -> rgb(197, 198, 182)
  [PLANE]: [0.3, 0.29, 0.23],
  // Light grey-brown.                                -> rgb(154, 145, 132)
  [JACARANDA]: [0.18, 0.155, 0.12],
  // The point of the species. Paperbark is near-white cream and it is the
  // brightest vertical surface at eye level in any park.
  //                                                  -> rgb(215, 211, 195)
  [PAPERBARK]: [0.34, 0.315, 0.255],
  // Warm red-brown, flaking.                         -> rgb(134, 114,  95)
  [BRUSH_BOX]: [0.14, 0.1, 0.07],
  // Pale grey and smooth -- a smooth-barked gum's trunk is nearly as bright as
  // a paperbark's and is meant to read *through* the sparse canopy above it.
  //                                                  -> rgb(196, 195, 184)
  [EUCALYPT]: [0.3, 0.29, 0.26],
  // A shrub has no trunk in this geometry, so this is read only by the tone
  // jitter and never by a face. Kept at the foliage value rather than left
  // undefined, because `BARK[species]` is indexed unconditionally in
  // `buildSpecies` and an undefined here is three NaN colours and a black mesh.
  [SHRUB]: [0.048, 0.058, 0.036],
  // Pale grey gum bark, `EUCALYPT`'s exactly -- see the foliage note.
  [BUSH_TREE]: [0.3, 0.29, 0.26],
};

/**
 * Park and verge grass, sunlit and horizontal.
 *
 * Two tones mixed by noise, on `ground.ts`'s argument: one flat value does not
 * read as a surface, and three fight over the top of the histogram. The brief is
 * narrow and worth stating as a range rather than a colour -- *clearly greener
 * than the dirt, nowhere near a golf course*. February parks are patchy
 * straw-green: the mown parts hold some colour, the worn parts are burnt off.
 *
 * The dirt in `ground.ts` renders at rgb(194, 176, 144) and rgb(172, 155, 109),
 * both **red over green**. Both tones here are **green at or over red**, which
 * is a hue flip rather than a tint and is what makes a park boundary visible
 * from a distance without the park being bright.
 */
//                                                     -> sun rgb(168, 169, 121)
const GRASS_STRAW = /*#__PURE__*/ vec3(0.145, 0.14, 0.07);
//                                                     -> sun rgb(137, 151,  97)
const GRASS_GREEN = /*#__PURE__*/ vec3(0.098, 0.112, 0.048);

/**
 * Bushland floor, sunlit and horizontal. The `bush_floor` slot.
 *
 * The brief for `park_grass` above was *clearly greener than the dirt, nowhere
 * near a golf course*. This one is narrower and points the other way: **darker
 * than both the dirt and the grass, and greyer than either.** A Sydney
 * sandstone bushland floor is bark litter, dead sticks, coarse orange-grey
 * sandstone grit and a broken layer of hard low sedge, and half of it is in the
 * shade of whatever is standing on it. It is the darkest ground surface in the
 * world file and it should be -- it is what makes a stand of forest read as a
 * mass rather than as trees standing on a lawn.
 *
 * Two tones on the same argument every other ground surface in this project
 * makes, and the same measured relation to their neighbours. `ground.ts`'s dirt
 * renders at rgb(194, 176, 144) and rgb(172, 155, 109); the grass above at
 * rgb(168, 169, 121) and rgb(137, 151, 97). Both of these sit **under** all
 * four, and the pair straddles the hue line rather than sitting on one side of
 * it -- litter is red over green like the dirt, understorey is green over red
 * like the grass -- so a bush floor is not a darker version of either but its
 * own thing between them.
 */
//                                                     -> sun rgb(142, 138, 116)
const BUSH_LITTER = /*#__PURE__*/ vec3(0.106, 0.1, 0.072);
//                                                     -> sun rgb(112, 120,  92)
const BUSH_UNDER = /*#__PURE__*/ vec3(0.067, 0.077, 0.042);

/**
 * Estuarine mud and saltmarsh, sunlit and horizontal. The `wetland_mud` slot.
 *
 * The one green polygon in Sydney that is not a vegetation colour. Badu at
 * Homebush, the Lane Cove and Georges River reaches, Bicentennial Park: grey
 * mangrove standing in grey-brown tidal mud, with saltmarsh and samphire on the
 * landward side of it in a slightly paler olive. Painted as bush floor it would
 * be dry leaf litter on a tidal flat, which is a worse answer than the bare
 * dirt this round is replacing, and that is the whole reason it is a second
 * slot instead of a third tone on the first.
 *
 * Where the tide is actually over the mud nothing here is seen at all: the
 * water sheet sits at its own surface height and wins the depth test, exactly
 * the way the carriageway wins over the grass. So this is the low-tide flat and
 * the bank above it, which is what it is most of the time and all of the time
 * in a world fixed at 3 pm.
 */
//                                                     -> sun rgb(118, 110,  98)
const MUD_WET = /*#__PURE__*/ vec3(0.075, 0.065, 0.049);
//                                                     -> sun rgb(132, 134, 112)
const MUD_MARSH = /*#__PURE__*/ vec3(0.093, 0.095, 0.067);

// --- Geometry -----------------------------------------------------------------

/**
 * Nominal size each species is authored at, metres: (height, canopy radius).
 *
 * An instance is scaled `(r / nominalRadius, h / nominalHeight, r / nominalRadius)`
 * from these, which means the trunk thickens and thins with the canopy rather
 * than staying constant. That is deliberate and it is also true: a wider tree of
 * the same species is an older tree with a thicker trunk. The draw in the
 * pipeline correlates height with spread, so the two scale factors stay within
 * about 20% of each other and the distortion never reads as a distortion.
 */
const NOMINAL: Record<number, [number, number]> = {
  [FIG]: [18.5, 11.5],
  [PLANE]: [12.0, 5.0],
  [JACARANDA]: [10.0, 5.0],
  [PAPERBARK]: [11.0, 2.6],
  [BRUSH_BOX]: [12.5, 4.0],
  [EUCALYPT]: [16.0, 5.5],
};

/** Unit icosahedron: 12 vertices, 20 faces. One lobe, before displacement. */
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS: Array<[number, number, number]> = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_FACES: Array<[number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * Deterministic hash. Author-time only -- this runs once at startup over a few
 * hundred vertices, so it is written for clarity rather than for speed.
 */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * Accumulates indexed triangles with a colour per vertex.
 *
 * **Indexed, and the faceting comes from `material.flatShading` instead**, which
 * is the single decision in this file with a measured frame cost behind it. The
 * obvious construction for a low-poly tree is non-indexed geometry with a baked
 * per-face normal, and it was built that way first. It triples the vertex count,
 * because no vertex can be shared: a 20-face icosahedral lobe becomes 60
 * vertices instead of 12, and a six-sided trunk 36 instead of 12.
 *
 * That multiplier lands on the one axis this feature is expensive on. The spawn
 * view carries ~5,500 trees, so the difference is 1.45 M vertices a frame
 * against 337 k -- 4.2x -- for exactly the same 483 k triangles and exactly the
 * same look, since three derives the flat normal from screen-space derivatives
 * of the view position and gets a *better* answer than a baked one does under
 * the non-uniform instance scale below.
 *
 * Normals are still written, and are the smooth radial ones. They are unread
 * while `flatShading` is on; they are here so that turning it off degrades to a
 * smooth tree rather than to a black one, because `isFlatShading()` is also true
 * whenever the normal attribute is simply missing.
 */
class MeshBuilder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];

  /** Push a run of vertices, returning the index of the first. */
  vertices(
    points: Array<readonly [number, number, number]>,
    normals: Array<readonly [number, number, number]>,
    colours: Rgb[],
  ): number {
    const base = this.position.length / 3;
    for (let i = 0; i < points.length; i++) {
      this.position.push(points[i][0], points[i][1], points[i][2]);
      const n = normals[i];
      const l = Math.hypot(n[0], n[1], n[2]);
      // A degenerate normal becomes up rather than NaN. A NaN would poison the
      // bounding sphere and cull the whole tree.
      if (l < 1e-9) this.normal.push(0, 1, 0);
      else this.normal.push(n[0] / l, n[1] / l, n[2] / l);
      this.color.push(colours[i][0], colours[i][1], colours[i][2]);
    }
    return base;
  }

  face(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    // 16-bit indices: no species comes near 65,536 vertices and the largest is
    // 122, so this halves the index buffer for free.
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    g.computeBoundingSphere();
    return g;
  }
}

function tint(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * A tapered cylinder between two arbitrary points, open at both ends.
 *
 * One helper covers the trunk, the lean, the fig's buttressed base and every
 * limb, because they are all the same shape at different aspect ratios. Caps are
 * never emitted: the bottom is in the ground and the top is inside a canopy
 * lobe, so both would be `sides` triangles of nothing.
 */
function cone(
  m: MeshBuilder,
  from: [number, number, number],
  to: [number, number, number],
  r0: number,
  r1: number,
  sides: number,
  colour: Rgb,
  seed: number,
): void {
  const ax = to[0] - from[0], ay = to[1] - from[1], az = to[2] - from[2];
  const len = Math.hypot(ax, ay, az) || 1;
  const dx = ax / len, dy = ay / len, dz = az / len;
  // Two orthogonal vectors across the axis, to lay the ring out in. The
  // reference vector must not be parallel to the axis or the cross product
  // collapses, so it switches between world X and world Y depending on which way
  // this piece runs: a trunk is near-vertical, a limb is near-horizontal, and
  // one fixed reference cannot serve both.
  const vertical = Math.abs(dy) > 0.9;
  // cross(ref, d) with ref = (1,0,0) or (0,1,0), written out.
  let ux = vertical ? 0 : dz;
  let uy = vertical ? -dz : 0;
  let uz = vertical ? dy : -dx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;

  const points: Array<[number, number, number]> = [];
  const normals: Array<[number, number, number]> = [];
  const colours: Rgb[] = [];
  for (const [o, r, wobbleSeed] of [
    [from, r0, seed],
    [to, r1, seed + 977],
  ] as Array<[[number, number, number], number, number]>) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      // A few per cent of per-side wobble so a six-sided trunk is not a perfect
      // hexagon -- at 40 cm across that is the whole difference between bark and
      // a prop.
      const rr = r * (0.93 + 0.14 * hash(wobbleSeed, i));
      const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
      points.push([
        o[0] + ux * cx + vx * cz,
        o[1] + uy * cx + vy * cz,
        o[2] + uz * cx + vz * cz,
      ]);
      // Radial, which is the cylinder's smooth normal.
      normals.push([
        ux * Math.cos(a) + vx * Math.sin(a),
        uy * Math.cos(a) + vy * Math.sin(a),
        uz * Math.cos(a) + vz * Math.sin(a),
      ]);
      // Tonal variation per ring vertex rather than per face -- it interpolates
      // around the trunk instead of banding it, which is what bark does.
      colours.push(tint(colour, 0.92 + 0.16 * hash(seed, i, 3)));
    }
  }

  const base = m.vertices(points, normals, colours);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    m.face(base + i, base + j, base + sides + j);
    m.face(base + i, base + sides + j, base + sides + i);
  }
}

/**
 * One canopy lobe: an icosahedron with every vertex pushed in or out a little,
 * scaled to an ellipsoid and placed.
 *
 * The displacement is what stops five lobes on a fig reading as five identical
 * balls. It is applied before the ellipsoid scale so it is proportional rather
 * than absolute -- a small lobe gets a small wobble.
 */
function lobe(
  m: MeshBuilder,
  centre: [number, number, number],
  radii: [number, number, number],
  colour: Rgb,
  seed: number,
): void {
  const points: Array<[number, number, number]> = [];
  const normals: Array<[number, number, number]> = [];
  const colours: Rgb[] = [];
  for (let i = 0; i < ICO_VERTS.length; i++) {
    const [x, y, z] = ICO_VERTS[i];
    const l = Math.hypot(x, y, z);
    const ux = x / l, uy = y / l, uz = z / l;
    const d = 0.86 + 0.28 * hash(seed, i);
    points.push([
      centre[0] + ux * radii[0] * d,
      centre[1] + uy * radii[1] * d,
      centre[2] + uz * radii[2] * d,
    ]);
    // Radial. The ellipsoid's true normal is the radial one divided by the
    // squared radii, and it is not worth computing: `flatShading` replaces this
    // anyway, and if it is ever switched off the difference on a lobe whose
    // radii are within a factor of two is a couple of degrees.
    normals.push([ux, uy, uz]);
    // Per-vertex rather than per-face -- with 12 vertices carrying 20 faces the
    // variation now interpolates across the lobe instead of tiling it, which is
    // closer to the way light actually falls through a canopy.
    colours.push(tint(colour, 0.9 + 0.2 * hash(seed, i, 7)));
  }
  const base = m.vertices(points, normals, colours);
  for (const [a, b, c] of ICO_FACES) m.face(base + a, base + b, base + c);
}

/**
 * The cheap lobe: an octahedron, 8 faces and 6 vertices against `lobe`'s 20 and
 * 12.
 *
 * Only the shrub uses it, and the reason it is worth a second primitive rather
 * than a smaller `lobe` is arithmetic. A shrub built from three icosahedral
 * lobes is 60 triangles; from three of these it is 24, and the pipeline's
 * bushland budget is spent in triangles, so that ratio is directly the stem
 * count a heath tile gets. 2.5x the heath for a polyhedron with six fewer
 * vertices in it.
 *
 * At 1.5 m across and under `flatShading` the difference between the two is
 * not a shape anybody can name: the same +/-14% per-vertex displacement is
 * applied, so this is a lumpy irregular blob rather than a diamond, and a heath
 * is a field of lumpy irregular blobs.
 */
const OCT_VERTS: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const OCT_FACES: Array<[number, number, number]> = [
  [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
  [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
];

function blob(
  m: MeshBuilder,
  centre: [number, number, number],
  radii: [number, number, number],
  colour: Rgb,
  seed: number,
): void {
  const points: Array<[number, number, number]> = [];
  const normals: Array<[number, number, number]> = [];
  const colours: Rgb[] = [];
  for (let i = 0; i < OCT_VERTS.length; i++) {
    const [ux, uy, uz] = OCT_VERTS[i];
    const d = 0.86 + 0.28 * hash(seed, i);
    points.push([
      centre[0] + ux * radii[0] * d,
      centre[1] + uy * radii[1] * d,
      centre[2] + uz * radii[2] * d,
    ]);
    normals.push([ux, uy, uz]);
    colours.push(tint(colour, 0.9 + 0.2 * hash(seed, i, 7)));
  }
  const base = m.vertices(points, normals, colours);
  for (const [a, b, c] of OCT_FACES) m.face(base + a, base + b, base + c);
}

/** Build the shared geometry for one species, at its nominal size. */
function buildSpecies(species: number): BufferGeometry {
  const m = new MeshBuilder();
  const leaf = FOLIAGE[species];
  const bark = BARK[species];

  switch (species) {
    case FIG: {
      // Two trunk segments: a short, very wide flare that suggests buttress
      // roots without modelling them, then the barrel above it. Eight-sided,
      // because at 4.4 m across a hexagon reads as a hexagon.
      cone(m, [0, 0, 0], [0, 3.0, 0], 2.2, 1.3, 8, bark, 11);
      cone(m, [0, 3.0, 0], [0, 6.5, 0], 1.3, 1.0, 8, bark, 12);
      // Three limbs out to the outer lobes. A fig's spread is carried on limbs
      // as thick as most trees' trunks, and seeing them is most of the species.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        cone(
          m, [0, 6.0, 0],
          [Math.cos(a) * 5.4, 10.4, Math.sin(a) * 5.4],
          0.62, 0.3, 5, bark, 20 + i,
        );
      }
      lobe(m, [0, 12.6, 0], [7.2, 4.6, 7.2], leaf, 30);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.7;
        lobe(
          m,
          [Math.cos(a) * 5.8, 10.6 + hash(40, i) * 2.4, Math.sin(a) * 5.8],
          [5.7, 3.7, 5.7],
          leaf,
          40 + i,
        );
      }
      break;
    }
    case PLANE: {
      cone(m, [0, 0, 0], [0, 4.2, 0], 0.44, 0.34, 6, bark, 51);
      // One dominant mass plus two smaller ones cut into it: a plane's crown is
      // pruned to a ball and that is exactly how it reads down a CBD street.
      lobe(m, [0, 8.3, 0], [4.6, 3.9, 4.6], leaf, 52);
      lobe(m, [2.1, 7.0, -1.5], [3.0, 2.6, 3.0], leaf, 53);
      lobe(m, [-1.9, 9.2, 1.4], [2.8, 2.4, 2.8], leaf, 54);
      break;
    }
    case JACARANDA: {
      // Short trunk that forks low, which is the giveaway of the species even
      // out of flower.
      cone(m, [0, 0, 0], [0, 2.6, 0], 0.36, 0.28, 6, bark, 61);
      cone(m, [0, 2.4, 0], [1.7, 5.4, 0.6], 0.22, 0.15, 4, bark, 62);
      cone(m, [0, 2.4, 0], [-1.5, 5.0, -0.9], 0.2, 0.14, 4, bark, 63);
      // Wide and flat -- a jacaranda is broader than it is tall and the crown is
      // a plate, not a ball.
      lobe(m, [0, 7.5, 0], [4.2, 2.3, 4.2], leaf, 64);
      lobe(m, [2.4, 6.6, -1.3], [2.9, 1.9, 2.9], leaf, 65);
      lobe(m, [-2.2, 6.9, 1.6], [2.9, 1.9, 2.9], leaf, 66);
      break;
    }
    case PAPERBARK: {
      // The trunk is half the tree's height and is meant to be seen for all of
      // it. Two segments so it can taper visibly over that run.
      cone(m, [0, 0, 0], [0, 3.0, 0], 0.32, 0.28, 6, bark, 71);
      cone(m, [0, 3.0, 0], [0.15, 5.6, 0.1], 0.28, 0.22, 6, bark, 72);
      lobe(m, [0, 8.0, 0], [2.3, 2.7, 2.3], leaf, 73);
      lobe(m, [0.3, 10.1, -0.2], [1.7, 1.7, 1.7], leaf, 74);
      break;
    }
    case BRUSH_BOX: {
      cone(m, [0, 0, 0], [0, 4.0, 0], 0.4, 0.3, 6, bark, 81);
      // A vertical oval, densest in the middle: the shape a council pruner
      // leaves after forty years under the wires.
      lobe(m, [0, 8.4, 0], [3.6, 4.0, 3.6], leaf, 82);
      lobe(m, [0.9, 6.5, 0.5], [2.6, 2.2, 2.6], leaf, 83);
      lobe(m, [-0.6, 10.7, -0.5], [2.4, 2.0, 2.4], leaf, 84);
      break;
    }
    case BUSH_TREE: {
      // Authored at the midpoint of `SPECIES_SIZE[BUSH_TREE]`, which is
      // `EUCALYPT`'s: 16 m tall, 11 m across, nominal radius 5.5. The instance
      // scales therefore land near 1.0 on the same curve the full-detail gums
      // draw from, which is what lets the two stand in one stand without a
      // visible size step between them.
      //
      // **Fourteen triangles**: a three-sided trunk and one octahedral crown.
      // Three sides is the fewest a cone can have, and on a 0.4 m trunk seen
      // from thirty metres it is a stick -- which is what a gum trunk is at
      // thirty metres, and the species' own note above says the trunk is half of
      // what makes it a gum. The crown is one blob rather than the eucalypt's
      // three, so the sky-through-the-canopy read is lost; that is the thing
      // being traded, it is bought back by the one stem in ten that is not this,
      // and it is why this is a stand-in for a distance tier rather than a
      // species anybody chose.
      cone(m, [0, 0, 0], [0.4, 9.2, 0.15], 0.42, 0.26, 3, bark, 111);
      blob(m, [0.5, 13.0, 0.2], [5.5, 3.4, 5.5], leaf, 112);
      break;
    }
    case SHRUB: {
      // Authored at the midpoint of `SPECIES_SIZE[SHRUB]` like every other
      // species: 1.85 m tall, 2.15 m across, so the nominal radius is 1.075 and
      // the instance scales land near 1.0.
      //
      // Three lumps and no trunk, sitting on the ground rather than over it.
      // The lowest is the widest, which is what a wind-pruned sandstone shrub
      // does -- it splays at the base and thins upward -- and the two above it
      // are offset so the silhouette is asymmetric from every bearing. Nothing
      // here is trying to be a species; it is trying to be *a shrub*, seen a
      // thousand at a time across a headland.
      // Authored at the midpoint of `SPECIES_SIZE[SHRUB]`: 1.8 m tall, 2.2 m
      // across, nominal radius 1.1. That row is deliberately *proportional*
      // (0.9:2.7 and 1.1:3.3 are both 1:3) so the two instance scale factors
      // come out equal at every point of the size curve -- see the pipeline's
      // note on it, and on why a shrub needs that where a tree does not.
      blob(m, [0, 0.54, 0], [1.04, 0.58, 1.04], leaf, 101);
      blob(m, [0.35, 1.12, -0.22], [0.73, 0.54, 0.73], leaf, 102);
      blob(m, [-0.31, 1.38, 0.27], [0.61, 0.44, 0.61], leaf, 103);
      break;
    }
    default: {
      // Eucalypt. The lean and the gap are the species: a bare trunk to more
      // than half the height, then two or three small open lobes with sky
      // between them. Anything denser is not a gum.
      cone(m, [0, 0, 0], [0.5, 4.5, 0.2], 0.46, 0.34, 6, bark, 91);
      cone(m, [0.5, 4.5, 0.2], [0.95, 9.0, 0.45], 0.34, 0.24, 6, bark, 92);
      cone(m, [0.95, 9.0, 0.45], [2.4, 12.0, 0.8], 0.2, 0.12, 4, bark, 93);
      cone(m, [0.95, 9.0, 0.45], [-1.6, 12.6, -1.2], 0.19, 0.11, 4, bark, 94);
      lobe(m, [2.6, 12.7, 0.8], [2.9, 2.2, 2.9], leaf, 95);
      lobe(m, [-2.0, 13.4, -1.4], [2.6, 2.0, 2.6], leaf, 96);
      lobe(m, [0.5, 14.7, 1.3], [2.4, 1.9, 2.4], leaf, 97);
      break;
    }
  }
  return m.build(`tree_${species}`);
}

// --- Wind ---------------------------------------------------------------------

/**
 * Peak lateral excursion at the top of a canopy, metres. February sea breeze.
 *
 * The two terms below sum to a peak of 0.054 m on x and 0.030 on z, so 0.062 m
 * of travel at the crown of an 18 m fig -- about a third of a per cent of its
 * own radius. That is the number this whole feature has to keep small. At twice
 * it the canopies read as underwater; at half it, at the distances trees are
 * actually seen, nothing moves at all.
 */
const SWAY_LONG = 0.04;
const SWAY_GUST = 0.014;
const SWAY_CROSS = 0.03;

/**
 * Foliage sway, and the reason it is here at all after the vegetation pass
 * deliberately left it out.
 *
 * The objection was a real one: a vertex offset applied only in the *main* pass
 * moves the leaves and not the shadow they cast, so every canopy shadow in the
 * city detaches and slides against the tree that owns it -- which is far worse
 * than no wind. That is what a hand-written depth material does, and it is what
 * three's WebGL path did for years. It is **not** what three r185's WebGPU path
 * does, and the source says so in three places:
 *
 *   - The shadow pass renders the ordinary scene with `scene.overrideMaterial`
 *     set to a shared, bare `NodeMaterial` (`nodes/lighting/ShadowNode.js`, and
 *     `getShadowMaterial` in `ShadowFilterNode.js`). That material has no
 *     `positionNode` of its own, which is where the fear comes from.
 *   - `Renderer.renderObject` copies it across per draw before the object is
 *     submitted -- `if (material.positionNode && material.positionNode.isNode)
 *     overrideMaterial.positionNode = material.positionNode` -- and restores the
 *     previous value afterwards.
 *   - `Renderer._getShadowNodes` then states the contract outright: it takes
 *     `material.castShadowPositionNode` **if it exists, and falls back to
 *     `material.positionNode` if it does not**. The existence of a dedicated
 *     override for the shadow pass is itself the proof that the ordinary
 *     `positionNode` is what the depth pass uses by default.
 *
 * Two follow-up hazards were checked rather than assumed, because both would
 * have produced exactly the same detached-shadow symptom by a different route:
 *
 *   - **Shader cache collisions.** The override material is one object shared by
 *     every caster in the scene, and its `positionNode` is mutated per draw. If
 *     the render object's cache key ignored it, the trees and the buildings
 *     would share a shadow shader and one of them would be wrong.
 *     `RenderObject.getMaterialCacheKey` enumerates the material's own
 *     properties and folds object-valued ones in, so a set `positionNode`
 *     hashes differently from a null one; and for an `InstancedMesh` the
 *     object's uuid goes into the key as well.
 *   - **Time skew between the passes.** `time` is
 *     `uniform(0).onRenderUpdate(frame => frame.time)`, and `NodeFrame.update()`
 *     is called exactly once per animation frame, from `common/Animation.js`.
 *     The shadow map is a nested `renderer.render()` inside that same frame, so
 *     both passes sample the identical value. A leaf and its shadow cannot be a
 *     frame out of phase.
 *
 * ---------------------------------------------------------------------------
 * What the offset is, and the one subtlety in reading a height from it.
 *
 * The gate has to be the *object-local* height -- zero at the trunk base, so
 * the tree is pinned to the ground -- and `positionLocal` is not that.
 * `NodeMaterial.setupPosition` applies the instance matrix to `positionLocal`
 * **before** a `positionNode` is evaluated (`accessors/Instance.js` assigns
 * `instanceMatrix * positionLocal` straight back into it), so by the time this
 * function runs its y is the vertex's height above the *tile* origin, terrain
 * and instance scale included. `positionGeometry` is the untouched attribute
 * and is what the gate reads.
 *
 * The same fact is why the offset below is in plain metres: `positionLocal` at
 * this point is already in tile-local space, and a tile's group carries no
 * rotation or scale, so adding 6 cm here is 6 cm in the world regardless of how
 * large the tree was scaled to.
 *
 * The gate is `smoothstep(4, 10, y)` squared. Squared because a cantilever's
 * tip deflection goes as the square of the height, so the base stays pinned and
 * the motion collects in the crown. The thresholds are absolute rather than a
 * fraction of each species' height, and that is deliberate: the six species are
 * authored 10 to 18.5 m tall, and a 7 m jacaranda crown really does deflect
 * less than an 18 m fig's in the same breeze.
 *
 * Evaluated against the authored geometry, vertex by vertex:
 *
 *   plane and brush box trunk tops   0.0 cm      jacaranda crown      2.4 cm
 *   jacaranda fork, paperbark trunk  0.1-0.2     paperbark crown      3.4
 *   fig trunk top (1.0 m barrel)     0.9         plane crown          4.0
 *   fig limb base                    0.6         brush box crown      4.2
 *   eucalypt leader at 9 m           5.3         fig / euc / upper    6.2
 *
 * Two of those are worth reading twice. The eucalypt's leader is the only
 * *trunk* that moves, at 5 cm, and a gum leader is the one trunk in the six
 * that genuinely whips. And a fig's limbs run 0.6 cm at the shoulder to 6.2 at
 * the tip, so they bend along their length rather than swinging rigidly, which
 * is free -- it falls out of reading the height per vertex rather than per
 * object.
 */
function swayNode(): MeshStandardNodeMaterial['positionNode'] {
  return Fn(() => {
    const up: any = positionGeometry.y;
    const gate: any = smoothstep(float(4.0), float(10.0), up);
    const gain: any = gate.mul(gate);

    // Per-instance phase from the instance index, off the golden ratio so
    // consecutive trees land far apart in the cycle rather than in a ramp. A
    // whole street sighing in unison is the tell this exists to avoid, and it
    // is much more visible than the sway itself.
    const phase: any = fract(float(instanceIndex).mul(0.618033988)).mul(6.2831853);
    const t: any = time.mul(0.62).add(phase);

    // Two periods on the main axis and a third across it. One sine at one rate
    // reads as the whole tree sliding; a 10 s swell with a 2.6 s gust on top of
    // it, and a slower cross-axis term so the crown traces a figure rather than
    // a line, reads as air moving through a canopy. The rates are not the
    // 16-second one this was scoped with -- a real canopy's fundamental is two
    // to five seconds, and at 16 the trees drift rather than breathe.
    const dx: any = sin(t).mul(SWAY_LONG).add(sin(t.mul(2.4).add(1.3)).mul(SWAY_GUST));
    const dz: any = sin(t.mul(0.71).add(2.1)).mul(SWAY_CROSS);

    return positionLocal.add(vec3(dx.mul(gain), 0, dz.mul(gain)));
  })();
}

// --- Shared assets ------------------------------------------------------------

/**
 * The six geometries and the one material, built once for the whole game.
 *
 * Shared exactly the way `streamer.ts` shares its facade and street materials,
 * and for the same reason: a material created per tile is a WebGPU pipeline
 * compiled per tile, and pipeline compilation blocks the main thread.
 */
export class VegetationAssets {
  private readonly geometries: BufferGeometry[] = [];
  readonly material: MeshStandardNodeMaterial;
  /** Triangles per species. 64-162; spec 7.5's implied ceiling here is 300. */
  readonly triangles: number[] = [];

  constructor() {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const g = buildSpecies(s);
      this.geometries.push(g);
      this.triangles.push((g.getIndex()?.count ?? 0) / 3);
    }

    const material = new MeshStandardNodeMaterial();
    material.name = 'foliage';
    // No `colorNode` at all, and that is the cheapest thing this file does.
    // `NodeMaterial` already multiplies the material colour by the geometry's
    // `color` attribute when `vertexColors` is set, and by `instanceColor` when
    // the object has one -- so bark, foliage, per-face tone and per-tree hue
    // jitter all arrive through two built-in multiplies and no shader graph.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Matte. Leaves have a real specular lobe in life, but every tree in frame
    // catching the same highlight from the same sun is the "plastic foliage"
    // read, and this project has already decided that broad dull sheen belongs
    // to the paving.
    material.roughness = 0.92;
    material.metalness = 0.0;
    // The low-poly faceting, and it is deliberate rather than a leftover -- see
    // `MeshBuilder` for the 4.2x vertex-count argument that put it here instead
    // of in the geometry. Turning this off does not make the trees smooth in any
    // useful sense; it makes them read as spheres.
    material.flatShading = true;
    material.positionNode = swayNode();
    this.material = material;
  }

  /**
   * The mesh for one species. The single point where a species becomes geometry
   * -- an impostor LOD adds a `detail` argument here and changes nothing else.
   */
  geometry(species: number): BufferGeometry {
    return this.geometries[species] ?? this.geometries[BRUSH_BOX];
  }
}

/**
 * What the pipeline believes each species costs to draw, and it is the only
 * copy of this table that is not derived from the geometry.
 *
 * `pipeline/sydney/vegetation.SPECIES_TRIANGLES` holds the same seven numbers,
 * and it holds them because the bushland scatter's per-tile cap is spent in
 * triangles rather than in instances -- a heath is a thousand 24-triangle
 * shrubs and a forest is three hundred 100-triangle gums, and a count cap
 * prices those the same and is wrong about one of them by a factor of four.
 * The pipeline cannot measure the geometry: it runs in Python and the geometry
 * is authored in `buildSpecies` above.
 *
 * So it asserts, and this is where the assertion is checked. `VegetationAssets`
 * already counts the built indices, so the comparison is free and the failure
 * it catches is otherwise invisible: add one lobe to the eucalypt's crown and
 * every forest tile in the world is over its draw budget by 20%, with nothing
 * in any output saying so.
 */
export const PIPELINE_TRIANGLES = [162, 72, 88, 64, 72, 100, 24, 14] as const;

/** The client half of `verifyCanopy`. Needs `three`, so it cannot live in `cover.ts`. */
export function verifyVegetationCost(assets: VegetationAssets): string[] {
  const out: string[] = [];
  if (assets.triangles.length !== SPECIES_COUNT) {
    out.push(
      `VegetationAssets built ${assets.triangles.length} geometries against ` +
        `SPECIES_COUNT ${SPECIES_COUNT}`,
    );
  }
  if (PIPELINE_TRIANGLES.length !== SPECIES_COUNT) {
    out.push(
      `PIPELINE_TRIANGLES has ${PIPELINE_TRIANGLES.length} rows against ` +
        `SPECIES_COUNT ${SPECIES_COUNT}`,
    );
  }
  const n = Math.min(assets.triangles.length, PIPELINE_TRIANGLES.length);
  for (let s = 0; s < n; s++) {
    if (assets.triangles[s] !== PIPELINE_TRIANGLES[s]) {
      out.push(
        `species ${s} is ${assets.triangles[s]} triangles, and the pipeline budgets it at ` +
          `${PIPELINE_TRIANGLES[s]} -- update SPECIES_TRIANGLES in pipeline/sydney/vegetation.py`,
      );
    }
  }
  return out;
}

// --- Instancing ---------------------------------------------------------------

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _scale = /*#__PURE__*/ new Vector3();
const _up = /*#__PURE__*/ new Vector3(0, 1, 0);
const _colour = /*#__PURE__*/ new Color();

/**
 * Build one `InstancedMesh` per species present in a tile.
 *
 * Positions are tile-local, so these are added to the tile's own group and
 * inherit its world translation -- the same arrangement that keeps float32
 * vertex precision constant across the extent for the buildings.
 *
 * `groundAt` is the tile's own terrain grid, in the same tile-local metres. Tree
 * height is the one thing in the sidecar that stays a *length* rather than
 * becoming an elevation -- a fig is 22 m tall wherever it stands -- so the trunk
 * base is placed here rather than baked in the pipeline, and a tree on a slope
 * stands vertically in the ground rather than leaning out of it.
 */
export function buildTileTrees(
  data: TileVegetation,
  assets: VegetationAssets,
  groundAt: (x: number, z: number) => number = () => 0,
): InstancedMesh[] {
  const perSpecies: number[][] = Array.from({ length: SPECIES_COUNT }, () => []);
  for (let i = 0; i < data.count; i++) perSpecies[data.species[i]].push(i);

  const out: InstancedMesh[] = [];
  for (let s = 0; s < SPECIES_COUNT; s++) {
    const members = perSpecies[s];
    if (members.length === 0) continue;

    const mesh = new InstancedMesh(assets.geometry(s), assets.material, members.length);
    mesh.name = `trees_${s}`;
    const [nominalHeight, nominalRadius] = NOMINAL[s];

    for (let n = 0; n < members.length; n++) {
      const i = members[n];
      const seed = data.seed[i];
      _position.set(data.x[i], groundAt(data.x[i], data.z[i]), data.z[i]);
      // Yaw from the seed. A row of street trees all facing the same way is the
      // single most obvious tell that they were instanced, and one rotation is
      // the cheapest possible fix for it.
      _quaternion.setFromAxisAngle(_up, (seed / 256) * Math.PI * 2);
      const sy = data.height[i] / nominalHeight;
      const sxz = data.radius[i] / nominalRadius;
      _scale.set(sxz, sy, sxz);
      _matrix.compose(_position, _quaternion, _scale);
      mesh.setMatrixAt(n, _matrix);

      // Hue jitter, +/-8%, weighted toward blue because that is the axis dry
      // foliage actually varies along -- a stressed tree goes grey-blue and a
      // watered one goes deeper green, and neither changes its red much. It
      // multiplies the trunk too, which is correct: bark varies at least as much.
      const a = hash(seed, s, 1);
      const b = hash(seed, s, 2);
      const c = hash(seed, s, 3);
      _colour.setRGB(
        1 + (a - 0.5) * 0.11,
        1 + (b - 0.5) * 0.09,
        1 + (c - 0.5) * 0.16,
      );
      mesh.setColorAt(n, _colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Culled with its tile, like every other primitive the streamer loads: a
    // per-object frustum test on 40 instanced meshes buys nothing over the one
    // box test the tile already does.
    mesh.frustumCulled = false;
    // Read by `streamer.ts` in two places -- the shadow role and, critically,
    // disposal, where the geometry is *shared* and must not be released with
    // the tile.
    mesh.userData.vegetation = true;
    out.push(mesh);
  }
  return out;
}

// --- Park grass ---------------------------------------------------------------

/**
 * Hoskins' integer-free hash, lifted from `ground.ts` for the reason measured
 * there: this drives a primary colour decision over an extent of kilometres, and
 * the `fract(sin(dot(...)))` hash the paving uses degrades in uniformity as the
 * lattice index grows. Park UVs are world metres and reach the same magnitudes
 * the ground plane does.
 */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const q: any = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const r: any = q.add(dot(q, q.yzx.add(33.33)));
  return fract(r.x.add(r.y).mul(r.z));
});

const valueNoise = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i: any = floor(p);
  const f: any = fract(p);
  const w: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
});

/** One octave, rotated into its own lattice frame so two scales never align. */
function octave(p: any, metres: number, angle: number): any {
  const c = Math.cos(angle) / metres;
  const s = Math.sin(angle) / metres;
  return valueNoise(vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))));
}

/**
 * The `park_grass` slot.
 *
 * Two octaves rather than the ground plane's three, and the difference is not
 * economy: a park is bounded, so there is no far field to keep varying and no
 * 118 m drift worth carrying. What is left is the scale a park actually varies
 * at -- the wear pattern where people walk and where the sprinklers reach, at
 * around nine metres -- plus a sub-metre grain so the surface is not flat
 * underfoot.
 */
export function createParkGrassMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'park_grass';

  // Same depth problem the street surfaces have and the same fix, one unit
  // weaker. This sits at y = 0.01 against a ground plane at 0, which quantises
  // to nothing in the mid-distance. At -1 against the streets' -2 the paving
  // still wins anywhere a subtraction left a sliver, which is the ordering the
  // pipeline's heights already imply.
  material.polygonOffset = true;
  material.polygonOffsetUnits = -1;
  material.polygonOffsetFactor = 0;

  material.colorNode = Fn(() => {
    // World metres, east and south -- the pipeline writes the same planar UVs
    // the street surfaces get, so a park that spans a tile line does not restart
    // its pattern at the seam.
    const p: any = uv();

    const wear = octave(p, 9.0, 0.61);
    const grain = octave(p, 0.62, 2.17);

    // Where the grass has burnt off. The grain goes into the threshold rather
    // than being mixed after it, which is what keeps the patch edges ragged at
    // sub-metre scale without a third octave -- `ground.ts` explains why a patch
    // boundary drawn from one smooth octave reads as an airbrush.
    const dryness = smoothstep(float(0.38), float(0.66), wear.add(grain.sub(0.5).mul(0.35)));
    const colour = mix(GRASS_GREEN, GRASS_STRAW, dryness);

    // Mown stripes are deliberately absent. They are the one cue that would make
    // this read as a maintained sports field everywhere it appears, including
    // the 707 `landuse=grass` scraps that are verges and road reserve.
    const tone = float(1.0).add(grain.sub(0.5).mul(0.16)).add(wear.sub(0.5).mul(0.1));
    return colour.mul(tone);
  })();

  // Matched to the ground plane rather than to the paving: dry grass has no
  // specular character worth the name, and parks are large enough in frame that
  // any sheen would be a sheet of highlight.
  material.roughnessNode = float(0.95);
  material.metalnessNode = float(0.0);
  return material;
}

// --- Bushland ground ----------------------------------------------------------

/**
 * The shared skeleton of the two bushland slots and of `park_grass`.
 *
 * All three are the same shader with three numbers changed -- two tones, two
 * octave scales and a threshold -- and writing it three times would have made
 * the third one drift from the first two the way this project's material tables
 * historically do. `createParkGrassMaterial` is deliberately *not* folded into
 * it: it carries a paragraph of its own about mown stripes and about why its
 * wear octave is at nine metres, and that argument is about parks rather than
 * about ground.
 */
function createCoverMaterial(
  name: string,
  // `any`, as everywhere else this file touches a TSL value: `vec3()` returns a
  // different node class for a constant than for a join and the two do not
  // unify, which is a fact about three's generics rather than about the colours.
  low: any,
  high: any,
  patchM: number,
  grainM: number,
  roughness: number,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  // The same one-unit bias `park_grass` takes, for the same reason and against
  // the same neighbours: these sit at y = 0.01 over a terrain mesh at 0, the
  // paving sits above them at 0.02 and 0.15, and the three green slots are cut
  // disjoint from each other in the pipeline so they never meet.
  material.polygonOffset = true;
  material.polygonOffsetUnits = -1;
  material.polygonOffsetFactor = 0;
  material.colorNode = Fn(() => {
    const p: any = uv();
    const patch = octave(p, patchM, 0.37);
    const grain = octave(p, grainM, 1.93);
    // The grain goes into the threshold rather than being mixed after it, which
    // is what keeps the patch edges ragged at sub-metre scale without a third
    // octave. `ground.ts` explains why a patch boundary drawn from one smooth
    // octave reads as an airbrush.
    const t = smoothstep(float(0.34), float(0.68), patch.add(grain.sub(0.5).mul(0.4)));
    const colour = mix(low, high, t);
    const tone = float(1.0).add(grain.sub(0.5).mul(0.18)).add(patch.sub(0.5).mul(0.12));
    return colour.mul(tone);
  })();
  material.roughnessNode = float(roughness);
  material.metalnessNode = float(0.0);
  return material;
}

/**
 * The `bush_floor` slot: forest, scrub, heath and golf-course rough.
 *
 * Four cover classes share it, and `pipeline/sydney/vegetation.py`'s header
 * argues that at length: underfoot those four *are* the same thing, and the
 * difference between them is vertical -- it is the height and the density of
 * what is standing on the ground, which is the instances' job and not this
 * one's.
 *
 * The patch octave is at 4.5 m rather than the park's 9 m because that is the
 * scale bushland ground actually varies at: it is the size of a shrub's own
 * litter shadow and of the gaps between clumps, not the reach of a sprinkler.
 * There is no wear pattern of any kind and there should not be -- nothing walks
 * here in enough numbers to make one, and a worn track through Ku-ring-gai is a
 * fire trail, which is a road and is drawn as one.
 */
export function createBushFloorMaterial(): MeshStandardNodeMaterial {
  return createCoverMaterial('bush_floor', BUSH_UNDER, BUSH_LITTER, 4.5, 0.55, 0.95);
}

/**
 * The `wetland_mud` slot: mangrove flats and saltmarsh.
 *
 * The patch octave is much wider than the others at 14 m, which is the scale a
 * tidal flat's channels and pans run at, and the grain a little coarser so the
 * surface is not glassy up close.
 *
 * Roughness 0.72 against every other ground surface's 0.95, and it is the one
 * place in this file a sheen is wanted rather than suppressed. Wet mud is wet:
 * a low broad specular lobe across a flat at 3 pm is the thing that says the
 * tide was here this morning, and the argument the grass makes against sheen --
 * that a park fills enough of the frame to become a sheet of highlight -- does
 * not apply to a surface that is never more than a few hundred metres of
 * shoreline at a time.
 */
export function createWetlandMudMaterial(): MeshStandardNodeMaterial {
  return createCoverMaterial('wetland_mud', MUD_WET, MUD_MARSH, 14.0, 0.9, 0.72);
}
