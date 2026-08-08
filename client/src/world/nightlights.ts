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
  MeshStandardNodeMaterial,
  Object3D,
  PerspectiveCamera,
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
import {
  CAR_BODY_SIZE,
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  type CarPose,
  type LaneWay,
} from '../game/traffic.ts';

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

// --- Where the beam comes from --------------------------------------------------

/**
 * The one real spot light in this build has three jobs, and this is how it is
 * told which one it is doing.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SECOND LIGHT FOR THE BIKE, WHICH IS THE INTERESTING HALF.
 *
 * An e-bike at 26 m/s down a black street is the one moving light source a
 * player controls, and it wants a real light -- an additive beam sprite says
 * "there is a headlight here" and does not put a single lumen on the road, which
 * at that speed is the difference between riding and guessing. The file header
 * gives two ways to have one: reuse the torch, or construct a fourth light at
 * boot and hold it at zero intensity when nobody is riding.
 *
 * **The torch is reused, and the argument is not really about cost.** The cost
 * is real -- a fourth light is ~0.6 s of measured boot compile, permanently, for
 * something a player uses in bursts -- but the reason it is not the deciding
 * argument is that 0.6 s is affordable if the feature needs it. What decides it
 * is that *a rider is not also holding a torch*. Both hands are on the bars;
 * `player/animation.ts`'s ride clip puts them there and `verifyCharacterRig`
 * asserts it. A build with both lights on at once would be drawing a beam from a
 * hand that is visibly gripping a handlebar, which is the kind of detail that is
 * wrong in a way people feel without seeing. Mounting is therefore an *exchange*
 * of one light for another, and an exchange is exactly what a single re-aimed
 * light expresses.
 *
 * It is also free of the recompile rule rather than merely cheap under it. What
 * changes between the two modes is `position`, `color`, `intensity`, `angle`,
 * `penumbra`, `distance` and `decay` -- and every one of those is a *uniform*
 * in three's WebGPU backend (`SpotLightNode.update` writes `coneCosNode`,
 * `penumbraCosNode`, `cutoffDistanceNode` and `decayExponentNode` every frame).
 * `LightsNode.customCacheKey` hashes `light.id`, `castShadow`, the projection
 * map and a `colorNode`, none of which moves here. So a player mounting a bike
 * at midnight compiles nothing at all, which is the property this whole file is
 * organised around, and `verifyNightLights` measures the mount/dismount cycle
 * rather than asserting it.
 *
 * The cost of the choice is that dismounting hands the torch straight back, so
 * there is one frame where the beam moves from the bar to the hand. It is a
 * frame, it happens under an animation that is already changing the whole body,
 * and it is the correct behaviour anyway: you put the torch away to ride and
 * take it out again when you get off.
 */
export const TORCH_MOUNT_HAND = 0;
export const TORCH_MOUNT_BIKE = 1;

/** Where the beam starts and, on a bike, which way it is bolted. See `TorchMount`. */
export interface TorchMount {
  /** `TORCH_MOUNT_HAND` or `TORCH_MOUNT_BIKE`. */
  kind: number;
  /** World metres. */
  x: number;
  y: number;
  z: number;
  /** Unit heading in the world plan. Read for `TORCH_MOUNT_BIKE` only. */
  dx: number;
  dz: number;
}

/** A reusable mount, so a frame that fills one allocates nothing. */
export function createTorchMount(): TorchMount {
  return { kind: TORCH_MOUNT_HAND, x: 0, y: 0, z: 0, dx: 0, dz: -1 };
}

/**
 * Where the torch is held on a body that can be seen holding it, relative to the
 * **chest bone**: right, up, forward in the body's own yaw frame.
 *
 * The bone rather than the wrist, and that is the one judgement call in the
 * third-person fix. `player/bat.ts` hangs a prop off `BONE.WRIST_R` because a
 * bat *is* the arm's motion; a torch is not. The rig's arms swing through tens
 * of degrees over a walk cycle and well over that at a sprint, so a beam from
 * the wrist is a searchlight sweeping the street once a step -- which is
 * realistic, unplayable, and about twenty times the 2.3-degree envelope
 * `TORCH_SWAY_MAX_DEG` spends a paragraph defending. The chest carries the lean,
 * the bob and the turn and none of the swing, which is what a torch held against
 * the body in a walk actually does, and the sway term is already modelling the
 * rest.
 *
 * 22 cm right and 26 cm forward is a hand carried in front of the sternum. It is
 * offset to the right because a light exactly on the body's axis flattens
 * everything it touches -- `TORCH_OFFSET` makes the same argument for first
 * person and buys the same thing here, a kerb and a step with a short shadow
 * beside them.
 *
 * **None of `TORCH_OFFSET` applies.** That constant's whole derivation is about
 * keeping two viewmodels out of the beam, and in third person `main.ts` has
 * already moved both of them off the camera's layer -- so the 16 cm of upward
 * push that exists to save the bat has nothing left to save and would only put
 * the beam through the top of the player's own head.
 */
const HAND_RIGHT = 0.22;
const HAND_UP = 0.06;
const HAND_FORWARD = 0.26;

/**
 * Fill `out` with the hand mount for a body whose **chest bone** is at
 * `(cx, cy, cz)` in world metres, facing `yaw`.
 *
 * `yaw` is the controller's, whose convention is that forward is
 * `(-sin yaw, -cos yaw)` -- stated here because getting the sign wrong puts the
 * torch behind the player's back, which is the bug this whole function exists to
 * fix, arrived at from the other direction.
 */
export function torchHandMount(
  out: TorchMount,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
): TorchMount {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // Right-hand side in the plan: rotate forward by -90 degrees about +Y.
  const rx = -fz;
  const rz = fx;
  out.kind = TORCH_MOUNT_HAND;
  out.x = cx + rx * HAND_RIGHT + fx * HAND_FORWARD;
  out.y = cy + HAND_UP;
  out.z = cz + rz * HAND_RIGHT + fz * HAND_FORWARD;
  out.dx = fx;
  out.dz = fz;
  return out;
}

/**
 * Where the headlamp sits on the bike, in the bike's own frame: up from the
 * ground, and forward of the point `RiddenBike.set` is given.
 *
 * `world/bike.ts` puts the head tube at `BAR_Z + 0.06` and the basket's front
 * face at `BAR_Z - 0.205`, which with `BAR_Z` at -0.55 is 0.755 m ahead of the
 * bottom bracket. 0.72 tucks the lamp just inside that -- under the basket, on
 * the head tube, which is where a share bike carries one -- and 0.93 m up is the
 * bottom of the basket. The lens sprite is drawn at exactly the same point by
 * `buildBikeHeadLight`, so the light and the thing that looks like the light are
 * the same object.
 */
const BIKE_LAMP_UP = 0.93;
const BIKE_LAMP_FORWARD = 0.72;

/**
 * How far below level the bike's beam is aimed, radians.
 *
 * 4.6 degrees, which puts the axis on the road 11.5 m ahead of a 0.93 m lamp.
 * That is a bicycle standard rather than a car one -- a StVZO-approved bike lamp
 * has a sharp cutoff aimed about 10 m out, because a bike lamp is mounted low
 * enough that anything flatter is straight into the eyes of the person walking
 * towards you. It also puts the hotspot where a rider at 26 m/s is looking,
 * which is the whole reason the light is here.
 */
const BIKE_BEAM_PITCH = 0.08;

/**
 * The bike beam's cone, against the torch's 0.42 rad / 0.55 penumbra / 60 m.
 *
 * **Wider and shorter, which is the opposite of what a headlight sounds like.**
 * A torch is a hand-aimed instrument and its narrow cone is what makes it feel
 * aimed; a bar-mounted lamp cannot be aimed at all, so the useful thing it can
 * do is light the *width* of the road, and a narrow cone on a rigid mount is a
 * spot of light that slides off the road on every corner. 0.62 rad is a 71-degree
 * cone, which at the 11.5 m aiming point covers the full carriageway.
 *
 * 46 m of throw rather than 60 because the beam is aimed down: past 25 m the
 * cone is under the road surface and the only thing the extra range buys is a
 * faint wash on the first-floor windows of whatever is at the end of the street.
 * The penumbra goes up to 0.72 because a bicycle lamp's cutoff is soft above the
 * axis and there is no hard-edged pool in the world to match.
 *
 * The gain is under one. A tuned e-bike does 39.4 m/s and its lamp is a 15 W
 * LED, not a 55 W projector; the reason it reads as *more* light than the torch
 * is the cone, not the flux.
 */
const BIKE_BEAM_ANGLE = 0.62;
const BIKE_BEAM_PENUMBRA = 0.72;
const BIKE_BEAM_DISTANCE = 46;
const BIKE_BEAM_GAIN = 0.92;
/**
 * A cool white, against the torch's warm one.
 *
 * A share-bike lamp is a 6000 K LED and a torch in this game is an incandescent
 * one at 2900 K, and the two being visibly different colours is most of what
 * says the light moved from your hand to the bike. It is also what a rider
 * approaching you at night reads as before you can see the bike.
 */
const BIKE_BEAM_COLOUR: Rgb = [0.84, 0.9, 1.0];

/**
 * Fill `out` with the bike mount, given the point `RiddenBike.set` is given --
 * the rider's **feet**, which is the bike's own origin -- and its yaw.
 */
export function torchBikeMount(
  out: TorchMount,
  feetX: number,
  feetY: number,
  feetZ: number,
  yaw: number,
): TorchMount {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  out.kind = TORCH_MOUNT_BIKE;
  out.x = feetX + fx * BIKE_LAMP_FORWARD;
  out.y = feetY + BIKE_LAMP_UP;
  out.z = feetZ + fz * BIKE_LAMP_FORWARD;
  out.dx = fx;
  out.dz = fz;
  return out;
}

// --- The street lamp ----------------------------------------------------------

/**
 * What fraction of the pole set carries a luminaire.
 *
 * **This was 0.42 and the argument for it did not survive being measured.** The
 * reasoning was "poles sit about 38 m apart, Sydney lights a street about every
 * 40 m, so every second pole" -- which quietly multiplies the two: at a 40 m
 * pole pitch, lighting 42% of them puts a lamp every 40/0.42 = 95 m, not every
 * 40. A player asked for more street lights, which is what that arithmetic
 * error feels like from inside the game.
 *
 * Measured properly, off the shipped sidecars rather than off the constants.
 * Every surveyed pole in a nine-tile square was assigned to its single nearest
 * way and the gaps read along each centreline:
 *
 * ```
 *                    pole pitch   metres of road per lamp
 *                    (median)     at 0.42     at 0.78
 *   residential        40.0 m      115 m       62 m
 *   tertiary           39.5 m      106 m       71 m
 * ```
 *
 * Against a real Sydney back street at 50-60 m and an arterial at 30-40, the
 * old figure was between two and three times too sparse; 0.78 lands residential
 * inside the band and tertiary just over it. It is *not* pushed to 1.0, and the
 * reason is the same one the hash was introduced for: at a 40 m pitch nothing
 * short of every pole reaches 40 m, and every pole is a chain of lights so
 * regular that it reads as a fence. 0.78 leaves roughly one pole in five dark,
 * which on the ground is a run of four or five lit spans and then a long one --
 * which is what a street with a corner and a driveway in it looks like.
 *
 * The arterials are the residual error and they are left alone on purpose: a
 * pole's sidecar record does not say what class of street it is beside, and
 * inventing that lookup here would put a second, differently-derived opinion
 * about the street network next to the one `deriveColumnLamps` already has. What
 * lights a real Sydney arterial at 34 m is a *column*, not a power pole, and
 * that is the mechanism below.
 *
 * Hashed on the pole's own sidecar seed and its position, so it is stable across
 * a tile eviction and reload: a lamp that moved when you walked away and came
 * back would be the most obvious possible bug and the cheapest to avoid.
 */
const LAMP_SHARE = 0.78;

/**
 * The median distance between two consecutive surveyed poles along one street,
 * metres, measured off the shipped sidecars.
 *
 * Written down as a constant because it is the thing `LAMP_SHARE` has to be
 * divided into to mean anything, and because it is a *measurement of the world
 * data* rather than a tuning knob: every pole in a nine-tile square was assigned
 * to its single nearest way and the gaps read along the centreline, in
 * Newtown (40.0), Bondi (40.3), Alexandria (40.0), Manly (40.0) and the CBD
 * fringe (36.7). It moves only if `pipeline/sydney/power.py` does, and
 * `verifyNightLights` uses it to bound the density the share actually produces.
 */
const MEASURED_POLE_PITCH = 40;

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
  /**
   * And the one column in the city, for the streets with no pole to hang a lamp
   * on. See `deriveColumnLamps`.
   *
   * Here rather than in a class of its own for the reason the glow is: a second
   * `StreetLampAssets` would be a second material and a second pipeline, and a
   * column standing beside a pole lamp has to be wearing the *same* luminaire
   * glow or the CBD and the suburbs are two different nights.
   */
  readonly columnGeometry: BufferGeometry;
  readonly columnMaterial: MeshStandardNodeMaterial;
  readonly columnTriangles: number;

  constructor() {
    this.geometry = buildStreetLamp();
    this.material = nightMaterial('street_lamp', true);
    this.triangles = (this.geometry.getIndex()?.count ?? 0) / 3;

    this.columnGeometry = buildLightColumn();
    const column = new MeshStandardNodeMaterial();
    column.name = 'light_column';
    column.color = new Color(COLUMN_ALBEDO[0], COLUMN_ALBEDO[1], COLUMN_ALBEDO[2]);
    // Painted steel that has been outside for a decade: rough enough that there
    // is no highlight to chase the sun across the frame, and metalness zero
    // because a metallic workflow with no environment map is a black object.
    column.roughness = 0.72;
    column.metalness = 0;
    this.columnMaterial = column;
    this.columnTriangles = this.columnGeometry.getAttribute('position').count / 3;
  }
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _yaw = /*#__PURE__*/ new Matrix4();
const _scale = /*#__PURE__*/ new Matrix4();
const _colour = /*#__PURE__*/ new Color();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _carScale = /*#__PURE__*/ new Vector3(1, 1, 1);
const _upAxis = /*#__PURE__*/ new Vector3(0, 1, 0);

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

// --- The columns the CBD is actually lit by -----------------------------------

/**
 * Lights on streets that have no power pole near them, derived from the lane
 * graph.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT "INVENTING WORLD DATA".
 *
 * The header above used to end the street-lamp story with a shrug: there are no
 * surveyed poles within 400 m of Sydney Tower, so the CBD has no street lights,
 * and that is the data telling the truth. The first half of that is a fact --
 * measured again here, three poles in the nine tiles around Wynyard against 459
 * in the nine around Newtown -- and the second half is a mistake. The truth the
 * data is telling is that **the CBD's distribution went underground**, not that
 * the city centre is unlit. It is the most brightly lit square kilometre in New
 * South Wales and the most played part of this map, and at night it was a black
 * hole with headlights in it.
 *
 * So the position of a CBD luminaire has to be *derived*, and the argument for
 * doing that here rather than shrugging is that the derivation needs no new
 * data and no guessing. `.lanes.bin` already ships, per tile, every drivable
 * centreline with its **kerb half-width and the footpath band beyond it** --
 * `tiles.write_lanes` wrote that contract down explicitly so that "a pass which
 * wants people walking the footpaths can derive them" -- and it is already
 * decoded and resident on the client for the traffic. A column standing on the
 * footpath, one third of the way in from the kerb face, at 34 m along a
 * secondary road, is not an invention: it is the same arithmetic
 * `game/pedestrians.ts` uses to put a person on the same footpath.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THAT KEEP THE SUBURBS ALONE.
 *
 * A derived light next to a real one is worse than no derived light at all: the
 * whole reason the pole lamps are worth having is that they are where Ausgrid
 * put them. Three tests, in increasing order of how often they fire:
 *
 *   1. **A tile with `COLUMN_TILE_POLE_FLOOR` poles in it derives nothing.**
 *      The coarse test, and it does nearly all the work. Sidecar pole counts
 *      across the 3,187 shipped tiles are bimodal -- 353 tiles have exactly
 *      zero and the non-zero median is 43 -- so a threshold of 12 splits
 *      "overhead suburb" from "underground city" almost perfectly and needs no
 *      distance arithmetic at all.
 *
 *      It is also what makes the whole pass **tile-local and therefore
 *      deterministic**, which rule 2 on its own is not: a way span is clipped to
 *      its own tile and this only ever sees one tile's poles, so a street
 *      running along a tile seam with its poles on the far side would derive a
 *      duplicate column. Rule 1 means that can only happen in a tile that is
 *      already nearly pole-free, where by construction there is no pole line to
 *      duplicate.
 *   2. **No column within `COLUMN_POLE_RADIUS` of a surveyed pole.** The fine
 *      test, for the fringe -- Pyrmont, Millers Point, the Manly waterfront --
 *      where a few poles survive on the back lanes and the main street went
 *      underground. Measured against a pole rather than against a *lit* pole,
 *      deliberately: `LAMP_SHARE` leaves one pole in five dark and filling those
 *      gaps with columns would be exactly the "keep the real positions" rule
 *      being broken one lamp at a time.
 *   3. **No two columns within `COLUMN_MIN_SEPARATION` of each other.** Not
 *      about poles at all. Ways overlap -- a dual carriageway is two ways, an
 *      intersection is four ends, and a gentle curve is a run of segments whose
 *      lattices do not quite agree -- so without this a roundabout is a pile of
 *      columns in one spot.
 *
 * ---------------------------------------------------------------------------
 * THE SPACING LATTICE, AND WHY IT IS NOT AN ARC-LENGTH WALK.
 *
 * The obvious implementation -- walk the polyline accumulating distance, drop a
 * column every `spacing` metres -- has one fatal property in this world: **a way
 * span is clipped to its tile**, so the walk restarts at every tile boundary.
 * That is a phase reset every 500 m on every street in Sydney, and the visible
 * result is a pair of columns 4 m apart at the seam and a 70 m hole at the next
 * one. Rule 3 above cannot fix it, because rule 3 is also tile-local.
 *
 * What is used instead is a **world-space lattice**: for each segment, the
 * scalar `u = P . d` (the point's projection onto the segment's own unit
 * direction) is exactly arc length measured from a world-fixed origin, and it is
 * continuous across a clip because both halves of a straight street have the
 * same direction. Columns go where `u` crosses a multiple of the spacing. Two
 * tiles that share a street therefore agree without ever having seen each other,
 * and so do the two halves of one street that a reload split differently.
 *
 * `d` is canonicalised (+X, or +Z on a north-south street) so that a way
 * traversed either way round produces the same lattice, and the phase is hashed
 * off the OSM id so that two parallel streets are not in step. Where a street
 * genuinely bends the lattice shifts, which puts an irregular gap at the corner
 * -- which is where a real street has one.
 */

/**
 * How near a surveyed pole kills a derived column, metres.
 *
 * 40 m is one pole pitch. Any less and a column lands between two poles on a
 * street that already has a lamp line; any more and the fringe streets this test
 * exists for -- a laneway with two poles on it feeding a block that is otherwise
 * underground -- stay dark for a hundred metres either side of those two poles.
 */
export const COLUMN_POLE_RADIUS = 40;

/**
 * Poles in a tile above which nothing is derived at all. See rule 1 above.
 *
 * Twelve, against a non-zero per-tile median of 43 and a 25th percentile of 23.
 * The gap between "a tile with a pole line in it" and "a tile with a couple of
 * strays" is wide enough that this number is not sensitive; it would have to be
 * wrong by a factor of two to change any tile's answer.
 */
export const COLUMN_TILE_POLE_FLOOR = 12;

/** Two columns nearer than this are one column. See rule 3 above. */
const COLUMN_MIN_SEPARATION = 24;

/**
 * How far under the terrain a street has to run before it is a **tunnel** and
 * gets no column at all, metres.
 *
 * A way's `y` in `.lanes.bin` is the solved *running surface*, which for most of
 * Sydney is the ground and for some of it is not. Above the terrain is a
 * viaduct, and a column standing on a viaduct is correct -- the Cahill has
 * lights on it. Below the terrain is a tunnel, and a column in a tunnel is a
 * luminaire hanging in mid-air over a park with the top two metres of its own
 * post sticking out of the grass, which is what the Eastern Distributor's portal
 * produced the first time this ran: the lane deck at -49.9 against a terrain at
 * -47.5, so the lamp head came out 6.5 m over the Domain with nothing under it.
 *
 * 1.2 m rather than zero because the terrain grid is 31.25 m a post and a road
 * in a shallow cutting is legitimately a metre under the interpolated surface
 * beside it. Nothing in Sydney is a metre and a bit under the ground by
 * accident.
 */
const COLUMN_TUNNEL_DEPTH = 1.2;

/**
 * Metres between columns, by `LANE_CLASSES` index. Zero means no column at all.
 *
 * Australian practice (AS/NZS 1158's lighting categories, which is what a
 * council designs to) runs category V on traffic routes at 30-45 m and category
 * P on local streets at 40-60 m depending on the mounting height. These sit at
 * the tight end of each because a CBD block is 100-160 m long and a spacing that
 * only fits two columns to a block reads as a gap rather than as a rhythm.
 *
 * The two zeroes are decisions rather than omissions. **Motorways** are lit in
 * reality, on 12 m high-mast columns at 60 m centres in the median -- which is
 * a different object at a different height on a carriageway this pass has no
 * median for, and the Cahill and the Western Distributor are elevated decks
 * whose kerb offsets would put a column in mid-air over Woolloomooloo.
 * **Service ways** are the CBD's laneways and every shopping-centre car park and
 * every driveway in Sydney: 9.95 km of them in the nine tiles around Wynyard
 * against 15.8 of tertiary, and lighting them all would double the count for
 * geometry that is mostly behind a roller door.
 */
const COLUMN_SPACING: readonly number[] = [
  0, 0, // motorway, motorway_link
  34, 34, // trunk, trunk_link
  34, 34, // primary, primary_link
  36, 36, // secondary, secondary_link
  40, 40, // tertiary, tertiary_link
  52, // residential
  52, // unclassified
  52, // living_street
  0, // service
  0, // other
];

/**
 * Above this kerb half-width a street is lit from both sides, metres.
 *
 * 11 m of half-width is a 22 m carriageway, which is four lanes and a median.
 * One row of columns on a road that wide leaves the far kerb outside the pool
 * and reads as a street lit by somebody else's lights -- and a real four-lane
 * road in Sydney has columns on both sides, usually staggered. Below it, one
 * side, chosen by hash: which side of a two-lane street the council put the
 * columns on is not in any data anybody has, and at a 6.5 m pool radius on a
 * 7 m carriageway the wrong choice is not a thing that can be seen.
 */
const COLUMN_BOTH_SIDES_HALF_WIDTH = 11;

/** The kerb face itself, metres, added to the way's own half-width. `parking.py`'s. */
const COLUMN_KERB_FACE = 0.15;
/**
 * How far across the footpath the column stands, as a fraction of its width,
 * and the width assumed where the sidecar says there is none.
 *
 * A third of the way in from the kerb, which is where a real column goes: far
 * enough back that a truck's mirror clears it, near enough that the outreach arm
 * still gets the luminaire over the traffic lane. The 1.5 m floor covers the
 * ways the pipeline gives no footpath at all -- a slip lane, a bridge approach
 * -- where the alternative is a column on the kerb line itself.
 */
const COLUMN_FOOTPATH_FRACTION = 0.34;
const COLUMN_FOOTPATH_MIN = 1.5;

/**
 * Mounting height as a scale on the geometry's nominal, by street class.
 *
 * Two heights, which is what a council buys: a 9 m column with a long outreach
 * on anything a bus runs down, and a 6.5 m one on a local street. The scale is
 * applied on Y alone, exactly as a pole's is, so the pool underneath keeps its
 * `POOL_RADIUS` -- which is correct rather than convenient: a shorter column
 * with the same luminaire throws a slightly smaller and much sharper pool, and
 * at 6.5 m radius against a 6.5 m mount that is a 45-degree cone, which is a
 * real category-P optic.
 */
const COLUMN_TALL_SCALE = 1;
const COLUMN_SHORT_SCALE = 0.72;
/** Classes at or below this index get the tall column: everything down to tertiary_link. */
const COLUMN_TALL_MAX_CLASS = 9;

/** The shaft: radius at the butt and at the top, and how many sides. */
const COLUMN_BUTT_R = 0.115;
const COLUMN_TOP_R = 0.08;
const COLUMN_SIDES = 8;
/** The outreach arm's radius, and the luminaire canister on the end of it. */
const COLUMN_ARM_R = 0.055;
const COLUMN_CAN: readonly [number, number, number] = [0.3, 0.055, 0.11];

/**
 * Painted steel, linear.
 *
 * Ausgrid's columns are galvanised and the City of Sydney's are painted charcoal;
 * this is the darker of the two because the brighter one is a pale vertical line
 * against a night sky in every frame, which is the failure `power.ts` documents
 * for the wires. Under the reference 3 pm sun this lands at about rgb(96), which
 * is a grey pole in daylight -- and they are there in daylight, because a column
 * that appeared at dusk would be the most obvious object in the game.
 */
const COLUMN_ALBEDO: Rgb = [0.052, 0.055, 0.058];

/** A flat-shaded solid: triangles with no vertex sharing, so `computeVertexNormals` gives facets. */
class Solid {
  readonly position: number[] = [];

  tri(a: readonly number[], b: readonly number[], c: readonly number[]): void {
    this.position.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  quad(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** A tapered prism between two points, `sides` around. Open at both ends; nobody sees either. */
  tube(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    ra: number,
    rb: number,
    sides: number,
  ): void {
    // A frame about the axis. The axis is never vertical *and* horizontal, so
    // one fixed reference is enough as long as it is the one the axis is least
    // parallel to.
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az) || 1;
    const ux = ax / len;
    const uy = ay / len;
    const uz = az / len;
    const refY = Math.abs(uy) > 0.9 ? 0 : 1;
    const refX = Math.abs(uy) > 0.9 ? 1 : 0;
    let px = uy * 0 - uz * refY;
    let py = uz * refX - ux * 0;
    let pz = ux * refY - uy * refX;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl;
    py /= pl;
    pz /= pl;
    const qx = uy * pz - uz * py;
    const qy = uz * px - ux * pz;
    const qz = ux * py - uy * px;
    for (let s = 0; s < sides; s++) {
      const t0 = (s / sides) * Math.PI * 2;
      const t1 = ((s + 1) / sides) * Math.PI * 2;
      const at = (t: number, r: number, o: readonly [number, number, number]) =>
        [
          o[0] + (px * Math.cos(t) + qx * Math.sin(t)) * r,
          o[1] + (py * Math.cos(t) + qy * Math.sin(t)) * r,
          o[2] + (pz * Math.cos(t) + qz * Math.sin(t)) * r,
        ] as const;
      this.quad(at(t0, ra, a), at(t0, rb, b), at(t1, rb, b), at(t1, ra, a));
    }
  }

  box(centre: readonly [number, number, number], half: readonly [number, number, number]): void {
    const [x, y, z] = centre;
    const [hx, hy, hz] = half;
    const p = (sx: number, sy: number, sz: number) => [x + sx * hx, y + sy * hy, z + sz * hz] as const;
    this.quad(p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1));
    this.quad(p(-1, -1, 1), p(1, -1, 1), p(1, -1, -1), p(-1, -1, -1));
    this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1));
    this.quad(p(1, -1, 1), p(-1, -1, 1), p(-1, 1, 1), p(1, 1, 1));
    this.quad(p(-1, -1, 1), p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1));
    this.quad(p(1, -1, -1), p(1, -1, 1), p(1, 1, 1), p(1, 1, -1));
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The physical column: shaft, outreach arm, luminaire canister.
 *
 * Authored base-at-zero and to exactly the height the glow geometry expects, so
 * the two take the same per-instance Y scale and the luminaire canister is
 * always inside the glow blob rather than beside it. `verifyNightLights` checks
 * that from the geometry rather than trusting this comment.
 *
 * 36 triangles, no cap on either end of the shaft (the top is under the arm and
 * the bottom is in the footpath), and no base plate: at 9 m the plate is four
 * pixels and the eye is looking at the silhouette of the shaft against the sky.
 */
function buildLightColumn(): BufferGeometry {
  const s = new Solid();
  const headY = NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION;
  // The shaft, stopping a little under the head so the arm has somewhere to
  // leave from, and leaning nothing: a steel column is plumb where a timber pole
  // is not, which is most of what says the two are different objects.
  s.tube([0, 0, 0], [0, headY - 0.35, 0], COLUMN_BUTT_R, COLUMN_TOP_R, COLUMN_SIDES);
  // The arm, out along the same +X the glow's pool and the point light use.
  s.tube([0, headY - 0.35, 0], [LAMP_OUTREACH, headY - 0.05, 0], COLUMN_ARM_R, COLUMN_ARM_R * 0.8, 5);
  // And the luminaire on the end of it, tilted nothing and hanging under the
  // arm, which is where a real one is.
  s.box([LAMP_OUTREACH, headY - 0.1, 0], COLUMN_CAN);
  return s.build('light_column');
}

/** One derived column: where it stands, which way its arm points, and how tall. */
export interface ColumnSite {
  /** World metres, at the foot of the column. */
  x: number;
  y: number;
  z: number;
  /** Rotation about Y that sends the geometry's +X across the road. */
  yaw: number;
  /** Y scale on both the post and the glow. See `COLUMN_TALL_SCALE`. */
  scale: number;
}

/**
 * Every column this tile's streets want, in world metres.
 *
 * Pure and framework-free -- no `three`, no scene -- so `verifyNightLights` can
 * run it over a synthetic street grid and measure the spacing it actually
 * produces rather than asserting `COLUMN_SPACING` and hoping.
 *
 * `poles` is this tile's power sidecar in its own tile-local frame, or null for
 * the 353 tiles that have none; `ways` is `decodeLanes`' output, which is
 * already in world metres. `groundAt` takes **world** metres and answers the
 * terrain height, and may be null -- see `COLUMN_TUNNEL_DEPTH` for the one thing
 * it is used for and what happens without it.
 */
export function deriveColumnLamps(
  ways: readonly LaneWay[],
  poles: TilePower | null,
  originX: number,
  originZ: number,
  groundAt: ((x: number, z: number) => number) | null = null,
): ColumnSite[] {
  const poleCount = poles?.poleCount ?? 0;
  // Rule 1. The coarse test, and the one that makes this tile-local safely.
  if (poleCount >= COLUMN_TILE_POLE_FLOOR) return [];

  const sites: ColumnSite[] = [];
  // Rule 3's accelerator: a hash grid at the separation radius, so the check is
  // nine buckets rather than a scan over everything placed so far. A CBD tile
  // produces of the order of sixty columns, which is small enough that the
  // difference does not matter and large enough that the quadratic version would
  // be the slowest thing in this file.
  const grid = new Map<number, number[]>();
  const cellOf = (x: number, z: number): number =>
    (Math.floor(x / COLUMN_MIN_SEPARATION) & 0xffff) * 0x10000 + (Math.floor(z / COLUMN_MIN_SEPARATION) & 0xffff);
  const clear = (x: number, z: number): boolean => {
    const gx = Math.floor(x / COLUMN_MIN_SEPARATION);
    const gz = Math.floor(z / COLUMN_MIN_SEPARATION);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = grid.get(((gx + i) & 0xffff) * 0x10000 + ((gz + j) & 0xffff));
        if (bucket === undefined) continue;
        for (const n of bucket) {
          const dx = sites[n].x - x;
          const dz = sites[n].z - z;
          if (dx * dx + dz * dz < COLUMN_MIN_SEPARATION * COLUMN_MIN_SEPARATION) return false;
        }
      }
    }
    return true;
  };

  const poleR2 = COLUMN_POLE_RADIUS * COLUMN_POLE_RADIUS;
  const nearPole = (x: number, z: number): boolean => {
    if (poles === null) return false;
    for (let i = 0; i < poleCount; i++) {
      const dx = originX + poles.x[i] - x;
      const dz = originZ + poles.z[i] - z;
      if (dx * dx + dz * dz < poleR2) return true;
    }
    return false;
  };

  for (const way of ways) {
    const spacing = COLUMN_SPACING[way.klass] ?? 0;
    if (spacing <= 0) continue;
    // The phase, so two parallel streets are not in step, and the side, so a
    // suburb of one-sided streets is not all lit from the north. Both off the
    // OSM id alone, which every tile holding a piece of this way agrees about.
    const phase = hash(way.osmId & 0xffff, 7) * spacing;
    const hashedSide = hash(way.osmId & 0xffff, 11) < 0.5 ? 1 : -1;
    const bothSides = way.halfWidth >= COLUMN_BOTH_SIDES_HALF_WIDTH;
    const offset =
      way.halfWidth + COLUMN_KERB_FACE + Math.max(way.footpathWidth, COLUMN_FOOTPATH_MIN) * COLUMN_FOOTPATH_FRACTION;
    const scale = way.klass <= COLUMN_TALL_MAX_CLASS ? COLUMN_TALL_SCALE : COLUMN_SHORT_SCALE;

    for (let i = 0; i + 1 < way.count; i++) {
      const ax = way.x[i];
      const az = way.z[i];
      const bx = way.x[i + 1];
      const bz = way.z[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const ux = dx / len;
      const uz = dz / len;
      // Canonical direction: the lattice must not depend on which end of the
      // segment the file happened to list first, or two tiles' copies of one
      // street disagree at the seam -- which is the whole point of the lattice.
      const cx = ux > 1e-6 || (Math.abs(ux) <= 1e-6 && uz > 0) ? ux : -ux;
      const cz = ux > 1e-6 || (Math.abs(ux) <= 1e-6 && uz > 0) ? uz : -uz;
      const ua = ax * cx + az * cz;
      const ub = bx * cx + bz * cz;
      const lo = Math.min(ua, ub);
      const hi = Math.max(ua, ub);
      const first = Math.floor((lo - phase) / spacing) + 1;
      const last = Math.floor((hi - phase) / spacing);
      const span = ub - ua;
      for (let k = first; k <= last; k++) {
        const u = k * spacing + phase;
        const t = Math.abs(span) > 1e-9 ? (u - ua) / span : 0;
        if (t < 0 || t > 1) continue;
        const px = ax + dx * t;
        const pz = az + dz * t;
        const py = way.y[i] + (way.y[i + 1] - way.y[i]) * t;
        // The kerb normal, in the segment's own frame rather than the canonical
        // one -- which side is which does not matter, only that the two offsets
        // are opposite.
        const nx = -uz;
        const nz = ux;
        for (const side of bothSides ? BOTH_KERBS : hashedSide > 0 ? RIGHT_KERB : LEFT_KERB) {
          const qx = px + nx * offset * side;
          const qz = pz + nz * offset * side;
          if (nearPole(qx, qz)) continue;
          // Underground streets get nothing. See `COLUMN_TUNNEL_DEPTH`.
          if (groundAt !== null && py < groundAt(qx, qz) - COLUMN_TUNNEL_DEPTH) continue;
          if (!clear(qx, qz)) continue;
          // The arm points back across the carriageway, which is `-side` of the
          // kerb normal: `makeRotationY(yaw)` sends local +X to
          // `(cos yaw, 0, -sin yaw)`, so the yaw that aims it at (ix, iz) is
          // `atan2(-iz, ix)`. The same convention `buildTileStreetLamps` uses,
          // stated the same way, because the point light's position is derived
          // from it in both places.
          const ix = -nx * side;
          const iz = -nz * side;
          const n = sites.length;
          sites.push({ x: qx, y: py, z: qz, yaw: Math.atan2(-iz, ix), scale });
          const key = cellOf(qx, qz);
          const bucket = grid.get(key);
          if (bucket === undefined) grid.set(key, [n]);
          else bucket.push(n);
        }
      }
    }
  }
  return sites;
}

const BOTH_KERBS: readonly number[] = [1, -1];
const RIGHT_KERB: readonly number[] = [1];
const LEFT_KERB: readonly number[] = [-1];

/**
 * A tile's derived columns: the post, the glow on it, and the world records the
 * real point lights follow.
 *
 * Two meshes rather than one because they are two different kinds of object with
 * two different lifecycles in the frame. The **post** is a lit standard material
 * that is there at noon and casts a shadow like the pole it stands in for; the
 * **glow** is the same additive geometry, material and instance colour every
 * pole lamp in the city wears, hidden all day by `setNightLightsVisible`. Giving
 * the glow its own mesh is what lets it share `StreetLampAssets` -- one geometry
 * and one material for every luminaire in Sydney however it got there, which is
 * the invariant that class exists to state.
 */
export function buildTileColumnLamps(
  sites: readonly ColumnSite[],
  assets: StreetLampAssets,
  originX: number,
  originZ: number,
): { post: InstancedMesh | null; glow: InstancedMesh | null; lamps: Float32Array } {
  if (sites.length === 0) return { post: null, glow: null, lamps: new Float32Array(0) };

  const post = new InstancedMesh(assets.columnGeometry, assets.columnMaterial, sites.length);
  post.name = 'light_columns';
  const glow = new InstancedMesh(assets.geometry, assets.material, sites.length);
  glow.name = 'light_column_glow';
  const lamps = new Float32Array(sites.length * LAMP_RECORD_STRIDE);

  for (let n = 0; n < sites.length; n++) {
    const site = sites[n];
    _yaw.makeRotationY(site.yaw);
    _scale.makeScale(1, site.scale, 1);
    // Tile-local, exactly as the poles are: the group's translation carries
    // them and float32 vertex precision stays constant across the extent.
    _matrix.makeTranslation(site.x - originX, site.y, site.z - originZ);
    _matrix.multiply(_yaw);
    _matrix.multiply(_scale);
    post.setMatrixAt(n, _matrix);
    glow.setMatrixAt(n, _matrix);

    // **Always LED, never sodium.** The 150 m colour cell in `lampAt` models a
    // conversion that is still running street by street in the suburbs; the CBD
    // and the arterials finished theirs years ago, and the streets that reach
    // this function are exactly the ones a council did first.
    _colour.setRGB(LAMP_LED_COLOUR[0], LAMP_LED_COLOUR[1], LAMP_LED_COLOUR[2]);
    glow.setColorAt(n, _colour);

    const o = n * LAMP_RECORD_STRIDE;
    lamps[o] = site.x + Math.cos(site.yaw) * LAMP_OUTREACH;
    lamps[o + 1] = site.y + NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION * site.scale;
    lamps[o + 2] = site.z - Math.sin(site.yaw) * LAMP_OUTREACH;
    lamps[o + 3] = 0;
  }

  post.instanceMatrix.needsUpdate = true;
  glow.instanceMatrix.needsUpdate = true;
  if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  post.frustumCulled = false;
  glow.frustumCulled = false;
  // The post is a real object and behaves like the pole it replaces: it casts
  // into the sun's depth pass and does not receive, which is `buildTilePoles`'
  // call and is made for the same reason -- a 9 m column on an unbroken footpath
  // throws the only shadow that footpath has.
  post.castShadow = true;
  post.receiveShadow = false;
  glow.castShadow = false;
  glow.receiveShadow = false;
  glow.userData.noShadow = true;
  // Read by `releaseGroupGeometry`: both geometries are the one shared pair in
  // the world, so a tile eviction must release the *instance buffers* and
  // nothing else. `columns` rather than `nightlights` on the post, and the
  // difference is the day: `setNightLightsVisible` walks `nightlights` and would
  // otherwise make every column in the CBD vanish at dawn.
  glow.userData.nightlights = true;
  post.userData.columns = true;
  return { post, glow, lamps };
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
  /**
   * Whether the night is on at all. Set by `NightLights.update`.
   *
   * Starts **true** to match the meshes' own `visible`, which is what makes the
   * first update's `setLive(false)` the call that actually hides them -- the
   * guard below is a per-frame early-out and would otherwise swallow it, and the
   * pair would stay drawn through the whole first day. See the constructor.
   */
  private live = true;
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
      //
      // **Visible at construction, and hidden again by the first `update`.**
      // These two spent every day invisible and were switched on at dusk, which
      // is free for a mesh -- and it meant they were invisible during the boot
      // scene pass, which is not. `main.ts` warms every scene-wide instanced set
      // with one `compileAsync(scene, camera)` before the first frame, and
      // three's `_projectObject` skips an invisible object in that walk exactly
      // as it does in `render`: the set was never reached, and the two pipelines
      // it needs were compiled inside the first frame after sunset instead.
      // Measured at 2 compiles on the dusk frame, which is small and is exactly
      // the class of thing `PipelineWatch` exists to have zero of. `BikeLights`
      // is constructed the same way for the same reason.
      mesh.visible = true;
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

// --- The bike lights ----------------------------------------------------------

/**
 * How many ridden bikes can be lit at once.
 *
 * Protocol v8's interest management sends a client **at most 40 players**, so 40
 * remotes plus the local rider is the ceiling the wire imposes, and 48 is that
 * with room for the offline bike sweep and a dummy or two. 6 kB. `CarLights`
 * sizes itself against the fleet it draws for the same reason and
 * `verifyNightLights` asserts both against the thing that feeds them.
 */
export const BIKE_LIGHT_CAPACITY = 48;

/**
 * The headlight sprite: the lens, the beam volume and the pool on the road.
 *
 * Everything here is the car's argument at a bicycle's scale, and the two
 * differences are worth stating because they are what stops a bike reading as a
 * small car. A car has **two** lamps 1.24 m apart and a bike has one on the
 * centreline, which is the whole silhouette from the front -- a single point of
 * light that does not resolve into a pair as it gets closer is how you know what
 * is coming at you. And a bike's beam is **narrow and short**: 13 m against the
 * car's 11 is close, but at 1.05 m of half-width against 1.5 it is a much
 * tighter wedge, which is what a lamp with a 71-degree optic 0.93 m off the road
 * actually throws.
 */
const BIKE_BEAM_LENGTH = 13;
const BIKE_BEAM_HALF_START = 0.07;
const BIKE_BEAM_HALF_END = 1.05;
/** How far the beam's axis has fallen at its far end. `BIKE_BEAM_PITCH` over `BIKE_BEAM_LENGTH`. */
const BIKE_BEAM_DROP = 1.04;
/**
 * How bright a beam sheet is.
 *
 * Lower than the car's 0.22, and for the reason the car's is lower than it first
 * looked right at, one step further along: this sheet is 0.72 m in front of a
 * **third-person camera that sits 3.2 m behind the rider**, so on a bike it is
 * always in frame and always seen from behind at a shallow angle -- which is the
 * one geometry that stacks the most sheet area into the fewest pixels. At the
 * car's level the whole lower third of the screen washed out the moment the
 * player mounted.
 */
const BIKE_BEAM_LEVEL = 0.15;
/** The lens: small, hot, and the thing you see at 300 m. */
const BIKE_LENS_HALF = 0.075;
const BIKE_LENS_LEVEL = 3.2;
/** The pool the lamp puts on the road ahead. Short, for `CAR_POOL_END`'s terrain reason. */
const BIKE_POOL_START = 1.4;
const BIKE_POOL_END = 10.5;
const BIKE_POOL_HALF_START = 0.35;
const BIKE_POOL_HALF_END = 1.7;
const BIKE_POOL_LIFT = 0.12;
const BIKE_POOL_RISE = 0.3;
const BIKE_POOL_LEVEL = 0.46;
const BIKE_POOL_SEGMENTS = 8;
/**
 * The tail light: a red marker under the saddle, and no beam and no pool.
 *
 * `TAIL_COLOUR`'s exact argument, at a scale that matters more: a share bike's
 * rear light is the only thing behind it, so it is a little brighter relative to
 * the front than a car's is, and it sits at 0.70 m where the seat tube meets the
 * saddle rather than at a car's 0.66 m tail lamp.
 */
const BIKE_TAIL_HALF = 0.085;
const BIKE_TAIL_LEVEL = 1.1;
const BIKE_TAIL_UP = 0.7;
const BIKE_TAIL_BACK = 0.3;

/**
 * The whole lit bike, in the bike's own frame: -Z forward, y = 0 at the road.
 *
 * One geometry and one mesh for the head and the tail together, which is the one
 * place this departs from `CarLights`. A car needs two anchors because the
 * distance between its nose and its tail is a property of the *body type* --
 * a van and a hatch are different lengths -- so the two kits have to be placed
 * from `CAR_BODY_SIZE` separately. Every bike in Sydney is the same bike, so its
 * lamp and its tail light are at fixed offsets in one frame and one instance
 * matrix places both.
 */
function buildBikeLight(): BufferGeometry {
  const m = new Emissive();

  // The lens.
  blob(m, 0, BIKE_LAMP_UP, -BIKE_LAMP_FORWARD, BIKE_LENS_HALF, scaled(BIKE_BEAM_COLOUR, BIKE_LENS_LEVEL));

  // The beam, as two crossed sheets down -Z, each stepped through the car's own
  // `BEAM_STOPS` so the two vehicles' beams fade on the same curve. Three strips
  // per sheet, which is `buildCarHeadLights`' finding restated: a single quad
  // ends at full brightness on a ruled line where it meets the asphalt, and a
  // headlight beam on a road has no such line.
  const edge: Rgb = [0, 0, 0];
  for (let s = 0; s < BEAM_STOPS.length - 1; s++) {
    const [t0] = BEAM_STOPS[s];
    const [t1] = BEAM_STOPS[s + 1];
    const c0 = scaled(BIKE_BEAM_COLOUR, ramp(BEAM_STOPS, t0) * BIKE_BEAM_LEVEL);
    const c1 = scaled(BIKE_BEAM_COLOUR, ramp(BEAM_STOPS, t1) * BIKE_BEAM_LEVEL);
    const at = (t: number) => ({
      z: -BIKE_LAMP_FORWARD - t * BIKE_BEAM_LENGTH,
      y: BIKE_LAMP_UP - t * BIKE_BEAM_DROP,
      half: BIKE_BEAM_HALF_START + (BIKE_BEAM_HALF_END - BIKE_BEAM_HALF_START) * t,
    });
    const a = at(t0);
    const b = at(t1);
    // The horizontal sheet.
    m.quad([a.half, a.y, a.z], [a.half * 0.4, a.y, a.z], [b.half * 0.4, b.y, b.z], [b.half, b.y, b.z],
      [edge, c0, c1, edge]);
    m.quad([a.half * 0.4, a.y, a.z], [-a.half * 0.4, a.y, a.z], [-b.half * 0.4, b.y, b.z], [b.half * 0.4, b.y, b.z],
      [c0, c0, c1, c1]);
    m.quad([-a.half * 0.4, a.y, a.z], [-a.half, a.y, a.z], [-b.half, b.y, b.z], [-b.half * 0.4, b.y, b.z],
      [c0, edge, edge, c1]);
    // And the vertical one, at 55% of the width -- a bike lamp's beam is wider
    // than it is tall for a car's reason and rather more so, because the cutoff
    // is what stops it dazzling. Its *bottom* edge is the one that has to fade:
    // the beam is aimed down, so it is through the road surface well before the
    // far end and an unfaded edge there is a bright line ruled across the
    // asphalt in front of every bike in the city.
    const av = a.half * 0.55;
    const bv = b.half * 0.55;
    m.quad([0, a.y - av, a.z], [0, a.y - av * 0.4, a.z], [0, b.y - bv * 0.4, b.z], [0, b.y - bv, b.z],
      [edge, c0, c1, edge]);
    m.quad([0, a.y - av * 0.4, a.z], [0, a.y + av * 0.4, a.z], [0, b.y + bv * 0.4, b.z], [0, b.y - bv * 0.4, b.z],
      [c0, c0, c1, c1]);
    m.quad([0, a.y + av * 0.4, a.z], [0, a.y + av, a.z], [0, b.y + bv, b.z], [0, b.y + bv * 0.4, b.z],
      [c0, edge, edge, c1]);
  }

  // The road pool, running forward from just ahead of the front wheel. Brightest
  // a third of the way along, for `CAR_POOL_LEVEL`'s reason, and rising along
  // its length for the same terrain slack every pool in this file is given.
  for (let s = 0; s < BIKE_POOL_SEGMENTS; s++) {
    const t0 = s / BIKE_POOL_SEGMENTS;
    const t1 = (s + 1) / BIKE_POOL_SEGMENTS;
    const at = (t: number) => ({
      z: -(BIKE_POOL_START + (BIKE_POOL_END - BIKE_POOL_START) * t),
      y: BIKE_POOL_LIFT + BIKE_POOL_RISE * t,
      half: BIKE_POOL_HALF_START + (BIKE_POOL_HALF_END - BIKE_POOL_HALF_START) * t,
      level:
        ramp(
          [
            [0, 0.3],
            [0.32, 1],
            [0.7, 0.4],
            [1, 0],
          ],
          t,
        ) * BIKE_POOL_LEVEL,
    });
    const a = at(t0);
    const b = at(t1);
    const c0 = scaled(BIKE_BEAM_COLOUR, a.level);
    const c1 = scaled(BIKE_BEAM_COLOUR, b.level);
    // Wound so the face normal is +Y with -Z forward, which `verifyNightLights`
    // re-derives rather than trusting: a pool wound the other way is culled by
    // `FrontSide` and the symptom is "the bike light does not light the road".
    m.quadUp([-a.half, a.y, a.z], [-a.half * 0.45, a.y, a.z], [-b.half * 0.45, b.y, b.z], [-b.half, b.y, b.z],
      [edge, c0, c1, edge]);
    m.quadUp([-a.half * 0.45, a.y, a.z], [a.half * 0.45, a.y, a.z], [b.half * 0.45, b.y, b.z], [-b.half * 0.45, b.y, b.z],
      [c0, c0, c1, c1]);
    m.quadUp([a.half * 0.45, a.y, a.z], [a.half, a.y, a.z], [b.half, b.y, b.z], [b.half * 0.45, b.y, b.z],
      [c0, edge, edge, c1]);
  }

  // And the tail.
  blob(m, 0, BIKE_TAIL_UP, BIKE_TAIL_BACK, BIKE_TAIL_HALF, scaled(TAIL_COLOUR, BIKE_TAIL_LEVEL));

  return m.build('bike_light');
}

/**
 * Every ridden bike in view, lit.
 *
 * One `InstancedMesh` over one material, filled declaratively each frame from
 * whoever is riding -- the local player and every remote whose snapshot says so
 * -- exactly as `CarLights` is filled from the traffic's poses, and for the same
 * reason: identity is not needed to draw a light, so the two sources can share a
 * pool without agreeing about ids. `world/bike.ts`'s `RiddenBike` is already
 * drawing each of those bikes from the same numbers.
 *
 * **The remotes matter more than the local rider**, which is not obvious from
 * the code. The player's own headlight is a convenience; somebody else's is
 * information. A rider closing at 26 m/s on a black street is two seconds of
 * warning if they are a moving white point and no warning at all if they are a
 * silhouette, and the lens sprite is deliberately the brightest thing in this
 * geometry so that they read as a headlight before they read as a shape.
 */
export class BikeLights {
  readonly mesh: InstancedMesh;
  readonly geometry: BufferGeometry;
  readonly material: MeshBasicNodeMaterial;
  /** Bikes lit last frame. Read by the dev handle. */
  drawn = 0;
  /** True to match the mesh's own `visible`. See `CarLights.live`. */
  private live = true;
  private count = 0;

  constructor() {
    this.material = nightMaterial('bike_lights', false);
    this.geometry = buildBikeLight();
    const mesh = new InstancedMesh(this.geometry, this.material, BIKE_LIGHT_CAPACITY);
    mesh.name = 'bike_lights';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Never per-instance coloured, and stated rather than left implicit for
    // `CarLights`' reason: `NodeMaterial.setupDiffuseColor` multiplies by
    // `instanceColor` only when the attribute exists at the moment the node
    // graph is built, so its presence is part of the shader. Both colours a bike
    // has -- the cool white in front and the red behind -- are baked into the
    // vertex colours of the one geometry.
    //
    // **Visible at construction, and hidden by the first `update`.** The
    // opposite of what a mesh that spends every day invisible wants, and it is
    // the one thing that keeps the mount/dismount pipeline count flat: the boot
    // scene pass in `main.ts` is a `compileAsync` over the real scene, and
    // three's `_projectObject` skips an invisible object in that walk exactly as
    // it does in `render`. A set that boots hidden is a set whose pipeline is
    // compiled inside whichever frame first shows it -- which for this one is
    // the frame a player mounts a bike at night, and for `CarLights` was the
    // frame the sun went down.
    mesh.visible = true;
    this.mesh = mesh;
  }

  /** Whether the sprites are being drawn at all. See `NIGHT_VISIBLE_LEVEL`. */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.mesh.visible = live;
  }

  /** Start a frame. False when the night is not on, and then `add` is never called. */
  begin(): boolean {
    this.count = 0;
    return this.live;
  }

  /**
   * One ridden bike, placed exactly as `RiddenBike.set` places its frame: the
   * point given is the rider's **feet**.
   *
   * No lean. `RiddenBike` rolls the local player's bike into a turn and the
   * light does not follow it, which is deliberate rather than an omission -- a
   * lamp bolted to a head tube does roll with the bike in reality, and a beam
   * that rolls 12 degrees puts its pool on the footpath through every corner.
   * The one thing a rider needs from this light is that the road ahead stays
   * lit while they are turning onto it.
   */
  add(x: number, y: number, z: number, yaw: number): void {
    if (this.count >= BIKE_LIGHT_CAPACITY) return;
    _position.set(x, y, z);
    _quaternion.setFromAxisAngle(_upAxis, yaw);
    _carScale.set(1, 1, 1);
    _matrix.compose(_position, _quaternion, _carScale);
    this.mesh.setMatrixAt(this.count, _matrix);
    this.count++;
  }

  end(): void {
    if (this.count > 0 || this.mesh.count > 0) this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.count;
    this.drawn = this.count;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
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
  readonly bikeLights = new BikeLights();

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
   * Which of the three jobs the spot light did last frame, so a change of mount
   * can snap the lag instead of sweeping through it.
   *
   * Without this, mounting a bike is a 0.075 s exponential chase from wherever
   * the hand was pointing to wherever the bike is, which at the moment the
   * camera also pulls back to 3.2 m reads as the beam being flung across the
   * street. -1 is "nothing yet", so the first frame of the session snaps too.
   */
  private mountKind = -1;

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
    scene.add(this.bikeLights.mesh);
  }

  /**
   * Place the torch, re-pick the lamps and set the dusk level. Once a frame.
   *
   * `speed` is the player's horizontal speed and drives nothing but the sway
   * amplitude; `lamps` is the streamer, or null offline before it has any tiles.
   *
   * `mount` says where the beam comes from and is **null in first person**, in
   * which case every line below behaves exactly as it did before mounts existed
   * -- the eye plus `TORCH_OFFSET`, the lagged chase, the full sway. That is not
   * a nicety: first person is the calibrated case, every display value in
   * `sky/calibration.ts`'s torch table was measured in it, and the third-person
   * fix must not be a retune of it. See `TorchMount`.
   */
  update(
    dt: number,
    camera: Camera,
    solarAltitudeDeg: number,
    speed: number,
    lamps: LampSource | null,
    mount: TorchMount | null = null,
  ): void {
    const rig = nightRig(solarAltitudeDeg);
    this.level = rig.level;
    // The one write to the one uniform every additive sprite in this file reads.
    nightOpacity.value = rig.level;

    const live = rig.level > NIGHT_VISIBLE_LEVEL;
    this.carLights.setLive(live);
    this.bikeLights.setLive(live);

    this.clock += dt;

    // --- The torch. Three cases and one light; see `TorchMount`.
    const kind = mount === null ? TORCH_MOUNT_HAND : mount.kind;
    const riding = kind === TORCH_MOUNT_BIKE;
    // A change of mount snaps the lag rather than sweeping through it.
    const snap = kind !== this.mountKind;
    this.mountKind = kind;

    // What the beam is chasing. On foot it is the view direction, whether the
    // camera is at the eye or twelve metres behind the player -- a chase camera
    // looks along the player's own aim, so the same vector is both. On a bike it
    // is the machine's heading, pitched down at the road: a lamp bolted to a
    // head tube does not look where the rider looks, which is exactly why the
    // camera can be swung around a rider at night and the road stays lit.
    if (riding && mount !== null) {
      const cosPitch = Math.cos(BIKE_BEAM_PITCH);
      this.forward.set(mount.dx * cosPitch, -Math.sin(BIKE_BEAM_PITCH), mount.dz * cosPitch).normalize();
    } else {
      camera.getWorldDirection(this.forward);
    }

    if (snap) {
      this.aim.copy(this.forward);
    } else if (riding) {
      // Rigid. A bar-mounted lamp has no lag to have: it is bolted to the thing
      // that is turning, and a beam that trailed the bike through a corner would
      // be lighting the kerb you just left.
      this.aim.copy(this.forward);
    } else {
      // Exponential chase, framed so the time constant is in seconds and the
      // result does not depend on the frame rate -- the naive `lerp(a, b, k)` with
      // a constant `k` is a different filter at 60 fps and at 144.
      const chase = 1 - Math.exp(-dt / TORCH_LAG);
      this.aim.lerp(this.forward, Math.min(Math.max(chase, 0), 1));
    }
    if (this.aim.lengthSq() < 1e-9) this.aim.copy(this.forward);
    this.aim.normalize();

    // No hand sway on a bike, and the flicker stays. The sway models an arm
    // settling and a wrist rolling; there is no arm, and the same 2.3 degrees
    // delivered by something bolted to a frame would read as a loose fitting.
    // The flicker is a battery LED's own ripple and belongs on both.
    const sway = torchSway(this.clock, riding ? 0 : speed);
    const swayYaw = riding ? 0 : sway.yaw;
    const swayPitch = riding ? 0 : sway.pitch;
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
      .addScaledVector(this.right, Math.tan(swayYaw))
      .addScaledVector(this.up, Math.tan(swayPitch))
      .normalize();

    // The cone, which is a different shape on a bike. Every one of these four is
    // a *uniform* in three's WebGPU spot light node, written from `light.*` on
    // each frame's update, so moving them costs no pipeline at all -- which is
    // the whole reason one light can do two jobs. See `TorchMount`.
    this.torch.angle = riding ? BIKE_BEAM_ANGLE : TORCH_ANGLE;
    this.torch.penumbra = riding ? BIKE_BEAM_PENUMBRA : TORCH_PENUMBRA;
    this.torch.distance = riding ? BIKE_BEAM_DISTANCE : TORCH_DISTANCE;
    this.torch.decay = TORCH_DECAY;
    const colour = riding ? BIKE_BEAM_COLOUR : TORCH_COLOUR;
    this.torch.color.setRGB(colour[0], colour[1], colour[2]);

    if (mount === null) {
      // First person, unchanged. The eye, offset down and to the right into a
      // hand -- in the **view's** axes rather than the beam's, because it is
      // where the hand is and the hand does not sway with the beam it is
      // holding. `camera.matrixWorld` is current here: `main.ts` calls
      // `updateMatrixWorld` before the sky and the streamer for the same reason.
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
    } else {
      // And in third person the apex is wherever the caller says it is, with no
      // offset at all. `TORCH_OFFSET`'s three components exist to keep the bat
      // and the football out of the beam, and `main.ts` has already taken both
      // viewmodels off the camera's layer by the time a mount is passed -- so
      // the constraint is gone and applying it anyway would put the beam through
      // the top of the player's own head. See `HAND_RIGHT`.
      this.torch.position.set(mount.x, mount.y, mount.z);
    }
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
    this.torch.intensity = rig.torchIntensity * sway.gain * (riding ? BIKE_BEAM_GAIN : 1);

    // --- The real lamps.
    //
    // Searched from the **camera**, always, and not from the mount. What these
    // two lights are for is the lamp the player can see the light of, which is a
    // property of the view rather than of where a torch happens to be held -- and
    // in third person the eye is up to 12.8 m behind the body, so searching from
    // the body would leave the lamp the camera is standing under unlit.
    const eye = camera.position;
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
    this.bikeLights.dispose();
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
    ['bike light', buildBikeLight()],
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

  // 5b. **The density that share actually buys**, which is the half the check
  //     above cannot see. A share is a probability; what a player walks past is
  //     metres between lamps, and the two are only the same sentence once the
  //     pole pitch is in it. The measured pitch off the shipped sidecars is
  //     40 m -- see `LAMP_SHARE` -- so this converts and bounds the result
  //     against the street it is modelling. It is the check that would have
  //     caught the original 0.42 as 95 m rather than reading it as "every second
  //     pole, which is about right".
  const metresPerLamp = MEASURED_POLE_PITCH / LAMP_SHARE;
  if (metresPerLamp > 72) {
    failures.push(
      `At ${(LAMP_SHARE * 100).toFixed(0)}% of a pole line whose measured pitch is ` +
        `${MEASURED_POLE_PITCH} m, a lit street gets a lamp every ${metresPerLamp.toFixed(0)} m. A ` +
        `Sydney back street is lit every 50-60 and an arterial every 30-40, so past about 70 the ` +
        `city reads as one a council has stopped maintaining -- which is what "add more street ` +
        `lights" meant.`,
    );
  }
  if (metresPerLamp < 34) {
    failures.push(
      `A lamp every ${metresPerLamp.toFixed(0)} m is denser than any Sydney residential street, ` +
        `and at a ${MEASURED_POLE_PITCH} m pole pitch it means essentially every pole carries one ` +
        `-- a chain of lights so regular it reads as a fence, which is the failure the hash in ` +
        `lampAt exists to prevent. It is also 2.4x the instanced fill this feature was measured at.`,
    );
  }

  // 6. The derived columns, which are the CBD's whole night and are the one
  //    population in this file with no survey behind them. Four properties,
  //    measured over synthetic streets rather than asserted, because every one
  //    of them fails silently: a lattice that drifts is a double column at a
  //    tile seam, a pole test that never fires is a suburb full of invented
  //    lights, and a spacing constant that is quietly wrong is a CBD that is
  //    lit but not lit *like a city*.
  const straightWay = (
    osmId: number,
    klass: number,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
  ): LaneWay => ({
    osmId,
    klass,
    oneway: false,
    halfWidth: 5,
    footpathWidth: 3,
    count: 2,
    x: new Float32Array([x0, x1]),
    y: new Float32Array([0, 0]),
    z: new Float32Array([z0, z1]),
  });
  const emptyPower = (count: number, at: (i: number) => [number, number]): TilePower => {
    const power: TilePower = {
      poleCount: count,
      x: new Float32Array(count),
      z: new Float32Array(count),
      groundY: new Float32Array(count),
      height: new Float32Array(count).fill(NOMINAL_HEIGHT),
      kind: new Uint8Array(count),
      tiltSeed: new Uint8Array(count),
      wireCount: 0,
      wire: new Float32Array(0),
    };
    for (let i = 0; i < count; i++) {
      const [x, z] = at(i);
      power.x[i] = x;
      power.z[i] = z;
    }
    return power;
  };

  // (a) Spacing, on a 600 m secondary running at 30 degrees to the axes -- a
  //     diagonal deliberately, because the lattice projects onto the segment
  //     direction and an axis-aligned test would pass with the projection
  //     missing entirely.
  const diagonal = straightWay(4242, 6, 0, 0, 600 * Math.cos(0.52), 600 * Math.sin(0.52));
  const derived = deriveColumnLamps([diagonal], null, 0, 0);
  const along = derived
    .map((c) => Math.hypot(c.x, c.z))
    .sort((a, b) => a - b);
  let worstGap = 0;
  let bestGap = Infinity;
  for (let i = 1; i < along.length; i++) {
    worstGap = Math.max(worstGap, along[i] - along[i - 1]);
    bestGap = Math.min(bestGap, along[i] - along[i - 1]);
  }
  const wantGap = COLUMN_SPACING[6];
  if (along.length < 2 || Math.abs(worstGap - wantGap) > 1 || Math.abs(bestGap - wantGap) > 1) {
    failures.push(
      `A 600 m secondary road derives ${along.length} columns with gaps from ` +
        `${bestGap.toFixed(1)} to ${worstGap.toFixed(1)} m, against the ${wantGap} m ` +
        `COLUMN_SPACING asks for. The lattice is meant to be exact along a straight segment; a ` +
        `spread here means the projection onto the segment direction is wrong, and every street ` +
        `in the CBD is unevenly lit.`,
    );
  }
  // And they stand on the footpath rather than in the road. Measured as
  // perpendicular distance from the centreline, which must clear the kerb face.
  const kerb = diagonal.halfWidth + COLUMN_KERB_FACE;
  for (const site of derived) {
    const perp = Math.abs(site.x * Math.sin(0.52) - site.z * Math.cos(0.52));
    if (perp < kerb || perp > kerb + diagonal.footpathWidth) {
      failures.push(
        `A derived column stands ${perp.toFixed(2)} m from the centreline of a road whose kerb ` +
          `face is at ${kerb.toFixed(2)} and whose footpath ends at ` +
          `${(kerb + diagonal.footpathWidth).toFixed(2)}. Inside the kerb it is a column in a ` +
          `traffic lane; past the footpath it is one in somebody's foyer.`,
      );
      break;
    }
  }

  // (b) **The tile seam**, which is the property the world-space lattice exists
  //     for and the only one that cannot be seen in a single tile. A way span is
  //     clipped to its own tile, so the same street arrives as two shorter ways
  //     with a different first vertex -- and the columns derived from the halves
  //     must be exactly the columns derived from the whole. An arc-length walk
  //     fails this by construction; that is why there is not one.
  const cut = 0.371;
  const midX = 600 * Math.cos(0.52) * cut;
  const midZ = 600 * Math.sin(0.52) * cut;
  const halves = [
    ...deriveColumnLamps([straightWay(4242, 6, 0, 0, midX, midZ)], null, 0, 0),
    ...deriveColumnLamps([straightWay(4242, 6, midX, midZ, 600 * Math.cos(0.52), 600 * Math.sin(0.52))], null, 0, 0),
  ];
  const fingerprint = (list: readonly ColumnSite[]): string =>
    list
      .map((c) => `${c.x.toFixed(2)},${c.z.toFixed(2)}`)
      .sort()
      .join(' ');
  if (fingerprint(halves) !== fingerprint(derived)) {
    failures.push(
      `Splitting one street at a tile boundary changes its columns: ${derived.length} whole ` +
        `against ${halves.length} in two pieces. The spacing lattice is world-space precisely so ` +
        `that two tiles holding two clipped halves of one way agree without having seen each ` +
        `other -- see deriveColumnLamps. If this fails, every street crossing a seam has a pair ` +
        `of columns a few metres apart on one side of it and a hole on the other.`,
    );
  }

  // (c) The two rules that keep the suburbs alone. A dense pole line derives
  //     nothing at all; a sparse one derives only where it does not reach.
  const dense = emptyPower(COLUMN_TILE_POLE_FLOOR + 4, (i) => [i * 40, 0]);
  if (deriveColumnLamps([straightWay(11, 10, 0, 0, 600, 0)], dense, 0, 0).length !== 0) {
    failures.push(
      `A tile with ${dense.poleCount} surveyed poles in it derived columns anyway. That test is ` +
        `what makes this pass tile-local and safe: it only ever sees one tile's poles, so a ` +
        `street on a tile seam in a pole-lit suburb would otherwise get a column beside a lamp ` +
        `line it cannot see. Check COLUMN_TILE_POLE_FLOOR.`,
    );
  }
  const stray = emptyPower(2, () => [300, 0]);
  const fringe = deriveColumnLamps([straightWay(12, 10, 0, 0, 600, 0)], stray, 0, 0);
  const nearest = Math.min(...fringe.map((c) => Math.hypot(c.x - 300, c.z)));
  if (fringe.length === 0 || nearest < COLUMN_POLE_RADIUS) {
    failures.push(
      `On a street with two stray poles at 300 m, ${fringe.length} columns were derived and the ` +
        `nearest is ${nearest.toFixed(1)} m from a pole, inside the ${COLUMN_POLE_RADIUS} m ` +
        `COLUMN_POLE_RADIUS. A pole that already has a luminaire on it must win; the derived set ` +
        `is for the streets the survey has nothing on.`,
    );
  }

  // (c2) And the tunnel rule, which is the one that came from looking at the
  //      thing rather than from reasoning about it. A way whose deck is well
  //      under the terrain is underground, and a column there is a luminaire
  //      floating over a park with two metres of post sticking out of the grass.
  const tunnel = deriveColumnLamps(
    [straightWay(13, 6, 0, 0, 400, 0)],
    null,
    0,
    0,
    () => COLUMN_TUNNEL_DEPTH + 2,
  );
  const surface = deriveColumnLamps([straightWay(13, 6, 0, 0, 400, 0)], null, 0, 0, () => 0);
  if (tunnel.length !== 0 || surface.length === 0) {
    failures.push(
      `A street running ${(COLUMN_TUNNEL_DEPTH + 2).toFixed(1)} m under the terrain derived ` +
        `${tunnel.length} columns and one at grade derived ${surface.length}. The first must be ` +
        `zero: a lanes-file y is the *running surface*, and the Eastern Distributor's is 2.4 m ` +
        `below the Domain it runs under -- which put lamp heads in mid-air over the grass. Above ` +
        `the terrain is a viaduct and is left alone; the Cahill has lights on it.`,
    );
  }

  // (d) The column's geometry has to agree with the glow that hangs on it, and
  //     the two are built by different functions from the same two constants --
  //     which is exactly the kind of agreement that rots. A luminaire canister
  //     outside its own glow blob reads as a bug in the terrain.
  const columnGeometry = buildLightColumn();
  const cpos = columnGeometry.getAttribute('position');
  let columnMinY = Infinity;
  let columnMaxY = -Infinity;
  let canMaxX = -Infinity;
  for (let i = 0; i < cpos.count; i++) {
    columnMinY = Math.min(columnMinY, cpos.getY(i));
    columnMaxY = Math.max(columnMaxY, cpos.getY(i));
    canMaxX = Math.max(canMaxX, cpos.getX(i));
  }
  const glowHead = NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION;
  if (columnMinY < -1e-6 || columnMaxY > glowHead + 1e-6) {
    failures.push(
      `The light column runs from ${columnMinY.toFixed(3)} to ${columnMaxY.toFixed(3)} m; it has ` +
        `to sit between the footpath and the ${glowHead.toFixed(2)} m the glow's lamp head is at, ` +
        `or the post and the light on it are two objects.`,
    );
  }
  if (Math.abs(canMaxX - (LAMP_OUTREACH + COLUMN_CAN[0])) > 1e-3) {
    failures.push(
      `The column's luminaire reaches ${canMaxX.toFixed(2)} m along the arm rather than ` +
        `${(LAMP_OUTREACH + COLUMN_CAN[0]).toFixed(2)}. The arm's outreach is the same ` +
        `LAMP_OUTREACH the glow's pool and the real point light are both offset by; if they ` +
        `disagree the lamp is lighting a place it is not.`,
    );
  }
  columnGeometry.dispose();

  // 7. The instanced budgets, which are the other half of "no surprises at
  //    night": a capacity under the fleet ceiling is cars that are drawn and not
  //    lit, which looks like a bug in the traffic rather than in the lights.
  if (CAR_LIGHT_CAPACITY < 384) {
    failures.push(
      `CAR_LIGHT_CAPACITY is ${CAR_LIGHT_CAPACITY}, under the 384 world/cars.ts sizes its own ` +
        `fleet buffers at. Every moving car in view has to be able to have its lights on.`,
    );
  }
  if (BIKE_LIGHT_CAPACITY < 41) {
    failures.push(
      `BIKE_LIGHT_CAPACITY is ${BIKE_LIGHT_CAPACITY}, under the 41 that protocol v8's 40-player ` +
        `interest cap plus the local rider can produce. A ridden bike that is drawn and not lit ` +
        `is a silhouette closing at 26 m/s in the dark.`,
    );
  }

  // 8. **The mount state machine**, which is the recompile guarantee restated
  //    for the thing most likely to break it. One spot light does three jobs
  //    (see `TorchMount`) and the whole argument for that rests on every
  //    difference between them being a uniform -- so this steps a real rig
  //    through walk, mount, ride, dismount and asserts that the *set of lights*
  //    is bit-identical at the end while the beam has visibly moved twice.
  const probe2 = new NightLights(new Object3D());
  const camera = new PerspectiveCamera(70, 1.6, 0.1, 2000);
  const identity = (rig: NightLights): string =>
    rig.realLights.map((l) => `${l.id}:${l.visible ? 1 : 0}`).join(',');
  const before = identity(probe2);

  // First person: the eye, plus `TORCH_OFFSET` and nothing else.
  camera.position.set(100, 2, 200);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  probe2.update(1 / 60, camera, -20, 0, null, null);
  const firstPersonReach = probe2.torch.position.distanceTo(camera.position);
  const offsetLength = Math.hypot(TORCH_OFFSET[0], TORCH_OFFSET[1], TORCH_OFFSET[2]);
  if (Math.abs(firstPersonReach - offsetLength) > 1e-3) {
    failures.push(
      `In first person the torch sits ${firstPersonReach.toFixed(3)} m from the eye rather than ` +
        `TORCH_OFFSET's ${offsetLength.toFixed(3)}. First person is the calibrated case -- every ` +
        `display value in calibration.ts's torch table was measured in it -- and the ` +
        `third-person fix must not have moved it.`,
    );
  }

  // Third person: the camera pulls back 8 m and the beam must not follow it.
  const mount = createTorchMount();
  camera.position.set(100, 3, 208);
  camera.updateMatrixWorld(true);
  torchHandMount(mount, 100, 0.32, 200, 0);
  probe2.update(1 / 60, camera, -20, 0, null, mount);
  const handError = Math.hypot(
    probe2.torch.position.x - mount.x,
    probe2.torch.position.y - mount.y,
    probe2.torch.position.z - mount.z,
  );
  const behind = probe2.torch.position.distanceTo(camera.position);
  if (handError > 1e-6 || behind < 7) {
    failures.push(
      `With the camera 8 m behind the player the torch is ${handError.toFixed(3)} m off the hand ` +
        `mount and ${behind.toFixed(2)} m from the eye. In third person the beam has to leave the ` +
        `*body*: parented to the camera it throws the player's own silhouette down the street and ` +
        `lights the wrong side of everything, which is what a player reported.`,
    );
  }

  // On the bike: a different apex, a different cone, a different colour, and
  // still exactly three lights.
  torchBikeMount(mount, 100, 0, 200, 0);
  probe2.update(1 / 60, camera, -20, 8, null, mount);
  if (probe2.torch.angle !== BIKE_BEAM_ANGLE || probe2.torch.distance !== BIKE_BEAM_DISTANCE) {
    failures.push(
      `Riding leaves the beam at angle ${probe2.torch.angle} / distance ${probe2.torch.distance} ` +
        `rather than the bike's ${BIKE_BEAM_ANGLE} / ${BIKE_BEAM_DISTANCE}. A bar-mounted lamp ` +
        `cannot be aimed, so what it can do instead is light the width of the road.`,
    );
  }
  // Aimed down the bike rather than wherever the camera is pointing, which is
  // the property that lets a player swing the view around while riding.
  const beamZ = probe2.torch.target.position.z - probe2.torch.position.z;
  if (!(beamZ < -20)) {
    failures.push(
      `The bike beam is not pointing along the bike: its target is ${beamZ.toFixed(1)} m in z from ` +
        `the lamp with the bike facing -Z. A headlight that follows the camera is a torch with ` +
        `extra steps.`,
    );
  }
  if (probe2.torch.position.y < 0.5 || probe2.torch.position.y > 1.4) {
    failures.push(
      `The bike's lamp is ${probe2.torch.position.y.toFixed(2)} m over the road; it belongs on the ` +
        `head tube at about ${BIKE_LAMP_UP}, which is where the lens sprite is drawn.`,
    );
  }

  // And off again. Everything the ride changed has to come back, or the first
  // dismount of the session leaves the player holding a floodlight.
  probe2.update(1 / 60, camera, -20, 0, null, null);
  if (
    probe2.torch.angle !== TORCH_ANGLE ||
    probe2.torch.distance !== TORCH_DISTANCE ||
    Math.abs(probe2.torch.color.r - TORCH_COLOUR[0]) > 1e-6
  ) {
    failures.push(
      `After dismounting the beam is still the bike's (angle ${probe2.torch.angle}, distance ` +
        `${probe2.torch.distance}). Every one of those is written unconditionally each frame ` +
        `precisely so that no state can be left behind by a mount.`,
    );
  }
  if (identity(probe2) !== before) {
    failures.push(
      `The set of real lights changed across a walk, a mount, a ride and a dismount: ` +
        `"${before}" became "${identity(probe2)}". That set is a shader constant -- ` +
        `LightsNode.customCacheKey hashes every light's id and visibility -- so this is a full ` +
        `recompile of every pipeline in the scene on the frame somebody got on a bike, which is ` +
        `the exact hitch world/warmup.ts exists to prevent. See TorchMount for why the bike ` +
        `reuses this light rather than adding a fourth.`,
    );
  }
  // The sprites are meshes and may be hidden freely; the *lights* may not, and
  // the two are one keystroke apart in this file. So: on at midnight, off at
  // three in the afternoon, and the light set unchanged either way.
  if (!probe2.bikeLights.mesh.visible || probe2.carLights.meshes.some((m) => !m.visible)) {
    failures.push(
      `The night's additive sets are not drawn with the sun 20 degrees down. They are the whole ` +
        `of what a headlight looks like -- the real lights only ever put light on surfaces -- so ` +
        `a set left hidden at midnight is a fleet of invisible cars and an unlit bike.`,
    );
  }
  probe2.update(1 / 60, camera, 57.11, 0, null, null);
  if (probe2.bikeLights.mesh.visible || probe2.carLights.meshes.some((m) => m.visible)) {
    failures.push(
      `The night's additive sets are still drawn at 3 pm. An additive blend at zero alpha is a ` +
        `no-op visually and is not one in the frame: every fragment is still rasterised and ` +
        `blended, and a bike's road pool is 20 square metres of it. See NIGHT_VISIBLE_LEVEL.`,
    );
  }
  if (identity(probe2) !== before) {
    failures.push(
      `Hiding the day's sprites changed the set of real lights to "${identity(probe2)}". Only ` +
        `meshes may be hidden -- _projectObject skips an invisible object, so an invisible light ` +
        `is off the render list and every pipeline in the scene rebuilds.`,
    );
  }
  probe2.dispose();

  return failures;
}
