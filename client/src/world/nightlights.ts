/**
 * The city after dark: a torch in the player's hand, a lamp on every second
 * power pole, and headlights on the traffic.
 *
 * `N` sets the clock to 21:30 and until this file existed that was the whole of
 * night: the sun goes under the horizon, `solarRig` takes the beam and the
 * bounce to zero, and what is left is `HEMISPHERE_NIGHT` -- 0.064 of luminance
 * on a wall, which is a silhouette. The windows in `facade.ts` light up and the
 * skyline reads beautifully from a distance, and then you try to walk down a
 * street and there is nothing there.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL AND WHAT IS NOT, AND WHY THE LINE IS WHERE IT IS.
 *
 * **Three real lights, forever.** One `SpotLight` for the torch and two
 * `PointLight`s that follow the two street lamps nearest the player. That
 * number is fixed at boot and is a *shader constant*, not a budget:
 * `LightsNode.customCacheKey` in three's WebGPU backend hashes `light.id` and
 * `light.castShadow` for every light on the render list, so the set of lights in
 * the scene is part of every material's cache key. Add a light, remove a light,
 * or hide one -- `_projectObject` skips an invisible object, so an invisible
 * light is not on the list at all -- and **every pipeline in the scene is
 * rebuilt and recompiled**, synchronously, inside the frame it happened.
 * `world/warmup.ts` exists because this project has already lost minutes of play
 * to exactly that, and a night feature that lit lamps as you approached them
 * would have been the most expensive possible version of it.
 *
 * So the three are constructed before `warmUpPipelines` runs, added to the scene
 * there and then, and never touched again except through `position`, `color` and
 * `intensity` -- none of which is in any cache key. By day their intensity is
 * exactly zero and they are still on the list, still in every shader, costing
 * their `N.L` and nothing else. `verifyNightLights` asserts the count, the
 * never-hidden flag and the day-zero intensity, and the boot log prints the
 * renderer's pipeline count so day and night can be compared by hand.
 *
 * **Everything else is additive geometry**, which is the same trick
 * `world/bike.ts` argues at length for its beacons and which is worth restating
 * here because it is why a city of five thousand lamps costs nothing: the frame
 * is tone mapped at `EXPOSURE` through `NeutralToneMapping`, so a night street
 * arrives at the blend at a few hundredths of scene-linear. Adding a fixed
 * amount of orange to that is a *glow*; adding the same amount to a sunlit
 * footpath at 4-5 is a tint nobody can see. The day/night term is the exposure,
 * and the only thing the shared `nightOpacity` uniform below has to do is fade
 * the sprites in over dusk so they do not appear the instant the sun clips the
 * horizon.
 *
 * ---------------------------------------------------------------------------
 * THE THREE POPULATIONS.
 *
 *   - **Street lamps.** A hashed 42% of the 12,695 surveyed power poles carry a
 *     luminaire, which is what a Sydney back street looks like -- the lights are
 *     on the power poles, roughly every second one, at 40-ish metre spacing. One
 *     geometry (ground pool, light shaft, lamp head), one material, one extra
 *     `InstancedMesh` per tile, built beside `buildTilePoles` off the same
 *     sidecar and destroyed with the tile. Two colours, hashed on a 150 m cell so
 *     a whole street converts at once -- see `LAMP_LED_COLOUR`.
 *
 *     **There are none in the CBD, and that is the data telling the truth.**
 *     `nearestLamps` finds zero within 400 m of Sydney Tower, because the CBD's
 *     distribution went underground decades ago and the surveyed `power=pole`
 *     set the pipeline ships reflects that. Real CBD lighting is on dedicated
 *     columns nobody has surveyed, and inventing a column set would be inventing
 *     world data. What lights the city centre at night here is what lights it in
 *     a photograph: thirty storeys of window behind it, the headlights, and the
 *     torch.
 *   - **Car lights.** Headlight cones, a road pool and tail glows on the moving
 *     traffic, driven from the poses `TrafficMovers` is already computing, so
 *     this costs one matrix compose per car and no simulation at all. Two
 *     geometries -- one anchored at the nose, one at the tail -- and one
 *     material, so it is one pipeline and two draws for the whole fleet. The
 *     44,000 parked cars stay dark, which is what a parked car is.
 *   - **The torch.** One real spot light with a slow two-tone sway and a short
 *     lag behind the view. See `torchSway`.
 *
 * Windows are **not** in this file and must not be. `facade.ts` has had a lit
 * window since it was written -- a hashed third of them come up on
 * `globals.nightFactor` with blinds, aircon units and a leak through the reveal
 * -- and adding a second emissive term over the top would double-count the one
 * part of the night that was already right.
 *
 * ---------------------------------------------------------------------------
 * SHADOWS: NONE OF THESE CAST ONE, AND THAT IS A MEASURED DECISION.
 *
 * The sun's shadow rig in `sky/sky.ts` is a 4096 map over a 440 m volume with a
 * bias solved against a 740 m depth range, and it is the only one in the build.
 * A second caster is a second full depth pass over the same scene every frame; a
 * *spot* shadow is that pass from a direction that changes every time the player
 * turns their head, so nothing in it can ever be cached. For a torch it also
 * buys very little -- the beam is centred on the view, so the things that would
 * shadow it are the things directly in front of you, which are lit anyway.
 *
 * What replaces it is falloff. `TORCH_DISTANCE` is 60 m with decay 2, so the
 * beam is down to 4x the ambient floor at 20 m and 1.4x at 35, and a wall a
 * street away is not being lit through the terrace in front of it because it is
 * not being lit at all. `LAMP_DISTANCE` is 32 m for the same reason: the light
 * that would have been occluded is the light that has already fallen off.
 */

import { uniform } from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Object3D,
  PointLight,
  Quaternion,
  SpotLight,
  Vector3,
  type Camera,
} from 'three/webgpu';

import {
  LAMP_DISTANCE,
  LAMP_LED_COLOUR,
  LAMP_REAL_COUNT,
  LAMP_SODIUM_COLOUR,
  LAMP_SODIUM_SHARE,
  NIGHT_FULL_ALTITUDE,
  NIGHT_ON_ALTITUDE,
  TORCH_ANGLE,
  TORCH_COLOUR,
  TORCH_DECAY,
  TORCH_DISTANCE,
  TORCH_PENUMBRA,
  nightLevel,
  nightRig,
} from '../sky/calibration.ts';
import { NOMINAL_HEIGHT, type TilePower } from './power.ts';
import { CAR_BODY_SIZE, CAR_STAGE_PARKED_IN, CAR_STAGE_PARKED_OUT, type CarPose } from '../game/traffic.ts';

type Rgb = readonly [number, number, number];

// --- The shared clock ---------------------------------------------------------

/**
 * How far into the night every additive sprite in this file is, 0 to 1.
 *
 * **One uniform for the whole city.** Every night material's `opacityNode` is
 * this and nothing else, so a lamp in Alexandria and a headlight in the CBD fade
 * up on the same frame and there is no second threshold anywhere. It is written
 * once a frame by `NightLights.update` from `nightLevel(solarAltitude)`, which is
 * the same function the real lights' intensity comes from -- so there is exactly
 * one dusk ramp in the build and `sky/calibration.ts` owns it.
 */
const nightOpacity = /*#__PURE__*/ uniform(0);

/**
 * Below this the night geometry is hidden outright rather than drawn at zero
 * alpha.
 *
 * Additive blending at alpha zero is a no-op *visually* and is not a no-op in
 * the frame: the triangles are still transformed, the fragments are still
 * rasterised and blended, and a lamp's ground pool is 130 square metres of road.
 * Across the resident tiles that is a measurable amount of fill to spend on
 * nothing at all. So the meshes carry `visible = false` through the whole day
 * and are switched on once, at dusk, by `TileStreamer.setNightLightsVisible`.
 *
 * Toggling `visible` on a *mesh* costs nothing and recompiles nothing -- it is
 * only a **light** whose visibility is in a cache key. The threshold is tiny
 * rather than zero so that the switch happens while the sprites are still
 * invisible against the sky: at 0.004 of opacity nothing has a pixel.
 */
export const NIGHT_VISIBLE_LEVEL = 0.004;

// --- The torch ----------------------------------------------------------------

/**
 * How fast the beam catches up with the view, seconds.
 *
 * A torch bolted rigidly to the camera is the thing that reads as *wrong* -- the
 * light is perfectly still relative to a view that is never still, so the beam
 * looks painted onto the screen rather than thrown by a hand. What sells it is
 * this lag: the aim is an exponential chase toward the camera's forward, so a
 * fast turn sweeps the beam across the wall a fraction of a second behind the
 * eye and it catches up as you settle.
 *
 * 0.075 s is short. It has to be: at a 180 degrees-per-second turn the beam
 * trails the view by 13 degrees, which is most of the cone's half-angle, and any
 * longer starts to feel like aiming a light that does not want to go where you
 * are looking. The order said *convenient* first.
 */
const TORCH_LAG = 0.075;

/**
 * Where the torch sits relative to the eye, in camera axes: right, up, forward.
 *
 * **Up and slightly left, which is not where a hand is, and the reason is the
 * two viewmodels.** A spot light at the eye puts the first-person bat about
 * 80 cm from a source of 110 candela -- 170 of irradiance on a pale willow
 * blade, which is a solid white shape across a third of the frame. The obvious
 * fix, putting the torch in the off hand, was tried and simply moved the problem
 * across the screen: the bat came right and the *football* went white in the
 * bottom-left corner instead.
 *
 * Both viewmodels live at the bottom corners, so the one direction with nothing
 * of the player's own in it is up. At 16 cm over the eye the two of them sit
 * 30-38 degrees off the beam axis, outside `TORCH_ANGLE`'s 24 and into the
 * penumbra, so both catch the beam's edge -- lit, shaped, and neither of them
 * the brightest thing in Sydney. There is no per-object way to do this
 * properly: three's node lighting has no per-object light mask, so a light in
 * the scene is a light on every material in it, and geometry is the only lever.
 *
 * The 10 cm of lateral offset is what is left of a hand. It is small and it
 * still earns its place: a light exactly on the view axis lights every surface
 * square-on and flattens everything it touches, which is the "head torch in a
 * video game" look, and a few centimetres across is enough that a kerb, a step
 * and a wheelie bin each throw a short shadow away from the beam.
 *
 * The forward offset is small on purpose and was nearly much larger. Pushing the
 * cone's apex a metre ahead is the other way to get a viewmodel out of the beam
 * -- behind the apex, where a spot light reaches nothing -- and it fails the
 * moment a player walks into a wall: the apex ends up *inside* the wall, the
 * surface in front of the camera is behind the light, and pressing against a
 * terrace turns the screen black. 10 cm cannot do that at any player radius.
 */
const TORCH_OFFSET: Rgb = [-0.1, 0.16, 0.1];

/**
 * The sway, as four sines: two on yaw, two on pitch, amplitudes in **degrees**
 * and rates in **hertz**.
 *
 * The whole design brief for this was three words -- *shaky but convenient
 * (fairly stable)* -- and the reading taken here is that a shake which makes you
 * work is a bug however realistic it is. So what this models is not a tremor. A
 * physiological hand tremor is 8-12 Hz at small amplitude and reads on screen as
 * *noise*, which at 60 fps aliases into a jitter that looks like a dropped frame
 * rather than like a hand. What a held torch actually does over a second or two
 * is **drift**: the arm settles, the wrist rolls, the walk cycle pushes it
 * around. That is well under 1 Hz and it is what is here.
 *
 * Four terms rather than two because two sines beat visibly -- the pattern
 * repeats on the difference of their rates and a player watching a wall for
 * thirty seconds can see it come round. Four incommensurate rates have a period
 * measured in hours.
 *
 * The amplitudes sum to 0.96 degrees of yaw and 0.74 of pitch, so the worst-case
 * excursion is 1.21 degrees, which at 15 m moves the hotspot 32 cm. That is a
 * beam that is visibly alive against a brick wall and is never somewhere you did
 * not point it. `TORCH_SWAY_MAX_DEG` bounds it and `verifyNightLights` sweeps a
 * minute of it to make sure the bound is real rather than asserted.
 */
const SWAY_YAW: ReadonlyArray<readonly [number, number, number]> = [
  // amplitude (deg), rate (Hz), phase (rad)
  [0.62, 0.31, 0.0],
  [0.34, 0.73, 1.7],
];
const SWAY_PITCH: ReadonlyArray<readonly [number, number, number]> = [
  [0.48, 0.41, 0.4],
  [0.26, 0.97, 2.9],
];

/**
 * How much bigger the sway gets when the player is moving, as a multiplier on
 * the amplitudes above.
 *
 * Walking with a torch is not standing with a torch, and the difference is the
 * one bit of this that a player will feel without being able to name. At a full
 * sprint the excursion goes from 1.2 degrees to 2.3 -- still under a metre at
 * 15 m, still nowhere near having to fight it, and enough that stopping to look
 * at something is *visibly* steadier than running past it.
 */
const SWAY_MOVE_GAIN = 0.9;
/** Speed, m/s, at which `SWAY_MOVE_GAIN` is fully applied. A sprint. */
const SWAY_FULL_SPEED = 7;

/**
 * The envelope the sway is not allowed to leave, and the numbers
 * `verifyNightLights` measures against.
 *
 * Both bounds exist because "fairly stable" is a claim that can rot silently:
 * somebody doubles an amplitude to make it read better in a screenshot and the
 * game becomes unpleasant to play in a way nobody attributes to this file. The
 * *rate* bound is the one that matters more -- 2.6 degrees of slow drift is
 * atmosphere and 2.6 degrees of fast jitter is motion sickness -- so the check
 * measures the peak angular velocity as well as the peak angle.
 */
export const TORCH_SWAY_MAX_DEG = 2.6;
export const TORCH_SWAY_MAX_RATE_DEG = 8;

/**
 * The intensity flicker: amplitude and rate, as a fraction of full brightness.
 *
 * Tiny and deliberately so. A torch beam does not flicker; what it does is
 * change apparent brightness slightly as the hand rolls the hotspot across a
 * surface, which is a geometric effect this is standing in for. 3.5% at 1.31 Hz
 * plus 2% at a slow 0.17 Hz is under a code value of display change on any
 * surface in the frame and is still enough that the light is never *dead*
 * steady, which is the tell.
 */
const FLICKER: ReadonlyArray<readonly [number, number, number]> = [
  [0.035, 1.31, 0.0],
  [0.02, 0.17, 2.2],
];
export const TORCH_FLICKER_MAX = 0.06;

/** What the torch is doing at one instant. Pure; see `torchSway`. */
export interface TorchSway {
  /** Radians, left/right off the view direction. */
  yaw: number;
  /** Radians, up/down off the view direction. */
  pitch: number;
  /** Multiplier on intensity, near 1. */
  gain: number;
}

/**
 * The sway at time `t` seconds, for a player moving at `speed` m/s.
 *
 * Pure and framework-free, so `verifyNightLights` can sweep a minute of it in a
 * loop rather than asserting the constants and hoping. Nothing here reads a
 * clock or a random number: two players standing in the same place at the same
 * moment have their torches in exactly the same place, which is not a
 * requirement of anything today and costs nothing to keep true.
 */
export function torchSway(t: number, speed = 0): TorchSway {
  const gainScale = 1 + SWAY_MOVE_GAIN * Math.min(Math.max(speed / SWAY_FULL_SPEED, 0), 1);
  const sum = (terms: ReadonlyArray<readonly [number, number, number]>): number => {
    let out = 0;
    for (const [amplitude, rate, phase] of terms) {
      out += amplitude * Math.sin(t * rate * Math.PI * 2 + phase);
    }
    return out;
  };
  let flicker = 1;
  for (const [amplitude, rate, phase] of FLICKER) {
    flicker += amplitude * Math.sin(t * rate * Math.PI * 2 + phase);
  }
  return {
    yaw: ((sum(SWAY_YAW) * gainScale) / 180) * Math.PI,
    pitch: ((sum(SWAY_PITCH) * gainScale) / 180) * Math.PI,
    gain: flicker,
  };
}

// --- The street lamp ----------------------------------------------------------

/**
 * What fraction of the pole set carries a luminaire.
 *
 * Sydney hangs street lights at roughly 40 m in a residential street and the
 * surveyed poles in `pipeline/sydney/power.py` sit at a median of about 38 m
 * apart, so a bit under half of them is the right answer -- every second pole,
 * with the hash breaking the regularity the way a real street's does at corners
 * and long spans.
 *
 * Hashed on the pole's own sidecar seed and its position, so it is stable across
 * a tile eviction and reload: a lamp that moved when you walked away and came
 * back would be the most obvious possible bug and the cheapest to avoid.
 */
const LAMP_SHARE = 0.42;

/**
 * The cell, metres, that decides LED or sodium. See `LAMP_LED_COLOUR`.
 *
 * 150 m is about a block. Hashing the *cell* rather than the pole is what makes
 * a run of lights down one street agree -- which is how the conversion actually
 * happened, a crew at a time -- instead of a salt-and-pepper mix that reads as a
 * random number generator.
 */
const LAMP_COLOUR_CELL = 150;

/**
 * Where the luminaire hangs, as a fraction of the pole's height, and how far it
 * reaches out from the shaft.
 *
 * 0.855 puts it at 8.98 m on a nominal pole, which is just under the crossarm at
 * 9.95 and clear of the insulator stubs -- a lamp bracket goes below the
 * conductors, always, because a maintenance crew has to be able to get at it.
 *
 * The 0.9 m of outreach is along the pole's local +X, which `power.deriveYaw`
 * has already aimed **across the street** (it is the crossarm's axis, and a
 * crossarm lies across the road because the conductors run along it). Which of
 * the two directions along that axis is the road is not in the data and is not
 * derivable from it -- the pipeline sends poles and spans, not kerb lines -- so
 * this always takes +X. On half the poles that is a lamp over the road and on
 * the other half it is a lamp over the front fence, and at 0.9 m from a 0.16 m
 * shaft the difference is not a thing anybody can see. Inventing a kerb side
 * would have been a guess with a worse failure mode: get it backwards and every
 * lamp in a suburb is in somebody's garden.
 */
const LAMP_HEIGHT_FRACTION = 0.855;
const LAMP_OUTREACH = 0.9;

/**
 * The pool of light on the road: radius in metres and how high it floats.
 *
 * 6.5 m against a lamp 9 m up is a 72-degree cone, which is a real luminaire's
 * beam and is also the width that makes a street read as a chain of pools rather
 * than as a continuous wash -- the dark between two lamps is what says the light
 * is coming from somewhere.
 *
 * **The pool is a shallow cone, not a disc, and it floats 30 cm at the middle
 * rising to 1.15 m at the rim.** Those are absurd numbers for a light on a road
 * until you know what they are fixing, and this cost two rounds of looking:
 *
 *   1. A pole's `groundY` in the sidecar is the **terrain**, because a pole is
 *      set into a hole through the paving. The street furniture's is the
 *      **paving**, which `pipeline/sydney` has already raised by the footpath's
 *      15 cm. Measured in a real session, the pole base under the player's feet
 *      in Barwon Park Road sits **30 cm below the surface being walked on**. A
 *      pool at terrain + 3 cm is therefore a decimetre *inside* the footpath,
 *      and no polygon offset can save it -- an offset is a depth bias of a few
 *      units, not a decimetre of geometry. The symptom was a street whose lamps
 *      lit the walls and put nothing at all on the ground, which reads as a
 *      taste decision rather than as an occluded surface. It took boosting the
 *      material to 6x and watching the shaft blaze while the road stayed black
 *      to prove the pool was being drawn at all.
 *   2. The disc is flat and Sydney is not. Over a 6.5 m radius a 6% grade is
 *      40 cm, so a pool that merely cleared the paving at its centre went back
 *      under it on the uphill side. Tilting the rim up turns that from a
 *      cliff-edge into slack: the cone rises faster than any street does, so the
 *      whole pool clears whatever the ground is doing under it.
 *
 * Neither number shows, and that is not luck -- it is what an additive gradient
 * with no hard edge and no contact cue buys. There is no shadow to detach, no
 * silhouette to float, and the rim is where the brightness has already reached
 * zero. The 4.8 degrees of tilt is below what any Sydney street reads as level.
 *
 * The polygon offset stays, and is now doing the job it was always for rather
 * than standing in for a height error: `world/contact.ts`'s argument that a
 * transparent surface which loses the depth fight does not z-fight, it
 * *disappears*.
 */
const POOL_RADIUS = 6.5;
const POOL_LIFT = 0.3;
/** How much higher the rim sits than the middle. See the header above. */
const POOL_RIM_LIFT = 0.85;
const POOL_SEGMENTS = 20;

/**
 * The pool's falloff, as `[radius fraction, brightness]`.
 *
 * Front-loaded, on `world/bike.ts`'s measured lesson about `NeutralToneMapping`:
 * the curve compresses its top hard, so a gentle ramp puts most of the disc
 * within a few code values of itself and crams the entire visible gradient into
 * the outer quarter -- which is a hard edge, not a fade. Spending the brightness
 * early puts the gradient where the curve is still steep.
 *
 * The one departure from the bike's disc is the dip at the very centre. A
 * luminaire is 9 m up, so the brightest point of a real pool is not a spike --
 * the inverse-square difference between the point under the lamp and a point 2 m
 * away is 5%, not 100% -- and a disc with a hot core reads as a spotlight aimed
 * at the road rather than as a lamp hanging over it. Flat to a fifth of the
 * radius, then away.
 *
 * The last stop is exactly zero, which under an additive blend is what an edge
 * is.
 */
const POOL_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.2, 0.95],
  [0.42, 0.62],
  [0.68, 0.28],
  [0.86, 0.09],
  [1, 0],
];

/** How bright the pool is, linear, before `instanceColor` tints it to the lamp's hue. */
const POOL_LEVEL = 0.5;

/**
 * The shaft of light between the lamp and its pool: half-width at the head and
 * at the ground, and how bright it is.
 *
 * Sydney in February is humid and there is always something in the air, so a
 * luminaire does have a visible cone under it -- but it is *faint*, and this is
 * the term with the highest fill cost per unit of readability in the file. It is
 * a 9 m tall, 4.4 m wide sheet and there can be sixty of them in frame, so it
 * runs at a tenth of the pool's brightness and is narrow enough that it reads as
 * a shaft rather than as a curtain. Three planes crossing at 60 degrees, like
 * the bike beacon's, so it presents the same width from any bearing.
 */
const SHAFT_HALF_HEAD = 0.28;
const SHAFT_HALF_FOOT = 2.2;
const SHAFT_LEVEL = 0.1;
const SHAFT_PLANES = 3;

/**
 * The lamp head itself: how big the glowing blob is and how bright.
 *
 * This is the part that has to work at 400 m, so it is the brightest thing in
 * the geometry by a factor of five -- at that range it is two pixels and two
 * pixels only read if they are near the top of the tone curve. Three quads
 * crossing on the three axes, which is a cheap approximation to a billboard that
 * costs no per-frame work at all: from any bearing at least one of them presents
 * most of its area, and the pair that are edge-on contribute the thin bright
 * line a bare lamp actually has.
 */
const HEAD_HALF = 0.34;
const HEAD_LEVEL = 2.6;

// --- The car ------------------------------------------------------------------

/**
 * How many moving cars can be lit at once.
 *
 * `world/cars.ts` measured 177 cars at the densest point in the extent inside
 * `TRAFFIC_DRAW_RADIUS` and sized its own buffers at 384 for the headroom. This
 * is the same ceiling for the same reason -- the thing that overflows it is a
 * pipeline headway change rather than anything in the renderer -- and it costs
 * 25 kB per set. `verifyNightLights` asserts it is at least the fleet ceiling,
 * so the two cannot drift apart into cars that are drawn and not lit.
 */
export const CAR_LIGHT_CAPACITY = 384;

/**
 * The headlight beam: where it starts on the car, how far it throws, and how
 * wide it gets.
 *
 * 11 m of throw and 1.5 m of half-width at the tip is a low beam, which is what
 * a car in a lit street has on. It is aimed 1.6 degrees down, which is the real
 * figure -- a low beam is aimed at the road about 30 m ahead so it does not
 * dazzle -- and the visible consequence is that the cone lands on the road
 * rather than running off to the horizon, which is what makes a car read as
 * lighting the street instead of shining a laser down it.
 *
 * Two crossed planes per lamp rather than a cone of revolution: a real beam seen
 * from the side is a wedge and seen head-on is a blob, and two planes give both
 * for 8 triangles. The `world/bike.ts` beacon makes the same call and its header
 * carries the full argument about `DoubleSide` costing two passes in this
 * renderer, which is why every plane here is emitted twice with opposite
 * winding instead.
 */
const BEAM_LENGTH = 11;
const BEAM_HALF_START = 0.14;
const BEAM_HALF_END = 1.5;
const BEAM_DROP = 0.31;
/** Where the lamps sit on the nose: height above the road and half-spacing. */
const LAMP_Y = 0.62;
const LAMP_HALF_SPACING = 0.62;

/**
 * The gradient along a headlight beam, `[length fraction, brightness]`.
 *
 * Both ends reach exactly zero and the far one is the interesting half. A beam
 * that stopped at any brightness above zero has a **flat bright cut** across it
 * 11 m in front of the car, which at night is the single most artificial thing
 * this file could draw -- it reads as a box, not as light. The near end is zero
 * for `world/bike.ts`'s reason: the plane's own foot is a straight edge and an
 * additive blend cannot hide one that is lit.
 */
const BEAM_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.04, 1],
  [0.3, 0.62],
  [0.62, 0.26],
  [1, 0],
];

/** Headlight colour, linear. A halogen low beam, not the blue-white of an LED conversion. */
const BEAM_COLOUR: Rgb = [1.0, 0.93, 0.74];
/**
 * How bright a beam sheet is.
 *
 * Low, and lower than it first looked right at, because this term is judged at
 * two wildly different distances and the near one wins. At 30 m -- a car coming
 * down the street, which is what these are *for* -- a beam is a few dozen pixels
 * and any reasonable level reads. At 2 m it is most of the frame: the sheets are
 * flat polygons and a player standing beside a passing car is looking at one
 * nearly face-on, so whatever this number is, it is what a quarter of the screen
 * becomes. At 0.34 that was a white wall with a straight edge down it. 0.22
 * still carries the street and leaves the close pass as a glare you can see
 * through, which is what being beside a headlight actually is.
 */
const BEAM_LEVEL = 0.22;
/** And the lens itself, which is small, hot and the thing you see at 300 m. */
const HEADLAMP_HALF = 0.15;
const HEADLAMP_LEVEL = 2.2;

/**
 * The road under the car, as an elongated pool from the bumper forwards.
 *
 * Short -- 8 m rather than the beam's 11 -- and that is a terrain decision
 * rather than a lighting one. The pool is a flat sheet lying at the car's own
 * road height, and the road ahead of a car on a Sydney hill is not at that
 * height: at a 6% grade 8 m of reach is 48 cm of error. Under an additive blend
 * with `depthWrite` off the two failure modes are wildly different -- a pool
 * that sinks below the road simply loses the depth test and disappears, which is
 * invisible, and one that floats is a soft patch of light a few centimetres
 * proud of the asphalt, which is also invisible. 8 m keeps both inside the range
 * where "invisible" is true.
 *
 * It also **rises along its length**, for the street lamps' reason and with the
 * same asymmetry: the near end sits close to the road, because that is where the
 * pool is brightest and where the car's own y is exactly right, and the far end
 * is given slack, because that is where the road has had eight metres to go
 * somewhere else. 26 cm over 7 m is 2 degrees, which is under the camber of the
 * road it is lying on.
 */
const CAR_POOL_START = 1.0;
const CAR_POOL_END = 8.0;
const CAR_POOL_HALF_START = 0.55;
const CAR_POOL_HALF_END = 2.4;
const CAR_POOL_LIFT = 0.14;
const CAR_POOL_RISE = 0.26;
const CAR_POOL_LEVEL = 0.42;
const CAR_POOL_SEGMENTS = 8;

/**
 * The tail lights: colour, size and level.
 *
 * Red, small and much dimmer than the headlights, because a tail light is a
 * 5 W marker and a headlight is a 55 W projector -- and because a street full of
 * receding cars with bright red glows on them reads as a brake-light jam rather
 * than as traffic. No beam, no pool: a tail light does not light the road and
 * drawing one that did would be the kind of detail that is wrong in a way people
 * feel without seeing.
 */
const TAIL_COLOUR: Rgb = [1.0, 0.1, 0.05];
const TAIL_HALF = 0.17;
const TAIL_LEVEL = 0.9;
const TAIL_Y = 0.66;
const TAIL_HALF_SPACING = 0.66;

// --- Geometry construction ----------------------------------------------------

/** Accumulator for the little procedural meshes below. Vertex colour is the brightness. */
class Emissive {
  readonly position: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  /**
   * One quad, both windings.
   *
   * Two triangles emitted twice with opposite winding rather than one quad on a
   * `DoubleSide` material, which is `world/contact.ts`'s measured finding: a
   * two-sided transparent material is two passes in this renderer, where a
   * mirrored pair is one draw of which the rasteriser discards exactly half.
   */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colours: readonly [Rgb, Rgb, Rgb, Rgb],
  ): void {
    const base = this.position.length / 3;
    for (const [p, col] of [
      [a, colours[0]],
      [b, colours[1]],
      [c, colours[2]],
      [d, colours[3]],
    ] as const) {
      this.position.push(p[0], p[1], p[2]);
      this.colour.push(col[0], col[1], col[2]);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /**
   * One quad, **one** winding, for the surfaces that are only ever seen from
   * one side.
   *
   * That is exactly the ground pools and nothing else: a player is above the
   * road, always, so the underside of a pool is never in frame and emitting it
   * would double the triangle count of the most numerous thing in the file for a
   * face nobody can reach. The sheets that stand up in the air need both, which
   * is what `quad` is for.
   */
  quadUp(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colours: readonly [Rgb, Rgb, Rgb, Rgb],
  ): void {
    const base = this.position.length / 3;
    for (const [p, col] of [
      [a, colours[0]],
      [b, colours[1]],
      [c, colours[2]],
      [d, colours[3]],
    ] as const) {
      this.position.push(p[0], p[1], p[2]);
      this.colour.push(col[0], col[1], col[2]);
    }
    // `(a, b, c)` with `cross(b - a, c - a)` pointing up, which is the winding
    // three's WebGPU backend calls front (`GPUFrontFace.CCW` for an unflipped
    // `FrontSide` material). Every caller below lists its corners so that this
    // comes out +Y, and `verifyNightLights` re-derives the face normals rather
    // than trusting it -- a pool wound the wrong way is not a subtle bug, it is
    // an invisible one.
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colour), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    g.computeBoundingSphere();
    return g;
  }
}

const scaled = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
const WHITE: Rgb = [1, 1, 1];

/** Sample a `[stop, value]` ramp. Linear between stops, clamped outside them. */
function ramp(stops: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, y1] = stops[i];
    if (t <= x1) {
      const [x0, y0] = stops[i - 1];
      const span = x1 - x0;
      return span <= 0 ? y1 : y0 + ((y1 - y0) * (t - x0)) / span;
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * A flat disc lying in the XZ plane with a radial brightness ramp, centred on
 * `(cx, cz)` at height `y`.
 *
 * Emitted as a triangle fan from a centre vertex out through the ramp's own
 * stops, so the gradient is carried in vertex colour and interpolated by the
 * rasteriser -- no texture, no sampler, no mip chain. `world/bike.ts` sets out
 * why that is the right call for a soft-edged additive shape: black is invisible
 * under an additive blend, so a colour ramp to black *is* the soft edge.
 */
function disc(
  m: Emissive,
  cx: number,
  y: number,
  cz: number,
  radius: number,
  stops: ReadonlyArray<readonly [number, number]>,
  level: number,
  segments: number,
  /** How much higher the rim sits than the middle. See `POOL_RIM_LIFT`. */
  rise = 0,
): void {
  const at = (t: number): number => y + rise * t;
  for (let ring = 1; ring < stops.length; ring++) {
    const t0 = stops[ring - 1][0];
    const t1 = stops[ring][0];
    const r0 = t0 * radius;
    const r1 = t1 * radius;
    const y0 = at(t0);
    const y1 = at(t1);
    const c0 = scaled(WHITE, stops[ring - 1][1] * level);
    const c1 = scaled(WHITE, stops[ring][1] * level);
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      m.quadUp(
        [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0],
        [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0],
        [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1],
        [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1],
        [c0, c0, c1, c1],
      );
    }
  }
}

/** Three quads crossing on the three axes at a point: a billboard with no per-frame cost. */
function blob(m: Emissive, x: number, y: number, z: number, half: number, colour: Rgb): void {
  const c: readonly [Rgb, Rgb, Rgb, Rgb] = [colour, colour, colour, colour];
  m.quad([x - half, y - half, z], [x + half, y - half, z], [x + half, y + half, z], [x - half, y + half, z], c);
  m.quad([x, y - half, z - half], [x, y - half, z + half], [x, y + half, z + half], [x, y + half, z - half], c);
  m.quad([x - half, y, z - half], [x + half, y, z - half], [x + half, y, z + half], [x - half, y, z + half], c);
}

/** The lamp, its shaft and its pool, in pole-local metres at `NOMINAL_HEIGHT`. */
function buildStreetLamp(): BufferGeometry {
  const m = new Emissive();
  const headY = NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION;

  // The pool, under the luminaire rather than under the pole -- the same
  // `LAMP_OUTREACH` the head is offset by, so the light and the light it casts
  // are in the same place. `verifyNightLights` asserts exactly that.
  disc(
    m,
    LAMP_OUTREACH,
    POOL_LIFT,
    0,
    POOL_RADIUS,
    POOL_FALLOFF,
    POOL_LEVEL,
    POOL_SEGMENTS,
    POOL_RIM_LIFT,
  );

  // The shaft. Three planes through the axis at 60 degrees, both windings, dim.
  // Zero at the top and the bottom: the top edge would otherwise be a bright
  // line cutting the sky under the lamp head, and the bottom one a ring where it
  // meets a pool that is already the brightest thing on the road.
  const dark: Rgb = [0, 0, 0];
  const lit = scaled(WHITE, SHAFT_LEVEL);
  for (let p = 0; p < SHAFT_PLANES; p++) {
    const a = (p / SHAFT_PLANES) * Math.PI;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    m.quad(
      [LAMP_OUTREACH - ux * SHAFT_HALF_FOOT, POOL_LIFT, -uz * SHAFT_HALF_FOOT],
      [LAMP_OUTREACH + ux * SHAFT_HALF_FOOT, POOL_LIFT, uz * SHAFT_HALF_FOOT],
      [LAMP_OUTREACH + ux * SHAFT_HALF_HEAD, headY, uz * SHAFT_HALF_HEAD],
      [LAMP_OUTREACH - ux * SHAFT_HALF_HEAD, headY, -uz * SHAFT_HALF_HEAD],
      [dark, dark, lit, lit],
    );
  }

  // And the luminaire.
  blob(m, LAMP_OUTREACH, headY, 0, HEAD_HALF, scaled(WHITE, HEAD_LEVEL));
  return m.build('street_lamp');
}

/** The headlights, their beams and the road pool, anchored at the nose centre. */
function buildCarHeadLights(): BufferGeometry {
  const m = new Emissive();

  for (const side of [-1, 1]) {
    const z = side * LAMP_HALF_SPACING;
    blob(m, 0, LAMP_Y, z, HEADLAMP_HALF, scaled(BEAM_COLOUR, HEADLAMP_LEVEL));

    // Two crossed planes down the beam, each stepped through `BEAM_STOPS` so the
    // gradient is in vertex colour. Four segments is enough for a ramp with five
    // stops; the shape is a wedge and the eye has nothing to compare it against.
    for (let s = 0; s < BEAM_STOPS.length - 1; s++) {
      const [t0] = BEAM_STOPS[s];
      const [t1] = BEAM_STOPS[s + 1];
      const c0 = scaled(BEAM_COLOUR, ramp(BEAM_STOPS, t0) * BEAM_LEVEL);
      const c1 = scaled(BEAM_COLOUR, ramp(BEAM_STOPS, t1) * BEAM_LEVEL);
      const at = (t: number) => ({
        x: t * BEAM_LENGTH,
        y: LAMP_Y - t * BEAM_DROP,
        half: BEAM_HALF_START + (BEAM_HALF_END - BEAM_HALF_START) * t,
      });
      const a = at(t0);
      const b = at(t1);
      // The horizontal sheet, in three strips so it fades at its **sides** as
      // well as its ends.
      //
      // One quad was the first cut and it had a visible straight edge running
      // down the road either side of every car -- the gradient ran along the
      // beam and not across it, so where the sheet met the asphalt it ended at
      // full brightness on a ruled line. A headlight beam on a road has no such
      // line. Two extra strips per segment is 8 more triangles a lamp and it is
      // the difference between light and a decal.
      const edge: Rgb = [0, 0, 0];
      m.quad(
        [a.x, a.y, z - a.half],
        [a.x, a.y, z - a.half * 0.4],
        [b.x, b.y, z - b.half * 0.4],
        [b.x, b.y, z - b.half],
        [edge, c0, c1, edge],
      );
      m.quad(
        [a.x, a.y, z - a.half * 0.4],
        [a.x, a.y, z + a.half * 0.4],
        [b.x, b.y, z + b.half * 0.4],
        [b.x, b.y, z - b.half * 0.4],
        [c0, c0, c1, c1],
      );
      m.quad(
        [a.x, a.y, z + a.half * 0.4],
        [a.x, a.y, z + a.half],
        [b.x, b.y, z + b.half],
        [b.x, b.y, z + b.half * 0.4],
        [c0, edge, edge, c1],
      );
      // The vertical sheet, at 60% of the width -- a low beam is wider than it
      // is tall, which is the whole point of a low beam -- and split three ways
      // for the horizontal one's reason. Its *bottom* edge is the one that
      // matters: the beam is aimed down, so eleven metres out the sheet has
      // dropped through the road surface, and an unfaded edge there is a bright
      // line ruled across the asphalt in front of every car in the city.
      const av = a.half * 0.6;
      const bv = b.half * 0.6;
      m.quad(
        [a.x, a.y - av, z],
        [a.x, a.y - av * 0.4, z],
        [b.x, b.y - bv * 0.4, z],
        [b.x, b.y - bv, z],
        [edge, c0, c1, edge],
      );
      m.quad(
        [a.x, a.y - av * 0.4, z],
        [a.x, a.y + av * 0.4, z],
        [b.x, b.y + bv * 0.4, z],
        [b.x, b.y - bv * 0.4, z],
        [c0, c0, c1, c1],
      );
      m.quad(
        [a.x, a.y + av * 0.4, z],
        [a.x, a.y + av, z],
        [b.x, b.y + bv, z],
        [b.x, b.y + bv * 0.4, z],
        [c0, edge, edge, c1],
      );
    }
  }

  // The road pool, as a tapered strip from the bumper forward. Brightest a third
  // of the way along rather than at the bumper: a low beam is aimed down the
  // road, so the hot part of the pool is ahead of the car and not under it.
  for (let s = 0; s < CAR_POOL_SEGMENTS; s++) {
    const t0 = s / CAR_POOL_SEGMENTS;
    const t1 = (s + 1) / CAR_POOL_SEGMENTS;
    const at = (t: number) => ({
      x: CAR_POOL_START + (CAR_POOL_END - CAR_POOL_START) * t,
      y: CAR_POOL_LIFT + CAR_POOL_RISE * t,
      half: CAR_POOL_HALF_START + (CAR_POOL_HALF_END - CAR_POOL_HALF_START) * t,
      level:
        ramp(
          [
            [0, 0.25],
            [0.3, 1],
            [0.7, 0.42],
            [1, 0],
          ],
          t,
        ) * CAR_POOL_LEVEL,
    });
    const a = at(t0);
    const b = at(t1);
    const c0 = scaled(BEAM_COLOUR, a.level);
    const c1 = scaled(BEAM_COLOUR, b.level);
    const edge: Rgb = [0, 0, 0];
    // Three strips across, so the pool fades at its sides as well as its ends --
    // a rectangle of light with hard edges down the gutters would be a decal.
    m.quadUp([a.x, a.y, -a.half], [a.x, a.y, -a.half * 0.45],
      [b.x, b.y, -b.half * 0.45], [b.x, b.y, -b.half], [edge, c0, c1, edge]);
    m.quadUp([a.x, a.y, -a.half * 0.45], [a.x, a.y, a.half * 0.45],
      [b.x, b.y, b.half * 0.45], [b.x, b.y, -b.half * 0.45], [c0, c0, c1, c1]);
    m.quadUp([a.x, a.y, a.half * 0.45], [a.x, a.y, a.half],
      [b.x, b.y, b.half], [b.x, b.y, b.half * 0.45], [c0, edge, edge, c1]);
  }

  return m.build('car_headlights');
}

/** The tail lights, anchored at the tail centre. Two blobs and nothing else. */
function buildCarTailLights(): BufferGeometry {
  const m = new Emissive();
  for (const side of [-1, 1]) {
    blob(m, 0, TAIL_Y, side * TAIL_HALF_SPACING, TAIL_HALF, scaled(TAIL_COLOUR, TAIL_LEVEL));
  }
  return m.build('car_taillights');
}

/**
 * The one material every additive night sprite of a given kind wears.
 *
 * Unlit, vertex-coloured, additive, depth-tested and never depth-written --
 * every one of which is `world/bike.ts`'s glow disc verbatim and for the same
 * reasons, and the depth test is the load-bearing one: it is what keeps a lamp
 * on the far side of a warehouse inside the warehouse, and what stops sixty
 * pools compositing into a haze over the whole frame.
 *
 * `opacityNode` is the shared `nightOpacity` uniform and nothing else. That is
 * the whole day/night term for every sprite in this file: one uniform, written
 * once a frame, from the one ramp in `sky/calibration.ts`.
 */
function nightMaterial(name: string, offset: boolean): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.name = name;
  material.vertexColors = true;
  material.color = new Color(1, 1, 1);
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = FrontSide;
  material.opacityNode = nightOpacity;
  if (offset) {
    // The ground pools lie flat on the road and have to keep winning the depth
    // test at range. `world/contact.ts` works out why a metric lift is not
    // enough on its own and why -8 units is: a transparent surface that loses
    // does not z-fight, it disappears.
    material.polygonOffset = true;
    material.polygonOffsetUnits = -8;
    material.polygonOffsetFactor = 0;
  }
  return material;
}

/** Deterministic hash, author-time only. `power.ts`'s, so the two agree by construction. */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * Does this pole carry a luminaire, and is it sodium?
 *
 * Split out and exported so `verifyNightLights` can measure the share over a
 * synthetic pole set rather than asserting `LAMP_SHARE` and hoping the hash is
 * uniform -- a hash that clumped would put every lamp in the city on one street
 * and the constant above would still read 0.42.
 */
export function lampAt(seed: number, x: number, z: number): { lit: boolean; sodium: boolean } {
  const lit = hash(seed, Math.round(x * 8), Math.round(z * 8), 23) < LAMP_SHARE;
  const cell = hash(Math.floor(x / LAMP_COLOUR_CELL), Math.floor(z / LAMP_COLOUR_CELL), 41);
  return { lit, sodium: cell < LAMP_SODIUM_SHARE };
}

/**
 * One geometry and one material for every street lamp in the city.
 *
 * Stated as an invariant rather than as an implementation detail, on
 * `world/bike.ts`'s terms: a material per lamp would be five thousand
 * `MeshBasicNodeMaterial`s and a pipeline compile on whichever frame the player
 * first turned a corner onto a lit street.
 */
export class StreetLampAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshBasicNodeMaterial;
  readonly triangles: number;

  constructor() {
    this.geometry = buildStreetLamp();
    this.material = nightMaterial('street_lamp', true);
    this.triangles = (this.geometry.getIndex()?.count ?? 0) / 3;
  }
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _yaw = /*#__PURE__*/ new Matrix4();
const _scale = /*#__PURE__*/ new Matrix4();
const _colour = /*#__PURE__*/ new Color();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _carScale = /*#__PURE__*/ new Vector3(1, 1, 1);

/** Where a tile's lamps are in the world, and what colour. Four floats each. */
export const LAMP_RECORD_STRIDE = 4;

/**
 * Every street lamp in a tile: one `InstancedMesh`, plus where they are in the
 * world for the real lights to follow.
 *
 * Built beside `buildTilePoles` off the same sidecar and with the same
 * arithmetic -- the same `NOMINAL_HEIGHT` scale, the same `deriveYaw` -- because
 * a luminaire that did not sit on its pole would be worse than no luminaire at
 * all. The yaw is passed in rather than recomputed: `power.ts` has already
 * derived it from the spans and doing it twice would be two answers.
 *
 * Positions are **tile-local** in the mesh, exactly as the poles are, so the
 * group's translation carries them and float32 vertex precision stays constant
 * across the whole 30 km extent. The returned `lamps` array is **world** metres,
 * because the four real lights are not in a tile and cannot be.
 */
export function buildTileStreetLamps(
  data: TilePower,
  assets: StreetLampAssets,
  yawOf: (index: number) => number,
  originX: number,
  originZ: number,
): { mesh: InstancedMesh | null; lamps: Float32Array } {
  const chosen: number[] = [];
  const sodium: boolean[] = [];
  for (let i = 0; i < data.poleCount; i++) {
    const decision = lampAt(data.tiltSeed[i], data.x[i] + originX, data.z[i] + originZ);
    if (!decision.lit) continue;
    chosen.push(i);
    sodium.push(decision.sodium);
  }
  if (chosen.length === 0) return { mesh: null, lamps: new Float32Array(0) };

  const mesh = new InstancedMesh(assets.geometry, assets.material, chosen.length);
  mesh.name = 'street_lamps';
  const lamps = new Float32Array(chosen.length * LAMP_RECORD_STRIDE);

  for (let n = 0; n < chosen.length; n++) {
    const i = chosen[n];
    const yaw = yawOf(i);
    const sy = data.height[i] / NOMINAL_HEIGHT;

    // No lean. The poles get up to 1.2 degrees of hashed tilt about the
    // conductor tie-off because a plumb pole line reads as CAD; a luminaire is
    // levelled by the crew that hangs it whatever the pole is doing, and 1.2
    // degrees at 9 m would move the pool 19 cm for no visible gain and put the
    // shaft's foot outside the pool it is supposed to stand in.
    _yaw.makeRotationY(yaw);
    _scale.makeScale(1, sy, 1);
    _matrix.makeTranslation(data.x[i], data.groundY[i], data.z[i]);
    _matrix.multiply(_yaw);
    _matrix.multiply(_scale);
    mesh.setMatrixAt(n, _matrix);

    const colour = sodium[n] ? LAMP_SODIUM_COLOUR : LAMP_LED_COLOUR;
    _colour.setRGB(colour[0], colour[1], colour[2]);
    mesh.setColorAt(n, _colour);

    // The head in world metres, for the real point lights. The same
    // `LAMP_OUTREACH` along the same rotated +X the geometry uses, so a
    // `PointLight` assigned to this lamp sits inside its own glow blob rather
    // than beside it.
    const out = LAMP_OUTREACH;
    const o = n * LAMP_RECORD_STRIDE;
    lamps[o] = originX + data.x[i] + Math.cos(yaw) * out;
    lamps[o + 1] = data.groundY[i] + data.height[i] * LAMP_HEIGHT_FRACTION;
    lamps[o + 2] = originZ + data.z[i] - Math.sin(yaw) * out;
    lamps[o + 3] = sodium[n] ? 1 : 0;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Culled with its tile, like every other instanced population.
  mesh.frustumCulled = false;
  // Pure emission: nothing for either half of the shadow pass to do with it.
  // The same flag the wires and the lit signal lamps carry, read by
  // `applyShadowRole` in `streamer.ts`.
  mesh.userData.noShadow = true;
  // Read by `releaseGroupGeometry`: the geometry is the one shared street lamp
  // in the world and disposing it with a tile would put out every light in the
  // city the first time the player walked far enough to evict one.
  mesh.userData.nightlights = true;
  return { mesh, lamps };
}

// --- The car lights -----------------------------------------------------------

/**
 * What `TrafficMovers` feeds, and the whole of the coupling between the traffic
 * and the night.
 *
 * An interface rather than the class for the reason `CollisionSink` is one in
 * `streamer.ts`: `world/cars.ts` has no business knowing what a headlight is. It
 * knows that it has a pose in its hand and that something may want it, and the
 * `begin` returning false is what makes the day path a single comparison per
 * frame rather than a branch per car.
 */
export interface CarLightSink {
  /** Start a frame. Returns false when there is nothing to draw, and then `add` is never called. */
  begin(): boolean;
  add(pose: CarPose): void;
  end(): void;
}

/**
 * Headlights, beams, road pools and tail lights for every moving car in view.
 *
 * Two `InstancedMesh` sets over **one material**, so it is one pipeline and two
 * draws for the whole fleet. Two rather than one because the two ends of a car
 * are a different distance apart on a van and on a hatch: the head kit is
 * anchored at the nose and the tail kit at the tail, each composed from
 * `CAR_BODY_SIZE`, which is the same table the hit box comes from -- so the
 * lights are on the car rather than near it.
 *
 * Not parented to a tile, for `TrafficMovers`' own reason: a car crosses a tile
 * boundary every few seconds and binning the fleet per frame would mean
 * rebuilding instance buffers for nothing.
 */
export class CarLights implements CarLightSink {
  readonly meshes: InstancedMesh[];
  readonly material: MeshBasicNodeMaterial;
  readonly headGeometry: BufferGeometry;
  readonly tailGeometry: BufferGeometry;
  /** Cars lit last frame. Read by the dev handle. */
  drawn = 0;
  /** Whether the night is on at all. Set by `NightLights.update`. */
  private live = false;
  private count = 0;

  constructor() {
    this.material = nightMaterial('car_lights', false);
    this.headGeometry = buildCarHeadLights();
    this.tailGeometry = buildCarTailLights();
    this.meshes = [this.headGeometry, this.tailGeometry].map((geometry, i) => {
      const mesh = new InstancedMesh(geometry, this.material, CAR_LIGHT_CAPACITY);
      mesh.name = i === 0 ? 'car_headlights' : 'car_taillights';
      mesh.count = 0;
      // Culled by the traffic draw radius the poses already came through, not by
      // a bounding sphere that would have to be recomputed every frame.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Never per-instance coloured. Both sets have to agree about that or they
      // would be two pipelines: `NodeMaterial.setupDiffuseColor` multiplies by
      // `instanceColor` only when the attribute exists, so its presence is in
      // the shader. Headlights are one colour and tail lights are another, and
      // both are baked into the vertex colours of their own geometry.
      mesh.visible = false;
      return mesh;
    });
  }

  /** Whether the sprites are being drawn at all. See `NIGHT_VISIBLE_LEVEL`. */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    for (const mesh of this.meshes) mesh.visible = live;
  }

  begin(): boolean {
    this.count = 0;
    return this.live;
  }

  add(pose: CarPose): void {
    if (this.count >= CAR_LIGHT_CAPACITY) return;
    // A car sitting in a kerb bay between runs is parked, and a parked car has
    // its lights off -- which is also what the 44,000 static ones do. Without
    // this a schedule car in its dwell is a parked car with its headlights
    // blazing into the terrace in front of it, which is the one thing in this
    // file a player would actually stop and look at.
    if (pose.stage === CAR_STAGE_PARKED_IN || pose.stage === CAR_STAGE_PARKED_OUT) return;

    // The heading, on `world/cars.ts`'s half-angle form: the car's local +X is
    // its nose, so the yaw that sends +X to (dx, 0, dz) is `atan2(-dz, dx)` and
    // the quaternion for it is one square root rather than three transcendentals.
    const c = pose.dx;
    const s = -pose.dz;
    const w2 = (1 + c) * 0.5;
    if (w2 > 1e-12) {
      const w = Math.sqrt(w2);
      _quaternion.set(0, s / (2 * w), 0, w);
    } else {
      _quaternion.set(0, 1, 0, 0);
    }
    _carScale.set(pose.scale, pose.scale, pose.scale);

    const size = CAR_BODY_SIZE[pose.body] ?? CAR_BODY_SIZE[0];
    const reach = size.length * 0.5 * pose.scale;
    const n = this.count;

    _position.set(pose.x + pose.dx * reach, pose.y, pose.z + pose.dz * reach);
    _matrix.compose(_position, _quaternion, _carScale);
    this.meshes[0].setMatrixAt(n, _matrix);

    _position.set(pose.x - pose.dx * reach, pose.y, pose.z - pose.dz * reach);
    _matrix.compose(_position, _quaternion, _carScale);
    this.meshes[1].setMatrixAt(n, _matrix);

    this.count = n + 1;
  }

  end(): void {
    for (const mesh of this.meshes) {
      if (this.count > 0 || mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
      mesh.count = this.count;
    }
    this.drawn = this.count;
  }

  /** Release the instance buffers. The geometry and material are this object's and go with it. */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    this.headGeometry.dispose();
    this.tailGeometry.dispose();
    this.material.dispose();
  }
}

// --- The rig -----------------------------------------------------------------

/**
 * Where the two real lights get their lamps from.
 *
 * An interface so this file never imports `streamer.ts`, which imports it. The
 * streamer is the only thing that knows which tiles are resident and therefore
 * the only thing that can answer this; what it hands back is world metres and a
 * colour flag, which is all a `PointLight` needs.
 */
export interface LampSource {
  /**
   * Fill `out` with the nearest lamp records -- x, y, z, sodium -- and return
   * how many were written.
   */
  nearestLamps(x: number, y: number, z: number, radius: number, out: Float32Array, max: number): number;
}

/** How far a real point light will reach for a lamp. Past this it would be worth nothing anyway. */
const LAMP_SEARCH_RADIUS = 44;

/**
 * How often the two real lights re-pick which lamps they are on, seconds.
 *
 * Not every frame, and not because the search is expensive -- it is a walk over
 * a handful of resident tiles' lamp arrays. It is because *reassignment is
 * visible*: a light that swaps from the lamp behind you to the lamp ahead moves
 * 40 m in one frame, and a wall that was lit going dark and another coming up is
 * a flicker. At 6 Hz the swap still happens between frames, but it happens at a
 * point where the outgoing lamp is at the edge of `LAMP_DISTANCE` and
 * contributing almost nothing, because that is where the sort put it.
 */
const LAMP_REPICK_INTERVAL = 1 / 6;

/**
 * The whole night rig: one torch, two lamp lights, and the traffic's own glow.
 *
 * Constructed and added to the scene **before the warm-up**, which is the one
 * hard requirement this class has on its caller and the reason the constructor
 * takes a scene rather than exposing a `group`. See this file's header: the set
 * of lights is in every material's cache key, so any light that appears after
 * the warm-up is a full recompile of the scene on the frame it appears.
 */
export class NightLights {
  readonly torch: SpotLight;
  readonly lamps: PointLight[] = [];
  readonly carLights = new CarLights();

  /**
   * The street lamps' geometry and material are **not** here, and that is
   * deliberate rather than an oversight. They are per-tile instanced populations
   * whose lifecycle is a tile's, so `TileStreamer` owns them exactly as it owns
   * `PowerAssets` -- and there must be precisely one `StreetLampAssets` in the
   * process, because a second material is a second pipeline that the warm-up
   * compiled nothing for. This class needs the lamps' *positions*, which it asks
   * the streamer for through `LampSource`, and nothing else about them.
   */

  /** 0 by day, 1 once dark. Published for the HUD and the dev handle. */
  level = 0;
  /** How many of the two real lights found a lamp last re-pick. */
  lampsLit = 0;

  private readonly aim = new Vector3(0, 0, -1);
  private readonly forward = new Vector3();
  private readonly beam = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly found = new Float32Array(LAMP_REAL_COUNT * LAMP_RECORD_STRIDE);
  private clock = 0;
  private repickIn = 0;

  /**
   * `scene` is typed as the `Object3D` it is used as rather than as `Scene`, so
   * that `verifyNightLights` can build a throwaway rig against a bare group and
   * assert the light invariants without a renderer anywhere near it. Everything
   * this constructor does to it is `add`.
   */
  constructor(scene: Object3D) {
    // --- The torch.
    this.torch = new SpotLight(0xffffff, 0);
    this.torch.angle = TORCH_ANGLE;
    this.torch.penumbra = TORCH_PENUMBRA;
    this.torch.distance = TORCH_DISTANCE;
    this.torch.decay = TORCH_DECAY;
    // Never. A second shadow map is a second full depth pass from a direction
    // that changes every time the player turns their head, so nothing in it can
    // be cached -- and the sun's rig in `sky.ts` is tuned against exactly one
    // caster with a bias solved for its own depth range. See this file's header
    // for what replaces it, which is falloff.
    this.torch.castShadow = false;
    this.torch.color.setRGB(TORCH_COLOUR[0], TORCH_COLOUR[1], TORCH_COLOUR[2]);
    // Not parented to the camera. A `SpotLight` aims at its `target`, and a
    // light parented to a moving object still has to have that target placed in
    // world space every frame -- so parenting would buy one matrix multiply and
    // cost the ability to lag the beam behind the view, which is the effect.
    scene.add(this.torch);
    scene.add(this.torch.target);

    // --- The lamps. Created here, in the constructor, once, for the life
    // of the process. See `LAMP_REAL_COUNT`.
    for (let i = 0; i < LAMP_REAL_COUNT; i++) {
      const light = new PointLight(0xffffff, 0, LAMP_DISTANCE, 2);
      light.castShadow = false;
      light.name = `street_lamp_${i}`;
      // Parked far under the terrain until the first re-pick. Not at the origin,
      // which is a real place in this world -- somebody standing at (0, 0, 0)
      // with unassigned lights at their feet would see phantom lamps.
      light.position.set(0, -1000, 0);
      this.lamps.push(light);
      scene.add(light);
    }

    for (const mesh of this.carLights.meshes) scene.add(mesh);
  }

  /**
   * Place the torch, re-pick the lamps and set the dusk level. Once a frame.
   *
   * `speed` is the player's horizontal speed and drives nothing but the sway
   * amplitude; `lamps` is the streamer, or null offline before it has any tiles.
   */
  update(
    dt: number,
    camera: Camera,
    solarAltitudeDeg: number,
    speed: number,
    lamps: LampSource | null,
  ): void {
    const rig = nightRig(solarAltitudeDeg);
    this.level = rig.level;
    // The one write to the one uniform every additive sprite in this file reads.
    nightOpacity.value = rig.level;

    const live = rig.level > NIGHT_VISIBLE_LEVEL;
    this.carLights.setLive(live);

    this.clock += dt;

    // --- The torch. The aim chases the view rather than copying it, so a fast
    // turn sweeps the beam across the wall a fraction behind the eye.
    camera.getWorldDirection(this.forward);
    // Exponential chase, framed so the time constant is in seconds and the
    // result does not depend on the frame rate -- the naive `lerp(a, b, k)` with
    // a constant `k` is a different filter at 60 fps and at 144.
    const chase = 1 - Math.exp(-dt / TORCH_LAG);
    this.aim.lerp(this.forward, Math.min(Math.max(chase, 0), 1));
    if (this.aim.lengthSq() < 1e-9) this.aim.copy(this.forward);
    this.aim.normalize();

    const sway = torchSway(this.clock, speed);
    // A basis about the (lagged) aim, so the sway is applied in the beam's own
    // frame rather than in world axes -- otherwise the same offset would be a
    // yaw when looking at the horizon and a roll when looking at your feet.
    this.right.crossVectors(this.aim, this.worldUp);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, this.aim).normalize();

    // Small angles: `tan(x) ~ x` to within a part in ten thousand at 2.6
    // degrees, so the offsets are added directly and the result renormalised.
    this.beam
      .copy(this.aim)
      .addScaledVector(this.right, Math.tan(sway.yaw))
      .addScaledVector(this.up, Math.tan(sway.pitch))
      .normalize();

    // The eye, offset down and to the right into a hand -- in the **view's**
    // axes rather than the beam's, because it is where the hand is and the hand
    // does not sway with the beam it is holding. `camera.matrixWorld` is current
    // here: `main.ts` calls `updateMatrixWorld` before the sky and the streamer
    // for the same reason.
    const eye = camera.position;
    this.right.crossVectors(this.forward, this.worldUp);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    this.torch.position.set(
      eye.x + this.right.x * TORCH_OFFSET[0] + this.up.x * TORCH_OFFSET[1] + this.beam.x * TORCH_OFFSET[2],
      eye.y + this.right.y * TORCH_OFFSET[0] + this.up.y * TORCH_OFFSET[1] + this.beam.y * TORCH_OFFSET[2],
      eye.z + this.right.z * TORCH_OFFSET[0] + this.up.z * TORCH_OFFSET[1] + this.beam.z * TORCH_OFFSET[2],
    );
    // 30 m down the beam. Only the direction matters to a spot light -- it takes
    // `position - target` -- so the distance is arbitrary and is stated at
    // something inside the light's own reach rather than at 1, where float
    // cancellation against a world coordinate of tens of thousands would start
    // to show in the beam's aim.
    this.torch.target.position.set(
      this.torch.position.x + this.beam.x * 30,
      this.torch.position.y + this.beam.y * 30,
      this.torch.position.z + this.beam.z * 30,
    );
    this.torch.target.updateMatrixWorld();
    this.torch.intensity = rig.torchIntensity * sway.gain;

    // --- The real lamps.
    this.repickIn -= dt;
    if (this.repickIn <= 0) {
      this.repickIn = LAMP_REPICK_INTERVAL;
      const n =
        lamps === null || rig.level <= 0
          ? 0
          : lamps.nearestLamps(eye.x, eye.y, eye.z, LAMP_SEARCH_RADIUS, this.found, LAMP_REAL_COUNT);
      this.lampsLit = n;
      for (let i = 0; i < LAMP_REAL_COUNT; i++) {
        const light = this.lamps[i];
        if (i >= n) {
          // Intensity, never `visible`. A hidden light is not pushed onto the
          // render list, which changes the lights hash, which recompiles every
          // pipeline in the scene. This is the invariant the whole feature rests
          // on and `verifyNightLights` asserts it.
          light.intensity = 0;
          continue;
        }
        const o = i * LAMP_RECORD_STRIDE;
        light.position.set(this.found[o], this.found[o + 1], this.found[o + 2]);
        const colour = this.found[o + 3] > 0.5 ? LAMP_SODIUM_COLOUR : LAMP_LED_COLOUR;
        light.color.setRGB(colour[0], colour[1], colour[2]);
        light.intensity = rig.lampIntensity;
      }
    } else if (rig.level > 0) {
      // Between re-picks the assignment stands and only the level moves, so the
      // lamps still fade smoothly through dusk without being re-sorted at 60 Hz.
      for (let i = 0; i < LAMP_REAL_COUNT; i++) {
        if (i < this.lampsLit) this.lamps[i].intensity = rig.lampIntensity;
      }
    } else {
      for (const light of this.lamps) light.intensity = 0;
    }
  }

  /** Every real light this rig owns. For the self-check and the dev handle. */
  get realLights(): Object3D[] {
    return [this.torch, ...this.lamps];
  }

  /**
   * Release everything this rig owns. For the self-check's throwaway probe.
   *
   * **Not called on the live rig**, and deliberately not wired to anything that
   * could be: the lights must exist for the life of the process, and a `dispose`
   * that removed one from the scene would recompile every pipeline in it.
   */
  dispose(): void {
    this.carLights.dispose();
  }
}

// --- The self-check -----------------------------------------------------------

/**
 * Everything about the night rig that fails silently, in one place.
 *
 * Same criterion as `verifyLightRig` and `verifyBikeGlow`: none of these throws,
 * none has a stack trace, and every one of them presents as "the night feels a
 * bit off" or -- worse, in the recompile case -- as "the game stutters
 * sometimes", which is a symptom nobody would trace back to a lighting file.
 */
export function verifyNightLights(): string[] {
  const failures: string[] = [];

  // 1. The dusk ramp, swept rather than asserted. Monotone, continuous, and
  //    pinned at both ends: a ramp that overshot 1 or went negative would drive
  //    a negative light intensity, which three does not clamp.
  let previous = nightLevel(40);
  let biggestStep = 0;
  for (let alt = 40; alt >= -40; alt -= 0.05) {
    const level = nightLevel(alt);
    if (level < previous - 1e-9) {
      failures.push(
        `nightLevel is not monotone: it falls from ${previous.toFixed(4)} to ${level.toFixed(4)} ` +
          `as the sun drops through ${alt.toFixed(2)} degrees. Every night term in the build is ` +
          `this number times a constant, so a ramp that goes backwards is lamps that dim as it ` +
          `gets darker.`,
      );
      break;
    }
    biggestStep = Math.max(biggestStep, level - previous);
    previous = level;
    if (level < -1e-9 || level > 1 + 1e-9) {
      failures.push(`nightLevel(${alt.toFixed(2)}) is ${level.toFixed(4)}, outside 0-1.`);
      break;
    }
  }
  if (nightLevel(NIGHT_ON_ALTITUDE) !== 0 || nightLevel(NIGHT_ON_ALTITUDE + 20) !== 0) {
    failures.push(
      `nightLevel is not zero at and above NIGHT_ON_ALTITUDE (${NIGHT_ON_ALTITUDE} deg). The ` +
        `whole daytime calibration in sky/calibration.ts was measured with three lights in the ` +
        `scene and is only still true because the other six are multiplied by this.`,
    );
  }
  if (nightLevel(NIGHT_FULL_ALTITUDE) !== 1 || nightLevel(-40) !== 1) {
    failures.push(
      `nightLevel does not reach 1 at or below NIGHT_FULL_ALTITUDE (${NIGHT_FULL_ALTITUDE} deg).`,
    );
  }
  // 0.05 degrees of altitude is about 12 seconds of Sydney clock in February, so
  // this bounds the fade rate at something no keystroke can jump: `[` and `]`
  // move the clock 30 minutes, which is under a quarter of the ramp.
  if (biggestStep > 0.02) {
    failures.push(
      `nightLevel steps by ${biggestStep.toFixed(4)} over 0.05 degrees of solar altitude, which ` +
        `is a visible jump rather than a fade. The ramp spans ` +
        `${NIGHT_ON_ALTITUDE - NIGHT_FULL_ALTITUDE} degrees; anything much narrower snaps.`,
    );
  }

  // 2. The torch's sway envelope, measured over ten minutes at 120 Hz rather
  //    than asserted from the constants. "Fairly stable" is a claim that rots
  //    the moment somebody doubles an amplitude for a screenshot.
  let peakAngle = 0;
  let peakRate = 0;
  let peakGain = 0;
  let smallest = Infinity;
  const dt = 1 / 120;
  let last = torchSway(0, SWAY_FULL_SPEED);
  for (let t = dt; t < 600; t += dt) {
    const now = torchSway(t, SWAY_FULL_SPEED);
    const angle = Math.hypot(now.yaw, now.pitch) * (180 / Math.PI);
    peakAngle = Math.max(peakAngle, angle);
    smallest = Math.min(smallest, angle);
    peakRate = Math.max(peakRate, (Math.hypot(now.yaw - last.yaw, now.pitch - last.pitch) * (180 / Math.PI)) / dt);
    peakGain = Math.max(peakGain, Math.abs(now.gain - 1));
    last = now;
  }
  if (peakAngle > TORCH_SWAY_MAX_DEG) {
    failures.push(
      `The torch sways up to ${peakAngle.toFixed(2)} degrees off the view at a sprint, past the ` +
        `${TORCH_SWAY_MAX_DEG} degree envelope. The order was "shaky but convenient (fairly ` +
        `stable)"; past this the player is fighting the light rather than holding it.`,
    );
  }
  if (peakAngle < 0.5) {
    failures.push(
      `The torch sways at most ${peakAngle.toFixed(2)} degrees, which is nothing -- a beam locked ` +
        `to the view reads as painted on the screen rather than thrown by a hand.`,
    );
  }
  if (peakRate > TORCH_SWAY_MAX_RATE_DEG) {
    failures.push(
      `The torch sway reaches ${peakRate.toFixed(1)} degrees per second, past the ` +
        `${TORCH_SWAY_MAX_RATE_DEG} bound. The amplitude is only half of "stable": the same ` +
        `2.6 degrees delivered fast is a jitter and delivered slowly is a hand.`,
    );
  }
  if (peakGain > TORCH_FLICKER_MAX) {
    failures.push(
      `The torch's intensity varies by ${(peakGain * 100).toFixed(1)}%, past the ` +
        `${(TORCH_FLICKER_MAX * 100).toFixed(0)}% bound. A torch does not flicker; this term is ` +
        `standing in for the hotspot rolling across a surface and should not be readable as one.`,
    );
  }

  // 3. The real lights, which is the recompile guarantee and the most expensive
  //    thing in this file to get wrong. Built for real, because the invariant is
  //    about objects rather than about numbers.
  const probe = new NightLights(new Object3D());
  const real = probe.realLights;
  if (real.length !== 1 + LAMP_REAL_COUNT) {
    failures.push(
      `The night rig owns ${real.length} real lights, not ${1 + LAMP_REAL_COUNT}. That count is a ` +
        `shader constant: LightsNode.customCacheKey hashes every light on the render list, so ` +
        `changing it rebuilds and recompiles every pipeline in the scene.`,
    );
  }
  for (const light of real) {
    if (light.visible !== true) {
      failures.push(
        `${light.name || light.type} starts hidden. An invisible light is skipped by ` +
          `_projectObject and never reaches the render list, which changes the lights hash and ` +
          `recompiles the whole scene -- exactly the mid-play compile world/warmup.ts exists to ` +
          `prevent. Fade intensity to zero instead.`,
      );
    }
    if ((light as unknown as { castShadow?: boolean }).castShadow === true) {
      failures.push(
        `${light.name || light.type} casts a shadow. There is one shadow rig in this build and it ` +
          `is the sun's, tuned against a single caster over a 740 m depth range; a second is a ` +
          `second full depth pass every frame.`,
      );
    }
  }
  const day = nightRig(57.11);
  if (day.torchIntensity !== 0 || day.lampIntensity !== 0) {
    failures.push(
      `The torch and the lamps are on at the reference 3 pm (${day.torchIntensity}, ` +
        `${day.lampIntensity}). They must be exactly zero, or every display value predicted in ` +
        `calibration.ts and facade.ts is wrong.`,
    );
  }
  probe.dispose();

  // 4. The pool has to be under the lamp. Two independent offsets -- the
  //    geometry's and the world record the point light follows -- and if they
  //    ever disagree the light is beside its own glow, which reads as a bug in
  //    the terrain rather than in this file.
  const lampGeometry = buildStreetLamp();
  const pos = lampGeometry.getAttribute('position');
  let minY = Infinity;
  let maxY = -Infinity;
  let poolVerts = 0;
  let poolMaxR = 0;
  let offCone = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    // A pool vertex is one whose height is exactly what the cone predicts for
    // its distance from the luminaire: `POOL_LIFT` at the middle rising to
    // `POOL_LIFT + POOL_RIM_LIFT` at `POOL_RADIUS`. That is a stronger test
    // than a height band, because it is the *shape* that is load-bearing --
    // the rise is what keeps the far side of a pool out of an uphill footpath,
    // and a cone that had quietly gone flat again would still pass a band.
    const r = Math.hypot(pos.getX(i) - LAMP_OUTREACH, pos.getZ(i));
    if (r > POOL_RADIUS + 1e-3) continue;
    const predicted = POOL_LIFT + POOL_RIM_LIFT * (r / POOL_RADIUS);
    if (Math.abs(y - predicted) < 1e-3) {
      poolVerts++;
      poolMaxR = Math.max(poolMaxR, r);
    } else if (y < POOL_LIFT + POOL_RIM_LIFT + 1e-3 && y < 2) {
      // Low, inside the pool's footprint, and not on the cone: that is either a
      // flattened pool or a shaft foot in the wrong place. The shaft's own feet
      // sit at exactly `POOL_LIFT` and within `SHAFT_HALF_FOOT` of the axis, so
      // they are excluded rather than counted.
      if (!(Math.abs(y - POOL_LIFT) < 1e-3 && r <= SHAFT_HALF_FOOT + 1e-3)) offCone++;
    }
  }
  if (poolVerts === 0 || offCone > 0) {
    failures.push(
      `The street lamp's ground pool is not the cone it is supposed to be: ${poolVerts} vertices ` +
        `on it and ${offCone} low ones off it. It has to be centred on the luminaire at ` +
        `x=${LAMP_OUTREACH} and rise ${POOL_RIM_LIFT} m from middle to rim -- the offset is what ` +
        `puts the light where the lamp is, and the rise is what stops the uphill half of every ` +
        `pool being swallowed by the footpath it is lying on.`,
    );
  }
  if (Math.abs(poolMaxR - POOL_RADIUS) > 0.05) {
    failures.push(
      `The pool reaches ${poolMaxR.toFixed(2)} m from the luminaire against POOL_RADIUS ` +
        `${POOL_RADIUS}.`,
    );
  }
  if (minY < 0) {
    failures.push(
      `The street lamp geometry reaches ${minY.toFixed(3)} m, below the pole's own foot. Nothing ` +
        `here may go under the road: a pole's sidecar height is the terrain and the surface being ` +
        `walked on is up to 30 cm above it, which is why the pool is lifted ${POOL_LIFT} m before ` +
        `it starts rising at all.`,
    );
  }
  const expectedHead = NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION + HEAD_HALF;
  if (Math.abs(maxY - expectedHead) > 1e-3) {
    failures.push(
      `The lamp head tops out at ${maxY.toFixed(2)} m rather than ${expectedHead.toFixed(2)}; it ` +
        `has to sit under the crossarm at ${(NOMINAL_HEIGHT - 0.55).toFixed(2)} m, because a ` +
        `bracket goes below the conductors on every pole in the country.`,
    );
  }

  // The winding, re-derived from the vertices rather than trusted. A ground pool
  // wound the wrong way is culled by `FrontSide` and is therefore not a subtle
  // bug -- it is an invisible one, and the symptom is "the street lights do not
  // light the road", which is a sentence that would send somebody straight to
  // the intensity constants where nothing is wrong.
  for (const [name, geometry] of [
    ['street lamp', lampGeometry],
    ['car headlights', buildCarHeadLights()],
  ] as const) {
    const p = geometry.getAttribute('position');
    const index = geometry.getIndex();
    // A face-down horizontal triangle is only a fault if it is **alone**. The
    // lamp heads and the headlight lenses are three quads crossing on the three
    // axes, and the horizontal one of those three is emitted twice with opposite
    // winding on purpose -- so it is legitimately half face-down, and a naive
    // count fires on it. What is never legitimate is a downward triangle with no
    // upward twin over the same three vertices, which is exactly a ground pool
    // that will be culled and never seen.
    const upward = new Set<string>();
    const downward: string[] = [];
    if (index !== null) {
      for (let t = 0; t < index.count; t += 3) {
        const [i0, i1, i2] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
        const ax = p.getX(i1) - p.getX(i0);
        const ay = p.getY(i1) - p.getY(i0);
        const az = p.getZ(i1) - p.getZ(i0);
        const bx = p.getX(i2) - p.getX(i0);
        const by = p.getY(i2) - p.getY(i0);
        const bz = p.getZ(i2) - p.getZ(i0);
        // The face normal, in full. The pools are shallow *cones* rather than
        // flat discs -- see `POOL_RIM_LIFT` -- so a test on equal vertex heights
        // would have skipped every one of them and this check would have passed
        // by looking at nothing.
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        // Only the ground-facing pieces. A vertical sheet's normal is horizontal
        // and its winding is a deliberate two-sided pair, which this says
        // nothing about; 0.9 admits the 5 degrees of pool tilt and nothing else
        // in the file.
        if (Math.abs(ny) / len < 0.9) continue;
        const key = [i0, i1, i2].sort((a, b) => a - b).join(',');
        if (ny > 0) upward.add(key);
        else downward.push(key);
      }
    }
    const orphans = downward.filter((key) => !upward.has(key)).length;
    if (orphans > 0) {
      failures.push(
        `${orphans} horizontal triangles in the ${name} geometry are wound face-down with no ` +
          `face-up twin, so FrontSide culls them and the pool they belong to is invisible from ` +
          `above -- which is the only place a player ever is.`,
      );
    }
    if (geometry !== lampGeometry) geometry.dispose();
  }
  lampGeometry.dispose();

  // 5. The lamp share and the colour split, measured over a synthetic pole set
  //    rather than read off the constants -- a hash that clumped would leave
  //    LAMP_SHARE reading 0.42 with every lamp in the city on one street.
  let lit = 0;
  let sodium = 0;
  const cells = new Set<string>();
  const SAMPLES = 20000;
  for (let i = 0; i < SAMPLES; i++) {
    const x = (i % 200) * 37.5 - 3750;
    const z = Math.floor(i / 200) * 37.5 - 3750;
    const decision = lampAt(i & 255, x, z);
    if (decision.lit) lit++;
    if (decision.sodium) sodium++;
    cells.add(`${Math.floor(x / LAMP_COLOUR_CELL)},${Math.floor(z / LAMP_COLOUR_CELL)}:${decision.sodium}`);
  }
  const share = lit / SAMPLES;
  if (Math.abs(share - LAMP_SHARE) > 0.03) {
    failures.push(
      `${(share * 100).toFixed(1)}% of poles carry a luminaire against the ${LAMP_SHARE * 100}% ` +
        `LAMP_SHARE asks for. Sydney hangs a street light on roughly every second power pole; ` +
        `the hash is meant to break the regularity, not the rate.`,
    );
  }
  const sodiumShare = sodium / SAMPLES;
  if (Math.abs(sodiumShare - LAMP_SODIUM_SHARE) > 0.06) {
    failures.push(
      `${(sodiumShare * 100).toFixed(1)}% of lamps are sodium against ` +
        `${LAMP_SODIUM_SHARE * 100}%. The mix is the tell that this is a city mid-conversion ` +
        `rather than one lit by a single decision.`,
    );
  }
  // One decision per cell, or the colour is hashed per pole and a street is
  // salt-and-pepper -- which is the failure this cell exists to prevent and is
  // invisible in the share above.
  const cellCount = new Set([...cells].map((k) => k.split(':')[0])).size;
  if (cells.size !== cellCount) {
    failures.push(
      `${cells.size} colour decisions across ${cellCount} cells of ${LAMP_COLOUR_CELL} m: a cell ` +
        `is carrying both colours, so the LED/sodium split is effectively per pole. A real street ` +
        `was converted by a crew in a morning and is all one colour.`,
    );
  }

  // 6. The instanced budgets, which are the other half of "no surprises at
  //    night": a capacity under the fleet ceiling is cars that are drawn and not
  //    lit, which looks like a bug in the traffic rather than in the lights.
  if (CAR_LIGHT_CAPACITY < 384) {
    failures.push(
      `CAR_LIGHT_CAPACITY is ${CAR_LIGHT_CAPACITY}, under the 384 world/cars.ts sizes its own ` +
        `fleet buffers at. Every moving car in view has to be able to have its lights on.`,
    );
  }

  return failures;
}
