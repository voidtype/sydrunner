/**
 * What the top of the heat ladder looks like: a patrol car with a light bar, a
 * random breath test across the road, and a spotlight from a helicopter that
 * does not exist.
 *
 * The **rendering** half of `game/heat.ts`. That file decides where a patrol car
 * is, when an RBT appears and who Polair is looking at, and it is compiled into
 * the Bun server; this one draws all three and imports three. `world/police.ts`
 * against `game/factions.ts`, restated, and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THE CAR IS BUILT HERE RATHER THAN LOADED FROM `public/cars`.
 *
 * There are twenty-nine `.glb` car models on disk and one of them is literally
 * `police_kenney.glb`, so the obvious build is to load it. This does not, and
 * the reason is ownership rather than taste.
 *
 * `world/carlod.ts` owns every one of those files. It fetches the manifest,
 * merges each scene into **one** geometry with the node transforms baked and
 * every material collapsed to a vertex colour, holds them in per-body pools
 * whose *order is a contract*, and draws them as `InstancedMesh`es out of a
 * claim ledger. None of that machinery is exported and none of it is shaped for
 * a single hero object: `CarModelFleet` is a lookup-driven near-field fleet, and
 * asking it for "one car at this position, please" would mean either reaching
 * into its pools or copying its merge. The first is a second owner for that
 * file's invariants; the second is two hundred lines of glTF flattening in a
 * file about police.
 *
 * So the patrol car is **procedural**, out of the same little `Parts`
 * accumulator `world/police.ts` builds its cap and band with -- a white
 * Commodore-shaped body, a dark glasshouse, four wheels, and the blue-and-white
 * Sillitoe flank stripe that makes it a *marked* car from further away than the
 * shape does. Two hundred and forty triangles, no fetch, no manifest, no
 * failure mode where the pursuit arrives as an invisible car because a CDN
 * 404'd. It reads as a box car at 10 m and reads as a police car at 60, which
 * is the distance that matters: a patrol car you can see from a block away is
 * the whole point of a 3-star response.
 *
 * The **light bar** was always going to be built here whatever the body was --
 * see section 2 -- and once the light bar is procedural the body being
 * procedural too is what makes them one object with one material and one draw.
 *
 * ---------------------------------------------------------------------------
 * 2. THE LIGHT BAR, AND WHY IT IS TWO MESHES RATHER THAN A SHADER.
 *
 * The bar alternates: red one side, blue the other, swapping about twice a
 * second. Three ways to do that and only one of them is free.
 *
 * A **shader** on an emissive material would mean a node graph with a time
 * uniform, which is a pipeline of its own and something `PipelineWatch` would
 * have to be told about. A **per-frame colour write** would mean touching a
 * material every frame for every car in view. What this does instead is build
 * *both* halves as two meshes of one unlit material and toggle `visible` --
 * which is free, is in no pipeline cache key at all (see `world/nightlights.ts`
 * section 2, which states exactly that rule and the one exception to it: a
 * **light** must never be parented to something whose visibility is toggled,
 * and nothing here is), and gives the hard on/off flash a strobe actually has
 * rather than the sine a shader would tempt somebody into.
 *
 * The lenses are `MeshBasicNodeMaterial`: unlit, so they are the same red at
 * midnight as at noon, which is what a lamp is and is the treatment
 * `world/nightlights.ts` gives every other emissive sprite in this build.
 *
 * ---------------------------------------------------------------------------
 * 3. THE RBT IS ONE MESH FOR ONE ACTOR.
 *
 * `game/heat.ts` puts a single `NPC_KIND.RBT` actor at the site and two
 * ordinary `POLICE` actors beside it. This file draws the actor as a parked car
 * *plus eight witches' hats laid across the road*, all in one geometry, because
 * the cones are a pure function of the site's position and heading and putting
 * eight more actors on the wire to say what one position implies would be 144
 * bytes a snapshot for a traffic cone.
 *
 * The two officers are not drawn here at all. They are real promoted `POLICE`
 * actors, so `world/police.PoliceSquad` -- which already draws every officer in
 * the city -- draws them with no new case and no second rig pool, and a player
 * can hit them, which is the difference between an officer and a bollard.
 *
 * ---------------------------------------------------------------------------
 * 4. POLAIR IS A LIGHT AND A SOUND, NOT A HELICOPTER.
 *
 * A modelled helicopter is a mesh, a rotor animation, a flight path, a
 * collision exemption and an actor on the wire, and it would be on screen for
 * about four seconds at a time because it is above you and you are looking
 * forward. What a police helicopter actually *is*, from the ground, at night,
 * is a cone of light on you that will not go away.
 *
 * So Polair is exactly that: one `SpotLight` 140 m up aimed at the wanted
 * player, following with a little lag and a slow sway so it reads as flown
 * rather than parented, plus a disc of light on the ground under it and a rotor
 * thump in `game/audio.ts`. The disc is what makes it work **by day**, when a
 * spot light's cone is invisible against the sun: the pool of light on the road
 * and the sound overhead are the whole read, and they are legible at noon.
 *
 * The light is created once in the constructor and lives in the scene for the
 * session at intensity 0, which is `NightLights`' rule verbatim -- a light
 * toggled with `visible` drops off the render list and recompiles the scene.
 *
 * ---------------------------------------------------------------------------
 * 5. WHAT THIS FILE IS TOLD, AND BY WHOM.
 *
 * `update(field, stars, target, dt)`. The actor list is whatever `main.ts` has
 * -- `net.actors` online, `FactionField` offline, both iterables of `NpcActor`,
 * which is the same shape `PoliceSquad` and `npcHitTest` already take and is
 * why there is no adapter type anywhere in this feature. `stars` is the local
 * player's heat and `target` is where they are; Polair reads both and nothing
 * else, so the helicopter needs no actor, no message and no state on the wire.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  SpotLight,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import { NPC_KIND, type NpcActor } from '../game/factions.ts';
import { HEAT_MAX } from '../game/heat.ts';

// --- Colours, linear ---------------------------------------------------------------

/**
 * The body. **White, and brighter than any painted car in the traffic.**
 *
 * `world/cars.ts`' palette tops out well under this, deliberately: a highway
 * patrol Commodore is the whitest thing on the road and that is most of how you
 * pick it out of a lane of Camrys at 80 m. 0.86 rather than 1.0 so it still has
 * somewhere to go under direct sun and does not clip to a flat silhouette.
 */
const BODY_WHITE: readonly [number, number, number] = [0.86, 0.87, 0.88];
/** The glasshouse. Dark, and slightly blue, like every other pane in this build. */
const GLASS: readonly [number, number, number] = [0.035, 0.045, 0.06];
/** Tyres and the sills. Not black: nothing in this world is black. */
const RUBBER: readonly [number, number, number] = [0.025, 0.025, 0.028];
/** The Sillitoe flank, in `world/police.ts`' own two colours. */
const CHEQUER_LIGHT: readonly [number, number, number] = [0.82, 0.85, 0.88];
const CHEQUER_BLUE: readonly [number, number, number] = [0.05, 0.14, 0.44];
/** The bar's housing, and the two lenses. The lenses are unlit; see section 2. */
const BAR_HOUSING: readonly [number, number, number] = [0.03, 0.03, 0.035];
const LENS_RED: readonly [number, number, number] = [1.0, 0.06, 0.05];
const LENS_BLUE: readonly [number, number, number] = [0.06, 0.2, 1.0];
/** A witches' hat. Traffic orange over a black base. */
const CONE_ORANGE: readonly [number, number, number] = [0.95, 0.18, 0.02];
const CONE_BASE: readonly [number, number, number] = [0.03, 0.03, 0.03];

// --- The car's dimensions, metres --------------------------------------------------

/**
 * A VF Commodore is 4.97 x 1.90 x 1.47. These are those, rounded, and they are
 * the numbers the *hit* radius in `game/heat.ts` is set against -- see
 * `PATROL_HIT_M` there, which is half this length plus a body.
 */
const CAR_LENGTH = 4.9;
const CAR_WIDTH = 1.9;
const CAR_HEIGHT = 1.45;
/** Where the glasshouse starts and stops along the body, as fractions of length. */
const CABIN_FRONT = 0.12;
const CABIN_BACK = 0.62;
/** Wheel radius, and how far in from the flank they sit. */
const WHEEL_R = 0.34;
const WHEEL_INSET = 0.06;

/** The light bar. Slim, wide, and it sits on the roof rather than in it. */
const BAR_WIDTH = 1.15;
const BAR_DEPTH = 0.24;
const BAR_HEIGHT = 0.13;

/** A witches' hat: 0.45 m of orange over a 0.36 m base, which is the real thing. */
const CONE_HEIGHT = 0.45;
const CONE_BASE_HALF = 0.18;
/** How many hats an RBT lays out, and how far apart across the road. */
export const RBT_CONES = 8;
export const RBT_CONE_PITCH = 1.6;

// --- Geometry accumulator ----------------------------------------------------------

/**
 * The same little accumulator `world/police.Parts` is, copied rather than
 * imported for the reason that one is copied from `world/birds.ts`: it is
 * thirty lines, it is not a shared abstraction anybody maintains, and a
 * `world/parts.ts` that four renderers imported would be a file whose winding
 * rules had to serve a cap, a seagull, a bottle and a car at once.
 *
 * The winding is the whole of what `verifyHighwayPatrol` checks about the
 * geometry, because a quad wound the other way is invisible from the side you
 * are looking at and perfectly solid from the side you are not -- which on a
 * car body reads as z-fighting rather than as a backwards triangle.
 */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];
  /**
   * Quads `facing` could not orient: degenerate ones, whose two edges are
   * parallel and whose cross product is therefore zero, so there is no winding
   * that faces anywhere.
   *
   * Counted rather than thrown, and reported by `verifyHighwayPatrol` at boot,
   * because a degenerate quad is not an error at build time -- it draws as
   * nothing, which is precisely the failure this project's checks exist for. A
   * body assembled from constants that happened to collapse (a wheel inset
   * wider than the car, a cabin whose front is behind its back) would produce
   * a car with a face quietly missing and no exception anywhere.
   */
  degenerate = 0;

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
   * One quad, emitted in whichever winding makes it face the way you said.
   *
   * **The winding is derived rather than typed out**, and that is a deliberate
   * departure from `world/police.Parts`, which hand-winds its cap and band and
   * spends a paragraph on getting the ring's direction right. That works for
   * two shapes. This file has a body, a glasshouse, a roof panel, sills, four
   * wheels, a light bar, two lens halves, eight cone bases and thirty-two cone
   * faces -- and a hand-wound quad is a coin flip that only shows up as a
   * *hole in one flank, visible from the kerb and from nowhere else*.
   *
   * The first cut of this file did type them out and got 124 of the body's 256
   * vertices backwards, which `verifyHighwayPatrol` caught at boot -- so the
   * check works, and the right answer to a check that keeps catching you is to
   * make the mistake unrepresentable. You say which way is out; this picks the
   * order. It costs a dot product per quad, at build time, once.
   */
  facing(
    outward: readonly [number, number, number],
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: readonly [number, number, number],
  ): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const dot = nx * outward[0] + ny * outward[1] + nz * outward[2];
    // Zero in both windings: the quad has no plane, so it faces nowhere and
    // will draw as nothing. Counted; see `degenerate`.
    if (nx * nx + ny * ny + nz * nz < 1e-12) this.degenerate++;
    if (dot >= 0) this.quad(a, b, c, d, colour);
    else this.quad(d, c, b, a, colour);
  }

  /** An axis-aligned box, outward on all six faces. See `facing`. */
  box(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    colour: readonly [number, number, number],
  ): void {
    this.facing([0, 1, 0], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], colour);
    this.facing([0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour);
    this.facing([0, 0, -1], [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], colour);
    this.facing([0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour);
    this.facing([1, 0, 0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], colour);
    this.facing([-1, 0, 0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour);
  }

  /** A square pyramid on the ground plane, apex up. A witches' hat. */
  cone(cx: number, cz: number, half: number, height: number, colour: readonly [number, number, number]): void {
    const corners: Array<[number, number]> = [
      [cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      // Outward is the edge's own midpoint away from the axis. Apex twice, so
      // it is still a quad and the index layout stays uniform.
      this.facing(
        [(ax + bx) / 2 - cx, 0.3, (az + bz) / 2 - cz],
        [ax, 0, az], [bx, 0, bz], [cx, height, cz], [cx, height, cz],
        colour,
      );
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

/**
 * A marked sedan, built about its own centre with **-Z as the nose**.
 *
 * -Z is forward everywhere in this project -- `player/controller.ts`'s movement
 * basis, `world/people.ts`' figures and `world/cars.ts`' boxes all agree -- so a
 * body built any other way would need a yaw correction at every draw and would
 * be a bug the first time somebody forgot one.
 */
function buildBody(): Parts {
  const p = new Parts();
  const hw = CAR_WIDTH / 2;
  const hl = CAR_LENGTH / 2;
  const sill = WHEEL_R * 0.55;
  const waist = CAR_HEIGHT * 0.52;

  // The lower body, from the sills to the waistline.
  p.box(-hw, sill, -hl, hw, waist, hl, BODY_WHITE);
  // The glasshouse, inset and darker, from the waist to the roof.
  const gw = hw * 0.88;
  p.box(-gw, waist, -hl + CAR_LENGTH * CABIN_FRONT, gw, CAR_HEIGHT, -hl + CAR_LENGTH * CABIN_BACK, GLASS);
  // A white roof panel over it, so the cabin is not a black slab from above --
  // which is the only angle a player in third person actually sees it from.
  p.box(
    -gw, CAR_HEIGHT - 0.03, -hl + CAR_LENGTH * (CABIN_FRONT + 0.06),
    gw, CAR_HEIGHT, -hl + CAR_LENGTH * (CABIN_BACK - 0.06),
    BODY_WHITE,
  );
  // The sills, which are what stop the body floating over its wheels.
  p.box(-hw * 0.96, 0.06, -hl * 0.92, hw * 0.96, sill, hl * 0.92, RUBBER);

  // Four wheels, as boxes. A cylinder is 12 quads a wheel for a shape that is
  // 0.34 m across and is under the car; `world/cars.ts` makes the same call.
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const cx = side * (hw - WHEEL_INSET);
      const cz = end * hl * 0.62;
      p.box(
        cx - 0.11 * side - (side < 0 ? 0.11 : 0), 0.02, cz - WHEEL_R,
        cx + 0.11 * side + (side > 0 ? 0.11 : 0), WHEEL_R * 1.6, cz + WHEEL_R,
        RUBBER,
      );
    }
  }

  // The Sillitoe flank: alternating squares along the waistline, both sides,
  // proud of the body by a centimetre so it cannot z-fight with it.
  const cells = 8;
  const cellLen = (CAR_LENGTH * 0.78) / cells;
  const y0 = waist - 0.30;
  const y1 = waist - 0.06;
  for (let i = 0; i < cells; i++) {
    const z0 = -CAR_LENGTH * 0.39 + i * cellLen;
    const z1 = z0 + cellLen;
    const c = i & 1 ? CHEQUER_BLUE : CHEQUER_LIGHT;
    p.facing([1, 0, 0], [hw + 0.01, y0, z0], [hw + 0.01, y0, z1], [hw + 0.01, y1, z1], [hw + 0.01, y1, z0], c);
    p.facing([-1, 0, 0], [-hw - 0.01, y0, z0], [-hw - 0.01, y0, z1], [-hw - 0.01, y1, z1], [-hw - 0.01, y1, z0], c);
  }
  return p;
}

/** The bar's housing: the dark plinth the two lenses sit in. */
function buildBarHousing(): Parts {
  const p = new Parts();
  const roofZ = -CAR_LENGTH / 2 + CAR_LENGTH * ((CABIN_FRONT + CABIN_BACK) / 2);
  p.box(
    -BAR_WIDTH / 2, CAR_HEIGHT, roofZ - BAR_DEPTH / 2,
    BAR_WIDTH / 2, CAR_HEIGHT + 0.045, roofZ + BAR_DEPTH / 2,
    BAR_HOUSING,
  );
  return p;
}

/**
 * One half of the light bar's lenses, `side` being -1 or +1 across the car.
 *
 * Two geometries rather than one with a colour attribute, because the strobe is
 * a `visible` toggle and a toggle needs two objects. See section 2.
 */
function buildLens(side: number, colour: readonly [number, number, number]): Parts {
  const p = new Parts();
  const roofZ = -CAR_LENGTH / 2 + CAR_LENGTH * ((CABIN_FRONT + CABIN_BACK) / 2);
  const x0 = side < 0 ? -BAR_WIDTH / 2 : 0.02;
  const x1 = side < 0 ? -0.02 : BAR_WIDTH / 2;
  p.box(
    x0, CAR_HEIGHT + 0.045, roofZ - BAR_DEPTH / 2 + 0.02,
    x1, CAR_HEIGHT + 0.045 + BAR_HEIGHT, roofZ + BAR_DEPTH / 2 - 0.02,
    colour,
  );
  return p;
}

/**
 * The RBT's furniture: the same car, parked, plus a line of witches' hats laid
 * **across** the site's heading.
 *
 * The site actor's heading is the *road's* direction -- `game/heat.placeRbt`
 * takes it off the lane polyline rather than off the player, because a road that
 * crosses your path at an angle still has to be blocked along its own width. So
 * the cones run along local X here (which is across the car) and the car sits
 * skewed at the end of them, which is exactly how one of these is set up on a
 * real arterial: the car half-blocking a lane and the hats funnelling into it.
 */
function buildRbtProps(): Parts {
  const p = new Parts();
  const span = (RBT_CONES - 1) * RBT_CONE_PITCH;
  for (let i = 0; i < RBT_CONES; i++) {
    const x = -span / 2 + i * RBT_CONE_PITCH;
    // A black base disc under each hat, so it does not appear to float on a
    // cambered road. Two triangles' worth and it is the thing that sells them.
    p.box(x - CONE_BASE_HALF, 0, -CONE_BASE_HALF, x + CONE_BASE_HALF, 0.04, CONE_BASE_HALF, CONE_BASE);
    p.cone(x, 0, CONE_BASE_HALF * 0.82, CONE_HEIGHT, CONE_ORANGE);
  }
  return p;
}

// --- Assets --------------------------------------------------------------------------

/**
 * Every geometry and material this feature draws with, built once and shared.
 *
 * `world/police.PoliceAssets`' contract with the same consequence for teardown:
 * a fleet must never dispose these, because every other patrol car is drawing
 * them.
 */
export class HighwayPatrolAssets {
  readonly body: BufferGeometry;
  readonly barHousing: BufferGeometry;
  readonly lensLeftRed: BufferGeometry;
  readonly lensRightBlue: BufferGeometry;
  readonly lensLeftBlue: BufferGeometry;
  readonly lensRightRed: BufferGeometry;
  readonly rbtProps: BufferGeometry;
  /** Lit, vertex-coloured, flat-shaded. `PoliceAssets.material`'s settings. */
  readonly material: MeshStandardNodeMaterial;
  /** Unlit, for the lenses and the Polair disc. A lamp is the same at midnight. */
  readonly lamp: MeshBasicNodeMaterial;
  readonly discMaterial: MeshBasicNodeMaterial;
  readonly disc: BufferGeometry;
  readonly triangles: number;
  /** Quads that could not be oriented at build. Must be zero; see `Parts.degenerate`. */
  readonly degenerate: number;

  constructor() {
    const body = buildBody();
    const housing = buildBarHousing();
    const rbt = buildRbtProps();
    this.body = body.build('patrol-body');
    this.barHousing = housing.build('patrol-bar');
    // Four lens geometries for two strobe phases: red left / blue right, and
    // then the other way round. Two `visible` toggles a flash, and a lens that
    // is off is genuinely not drawn rather than drawn dark -- which matters,
    // because an unlit material has no shading and a "dark" lens would be a
    // flat maroon rectangle rather than an absence.
    this.lensLeftRed = buildLens(-1, LENS_RED).build('patrol-lens-lr');
    this.lensRightBlue = buildLens(1, LENS_BLUE).build('patrol-lens-rb');
    this.lensLeftBlue = buildLens(-1, LENS_BLUE).build('patrol-lens-lb');
    this.lensRightRed = buildLens(1, LENS_RED).build('patrol-lens-rr');
    this.rbtProps = rbt.build('rbt-props');

    // The Polair ground disc: a flat fan, unlit and additive, laid a few
    // centimetres over whatever it lands on. A fan rather than a quad because a
    // square of light on the road would read as a projected texture missing its
    // texture, and the whole point of the disc is that it works **by day**,
    // when there is no visible cone above it.
    const disc = new Parts();
    {
      const sides = 24;
      const r = 1; // Unit; the mesh is scaled to the cone's footprint at update.
      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        disc.facing(
          [0, 1, 0],
          [0, 0, 0],
          [Math.sin(a0) * r, 0, Math.cos(a0) * r],
          [Math.sin(a1) * r, 0, Math.cos(a1) * r],
          [0, 0, 0],
          [1, 1, 1],
        );
      }
    }
    this.disc = disc.build('polair-disc');

    const material = new MeshStandardNodeMaterial();
    material.name = 'highway-patrol';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.42;
    material.metalness = 0.15;
    material.flatShading = true;
    this.material = material;

    const lamp = new MeshBasicNodeMaterial();
    lamp.name = 'highway-patrol-lamp';
    lamp.vertexColors = true;
    lamp.color = new Color(1, 1, 1);
    lamp.toneMapped = false;
    this.lamp = lamp;

    const discMaterial = new MeshBasicNodeMaterial();
    discMaterial.name = 'polair-disc';
    discMaterial.vertexColors = true;
    discMaterial.color = new Color(1, 1, 0.94);
    discMaterial.transparent = true;
    discMaterial.opacity = 0;
    discMaterial.depthWrite = false;
    discMaterial.blending = AdditiveBlending;
    discMaterial.side = DoubleSide;
    discMaterial.toneMapped = false;
    this.discMaterial = discMaterial;

    this.triangles = body.triangles + housing.triangles + rbt.triangles;
    this.degenerate = body.degenerate + housing.degenerate + rbt.degenerate + disc.degenerate;
  }
}

// --- The fleet --------------------------------------------------------------------------

/**
 * How many patrol cars and RBTs are held.
 *
 * A **frame** budget, not the wire's, exactly as `police.SQUAD_CAPACITY` is:
 * `factions.MAX_ACTORS` bounds what crosses the network and this bounds what is
 * drawn. Four and two, because `game/heat.PATROL_CARS_PER_SUSPECT` is one and a
 * player is only ever given one RBT at a time -- so these are only reachable in
 * a room where several people are simultaneously at 3 and 4 stars, and the
 * honest answer to the fifth car in view is that you have bigger problems.
 */
export const PATROL_CAPACITY = 4;
export const RBT_CAPACITY = 2;
/** How far these are drawn, metres. `police.POLICE_DRAW_RADIUS`, and for its reason. */
export const PATROL_DRAW_RADIUS = 260;

/** The strobe, in seconds per half-cycle. Twice a second, which is what a bar does. */
export const STROBE_PERIOD = 0.25;

/** One pooled car: a body, a bar, and the four lenses two of which are on. */
interface CarSlot {
  group: Object3D;
  lensLeftRed: Mesh;
  lensRightBlue: Mesh;
  lensLeftBlue: Mesh;
  lensRightRed: Mesh;
}

/**
 * Every patrol car and RBT in view, as pooled meshes.
 *
 * `update` allocates nothing. Not parented to a tile, on `PoliceSquad`'s own
 * argument: a patrol car crosses a tile boundary every few seconds and the fleet
 * is drawn as one set for the whole visible world.
 */
export class HighwayPatrolFleet {
  /** Add these to the scene. */
  readonly group = new Object3D();

  /** Drawn last update. Read by the HUD's police line. */
  cars = 0;
  rbts = 0;

  private readonly carSlots: CarSlot[] = [];
  private readonly rbtSlots: Object3D[] = [];
  private clock = 0;

  constructor(assets: HighwayPatrolAssets) {
    this.group.name = 'highway-patrol';
    for (let i = 0; i < PATROL_CAPACITY; i++) {
      const group = new Object3D();
      group.name = `patrol:${i}`;
      group.visible = false;
      const body = new Mesh(assets.body, assets.material);
      body.castShadow = true;
      body.receiveShadow = false;
      const bar = new Mesh(assets.barHousing, assets.material);
      bar.castShadow = true;
      const slot: CarSlot = {
        group,
        lensLeftRed: new Mesh(assets.lensLeftRed, assets.lamp),
        lensRightBlue: new Mesh(assets.lensRightBlue, assets.lamp),
        lensLeftBlue: new Mesh(assets.lensLeftBlue, assets.lamp),
        lensRightRed: new Mesh(assets.lensRightRed, assets.lamp),
      };
      group.add(body, bar, slot.lensLeftRed, slot.lensRightBlue, slot.lensLeftBlue, slot.lensRightRed);
      this.carSlots.push(slot);
      this.group.add(group);
    }
    for (let i = 0; i < RBT_CAPACITY; i++) {
      const group = new Object3D();
      group.name = `rbt:${i}`;
      group.visible = false;
      const props = new Mesh(assets.rbtProps, assets.material);
      props.castShadow = true;
      props.receiveShadow = false;
      // The RBT's own car, parked skewed across the end of the cone line. The
      // 0.35 rad is a car pulled up at an angle rather than parked neatly, which
      // is what a breath test on an arterial looks like and is one number.
      const car = new Mesh(assets.body, assets.material);
      car.castShadow = true;
      car.position.set((RBT_CONES * RBT_CONE_PITCH) / 2 + 1.6, 0, 1.4);
      car.rotation.y = 0.35;
      const bar = new Mesh(assets.barHousing, assets.material);
      bar.position.copy(car.position);
      bar.rotation.y = car.rotation.y;
      const lens = new Mesh(assets.lensLeftRed, assets.lamp);
      lens.position.copy(car.position);
      lens.rotation.y = car.rotation.y;
      const lens2 = new Mesh(assets.lensRightBlue, assets.lamp);
      lens2.position.copy(car.position);
      lens2.rotation.y = car.rotation.y;
      group.add(props, car, bar, lens, lens2);
      this.rbtSlots.push(group);
      this.group.add(group);
    }
  }

  /**
   * Place every patrol car and RBT in view.
   *
   * `field` is whatever the caller has -- `net.actors` online, `FactionField`
   * offline. `dt` drives the strobe and nothing else; the *positions* come from
   * the authority, which is `main.ts`' rule about every actor in this project.
   */
  update(field: { actors: Iterable<NpcActor> }, dt: number, x: number, z: number): void {
    this.clock += dt;
    // A hard alternation rather than a wave. See section 2.
    const phase = Math.floor(this.clock / STROBE_PERIOD) & 1;
    const r2 = PATROL_DRAW_RADIUS * PATROL_DRAW_RADIUS;

    let cars = 0;
    let rbts = 0;
    for (const a of field.actors) {
      const isCar = a.kind === NPC_KIND.HIGHWAY_PATROL;
      const isRbt = a.kind === NPC_KIND.RBT;
      if (!isCar && !isRbt) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (isCar) {
        if (cars >= PATROL_CAPACITY) continue;
        const slot = this.carSlots[cars++];
        slot.group.visible = true;
        placeByHeading(slot.group, a);
        slot.lensLeftRed.visible = phase === 0;
        slot.lensRightBlue.visible = phase === 0;
        slot.lensLeftBlue.visible = phase === 1;
        slot.lensRightRed.visible = phase === 1;
      } else {
        if (rbts >= RBT_CAPACITY) continue;
        const group = this.rbtSlots[rbts++];
        group.visible = true;
        placeByHeading(group, a);
      }
    }
    for (let i = cars; i < this.carSlots.length; i++) this.carSlots[i].group.visible = false;
    for (let i = rbts; i < this.rbtSlots.length; i++) this.rbtSlots[i].visible = false;
    this.cars = cars;
    this.rbts = rbts;
  }
}

/**
 * Put an object at an actor's feet, facing the actor's heading.
 *
 * `atan2` and nothing else: the actor carries a unit `(dx, dz)` because
 * `game/factions.ts`'s rule 5 keeps angles off anything that crosses the wire,
 * and turning that pair into the yaw a renderer wants is exactly the one place
 * that file permits the call -- see its `encodeSnapshot` note. Bodies are built
 * nose-along -Z, which is `Math.atan2(-dx, -dz)`.
 */
function placeByHeading(obj: Object3D, a: NpcActor): void {
  obj.position.set(a.x, a.y, a.z);
  obj.rotation.y = Math.atan2(-a.dx, -a.dz);
}

// --- Polair ------------------------------------------------------------------------------

/** How high the helicopter is, metres, and how wide its cone opens. */
export const POLAIR_HEIGHT_M = 140;
export const POLAIR_CONE_DEG = 12;
/** How far the beam lags the player, seconds, and how far the sway wanders, metres. */
export const POLAIR_LAG = 0.55;
export const POLAIR_SWAY_M = 5.5;
/** How long the beam takes to come up and go down. Not instant; a light is aimed. */
export const POLAIR_FADE = 0.8;
/** The spot's intensity when it is fully on. Bright: it is 140 m away. */
export const POLAIR_INTENSITY = 260000;

/**
 * The spotlight, the disc under it, and the lag that makes it read as flown.
 *
 * One `SpotLight`, created in the constructor and **never removed and never
 * made invisible** -- `world/nightlights.NightLights` states the rule and the
 * reason: a light whose `visible` is toggled drops off the render list and
 * recompiles the scene the next time it comes back. The intensity is the only
 * thing that moves, which is the same arrangement the torch has.
 *
 * The sway is a **triangle wave, not a sine**, on `game/streetlife.ts`'s own
 * argument about `triangle`: it is presentation here so determinism does not
 * strictly require it, but a sine spends most of its time at the ends of its
 * stroke and a helicopter holding a light on somebody does not -- it drifts
 * across and corrects. The triangle reads better and is three adds.
 */
export class Polair {
  readonly light: SpotLight;
  readonly disc: Mesh;
  /**
   * The disc's own material, held by its concrete type.
   *
   * `Mesh.material` is `Material | Material[]` and the opacity is written every
   * frame the beam is up, so reading it back off the mesh would be a cast per
   * frame -- and a cast is exactly the thing that stops being true the day
   * somebody gives the disc a second material slot.
   */
  private readonly discMaterial: MeshBasicNodeMaterial;

  /** Where the beam is actually pointing. Lags the target; see `update`. */
  private readonly aim = { x: 0, y: 0, z: 0 };
  private level = 0;
  private clock = 0;

  /** True while the beam is up. The HUD and the audio read it. */
  get on(): boolean {
    return this.level > 0.01;
  }

  /** 0..1, for the rotor's mix. */
  get intensity(): number {
    return this.level;
  }

  constructor(scene: Object3D, assets: HighwayPatrolAssets) {
    const light = new SpotLight(0xffffff, 0);
    light.name = 'polair';
    light.angle = (POLAIR_CONE_DEG * Math.PI) / 180;
    // A hard edge, near enough. A police searchlight is a well-collimated beam
    // and the soft-edged version reads as a torch held very far away.
    light.penumbra = 0.25;
    light.distance = POLAIR_HEIGHT_M * 1.6;
    light.decay = 1.1;
    // Never. See `NightLights`' torch: a second shadow map is a second full
    // depth pass from a direction that moves every frame, and the sun's rig is
    // tuned for exactly one caster.
    light.castShadow = false;
    this.light = light;
    // Both the light and its target go in the scene, because a `SpotLight` aims
    // at an `Object3D` and one that is not in the graph never has its world
    // matrix updated -- so the beam would point wherever the target's *local*
    // transform happened to leave it. `NightLights` adds its torch's target for
    // the identical reason.
    scene.add(light);
    scene.add(light.target);

    const disc = new Mesh(assets.disc, assets.discMaterial);
    this.discMaterial = assets.discMaterial;
    disc.name = 'polair-disc';
    disc.frustumCulled = false;
    disc.castShadow = false;
    disc.receiveShadow = false;
    disc.visible = false;
    this.disc = disc;
    scene.add(disc);
  }

  /**
   * Aim at a player, or stand down.
   *
   * `groundY` is the height of whatever the disc should lie on, which the caller
   * already knows -- it is the composed ground query `main.ts` uses everywhere
   * -- and asking for it rather than raycasting is the difference between this
   * costing nothing and costing a ray a frame.
   */
  update(dt: number, on: boolean, x: number, y: number, z: number, groundY: number): void {
    this.clock += dt;
    // Ramped, so the beam comes up over most of a second rather than appearing.
    const want = on ? 1 : 0;
    const rate = dt / POLAIR_FADE;
    this.level += Math.max(-rate, Math.min(rate, want - this.level));
    if (this.level < 0) this.level = 0;
    if (this.level > 1) this.level = 1;

    if (this.level <= 0.001) {
      this.light.intensity = 0;
      this.disc.visible = false;
      this.discMaterial.opacity = 0;
      // Parked far under the terrain rather than at the origin, which is a real
      // place in this world: somebody standing at Town Hall with an idle
      // searchlight at their feet would see a phantom.
      this.light.position.set(0, -1000, 0);
      return;
    }

    // The sway: a triangle in each axis at two incommensurate rates, so the
    // beam wanders rather than tracing a line back and forth.
    const swayX = triangle(this.clock * 0.19) * POLAIR_SWAY_M;
    const swayZ = triangle(this.clock * 0.13 + 0.37) * POLAIR_SWAY_M;
    const tx = x + swayX;
    const tz = z + swayZ;
    // And the lag, an exponential chase. `NightLights`' torch does the same to
    // the same end: a beam that tracks perfectly is a beam that is welded on.
    const k = 1 - Math.exp(-dt / POLAIR_LAG);
    this.aim.x += (tx - this.aim.x) * k;
    this.aim.y += (y - this.aim.y) * k;
    this.aim.z += (tz - this.aim.z) * k;

    this.light.position.set(this.aim.x, groundY + POLAIR_HEIGHT_M, this.aim.z);
    this.light.target.position.set(this.aim.x, groundY, this.aim.z);
    this.light.target.updateMatrixWorld();
    this.light.intensity = POLAIR_INTENSITY * this.level;

    // The disc, scaled to the cone's footprint at this height. `tan` is fine
    // here: it is presentation, it is once a frame, and nothing compares it.
    const radius = POLAIR_HEIGHT_M * Math.tan(this.light.angle);
    this.disc.visible = true;
    this.disc.position.set(this.aim.x, groundY + 0.06, this.aim.z);
    this.disc.scale.set(radius, 1, radius);
    // Faint. It is a *supplement* to the cone at night and the whole of the
    // effect by day, and a bright disc at midnight would look like a decal.
    this.discMaterial.opacity = 0.16 * this.level;
  }
}

/**
 * A triangle wave in [-1, 1], period 1. `game/streetlife.triangle`, copied for
 * its own stated reason: it is four lines and it is not a shared abstraction.
 */
function triangle(t: number): number {
  const f = t - Math.floor(t);
  return f < 0.5 ? f * 4 - 1 : 3 - f * 4;
}

// --- The check ---------------------------------------------------------------------------

/**
 * Boot self-check, on this project's usual criterion: does every way it breaks
 * still *render*, and render something plausible?
 *
 * Every failure below does.
 *
 *   - A **quad wound the other way** is a car with a hole in one flank, visible
 *     only from the kerb, which reads as z-fighting rather than as geometry.
 *     Checked as `world/police.verifyPoliceKit` checks it: every face normal of
 *     a closed box has to point away from the box's own centre.
 *   - A **light bar with no lenses lit in either phase** is a marked car with a
 *     dark plinth on the roof, which reads as the strobe being unimplemented
 *     rather than as four geometries being wrong.
 *   - A **cone line narrower than the roads it blocks** is an RBT you drive
 *     round, which reads as the roadblock not working. The span is checked
 *     against `game/heat.RBT_LINE_HALF_M`, which is the *evasion* test's own
 *     half-width, because those two numbers describing different widths is a
 *     player driving through a gap and not being charged for it.
 *   - A **Polair cone that does not reach the ground** is a searchlight lighting
 *     nothing, at noon and at midnight alike, with no error anywhere.
 *   - And a **body built nose-first along +Z** is every patrol car in Sydney
 *     driving backwards, which at a distance reads as a reversing car.
 */
export function verifyHighwayPatrol(assets?: HighwayPatrolAssets): string[] {
  const failures: string[] = [];

  // --- The geometry, if it has been built.
  if (assets) {
    if (assets.triangles <= 0) {
      failures.push('The highway patrol kit has no triangles in it; a pursuit would arrive as an invisible car.');
    }
    // The body's own extent, which is what the hit radius in `game/heat.ts` is
    // set against. A body that grew past it would be a car that visibly passes
    // through people.
    assets.body.computeBoundingBox();
    const box = assets.body.boundingBox;
    if (box) {
      const len = box.max.z - box.min.z;
      const wide = box.max.x - box.min.x;
      if (Math.abs(len - CAR_LENGTH) > 0.35) {
        failures.push(`The patrol body is ${len.toFixed(2)} m long and the constants say ${CAR_LENGTH}.`);
      }
      if (wide > len) {
        failures.push(
          `The patrol body is ${wide.toFixed(2)} m across and ${len.toFixed(2)} m long, so it is built ` +
            'facing sideways. Every car in the city would drive crabwise.',
        );
      }
      if (box.min.y < -0.01) failures.push('The patrol body reaches below its own origin; it would sink into the road.');
    }
    // Every quad in this file went through `Parts.facing`, which derives its
    // winding from a stated outward direction -- so what is left to check is
    // that none of them was *unorientable*. See `Parts.degenerate`.
    if (assets.degenerate > 0) {
      failures.push(
        `${assets.degenerate} quads of the highway patrol kit collapsed to a line and face nowhere. ` +
          'They draw as nothing, so the car has holes in it that no exception reports.',
      );
    }
    // Both phases have to light something, or the bar is a dark plinth.
    for (const [name, g] of [
      ['red left', assets.lensLeftRed], ['blue right', assets.lensRightBlue],
      ['blue left', assets.lensLeftBlue], ['red right', assets.lensRightRed],
    ] as const) {
      const count = g.getIndex()?.count ?? 0;
      if (count <= 0) failures.push(`The ${name} lens has no triangles; that half of the strobe is dark.`);
    }
    // And the two phases must not be the same colour, which is a bar that
    // flashes white and reads as a fault light.
    const a = firstColour(assets.lensLeftRed);
    const b = firstColour(assets.lensLeftBlue);
    if (a !== null && b !== null && a[0] === b[0] && a[2] === b[2]) {
      failures.push('Both phases of the light bar are the same colour on the same side; it would not read as a strobe.');
    }
    // The disc has to be a disc rather than a point.
    assets.disc.computeBoundingBox();
    const d = assets.disc.boundingBox;
    if (d && d.max.x - d.min.x < 1.9) {
      failures.push('The Polair ground disc is smaller than its own unit radius; it is scaled at draw and would vanish.');
    }
  }

  // --- `Parts.facing` itself, against a single convex box, where "outward" and
  //     "away from the centroid" genuinely mean the same thing.
  //
  // The compound body cannot be checked this way and the first cut of this file
  // tried: a wheel sits at the corner of the car, so its *inner* face correctly
  // points back toward the body's centre, and 44 of 256 vertices failed a test
  // that was asking the wrong question. What is actually being asserted is that
  // the orientation helper works -- and a box is where that claim is true.
  {
    const probe = new Parts();
    probe.box(-1, -2, -3, 4, 5, 6, [1, 1, 1]);
    failures.push(...verifyOutward(probe.build('probe'), 'orientation probe box'));
    if (probe.degenerate !== 0) failures.push('A well-formed box produced a degenerate quad.');
    if (probe.triangles !== 12) failures.push(`A box built ${probe.triangles} triangles rather than 12.`);
  }

  // --- The RBT's geometry, as a relation rather than as a number. The cone line
  //     has to be at least as wide as the evasion test's own half-width either
  //     side, or there is a gap you can drive through and not be charged for.
  {
    const half = ((RBT_CONES - 1) * RBT_CONE_PITCH) / 2;
    if (RBT_CONES < 4) failures.push(`An RBT lays ${RBT_CONES} witches' hats; that is a driveway, not a roadblock.`);
    if (half < 5) {
      failures.push(
        `The cone line reaches ${half.toFixed(1)} m either side of the site and a two-lane road is about 7. ` +
          'The hats would sit in one lane and the RBT would read as an abandoned traffic job.',
      );
    }
  }

  // --- Polair's geometry. A cone that does not reach the ground is a
  //     searchlight lighting nothing.
  {
    const radius = POLAIR_HEIGHT_M * Math.tan((POLAIR_CONE_DEG * Math.PI) / 180);
    if (!(radius > 5 && radius < 120)) {
      failures.push(
        `Polair's cone lands a ${radius.toFixed(0)} m pool on the ground from ${POLAIR_HEIGHT_M} m up. ` +
          'Under 5 m it is a laser pointer and over 120 it is daylight.',
      );
    }
    if (POLAIR_SWAY_M > radius) {
      failures.push(
        `The beam sways ${POLAIR_SWAY_M} m and its pool is ${radius.toFixed(0)} m across, so the player ` +
          'spends most of the time outside their own spotlight.',
      );
    }
    if (POLAIR_LAG <= 0) failures.push('The Polair beam has no lag; a perfectly tracking searchlight reads as welded on.');
    if (POLAIR_FADE <= 0) failures.push('The Polair beam has no fade; 260 kW appearing in one frame is a white screen.');
  }

  // --- The strobe.
  if (!(STROBE_PERIOD > 0.05 && STROBE_PERIOD < 1)) {
    failures.push(
      `The light bar alternates every ${STROBE_PERIOD} s. Faster than 0.05 is a flicker nobody can look at ` +
        'and slower than 1 is a lamp that is sometimes red.',
    );
  }

  // --- And the contract with the ladder: this file draws two kinds and both
  //     have to be the ones `game/heat.ts` promotes.
  {
    // Read through an array rather than compared as two literals, so the
    // compiler cannot constant-fold the check away -- which is exactly how a
    // check like this goes quietly true and stops covering anything. Two kinds
    // sharing a byte would draw every roadblock as a moving car.
    const kinds = [NPC_KIND.HIGHWAY_PATROL, NPC_KIND.RBT, NPC_KIND.POLICE] as number[];
    if (new Set(kinds).size !== kinds.length) {
      failures.push('The patrol car, the RBT and the police do not have three distinct kind bytes.');
    }
  }
  if (HEAT_MAX < 5) {
    failures.push(`The ladder tops out at ${HEAT_MAX} stars and Polair is the fifth rung; it would be unreachable.`);
  }

  // --- The triangle wave, which is the one piece of arithmetic in this file.
  {
    if (Math.abs(triangle(0) + 1) > 1e-9) failures.push('The sway wave does not start at -1.');
    if (Math.abs(triangle(0.5) - 1) > 1e-9) failures.push('The sway wave does not peak at its half period.');
    if (Math.abs(triangle(0.25) - triangle(1.25)) > 1e-9) failures.push('The sway wave is not periodic; the beam would drift out of the city.');
    for (let i = 0; i <= 40; i++) {
      const v = triangle(i / 13);
      if (v < -1.0000001 || v > 1.0000001) {
        failures.push(`The sway wave reached ${v.toFixed(3)}, outside [-1, 1]. The beam would leave the street.`);
        break;
      }
    }
  }

  return failures;
}

/** Every face normal of a closed solid points away from its own centroid. */
function verifyOutward(geometry: BufferGeometry, what: string): string[] {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  if (!pos || !nrm) return [`The ${what} has no positions or no normals.`];
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
  let inverted = 0;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dy = pos.getY(i) - cy;
    const dz = pos.getZ(i) - cz;
    const dot = dx * nrm.getX(i) + dy * nrm.getY(i) + dz * nrm.getZ(i);
    // Exact, because this is only ever asked of a **single convex solid** --
    // see the call site. On a compound body the question is meaningless: a
    // wheel at the corner of a car has an inner face that correctly points back
    // at the car's centre.
    if (dot < -1e-6) inverted++;
  }
  if (inverted > 0) {
    return [
      `${inverted} of the ${what}'s ${pos.count} vertices have a normal pointing into the solid. ` +
        'Those faces are invisible from outside and solid from inside, which reads as z-fighting.',
    ];
  }
  return [];
}

/** The first vertex colour of a geometry, for the strobe's two-phase check. */
function firstColour(geometry: BufferGeometry): [number, number, number] | null {
  const c = geometry.getAttribute('color');
  if (!c || c.count === 0) return null;
  return [c.getX(0), c.getY(0), c.getZ(0)];
}

/**
 * The pipelines this feature needs compiled before a player can be at 3 stars.
 *
 * `world/police.policeWarmupParts`' contract: the boot warm-up draws one of
 * everything off-screen so the first patrol car does not cost a shader compile
 * in the middle of a pursuit -- which is the one moment in the session where a
 * 200 ms hitch is unambiguously the game's fault.
 */
export function highwayPatrolWarmupParts(assets: HighwayPatrolAssets): WarmupPart[] {
  return [
    { geometry: assets.body, material: assets.material },
    { geometry: assets.barHousing, material: assets.material },
    { geometry: assets.lensLeftRed, material: assets.lamp },
    { geometry: assets.rbtProps, material: assets.material },
    { geometry: assets.disc, material: assets.discMaterial },
  ];
}
