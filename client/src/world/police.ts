/**
 * What the police look like: a navy kit, a cap, a chequered chest band, and the
 * pool of rigs that draws both tiers of them.
 *
 * The **rendering** half of `game/factions.ts`. That file decides where an
 * officer is and what they are doing and is compiled into the Bun server; this
 * one draws it and imports three. The split is `game/traffic.ts` against
 * `world/cars.ts` exactly, and the reason it matters here is the same: a server
 * that pulled a `SkinnedMesh` in behind a witness query would be a server that
 * imports three, which `server/sim.ts` documents at length as the thing that
 * must not happen.
 *
 * ---------------------------------------------------------------------------
 * WHY THE UNIFORM IS A KIT PLUS TWO PROPS RATHER THAN A NEW FIGURE.
 *
 * The obvious build is a police-shaped mesh: a body with a uniform modelled into
 * it. It is the wrong one, twice over.
 *
 * It would be a **second figure to keep in step with the rig**. Every clip in
 * `player/animation.ts` writes seventeen bones and `verifyCharacterRig` skins
 * every vertex of the figure through every one of them; a second mesh weighted
 * by hand would be a second thing to re-weight the day a bone moves, and the
 * failure when it drifted would be a shoulder that tears open only during a
 * swing.
 *
 * And it would **cost a second geometry in every LOD path**. `PedestrianCrowd`
 * swaps a pooled rig's geometry between seven kits by reference; a figure with a
 * different vertex count could not go through that pool at all.
 *
 * So an officer is the same 1.70 m figure everybody else is, in a colourway that
 * is not in `COLOURWAYS` (see `CharacterAssets.kitGeometry` for why it is not),
 * with two props parented to bones -- `player/bat.BatProp`'s precedent, which is
 * one line per prop and saves a matrix decompose per officer per frame because
 * three composes the skeleton for the skinning anyway.
 *
 * The two props are chosen for what they do at distance rather than for detail:
 *
 *   - the **cap** is the silhouette. At 40 m a navy figure is a dark figure and
 *     nothing else; a peaked cap is the one shape that reads as *police* from
 *     further away than a face does, and it is 60 triangles.
 *   - the **chequer band** is the colour. Navy on navy is invisible in shade, so
 *     the band is a ring of alternating white and mid-blue quads at chest height
 *     -- the Sillitoe tartan every police force in the Commonwealth uses, and
 *     the only high-frequency pattern in this build. It exists because a uniform
 *     has to be identifiable *against a dark shopfront*, which is exactly where a
 *     player will first meet one.
 *
 * ---------------------------------------------------------------------------
 * THE POOL, and why officers get real rigs where pedestrians mostly do not.
 *
 * `world/people.ts` runs fourteen skinned rigs and two hundred impostors,
 * because there are nineteen thousand walkers and only the nearest few can
 * afford a skeleton. There are at most a few dozen officers in view and every
 * one of them is either about to matter or already does, so they all get rigs
 * and there is no impostor tier at all. `SQUAD_CAPACITY` is what bounds it, and
 * it is a *frame* budget rather than a wire one -- `factions.MAX_ACTORS` is the
 * wire's, and the two are deliberately different numbers because ambient
 * officers cost frames and nothing else.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import { BONE, FIGURE_HEIGHT } from '../player/animation.ts';
import {
  CharacterActor,
  SELF_SHADOW_LAYER,
  type CharacterAssets,
  type Colourway,
} from '../player/character.ts';
import {
  NPC_KIND,
  NPC_STATE,
  POLICE_SLOT_BASE,
  createBeatPose,
  forEachPoliceNear,
  type BeatPose,
  type FactionField,
  type NpcActor,
} from '../game/factions.ts';
import { createPedPose, type PedBand, type PedPose, type PedestrianField } from '../game/pedestrians.ts';

// --- The uniform ------------------------------------------------------------------

/**
 * The kit, in the same five roles every other colourway uses.
 *
 * Navy over navy, which is what NSW general duties actually wear and is also the
 * darkest thing in the wardrobe -- deliberately, because the band and the cap
 * are what carry the read and a busy uniform would fight them. The shoes are the
 * black the red/black kit uses; the skin runs mid, because there is one police
 * kit and it cannot be a statement about who police are.
 *
 * Linear, like every colour in `player/character.ts`. The singlet at
 * (0.02, 0.028, 0.075) is display rgb(50,58,84) in sun and rgb(24,27,38) in
 * shade, which is a shade under the darkest sunlit asphalt in the build -- so an
 * officer never disappears into the road and never reads as black.
 */
export const POLICE_KIT: Colourway = {
  name: 'police',
  singlet: [0.02, 0.028, 0.075],
  shorts: [0.016, 0.021, 0.055],
  skin: [0.34, 0.23, 0.17],
  shoe: [0.028, 0.028, 0.03],
};

/** The chequer's two colours, linear. White and a mid police blue. */
const CHEQUER_LIGHT: readonly [number, number, number] = [0.82, 0.85, 0.88];
const CHEQUER_BLUE: readonly [number, number, number] = [0.05, 0.14, 0.44];
/** The cap's peak and crown. Both a touch darker than the singlet, so it reads as a separate object. */
const CAP_CLOTH: readonly [number, number, number] = [0.015, 0.02, 0.055];
const CAP_PEAK: readonly [number, number, number] = [0.02, 0.02, 0.024];

/**
 * A little accumulator for a prop's triangles.
 *
 * The same shape `player/bat.BatParts` and `world/birds.Parts` are, at a
 * quarter of the size, because a cap is a cylinder and a band is a ring and
 * neither needs a lofting engine.
 */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  /**
   * One flat quad, wound `a -> b -> c -> d`.
   *
   * The winding is the whole of what `verifyPoliceKit` checks about this file,
   * because a quad wound the other way is invisible from the side you are
   * looking at and perfectly solid from the side you are not -- which on a chest
   * band means an officer with a stripe that vanishes when they turn around, and
   * reads as a z-fighting artefact rather than as a backwards triangle.
   */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: readonly [number, number, number],
  ): void {
    const base = this.position.length / 3;
    // The face normal from the first triangle, which is what the flat-shaded
    // material would derive anyway -- computed here so a quad can be checked
    // without rasterising it.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (const p of [a, b, c, d]) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(nx, ny, nz);
      this.colour.push(colour[0], colour[1], colour[2]);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colour), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    g.computeBoundingSphere();
    return g;
  }

  get triangles(): number {
    return this.index.length / 3;
  }
}

/** Facets around the cap and the band. Twelve: a dodecagon reads round at 3 m and is 24 quads. */
const RING_SIDES = 12;
/** The band's radius and height in the chest bone's frame, metres. */
const BAND_RADIUS = 0.145;
const BAND_HEIGHT = 0.055;
/** Where the band sits above the chest joint. Sternum height on a 1.70 m figure. */
const BAND_Y = 0.02;

/**
 * The cap, in the **head bone's** frame -- which is not where a head is, and
 * that is the whole of what this block has to get right.
 *
 * `animation.RIG` puts the head joint 1.25 m up (hips 0.86 + spine 0.13 + chest
 * 0.14 + neck 0.07 + head 0.05) and `character.HEAD_CENTRE` puts the skull's
 * *centre* at 1.445 with a vertical radius of 0.25. So in the bone's own frame
 * the head runs from y = -0.055 to y = +0.445, and its centre -- the widest part
 * -- is at +0.195.
 *
 * The first cut of this file put the cap at 0.2, which is exactly the middle of
 * the skull: geometrically perfect, entirely inside the head, and invisible from
 * every angle. It took a screenshot to notice, which is precisely why
 * `verifyPoliceKit` now asserts the cap sits above the head's equator rather
 * than merely above the joint.
 *
 * 0.30 is where a cap band sits on a real skull -- above the ears, below the
 * crown -- and the radius is a shade proud of the head's own half-width at that
 * height (0.185 x sqrt(1 - (0.105/0.25)^2) = 0.168), which is what makes it read
 * as something *worn* rather than as a painted stripe.
 */
const CAP_RADIUS = 0.175;
const CAP_HEIGHT = 0.105;
const CAP_Y = 0.3;
const PEAK_REACH = 0.15;

/**
 * The uniform's geometry, built once and shared by every officer in the city.
 *
 * `CharacterAssets`' contract, with the same consequence for teardown: a squad
 * must never dispose these, because every other officer is drawing them.
 */
export class PoliceAssets {
  /** The figure, in navy. One geometry, shared -- see `CharacterAssets.kitGeometry`. */
  readonly kit: BufferGeometry;
  readonly cap: BufferGeometry;
  readonly band: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;

  constructor(characters: CharacterAssets) {
    this.kit = characters.kitGeometry(POLICE_KIT);

    // --- The chequer band. A ring of quads at chest height, alternating.
    //
    // An odd count would put two of one colour side by side at the seam, which
    // is the one place a chequer stops being a chequer. `RING_SIDES` is twelve
    // and the alternation is `i & 1`, so the seam closes correctly by
    // construction -- and `verifyPoliceKit` asserts the count is even rather
    // than trusting that nobody retunes it to thirteen.
    const band = new Parts();
    for (let i = 0; i < RING_SIDES; i++) {
      const a0 = (i / RING_SIDES) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SIDES) * Math.PI * 2;
      const x0 = Math.sin(a0) * BAND_RADIUS;
      const z0 = Math.cos(a0) * BAND_RADIUS;
      const x1 = Math.sin(a1) * BAND_RADIUS;
      const z1 = Math.cos(a1) * BAND_RADIUS;
      const lo = BAND_Y - BAND_HEIGHT * 0.5;
      const hi = BAND_Y + BAND_HEIGHT * 0.5;
      // Wound so the face normal points **outward**. The ring runs
      // anticlockwise in (x, z) as the angle increases, so bottom-near ->
      // bottom-far -> top-far -> top-near is the outward winding; the reverse is
      // a band you can only see from inside the officer.
      band.quad([x0, lo, z0], [x1, lo, z1], [x1, hi, z1], [x0, hi, z0], i & 1 ? CHEQUER_BLUE : CHEQUER_LIGHT);
    }
    this.band = band.build('police-band');

    // --- The cap. A crown, a flat top, and a peak over the eyes.
    const cap = new Parts();
    for (let i = 0; i < RING_SIDES; i++) {
      const a0 = (i / RING_SIDES) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SIDES) * Math.PI * 2;
      const s0 = Math.sin(a0);
      const c0 = Math.cos(a0);
      const s1 = Math.sin(a1);
      const c1 = Math.cos(a1);
      // The crown, slightly tapered: a cylinder reads as a bucket and a taper
      // reads as a cap. 0.86 is measured off nothing -- it is the smallest taper
      // that survives the flat shading at 20 m.
      const rb = CAP_RADIUS;
      const rt = CAP_RADIUS * 0.86;
      cap.quad(
        [s0 * rb, CAP_Y, c0 * rb],
        [s1 * rb, CAP_Y, c1 * rb],
        [s1 * rt, CAP_Y + CAP_HEIGHT, c1 * rt],
        [s0 * rt, CAP_Y + CAP_HEIGHT, c0 * rt],
        CAP_CLOTH,
      );
      // The top, as a fan of quads collapsed to triangles at the centre. Wound
      // anticlockwise seen from above, which is +Y out.
      cap.quad(
        [0, CAP_Y + CAP_HEIGHT, 0],
        [s0 * rt, CAP_Y + CAP_HEIGHT, c0 * rt],
        [s1 * rt, CAP_Y + CAP_HEIGHT, c1 * rt],
        [0, CAP_Y + CAP_HEIGHT, 0],
        CAP_CLOTH,
      );
    }
    // The peak, over -Z, which is the direction the figure faces. A trapezium,
    // drawn on both sides because it is a single sheet and is seen from below by
    // anybody the officer is standing over.
    {
      const y = CAP_Y + 0.004;
      const hw = CAP_RADIUS * 0.8;
      const tw = CAP_RADIUS * 0.52;
      const near = -CAP_RADIUS * 0.55;
      const far = near - PEAK_REACH;
      cap.quad([-hw, y, near], [hw, y, near], [tw, y, far], [-tw, y, far], CAP_PEAK);
      cap.quad([-tw, y - 0.008, far], [tw, y - 0.008, far], [hw, y - 0.008, near], [-hw, y - 0.008, near], CAP_PEAK);
    }
    this.cap = cap.build('police-cap');
    this.triangles = band.triangles + cap.triangles;

    // Lit, like the bat and the football and unlike a beam: a uniform has no
    // output of its own, so what has to be true of it is that it goes dark when
    // the officer walks into a building's shadow. Slightly glossier than the
    // figure's 0.78, because a cap peak and a reflective band both carry a sheen
    // the cotton next to them does not.
    const material = new MeshStandardNodeMaterial();
    material.name = 'police-kit';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.6;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }
}

/**
 * One officer's cap and band.
 *
 * `player/bat.BatProp`'s precedent in full: parented to a **bone** rather than
 * positioned per frame from a bone's world matrix, which saves a matrix
 * decompose per officer per frame because three composes the skeleton for the
 * skinning anyway. Frustum culling is off for the same reason a bat's is -- a
 * 0.3 m object on a figure that is already frustum-tested has nothing to gain
 * from a test of its own and would need animated bounds to survive a swing.
 */
export class PoliceProps {
  readonly cap: Mesh;
  readonly band: Mesh;

  constructor(assets: PoliceAssets, actor: CharacterActor) {
    this.cap = new Mesh(assets.cap, assets.material);
    this.cap.name = 'police-cap';
    this.cap.castShadow = true;
    this.cap.receiveShadow = true;
    this.cap.frustumCulled = false;
    actor.bones[BONE.HEAD].add(this.cap);

    this.band = new Mesh(assets.band, assets.material);
    this.band.name = 'police-band';
    this.band.castShadow = true;
    this.band.receiveShadow = true;
    this.band.frustumCulled = false;
    actor.bones[BONE.CHEST].add(this.band);
  }

  set visible(v: boolean) {
    this.cap.visible = v;
    this.band.visible = v;
  }

  /** Seen by the sun and not by the eye. See `BatProp.castShadowOnly`: three does not inherit layers. */
  castShadowOnly(): void {
    for (const mesh of [this.cap, this.band]) {
      mesh.layers.set(SELF_SHADOW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    }
  }

  dispose(): void {
    this.cap.removeFromParent();
    this.band.removeFromParent();
  }
}

// --- The squad ---------------------------------------------------------------------

/**
 * Rigs held for officers. A **frame** budget, not the wire's.
 *
 * `factions.MAX_ACTORS` bounds what crosses the network; this bounds what is
 * skinned. They are different numbers because ambient officers -- everybody on
 * a beat who has not been promoted -- cost frames and no bytes at all, so the
 * two counts are not even measuring the same set.
 *
 * Sixteen is the busiest thing this can meet: a pursuit at the wire cap is
 * twenty-four, but they arrive over eight seconds and are spread across the
 * blocks the suspect ran down, so the number actually in the draw radius at once
 * is a fraction of it. Each rig is a `SkinnedMesh`, seventeen bones and two
 * props; `PedestrianCrowd` runs fourteen for nineteen thousand people, which is
 * the measurement this is scaled against.
 */
export const SQUAD_CAPACITY = 16;

/** How far officers are drawn, metres. Inside the crowd's own impostor radius. */
export const POLICE_DRAW_RADIUS = 180;

// --- Where the round leaves ---------------------------------------------------------

/**
 * The aiming arm, and the muzzle at the end of it.
 *
 * ===========================================================================
 * THE REPORT: *"and also the bullets need tro actually have the tracers come
 * from the police's gun"*.
 *
 * `Tracers.fire` used to take its origin from `actor.x + actor.dx * 0.3`,
 * `actor.y + 1.35` -- a point thirty centimetres in front of the officer's feet
 * position at a fixed chest height, which is the same estimate
 * `factions.POLICE.think` puts in the `shot` event. It is a perfectly good
 * *simulation* muzzle: it is deterministic, it costs nothing, and the round's
 * arithmetic does not care. What it is not is a place on the officer. It does
 * not lean with the walk cycle, it does not move when the figure turns its
 * shoulders, and it is thirty centimetres in front of a body whose arms are by
 * its sides -- so at any range a player can actually see an officer at, the
 * tracer starts in mid-air beside them.
 *
 * ---------------------------------------------------------------------------
 * **THE ARM HAD TO COME UP FIRST, AND THAT IS THE HALF THAT IS NOT OBVIOUS.**
 *
 * The rig's arm hangs straight down: `animation.RIG` runs the shoulder 0.33 m
 * to the elbow and 0.31 m to the wrist, both along -Y, and its own header says
 * so in as many words -- *"the arm runs 0.185 m out and then 0.64 m straight
 * down to the wrist, which hangs the mitt level with the knee"*. There is no aim
 * clip in `player/animation.ts` and there should not be one: that file is the
 * player's locomotion and a police pose is not locomotion.
 *
 * So taking the wrist as the muzzle *without* raising the arm would have moved
 * the tracer from a plausible-looking point in mid-air to the officer's **knee**,
 * which is unambiguously worse and would have passed any check that only asked
 * "is the origin on the rig". The arm is raised here, as a two-bone override
 * written straight onto the skeleton after `CharacterActor.update` has posed it
 * -- the standard place for anything that has to happen after a clip and before
 * the skinning -- and the muzzle is the wrist plus a fist's worth of pistol.
 *
 * The two angles are radians about the bone's own X, which is the axis the whole
 * rig's limb clips use. 1.35 at the shoulder brings the upper arm within 13
 * degrees of level and 0.35 at the elbow puts a slight bend in it, which lands
 * the wrist at about 1.12 m -- an inch under the shoulder joint, which is where
 * a hand holding a pistol at arm's length actually is -- and 0.63 m in front of
 * the chest.
 *
 * **What only eyes can judge**: whether an officer at *one* star, who by
 * `factions.POLICE_ARMED_STARS` is holding `NPC_STATE.AIM` with no weapon at
 * all, reads as pointing a pistol or as putting a hand up to say stop. The
 * state byte carries no distinction and the client cannot infer one for a
 * pursuit that is not the local player's, so the arm goes up for both. It is a
 * one-line change to gate it on the shot if the owner looks and disagrees.
 */
const AIM_SHOULDER_X = 1.35;
const AIM_ELBOW_X = 0.35;

/**
 * How far in front of the wrist the muzzle is, metres.
 *
 * A pistol held in a fist puts the barrel's end about a hand's length past the
 * wrist joint, and the round leaves the end of the barrel. It is along the
 * **figure's facing** rather than along the forearm because that is the
 * direction the shot was aimed in -- `POLICE.think` squares the actor's heading
 * onto the suspect before it fires, and the arm is posed to that heading -- and
 * because a bend at the elbow should not be able to point the tracer somewhere
 * the round did not go.
 *
 * Twelve centimetres, which is inside `MUZZLE_MAX_FROM_HAND_M`: the check below
 * asserts that the origin this produces is a point *on the officer's hand*
 * rather than a point in front of them that happens to be near it.
 */
export const MUZZLE_FORWARD_M = 0.12;

/**
 * How far the muzzle may be from the hand node before it has stopped being the
 * officer's gun, metres. `verifyPoliceKit` asserts it.
 *
 * Fifteen centimetres is a pistol. The number exists so that the failure this
 * whole section is about -- an origin that drifts back to a fixed offset from
 * the body, or to a bone that is not the hand -- is convicted by arithmetic
 * rather than by somebody looking at a tracer and thinking it seems fine.
 */
export const MUZZLE_MAX_FROM_HAND_M = 0.15;

/** Scratch for the muzzle query. One per module: `muzzle` is called once a shot. */
const MUZZLE_HAND = new Vector3();

/**
 * Put the aiming arm on a posed rig. **After `CharacterActor.update`, always.**
 *
 * Two bone rotations and nothing else, which is what keeps this compatible with
 * every clip: `applyToBones` writes all seventeen bones from the blended pose on
 * every frame, so this is overwritten and rewritten each time and there is no
 * state to get out of step. The officer still walks, still bobs, still turns --
 * they simply do it with one arm up.
 */
function poseAimArm(actor: CharacterActor): void {
  actor.bones[BONE.SHOULDER_R].rotation.set(AIM_SHOULDER_X, 0, 0);
  actor.bones[BONE.ELBOW_R].rotation.set(AIM_ELBOW_X, 0, 0);
}

/**
 * The world position of the gun at the end of a posed rig's aiming arm.
 *
 * `updateMatrixWorld` is forced rather than assumed, and that is the one line
 * here that is load-bearing: three composes a skeleton during render, and this
 * is asked from the frame loop *before* the render on the frame a shot arrives.
 * Without it the muzzle is one frame stale, which at `CHASE_SPEED` is ten
 * centimetres and at a snapshot boundary is more -- and the symptom is a tracer
 * that starts just behind the hand it came out of, which is the original report
 * in a smaller size.
 *
 * One rig, once per shot fired: `FIRE_INTERVAL_TICKS` is 54 ticks and the actor
 * cap is 24, so the worst case is a few dozen matrix composes a second against a
 * skeleton three composes for the skinning anyway.
 */
export function muzzleOf(actor: CharacterActor, out: { x: number; y: number; z: number }): void {
  actor.mesh.updateMatrixWorld(true);
  actor.bones[BONE.WRIST_R].getWorldPosition(MUZZLE_HAND);
  // The figure's own forward. Yaw 0 faces -Z -- `CharacterActor.update` sets
  // `mesh.rotation.y` and nothing else, so this is exact and needs no matrix.
  const yaw = actor.mesh.rotation.y;
  out.x = MUZZLE_HAND.x - Math.sin(yaw) * MUZZLE_FORWARD_M;
  out.y = MUZZLE_HAND.y;
  out.z = MUZZLE_HAND.z - Math.cos(yaw) * MUZZLE_FORWARD_M;
}

/** One pooled rig, and the officer it currently stands in for. */
interface Slot {
  actor: CharacterActor;
  props: PoliceProps;
  /** The officer's stable key, or -1 for a free slot. */
  key: number;
  /** Whether `setAction('knockout')` is currently held on it. */
  down: boolean;
}

/**
 * What the squad was asked to draw this frame. Structure of arrays; allocates
 * nothing.
 *
 * **Raised from 64 with the patrol lattice**, and the reason is a bug rather
 * than a budget. `gather` fills these arrays in *iteration order* and stops at
 * the cap, while `assign` hands the sixteen rigs to the **nearest** of whatever
 * was gathered -- so a truncated gather does not merely draw fewer officers, it
 * can drop the pair standing next to the player in favour of one two blocks away
 * that happened to be visited first. Before the lattice the busiest measured
 * point in the city held 29 officers inside 180 m and the cap was unreachable;
 * `factions.forEachPatrolNear` adds up to sixteen cells of patrols on top of
 * that, which puts the CBD within reach of it.
 *
 * Ninety-six is eight `Float64Array`s thirty-two longer -- two kilobytes, once,
 * for the life of the process -- against a failure that would have read as the
 * police rendering the wrong people.
 */
const VISIBLE = 96;

/**
 * Every officer in view, ambient and promoted, as pooled skinned rigs.
 *
 * `update` allocates nothing. Not parented to a tile, on `TrafficMovers`' own
 * argument: an officer crosses a tile boundary every couple of minutes and the
 * squad is drawn as one set for the whole visible world.
 */
export class PoliceSquad {
  /** Add these to the scene. One per pooled rig. */
  readonly rigs: CharacterActor[] = [];

  /** Officers posed last update, and how long it took. Read by the HUD. */
  beats = 0;
  actors = 0;
  costMs = 0;

  private readonly slots: Slot[] = [];
  private readonly bands: PedBand[] = [];
  private readonly ped: PedPose = createPedPose();
  private readonly beat: BeatPose = createBeatPose();

  private readonly vKey = new Float64Array(VISIBLE);
  private readonly vX = new Float64Array(VISIBLE);
  private readonly vY = new Float64Array(VISIBLE);
  private readonly vZ = new Float64Array(VISIBLE);
  private readonly vDx = new Float64Array(VISIBLE);
  private readonly vDz = new Float64Array(VISIBLE);
  private readonly vDist2 = new Float64Array(VISIBLE);
  private readonly vState = new Int32Array(VISIBLE);
  private readonly vSpeed = new Float64Array(VISIBLE);
  private visible = 0;

  constructor(assets: PoliceAssets, characters: CharacterAssets) {
    for (let i = 0; i < SQUAD_CAPACITY; i++) {
      // The navy geometry rather than a colourway index. See
      // `CharacterActor`'s constructor for why the override exists.
      const actor = new CharacterActor(characters, 0, assets.kit);
      actor.mesh.name = `police:${i}`;
      actor.mesh.visible = false;
      const props = new PoliceProps(assets, actor);
      props.visible = false;
      this.rigs.push(actor);
      this.slots.push({ actor, props, key: -1, down: false });
    }
  }

  /**
   * Place every officer in view, at `tick` plus a frame fraction.
   *
   * `tick` may be fractional -- `TrafficMovers.update`'s split, for the same
   * reason: the witness test runs on whole ticks so this client and the server
   * ask the identical question, and the *picture* runs between them so a 144 Hz
   * display does not watch 60 Hz people.
   *
   * `dt` is the frame delta, for the rigs' own animation clocks. Presentation
   * runs on the frame and simulation runs on the tick, which is `main.ts`'s rule
   * about every actor in this project.
   */
  update(
    peds: PedestrianField | null,
    field: FactionField | { actors: Iterable<NpcActor> },
    tick: number,
    dt: number,
    x: number,
    z: number,
  ): void {
    const at = performance.now();
    this.gather(peds, field, tick, x, z);
    this.assign();
    this.pose(dt);
    this.costMs = performance.now() - at;
  }

  /**
   * Everybody in view into the visible arrays, promoted actors **first**.
   *
   * The order is the priority: when there are more officers in view than there
   * are rigs, the ones chasing somebody are the ones that get drawn. A pursuit
   * that ran out of rigs and drew the pair strolling past instead would be the
   * one frame where this feature looked broken.
   */
  private gather(
    peds: PedestrianField | null,
    field: { actors: Iterable<NpcActor> },
    tick: number,
    x: number,
    z: number,
  ): void {
    let n = 0;
    const r2 = POLICE_DRAW_RADIUS * POLICE_DRAW_RADIUS;
    let actors = 0;
    for (const a of field.actors) {
      if (n >= VISIBLE) break;
      // **Officers only.** `FactionField.actors` is shared by every faction --
      // that is the whole point of it -- so a squad that drew what it was handed
      // would put a meth head in a navy uniform with a cap on, and the failure
      // would read as the police spawning in Redfern rather than as a missing
      // filter. `world/streetlife.ts` makes the same test for its own kinds.
      if (a.kind !== NPC_KIND.POLICE) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      this.vKey[n] = -a.id;
      this.vX[n] = a.x;
      this.vY[n] = a.y;
      this.vZ[n] = a.z;
      this.vDx[n] = a.dx;
      this.vDz[n] = a.dz;
      this.vDist2[n] = d2;
      this.vState[n] = a.state;
      // The gait comes from the state rather than from a measured speed,
      // because a promoted officer's position arrives interpolated between two
      // snapshots and differencing it per frame reports a walk as a sprint on a
      // slow frame -- `RemotePlayer.speed` documents the same trap. The states
      // are discrete and the authority already resolved them.
      this.vSpeed[n] =
        a.state === NPC_STATE.CHASE ? 6.4 : a.state === NPC_STATE.RETURN ? 3.0 : 0;
      n++;
      actors++;
    }
    this.actors = actors;

    let beats = 0;
    if (peds) {
      forEachPoliceNear(peds, x, z, POLICE_DRAW_RADIUS, tick, this.bands, this.ped, this.beat, (p) => {
        if (n >= VISIBLE) return true;
        const dx = p.x - x;
        const dz = p.z - z;
        this.vKey[n] = p.key;
        this.vX[n] = p.x;
        this.vY[n] = p.y;
        this.vZ[n] = p.z;
        this.vDx[n] = p.dx;
        this.vDz[n] = p.dz;
        this.vDist2[n] = dx * dx + dz * dz;
        this.vState[n] = NPC_STATE.WALK;
        // The beat's own pace, off the pedestrian schedule this officer is a
        // reserved slot of. Zero means they are in the dwell between traversals
        // and are standing still, which is a pair of officers having a look at
        // something and is exactly right.
        this.vSpeed[n] = this.ped.speed;
        n++;
        beats++;
      });
    }
    this.beats = beats;
    this.visible = n;
  }

  /**
   * Hand the nearest officers a rig, keeping the ones already assigned.
   *
   * `PedestrianCrowd.assign`'s two passes and no sort: the first keeps every
   * slot whose officer is still in view, which is the hysteresis that stops a
   * rig being handed back and forth between two people at the same distance; the
   * second fills what is left with the nearest unassigned officer. O(slots x
   * visible), which is sixteen times a few dozen.
   */
  private assign(): void {
    const taken = new Set<number>();
    for (const slot of this.slots) {
      if (slot.key < 0) continue;
      let still = false;
      for (let i = 0; i < this.visible; i++) {
        if (this.vKey[i] === slot.key) {
          still = true;
          break;
        }
      }
      if (still) taken.add(slot.key);
      else slot.key = -1;
    }
    for (const slot of this.slots) {
      if (slot.key >= 0) continue;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.visible; i++) {
        if (taken.has(this.vKey[i])) continue;
        if (this.vDist2[i] >= bestD) continue;
        bestD = this.vDist2[i];
        best = i;
      }
      if (best < 0) break;
      slot.key = this.vKey[best];
      taken.add(slot.key);
    }
  }

  /** Drive every assigned rig, and hide the rest. */
  private pose(dt: number): void {
    for (const slot of this.slots) {
      if (slot.key < 0) {
        if (slot.actor.mesh.visible) {
          slot.actor.mesh.visible = false;
          slot.props.visible = false;
        }
        continue;
      }
      let i = -1;
      for (let k = 0; k < this.visible; k++) {
        if (this.vKey[k] === slot.key) {
          i = k;
          break;
        }
      }
      if (i < 0) continue;
      slot.actor.mesh.visible = true;
      slot.props.visible = true;

      const state = this.vState[i];
      const down = state === NPC_STATE.DOWN;
      if (down !== slot.down) {
        slot.down = down;
        // `knockout` holds until something clears it, which is the property
        // `ReactionName` documents and is exactly what a five-second downtime
        // wants -- there is no clock here that has to agree with the server's.
        slot.actor.setAction(down ? 'knockout' : null);
      }
      slot.actor.update(dt, {
        position: { x: this.vX[i], y: this.vY[i], z: this.vZ[i] },
        // Yaw 0 faces -Z, so the yaw that sends the figure's forward to
        // (dx, dz) is `atan2(-dx, -dz)`. One `atan2` per drawn officer per
        // frame, entirely on the presentation side -- see
        // `game/factions.ts`'s determinism rule.
        yaw: Math.atan2(-this.vDx[i], -this.vDz[i]),
        speed: down ? 0 : this.vSpeed[i],
        onGround: true,
      });
      // --- And the weapon up, for an officer who has squared up or just fired.
      //
      // **After `update`, which writes all seventeen bones**, so this is an
      // override rather than a blend and there is nothing to keep in step. See
      // `poseAimArm` and `AIM_SHOULDER_X`, which carry the argument -- including
      // the half that is really about the tracer: the round leaves the hand, and
      // the hand had to be somewhere a round could leave from.
      if (state === NPC_STATE.AIM || state === NPC_STATE.FIRE || state === NPC_STATE.FIRE_MISS) {
        poseAimArm(slot.actor);
      }
    }
  }

  /**
   * Where a promoted officer's gun is, in world metres. False if they are not
   * on a rig this frame.
   *
   * **False is a real answer and the caller has to have one**: `SQUAD_CAPACITY`
   * is sixteen and `POLICE_DRAW_RADIUS` is 180 m, so an officer firing from
   * behind you in a busy CBD block may have no skeleton at all in this process.
   * `main.ts` falls back to the simulation's own muzzle estimate, which is the
   * point the `shot` event already carries -- a tracer from an approximate place
   * is right for somebody you cannot see, and wrong for somebody you can.
   *
   * Keyed on `-actorId`, which is `gather`'s encoding: a promoted actor's key is
   * the negative of its id and an ambient officer's is a positive `pedKey`, so
   * the two tiers cannot collide in the slot table.
   */
  muzzle(actorId: number, out: { x: number; y: number; z: number }): boolean {
    for (const slot of this.slots) {
      if (slot.key !== -actorId) continue;
      if (!slot.actor.mesh.visible) return false;
      muzzleOf(slot.actor, out);
      return true;
    }
    return false;
  }

  /**
   * Release the rigs. **Not the shared geometry or the material**, which are
   * `PoliceAssets`' and are drawn by every officer in the city -- the trap
   * `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const slot of this.slots) {
      slot.props.dispose();
      slot.actor.mesh.removeFromParent();
    }
  }
}

// --- Tracers --------------------------------------------------------------------------

/**
 * The flash between a muzzle and wherever the round went.
 *
 * A **cosmetic** object entirely -- the shot was decided on the authority the
 * instant the state byte turned over, and this is drawn afterwards to say so.
 * That is the opposite of the raygun this project used to have, whose beam
 * carried the two endpoints on the wire in a reliable event *because a hitscan
 * leaves nothing behind*: if the event was lost, the shot never happened on that
 * client. Nothing here can be lost, because the thing being drawn is derived
 * from a state that arrives in a snapshot twenty times a second.
 *
 * Pooled and stretched rather than rebuilt: one unit-length box geometry, and a
 * tracer is that box scaled along Z to the range and rotated onto the line. A
 * fresh geometry per shot would be an allocation per trigger pull forever.
 *
 * `TRACER_SECONDS` is 55 ms, which is about three frames at 60 Hz. Long enough
 * to be seen and far too short to be looked at, which is what a tracer is: the
 * eye reconstructs a line from a flash it never actually resolved, and anything
 * over about 100 ms stops reading as a bullet and starts reading as a laser.
 */
const TRACER_SECONDS = 0.055;
const TRACER_POOL = 12;
const TRACER_HALF_WIDTH = 0.022;

interface Tracer {
  mesh: Mesh;
  /** Seconds left, or 0 for a free slot. */
  life: number;
}

export class Tracers {
  /** Add this to the scene. One mesh per pooled tracer. */
  readonly meshes: Mesh[] = [];
  private readonly pool: Tracer[] = [];
  /**
   * Public so `policeWarmupParts` can name the pair. A tracer's shader is
   * compiled the frame the first shot is fired unless the boot warm-up gets it,
   * and the warm-up must be handed the **shared instances** rather than copies --
   * see `world/warmup.ts`.
   */
  readonly material: MeshStandardNodeMaterial;
  readonly geometry: BufferGeometry;
  private cursor = 0;

  constructor() {
    // A unit box from the origin along -Z, so a tracer is one scale and one
    // `lookAt`. Built here rather than borrowed from `PoliceAssets` because it
    // is the only thing in this file that is not part of a uniform.
    const parts = new Parts();
    const h = TRACER_HALF_WIDTH;
    const hot: readonly [number, number, number] = [3.4, 2.4, 1.1];
    // Four sides of a square section, wound outward. No caps: a tracer is seen
    // from the side and a cap is two triangles nobody looks at.
    const ring: Array<[number, number]> = [[-h, -h], [h, -h], [h, h], [-h, h]];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % 4];
      parts.quad([x0, y0, 0], [x1, y1, 0], [x1, y1, -1], [x0, y0, -1], hot);
    }
    this.geometry = parts.build('tracer');

    // Emissive rather than lit, and it is the one object in this feature that
    // is: a tracer *is* the light. The albedo is near-black so it contributes
    // nothing in shade, and the emission carries it -- which is what stops a
    // tracer looking like a painted stick when the officer firing it is standing
    // under an awning.
    this.material = new MeshStandardNodeMaterial();
    this.material.name = 'tracer';
    this.material.vertexColors = true;
    this.material.color = new Color(0.02, 0.02, 0.02);
    this.material.emissive = new Color(2.6, 1.7, 0.7);
    this.material.roughness = 1;
    this.material.metalness = 0;
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.flatShading = true;

    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new Mesh(this.geometry, this.material);
      mesh.name = `tracer:${i}`;
      mesh.visible = false;
      // Never casts. A 55 ms object in a shadow map is a shadow nobody sees and
      // a pipeline variant nobody needed.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.pool.push({ mesh, life: 0 });
    }
  }

  /**
   * Draw one, from an officer's muzzle to where the round went.
   *
   * Round-robin rather than first-free: at `FIRE_INTERVAL_TICKS` apart a pool of
   * twelve cannot be exhausted by fewer than thirteen simultaneous officers,
   * which is past the actor cap in any case, and overwriting the oldest is both
   * cheaper and the correct behaviour if it ever happened.
   */
  fire(
    actor: NpcActor,
    target: { x: number; y: number; z: number },
    /**
     * The gun, if the officer is on a rig this frame. See `PoliceSquad.muzzle`.
     *
     * **An argument rather than a lookup**, because this class does not own a
     * squad and should not: `Tracers` is twelve boxes and a pool, it is built in
     * `main.ts` four hundred lines before the squad is, and a renderer that
     * reached across to another renderer to find out where to draw would be the
     * one edge in this feature that has to be kept in step by hand.
     *
     * Optional, and absent falls back to the estimate this used to compute
     * unconditionally: `actor.dx * 0.3` in front of the feet at 1.35 m, which is
     * the same muzzle `factions.POLICE.think` puts in the `shot` event. That is
     * the right answer for an officer with no skeleton in this process -- see
     * `PoliceSquad.muzzle`, which returns false for exactly that case.
     */
    muzzle?: { x: number; y: number; z: number },
  ): void {
    const t = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    const mx = muzzle ? muzzle.x : actor.x + actor.dx * 0.3;
    const my = muzzle ? muzzle.y : actor.y + 1.35;
    const mz = muzzle ? muzzle.z : actor.z + actor.dz * 0.3;
    t.mesh.position.set(mx, my, mz);
    t.mesh.lookAt(target.x, target.y, target.z);
    // The box runs one metre along -Z, which is what `lookAt` points; scaling z
    // to the range stretches it exactly onto the line. The other two axes stay
    // at 1 so a tracer is the same width at 5 m and at 35.
    //
    // **Measured from the origin this tracer is actually drawn from**, which it
    // used to be handed as an argument. That was correct exactly while there was
    // one possible origin: the moment the muzzle can be the rig's hand *or* the
    // estimate, a length computed by the caller against one of them and a
    // position set here from the other is a tracer that stops short of, or
    // reaches past, where the round went -- and the error is a few tenths of a
    // metre, which is precisely the size that reads as sloppy rather than as
    // wrong. There is one origin and it is three lines up.
    const dx = target.x - mx;
    const dy = target.y - my;
    const dz = target.z - mz;
    t.mesh.scale.set(1, 1, Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz)));
    t.mesh.visible = true;
    t.life = TRACER_SECONDS;
  }

  update(dt: number): void {
    for (const t of this.pool) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.life = 0;
        t.mesh.visible = false;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- The self-check ------------------------------------------------------------------

/**
 * The uniform, checked for the two ways it fails without throwing.
 *
 * Both are invisible from the camera the developer is sitting in, which is this
 * project's whole criterion:
 *
 *   - **A prop wound inside out** is a cap you can see through from in front and
 *     not from behind, or a chest band that vanishes when an officer turns
 *     around. From any single frame it reads as a z-fighting artefact or as the
 *     officer being lit oddly, and it is the exact failure `world/bike.ts` and
 *     `player/bat.ts` both have a winding assertion for.
 *   - **A chequer with an odd number of facets** puts two of one colour side by
 *     side at the seam, which stops being a chequer at exactly the one place
 *     nobody photographs.
 *
 * And one that is not about geometry at all: **a cap parented so low that it
 * intersects the shoulders**, which at 40 m is an officer with no head.
 */
export function verifyPoliceKit(assets: PoliceAssets, characters?: CharacterAssets): string[] {
  const failures: string[] = [];

  if (RING_SIDES % 2 !== 0) {
    failures.push(
      `The chequer band has ${RING_SIDES} facets. An odd count puts two of one colour together at the ` +
        'seam, which is the one place a chequer stops being a chequer.',
    );
  }

  // --- Every band quad's normal points away from the figure's axis.
  //
  // The test is the dot of the face normal with the outward radial direction at
  // the quad's own centre, which is the only formulation that works for a ring:
  // "outward" is a different direction for every facet.
  for (const [name, geometry, axis] of [
    ['band', assets.band, true],
    ['cap', assets.cap, false],
  ] as Array<[string, BufferGeometry, boolean]>) {
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const idx = geometry.getIndex();
    if (!pos || !nrm || !idx) {
      failures.push(`The police ${name} is missing an attribute; it cannot be drawn.`);
      continue;
    }
    if (pos.count === 0 || idx.count === 0) {
      failures.push(`The police ${name} has no triangles in it; officers would be bare-headed and still shoot.`);
      continue;
    }
    if (!axis) continue;
    let inward = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const i = idx.getX(t);
      const cx = pos.getX(i);
      const cz = pos.getZ(i);
      const r = Math.sqrt(cx * cx + cz * cz);
      if (r < 1e-6) continue;
      const dot = (nrm.getX(i) * cx + nrm.getZ(i) * cz) / r;
      if (dot < 0) inward++;
    }
    if (inward > 0) {
      failures.push(
        `${inward} of the police ${name}'s triangles face inward. A band wound the wrong way is ` +
          'invisible from outside the officer and solid from inside them.',
      );
    }
  }

  // --- The cap is on the head rather than inside it.
  //
  // The assertion this file most needed and least expected to. `BONE.HEAD`'s
  // origin is at the *base* of the skull, not at its centre: the head runs from
  // y = -0.055 to +0.445 in that bone's frame with its widest point at +0.195 --
  // see the `CAP_Y` note. A cap placed at a plausible-sounding 0.2 is dead
  // centre inside the head and cannot be seen from any angle, which renders as
  // an officer in a navy singlet and nothing else. It looks like the prop was
  // never parented rather than like it was parented one number wrong, and no
  // amount of reading the code finds it.
  //
  // So the test is against the head's **equator**, not against the joint.
  {
    const pos = assets.cap.getAttribute('position');
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      lowest = Math.min(lowest, pos.getY(i));
      highest = Math.max(highest, pos.getY(i));
    }
    if (lowest < 0.22) {
      failures.push(
        `The cap's lowest point is ${lowest.toFixed(3)} m above the head joint, at or below the skull's ` +
          'widest point (0.195). It would be inside the head and invisible from every angle.',
      );
    }
    if (highest > 0.5) {
      failures.push(`The cap reaches ${highest.toFixed(3)} m, well over the crown at 0.445. It would float.`);
    }
  }

  // --- The kit geometry is a real figure and shares the rig's skinning.
  {
    const skin = assets.kit.getAttribute('skinIndex');
    if (!skin) {
      failures.push('The police kit geometry carries no skin indices; the uniform cannot follow the rig.');
    }
    if (assets.kit.getAttribute('color') === undefined) {
      failures.push('The police kit geometry has no colour attribute; every officer would be white.');
    }
  }

  // --- And the slot reservation, which is where a uniform meets a schedule.
  if (POLICE_SLOT_BASE < 40) {
    failures.push('The police beat slots overlap the pedestrian range; an officer and a bystander share an identity.');
  }

  // --- The muzzle, on a rig that is actually posed. See below.
  if (characters !== undefined) failures.push(...verifyMuzzle(characters, assets));

  return failures;
}

/**
 * **The tracer comes out of the gun**, asserted against a posed skeleton.
 *
 * The owner: *"and also the bullets need tro actually have the tracers come from
 * the police's gun"*. The three ways that can be false all render a frame
 * nobody would file a bug about:
 *
 *   - **The origin drifts back to a body offset.** A fixed point in front of the
 *     feet at a fixed height is what this replaced, and it is the one that looks
 *     nearly right: at 40 m a tracer starting 30 cm beside an officer is a
 *     tracer starting at an officer. This measures the distance from the *hand*,
 *     so an origin that stops following the arm is convicted by a number.
 *   - **The wrong bone.** `BONE.WRIST_L` type-checks perfectly and puts every
 *     round through the officer's other hand, which nobody sees because the
 *     tracer is 55 ms long.
 *   - **The arm never came up.** Without `poseAimArm` the wrist hangs level with
 *     the knee -- `animation.RIG` says so -- so an origin that is genuinely on
 *     the hand is genuinely at knee height and shooting up at you. That is the
 *     one this whole section exists for, and it is why the second assertion is
 *     *forward of the chest* rather than merely *near the hand*.
 *
 * A real `CharacterActor` is built and posed rather than the arithmetic being
 * repeated: what is being tested is the composition of the rig, the two bone
 * overrides and the forward offset, and a check that recomputed the chain by
 * hand would be asserting its own copy of it. Three geometry, no context, no
 * scene -- `PoliceSquad`'s constructor already builds sixteen of these at boot.
 */
function verifyMuzzle(characters: CharacterAssets, assets: PoliceAssets): string[] {
  const failures: string[] = [];
  const actor = new CharacterActor(characters, 0, assets.kit);
  // Standing still at the origin, facing yaw 0 -- which is -Z. Anything else
  // would make the "forward of the chest" test a statement about a rotation.
  actor.update(1 / 60, { position: { x: 0, y: 0, z: 0 }, yaw: 0, speed: 0, onGround: true });
  poseAimArm(actor);

  const muzzle = { x: 0, y: 0, z: 0 };
  muzzleOf(actor, muzzle);

  const hand = new Vector3();
  const chest = new Vector3();
  actor.mesh.updateMatrixWorld(true);
  actor.bones[BONE.WRIST_R].getWorldPosition(hand);
  actor.bones[BONE.CHEST].getWorldPosition(chest);

  const fromHand = Math.sqrt(
    (muzzle.x - hand.x) ** 2 + (muzzle.y - hand.y) ** 2 + (muzzle.z - hand.z) ** 2,
  );
  if (fromHand > MUZZLE_MAX_FROM_HAND_M) {
    failures.push(
      `The tracer's origin is ${fromHand.toFixed(3)} m from the officer's hand, past the ` +
        `${MUZZLE_MAX_FROM_HAND_M} m a pistol is. It is a point near the officer rather than a point on them.`,
    );
  }
  // Forward is -Z at yaw 0, so "in front of the chest" is a smaller z than the
  // chest's. Half a metre of margin would be a claim about the arm's length;
  // this asks only that the round leaves in front of the body rather than out
  // of its back or its side.
  if (!(muzzle.z < chest.z - 0.2)) {
    failures.push(
      `The muzzle is at z=${muzzle.z.toFixed(3)} against a chest at ${chest.z.toFixed(3)}: it is not in front ` +
        'of the officer. The aiming arm has not been applied, so the round is leaving from a hand hanging at ' +
        'the knee -- see AIM_SHOULDER_X.',
    );
  }
  // And it is at something like weapon height rather than at knee height, which
  // is the same failure measured the other way and is the one a reader of a
  // single frame would put down to perspective.
  if (!(muzzle.y > 0.9 && muzzle.y < 1.5)) {
    failures.push(
      `The muzzle is ${muzzle.y.toFixed(3)} m off the ground on a ${FIGURE_HEIGHT} m figure. A pistol held ` +
        'out is between 0.9 and 1.5; the knee this rig rests its wrist at is 0.46.',
    );
  }
  actor.mesh.removeFromParent();
  return failures;
}

/**
 * The police kit's own pipelines, as warm-up parts.
 *
 * The **cap and the band** rather than the body: an officer's body is a
 * `CharacterActor`, whose skinned pipeline the warm-up already compiles from a
 * throwaway actor, and `kitGeometry` produces the same attribute layout as every
 * other kit so the swap in `PoliceSquad` costs no compile. The two props are the
 * part nothing else in the game covers -- plain `Mesh`es on a material this file
 * owns -- and the tracers likewise.
 *
 * Both receive variants for the props, because a cap is parented to a head whose
 * `receiveShadow` follows the actor's, and `CharacterActor` builds bodies
 * receiving while `castShadowOnly` turns it off for the local player's own.
 */
export function policeWarmupParts(assets: PoliceAssets, tracers: Tracers): WarmupPart[] {
  return [
    { geometry: assets.cap, material: assets.material, casts: true },
    { geometry: assets.band, material: assets.material, casts: true },
    // A tracer is an emissive sliver drawn for two frames. It neither casts nor
    // receives, and without this entry the first shot fired in the session
    // compiles a pipeline inside the frame that shot is supposed to be read on.
    { geometry: tracers.geometry, material: tracers.material, casts: false, receives: [false] },
  ];
}
