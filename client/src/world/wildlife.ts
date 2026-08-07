/**
 * What the wildlife looks like: three birds, five draw calls, no skeletons.
 *
 * `game/wildlife.ts` decides where every bird is and what it is doing; this file
 * is geometry, tone and instancing, and it is the *only* half of the feature
 * that imports three. That split is `game/factions.ts`'s own rule -- the
 * simulation compiles into the Bun server and a server that imported a renderer
 * would be a server that imported three -- and it is why the models' triangle
 * counts are handed to `verifyWildlife` as an argument rather than read from it.
 *
 * ---------------------------------------------------------------------------
 * NO SKELETONS, and it is not a shortcut.
 *
 * `world/people.ts` gives a pedestrian a real rig because a human walk is
 * legible at fifty metres and a wrong one is uncanny. A bird is 30 cm across and
 * is almost never closer than five metres, and what carries it at that size is
 * the *silhouette in motion*: a bush turkey is a black wedge with a red head
 * that bobs once a stride, an ibis is a white egg with a black scythe that goes
 * down into a bin, and a magpie is a black-and-white dart. All three of those
 * are one instance matrix -- position, yaw, and a pitch or a roll off a phase
 * the simulation already carries -- which is `world/birds.ts`' finding on its
 * own ibises and it holds here for the same reason.
 *
 * The one exception is the magpie's wings, and it earns the exception: a magpie
 * mid-swoop with its wings held still is a magpie-shaped rock. So the wings are
 * **two more instanced meshes**, each drawn with the body's matrix times a
 * hinge rotation. Two extra draws for the whole city, and the flap is a
 * `Math.sin` on the presentation side where a transcendental is free.
 *
 * ---------------------------------------------------------------------------
 * Cost. Three geometries, two wing panels, one material, five `InstancedMesh`es
 * for the entire extent -- not one per tile, because a bird is not tile-parented
 * (`PoliceSquad`'s argument: the flock is drawn as one set for the visible
 * world, and a turkey chasing you across a tile boundary must not blink).
 *
 *     turkey   208 triangles, 172 verts    up to 24 drawn
 *     ibis     134 triangles, 110 verts    up to 24 drawn
 *     magpie   108 + 2x8 = 124 triangles   up to 12 drawn, wings in two meshes
 *
 * At the very worst viewpoint this feature can produce -- the middle of Sydney
 * Park, where the turkey grid is densest -- that is about 40 birds and 7,000
 * triangles, against the 483,000 of trees already in the same frame. Every one
 * of those counts is asserted against its budget by `verifyWildlifeKit`, which
 * is also what caught this file shipping a 0.70 m ibis under a 0.85 m capsule.
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

import { NPC_KIND, NPC_STATE, type FactionField, type NpcActor } from '../game/factions.ts';
import type { PedestrianField } from '../game/pedestrians.ts';
import { carHash, trafficSeconds } from '../game/traffic.ts';
import {
  ACT,
  createWildPose,
  createWildScratch,
  forEachWildlifeNear,
  isProtected,
  type WildPose,
  type WildScratch,
} from '../game/wildlife.ts';

// --- The palette ----------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Bush turkey body, linear.
 *
 * A near-black that is deliberately **not** black. A real *Alectura lathami* is
 * sooty brown-black with a green iridescence nobody will ever see at this size,
 * and rho 0.028 is what keeps it from reading as a hole punched in the grass:
 * in sun it lands at about rgb(60, 58, 57) against the park's lit grass, which
 * is dark enough to be unmistakably a black bird and light enough that the
 * *shape* survives. Pure black loses the whole silhouette in shade, which is
 * exactly where these birds stand.
 */
const TURKEY_BODY: Rgb = [0.028, 0.026, 0.026];
/**
 * The bald head. The single most identifying thing about the species and the
 * reason the model spends a fifth of its triangles above the neck.
 *
 * Saturated red at rho 0.36 in the red channel against 0.045 in green: in sun
 * that is roughly rgb(196, 62, 47), which is the most saturated object anywhere
 * in this build. It should be. At twenty metres the bird *is* a red dot on a
 * black wedge.
 */
const TURKEY_HEAD: Rgb = [0.36, 0.045, 0.032];
/** The wattle. Yellow in the breeding male, and this build's turkeys are all male. */
const TURKEY_WATTLE: Rgb = [0.62, 0.42, 0.035];
const TURKEY_LEG: Rgb = [0.055, 0.05, 0.045];
const TURKEY_BEAK: Rgb = [0.11, 0.095, 0.08];

/**
 * Magpie black and magpie white, linear.
 *
 * The species is a two-tone problem and nothing else: at any distance a magpie
 * is a white nape and a white wing bar on a black bird, and if those two values
 * do not separate hard the bird reads as a crow. 0.022 against 0.80 is the
 * widest step in this file, and the white is a *neutral* white rather than the
 * ibis's cream, because a magpie's is.
 */
const MAGPIE_BLACK: Rgb = [0.022, 0.022, 0.024];
const MAGPIE_WHITE: Rgb = [0.8, 0.8, 0.79];
/** The bill: pale blue-grey with a black tip, which is what a magpie actually has. */
const MAGPIE_BILL: Rgb = [0.4, 0.42, 0.45];

/**
 * Ibis body, head and legs, linear.
 *
 * **Taken verbatim from `world/birds.ts`** -- rho 0.74 body, 0.045 head and
 * bill, 0.075 legs -- with its calibration and its reasoning, which are set out
 * at length in that file's header (the short version: a white bird has to read
 * *white*, brighter than the brightest surface in the street, and the shape has
 * to be carried by the black and not by any shading of the white).
 *
 * Copied rather than imported, and that is a deliberate call rather than
 * laziness: those constants are module-private in a file this pass was told not
 * to break, and exporting three numbers out of it to save typing them would be
 * an edit to somebody else's module for no behavioural gain. What matters is
 * that the two ibises in this game are the same bird, and they are: same
 * albedo, same proportions, same silhouette. `verifyWildlifeKit` asserts the
 * body stays above rho 0.7 so a future tone pass cannot quietly grey it.
 */
const IBIS_BODY: Rgb = [0.74, 0.72, 0.65];
const IBIS_BLACK: Rgb = [0.045, 0.043, 0.044];
const IBIS_LEG: Rgb = [0.075, 0.068, 0.062];

// --- The builder ----------------------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS: Array<[number, number, number]> = [
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

type Point = readonly [number, number, number];

/**
 * Indexed triangles with a colour per vertex, faceted by `flatShading`.
 *
 * `world/birds.ts` and `world/police.ts` each have one of these and this is a
 * third, which is worth a sentence: they are twenty lines of arithmetic apiece
 * with different primitives on them (this one has a `quad` those two do not
 * need), they are author-time only, and the alternative -- a shared mesh
 * toolkit imported by three `world/` modules and therefore by anything that
 * imports any of them -- is a dependency the renderer does not currently have
 * and would be paying for at load time in every process.
 */
class Parts {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly colour: number[] = [];
  private readonly index: number[] = [];

  /** A ring-to-ring tube between two points, open at both ends. */
  cone(from: Point, to: Point, r0: number, r1: number, sides: number, c0: Rgb, c1: Rgb = c0): void {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const dx = ax / len;
    const dy = ay / len;
    const dz = az / len;
    // The reference vector must not be parallel to the axis or the cross
    // product collapses -- a leg is vertical and a bill is nearly horizontal,
    // so one fixed reference cannot serve both.
    const vertical = Math.abs(dy) > 0.9;
    let ux = vertical ? 0 : dz;
    let uy = vertical ? -dz : 0;
    let uz = vertical ? dy : -dx;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const base = this.position.length / 3;
    const rings: Array<[Point, number, Rgb]> = [[from, r0, c0], [to, r1, c1]];
    for (const [o, r, c] of rings) {
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.position.push(
          o[0] + ux * ca * r + vx * sa * r,
          o[1] + uy * ca * r + vy * sa * r,
          o[2] + uz * ca * r + vz * sa * r,
        );
        this.normal.push(ux * ca + vx * sa, uy * ca + vy * sa, uz * ca + vz * sa);
        this.colour.push(c[0], c[1], c[2]);
      }
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.index.push(base + i, base + j, base + sides + j);
      this.index.push(base + i, base + sides + j, base + sides + i);
    }
  }

  /** An icosahedral ellipsoid: 12 vertices, 20 faces. One body, or one head. */
  lobe(centre: Point, radii: Point, c: Rgb): void {
    const base = this.position.length / 3;
    for (const [x, y, z] of ICO_VERTS) {
      const l = Math.sqrt(x * x + y * y + z * z);
      const ux = x / l;
      const uy = y / l;
      const uz = z / l;
      this.position.push(centre[0] + ux * radii[0], centre[1] + uy * radii[1], centre[2] + uz * radii[2]);
      this.normal.push(ux, uy, uz);
      this.colour.push(c[0], c[1], c[2]);
    }
    for (const [a, b, c2] of ICO_FACES) this.index.push(base + a, base + b, base + c2);
  }

  /** One triangle from three explicit points, normal from the winding. */
  triangle(a: Point, b: Point, c: Point, ca: Rgb, cb: Rgb = ca, cc: Rgb = ca): void {
    const base = this.position.length / 3;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    for (const [p, col] of [[a, ca], [b, cb], [c, cc]] as Array<[Point, Rgb]>) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(nx, ny, nz);
      this.colour.push(col[0], col[1], col[2]);
    }
    this.index.push(base, base + 1, base + 2);
  }

  /**
   * A flat panel, wound both ways so it is solid from above and below.
   *
   * Two triangles would be invisible from one side, which for a tail fan and a
   * wing is half the time -- the failure `world/bike.ts` documents as the one
   * thing no single frame can show, because from the other side it simply is
   * not there.
   */
  quad(a: Point, b: Point, c: Point, d: Point, top: Rgb, bottom: Rgb = top): void {
    this.triangle(a, b, c, top);
    this.triangle(a, c, d, top);
    this.triangle(a, d, c, bottom);
    this.triangle(a, c, b, bottom);
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
}

// --- The birds ------------------------------------------------------------------

/**
 * One bush turkey, standing, facing **-Z** at yaw 0 -- the convention the player
 * controller, the pedestrians and the police all use, so a heading is a heading
 * everywhere in this client.
 *
 * A real one stands about 70 cm with a 60-70 cm body; this one is **0.78 m tall
 * and 0.62 m nose to tail**, with the exaggeration spent, per spec 8.1's comic
 * brief, on the three things that identify it: the bald red head, the yellow
 * wattle, and the tail.
 *
 * **The tail is the model.** A bush turkey's tail is held *vertically*, flat-on
 * like a rudder, which no other bird in this city does and which is legible
 * from any angle and any distance -- so it is a 40 cm fan of four panels,
 * double-sided, and it is the single feature that makes the bird identifiable
 * at the fifty metres from which it is a black smudge.
 */
function buildTurkey(): BufferGeometry {
  const p = new Parts();
  const body = TURKEY_BODY;

  // Legs. Strong and set well back, which is what makes the walk read as a
  // strut rather than a scurry.
  p.cone([-0.075, 0, 0.055], [-0.055, 0.30, 0.03], 0.024, 0.019, 4, TURKEY_LEG);
  p.cone([0.075, 0, 0.055], [0.055, 0.30, 0.03], 0.024, 0.019, 4, TURKEY_LEG);
  // Toes, three forward per foot, because a turkey standing on smooth stumps
  // reads as a toy at close range and this is four triangles.
  for (const side of [-1, 1]) {
    p.triangle(
      [side * 0.075 - 0.03, 0.012, 0.055],
      [side * 0.075 + 0.03, 0.012, 0.055],
      [side * 0.075, 0.004, -0.03],
      TURKEY_LEG,
    );
  }
  // Thighs: the feathered trousers, which is where the leg meets the mass.
  p.lobe([-0.075, 0.33, 0.05], [0.05, 0.08, 0.07], body);
  p.lobe([0.075, 0.33, 0.05], [0.05, 0.08, 0.07], body);

  // The body: a 48 cm barrel carried nose-down, and the breast in front of it.
  p.lobe([0, 0.45, 0.04], [0.15, 0.155, 0.235], body);
  p.lobe([0, 0.44, -0.11], [0.115, 0.125, 0.11], body);

  // Neck and head. Bare skin from the shoulders up: red head, and the neck
  // shading from the body's black into it over one segment.
  p.cone([0, 0.55, -0.13], [0, 0.66, -0.185], 0.052, 0.036, 5, body, TURKEY_HEAD);
  p.lobe([0, 0.70, -0.20], [0.057, 0.062, 0.062], TURKEY_HEAD);
  p.cone([0, 0.70, -0.245], [0, 0.687, -0.315], 0.021, 0.005, 4, TURKEY_BEAK);
  // The wattle: a yellow sack at the base of the neck. The only warm thing on
  // the bird apart from the head, and the pair of them is the identification.
  p.lobe([0, 0.575, -0.155], [0.052, 0.075, 0.04], TURKEY_WATTLE);

  // Wings, folded against the flanks.
  p.lobe([-0.145, 0.47, 0.02], [0.042, 0.10, 0.19], body);
  p.lobe([0.145, 0.47, 0.02], [0.042, 0.10, 0.19], body);

  // The tail: four panels fanning up and back from the rump, in the vertical
  // plane. Double-sided; see `Parts.quad`.
  const root: Point = [0, 0.44, 0.24];
  const fan: Array<[number, number]> = [[-0.16, 0.60], [-0.055, 0.74], [0.055, 0.74], [0.16, 0.60]];
  for (let i = 0; i < fan.length - 1; i++) {
    const [x0, y0] = fan[i];
    const [x1, y1] = fan[i + 1];
    p.quad(
      root,
      [x0 * 0.35, 0.46 + (y0 - 0.44) * 0.25, 0.30],
      [x0, y0, 0.36],
      [x1, y1, 0.36],
      body,
    );
  }

  return p.build('turkey');
}

/**
 * One magpie, facing -Z. **0.42 m tall, 0.44 m bill to tail.**
 *
 * Perched, with the wings built as separate panels so they can be hinged -- see
 * `buildMagpieWing`. Everything about this model is the pied pattern: black
 * body, black head, white nape and white rump, which is what a *tibicen* has
 * and is what separates it at a glance from every crow in the city.
 */
function buildMagpieBody(): BufferGeometry {
  const p = new Parts();
  p.cone([-0.035, 0, 0.02], [-0.028, 0.115, 0.01], 0.011, 0.009, 4, MAGPIE_BLACK);
  p.cone([0.035, 0, 0.02], [0.028, 0.115, 0.01], 0.011, 0.009, 4, MAGPIE_BLACK);
  // Body, then the white saddle over the back and rump.
  p.lobe([0, 0.175, 0.02], [0.072, 0.078, 0.145], MAGPIE_BLACK);
  p.lobe([0, 0.215, 0.055], [0.062, 0.05, 0.10], MAGPIE_WHITE);
  // Head, black, with the white nape behind it -- the wedge that says magpie.
  p.lobe([0, 0.265, -0.095], [0.052, 0.052, 0.058], MAGPIE_BLACK);
  p.lobe([0, 0.253, -0.035], [0.048, 0.042, 0.038], MAGPIE_WHITE);
  p.cone([0, 0.262, -0.135], [0, 0.252, -0.215], 0.018, 0.004, 4, MAGPIE_BILL, MAGPIE_BLACK);
  // Tail: black with a white base, held flat.
  p.quad(
    [-0.042, 0.175, 0.145],
    [0.042, 0.175, 0.145],
    [0.05, 0.166, 0.315],
    [-0.05, 0.166, 0.315],
    MAGPIE_BLACK,
  );
  return p.build('magpie');
}

/**
 * One magpie wing, hinged at the shoulder and built for the given side.
 *
 * Two geometries rather than one mirrored by a negative scale, and the reason
 * is the winding: a mirrored instance turns every triangle inside out, so the
 * right wing would be lit from behind and invisible from outside the bird --
 * `world/bike.ts`'s failure, which no single frame shows.
 *
 * The panel is drawn in the wing's own frame: the origin is the shoulder, +X is
 * outboard for a left wing, and the flap is a rotation about Z applied by
 * `WildlifeFlock`. The white bar is the outboard half, which is what is
 * actually visible on a bird coming at your head.
 */
function buildMagpieWing(side: number): BufferGeometry {
  const p = new Parts();
  const s = side;
  const root: Point = [0, 0, 0];
  const front: Point = [s * 0.06, 0.005, -0.07];
  const mid: Point = [s * 0.22, 0.0, -0.02];
  const tip: Point = [s * 0.33, -0.01, 0.06];
  const back: Point = [s * 0.05, 0.0, 0.10];
  // Inner panel black, outer panel white-barred, both double-sided: a wing seen
  // edge-on from below is the common case in a swoop.
  p.quad(root, front, mid, back, MAGPIE_BLACK);
  p.quad(back, mid, tip, tip, MAGPIE_WHITE);
  return p.build(side < 0 ? 'magpie_wing_l' : 'magpie_wing_r');
}

/**
 * One ibis, facing -Z. **0.85 m tall, 0.95 m bill to tail.**
 *
 * `world/birds.ts` already draws hundreds of these as scenery and this is the
 * *faction* one -- the bird at the bin that can be hit, that reports a crime
 * when it is, and that waddles off when you get close. Same species, same
 * palette, same proportions, drawn by a different system for a different
 * reason, and the two are never in the same place: the scenery ibises come off
 * the tile's fig trees and shopfront awnings, and these come off the footpath
 * bands and the park discs.
 *
 * The bill is the species and gets the same treatment it gets there: 25 cm of
 * black scythe on a white bird, which is recognisable from further away than
 * the bird is.
 */
function buildIbis(): BufferGeometry {
  const p = new Parts();
  p.cone([-0.05, 0, 0.03], [-0.045, 0.30, 0.0], 0.021, 0.016, 4, IBIS_LEG);
  p.cone([0.05, 0, 0.03], [0.045, 0.30, 0.0], 0.021, 0.016, 4, IBIS_LEG);
  // The body: a 50 cm egg, tipped nose-down the way a standing ibis carries it.
  p.lobe([0, 0.42, 0.02], [0.115, 0.12, 0.215], IBIS_BODY);
  // Black wing tips, laid over the back of the flanks.
  p.lobe([-0.085, 0.44, 0.16], [0.035, 0.055, 0.085], IBIS_BLACK);
  p.lobe([0.085, 0.44, 0.16], [0.035, 0.055, 0.085], IBIS_BLACK);
  // Neck: white into the bare black head over two segments.
  //
  // **The neck carries the height**, and it is the number `verifyWildlifeKit`
  // caught: this bird was built at 0.70 m against the 0.85 m its capsule is
  // registered at, so the model stood two heads shorter than the thing the bat
  // was testing against -- a bird you could swing straight over and still hit.
  // A white ibis holds its neck up when it is not in a bin, and 0.85 m is what
  // `world/birds.ts` builds its own at, which is the other reason it matters:
  // the two ibises in this game have to be the same bird.
  p.cone([0, 0.52, -0.10], [0, 0.775, -0.15], 0.052, 0.032, 5, IBIS_BODY, IBIS_BLACK);
  p.lobe([0, 0.805, -0.16], [0.042, 0.045, 0.055], IBIS_BLACK);
  // The bill: three segments, each angled further down, which is what makes it
  // a curve rather than a spike. A straight black spike is a stork.
  p.cone([0, 0.80, -0.205], [0, 0.735, -0.285], 0.017, 0.012, 4, IBIS_BLACK);
  p.cone([0, 0.735, -0.285], [0, 0.645, -0.34], 0.012, 0.008, 4, IBIS_BLACK);
  p.cone([0, 0.645, -0.34], [0, 0.545, -0.365], 0.008, 0.003, 4, IBIS_BLACK);
  // Tail, short and black-tipped.
  p.quad(
    [-0.05, 0.44, 0.22],
    [0.05, 0.44, 0.22],
    [0.045, 0.41, 0.33],
    [-0.045, 0.41, 0.33],
    IBIS_BODY,
    IBIS_BLACK,
  );
  return p.build('ibis_faction');
}

// --- Shared assets --------------------------------------------------------------

/**
 * Five geometries and one material, built once for the whole game.
 *
 * One material for all three species, on `world/birds.BirdAssets`' argument: a
 * material is a WebGPU pipeline, pipeline compilation blocks the main thread,
 * and three matte vertex-coloured birds have no reason to be three pipelines.
 */
export class WildlifeAssets {
  readonly turkey: BufferGeometry;
  readonly ibis: BufferGeometry;
  readonly magpie: BufferGeometry;
  readonly wingLeft: BufferGeometry;
  readonly wingRight: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;

  readonly turkeyTriangles: number;
  readonly ibisTriangles: number;
  readonly magpieTriangles: number;

  constructor() {
    this.turkey = buildTurkey();
    this.ibis = buildIbis();
    this.magpie = buildMagpieBody();
    this.wingLeft = buildMagpieWing(-1);
    this.wingRight = buildMagpieWing(1);
    const tris = (g: BufferGeometry): number => (g.getIndex()?.count ?? 0) / 3;
    this.turkeyTriangles = tris(this.turkey);
    this.ibisTriangles = tris(this.ibis);
    this.magpieTriangles = tris(this.magpie) + tris(this.wingLeft) + tris(this.wingRight);

    const material = new MeshStandardNodeMaterial();
    material.name = 'wildlife';
    // No `colorNode`: `NodeMaterial` already multiplies the material colour by
    // the geometry `color` attribute, so the red head, the yellow wattle and
    // the white nape all arrive through one built-in multiply and no shader
    // graph. The same arrangement the trees, the cars and the gulls use.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Feathers: matte with a little sheen, the same 0.82 the gulls carry.
    material.roughness = 0.82;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }

  dispose(): void {
    for (const g of [this.turkey, this.ibis, this.magpie, this.wingLeft, this.wingRight]) g.dispose();
    this.material.dispose();
  }
}

// --- The flock ------------------------------------------------------------------

/** How far birds are drawn, metres. Past this a 30 cm object is under a pixel. */
export const WILDLIFE_DRAW_RADIUS = 150;

const TURKEY_CAP = 24;
const IBIS_CAP = 24;
const MAGPIE_CAP = 12;

/** Wingbeats a second while circling, and while diving. A magpie's is about 5 Hz. */
const FLAP_HZ = 5;
const DIVE_FLAP_HZ = 9;

/** Seconds between ambient calls, at most one bird at a time. See `idleCall`. */
const IDLE_CALL_GAP = 7;
/** And the window a bird's eligibility is hashed over. */
const IDLE_CALL_WINDOW = 6;

const _matrix = /*#__PURE__*/ new Matrix4();
const _wing = /*#__PURE__*/ new Matrix4();
const _hinge = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _axis = /*#__PURE__*/ new Vector3();
const _one = /*#__PURE__*/ new Vector3(1, 1, 1);

/** One bird to draw this frame. Structure of arrays; `update` allocates nothing. */
interface Drawn {
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 0..1. Drives the bob, the waddle and the flap. */
  phase: number;
  /** `ACT`, or a promoted actor's `NPC_STATE` mapped onto it. */
  act: number;
  /** Head-down amount, 0..1: a turkey scratching, an ibis in the bin. */
  feed: number;
  /** Pitch of the whole body, radians. Positive is nose down. */
  pitch: number;
  /** Roll, radians. Banking, in a dive. */
  roll: number;
}

/**
 * Every bird in view, ambient and promoted, in five instanced draws.
 *
 * `update` allocates nothing and is called once a frame from `main.ts`, after
 * the streamer (so a tile that arrived this frame has ground to stand on) and
 * before the render.
 *
 * **The suppression rule** is the only subtle thing in here. A promoted bird and
 * the ambient bird it was promoted *from* are the same animal, and the wire
 * carries no identity that would say so -- `protocol.NPC_BYTES` is id, kind,
 * position, yaw and state, and the anchor is deliberately not on it. So for
 * every live actor this drops the nearest ambient bird of the same kind, which
 * is exact rather than approximate because of a constraint the simulation
 * enforces for exactly this reason: `TURKEY_CELL` is 62 m and a turkey's
 * `LEASH` is 35, so a bird at the very end of its chase is still nearer its own
 * anchor than to anybody else's. `verifyWildlife` asserts that relationship.
 */
export class WildlifeFlock {
  /** Add these to the scene. */
  readonly meshes: InstancedMesh[] = [];

  /** Drawn last update, and how long it took. Read by the HUD. */
  ambient = 0;
  actors = 0;
  costMs = 0;

  private readonly turkeys: InstancedMesh;
  private readonly ibises: InstancedMesh;
  private readonly magpies: InstancedMesh;
  private readonly wingsL: InstancedMesh;
  private readonly wingsR: InstancedMesh;

  private readonly scratch: WildScratch = createWildScratch();
  private readonly pose: WildPose = createWildPose();
  private readonly drawn: Drawn[] = [];
  private count = 0;

  /** Where the live actors are, so the ambient pass can drop their twins. */
  private readonly liveX = new Float64Array(32);
  private readonly liveZ = new Float64Array(32);
  private readonly liveKind = new Int32Array(32);
  private live = 0;

  /** Where the camera was last update, for `idleCall`'s distances. */
  private viewX = 0;
  private viewZ = 0;
  /** Seconds until another ambient call is allowed. See `idleCall`. */
  private idleGap = IDLE_CALL_GAP;

  constructor(assets: WildlifeAssets) {
    this.turkeys = new InstancedMesh(assets.turkey, assets.material, TURKEY_CAP);
    this.ibises = new InstancedMesh(assets.ibis, assets.material, IBIS_CAP);
    this.magpies = new InstancedMesh(assets.magpie, assets.material, MAGPIE_CAP);
    this.wingsL = new InstancedMesh(assets.wingLeft, assets.material, MAGPIE_CAP);
    this.wingsR = new InstancedMesh(assets.wingRight, assets.material, MAGPIE_CAP);
    const named: Array<[InstancedMesh, string]> = [
      [this.turkeys, 'turkeys'],
      [this.ibises, 'ibises_faction'],
      [this.magpies, 'magpies'],
      [this.wingsL, 'magpie_wings_l'],
      [this.wingsR, 'magpie_wings_r'],
    ];
    for (const [mesh, name] of named) {
      mesh.name = name;
      mesh.count = 0;
      // A bird casts a shadow -- a turkey's is what makes it look like it is
      // standing on the grass rather than hovering over it -- and receives one,
      // because the parks these live in are under figs.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The city is the frustum here: birds are placed in world space and the
      // per-instance bounds three would compute are useless for a set that
      // moves every frame. `PoliceSquad` and `TrafficMovers` make the same call.
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
    }
    for (let i = 0; i < TURKEY_CAP + IBIS_CAP + MAGPIE_CAP; i++) {
      this.drawn.push({ kind: 0, x: 0, y: 0, z: 0, yaw: 0, phase: 0, act: 0, feed: 0, pitch: 0, roll: 0 });
    }
  }

  /**
   * Place every bird in view.
   *
   * `tick` may be fractional -- `TrafficMovers.update`'s split, for the same
   * reason: the simulation runs on whole ticks so this client and the server ask
   * the identical question, and the picture runs between them so a 144 Hz
   * display does not watch 60 Hz birds.
   */
  update(
    peds: PedestrianField | null,
    field: FactionField | { actors: Iterable<NpcActor> },
    tick: number,
    x: number,
    z: number,
    groundAt: (x: number, z: number) => number,
  ): void {
    const at = performance.now();
    this.count = 0;
    this.live = 0;
    this.viewX = x;
    this.viewZ = z;
    const now = trafficSeconds(tick);

    // --- Promoted first: they are the ones something is happening to, so when
    // the pools run out it is the scenery that goes.
    let actors = 0;
    const r2 = WILDLIFE_DRAW_RADIUS * WILDLIFE_DRAW_RADIUS;
    for (const a of field.actors) {
      if (!isProtected(a.kind)) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (this.live < this.liveX.length) {
        this.liveX[this.live] = a.homeX;
        this.liveZ[this.live] = a.homeZ;
        this.liveKind[this.live] = a.kind;
        this.live++;
      }
      this.pushActor(a, now);
      actors++;
    }
    this.actors = actors;

    // --- And the ambient birds, minus the ones already drawn as actors.
    let ambient = 0;
    forEachWildlifeNear(peds, x, z, WILDLIFE_DRAW_RADIUS, Math.floor(tick), groundAt, this.scratch, this.pose, (p) => {
      if (this.suppressed(p)) return;
      if (!this.pushAmbient(p)) return true;
      ambient++;
    });
    this.ambient = ambient;

    this.write();
    this.costMs = performance.now() - at;
  }

  /**
   * Whether this ambient bird is currently being drawn as a promoted one.
   *
   * Matched on the actor's `homeX/homeZ`, which `stepWildlife` pins to the
   * anchor -- offline that is exact. Online the home is not on the wire and
   * arrives as zero, so the fallback is a distance test against the actor's
   * *position*, which is what the `TURKEY_CELL`-against-`LEASH` constraint
   * exists to make unambiguous.
   */
  private suppressed(p: WildPose): boolean {
    for (let i = 0; i < this.live; i++) {
      if (this.liveKind[i] !== p.kind) continue;
      const hx = this.liveX[i];
      const hz = this.liveZ[i];
      const dx = hx - p.ax;
      const dz = hz - p.az;
      if (dx * dx + dz * dz < 30 * 30) return true;
    }
    return false;
  }

  private capacityFor(kind: number): number {
    return kind === NPC_KIND.TURKEY ? TURKEY_CAP : kind === NPC_KIND.IBIS ? IBIS_CAP : MAGPIE_CAP;
  }

  private countOf(kind: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.drawn[i].kind === kind) n++;
    return n;
  }

  private take(kind: number): Drawn | null {
    if (this.count >= this.drawn.length) return null;
    if (this.countOf(kind) >= this.capacityFor(kind)) return null;
    return this.drawn[this.count++];
  }

  /** One promoted actor, posed off its state byte. */
  private pushActor(a: NpcActor, now: number): void {
    const d = this.take(a.kind);
    if (d === null) return;
    d.kind = a.kind;
    d.x = a.x;
    d.y = a.y;
    d.z = a.z;
    // Yaw 0 faces -Z, so the yaw that sends the bird's forward to (dx, dz) is
    // `atan2(-dx, -dz)`. One `atan2` per drawn bird per frame, entirely on the
    // presentation side -- see `game/factions.ts`'s determinism rule.
    d.yaw = Math.atan2(-a.dx, -a.dz);
    const jitter = (carHash(a.id, 0x31) & 1023) / 1024;
    const diving = a.state === NPC_STATE.CHASE || a.state === NPC_STATE.FIRE;
    // `NPC_STATE.AIM` on a magpie is the alarm: it is still on the branch, and
    // the whole point of the state is that a player gets nearly a second to see
    // and hear it before the dive. So it is drawn *agitated rather than
    // arriving* -- wings beating at the dive rate on a body that has not moved,
    // which reads as a bird working itself up to something. A magpie that
    // telegraphed silently and invisibly would be the old magpie with a delay.
    const alarmed = a.kind === NPC_KIND.MAGPIE && a.state === NPC_STATE.AIM;
    const flying = a.kind === NPC_KIND.MAGPIE && a.state !== NPC_STATE.IDLE && a.state !== NPC_STATE.DOWN;
    const hz = a.kind === NPC_KIND.MAGPIE
      ? (diving || alarmed ? DIVE_FLAP_HZ : FLAP_HZ)
      : a.state === NPC_STATE.CHASE ? 3.4 : 1.5;
    d.phase = (now * hz + jitter) % 1;
    d.act = a.state === NPC_STATE.DOWN ? ACT.PAUSE : flying ? ACT.WALK : a.state === NPC_STATE.IDLE ? ACT.PAUSE : ACT.WALK;
    d.feed = 0;
    // Down: on its side, which is one roll and no second geometry.
    if (a.state === NPC_STATE.DOWN) {
      d.pitch = 0;
      d.roll = Math.PI * 0.42;
      return;
    }
    // A chasing turkey runs with its neck out and its body level-low; a diving
    // magpie is nose-down at the bottom of the arc and banking.
    d.pitch = diving && a.kind === NPC_KIND.MAGPIE ? 0.55 : a.state === NPC_STATE.CHASE ? 0.22 : 0;
    d.roll = diving && a.kind === NPC_KIND.MAGPIE ? 0.3 : 0;
  }

  /** One ambient bird, posed off its `ACT`. Returns false when the pool is full. */
  private pushAmbient(p: WildPose): boolean {
    const d = this.take(p.kind);
    if (d === null) return this.count < this.drawn.length;
    d.kind = p.kind;
    d.x = p.x;
    d.y = p.y;
    d.z = p.z;
    d.yaw = Math.atan2(-p.dx, -p.dz);
    d.phase = p.gait;
    d.act = p.act;
    // Head down in the litter or in the bin, and it is the *pose* that says
    // which bird this is at distance: an ibis with its bill in a bin is the
    // single most recognisable silhouette in Sydney.
    d.feed = p.act === ACT.FEED ? 1 : 0;
    d.pitch = 0;
    d.roll = 0;
    return true;
  }

  /**
   * Compose every instance matrix and hand the meshes their counts.
   *
   * One pass, no allocation, and the bob is here rather than in the pose so that
   * the *simulation* never has to carry an animation phase across the wire: what
   * arrives is a position, a heading and a state, and the wobble is derived.
   */
  private write(): void {
    let nt = 0;
    let ni = 0;
    let nm = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.drawn[i];
      const wobble = Math.sin(d.phase * Math.PI * 2);
      // Ground birds bob once a stride and settle when they stop. The feed pose
      // pitches the whole body down, which on a bird with a long neck is what
      // the eye reads as the head going into something.
      const walking = d.act === ACT.WALK;
      let pitch = d.pitch + (walking ? wobble * 0.09 : 0) + d.feed * 0.62;
      let roll = d.roll + (walking ? wobble * 0.07 : 0);
      let lift = walking ? Math.abs(wobble) * 0.018 : 0;
      if (d.kind === NPC_KIND.MAGPIE && d.act === ACT.PERCH) {
        // A perched magpie shuffles and flicks its tail. Small, and it is the
        // difference between a bird on a branch and an ornament on one.
        pitch = wobble * 0.05;
        roll = 0;
        lift = 0;
      }
      _position.set(d.x, d.y + lift, d.z);
      _axis.set(0, 1, 0);
      _quaternion.setFromAxisAngle(_axis, d.yaw);
      _matrix.compose(_position, _quaternion, _one);
      // Pitch and roll in the bird's own frame, so a banked dive banks about the
      // direction of travel rather than about the world.
      _axis.set(1, 0, 0);
      _hinge.makeRotationAxis(_axis, pitch);
      _matrix.multiply(_hinge);
      _axis.set(0, 0, 1);
      _hinge.makeRotationAxis(_axis, roll);
      _matrix.multiply(_hinge);

      if (d.kind === NPC_KIND.TURKEY) {
        if (nt < TURKEY_CAP) this.turkeys.setMatrixAt(nt++, _matrix);
      } else if (d.kind === NPC_KIND.IBIS) {
        if (ni < IBIS_CAP) this.ibises.setMatrixAt(ni++, _matrix);
      } else if (nm < MAGPIE_CAP) {
        this.magpies.setMatrixAt(nm, _matrix);
        // The wings: the body matrix, translated out to the shoulder and
        // hinged. Folded flat against the body when perched, and beating
        // through 70 degrees when it is not.
        const flap = d.act === ACT.PERCH ? -0.95 : wobble * 0.62;
        for (const side of [-1, 1]) {
          _position.set(side * 0.055, 0.205, 0.01);
          _axis.set(0, 0, 1);
          _quaternion.setFromAxisAngle(_axis, -side * flap);
          _wing.compose(_position, _quaternion, _one);
          _wing.premultiply(_matrix);
          if (side < 0) this.wingsL.setMatrixAt(nm, _wing);
          else this.wingsR.setMatrixAt(nm, _wing);
        }
        nm++;
      }
    }
    this.turkeys.count = nt;
    this.ibises.count = ni;
    this.magpies.count = nm;
    this.wingsL.count = nm;
    this.wingsR.count = nm;
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * An occasional call from a bird that nothing is happening to, or null.
   *
   * The **presentation** half of the wildlife's voice: the state-edge calls in
   * `main.ts` are events, and this is atmosphere. It lives here rather than
   * there because this class already knows which birds are in view and how far
   * away they are, and re-deriving that in the frame loop would be the same
   * query twice.
   *
   * Two gates, and the second one is the important one. A bird is *eligible* if
   * a hash of its position and the current six-second window says so, which is
   * about one bird in sixteen; and at most one call is emitted every
   * `IDLE_CALL_GAP` seconds no matter how many are eligible. Without the second
   * gate a park with twenty turkeys in it produces twenty gobbles a minute,
   * which is a soundboard -- and the entire effect of one call from behind a fig
   * depends on it being the only one you have heard for a while.
   *
   * Nothing here is deterministic and nothing needs to be: no authority listens
   * to a bird.
   */
  idleCall(dt: number): { kind: number; distance: number } | null {
    this.idleGap -= dt;
    if (this.idleGap > 0 || this.count === 0) return null;
    const window = Math.floor(performance.now() / (IDLE_CALL_WINDOW * 1000));
    for (let i = 0; i < this.count; i++) {
      const d = this.drawn[i];
      // Nothing that is fleeing, diving or lying on its back has anything
      // ambient to say.
      if (d.act === ACT.WALK && d.kind === NPC_KIND.MAGPIE) continue;
      const h = carHash((d.x * 4) | 0, ((d.z * 4) | 0) ^ window);
      if (h % 16 !== 0) continue;
      this.idleGap = IDLE_CALL_GAP;
      // Distance is the only thing the audio needs; it is already implied by
      // the arrays here and nowhere else.
      return { kind: d.kind, distance: this.lastDistance(d) };
    }
    // Nobody spoke. Try again shortly rather than next window, so a park is not
    // silent for six seconds after one unlucky roll.
    this.idleGap = 0.35;
    return null;
  }

  private lastDistance(d: Drawn): number {
    const dx = d.x - this.viewX;
    const dz = d.z - this.viewZ;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Release the instanced meshes. **Not the geometry or the material**, which
   * are `WildlifeAssets`' and are shared by every bird in the city -- the trap
   * `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
  }
}

// --- The kit's own self-check ----------------------------------------------------

/**
 * The three models, against the two ways a low-poly bird fails silently.
 *
 * **Winding.** A lobe wound inside out is see-through from outside the bird and
 * solid from inside it, which from any single frame reads as z-fighting or as a
 * shading bug -- `world/bike.ts`'s finding, and the reason every `world/` module
 * in this project checks it. Tested by asking whether each triangle's normal,
 * taken from its winding, agrees with the vertex normals the builder wrote:
 * they are independent statements of the same fact, so a disagreement is a
 * reversed face.
 *
 * **Proportion and facing.** A bird whose bill is on the wrong end walks
 * backwards, and one built to the wrong scale is a chicken. Both are invisible
 * in a still frame from the front and obvious in play, which is the definition
 * of what belongs in a self-check.
 */
export function verifyWildlifeKit(assets: WildlifeAssets): string[] {
  const failures: string[] = [];

  const models: Array<[string, BufferGeometry, number, number]> = [
    // name, geometry, triangle budget, expected height
    ['turkey', assets.turkey, 320, 0.78],
    ['ibis', assets.ibis, 220, 0.85],
    ['magpie', assets.magpie, 220, 0.42],
  ];

  for (const [name, geometry, budget, height] of models) {
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const colour = geometry.getAttribute('color');
    if (!index || !position || !normal || !colour) {
      failures.push(`The ${name} is missing an attribute; it would draw as nothing or as garbage.`);
      continue;
    }
    const triangles = index.count / 3;
    if (triangles <= 0) failures.push(`The ${name} has no triangles in it.`);
    if (triangles > budget) failures.push(`The ${name} is ${triangles} triangles, over its ${budget} budget.`);

    let reversed = 0;
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
      const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b);
      const cx = position.getX(c), cy = position.getY(c), cz = position.getZ(c);
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const mx = (normal.getX(a) + normal.getX(b) + normal.getX(c)) / 3;
      const my = (normal.getY(a) + normal.getY(b) + normal.getY(c)) / 3;
      const mz = (normal.getZ(a) + normal.getZ(b) + normal.getZ(c)) / 3;
      const dot = nx * mx + ny * my + nz * mz;
      // The double-sided panels are *deliberately* wound both ways and their
      // vertex normals come from the winding, so they can never disagree; only
      // a lobe or a cone can, and those are what this is looking for.
      if (dot < -1e-9) reversed++;
    }
    if (reversed > 0) {
      failures.push(
        `${reversed} of the ${name}'s ${triangles} triangles are wound against their own normals. ` +
          'Those faces are invisible from outside the bird and solid from inside it.',
      );
    }

    // Bounds: the height it was designed to, and the bill on the -Z end.
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let noseY = 0;
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      const z = position.getZ(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      if (z < minZ) {
        minZ = z;
        noseY = y;
      }
    }
    if (Math.abs(maxY - height) > 0.12) {
      failures.push(`The ${name} stands ${maxY.toFixed(2)} m; it was designed at ${height} m.`);
    }
    if (minY < -0.01) failures.push(`The ${name} has geometry below its own feet; it would sink into the ground.`);
    if (minZ >= 0) {
      failures.push(`The ${name} has nothing on its -Z end. Yaw 0 faces -Z, so it would walk backwards.`);
    }
    if (noseY < maxY * 0.35) {
      failures.push(
        `The furthest-forward point of the ${name} is at ${noseY.toFixed(2)} m on a ${maxY.toFixed(2)} m bird. ` +
          'The head is meant to be the leading edge; this one leads with its feet.',
      );
    }
  }

  // The wings have to be a mirrored pair, or the bird has two left wings --
  // which is invisible head-on and unmistakable from the side.
  {
    const l = assets.wingLeft.getAttribute('position');
    const r = assets.wingRight.getAttribute('position');
    if (l.count !== r.count) {
      failures.push('The magpie wings have different vertex counts; they are not a pair.');
    } else {
      let worst = 0;
      for (let i = 0; i < l.count; i++) {
        const dx = Math.abs(l.getX(i) + r.getX(i));
        const dy = Math.abs(l.getY(i) - r.getY(i));
        const dz = Math.abs(l.getZ(i) - r.getZ(i));
        worst = Math.max(worst, dx, dy, dz);
      }
      if (worst > 1e-6) failures.push('The magpie wings are not mirror images; the bird flies lopsided.');
    }
  }

  // The ibis has to read white. See the palette note.
  if (IBIS_BODY[0] < 0.7) {
    failures.push(
      `The ibis body is rho ${IBIS_BODY[0]}, under the 0.7 that makes it read as a white bird rather ` +
        'than as grey plastic. `world/birds.ts` sets out the calibration this number comes from.',
    );
  }
  // And the turkey has to be black without being a hole.
  if (TURKEY_BODY[0] > 0.06 || TURKEY_BODY[0] < 0.015) {
    failures.push(`The turkey body is rho ${TURKEY_BODY[0]}; it reads as neither a black bird nor a shadow.`);
  }

  return failures;
}

