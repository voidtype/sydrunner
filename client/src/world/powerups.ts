/**
 * Spec 8.3's floating icons: a lightning bolt over every station entrance and a
 * coffee cup over every cafe, spinning, bobbing, and visible through the city.
 *
 * *"Both spawn as floating rotating icons at the mapped coordinate, visible
 * through geometry to 60 m with a soft outline."* That is one sentence and
 * three separate rendering problems, and this file is the three of them.
 *
 * The *gameplay* half -- who picked what up, what it did, when it comes back --
 * is `game/powerups.ts` and is deliberately not here. Nothing in this file
 * decides anything; it is handed the point states each frame and draws them,
 * exactly as `dummies.ActorDriver` is handed a `CombatantState` and poses it.
 *
 * ---------------------------------------------------------------------------
 * **Seeing it through a building: three passes, and why not one.**
 *
 * The obvious implementation is one mesh with `depthTest: false`, and it fails
 * on the first street you try it in. A powerup drawn with no depth test at all
 * is drawn *over everything at every distance*, so a cafe icon in Alexandria
 * paints itself on the CBD skyline from two kilometres away and the frame fills
 * with floating cups. The spec's "to 60 m" is not a nicety, it is the clause
 * that makes the feature usable, and it has to be in the shader because the
 * distance is per fragment and per instance.
 *
 * So each icon is drawn up to three times:
 *
 *   1. **The solid**, ordinary depth test, ordinary depth write. This is what
 *      you see when nothing is in the way, and it is the only pass that can be
 *      occluded by the icon's own far side.
 *   2. **The ghost**, the same geometry with `depthTest: false`,
 *      `depthWrite: false`, `transparent: true` and an opacity that is a
 *      function of distance from the camera -- full inside `GHOST_FULL`, zero
 *      beyond `GHOST_FADE`, smoothstepped between. Through a wall this is all
 *      you see; in the open it lands on top of the solid and lifts it slightly,
 *      which is a glow and is welcome.
 *   3. **The shell**, the ghost's geometry scaled by `SHELL_SCALE` with
 *      `side: BackSide` and a squared rim term on its opacity. Rendering only
 *      the *inside* of a slightly larger copy puts a sliver outside the real
 *      silhouette; the rim term is what stops the rest of it washing over the
 *      icon, since a depth-free pass cannot be masked by the solid in front of
 *      it. Together they are the "soft outline" the spec asks for -- one draw,
 *      no post-process, no second render target, and it survives the wall
 *      because it is in the same depth-free pass as the ghost.
 *
 * Three things about that were read out of three r185 rather than assumed:
 *
 *   - **A `transparent` material is drawn after every opaque one.** The WebGPU
 *     renderer keeps two lists and flushes opaque first, so the ghost and the
 *     shell cannot be painted over by the building they are meant to show
 *     through, regardless of the order the tiles streamed in.
 *   - **`renderOrder` beats depth in the transparent sort**, so the shell is
 *     pinned before the ghost and the outline stays behind the icon rather than
 *     over it. Without it the two sort by camera distance and the shell -- which
 *     is genuinely nearer on its front half -- wins about half the time and the
 *     icon reads as a blob.
 *   - **`positionWorld` includes the instance matrix.** `NodeMaterial`'s
 *     `setupPosition` applies `instanceMatrix` to `positionLocal` before any
 *     node runs, which is the same fact `world/vegetation.ts` documents about
 *     its sway; it is what lets one shared material fade 800 icons at 800
 *     different distances.
 *
 * The fade is on `opacityNode` rather than on the colour because `NodeMaterial`
 * folds opacity into the alpha the blend actually uses; multiplying the colour
 * of an alpha-blended fragment darkens it toward black instead of fading it out.
 *
 * ---------------------------------------------------------------------------
 * **Both icons are unlit, and that is the same call `furniture.ts` makes about
 * a signal lamp.**
 *
 * A powerup is a marker, not an object in the world: it is not standing on the
 * footpath, it has no shadow, and its readability must not depend on whether
 * the terrace beside it is between it and the sun. A `MeshStandardNodeMaterial`
 * would put the Training bolt at a quarter brightness on the shaded side of
 * every street, which is exactly where a player most needs to see it.
 *
 * What replaces the shading is baked into the geometry: every face carries a
 * vertex colour tinted by its own normal, so the two icons still read as solid
 * objects turning in space rather than as flat cut-outs. It costs nothing, it
 * cannot go black, and it does not change when the sun moves. `instanceColor`
 * then multiplies the whole thing by the kind's tint, which is the same two
 * built-in multiplies `cars.ts`, `power.ts` and `furniture.ts` all rely on, and
 * means the entire feature is three materials for the whole world.
 *
 * ---------------------------------------------------------------------------
 * **What the two shapes are, and their cost.**
 *
 * A bolt is 24 triangles and a cup is 68. Both are built from the same
 * primitive helpers the rest of the world's props use and neither carries a UV,
 * because nothing here is textured. Every face carries its own three vertices,
 * which is what makes the derived normal and the baked shade exact -- and it is
 * why 92 triangles come to 276 vertices.
 *
 * The bolt is two slanted prisms sharing a waist rather than one extruded
 * concave outline, and the reason is triangulation: a lightning outline is a
 * six-vertex *concave* polygon and needs an ear clipper to cap, where two
 * parallelograms need none at all. The seam where they cross is inside the
 * union from every angle a player can see it from.
 *
 * The cup is a ten-sided tapered barrel with a fan at each end and a four-
 * segment square-section handle -- a torus arc without the second ring of
 * subdivision, because at the size this is drawn the handle is a *hole*, and
 * whether the bar around the hole is round or square is invisible. The coffee
 * itself is the top fan, and it is the one place the vertex colour is doing
 * something other than shading: a flat white is a pale cup with a darker disc
 * in it, and without that disc a cream cylinder is a candle.
 */

import { Fn, cameraPosition, normalView, positionWorld, smoothstep } from 'three/tsl';
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';

/** Must match `pipeline/sydney/powerups.py` and `game/powerups.ts`. */
export const TRAINING = 0;
export const FLAT_WHITE = 1;
export const KIND_COUNT = 2;

/** Fixed record stride in a `.pow.bin`. Set by `tiles.write_powerups`. */
const STRIDE = 16;

// --- The look -----------------------------------------------------------------

/**
 * Per-kind tint, linear, applied through `instanceColor`.
 *
 * Warm gold for Training and cream for Flat White, and the pair was chosen for
 * separation against the city rather than for prettiness: the two must be
 * distinguishable at 60 m through a wall, where each is a few pixels of flat
 * colour with no shape left. Gold sits at Y' 187 and cream at Y' 233 under this
 * rig's tone curve -- 46 code values apart, which is four times the dozen a
 * viewer stops resolving at -- and they differ in *hue* as well, so the
 * distinction survives a player who cannot separate the two brightnesses.
 */
const KIND_COLOUR: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 0.72, 0.16], // Training: warm gold
  [0.97, 0.93, 0.82], // Flat White: cream
];

/** Metres above the ground the icon floats, before the bob. Spec 8.3's "floating". */
const HOVER_HEIGHT = 1.2;
/** Revolutions per second. Spec-free; fast enough to read as spinning, slow enough not to strobe. */
const SPIN_RATE = 0.8;
/** Bob amplitude, metres, and its period in seconds. */
const BOB_AMPLITUDE = 0.15;
const BOB_PERIOD = 2.6;
/** Overall size. Both icons are authored in a roughly unit box and scaled here. */
const ICON_SCALE = 0.62;

/**
 * How far the through-wall ghost reaches, metres, and where it starts to go.
 *
 * 60 is spec 8.3's number verbatim. The 45 is the fade-in edge, and 15 m of
 * ramp is what stops a line of cafes down King Street switching on together as
 * the player walks: at a sprint of 8.2 m/s the ramp is 1.8 s, which reads as
 * something coming into view rather than as a pop.
 */
const GHOST_FULL = 45;
const GHOST_FADE = 60;

/**
 * Peak opacity of the depth-free pass, and of the outline shell behind it.
 *
 * The shell's is much the higher of the two and that is not a contradiction:
 * it is multiplied by a squared rim term, so 0.5 is what the silhouette edge
 * gets and the middle of the shell gets almost nothing. See `distanceFade`.
 */
const GHOST_OPACITY = 0.28;
const SHELL_OPACITY = 0.5;
/** How much bigger the outline shell is than the icon. */
const SHELL_SCALE = 1.15;

/**
 * The pickup animation, in seconds, and how big it gets.
 *
 * A quick scale-pop and out. Spec 8.3 says the point *respawns* and says
 * nothing about a marker while it is gone, so there is deliberately no ghost,
 * no dimmed icon and no countdown ring in the world -- an empty spot is the
 * honest signal that the thing is not there, and a dimmed one would be a second
 * kind of icon to learn.
 */
const POP_SECONDS = 0.26;
const POP_SCALE = 1.9;

// --- Geometry -----------------------------------------------------------------

/**
 * Baked shading, as a per-face multiplier on the vertex colour.
 *
 * A cheap two-term hemisphere: up-facing faces are brightest, down-facing
 * darkest, and the side facing world +X gets a touch more than the one facing
 * -X so a spinning icon's facets change as it turns. It is not a light and does
 * not pretend to be -- it is the *shape* information an unlit material throws
 * away, put back at author time where the sun cannot reach it.
 */
function bakedShade(nx: number, ny: number): number {
  return 0.72 + 0.24 * (ny * 0.5 + 0.5) + 0.06 * nx;
}

/** A growable triangle-soup builder. Every face gets its own vertices, so a
 * per-face normal and a per-face baked colour are both exact. */
class Soup {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly color: number[] = [];

  /** One triangle, wound a-b-c, with the normal derived from that winding.
   *
   * Derived rather than passed, on the argument the pipeline's own winding
   * audit makes at length: a stored normal and a vertex order that are supplied
   * separately are two things that can disagree, and a face lit by a normal
   * pointing into its own solid is invisible for a reason nothing in the
   * picture explains. `tint` scales the baked shade for faces that are a
   * different material -- the coffee in the cup.
   */
  tri(a: Vector3, b: Vector3, c: Vector3, tint: readonly [number, number, number] = [1, 1, 1]): void {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const k = bakedShade(nx, ny);
    for (const p of [a, b, c]) {
      this.position.push(p.x, p.y, p.z);
      this.normal.push(nx, ny, nz);
      this.color.push(k * tint[0], k * tint[1], k * tint[2]);
    }
  }

  /** A quad as two triangles, wound a-b-c-d. */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, tint?: readonly [number, number, number]): void {
    this.tri(a, b, c, tint);
    this.tri(a, c, d, tint);
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    g.name = name;
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * A closed prism over a planar convex polygon in the XY plane, `depth` thick in
 * Z, centred on z = 0. The only primitive the bolt needs.
 */
function prism(soup: Soup, ring: ReadonlyArray<readonly [number, number]>, depth: number): void {
  const h = depth * 0.5;
  const front = ring.map(([x, y]) => new Vector3(x, y, h));
  const back = ring.map(([x, y]) => new Vector3(x, y, -h));
  // Caps as fans. Safe here and only here: `prism` is documented convex, and the
  // bolt is two convex parallelograms precisely so this stays true.
  for (let i = 1; i < ring.length - 1; i++) {
    soup.tri(front[0], front[i], front[i + 1]);
    soup.tri(back[0], back[i + 1], back[i]);
  }
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    soup.quad(front[i], back[i], back[j], front[j]);
  }
}

/**
 * The Training bolt: 24 triangles.
 *
 * Two slanted parallelograms overlapping at the waist, which is a lightning
 * bolt and needs no ear clipper. Authored in a roughly 0.5 x 1.0 box so
 * `ICON_SCALE` is the only size in the file.
 */
function buildBolt(): BufferGeometry {
  const soup = new Soup();
  const t = 0.13; // thickness in Z
  // Upper stroke: top right, down-left to the waist.
  prism(
    soup,
    [
      [0.24, 0.52],
      [0.04, 0.52],
      [-0.16, 0.04],
      [0.04, 0.04],
    ],
    t,
  );
  // Lower stroke: starts to the *right* of where the upper one ended, which is
  // the offset that makes the pair read as a zigzag rather than as a slash.
  prism(
    soup,
    [
      [0.16, 0.06],
      [-0.04, 0.06],
      [-0.24, -0.52],
      [-0.04, -0.52],
    ],
    t,
  );
  return soup.build('powerup_bolt');
}

/** The coffee in the cup, as a multiplier on the cream tint. */
const CREMA: readonly [number, number, number] = [0.52, 0.36, 0.24];

/**
 * The Flat White cup: 68 triangles.
 *
 * A ten-sided barrel, tapered the way a cup is, with a square-section handle on
 * the +X side. The rim sits a little proud of the coffee disc so the two read
 * apart at a glance.
 */
function buildCup(): BufferGeometry {
  const soup = new Soup();
  const sides = 10;
  const rTop = 0.30;
  const rBottom = 0.22;
  const yTop = 0.28;
  const yBottom = -0.30;

  const at = (i: number, r: number, y: number): Vector3 => {
    const a = (i / sides) * Math.PI * 2;
    return new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  };

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    soup.quad(at(i, rBottom, yBottom), at(i, rTop, yTop), at(j, rTop, yTop), at(j, rBottom, yBottom));
  }
  // Base, wound so its normal points down.
  const base0 = at(0, rBottom, yBottom);
  for (let i = 1; i < sides - 1; i++) {
    soup.tri(base0, at(i + 1, rBottom, yBottom), at(i, rBottom, yBottom));
  }
  // The coffee: the same fan 30 mm below the rim, in crema brown.
  const surfaceY = yTop - 0.03;
  const top0 = at(0, rTop * 0.93, surfaceY);
  for (let i = 1; i < sides - 1; i++) {
    soup.tri(top0, at(i, rTop * 0.93, surfaceY), at(i + 1, rTop * 0.93, surfaceY), CREMA);
  }

  // The handle: four segments of a semicircular arc on +X, square section.
  const segments = 4;
  const arcR = 0.17;
  const barR = 0.045;
  const centre = new Vector3(rTop * 0.92, 0.0, 0);
  const ringAt = (k: number): Vector3[] => {
    // Sweep from -100 to +100 degrees about the cup's axis direction, so the
    // handle leaves and rejoins the wall rather than floating beside it.
    const a = (-100 + (200 * k) / segments) * (Math.PI / 180);
    const cx = centre.x + Math.cos(a) * arcR;
    const cy = centre.y + Math.sin(a) * arcR;
    // Section corners in the plane perpendicular to the sweep: the local radial
    // direction and the cup's Z.
    const rx = Math.cos(a);
    const ry = Math.sin(a);
    return [
      new Vector3(cx + rx * barR, cy + ry * barR, barR),
      new Vector3(cx + rx * barR, cy + ry * barR, -barR),
      new Vector3(cx - rx * barR, cy - ry * barR, -barR),
      new Vector3(cx - rx * barR, cy - ry * barR, barR),
    ];
  };
  let prev = ringAt(0);
  for (let k = 1; k <= segments; k++) {
    const next = ringAt(k);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      soup.quad(prev[i], next[i], next[j], prev[j]);
    }
    prev = next;
  }
  return soup.build('powerup_cup');
}

// --- Materials ----------------------------------------------------------------

/**
 * The distance gate, as a TSL node. Shared by the ghost and the shell, so the
 * two can never fade on different curves.
 */
function distanceFade(peak: number, rimOnly = false): MeshBasicNodeMaterial['opacityNode'] {
  return Fn(() => {
    // `positionWorld` carries the instance matrix -- see the header.
    const d = positionWorld.distance(cameraPosition);
    // Written as an ascending smoothstep and inverted rather than as a
    // descending one: WGSL's `smoothstep` is undefined when `edge0 > edge1`, and
    // the descending form compiles, runs, and returns whatever the hardware
    // feels like.
    const fade = smoothstep(GHOST_FULL, GHOST_FADE, d).oneMinus().mul(peak);
    if (!rimOnly) return fade;
    // The shell's rim term, and it is what turns a wash into an outline.
    //
    // The shell is depth-free by necessity -- it has to be visible through the
    // building the icon is behind -- so it cannot be masked by the solid icon
    // in front of it, and a flat back-face shell therefore paints its full
    // opacity across the whole silhouette as well as around it. The centre is
    // the part that is wrong; the rim is the whole point.
    //
    // In view space the eye looks down -Z, so `abs(normalView.z)` is 1 on a
    // face square to the camera and 0 on one seen edge-on. Inverting it leaves
    // energy only where the surface is turning away, which on a closed hull is
    // exactly its silhouette. Squared, because a linear falloff still leaves a
    // visible haze over the middle at this opacity.
    const rim = normalView.z.abs().oneMinus();
    return fade.mul(rim).mul(rim);
  })();
}

/**
 * The three materials and the two geometries, built once for the whole world.
 *
 * One instance of this is shared by every tile, on the terms every other
 * streamed prop in this project uses: a material created per tile is a WebGPU
 * pipeline compiled per tile, and pipeline compilation blocks the main thread.
 */
export class PowerupAssets {
  readonly bolt: BufferGeometry;
  readonly cup: BufferGeometry;

  /** Ordinary depth test. What you see when nothing is in the way. */
  readonly solidMaterial: MeshBasicNodeMaterial;
  /** Depth-free, distance-gated. What you see through a building. */
  readonly ghostMaterial: MeshBasicNodeMaterial;
  /** The same, back faces only, on geometry scaled up -- the soft outline. */
  readonly shellMaterial: MeshBasicNodeMaterial;

  constructor() {
    this.bolt = buildBolt();
    this.cup = buildCup();

    // Unlit, and `vertexColors` so the baked facet shading and `instanceColor`
    // multiply through untouched. See the header for why a powerup is an
    // emitter in the sense `furniture.ts`'s signal lamp is.
    const solid = new MeshBasicNodeMaterial();
    solid.name = 'powerup_solid';
    solid.vertexColors = true;
    solid.color = new Color(1, 1, 1);
    this.solidMaterial = solid;

    const ghost = new MeshBasicNodeMaterial();
    ghost.name = 'powerup_ghost';
    ghost.vertexColors = true;
    ghost.color = new Color(1, 1, 1);
    ghost.transparent = true;
    ghost.depthTest = false;
    ghost.depthWrite = false;
    ghost.opacityNode = distanceFade(GHOST_OPACITY);
    this.ghostMaterial = ghost;

    const shell = new MeshBasicNodeMaterial();
    shell.name = 'powerup_shell';
    shell.vertexColors = true;
    shell.color = new Color(1, 1, 1);
    shell.transparent = true;
    shell.depthTest = false;
    shell.depthWrite = false;
    // Back faces only. Rendering the *inside* of a larger copy is what leaves
    // just the halo outside the real silhouette; front faces would paint the
    // whole icon over with a flat wash.
    shell.side = BackSide;
    shell.opacityNode = distanceFade(SHELL_OPACITY, true);
    this.shellMaterial = shell;
  }
}

// --- The sidecar --------------------------------------------------------------

/** One tile's powerups, decoded from `<key>.pow.bin`. */
export interface TilePowerupData {
  count: number;
  /** Tile-local metres, renderer axes: x in [0, tileSize), z in (-tileSize, 0]. */
  x: Float32Array;
  z: Float32Array;
  /** Absolute metres -- the top of the footpath paving, as the pipeline sampled it. */
  groundY: Float32Array;
  kind: Uint8Array;
}

/**
 * Decode a `.pow.bin`. Returns `null` for anything that is not one, because a
 * tile with no powerups must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodePowerups(buffer: ArrayBuffer): TilePowerupData | null {
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count === 0 || buffer.byteLength < 4 + count * STRIDE) return null;

  const out: TilePowerupData = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    groundY: new Float32Array(count),
    kind: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const p = 4 + i * STRIDE;
    out.x[i] = view.getFloat32(p, true);
    out.z[i] = view.getFloat32(p + 4, true);
    out.groundY[i] = view.getFloat32(p + 8, true);
    // Clamped rather than trusted: an out-of-range kind would read past the
    // colour table and take the whole tile out with it.
    out.kind[i] = Math.min(view.getUint8(p + 12), KIND_COUNT - 1);
  }
  return out;
}

// --- Instancing ---------------------------------------------------------------

/**
 * The one thing this file needs to know about a powerup's gameplay state.
 *
 * Structural rather than an import of `game/powerups.ts`'s `PowerupPoint`, and
 * deliberately: `world/` draws things and `game/` decides them, and the arrow
 * between the two directories runs one way. `PowerupPoint` satisfies this
 * without knowing it exists.
 */
export interface PowerupDrawState {
  readonly active: boolean;
}

/**
 * Whoever owns the powerups' gameplay state, as the streamer sees it.
 *
 * `main.ts` hands the streamer a `game/powerups.PowerupField`, which satisfies
 * this without importing anything from `world/` -- the coordinates are plain
 * arrays in world metres rather than a `TilePowerupData`, precisely so the
 * decoded-sidecar type stays on this side of the line.
 *
 * The returned array is in sidecar order, so row `i` of a `PowerupIcons` set is
 * point `i` of the field's answer. That correspondence is the whole contract
 * and it is why `adopt` returns the states rather than taking a callback.
 */
export interface PowerupSink {
  adopt(
    tileKey: string,
    kind: Uint8Array,
    worldX: Float32Array,
    worldY: Float32Array,
    worldZ: Float32Array,
  ): readonly PowerupDrawState[];
  /** The tile's geometry has gone. The points' state must not. */
  release(tileKey: string): void;
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _spin = /*#__PURE__*/ new Matrix4();
const _scale = /*#__PURE__*/ new Matrix4();
const _colour = /*#__PURE__*/ new Color();

/** Deterministic hash over the sidecar, for the bob phase. `furniture.ts`'s. */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * One tile's icons: up to six `InstancedMesh` sets over two geometries and
 * three materials, plus the per-frame animation.
 *
 * Six rather than two because each kind needs its solid, its ghost and its
 * shell, and an `InstancedMesh` is one geometry and one material by
 * construction. A tile with cafes and no station -- which is most of them --
 * builds three; the densest tile in the inner ring builds six for 64 icons.
 * They share their instance *transforms* through one loop, so a ghost can never
 * drift from the solid it belongs to.
 */
export class PowerupIcons {
  readonly meshes: InstancedMesh[] = [];
  private readonly count: number;
  private readonly kind: Uint8Array;
  private readonly baseX: Float32Array;
  private readonly baseY: Float32Array;
  private readonly baseZ: Float32Array;
  private readonly phase: Float32Array;
  /** Per kind: the three meshes, and the row each point occupies in them. */
  private readonly slot: Int32Array;
  private readonly sets: Array<InstancedMesh[] | null> = [null, null];
  /** Seconds left of the pickup pop, and what `active` was last frame. */
  private readonly popT: Float32Array;
  private readonly wasActive: Uint8Array;
  private clock = 0;

  constructor(data: TilePowerupData, assets: PowerupAssets) {
    this.count = data.count;
    this.kind = data.kind;
    this.baseX = data.x;
    this.baseZ = data.z;
    this.baseY = new Float32Array(data.count);
    this.phase = new Float32Array(data.count);
    this.slot = new Int32Array(data.count);
    this.popT = new Float32Array(data.count);
    this.wasActive = new Uint8Array(data.count).fill(1);

    const perKind = [0, 0];
    for (let i = 0; i < data.count; i++) {
      this.baseY[i] = data.groundY[i] + HOVER_HEIGHT;
      // Bob phase off the position rather than the index, so two icons that
      // happen to be neighbours in the sidecar are not in lockstep and a tile
      // rebuilt after an eviction bobs identically to the way it did before.
      this.phase[i] = hash(Math.round(data.x[i] * 16), Math.round(data.z[i] * 16), 0x50b) * Math.PI * 2;
      this.slot[i] = perKind[data.kind[i]]++;
    }

    for (let k = 0; k < KIND_COUNT; k++) {
      if (perKind[k] === 0) continue;
      const geometry = k === TRAINING ? assets.bolt : assets.cup;
      const trio = [
        instanced(geometry, assets.solidMaterial, perKind[k], `powerup_${k}_solid`, 0),
        instanced(geometry, assets.shellMaterial, perKind[k], `powerup_${k}_shell`, 8),
        instanced(geometry, assets.ghostMaterial, perKind[k], `powerup_${k}_ghost`, 9),
      ];
      for (const mesh of trio) {
        _colour.setRGB(...(KIND_COLOUR[k] as [number, number, number]));
        for (let i = 0; i < perKind[k]; i++) mesh.setColorAt(i, _colour);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        this.meshes.push(mesh);
      }
      this.sets[k] = trio;
    }
    // One pass with nothing running, so a tile that arrives mid-frame is never
    // drawn with sixty-four icons stacked at its origin.
    this.update([], 0);
    // And the depth-free passes off until `updateLife` has measured the tile's
    // distance. Three's default is visible, so without this a tile that streams
    // in 1.5 km away draws two full transparent passes for the one frame before
    // the streamer gets to it.
    this.setDepthFreeVisible(Infinity);
  }

  /**
   * Turn the two depth-free passes on or off from the tile's near-edge distance.
   *
   * Exact rather than heuristic, and that is what makes it worth doing: the
   * ghost and the shell fade to *zero* opacity at `GHOST_FADE`, so if the
   * nearest point of a tile's bounding box is further than that, every icon in
   * it is beyond the fade and both passes are drawing fully transparent
   * fragments. A zero-alpha `transparent` draw is not free -- three submits it,
   * the vertex shader runs on every instance, and the blend runs on every
   * covered pixel -- and at a 1,800 m load radius that is sixty tiles of it.
   *
   * The solid pass is left alone: it is the ordinary depth-tested object and is
   * what a player sees an icon *in the open* by, at any distance.
   */
  setDepthFreeVisible(nearDistance: number): void {
    const on = nearDistance <= GHOST_FADE;
    for (const trio of this.sets) {
      if (trio === null) continue;
      trio[1].visible = on;
      trio[2].visible = on;
    }
  }

  /**
   * Spin, bob, pop and hide, once per frame.
   *
   * `states` is the game's own array in sidecar order; an empty one means "not
   * wired yet" and draws everything as present, which is what makes an icon set
   * usable before `main.ts` has a field to give it.
   *
   * Everything is written every frame rather than only on a change, and that is
   * the right trade at this count: the spin and the bob move every frame
   * anyway, so a dirty test would be a comparison that is always true plus a
   * branch. The densest tile is 64 icons in three sets, which is 192 matrix
   * writes -- against `birds.ts`'s 150 simulated ibises at 0.024 ms.
   */
  update(states: readonly PowerupDrawState[], dt: number): void {
    this.clock += dt;
    const spin = this.clock * SPIN_RATE * Math.PI * 2;

    for (let i = 0; i < this.count; i++) {
      const state = states[i];
      const active = state === undefined ? true : state.active;
      // The pop fires on the transition, not on the state, so a tile that
      // streams in next to an already-taken powerup does not replay somebody
      // else's pickup.
      if (this.wasActive[i] === 1 && !active) this.popT[i] = POP_SECONDS;
      this.wasActive[i] = active ? 1 : 0;
      if (this.popT[i] > 0) this.popT[i] = Math.max(0, this.popT[i] - dt);

      let scale = ICON_SCALE;
      if (!active) {
        if (this.popT[i] > 0) {
          // Grow and thin out. `k` runs 1 -> 0 across the window, so the icon
          // leaves by expanding rather than by shrinking, which reads as
          // *taken* where a shrink reads as *cancelled*.
          const k = this.popT[i] / POP_SECONDS;
          scale = ICON_SCALE * (POP_SCALE - (POP_SCALE - 1) * k);
        } else {
          // Zero scale rather than `visible = false`: visibility is per mesh and
          // this is per instance, and a degenerate matrix is culled by the
          // rasteriser for free. Spec 8.3 asks for a respawn and not for a
          // marker while it is gone -- see `POP_SECONDS`.
          scale = 0;
        }
      }

      const bob = Math.sin(this.clock * ((Math.PI * 2) / BOB_PERIOD) + this.phase[i]) * BOB_AMPLITUDE;
      _matrix.makeTranslation(this.baseX[i], this.baseY[i] + bob, this.baseZ[i]);
      _spin.makeRotationY(spin + this.phase[i]);
      _matrix.multiply(_spin);
      _scale.makeScale(scale, scale, scale);
      _matrix.multiply(_scale);

      const trio = this.sets[this.kind[i]];
      if (trio === null) continue;
      const row = this.slot[i];
      trio[0].setMatrixAt(row, _matrix);
      trio[2].setMatrixAt(row, _matrix);
      // The shell is the same transform grown about the icon's own centre,
      // which is why it is a fourth multiply rather than a different scale in
      // the line above: scaling the translation as well would slide the outline
      // off toward the tile origin.
      _scale.makeScale(SHELL_SCALE, SHELL_SCALE, SHELL_SCALE);
      _matrix.multiply(_scale);
      trio[1].setMatrixAt(row, _matrix);
    }

    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}

/** One `InstancedMesh`, set up the way every streamed instance set here is. */
function instanced(
  geometry: BufferGeometry,
  material: MeshBasicNodeMaterial,
  count: number,
  name: string,
  order: number,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  // Culled with its tile, like every other primitive the streamer loads. It is
  // load-bearing on the two depth-free passes for a second reason: an icon 40 m
  // behind the camera is still *drawn* if it survives to the draw call, so the
  // per-tile box is the only thing keeping the ghost pass off the whole city.
  mesh.frustumCulled = false;
  // Read by `streamer.ts` for disposal: the geometry here is shared world-wide
  // and must not be released with the tile, where the per-tile part is the
  // instance matrix and colour buffers.
  mesh.userData.powerups = true;
  // Never in the depth map. A floating marker that threw a shadow on the
  // footpath would be a solid object, and the two depth-free passes have no
  // meaningful depth to contribute at all.
  mesh.userData.noShadow = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = order;
  return mesh;
}
