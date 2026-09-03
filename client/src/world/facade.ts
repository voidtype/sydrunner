/**
 * The facade material. Spec sections 3.3, 6.4 -- with the classifier, this is the
 * project.
 *
 * The whole design rests on one idea: facade detail lives in the material, not
 * the mesh. A building arrives from the pipeline as bare walls plus a roof, about
 * thirty triangles. Everything that makes it read as a real building -- floor
 * lines at the right heights, bays at the right rhythm, windows with the right
 * proportion, reveals with real apparent depth, and at night a different lit
 * interior behind every single window -- is computed here, per pixel.
 *
 * That is what makes uniform quality across a million buildings affordable. A
 * terrace in Marrickville costs exactly what one in Surry Hills costs, which is
 * the spec's non-negotiable requirement in section 3.1.
 *
 * How a fragment knows which building it belongs to: the pipeline writes a
 * `_BLDIDX` vertex attribute and a per-tile parameter buffer, uploaded as an
 * RGBA32F data texture of width 4. Four texel fetches give the fragment its
 * building's floor height, bay width, storey count, window proportions, reveal
 * depth, material, retail flag and random seed.
 *
 * UVs arrive in **world metres**: u runs along the facade from the start of the
 * wall run, v is height above ground. So the modulo arithmetic below is
 * physical, and a 2.4 m terrace bay and a 1.5 m curtain-wall bay come out of the
 * same shader with no per-building branching.
 */

import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  floor,
  fract,
  fwidth,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  saturate,
  sin,
  smoothstep,
  step,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial, Vector3, type DataTexture } from 'three/webgpu';

import { ROW_SHIFT, ROW_TEXELS, TEXELS_PER_BUILDING } from './params-atlas.ts';

/**
 * Material slot order. Must match `mesh.MATERIALS` in the pipeline, element for
 * element -- a building's material index is written into its parameter record on
 * the Python side and read back here, so the two lists are one thing stored
 * twice. Append only.
 */
export const MATERIALS = [
  'brick_red',
  'brick_cream',
  'brick_brown',
  'sandstone',
  'concrete_precast',
  'curtain_wall',
  'corrugated_steel',
  'render_painted',
  'fibro',
  'roof_terracotta',
  'roof_steel',
  'road_asphalt',
  'footpath_concrete',
  'kerb_sandstone',
  'park_grass',
  'contact_ao',
  'awning_fascia',
  'fence_masonry',
  'fence_iron',
  'fence_timber',
  'bush_floor',
  'wetland_mud',
] as const;
export type MaterialName = (typeof MATERIALS)[number];

/**
 * The slots that lie on the ground rather than standing on it.
 *
 * Repeated from `MATERIALS` rather than sliced out of it because the split has
 * to exist in the type system: this geometry carries no `_BLDIDX` and reads no
 * parameter atlas, so handing one of these to `createFacadeMaterial` would
 * compile and then sample an attribute that is not there. Naming them separately
 * makes that a type error instead -- and `FacadeMaterialName` is derived by
 * subtraction, so adding a slot here without giving it a material is one too.
 *
 * It is also the shadow-caster test (`streamer.applyShadowRole` stores it as
 * `userData.surface`), which is why `contact_ao` belongs here despite belonging
 * to a building: a contact shadow that cast a shadow of its own would be a
 * shadow casting a shadow.
 */
export const SURFACE_MATERIALS = [
  'road_asphalt',
  'footpath_concrete',
  'kerb_sandstone',
  'park_grass',
  // The two bushland ground slots, on exactly `park_grass`' terms: flat,
  // world-metre UVs, no parameter fetch, no `_BLDIDX`, and never a shadow
  // caster. `vegetation.ts` owns all three because their colours are calibrated
  // against the foliage standing on them rather than against the paving.
  'bush_floor',
  'wetland_mud',
  'contact_ao',
] as const;
export type SurfaceMaterialName = (typeof SURFACE_MATERIALS)[number];
export type FacadeMaterialName = Exclude<MaterialName, SurfaceMaterialName>;

/**
 * The three that `street.ts` builds. A narrower set than the surfaces above:
 * park grass is a ground surface with the same needs -- flat, world-metre UVs,
 * no parameter fetch -- but its colour is calibrated against the foliage rather
 * than against the paving, so it lives with the trees in `vegetation.ts`.
 */
export const STREET_MATERIALS = ['road_asphalt', 'footpath_concrete', 'kerb_sandstone'] as const;
export type StreetMaterialName = (typeof STREET_MATERIALS)[number];

export function isSurfaceMaterial(slot: MaterialName): slot is SurfaceMaterialName {
  return (SURFACE_MATERIALS as readonly string[]).includes(slot);
}

export function isStreetMaterial(slot: MaterialName): slot is StreetMaterialName {
  return (STREET_MATERIALS as readonly string[]).includes(slot);
}

/**
 * Base colours, spec section 7.3. The parenthetical warnings there are the point:
 * Hawkesbury sandstone is warm buff-honey and **not grey**; Federation brick is
 * dark red-brown and **not orange**; galvanised steel is dull zinc and **never
 * shiny**. These are the colours that decide whether the city reads as Sydney.
 *
 * These are **linear** albedos -- they go straight into `colorNode` with no
 * sRGB decode -- and the previous set was authored as though they were display
 * values, which put most of them at reflectances no real material has: 0.78 for
 * sandstone, 0.81 for painted render, 0.77 for cream brick. Combined with an
 * exposure that was too low, the result was a city with nothing dark in it and
 * nothing bright either -- cream brick, sandstone, painted render and fibro all
 * tone mapped between 162 and 174, which is to say they were the same colour.
 * Contrast comes from albedo spread as much as it does from the light, and
 * there was none.
 *
 * Every value below is now a measured luminous reflectance, and the rendered
 * result at 3 pm on 15 February is written beside it (allowing for the ~0.87 the
 * joint, soiling and tint modulation below takes out at eye level). Those figures
 * come from the same offline evaluation that calibrated the light rig -- see
 * `sky/calibration.ts`.
 *
 * Two figures per material now, because the shaded one is a design target rather
 * than a leftover. `sun` is a wall square-on to the sun; `shade` is the other
 * side of the same street, square-on to the bounce. The sunlit column is
 * unchanged by the bounce pass and that is the point of how the bounce is aimed
 * -- it comes from behind the sun, so every surface the sun can see clamps it
 * away. The shaded column is what that pass moved: red brick from rgb(48, 14, 7),
 * a black silhouette with a blue cast, to something with a hue and a legible
 * window grid.
 *
 * A wall turned partway between the two takes `cos` of the bounce, so a street
 * corner reads as a gradient rather than as two flat values -- shaded red brick
 * runs rgb(95, 40, 17) square-on, rgb(84, 34, 14) at 45 degrees off, and
 * rgb(60, 20, 9) on a wall the bounce only grazes.
 */
const MATERIAL_LOOK: Record<
  FacadeMaterialName,
  { colour: [number, number, number]; roughness: number; metalness: number }
> = {
  // rho 0.11. Deep red-brown; the old value rendered as a desaturated pink at
  // rgb(204, 159, 145), which is the "orange" the spec warns about with the
  // saturation taken out of it as well.
  //                            sun rgb(161,  91,  72)  shade rgb( 95,  40,  17)
  brick_red: { colour: [0.235, 0.083, 0.058], roughness: 0.93, metalness: 0.0 },
  // rho 0.43, the Sydney interwar/mid-century cream.
  //                            sun rgb(231, 216, 188)  shade rgb(138, 121,  96)
  brick_cream: { colour: [0.500, 0.420, 0.300], roughness: 0.90, metalness: 0.0 },
  // rho 0.18, the darker brown-brick end of the same era.
  //                            sun rgb(168, 139, 117)  shade rgb( 94,  66,  44)
  brick_brown: { colour: [0.255, 0.170, 0.120], roughness: 0.91, metalness: 0.0 },
  // rho 0.40. Hawkesbury sandstone: warm buff-honey, iron-stained, never grey.
  // Brightest of the masonry and it should be.
  //                            sun rgb(232, 208, 163)  shade rgb(140, 116,  79)
  sandstone: { colour: [0.510, 0.390, 0.225], roughness: 0.86, metalness: 0.0 },
  // rho 0.31, board-formed and precast grey. The shaded figure is the one worth
  // reading here: it used to be rgb(43, 56, 67), a blue-grey nothing, and a
  // neutral albedo is where a cold shade term shows up most plainly.
  //
  // This slot is also every flat roof on a brutalist, tower or modern-infill
  // building -- one primitive holding both -- and up there this colour is not
  // used at all. See `flatRoofNode`.
  //                            sun rgb(186, 186, 185)  shade rgb(107, 100,  94)
  concrete_precast: { colour: [0.315, 0.305, 0.288], roughness: 0.82, metalness: 0.0 },
  // Blue-green glazing. Dark by design -- a curtain wall's brightness is its
  // reflection, which is the specular lobe, not this. -> rgb( 79, 112, 117)
  curtain_wall: { colour: [0.070, 0.115, 0.120], roughness: 0.10, metalness: 0.28 },
  // rho 0.29. Weathered galvanised steel: dull zinc. Roughness up from 0.66 and
  // metalness down from 0.42, because spec 7.3 says **never shiny** and what is
  // actually on a Sydney wall is a decades-old oxide bloom, not bare metal. The
  // sun still finds a broad specular sheen on it and that sheen is one of the
  // few things in frame that genuinely clips.       -> rgb(176, 181, 185)
  corrugated_steel: { colour: [0.280, 0.288, 0.288], roughness: 0.78, metalness: 0.30 },
  // rho 0.68, the brightest thing the city is made of, and the diffuse surface
  // that comes closest to blowing out in the sun.
  //
  // This row's `colour` is **not what a painted wall draws**. Spec 7.3 asks for
  // "painted render in inner-west pastels" -- plural -- and one warm white is not
  // a palette, so the slot picks per building out of `PAINT_PALETTE` below. The
  // value here is that palette's first and most common entry, kept in the table
  // so the calibrated anchor sits alongside the other materials it was measured
  // against; the roughness and metalness are used as written, for every tone.
  //                            sun rgb(244, 244, 239)  shade rgb(164, 156, 145)
  render_painted: { colour: [0.700, 0.680, 0.620], roughness: 0.88, metalness: 0.0 },
  // rho 0.50, painted fibro sheet.
  //                            sun rgb(230, 233, 233)  shade rgb(138, 133, 127)
  fibro: { colour: [0.500, 0.500, 0.478], roughness: 0.92, metalness: 0.0 },
  // rho 0.12. Muted, per spec 7.3 -- old terracotta is a dull earth red, and the
  // previous value was a bright salmon that made every suburban roofscape glow.
  // This is now the *brighter* of the two anchors `finishTileRoof` mixes between
  // per tile rather than the colour of a whole roof; with the dulling and course
  // shading it applies, a mid-tone tile lands at sunlit rgb(176, 106, 86) and
  // shaded rgb(62, 25, 17). Bare, on an up-facing plane, it is rgb(196, 121, 99).
  roof_terracotta: { colour: [0.190, 0.072, 0.049], roughness: 0.88, metalness: 0.0 },
  // rho 0.23, weathered corrugated roof sheet, same reasoning as the wall slot.
  // Bare, on an up-facing plane: rgb(200, 208, 212). Roofs are up-facing, so they
  // take the small `sin(16 deg)` share of the bounce and moved four code values
  // with it; the walls above did not move in sun at all.
  //
  // `finishSteelRoof` reads none of this row. A steel roof picks one of five
  // families per building -- this is the aged-galv one, repeated in
  // `STEEL_FAMILIES` -- and takes its roughness off the corrugation and its
  // metalness off whether the sheet is painted, both of which vary within one
  // roof and neither of which a single constant can say. The row stays because
  // the galv anchor has to live somewhere the other slots can be compared
  // against, and because the two lists have to move together if it ever changes.
  roof_steel: { colour: [0.200, 0.209, 0.207], roughness: 0.74, metalness: 0.28 },
  // The awning fascia and soffit. **This row is not drawn by anything.**
  //
  // `createAwningMaterial` in `world/awning.ts` serves this slot instead, and it
  // reads none of these three numbers -- the fascia picks a signage colour per
  // shop out of its own palette and the soffit is a single lining tone measured
  // against the one illuminant a down-facing surface gets. The row exists because
  // this table is typed `Record<FacadeMaterialName, ...>` and the slot *is* a
  // facade material: it casts a shadow, which is the whole point of an awning,
  // and `SURFACE_MATERIALS` is what decides that. Leaving it out is a type error
  // and adding it to the surfaces would take away the shadow.
  //
  // The value written here is the palette's darkest common ground, so the
  // calibrated anchor sits alongside the materials it was measured against.
  awning_fascia: { colour: [0.032, 0.032, 0.031], roughness: 0.58, metalness: 0.0 },
  // The three front-fence styles. **None of these three rows is drawn by
  // anything**, on the same terms as `awning_fascia` above: `world/fences.ts`
  // serves all three slots and each picks its own tone out of its own two- or
  // three-entry sub-palette on a world-position hash. The rows exist because
  // this table is typed `Record<FacadeMaterialName, ...>` and a fence *is* a
  // facade material by the test that decides it -- it stands on the ground and
  // casts a shadow across the footpath, so it must not be in
  // `SURFACE_MATERIALS`, and leaving it out of this table is a type error.
  //
  // Each value is its style's first sub-palette entry, so the calibrated anchor
  // sits beside the materials it was measured against.
  fence_masonry: { colour: [0.560, 0.545, 0.505], roughness: 0.88, metalness: 0.0 },
  fence_iron: { colour: [0.024, 0.024, 0.026], roughness: 0.62, metalness: 0.0 },
  fence_timber: { colour: [0.700, 0.690, 0.660], roughness: 0.72, metalness: 0.0 },
};

/**
 * The inner-west paint palette. Spec 7.3: "painted render in inner-west pastels".
 *
 * Half the point of the pipeline pass that landed with this: `render_painted` is
 * now 21% of the city rather than 12%, and 35% of every terrace, because a
 * painted terrace is the inner-west signature. Drawing all of them in one warm
 * white would have replaced a monochrome brick street with a monochrome white
 * one, which is the same failure wearing a different colour.
 *
 * These are **linear albedos**, same convention and same measurement basis as
 * `MATERIAL_LOOK` -- a house is painted by one owner in one decade, so the choice
 * is per building and nothing else. Walk Camperdown and this is what is on the
 * walls: mostly whites and creams, a solid minority of greys and greens, and the
 * occasional ochre or terracotta that somebody committed to in 1987.
 *
 * Predicted display values through `sky/calibration.ts` at 3 pm on 15 February,
 * at the 0.87 the joint, soiling and tint modulation takes out at eye level, for
 * the four tones that bracket the set. `sun` is a wall square-on to the sun,
 * `shade` the other side of the same street:
 *
 *   warm white        sun rgb(244, 244, 239) Y' 244   shade rgb(164, 156, 145) Y' 157
 *   pale sage         sun rgb(208, 222, 204) Y' 218   shade rgb(122, 124, 107) Y' 122
 *   dusty pink        sun rgb(235, 210, 208) Y' 215   shade rgb(143, 118, 111) Y' 123
 *   soft terracotta   sun rgb(199, 149, 130) Y' 158   shade rgb(115,  73,  53) Y'  87
 *
 * THE SHADED COLUMN IS WHERE THE PALETTE ACTUALLY READS, and the numbers say so
 * plainly. In full sun the tone curve compresses everything above rho 0.42 into
 * 34 code values of luminance -- warm white, cream and off-white land within
 * eight of each other, which is exactly what a photograph of a sunlit white
 * street shows and is not a fault. What separates them there is *hue*: sage puts
 * 18 code values of green over red, sky blue 32 of blue over red, ochre 67 of red
 * over blue, and those survive the compression intact. In shade the value spread
 * reopens to 70 code values and the palette reads as a palette.
 *
 * Nothing here is saturated. A pastel is a low-chroma tint of white and the
 * moment one of these goes past about 40% chroma it stops reading as house paint
 * and starts reading as a colour-picker default; soft terracotta is the darkest
 * and is deliberately the rarest at 5%.
 *
 * The shares are the whole street, not a uniform draw -- whites and creams are
 * 42% between them because that is what a Sydney street is. They are normalised
 * at build time, so they need not sum to 100, but they do.
 */
const PAINT_PALETTE: readonly { name: string; colour: [number, number, number]; share: number }[] = [
  { name: 'warm white', colour: [0.700, 0.680, 0.620], share: 16 },
  { name: 'cream', colour: [0.660, 0.605, 0.480], share: 14 },
  { name: 'off-white', colour: [0.725, 0.720, 0.690], share: 12 },
  { name: 'light grey', colour: [0.470, 0.478, 0.478], share: 11 },
  { name: 'pale sage', colour: [0.395, 0.440, 0.355], share: 10 },
  { name: 'pale sky blue', colour: [0.425, 0.485, 0.545], share: 9 },
  { name: 'dusty pink', colour: [0.530, 0.405, 0.380], share: 9 },
  { name: 'light ochre', colour: [0.535, 0.430, 0.245], share: 8 },
  { name: 'grey-green', colour: [0.285, 0.325, 0.288], share: 6 },
  { name: 'soft terracotta', colour: [0.360, 0.195, 0.145], share: 5 },
];

/**
 * Mortar, and the reason a brick wall is not one colour.
 *
 * A brick wall is brick *and* joint, and the joint is a different material laid
 * by a different trade out of a batch mixed for that one job. Lime-rich mortar on
 * Federation and interwar stock is close to white and lifts the whole wall; a
 * raked or ironed cement joint on a post-war infill is darker than the brick and
 * drops it. That is per building, exactly the way the paint is, and it is the
 * close-range half of why two red-brick terraces side by side are not the same
 * red -- the other half is the value tint, which is what carries to distance.
 *
 * Linear albedos again. On brick_red at the 0.45 mix weight below, the joint line
 * itself renders sunlit rgb(130, 81, 69) with a raked cement joint against
 * rgb(204, 182, 175) with pale lime, either side of a brick face at
 * rgb(161, 91, 72) -- a dark grid or a light one, which is what the two look like.
 *
 * The joint mask integrates to about 5% of a course, so past the distance where
 * a 10 mm joint resolves this is worth only 1-7 code values of shift on the
 * wall's mean. That is intentional and it is why the per-building value tint
 * below is the wider of the two effects: mortar is the close read, tint is the
 * distance read, and a wall needs both to stop being flat at either range.
 */
const MORTAR = {
  raked: [0.058, 0.055, 0.050] as const,
  lime: [0.560, 0.545, 0.505] as const,
};

/** How far the joint band goes toward mortar. See MORTAR. */
const MORTAR_JOINT_MIX = 0.45;

/**
 * Per-building value spread, as a fraction either side of the base albedo.
 *
 * Brick is nearly twice the render figure and that asymmetry is the point. A
 * painted wall's variety is already carried by `PAINT_PALETTE` picking a
 * different *colour*, so the tint on top of it only has to be the fade and
 * repaint history of one tone; brick has no palette -- there are three brick
 * slots and that is the whole of it -- so the tint is the only thing standing
 * between a street of terraces and a single flat red. At +/-18% a red brick
 * terrace runs sunlit rgb(146, 79, 61) to rgb(175, 101, 82), which is genuinely
 * a darker and a lighter red rather than the same red twice, and it is still
 * inside what one kiln's output actually spans.
 */
const TINT_SPREAD = { brick: 0.18, other: 0.10 };

/**
 * The world a window reflects, as **linear radiance**, not albedo.
 *
 * A daytime window is not a dark hole with a tint on it: the glazing mirrors the
 * sky and the sunlit buildings opposite, and on a shaded facade that reflection
 * is routinely the *brightest thing in frame*. That inversion -- glass brighter
 * than the wall it sits in, while the wall is in shade -- is the single tell that
 * separates real glazing from a painted-on rectangle, and it is what this table
 * exists to produce.
 *
 * The two sky values are not invented. `sky.ts` records what the Preetham dome
 * actually resolves to at 3 pm on 15 February: linear (0.31, 0.97, 2.73) at the
 * zenith and (6.5, 7.9, 8.3) in the horizon haze band, which through Neutral at
 * exposure 0.62 are rgb(114, 166, 249) overhead and rgb(238, 250, 254) at the
 * horizon. Copying them here means a window and the sky above it are the same
 * blue, because they are literally the same numbers -- and if the dome is ever
 * retuned, the glass is wrong until these follow it. Note the horizon is eight
 * times the zenith in luminance: most window reflections point near-horizontal,
 * so most of them land in the bright end of that range, which is exactly why
 * real windows read pale rather than blue.
 *
 * `STREET` is what the glass sees below the horizon. Not asphalt -- the mirror
 * direction of a downward view off a vertical wall lands mostly on the *sunlit
 * facade opposite* and the footpath in front of it, so this is a warm mid-tone
 * (a perfect mirror of it renders rgb(149, 137, 123)), not a dark road.
 *
 * What is deliberately not modelled: occlusion. The glass sees an unobstructed
 * dome, so inside a narrow canyon it reflects haze band where a real window would
 * reflect the building across the street. The honest fixes are a cube map or a
 * screen-space trace and both are out of budget by an order of magnitude; the
 * soft horizon blend below hides most of it, because a real skyline sits within a
 * few degrees of where this puts the transition anyway.
 */
const GLASS_SKY = {
  zenith: [0.31, 0.97, 2.73] as const,
  horizon: [6.5, 7.9, 8.3] as const,
  street: [0.55, 0.47, 0.38] as const,
};

/**
 * How fast the reflected sky runs from horizon to zenith, as `elevation^k`.
 *
 * Fitted against Preetham's own gradient term `1 + A*exp(B/cos(theta))` at this
 * sky's turbidity, normalised between the two anchors above. That says the sky is
 * 30% of the way to zenith at 10 degrees of elevation, 71% at 25 and 90% at 45;
 * 0.65 reproduces the first of those exactly and runs up to 15% bright at the
 * top. The low end is the one worth matching -- a player at street level looking
 * at a facade sees reflections between 0 and 20 degrees almost exclusively, and
 * that is the band where getting it wrong turns every window grey.
 */
const GLASS_SKY_FALLOFF = 0.65;

/* ---------------------------------------------------------------------------
 * Per-window daytime life. Spec 6.4 asks for a "per-window randomised interior:
 * lit/unlit, blind up/down/half, curtain colour", and until this pass only the
 * night half of that existed. By day every window on a facade was the same pane
 * of the same glass at the same reflectance -- and a facade whose windows are
 * all identical is a facade with nobody in it, which is the one thing a city
 * cannot be.
 *
 * Everything below is a `step` on a hash. No geometry, no textures, no loops.
 * The shares are what a walk down a street of terraces and interwar flats
 * actually shows rather than a set of round numbers, and they are *independent*
 * draws -- see the roll block inside `createFacadeMaterial` for the measured
 * co-occurrence rates, which matter more than the shares do. Two of these
 * correlating is what turns a facade back into a pattern.
 * ------------------------------------------------------------------------- */

/**
 * How many windows are dressed, opened and fitted.
 *
 * `blind` and `curtain` are two arms of one roll and are therefore mutually
 * exclusive by construction: a window has one covering or none. The remaining
 * 40% is bare glass, and it has to stay the largest single share -- the
 * reflection is what makes glazing read as glazing (see `GLASS_SKY`), and a
 * facade with a blind in four windows out of five is a facade with no windows.
 *
 * `openSash` applies only to the pre-war double-hung stock `frameNode` already
 * gives a meeting rail; `aircon` only to the archetypes that were built without
 * ducting and have had a box screwed to them since -- interwar flats, walk-ups,
 * suburban brick veneer and modern infill.
 */
const WINDOW_LIFE = {
  blind: 0.45,
  curtain: 0.15,
  openSash: 0.08,
  aircon: 0.12,
} as const;

/**
 * What a drawn blind is worth as a daytime albedo, as a multiplier on the
 * existing night fabric colour.
 *
 * One number rather than a second palette, and that is the whole day/night
 * join: the night path multiplies the same fabric colour by `0.35 + lit*0.8`,
 * so `mix(BLIND_DAY_LEVEL, 0.35, nightFactor)` reaches *exactly* the existing
 * expression at nightFactor 1 and nothing after dark moves by a code value.
 *
 * 0.46 is set by where the band has to land between the two things it sits
 * against. Through the chain in `sky/calibration.ts` at 3 pm on 15 February, on
 * the shaded side of a street, windows reflecting sky 12 degrees up:
 *
 *   the glass it replaces (bare, reflecting)  rgb(104, 116, 124)  Y' 114
 *   blind, dark fabric (hueRoll 1)            rgb(139, 142, 144)  Y' 142
 *   blind, light fabric (hueRoll 0)           rgb(154, 157, 157)  Y' 156
 *   the painted frame in front of it          rgb(178, 169, 159)  Y' 170
 *
 * Clearly lighter than the glass, clearly darker than the joinery, and neutral
 * against glass that is cool -- three separate reads, which is what stops a
 * drawn blind looking like a dirty window. In full sun the same fabric is
 * rgb(224, 229, 230) against brick_cream at rgb(231, 216, 188): eleven code
 * values apart in luminance and forty-two in blue, which is the right way round
 * -- up there the tone curve has compressed the value spread out of everything
 * over rho 0.42 and hue is all that is left to separate two bright surfaces.
 */
const BLIND_DAY_LEVEL = 0.46;

/**
 * What a covering does to the reflection in front of it.
 *
 * Almost nothing, and that is deliberate. The reflection is a *front-surface*
 * effect: the glass does not know what is behind it, so a drawn blind cannot
 * switch it off. What it does remove is the second bounce off the inner pane
 * and off the room behind, which is a real and small part of what a window
 * shows. 12% is that, and it is small enough that the property the file already
 * relies on survives -- at grazing incidence a blind renders rgb(220, 235, 241)
 * against bare glass at rgb(212, 232, 240), which is to say it disappears under
 * the mirror exactly as it must.
 *
 * A large dim here would look like the obvious move and is the trap: it makes
 * every blinded window on a curtain-lit street go flat at exactly the angle
 * where glazing is at its most convincing.
 */
const BLIND_REFLECTION_DIM = 0.88;

/**
 * Half-open curtains: where the leading edge sits, as a fraction of the
 * opening's half width, and how soft it is.
 *
 * A blind is a horizontal line with a hard bottom rail; curtains are two
 * vertical bands gathered at the jambs. That difference in *axis* is what makes
 * the two read as different objects at fifty metres, and it is why this is a
 * separate pattern rather than another height on the same one. The soft edge is
 * the second tell: cloth gathers, a bottom rail does not, so the curtain uses a
 * `smoothstep` where the blind uses a `step`.
 *
 * 0.40 to 0.74 keeps at least a quarter of the opening clear on the tightest
 * draw, because a curtain closed all the way is a blind and there is already
 * one of those.
 */
const CURTAIN = { edge: 0.4, spread: 0.34, softness: 0.07 } as const;

/**
 * The raised lower sash. 8% of the pre-war double-hung stock, and the single
 * cheapest thing on this list that sells occupancy.
 *
 * Three things happen at once and none of them works alone:
 *
 *   - the lower pane is *gone*, so there is no reflection there at all and what
 *     is left is a room seen directly. `interior` is that room, and it is dark
 *     enough to be a hole: rgb(9, 4, 1) on a shaded wall and rgb(18, 15, 13) on
 *     a sunlit one. A black rectangle in a sunlit brick wall is what an open
 *     window looks like from across a street and nothing else in this shader
 *     produces one.
 *   - the pane is now stacked *behind* the upper one, so the upper half is
 *     looking through two sheets of glass and reflects off both. `upperGain` is
 *     that second reflection, attenuated by the two transmissions it makes on
 *     the way (1 + (1-F)^2 at F 0.055 -> 1.89, so "double" less the loss). It
 *     takes the upper pane from rgb(104, 116, 124) to rgb(142, 158, 169), a
 *     clear step across the rail.
 *   - the meeting rail moves with the sash that carries it, to two thirds of
 *     the way up the opening. `railRise` is that offset from the mid-line, in
 *     units of the opening's half height. Done in `frameNode`, because the rail
 *     is joinery and stands at the wall plane.
 *
 * After dark the hole goes deeper still (`nightDeepen`) and, if the room behind
 * it is lit, leaks: `nightLeak` of the emissive a glazed window would put out,
 * so an open lit window reads rgb(101, 82, 48) against a closed one at
 * rgb(192, 163, 120). Dimmer, not brighter -- through an open sash you are
 * looking at a ceiling and a wall, not at the light fitting.
 */
const OPEN_SASH = {
  interior: [0.014, 0.013, 0.012] as const,
  upperGain: 1.89,
  railRise: 1 / 3,
  nightDeepen: 0.6,
  nightLeak: 0.3,
} as const;

/**
 * A window air conditioner: 700 x 450 mm, which is the box a hardware shop has
 * sold in this city since about 1975.
 *
 * Drawn flat, because it is flat -- a pressed steel casing with a moulded
 * grille in it, seen from the street at a distance where its own relief is one
 * pixel. What makes it read is the *silhouette plus the shadow under it*, not
 * shading on the box, and that is why the shadow is here at all.
 *
 * Predicted at 3 pm on 15 February on the shaded side of a street, against the
 * cream brick it usually sits on:
 *
 *   cream brick wall            rgb(138, 121,  96)  Y' 123
 *   casing                      rgb(141, 136, 134)  Y' 137
 *   grille band                 rgb( 64,  60,  59)  Y'  61
 *   the shadow under it         rgb( 85,  71,  51)  Y'  73
 *
 * The casing is only 14 code values of luminance over the wall and that is not
 * the separation doing the work -- it is 38 code values of *blue*. Every
 * masonry colour in this file is warm and every appliance ever bolted to one is
 * neutral, so a cool grey box on cream brick reads as a different substance
 * before it reads as a lighter one. In full sun the pair is rgb(227, 232, 238)
 * against rgb(231, 216, 188) -- fourteen code values of luminance between them
 * and fifty of blue, which is the same ordering the shade gives and is why this
 * works on both sides of a street rather than only the dark one.
 *
 * `shadowStrength` is the peak of a ramp that dies over `shadowDrop`, and it is
 * the same 0.55-0.60 the ground's contact skirt uses at the wall for the same
 * physical reason: a box hard against a wall closes off most of that strip's
 * view of the sky.
 */
const AIRCON = {
  width: 0.7,
  height: 0.45,
  casing: [0.515, 0.522, 0.53] as const,
  grilleMix: 0.3,
  shadow: [0.03, 0.028, 0.026] as const,
  shadowDrop: 0.055,
  shadowStrength: 0.6,
} as const;

/**
 * The front door. Spec 6.3's last clause -- "Openings. Front door placed on the
 * street-facing edge, at the bay nearest the footprint centroid" -- and until
 * this pass the only clause of the grammar with nothing behind it.
 *
 * What it buys is out of proportion to what it costs, and the reason is rhythm
 * rather than the door itself. A terrace row's street elevation is *door,
 * window, door, window* at a 5 m pitch, and that alternation is the single thing
 * that says "these are houses" rather than "this is a wall with holes in it".
 * The pipeline cut terrace rows into individual houses two passes ago; this is
 * what makes that visible from the footpath.
 *
 * WHERE IT COMES FROM. One float in the parameter record -- texel 2 slot 3, the
 * door's centre as metres along the perimeter in the same `u` the wall UVs carry
 * -- and nothing else. Everything below is derived from parameters the shader
 * already has: the leaf width and head from the retail flag, the fanlight from
 * the archetype index, the paint from the seed. Negative means no door.
 *
 * IT IS A WALL-PLANE FEATURE AND TAKES NO PARALLAX, exactly like `frameNode`'s
 * joinery and for the same reason: an architrave and a door leaf stand in front
 * of the wall, not behind it, and anything at the wall plane that slides with
 * the viewer reads as a decal printed on the building. The recess is drawn as
 * shading (`revealShade` below) rather than as an offset.
 *
 * The dimensions are one set of numbers checking another. `width` is the
 * *opening*, architrave to architrave, and `architrave` is a band drawn inside
 * it -- so the leaf that falls out of a 1 m opening is 1.00 - 2 x 0.09 = 0.82 m
 * wide, which is the Australian standard door leaf exactly and was not aimed at.
 * It stands 1.95 m from the top of its threshold to the underside of the head
 * architrave, which is that same 2040 leaf less the architrave over it.
 *
 * The whole assembly is 2.10 m tall without a fanlight, which is why the
 * pipeline refuses a door below 2.2 m of building (`mesh.DOOR_MIN_HEIGHT`) --
 * 100 mm of clearance under the wall's own top edge, and the roofline trim that
 * shares this material carries a v of `height + 0.05`, so it clears that too.
 *
 * PREDICTED DISPLAY VALUES, 3 pm on 15 February through `sky/calibration.ts`,
 * at the `soil` factor the door shares with the wall (0.846 at mid-leaf). The
 * two palette extremes are the ones that bracket the set:
 *
 *                                 sun                      shade
 *   heritage green leaf     rgb( 33,  75,  56) Y'  65   rgb(  6,  36,  18) Y'  28
 *   heritage cream leaf     rgb(236, 234, 223) Y' 234   rgb(145, 135, 122) Y' 136
 *   ...against red brick    rgb(161,  91,  72) Y' 105   rgb( 95,  40,  17) Y'  50
 *   ...against warm white   rgb(244, 244, 239) Y' 244   rgb(164, 156, 145) Y' 157
 *   painted architrave      rgb(244, 244, 241) Y' 244   rgb(164, 156, 147) Y' 157
 *   threshold step          rgb(191, 182, 163) Y' 183   rgb(110,  97,  79) Y'  98
 *   leaf edge, at the reveal floor:
 *     heritage green        rgb( 15,  53,  37) Y'  44   rgb(  2,  24,   9) Y'  18
 *     heritage cream        rgb(182, 180, 171) Y' 180   rgb(103,  95,  84) Y'  96
 *   panel moulding groove:
 *     heritage green        rgb( 18,  57,  40) Y'  47   rgb(  2,  26,  11) Y'  20
 *     heritage cream        rgb(193, 190, 181) Y' 190   rgb(111, 103,  91) Y' 104
 *
 * READ THE TWO EXTREMES AGAINST THEIR WALLS, because they fail in opposite
 * directions and both are covered. A dark door on brick is carried by *value*:
 * 40 code values in sun and 22 in shade, which clears the file's own "dozen
 * code values a viewer stops resolving at distance" bar three times over. A
 * cream door on painted render is not -- it is 10 code values in sun, because
 * the tone curve compresses everything over rho 0.42 into 34 code values, the
 * same compression `PAINT_PALETTE` documents at length. What carries that one is
 * *structure*: the reveal shading at the leaf edge (180 against the architrave's
 * 244, so 64 code values), the four panel grooves (190, so 54) and the threshold
 * (183, so 61). Which is exactly how a white door on a white wall reads in a
 * photograph -- by its shadows and its mouldings, not by its colour.
 *
 * AT NIGHT the leaf emits nothing and is a silhouette at rgb(1, 1, 2) against a
 * brick wall at rgb(5, 1, 0), and the fanlight joins the lit-window lottery on
 * the same `lit` node the windows use -- literally the same roll of the same
 * cell, since a door's bay and storey are the cell the hash is taken over. A lit
 * fanlight lands at rgb(179, 152, 111) against the lit window above it at
 * rgb(192, 164, 121): the same light, 0.86 of it, because a fanlight sits at the
 * back of the same reveal and sees the same slot of sky.
 */
const DOOR = {
  /** The opening, architrave to architrave. See above for what the leaf is. */
  width: 1.0,
  widthRetail: 1.3,
  /** Head height above the pad. A shop's entrance is taller than a house's. */
  head: 2.1,
  headRetail: 2.4,
  /**
   * The architrave, as a band inside the opening on the jambs and the head --
   * NOT across the bottom, where a door meets its threshold and there is no
   * architrave in life. 90 mm is a lambs-tongue moulding and it is deliberately
   * the same order as the 78 mm sash stile `frameNode` draws: the two are the
   * same trade, the same timber and the same paint, and they take the same
   * widen-and-hold fade so they dissolve together.
   */
  architrave: 0.09,
  /**
   * How much wall beyond the architrave the door claims back from the window
   * grammar. A jamb's worth, so a shopfront's glass stops a hand's breadth off
   * the door surround rather than butting into it. The pipeline uses the same
   * number to decide whether an edge is wide enough to hold a door at all --
   * see `mesh.DOOR_ARCHITRAVE`, which is where both live on that side.
   */
  cutMargin: 0.05,
  /**
   * The step, and the one detail that stops a door looking printed on. A door
   * sits above the footpath on a threshold -- sandstone on the pre-war stock,
   * concrete since -- and 60 mm of it below the leaf is the line the eye reads
   * as "this is a way in" before it has resolved anything else.
   */
  step: 0.06,
  threshold: [0.34, 0.30, 0.23] as const,
  /**
   * How far below the pad the steps reach, metres, and each riser. 2.4 m is
   * fourteen risers -- the deepest a front flight gets before it is a
   * staircase with a landing, and past it the skirt is masonry again. See
   * the steps in the door node.
   */
  stepsDown: 2.4,
  riser: 0.17,
  /** How far past the architrave the flight spreads, each side. */
  stepsSide: 0.25,
  /**
   * The fanlight over a terrace or federation door: a 340 mm light on a 70 mm
   * transom bar. Sydney terraces have these almost universally and they are the
   * reason a terrace's opening reads as taller than its door.
   *
   * `minStorey` is the ground-storey height below which it is not drawn, and it
   * is a clearance test rather than a taste one: leaf head 2.10 + bar 0.07 +
   * light 0.34 + architrave 0.09 is 2.60 m of assembly, and the roofline trim
   * carries a v of `height + 0.05` in this same material. 2.9 m keeps the
   * fanlight clear of it on every building that has one.
   */
  transomBar: 0.07,
  transomHeight: 0.34,
  transomMinStorey: 2.9,
  /**
   * How much of the daylight reflection a recessed fanlight keeps. The same
   * argument `revealShade` makes for a window: glass at the back of a reveal
   * sees a slot of sky rather than a hemisphere of it.
   */
  glassReveal: 0.86,
  /**
   * The reveal. A door leaf is set back in its frame, and the shading at the
   * edges is the whole of the depth cue -- there is no parallax here by design.
   * `shade` is the floor the ramp reaches hard against the architrave, and it is
   * deeper than the window's 0.52-to-1.0 ramp is wide because a door reveal is
   * a genuine 70 mm rebate rather than a 30 mm one.
   */
  reveal: 0.07,
  revealShade: 0.55,
  /** The four-panel Victorian door: stile and rail widths, and the moulding. */
  stile: 0.075,
  rail: 0.11,
  moulding: 0.014,
  /** How much darker a sunk panel is: it sees less sky than the stiles do. */
  panelSink: 0.06,
  /** Semi-gloss enamel on timber. Between the frame's 0.38 and its 0.55. */
  roughness: 0.42,
} as const;

/**
 * What a Sydney front door is painted, as linear albedos and the share of the
 * street each tone has.
 *
 * A HERITAGE PALETTE, AND NARROW ON PURPOSE. `PAINT_PALETTE` above is pastels
 * because that is what a wall is; a door is the opposite -- it is the one
 * element of a terrace that is allowed to be saturated and dark, and it is
 * traditionally painted in the four colours below plus a stained cedar and a
 * cream. Half the point of a door is that it is *darker than the wall it is in*,
 * which is why five of the six sit under rho 0.10 and the shares put 70% of the
 * city's doors down there.
 *
 * Picked by a thresholded chain on `BUILDING_STRIDES.door`, hashed rather than
 * spun for the reason `ROLL_STREAM` states: a roll you are going to threshold
 * has to be independently hashed, not derived.
 */
const DOOR_PALETTE: readonly { name: string; colour: [number, number, number]; share: number }[] = [
  { name: 'heritage green', colour: [0.030, 0.062, 0.042], share: 22 },
  { name: 'gloss black', colour: [0.021, 0.021, 0.023], share: 20 },
  { name: 'oxide red', colour: [0.092, 0.030, 0.024], share: 16 },
  { name: 'heritage cream', colour: [0.560, 0.530, 0.460], share: 18 },
  { name: 'navy', colour: [0.024, 0.034, 0.072], share: 12 },
  { name: 'stained cedar', colour: [0.058, 0.030, 0.018], share: 12 },
];

/**
 * Per-window grime: how clean this pane's glass is, as a spread either side of
 * the reflection this shader would otherwise give every window equally.
 *
 * A facade's glazing is not uniformly mirror-fresh -- one flat gets its windows
 * done twice a year and the one above it has not since it was tenanted -- and
 * without this the *reflection* is the one thing on a facade that stays
 * perfectly regular however varied the blinds behind it get. +/-15% lands the
 * cleanest pane at rgb(111, 124, 133) and the dirtiest at rgb(98, 106, 112)
 * against a mean of rgb(105, 115, 123): under ten code values, which is exactly
 * the size it should be. Bigger and it stops being dirt and starts being a
 * different glazing type.
 *
 * `desaturate` is the half that makes it read as film rather than as exposure.
 * Dirt is a diffusing layer, so it does not merely darken the sky behind it, it
 * takes the blue out of it -- and a window that is dimmer *and* greyer is
 * dirty, where one that is only dimmer is in shadow.
 */
const GRIME = { spread: 0.15, desaturate: 0.2 } as const;

/* ---------------------------------------------------------------------------
 * DISTANCE. What a facade converges on once its grammar stops being sampled.
 *
 * The roofs solved this and the walls never got the treatment. `resolves` and
 * `softLine` at the bottom of this file are the two constructions: a pattern
 * fades to *its own mean* rather than to nothing, and a thin line is widened to
 * the pixel footprint with its contrast cut by exactly the factor it was
 * widened, so the area under it is held and it dissolves instead of crawling.
 * A tile roof at two hundred metres is a flat colour of the right value; a
 * facade at two hundred metres was a boiling grid of windows, mullions and
 * glazing sparkle, and at 0.75 render scale it was the loudest artefact left in
 * any mid-to-far view.
 *
 * WHAT THE FACADE FADES TO IS NOT THE WALL, and that is the whole design. A
 * distant tower faded to bare concrete is a slab of concrete, which is the far
 * -LOD flatness problem wearing the opposite sign: what makes a curtain wall
 * read at two kilometres is that it is *glass*, and glass is 82% of its area.
 * So every mask fades to its own **area share** and the composite arithmetic
 * then produces the correct mean facade for free -- `mix(wall, glass, openFrac)`
 * is the analytic average of a bay, written as the same expression that draws
 * one. Nothing had to be added to the colour path; the masks that feed it stop
 * being 0-or-1 and become the fractions they average to.
 *
 * The three fractions below are the ones that cannot be read off the parameter
 * record directly. Everything else in the mean -- the opening's width as a
 * fraction of the bay, its height as a fraction of the storey -- IS a parameter,
 * which is why this is so cheap.
 *
 * MEASURED, not asserted. Each constant was fitted against a brute-force area
 * integration of this shader's own masks over a whole elevation -- one bay wide,
 * ground to `b.height`, on a 150 x 400 grid, over 90-220 seeds, for all ten
 * archetypes at their classifier heights. The end-to-end check is the one that
 * matters and it is the last table in this comment: the analytic mean against
 * the true area average of the drawn facade, in display code values through
 * `sky/calibration.ts`.
 *
 *   frameK   The joinery, as `K * frameWidth * (perimeter / area)` of one
 *            opening. A frame is a band of constant width run round a
 *            rectangle, so its area is the perimeter times the width to first
 *            order; K is what folds in the three members that are not the
 *            perimeter -- the deeper sill band at 2.2x the frame width, the
 *            meeting rail on the pre-war stock, and the centre mullion on any
 *            opening over 1.45 m. Those were tried as explicit terms first and
 *            REMOVED: fitting K over the ten archetypes with them present gave
 *            K 1.17 and a spread of -8% to +6%, without them K 1.34 and -18% to
 *            +17% -- and the end-to-end display error was *the same or better*
 *            without them (4 code values worst case either way), because a
 *            frame is 7-9% of a facade's area and 18% of that is under two code
 *            values. Six instructions at each of the two sites that need this,
 *            for nothing measurable.
 *
 *              terrace +11%   federation +5%   interwar +1%   walk-up -17%
 *              brutalist -17%  tower +17%   warehouse -18%   veneer -6%
 *              retail -8%   modern infill -15%
 *
 *            The frame width is read per fragment rather than per building,
 *            which is what makes the retail case work without any extra
 *            arithmetic: a shopfront's 30 mm structural glazing and the 78 mm
 *            timber sashes two storeys above it are the same expression
 *            evaluated on different storeys.
 *
 *   reveal   How much the reveal shading takes out of an opening on average.
 *            `revealShade` ramps 0.52 to 1.0 over `revealDepth` metres in from
 *            the opening edge, so the shortfall is half the ramp over the
 *            fraction of the opening within one reveal depth of its perimeter:
 *            `1 - C * revealDepth * (perimeter / area)`. Fitted C 0.22 against
 *            the same integration, rms 0.0027 -- the closest fit of the three,
 *            because unlike the frame it has no members hiding inside it.
 *
 *   life     What the per-window life averages to over an opening: the blind
 *            and curtain coverage, the hole where a raised lower sash was, and
 *            the doubled upper pane above it. The last two are exact rather
 *            than fitted -- 8% of windows open, and `OPEN_SASH.railRise` puts
 *            the rail a third of the way up, so the hole is 8% x 2/3 and the
 *            upper pane 8% x 1/3, both gated to the sashed stock. The first is
 *            a genuine average: 0.233 on a retail strip to 0.376 on a
 *            warehouse, mean 0.296, and the spread is structural (it is where
 *            the opening sits inside its storey, since a blind's drop is
 *            measured against the storey and not the hole). One constant is
 *            enough -- +/-25% of a 0.30 mix toward a fabric 36 code values off
 *            the glass is under a code value on the facade.
 *
 *   aircon   The box unit is 0.7 x 0.45 m on 12% of the windows of four
 *            archetypes, which integrates to 0.45% of a bay's area at a
 *            measured mean colour of (0.318, 0.322, 0.327) -- the casing, its
 *            grille band and its shadow, area-weighted. Its contribution to the
 *            mean is a third of a code value. It fades to that rather than to
 *            zero anyway, because a mask that fades to zero changes the wall's
 *            brightness as it recedes and that is the one thing this discipline
 *            does not allow.
 *
 * END TO END, the analytic mean against the true area average of the drawn
 * facade, at 3 pm on 15 February through `sky/calibration.ts`. `exact` is the
 * brute-force integration, `mean` is what the faded shader converges on:
 *
 *                                   exact              mean            dY'
 *   tower / curtain_wall     sun    rgb(202,232,245)   rgb(202,232,244)   1
 *   tower / curtain_wall     shade  rgb(200,231,244)   rgb(199,230,243)   1
 *   walk-up / brick_cream    sun    rgb(217,206,183)   rgb(216,205,183)   1
 *   walk-up / brick_cream    shade  rgb(134,122,105)   rgb(134,122,105)   0
 *   terrace / brick_red      shade  rgb( 99, 65, 57)   rgb( 99, 64, 54)   1
 *   retail / render_painted  shade  rgb(164,163,160)   rgb(164,162,159)   1
 *   veneer / brick_brown     shade  rgb(102, 84, 73)   rgb(102, 85, 75)  -1
 *   brutalist / precast      shade  rgb(118,117,115)   rgb(117,116,115)   1
 *   terrace / brick_red      NIGHT  rgb( 45, 37, 29)   rgb( 42, 33, 25)   4
 *
 * Worst case four code values, on the darkest surface in the build. The file's
 * own bar elsewhere is "the dozen code values a viewer stops resolving at
 * distance", and this clears it by three times.
 */
const MEAN = {
  frameK: 1.34,
  reveal: 0.22,
  /** blind/curtain coverage, the open sash's hole, and its doubled upper pane. */
  life: [0.30, 0.08 * (2 / 3), 0.08 / 3] as const,
  airconCover: 0.0045,
  airconColour: [0.318, 0.322, 0.327] as const,
} as const;

/**
 * The fade bands, finest to coarsest, and the distances they land at.
 *
 * Every one is a footprint in metres of wall per pixel, out of one `fwidth`
 * pair on the wall-plane coordinate, so all of them follow render scale, field
 * of view and the angle the wall is seen at without any of them being passed
 * in. The distances quoted throughout this file are at 72 degrees of vertical
 * field of view and 840 pixels of drawing buffer -- a 1120-pixel window at the
 * 0.75 render scale `main.ts` starts on -- which is `d = 578 * footprint`, and
 * which reproduces the roof path's own published figures for the 762 mm sheet
 * column (full to 145 m, gone by 317 m against its stated "about 145" and
 * "about 320"). Halve the buffer and every distance below halves with it.
 *
 * WHY THE TWO GRID AXES ARE SEPARATE and not one `min`, which was the obvious
 * construction and is wrong on half the city. A window grid has two periods --
 * the bay across and the storey up -- and they are not close: a CBD curtain
 * wall is 1.5 m by 3.6 m, a walk-up is 3.6 m by 2.7 m. Gating both on the
 * smaller throws away the coarser axis while it is still four to six pixels a
 * period and perfectly legible, and the coarser axis is *different building to
 * building*: a tower's bays go first and its floor banding survives to twice
 * the distance, which is exactly what a real tower looks like at range, while a
 * walk-up is the other way round because its floor-to-floor is finer than its
 * bay. One `min` cannot express that in either direction. The opening mask is
 * separable -- a rectangle is `insideX AND insideY` -- so fading the two
 * factors independently and multiplying is not an approximation of the mask, it
 * IS the mask, and each factor converges on its own axis's occupancy.
 *
 *   (a) joinery         30-90 mm. `softLine`'s widen-and-hold, so it needs no
 *                       band of its own; the blend to the analytic frame
 *                       fraction rides on the same `held` factor. Exactly
 *                       unchanged to 63 m on 78 mm painted timber, 36 m on
 *                       45 mm aluminium, 24 m on 30 mm shopfront glazing;
 *                       fully dissolved by 235 / 135 / 90 m.
 *   (b) window grid     periods `bayWidth` and the storey height, faded
 *                       independently. Full detail to six samples a period,
 *                       gone by two, which is `resolves`'s default band and the
 *                       right one for a hard-edged high-contrast pattern.
 *                         tower  bays 139-434 m, floors 333-1040 m
 *                         terrace bays 222-694 m, floors 342-1069 m
 *                         walk-up floors 250-780 m, bays 333-1040 m
 *   (c) per-window life at twice the footprint of (b), so it is gone at half
 *       and glazing    the distance: these carry the highest contrast on the
 *                       facade (a black open sash, a lit room, a pane of
 *                       grime-varied mirror) and they boil first.
 *                         tower 69-217 m, terrace 111-347 m, walk-up 125-390 m
 *   (d) reveal shading  a soft ramp `revealDepth` wide, so it is pushed nearer
 *                       Nyquist than the grid: two samples a ramp to one.
 *                         terrace 64-153 m, brutalist 101-243 m, tower 9-21 m
 *
 * The emissive path takes band (b) rather than band (c), and that is deliberate
 * -- see the night lit-window fade where it is applied. After dark the lit grid
 * is not one signal among several, it is the *only* signal, and fading it on
 * the life band would blank the skyline at half the distance the daytime facade
 * survives to.
 *
 * WHAT IT ACTUALLY DOES, as the window-to-wall contrast in display code values
 * through `sky/calibration.ts` -- which is the amplitude the moire was made of,
 * since a pattern that aliases can only alias as hard as its own contrast. Both
 * axes measured separately, at 3 pm on 15 February:
 *
 *                                  30 m  200 m  400 m  600 m  800 m  1200 m
 *   CBD tower, shaded    before     179    179    179    179    179     179
 *     1.5 m bays          after     179    126      0      0      0       0
 *     3.6 m floor bands   after     179    179    166     78     14       0
 *   brick walk-up, sun   before      95     95     95     95     95      95
 *     3.6 m bays          after      95    100     85     40     12       0
 *     2.7 m floor bands   after      95    100     80     22      0       0
 *   terrace, shaded      before      37     37     37     37     37      37
 *     2.4 m bays          after      37     28     21      3      0       0
 *
 * The `before` rows are flat because nothing faded: 179 code values of contrast
 * on a sub-pixel grid is the artefact, and it was there at every distance out to
 * the far plane.
 *
 * THE TOWER AND THE WALK-UP FADE IN OPPOSITE ORDERS, which is the whole case for
 * two bands rather than one. A tower's 1.5 m bays go first and its floor banding
 * outlives them by three times the distance -- a blue-green glass slab that
 * keeps its horizontal banding to a kilometre, which is what a real tower looks
 * like at range. A walk-up is the other way round, because its 2.7 m
 * floor-to-floor is *finer* than its 3.6 m bay, so what survives at 800 m is
 * faint vertical bay banding and no floor banding at all. Gating both axes on
 * the smaller period would have taken the tower's floor bands out at 434 m with
 * its bays; gating on the larger would have left the walk-up's floor lines
 * aliasing to a kilometre.
 *
 * The walk-up's 95 -> 100 between 30 and 200 m is the reveal band, not a fault:
 * `revealShade` fades to its own mean over the opening, which is 0.925, so the
 * middle of a window -- which had no reveal shading on it at all -- darkens by
 * 7.5% and the contrast against a sunlit cream wall goes *up* by five code
 * values before the grid takes it down. That is the correct average and it is
 * the price of not letting a window brighten as it recedes.
 *
 * WHERE THEY LAND. The mean each converges on, and the fade state there:
 *
 *   CBD tower, shaded face   2 km   rgb(195, 229, 243)  Y' 223
 *       bayFade 0.000, floorFade 0.000, life 0.000 -- ZERO grid contrast on
 *       both axes. A pale blue-grey slab: the horizon haze band at Fresnel
 *       0.30 through the curtain wall's own blue-green tint, over 82% of the
 *       facade, which is what a glass tower two kilometres off is.
 *   brick walk-up, sunlit   800 m   rgb(206, 196, 175)  Y' 197
 *       bayFade 0.268, floorFade 0.000, life 0.000 -- warm and
 *       brick-dominant, with 12 code values of bay banding left and no floor
 *       banding. At 2 km it settles to rgb(214, 202, 179) Y' 203.
 *   terrace, shaded         2 km    rgb( 92,  45,  34)  Y'  54
 *
 * AND AT 30 m NOTHING CHANGES. Every band is exactly 1.0 there -- not nearly,
 * exactly, because `resolves` is a `smoothstep` that saturates. The two grid
 * bands hold to 145 m at the very earliest (the tower's bays, the finest module
 * in the city) and 577 m at the latest; the life band to 73 m; the joinery to
 * 64 m on painted timber and 37 m on aluminium. Three things are already faded
 * at 30 m and all three are sub-pixel there and area-conserving:
 *
 *   the tower's 30 mm reveal      0.000 from 9 m   -- 0.5 px at 30 m, and worth
 *                                                     1.4% of the opening
 *   a shopfront's 30 mm joinery   0.822 from 24 m  -- 0.58 px at 30 m
 *   the poster rim at 40 mm       0.482 from 14 m  -- and the tag beside it has
 *                                                     widened from 4.7 m since
 *                                                     the weathering pass
 */
const BAND = {
  /** The window grid. `resolves`'s default: six samples a period to two. */
  grid: [0.16, 0.5] as const,
  /** How much earlier the per-window life goes. See (c). */
  lifeAhead: 2.0,
  /** The reveal ramp, pushed nearer Nyquist because it is a gradient. */
  reveal: [0.5, 1.2] as const,
  /**
   * Where the joinery hands over from its widened self to the analytic mean, in
   * units of `softLine`'s `held` factor. 1.0 is a frame still wider than the
   * pixel footprint; the blend runs from 0.45 -- where the widening has just
   * started and the area is still being conserved honestly -- down to 0.12,
   * where the widened band is about to overrun the opening and holding its area
   * would start to under-count.
   */
  joinery: [0.12, 0.45] as const,
} as const;

/* ---------------------------------------------------------------------------
 * WEATHERING. Spec section 7.6, which is unusually blunt about it: decals are
 * "the cheapest large win available", the list is exact -- water staining below
 * sills and aircon units, rust runs from fixings, poster residue on blank
 * walls, tag-level graffiti at reachable height, oil staining on driveways and
 * laneways -- and it says to "budget real effort here, more than on facade
 * geometry".
 *
 * All of it is shader-side, deterministic and distance-faded. The one rule that
 * shapes every effect below: a real city's dirt is *placed* -- it comes from
 * somewhere and runs somewhere -- so every mark here is keyed off a feature the
 * shader already knows about (a sill, an aircon unit, a fixing row, a stretch of
 * blank wall) rather than scattered on a noise field. Noise-scattered grime is
 * the failure mode this avoids: it reads as a dirty *texture* rather than as a
 * dirty *building*, and it looks identical on every facade in the city.
 *
 * WHICH COORDINATE THE STREAKS USE, because it is the one thing that would be
 * invisible in a still and obvious in motion. The window grid exists twice per
 * fragment -- once at the wall plane in `frameNode`, once at reveal depth in
 * `surface` -- and a streak keyed off the second one would slide across the wall
 * as the viewer moves, because that coordinate is parallax-offset. It does not
 * have to be evaluated a third time to get the first: `surface` applies its
 * offset only where `frameNode.z` says the fragment is inside an opening, so on
 * wall -- which is the only place a streak is ever drawn -- `coord` *is* `uv()`,
 * exactly, and `openingLocal`, `bayIdx` and `storeyIdx` are already the
 * wall-plane values. The streaks cost no extra field evaluation and cannot
 * parallax-slide.
 * ------------------------------------------------------------------------- */

/**
 * Per-building weathering age: how hard this building has been left.
 *
 * A single multiplier on every mark below, so one terrace reads freshly painted
 * and the one beside it reads neglected. That variety is the point of the whole
 * pass at street level -- a uniform amount of dirt on every building is just a
 * darker city, and it is the second way (after uniform *placement*) that
 * procedural grime gives itself away.
 *
 * 0.3 to 1.6 is a 5.3x spread, which is wide on purpose. At the bottom it is
 * near enough clean; at the top a cream-brick sill streak lands at 20% and is
 * plainly a stained building. A narrower band would put every building in the
 * same middle and buy nothing over a constant.
 *
 * DERIVED, NOT HASHED, and the file's own rule is what permits it: "derive a
 * roll you are going to *lerp* with, hash a roll you are going to *threshold*"
 * (see `ROLL_STREAM`). The age factor is only ever multiplied -- where a
 * presence *threshold* is age-dependent below, it is the threshold that moves
 * and the roll being thresholded is an independent spatial hash -- so a third
 * quadratic round off the value roll the tint already computes is enough, at
 * four instructions instead of the six a fourth stride pair would cost, and
 * with no new low-discrepancy constants to justify.
 *
 * Measured over all 65,536 seeds with fp32 rounding, against the three rolls it
 * has to stay clear of and the two `finishRoof` uses:
 *
 *   mean 0.4961   r: paint 0.0066  value 0.0095  mortar -0.0058
 *                    idA 0.0004    idB -0.0012
 *
 * and -- the check that actually matters for a terrace row, whose OSM way ids
 * arrive near-consecutive -- a lag-1 autocorrelation over sequential seeds of
 * -0.090, against the existing rolls' own -0.036 (paint), +0.192 (value) and
 * -0.125 (mortar). So a street of terraces does not age in a repeating cycle,
 * and it does so slightly better than two of the three rolls already shipping.
 */
const AGE = { min: 0.3, span: 1.3, respin: 31.7 } as const;

/**
 * The sill streak, and the aircon drip that is the same streak with its
 * parameters lerped.
 *
 * They are one effect because they are one mechanism: water runs off a sill,
 * picks up whatever the wall above shed, and stains the wall below. A window
 * with an air conditioner in it does the same thing from a different origin --
 * the unit's drain corner rather than the sill lip -- and it does it harder,
 * narrower, further, and with the rust off a steel bracket in it. Writing that
 * as a second profile costs a second evaluation of everything; writing it as
 * six `mix`es on the first one costs six instructions and cannot drift out of
 * agreement with the box the streak comes from.
 *
 * `fall` is metres below the source sill, and it is allowed to cross the storey
 * line: the wall between a sill and the head of the window below is only
 * 0.8-1.5 m on every archetype in the table (terrace 1.2, federation 1.5,
 * walk-up 1.3, modern infill 0.9), so a streak confined to its own storey would
 * be capped at the 0.5-1.0 m of wall under the sill and the roll's length
 * variation would have nowhere to go. Crossing costs one `step` and one add,
 * and it is what lets a neglected interwar block streak all the way down onto
 * the head of the window below -- which is exactly what one looks like.
 *
 * Widths are fractions of the *opening*, not of the bay, so a terrace sash and a
 * warehouse steel window streak in proportion to themselves.
 *
 * Predicted display values, 3 pm on 15 February, through the chain in
 * `sky/calibration.ts`, at the 0.87 the joint, soiling and tint modulation takes
 * out at eye level:
 *
 * `peak` below is the darkening BEFORE the age factor, so what a wall actually
 * draws is `peak * age` -- 12-20% on a building of ordinary age, and 3.6% to
 * 32% across the whole 0.3-1.6 range. That spread is item three doing its job
 * rather than a value out of band: a freshly painted building's streak has to
 * be able to disappear.
 *
 *   cream brick, sunlit, clean                rgb(231, 216, 188)  Y' 217
 *     streak centre, age 0.3  (4.8%)          rgb(227, 212, 184)  Y' 213
 *     streak centre, age 1.0  (16%)           rgb(214, 200, 174)  Y' 201
 *     streak centre, age 1.6  (32%)           rgb(193, 181, 158)  Y' 182
 *   cream brick, shaded, clean                rgb(138, 121,  96)  Y' 123
 *     streak centre, age 1.0                  rgb(126, 109,  86)  Y' 111
 *     streak centre, age 1.6                  rgb(112,  96,  75)  Y'  98
 *   red brick, sunlit, clean                  rgb(161,  91,  72)  Y' 105
 *     streak centre, age 1.0                  rgb(147,  81,  63)  Y'  94
 *   aircon drip on cream brick, sunlit  27%   rgb(209, 187, 153)  Y' 189
 *     the same at 45%                         rgb(193, 162, 121)  Y' 166
 *     27% in shade                            rgb(123, 100,  71)  Y' 103
 *
 * Sixteen code values of luminance at ordinary age and thirty-five at the top,
 * which is the size this has to be: the file's own bar elsewhere is that a
 * facade feature has to clear "the dozen code values a viewer stops resolving
 * at distance", and a streak that cleared it by much more at *ordinary* age
 * would stop being water and start being paint. The one place it does not clear
 * it is sunlit painted render, where 244 goes to 239 -- that is the tone curve
 * compressing everything above rho 0.42, the same compression `PAINT_PALETTE`
 * documents, and the same wall in shade moves 157 to 144. A white wall in full
 * sun does not show its dirt in a photograph either.
 *
 * The drip's warmth is worth reading in the shaded row rather than the sunlit
 * one: at 45% it takes cream brick to rgb(112, 84, 46), sixty-six code values
 * of red over blue against the wall's forty-two. That is iron in it.
 *
 * The drip is warm and the streak is not: `tint` removes blue fastest under an
 * aircon (iron oxide off the bracket) and red fastest under a plain sill (grey
 * road dirt on a warm masonry wall reads as a loss of chroma, not a loss of
 * value).
 */
const STAIN = {
  /** Fall over which a plain sill streak dies, metres, lerped on the roll. */
  fall: [0.8, 1.5] as const,
  /** The same for a streak leaving an aircon unit. */
  dripFall: [1.3, 2.2] as const,
  /** Half width as a fraction of the opening's half width. 0.6 of the opening. */
  width: 0.6,
  /**
   * The same thing in metres, for the distance fade only.
   *
   * `resolves` needs a period in the units of the pixel footprint and the width
   * above is a *fraction*, so it cannot be the one that is handed over. 0.55 m
   * is the streak across the archetypes that carry most of them -- a terrace
   * sash gives 0.60, an interwar flat 0.77, a brick veneer 0.90 -- and being a
   * little under the true width errs the right way, since the effect fades
   * slightly earlier than it strictly must rather than slightly later.
   */
  module: 0.55,
  /** Half width of a drip, metres. A drain corner, not a whole sill. */
  dripWidth: 0.11,
  /** How much the streak narrows over its fall. Water spreads, dirt does not. */
  taper: 0.32,
  /** Peak darkening at the streak centre, before the age factor. */
  peak: [0.12, 0.20] as const,
  dripPeak: [0.20, 0.28] as const,
  /** Which channels the darkening takes, per unit of it. See above. */
  tint: [1.0, 0.98, 0.94] as const,
  dripTint: [0.72, 1.0, 1.28] as const,
  /** The clean band right under the sill lip: a sill sheds before it stains. */
  lip: 0.07,
} as const;

/**
 * Rust runs down a corrugated wall, from the fixings that hold the sheet on.
 *
 * The roof path already argues this case (see `FIXING_SPACING`): every screw is
 * a hole punched through the zinc under a rubber washer that perished two
 * decades ago. A wall is the same sheet, the same screws and the same rain, with
 * one difference that matters -- on a wall the water has nowhere to go but
 * straight down, so a wall's rust is a set of narrow vertical runs rather than
 * the roof's blooms.
 *
 * The girt spacing is wider than a roof batten because a wall carries no snow,
 * no foot traffic and no ponding: 1.2 m is the common industrial girt. Sheets
 * are the same 762 mm cover as the roof, and the fixing sits on a rib crest at a
 * hashed position within the sheet, so the runs do not line up into columns.
 *
 * Density is set to the spec's "2-6 per 10 m of wall". Ten metres of a 6 m
 * warehouse wall is 13 sheets by 5 girt rows = 65 fixing cells, so the
 * base rate is 4.6% and the age factor takes it from 1.4% to 7.4% -- one clean
 * shed and one that has not been touched since the eighties.
 *
 * The peak alpha is compressed by age rather than scaled by it -- 0.36 on a
 * tidy shed to 0.61 on a derelict one, against the rate's full 5.3x -- because
 * a rust run is a discrete thing that is either there or not, and 5.3x of its
 * alpha would be a run nobody can see beside one that is a red stripe.
 *
 * Predicted at 3 pm on 15 February on a sunlit galvanised wall:
 *
 *   bare galv wall                            rgb(176, 181, 185)  Y' 180
 *   rust run, alpha 0.36 (age 0.3)            rgb(156, 152, 153)  Y' 153
 *   rust run, alpha 0.48 (age 1.0)            rgb(149, 141, 140)  Y' 143
 *   rust run, alpha 0.61 (age 1.6)            rgb(140, 127, 124)  Y' 130
 *   the 0.48 run in shade                     rgb( 79,  67,  61)  Y'  69
 *
 * Read the hue rather than the value: in sun the run is only 9-16 code values
 * of red over blue, because the tone curve compresses two bright surfaces
 * together and galvanised zinc is *cool* where the oxide is warm, so most of
 * the separation lands in luminance instead -- 37 code values of it at ordinary
 * age. In shade, where the spread reopens, it is 18 over blue and reads plainly
 * as rust. Mixing towards `RUST` -- the same iron-oxide albedo the roof path
 * uses, because it is the same oxide -- is what keeps the two consistent on a
 * warehouse that has both.
 */
const WALL_RUST = {
  girt: 1.2,
  rate: 0.046,
  /** Half width at the fixing and at the bottom of the run, metres. */
  width: [0.024, 0.055] as const,
  /** Fall over which a run dies, metres. */
  fall: [0.7, 2.4] as const,
  peak: 0.55,
} as const;

/**
 * Poster residue and tags, on the blank ground-storey wall that carries both.
 *
 * WHERE, and it is nearly all of the design. Both live below 3 m -- reachable
 * height, which is what makes them read as done by a person rather than
 * generated -- and both need a stretch of *blank* wall, because a poster goes
 * where there is room for one and a tag goes where nobody can see you doing it.
 * The window field gives that for nothing: it is a signed distance in metres, so
 * "at least 0.8 m from any opening" is a comparison on a number the shader has
 * already computed, and the marks route themselves around the windows without
 * anything having to know where the windows are.
 *
 * The archetype gate is `lightFramed` plus the warehouses, and the set is not
 * arbitrary even though the test is borrowed: the joinery test names the pre-war
 * and suburban stock (terrace, federation, interwar, brick veneer, retail
 * strip), and adding warehouse to it gives exactly the buildings that present a
 * reachable masonry or steel wall at street level. What it excludes -- walk-up,
 * brutalist, tower, modern infill -- present a lobby, a plant room, a podium or
 * curtain wall at that height, and none of them takes a poster.
 *
 * SUBTLE, and this is where a pass like this goes wrong. These are grime, not
 * decoration: alpha runs 0.10-0.25 and the tag is never legible as text. The
 * failure mode is a city where every blank wall has a readable mark on it, which
 * reads as set dressing within about ten seconds of looking at it.
 *
 * WHAT A TORN POSTER ACTUALLY LEAVES was measured before it was drawn, and it
 * changed the design. A pale patch alone only reads on dark walls -- at alpha
 * 0.20 a paper-grey residue moves red brick from Y' 105 to Y' 135, but cream
 * brick 217 to 216 and painted render 244 to 242, because the tone curve has
 * compressed everything bright together. What survives on every wall is the
 * *rim*: the grimy adhesive line around the edge, which is dark, and a dark line
 * reads against anything. So the patch is a weak fill inside a strong rim, which
 * is also what one looks like from across a street.
 *
 * Predicted at 3 pm on 15 February, at the mid alphas (poster 0.18, ink 0.16):
 *
 *   red brick, sunlit                         rgb(161,  91,  72)  Y' 105
 *     poster fill                             rgb(171, 123, 111)  Y' 132
 *     poster rim                              rgb(153,  94,  80)  Y' 106
 *     tag stroke                              rgb(151,  87,  72)  Y' 100
 *   cream brick, sunlit                       rgb(231, 216, 188)  Y' 217
 *     poster fill (near-invisible, as above)  rgb(227, 215, 191)  Y' 216
 *     poster rim                              rgb(216, 203, 177)  Y' 204
 *     tag stroke                              rgb(216, 202, 176)  Y' 203
 *   galvanised wall, sunlit                   rgb(176, 181, 185)  Y' 180
 *     poster rim                              rgb(166, 171, 174)  Y' 170
 *     tag stroke                              rgb(164, 169, 173)  Y' 168
 *   painted render, sunlit                    rgb(244, 244, 239)  Y' 244
 *     tag stroke                              rgb(240, 240, 235)  Y' 240
 *   painted render, shaded                    rgb(164, 156, 145)  Y' 157
 *     tag stroke                              rgb(152, 144, 134)  Y' 145
 *   galvanised wall, shaded                   rgb( 99,  96,  94)  Y'  96
 *     tag stroke                              rgb( 91,  88,  85)  Y'  88
 *
 * Four to twenty-seven code values, and the pattern in the table is the design:
 * the *fill* only carries on red brick (105 to 132), the *rim* carries on every
 * masonry and steel wall (10-14 code values), and both give up on sunlit white
 * render exactly as a photograph does. That is why the rim exists at all.
 * Present at conversational distance, gone by the end of the block.
 */
const MARKS = {
  /** Cell along the wall run, metres. One decision per cell. */
  cell: 2.6,
  /** Share of cells taking a poster, and the band above it taking a tag. */
  poster: 0.30,
  tag: 0.17,
  /** Reachable height, and how hard the top edge of the zone is. */
  top: [2.4, 3.05] as const,
  /**
   * How far from an opening a wall counts as blank, in metres of the window
   * field. Full marks at 0.72 m clear, nothing inside 0.48.
   *
   * SET FROM THE ARCHETYPE TABLE, not from a round number, and the difference
   * matters because the obvious 0.8 m excludes more than it looks like it
   * does. The most blank wall a bay can have is `bayWidth/2 - halfOpening`
   * measured at the pier between two bays:
   *
   *   warehouse   2.10 m   (and its whole wall below 2.7 m, since the sill is
   *                         at 3.4 -- the window field is negative on height
   *                         alone down there, across every bay)
   *   interwar     0.96 m
   *   brick veneer 0.95 m
   *   federation   0.93 m
   *   terrace      0.70 m
   *   retail       0.12 m   (ground storey is 92% glazing by construction)
   *
   * So this lands the effect where it belongs -- overwhelmingly on the
   * warehouses, then the piers of the pre-war and suburban stock -- and leaves
   * two archetypes out on their own geometry rather than by a rule. A retail
   * shopfront cannot be fly-posted because it is a window, and a terrace's
   * street elevation is window, door, window with nothing between them; both
   * of those get marked on their *side* walls in life, and a side wall is not
   * something this shader has any way to know it is looking at.
   */
  blank: [-0.72, -0.48] as const,
  /** Half width of the box, metres, lerped on the cell roll. 0.4-0.7 m wide. */
  posterW: [0.20, 0.35] as const,
  /** Height:width of the box, both marks. Root two, because a poster is A-series. */
  aspect: 1.41,
  /** Where the box sits, metres above the ground. */
  centre: [0.72, 1.77] as const,
  /** Paper residue and the adhesive rim, linear albedos. */
  paper: [0.34, 0.33, 0.30] as const,
  rim: [0.10, 0.095, 0.09] as const,
  posterAlpha: 0.21,
  /** Tag ink, its alpha, the stroke half width, and how tight the scrawl is. */
  ink: [0.045, 0.043, 0.048] as const,
  inkAlpha: 0.19,
  stroke: 0.013,
  wanderK: 7.5,
  /**
   * How the building's age factor reaches the marks, as `floor + age * scale`.
   *
   * A shallower curve than everything else in this pass takes, and both ends are
   * the reason. `AGE` spans 0.3-1.6 because that is the right spread for *dirt*,
   * which is a continuum; a mark is a discrete event and 5.3x of it is not a
   * neglected wall, it is a wall with nothing on it beside a wall covered in
   * posters. 0.45 + 0.42*age lands the compressed range at 0.58-1.12, which
   * holds every alpha inside the 0.09-0.25 band this belongs in and keeps the
   * poster rate between one per 15 m and one per 7.6 m of blank wall.
   *
   * Through it the two alphas land at 0.122-0.235 (poster) and 0.110-0.213
   * (ink), both inside the 0.10-0.25 this belongs in at every age.
   */
  ageFloor: 0.45,
  ageScale: 0.42,
} as const;

/**
 * Shared uniforms every facade material in the scene reads.
 *
 * The type is inferred from the factory rather than written out, because
 * `uniform` is a heavily overloaded call and naming its return type by hand
 * collapses the overloads to `unknown`.
 */
export function createFacadeGlobals() {
  return {
    /** 0 = full day, 1 = full night. Drives window interior lighting. */
    nightFactor: uniform(0),
    sunDirection: uniform(new Vector3(0, 1, 0)),
  };
}

export type FacadeGlobals = ReturnType<typeof createFacadeGlobals>;

/**
 * A cheap, stable hash. Used for every per-window random decision, so that a
 * window's lit/unlit state and blind position are fixed for a given building and
 * window -- the spec requires determinism, and a hash of the window's integer
 * grid cell gives it without any storage.
 */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h).mul(43758.5453123));
});

const hash31 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = dot(p, vec3(127.1, 311.7, 74.7));
  return fract(sin(h).mul(43758.5453123));
});

/**
 * The per-window hash streams, as offsets added to the window's cell before it
 * is hashed. One entry per independent decision a window makes.
 *
 * They are here rather than inline because `frameNode` needs one of them
 * (`open`, for where the meeting rail sits) and it runs before the block that
 * defines the rest, and because a list of streams is the only place the
 * separation between them can be argued about in one go.
 *
 * WHAT AN OFFSET ACTUALLY DOES, since it is not obvious from the numbers. The
 * cell is `(bayIdx, storeyIdx, seed)` and `hash31` dots it with
 * (127.1, 311.7, 74.7), so an offset is a constant shift in the argument of a
 * single `sin()` -- 3866 for `blind`, 6930 for `hue`, 4594 for `dress`, 9011
 * for `fit`, 10685 for `open`. What has to be true is that those shifts are
 * large against the fp32 quantisation of the argument (a seed of 65,535 puts it
 * at 4.9e6, where the ulp is 0.5) and not near a common multiple of each other.
 *
 * MEASURED, not assumed, over 288,000 windows -- 4,000 seeds x 12 bays x 6
 * storeys, with the dot and the multiply rounded to fp32 the way the GPU does
 * them. Every roll is uniform to within 0.006 of mean 0.5, no pair correlates
 * above |r| 0.004, and -- the number that actually matters, because a *rate* is
 * what shows -- every pair of thresholded decisions co-occurs within 1.3% of
 * independence:
 *
 *   P(lit & aircon)      0.0407 against 0.0410 independent   lift 0.99
 *   P(lit & openSash)    0.0277 against 0.0275               lift 1.01
 *   P(aircon & openSash) 0.0096 against 0.0097               lift 0.99
 *   P(blind & aircon)    0.0540 against 0.0541               lift 1.00
 *
 * and no gradient across bay index or storey index in any of them.
 *
 * THE FIRST ATTEMPT AT THIS FAILED AND IS WORTH RECORDING. `open` was derived
 * from `fit` by the same quadratic second round `buildingRoll` uses, on the
 * argument that a value which only has to be *uncorrelated* need not be
 * independently hashed -- which is true, and is what `curtain` and `grime`
 * below still do. It is not true of a value that then gets thresholded at 8%.
 * The quadratic map is smooth, so the low tail of the derived roll is not a
 * random subset of the parent's: measured, P(aircon & openSash) came out at
 * lift 0.82 and the derived share landed at 6.5% instead of 8%. Aircon units
 * and open windows avoiding each other is precisely the kind of soft rhythm
 * this pass exists to remove, so `open` got its own stream. The rule that falls
 * out: derive a roll you are going to *lerp* with, hash a roll you are going to
 * *threshold*.
 */
const ROLL_STREAM = {
  lit: [0, 0, 0],
  blind: [11.3, 7.1, 2.9],
  hue: [3.1, 19.7, 5.3],
  dress: [17.9, 4.3, 13.1],
  fit: [6.7, 23.9, 9.5],
  open: [2.3, 29.1, 17.7],
  stain: [13.7, 15.3, 21.1],
} as const;

/**
 * `stain` is the weathering pass's addition and it is measured the same way.
 *
 * Its argument shift is 8086.45, which sits between `hue` at 6930 and `fit` at
 * 9011 with 1156 and 925 of clearance -- the same order of separation the five
 * existing streams have from each other. Over the same 288,000 windows, with
 * every operation rounded to fp32:
 *
 *   mean 0.4984, and |r| against every existing stream at or under 0.0044
 *   (lit -0.0044, blind -0.0027, hue -0.0034, dress -0.0003, fit 0.0014,
 *   open 0.0008), no gradient across bay (-0.0012) or storey (0.0028).
 *
 * The pair that had to be checked *specifically* is `stain` against `fit`,
 * because they land on the same windows by construction: an aircon unit's drip
 * is this same streak with its parameters lerped, so the streak's length and
 * intensity are read on exactly the 12% of windows `fit` selects. `stain` is a
 * lerped roll rather than a thresholded one, so the number to check is its
 * conditional mean rather than a co-occurrence rate:
 *
 *   E[stain | fit < 0.12]  0.4986 over 34,979 windows, against 0.5 independent
 *   E[stain | open < 0.08] 0.4984
 *
 * -- so the streaks under the aircon units are drawn from the same distribution
 * of lengths as the streaks everywhere else. Had they not been, every unit in
 * the city would weep the same distance, which is the soft rhythm the whole
 * `ROLL_STREAM` discipline exists to remove.
 *
 * `respin(stain, 31.7)` is the second quantity the streak needs (its lateral
 * jitter and its peak), and it is spun rather than hashed for the reason stated
 * above: both uses are lerps. Measured, it comes out at mean 0.5017 with
 * r 0.0019 against `fit` and -0.0082 against its own parent.
 */

/**
 * Three uncorrelated 0-1 identities for one building, off its seed.
 *
 * Which paint it was given, how light or dark that batch fired, what its mortar
 * was mixed from. Every one of them has to be stable for a given building and
 * independent of the other two, and getting either wrong is visible from the
 * footpath -- so the strides are the R3 low-discrepancy triple, used in a
 * rotation so no two rolls share a pair.
 *
 * `lo` and `hi` are the seed's two bytes, split by the caller. That split is not
 * tidiness, it is precision. The seed is an integer under 65,536, so the obvious
 * `fract(seed * irrational)` -- which is what `finishRoof` does, and which is
 * fine for a five-way family select -- reaches ~54,000, where fp32 has an ulp of
 * 0.004: `fract` keeps barely two decimal digits and 65,536 seeds collapse onto
 * 5,073 distinct values. Both bytes are exact in fp32 and every product here
 * stays under 500, which recovers 34,000 of them.
 *
 * THE SECOND ROUND IS NOT DECORATION. A bare `fract(n * stride)` is a
 * low-discrepancy *walk*: consecutive seeds step by a constant, so a terrace row
 * -- whose OSM way ids were created in one import and are near enough
 * consecutive -- comes out painted in a repeating cycle down the street, which is
 * the exact artefact this whole pass exists to remove. Squaring is the cheapest
 * thing that destroys the regularity while staying analysable, and it costs no
 * transcendental. Measured over all 65,536 seeds: palette shares within 0.2
 * points of target, and |r| < 0.01 between the three rolls and against the two
 * `finishRoof` already uses -- which matters, because a terrace has both a
 * painted wall and a steel roof and they must not choose together.
 */
const BUILDING_STRIDES = {
  paint: [0.8191725134, 0.6710436067],
  value: [0.6710436067, 0.5497004779],
  mortar: [0.5497004779, 0.8191725134],
  /**
   * What colour the front door was painted, and the fourth *ordered* pair the
   * same R3 triple admits.
   *
   * The three above are a rotation -- (a,b), (b,c), (c,a) -- and a rotation of
   * three elements has only three members, so a fourth roll cannot be another
   * one. It does not need to be: the two components multiply different
   * quantities (the seed's low byte and its high byte), so (a,c) is a distinct
   * pair from (c,a) and no new irrational has to be justified.
   *
   * MEASURED over all 65,536 seeds with every operation rounded to fp32 the way
   * the GPU does them, against the three rolls it has to stay clear of and the
   * two `finishRoof` uses:
   *
   *   mean 0.4972   r: paint 0.0047  value 0.0041  mortar 0.0020
   *                    idA 0.0032    idB -0.0004
   *
   * 35,391 distinct values out of 65,536, and the palette shares land within
   * 0.3 points of target on every one of the six tones. The check that actually
   * matters for a terrace row -- whose OSM way ids arrive near-consecutive, so a
   * low-discrepancy walk would paint the street in a repeating cycle -- is the
   * lag-1 autocorrelation over sequential seeds: -0.034, against the existing
   * rolls' -0.036 (paint), +0.192 (value) and -0.125 (mortar). A row of doors
   * does not cycle, and it cycles less than two of the three rolls shipping.
   */
  door: [0.8191725134, 0.5497004779],
} as const;

function buildingRoll(lo: any, hi: any, stride: readonly [number, number]) {
  const h = fract(lo.mul(float(stride[0])).add(hi.mul(float(stride[1]))));
  return fract(h.mul(h.add(float(41.7))));
}

/**
 * A second roll off one that has already been hashed. `buildingRoll`'s second
 * round, on its own, for the window path.
 *
 * Four instructions against nine for another `hash31`, and the trade is stated
 * plainly on `ROLL_STREAM`: this is uncorrelated enough to *lerp* with and not
 * to *threshold* with. Both uses below are lerps, and both are additionally
 * paired with a roll they can never be seen alongside -- the curtain draw only
 * matters on a window the dress roll gave curtains rather than a blind, and the
 * grime only matters on the glass an aircon is not covering.
 */
function respin(roll: any, k: number) {
  return fract(roll.mul(roll.add(float(k))));
}

/**
 * Which of `PAINT_PALETTE` this building is, as a chain of `step`s on one roll.
 *
 * Same shape as `STEEL_FAMILIES` in the roof path and for the same reasons:
 * there is no texture on this path and there should not be one, and nine mixes
 * against compile-time constant edges is cheaper than any way of avoiding them.
 * The thresholds are the running total of the shares, derived here rather than
 * written out, so editing a weight cannot leave a stale cumulative behind it.
 */
function paintColour(roll: any) {
  return palette(PAINT_PALETTE, roll);
}

/**
 * A weighted palette pick as a chain of `step`s on one roll.
 *
 * Factored out when the doors arrived with a second palette of their own: the
 * construction is identical, the thresholds are the running total of the shares
 * derived here rather than written out (so editing a weight cannot leave a stale
 * cumulative behind it), and the argument for the shape is the same one
 * `STEEL_FAMILIES` makes in the roof path -- there is no texture on this path
 * and there should not be one, and N mixes against compile-time constant edges
 * is cheaper than any way of avoiding them.
 */
function palette(
  tones: readonly { colour: [number, number, number]; share: number }[],
  roll: any,
) {
  const total = tones.reduce((s, p) => s + p.share, 0);
  const picked = vec3(...tones[0].colour).toVar();
  let acc = tones[0].share;
  for (const tone of tones.slice(1)) {
    picked.assign(mix(picked, vec3(...tone.colour), step(float(acc / total), roll)));
    acc += tone.share;
  }
  return picked;
}


/**
 * Create the facade material for one material slot.
 *
 * Called **once per slot for the whole game**, not once per tile: the parameter
 * atlas means every tile reads the same texture, so the eleven materials here are
 * the only facade pipelines that ever get compiled.
 *
 * The other performance-critical decision is inside: the parallax-corrected
 * facade coordinate and its window field are computed by one shared node that
 * all four material outputs reference. Computing it per output -- the obvious
 * way, since colour, roughness, metalness and emissive are separate node slots
 * -- quadruples the cost of the most expensive thing in the frame.
 *
 * `side` IS NEVER SET HERE, and that is now a decision rather than an omission.
 * Three's default is `FrontSide`, which the WebGPU backend compiles to
 * `cullMode: 'back'` (`WebGPUPipelineUtils._getPrimitiveState`), so every wall
 * in the city is back-face culled and always has been. For most of this
 * project's life that culling was removing the wrong half: `mesh.build_walls`
 * emitted a winding and a normal that were exact negatives, so on 61% of
 * buildings every wall faced inward, the near walls were culled and what you
 * were looking at through them was the inside of the back ones. It did not read
 * as a hole -- a closed prism turned inside out still covers its own silhouette
 * -- which is why it survived. It is fixed in the pipeline, where it belongs,
 * and the check that keeps it fixed is `sydney winding-audit`. Nothing here
 * needs to compensate, and a `DoubleSide` put here to make a symptom go away
 * would cost the whole city's back faces and hide the cause.
 */
export function createFacadeMaterial(
  slot: FacadeMaterialName,
  paramsTexture: DataTexture,
  globals: FacadeGlobals,
): MeshStandardNodeMaterial {
  const look = MATERIAL_LOOK[slot];
  const material = new MeshStandardNodeMaterial();
  material.name = slot;

  // --- Per-building parameter fetch -----------------------------------------
  // `_BLDIDX` already carries the tile's atlas offset, folded in on load, so this
  // is a direct global building index with no per-tile uniform.
  //
  // The type argument is explicit: without it TypeScript widens 'float' to
  // `string` and the node loses its arithmetic surface. The +0.5 makes the
  // float-to-int truncation land on the intended index rather than one below it.
  //
  // Buildings are packed linearly into a wide texture rather than one per row,
  // because a 4-wide texture would need 65,536 rows and blow past WebGPU's
  // 8192 `maxTextureDimension2D`. See `params-atlas.ts`.
  const bldIndex = attribute<'float'>('_BLDIDX', 'float');
  const texel0 = int(bldIndex.add(0.5)).mul(int(TEXELS_PER_BUILDING));
  const fetchParam = (k: number) => {
    const linear = texel0.add(int(k));
    // ROW_TEXELS is a power of two, so this is a mask and a shift. It is also a
    // multiple of TEXELS_PER_BUILDING, so a building never straddles two rows.
    return textureLoad(
      paramsTexture,
      ivec2(linear.bitAnd(int(ROW_TEXELS - 1)), linear.shiftRight(int(ROW_SHIFT))),
    );
  };
  const p0 = fetchParam(0);
  const p1 = fetchParam(1);
  const p2 = fetchParam(2);
  const p3 = fetchParam(3);

  // Roofs branch here rather than before the fetch, because they want the same
  // record. `mesh.build_roof` writes every roof surface into `slots[roof_material]`
  // with the building's own `bidx`, so a roof primitive carries `_BLDIDX` exactly
  // as a wall does and `seed` is a real per-building identity up here. That is
  // what lets one house be aged galv and the one next door faded Colorbond
  // without a byte of extra geometry -- see `finishRoof`.
  if (slot.startsWith('roof_')) return finishRoof(material, slot, look, p2.x);

  const groundHeight = p0.x;
  const floorHeight = max(p0.y, float(2.0));
  const storeys = p0.z;
  const bayWidth = max(p0.w, float(0.8));

  const windowRatio = p1.x;
  const sillHeight = p1.y;
  const headHeight = p1.z;
  const revealDepth = p1.w;

  const seed = p2.x;
  const isRetail = p2.y;
  const archetype = p2.w;
  const reflectivity = p3.z;
  // p3.w is the roof rectangle's half-width -- `mesh.build_roof`'s return value,
  // in metres, eave overhang included -- and is deliberately not unpacked here.
  //
  // It is the number the roof path below says it cannot locate the ridge
  // without: on a hip or a gable the pitched slopes carry v as metres up the
  // fall line from the eave, so the ridge sits at exactly this value and nothing
  // else in this shader can find it. It is 0.0 on flat and parapet forms, which
  // have no ridge at all, and a reader must treat 0.0 as "no ridge" rather than
  // as a ridge lying on the eave.
  //
  // The pipeline lands it; nothing consumes it yet. What it unblocks is a
  // shaded ridge line, barge boards and hip lines drawn in the material rather
  // than in geometry -- see the long comment above `finishRoof`. The roofline
  // pass that filled this slot took the geometric route for all three, so the
  // shader version is now an *alternative* to real triangles rather than the
  // only way to have them, and it should only be built if it can retire some.

  /* --- The front door. Spec 6.3's "Openings"; see the `DOOR` table -----------
   *
   * `doorU` is the door's centre as metres along the perimeter, in exactly the
   * `u` the wall UVs carry -- `mesh._wall_runs` is the one walk both come out of,
   * which is what makes this a comparison against `uv().x` and nothing more.
   * Negative is the pipeline's "no door on this building" (`mesh.DOOR_NONE`),
   * and it has to be a negative sentinel rather than zero, because zero is a
   * perfectly good door position: the first vertex of the ring.
   *
   * Everything here is hoisted to factory scope rather than computed inside the
   * two door nodes, for the reason `airconArchetype` and `valueRoll` already
   * are: referencing one node object is what keeps a shared sub-expression at
   * one evaluation, and the door's geometry is read by the leaf, the fanlight
   * and the window suppression alike.
   */
  const doorU = p2.z;
  const hasDoor = step(float(0.0), doorU);
  /** Half the opening, architrave to architrave. A shop's entrance is wider. */
  const doorHalf = mix(float(DOOR.width), float(DOOR.widthRetail), isRetail).mul(0.5);
  /** Where the leaf's own head sits: the opening's head less the architrave. */
  const doorLeafTop = mix(float(DOOR.head), float(DOOR.headRetail), isRetail).sub(
    float(DOOR.architrave),
  );
  const doorLeafHalf = doorHalf.sub(float(DOOR.architrave));
  /**
   * The fanlight, on the pre-war stock that has one: terrace (0) and federation
   * (1). Never on a shopfront -- a shop's entrance is a glazed door in a glass
   * wall and a fanlight over it would be a fanlight over a window.
   *
   * `transomMinStorey` is the clearance test the `DOOR` table sets out: the
   * assembly is 2.60 m tall with a fanlight and the roofline trim carries a v of
   * `height + 0.05` in this same material.
   */
  const doorTransom = step(archetype, float(1.5))
    .mul(isRetail.oneMinus())
    .mul(step(float(DOOR.transomMinStorey), groundHeight));
  const doorFanBottom = doorLeafTop.add(float(DOOR.transomBar));
  const doorFanTop = doorFanBottom.add(float(DOOR.transomHeight));
  /** The top of the whole opening: the leaf's head, or the fanlight's. */
  const doorTop = mix(
    doorLeafTop,
    doorFanTop,
    doorTransom,
  ).add(float(DOOR.architrave));
  /** Signed metres from the door's centre line. The door does not parallax. */
  const doorAcross = abs(uv().x.sub(doorU));

  /**
   * How much wall the door takes out of the window grammar, as a half-span in
   * metres either side of `doorU`.
   *
   * Two rules, and they are two rules because a punched window and a shopfront
   * are two different things to put a door into.
   *
   * On a punched-window archetype the door replaces the window in its bay
   * outright -- a house does not have a door and a window in the same bay at
   * street level. The pipeline snaps the door to a bay *centre* and the window
   * is centred in the same bay, so a span of the window's own half width removes
   * exactly the window and nothing more. Anything narrower would leave two
   * slivers of glazing either side of the architrave, which is the artefact this
   * number exists to prevent.
   *
   * On a shopfront the door is set INTO the glazing, because that is what a
   * shopfront is: plate glass floor to head with a door in it. So the span is
   * the door's own, plus a jamb's worth of margin, and the glass runs up to the
   * architrave on both sides.
   */
  const doorCutHalf = mix(
    max(bayWidth.mul(windowRatio).mul(0.5), doorHalf.add(float(DOOR.cutMargin))),
    doorHalf.add(float(DOOR.cutMargin)),
    isRetail,
  );

  /**
   * 1 where the door stands, at whichever coordinate is handed in.
   *
   * Written as a plain function rather than an `Fn` so it inlines: it is three
   * comparisons, and the alternative -- carrying the answer out of `windowField`
   * -- would need a fifth component on a vec4 that is already full. It is
   * evaluated three times per fragment (twice inside `windowField`, which itself
   * runs at the wall plane and at reveal depth, and once on the opening mask),
   * for about eighteen instructions in total.
   *
   * The ground-storey test is `co.y <= groundHeight`, which is `storeyCoord`'s
   * own `isGround` without the storey division: a door is on storey 0 by
   * definition and there is no cheaper way to say so. It stays true below v = 0,
   * on the buried skirt, where there is no window to suppress anyway.
   */
  const doorCut = (co: any) =>
    hasDoor.mul(step(co.y, groundHeight)).mul(step(abs(co.x.sub(doorU)), doorCutHalf));

  /**
   * What the window frames are made of, from the archetype index.
   *
   * Two families, because two is what a Sydney street actually has. Painted
   * timber sashes and white powder-coated aluminium sit on the old and the
   * suburban stock -- terrace (0), federation (1), interwar (2), brick veneer (7)
   * and the shop-top storeys of a retail strip (8); dark anodised and bronze
   * aluminium is everything post-war and commercial -- walk-up (3), brutalist
   * (4), tower (5), warehouse (6) and modern infill (9). The two sets are not
   * contiguous, hence the second pair of steps rather than one comparison.
   *
   * `sashFramed` is narrower: a horizontal meeting rail across the middle of the
   * opening means a double-hung sash, which is the pre-war stock only. A walk-up
   * slider or a tower's curtain wall has no such member and drawing one there is
   * the fastest way to make a 1970s block read as Victorian.
   */
  const lightFramed = max(
    step(archetype, float(2.5)),
    step(float(6.5), archetype).mul(step(archetype, float(8.5))),
  );
  const sashFramed = step(archetype, float(2.5));

  /**
   * Which storey a height falls on, and how far up that storey it is.
   *
   * Not a single modulo: the ground storey is taller than the uppers in every
   * commercial archetype, so it is handled separately and the uppers tile above it.
   * Returns vec3(storey index, fraction up the storey, storey height).
   */
  const storeyCoord = Fn(([v]: [any]) => {
    const aboveGround = v.sub(groundHeight);
    const isGround = step(v, groundHeight);
    const upperIndex = floor(aboveGround.div(floorHeight)).add(1.0);
    const upperFrac = fract(aboveGround.div(floorHeight));
    return vec3(
      mix(upperIndex, float(0.0), isGround),
      mix(upperFrac, v.div(max(groundHeight, float(0.1))), isGround),
      mix(floorHeight, groundHeight, isGround),
    );
  });

  /**
   * Signed distance into the window opening, in metres, plus what the frame
   * needs to divide that opening up.
   *
   * Positive inside the glazing, negative on the wall. Returns
   * `vec4(distance, packed cell, height above the opening's mid-line, half the
   * opening height)`.
   *
   * The cell is packed here rather than at the call site because the last two
   * components have to be somewhere and a vec4 is all there is. Both callers want
   * a different subset -- the frame pass wants the geometry, the glass pass wants
   * the cell to hash from -- and packing is what lets one evaluation serve both.
   * Everything is in metres, so a frame band is a plain comparison against a
   * physical width.
   */
  const windowField = Fn(([co]: [any]) => {
    const sc = storeyCoord(co.y);
    const storeyIdx = sc.x;
    const storeyH = sc.z;
    const yInStorey = sc.y.mul(storeyH);

    // Bay division: whole bays, never stretched -- the spec requires terminating
    // with a partial bay at corners instead.
    const bayIdx = floor(co.x.div(bayWidth));
    const xInBay = fract(co.x.div(bayWidth)).mul(bayWidth);

    // Retail ground-floor override. This one rule does an enormous amount of
    // work: it is what makes King Street and Redfern Street read correctly.
    const onGround = step(storeyIdx, float(0.5));
    const shopfront = onGround.mul(isRetail);

    const halfW = mix(bayWidth.mul(windowRatio), bayWidth.mul(0.92), shopfront).mul(0.5);
    const centreX = bayWidth.mul(0.5);
    const dx = halfW.sub(abs(xInBay.sub(centreX)));

    const sill = mix(sillHeight, float(0.35), shopfront);
    const head = mix(headHeight, storeyH.sub(0.75), shopfront);
    const dy = min(yInStorey.sub(sill), head.sub(yInStorey));

    // Above the top storey there is no window; otherwise a partial top floor
    // grows a row of half windows into the parapet.
    //
    // Forced to a metre *outside* the opening rather than multiplied to zero, and
    // the difference is not cosmetic. `min(dx, dy) * 0` is zero -- or negative
    // zero, which `step(0, d)` reads as inside -- so with a multiply the whole
    // parapet band came back as "exactly on the opening boundary" and rendered as
    // a sheet of glazing at reveal depth zero. It read as a dark shadow line
    // under the roof and went unnoticed; the moment a frame band keys off small
    // positive distances it becomes a painted stripe around every parapet in the
    // city instead.
    const withinBuilding = step(storeyIdx, storeys.sub(0.5));

    // ...and where the front door stands there is no window either, which is the
    // one thing the door could not be drawn without. A door is a hole in the
    // wall on storey 0 and so is the window the grammar would put in the same
    // bay; without this they are drawn on top of each other and the result is a
    // pane of glass with a door painted on it.
    //
    // It goes HERE, in the field, rather than only on the opening mask below,
    // because the field is what three other things read: the joinery (so no
    // architrave grows an architrave), the parallax gate in `surface` (so the
    // door's own coordinate stays at the wall plane, which is what makes it a
    // wall-plane feature at all), and the blank-wall test the marks use.
    const present = withinBuilding.mul(doorCut(co).oneMinus());

    // Both halves of a double-hung sash meet at the middle of the opening and
    // both jambs run its full height, so the frame pass needs where the middle is
    // and how far the edges are from it. Signed, in metres, from the mid-line.
    const halfHeight = head.sub(sill).mul(0.5);

    return vec4(
      mix(float(-1.0), min(dx, dy), present),
      // Bay and storey either side of a large multiplier, with the shopfront flag
      // in the fraction so it survives as `fract()` -- both are small non-negative
      // integers and this keeps the whole record inside one float.
      bayIdx.mul(4096.0).add(storeyIdx).add(shopfront.mul(0.5)),
      yInStorey.sub(sill).sub(halfHeight),
      // Floored because a degenerate parameter record could invert the opening,
      // and the frame's vertical shading divides by this.
      max(halfHeight, float(0.05)),
    );
  });

  /**
   * Metres of wall per pixel. Every distance fade in this material reads it,
   * and it is the only `fwidth` pair the wall path takes.
   *
   * The larger of the two axes, for the reason `flatRoofNode` gives: a facade
   * seen from anywhere but square-on is foreshortened on one of them, and the
   * axis with the bigger footprint is the one that decides when a pattern starts
   * to crawl.
   *
   * MEASURED ON `uv()`, WHICH IS THE WALL PLANE, and that is a change from the
   * weathering pass, which took it on the parallax-corrected `coord`. Two
   * reasons, and the first is why this moved up here at all: the joinery in
   * `frameNode` below stands at the wall plane and runs *before* the parallax
   * exists, so a footprint taken on `coord` is not available to it and a second
   * pair of derivatives to serve it would double the cost of the cheapest thing
   * in the shader. The second is that `coord` is the better coordinate only
   * where the two agree. `surface` applies its offset exactly where the fragment
   * is inside an opening, so a 2x2 derivative quad straddling an opening edge
   * sees the whole parallax offset as a *jump* -- a spike in `fwidth` at every
   * window edge on every building, which reads as a ring of prematurely faded
   * weathering round every opening. On wall, where every weathering mark is
   * actually drawn, `coord` IS `uv()` exactly (the note at the head of the
   * weathering section makes the same argument from the other end), so this is
   * the same number everywhere it was already being used and a better-behaved
   * one at the edges.
   */
  const pxWall = max(fwidth(uv().x), fwidth(uv().y));

  /**
   * The joinery: frame, sill, meeting rail and mullion, all at the wall plane.
   *
   * Every one of these is a comparison against the window field in metres, which
   * is the whole reason the field is signed and physical rather than a 0-1 mask.
   * A frame is `0 < distance < width`. A sill is the same band, wider, at the
   * bottom of the opening. A meeting rail is a band about the opening's mid-line.
   * A mullion is a band about the bay's centre. Four `step`s on numbers that are
   * already computed, and between them they turn a hole into a window.
   *
   * **This is evaluated at the un-offset coordinate, and that is the point.** The
   * frame sits at the wall plane and the glass sits at the back of the reveal, so
   * the frame must not move with the parallax -- if it does, it slides across the
   * opening with the viewer and reads as a decal printed on the glass rather than
   * as joinery standing in front of it. Composited last, over both the glass and
   * the reveal jamb, because it is nearer the eye than either.
   *
   * Returns vec4(mask, vertical shading, inside-the-opening flag, painted flag).
   * The third component is what `surface` below uses to gate its parallax, so the
   * window field is evaluated exactly twice per fragment -- once here at the wall
   * plane, once there at reveal depth -- which is what it cost before any of this
   * existed.
   */
  const frameNode = Fn(() => {
    const co = uv();
    const field = windowField(co);
    const dist = field.x;
    const aboveMid = field.z;
    const halfHeight = field.w;
    // The shopfront flag rides in the fraction of the packed cell.
    const shopfront = step(float(0.25), fract(field.y));
    const inOpening = step(float(0.0), dist);
    // A shopfront's frames are black or dark bronze aluminium on every retail
    // street in Sydney, including the ones whose upper storeys are white timber
    // sashes -- so the paint flag is per *opening*, not per building.
    const painted = lightFramed.mul(shopfront.oneMinus());

    // 78 mm of painted timber against 45 mm of aluminium: a double-hung sash
    // stile plus its bead is visibly chunkier than a mid-century slider, and that
    // difference is most of what dates a facade at fifty metres. Shopfront glass
    // is structural and its framing is slimmer still, which is what makes a
    // retail strip read as a glass wall rather than a row of punched holes.
    const frameW = mix(mix(float(0.045), float(0.078), painted), float(0.030), shopfront);

    // --- Band (a): the thinnest thing on a facade, and the first to crawl.
    //
    // Every member below used to be a bare `step`, which is a hard edge on a
    // 30-90 mm feature: past about twenty metres it is under a pixel and
    // switches on and off with the sampling grid, and a facade's worth of them
    // doing it together is most of the mid-distance shimmer this pass exists to
    // remove. `softLine`'s construction is the fix and it is applied here in
    // mask form rather than as a multiplier -- the member is widened to the
    // pixel footprint and its amplitude cut by exactly the factor it was
    // widened, so the area under it is held and it dissolves into a uniform
    // faint tint instead of flickering. Same thing the tag in `marks` already
    // does, and for the same reason.
    //
    // Each member keeps its own width, because they are not interchangeable: a
    // 78 mm timber stile, a 172 mm sill band, a 52 mm meeting rail and a 64 mm
    // mullion are four different objects and widening them all to the frame's
    // width would put a terrace's rail at half again its real thickness at
    // arm's length. `held` is taken off the perimeter band alone and applied to
    // all four -- the perimeter is 70% of the joinery's area, and the rail and
    // mullion sit within a factor of two of it, so the error is a fraction of a
    // member that is already dissolving.
    //
    // THE EDGE RAMP IS ONE PIXEL WIDE AND NOT A FRACTION OF THE MEMBER, which
    // is the difference between this and a plain reading of `softLine`. Ramping
    // over the whole widened width -- what that helper does, because a lap
    // shadow has no crisp edge to lose -- would feather a terrace's 78 mm stile
    // over 47 mm at arm's length, and the bright hard outline round an opening
    // is most of what says "there is a hole in this wall". Starting the ramp at
    // `w - pw` instead makes it a properly antialiased hard edge while the
    // member is wider than a pixel (which is strictly better than the `step` it
    // replaces, since a `step` is the aliasing) and collapses to exactly
    // `softLine`'s full-width ramp once `w` IS the footprint. The integral is
    // therefore exact in the near and mid field and loses the usual factor of
    // two only at the far end, where `dissolve` below has already handed over.
    const pw = pxWall.mul(1.6);
    const wBand = max(frameW, pw);
    const held = frameW.div(wBand);
    const band = smoothstep(wBand.sub(pw), wBand, dist).oneMinus();

    // The sill is the one member that is deeper than the rest, and it is the cue
    // the eye uses for "there is a hole in this wall with something sitting in
    // it". Measured up from the bottom of the opening rather than in from the
    // edge, so it stays a horizontal band and does not thicken the jambs with it.
    const wSill = max(frameW.mul(2.2), pw);
    const sill = smoothstep(wSill.sub(pw), wSill, aboveMid.add(halfHeight)).oneMinus();

    // Meeting rail: where the two sashes of a double-hung window overlap. 52 mm
    // overall, which is a real rail plus its putty line, and it is the single
    // most recognisable thing about a terrace window.
    //
    // It sits at the middle of the opening on a closed window and two thirds of
    // the way up on an open one, because the rail is carried by the *lower*
    // sash and a raised lower sash takes it with it. Without that the open
    // windows below would be a dark rectangle under a rail that had not moved,
    // which reads as a broken window rather than an open one.
    //
    // The roll is repeated here rather than shared, and the reason is the shape
    // of this shader: the sash decision belongs to the glass, which is shaded
    // off the *parallax-corrected* cell further down, while the rail belongs to
    // the joinery, which stands at the wall plane and is shaded off this one.
    // Re-hashing this cell costs nine instructions; evaluating `windowField` a
    // third time to share one number costs the whole grammar again. The two
    // cells agree wherever the parallax offset stays inside its own bay, which
    // is everywhere the rail is legible -- it only crosses one at grazing
    // incidence, where the glass is a mirror and there is no rail to read.
    const bayHere = floor(field.y.div(4096.0));
    const storeyHere = floor(field.y.sub(bayHere.mul(4096.0)));
    const openHere = step(
      hash31(vec3(bayHere, storeyHere, seed).add(vec3(...ROLL_STREAM.open))),
      float(WINDOW_LIFE.openSash),
    );
    const railY = openHere.mul(halfHeight).mul(float(OPEN_SASH.railRise));
    const wRail = max(float(0.026), pw);
    const rail = smoothstep(wRail.sub(pw), wRail, abs(aboveMid.sub(railY)))
      .oneMinus()
      .mul(sashFramed)
      .mul(shopfront.oneMinus());

    // One vertical mullion down the centre of any opening wide enough to need
    // one. 1.45 m is the threshold and it falls where it should: a terrace sash
    // (1.0 m) and a tower's curtain-wall bay (1.41 m) get none, a walk-up slider
    // (1.98 m), a warehouse steel window (1.8 m) and a shopfront (2.76 m) all do.
    const openW = mix(bayWidth.mul(windowRatio), bayWidth.mul(0.92), shopfront);
    const centreOffset = abs(fract(co.x.div(bayWidth)).mul(bayWidth).sub(bayWidth.mul(0.5)));
    const wMull = max(float(0.032), pw);
    const mullion = smoothstep(wMull.sub(pw), wMull, centreOffset)
      .oneMinus()
      .mul(step(float(1.45), openW));

    // Frame members are three-dimensional and this is the cheapest way to say so:
    // the head faces down and sees only the reveal soffit, the sill faces up and
    // sees the sky. A gradient rather than a two-value split, because a hard seam
    // across the jambs at mid-height is exactly the artefact this is meant to
    // avoid on the windows that have no meeting rail to hide it.
    const lift = mix(float(1.14), float(0.80), smoothstep(halfHeight.negate(), halfHeight, aboveMid));

    // --- Where band (a) hands over to the analytic mean.
    //
    // Holding the area is honest only while the widened member still fits
    // inside the opening it is drawn in. Past that it saturates -- a 78 mm
    // stile widened to half a metre covers the whole opening, so its mask can
    // no longer grow and `held` keeps falling, which *under*-counts the
    // joinery and would take a terrace's windows nine code values dark through
    // the whole mid-distance. So the widened member blends into the frame's
    // analytic share of its own opening, on the same `held` factor that drives
    // the widening: 1.0 while the frame is still wider than a pixel, and fully
    // handed over by the time the widened band is about to overrun the hole.
    //
    // The share is the perimeter times the width over the area, which for a
    // rectangle of half-dimensions (a, b) is `w * (a + b) / (a * b)` -- see
    // `MEAN.frameK` for what the constant folds in and what it costs. Both the
    // half-width and the half-height are already here: `openW` was computed for
    // the mullion test and `halfHeight` is the field's own fourth component.
    const halfW = max(openW.mul(0.5), float(0.05));
    const frameShare = min(
      float(0.95),
      frameW
        .mul(float(MEAN.frameK))
        .mul(halfW.add(halfHeight).div(halfW.mul(halfHeight))),
    );
    const dissolve = smoothstep(float(BAND.joinery[0]), float(BAND.joinery[1]), held);
    const members = max(max(band, sill), max(rail, mullion)).mul(held);

    return vec4(
      inOpening.mul(mix(frameShare, members, dissolve)),
      lift,
      inOpening,
      painted,
    );
  })();

  /**
   * The shared surface evaluation: parallax-corrected facade coordinate plus the
   * window field at that coordinate.
   *
   * Returns vec4(coord.x, coord.y, fieldDistance, packed) where `packed` folds the
   * bay and storey indices and the shopfront flag, so the whole thing fits one
   * node that every output slot can reference. Because it is a single node
   * instance shared across slots, the graph builder emits it once.
   */
  const surface = Fn(() => {
    const co = uv();
    const n = normalize(normalWorld);
    const view = normalize(positionWorld.sub(cameraPosition));

    // Facade tangent basis: u runs horizontally along the wall, v is world up.
    const tangent = normalize(vec3(n.z.negate(), float(0.0), n.x));
    const up = vec3(0.0, 1.0, 0.0);

    // View direction in facade space. Clamped so near-grazing angles cannot
    // explode into enormous offsets.
    const vn = max(abs(dot(view, n)), float(0.12));
    const su = dot(view, tangent).div(vn);
    const sv = dot(view, up).div(vn);
    const totalOffset = vec2(su, sv).mul(revealDepth);

    // Single-step parallax offset, applied only where the fragment lands on
    // glazing. A multi-step occlusion march was measured first and is not worth
    // it here: a `Loop` with a nested `If` inside it, inlined across four
    // material outputs and nine material slots, produced shaders large enough
    // that pipeline compilation blocked the main thread outright. One step is
    // the correct cost for reveals of 3-35 cm, and the reveal shading below is
    // what actually sells the depth.
    //
    // The gate is `frameNode`'s -- it already evaluated the field at the wall
    // plane to place the joinery, and this is the same test on the same number.
    // The offset therefore lands exactly where it did before the frame existed,
    // and the field is still evaluated twice per fragment rather than three
    // times.
    const coord = mix(co, vec2(co).add(totalOffset), frameNode.z);

    const field = windowField(coord);
    return vec4(coord.x, coord.y, field.x, field.y);
  })();

  /** Unpack the shared node's fourth component. */
  const bayIdx = floor(surface.w.div(4096.0));
  const storeyIdx = floor(surface.w.sub(bayIdx.mul(4096.0)));
  const shopfront = step(float(0.25), surface.w.sub(bayIdx.mul(4096.0)).sub(storeyIdx));
  const coord = vec2(surface.x, surface.y);
  const fieldDist = surface.z;

  /** Half the opening's width in metres, the same mix `windowField` makes. */
  const halfOpening = max(
    mix(bayWidth.mul(windowRatio), bayWidth.mul(0.92), shopfront).mul(0.5),
    float(0.05),
  );

  /**
   * Where this fragment sits *inside its window*, in the four measures the
   * per-window life below needs. Evaluated once and shared, like `surface`.
   *
   *   x  fraction up the storey, 0 at the floor and 1 at the ceiling
   *   y  metres above the sill line, negative on the wall under it
   *   z  metres from the opening's vertical centre line
   *   w  -1 at the sill, 0 at the mid-line, +1 at the head
   *
   * This is re-derived from the parallax coordinate rather than carried out of
   * `windowField`, and the difference is the whole performance argument for the
   * pass. The field is a vec4 and all four components are already spoken for,
   * so sharing these would mean a *third* field evaluation -- the storey
   * division, the bay division, the shopfront override and both openings, per
   * fragment, to move four numbers. Re-deriving them costs one `storeyCoord`
   * and about a dozen instructions, and `storeyCoord` is the same call the
   * blind path was already making before any of this existed. Net, this node is
   * roughly free and the alternative is not.
   *
   * Note x rather than w is what the blind's own drop is measured against, and
   * that is not an oversight: a roller blind is fixed above the head and its
   * travel is a property of the wall it hangs on, not of the hole it covers.
   * The night path has measured it that way since it was written and this keeps
   * it bit-for-bit.
   */
  const openingLocal = Fn(() => {
    const sc = storeyCoord(coord.y);
    const storeyH = sc.z;
    const yInStorey = sc.y.mul(storeyH);
    const sill = mix(sillHeight, float(0.35), shopfront);
    const head = mix(headHeight, storeyH.sub(0.75), shopfront);
    const halfHeight = max(head.sub(sill).mul(0.5), float(0.05));
    const aboveSill = yInStorey.sub(sill);
    return vec4(
      sc.y,
      aboveSill,
      abs(fract(coord.x.div(bayWidth)).mul(bayWidth).sub(bayWidth.mul(0.5))),
      aboveSill.sub(halfHeight).div(halfHeight),
    );
  })();

  /**
   * Is there a window on this storey at all, and its `storeys - 0.5` test.
   *
   * Five things need it -- the opening mask's vertical factor below, the aircon
   * box, the streak, the marks, and the streak's *source* storey, which is a
   * different index and so takes the threshold rather than the result. Above the
   * top storey `windowField` forces its distance to -1, and the parapet band and
   * the roofline trim both carry a v just past the building's head in this same
   * material, so anything that forgets this grows a row of itself along the
   * skyline.
   */
  const topStorey = storeys.sub(0.5);
  const withinTop = step(storeyIdx, topStorey);

  /* --- DISTANCE, band (b): the window grid ---------------------------------
   *
   * The opening mask, rebuilt as a **product of two independent factors** so
   * each axis can fade on its own period. See `BAND` for why one `min` over the
   * two periods is the wrong construction and what it costs.
   *
   * This is not an approximation of `step(0, fieldDist)`, it is an identity. The
   * field's distance is `min(dx, dy)` over a rectangular opening, so
   * `step(0, min(dx, dy))` is `step(0, dx) * step(0, dy)` exactly -- and both
   * factors are already sitting in numbers this shader computed for other
   * reasons. `openingLocal.z` is metres from the opening's centre line, so the
   * horizontal test is one subtraction against the half width. `openingLocal.w`
   * is signed height in units of the opening's own half height, so the vertical
   * test is `|w| <= 1` and needs no half height at all.
   */
  const xInside = step(openingLocal.z, halfOpening);
  const yInside = step(abs(openingLocal.w), float(1.0)).mul(withinTop);

  /**
   * What each factor averages to: the opening's width as a fraction of the bay,
   * and its height as a fraction of the storey.
   *
   * Both are parameters rather than measurements, which is what makes the mean
   * facade nearly free. The width fraction IS `windowRatio` -- 0.92 on a
   * shopfront -- because `windowField` builds the opening as exactly that
   * fraction of the bay. The height fraction is the head-to-sill span over the
   * storey it sits in, and both of those are the same two `mix`es `windowField`
   * and `openingLocal` already make.
   *
   * Read per fragment rather than per building, and that is what makes the
   * ground-storey override come out right for nothing: on a retail strip's
   * ground storey these evaluate to the shopfront's 0.92 and its 3.1 m of glass
   * in a 4.2 m storey, and on the sashes above to 0.80 and 2.4 m in 3.95, so the
   * building's mean is the area-weighted blend of the two *by construction*
   * rather than by an arithmetic that has to be told the height shares. Above
   * the top storey `withinTop` takes the vertical factor to zero, so the parapet
   * band and the roofline trim dilute the mean exactly as much wall as they are.
   */
  const storeyH = mix(floorHeight, groundHeight, step(storeyIdx, float(0.5)));
  const openH = max(
    mix(headHeight.sub(sillHeight), storeyH.sub(1.10), shopfront),
    float(0.1),
  );
  const xShare = mix(windowRatio, float(0.92), shopfront);
  const yShare = saturate(openH.div(storeyH)).mul(withinTop);

  /**
   * The joinery's share of one opening, and the reveal shading's average over
   * it. The same perimeter-over-area `frameNode` computes for band (a); it is
   * cheaper to write the three lines twice than to evaluate the window field a
   * third time to carry two numbers out of it, which is the trade the meeting
   * rail's own comment already makes at nine instructions.
   */
  const perimOverArea = halfOpening.add(openH.mul(0.5)).div(halfOpening.mul(openH.mul(0.5)));
  const frameW = mix(mix(float(0.045), float(0.078), frameNode.w), float(0.030), shopfront);
  const frameFrac = min(float(0.95), frameW.mul(float(MEAN.frameK)).mul(perimOverArea));
  const meanReveal = clamp(
    float(1.0).sub(perimOverArea.mul(revealDepth).mul(float(MEAN.reveal))),
    0.52,
    1.0,
  );

  /**
   * The bands. One divide each off the shared footprint, and everything after
   * this point is arithmetic.
   *
   * `gridRatio` is the *worse* of the two axes -- the one that goes sub-pixel
   * first -- and it drives the per-window life and the night emissive, which are
   * single decisions per window rather than per axis and so have only one
   * period to fade on.
   */
  const bayRatio = pxWall.div(bayWidth);
  const floorRatio = pxWall.div(storeyH);
  const gridRatio = max(bayRatio, floorRatio);
  const bayFade = resolves(1.0, bayRatio, BAND.grid[0], BAND.grid[1]);
  const floorFade = resolves(1.0, floorRatio, BAND.grid[0], BAND.grid[1]);
  const gridFade = min(bayFade, floorFade);
  const lifeFade = resolves(1.0, gridRatio.mul(BAND.lifeAhead), BAND.grid[0], BAND.grid[1]);
  const revealFade = resolves(1.0, pxWall.div(max(revealDepth, float(0.02))), BAND.reveal[0], BAND.reveal[1]);

  /**
   * The opening mask, faded. This one node is most of the pass.
   *
   * WHY THE HORIZONTAL FACTOR CARRIES A CORRECTION AND THE VERTICAL DOES NOT.
   * The joinery is composited *over* the opening rather than beside it --
   * `mix(mix(wall, glass, inWindow), frame, frameMask)` -- so once both masks
   * are fractions rather than 0-or-1, the frame's share comes out of the wall
   * and the glass in proportion, where physically it comes out of the glass
   * alone. Solving the two nested mixes for the coefficients that give
   * `wall*(1-p) + glass*p*(1-f) + frame*p*f` puts the whole correction on the
   * first mix: it must fade to `p*(1-f)/(1-p*f)` rather than to `p`, and the
   * second to `p*f`. Then all three land exactly, which is what the measured
   * table on `MEAN` is checking. Six instructions, and without them a terrace's
   * wall is 6% light and its windows 16 code values dark at range.
   *
   * The alternative -- reordering to `mix(wall, mix(glass, frame, bands), open)`
   * -- is exact with no correction at all and was rejected on a different
   * count: the frame is gated by the opening at the *wall plane* and the glass
   * by the opening at *reveal depth*, and between them lies the parallax jamb,
   * where the current order correctly paints joinery on wall. Reordering
   * deletes the frame from every reveal at grazing incidence.
   */
  const openTarget = xShare.mul(yShare);
  const nested = frameFrac.oneMinus().div(openTarget.mul(frameFrac).oneMinus());
  /**
   * The door's suppression, at the parallax-corrected coordinate, and the one
   * thing that could not be left to `windowField` alone.
   *
   * `inWindow` is NOT `step(0, fieldDist)` -- it is rebuilt from `openingLocal`
   * so the two axes can fade on their own periods (see `BAND`), which means it
   * never sees the field's suppressed distance and would keep drawing glazing
   * straight through the door. Both factors have to lose it, and applying it to
   * the product is the same thing for one multiply instead of two.
   *
   * Applied AFTER the distance fade rather than inside `yInside`, deliberately.
   * The faded arm converges on the opening's analytic *share* of its bay, so a
   * cut folded in before the fade would come back at range as a window mean
   * painted over the door. What a door's bay converges to at two hundred metres
   * is wall and door, and this is what says so.
   */
  const notDoor = doorCut(coord).oneMinus();
  const inWindow = mix(xInside, xShare.mul(nested), bayFade.oneMinus())
    .mul(mix(yInside, yShare, floorFade.oneMinus()))
    .mul(notDoor);

  /**
   * The joinery, faded the rest of the way. Band (a) inside `frameNode` has
   * already dissolved the members into that opening's own frame fraction; what
   * is left is to stop the *opening* being a hard edge, which is the same
   * handover the mask above makes and on the same band.
   *
   * `notDoor` for the same reason `inWindow` carries it: `frameNode.x` is
   * already zero inside the door, because the field is suppressed there, but the
   * analytic arm it fades into is not, and a window frame's mean painted across
   * a door at range is exactly as wrong as the window would have been.
   */
  const frameMask = mix(frameNode.x, openTarget.mul(frameFrac), gridFade.oneMinus()).mul(
    notDoor,
  );

  /**
   * How deep into the opening this fragment sits, used to darken the sides of
   * the reveal. Without this the parallax reads as a texture sliding about.
   *
   * Hoisted out of the colour node because the reflection needs it too: a
   * fragment against the side of a reveal is looking at glass that sees a slot of
   * sky rather than a hemisphere of it, so the mirror term has to fall off there
   * for the same reason and by the same amount as the diffuse one. Left out, the
   * reveal reappears as a bright band exactly where the depth cue says shadow.
   *
   * Band (d): the ramp is `revealDepth` wide -- 30 to 350 mm -- so it is a
   * soft-edged frame around every opening in the city and it aliases on its own
   * schedule, well before the grid does and well after the joinery. It fades to
   * the average of itself over the opening rather than to 1.0, because a window
   * that brightened as it receded would be worse than one that shimmered.
   */
  const depthFrac = clamp(fieldDist.div(max(revealDepth, float(0.02))), 0, 1);
  const revealShade = mix(
    meanReveal,
    mix(float(0.52), float(1.0), depthFrac),
    revealFade,
  );

  /**
   * The seed's two bytes and the value roll, hoisted.
   *
   * They were local to `colorNode` and are now shared with the weathering, which
   * needs the age factor outside it -- the corrugated-wall rust drives roughness
   * and metalness as well as colour, for the same reason the roof's rust does.
   * Referencing one node object rather than rebuilding the expression is what
   * keeps this at one evaluation; see `surface` for the same argument at four
   * times the cost.
   */
  const seedHi = floor(seed.div(float(256.0)));
  const seedLo = seed.sub(seedHi.mul(float(256.0)));
  const valueRoll = buildingRoll(seedLo, seedHi, BUILDING_STRIDES.value);

  /** How hard this building has been left. See `AGE`. */
  const age = float(AGE.min).add(respin(valueRoll, AGE.respin).mul(AGE.span));

  /**
   * The archetypes built without ducting, which have had a box screwed to them
   * since: interwar flats (2), walk-ups (3), suburban brick veneer (7) and
   * modern infill (9). Not contiguous, so it is three tests rather than one.
   *
   * Hoisted out of `aircon` because the drip below has to agree with the box
   * exactly -- a rust run under a wall that never had a unit on it is worse than
   * no run at all -- and sharing the node is the only way that cannot drift.
   */
  const airconArchetype = max(
    step(float(1.5), archetype).mul(step(archetype, float(3.5))),
    max(
      step(float(6.5), archetype).mul(step(archetype, float(7.5))),
      step(float(8.5), archetype),
    ),
  );

  /**
   * What the glass reflects, and how much of it.
   *
   * This is the whole answer to "windows are black holes". A daytime window's
   * brightness is almost entirely *not* its own colour -- it is the sky and the
   * sunlit facade opposite, arriving as radiance from somewhere else. That is why
   * the result goes to `emissiveNode` and not to `colorNode`: an albedo would be
   * multiplied by the irradiance landing on *this* wall, so a shaded facade's
   * windows would go dark with the wall they sit in, which is the exact inversion
   * of what real glazing does. `NodeMaterial` adds emissive straight into the
   * outgoing radiance, so a value here is in the same units as the sky dome and
   * lands on the same tone curve.
   *
   * Returns vec4(reflected radiance already scaled by Fresnel and daylight,
   * Fresnel). The colour node needs the Fresnel separately: whatever is behind
   * the glass is *transmitted*, so it has to lose exactly what the reflection
   * gains, and a shared node is how both slots get it for one evaluation.
   *
   * Predicted at 3 pm on 15 February, through the same chain that calibrated the
   * material table above -- irradiance, Lambert, plus emissive, Neutral at
   * exposure 0.62 (shaded wall (3.44, 3.19, 3.05), sunlit wall (9.85, 10.16,
   * 10.59)). Y' is the luminance of the displayed value:
   *
   *   SHADED red-brick facade
   *     the wall                            rgb( 95,  40,  17)   Y'  50
   *     its windows, looking up 12 deg      rgb(104, 116, 124)   Y' 114
   *     the same at 60 deg off-normal       rgb(129, 143, 153)   Y' 141
   *     the same at grazing                 rgb(216, 236, 250)   Y' 233
   *     painted frame, sill end             rgb(181, 172, 162)   Y' 173
   *   SUNLIT red-brick facade
   *     the wall                            rgb(161,  91,  72)   Y' 105
   *     its windows, looking up 12 deg      rgb(121, 132, 139)   Y' 130
   *   CURTAIN WALL, looking up 25 deg       rgb(175, 210, 241)   Y' 205
   *   SHOPFRONT plate glass, at eye level   rgb(154, 166, 168)   Y' 164
   *
   * And what the per-window life below does to that same shaded window, on the
   * same conditions -- the whole point being that no two of these are the same
   * and every one of them is separated from bare glass by more than the dozen
   * code values a viewer stops resolving at distance:
   *
   *     bare glass, the baseline above      rgb(104, 116, 124)   Y' 114
   *     the cleanest pane of it             rgb(111, 124, 133)   Y' 122
   *     the dirtiest                        rgb( 98, 106, 112)   Y' 105
   *     a drawn blind, dark fabric          rgb(139, 142, 144)   Y' 142
   *     a drawn blind, light fabric         rgb(154, 157, 157)   Y' 156
   *     a half-open curtain band            rgb(147, 150, 151)   Y' 149
   *     the upper pane of an open sash      rgb(142, 158, 169)   Y' 155
   *     the raised sash's own opening       rgb(  9,   4,   1)   Y'   5
   *
   * The last two are one window: a bright pane over a black hole, split by a
   * meeting rail that has moved up with the sash. Nothing else on a facade
   * looks like that, which is why 8% of the windows carry the read for all of
   * them.
   *
   * The first block is the one that matters. Glass at 2.3x the luminance of the
   * wall it sits in, cool against warm, and a near-mirror as the wall turns away
   * -- **brighter than the masonry around it while both are in shade**, which is
   * the tell of real glazing and is exactly what an albedo cannot produce, since
   * an albedo can only ever be a fraction of the same irradiance the wall gets.
   * On the sunlit side the ordering flips back and the wall wins the red channel:
   * glazing does not care which side of the street it is on, and masonry does.
   */
  const glazing = Fn(() => {
    const n = normalize(normalWorld);
    const view = normalize(positionWorld.sub(cameraPosition));
    // `view` runs camera -> surface, which is the incident direction `reflect`
    // wants, so this is the mirror direction without a negation.
    const mirror = reflect(view, n);

    // The dome, as two anchors and a fitted falloff. See GLASS_SKY.
    const sky = mix(
      vec3(...GLASS_SKY.horizon),
      vec3(...GLASS_SKY.zenith),
      pow(saturate(mirror.y), float(GLASS_SKY_FALLOFF)),
    );

    // Where the sun is, in the only two ways that are worth their instructions.
    //
    // The broad term first: the half of the sky the sun is in is brighter than
    // the half behind you, by about 1.3 to 0.74 here. That gradient is what makes
    // the two sides of a street's glazing differ at all, and it costs one mix --
    // without it every window in the city reflects the same sky and the whole
    // effect reads as a flat blue decal.
    //
    // Then the aureole: the halo around the sun itself, roughly 15 degrees wide,
    // an order of magnitude brighter than the sky beside it. A window whose
    // mirror direction lands on it blows out, which is correct and which is the
    // thing you actually see walking up a Sydney street at three in the
    // afternoon. The *tight* specular spike is deliberately not here -- the
    // glass already carries a low roughness and a metalness keyed to its glazing
    // type, so the sun's own directional light draws that lobe. Adding a second
    // one would double-count it.
    const sunAlign = dot(mirror, globals.sunDirection);
    const dome = sky
      .mul(mix(float(0.74), float(1.30), sunAlign.mul(0.5).add(0.5)))
      .add(vec3(1.0, 0.93, 0.82).mul(pow(saturate(sunAlign), float(22.0)).mul(9.0)));

    // Below the horizon it is street, not sky. Blended across about seven degrees
    // rather than cut: real glass is never optically flat, and the soft edge also
    // stands in for the skyline this model has no way to know about.
    const reflected = mix(
      vec3(...GLASS_SKY.street),
      dome,
      smoothstep(float(-0.06), float(0.06), mirror.y),
    );

    // Schlick, with the normal-incidence reflectance keyed to the building's
    // glazing type. Plain float glass is 0.04-0.08 and everything old lands there
    // (`reflectivity` 0.18 -> 0.055); a tower's coated curtain wall is nothing
    // like it (0.92 -> 0.30), and squaring the parameter is what keeps the low
    // end physical while still letting the CBD go properly mirrored. The fifth
    // power is three multiplies instead of a `pow`, and it is what takes any
    // glass to a full mirror at grazing incidence.
    //
    // Shopfronts get a step up on top of whatever their building is: plate glass
    // is thick, laminated and optically flat where a hundred-year-old sash is
    // none of those, and it is floor-to-head with no wall interrupting it. That
    // combination is why a retail strip reads as a glass wall mirroring the
    // street rather than as a row of holes -- 0.15 face-on for a retail strip,
    // and a full mirror by the time you are looking along the shopfronts.
    const f0 = float(0.045)
      .add(reflectivity.mul(reflectivity).mul(0.30))
      .add(shopfront.mul(0.045));
    const grazing = abs(dot(n, view)).oneMinus();
    const grazing2 = grazing.mul(grazing);
    const fresnel = f0.add(f0.oneMinus().mul(grazing2.mul(grazing2).mul(grazing)));

    // Blue-green, per spec 7.3, and only on the slot that is actually curtain
    // wall. A compile-time branch, so it costs nothing anywhere else.
    const tinted =
      slot === 'curtain_wall' ? reflected.mul(vec3(0.80, 0.94, 1.0)) : reflected;

    // Nothing to reflect after dark. This is the whole of the night handling:
    // the sky term goes to zero with the daylight that produced it, unlit glass
    // falls back to its dark interior, and the lit windows below are untouched.
    return vec4(tinted.mul(fresnel).mul(globals.nightFactor.oneMinus()), fresnel);
  })();

  /** The glazing that is actually glass -- the joinery in front of it is not. */
  const glassArea = inWindow.mul(frameMask.oneMinus());

  /**
   * Per-window deterministic rolls, shared by colour and emissive.
   *
   * Six streams, of which three are hashed and three are spun off one that
   * already was. Which is which is not a cost decision, it is the rule stated on
   * `ROLL_STREAM`: a roll that gets thresholded is hashed, a roll that gets
   * lerped is spun. See there for the measured independence, and for the
   * attempt that got it wrong.
   *
   *   litRoll      lit / unlit                     hashed, thresholded at 0.34
   *   blindRoll    how far a blind is drawn        hashed, lerped
   *   hueRoll      interior and fabric colour      hashed, lerped
   *   dressRoll    blind / curtain / bare glass    hashed, thresholded twice
   *   fitRoll      is there an aircon on this bay  hashed, thresholded at 0.12
   *   openRoll     is the lower sash up            hashed, thresholded at 0.08
   *   curtainRoll  how far the curtains are drawn  spun off blindRoll, lerped
   *   grimeRoll    how clean this pane is          spun off fitRoll, lerped
   *
   * The two spun rolls are each paired with a parent they can never be seen
   * beside: `curtainRoll` only matters on a window `dressRoll` gave curtains
   * rather than a blind, so it and `blindRoll` are never both on screen for the
   * same window, and `grimeRoll` only matters on glass an aircon is not
   * covering.
   */
  const cell = vec3(bayIdx, storeyIdx, seed);
  // `lit` is the unshifted stream -- `ROLL_STREAM.lit` is (0, 0, 0) and is
  // written out rather than added, so the one roll the night skyline depends on
  // carries not a single instruction it did not carry before this pass.
  const litRoll = hash31(cell);
  const blindRoll = hash31(cell.add(vec3(...ROLL_STREAM.blind)));
  const hueRoll = hash31(cell.add(vec3(...ROLL_STREAM.hue)));
  const dressRoll = hash31(cell.add(vec3(...ROLL_STREAM.dress)));
  const fitRoll = hash31(cell.add(vec3(...ROLL_STREAM.fit)));
  const openRoll = hash31(cell.add(vec3(...ROLL_STREAM.open)));
  const curtainRoll = respin(blindRoll, 27.1);
  /**
   * Band (c) on the glazing sparkle. A lerped roll, so it fades to 0.5 the way
   * the roof's sheet roll does -- and at 0.5 the two things it drives land on
   * exactly their own means for free: the film multiplier becomes 1.0 and the
   * desaturation becomes half of `GRIME.desaturate`.
   *
   * This is the only per-window variation a curtain wall has, and on a tower it
   * is the loudest: a facade that is nothing but reflection, dithered per pane
   * by +/-15% of the brightest value in frame, is a sheet of static the moment
   * the panes go sub-pixel. It fades a stop before the grid it sits on, because
   * a random value on a cell boils long before the cell's own edges do -- the
   * same argument `finishTileRoof` makes about a 330 mm tile at a hundred
   * metres.
   */
  const grimeRoll = mix(float(0.5), respin(fitRoll, 19.3), lifeFade);
  /**
   * Roughly a third of windows lit at night, effectively none by day -- faded
   * toward that third itself, which is the whole of the night treatment.
   *
   * A lit window is the highest-contrast thing this material draws: `rgb(193,
   * 164, 121)` against a wall at `rgb(5, 1, 0)`. As the grid goes sub-pixel a
   * binary lit/unlit roll on that contrast is not shimmer, it is a strobe, and
   * it is the worst artefact in the build after dark. Faded, a distant tower
   * reads as a soft warm-speckled slab at `litFraction` of the lit colour --
   * which is what a city looks like from a hill, and is arrived at here by
   * exactly the arithmetic that describes it.
   *
   * ON THE GRID BAND AND NOT THE LIFE BAND, which is the one place this pass
   * deliberately fades something later than the daytime equivalent. Everything
   * on the life band is *one signal among several* -- take the blinds out of a
   * facade and the windows, frames and wall are all still there. After dark the
   * lit grid is the only thing drawn: the wall is at code value 5, the frame is
   * a silhouette, and unlit glass has no sky left to reflect. Fading it at half
   * the distance the daytime facade survives to would blank the skyline, so it
   * goes when the grid goes and not before.
   */
  const lit = mix(
    float(0.34),
    step(litRoll, float(0.34)),
    gridFade,
  ).mul(globals.nightFactor);
  /**
   * The lit room's own colour and brightness, faded on the same band as `lit`
   * for the same reason -- and its two rolls fade differently because they are
   * used differently. `litRoll` is lerped into the brightness, so it goes to
   * 0.5; `hueRoll` is *thresholded* at 0.38 to pick warm domestic tungsten
   * against cool office fluorescent, so what fades is the threshold's result to
   * its 38% share. Fading a thresholded roll to 0.5 would put every room in the
   * city on the same side of it, which is the trap `ROLL_STREAM` documents from
   * the other direction.
   */
  const litLevel = mix(float(0.5), litRoll, gridFade);
  const coolShare = mix(float(0.38), step(hueRoll, float(0.38)), gridFade);
  /** The fabric colour is a lerp, so the roll itself fades. See `grimeRoll`. */
  const fabricRoll = mix(float(0.5), hueRoll, lifeFade);

  /**
   * The room behind the glass, lit and unlit. Hoisted out of `colorNode` when
   * the front door's fanlight arrived, because a fanlight is a window into the
   * same hall and has to be the same room -- sharing the node is the only way
   * the two cannot drift, and it is the same argument `airconArchetype` makes
   * for the box and its drip.
   *
   * Interior colour runs warm domestic tungsten to cool office fluorescent. Both
   * rolls arrive already faded on the grid band -- `coolShare` is the thresholded
   * warm/cool pick faded to its 38% share, `litLevel` the lerped brightness
   * faded to the middle of its range.
   *
   * Unlit is the transmitted term and nothing else: a dark room, warm-neutral
   * rather than blue. Kept deliberately low (0.045) because an albedo here is
   * lit by the irradiance on the *outside* of the wall, which a room's interior
   * plainly is not -- at 0.045 that lie is worth about eight code values on a
   * sunlit facade and it is not worth a second lighting model to fix.
   */
  const interiorLit = mix(vec3(1.0, 0.76, 0.45), vec3(0.82, 0.90, 1.0), coolShare).mul(
    float(0.55).add(litLevel.mul(1.1)),
  );
  const interiorDark = vec3(0.045, 0.043, 0.040).mul(
    float(1.0).sub(globals.nightFactor.mul(0.55)),
  );

  /**
   * Painted timber and white powder-coat against dark anodised aluminium.
   *
   * Hoisted for the fanlight's architrave, which is the same trade and the same
   * paint as the window joinery beside it and must never be a different colour
   * from it -- `frameNode.w` is the per-opening painted flag, and on a door's
   * own ground storey it reads exactly what the windows two metres away read.
   *
   * The painted value is a little above `render_painted` on purpose -- window
   * frames get repainted far more often than the wall around them, and in shade
   * this lands at rgb(181, 172, 162) against brick at rgb(95, 40, 17), which is
   * the bright outline that says "opening" before any of the glass is read.
   */
  const frameColour = mix(
    vec3(0.050, 0.047, 0.043),
    vec3(0.72, 0.70, 0.65),
    frameNode.w,
  );

  /**
   * What this window is doing, as three masks over the glazing.
   *
   *   x  covering weight -- a blind drawn from the head, or curtains gathered
   *      at the jambs. One mask, because both are fabric and both take the same
   *      colour; what separates them for the eye is the axis they run on.
   *   y  the hole where a raised lower sash used to be
   *   z  the upper pane of that same window, which now has two sheets of glass
   *      in front of it
   *
   * Compiled out of the curtain-wall pipeline entirely: a tower has no blinds
   * this shader could draw, no double-hung sashes, and its spandrel grid is not
   * a room. That is the same compile-time branch `flatRoof` and the curtain
   * wall's own tint use, so eight pipelines carry this and the ninth does not.
   */
  const windowLife =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          // Which of the three states this window is in. Two `step`s on one
          // roll, so the three shares are exclusive by construction and cannot
          // drift apart the way three independent rolls would.
          const hasBlind = step(dressRoll, float(WINDOW_LIFE.blind));
          const hasCurtain = step(float(WINDOW_LIFE.blind), dressRoll).mul(
            step(dressRoll, float(WINDOW_LIFE.blind + WINDOW_LIFE.curtain)),
          );

          // The blind's geometry, unchanged from the night path that has always
          // been here: drawn down from the ceiling by `blindRoll * 0.9` of the
          // storey. A roll under about 0.105 leaves the bottom rail above the
          // window head and draws nothing at all, which is why the 45% share
          // shows as roughly 40% of windows visibly blinded -- a blind rolled
          // right up is a blind, and it is invisible either way.
          //
          // The presence gate is the one thing that is day-only, and it has to
          // be. After dark this band is not really a blind at all: it is the
          // lit room's own falloff, a brighter panel at the top of the opening
          // standing in for the ceiling and the fitting, and every window wants
          // one. By day it is a physical object and 55% of windows do not have
          // it. `mix(gate, 1, nightFactor)` is both, and lands on exactly the
          // existing expression at nightFactor 1.
          const behindBlind = step(float(1.0).sub(openingLocal.x), blindRoll.mul(0.9));
          const blind = behindBlind.mul(mix(hasBlind, float(1.0), globals.nightFactor));

          // Curtains: two vertical bands, gathered at the jambs, on a soft edge
          // because cloth gathers and a bottom rail does not.
          const across = openingLocal.z.div(halfOpening);
          const gap = float(CURTAIN.edge).add(curtainRoll.mul(CURTAIN.spread));
          const curtain = smoothstep(gap, gap.add(float(CURTAIN.softness)), across)
            .mul(hasCurtain)
            .mul(globals.nightFactor.oneMinus());

          // The raised lower sash. Pre-war double-hung stock only -- the same
          // test `frameNode` uses to decide whether to draw a meeting rail at
          // all, because a window with no rail has no sash to raise.
          const openSash = step(openRoll, float(WINDOW_LIFE.openSash))
            .mul(sashFramed)
            .mul(shopfront.oneMinus());
          const upper = step(float(OPEN_SASH.railRise), openingLocal.w);
          const hole = openSash.mul(upper.oneMinus());

          // Nothing hangs across a hole. Without this the 8% that are open
          // would show a blind drawn over an opening that has no glass in it,
          // which is two features arguing rather than one facade.
          const live = vec3(
            max(blind, curtain).mul(hole.oneMinus()),
            hole,
            openSash.mul(upper),
          );

          // --- Band (c): all three, to their measured means at once.
          //
          // Every one of these is a hard edge on a per-window roll -- a bottom
          // rail across the opening, a curtain's leading edge, a black hole
          // where a sash used to be -- and the contrast is the highest on the
          // facade after the night emissive. They are also the cheapest thing
          // here to fade, because a mask's mean is a number and the numbers were
          // measured rather than guessed: see `MEAN.life`.
          //
          // The last two carry `sashFramed` and the shopfront gate because their
          // means do, exactly: an open lower sash exists only on the pre-war
          // double-hung stock, so on everything else the mean of the mask is
          // zero and this whole term compiles to a multiply by zero rather than
          // to a wrong constant.
          const sashed = sashFramed.mul(shopfront.oneMinus());
          return mix(
            vec3(
              float(MEAN.life[0]),
              float(MEAN.life[1]).mul(sashed),
              float(MEAN.life[2]).mul(sashed),
            ),
            live,
            lifeFade,
          );
        })();

  /**
   * The box unit, as `vec4(colour, coverage)` -- the same shape `flatRoof`
   * returns, and composited the same way.
   *
   * Placed off `openingLocal` and the bay geometry alone, so it costs no field
   * evaluation of its own. Note where the two placements put it relative to the
   * parallax: an under-sill unit sits on wall, where the coordinate is
   * un-offset, so it stands at the wall plane as a bracketed box should. A
   * walk-up's sits inside the opening, where the coordinate *is* offset, so it
   * recedes with the reveal -- which is right, because that unit is behind the
   * sash line rather than in front of it.
   *
   * Compiled out of the curtain-wall pipeline. A modern-infill building can
   * draw the curtain-wall slot, and a box unit screwed to a curtain wall is not
   * a thing that exists.
   */
  const aircon =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          // Interwar flats (2), walk-ups (3), suburban brick veneer (7) and
          // modern infill (9): the archetypes built without ducting. Hoisted to
          // `airconArchetype` so the drip below reads the same node -- if the
          // two ever disagreed there would be rust running down a wall that
          // never had a unit on it.
          const fitted = airconArchetype;
          // `withinBuilding` in `windowField` terms: above the top storey there
          // is no window, so there is nothing to hang a unit under. Without
          // this the parapet band and the roofline trim -- which carry a v just
          // past the building's head, in this same material -- would grow a row
          // of boxes along the skyline.
          const has = step(fitRoll, float(WINDOW_LIFE.aircon))
            .mul(fitted)
            .mul(shopfront.oneMinus())
            .mul(withinTop);

          // A walk-up's unit stands *in* the opening -- those are the aluminium
          // sliders of spec 6.2, wide enough that a box takes half of one and
          // leaves the rest as glass. Everything else hangs on brackets with
          // its top at the sill line.
          const inOpeningUnit = step(float(2.5), archetype).mul(step(archetype, float(3.5)));
          const boxTop = mix(float(0.0), float(AIRCON.height + 0.03), inOpeningUnit);

          // Metres up from the bottom of the casing, and signed metres in from
          // its two ends. Everything below is a comparison on these two.
          const up = openingLocal.y.sub(boxTop).add(float(AIRCON.height));
          const dx = float(AIRCON.width * 0.5).sub(openingLocal.z);
          const casing = step(
            float(0.0),
            min(dx, min(up, float(AIRCON.height).sub(up))),
          ).mul(has);

          // The moulded grille: the lower two thirds of the face, set in from
          // the ends. One band rather than louvres, because a 12 mm louvre on a
          // wall thirty metres away is a texture nobody asked for and this
          // shader has no way to fade it.
          const grille = casing
            .mul(step(float(0.035), dx))
            .mul(step(float(0.05), up))
            .mul(step(up, float(0.30)));

          // The shadow, which is what makes the box sit on the wall rather than
          // be printed on it. A ramp that dies over `shadowDrop`, mixed toward
          // a dark tone rather than multiplied into the wall -- the vec4 has
          // room for a coverage and not for a multiplier, and at 55 mm the two
          // are indistinguishable.
          const shadow = has
            .mul(step(float(0.0), dx))
            .mul(step(up, float(0.0)))
            .mul(saturate(up.div(float(AIRCON.shadowDrop)).add(1.0)))
            .mul(float(AIRCON.shadowStrength));

          const face = mix(
            vec3(...AIRCON.casing),
            vec3(...AIRCON.casing).mul(float(AIRCON.grilleMix)),
            grille,
          );
          // Band (c). A 700 x 450 mm box with a hard silhouette and a hard
          // grille band inside it is a two-pixel object of high contrast well
          // before the grid it hangs on goes, and a facade's worth of them
          // popping in and out is the same artefact the windows have. It fades
          // to the area-weighted mean of the casing, its grille and its shadow
          // at the measured 0.45% of a bay -- see `MEAN.airconCover`, and note
          // that the gates go with it, so a terrace, which never had one, gets
          // a mean of exactly nothing rather than a small grey wash.
          return mix(
            vec4(
              vec3(...MEAN.airconColour),
              float(MEAN.airconCover).mul(fitted).mul(shopfront.oneMinus()).mul(withinTop),
            ),
            vec4(mix(vec3(...AIRCON.shadow), face, casing), max(casing, shadow)),
            lifeFade,
          );
        })();

  /**
   * Water staining below sills, and the aircon drip that is the same streak.
   * Spec section 7.6's first two items. Returns a multiplier on the wall.
   *
   * Compiled out of the curtain-wall pipeline: a tower's spandrel grid has no
   * sills, and a streak down a sheet of glass is a different effect that does
   * not exist here.
   */
  const sillStain =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          // --- Where the water came from.
          //
          // The whole storey geometry, rebuilt from numbers that already exist
          // rather than from a third `windowField` evaluation. `openingLocal.y`
          // is metres above this storey's sill; adding the sill back gives
          // metres above its floor, and the storey height is the same two-line
          // `mix` `storeyCoord` makes.
          const sillLine = mix(sillHeight, float(0.35), shopfront);
          const storeyH = mix(floorHeight, groundHeight, step(coord.y, groundHeight));
          const headLine = mix(headHeight, storeyH.sub(0.75), shopfront);
          const yInStorey = openingLocal.y.add(sillLine);

          // Above the head of this storey's window there is still wall, and the
          // sill staining it belongs to the storey *above*. One `step` buys the
          // whole cross-storey run -- see `STAIN` for why the 0.5-1.0 m under a
          // sill is not enough on its own.
          const fromAbove = step(headLine, yInStorey);
          const fall = sillLine.sub(yInStorey).add(fromAbove.mul(storeyH));
          const srcStorey = storeyIdx.add(fromAbove);
          const srcCell = vec3(bayIdx, srcStorey, seed);

          // The source window has to exist. Above the top storey `windowField`
          // forces its distance to -1 and there is no opening at all, so without
          // this the parapet band and the roofline trim -- which carry a v just
          // past the building's head, in this same material -- would streak from
          // a row of windows that is not there. Exactly the trap `aircon`
          // documents, one storey higher up.
          //
          // A shopfront is excluded only when the fragment is under its own
          // 0.35 m sill, which is 350 mm of plinth and not worth a streak. The
          // band above a shopfront head belongs to the window on storey 1 and
          // keeps its streak.
          const exists = step(srcStorey, topStorey).mul(max(shopfront.oneMinus(), fromAbove));

          // --- The rolls, at the *source* window's cell, not this fragment's.
          const stainRoll = hash31(srcCell.add(vec3(...ROLL_STREAM.stain)));
          const stainSpin = respin(stainRoll, 31.7);
          // The same `fit` stream the box is drawn from, re-hashed at the source
          // cell so a streak in the band above one window still knows about the
          // unit hanging under the window above it.
          const srcFit = hash31(srcCell.add(vec3(...ROLL_STREAM.fit)));

          // Faded almost to Nyquist, per `resolves`: a streak is a low-contrast
          // half-metre band and it is meant to survive as far as anything on the
          // facade does. Fading the *roll* to 0.5 rather than the streak to zero
          // is the discipline the roof path sets -- a wall must not change
          // brightness as it recedes, so what goes away is the variation between
          // windows, not the dirt.
          const fade = resolves(STAIN.module, pxWall, 0.33, 0.72);
          const roll = mix(float(0.5), stainRoll, fade);
          const spin = mix(float(0.5), stainSpin, fade);

          // --- Which streak this is. A handful of lerps, and the drip falls out.
          const hasDrip = step(srcFit, float(WINDOW_LIFE.aircon)).mul(airconArchetype);
          // Where the water actually leaves, as a fall below the sill line.
          //
          // The two numbers are `AIRCON.height - boxTop` for the two placements
          // `aircon` uses, folded here rather than recomputed: everything but a
          // walk-up hangs on brackets with its top at the sill, so the casing's
          // bottom is 0.45 m *below* it; a walk-up's unit stands in the opening
          // with its top at 0.48, so the bottom is 30 mm *above* the sill. That
          // is the only thing about the box this needs to know, and it has to
          // agree with `aircon` exactly or the streak leaves from nowhere.
          const inOpeningUnit = step(float(2.5), archetype).mul(step(archetype, float(3.5)));
          const drop = fall.sub(
            hasDrip.mul(mix(float(AIRCON.height), float(-0.03), inOpeningUnit)),
          );

          const reach = mix(float(STAIN.fall[0]), float(STAIN.dripFall[0]), hasDrip).add(
            roll.mul(mix(float(STAIN.fall[1] - STAIN.fall[0]), float(STAIN.dripFall[1] - STAIN.dripFall[0]), hasDrip)),
          );
          const down = saturate(drop.div(reach));

          // Lateral placement. A plain streak wanders about the middle of the
          // opening; a drip leaves one corner of the casing and stays there.
          // `sin` on the fall is what stops either being a rectangle -- one
          // transcendental, and without it the mark reads as a printed decal at
          // any distance where its edges are still sharp.
          const dxSigned = fract(coord.x.div(bayWidth)).mul(bayWidth).sub(bayWidth.mul(0.5));
          const wander = sin(drop.mul(3.7).add(spin.mul(19.0))).mul(0.028);
          const offset = spin.sub(0.5).mul(mix(float(0.09), float(0.44), hasDrip)).add(wander);
          const trueW = mix(
            halfOpening.mul(float(STAIN.width)),
            float(STAIN.dripWidth),
            hasDrip,
          ).mul(float(1.0).sub(down.mul(STAIN.taper)));

          // Band (d), and the half of this the weathering pass did not have.
          //
          // The `resolves` above fades the streak's *rolls* to their means, so
          // past 229 m every streak on the building is the same streak -- which
          // removes the boiling between windows and was the right call. What it
          // does not remove is the streak itself, which is still a 0.3 m mark
          // laid out on the bay module, and a 0.3 m mark is under a pixel from
          // about 175 m. Verified at tower distances and it does crawl there:
          // low contrast, but it is the only thing left on a distant wall that
          // still has a hard-ish edge in it.
          //
          // So the same widen-and-hold `softLine` puts on a roof's fixing line,
          // on the lateral axis only. That axis is the one that fails first --
          // a streak is 0.55 m across and 0.8 to 2.2 m long, so it goes
          // sub-pixel sideways two to four times sooner than it does vertically
          // -- and holding the area is what keeps a stained wall the same
          // brightness as it recedes, which is the rule the roof path set and
          // the reason the rolls fade to 0.5 rather than the dirt to zero.
          // Starts at 109 m on a plain streak and 40 m on the narrower drip.
          const halfW = max(trueW, pxWall.mul(1.6));
          const held = trueW.div(halfW);

          // Soft-edged, and clean for the first 70 mm: a sill sheds its water
          // over a drip edge before any of it touches the wall, and that gap is
          // most of what separates a stain from a painted-on gradient.
          const across = abs(dxSigned.sub(offset));
          const profile = smoothstep(halfW.mul(0.45), halfW, across).oneMinus().mul(held);
          const lip = smoothstep(float(0.0), float(STAIN.lip), drop);
          const streak = profile.mul(down.oneMinus()).mul(lip).mul(exists);

          const peak = mix(float(STAIN.peak[0]), float(STAIN.dripPeak[0]), hasDrip).add(
            spin.mul(mix(float(STAIN.peak[1] - STAIN.peak[0]), float(STAIN.dripPeak[1] - STAIN.dripPeak[0]), hasDrip)),
          );
          const tint = mix(vec3(...STAIN.tint), vec3(...STAIN.dripTint), hasDrip);
          return vec3(1.0, 1.0, 1.0).sub(tint.mul(streak.mul(peak).mul(age)));
        })();

  /**
   * Rust runs down a corrugated wall, from the fixings holding the sheet on.
   * Spec 7.6's third item. See `WALL_RUST`.
   *
   * A compile-time branch on the one slot that is industrial cladding, so the
   * other eight pipelines carry none of it. Shared between colour, roughness and
   * metalness for the reason the roof path shares its own: oxide is a matte
   * dielectric crust, so wherever it blooms it takes the metal out from under
   * itself, and three slots recomputing the mask would triple it.
   */
  const wallRust =
    slot === 'corrugated_steel'
      ? Fn(() => {
          // Which sheet, and which girt row is above this fragment. Rust runs
          // *down* from a fixing, so the row that matters is the one overhead:
          // that is `1 - fract`, and it makes `fall` zero at the fixing and
          // grow downward without a second modulo.
          const sheet = floor(coord.x.div(float(SHEET_COVER)));
          const rows = coord.y.div(float(WALL_RUST.girt));
          const row = floor(rows).add(1.0);
          const fall = fract(rows).oneMinus().mul(float(WALL_RUST.girt));

          // Which screw in this sheet weeps, and where across the sheet it sits.
          // Hashed by (sheet, row) so the runs never line up into columns --
          // real cladding is fixed on every rib and only some of them fail.
          //
          // Salted with `valueRoll` rather than with the seed itself, for the
          // reason `finishRoof` sets out at length: a raw seed near 65,535 puts
          // `sin()`'s argument at eight million, where fp32 has an ulp of a
          // whole radian and the whole thing is one driver's range reduction
          // away from every warehouse in the city rusting identically.
          const pick = hash21(vec2(sheet, row.add(valueRoll.mul(43.0))));
          // 0.15-0.85 across the sheet: a screw at the very edge would put half
          // its run on the neighbouring sheet, which water cannot cross.
          //
          // HASHED SEPARATELY, and this one was got wrong first and is worth
          // recording alongside the `open`-stream failure on `ROLL_STREAM`,
          // because it is the same rule failing from the other direction.
          //
          // `respin(pick)` looks legal: the position is a lerp, not a
          // threshold. What the rule does not say out loud is that it also
          // depends on how *hard* the parent is thresholded. `respin` is
          // `fract(r * (r + k))`, and over `r` in [0, 0.0138] -- which is this
          // rate on a well-kept shed -- `r * (r + 17.3)` never completes a
          // single wrap, so it is a smooth monotone map and the selected subset
          // lands in a band of it. Measured over 400,000 cells, `respin`'s
          // distribution on that subset:
          //
          //   age 0.3   mean 0.111   range [0.000, 0.237]   KS 0.763
          //   age 1.0   mean 0.386   range [0.000, 0.796]   KS 0.227
          //   age 1.6   mean 0.408   range [0.000, 0.998]   KS 0.185
          //
          // against a second hash on the same cells at mean 0.499-0.503, full
          // range, KS 0.005-0.011. What that first column is on a wall is every
          // rust run on a tidy shed sitting in the left third of its sheet: a
          // column of stains down the elevation at one fixed offset. The marks
          // block below spins rather than hashes and is fine, because its
          // thresholds are 0.17-0.34 and the same map wraps four to eight times
          // across them -- the difference is the rate, not the construction.
          // Five instructions, and there is nothing else it can be.
          const spread = hash21(vec2(sheet.add(53.1), row.add(valueRoll.mul(19.0))));
          const place = float(0.15).add(spread.mul(0.70));
          // Spun off `spread`, which is never thresholded, so the rule applies
          // cleanly here where it did not above.
          const life = respin(spread, 9.7);

          // Density scales with the building's age: 1.4% of fixing cells on a
          // shed somebody still maintains, 7.4% on one nobody has.
          const has = step(pick, float(WALL_RUST.rate).mul(age));

          const along = fract(coord.x.div(float(SHEET_COVER)));
          const width = float(WALL_RUST.width[0]).add(
            saturate(fall.div(float(WALL_RUST.fall[1]))).mul(WALL_RUST.width[1] - WALL_RUST.width[0]),
          );
          const across = abs(along.sub(place).mul(float(SHEET_COVER)));

          const spent = float(WALL_RUST.fall[0]).add(
            life.mul(WALL_RUST.fall[1] - WALL_RUST.fall[0]),
          );
          const down = saturate(fall.div(spent));
          // Faded on the sheet module rather than the run's own width: the run
          // is 25-55 mm and would be gone by twenty metres on its own width,
          // where what actually has to stop is the *pattern* of runs, which is
          // a 762 mm feature. Same argument as `softLine`, arrived at from the
          // other end -- there the line is widened to hold its area, here the
          // whole family fades to nothing on the module it is laid out on.
          //
          // Written in the un-reversed form for the reason `resolves` gives:
          // WGSL leaves `smoothstep(hi, lo, x)` undefined and it is the kind of
          // thing that works on one driver.
          const fade = resolves(SHEET_COVER, pxWall, 0.33, 0.72);
          return smoothstep(width.mul(0.3), width, across)
            .oneMinus()
            .mul(down.oneMinus())
            .mul(has)
            .mul(fade)
            // The age factor reaches this twice: through the rate above, which
            // is how *many* fixings weep, and through here, which is how badly.
            // Compressed, because unlike a stain a rust run is either there or
            // it is not and 5.3x of its alpha would be a run you cannot see
            // beside one that is a red stripe.
            .mul(float(WALL_RUST.peak).mul(float(0.55).add(age.mul(0.35))));
        })()
      : null;

  /**
   * Poster residue and tags on blank ground-storey wall. Spec 7.6's third and
   * fourth items. Returns `vec4(colour, coverage)`, composited like the aircon.
   *
   * Compiled out of curtain wall, where there is no wall at reachable height to
   * put either on.
   */
  const marks =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          // --- Where a mark is allowed to be.
          //
          // Reachable height, a stretch of blank wall, a storey that exists, and
          // one of the archetypes that presents a wall to the street at all.
          // Every one of these is a comparison on something already computed;
          // `fieldDist` in particular is the whole "blank wall" test for free,
          // because it is a signed distance in metres to the nearest opening.
          const low = smoothstep(float(MARKS.top[0]), float(MARKS.top[1]), coord.y).oneMinus();
          const blank = smoothstep(
            float(MARKS.blank[0]),
            float(MARKS.blank[1]),
            fieldDist,
          ).oneMinus();
          const warehouse = step(float(5.5), archetype).mul(step(archetype, float(6.5)));
          const site = low.mul(blank).mul(withinTop).mul(max(lightFramed, warehouse));

          // --- One cell along the wall run, one decision in it.
          //
          // Poster and tag are two bands of a single roll rather than two
          // independent ones, the same construction `dressRoll` uses for
          // blind/curtain/bare: a patch of wall carries one or the other, and
          // making them exclusive by construction is what stops the two shares
          // drifting apart or a tag being drawn over a poster.
          const cellX = coord.x.div(float(MARKS.cell));
          const lx = fract(cellX).sub(0.5).mul(float(MARKS.cell));
          // Salted with `valueRoll`, not the raw seed, for the fp32 argument
          // `finishRoof` makes and `wallRust` above repeats.
          const pick = hash21(vec2(floor(cellX), valueRoll.mul(43.0)));
          // Spun rather than hashed, and here it *is* safe where it was not in
          // `wallRust`: the thresholds below are 0.17-0.34 rather than 0.0138,
          // so `fract(r * (r + 23.9))` completes four to eight wraps across the
          // selected subset. Measured on it, mean 0.479-0.489 and KS 0.035-0.048
          // against uniform, where the rust path's equivalent was KS 0.763.
          const r1 = respin(pick, 23.9);
          const r2 = respin(r1, 11.3);
          // See `MARKS.ageFloor`: a mark is a discrete event, so it takes a
          // shallower curve off the age factor than the continuous grime does.
          const markAge = float(MARKS.ageFloor).add(age.mul(MARKS.ageScale));
          const posterRate = float(MARKS.poster).mul(markAge);
          const hasPoster = step(pick, posterRate);
          const hasTag = step(posterRate, pick).mul(
            step(pick, posterRate.add(float(MARKS.tag).mul(markAge))),
          );

          // --- The poster: a weak pale fill inside a strong grimy rim. The rim
          // is what makes this read on a pale wall at all -- see the measured
          // table on `MARKS` -- and A-series proportions are what goes up on a
          // wall in this city.
          //
          // ONE box and ONE centre height serve both marks, which is legitimate
          // by the argument `curtainRoll` and `grimeRoll` are built on: the two
          // are exclusive per cell by construction, so nothing that couples them
          // can ever be seen in one place. A tag has a bounding box too, and
          // this is it -- so the tag's horizontal bound below is free.
          const pw = float(MARKS.posterW[0]).add(r1.mul(MARKS.posterW[1] - MARKS.posterW[0]));
          const ph = pw.mul(float(MARKS.aspect));
          const cy = coord.y.sub(float(MARKS.centre[0]).add(r2.mul(MARKS.centre[1] - MARKS.centre[0])));
          const box = min(pw.sub(abs(lx)), ph.sub(abs(cy)));
          // The rim is a 40 mm line and the fill's edge a 25 mm one, so both get
          // the widen-and-hold the tag below already carries -- the rim needs it
          // most, because the measured table on `MARKS` says the rim is the half
          // that reads on every wall and the fill only on dark brick. Only the
          // rim is held: a fill is an area, and widening the edge of an area
          // does not change how much of it there is.
          const rimW = max(float(0.04), pxWall.mul(1.6));
          const paper = smoothstep(float(0.0), max(float(0.025), pxWall.mul(1.6)), box).mul(hasPoster);
          const rim = smoothstep(float(0.0), rimW, abs(box))
            .oneMinus()
            .mul(hasPoster)
            .mul(float(0.04).div(rimW));

          // --- The tag: two wandering strokes, and deliberately not text.
          //
          // The cheap construction, and the reason for it. Two true segment
          // SDFs are about forty instructions -- a projection, a clamp and a
          // length each -- for a mark that is below three metres on three
          // archetypes. This is the same two strokes for eleven: one wander
          // built from two sines, evaluated as a vertical distance, read twice
          // -- once as itself and once inverted, shortened and offset, so the
          // two curves genuinely cross instead of running parallel. Parallel
          // was the first version and it reads as a double underline; a tag is
          // a tangle, and one `mul` is what buys the crossing.
          //
          // The vertical-distance approximation *thickens* the stroke where the
          // wander is steep. On a marker line that is right rather than wrong.
          //
          // Never legible, and it must not become legible: this is grime that
          // says somebody was here, not signage.
          const phase = lx.mul(float(MARKS.wanderK)).add(r2.mul(21.0));
          const wander = sin(phase)
            .mul(0.055)
            .add(sin(phase.mul(2.7)).mul(0.028));
          const strokeA = abs(cy.sub(wander));
          const strokeB = abs(cy.add(wander.mul(0.55)).sub(0.06));
          // Bounded by the same box the poster would have filled, so the stroke
          // cannot run the whole 2.6 m cell and read as a stripe. 0.4-0.7 m wide,
          // which is the 0.3-0.8 m the spec asks for.
          const within = smoothstep(float(0.0), float(0.03), box);
          // Area-preserving fade, the `softLine` construction: the stroke is
          // widened to the pixel footprint and its contrast cut by exactly the
          // factor it was widened, so as it goes sub-pixel it converges on a
          // uniform faint darkening rather than switching on and off with the
          // sampling grid. Written out rather than calling `softLine` because
          // the strength here is a node -- it carries the age factor -- and
          // that helper takes a compile-time constant.
          const sw = max(float(MARKS.stroke), pxWall.mul(1.6));
          const held = float(MARKS.stroke).div(sw);
          const tag = smoothstep(sw.mul(0.25), sw, min(strokeA, strokeB))
            .oneMinus()
            .mul(within)
            .mul(hasTag)
            .mul(held);

          const inkAlpha = float(MARKS.inkAlpha).mul(markAge);
          // One composite, three marks, and no divisions in it. The rim is the
          // *edge* of the fill so it sits on top of it wherever the two meet;
          // the tag is in a different cell of the same lattice by construction
          // and can never share a fragment with either.
          const colour = vec3(...MARKS.paper).toVar();
          colour.assign(mix(colour, vec3(...MARKS.rim), rim));
          colour.assign(mix(colour, vec3(...MARKS.ink), tag));
          const cover = max(
            max(paper, rim).mul(float(MARKS.posterAlpha)).mul(markAge),
            tag.mul(inkAlpha),
          );
          return vec4(colour, saturate(cover).mul(site));
        })();

  /**
   * The fanlight over a terrace or federation front door, as an area mask.
   *
   * Its own node rather than a fifth component on the door's vec4, because two
   * output slots need it and neither can get it from the other: the colour path
   * paints a dark hall behind it, and the emissive path both reflects the sky
   * off it by day and lights it at night. Twelve instructions, against a second
   * evaluation of the whole door assembly to carry one number out -- the same
   * trade the meeting rail's comment in `frameNode` makes at nine.
   *
   * Everything it reads is hoisted, so the geometry is shared with the door
   * itself rather than rebuilt: `doorAcross`, `doorFanBottom`, `doorFanTop` and
   * `doorTransom` are one node object each.
   *
   * Compiled out of the curtain-wall pipeline with the door itself. A building
   * whose walls are curtain wall never gets a door at all (`mesh`'s
   * `DOOR_EXCLUDE_MATERIALS`), so this would be a branch that can never be taken.
   */
  const doorGlass =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          const co = uv();
          const inside = min(
            doorLeafHalf.sub(doorAcross),
            min(co.y.sub(doorFanBottom), doorFanTop.sub(co.y)),
          );
          // One pixel of edge, which is antialiasing rather than a fade: a
          // fanlight is a single 0.82 x 0.34 m rectangle and has no period to
          // alias against. What it converges on as it goes sub-pixel is a soft
          // patch holding roughly its own area, which is correct.
          return smoothstep(float(0.0), pxWall.mul(1.6), inside)
            .mul(doorTransom)
            .mul(hasDoor);
        })();

  /**
   * The front door itself, as `vec4(colour, coverage)` -- the same shape
   * `flatRoof`, `aircon` and `marks` return, composited the same way.
   *
   * DRAWN AT `uv()`, NOT AT `coord`, and that is the whole of what makes it a
   * door rather than a picture of one. `surface` offsets its coordinate only
   * where `frameNode.z` says the fragment is inside a window opening, and the
   * suppression in `windowField` is what makes that false everywhere the door
   * stands -- so inside the door's own span the two coordinates are identical
   * and this could read either. It reads the wall plane explicitly because the
   * architrave, the leaf and the threshold all stand *in front of* the wall, and
   * anything at the wall plane that slides with the viewer reads as a decal.
   *
   * The recess is drawn instead: `reveal` ramps the leaf and the fanlight from
   * `revealShade` hard against the architrave to full in the middle of the leaf,
   * which is the same construction the window reveal uses and the same thing
   * that sells it there.
   *
   * WHAT DISSOLVES AND HOW. Three members are lines rather than areas -- the
   * 90 mm architrave, the 60 mm threshold and the 14 mm panel mouldings -- and
   * all three take `softLine`'s widen-and-hold in the form `frameNode` uses it:
   * widened to the pixel footprint, contrast cut by exactly the factor they were
   * widened, so the area under each is held and they converge on a uniform faint
   * tint instead of switching on and off with the sampling grid. That matters
   * more here than it does on a window: without it a door dissolving into the
   * distance goes *bright*, because the architrave is the palest thing in the
   * assembly and 82% of the leaf is the darkest, and a city of doors turning
   * into pale smudges at 200 m would be worse than no doors at all.
   *
   * The leaf and the fanlight are areas, so they take a plain one-pixel
   * antialiased edge. A door is one object per building rather than a repeating
   * module, so there is nothing here with a period to alias against; the failure
   * mode this pass has to avoid is drift in the *mean*, not shimmer.
   */
  const door =
    slot === 'curtain_wall'
      ? null
      : Fn(() => {
          const co = uv();
          const pw = pxWall.mul(1.6);

          // The opening: architrave to architrave, and the ground to the head.
          // The bottom is v = 0 rather than the top of the threshold, because
          // the step is part of the assembly and stands on the pad -- and
          // below v = 0, down the skirt, the flight of steps that reaches it.
          // See `steps` below; `DOOR.stepsDown` is how far they go.
          const cover = smoothstep(
            float(0.0),
            pw,
            min(doorHalf.sub(doorAcross), min(co.y.add(float(DOOR.stepsDown)), doorTop.sub(co.y))),
          ).mul(hasDoor);

          // The leaf: 820 mm wide on a house, which is the standard leaf and
          // falls out of the opening rather than being decreed -- see `DOOR`.
          const leaf = smoothstep(
            float(0.0),
            pw,
            min(
              doorLeafHalf.sub(doorAcross),
              min(co.y.sub(float(DOOR.step)), doorLeafTop.sub(co.y)),
            ),
          );

          // The reveal, over the whole sash area so the fanlight is set back
          // with the leaf. Its top is the fanlight's where there is one.
          const sashTop = mix(doorLeafTop, doorFanTop, doorTransom);
          const sash = min(
            doorLeafHalf.sub(doorAcross),
            min(co.y.sub(float(DOOR.step)), sashTop.sub(co.y)),
          );
          const reveal = mix(
            float(DOOR.revealShade),
            float(1.0),
            saturate(sash.div(float(DOOR.reveal))),
          );

          // --- Four sunk panels, two columns by two rows, in a stile-and-rail
          // frame. `cx` is metres from the centre line of whichever column this
          // fragment is in and `cy` metres from the centre of whichever row, so
          // one distance serves all four panels and there is no cell hash and no
          // branch anywhere in it.
          const leafH = doorLeafTop.sub(float(DOOR.step));
          const colHalf = doorLeafHalf.mul(0.5);
          const rowHalf = leafH.mul(0.25);
          const cx = abs(doorAcross.sub(colHalf));
          const cy = abs(
            fract(co.y.sub(float(DOOR.step)).div(rowHalf.mul(2.0)))
              .mul(rowHalf.mul(2.0))
              .sub(rowHalf),
          );
          const panel = min(
            colHalf.sub(float(DOOR.stile)).sub(cx),
            rowHalf.sub(float(DOOR.rail)).sub(cy),
          );
          const wMould = max(float(DOOR.moulding), pw);
          const groove = smoothstep(float(0.0), wMould, abs(panel))
            .oneMinus()
            .mul(float(DOOR.moulding).div(wMould));
          // The panel field itself is an area, not a line, so it takes an
          // antialiased edge rather than the widen-and-hold: widening the edge
          // of an area does not change how much of it there is. Same call the
          // poster's fill makes in `marks`.
          const sunk = smoothstep(float(0.0), max(float(0.042), pw), panel);

          // --- Composite, in the order the carpenter worked in.
          //
          // Leaf first, because it is 82% of the assembly and therefore what the
          // whole thing has to converge on at distance; then the fanlight; then
          // the architrave over both, held; then the threshold at the foot.
          const tone = palette(
            DOOR_PALETTE,
            buildingRoll(seedLo, seedHi, BUILDING_STRIDES.door),
          );
          const colour = tone
            .mul(reveal)
            .mul(float(1.0).sub(groove.mul(0.38)))
            .mul(float(1.0).sub(sunk.mul(float(DOOR.panelSink))))
            .toVar();
          colour.assign(mix(frameColour, colour, leaf));

          // The fanlight: the same hall the windows above it look into, seen
          // through glass that loses exactly what its reflection gains. The
          // reflection itself is emissive and is added in the emissive slot,
          // which is where a window's is and for the reason `glazing` sets out
          // at length -- reflected radiance does not care what irradiance this
          // wall is receiving.
          if (doorGlass) {
            colour.assign(
              mix(
                colour,
                mix(interiorDark, interiorLit, lit).mul(glazing.w.oneMinus()).mul(reveal),
                doorGlass,
              ),
            );
          }

          // The architrave: a band inside the opening on the JAMBS AND THE HEAD
          // and not across the bottom, where a door meets its threshold and
          // there is no architrave in life.
          const wArch = max(float(DOOR.architrave), pw);
          const arch = smoothstep(
            wArch.sub(pw),
            wArch,
            min(doorHalf.sub(doorAcross), doorTop.sub(co.y)),
          )
            .oneMinus()
            .mul(float(DOOR.architrave).div(wArch));
          colour.assign(mix(colour, frameColour, arch));

          // The threshold. Sandstone on the pre-war stock and concrete since,
          // and one tone for both because at 60 mm across a footpath they are
          // the same worn pale line -- which is the point of it: it is the cue
          // the eye reads as "a way in" before it has resolved anything else.
          const wStep = max(float(DOOR.step), pw);
          const stepBand = smoothstep(wStep.sub(pw), wStep, co.y)
            .oneMinus()
            .mul(float(DOOR.step).div(wStep));
          colour.assign(mix(colour, vec3(...DOOR.threshold), stepBand));

          // --- The steps, below the pad. The owner's "doors appear in air":
          // a pad is one height for the whole building and on a sloping
          // block the downhill wall stands on its skirt, so the door sat a
          // metre up a blank masonry base. What a Sydney house has there is a
          // flight of sandstone steps from the footpath to the threshold, and
          // that is what is drawn: treads at `DOOR.riser` down the skirt
          // inside the door's own width, each riser a shaded line, the whole
          // thing the threshold's stone. Where the ground is at the pad the
          // terrain buries the flight and nothing shows, which is the right
          // answer for the four fifths of doors that were never in the air.
          const below = step(co.y, float(0.0)).mul(step(float(-DOOR.stepsDown), co.y));
          const inFlight = below.mul(step(doorAcross, doorHalf.add(float(DOOR.stepsSide))));
          const riserT = fract(co.y.negate().div(float(DOOR.riser)));
          const wRiser = max(float(0.02), pw.div(float(DOOR.riser)));
          const riserLine = smoothstep(float(0.0), wRiser, riserT).mul(smoothstep(float(1.0), float(1.0).sub(wRiser), riserT)).oneMinus();
          const treadShade = mix(float(1.0), float(0.55), riserLine);
          // A tread is sunlit from above; the riser under it is not. Nine
          // tenths of the height of each step is the riser face, drawn a
          // little darker so the flight reads as steps and not stripes.
          const riserFace = smoothstep(float(0.08), float(0.2), riserT).mul(0.18);
          const stone = vec3(...DOOR.threshold).mul(1.12).mul(treadShade).mul(float(1.0).sub(riserFace));
          colour.assign(mix(colour, stone, inFlight));

          return vec4(colour, cover);
        })();

  /**
   * The flat roof caps that share this slot with the walls, or nothing at all.
   *
   * A compile-time branch, like the curtain wall's tint in `glazing`, so the
   * other eight facade pipelines do not carry a single instruction of it. Only
   * `concrete_precast` is both a wall material and a roof material -- see
   * `mesh.ROOF_MATERIAL`, where brutalist, tower and modern_infill all cap out
   * in precast -- so it is the only slot where a fragment's own normal has to
   * decide which of the two it is looking at. Carries the mask in `w`.
   */
  const flatRoof = slot === 'concrete_precast' ? flatRoofNode() : null;

  // Which of the two wall treatments this pipeline compiles. Both are decided
  // once per slot at graph-build time, so a brick pipeline carries no palette
  // chain and a painted one carries no mortar.
  const isBrick = slot.startsWith('brick');
  const isPainted = slot === 'render_painted';

  // --- Colour --------------------------------------------------------------
  material.colorNode = Fn(() => {
    // --- Wall
    //
    // The seed's two bytes, exact in fp32, feed three uncorrelated identities and
    // -- through one more quadratic round -- the weathering age. See
    // `buildingRoll` for why the split is where it is; `seedLo`, `seedHi` and
    // `valueRoll` are now hoisted to the factory scope because the weathering
    // needs the age factor in the roughness and metalness slots too.

    // What colour this building was painted, if it is painted at all. Everything
    // else takes the one albedo its slot is named for -- there is no palette for
    // brick because the three brick slots *are* the palette, chosen per building
    // by the pipeline's weighted draw rather than here.
    const wallBase = isPainted
      ? paintColour(buildingRoll(seedLo, seedHi, BUILDING_STRIDES.paint))
      : vec3(...look.colour);

    // Per-building value, so a street of one material is not a single flat
    // colour: kiln batch on brick, fade and repaint history on paint. Wider on
    // brick, because brick has no palette to carry the variety for it.
    const spread = isBrick ? TINT_SPREAD.brick : TINT_SPREAD.other;
    const tint = valueRoll.sub(0.5).mul(2 * spread).add(1.0);

    // Course module: a 76 mm brick on a 10 mm bed, or a 300 mm board/panel.
    const courseH = isBrick ? float(0.086) : float(0.30);
    // 1 in the joint, 0 on the face. Kept as a mask rather than folded straight
    // into a multiplier because the brick path needs to put a *colour* there.
    const jointMask = smoothstep(float(0.0), float(0.10), fract(coord.y.div(courseH))).oneMinus();
    const grain = hash21(floor(vec2(coord.x.div(0.24), coord.y.div(courseH)))).mul(0.10).sub(0.05);
    // Vertical soiling: rain washes the top, dirt collects lower down. Spec
    // section 7.6 wants real effort here and this is the cheapest large win.
    const soil = smoothstep(float(0.0), float(9.0), coord.y).mul(0.16).add(0.84);

    // The joint. On brick it is mortar -- a different material, of a colour this
    // building's bricklayer mixed once, so it goes in as a colour rather than as
    // a shadow; a pale lime joint comes out *brighter* than the brick around it,
    // which is precisely what a Federation wall looks like and what a value
    // multiplier can never produce. Everything else keeps the plain darkening it
    // had, which is all a panel joint or a board lap is.
    const face = wallBase.mul(tint);
    const jointed = isBrick
      ? mix(
          face,
          mix(
            vec3(...MORTAR.raked),
            vec3(...MORTAR.lime),
            buildingRoll(seedLo, seedHi, BUILDING_STRIDES.mortar),
          ),
          jointMask.mul(MORTAR_JOINT_MIX),
        )
      : face.mul(float(1.0).sub(jointMask.mul(0.16)));
    const wall = vec3(jointed.mul(soil).add(vec3(grain))).toVar();

    // Wall signage above the awning line on retail strips (spec 7.7).
    //
    // This band used to BE the awning. It ran 3.2 to 4.3 m at 0.85 alpha and was
    // a picture of one: a painted stripe standing in for a canopy, because there
    // was no canopy. There is now -- `mesh.AwningNetwork` hangs a real 450 mm
    // slab off every street-facing retail edge at exactly 3.2 m, and
    // `world/awning.ts` paints its fascia per shop -- so this band is no longer
    // the signage. It is the wall BEHIND the signage.
    //
    // Two changes, and both follow from that. It moves up to start at 3.5 m,
    // above the top of the slab at 3.65 m less the overlap that keeps a hairline
    // from opening between the two on a short building where the awning drops to
    // 0.75 of the height. And its alpha halves, because what is left of it is
    // the ghost of a painted-out shop name on the wall over the canopy -- which
    // every Sydney retail strip has and which is a stain, not a sign.
    //
    // On red brick at coord.y = 4.0, through the chain in `sky/calibration.ts`,
    // before -> after:
    //
    //   sunlit   rgb(105,  75,  74) Y'  82  ->  rgb(136,  84,  73) Y'  95
    //   shaded   rgb( 42,  25,  27) Y'  30  ->  rgb( 70,  33,  22) Y'  40
    //
    // Thirteen and ten code values back toward the wall's own colour, which is
    // what "sits behind the awning" has to look like. Below 3.5 m the band is
    // simply gone, and what is there instead is 450 mm of painted fascia in
    // front of it.
    const signBand = step(float(3.5), coord.y).mul(step(coord.y, float(4.3))).mul(isRetail);
    const signColour = mix(vec3(0.10, 0.12, 0.16), vec3(0.42, 0.10, 0.12), hash21(vec2(seed, 9.1)));
    wall.assign(mix(wall, signColour, signBand.mul(0.42)));

    // Plinth: the darker, wetter band at the base of every masonry wall.
    const plinth = float(1.0).sub(smoothstep(float(0.0), float(0.65), coord.y).oneMinus().mul(0.32));
    // ...and a shorter, deeper toe inside it, which is the wall's half of the
    // contact shadow the ground now carries (`world/contact.ts`). The two have
    // to be one gradient or they read as two effects that happen to meet: the
    // skirt floats 17 cm, so parallax puts the dark end of *its* ramp on the
    // bottom 17 cm of this wall, and without a toe the wall would be lighter
    // there than the ground beside it -- the one ordering a wall base never has.
    //
    // 0.4 m and 0.12 keep it inside the plinth in both reach and depth, so this
    // stays a modulation of an existing curve rather than a second band. Through
    // the chain at the top of `sky/calibration.ts`, on red brick at co.y = 0.1
    // (brick face, no per-building tint), before -> after:
    //
    //   sunlit   rgb(132, 68, 50) Y' 80  ->  rgb(124, 63, 44) Y' 75
    //   shaded   rgb( 78, 30,  9) Y' 39  ->  rgb( 74, 28,  7) Y' 36
    //
    // Five code values and three. At co.y = 0 it is seven and four; by 0.4 m it
    // is exactly nothing, which is the property that matters -- a toe that
    // reached as far as the plinth would just be a deeper plinth.
    const toe = float(1.0).sub(smoothstep(float(0.0), float(0.4), coord.y).oneMinus().mul(0.12));
    wall.assign(wall.mul(plinth).mul(toe));

    // --- Weathering, last on the wall. Spec section 7.6.
    //
    // Order within the block is the order the marks physically went on: water
    // has been running off the sills since the building was finished, the rust
    // started when the first washer perished, and the posters and the tags went
    // up on top of both last week. Nothing here is masked to the wall by hand --
    // the glazing composite below replaces all of it inside an opening and the
    // joinery composite replaces it again on a frame, which is exactly right:
    // dirt is on the wall, and a window is not the wall.
    if (sillStain) wall.assign(wall.mul(sillStain));
    // Iron oxide is a different material sitting on the steel, so it is mixed
    // towards `RUST` rather than multiplied into the sheet -- the same argument
    // and the same albedo the roof path uses, because it is the same oxide on
    // the same building.
    if (wallRust) wall.assign(mix(wall, vec3(...RUST), wallRust));
    if (marks) wall.assign(mix(wall, marks.xyz, marks.w));

    // --- Glazing
    //
    // The lit and unlit room are hoisted to the factory scope, because the front
    // door's fanlight looks into the same hall and the two must be the same
    // room. The blue tint that used to stand in for a sky reflection is gone --
    // `glazing` above does the height gradient properly, out of the mirror
    // direction -- so what is left in `interiorDark` is only the transmitted
    // term. See where both are built.
    const glass = vec3(mix(interiorDark, interiorLit, lit)).toVar();

    // Blinds, curtains and open sashes. Only meaningful at residential scale,
    // so curtain wall skips the lot.
    if (windowLife) {
      // The fabric, and the one expression that carries the whole day/night
      // join. `lit` is already zero by day -- it has `nightFactor` as a factor
      // -- so at nightFactor 1 this is `0.35 + lit*0.8`, character for
      // character what has always been here, and at 0 it is a plain daytime
      // albedo lit by whatever the wall is receiving. One `mix`, no branch, and
      // nothing after dark moves by a code value. See BLIND_DAY_LEVEL.
      const blindColour = mix(vec3(0.86, 0.84, 0.78), vec3(0.62, 0.58, 0.52), fabricRoll);
      const fabric = mix(float(BLIND_DAY_LEVEL), float(0.35), globals.nightFactor).add(
        lit.mul(0.8),
      );
      glass.assign(mix(glass, blindColour.mul(fabric), windowLife.x.mul(0.9)));

      // Where the lower sash used to be there is no glass, so there is nothing
      // to tint and nothing to reflect -- just a room, seen directly. Deeper
      // after dark, and leaking a little if the room is lit. See OPEN_SASH.
      const hole = vec3(...OPEN_SASH.interior)
        .mul(globals.nightFactor.mul(OPEN_SASH.nightDeepen).oneMinus())
        .add(interiorLit.mul(lit).mul(float(OPEN_SASH.nightLeak)));
      glass.assign(mix(glass, hole, windowLife.y));
    }
    // Shopfront interiors are bright and busy at street level, day or night.
    glass.assign(mix(glass, glass.add(vec3(0.22, 0.20, 0.17)), shopfront));

    // Everything above is seen *through* the glass, so it loses exactly what the
    // reflection gains. It matters most where it is largest: a window at grazing
    // incidence is a mirror, and a blind behind it has to disappear under the
    // reflection rather than glow through it.
    glass.assign(glass.mul(glazing.w.oneMinus()));

    const opening = mix(wall, glass.mul(revealShade), inWindow);

    // --- Joinery, composited last because it stands in front of both.
    //
    // `frameColour` is hoisted -- see there for what the two tones are and why
    // the painted one sits above `render_painted`. Soiling is shared with the
    // wall: joinery weathers with the building, and a frame that stays clean
    // while the wall below it streaks reads as a sticker.
    const facade = mix(opening, frameColour.mul(frameNode.y).mul(soil), frameMask);

    // The box unit, over the joinery because it hangs in front of it -- a
    // through-wall unit in a walk-up's slider covers the mullion behind it, and
    // that is what makes it read as an object rather than a decal. Soiled with
    // the wall for exactly the argument the frame above makes: an appliance
    // that stays clean while the wall it is bolted to streaks is a sticker.
    const hung = aircon ? mix(facade, aircon.xyz.mul(soil), aircon.w) : facade;

    // The front door, over everything on the wall, and last of the wall
    // features for two reasons. It replaces rather than decorates: within its
    // own span the window, the joinery and the reveal have all been suppressed
    // upstream, so there is nothing under it that should show through. And an
    // aircon box is placed off the bay geometry alone rather than off the window
    // field, so on the ground storey of a walk-up one could otherwise be drawn
    // hanging in the middle of the doorway.
    //
    // Soiled with the wall, on exactly the argument the frame above makes: a
    // door weathers with the building it is in, and one that stays clean while
    // the wall around it streaks is a sticker.
    const doored = door ? mix(hung, door.xyz.mul(soil), door.w) : hung;

    // Everything above was computed against a wall's coordinate system, which on
    // an up-facing cap means nothing at all. Composited last and by the normal,
    // so the wall path is bit-for-bit what it was.
    return flatRoof ? mix(doored, flatRoof.xyz, flatRoof.w) : doored;
  })();

  // --- Surface response ----------------------------------------------------
  // Glass roughness is keyed to the building's glazing type, so CBD curtain wall
  // is near-mirror and a Federation sash window is not. The frame overrides both,
  // because the joinery in front of the glass is not glass: semi-gloss enamel on
  // timber holds a broad sheen, anodised aluminium a tighter one, and only the
  // aluminium is a conductor. Leave it reading as glass and a white timber sash
  // frame takes the sun's specular like a mirror, which is the one thing that
  // would undo the frame's whole job of looking solid.
  //
  // Shopfront plate glass is smoother than anything the building it sits under
  // is made of, so it takes its own multiplier -- that is what lets a shop window
  // catch the sun as a hard flash while the sashes two storeys above it do not.
  const glassRoughness = float(1.0)
    .sub(reflectivity)
    .mul(0.35)
    .add(0.02)
    .mul(mix(float(1.0), float(0.35), shopfront));
  const wallRoughness = mix(
    mix(float(look.roughness), glassRoughness, inWindow),
    mix(float(0.38), float(0.55), frameNode.w),
    frameMask,
  );
  const wallMetalness = mix(
    mix(float(look.metalness), reflectivity.mul(0.6), inWindow),
    frameNode.w.oneMinus().mul(0.55),
    frameMask,
  );
  // A powder-coated appliance casing is neither masonry nor glass: semi-gloss
  // enamel that chalked out a decade ago, and painted steel that reads as a
  // dielectric however much metal is under the paint. Without this a walk-up's
  // through-wall unit inherits the *glass* response it is standing in front of
  // and takes the sun's specular like a mirror -- a chrome box in a window,
  // which is the one way this feature could look worse than not having it.
  const plantRoughness = aircon ? mix(wallRoughness, float(0.62), aircon.w) : wallRoughness;
  const plantMetalness = aircon ? wallMetalness.mul(aircon.w.oneMinus()) : wallMetalness;
  // Rust is a matte dielectric crust, so wherever it blooms it takes the metal
  // out from under itself. Exactly what `finishSteelRoof` does with the same
  // mask on the same oxide, and the reason it matters more on a wall than it
  // sounds: `corrugated_steel` carries metalness 0.30, and a rust run left
  // conductive would flare at the sun in the one place the sheet is supposed to
  // look eaten. Masked to the wall by `inWindow`, so a steel window in a
  // warehouse elevation keeps its glass response.
  const rusted = wallRust ? wallRust.mul(inWindow.oneMinus()) : null;
  const crustRoughness = rusted ? mix(plantRoughness, float(0.95), rusted) : plantRoughness;
  const crustMetalness = rusted ? plantMetalness.mul(rusted.oneMinus()) : plantMetalness;
  // A front door is semi-gloss enamel on timber, which sits between the frame's
  // two families and is a dielectric whatever it is painted -- so the whole
  // assembly takes the joinery response and drops the metalness the wall behind
  // it may have carried. A door that inherited `corrugated_steel`'s 0.30 would
  // flare at the sun like a sheet of tin, which is the one way this feature
  // could look worse than not having it (the same trap `plantMetalness` above
  // documents for the aircon casing).
  //
  // The fanlight is the exception in both slots, and takes exactly what a window
  // takes: smooth glass with a metalness keyed to the building's glazing type.
  const doorRoughness =
    door && doorGlass
      ? mix(crustRoughness, mix(float(DOOR.roughness), glassRoughness, doorGlass), door.w)
      : crustRoughness;
  const doorMetalness =
    door && doorGlass
      ? mix(crustMetalness, reflectivity.mul(0.6).mul(doorGlass), door.w)
      : crustMetalness;
  // A weathered membrane or a gravel ballast is the roughest thing on a
  // commercial building and nothing on a roof is a conductor. The mask is the
  // same one the colour used, so the two can never disagree about where the roof
  // starts.
  material.roughnessNode = flatRoof ? mix(doorRoughness, float(0.94), flatRoof.w) : doorRoughness;
  material.metalnessNode = flatRoof ? doorMetalness.mul(flatRoof.w.oneMinus()) : doorMetalness;

  // Two things leave a window without being lit by this wall.
  //
  // Lit interiors, which are what makes the night skyline read at distance --
  // unchanged, and still the loudest thing in frame after dark.
  //
  // And the sky, reflected. It is added here rather than tinted into the albedo
  // for the reason spelled out on `glazing`: reflected radiance does not care
  // what irradiance this wall is receiving, and putting it anywhere else makes
  // shaded windows go dark with their wall, which is the black-hole read this
  // whole pass exists to kill. Both are masked to the glass only, so the frame
  // neither reflects the sky by day nor glows by night -- after dark it is a dark
  // silhouette against a lit interior, which is exactly what a window frame is.
  //
  // Night, on the same chain (fill (0.058, 0.064, 0.075), `KeyN` at 21:30):
  //
  //   brick wall             rgb(  5,   1,   0)
  //   unlit glass            rgb(  0,   0,   0)   -- no sky left to reflect
  //   painted frame          rgb(  1,   3,   6)   -- the silhouette
  //   lit window             rgb(193, 164, 121)   -- unchanged by this pass
  //   lit behind a blind     rgb(192, 164, 122)   -- unchanged by this pass
  //   aircon casing          rgb(  1,   2,   6)   -- a dark box, no emission
  //   open sash, unlit       rgb(  0,   0,   0)   -- deeper than unlit glass
  //   open sash, lit         rgb(101,  82,  48)   -- the leak, at 30%
  //
  // Which is spec 6.4's night exactly: the silhouette and the lit windows carry
  // the image and nothing else does.

  /**
   * Per-window grime, applied here and nowhere else.
   *
   * It goes on the *reflection* rather than on the albedo or the roughness
   * because that is what a film of dirt actually does to a window at street
   * distance -- the transmitted term is 4% of a dark room either way, and the
   * roughness is what decides whether the sun draws a hard flash on it, which a
   * clean window and a dirty one both do. `glazing.w` is left alone for the
   * same reason: whatever is behind the glass still loses exactly what the
   * reflection *would* have gained, so the two slots cannot drift apart.
   *
   * Applies on every slot including curtain wall, where it is worth the most: a
   * tower is nothing but this reflection, and a tower whose every pane returns
   * the identical sky is the flattest surface in the city.
   */
  const grime = float(1 - GRIME.spread).add(grimeRoll.mul(2 * GRIME.spread));
  const filmed = glazing.xyz.mul(grime);
  const reflected = mix(
    filmed,
    vec3(dot(filmed, vec3(0.2126, 0.7152, 0.0722))),
    grimeRoll.oneMinus().mul(float(GRIME.desaturate)),
  );

  /**
   * What the window's own life does to that reflection: a covering dims it
   * slightly, a raised sash removes it outright, and the upper pane of that same
   * window gets it close to twice over. All three are `mix`es on masks that are
   * zero for a plain window, so the 40% of windows showing bare glass come out
   * of here bit-for-bit what they were.
   */
  const reflectionGain = windowLife
    ? mix(float(1.0), float(BLIND_REFLECTION_DIM), windowLife.x)
        .mul(windowLife.y.oneMinus())
        .mul(mix(float(1.0), float(OPEN_SASH.upperGain), windowLife.z))
    : float(1.0);

  // A box in the opening blocks both the reflection and the glow behind it.
  const glazed = aircon ? glassArea.mul(aircon.w.oneMinus()) : glassArea;

  // A lit room seen through a raised sash leaks rather than glows: you are
  // looking at a ceiling and a side wall, not at the fitting. 1 everywhere
  // else, so no closed window's night value moves.
  const litThrough = windowLife
    ? windowLife.y.mul(1 - OPEN_SASH.nightLeak).oneMinus()
    : float(1.0);

  /**
   * The fanlight over a front door, on both counts a window: it reflects the sky
   * by day and it joins the lit-window lottery at night.
   *
   * KEYED TO `lit`, WHICH IS THE ROLL OF ITS OWN CELL and not a second draw. The
   * door stands on storey 0 of one bay, and `litRoll` is hashed over exactly
   * `(bayIdx, storeyIdx, seed)` -- so a lit fanlight is a lit *room*, the same
   * room the window on the storey above would be lit from, and it inherits the
   * grid-band fade with it rather than needing one of its own.
   *
   * THE LEAF EMITS NOTHING, which is the whole of the night treatment for the
   * rest of the door. After dark a painted timber door is a silhouette at
   * rgb(1, 1, 2) against a brick wall at rgb(5, 1, 0), and a lit fanlight over
   * it at rgb(179, 152, 111) -- against the lit window above at rgb(192, 164,
   * 121), which is the same light at `glassReveal` of it, because a fanlight
   * sits at the back of the same reveal and sees the same slot of sky.
   */
  const fanlight = doorGlass
    ? vec3(1.0, 0.72, 0.40)
        .mul(doorGlass.mul(lit).mul(0.9))
        .add(reflected.mul(doorGlass))
        .mul(float(DOOR.glassReveal))
    : null;

  const emissive = vec3(1.0, 0.72, 0.40)
    .mul(glazed.mul(lit).mul(0.9).mul(litThrough))
    .add(reflected.mul(glazed).mul(revealShade).mul(reflectionGain));
  material.emissiveNode = fanlight ? emissive.add(fanlight) : emissive;

  return material;
}

/* ---------------------------------------------------------------------------
 * Roofs. Spec section 7.4: "enormous screen area in any game with verticality
 * ... get roof material right before spending effort anywhere else."
 *
 * WHAT THE ROOF UVs ACTUALLY ARE, because everything below turns on it.
 * `mesh.build_roof` emits roof surfaces through two paths that do not share a
 * UV space, and both land on the same material:
 *
 *   `add_triangle_soup` -- flat and parapet caps, and the triangular hip ends
 *   and gable ends. Its UV *is* the vertex's own local XZ in metres. u and v
 *   are compass directions. There is no eave, no ridge and no fall in them.
 *
 *   `add_quad` -- skillion, sawtooth, and the two main slopes of a hip or
 *   gable, in the footprint's oriented-rectangle frame:
 *       u   metres along the long axis, 0 .. 2*half_long
 *           (a sawtooth restarts u at every tooth)
 *       v   metres from the EAVE, up the fall line, 0 .. half_short on a hip
 *           or gable and 0 .. 2*half_short on a skillion or sawtooth
 *
 * Two consequences run through the whole file below.
 *
 * First, v = 0 is the eave on every pitched form and that is reliable, so the
 * gutter shadow and the eave rust have a coordinate to key off. The RIDGE is
 * not visible to a fragment: it sits at half_short, and while that number IS now
 * in the parameter record -- texel 3 slot 4, written by `mesh.build_roof`, see
 * the note where the record is unpacked above -- nothing here reads it, because
 * the ridge stopped needing a shader. There is no screen-space substitute; the
 * ridge is a geometric seam between two quads that never share a fragment, and
 * the normal is constant across each slope, so nothing local to a fragment says
 * "the roof peaks here". The roofline pass answered that with GEOMETRY instead:
 * `mesh._ridge_caps` emits a real capping roll along the ridge and the four hip
 * lines, in this same material and this same UV space, so the sheet columns and
 * tile courses below run across it unbroken. A shaded ridge would now have to
 * beat six triangles, which is a harder test than the one it was set.
 *
 * Two more consequences of that pass, since everything below reads UVs:
 *
 *   The pitched planes now OVERSAIL the walls by 0.45 m on every side, so v
 *   still starts at 0 on the eave -- which is what matters here -- but the eave
 *   is 0.45 m outboard of the wall and 0.18 m lower than it used to be. Nothing
 *   in this file has to change for that; the eave-keyed effects follow it.
 *
 *   The fascia, the parapet capping and the chimneys are NOT on this material.
 *   They land in `render_painted`, `concrete_precast` and the brick slots and
 *   are shaded by the wall path above, carrying a v placed just past the
 *   building's head so the window field can never open on them.
 *
 * Second, both UV spaces are in METRES, so every modulo pattern below -- sheet
 * columns, rib pitch, fixing rows, tile courses -- is physical and reads at the
 * right scale in both. Only the two eave-relative effects need to know which
 * space they are in, and `onSlope` is how they find out.
 * ------------------------------------------------------------------------- */

/**
 * Corrugated sheet, AS 1562 profile: 76 mm rib pitch on 762 mm of cover width.
 *
 * These two numbers are the whole design. The ribs are the close-range read and
 * they are gone by thirty metres -- at 0.75 render scale a 76 mm feature is
 * under two pixels well before that, which is why the old `sin()` corrugation
 * was invisible everywhere except under the player's feet. The 762 mm sheet is
 * what carries the distance: sheets are laid side by side and weather
 * independently, so a corrugated roof at two hundred metres is a set of vertical
 * bands of slightly different value, and nothing else.
 */
const RIB_PITCH = 0.076;
const SHEET_COVER = 0.762;

/**
 * Batten and purlin spacing, and so the spacing of the rows of fixings across
 * every sheet. One of exactly two places rust starts on a Sydney roof: each
 * screw is a hole punched through the zinc with a rubber washer that perished
 * two decades ago. The other is the cut end of the sheet, below.
 */
const FIXING_SPACING = 0.9;

/**
 * A run of roofing is laid in lengths, and 7.2 m is a common one. Both ends of
 * every length are shear-cut, which severs the zinc coating and leaves bare
 * steel sitting in whatever water runs past.
 *
 * The period is doing double duty and that is deliberate. On a pitched plane v
 * starts at the eave and rarely reaches 7 m, so the only sheet end this finds is
 * the one at v = 0 -- which is the eave, sitting in the gutter, which is exactly
 * where the rust is. On a cap, where v is world Z and there is no eave to find,
 * the same expression puts the same bloom on a plausible grid instead of nowhere.
 */
const SHEET_LENGTH = 7.2;

/** Marseille-pattern tile: 330 mm cover width on a 420 mm course gauge. */
const TILE_COVER = 0.33;
const TILE_GAUGE = 0.42;

/**
 * What a whole roof is made of, picked per building. Linear albedos, same
 * convention and same measurement basis as `MATERIAL_LOOK`.
 *
 * The share each family gets is the inner ring rather than the national mix:
 * unpainted and long-aged galvanised iron still covers most terraces, most
 * warehouses and every back shed, and Colorbond is what has gone on over it
 * since about 1990. Sunlit display values, through the chain in
 * `sky/calibration.ts` at 3 pm on 15 February, on an up-facing plane and at the
 * 0.907 mean the shader's weathering multiplies out to (rib 0.96 x dulling 0.95
 * x fixings 0.994):
 *
 *   aged galv    44%   rgb(191, 199, 203)  Y' 198   -- bright, and clear of the
 *                                                      sunlit footpath at 248
 *   off-white    16%   rgb(213, 216, 217)  Y' 215   -- Surfmist, sun-faded
 *   charcoal     14%   rgb( 82,  87,  90)  Y'  86   -- Woodland Grey / Monument
 *   muted green  13%   rgb(112, 128, 116)  Y' 124   -- Pale Eucalypt, faded
 *   faded red    13%   rgb(124,  78,  68)  Y'  87   -- Manor Red, chalked out
 *
 * Aged galv again, through the rest of the shader, because the spread matters as
 * much as the level:
 *
 *   brightest sheet on a rib crest       rgb(221, 229, 234)  Y' 228
 *   darkest sheet in a pan               rgb(160, 167, 170)  Y' 166
 *   the gutter band at the eave          rgb(135, 141, 144)  Y' 140
 *   the same roof in shade               rgb( 58,  73,  88)  Y'  71
 *   22-degree gable, slope facing the sun rgb(200, 208, 213)  Y' 207
 *   the other slope of the same gable    rgb(169, 176, 179)  Y' 175
 *
 * Not one of them is chrome, which is what spec 7.3's "**never shiny**" is
 * about: the brightness above is diffuse reflectance off an oxide bloom, and
 * the metalness below is what is left of the metal underneath.
 */
const STEEL_FAMILIES = {
  galv: [0.200, 0.209, 0.207],
  offWhite: [0.250, 0.250, 0.239],
  charcoal: [0.044, 0.046, 0.046],
  green: [0.072, 0.088, 0.070],
  red: [0.086, 0.040, 0.032],
} as const;

/**
 * Iron oxide. A dielectric, so it takes the metalness *off* the steel wherever
 * it blooms, and warm red-brown rather than orange.
 *
 * Neat it renders sunlit at rgb(142, 91, 70); the strongest bloom the shader
 * actually draws keeps 6% of the sheet under it and lands at rgb(146, 102, 86)
 * on galv and rgb(140, 94, 76) on a charcoal roof -- a warm mid with red clearly
 * dominant either way, which is the point of mixing towards this rather than
 * multiplying the sheet by it. In shade, rgb(42, 24, 25).
 */
const RUST = [0.100, 0.045, 0.030] as const;

/**
 * How much of a feature at `period` metres this fragment can still resolve.
 * 1 where it is comfortably sampled, 0 before it starts to alias.
 *
 * `footprint` is metres of surface per pixel, straight out of `fwidth` on the
 * roof coordinate, so this follows render scale, field of view and the angle the
 * roof is seen at without any of them being passed in. Two samples per period is
 * the Nyquist limit; the default band holds full detail to six samples and is
 * gone by two, which at 0.75 render scale puts the 76 mm rib fade between roughly
 * 10 and 30 metres.
 *
 * `fine` and `coarse` are open because how close to Nyquist a pattern can be
 * pushed depends on its contrast, not only its period. A hard dark line -- a lap
 * shadow, a joint groove -- crawls the moment it is near a pixel wide and needs
 * the whole margin. A soft value band, which is what a 762 mm sheet column is,
 * survives most of the way to Nyquist and needs to, because it is the thing that
 * has to still be legible at two hundred metres when nothing else is.
 *
 * Written as `smoothstep(fine, coarse, x).oneMinus()` rather than the reversed
 * `smoothstep(coarse, fine, x)` that reads more naturally: WGSL leaves the
 * reversed form undefined, and it is the kind of thing that works on one driver.
 *
 * Exported because the weathering pass needs it on both sides of the world --
 * the wall path above and the road in `street.ts` -- and a second copy of a
 * fade curve is exactly the kind of thing that drifts.
 */
export function resolves(period: number, footprint: any, fine = 0.16, coarse = 0.5) {
  return smoothstep(float(period * fine), float(period * coarse), footprint).oneMinus();
}

/**
 * A dark line that dissolves instead of crawling.
 *
 * The lap shadow under a roof tile is 20 mm on a 420 mm course and the crease at
 * a roof fixing is 35 mm on 900 mm. Fading those on their *period* leaves them
 * flickering across the whole mid-distance, because the line is a twentieth of
 * the period and stops being sampled twenty times sooner than the pattern does.
 * Fading them on their own *width* takes the tiles out of a suburban roof at
 * twenty-five metres, which is the read the whole pass exists to protect.
 *
 * So neither: the line is widened to the pixel footprint and its contrast is cut
 * by exactly the factor it was widened. The area under it -- which is all a pixel
 * covering several periods can see -- is held constant, so as it goes
 * sub-pixel it converges on a uniform slight darkening rather than switching on
 * and off with the sampling grid. It also needs no separate fade term: past the
 * point where the period itself is a pixel, the contrast has already gone to
 * nothing on its own.
 *
 * `distance`, `width` and `footprint` must all be in the same units -- metres for
 * the steel path, fractions of a course for the tile path.
 *
 * Returns a multiplier: `1 - strength` on the line, 1.0 away from it.
 *
 * Exported alongside `resolves`. `street.ts` carries a `softDot` built on the
 * same idea and a squared exponent, because a dot's area does not scale the way
 * a line's does; the argument is written out there.
 */
export function softLine(distance: any, width: number, strength: number, footprint: any) {
  const w = max(float(width), footprint.mul(1.6));
  const a = float(strength * width).div(w);
  return smoothstep(float(0.0), w, distance).mul(a).add(a.oneMinus());
}

/**
 * Roofs take a simpler path than a facade: no window grid, no parallax, no
 * parameter-driven grammar. What they need instead is to survive distance, which
 * is a different problem and is what the fades above and the per-sheet and
 * per-course variation below are for.
 *
 * `seed` is the building's own, out of parameter texel 2.
 */
function finishRoof(
  material: MeshStandardNodeMaterial,
  slot: FacadeMaterialName,
  look: { colour: [number, number, number]; roughness: number; metalness: number },
  seed: any,
): MeshStandardNodeMaterial {
  const co = uv();

  /**
   * Two independent 0-1 identities for this building, and neither goes near a
   * `sin()`.
   *
   * `hash21(vec2(seed, k))` -- which is what the wall path does -- evaluates
   * `sin()` at about 8e6 for a seed near 65535, and fp32 has an ulp of a whole
   * radian up there. It happens to work, because sin of consecutive integers is
   * still equidistributed, but it is one driver's range reduction away from
   * every roof in the city being the same colour. Multiplying by an irrational
   * and taking the fraction is the standard low-discrepancy trick, costs two
   * instructions instead of five, and keeps everything downstream in the range
   * `sin()` is actually accurate over. Golden ratio and the plastic number, so
   * the two are uncorrelated.
   */
  const idA = fract(seed.mul(0.6180339887));
  const idB = fract(seed.mul(0.7548776662));

  /**
   * Which UV space this fragment is in: 1 on a pitched plane whose v is metres
   * from the eave, 0 on a cap or an end triangle whose v is world Z.
   *
   * The test is exact rather than heuristic. `add_triangle_soup` writes
   * `uv = (position.x, position.z)` by construction, so a fragment whose UV
   * equals its own local XZ came out of that path; a fragment in the oriented
   * rectangle's frame agrees with its local XZ only where the roof rectangle
   * happens to be axis-aligned *and* cornered on the tile origin, which is a
   * measure-zero coincidence. Both quantities are float32 varyings interpolated
   * with the same weights, so where they are equal they are equal to within an
   * ulp of a coordinate that never exceeds a tile, and 1 cm of slack is three
   * orders of magnitude of headroom.
   *
   * Worth noting what this buys over the obvious alternative. Testing the normal
   * instead -- caps are exactly (0,1,0) -- gets the caps right and the *hip end
   * triangles* wrong, because those are pitched at the roof's own angle while
   * carrying world XZ UVs. This test classifies them correctly, which is the
   * difference between a hip roof with a gutter line on it and a hip roof with a
   * gutter line plus a stray dark stripe wherever the tile's local Z passes zero.
   */
  const onSlope = step(
    float(0.01),
    max(abs(co.x.sub(positionGeometry.x)), abs(co.y.sub(positionGeometry.z))),
  );

  // Metres of roof per pixel, on each axis of the roof coordinate. Everything
  // fine-grained below fades against one of these.
  const pxAcross = fwidth(co.x);
  const pxAlong = fwidth(co.y);

  if (slot === 'roof_steel') return finishSteelRoof(material, co, onSlope, idA, idB, pxAcross, pxAlong);
  return finishTileRoof(material, co, onSlope, idA, pxAcross, pxAlong, look);
}

/**
 * Weathered corrugated steel: the inner-suburb signature, and the largest single
 * area of roof in the build.
 *
 * `co.x` runs across the sheets and `co.y` runs down the fall, in both UV spaces
 * -- on a pitched plane because v is the fall line by construction, and on a cap
 * because there is no fall and any direction will do. Sheets are therefore
 * columns in x, laid side by side, which is what they are.
 */
function finishSteelRoof(
  material: MeshStandardNodeMaterial,
  co: any,
  onSlope: any,
  idA: any,
  idB: any,
  pxAcross: any,
  pxAlong: any,
): MeshStandardNodeMaterial {
  const across = co.x;
  const along = co.y;

  /**
   * The one evaluation the colour and the surface response share. Same reason as
   * `surface` on the facade path: four output slots each recomputing this would
   * quadruple the only work on the roof.
   *
   *   x  rib shading, 0 in the pan and 1 on the crest, already faded to its mean
   *   y  per-sheet value roll, 0-1, constant across one 762 mm sheet
   *   z  rust weight, 0-1
   */
  const sheetNode = Fn(() => {
    // --- Per-sheet variation. The single highest-value thing in this shader.
    //
    // Sheets go up one at a time, out of different bundles, sometimes years
    // apart, and they weather independently from the day they are laid. At any
    // distance past the ribs that variation IS the corrugated read -- a set of
    // 762 mm bands of slightly different value running down the fall. Hashed
    // with the building identity so the row of terraces opposite does not share
    // one pattern, and the second roll is derived from the first rather than
    // hashed again, which is two instructions instead of five for a value that
    // only has to be uncorrelated, not independent.
    const sheet = floor(across.div(SHEET_COVER));
    // Faded almost to Nyquist rather than well short of it, per `resolves`: this
    // band is low contrast, and it is the last thing on the roof still carrying
    // information. Full to about 145 m, gone by about 320 m at 0.75 scale.
    const sheetFade = resolves(SHEET_COVER, pxAcross, 0.33, 0.72);
    const sheetRoll = mix(float(0.5), hash21(vec2(sheet, idB.mul(37.0))), sheetFade);
    const sheetRust = fract(sheetRoll.mul(17.13));

    // --- Ribs. 76 mm, and honest about how long they last.
    //
    // Smootherstep rather than the old `pow(rib, 0.7)`: a corrugation's shading
    // is not sinusoidal in value -- the pan is flat and dark because it sees a
    // slot of sky and holds the dirt, the crest is a narrow bright line where
    // the rain runs off. Three multiplies instead of a transcendental, and it
    // fades to its own mean rather than to a flat surface, so nothing shifts
    // brightness as it recedes.
    const ribFade = resolves(RIB_PITCH, pxAcross);
    const wave = sin(across.mul(float((Math.PI * 2) / RIB_PITCH))).mul(0.5).add(0.5);
    const rib = wave.mul(wave).mul(float(3.0).sub(wave.mul(2.0)));

    // --- Rust, from the two places it actually starts.
    //
    // Everywhere else the zinc is still doing its job.
    const toFixing = abs(fract(along.div(FIXING_SPACING).add(0.5)).sub(0.5)).mul(FIXING_SPACING);
    const toEnd = abs(fract(along.div(SHEET_LENGTH).add(0.5)).sub(0.5)).mul(SHEET_LENGTH);
    const nearFixing = smoothstep(float(0.02), float(0.26), toFixing).oneMinus();
    const nearEnd = smoothstep(float(0.0), float(1.5), toEnd).oneMinus();
    // How far a bloom actually spreads, per 2.3 m of sheet. The cell is indexed
    // by *sheet number* rather than by x, which matters twice: water cannot cross
    // a rib, so a real bloom is bounded by the sheet it started on, and a hash
    // cell laid out on a free grid would put visible squares on the roof wherever
    // the pattern was strong. Bounded by the sheet, the only new edges run
    // across the fall -- which is where the fixing rows already are.
    const bloom = hash21(vec2(sheet, floor(along.div(2.3)).add(idA.mul(23.0))));
    // Rust *gated* by proximity rather than added to it, so there is none in the
    // middle of a sheet that is still sound. That gate is the difference between
    // a roof that looks old and one that looks like it was dipped in something.
    // The end weighs more than the fixings deliberately: a fixing weeps a stain,
    // a cut end sitting in a gutter rots.
    const rust = smoothstep(
      float(0.30),
      float(0.80),
      max(nearFixing.mul(0.60), nearEnd).mul(bloom.mul(sheetRust.add(0.7)).add(0.14)),
    );

    return vec3(mix(float(0.5), rib, ribFade), sheetRoll, rust);
  })();

  const rib = sheetNode.x;
  const sheetRoll = sheetNode.y;
  const rust = sheetNode.z;

  material.colorNode = Fn(() => {
    // --- Which steel this whole roof is.
    //
    // A chain of `step`s on one per-building value rather than a table lookup:
    // there is no texture on this path and there should not be one, and four
    // mixes is cheaper than any way of avoiding them.
    const family = vec3(...STEEL_FAMILIES.galv).toVar();
    family.assign(mix(family, vec3(...STEEL_FAMILIES.offWhite), step(float(0.44), idA)));
    family.assign(mix(family, vec3(...STEEL_FAMILIES.charcoal), step(float(0.60), idA)));
    family.assign(mix(family, vec3(...STEEL_FAMILIES.green), step(float(0.74), idA)));
    family.assign(mix(family, vec3(...STEEL_FAMILIES.red), step(float(0.87), idA)));

    // Per-sheet value, +/- 11%: rgb(201, 209, 213) against rgb(181, 188, 192) on
    // galv. Wide enough to read as separate sheets right across a roofscape,
    // narrow enough that it never reads as a stripe pattern.
    const sheetTint = sheetRoll.sub(0.5).mul(0.22).add(1.0);

    // Rib shading. The crest is 1.13 and the pan 0.79, which on an aged-galv
    // sheet is rgb(207, 215, 220) against rgb(174, 181, 185) -- a real
    // corrugation at arm's length, and gone to its own mean by the time it would
    // start to crawl.
    const ribShade = mix(float(0.79), float(1.13), rib);

    // The fixing rows themselves: a faint dark line where the sheet is pulled
    // down onto the batten and dirt collects in the crease. Kept much subtler
    // than the rust it seeds -- the crease is a cue, the rust is the story.
    const toFixing = abs(fract(along.div(FIXING_SPACING).add(0.5)).sub(0.5)).mul(FIXING_SPACING);
    const fixings = softLine(toFixing, 0.035, 0.08, pxAlong);

    // Zinc dulling: the broad, slow grubbiness of a roof nobody has been on in
    // thirty years. Indexed by sheet and by 5.4 m down the fall for the same
    // reason the rust is -- dirt washes down a sheet and stops at its ribs -- and
    // deliberately unfaded, because this is a distance term and it is meant to
    // still be there at four hundred metres.
    const dull = hash21(vec2(floor(across.div(SHEET_COVER)), floor(along.div(5.4)).add(idB.mul(13.0)))).mul(0.10);

    const steel = family.mul(sheetTint).mul(ribShade).mul(fixings).mul(float(1.0).sub(dull)).toVar();

    // Rust over the top, not multiplied into it: iron oxide is a different
    // material sitting on the steel, and mixing towards its albedo is what keeps
    // a bloom on a charcoal roof the same red-brown as one on bare galv. Stops
    // just short of a full replacement, so the sheet under it still shows.
    steel.assign(mix(steel, vec3(...RUST), rust.mul(0.94)));

    // --- Eave, and only on a plane that has one.
    //
    // The gutter line: 90 mm of quad gutter in shadow under the sheet ends, plus
    // the fascia below it. rgb(135, 141, 144) against rgb(191, 199, 203) of sheet
    // -- a hard dark band, and most of why a roof reads as terminating rather
    // than as merging into the wall it sits on. Gated on `onSlope` because on a
    // cap or a hip end v is world Z, and an unconditional band would draw a
    // stripe across the roof wherever local Z passed zero.
    const gutter = smoothstep(float(0.06), float(0.30), along).mul(0.45).add(0.55);
    // And the wash gradient above it: rain concentrates at the eave and carries
    // everything it picked up further up the slope into the last half metre.
    const wash = smoothstep(float(0.15), float(2.6), along).mul(0.09).add(0.91);
    return mix(steel, steel.mul(gutter).mul(wash), onSlope);
  })();

  // --- Surface response, and where the anisotropy lives ----------------------
  //
  // Corrugated steel is the one material in the build with a direction in it. A
  // true anisotropic lobe is not available on a standard node material without a
  // tangent frame, and reconstructing one from screen derivatives costs more than
  // the whole rest of this shader, so the sheen is done with roughness instead --
  // and it lands in the same place for the same physical reason. Rain runs off
  // the crests and polishes them; the pans hold dirt and go matte. That puts a
  // narrow band of low roughness along every crest, which under a directional sun
  // draws exactly the stretched highlight running down the fall that an
  // anisotropic BRDF would.
  //
  // The per-sheet term is what carries it past the ribs: sheets differ in how
  // chalked their oxide is, so at distance some sheets flash at the sun and their
  // neighbours do not, which is the read a real roofscape has at two hundred
  // metres and the ribs cannot give at all.
  //
  // Rust is neither. It is a matte dielectric crust, so it takes the roughness
  // to 0.95 and the metalness to nothing.
  const crestPolish = rib.sub(0.5).mul(0.20);
  const sheetSheen = sheetRoll.sub(0.5).mul(0.12);
  material.roughnessNode = mix(
    clamp(float(0.76).sub(crestPolish).add(sheetSheen), 0.5, 0.95),
    float(0.95),
    rust,
  );
  // Bare galv keeps more metal in it than a painted sheet: the paint on Colorbond
  // is a dielectric film over the zinc and it is what stops a whole suburb of
  // re-roofed houses flaring at once.
  material.metalnessNode = mix(float(0.12), float(0.32), step(idA, float(0.44)))
    .mul(rust.oneMinus());
  return material;
}

/**
 * Terracotta tile. Aged Sydney terracotta is not bright orange -- it is a
 * seventy-year-old Marseille pattern that has chalked to a dull earth red, with
 * whole patches gone black-green where lichen has taken the south-facing side.
 *
 * Sunlit on an up-facing plane, through `sky/calibration.ts` at 3 pm on
 * 15 February:
 *
 *   mid tile                             rgb(159, 100,  83)  Y' 111
 *   the reddest tile on the roof         rgb(184, 113,  92)  Y' 127
 *   the brownest                         rgb(132,  87,  74)  Y'  96
 *   the lap shadow under a course        rgb(118,  67,  50)  Y'  77
 *   a lichen patch                       rgb(104,  96,  78)  Y'  96
 *   the eave course                      rgb(109,  63,  42)  Y'  71
 *   mid tile in shade                    rgb( 52,  20,  15)  Y'  26
 *   22-degree gable, toward the sun      rgb(167, 107,  89)  Y' 118
 *   the other slope of the same gable    rgb(140,  85,  68)  Y'  95
 *
 * Red dominant everywhere and never above 184, against the 196 the bare albedo
 * gives -- which is what "aged" costs, and it is the difference between a
 * roofscape that glows and one that sits under the sky.
 */
function finishTileRoof(
  material: MeshStandardNodeMaterial,
  co: any,
  onSlope: any,
  idA: any,
  pxAcross: any,
  pxAlong: any,
  look: { colour: [number, number, number]; roughness: number; metalness: number },
): MeshStandardNodeMaterial {
  const across = co.x;
  const along = co.y;

  /**
   * Shared between colour and roughness, same reason as the steel path.
   *
   *   x  per-tile hue roll, 0-1, 0.5 once tiles stop resolving
   *   y  lichen weight, 0-1
   *   z  course shading: lap shadow and the tile's own rolls, already faded
   *   w  every plain value multiplier at once -- the per-tile jitter and the
   *      coarse four-course banding, which is the thing that survives distance
   */
  const tileNode = Fn(() => {
    // Two fades, because a tile is a different size on each axis: the lap shadow
    // and the head roll run across the courses, the side roll runs along them,
    // and they stop resolving at different distances.
    const courseFade = resolves(TILE_GAUGE, pxAlong);
    const columnFade = resolves(TILE_COVER, pxAcross);

    // --- Courses that are not laser-straight.
    //
    // Battens sag between rafters and no tiler in 1954 was working to a
    // millimetre, so a real tile roof's courses wander by 15-25 mm over a few
    // metres. Two sines an octave and a half apart, because one alone reads as a
    // deliberate wave rather than as slop; both are cheap and both are in metres
    // so the wander is the same size on a cottage and on a hall.
    const wander = sin(across.mul(1.9)).mul(0.011).add(sin(across.mul(0.61)).mul(0.017));
    const wavy = along.add(wander);
    const course = floor(wavy.div(TILE_GAUGE));
    const upCourse = fract(wavy.div(TILE_GAUGE));
    const acrossTile = fract(across.div(TILE_COVER));

    // --- Per-tile rolls, faded to their mean before the tile is a pixel wide.
    //
    // These have to fade and the old version did not, which is why a suburban
    // roofscape crawled: a random value on a 330 mm cell, seen at a hundred
    // metres, is a per-pixel dither and it boils under any camera movement.
    //
    // Both fade to the *centre* of their own range rather than to zero, which is
    // the whole point -- a roof must not change brightness as it recedes. The
    // second roll comes off the first for the same two-instructions-not-five
    // reason as the steel path.
    const tileFade = min(courseFade, columnFade);
    const rawRoll = hash21(vec2(floor(across.div(TILE_COVER)), course).add(idA.mul(29.0)));
    const tileRoll = mix(float(0.5), rawRoll, tileFade);
    const tileValue = mix(
      float(1.0),
      fract(rawRoll.mul(19.7)).sub(0.5).mul(0.15).add(1.0),
      tileFade,
    );

    // --- Lap shadow, strengthened and narrowed.
    //
    // The course above laps over the head of the course below, and what you see
    // looking up the slope is the nose of each tile with a hard shadow under it.
    // The old version smeared that over 60 mm at a quarter strength, which is a
    // gradient rather than a shadow; a real lap is a 20 mm line at close to half
    // value, with the tile's own curvature falling away above it. Both `upCourse`
    // and the footprint handed to `softLine` are in fractions of a course, which
    // is the unit the line width is written in.
    const lapLine = softLine(upCourse, 0.048, 0.44, pxAlong.div(TILE_GAUGE));
    const lapRoll = smoothstep(float(0.0), float(0.30), upCourse).mul(0.14).add(0.86);
    // And the side roll: a Marseille tile has a raised roll down one edge and a
    // channel down the other, so every tile is a little darker at its own edge.
    const sideRoll = smoothstep(float(0.0), float(0.20), acrossTile).mul(0.13).add(0.87);
    // The lap line carries its own fade out of `softLine`; the two broad
    // gradients are wide enough to fade on their own module instead.
    const courseShade = lapLine
      .mul(mix(float(1.0), lapRoll, courseFade))
      .mul(mix(float(1.0), sideRoll, columnFade));

    // --- What is left at distance.
    //
    // Individual tiles are 330 mm and gone by forty metres. Two things have to
    // carry the read past that, and they are both here.
    //
    // First, lichen -- and it arrives in round patches, not square ones, which is
    // why this is a splat on a lattice rather than a hash of the cell. A hashed
    // radius against the distance to the cell centre costs one hash and a
    // `length`, where a value noise smooth enough not to show its own lattice is
    // four hashes and a bilinear (see `street.ts`), and a cell hash on its own
    // puts 3.4 m squares on the roof. The same roll sets the radius and votes on
    // whether the cell has a patch at all, so a bare majority of cells get one and
    // the ones that do are the big ones -- about 15% of a roof, which is what a
    // south-facing tiled slope in Sydney actually carries.
    const lcell = fract(vec2(across, along).div(3.4)).sub(vec2(0.5, 0.5));
    const lroll = hash21(floor(vec2(across, along).div(3.4)).add(idA.mul(41.0)));
    const lrad = lroll.mul(0.42).sub(0.10);
    const lichen = smoothstep(lrad, lrad.add(0.13), length(lcell))
      .oneMinus()
      .mul(step(float(0.38), lroll));

    // Second, banding at four courses -- 1.7 m -- which is roughly the scale a
    // real roof's colour varies at, because that is how tiles come off a pallet.
    // Bands are lines across the fall, so unlike a cell they have no grid to show.
    const band = hash21(vec2(floor(course.div(4.0)), idA.mul(53.0))).sub(0.5).mul(0.10).add(1.0);

    return vec4(tileRoll, lichen, courseShade, band.mul(tileValue));
  })();

  const tileRoll = tileNode.x;
  const lichen = tileNode.y;

  material.colorNode = Fn(() => {
    // --- Per-tile hue, between two muted earths rather than around one orange.
    //
    // The slot albedo is the faded Marseille red; the second anchor is the
    // browner, sootier end that any roof more than half a century old has a good
    // share of. Varying the *hue* between them rather than only the value is what
    // stops a tiled roof reading as a single colour with noise on it -- which is
    // what the old +/- 11% value jitter gave, and it is visibly a texture rather
    // than a roof.
    const brown = vec3(0.115, 0.055, 0.042);
    const tile = mix(vec3(...look.colour), brown, tileRoll).toVar();

    // Lichen and soot. Grey-green and it kills the red, which is what it does on
    // a real roof -- the patches are not darker terracotta, they are a different
    // organism growing on it.
    tile.assign(mix(tile, vec3(0.052, 0.058, 0.041), lichen.mul(0.82)));

    // Courses, the value multipliers, and the overall dulling that takes the
    // mid-tone from the bare albedo's rgb(196, 121, 99) -- which is a new tile --
    // down to rgb(176, 106, 86), which is one that has been on a roof in Sydney
    // since the Menzies government.
    const dulled = tile.mul(tileNode.z).mul(tileNode.w).mul(0.86).toVar();

    // Eave, on the planes that have one. A tiled roof's eave course sits up on a
    // tilting fillet and overhangs the gutter, so the shadow under it is deeper
    // than any lap above it -- and the first metre is where the moss is, because
    // that is where the water sits longest.
    const gutter = smoothstep(float(0.05), float(0.26), along).mul(0.42).add(0.58);
    const damp = mix(
      vec3(1.0, 1.0, 1.0),
      vec3(0.84, 0.90, 0.82),
      smoothstep(float(0.2), float(1.4), along).oneMinus(),
    );
    return mix(dulled, dulled.mul(gutter).mul(damp), onSlope);
  })();

  // Old tile is matte and lichen is matter still; the only thing on a tiled roof
  // that holds any sheen at all is a tile that has stayed clean.
  material.roughnessNode = mix(
    mix(float(0.84), float(0.92), tileRoll),
    float(0.97),
    lichen,
  );
  material.metalnessNode = float(look.metalness);
  return material;
}

/**
 * Flat commercial roofs, on the slot that also serves the walls holding them up.
 *
 * `concrete_precast` is the roof material for the brutalist, tower and
 * modern-infill archetypes and a wall material in its own right, so one
 * primitive carries both and the shader has to tell them apart per fragment. The
 * world normal does it cleanly: a wall's is exactly horizontal and a cap's is
 * exactly (0, 1, 0), so the band this gates across is never actually sampled and
 * exists only so that a pitched precast roof -- which OSM's `roof:shape` can
 * still ask for -- degrades into the same treatment instead of popping.
 *
 * What was there before was not neutral. A cap's UV is its local XZ, so the
 * facade path was reading world Z as height above ground -- and local Z runs
 * from -500 to 0 across a tile, so it was reading it as *negative* height. The
 * window field therefore never opened, which is the only reason there are no
 * windows painted across the top of every tower in the CBD; but the plinth and
 * the soiling gradient both bottomed out at their floors, and what was left was
 * every flat roof in the city at a flat 0.57x grey with a stripe across it at
 * the 0.30 m course module.
 *
 * Subtle on purpose -- these are seen from above and from a distance and almost
 * never square-on -- so it is three things and no more: a grey membrane, the
 * joints of the deck under it, and the water that does not drain. Returns
 * vec4(membrane colour, roof mask).
 */
function flatRoofNode() {
  return Fn(() => {
    const p = uv();
    // Both axes, because everything below is a grid rather than a set of stripes
    // and a roof seen from a tower two blocks away is foreshortened on one of
    // them. The larger footprint is the one that decides when a joint crawls.
    const px = max(fwidth(p.x), fwidth(p.y));

    // rho 0.21, and it belongs between two values that are already fixed: below
    // the sunlit footpath at rgb(247, 248, 246), because a roof membrane is
    // grubbier than a footpath, and a little above the sunlit precast wall at
    // rgb(186, 186, 185), because it is up-facing and takes the 57-degree sun
    // square-on where the wall takes it at 33. It lands at:
    //
    //   clean membrane                   rgb(205, 207, 208)  Y' 207
    //   where the water ponds            rgb(173, 177, 175)  Y' 176
    //   a deck joint                     rgb(170, 172, 173)  Y' 172
    //   in shade                         rgb( 66,  79,  92)  Y'  77
    const base = vec3(0.210, 0.207, 0.198);

    // Deck and membrane joints on a 3.6 m grid. The same argument as the
    // footpath's expansion joints in `street.ts`: a flat grey field has no scale
    // and a grid of slabs has one immediately, and on a roof it is the only cue
    // that says how big the building is when the facade is out of frame.
    const toJointX = abs(fract(p.x.div(3.6)).sub(0.5)).mul(3.6);
    const toJointY = abs(fract(p.y.div(3.6)).sub(0.5)).mul(3.6);
    const joint = softLine(min(toJointX, toJointY), 0.11, 0.32, px);

    // Ponding. Every flat roof in Sydney has falls that stopped working in about
    // 1978, and what you see from a tower is the dark rings where the water sat
    // and the dirt it left when it finally went. Round splats on a 5 m lattice
    // rather than value noise: one hash and a length instead of four hashes and a
    // bilinear, and a puddle is round.
    const cell = floor(p.div(5.0));
    const toCentre = length(fract(p.div(5.0)).sub(0.5));
    const pond = smoothstep(float(0.16), float(0.46), toCentre)
      .oneMinus()
      .mul(step(hash21(cell), float(0.42)));
    const stain = mix(vec3(1.0, 1.0, 1.0), vec3(0.70, 0.72, 0.70), pond);

    // Gravel and chip, the ballast layer, fading before it can crawl.
    const chip = hash21(floor(p.mul(6.5))).sub(0.5).mul(0.09).mul(resolves(0.154, px));

    return vec4(
      base.mul(joint).mul(stain).mul(float(1.0).add(chip)),
      smoothstep(float(0.55), float(0.80), normalWorld.y),
    );
  })();
}
