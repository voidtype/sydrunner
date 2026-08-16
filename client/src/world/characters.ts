/**
 * What the five characters look like: five kits, eight props, and the pool of
 * rigs that draws both tiers of all of them.
 *
 * The **rendering** half of `game/characters.ts`, on `world/streetlife.ts`'s
 * split exactly: that file decides where these people are and is compiled into
 * the Bun server, and this one draws them and imports three.
 *
 * ---------------------------------------------------------------------------
 * THE FIGURE IS THE FIGURE. Nothing here is a second mesh.
 *
 * `world/police.ts` states the case and `world/streetlife.ts` inherits it, so it
 * is not restated: a second body would be a second thing to re-weight the day a
 * bone moves, and it could not go through the pooled-rig geometry swap. All five
 * are the same 1.70 m figure everybody else is, and the whole of the look is a
 * colourway and props parented to bones.
 *
 * This file does not even do the one thing `world/streetlife.ts` added -- the
 * narrowed position buffer. A meth head needed to be *skinny*, which is a shape.
 * None of these five is defined by a shape; they are defined by what they are
 * wearing and what they are holding, which is exactly what a colourway and a
 * prop are for. So the kit geometries here are `CharacterAssets.kitGeometry`
 * unmodified, and this file allocates no vertex data for a body at all.
 *
 * ---------------------------------------------------------------------------
 * THE PROPS, and what each one is for at forty metres.
 *
 * `world/police.ts`'s criterion throughout: a prop earns its triangles by what
 * it does at 40 m, not by what it does at 3.
 *
 *   - the **cap** and the **bumbag** are the eshay, and the bumbag is the one
 *     that does the work. A cap is a cap; a bag worn across the chest is a
 *     silhouette nobody else in this city has.
 *   - the **sunglasses on the head** are the Karen and the influencer both, and
 *     they are deliberately shared: two different people wearing the same thing
 *     the same way is the observation, not an economy. On the crown rather than
 *     over the eyes, which is the entire joke and is worth two triangles.
 *   - the **coffee cup** is the Karen's other hand, and it is a white cylinder
 *     with a dark lid because that reads at distance and a keep cup does not.
 *   - the **hard hat** and the **vest** are the tradie. The vest is the drunk's
 *     geometry rebuilt rather than imported, for the reason `world/police.ts`
 *     gives about restating `Parts`: importing it would make a change to the
 *     drunks' hem a change to the tradie's.
 *   - the **phone** is the influencer's, and it is *held up*, which is why it is
 *     parented to the wrist and why `raisePhone` writes two bone rotations. A
 *     phone at hip height is a phone; a phone at eye height pointed at you is a
 *     character.
 *   - the **clipboard** is the agent's, and it is the smallest prop here. It
 *     does nothing at forty metres and it does everything at four, which is the
 *     one exception this file makes to the rule above -- an agent is somebody
 *     you meet on a footpath, never somebody you see across a park.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import { BONE } from '../player/animation.ts';
import {
  CharacterActor,
  SELF_SHADOW_LAYER,
  type CharacterAssets,
  type Colourway,
} from '../player/character.ts';
import { NPC_KIND, NPC_STATE, type NpcActor } from '../game/factions.ts';
import {
  ESHAY_CHASE_SPEED,
  createCharacterPose,
  forEachCharacterNear,
  isCharacterKind,
  lineFor,
  type CharacterPose,
} from '../game/characters.ts';
import { type PedBand, type PedestrianField } from '../game/pedestrians.ts';
import { carHash, trafficSeconds } from '../game/traffic.ts';

// --- The kits -----------------------------------------------------------------------------

/**
 * One kit per character, and the colours are the observation.
 *
 * Linear, like every colour in this project -- the display value is roughly the
 * square root of these, so `0.055` reads as a mid navy rather than as black.
 *
 * `singlet` is the top, `shorts` is the bottom, and `skin` and `shoe` are what
 * they say. `world/streetlife.METH_KITS` uses `singlet === skin` for a bare
 * torso; nothing here does, because all five of these people are dressed, which
 * is itself a thing you can see from a hundred metres.
 */
export const ESHAY_KITS: readonly Colourway[] = [
  // Navy polo, black trackies, white shoes. The shoes are the loud part and they
  // are the one white object below the knee in the whole build.
  { name: 'eshay/navy', singlet: [0.045, 0.075, 0.17], shorts: [0.035, 0.035, 0.04], skin: [0.44, 0.3, 0.22], shoe: [0.85, 0.85, 0.84] },
  { name: 'eshay/red', singlet: [0.3, 0.045, 0.055], shorts: [0.035, 0.035, 0.04], skin: [0.3, 0.2, 0.15], shoe: [0.85, 0.85, 0.84] },
  { name: 'eshay/white', singlet: [0.62, 0.63, 0.64], shorts: [0.03, 0.03, 0.036], skin: [0.5, 0.35, 0.27], shoe: [0.82, 0.83, 0.85] },
];

/** Activewear: one is black, one is the mauve nobody else wears. */
export const KAREN_KITS: readonly Colourway[] = [
  { name: 'karen/black', singlet: [0.05, 0.05, 0.055], shorts: [0.04, 0.04, 0.045], skin: [0.55, 0.4, 0.32], shoe: [0.7, 0.7, 0.72] },
  { name: 'karen/mauve', singlet: [0.24, 0.14, 0.22], shorts: [0.045, 0.045, 0.05], skin: [0.6, 0.44, 0.35], shoe: [0.75, 0.74, 0.73] },
];

/** Hi-vis over a work shirt, and shorts. The vest prop is what you actually see. */
export const TRADIE_KITS: readonly Colourway[] = [
  { name: 'tradie/navy', singlet: [0.05, 0.08, 0.15], shorts: [0.09, 0.1, 0.11], skin: [0.42, 0.26, 0.18], shoe: [0.06, 0.055, 0.05] },
  { name: 'tradie/grey', singlet: [0.12, 0.125, 0.13], shorts: [0.08, 0.085, 0.09], skin: [0.5, 0.34, 0.24], shoe: [0.07, 0.06, 0.05] },
];

/** Activewear again, and lighter: the whole point is that it photographs. */
export const INFLUENCER_KITS: readonly Colourway[] = [
  { name: 'influencer/bone', singlet: [0.72, 0.68, 0.62], shorts: [0.66, 0.62, 0.56], skin: [0.62, 0.44, 0.32], shoe: [0.78, 0.78, 0.77] },
  { name: 'influencer/sage', singlet: [0.3, 0.4, 0.3], shorts: [0.62, 0.6, 0.55], skin: [0.55, 0.38, 0.28], shoe: [0.8, 0.8, 0.79] },
];

/** A slim suit. Charcoal or navy, white shirt collar implied by the skin tone. */
export const AGENT_KITS: readonly Colourway[] = [
  { name: 'agent/charcoal', singlet: [0.055, 0.058, 0.065], shorts: [0.05, 0.052, 0.06], skin: [0.5, 0.36, 0.28], shoe: [0.03, 0.03, 0.035] },
  { name: 'agent/navy', singlet: [0.04, 0.055, 0.11], shorts: [0.035, 0.05, 0.1], skin: [0.45, 0.32, 0.24], shoe: [0.03, 0.03, 0.035] },
];

/** Which kit list a kind wears. One lookup, so the renderer has no `switch`. */
function kitsFor(kind: number): readonly Colourway[] {
  switch (kind) {
    case NPC_KIND.ESHAY:
      return ESHAY_KITS;
    case NPC_KIND.KAREN:
      return KAREN_KITS;
    case NPC_KIND.TRADIE:
      return TRADIE_KITS;
    case NPC_KIND.INFLUENCER:
      return INFLUENCER_KITS;
    default:
      return AGENT_KITS;
  }
}

// --- Prop geometry -------------------------------------------------------------------------

/**
 * Triangle accumulator. `world/streetlife.Parts`, restated for the reason that
 * file restates `world/police.Parts`: it is sixty lines against an import that
 * would couple a change to the drunks' beanie to a change to the tradie's hat.
 */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  /** One flat quad, wound `a -> b -> c -> d`. The winding is what the check tests. */
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

  /** An axis-aligned box, six quads, all wound outward. */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    colour: readonly [number, number, number],
  ): void {
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colour); // top
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour); // bottom
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour); // -x
  }

  /** A closed band of quads between two rings, wound outward. `streetlife.Parts.band`. */
  band(
    y0: number, r0: number,
    y1: number, r1: number,
    sides: number,
    colour: readonly [number, number, number],
  ): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      this.quad(
        [Math.sin(a0) * r0, y0, Math.cos(a0) * r0],
        [Math.sin(a1) * r0, y0, Math.cos(a1) * r0],
        [Math.sin(a1) * r1, y1, Math.cos(a1) * r1],
        [Math.sin(a0) * r1, y1, Math.cos(a0) * r1],
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

/** Facets around a hat or a cup. `world/streetlife.SIDES`. */
const SIDES = 10;

/**
 * Everything above is in a **bone's** frame, and the head bone is not where a
 * head is.
 *
 * `world/police.ts` paid for this paragraph and `world/streetlife.ts` inherited
 * it: `animation.RIG` puts the head joint at 1.25 m and `character.HEAD_CENTRE`
 * puts the skull's centre at 1.445 with a vertical radius of 0.25, so in the
 * bone's own frame the head runs from -0.055 to +0.445 and its widest point is
 * at +0.195. A hat placed at a plausible-sounding 0.2 is dead centre inside the
 * skull and invisible from every angle. `verifyCharacterKit` asserts it from the
 * other end, because it is the failure that costs a screenshot to find.
 */
const HEAD_BROW = 0.235;
const HEAD_CROWN = 0.44;

const CAP_NAVY: readonly [number, number, number] = [0.035, 0.055, 0.13];
const CAP_PEAK: readonly [number, number, number] = [0.028, 0.045, 0.11];
const BAG_BLACK: readonly [number, number, number] = [0.035, 0.035, 0.04];
const BAG_TRIM: readonly [number, number, number] = [0.5, 0.09, 0.09];
const SHADE_LENS: readonly [number, number, number] = [0.02, 0.022, 0.028];
const SHADE_FRAME: readonly [number, number, number] = [0.35, 0.3, 0.22];
const CUP_WHITE: readonly [number, number, number] = [0.78, 0.77, 0.74];
const CUP_LID: readonly [number, number, number] = [0.09, 0.085, 0.08];
const HAT_WHITE: readonly [number, number, number] = [0.82, 0.82, 0.8];
const FLUORO_YELLOW: readonly [number, number, number] = [0.72, 0.85, 0.05];
const FLUORO_ORANGE: readonly [number, number, number] = [0.9, 0.32, 0.02];
const VEST_SILVER: readonly [number, number, number] = [0.55, 0.57, 0.58];
const PHONE_BODY: readonly [number, number, number] = [0.03, 0.03, 0.035];
const PHONE_SCREEN: readonly [number, number, number] = [0.55, 0.6, 0.72];
const BOARD_WHITE: readonly [number, number, number] = [0.74, 0.73, 0.7];
const BOARD_CLIP: readonly [number, number, number] = [0.3, 0.3, 0.32];

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
 * Every piece of geometry the five share, built once for the city.
 *
 * `CharacterAssets`' contract, with the same consequence for teardown: a crowd
 * must never dispose these, because every other character in the city is drawing
 * them.
 */
export class CharacterKitAssets {
  readonly kits: ReadonlyMap<number, readonly BufferGeometry[]>;
  readonly cap: BufferGeometry;
  readonly bumbag: BufferGeometry;
  readonly shades: BufferGeometry;
  readonly cup: BufferGeometry;
  readonly hardhat: BufferGeometry;
  readonly vests: readonly BufferGeometry[];
  readonly phone: BufferGeometry;
  readonly clipboard: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;

  constructor(characters: CharacterAssets) {
    const kits = new Map<number, readonly BufferGeometry[]>();
    for (const kind of [NPC_KIND.ESHAY, NPC_KIND.KAREN, NPC_KIND.TRADIE, NPC_KIND.INFLUENCER, NPC_KIND.AGENT]) {
      kits.set(kind, kitsFor(kind).map((kit) => characters.kitGeometry(kit)));
    }
    this.kits = kits;

    // --- The cap: a tapered crown, a flat top, and a peak over -Z, which is the
    // direction the figure faces. `world/streetlife.ts`'s cap in navy, and it is
    // the same geometry deliberately -- a cap is a cap, and two slightly
    // different caps in one build would be two things to keep off the skull.
    const cap = new Parts();
    const CAP_R = 0.175;
    cap.band(0.3, CAP_R, 0.405, CAP_R * 0.86, SIDES, CAP_NAVY);
    cap.lid(0.405, CAP_R * 0.86, SIDES, true, CAP_NAVY);
    {
      const y = 0.304;
      const hw = CAP_R * 0.8;
      const tw = CAP_R * 0.52;
      const near = -CAP_R * 0.55;
      const far = near - 0.15;
      cap.quad([-hw, y, near], [hw, y, near], [tw, y, far], [-tw, y, far], CAP_PEAK);
      cap.quad([-tw, y - 0.008, far], [tw, y - 0.008, far], [hw, y - 0.008, near], [-hw, y - 0.008, near], CAP_PEAK);
    }
    this.cap = cap.build('eshay-cap');

    // --- The bumbag, in the **chest** bone's frame rather than the hips'.
    //
    // Worn across the chest, which is how it is actually worn and is also the
    // only way it is visible: a bag at the hips is behind the arms from every
    // angle a player sees somebody at. The strap is a thin quad across the torso
    // and it is what makes the silhouette rather than the pouch.
    const bag = new Parts();
    bag.box(0, -0.14, -torsoRadius(-0.14) - 0.045, 0.115, 0.055, 0.045, BAG_BLACK);
    bag.box(0, -0.14, -torsoRadius(-0.14) - 0.09, 0.09, 0.024, 0.004, BAG_TRIM);
    // The strap, corner to opposite shoulder. Two thin boxes rather than a
    // rotated one, because a rotation here would need a matrix and this is two
    // hundred grams of geometry.
    bag.box(-0.06, -0.03, -torsoRadius(-0.03) - 0.012, 0.022, 0.13, 0.008, BAG_BLACK);
    bag.box(0.06, -0.03, torsoRadius(-0.03) + 0.012, 0.022, 0.13, 0.008, BAG_BLACK);
    this.bumbag = bag.build('eshay-bumbag');

    // --- Sunglasses, on the crown. Two lenses and a bridge, lying flat, which
    // is the pose that makes them read as pushed up rather than worn.
    const shades = new Parts();
    shades.box(-0.062, HEAD_CROWN - 0.015, -0.055, 0.045, 0.012, 0.03, SHADE_LENS);
    shades.box(0.062, HEAD_CROWN - 0.015, -0.055, 0.045, 0.012, 0.03, SHADE_LENS);
    shades.box(0, HEAD_CROWN - 0.012, -0.055, 0.022, 0.008, 0.012, SHADE_FRAME);
    // The arms, back over the ears, so it is not two floating rectangles.
    shades.box(-0.1, HEAD_CROWN - 0.02, 0.02, 0.008, 0.008, 0.08, SHADE_FRAME);
    shades.box(0.1, HEAD_CROWN - 0.02, 0.02, 0.008, 0.008, 0.08, SHADE_FRAME);
    this.shades = shades.build('shades');

    // --- The coffee: a tapered white cup with a dark lid, in the right wrist's
    // frame. `world/streetlife.ts`'s stubbie sits at -0.14 to +0.15 in this
    // frame because the mitt is about 40 mm below the wrist joint; a takeaway
    // cup is shorter, so it straddles the same mitt over a smaller span.
    const cup = new Parts();
    cup.band(-0.055, 0.036, 0.055, 0.043, SIDES, CUP_WHITE);
    cup.band(0.055, 0.043, 0.068, 0.046, SIDES, CUP_LID);
    cup.lid(0.068, 0.046, SIDES, true, CUP_LID);
    cup.lid(-0.055, 0.036, SIDES, false, CUP_WHITE);
    this.cup = cup.build('karen-cup');

    // --- The hard hat: a dome with a brim. Sized off the same head profile the
    // cap is, and higher, because a hard hat sits on top of the skull rather
    // than around it.
    const hat = new Parts();
    hat.band(HEAD_BROW + 0.03, 0.185, HEAD_CROWN - 0.02, 0.155, SIDES, HAT_WHITE);
    hat.band(HEAD_CROWN - 0.02, 0.155, HEAD_CROWN + 0.04, 0.075, SIDES, HAT_WHITE);
    hat.lid(HEAD_CROWN + 0.04, 0.075, SIDES, true, HAT_WHITE);
    hat.band(HEAD_BROW + 0.03, 0.215, HEAD_BROW + 0.042, 0.215, SIDES, HAT_WHITE);
    hat.lid(HEAD_BROW + 0.03, 0.215, SIDES, false, HAT_WHITE);
    this.hardhat = hat.build('tradie-hardhat');

    // --- The vest, in the **chest** bone's frame. `world/streetlife.ts`'s
    // drunk vest rebuilt rather than imported; see this file's header on props.
    const vests: BufferGeometry[] = [];
    for (const [name, fluoro] of [['yellow', FLUORO_YELLOW], ['orange', FLUORO_ORANGE]] as Array<
      [string, readonly [number, number, number]]
    >) {
      const v = new Parts();
      const r = (y: number): number => torsoRadius(y) + 0.013;
      v.band(-0.3, r(-0.3), -0.13, r(-0.13), SIDES, fluoro);
      v.band(-0.13, r(-0.13), -0.085, r(-0.085), SIDES, VEST_SILVER);
      v.band(-0.085, r(-0.085), 0.03, r(0.03), SIDES, fluoro);
      v.lid(-0.3, r(-0.3), SIDES, false, fluoro);
      vests.push(v.build(`tradie-vest-${name}`));
    }
    this.vests = vests;

    // --- The phone, in the right wrist's frame, **face out**.
    //
    // The screen faces -Z, which in the bind pose is the direction the figure is
    // looking, so once `raisePhone` folds the elbow the screen is pointed at
    // whatever she is filming. Two boxes: a dark slab and a lighter face 3 mm
    // proud of it, which is the only way a 7 cm object reads as a phone at all.
    const phone = new Parts();
    phone.box(0, 0.075, 0.01, 0.038, 0.075, 0.006, PHONE_BODY);
    phone.box(0, 0.075, 0.004, 0.032, 0.066, 0.002, PHONE_SCREEN);
    this.phone = phone.build('influencer-phone');

    // --- The clipboard, in the left wrist's frame, held flat against the body.
    const board = new Parts();
    board.box(0, -0.08, 0.02, 0.11, 0.15, 0.006, BOARD_WHITE);
    board.box(0, 0.055, 0.02, 0.05, 0.018, 0.012, BOARD_CLIP);
    this.clipboard = board.build('agent-clipboard');

    this.triangles =
      cap.triangles + bag.triangles + shades.triangles + cup.triangles + hat.triangles +
      phone.triangles + board.triangles;

    // Lit, like the police kit and unlike a tracer. The fluoro is bright albedo
    // and nothing else -- `world/streetlife.ts` makes the argument: a hi-vis
    // vest is not emissive, and making it glow would make a tradie visible
    // through a shadow he is standing in.
    const material = new MeshStandardNodeMaterial();
    material.name = 'characters';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.6;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }

  /** Release what this object owns. Never the buffers it shares with the figure. */
  dispose(): void {
    for (const list of this.kits.values()) for (const g of list) g.dispose();
    for (const g of [this.cap, this.bumbag, this.shades, this.cup, this.hardhat, ...this.vests, this.phone, this.clipboard]) {
      g.dispose();
    }
    this.material.dispose();
  }
}

// --- One person's props ---------------------------------------------------------------------

/**
 * The eight props a pooled rig carries, all of them at once.
 *
 * A rig is reassigned between the five kinds as people come and go, so it holds
 * every prop and toggles visibility rather than building and tearing down
 * meshes -- `StreetProps`' arrangement and its argument: a `Mesh` added to a
 * `Bone` is a scene-graph edit, and doing eight of them on the frame somebody
 * walks past a station is the one allocation this pool exists to avoid.
 */
class CharacterProps {
  readonly cap: Mesh;
  readonly bumbag: Mesh;
  readonly shades: Mesh;
  readonly cup: Mesh;
  readonly hardhat: Mesh;
  readonly vest: Mesh;
  readonly phone: Mesh;
  readonly clipboard: Mesh;
  readonly all: readonly Mesh[];

  constructor(assets: CharacterKitAssets, actor: CharacterActor) {
    this.cap = new Mesh(assets.cap, assets.material);
    this.bumbag = new Mesh(assets.bumbag, assets.material);
    this.shades = new Mesh(assets.shades, assets.material);
    this.cup = new Mesh(assets.cup, assets.material);
    this.hardhat = new Mesh(assets.hardhat, assets.material);
    this.vest = new Mesh(assets.vests[0], assets.material);
    this.phone = new Mesh(assets.phone, assets.material);
    this.clipboard = new Mesh(assets.clipboard, assets.material);
    this.all = [this.cap, this.bumbag, this.shades, this.cup, this.hardhat, this.vest, this.phone, this.clipboard];
    for (const mesh of this.all) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = false;
    }
    actor.bones[BONE.HEAD].add(this.cap);
    actor.bones[BONE.HEAD].add(this.shades);
    actor.bones[BONE.HEAD].add(this.hardhat);
    actor.bones[BONE.CHEST].add(this.bumbag);
    actor.bones[BONE.CHEST].add(this.vest);
    actor.bones[BONE.WRIST_R].add(this.cup);
    actor.bones[BONE.WRIST_R].add(this.phone);
    actor.bones[BONE.WRIST_L].add(this.clipboard);
  }

  hideAll(): void {
    for (const mesh of this.all) mesh.visible = false;
  }

  /** Seen by the sun and not by the eye. `StreetProps.castShadowOnly`. */
  castShadowOnly(): void {
    for (const mesh of this.all) {
      mesh.layers.set(SELF_SHADOW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    }
  }

  dispose(): void {
    for (const mesh of this.all) mesh.removeFromParent();
  }
}

// --- The crowd -------------------------------------------------------------------------------

/**
 * Rigs held for the five characters. A **frame** budget, not the wire's.
 *
 * Twelve, against `STREET_CAPACITY`'s fourteen and `RIG_CAPACITY`'s fourteen for
 * nineteen thousand walkers. It is scaled against what is in view: a station
 * forecourt at night puts one eshay group and a Karen inside 40 m, and the
 * absolute worst case -- a shopping strip at nine in the morning with four
 * Karens, three tradies and an agent -- is eight.
 */
export const CHARACTER_CAPACITY = 12;

/** How far these are drawn, metres. Inside the crowd's own impostor radius. */
export const CHARACTER_DRAW_RADIUS = 150;

/** What the crowd was asked to draw this frame. Structure of arrays; allocates nothing. */
const VISIBLE = 64;

/**
 * How close a promoted actor has to be to an ambient anchor to claim it, and how
 * far it may then drag the claim.
 *
 * `world/streetlife.CLAIM_SNAP` and `CLAIM_RADIUS`, and that file's header is
 * the argument in full: **the wire does not carry an actor's home**, so a
 * connected client cannot ask a promoted Karen which strip she came off and
 * therefore cannot know which ambient to stop drawing. What it can do is notice
 * that a promoted actor is standing on top of one, which at the instant of
 * promotion is exact.
 *
 * The snap is 1.25 m -- the same figure, arrived at the same way: an actor is
 * literally standing on its ambient when it is promoted, and the nearest *other*
 * character of the same kind is at least a formation offset away. An eshay
 * group's members are 0.55 m and 0.95 m apart, which is the tightest pair in
 * this file, so the snap has to be under half of that. It is 0.4.
 */
const CLAIM_SNAP = 0.4;
const CLAIM_SNAP_2 = CLAIM_SNAP * CLAIM_SNAP;
const CLAIM_RADIUS = 30;
const CLAIM_RADIUS_2 = CLAIM_RADIUS * CLAIM_RADIUS;

/** One pooled rig and whoever it currently stands in for. */
interface Slot {
  actor: CharacterActor;
  props: CharacterProps;
  /** Whether this rig is standing in for anybody. A flag, never a sentinel in `key`. */
  held: boolean;
  /** The person's stable key: `characterKey` for an ambient, `-id` for an actor. */
  key: number;
  kit: BufferGeometry | null;
  down: boolean;
}

/**
 * What the crowd wants to say, this frame. Drained by `main.ts` into `hud.notice`.
 *
 * A queue rather than a callback for `FactionField.events`' reason: the caller
 * decides when and whether a line is shown, and this object has no business
 * knowing that a HUD exists. It is cleared at the top of every `update`, so a
 * caller that does not drain it simply misses lines rather than accumulating
 * them.
 */
export interface CharacterLine {
  text: string;
  x: number;
  z: number;
  kind: number;
}

/**
 * Every character in view, ambient and promoted, as pooled rigs.
 *
 * `update` allocates nothing after the first frame. Not parented to a tile, on
 * `StreetCrowd`'s argument: these people cross a tile boundary while an eshay is
 * chasing you and the crowd is drawn as one set for the whole visible world.
 */
export class CharacterCrowd {
  /** Add these to the scene. One per pooled rig. */
  readonly rigs: CharacterActor[] = [];

  /** Diagnostics for the HUD. */
  ambient = 0;
  actors = 0;
  costMs = 0;

  /** Lines said this frame. Cleared at the top of `update`; see `CharacterLine`. */
  readonly lines: CharacterLine[] = [];

  private readonly assets: CharacterKitAssets;
  private readonly slots: Slot[] = [];
  private readonly bands: PedBand[] = [];
  private readonly pose: CharacterPose = createCharacterPose();

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
  private visible = 0;

  /** Look and the claimed ambient key, per promoted actor id. See `CLAIM_SNAP`. */
  private readonly inherited = new Map<number, { look: number; key: number }>();
  private readonly lockedKeys = new Set<number>();
  private readonly liveIds = new Set<number>();
  /** The last second a given key spoke, so one line is posted once. */
  private readonly spokeAt = new Map<number, number>();

  constructor(assets: CharacterKitAssets, characters: CharacterAssets) {
    this.assets = assets;
    const first = assets.kits.get(NPC_KIND.KAREN)!;
    for (let i = 0; i < CHARACTER_CAPACITY; i++) {
      const actor = new CharacterActor(characters, 0, first[0]);
      actor.mesh.name = `character:${i}`;
      actor.mesh.visible = false;
      const props = new CharacterProps(assets, actor);
      this.rigs.push(actor);
      this.slots.push({ actor, props, held: false, key: -1, kit: null, down: false });
    }
  }

  /**
   * Place everybody in view, at `tick` plus a frame fraction.
   *
   * `tick` may be fractional -- `StreetCrowd.update`'s split: the promotion
   * tests run on whole ticks so this client and the server ask the identical
   * question, and the picture runs between them so a 144 Hz display does not
   * watch 60 Hz people.
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
    this.lines.length = 0;
    this.gather(peds, field, tick, x, z);
    this.assign();
    this.drive(dt, trafficSeconds(tick));
    this.speak(trafficSeconds(tick));
    this.costMs = performance.now() - at;
  }

  /**
   * Everybody in view into the visible arrays, **ambient first and promoted
   * second**, which is `StreetCrowd.gather`'s order and is deliberate: the
   * promoted pass has to be able to find the ambient it is standing on, claim
   * it and inherit its look, so the ambients are laid down first and the
   * promoted actors overwrite the entries they claim. That both removes the
   * duplicate and keeps the array packed with no second compaction pass.
   */
  private gather(
    peds: PedestrianField | null,
    field: { actors: Iterable<NpcActor> },
    tick: number,
    x: number,
    z: number,
  ): void {
    let n = 0;
    const r2 = CHARACTER_DRAW_RADIUS * CHARACTER_DRAW_RADIUS;

    if (peds) {
      forEachCharacterNear(peds, x, z, CHARACTER_DRAW_RADIUS, tick, this.bands, this.pose, (p) => {
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
        this.vSpeed[n] = 0;
        n++;
      });
    }
    this.ambient = n;

    let actors = 0;
    this.lockedKeys.clear();
    for (const held of this.inherited.values()) if (held.key >= 0) this.lockedKeys.add(held.key);
    this.liveIds.clear();
    for (const a of field.actors) {
      if (!isCharacterKind(a.kind)) continue;
      this.liveIds.add(a.id);
      const dx = a.x - x;
      const dz = a.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;

      let mine = this.inherited.get(a.id);
      let claim = -1;

      // --- The held claim, by key rather than by distance. `CLAIM_SNAP`'s
      // header is the whole of why: distance stopped being an identity the
      // moment an eshay group stood together.
      if (mine !== undefined && mine.key >= 0) {
        for (let i = 0; i < this.ambient; i++) {
          if (this.vKey[i] !== mine.key) continue;
          claim = i;
          break;
        }
        if (claim >= 0) {
          const ax = this.vX[claim] - a.x;
          const az = this.vZ[claim] - a.z;
          if (ax * ax + az * az > CLAIM_RADIUS_2) {
            this.lockedKeys.delete(mine.key);
            mine.key = -1;
            claim = -1;
          }
        }
      }

      // --- A first claim, or a re-claim by an actor that walked back to its
      // post. Only what it is literally standing on, and never somebody else's.
      if (claim < 0 && (mine === undefined || mine.key < 0)) {
        let best2 = CLAIM_SNAP_2;
        for (let i = 0; i < this.ambient; i++) {
          if (this.vKind[i] !== a.kind) continue;
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
        mine = claim >= 0 ? { look: this.vLook[claim], key: this.vKey[claim] } : { look: carHash(a.id, 0x4a17), key: -1 };
        this.inherited.set(a.id, mine);
      } else if (mine.key < 0 && claim >= 0) {
        mine.key = this.vKey[claim];
      }

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
      // The gait comes from the state, never from a measured speed: a promoted
      // actor's position arrives interpolated between two snapshots and
      // differencing it per frame reports a walk as a sprint on a slow frame.
      // `RemotePlayer.speed` and `StreetCrowd.gather` both document the trap.
      this.vSpeed[at] =
        a.state === NPC_STATE.CHASE
          ? a.kind === NPC_KIND.ESHAY
            ? ESHAY_CHASE_SPEED
            : 3
          : a.state === NPC_STATE.RETURN || a.state === NPC_STATE.WALK
            ? 1.3
            : 0;
      actors++;
    }
    this.actors = actors;
    this.visible = n;

    // Forget the look of anybody who has resolved. The live set is the one
    // collected **during** the pass above rather than a second walk of
    // `field.actors`, which is `StreetCrowd.gather`'s hard-won correctness fix:
    // online that iterable is a `Map` iterator the pass has already exhausted,
    // so re-iterating it yields nothing and the whole table gets dropped.
    if (this.inherited.size > 64) {
      for (const id of [...this.inherited.keys()]) if (!this.liveIds.has(id)) this.inherited.delete(id);
    }
  }

  /**
   * Hand the nearest people a rig, keeping the ones already assigned.
   *
   * `StreetCrowd.assign`'s two passes and no sort: the first keeps every slot
   * whose person is still in view, which is the hysteresis that stops a rig
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

      // The kit, swapped by reference and only when it changes. A pooled rig is
      // reassigned between kinds as people come and go; `PedestrianCrowd` makes
      // the same swap for the same reason.
      const kits = this.assets.kits.get(kind) ?? this.assets.kits.get(NPC_KIND.KAREN)!;
      const kit = kits[Math.floor(look / 8) % kits.length];
      if (slot.kit !== kit) {
        slot.kit = kit;
        slot.actor.mesh.geometry = kit;
      }

      slot.actor.mesh.visible = true;
      const p = slot.props;
      p.cap.visible = kind === NPC_KIND.ESHAY;
      p.bumbag.visible = kind === NPC_KIND.ESHAY;
      p.shades.visible = kind === NPC_KIND.KAREN || kind === NPC_KIND.INFLUENCER;
      p.cup.visible = kind === NPC_KIND.KAREN;
      p.hardhat.visible = kind === NPC_KIND.TRADIE;
      p.vest.visible = kind === NPC_KIND.TRADIE;
      p.phone.visible = kind === NPC_KIND.INFLUENCER;
      p.clipboard.visible = kind === NPC_KIND.AGENT;
      if (kind === NPC_KIND.TRADIE) {
        const vest = this.assets.vests[(look >>> 1) % this.assets.vests.length];
        if (p.vest.geometry !== vest) p.vest.geometry = vest;
      }

      const state = this.vState[i];
      const down = state === NPC_STATE.DOWN;
      if (down !== slot.down) {
        slot.down = down;
        slot.actor.setAction(down ? 'knockout' : null);
      }
      slot.actor.update(dt, {
        position: { x: this.vX[i], y: this.vY[i], z: this.vZ[i] },
        // Yaw 0 faces -Z, so the yaw that sends the figure's forward to (dx, dz)
        // is `atan2(-dx, -dz)`. One `atan2` per drawn person per frame, entirely
        // on the presentation side -- `game/factions.ts`'s determinism rule
        // permits exactly this and nothing downstream of it decides anything.
        yaw: Math.atan2(-this.vDx[i], -this.vDz[i]),
        speed: down ? 0 : this.vSpeed[i],
        onGround: true,
      });

      // --- The overlays, **after** `update`, because that is what writes the
      // bones. Two of the five have one, and both are two bone rotations rather
      // than a clip: `player/animation.ts` has four locomotions and five
      // reactions and every one of them is written for a player, so "holding a
      // phone up" would be a sixth reaction in a file this faction does not own.
      if (!down && kind === NPC_KIND.INFLUENCER) this.raisePhone(slot);
      if (!down && kind === NPC_KIND.KAREN) this.holdCup(slot, now);
    }
  }

  /**
   * The phone, up and pointed forward.
   *
   * The upper arm comes forward and in, the forearm folds up, and the wrist
   * turns the screen outward. Eyeballed against the rig rather than derived, on
   * `StreetCrowd.swig`'s own terms: `RIG` puts the shoulder at 1.14 m with a
   * 0.33 m upper arm and a 0.31 m forearm, and these three numbers land the mitt
   * at about chin height and 0.3 m forward, which is where a person holds a
   * phone they are filming with.
   *
   * Held **constantly** rather than on a cycle, unlike the drunk's swig, and
   * that is the character: she is always filming. A cycle would have made her a
   * person who occasionally checks her phone, which is everybody.
   */
  private raisePhone(slot: Slot): void {
    const bones = slot.actor.bones;
    bones[BONE.SHOULDER_R].rotation.x -= 0.95;
    bones[BONE.SHOULDER_R].rotation.z -= 0.2;
    bones[BONE.ELBOW_R].rotation.x -= 1.35;
  }

  /**
   * The cup, up at the chest, and a slow sip now and then.
   *
   * The arm is folded to about waist-to-chest height always -- somebody holding
   * a takeaway coffee does not let it hang -- and the sip is a small extra fold
   * on a period nobody will consciously notice. Ten seconds, because a coffee
   * lasts and a longneck's eleven-second swig cycle would make her look thirsty.
   */
  private holdCup(slot: Slot, now: number): void {
    const bones = slot.actor.bones;
    // A triangle, not a sine: `game/streetlife.ts` rule 5 is about shared paths
    // and this is not one, but a second kind of wave in the same build for no
    // reason would be a second thing to reason about.
    const u = (now / 10) % 1;
    const tri = u < 0.5 ? u * 2 : 2 - u * 2;
    const sip = tri > 0.82 ? (tri - 0.82) / 0.18 : 0;
    bones[BONE.SHOULDER_R].rotation.x -= 0.42 + 0.22 * sip;
    bones[BONE.ELBOW_R].rotation.x -= 1.5 + 0.35 * sip;
    bones[BONE.HEAD].rotation.x -= 0.16 * sip;
  }

  /**
   * Queue whatever the nearest character is saying, at most one line at a time.
   *
   * `characters.lineFor` is a pure function of the person and the tick, so this
   * is a *read* rather than a decision -- see that file's section 4. What this
   * adds is the two things a pure function cannot have: a range, so somebody
   * eighty metres away does not talk to you, and a memory, so one line is posted
   * once rather than on every frame of its two-second window.
   *
   * Nearest only. Four Karens on a strip all saying something at once would be a
   * notice bar rather than a street.
   */
  private speak(now: number): void {
    let best = -1;
    let best2 = SPEAK_RANGE * SPEAK_RANGE;
    for (let i = 0; i < this.visible; i++) {
      // **Nobody on the ground says anything**, and this is not a nicety -- it
      // is the fix for the one place this feature's own two halves fought each
      // other. `main.accuse` posts the Karen's "I'm calling the police" on the
      // frame she reports a crime, and the crowd update runs *after* the fixed
      // step in that frame; so a Karen who had just been knocked down by the
      // very crime she was reporting would overwrite her own report line with a
      // piece of ambient chatter, in the same frame, every time. Measured on a
      // footpath in St Peters: the banner opened, the report fired, and the
      // notice bar read "I've got all this on video".
      //
      // It is also simply correct. A person lying on a footpath is not making
      // conversation.
      if (this.vState[i] === NPC_STATE.DOWN) continue;
      if (this.vDist2[i] >= best2) continue;
      best2 = this.vDist2[i];
      best = i;
    }
    if (best < 0) return;
    const key = this.vKey[best];
    const text = lineFor(this.vKind[best], key < 0 ? -key : key, now);
    if (text === null) return;
    // One post per window. The window is two seconds and the cycle twenty-two,
    // so keying on the cycle index is exact: `floor(now / 22)` changes once per
    // line and never inside one.
    const cycle = Math.floor(now / 22);
    if (this.spokeAt.get(key) === cycle) return;
    this.spokeAt.set(key, cycle);
    if (this.spokeAt.size > 128) this.spokeAt.clear();
    this.lines.push({ text, x: this.vX[best], z: this.vZ[best], kind: this.vKind[best] });
  }

  /**
   * Release the rigs. **Not the shared geometry or the material**, which are
   * `CharacterKitAssets`' and are drawn by every character in the city -- the
   * trap `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const slot of this.slots) {
      slot.props.dispose();
      slot.actor.mesh.removeFromParent();
    }
  }
}

/**
 * How close you have to be to hear somebody, metres.
 *
 * Fourteen. Far enough that you get the line as you walk up to a group rather
 * than after you are inside it, close enough that it is unambiguous who said it
 * -- there is no speech bubble and no name on the notice, so the only thing
 * identifying the speaker is that they are the person in front of you.
 */
const SPEAK_RANGE = 14;

// --- The self-check ------------------------------------------------------------------------

/**
 * The look, checked for the ways it fails without throwing.
 *
 * Every one of them is invisible from the camera a developer is sitting in,
 * which is this project's whole criterion, and three of them are failures
 * `verifyStreetlifeKit` and `verifyPoliceKit` have already actually caught in
 * this codebase:
 *
 *   - **A prop inside the head.** `BONE.HEAD`'s origin is at the *base* of the
 *     skull, so a hat at a plausible 0.2 is dead centre inside it and invisible
 *     from every angle. It looks like the prop was never parented.
 *   - **A prop wound inside out** is a hard hat you can see the skull through
 *     from in front and not from behind, which from a single frame reads as a
 *     z-fighting artefact rather than as a backwards triangle.
 *   - **Two kinds sharing a kit** is five characters that are three, and it
 *     survives review because every one of them still looks like a person.
 *   - **Sunglasses over the eyes** rather than on the crown is the joke not
 *     landing, and there is no error for a joke not landing except this one.
 */
export function verifyCharacterKit(assets: CharacterKitAssets): string[] {
  const failures: string[] = [];

  // --- Every kind has a kit, and no two kinds share one.
  const seen = new Map<string, number>();
  for (const kind of [NPC_KIND.ESHAY, NPC_KIND.KAREN, NPC_KIND.TRADIE, NPC_KIND.INFLUENCER, NPC_KIND.AGENT]) {
    const kits = assets.kits.get(kind);
    if (!kits || kits.length === 0) {
      failures.push(`Kind ${kind} has no kit geometry, so it would be drawn in whatever the last rig wore.`);
      continue;
    }
    for (const g of kits) {
      const name = g.name;
      const twin = seen.get(name);
      if (twin !== undefined && twin !== kind) {
        failures.push(`Kinds ${twin} and ${kind} both wear "${name}"; two of the five are the same character.`);
      }
      seen.set(name, kind);
    }
  }
  // And the colourways themselves are distinct. A kit list whose two entries are
  // the same colours is a variant that does nothing.
  for (const [name, list] of [
    ['eshay', ESHAY_KITS], ['karen', KAREN_KITS], ['tradie', TRADIE_KITS],
    ['influencer', INFLUENCER_KITS], ['agent', AGENT_KITS],
  ] as Array<[string, readonly Colourway[]]>) {
    if (list.length < 2) {
      failures.push(`The ${name} has ${list.length} kit; a strip of them would be a uniform.`);
    }
    const tops = new Set(list.map((k) => k.singlet.join(',')));
    if (tops.size !== list.length) failures.push(`Two ${name} kits share a top colour, so the variant is invisible.`);
  }

  // --- The head props clear the skull. `HEAD_CENTRE` is 1.445 with a 0.25
  // vertical radius, and the head bone is at 1.25, so in the bone's frame the
  // skull's top is at 0.445 and its widest point at 0.195. Anything meant to be
  // *on* a head has to have geometry above the widest point.
  for (const [name, g] of [['cap', assets.cap], ['hard hat', assets.hardhat], ['shades', assets.shades]] as Array<
    [string, BufferGeometry]
  >) {
    const pos = g.getAttribute('position');
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    if (maxY < 0.24) {
      failures.push(
        `The ${name} tops out at y = ${maxY.toFixed(3)} in the head bone's frame, which is inside the skull ` +
          '(its widest point is at 0.195 and its crown at 0.445). It would be invisible from every angle.',
      );
    }
    if (minY > 0.5) failures.push(`The ${name} floats above the head entirely, starting at ${minY.toFixed(3)}.`);
  }
  // The shades specifically: on the crown, not over the eyes. The eyes are at
  // about 0.19 in this frame; anything at or below that is worn rather than
  // pushed up, and the whole joke is that they are pushed up.
  {
    const pos = assets.shades.getAttribute('position');
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
    if (minY < 0.3) {
      failures.push(
        `The sunglasses reach down to y = ${minY.toFixed(3)}, which is over the eyes rather than on the crown. ` +
          'Sunglasses on the head are the entire characterisation; sunglasses on the face are sunglasses.',
      );
    }
  }

  // --- Winding. A prop whose triangles face inward is a hole in the world.
  //
  // Tested as `world/police.ts` tests it: for a closed-ish prop, the signed
  // volume of the triangle fan from the origin is positive when the winding is
  // outward. The two flat props -- the phone and the clipboard -- are excluded
  // because they are slabs and a slab's signed volume about a point inside it is
  // meaningless.
  for (const [name, g] of [
    ['cap', assets.cap], ['hard hat', assets.hardhat], ['cup', assets.cup], ['bumbag', assets.bumbag],
    ['vest', assets.vests[0]],
  ] as Array<[string, BufferGeometry]>) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    if (!idx) {
      failures.push(`The ${name} has no index buffer.`);
      continue;
    }
    // The centroid, so the volume test is about a point that is genuinely
    // inside rather than about the bone's origin -- a hat's origin is at the
    // base of the skull, well outside the hat.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < pos.count; i++) {
      cx += pos.getX(i);
      cy += pos.getY(i);
      cz += pos.getZ(i);
    }
    cx /= pos.count;
    cy /= pos.count;
    cz /= pos.count;
    let volume = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t);
      const b = idx.getX(t + 1);
      const c = idx.getX(t + 2);
      const ax = pos.getX(a) - cx, ay = pos.getY(a) - cy, az = pos.getZ(a) - cz;
      const bx = pos.getX(b) - cx, by = pos.getY(b) - cy, bz = pos.getZ(b) - cz;
      const gx = pos.getX(c) - cx, gy = pos.getY(c) - cy, gz = pos.getZ(c) - cz;
      volume += ax * (by * gz - bz * gy) - ay * (bx * gz - bz * gx) + az * (bx * gy - by * gx);
    }
    if (volume <= 0) {
      failures.push(
        `The ${name} has a signed volume of ${volume.toFixed(4)}, so its triangles are wound inward. ` +
          'From in front you would see through it and from behind it would be solid.',
      );
    }
  }

  // --- The wrist props are on the right side of the wrist. The mitt is about
  // 40 mm below the wrist joint, so a prop entirely above +0.1 is being held
  // above the hand rather than in it -- except the phone, which is deliberately
  // held forward of and above the mitt.
  {
    const pos = assets.cup.getAttribute('position');
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
    if (minY > 0) failures.push(`The cup's base is at ${minY.toFixed(3)} in the wrist frame; it is floating above the hand.`);
  }

  if (assets.triangles > 900) {
    failures.push(`The prop set is ${assets.triangles} triangles; twelve rigs of it would be a budget rather than a hat.`);
  }

  return failures;
}

/**
 * The prop geometries, for the warm-up pass.
 *
 * `world/streetlife.streetlifeWarmupParts`' contract: a material and a geometry
 * compiled at boot rather than on the frame somebody first walks past a station.
 * WebGPU pipeline compilation is tens of milliseconds and it lands as a stall on
 * exactly the frame the thing appears, which is the frame it is most visible.
 */
export function characterWarmupParts(assets: CharacterKitAssets): WarmupPart[] {
  const parts: WarmupPart[] = [];
  for (const g of [assets.cap, assets.bumbag, assets.shades, assets.cup, assets.hardhat, assets.vests[0], assets.phone, assets.clipboard]) {
    parts.push({ geometry: g, material: assets.material });
  }
  return parts;
}
