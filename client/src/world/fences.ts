/**
 * Front fences: a rendered masonry wall, an iron palisade and a timber picket.
 *
 * The geometry is `fences.py` in the pipeline -- a strip on the property line
 * across the frontage of every residential building that stands back off its
 * street, with a 900 mm gap in it aligned to the front door. This file is the
 * three materials, and the whole of the difference between them is here: the
 * pipeline emits one quad strip and two posts either way, and what makes one a
 * wall and another a row of bars is a mask.
 *
 * ---------------------------------------------------------------------------
 * THE PICKETS ARE ALPHA-TESTED AND THE GARDEN SHOWS THROUGH, which is the
 * decision this file exists for. A palisade drawn as a solid strip with dark
 * stripes painted on it is a *picture* of a fence -- the same failure the awning
 * pass names about a painted-on canopy -- because what a real front fence does
 * to a street is let you see the garden and the bottom of the house behind it in
 * slices. Stripes on a solid strip give a suburban street a continuous 0.9 m
 * dado rail along both sides of it and hide every front garden in the city.
 *
 * Three things had to be true for the alpha test to be the right answer and all
 * three were read out of three r185 rather than assumed:
 *
 *   1. `NodeMaterial.setupDiffuseColor` runs `diffuseColor.a.lessThanEqual(
 *      alphaTest).discard()` whenever `material.alphaTest > 0`, on the ordinary
 *      opaque path. Nothing has to be transparent, nothing sorts, and the strip
 *      still writes depth -- which matters, because a fence is the nearest thing
 *      to the camera on a residential street and a fence that failed to write
 *      depth would let the house behind it draw over its own posts.
 *
 *   2. IT CARRIES TO THE SHADOW PASS, and by exactly one route. The shadow pass
 *      runs with `scene.overrideMaterial` set to a shared bare material;
 *      `Renderer.renderObject` copies `material.alphaTest` onto it verbatim, and
 *      `Renderer._getShadowNodes` builds the override's colour as
 *      `vec4(vec3(0), 1.0 * material.colorNode.a)` -- the SOURCE material's
 *      colour node, alpha channel only. So the mask has to live in
 *      `colorNode.a`. Putting it in `opacityNode` instead compiles, looks
 *      identical in the main pass, and throws a solid shadow: nothing in
 *      `_getShadowNodes` reads `opacityNode`. That is the whole reason the
 *      colour below is assembled as a `vec4` rather than returned as a `vec3`
 *      with the mask handed to `material.opacityNode`.
 *
 *   3. `alphaToCoverage` is real on this backend.
 *      `WebGPUPipelineUtils` sets `multisample.alphaToCoverageEnabled` from it
 *      whenever `sampleCount > 1`, and `main.ts` builds the renderer with
 *      `antialias: true`. `NodeBuilder.isOpaque()` returns false while it is
 *      set, which is what stops the opaque path forcing alpha back to 1 and
 *      throwing the coverage away. So a picket edge is 4x coverage-sampled in
 *      the main pass instead of a hard stair.
 *
 * WHAT THE SHADOW ACTUALLY LOOKS LIKE, since the point of casting was the stripe
 * pattern across the footpath. It is **not** a stripe pattern, and the reason is
 * arithmetic rather than a limitation of the alpha test. The shadow map is 4096
 * over a 440 m volume, so 10.7 cm a texel, and the palisade's bar pitch is
 * 11 cm. The mask is faded on `resolves(pitch, fwidth(u))` for the ordinary
 * reason -- an alpha test on a sub-pixel period is the worst aliasing available
 * -- and in the depth pass `fwidth` is measured in *shadow-map* texels, so the
 * fade evaluates at a footprint of 0.107 against a period of 0.11 and returns
 * zero. The mask goes solid, and a palisade throws a soft continuous bar.
 *
 * That is the correct answer at this resolution and it is worth being plain
 * about the error in it: a bar shadow is denser than the 35% duty the real fence
 * has. What bounds the damage is that the object is 0.9 m tall, so at the 3 pm
 * sun's 57 degrees it throws 0.58 m -- five shadow texels, a soft dark band at
 * the back of the footpath, which is what a front fence's shadow is from any
 * distance you can see a footpath from. A stripe pattern would need a shadow map
 * an order of magnitude finer, and that is a rig change and not a fence one.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS A HASH OF WORLD POSITION, on an 18 m lattice, the way
 * `awning_fascia`'s signage colour is -- so these slots read no parameter atlas
 * and carry no `_BLDIDX`, and the pipeline's per-building *style* choice arrives
 * as which slot the geometry landed in rather than as a number.
 *
 * The cost of a lattice is that a fence longer than a cell changes tone
 * somewhere along its length. On a fascia that is the point, because the paint
 * really does change per shop; on a fence it is not, so it is bounded from both
 * ends. The cell is more than twice the median frontage (8.9 m over the inner
 * ring), so about two thirds of fences never cross one -- and the tones inside
 * each style are deliberately near neighbours, six to fourteen display code
 * values apart, rather than a palette. What a crossing produces is a long
 * rendered wall that changes tone once down a block of flats, which is what a
 * long rendered wall that has been patched and repainted looks like.
 */

import {
  Fn,
  abs,
  dot,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DoubleSide, MeshStandardNodeMaterial } from 'three/webgpu';

import { resolves, softLine } from './facade.ts';

/**
 * The tone lattice, metres.
 *
 * Four times the median frontage over the inner ring (9.9 m), and it is set from
 * the crossing probability rather than by eye: a straight segment of length L at
 * a random bearing crosses an axis-aligned lattice of pitch `c` about `1.27 L/c`
 * times, so 40 m leaves about a third of fences with a tone change somewhere
 * along them and a 20 m one would have left two thirds.
 *
 * The cost of going large is that neighbouring houses inside one cell share a
 * tone, and that is deliberately affordable *because the style is not hashed
 * here*. Which of the three fences a building gets is a per-building draw the
 * pipeline makes, arriving as which slot the geometry landed in, so four houses
 * in one cell are a masonry wall, a palisade, another palisade and a picket
 * fence that happen to agree about a shade of paint -- which is a street, and is
 * exactly what `attributes.MATERIAL_MIX` is careful to produce for the walls.
 */
const FENCE_CELL = 40.0;

/**
 * What is behind a fence, as a linear albedo, and the only reason it is here.
 *
 * An alpha-tested mask on a period that has gone sub-pixel is the worst
 * aliasing available -- it does not soften, it flickers between drawn and
 * discarded with the sampling grid. So the mask is faded on `resolves` and goes
 * fully solid once the bars stop resolving, and a solid strip has to converge on
 * the *area-weighted* colour of what the strip really is: `duty` of paint and
 * `1 - duty` of whatever was visible through it.
 *
 * This is that remainder, and it is a mid-dark neutral because a front garden at
 * 150 m is foliage, mulch, a path and the shaded bottom of a house, and none of
 * those is a colour. Through the chain it is sunlit rgb(140, 140, 127) Y' 139
 * and shaded rgb(72, 66, 51) Y' 66.
 *
 * The consequence is the right one at both ends of the palette. A picket fence
 * at 55% duty converges on sunlit rgb(233, 235, 232) Y' 234 -- a pale band, 13
 * code values under the near-field picket, so it stays a white fence and gets
 * quieter. A palisade at 35% converges on sunlit Y' 114 against the garden's
 * own 139, which is 25 code values: barely distinct, and that is also correct.
 * You cannot see a wrought-iron fence from across a park.
 */
const BEHIND: [number, number, number] = [0.155, 0.150, 0.120];

/**
 * Below this `u`, the fragment is on a post rather than on a panel.
 *
 * `fences.POST_U` on the pipeline side -- the same number stored twice, and the
 * only one these two files share. A panel's `u` starts at zero and only
 * increases; a post's is written into a band starting at -1.0 and running
 * downwards, so this threshold has half a metre of margin either side of it.
 *
 * It is here because a post is 75 to 90 mm across, which is *narrower than one
 * picket pitch*: run through the bar mask, a post comes out with a hole in it.
 * See `fences.POST_U` for the discriminators that do not exist.
 */
const POST_U = -0.5;

/** Same construction as `facade.hash21`, which is not exported. */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h).mul(43758.5453123));
});

/**
 * One fragment's cell roll, from world XZ.
 *
 * World rather than tile-local, for the reason `awning.ts` gives: tile geometry
 * is tile-local with a group translation, so `positionWorld` is the only
 * coordinate that is continuous across a tile seam -- and a fence on a corner
 * block routinely spans one.
 */
function cellRoll(salt: number) {
  const cell = floor(vec2(positionWorld.x, positionWorld.z).div(FENCE_CELL));
  return hash21(cell.add(vec2(salt, salt * 1.7)));
}

/* ===========================================================================
 * The open styles: iron palisade and timber picket
 * ======================================================================== */

interface OpenStyle {
  readonly slot: string;
  /** Bar centres, metres. `u` is metres along the fence. */
  readonly pitch: number;
  /** Fraction of the pitch that is bar. */
  readonly duty: number;
  /** Panel height, metres, matching `fences.Style.height` on the pipeline side. */
  readonly height: number;
  /** Bottom and top rail bands, as [low, high] in metres above grade. */
  readonly railLow: readonly [number, number];
  readonly railHigh: readonly [number, number];
  /**
   * Bar duty above the top rail. Under 1 it leaves the bars standing proud of
   * the rail as a row of points, which is what a palisade is; at 1 the panel is
   * square-topped, which is what a picket fence is.
   */
  readonly finialDuty: number;
  /** Two near-neighbour paint tones, linear albedo. */
  readonly paint: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** How far one bar's value strays from its neighbour's. */
  readonly barVariation: number;
  readonly roughness: number;
  readonly metalness: number;
  /**
   * Line posts, as a **second period in the same mask** -- optional, and absent
   * on both of the garden styles, whose posts arrive as geometry the pipeline
   * emits into the `POST_U` band.
   *
   * It exists for the rail boundary fence, which is the one caller that builds
   * its own strip: 300 km of corridor fencing is affordable at *one quad per
   * eight metres per side* and is not affordable at one box per post. A post
   * every 2.8 m over a 19,000-segment network is a hundred thousand boxes; the
   * same rhythm as a solid band in `u` is free, because the fragment already
   * knows where along the fence it is.
   *
   * Guarded rather than defaulted, so the two garden styles generate exactly the
   * node graph they generated before this field existed. A different graph is a
   * different pipeline, and `world/warmup.ts` is the file that explains at
   * length what that costs.
   */
  readonly post?: { readonly pitch: number; readonly width: number };
  /**
   * What is behind this fence, for the far-field convergence, when it is not a
   * front garden. See `BEHIND`: the value is the area-weighted remainder a solid
   * strip has to converge on, and behind a rail fence is ballast and cess rather
   * than foliage and mulch.
   */
  readonly behind?: readonly [number, number, number];
}

/**
 * Wrought iron, and the two tones are the same tone.
 *
 * A Sydney palisade is painted one of two things and has been since 1900: black,
 * or the very dark blue-green everybody calls heritage green and nobody can pick
 * out of black at more than a few metres. Predicted display values through the
 * chain in `sky/calibration.ts` -- linear radiance, Lambert, exposure 0.62,
 * Neutral tone mapping, sRGB encode -- at 3 pm on 15 February, on a vertical bar
 * square-on to the sun and on the same bar in shade:
 *
 *   ironbark black   rho 0.024   sun rgb( 31,  33,  40) Y'  33   shade rgb(  9,   5,   7) Y'   6
 *   heritage green   rho 0.024   sun rgb( 23,  43,  33) Y'  38   shade rgb(  4,  15,   3) Y'  12
 *
 * FIVE CODE VALUES APART IN SUN and six in shade, which is the number that makes
 * the lattice safe: a fence that crosses a cell boundary changes by less than
 * the noise in the image. The two are matched in luminance on purpose and differ
 * only in hue, which is the honest description of the pair -- nobody can pick
 * heritage green out of black at more than a few metres, and the reason to have
 * both is that the green one is *green* in the sun at close range.
 *
 * What carries a palisade is not its colour at all: it is that the bars are
 * near-black against whatever is behind them. Against sunlit foliage at rho
 * 0.122 (rgb(119, 129, 92), Y' 124) a bar is 91 code values down in sun and 55
 * in shade, and that is the whole read.
 *
 * 35% duty on a 110 mm pitch is a 38 mm bar, which is over-scale: a real
 * palisade is a 16 mm square at 110 mm centres. It is over-scale deliberately
 * and by the same argument the street-name blades use for their border -- a
 * 16 mm bar is one pixel at 9 m and gone, so the thing that reads at the
 * distance a fence is looked at from is a *bar* rather than the bar's true
 * width. The gaps are still 72 mm, which is two thirds of the fence, so what the
 * silhouette gives back is still mostly garden.
 */
const IRON: OpenStyle = {
  slot: 'fence_iron',
  pitch: 0.11,
  duty: 0.35,
  height: 0.9,
  railLow: [0.06, 0.14],
  railHigh: [0.68, 0.78],
  // The bars run on past the top rail as points. 0.55 of the bar's own width, so
  // a 38 mm bar tapers to a 21 mm spear -- and because it is a duty rather than
  // a taper it costs one `mix` and no geometry.
  finialDuty: 0.55,
  paint: [
    [0.024, 0.024, 0.026],
    [0.019, 0.026, 0.021],
  ],
  barVariation: 0.10,
  // Old enamel over iron, gone chalky. Not a conductor at any roughness: a
  // metallic palisade takes a specular lobe off the sun and a street of them
  // flares like chrome.
  roughness: 0.62,
  metalness: 0.0,
};

/**
 * Timber pickets, and here the paint IS the object.
 *
 * A picket fence that is not white is a fence. Both tones are therefore whites,
 * and both sit above rho 0.42, which is where the tone curve compresses -- the
 * same compression `facade.PAINT_PALETTE` documents at length. Through the same
 * chain:
 *
 *   white gloss      rho 0.690   sun rgb(245, 247, 247) Y' 247   shade rgb(176, 169, 161) Y' 170
 *   old cream        rho 0.613   sun rgb(246, 241, 225) Y' 241   shade rgb(171, 159, 140) Y' 160
 *
 * Six code values apart in sun and ten in shade, which is again below what a
 * viewer resolves and is what makes a mid-fence tone change harmless. And the
 * compression is not a fault here for the same reason it is not on a painted
 * wall: what makes a picket fence read is not the difference between two whites,
 * it is the alternation between a sunlit picket and what is behind the gap
 * beside it -- 123 code values against sunlit foliage and 109 against shaded,
 * which is the largest contrast any surface in this build carries at eye level.
 *
 * 55% duty on a 140 mm pitch is a 77 mm picket with a 63 mm gap, which is very
 * close to the real 70/60 -- a timber picket is wide enough not to need the
 * over-scaling the iron does.
 */
const TIMBER: OpenStyle = {
  slot: 'fence_timber',
  pitch: 0.14,
  duty: 0.55,
  height: 1.0,
  railLow: [0.10, 0.19],
  railHigh: [0.72, 0.81],
  // Square-topped: a picket fence's rail is behind the pickets and the pickets
  // run to the top of the panel.
  finialDuty: 1.0,
  paint: [
    [0.700, 0.690, 0.660],
    [0.660, 0.610, 0.500],
  ],
  // Twice the iron's, because a painted timber fence weathers picket by picket
  // -- one board takes the sun and the next is under a shrub -- and that
  // per-board value scatter is most of what stops a white fence reading as a
  // white bar.
  barVariation: 0.20,
  roughness: 0.72,
  metalness: 0.0,
};

/**
 * The palisade and the picket: one pipeline each, out of one factory.
 *
 * They differ in six constants and share every line of graph, which is the whole
 * argument for a factory rather than two files -- and they are two *slots*
 * rather than one because the style is a per-building choice the pipeline makes
 * and a slot is the only way it can say so without a parameter fetch. See
 * `mesh.MATERIALS`.
 */
export function createFenceOpenMaterial(style: OpenStyle): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = style.slot;

  // The mask lives in the colour node's alpha, and it has to: that is the only
  // channel `Renderer._getShadowNodes` carries into the depth pass. See the
  // header.
  material.alphaTest = 0.5;
  material.alphaToCoverage = true;

  const tone = mix(
    vec3(...style.paint[0]),
    vec3(...style.paint[1]),
    step(float(0.5), cellRoll(11.3)),
  );

  const shape = Fn(() => {
    const co = uv();
    const px = max(fwidth(co.x), fwidth(co.y));

    // Where in its own bar this fragment is, and which bar that is. One `fract`
    // and one `floor` on the same division, which is the whole cost of the
    // pattern.
    const cell = co.x.div(style.pitch);
    const withinBar = fract(cell);
    const barIndex = floor(cell);

    // A bar is narrower above the top rail than below it, which is what turns a
    // row of bars into a palisade with points on it. `duty` is measured about
    // the centre of the cell so that narrowing it keeps the bar where it was
    // instead of sliding it along the fence.
    const duty = mix(
      float(style.duty),
      float(style.duty * style.finialDuty),
      step(float(style.railHigh[1]), co.y),
    );
    const half = duty.mul(0.5);
    const offset = abs(withinBar.sub(0.5));
    // Widened to the pixel footprint on the way out, so that the LAST resolvable
    // state before the fade takes over is a bar of about the right area rather
    // than a bar that has thinned to nothing. `alphaToCoverage` turns the soft
    // edge into real coverage in the main pass; in the shadow pass, which is not
    // multisampled, the same edge is cut at 0.5 and is the analytic bar.
    //
    // WRITTEN LOW-EDGE-TO-HIGH AND INVERTED, not as `smoothstep(hi, lo, x)`:
    // WGSL leaves `smoothstep` undefined when the low edge exceeds the high one,
    // and it is the kind of thing that works on one driver. The same warning
    // `facade.resolves` and `awning.soffitMask` carry, and it was written the
    // wrong way round here first -- the generated WGSL is what caught it.
    const edge = min(max(px.div(style.pitch), float(0.002)), float(0.25));
    const bar = smoothstep(half.sub(edge), half.add(edge), offset).oneMinus();

    // The rails, which are solid all the way along and are what makes the two
    // sides of a gap look like the two sides of a gap rather than like a comb.
    const rails = step(float(style.railLow[0]), co.y)
      .mul(step(co.y, float(style.railLow[1])))
      .add(step(float(style.railHigh[0]), co.y).mul(step(co.y, float(style.railHigh[1]))));

    // Below grade the panel is solid, so nothing shows daylight under a fence
    // where the ground falls away between two terrain stations -- and so the
    // shadow it throws starts at the ground rather than 60 mm above it.
    const buried = step(co.y, float(0.0));

    // ...and a post is solid everywhere, on all five of its faces. See `POST_U`:
    // a post is narrower than one picket pitch, so without this the gate posts
    // -- the two pieces of this object that say "this gap is a way in" -- come
    // out as a pair of shredded slivers.
    //
    // A style with `post` set folds its line posts in here, for the same reason
    // and with the same consequence: a post is solid, and it keeps its own paint
    // all the way out instead of being averaged with what is behind the fence.
    const geometryPost = step(co.x, float(POST_U));
    const post = style.post
      ? max(
          geometryPost,
          step(
            abs(fract(co.x.div(style.post.pitch)).sub(0.5)),
            float(style.post.width / style.post.pitch / 2),
          ),
        )
      : geometryPost;

    const drawn = max(max(max(bar, rails), buried), post).clamp();

    // ...and once the pitch stops resolving, the mask goes solid rather than
    // flickering. `resolves` at its default band holds full detail to six
    // samples a period and is gone by two: on the iron's 110 mm that is roughly
    // 100 m to 320 m through this build's own footprint-to-distance figure, and
    // in the shadow pass -- where the footprint is a 10.7 cm shadow texel -- it
    // is zero at every distance, which is why a palisade's shadow is a bar.
    const held = resolves(style.pitch, px);
    const mask = max(drawn, held.oneMinus());

    // The colour the solid strip converges on is the area-weighted average of
    // the paint and what was behind it, so the fence gets quieter with distance
    // instead of getting *bigger*, which is what letting it go solid in its own
    // paint would have done.
    const perBar = hash21(vec2(barIndex, 3.7)).sub(0.5).mul(style.barVariation).add(1.0);
    const near = tone.mul(perBar);
    const far = mix(vec3(...(style.behind ?? BEHIND)), tone, float(style.duty));
    // A post is exempt from the convergence as well as from the mask: it really
    // is solid paint, so it should keep its own colour all the way out rather
    // than being averaged with a garden that is not behind it.
    const albedo = mix(far, near, max(held, post));

    // The rail's own shadow line, where the bars pass behind it. One dark line
    // and it is the only depth cue a zero-thickness strip has.
    const railShade = softLine(abs(co.y.sub(float(style.railHigh[0]))), 0.012, 0.30, px);

    return vec4(albedo.mul(railShade), mask);
  })();

  material.colorNode = shape;
  material.roughnessNode = float(style.roughness);
  material.metalnessNode = float(style.metalness);
  return material;
}

export const FENCE_IRON = IRON;
export const FENCE_TIMBER = TIMBER;

/* ===========================================================================
 * The rail corridor boundary fence
 * ======================================================================== */

/**
 * What is behind a rail fence, which is not a garden.
 *
 * Ballast, cess and the shadowed side of a formation, area-averaged: darker and
 * far less saturated than `BEHIND`, because there is nothing green in a rail
 * corridor and the dominant surface in it is crushed basalt at rho 0.055. Using
 * the garden's remainder here would make every corridor in the city converge on
 * a warm olive band at 150 m, which is the one thing a railway is not.
 */
const RAIL_BEHIND: readonly [number, number, number] = [0.075, 0.076, 0.078];

/**
 * The corridor boundary fence: 1.8 m of galvanised weldmesh on line posts.
 *
 * ---------------------------------------------------------------------------
 * **The absence of this object is most of why a Sydney rail corridor rendered
 * as a car park.** Every metre of running line in this city is fenced -- it is a
 * legal requirement, not a stylistic one -- and the fence is the single edge
 * that says "the ground stops here and a railway begins". Ballast without it is
 * a gravel yard; ballast with it is a railway, at any distance you can resolve
 * a 1.8 m vertical from.
 *
 * It is a **weldmesh** rather than the garden palisade, and the three constants
 * that make it one are the pitch, the duty and the height. Sydney's corridor
 * fence is a 2.4 m bay of 50 x 200 mm mesh between galvanised posts; at 65 mm
 * on a 200 mm pitch the verticals are over-scale on the palisade's own argument
 * -- a 5 mm wire is nothing at any distance a corridor is looked at from -- and
 * the 32% duty is what keeps the silhouette mostly see-through, which is what a
 * mesh fence does and a hoarding does not.
 *
 * Galvanising, not paint: rho 0.34 at a roughness that is neither a mirror nor a
 * matte, weathered to the flat pale grey every one of them goes within a year.
 * Through `sky/calibration.ts`'s chain at 3 pm on 15 February, on a vertical
 * wire square-on to the sun, sunlit rgb(208, 211, 213) Y' 210 and shaded
 * rgb(121, 118, 118) Y' 119 -- which is *lighter than the ballast behind it by
 * 150 code values*, and that contrast is the whole of the read. The two tones
 * differ by six values and are the same tone, on `IRON`'s argument.
 *
 * The rails sit at 0.12 and 0.95 rather than at the garden fence's proportions,
 * because a corridor fence has one mid rail and a top rail and the top rail is
 * the line the eye follows for a kilometre.
 */
const RAIL_FENCE: OpenStyle = {
  slot: 'fence_rail',
  pitch: 0.2,
  duty: 0.32,
  height: 1.8,
  railLow: [0.1, 0.17],
  railHigh: [1.68, 1.78],
  // Square-topped. A corridor fence's mesh runs to the top rail and stops; the
  // barbed outriggers that sit above it at depots are a different object and are
  // not what runs past a suburban platform.
  finialDuty: 1.0,
  paint: [
    [0.335, 0.342, 0.345],
    [0.312, 0.315, 0.322],
  ],
  // Half the palisade's. Galvanising weathers evenly -- it is one dip, not
  // eighty separately painted boards -- so wire-to-wire scatter is small, and a
  // large one on a 200 mm pitch reads as noise rather than as wire.
  barVariation: 0.06,
  roughness: 0.58,
  // Matte-grey zinc rather than a conductor, on `IRON`'s argument: a metallic
  // fence takes a specular lobe off the sun and 300 km of it flares like chrome.
  metalness: 0.0,
  post: { pitch: 2.8, width: 0.11 },
  behind: RAIL_BEHIND,
};

/**
 * The corridor fence material, and the one thing it does that the garden fences
 * do not: it is **double-sided**.
 *
 * `world/rail-geo.ts` builds this strip itself, one quad per eight metres, and a
 * player walks along both sides of a railway. The pipeline's garden fences are
 * emitted as two back-to-back faces by `fences.py`, which is the cheaper answer
 * when the geometry is baked; a runtime builder that did the same would double
 * the corridor's quad count for a surface nobody can see two of at once.
 */
export function createRailFenceMaterial(): MeshStandardNodeMaterial {
  const material = createFenceOpenMaterial(RAIL_FENCE);
  material.side = DoubleSide;
  return material;
}

/** The fence's own height, so the builder and the mask cannot disagree. */
export const RAIL_FENCE_HEIGHT = RAIL_FENCE.height;

/* ===========================================================================
 * The masonry fence
 * ======================================================================== */

/**
 * Rendered masonry, in three tones that are one tone.
 *
 * A 0.75 m front fence in Sydney is a single-brick wall with a cement render on
 * it, painted -- or bagged and left, which weathers to the same warm grey. It is
 * the commonest of the three styles by a distance and the one that reads
 * furthest, because it is the only one of the three with a continuous sunlit
 * face and a horizontal top on it. Through the chain in `sky/calibration.ts` at
 * 3 pm on 15 February, on the street face:
 *
 *   painted render   rho 0.468   sun rgb(236, 237, 233) Y' 236   shade rgb(146, 138, 129) Y' 139
 *   sand render      rho 0.359   sun rgb(222, 214, 198) Y' 215   shade rgb(131, 119, 102) Y' 120
 *   bagged grey      rho 0.318   sun rgb(201, 203, 205) Y' 203   shade rgb(117, 111, 107) Y' 112
 *
 * Thirty-three code values across the three in sun, twenty-seven in shade, and
 * the worst adjacent step -- which is what a lattice crossing on a long wall
 * actually costs -- is twenty-one and nineteen. That is above the dozen this
 * project uses as the bar for "a viewer stops resolving it", and it is left
 * there rather than compressed for two reasons: only about a third of fences
 * cross a cell at all at 40 m, and the ones long enough to are the block-of-
 * flats walls where a tone change reads as the repaint it looks like.
 *
 * ALL THREE SIT WELL BELOW `PAINT_PALETTE`'s warm white at rho 0.700, and that
 * is what makes a fence separate from the paving it stands on. Sunlit footpath
 * concrete renders at Y' 248 -- an up-facing surface takes `sin(57)` of the beam
 * where a vertical one takes `cos(57)`, so the path is the brighter object
 * despite the lower albedo -- and a fence at the wall slot's rho would have come
 * out within six code values of it. At these values the lightest is 12 down and
 * the darkest 45. It is also simply true: a front fence is the dirtiest painted
 * surface on a property, at splash height, taking the street's dust, and nobody
 * repaints it when they repaint the house.
 */
const MASONRY_TONES: readonly (readonly [number, number, number])[] = [
  [0.480, 0.468, 0.432],
  [0.395, 0.355, 0.288],
  [0.322, 0.318, 0.310],
];

/** Panel height, matching `fences.MASONRY.height`. */
const MASONRY_HEIGHT = 0.75;

/**
 * The coping, and it is the whole reason this is not a flat grey strip.
 *
 * A rendered fence is capped -- with a precast concrete coping, a bullnosed
 * brick course, or a run of render turned over the top -- and the cap is
 * *lighter* than the wall under it, because it is newer, it is washed by every
 * rain, and it is the one part of the object with the sky on it. Under it is a
 * shadow line where the cap oversails by 15 or 20 mm.
 *
 * Together those two are the entire silhouette of a masonry fence at fifty
 * metres: a pale line, a dark line under it, and the wall. Without them a
 * masonry fence and a shaded footpath are the same rectangle.
 *
 * On the lightest tone, through the chain: the coping's street face lands at
 * sunlit rgb(241, 242, 238) Y' 241 against the wall's Y' 236 and the splashed
 * base's Y' 227, and its up-facing top at rgb(247, 249, 247) Y' 248 -- which is
 * the sunlit footpath's own value, and correctly so, because it is the same
 * material in the same orientation. In shade the cap is Y' 149 over a wall at
 * 139 and a base at 129.
 */
const COPING = { depth: 0.055, lift: 1.14, shadow: 0.026 } as const;

/**
 * The splash zone: how far up the wall the dirt reaches and how dark it gets.
 *
 * 250 mm of a garden wall is rain bouncing off a concrete path, and it is the
 * one weathering term this surface genuinely needs -- a front fence is at the
 * exact height where everything that is thrown up off a footpath lands. Worth
 * nine code values at the base in sun and ten in shade, which is a soft gradient
 * rather than a band.
 */
const SPLASH = { reach: 0.25, depth: 0.13 } as const;

export function createFenceMasonryMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'fence_masonry';

  // A chain of steps on one roll, the same construction `awning.ts` uses to pick
  // a fascia ground and `finishSteelRoof` to pick a steel family: there is no
  // texture on this path and two mixes are cheaper than any way of avoiding
  // them. Uniform over the three.
  const roll = cellRoll(5.9);
  const tone = mix(
    mix(vec3(...MASONRY_TONES[0]), vec3(...MASONRY_TONES[1]), step(float(1 / 3), roll)),
    vec3(...MASONRY_TONES[2]),
    step(float(2 / 3), roll),
  );

  material.colorNode = Fn(() => {
    const co = uv();
    const px = max(fwidth(co.x), fwidth(co.y));

    // THE TOP OF THE WALL IS TOLD FROM THE FACE OF IT BY THE NORMAL, which is
    // the same discriminator `awning.ts` uses to separate a soffit from a fascia
    // and is exact here for the same reason: every face this slot carries is
    // emitted axis-aligned, so the true values are 1 on a coping or a pier cap
    // and 0 on a wall face, and the band this smoothsteps across is never
    // sampled.
    //
    // It is not optional. `mesh._add_face` gives the coping's own top face a `v`
    // running 0 to the wall's 0.23 m thickness -- there is nowhere else for it
    // to run -- and 0 to 0.23 lands squarely inside the 0.25 m splash zone
    // below, so without this the brightest surface on the object would render as
    // its dirtiest.
    const up = smoothstep(float(0.55), float(0.80), normalWorld.y);

    // The cap band on the two vertical faces: the last 55 mm of the wall, where
    // a precast coping or a bullnosed course sits.
    const capBand = smoothstep(
      float(MASONRY_HEIGHT - COPING.depth).sub(px),
      float(MASONRY_HEIGHT - COPING.depth).add(px),
      co.y,
    );
    const cap = max(capBand, up);
    // ...and the shadow line under it, where the cap oversails the wall. Written
    // with `softLine` so it converges on a slight darkening instead of crawling
    // once 26 mm is under a pixel, which is about 15 m.
    const drip = softLine(
      abs(co.y.sub(float(MASONRY_HEIGHT - COPING.depth))),
      COPING.shadow,
      0.34,
      px,
    );

    // The splash zone, and a slight lift over the whole height so a long wall is
    // not one flat value -- a metre-scale mottle, which is what render on
    // blockwork does. One hash on world XZ at a 1.3 m cell; no octaves, because
    // at this size a second one is invisible and this shader is drawn on ten
    // thousand objects.
    const splash = smoothstep(float(0.0), float(SPLASH.reach), co.y)
      .oneMinus()
      .mul(SPLASH.depth)
      .oneMinus();
    const mottle = hash21(floor(vec2(positionWorld.x, positionWorld.z).div(1.3)))
      .sub(0.5)
      .mul(0.07)
      .add(1.0);

    const wall = tone.mul(splash).mul(mottle).mul(drip);
    return mix(wall, tone.mul(COPING.lift), cap);
  })();

  // Painted render, flat: a garden wall is done in a low-sheen exterior acrylic
  // and then left for twenty years. Slightly smoother on the cap, which is
  // either precast or a trowelled render finish and is the one part of the
  // object that is still sound.
  material.roughnessNode = float(0.88);
  material.metalnessNode = float(0.0);
  return material;
}
