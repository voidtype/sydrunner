/**
 * The city after dark: a torch in the player's hand, a lamp on every second
 * power pole, and headlights on the traffic.
 *
 * Until this file existed, night was one thing: the sun goes under the horizon,
 * `solarRig` takes the beam and the bounce to zero, and what is left is
 * `HEMISPHERE_NIGHT` -- 0.064 of luminance on a wall at the time, which is a
 * silhouette. The windows in `facade.ts` light up and the skyline reads
 * beautifully from a distance, and then you try to walk down a street and there
 * is nothing there.
 *
 * (That floor is 0.243 now -- 3.5x, on the same player's second report -- and
 * `sky/calibration.HEMISPHERE_NIGHT` carries the derivation and what it cost.
 * Every ratio quoted in this file has been restated against it. The clock the
 * whole thing is a function of is the *server's* as of protocol v11, and the
 * `N` key that used to be the way to see any of this is gone with it; the
 * console handle is `sydney.sky.scrubTo(0)`.)
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
 * (It is seven now, not three, and the paragraph above is the reason each one
 * had to be argued for in writing before it was added: the saloon of the
 * carriage the player is standing in, the nearest open train doorway, and -- the
 * two newest -- the burning cars nearest the camera. `TrainLights` section 2,
 * the door section and `FIRE_REAL_COUNT` carry those three arguments, and
 * `verifyNightLights` asserts the count so that an eighth cannot arrive without
 * somebody having read all of them. What has never changed is the rule: they are
 * all built at boot and none of them is ever hidden.)
 *
 * So the seven are constructed before `warmUpPipelines` runs, added to the scene
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
  LinearSRGBColorSpace,
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
  createCarPose,
  type CarPose,
  type LaneWay,
} from '../game/traffic.ts';
// One headlight out on a dented car. The threshold is the rules', not this
// file's -- see `game/driving.damageGrade`.
import { CAR_DENTED_HEALTH, createDamageGrade, damageFraction, damageGrade } from '../game/driving.ts';

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
 * The pool of light on the road: its two semi-axes in metres, and how high it
 * floats.
 *
 * ---------------------------------------------------------------------------
 * **THIS WAS A 6.5 M CIRCLE AND THE MODEL BEHIND IT WAS THE WRONG LUMINAIRE.**
 *
 * *"still not enough street lighting, lamps should spill much further"* -- the
 * second time this has been asked for, after `LAMP_SHARE` doubled the number of
 * lamps and the player still said the streets were dark. That is worth reading
 * as the diagnosis it is: the complaint survived the density fix, so the
 * problem was never how many lamps there are. It is how far one reaches.
 *
 * The old number came with an argument that was internally consistent and
 * modelled the wrong object: "6.5 m against a lamp 9 m up is a 72-degree cone,
 * which is a real luminaire's beam". A 72-degree cone is a real *downlight*'s
 * beam -- a bulkhead over a door, a bare lamp in a warehouse. **A street light
 * is not a downlight.** The entire reason a road luminaire has an optic in it
 * is to throw light *along* the kerb line, because poles are 40-60 m apart and
 * a circle of light 13 m across cannot light a road that is lit every 50 m.
 * The distributions have names for it -- Type II and Type III -- and the shape
 * they produce on the road is roughly two to three times as long as it is wide,
 * with its long axis down the street.
 *
 * So the pool is now an **ellipse aligned to the street**, and the axis it is
 * aligned to costs nothing because it is already known: `LAMP_OUTREACH` is
 * along the pole's local +X, which `power.deriveYaw` has aimed **across** the
 * road (it is the crossarm's axis), and `deriveColumnLamps` yaws a kerb column
 * to the kerb normal, which is the same axis for the same reason. Across the
 * street is local X; along the street is local Z; and nothing new has to be
 * derived, stored or guessed to know which is which.
 *
 * ```
 *                       across (X)   along (Z)   area      of the old pool
 *   before                  6.5 m       6.5 m    133 m2    1.00x
 *   after                    10 m        26 m    817 m2    6.15x
 * ```
 *
 * The equal-area radius is `sqrt(10 * 26)` = **16.1 m, which is 2.48x the old
 * 6.5** -- so this is a two-and-a-half-times-wider pool spent unevenly, rather
 * than a bigger circle. Across the street 20 m of width covers a 10 m
 * carriageway and both footpaths, which is all there is to light. Along it,
 * 52 m of lit road per lamp is the number that matters:
 *
 * ```
 *   lamps every 51 m (the CBD and arterials, at LAMP_SHARE over a 40 m pitch)
 *       -> pools overlap; the street is a continuous lit corridor
 *   lamps every 62 m (residential, measured -- see LAMP_SHARE)
 *       -> 10 m of dim road between two pools, against 49 m before
 * ```
 *
 * That last row is the honest one and it is worth stating rather than rounding
 * off: **on an ordinary residential street the pools still do not quite meet.**
 * Closing that last ten metres needs either a third again of pool length -- at
 * a fill cost the measurements below did not support -- or more lamps, which is
 * `LAMP_SHARE`'s business and has already been argued to a Sydney figure. What
 * a player sees now is a road lit end to end with a soft dip between lamps,
 * instead of a chain of separate discs with fifty metres of black between them.
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
 * zero.
 *
 * **`POOL_RIM_LIFT` did not scale with the pool and that is deliberate.** Held
 * at the same 0.85 m of rise, a pool that is now 26 m long is a 1.9-degree
 * ramp rather than a 7.5-degree one, which clears a 3.3% grade over its whole
 * length instead of 13%. That is a real reduction and it was chosen against the
 * alternative rather than overlooked: scaling the rise proportionally would put
 * the lit part of the cone at **1.4 m above the road eight metres from the
 * lamp**, which is a bright additive sheet at chest height that the player
 * walks through -- a new artefact, in exchange for grade tolerance on the
 * steepest one street in fifty. The failure mode that is being accepted instead
 * is the old, quiet one: on a genuinely steep street the far, dim end of a pool
 * loses the depth test and the pool reads shorter. That was the bug once
 * because the *whole* pool vanished; a tail at four percent brightness going
 * missing on Nelson Street is not the same event.
 *
 * The polygon offset stays, and is now doing the job it was always for rather
 * than standing in for a height error: `world/contact.ts`'s argument that a
 * transparent surface which loses the depth fight does not z-fight, it
 * *disappears*.
 */
const POOL_ACROSS = 10;
const POOL_ALONG = 26;
const POOL_LIFT = 0.3;
/** How much higher the rim sits than the middle. See the header above. */
const POOL_RIM_LIFT = 0.85;
const POOL_SEGMENTS = 20;

/**
 * The pool's falloff, as `[radius fraction, brightness]`, the fraction being of
 * the ellipse rather than of a circle: `t = 1` is the rim on either axis.
 *
 * ---------------------------------------------------------------------------
 * **DERIVED RATHER THAN DIALLED, WHICH THE OLD ONE WAS NOT.**
 *
 * The previous table was six stops picked by eye, and measured against the
 * physics it was between two and five times too dark from three metres out: it
 * read 0.36 at 4 m where a lamp 9 m up puts 0.76, and it was at 0.05 by 6 m
 * where the real answer is 0.55. That is the whole of *"still not enough street
 * lighting"* in two numbers -- the pool was not merely small, it fell off the
 * cliff a third of the way across itself.
 *
 * So the shape is now the actual illuminance under a source at height `h`,
 *
 *     E(r) = (1 + (r / h)^2) ^ -1.5
 *
 * -- the inverse square times the cosine of incidence, which is the whole of
 * why the ground under a lamp is brighter than the ground beside it -- with
 * `h` the real `NOMINAL_HEIGHT * LAMP_HEIGHT_FRACTION` of 8.98 m. It is then
 * multiplied by `1 - t^3`, and that taper is not cosmetic: `E` at the rim is
 * 0.12, and an additive surface that ends at 0.12 ends at a **visible ring**.
 * The taper spends the last third of the pool going to exactly zero, which
 * under an additive blend is what an edge is.
 *
 * ```
 *        t      r along     E(r)   taper    stop    the old table at that r
 *     0.00        0.0 m    1.000   1.000   1.000    1.000
 *     0.12        1.9 m    0.935   0.998   0.933    0.807
 *     0.25        4.0 m    0.762   0.984   0.750    0.364
 *     0.40        6.4 m    0.540   0.936   0.505    0.010
 *     0.55        8.8 m    0.364   0.834   0.304    0
 *     0.72       11.5 m    0.232   0.627   0.146    0
 *     0.88       14.1 m    0.155   0.319   0.049    0
 *     1.00       16.0 m    0.117   0.000   0.000    0
 * ```
 *
 * Seven rings rather than the old five, which is 280 triangles a lamp against
 * 200. The extra two are spent entirely on the tail, where the gradient is
 * shallow and a coarse ring would show as a band.
 *
 * `POOL_LEVEL` is **not** touched and neither is the night ambient. The centre
 * of a pool is exactly as bright as it was; every stop between the middle and
 * the rim is brighter, and there are far more metres of them. Note that this
 * curve is applied in the ellipse's normalised coordinate, so along the street
 * it delivers more light per metre than a bare downlight would -- which is
 * precisely what a road optic is for, and is the same physical fact stated
 * twice.
 */
const POOL_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.12, 0.933],
  [0.25, 0.75],
  [0.4, 0.505],
  [0.55, 0.304],
  [0.72, 0.146],
  [0.88, 0.049],
  [1, 0],
];

/** How bright the pool is, linear, before `instanceColor` tints it to the lamp's hue. */
// x1.6 on 2026-09-05 with `sky/calibration.HEMISPHERE_NIGHT`, so the pool keeps
// its ratio to a floor that is 1.6x brighter; the note on that constant lists
// every term that moved with it.
const POOL_LEVEL = 0.8;

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
const HEAD_LEVEL = 3.4;

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
 * How many cars can be showing brake lights at once.
 *
 * Only cars a *player* is steering ever do -- the ambient fleet's braking is a
 * lookup nobody asked to see lit -- and protocol v8 sends a client at most 40
 * players. 48 is that with room for the local driver and a dummy or two, which
 * is `BIKE_LIGHT_CAPACITY`'s own sum and for its own reason. 6 kB.
 */
export const CAR_BRAKE_CAPACITY = 48;

/**
 * The damage grading, shared with the box fleet, the model fleet and the plume.
 *
 * Asked once per lit car per frame and never allocated. See
 * `game/driving.damageGrade` for why the four systems that draw a damaged car
 * take their thresholds from one three-free function rather than each keeping
 * its own: a headlight that went out at a health the paint had not darkened at
 * would be four systems with four opinions about what "dented" means.
 */
const _damage = /*#__PURE__*/ createDamageGrade();

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
const BEAM_LEVEL = 0.29;
/** And the lens itself, which is small, hot and the thing you see at 300 m. */
const HEADLAMP_HALF = 0.15;
const HEADLAMP_LEVEL = 2.9;

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

// --- The burning car ----------------------------------------------------------

/**
 * Real lights kept for cars that are on fire. The brief's two.
 *
 * ---------------------------------------------------------------------------
 * WHY A BURNING CAR GETS A REAL LIGHT WHEN A HEADLIGHT DOES NOT.
 *
 * Everything else in this file's third population is additive geometry, and
 * `world/carsmoke.ts`' header made exactly that argument about the fire itself:
 * an additive quad is a tint at noon and a glow at dusk with no day/night term
 * anywhere, and the flames are already drawn that way. What it also said, in the
 * one sentence this section exists because of, is what that costs -- *"a burning
 * car does not light the wall beside it, and that is a thing only an eye can
 * judge"*. An eye judged it.
 *
 * The distinction that makes this worth two lights when four hundred headlights
 * get none is **how long the thing lasts and how close you are to it**. A
 * headlight is on a car doing 14 m/s past you: it is in frame for two seconds,
 * it points away from everything you are looking at, and the sprite sells it.
 * A burning car stands still for six seconds in the middle of a fight you are
 * having next to it, and the whole read of "get away from that" is the light it
 * throws on the wall, the road and the people standing round it. That is a thing
 * geometry cannot fake, because what is missing is not a glow -- it is the
 * *shading of everything else*.
 *
 * ---------------------------------------------------------------------------
 * AND WHY TWO, WHICH IS THE PART THAT IS A BUDGET.
 *
 * Read the file header first: the set of lights in the scene is in every
 * material's cache key, so these two exist **from boot**, sit at zero intensity
 * all day and every day, and are only ever moved and brightened. Nothing is
 * created when a car catches fire and nothing is destroyed when it explodes;
 * "releasing" a light here means writing 0 into its intensity, exactly as the
 * lamps and the torch are released.
 *
 * Two, and not one: the case this feature is actually for is a *chain reaction*
 * (`carfire.CHAIN_M` is nine metres and the brief calls a chain a feature), so
 * one light would mean the second car in a pile burning without lighting
 * anything and the pair of them flickering as the sort swapped between them.
 * Two, and not four: every light on the list is `N.L` in every shader in the
 * build, paid on every fragment of a sixty-kilometre city whether anything is
 * burning or not, and a third and fourth would be paid for a case -- three cars
 * alight within sixty metres of one camera -- that a session may never contain.
 */
export const FIRE_REAL_COUNT = 2;

/** How far a burning car can be and still be worth a real light, metres. The brief's 60. */
const FIRE_SEARCH_RADIUS = 60;

/** x, y, z per fire in the buffer `FireSource` fills. */
export const FIRE_RECORD_STRIDE = 3;

/**
 * The colour of a car fire, linear. The brief's `#ff7a2a`, warmed on purpose.
 *
 * `#ff7a2a` converted honestly out of sRGB is (1.0, 0.194, 0.023), which is not
 * an orange -- it is a red, because the eye reads a hex swatch against a white
 * page and a *light* against a dark street. Every colour in this file has been
 * through the same correction: `LAMP_SODIUM_COLOUR` is (1.0, 0.48, 0.11) for a
 * lamp whose swatch is far deeper than that, and `world/carsmoke.FLAME_COLOUR`
 * is (1.0, 0.42, 0.08) for the flames this light is standing in for.
 *
 * So it is the flames' own triple, one step warmer in the green to carry the
 * brief's `#ff7a2a` -- and being within a hair of `FLAME_COLOUR` is the point
 * rather than a coincidence: the tongues on the bonnet and the light they throw
 * on the wall behind them have to be the same fire.
 */
const FIRE_COLOUR: Rgb = [1.0, 0.45, 0.12];

/**
 * How bright a burning car is at full night, and how far the light reaches.
 *
 * `LAMP_INTENSITY` is 70 over `LAMP_DISTANCE`'s 32 m for a luminaire on a 7 m
 * pole; a car fire is a smaller source than a street lamp and it is at knee
 * height, so it is dimmer and much shorter -- 46 at 18 m puts roughly the lamp's
 * own illuminance on a wall two metres away and essentially nothing on the far
 * footpath. The shortness is doing real work: a fire that lit a whole
 * intersection would flatten the street lamps it is standing between, and the
 * read this is for is *local* -- the ground round the wreck and the faces of the
 * people who did not get far enough away.
 *
 * Decay 2, like every other point light here, because that is what inverse
 * square is and the whole calibration in `sky/calibration.ts` assumes it.
 */
const FIRE_INTENSITY = 46;
const FIRE_DISTANCE = 18;

/**
 * The flicker: how far the intensity wanders either side of nominal and how
 * fast. The brief's 0.7 to 1.3 at about 9 Hz.
 *
 * Twenty times the torch's `FLICKER` (`TORCH_FLICKER_MAX` is 6%) and that is the
 * whole difference between the two effects: the torch's term is standing in for
 * a hotspot rolling across a surface and *must not be readable as a flicker*,
 * and this one is a fire, where the flicker is the entire tell. A car fire whose
 * light was steady would read as somebody having left the headlights on.
 *
 * Two rates rather than one, on `SWAY_YAW`'s argument restated: a single sine at
 * 9 Hz is a pulse, and a pulse is a machine. 9.0 and 14.3 Hz are incommensurate,
 * so the pattern does not come round, and the amplitudes sum to **exactly**
 * `FIRE_FLICKER_SWING` -- which is what lets the envelope be asserted rather
 * than measured and hoped for. `verifyNightLights` sweeps ten minutes of it
 * anyway, because "the amplitudes sum to 0.3" is a claim about two lines that a
 * third line can quietly break.
 *
 * The per-light phase offset is the other half: two cars burning side by side
 * flickering in step is the single thing that would make this read as a shader
 * rather than as two fires. See `fireFlicker`.
 */
const FIRE_FLICKER: ReadonlyArray<readonly [number, number, number]> = [
  // amplitude, rate (Hz), phase (rad)
  [0.2, 9.0, 0.0],
  [0.1, 14.3, 2.1],
];
export const FIRE_FLICKER_SWING = 0.3;
/** How far apart in the cycle two fires are held, radians. Half a turn of the fast term. */
const FIRE_FLICKER_STAGGER = 1.9;

/**
 * The intensity multiplier for fire `index` at time `t` seconds. 0.7 to 1.3.
 *
 * Pure and framework-free for `torchSway`'s reason exactly: it is a claim about
 * an envelope, and an envelope is a thing a self-check can sweep ten minutes of
 * in a loop rather than assert from the constants and hope.
 */
export function fireFlicker(t: number, index = 0): number {
  let out = 1;
  for (const [amplitude, rate, phase] of FIRE_FLICKER) {
    out += amplitude * Math.sin(t * rate * Math.PI * 2 + phase + index * FIRE_FLICKER_STAGGER);
  }
  return out;
}

/**
 * Where the two fire lights get their cars from.
 *
 * `LampSource`'s twin, and the same interface trick for the same reason: this
 * file must not import `world/carsmoke.ts`, which is a renderer with its own
 * opinions and its own imports, and what it hands back is world metres, which is
 * all a `PointLight` needs. The implementer is `CarSmoke`, which is already
 * handed every driven car in view once a frame together with whether it is
 * alight -- so the list costs a second pass over nothing.
 *
 * The answer is expected to be **last frame's**: `main.ts` runs the night rig
 * before it poses the driven cars. See `CarSmoke.nearestFires`.
 */
export interface FireSource {
  /** Fill `out` with the nearest burning cars -- x, y, z -- and return how many. */
  nearestFires(x: number, y: number, z: number, radius: number, out: Float32Array, max: number): number;
}

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
 * A flat ellipse lying in the XZ plane with a radial brightness ramp, centred on
 * `(cx, cz)` at height `y`.
 *
 * Emitted as a triangle fan from a centre vertex out through the ramp's own
 * stops, so the gradient is carried in vertex colour and interpolated by the
 * rasteriser -- no texture, no sampler, no mip chain. `world/bike.ts` sets out
 * why that is the right call for a soft-edged additive shape: black is invisible
 * under an additive blend, so a colour ramp to black *is* the soft edge.
 *
 * `radiusZ` defaults to `radius`, so every caller that wants a circle writes
 * one and reads as one. The street lamp is the only caller that does not: see
 * `POOL_ACROSS`. The ramp parameter `t` is the **normalised** radius in both
 * cases -- `t = 1` is the rim on whichever axis you leave along -- which is what
 * makes one falloff table describe both shapes.
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
  radiusZ = radius,
): void {
  const at = (t: number): number => y + rise * t;
  for (let ring = 1; ring < stops.length; ring++) {
    const t0 = stops[ring - 1][0];
    const t1 = stops[ring][0];
    const y0 = at(t0);
    const y1 = at(t1);
    const c0 = scaled(WHITE, stops[ring - 1][1] * level);
    const c1 = scaled(WHITE, stops[ring][1] * level);
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius;
      const x1 = Math.cos(a1) * radius;
      const z0 = Math.sin(a0) * radiusZ;
      const z1 = Math.sin(a1) * radiusZ;
      m.quadUp(
        [cx + x0 * t0, y0, cz + z0 * t0],
        [cx + x1 * t0, y0, cz + z1 * t0],
        [cx + x1 * t1, y1, cz + z1 * t1],
        [cx + x0 * t1, y1, cz + z0 * t1],
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
  //
  // `POOL_ACROSS` on X and `POOL_ALONG` on Z, in that order and not the other:
  // local +X is the crossarm's axis and therefore across the road, so the long
  // axis of a road optic's footprint is Z. Swapping them would light twenty-six
  // metres of somebody's front garden and ten metres of the street.
  disc(
    m,
    LAMP_OUTREACH,
    POOL_LIFT,
    0,
    POOL_ACROSS,
    POOL_FALLOFF,
    POOL_LEVEL,
    POOL_SEGMENTS,
    POOL_RIM_LIFT,
    POOL_ALONG,
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

/**
 * The headlights, their beams and the road pool, anchored at the nose centre.
 *
 * `sides` is which lamps the car still has. Both, normally; **one** for the
 * variant a dented car is drawn with -- see `CarLights.add` and
 * `driving.CAR_DENTED_HEALTH`. A second geometry rather than a second instance
 * with half the pair hidden, because there is no way to hide half of an
 * instance: the pair is baked into the vertices, and the whole reason this fleet
 * is two draws for the entire city is that it is two `InstancedMesh` sets over
 * one material. A third set is one more draw call and the same material, and it
 * costs nothing at all on the 99 % of nights when nobody has crashed anything --
 * `mesh.count` is zero and the draw is skipped.
 *
 * The **road pool is kept in both variants**, and deliberately: a car with one
 * headlight still lights the road in front of it, just less evenly, and dropping
 * the pool would make a dented car at night invisible from the front rather than
 * lopsided. What says "one lamp is out" is the pair of lens blobs resolving into
 * one as it comes toward you, which is the same silhouette argument
 * `BIKE_LIGHT_CAPACITY`'s header makes about a bicycle.
 */
function buildCarHeadLights(sides: readonly number[] = [-1, 1]): BufferGeometry {
  const m = new Emissive();

  for (const side of sides) {
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

  return m.build(sides.length === 1 ? 'car_headlight_broken' : 'car_headlights');
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
 *
 * `perInstance` is the one exception the build has and it belongs to the trains,
 * which are the only thing in the city that can be in the dark at noon. It drops
 * the uniform and leaves the level to `instanceColor`; `TrainLights` section 1
 * carries the whole argument, including why nothing else may do this.
 */
function nightMaterial(
  name: string, offset: boolean, perInstance = false,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.name = name;
  material.vertexColors = true;
  material.color = new Color(1, 1, 1);
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = FrontSide;
  if (!perInstance) material.opacityNode = nightOpacity;
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
/**
 * Up to this `LANE_CLASSES` index a street is a **traffic route** and is lit by
 * columns regardless of rule 1: trunk, primary and secondary and their links.
 *
 * Rule 1 was written for the suburbs, where the survey's pole line *is* the
 * street lighting and a derived column beside it is an invented light. It was
 * also what left every arterial through those suburbs dark: Parramatta Road,
 * the Pacific Highway and King Georges Road all run through pole tiles, and
 * their poles carry a luminaire on the same hashed 42% a back street gets --
 * which is a category P rhythm on a category V road. In life a traffic route
 * has its own columns at 30 m whatever the side streets hang off, and the
 * owner asked for exactly that. So on these classes the tile's pole count is
 * not consulted; what is consulted instead is the tile's *lit* lamp records,
 * so a pole that does carry a luminaire on the arterial still wins over a
 * column beside it (`COLUMN_LAMP_RADIUS`). Every other class keeps rule 1.
 */
export const COLUMN_ARTERIAL_MAX_CLASS = 7;
/**
 * A surveyed luminaire nearer than this to a would-be arterial column *is*
 * that column, metres. Smaller than `COLUMN_POLE_RADIUS` on purpose: that one
 * keeps a column away from any pole, lit or not, because on a local street the
 * pole line is the lighting; this one only has to stop two lights standing on
 * one spot, and half a 30 m bay is the distance at which two lamps read as two.
 */
export const COLUMN_LAMP_RADIUS = 15;

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
 *
 * 2026-09-05, the owner: *"more street lamps, esp on arterial roads"*. The
 * traffic routes came down four metres each, to the bottom of category V's
 * band, and -- the bigger change -- they are now lit **whether or not the tile
 * has a pole line in it**: see `COLUMN_ARTERIAL_MAX_CLASS`.
 */
const COLUMN_SPACING: readonly number[] = [
  0, 0, // motorway, motorway_link
  30, 30, // trunk, trunk_link
  30, 30, // primary, primary_link
  32, 32, // secondary, secondary_link
  36, 36, // tertiary, tertiary_link
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
 * `POOL_ACROSS` and `POOL_ALONG` -- which is correct rather than convenient: a
 * shorter column with the same luminaire throws the same footprint at a steeper
 * incidence, which is what a category-P optic on a 6.5 m mount does. The one
 * thing it must not do is shrink, because a local street is exactly the street
 * the player said was too dark.
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
  /**
   * The tile's surveyed luminaires, `LAMP_RECORD_STRIDE` floats each in world
   * metres -- `buildTileStreetLamps`' output -- or null. Only the traffic
   * routes read it; see `COLUMN_ARTERIAL_MAX_CLASS`.
   */
  litLamps: Float32Array | null = null,
): ColumnSite[] {
  const poleCount = poles?.poleCount ?? 0;
  // Rule 1. The coarse test, and the one that makes this tile-local safely --
  // for every class but the traffic routes, which are decided per way below.
  const denseTile = poleCount >= COLUMN_TILE_POLE_FLOOR;
  if (denseTile && !ways.some((w) => w.klass <= COLUMN_ARTERIAL_MAX_CLASS && (COLUMN_SPACING[w.klass] ?? 0) > 0)) {
    return [];
  }

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
  const lampR2 = COLUMN_LAMP_RADIUS * COLUMN_LAMP_RADIUS;
  const nearLamp = (x: number, z: number): boolean => {
    if (litLamps === null) return false;
    for (let i = 0; i < litLamps.length; i += LAMP_RECORD_STRIDE) {
      const dx = litLamps[i] - x;
      const dz = litLamps[i + 2] - z;
      if (dx * dx + dz * dz < lampR2) return true;
    }
    return false;
  };

  for (const way of ways) {
    const spacing = COLUMN_SPACING[way.klass] ?? 0;
    if (spacing <= 0) continue;
    const arterial = way.klass <= COLUMN_ARTERIAL_MAX_CLASS;
    if (denseTile && !arterial) continue;
    // On a traffic route the surveyed *lamps* decide, not the poles; on a
    // local street any pole does. See `COLUMN_ARTERIAL_MAX_CLASS`.
    const taken = arterial ? nearLamp : nearPole;
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
          if (taken(qx, qz)) continue;
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
  /** The one-lamp head kit a dented car is drawn with. See `buildCarHeadLights`. */
  readonly brokenGeometry: BufferGeometry;
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
  /** Brake lamps this frame. Its own counter, because its own set is never gated on night. */
  private brakeCount = 0;
  /** Cars drawn with a lamp out this frame. Its own set, so its own count. */
  private brokenCount = 0;
  /** And the ones with both lamps. `count` less `brokenCount`, tracked rather than derived. */
  private pairedCount = 0;

  constructor() {
    this.material = nightMaterial('car_lights', false);
    this.headGeometry = buildCarHeadLights();
    this.brokenGeometry = buildCarHeadLights([-1]);
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
    // --- And the brake set, third and last, sharing the tail lamp's geometry
    // and the one material. Appended to `this.meshes` rather than exposed
    // separately so `main.ts` adds it to the scene, disposes it and warms its
    // pipeline through the lines that already do all three for the other two --
    // `setLive`, `end` and `dispose` index around it.
    //
    // Visible at construction and *never hidden*, which is the whole point:
    // `mesh.count` is zero unless somebody is braking, and a set with a count of
    // zero costs one skipped draw call. See `setLive`.
    {
      const brakes = new InstancedMesh(this.tailGeometry, this.material, CAR_BRAKE_CAPACITY);
      brakes.name = 'car_brakelights';
      brakes.count = 0;
      brakes.frustumCulled = false;
      brakes.castShadow = false;
      brakes.receiveShadow = false;
      brakes.visible = true;
      this.meshes.push(brakes);
    }
    // --- And the one-lamp set, fourth. Appended for the brake set's reason
    // exactly -- `main.ts` adds, warms and disposes everything in `meshes` -- and
    // gated on the night like the head and tail kits are, because a broken
    // headlight is still a headlight. Sized against
    // `driving.MAX_DRIVEN_CARS`... which it is not: only the cars *in view* are
    // ever added, and the view is bounded by `TRAFFIC_DRAW_RADIUS` and therefore
    // by the same `CAR_LIGHT_CAPACITY` the whole fleet shares. Sharing the
    // constant costs 96 kB of instance buffer for a set that will hold two
    // entries, which is the same trade `CAR_BRAKE_CAPACITY` refuses -- so this
    // one takes the brake set's smaller number, on the identical argument: the
    // cars with a lamp out are the cars a *player* has crashed, and the wire
    // caps those at forty.
    {
      const broken = new InstancedMesh(this.brokenGeometry, this.material, CAR_BRAKE_CAPACITY);
      broken.name = 'car_headlights_broken';
      broken.count = 0;
      broken.frustumCulled = false;
      broken.castShadow = false;
      broken.receiveShadow = false;
      broken.visible = true;
      this.meshes.push(broken);
    }
  }

  /**
   * Whether the sprites are being drawn at all. See `NIGHT_VISIBLE_LEVEL`.
   *
   * **The brake set is exempt**, and that is the whole reason this loop is
   * indexed rather than a `for..of` over `this.meshes`: a brake light is on
   * because a driver is standing on the pedal, which is as true at noon as it is
   * at midnight. Head and tail lamps are a *night* thing and stay gated.
   */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.meshes[0].visible = live;
    this.meshes[1].visible = live;
    // The one-lamp set is a *head* kit and is gated with the other two. Index 2
    // is skipped: see the header above -- a brake light is on because somebody
    // is standing on the pedal, which is as true at noon as at midnight.
    this.meshes[3].visible = live;
  }

  begin(): boolean {
    this.count = 0;
    this.brokenCount = 0;
    this.pairedCount = 0;
    return this.live;
  }

  /**
   * A driven car's brake lamps, on at any hour. Returns nothing and gates on
   * nothing but capacity.
   *
   * Separate from `add` above because the two have different *owners*: `add` is
   * fed by `world/cars.TrafficMovers` for the ambient fleet at night, and this is
   * fed for the handful of cars a player is steering, whenever one of them is on
   * the brake. It reuses the tail geometry and the tail material rather than
   * authoring a second lamp, so a braking car's lights are the same lights every
   * other car in the city has -- which is the point, and is also why this is
   * thirty lines here rather than a module of its own.
   *
   * `begin`/`end` bracket it exactly as they bracket `add`; a frame that calls
   * neither leaves the set at last frame's count, which is why `beginBrakes` is
   * unconditional where `begin` returns a boolean.
   */
  beginBrakes(): void {
    this.brakeCount = 0;
  }

  addBrake(pose: CarPose): void {
    if (this.brakeCount >= CAR_BRAKE_CAPACITY) return;
    // `add`'s half-angle quaternion, and see its comment: one square root
    // against three transcendentals.
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
    _position.set(pose.x - pose.dx * reach, pose.y, pose.z - pose.dz * reach);
    _matrix.compose(_position, _quaternion, _carScale);
    this.meshes[2].setMatrixAt(this.brakeCount, _matrix);
    this.brakeCount++;
  }

  /**
   * The two sets the day/night switch owns: head lamps and tail lamps.
   *
   * `meshes` is what `main.ts` adds to the scene and disposes, and it carries a
   * third entry -- the brake lamps -- that must never be hidden. Every caller
   * asking "is the night's additive geometry drawn" wants *these two*, which is
   * why the distinction is a named getter rather than a slice at each call site.
   */
  get nightSets(): readonly InstancedMesh[] {
    return [this.meshes[0], this.meshes[1], this.meshes[3]];
  }

  endBrakes(): void {
    const mesh = this.meshes[2];
    if (this.brakeCount > 0 || mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
    mesh.count = this.brakeCount;
  }

  add(pose: CarPose): void {
    if (this.count >= CAR_LIGHT_CAPACITY) return;
    // A car sitting in a kerb bay between runs is parked, and a parked car has
    // its lights off -- which is also what the 44,000 static ones do. Without
    // this a schedule car in its dwell is a parked car with its headlights
    // blazing into the terrace in front of it, which is the one thing in this
    // file a player would actually stop and look at.
    //
    // **This line carries much more weight since traffic v3.** A car now holds
    // its bay for the whole of the time the bay is free rather than for a hashed
    // six-to-eighteen seconds, so a kerb bay has a car standing in it 80 % of
    // the time against 54 % before, and the parked share of the fleet in frame
    // went from 134 to 151 of the peak 536. All of that arrives here and leaves
    // again on this one comparison, which is why the *lit* population is
    // unchanged at a measured 403 and `CAR_LIGHT_CAPACITY` needed no revisiting.
    // See `game/traffic.ts`'s residency section.
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

    // --- Which head kit. A car a player has dented enough to break a lamp goes
    // into the one-lamp set instead of the pair -- see `buildCarHeadLights` and
    // `driving.CAR_DENTED_HEALTH`. Zero for every ambient car in the city, so
    // the branch is one float compare and the third set stays at count zero.
    //
    // The **tail** lamps are unchanged and stay on the shared count, because
    // they are in the shared set and because a dented car's tail lights are not
    // what the brief broke: "one headlight out at night" is a front-of-car read,
    // and a car with no tail lights at all would be a car you cannot see from
    // behind, which is a different and much worse effect.
    _position.set(pose.x + pose.dx * reach, pose.y, pose.z + pose.dz * reach);
    _matrix.compose(_position, _quaternion, _carScale);
    if (damageGrade(pose.damage, _damage).headlightOut && this.brokenCount < CAR_BRAKE_CAPACITY) {
      this.meshes[3].setMatrixAt(this.brokenCount, _matrix);
      this.brokenCount++;
    } else {
      // **Its own index**, and this is the one thing this branch could not
      // share: both sets are filled front to back and packed, so a car that
      // went into the broken set must not leave a hole in the paired one --
      // `mesh.count` is what bounds the draw, and an unwritten instance inside
      // that bound is last frame's matrix, which is a pair of headlights
      // hanging in the air where a car used to be.
      this.meshes[0].setMatrixAt(this.pairedCount, _matrix);
      this.pairedCount++;
    }

    _position.set(pose.x - pose.dx * reach, pose.y, pose.z - pose.dz * reach);
    _matrix.compose(_position, _quaternion, _carScale);
    this.meshes[1].setMatrixAt(n, _matrix);

    this.count = n + 1;
  }

  end(): void {
    // Three sets, three counts, and they are deliberately not one number: the
    // tail lamps are on every lit car (set 1, `count`), the head lamps are on
    // the ones with both (set 0, `pairedCount`) and the rest are in the one-lamp
    // set (set 3, `brokenCount`). Index 2 is the brakes and has its own bracket,
    // which is why this was never a walk over `this.meshes` -- see `setLive`.
    const head = this.meshes[0];
    if (this.pairedCount > 0 || head.count > 0) head.instanceMatrix.needsUpdate = true;
    head.count = this.pairedCount;
    const tail = this.meshes[1];
    if (this.count > 0 || tail.count > 0) tail.instanceMatrix.needsUpdate = true;
    tail.count = this.count;
    const broken = this.meshes[3];
    if (this.brokenCount > 0 || broken.count > 0) broken.instanceMatrix.needsUpdate = true;
    broken.count = this.brokenCount;
    this.drawn = this.count;
  }

  /** Release the instance buffers. The geometry and material are this object's and go with it. */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    this.headGeometry.dispose();
    this.brokenGeometry.dispose();
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
const BIKE_BEAM_LEVEL = 0.2;
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

// --- The train ----------------------------------------------------------------

/**
 * How many carriages can be lit at once, per body type.
 *
 * **`world/trains.IMPOSTOR_CAPACITY`, exactly**, and it has to be: every train
 * the fleet draws is a train that must be lit, and a box train with dark windows
 * at 600 m is not a dimmer train, it is a *hole* in the string of lights that is
 * the whole point of this feature. The fleet's own `verifyTrainLights` asserts
 * the two against each other rather than trusting this comment, because the
 * files cannot import each other -- `world/trains.ts` imports this one.
 *
 * Two sets rather than one because a Tangara is a double-decker and a Metropolis
 * is not, and the difference is two rows of windows against one -- see
 * `buildTrainWindows`. 900 instances is 58 kB of matrix and 11 kB of colour per
 * set, which is the same order as the fleet's own instance buffer and is bought
 * once at boot.
 */
export const TRAIN_LIGHT_CAPACITY = 900;

/**
 * And how many train *ends*. Two per consist, so this is the fleet's carriage
 * ceiling divided by the shortest consist in the game -- the Metro's six -- and
 * doubled: 900 carriages is at most 150 trains and therefore 300 ends. The
 * fleet's `verifyTrainLights` does that division against the real consist tables
 * rather than leaving it to this comment.
 */
export const TRAIN_END_CAPACITY = 320;

/**
 * The fluorescent, linear, largest channel 1.
 *
 * A Sydney train's saloon lighting is cool white and reads distinctly *blue*
 * against the sodium and the warm LED in the street below it -- that contrast is
 * most of how a lit train reads as a train rather than as a lit building, so the
 * blue is deliberate and a little past neutral. `LAMP_SODIUM_COLOUR` is
 * [1, 0.48, 0.11] and `LAMP_LED_COLOUR` [1, 0.7, 0.44]; this sits on the other
 * side of white from both of them.
 */
export const SALOON_COLOUR: Rgb = [0.78, 0.87, 1.0];

/**
 * **The ceiling panels themselves, as `emissiveIntensity` on the carriage's own
 * luminaire material.** See `world/trains.paintSaloonPanels`, which is the only
 * caller and which owns the question of *which* material that is.
 *
 * *"The train has these white panels that irl have fluorescent light in them, if
 * u could make those luminos that would be amazing."* Half of that shipped by
 * accident and half of it did not, which is worth writing down because the
 * screenshot that came with the report showed one panel glowing:
 *
 * ```
 *   tangara.glb    interior_emission        emissiveFactor [1,1,1] + a map   glows
 *                  interior_emission.001    no emissiveFactor at all         white plastic
 *   metropolis.glb interior_light           emissiveFactor [1,1,1], no map   glows
 * ```
 *
 * The two Tangara **driving cars** carry `interior_emission` and the two
 * **middle cars** carry `interior_emission.001`, so on an eight-car set the
 * panels light up at the two ends and are dead through the middle -- which is
 * exactly one blooming panel from a platform at Hurstville, and is a property of
 * how somebody exported a Sketchfab model rather than a decision anybody made.
 *
 * So this level is applied to all three, and the ends and the middle of a train
 * agree for the first time. 1.35 rather than the file's implicit 1.0, and the
 * number is set by what a diffuser has to be: **the brightest thing in the
 * carriage, by a clear margin, without being flat white.** Through `EXPOSURE`
 * and the Neutral curve, 1.35 against `SALOON_COLOUR` lands a bare panel at
 * roughly rgb(211, 225, 234) -- a cool white that is plainly a source, with the
 * blue channel nearly clipped and the red two dozen values below it so the tube
 * still has a colour rather than being a hole in the image. At 1.0 it renders
 * 206 neutral, which reads as a white ceiling in a bright room; past about 1.6
 * all three channels clip and the panel becomes a flat cut-out with no shape.
 *
 * **Where the model ships an `emissiveMap`, that map multiplies through and
 * wins the hue**, and it is left to. The Tangara's driving cars have one and it
 * is a warm yellow-green, so their tubes render as an aged fluorescent rather
 * than as this cool white -- which is a fair picture of a Tangara and is not
 * worth overriding, because the same map is what gives the tube its *shape*: it
 * separates the lit diffuser from the frame around it, and no constant here can
 * invent that mask for the carriages that lack one. The level is what this
 * controls on every panel; the colour is what it controls on the panels that
 * have nothing else to say.
 *
 * **Not gated on `nightLevel`, and that is deliberate.** Everything else in this
 * file is a function of the sun because everything else in this file is
 * outdoors; a saloon light is on at noon, in a bore, in a cutting and at
 * Hurstville, which is `SALOON_INTENSITY`'s argument one constant over and the
 * reason both live here rather than in `sky/calibration.ts`. It is also free:
 * `emissiveIntensity` is a uniform, the material is built once per GLB at load,
 * and `warm()` compiles it with everything else before the first frame.
 */
export const SALOON_PANEL_LEVEL = 1.35;

/**
 * Which of a train GLB's materials is a **saloon ceiling luminaire**, and the
 * one rule in the night rig that is a list of names rather than a measurement.
 *
 * Both models are Sketchfab exports and both name the fluorescent panels after
 * what they are, which is the only reason this can be done by name at all:
 *
 * ```
 *   tangara.glb      interior_emission        the two driving cars
 *                    interior_emission.001    the two middle cars
 *   metropolis.glb   interior_light           all three interiors
 * ```
 *
 * `.001` and any further duplicate suffix are matched, because that is what
 * Blender does to a material that got copied when a mesh was, and the copy is
 * the same object on a different carriage. Deliberately **not** matched:
 * `train_all_lights` and `light`, which are the head and tail lamps on the
 * outside of the nose -- those already read correctly, this file hangs additive
 * sprites on them, and pushing them a third brighter would put a blown-out
 * marker on every train in the city.
 *
 * A name list is a weak rule and its failure mode is *silence*: a future model
 * whose panels are called something else simply stays dull, which is
 * indistinguishable from a taste decision. So `world/trains.load` counts what
 * this matched in each file and warns when a model yields none, and
 * `server/integration-check.ts` reads the shipped glTF and asserts the names are
 * still there. Those are the checks; this regex is not one.
 */
export const SALOON_PANEL_RE = /^(interior_emission|interior_light)(\.\d+)?$/;

/**
 * The little of a three material this rule touches, so the rule can be called
 * and checked without a renderer.
 *
 * Structural rather than `MeshStandardNodeMaterial`, and it buys something real:
 * `world/trains.ts` reaches for `document` to measure texture alpha, so a
 * headless process that imported it for this one function would be dragging a
 * DOM in behind it. Typing the two fields the function writes lets the rule live
 * here, beside the level it applies and the colour it applies, and lets
 * `server/integration-check.ts` exercise it for real.
 */
export interface PanelMaterial {
  emissive: { setRGB(r: number, g: number, b: number, colorSpace?: unknown): void };
  emissiveIntensity: number;
}

/**
 * Make a ceiling panel a light rather than a white surface near one. Returns
 * whether this material was one.
 *
 * The whole of it is two writes and both are uniforms, so this costs one
 * material construction at GLB load and nothing per frame. The level is
 * `SALOON_PANEL_LEVEL`, which carries the derivation and the screenshot the
 * request came with; the colour is `SALOON_COLOUR` -- the *same* cool white the
 * window sprites and the real saloon light already use. That last part is the
 * half nobody asked for and is what makes it read: before, a carriage's panels
 * were neutral white plastic while its own windows glowed blue at the platform,
 * so the inside and the outside of one train disagreed about what colour its
 * lighting was.
 *
 * `emissiveIntensity` rather than a colour scaled past 1, because three reads
 * `emissive` as a colour *reference* and a `Color` is not the place to put a
 * radiometric multiplier; the intensity is a float uniform and is exactly what
 * glTF's own `KHR_materials_emissive_strength` is. Any `emissiveMap` the file
 * has is left alone and multiplies through -- it is what separates the tube from
 * its frame on the Tangara's driving cars, and inventing that mask for the
 * models that lack one would be inventing geometry.
 */
export function paintSaloonPanels(m: PanelMaterial, sourceName: string): boolean {
  if (!SALOON_PANEL_RE.test(sourceName)) return false;
  // Written in the working colour space explicitly. These are radiometric, not
  // a swatch, and a future change to the working space must not silently invert
  // them -- the same statement `sky.ts` makes at every `setRGB` it does.
  m.emissive.setRGB(SALOON_COLOUR[0], SALOON_COLOUR[1], SALOON_COLOUR[2], LinearSRGBColorSpace);
  m.emissiveIntensity = SALOON_PANEL_LEVEL;
  return true;
}

/**
 * **The saloon the luminaires light, as opposed to the luminaires.**
 *
 * `SALOON_PANEL_LEVEL` makes the ceiling tubes glow and does nothing whatever to
 * the room under them, because nothing in this renderer carries light from a
 * surface to another surface. So the carriage that shipped was a set of bright
 * strips floating over 69,000 triangles of seat, pole, floor and moquette lit by
 * the **night sky** -- a display value of about 29. Seen through the model's own
 * glazing from a platform that is the interior of an unlit shed, which is why the
 * additive sprite band was doing all the work and why taking it away cannot be
 * the whole change: remove the sticker and put nothing behind the glass and the
 * train reads as *darker* than it did.
 *
 * The correct light source is the one that is already there and cannot reach:
 * twelve fluorescent tubes down a ceiling, filling a 3 m box. What that produces
 * is very close to a **uniform ambient inside the carriage**, and an ambient on a
 * textured surface is exactly `albedo x constant` -- which is what an emissive
 * term with the material's own base-colour map as its `emissiveMap` is. So the
 * moquette stays moquette, the grab poles stay yellow, the floor stays the floor,
 * and all of it comes up together. A flat `emissive` with no map would instead
 * add a constant to every surface and wash the interior into one colour, which is
 * the sticker problem moved indoors.
 *
 * **Level, and it was measured through the glass rather than derived.** A
 * Tangara's interior atlas is dark -- navy moquette, charcoal floor, grey lining,
 * an albedo nearer 0.05 than the 0.25 this file's wall examples use -- and it is
 * then seen through a translucent pane that takes about half of what is left. So
 * the arithmetic that gives a "lit room" for a nominal surface is off by an order
 * of magnitude here, and the honest way to set this was to stand on the platform
 * at Redfern at the darkest phase of a moonless night and read the frame:
 *
 * ```
 *   emissiveIntensity     0      0.6     2.4      5.0
 *   interior, mean          3.0    8.2   20.1    28.4     (of 255, through glass)
 * ```
 *
 * against a **platform deck at 12.8** and a **bodyside at 2.9** in the same
 * frame. 0 is a black box behind glass, which is what shipped under the sprite
 * band; 5.0 buys another two per cent of legibility in the far half of the
 * carriage and costs a stop of the daytime restraint below.
 *
 * **2.0 rather than the 2.4 that reading suggested, and the second frame is why.**
 * The measurement above is a saloon seen through glass from five metres, where
 * everything in the box is moquette and floor. Standing in an *open doorway* at
 * two metres the nearest surface is the vestibule lining, which is the one white
 * thing in the model -- and at 2.4 nine per cent of that panel clipped. Clipping
 * is exactly the failure the player named on the outside of the glass and it is
 * no better on the inside of it. At 2.0 it is under three per cent, on the
 * corners of a panel a metre from the eye, which is what a white panel under a
 * fluorescent does.
 *
 * The colour moved with it -- see `SALOON_ROOM_COLOUR`.
 *
 * **Not gated on the sun, for `SALOON_PANEL_LEVEL`'s reason.** A saloon light is
 * on at noon and this is material state, set once at GLB load, with no per-frame
 * cost and nowhere to read a clock from even if it wanted one. What it costs is
 * that a carriage interior at midday is about a stop brighter than its own albedo
 * under `HEMISPHERE_DAY` would make it -- which is a lit saloon in daylight, seen
 * through glass, next to a sunlit bodyside four times brighter than either. It is
 * the right error and it is the small one; the alternative is a second per-carriage
 * uniform on a 115,000-triangle material to hide a difference nobody can see.
 *
 * **Not the ridden carriage's job.** `SALOON_INTENSITY` is a real `PointLight`
 * and stays exactly as it was: it is what gives the carriage the player is
 * standing in real falloff and real shading, which an ambient cannot. This is
 * what the other hundred and fifty carriages get, from outside, for nothing.
 */
export const SALOON_INTERIOR_GLOW = 2.0;

/**
 * The colour of the light *in* the saloon, as opposed to the colour of the tubes.
 *
 * `SALOON_COLOUR` is [0.78, 0.87, 1.0] and is the radiance of the diffuser
 * itself: a cool white a clear step past neutral, and deliberately so, because
 * that contrast against the sodium in the street below is most of how a lit train
 * reads as a train. This is a step back toward neutral and it is the same
 * argument `BOUNCE_FRACTION` makes about a sunlit street: **the light that has
 * arrived at a surface is not the light that left the source.** What fills a
 * carriage is the tubes' output after two or three bounces off cream lining, grey
 * floor and blue moquette, and every one of those takes blue out.
 *
 * It also fixes a specific artefact rather than only being more correct. The one
 * white surface in either model is the vestibule lining, which is the nearest
 * thing to the eye when standing in an open doorway -- and under a source whose
 * blue channel is at 1.0 and whose red is at 0.78, the first thing that happens
 * as it approaches clipping is that **blue clips alone and the panel goes cyan**.
 * At R/B 0.92 the three channels arrive together, so an over-bright white panel
 * renders as an over-bright *white* panel. The dark moquette, which is nowhere
 * near clipping, keeps its cool cast either way.
 */
export const SALOON_ROOM_COLOUR: Rgb = [0.92, 0.96, 1.0];

/* ---------------------------------------------------------------------------
 * AND HOW MUCH OF ALL OF THAT SURVIVES THE NIGHT, WHICH IS NOT ALL OF IT.
 *
 *   > *"it is too bright at night in the metro"*
 *
 * Three terms light the inside of a carriage and none of them was a function of
 * the sun: `SALOON_PANEL_LEVEL` on the ceiling tubes, `SALOON_INTERIOR_GLOW` on
 * the room under them, and `SALOON_INTENSITY` on the one real light in the
 * carriage the player is standing in. Every one of those paragraphs argues, and
 * argues correctly, that a saloon light is on at noon. That is still true. What
 * is also true, and is what the report is about, is that **this renderer has a
 * fixed exposure and a human eye does not.**
 *
 * At midday a Metropolis interior is one lit box among a city of sunlit
 * surfaces four times brighter than it, and it reads as a lit carriage. At
 * midnight it is the brightest thing within a kilometre and the tone curve gives
 * it exactly the same code values -- so what was "a lit saloon" becomes a light
 * box with a train drawn round it. A real eye adapts down two or three stops
 * walking into a station at night and the picture comes back; nothing in this
 * build does that, so the adaptation has to be spent here or not at all.
 *
 * **Why the Metro and not the Tangara.** Two reasons, and the second is the one
 * that makes this a split rather than a global change. The Metropolis `interior`
 * material is 114,997 triangles of a *bright white* saloon -- white lining, white
 * ceiling, pale floor -- against a Tangara's navy moquette and charcoal, so the
 * same `emissiveIntensity` on the same albedo trick lands the two an easy stop
 * apart before anything else happens. And the Metro is the one train in Sydney
 * that spends its life in a bore, so its interior is what a player sees for the
 * whole of a ride rather than for the length of a tunnel. The Tangara's night
 * was tuned last round against a platform at Redfern and nobody complained about
 * it; it is left exactly where it was, which is what
 * `TANGARA_NIGHT_INTERIOR_GAIN` being 1 says.
 *
 * **0.45, and it is a scene-referred number.** The complaint is relative, so the
 * target is relative: the metro interior at full night is a little under half the
 * radiance it was, which through the Neutral curve is roughly two thirds of the
 * display value and lands the saloon a clear step under the platform lighting
 * instead of a step over it. A real M1 saloon is bright -- it is not floodlit,
 * and it is certainly not the brightest thing at Chatswood at two in the morning.
 * All three terms move together by the same factor, because they are three
 * descriptions of one room and moving them apart would leave the tubes searing
 * over a saloon that had gone dim, which is a different and worse picture.
 *
 * **What is deliberately NOT in this**: the exterior window band (`WINDOW_LEVEL`)
 * and the wedge an open door lays on the platform (`DOOR_SPILL_LEVEL`). Both were
 * tuned last round against the specific complaint that they clipped, both are
 * about what the train looks like from *outside*, and `world/trains.verifyTrainLights`
 * pins both to the value they have so this change cannot drift into them.
 *
 * **The driver is the city-wide dusk ramp and not the carriage's own level**,
 * which is forced rather than chosen: `paintSaloonInterior` writes an
 * `emissiveIntensity` onto a material shared by every carriage of a model, and
 * the bore rule (`world/trains.levelAt`) is per carriage. A per-carriage uniform
 * on a 115,000-triangle material to dim a train in a tunnel at noon is a cost
 * with no picture behind it -- and the report says *at night*.
 * ------------------------------------------------------------------------- */

/**
 * How much of its daytime interior a Metropolis keeps at full night.
 *
 * See the block above for the derivation and for why the Tangara does not share
 * it. `world/trains.verifyTrainLights` asserts this is at most half the day term
 * and no brighter than the Tangara's.
 */
export const METRO_NIGHT_INTERIOR_GAIN = 0.45;

/**
 * And the Tangara's, which is 1 and is a statement rather than a placeholder.
 *
 * The constant exists so that the two trains are visibly two numbers in one
 * table: the alternative is a `metro ? 0.45 : 1` somewhere, which is the same
 * arithmetic with the Tangara's decision written as a fallback rather than as a
 * decision. If a report ever comes in about a Tangara at night, this is where it
 * goes, and `interiorNightGain` needs no change at all.
 */
export const TANGARA_NIGHT_INTERIOR_GAIN = 1;

/**
 * The multiplier on every interior term of a carriage, given how dark it is out.
 *
 * Pure and exported so that `world/trains.verifyTrainLights` can assert the two
 * ends and the monotonicity rather than trusting a lerp, and so that the fleet --
 * which applies it to two materials and one point light -- has no second copy of
 * the rule. Linear in `night` because `nightOpacity` is already a smoothstep over
 * solar altitude (see `NIGHT_START_DEG`): ramping a ramp buys a curve nobody
 * asked for and a dusk that changes speed halfway through.
 *
 * `night` outside 0..1 is clamped rather than trusted. It arrives from
 * `nightLevelNow`, which is a uniform, and a uniform is a thing another file can
 * write.
 */
export function interiorNightGain(metro: boolean, night: number): number {
  const n = night < 0 ? 0 : night > 1 ? 1 : night;
  const floor = metro ? METRO_NIGHT_INTERIOR_GAIN : TANGARA_NIGHT_INTERIOR_GAIN;
  return 1 + (floor - 1) * n;
}

/**
 * Which of a train GLB's materials is **the inside of the carriage**.
 *
 * Deliberately narrow, and the two exclusions are the point: `interior_emission`
 * and `interior_light` are the luminaires and are `SALOON_PANEL_RE`'s, so the
 * anchors and the optional `.001` suffix keep this from swallowing them and
 * putting a second emissive term on a panel that already has one. Blender's
 * duplicate suffix is matched for `SALOON_PANEL_RE`'s reason -- the Tangara's
 * middle cars carry `interior.001`, which is the same room on a different
 * carriage.
 *
 * ```
 *   tangara.glb      interior         69,392 triangles, the driving cars
 *                    interior.001     38,184, the middle cars
 *   metropolis.glb   interior        114,997
 * ```
 *
 * A name list is a weak rule whose failure mode is silence, exactly as over at
 * `SALOON_PANEL_RE`: a model whose interior is called something else gets a dark
 * saloon behind bright glass, which looks like a taste decision. `world/trains.ts`
 * counts what this matched per file and warns on zero, and
 * `server/integration-check.ts` reads the shipped glTF and asserts the names.
 */
export const SALOON_INTERIOR_RE = /^interior(\.\d+)?$/;

/**
 * The little of a three material this rule touches. `PanelMaterial` plus the base
 * map, because the whole trick is that the emissive wears the albedo.
 *
 * `map` is `unknown` rather than `Texture` for `PanelMaterial`'s reason: this
 * interface exists so `server/integration-check.ts` can exercise the rule in a
 * process with no renderer in it, and naming a three type here would drag one in.
 */
export interface InteriorMaterial extends PanelMaterial {
  map?: unknown;
  emissiveMap?: unknown;
}

/**
 * Light the room rather than the tubes. Returns whether this material was one.
 *
 * Three writes, all uniforms or texture bindings set once at GLB load, so this
 * costs nothing per frame. A material with no base map still gets the level --
 * the emissive is then flat, which is the right answer for an untextured surface
 * and is what `emissiveMap` being absent already means to three.
 */
export function paintSaloonInterior(m: InteriorMaterial, sourceName: string): boolean {
  if (!SALOON_INTERIOR_RE.test(sourceName)) return false;
  m.emissive.setRGB(
    SALOON_ROOM_COLOUR[0], SALOON_ROOM_COLOUR[1], SALOON_ROOM_COLOUR[2], LinearSRGBColorSpace,
  );
  m.emissiveIntensity = SALOON_INTERIOR_GLOW;
  // The albedo, as the shape of the light. See `SALOON_INTERIOR_GLOW`.
  if (m.map) m.emissiveMap = m.map;
  return true;
}

/** Half the bodyside, and how far outside it the window sprites hang. */
const TRAIN_HALF_WIDTH = 1.52;
/**
 * The window sprites sit **2 cm proud of the skin**, and both halves of that
 * matter.
 *
 * Proud, because the sprite is depth-tested and never depth-written: at or
 * inside the bodyside it loses the test against the carriage's own opaque hull
 * and simply is not there, which is the failure mode `world/contact.ts` names --
 * a transparent surface that loses does not z-fight, it disappears. Only 2 cm,
 * because the same test is what keeps a train's windows *out of* the frame when
 * the train is behind a warehouse, and because from inside the carriage the
 * sprite is then behind the wall and correctly hidden. A rider looks out of a
 * dark window at a dark city, which is what a window is.
 */
const WINDOW_PROUD = 0.02;

/**
 * The window band: how many panes, how wide, and where the decks are.
 *
 * **Discrete panes rather than a continuous strip, and this is the feature.**
 * A lit train at 300 m is not a glowing line, it is a rhythm -- eight bright
 * rectangles, a dark gap at the coupler, eight more -- and that rhythm is what
 * the eye reads as *a train, moving* rather than as a light source that happens
 * to be travelling. It survives to a surprising distance: the panes stop being
 * resolvable at about 700 m and the beat they leave behind is still legible
 * because the gaps are 40% of the pitch.
 *
 * Everything here is in **unit carriage lengths** on X, because the instance
 * matrix scales X by the consist's own pitch exactly as the impostor box is
 * scaled -- so one geometry is a 19.5 m Tangara and a 21.1 m Metropolis, with the
 * panes and the gaps stretching in proportion, which is what they do in reality.
 *
 * ---------------------------------------------------------------------------
 * **AND IT IS A DISTANT-TRAIN DEVICE ONLY, WHICH IT WAS NOT WHEN IT SHIPPED.**
 *
 * *"i honestly hate the outside sprites u made they look bad"*, with a frame of a
 * Tangara at a platform in which the whole bodyside is a row of flat, uniform,
 * near-white slabs and the yellow door between them has been swallowed. Every
 * word of that is right and the cause is arithmetic rather than taste: this
 * material is **additive in sRGB** (see `nightMaterial`), so `WINDOW_LEVEL` is
 * added to the display value rather than to the radiance. 0.62 was +158 code
 * values on a bodyside sitting at about 20, laid down as an eight-by-two grid of
 * hard-edged rectangles that line up with **nothing** -- the band is a generic
 * unit-length pattern and a Tangara's real glass runs 1.21 to 4.24 m over the
 * railhead in a completely different rhythm. From a platform it is a sticker of a
 * train stuck over a train.
 *
 * It is also, at 300 m, the only reason a train reads as lit at all. Both facts
 * are true at once, so the band is now gated on **distance** rather than deleted:
 * see `windowBandFade`. Inside 60 m a hero carriage wears none of it and what
 * lights it is what actually lights a real one -- the ceiling luminaires
 * (`SALOON_PANEL_LEVEL`), the saloon they light (`SALOON_INTERIOR_GLOW`), and the
 * modelled interior seen through the model's own translucent glazing. Past 150 m
 * it wears the full band, because past 150 m there is no interior to see and a
 * box train has no windows to see it through.
 */
const WINDOW_PANES = 8;
const WINDOW_SPAN = 0.9;
const WINDOW_PANE_SHARE = 0.6;

/**
 * How bright each pane is, as a fraction of `WINDOW_LEVEL`, going down the
 * carriage -- and the answer to "flat, uniform".
 *
 * A real lit carriage is not eight identical rectangles. Somebody is standing in
 * front of that one, this one is behind a grab pole, that one has the blind half
 * down over a seat back, and the vestibule between the two saloons is a stop
 * darker than either. None of that is worth modelling and all of it is worth
 * *implying*, which is what an uneven row of panes does for free: the variation
 * is baked into vertex colour once, at build, and costs a multiply in a loop that
 * runs 32 times in the life of the process.
 *
 * Eight entries for eight panes, and the table is **rotated** by deck and by
 * bodyside -- see `buildTrainWindows`. One table applied identically everywhere
 * would put the same dark pane at the same place on every carriage of every train
 * in the city, which is a pattern rather than a variation and reads worse than
 * uniform does.
 *
 * The 0.22 is the blind, and it is deliberately low enough to be a *gap* in the
 * row rather than a dim pane: at 300 m what survives is the rhythm, and a rhythm
 * needs rests in it.
 */
const WINDOW_PANE_VARIATION: readonly number[] = [1.0, 0.78, 0.93, 0.22, 1.0, 0.86, 0.64, 0.97];

/**
 * Where the sprite band hands over to the real carriage, metres.
 *
 * Two numbers rather than a switch, because a band that vanished at a threshold
 * would pop -- and it would pop on the *nearest* train in the frame, which is the
 * one being looked at. `windowBandFade` ramps it, and the ramp is entirely inside
 * the model tier (`world/trains.MODEL_RADIUS` is 260 m) so nothing crosses the
 * LOD swap and the sprite handover: a carriage is a box wearing a full band, or a
 * model wearing a full band, or a model wearing less of one, in that order,
 * outside in.
 *
 * 60 m is where a 20 m carriage is still 30 degrees across and the grid is
 * plainly a grid. 150 m is where a pane is about four pixels at this field of
 * view and the model's own glass is a smear -- past it the band is carrying the
 * whole train and there is nothing left for it to fight with.
 */
export const WINDOW_HERO_NEAR = 60;
export const WINDOW_HERO_FAR = 150;

/**
 * How much of the window band a carriage `metres` away wears, 0 to 1.
 *
 * Pure, and exported, so `verifyTrainLightKit` can assert the two ends and the
 * monotonicity rather than trusting the smoothstep -- and so `world/trains.ts`
 * has no second copy of the rule. Impostor carriages never call it: they are past
 * both numbers by construction and always wear the whole band.
 */
export function windowBandFade(metres: number): number {
  if (metres <= WINDOW_HERO_NEAR) return 0;
  if (metres >= WINDOW_HERO_FAR) return 1;
  const t = (metres - WINDOW_HERO_NEAR) / (WINDOW_HERO_FAR - WINDOW_HERO_NEAR);
  return t * t * (3 - 2 * t);
}
/** The two saloons of a double-decker, and the one of a single. Metres over the railhead. */
const DECK_LOWER: readonly [number, number] = [1.16, 2.0];
const DECK_UPPER: readonly [number, number] = [2.42, 3.2];
const DECK_SINGLE: readonly [number, number] = [1.34, 2.62];

/**
 * How bright a pane is, and how bright the wash around it.
 *
 * Judged against this file's own population rather than in isolation, which is
 * the only way to judge an additive term in a renderer whose blend is in sRGB: a
 * street lamp's head is 2.6 because it is two pixels at the distance it has to
 * work at, a car's tail light is 0.9 because it is a 5 W marker, and a car's road
 * pool is 0.42 across ten square metres. A carriage window is a large flat area
 * of *diffuse* light -- a metre and a half of glass with a lit ceiling behind it
 * -- so it belongs near the pool rather than near the lamp head, and 0.62 is a
 * window you can see from the far platform without the train reading as being on
 * fire from the near one.
 *
 * The wash is the same band with no gaps in it at a sixth of the level, and it is
 * there for one reason: at 800 m a pane is under a pixel tall and a sub-pixel
 * triangle is a triangle the rasteriser is entitled to miss entirely, so the
 * panes *twinkle* as the train crosses the valley. The wash is continuous along
 * the whole carriage and 2 m tall, so something is always covered, and what the
 * twinkle becomes is a very slight shimmer on a line of light. It also happens to
 * be what a lit carriage does to its own paintwork.
 *
 * **0.62 is 0.40 now, and the paragraph above is exactly where it went wrong.**
 * "From the far platform" and "from the near one" were the two cases considered,
 * and this band is now drawn at neither of them -- `windowBandFade` hands the
 * near platform to the real carriage. What is left for this number to serve is a
 * train at 150 m and beyond, where every pane is a handful of pixels against a
 * black valley and 0.40 is still four times the ambient floor. What 0.62 bought
 * was the last stop of brightness at 800 m, and what it cost was that anything
 * inside a couple of hundred metres clipped: an additive sRGB blend at 0.62 puts
 * +158 code values on whatever is behind it, so eight panes and their wash were a
 * single white slab long before the fade had begun. The wash follows it down by
 * the same ratio, because its whole job is to be a sixth of a pane.
 */
/**
 * Exported for one reason and it is not use: `world/trains.verifyTrainLights`
 * **pins** it. This is a number the metro-interior change of this round had every
 * opportunity to drift into and must not have -- the band is what a train looks
 * like from three hundred metres away and it was tuned, twice, against a player's
 * own screenshot. A constant with a check on it is a constant somebody has to
 * mean to change.
 */
export const WINDOW_LEVEL = 0.4;
const WINDOW_WASH_LEVEL = 0.11;
/** The wash band, which is the two decks and the floor between them as one. */
const WINDOW_WASH: readonly [number, number] = [1.05, 3.3];

/**
 * The headlight: a pair of lamps on the nose and what they throw down the track.
 *
 * A train's headlight is not a car's. It is aimed nearly level -- there is no
 * oncoming driver to dazzle on a railway and the thing it exists to light is the
 * signal and the track a long way off -- so `TRAIN_BEAM_DROP` is a fifth of the
 * car's over three times the length, and the beam runs 30 m rather than 11.
 *
 * 30 m and not more, and the limit is the *curve* rather than the light. The
 * sheet is a straight prism hung off one carriage's frame, and the railway it is
 * hung on bends: on the sharpest curve a train takes at speed here (about 400 m
 * radius) 30 m of chord stands 28 cm off the rails at its tip, which is inside
 * the beam's own half-width. At 60 m it would be 1.1 m and the beam would visibly
 * leave the track.
 */
const TRAIN_BEAM_LENGTH = 30;
const TRAIN_BEAM_HALF_START = 0.22;
const TRAIN_BEAM_HALF_END = 1.9;
const TRAIN_BEAM_DROP = 0.55;
const TRAIN_BEAM_LEVEL = 0.14;
/** Where the lamps sit on the nose: over the railhead, and half-spacing across. */
const TRAIN_LAMP_Y = 0.95;
const TRAIN_LAMP_HALF_SPACING = 1.05;
const TRAIN_LAMP_HALF = 0.19;
const TRAIN_LAMP_LEVEL = 3.0;
/** Headlight colour, linear. A modern rail headlight is white and slightly cool. */
const TRAIN_BEAM_COLOUR: Rgb = [0.96, 0.97, 1.0];
/** The ballast under the beam. Short, for `CAR_POOL_END`'s terrain reason, doubled. */
const TRACK_POOL_START = 2.0;
const TRACK_POOL_END = 22.0;
const TRACK_POOL_HALF_START = 1.0;
const TRACK_POOL_HALF_END = 2.9;
const TRACK_POOL_LIFT = 0.16;
const TRACK_POOL_RISE = 0.3;
const TRACK_POOL_LEVEL = 0.3;
const TRACK_POOL_SEGMENTS = 8;
/** The tail: two red markers on the rear end, `TAIL_COLOUR`'s argument at rail scale. */
const TRAIN_TAIL_HALF = 0.22;
const TRAIN_TAIL_LEVEL = 1.0;

/**
 * How bright the one real light in the carriage is, and how far it reaches.
 *
 * `TORCH_INTENSITY` and `LAMP_INTENSITY` are in `sky/calibration.ts` because they
 * are part of a calibration the daylight rests on -- every one of them is
 * multiplied by `nightLevel` and is therefore exactly zero at noon, which is what
 * makes the daytime numbers in that file still true. **This one is not**, and
 * that is precisely why it is here instead: a train in a bore is lit at noon, so
 * this term is not a function of the sun and putting it in that table would
 * break the one invariant the table exists to state.
 *
 * It is quoted against the same night ambient floor everything else is, and
 * calibrated against the street lamp rather than against taste:
 * `LAMP_INTENSITY` is 70 at `decay = 2` from 8.6 m up, which puts **0.95** of
 * irradiance on the road, and that is what "well lit" is worth in this renderer.
 * 8 at `decay = 1.5` puts 1.5 on a seat 3 m away, 0.9 on the vestibule wall at
 * 4 m and 0.35 at the far end of the carriage -- against the 0.070 a surface gets
 * from the night sky. So the saloon is a couple of stops brighter than the
 * footpath outside it and the far end is still five times the night.
 *
 * (It was 30 for one build and the first screenshot from a seat settled it: at
 * a metre and a half the near wall, the ceiling and the grab poles were all at
 * 255 and the interior had no shading left in it at all. An interior light is
 * judged from *inside*, where the nearest surface is a metre away, and a number
 * that looks reasonable against a street lamp eight metres up is four stops hot
 * there.)
 *
 * `decay = 1.5` rather than the physical 2, and it is the one number here that is
 * not physics. A real fluorescent saloon is a *line* of sources down the ceiling
 * and this is one point standing in for twelve; inverse-square from a single
 * point puts the far vestibule at a twentieth of the near one, which reads as a
 * torch in a tunnel rather than as a lit carriage. 1.5 is the exponent at which
 * one point looks like a row.
 */
export const SALOON_INTENSITY = 8;
const SALOON_DISTANCE = 26;
const SALOON_DECAY = 1.5;
/**
 * How high over the **railhead** the light hangs, at the rider's own plan
 * position.
 *
 * At the rider's x and z, because that is what makes one light enough -- see
 * section 2 -- and at a fixed height rather than at their eye, because 2.55 m is
 * the intermediate floor of a Tangara and this light casts no shadow. A
 * shadowless point light sitting in the deck between the two saloons lights both
 * of them: the lower deck from above at 1.4 m and the upper from below at 1.3 m,
 * which is within a stop of each other. Put it at the rider's eye instead and a
 * player on the upper deck is standing in a dark box with a bright floor.
 */
const SALOON_LIFT = 2.55;
/**
 * How long the saloon light survives without being told about a carriage.
 *
 * A staleness guard and nothing else. Every frame the fleet updates it either
 * places this light or leaves it dark, so in the ordinary course it is exact --
 * but a fleet that stops updating at all (no bake, a rail load that failed, a
 * future caller that forgets) would otherwise leave a point light burning in the
 * middle of Redfern forever, which is a bug with no owner. Half a second is
 * thirty frames: long enough that a dropped frame never flickers it, short enough
 * that nobody sees the orphan.
 */
const SALOON_STALE_S = 0.5;

/* ---------------------------------------------------------------------------
 * THE OPEN DOORS, AND WHAT THEY PUT ON THE PLATFORM.
 *
 * *"the onboard lights need to account for the doors"*, and from outside at
 * night an open door was a **black rectangle** -- the one place on a lit carriage
 * where you are looking straight into the saloon, rendered darker than the
 * bodyside beside it, because the sprite band covered the steel and stopped at
 * the door. Everything below is the correction, and it is deliberately made of
 * the two cheapest things in this file rather than of the obvious expensive one.
 *
 * **The clock is `rail.dwellElapsed` and there is no second one.**
 * `world/trains.doorOpenness` already turns it into 0-to-1 for the leaves the
 * animator drew; the same float arrives here as the instance level and as the
 * real light's. A door that is 40% open spills 40% of the light, by construction,
 * and nothing here can drift from where the leaves actually are.
 *
 * **WHAT IS REAL AND WHAT IS NOT, AND THE BUDGET.**
 *
 * A spot light per open door is 32 lights for one eight-car set, and this file's
 * header prices a real light at 0.6 s of boot and a per-fragment cost in every
 * material in the build, forever. So:
 *
 *   - **Geometry, at every open door of the two hero trains.** A wedge of light
 *     lying on the platform deck, additive, in one instanced draw --
 *     `DOOR_SPILL_CAPACITY` of them, which covers both model-tier consists at
 *     every doorway on both sides with room to spare. Impostor trains get none:
 *     they have no door leaves drawn, so a wedge under one would be light coming
 *     out of a shut steel box.
 *   - **Exactly one real light in the city**, at the single nearest open doorway.
 *     One, and this is the whole argument for the number: the wedge is *emissive*
 *     and therefore lights nothing -- not the player standing in the doorway, not
 *     the bench behind them, not the platform sign. One spot at the door the
 *     player is actually at buys all of that where it can be seen, and the
 *     ninety-ninth doorway in the frame is four pixels of deck.
 *
 * **A spot rather than a point, and that is not an aesthetic choice.** Nothing in
 * this rig casts a shadow (see the header), so a point light hung inside the
 * saloon would light the platform straight through the carriage's steel side --
 * with the doors shut. The cone *is* the mask: anchored in the door aperture and
 * aimed out and down, it reaches the deck outside and nothing behind it, which is
 * the one geometry that gets a shut door and an open door visibly different
 * without a shadow map.
 * ------------------------------------------------------------------------- */

/**
 * Where the platform deck is, metres over the railhead.
 *
 * `game/riding.PLATFORM_TOP_M` and `PLATFORM_INNER_M` restated, exactly as that
 * file restates them from `world/rail-geo.ts`, and for the same reason inverted:
 * this file must not import the riding controller to draw a sprite. What makes
 * the restatement safe is that a doorway frame *is* a carriage frame -- y = 0 is
 * the railhead at both ends of the pipeline -- so 1.05 up and 1.62 out lands on
 * the deck whether the train is at Redfern, on the Meadowbank bridge or in a
 * cutting at Wynyard. `verifyTrainLightKit` asserts these against the two
 * imported constants rather than leaving it to this paragraph.
 */
const DOOR_DECK_Y = 1.05;
const DOOR_DECK_INNER = 1.62;

/**
 * The wedge: how far out over the deck it reaches, and how wide it is at each
 * end.
 *
 * 4.2 m out, against `PLATFORM_WIDTH_M`'s 5.5 -- so the light stops short of the
 * back of the platform and the wedge has a visible far edge on the deck rather
 * than running off it and reading as a lit floor. That gap is the effect: what
 * says "the doors are open" from thirty metres down the platform is the *shape*,
 * a bright trapezium with dark deck either side of it, and a pool that covered
 * the whole width would just be a brighter station.
 *
 * It spreads, 1.15 m half-width at the threshold to 2.05 at the far edge, which
 * is the projection of a 2.3 m aperture lit from a ceiling 2 m inboard of it.
 * The threshold half-width is the Tangara's own doorway (measured off the shipped
 * GLB: leaves at x -7.29 to -5.09 about a centre at -6.19); a Metropolis doorway
 * is 1.92 m and wears the same wedge 15% too wide, which is a difference no
 * screenshot has ever shown and is cheaper than a second geometry.
 */
const DOOR_SPILL_REACH = 4.2;
const DOOR_SPILL_HALF_START = 1.15;
const DOOR_SPILL_HALF_END = 2.05;
/** Clear of the deck by the coat of paint that stops it z-fighting the platform. */
const DOOR_SPILL_LIFT = 0.03;

/**
 * How the wedge fades going out, as `[fraction of the reach, brightness]`.
 *
 * Not inverse-square, and the reason is the same one `POOL_STOPS` gives: this is
 * a *large soft source* -- a two-metre doorway with a ceiling of tubes behind it
 * -- seen at a grazing angle across a deck, so the falloff is dominated by the
 * cosine and by how much of the opening each patch of deck can still see. The
 * near half holds up and the last third goes to nothing, which is what stops the
 * wedge having a ruled edge on the platform.
 */
const DOOR_SPILL_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0.25, 0.86], [0.5, 0.6], [0.75, 0.3], [1, 0],
];

/**
 * How bright the wedge is, in this file's own additive currency.
 *
 * A street lamp's road pool is `POOL_LEVEL` and a car's is 0.42 over ten square
 * metres; this is a smaller area, closer to its source and much brighter in
 * reality -- a saloon full of fluorescents opening onto a deck. 0.34 lands the
 * threshold end at about +87 code values over the platform's own night value,
 * which is the deck plainly lit, and the far edge at nothing. It is deliberately
 * under `WINDOW_LEVEL`'s old 0.62: this one is light on a floor and reads as
 * light on a floor, where that one was light on a wall you were looking through.
 */
/** Pinned by `world/trains.verifyTrainLights` for `WINDOW_LEVEL`'s reason. */
export const DOOR_SPILL_LEVEL = 0.34;
/** Strips across the wedge, so its sides fade rather than being ruled lines. */
const DOOR_SPILL_EDGE_SHARE = 0.42;

/**
 * How many doorways can wear a wedge at once.
 *
 * Both hero consists, every doorway, both sides, and half as much again. An
 * eight-car Tangara has two doorways a side (16 leaves a carriage, in pairs, at
 * x -6.19 and +4.79) so it is 32; a six-car Metropolis has three a side, so 36.
 * 128 is two of the larger with 78% headroom, and `overflowed` counts anything
 * refused -- which should be forever zero, because `world/trains.MAX_MODEL_TRAINS`
 * is 2 and nothing else offers.
 */
export const DOOR_SPILL_CAPACITY = 128;

/**
 * The one real light: where it sits in the aperture, where it looks, and how hard.
 *
 * 2.1 m over the railhead is the middle of a Tangara doorway (1.18 to 3.45) and
 * of a Metropolis one (1.23 to 3.22), and 1.0 m inboard of the platform face --
 * 0.9 m inside the bodyside -- puts it *behind* the opening rather than in it, so
 * the door frame and the leaves are between the source and the deck. That is what
 * makes the cone land as a shape with the doorway's own proportions instead of as
 * a circle painted round the player's feet.
 *
 * It aims at the deck 2.4 m out, which is 1.05 m down and 3.4 m across from the
 * source: a beam 20 degrees under level. The cone at 0.62 rad is 71 degrees
 * across, wide enough to take in the whole threshold from that close, and the
 * penumbra is high for `TORCH_PENUMBRA`'s reason -- a hard-edged spot on a
 * platform deck reads as a projector.
 *
 * 26 at decay 2 puts 0.98 of irradiance on the deck at the aim point, which is
 * within 3% of what `LAMP_INTENSITY` puts on the road under a street lamp -- the
 * value this file calls "well lit" -- and 4x the night ambient floor. It is not a
 * coincidence and it is the only calibration available: there is no photograph of
 * this, so the honest reference is the one lit surface in the game whose level
 * was already argued.
 */
const DOOR_SPOT_LIFT = 2.1;
const DOOR_SPOT_INBOARD = 1.0;
const DOOR_SPOT_AIM_OUT = 2.4;
const DOOR_SPOT_INTENSITY = 26;
const DOOR_SPOT_DISTANCE = 14;
const DOOR_SPOT_ANGLE = 0.62;
const DOOR_SPOT_PENUMBRA = 0.6;

/**
 * How far away the real door light gives up, metres.
 *
 * Past 60 m the deck under a doorway is a few pixels and the spot is paying its
 * per-fragment cost to move nothing; inside it, it is the door the player is
 * walking towards. The same number as `TORCH_DISTANCE`, and that is the argument:
 * this is the range at which a light in this game is worth having.
 */
const DOOR_SPOT_RANGE = 60;

/**
 * The wedge of light one open door lays on the platform, in the **doorway
 * frame**: origin at the railhead under the doorway centre, +X along the
 * carriage, +Z out through the opening.
 *
 * In metres and **not** unit-scaled, unlike the window band -- the caller
 * multiplies the carriage's own orthonormal frame by a translation along X and
 * nothing else, so a Tangara doorway and a Metropolis doorway get the same
 * physical wedge rather than one stretched by the consist's pitch.
 *
 * `quadUp` throughout, on its own terms: a player is above a platform deck,
 * always, so the underside of this is never in frame.
 */
function buildDoorSpill(): BufferGeometry {
  const m = new Emissive();
  const y = DOOR_DECK_Y + DOOR_SPILL_LIFT;
  const at = (t: number) => ({
    z: DOOR_DECK_INNER + t * (DOOR_SPILL_REACH - DOOR_DECK_INNER),
    half: DOOR_SPILL_HALF_START + (DOOR_SPILL_HALF_END - DOOR_SPILL_HALF_START) * t,
    c: scaled(SALOON_COLOUR, ramp(DOOR_SPILL_STOPS, t) * DOOR_SPILL_LEVEL),
  });
  const edge: Rgb = [0, 0, 0];

  for (let s = 0; s < DOOR_SPILL_STOPS.length - 1; s++) {
    const a = at(DOOR_SPILL_STOPS[s][0]);
    const b = at(DOOR_SPILL_STOPS[s + 1][0]);
    // Three strips across, exactly as the head-light sheet is split: one quad
    // running to full brightness on a ruled line is a wedge with a hard side, and
    // light coming out of a doorway has no such line. The middle strip is
    // `DOOR_SPILL_EDGE_SHARE` of the half-width and the two outer ones fade to
    // black, which under an additive blend is the soft edge.
    const inner = DOOR_SPILL_EDGE_SHARE;
    // Corner order so `cross(b - a, c - a)` comes out **+Y**: the first edge runs
    // along -X and the second heads out along +Z, which is the same handedness
    // `disc` walks its rings with (tangent, then radial). Reversed, the wedge is
    // not dim, it is culled -- and `verifyNightLights`' face-down sweep is what
    // catches that rather than this comment.
    m.quadUp(
      [-a.half * inner, y, a.z], [-a.half, y, a.z],
      [-b.half, y, b.z], [-b.half * inner, y, b.z],
      [a.c, edge, edge, b.c],
    );
    m.quadUp(
      [a.half * inner, y, a.z], [-a.half * inner, y, a.z],
      [-b.half * inner, y, b.z], [b.half * inner, y, b.z],
      [a.c, a.c, b.c, b.c],
    );
    m.quadUp(
      [a.half, y, a.z], [a.half * inner, y, a.z],
      [b.half * inner, y, b.z], [b.half, y, b.z],
      [edge, a.c, b.c, edge],
    );
  }
  return m.build('train_doorspill');
}

/**
 * The window band of one carriage, in the carriage's own frame.
 *
 * **Unit length on X**, so the caller's instance matrix scales it by the
 * consist's own pitch exactly as `world/trains.drawImpostor` scales the box, and
 * one geometry serves both a Tangara and a Metropolis. y = 0 is the railhead, +Z
 * and -Z are the two bodysides.
 *
 * `double` is the whole difference between the two sets: a Tangara carries two
 * saloons and shows two rows of windows with a dark stripe between them where the
 * intermediate floor is, and that stripe is the single most recognisable thing
 * about a Sydney suburban train seen at night. A Metropolis is a single-decker and
 * shows one taller row. Two geometries and two draws rather than a compromise
 * band, because the compromise is a train that is neither.
 *
 * Every quad is emitted with **one winding**, facing out of its own bodyside.
 * `Emissive.quad` would emit both and double the triangle count of the most
 * numerous thing in this file for a face that is inside a steel box.
 */
function buildTrainWindows(double: boolean): BufferGeometry {
  const m = new Emissive();
  const decks: ReadonlyArray<readonly [number, number]> = double
    ? [DECK_LOWER, DECK_UPPER]
    : [DECK_SINGLE];
  const pitch = WINDOW_SPAN / WINDOW_PANES;
  const half = (pitch * WINDOW_PANE_SHARE) / 2;
  const wash = scaled(SALOON_COLOUR, WINDOW_WASH_LEVEL);

  for (const side of [-1, 1] as const) {
    const z = side * (TRAIN_HALF_WIDTH + WINDOW_PROUD);
    // Corner order so `cross(b - a, c - a)` points **out** of this bodyside,
    // which is the winding three's WebGPU backend calls front for an unflipped
    // `FrontSide` material. A pane wound the other way is not dim, it is absent,
    // and only on one side of every train in the city -- which is exactly the
    // kind of defect that survives a screenshot. `verifyTrainLightKit`
    // re-derives both sides' normals rather than trusting this loop.
    const face = (x0: number, y0: number, x1: number, y1: number, c: Rgb, cTop: Rgb): void => {
      const a = side > 0 ? x0 : x1;
      const b = side > 0 ? x1 : x0;
      m.quadUp([a, y0, z], [b, y0, z], [b, y1, z], [a, y1, z], [c, c, cTop, cTop]);
    };

    // The wash: one unbroken band per side, under everything, so there is always
    // a lit fragment where the panes are sub-pixel. See `WINDOW_WASH_LEVEL`.
    face(-WINDOW_SPAN / 2, WINDOW_WASH[0], WINDOW_SPAN / 2, WINDOW_WASH[1], wash, wash);

    for (let deck = 0; deck < decks.length; deck++) {
      const [y0, y1] = decks[deck];
      for (let i = 0; i < WINDOW_PANES; i++) {
        const cx = -WINDOW_SPAN / 2 + pitch * (i + 0.5);
        // The pane's own share of the level. Rotated by deck and by bodyside so
        // that the eight entries are four different orders on one carriage --
        // otherwise the blind is in the same seat on every deck of every train,
        // which is a wallpaper rather than a variation. The offsets are coprime
        // with 8 so the rotations cannot land on each other.
        const turn = deck * 3 + (side > 0 ? 0 : 5);
        const share = WINDOW_PANE_VARIATION[(i + turn) % WINDOW_PANE_VARIATION.length];
        const pane = scaled(SALOON_COLOUR, WINDOW_LEVEL * share);
        const dim = scaled(SALOON_COLOUR, WINDOW_LEVEL * share * 0.25);
        // Split top and bottom off the pane at a quarter level rather than
        // running the full brightness to a ruled edge. A window does have a hard
        // edge -- it is a frame -- but a hard edge on an *additive* sprite at
        // 2 cm from the steel is a bright line that survives to any distance,
        // and two extra strips a pane is cheap enough not to argue about.
        const lip = (y1 - y0) * 0.12;
        face(cx - half, y0, cx + half, y0 + lip, dim, pane);
        face(cx - half, y0 + lip, cx + half, y1 - lip, pane, pane);
        face(cx - half, y1 - lip, cx + half, y1, pane, dim);
      }
    }
  }
  return m.build(double ? 'train_windows_double' : 'train_windows_single');
}

/**
 * The headlight kit, anchored at the **outer end of the leading carriage** with
 * that carriage's own +X pointing down the track ahead.
 *
 * Two lamps, a beam and a pool on the ballast, which is `buildCarHeadLights`
 * three times the size and one important shape different: the beam is aimed
 * nearly level. See `TRAIN_BEAM_LENGTH`.
 */
function buildTrainHeadLights(): BufferGeometry {
  const m = new Emissive();
  const edge: Rgb = [0, 0, 0];

  for (const side of [-1, 1]) {
    const z = side * TRAIN_LAMP_HALF_SPACING;
    blob(m, 0, TRAIN_LAMP_Y, z, TRAIN_LAMP_HALF, scaled(TRAIN_BEAM_COLOUR, TRAIN_LAMP_LEVEL));

    for (let s = 0; s < BEAM_STOPS.length - 1; s++) {
      const [t0] = BEAM_STOPS[s];
      const [t1] = BEAM_STOPS[s + 1];
      const c0 = scaled(TRAIN_BEAM_COLOUR, ramp(BEAM_STOPS, t0) * TRAIN_BEAM_LEVEL);
      const c1 = scaled(TRAIN_BEAM_COLOUR, ramp(BEAM_STOPS, t1) * TRAIN_BEAM_LEVEL);
      const at = (t: number) => ({
        x: t * TRAIN_BEAM_LENGTH,
        y: TRAIN_LAMP_Y - t * TRAIN_BEAM_DROP,
        half: TRAIN_BEAM_HALF_START + (TRAIN_BEAM_HALF_END - TRAIN_BEAM_HALF_START) * t,
      });
      const a = at(t0);
      const b = at(t1);
      // Three strips a sheet, on `buildCarHeadLights`' finding: one quad ends at
      // full brightness on a ruled line where it meets the ballast, and a
      // headlight beam on a railway has no such line.
      m.quad([a.x, a.y, z - a.half], [a.x, a.y, z - a.half * 0.4],
        [b.x, b.y, z - b.half * 0.4], [b.x, b.y, z - b.half], [edge, c0, c1, edge]);
      m.quad([a.x, a.y, z - a.half * 0.4], [a.x, a.y, z + a.half * 0.4],
        [b.x, b.y, z + b.half * 0.4], [b.x, b.y, z - b.half * 0.4], [c0, c0, c1, c1]);
      m.quad([a.x, a.y, z + a.half * 0.4], [a.x, a.y, z + a.half],
        [b.x, b.y, z + b.half], [b.x, b.y, z + b.half * 0.4], [c0, edge, edge, c1]);
      const av = a.half * 0.55;
      const bv = b.half * 0.55;
      m.quad([a.x, a.y - av, z], [a.x, a.y - av * 0.4, z],
        [b.x, b.y - bv * 0.4, z], [b.x, b.y - bv, z], [edge, c0, c1, edge]);
      m.quad([a.x, a.y - av * 0.4, z], [a.x, a.y + av * 0.4, z],
        [b.x, b.y + bv * 0.4, z], [b.x, b.y - bv * 0.4, z], [c0, c0, c1, c1]);
      m.quad([a.x, a.y + av * 0.4, z], [a.x, a.y + av, z],
        [b.x, b.y + bv, z], [b.x, b.y + bv * 0.4, z], [c0, edge, edge, c1]);
    }
  }

  // The ballast under the beam. `quadUp` and not `quad`, for the pools' reason:
  // a player is above the four-foot, always.
  for (let s = 0; s < TRACK_POOL_SEGMENTS; s++) {
    const t0 = s / TRACK_POOL_SEGMENTS;
    const t1 = (s + 1) / TRACK_POOL_SEGMENTS;
    const at = (t: number) => ({
      x: TRACK_POOL_START + (TRACK_POOL_END - TRACK_POOL_START) * t,
      y: TRACK_POOL_LIFT + TRACK_POOL_RISE * t,
      half: TRACK_POOL_HALF_START + (TRACK_POOL_HALF_END - TRACK_POOL_HALF_START) * t,
      level: ramp([[0, 0.4], [0.25, 1], [0.7, 0.4], [1, 0]], t) * TRACK_POOL_LEVEL,
    });
    const a = at(t0);
    const b = at(t1);
    const c0 = scaled(TRAIN_BEAM_COLOUR, a.level);
    const c1 = scaled(TRAIN_BEAM_COLOUR, b.level);
    const edgeC: Rgb = [0, 0, 0];
    m.quadUp([a.x, a.y, -a.half], [a.x, a.y, -a.half * 0.45],
      [b.x, b.y, -b.half * 0.45], [b.x, b.y, -b.half], [edgeC, c0, c1, edgeC]);
    m.quadUp([a.x, a.y, -a.half * 0.45], [a.x, a.y, a.half * 0.45],
      [b.x, b.y, b.half * 0.45], [b.x, b.y, -b.half * 0.45], [c0, c0, c1, c1]);
    m.quadUp([a.x, a.y, a.half * 0.45], [a.x, a.y, a.half],
      [b.x, b.y, b.half], [b.x, b.y, b.half * 0.45], [c0, edgeC, edgeC, c1]);
  }

  return m.build('train_headlights');
}

/**
 * The tail kit, on the same anchor as the head and in the same local frame.
 *
 * That the two share a frame is not a coincidence to be tidied away later: every
 * consist in `game/riding.ts` ends with a carriage whose `flip` is true, so the
 * rear vehicle's own +X already points backwards down the line and the rear end
 * of the train is at the same `+X * halfLength` the nose is. `verifyTrainLights`
 * asserts that about the consist tables rather than leaving it as a thing this
 * comment happens to know.
 *
 * Two markers and no beam and no pool, which is `TAIL_COLOUR`'s argument
 * unchanged: a tail light does not light the track and one that did would be
 * wrong in a way people feel without seeing.
 */
function buildTrainTailLights(): BufferGeometry {
  const m = new Emissive();
  for (const side of [-1, 1]) {
    blob(m, 0, TRAIN_LAMP_Y, side * TRAIN_LAMP_HALF_SPACING, TRAIN_TAIL_HALF,
      scaled(TAIL_COLOUR, TRAIN_TAIL_LEVEL));
  }
  return m.build('train_taillights');
}

/**
 * Every lit carriage in the city, plus the one real light in the one carriage the
 * player is standing in.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THE DAY/NIGHT TERM IS PER **INSTANCE** HERE AND NOWHERE ELSE.
 *
 * Every other sprite in this file reads the shared `nightOpacity` uniform and is
 * therefore off by day, everywhere, by construction -- one uniform, one dusk
 * ramp, no second threshold anywhere. A train breaks that and is the only thing
 * in the game that can: **a train in a bore is in the dark at noon.** Two trains
 * on the same line at the same instant, one on the viaduct at Meadowbank in full
 * sun and one under Victoria Cross, need different answers, and no uniform can
 * give two answers.
 *
 * So the level rides in `instanceColor`, written per carriage by the fleet, and
 * the material's own opacity is 1. Two consequences worth stating:
 *
 *   - `setColorAt(0, white)` in the constructor of every set below, because
 *     `NodeMaterial.setupDiffuseColor` multiplies by `instanceColor` **only when
 *     the attribute exists at the moment the node graph is built**. Absent then,
 *     absent from the shader forever, and every train in Sydney is fully lit at
 *     midday. `world/rail-geo.ts` and `world/cars.ts` both carry this scar.
 *   - the day path costs nothing anyway, because a carriage whose level is zero
 *     is never *added*: `count` ends the frame at the number of lit carriages, so
 *     a summer afternoon above ground is four instanced draws of zero instances.
 *     That is what replaces `CarLights.setLive`, and it is strictly better --
 *     there is no visibility to toggle and therefore no boot-order trap.
 *
 * ---------------------------------------------------------------------------
 * 2. THE ONE REAL LIGHT, AND WHY EXACTLY ONE.
 *
 * The rig this file already owns is three real lights and the header explains at
 * length that the number is a shader constant rather than a budget. This makes it
 * four, and the fourth buys the one thing no amount of additive geometry can:
 * **shading**. A carriage interior is 36,000 triangles of seat, pole, strap and
 * moquette that exist as geometry and are lit by nothing after dark; an emissive
 * term over the top of them would make them glow rather than make them lit, and
 * the difference is exactly the difference between a photograph of a train and a
 * drawing of one.
 *
 * It is one and not two because it follows the **rider**, not the carriage. A
 * light hung at each carriage's centre would be eight lights for a train and
 * seven of them light nothing anybody can see; a light hung 0.72 m over the
 * player's own eye is always in the saloon the player is in, and the player is
 * the only observer who is ever inside one. `SALOON_DECAY` is what makes that one
 * point read as a ceiling full of tubes.
 *
 * Constructed here and added to the scene by `NightLights`, which is the one
 * place in the build that is guaranteed to run before `warmUpPipelines` -- see
 * this file's header for what a light appearing after that costs.
 *
 * ---------------------------------------------------------------------------
 * 3. A MODULE SINGLETON, DELIBERATELY.
 *
 * `world/trains.ts` fills this and `NightLights` owns its light, and the two have
 * no reference to each other. The alternative is a line of wiring in `main.ts`
 * assigning one to the other -- which is what `trafficMovers.lights` is -- and it
 * buys nothing here: there is exactly one fleet and exactly one night in the
 * process, the sprites are a property of the *world* rather than of any
 * particular rig, and `nightOpacity` two thousand lines above is already a
 * city-wide singleton on identical terms. What it costs is the class of bug where
 * the wiring line is deleted and the feature silently stops existing.
 */
export class TrainLights {
  /**
   * `[double-deck windows, single-deck windows, headlights, tail lights, door
   * spill]`.
   */
  readonly meshes: InstancedMesh[];
  readonly material: MeshBasicNodeMaterial;
  readonly geometries: BufferGeometry[];
  /** The real light in the carriage the player is standing in. See section 2. */
  readonly saloon: PointLight;
  /**
   * And the real light at the nearest open doorway -- the *second* one, and the
   * whole of this rig's door budget. See the door section above for why it is a
   * spot rather than a point and why there is exactly one.
   */
  readonly doorLight: SpotLight;

  /** Carriages lit last frame, and how many of those because they are underground. */
  drawn = 0;
  drawnUnderground = 0;
  /**
   * Carriages that actually wore the sprite band, which is no longer the same
   * number as `drawn`.
   *
   * A hero carriage inside `WINDOW_HERO_NEAR` is lit -- by its own glazing, its
   * luminaires and the saloon behind them -- and wears no band at all, so `drawn`
   * counts what the night rig answered for and this counts what it drew. The two
   * being equal is what the shipped bug looked like: a sprite grid pasted over
   * every hero model at every distance.
   */
  banded = 0;
  /** Train ends lit last frame: heads and tails together. */
  ends = 0;
  /** Open doorways wearing a wedge of light on the deck this frame. */
  spills = 0;
  /** Carriages, ends and doorways refused for want of capacity. Should be 0 forever. */
  overflowed = 0;

  private readonly counts = [0, 0, 0, 0, 0];
  private saloonLevel = 0;
  /** `interiorNightGain` for the ridden carriage's own model. See `rider`. */
  private saloonGain = 1;
  private stale = SALOON_STALE_S;
  /** How far away the doorway the real light is currently claimed by is. */
  private doorPick = Infinity;
  private doorLevel = 0;

  constructor() {
    // One material for all five sets: unlit, vertex-coloured, additive, never
    // depth-written, and **no `opacityNode`**. See section 1.
    this.material = nightMaterial('train_lights', false, true);
    this.geometries = [
      buildTrainWindows(true),
      buildTrainWindows(false),
      buildTrainHeadLights(),
      buildTrainTailLights(),
      buildDoorSpill(),
    ];
    const names = [
      'train_windows_double', 'train_windows_single', 'train_headlights', 'train_taillights',
      'train_doorspill',
    ];
    const capacity = [
      TRAIN_LIGHT_CAPACITY, TRAIN_LIGHT_CAPACITY, TRAIN_END_CAPACITY, TRAIN_END_CAPACITY,
      DOOR_SPILL_CAPACITY,
    ];
    this.meshes = this.geometries.map((geometry, i) => {
      const mesh = new InstancedMesh(geometry, this.material, capacity[i]);
      mesh.name = names[i];
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // The colour buffer, allocated **before** the node graph is built. See
      // section 1; without this line every train in the city is lit at noon.
      mesh.setColorAt(0, _colour.setRGB(1, 1, 1));
      // One instance, parked four kilometres under the world, and `count` left at
      // one until the first frame's `end()` takes it over. `world/trains.warm`
      // does the identical thing to the impostor set for the identical reason:
      // these four are added to the fleet's own group and are walked by the
      // fleet's warm-up pass, and a set that is drawing nothing at the moment of
      // the walk is a set whose pipeline is compiled inside whichever frame first
      // shows a lit train -- which is the frame the sun goes down, in front of the
      // player, with a train in view. This project has shipped that bug.
      _matrix.makeTranslation(0, -4000, 0);
      mesh.setMatrixAt(0, _matrix);
      mesh.count = 1;
      mesh.visible = true;
      return mesh;
    });

    const light = new PointLight(0xffffff, 0, SALOON_DISTANCE, SALOON_DECAY);
    light.name = 'train_saloon';
    // Never. One shadow rig in this build and it is the sun's; see the header.
    light.castShadow = false;
    light.color.setRGB(SALOON_COLOUR[0], SALOON_COLOUR[1], SALOON_COLOUR[2]);
    // Parked under the world rather than at the origin, which is a real place --
    // `NightLights`' own lamps make the same move for the same reason.
    light.position.set(0, -1000, 0);
    this.saloon = light;

    const door = new SpotLight(0xffffff, 0);
    door.name = 'train_door';
    door.angle = DOOR_SPOT_ANGLE;
    door.penumbra = DOOR_SPOT_PENUMBRA;
    door.distance = DOOR_SPOT_DISTANCE;
    door.decay = 2;
    // Never, for the header's reason and one of its own: this light moves to a
    // different doorway whenever the player walks past one, so a shadow map for
    // it could never be cached for two frames running.
    door.castShadow = false;
    door.color.setRGB(SALOON_COLOUR[0], SALOON_COLOUR[1], SALOON_COLOUR[2]);
    door.position.set(0, -1000, 0);
    door.target.position.set(0, -1000, 1);
    this.doorLight = door;
  }

  /** Start a frame. Nothing is ever refused wholesale: see section 1. */
  begin(): void {
    this.counts[0] = 0;
    this.counts[1] = 0;
    this.counts[2] = 0;
    this.counts[3] = 0;
    this.counts[4] = 0;
    this.saloonLevel = 0;
    this.saloonGain = 1;
    this.overflowed = 0;
    this.doorPick = Infinity;
    this.doorLevel = 0;
    this.banded = 0;
    // Zeroed here and not in `end()`, with the counts it belongs beside. It was
    // left out of the first cut and simply accumulated -- 75,000 "underground
    // carriages" after two minutes at Redfern -- which is worth a line because
    // the number looked plausible for about a second and is the only evidence
    // anybody has that the bore rule is still answering.
    this.drawnUnderground = 0;
    // And `drawn` with it, for the same reason and a newer one: it is counted in
    // `car` now rather than read off the instance counts in `end`, because a hero
    // carriage inside `WINDOW_HERO_NEAR` is lit and has no instance. A counter
    // incremented per call and reset anywhere but here accumulates silently.
    this.drawn = 0;
  }

  /**
   * One carriage, from the matrix the fleet already built to draw it with.
   *
   * `matrix` is the carriage frame with X scaled by the consist's own pitch --
   * exactly what `drawImpostor` puts on the box, and the reason the window band is
   * built at unit length. `level` is 0 to 1 and is the carriage's own: night
   * outside, or a bore at any hour.
   *
   * `fade` is `windowBandFade` of the carriage's own distance and is **not**
   * folded into `level` by the caller, deliberately: they answer different
   * questions -- one is "is this carriage lit", which drives the counters and the
   * bore rule, and the other is "should the sprite band be doing the lighting",
   * which is a property of how far away it is. A hero carriage at 20 m is fully
   * lit and wears no band, and `drawn` must still say so or `litUnderground`
   * stops meaning anything at Wynyard.
   */
  car(matrix: Matrix4, metro: boolean, level: number, underground: boolean, fade = 1): void {
    if (level <= 0) return;
    if (underground) this.drawnUnderground++;
    this.drawn++;
    const shown = level * fade;
    if (shown <= 0) return;
    const set = metro ? 1 : 0;
    const at = this.counts[set];
    if (at >= TRAIN_LIGHT_CAPACITY) {
      this.overflowed++;
      return;
    }
    const mesh = this.meshes[set];
    mesh.setMatrixAt(at, matrix);
    mesh.setColorAt(at, _colour.setRGB(shown, shown, shown));
    this.counts[set] = at + 1;
  }

  /**
   * One open doorway: the wedge on the deck, and a bid for the one real light.
   *
   * `matrix` is the **doorway frame** -- the carriage's own orthonormal basis
   * translated along its X to the doorway centre, and turned about Y for the far
   * bodyside so that local +Z always points out through the opening. Unscaled, so
   * a metre in this geometry is a metre on the platform.
   *
   * `open` is `world/trains.doorOpenness` and nothing else, so the wedge grows and
   * dies with the leaves the animator drew rather than with a clock of its own.
   * `metres` is how far the player is from this doorway and decides only which
   * one of them gets the real light -- the nearest, which is the one whose deck
   * anybody can see.
   */
  doorway(matrix: Matrix4, level: number, open: number, metres: number): void {
    const shown = level * open;
    if (shown <= 0) return;
    const at = this.counts[4];
    if (at >= DOOR_SPILL_CAPACITY) {
      this.overflowed++;
      return;
    }
    const mesh = this.meshes[4];
    mesh.setMatrixAt(at, matrix);
    mesh.setColorAt(at, _colour.setRGB(shown, shown, shown));
    this.counts[4] = at + 1;

    // The bid. One light, so the nearest doorway inside its range takes it and
    // everything else is geometry. Resolved in `end()`, which is the only place
    // an intensity is written -- see `SALOON_INTENSITY`'s sibling line there.
    if (metres >= this.doorPick || metres > DOOR_SPOT_RANGE) return;
    this.doorPick = metres;
    this.doorLevel = shown;
    // The source sits inboard of the opening and the aim point out over the deck,
    // both in the doorway's own frame, so the cone comes out of the doorway the
    // way light does. `Matrix4.elements` is column-major: columns 0/1/2 are the
    // carriage's along/up/across axes and column 3 is the doorway's origin at the
    // railhead.
    const e = matrix.elements;
    const put = (out: Vector3, up: number, across: number): void => {
      out.set(
        e[12] + e[4] * up + e[8] * across,
        e[13] + e[5] * up + e[9] * across,
        e[14] + e[6] * up + e[10] * across,
      );
    };
    put(this.doorLight.position, DOOR_SPOT_LIFT, DOOR_DECK_INNER - DOOR_SPOT_INBOARD);
    put(this.doorLight.target.position, DOOR_DECK_Y, DOOR_DECK_INNER + DOOR_SPOT_AIM_OUT);
  }

  /** The leading end of a consist, in the leading carriage's own frame. */
  head(matrix: Matrix4, level: number): void {
    this.endKit(2, matrix, level);
  }

  /** And the trailing end, in the trailing carriage's -- which points backwards. */
  tail(matrix: Matrix4, level: number): void {
    this.endKit(3, matrix, level);
  }

  private endKit(set: number, matrix: Matrix4, level: number): void {
    if (level <= 0) return;
    const at = this.counts[set];
    if (at >= TRAIN_END_CAPACITY) {
      this.overflowed++;
      return;
    }
    const mesh = this.meshes[set];
    mesh.setMatrixAt(at, matrix);
    mesh.setColorAt(at, _colour.setRGB(level, level, level));
    this.counts[set] = at + 1;
  }

  /**
   * The player is standing in a lit carriage: their plan position, and the
   * railhead under the carriage they are in.
   *
   * Called at most once a frame, by the fleet, from the same rectangle test that
   * decides the train must not collide with them -- so the light is on exactly
   * when the player is aboard, with no second source for that fact to drift from.
   *
   * `gain` is `interiorNightGain` of this train's own type, and it is the third
   * of the three interior terms that move together after dark -- the other two
   * are material state the fleet writes directly. It is a separate argument from
   * `level` rather than multiplied into it by the caller, for `car`'s reason one
   * function down: they answer different questions. `level` is "is this carriage
   * lit", which is a fact about a bore and the sun and drives whether there is a
   * light at all; `gain` is "how much of its daytime saloon does this model keep
   * at night", which is a fact about the model.
   */
  rider(x: number, railY: number, z: number, level: number, gain = 1): void {
    if (level <= this.saloonLevel) return;
    this.saloonLevel = level;
    this.saloonGain = gain;
    this.saloon.position.set(x, railY + SALOON_LIFT, z);
  }

  end(): void {
    let banded = 0;
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      const n = this.counts[i];
      if (n > 0 || mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = n;
      if (i < 2) banded += n;
    }
    this.banded = banded;
    this.ends = this.counts[2] + this.counts[3];
    this.spills = this.counts[4];
    // Intensity, never `visible`. The invariant the whole night rests on, and it
    // holds for both of these: the door light goes to zero when no doorway bid,
    // and its `target` stays parked wherever the last bid left it, which nothing
    // can see because nothing is being emitted along it.
    this.saloon.intensity = SALOON_INTENSITY * this.saloonLevel * this.saloonGain;
    this.doorLight.intensity = DOOR_SPOT_INTENSITY * this.doorLevel;
    this.stale = 0;
  }

  /**
   * Age the saloon light, from whoever is running the frame clock.
   *
   * `NightLights.update` calls this and the fleet does not, which is the point:
   * this is the guard against the fleet *not* running. See `SALOON_STALE_S`.
   */
  tick(dt: number): void {
    if (this.saloon.intensity === 0 && this.doorLight.intensity === 0) return;
    this.stale += dt;
    if (this.stale > SALOON_STALE_S) {
      this.saloon.intensity = 0;
      this.saloonLevel = 0;
      this.saloonGain = 1;
      // The door light is on the same guard and for a worse case than the
      // saloon's: it is anchored to a doorway rather than to the player, so a
      // fleet that stopped updating would leave a spot burning on an empty
      // platform at a station the player left ten minutes ago.
      this.doorLight.intensity = 0;
      this.doorLevel = 0;
      this.doorPick = Infinity;
    }
  }

  /**
   * Release everything. **Never called on the live singleton** -- and
   * `NightLights.dispose` deliberately does not reach it, because the probes
   * `verifyNightLights` builds would otherwise dispose the geometry the game is
   * about to draw with.
   */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The one train light rig in the process. See `TrainLights` section 3.
 *
 * `world/trains.TrainFleet` puts the meshes in its own group and fills them;
 * `NightLights` puts the real light in the scene. Neither file imports the other.
 */
export const trainLights = /*#__PURE__*/ new TrainLights();

/**
 * How far into the night the city is, as the last frame left it.
 *
 * The shared uniform, read back rather than recomputed, so a caller outside this
 * file that needs the level cannot end up with a second dusk ramp. It is `one
 * frame stale` for anything that runs before `NightLights.update` -- which is the
 * fleet -- and that is 16 ms of a ramp that takes eight degrees of solar altitude
 * to complete, or about twelve minutes of Sydney clock. Nothing can see it.
 */
export function nightLevelNow(): number {
  return nightOpacity.value;
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
  /**
   * The two that follow burning cars. See `FIRE_REAL_COUNT` for why there are
   * two of them and why they are constructed here with everything else rather
   * than when a car catches fire.
   */
  readonly fires: PointLight[] = [];
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
  /** ...and how many of the two fire lights found a burning car this frame. */
  firesLit = 0;

  private readonly aim = new Vector3(0, 0, -1);
  private readonly forward = new Vector3();
  private readonly beam = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly found = new Float32Array(LAMP_REAL_COUNT * LAMP_RECORD_STRIDE);
  private readonly foundFires = new Float32Array(FIRE_REAL_COUNT * FIRE_RECORD_STRIDE);
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
   * Whether the player is holding the torch out. `F`; see `toggleTorch`.
   *
   * **Starts true, and the default is the decision.** The torch has been
   * automatic since it existed -- on with the street lamps, off with the sun --
   * and a player who never learns the key must get exactly that, because the
   * request that arrived beside this one was "i cant see shit at night rn" and
   * shipping a night that starts with the torch in your pocket would answer it
   * backwards. What the key adds is the ability to *put it away*: to look at a
   * lit street with nothing of your own in the frame, to stand in a rave without
   * a beam across it, and to take a screenshot of the city rather than of a wall
   * with a hole burnt in it.
   */
  private torchWanted = true;

  /** Whether the beam is out. False only after the player pressed `F`. */
  get torchOn(): boolean {
    return this.torchWanted;
  }

  /**
   * Put the torch away, or take it out. Returns the new state, so the caller can
   * say which one happened without asking again.
   *
   * Nothing is written here but a boolean: the light is *never* touched outside
   * `update`, so a press cannot land between the intensity being set and the
   * frame being drawn, and there is exactly one line in this file that decides
   * how bright the beam is. See that line for why it is intensity and not
   * `visible`.
   */
  toggleTorch(): boolean {
    this.torchWanted = !this.torchWanted;
    return this.torchWanted;
  }

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

    // --- And the fire lights, on exactly the lamps' terms: constructed here,
    // once, for the life of the process, parked under the terrain until
    // something catches, and never hidden. `FIRE_REAL_COUNT` carries the whole
    // argument for why a burning car is worth two of these when four hundred
    // headlights are worth none.
    for (let i = 0; i < FIRE_REAL_COUNT; i++) {
      const light = new PointLight(0xffffff, 0, FIRE_DISTANCE, 2);
      light.castShadow = false;
      light.name = `car_fire_${i}`;
      // The colour never changes -- a fire is a fire -- so unlike a lamp it is
      // set once here rather than on every re-pick.
      light.color.setRGB(FIRE_COLOUR[0], FIRE_COLOUR[1], FIRE_COLOUR[2]);
      light.position.set(0, -1000, 0);
      this.fires.push(light);
      scene.add(light);
    }

    for (const mesh of this.carLights.meshes) scene.add(mesh);
    scene.add(this.bikeLights.mesh);

    // --- And the fourth real light: the saloon of whichever carriage the player
    // is standing in. Added here rather than by the fleet, because *here* is the
    // one place in the boot that is guaranteed to run before `warmUpPipelines`
    // and because a light must never be parented to something whose `visible` is
    // ever toggled -- `TileStreamer` and `precompileGroup` both toggle a group's
    // visibility, and `_projectObject` skips an invisible object's children, so a
    // light in one would drop off the render list and recompile the scene. See
    // `TrainLights` section 2. Its *sprites* live in the fleet's own group, which
    // is safe because a mesh's visibility is in no cache key at all.
    scene.add(trainLights.saloon);
    // --- And the fifth: the nearest open doorway. Same rule, same place, and its
    // `target` too -- a `SpotLight` aims at an `Object3D` and one that is not in
    // the scene graph never has its world matrix updated, so the beam would point
    // wherever the target's *local* transform happened to leave it. The torch
    // above adds its own for the same reason.
    scene.add(trainLights.doorLight);
    scene.add(trainLights.doorLight.target);
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
    fires: FireSource | null = null,
  ): void {
    const rig = nightRig(solarAltitudeDeg);
    this.level = rig.level;
    // The one write to the one uniform every additive sprite in this file reads.
    nightOpacity.value = rig.level;

    const live = rig.level > NIGHT_VISIBLE_LEVEL;
    this.carLights.setLive(live);
    this.bikeLights.setLive(live);
    // The trains are **not** given `live`, and that is the one asymmetry in this
    // function. A train in a bore is lit at noon, so its sprites are not a
    // function of the sun and its level is per carriage rather than per city --
    // see `TrainLights` section 1. All this call does is age the saloon light so
    // that a fleet which stops updating cannot leave one burning.
    trainLights.tick(dt);

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
    /* And the switch, which is the *only* thing `F` does to this light.
     *
     * **Intensity, never `visible`.** The whole architecture of this file is the
     * paragraph at the top: hiding a light takes it off three's render list,
     * which changes `LightsNode.customCacheKey`, which recompiles every pipeline
     * in the scene inside the frame it happened. A torch bound to a key is
     * therefore the single most dangerous possible way to have got that wrong --
     * a player tapping `F` would have been a player stuttering the whole game
     * once per press. Zero intensity costs the same `N.L` it costs at noon.
     *
     * **A bike headlight is not switched by it**, and that is the mount argument
     * stated from the other end: this light does three jobs, and mounting is an
     * *exchange* of the torch for a lamp bolted to a head tube. A rider is not
     * holding the torch -- both hands are on the bars and `verifyCharacterRig`
     * asserts it -- so there is nothing in their hand for the key to put away,
     * and a rider who had pressed `F` on foot would otherwise get on a bike at
     * midnight and find its headlight dead for a reason nothing on screen could
     * explain. Getting off hands the torch back in whatever state it was left. */
    const held = riding ? BIKE_BEAM_GAIN : this.torchWanted ? 1 : 0;
    this.torch.intensity = rig.torchIntensity * sway.gain * held;

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

    // --- The burning cars.
    //
    // **Re-picked every frame**, where the lamps re-pick at 6 Hz, and the
    // asymmetry is deliberate rather than an oversight. `LAMP_REPICK_INTERVAL`
    // exists because reassignment is *visible*: there are five thousand lamps,
    // the sort swaps between them constantly as the player walks, and a light
    // jumping 40 m is a wall going dark. There are at most a couple of burning
    // cars in a session and they do not move, so a swap is a rarity -- while the
    // event this must be prompt about is the opposite one: a car **explodes**,
    // and a warm orange light left standing over the hole for a sixth of a
    // second after the wreck has gone is a thing you can see. Releasing the
    // light is the same line as never having assigned it.
    //
    // The cost is a walk over at most `carsmoke.MAX_SMOKING_CARS` records, which
    // is the cheapest thing in this function.
    const fireCount =
      fires === null || rig.level <= 0
        ? 0
        : fires.nearestFires(eye.x, eye.y, eye.z, FIRE_SEARCH_RADIUS, this.foundFires, FIRE_REAL_COUNT);
    this.firesLit = fireCount;
    for (let i = 0; i < FIRE_REAL_COUNT; i++) {
      const light = this.fires[i];
      if (i >= fireCount) {
        // Intensity, never `visible`. The invariant this whole file rests on.
        light.intensity = 0;
        continue;
      }
      const o = i * FIRE_RECORD_STRIDE;
      light.position.set(this.foundFires[o], this.foundFires[o + 1], this.foundFires[o + 2]);
      // Gated on the night level like every other source in this file, through
      // `rig.level` rather than through a second ramp -- `sky/calibration.ts`
      // owns the one dusk curve in the build and a fire that came up on its own
      // schedule would be the only light in Sydney that disagreed about when it
      // gets dark. A burning car at noon is still drawn: its flames are additive
      // geometry and they are visible all day. What it does not do at noon is
      // put light on a wall, which is what a fire in daylight does not do.
      light.intensity = FIRE_INTENSITY * rig.level * fireFlicker(this.clock, i);
    }
  }

  /**
   * Every real light this rig owns. For the self-check and the dev handle.
   *
   * The saloon light is in the list even though `TrainLights` constructs it: what
   * this list is *for* is the set of lights on the render list, which is what
   * every material's cache key is hashed over, and a light that is in the scene
   * and not in this list is a light the self-check cannot see.
   */
  get realLights(): Object3D[] {
    return [this.torch, trainLights.saloon, trainLights.doorLight, ...this.lamps, ...this.fires];
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
    // **And deliberately not `trainLights`.** That one is a module singleton
    // shared with the fleet (see `TrainLights` section 3), and the only caller
    // this method has is the self-check's throwaway probe -- which would
    // otherwise dispose the geometry and the material the game is about to draw
    // every train in Sydney with, three hundred lines before it does.
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
  // this bounds the fade rate at something no scrub can jump: `sydney.sky.advance(30)`
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
  // The torch, the saloon, the door, the lamps and the fires. The saloon was the
  // fourth and `TrainLights` section 2 argues for it; the door spot is the fifth
  // and the door section argues for *that*, including why it is one and not one
  // per open doorway; the two fire lights are the sixth and seventh and
  // `FIRE_REAL_COUNT` argues for them, including why a burning car earns one
  // when four hundred headlights do not. What this number is guarding is that
  // there is never an **eighth** without somebody having read all three.
  const realWanted = 3 + LAMP_REAL_COUNT + FIRE_REAL_COUNT;
  if (real.length !== realWanted) {
    failures.push(
      `The night rig owns ${real.length} real lights, not ${realWanted}. That count is a ` +
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
  /* --- The fire lights, which are the newest thing on that list and the one
   * most likely to break it.
   *
   * Four claims, and every one of them renders a perfectly good frame when it is
   * wrong: the flicker stays inside its envelope and is not the same in two
   * lights at once, a burning car within range lights up after dark, the budget
   * is two and they are the *nearest* two, and a car that stops burning -- or
   * explodes, which is the same thing from here -- gives its light back on the
   * very next frame rather than leaving an orange glow over an empty street.
   */
  {
    // The envelope, swept over ten minutes at 120 Hz rather than asserted from
    // the two amplitudes. `torchSway`'s check one section up, for its reason.
    let lowest = Infinity;
    let highest = -Infinity;
    let sameAsOther = 0;
    let samples = 0;
    const step = 1 / 120;
    for (let t = 0; t < 600; t += step) {
      const a = fireFlicker(t, 0);
      const b = fireFlicker(t, 1);
      lowest = Math.min(lowest, a);
      highest = Math.max(highest, a);
      if (Math.abs(a - b) < 0.01) sameAsOther++;
      samples++;
    }
    const floor = 1 - FIRE_FLICKER_SWING;
    const ceiling = 1 + FIRE_FLICKER_SWING;
    if (lowest < floor - 1e-9 || highest > ceiling + 1e-9) {
      failures.push(
        `A car fire's light runs from ${lowest.toFixed(3)} to ${highest.toFixed(3)} of nominal, ` +
          `outside the ${floor}-${ceiling} the brief asks for. Past the top it blows out the wall ` +
          `it is lighting on the peaks; below the bottom the fire visibly goes out and comes back.`,
      );
    }
    // ...and it has to actually use the envelope. Two sines that cancelled would
    // pass the bound above and be a light that does not flicker at all, which is
    // a burning car that reads as somebody's headlights left on.
    if (highest - lowest < FIRE_FLICKER_SWING) {
      failures.push(
        `A car fire's light only varies by ${(highest - lowest).toFixed(3)} over ten minutes ` +
          `against a swing of ${FIRE_FLICKER_SWING} either way. The flicker is the whole tell.`,
      );
    }
    if (sameAsOther > samples * 0.2) {
      failures.push(
        `Two burning cars flicker together on ${((sameAsOther / samples) * 100).toFixed(0)}% of ` +
          `frames. Two fires in step is the one thing that reads as a shader rather than as fire; ` +
          `see FIRE_FLICKER_STAGGER.`,
      );
    }

    // And the rig, driven for real against a fixture. Three burning cars in a
    // line, a camera at the origin, and the sun well down.
    const fireCam = new PerspectiveCamera(70, 1.6, 0.1, 2000);
    fireCam.position.set(0, 1.7, 0);
    fireCam.updateMatrixWorld(true);
    const burning: FireSource = {
      nearestFires(x, y, z, radius, out, max) {
        const at = [8, 20, 200];
        let n = 0;
        for (const cx of at) {
          if (n >= max) break;
          const d = Math.hypot(cx - x, y, z);
          if (d > radius) continue;
          out[n * FIRE_RECORD_STRIDE] = cx;
          out[n * FIRE_RECORD_STRIDE + 1] = 0.9;
          out[n * FIRE_RECORD_STRIDE + 2] = 0;
          n++;
        }
        return n;
      },
    };
    const none: FireSource = { nearestFires: () => 0 };

    const fireRig = new NightLights(new Object3D());
    const fireIdentity = (): string => fireRig.realLights.map((l) => `${l.id}:${l.visible ? 1 : 0}`).join(',');
    const fireBefore = fireIdentity();
    fireRig.update(1 / 60, fireCam, -20, 0, null, null, burning);
    if (fireRig.firesLit !== FIRE_REAL_COUNT) {
      failures.push(
        `Three burning cars within 60 m lit ${fireRig.firesLit} of ${FIRE_REAL_COUNT} fire lights.`,
      );
    }
    if (!(fireRig.fires[0].intensity > 0) || !(fireRig.fires[1].intensity > 0)) {
      failures.push(
        `A car burning 8 m away at midnight puts ${fireRig.fires[0].intensity} of light on the ` +
          `street. The whole feature is the wall behind the wreck; a sprite already does the flames.`,
      );
    }
    if (Math.abs(fireRig.fires[0].position.x - 8) > 1e-6 || Math.abs(fireRig.fires[1].position.x - 20) > 1e-6) {
      failures.push(
        `The two fire lights are on the cars at x ${fireRig.fires[0].position.x} and ` +
          `${fireRig.fires[1].position.x} rather than on the nearest two at 8 and 20. Over the ` +
          `budget it is the closest fires that get the lights, or a player standing next to a ` +
          `burning car is lit by one two streets away.`,
      );
    }
    // Warm, and the same fire the flames are. A white light on a car fire is a
    // searchlight in a wreck.
    if (!(fireRig.fires[0].color.r > fireRig.fires[0].color.g && fireRig.fires[0].color.g > fireRig.fires[0].color.b)) {
      failures.push(
        `A car fire's light is (${fireRig.fires[0].color.r}, ${fireRig.fires[0].color.g}, ` +
          `${fireRig.fires[0].color.b}), which is not a warm orange.`,
      );
    }
    // Dark by day, with the cars still burning: the gate is the shared level.
    fireRig.update(1 / 60, fireCam, 57.11, 0, null, null, burning);
    if (fireRig.fires[0].intensity !== 0) {
      failures.push(
        `A car burning at 3 pm is putting ${fireRig.fires[0].intensity} of real light on the road. ` +
          `Every source in this file is gated on the shared night level, or the daytime ` +
          `calibration in sky/calibration.ts is wrong by however much is burning.`,
      );
    }
    // The fire goes out -- or the car explodes, which from here is the same
    // event -- and the light is back on the frame after.
    fireRig.update(1 / 60, fireCam, -20, 0, null, null, none);
    if (fireRig.firesLit !== 0 || fireRig.fires[0].intensity !== 0 || fireRig.fires[1].intensity !== 0) {
      failures.push(
        `A car that exploded is still lighting the street (${fireRig.fires[0].intensity}, ` +
          `${fireRig.fires[1].intensity}). The light has to be released on the frame the fire ends, ` +
          `or there is a warm glow standing over the hole where the wreck was.`,
      );
    }
    // A caller that knows nothing about fires -- the offline boot, the check
    // above -- must leave them dark rather than at whatever they were.
    fireRig.update(1 / 60, fireCam, -20, 0, null, null);
    if (fireRig.fires[0].intensity !== 0) {
      failures.push('An update with no fire source left a fire light burning.');
    }
    // ...and none of that moved the set of lights, which is the invariant.
    if (fireIdentity() !== fireBefore) {
      failures.push(
        `Lighting and releasing a car fire changed the set of real lights to "${fireIdentity()}". ` +
          `A fire light must be a light at zero intensity and never a hidden one.`,
      );
    }
    fireRig.dispose();
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
  let poolAcross = 0;
  let poolAlong = 0;
  let offCone = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    // A pool vertex is one whose height is exactly what the cone predicts for
    // its **normalised** distance from the luminaire: `POOL_LIFT` at the middle
    // rising to `POOL_LIFT + POOL_RIM_LIFT` at the rim. That is a stronger test
    // than a height band, because it is the *shape* that is load-bearing --
    // the rise is what keeps the far side of a pool out of an uphill footpath,
    // and a cone that had quietly gone flat again would still pass a band.
    //
    // Normalised, because the pool is an ellipse: `POOL_ACROSS` on X and
    // `POOL_ALONG` on Z. `t` is 1 on the rim of either axis, which is the same
    // coordinate `POOL_FALLOFF` is written in, and testing in it is what makes
    // this a test of the ellipse rather than of a circle that happens to fit
    // inside one. It also catches the axes being swapped, which the geometry
    // alone cannot: `poolAcross` and `poolAlong` below are read off the built
    // vertices and compared to the constants in the order they are declared.
    const dx = pos.getX(i) - LAMP_OUTREACH;
    const dz = pos.getZ(i);
    const t = Math.hypot(dx / POOL_ACROSS, dz / POOL_ALONG);
    if (t > 1 + 1e-3) continue;
    const predicted = POOL_LIFT + POOL_RIM_LIFT * t;
    if (Math.abs(y - predicted) < 1e-3) {
      poolVerts++;
      poolMaxR = Math.max(poolMaxR, t);
      poolAcross = Math.max(poolAcross, Math.abs(dx));
      poolAlong = Math.max(poolAlong, Math.abs(dz));
    } else if (y < POOL_LIFT + POOL_RIM_LIFT + 1e-3 && y < 2) {
      // Low, inside the pool's footprint, and not on the cone: that is either a
      // flattened pool or a shaft foot in the wrong place. The shaft's own feet
      // sit at exactly `POOL_LIFT` and within `SHAFT_HALF_FOOT` of the axis, so
      // they are excluded rather than counted.
      if (!(Math.abs(y - POOL_LIFT) < 1e-3 && Math.hypot(dx, dz) <= SHAFT_HALF_FOOT + 1e-3)) offCone++;
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
  if (Math.abs(poolMaxR - 1) > 0.01) {
    failures.push(
      `The pool reaches ${poolMaxR.toFixed(3)} of its own rim rather than exactly 1; the falloff ` +
        `table's last stop is what the geometry ends at.`,
    );
  }
  if (Math.abs(poolAcross - POOL_ACROSS) > 0.05 || Math.abs(poolAlong - POOL_ALONG) > 0.05) {
    failures.push(
      `The pool measures ${poolAcross.toFixed(2)} m across the street and ${poolAlong.toFixed(2)} m ` +
        `along it, against POOL_ACROSS ${POOL_ACROSS} and POOL_ALONG ${POOL_ALONG}. The long axis ` +
        `is Z because power.deriveYaw aims local +X across the road; swapped, every lamp in the ` +
        `city lights the front gardens instead of the street.`,
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
    // The train's ballast pool, on the same predicate rather than on one of its
    // own: the head kit's two lamps are `blob`s, so it is legitimately half
    // face-down, and only the orphan test can tell that apart from a pool that
    // will never be seen.
    ['train headlights', buildTrainHeadLights()],
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
  // (c1) 2026-09-05, "more street lamps, esp on arterial roads": a primary road
  //      through that same pole tile is lit anyway, at its own spacing, and a
  //      surveyed luminaire on it still wins over a column on the same spot.
  const primary = straightWay(14, 4, 0, 0, 600, 0);
  const arterial = deriveColumnLamps([primary], dense, 0, 0);
  const wantArterial = Math.floor(600 / COLUMN_SPACING[4]);
  if (arterial.length < wantArterial - 1 || arterial.length > wantArterial + 1) {
    failures.push(
      `A 600 m primary road through a tile with ${dense.poleCount} poles derived ${arterial.length} ` +
        `columns where ${wantArterial} were expected at ${COLUMN_SPACING[4]} m. Traffic routes are lit ` +
        `whatever the side streets hang off -- see COLUMN_ARTERIAL_MAX_CLASS.`,
    );
  }
  const litOnIt = new Float32Array(arterial.length * LAMP_RECORD_STRIDE);
  for (let i = 0; i < arterial.length; i++) {
    litOnIt[i * LAMP_RECORD_STRIDE] = arterial[i].x + 4;
    litOnIt[i * LAMP_RECORD_STRIDE + 1] = arterial[i].y + 8;
    litOnIt[i * LAMP_RECORD_STRIDE + 2] = arterial[i].z;
  }
  if (deriveColumnLamps([primary], dense, 0, 0, null, litOnIt).length !== 0) {
    failures.push(
      `With a surveyed luminaire 4 m from every one of its would-be columns, the primary road still ` +
        `derived columns. A pole that carries a lamp on the arterial must win; check COLUMN_LAMP_RADIUS.`,
    );
  }
  const litOffIt = new Float32Array(LAMP_RECORD_STRIDE);
  litOffIt[0] = 300;
  litOffIt[2] = COLUMN_LAMP_RADIUS + 40;
  if (deriveColumnLamps([primary], dense, 0, 0, null, litOffIt).length !== arterial.length) {
    failures.push('A luminaire well off the arterial changed how many columns it got.');
  }
  if (deriveColumnLamps([primary, straightWay(15, 10, 0, 200, 600, 200)], dense, 0, 0).length !== arterial.length) {
    failures.push(
      'A residential street in the same dense pole tile derived columns beside the arterial; rule 1 ' +
        'still binds every class that is not a traffic route.',
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
  // --- The broken headlight, which is the one thing in `CarLights` that can
  //     leave an instance buffer describing a car that is not there.
  //
  // Three claims, and the second is the one that would ship: a dented car goes
  // into the one-lamp set, the *paired* set is packed with no hole where it
  // went, and both sets go back to zero on a frame with nothing in them. A hole
  // in the pair set is last frame's matrix inside this frame's count -- a pair
  // of headlights hanging in the air where a car used to be, which is exactly
  // the artefact `TrafficMovers`' own "only upload what changed" rule is written
  // around.
  {
    const lights = new CarLights();
    const pose = createCarPose();
    pose.dx = 1;
    pose.dz = 0;
    pose.scale = 1;
    pose.body = 0;
    lights.setLive(true);
    lights.begin();
    // Two healthy cars, one dented, one healthy -- interleaved, because the
    // packing bug only shows when a broken car is not last.
    for (const [x, damage] of [[0, 0], [10, 0.5], [20, 0], [30, 0.9]] as Array<[number, number]>) {
      pose.x = x;
      pose.damage = damage;
      lights.add(pose);
    }
    lights.end();
    const [head, tail, , broken] = lights.meshes;
    if (broken.count !== 2) failures.push(`Two dented cars produced ${broken.count} one-lamp instances.`);
    if (head.count !== 2) failures.push(`Two undamaged cars produced ${head.count} paired-lamp instances.`);
    if (tail.count !== 4) failures.push(`Four lit cars produced ${tail.count} tail-lamp instances; every car has tail lamps.`);
    // The pair set is packed: instance 0 and 1 are the two healthy cars at x = 0
    // and x = 20, and neither is at x = 10 or 30.
    const at = (mesh: typeof head, i: number): number => {
      const m = new Matrix4();
      mesh.getMatrixAt(i, m);
      return m.elements[12];
    };
    // The lamp kit is anchored half a body length ahead of the car's centre.
    const nose = CAR_BODY_SIZE[0].length * 0.5;
    if (Math.abs(at(head, 0) - nose) > 0.01 || Math.abs(at(head, 1) - (20 + nose)) > 0.01) {
      failures.push(
        `The paired headlight set has a hole in it: instances 0 and 1 are at x = ${at(head, 0).toFixed(1)} and ` +
          `${at(head, 1).toFixed(1)}, and the two undamaged cars are at 0 and 20. A slot inside the count that ` +
          `nobody wrote draws last frame's matrix -- headlights hanging in the air where a car used to be.`,
      );
    }
    // An empty frame empties all three.
    lights.begin();
    lights.end();
    if (head.count !== 0 || tail.count !== 0 || broken.count !== 0) {
      failures.push(`An empty frame left ${head.count}/${tail.count}/${broken.count} car lamp instances drawn.`);
    }
    // The night switch reaches the one-lamp set. A broken headlight is still a
    // headlight and must not burn through the daylight.
    lights.setLive(false);
    if (broken.visible) failures.push('The one-lamp headlight set stayed visible in daylight.');
    lights.setLive(true);
    if (!broken.visible) failures.push('The one-lamp headlight set did not come back at dusk.');
    if (!lights.nightSets.includes(broken)) {
      failures.push('`nightSets` does not include the one-lamp set, so the dusk probe would not check it.');
    }
    // And the threshold is the *rules'*. A car one point above
    // `CAR_DENTED_HEALTH` keeps both lamps and one exactly on it does not, which
    // is `damageGrade`'s answer and not a number this file chose.
    {
      const probe = new CarLights();
      probe.setLive(true);
      probe.begin();
      pose.x = 0;
      pose.damage = damageFraction(CAR_DENTED_HEALTH + 1);
      probe.add(pose);
      pose.damage = damageFraction(CAR_DENTED_HEALTH);
      probe.add(pose);
      probe.end();
      if (probe.meshes[0].count !== 1 || probe.meshes[3].count !== 1) {
        failures.push(
          `A car on ${CAR_DENTED_HEALTH + 1} hp and one on ${CAR_DENTED_HEALTH} produced ` +
            `${probe.meshes[0].count} paired and ${probe.meshes[3].count} one-lamp kits. The headlight goes ` +
            `out at exactly the health game/driving.ts calls dented, and nowhere else.`,
        );
      }
      probe.dispose();
    }
    lights.dispose();
  }

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
  /* --- The `F` switch, and it is checked here rather than believed because it
   * is now the one thing in this file a *player* can do to a light thirty times
   * a second if they want to.
   *
   * Three claims: pressing it takes the beam to exactly zero, it leaves the
   * light on the render list (the recompile invariant, which is the whole file),
   * and it does not reach a bike headlight -- see the switch in `update`. The
   * last of those is the one that would ship: a rider whose lamp is dark because
   * they put a torch away on foot ten minutes ago has no way at all to find out
   * why. */
  probe2.update(1 / 60, camera, -20, 0, null, null);
  const beamOn = probe2.torch.intensity;
  if (!(beamOn > 0) || probe2.torchOn !== true) {
    failures.push(
      `The torch is not lit at midnight before anybody has touched the key: intensity ${beamOn}, ` +
        `torchOn ${probe2.torchOn}. It must default to on -- it has been automatic since it ` +
        `existed, and the request the key arrived beside was "i cant see shit at night rn".`,
    );
  }
  probe2.toggleTorch();
  probe2.update(1 / 60, camera, -20, 0, null, null);
  if (probe2.torch.intensity !== 0) {
    failures.push(
      `Switching the torch off left it at ${probe2.torch.intensity} of intensity rather than ` +
        `exactly zero. The sway's flicker gain multiplies this line, so a switch written as a ` +
        `subtraction or a fade floor leaves a beam nobody asked for.`,
    );
  }
  if (probe2.torch.visible !== true || identity(probe2) !== before) {
    failures.push(
      `Switching the torch off changed the set of real lights to "${identity(probe2)}" (visible ` +
        `${probe2.torch.visible}). An off torch must be a light at zero intensity and never a ` +
        `hidden one: _projectObject skips an invisible object, so hiding it takes it off the ` +
        `render list, changes LightsNode.customCacheKey and recompiles every pipeline in the ` +
        `scene -- once per keypress, on a key a player can hold down.`,
    );
  }
  torchBikeMount(mount, 100, 0, 200, 0);
  probe2.update(1 / 60, camera, -20, 8, null, mount);
  if (!(probe2.torch.intensity > 0)) {
    failures.push(
      `A bike headlight is dark (${probe2.torch.intensity}) because the rider had put their torch ` +
        `away on foot. Mounting is an *exchange* of one light for another -- both hands are on ` +
        `the bars, so there is nothing in the hand for the key to have switched -- and a rider ` +
        `riding blind at 26 m/s for a reason nothing on screen explains is the worst failure this ` +
        `key can have. See the switch in \`update\`.`,
    );
  }
  probe2.toggleTorch();
  probe2.update(1 / 60, camera, -20, 0, null, null);
  if (!(probe2.torch.intensity > 0) || probe2.torchOn !== true) {
    failures.push(
      `The torch did not come back on when switched back on: intensity ${probe2.torch.intensity}, ` +
        `torchOn ${probe2.torchOn}.`,
    );
  }

  // The sprites are meshes and may be hidden freely; the *lights* may not, and
  // the two are one keystroke apart in this file. So: on at midnight, off at
  // three in the afternoon, and the light set unchanged either way.
  // `nightSets` and not `meshes`: the brake lamps are in that array too and are
  // deliberately *not* on the night's switch, because a brake light is on
  // because somebody is standing on the pedal, which is as true at noon as it is
  // at midnight. See `CarLights.setLive`.
  if (!probe2.bikeLights.mesh.visible || probe2.carLights.nightSets.some((m) => !m.visible)) {
    failures.push(
      `The night's additive sets are not drawn with the sun 20 degrees down. They are the whole ` +
        `of what a headlight looks like -- the real lights only ever put light on surfaces -- so ` +
        `a set left hidden at midnight is a fleet of invisible cars and an unlit bike.`,
    );
  }
  probe2.update(1 / 60, camera, 57.11, 0, null, null);
  if (probe2.bikeLights.mesh.visible || probe2.carLights.nightSets.some((m) => m.visible)) {
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

  // 9. The trains, which are the one population in this file whose level is not
  //    the shared uniform. See `verifyTrainLightKit`.
  for (const failure of verifyTrainLightKit()) failures.push(failure);

  return failures;
}

/**
 * The train light kit: the windows, the two ends, the one real light, and the
 * frame cycle that drives them.
 *
 * Split out of `verifyNightLights` rather than folded into it because half of
 * what it checks belongs to `world/trains.ts` and cannot be reached from there --
 * that file imports this one, so the arrow only points one way and the geometry
 * has to be asserted on this side of it. `verifyTrainLights` over there asserts
 * the half that needs a bake and a consist. Both are run at boot; neither throws.
 *
 * Everything here is measured on a **throwaway** rig rather than on the singleton
 * the game is about to draw with, so that a self-check can exercise the frame
 * cycle -- including the states this feature is most likely to get stuck in --
 * without leaving a carriage lit at the origin.
 */
export function verifyTrainLightKit(): string[] {
  const failures: string[] = [];

  // --- 1. The windows face out of their own bodyside, and sit just proud of it.
  //
  // A pane wound inwards is not dim, it is **absent**, and only on one side of
  // every train in the city: `FrontSide` culls it, so a player on the down
  // platform sees a lit train and a player on the up platform sees a black one.
  // That is a defect a screenshot can easily be taken on the wrong side of, so it
  // is re-derived here rather than trusted to the corner ordering in
  // `buildTrainWindows`.
  for (const double of [true, false]) {
    const g = buildTrainWindows(double);
    const p = g.getAttribute('position');
    const index = g.getIndex()!;
    let wrongWay = 0;
    let insideSkin = 0;
    let tooProud = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
      const bx = p.getX(b), by = p.getY(b);
      const cx = p.getX(c), cy = p.getY(c);
      // The z component of `cross(b - a, c - a)`, which is the front face under
      // `GPUFrontFace.CCW`. Only z, because every one of these triangles lies in
      // a plane of constant z and the other two components are zero by
      // construction -- and if they are not, the test below fails anyway.
      const ux = bx - ax, uy = by - ay;
      const vx = cx - ax, vy = cy - ay;
      const nz = ux * vy - uy * vx;
      if (nz * az <= 0) wrongWay++;
      const proud = Math.abs(az) - TRAIN_HALF_WIDTH;
      if (proud <= 0) insideSkin++;
      if (proud > 0.05) tooProud++;
      for (const [x, y] of [[ax, ay], [bx, by], [cx, cy]] as const) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const kind = double ? 'double-deck' : 'single-deck';
    if (wrongWay > 0) {
      failures.push(
        `${wrongWay} of the ${kind} carriage's ${index.count / 3} window triangles are wound ` +
          `towards the inside of the train. FrontSide culls those, so that is a train whose ` +
          `windows are lit from one platform and black from the other -- and which of the two ` +
          `you happen to look from is not something a screenshot settles.`,
      );
    }
    if (insideSkin > 0 || tooProud > 0) {
      failures.push(
        `The ${kind} window band is not just outside the bodyside: ${insideSkin} vertices are at ` +
          `or inside ${TRAIN_HALF_WIDTH} m and ${tooProud} are more than 5 cm proud of it. Inside ` +
          `it the sprite loses the depth test against the carriage's own hull and simply is not ` +
          `drawn; far outside it, it hangs in the air beside the train and is visible through the ` +
          `next carriage. See WINDOW_PROUD.`,
      );
    }
    // Unit length on X, because the instance matrix multiplies X by the consist's
    // own pitch. A band built at 20 m would come out 400 m long.
    if (maxX - minX > 1 || maxX - minX < 0.8) {
      failures.push(
        `The ${kind} window band is ${(maxX - minX).toFixed(2)} carriage lengths long. It is ` +
          `built at unit length and scaled by the consist's pitch exactly as the impostor box is, ` +
          `so anything but a little under 1 is a band the length of a platform.`,
      );
    }
    // Inside the loading gauge: the impostor's roof is 4.15 and its sill 0.9, and
    // a window above the roof is a window on the pantograph.
    if (maxY > 4.0 || minY < 0.8) {
      failures.push(
        `The ${kind} window band spans ${minY.toFixed(2)} to ${maxY.toFixed(2)} m over the ` +
          `railhead. The bodyside is 0.9 to 4.15, so this is glass in the underframe or in the ` +
          `roof.`,
      );
    }
    g.dispose();
  }

  // --- 2. The head kit throws forwards, stays on the track, and its pool is
  //        wound upwards. `quadUp`'s own trap, restated for a new caller: a pool
  //        wound the other way is culled and the symptom is "the train does not
  //        light the track", which reads as a missing feature rather than a bug.
  {
    const g = buildTrainHeadLights();
    const p = g.getAttribute('position');
    const index = g.getIndex()!;
    let behind = 0;
    let outOfGauge = 0;
    let reach = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      for (const v of [a, b, c]) {
        const x = p.getX(v);
        const z = p.getZ(v);
        if (x < -0.4) behind++;
        if (x > reach) reach = x;
        if (Math.abs(z) > 3.2) outOfGauge++;
      }
    }
    if (behind > 0) {
      failures.push(
        `${behind} vertices of the headlight kit are behind its own anchor. The anchor is the ` +
          `**nose** of the leading carriage, so anything at negative x is a beam thrown through ` +
          `the driver's cab and down the inside of the train.`,
      );
    }
    if (Math.abs(reach - TRAIN_BEAM_LENGTH) > 0.5 && Math.abs(reach - TRACK_POOL_END) > 0.5) {
      failures.push(
        `The headlight kit reaches ${reach.toFixed(1)} m, neither the beam's ` +
          `${TRAIN_BEAM_LENGTH} m nor the pool's ${TRACK_POOL_END} m.`,
      );
    }
    if (outOfGauge > 0) {
      failures.push(
        `${outOfGauge} vertices of the headlight kit are more than 3.2 m off the track centre. ` +
          `A beam wider than the four-foot and its cess is a beam lighting the platform coping ` +
          `of the road beside it -- see TRAIN_BEAM_HALF_END.`,
      );
    }
    // The pool's own winding is not checked here: it goes through the orphan
    // face-down test in `verifyNightLights` above, with the street lamp's and the
    // car's, because the head kit's two lamps are `blob`s and are legitimately
    // half face-down. A naive flat-triangle count fires on those every time.
    g.dispose();
  }

  // --- 3. The rig itself: the instanced sets, the colour buffer, the parked
  //        warm-up instance, and the one real light.
  const kit = new TrainLights();
  if (kit.material.opacityNode !== null && kit.material.opacityNode !== undefined) {
    failures.push(
      `The train material carries an opacityNode. It must not: the day/night term for a train is ` +
        `per **carriage**, because a train in a bore is lit at noon and one on the Meadowbank ` +
        `bridge beside it is not, and one uniform cannot say both. See TrainLights section 1.`,
    );
  }
  for (const mesh of kit.meshes) {
    if (mesh.instanceColor === null) {
      failures.push(
        `${mesh.name} has no instanceColor buffer after construction. ` +
          `NodeMaterial.setupDiffuseColor only multiplies by it when the attribute exists at the ` +
          `moment the node graph is built, so this is every train in Sydney lit at midday, ` +
          `forever, with no way to turn it off. setColorAt(0, white) in the constructor.`,
      );
    }
    if (mesh.count < 1 || !mesh.visible) {
      failures.push(
        `${mesh.name} starts at count ${mesh.count} / visible ${mesh.visible}. A set that draws ` +
          `nothing during the fleet's warm-up walk is a set whose pipeline is compiled inside ` +
          `whichever frame first shows a lit train -- see world/warmup.ts, and the parked ` +
          `instance in the constructor.`,
      );
    }
  }
  const saloon = kit.saloon;
  if (saloon.visible !== true || saloon.castShadow === true || saloon.intensity !== 0) {
    failures.push(
      `The saloon light starts visible ${saloon.visible}, castShadow ${saloon.castShadow}, ` +
        `intensity ${saloon.intensity}. It must be visible (an invisible light is off the render ` +
        `list, which recompiles every pipeline in the scene), cast nothing, and be dark until ` +
        `somebody boards.`,
    );
  }

  // --- 4. One frame of the cycle, and then the *empty* frame after it, which is
  //        the state this feature is most likely to get stuck in: the player gets
  //        off, or the sun comes up, and something stays lit. Nothing in the
  //        renderer would report that and the player would simply see a glowing
  //        train in daylight.
  // **Twice**, and that is not padding: every counter here is reset in `begin`
  // and incremented in `car`, so one pass cannot tell a counter that is reset
  // from one that accumulates. `drawnUnderground` was exactly that -- it read
  // 75,033 after two minutes on the platform at Redfern, which is a plausible
  // enough number to be believed and is the only evidence anybody has that the
  // bore rule is still answering.
  for (let pass = 0; pass < 2; pass++) {
    kit.begin();
    _matrix.identity();
    kit.car(_matrix, false, 1, false);
    kit.car(_matrix, true, 0.5, true);
    kit.car(_matrix, false, 0, false);
    kit.head(_matrix, 1);
    kit.tail(_matrix, 1);
    kit.rider(0, 2, 0, 1);
    kit.end();
  }
  if (kit.drawn !== 2 || kit.ends !== 2 || kit.overflowed !== 0) {
    failures.push(
      `One frame with three carriages offered -- lit, half lit underground and dark -- drew ` +
        `${kit.drawn} carriages and ${kit.ends} ends. It should be 2 and 2: a carriage at level ` +
        `zero is never added at all, which is what makes a summer afternoon four draws of zero ` +
        `instances rather than a buffer full of black quads.`,
    );
  }
  if (kit.drawnUnderground !== 1) {
    failures.push(
      `${kit.drawnUnderground} carriages were counted as underground out of one offered. That ` +
        `counter is how anybody ever notices the bore rule has stopped answering.`,
    );
  }
  if (kit.saloon.intensity !== SALOON_INTENSITY) {
    failures.push(
      `A rider aboard a fully lit carriage got ${kit.saloon.intensity} of saloon light, not ` +
        `${SALOON_INTENSITY}.`,
    );
  }
  kit.begin();
  kit.end();
  const stuck = kit.meshes.filter((m) => m.count !== 0).map((m) => m.name);
  if (stuck.length > 0 || kit.saloon.intensity !== 0 || kit.drawn !== 0 || kit.drawnUnderground !== 0) {
    failures.push(
      `After a frame in which nothing was offered, ${stuck.join(', ') || 'nothing'} is still ` +
        `drawing and the saloon light is at ${kit.saloon.intensity}. That is the daybreak case ` +
        `and the alighting case: whatever was lit last frame must go dark on the frame nobody ` +
        `asks for it, or the player walks away from a train they are still standing inside the ` +
        `light of.`,
    );
  }
  // And the staleness guard, which is the *other* way this gets stuck: the fleet
  // stops updating entirely and nothing ever calls `end()` again.
  kit.begin();
  kit.rider(0, 2, 0, 1);
  kit.end();
  kit.tick(SALOON_STALE_S * 0.4);
  if (kit.saloon.intensity === 0) {
    failures.push(
      `The saloon light went out ${(SALOON_STALE_S * 0.4).toFixed(2)} s after being placed. The ` +
        `staleness guard is meant to survive a dropped frame; at this rate it flickers.`,
    );
  }
  kit.tick(SALOON_STALE_S);
  if (kit.saloon.intensity !== 0) {
    failures.push(
      `The saloon light is still on ${(SALOON_STALE_S * 1.4).toFixed(2)} s after the last frame ` +
        `that placed it. A fleet that stops updating -- no bake, a failed rail load -- would ` +
        `leave a point light burning in the middle of Redfern for the session.`,
    );
  }

  // --- 5. **THE HANDOVER**: `windowBandFade`, which is the one number standing
  //        between a hero carriage and the sprite grid the player asked to have
  //        taken off it. Both ends and the monotonicity, because a ramp that
  //        went the wrong way would put the band on the near train and take it
  //        off the far one, which is the shipped bug with a minus sign.
  if (windowBandFade(0) !== 0 || windowBandFade(WINDOW_HERO_NEAR) !== 0) {
    failures.push(
      `windowBandFade puts ${windowBandFade(0)} of the sprite band on a carriage at the player's ` +
        `feet. It must be exactly zero inside ${WINDOW_HERO_NEAR} m: that band is a generic ` +
        `unit-length grid that lines up with no real window on either model, and over a hero ` +
        `carriage at a platform it is a picture of a train stuck on a train.`,
    );
  }
  if (windowBandFade(WINDOW_HERO_FAR) !== 1 || windowBandFade(1e4) !== 1) {
    failures.push(
      `windowBandFade only reaches ${windowBandFade(WINDOW_HERO_FAR)} at ${WINDOW_HERO_FAR} m. ` +
        `Past there the band is the *whole* of what makes a train read as lit -- there is no ` +
        `interior left to see -- so anything under 1 is a dimmer city seen from every hill in it.`,
    );
  }
  {
    let previous = -1;
    let wrongWay = 0;
    for (let d = 0; d <= WINDOW_HERO_FAR + 20; d += 0.5) {
      const f = windowBandFade(d);
      if (f < previous - 1e-9) wrongWay++;
      previous = f;
    }
    if (wrongWay > 0) {
      failures.push(
        `windowBandFade falls with distance at ${wrongWay} of the sampled metres. It is swept ` +
          `rather than spot-checked because a non-monotonic ramp is a band that brightens and ` +
          `dims as a player walks along a platform, which reads as flicker rather than as a bug.`,
      );
    }
  }

  // --- 6. **THE DOOR WEDGE**, on the same terms as the window band: it lies on
  //        the platform deck, it is outboard of the platform face, and it is
  //        wound face-up. A wedge wound the other way is culled and the symptom
  //        is "the doors do not light the platform", which reads as the feature
  //        never having been built.
  {
    const g = buildDoorSpill();
    const p = g.getAttribute('position');
    const index = g.getIndex()!;
    const deck = DOOR_DECK_Y + DOOR_SPILL_LIFT;
    let offDeck = 0;
    let inboard = 0;
    let faceDown = 0;
    let reach = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const ax = p.getX(a), az = p.getZ(a);
      const ux = p.getX(b) - ax, uz = p.getZ(b) - az;
      const vx = p.getX(c) - ax, vz = p.getZ(c) - az;
      // The y component of `cross(b - a, c - a)` for a triangle in a plane of
      // constant y, which is what `quadUp` promises and what `FrontSide` keeps.
      if (uz * vx - ux * vz <= 0) faceDown++;
      for (const v of [a, b, c]) {
        if (Math.abs(p.getY(v) - deck) > 1e-6) offDeck++;
        const z = p.getZ(v);
        if (z < DOOR_DECK_INNER - 1e-6) inboard++;
        if (z > reach) reach = z;
      }
    }
    if (faceDown > 0) {
      failures.push(
        `${faceDown} of the door wedge's ${index.count / 3} triangles are wound face-down. ` +
          `FrontSide culls those, so this is a train whose open doors put nothing on the platform ` +
          `-- and nothing is exactly what the state before this change looked like.`,
      );
    }
    if (offDeck > 0) {
      failures.push(
        `${offDeck} of the door wedge's vertices are not at ${deck.toFixed(2)} m over the railhead. ` +
          `It is light lying on a platform deck, and a deck is flat: anything off it either ` +
          `z-fights the paving or floats over it as a sheet you can see the edge of.`,
      );
    }
    if (inboard > 0) {
      failures.push(
        `${inboard} of the door wedge's vertices are inboard of the ${DOOR_DECK_INNER} m platform ` +
          `face. That is light drawn in the gap between the train and the coping, at deck height, ` +
          `which is inside the carriage's own solid box.`,
      );
    }
    if (Math.abs(reach - DOOR_SPILL_REACH) > 1e-6) {
      failures.push(
        `The door wedge reaches ${reach.toFixed(2)} m from the track centre rather than ` +
          `${DOOR_SPILL_REACH}. A platform is 5.5 m wide from the face; a wedge that ran the whole ` +
          `way over it would stop being a shape and start being a lit floor.`,
      );
    }
    g.dispose();
  }

  // --- 7. **OPEN AND SHUT MUST DIFFER, AND MEASURABLY.** The whole of the
  //        report is that they did not: a shut door was a lit window band and an
  //        open one was a black rectangle in the middle of it, and neither state
  //        put anything on the deck. So the frame cycle is driven through both,
  //        and the shut case is the negative control rather than an afterthought
  //        -- a wedge that is always on is as wrong as one that never is, and it
  //        is the version that looks fine in a screenshot of an open door.
  {
    const probe = new TrainLights();
    const spill = probe.meshes[4];
    _matrix.identity();

    probe.begin();
    probe.doorway(_matrix, 1, 0, 5);
    probe.end();
    const shutDrawn = spill.count;
    const shutLight = probe.doorLight.intensity;

    probe.begin();
    probe.doorway(_matrix, 1, 1, 5);
    probe.end();
    const openDrawn = spill.count;
    const openLight = probe.doorLight.intensity;

    if (shutDrawn !== 0 || shutLight !== 0) {
      failures.push(
        `A doorway offered with the leaves shut drew ${shutDrawn} wedges and lit the door spot to ` +
          `${shutLight}. Both must be zero. This is the control the feature exists against: light ` +
          `on the platform that does not depend on the doors is a station lamp somebody has ` +
          `attached to a train.`,
      );
    }
    if (openDrawn !== 1 || openLight !== DOOR_SPOT_INTENSITY) {
      failures.push(
        `A doorway offered wide open drew ${openDrawn} wedges and lit the door spot to ` +
          `${openLight} rather than 1 and ${DOOR_SPOT_INTENSITY}.`,
      );
    }
    // Half open is half of both, because the only clock either of them has is
    // `world/trains.doorOpenness` and it arrives as this argument.
    probe.begin();
    probe.doorway(_matrix, 1, 0.5, 5);
    probe.end();
    if (Math.abs(probe.doorLight.intensity - DOOR_SPOT_INTENSITY * 0.5) > 1e-6) {
      failures.push(
        `A half-open doorway lit the spot to ${probe.doorLight.intensity} rather than half of ` +
          `${DOOR_SPOT_INTENSITY}. The leaves take ${1.6} s to travel and the light has to travel ` +
          `with them, off the same number, or the spill snaps on before the door is open.`,
      );
    }

    // Where the beam goes, which is the whole reason it is a spot: out of the
    // opening and down onto the deck, never back through the carriage.
    probe.begin();
    probe.doorway(_matrix, 1, 1, 5);
    probe.end();
    const src = probe.doorLight.position;
    const aim = probe.doorLight.target.position;
    if (!(src.z > 0 && src.z < DOOR_DECK_INNER) || src.y <= DOOR_DECK_Y) {
      failures.push(
        `The door spot sits at z ${src.z.toFixed(2)}, y ${src.y.toFixed(2)} in the doorway frame. ` +
          `It has to be inboard of the ${DOOR_DECK_INNER} m platform face and above the deck -- in ` +
          `the aperture, behind the leaves -- or the doorway is not what is shaping the light.`,
      );
    }
    if (!(aim.z > src.z && aim.y < src.y)) {
      failures.push(
        `The door spot aims from (${src.z.toFixed(2)}, ${src.y.toFixed(2)}) to ` +
          `(${aim.z.toFixed(2)}, ${aim.y.toFixed(2)}) in the doorway frame. It must point outward ` +
          `and down. Nothing in this rig casts a shadow, so the cone is the only mask there is: ` +
          `pointed anywhere else it lights the platform straight through the bodyside, with the ` +
          `doors shut.`,
      );
    }

    // And the nearest doorway wins the one light, which is the budget. Offered
    // a near one and a far one in either order, the near one takes it.
    for (const order of [[4, 40], [40, 4]] as const) {
      probe.begin();
      _matrix.makeTranslation(0, 0, 0);
      probe.doorway(_matrix, 1, 1, order[0]);
      _matrix.makeTranslation(100, 0, 0);
      probe.doorway(_matrix, 1, 1, order[1]);
      probe.end();
      const near = order[0] < order[1] ? 0 : 100;
      if (Math.abs(probe.doorLight.position.x - near) > 1e-6) {
        failures.push(
          `Offered doorways at ${order[0]} m and ${order[1]} m in that order, the one real door ` +
            `light went to the one at x ${probe.doorLight.position.x}. It must always be the ` +
            `nearest: there is exactly one of these in the city and the deck it lights is the only ` +
            `deck anybody is standing on.`,
        );
      }
    }
    // Out of range is out of the budget entirely -- geometry only.
    probe.begin();
    _matrix.identity();
    probe.doorway(_matrix, 1, 1, DOOR_SPOT_RANGE + 10);
    probe.end();
    if (probe.doorLight.intensity !== 0 || probe.meshes[4].count !== 1) {
      failures.push(
        `A doorway ${DOOR_SPOT_RANGE + 10} m away drew ${probe.meshes[4].count} wedges and lit the ` +
          `spot to ${probe.doorLight.intensity}. Past ${DOOR_SPOT_RANGE} m the wedge is still worth ` +
          `drawing -- it is free -- and the real light is worth nothing but its per-fragment cost.`,
      );
    }
    // The empty frame, and the staleness guard, on the saloon's own terms: this
    // light is anchored to a doorway rather than to the player, so an orphan
    // burns on a platform the player left rather than following them about.
    probe.begin();
    probe.end();
    if (probe.doorLight.intensity !== 0 || probe.meshes[4].count !== 0) {
      failures.push(
        `After a frame in which no doorway was offered the door spot is at ` +
          `${probe.doorLight.intensity} over ${probe.meshes[4].count} wedges. That is the departure ` +
          `case: the doors shut, the train pulls out, and the light it left is still on the deck.`,
      );
    }
    probe.begin();
    _matrix.identity();
    probe.doorway(_matrix, 1, 1, 5);
    probe.end();
    probe.tick(SALOON_STALE_S * 1.4);
    if (probe.doorLight.intensity !== 0) {
      failures.push(
        `The door spot survived ${(SALOON_STALE_S * 1.4).toFixed(2)} s of a fleet that stopped ` +
          `updating. It is on the same guard as the saloon light and for a worse case -- this one ` +
          `is not attached to the player, so nobody would ever walk into it and notice.`,
      );
    }

    // And the interior gain, on the one term of it that is a light rather than a
    // material: a rider in a Metro at full night gets `METRO_NIGHT_INTERIOR_GAIN`
    // of the saloon light a rider in a Tangara gets, and both are the full
    // `SALOON_INTENSITY` at noon. Driven through `begin`/`rider`/`end` rather
    // than read off the constant, because the failure worth catching is the gain
    // being accepted and then not multiplied in -- which renders as the reported
    // bug being unfixed and reads as a taste disagreement.
    for (const [what, metro, night] of [
      ['a Tangara at midnight', false, 1],
      ['a Metro at midday', true, 0],
      ['a Metro at midnight', true, 1],
    ] as ReadonlyArray<readonly [string, boolean, number]>) {
      probe.begin();
      probe.rider(0, 0, 0, 1, interiorNightGain(metro, night));
      probe.end();
      const want = SALOON_INTENSITY * interiorNightGain(metro, night);
      if (Math.abs(probe.saloon.intensity - want) > 1e-9) {
        failures.push(
          `the saloon light for ${what} came out at ${probe.saloon.intensity} rather than ` +
            `${want}. The night gain has to reach the intensity or "it is too bright at night in ` +
            `the metro" is still true and the constant is decoration.`,
        );
      }
    }
    if (
      SALOON_INTENSITY * interiorNightGain(true, 1) >=
      SALOON_INTENSITY * interiorNightGain(false, 1)
    ) {
      failures.push(
        `a Metro's saloon light at full night is not under a Tangara's. The whole report is that ` +
          `the Metro reads brighter than everything around it, and the Tangara is what "around ` +
          `it" is being measured against.`,
      );
    }

    // And the band, which is the other half of the same frame: a hero carriage
    // close enough to be seen properly is *lit* and *not banded*.
    probe.begin();
    _matrix.identity();
    probe.car(_matrix, false, 1, false, windowBandFade(20));
    probe.car(_matrix, false, 1, false, windowBandFade(400));
    probe.end();
    if (probe.drawn !== 2 || probe.banded !== 1) {
      failures.push(
        `A carriage at 20 m and one at 400 m came out as ${probe.drawn} lit and ${probe.banded} ` +
          `banded; it must be 2 and 1. Those two counters being equal is precisely the state the ` +
          `player photographed -- every lit carriage in the city wearing the sprite grid, including ` +
          `the one they were standing next to.`,
      );
    }
    probe.dispose();
  }

  kit.dispose();

  return failures;
}
