/**
 * What a meth head and a drunk look like: two kits, four props, and the pool of
 * rigs that draws both tiers of both factions.
 *
 * The **rendering** half of `game/streetlife.ts`, on `world/police.ts`'s split
 * exactly: that file decides where these people are and is compiled into the Bun
 * server, and this one draws them and imports three.
 *
 * ---------------------------------------------------------------------------
 * THE FIGURE IS THE FIGURE. Nothing here is a second mesh.
 *
 * `world/police.ts` states the case at length and it is not restated: a second
 * body would be a second thing to re-weight the day a bone moves, and it could
 * not go through the pooled-rig geometry swap `PedestrianCrowd` runs. So both
 * factions are the same 1.70 m figure everybody else is, and the whole of the
 * look is a colourway, a **narrowed copy of the position buffer**, and props
 * parented to bones.
 *
 * The narrowing is the one new technique and it is worth the paragraph.
 *
 * The user asked for meth heads who are *shirtless* and *skinny*. Shirtless is
 * free: `character.ROLE` splits the figure into skin, singlet, shorts, shoe and
 * eye, and a colourway whose `singlet` is its own `skin` is a bare torso with no
 * geometry change at all -- the vertices were always there and were always
 * asking a colourway what colour to be.
 *
 * Skinny is not free, because it is a *shape*. The obvious implementation is to
 * scale the bones, and it is the wrong one for a reason `player/bat.ts` already
 * documents: a bone's scale is inherited by everything parented to it, so a
 * 0.76 scale on the chest is a 0.76 scale on the vest, on the beanie and on the
 * bottle in the hand -- and worse, a non-uniform scale on a bone **shears
 * whatever hangs off it** the moment the bone rotates. What is done instead is
 * one copy of the position attribute with every vertex pulled toward **its own
 * dominant bone's axis**, so the torso narrows about the spine, the arms narrow
 * about the arm and the hands stay in the hands. The bones do not move, so no
 * prop moves, and the skinning is unchanged: it is the bind pose that is
 * different, which is exactly what "a skinny person" means.
 *
 * Scaling the positions leaves the `normal` attribute pointing the way it did,
 * and that is deliberate rather than overlooked. `CharacterAssets.material` is
 * `flatShading`, and three derives a flat normal from the screen-space
 * derivative of the **post-skinning view position** -- see the note in
 * `character.ts` -- so the attribute is not what shades this mesh. Recomputing
 * it would be arithmetic nobody reads.
 *
 * ---------------------------------------------------------------------------
 * THE PROPS, and what each one is for at distance.
 *
 * `world/police.ts`'s criterion: a prop earns its triangles by what it does at
 * 40 m, not by what it does at 3.
 *
 *   - the **purple beanie** and the **white cap** are the meth head's
 *     silhouette, and they are two so that a group of them reads as *people*
 *     rather than as a squad. Which one an individual wears is a hash bit, and
 *     the hash is the anchor's rather than the actor's -- see `Slot.look` for
 *     the small dance that keeps somebody in the same hat when they stop
 *     loitering and start running at you.
 *   - the **high-vis vest** is the drunk's, and it is the only fluoro object in
 *     the build. That is the point: a hi-vis vest is the single most legible
 *     garment in an Australian street at any distance and in any light, which is
 *     why the country's tradesmen and the country's drunks both wear one.
 *   - the **stubbie** is the characterful one. A brown longneck in the right
 *     hand, and every so often the arm comes up and the bottle tips. It is
 *     twenty-eight triangles and it is the thing that makes a swaying figure
 *     read as a person having a drink rather than as a broken walk cycle.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import { BONE, RIG } from '../player/animation.ts';
import {
  CharacterActor,
  SELF_SHADOW_LAYER,
  type CharacterAssets,
  type Colourway,
} from '../player/character.ts';
import { NPC_KIND, NPC_STATE, type NpcActor } from '../game/factions.ts';
import {
  DRUNK_CHASE_SPEED,
  DRUNK_MIN_GAP,
  METH_CHASE_SPEED,
  createStreetPose,
  forEachDrunkNear,
  forEachMethheadNear,
  isStreetKind,
  swigPhase,
  type StreetPose,
} from '../game/streetlife.ts';
import { type PedBand, type PedestrianField } from '../game/pedestrians.ts';
import { carHash, trafficSeconds } from '../game/traffic.ts';

// --- The kits ------------------------------------------------------------------------

/**
 * Three meth head kits, and every one of them is shirtless.
 *
 * `singlet` equal to `skin` is the whole trick: `character.roleColour` hands the
 * singlet vertices the singlet colour, and a colourway that answers with its own
 * skin tone has a bare torso. Three of them rather than one because there is one
 * police uniform and there is not one kind of person -- the skin tones are the
 * spread `COLOURWAYS` already uses, and the shorts are the three colours a pair
 * of trackies is actually seen in.
 *
 * Linear, like every colour in this project.
 */
export const METH_KITS: readonly Colourway[] = [
  { name: 'meth/pale', singlet: [0.52, 0.36, 0.29], shorts: [0.055, 0.055, 0.062], skin: [0.52, 0.36, 0.29], shoe: [0.06, 0.055, 0.05] },
  { name: 'meth/tan', singlet: [0.34, 0.23, 0.17], shorts: [0.09, 0.1, 0.115], skin: [0.34, 0.23, 0.17], shoe: [0.13, 0.12, 0.11] },
  { name: 'meth/dark', singlet: [0.19, 0.12, 0.08], shorts: [0.13, 0.115, 0.09], skin: [0.19, 0.12, 0.08], shoe: [0.05, 0.05, 0.055] },
];

/**
 * Three drunk kits: a shirt, work trousers, and boots.
 *
 * Dressed, unlike the meth heads, and dressed *dully* -- the vest over the top
 * is doing all of the work, and a bright singlet under a fluoro vest would fight
 * it. The shirts are the blue, the grey and the faded maroon that a man drinking
 * a longneck outside a pub at four in the afternoon is wearing.
 */
export const DRUNK_KITS: readonly Colourway[] = [
  { name: 'drunk/blue', singlet: [0.055, 0.09, 0.19], shorts: [0.075, 0.07, 0.062], skin: [0.42, 0.27, 0.2], shoe: [0.04, 0.035, 0.032] },
  { name: 'drunk/grey', singlet: [0.13, 0.135, 0.14], shorts: [0.05, 0.055, 0.075], skin: [0.3, 0.19, 0.13], shoe: [0.045, 0.04, 0.035] },
  { name: 'drunk/maroon', singlet: [0.19, 0.06, 0.06], shorts: [0.085, 0.08, 0.07], skin: [0.24, 0.15, 0.1], shoe: [0.04, 0.04, 0.042] },
];

/**
 * How far in a meth head's flesh is pulled toward its own bones.
 *
 * 0.76 is the smallest number that still reads as a person rather than as a
 * stick: at 0.7 the head -- which is *not* scaled, because a beanie has to fit
 * it -- starts to look detached, and at 0.85 nobody can tell. Applied to x and z
 * only; a skinny person is not a short one.
 */
const SKINNY = 0.76;

/**
 * Every bone's position in the bind pose, accumulated down `RIG`.
 *
 * The narrowing needs to know where a vertex's own limb axis *is*, and that is
 * the bone's rest position composed through its parents. `RIG` is declared with
 * every bone at identity rotation, so the composition is three adds.
 */
function bindPositions(): Float64Array {
  const out = new Float64Array(RIG.length * 3);
  for (let i = 0; i < RIG.length; i++) {
    const spec = RIG[i];
    const px = spec.parent >= 0 ? out[spec.parent * 3] : 0;
    const py = spec.parent >= 0 ? out[spec.parent * 3 + 1] : 0;
    const pz = spec.parent >= 0 ? out[spec.parent * 3 + 2] : 0;
    out[i * 3] = px + spec.rest[0];
    out[i * 3 + 1] = py + spec.rest[1];
    out[i * 3 + 2] = pz + spec.rest[2];
  }
  return out;
}

/**
 * A kit geometry with the flesh pulled in toward the bones.
 *
 * Shares **everything except position and colour** with the figure every other
 * character in the city is drawn from: the normals, the skin bindings and the
 * index are the same `BufferAttribute` objects, so the cost of a skinny variant
 * is one Float32Array of positions and nothing else. The caller owns the result
 * and may dispose it; it must never dispose what it shares.
 *
 * The head is left alone, and that is the assertion `verifyStreetlifeKit` makes
 * about this function rather than a detail: `world/police.ts` sizes a cap
 * against `HEAD_RADII`, this file sizes a beanie the same way, and a skull
 * narrowed to 76% would wear both of them like a hoop.
 */
function skinnyGeometry(base: BufferGeometry, name: string): BufferGeometry {
  const position = base.getAttribute('position');
  const skinIndex = base.getAttribute('skinIndex');
  const skinWeight = base.getAttribute('skinWeight');
  const colour = base.getAttribute('color');
  const bones = bindPositions();

  const out = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // The dominant influence: `character.ts` binds at most two bones per vertex
    // and the joints are the only place both are non-zero, so the heavier of the
    // first two is the limb this vertex belongs to.
    const b0 = skinIndex.getX(i);
    const b1 = skinIndex.getY(i);
    const w0 = skinWeight.getX(i);
    const w1 = skinWeight.getY(i);
    const bone = w0 >= w1 ? b0 : b1;
    // The head **and the neck** are left alone, and the neck is not an
    // afterthought: `character.buildFigure` runs its tube up to y = 1.27, which
    // is inside the skull, and both hats are sized against `HEAD_RADII` at that
    // height. Narrowing the neck under an unnarrowed head opens a step at the
    // jaw that reads as the head being a separate object -- and it is the
    // failure `verifyStreetlifeKit` actually caught, on the eight vertices of
    // the neck's top ring.
    if (bone === BONE.HEAD || bone === BONE.NECK) {
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
      continue;
    }
    const ax = bones[bone * 3];
    const az = bones[bone * 3 + 2];
    out[i * 3] = ax + (x - ax) * SKINNY;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = az + (z - az) * SKINNY;
  }

  const g = new BufferGeometry();
  g.name = name;
  g.setAttribute('position', new BufferAttribute(out, 3));
  g.setAttribute('normal', base.getAttribute('normal'));
  g.setAttribute('skinIndex', skinIndex);
  g.setAttribute('skinWeight', skinWeight);
  g.setAttribute('color', colour);
  g.setIndex(base.getIndex());
  // The shared inflated sphere, cloned. `SkinnedMesh` writes to
  // `boundingSphere` on the first frame it is culled -- see `CharacterAssets` --
  // so two geometries must never hold one `Sphere`. Narrowing only shrinks the
  // figure, so the sphere still covers every clip.
  g.boundingSphere = base.boundingSphere ? base.boundingSphere.clone() : null;
  return g;
}

// --- Prop geometry ---------------------------------------------------------------------

/** Triangle accumulator. `world/police.Parts`, restated for the reason that file states. */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  /**
   * One flat quad, wound `a -> b -> c -> d`.
   *
   * The winding is what `verifyStreetlifeKit` checks, because a quad wound the
   * other way is invisible from the side you are looking at and solid from the
   * side you are not -- a beanie you can see the inside of the skull through,
   * which reads as a z-fighting artefact rather than as a backwards triangle.
   */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: readonly [number, number, number],
  ): void {
    const base = this.position.length / 3;
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

  /**
   * A closed band of quads between two rings, wound outward.
   *
   * The ring runs anticlockwise in (x, z) as the angle increases, so
   * bottom-near -> bottom-far -> top-far -> top-near points the face normal
   * away from the axis. Every ring in this file goes through here so that
   * exactly one piece of code decides which way round is out.
   */
  band(
    y0: number, r0: number,
    y1: number, r1: number,
    sides: number,
    colour: readonly [number, number, number],
  ): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const s0 = Math.sin(a0);
      const c0 = Math.cos(a0);
      const s1 = Math.sin(a1);
      const c1 = Math.cos(a1);
      this.quad(
        [s0 * r0, y0, c0 * r0],
        [s1 * r0, y0, c1 * r0],
        [s1 * r1, y1, c1 * r1],
        [s0 * r1, y1, c0 * r1],
        colour,
      );
    }
  }

  /** A cap on a ring, as a fan of degenerate quads. `up` faces +Y. */
  lid(y: number, r: number, sides: number, up: boolean, colour: readonly [number, number, number]): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const p0: [number, number, number] = [Math.sin(a0) * r, y, Math.cos(a0) * r];
      const p1: [number, number, number] = [Math.sin(a1) * r, y, Math.cos(a1) * r];
      const c: [number, number, number] = [0, y, 0];
      if (up) this.quad(c, p0, p1, c, colour);
      else this.quad(c, p1, p0, c, colour);
    }
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

/** Facets around a hat, a vest or a bottle. Ten reads round at 3 m; see `world/police.RING_SIDES`. */
const SIDES = 10;

/**
 * The hats, in the **head bone's** frame -- which is not where a head is.
 *
 * `world/police.ts` paid for this paragraph and it is inherited whole:
 * `animation.RIG` puts the head joint at 1.25 m and `character.HEAD_CENTRE`
 * puts the skull's centre at 1.445 with a vertical radius of 0.25, so in the
 * bone's own frame the head runs from -0.055 to +0.445 and its widest point is
 * at +0.195. A hat placed at a plausible-sounding 0.2 is dead centre inside the
 * skull and invisible from every angle.
 *
 * A **beanie sits lower than a cap**, which is the one thing that makes them
 * read as different hats rather than as one hat in two colours: the brim is
 * rolled down over the ears at 0.235 -- just above the equator, so it is still
 * outside the skull -- and the crown follows the skull up to 0.435. The radii
 * below are each a shade proud of the head's own half-width at that height,
 * which is what makes a hat look *worn* rather than painted on.
 */
const BEANIE_RINGS: readonly (readonly [number, number])[] = [
  [0.235, 0.192], [0.29, 0.19], [0.345, 0.163], [0.395, 0.122], [0.435, 0.05],
];

const CAP_RADIUS = 0.175;
const CAP_HEIGHT = 0.105;
const CAP_Y = 0.3;
const PEAK_REACH = 0.15;

/** Purple, because the user said purple. Linear; display rgb(120, 62, 168) in sun. */
const BEANIE_PURPLE: readonly [number, number, number] = [0.17, 0.045, 0.36];
const BEANIE_BRIM: readonly [number, number, number] = [0.13, 0.032, 0.28];
/** And the cap: white cloth with a slightly grey peak, so the two planes separate. */
const CAP_WHITE: readonly [number, number, number] = [0.8, 0.8, 0.79];
const CAP_PEAK: readonly [number, number, number] = [0.62, 0.62, 0.63];

/**
 * The vest, in the **chest bone's** frame, which sits at y = 1.13 in the figure.
 *
 * The torso it goes over is two tubes running 0.755 -> 1.155 with radii 0.155 ->
 * 0.175 (see `character.buildFigure`), so in this frame it runs -0.375 to +0.025
 * and the vest is that profile plus 13 mm. Thirteen millimetres is the whole
 * design: any less and it z-fights the singlet, any more and it stands off the
 * body like a barrel.
 *
 * The silver band across the chest is what a hi-vis vest actually *is* at
 * distance -- the fluoro is the colour and the retroreflective tape is the
 * pattern, and a vest without it reads as a yellow shirt.
 */
const VEST_LOW = -0.30;
const VEST_HIGH = 0.03;
const VEST_STAND_OFF = 0.013;
const FLUORO_YELLOW: readonly [number, number, number] = [0.72, 0.85, 0.05];
const FLUORO_ORANGE: readonly [number, number, number] = [0.9, 0.32, 0.02];
const VEST_SILVER: readonly [number, number, number] = [0.55, 0.57, 0.58];

/** The torso's own radius at a height in the chest bone's frame. `buildFigure`'s profile. */
function torsoRadius(yLocal: number): number {
  const y = yLocal + 1.13;
  if (y <= 0.99) {
    const f = Math.max(0, (y - 0.755) / (0.99 - 0.755));
    return 0.155 + (0.163 - 0.155) * f;
  }
  const f = Math.min(1, (y - 0.99) / (1.155 - 0.99));
  return 0.163 + (0.175 - 0.163) * f;
}

/**
 * The stubbie, in the **right wrist's** frame.
 *
 * A 750 ml longneck: 0.29 m tall, 38 mm across the body and 14 mm at the neck,
 * which is the real bottle to within a couple of millimetres and matters only
 * because the silhouette of a longneck is a specific and recognisable thing --
 * a stubby brown cylinder is a can.
 *
 * Held rather than carried. `character.MITT_RADII` puts the mitt about 40 mm
 * below the wrist joint, so the bottle's body straddles that: the base is at
 * -0.14 and the mouth at +0.15, which is a hand wrapped around the lower third
 * of the bottle. In the bind pose the arm hangs, so a bottle along the wrist's
 * +Y stands upright in the hand, which is where a longneck lives when nobody is
 * drinking it.
 */
const BOTTLE_BASE = -0.14;
const BOTTLE_SHOULDER = 0.045;
const BOTTLE_NECK = 0.105;
const BOTTLE_MOUTH = 0.15;
const BOTTLE_BODY_R = 0.038;
const BOTTLE_NECK_R = 0.014;
/** Brown glass. Dark and warm; a longneck in the sun is nearly black at the shoulder. */
const GLASS_BROWN: readonly [number, number, number] = [0.075, 0.028, 0.008];
const GLASS_LABEL: readonly [number, number, number] = [0.42, 0.35, 0.16];

/**
 * Every piece of geometry both factions share, built once for the city.
 *
 * `CharacterAssets`' contract, with the same consequence for teardown: a crowd
 * must never dispose these, because every other street person is drawing them.
 */
export class StreetlifeAssets {
  /** Kit geometries. Meth heads are the narrowed figure; drunks are the figure. */
  readonly methKits: readonly BufferGeometry[];
  readonly drunkKits: readonly BufferGeometry[];
  readonly beanie: BufferGeometry;
  readonly cap: BufferGeometry;
  /** Two vests, so the fluoro can be yellow or orange without a second material. */
  readonly vests: readonly BufferGeometry[];
  readonly bottle: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;

  constructor(characters: CharacterAssets) {
    this.methKits = METH_KITS.map((kit) => {
      const base = characters.kitGeometry(kit);
      const skinny = skinnyGeometry(base, `character:${kit.name}`);
      // The un-narrowed intermediate is not kept: it shares every buffer with
      // the figure and holds one colour array, and the narrowed copy took a
      // reference to that same colour array. Disposing it would free buffers
      // the whole city draws from -- see `CharacterAssets.kitGeometry`'s
      // contract -- so it is simply dropped.
      return skinny;
    });
    this.drunkKits = DRUNK_KITS.map((kit) => characters.kitGeometry(kit));

    // --- The beanie: a stack of bands up the skull, closed at the crown, with
    // the brim rolled down over the ears.
    const beanie = new Parts();
    for (let i = 0; i < BEANIE_RINGS.length - 1; i++) {
      const [y0, r0] = BEANIE_RINGS[i];
      const [y1, r1] = BEANIE_RINGS[i + 1];
      beanie.band(y0, r0, y1, r1, SIDES, BEANIE_PURPLE);
    }
    const crown = BEANIE_RINGS[BEANIE_RINGS.length - 1];
    beanie.lid(crown[0], crown[1], SIDES, true, BEANIE_PURPLE);
    // The rolled brim: a short, slightly fatter band at the bottom, in a darker
    // purple so the fold catches an edge at any distance the hat is visible at.
    beanie.band(0.235, 0.198, 0.272, 0.198, SIDES, BEANIE_BRIM);
    beanie.lid(0.235, 0.198, SIDES, false, BEANIE_BRIM);
    this.beanie = beanie.build('meth-beanie');

    // --- The cap: a tapered crown, a flat top, and a peak over -Z, which is the
    // direction the figure faces.
    const cap = new Parts();
    cap.band(CAP_Y, CAP_RADIUS, CAP_Y + CAP_HEIGHT, CAP_RADIUS * 0.86, SIDES, CAP_WHITE);
    cap.lid(CAP_Y + CAP_HEIGHT, CAP_RADIUS * 0.86, SIDES, true, CAP_WHITE);
    {
      const y = CAP_Y + 0.004;
      const hw = CAP_RADIUS * 0.8;
      const tw = CAP_RADIUS * 0.52;
      const near = -CAP_RADIUS * 0.55;
      const far = near - PEAK_REACH;
      // Drawn on both sides: a single sheet, and it is seen from below by
      // anybody the wearer is standing over.
      cap.quad([-hw, y, near], [hw, y, near], [tw, y, far], [-tw, y, far], CAP_PEAK);
      cap.quad([-tw, y - 0.008, far], [tw, y - 0.008, far], [hw, y - 0.008, near], [-hw, y - 0.008, near], CAP_PEAK);
    }
    this.cap = cap.build('meth-cap');

    // --- The vests. Four bands: fluoro, silver, fluoro, and a shoulder yoke.
    const vests: BufferGeometry[] = [];
    for (const [name, fluoro] of [['yellow', FLUORO_YELLOW], ['orange', FLUORO_ORANGE]] as Array<
      [string, readonly [number, number, number]]
    >) {
      const v = new Parts();
      const r = (y: number): number => torsoRadius(y) + VEST_STAND_OFF;
      const tapeLow = -0.13;
      const tapeHigh = -0.085;
      v.band(VEST_LOW, r(VEST_LOW), tapeLow, r(tapeLow), SIDES, fluoro);
      v.band(tapeLow, r(tapeLow), tapeHigh, r(tapeHigh), SIDES, VEST_SILVER);
      v.band(tapeHigh, r(tapeHigh), VEST_HIGH, r(VEST_HIGH), SIDES, fluoro);
      // The hem, closed downward, so the vest is not a tube you can see up.
      v.lid(VEST_LOW, r(VEST_LOW), SIDES, false, fluoro);
      vests.push(v.build(`drunk-vest-${name}`));
    }
    this.vests = vests;

    // --- The stubbie: body, shoulder, neck, and a label band around the middle.
    const bottle = new Parts();
    bottle.band(BOTTLE_BASE, BOTTLE_BODY_R, -0.05, BOTTLE_BODY_R, SIDES, GLASS_BROWN);
    bottle.band(-0.05, BOTTLE_BODY_R, -0.005, BOTTLE_BODY_R, SIDES, GLASS_LABEL);
    bottle.band(-0.005, BOTTLE_BODY_R, BOTTLE_SHOULDER, BOTTLE_BODY_R, SIDES, GLASS_BROWN);
    bottle.band(BOTTLE_SHOULDER, BOTTLE_BODY_R, BOTTLE_NECK, BOTTLE_NECK_R, SIDES, GLASS_BROWN);
    bottle.band(BOTTLE_NECK, BOTTLE_NECK_R, BOTTLE_MOUTH, BOTTLE_NECK_R, SIDES, GLASS_BROWN);
    bottle.lid(BOTTLE_MOUTH, BOTTLE_NECK_R, SIDES, true, GLASS_BROWN);
    bottle.lid(BOTTLE_BASE, BOTTLE_BODY_R, SIDES, false, GLASS_BROWN);
    this.bottle = bottle.build('drunk-stubbie');

    this.triangles = beanie.triangles + cap.triangles + bottle.triangles;

    // Lit, like the police kit and unlike a tracer. The fluoro is *bright albedo
    // and nothing else*: a hi-vis vest is not emissive -- it is a very high
    // diffuse reflectance plus retroreflective tape -- and making it glow would
    // make a drunk visible through a shadow they are standing in, which is the
    // one thing a lit build must not do.
    const material = new MeshStandardNodeMaterial();
    material.name = 'streetlife';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.62;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }

  /** Release what this object owns. Never the buffers it shares with the figure. */
  dispose(): void {
    for (const g of [...this.methKits, ...this.drunkKits, this.beanie, this.cap, ...this.vests, this.bottle]) {
      g.dispose();
    }
    this.material.dispose();
  }
}

// --- One person's props ------------------------------------------------------------------

/**
 * The four props a pooled rig carries, all of them at once.
 *
 * A rig is reassigned between a meth head and a drunk as people come and go, so
 * it holds every prop and toggles visibility rather than building and tearing
 * down meshes -- `PoliceProps`' arrangement, with one more reason: a `Mesh`
 * added to a `Bone` is a scene-graph edit, and doing four of them on the frame
 * somebody walks past a pub is the one allocation this pool exists to avoid.
 *
 * Parented to bones rather than positioned from a bone's world matrix, which
 * saves a matrix decompose per person per frame because three composes the
 * skeleton for the skinning anyway. Frustum culling is off for `BatProp`'s
 * reason: a 0.3 m object on a figure that is already frustum-tested has nothing
 * to gain from a test of its own.
 */
class StreetProps {
  readonly beanie: Mesh;
  readonly cap: Mesh;
  readonly vest: Mesh;
  readonly bottle: Mesh;

  constructor(assets: StreetlifeAssets, actor: CharacterActor) {
    this.beanie = new Mesh(assets.beanie, assets.material);
    this.beanie.name = 'meth-beanie';
    this.cap = new Mesh(assets.cap, assets.material);
    this.cap.name = 'meth-cap';
    this.vest = new Mesh(assets.vests[0], assets.material);
    this.vest.name = 'drunk-vest';
    this.bottle = new Mesh(assets.bottle, assets.material);
    this.bottle.name = 'drunk-stubbie';
    for (const mesh of [this.beanie, this.cap, this.vest, this.bottle]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = false;
    }
    actor.bones[BONE.HEAD].add(this.beanie);
    actor.bones[BONE.HEAD].add(this.cap);
    actor.bones[BONE.CHEST].add(this.vest);
    actor.bones[BONE.WRIST_R].add(this.bottle);
  }

  hideAll(): void {
    this.beanie.visible = false;
    this.cap.visible = false;
    this.vest.visible = false;
    this.bottle.visible = false;
  }

  /** Seen by the sun and not by the eye. `BatProp.castShadowOnly`: three does not inherit layers. */
  castShadowOnly(): void {
    for (const mesh of [this.beanie, this.cap, this.vest, this.bottle]) {
      mesh.layers.set(SELF_SHADOW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    }
  }

  dispose(): void {
    for (const mesh of [this.beanie, this.cap, this.vest, this.bottle]) mesh.removeFromParent();
  }
}

// --- The crowd -----------------------------------------------------------------------------

/**
 * Rigs held for street people. A **frame** budget, not the wire's.
 *
 * Fourteen, against `PoliceSquad`'s sixteen and `PedestrianCrowd`'s fourteen for
 * nineteen thousand walkers. It is scaled against what is actually in view: a
 * pub strip in the Cross puts six or seven drunks inside 80 m, and a meth head
 * pursuit at `streetlife.MAX_STREET_ACTORS` is ten -- but those ten arrive
 * spread over the blocks you ran down, and the number in the draw radius at once
 * is a fraction of it.
 */
export const STREET_CAPACITY = 14;

/** How far street people are drawn, metres. Inside the crowd's own impostor radius. */
export const STREET_DRAW_RADIUS = 150;

/** What the crowd was asked to draw this frame. Structure of arrays; allocates nothing. */
const VISIBLE = 72;

/**
 * How close a promoted actor has to be to an ambient anchor to claim it.
 *
 * The one piece of bookkeeping in this file, and it exists because **the wire
 * does not carry an actor's home**. `protocol.NPC_BYTES` is eighteen bytes of
 * id, kind, position, yaw and state, and every omission in it is deliberate --
 * so a connected client cannot ask a running meth head which laneway it came out
 * of, and therefore cannot know which ambient loiterer to stop drawing.
 *
 * What it can do is notice that a promoted actor is standing on top of one. At
 * the instant of promotion that is exact: the authority promotes an ambient at
 * its own position, so the actor and the loiterer are the same point. Thirty
 * metres of tolerance keeps the claim through the first seconds of a chase, and
 * past that the loiterer comes back -- which is a second meth head appearing at
 * the anchor while the first one chases you down the street, and is both
 * accepted and, at a hundred metres with a bat in your hands, invisible.
 *
 * The claim carries the **look** across too, which is what stops somebody's hat
 * changing colour on the frame they start running: the first time an actor id is
 * seen, it inherits the hash of whatever ambient it claimed, and keeps it.
 */
const CLAIM_RADIUS = 30;
const CLAIM_RADIUS_2 = CLAIM_RADIUS * CLAIM_RADIUS;

/**
 * How close an actor has to be to an ambient to claim it **on the frame it
 * first appears**, metres -- and the fix for "the drunks teleport when I get
 * close to them".
 *
 * The claim used to be recomputed every frame as "the nearest ambient of this
 * kind inside `CLAIM_RADIUS`", and that was correct for exactly as long as a
 * venue's drunks were nowhere near each other. They were: before the frontage
 * fix the median drunk stood 58 m from their own pub and a pub's two or three
 * were scattered across the suburb, so the nearest candidate was always the
 * right one by a mile. Putting them back on the frontage put two and three
 * ambients inside one 30 m disc for the first time, and the per-frame search
 * started picking the wrong one -- measured over a walk-up to all 153
 * multi-drunk pubs in the city: **5,539 mis-claims in 46,867 actor-frames**,
 * 801 frames where an actor was drawn *and* its own ambient was still standing
 * there, and 34 frames where the ambient an actor was hiding changed between
 * one frame and the next.
 *
 * That last number is the bug the player saw. The actor is drawn at its own
 * position throughout -- the promotion seeds it exactly on the ambient, and the
 * displacement is 0.000 m over 198 promotions -- but the *ambient it hides*
 * flips, so a drunk winks out of one spot on the footpath and a different one
 * appears a few metres away. Approach range, every time, because that is where
 * the second candidate enters the disc.
 *
 * So the claim is made **once** and then held by key. `CLAIM_SNAP` is the
 * radius of that first claim, and it is small on purpose: an actor is standing
 * exactly on its ambient at the instant of promotion, and the nearest other
 * drunk of the same venue is 3.6 m away at the 5th percentile. Anything an
 * actor is not literally standing on is not the ambient it *is*.
 *
 * `CLAIM_RADIUS` keeps its old job: how far the actor may drag the claim before
 * the loiterer is released and comes back, which is the documented behaviour a
 * hundred metres into a chase.
 */
const CLAIM_SNAP = DRUNK_MIN_GAP / 2;
const CLAIM_SNAP_2 = CLAIM_SNAP * CLAIM_SNAP;

/** One pooled rig and whoever it currently stands in for. */
interface Slot {
  actor: CharacterActor;
  props: StreetProps;
  /**
   * Whether this rig is standing in for anybody, and it is a **flag rather than
   * a sentinel value in `key`** for a reason that cost the faction its promoted
   * half.
   *
   * `key` was doing both jobs: the person's identity, with "-1 means free". But
   * an ambient's key is `streetKey`, a large positive, and a *promoted* actor's
   * is `-a.id` -- negative, and `-1` for the actor that happens to hold id 1. So
   * `key < 0` read "free slot" for every promoted meth head and drunk in the
   * city, and all three places that asked did the wrong thing with the answer:
   * `assign`'s first pass never re-validated them, its second pass handed their
   * rig to somebody else, and `drive` hid them outright.
   *
   * The effect was that **a street person was invisible for exactly as long as
   * they were promoted** -- which is to say from `DRUNK_NOTICE` inward, the
   * moment you walked up to one. They did not teleport so much as wink out at
   * seven metres while the ambient they had been mis-paired with stayed
   * standing somewhere else, and that pair of symptoms is the bug report.
   */
  held: boolean;
  /** The person's stable key: `streetKey` for an ambient, `-id` for an actor. */
  key: number;
  /** Which kit geometry the rig is currently wearing, so it is only swapped on a change. */
  kit: BufferGeometry | null;
  down: boolean;
}

/**
 * Every meth head and drunk in view, ambient and promoted, as pooled rigs.
 *
 * `update` allocates nothing after the first frame. Not parented to a tile, on
 * `PoliceSquad`'s argument: these people cross a tile boundary while they are
 * chasing you and the crowd is drawn as one set for the whole visible world.
 */
export class StreetCrowd {
  /** Add these to the scene. One per pooled rig. */
  readonly rigs: CharacterActor[] = [];

  /** Diagnostics for the HUD. */
  ambient = 0;
  actors = 0;
  costMs = 0;

  private readonly assets: StreetlifeAssets;
  private readonly slots: Slot[] = [];
  private readonly bands: PedBand[] = [];
  private readonly pose: StreetPose = createStreetPose();

  private readonly vKey = new Float64Array(VISIBLE);
  private readonly vX = new Float64Array(VISIBLE);
  private readonly vY = new Float64Array(VISIBLE);
  private readonly vZ = new Float64Array(VISIBLE);
  private readonly vDx = new Float64Array(VISIBLE);
  private readonly vDz = new Float64Array(VISIBLE);
  private readonly vDist2 = new Float64Array(VISIBLE);
  private readonly vState = new Int32Array(VISIBLE);
  private readonly vKind = new Int32Array(VISIBLE);
  private readonly vLook = new Float64Array(VISIBLE);
  private readonly vSpeed = new Float64Array(VISIBLE);
  /** The seed a swig runs off: the anchor's hash, or the claimed actor's inherited one. */
  private readonly vSeed = new Float64Array(VISIBLE);
  private visible = 0;
  /**
   * Look, swig seed and **the ambient key this actor claimed**, per promoted
   * actor id. The key is what makes the pairing stable; see `CLAIM_SNAP`.
   */
  private readonly inherited = new Map<number, { look: number; seed: number; key: number }>();
  /** The keys currently held by a live actor, so a first claim cannot steal one. */
  private readonly lockedKeys = new Set<number>();
  /** Actor ids seen this frame. Filled during the gather; see the cleanup at its end. */
  private readonly liveIds = new Set<number>();

  constructor(assets: StreetlifeAssets, characters: CharacterAssets) {
    this.assets = assets;
    for (let i = 0; i < STREET_CAPACITY; i++) {
      const actor = new CharacterActor(characters, 0, assets.drunkKits[0]);
      actor.mesh.name = `street:${i}`;
      actor.mesh.visible = false;
      const props = new StreetProps(assets, actor);
      this.rigs.push(actor);
      this.slots.push({ actor, props, held: false, key: -1, kit: null, down: false });
    }
  }

  /**
   * Place everybody in view, at `tick` plus a frame fraction.
   *
   * `tick` may be fractional -- `PoliceSquad.update`'s split: the aggro tests run
   * on whole ticks so this client and the server ask the identical question, and
   * the picture runs between them so a 144 Hz display does not watch 60 Hz people.
   */
  update(
    peds: PedestrianField | null,
    field: { actors: Iterable<NpcActor> },
    tick: number,
    dt: number,
    x: number,
    z: number,
  ): void {
    const at = performance.now();
    this.gather(peds, field, tick, x, z);
    this.assign();
    this.drive(dt, trafficSeconds(tick));
    this.costMs = performance.now() - at;
  }

  /**
   * Everybody in view into the visible arrays, **ambient first and promoted
   * second**, which is the opposite of `PoliceSquad.gather` and is deliberate.
   *
   * The promoted pass has to be able to find the ambient it is standing on, to
   * claim it and to inherit its look -- see `CLAIM_RADIUS`. So the ambients are
   * laid down first and the promoted actors overwrite the entries they claim,
   * which both removes the duplicate and keeps the array packed with no second
   * compaction pass.
   *
   * Priority is restored at the end: an actor that claimed nothing is appended,
   * and `assign` picks by distance, so somebody running at you is nearer than
   * somebody loitering and wins a rig on that alone.
   */
  private gather(
    peds: PedestrianField | null,
    field: { actors: Iterable<NpcActor> },
    tick: number,
    x: number,
    z: number,
  ): void {
    let n = 0;
    const r2 = STREET_DRAW_RADIUS * STREET_DRAW_RADIUS;

    if (peds) {
      const push = (p: StreetPose): boolean | void => {
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
        this.vState[n] = NPC_STATE.IDLE;
        this.vKind[n] = p.kind;
        this.vLook[n] = p.look;
        this.vSeed[n] = p.key;
        this.vSpeed[n] = 0;
        n++;
      };
      forEachMethheadNear(peds, x, z, STREET_DRAW_RADIUS, tick, this.bands, this.pose, push);
      forEachDrunkNear(peds, x, z, STREET_DRAW_RADIUS, tick, this.bands, this.pose, push);
    }
    this.ambient = n;

    let actors = 0;
    // Whatever is already spoken for. Rebuilt per frame rather than maintained,
    // because the actor set is the wire's and turns over without telling us.
    this.lockedKeys.clear();
    for (const held of this.inherited.values()) {
      if (held.key >= 0) this.lockedKeys.add(held.key);
    }
    this.liveIds.clear();
    for (const a of field.actors) {
      if (!isStreetKind(a.kind)) continue;
      this.liveIds.add(a.id);
      const dx = a.x - x;
      const dz = a.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;

      let mine = this.inherited.get(a.id);
      let claim = -1;

      // --- The held claim, by key rather than by distance. See `CLAIM_SNAP`:
      // this is the whole of the fix, and the reason it is an identity lookup is
      // that distance stopped being an identity the moment a pub's drunks stood
      // together.
      if (mine !== undefined && mine.key >= 0) {
        for (let i = 0; i < this.ambient; i++) {
          if (this.vKey[i] !== mine.key) continue;
          claim = i;
          break;
        }
        if (claim >= 0) {
          // Released once the actor has dragged it `CLAIM_RADIUS` off the post,
          // which is the documented "the loiterer comes back" behaviour.
          const ax = this.vX[claim] - a.x;
          const az = this.vZ[claim] - a.z;
          if (ax * ax + az * az > CLAIM_RADIUS_2) {
            this.lockedKeys.delete(mine.key);
            mine.key = -1;
            claim = -1;
          }
        }
      }

      // --- A first claim, or a re-claim by an actor that has walked back to its
      // post. Only what it is literally standing on, and never somebody else's.
      if (claim < 0 && (mine === undefined || mine.key < 0)) {
        let best2 = CLAIM_SNAP_2;
        for (let i = 0; i < this.ambient; i++) {
          if (this.vKind[i] !== a.kind) continue;
          if (this.vKey[i] < 0) continue;
          if (this.lockedKeys.has(this.vKey[i])) continue;
          const ax = this.vX[i] - a.x;
          const az = this.vZ[i] - a.z;
          const ad2 = ax * ax + az * az;
          if (ad2 >= best2) continue;
          best2 = ad2;
          claim = i;
        }
        if (claim >= 0) this.lockedKeys.add(this.vKey[claim]);
      }

      if (mine === undefined) {
        mine =
          claim >= 0
            ? { look: this.vLook[claim], seed: this.vSeed[claim], key: this.vKey[claim] }
            : { look: carHash(a.id, 0x4a17), seed: a.id, key: -1 };
        this.inherited.set(a.id, mine);
      } else if (mine.key < 0 && claim >= 0) {
        mine.key = this.vKey[claim];
      }

      // Overwrite the claimed ambient rather than appending: one slot, one
      // person, and the loiterer this actor *is* stops being drawn separately.
      const at = claim >= 0 ? claim : n;
      if (at >= VISIBLE) continue;
      if (claim < 0) n++;
      this.vKey[at] = -a.id;
      this.vX[at] = a.x;
      this.vY[at] = a.y;
      this.vZ[at] = a.z;
      this.vDx[at] = a.dx;
      this.vDz[at] = a.dz;
      this.vDist2[at] = d2;
      this.vState[at] = a.state;
      this.vKind[at] = a.kind;
      this.vLook[at] = mine.look;
      this.vSeed[at] = mine.seed;
      // The gait comes from the state, not from a measured speed: a promoted
      // actor's position arrives interpolated between two snapshots and
      // differencing it per frame reports a walk as a sprint on a slow frame.
      // `RemotePlayer.speed` documents the same trap.
      this.vSpeed[at] =
        a.state === NPC_STATE.CHASE
          ? a.kind === NPC_KIND.METHHEAD
            ? METH_CHASE_SPEED
            : DRUNK_CHASE_SPEED
          : a.state === NPC_STATE.RETURN || a.state === NPC_STATE.WALK
            ? 1.4
            : 0;
      actors++;
    }
    this.actors = actors;
    this.visible = n;

    // Forget the look of anybody who has resolved. `NetClient` rebuilds its
    // actor set from every snapshot, so an id that stops appearing is gone --
    // and an unbounded map keyed on a 16-bit id that wraps would eventually hand
    // a fresh meth head a despawned one's hat.
    //
    // The live set is the one collected **during** the pass above rather than a
    // second walk of `field.actors`, and that is a correctness fix rather than a
    // saved loop: online `policeField()` hands over `net.actors.values()`, a Map
    // iterator, which the pass above has already exhausted. Re-iterating it
    // yielded nothing, so every entry looked dead and the whole table was
    // dropped the first time it passed 64 -- every street person in view
    // changing kit and hat on one frame, and, now that the claim is held here,
    // every pairing releasing at once.
    if (this.inherited.size > 64) {
      for (const id of [...this.inherited.keys()]) {
        if (!this.liveIds.has(id)) this.inherited.delete(id);
      }
    }
  }

  /**
   * Hand the nearest people a rig, keeping the ones already assigned.
   *
   * `PedestrianCrowd.assign`'s two passes and no sort: the first keeps every
   * slot whose person is still in view, which is the hysteresis that stops a rig
   * being handed back and forth between two people at the same distance; the
   * second fills what is left with the nearest unassigned person.
   */
  private assign(): void {
    const taken = new Set<number>();
    for (const slot of this.slots) {
      if (!slot.held) continue;
      let still = false;
      for (let i = 0; i < this.visible; i++) {
        if (this.vKey[i] === slot.key) {
          still = true;
          break;
        }
      }
      if (still) taken.add(slot.key);
      else slot.held = false;
    }
    for (const slot of this.slots) {
      if (slot.held) continue;
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
      slot.held = true;
      taken.add(slot.key);
    }
  }

  /** Drive every assigned rig, and hide the rest. */
  private drive(dt: number, now: number): void {
    for (const slot of this.slots) {
      if (!slot.held) {
        if (slot.actor.mesh.visible) {
          slot.actor.mesh.visible = false;
          slot.props.hideAll();
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

      const kind = this.vKind[i];
      const look = this.vLook[i];
      const meth = kind === NPC_KIND.METHHEAD;

      // The kit, swapped by reference and only when it changes. A pooled rig is
      // reassigned between a meth head and a drunk as people come and go, and
      // `PedestrianCrowd` makes the same swap for the same reason.
      const kits = meth ? this.assets.methKits : this.assets.drunkKits;
      const kit = kits[Math.floor(look / 8) % kits.length];
      if (slot.kit !== kit) {
        slot.kit = kit;
        slot.actor.mesh.geometry = kit;
      }

      slot.actor.mesh.visible = true;
      slot.props.beanie.visible = meth && (look & 1) === 0;
      slot.props.cap.visible = meth && (look & 1) === 1;
      slot.props.vest.visible = !meth;
      slot.props.bottle.visible = !meth;
      if (!meth) {
        const vest = this.assets.vests[(look >>> 1) % this.assets.vests.length];
        if (slot.props.vest.geometry !== vest) slot.props.vest.geometry = vest;
      }

      const state = this.vState[i];
      const down = state === NPC_STATE.DOWN;
      if (down !== slot.down) {
        slot.down = down;
        // `knockout` holds until something clears it, which is what an eight- or
        // ten-second downtime wants: there is no clock here that has to agree
        // with the authority's.
        slot.actor.setAction(down ? 'knockout' : null);
      }
      slot.actor.update(dt, {
        position: { x: this.vX[i], y: this.vY[i], z: this.vZ[i] },
        // Yaw 0 faces -Z, so the yaw that sends the figure's forward to (dx, dz)
        // is `atan2(-dx, -dz)`. One `atan2` per drawn person per frame, entirely
        // on the presentation side -- see `game/factions.ts`'s determinism rule.
        yaw: Math.atan2(-this.vDx[i], -this.vDz[i]),
        speed: down ? 0 : this.vSpeed[i],
        onGround: true,
      });

      // --- The swig, **after** `update`, because that is what writes the bones.
      //
      // An overlay on two joints rather than a clip, and the difference is the
      // whole reason it exists at all: `player/animation.ts` has four
      // locomotions and five reactions and every one of them is written for a
      // player, so a drinking pose would be a sixth reaction in a file this
      // faction does not own and a weight in a crossfade nobody else wants.
      // Writing the shoulder and the elbow here costs two Euler sets on the
      // frames a bottle is actually up, and the bottle follows the hand because
      // it is parented to the wrist -- which is the entire argument for
      // bone-parented props restated in one sentence.
      if (!meth && !down) this.swig(slot, this.vSeed[i], now);
    }
  }

  /**
   * Raise the arm and tip the bottle, if this one is mid-swig.
   *
   * `swigPhase` is the shared clock and it returns -1 for "bottle down", which
   * is most of the time: `SWIG_DUTY` is 0.22 of an eleven-second cycle, so a
   * drunk is drinking for two and a half seconds in eleven and standing there
   * with a longneck for the rest. The eased amount is a triangle over that
   * window -- up, held, down -- because a linear one snaps at the top and reads
   * as the arm hitting something.
   */
  private swig(slot: Slot, seed: number, now: number): void {
    const p = swigPhase(seed, now);
    if (p < 0) {
      // The bottle hangs, and the arm is whatever the locomotion put it at.
      slot.props.bottle.rotation.set(0, 0, 0);
      return;
    }
    const triangle = 1 - Math.abs(p * 2 - 1);
    const amount = triangle * triangle * (3 - 2 * triangle);
    const bones = slot.actor.bones;
    // The upper arm swings forward and slightly in; the forearm folds up. These
    // are eyeballed against the rig rather than derived: the wrist has to arrive
    // in front of the chin, and `RIG` puts the shoulder at 1.14 m with a 0.33 m
    // upper arm and a 0.31 m forearm, so a 32-degree swing and a 129-degree fold
    // lands the mitt at about 1.35 m and 0.2 m forward, which is a mouth.
    bones[BONE.SHOULDER_R].rotation.x -= 0.56 * amount;
    bones[BONE.SHOULDER_R].rotation.z -= 0.34 * amount;
    bones[BONE.ELBOW_R].rotation.x -= 2.25 * amount;
    // And the head goes back, which is the read: a person tipping a bottle tips
    // their head, and without it the bottle simply arrives at a face that has
    // not moved.
    bones[BONE.HEAD].rotation.x -= 0.3 * amount;
    // The bottle's own tip, on top of the arm's. The forearm points up-forward
    // at the top of the swing, so the bottle needs another half-radian to get
    // its mouth over the lip rather than under the chin.
    slot.props.bottle.rotation.set(-0.55 * amount, 0, 0);
  }

  /**
   * Release the rigs. **Not the shared geometry or the material**, which are
   * `StreetlifeAssets`' and are drawn by every street person in the city -- the
   * trap `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const slot of this.slots) {
      slot.props.dispose();
      slot.actor.mesh.removeFromParent();
    }
  }
}

// --- The self-check ---------------------------------------------------------------------

/**
 * The look, checked for the ways it fails without throwing.
 *
 * Every one of them is invisible from the camera a developer is sitting in,
 * which is this project's whole criterion:
 *
 *   - **A prop wound inside out** is a beanie you can see the skull through from
 *     in front and not from behind. From a single frame it reads as a
 *     z-fighting artefact or as odd lighting, and `world/police.ts` and
 *     `player/bat.ts` both have the same assertion for the same reason.
 *   - **A hat inside the head** is the failure `verifyPoliceKit` was written for
 *     and it cost that file a screenshot to find: `BONE.HEAD`'s origin is at the
 *     *base* of the skull, so a hat at a plausible 0.2 is dead centre inside it
 *     and invisible from every angle. It looks like the prop was never parented.
 *   - **A narrowed head** would be a beanie worn like a hoop, because both hats
 *     are sized against `HEAD_RADII` and the meth head kit is the only geometry
 *     in the build whose vertices have moved.
 *   - **A shirt on a shirtless man** is one line of a colourway, and it is
 *     exactly the sort of thing that survives a review because the figure still
 *     looks like a person.
 */
export function verifyStreetlifeKit(assets: StreetlifeAssets): string[] {
  const failures: string[] = [];

  // --- Every ring quad's normal points away from the figure's axis.
  //
  // The test is the dot of the face normal with the outward radial direction at
  // the quad's own centre, which is the only formulation that works for a ring:
  // "outward" is a different direction for every facet. The lids are excluded by
  // the radius floor, because a fan's centre vertex has no radial direction.
  for (const [name, geometry] of [
    ['beanie', assets.beanie],
    ['cap', assets.cap],
    ['vest', assets.vests[0]],
    ['stubbie', assets.bottle],
  ] as Array<[string, BufferGeometry]>) {
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const idx = geometry.getIndex();
    if (!pos || !nrm || !idx) {
      failures.push(`The ${name} is missing an attribute; it cannot be drawn.`);
      continue;
    }
    if (pos.count === 0 || idx.count === 0) {
      failures.push(`The ${name} has no triangles in it; it would be invisible and still be there.`);
      continue;
    }
    let inward = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const i = idx.getX(t);
      const cx = pos.getX(i);
      const cz = pos.getZ(i);
      const r = Math.sqrt(cx * cx + cz * cz);
      // Skip the fan centres and the cap peak, which is a flat sheet drawn on
      // both sides and has no outward direction at all.
      if (r < 0.02) continue;
      if (Math.abs(nrm.getY(i)) > 0.9) continue;
      const dot = (nrm.getX(i) * cx + nrm.getZ(i) * cz) / r;
      if (dot < 0) inward++;
    }
    if (inward > 0) {
      failures.push(
        `${inward} of the ${name}'s triangles face inward. A ring wound the wrong way is invisible from ` +
          'outside the wearer and solid from inside them.',
      );
    }
  }

  // --- Both hats are on the head rather than inside it.
  //
  // The head runs from -0.055 to +0.445 in `BONE.HEAD`'s frame with its widest
  // point at +0.195, so anything below about 0.22 is inside the skull. See
  // `verifyPoliceKit`, which found this the hard way.
  for (const [name, geometry, floor] of [
    ['beanie', assets.beanie, 0.22],
    ['cap', assets.cap, 0.22],
  ] as Array<[string, BufferGeometry, number]>) {
    const pos = geometry.getAttribute('position');
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      lowest = Math.min(lowest, pos.getY(i));
      highest = Math.max(highest, pos.getY(i));
    }
    if (lowest < floor) {
      failures.push(
        `The ${name}'s lowest point is ${lowest.toFixed(3)} m above the head joint, at or below the skull's ` +
          'widest point (0.195). It would be inside the head and invisible from every angle.',
      );
    }
    if (highest > 0.5) {
      failures.push(`The ${name} reaches ${highest.toFixed(3)} m, well over the crown at 0.445. It would float.`);
    }
  }

  // --- The vest is over the torso and not inside it or floating off it.
  {
    const pos = assets.vests[0].getAttribute('position');
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = Math.sqrt(x * x + z * z);
      if (r < 0.02) continue;
      const stand = r - torsoRadius(y);
      if (stand < 0.002) {
        failures.push(
          `The vest passes inside the torso at y = ${y.toFixed(3)} (${(stand * 1000).toFixed(1)} mm). ` +
            'It would z-fight the shirt under it, which reads as a flickering texture rather than as a size.',
        );
        break;
      }
      worst = Math.max(worst, stand);
    }
    if (worst > 0.05) {
      failures.push(`The vest stands ${(worst * 1000).toFixed(0)} mm off the torso at its worst; it would read as a barrel.`);
    }
  }

  // --- The bottle is a longneck rather than a can, and it is in the hand.
  {
    const pos = assets.bottle.getAttribute('position');
    let lo = Infinity;
    let hi = -Infinity;
    let widest = 0;
    for (let i = 0; i < pos.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
      const x = pos.getX(i);
      const z = pos.getZ(i);
      widest = Math.max(widest, Math.sqrt(x * x + z * z));
    }
    const height = hi - lo;
    if (height < 0.2 || height > 0.36) {
      failures.push(`The stubbie is ${(height * 100).toFixed(0)} cm tall; a longneck is 29 and the silhouette is the point.`);
    }
    if (height / (widest * 2) < 2.5) {
      failures.push('The stubbie is too fat for its height; at any distance it would read as a can rather than a bottle.');
    }
    // The mitt hangs about 40 mm below the wrist joint, so the bottle's body has
    // to straddle that or it is being held by nothing.
    if (lo > -0.05 || hi < 0.05) {
      failures.push(
        `The stubbie runs from ${lo.toFixed(3)} to ${hi.toFixed(3)} in the wrist's frame. It has to straddle ` +
          'the mitt at about -0.04, or it floats beside the hand.',
      );
    }
  }

  // --- Shirtless is a colourway, and it is one line that can silently be wrong.
  for (const kit of METH_KITS) {
    for (let c = 0; c < 3; c++) {
      if (kit.singlet[c] !== kit.skin[c]) {
        failures.push(
          `The "${kit.name}" kit's singlet is not its skin tone, so the meth head is wearing a shirt. ` +
            'Shirtless is the whole of what makes them read as a different kind of person.',
        );
        break;
      }
    }
  }
  for (const kit of DRUNK_KITS) {
    let bare = true;
    for (let c = 0; c < 3; c++) if (kit.singlet[c] !== kit.skin[c]) bare = false;
    if (bare) failures.push(`The "${kit.name}" kit is shirtless; the drunks are dressed and the vest goes over it.`);
  }

  // --- The narrowed figure: narrower than the drunks', with the head untouched.
  {
    if (assets.methKits.length === 0 || assets.drunkKits.length === 0) {
      failures.push('A kit list is empty; nobody would be drawn.');
    } else {
      const skinny = assets.methKits[0].getAttribute('position');
      const plain = assets.drunkKits[0].getAttribute('position');
      if (!skinny || !plain || skinny.count !== plain.count) {
        failures.push('The narrowed figure has a different vertex count from the figure; it is not the same mesh.');
      } else {
        // Measured **against each vertex's own bone axis**, which is the
        // property the transform actually has and the one that matters: flesh
        // comes in toward the bone it hangs off.
        //
        // The first version of this compared plan radius about the *body* axis
        // and reported twelve failures on a correct mesh -- the inner face of
        // each shoulder is closer to the body's centreline than its own arm
        // bone is, so pulling it toward the arm moves it *outward* in body
        // radius while making the arm thinner. A skinny person has thin arms in
        // the places arms are, not a figure squeezed toward its spine.
        const skinIndex = plain.array !== undefined ? assets.drunkKits[0].getAttribute('skinIndex') : null;
        const skinWeight = assets.drunkKits[0].getAttribute('skinWeight');
        const bones = bindPositions();
        let headMoved = 0;
        let wider = 0;
        let narrowed = 0;
        let vertical = 0;
        for (let i = 0; i < plain.count; i++) {
          const y = plain.getY(i);
          const dx = skinny.getX(i) - plain.getX(i);
          const dy = skinny.getY(i) - plain.getY(i);
          const dz = skinny.getZ(i) - plain.getZ(i);
          if (Math.abs(dy) > 1e-6) vertical++;
          // The head lobe, the eyes, the nose and the neck's top ring all sit
          // above 1.2 m and are all sized against, or hidden inside, the skull.
          if (y > 1.2 && (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6)) headMoved++;
          if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) narrowed++;
          if (!skinIndex || !skinWeight) continue;
          const bone = skinWeight.getX(i) >= skinWeight.getY(i) ? skinIndex.getX(i) : skinIndex.getY(i);
          const ax = bones[bone * 3];
          const az = bones[bone * 3 + 2];
          const before = Math.sqrt((plain.getX(i) - ax) ** 2 + (plain.getZ(i) - az) ** 2);
          const after = Math.sqrt((skinny.getX(i) - ax) ** 2 + (skinny.getZ(i) - az) ** 2);
          if (after > before + 1e-6) wider++;
        }
        if (vertical > 0) {
          failures.push(`The narrowing moved ${vertical} vertices vertically; a skinny person is not a short one.`);
        }
        if (headMoved > 0) {
          failures.push(
            `${headMoved} head vertices moved when the figure was narrowed. Both hats are sized against ` +
              'the skull, so a narrowed head wears a beanie like a hoop.',
          );
        }
        if (wider > 0) {
          failures.push(`${wider} vertices ended up further from their own bone than they started; that is not narrowing.`);
        }
        if (narrowed === 0) failures.push('The narrowed figure is identical to the figure; meth heads are not skinny at all.');
      }
    }
  }

  // --- The kit geometry is a real figure and shares the rig's skinning.
  for (const [name, list] of [['meth', assets.methKits], ['drunk', assets.drunkKits]] as Array<
    [string, readonly BufferGeometry[]]
  >) {
    for (const g of list) {
      if (!g.getAttribute('skinIndex')) {
        failures.push(`A ${name} kit carries no skin indices; the figure could not follow the rig.`);
        break;
      }
      if (!g.getAttribute('color')) {
        failures.push(`A ${name} kit has no colour attribute; everybody in it would be white.`);
        break;
      }
    }
  }

  // --- The fluoro is albedo and not emission, which is what stops a drunk
  // glowing inside a shadow they are standing in.
  {
    const e = assets.material.emissive;
    if (e && (e.r > 0.01 || e.g > 0.01 || e.b > 0.01)) {
      failures.push('The street material is emissive; a hi-vis vest reflects light, it does not make any.');
    }
    if (!assets.material.vertexColors) {
      failures.push('The street material ignores vertex colours; every prop would be white.');
    }
  }

  return failures;
}

/**
 * The street factions' own pipelines, as warm-up parts.
 *
 * The **props** rather than the bodies, for `policeWarmupParts`' reason: a
 * loiterer's body is a `CharacterActor` whose skinned pipeline the boot warm-up
 * already compiles from a throwaway actor, and the skinny meth-head kit is a
 * modified position buffer on the same attribute layout, so it keys the same and
 * costs no compile when `StreetCrowd.assign` swaps it in.
 *
 * The four props are a different matter. They are plain `Mesh`es on a material
 * nothing else in the world uses and they start `visible = false`, and an
 * invisible mesh is never drawn -- `_projectObject` returns early on it -- so
 * without this entry the first meth head to come round a corner compiles a
 * pipeline in the frame they appear in.
 *
 * One entry per prop even though all four share the material, because the cache
 * key reads the geometry's attribute layout and the four are built by four
 * different builders. `vests[0]` stands in for both vests: two geometries, one
 * layout, one pipeline.
 */
export function streetlifeWarmupParts(assets: StreetlifeAssets): WarmupPart[] {
  return [assets.beanie, assets.cap, assets.vests[0], assets.bottle].map((geometry) => ({
    geometry,
    material: assets.material,
    // `StreetProps`' own flags: a prop casts and receives.
    casts: true,
  }));
}
