/**
 * Drawing the crowd: what a pedestrian looks like at two distances.
 *
 * `game/pedestrians.ts` answers *where* everybody is -- a schedule lookup with no
 * state in it -- and this file is the half that costs frame time. It is the whole
 * of the engineering in this feature, because the schedule is free and the
 * figures are not.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET, AND WHY THERE ARE TWO TIERS.
 *
 * The character rig is 440 triangles and **seventeen bones**, and the bones are
 * the cost rather than the triangles: `CharacterActor.update` evaluates up to
 * four clips, blends them into a pose, writes 17 bone rotations and lets three
 * recompute 17 world matrices and 17 skinning matrices, then draws it as its own
 * `SkinnedMesh` -- one draw call per person, which is the part that does not
 * scale at all. Nineteen thousand people exist in the built world at any instant
 * (`checkPedestrians` reports the figure) and about fifty are inside the far draw
 * radius on a Sydney street. Fifty skinned meshes is fifty draw calls and fifty
 * skeletons, for extras nobody is looking at.
 *
 * So there are two tiers, and the split is at the distance a skeleton stops being
 * legible:
 *
 *   - **Near, inside `RIG_TAKE`.** Real `CharacterActor`s, driven through the
 *     existing public animation API with the walk clip the rig already has.
 *     `RIG_CAPACITY` of them, pooled and reassigned to the nearest walkers, with
 *     `RIG_KEEP`'s hysteresis so a figure at the boundary does not flip tiers
 *     every time the player sways.
 *   - **Far, out to `IMPOSTOR_RADIUS`.** Six instanced sets and a 120-triangle
 *     figure whose legs swing by *instance matrix* rather than by skinning --
 *     which is the trick that makes the far tier possible at all, because it
 *     costs three `Matrix4.compose` calls and no skeleton.
 *
 * At 55 m a 1.7 m figure is about 26 pixels tall on a 1080p display at this
 * game's 72-degree field. A swinging leg is five pixels of travel; a *knee* is
 * one. That is the entire argument for where the line is: the impostor keeps the
 * thing you can see at that size (a silhouette, a gait, a colour) and throws away
 * the thing you cannot (joints).
 *
 * **Measured, on Cleveland Street in Darlington with 53 people posed and 11 of
 * them on rigs: 0.17 ms a frame, peaking at 0.30.** Against a 2 ms budget. The
 * far tier is close to free -- three matrix composes and a schedule lookup each
 * -- and what the number is really measuring is the eleven skeletons, which is
 * exactly where a crowd's budget should be going.
 *
 * ---------------------------------------------------------------------------
 * SIX INSTANCED SETS, WHICH LOOKS LIKE FOUR TOO MANY.
 *
 * It is one set per *part*: torso, bare skin, and two halves of each leg. The
 * reason is `instanceColor`, and it is the same wall `world/cars.ts` documents
 * from the other side.
 *
 * `instanceColor` multiplies the **whole object**, so a single-mesh pedestrian
 * can carry exactly one per-person colour. A car gets away with that -- its glass
 * and tyres are a vertex colour and dark times anything is dark. A person does
 * not: the singlet, the shorts and the skin are three *independent* per-person
 * colours of similar brightness, and multiplying all three by one tint gives a
 * figure in a red shirt red legs. Splitting by part gives each one its own
 * `instanceColor` and makes the far tier's palette exactly the near tier's --
 * which is what the handoff needs, because the thing that would give a tier swap
 * away is not the geometry, it is somebody changing clothes.
 *
 * The split costs six draw calls for the entire crowd and **three** matrix
 * composes a person, because the torso and the bare skin share one transform and
 * the two halves of each leg share the leg's.
 *
 * ---------------------------------------------------------------------------
 * THE ARMS DO NOT SWING, AND THAT IS DELIBERATE.
 *
 * They hang from the torso as part of its own geometry. Swinging them would mean
 * two more instanced sets and two more transforms for a motion five pixels wide
 * at the distance this tier starts, where the legs' is five pixels *of a
 * silhouette that has nothing else moving in it*. The near tier's rig swings
 * everything, and the handoff distance is chosen so that the difference arrives
 * with the joints.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import { CharacterActor, COLOURWAYS, type CharacterAssets } from '../player/character.ts';
import { FIGURE_HEIGHT, HIP_HEIGHT, strideLength } from '../player/animation.ts';
import {
  PedestrianField,
  createPedPose,
  forEachPedestrianNear,
  type PedBand,
  type PedPose,
} from '../game/pedestrians.ts';
import { uploadInstances } from './instupload.ts';

// --- The figure ----------------------------------------------------------------

/**
 * The impostor's proportions, metres, measured off the real rig so the two tiers
 * are the same person.
 *
 * `animation.FIGURE_HEIGHT` is 1.7 and `animation.HIP_HEIGHT` is where the legs
 * start; both are restated as literals here rather than imported, because these
 * are a *stand-in's* dimensions and pinning them to the rig's constants would
 * make a change to the skeleton silently resize a box that is not skinned to it.
 * `verifyPedestrianModel` asserts the two agree to within a couple of
 * centimetres, which is the right relationship: checked, not shared.
 */
const HIP_Y = 0.815;
const TORSO_TOP = 1.46;
/** Two centimetres inside the torso, so the neck is never a gap at any angle. */
const HEAD_BOTTOM = 1.44;
const HEAD_TOP = 1.70;
const SHOULDER_Y = 1.38;
const HAND_Y = 0.95;
/** Half the gap between the two legs, and the two arms. */
const LEG_X = 0.085;
const ARM_X = 0.185;
/** Where the shorts stop and the leg starts. Measured down from the hip. */
const SHORTS_DROP = 0.30;
/** The sole, measured down from the hip. `HIP_Y` exactly, so the figure stands on 0. */
const SOLE_DROP = HIP_Y;

type Rgb = readonly [number, number, number];
/** White: every part below takes its colour from `instanceColor`. See the header. */
const TAKE_TINT: Rgb = [1, 1, 1];

/** Accumulates boxes into one indexed geometry with a colour per vertex. */
class FigureBuilder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];

  /**
   * One axis-aligned box. Flat-shaded and indexed, for `world/cars.ts`'s reason:
   * non-indexed geometry with baked face normals triples the vertex count for an
   * identical image, and the vertex count is the axis a hundred and fifty of
   * these are expensive on.
   */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, c: Rgb): void {
    const base = this.position.length / 3;
    for (const [sx, sy, sz] of CORNERS) {
      this.position.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
      this.color.push(c[0], c[1], c[2]);
    }
    for (const [a, b, d, e] of BOX_FACES) {
      this.index.push(base + a, base + b, base + d, base + a, base + d, base + e);
    }
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit cube corners, in the order `BOX_FACES` indexes them. */
const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** Wound so each quad faces out of the box. */
const BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4, 5, 6, 7], // +z
  [1, 0, 3, 2], // -z
  [5, 1, 2, 6], // +x
  [0, 4, 7, 3], // -x
  [3, 7, 6, 2], // +y
  [0, 1, 5, 4], // -y
];

/**
 * The torso. Origin at the **feet**, facing -Z -- the rig's own convention, so a
 * pedestrian and a player are yawed by the same number.
 */
function buildTorso(): BufferGeometry {
  const m = new FigureBuilder();
  m.box(0, (HIP_Y + TORSO_TOP) * 0.5, 0, 0.17, (TORSO_TOP - HIP_Y) * 0.5, 0.105, TAKE_TINT);
  return m.build('ped_torso');
}

/**
 * Head and two hanging arms: everything that is bare skin, in one set so it can
 * carry the skin tint. See the header on why the arms are here and not swinging.
 */
function buildBare(): BufferGeometry {
  const m = new FigureBuilder();
  // The head is deliberately large, like the rig's: spec 8.1's comic figure, and
  // at 26 pixels tall it is most of what says "person" rather than "post".
  m.box(0, (HEAD_BOTTOM + HEAD_TOP) * 0.5, 0, 0.115, (HEAD_TOP - HEAD_BOTTOM) * 0.5, 0.1, TAKE_TINT);
  for (const side of [-1, 1]) {
    m.box(side * ARM_X, (SHOULDER_Y + HAND_Y) * 0.5, 0, 0.045, (SHOULDER_Y - HAND_Y) * 0.5, 0.05, TAKE_TINT);
  }
  return m.build('ped_bare');
}

/**
 * The shorts on one leg. **Origin at the hip**, extending down -- so the instance
 * transform can rotate the leg about its own joint, which is the entirety of how
 * a walk cycle happens without a skeleton.
 */
function buildShorts(): BufferGeometry {
  const m = new FigureBuilder();
  m.box(0, -SHORTS_DROP * 0.5, 0, 0.075, SHORTS_DROP * 0.5, 0.085, TAKE_TINT);
  return m.build('ped_shorts');
}

/** The bare leg below the shorts, and the foot. Origin at the hip, like the shorts. */
function buildShin(): BufferGeometry {
  const m = new FigureBuilder();
  m.box(0, -(SHORTS_DROP + SOLE_DROP) * 0.5, 0, 0.055, (SOLE_DROP - SHORTS_DROP) * 0.5, 0.06, TAKE_TINT);
  // The foot, projecting forward. A figure with no feet at all reads as floating
  // even at 26 pixels, because the silhouette ends in a flat stump.
  m.box(0, -SOLE_DROP + 0.03, -0.05, 0.05, 0.03, 0.09, TAKE_TINT);
  return m.build('ped_shin');
}

/**
 * The three geometries and the one material, built once for the whole game.
 *
 * Shared on `CarAssets`' terms and for its reason: a material created per tile
 * is a WebGPU pipeline compiled per tile, and pipeline compilation blocks the
 * main thread.
 */
export class PedestrianAssets {
  readonly torso: BufferGeometry;
  readonly bare: BufferGeometry;
  readonly shorts: BufferGeometry;
  readonly shin: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  /** Triangles in one impostor, all six parts. Reported by the HUD's line. */
  readonly triangles: number;

  constructor() {
    this.torso = buildTorso();
    this.bare = buildBare();
    this.shorts = buildShorts();
    this.shin = buildShin();

    const material = new MeshStandardNodeMaterial();
    material.name = 'pedestrian_impostor';
    // No `colorNode`, exactly as the trees, cars, birds and characters have
    // none: `NodeMaterial` already multiplies the material colour by the
    // geometry `color` attribute and then by `instanceColor`, so the kit arrives
    // through two built-in multiplies and no shader graph at all.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // The character material's own numbers -- cotton and skin, not foliage and
    // not car paint. The two tiers have to be lit identically or the handoff is
    // a change in brightness rather than in detail.
    material.roughness = 0.78;
    material.metalness = 0.0;
    material.flatShading = true;
    this.material = material;

    const tris = (g: BufferGeometry): number => (g.getIndex()?.count ?? 0) / 3;
    this.triangles = tris(this.torso) + tris(this.bare) + 2 * (tris(this.shorts) + tris(this.shin));
  }
}

// --- Where the tiers sit -------------------------------------------------------

/**
 * Inside this, a walker is eligible for a real skinned rig, metres.
 *
 * 55 m is where a 1.7 m figure falls to about 26 pixels on a 1080p display at
 * this game's 72-degree field, which is where the knees stop resolving. It is
 * also comfortably outside the 1.55 m melee reach and the range a football
 * covers in a third of a second, so anything a player can actually interact with
 * is always a rig.
 */
export const RIG_TAKE = 55;

/**
 * ...and it holds that rig until this, metres. The hysteresis.
 *
 * Without the gap a walker sitting exactly on the boundary swaps tiers every
 * frame the player sways, which is a figure flickering between two levels of
 * detail -- far more visible than either level is. 17 m is about thirteen seconds
 * of walking, so a swap that does happen is a walker who has genuinely left.
 */
export const RIG_KEEP = 72;

/**
 * Skinned rigs in the pool.
 *
 * Fourteen, against the ~22 people the schedule puts inside 120 m on an inner
 * Sydney street and the ten or twelve it puts inside 55. So the pool runs close
 * to full on a busy footpath and saturates only on the densest corner in the
 * CBD, which is exactly when it should -- and the walkers it cannot serve are
 * drawn as impostors 55 m away, where the difference is a handful of pixels.
 *
 * It is also fourteen extra draw calls, which is the real ceiling here rather
 * than the pose cost: a `SkinnedMesh` cannot be instanced, so the near tier is
 * one draw a person and the far tier is six draws for all of them.
 */
export const RIG_CAPACITY = 14;

/**
 * How far out an impostor is drawn, metres.
 *
 * The traffic draws to 420 m because a car is 4.6 m long and legible at that
 * range. A person is 0.4 m wide and is under two pixels past about 250 m, so
 * drawing them further is instance buffer traffic for nothing. 200 m also keeps
 * the *appearances* out of the middle distance: a walker exists for one
 * traversal of one band, so the further out they are drawn the more often one is
 * seen arriving from nowhere.
 */
export const IMPOSTOR_RADIUS = 200;

/**
 * Instances per part.
 *
 * The measured worst case in the built world is 61 people inside 200 m (Surry
 * Hills, off `checkPedestrians`), and a live frame on Cleveland Street posed 56.
 * So 220 is three and a half times the densest ground in the city. An
 * `InstancedMesh` costs its capacity in buffer bytes and its *count* in draw
 * work, so the headroom is 56 kB and no frame time.
 */
export const IMPOSTOR_CAPACITY = 220;

/** Walkers gathered per frame before the tiers are decided. */
const VISIBLE_CAPACITY = 384;

/**
 * How far a knocked-over walker has to be before their offset is forgotten,
 * metres. Well outside `IMPOSTOR_RADIUS` -- see `PedestrianField.forgetDistant`.
 */
const FORGET_RADIUS = 320;

/** How far a leg swings from vertical at walking pace, radians. */
const LEG_SWING = 0.42;
/** Seconds a struck figure spends toppling, and getting back up. */
const FALL_IN = 0.28;
const FALL_OUT = 0.38;
/** How high off the footpath a body lies. Half a torso. */
const LIE_LIFT = 0.13;

// --- The crowd -----------------------------------------------------------------

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _swing = /*#__PURE__*/ new Quaternion();
const _hip = /*#__PURE__*/ new Vector3();
const _scale = /*#__PURE__*/ new Vector3(1, 1, 1);
const _colour = /*#__PURE__*/ new Color();

/** One pooled skinned rig, and the walker it is currently standing in for. */
interface RigSlot {
  actor: CharacterActor;
  /** The walker's key, or -1 for a free slot. */
  key: number;
  /** Which kit its geometry is currently wearing. See `assign`. */
  kit: number;
  /** Whether `setAction('knockout')` is currently held on it. */
  down: boolean;
}

/**
 * Everybody in view, as fourteen rigs and six instanced sets.
 *
 * **Not parented to a tile**, on `TrafficMovers`' argument and for the same
 * reason: a walker crosses a tile boundary every couple of minutes and the crowd
 * is drawn as one set for the whole visible world rather than one per tile.
 * Positions are world-space -- `decodeLanes` folded the tile origin in once, at
 * load -- and the float32 precision argument is answered by the draw radius: the
 * matrices are absolute coordinates but never further than `IMPOSTOR_RADIUS`
 * from the camera, and at 5 km from the origin a float32 has 0.5 mm.
 *
 * `update` allocates nothing.
 */
export class PedestrianCrowd {
  /** Add these to the scene. Six sets, in part order. */
  readonly meshes: InstancedMesh[] = [];
  /** Add these to the scene too. The near tier's bodies. */
  readonly rigs: CharacterActor[] = [];

  /** People posed last update, both tiers. Read by the HUD's diagnostics line. */
  drawn = 0;
  /** How many of those were skinned rigs. */
  rigged = 0;
  /** How long the whole update took, milliseconds. */
  costMs = 0;

  private readonly slots: RigSlot[] = [];
  private readonly scratch: PedBand[] = [];
  private readonly pose: PedPose = createPedPose();

  // The visible set, as a structure of arrays so gathering it allocates nothing.
  private readonly vKey = new Float64Array(VISIBLE_CAPACITY);
  private readonly vX = new Float64Array(VISIBLE_CAPACITY);
  private readonly vY = new Float64Array(VISIBLE_CAPACITY);
  private readonly vZ = new Float64Array(VISIBLE_CAPACITY);
  private readonly vDx = new Float64Array(VISIBLE_CAPACITY);
  private readonly vDz = new Float64Array(VISIBLE_CAPACITY);
  private readonly vAlong = new Float64Array(VISIBLE_CAPACITY);
  private readonly vSpeed = new Float64Array(VISIBLE_CAPACITY);
  private readonly vDist2 = new Float64Array(VISIBLE_CAPACITY);
  private readonly vKit = new Int32Array(VISIBLE_CAPACITY);
  /** 0 standing, otherwise the topple fraction in [0, 1]. */
  private readonly vFall = new Float64Array(VISIBLE_CAPACITY);
  private readonly vDown = new Uint8Array(VISIBLE_CAPACITY);
  /** Which rig slot took this walker, or -1. */
  private readonly vRig = new Int32Array(VISIBLE_CAPACITY);
  private visible = 0;

  private readonly counts = [0, 0, 0, 0, 0, 0];
  /** The seven kit geometries, for the swap in `assign`. `CharacterAssets`' own. */
  private readonly kitGeometries: readonly BufferGeometry[];

  constructor(assets: PedestrianAssets, characters: CharacterAssets) {
    this.kitGeometries = characters.geometries;
    const parts: Array<[string, BufferGeometry]> = [
      ['torso', assets.torso],
      ['bare', assets.bare],
      ['shorts_l', assets.shorts],
      ['shin_l', assets.shin],
      ['shorts_r', assets.shorts],
      ['shin_r', assets.shin],
    ];
    for (const [name, geometry] of parts) {
      const mesh = new InstancedMesh(geometry, assets.material, IMPOSTOR_CAPACITY);
      mesh.name = `pedestrian_${name}`;
      mesh.count = 0;
      // Culled by the draw radius rather than by the frustum, for the reason
      // every instanced set in this project has: the bounding sphere of a set
      // that changes every frame would have to be recomputed every frame, and a
      // radius test the fill loop is already doing is free.
      mesh.frustumCulled = false;
      // Casts, and receives. A figure with no shadow does not stand on the
      // footpath -- `world/birds.ts` makes the argument for a 0.84 m ibis and it
      // applies twice over to a person. Receiving matters as much: at 60 m a
      // pedestrian in a building's shadow lit as though in full sun is the
      // clearest possible sign that they were pasted on.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Never owned by a tile and never freed by an eviction -- the geometry is
      // shared by every pedestrian in the city. Distinct flag from
      // `userData.cars` and `userData.traffic` so a change to either cannot
      // silently free this one's buffers.
      mesh.userData.pedestrians = true;
      // **The kit buffer, allocated here rather than by the first `setColorAt`
      // in `write`.** This whole tier is white geometry whose skin, singlet and
      // shorts arrive through `instanceColor` -- see the header -- and
      // `NodeMaterial.setupDiffuseColor` applies that attribute only when it
      // exists at the moment the node graph is built. `main.ts` compiles every
      // scene-wide instanced set with one `compileAsync` before the first frame,
      // which is before this pool has ever been filled, so without this line the
      // six impostor sets get a shader with no tint in it and the far tier is a
      // crowd of white mannequins. `world/cars.ts` carries the full argument.
      mesh.setColorAt(0, _colour.setRGB(1, 1, 1));
      this.meshes.push(mesh);
    }

    for (let i = 0; i < RIG_CAPACITY; i++) {
      // Seeded across the kits so an unassigned pool is not seven copies of one
      // person, and so the *first* assignment usually needs no geometry swap.
      const actor = new CharacterActor(characters, i % COLOURWAYS.length);
      actor.mesh.name = `character:pedestrian:${i}`;
      actor.mesh.visible = false;
      this.rigs.push(actor);
      this.slots.push({ actor, key: -1, kit: i % COLOURWAYS.length, down: false });
    }
  }

  /**
   * Place every pedestrian in view, at `tick` plus a frame fraction.
   *
   * `tick` may be fractional. That is the one place a non-integer tick is
   * correct here, and it is `TrafficMovers.update`'s split: the strike test runs
   * on whole ticks so that this client and a future server ask the identical
   * question, and the *picture* runs between them so a 144 Hz display does not
   * watch 60 Hz people.
   *
   * `dt` is the frame delta, for the rigs' own clocks. They are animated on the
   * frame delta rather than the tick for `main.ts`'s reason: the simulation is
   * fixed so prediction and rewind agree, and animation is presentation.
   */
  update(field: PedestrianField, tick: number, dt: number, x: number, z: number): void {
    const at = performance.now();
    this.gather(field, tick, x, z);
    this.assign();
    this.poseRigs(dt);
    this.fillImpostors();
    // The knockdown registry is the one piece of state this feature has, and
    // this is where it is bounded. Done here because the crowd is the only thing
    // that knows where the camera is.
    field.forgetDistant(x, z, FORGET_RADIUS, tick / 60);
    this.drawn = this.visible;
    this.costMs = performance.now() - at;
  }

  /** Everybody inside the far radius, into the visible arrays. Allocates nothing. */
  private gather(field: PedestrianField, tick: number, x: number, z: number): void {
    let n = 0;
    forEachPedestrianNear(field, x, z, IMPOSTOR_RADIUS, tick, this.scratch, this.pose, (p) => {
      if (n >= VISIBLE_CAPACITY) return true;
      const dx = p.x - x;
      const dz = p.z - z;
      this.vKey[n] = p.key;
      this.vX[n] = p.x;
      this.vY[n] = p.y;
      this.vZ[n] = p.z;
      this.vDx[n] = p.dx;
      this.vDz[n] = p.dz;
      this.vAlong[n] = p.along;
      this.vSpeed[n] = p.speed;
      this.vKit[n] = p.kit;
      this.vDist2[n] = dx * dx + dz * dz;
      this.vDown[n] = p.down ? 1 : 0;
      // The topple, and standing back up. A cubic smoothstep rather than a
      // cosine, because this runs on every downed figure in view and there is no
      // reason to spend a transcendental on an ease.
      this.vFall[n] = p.down ? ease(Math.min(p.downT / FALL_IN, 1)) * ease(Math.min(p.downLeft / FALL_OUT, 1)) : 0;
      this.vRig[n] = -1;
      n++;
    });
    this.visible = n;
  }

  /**
   * Hand the nearest walkers a skinned rig, keeping the ones already assigned.
   *
   * Two passes and no sort. The first keeps every slot whose walker is still in
   * view and still inside `RIG_KEEP`, which is the hysteresis; the second fills
   * whatever is left with the nearest unassigned walker inside `RIG_TAKE`, one
   * slot at a time. That is O(slots * visible) -- fourteen times a few hundred,
   * a few thousand comparisons -- against a sort of the whole visible set, and
   * unlike a sort it allocates nothing and never reorders equal distances
   * differently from one frame to the next.
   */
  private assign(): void {
    const keep = RIG_KEEP * RIG_KEEP;
    const take = RIG_TAKE * RIG_TAKE;

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.key < 0) continue;
      let held = -1;
      for (let i = 0; i < this.visible; i++) {
        if (this.vKey[i] === slot.key && this.vDist2[i] <= keep && this.vRig[i] < 0) {
          held = i;
          break;
        }
      }
      if (held < 0) {
        slot.key = -1;
        slot.actor.mesh.visible = false;
        if (slot.down) {
          slot.actor.setAction(null);
          slot.down = false;
        }
      } else {
        this.vRig[held] = s;
      }
    }

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.key >= 0) continue;
      let best = -1;
      let bestD = take;
      for (let i = 0; i < this.visible; i++) {
        if (this.vRig[i] >= 0) continue;
        if (this.vDist2[i] < bestD) {
          bestD = this.vDist2[i];
          best = i;
        }
      }
      if (best < 0) break;
      slot.key = this.vKey[best];
      this.vRig[best] = s;
      // The kit. `CharacterActor` fixes its colourway at construction, so a
      // pooled body wears whatever it was born in -- and the walker it has just
      // been handed has its own, hashed off the schedule and shared with the
      // impostor it was a moment ago. Swapping the *geometry* is what reconciles
      // them: all seven of `CharacterAssets`' geometries share position, normal,
      // skinIndex and skinWeight and differ only in their colour attribute, so
      // the skeleton, the bind matrix and the bounding sphere are all still
      // correct. Nothing in `player/character.ts` had to change for this, which
      // is the same relationship `player/bat.ts` has with the rig: reach in from
      // outside and use the public surface.
      const kit = this.vKit[best];
      if (kit !== slot.kit) {
        slot.actor.mesh.geometry = this.kitGeometries[kit] ?? this.kitGeometries[0];
        slot.kit = kit;
      }
      slot.actor.mesh.visible = true;
    }
  }

  /** Drive the assigned rigs through the existing public animation API. */
  private poseRigs(dt: number): void {
    let rigged = 0;
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.key < 0) continue;
      let i = -1;
      for (let k = 0; k < this.visible; k++) {
        if (this.vRig[k] === s) {
          i = k;
          break;
        }
      }
      if (i < 0) continue;
      rigged++;

      const down = this.vDown[i] !== 0;
      if (down !== slot.down) {
        // The rig's own crumple, on the *edge* rather than while it is set --
        // `game/dummies.ts`'s rule, and it is here for the same reason:
        // `setAction` restarts a clip every time it is called, and a knockout
        // re-triggered sixty times a second is a figure vibrating on the
        // footpath. `knockout` holds until cleared, which is exactly what a
        // pedestrian lying down for two seconds needs.
        slot.actor.setAction(down ? 'knockout' : null);
        slot.down = down;
      }

      _rigFeet.x = this.vX[i];
      _rigFeet.y = this.vY[i];
      _rigFeet.z = this.vZ[i];
      slot.actor.update(dt, {
        position: _rigFeet,
        // Solving `forward = (-sin yaw, -cos yaw)` for yaw. `Math.atan2` on
        // fourteen figures a frame is free, and unlike the impostors' quaternion
        // trick it is the form the actor's API asks for.
        yaw: Math.atan2(-this.vDx[i], -this.vDz[i]),
        // A downed figure is not walking. Feeding the crumple a walk would still
        // drive the stride and leave the legs mid-cycle on the frame it stands.
        speed: down ? 0 : this.vSpeed[i],
        onGround: true,
      });
    }
    this.rigged = rigged;
  }

  /** Everybody the rigs did not take, into the six instance buffers. */
  private fillImpostors(): void {
    for (let p = 0; p < 6; p++) this.counts[p] = 0;
    let n = 0;

    for (let i = 0; i < this.visible; i++) {
      if (this.vRig[i] >= 0) continue;
      if (n >= IMPOSTOR_CAPACITY) break;

      // The yaw, straight off the pose's unit direction and with no
      // `Math.atan2` in it. The figure's local -Z is its front, so the rotation
      // that sends -Z to (dx, 0, dz) is a yaw whose cosine is -dz and whose sine
      // is -dx -- and the half-angle form of that is one square root and no
      // transcendental. `world/cars.ts` makes the same trade on the same
      // grounds: this runs on every figure in frame on every frame.
      const c = -this.vDz[i];
      const s = -this.vDx[i];
      const w2 = (1 + c) * 0.5;
      if (w2 > 1e-12) {
        const w = Math.sqrt(w2);
        _quaternion.set(0, s / (2 * w), 0, w);
      } else {
        _quaternion.set(0, 1, 0, 0);
      }

      const fall = this.vFall[i];
      if (fall > 0) {
        // Face down on the footpath. A rotation about the figure's own right
        // axis takes +Y (up) to -Z (forward), so the body lies pointing the way
        // it was walking -- which is what falling forward looks like and costs
        // one more quaternion multiply.
        const half = -fall * (Math.PI * 0.25);
        _swing.set(Math.sin(half), 0, 0, Math.cos(half));
        _quaternion.multiply(_swing);
      }

      const lift = fall * LIE_LIFT;
      _position.set(this.vX[i], this.vY[i] + lift, this.vZ[i]);
      _matrix.compose(_position, _quaternion, _scale);
      const kit = COLOURWAYS[this.vKit[i]] ?? COLOURWAYS[0];
      this.write(0, n, _matrix, kit.singlet);
      this.write(1, n, _matrix, kit.skin);

      // The legs. One `Math.sin` for the stride and one half-angle pair, reused
      // for both legs because they swing in exact antiphase -- so the right
      // leg's quaternion is the left's with its y and w flipped, which is two
      // negations rather than a second pair of transcendentals.
      const swing = fall > 0 ? 0 : LEG_SWING * Math.sin(this.strideOf(i));
      const halfSwing = swing * 0.5;
      const ss = Math.sin(halfSwing);
      const cs = Math.cos(halfSwing);
      for (let leg = 0; leg < 2; leg++) {
        const sign = leg === 0 ? 1 : -1;
        _swing.set(ss * sign, 0, 0, cs);
        _legQuat.copy(_quaternion).multiply(_swing);
        // The hip, in the figure's own frame, taken through the body rotation so
        // the joint stays on the body when it is yawed or lying down.
        _hip.set(sign * LEG_X, HIP_Y, 0).applyQuaternion(_quaternion);
        _position.set(this.vX[i] + _hip.x, this.vY[i] + lift + _hip.y, this.vZ[i] + _hip.z);
        _matrix.compose(_position, _legQuat, _scale);
        this.write(2 + leg * 2, n, _matrix, kit.shorts);
        this.write(3 + leg * 2, n, _matrix, kit.skin);
      }
      n++;
    }

    for (let p = 0; p < 6; p++) {
      const mesh = this.meshes[p];
      const count = this.counts[p];
      // Only upload what changed. A region of the buffer nobody is drawing does
      // not need to be correct.
      // WORKSTREAM AB: and only *what* changed, which this comment has always
      // claimed and could not do. `needsUpdate` alone hands three's WebGPU
      // backend the whole 16 kB array; a prefix range hands it the 52
      // pedestrians actually in view. See `world/instupload.ts`.
      if (count > 0 || mesh.count > 0) uploadInstances(mesh, count);
      mesh.count = count;
    }
  }

  /**
   * The stride phase, from the distance this walker has covered on this
   * traversal.
   *
   * Derived rather than integrated, which is what makes it stateless like
   * everything else here -- there is no per-walker clock to keep, a walker who
   * despawns and comes back starts a fresh cycle, and two clients agree.
   * `animation.strideLength` is the rig's own relationship between pace and step,
   * so a figure crossing the tier boundary does not change how long its steps are
   * -- only how many joints they have.
   */
  private strideOf(i: number): number {
    const speed = this.vSpeed[i];
    return (this.vAlong[i] * Math.PI * 2) / strideLength(speed > 0.1 ? speed : 1.3);
  }

  private write(part: number, n: number, matrix: Matrix4, tint: Rgb): void {
    const mesh = this.meshes[part];
    mesh.setMatrixAt(n, matrix);
    _colour.setRGB(tint[0], tint[1], tint[2]);
    mesh.setColorAt(n, _colour);
    this.counts[part] = n + 1;
  }

  /**
   * Release the instance buffers. **Not the geometry or the material**, which
   * are `PedestrianAssets`' and are shared by every pedestrian in the city --
   * the same trap `streamer.dispose` documents at length. The rigs' geometry
   * belongs to `CharacterAssets` and is likewise never released here.
   */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
  }
}

const _legQuat = /*#__PURE__*/ new Quaternion();
const _rigFeet = { x: 0, y: 0, z: 0 };

/** Cubic smoothstep. No transcendental; see `gather`. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

// --- Self-check ----------------------------------------------------------------

/**
 * What the *model* gets wrong in a way that renders.
 *
 * The rules half is `pedestrians.verifyPedestrians`; this is the half about the
 * figure. A box wound inside out is see-through from one side only, which is
 * invisible in a screenshot taken from the other. An impostor built to different
 * proportions from the rig is a person who changes height at 55 m -- the one
 * thing that would give the tier handoff away, and the one thing no single frame
 * can show. A leg whose origin is not at the hip swings about the wrong point and
 * scissors through the body, which at 26 pixels reads as a walk cycle with a
 * limp.
 */
export function verifyPedestrianModel(assets: PedestrianAssets = new PedestrianAssets()): string[] {
  const failures: string[] = [];

  // --- The two tiers are the same person. Checked against the rig's own
  // constants rather than built from them -- see `HIP_Y`.
  if (Math.abs(HEAD_TOP - FIGURE_HEIGHT) > 0.03) {
    failures.push(
      `The impostor is ${HEAD_TOP} m tall and the rig is ${FIGURE_HEIGHT} m; a pedestrian would change ` +
        'height at the LOD handoff.',
    );
  }
  if (Math.abs(HIP_Y - HIP_HEIGHT) > 0.02) {
    failures.push(
      `The impostor's hip is at ${HIP_Y} m and the rig's is at ${HIP_HEIGHT.toFixed(3)} m; the legs ` +
        'would visibly change length at the LOD handoff.',
    );
  }
  if (Math.abs(SOLE_DROP - HIP_Y) > 1e-6) {
    failures.push("The impostor's leg does not reach the ground from its hip; the figure floats or sinks.");
  }

  // --- The legs pivot at the hip, which is what the instance transform assumes.
  {
    const pos = assets.shorts.getAttribute('position');
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    if (Math.abs(maxY) > 1e-6) {
      failures.push(`The shorts geometry's top is at y = ${maxY}; it must be at 0, the hip it rotates about.`);
    }
    if (minY >= 0) failures.push('The shorts geometry does not extend downward from the hip.');
  }

  // --- Wound outward. One box is enough to catch the whole `BOX_FACES` table
  // being reversed, and the whole table is what every part here is built from.
  {
    const g = assets.torso;
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    if (idx === null) failures.push('The impostor torso is not indexed.');
    else {
      let outward = 0;
      let inward = 0;
      // The box is centred on (0, mid, 0); a face normal must point away from it.
      const midY = (HIP_Y + TORSO_TOP) * 0.5;
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t);
        const b = idx.getX(t + 1);
        const c = idx.getX(t + 2);
        const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
        const bx = pos.getX(b) - ax, by = pos.getY(b) - ay, bz = pos.getZ(b) - az;
        const cx = pos.getX(c) - ax, cy = pos.getY(c) - ay, cz = pos.getZ(c) - az;
        const nx = by * cz - bz * cy;
        const ny = bz * cx - bx * cz;
        const nz = bx * cy - by * cx;
        // Outward from the centroid of the face.
        const ox = (ax + pos.getX(b) + pos.getX(c)) / 3;
        const oy = (ay + pos.getY(b) + pos.getY(c)) / 3 - midY;
        const oz = (az + pos.getZ(b) + pos.getZ(c)) / 3;
        if (nx * ox + ny * oy + nz * oz > 0) outward++;
        else inward++;
      }
      if (inward > 0) {
        failures.push(`${inward} of ${outward + inward} impostor triangles face inward; the figure is see-through from outside.`);
      }
    }
  }

  // --- Cost. The number this tier exists to keep down.
  if (assets.triangles > 200) {
    failures.push(`One impostor is ${assets.triangles} triangles; the far tier was budgeted at well under 200.`);
  }
  if (IMPOSTOR_CAPACITY < 64) {
    failures.push(`The far tier holds ${IMPOSTOR_CAPACITY} figures, which is fewer than one dense street corner.`);
  }
  if (RIG_KEEP <= RIG_TAKE) {
    failures.push('The rig hysteresis band is empty; figures will flicker between tiers at the boundary.');
  }

  return failures;
}

