/**
 * Ambient life: ibises on the ground, gulls in the air.
 *
 * Spec section 7.7 ends on the only non-negotiable sentence in the document --
 * *"And ibises. Non-negotiable. Idle animation, scatter near bins and parks,
 * flee on approach."* -- and this is that, plus the second half of the same
 * observation: a city where nothing moves reads as a render rather than a
 * place, and the two cheapest moving things in Sydney are an ibis stalking a
 * park and a gull wheeling over it.
 *
 * Everything here is derived on the client from data a tile already has. No
 * pipeline change, no new sidecar, no rebuild:
 *
 *   - **Where ibises stand** comes from the tile's *own* `.veg.bin`, already
 *     decoded for the trees. Species 0 (Moreton Bay fig) and 5 (eucalypt) are
 *     what the pipeline scatters through park interiors, so "a tile with figs"
 *     *is* "a tile with parkland" without anything having to say so -- and it is
 *     ecologically exact rather than merely convenient. Sydney's white ibis
 *     colonised the fig parks: Hyde Park, the Domain, Centennial. That is where
 *     they are.
 *   - **The retail half** of "near bins" comes from the `awning_fascia`
 *     primitive in the tile's GLB. Bins are street furniture and street
 *     furniture is a different project, so the clause resolves to the thing an
 *     awning already marks exactly: a retail strip, which is where the bins are.
 *   - **The ground** comes from the tile's terrain grid, through the same
 *     `sampleTileGrid` closure the trees and the parked cars are placed with.
 *   - **Whether a spawn point is inside a building** comes from the collision
 *     prisms, queried through `SpawnGuard` below so this module never has to
 *     know what a prism is.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and every display value beside it was
 * produced by running the chain documented at the top of `sky/calibration.ts` --
 * irradiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode -- at
 * the reference instant of 3 pm on 15 February. The method is checked rather
 * than assumed: the same evaluation reproduces `street.ts`'s published footpath
 * (247, 248, 246), asphalt (131, 137, 148) and shaded asphalt (24, 40, 59)
 * exactly.
 *
 * The one value the whole palette exists to protect is that **the ibis has to
 * read WHITE**. It is a white bird on a grey city and the failure mode is grey
 * plastic. At rho 0.74 its back in sun lands at rgb(250, 251, 250) against the
 * sunlit footpath's rgb(247, 248, 246) -- brighter than the brightest surface
 * in the street, which is correct, because a white bird is. Its flank at
 * N.L 0.45 is still rgb(242, 246, 248), so the entire sunlit side of the bird
 * sits inside nine code values of white and the *shape* is carried by the
 * black, not by any shading of the white.
 *
 * ---------------------------------------------------------------------------
 * Cost. One ibis geometry and one gull geometry, built once for the whole game
 * and shared by every tile, and **one material for both**, on exactly the terms
 * `vegetation.ts` and `cars.ts` set: a material created per tile is a WebGPU
 * pipeline compiled per tile, and pipeline compilation blocks the main thread.
 *
 *   ibis   146 triangles, 114 vertices   one InstancedMesh per tile with birds
 *   gull     4 triangles,  12 vertices   one InstancedMesh for the whole sky
 *
 * A tile's ibises are **one** draw call, not two: the bill, the legs and the
 * body are vertex colours on one geometry, the same trick that puts a car's
 * glass and tyres in the paint mesh.
 *
 * Counted by running this exact derivation over every tile of the inner ring:
 * **693 ibises on 180 of the 221 tiles**, 3.9 per populated tile, because 176
 * carry fig or eucalypt and 41 carry a retail strip. At the spawn point that is
 * **237 resident in 56 instanced draws**, and the worst viewpoint anywhere in
 * the ring holds 252 -- against the ceiling of 400 this feature was given.
 * 252 birds is 36,800 triangles, which is 7% of the 483 k of trees already in
 * the same frame.
 *
 * Only the birds inside 150 m of the camera are simulated at all, which is
 * typically ten to twenty. Timed in Node against this exact update loop, **150
 * ibises all inside the radius step and repose in 0.024 ms** -- the
 * pathological case, and 5% of the 0.5 ms budget; the frame that actually
 * happens is a tenth of it. The gulls are 36 instances of the same arithmetic
 * and do not register.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import type { TileVegetation } from './vegetation.ts';

// --- The palette --------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Ibis body, linear. A *dirty* white -- blue is pulled 12% under red so it reads
 * cream rather than the blue-white a pure neutral takes on under a sky fill this
 * blue. This is a bird that lives in a bin.
 *
 *   back, N.L 1.0   rgb(250, 251, 250)     flank, N.L 0.45  rgb(242, 246, 248)
 *   in shade        rgb(148, 164, 181)     underside        rgb( 71,  60,  36)
 *
 * The shade figure is the one that decides whether this works in a park, because
 * a fig canopy is the darkest thing in the city and the birds stand under it: at
 * Y' 161 against shaded asphalt's Y' 36 the bird is still four stops clear of
 * the ground it is standing on.
 */
const IBIS_BODY: Rgb = [0.74, 0.72, 0.65];

/**
 * Head, neck, bill and tail tip, linear. Matte keratin and bare black skin, so
 * unlike `cars.ts`'s paint there is nothing here to lift for a missing sky
 * reflection -- this really is that dark.
 *
 *   in sun          rgb( 89,  88,  93)     in shade         rgb(  8,  19,  32)
 *
 * Against the body's 250 in sun that is a 160-code-value step across a 3 cm
 * boundary, which is the entire reason the silhouette survives at fifty metres.
 * The bill *is* the species -- a long black scythe on a white bird is
 * recognisable from further away than the bird is -- so it gets the hardest
 * contrast in the file and 0.25 m of length, against a real bill's 0.17.
 */
const IBIS_BLACK: Rgb = [0.045, 0.043, 0.044];

/** Legs. Dark grey-pink, warmer and a little lighter than the bill. rgb(121, 117, 115) in sun. */
const IBIS_LEG: Rgb = [0.075, 0.068, 0.062];

/**
 * Gull upperwing, linear -- pale grey, because a silver gull's mantle is grey
 * and only its head and underparts are white. rgb(243, 246, 251) in sun, which
 * the tone curve has already pushed to white: above rho 0.42 everything
 * compresses into a few code values, so the grey and the white read as one
 * blazing surface in sun and separate only in shade. That is what a gull does.
 */
const GULL_TOP: Rgb = [0.46, 0.465, 0.48];

/**
 * Gull underwing, linear. White -- and it renders **dark**: a down-facing
 * surface in this rig sees only `GROUND_FILL`, because `BOUNCE_ALTITUDE` puts
 * the bounce 16 degrees *above* the horizon where an underwing can never reach
 * it. rgb(73, 62, 40), which is the same Y' 64 as the awning and eave soffits,
 * arrived at by the same argument rather than by taste.
 *
 * That is not a defect here, it is the feature. A gull banking on its orbit
 * alternates between a blazing rgb(243, 246, 251) top and a rgb(73, 62, 40)
 * underside -- a 180-code-value flash, twice a circuit, on an object a few
 * pixels across. See `GullFlocks` for why that is the whole animation.
 */
const GULL_BELLY: Rgb = [0.78, 0.78, 0.79];

/** Wing tips. Black on a silver gull, and free: it is a vertex colour. */
const GULL_TIP: Rgb = [0.05, 0.05, 0.052];

// --- Geometry -----------------------------------------------------------------

/**
 * Deterministic hash, 0..1. The same construction `vegetation.ts` uses, and it
 * is duplicated rather than shared for one reason worth stating: that copy is
 * module-private and this pass is not allowed to refactor the vegetation
 * module. Both are author-time only -- this one also runs per bird at tile
 * load, which is a few hundred calls for a whole city.
 */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

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
 * Accumulates indexed triangles with a colour per vertex.
 *
 * Indexed, with the faceting coming from `material.flatShading`, for the reason
 * `vegetation.ts` measured: a non-indexed build with baked face normals triples
 * the vertex count for exactly the same triangles and exactly the same look.
 * That mattered at 5,500 trees a frame and matters much less at 190 birds, but
 * there is no reason to do the worse thing.
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
    const len = Math.hypot(ax, ay, az) || 1;
    const dx = ax / len;
    const dy = ay / len;
    const dz = az / len;
    // The reference vector must not be parallel to the axis or the cross product
    // collapses. A leg is vertical and a bill is nearly horizontal, so one fixed
    // reference cannot serve both -- the same switch `vegetation.cone` makes.
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
    const rings: Array<[Point, number, Rgb]> = [
      [from, r0, c0],
      [to, r1, c1],
    ];
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
      const l = Math.hypot(x, y, z);
      const ux = x / l;
      const uy = y / l;
      const uz = z / l;
      this.position.push(centre[0] + ux * radii[0], centre[1] + uy * radii[1], centre[2] + uz * radii[2]);
      this.normal.push(ux, uy, uz);
      this.colour.push(c[0], c[1], c[2]);
    }
    for (const [a, b, c2] of ICO_FACES) this.index.push(base + a, base + b, base + c2);
  }

  /** One triangle from three explicit points, for the gull's wing panels. */
  triangle(a: Point, b: Point, c: Point, ca: Rgb, cb: Rgb, cc: Rgb): void {
    const base = this.position.length / 3;
    // Flat normal from the winding, so the geometry degrades to something
    // sensible if `flatShading` is ever turned off.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const verts: Array<[Point, Rgb]> = [
      [a, ca],
      [b, cb],
      [c, cc],
    ];
    for (const [p, col] of verts) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(nx, ny, nz);
      this.colour.push(col[0], col[1], col[2]);
    }
    this.index.push(base, base + 1, base + 2);
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

/**
 * One ibis, standing, facing **-Z** at yaw 0 -- the same convention the player
 * controller uses, so a heading is a heading everywhere in the client.
 *
 * Proportions are comic per spec 8.1, and the exaggeration is spent entirely on
 * the head and the bill because that is where an ibis is recognisable from. A
 * real *Threskiornis molucca* stands 65-75 cm with a 17 cm bill; this one
 * measures **0.81 m tall, 0.91 m bill tip to tail and 0.32 m across**, with a
 * 25 cm bill on a head half again as large as life. Everything else is honest
 * -- the body really is a 52 cm egg on 30 cm of leg -- and getting *that* wrong
 * is what makes a bird read as a chicken.
 *
 * No wing bones and no leg animation. At the size this is seen (a 32 cm wide
 * object, almost always beyond ten metres) what carries the walk is the
 * whole-body waddle and the pitch of the peck, and both are one instance matrix.
 */
function buildIbis(): BufferGeometry {
  const p = new Parts();
  const body = IBIS_BODY;
  const black = IBIS_BLACK;

  // Legs. Four-sided sticks: at 4 cm across, more sides is more vertices for a
  // silhouette that is already a line.
  p.cone([-0.055, 0, 0.03], [-0.05, 0.31, 0.0], 0.022, 0.017, 4, IBIS_LEG);
  p.cone([0.055, 0, 0.03], [0.05, 0.31, 0.0], 0.022, 0.017, 4, IBIS_LEG);

  // The body: a 52 cm egg, carried the way a standing ibis carries it.
  p.lobe([0, 0.42, 0.02], [0.13, 0.135, 0.26], body);

  // Folded wings. Flattened lobes rather than flat plates, so the body reads as
  // having a shoulder rather than a decal, and so the underside of the wing
  // takes the down-facing fill and separates from the flank.
  p.lobe([-0.115, 0.45, 0.04], [0.05, 0.075, 0.2], body);
  p.lobe([0.115, 0.45, 0.04], [0.05, 0.075, 0.2], body);

  // Tail, black at the tip. Two colours on one tube, so the black band costs
  // nothing at all.
  p.cone([0, 0.45, 0.22], [0, 0.4, 0.44], 0.085, 0.02, 4, body, black);

  // Neck. Bare black skin on a white bird, which is most of the recognition
  // after the bill.
  p.cone([0, 0.5, -0.11], [0, 0.72, -0.19], 0.05, 0.036, 5, black);

  // Head, oversized per 8.1.
  p.lobe([0, 0.76, -0.215], [0.052, 0.058, 0.068], black);

  // The bill. Four segments, so it *curves* rather than bending -- a straight
  // black spike is a stork and a curved one is an ibis, and at fifty metres
  // that is the entire difference between the two. 0.25 m along the curve,
  // dropping 0.22 m over it.
  const BILL: Point[] = [
    [0, 0.755, -0.26],
    [0, 0.735, -0.35],
    [0, 0.685, -0.42],
    [0, 0.61, -0.455],
    [0, 0.535, -0.46],
  ];
  const BILL_R = [0.03, 0.023, 0.017, 0.011, 0.005];
  for (let i = 0; i < BILL.length - 1; i++) {
    p.cone(BILL[i], BILL[i + 1], BILL_R[i], BILL_R[i + 1], 4, black);
  }

  return p.build('ibis');
}

/**
 * One gull: a bent-wing chevron, 1.15 m across, nose at **-Z**.
 *
 * Four triangles -- two facing up, two facing down, 3 cm apart -- rather than
 * two double-sided ones. That is the whole trick and it is worth saying why: a
 * `DoubleSide` quad shades its back face with the *front* face's colour, so a
 * gull seen from below would be exactly as bright as one seen from above. Two
 * opposed faces get the light rig's own answer instead -- the top takes the
 * beam, the bottom takes only `GROUND_FILL` -- and the 180-code-value step
 * between them is what makes a few-pixel object legible when it banks.
 *
 * The wing tips are raised 10 cm, so the two halves of the top surface take
 * different `N.L` and one wing is always brighter than the other. Under
 * `flatShading` that is two flat tones meeting at a line, which is what a
 * gliding bird looks like from a hundred metres underneath it.
 */
function buildGull(): BufferGeometry {
  const p = new Parts();
  const span = 0.575; // half span; a silver gull is 0.94 m, this is comic-wide
  const nose: Point = [0, 0, -0.11];
  const tail: Point = [0, 0, 0.07];
  const left: Point = [-span, 0.1, 0.15];
  const right: Point = [span, 0.1, 0.15];
  const drop = 0.03;
  const under = (v: Point): Point => [v[0], v[1] - drop, v[2]];

  // Top, wound so both faces look up.
  p.triangle(nose, tail, left, GULL_TOP, GULL_TOP, GULL_TIP);
  p.triangle(nose, right, tail, GULL_TOP, GULL_TIP, GULL_TOP);
  // Bottom: the same outline, dropped and wound the other way.
  p.triangle(under(nose), under(left), under(tail), GULL_BELLY, GULL_TIP, GULL_BELLY);
  p.triangle(under(nose), under(tail), under(right), GULL_BELLY, GULL_BELLY, GULL_TIP);

  return p.build('gull');
}

// --- Shared assets ------------------------------------------------------------

/**
 * Two geometries and one material, built once for the whole game.
 *
 * One material for *both* birds, and that is a real saving rather than
 * tidiness: a material is a WebGPU pipeline, `vegetation.ts` and `cars.ts` each
 * already have their own, and a third and a fourth for two objects that are
 * both matte, faceted and vertex-coloured would be two more pipeline compiles
 * on the main thread for no pixel difference at all.
 */
export class BirdAssets {
  readonly ibis: BufferGeometry;
  readonly gull: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  /** Triangles per bird. Reported so the numbers in the header can be checked. */
  readonly ibisTriangles: number;
  readonly gullTriangles: number;

  constructor() {
    this.ibis = buildIbis();
    this.gull = buildGull();
    this.ibisTriangles = (this.ibis.getIndex()?.count ?? 0) / 3;
    this.gullTriangles = (this.gull.getIndex()?.count ?? 0) / 3;

    const material = new MeshStandardNodeMaterial();
    material.name = 'bird';
    // No `colorNode`, exactly as the trees and the cars have none: `NodeMaterial`
    // already multiplies the material colour by the geometry `color` attribute
    // and then by `instanceColor`, so the body, the bill, the legs and the
    // per-bird grubbiness all arrive through two built-in multiplies and no
    // shader graph.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Feathers. Matte, but not as matte as foliage -- a white bird in sun does
    // carry a faint sheen along the back, and at roughness 1.0 it goes chalky.
    material.roughness = 0.82;
    material.metalness = 0.0;
    // Faceted, like everything else low-poly here. Smooth-shading a 20-face body
    // makes it read as a melted egg.
    material.flatShading = true;
    this.material = material;
  }
}

// --- The collision query ------------------------------------------------------

/**
 * The collision world, as much of it as this module is allowed to know.
 *
 * A pair of predicates rather than the `CollisionWorld` itself, for two
 * reasons. It keeps `world/` from importing `player/`, which nothing in
 * `world/` does today; and it keeps the collision *format* out of this
 * feature's dependencies, which is one of the things this pass was told not to
 * touch.
 */
export interface SpawnGuard {
  /**
   * Whether this tile's prisms have been loaded yet.
   *
   * Collision loads on the player's 420 m radius and tiles stream on the
   * camera's 1,800 m one, so a tile can be drawn long before it is solid. A
   * bird validated against an empty collision world would be validated against
   * nothing, so validation waits for this -- which is always true well before a
   * bird is close enough to be simulated at all.
   */
  ready(tileKey: string): boolean;
  /** Whether a world-space point is inside a building. */
  solid(x: number, y: number, z: number): boolean;
}

// --- Ibises -------------------------------------------------------------------

const IDLE_WALK = 0;
const IDLE_PAUSE = 1;
const PECK = 2;
const FLEE = 3;
const HIDDEN = 4;

/** Metres. Spec: "flee on approach", and 4 m is where a real one loses its nerve. */
const FLEE_TRIGGER = 4.0;
/** And 9 m is where it stops caring. The gap is hysteresis -- see `step`. */
const FLEE_RELEASE = 9.0;
const FLEE_SPEED = 3.0;
const FLEE_MIN = 8.0;
const FLEE_SPAN = 7.0;
const WALK_MIN = 0.15;
const WALK_MAX = 0.4;
/** How far from its home point one wanders. Small: an ibis works a patch. */
const HOME_RADIUS = 2.6;
const TURN_RATE = 2.4; // rad/s
/** Radians of stride phase per metre walked. 5.2 is about a 1.2 m stride cycle. */
const GAIT_PER_METRE = 5.2;
const WADDLE_YAW = 0.12;
const WADDLE_ROLL = 0.07;
const PECK_PITCH = 0.55;

/**
 * Where to look for free ground when a spawn lands inside a building, as
 * `[radius scale, bearing swing]` applied to the anchor-to-spawn vector. In
 * order: pull most of the way in, pull nearly all the way in, swing 120 degrees
 * each way at the same radius, then reach out to 1.6x on three more bearings.
 * See `TileIbises.validate` for why both directions are needed.
 */
const RESCUE: ReadonlyArray<readonly [number, number]> = [
  [0.45, 0],
  [0.18, 0],
  [1.0, 2.094],
  [1.0, -2.094],
  [1.6, 1.047],
  [1.6, -1.047],
  [1.6, Math.PI],
];

/** Where a bird was derived from, and where it is put. Tile-local metres. */
export interface IbisSpawn {
  x: number;
  z: number;
  /** The tree or shopfront it came off: free ground, by construction. */
  anchorX: number;
  anchorZ: number;
  seed: number;
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _euler = /*#__PURE__*/ new Euler();
const _scale = /*#__PURE__*/ new Vector3();
const _one = /*#__PURE__*/ new Vector3(1, 1, 1);
const _colour = /*#__PURE__*/ new Color();

/** Shortest angular step from `from` toward `to`, capped at `maxStep`. */
function turnToward(from: number, to: number, maxStep: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + Math.max(-maxStep, Math.min(maxStep, d));
}

/**
 * One tile's ibises: the instanced mesh, and the flat arrays that drive it.
 *
 * All state is a parallel typed array per field rather than an array of
 * objects, which at 190 birds is not really about speed -- it is so the update
 * loop is a straight-line pass with no property lookups in it and its cost is
 * obvious from reading it.
 *
 * Positions are **tile-local**, so the mesh goes in the tile's own group and
 * inherits its world translation, and is hidden, shadowed and disposed with it.
 * That is the same arrangement the trees and the parked cars use, and it is the
 * one thing that keeps a stream-out from leaking a flock of birds into an empty
 * sky.
 */
export class TileIbises {
  readonly mesh: InstancedMesh;
  readonly count: number;

  /** Tile-local metres. `y` is the terrain under the bird, resampled as it walks. */
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  /** The patch it works: the spawn point, moved by a flee. */
  private readonly homeX: Float32Array;
  private readonly homeZ: Float32Array;
  /** The tree or shopfront it was derived from. The fallback for a bad spawn. */
  private readonly anchorX: Float32Array;
  private readonly anchorZ: Float32Array;
  private readonly targetX: Float32Array;
  private readonly targetZ: Float32Array;
  private readonly yaw: Float32Array;
  private readonly speed: Float32Array;
  /** Seconds left in the current state, and how many it started with. */
  private readonly timer: Float32Array;
  private readonly duration: Float32Array;
  /** Advances with distance walked; drives the waddle. */
  private readonly gait: Float32Array;
  /** Metres still to run before a flee ends. */
  private readonly fleeLeft: Float32Array;
  private readonly state: Uint8Array;
  private readonly seed: Uint32Array;
  /** 1 until the spawn point has been checked against the collision prisms. */
  private readonly unchecked: Uint8Array;

  constructor(
    private readonly key: string,
    /** World position of the tile's local origin, for the collision query. */
    private readonly originX: number,
    private readonly originZ: number,
    private readonly groundAt: (x: number, z: number) => number,
    spawns: readonly IbisSpawn[],
    assets: BirdAssets,
  ) {
    const n = spawns.length;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.homeX = new Float32Array(n);
    this.homeZ = new Float32Array(n);
    this.anchorX = new Float32Array(n);
    this.anchorZ = new Float32Array(n);
    this.targetX = new Float32Array(n);
    this.targetZ = new Float32Array(n);
    this.yaw = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.timer = new Float32Array(n);
    this.duration = new Float32Array(n);
    this.gait = new Float32Array(n);
    this.fleeLeft = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.seed = new Uint32Array(n);
    this.unchecked = new Uint8Array(n).fill(1);

    const mesh = new InstancedMesh(assets.ibis, assets.material, n);
    mesh.name = 'ibises';
    // Culled with its tile like every other primitive the streamer loads, and
    // for two reasons rather than one: a per-object frustum test buys nothing
    // over the one box test the tile already does, *and* an `InstancedMesh`
    // bounding sphere is computed from the instance matrices at construction and
    // would be stale the moment a bird walked.
    mesh.frustumCulled = false;
    // Read by `streamer.ts` at disposal, where the geometry is *shared* and must
    // not be released with the tile -- the same contract the trees and the cars
    // have, and the same failure if it is missed: every ibis in the city
    // vanishing the first time the player walks far enough to evict a tile.
    //
    // There is deliberately no `dispose()` on this class. The streamer's
    // teardown is one loop over a tile's children with one rule in it, and a
    // second entry point into the same work is a second thing to keep in step.
    mesh.userData.birds = true;
    this.mesh = mesh;

    for (let i = 0; i < n; i++) {
      const s = spawns[i];
      this.seed[i] = (s.seed >>> 0) || 1;
      this.x[i] = s.x;
      this.z[i] = s.z;
      this.homeX[i] = s.x;
      this.homeZ[i] = s.z;
      this.anchorX[i] = s.anchorX;
      this.anchorZ[i] = s.anchorZ;
      this.targetX[i] = s.x;
      this.targetZ[i] = s.z;
      this.y[i] = groundAt(s.x, s.z);
      this.yaw[i] = hash(s.seed, 7) * Math.PI * 2;
      // Staggered, so a park does not peck in unison -- which is the tell that
      // gives away every instanced crowd ever shipped.
      this.state[i] = hash(s.seed, 8) < 0.5 ? IDLE_PAUSE : IDLE_WALK;
      this.duration[i] = 0.4 + hash(s.seed, 9) * 3.0;
      this.timer[i] = this.duration[i];
      this.speed[i] = this.state[i] === IDLE_WALK ? WALK_MIN + hash(s.seed, 11) * (WALK_MAX - WALK_MIN) : 0;
      this.gait[i] = hash(s.seed, 10) * Math.PI * 2;

      // Grubbiness, +/-5% and biased warm -- an ibis is off-white in a way that
      // varies bird to bird and never goes blue.
      _colour.setRGB(
        1 + (hash(s.seed, 1) - 0.5) * 0.08,
        1 + (hash(s.seed, 2) - 0.5) * 0.07,
        1 + (hash(s.seed, 3) - 0.5) * 0.11 - 0.03,
      );
      mesh.setColorAt(i, _colour);
      this.pose(i);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Advance every bird inside `radius` of the viewer, and leave the rest frozen.
   *
   * `viewer` is the camera, which is the player's eye, so one position answers
   * both of this function's questions -- how close the threat is, and whether
   * the bird is worth simulating -- and they cannot disagree with each other.
   *
   * Returns the number of birds stepped, so the caller can account for the cost.
   */
  update(
    dt: number,
    viewerX: number,
    viewerY: number,
    viewerZ: number,
    radius: number,
    guard: SpawnGuard | null,
  ): number {
    const r2 = radius * radius;
    const ready = guard !== null && guard.ready(this.key);
    let stepped = 0;

    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - viewerX;
      const dz = this.z[i] - viewerZ;
      const d2 = dx * dx + dz * dz;
      // The distance gate, and it is the whole performance story: a bird beyond
      // this is not stepped, not posed and not uploaded. At 150 m an ibis is
      // under two pixels, so freezing it is not a compromise, it is invisible.
      if (d2 > r2) continue;

      // The first time this bird is close enough to matter, check that the hash
      // did not put it inside a wall. Deferred to here rather than done at load,
      // because the prisms load on the *player's* radius and may not exist when
      // the tile does. See `SpawnGuard`.
      if (this.unchecked[i] === 1 && ready && guard !== null) this.validate(i, guard);

      this.step(i, dt, dx, dz, Math.sqrt(d2), viewerY, guard);
      this.pose(i);
      stepped++;
    }

    if (stepped > 0) this.mesh.instanceMatrix.needsUpdate = true;
    return stepped;
  }

  /**
   * Pull a bird out of a building, or give up and hide it.
   *
   * A short fixed list of candidates rather than a rejection loop, and it has to
   * cover two different failures rather than one. The common case is that the
   * *offset* landed in a building and the anchor is clear -- a fig stands in a
   * park and the 3-12 m hash reached the terrace across the fence -- and pulling
   * in toward the anchor fixes it. The other case is that the **anchor itself**
   * is bad, which happens on the retail side by construction: an awning is
   * cantilevered off a wall, so its innermost vertices sit *on* the footprint
   * ring and a ray-crossing test on a boundary point is a coin flip. Pulling in
   * makes that one worse, so the list also swings the bearing and reaches
   * further out.
   *
   * Seven queries, once per bird, ever. If all seven fail the bird is scaled to
   * nothing -- a silent, zero-cost removal, and the honest answer when there is
   * no free ground near the thing it was derived from.
   */
  private validate(i: number, guard: SpawnGuard): void {
    this.unchecked[i] = 0;
    if (!guard.solid(this.x[i] + this.originX, this.y[i], this.z[i] + this.originZ)) return;

    const ax = this.anchorX[i];
    const az = this.anchorZ[i];
    const ox = this.x[i] - ax;
    const oz = this.z[i] - az;
    for (const [scale, swing] of RESCUE) {
      const c = Math.cos(swing);
      const s = Math.sin(swing);
      const nx = ax + (ox * c - oz * s) * scale;
      const nz = az + (ox * s + oz * c) * scale;
      const ny = this.groundAt(nx, nz);
      if (!guard.solid(nx + this.originX, ny, nz + this.originZ)) {
        this.x[i] = nx;
        this.z[i] = nz;
        this.y[i] = ny;
        this.homeX[i] = nx;
        this.homeZ[i] = nz;
        this.targetX[i] = nx;
        this.targetZ[i] = nz;
        return;
      }
    }
    this.state[i] = HIDDEN;
  }

  /**
   * The state machine. Four states and one escape hatch:
   *
   *   IDLE_WALK   stalk toward a point inside the home radius, 0.15-0.4 m/s
   *   IDLE_PAUSE  stand, 0.8-4 s, head up
   *   PECK        pitch the whole bird nose-down and back, 0.55-0.95 s
   *   FLEE        run 3 m/s straight away from the viewer, 8-15 m
   *   HIDDEN      scaled to zero; a spawn that could not be freed from a wall
   *
   * The flee threshold is 4 m and the release is 9 m, and the gap between them
   * is deliberate. With one threshold a bird that stops just outside it starts
   * walking back toward the player immediately, which is the opposite of the
   * behaviour. It also re-homes where it stops, so chasing the birds across a
   * park actually moves them across the park rather than snapping them back.
   */
  private step(
    i: number,
    dt: number,
    dxToViewer: number,
    dzToViewer: number,
    dist: number,
    viewerY: number,
    guard: SpawnGuard | null,
  ): void {
    if (this.state[i] === HIDDEN) return;

    // The threat test runs in every state, so a pecking bird is startled the
    // same as a walking one. It is height-aware only as far as it has to be: a
    // player on a roof six metres up is not a threat to a bird on the footpath,
    // and without this every ibis in a block scatters as you walk over them.
    if (dist < FLEE_TRIGGER && Math.abs(viewerY - this.y[i]) < 3.5) {
      if (this.state[i] !== FLEE) {
        this.fleeLeft[i] = FLEE_MIN + this.rand(i) * FLEE_SPAN;
        this.state[i] = FLEE;
      }
      // Directly away, re-aimed every frame while the threat is close, which is
      // both what they do and the only choice that cannot run into the player.
      // `(dxToViewer, dzToViewer)` is bird-minus-viewer, so it already points
      // away; yaw 0 faces -Z, so the heading that matches it is `atan2(-x, -z)`.
      this.yaw[i] = Math.atan2(-dxToViewer, -dzToViewer);
      this.speed[i] = FLEE_SPEED;
    }

    switch (this.state[i]) {
      case FLEE: {
        const run = this.speed[i] * dt;
        this.fleeLeft[i] -= run;
        this.advance(i, run, guard);
        if (this.fleeLeft[i] <= 0 && dist > FLEE_RELEASE) {
          // Re-home where it stopped. A chased ibis does not walk back.
          this.homeX[i] = this.x[i];
          this.homeZ[i] = this.z[i];
          this.targetX[i] = this.x[i];
          this.targetZ[i] = this.z[i];
          this.enter(i, IDLE_PAUSE, 0.6 + this.rand(i) * 1.2);
          this.speed[i] = 0;
          this.fleeLeft[i] = 0;
        }
        break;
      }

      case IDLE_WALK: {
        const tx = this.targetX[i] - this.x[i];
        const tz = this.targetZ[i] - this.z[i];
        if (Math.hypot(tx, tz) < 0.12) {
          // Arrived. Peck about half the time -- this is a bird that spends most
          // of its day with its bill in something.
          if (this.rand(i) < 0.5) this.enter(i, PECK, 0.55 + this.rand(i) * 0.4);
          else this.enter(i, IDLE_PAUSE, 0.8 + this.rand(i) * 3.2);
          this.speed[i] = 0;
          break;
        }
        // Turn toward the target at a bounded rate rather than snapping, so the
        // path curves. A bird that pivots on the spot reads as a turret.
        this.yaw[i] = turnToward(this.yaw[i], Math.atan2(-tx, -tz), TURN_RATE * dt);
        this.advance(i, this.speed[i] * dt, guard);
        break;
      }

      case PECK:
      case IDLE_PAUSE: {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          // A new spot inside the home radius. Polar with a square root on the
          // radius, so the wander is a uniform disc rather than a distribution
          // that crowds the middle.
          const a = this.rand(i) * Math.PI * 2;
          const r = HOME_RADIUS * Math.sqrt(this.rand(i));
          this.targetX[i] = this.homeX[i] + Math.cos(a) * r;
          this.targetZ[i] = this.homeZ[i] + Math.sin(a) * r;
          this.enter(i, IDLE_WALK, 0);
          this.speed[i] = WALK_MIN + this.rand(i) * (WALK_MAX - WALK_MIN);
        }
        break;
      }
    }
  }

  private enter(i: number, state: number, seconds: number): void {
    this.state[i] = state;
    this.duration[i] = seconds;
    this.timer[i] = seconds;
  }

  /**
   * Move a bird along its heading, refusing to enter a building.
   *
   * The retry is a single 50-degree turn rather than a search: a fleeing ibis
   * that meets a wall runs along it, and one deflection produces exactly that.
   * Only birds actually moving inside the active radius ever reach here, which
   * is a handful a frame.
   */
  private advance(i: number, distance: number, guard: SpawnGuard | null): void {
    if (distance <= 0) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Yaw 0 faces -Z, so a heading is (-sin, -cos) -- the identity
      // `controller.step` derives the player's forward vector from.
      const nx = this.x[i] - Math.sin(this.yaw[i]) * distance;
      const nz = this.z[i] - Math.cos(this.yaw[i]) * distance;
      const ny = this.groundAt(nx, nz);
      if (guard === null || !guard.solid(nx + this.originX, ny, nz + this.originZ)) {
        this.x[i] = nx;
        this.z[i] = nz;
        this.y[i] = ny;
        // The gait phase advances with *distance*, not with time, so the waddle
        // stays in step with the walk at any speed and stops dead when the bird
        // does.
        this.gait[i] = (this.gait[i] + distance * GAIT_PER_METRE) % (Math.PI * 2);
        return;
      }
      this.yaw[i] += 0.9;
    }
  }

  /**
   * Compose one instance matrix.
   *
   * Three things ride on the same rotation and there are no bones anywhere:
   *
   *   - **yaw** is the heading plus a waddle wobble. An ibis walks with its
   *     whole body swinging side to side, and 7 degrees of yaw oscillation at
   *     the stride frequency is what sells a two-legged gait without legs.
   *   - **pitch** is the peck: the whole bird tips nose-down, which takes the
   *     bill tip from 0.54 m to 0.26 m and reaches it 20 cm forward. The feet
   *     stay on the ground because the instance origin is between them.
   *   - **roll** is the same wobble at half amplitude and a quarter cycle off,
   *     which turns a flat side-to-side yaw into something that reads as weight
   *     transferring between two legs.
   *
   * The Euler order is `YXZ` -- yaw first in world, then pitch and roll in the
   * bird's own frame -- which is the order `applyToCamera` uses and for the same
   * reason: in any other order pitch depends on heading.
   */
  private pose(i: number): void {
    if (this.state[i] === HIDDEN) {
      _matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _matrix);
      return;
    }

    const walking = this.speed[i] > 0.01;
    const swing = walking ? Math.sin(this.gait[i]) : 0;
    const wobble = walking ? WADDLE_YAW * swing : 0;
    const roll = walking ? WADDLE_ROLL * Math.sin(this.gait[i] + Math.PI * 0.5) : 0;
    // The bob is |sin|, not sin: a body rises once per *step*, twice per stride.
    const bob = walking ? Math.abs(swing) * 0.014 : 0;

    let pitch = 0;
    if (this.state[i] === PECK && this.duration[i] > 0) {
      // A half sine over the state's whole duration -- down and back up with no
      // discontinuity at either end, and no second timer to keep in step.
      const t = 1 - Math.max(this.timer[i], 0) / this.duration[i];
      pitch = -PECK_PITCH * Math.sin(t * Math.PI);
    }

    _euler.set(pitch, this.yaw[i] + wobble, roll, 'YXZ');
    _quaternion.setFromEuler(_euler);
    _position.set(this.x[i], this.y[i] + bob, this.z[i]);
    _matrix.compose(_position, _quaternion, _one);
    this.mesh.setMatrixAt(i, _matrix);
  }

  /** A fresh 0..1 draw for this bird, advancing its own stream. */
  private rand(i: number): number {
    // xorshift32 on the per-bird seed: three shifts and three xors, and each
    // bird's sequence stays independent of every other bird's without a shared
    // generator anyone has to reason about.
    let s = this.seed[i];
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed[i] = s >>> 0;
    return (this.seed[i] >>> 8) / 0x01000000;
  }
}

// --- Deriving a tile's ibises -------------------------------------------------

/** Ibises per park tile. Deliberately few: this is a bird you notice, not a swarm. */
const PARK_MIN = 2;
const PARK_SPAN = 4; // 2..5 inclusive
/** A retail strip gets one or two, on the footpath where the bins would be. */
const RETAIL_MIN = 1;
const RETAIL_SPAN = 2; // 1..2
/**
 * Awning triangles a tile needs before it counts as a retail strip.
 *
 * An awning run is 10 triangles (`world/awning.ts`), so 400 is 40 runs -- twenty
 * or so shopfronts. Measured over the inner ring that admits 41 of the 221
 * tiles, which is the right shape for a city whose retail is in strips: the
 * spawn tile is the second-heaviest in the build at 196 runs, and the median
 * tile has five.
 */
const RETAIL_TRIANGLES = 400;

/** How far from its tree an ibis spawns. Near the figs, not under them. */
const SPAWN_NEAR = 3.0;
const SPAWN_FAR = 12.0;

/**
 * Derive one tile's ibises from what the tile already carries.
 *
 * `veg` is the sidecar the trees were built from, and `awningPositions` is the
 * `awning_fascia` primitive's vertex buffer -- both tile-local. `tileX/tileZ`
 * are the tile's world corner, and they are what is hashed rather than the tile
 * key, so the derivation is a pure function of *where* the tile is: a park's
 * ibises stand in the same places every session and after every stream-out.
 * That matters more than it sounds. A tile that reloads with its birds
 * reshuffled is a tile that visibly blinks when you turn around.
 *
 * Returns null for a tile with nothing to hang a bird on, which is most of the
 * CBD -- and that is correct. There are no ibises in the middle of Hunter
 * Street.
 */
export function buildTileIbises(
  key: string,
  tileX: number,
  tileZ: number,
  tileSize: number,
  veg: TileVegetation | null,
  awningPositions: Float32Array | null,
  awningTriangles: number,
  assets: BirdAssets,
  groundAt: (x: number, z: number) => number,
): TileIbises | null {
  const tx = Math.round(tileX);
  const tz = Math.round(tileZ);
  const spawns: IbisSpawn[] = [];

  // --- Parks. Species 0 is the Moreton Bay fig and 5 the eucalypt: the two the
  // pipeline scatters through park interiors. Every other species is a street
  // tree, and a street tree is a verge rather than a park.
  const parkTrees: number[] = [];
  if (veg !== null) {
    for (let i = 0; i < veg.count; i++) {
      const s = veg.species[i];
      if (s === 0 || s === 5) parkTrees.push(i);
    }
  }
  if (veg !== null && parkTrees.length > 0) {
    const wanted = PARK_MIN + Math.floor(hash(tx, tz, 101) * PARK_SPAN);
    for (let n = 0; n < wanted; n++) {
      // Spread across the tile's park trees rather than clustering on the first
      // few: an ibis under every fig is the read, not five under one.
      const pick = parkTrees[Math.floor(hash(tx, tz, n, 102) * parkTrees.length) % parkTrees.length];
      const a = hash(tx, tz, n, 103) * Math.PI * 2;
      const r = SPAWN_NEAR + hash(tx, tz, n, 104) * (SPAWN_FAR - SPAWN_NEAR);
      spawns.push({
        x: veg.x[pick] + Math.cos(a) * r,
        z: veg.z[pick] + Math.sin(a) * r,
        // The anchor is the tree, not the offset -- `validate` pulls a bad spawn
        // back toward one, and a tree is guaranteed not to be inside a building.
        anchorX: veg.x[pick],
        anchorZ: veg.z[pick],
        seed: Math.floor(hash(tx, tz, n, 105) * 0xffffffff) || 1,
      });
    }
  }

  // --- Retail. The awning fascia is the one primitive in the build that marks a
  // shopping strip exactly, and its vertices already sit over the footpath.
  if (awningPositions !== null && awningTriangles >= RETAIL_TRIANGLES) {
    const wanted = RETAIL_MIN + Math.floor(hash(tx, tz, 201) * RETAIL_SPAN);
    const verts = Math.floor(awningPositions.length / 3);
    // Stride through the buffer rather than taking the first few vertices, which
    // would put both birds on the same shopfront.
    const stride = Math.max(1, Math.floor(verts / (wanted * 9)));
    let v = Math.floor(hash(tx, tz, 202) * stride);
    for (let n = 0; n < wanted && v < verts; n++, v += stride) {
      const ax = awningPositions[v * 3];
      const az = awningPositions[v * 3 + 2];
      // Out from under the canopy by a metre or two, which is where a gutter and
      // a bin are and therefore where the bird is.
      const a = hash(tx, tz, n, 203) * Math.PI * 2;
      const r = 1.2 + hash(tx, tz, n, 204) * 1.8;
      spawns.push({
        x: ax + Math.cos(a) * r,
        z: az + Math.sin(a) * r,
        anchorX: ax,
        anchorZ: az,
        seed: Math.floor(hash(tx, tz, n, 205) * 0xffffffff) || 1,
      });
    }
  }

  if (spawns.length === 0) return null;
  // The tile's group sits at `(minX, 0, minZ + tileSize)` -- tile-local x runs
  // 0..tileSize west to east and local z runs -tileSize..0 north to south, which
  // is the frame every tile-local sidecar is written in. That offset is what
  // takes a bird back to world space for the collision query, and nothing else
  // in this module needs it.
  return new TileIbises(key, tileX, tileZ + tileSize, groundAt, spawns, assets);
}

// --- Gull flocks --------------------------------------------------------------

/** Flocks resident at once. Four is a sky with birds in it; eight is Hitchcock. */
const FLOCKS = 4;
const GULLS_MIN = 5;
const GULLS_MAX = 9;
const PER_FLOCK = GULLS_MAX;
const MAX_GULLS = FLOCKS * PER_FLOCK;

/**
 * Where a flock is put when it respawns, and where it is taken away.
 *
 * Both are far enough out that the transition cannot be seen. A 1.15 m gull at
 * 240 m subtends 0.27 degrees, which at this project's 72-degree vertical field
 * on a 1440-line display at 0.75 render scale is **four pixels** -- and it
 * arrives at scale zero and grows over two seconds, so what actually appears is
 * a sub-pixel dot swelling to four. Nothing pops.
 *
 * The alternative the brief offered, an opacity fade, needs either a
 * transparent material for the whole sky or one material per flock. Scale costs
 * nothing and lives in the instance matrix that is being written anyway.
 */
const SPAWN_MIN = 240;
const SPAWN_SPAN = 160;
const DESPAWN = 520;
const FADE_SECONDS = 2.0;

/** Metres above the camera. A gull over a Sydney street is not high. */
const ALTITUDE_MIN = 25;
const ALTITUDE_SPAN = 35;
const ORBIT_MIN = 15;
const ORBIT_SPAN = 25;
/** Metres per second along the orbit. A gliding silver gull, not a swift. */
const ORBIT_SPEED_MIN = 6.5;
const ORBIT_SPEED_SPAN = 5.0;
/** How fast the whole flock's centre drifts. Slow: this is soaring, not commuting. */
const DRIFT_SPEED = 1.6;

/**
 * Gulls, wheeling.
 *
 * One `InstancedMesh` in world space for the entire sky -- **one draw call**,
 * 36 instances, 144 triangles -- rather than one per flock. It is in no tile's
 * group and is never evicted: a flock is a property of where the camera is, not
 * of which tiles happen to be resident, and hanging it off a tile would make the
 * birds vanish whenever the ground under them streamed out.
 *
 * The animation is a **bank**, not a flap, and the choice was made on what
 * survives at the distance these are seen. A gull orbiting 30 m up and 25 m out
 * is 40 m away at its closest and typically 100-300 m; at 40 m it is thirty
 * pixels across and at 200 m it is six. A wing-position morph is a change of a
 * pixel or two *inside* that silhouette. A roll is a change of the whole
 * silhouette -- a white bar to a line and back -- and it swaps which of the two
 * faces is visible, the top at rgb(243, 246, 251) or the underside at
 * rgb(73, 62, 40). That is a 180-code-value flash on a six-pixel object, twice
 * a circuit, and it is legible exactly where a morph is not. It also costs
 * nothing: the roll goes into an instance matrix that has to be composed for
 * the orbit position regardless.
 *
 * The bank angle is not decorative either. A coordinated turn has
 * `tan(bank) = v^2 / (r g)`, which at 9 m/s on a 25 m radius is 18 degrees -- so
 * the constant part of the roll below is the turn the orbit *implies*, and the
 * oscillation on top of it is the correction a real bird is always making.
 */
export class GullFlocks {
  readonly mesh: InstancedMesh;

  /** Flock state. Centre in world metres. */
  private readonly cx = new Float32Array(FLOCKS);
  private readonly cy = new Float32Array(FLOCKS);
  private readonly cz = new Float32Array(FLOCKS);
  private readonly driftX = new Float32Array(FLOCKS);
  private readonly driftZ = new Float32Array(FLOCKS);
  private readonly radius = new Float32Array(FLOCKS);
  private readonly omega = new Float32Array(FLOCKS);
  private readonly bank = new Float32Array(FLOCKS);
  private readonly members = new Uint8Array(FLOCKS);
  /** 0..1. Grows in over `FADE_SECONDS`, and runs backwards on the way out. */
  private readonly fade = new Float32Array(FLOCKS);
  private readonly dying = new Uint8Array(FLOCKS);
  private readonly generation = new Uint32Array(FLOCKS);
  /** Orbit angle, wrapped every revolution so it cannot lose precision. */
  private readonly angle = new Float32Array(FLOCKS);

  /** Per gull, indexed `f * PER_FLOCK + m`. */
  private readonly phase = new Float32Array(MAX_GULLS);
  private readonly radialK = new Float32Array(MAX_GULLS);
  private readonly bobPhase = new Float32Array(MAX_GULLS);

  /** Seconds, wrapped. Only ever advanced by the caller's clamped frame delta. */
  private clock = 0;

  constructor(assets: BirdAssets) {
    const mesh = new InstancedMesh(assets.gull, assets.material, MAX_GULLS);
    mesh.name = 'gulls';
    mesh.frustumCulled = false;
    // No shadow either way. A 1.15 m bird 40 m up writes two texels into a
    // 2048-texel map covering 440 m, which is aliasing rather than shadow -- the
    // same call `power.ts` makes about its wires, from the same arithmetic.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;

    // Every flock starts dead and infinitely far away, so the first `update`
    // places all four around wherever the camera turns out to be.
    for (let f = 0; f < FLOCKS; f++) {
      this.members[f] = 0;
      this.cx[f] = Infinity;
      this.dying[f] = 1;
    }
    _matrix.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_GULLS; i++) mesh.setMatrixAt(i, _matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * One frame. `dt` is the *clamped* frame delta, so a tab that was hidden for
   * an hour advances the orbit by one step rather than by an hour -- `main.ts`
   * already clamps it for the player simulation and the same number serves
   * here, which is why this takes it as an argument rather than reading a clock.
   */
  update(dt: number, camX: number, camY: number, camZ: number): void {
    this.clock = (this.clock + dt) % 1000;

    for (let f = 0; f < FLOCKS; f++) {
      const dx = this.cx[f] - camX;
      const dz = this.cz[f] - camZ;
      const dist = Math.hypot(dx, dz);

      if (!Number.isFinite(dist) || dist > DESPAWN) this.dying[f] = 1;
      if (this.dying[f] === 1) {
        this.fade[f] -= dt / FADE_SECONDS;
        if (this.fade[f] <= 0) this.respawn(f, camX, camY, camZ);
      } else if (this.fade[f] < 1) {
        this.fade[f] = Math.min(1, this.fade[f] + dt / FADE_SECONDS);
      }

      // The centre drifts, and the drift is turned by a slow sine rather than
      // re-rolled: a random walk on a 1.6 m/s velocity produces a flock that
      // jitters in place, where a *turning* one traces the long lazy arc a
      // soaring flock actually traces.
      const turn = Math.sin(this.clock * 0.11 + f * 2.4) * 0.25 * dt;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const nx = this.driftX[f] * c - this.driftZ[f] * s;
      const nz = this.driftX[f] * s + this.driftZ[f] * c;
      this.driftX[f] = nx;
      this.driftZ[f] = nz;
      this.cx[f] += nx * dt;
      this.cz[f] += nz * dt;

      this.angle[f] = (this.angle[f] + this.omega[f] * dt) % (Math.PI * 2);
      this.pose(f);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Place a flock on a ring around the camera.
   *
   * The bearing is hashed from the camera's 200 m cell plus a per-flock
   * generation counter, which is what "tied to the camera position" buys: walk a
   * kilometre and the flocks that reappear are somewhere else, stand still and
   * they come back roughly where they were, and the four never stack up on one
   * bearing the way four independent random draws periodically would.
   */
  private respawn(f: number, camX: number, camY: number, camZ: number): void {
    const cell = Math.floor(camX / 200) * 73856093 + Math.floor(camZ / 200) * 19349663;
    const g = ++this.generation[f];
    // Quartered, so the four flocks are spread around the compass rather than
    // free to bunch.
    const bearing = ((f + hash(cell, f, g, 1)) / FLOCKS) * Math.PI * 2;
    const dist = SPAWN_MIN + hash(cell, f, g, 2) * SPAWN_SPAN;

    this.cx[f] = camX + Math.cos(bearing) * dist;
    this.cz[f] = camZ + Math.sin(bearing) * dist;
    // Altitude is measured off the camera because the camera is on the ground:
    // world y runs 30-60 m *below* the datum over most of this city, so an
    // absolute altitude would put a flock underground in Alexandria and in orbit
    // over the CBD. It is fixed at spawn and then left alone, so a player
    // walking downhill does not drag the flock down with them.
    this.cy[f] = camY + ALTITUDE_MIN + hash(cell, f, g, 3) * ALTITUDE_SPAN;

    const heading = hash(cell, f, g, 4) * Math.PI * 2;
    this.driftX[f] = Math.cos(heading) * DRIFT_SPEED;
    this.driftZ[f] = Math.sin(heading) * DRIFT_SPEED;

    this.radius[f] = ORBIT_MIN + hash(cell, f, g, 5) * ORBIT_SPAN;
    const speed = ORBIT_SPEED_MIN + hash(cell, f, g, 6) * ORBIT_SPEED_SPAN;
    this.omega[f] = (speed / this.radius[f]) * (hash(cell, f, g, 7) < 0.5 ? -1 : 1);
    // tan(bank) = v^2 / (r g): the turn the orbit implies, not a number picked
    // for looking right. 6.5-11.5 m/s on 15-40 m comes out at 9 to 34 degrees.
    this.bank[f] = Math.atan((speed * speed) / (this.radius[f] * 9.81));

    const n = GULLS_MIN + Math.floor(hash(cell, f, g, 8) * (GULLS_MAX - GULLS_MIN + 1));
    this.members[f] = Math.min(n, PER_FLOCK);
    for (let m = 0; m < PER_FLOCK; m++) {
      const i = f * PER_FLOCK + m;
      // Evenly spaced around the orbit and then jittered, so the flock is a
      // ragged ring rather than a clock face.
      this.phase[i] = (m / Math.max(n, 1)) * Math.PI * 2 + (hash(cell, f, g, m, 9) - 0.5) * 0.7;
      this.radialK[i] = 0.78 + hash(cell, f, g, m, 10) * 0.4;
      this.bobPhase[i] = hash(cell, f, g, m, 11) * Math.PI * 2;
    }

    this.fade[f] = 0;
    this.dying[f] = 0;
    this.angle[f] = hash(cell, f, g, 12) * Math.PI * 2;
  }

  /** Write one flock's instance matrices. */
  private pose(f: number): void {
    // A smoothstep on the fade, so the growth has no visible corner at either
    // end rather than starting and stopping abruptly.
    const t = Math.max(0, Math.min(1, this.fade[f]));
    const scale = t * t * (3 - 2 * t);
    const n = this.members[f];
    const dir = this.omega[f] >= 0 ? 1 : -1;

    for (let m = 0; m < PER_FLOCK; m++) {
      const i = f * PER_FLOCK + m;
      if (m >= n || scale <= 0.001) {
        _matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _matrix);
        continue;
      }

      const a = this.angle[f] + this.phase[i];
      const r = this.radius[f] * this.radialK[i];
      const x = this.cx[f] + Math.cos(a) * r;
      const z = this.cz[f] + Math.sin(a) * r;
      // Each gull rides its own slow altitude sine, so the flock is a shell
      // rather than a disc. 2.4 m over ten seconds is a glide, not a bounce.
      const y = this.cy[f] + Math.sin(this.clock * 0.62 + this.bobPhase[i]) * 2.4;

      // The tangent to the orbit, signed by the direction of travel. The
      // geometry's nose is -Z and (0, 0, -1) rotated by yaw gives
      // (-sin, 0, -cos), so `atan2(-tx, -tz)` points the nose along it -- the
      // same identity the player controller derives its forward vector from.
      const tx = -Math.sin(a) * dir;
      const tz = Math.cos(a) * dir;
      const yaw = Math.atan2(-tx, -tz);

      // Bank into the turn. After the yaw, the gull's local +X points at the
      // orbit centre when it is travelling anticlockwise, so a negative roll
      // drops the inside wing -- and the sign flips with the direction of travel.
      const rock = Math.sin(this.clock * 1.15 + this.bobPhase[i] * 1.7) * 0.22;
      _euler.set(0, yaw, -dir * this.bank[f] + rock, 'YXZ');
      _quaternion.setFromEuler(_euler);
      _position.set(x, y, z);
      _scale.set(scale, scale, scale);
      _matrix.compose(_position, _quaternion, _scale);
      this.mesh.setMatrixAt(i, _matrix);
    }
  }

  /** Gulls currently in the air. Reported on the debug overlay. */
  get count(): number {
    let n = 0;
    for (let f = 0; f < FLOCKS; f++) if (this.fade[f] > 0.001) n += this.members[f];
    return n;
  }
}

