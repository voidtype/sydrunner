/**
 * Street furniture: wheelie bins, street-name blades and traffic signals.
 *
 * `pipeline/sydney/furniture.py` decides where every one of these stands, which
 * lid a bin has, which way a blade points and which lamp is lit; this file is
 * geometry, tone and instancing. Three items from spec 7.7, chosen on the same
 * argument spec 7.2 makes about the power lines -- each is a *sign* that this is
 * Sydney, and none of them costs more than sixty triangles.
 *
 * ---------------------------------------------------------------------------
 * THE BIN, and why it is two meshes rather than one.
 *
 * A 240 L MGB is a dark green body with a coloured lid, and the *lid* is the
 * whole feature: red, yellow and green on the same body is Australian domestic
 * infrastructure and nothing else in the world reads it. So the lid has to be
 * per instance, and a `NodeMaterial` gives exactly one per-instance colour --
 * `instanceColor` -- which multiplies the *whole* mesh. Tinting one geometry
 * three ways therefore tints the body three ways too, and a red bin with a red
 * body is a red bin, which is not a thing.
 *
 * Two ways out. `cars.ts` and `power.ts` take the first: one geometry per
 * variant, one `InstancedMesh` each, three draws. This takes the second: the
 * body and the lid are *separate geometries*, so the body's `instanceColor`
 * carries nothing but a tone jitter and the lid's carries the colour. Two draws
 * instead of three, and it stays two if a fourth stream ever appears -- which
 * matters, because the councils keep adding them (purple glass is already out
 * there). The two meshes cannot drift apart: they are built from the same
 * instance loop with the same matrix.
 *
 * ---------------------------------------------------------------------------
 * THE BLADE, in two Sydney styles, with the street's real name on it.
 *
 * A street-name blade is 900 x 200 mm on a thin post about 2.4 m up, and Sydney
 * has two of them. Inside the City of Sydney LGA it is a **bottle green plate
 * with a white legend and a white rule** -- the council's own pattern, the one
 * on the York Street corner. Outside it, across most of the inner south and
 * inner west, it is the older RMS pattern: a **white plate with a black legend
 * and a thin black rule**, which is what the Sydney Park Road corner at St
 * Peters carries. The pipeline decides which per post and writes it as a byte;
 * `furniture.COS_LGA_RADIUS` is the line.
 *
 * The plate itself is what it always was -- one 12-triangle box, one material
 * per style, `step()` on UV for the rule, instanced per tile. At any distance
 * from which you can see the whole intersection a blade is under twenty pixels
 * wide, and what survives there is the *colour and the proportion*: a coloured
 * horizontal sliver with a rule round it, at right angles to another one. That
 * is still the recognition and it is still what carries the city.
 *
 * **The legend is a separate, local thing, and that is forced rather than
 * chosen.** An `InstancedMesh` binds one texture, and 1,439 distinct legends are
 * 1,439 textures, so a named blade cannot be instanced. What makes that
 * affordable is that a legend is only worth drawing where it can be read: the
 * blades within `LABEL_RADIUS` get a four-triangle skin over the plate carrying
 * a canvas texture of their own name, and everything beyond it stays the plain
 * instanced plate it always was. See `BladeLabels` for the bounds -- distance,
 * count and texture reuse, all three -- and `BladeTextCache` for the raster.
 *
 * The skin is a skin rather than a replacement, so the swap has nothing to pop:
 * crossing the radius adds 0.6 mm of paint to an object whose silhouette,
 * shadow and colour are unchanged, and at 140 m that paint is a fifth of a
 * pixel.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNAL, and the one lamp that is lit.
 *
 * A black three-lamp head on a yellow-bordered backing board, on a 4.2 m grey
 * pole, with a deep hood over each lens and a yellow push-button box at hand
 * height. The yellow border is the Australian tell -- it is a retroreflective
 * surround the rest of the world mostly does not use -- and it costs twelve
 * triangles, because the "board" is simply a slightly larger yellow box with the
 * black head standing 15 mm proud of it.
 *
 * The hoods and the button box are the reference photographs' two corrections
 * and they cost 30 triangles between them. A hood is three quads -- a shelf and
 * two cheeks, in a tone darker than the housing -- and what it contributes at
 * any distance is not a shape but a band of shadow across the top of each lens,
 * which is why a Sydney signal head reads as three sunken eyes rather than three
 * discs on a board. The button box contributes the opposite: the one saturated
 * colour below 2 m on a corner, which is what makes a grey pole read as a
 * pedestrian crossing rather than as a bollard.
 *
 * The three lamps in that head are all **dark**: they are part of the head's own
 * geometry, at near-black tints of their own hue, which is what an unlit signal
 * lens looks like. The lit one is a *separate* `InstancedMesh` of a single
 * 8-triangle disc, positioned by its instance matrix at whichever of the three
 * lamp heights the sidecar names and coloured by `instanceColor`. So one draw
 * covers every lit lamp in the tile whatever colour it is, and the aspect is a
 * translation rather than a geometry variant.
 *
 * That disc is **unlit**, and that is the whole reason it reads at midday. A
 * signal lamp is an emitter: its brightness does not depend on which way the
 * head is turned or whether the intersection is in the shadow of a tower, and a
 * lit material would make it depend on both. `MeshBasicNodeMaterial` takes the
 * colour straight to the tone curve, so the green lamp is rgb(65,223,115)
 * against its own housing at rgb(28,30,37) in sun and rgb(8,4,6) in shade --
 * 150 code values either way. The green channel is over 1.0, which a diffuse
 * albedo cannot be; that excess *is* the emissive boost, and it is here rather
 * than in an `emissiveNode` because an unlit material has no other term to add
 * it to.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and each display value beside it was
 * produced by running the chain documented at the top of `sky/calibration.ts` --
 * irradiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode -- at
 * the reference instant of 3 pm on 15 February. The method is checked rather
 * than assumed: the same evaluation reproduces `power.ts`'s published sunlit
 * timber (137,135,130) and unlit wire (7,11,18) exactly.
 *
 * ---------------------------------------------------------------------------
 * Cost. Four shared materials for the whole game and seven shared geometries,
 * plus one material and one 288 x 64 texture per distinct legend on screen. Per
 * tile: **two draws on a residential street** (bin bodies, bin lids), four more
 * only where a tile also has a named corner and a signalised crossing (posts,
 * blades, signal heads, lit lamps), and a fifth blade draw only in the tiles the
 * City of Sydney boundary runs through, which carry both styles.
 *
 * The legends are not per tile at all: they are one pool for the whole scene,
 * capped at `MAX_LABELS` meshes of four triangles each and `LABEL_CACHE_MAX`
 * textures. In the CBD, where the corners are closest together, the 140 m radius
 * admits about 45 blades naming about 20 distinct streets.
 *
 * The inner ring carries 6,863 bins, 2,406 posts with 4,812 blades and 1,305
 * signal heads, at a per-tile median of 35 bins, 13 posts and 9 heads -- about
 * 2,700 triangles against the 40,000 of trees already in the same tile. 1,439
 * distinct legends across the ring; 1,029 posts in City of Sydney green and
 * 1,377 in RMS white. The whole ring's furniture sidecars are 273 kB, of which
 * the legends are 55.
 */

import { Fn, mix, step, uv, vec3 } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
} from 'three/webgpu';
import type { InstanceClaim, InstancePool, PooledSet } from './instancepool.ts';

import {
  LAMP_COUNT,
  LID_COUNT,
  STYLE_COUNT,
  decodeFurniture,
  type TileFurniture,
} from './tile-decode.ts';

/**
 * The sidecar half of this module lives in `world/tile-decode.ts`.
 *
 * `.furn.bin` is the only variable-stride record in the build and its decode is
 * the most expensive of the eight -- 0.15 ms a tile against 0.03 for the next
 * one, because it builds a string per blade. That file carries no `three`
 * import, so `world/decode.worker.ts` can run it off the render thread. The
 * three kind counts come back with it: they are what the decode clamps against,
 * and a second copy of one of them on this side is a table overrun waiting for
 * a pipeline change.
 */
export { LAMP_COUNT, LID_COUNT, STYLE_COUNT, decodeFurniture };
export type { TileFurniture };

/** Must match `furniture.LAMP_*` in the pipeline. */
/** Must match `furniture.STYLE_*` in the pipeline. */
export const STYLE_COS_GREEN = 0;
export const STYLE_RMS_WHITE = 1;

// --- Dimensions shared with the pipeline --------------------------------------
//
// **`furniture.py` holds these same numbers.** They are what makes a cluster of
// bins sit shoulder to shoulder rather than overlapping, and what puts a blade
// at the height the post was placed for.

/** The 240 L MGB: across the lid, front to back, and up to the closed lid. */
const BIN_WIDTH = 0.58;
const BIN_DEPTH = 0.74;
const BIN_HEIGHT = 1.07;
/** Where the body stops and the lid starts. */
const BIN_BODY_TOP = 0.98;

/**
 * Blade plate, and the height of the *upper* blade's centre above the paving.
 *
 * 900 x 200 mm rather than the 900 x 150 this started at, and the arithmetic is
 * in `furniture.BLADE_HEIGHT`: a 150 mm plate at 10 m is 11.1 screen px tall at
 * this project's 72 degree field of view and 1440p at the 0.75 render scale, so
 * its capitals are under 8 and the legend is guessed at rather than read. 200 mm
 * puts the capitals at 10.2 px. Both are real Australian blade sizes.
 */
const BLADE_LENGTH = 0.9;
const BLADE_HEIGHT = 0.2;
const BLADE_MOUNT_Y = 2.4;
/** Half-thickness of the plate. The legend quads stand just proud of this. */
const BLADE_HALF_THICK = 0.012;
/**
 * How far outside the plate's face a legend quad sits, metres.
 *
 * Small enough that nothing about the blade's silhouette changes, large enough
 * that no depth buffer this project runs on can tie. The near plane is 0.1 m and
 * the far 24 km, so a reversed-Z float depth buffer resolves better than a
 * micrometre at the 5-15 m the legend is read at; 0.6 mm is three orders of
 * magnitude clear of that, and it is under the width of the paint on a real
 * blade.
 */
const LABEL_PROUD = 0.0006;
/**
 * How far from the camera a blade gets a real legend, metres.
 *
 * The distance-swap, and the number that decides the whole cost of this feature.
 * Beyond it a blade is the instanced plate and nothing else, which is what the
 * whole city was before the legends and is what still reads at range -- a green
 * or white sliver at right angles to another one. Inside it the plate gains a
 * skin with the name on it.
 *
 * 140 m is well past where a legend is readable -- a 200 mm blade at 140 m is
 * 1.1 screen px tall, so the text is long gone by 40 -- and that is deliberate.
 * The swap has to happen where nobody can see it happen, and a radius set at the
 * legibility limit would be a radius where a player walking toward a corner
 * watches the name resolve out of nothing. Set past it, the name is already
 * there, sub-pixel, and simply becomes readable.
 */
const LABEL_RADIUS = 140;
/**
 * Ceiling on legend meshes alive at once.
 *
 * `LABEL_RADIUS` is generous and Sydney's corners are close together, so the
 * radius alone does not bound the draw calls -- and each legend is its own mesh,
 * because each wears its own texture. This bounds them. When more blades qualify
 * than this, the nearest win, which is the correct thing to drop: the ones lost
 * are the furthest, where the legend was under two pixels and the plate under
 * the skin says the same thing.
 */
const MAX_LABELS = 96;
/**
 * How often the resident legend set is rebuilt, seconds.
 *
 * Once a second, not once a frame. The set is a function of position and
 * position changes slowly relative to what this costs: at a 6 m/s sprint a
 * second is 6 m against a 140 m radius, so the worst a stale set can be is 4%
 * out at its own edge -- where the legend is a pixel. What it saves is the
 * per-post distance loop and the mesh churn, sixty times over.
 */
const LABEL_REBUILD_S = 1.0;
/**
 * Vertical drop from one blade to the next on the same post.
 *
 * Two blades at the same height would intersect at right angles through each
 * other's middle, which is both wrong and the ugliest possible way to be wrong.
 * A real two-name corner stacks them, and this is a blade's height plus the
 * bracket between them.
 */
const BLADE_STACK = BLADE_HEIGHT + 0.04;

/** 65 mm post, and how far it stands over the upper blade. */
const POST_RADIUS = 0.0325;
const POST_HEIGHT = 2.72;

/** Signal pole and head. */
const SIGNAL_POLE_HEIGHT = 4.2;
const SIGNAL_POLE_RADIUS = 0.07;
const SIGNAL_HEAD_WIDTH = 0.3;
const SIGNAL_HEAD_HEIGHT = 0.9;
/** Head centre, below the top of the pole. */
const SIGNAL_HEAD_BELOW_TOP = 0.55;
/** Lamp pitch within the head, and the lens radius. */
const LAMP_PITCH = 0.28;
const LAMP_RADIUS = 0.105;
/**
 * The lamp hood: how far its shelf reaches out past the housing face, how far it
 * falls over that reach, and how far its side cheeks come down.
 *
 * 90 mm of reach on a 210 mm lens is what an Australian signal visor actually
 * is, and it has to clear the lit disc -- which stands 6 mm proud of the dark
 * lens at 0.138 -- or the disc would poke through the shelf. The cheeks stop at
 * 60 mm rather than wrapping the lens, because a full shroud at this size closes
 * the lens up into a dark hole from an oblique approach, which is the one angle
 * a far-side display is most often seen from.
 */
const LAMP_HOOD_DEPTH = 0.09;
const LAMP_HOOD_DROP = 0.012;
const LAMP_HOOD_CHEEK = 0.06;

/**
 * The pedestrian push-button box: across the pole, up it, and out from it, and
 * the height of its centre.
 *
 * 1.1 m is hand height, which is where every one of them in the city is -- and,
 * more to the point for a game seen from 1.7 m, it is low enough to be under the
 * player's eyeline and so is read against the footpath rather than against the
 * sky. The box is small enough that the twelve triangles are the whole cost.
 */
const BUTTON_WIDTH = 0.12;
const BUTTON_HEIGHT = 0.18;
const BUTTON_DEPTH = 0.1;
const BUTTON_Y = 1.1;
/**
 * Height of each lamp above the pole's foot, red at the top. The lit-lamp
 * instance is translated to one of these, which is what lets a single disc
 * geometry serve all three aspects -- see the note at the top.
 */
const LAMP_Y = [
  SIGNAL_POLE_HEIGHT - SIGNAL_HEAD_BELOW_TOP + LAMP_PITCH,
  SIGNAL_POLE_HEIGHT - SIGNAL_HEAD_BELOW_TOP,
  SIGNAL_POLE_HEIGHT - SIGNAL_HEAD_BELOW_TOP - LAMP_PITCH,
];

// --- The palette --------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Wheelie bin body: dark green HDPE.
 *
 *   sun N.L 0.54  rgb( 76,106, 90) Y' 98    grazing N.L 0.30  rgb(48,77,64) Y' 70
 *   shade         rgb( 25, 47, 28) Y' 41
 *
 * Which puts a sunlit bin 145 code values under the sunlit footpath it stands on
 * (238,244,248) -- a dark object on a bright surface, which is what carries the
 * silhouette. In shade it holds Y' 41 against shaded asphalt at Y' 35, and what
 * separates those two is hue rather than value: the bin is green where the road
 * is the bluest thing in the frame.
 */
const BIN_BODY: Rgb = [0.058, 0.092, 0.068];

/**
 * The wheels and the axle housing. Near-black rubber, the same role the tyres
 * play in `cars.ts`: they are the shadow line that stops the bin looking like it
 * is printed on the footpath.
 *
 *   sun rgb(25,27,32)   shade rgb(6,3,3)
 */
const BIN_WHEEL: Rgb = [0.02, 0.02, 0.021];

/**
 * The three lids, carried on `instanceColor` over a white lid geometry.
 *
 * Quoted on the **up-facing** lid, because that is the face you see from a
 * footpath and it is a full 0.84 of the direct beam rather than a wall's 0.54:
 *
 *   red     sun rgb(222, 66, 51) Y'  98    shade rgb( 90,  8,  5) Y'  25
 *   yellow  sun rgb(250,228,111) Y' 224    shade rgb(138,134, 20) Y' 127
 *   green   sun rgb(144,241,123) Y' 212    shade rgb( 35,109, 39) Y'  88
 *   body    sun rgb(102,136,119) Y' 128    shade rgb( 14, 49, 47) Y'  41
 *
 * The number that matters is the last row against the third: a *green* lid on a
 * *green* body is the one pairing that could collapse, and it lands 84 code
 * values apart in sun and 47 in shade, because the lid is a saturated lime and
 * the body is a desaturated bottle green. The red lid is the opposite failure --
 * dark rather than similar -- and it is carried by chroma: at Y' 98 it is no
 * brighter than the body, and it is the only strongly red object on the street.
 */
const LID_COLOURS: Rgb[] = [
  [0.26, 0.03, 0.022], // LID_RED
  [0.62, 0.47, 0.045], // LID_YELLOW
  [0.115, 0.33, 0.075], // LID_GREEN
];

/**
 * City of Sydney blade green, corrected against a photograph of the York Street
 * corner.
 *
 *   sun rgb( 25, 84, 58) Y' 70    grazing rgb(12,63,41) Y' 51    shade rgb(4,42,21) Y' 33
 *
 * This started at AS 2700 G13 emerald -- a mid green that landed at Y' 109 in
 * sun -- and the reference says that is wrong for the city. A City of Sydney
 * blade is a **bottle green**, near enough to AS 2700 G13's darker neighbour
 * G21 "jade" and closer still to the brunswick end of the range: on the York
 * Street plate the field is dark enough that the white legend, not the field,
 * is what carries at distance. Dropping it 39 code values is what puts the
 * white legend 175 clear of its background instead of 136, and it is also what
 * separates a blade from the street trees behind it, which sit at Y' 70-90.
 */
const BLADE_GREEN: Rgb = [0.011, 0.052, 0.026];

/**
 * The white border and legend on the green style.
 *
 *   sun rgb(241,246,245) Y' 245    grazing rgb(216,223,225) Y' 222   shade rgb(166,161,154) Y' 162
 *
 * 175 code values over the field in sun and **129 in shade**, which is the one
 * that matters: half the blades in the city are on the shaded side of a street
 * at any moment, and a border that only worked in sun would leave those as dark
 * rectangles. For scale, this project's own bar for "a viewer stops resolving
 * it" is about a dozen code values.
 */
const BLADE_WHITE: Rgb = [0.62, 0.63, 0.6];

/**
 * The RMS white style: the field, and the black legend and border on it.
 *
 * From the Sydney Park Road plate at St Peters -- a white blade with black
 * uppercase legend and a thin black border, which is what most of the inner
 * south and inner west still carries.
 *
 *   field  sun rgb(236,240,238) Y' 239    grazing rgb(209,215,216) Y' 214   shade rgb(158,153,147) Y' 154
 *   legend sun rgb( 32, 33, 38) Y'  33    shade rgb( 9,  6,  8) Y'   7
 *
 * The field is a shade under `BLADE_WHITE`, deliberately: a painted plate is
 * not the same white as the retroreflective border bead on the green one, and
 * two whites 6 code values apart on the same street is what stops a corner
 * where both styles meet reading as one material.
 *
 * The black is the signal housing's, not pure black. A blade legend that
 * reached 0 would be the only object in the frame with no shading at all.
 */
const BLADE_FIELD_WHITE: Rgb = [0.58, 0.6, 0.585];
const BLADE_BLACK: Rgb = [0.024, 0.024, 0.027];

/**
 * Border thickness in UV, on the blade's two large faces.
 *
 * Not equal on the two axes, because the blade is not square: 0.075 of a 200 mm
 * height is 15 mm and 0.018 of a 900 mm length is 16 mm, which is about as
 * close to a constant-width frame as two numbers get. Both are drawn wider than
 * AS 1742's 10 mm for the reason given at the top of this file -- and this pair
 * only ever draws the *far* blade now, the one past `LABEL_RADIUS` where the
 * legend has stopped resolving and the border is the whole read.
 */
const BORDER_U = 0.018;
const BORDER_V = 0.075;

/**
 * The name post: galvanised steel, weathered.
 *
 *   sun rgb(142,147,152) Y' 146    shade rgb(74,72,71) Y' 72
 *
 * Deliberately lighter than `power.ts`'s timber at Y' 135, and cool where that
 * is warm. The two stand on the same footpaths and a 65 mm galvanised post that
 * read as a small timber pole would make the street look like it has two pole
 * lines down it.
 */
const POST_GREY: Rgb = [0.16, 0.165, 0.17];

/**
 * The signal pole: grey enamel over galvanising, darker than the name post
 * because it is painted rather than bare.
 *
 *   sun rgb(124,129,135) Y' 128    shade rgb(60,58,58) Y' 58
 */
const SIGNAL_POLE: Rgb = [0.125, 0.13, 0.136];

/**
 * The signal head. Matte black, and it has to be genuinely black or the lamps
 * have nothing to read against.
 *
 *   sun rgb(24,26,32) Y' 26    shade rgb(6,3,4) Y' 4
 *
 * Four code values darker than it was, on the reference: the Oxford Street
 * housings photograph as a flat matte black with no sheen at all, and the
 * previous value was reading as a dark charcoal against the hoods now in front
 * of it. Small, and it is the difference between a housing that frames the lamp
 * and one that competes with it.
 */
const SIGNAL_BLACK: Rgb = [0.018, 0.018, 0.02];

/**
 * The lamp hoods -- the deep visors over each lens.
 *
 *   sun rgb(16,17,21) Y' 17    shade rgb(4,2,3) Y' 3
 *
 * Darker again than the housing they stand off, and that is the whole point of
 * them. A hood is a horizontal shelf and two short cheeks in *shadow*, seen
 * against a housing face that is lit; making the geometry darker than the
 * housing as well means the visor reads at a distance where three quads are two
 * pixels, which is where a Sydney signal head gets its particular squinting
 * silhouette from.
 */
const SIGNAL_HOOD: Rgb = [0.011, 0.011, 0.013];

/**
 * The pedestrian push-button box.
 *
 *   sun rgb(247,197,44) Y' 196    shade rgb(160,118,6) Y' 118
 *
 * A slightly warmer, slightly deeper yellow than the backing board's, because
 * the button box is painted rather than retroreflective. At hand height on a
 * grey pole it is the only saturated thing below 2 m on a corner, and it is
 * what makes a signal pole read as a *pedestrian* crossing rather than as a
 * bollard -- which is the whole of its job at 30 triangles.
 */
const SIGNAL_BUTTON: Rgb = [0.55, 0.33, 0.03];

/**
 * The backing board's retroreflective yellow surround.
 *
 *   sun rgb(240,211,58) Y' 206    shade rgb(157,129,9) Y' 126
 *
 * 176 code values over the black head it frames, which is what makes a signal
 * legible as a signal from the far side of an intersection at a size where the
 * lamps themselves are three pixels.
 */
const SIGNAL_YELLOW: Rgb = [0.52, 0.38, 0.035];

/**
 * The two lamps that are *not* lit, at near-black tints of their own hue --
 * which is what an unlit signal lens actually is, a dark coloured glass over a
 * black reflector rather than a hole.
 *
 *   red sun rgb(61,14,3) Y' 23   amber rgb(58,45,1) Y' 45   green rgb(2,47,31) Y' 36
 */
const LENS_DARK: Rgb[] = [
  [0.03, 0.008, 0.006],
  [0.026, 0.017, 0.004],
  [0.005, 0.019, 0.011],
];

/**
 * The lit lamp. **Unlit**, so these are not albedos -- they are the linear
 * radiance leaving the lens, and they go to the tone curve untouched by any
 * light in the scene.
 *
 *   red   rgb(239, 53, 34) Y'  91
 *   amber rgb(244,164, 51) Y' 173
 *   green rgb( 65,223,115) Y' 182
 *
 * Against the black housing they sit in -- Y' 30 in sun, Y' 5 in shade -- and
 * against the sunlit footpath below at Y' 243. The green is *dimmer* than the
 * concrete, which is honest: a signal lamp does not out-glow a footpath at
 * midday. What separates it is chroma, at full saturation against a scene whose
 * brightest surfaces are all neutral, and that is how a green signal reads in a
 * photograph taken at three in the afternoon.
 *
 * Every one of these has a channel over 1.0. That excess is the emissive boost
 * and it is the only place in this file where a colour is not a reflectance.
 */
const LAMP_LIT: Rgb[] = [
  [1.55, 0.09, 0.055],
  [1.85, 0.75, 0.05],
  [0.15, 1.25, 0.34],
];

// --- Geometry -----------------------------------------------------------------

/**
 * Accumulates indexed triangles with a colour per vertex.
 *
 * The same builder `power.ts` uses, down to the two rules that matter: indexed
 * with `material.flatShading` supplying the faceting, because non-indexed
 * geometry with baked face normals triples the vertex count for an identical
 * image; and vertices never shared between two *tones*, because a body and a rim
 * meeting at the same coordinates would gradient into one another.
 */
class PropBuilder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly uv: number[] = [];
  readonly index: number[] = [];

  vertex(x: number, y: number, z: number, c: Rgb, u = 0.5, v = 0.5): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.color.push(c[0], c[1], c[2]);
    this.uv.push(u, v);
    return i;
  }

  /** Two triangles, wound so `a -> b -> c` faces out. */
  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  /** An axis-aligned box. 12 triangles, its own eight vertices. */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    colour: Rgb,
  ): void {
    const v: number[] = [];
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const sx of [-1, 1]) {
          v.push(this.vertex(cx + sx * hx, cy + sy * hy, cz + sz * hz, colour));
        }
      }
    }
    // Index order above is (y, z, x) major: 0 -x-z-y, 1 +x-z-y, 2 -x+z-y,
    // 3 +x+z-y, 4 -x-z+y, 5 +x-z+y, 6 -x+z+y, 7 +x+z+y.
    //
    // These six are the **reverse** of the ones `power.PoleBuilder.box` uses,
    // and that is a correction rather than a variation. Built with that
    // ordering, a unit cube comes out with a signed volume of exactly -1: all
    // twelve triangles face inward and every face's normal is the exact negative
    // of the axis it is labelled with. It is invisible on a pole because the
    // only boxes there are a 90 mm crossarm and two transformer brackets seen
    // against a shaft, where a back-facing quad shows the inside of a small dark
    // object and reads as a small dark object. It would not be invisible here:
    // a bin lid is a box you look straight down on.
    this.quad(v[6], v[7], v[5], v[4]); // +y
    this.quad(v[0], v[1], v[3], v[2]); // -y
    this.quad(v[3], v[7], v[6], v[2]); // +z
    this.quad(v[0], v[4], v[5], v[1]); // -z
    this.quad(v[1], v[5], v[7], v[3]); // +x
    this.quad(v[2], v[6], v[4], v[0]); // -x
  }

  /**
   * A rectangular prism that may taper: four side quads between two rectangles.
   * Capped at the top only, and only on request -- a bin's base is on the ground
   * and its top is under a lid.
   */
  taperedBox(
    y0: number, y1: number,
    hx0: number, hz0: number,
    hx1: number, hz1: number,
    colour: Rgb, cap: boolean,
  ): void {
    const ring = (y: number, hx: number, hz: number): number[] => [
      this.vertex(-hx, y, -hz, colour),
      this.vertex(hx, y, -hz, colour),
      this.vertex(hx, y, hz, colour),
      this.vertex(-hx, y, hz, colour),
    ];
    const lo = ring(y0, hx0, hz0);
    const hi = ring(y1, hx1, hz1);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(lo[i], hi[i], hi[j], lo[j]);
    }
    // Reversed against the ring's own order, which runs clockwise seen from +Y:
    // taking it as it stands would face the cap down. Checked by cross product
    // rather than by eye, because a single inverted cap is invisible until the
    // player is above it and then it is a hole.
    if (cap) this.quad(hi[3], hi[2], hi[1], hi[0]);
  }

  /**
   * A tapered n-gon prism about the Y axis, capped at the top only. Winding runs
   * counter-clockwise seen from +Y, which puts the side quads' normals outward.
   */
  prism(
    y0: number, y1: number, r0: number, r1: number,
    sides: number, colour: Rgb, cap: boolean,
  ): void {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      lo.push(this.vertex(Math.cos(a) * r0, y0, Math.sin(a) * r0, colour));
      hi.push(this.vertex(Math.cos(a) * r1, y1, Math.sin(a) * r1, colour));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.quad(lo[i], hi[i], hi[j], lo[j]);
    }
    if (!cap) return;
    const centre = this.vertex(0, y1, 0, colour);
    // Reversed for the same reason `taperedBox`'s cap is: `(cos a, sin a)` in
    // (x, z) walks clockwise seen from +Y, so the fan has to be wound backwards
    // to face up.
    for (let i = 0; i < sides; i++) this.index.push(centre, hi[(i + 1) % sides], hi[i]);
  }

  /**
   * A lamp visor: a shelf at `y` reaching out from `x` to `x + LAMP_HOOD_DEPTH`,
   * with a short cheek down each side. Six triangles.
   *
   * Only the top and the two sides, never the bottom -- which is what a real
   * signal hood is, because the point of one is to keep the low sun off the lens
   * and the sun is never underneath it. Leaving the bottom off also halves the
   * cost and removes the one face that would z-fight with the lens below.
   *
   * Wound so the shelf faces up and each cheek faces outward.
   */
  hood(x: number, y: number, colour: Rgb): void {
    const hz = LAMP_RADIUS + 0.012;
    const x1 = x + LAMP_HOOD_DEPTH;
    const drop = LAMP_HOOD_DROP;
    // The shelf, sloping very slightly down as it comes out -- which is what a
    // pressed visor does, and what keeps its underside in shadow from above.
    const a = this.vertex(x, y, -hz, colour);
    const b = this.vertex(x, y, hz, colour);
    const c = this.vertex(x1, y - drop, hz, colour);
    const d = this.vertex(x1, y - drop, -hz, colour);
    this.quad(a, b, c, d);
    // Two cheeks, each a triangle-shaped quad closing the gap between the shelf
    // and the housing face. Built as quads with a degenerate-free outline: the
    // inner edge runs the full drop, the outer edge none.
    for (const sz of [-1, 1] as const) {
      const z = sz * hz;
      const p0 = this.vertex(x, y, z, colour);
      const p1 = this.vertex(x1, y - drop, z, colour);
      const p2 = this.vertex(x1, y - drop - LAMP_HOOD_CHEEK, z, colour);
      const p3 = this.vertex(x, y - LAMP_HOOD_CHEEK, z, colour);
      // Reversed on the +z side so each cheek faces away from the lens. Checked
      // by cross product rather than by eye: `p0 -> p1 -> p2` walks clockwise
      // seen from +Z, so taking it as it stands faces the +z cheek inward, and
      // an inward-facing quad on a `FrontSide` material is an invisible one.
      if (sz > 0) this.quad(p3, p2, p1, p0);
      else this.quad(p0, p1, p2, p3);
    }
  }

  /**
   * A flat n-gon facing +X, standing `x` out along it. Eight triangles for an
   * octagon, which is what a signal lens is at any distance it is legible from.
   */
  disc(x: number, cy: number, r: number, sides: number, colour: Rgb): void {
    const rim: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      rim.push(this.vertex(x, cy + Math.sin(a) * r, Math.cos(a) * r, colour));
    }
    const centre = this.vertex(x, cy, 0, colour);
    // Wound so the fan faces +X. The ring runs from +Z toward +Y as the angle
    // advances, and `(0,0,r) x (0,r,r)` is -X, so the two rim vertices go in the
    // other order.
    for (let i = 0; i < sides; i++) this.index.push(centre, rim[(i + 1) % sides], rim[i]);
  }

  build(name: string, withUv = false): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    if (withUv) g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    // Computed rather than authored, and unread while `flatShading` is on. They
    // exist so that turning it off degrades to a smooth prop rather than a black
    // one -- `isFlatShading()` is also true when the normal attribute is absent.
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The bin body: a tapered tub, a moulded rim and two stub wheels. 42 triangles.
 *
 * Local axes: **+Y up, +X toward the road.** The pipeline writes an ENU bearing
 * straight into the sidecar and the instance applies it as a Y rotation, which
 * lands local +X on that bearing -- see `tiles.write_furniture`. So the wheels
 * and the lid hinge go on -X, the property side, which is where the council asks
 * for them and, more usefully, is what makes the lid read as a lid from the
 * street rather than as a flat top.
 */
function buildBinBody(): BufferGeometry {
  const m = new PropBuilder();
  const hx = BIN_DEPTH / 2;
  const hz = BIN_WIDTH / 2;
  // The tub, tapering in toward the base the way a moulded bin does so it can be
  // stacked. Uncapped: the base is on the paving and the top is under the rim.
  m.taperedBox(0.08, 0.92, hx * 0.82, hz * 0.8, hx, hz, BIN_BODY, false);
  // The rim, a couple of centimetres proud all round. It is what the lid closes
  // onto, and it is the one horizontal line on the object -- without it the body
  // and the lid merge into a single lump at any distance.
  m.taperedBox(0.92, BIN_BODY_TOP, hx, hz, hx * 1.02, hz * 1.02, BIN_BODY, true);
  // Two stub wheels under the hinge end, axle across the bin. Boxes rather than
  // prisms: an 80 mm wheel is under a pixel across at fifteen metres, so a round
  // one costs the same triangles to say nothing.
  for (const sz of [-1, 1]) {
    m.box(-hx * 0.72, 0.075, sz * hz * 0.72, 0.055, 0.075, 0.03, BIN_WHEEL);
  }
  return m.build('bin_body');
}

/**
 * The bin lid: a wedge hinged at the back, falling toward the front lip. 12
 * triangles, white, so `instanceColor` carries the stream colour whole.
 *
 * The fall is 40 mm over the depth and it is not decoration: a flat lid takes
 * exactly the same irradiance as the footpath beside it and both tone map into
 * the same 250s, where a lid tilted 3 degrees out of horizontal separates from
 * it. It is also what a real lid does, because it sheds water forward.
 */
function buildBinLid(): BufferGeometry {
  const m = new PropBuilder();
  const hx = BIN_DEPTH / 2;
  const hz = (BIN_WIDTH / 2) * 1.02;
  const white: Rgb = [1, 1, 1];
  const skirt = BIN_BODY_TOP - 0.01;
  // Eight vertices in `box`'s own (y, z, x)-major order, so the six quads below
  // are that method's proven winding with nothing re-derived. The only
  // difference is that the four top vertices sit at two heights rather than one:
  // the hinge edge at -X is 40 mm higher than the lip at +X. That still leaves
  // the top face planar, because it is ruled along X with no variation along Z.
  const v: number[] = [];
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const y = sy < 0 ? skirt : sx < 0 ? BIN_HEIGHT : BIN_HEIGHT - 0.04;
        v.push(m.vertex(sx * hx, y, sz * hz, white));
      }
    }
  }
  m.quad(v[6], v[7], v[5], v[4]); // the sloped top
  m.quad(v[0], v[1], v[3], v[2]); // underside
  m.quad(v[3], v[7], v[6], v[2]); // +z
  m.quad(v[0], v[4], v[5], v[1]); // -z
  m.quad(v[1], v[5], v[7], v[3]); // +x, the front lip
  m.quad(v[2], v[6], v[4], v[0]); // -x, the hinge face
  return m.build('bin_lid');
}

/**
 * The name post: a hexagonal shaft on a base collar. 30 triangles.
 *
 * Hexagonal rather than round because at 65 mm across it is three pixels wide at
 * any distance the blade on top is legible from, and six facets at 12 triangles
 * catch the sun on one side and not the other -- which is the whole of what a
 * post has to do, which is not be a flat grey line.
 */
function buildNamePost(): BufferGeometry {
  const m = new PropBuilder();
  m.prism(0.1, POST_HEIGHT, POST_RADIUS, POST_RADIUS * 0.94, 6, POST_GREY, true);
  // The collar over the footpath socket. Twelve triangles for the one thing that
  // stops the post looking pushed into the concrete like a pin.
  m.prism(0, 0.1, POST_RADIUS * 1.75, POST_RADIUS * 1.35, 6, POST_GREY, false);
  return m.build('name_post');
}

/**
 * One blade: a 900 x 150 mm plate, 12 triangles, with the UVs that drive the
 * border.
 *
 * Local axes: **+X along the blade**, so the instance yaw -- which is the street
 * the blade names -- lays it parallel to that street.
 *
 * The two large faces carry a full 0..1 UV. The four narrow edges are pinned to
 * (0, 0), which is inside the border on both axes, so they come out white: a
 * pressed blade's edge rim genuinely is white, and getting it for free beats
 * either a second material or a seam where the green stops.
 */
function buildBlade(): BufferGeometry {
  const m = new PropBuilder();
  const hx = BLADE_LENGTH / 2;
  const hy = BLADE_HEIGHT / 2;
  const hz = BLADE_HALF_THICK;
  const white: Rgb = [1, 1, 1];
  // The two faces, each with its own four vertices so the UV runs 0..1 across
  // the plate rather than wrapping round the edge.
  for (const sz of [1, -1] as const) {
    const a = m.vertex(-hx * sz, -hy, hz * sz, white, 0, 0);
    const b = m.vertex(hx * sz, -hy, hz * sz, white, 1, 0);
    const c = m.vertex(hx * sz, hy, hz * sz, white, 1, 1);
    const d = m.vertex(-hx * sz, hy, hz * sz, white, 0, 1);
    m.quad(a, b, c, d);
  }
  // The rim: four narrow quads at UV (0, 0), which the border test resolves to
  // white.
  const rim: number[][] = [];
  for (const sz of [-1, 1] as const) {
    rim.push([
      m.vertex(-hx, -hy, hz * sz, white, 0, 0),
      m.vertex(hx, -hy, hz * sz, white, 0, 0),
      m.vertex(hx, hy, hz * sz, white, 0, 0),
      m.vertex(-hx, hy, hz * sz, white, 0, 0),
    ]);
  }
  const [n, p] = rim; // -z ring, +z ring; each is (-x-y), (+x-y), (+x+y), (-x+y)
  m.quad(n[2], p[2], p[1], n[1]); // +x
  m.quad(n[0], p[0], p[3], n[3]); // -x
  m.quad(p[3], p[2], n[2], n[3]); // +y
  m.quad(n[0], n[1], p[1], p[0]); // -y
  return m.build('name_blade', true);
}

/**
 * The legend plate: two quads back to back, 4 triangles, one shared geometry for
 * every named blade in the world.
 *
 * It is a *skin* rather than a plate. It stands `LABEL_PROUD` outside the two
 * faces of the instanced blade it covers, so a post that gains a legend gains
 * nothing but paint: the plate underneath is already there, already the right
 * size, already the right colour family, and already casting the right shadow.
 * Nothing has to be hidden, no instance buffer is rewritten, and the swap at
 * `LABEL_RADIUS` cannot pop a blade in or out of existence -- the most it can do
 * is change what is written on one. That is the whole reason this is a skin.
 *
 * **The two quads carry mirrored UVs and that is the entire point of there being
 * two of them.** A single double-sided quad shows the same texture space to both
 * sides, so the legend reads correctly from the front and backwards from the
 * back -- and half the blades on any street are read from the back. The -Z quad
 * therefore runs its `u` from 1 to 0, which un-mirrors it. Four triangles is a
 * cheaper fix than a `frontFacing` branch in the shader, and it cannot be got
 * wrong by a future material change.
 *
 * Local axes match the blade's: **+X along the plate, +Y up**, so one instance
 * yaw serves both.
 */
function buildBladeLabel(): BufferGeometry {
  const m = new PropBuilder();
  const hx = BLADE_LENGTH / 2;
  const hy = BLADE_HEIGHT / 2;
  const hz = BLADE_HALF_THICK + LABEL_PROUD;
  const white: Rgb = [1, 1, 1];
  // +Z face, read from the +Z side: u runs with +X.
  m.quad(
    m.vertex(-hx, -hy, hz, white, 0, 0),
    m.vertex(hx, -hy, hz, white, 1, 0),
    m.vertex(hx, hy, hz, white, 1, 1),
    m.vertex(-hx, hy, hz, white, 0, 1),
  );
  // -Z face, read from the -Z side. The winding reverses so the quad faces -Z,
  // and `u` reverses with it, which is what makes the legend read forwards from
  // behind rather than as its own mirror image.
  m.quad(
    m.vertex(hx, -hy, -hz, white, 0, 0),
    m.vertex(-hx, -hy, -hz, white, 1, 0),
    m.vertex(-hx, hy, -hz, white, 1, 1),
    m.vertex(hx, hy, -hz, white, 0, 1),
  );
  return m.build('name_blade_label', true);
}

/**
 * A signal head on its pole, with all three lenses dark, a hood over each and a
 * push-button box at hand height. 96 triangles.
 *
 * Local axes: **+Y up, +X out of the face of the head**, so the instance yaw
 * turns the display toward the middle of the intersection.
 *
 * The head passes *through* the pole rather than butting against it, which is
 * the trick `power.ts` uses for the crossarm and for the same reason: there is
 * no seam to line up and nothing to z-fight along.
 *
 * The hoods and the button box are both from the reference photographs and both
 * are cheap, and it is worth saying which part of each is doing the work. A
 * Sydney lamp visor is *deep* -- a good 90 mm of shelf over a 210 mm lens -- and
 * what it contributes at any distance you can see a signal from is not a shape
 * but a **band of shadow across the top of each lens**, which is why the housing
 * reads as three sunken eyes rather than as three discs on a board. Three quads
 * a lamp buys that: a shelf and two cheeks, in a darker tone than the housing.
 * The button box contributes the opposite thing -- the one saturated colour
 * below 2 m on a corner.
 */
function buildSignal(): BufferGeometry {
  const m = new PropBuilder();
  const headY = SIGNAL_POLE_HEIGHT - SIGNAL_HEAD_BELOW_TOP;
  m.prism(0, SIGNAL_POLE_HEIGHT, SIGNAL_POLE_RADIUS, SIGNAL_POLE_RADIUS * 0.9, 6, SIGNAL_POLE, true);
  // The backing board: a yellow box the head stands proud of, so the yellow
  // survives as a 70 mm frame with no extra geometry.
  m.box(
    0, headY, 0,
    0.1, SIGNAL_HEAD_HEIGHT / 2 + 0.08, SIGNAL_HEAD_WIDTH / 2 + 0.07,
    SIGNAL_YELLOW,
  );
  m.box(
    0.015, headY, 0,
    0.115, SIGNAL_HEAD_HEIGHT / 2, SIGNAL_HEAD_WIDTH / 2,
    SIGNAL_BLACK,
  );
  // The three dark lenses, on the face, red at the top. The lit one is a
  // separate instanced disc that lands 6 mm in front of whichever of these the
  // sidecar names -- see `buildTileSignals`.
  for (let i = 0; i < LAMP_COUNT; i++) {
    m.disc(0.132, LAMP_Y[i], LAMP_RADIUS, 8, LENS_DARK[i]);
  }
  // A hood over each, 18 triangles for all three. The shelf sits a lens-radius
  // above the centre and reaches `LAMP_HOOD_DEPTH` out past the lit disc, so
  // the disc is genuinely under it rather than in front of it.
  for (let i = 0; i < LAMP_COUNT; i++) m.hood(0.13, LAMP_Y[i] + LAMP_RADIUS, SIGNAL_HOOD);
  // The push-button box, on the *back* of the pole -- the side away from the
  // display, which is the side the pedestrian waiting to cross is standing on.
  // The head faces inward across the intersection, so -X is the footpath.
  m.box(
    -(SIGNAL_POLE_RADIUS + BUTTON_DEPTH / 2), BUTTON_Y, 0,
    BUTTON_DEPTH / 2, BUTTON_HEIGHT / 2, BUTTON_WIDTH / 2,
    SIGNAL_BUTTON,
  );
  return m.build('signal_head');
}

/** The lit lens: one octagon, 8 triangles, white so `instanceColor` is the aspect. */
function buildLamp(): BufferGeometry {
  const m = new PropBuilder();
  m.disc(0, 0, LAMP_RADIUS * 0.94, 8, [1, 1, 1]);
  return m.build('signal_lamp');
}

// --- The legend, rasterised ---------------------------------------------------

/**
 * Canvas dimensions for one legend, pixels.
 *
 * **The aspect matches the blade exactly** -- 900 x 200 mm is 4.5:1 and so is
 * 288 x 64 -- because anything else stretches the lettering, and stretched
 * lettering on a street sign is the single most obvious way for this to look
 * fake. It is the reason these are not the rounder 256 x 64 or 320 x 64: at
 * 4:1 the letters come out 12% fat and at 5:1 11% thin, and both are visible at
 * the distance the thing is read from.
 *
 * 64 px of height is set by what the blade covers on screen. At 10 m it is 14.9
 * screen px tall, at 5 m 29.8, at 2 m 74; so 64 texels is between two and four
 * times oversampled over the whole band this is read in, and undersampled only
 * when a player's face is against the post. There is no case for more.
 */
const LABEL_W = 288;
const LABEL_H = 64;
/**
 * Cap height as a fraction of the canvas, and the border inset in canvas pixels.
 *
 * 0.6875 is 44 px of 64, which on a 200 mm blade is a **137 mm capital** -- at
 * the top of AS 1742.5's range and chosen there rather than in the middle for
 * the reason the whole blade got taller: at 10 m this is 10.2 screen px of cap
 * height, and 10 px is about where uppercase stops being guessed at.
 *
 * That leaves 10 px of the canvas above and below the letters, of which the
 * border takes 3 and its inset 3. Tight, and real blades are tight.
 */
const LABEL_CAP = 0.6875;
const LABEL_BORDER = 3;
const LABEL_INSET = 3;
/** Clear space between the rule and the first letter, canvas pixels. */
const LABEL_PAD = 4;
/**
 * Font size that yields `LABEL_CAP`. Cap height is about 0.72 of the em for a
 * grotesque, so the size that gives the cap height asked for is a little larger
 * than it. Measured on Arial Narrow Bold, where a 61 px em renders a 44 px cap.
 */
const LABEL_EM = Math.round((LABEL_CAP * LABEL_H) / 0.72);
/**
 * How far a legend may be condensed before the font size starts coming down
 * instead. See `BladeTextCache.fit` for why this is the axis that gives.
 *
 * Measured against the inner ring's own 1,287 distinct legends in Arial Narrow
 * Bold: at 0.62, **91% of them keep the full 138 mm capitals** and the 10.2
 * screen px those are worth at 10 m. The median legend needs only 0.84 and the
 * worst -- a motorway on-ramp -- needs 0.39, which is the 1% that gives up cap
 * height instead.
 *
 * It is also about where a condensed grotesque stops being a typeface and
 * starts being a picket fence: 0.62 of Arial Narrow is half the width of Arial,
 * which is the compressed end of what real signage sets.
 */
const LABEL_CONDENSE_MIN = 0.62;
/**
 * Legends kept alive before the least recently drawn are released.
 *
 * At 288 x 64 RGBA with a mip chain a legend is 96 kB of GPU memory, so this is
 * about 12 MB -- against roughly 600 distinct street names in the inner ring,
 * which would be 57 MB if nothing was ever released. The working set is nothing
 * like the cap: `LABEL_RADIUS` admits a few dozen blades and they name fewer
 * distinct streets than that, so in normal play the cache fills to some tens of
 * entries and never evicts. This exists for the session that walks the whole
 * city, and it evicts by "not drawn this rebuild", so an entry in use is never
 * the one that goes.
 */
const LABEL_CACHE_MAX = 128;

/**
 * The font stack, and the reason nothing is shipped with it.
 *
 * Australian street blades are lettered in AS 1744 Series C or D -- a condensed
 * grotesque -- and the nearest thing every platform already has is Arial
 * Narrow, with Helvetica Neue and then the generic sans behind it. A real
 * webfont would be 30-80 kB of download and one more asset to serve for
 * something that is 44 px tall and mostly read at a glance, and the fallback
 * chain degrades in the right direction: each step is a little wider than the
 * last, and `fitFont` below squeezes whatever it gets to fit the plate anyway.
 */
const LABEL_FONT_STACK = "'Arial Narrow', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** One rasterised legend: the texture, the material that wears it, and its age. */
interface LabelEntry {
  texture: CanvasTexture;
  material: MeshStandardNodeMaterial;
  /** The rebuild tick this was last asked for. Drives eviction. */
  usedAt: number;
}

/**
 * One canvas texture and one material per distinct *(legend, style)*, for the
 * whole world.
 *
 * The cache is the answer to the one hard problem in putting text on 4,812
 * blades: **a unique texture cannot be instanced.** Every other streamed prop in
 * this project is one geometry, one material and an instance buffer, and the
 * moment each blade wants its own image that collapses -- an `InstancedMesh` has
 * exactly one material and one texture binding. So each legend is its own small
 * mesh, and the cost is controlled from both ends at once: `BladeLabels` bounds
 * how many meshes exist by distance and by count, and this bounds how many
 * *textures* exist by reuse. The two are different bounds because they are
 * different resources -- eight corners of Crown Street inside the radius are
 * eight meshes and one texture.
 *
 * Keyed on the pair rather than on the name, because the same street can cross
 * the City of Sydney boundary and be signed both ways -- Crown Street and
 * Cleveland Street both do -- and the two plates are not the same image.
 */
export class BladeTextCache {
  private readonly entries = new Map<string, LabelEntry>();
  private tick = 0;
  /**
   * Whether this environment has a 2D canvas at all. Probed once; null until
   * the first `acquire`, `false` in a headless import or a browser that refused
   * the context.
   */
  private canvasOk: boolean | null = null;

  /** Distinct legends resident. Reported by `stats`, and read by nothing else. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The material for one legend, rasterising it if this is the first time it has
   * been asked for.
   *
   * Returns null only where there is no 2D canvas at all -- a headless test, or
   * a browser that has refused the context -- in which case the caller draws the
   * plain instanced plate and the world is what it was before the legends.
   */
  acquire(name: string, style: number): MeshStandardNodeMaterial | null {
    if (!name) return null;
    const key = `${style} ${name}`;
    const found = this.entries.get(key);
    if (found !== undefined) {
      found.usedAt = this.tick;
      return found.material;
    }
    const texture = this.rasterise(name, style);
    if (texture === null) return null;

    const material = new MeshStandardNodeMaterial();
    material.name = `name_legend_${style}`;
    material.map = texture;
    // Matte paint on pressed aluminium, the same as the plate under it. It has
    // to be *the same* rather than merely similar: the legend skin and the plate
    // are coplanar to within 0.6 mm, and two different roughnesses there would
    // put a specular seam round the edge of every blade in the city.
    material.roughness = 0.55;
    material.metalness = 0.0;
    // Not flat-shaded, unlike everything else in this file. A legend quad is
    // flat, so faceting has nothing to do -- and leaving it on would make the
    // two back-to-back quads shade as two separate surfaces at grazing angles.
    material.flatShading = false;
    this.entries.set(key, { texture, material, usedAt: this.tick });
    return material;
  }

  /**
   * Start a rebuild pass. Everything `acquire`d until the next `endPass` is
   * marked as in use; the rest becomes evictable.
   */
  beginPass(): void {
    this.tick++;
  }

  /**
   * Release legends not asked for in the pass just finished, oldest first, until
   * the cache is back under `LABEL_CACHE_MAX`.
   *
   * Nothing in use is ever released, because "in use" is exactly "asked for
   * during this pass" and the meshes are rebuilt from those same calls. That is
   * the whole reason eviction is tied to the rebuild rather than run on a clock:
   * a clock could free a texture a live mesh is still pointing at.
   */
  endPass(): void {
    if (this.entries.size <= LABEL_CACHE_MAX) return;
    const cold = [...this.entries.entries()]
      .filter(([, e]) => e.usedAt !== this.tick)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of cold) {
      if (this.entries.size <= LABEL_CACHE_MAX) break;
      this.release(entry);
      this.entries.delete(key);
    }
  }

  /**
   * Draw one legend and hand back a texture of it.
   *
   * The two styles are the two reference photographs and nothing here is
   * invented: the City of Sydney plate is a dark green field with a white rule
   * inset from the edge and white condensed capitals; the RMS plate is a white
   * field with a thin black rule and black capitals. The crest and the street
   * number range on the CBD plate are **not** drawn -- at 44 px of cap height
   * the crest is a six-pixel smudge, and a smudge where a coat of arms should be
   * is worse than a plate without one.
   *
   * The canvas is deliberately painted with the *display* colours rather than
   * the linear ones the rest of this file quotes. It is an sRGB texture and
   * three.js decodes it, so what goes in has to be what the eye should see; the
   * `Rgb` constants above are what the shader multiplies light by, which is a
   * different quantity and is not interchangeable with this.
   *
   * **Each legend gets its own canvas and that is not an oversight.** The
   * obvious economy -- one scratch canvas repainted per legend -- is a bug:
   * `CanvasTexture` keeps a *reference* to the element and uploads whatever is
   * on it at the next render, not at the moment `needsUpdate` is set. A rebuild
   * that rasterises twenty legends in one frame would upload the twentieth to
   * all twenty textures, and every blade on screen would read the same street.
   * The cost of doing it properly is one 73 kB backing store per cached legend,
   * which `LABEL_CACHE_MAX` bounds at about 9 MB, and the eviction path drops
   * the reference so the store is collectable.
   */
  private rasterise(name: string, style: number): CanvasTexture | null {
    const ctx = this.context();
    if (ctx === null) return null;
    const green = style !== STYLE_RMS_WHITE;
    const field = green ? '#0e4b33' : '#f3f3f0';
    const ink = green ? '#ffffff' : '#141414';

    ctx.clearRect(0, 0, LABEL_W, LABEL_H);
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, LABEL_W, LABEL_H);

    // The rule, inset from the edge. Stroked on the half-pixel so a 3 px line
    // lands on whole texels rather than being split across four of them and
    // coming out as 4 px of half-strength grey.
    ctx.strokeStyle = ink;
    ctx.lineWidth = LABEL_BORDER;
    const i = LABEL_INSET + LABEL_BORDER / 2;
    ctx.strokeRect(i, i, LABEL_W - 2 * i, LABEL_H - 2 * i);

    // Uppercase, always, in both styles -- which is what both reference plates
    // do and what AS 1744's blade series is drawn for.
    const text = name.toUpperCase();
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${LABEL_EM}px ${LABEL_FONT_STACK}`;
    const { condense, size } = this.fit(ctx, text);
    if (size !== LABEL_EM) ctx.font = `bold ${size}px ${LABEL_FONT_STACK}`;
    // `middle` is the em box's centre rather than the capitals', which sits a
    // hair low because the em box reserves descender room this text has no
    // descenders for. Lifting by 3% of the cap height puts the capitals'
    // optical centre on the plate's centre.
    const baseline = LABEL_H / 2 - LABEL_CAP * LABEL_H * 0.03;
    if (condense < 1) {
      // Squeezed along x only, about the plate's centre, so the cap height --
      // the thing legibility is actually made of -- is untouched. See `fit`.
      ctx.save();
      ctx.translate(LABEL_W / 2, 0);
      ctx.scale(condense, 1);
      ctx.fillText(text, 0, baseline);
      ctx.restore();
    } else {
      ctx.fillText(text, LABEL_W / 2, baseline);
    }

    const texture = new CanvasTexture(ctx.canvas);
    // Painted in display values, so the sampler has to be told to linearise
    // them. Without this the legend is drawn with sRGB numbers treated as
    // linear, which is a white that is far too bright and a green far too dark
    // -- the same mistake as reading `BLADE_GREEN` off a colour picker.
    texture.colorSpace = SRGBColorSpace;
    // Mipped and anisotropic, and both are load-bearing rather than defaults.
    // A blade is read from the footpath, which means from the side: at 30 m and
    // 20 degrees off the plate the texture is minified 8:1 along its length and
    // barely at all across it, which is the exact case a mip chain alone gets
    // wrong -- it picks the level for the worst axis and blurs the legend into a
    // grey bar. Anisotropy 4 is what keeps it a legend.
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    // Clamped, because the quad's UV is exactly 0..1 and a repeating wrap would
    // let the far edge of the plate sample the near one under minification --
    // which shows up as the last letter bleeding round onto the first.
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * How to make this legend fit between the rules: **condense first, shrink
   * last**.
   *
   * The measurement is unavoidable. A canvas cannot be told to condense a font
   * it does not have, and the fallback chain runs Arial Narrow, Helvetica Neue,
   * Helvetica, Arial -- each step wider than the last -- so what fits on a Mac
   * runs off the plate on a machine with only Arial. Measuring is the only way
   * to know which one turned up.
   *
   * What is done about it is the decision. The obvious response to "too wide" is
   * a smaller font, and it is the wrong one: cap height is what legibility is
   * made of, and a 200 mm blade only just clears 10 screen px of capitals at
   * 10 m, so a legend that shrinks to fit is a legend that stops being readable
   * at the distance it exists for. **Condensing costs stroke width instead**,
   * and stroke width is the cheaper of the two -- an uppercase word is read by
   * its outline, and a condensed grotesque is what every long street name on a
   * fixed-length plate in the country is set in. AS 1744 has a whole narrower
   * series for exactly this case.
   *
   * `LABEL_CONDENSE_MIN` is where that stops paying. Past it the stems are
   * sub-pixel at reading distance and would tone-map to grey rather than to
   * letters, so the size finally does come down -- and the legend goes back to
   * being recognised by its shape, which is what it would have been anyway.
   *
   * On the real inner-ring legends, with Arial Narrow, 90% of them need no more
   * than the floor and so keep the full 138 mm capitals.
   */
  private fit(ctx: CanvasRenderingContext2D, text: string): { condense: number; size: number } {
    const usable = LABEL_W - 2 * (LABEL_INSET + LABEL_BORDER) - 2 * LABEL_PAD;
    const measured = ctx.measureText(text).width;
    if (measured <= usable) return { condense: 1, size: LABEL_EM };
    const wanted = usable / measured;
    if (wanted >= LABEL_CONDENSE_MIN) return { condense: wanted, size: LABEL_EM };
    // Held at the floor, with the size taking whatever is left over. The two
    // multiply, so the drawn width is `size/LABEL_EM * LABEL_CONDENSE_MIN *
    // measured`, and setting the size ratio to `wanted / LABEL_CONDENSE_MIN`
    // makes that exactly `usable`.
    return {
      condense: LABEL_CONDENSE_MIN,
      size: LABEL_EM * (wanted / LABEL_CONDENSE_MIN),
    };
  }

  /** A fresh canvas for one legend, or null where there is no canvas to be had. */
  private context(): CanvasRenderingContext2D | null {
    if (this.canvasOk === false) return null;
    if (typeof document === 'undefined') {
      this.canvasOk = false;
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_W;
    canvas.height = LABEL_H;
    // `willReadFrequently` is deliberately *off*: this canvas is uploaded to the
    // GPU and never read back, so asking for a software-backed surface would
    // trade away the one thing it is for.
    const ctx = canvas.getContext('2d');
    this.canvasOk = ctx !== null;
    return ctx;
  }

  /** Release every texture and material. For a teardown; nothing calls it in play. */
  dispose(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }

  /**
   * Free one legend's GPU texture, its material, and the canvas behind it.
   *
   * `image = null` is the part that is easy to leave out and is the reason this
   * is a method rather than two lines at each call site: `dispose` releases the
   * GPU side, but the `Texture` object outlives it briefly in three.js's own
   * bookkeeping and holds the 73 kB canvas alive with it.
   */
  private release(entry: LabelEntry): void {
    entry.texture.dispose();
    // Typed as an `HTMLCanvasElement` rather than as nullable, because a live
    // `CanvasTexture` always has one. A disposed one does not, and dropping the
    // reference is the whole point of this line.
    (entry.texture as unknown as { image: unknown }).image = null;
    entry.material.dispose();
  }
}

// --- Shared assets ------------------------------------------------------------

/**
 * Six geometries and three materials, built once for the whole game.
 *
 * Shared the way `PowerAssets`, `CarAssets` and `VegetationAssets` are, and for
 * the same reason: a material created per tile is a WebGPU pipeline compiled per
 * tile, and pipeline compilation blocks the main thread.
 */
export class FurnitureAssets {
  readonly binBody: BufferGeometry;
  readonly binLid: BufferGeometry;
  readonly namePost: BufferGeometry;
  readonly blade: BufferGeometry;
  /** The legend skin: two mirrored quads, worn over `blade` by named posts. */
  readonly bladeLabel: BufferGeometry;
  readonly signal: BufferGeometry;
  readonly lamp: BufferGeometry;

  /** Bin body, bin lid, name post and signal head all wear this one. */
  readonly propMaterial: MeshStandardNodeMaterial;
  /**
   * The far blade, one material per style. Two rather than one because the two
   * styles invert each other -- white legend on a dark field against black on a
   * light one -- and `instanceColor` can only ever multiply, so no per-instance
   * value turns one into the other. This is the same "one variant, one material"
   * call `cars.ts` makes about paint, and it costs a second draw only in the
   * tiles where the City of Sydney boundary happens to run.
   */
  readonly bladeMaterial: MeshStandardNodeMaterial[];
  /** The lit lamp, unlit -- see the note at the top of this file. */
  readonly lampMaterial: MeshBasicNodeMaterial;
  /** One canvas texture and one material per distinct legend. Shared world-wide. */
  readonly labels = new BladeTextCache();

  constructor() {
    this.binBody = buildBinBody();
    this.binLid = buildBinLid();
    this.namePost = buildNamePost();
    this.blade = buildBlade();
    this.bladeLabel = buildBladeLabel();
    this.signal = buildSignal();
    this.lamp = buildLamp();

    const prop = new MeshStandardNodeMaterial();
    prop.name = 'street_furniture';
    // No `colorNode`, exactly as `cars.ts`, `vegetation.ts` and `power.ts` have
    // none: `NodeMaterial` already multiplies the material colour by the
    // geometry `color` attribute and then by `instanceColor`, so the body tone,
    // the wheels, the lid colour and the per-instance jitter all arrive through
    // two built-in multiplies and no shader graph at all.
    prop.vertexColors = true;
    prop.color = new Color(1, 1, 1);
    // Injection-moulded HDPE and powder-coated steel are both semi-matte. Lower
    // than the poles' 0.95 because a bin genuinely does have a sheen, and a
    // little specular on a curved-looking box is what stops it reading as card.
    prop.roughness = 0.72;
    prop.metalness = 0.0;
    // Faceted, like the trees, the cars and the poles: these are polyhedra, and
    // smooth-shading a polyhedron makes it read as a melted version of itself.
    prop.flatShading = true;
    this.propMaterial = prop;

    // The far blade in each style, as four `step`s and a `mix`. `uv` is 0..1
    // over each large face and pinned inside the border on the four narrow
    // edges, so the edges come out as the border colour with no branch for them
    // -- which is right both ways round: a pressed blade's edge rim is white on
    // the green style, and on the white one the rim is the field.
    this.bladeMaterial = ([
      [BLADE_WHITE, BLADE_GREEN, 'name_blade_cos'],
      [BLADE_BLACK, BLADE_FIELD_WHITE, 'name_blade_rms'],
    ] as const).map(([border, field, name]) => {
      const blade = new MeshStandardNodeMaterial();
      blade.name = name;
      blade.roughness = 0.55;
      blade.metalness = 0.0;
      blade.flatShading = true;
      blade.colorNode = Fn(() => {
        const p = uv();
        const inside = step(BORDER_U, p.x)
          .mul(step(p.x, 1 - BORDER_U))
          .mul(step(BORDER_V, p.y))
          .mul(step(p.y, 1 - BORDER_V));
        return mix(vec3(...border), vec3(...field), inside);
      })();
      return blade;
    });

    const lamp = new MeshBasicNodeMaterial();
    lamp.name = 'signal_lamp';
    // Unlit, and `vertexColors` so the white disc geometry passes
    // `instanceColor` through untouched. `MeshBasicNodeMaterial` takes the
    // result straight to the tone curve, which is the point: a signal lamp is an
    // emitter and an emitter does not have a shaded side.
    lamp.vertexColors = true;
    lamp.color = new Color(1, 1, 1);
    this.lampMaterial = lamp;
  }
}

// --- Instancing ---------------------------------------------------------------

const _matrix = /*#__PURE__*/ new Matrix4();
const _yaw = /*#__PURE__*/ new Matrix4();
const _colour = /*#__PURE__*/ new Color();
/**
 * The lit disc's offset out of the head's face, in the head's own local frame:
 * 6 mm in front of the dark lens it covers. Constant, so it is composed once
 * rather than per instance.
 */
const _lampOffset = /*#__PURE__*/ new Matrix4().makeTranslation(0.138, 0, 0);

/** Deterministic hash over the sidecar. Author-time only, as in `power.ts`. */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * One span of this kind's shared mesh, set up the way every streamed instance
 * set in this project now is.
 *
 * This made `new InstancedMesh(...)` per tile, and that is the line the client
 * was spending its frames on: three keys a node builder state on
 * `object.uuid`, so a hundred and ninety street-furniture meshes across a tile
 * ring were a hundred and ninety node graphs and a hundred and ninety WGSL
 * generations of the same shader. One mesh per kind for the whole city instead.
 * See `world/instancepool.ts`.
 *
 * `castShadow` is decided here rather than by the streamer, because the streamer
 * decided it by walking the tile group and these are no longer in one. The lit
 * signal lamps are the one kind that never casts -- an eight-triangle disc of
 * pure emission contributes a dotted line to the depth map and nothing else.
 */
function pooled(
  pool: InstancePool,
  key: string,
  geometry: BufferGeometry,
  material: MeshStandardNodeMaterial | MeshBasicNodeMaterial,
  count: number,
  originX: number,
  originZ: number,
  casts = true,
): PooledSet | null {
  return pool.set(key, geometry, material, count, originX, originZ, (mesh) => {
    mesh.castShadow = casts;
    mesh.receiveShadow = false;
  });
}

/** Give back a partly-built set when a later claim in the same kind is refused. */
function unclaim(pool: InstancePool, sets: Array<PooledSet | null>): InstanceClaim[] {
  for (const set of sets) if (set !== null) pool.release(set.claim);
  return [];
}

/**
 * Every wheelie bin in a tile, as two `InstancedMesh` sets sharing one instance
 * loop: the bodies and the lids.
 *
 * See the note at the top of this file for why it is a split rather than one
 * mesh per lid colour. The two are written in lockstep from the same matrix, so
 * a lid can never end up on the wrong bin.
 *
 * `groundY` comes out of the sidecar rather than being sampled from the tile's
 * height grid, unlike a tree or a car, and it is the *footpath* rather than the
 * terrain -- the pipeline has already added the paving's 15 cm. A bin sampled
 * against the terrain here would sink to its axle in the concrete.
 */
export function buildTileBins(
  data: TileFurniture,
  assets: FurnitureAssets,
  pool: InstancePool,
  originX: number,
  originZ: number,
): InstanceClaim[] {
  if (data.binCount === 0) return [];
  const bodies = pooled(pool, 'bin_bodies', assets.binBody, assets.propMaterial, data.binCount, originX, originZ);
  const lids = pooled(pool, 'bin_lids', assets.binLid, assets.propMaterial, data.binCount, originX, originZ);
  if (bodies === null || lids === null) return unclaim(pool, [bodies, lids]);

  for (let i = 0; i < data.binCount; i++) {
    _matrix.makeTranslation(data.binX[i], data.binGroundY[i], data.binZ[i]);
    _yaw.makeRotationY(data.binYaw[i]);
    _matrix.multiply(_yaw);
    bodies.setMatrixAt(i, _matrix);
    lids.setMatrixAt(i, _matrix);

    // Tonal jitter on the body only, no hue. Two bins differ by how long they
    // have been in the sun and how often they have been dragged over a kerb, not
    // by being different greens -- the same argument `power.ts` makes about
    // timber and `cars.ts` about paint.
    const t = 0.88 + 0.2 * hash(i, Math.round(data.binX[i] * 16), 3);
    _colour.setRGB(t, t, t);
    bodies.setColorAt(i, _colour);

    // The lid geometry is white, so this *is* the colour rather than a tint of
    // one. A little less jitter than the body: a lid is the newest-looking part
    // of a bin because it is the part that gets replaced.
    const lid = LID_COLOURS[data.binLid[i]];
    const k = 0.93 + 0.12 * hash(i, Math.round(data.binZ[i] * 16), 7);
    _colour.setRGB(lid[0] * k, lid[1] * k, lid[2] * k);
    lids.setColorAt(i, _colour);
  }
  return [bodies.claim, lids.claim];
}

/**
 * Every street-name post in a tile, and every blade on them, as two
 * `InstancedMesh` sets.
 *
 * The blades are a set of their own rather than part of the post's geometry, and
 * that is forced rather than chosen: the two blades on one corner point at two
 * different streets, so their yaws are independent and neither can be baked into
 * a shared post. One instance per blade is what makes them independent, and it
 * costs one draw for every blade in the tile.
 *
 * `bladeRank` stacks them: rank 0 sits at `BLADE_MOUNT_Y` and each one below it
 * drops `BLADE_STACK`. Two blades at the same height would pass through each
 * other's middle at right angles.
 */
export function buildTilePosts(
  data: TileFurniture,
  assets: FurnitureAssets,
  pool: InstancePool,
  originX: number,
  originZ: number,
): InstanceClaim[] {
  if (data.postCount === 0) return [];
  const out: InstanceClaim[] = [];

  const posts = pooled(pool, 'name_posts', assets.namePost, assets.propMaterial, data.postCount, originX, originZ);
  if (posts === null) return out;
  for (let i = 0; i < data.postCount; i++) {
    _matrix.makeTranslation(data.postX[i], data.postGroundY[i], data.postZ[i]);
    // No yaw on the post itself: it is a hexagon on its own axis, so any
    // rotation is the same post. A hashed one anyway, so a row of them along a
    // street does not present the same facet to the sun.
    _yaw.makeRotationY(hash(i, Math.round(data.postX[i] * 16), 11) * Math.PI * 2);
    _matrix.multiply(_yaw);
    posts.setMatrixAt(i, _matrix);
    const t = 0.9 + 0.16 * hash(i, Math.round(data.postZ[i] * 16), 13);
    _colour.setRGB(t, t, t);
    posts.setColorAt(i, _colour);
  }
  out.push(posts.claim);

  // The plates, one `InstancedMesh` per style present in the tile. Counted
  // first so neither is allocated at the tile's full blade count -- a tile is
  // almost always entirely one style, and sizing both for the worst case would
  // double the instance buffers on every tile in the city to serve the handful
  // the City of Sydney boundary runs through.
  const perStyle = new Array<number>(STYLE_COUNT).fill(0);
  for (let b = 0; b < data.bladeCount; b++) perStyle[data.postStyle[data.bladePost[b]]]++;

  for (let style = 0; style < STYLE_COUNT; style++) {
    if (perStyle[style] === 0) continue;
    const blades = pooled(
      pool,
      style === STYLE_RMS_WHITE ? 'name_blades_rms' : 'name_blades_cos',
      assets.blade,
      assets.bladeMaterial[style],
      perStyle[style],
      originX,
      originZ,
    );
    if (blades === null) continue;
    let n = 0;
    for (let b = 0; b < data.bladeCount; b++) {
      const i = data.bladePost[b];
      if (data.postStyle[i] !== style) continue;
      _matrix.makeTranslation(
        data.postX[i],
        data.postGroundY[i] + BLADE_MOUNT_Y - data.bladeRank[b] * BLADE_STACK,
        data.postZ[i],
      );
      _yaw.makeRotationY(data.bladeYaw[b]);
      _matrix.multiply(_yaw);
      blades.setMatrixAt(n++, _matrix);
    }
    // No `instanceColor` at all: every blade of a style is the same two colours,
    // and an unused instance colour buffer is 12 bytes an instance of upload
    // that the shader would multiply by one.
    out.push(blades.claim);
  }
  return out;
}

/**
 * Where one blade's legend hangs, in the tile's own local frame. Filled by
 * `collectBladeLabels` and read by `BladeLabels`; a plain shape rather than a
 * class, because a hundred of them are produced a second.
 */
export interface BladeLabelSite {
  x: number;
  y: number;
  z: number;
  yaw: number;
  name: string;
  style: number;
}

/**
 * Every blade in a tile that has a legend to draw, with the pose to draw it at.
 *
 * Tile-local, exactly as the sidecar is: the caller adds the tile's group
 * offset, because the caller is the only thing that knows it and doing it here
 * would mean passing the offset down to be added and subtracted again.
 */
export function collectBladeLabels(data: TileFurniture): BladeLabelSite[] {
  const out: BladeLabelSite[] = [];
  for (let b = 0; b < data.bladeCount; b++) {
    const name = data.bladeName[b];
    if (!name) continue;
    const i = data.bladePost[b];
    out.push({
      x: data.postX[i],
      y: data.postGroundY[i] + BLADE_MOUNT_Y - data.bladeRank[b] * BLADE_STACK,
      z: data.postZ[i],
      yaw: data.bladeYaw[b],
      name,
      style: data.postStyle[i],
    });
  }
  return out;
}

/**
 * The near-field legends: one small mesh per blade close enough to read, pooled
 * and rebuilt once a second.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL, which is the whole design.
 *
 * Every other streamed prop in this project is an `InstancedMesh`: one geometry,
 * one material, a matrix per instance, one draw for the tile. A blade with its
 * own name on it cannot be. An `InstancedMesh` binds exactly one texture, and
 * "York St" and "Kent St" are two textures, so the moment the legend is real the
 * instancing is gone -- for the *legends*. It is emphatically not gone for the
 * plates: those stay instanced, two draws a tile, and they are what the city is
 * made of at range.
 *
 * So this is a strictly local overlay, and it is bounded three ways at once:
 *
 *   * **By distance.** Only blades within `LABEL_RADIUS` get one. Past that the
 *     legend is under two pixels and the instanced plate says everything that
 *     survives -- a coloured sliver at right angles to another one.
 *   * **By count.** `MAX_LABELS`, nearest first. Sydney corners are close
 *     together and the radius alone does not bound the draws; this does.
 *   * **By texture.** `BladeTextCache` keys on *(name, style)*, so the eight
 *     corners of Crown Street inside the radius are eight meshes and one image.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT POP.
 *
 * The legend is a skin over a plate that is already there -- see
 * `buildBladeLabel`. Crossing `LABEL_RADIUS` therefore adds or removes 0.6 mm of
 * paint on an object whose silhouette, shadow and colour do not change. At 140 m
 * that paint is a fifth of a pixel. There is no transition to hide because there
 * is nothing to see.
 *
 * ---------------------------------------------------------------------------
 * WHY ONCE A SECOND.
 *
 * The set is a function of position, and the pool means a rebuild that changes
 * nothing costs nothing but the distance loop. At 6 m/s a second is 6 m of a
 * 140 m radius. The meshes are **reused in place**: a rebuild rewrites the
 * matrix and the material of pooled meshes and moves the `visible` line, so a
 * frame where nothing changed allocates nothing and a frame where everything did
 * allocates only the meshes past the previous high-water mark.
 */
export class BladeLabels {
  readonly group = new Group();
  private readonly pool: Mesh[] = [];
  private readonly assets: FurnitureAssets;
  private since = LABEL_REBUILD_S;
  /** Legends drawn at the last rebuild. Reported; read by nothing else. */
  private live = 0;

  constructor(assets: FurnitureAssets) {
    this.assets = assets;
    this.group.name = 'name_blade_legends';
    // Culled per mesh rather than as a group: the members are scattered over a
    // 280 m box and a group-level test would either draw all of them or none.
    // Each is two quads, so the per-mesh frustum test is the cheapest thing in
    // this class.
    this.group.frustumCulled = false;
  }

  get count(): number {
    return this.live;
  }

  /**
   * Advance the rebuild clock and, when it fires, re-pick the legend set.
   *
   * `sites` is a callback rather than an array so nothing is built for the
   * common frame where the clock has not fired: the caller only walks its tiles
   * on the frames this asks it to.
   */
  update(dt: number, camX: number, camY: number, camZ: number, sites: () => BladeLabelSite[]): void {
    this.since += dt;
    if (this.since < LABEL_REBUILD_S) return;
    this.since = 0;
    this.rebuild(camX, camY, camZ, sites());
  }

  private rebuild(camX: number, camY: number, camZ: number, sites: BladeLabelSite[]): void {
    // Ranked by distance and cut to `MAX_LABELS`, so an over-full frame loses
    // its furthest legends rather than an arbitrary set of them. Squared
    // distance throughout: the ordering is the same and the radius is compared
    // against its own square.
    const r2 = LABEL_RADIUS * LABEL_RADIUS;
    const near: Array<{ site: BladeLabelSite; d2: number }> = [];
    for (const site of sites) {
      const dx = site.x - camX;
      const dy = site.y - camY;
      const dz = site.z - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) near.push({ site, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    if (near.length > MAX_LABELS) near.length = MAX_LABELS;

    this.assets.labels.beginPass();
    let n = 0;
    for (const { site } of near) {
      const material = this.assets.labels.acquire(site.name, site.style);
      // Null only where there is no canvas at all. The plate underneath is
      // already drawn, so this degrades to the world as it was rather than to a
      // hole.
      if (material === null) continue;
      const mesh = this.pool[n] ?? this.grow();
      mesh.material = material;
      mesh.position.set(site.x, site.y, site.z);
      mesh.rotation.set(0, site.yaw, 0);
      mesh.visible = true;
      // Composed here rather than left to the renderer: the group never moves,
      // so nothing else would mark these dirty and a pooled mesh reused at a new
      // pose would draw at its old one for a frame.
      mesh.updateMatrix();
      n++;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].visible = false;
    this.live = n;
    this.assets.labels.endPass();
  }

  private grow(): Mesh {
    const mesh = new Mesh(this.assets.bladeLabel, this.assets.bladeMaterial[0]);
    mesh.name = 'name_blade_legend';
    // Never marked dirty by the scene graph, because `rebuild` composes the
    // matrix itself -- see there. This is what makes a rebuild that changes
    // nothing cost nothing.
    mesh.matrixAutoUpdate = false;
    // A 0.6 mm skin on a plate that already casts. Putting it in the depth pass
    // would draw the same shadow twice and, at the shadow map's 10.7 cm a texel,
    // the second copy would land in the same texels as the first.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.pool.push(mesh);
    this.group.add(mesh);
    return mesh;
  }

  /** Release the pooled meshes. The geometry and the textures are shared and stay. */
  dispose(): void {
    for (const mesh of this.pool) this.group.remove(mesh);
    this.pool.length = 0;
    this.live = 0;
  }
}

/**
 * Every traffic signal head in a tile, and the lit lamp on each, as two
 * `InstancedMesh` sets.
 *
 * The lit lamp is its own instance for the same reason the blades are: which
 * aspect is showing varies per head, and baking it into the head would mean
 * three head geometries. Instead one disc is *translated* to whichever of the
 * three lamp heights the sidecar names and coloured by `instanceColor`, so a
 * junction showing two greens and two reds is one draw of four discs.
 */
export function buildTileSignals(
  data: TileFurniture,
  assets: FurnitureAssets,
  pool: InstancePool,
  originX: number,
  originZ: number,
): InstanceClaim[] {
  if (data.signalCount === 0) return [];
  const heads = pooled(pool, 'signal_heads', assets.signal, assets.propMaterial, data.signalCount, originX, originZ);
  // The lamps never cast and never receive: an 8-triangle disc of pure emission
  // whose contribution to the depth map is a dotted line at 4 m up. This was
  // `userData.noShadow`, read by `applyShadowRole` off the tile group -- which
  // these are no longer in.
  const lamps = pooled(pool, 'signal_lamps', assets.lamp, assets.lampMaterial, data.signalCount, originX, originZ, false);
  if (heads === null || lamps === null) return unclaim(pool, [heads, lamps]);

  for (let i = 0; i < data.signalCount; i++) {
    _yaw.makeRotationY(data.signalYaw[i]);

    _matrix.makeTranslation(data.signalX[i], data.signalGroundY[i], data.signalZ[i]);
    _matrix.multiply(_yaw);
    heads.setMatrixAt(i, _matrix);
    // Tone jitter on the pole and housing only. Small, because a signal is
    // maintained infrastructure and a street of visibly different blacks reads
    // as a bug rather than as weathering.
    const t = 0.94 + 0.1 * hash(i, Math.round(data.signalX[i] * 16), 17);
    _colour.setRGB(t, t, t);
    heads.setColorAt(i, _colour);

    // The disc, 6 mm in front of the dark lens it covers, at that lens's height.
    const lit = data.signalLit[i];
    _matrix.makeTranslation(
      data.signalX[i],
      data.signalGroundY[i] + LAMP_Y[lit],
      data.signalZ[i],
    );
    _matrix.multiply(_yaw);
    _matrix.multiply(_lampOffset);
    lamps.setMatrixAt(i, _matrix);
    const c = LAMP_LIT[lit];
    _colour.setRGB(c[0], c[1], c[2]);
    lamps.setColorAt(i, _colour);
  }
  return [heads.claim, lamps.claim];
}
