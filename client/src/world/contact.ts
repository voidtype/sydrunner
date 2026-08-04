/**
 * The contact-occlusion skirt: the one translucent material in the world.
 *
 * The pipeline (`contact.py`) lays a flat black ribbon around every footprint,
 * 0.9 m wide, and bakes the wall's occlusion of the sky into COLOR_0's alpha --
 * 0.55 against the wall, nothing at the far edge. This file is what draws it,
 * and it is deliberately the smallest material in the project: no light, no
 * texture, no UVs, no normals, no parameter fetch. The shading is already in the
 * mesh; the material's entire job is to blend it.
 *
 * **Unlit is not an optimisation, it is the point.** Occlusion is the absence of
 * light. A lit material would take the sun on this ribbon and make the shadow
 * *brighter* on the sunlit side of the street, which is the exact inversion of
 * what it is for. It casts nothing into the shadow map for the same reason --
 * see `streamer.applyShadowRole`, which reads `userData.surface`.
 *
 * ---------------------------------------------------------------------------
 * `CONTACT_GAIN` is the one measured number here, and it is measured because
 * the physical answer and the useful answer are not the same number.
 *
 * The alpha the pipeline bakes is an *occlusion*: a wall standing on the ground
 * takes about half the hemisphere away from the ground touching it. What that
 * occlusion is worth as a display-space alpha depends entirely on how much of
 * the surface's light was ambient in the first place, and on a Sydney afternoon
 * that ranges over an order of magnitude. Halving the ambient term, evaluated
 * through the chain at the top of `sky/calibration.ts` at 3 pm on 15 February:
 *
 *                       open surface        with half its sky taken     alpha
 *   footpath, sunlit    rgb(247,248,246)    rgb(247,245,241)  Y' -3     0.012
 *   footpath, shaded    rgb(116,129,143)    rgb( 73, 84, 96)  Y' -44    0.346
 *   asphalt,  sunlit    rgb(131,137,148)    rgb(126,130,139)  Y' -7     0.051
 *   asphalt,  shaded    rgb( 24, 40, 59)    rgb(  8, 23, 38)  Y' -17    0.447
 *   dry ground, sunlit  rgb(233,225,202)    rgb(227,217,193)  Y' -8     0.036
 *   dry ground, shaded  rgb( 83, 90, 89)    rgb( 44, 51, 50)  Y' -39    0.443
 *
 * So pure ambient occlusion is worth 0.35-0.45 in shade and **essentially
 * nothing in sun** -- 82% of the light on a sunlit footpath is direct beam and a
 * wall 20 cm away blocks none of it. One constant cannot be both, and the two
 * halves do not deserve equal weight in either direction:
 *
 *   - In shade the building has usually already cast its own shadow onto the
 *     ground the skirt is lying on, so the grounding cue is *already there* and
 *     the skirt is only deepening it. Landing under the physical figure is safe.
 *   - In sun there is no shadow and the wall reads as pasted on, which is the
 *     failure this whole feature exists to fix -- but occlusion is not what
 *     darkens that ground in life. Grime is. The last 30 cm before a wall
 *     collects road dust and roof runoff and sits 20-30% down on the open
 *     footpath beside it, and unlike occlusion that is a reflectance and scales
 *     with whatever light is falling on it.
 *
 * 0.55 against the pipeline's 0.55 makes the peak 0.30, which is the grime
 * figure at the sunlit end and two thirds of the occlusion figure at the shaded
 * one. Through the same chain, at the wall, falling to nothing 0.9 m out:
 *
 *   footpath, sunlit    rgb(247,248,246) Y' 248  ->  rgb(173,174,172) Y' 174
 *   footpath, shaded    rgb(116,129,143) Y' 127  ->  rgb( 81, 90,100) Y'  89
 *   asphalt,  sunlit    rgb(131,137,148) Y' 137  ->  rgb( 92, 96,104) Y'  96
 *   asphalt,  shaded    rgb( 24, 40, 59) Y'  38  ->  rgb( 17, 28, 41) Y'  27
 *   dry ground, sunlit  rgb(233,225,202) Y' 225  ->  rgb(163,158,141) Y' 158
 *
 * Those are peaks. The band averages half of them across its width, and at eye
 * height the ramp is compressed toward the wall by the parallax of the 17 cm the
 * ribbon floats (see `contact.py`), so what is actually read is a tight dark
 * line at the joint fading out within half a metre. It is a gain rather than a
 * baked constant so that this can be retuned against a screenshot without a
 * thirty-minute retile -- the mesh carries the physics, this carries the look.
 */

import { float, vec3, vertexColor } from 'three/tsl';
import { FrontSide, MeshBasicNodeMaterial } from 'three/webgpu';

/** What one unit of baked occlusion is worth as display-space alpha. */
const CONTACT_GAIN = 0.55;

/**
 * Create the contact-skirt material. Once for the whole world, like every other
 * slot -- one more pipeline compiled at startup and none ever after.
 */
export function createContactMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.name = 'contact_ao';

  // Black, and only the alpha varies. `vertexColor()` falls back to opaque white
  // when COLOR_0 is missing, so a tile emitted by a pipeline that has lost the
  // attribute draws a solid black ribbon rather than nothing -- which is the
  // right way round for a failure that would otherwise be invisible.
  material.colorNode = vec3(0.0, 0.0, 0.0);
  material.opacityNode = vertexColor().w.mul(float(CONTACT_GAIN));
  material.transparent = true;

  // No depth write. The ribbon is a decal on surfaces that have already
  // established the depth of this pixel, and writing would let one building's
  // skirt occlude the neighbour's where the two overlap in a laneway -- the
  // overlap is deliberate (two walls a metre apart really do darken the metre
  // between them twice) and it only composes correctly if neither one hides the
  // other.
  material.depthWrite = false;

  // SINGLE-SIDED, and this is the one place in the client where the choice is
  // worth real money.
  //
  // It used to be `DoubleSide`, on the argument that the ribbon's winding was
  // derived rather than inherited and the failure mode of getting a flat
  // horizontal surface's facing wrong is silence. The argument was right and
  // the price was not visible from here: three renders a material that is
  // `transparent` AND `DoubleSide` AND not `forceSinglePass` in **two passes**
  // -- `Renderer._renderObjectDirect` sets `BackSide`, draws, sets `FrontSide`,
  // draws again -- so the largest slot in the build, 816,352 triangles over the
  // inner ring and the one drawn by the cheapest shader, was rasterised twice
  // and compiled two pipelines to do it.
  //
  // What made it safe to drop is that the winding is now guaranteed rather than
  // hoped for. `merge.orient_footprint` gives every footprint a
  // counter-clockwise ENU ring, `contact._outward_ring` keeps its own check on
  // top of that, and the ribbon comes out 99.29% up-facing measured over every
  // triangle in the ring. The 0.709% that do not are the bow-ties `contact.py`
  // documents at reflex corners, where the outer rail crosses itself and lays
  // the same patch of ground down twice with opposite winding -- culling one
  // half of that is not a loss, it is the doubled alpha going away.
  material.side = FrontSide;

  // The depth bias is load-bearing, more so than it is on the street slots.
  //
  // The ribbon sits 0.02 m over the footpath, which is the same clearance the
  // carriageway has over the terrain -- and `street.ts` records that 0.02 m
  // quantises to under one depth step somewhere around 180 m against this
  // camera's 0.1 m near plane. A road that loses that fight z-fights, which is
  // ugly; a *transparent* surface that loses it fails the depth test and
  // disappears, so the skirt would simply stop existing in the mid-distance
  // with nothing to see but buildings going back to looking pasted on.
  //
  // -8 rather than the streets' -2 because the bias has to cover more than the
  // paving: the ribbon's inner rail lies exactly *in the wall plane*, which is
  // coplanar with the wall in depth along that whole edge, and the ribbon has to
  // win there too. Eight depth quanta is around half a millimetre at 10 m and a
  // few centimetres at a kilometre -- it scales with the precision it is
  // correcting for, which a metric offset would not, and nothing else in the
  // world lies within it.
  material.polygonOffset = true;
  material.polygonOffsetUnits = -8;
  material.polygonOffsetFactor = 0;

  return material;
}
