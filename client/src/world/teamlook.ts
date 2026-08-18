/**
 * Teams, as things you can see: the tint, the horns, the cactus, the rings and
 * the sausage-sizzle tent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR.
 *
 * `game/teams.ts` is a contract with two names on it and forty-two nodes. The
 * player never reads it. What a player reads is a street: somebody in teal
 * coming round a corner, somebody with horns, somebody who is a cactus, a faint
 * ring on the footpath that says two of them are buffing each other, and a red
 * gazebo in a car park that means the other side has just spent two hundred
 * dollars on being unkillable for a minute. This file is the whole of that, and
 * it is deliberately the *only* place in the client that turns a team into
 * geometry.
 *
 * ---------------------------------------------------------------------------
 * THE MATERIAL BUDGET, which is the constraint everything below is shaped by.
 *
 * `player/character.ts` states this project's hardest rendering rule at length
 * and `world/vegetation.ts`, `world/cars.ts` and `world/birds.ts` each restate
 * it: **a material is a WebGPU pipeline and pipeline compilation blocks the main
 * thread.** Seven colourways were baked into vertex colours rather than seven
 * materials precisely so a match starting does not compile seven shaders.
 *
 * A team look that added a material per team, or per Big Night kit, or one for
 * the tent, would put four to six compiles back -- and worse, it would put them
 * on the frames a *mega fires* and somebody's body changes, which is the single
 * worst moment in the session to drop 200 ms. So:
 *
 *   - **The tint is a colour attribute.** A teamed player draws the same figure
 *     from a geometry that differs only in its `color` buffer, exactly as the
 *     seven kits already do. `CharacterAssets.kitGeometry` was built to be
 *     called with an arbitrary kit and this is its second caller (the first is
 *     the police uniform). Fourteen extra geometries at 5 kB each, one material,
 *     zero new pipelines.
 *   - **The cactus is another geometry on the same skeleton and the same
 *     material.** Which is what makes "every animation still works" true by
 *     construction rather than by re-authoring: it is bound to the same
 *     seventeen bones with the same two-influence weights, so `CharacterActor`
 *     does not know it happened. Swapping a body is `mesh.geometry = ...`.
 *   - **The horns and the tent share one material with the characters** -- the
 *     same `MeshStandardNodeMaterial`, vertex-coloured and flat-shaded -- and
 *     one geometry *layout* with each other (position, normal, colour, no skin
 *     attributes), so between them they are one extra pipeline family rather
 *     than two. `teamLookWarmupParts` puts it behind the loading screen.
 *   - **The rings are the one new material**, and they have to be: they are
 *     additive, unlit and depth-write-off, which is not a state any existing
 *     material in this client is in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HORNS ARE PARENTED AND THE CACTUS IS NOT.
 *
 * Two Big Night kits, two different mechanisms, and the asymmetry is the whole
 * design rather than an accident of who wrote which one.
 *
 * Horns are an *addition*: the Marita body is unchanged underneath and two horns
 * sit on the skull. That is `player/bat.ts`'s situation exactly -- a rigid prop
 * that follows one bone -- and its answer is the right one here: parent a plain
 * `Mesh` to `actor.bones[BONE.HEAD]` and let three compose the skeleton it was
 * going to compose anyway. No skinning, no per-frame matrix decompose, and the
 * horns are correct in a knockout, on a bike and mid-punch for free.
 *
 * A cactus is a *replacement*: the brief says the torso and limbs become cactus
 * segments and the head stays. Parenting seven props to seven bones would be
 * seven draw calls per player and would leave the original arm inside the new
 * one. So it is one skinned geometry that replaces the body's -- one draw call,
 * one swap, and the arms cannot be inside anything because there is only one
 * arm.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY EYES CAN JUDGE. Three things, and they are named here so nobody
 * mistakes a passing check for a passing look: **the cactus silhouette** at
 * distance (does a green figure with paddle arms still read as a person, or as a
 * bush), **the horn placement** against the skull from behind and in a knockout,
 * and **the tint's readability on each of the seven colourways** in shade. The
 * numbers behind all three are checked -- triangle budgets, bounds, and the
 * singlet-against-shorts separation in `game/teamlook.verifyTeamLook` -- and
 * none of the three is a number.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Sphere,
  Vector3,
} from 'three/webgpu';

import { BONE, FOOT_HALF_WIDTH, FOOT_HEEL, FOOT_THICKNESS, FOOT_TOE } from '../player/animation.ts';
import {
  COLOURWAYS,
  LIMB_SIDES,
  Parts,
  ROLE,
  SELF_SHADOW_LAYER,
  roleColour,
  w1,
  w2,
  type CharacterActor,
  type CharacterAssets,
  type Colourway,
  type Point,
  type Role,
} from '../player/character.ts';
import {
  AURA_RING_M,
  GROUP_RING_M,
  MAX_RINGS,
  RING_ALPHA,
  RING_THICKNESS,
  TENT,
  TENT_RED,
  TENT_WHITE,
  TRI_BUDGET,
  hexToLinear,
  ringAlpha,
  slamRing,
  teamKit,
  type Rgb,
} from '../game/teamlook.ts';
import { TEAM, TEAM_COLOUR, TEAM_NAME, type Team } from '../game/teams.ts';
import { verifyTeamView } from './teamview.ts';
import type { WarmupPart } from './warmup.ts';

const TAU = Math.PI * 2;

// --- Building geometry out of `Parts` -------------------------------------------------

/**
 * A `Parts` with a colour per vertex, and the two ways of filling it in.
 *
 * `Parts` records a *role* per vertex, which is exactly right for a wardrobe --
 * seven kits over one buffer -- and exactly wrong for a horn, whose whole look
 * is a gradient along its own length, and for a striped valance, where the
 * stripe is the geometry. So this wrapper carries a parallel colour array and
 * offers both: `fill` paints everything appended since the last `fill`, and
 * `fromRoles` runs the wardrobe's own `roleColour` over the lot.
 *
 * The `fill` idiom -- build a piece, then say what colour it was -- is chosen
 * over passing a colour into every call because the builders below are
 * `Parts`' own methods and cannot take one. It is checked: `geometry` throws if
 * a vertex was left unpainted, which is the one mistake this arrangement makes
 * easy and which would otherwise ship a black horn.
 */
class Painted {
  readonly parts = new Parts();
  private readonly colour: number[] = [];

  /** How many vertices exist so far. */
  get count(): number {
    return this.parts.position.length / 3;
  }

  /** Paint every vertex appended since the last `fill`. */
  fill(rgb: Rgb): void {
    while (this.colour.length < this.parts.position.length) {
      this.colour.push(rgb[0], rgb[1], rgb[2]);
    }
  }

  /** Paint everything from the vertex roles and a kit, the wardrobe's way. */
  fromRoles(kit: Colourway): void {
    for (let i = this.colour.length / 3; i < this.count; i++) {
      const c = roleColour(kit, this.parts.role[i]);
      this.colour.push(c[0], c[1], c[2]);
    }
  }

  /**
   * The geometry.
   *
   * `skinned` decides whether the bone attributes are attached, and it is the
   * one thing about this that matters for cost: a mesh with `skinIndex` and
   * `skinWeight` is a different pipeline from one without, so the horns and the
   * tent deliberately go out *without* them and share a key, while the cactus
   * goes out with them and shares the character's.
   */
  geometry(name: string, skinned: boolean): BufferGeometry {
    if (this.colour.length !== this.parts.position.length) {
      throw new Error(`teamlook: ${name} left ${(this.parts.position.length - this.colour.length) / 3} vertices unpainted`);
    }
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.parts.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.parts.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colour), 3));
    if (skinned) {
      g.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(this.parts.skinIndex), 4));
      g.setAttribute('skinWeight', new BufferAttribute(new Float32Array(this.parts.skinWeight), 4));
    }
    g.setIndex(new BufferAttribute(new Uint16Array(this.parts.index), 1));
    g.computeBoundingSphere();
    return g;
  }

  /**
   * A flat quad, wound to face the normal its own corners imply.
   *
   * The normal is **derived rather than passed**, and that is a correctness
   * decision rather than a convenience: `verifyBigNightKit` checks every
   * triangle against the mean of its vertices' stored normals -- the test
   * `verifyCharacterRig` runs, which is the README's winding audit applied to
   * client geometry -- so a hand-written normal that disagreed with the corner
   * order would fail that check rather than quietly draw an invisible panel.
   * Deriving it makes the two agree by construction and leaves the check
   * measuring what it is really for, which is the *order of the corners*.
   */
  quad(a: Point, b: Point, c: Point, d: Point, role: Role): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const n: Point = [nx, ny, nz];
    const base = this.count;
    // Rigid to nothing in particular: every caller of `quad` is a static prop,
    // and a static prop's geometry is never handed to a `SkinnedMesh`. The
    // binding is still written because `Parts.vertex` demands one and a
    // zero-weight second slot would not sum to 1.
    const skin = w1(0);
    for (const p of [a, b, c, d]) this.parts.vertex(p, n, role, skin);
    this.parts.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// --- The team tint ----------------------------------------------------------------------

/**
 * A `Colourway` for a base kit in a team's colours, named so a geometry can be
 * told apart in a scene dump.
 *
 * The colour decisions are all in `game/teamlook.teamKit`, which is three-free
 * and therefore checkable in Bun; this adds nothing but the name. That split is
 * the point -- the thing that can be wrong here is a *measurement*, and a
 * measurement in a file that imports three cannot be run in the server's boot
 * list.
 */
export function teamColourway(base: Colourway, team: Team): Colourway {
  if (team === TEAM.NONE) return base;
  return { name: `${base.name}:${TEAM_NAME[team]}`, ...teamKit(base, team) };
}

// --- The Big Night kits -------------------------------------------------------------------

/** Two keratin colours, base to tip. Linear, and both are darker than any skin in the wardrobe. */
const HORN_BASE: Rgb = [0.028, 0.021, 0.016];
const HORN_TIP: Rgb = [0.30, 0.26, 0.20];

/** The cactus's flesh, its ribs, its spines. Linear. */
const CACTUS_FLESH: Rgb = [0.055, 0.20, 0.075];
const CACTUS_RIB: Rgb = [0.10, 0.30, 0.11];
const CACTUS_SPINE: Rgb = [0.72, 0.70, 0.58];

/**
 * Two horns, in the head bone's own frame.
 *
 * Everything here is local to that bone, which is why the numbers look 1.25 m
 * lower than the ones in `character.ts`: `HEAD_CENTRE` is at world 1.445 in the
 * bind pose and the bone is at 1.25, so the skull's centre is at local y 0.195
 * and its crown at 0.445.
 *
 * The base is set at local y 0.36 on each side, which is a little *inside* the
 * ellipsoid rather than tangent to it -- at x 0.115 the skull's surface is at
 * local y 0.391 -- because a horn whose first ring exactly touches the surface
 * shows a seam the moment the head turns and the flat-shaded facets disagree.
 * Sinking it 3 cm costs nothing and is what every other prop in this client
 * does where two procedural solids meet.
 *
 * The curve is up, out and **back**, in that order of magnitude. Forward-curling
 * horns were tried on paper and rejected for a reason specific to this game:
 * the camera is behind the player in third person and at the player's eye in
 * first, so a horn that curls forward is either in front of your own face or
 * hidden by your own head, and the one view it reads in is the one nobody has.
 * Curling back puts the whole silhouette against the sky from behind, which is
 * the view a Marita is most often seen from -- by somebody chasing them.
 */
function buildHorns(): Painted {
  const p = new Painted();
  const segments = 5;
  const sides = 6;
  for (const side of [-1, 1] as const) {
    const at = (t: number): Point => [
      side * (0.115 + 0.085 * t + 0.05 * t * t),
      0.36 + 0.20 * t - 0.03 * t * t,
      -0.01 + 0.02 * t + 0.075 * t * t,
    ];
    const radius = (t: number): number => 0.036 * (1 - t) * (1 - 0.3 * t) + 0.004;
    for (let s = 0; s < segments; s++) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      const before = p.count;
      p.parts.tube(at(t0), at(t1), radius(t0), radius(t1), sides, ROLE.SKIN, w1(0));
      // The gradient, a ring at a time. `fill` paints from wherever it left off,
      // so painting after each segment is what makes the horn shade along its
      // length with one colour array and no per-vertex branch.
      const mix = (t0 + t1) / 2;
      p.fill([
        HORN_BASE[0] + (HORN_TIP[0] - HORN_BASE[0]) * mix,
        HORN_BASE[1] + (HORN_TIP[1] - HORN_BASE[1]) * mix,
        HORN_BASE[2] + (HORN_TIP[2] - HORN_BASE[2]) * mix,
      ]);
      if (before === p.count) throw new Error('teamlook: a horn segment produced no geometry');
    }
  }
  return p;
}

/**
 * The cactus body: the same seventeen bones, the same two-influence weights, a
 * completely different figure.
 *
 * Read against `character.buildFigure`, which this mirrors joint for joint. The
 * rule that file states in capitals is the rule here too and is the only thing
 * worth watching while reading: **wherever two segments meet, both coincident
 * rings take the same `Skin`.** A cactus that tore at the elbow would be a
 * rigging bug wearing a costume.
 *
 * The roles are re-purposed rather than extended, and the mapping is the whole
 * trick that lets `roleColour` serve both figures:
 *
 *     SINGLET  the cactus flesh -- torso, neck, arms, legs
 *     SHORTS   the ribbed base segment, a shade lighter
 *     SKIN     the head, which stays a head. The brief is explicit.
 *     BAND     the spines
 *     TRIM     the flower, which is the team colour
 *     SHOE     the shoes, unchanged, because a cactus in thongs is funnier
 *              than a cactus with roots and the brief's joke is the body
 *
 * So a "cactus kit" is a `Colourway` like any other and there is no second
 * colour path anywhere.
 */
function buildCactus(): Parts {
  const p = new Parts();

  const waist = w2(BONE.SPINE, BONE.HIPS, 0.5);
  const chestMid = w2(BONE.CHEST, BONE.SPINE, 0.5);
  const neckBase = w2(BONE.NECK, BONE.CHEST, 0.5);
  const head = w1(BONE.HEAD);

  // --- The head, lifted from `buildFigure` unchanged. It is the same lobe, the
  // same two eyes and the same four-sided nose, because the brief keeps the head
  // and because a cactus with a different face would read as a different
  // character rather than as the same person after a big night.
  p.lobe([0, 1.445, 0], [0.185, 0.25, 0.175], ROLE.SKIN, head, 1);
  for (const side of [-1, 1] as const) {
    p.lobe([side * 0.075, 1.5, -0.163], [0.045, 0.055, 0.032], ROLE.EYE, head);
  }
  p.tube([0, 1.44, -0.165], [0, 1.425, -0.238], 0.03, 0.012, 4, ROLE.SKIN, head);

  // --- The flower, on the crown. A stem, five petals and a pale centre.
  //
  // Five rather than a ring of eight because five is what a prickly pear does
  // and because at 40 m -- the distance the brief asks both kits to read at --
  // the petal count is not what is being read: what is being read is "there is a
  // bright disc on top of that head", and five 9 cm petals make a 20 cm disc
  // which is a quarter of the head's width.
  p.tube([0, 1.685, 0], [0, 1.745, 0], 0.024, 0.032, 6, ROLE.SINGLET, head);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    p.lobe([Math.cos(a) * 0.058, 1.772, Math.sin(a) * 0.058], [0.046, 0.012, 0.046], ROLE.TRIM, head);
  }
  p.lobe([0, 1.78, 0], [0.024, 0.015, 0.024], ROLE.BAND, head);

  // --- Neck.
  p.tube([0, 1.16, 0], [0, 1.27, 0], 0.062, 0.056, LIMB_SIDES, ROLE.SINGLET, neckBase, w1(BONE.NECK));

  // --- The base segment and the ribbed trunk over it.
  //
  // Ten sides rather than the figure's eight, and that is the only place this
  // body costs more per ring than the one it replaces: a rib is read as a
  // *facet count* under flat shading, and eight facets on a 0.19 m trunk reads
  // as an octagonal bin. Ten is where it starts reading as a barrel cactus, and
  // the pinch-and-bulge down the four segments is what puts the ribs in it.
  p.tube([0, 0.62, 0], [0, 0.72, 0], 0.19, 0.165, 10, ROLE.SHORTS, w1(BONE.HIPS));
  p.disc([0, 0.62, 0], 0.19, 10, false, ROLE.SHORTS, w1(BONE.HIPS));
  p.tube([0, 0.72, 0], [0, 0.86, 0], 0.165, 0.19, 10, ROLE.SINGLET, waist, chestMid);
  p.tube([0, 0.86, 0], [0, 0.99, 0], 0.19, 0.155, 10, ROLE.SINGLET, chestMid);
  p.tube([0, 0.99, 0], [0, 1.08, 0], 0.155, 0.185, 10, ROLE.SINGLET, chestMid, w1(BONE.CHEST));
  p.tube([0, 1.08, 0], [0, 1.155, 0], 0.185, 0.15, 10, ROLE.SINGLET, w1(BONE.CHEST));
  p.disc([0, 1.155, 0], 0.15, 10, true, ROLE.SINGLET, w1(BONE.CHEST));

  // --- Arms: a stubby upper segment and then a paddle.
  //
  // The paddle is a lobe flattened to 3.5 cm in z and stretched to 34 cm in y,
  // which is the prickly-pear shape, and it is bound **rigidly to the elbow**
  // rather than blended toward the wrist. That is deliberate and it is what
  // makes the swing still read: a paddle that deformed along its length would
  // bend like a noodle, and the joke is that it does not -- a cactus arm is a
  // board, and a bat swung by a board is the same arc with a funnier shape on
  // it. The mitt stays a lobe at the wrist because `player/bat.ts` parents the
  // bat to that bone and a hand that vanished would leave the bat floating.
  for (const side of [-1, 1] as const) {
    const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    const wrist = side < 0 ? BONE.WRIST_L : BONE.WRIST_R;
    const x = side * 0.185;
    const shoulderJoint = w2(shoulder, BONE.CHEST, 0.65);
    const elbowJoint = w2(shoulder, elbow, 0.5);

    p.lobe([x, 1.14, 0], [0.072, 0.064, 0.064], ROLE.SINGLET, shoulderJoint);
    p.tube([x, 1.14, 0], [x, 0.81, 0], 0.056, 0.05, 6, ROLE.SINGLET, shoulderJoint, elbowJoint);
    p.lobe([x, 0.655, 0], [0.105, 0.17, 0.035], ROLE.SINGLET, w1(elbow));
    p.lobe([x, 0.435, -0.008], [0.08, 0.09, 0.05], ROLE.SINGLET, w1(wrist));
  }

  // --- Legs, the figure's proportions with a rib at the knee.
  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? BONE.HIP_L : BONE.HIP_R;
    const knee = side < 0 ? BONE.KNEE_L : BONE.KNEE_R;
    const ankle = side < 0 ? BONE.ANKLE_L : BONE.ANKLE_R;
    const x = side * 0.105;
    const hipJoint = w2(hip, BONE.HIPS, 0.7);
    const kneeJoint = w2(hip, knee, 0.5);
    const ankleJoint = w2(knee, ankle, 0.5);

    p.tube([x, 0.815, 0], [x, 0.415, 0], 0.09, 0.07, LIMB_SIDES, ROLE.SINGLET, hipJoint, kneeJoint);
    p.tube([x, 0.415, 0], [x, 0.06, 0], 0.078, 0.052, LIMB_SIDES, ROLE.SINGLET, kneeJoint, ankleJoint);
    // The shoe, from `animation.ts`'s own constants exactly as `buildFigure`
    // takes them -- a sole in a different place is a character that scuffs.
    p.box(
      [x, FOOT_THICKNESS / 2, (FOOT_TOE + FOOT_HEEL) / 2],
      [FOOT_HALF_WIDTH, FOOT_THICKNESS / 2, (FOOT_HEEL - FOOT_TOE) / 2],
      ROLE.SHOE,
      w1(ankle),
    );
  }

  // --- Spines. Twelve three-sided cones, pointing out of the surface.
  //
  // Three sides is the smallest cone that is a cone, and at 3 cm long that is
  // all a spine ever is on screen; twelve is the count at which the silhouette
  // reads as prickly from the side without any of them being individually
  // visible, which is the right amount of detail for a 40 m read.
  const spine = (at: Point, out: Point, skin: ReturnType<typeof w1>): void => {
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    const tip: Point = [at[0] + (out[0] / l) * 0.05, at[1] + (out[1] / l) * 0.05, at[2] + (out[2] / l) * 0.05];
    p.tube(at, tip, 0.012, 0.0016, 3, ROLE.BAND, skin);
  };
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.4;
    const y = 0.78 + (i % 3) * 0.14;
    const r = 0.17;
    spine([Math.cos(a) * r, y, Math.sin(a) * r], [Math.cos(a), 0.35, Math.sin(a)], i % 2 === 0 ? w1(BONE.CHEST) : w1(BONE.SPINE));
  }
  for (const side of [-1, 1] as const) {
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    for (const y of [0.74, 0.6]) {
      spine([side * 0.185, y, -0.033], [0, 0.3, -1], w1(elbow));
      spine([side * 0.185, y, 0.033], [0, 0.3, 1], w1(elbow));
    }
  }

  return p;
}

/**
 * Every geometry a team look needs, built once and shared by the whole game.
 *
 * The same contract `CharacterAssets` and `BirdAssets` state, with the same
 * consequence: an actor must never dispose anything handed out here, because
 * every other actor is drawing it. Built lazily per (colourway, team) rather
 * than eagerly over all fourteen because a session usually sees two or three
 * kits and a geometry is 5 kB it need not allocate.
 */
export class BigNightKit {
  /** Two horns, in the head bone's frame. Non-skinned; parented, not bound. */
  readonly horns: BufferGeometry;
  /** The gazebo, at the origin with its floor at y = 0. Non-skinned. */
  readonly tent: BufferGeometry;
  readonly hornTriangles: number;
  readonly cactusTriangles: number;
  readonly tentTriangles: number;

  private readonly assets: CharacterAssets;
  /** `colourway * 4 + team` -> the tinted body. See `bodyFor`. */
  private readonly bodies = new Map<number, BufferGeometry>();
  private readonly cacti = new Map<number, BufferGeometry>();
  /** The bind-pose cactus, kept so `cactusFor` can re-colour without rebuilding. */
  private readonly cactusParts: Parts;

  constructor(assets: CharacterAssets) {
    this.assets = assets;

    const horns = buildHorns();
    this.horns = horns.geometry('bignight:horns', false);
    this.hornTriangles = horns.parts.index.length / 3;

    const tent = buildTent();
    this.tent = tent.geometry('teamlook:tent', false);
    this.tentTriangles = tent.parts.index.length / 3;

    this.cactusParts = buildCactus();
    this.cactusTriangles = this.cactusParts.index.length / 3;
  }

  /**
   * The body a player draws: their colourway, tinted for their team.
   *
   * `TEAM.NONE` returns the shared kit geometry `CharacterAssets` already built,
   * which is the guest path and allocates nothing -- the property
   * `game/teamlook.teamKit` is written to preserve.
   */
  bodyFor(colourway: number, team: Team): BufferGeometry {
    const kit = COLOURWAYS[((colourway % COLOURWAYS.length) + COLOURWAYS.length) % COLOURWAYS.length];
    if (team === TEAM.NONE) return this.assets.geometries[COLOURWAYS.indexOf(kit)];
    const key = COLOURWAYS.indexOf(kit) * 4 + team;
    let g = this.bodies.get(key);
    if (!g) {
      g = this.assets.kitGeometry(teamColourway(kit, team));
      this.bodies.set(key, g);
    }
    return g;
  }

  /**
   * The cactus body for a colourway, in a team's flower.
   *
   * Keyed on both because the head keeps the player's own skin tone -- which is
   * the whole reason a cactus is still recognisably *that* player -- and the
   * flower takes the team colour. Only DeFAULT ever asks for one today; the
   * signature takes a team anyway rather than hard-coding the yellow, because a
   * renderer that knew which team the cactus belonged to would be a second place
   * the answer lives.
   */
  cactusFor(colourway: number, team: Team): BufferGeometry {
    const index = ((colourway % COLOURWAYS.length) + COLOURWAYS.length) % COLOURWAYS.length;
    const key = index * 4 + team;
    let g = this.cacti.get(key);
    if (!g) {
      const base = COLOURWAYS[index];
      const kit: Colourway = {
        name: `cactus:${base.name}:${TEAM_NAME[team] || 'none'}`,
        singlet: CACTUS_FLESH,
        shorts: CACTUS_RIB,
        skin: base.skin,
        shoe: base.shoe,
        band: CACTUS_SPINE,
        trim: team === TEAM.NONE ? CACTUS_SPINE : hexToLinear(TEAM_COLOUR[team].hex),
      };
      const painted = new Painted();
      // The parts are shared across every cactus; only the colour array differs,
      // which is `CharacterAssets`' own bargain restated -- one figure, many
      // kits, one buffer set. Copying the arrays here rather than sharing the
      // `BufferAttribute`s costs 20 kB per cactus kit against a `Map` that will
      // hold one or two entries in a session, and buys not having to reason
      // about who disposes a shared attribute.
      copyParts(this.cactusParts, painted.parts);
      painted.fromRoles(kit);
      g = painted.geometry(kit.name, true);
      // The animated bounds, on the same argument `CharacterAssets` makes at
      // length: a skinned mesh's rest bounds are not its animated bounds, and
      // three caches whatever pose it first culled in. The cactus is a wider
      // figure than the one it replaces (paddle arms, a flower over the crown),
      // so it takes the character's inflated sphere expanded to cover its own
      // bind pose rather than a sphere of its own.
      g.boundingSphere = inflatedBounds(g, this.assets.bounds);
      this.cacti.set(key, g);
    }
    return g;
  }

  /**
   * Everything built here, released.
   *
   * The bodies are `CharacterAssets.kitGeometry` products, which that file says
   * a caller owns and may dispose -- and must dispose, because they are ours and
   * nothing else holds them. What must never be disposed is `assets.material` or
   * the attributes the kit geometries share with every other figure, and nothing
   * below touches either.
   */
  dispose(): void {
    this.horns.dispose();
    this.tent.dispose();
    for (const g of this.bodies.values()) g.dispose();
    for (const g of this.cacti.values()) g.dispose();
    this.bodies.clear();
    this.cacti.clear();
  }
}

/** A `Parts` copied into another, for a figure whose geometry is shared and whose colours are not. */
function copyParts(from: Parts, into: Parts): void {
  // Element by element rather than `push(...array)`: these run to a few thousand
  // entries and spreading an array into an argument list is a stack frame that
  // size, which is a `RangeError` on some engines at a length nobody would have
  // predicted. `world/streamer.ts` makes the same note about its index copies.
  for (const v of from.position) into.position.push(v);
  for (const v of from.normal) into.normal.push(v);
  for (const v of from.role) into.role.push(v);
  for (const v of from.skinIndex) into.skinIndex.push(v);
  for (const v of from.skinWeight) into.skinWeight.push(v);
  for (const v of from.index) into.index.push(v);
}

/** A sphere covering both the bind pose of `g` and the character's inflated one. */
function inflatedBounds(g: BufferGeometry, character: Sphere): Sphere {
  const sphere = new Sphere();
  const v = new Vector3();
  const position = g.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    sphere.expandByPoint(v);
  }
  sphere.radius = Math.max(sphere.radius, 0) + 0.45;
  return sphere.union(character);
}

// --- The horns, on a head ------------------------------------------------------------------

/**
 * One Marita's horns.
 *
 * `player/bat.ts`'s `BatProp` with the bone changed, and every line of its
 * header applies: parented rather than positioned, `frustumCulled` off because
 * the body it hangs on is already tested, and `castShadowOnly` provided
 * separately because **three does not inherit layers** -- horns on a body that
 * has been moved to the self-shadow layer are still on layer 0 and are still
 * drawn, which in first person is two horns hanging in front of your own eyes.
 */
export class HornProp {
  readonly mesh: Mesh;

  constructor(kit: BigNightKit, assets: CharacterAssets, actor: CharacterActor) {
    const mesh = new Mesh(kit.horns, assets.material);
    mesh.name = 'bignight:horns';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    actor.bones[BONE.HEAD].add(mesh);
    this.mesh = mesh;
  }

  /** The local player's own horns: seen by the sun, not by the eye. See `BatProp.castShadowOnly`. */
  castShadowOnly(): void {
    this.mesh.layers.set(SELF_SHADOW_LAYER);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

// --- The sausage-sizzle tent -----------------------------------------------------------------

/** The gazebo's frame, and the trestle under it. Linear albedos. */
const TENT_STEEL: Rgb = [0.34, 0.35, 0.36];
const TENT_TABLE: Rgb = [0.42, 0.30, 0.16];
const TENT_PLATE: Rgb = [0.06, 0.06, 0.065];
const TENT_SNAG: Rgb = [0.32, 0.13, 0.08];

/**
 * A Bunnings sausage sizzle, as about a hundred and seventy triangles.
 *
 * Built at the origin with its floor at y = 0 and its footprint square to the
 * axes, so a `TentSet` instance is a translation and nothing else -- no
 * rotation, because a pop-up gazebo dropped at somebody's feet has no meaningful
 * heading and giving it one would mean carrying a yaw on the wire for a prop
 * that is symmetric under 90 degrees anyway.
 *
 * **The valance is eight independent quads and the canopy is eight more**, which
 * is the only reason `Painted.quad` exists. A striped awning cannot be built out
 * of `tube`: adjacent gores of a tube share their vertices, so a red one and a
 * white one would share the boundary and the stripe would be a gradient. Eight
 * quads is sixteen triangles and thirty-two vertices for a thing that has to be
 * read as *stripes* from a car going past.
 */
function buildTent(): Painted {
  const p = new Painted();
  const half = TENT.half;
  const eaves = TENT.eaves;

  // --- Four legs, inset from the corners so the canopy overhangs them.
  const inset = half - 0.12;
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      p.parts.tube([sx * inset, 0, sz * inset], [sx * inset, eaves, sz * inset], 0.035, 0.03, 8, ROLE.SKIN, w1(0));
    }
  }
  p.fill(TENT_STEEL);

  // --- The canopy: eight gores from a small flat top down to the eaves ring,
  // alternating red and white. The ring is at `half * 1.06` so the awning
  // overhangs the legs, which is what a pop-up does and what stops the frame
  // reading as a climbing frame.
  const ring = half * 1.06;
  const topR = 0.16;
  const at = (r: number, i: number, y: number): Point => [Math.cos((i / TENT.gores) * TAU) * r, y, Math.sin((i / TENT.gores) * TAU) * r];
  for (let i = 0; i < TENT.gores; i++) {
    const j = (i + 1) % TENT.gores;
    // Wound outer-first so the derived normal points up and out, which is the
    // side a canopy is seen from. `Painted.quad` derives it from these corners,
    // so the order here *is* the facing.
    p.quad(at(ring, i, eaves), at(ring, j, eaves), at(topR, j, TENT.peak), at(topR, i, TENT.peak), ROLE.SINGLET);
    p.fill(i % 2 === 0 ? TENT_RED : TENT_WHITE);
  }
  p.parts.disc([0, TENT.peak, 0], topR, TENT.gores, true, ROLE.SINGLET, w1(0));
  p.fill(TENT_RED);

  // --- The valance: the same eight gores hanging straight down, offset by one
  // so a red gore has a white skirt and the awning reads as a check rather than
  // as eight solid wedges.
  for (let i = 0; i < TENT.gores; i++) {
    const j = (i + 1) % TENT.gores;
    p.quad(
      at(ring, i, eaves - TENT.valance),
      at(ring, j, eaves - TENT.valance),
      at(ring, j, eaves),
      at(ring, i, eaves),
      ROLE.SINGLET,
    );
    p.fill(i % 2 === 0 ? TENT_WHITE : TENT_RED);
  }

  // --- A trestle, a hotplate and four snags, because a tent with nothing under
  // it is a tent and a tent with a sausage under it is a sausage sizzle. This is
  // the half of the prop that says what the mega *does*: `FX.MEGA_SIZZLE_TENT`
  // heals every DeFAULT who touches it, and the thing on the map has to look
  // like food rather than like shelter.
  p.parts.box([0, 0.78, -0.55], [0.75, 0.03, 0.3], ROLE.SKIN, w1(0));
  p.fill(TENT_TABLE);
  p.parts.box([0, 0.83, -0.55], [0.4, 0.025, 0.22], ROLE.SKIN, w1(0));
  p.fill(TENT_PLATE);
  for (let i = 0; i < 4; i++) {
    const z = -0.68 + i * 0.09;
    p.parts.tube([-0.26, 0.865, z], [0.26, 0.865, z], 0.021, 0.021, 6, ROLE.SKIN, w1(0));
  }
  p.fill(TENT_SNAG);

  return p;
}

/** One tent on the ground: where, and when it stops standing. The wire's own record. */
export interface TentSpec {
  x: number;
  y: number;
  z: number;
  untilMs: number;
}

/** Tents standing at once. A mega is once per in-game day per player; four is generous. */
export const MAX_TENTS = 4;

/**
 * Every sausage-sizzle tent in the world, in one draw call.
 *
 * An `InstancedMesh` rather than a `Mesh` per tent even though the count is four,
 * for the reason `world/powerups.ts` gives about its own handful: the cost that
 * matters is not the draw, it is that a `Mesh` created when a mega fires is a
 * render-object cache miss on that frame, and this feature's whole job is to
 * appear at the worst possible moment. One mesh, built at boot, with `count`
 * moved up and down.
 */
export class TentSet {
  readonly mesh: InstancedMesh;
  /** Tents standing after the last `set`. For the console. */
  live = 0;

  private readonly matrix = new Matrix4();

  constructor(kit: BigNightKit, assets: CharacterAssets) {
    const mesh = new InstancedMesh(kit.tent, assets.material, MAX_TENTS);
    mesh.name = 'teamlook:tents';
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A tent is 3 m across and there are at most four of them anywhere in a
    // 60 km city, so a bounding sphere spanning all four is useless and the
    // per-instance test three does not do would be the only useful one. Culling
    // it as a unit would flicker the whole set on and off at the frustum edge.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh = mesh;
  }

  /**
   * Stand every tent that has not expired, and take down the rest.
   *
   * Declarative like `NameplateField` -- the caller hands over the whole list
   * every time rather than adding and removing -- because the source of truth is
   * a server message and reconciling two lists is how a tent gets left standing
   * forever after a reconnect.
   */
  set(tents: readonly TentSpec[], nowMs: number, groundAt?: (x: number, z: number) => number): void {
    let n = 0;
    for (const t of tents) {
      if (n >= MAX_TENTS) break;
      if (t.untilMs <= nowMs) continue;
      // The client's own ground height wins where it has one. The wire carries a
      // decimetre `y` as an anchor for the frames before the tile has streamed
      // in -- see `protocol.TEAM_EVENT_BYTES` -- and a tent floating 40 cm over a
      // car park is the thing that anchor is there to avoid, not to cause.
      const y = groundAt ? groundAt(t.x, t.z) : t.y;
      this.matrix.makeTranslation(t.x, y, t.z);
      this.mesh.setMatrixAt(n, this.matrix);
      n++;
    }
    this.mesh.count = n;
    this.live = n;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

// --- The ground rings ------------------------------------------------------------------------

/** How far a ring floats over the ground, metres. Enough to clear the road deck's own z-fight guard. */
const RING_LIFT = 0.05;
/** Segments round a ring. 48 is smooth at 12 m and is 96 triangles once, forever. */
const RING_SEGMENTS = 48;

/**
 * A flat annulus in the XZ plane, outer radius 1, facing up.
 *
 * Radius 1 so an instance's scale *is* its radius in metres, which is what makes
 * the aura ring, the group ring and the slam shockwave one geometry rather than
 * three. The winding was derived rather than guessed and is asserted in
 * `verifyBigNightKit`: seen from +Y with x to the right, increasing angle runs
 * clockwise on screen because z runs down it, which is the same trap
 * `character.Parts.disc` documents and the same fix.
 */
function ringGeometry(inner: number): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    position.push(c, 0, s, c * inner, 0, s * inner);
    normal.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const j = (i + 1) % RING_SEGMENTS;
    const oi = i * 2;
    const ii = i * 2 + 1;
    const oj = j * 2;
    const ij = j * 2 + 1;
    index.push(oi, ii, ij, oi, ij, oj);
  }
  const g = new BufferGeometry();
  g.name = 'teamlook:ring';
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setIndex(new BufferAttribute(new Uint16Array(index), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Every team ring in the world: auras, mega groups and slam shockwaves.
 *
 * One `InstancedMesh`, one material, `MAX_RINGS` instances, filled declaratively
 * each frame -- `begin`, `add*` per ring, `end` -- which is the idiom
 * `world/nameplates.ts` and the football pool already use and for the same
 * reason: the callers are unrelated lists that must not have to agree about
 * identity or about who owns the pool.
 *
 * **The brightness rides in the instance colour rather than in an alpha**, which
 * is the one thing here that is not obvious. Three's `NodeMaterial` multiplies
 * `instanceColor` into the diffuse (see `NodeMaterial.setupDiffuseColor`), and
 * this material blends additively -- so a colour scaled by 0.16 *is* a 16%
 * ring, with no per-instance alpha attribute, no custom TSL and one uniform
 * pipeline. Additive is also the right blend on its own merits: a ring on a
 * sunlit footpath and a ring on shaded asphalt should both read, and additive is
 * the only blend that brightens both.
 */
export class TeamRingField {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicNodeMaterial;
  /** Rings written by the last `end()`. For the console and the checks. */
  live = 0;
  /** Rings `add` refused because the buffers were full. Should be 0 forever. */
  dropped = 0;

  private readonly matrix = new Matrix4();
  private readonly colour = new Color();
  private written = 0;

  constructor() {
    const material = new MeshBasicNodeMaterial();
    material.name = 'teamlook:ring';
    material.transparent = true;
    material.blending = AdditiveBlending;
    // Additive transparency must not write depth or the rings occlude each other
    // and the world behind them in draw order rather than in space.
    material.depthWrite = false;
    // Depth *test* stays on, deliberately, and it is the opposite of the choice
    // `world/nameplates.ts` makes: a plate is information about a person and is
    // wanted through a wall, and a ring is a mark on the ground -- one drawn
    // through the Queen Victoria Building would be a circle painted on a
    // building, which reads as a bug rather than as a buff.
    material.depthTest = true;
    // Two-sided because a ring lifted 5 cm over sloping ground can be seen from
    // underneath at the downhill edge, and a single-sided ring there simply
    // disappears in patches.
    material.side = DoubleSide;
    this.material = material;

    const mesh = new InstancedMesh(ringGeometry(1 - RING_THICKNESS), material, MAX_RINGS);
    mesh.name = 'teamlook:rings';
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    // Over the world's opaque geometry and under the nameplates, which sit at 12.
    mesh.renderOrder = 6;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Allocated up front by writing white into every slot: `InstancedMesh` only
    // creates `instanceColor` when `setColorAt` is first called, and creating it
    // on the frame the first aura appears is a buffer allocation at exactly the
    // moment this feature exists to be smooth through.
    for (let i = 0; i < MAX_RINGS; i++) mesh.setColorAt(i, this.colour.setRGB(1, 1, 1));
    this.mesh = mesh;
  }

  /** Start a frame. */
  begin(): void {
    this.written = 0;
  }

  /**
   * A faint ring at somebody's feet, because they have an aura node **and there
   * is a teammate inside it**.
   *
   * The teammate condition is the caller's -- it needs positions, which this
   * class does not have -- and it is not decoration: `game/teams.ts` has four
   * aura nodes a Marita can hold, everybody within twelve metres of a fight is
   * in somebody's aura, and a ring per aura holder unconditionally would paint
   * a brawl with overlapping circles until nothing meant anything. Drawn only
   * when it is doing something, it means "this pair is buffing each other",
   * which is a read.
   */
  addAura(x: number, y: number, z: number, team: Team, seconds: number): void {
    this.push(x, y, z, AURA_RADIUS, team, ringAlpha(RING_ALPHA.aura, seconds));
  }

  /** The stronger ring a mega draws while its group condition holds. */
  addGroup(x: number, y: number, z: number, team: Team, seconds: number): void {
    this.push(x, y, z, GROUP_RADIUS, team, ringAlpha(RING_ALPHA.group, seconds));
  }

  /**
   * A slam shockwave, `age` seconds after it fired. Silently ignored once it has
   * expired, so a caller can keep a fixed list and let it fall off.
   */
  addSlam(x: number, y: number, z: number, team: Team, age: number): void {
    const { radius, alpha } = slamRing(age);
    if (alpha <= 0.004 || radius <= 0.01) return;
    this.push(x, y, z, radius, team, alpha);
  }

  /** Hand the frame's rings to the renderer. */
  end(): void {
    this.mesh.count = this.written;
    this.live = this.written;
    if (this.written > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }

  private push(x: number, y: number, z: number, radius: number, team: Team, alpha: number): void {
    if (this.written >= MAX_RINGS) {
      this.dropped++;
      return;
    }
    const hex = TEAM_COLOUR[team].hex;
    // The team colour scaled by the ring's brightness. See the class header on
    // why the alpha rides here.
    const linear = hexToLinear(hex);
    this.colour.setRGB(linear[0] * alpha * RING_GAIN, linear[1] * alpha * RING_GAIN, linear[2] * alpha * RING_GAIN);
    // Scaled in x and z only. A uniform scale would multiply the 5 cm lift by
    // the radius and float a 12 m aura ring 60 cm over the footpath.
    this.matrix.makeScale(radius, 1, radius);
    this.matrix.setPosition(x, y + RING_LIFT, z);
    this.mesh.setMatrixAt(this.written, this.matrix);
    this.mesh.setColorAt(this.written, this.colour);
    this.written++;
  }
}

/**
 * Aura and group radii, aliased from `game/teamlook.ts` -- which aliases them
 * from `game/teams.ts`, which owns them. Three names for two numbers looks like
 * one too many until you notice that the alternative is a `12` in a renderer,
 * and `verifyTeamLook` asserts the chain has not been broken.
 */
const AURA_RADIUS = AURA_RING_M;
const GROUP_RADIUS = GROUP_RING_M;

/**
 * The ring's brightness multiplier, and it is the nameplates' `PLATE_GAIN`
 * argument in another material.
 *
 * `material.toneMapped` is honoured by the WebGL renderer only and this project
 * is WebGPU, so the renderer's Neutral tone map at exposure 0.62 takes a linear
 * 1.0 down to about 0.79. A ring written at its nominal 16% would land nearer
 * 12% and be a smudge. 1.45 is the same number `world/nameplates.ts` arrived at
 * against the same chain, and using a second one here would be two files with
 * different ideas about what white is.
 */
const RING_GAIN = 1.45;

// --- Warm-up ----------------------------------------------------------------------------------

/**
 * Every pipeline this feature will ever need, for the boot warm-up.
 *
 * Four parts and the reason for each: the **tinted body** is the character
 * material against the character's own skinned layout, which is already warmed
 * by the actors -- it is listed anyway because it costs nothing and because a
 * future change to the tint's attribute set would otherwise silently start
 * compiling on the frame somebody with a team walks round a corner. The
 * **cactus** is the same layout again. The **horns and the tent** are the
 * character material against a *non-skinned* layout, which nothing else in the
 * client produces, and are the one genuinely new pipeline family here. The
 * **ring** is the new material.
 *
 * `casts` and `receives` mirror what each really is: the rings neither cast nor
 * receive, and everything else does both. See `world/warmup.ts` on why
 * `receiveShadow` is part of the cache key and therefore doubles the count.
 */
export function teamLookWarmupParts(kit: BigNightKit, assets: CharacterAssets, rings: TeamRingField): WarmupPart[] {
  return [
    { geometry: kit.bodyFor(0, TEAM.MARITA), material: assets.material, casts: true },
    { geometry: kit.cactusFor(0, TEAM.DEFAULT), material: assets.material, casts: true },
    { geometry: kit.horns, material: assets.material, casts: true },
    { geometry: kit.tent, material: assets.material, casts: true },
    { geometry: rings.mesh.geometry, material: rings.material, casts: false, receives: [false] },
  ];
}

// --- The self-check --------------------------------------------------------------------------

/**
 * The two Big Night kits, the tent, the ring and the tint, built for real and
 * measured.
 *
 * On this repo's criterion throughout: **every failure below renders.** A horn
 * wound inside out is a Marita with nothing on their head, which reads as the
 * talent not being wired up. A cactus whose bounds are its rest pose is a player
 * who vanishes at the edge of the screen while swinging -- the exact trap
 * `CharacterAssets` documents, one figure over. A budget that has quietly
 * doubled is sixteen players' worth of triangles nobody counted. A skin weight
 * that does not sum to 1 shrinks the cactus toward the origin, smoothly and
 * slightly. And a ring wound face-down is a buff with no mark on the ground at
 * all.
 *
 * It builds real `CharacterAssets`, which means it needs three but not a GPU or
 * a document -- the same footing `verifyCharacterRig` runs on, and the reason
 * this one is in the browser's boot list only while `verifyTeamLook` is in both.
 * `verifyTeamView`'s failures are folded in here because that adapter is only
 * ever wrong in this feature's terms; see its header.
 */
export function verifyBigNightKit(assets: CharacterAssets): string[] {
  const failures: string[] = [...verifyTeamView()];
  const kit = new BigNightKit(assets);
  try {
    // --- Budgets.
    if (kit.hornTriangles > TRI_BUDGET.horns) {
      failures.push(`The horns are ${kit.hornTriangles} triangles against a budget of ${TRI_BUDGET.horns}, paid by every Marita in the lobby.`);
    }
    if (kit.cactusTriangles > TRI_BUDGET.cactus) {
      failures.push(`The cactus is ${kit.cactusTriangles} triangles against a budget of ${TRI_BUDGET.cactus}.`);
    }
    if (kit.tentTriangles > TRI_BUDGET.tent) {
      failures.push(`The tent is ${kit.tentTriangles} triangles against a budget of ${TRI_BUDGET.tent}.`);
    }
    // And they have to be *something*: a builder that silently produced nothing
    // passes every ceiling above.
    if (kit.hornTriangles < 24) failures.push(`The horns are ${kit.hornTriangles} triangles; that is not two horns.`);
    if (kit.cactusTriangles < 200) failures.push(`The cactus is ${kit.cactusTriangles} triangles; that is not a body.`);
    if (kit.tentTriangles < 60) failures.push(`The tent is ${kit.tentTriangles} triangles; that is not a gazebo.`);

    // --- Both kits build, are finite, and are wound the right way out.
    const cactus = kit.cactusFor(0, TEAM.DEFAULT);
    const ring = ringProbe();
    for (const [name, g] of [['horns', kit.horns], ['cactus', cactus], ['tent', kit.tent], ['ring', ring]] as Array<[string, BufferGeometry]>) {
      failures.push(...checkSolid(name, g));
    }
    ring.dispose();

    // --- The cactus is bound to the real rig, with weights that sum to 1.
    // Everything about "the animations still work" reduces to this: the same
    // seventeen bones, in range, at full weight.
    {
      const skinIndex = cactus.getAttribute('skinIndex');
      const skinWeight = cactus.getAttribute('skinWeight');
      if (!skinIndex || !skinWeight) {
        failures.push('The cactus has no bone attributes; it would draw in the bind pose while its owner ran off.');
      } else {
        let badWeight = 0;
        let badIndex = 0;
        const touched = new Set<number>();
        for (let i = 0; i < skinWeight.count; i++) {
          const sum = skinWeight.getX(i) + skinWeight.getY(i) + skinWeight.getZ(i) + skinWeight.getW(i);
          if (Math.abs(sum - 1) > 1e-4) badWeight++;
          for (const v of [skinIndex.getX(i), skinIndex.getY(i)]) {
            if (!Number.isInteger(v) || v < 0 || v >= 17) badIndex++;
            else touched.add(v);
          }
        }
        if (badWeight > 0) failures.push(`${badWeight} cactus vertices have skin weights that do not sum to 1; the body would shrink toward the origin.`);
        if (badIndex > 0) failures.push(`${badIndex} cactus skin indices are outside the rig's seventeen bones.`);
        // Every limb bone has to carry something, or that limb simply does not
        // move and it looks like a stiff animation rather than an unbound mesh.
        for (const bone of [BONE.HEAD, BONE.CHEST, BONE.HIPS, BONE.ELBOW_L, BONE.ELBOW_R, BONE.WRIST_L, BONE.WRIST_R, BONE.KNEE_L, BONE.KNEE_R, BONE.ANKLE_L, BONE.ANKLE_R]) {
          if (!touched.has(bone)) failures.push(`No cactus vertex is bound to bone ${bone}; that limb would not animate.`);
        }
      }
      // The bounds have to cover the figure and then some, or three caches a
      // sphere from the first pose it culled in and the cactus pops out of the
      // frame mid-swing. See `CharacterAssets`.
      const bounds = cactus.boundingSphere;
      if (!bounds) failures.push('The cactus has no bounding sphere.');
      else if (bounds.radius < assets.bounds.radius) {
        failures.push(`The cactus's bounds (${bounds.radius.toFixed(2)} m) are tighter than the character's inflated ${assets.bounds.radius.toFixed(2)} m; it would be culled while on screen.`);
      }
      // A cactus is still a person-shaped thing standing on the ground. Sole at
      // zero and crown around the figure's height, or the body floats.
      const extent = heightOf(cactus);
      if (extent.min < -0.02 || extent.min > 0.06) failures.push(`The cactus's lowest point is at y ${extent.min.toFixed(3)}; the mesh origin is the sole.`);
      if (extent.max < 1.6 || extent.max > 2.0) failures.push(`The cactus stands ${extent.max.toFixed(2)} m against a 1.70 m figure (the flower is allowed a little over).`);
    }

    // --- The horns sit on the skull rather than beside it or inside it.
    //
    // Measured in the head bone's frame, which is the frame they are parented
    // in, against the skull `character.ts` builds: centre at local y 0.195 with
    // radii 0.185 x 0.25 x 0.175. What this catches is the failure that has no
    // frame anybody develops in -- horns authored in mesh space rather than bone
    // space, which puts them 1.25 m above the head and looks, from the front, at
    // the distance a check would be run at, like nothing at all.
    {
      const extent = heightOf(kit.horns);
      if (extent.min < 0.2) failures.push(`A horn reaches down to local y ${extent.min.toFixed(2)} in the head bone's frame; it would come out of the neck.`);
      if (extent.max < 0.45 || extent.max > 0.85) failures.push(`The horns top out at local y ${extent.max.toFixed(2)}; the crown is at 0.445 and a horn is meant to clear it by a head's radius or so.`);
      const position = kit.horns.getAttribute('position');
      let left = 0;
      let right = 0;
      for (let i = 0; i < position.count; i++) {
        if (position.getX(i) < -0.05) left++;
        else if (position.getX(i) > 0.05) right++;
      }
      if (left === 0 || right === 0) failures.push(`The horns are all on one side (${left} left, ${right} right).`);
      if (Math.abs(left - right) > 2) failures.push(`The horns are asymmetric: ${left} vertices left, ${right} right.`);
    }

    // --- The tent is a shelter with room under it, standing on the ground.
    {
      const extent = heightOf(kit.tent);
      if (Math.abs(extent.min) > 0.01) {
        failures.push(`The tent's floor is at y ${extent.min.toFixed(3)}; a TentSet instance is a translation and nothing else.`);
      }
      if (Math.abs(extent.max - TENT.peak) > 0.02) failures.push(`The tent peaks at ${extent.max.toFixed(2)} m rather than ${TENT.peak}.`);
    }

    // --- The tint reaches the body. This is the one that would otherwise ship:
    // every colour decision is checked in `verifyTeamLook`, and none of that
    // proves the geometry a player actually draws has the tinted colours *in*
    // it. A `bodyFor` that returned the base kit would pass every measurement in
    // the other file and put a whole team in the wrong shirt.
    for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
      const tinted = kit.bodyFor(0, team);
      const base = assets.geometries[0];
      if (tinted === base) {
        failures.push(`A ${TEAM_NAME[team]} draws the untinted kit geometry; the tint never reaches the body.`);
        continue;
      }
      if (tinted.getAttribute('position') !== base.getAttribute('position')) {
        failures.push(`A ${TEAM_NAME[team]}'s body does not share the figure's position buffer; the tint has rebuilt the mesh.`);
      }
      const want = hexToLinear(TEAM_COLOUR[team].hex);
      const colour = tinted.getAttribute('color');
      let singletVerts = 0;
      for (let i = 0; i < colour.count; i++) {
        if (Math.abs(colour.getX(i) - want[0]) < 1e-6 && Math.abs(colour.getY(i) - want[1]) < 1e-6 && Math.abs(colour.getZ(i) - want[2]) < 1e-6) singletVerts++;
      }
      if (singletVerts < 16) failures.push(`Only ${singletVerts} vertices of a ${TEAM_NAME[team]} body are the team colour; the singlet is 40-odd.`);
      // And asking twice hands back the same geometry rather than building a new
      // one every frame, which would be a few kilobytes of GPU buffer per frame
      // per player and would look exactly like a memory leak, because it is one.
      if (kit.bodyFor(0, team) !== tinted) failures.push(`bodyFor is not cached; a ${TEAM_NAME[team]} would allocate a geometry every frame.`);
    }
    if (kit.bodyFor(2, TEAM.NONE) !== assets.geometries[2]) {
      failures.push('A guest is not drawing the shared kit geometry; teams have changed how somebody with no team looks.');
    }

    // --- The ring field: it fills, it caps, and it does not leak instances.
    {
      const rings = new TeamRingField();
      try {
        rings.begin();
        rings.addAura(0, 0, 0, TEAM.MARITA, 0.5);
        rings.addGroup(10, 0, 0, TEAM.DEFAULT, 0.5);
        rings.end();
        if (rings.live !== 2) failures.push(`Two rings were offered and ${rings.live} were drawn.`);
        if (!rings.mesh.instanceColor) failures.push('The ring field has no instance colour buffer, so every ring would be white at full strength.');
        // An expired slam draws nothing rather than a zero-radius dot.
        rings.begin();
        rings.addSlam(0, 0, 0, TEAM.MARITA, 99);
        rings.end();
        if (rings.live !== 0) failures.push('An expired slam ring is still being drawn.');
        // Over the cap: dropped and counted, never written off the end.
        rings.begin();
        for (let i = 0; i < MAX_RINGS + 5; i++) rings.addAura(i, 0, 0, TEAM.MARITA, 0);
        rings.end();
        if (rings.live !== MAX_RINGS) failures.push(`${rings.live} rings were written into a buffer sized for ${MAX_RINGS}.`);
        if (rings.dropped !== 5) failures.push(`${MAX_RINGS + 5} rings over a ${MAX_RINGS} budget dropped ${rings.dropped}, not 5.`);
        // The slam grows. Sampled rather than asserted point by point --
        // `verifyTeamLook` owns the curve; what is checked here is that the
        // field is actually using it and scaling the instance by it.
        const radii: number[] = [];
        for (const age of [0.05, 0.2, 0.35]) {
          rings.begin();
          rings.addSlam(0, 0, 0, TEAM.DEFAULT, age);
          rings.end();
          const m = new Matrix4();
          rings.mesh.getMatrixAt(0, m);
          radii.push(m.elements[0]);
        }
        for (let i = 1; i < radii.length; i++) {
          if (radii[i] <= radii[i - 1]) failures.push(`The slam ring did not grow between samples: ${radii[i - 1]} then ${radii[i]}.`);
        }
      } finally {
        rings.dispose();
      }
    }

    // --- The tents: expiry is honoured and the cap holds.
    {
      const tents = new TentSet(kit, assets);
      try {
        const now = 1_800_000_000_000;
        tents.set([{ x: 0, y: 0, z: 0, untilMs: now + 1000 }, { x: 5, y: 0, z: 0, untilMs: now - 1 }], now);
        if (tents.live !== 1) failures.push(`One live tent and one expired one produced ${tents.live} standing; an expired tent never comes down.`);
        tents.set([], now);
        if (tents.live !== 0) failures.push('An empty tent list left tents standing.');
        const many: TentSpec[] = [];
        for (let i = 0; i < MAX_TENTS + 3; i++) many.push({ x: i, y: 0, z: 0, untilMs: now + 1000 });
        tents.set(many, now);
        if (tents.live !== MAX_TENTS) failures.push(`${tents.live} tents were written into a buffer sized for ${MAX_TENTS}.`);
        // And the ground query wins over the wire's decimetre anchor.
        tents.set([{ x: 0, y: -50, z: 0, untilMs: now + 1000 }], now, () => 7.5);
        const m = new Matrix4();
        tents.mesh.getMatrixAt(0, m);
        if (Math.abs(m.elements[13] - 7.5) > 1e-6) {
          failures.push(`A tent was placed at y ${m.elements[13]} rather than at the client's own ground height of 7.5.`);
        }
      } finally {
        tents.dispose();
      }
    }
  } finally {
    kit.dispose();
  }
  return failures;
}

/** A ring geometry for the winding check, since the field's is inside an `InstancedMesh`. */
function ringProbe(): BufferGeometry {
  return ringGeometry(1 - RING_THICKNESS);
}

/** A geometry's vertical extent. */
function heightOf(g: BufferGeometry): { min: number; max: number } {
  const position = g.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  return { min, max };
}

/**
 * Finite, indexed, and every triangle wound to agree with its own normals.
 *
 * `verifyCharacterRig`'s winding test, lifted so this file's four solids get it
 * too. The README's winding pass records that 61% of the city's walls were
 * inside out for months while looking like a city; a closed tube, a lobe and a
 * hand-wound quad all have exactly that property.
 */
function checkSolid(name: string, g: BufferGeometry): string[] {
  const out: string[] = [];
  const position = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const index = g.getIndex();
  if (!position || !normal) {
    out.push(`The ${name} geometry is missing position or normal.`);
    return out;
  }
  if (index === null) {
    out.push(`The ${name} geometry is not indexed.`);
    return out;
  }
  for (let i = 0; i < position.count; i++) {
    if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) {
      out.push(`The ${name} geometry has a non-finite vertex at ${i}; its bounds would be NaN and it would never draw.`);
      break;
    }
  }
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const face = new Vector3();
  let disagreeing = 0;
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t);
    const i1 = index.getX(t + 1);
    const i2 = index.getX(t + 2);
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    face.copy(b).sub(a).cross(n.copy(c).sub(a));
    if (face.lengthSq() < 1e-16) continue;
    face.normalize();
    n.set(0, 0, 0);
    for (const i of [i0, i1, i2]) {
      n.x += normal.getX(i);
      n.y += normal.getY(i);
      n.z += normal.getZ(i);
    }
    if (n.lengthSq() < 1e-12) continue;
    if (face.dot(n.normalize()) < 0) disagreeing++;
  }
  if (disagreeing > 0) {
    out.push(
      `${disagreeing} of ${index.count / 3} ${name} triangles are wound against their own normals -- they ` +
        'will be back-face culled and the object will be invisible or see-through from outside.',
    );
  }
  return out;
}

/**
 * Put the horns on a character, or take them off, in one call.
 *
 * A free function taking the actor rather than a method on anything, because
 * `main.ts` has three unrelated lists of characters -- the local player, the
 * remotes and the offline dummies -- and none of them shares a type. This is the
 * whole of the wiring the caller needs: hold the returned prop and call this
 * again with `null` when the talent goes away.
 */
export function setHorns(
  current: HornProp | null,
  wanted: boolean,
  kit: BigNightKit,
  assets: CharacterAssets,
  actor: CharacterActor,
): HornProp | null {
  if (wanted === (current !== null)) return current;
  if (!wanted) {
    current?.dispose();
    return null;
  }
  return new HornProp(kit, assets, actor);
}

/**
 * Point a character's mesh at the body it should be wearing this frame.
 *
 * The whole of the Big Night cactus and of the team tint, from a caller's point
 * of view: three inputs and a geometry swap. It is written as "set the geometry
 * to what these three facts imply" rather than as "change into a cactus" on
 * purpose -- a level-up, a refund, a reconnect and a team choice all land here
 * as the same idempotent assignment, and there is no transition to get wrong.
 *
 * Assigning `mesh.geometry` on a `SkinnedMesh` is safe and is not a rebind: the
 * skeleton, the bind matrix and the bones are all properties of the *mesh*, and
 * three re-reads `geometry.attributes.skinIndex` per draw. The one thing that
 * does have to travel with the geometry is the bounding sphere, and
 * `SkinnedMesh.boundingSphere` -- the one three actually culls against -- is
 * separate again, so it is set here from whichever body was chosen.
 */
export function setTeamBody(
  actor: CharacterActor,
  kit: BigNightKit,
  team: Team,
  bigNight: boolean,
): void {
  const cactus = bigNight && team === TEAM.DEFAULT;
  const geometry = cactus ? kit.cactusFor(actor.colourway, team) : kit.bodyFor(actor.colourway, team);
  if (actor.mesh.geometry === geometry) return;
  actor.mesh.geometry = geometry;
  if (geometry.boundingSphere) actor.mesh.boundingSphere = geometry.boundingSphere.clone();
}
