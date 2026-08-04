/**
 * The signage fascia and soffit of a footpath awning.
 *
 * Spec 7.7 asks for "continuous cantilevered awnings over the footpath on every
 * retail strip" and 6.3 for a "continuous awning at 3.2 m" on the ground-floor
 * override. The geometry is `mesh.AwningNetwork` in the pipeline: a 450 mm slab
 * cantilevered 2.6 m off every street-facing edge of a retail building, with its
 * top face on `roof_steel` -- that slot is the corrugated-sheet shader and an
 * awning roof is a sheet roof -- and its soffit, fascia and end caps here.
 *
 * TWO SURFACES, ONE PIPELINE, TOLD APART BY THE NORMAL. `normalWorld.y` is
 * exactly -1 on the soffit and exactly 0 on the fascia and the end caps, because
 * every one of them is emitted axis-aligned by `mesh._awning_run`. That is the
 * same discriminator `facade.flatRoofNode` uses on the precast slot, but here it
 * is written for geometry this pass owns end to end rather than inferred after
 * the fact, and there is no third case for it to get wrong.
 *
 * WHY THIS IS ITS OWN SLOT rather than `render_painted`, which is where the
 * roofline pass put its soffits. Two reasons, and the first is fatal:
 *
 *   The wall pipelines read UV.v as height above the building's pad, and that is
 *   what the window grammar divides into storeys. A soffit at v = 3.2 on a
 *   retail building -- ground storey 4.2 m, shopfront sill 0.35, head 3.45 -- is
 *   INSIDE the opening. Every awning in Sydney would grow plate glass on its
 *   underside. Handing it world-XZ UVs instead is the trick the flat roof caps
 *   use (see `facade.flatRoofNode`) and it does close the window field, because
 *   local Z is negative; but the plinth, the contact toe and the soiling ramp
 *   all bottom out down there and multiply to 0.503, so the soffit would arrive
 *   at half the albedo of the wall beside it because three unrelated gradients
 *   ran off their bottom ends together.
 *
 *   And `concrete_precast`, which does have a normal-gated flat path, gates it on
 *   `smoothstep(0.55, 0.80, normalWorld.y)`. A soffit's normal is (0, -1, 0). It
 *   fails the gate and falls through to the same wall path in grey.
 *
 * The fascia needed a slot of its own regardless, for a reason nothing else in
 * the world has: its colour is per SHOP, not per building. Awnings on adjacent
 * titles butt into one another and read as one canopy, and the paint on the
 * front of that canopy changes at shopfront widths that have nothing to do with
 * where one building ends. So this slot reads no parameter atlas and carries no
 * `_BLDIDX` at all -- the colour is a hash of world position on an 8 m lattice.
 *
 * NO TEXT, and that is a decision rather than a limit. A fascia is 450 mm deep
 * and read from across a street; what survives at that size is a band of
 * lettering, not letters. Drawing a band is honest and drawing glyphs at four
 * pixels tall is mud.
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
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { resolves, softLine } from './facade.ts';

/**
 * The shop lattice: how far you walk before the fascia changes colour.
 *
 * 8 m is a Sydney shopfront -- a terrace-derived retail strip runs 4 to 6 m of
 * frontage and a supermarket or a bank runs twenty, and a single lattice cannot
 * have both, so this is the modal one. Hashed on world XZ rather than along the
 * run, because the run has no origin a neighbouring building could agree with:
 * two awnings that merge into one canopy have separate `u` accumulators, and a
 * lattice in world space is the only thing that makes the join invisible.
 *
 * The cost of an axis-aligned lattice is that a fascia running at 45 degrees
 * crosses a cell boundary every 5.7 m rather than every 8. That is still a
 * shopfront, so it is left alone.
 */
const SHOP_CELL = 8.0;

/**
 * Muted signage colours, **linear albedos**, on the same measurement basis as
 * `facade.MATERIAL_LOOK` and `facade.PAINT_PALETTE`.
 *
 * What a Sydney retail fascia is painted: a dark saturated ground with light
 * lettering on it, or cream with dark lettering. Nothing bright, because a
 * fascia is enamel over fibre cement that was last done in about 1994, and
 * nothing mid-toned, because a mid-toned fascia has nowhere to put the letters.
 *
 * Predicted display values through the chain in `sky/calibration.ts` -- linear
 * radiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode -- at
 * 3 pm on 15 February. `sunlit` is a fascia square-on to the sun; `shaded` is
 * the other side of the same street, square-on to the bounce:
 *
 *   deep green   rho 0.050   sun rgb( 49,  89,  63) Y'  79   shade rgb(  6,  35,  14) Y'  27
 *   burgundy     rho 0.037   sun rgb(118,  34,  54) Y'  53   shade rgb( 58,   3,  16) Y'  16
 *   navy         rho 0.033   sun rgb( 33,  57, 114) Y'  56   shade rgb(  3,  18,  52) Y'  17
 *   cream        rho 0.553   sun rgb(247, 241, 220) Y' 241   shade rgb(149, 140, 122) Y' 141
 *   black        rho 0.032   sun rgb( 52,  54,  54) Y'  54   shade rgb( 10,   8,   6) Y'   8
 *   rust red     rho 0.068   sun rgb(156,  73,  48) Y'  89   shade rgb( 79,  26,   5) Y'  36
 *
 * THE SPREAD IS THE POINT AND IT IS ENORMOUS: 8 to 241 in shade, on a surface
 * every one of which is at the same height on the same street. A retail strip's
 * fascias are the highest-contrast row of anything in the city -- more than the
 * walls, which `PAINT_PALETTE` documents compressing into 34 code values in full
 * sun -- and that is exactly what makes a shopping street read as shops rather
 * than as a wall with a shelf on it. The draw is uniform over the six, so cream
 * is the ground a sixth of the time; five dark grounds against one light one is
 * what the street actually is.
 */
const FASCIA_PALETTE: readonly { name: string; colour: [number, number, number] }[] = [
  { name: 'deep green', colour: [0.030, 0.058, 0.036] },
  { name: 'burgundy', colour: [0.092, 0.021, 0.029] },
  { name: 'navy', colour: [0.021, 0.031, 0.082] },
  { name: 'cream', colour: [0.600, 0.552, 0.430] },
  { name: 'black', colour: [0.032, 0.032, 0.031] },
  { name: 'rust red', colour: [0.160, 0.044, 0.028] },
];

/**
 * The lettering band, in the two tones it has to come in.
 *
 * Contrast-picked rather than fixed, and it has to be: a light band on a cream
 * fascia lands at Y' 245 against Y' 241, which is nothing at all -- the same
 * failure the one-tone version of this had before it was measured. So the band
 * takes the light tone on the five dark grounds and the dark tone on cream,
 * decided by the ground's own luminance.
 *
 *   light band   rho 0.541   sun rgb(246, 245, 241) Y' 245   shade rgb(144, 138, 133) Y' 139
 *   dark band    rho 0.043   sun rgb( 72,  71,  69) Y'  71   shade rgb( 19,  15,  10) Y'  15
 *
 * On navy that is 17 against 139 in shade, and on cream 141 against 15. Both
 * read from across a street, which is the only distance this is drawn for.
 */
const BAND_LIGHT: [number, number, number] = [0.560, 0.540, 0.500];
const BAND_DARK: [number, number, number] = [0.045, 0.043, 0.040];
/** Below this luminance the ground is dark and takes the light band. */
const BAND_SWITCH = 0.20;

/**
 * Where the band sits on the 450 mm fascia and how much of it there is.
 *
 * Centred a little high (0.145 to 0.315 of 0.45, so 62 mm above centre) because
 * signwriting is set above the middle of a fascia -- there is a shadow line
 * along the bottom edge and nobody paints into it.
 *
 * Half the fascias get one. A strip where every shop has the same band is a
 * pattern; a strip where half do is a street, and the ones without it are the
 * places that painted their name on the glass instead.
 */
const BAND = { lo: 0.145, hi: 0.315, share: 0.5 } as const;

/**
 * The fascia's depth, metres. `mesh.AWNING_SLAB` on the pipeline side -- the same
 * number stored twice, because the UV the pipeline writes runs 0 to exactly this
 * and everything positioned on the fascia is a fraction of it.
 */
const FASCIA_DEPTH = 0.45;

/**
 * The soffit: painted lining board, and the one surface in the world lit by a
 * single term.
 *
 * A down-facing normal takes the hemisphere at weight `0.5 * N.y + 0.5` = 0,
 * which is pure `GROUND_FILL`, and the bounce light arrives from 16 degrees
 * ABOVE the horizon so `max(0, N.L)` clamps it to nothing. There is no direct
 * sun on a soffit at any hour. So the whole of a soffit's appearance is its
 * albedo times `GROUND_FILL * HEMISPHERE_DAY` = (0.68, 0.561, 0.391), and that
 * is why this value is picked against that one illuminant rather than against
 * daylight:
 *
 *   lining board rho 0.641                        rgb( 67,  55,  31)  Y'  56
 *
 * WHICH IS THE SAME NUMBER THE ROOFLINE PASS'S EAVE SOFFITS ALREADY RENDER AT
 * -- `render_painted` at 0.95 soiling on a down-facing normal comes out at
 * rgb(67, 56, 30), Y' 56 -- and the match is deliberate. Every soffit in the
 * city is this value because the light rig gives a down-facing surface exactly
 * one term, and an awning that special-cased itself brighter would be the one
 * soffit in Sydney that glowed.
 *
 * FOLLOW-UP, named rather than taken: a real awning soffit's dominant illuminant
 * is the sunlit footpath a metre below it, and this rig cannot deliver that --
 * `BOUNCE_ALTITUDE` puts the bounce light where a down-facing surface can never
 * see it. A ground-bounce term aimed UP would lift every soffit, every balcony
 * underside and every eave in the world together, which is a light-rig change
 * and belongs in `sky/calibration.ts`, not in one material.
 */
const SOFFIT = [0.660, 0.645, 0.610] as [number, number, number];

/** Lining board module. 300 mm boards, laid parallel to the street. */
const BOARD = 0.30;

/**
 * How far the soffit darkens back into the wall junction.
 *
 * A real awning is darkest where it meets the shopfront, because that corner
 * sees least of the sky and none of the road. Worth about eight code values
 * over the first 350 mm, which is a soft edge rather than a line and is the only
 * thing separating an awning from a flat grey ceiling when you stand under one.
 */
const JUNCTION = { reach: 0.35, depth: 0.14 } as const;

/** Same construction as `facade.hash21`, which is not exported. */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h).mul(43758.5453123));
});

/**
 * The awning material: one pipeline, two surfaces, no parameter fetch.
 *
 * Called once for the whole game like every other slot. Compiles to rather less
 * than a facade -- there is no window grid, no parallax and no atlas read, which
 * is the whole reason this is not `createFacadeMaterial` with a flag on it.
 */
export function createAwningMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = 'awning_fascia';

  /**
   * 1 on the soffit, 0 on the fascia and the end caps.
   *
   * All three are emitted axis-aligned by `mesh._awning_run`, so the true values
   * are exactly -1 and exactly 0 and the band this gates across is never
   * sampled. It is a smoothstep rather than a step only so that an awning on a
   * raked frontage -- which nothing emits today -- would degrade into the fascia
   * treatment rather than flicker between the two.
   *
   * Written with its edges in increasing order and inverted afterwards, rather
   * than as `smoothstep(-0.35, -0.75, y)`: WGSL leaves `smoothstep` undefined
   * when the low edge exceeds the high one, and that is the kind of thing that
   * works on one driver. Same warning `facade.resolves` carries.
   */
  const soffitMask = smoothstep(float(-0.75), float(-0.35), normalWorld.y).oneMinus();

  /**
   * Which shop this fragment belongs to, from world position on the 8 m lattice.
   *
   * World rather than tile-local, and that is load-bearing: a canopy crossing a
   * tile line has to keep its colour, and tile-local geometry plus a group
   * translation means only `positionWorld` is continuous across the seam.
   */
  const cell = floor(vec2(positionWorld.x, positionWorld.z).div(SHOP_CELL));
  const shopRoll = hash21(cell);
  const bandRoll = hash21(cell.add(vec2(37.3, 11.9)));

  const shared = Fn(() => {
    // The ground colour: a chain of steps on one roll rather than a lookup,
    // which is the same construction `finishSteelRoof` uses to pick a steel
    // family and for the same reason -- there is no texture on this path and
    // five mixes is cheaper than any way of avoiding them. Uniform over the six,
    // so cream is a sixth of the fascias.
    const ground = vec3(...FASCIA_PALETTE[0].colour).toVar();
    for (let i = 1; i < FASCIA_PALETTE.length; i++) {
      ground.assign(
        mix(ground, vec3(...FASCIA_PALETTE[i].colour), step(float(i / FASCIA_PALETTE.length), shopRoll)),
      );
    }
    return ground;
  })();

  material.colorNode = Fn(() => {
    const co = uv();
    const px = max(fwidth(co.x), fwidth(co.y));

    // --- Fascia
    //
    // The lettering band. Its edges are hard on purpose -- signwriting has a cut
    // edge, not a gradient -- so both are one pixel footprint wide and no more.
    //
    // BOTH SMOOTHSTEPS RUN LOW-EDGE-TO-HIGH and the upper one is inverted, for
    // the reason `soffitMask` above states: WGSL leaves `smoothstep(hi, lo, x)`
    // undefined and it is the kind of thing that works on one driver. The
    // widening is also clamped, because `px` grows without limit as the strip
    // recedes and an unclamped edge would swallow the band's own 170 mm and
    // paint every fascia in the distance the band's colour instead of the
    // ground's -- the exact opposite of what fading is for.
    const edge = min(max(px, float(0.004)), float(0.05));
    const inBand = smoothstep(float(BAND.lo).sub(edge), float(BAND.lo).add(edge), co.y).mul(
      smoothstep(float(BAND.hi).sub(edge), float(BAND.hi).add(edge), co.y).oneMinus(),
    );

    // ...and once the band stops resolving, every fragment converges on the
    // band's own *coverage* rather than on nothing. A fascia past the distance
    // where 170 mm is a pixel is genuinely 38% band and 62% ground, and fading
    // to zero the way a weathering pattern does would make a whole strip of
    // signage quietly disappear into its own backing colour.
    const coverage = (BAND.hi - BAND.lo) / FASCIA_DEPTH;
    const band = mix(float(coverage), inBand, resolves(BAND.hi - BAND.lo, px)).mul(
      step(bandRoll, float(BAND.share)),
    );

    // Light band on a dark ground, dark band on a light one. Measured; see
    // BAND_LIGHT.
    const groundLum = dot(shared, vec3(0.2126, 0.7152, 0.0722));
    const bandColour = mix(
      vec3(...BAND_DARK),
      vec3(...BAND_LIGHT),
      step(groundLum, float(BAND_SWITCH)),
    );

    // The shadow line under the top edge of the fascia, where the slab oversails
    // its own face by a few millimetres. One dark line, and it is what stops the
    // fascia and the top face reading as one folded sheet.
    const capShadow = softLine(abs(co.y.sub(float(FASCIA_DEPTH))), 0.02, 0.35, px);

    const fascia = mix(shared, bandColour, band).mul(capShadow);

    // --- Soffit
    //
    // Lining boards, laid parallel to the street: the soffit's v is metres out
    // from the wall, so a joint at a fixed v is a line running along the shop
    // front, which is how a boarded soffit is laid.
    const toBoard = abs(fract(co.y.div(BOARD)).sub(0.5)).mul(BOARD);
    const boards = softLine(toBoard, 0.012, 0.22, px);
    // ...and the wall junction, darkest where the canopy meets the shopfront.
    const junction = smoothstep(float(0.0), float(JUNCTION.reach), co.y)
      .oneMinus()
      .mul(JUNCTION.depth)
      .oneMinus();
    const soffit = vec3(...SOFFIT).mul(boards).mul(junction);

    return mix(fascia, soffit, soffitMask);
  })();

  // Enamel over fibre cement on the fascia, and flatter paint on the boards
  // above. Neither is a conductor: a painted fascia that took a metallic
  // specular would flare at the sun like the steel above it and stop reading as
  // the painted board it is.
  material.roughnessNode = mix(float(0.58), float(0.86), soffitMask);
  material.metalnessNode = float(0.0);
  return material;
}
