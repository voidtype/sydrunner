/**
 * The ground under everything that is not a street.
 *
 * This file is the *shading* of that ground plus the one flat surface left in
 * the world. The ground itself is now geometry: `terrain.ts` builds a displaced
 * grid per tile from the pipeline's `.terr.bin`, and `createGroundMaterial`
 * below is what those meshes wear. Everything from "Which makes the target a
 * specific Sydney thing" down was written for a plane and applies unchanged --
 * it reads `positionWorld.xz`, so it never knew the surface was flat and does
 * not notice that it no longer is.
 *
 * What is still a plane is `createFarGround`: one huge quad at **sea level**,
 * seen only past the edge of tile coverage and through the gaps where there is
 * no tile at all, which in the inner ring means the harbour. See its own note
 * for why sea level rather than zero, and why four metres under it.
 *
 * This surface's job changed once before, the moment the pipeline started
 * emitting real carriageways. It used to *be* the road network -- shaded as
 * asphalt and concrete because there was nothing else to stand in for them. Now
 * `road_asphalt`, `footpath_concrete` and `kerb_sandstone` sit on top of it at
 * 0.02-0.15 m above the ground, so this is **everything they are not**: the
 * interiors of blocks behind the buildings, nature strips and verges, vacant
 * lots and back lanes OSM never mapped, and the far field out to where the fog
 * closes.
 *
 * Which makes the target a specific Sydney thing rather than a generic one.
 * Inner-suburban ground in February is dry: compacted buff soil with dead straw
 * grass over it in patches. It is deliberately **not green**. Lush grass is the
 * fastest way to make a render of Sydney read as England, and it is the mistake
 * worth naming here specifically, because "ground plane" defaults to green in
 * every engine and every asset pack ever shipped.
 *
 * The other half of the brief is that the streets have to win. They are the
 * structured, high-contrast, legible thing in frame -- footpath at display 248,
 * asphalt at 137, a sandstone edge between them. This surface has to sit softly
 * *between* those two with no structure of its own, so that the paved network
 * reads as a network laid over it.
 *
 * Every display value quoted in this file was measured rather than judged: the
 * composition in `colorNode` and the shading chain documented at the top of
 * `calibration.ts` were run together offline over a 680 m square at 3 pm on
 * 15 February. That gives a sunlit luminance of p05 157, median 170, p95 186 --
 * a third of the way from the asphalt to the footpath, and never touching
 * either end. By area it comes out 40% bare soil, 42% dry grass, 18% the
 * transition between them.
 *
 * Those three figures were 154 / 167 / 183 before the bounce light went into the
 * rig, and they are restated rather than re-measured: this is an up-facing
 * surface, so it takes only the `sin(16 deg)` share of the bounce, and both of
 * its albedos move by the same three code values of luminance (soil +3.1, grass
 * +2.9). A constant shift does not change the shape of the histogram, which is
 * what the percentiles are here to describe.
 *
 * ---------------------------------------------------------------------------
 * What was here before, and why the replacement has the shape it has.
 *
 * The old version hashed one value per 24 m cell and flat-shaded the cell. One
 * hash per cell with no interpolation is a *pattern*, not a texture: across a
 * 40 km plane seen from 1.7 m of eye height those cells project into enormous
 * triangular light and dark wedges radiating out from the camera, which filled
 * the lower half of the frame and was the third most obviously synthetic thing
 * in the image.
 *
 * A smaller cell does not fix that -- it just makes smaller wedges. Three things
 * fix it, and all three are below:
 *
 *   1. interpolate between lattice points rather than flat-shading cells, so
 *      there are no cell boundaries to see in the first place;
 *   2. three scales rather than one, so no single scale carries the read;
 *   3. a different rotation per scale, so three square lattices never line up
 *      into anything axis-aligned at any distance.
 *
 * ---------------------------------------------------------------------------
 * Why there are two tones here and not three.
 *
 * The obvious third element is worn concrete -- the slab a shed used to sit on,
 * a driveway apron, a depot yard. Four constructions of it were built and
 * rendered top-down before the idea was dropped, and the failure is structural
 * rather than a tuning problem. A rare pale feature pulled from the tail of a
 * noise field comes out as one of three things and never as a slab:
 *
 *   - keyed off the 13.5 m patches, it is bright speckle: dozens of small white
 *     flecks per block, which reads as sensor noise;
 *   - keyed off the 118 m drift, the flecks trace out that field's shape as a
 *     density gradient, which puts diagonal banding back into the frame -- the
 *     exact artifact this file exists to remove;
 *   - widened until it is not speckle, it becomes soft pale cloud, which reads
 *     as fog lying on the ground.
 *
 * Underneath all three is the same conflict: concrete is the *brightest* thing
 * that could go here, and the one requirement this surface has is not to
 * compete with the footpath network. Two tones and a wide tonal range beat three
 * tones and a fight over the top of the histogram. A real slab wants real
 * geometry with a real edge, which is a pipeline job, not a shader job.
 *
 * ---------------------------------------------------------------------------
 * The budget, because this is roughly half the frame -- about a million pixels
 * at 0.75 render scale -- on an iGPU.
 *
 * Three octaves at four corner hashes each is twelve hash evaluations, and that
 * is the whole cost: no texture fetch, no loop, no branch, no derivative, and
 * no transcendental anywhere. Roughly 300 scalar ALU ops, most of it the hash.
 * Twelve is also the floor for what is being asked, not a comfortable number
 * chosen for looks: smooth interpolation in 2D needs four lattice corners, and
 * three separately-readable scales is the requirement. The savings that were
 * available were taken by *reusing* the three fields instead -- the patch mix
 * and the tonal variation are two different recombinations of the same three
 * samples rather than a fourth and fifth octave.
 * ---------------------------------------------------------------------------
 */

import {
  Fn,
  attribute,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  length,
  mix,
  positionWorld,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl';
import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';

import { COVER_TINT_SCALE } from './cover.ts';

/**
 * Extent, metres. Unchanged: it has to outrun the 1.8 km streaming radius by
 * enough that no camera angle finds sky under the world, and `main.ts` closes
 * the fog by 9 km, so everything past that is paying for depth and a fog blend
 * and nothing else.
 */
const GROUND_EXTENT = 40000;

/**
 * How far under sea level the far plane sits, metres.
 *
 * It has to be under, because terrarium clamps the harbour to exactly 0 m AHD
 * and a tile on the shoreline therefore has posts at exactly sea level: coplanar
 * with the plane, which z-fights, and z-fighting on the ground is the worst
 * artefact a renderer can produce. It has to be *this far* under because of
 * where the plane is seen from. Depth resolution at range d with a 0.1 m near
 * plane is about d^2 / (near * 2^24) -- 5 cm at 300 m, 1.35 m at 1.5 km, 1.9 m
 * at the 1.8 km streaming radius, which is as far as any tile ever is. Four
 * metres clears the worst of those twice over, and four metres of water level is
 * not a thing anyone can see at a kilometre and a half through fog.
 */
const FAR_PLANE_SINK = 4.0;

/**
 * The three scales, in metres, and the angle each one's lattice is rotated by.
 *
 * The scales are the three things a real block interior varies at, spread
 * roughly a decade apart (x8.7 then x25) so each stays separately readable
 * instead of beating against its neighbour: block-to-block character, patches of
 * worn ground against vegetated ground, and the grain of the surface itself.
 *
 * The angles are arbitrary, and their only requirement is to differ. A value
 * noise lattice is a square grid, and a square grid leaves a faint axis-aligned
 * signature no matter how well it is interpolated; three grids at three
 * unrelated angles cancel each other's. The rotation folds into the scale
 * constant, so a whole frame change costs four multiplies.
 */
const DRIFT_METRES = 118;
const DRIFT_ANGLE = 0.37;
const PATCH_METRES = 13.5;
const PATCH_ANGLE = 1.13;
const GRAIN_METRES = 0.55;
const GRAIN_ANGLE = 2.41;

/**
 * Dry compacted soil, the bare 40% of the ground. rho 0.157, mid-range for the
 * measured 0.15-0.20 of dry light-brown earth, and a stop and a third under the
 * sandstone it weathered out of.            -> sun rgb(198, 179, 145)
 *                                              shade rgb( 62,  61,  49)
 */
const SOIL = /*#__PURE__*/ vec3(0.195, 0.152, 0.096);

/**
 * Dead summer grass. rho 0.121, darker than the soil and pulled well down in
 * blue so it lands as warm straw rather than sage -- 17 code values of red over
 * green, against the 8 of the olive-khaki version this replaced. Eight was
 * enough to make the patches read as a live lawn gone dull; seventeen reads as
 * dead, which is what February is.
 *
 * Only 22 display values of luminance separate it from the soil, and that gap is
 * deliberately small: verge grass and the dirt beside it really are close in
 * tone, and widening it turns the patches into leopard spots.
 *                                           -> sun rgb(176, 158, 110)
 *                                              shade rgb( 55,  53,  28)
 */
const GRASS = /*#__PURE__*/ vec3(0.153, 0.118, 0.058);

/**
 * Value hash -- and deliberately **not** the `fract(sin(dot(p, k)) * 43758.5)`
 * that `street.ts` and `facade.ts` share. The reason is extent, and it was
 * measured rather than assumed, because the assumption turned out to be wrong.
 *
 * A street primitive is a few hundred metres inside a tile. This plane is 40 km
 * across and its finest lattice is 0.55 m, so the integer lattice index reaches
 * ~36,000 and the argument handed to `sin` reaches ~1.1e7 -- a magnitude where
 * float32's smallest representable step is 2, so the argument arrives quantised
 * to two-radian jumps. The expectation was that this would break the hash into
 * visible banding in the outer half of the plane. It does not: sampling 40,000
 * cells at lattice indices of 0, 2k, 20k, 33k and 60k, the lag-1
 * autocorrelation of the sin hash stays within +/-0.01 of zero at every one of
 * them, and a side-by-side render at the plane's corner is indistinguishable.
 * That negative result is recorded here so nobody re-derives it.
 *
 * What the same measurement does show is two smaller things, and together they
 * are enough to justify the swap on a surface that covers half the screen:
 *
 *   - **Alphabet.** In float32 the sin hash resolves to ~2,800 distinct values
 *     per 40,000 samples against this one's ~9,000, at every index including
 *     zero. Interpolation hides most of that, but this field drives the primary
 *     colour decision rather than a +/-0.05 modulation, so it has the least
 *     margin for a coarse one.
 *   - **Uniformity, and it degrades with distance.** Chi-squared over 20 bins
 *     (19 dof, 95% point ~30) runs 43, 16, 38, 48, 77 for the sin hash across
 *     those five indices -- past the 95% point by the plane's edge -- against a
 *     flat 14 to 27 here. A skewed hash is a slow tonal drift over kilometres,
 *     not an artifact you can point at, which is exactly the kind of thing that
 *     survives review and looks subtly wrong forever.
 *
 * This is Hoskins' integer-free hash. It folds the coordinate into the unit
 * interval first, so its conditioning depends on the *step* between lattice
 * cells (0.1031) rather than on their absolute magnitude. It also has no
 * transcendental in it, which means it is not leaning on WGSL's accuracy for
 * `sin` at 1e7 -- a range the spec does not constrain.
 */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  // Annotated `any` for the reason `street.ts` gives: TSL's arithmetic overloads
  // collapse a vector node to a scalar node type through a chain of `mul`, and
  // the component accessors go with it.
  const q: any = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const r: any = q.add(dot(q, q.yzx.add(33.33)));
  return fract(r.x.add(r.y).mul(r.z));
});

/**
 * Smooth value noise on a unit lattice. Four corner hashes and a smoothstepped
 * interpolant -- a plain bilinear blend shows the lattice as a diamond grid, and
 * a grid is the one thing this surface must not have.
 */
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

/**
 * One octave: rotate world metres into that octave's own lattice frame, and
 * sample.
 *
 * A plain TypeScript helper rather than a TSL `Fn`, so it inlines and adds no
 * function node to the graph. Rotation and scale collapse into two constants.
 */
function octave(p: any, metres: number, angle: number): any {
  const c = Math.cos(angle) / metres;
  const s = Math.sin(angle) / metres;
  return valueNoise(vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))));
}

/**
 * The material every piece of unpaved ground wears, near and far.
 *
 * One instance, shared by every tile's terrain mesh and by the far plane, for
 * the reason every other material in the streamer is shared: it is one pipeline
 * compile for the whole world, and a per-tile material would be a per-tile
 * pipeline. Nothing in it varies per tile -- it is a function of world position
 * and nothing else.
 */
export function createGroundMaterial(
  options: { cover?: boolean } = {},
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = options.cover ? 'far-ground' : 'ground';

  material.colorNode = Fn(() => {
    // World metres, east and south, taken from the interpolated world position
    // rather than from the mesh UV. The plane's UV is 0..1 across 40 km, so a
    // metric coordinate built from it is a large scale factor applied to a
    // number that only ever had 24 bits, and the 0.55 m octave would quantise
    // into stripes long before the plane's edge. `facade.ts` reads
    // `positionWorld` for the same reason. The mesh is centred on the origin,
    // so this needs no offset.
    const p: any = positionWorld.xz;

    // Block-to-block drift: one inner-suburban block across, so the ground
    // changes character as the player crosses a suburb while no single view ever
    // contains a whole period of it to recognise as a period.
    const drift = octave(p, DRIFT_METRES, DRIFT_ANGLE);
    // Patches -- worn bare ground against vegetated ground. The size of a
    // backyard or a run of nature strip, which is the scale this surface is
    // actually read at from standing height.
    const patch = octave(p, PATCH_METRES, PATCH_ANGLE);
    // Grain: the texture of dirt and grass itself, just under a stride.
    const grain = octave(p, GRAIN_METRES, GRAIN_ANGLE);

    // --- Distance fade, which is an anti-aliasing measure and not a cost one --
    // The octaves are evaluated either way; what fades is how much they
    // contribute. The reason is the anisotropy of a ground plane seen from eye
    // height. A feature of size L at distance d spans about L/d radians across
    // the view but only L*1.7/d^2 along it, so it goes sub-pixel *in depth*
    // while it is still tens of pixels wide -- and a noise field that is
    // sub-pixel in one direction only does not average away. It resolves into
    // thin horizontal slivers that sweep up the screen as the player walks,
    // which is a far worse artifact than the flatness it is hiding.
    //
    // At 0.75 render scale (about 1.2 mrad per pixel) that crossover is ~30 m
    // for the 0.55 m grain and ~140 m for the 13.5 m patches, and each fade is
    // hung on its own crossover. They are ramps rather than cuts because the
    // artifact grows as the feature gets smaller, so a decaying amplitude and a
    // worsening footprint cancel instead of trading one for the other.
    //
    // The 118 m drift is left alone. Its crossover is ~420 m, it is low-contrast
    // and low-frequency enough that aliasing it costs almost no tonal error, and
    // fading it too would leave a dead flat plane from there out to the fog at
    // 9 km. As it is, past ~900 m the drift is all that is left and the ground
    // settles into a 164-174 band -- flat, but flat is what a mipmap would have
    // produced anyway, and it is the correct mean rather than a guess.
    //
    // Analytic filtering by pixel footprint is the principled fix. It needs
    // derivatives and a per-octave weight, and it is not worth it here: measured
    // either side of both fades the histogram hardly moves -- median 170 with
    // all the detail and 170 with none -- so what is given up is only shimmer.
    const viewDistance = length(positionWorld.sub(cameraPosition));
    const grainFade = float(1.0).sub(smoothstep(float(20.0), float(90.0), viewDistance));
    const patchFade = float(1.0).sub(smoothstep(float(150.0), float(900.0), viewDistance));
    // Both are carried centred on zero, so a faded octave decays to its own mean
    // rather than to black.
    const g: any = grain.sub(0.5).mul(grainFade);
    const q: any = patch.sub(0.5).mul(patchFade);

    // --- Where the grass is ---------------------------------------------------
    // The drift biases the threshold rather than being mixed in after it, so a
    // block comes out mostly bare or mostly grassy *as a block* -- which is how
    // real blocks differ from each other -- instead of every block averaging to
    // the same thing with different noise laid over it. It is also what keeps
    // the far field varying at all once the patches have faded.
    //
    // The grain goes into the threshold as well, and that is what keeps the
    // patch edges ragged at sub-metre scale for free. A patch boundary drawn
    // from the 13.5 m octave alone is a smooth blobby curve and reads as an
    // airbrush; this breaks it up without a fourth octave.
    const wear = float(0.5).add(q).add(g.mul(0.55)).add(drift.sub(0.5).mul(0.28));
    const vegetation = smoothstep(float(0.42), float(0.62), wear);
    const colour = mix(SOIL, GRASS, vegetation);

    // Tone, weighted the other way round from the mix above so the two do not
    // collapse into "the grass is always the dark bits": the mix is led by the
    // 13.5 m patches, the tone is led by the 118 m drift. With two materials
    // rather than three this is what carries the range -- it is what takes a
    // 22-value gap between the albedos out to a 141-193 spread on screen.
    const tone = float(1.0)
      .add(drift.sub(0.5).mul(0.34))
      .add(q.mul(0.14))
      .add(g.mul(0.22));

    const dirt: any = colour.mul(tone);
    if (!options.cover) return dirt;

    // --- The cover channel, and it is one `mix` ------------------------------
    //
    // `world/cover.ts` holds the whole argument; the short of it is that this
    // material is what the horizon wears, it has never known what grows on the
    // ground it is painting, and past the streaming radius that is the entire
    // reason Ku-ring-gai reads brown. `far-cover.bin` gives one byte per 500 m
    // post -- a class and how much of the cell it covers -- and `far.ts` expands
    // it into this attribute before the mesh is built.
    //
    // Mixed toward the canopy tint rather than multiplied by it, because the two
    // are different colours and not a tint of one another: forest is grey-olive
    // where the dirt is warm buff, and a multiply can only ever darken the dirt
    // toward a browner brown. The dirt's own `tone` rides along on the mixed
    // result -- one multiply after the mix rather than inside it -- so a
    // forested slope still carries the 118 m drift that keeps the far field from
    // going flat, at the reduced contrast a canopy actually has.
    const cover: any = attribute('cover', 'vec4');
    const canopy: any = cover.xyz.mul(float(COVER_TINT_SCALE)).mul(tone);
    return mix(dirt, canopy, cover.w);
  })();

  // Dry soil and dead grass have no specular character worth the name, and this
  // surface is half the frame -- any sheen on it at all would be a sheet of
  // highlight running to the horizon. 0.96 spreads the lobe wide enough that it
  // disappears into the diffuse term, which is what leaves the streets' own
  // broad sheen as the thing that reads as paving.
  material.roughnessNode = float(0.96);
  material.metalnessNode = float(0.0);

  // Push the ground back in depth, so everything lying on it always wins.
  //
  // The paved surfaces clear the ground by 2 cm (carriageway), 1 cm (park
  // grass) and 15 cm (footpath), which are the right numbers in metres and
  // nowhere near enough in *depth buffer*. With a 0.1 m near plane the smallest
  // resolvable world separation is about d^2 / (near * 2^24): 2.4 cm at 200 m,
  // 15 cm at 500 m, 60 cm at a kilometre. So past a couple of hundred metres the
  // road and the dirt under it occupy the same depth value and fight, which
  // reads as the asphalt dissolving into speckle across the mid-field. It is not
  // new -- the flat plane this replaces had the identical arithmetic -- but the
  // ground is 31 m triangles now rather than one 40 km quad, so the fight breaks
  // into visible patches instead of a smooth wash.
  //
  // A depth bias is the right fix because it scales the way the problem does.
  // WebGPU's `depthBias` is in units of the depth format's own resolution, so a
  // constant bias is a *growing* world-space push: 4 units is 2.4e-6 * d^2, or
  // 1 cm at 60 m, 10 cm at 200 m, 2.4 m at a kilometre -- always a few times the
  // margin the surfaces need and never more than a rounding error where the
  // player is standing. `polygonOffsetFactor` adds the slope term, which is what
  // covers the ground being tilted now rather than flat.
  //
  // The cost is at ridgelines a long way off: geometry hidden behind a crest by
  // less than the bias can peek through it. That is metres at a kilometre, under
  // fog, against speckle over the whole mid-field. Four units is deliberately at
  // the low end of what works, and this is a three-line revert if it ever shows.
  material.polygonOffset = true;
  material.polygonOffsetUnits = 4;
  material.polygonOffsetFactor = 1;
  return material;
}

/**
 * The flat far field, at sea level, under everything the pipeline emitted.
 *
 * `seaLevelY` comes from `index.json`: the pipeline's datum puts world y = 0 at
 * the ground under the ENU origin, so 0 m AHD is at minus that. Putting the
 * plane there rather than at y = 0 is the only choice that is right in both
 * places it shows:
 *
 *   * **Through the gaps.** A tile is emitted only where there is something to
 *     put on it, so the harbour, the bays and Botany Bay have no tile at all and
 *     this is what fills them. At sea level that is water level, which is what
 *     it should be; at y = 0 it would be a 70 m plateau standing where the
 *     harbour is.
 *   * **Past the edge of coverage.** Beyond the streaming radius the world stops
 *     and this is what continues. Under the fog it reads as distant flats, and
 *     the step down to it from the last tile is the real height of the land
 *     above the sea, which is the correct shape for a step at a coastline.
 *
 * Terrain heights are clamped to sea level in the pipeline, so no tile can ever
 * be *under* this -- there is no case where the far plane cuts through the world.
 */
export function createFarGround(seaLevelY: number, material: MeshStandardNodeMaterial): Mesh {
  // Two triangles. The world-metre coordinate in the material is interpolated
  // across them at float32, and even at the far corner that is a 2.4 mm step
  // against a 0.55 m lattice -- 200x of headroom, so subdividing the plane
  // would buy nothing the shader could notice.
  const mesh = new Mesh(new PlaneGeometry(GROUND_EXTENT, GROUND_EXTENT), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = seaLevelY - FAR_PLANE_SINK;
  // Receives, and never casts. Receiving is what puts building shadows on the
  // block interiors and the unpaved verges; not casting is what keeps a 40 km
  // plane out of the depth map, where it would otherwise write a full-screen
  // layer at ground level and shadow everything standing on it.
  //
  // It also means this surface cannot self-shadow, which is why the bias in
  // `sky.ts` can be as small as it is -- there is no acne to defend against on
  // the one surface whose extent would make acne unavoidable.
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'far-ground';
  return mesh;
}
