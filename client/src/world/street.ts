/**
 * Materials for the three street surfaces the pipeline emits.
 *
 * Deliberately nothing like `facade.ts`. A facade needs a per-building parameter
 * fetch, a window grid and a parallax step; a road needs none of that and must
 * not pay for it. These three are flat surfaces with a procedural pattern and no
 * dependence on the parameter atlas or the `_BLDIDX` attribute -- which is what
 * lets the pipeline leave that attribute off street primitives entirely.
 *
 * UVs arrive in **world metres**, planar over XZ, and the world part matters: a
 * tile is 500 m and a footpath slab is 1.2 m, so a tile-local UV would restart
 * the joint grid mid-pattern at every tile line. Everything below reads `uv()`
 * directly as metres east and metres south.
 *
 * Colours are spec section 7.3: blue-metal road, sandstone kerbing. Sydney's
 * asphalt is a cool blue-grey because the aggregate is crushed basalt, not the
 * warm near-black of a bitumen-rich northern-hemisphere road, and its kerbs are
 * warm buff Hawkesbury sandstone rather than grey concrete. Both are things an
 * Australian player registers without being able to name.
 */

import {
  Fn,
  abs,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalWorld,
  sin,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { resolves, type StreetMaterialName } from './facade.ts';

/** Expansion joints in a poured footpath, metres. */
const SLAB_SIZE = 1.2;
/** Half-width of a joint groove, metres. Wide enough to survive a mipmap. */
const JOINT_HALF_WIDTH = 0.02;

/* ---------------------------------------------------------------------------
 * WEATHERING. Spec section 7.6 asks for oil staining on driveways and laneways
 * and, with the facade's half of the same pass, for a city that reads
 * sun-beaten rather than freshly poured.
 *
 * WHAT THESE SHADERS CAN AND CANNOT KNOW, because two of the obvious effects
 * are not constructible here and it is worth writing down why rather than
 * leaving the next reader to rediscover it:
 *
 *   Kerb proximity from the asphalt. Not available. The carriageway arrives as
 *   one unioned polygon per tile with planar world-XZ UVs and nothing else --
 *   no edge distance, no per-vertex attribute, no lane centreline. So the
 *   gutter grime that belongs in the 0.4 m against the kerb cannot be drawn on
 *   the road. It is drawn on the KERB instead, which is where most of it is
 *   anyway; see `finishSandstone`.
 *
 *   Height up the kerb face. Not available either, and this one is a genuine
 *   surprise: `streets._emit_kerb_face` builds the 13 cm step as a quad strip
 *   whose two rails are the *same* ring, and it writes `np.tile(_world_uv(pts),
 *   (2, 1))` -- one UV, used for both the bottom rail and the top. So the face
 *   carries no vertical coordinate at all. What does separate the two surfaces
 *   is the normal: the top face is up-facing off the terrain and the step's
 *   face is exactly horizontal, so `normalWorld.y` splits them cleanly. A
 *   gradient across 13 cm would be invisible at any distance a player sees a
 *   kerb from, so the face takes a flat darkening and loses nothing.
 *
 *   A darkening band along the footpath's outer edge. Not constructible. The
 *   footpath is `band - kerb_outer - buildings`, triangulated, with the same
 *   planar world UVs and up-facing normals throughout; there is no coordinate
 *   anywhere in it that says how far a fragment is from the kerb side. Doing it
 *   would need a distance-to-edge written per vertex out of `streets._emit_flat`,
 *   which is a pipeline change. Recorded as the follow-up it is.
 *
 *   Tyre-polish bands on the asphalt. Skipped for the reason `finishAsphalt`
 *   already gives about its own noise: the shader has no idea which way a road
 *   runs, so anything with a direction in it would lie across the whole city at
 *   one fixed angle. A wheel path drawn at the wrong angle is worse than none.
 * ------------------------------------------------------------------------- */

/**
 * Oil dripped out of a stationary car: round, 1.5-3 m across, about 4% of the
 * road.
 *
 * A splat on a lattice rather than a noise threshold, and the argument is the
 * one `flatRoofNode` makes about ponding: one hash and a `length` instead of
 * four hashes and a bilinear, and the shape is right -- a car parks, drips in
 * one place for a month, and leaves a round patch. The centre offset is hashed
 * so the patches do not sit on a visible grid, and the reach is kept inside half
 * a cell so a patch is never clipped square by its own cell boundary.
 *
 * The rate is set from the coverage rather than picked: at a mean effective
 * radius of 0.20 cells a patch covers 0.126 of one, so 0.32 of cells carrying
 * one gives 4%.
 */
const OIL = {
  cell: 2.4,
  rate: 0.32,
  radius: [0.08, 0.20] as const,
  soft: 0.12,
  offset: 0.15,
  peak: 0.25,
  /** Coverage x peak: what the patches are worth once they stop resolving. */
  mean: 0.010,
  /** Which channels the darkening takes. Oil on blue-metal reads warm-dark. */
  tint: [0.92, 1.0, 1.12] as const,
} as const;

/**
 * Chewing gum, and the general mottling of a footpath that has been walked on
 * since 1954.
 *
 * The gum is 2-4 cm and therefore sub-pixel almost everywhere, which is what
 * `softDot` exists for. The blotch is 1.8 m and signed either side of zero, so
 * it cannot move the footpath's *mean* -- and that matters more here than
 * anywhere else in the build, because sunlit concrete at rho 0.472 is the
 * anchor the whole exposure was solved against (see `finishConcrete`).
 *
 * Where it reads: in shade. At +/-8% the blotch moves a shaded footpath from
 * rgb(116, 129, 143) Y' 127 to rgb(110, 123, 137) Y' 121 and rgb(121, 134, 149)
 * Y' 132 -- 11 code values of spread -- and a sunlit one by exactly one, from
 * Y' 248 to 247 and 249, because the tone curve has compressed everything above
 * rho 0.42 into a few code values. That is the same compression `PAINT_PALETTE`
 * documents on the facade side, it is what a photograph of a sunlit footpath
 * shows, and it is not a fault. A swing big enough to read in full sun would
 * look like a leopard in shade.
 *
 * The gum has no such problem, because it is *dark*: rgb(247, 248, 246) Y' 248
 * to rgb(200, 200, 198) Y' 200 in sun, and rgb(116, 129, 143) Y' 127 to
 * rgb( 63,  74,  86) Y'  73 in shade. Forty-eight and fifty-four code values,
 * on a 3 cm dot, which is why it needs `softDot` and not a plain threshold.
 */
const GUM = {
  cell: 0.5,
  rate: 0.5,
  /** Dot radius, metres. 2-4 cm dots. */
  radius: [0.010, 0.020] as const,
  peak: 0.58,
} as const;
const BLOTCH = { scale: 1.8, amp: 0.08 } as const;

/**
 * Gutter grime on the kerb face.
 *
 * A kerb face is the dirtiest 15 cm of any street -- it is where the road's
 * runoff goes, and it never sees a broom. The top face does not get it: people
 * walk on it, and rain hits it square-on.
 *
 * The existing 1.25 m noise scales it between 0.75 and 1.0 of this along the
 * run, so the band is 0.21-0.28 rather than a constant. At 3 pm on 15 February:
 *
 *   kerb top, sunlit (up-facing)              rgb(247, 229, 188)  Y' 230
 *   kerb face, sunlit, ungrimed               rgb(233, 213, 170)  Y' 214
 *   kerb face, grime 0.21                     rgb(210, 193, 153)  Y' 194
 *   kerb face, grime 0.28                     rgb(201, 184, 147)  Y' 185
 *   kerb top, shaded                          rgb(112, 113,  96)  Y' 112
 *   kerb face, shaded, grime 0.28             rgb(117,  99,  67)  Y' 101
 *
 * Forty-five code values between the top and the dirtiest face, of which
 * sixteen are geometry -- an ungrimed vertical face is already at Y' 214
 * because it takes the 57 degree sun at a glance where the top takes it
 * square-on -- and the other twenty-nine are this.
 */
const GUTTER_GRIME = 0.28;

/**
 * A dark *dot* that dissolves instead of crawling. `softLine`'s argument in two
 * dimensions, and the exponent is the whole reason it is a separate helper.
 *
 * `softLine` widens a line to the pixel footprint and cuts its contrast by the
 * factor it was widened, because a line's area scales linearly with its width.
 * A dot's area scales with the *square*, so a dot faded on `width / w` holds
 * far too much contrast and a 3 cm gum spot ends up a visible speck at fifty
 * metres. Squaring the ratio holds the area properly, so the dots converge on a
 * uniform faint darkening of the right size rather than on a stipple.
 *
 * Returns a 0-1 coverage, already area-corrected.
 */
const softDot = /*#__PURE__*/ Fn(([distance, radius, footprint]: [any, any, any]) => {
  const w = max(radius, footprint.mul(1.3));
  const held = radius.mul(radius).div(w.mul(w));
  return smoothstep(w.mul(0.55), w, distance).oneMinus().mul(held);
});

/** Value noise on a metre-scale lattice, the same hash the facade uses. */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h).mul(43758.5453123));
});

/**
 * Smooth value noise over world metres, so a surface varies at the scale of a
 * patch repair rather than a pixel. Bilinear between lattice points; a single
 * octave is enough because these surfaces are seen at a grazing angle and the
 * point is only to break up a flat tone.
 */
const valueNoise = /*#__PURE__*/ Fn(([p]: [any]) => {
  // Annotated `any` for the same reason `facade.ts` takes its arguments that
  // way: TSL's arithmetic overloads collapse a vec2 node to a scalar node type
  // through a chain of `mul`, and the component accessors go with it.
  const i: any = floor(p);
  const f: any = fract(p);
  // Smoothstep the interpolant, otherwise the lattice shows as a diamond grid.
  const w: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
});

/**
 * Create the material for one street slot.
 *
 * Called once per slot for the whole game, like the facade materials: every tile
 * shares them, so these are three more pipelines compiled at startup and none
 * ever after.
 */
export function createStreetMaterial(slot: StreetMaterialName): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = slot;

  // The carriageway sits 2 cm above the placeholder ground plane, and with a
  // 0.1 m near plane against a 24 km far plane that separation quantises to less
  // than one depth-buffer step somewhere around 180 m: past that the road and
  // the ground shimmer against each other across the whole mid-distance. A
  // constant two-unit bias toward the camera settles it. Constant, not
  // slope-scaled, so the pull is the same on the flat surfaces and on the
  // near-vertical kerb face, and all three street slots take the same value so
  // their order among themselves is unchanged. Nothing else in the world sits
  // within the bias of a street in plan, so there is nothing for it to punch
  // through.
  material.polygonOffset = true;
  material.polygonOffsetUnits = -2;
  material.polygonOffsetFactor = 0;

  switch (slot) {
    case 'road_asphalt':
      return finishAsphalt(material);
    case 'footpath_concrete':
      return finishConcrete(material);
    case 'kerb_sandstone':
      return finishSandstone(material);
  }
}

/**
 * Blue-metal bitumen. No markings: lane lines, stop bars and give-way triangles
 * are a project of their own and a half-hearted pass at them would look worse
 * than clean asphalt.
 *
 * It does carry oil now (spec 7.6), and the reason that is allowed where a lane
 * line is not is that oil has no *direction* in it. Everything on this surface
 * has to survive the fact that the shader cannot know which way the road runs;
 * a round patch does, and a wheel path does not. See `OIL`, and the block at the
 * top of this file for what else that rules out.
 *
 * Predicted at 3 pm on 15 February: clean sunlit asphalt rgb(131, 137, 148),
 * the centre of a patch rgb(113, 117, 124), and in shade rgb(24, 40, 59)
 * against rgb(17, 31, 47).
 */
function finishAsphalt(material: MeshStandardNodeMaterial): MeshStandardNodeMaterial {
  material.colorNode = Fn(() => {
    const p = uv();
    // rho 0.09, and left exactly where it was: this is a measured asphalt
    // reflectance and it was already right. Checked against the calibrated
    // exposure because asphalt is the darkest large surface in any street view
    // and the one at risk of crushing -- in sun at 3 pm it lands at
    // rgb(131, 137, 148), cool and blue-metal, with the aggregate variation
    // below still legible; in shade at rgb(24, 40, 59).
    //
    // The shaded figure is the one this surface is judged on and it is the least
    // improved thing in the bounce pass, on purpose. It was rgb(15, 38, 59) --
    // red at a quarter of blue, which is the blue-grey-dead reading -- and it is
    // now rgb(24, 40, 59), which is the same blue with the red end lifted most of
    // the way to it. It does not go further, and the reason is measurement rather
    // than budget: the converged street-canyon integration in `calibration.ts`
    // puts the *physical* shaded road at lum 1.8-2.2 against the 2.3 this rig
    // already gives an up-facing surface, and the physical ground sun:shade at
    // 8.3:1 against the rig's 5.8:1. A shaded road is lit from the sky and is
    // genuinely cool and genuinely dark, and blue-metal aggregate is itself
    // blue-biased -- R over B here would be wrong, not warmer. Almost none of the
    // bounce is aimed at the horizontal for exactly this reason.
    const base = vec3(0.086, 0.090, 0.099);
    // Two scales of variation: metre-scale for the aggregate patchiness that
    // stops the road reading as a single painted value, and a much coarser one
    // for the tonal difference between an old surface and a resheeted one.
    // Both are isotropic noise rather than any kind of stripe -- the shader has
    // no idea which way a road runs, so anything with a direction in it would
    // lie across the whole city at one fixed angle.
    const fine = valueNoise(p.mul(1.4)).sub(0.5).mul(0.055);
    const coarse = valueNoise(p.mul(0.06)).sub(0.5).mul(0.075);
    // Trench patches: the darker rectangles left where a service was cut in and
    // resealed. About a fifth of a 4 m grid, which is roughly the density of any
    // street that has had gas or fibre through it.
    const patch = step(hash21(floor(p.div(4.0))), float(0.20)).mul(0.020);
    const road = base.add(vec3(fine.add(coarse).sub(patch)));

    // --- Oil. Spec section 7.6. See `OIL`.
    const cell = p.div(float(OIL.cell));
    const roll = hash21(floor(cell));
    const local = fract(cell).sub(0.5);
    // The three geometry rolls are spun off the presence roll, and the
    // multipliers are large for a reason `facade.ts` documents at length on
    // `wallRust`: `roll` is thresholded at 0.32 here, so a multiplier that does
    // not complete several wraps across [0, 0.32] would map the whole selected
    // subset onto a narrow band and every patch in the city would be the same
    // size. At 29.1, 43.7 and 17.3 they wrap nine, fourteen and five times.
    const centre = vec2(fract(roll.mul(29.1)), fract(roll.mul(43.7)))
      .sub(0.5)
      .mul(float(OIL.offset * 2.0));
    const radius = float(OIL.radius[0]).add(
      fract(roll.mul(17.3)).mul(OIL.radius[1] - OIL.radius[0]),
    );
    const patchWeight = smoothstep(radius, radius.add(float(OIL.soft)), length(local.sub(centre)))
      .oneMinus()
      .mul(step(roll, float(OIL.rate)));

    // Faded to its own mean rather than to nothing, per `resolves`: a road must
    // not change brightness as it recedes, and at a grazing angle -- which is
    // how a road is nearly always seen -- the footprint of a pixel runs away
    // fast enough that this matters well inside the visible distance. What
    // dissolves is the *pattern* of patches; the 1% they are worth on average
    // stays, which is under a code value and exactly where it should be.
    const oil = mix(
      float(OIL.mean),
      patchWeight.mul(float(OIL.peak)),
      resolves(OIL.cell * 0.4, max(fwidth(p.x), fwidth(p.y)), 0.33, 0.72),
    );
    return road.mul(vec3(1.0, 1.0, 1.0).sub(vec3(...OIL.tint).mul(oil)));
  })();
  // Near-matte. Wet-look asphalt is a night-time-and-rain effect and there is
  // no rain; at 0.95 the sun leaves a broad dull sheen and nothing more.
  material.roughnessNode = float(0.95);
  material.metalnessNode = float(0.0);
  return material;
}

/**
 * Poured concrete footpath with its expansion-joint grid.
 *
 * The joints are the whole point. A flat grey band does not read as a footpath
 * at any distance; a grid of 1.2 m slabs does, immediately, because it is the
 * only cue that gives the surface a scale relative to the player.
 */
function finishConcrete(material: MeshStandardNodeMaterial): MeshStandardNodeMaterial {
  material.colorNode = Fn(() => {
    const p = uv();
    // rho 0.46, also left alone. A new-ish poured footpath really is that
    // reflective, and under the calibrated exposure it renders at
    // rgb(247, 248, 246) in full sun -- the near-blinding surface a Sydney
    // footpath in February actually is, and the brightest large area in frame
    // after the horizon haze. It is the anchor the exposure was solved against,
    // and it moved one code value when the bounce light went in, which is the
    // whole budget that pass was allowed to spend on the sunlit half.
    // In shade: rgb(116, 129, 143), up from rgb(94, 116, 136).
    const base = vec3(0.472, 0.457, 0.427);

    // Distance to the nearer joint on each axis, in metres, so the groove is a
    // fixed physical width rather than a fraction of a slab.
    const toJointX = abs(fract(p.x.div(SLAB_SIZE)).sub(0.5)).mul(SLAB_SIZE);
    const toJointY = abs(fract(p.y.div(SLAB_SIZE)).sub(0.5)).mul(SLAB_SIZE);
    const toJoint = min(toJointX, toJointY);
    const groove = smoothstep(float(JOINT_HALF_WIDTH), float(JOINT_HALF_WIDTH * 3.0), toJoint);
    // The groove is a shadowed recess, not a drawn line, so it darkens rather
    // than tinting.
    const jointShade = mix(float(0.62), float(1.0), groove);

    // Per-slab pour variation: adjacent slabs were poured on different days and
    // it shows for decades.
    const slab = floor(p.div(SLAB_SIZE));
    const pour = hash21(slab).mul(0.09).sub(0.045);
    // Aggregate speckle, finer than the slab and independent of it.
    const speckle = valueNoise(p.mul(9.0)).sub(0.5).mul(0.045);

    // --- Traffic mottling at 1.8 m, which is the scale a walked-on footpath
    // actually varies at -- above the slab and below the block. Signed either
    // side of zero, so the mean is untouched; see `BLOTCH` for why symmetry
    // matters here more than anywhere else in the build.
    //
    // VALUE NOISE, not the round splat the oil and the gum use, and the reason
    // is a seam. A splat is `1 - smoothstep(r0, r1, |fract(p/c) - 0.5 - off|)`,
    // and if `off + r1` exceeds half a cell the blob is cut square by its own
    // cell boundary. Sized so it cannot be, the centres go back to sitting on a
    // near-regular grid with gaps between them, which is the artefact the offset
    // existed to remove. Measured on this one: at the sizes a 1-3 m mottle wants
    // there is no setting that avoids both, and the discontinuity is worth 6% --
    // eight code values in shade -- along every 2 m grid line, on the surface
    // the player is standing on. Bilinear noise has no cell edges by
    // construction, and here it is also the *cheaper* of the two.
    const blotch = valueNoise(p.mul(float(1.0 / BLOTCH.scale)))
      .sub(0.5)
      .mul(BLOTCH.amp * 2.0);

    // --- Gum. Two a square metre, everywhere, because a Sydney footpath is
    // uniformly disgusting and this shader has no retail signal to weight it by
    // -- the street materials read no parameter atlas and no building index at
    // all, which is the property that lets the pipeline leave `_BLDIDX` off
    // street primitives entirely.
    const px = max(fwidth(p.x), fwidth(p.y));
    const gcell = p.div(float(GUM.cell));
    const groll = hash21(floor(gcell).add(vec2(31.7, 11.3)));
    // Large multipliers again, for the reason spelled out on the oil above:
    // `groll` is thresholded at 0.5, so these wrap twelve, seven and six times
    // across the half of cells that carry a dot.
    const gcentre = vec2(fract(groll.mul(23.9)), fract(groll.mul(13.31))).sub(0.5).mul(0.7);
    const gradius = float(GUM.radius[0]).add(
      fract(groll.mul(11.7)).mul(GUM.radius[1] - GUM.radius[0]),
    );
    const gum = softDot(
      length(fract(gcell).sub(0.5).sub(gcentre).mul(float(GUM.cell))),
      gradius,
      px,
    ).mul(step(groll, float(GUM.rate)));

    return base
      .mul(float(1.0).add(pour).add(speckle).add(blotch))
      .mul(jointShade)
      .mul(float(1.0).sub(gum.mul(float(GUM.peak))));
  })();
  material.roughnessNode = float(0.90);
  material.metalnessNode = float(0.0);
  return material;
}

/**
 * Hawkesbury sandstone kerbing. Spec section 7.3 is explicit that this is warm
 * buff-honey and **not grey** -- the same colour note as the sandstone facade
 * slot, because it is the same rock out of the same quarries.
 *
 * This slot is two surfaces, not one: `streets._emit_flat` lays the 0.15 m top
 * and `streets._emit_kerb_face` stands the 0.13 m step beside it, both in here.
 * The gutter grime belongs on the second and not the first, and the normal is
 * the only thing that separates them -- see `GUTTER_GRIME` and the block at the
 * top of this file.
 */
function finishSandstone(material: MeshStandardNodeMaterial): MeshStandardNodeMaterial {
  material.colorNode = Fn(() => {
    const p = uv();
    // rho 0.38, down from 0.53. The old value gave the kerb a higher reflectance
    // than the sandstone facade slot, which is backwards twice over: it is the
    // same rock out of the same quarries, and a kerb is the most weathered, most
    // trafficked and dirtiest sandstone in the city. It still renders brighter
    // than a sandstone wall -- rgb(248, 230, 189) against rgb(232, 208, 163) --
    // but now because its top face is horizontal and takes the sun at 57 degrees
    // rather than 33, which is geometry doing it and not the albedo.
    // In shade: rgb(116, 117, 100), up from rgb(94, 104, 94) -- and warm-side of
    // neutral now, where it used to sit green-grey, which is the wrong reading
    // for a sandstone kerb under a building's shadow.
    const base = vec3(0.475, 0.382, 0.228);

    // Kerbs are laid as blocks around a metre long, and a faint darker line at
    // each joint is what stops a kilometre of kerb reading as one extruded
    // ribbon. Measured along x+y rather than along either axis: a kerb runs in
    // any direction and the shader cannot know which, but a diagonal wave cuts
    // across every direction except one and puts a mark every ~0.9 m along it
    // either way. Using the axes themselves would leave a whole east-west kerb
    // run either uniformly dark or uniformly clean depending on its latitude.
    const along = p.x.add(p.y);
    const joint = smoothstep(float(0.0), float(0.05), abs(fract(along.div(0.9)).sub(0.5)))
      .mul(0.12)
      .add(0.88);

    // Iron banding, the giveaway of Hawkesbury sandstone: rusty streaks along
    // the bedding planes rather than uniform colour. Mildly anisotropic, which
    // is all a 15 cm ribbon can show of a bedding direction anyway.
    const band = valueNoise(vec2(p.x.mul(0.6), p.y.mul(1.6))).sub(0.5);
    const iron = mix(vec3(1.0, 1.0, 1.0), vec3(1.06, 0.94, 0.80), band.add(0.5));

    // Grime in the gutter line. A kerb face is the dirtiest 15 cm of any street.
    const grime = valueNoise(p.mul(0.8)).mul(0.10);

    // ...and the face itself, which is the whole of the gutter grime this pass
    // could construct. `normalWorld.y` is the only thing that separates the two
    // surfaces in this slot -- the top face is up-facing off the terrain and the
    // step is exactly vertical -- because `_emit_kerb_face` writes one UV for
    // both of its rails and there is no height coordinate anywhere in it. See
    // the block at the top of this file.
    //
    // The existing noise is reused as the variation rather than a second one
    // being drawn: `grime` runs 0 to 0.10 on a 1.25 m scale, so this scales the
    // band between 0.75 and 1.0 of `GUTTER_GRIME` along the run and the two
    // effects agree about where the dirt is instead of arguing.
    const face = smoothstep(float(0.25), float(0.55), abs(normalWorld.y)).oneMinus();
    const gutter = face.mul(float(GUTTER_GRIME)).mul(grime.mul(2.5).add(0.75));
    // Warm-side removal: road dirt is grey, so what it takes off a buff
    // sandstone is mostly the red end, and the face reads greyer as well as
    // darker. That second read is what stops it looking like a shadow.
    return base
      .mul(iron)
      .mul(joint)
      .mul(float(1.0).sub(grime))
      .mul(vec3(1.0, 1.0, 1.0).sub(vec3(1.0, 0.99, 0.93).mul(gutter)));
  })();
  material.roughnessNode = float(0.88);
  material.metalnessNode = float(0.0);
  return material;
}
