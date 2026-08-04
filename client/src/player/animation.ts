/**
 * The rig, the pose representation, and every clip in spec 8.1.
 *
 * There are no keyframes and no glTF animation tracks anywhere in this project.
 * A clip here is a **function of time** that writes bone rotations, exactly the
 * way `world/birds.ts` writes an instance matrix from a state machine -- the
 * same philosophy one level up, at skeleton scale instead of whole-object scale.
 * The argument is the same one that file makes and it is worth repeating,
 * because "just author it in Blender" is the obvious alternative:
 *
 *   - There is no asset pipeline for characters. Everything in this build is
 *     generated -- the city by `pipeline/`, the trees, cars, poles, bins and
 *     birds by code -- and a single `.glb` of hand-keyed animation would be the
 *     only binary asset in the repository and the only thing a contributor
 *     could not change without opening a DCC tool.
 *   - A punch that has to land inside spec 8.2's 150/100/250 ms envelope is
 *     *written* as 150/100/250 ms here. In a keyframe pipeline it is authored at
 *     some frame rate, exported, and then hoped to still be 150 ms.
 *   - Locomotion has to be keyed to real speed or the feet slide, and the
 *     arithmetic that prevents it (see `strideLength`) needs the leg length,
 *     which is a property of the rig rather than of a clip.
 *
 * ---------------------------------------------------------------------------
 * Why the rig lives in this file rather than in `character.ts`.
 *
 * A pose is a list of rotations *indexed by bone*, so the bone indices are the
 * contract every clip below is written against. Putting them here makes the
 * dependency one-way -- `character.ts` reads this table to build its skeleton,
 * and nothing here knows a mesh exists. The alternative, declaring the rig
 * beside the geometry it deforms, reads better and does not work: `character.ts`
 * needs the clips and the clips need the bone indices, and an ES module cycle
 * between two files whose top-level constants each reference the other's is a
 * temporal-dead-zone `ReferenceError` at import, not a warning.
 *
 * ---------------------------------------------------------------------------
 * Why every bone's rest rotation is the identity.
 *
 * The usual convention points a bone's local +Y down its own limb, which makes
 * "bend the elbow" one rotation about one axis no matter how the arm is posed.
 * This rig does the opposite: **all seventeen bones are axis-aligned with the
 * character in the bind pose, and the shape of the skeleton lives entirely in
 * the bones' rest positions.** Two things fall out of that, and both of them are
 * why a hand-written clip is readable at all:
 *
 *   - A rotation is in *character* space. `rot.x` on a shoulder swings the arm
 *     fore-and-aft whatever else is happening; in a limb-aligned rig the axis
 *     that does that depends on how the shoulder was built.
 *   - **Stretch is `scale.y`.** Every limb hangs along -Y from its parent, so
 *     scaling a bone's Y scales the offset to its child *along the limb* and
 *     nothing else. That is what makes the comic arm-stretch a single number
 *     rather than a translation the animator has to keep in step with a
 *     rotation. It compounds down the chain -- 1.05 on the shoulder and 1.05 on
 *     the elbow put the wrist at 1.10 -- and the mitt inherits it and smears
 *     along the swing axis, which is the rubber-hose read this is aiming at.
 *     It used to be 1.14 a bone, for a 1.30 smear; `clipPunchActive` records why
 *     a rigid cricket bat in that hand made the larger number unshippable.
 *
 * The cost is that a knee bends about the character's X even when the hip is
 * turned out, which for a figure that never turns its legs out is nothing.
 *
 * ---------------------------------------------------------------------------
 * Sign conventions, stated once so no clip has to re-derive them. Yaw 0 faces
 * **-Z**, which is `controller.step`'s forward and `birds.ts`'s heading, and
 * every limb hangs along -Y:
 *
 *   shoulder / hip  `rot.x > 0`   swings the limb FORWARD (toward -Z)
 *   elbow           `rot.x > 0`   bends the forearm forward -- the only way it goes
 *   knee            `rot.x < 0`   folds the shin BACKWARD -- the only way it goes
 *   shoulder / hip  `rot.z * side` > 0 splays the limb OUT, where side is -1 left
 *   chest / hips    `rot.y > 0`   turns the shoulders to the character's LEFT
 */

// --- The rig ------------------------------------------------------------------

/**
 * Bone indices. Seventeen bones against spec 8.1's budget of twenty, and the
 * three left unspent are deliberate rather than an accident of counting: there
 * is no head-look bone (the head bone does it), no clavicles (the shoulder lobe
 * is skinned to the shoulder) and no toe bones (a shoe is a rigid box on a
 * character whose feet are 12 cm long). Each of those is a bone that would cost
 * a uniform slot and 68 bytes of the per-object bind group on every actor for a
 * deflection nobody can see at the distance a melee brawler is played at.
 */
export const BONE = {
  HIPS: 0,
  SPINE: 1,
  CHEST: 2,
  NECK: 3,
  HEAD: 4,
  SHOULDER_L: 5,
  ELBOW_L: 6,
  WRIST_L: 7,
  SHOULDER_R: 8,
  ELBOW_R: 9,
  WRIST_R: 10,
  HIP_L: 11,
  KNEE_L: 12,
  ANKLE_L: 13,
  HIP_R: 14,
  KNEE_R: 15,
  ANKLE_R: 16,
} as const;

export const BONE_COUNT = 17;

export interface BoneSpec {
  readonly name: string;
  /** Index into `RIG`, or -1 for the root. */
  readonly parent: number;
  /** Rest position in the parent's frame, metres. The whole shape of the rig. */
  readonly rest: readonly [number, number, number];
}

/**
 * The skeleton, in metres, for a figure 1.70 m from the sole to the crown.
 *
 * Read down the `y` column and the proportions of spec 8.1 are visible as
 * numbers: the hip joints are at 0.815 and the shoulder joints at 1.14, so the
 * whole torso is **0.33 m** -- stubby, less than half a leg -- while the head
 * that sits on it is 0.50 m tall, or 29% of the figure. The arm runs 0.185 m
 * out and then 0.64 m straight down to the wrist, which hangs the mitt level
 * with the knee: that is the noodle, and it is a *length* decision as much as
 * the thinness in `character.ts` is a radius one.
 */
export const RIG: readonly BoneSpec[] = [
  { name: 'hips', parent: -1, rest: [0, 0.86, 0] },
  { name: 'spine', parent: BONE.HIPS, rest: [0, 0.13, 0] },
  { name: 'chest', parent: BONE.SPINE, rest: [0, 0.14, 0] },
  { name: 'neck', parent: BONE.CHEST, rest: [0, 0.07, 0] },
  { name: 'head', parent: BONE.NECK, rest: [0, 0.05, 0] },

  { name: 'shoulder.L', parent: BONE.CHEST, rest: [-0.185, 0.01, 0] },
  { name: 'elbow.L', parent: BONE.SHOULDER_L, rest: [0, -0.33, 0] },
  { name: 'wrist.L', parent: BONE.ELBOW_L, rest: [0, -0.31, 0] },

  { name: 'shoulder.R', parent: BONE.CHEST, rest: [0.185, 0.01, 0] },
  { name: 'elbow.R', parent: BONE.SHOULDER_R, rest: [0, -0.33, 0] },
  { name: 'wrist.R', parent: BONE.ELBOW_R, rest: [0, -0.31, 0] },

  { name: 'hip.L', parent: BONE.HIPS, rest: [-0.105, -0.045, 0] },
  { name: 'knee.L', parent: BONE.HIP_L, rest: [0, -0.4, 0] },
  { name: 'ankle.L', parent: BONE.KNEE_L, rest: [0, -0.355, 0] },

  { name: 'hip.R', parent: BONE.HIPS, rest: [0.105, -0.045, 0] },
  { name: 'knee.R', parent: BONE.HIP_R, rest: [0, -0.4, 0] },
  { name: 'ankle.R', parent: BONE.KNEE_R, rest: [0, -0.355, 0] },
];

/** Thigh and shin, metres, and their sum. Derived so the gait arithmetic cannot drift from the rig. */
export const THIGH_LENGTH = -RIG[BONE.KNEE_L].rest[1];
export const SHIN_LENGTH = -RIG[BONE.ANKLE_L].rest[1];
export const LEG_LENGTH = THIGH_LENGTH + SHIN_LENGTH;

/** Character height, sole to crown. Stated here because `strideLength` and the crumple both scale off it. */
export const FIGURE_HEIGHT = 1.7;

/** Hip joint height in the bind pose, metres. */
export const HIP_HEIGHT = RIG[BONE.HIPS].rest[1] + RIG[BONE.HIP_L].rest[1];

/*
 * The shoe, declared here rather than with the mesh it belongs to.
 *
 * It is here because `legPair` has to know where the sole is: the lift that
 * keeps a character on the ground is computed from the lowest point of the
 * *shoe*, not of the ankle joint, and a foot pitched 13 degrees at toe-off puts
 * its heel 2.4 cm lower than its joint. Declaring it once and having
 * `character.buildFigure` read the same numbers is what stops the geometry and
 * the gait disagreeing about how long a foot is -- which would show up as a
 * character that walks correctly and scuffs, with nothing in either file wrong.
 */
/** Ankle joint height above the sole, metres. */
export const FOOT_DROP = HIP_HEIGHT - LEG_LENGTH;
/** Toe and heel, as z relative to the ankle. Toes point at -Z, which is forward. */
export const FOOT_TOE = -0.17;
export const FOOT_HEEL = 0.06;
export const FOOT_HALF_WIDTH = 0.062;
export const FOOT_THICKNESS = 0.07;

// --- Poses --------------------------------------------------------------------

/**
 * One pose: a rotation and a stretch per bone, plus one whole-body lift.
 *
 * Flat typed arrays rather than an array of `{x, y, z}` for the reason
 * `birds.ts` gives about its bird state: at seventeen bones this is not really
 * about speed, it is that blending two poses is then a straight-line loop over
 * numbers with no property lookups in it, and its cost is obvious from reading
 * it. A blend is the operation that runs three or four times per actor per
 * frame, so it is the one worth making boring.
 *
 * `lift` is the only translation in the system and it exists because two clips
 * genuinely need one. A walk rises twice per stride as the stance leg passes
 * under the body, and a knockout ends with the figure *on the ground*, 0.6 m
 * below where its feet were. Neither is expressible as a rotation, and adding a
 * translation channel to every bone to serve two clips would triple the size of
 * a pose to no other purpose.
 */
export interface Pose {
  /** XYZ Euler per bone, radians. Three's default `'XYZ'` order. */
  readonly rot: Float32Array;
  /** Scale along the bone's own +Y, which is along its limb. 1 is rest. */
  readonly stretch: Float32Array;
  /** Metres. The whole figure raised (+) or dropped (-) relative to its feet. */
  lift: number;
}

export function createPose(): Pose {
  return {
    rot: new Float32Array(BONE_COUNT * 3),
    stretch: new Float32Array(BONE_COUNT).fill(1),
    lift: 0,
  };
}

/** Back to the bind pose. Every clip starts here, so no clip has to zero what it does not set. */
export function resetPose(p: Pose): void {
  p.rot.fill(0);
  p.stretch.fill(1);
  p.lift = 0;
}

/** Set one bone's rotation. */
function rot(p: Pose, bone: number, x: number, y: number, z: number): void {
  const i = bone * 3;
  p.rot[i] = x;
  p.rot[i + 1] = y;
  p.rot[i + 2] = z;
}

/** Add to one bone's rotation, for clips that layer a wobble over a base. */
function addRot(p: Pose, bone: number, x: number, y: number, z: number): void {
  const i = bone * 3;
  p.rot[i] += x;
  p.rot[i + 1] += y;
  p.rot[i + 2] += z;
}

export function copyPose(out: Pose, src: Pose): void {
  out.rot.set(src.rot);
  out.stretch.set(src.stretch);
  out.lift = src.lift;
}

/**
 * Blend `src` over `out` by `weight`, optionally masked per bone.
 *
 * Component-wise linear interpolation of Euler angles, which is the cheap
 * approximation and is the right one here. It is wrong in general -- two large
 * rotations about different axes do not interpolate through the arc a
 * quaternion slerp would take -- and it is wrong by an amount that is
 * invisible at the amplitudes these clips use. The one place it could have bitten
 * is the knockout, whose hips reach 1.35 rad; that clip blends from *whatever
 * pose the actor was in* to a canned one along a single dominant axis, which is
 * exactly the case component-wise lerp gets right.
 *
 * `mask` is what makes a punch an *overlay*: with `UPPER_BODY` the arms, chest
 * and head take the punch while the legs keep walking, out of the same two
 * poses and one loop.
 */
export function blendPose(out: Pose, src: Pose, weight: number, mask: Float32Array | null = null): void {
  if (weight <= 0) return;
  for (let b = 0; b < BONE_COUNT; b++) {
    const w = mask === null ? weight : weight * mask[b];
    if (w <= 0) continue;
    const i = b * 3;
    out.rot[i] += (src.rot[i] - out.rot[i]) * w;
    out.rot[i + 1] += (src.rot[i + 1] - out.rot[i + 1]) * w;
    out.rot[i + 2] += (src.rot[i + 2] - out.rot[i + 2]) * w;
    out.stretch[b] += (src.stretch[b] - out.stretch[b]) * w;
  }
  // The lift follows the mask's *root* weight, because it is a property of the
  // whole figure and the hips are what carries the whole figure. A punch masked
  // to the upper body therefore cannot lift the character off the ground, and a
  // knockout, which is unmasked, can drop it.
  out.lift += (src.lift - out.lift) * (mask === null ? weight : weight * mask[BONE.HIPS]);
}

// --- Bone masks ---------------------------------------------------------------

function mask(weights: Partial<Record<number, number>>, fill = 0): Float32Array {
  const m = new Float32Array(BONE_COUNT).fill(fill);
  for (const key of Object.keys(weights)) {
    const b = Number(key);
    m[b] = weights[b] as number;
  }
  return m;
}

/**
 * Everything from the spine up, plus a third of the hips.
 *
 * The hips are in it on purpose and at a deliberately partial weight. A punch is
 * thrown from the ground: the hips lead, the chest follows, the arm arrives
 * last, and an upper-body overlay that stops at the spine produces a character
 * punching from the waist like a marionette. A third is as much hip rotation as
 * can be borrowed without visibly stealing the leg pose from a walk running
 * underneath it -- the legs are children of the hips, so every radian the
 * overlay puts here swings both feet with it.
 */
export const UPPER_BODY = /*#__PURE__*/ mask({
  [BONE.HIPS]: 0.33,
  [BONE.SPINE]: 1,
  [BONE.CHEST]: 1,
  [BONE.NECK]: 1,
  [BONE.HEAD]: 1,
  [BONE.SHOULDER_L]: 1,
  [BONE.ELBOW_L]: 1,
  [BONE.WRIST_L]: 1,
  [BONE.SHOULDER_R]: 1,
  [BONE.ELBOW_R]: 1,
  [BONE.WRIST_R]: 1,
});

/** The legs and the root. The half of a locomotion clip a punch must not touch. */
export const LOWER_BODY = /*#__PURE__*/ mask({
  [BONE.HIPS]: 1,
  [BONE.HIP_L]: 1,
  [BONE.KNEE_L]: 1,
  [BONE.ANKLE_L]: 1,
  [BONE.HIP_R]: 1,
  [BONE.KNEE_R]: 1,
  [BONE.ANKLE_R]: 1,
});

/** Everything. A knockout takes the whole figure and nothing survives it. */
export const WHOLE_BODY = /*#__PURE__*/ mask({}, 1);

// --- Clip inputs --------------------------------------------------------------

export interface ClipContext {
  /** Seconds since the actor was created. Drives everything that drifts rather than cycles. */
  time: number;
  /**
   * Stride phase, radians, advanced by **distance walked** and not by time.
   *
   * The same device `birds.ts` uses for its waddle, and it is what actually
   * stops the feet sliding: a phase driven by a clock has to be re-tuned every
   * time the speed changes and is wrong during every acceleration, where a
   * phase driven by distance is correct at every speed by construction and
   * stops dead the instant the character does.
   */
  stride: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Seconds since leaving the ground. Zero while standing. */
  air: number;
  /** Progress 0..1 through the current one-shot, for the timed clips. */
  t: number;
}

export type Clip = (out: Pose, ctx: ClipContext) => void;

// --- Stride arithmetic --------------------------------------------------------

/** Metres per full two-step cycle at walking pace, and at a flat sprint. */
const STRIDE_WALK = 1.55;
const STRIDE_RUN = 2.6;
/** Where the two are read off, in m/s. `controller.ts`'s WALK_SPEED and SPRINT_SPEED. */
const SPEED_WALK = 4.4;
const SPEED_RUN = 8.2;

/**
 * How far the character travels per full stride cycle, at a given speed.
 *
 * Interpolated between a walk's 1.55 m and a sprint's 2.6 m rather than held
 * constant, because a constant stride length turns a speed increase into pure
 * cadence: at `SPRINT_SPEED` and a walk's stride the legs would cycle at 5.3 Hz,
 * which is not a sprint, it is a cartoon of a treadmill. Real gait lengthens the
 * stride and raises the cadence together, and this splits the 1.9x speed change
 * into 1.7x of stride and 1.9/1.7 = 1.1x of... no: 2.6/1.55 is 1.68 of stride and
 * therefore 1.13x of cadence over the same range, so almost all of a sprint's
 * extra ground is bought with longer steps. Which is what a sprint is.
 */
export function strideLength(speed: number): number {
  const t = clamp01((speed - SPEED_WALK) / (SPEED_RUN - SPEED_WALK));
  return STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * t;
}

/**
 * The hip swing amplitude that makes a given stride length land without sliding.
 *
 * This is the whole no-foot-slide argument and it is three lines of geometry.
 * The planted foot sits `L * sin(theta)` ahead of the hip, where `theta` is the
 * hip's rotation and `L` the hip-to-ankle length. Over a stance phase the hip
 * goes from `+A` to `-A`, so the foot travels `2 * L * sin(A)` *backwards
 * relative to the body*. A stance phase is half a cycle, in which the body
 * advances half a stride. Set the two equal:
 *
 *     2 * L * sin(A) = stride / 2      ->      A = asin(stride / (4 * L))
 *
 * At a walk that is `asin(1.55 / (4 * 0.797))` = **0.508 rad**, a 29-degree
 * stride angle, which is what a person walking looks like. At a sprint the
 * stride outruns the legs -- 2.6 m over four rest leg lengths is 0.861 and
 * climbing -- which is why the run clip *stretches* the legs: `effectiveLeg` is
 * the rest length times both the run's own 6% and the stance compensation's
 * mean, and that is what keeps the required angle at a usable **0.878 rad**
 * instead of asking for one that does not exist. Clamped at 0.93 regardless,
 * because the last few degrees before a right angle buy almost no reach and
 * cost a splits pose.
 */
export function hipSwing(stride: number, effectiveLeg: number): number {
  return Math.asin(Math.min(0.93, stride / (4 * effectiveLeg)));
}

// --- Helpers ------------------------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hermite ramp, the same one every shader in this project uses. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// --- Locomotion clips ---------------------------------------------------------

/**
 * Idle: a weight shift, a breath, a sway and a slow look around.
 *
 * Four oscillators on deliberately unrelated periods -- 3.4 s, 2.2 s, 4.9 s and
 * 7.3 s -- because the failure mode of a procedural idle is that everything
 * pulses together and the character reads as a single breathing balloon. None of
 * these periods divides another, so the pose does not repeat for well over a
 * minute, which is longer than anyone stands still in a brawler.
 *
 * The weight shift is a hip roll with a *counter* roll in the chest, which is
 * what standing on one leg actually does and is the difference between "shifting
 * weight" and "leaning". It is small: 2.5 degrees at the hips.
 */
export const clipIdle: Clip = (out, ctx) => {
  const t = ctx.time;
  const shift = Math.sin(t * (Math.PI * 2) / 3.4);
  const breath = Math.sin(t * (Math.PI * 2) / 2.2);
  const sway = Math.sin(t * (Math.PI * 2) / 4.9);
  const look = Math.sin(t * (Math.PI * 2) / 7.3);

  rot(out, BONE.HIPS, 0.02, shift * 0.045, shift * 0.043);
  rot(out, BONE.SPINE, -0.01, shift * -0.02, shift * -0.028);
  rot(out, BONE.CHEST, 0.015, shift * -0.05, shift * -0.03);
  rot(out, BONE.NECK, breath * 0.012, 0, 0);
  // The head leads the look and the neck follows a beat behind, which is what
  // stops a head turn reading as a turret. A tenth of a second of phase is all
  // it takes at this amplitude.
  rot(out, BONE.HEAD, breath * 0.028 - 0.02, look * 0.19, shift * 0.03);
  addRot(out, BONE.NECK, 0, look * 0.06, 0);
  // Breathing is a stretch, not a rotation: the chest lengthens by 1.4 cm.
  out.stretch[BONE.CHEST] = 1 + breath * 0.012;

  // Arms hang out from the body far enough not to intersect the singlet, and
  // sway a few degrees out of phase with each other -- exactly out of phase
  // would read as a pendulum.
  armHang(out, -1, sway * 0.055, 0.1);
  armHang(out, 1, sway * -0.05, 0.11);

  // A standing figure's knees are not locked. Two degrees of bend is the
  // difference between a person and a mannequin.
  rot(out, BONE.KNEE_L, -0.05, 0, 0);
  rot(out, BONE.KNEE_R, -0.055, 0, 0);
  rot(out, BONE.HIP_L, 0.025, 0, -0.012);
  rot(out, BONE.HIP_R, 0.02, 0, 0.012);
};

/** `side` is -1 for the left arm and +1 for the right, matching the splay convention. */
function armHang(out: Pose, side: number, swing: number, splay: number): void {
  const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
  const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
  rot(out, shoulder, swing, 0, side * splay);
  rot(out, elbow, 0.14 + swing * 0.5, 0, 0);
}

/**
 * Walk, keyed to real speed.
 *
 * Legs and arms are one sine each, in exact anti-phase left to right and arm to
 * leg, which is the whole of a walk cycle -- everything else is amplitude. The
 * knee is the one channel that is not a sine: a knee only bends one way, so it
 * takes `max(0, ...)` of a sine advanced a quarter cycle, which puts the fold at
 * the top of the swing phase where the foot has to clear the ground and leaves
 * the stance leg straight, where it is carrying the body.
 *
 * The body rises and falls twice per cycle -- once per step, as the stance leg
 * passes under it -- but that is not written here as a curve. `legPair` returns
 * it, derived from where the lower foot actually is, which is the only way it
 * can be right through a crossfade. Measured over a cycle at 4.4 m/s the hip
 * travels **2.8 cm**, which is a walk.
 */
export const clipWalk: Clip = (out, ctx) => {
  const phase = ctx.stride;
  const stride = strideLength(ctx.speed);
  const swing = hipSwing(stride, LEG_LENGTH * STANCE_REACH);
  const s = Math.sin(phase);

  out.lift = legPair(out, phase, swing, 0.95, 0.02, 1, WALK_ROOT_PITCH);

  // Arms counter the legs. A walk's arm swing is about 60% of the leg's and the
  // elbow carries a constant 15 degrees of bend that deepens on the forward half.
  armSwing(out, -1, -s, swing * 0.62, 0.09, 0.15);
  armSwing(out, 1, s, swing * 0.62, 0.1, 0.15);

  // The torso counter-rotates against the pelvis -- the pelvis follows the legs,
  // the shoulders follow the arms, and the spine takes the difference. This is
  // the single cheapest thing that makes a walk look like a walk rather than
  // like scissors.
  rot(out, BONE.HIPS, WALK_ROOT_PITCH, s * 0.08, 0);
  rot(out, BONE.SPINE, 0.01, s * -0.06, 0);
  rot(out, BONE.CHEST, 0.02, s * -0.11, 0);
  rot(out, BONE.HEAD, 0.01, s * 0.05, 0);
};

/**
 * Run: the same cycle with the amplitudes a run has, plus the two things that
 * make it read as a run rather than a fast walk.
 *
 * The **lean** is the first: about 11 degrees of forward pitch spread across the
 * spine and chest rather than put on the hips, because leaning at the hips takes
 * the legs with it and the character runs bent at the waist with its feet
 * trailing behind. The second is the **arms**, which in a run stop swinging from
 * the shoulder and start pumping with a locked 80-degree elbow -- that shape is
 * more of the read than the leg speed is.
 *
 * The legs carry a constant 6% stretch on top of the stance compensation, and
 * that is not decoration: `hipSwing` needs the extra reach to keep a 2.6 m
 * stride inside a usable hip angle. Measured over a sprint cycle the leg runs
 * between 1.02 and 1.20 of its rest length and the hip bob reaches 9.6 cm.
 */
export const clipRun: Clip = (out, ctx) => {
  const phase = ctx.stride;
  const stride = strideLength(ctx.speed);
  const stretch = 1.06;
  const swing = hipSwing(stride, LEG_LENGTH * stretch * STANCE_REACH);
  const s = Math.sin(phase);

  out.lift = legPair(out, phase, swing, 1.55, 0.14, stretch, RUN_ROOT_PITCH);

  armSwing(out, -1, -s, 0.85, 0.12, 0.95);
  armSwing(out, 1, s, 0.85, 0.13, 0.95);

  rot(out, BONE.HIPS, RUN_ROOT_PITCH, s * 0.12, 0);
  rot(out, BONE.SPINE, 0.1, s * -0.09, 0);
  rot(out, BONE.CHEST, 0.09, s * -0.16, 0);
  // The head stays level while the body leans, because a runner looks where they
  // are going. This is the sum of the spine and chest lean, negated.
  rot(out, BONE.NECK, -0.06, 0, 0);
  rot(out, BONE.HEAD, -0.09, s * 0.06, 0);
};

/**
 * How much of the drop at the ends of a stride is paid for by *lengthening the
 * leg* rather than by dropping the whole body.
 *
 * A leg swung `theta` off vertical puts its foot `L * (1 - cos theta)` higher
 * than a vertical one does, and at a walk's 0.508 rad that is **9.6 cm**. Left
 * alone the character walks with its feet skimming over the pavement at heel
 * strike and toe-off, which is the second-most obvious animation failure after
 * sliding. Only two things can pay for it: the body drops, or the leg gets
 * longer. Real gait pays with a mixture (pelvic list, knee flexion in stance,
 * ankle plantarflexion) and 9.6 cm of pure body bob would be twice what a
 * person does.
 *
 * So 0.55 of it is paid by the leg and 0.45 by the body. Measured over a cycle,
 * that lands the walk's hip bob at **2.8 cm** and its leg lengthening between
 * 0.98 and 1.02 -- imperceptible as a stretch, which is the point at walking
 * pace. At a sprint the same split gives a 9.6 cm bob on legs running 1.02 to
 * 1.20, and there the stretch *is* meant to be visible: a leg that lengthens
 * into a stride is not a compromise on a character built out of noodles, it is
 * the same gag as the punch running quietly at every step.
 *
 * The value it is applied at is not written down anywhere -- `legPair` solves
 * for it, because every closed form for it was wrong. See the secant step there.
 */
const STANCE_LENGTHEN = 0.55;

/**
 * The correction `hipSwing` has to be told about, because a longer leg reaches
 * further forward as well as further down.
 *
 * With the lengthening above, the foot's fore-aft excursion is
 * `2 * L * k(theta) * sin(theta)` rather than `2 * L * sin(theta)`, so solving
 * for the no-slide angle against the *rest* length over-strides by about 8% --
 * the feet then run backwards faster than the body runs forwards, which is a
 * slide in the other direction and looks exactly as wrong. 1.055 is the mean of
 * `k` over a stance phase at walking amplitude.
 *
 * What the whole arrangement is worth, measured by stepping an actor at a
 * constant speed and reading the ankle's world position through the stance half
 * of a cycle: the planted foot's fore-aft excursion is **17% of the distance the
 * body covers in the same time** at 4.4 m/s and 25% at 8.2. An uncompensated
 * sinusoidal leg swing is 100% -- the foot travels with the body, which is a
 * moonwalk. The residual is the difference between a sine and the exact inverse
 * kinematics, and closing it needs a foot-locking IK pass, which is a different
 * feature and a much larger one.
 */
const STANCE_REACH = 1.055;

/**
 * How far the pelvis itself pitches forward, per gait.
 *
 * Named rather than written inline because `legPair` has to be told: the hips
 * bone is the legs' parent, so its lean tilts the whole chain, and a sole-height
 * calculation that does not know about it leaves the foot in the pavement by
 * `LEG_LENGTH * sin(hipAngle) * rootPitch` -- 7 mm at a walk and 30 at a run.
 */
const WALK_ROOT_PITCH = 0.02;
const RUN_ROOT_PITCH = 0.05;

/**
 * How far one leg's lowest shoe corner is below the hip joint.
 *
 * Full forward kinematics down the hip-knee-ankle-sole chain, composed in
 * exactly the order three composes it, and both of those words are load-bearing.
 *
 * The obvious closed form -- `stretch * (THIGH*cos(hip) + SHIN*cos(hip+knee))`
 * plus a rotated foot -- is what the first two versions of this used and it is
 * wrong by up to 2 cm at a walk and 9 at a sprint, always in the direction that
 * puts a shoe through the footpath. Three things defeat it, and only the last is
 * subtle:
 *
 *   - The two legs sit at `+theta` and `-theta` but carry the same *backward*
 *     knee bend, so the forward leg's shin is nearer vertical and reaches lower
 *     than the symmetric form predicts.
 *   - A foot pitched for a heel strike hangs its heel well below its own joint,
 *     so the ankle is not the lowest point of a leg and cannot stand in for it.
 *   - **The stance stretch is anisotropic and is applied at the hip.** A bone's
 *     matrix is `T * R * S`, so the hip's `scale.y` scales everything below it
 *     along the *hip's* local Y -- which after the knee has bent is not along
 *     the shin, and after the ankle has pitched is not along the foot. Modelling
 *     it as "the leg is `k` times longer" is right for the thigh and wrong for
 *     everything past the knee, by `SHIN * sin(knee) * sin(hip) * (k - 1)` and a
 *     larger term on the foot. Composing the chain instead makes the question
 *     disappear.
 */
export function soleDrop(hipAngle: number, kneeAngle: number, ankleAngle: number, stretch: number): number {
  const ca = Math.cos(ankleAngle);
  const sa = Math.sin(ankleAngle);
  const ck = Math.cos(kneeAngle);
  const sk = Math.sin(kneeAngle);
  const ch = Math.cos(hipAngle);
  const sh = Math.sin(hipAngle);

  let deepest = -Infinity;
  for (const cornerZ of [FOOT_HEEL, FOOT_TOE]) {
    // The sole corner in the ankle bone's own frame.
    const vy = -FOOT_DROP;
    const vz = cornerZ;
    // -> the knee's frame: the ankle bone is `T(0, -SHIN, 0) * R_ankle`.
    const qy = -SHIN_LENGTH + (vy * ca - vz * sa);
    const qz = vy * sa + vz * ca;
    // -> the hip's frame: the knee bone is `T(0, -THIGH, 0) * R_knee`.
    const ry = -THIGH_LENGTH + (qy * ck - qz * sk);
    const rz = qy * sk + qz * ck;
    // -> relative to the hip joint: the hip bone is `T(rest) * R_hip * S`, and
    // `S` is where the anisotropy lives.
    const y = (ry * stretch) * ch - rz * sh;
    deepest = Math.max(deepest, -y);
  }
  return deepest;
}

/**
 * One stride cycle's worth of legs. Returns the body bob, in metres.
 *
 * `kneeGain` is how hard the swing leg folds and `ankleBias` how much the foot
 * points on the drive -- the two numbers that separate a walk from a run once
 * the hip amplitude is decided by `hipSwing`. `extraStretch` is a constant
 * lengthening multiplied on top of the stance compensation, which is how the run
 * gets its longer legs.
 *
 * The bob and the stretch are computed once for *both* legs rather than per leg,
 * and that is exact rather than an approximation: the two legs are half a cycle
 * apart, so their hip angles are `+theta` and `-theta`, and both `cos` and
 * `sec` are even. One number serves both, always.
 */
function legPair(
  out: Pose, phase: number, swing: number, kneeGain: number, ankleBias: number, extraStretch: number,
  rootPitch: number,
): number {
  const angles: Array<[number, number, number]> = [];

  for (const side of [-1, 1] as const) {
    const p = side < 0 ? phase : phase + Math.PI;
    const hip = side < 0 ? BONE.HIP_L : BONE.HIP_R;
    const knee = side < 0 ? BONE.KNEE_L : BONE.KNEE_R;
    const ankle = side < 0 ? BONE.ANKLE_L : BONE.ANKLE_R;
    const s = Math.sin(p);
    // The knee folds through the **swing** phase and stays out of the way
    // through stance, which is `cos` and not `sin` and is worth stating because
    // the quarter-cycle error is not obvious in a still: a knee that folds at
    // mid-stance is a leg collapsing under the body's weight, which reads as a
    // limp rather than as a bug. Stance is the half where the hip travels from
    // fully forward to fully back -- `p` in [pi/2, 3pi/2] -- so the fold has to
    // peak at `p = 0`, where the hip is vertical and the foot is halfway through
    // being carried past it. `max(0, ...)` because a knee has one direction and
    // a negative fold is a broken leg -- and it is also what makes the stance
    // leg's knee a *constant* -0.06 for the whole of stance, which the lift
    // below relies on.
    // **Squared**, and that is not a shaping choice. `max(0, cos p)` leaves the
    // knee's rate discontinuous where the fold starts: at a walk the phase
    // advances 0.30 rad a frame, so the knee opened 0.28 rad in a single frame
    // at the stance boundary -- and because the body's height is derived from
    // whichever foot is lowest, that snap moved the whole character 4.6 cm in
    // one frame, twice a stride. Squaring makes the derivative zero at the
    // crossing, which removes the pop and moves the deepest fold nearer
    // mid-swing, where a knee actually folds most.
    const f = Math.max(0, Math.cos(p));
    const fold = f * f;
    const hipAngle = s * swing;
    const kneeAngle = -0.06 - fold * kneeGain;
    // Toe **up** at heel strike and toe **down** at push-off, which is
    // `+s` and not `-s`: positive rotation about X swings a bone's children
    // forward, and a foot's children are its toes. The sign was the other way
    // round in the first version and it plantarflexed into the pavement at every
    // heel strike -- the character walked on its toes going forwards.
    const ankleAngle = s * 0.22 + ankleBias;
    rot(out, hip, hipAngle, 0, side * 0.035);
    rot(out, knee, kneeAngle, 0, 0);
    rot(out, ankle, ankleAngle, 0, 0);
    // `rootPitch` is folded in here and nowhere else: the hips bone is the
    // legs' parent, so its forward lean tilts the whole chain and therefore
    // changes how far the sole reaches -- 7 mm at a walk's 0.02 rad and 30 at a
    // run's 0.05, which is exactly the residual that was left in the footpath
    // once the chain itself was composed correctly.
    angles.push([hipAngle + rootPitch, kneeAngle, ankleAngle]);
  }

  // Stand on whichever foot is lower, which is what a person does.
  //
  // One `max` replaces the whole stance/swing bookkeeping: the lower sole is by
  // definition the one bearing weight, so tracking *it* keeps the character on
  // the ground at every phase and through every crossfade, including the ones
  // where the two clips disagree about which leg is which.
  const deepest = (k: number): number =>
    Math.max(
      soleDrop(angles[0][0], angles[0][1], angles[0][2], k),
      soleDrop(angles[1][0], angles[1][1], angles[1][2], k),
    );

  // Solve for the leg lengthening rather than writing a formula for it.
  //
  // The intent is fixed -- pay `STANCE_LENGTHEN` of the stride's drop by
  // lengthening the leg and the rest by lowering the body -- and the closed form
  // for it was written twice and was wrong both times, because it was derived
  // against a straight-leg model that the real chain (a permanently bent knee,
  // a pitching foot, an anisotropic scale) does not obey. At a walk it
  // over-compensated enough to *raise* the figure 5.5 cm at the stride extremes,
  // which is a walk with the bob upside down: a person is tallest at mid-stance
  // over a vertical leg, and this was tallest at full stride.
  //
  // `soleDrop` is exactly affine in the stretch -- the stretch multiplies one
  // term of one matrix -- so one secant step through two evaluations lands on
  // the answer rather than approaching it, and it stays correct if any of the
  // clip's angles ever change. Three evaluations of twenty flops each, per actor
  // per frame.
  const d1 = deepest(extraStretch);
  const probe = extraStretch * 0.1;
  const slope = deepest(extraStretch + probe) - d1;
  const target = HIP_HEIGHT + (1 - STANCE_LENGTHEN) * (d1 - HIP_HEIGHT);
  const lengthen = slope > 1e-6 ? extraStretch + (probe * (target - d1)) / slope : extraStretch;
  out.stretch[BONE.HIP_L] = lengthen;
  out.stretch[BONE.HIP_R] = lengthen;

  // The sole ends at `HIP_HEIGHT + lift - deepest`, and at rest it was at 0, so
  // the lift that puts it back is the difference: positive when the leg is
  // longer than rest, negative when it is swung and therefore shorter.
  return deepest(lengthen) - HIP_HEIGHT;
}

/** Arm swing keyed to the opposite leg. `bend` is the elbow's resting fold. */
function armSwing(out: Pose, side: number, s: number, amount: number, splay: number, bend: number): void {
  const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
  const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
  rot(out, shoulder, s * amount, 0, side * splay);
  // The elbow deepens as the arm comes forward and opens as it goes back, which
  // is what an arm does and what a constant bend conspicuously does not.
  rot(out, elbow, bend + Math.max(0, s) * bend * 0.55, 0, 0);
}

/**
 * Jump: tuck on the way up, reach on the way down.
 *
 * Driven by `air` -- seconds since leaving the ground -- rather than by vertical
 * velocity, which the actor is not given and should not need: the actor's
 * contract is position, yaw, speed and grounded, and reading a velocity would
 * couple this file to `controller.ts`'s state shape for one clip.
 *
 * `controller.ts` jumps at 7.1 m/s under 22.5 m/s^2, so the apex is at 0.32 s
 * and a flat-ground jump lasts 0.63 s. The tuck is therefore keyed to peak at
 * 0.3 s and unwind over the next third of a second, which lands the legs
 * straight and reaching about where the feet touch down.
 */
export const clipJump: Clip = (out, ctx) => {
  const rise = smoothstep(0, 0.16, ctx.air);
  const fall = smoothstep(0.34, 0.62, ctx.air);
  const tuck = rise * (1 - fall);

  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? BONE.HIP_L : BONE.HIP_R;
    const knee = side < 0 ? BONE.KNEE_L : BONE.KNEE_R;
    const ankle = side < 0 ? BONE.ANKLE_L : BONE.ANKLE_R;
    const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    // Legs: knees to the chest at the top, then straight and slightly ahead for
    // the landing.
    rot(out, hip, tuck * 0.95 + fall * 0.3, 0, side * (0.05 + tuck * 0.12));
    rot(out, knee, -0.08 - tuck * 1.5, 0, 0);
    rot(out, ankle, 0.18 + tuck * 0.3 - fall * 0.35, 0, 0);
    // Arms up and back at the launch -- the counterweight -- then out for balance.
    rot(out, shoulder, -1.75 * rise + fall * 1.05, 0, side * (0.16 + tuck * 0.3 + fall * 0.45));
    rot(out, elbow, 0.35 + tuck * 0.5, 0, 0);
  }

  rot(out, BONE.HIPS, tuck * 0.18, 0, 0);
  rot(out, BONE.SPINE, tuck * 0.14 - fall * 0.06, 0, 0);
  rot(out, BONE.CHEST, tuck * 0.1 - fall * 0.05, 0, 0);
  rot(out, BONE.HEAD, -tuck * 0.12, 0, 0);
  // The whole figure curls up a little at the top of the arc.
  out.lift = tuck * 0.04;
};

// --- The swing ----------------------------------------------------------------

/**
 * Spec 8.2's envelope, in seconds, and the only place these three numbers appear.
 *
 * The names are the spec's and are kept although the weapon is no longer a fist:
 * the melee attack in this game is a **cricket bat** (see `player/bat.ts`), and
 * `PUNCH_WIND_UP` is the wind-up of a bat swing. Renaming them would touch the
 * protocol's button table, the server's simulation and its bots for a word, and
 * the one thing a shared constant must never become is a thing two processes
 * spell differently.
 *
 * The three windows themselves did not move, and that is a real decision rather
 * than an omission. 150/100/250 was chosen against how long a player will wait
 * between deciding and connecting; a bat is heavier than a fist and the honest
 * reading would stretch the wind-up, but the whole cycle is shared with
 * `server/sim.ts` through `game/combat.ts` and the rhythm is the thing spec 8.2
 * asks a player to learn. What the bat changes is the *reach* -- 1.2 m to 1.55 m
 * -- which is the number a longer weapon actually buys.
 */
export const PUNCH_WIND_UP = 0.15;
export const PUNCH_ACTIVE = 0.1;
export const PUNCH_RECOVERY = 0.25;
export const PUNCH_TOTAL = PUNCH_WIND_UP + PUNCH_ACTIVE + PUNCH_RECOVERY;

/** Which arm swings. Right-handed, and the mirror is one sign. */
const PUNCH_SIDE = 1;

/**
 * Wind-up, 150 ms: the backlift. The shoulder pulls back and out, the elbow
 * folds and the wrist cocks, which together take the blade up behind the ear.
 *
 * Eased on `t^0.6` rather than linearly, so most of the lift happens in the
 * first half of the window and the bat is *waiting* at the top of it. That is
 * the shape a wind-up needs: an anticipation that arrives early reads as a
 * decision, one that arrives late reads as slow. It matters more with a bat than
 * it did with a fist, because the thing an opponent has to read at fifteen
 * metres is a blade against the sky.
 */
export const clipPunchWindUp: Clip = (out, ctx) => {
  const k = Math.pow(clamp01(ctx.t), 0.6);
  punchPose(out, k, 0, 0);
};

/**
 * Active, 100 ms: the swing, down and across the body.
 *
 * This clip was a jab and is now a swing, and the reason is arithmetic rather
 * than taste. Every rotation from the shoulder to the blade is about the same
 * axis, so the direction the bat points is the *sum* of the shoulder, the elbow,
 * the wrist and the bat's own mounting angle -- `player/bat.ts` writes the
 * identity out. A bat held in a hand that throws a straight punch has that sum
 * running the wrong way at the moment of impact: the arm arrives extended
 * forward and the blade, mounted so it sits shouldered at rest, ends up pointing
 * back over the player's head. The fix is not a different mounting angle -- no
 * single angle satisfies both ends -- it is that the arm has to travel through
 * about 230 degrees, which is what a swing is and what a jab is not.
 *
 * **Most of that travel is in the wrist, and that is deliberate.** The wrist
 * carries 2.7 rad across the swing, which on a person would be an injury. It is
 * free here for a reason peculiar to this figure: the hand is a single
 * near-symmetric lobe (`character.MITT_RADII`), so rotating the wrist is
 * invisible on the hand and is the entire arc of the bat. It is the rig's
 * cheapest joint and the one with the most to say.
 *
 * The arm still stretches, at **1.10x** rather than the punch's 1.30x, and the
 * reduction is not a softening of the gag. A skinned noodle arm can smear; a
 * rigid prop parented to the wrist cannot, and it inherits the stretch as a
 * *non-uniform* scale along the forearm axis -- which on a bat mounted across
 * that axis is not a smear but a shear, and a sheared bat reads as a bug. 1.05
 * per bone compounds to 1.10 at the wrist, which is enough lengthening to sell
 * the reach and little enough skew to be invisible on the blade.
 *
 * Eased on `t^0.45`, harder than the wind-up: the whole 100 ms is the strike and
 * the blade should be most of the way through in the first 30 of them.
 */
export const clipPunchActive: Clip = (out, ctx) => {
  const k = Math.pow(clamp01(ctx.t), 0.45);
  punchPose(out, 1 - k, k, 0);
};

/**
 * Recovery, 250 ms: the bat's own weight carries the follow-through past the
 * stopping point and back.
 *
 * `exp(-5.2 t) * cos(8.6 t)` is a damped oscillator sampled over the window, and
 * both constants are chosen against the 250 ms rather than to taste: the cosine
 * completes 1.09 cycles in 250 ms, so the arm crosses its rest pose once,
 * overshoots *behind* it by 11% at about 180 ms, and comes back -- one visible
 * wobble and not a shiver. The envelope leaves 4% at the end of the window,
 * which is under a degree and blends out invisibly.
 *
 * The stretch compresses to 0.97 as the arm gathers back, which is the same
 * settle one axis over and is what stops the recovery being a straight line.
 */
export const clipPunchRecovery: Clip = (out, ctx) => {
  const t = clamp01(ctx.t);
  const spring = Math.exp(-5.2 * t) * Math.cos(8.6 * t);
  punchPose(out, 0, Math.max(0, spring), Math.max(0, -spring));
};

/**
 * The three phases share one pose function so they cannot drift apart.
 *
 * `coil`, `strike` and `rebound` are the three shapes the body takes and every
 * phase is a weighted sum of them: wind-up is pure coil, active crossfades coil
 * to strike, recovery decays strike and lets rebound take the overshoot. Written
 * as three clips over one function rather than three independent poses because
 * the failure mode of independent poses is a discontinuity at a phase boundary,
 * where the arm jumps a few degrees at 150 ms and reads as a dropped frame.
 *
 * The swing is a **diagonal**, high-outside to low-inside, and the two channels
 * that make it one are the shoulder's Z and the shoulder's Y. Z splays the arm
 * out on the coil and sweeps it in across the body on the strike, so the blade
 * travels from over the right shoulder to past the left hip rather than
 * chopping down the centre line; Y turns the whole limb through the arc. A swing
 * with no lateral component is a chop, and a chop with a cricket bat lands with
 * the edge, which is both wrong and much less funny.
 */
function punchPose(out: Pose, coil: number, strike: number, rebound: number): void {
  const side = PUNCH_SIDE;
  const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
  const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
  const wrist = side < 0 ? BONE.WRIST_L : BONE.WRIST_R;
  const guardShoulder = side < 0 ? BONE.SHOULDER_R : BONE.SHOULDER_L;
  const guardElbow = side < 0 ? BONE.ELBOW_R : BONE.ELBOW_L;

  // The swinging arm. Coil takes it back, up and out and folds the elbow to 75
  // degrees; strike drives it forward, down and across and opens the elbow;
  // rebound gathers it a little past rest on the way home.
  rot(
    out,
    shoulder,
    coil * -1.3 + strike * 1.55 + rebound * -0.45,
    side * (coil * 0.24 - strike * 0.34),
    side * (0.16 + coil * 0.42 - strike * 0.34),
  );
  // The elbow folds hard on the backlift and comes back **straight** on the
  // strike, and that second half is the non-obvious one. A positive elbow bends
  // the forearm forward *from wherever the upper arm is pointing*, so with the
  // shoulder already swung to horizontal any bend left in the elbow at impact
  // aims the forearm at the sky -- which is what the first version of this did,
  // and it cost the swing 30 cm of reach that the hit test was already promising.
  rot(out, elbow, 0.12 + coil * 1.18 - strike * 0.02 + rebound * 0.7, 0, 0);
  // The wrist is the swing. See `clipPunchActive` for why it can carry this much.
  rot(out, wrist, coil * -0.62 + strike * 2.15 + rebound * -0.4, 0, 0);

  // The stretch, and its compression on the rebound. See `clipPunchActive` for
  // why it is 1.05 a bone rather than the punch's 1.14.
  const armStretch = 1 + strike * 0.05 - rebound * 0.03;
  out.stretch[shoulder] = armStretch;
  out.stretch[elbow] = armStretch;

  // The other arm comes up as a guard and stays there. A brawler that swings
  // with one arm and leaves the other hanging looks asleep.
  rot(out, guardShoulder, 0.45 + coil * 0.35 + strike * 0.15, 0, -side * 0.28);
  rot(out, guardElbow, 1.35 + coil * 0.3, 0, 0);

  // The body swings the bat. Hips lead, chest follows harder, head last -- and
  // the whole chain rotates *away* on the coil and *through* on the strike,
  // which is where the power reads from. The amplitudes are up on the punch's,
  // because a bat is swung from the hips and a jab is not.
  //
  // **The signs are the opposite of the punch's, and that was a bug rather than
  // a style.** `rot.y > 0` on the chest turns the shoulders to the character's
  // left, which brings the *right* shoulder forward -- so a right-handed strike
  // wants a positive Y and the punch had a negative one. It cost that clip a
  // hand's width of reach nobody had measured, because the punch bought its
  // distance back with a 1.30x arm stretch. A bat cannot: it is rigid, its reach
  // is the number `combat.REACH` promises, and `player/bat.ts`'s check reads the
  // blade's real position rather than taking the pose's word for it. Turning the
  // torso the right way is worth 0.2 m of that.
  rot(out, BONE.HIPS, 0.02, side * (strike * 0.22 - coil * 0.28), 0);
  rot(out, BONE.SPINE, coil * 0.05, side * (strike * 0.2 - coil * 0.24), 0);
  rot(out, BONE.CHEST, coil * -0.12 + strike * 0.2, side * (strike * 0.28 - coil * 0.32), 0);
  // The head holds its line while the shoulders turn under it, which is what a
  // person swinging at something does and is the difference between a swing and
  // a spin. These two are the chest's rotation partly cancelled, not a look of
  // their own.
  rot(out, BONE.NECK, 0, side * (coil * 0.12 - strike * 0.1), 0);
  rot(out, BONE.HEAD, coil * 0.06 + strike * -0.05, side * (coil * 0.16 - strike * 0.12), 0);
}

// --- Reactions ----------------------------------------------------------------

export const FLINCH_DURATION = 0.38;

/**
 * Flinch: a head-and-torso recoil with a fast attack and a slow release.
 *
 * The envelope is the clip. 55 ms to full and 320 ms back, which is a 6:1 ratio
 * -- the same asymmetry as an impact sound, and for the same reason: what reads
 * as "hit" is the *rate* of the first movement, not how far it goes. A
 * symmetrical bump of the same amplitude reads as a nod.
 */
export const clipFlinch: Clip = (out, ctx) => {
  const t = clamp01(ctx.t) * FLINCH_DURATION;
  const k = t < 0.055 ? smoothstep(0, 0.055, t) : 1 - smoothstep(0.055, FLINCH_DURATION, t);
  // A small counter-wobble on the way out, so the recovery is not a straight line.
  const wobble = Math.exp(-7 * t) * Math.sin(21 * t) * 0.25;

  rot(out, BONE.HIPS, k * -0.06, k * 0.06, 0);
  rot(out, BONE.SPINE, k * -0.16 + wobble * 0.1, k * 0.1, k * 0.05);
  rot(out, BONE.CHEST, k * -0.24 + wobble * 0.14, k * 0.14, k * 0.07);
  rot(out, BONE.NECK, k * -0.28, k * 0.1, 0);
  rot(out, BONE.HEAD, k * -0.5 + wobble * 0.3, k * 0.22, k * 0.14);

  // Both arms fly up and out. This is the recoil, not a guard -- the elbows open
  // rather than close, which is what an unbraced body does when it is hit.
  for (const side of [-1, 1] as const) {
    const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    rot(out, shoulder, k * -0.55, 0, side * (0.12 + k * 0.5));
    rot(out, elbow, 0.14 + k * 0.35, 0, 0);
  }
  rot(out, BONE.KNEE_L, -0.05 - k * 0.28, 0, 0);
  rot(out, BONE.KNEE_R, -0.05 - k * 0.24, 0, 0);
  out.lift = k * -0.05;
};

/**
 * How long the throw overlay runs, seconds.
 *
 * 0.34 s, and it is a **presentation** number rather than a simulation one --
 * `combat.BALL_COOLDOWN` is 0.55 s, so the arm is home with a fresh ball in it a
 * fifth of a second before another throw is allowed. That ordering is
 * deliberate: an animation still running when the weapon is ready would make the
 * weapon feel slower than it is, and that is the one direction this kind of
 * error must not fall. `world/footyball.ts` restates it for the viewmodel.
 *
 * There is **no wind-up**, which is the whole difference between this clip and
 * the swing next to it. `combat.advance` puts the ball in the air on the tick
 * the button goes down, because a throw that waited 150 ms to spawn could not be
 * predicted -- the client would have to guess whether the server was going to
 * allow it. So the pose starts at the release and the clip is a follow-through:
 * `t = 0` is the instant the ball leaves the hand.
 */
export const THROW_DURATION = 0.34;

/**
 * The throw: a chest-high launch off the left hand and the follow-through after
 * it.
 *
 * An overhead handball rather than a drop punt, and that is forced by the rig
 * and by the bat. Spec 8.1's figure has one pair of noodle arms and
 * `player/bat.ts` has permanently occupied the right one with a 0.83 m blade, so
 * the ball is in the **left** hand and the throw has to be a one-armed action
 * that never asks the right arm for anything. A punt would also need the legs,
 * which are busy carrying a player who is usually running when they throw.
 *
 * The shape is three overlapping things, and they are staged rather than
 * simultaneous because a limb that starts and stops with the body reads as a
 * mannequin:
 *
 *   - **The left arm extends and follows through**, hardest in the first 40% of
 *     the window, then relaxes back. It is already extended at `t = 0` -- see
 *     `THROW_DURATION` on why there is no wind-up -- so the clip opens at the
 *     top of the action and the interest is all in the settle.
 *   - **The torso counter-rotates.** A right-handed figure throwing with the
 *     left hand turns their shoulders *clockwise* seen from above, which is a
 *     negative Y on the chest by `punchPose`'s own sign convention -- the one
 *     that file records as having been a bug in the punch for months.
 *   - **The right arm braces.** The bat comes across the body rather than
 *     hanging, which is what a person carrying something heavy does when they
 *     throw with the other hand, and it keeps the blade out of the left arm's
 *     arc.
 *
 * The easing is `1 - (1-t)^3` on the way out and a damped cosine on the way
 * back, so the arm snaps to full extension in the first 80 ms and drifts home
 * over the remaining 260 -- the same asymmetry `clipPunchActive` uses and for
 * the same reason.
 */
export const clipThrow: Clip = (out, ctx) => {
  const t = clamp01(ctx.t);
  // The launch: 1 at the release, decaying to 0 across the window.
  const launch = Math.exp(-4.6 * t);
  // The follow-through: 0 at the release, peaking a third of the way in, gone
  // by the end. This is what carries the arm *past* the release point.
  const follow = Math.sin(Math.PI * clamp01(t * 1.15)) * (1 - t * 0.4);

  // The throwing arm. Shoulder forward and up, elbow nearly straight at the
  // release and folding as it comes home, wrist snapping over the top -- which
  // on this rig is the whole of the gesture, for `clipPunchActive`'s reason:
  // the mitt is a near-symmetric lobe, so a wrist rotation is invisible on the
  // hand and is entirely the arc of whatever it is holding.
  rot(out, BONE.SHOULDER_L, 1.45 * launch + 0.55 * follow, 0, -0.22 * launch - 0.3 * follow);
  rot(out, BONE.ELBOW_L, 0.12 + 0.18 * launch + 0.9 * follow, 0, 0);
  rot(out, BONE.WRIST_L, -0.9 * launch + 0.35 * follow, 0, 0);
  // A touch of stretch through the release, on `clipPunchActive`'s 1.05-a-bone
  // budget rather than the old punch's 1.14: the ball is a rigid prop parented
  // to the wrist and inherits the stretch as a non-uniform scale, which on a
  // spheroid is a visible squash rather than a smear.
  out.stretch[BONE.SHOULDER_L] = 1 + 0.05 * launch;
  out.stretch[BONE.ELBOW_L] = 1 + 0.05 * launch;

  // The bracing arm, holding the bat across the body and out of the way.
  rot(out, BONE.SHOULDER_R, 0.3 + 0.45 * launch, 0, 0.34 + 0.2 * launch);
  rot(out, BONE.ELBOW_R, 1.1 + 0.35 * launch, 0, 0);

  // The body throws the ball. Hips lead a little, chest turns hardest, head
  // holds its line -- the same chain `punchPose` builds, mirrored, because this
  // is the other arm. Negative Y turns the shoulders clockwise from above,
  // which brings the *left* shoulder forward.
  rot(out, BONE.HIPS, 0.02 * launch, -0.18 * launch, 0);
  rot(out, BONE.SPINE, 0.08 * launch, -0.2 * launch, 0);
  rot(out, BONE.CHEST, 0.14 * launch - 0.06 * follow, -0.3 * launch, 0);
  // The neck and head partly cancel the chest, so the figure keeps looking at
  // what it threw at rather than turning away from it.
  rot(out, BONE.NECK, -0.04 * launch, 0.12 * launch, 0);
  rot(out, BONE.HEAD, -0.06 * launch, 0.16 * launch, 0);
};

export const KNOCKOUT_DURATION = 0.8;

/**
 * Knockout: a canned crumple, and deliberately **not** a ragdoll.
 *
 * Spec 8.2 asks for a ragdoll on knockout and this is not one. Real ragdoll is
 * the punch project's problem -- it needs a constrained body solver, a collision
 * representation for a character that today has none, and a decision about what
 * happens when a limb ends up inside a terrace. What that project needs *from
 * here* is a pose it can either drive to or replace, and this is that pose: one
 * function of `t` in [0, 1] that ends with the figure on the ground and holds.
 *
 * The collapse is backward, folding at the knees first and the hips second,
 * which is the order a body actually goes down in -- the legs stop holding
 * before the spine stops trying. Three eases, all on the same `t`, staggered:
 * the knees are gone by 40% of the clip, the hips by 75%, and the head lolls
 * last. `lift` drops 0.30 m over the same window, and that number is *measured*
 * rather than chosen: the rotations alone leave the crumpled figure's lowest
 * vertex 0.295 m above the mesh origin, so 0.30 is what puts the heap on the
 * pavement instead of hovering over it or sinking into it. It leaves the crown
 * at 0.76 m -- a body on its back with one knee still up, which is the shape a
 * person makes when their legs go before their spine does. `verifyCharacterRig`
 * skins the mesh on the CPU and asserts both ends of that.
 *
 * The overshoot at the end is the bounce. `sin(pi * t) * exp(-3.4 t)` on the
 * hips adds a settle that stops the body arriving at its final pose and simply
 * stopping, which is the tell that gives away a canned animation.
 */
export const clipKnockout: Clip = (out, ctx) => {
  const t = clamp01(ctx.t);
  const knees = smoothstep(0, 0.4, t);
  const hips = smoothstep(0.12, 0.75, t);
  const head = smoothstep(0.3, 1, t);
  const settle = Math.sin(Math.PI * t) * Math.exp(-3.4 * t);

  // Backward over the heels. The hips carry the whole figure, so this is the
  // rotation that lays the character out.
  rot(out, BONE.HIPS, hips * 1.35 + settle * 0.12, hips * 0.22, hips * 0.3);
  rot(out, BONE.SPINE, hips * 0.2 - settle * 0.1, hips * -0.12, hips * -0.16);
  rot(out, BONE.CHEST, hips * 0.15, hips * -0.18, hips * -0.2);
  rot(out, BONE.NECK, head * 0.25, head * 0.12, head * 0.18);
  // The head is 30% of the figure and it is what sells the crumple: it lolls
  // furthest, last, and keeps moving after everything else has stopped.
  rot(out, BONE.HEAD, head * 0.55 + settle * 0.25, head * 0.3, head * 0.4);

  // Knees fold under, one further than the other -- a symmetrical collapse reads
  // as a controlled squat.
  rot(out, BONE.HIP_L, knees * -0.55, 0, -0.1 - knees * 0.25);
  rot(out, BONE.KNEE_L, -knees * 2.1, 0, 0);
  rot(out, BONE.ANKLE_L, knees * 0.6, 0, 0);
  rot(out, BONE.HIP_R, knees * -0.35, 0, 0.1 + knees * 0.4);
  rot(out, BONE.KNEE_R, -knees * 1.75, 0, 0);
  rot(out, BONE.ANKLE_R, knees * 0.45, 0, 0);

  // Arms go limp: out to the sides, elbows nearly straight, no guard left.
  rot(out, BONE.SHOULDER_L, hips * -0.7, 0, -(0.12 + hips * 0.85));
  rot(out, BONE.ELBOW_L, 0.1 + hips * 0.2, 0, 0);
  rot(out, BONE.SHOULDER_R, hips * -0.55, 0, 0.12 + hips * 1.0);
  rot(out, BONE.ELBOW_R, 0.1 + hips * 0.15, 0, 0);

  // Down onto the ground. Measured rather than chosen -- see the header, and
  // `verifyCharacterRig`, which skins every vertex on the CPU and asserts that
  // the crumpled figure's crown ends under 1.05 m and that nothing sinks more
  // than a shoe's depth into the pavement.
  out.lift = -0.3 * hips + settle * 0.04;
};

// --- The ride -----------------------------------------------------------------

/**
 * How long the pose takes to blend in when you get on a bike. Seconds.
 *
 * Not a clip length: `clipRide` holds forever, exactly as `clipKnockout` does,
 * and this is only the window `CharacterActor` fades it in over. Slower than an
 * impact overlay's 0.07 because getting on a bike is not an impact -- a snap
 * from a run into a seated pose reads as a glitch, and a fifth of a second reads
 * as swinging a leg over.
 */
export const RIDE_BLEND = 0.2;

/**
 * Where the saddle and the handlebars are, in metres above the sole and forward
 * of it. **`world/bike.ts` builds its mesh to these numbers.**
 *
 * The dependency runs this way round on purpose. The rig is fixed -- the hips
 * are at 0.86, the arm is 0.64 m long, and no amount of wanting changes where a
 * seated figure's hands end up -- so the honest order is to pose the rider from
 * the rig and then build the bike under the pose. The other way round produces
 * either a rider whose hands are 10 cm off the bars or a pose contorted to reach
 * a saddle somebody drew first, and both of those are visible from across a
 * street.
 *
 * `HIP_HEIGHT` is 0.815 and the hips bone sits at 0.86, so a rider whose pose
 * has no lift in it is already sitting at saddle height: the character's mesh
 * origin is its sole, and while riding that origin is on the ground under the
 * bike. That is why this clip's `lift` is nearly zero -- it is a couple of
 * centimetres of settle into the seat and nothing else.
 */
export const SADDLE_Y = 0.86;
export const SADDLE_Z = 0.12;
/**
 * The grips. **Solved from the rig rather than chosen**, which is the whole
 * point of the paragraph above and is worth recording because the first attempt
 * at these numbers was 0.15 m out.
 *
 * A hand cannot go anywhere the arm reaches: the shoulder joint ends up at
 * (y 1.13, z +0.07) once the torso lean is applied, the arm is 0.64 m long, and
 * sweeping the two arm angles over their whole range puts the wrist between
 * z -0.53 and -0.55 for every pose that is not a straight-armed lunge. So the
 * bars are at -0.55 because that is where the hands are, and `world/bike.ts`
 * draws them there. Asking for -0.70 -- which is what a drawing of a bike would
 * suggest -- gives a rider whose hands hang 15 cm short of their own
 * handlebars, and `verifyCharacterRig` is what said so.
 */
export const BAR_Y = 1.08;
export const BAR_Z = -0.55;
/** Half the bar's width, from the same solve: the wrists sit at x = +/-0.31. */
export const BAR_HALF_WIDTH = 0.31;
/**
 * Where the feet sit, which is where `world/bike.ts` puts the bottom bracket.
 * The ankle *joint*, solved the same way -- the sole is about 6 cm under it.
 */
export const PEDAL_Y = 0.27;
export const PEDAL_Z = -0.16;

/**
 * Seated on a lime e-bike: legs turning over, torso down over the bars.
 *
 * A **held whole-body clip** rather than a locomotion, and that is the one
 * structural decision here. The four locomotions crossfade against each other by
 * speed, and riding is not a speed -- a rider at 2 m/s pulling away from a kerb
 * and one at 26 m/s down Cleveland Street are in the same pose. So it enters
 * `CharacterActor` the way a knockout does: an overlay at full weight that holds
 * until something clears it, with the walk or run still running underneath and
 * completely masked. It costs the actor no new blend weight and no new branch in
 * `updateWeights`.
 *
 * The legs are driven by `ctx.stride`, which advances by **distance travelled**
 * rather than by time -- see `ClipContext`. That is exactly the property a bike
 * wants and it comes for free: the cranks turn faster the faster you are going,
 * they stop dead when you stop, and the phase is continuous through an
 * acceleration. The amplitude is small (0.34 rad at the hip) because a pedal
 * stroke is a much shorter arc than a stride, and the two legs are half a cycle
 * apart, which is what a crank is.
 *
 * The arms reach *down and forward* to `BAR_Y`/`BAR_Z` with a fair amount of
 * elbow, which on this rig's noodle arms is the pose that puts the mitts on the
 * grips. `character.ts`'s bat prop hangs off the right wrist and rides along with
 * it, which is the correct look -- one hand on the bar, bat still in it.
 */
export const clipRide: Clip = (out, ctx) => {
  // Half a cycle apart, and quarter-turn offset so neither leg is at top dead
  // centre when the bike is standing still with a rider on it.
  const crank = ctx.stride + Math.PI / 2;
  const sL = Math.sin(crank);
  const sR = Math.sin(crank + Math.PI);

  // The torso: down over the bars, most of it in the spine and chest rather than
  // the hips. `clipRun` makes the same split for the same reason -- leaning at
  // the hips takes the legs with it, and the legs here have somewhere to be.
  rot(out, BONE.HIPS, 0.14, 0, 0);
  rot(out, BONE.SPINE, 0.2, 0, 0);
  rot(out, BONE.CHEST, 0.16, 0, 0);
  // And the head back up, because a rider looks where they are going rather than
  // at the front hub. The sum of the three above, negated, plus a little.
  rot(out, BONE.NECK, -0.2, 0, 0);
  rot(out, BONE.HEAD, -0.3, 0, 0);

  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? BONE.HIP_L : BONE.HIP_R;
    const knee = side < 0 ? BONE.KNEE_L : BONE.KNEE_R;
    const ankle = side < 0 ? BONE.ANKLE_L : BONE.ANKLE_R;
    const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    const s = side < 0 ? sL : sR;

    // Thigh forward and up, knee deeply folded: the shape of a leg on a pedal
    // with the saddle at hip height. The three base angles put the ankle within
    // 2 mm of `PEDAL_Y`/`PEDAL_Z` -- solved against the real rig, not eyeballed.
    // The knee leads the hip through the stroke by a quarter cycle, which is what
    // stops the leg extending and retracting like a piston.
    rot(out, hip, 0.8 + s * 0.34, 0, side * 0.055);
    rot(out, knee, -1.44 + Math.cos(crank + (side < 0 ? 0 : Math.PI)) * 0.3, 0, 0);
    rot(out, ankle, -0.3 - s * 0.12, 0, 0);

    // Arms down and forward to the grips, elbows soft. The splay is wider than a
    // walk's because the bars are wider than the shoulders. These two land the
    // wrist on `BAR_Y`/`BAR_Z`; see there for why the bar moved to meet the hand
    // rather than the other way round.
    rot(out, shoulder, 0.85, 0, side * 0.2);
    rot(out, elbow, 0.3, 0, 0);
  }

  // A couple of centimetres into the seat. See `SADDLE_Y` for why this is not
  // the 30 cm a knockout needs: the rider is already at saddle height.
  out.lift = -0.02;
};

// --- The self-check -----------------------------------------------------------

/**
 * Every clip, stepped, with the two things that are silent when they break.
 *
 * A clip that does nothing is invisible: the character keeps whatever pose the
 * blend left it in and reads as "the animation is subtle" rather than as a
 * broken function. And a clip that writes a wild value is invisible in the
 * *code* -- it only shows up as a limb through a torso or a figure buried in the
 * footpath. Both are checked here, in the same spirit as
 * `verifyMovementBasis()`: pure, framework-free, and runnable in Node.
 *
 * Returns a list of complaints, empty when correct.
 */
export function verifyAnimation(): string[] {
  const failures: string[] = [];
  const pose = createPose();

  const cases: Array<[string, Clip, ClipContext]> = [
    ['idle', clipIdle, ctx({ time: 1.7 })],
    ['walk', clipWalk, ctx({ stride: 1.1, speed: 4.4 })],
    ['run', clipRun, ctx({ stride: 1.1, speed: 8.2 })],
    ['jump', clipJump, ctx({ air: 0.2 })],
    ['punch wind-up', clipPunchWindUp, ctx({ t: 1 })],
    ['punch active', clipPunchActive, ctx({ t: 1 })],
    ['punch recovery', clipPunchRecovery, ctx({ t: 0.15 })],
    ['flinch', clipFlinch, ctx({ t: 0.16 })],
    ['knockout', clipKnockout, ctx({ t: 1 })],
    // Two phases of the crank, because the ride pose is the only clip here whose
    // legs are driven by a cycle with no `t` in it -- a sign slip in the knee
    // term shows up at one phase and not the other, and the knee-fold assertion
    // below is what would catch it.
    ['ride', clipRide, ctx({ stride: 0.4, speed: 26 })],
    ['ride (half crank)', clipRide, ctx({ stride: 0.4 + Math.PI, speed: 26 })],
  ];

  for (const [name, clip, context] of cases) {
    resetPose(pose);
    clip(pose, context);

    let moved = 0;
    let worst = 0;
    for (let i = 0; i < pose.rot.length; i++) {
      const v = pose.rot[i];
      if (!Number.isFinite(v)) {
        failures.push(`Clip "${name}" wrote a non-finite rotation at index ${i}.`);
        break;
      }
      if (Math.abs(v) > 1e-4) moved++;
      worst = Math.max(worst, Math.abs(v));
    }
    // Six channels is three bones with something to say. Below that a clip is
    // not animating, it is twitching.
    if (moved < 6) {
      failures.push(
        `Clip "${name}" moved only ${moved} of ${BONE_COUNT * 3} rotation channels. ` +
          `A clip that writes nothing is invisible rather than broken, which is why this is checked.`,
      );
    }
    if (worst > Math.PI) {
      failures.push(
        `Clip "${name}" wrote a rotation of ${worst.toFixed(2)} rad. Nothing in this rig ` +
          `should exceed a half turn -- a knee that folds past pi is a leg through a shin.`,
      );
    }
    for (let b = 0; b < BONE_COUNT; b++) {
      const s = pose.stretch[b];
      if (!(s > 0.5 && s < 1.6)) {
        failures.push(
          `Clip "${name}" set ${RIG[b].name} stretch to ${s.toFixed(3)}. The comic range is ` +
            `0.94 to 1.14 per bone; outside 0.5-1.6 a limb has inverted or gone to infinity.`,
        );
      }
    }
    if (!(pose.lift > -0.8 && pose.lift < 0.3)) {
      failures.push(`Clip "${name}" lifted the figure by ${pose.lift.toFixed(3)} m, which is off the ground or under it.`);
    }
  }

  // Knees fold one way. This is the constraint most easily broken by a sign slip
  // in a clip, and it produces a leg bending forward at the knee -- which reads
  // as a bug instantly and would never be caught by an amplitude bound.
  for (const [name, clip, context] of cases) {
    resetPose(pose);
    clip(pose, context);
    for (const knee of [BONE.KNEE_L, BONE.KNEE_R]) {
      if (pose.rot[knee * 3] > 1e-3) {
        failures.push(
          `Clip "${name}" bent ${RIG[knee].name} forward by ${pose.rot[knee * 3].toFixed(3)} rad. ` +
            `A knee only folds backward, which in this rig is a negative rotation about X.`,
        );
      }
    }
  }

  // Spec 8.2's envelope, asserted rather than commented.
  if (Math.abs(PUNCH_WIND_UP - 0.15) > 1e-6 || Math.abs(PUNCH_ACTIVE - 0.1) > 1e-6 || Math.abs(PUNCH_RECOVERY - 0.25) > 1e-6) {
    failures.push(
      `The punch envelope is ${(PUNCH_WIND_UP * 1000).toFixed(0)}/${(PUNCH_ACTIVE * 1000).toFixed(0)}/` +
        `${(PUNCH_RECOVERY * 1000).toFixed(0)} ms; spec 8.2 says 150/100/250.`,
    );
  }

  // The no-slide arithmetic, across the speed range. `hipSwing` is the only
  // thing standing between this and a moonwalk, and it is one `asin` that would
  // silently clamp to nonsense if the rig's leg length ever changed. Checked
  // against the *effective* leg -- rest length times the stance lengthening --
  // because that is the leg the foot is actually on.
  for (const speed of [1.5, 4.4, 6.0, 8.2]) {
    const stride = strideLength(speed);
    const leg = LEG_LENGTH * STANCE_REACH;
    if (stride / (4 * leg) >= 0.93) continue; // clamped on purpose; see `hipSwing`
    const reach = 4 * leg * Math.sin(hipSwing(stride, leg));
    if (Math.abs(reach - stride) > 0.05) {
      failures.push(
        `At ${speed} m/s a stride of ${stride.toFixed(2)} m makes the foot travel ` +
          `${reach.toFixed(2)} m per cycle relative to the body. The two must match or the feet slide.`,
      );
    }
  }

  // The stance compensation has to cancel the drop, or the feet skim the
  // pavement at the ends of every stride. The residual is what the body bob is
  // for, so what is checked is that the two add up rather than that either is
  // any particular size.
  // The lower foot has to be exactly on the ground at every phase, or the
  // character skims the footpath at some part of its stride and plants at
  // others. Swept over a whole cycle rather than checked at the extremes,
  // because the first version of this was right at the extremes and 3 cm wrong
  // in between.
  for (const [name, clip, speed] of [['walk', clipWalk, 4.4], ['run', clipRun, 8.2]] as const) {
    let worst = 0;
    for (let i = 0; i < 128; i++) {
      resetPose(pose);
      clip(pose, ctx({ stride: (i / 128) * Math.PI * 2, speed }));
      let lowest = Infinity;
      for (const [hip, knee, ankle] of [
        [BONE.HIP_L, BONE.KNEE_L, BONE.ANKLE_L],
        [BONE.HIP_R, BONE.KNEE_R, BONE.ANKLE_R],
      ] as const) {
        const drop = soleDrop(
          pose.rot[hip * 3] + pose.rot[BONE.HIPS * 3],
          pose.rot[knee * 3],
          pose.rot[ankle * 3],
          pose.stretch[hip],
        );
        lowest = Math.min(lowest, HIP_HEIGHT + pose.lift - drop);
      }
      worst = Math.max(worst, Math.abs(lowest));
    }
    if (worst > 0.003) {
      failures.push(
        `Over a "${name}" cycle the lower shoe strays ${(worst * 100).toFixed(1)} cm from the ground. ` +
          `It must stay on it: that is the whole job of the stance lengthening and the body bob in ` +
          `\`legPair\`, and a centimetre of it is a foot through the footpath.`,
      );
    }
  }

  return failures;
}

/** A `ClipContext` with everything defaulted, so a case only states what it uses. */
function ctx(partial: Partial<ClipContext>): ClipContext {
  return { time: 0, stride: 0, speed: 0, air: 0, t: 0, ...partial };
}
