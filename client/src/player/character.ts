/**
 * The player character: mesh, skin, colourways and the actor that drives them.
 *
 * Spec 8.1 asks for "low-poly, exaggerated, comical. Big heads, noodle arms,
 * oversized hands. Deliberately at odds with the accurate city," and spec 2
 * states the whole reason: *the world is straight and accurate; the characters
 * and combat are broad and silly, and that contrast is the point.* Everything
 * below is in service of the second half of that sentence, and nothing in it
 * touches the first.
 *
 * ---------------------------------------------------------------------------
 * The deviation from the spec, stated first because it is the largest.
 *
 * 8.1 nominates "Kenney or Quaternius CC0 packs, modified" as base meshes. This
 * build does not use them, and the reason is not licensing -- section 2 makes
 * clear that nothing here is distributed, so CC0 is not even a question. It is
 * that **there is no asset pipeline for a downloaded mesh to enter.** Every
 * object in this world is generated: the city by `pipeline/`, and the trees,
 * parked cars, power poles, wheelie bins, signal heads and ibises by six
 * client modules that build geometry in code from a palette and a few
 * proportions. A `.glb` of somebody else's character would be the only binary
 * asset in the repository, the only thing that could not be changed by editing a
 * number, and the only thing whose triangle budget, bone names, pivot
 * convention and up-axis were decided somewhere else. A comic figure is four
 * hundred triangles of tubes and lobes. It is well inside procedural reach, and
 * `world/birds.ts` already demonstrates the whole method one level down.
 *
 * ---------------------------------------------------------------------------
 * Why there is no instancing, and why there is no per-actor material either.
 *
 * Two decisions that look like the same decision and are not.
 *
 * **Instancing is skipped** because it does not apply. A skinned mesh's bone
 * matrices live in the *per-object* bind group -- `Skinning.js` builds them with
 * `referenceBuffer('skeleton.boneMatrices', ...)`, and the generated WGSL puts
 * them at `@group(1)`, which is three's object group -- so two instances of one
 * `InstancedMesh` would share one skeleton and strike the same pose. Skinning
 * sixteen actors as instances needs the bone matrices in a storage buffer
 * indexed by instance, which is a real feature and would be worth building for a
 * crowd. Spec 2 caps this game at sixteen players. Sixteen draw calls against a
 * frame that already issues one hundred and forty for parked cars alone is not a
 * problem, and pretending it is would be the expensive kind of premature.
 *
 * **A material per actor is skipped for the opposite reason** -- it is not free.
 * A material is a WebGPU pipeline, and `vegetation.ts`, `cars.ts` and `birds.ts`
 * each say the same thing in their own headers: pipeline compilation blocks the
 * main thread. Seven colourways as seven material clones is seven compiles the
 * first time seven kits appear on screen, which is exactly the moment a match
 * starts. So the kit is baked into **vertex colours** instead, and the seven
 * colourways are seven `BufferGeometry` objects that **share one position, one
 * normal, one `skinIndex` and one `skinWeight` buffer** and differ only in a
 * `color` attribute. The whole palette costs 7 x 380 x 3 floats -- 32 kB, once,
 * for the entire game -- and every actor in the world draws with **one shared
 * material and therefore one pipeline**. It is the trick `cars.ts` uses to put a
 * car's glass and tyres in the paint mesh, applied to a wardrobe.
 *
 * ---------------------------------------------------------------------------
 * Skinning under WebGPU + TSL, and the depth pass, both read rather than assumed.
 *
 * Three things had to be true and all three were confirmed against three r185's
 * source and by generating the WGSL headlessly:
 *
 *   1. `NodeMaterial.setupPosition` calls `skinning(object)` whenever
 *      `object.isSkinnedMesh === true`. The generated vertex shader contains
 *      `positionLocal = bindMatrixInverse * (skinWeight.x * boneMatrices[skinIndex.x] * v + ...)`.
 *      Skinning works on `MeshStandardNodeMaterial` with no wiring at all.
 *   2. **It deforms the depth pass too, structurally.** The shadow pass sets
 *      `scene.overrideMaterial` to a plain `NodeMaterial` (`getShadowMaterial`
 *      in `ShadowFilterNode.js`), and that material goes through the same
 *      `setupPosition`, whose skinning branch is keyed on **the object**, not on
 *      the material. Generating the WGSL for the override material against this
 *      exact `SkinnedMesh` produces the same bone-matrix expression. This is a
 *      stronger guarantee than the one `vegetation.ts` documents for its wind: a
 *      `positionNode` reaches the depth pass only because `Renderer.renderObject`
 *      copies it across, where skinning is never absent in the first place.
 *   3. `flatShading` is safe on a skinned mesh. Three's node path derives the
 *      flat normal as `dFdx(positionView) x dFdy(positionView)`
 *      (`nodes/accessors/Normal.js`), which is the *post*-skinning position, so a
 *      deformed facet is shaded by its deformed normal and there is no seam.
 *
 * The bones are **children of the mesh**, which is what makes an actor one
 * self-contained object that can be moved by writing `mesh.position`. Three's
 * default `AttachedBindMode` recomputes `bindMatrixInverse` from the mesh's
 * world matrix every frame, and that inverse exactly cancels the model matrix
 * the bones inherited -- so the skinned result is in mesh-local space wherever
 * the mesh happens to be. Bind at the identity and nothing else has to be true.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and every display value beside it was
 * produced by running the chain documented at the top of `sky/calibration.ts` --
 * irradiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode -- at
 * the reference instant of 3 pm on 15 February. The method is checked rather
 * than assumed: the same evaluation reproduces `street.ts`'s published sunlit
 * footpath (247, 248, 246), sunlit asphalt (131, 137, 148), shaded asphalt
 * (24, 40, 59) and shaded footpath (116, 129, 143) exactly, to the code value.
 * "Sun" below is a surface square-on to the beam and "shade" is the shaded side
 * of a street -- the two geometries `calibration.shadedWallIrradiance` and
 * `sunlitWallIrradiance` are written against, which is the right pair for a
 * standing figure whose torso is vertical.
 *
 * Two colourways in full, since the kit has to work at both ends of its range.
 * For scale, the surfaces they will be standing on: sunlit footpath Y' 247,
 * sunlit asphalt Y' 130, shaded footpath Y' 137, shaded asphalt Y' 36.
 *
 *   COBALT / GOLD                    sun                   shade
 *     cobalt singlet      rgb(104, 144, 248) Y' 143   rgb( 18,  62, 135) Y'  58
 *     gold shorts         rgb(250, 209, 113) Y' 211   rgb(160, 121,  15) Y' 122
 *     mid skin            rgb(240, 197, 166) Y' 204   rgb(113,  80,  55) Y'  85
 *
 *   CHARCOAL / YELLOW                sun                   shade
 *     charcoal singlet    rgb(107, 108, 115) Y' 108   rgb( 26,  21,  24) Y'  22
 *     yellow shorts       rgb(252, 230, 130) Y' 227   rgb(181, 153,  20) Y' 149
 *     deep skin           rgb(127,  93,  73) Y'  99   rgb( 52,  27,   7) Y'  31
 *
 * The number that decides whether a kit works is the **singlet against its own
 * shorts**, not either against the city, because a player is identified at fifty
 * metres by a two-tone silhouette. Measured over all seven, that gap runs:
 *
 *   cobalt/gold 68 / 64      red/black 76 / 53       green/cream 93 / 106
 *   purple/white 117 / 139   orange/navy 76 / 75     teal/pink 62 / 60
 *   charcoal/yellow 119 / 127                                (sun / shade)
 *
 * The **worst pair in the set is 62 in sun and 53 in shade**, which is four
 * times this project's "a dozen code values is where a viewer stops resolving a
 * difference" bar. Three of the seven were re-picked to get there rather than
 * left where taste put them, and the measurement is the reason: teal against
 * pink started 11 code values apart in sun -- two very different hues at almost
 * exactly the same value, which is a solid-colour figure at any distance where
 * chroma has gone. Red against black and green against cream failed the same way
 * more mildly. The fix in each case was to take *value* out of the singlet and
 * leave the hue alone.
 *
 * The failure the palette was checked against from the other end is the *shaded
 * charcoal* case, which is genuinely dark: Y' 22 against shaded asphalt's Y' 36
 * is 14 code values, so a charcoal singlet on a shaded road is nearly invisible
 * on its own. What carries it is that the same figure's shorts are at Y' 149 on
 * the same road -- the pairing is deliberately maximum-contrast on exactly the
 * colourway whose top half disappears, and none of the seven pairs two dark
 * halves.
 *
 * ---------------------------------------------------------------------------
 * Cost. 440 triangles and 380 vertices per figure, against spec 8.1's budget of
 * 2,000, and 17 bones against its 20. One geometry buffer set and one material
 * for the whole game. Sixteen players at the spec's maximum is 7,040 triangles
 * in 16 draws, which is 1.4% of the 483 k of trees already in the spawn frame.
 * There is no 512x512 atlas because there is no texture: the kit is a vertex
 * colour and the shading is `flatShading`, the same arrangement every other
 * procedural object in this client uses.
 */

import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  Layers,
  Matrix4,
  MeshStandardNodeMaterial,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three/webgpu';

import {
  BONE,
  BONE_COUNT,
  FIGURE_HEIGHT,
  FOOT_HALF_WIDTH,
  FOOT_HEEL,
  FOOT_THICKNESS,
  FOOT_TOE,
  PUNCH_ACTIVE,
  PUNCH_RECOVERY,
  PUNCH_TOTAL,
  PUNCH_WIND_UP,
  RIG,
  UPPER_BODY,
  WHOLE_BODY,
  BAR_Y,
  BAR_Z,
  FLINCH_DURATION,
  KNOCKOUT_DURATION,
  PEDAL_Y,
  RIDE_BLEND,
  SADDLE_Y,
  THROW_DURATION,
  type ClipContext,
  type Pose,
  blendPose,
  clipFlinch,
  clipIdle,
  clipJump,
  clipKnockout,
  clipPunchActive,
  clipPunchRecovery,
  clipPunchWindUp,
  clipRide,
  clipRun,
  clipThrow,
  clipWalk,
  copyPose,
  createPose,
  resetPose,
  smoothstep,
  strideLength,
} from './animation.ts';

// --- The palette --------------------------------------------------------------

type Rgb = readonly [number, number, number];

/**
 * What a vertex is made of. Five roles is the whole wardrobe, and it is what
 * lets one geometry serve seven kits: a vertex records *which* colour it takes,
 * and the colourway decides what that colour is.
 */
const ROLE = { SKIN: 0, SINGLET: 1, SHORTS: 2, SHOE: 3, EYE: 4 } as const;
type Role = (typeof ROLE)[keyof typeof ROLE];

export interface Colourway {
  readonly name: string;
  readonly singlet: Rgb;
  readonly shorts: Rgb;
  readonly skin: Rgb;
  readonly shoe: Rgb;
}

/**
 * Eyes, linear, and the same for every kit.
 *
 * Near-black rather than white-with-a-pupil, which is two more lobes for a
 * detail that is one pixel at any distance a fight happens at. What a big head
 * needs is two dark marks in the right place -- the same argument `birds.ts`
 * makes about an ibis's bill carrying the silhouette, and the same 100+ code
 * value step doing the work.
 */
const EYE: Rgb = [0.035, 0.033, 0.038];

/**
 * Seven kits, park-cricket bright.
 *
 * Spec 8.1 asks for six to eight colourways with no customisation system, and
 * seven is what fits the constraint that actually mattered: every pair has to be
 * legible against every other pair at a distance, so the singlets are spread
 * around the hue circle rather than picked for taste, and no two kits share both
 * a hue family and a value band. The skin tones run the full range across the
 * seven rather than being offered as a separate axis -- there is no
 * customisation system to offer them in, and a kit is a whole person.
 */
export const COLOURWAYS: readonly Colourway[] = [
  {
    name: 'cobalt/gold',
    singlet: [0.045, 0.115, 0.44],
    shorts: [0.55, 0.34, 0.045],
    skin: [0.3, 0.19, 0.13],
    shoe: [0.72, 0.72, 0.7],
  },
  {
    name: 'red/black',
    singlet: [0.62, 0.07, 0.05],
    shorts: [0.035, 0.033, 0.036],
    skin: [0.52, 0.36, 0.29],
    shoe: [0.04, 0.04, 0.042],
  },
  {
    name: 'green/cream',
    singlet: [0.03, 0.15, 0.052],
    shorts: [0.7, 0.66, 0.5],
    skin: [0.13, 0.075, 0.05],
    shoe: [0.72, 0.72, 0.7],
  },
  {
    name: 'purple/white',
    singlet: [0.17, 0.055, 0.34],
    shorts: [0.78, 0.78, 0.79],
    skin: [0.46, 0.31, 0.24],
    shoe: [0.04, 0.04, 0.042],
  },
  {
    name: 'orange/navy',
    singlet: [0.62, 0.19, 0.03],
    shorts: [0.035, 0.05, 0.16],
    skin: [0.21, 0.13, 0.085],
    shoe: [0.72, 0.72, 0.7],
  },
  {
    name: 'teal/pink',
    singlet: [0.02, 0.105, 0.11],
    shorts: [0.7, 0.24, 0.34],
    skin: [0.38, 0.25, 0.18],
    shoe: [0.04, 0.04, 0.042],
  },
  {
    name: 'charcoal/yellow',
    singlet: [0.055, 0.055, 0.06],
    shorts: [0.72, 0.55, 0.055],
    skin: [0.075, 0.043, 0.03],
    shoe: [0.72, 0.72, 0.7],
  },
];

function roleColour(kit: Colourway, role: number): Rgb {
  switch (role) {
    case ROLE.SINGLET:
      return kit.singlet;
    case ROLE.SHORTS:
      return kit.shorts;
    case ROLE.SHOE:
      return kit.shoe;
    case ROLE.EYE:
      return EYE;
    default:
      return kit.skin;
  }
}

// --- Geometry -----------------------------------------------------------------

type Point = readonly [number, number, number];

/**
 * A vertex's bone binding: `[boneA, boneB, weightOfA]`.
 *
 * Two influences, never four. Spec 8.1's comic figure is built from rigid
 * segments and the only place a blend is wanted at all is the four joints where
 * two segments meet -- shoulder, elbow, hip, knee -- so the third and fourth
 * slots would carry zero on every vertex in the mesh. They are still emitted,
 * because `skinIndex`/`skinWeight` are `vec4` attributes in the shader and there
 * is no narrower form, but nothing here has to reason about them.
 */
type Skin = readonly [number, number, number];

/** One bone, rigidly. */
const w1 = (bone: number): Skin => [bone, bone, 1];
/** A joint: `t` of `a`, the rest of `b`. */
const w2 = (a: number, b: number, t: number): Skin => [a, b, t];

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS: Point[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_FACES: Array<[number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * Accumulates indexed triangles with a role and a bone binding per vertex.
 *
 * The same class of object as `birds.ts`'s `Parts`, with two attributes added
 * and one changed: a vertex carries a *role* rather than a colour, because the
 * colour is not known until a colourway is chosen, and it carries a bone
 * binding, because that is the whole point of this pass.
 *
 * Indexed, with the faceting coming from `material.flatShading`, for the reason
 * `vegetation.ts` measured and `birds.ts` repeats: a non-indexed build with
 * baked face normals triples the vertex count for exactly the same triangles and
 * exactly the same look.
 */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly role: number[] = [];
  readonly skinIndex: number[] = [];
  readonly skinWeight: number[] = [];
  readonly index: number[] = [];

  private vertex(p: Point, n: Point, role: Role, skin: Skin): void {
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.role.push(role);
    this.skinIndex.push(skin[0], skin[1], 0, 0);
    this.skinWeight.push(skin[2], 1 - skin[2], 0, 0);
  }

  /**
   * A ring-to-ring tube between two points, open at both ends.
   *
   * Lifted from `birds.cone` because that construction is already proven in this
   * client -- including its winding, which the README's winding pass makes clear
   * is not a thing to re-derive casually. The reference vector switches on
   * whether the axis is near-vertical for the same reason it does there: a leg
   * is vertical and a shoe is horizontal, and one fixed reference cannot serve
   * both without the cross product collapsing.
   *
   * `s0` and `s1` are the bone bindings of the two rings, separately, so a limb
   * segment can be rigid down its length and blended only at the joint ring it
   * shares with the next segment.
   */
  tube(
    from: Point, to: Point, r0: number, r1: number, sides: number,
    role: Role, s0: Skin, s1: Skin = s0, phase = 0,
  ): void {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const len = Math.hypot(ax, ay, az) || 1;
    const dx = ax / len;
    const dy = ay / len;
    const dz = az / len;
    const vertical = Math.abs(dy) > 0.9;
    let ux = vertical ? 0 : dz;
    let uy = vertical ? -dz : 0;
    let uz = vertical ? dy : -dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const base = this.position.length / 3;
    const rings: Array<[Point, number, Skin]> = [
      [from, r0, s0],
      [to, r1, s1],
    ];
    for (const [o, r, skin] of rings) {
      for (let i = 0; i < sides; i++) {
        const a = phase + (i / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = ux * ca + vx * sa;
        const ny = uy * ca + vy * sa;
        const nz = uz * ca + vz * sa;
        this.vertex(
          [o[0] + nx * r, o[1] + ny * r, o[2] + nz * r],
          [nx, ny, nz],
          role,
          skin,
        );
      }
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.index.push(base + i, base + j, base + sides + j);
      this.index.push(base + i, base + sides + j, base + sides + i);
    }
  }

  /**
   * A flat disc on a horizontal plane, facing up (`up = true`) or down.
   *
   * Only the two axis-aligned cases exist because they are the only two the
   * figure needs -- the top of the chest and the hem of the shorts -- and a
   * general oriented disc would need the same reference-vector dance as `tube`
   * for no caller.
   */
  disc(centre: Point, r: number, sides: number, up: boolean, role: Role, skin: Skin, phase = 0): void {
    const n: Point = [0, up ? 1 : -1, 0];
    const base = this.position.length / 3;
    this.vertex(centre, n, role, skin);
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * Math.PI * 2;
      this.vertex([centre[0] + Math.cos(a) * r, centre[1], centre[2] + Math.sin(a) * r], n, role, skin);
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      // Seen from +Y with x to the right, increasing angle runs *clockwise* on
      // screen because z runs down it -- so an up-facing fan has to be wound
      // backwards to come out front-facing, and a down-facing one forwards.
      if (up) this.index.push(base, base + 1 + j, base + 1 + i);
      else this.index.push(base, base + 1 + i, base + 1 + j);
    }
  }

  /**
   * An icosahedral ellipsoid, optionally subdivided once. One head, or one mitt.
   *
   * 20 faces at `detail = 0` and 80 at `detail = 1`. The head takes the
   * subdivided one and everything else takes the bare icosahedron, which under
   * `flatShading` reads as a faceted blob -- exactly what the ibis's 20-face
   * body reads as, and correct for this style.
   *
   * The normal is the *sphere* normal rather than the ellipsoid's, which is
   * wrong by up to 8 degrees on the head's 0.185 x 0.25 x 0.175 radii. It costs
   * nothing here because `flatShading` derives the shading normal from screen
   * derivatives and never reads this attribute; what the attribute does feed is
   * the shadow pass's `normalBias`, where 8 degrees on a 3 cm offset is 4 mm.
   */
  lobe(centre: Point, radii: Point, role: Role, skin: Skin, detail = 0): void {
    const base = this.position.length / 3;
    const verts: Point[] = ICO_VERTS.map((v) => {
      const l = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / l, v[1] / l, v[2] / l];
    });
    let faces = ICO_FACES.map((f) => [...f] as [number, number, number]);

    for (let d = 0; d < detail; d++) {
      const midpoints = new Map<number, number>();
      const mid = (a: number, b: number): number => {
        const key = a < b ? a * 4096 + b : b * 4096 + a;
        const found = midpoints.get(key);
        if (found !== undefined) return found;
        const va = verts[a];
        const vb = verts[b];
        const mx = (va[0] + vb[0]) / 2;
        const my = (va[1] + vb[1]) / 2;
        const mz = (va[2] + vb[2]) / 2;
        const l = Math.hypot(mx, my, mz) || 1;
        verts.push([mx / l, my / l, mz / l]);
        const idx = verts.length - 1;
        midpoints.set(key, idx);
        return idx;
      };
      const next: Array<[number, number, number]> = [];
      for (const [a, b, c] of faces) {
        const ab = mid(a, b);
        const bc = mid(b, c);
        const ca = mid(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      faces = next;
    }

    for (const v of verts) {
      this.vertex(
        [centre[0] + v[0] * radii[0], centre[1] + v[1] * radii[1], centre[2] + v[2] * radii[2]],
        v,
        role,
        skin,
      );
    }
    for (const [a, b, c] of faces) this.index.push(base + a, base + b, base + c);
  }

  /**
   * An axis-aligned box, 12 triangles on 24 vertices.
   *
   * Written out face by face rather than generated, and the corner orders below
   * were each checked by hand against the outward normal, because the README
   * records that `power.ts`'s equivalent has all twelve triangles wound inside
   * out and nothing in the picture said so. `verifyCharacterRig` checks it a
   * second way -- every triangle in this mesh has to agree with its own stored
   * normals -- so a slip here fails at startup instead of shipping.
   */
  box(centre: Point, half: Point, role: Role, skin: Skin): void {
    const [cx, cy, cz] = centre;
    const [hx, hy, hz] = half;
    const p = (sx: number, sy: number, sz: number): Point => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const faces: Array<[Point, Point[]]> = [
      [[1, 0, 0], [p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1)]],
      [[-1, 0, 0], [p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)]],
      [[0, 1, 0], [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)]],
      [[0, -1, 0], [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)]],
      [[0, 0, 1], [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)]],
      [[0, 0, -1], [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)]],
    ];
    for (const [n, corners] of faces) {
      const base = this.position.length / 3;
      for (const corner of corners) this.vertex(corner, n, role, skin);
      this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

// --- Proportions --------------------------------------------------------------

/*
 * Every dimension of the figure, in metres, in one place.
 *
 * Read against `RIG` in `animation.ts`: the joints are there and the flesh is
 * here, and the two have to agree or a limb pivots somewhere it does not bend.
 * Three numbers carry the whole of spec 8.1's brief:
 *
 *   HEAD_RADII[1] * 2 / FIGURE_HEIGHT   = 0.294   "big heads"
 *   ARM_UPPER_R / HEAD_RADII[0]         = 0.281   "noodle arms"
 *   MITT_RADII[0] * 2 / (HEAD_RADII[0] * 2) = 0.51   "oversized hands"
 *
 * That last one is a deliberate reading of the brief rather than a literal one.
 * A mitt at one and a half times the *head's width* would be 0.55 m across and
 * wider than the figure is deep; what is 1.5x here is the hand-to-head ratio
 * against life, where a real hand spans about 0.34 of a head's width and this
 * one spans 0.51. Against the thing it is actually seen next to -- a 0.092 m
 * forearm -- the mitt is 2.1 times wider, which is what reads as a mitt.
 */
const HEAD_CENTRE: Point = [0, 1.445, 0];
const HEAD_RADII: Point = [0.185, 0.25, 0.175];
const ARM_UPPER_R = 0.052;
const ARM_LOWER_R = 0.046;
const ARM_WRIST_R = 0.04;
const MITT_RADII: Point = [0.095, 0.105, 0.062];
const SHOULDER_X = 0.185;
const HIP_X = 0.105;

/** Sides on a limb tube. Eight, and the reason is the punch camera. */
const LIMB_SIDES = 8;

/**
 * Build the figure, once, in the bind pose.
 *
 * Facing **-Z** at yaw 0, sole at y = 0 -- the same two conventions
 * `controller.step` and `birds.ts` use, so a heading is a heading and a ground
 * height is a ground height everywhere in this client.
 *
 * The order below is the order a reader would draw it in, and the only thing
 * worth watching while reading is the **joint bindings**: wherever two segments
 * meet, both of the coincident rings are given the *same* `Skin`. That is not
 * tidiness, it is the whole reason the elbow does not tear open. Two rings at
 * the same point with different weights deform to different points the moment
 * the joint bends, and what opens up is a wedge you can see the inside of the
 * arm through.
 */
function buildFigure(): Parts {
  const p = new Parts();

  // Joints, each defined once and handed to both of the rings that meet there.
  const waist = w2(BONE.SPINE, BONE.HIPS, 0.5);
  const chestMid = w2(BONE.CHEST, BONE.SPINE, 0.5);
  const neckBase = w2(BONE.NECK, BONE.CHEST, 0.5);

  // --- Head. 0.50 m tall on a 1.70 m figure: 29% of the whole character, which
  // is the single loudest thing about the silhouette and the reason a player is
  // recognisable as a *character* at a distance where the city is still
  // rectangles.
  p.lobe(HEAD_CENTRE, HEAD_RADII, ROLE.SKIN, w1(BONE.HEAD), 1);

  // Eyes: two dark lobes, set wide and standing slightly proud of the face.
  // Wide because a comic face is wide-set, proud because a flush eye on a
  // faceted head disappears into whichever facet it lands on.
  for (const side of [-1, 1] as const) {
    p.lobe([side * 0.075, 1.5, -0.163], [0.045, 0.055, 0.032], ROLE.EYE, w1(BONE.HEAD));
  }
  // A four-sided nose. Eight triangles that answer "which way is this character
  // facing" from behind, from above, and in silhouette against a bright wall.
  p.tube([0, 1.44, -0.165], [0, 1.425, -0.238], 0.03, 0.012, 4, ROLE.SKIN, w1(BONE.HEAD));

  // --- Neck. Almost none of it, which is the point: the head sits on the
  // shoulders. Only 2.5 cm of this is ever outside the head.
  p.tube([0, 1.16, 0], [0, 1.27, 0], 0.063, 0.058, LIMB_SIDES, ROLE.SKIN, neckBase, w1(BONE.NECK));

  // --- Torso, in a singlet. Two stacked tubes so it can be blended at the waist
  // and again at the sternum, and a disc closing the top under the head.
  p.tube([0, 0.755, 0], [0, 0.99, 0], 0.155, 0.163, LIMB_SIDES, ROLE.SINGLET, waist, chestMid);
  p.tube([0, 0.99, 0], [0, 1.155, 0], 0.163, 0.175, LIMB_SIDES, ROLE.SINGLET, chestMid, w1(BONE.CHEST));
  p.disc([0, 1.155, 0], 0.175, LIMB_SIDES, true, ROLE.SINGLET, w1(BONE.CHEST));

  // --- Shorts. Flared at the hem, over the bottom of the singlet, with the hem
  // closed by a down-facing disc the thighs pass through -- otherwise the figure
  // is hollow when seen from below, which in a game with a jump button happens.
  p.tube([0, 0.62, 0], [0, 0.905, 0], 0.185, 0.168, LIMB_SIDES, ROLE.SHORTS, w1(BONE.HIPS));
  p.disc([0, 0.62, 0], 0.185, LIMB_SIDES, false, ROLE.SHORTS, w1(BONE.HIPS));

  // --- Arms. Three segments each, per the brief, and thin: a 0.052 m upper arm
  // against a 0.185 m head half-width. The noodle is as much this ratio as it is
  // the length.
  for (const side of [-1, 1] as const) {
    const shoulder = side < 0 ? BONE.SHOULDER_L : BONE.SHOULDER_R;
    const elbow = side < 0 ? BONE.ELBOW_L : BONE.ELBOW_R;
    const wrist = side < 0 ? BONE.WRIST_L : BONE.WRIST_R;
    const x = side * SHOULDER_X;

    // The shoulder lobe is bound 0.65 to the arm and 0.35 to the chest, which is
    // the only place in this mesh where a smooth blend is genuinely needed: a
    // rigid shoulder punches a hole in the singlet the moment the arm goes over
    // the head, and the punch clip raises it 1.5 rad.
    const shoulderJoint = w2(shoulder, BONE.CHEST, 0.65);
    const elbowJoint = w2(shoulder, elbow, 0.5);
    const wristJoint = w2(elbow, wrist, 0.5);

    p.lobe([x, 1.14, 0], [0.068, 0.062, 0.062], ROLE.SKIN, shoulderJoint);
    p.tube([x, 1.14, 0], [x, 0.81, 0], ARM_UPPER_R, ARM_LOWER_R, LIMB_SIDES, ROLE.SKIN, shoulderJoint, elbowJoint);
    p.tube([x, 0.81, 0], [x, 0.5, 0], ARM_LOWER_R, ARM_WRIST_R, LIMB_SIDES, ROLE.SKIN, elbowJoint, wristJoint);
    // The mitt. Centred below the wrist joint and rigid to it, so the swing's
    // 1.10x stretch arrives here as a smear along the arm rather than as a joint
    // that has to be reasoned about. It is also what the cricket bat hangs off:
    // `player/bat.ts` parents a prop to this wrist bone, and a hand that is one
    // rigid lobe is why the swing clip can put 2.15 rad through the wrist and
    // have it read as the bat's arc rather than as a broken hand.
    p.lobe([x, 0.435, -0.008], MITT_RADII, ROLE.SKIN, w1(wrist));
  }

  // --- Legs. Simple, per the brief -- the comedy is in the arms and the head,
  // and a pair of legs that draws attention to itself fights both.
  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? BONE.HIP_L : BONE.HIP_R;
    const knee = side < 0 ? BONE.KNEE_L : BONE.KNEE_R;
    const ankle = side < 0 ? BONE.ANKLE_L : BONE.ANKLE_R;
    const x = side * HIP_X;

    const hipJoint = w2(hip, BONE.HIPS, 0.7);
    const kneeJoint = w2(hip, knee, 0.5);
    const ankleJoint = w2(knee, ankle, 0.5);

    p.tube([x, 0.815, 0], [x, 0.415, 0], 0.088, 0.075, LIMB_SIDES, ROLE.SKIN, hipJoint, kneeJoint);
    p.tube([x, 0.415, 0], [x, 0.06, 0], 0.075, 0.055, LIMB_SIDES, ROLE.SKIN, kneeJoint, ankleJoint);
    // A shoe: a box, toes forward at -Z, sole on the ground at y = 0. Its
    // dimensions come from `animation.ts` rather than being written here,
    // because `legPair` computes the body's height from where this sole is --
    // see `soleDrop`. Two copies of "how long is a foot" is a character that
    // walks correctly and scuffs, with nothing in either file looking wrong.
    p.box(
      [x, FOOT_THICKNESS / 2, (FOOT_TOE + FOOT_HEEL) / 2],
      [FOOT_HALF_WIDTH, FOOT_THICKNESS / 2, (FOOT_HEEL - FOOT_TOE) / 2],
      ROLE.SHOE,
      w1(ankle),
    );
  }

  return p;
}

// --- Shared assets ------------------------------------------------------------

/**
 * One figure's geometry in seven kits, and one material for all of them.
 *
 * Built once for the whole game and shared by every actor -- the same contract
 * `BirdAssets` has, and with the same consequence for teardown: an actor must
 * never dispose this geometry, because every other actor is drawing it.
 */
export class CharacterAssets {
  /** One per colourway. All seven share position, normal, skinIndex and skinWeight. */
  readonly geometries: readonly BufferGeometry[];
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;
  /** The bind pose's sphere, inflated to cover every clip. See the constructor. */
  readonly bounds: Sphere;

  /**
   * What each vertex is made of, and the four attributes every kit shares.
   *
   * Kept after construction so that a **kit outside `COLOURWAYS` can be mixed
   * later** -- see `kitGeometry`. Nothing about the figure is rebuilt for one:
   * the position, normal and skin bindings are the same buffers the seven
   * player kits are drawn from, and the only thing a new kit costs is a colour
   * attribute, which at this vertex count is a few kilobytes.
   *
   * The alternative -- adding an eighth entry to `COLOURWAYS` -- was rejected
   * because that array is the **player** wardrobe and three other things count
   * it: the server assigns a colourway per join out of its length,
   * `pedestrians.PEDESTRIAN_KIT_COUNT` must equal it or a walker changes clothes
   * at the LOD handoff, and `verifyPedestrians` asserts exactly that. A police
   * uniform is not a kit a player can be given, and putting it in the list of
   * kits a player can be given would make it one.
   */
  private readonly roles: readonly number[];
  private readonly shared: {
    position: BufferAttribute;
    normal: BufferAttribute;
    skinIndex: BufferAttribute;
    skinWeight: BufferAttribute;
    index: BufferAttribute;
  };

  constructor() {
    const parts = buildFigure();
    const count = parts.position.length / 3;
    this.roles = parts.role;

    const position = new BufferAttribute(new Float32Array(parts.position), 3);
    const normal = new BufferAttribute(new Float32Array(parts.normal), 3);
    // `Uint16` on skinIndex because three's WebGPU backend uploads it as a
    // `uvec4` attribute and 17 bones fit in a byte twice over. `Uint8` would
    // work too and is not offered a normalised path by three's attribute
    // handling, so this is the narrow form that is actually safe.
    const skinIndex = new BufferAttribute(new Uint16Array(parts.skinIndex), 4);
    const skinWeight = new BufferAttribute(new Float32Array(parts.skinWeight), 4);
    const index = new BufferAttribute(new Uint16Array(parts.index), 1);

    // One bounding sphere, computed from the bind pose and then **inflated**.
    //
    // A skinned mesh's rest bounds are not its animated bounds, and every clip
    // here leaves them: a swing reaches past the arm and a jump tucks the whole
    // figure. A tight sphere makes a character vanish at the edge of the screen
    // exactly when they are swinging. Inflating by 0.45 m is cheaper and
    // far more robust than turning culling off, and it is measured rather than
    // guessed -- `verifyCharacterRig` steps every clip, skins every vertex on
    // the CPU, and asserts the result stays inside it.
    //
    // It has to be set on the **mesh** and not only on the geometry, and that is
    // the trap. `Frustum.intersectsObject` prefers `object.boundingSphere` when
    // the property merely *exists*, and `SkinnedMesh`'s constructor initialises
    // it to `null` -- so three calls `SkinnedMesh.computeBoundingSphere()` on the
    // first frame the object is culled, caching a sphere from whatever pose it
    // happened to be in, and never recomputing. The geometry's sphere would be
    // ignored entirely. See `CharacterActor`'s constructor, which assigns this.
    const bounds = new Sphere();
    const vertex = new Vector3();
    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(position, i);
      bounds.expandByPoint(vertex);
    }
    bounds.radius += 0.45;
    this.bounds = bounds;

    this.shared = { position, normal, skinIndex, skinWeight, index };
    const geometries: BufferGeometry[] = [];
    for (const kit of COLOURWAYS) geometries.push(this.kitGeometry(kit));
    this.geometries = geometries;
    this.triangles = parts.index.length / 3;
    this.vertices = count;

    const material = new MeshStandardNodeMaterial();
    material.name = 'character';
    // No `colorNode`, exactly as the trees, cars and birds have none:
    // `NodeMaterial` already multiplies the material colour by the geometry
    // `color` attribute, so seven kits arrive through one built-in multiply and
    // no shader graph.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Cotton singlet and bare skin. Not as matte as foliage and not as matte as
    // a bird -- a sunlit forearm carries a sheen, and at roughness 1.0 a
    // character goes to felt.
    material.roughness = 0.78;
    material.metalness = 0.0;
    // Faceted, like every other procedural object in this client. On a
    // skinned mesh three derives the flat normal from `dFdx/dFdy` of the
    // *view* position, which is post-skinning, so a bent elbow's facets are
    // shaded by their bent normals. Checked in three's `Normal.js` rather
    // than assumed, because a smooth-shaded fallback here would look like a
    // taste decision rather than a broken normal path.
    material.flatShading = true;
    this.material = material;
  }

  /**
   * The figure in an arbitrary kit, sharing every buffer except the colours.
   *
   * The seven player kits are built through this and so is anything a faction
   * wants -- `world/police.ts` asks for one navy one. A caller owns the geometry
   * it is handed and may dispose it; it must **never** dispose
   * `CharacterAssets.material`, or the attributes it shares with every other
   * figure in the city, which is `BatAssets`' contract restated.
   *
   * `bounds` is the shared inflated sphere rather than a fresh one, and the
   * clone is not optional: `SkinnedMesh` writes to `boundingSphere` on the first
   * frame it is culled (see the constructor's long note), so handing two
   * geometries the same `Sphere` object would let one mesh's cached pose become
   * every other mesh's culling volume.
   */
  kitGeometry(kit: Colourway): BufferGeometry {
    const g = new BufferGeometry();
    g.name = `character:${kit.name}`;
    g.setAttribute('position', this.shared.position);
    g.setAttribute('normal', this.shared.normal);
    g.setAttribute('skinIndex', this.shared.skinIndex);
    g.setAttribute('skinWeight', this.shared.skinWeight);
    g.setIndex(this.shared.index);
    const count = this.shared.position.count;
    const colour = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const c = roleColour(kit, this.roles[i]);
      colour[i * 3] = c[0];
      colour[i * 3 + 1] = c[1];
      colour[i * 3 + 2] = c[2];
    }
    g.setAttribute('color', new BufferAttribute(colour, 3));
    g.boundingSphere = this.bounds.clone();
    return g;
  }
}

// --- The actor ----------------------------------------------------------------

export type LocomotionName = 'idle' | 'walk' | 'run' | 'jump';
/**
 * `ride` is a reaction rather than a locomotion, and it is worth saying why.
 *
 * The four locomotions crossfade against **speed** -- that is the whole of what
 * `updateWeights` does -- and riding is not a speed: a rider pulling away from a
 * kerb and one doing 26 m/s down Cleveland Street are in the same pose. Making
 * it a fifth locomotion would mean a fifth weight, a fifth branch in every pin
 * case, and a crossfade against a run that must never actually happen.
 *
 * As a reaction it is one line in `applyReaction` and it **holds**, which is the
 * property `knockout` already needed and which is exactly right here: the pose
 * stays until something clears it, and being punched or knocked out replaces it
 * -- by which point `combat.applyHit` has already taken the bike away.
 */
export type ReactionName = 'punch' | 'throw' | 'flinch' | 'knockout' | 'ride';
export type ActionName = LocomotionName | ReactionName;

export interface ActorInput {
  /** World position of the character's **feet**. The mesh origin is the sole. */
  position: { x: number; y: number; z: number };
  /** Radians. Yaw 0 faces -Z. */
  yaw: number;
  /** Horizontal speed, m/s. Drives the stride, so it must be the real one. */
  speed: number;
  onGround: boolean;
  /**
   * A requested action, applied only when it *changes*. Passing `'punch'` every
   * frame throws one punch, not sixty -- which is the behaviour a caller wiring
   * this to a mouse button wants and the opposite of what a naive read would do.
   */
  action?: ActionName | null;
}

/** How long an overlay takes to fade in and out. Short: these are impacts. */
const OVERLAY_IN = 0.07;
const OVERLAY_OUT = 0.11;

/**
 * Time constant for the locomotion crossfade, seconds -- and it is applied to
 * the blend **weights**, never to the pose.
 *
 * This distinction cost a full debugging pass and is the single most useful
 * thing in this file to have written down. The obvious arrangement is to
 * low-pass the composed pose, which smooths every transition in one place. It
 * also destroys the gait: a low-pass filter does not know the difference between
 * a transition and the clip's own cycle, and a run's stride runs at 3.15 Hz,
 * where an 80 ms filter attenuates by 0.53. That would be survivable if it
 * attenuated everything equally, and it does not -- the stance compensation in
 * `animation.legPair` cancels a `1 - cos(theta)` drop against a `sec(theta)`
 * lengthening and a linear body lift, and halving `theta` shrinks the first term
 * *quadratically* and the other two linearly. The residual was measured at
 * **0.26 m of leg through the pavement** at sprint speed, from a filter whose
 * only job was to make idle-to-walk smooth.
 *
 * Smoothing the weights instead has neither problem. A crossfade between two
 * clips is exactly a weight moving from 0 to 1, each clip is evaluated at full
 * fidelity at every instant, and nothing inside a cycle is touched.
 */
const BLEND_TAU = 0.1;

/** Stride speeds used when a locomotion clip is pinned for inspection and the actor is standing still. */
const PINNED_WALK_SPEED = 2.6;
const PINNED_RUN_SPEED = 6.8;

/**
 * One character in the world: a mesh, a skeleton, a colourway and a pose.
 *
 * Owns nothing shared. Constructing one is a `SkinnedMesh`, seventeen `Bone`
 * objects and a `Skeleton`, all cheap; the geometry and the material come from
 * `CharacterAssets` and are never disposed by an actor.
 */
export class CharacterActor {
  readonly mesh: SkinnedMesh;
  readonly bones: readonly Bone[];
  readonly colourway: number;

  /** Seconds since construction. The clock the idle drifts on. */
  private time = 0;
  /** Radians of stride phase, advanced by distance walked. */
  private stride = 0;
  /** Seconds since leaving the ground. */
  private air = 0;
  private speed = 0;

  /** The clip a caller has pinned, or null for automatic. */
  private pinned: LocomotionName | null = null;
  private reaction: ReactionName | null = null;
  private reactionClock = 0;
  private lastRequest: ActionName | null | undefined = undefined;

  /** Smoothed clip weights. The only thing in this actor that is filtered. */
  private wWalk = 0;
  private wRun = 0;
  private wAir = 0;

  private readonly pose = createPose();
  private readonly overlay = createPose();
  private readonly scratch = createPose();
  private readonly ctx: ClipContext = { time: 0, stride: 0, speed: 0, air: 0, t: 0 };

  /**
   * `geometry` overrides the kit, for a figure that is **not** wearing one of
   * the seven player colourways -- a police uniform, and whatever the factions
   * behind them want.
   *
   * An argument rather than a wider `COLOURWAYS` for the reason
   * `CharacterAssets.kitGeometry` states: that array is the player wardrobe and
   * three other things count its length. The actor still records a `colourway`,
   * because `PedestrianCrowd` swaps geometries on a pooled rig by comparing it;
   * an actor constructed with an override simply never takes part in that.
   */
  constructor(assets: CharacterAssets, colourway = 0, geometry?: BufferGeometry) {
    this.colourway = ((colourway % COLOURWAYS.length) + COLOURWAYS.length) % COLOURWAYS.length;

    const bones = RIG.map((spec) => {
      const bone = new Bone();
      bone.name = spec.name;
      bone.position.set(spec.rest[0], spec.rest[1], spec.rest[2]);
      return bone;
    });
    for (let i = 0; i < RIG.length; i++) {
      const parent = RIG[i].parent;
      if (parent >= 0) bones[parent].add(bones[i]);
    }
    this.bones = bones;

    const mesh = new SkinnedMesh(geometry ?? assets.geometries[this.colourway], assets.material);
    mesh.name = `character:${geometry?.name ?? COLOURWAYS[this.colourway].name}`;
    mesh.add(bones[0]);
    // The bind pose has to be *current* before the skeleton takes its inverses,
    // or every bone's inverse is the identity and the mesh collapses to a point
    // the first time a bone moves.
    mesh.updateMatrixWorld(true);
    // An identity bind matrix, which is exact rather than convenient: the bones
    // are children of the mesh, so `bone.matrixWorld` already carries the model
    // matrix, and three's default `AttachedBindMode` recomputes
    // `bindMatrixInverse` from `mesh.matrixWorld` every frame. The two cancel,
    // and the skinned result comes out in mesh-local space wherever the mesh is.
    // The mesh is still at the origin here, so the inverses the `Skeleton`
    // takes are the pure bind pose.
    mesh.bind(new Skeleton(bones as Bone[]), new Matrix4());
    // The animated bounds, on the mesh rather than the geometry, because that is
    // the one three actually reads for a `SkinnedMesh`. See `CharacterAssets`.
    mesh.boundingSphere = assets.bounds.clone();

    // Casts, and receives. Casting is the whole reason this project has a
    // character at all before it has a punch -- see `main.ts`, where the local
    // player's own body is put on a layer the camera excludes and the sun's
    // shadow camera does not. Receiving matters as much and is easy to forget:
    // a figure standing in a building's shadow lit as though it were in full sun
    // is the single most obvious way to make a character look pasted on.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.mesh = mesh;
  }

  /** The kit this actor is wearing. */
  get kit(): Colourway {
    return COLOURWAYS[this.colourway];
  }

  /** What is playing: the pinned or derived locomotion, and any reaction over it. */
  get action(): { locomotion: LocomotionName; reaction: ReactionName | null } {
    return { locomotion: this.pinned ?? this.derivedLocomotion(), reaction: this.reaction };
  }

  /**
   * Play something, now.
   *
   * A reaction name starts a one-shot overlay and replaces whatever was already
   * running. A locomotion name **pins** that clip until it is cleared, which is
   * what makes every clip inspectable from the console without having to arrange
   * for the character to actually be doing it. `null` clears both.
   */
  setAction(name: ActionName | null): void {
    if (name === null) {
      this.pinned = null;
      this.reaction = null;
      this.reactionClock = 0;
      return;
    }
    if (
      name === 'punch' || name === 'throw' || name === 'flinch' ||
      name === 'knockout' || name === 'ride'
    ) {
      // Re-issuing the ride that is already playing is ignored rather than
      // restarted. Every other reaction here is a one-shot whose caller fires it
      // on an edge; this one is a *state*, and a caller that level-triggers it --
      // which is the obvious thing to write, and what a remote's RIDING flag
      // arriving twenty times a second would do -- would otherwise restart the
      // 0.2 s blend on every snapshot and hold the rider permanently half-seated.
      if (name === 'ride' && this.reaction === 'ride') return;
      this.reaction = name;
      this.reactionClock = 0;
      return;
    }
    this.pinned = name;
  }

  /** Total seconds a reaction runs for, including the hold on a knockout. */
  private reactionDuration(name: ReactionName): number {
    if (name === 'punch') return PUNCH_TOTAL;
    if (name === 'throw') return THROW_DURATION;
    if (name === 'flinch') return FLINCH_DURATION;
    // Not a clip length: `ride` holds, so this is only the window it fades in
    // over. See `animation.RIDE_BLEND`.
    if (name === 'ride') return RIDE_BLEND;
    return KNOCKOUT_DURATION;
  }

  private derivedLocomotion(): LocomotionName {
    if (this.air > 0.02) return 'jump';
    if (this.speed > 6.0) return 'run';
    if (this.speed > 0.35) return 'walk';
    return 'idle';
  }

  update(dt: number, input: ActorInput): void {
    if (input.action !== undefined && input.action !== this.lastRequest) {
      this.lastRequest = input.action;
      this.setAction(input.action);
    }

    this.time += dt;
    this.speed = Math.max(0, input.speed);
    this.air = input.onGround ? 0 : this.air + dt;

    // The stride advances by *distance*, which is what keeps the feet planted.
    // A pinned clip with no movement under it is the one exception, and it is a
    // deliberate one: an inspection pose that stands still with its legs frozen
    // is useless, so a pinned walk or run drives the phase at a nominal speed
    // and slides its feet on purpose.
    let strideSpeed = this.speed;
    if (this.pinned === 'walk' && strideSpeed < 0.3) strideSpeed = PINNED_WALK_SPEED;
    if (this.pinned === 'run' && strideSpeed < 0.3) strideSpeed = PINNED_RUN_SPEED;
    this.stride = (this.stride + (strideSpeed * dt * Math.PI * 2) / strideLength(strideSpeed)) % (Math.PI * 2);

    const ctx = this.ctx;
    ctx.time = this.time;
    ctx.stride = this.stride;
    ctx.speed = this.pinned === 'run' ? Math.max(this.speed, PINNED_RUN_SPEED) : this.speed;
    ctx.air = this.pinned === 'jump' ? Math.max(this.air, 0.2) : this.air;

    this.updateWeights(dt, input.onGround, ctx.speed);
    this.buildLocomotion(ctx);

    copyPose(this.scratch, this.pose);
    this.applyReaction(dt, ctx);
    this.applyToBones(this.scratch);

    this.mesh.position.set(input.position.x, input.position.y + this.scratch.lift, input.position.z);
    this.mesh.rotation.set(0, input.yaw, 0);
  }

  /**
   * Move the three clip weights toward what the state asks for.
   *
   * Walk fades in from a shuffle and run fades in over the band where the
   * controller's WALK_SPEED (4.4) and SPRINT_SPEED (8.2) sit, so the crossover
   * happens where a player actually changes gait rather than at an arbitrary
   * number. Pinning aims a weight at 0 or 1 and lets it travel there at the same
   * rate as everything else, so an inspection pose crossfades in rather than
   * snapping.
   */
  private updateWeights(dt: number, onGround: boolean, speed: number): void {
    let walk = smoothstep(0.35, 1.9, speed);
    let run = smoothstep(4.6, 7.4, speed);
    let air = onGround ? 0 : 1;
    if (this.pinned === 'idle') {
      walk = 0;
      run = 0;
      air = 0;
    } else if (this.pinned === 'walk') {
      walk = 1;
      run = 0;
      air = 0;
    } else if (this.pinned === 'run') {
      walk = 1;
      run = 1;
      air = 0;
    } else if (this.pinned === 'jump') {
      air = 1;
    }

    const k = Math.min(1, 1 - Math.exp(-dt / BLEND_TAU));
    this.wWalk += (walk - this.wWalk) * k;
    this.wRun += (run - this.wRun) * k;
    this.wAir += (air - this.wAir) * k;
  }

  /** Idle, walk, run and jump, layered in that order at the current weights. */
  private buildLocomotion(ctx: ClipContext): void {
    const pose = this.pose;
    resetPose(pose);
    clipIdle(pose, ctx);

    if (this.wWalk > 0.001) {
      resetPose(this.scratch);
      clipWalk(this.scratch, ctx);
      blendPose(pose, this.scratch, this.wWalk, null);
    }
    if (this.wRun > 0.001) {
      resetPose(this.scratch);
      clipRun(this.scratch, ctx);
      blendPose(pose, this.scratch, this.wRun, null);
    }
    if (this.wAir > 0.001) {
      resetPose(this.scratch);
      clipJump(this.scratch, ctx);
      blendPose(pose, this.scratch, this.wAir, null);
    }
  }

  /**
   * Lay the current reaction over `this.scratch`.
   *
   * A swing is masked to the upper body, so a character can swing the bat while
   * walking and the legs keep walking. A flinch and a knockout are not: being hit
   * interrupts what you were doing, and a knockout ends it.
   *
   * A knockout **holds** rather than ending. It is the only clip here that does,
   * and it is what makes this usable by the punch project: drive `t` to 1 and the
   * figure stays crumpled until something clears the action.
   */
  private applyReaction(dt: number, ctx: ClipContext): void {
    const reaction = this.reaction;
    if (reaction === null) return;

    this.reactionClock += dt;
    const duration = this.reactionDuration(reaction);
    // Two clips hold rather than end, for opposite reasons: a knockout holds
    // because the body has stopped, and a ride holds because the rider has not.
    const held =
      (reaction === 'knockout' || reaction === 'ride') && this.reactionClock >= duration;
    if (this.reactionClock >= duration && !held) {
      this.reaction = null;
      return;
    }

    const clock = Math.min(this.reactionClock, duration);
    // Fade in always; fade out only on clips that end. A held knockout stays at
    // full weight forever, which is the point of it.
    const weight = held
      ? 1
      : Math.min(smoothstep(0, OVERLAY_IN, clock), 1 - smoothstep(duration - OVERLAY_OUT, duration, clock));

    resetPose(this.overlay);
    // The overlay inherits the pose's lift before the clip runs, and that one
    // line is what stops a punch sinking the character.
    //
    // `blendPose` moves `lift` at the mask's *root* weight, which is right --
    // the hips carry the figure -- and `UPPER_BODY` gives the hips 0.33 so a
    // punch can be thrown from the ground. Without this, a punch's lift of zero
    // would be blended in at 0.33 and pull a walking character a third of its
    // bob into the footpath for half a second. Seeding it instead makes the rule
    // "a clip that does not set `lift` does not move the figure vertically",
    // which is what every clip here except the flinch and the knockout wants.
    this.overlay.lift = this.scratch.lift;
    if (reaction === 'punch') {
      // The three phases of spec 8.2, in their own windows. Each gets `t` in
      // [0, 1] across *its* phase rather than across the punch, so a phase's
      // easing is written against its own duration and changing one window does
      // not silently re-time the other two.
      if (clock < PUNCH_WIND_UP) {
        ctx.t = clock / PUNCH_WIND_UP;
        clipPunchWindUp(this.overlay, ctx);
      } else if (clock < PUNCH_WIND_UP + PUNCH_ACTIVE) {
        ctx.t = (clock - PUNCH_WIND_UP) / PUNCH_ACTIVE;
        clipPunchActive(this.overlay, ctx);
      } else {
        ctx.t = (clock - PUNCH_WIND_UP - PUNCH_ACTIVE) / PUNCH_RECOVERY;
        clipPunchRecovery(this.overlay, ctx);
      }
      blendPose(this.scratch, this.overlay, weight, UPPER_BODY);
      return;
    }
    if (reaction === 'throw') {
      // Masked to the upper body exactly as the swing is, and for the same
      // reason: a player throws while running far more often than they throw
      // standing still, and an unmasked throw would stop the legs dead for a
      // third of a second every time.
      ctx.t = clock / duration;
      clipThrow(this.overlay, ctx);
      blendPose(this.scratch, this.overlay, weight, UPPER_BODY);
      return;
    }

    ctx.t = held ? 1 : clock / duration;
    if (reaction === 'flinch') clipFlinch(this.overlay, ctx);
    // The ride reads `ctx.stride` rather than `ctx.t`, which is already set by
    // `update` from the distance travelled -- so the cranks turn with the wheels
    // and not with the blend.
    else if (reaction === 'ride') clipRide(this.overlay, ctx);
    else clipKnockout(this.overlay, ctx);
    blendPose(this.scratch, this.overlay, weight, WHOLE_BODY);
  }

  private applyToBones(pose: Pose): void {
    const bones = this.bones;
    for (let b = 0; b < BONE_COUNT; b++) {
      const i = b * 3;
      bones[b].rotation.set(pose.rot[i], pose.rot[i + 1], pose.rot[i + 2]);
      // Non-uniform, along the bone's own limb axis. See the rig's header for
      // why every bone in this skeleton points its +Y at its child.
      bones[b].scale.set(1, pose.stretch[b], 1);
    }
  }

  /** Where the head is in world space, for a caller that wants to aim at it. */
  headPosition(target: Vector3): Vector3 {
    return target.setFromMatrixPosition(this.bones[BONE.HEAD].matrixWorld);
  }
}

// --- The first-person self, and its shadow ------------------------------------

/**
 * The layer the local player's own body lives on: seen by the sun, not by the eye.
 *
 * Layer 1 rather than any other because layer 0 is where everything else in this
 * project already is, and three's `Layers` default -- `1 << 0` -- is what every
 * object and every camera starts with.
 */
export const SELF_SHADOW_LAYER = 1;

/**
 * Make an object invisible to the camera while keeping it in the shadow map.
 *
 * **This is the mechanism, and it was chosen against three alternatives that all
 * work badly.** The thing being bought is small and constant: in first person
 * you should be able to look down at a Sydney footpath at 3 pm and see your own
 * shadow on it, arms swinging, and it should punch when you punch. Every other
 * moving object in this world already throws one -- the trees, the parked cars,
 * the bins, the ibises -- and the player being the single exception is the kind
 * of absence nobody names and everybody feels.
 *
 * What was rejected:
 *
 *   - **`visible = false`** removes the object from `_projectObject` entirely,
 *     which is every pass including the depth one. No shadow. This is the
 *     obvious move and it is simply wrong.
 *   - **`colorWrite = false`** does work on the WebGPU path --
 *     `WebGPUPipelineUtils._getColorWriteMask` maps it to
 *     `GPUColorWriteFlags.None` -- but it only stops the *colour* write. The
 *     body would still be rasterised at the camera's own position and would
 *     still write depth, punching a hole through the city in front of the
 *     player. Turning `depthWrite` off as well leaves a full-screen rasterise
 *     of a 440-triangle mesh doing nothing at all, every frame, to achieve what
 *     one bit of a layer mask achieves for free.
 *   - **Near-plane clipping** -- keep the body visible and trust the 0.1 m near
 *     plane to cut the head off -- fails on inspection: the eye is at 1.68 m and
 *     the crown at 1.70, so the near plane clips a slice of skull and leaves the
 *     inside of a shoulder, a singlet strap and both arms in frame. It also
 *     breaks the moment anyone looks down.
 *
 * What works is **layers, and specifically the fact that three's shadow pass
 * runs `renderer.render(scene, shadow.camera)`** -- a real render with a real
 * camera -- so `_projectObject`'s `object.layers.test(camera.layers)` is
 * evaluated against the *shadow* camera's mask. Put the body on layer 1 only,
 * leave the main camera on layer 0 only, and enable layer 1 on the sun's shadow
 * camera: the eye never sees it and the sun always does.
 *
 * The one trap is in `ShadowNode.updateShadow`, and it is why this function
 * exists rather than a line at the call site:
 *
 *     if ( ( shadow.camera.layers.mask & 0xFFFFFFFE ) === 0 )
 *         shadow.camera.layers.mask = camera.layers.mask;
 *
 * A shadow camera that has *only* layer 0 enabled -- the default -- is treated
 * as unconfigured and silently inherits the view camera's mask every frame,
 * which would overwrite anything set here. Enabling any layer above 0 makes that
 * test false and the shadow camera keeps its own mask, so `enable(1)` both asks
 * for the body and pins the arrangement in place. `enable` and not `set`,
 * because the mask has to keep layer 0 as well or the entire city stops casting.
 */
export function castShadowOnly(mesh: SkinnedMesh, shadowCamera: { layers: { enable(n: number): void } }): void {
  mesh.layers.set(SELF_SHADOW_LAYER);
  mesh.castShadow = true;
  // Pointless on an object the camera never draws, and it would compile a second
  // pipeline variant: three keys the render pipeline on `receiveShadow`.
  mesh.receiveShadow = false;
  shadowCamera.layers.enable(SELF_SHADOW_LAYER);
}

/**
 * Let the camera see an object `castShadowOnly` hid from it, or hide it again.
 *
 * This is third person, and it is the *whole* of third person as far as the
 * local player's body is concerned. `castShadowOnly` above moved the body to
 * layer 1 alone; showing it is `enable(0)` and not `set(0)` -- the shadow layer
 * has to stay, or stepping into third person would take the player's shadow off
 * the footpath at the exact moment they could finally see it.
 *
 * It takes an `Object3D` rather than a `SkinnedMesh` because it has three
 * callers and they are three different classes: the body, `BatProp` and
 * `FootyProp`. **Three does not inherit layers** -- `Renderer._projectObject`
 * tests every object's own mask -- so a prop parented to a bone of a body that
 * just became visible is still on layer 1 and still invisible. That is the exact
 * bug `verifyFootyBall` was written for, one direction over, and it is why this
 * is a free function taking anything with layers rather than a method on the
 * body that could only ever fix a third of the problem.
 *
 * `receiveShadow` is turned on and **left on**. Three keys its render pipeline
 * on that flag, so flipping it toggles a shader compile, and a compile on the
 * frame a player mounts a bike is a hitch at the worst possible moment. One
 * permanent variant, paid the first time anybody looks at themselves, is the
 * cheaper end of that trade -- and a figure in a terrace's shadow lit as though
 * it were in full sun is what `CharacterActor`'s constructor calls the single
 * most obvious way to make a character look pasted on.
 */
export function setVisibleToCamera(object: { layers: Layers; receiveShadow?: boolean }, visible: boolean): void {
  if (visible) {
    object.layers.enable(0);
    object.receiveShadow = true;
  } else {
    object.layers.disable(0);
  }
}

// --- The demo dummy -----------------------------------------------------------

/** One step of the demo script: what to do, for how long, and how fast to travel. */
interface Segment {
  readonly label: string;
  readonly seconds: number;
  /** Metres per second along the dummy's own heading. */
  readonly speed?: number;
  /** Radians to turn over the segment. */
  readonly turn?: number;
  /** A reaction to fire once, at the start of the segment. */
  readonly action?: ReactionName;
  /** Launch a hop, using the controller's own jump arithmetic. */
  readonly hop?: boolean;
}

/** `controller.ts`'s JUMP_VELOCITY and GRAVITY. Duplicated rather than imported, because this is a
 *  *demonstration* of the jump clip and must not become a reason for anything to touch the controller. */
const HOP_VELOCITY = 7.1;
const HOP_GRAVITY = 22.5;
const HOP_SECONDS = (2 * HOP_VELOCITY) / HOP_GRAVITY;

/**
 * The script. Nine and a bit seconds, and it plays every clip in spec 8.1.
 *
 * It is a there-and-back rather than a loop or a circle, and that is a
 * deliberate choice about what is being verified: walking out and running back
 * over the same 3.5 m of footpath is the only arrangement where the *same*
 * ground is covered at two speeds, which is what makes a foot-slide obvious. A
 * circle hides it, and a one-way walk takes the dummy out of the spawn view
 * inside a minute.
 *
 * The reactions are fired at the far end so that the punch, which is the clip
 * this project exists to feed, plays side-on from the player's spawn: a punch
 * seen down its own axis is a hand getting bigger.
 */
const DEMO: readonly Segment[] = [
  { label: 'idle', seconds: 0.9 },
  { label: 'turn away', seconds: 0.5, turn: Math.PI },
  { label: 'walk out 3.5 m', seconds: 2.2, speed: 1.6 },
  { label: 'turn back', seconds: 0.5, turn: Math.PI },
  { label: 'punch', seconds: 0.55, action: 'punch' },
  { label: 'punch', seconds: 0.55, action: 'punch' },
  { label: 'flinch', seconds: 0.5, action: 'flinch' },
  { label: 'jump', seconds: HOP_SECONDS + 0.15, hop: true },
  { label: 'run back 3.5 m', seconds: 0.55, speed: 6.4 },
  { label: 'knockout', seconds: 1.7, action: 'knockout' },
  { label: 'idle', seconds: 0.8 },
];

const DEMO_SECONDS = DEMO.reduce((total, s) => total + s.seconds, 0);

/**
 * A character standing on the footpath, cycling every clip, for verification.
 *
 * This exists because an animation system with nothing playing it is a system
 * nobody has looked at. It also happens to be the object the punch project needs
 * next -- something at a known position, with a known pose, that can be hit --
 * so it is built as a real `CharacterActor` driven by a script rather than as a
 * debug widget.
 */
export class DemoDummy {
  readonly actor: CharacterActor;
  /** Where the loop starts and ends, in world metres. */
  readonly origin: Vector3;

  private clock = 0;
  private index = 0;
  private elapsed = 0;
  private hopClock = -1;
  private readonly at: { x: number; y: number; z: number };
  private yaw: number;
  private pinnedAction: ActionName | null = null;
  /**
   * Written out as a field rather than as a TypeScript parameter property, and
   * that is a portability constraint rather than a style one: Node's
   * `--experimental-strip-types` refuses a parameter property, and this file has
   * to stay runnable in Node for `verifyCharacterRig` to be checkable outside a
   * browser -- which is the same reason `sky/calibration.ts` is framework-free.
   */
  private readonly groundAt: (x: number, z: number) => number;

  constructor(
    assets: CharacterAssets,
    origin: Vector3,
    yaw: number,
    groundAt: (x: number, z: number) => number,
    colourway = 0,
  ) {
    this.groundAt = groundAt;
    this.actor = new CharacterActor(assets, colourway);
    this.origin = origin.clone();
    this.yaw = yaw;
    this.at = { x: origin.x, y: origin.y, z: origin.z };
    this.actor.mesh.name = 'character:dummy';
  }

  /** Seconds into the current loop, and which segment that is. Reported on the dev handle. */
  get state(): { loop: number; segment: string; total: number } {
    return { loop: this.clock, segment: this.pinnedAction ?? DEMO[this.index].label, total: DEMO_SECONDS };
  }

  /**
   * Hold one clip indefinitely, or `null` to resume the script.
   *
   * The whole point of the dev handle: a 100 ms punch-active window cannot be
   * looked at while it is cycling past, and a knockout that gets up after 1.7 s
   * cannot be inspected at all.
   */
  setAction(name: ActionName | null): void {
    this.pinnedAction = name;
    this.actor.setAction(name);
    if (name === null) {
      this.index = 0;
      this.elapsed = 0;
      this.clock = 0;
    }
  }

  update(dt: number): void {
    if (this.pinnedAction !== null) {
      // Pinned: hold position, let the actor run the clip. A pinned reaction is
      // re-fired when it finishes so a punch can be watched more than once.
      if (this.actor.action.reaction === null && this.pinnedAction !== 'idle') {
        this.actor.setAction(this.pinnedAction);
      }
      this.at.y = this.groundAt(this.at.x, this.at.z);
      this.actor.update(dt, { position: this.at, yaw: this.yaw, speed: 0, onGround: true });
      return;
    }

    this.clock = (this.clock + dt) % DEMO_SECONDS;
    this.elapsed += dt;
    let segment = DEMO[this.index];
    if (this.elapsed >= segment.seconds) {
      this.elapsed -= segment.seconds;
      this.index = (this.index + 1) % DEMO.length;
      segment = DEMO[this.index];
      if (segment.action) this.actor.setAction(segment.action);
      if (segment.hop) this.hopClock = 0;
    }

    if (segment.turn) this.yaw += (segment.turn / segment.seconds) * dt;
    if (segment.speed) {
      // Yaw 0 faces -Z, so a heading is (-sin, -cos) -- the identity
      // `controller.step` derives the player's forward vector from.
      this.at.x -= Math.sin(this.yaw) * segment.speed * dt;
      this.at.z -= Math.cos(this.yaw) * segment.speed * dt;
    }

    let hop = 0;
    let onGround = true;
    if (this.hopClock >= 0) {
      this.hopClock += dt;
      hop = HOP_VELOCITY * this.hopClock - 0.5 * HOP_GRAVITY * this.hopClock * this.hopClock;
      if (hop <= 0) {
        hop = 0;
        this.hopClock = -1;
      } else {
        onGround = false;
      }
    }

    this.at.y = this.groundAt(this.at.x, this.at.z) + hop;
    this.actor.update(dt, {
      position: this.at,
      yaw: this.yaw,
      speed: segment.speed ?? 0,
      onGround,
    });
  }
}

// --- The self-check -----------------------------------------------------------

/**
 * The rig, the mesh and every clip's effect on it, checked in Node.
 *
 * Everything here guards a failure that is silent in the sense this project uses
 * the word -- it renders, it does not throw, and it looks like a taste decision:
 *
 *   - **Winding.** The README's winding pass records that 61% of the city's
 *     walls were inside out for months while looking like a city. A closed limb
 *     tube has exactly that property, so every triangle is tested against its
 *     own stored normals, which is `sydney winding-audit`'s test applied to
 *     client geometry the audit cannot see.
 *   - **Weights.** Skin weights that do not sum to 1 shrink the mesh toward the
 *     origin, smoothly and slightly. Nothing errors.
 *   - **Extents under every clip.** A pose that puts a limb through the torso or
 *     the figure through the pavement is only visible from a specific angle,
 *     which is exactly the kind of thing that survives a look and fails in a
 *     screenshot a week later.
 *
 * Pure and framework-free apart from three itself, so it runs from Node:
 *
 *     node --experimental-strip-types --input-type=module \
 *       -e "import {verifyCharacterRig} from './src/player/character.ts';
 *           console.log(verifyCharacterRig())"
 */
export function verifyCharacterRig(): string[] {
  const failures: string[] = [];
  const assets = new CharacterAssets();

  // --- Budgets, from spec 8.1.
  if (assets.triangles > 2000) {
    failures.push(`The figure is ${assets.triangles} triangles; spec 8.1 budgets 2,000.`);
  }
  if (BONE_COUNT > 20) {
    failures.push(`The rig has ${BONE_COUNT} bones; spec 8.1 budgets 20.`);
  }

  const geometry = assets.geometries[0];
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const index = geometry.getIndex();
  if (index === null) {
    failures.push('The character geometry is not indexed.');
    return failures;
  }

  // --- Winding. A face's cross product must agree with the mean of the three
  // vertex normals it was built from.
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
    failures.push(
      `${disagreeing} of ${index.count / 3} triangles are wound against their own normals -- ` +
        `they will be back-face culled and the figure will be see-through from outside. ` +
        `This is the failure the README's winding pass documents on the city's walls.`,
    );
  }

  // --- Skin weights.
  let badWeight = 0;
  let badIndex = 0;
  for (let i = 0; i < position.count; i++) {
    const sum = skinWeight.getX(i) + skinWeight.getY(i) + skinWeight.getZ(i) + skinWeight.getW(i);
    if (Math.abs(sum - 1) > 1e-4) badWeight++;
    for (const v of [skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i)]) {
      if (!Number.isInteger(v) || v < 0 || v >= BONE_COUNT) badIndex++;
    }
  }
  if (badWeight > 0) failures.push(`${badWeight} vertices have skin weights that do not sum to 1.`);
  if (badIndex > 0) failures.push(`${badIndex} skin indices are outside 0..${BONE_COUNT - 1}.`);

  // --- The bind pose's proportions are the brief, so they are asserted.
  const bind = extents(position);
  const height = bind.max[1] - bind.min[1];
  if (Math.abs(height - FIGURE_HEIGHT) > 0.02) {
    failures.push(`The figure is ${height.toFixed(3)} m tall; it should be ${FIGURE_HEIGHT} m.`);
  }
  if (Math.abs(bind.min[1]) > 0.005) {
    failures.push(`The sole is at y = ${bind.min[1].toFixed(4)}; it must be at 0, because the mesh origin is what a ground height is applied to.`);
  }
  const headFraction = (HEAD_RADII[1] * 2) / height;
  if (headFraction < 0.26 || headFraction > 0.34) {
    failures.push(`The head is ${(headFraction * 100).toFixed(1)}% of the figure; spec 8.1's "big heads" is about 30%.`);
  }

  // --- Every clip, stepped, with the mesh actually deformed on the CPU.
  //
  // Uses three's own `applyBoneTransform`, which runs exactly the arithmetic the
  // vertex shader runs, so this is a test of the *shipped* skinning rather than
  // a reimplementation of it that could agree with itself while both are wrong.
  const actor = new CharacterActor(assets, 0);
  const at = { x: 0, y: 0, z: 0 };
  const skinned = new Vector3();
  // The sphere three will really cull against -- the mesh's, not the geometry's.
  const bounds = actor.mesh.boundingSphere;
  if (bounds === null) {
    failures.push('The actor has no bounding sphere on its mesh, so three will compute one from a single pose and cache it.');
  }

  const cases: Array<[ActionName, number, number]> = [
    ['idle', 1.2, 0],
    ['walk', 1.2, 4.4],
    ['run', 1.2, 8.2],
    ['jump', 0.4, 3.0],
    ['punch', PUNCH_TOTAL, 0],
    ['flinch', FLINCH_DURATION, 0],
    ['knockout', KNOCKOUT_DURATION + 0.2, 0],
    // At a bike's real speed, which is the case that matters: the stride phase
    // advances by distance, so a rider doing 26 m/s turns the cranks about
    // fifteen times over this second and every one of them is skinned below.
    ['ride', 1.0, 26.2],
  ];

  for (const [name, seconds, speed] of cases) {
    actor.setAction(null);
    actor.setAction(name);
    const before = actor.bones.map((bone) => bone.rotation.x + bone.rotation.y + bone.rotation.z);
    let moved = false;
    let worstLow = Infinity;
    let worstHigh = -Infinity;
    let outsideBounds = 0;

    const steps = Math.max(2, Math.round(seconds / (1 / 60)));
    for (let s = 0; s < steps; s++) {
      actor.update(1 / 60, { position: at, yaw: 0, speed, onGround: name !== 'jump' });
      actor.mesh.updateMatrixWorld(true);
      actor.mesh.skeleton.update();

      for (let i = 0; i < position.count; i++) {
        skinned.fromBufferAttribute(position, i);
        actor.mesh.applyBoneTransform(i, skinned);
        if (!Number.isFinite(skinned.x) || !Number.isFinite(skinned.y) || !Number.isFinite(skinned.z)) {
          failures.push(`Clip "${name}" produced a non-finite skinned vertex at index ${i}.`);
          s = steps;
          break;
        }
        const world = skinned.y + actor.mesh.position.y;
        worstLow = Math.min(worstLow, world);
        worstHigh = Math.max(worstHigh, world);
        if (bounds !== null && skinned.distanceTo(bounds.center) > bounds.radius) outsideBounds++;
      }
      if (actor.bones.some((bone, i) => Math.abs(bone.rotation.x + bone.rotation.y + bone.rotation.z - before[i]) > 1e-3)) {
        moved = true;
      }
    }

    if (!moved) {
      failures.push(`Clip "${name}" never moved a bone across ${steps} steps.`);
    }
    // A quarter of a metre under the pavement is the tolerance, and it is not
    // zero on purpose: a knockout genuinely puts a shoulder at ground level and
    // a fraction of a shoe through it, and demanding otherwise would mean
    // authoring a crumple that hovers.
    if (worstLow < -0.25) {
      failures.push(`Clip "${name}" put a vertex ${(-worstLow).toFixed(2)} m under the ground.`);
    }
    if (worstHigh > 2.35) {
      failures.push(`Clip "${name}" reached ${worstHigh.toFixed(2)} m, which is off the top of a 1.70 m figure.`);
    }
    if (outsideBounds > 0) {
      failures.push(
        `Clip "${name}" put ${outsideBounds} vertex-samples outside the inflated bounding sphere ` +
          `(radius ${bounds?.radius.toFixed(2)}), so the mesh will be frustum-culled while still on screen.`,
      );
    }
  }

  // The knockout has to actually end on the ground, which is the one thing that
  // makes it a crumple rather than a curtsey.
  actor.setAction(null);
  actor.setAction('knockout');
  for (let s = 0; s < 90; s++) actor.update(1 / 60, { position: at, yaw: 0, speed: 0, onGround: true });
  actor.mesh.updateMatrixWorld(true);
  actor.mesh.skeleton.update();
  let crown = -Infinity;
  for (let i = 0; i < position.count; i++) {
    skinned.fromBufferAttribute(position, i);
    actor.mesh.applyBoneTransform(i, skinned);
    crown = Math.max(crown, skinned.y + actor.mesh.position.y);
  }
  if (crown > 1.05) {
    failures.push(
      `A knocked-out character's highest point is ${crown.toFixed(2)} m. It is meant to be lying ` +
        `on the footpath; anything over about a metre is still standing up.`,
    );
  }

  // --- The third-person switch, both ways.
  //
  // What this catches has no picture on the frame anybody develops in: the
  // *first-person* view is correct either way, and the failure is only visible
  // once you press `V` or get on a bike. Specifically it asserts the two halves
  // of the arrangement `castShadowOnly` and `setVisibleToCamera` make between
  // them -- that showing the body keeps it in the sun's map (or third person
  // costs you your own shadow at the moment you can finally see it), and that
  // hiding it again really does take it off the view camera's layer rather than
  // leaving a body welded to the inside of your own eye.
  {
    const probe = new CharacterActor(assets, 0);
    const shadowCamera = { layers: { enable: () => {} } };
    castShadowOnly(probe.mesh, shadowCamera);
    if (probe.mesh.layers.isEnabled(0)) {
      failures.push('castShadowOnly left the body on layer 0, so the player sees the inside of their own head.');
    }
    setVisibleToCamera(probe.mesh, true);
    if (!probe.mesh.layers.isEnabled(0)) {
      failures.push('setVisibleToCamera(true) did not put the body on the view camera\'s layer; third person would draw nothing.');
    }
    if (!probe.mesh.layers.isEnabled(SELF_SHADOW_LAYER)) {
      failures.push(
        'setVisibleToCamera(true) dropped the shadow layer. Stepping into third person would take the ' +
          'player\'s own shadow off the footpath at the exact moment they could see it.',
      );
    }
    setVisibleToCamera(probe.mesh, false);
    if (probe.mesh.layers.isEnabled(0)) {
      failures.push('setVisibleToCamera(false) did not hide the body again; first person would draw it over the eye.');
    }
    if (!probe.mesh.layers.isEnabled(SELF_SHADOW_LAYER)) {
      failures.push('Going back to first person lost the shadow layer, so the player has no shadow at all.');
    }
    // And the round trip is exactly the state `castShadowOnly` left, so toggling
    // `V` a hundred times cannot drift.
    const after = probe.mesh.layers.mask;
    castShadowOnly(probe.mesh, shadowCamera);
    if (probe.mesh.layers.mask !== after) {
      failures.push(`A show/hide round trip left the layer mask at ${after}, not the ${probe.mesh.layers.mask} castShadowOnly sets.`);
    }
  }

  // --- And the ride pose ends up on the bike rather than beside it.
  //
  // `world/bike.ts` builds its saddle, bars and cranks to `animation`'s
  // `SADDLE_Y`/`BAR_*`/`PEDAL_*`, so this is the assertion that keeps the two
  // files honest: the rig is fixed, and if the *skinned* hips, mitts and soles
  // are not where those constants say they are, the mesh is drawn to numbers the
  // rider does not actually reach. The symptom is a figure pedalling 10 cm above
  // a saddle with its hands in the air, which reads as a rigging bug and is
  // really a disagreement between two files.
  actor.setAction(null);
  actor.setAction('ride');
  for (let s = 0; s < 60; s++) actor.update(1 / 60, { position: at, yaw: 0, speed: 0, onGround: true });
  actor.mesh.updateMatrixWorld(true);
  actor.mesh.skeleton.update();
  const jointAt = (bone: number, out: Vector3): Vector3 => out.setFromMatrixPosition(actor.bones[bone].matrixWorld);
  const joint = new Vector3();

  jointAt(BONE.HIPS, joint);
  if (Math.abs(joint.y - SADDLE_Y) > 0.1) {
    failures.push(
      `A rider's hips sit at ${joint.y.toFixed(2)} m against a saddle at ${SADDLE_Y} m. ` +
        `world/bike.ts draws the saddle to that constant, so this is the figure floating over it.`,
    );
  }
  for (const [label, wrist] of [['left', BONE.WRIST_L], ['right', BONE.WRIST_R]] as Array<[string, number]>) {
    jointAt(wrist, joint);
    const reach = Math.hypot(joint.y - BAR_Y, joint.z - BAR_Z);
    if (reach > 0.22) {
      failures.push(
        `The ${label} mitt is ${reach.toFixed(2)} m from the handlebar at (y ${BAR_Y}, z ${BAR_Z}); ` +
          `it is at (y ${joint.y.toFixed(2)}, z ${joint.z.toFixed(2)}). The hands are not on the bars.`,
      );
    }
  }
  for (const [label, ankle] of [['left', BONE.ANKLE_L], ['right', BONE.ANKLE_R]] as Array<[string, number]>) {
    jointAt(ankle, joint);
    // Generous on z, because the crank is a circle and this samples one phase of
    // it; the height is what says the foot is on a pedal rather than on the road.
    if (Math.abs(joint.y - PEDAL_Y) > 0.28) {
      failures.push(
        `The ${label} foot is at y ${joint.y.toFixed(2)} against cranks at ${PEDAL_Y} m -- ` +
          `a rider with a leg through the bottom bracket or dangling under it.`,
      );
    }
  }
  // Both knees still fold the right way once skinned, which the pose's cosine
  // term is the one thing here capable of breaking at a phase the clip check
  // above did not sample.
  for (const [label, knee] of [['left', BONE.KNEE_L], ['right', BONE.KNEE_R]] as Array<[string, number]>) {
    if (actor.bones[knee].rotation.x > 1e-3) {
      failures.push(`A riding character's ${label} knee bent forward by ${actor.bones[knee].rotation.x.toFixed(3)} rad.`);
    }
  }

  return failures;
}

function extents(position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.count; i++) {
    const p: [number, number, number] = [position.getX(i), position.getY(i), position.getZ(i)];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}
