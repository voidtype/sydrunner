/**
 * The railway, as a thing you can see: ballast, rail, viaducts, tunnel portals,
 * overhead wire, platforms and station names.
 *
 * `game/rail.ts` is the half with no pictures in it -- where every train is, as
 * a function of the clock -- and this is the half that costs frame time. Same
 * division as `game/rave.ts` against `world/rave.ts`, in the same words.
 *
 * ---------------------------------------------------------------------------
 * 1. THE ARCHITECTURAL DECISION, WHICH IS THAT NONE OF THIS IS IN THE WORLD.
 *
 * Every other structure in Sydney arrives as a per-tile GLB the pipeline baked
 * and R2 published. The railway does not, and that is deliberate rather than
 * expedient:
 *
 *   - The 60 km world took **5 h 42 m to build and a 12 GB upload**. Baking rail
 *     into per-tile sidecars means redoing both.
 *   - What would be baked is a few thousand polylines. The bake this file reads
 *     is **1.03 MB** and already carries every fact the geometry needs --
 *     22,944 densified vertices with per-vertex tunnel / bridge / cutting /
 *     embankment / electrified flags, f64 cumulative arc lengths that the
 *     cone-envelope solve has already held to the 3.3% ruling gradient, 267
 *     stations with a vertical class each, 2,063 block sections, and 12,315
 *     mast placements of which 3,510 are portal gantries.
 *   - A compact procedural source plus a runtime builder is *strictly better*
 *     than a bake for something this small: it costs one 1 MB fetch instead of
 *     18,113 tile rebuilds, and changing the ballast profile is a reload.
 *
 * So: `client/public/rail/rail.bin`, fetched from the game's own origin. **Not**
 * through `world/cdn.ts`, and that is the one place this file departs from the
 * brief it was written to. `fetchWorldAsset` resolves against the *world* --
 * either the R2 bucket or `/world/` on the origin -- and the rail bake is in
 * neither, because putting it there is the world republish this whole design
 * exists to avoid. It is a client asset and it is fetched the way the other
 * client assets are, which is `carlod.ts`'s `fetch('/cars/manifest.json')`.
 *
 * ---------------------------------------------------------------------------
 * 2. THE POLYLINES OVERLAP AND THE FIRST JOB IS TO STOP DRAWING THEM TWICE.
 *
 * The bake carries one polyline per line per direction: twenty of them, 856 km
 * of centreline between them. They are not twenty railways. T1 down and T1 up
 * are the *same rails* reversed, T1 and T9 share everything north of
 * Strathfield, and T2, T3 and T8 share the approach to Central -- so a naive
 * ribbon per direction draws the North Shore line four times, in exactly the
 * same place, which is four times the triangles and a z-fight down the middle of
 * every one of them.
 *
 * They deduplicate exactly, because they are not merely near each other: every
 * direction is pathed through the *same graph*, so a shared edge contributes the
 * identical f32 vertices to both. `buildNetwork` quantises each endpoint to
 * 25 mm, orders the pair canonically and keys a `Map` on the six integers. The
 * flags of the two copies are unioned, so a segment one line calls electrified
 * and another does not comes out electrified. Measured on the shipped bake:
 * 22,924 directed segments collapse to the unique set the report prints at boot.
 *
 * Two parallel tracks are **not** deduplicated and must not be: the up and down
 * roads of a double-track railway are separate OSM ways four metres apart, and
 * both are really there.
 *
 * ---------------------------------------------------------------------------
 * 3. WHAT IS DRAWN WHERE, WHICH IS THREE TIERS AND NOT TWO.
 *
 *   - **The corridor**, everywhere, always: one merged ribbon per 8 km cell of
 *     the ballast *base*, 3.6 m wide, at 30 cm under the rail head. It is what
 *     makes the rail corridor legible from the other side of the harbour, it is
 *     about 40k triangles for the whole 60 km disc across a dozen draws, and it
 *     is deliberately narrower and lower than the near-field ballast so that the
 *     two never z-fight where they overlap.
 *   - **The chunk ring** inside `BUILD_RADIUS`: ballast prism, rails, viaduct
 *     decks and piers, tunnel lining and portals, platforms, canopies, station
 *     signs and the overhead wire, built per 512 m chunk on demand and disposed
 *     past `KEEP_RADIUS`. Plain `Mesh`es over shared materials, so a chunk
 *     arriving compiles nothing -- see section 5.
 *   - **The instanced sets**: sleepers within `SLEEPER_RADIUS` and masts within
 *     `MAST_RADIUS`, and these are **two meshes for the whole world**, refilled
 *     when the resident chunk set changes. Per-chunk instanced meshes would have
 *     been the obvious shape and would have been a bug: three keys an instanced
 *     draw on `object.uuid`, so every chunk's sleepers would compile their own
 *     pipeline on the frame they were first drawn. `world/warmup.ts` sets that
 *     out at length and this project has paid for it twice.
 *
 * ---------------------------------------------------------------------------
 * 4. A VIADUCT IS SOLID AND YOU WALK UNDER IT.
 *
 * `pipeline/sydney/decks.py` is the precedent and `player/collision.ts` has
 * honoured `base` since the walk-under round: a prism occupies `[base, base +
 * height]`, so a deck whose `base` is its soffit is a floor for whoever is on it
 * and thin air for whoever is under it. Every deck, pier, platform and station
 * box this file draws is registered with those semantics through
 * `CollisionWorld.addPrisms`, keyed by chunk and taken back by `removeTile` when
 * the chunk goes.
 *
 * ---------------------------------------------------------------------------
 * 5. THE RENDERER RULES, BOTH OF WHICH THIS PROJECT HAS SHIPPED AS BUGS.
 *
 *   - Every material here is constructed once, in `RailAssets`, before the boot
 *     warm-up, and `railWarmupParts` hands all of them to it. Nothing is created
 *     per chunk.
 *   - Both `InstancedMesh` constructors call `setColorAt(0, white)` immediately.
 *     `NodeMaterial.setupDiffuseColor` multiplies by `instanceColor` only when
 *     the attribute exists *at the moment the node graph is built*, and the boot
 *     scene pass builds it before a single sleeper has been placed.
 *
 * ---------------------------------------------------------------------------
 * 6. NO CLOCK AND NO RANDOM. Nothing in this file reads the time or a random
 * number, and nothing it builds is a function of anything but the bake and the
 * player's position. `poseTrain` stays pure because nothing here can reach it.
 */

import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
  type Material,
} from 'three/webgpu';

import {
  CATENARY_INDICES,
  CATENARY_VERTS,
  WIRE_COLOUR,
  catenarySag,
  writeCatenary,
} from './power.ts';
import { warmupGeometry, type WarmupPart } from './warmup.ts';
import {
  SPAN_BRIDGE,
  SPAN_ELECTRIFIED,
  SPAN_TUNNEL,
  decodeRail,
  type RailBake,
  type RailStation,
} from '../game/rail.ts';

// --- Where the bake comes from ------------------------------------------------

/** The client-asset path. See section 1 on why this is not a world asset. */
const BAKE_URL = '/rail/rail.bin';

/**
 * Fetch and decode the rail bake, or `null`.
 *
 * Never throws and never blocks a boot: a build with no rail bake is the build
 * that shipped last week, and the whole feature is absent rather than fatal.
 */
export async function loadRailBake(url = BAKE_URL): Promise<RailBake | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return decodeRail(await response.arrayBuffer());
  } catch (err) {
    console.warn('[rail] no rail bake; the railway is not drawn.', err);
    return null;
  }
}

// --- The dimensions of a railway ------------------------------------------------
//
// Standard gauge and the NSW loading gauge, in metres. The polyline's y is the
// **rail head**: everything below is measured down from it and everything above,
// up.

const GAUGE_HALF = 0.7175;
const RAIL_HALF_WIDTH = 0.035;
const RAIL_HEIGHT = 0.17;
/** Ballast top, below the rail head: the sleeper is buried to its shoulders. */
const BALLAST_TOP_DROP = 0.2;
const BALLAST_DEPTH = 0.55;
const BALLAST_TOP_HALF = 2.2;
const BALLAST_BASE_HALF = 3.3;

const SLEEPER_PITCH = 0.65;
const SLEEPER_HALF_LENGTH = 1.3;
const SLEEPER_HALF_WIDTH = 0.13;
const SLEEPER_HEIGHT = 0.2;

/** Viaduct deck: the slab the ballast sits on, and how far its soffit is down. */
const DECK_HALF_WIDTH = 3.9;
const DECK_DEPTH = 1.15;
const PIER_SPACING = 26;
const PIER_HALF = 0.85;

/** Tunnel bore: a lining tube around the track and nothing else. See the brief. */
const TUNNEL_RADIUS = 3.4;
const TUNNEL_SIDES = 10;
/** Bore centre, above the rail head. */
const TUNNEL_RISE = 1.9;
/** Portal headwall: how far it stands proud of the bore. */
const PORTAL_MARGIN = 1.1;
const PORTAL_THICKNESS = 0.9;

/** Overhead line. Contact wire at the regulated height above the rail head. */
const CONTACT_HEIGHT = 5.1;
const MESSENGER_HEIGHT = 6.35;
const MAST_HEIGHT = 7.4;
const MAST_OFFSET = 3.15;
const MAST_RADIUS = 0.14;
const GANTRY_HALF_SPAN = 9.5;

/** Platform: 160 m is an eight-car Tangara with a few metres in hand. */
const PLATFORM_HALF_LENGTH = 80;
const PLATFORM_WIDTH = 5.5;
const PLATFORM_HEIGHT = 1.05;
/** Platform edge, from the track centre. Real NSW clearance is about 1.6 m. */
const PLATFORM_INNER = 1.62;
const CANOPY_HALF_LENGTH = 34;
const CANOPY_HEIGHT = 3.9;
const CANOPY_OVERHANG = 0.7;

/** Underground box: the room the platforms stand in. */
const BOX_HALF_LENGTH = 88;
const BOX_HALF_WIDTH = 13;
const BOX_HEIGHT = 7.5;
const SHAFT_HALF = 3.2;

/** Sign blade, in the street-sign spirit: a small plate on two posts. */
const SIGN_WIDTH = 3.6;
const SIGN_HEIGHT = 0.45;
const SIGN_Y = 2.6;

/**
 * The street-level station board. See `writeStationBoard`.
 *
 * Bigger than the platform blade on both axes and higher off its own datum,
 * because the reader is further away and is looking for the station rather than
 * confirming which one they are standing in. 4.2 m at 3.4 m up subtends about
 * the same angle at 60 m that the blade does at 20.
 */
const BOARD_WIDTH = 4.2;
const BOARD_HEIGHT = 1.1;
const BOARD_Y = 3.4;

// --- Chunking -------------------------------------------------------------------

const CHUNK_M = 512;
/** Chunks whose box is inside this are built. */
const BUILD_RADIUS = 1100;
/**
 * Chunks built per frame, and the reason this is not "all of them".
 *
 * Measured on the shipped build: a full ring reshape at a 512 m boundary is
 * **10-17 ms**, which is a dropped frame every 512 m walked and every 12 s on a
 * bike. Spread over frames it is under a millisecond each and the ring simply
 * fills in behind the player, which is what the tile streamer does with a much
 * larger payload for exactly this reason. Two per frame at 60 Hz fills a
 * fifteen-chunk ring in an eighth of a second.
 */
const BUILDS_PER_FRAME = 2;
/** And disposed past this. The hysteresis is the streamer's own pattern. */
const KEEP_RADIUS = 1500;
/** Sleepers are geometry only this close; past it the ballast ribbon reads. */
const SLEEPER_RADIUS = 165;
const MAST_RADIUS_M = 520;
const SLEEPER_CAPACITY = 7000;
const CANTILEVER_CAPACITY = 700;
const GANTRY_CAPACITY = 260;
/** The always-on corridor layer's cell, which is coarse because it never moves. */
const FAR_CELL_M = 8192;
const FAR_DROP = 0.3;
const FAR_HALF_WIDTH = 1.8;

// --- Colour ----------------------------------------------------------------------
//
// Linear albedo, on `sky/calibration.ts`'s chain and `power.ts`'s method: the
// display value beside each is the 3 pm, 15 February render at exposure 0.62
// through Neutral tone mapping.

type Rgb = readonly [number, number, number];

/**
 * Blue-metal ballast. Dark, and **cooler than the asphalt beside it**: crushed
 * basalt against a bitumen road is the one pairing in this city where the darker
 * surface is the bluer one, and getting that backwards makes a rail corridor
 * read as a service road.
 *
 *   sun rgb(84,86,92)   shade rgb(41,42,46)
 */
const BALLAST: Rgb = [0.052, 0.054, 0.062];
/**
 * Rail. Not a colour so much as a contrast: the web and foot are rust and the
 * head is polished by every wheel that has passed, and the head is the only part
 * anybody sees from a distance. One material, and the head's brightness comes
 * from `metalness` catching the sky rather than from a second tone.
 *
 *   sun rgb(96,92,88)   shade rgb(47,45,44)
 */
const RAIL_STEEL: Rgb = [0.062, 0.058, 0.053];
/** Prestressed sleeper. Pale grey concrete, greyer than the viaduct's. */
const SLEEPER_CONCRETE: Rgb = [0.115, 0.115, 0.112];
/**
 * Viaduct, platform and station box concrete. Warm, because a Sydney rail
 * viaduct is 1920s sandstone-aggregate concrete and every one of them has run
 * with rust from the parapet.
 *
 *   sun rgb(156,152,143)   shade rgb(83,78,71)
 */
const CONCRETE: Rgb = [0.195, 0.186, 0.168];
/** Tunnel lining: sprayed concrete, seen only by lamp and headlight. */
const LINING: Rgb = [0.085, 0.084, 0.082];
/** Canopy: painted steel and a fibre-cement soffit. */
const CANOPY: Rgb = [0.145, 0.152, 0.156];
/** Mast and gantry steel: hot-dip galvanised, gone matt grey. */
const MAST_STEEL: Rgb = [0.096, 0.1, 0.104];

// --- A tiny mesh builder -----------------------------------------------------------

/**
 * Positions, normals and an index, accumulated as plain arrays.
 *
 * Flat-shaded materials do not read the normals -- three's `NodeMaterial` takes
 * derivatives instead -- but the tunnel lining and the canopy are smooth, and one
 * builder that always writes them is a great deal less error-prone than two that
 * differ in their attribute layout, which is a thing the pipeline cache is keyed
 * on. Face normals throughout, so a shared vertex is never shared between two
 * faces and there is nothing to average.
 */
class Solid {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly index: number[] = [];

  get empty(): boolean {
    return this.index.length === 0;
  }

  /** One quad, wound `a -> b -> c -> d`, with the normal from its own plane. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    uvs?: readonly number[],
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = dx - ax;
    const vy = dy - ay;
    const vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      ny = 1;
    }
    const base = this.position.length / 3;
    this.position.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) this.normal.push(nx, ny, nz);
    if (uvs) this.uv.push(...uvs);
    else this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** An axis-aligned box between two corners. Six quads, outward-facing. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0); // +y
    this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // -y
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +z
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // -z
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +x
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // -x
  }

  build(name: string, withUv = false): BufferGeometry | null {
    if (this.empty) return null;
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    if (withUv) g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    const count = this.position.length / 3;
    g.setIndex(
      new BufferAttribute(
        count > 65535 ? new Uint32Array(this.index) : new Uint16Array(this.index),
        1,
      ),
    );
    g.computeBoundingSphere();
    return g;
  }
}

function standard(name: string, colour: Rgb, roughness: number, metalness: number, flat: boolean) {
  const m = new MeshStandardNodeMaterial();
  m.name = name;
  m.color = new Color().setRGB(colour[0], colour[1], colour[2]);
  m.roughness = roughness;
  m.metalness = metalness;
  m.flatShading = flat;
  return m;
}

// --- The shared kit ---------------------------------------------------------------

/**
 * Every material and every instanced geometry the railway ever draws, built once
 * for the whole game and handed to the boot warm-up.
 *
 * Constructed before `warmUpPipelines` in `main.ts`, on exactly the argument
 * `PoliceAssets`, `StreetlifeAssets` and `RaveAssets` are: a material created
 * when the first chunk arrives is a pipeline compiled on the frame the player
 * first walks within a kilometre of a railway, and in this city that is the
 * frame they leave the spawn.
 */
export class RailAssets {
  readonly ballast = standard('rail_ballast', BALLAST, 0.97, 0.0, true);
  readonly rail = standard('rail_steel', RAIL_STEEL, 0.42, 0.65, true);
  readonly concrete = standard('rail_concrete', CONCRETE, 0.9, 0.0, true);
  readonly canopy = standard('rail_canopy', CANOPY, 0.6, 0.25, true);
  readonly sleeper = standard('rail_sleeper', SLEEPER_CONCRETE, 0.92, 0.0, true);
  readonly mast = standard('rail_mast', MAST_STEEL, 0.55, 0.5, true);
  /**
   * The tunnel lining, and the only `BackSide` material in the file: it is a tube
   * seen from inside, and a front-facing one would be the outside of a pipe
   * buried in the ground, which is to say nothing at all.
   */
  readonly lining: MeshStandardNodeMaterial;
  /** The overhead conductors. Unlit, for the reason `power.ts` sets out at length. */
  readonly wire: MeshBasicNodeMaterial;
  /** Station names, all 267 of them, on one atlas. See `buildSignAtlas`. */
  readonly sign: MeshBasicNodeMaterial;
  /** The far corridor ribbon: the same blue metal, but never shadowed. */
  readonly corridor = standard('rail_corridor', BALLAST, 0.97, 0.0, true);

  readonly sleeperGeometry: BufferGeometry;
  readonly cantileverGeometry: BufferGeometry;
  readonly gantryGeometry: BufferGeometry;

  private signSlots = new Map<string, readonly number[]>();
  private signTexture: CanvasTexture | null = null;

  constructor() {
    const lining = standard('rail_lining', LINING, 0.95, 0.0, false);
    lining.side = BackSide;
    this.lining = lining;

    const wire = new MeshBasicNodeMaterial();
    wire.name = 'rail_wire';
    wire.color = new Color().setRGB(WIRE_COLOUR[0], WIRE_COLOUR[1], WIRE_COLOUR[2]);
    wire.side = DoubleSide;
    this.wire = wire;

    const sign = new MeshBasicNodeMaterial();
    sign.name = 'rail_sign';
    // Single-sided: `writeSign` emits the back face itself with the U range
    // reversed, because a two-sided quad shows mirror writing from behind.
    sign.side = FrontSide;
    sign.fog = false;
    this.sign = sign;

    this.sleeperGeometry = buildSleeper();
    this.cantileverGeometry = buildMast(false);
    this.gantryGeometry = buildMast(true);
  }

  /**
   * Lay every station name out on one canvas and hand back the UV rectangle for
   * each.
   *
   * One texture and one material for the whole network, because the alternative
   * -- a `CanvasTexture` per station, which is what a per-sign renderer would be
   * -- is 267 textures, 267 materials and 267 pipelines for a few hundred
   * triangles of legend. 512 cells of 256 x 32 on a 2048 square is 64 px/m on a
   * 3.6 m blade, which is a name you can read from the far platform and not from
   * the next suburb, and that is the right distance for it.
   */
  prepareSigns(names: readonly string[]): void {
    if (typeof document === 'undefined') return;
    const cols = 8;
    const cellW = 2048 / cols;
    const cellH = 32;
    const rows = Math.ceil(names.length / cols);
    if (rows * cellH > 2048) {
      console.warn(`[rail] ${names.length} station names do not fit one sign atlas; the tail is blank.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 2048;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Not transparent: the blade is a solid plate and the text sits on it, so
    // the atlas is the plate. A transparent atlas would need the plate drawn as
    // separate geometry behind every sign.
    ctx.fillStyle = '#12181c';
    ctx.fillRect(0, 0, 2048, 2048);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < names.length; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cellW;
      const y = row * cellH;
      if (y + cellH > 2048) break;
      ctx.fillStyle = '#12181c';
      ctx.fillRect(x, y, cellW, cellH);
      ctx.fillStyle = '#eef3f6';
      ctx.font = '600 21px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.fillText(names[i].toUpperCase(), x + cellW / 2, y + cellH / 2 + 1, cellW - 14);
      this.signSlots.set(names[i], [
        (x + 2) / 2048,
        1 - (y + cellH - 1) / 2048,
        (x + cellW - 2) / 2048,
        1 - (y + 1) / 2048,
      ]);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    this.signTexture = texture;
    this.sign.map = texture;
    this.sign.needsUpdate = true;
  }

  /** `[u0, v0, u1, v1]` for one station name, or null if it has no cell. */
  signUv(name: string): readonly number[] | null {
    return this.signSlots.get(name) ?? null;
  }

  get hasSignAtlas(): boolean {
    return this.signTexture !== null;
  }

  /** Every material, for the warm-up and the audit. */
  materials(): Material[] {
    return [
      this.ballast, this.rail, this.concrete, this.canopy, this.sleeper,
      this.mast, this.lining, this.wire, this.sign, this.corridor,
    ];
  }
}

/**
 * The boot warm-up entries.
 *
 * Every one of these is a shared material over a plain `Mesh`, which is exactly
 * the case a stand-in *can* warm: the pipeline is keyed on the material, the
 * attribute layout and the shadow role, and a chunk arriving three minutes into
 * the session brings none of them that are new. The two `InstancedMesh`es are
 * deliberately **not** here -- three keys those on `object.uuid` and no stand-in
 * can warm one -- and are covered by the scene pass instead, which is why they
 * are constructed before it rather than on first use.
 */
export function railWarmupParts(assets: RailAssets): WarmupPart[] {
  const lit = (material: Material, casts: boolean): WarmupPart => ({
    geometry: warmupGeometry({ normal: true, uv: true }),
    material,
    owned: true,
    casts,
  });
  return [
    lit(assets.ballast, false),
    lit(assets.rail, true),
    lit(assets.concrete, true),
    lit(assets.canopy, true),
    lit(assets.lining, false),
    lit(assets.corridor, false),
    {
      geometry: warmupGeometry({ normal: true, uv: true }),
      material: assets.wire,
      owned: true,
      casts: false,
      receives: [false],
    },
    {
      geometry: warmupGeometry({ normal: true, uv: true }),
      material: assets.sign,
      owned: true,
      casts: false,
      receives: [false],
    },
  ];
}

// --- Instanced geometries ----------------------------------------------------------

function buildSleeper(): BufferGeometry {
  const s = new Solid();
  s.box(
    -SLEEPER_HALF_WIDTH, -SLEEPER_HEIGHT, -SLEEPER_HALF_LENGTH,
    SLEEPER_HALF_WIDTH, 0, SLEEPER_HALF_LENGTH,
  );
  return s.build('rail_sleeper')!;
}

/**
 * A catenary mast, built at the origin with **+X along the track and +Z toward
 * the track centre**, so one geometry serves both cantilever sides: the instance
 * matrix mirrors Z for the other hand, which is a scale of -1 and is exactly how
 * a real mast is handed.
 *
 * The gantry variant is two legs and a beam, spanning the corridor rather than
 * reaching over one road of it.
 */
function buildMast(gantry: boolean): BufferGeometry {
  const s = new Solid();
  const leg = (cz: number): void => {
    s.box(-MAST_RADIUS, -1.0, cz - MAST_RADIUS, MAST_RADIUS, MAST_HEIGHT, cz + MAST_RADIUS);
    // A base plate, because a mast that vanishes into the ballast at exactly its
    // own width reads as a fence post pushed in.
    s.box(-0.26, -0.1, cz - 0.26, 0.26, 0.16, cz + 0.26);
  };
  if (gantry) {
    leg(-GANTRY_HALF_SPAN);
    leg(GANTRY_HALF_SPAN);
    // The beam, a shallow lattice reduced to one box: at 9 m up and 0.22 m deep
    // the truss detail is under a pixel from anywhere a player stands.
    s.box(-0.1, MAST_HEIGHT - 0.34, -GANTRY_HALF_SPAN, 0.1, MAST_HEIGHT - 0.12, GANTRY_HALF_SPAN);
    // Droppers to the messenger height, one every third of the span.
    for (const f of [-0.66, -0.33, 0, 0.33, 0.66]) {
      const cz = f * GANTRY_HALF_SPAN;
      s.box(-0.05, MESSENGER_HEIGHT, cz - 0.05, 0.05, MAST_HEIGHT - 0.34, cz + 0.05);
    }
  } else {
    leg(0);
    // The cantilever: a bracket tube out over the track and a registration arm
    // under it, the two things that make a mast read as overhead line equipment
    // rather than as a lamp post.
    s.box(-0.09, MESSENGER_HEIGHT - 0.08, 0, 0.09, MESSENGER_HEIGHT + 0.08, MAST_OFFSET);
    s.box(-0.06, CONTACT_HEIGHT + 0.05, MAST_OFFSET - 1.5, 0.06, CONTACT_HEIGHT + 0.17, MAST_OFFSET);
    // The stay that triangulates the two, which is the whole silhouette.
    s.box(-0.05, CONTACT_HEIGHT + 0.1, MAST_OFFSET - 0.12, 0.05, MESSENGER_HEIGHT, MAST_OFFSET);
  }
  return s.build(gantry ? 'rail_gantry' : 'rail_cantilever')!;
}

// --- The network index --------------------------------------------------------------

/** One length of track, after the twenty polylines have been deduplicated. */
interface Segment {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  flags: number;
  /** Plan length, and the unit plan direction. Computed once. */
  len: number;
  ux: number; uz: number;
}

/** A tunnel mouth: where the flags flip between one vertex and the next. */
interface Portal {
  x: number; y: number; z: number;
  /** Unit plan direction, pointing **into** the tunnel. */
  ux: number; uz: number;
}

interface Chunk {
  segments: number[];
  masts: number[];
  portals: number[];
  stations: number[];
}

/** Everything derived from the bake once, before a single triangle is built. */
export interface RailNetwork {
  bake: RailBake;
  segments: Segment[];
  portals: Portal[];
  /** Stations that sit on the heavy-rail network, with the track heading at each. */
  stations: Array<RailStation & { ux: number; uz: number }>;
  chunks: Map<string, Chunk>;
  /** What the deduplication actually saved. Printed at boot. */
  directedSegments: number;
}

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

function chunkOf(x: number, z: number): string {
  return chunkKey(Math.floor(x / CHUNK_M), Math.floor(z / CHUNK_M));
}

function bucket(chunks: Map<string, Chunk>, key: string): Chunk {
  let c = chunks.get(key);
  if (c === undefined) {
    c = { segments: [], masts: [], portals: [], stations: [] };
    chunks.set(key, c);
  }
  return c;
}

/**
 * Deduplicate the twenty polylines into a segment set, find the tunnel mouths,
 * orient the stations, and file everything by chunk.
 *
 * Runs once at load. The dedup key is described in section 2; the quantisation
 * is 25 mm, which is four orders of magnitude finer than any two distinct rails
 * in this city are apart and two orders coarser than f32 round-trip error at
 * 60 km from the origin.
 */
export function buildNetwork(bake: RailBake): RailNetwork {
  const segments: Segment[] = [];
  const seen = new Map<string, number>();
  const p = bake.vertices;
  const flags = bake.vertexFlags;
  let directed = 0;

  const q = (v: number): number => Math.round(v * 4);

  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        directed++;
        const ax = p[i * 3];
        const ay = p[i * 3 + 1];
        const az = p[i * 3 + 2];
        const bx = p[(i + 1) * 3];
        const by = p[(i + 1) * 3 + 1];
        const bz = p[(i + 1) * 3 + 2];
        // Canonical order, so a segment and its reverse hash the same.
        const forward = ax < bx || (ax === bx && az <= bz);
        const key = forward
          ? `${q(ax)},${q(ay)},${q(az)},${q(bx)},${q(by)},${q(bz)}`
          : `${q(bx)},${q(by)},${q(bz)},${q(ax)},${q(ay)},${q(az)}`;
        // A segment's flags are the union of both vertices': a run is a tunnel
        // if either end of it is, or the last few metres before a portal would
        // be open sky inside the hill.
        const f = flags[i] | flags[i + 1];
        const at = seen.get(key);
        if (at !== undefined) {
          segments[at].flags |= f;
          continue;
        }
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.05) continue;
        seen.set(key, segments.length);
        segments.push({
          ax, ay, az, bx, by, bz,
          flags: f,
          len,
          ux: dx / len,
          uz: dz / len,
        });
      }
    }
  }

  // --- Portals: a flag transition along a direction's own polyline.
  const portals: Portal[] = [];
  const portalSeen = new Set<string>();
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        const a = (flags[i] & SPAN_TUNNEL) !== 0;
        const b = (flags[i + 1] & SPAN_TUNNEL) !== 0;
        if (a === b) continue;
        // The mouth is the vertex on the *surface* side of the transition, and
        // the direction points into the hill.
        const surface = a ? i + 1 : i;
        const under = a ? i : i + 1;
        const x = p[surface * 3];
        const y = p[surface * 3 + 1];
        const z = p[surface * 3 + 2];
        const key = `${q(x)},${q(z)}`;
        if (portalSeen.has(key)) continue;
        portalSeen.add(key);
        let ux = p[under * 3] - x;
        let uz = p[under * 3 + 2] - z;
        const len = Math.sqrt(ux * ux + uz * uz) || 1;
        portals.push({ x, y, z, ux: ux / len, uz: uz / len });
      }
    }
  }

  // --- Chunks. Segments by midpoint, everything else by its own position.
  const chunks = new Map<string, Chunk>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    bucket(chunks, chunkOf((s.ax + s.bx) / 2, (s.az + s.bz) / 2)).segments.push(i);
  }
  const st = bake.stanchions;
  for (let i = 0; i < bake.stanchionKinds.length; i++) {
    bucket(chunks, chunkOf(st[i * 5], st[i * 5 + 2])).masts.push(i);
  }
  for (let i = 0; i < portals.length; i++) {
    bucket(chunks, chunkOf(portals[i].x, portals[i].z)).portals.push(i);
  }

  // --- Stations, placed **where the trains actually stop**.
  //
  // This is the one place the bake has to be read against itself rather than at
  // face value, and getting it wrong is the loudest possible defect: a train
  // that dwells two hundred metres short of its own platform.
  //
  // `bake.stations[].x, z` is the OSM station *node*, and `dir.stops[k].s` is
  // the arc length the timetable brings a train to rest at -- the graph vertex
  // the router snapped the station to. Measured on the shipped bake, the two
  // differ by **225 m at Meadowbank and 248 m the other way**, because a station
  // node sits at the entrance and the routed anchor is wherever the platform's
  // way joins the running line. Building the platform at the node and stopping
  // the train at the arc length puts the two a rugby field apart.
  //
  // So a served station is positioned by evaluating its own stopping arc length
  // on the polyline of the first service that calls there, which also gives the
  // heading and the rail level for free and cannot disagree with `poseTrain` by
  // construction. A station **no line calls at** -- and 94 of the bake's 267 are
  // light-rail stops or closed platforms the network never reaches -- falls back
  // to the nearest segment within 60 m, and is dropped if there is not one.
  interface Anchor { name: string; x: number; y: number; z: number; ux: number; uz: number }
  const anchors: Anchor[] = [];
  const anchorAt = (dir: (typeof bake.lines)[number]['dirs'][number], at: number): Omit<Anchor, 'name'> => {
    const c = bake.cum;
    let lo = dir.vertexOff;
    let hi = dir.vertexOff + dir.vertexCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
    const span = c[lo + 1] - c[lo];
    const u = span > 0 ? (at - c[lo]) / span : 0;
    const ax = p[lo * 3];
    const ay = p[lo * 3 + 1];
    const az = p[lo * 3 + 2];
    const dx = p[(lo + 1) * 3] - ax;
    const dy = p[(lo + 1) * 3 + 1] - ay;
    const dz = p[(lo + 1) * 3 + 2] - az;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: ax + dx * u, y: ay + dy * u, z: az + dz * u, ux: dx / len, uz: dz / len };
  };
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      for (const stop of dir.stops) {
        if (!stop.calls) continue;
        const at = anchorAt(dir, stop.s);
        // Merge with an anchor of the same name already within a platform's
        // length: the up and down roads of one station are two ways a few metres
        // apart and their arc lengths land within a carriage of each other, so
        // they are one platform pair. What must *not* merge is a station whose
        // two directions the router anchored hundreds of metres apart -- and the
        // bake has those: Meadowbank's two are 471 m up the corridor from each
        // other. Merging those would put one direction's trains half a kilometre
        // from their own platform, which is the defect this whole block exists
        // to prevent, so they become two platform sites under one name.
        const near = anchors.find(
          (a) => a.name === stop.name && Math.hypot(a.x - at.x, a.z - at.z) < PLATFORM_HALF_LENGTH,
        );
        if (near) continue;
        anchors.push({ name: stop.name, ...at });
      }
    }
  }

  const byName = new Map(bake.stations.map((s) => [s.name, s]));
  const stations: Array<RailStation & { ux: number; uz: number }> = [];
  const served = new Set<string>();
  for (const a of anchors) {
    const record = byName.get(a.name);
    if (!record) continue;
    served.add(a.name);
    const index = stations.length;
    stations.push({ ...record, x: a.x, z: a.z, trackY: a.y, ux: a.ux, uz: a.uz });
    bucket(chunks, chunkOf(a.x, a.z)).stations.push(index);
  }

  // And the ones nothing calls at: 94 of the bake's 267 are light-rail stops or
  // closed platforms the modelled network never reaches. Kept when a rail is
  // within 60 m of them and dropped otherwise, because a platform built beside
  // no track is the one artefact a player would certainly notice.
  for (const station of bake.stations) {
    if (served.has(station.name)) continue;
    const cx = Math.floor(station.x / CHUNK_M);
    const cz = Math.floor(station.z / CHUNK_M);
    let best = -1;
    let bestD = 60 * 60;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const c = chunks.get(chunkKey(cx + ox, cz + oz));
        if (!c) continue;
        for (const si of c.segments) {
          const d = pointSegmentDistanceSquared(station.x, station.z, segments[si]);
          if (d < bestD) {
            bestD = d;
            best = si;
          }
        }
      }
    }
    if (best < 0) continue;
    const index = stations.length;
    stations.push({ ...station, ux: segments[best].ux, uz: segments[best].uz });
    bucket(chunks, chunkOf(station.x, station.z)).stations.push(index);
  }

  return { bake, segments, portals, stations, chunks, directedSegments: directed };
}

function pointSegmentDistanceSquared(x: number, z: number, s: Segment): number {
  const ex = s.bx - s.ax;
  const ez = s.bz - s.az;
  const len2 = ex * ex + ez * ez;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((x - s.ax) * ex + (z - s.az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = x - (s.ax + ex * t);
  const dz = z - (s.az + ez * t);
  return dx * dx + dz * dz;
}

// --- Collision, as a hook rather than an import ---------------------------------

/**
 * Where the solid parts of the railway go.
 *
 * A hook rather than a `CollisionWorld` import, on `world/cdn.ts`'s own argument
 * for `LocalAssetSource`: this module is about geometry, the collision world is
 * about the player, and the only thing they need to agree on is a prism with a
 * `base`. It also means the whole feature runs with the hook absent, which is
 * what a check or a headless build gets.
 */
export interface RailSolids {
  addPrisms(key: string, prisms: ReadonlyArray<{ points: Float32Array; height: number; base: number }>): number;
  removeTile(key: string): number;
}

/** Ground height at a point, or `NaN` where no terrain is loaded. */
export type GroundAt = (x: number, z: number) => number;

// --- Per-chunk construction ----------------------------------------------------------

interface BuiltChunk {
  group: Group;
  geometries: BufferGeometry[];
  collisionKey: string | null;
  /** Instance sources, held so the global sets can be refilled without a rebuild. */
  sleepers: Float32Array;
  masts: number[];
  cx: number;
  cz: number;
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _white = /*#__PURE__*/ new Color(1, 1, 1);

/**
 * The railway in the scene.
 *
 * One `update(x, z)` a frame, which does nothing at all unless the player has
 * crossed a chunk boundary or moved far enough to change the sleeper or mast
 * set. Everything expensive is on that transition and nothing is per frame.
 */
export class RailWorld {
  readonly group = new Group();
  /** Chunks built right now. On the debug overlay. */
  get residentChunks(): number {
    return this.built.size;
  }
  /** What the last chunk transition cost, milliseconds. */
  rebuildMs = 0;
  /** Draw calls the chunk ring is currently contributing. */
  chunkDraws = 0;
  sleeperCount = 0;
  mastCount = 0;
  /** Instances the capacities refused. Should stay at zero. */
  overflows = 0;

  private readonly built = new Map<string, BuiltChunk>();
  /** Chunk keys inside the build radius that have not been built yet. */
  private pending: string[] = [];
  private readonly sleeperMesh: InstancedMesh;
  private readonly cantileverMesh: InstancedMesh;
  private readonly gantryMesh: InstancedMesh;
  private lastChunk = '';
  private lastSleeperCell = '';

  constructor(
    private readonly net: RailNetwork,
    private readonly assets: RailAssets,
    private readonly ground: GroundAt,
    private readonly solids: RailSolids | null = null,
  ) {
    this.group.name = 'rail';

    // --- The always-on corridor. Built once and never touched again.
    const corridor = new Group();
    corridor.name = 'rail_corridor';
    for (const [name, geometry] of buildCorridor(net)) {
      const mesh = new Mesh(geometry, assets.corridor);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.noShadow = true;
      corridor.add(mesh);
    }
    this.group.add(corridor);

    // --- The two instanced sets, **one each for the whole world**. See section 3.
    this.sleeperMesh = this.makeInstanced(assets.sleeperGeometry, assets.sleeper, SLEEPER_CAPACITY, 'rail_sleepers');
    this.cantileverMesh = this.makeInstanced(assets.cantileverGeometry, assets.mast, CANTILEVER_CAPACITY, 'rail_masts');
    this.gantryMesh = this.makeInstanced(assets.gantryGeometry, assets.mast, GANTRY_CAPACITY, 'rail_gantries');
  }

  private makeInstanced(
    geometry: BufferGeometry,
    material: Material,
    capacity: number,
    name: string,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    // Culled by radius rather than by frustum, on `CarModelFleet`'s argument: the
    // bounding sphere of a set whose instances move with the player would have to
    // be recomputed every refill, and the radius test is already done.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // **The colour buffer, allocated here rather than by a first `setColorAt`.**
    // `InstancedMesh` allocates `instanceColor` lazily and
    // `NodeMaterial.setupDiffuseColor` multiplies by it only when the attribute
    // exists at the moment the node graph is built -- and the boot scene pass
    // builds it before a single sleeper is placed. Without this line the whole
    // set would draw in the material's base value forever. Shipped twice here.
    mesh.setColorAt(0, _white);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Bring the chunk ring, the sleepers and the masts up to date for a player at
   * (x, z). Cheap and early-out on every frame but the transitions.
   */
  update(x: number, z: number): void {
    const key = chunkOf(x, z);
    if (key !== this.lastChunk) {
      this.lastChunk = key;
      this.reshapeRing(x, z);
      // The sleeper set is a finer grid than the chunk ring, so a chunk
      // transition also invalidates it.
      this.lastSleeperCell = '';
    }
    if (this.pending.length > 0) {
      const started = performance.now();
      for (let n = 0; n < BUILDS_PER_FRAME && this.pending.length > 0; n++) {
        const next = this.pending.pop()!;
        if (this.built.has(next) || !this.net.chunks.has(next)) continue;
        const [cx, cz] = next.split(',').map(Number);
        this.built.set(next, this.buildChunk(next, cx, cz));
      }
      this.rebuildMs = performance.now() - started;
      this.countDraws();
      this.refillMasts(x, z);
      // A chunk that has just arrived may be the one the player is standing on.
      this.lastSleeperCell = '';
    }
    // Sleepers move on their own, much smaller cell: 165 m of near field
    // re-derived every 512 m would leave the player walking out of their own
    // sleepers for three hundred metres.
    const sleeperCell = `${Math.floor(x / 64)},${Math.floor(z / 64)}`;
    if (sleeperCell !== this.lastSleeperCell) {
      this.lastSleeperCell = sleeperCell;
      this.refillSleepers(x, z);
    }
  }

  /**
   * Decide what should be in range and drop what is not. **Queues** the builds
   * rather than doing them, which is what keeps a boundary crossing off the
   * frame budget -- see `BUILDS_PER_FRAME`.
   *
   * Sorted nearest-last, because `update` pops from the end: the chunk the
   * player is about to walk into is the one that must arrive first.
   */
  private reshapeRing(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK_M);
    const cz = Math.floor(z / CHUNK_M);
    const span = Math.ceil(BUILD_RADIUS / CHUNK_M);
    const wanted: Array<{ key: string; d: number }> = [];
    for (let ox = -span; ox <= span; ox++) {
      for (let oz = -span; oz <= span; oz++) {
        const key = chunkKey(cx + ox, cz + oz);
        if (this.built.has(key)) continue;
        if (!this.net.chunks.has(key)) continue;
        const d = chunkDistance(cx + ox, cz + oz, x, z);
        if (d > BUILD_RADIUS) continue;
        wanted.push({ key, d });
      }
    }
    wanted.sort((a, b) => b.d - a.d);
    this.pending = wanted.map((w) => w.key);
    for (const [key, chunk] of this.built) {
      if (chunkDistance(chunk.cx, chunk.cz, x, z) <= KEEP_RADIUS) continue;
      this.disposeChunk(key, chunk);
    }
    this.countDraws();
  }

  private countDraws(): void {
    let draws = 0;
    for (const chunk of this.built.values()) draws += chunk.group.children.length;
    this.chunkDraws = draws;
  }

  private disposeChunk(key: string, chunk: BuiltChunk): void {
    this.group.remove(chunk.group);
    for (const g of chunk.geometries) g.dispose();
    if (chunk.collisionKey && this.solids) this.solids.removeTile(chunk.collisionKey);
    this.built.delete(key);
  }

  /** Drop everything. For a teleport, and for the module's own tests. */
  clear(): void {
    for (const [key, chunk] of [...this.built]) this.disposeChunk(key, chunk);
    this.pending.length = 0;
    this.lastChunk = '';
    this.lastSleeperCell = '';
  }

  private buildChunk(key: string, cx: number, cz: number): BuiltChunk {
    const chunk = this.net.chunks.get(key)!;
    const group = new Group();
    group.name = `rail_${key}`;
    const geometries: BufferGeometry[] = [];
    const prisms: Array<{ points: Float32Array; height: number; base: number }> = [];

    const ballast = new Solid();
    const rails = new Solid();
    const concrete = new Solid();
    const lining = new Solid();
    const canopy = new Solid();
    const signs = new Solid();
    const sleepers: number[] = [];

    let wireSpans = 0;
    for (const si of chunk.segments) {
      const s = this.net.segments[si];
      const tunnel = (s.flags & SPAN_TUNNEL) !== 0;
      const bridge = (s.flags & SPAN_BRIDGE) !== 0;
      if (tunnel) {
        writeTunnel(lining, s);
      } else {
        writeBallast(ballast, s, bridge);
        if ((s.flags & SPAN_ELECTRIFIED) !== 0) wireSpans++;
        for (let t = 0; t < s.len; t += SLEEPER_PITCH) {
          const f = t / s.len;
          sleepers.push(
            s.ax + (s.bx - s.ax) * f,
            s.ay + (s.by - s.ay) * f - BALLAST_TOP_DROP,
            s.az + (s.bz - s.az) * f,
            Math.atan2(-s.ux, -s.uz),
          );
        }
      }
      if (!tunnel) writeRails(rails, s);
      if (bridge) writeViaduct(concrete, prisms, s, this.ground);
    }

    for (const pi of chunk.portals) writePortal(concrete, lining, this.net.portals[pi]);

    for (const si of chunk.stations) {
      const station = this.net.stations[si];
      if (station.vertical === 'underground') {
        writeUndergroundStation(concrete, lining, prisms, station);
      } else {
        writePlatforms(concrete, canopy, prisms, station);
      }
      const uv = this.assets.signUv(station.name);
      if (uv) {
        // The platform blade, for the person already on the platform.
        if (station.vertical !== 'underground') writeSign(signs, concrete, station, uv);
        // And the board, for the person in the street who does not yet know
        // there is a station here. See `writeStationBoard`: reported as "there
        // is no sign for the train station", and the platform blade is not an
        // answer to it -- it is 45 cm tall, it is under the canopy, and at a
        // station in a cutting it is metres below the footpath.
        writeStationBoard(signs, concrete, station, uv);
      }
    }

    // The overhead line, strung span by span over the electrified segments. The
    // sag maths is `power.ts`' and so is the cross-ribbon: see `writeCatenary`.
    let wire: BufferGeometry | null = null;
    if (wireSpans > 0) {
      const position = new Float32Array(wireSpans * 2 * CATENARY_VERTS * 3);
      const index =
        wireSpans * 2 * CATENARY_VERTS > 65535
          ? new Uint32Array(wireSpans * 2 * CATENARY_INDICES)
          : new Uint16Array(wireSpans * 2 * CATENARY_INDICES);
      const cursor = { vp: 0, ip: 0 };
      for (const si of chunk.segments) {
        const s = this.net.segments[si];
        if ((s.flags & SPAN_TUNNEL) !== 0 || (s.flags & SPAN_ELECTRIFIED) === 0) continue;
        const px = -s.uz;
        const pz = s.ux;
        const sag = catenarySag(s.len);
        // The messenger sags and the contact wire does not, which is the whole
        // point of a catenary suspension and the only thing that tells one apart
        // from a trolley wire at a glance.
        writeCatenary(
          position, index, cursor,
          s.ax, s.ay + MESSENGER_HEIGHT, s.az,
          s.bx, s.by + MESSENGER_HEIGHT, s.bz,
          px, pz, sag,
        );
        writeCatenary(
          position, index, cursor,
          s.ax, s.ay + CONTACT_HEIGHT, s.az,
          s.bx, s.by + CONTACT_HEIGHT, s.bz,
          px, pz, 0.02,
        );
      }
      if (cursor.vp > 0) {
        wire = new BufferGeometry();
        wire.name = `rail_wire_${key}`;
        wire.setAttribute('position', new BufferAttribute(position.subarray(0, cursor.vp * 3), 3));
        wire.setIndex(new BufferAttribute(index.subarray(0, cursor.ip), 1));
        wire.computeBoundingSphere();
      }
    }

    const add = (
      geometry: BufferGeometry | null,
      material: Material,
      name: string,
      casts: boolean,
      receives: boolean,
    ): void => {
      if (!geometry) return;
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = casts;
      mesh.receiveShadow = receives;
      if (!casts) mesh.userData.noShadow = true;
      group.add(mesh);
      geometries.push(geometry);
    };

    add(ballast.build(`rail_ballast_${key}`), this.assets.ballast, 'ballast', false, true);
    add(rails.build(`rail_steel_${key}`), this.assets.rail, 'rails', false, true);
    add(concrete.build(`rail_concrete_${key}`), this.assets.concrete, 'concrete', true, true);
    add(lining.build(`rail_lining_${key}`), this.assets.lining, 'lining', false, false);
    add(canopy.build(`rail_canopy_${key}`), this.assets.canopy, 'canopy', true, true);
    add(signs.build(`rail_sign_${key}`, true), this.assets.sign, 'signs', false, false);
    add(wire, this.assets.wire, 'wire', false, false);

    if (group.children.length > 0) this.group.add(group);

    let collisionKey: string | null = null;
    if (this.solids && prisms.length > 0) {
      collisionKey = `rail:${key}`;
      this.solids.addPrisms(collisionKey, prisms);
    }

    return {
      group,
      geometries,
      collisionKey,
      sleepers: new Float32Array(sleepers),
      masts: chunk.masts,
      cx,
      cz,
    };
  }

  private refillSleepers(x: number, z: number): void {
    const mesh = this.sleeperMesh;
    const r2 = SLEEPER_RADIUS * SLEEPER_RADIUS;
    let n = 0;
    for (const chunk of this.built.values()) {
      if (chunkDistance(chunk.cx, chunk.cz, x, z) > SLEEPER_RADIUS) continue;
      const s = chunk.sleepers;
      for (let i = 0; i + 3 < s.length; i += 4) {
        const dx = s[i] - x;
        const dz = s[i + 2] - z;
        if (dx * dx + dz * dz > r2) continue;
        if (n >= SLEEPER_CAPACITY) {
          this.overflows++;
          break;
        }
        _matrix.makeRotationY(s[i + 3]);
        _matrix.setPosition(s[i], s[i + 1], s[i + 2]);
        mesh.setMatrixAt(n, _matrix);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.sleeperCount = n;
  }

  private refillMasts(x: number, z: number): void {
    const st = this.net.bake.stanchions;
    const kinds = this.net.bake.stanchionKinds;
    const r2 = MAST_RADIUS_M * MAST_RADIUS_M;
    let cantilevers = 0;
    let gantries = 0;
    for (const chunk of this.built.values()) {
      if (chunkDistance(chunk.cx, chunk.cz, x, z) > MAST_RADIUS_M) continue;
      for (const mi of chunk.masts) {
        const mx = st[mi * 5];
        const my = st[mi * 5 + 1];
        const mz = st[mi * 5 + 2];
        const dx = mx - x;
        const dz = mz - z;
        if (dx * dx + dz * dz > r2) continue;
        const kind = kinds[mi];
        // The bake puts the stanchion **on the track centreline** with the
        // along-track direction; the mast itself stands beside it. A gantry
        // straddles, so it stays where it was put.
        const ux = st[mi * 5 + 3];
        const uz = st[mi * 5 + 4];
        const side = kind === 1 ? -1 : 1;
        const offset = kind === 2 ? 0 : MAST_OFFSET * side;
        // Local +X along the track and +Z toward the track, so a Y rotation of
        // `atan2` puts the geometry on the rails and the `side` scale hands it.
        const yaw = Math.atan2(-uz, ux) + (kind === 1 ? Math.PI : 0);
        _matrix.makeRotationY(yaw);
        _matrix.setPosition(mx + -uz * offset, my - 0.25, mz + ux * offset);
        if (kind === 2) {
          if (gantries >= GANTRY_CAPACITY) {
            this.overflows++;
            continue;
          }
          this.gantryMesh.setMatrixAt(gantries++, _matrix);
        } else {
          if (cantilevers >= CANTILEVER_CAPACITY) {
            this.overflows++;
            continue;
          }
          this.cantileverMesh.setMatrixAt(cantilevers++, _matrix);
        }
      }
    }
    this.cantileverMesh.count = cantilevers;
    this.cantileverMesh.instanceMatrix.needsUpdate = true;
    this.gantryMesh.count = gantries;
    this.gantryMesh.instanceMatrix.needsUpdate = true;
    this.mastCount = cantilevers + gantries;
  }
}

/** Distance from a point to a chunk's box, in metres. Zero inside. */
function chunkDistance(cx: number, cz: number, x: number, z: number): number {
  const x0 = cx * CHUNK_M;
  const z0 = cz * CHUNK_M;
  const dx = Math.max(x0 - x, 0, x - (x0 + CHUNK_M));
  const dz = Math.max(z0 - z, 0, z - (z0 + CHUNK_M));
  return Math.hypot(dx, dz);
}

// --- The pieces --------------------------------------------------------------------

/**
 * Ballast: a trapezoid prism along the segment, or a flat plinth on a viaduct.
 *
 * Both ends are extended by half the top width along the run, which is the
 * cheap mitre this whole approach rests on. Consecutive segments are built
 * independently -- there is no chain and no shared vertex -- so at a bend the
 * two trapezoids leave a wedge of daylight on the outside of the turn. The
 * overlap fills it, and because the pieces are opaque and coplanar in the only
 * axis that matters, it costs nothing but the overlap's own triangles. The
 * alternative, a mitred chain, would have to survive junctions where four
 * segments meet at a point and there is no mitre that is right for all of them.
 */
function writeBallast(s: Solid, seg: Segment, bridge: boolean): void {
  const ext = BALLAST_TOP_HALF;
  const ax = seg.ax - seg.ux * ext;
  const az = seg.az - seg.uz * ext;
  const bx = seg.bx + seg.ux * ext;
  const bz = seg.bz + seg.uz * ext;
  const ay = seg.ay - BALLAST_TOP_DROP;
  const by = seg.by - BALLAST_TOP_DROP;
  const px = -seg.uz;
  const pz = seg.ux;
  const topHalf = BALLAST_TOP_HALF;
  // On a viaduct the shoulders sit on the deck rather than running away to
  // ground, so the prism is a shallow plinth with no batter to speak of.
  const baseHalf = bridge ? BALLAST_TOP_HALF + 0.25 : BALLAST_BASE_HALF;
  const depth = bridge ? 0.4 : BALLAST_DEPTH;

  const p = (x: number, y: number, z: number, o: number, dy: number): [number, number, number] => [
    x + px * o,
    y + dy,
    z + pz * o,
  ];
  const a1 = p(ax, ay, az, -topHalf, 0);
  const a2 = p(ax, ay, az, topHalf, 0);
  const b1 = p(bx, by, bz, -topHalf, 0);
  const b2 = p(bx, by, bz, topHalf, 0);
  const a3 = p(ax, ay, az, -baseHalf, -depth);
  const a4 = p(ax, ay, az, baseHalf, -depth);
  const b3 = p(bx, by, bz, -baseHalf, -depth);
  const b4 = p(bx, by, bz, baseHalf, -depth);
  // Top, then the two shoulders. No underside and no ends: the underside is
  // buried and the ends are inside the next segment's overlap.
  s.quad(...a1, ...b1, ...b2, ...a2);
  s.quad(...a3, ...b3, ...b1, ...a1);
  s.quad(...a2, ...b2, ...b4, ...a4);
}

/** Two rails, as thin boxes standing on the ballast with their heads at `y`. */
function writeRails(s: Solid, seg: Segment): void {
  const px = -seg.uz;
  const pz = seg.ux;
  for (const side of [-1, 1]) {
    const ox = px * GAUGE_HALF * side;
    const oz = pz * GAUGE_HALF * side;
    const wx = px * RAIL_HALF_WIDTH;
    const wz = pz * RAIL_HALF_WIDTH;
    const ax = seg.ax + ox;
    const az = seg.az + oz;
    const bx = seg.bx + ox;
    const bz = seg.bz + oz;
    const ay = seg.ay;
    const by = seg.by;
    const lo = RAIL_HEIGHT;
    // Head, then the two webs. A rail seen from a metre away is a bright line
    // and two dark ones, and that is exactly three quads.
    s.quad(ax - wx, ay, az - wz, bx - wx, by, bz - wz, bx + wx, by, bz + wz, ax + wx, ay, az + wz);
    s.quad(ax - wx, ay - lo, az - wz, bx - wx, by - lo, bz - wz, bx - wx, by, bz - wz, ax - wx, ay, az - wz);
    s.quad(ax + wx, ay, az + wz, bx + wx, by, bz + wz, bx + wx, by - lo, bz + wz, ax + wx, ay - lo, az + wz);
  }
}

/**
 * A viaduct: the deck the ballast sits on, and piers to the ground.
 *
 * The deck's prism `base` is its **soffit**, which is the whole of what makes a
 * player walk under it -- `decks.py` and `player/collision.ts` say the same
 * thing in the same words. The piers' base is the ground, so they are solid all
 * the way up and you walk into one.
 */
function writeViaduct(
  s: Solid,
  prisms: Array<{ points: Float32Array; height: number; base: number }>,
  seg: Segment,
  ground: GroundAt,
): void {
  const px = -seg.uz;
  const pz = seg.ux;
  const soffit = Math.min(seg.ay, seg.by) - BALLAST_TOP_DROP - 0.4 - DECK_DEPTH;
  const top = soffit + DECK_DEPTH;
  // Deck: a box swept along the run, extended half a metre each end so
  // consecutive spans meet without a slot of daylight between them.
  const ax = seg.ax - seg.ux * 0.5;
  const az = seg.az - seg.uz * 0.5;
  const bx = seg.bx + seg.ux * 0.5;
  const bz = seg.bz + seg.uz * 0.5;
  const h = DECK_HALF_WIDTH;
  const corner = (x: number, z: number, o: number, y: number): [number, number, number] => [
    x + px * o, y, z + pz * o,
  ];
  s.quad(...corner(ax, az, -h, top), ...corner(bx, bz, -h, top), ...corner(bx, bz, h, top), ...corner(ax, az, h, top));
  s.quad(...corner(ax, az, -h, soffit), ...corner(ax, az, h, soffit), ...corner(bx, bz, h, soffit), ...corner(bx, bz, -h, soffit));
  s.quad(...corner(ax, az, h, soffit), ...corner(ax, az, h, top), ...corner(bx, bz, h, top), ...corner(bx, bz, h, soffit));
  s.quad(...corner(bx, bz, -h, soffit), ...corner(bx, bz, -h, top), ...corner(ax, az, -h, top), ...corner(ax, az, -h, soffit));
  // Parapets, which are what a viaduct is recognised by from underneath and from
  // the street beside it.
  for (const side of [-1, 1]) {
    const o = (h - 0.22) * side;
    const cx = ax + px * o;
    const cz = az + pz * o;
    const dxp = bx + px * o;
    const dzp = bz + pz * o;
    s.quad(
      cx - px * 0.22, top, cz - pz * 0.22,
      dxp - px * 0.22, top, dzp - pz * 0.22,
      dxp - px * 0.22, top + 0.95, dzp - pz * 0.22,
      cx - px * 0.22, top + 0.95, cz - pz * 0.22,
    );
    s.quad(
      cx + px * 0.22, top + 0.95, cz + pz * 0.22,
      dxp + px * 0.22, top + 0.95, dzp + pz * 0.22,
      dxp + px * 0.22, top, dzp + pz * 0.22,
      cx + px * 0.22, top, cz + pz * 0.22,
    );
    s.quad(
      cx - px * 0.22, top + 0.95, cz - pz * 0.22,
      dxp - px * 0.22, top + 0.95, dzp - pz * 0.22,
      dxp + px * 0.22, top + 0.95, dzp + pz * 0.22,
      cx + px * 0.22, top + 0.95, cz + pz * 0.22,
    );
  }
  prisms.push({
    points: ring(ax, az, bx, bz, px, pz, h),
    height: DECK_DEPTH + 1.0,
    base: soffit,
  });

  // Piers. One per `PIER_SPACING` of arc, placed at the segment's own start so a
  // chain of segments does not double up where they meet.
  const count = Math.max(1, Math.round(seg.len / PIER_SPACING));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const cx = seg.ax + (seg.bx - seg.ax) * t;
    const cz = seg.az + (seg.bz - seg.az) * t;
    const g = ground(cx, cz);
    // No terrain loaded yet -- a chunk built at the edge of the ring, before the
    // tiles under it -- so the pier is given a plausible depth rather than being
    // skipped. A viaduct on invisible legs is worse than one whose legs are a
    // metre short, and the chunk is rebuilt when the player comes back through.
    const base = Number.isFinite(g) ? g - 0.6 : soffit - 8;
    if (base >= soffit - 0.4) continue;
    const o = 0;
    const bxp = cx + px * o;
    const bzp = cz + pz * o;
    s.box(bxp - PIER_HALF, base, bzp - PIER_HALF, bxp + PIER_HALF, soffit + 0.1, bzp + PIER_HALF);
    prisms.push({
      points: new Float32Array([
        bxp - PIER_HALF, bzp - PIER_HALF,
        bxp + PIER_HALF, bzp - PIER_HALF,
        bxp + PIER_HALF, bzp + PIER_HALF,
        bxp - PIER_HALF, bzp + PIER_HALF,
      ]),
      height: soffit - base,
      base,
    });
  }
}

/** The plan rectangle of a swept box, as the ring `addPrisms` wants. */
function ring(
  ax: number, az: number, bx: number, bz: number,
  px: number, pz: number, half: number,
): Float32Array {
  return new Float32Array([
    ax + px * half, az + pz * half,
    bx + px * half, bz + pz * half,
    bx - px * half, bz - pz * half,
    ax - px * half, az - pz * half,
  ]);
}

/**
 * A tunnel: a lining tube around the track and **nothing else**.
 *
 * No carving, no cut in the terrain, no hole in a single building above. The
 * city over the top is untouched, which is the decision the brief makes and the
 * only one that avoids rebuilding the world: what a player sees from inside a
 * train is the tube and the portal transition, and that is the whole experience.
 * Nobody walks these.
 */
function writeTunnel(s: Solid, seg: Segment): void {
  const px = -seg.uz;
  const pz = seg.ux;
  const ay = seg.ay + TUNNEL_RISE;
  const by = seg.by + TUNNEL_RISE;
  for (let i = 0; i < TUNNEL_SIDES; i++) {
    const t0 = (i / TUNNEL_SIDES) * Math.PI * 2;
    const t1 = ((i + 1) / TUNNEL_SIDES) * Math.PI * 2;
    const o0 = Math.cos(t0) * TUNNEL_RADIUS;
    const y0 = Math.sin(t0) * TUNNEL_RADIUS;
    const o1 = Math.cos(t1) * TUNNEL_RADIUS;
    const y1 = Math.sin(t1) * TUNNEL_RADIUS;
    s.quad(
      seg.ax + px * o0, ay + y0, seg.az + pz * o0,
      seg.bx + px * o0, by + y0, seg.bz + pz * o0,
      seg.bx + px * o1, by + y1, seg.bz + pz * o1,
      seg.ax + px * o1, ay + y1, seg.az + pz * o1,
    );
  }
}

/**
 * A portal: the headwall where the bore meets daylight, plus a short length of
 * lining outside it so the mouth is never a hole onto nothing.
 */
function writePortal(concrete: Solid, lining: Solid, portal: Portal): void {
  const ux = portal.ux;
  const uz = portal.uz;
  const px = -uz;
  const pz = ux;
  const cy = portal.y + TUNNEL_RISE;
  const outer = TUNNEL_RADIUS + PORTAL_MARGIN;

  // The headwall as an annulus of quads between the bore and a square frame:
  // eight facets is enough for an arch at this radius and it costs 16 triangles.
  const face = (depth: number, flip: boolean): void => {
    const fx = portal.x + ux * depth;
    const fz = portal.z + uz * depth;
    for (let i = 0; i < TUNNEL_SIDES; i++) {
      const t0 = (i / TUNNEL_SIDES) * Math.PI * 2;
      const t1 = ((i + 1) / TUNNEL_SIDES) * Math.PI * 2;
      const i0 = [Math.cos(t0) * TUNNEL_RADIUS, Math.sin(t0) * TUNNEL_RADIUS];
      const i1 = [Math.cos(t1) * TUNNEL_RADIUS, Math.sin(t1) * TUNNEL_RADIUS];
      const o0 = [Math.cos(t0) * outer, Math.max(Math.sin(t0) * outer, -TUNNEL_RADIUS)];
      const o1 = [Math.cos(t1) * outer, Math.max(Math.sin(t1) * outer, -TUNNEL_RADIUS)];
      const pt = (o: number[]): [number, number, number] => [fx + px * o[0], cy + o[1], fz + pz * o[0]];
      if (flip) concrete.quad(...pt(i0), ...pt(o0), ...pt(o1), ...pt(i1));
      else concrete.quad(...pt(i1), ...pt(o1), ...pt(o0), ...pt(i0));
    }
  };
  face(0, true);
  face(PORTAL_THICKNESS, false);
  // The wing between the two faces, so the headwall has thickness seen from an
  // angle rather than being a pair of decals.
  for (let i = 0; i < TUNNEL_SIDES; i++) {
    const t0 = (i / TUNNEL_SIDES) * Math.PI * 2;
    const t1 = ((i + 1) / TUNNEL_SIDES) * Math.PI * 2;
    const a = [Math.cos(t0) * outer, Math.max(Math.sin(t0) * outer, -TUNNEL_RADIUS)];
    const b = [Math.cos(t1) * outer, Math.max(Math.sin(t1) * outer, -TUNNEL_RADIUS)];
    const at = (o: number[], d: number): [number, number, number] => [
      portal.x + ux * d + px * o[0], cy + o[1], portal.z + uz * d + pz * o[0],
    ];
    concrete.quad(...at(a, 0), ...at(b, 0), ...at(b, PORTAL_THICKNESS), ...at(a, PORTAL_THICKNESS));
  }

  // And a stub of lining reaching back out of the hill, so the mouth reads as a
  // bore rather than as a ring painted on a wall.
  const stub: Segment = {
    ax: portal.x - ux * 1.5, ay: portal.y, az: portal.z - uz * 1.5,
    bx: portal.x + ux * 14, by: portal.y, bz: portal.z + uz * 14,
    flags: SPAN_TUNNEL, len: 15.5, ux, uz,
  };
  writeTunnel(lining, stub);
}

/**
 * Two side platforms, a canopy over the middle of each, and the collision that
 * makes them stand on.
 *
 * Side platforms for every station rather than an island where the real one has
 * one, and that is a stated limitation rather than an oversight: the bake
 * carries a platform *count* and no polygons, so an island would be a guess
 * dressed as data. Two faces at the real clearance is right at every station
 * with an even count and generous at the others.
 */
function writePlatforms(
  concrete: Solid,
  canopy: Solid,
  prisms: Array<{ points: Float32Array; height: number; base: number }>,
  station: RailStation & { ux: number; uz: number },
): void {
  const ux = station.ux;
  const uz = station.uz;
  const px = -uz;
  const pz = ux;
  const y = station.trackY;
  const top = y + PLATFORM_HEIGHT;
  // Elevated stations stand on their own viaduct, which the bridge spans have
  // already built; a surface station's platform runs to the ground.
  const base = station.vertical === 'elevated' ? top - 1.4 : Math.min(station.groundY, y) - 0.4;

  for (const side of [-1, 1]) {
    const inner = PLATFORM_INNER * side;
    const outer = (PLATFORM_INNER + PLATFORM_WIDTH) * side;
    const corner = (t: number, o: number, cy: number): [number, number, number] => [
      station.x + ux * t + px * o, cy, station.z + uz * t + pz * o,
    ];
    const L = PLATFORM_HALF_LENGTH;
    concrete.quad(...corner(-L, inner, top), ...corner(L, inner, top), ...corner(L, outer, top), ...corner(-L, outer, top));
    // The platform face, which is the one surface of a station a passenger ever
    // looks straight at.
    concrete.quad(...corner(-L, inner, base), ...corner(L, inner, base), ...corner(L, inner, top), ...corner(-L, inner, top));
    concrete.quad(...corner(L, outer, base), ...corner(-L, outer, base), ...corner(-L, outer, top), ...corner(L, outer, top));
    concrete.quad(...corner(L, inner, base), ...corner(L, outer, base), ...corner(L, outer, top), ...corner(L, inner, top));
    concrete.quad(...corner(-L, outer, base), ...corner(-L, inner, base), ...corner(-L, inner, top), ...corner(-L, outer, top));

    prisms.push({
      points: new Float32Array([
        station.x + ux * -L + px * inner, station.z + uz * -L + pz * inner,
        station.x + ux * L + px * inner, station.z + uz * L + pz * inner,
        station.x + ux * L + px * outer, station.z + uz * L + pz * outer,
        station.x + ux * -L + px * outer, station.z + uz * -L + pz * outer,
      ]),
      height: top - base,
      base,
    });

    // Canopy: a flat roof on four posts over the middle third. Enough to say
    // "station" from the train and cheap enough to build at all 195 of them.
    const C = CANOPY_HALF_LENGTH;
    const rise = top + CANOPY_HEIGHT;
    const cIn = inner - CANOPY_OVERHANG * side;
    const cOut = outer + CANOPY_OVERHANG * side;
    canopy.quad(...corner(-C, cIn, rise), ...corner(C, cIn, rise), ...corner(C, cOut, rise), ...corner(-C, cOut, rise));
    canopy.quad(...corner(-C, cOut, rise - 0.28), ...corner(C, cOut, rise - 0.28), ...corner(C, cIn, rise - 0.28), ...corner(-C, cIn, rise - 0.28));
    canopy.quad(...corner(-C, cIn, rise - 0.28), ...corner(C, cIn, rise - 0.28), ...corner(C, cIn, rise), ...corner(-C, cIn, rise));
    canopy.quad(...corner(C, cOut, rise - 0.28), ...corner(-C, cOut, rise - 0.28), ...corner(-C, cOut, rise), ...corner(C, cOut, rise));
    for (const t of [-C + 3, -C / 3, C / 3, C - 3]) {
      const o = (inner + outer) / 2;
      const cx = station.x + ux * t + px * o;
      const cz = station.z + uz * t + pz * o;
      canopy.box(cx - 0.11, top, cz - 0.11, cx + 0.11, rise - 0.28, cz + 0.11);
    }
  }
}

/**
 * An underground station: the box, and a stair shaft to a street entrance.
 *
 * Phase A exactly as `TRAINS.md` scopes it -- the *vertical truth* is data (the
 * bake decided which stations are below grade and how deep, and hand-asserted
 * twelve of them) and the architecture is not. Every one of these gets the same
 * room and the same shaft; per-station layout is a later round and this one
 * leaves the seam for it.
 */
function writeUndergroundStation(
  concrete: Solid,
  lining: Solid,
  prisms: Array<{ points: Float32Array; height: number; base: number }>,
  station: RailStation & { ux: number; uz: number },
): void {
  const ux = station.ux;
  const uz = station.uz;
  const px = -uz;
  const pz = ux;
  const floor = station.trackY - 0.4;
  const roof = floor + BOX_HEIGHT;
  const corner = (t: number, o: number, cy: number): [number, number, number] => [
    station.x + ux * t + px * o, cy, station.z + uz * t + pz * o,
  ];
  const L = BOX_HALF_LENGTH;
  const W = BOX_HALF_WIDTH;

  // The room, seen from inside: floor up, ceiling down, four walls in. On the
  // lining material, which is the file's one `BackSide` material -- a box the
  // player is inside is exactly the case it exists for.
  lining.quad(...corner(-L, -W, floor), ...corner(L, -W, floor), ...corner(L, W, floor), ...corner(-L, W, floor));
  lining.quad(...corner(-L, -W, roof), ...corner(L, -W, roof), ...corner(L, W, roof), ...corner(-L, W, roof));
  lining.quad(...corner(-L, -W, floor), ...corner(L, -W, floor), ...corner(L, -W, roof), ...corner(-L, -W, roof));
  lining.quad(...corner(-L, W, floor), ...corner(L, W, floor), ...corner(L, W, roof), ...corner(-L, W, roof));
  lining.quad(...corner(-L, -W, floor), ...corner(-L, W, floor), ...corner(-L, W, roof), ...corner(-L, -W, roof));
  lining.quad(...corner(L, -W, floor), ...corner(L, W, floor), ...corner(L, W, roof), ...corner(L, -W, roof));

  // Two platforms inside it, on the same clearances the surface ones use.
  const top = station.trackY + PLATFORM_HEIGHT;
  for (const side of [-1, 1]) {
    const inner = PLATFORM_INNER * side;
    const outer = (PLATFORM_INNER + PLATFORM_WIDTH) * side;
    concrete.quad(...corner(-L + 6, inner, top), ...corner(L - 6, inner, top), ...corner(L - 6, outer, top), ...corner(-L + 6, outer, top));
    concrete.quad(...corner(-L + 6, inner, floor), ...corner(L - 6, inner, floor), ...corner(L - 6, inner, top), ...corner(-L + 6, inner, top));
    prisms.push({
      points: new Float32Array([
        station.x + ux * (-L + 6) + px * inner, station.z + uz * (-L + 6) + pz * inner,
        station.x + ux * (L - 6) + px * inner, station.z + uz * (L - 6) + pz * inner,
        station.x + ux * (L - 6) + px * outer, station.z + uz * (L - 6) + pz * outer,
        station.x + ux * (-L + 6) + px * outer, station.z + uz * (-L + 6) + pz * outer,
      ]),
      height: top - floor,
      base: floor,
    });
  }

  // The shaft, up to street level and out as a small entrance box. `groundY` is
  // the bake's own reading of the terrain at the station node, so the entrance
  // lands on the footpath rather than at whatever height the tunnel is.
  const street = station.groundY;
  if (!Number.isFinite(street) || street <= roof) return;
  const sx = station.x + ux * (L - 14);
  const sz = station.z + uz * (L - 14);
  lining.quad(
    sx - SHAFT_HALF, roof, sz - SHAFT_HALF, sx + SHAFT_HALF, roof, sz - SHAFT_HALF,
    sx + SHAFT_HALF, street + 0.2, sz - SHAFT_HALF, sx - SHAFT_HALF, street + 0.2, sz - SHAFT_HALF,
  );
  lining.quad(
    sx - SHAFT_HALF, roof, sz + SHAFT_HALF, sx + SHAFT_HALF, roof, sz + SHAFT_HALF,
    sx + SHAFT_HALF, street + 0.2, sz + SHAFT_HALF, sx - SHAFT_HALF, street + 0.2, sz + SHAFT_HALF,
  );
  lining.quad(
    sx - SHAFT_HALF, roof, sz - SHAFT_HALF, sx - SHAFT_HALF, roof, sz + SHAFT_HALF,
    sx - SHAFT_HALF, street + 0.2, sz + SHAFT_HALF, sx - SHAFT_HALF, street + 0.2, sz - SHAFT_HALF,
  );
  lining.quad(
    sx + SHAFT_HALF, roof, sz - SHAFT_HALF, sx + SHAFT_HALF, roof, sz + SHAFT_HALF,
    sx + SHAFT_HALF, street + 0.2, sz + SHAFT_HALF, sx + SHAFT_HALF, street + 0.2, sz - SHAFT_HALF,
  );
  // The entrance at the top: a low box with an open mouth facing the street.
  concrete.box(sx - SHAFT_HALF - 0.5, street, sz - SHAFT_HALF - 0.5, sx + SHAFT_HALF + 0.5, street + 3.2, sz - SHAFT_HALF + 0.1);
  concrete.box(sx - SHAFT_HALF - 0.5, street, sz + SHAFT_HALF - 0.1, sx + SHAFT_HALF + 0.5, street + 3.2, sz + SHAFT_HALF + 0.5);
  concrete.box(sx - SHAFT_HALF - 0.5, street, sz - SHAFT_HALF, sx - SHAFT_HALF + 0.1, street + 3.2, sz + SHAFT_HALF);
  concrete.box(sx - SHAFT_HALF - 0.5, street + 3.2, sz - SHAFT_HALF - 0.5, sx + SHAFT_HALF + 0.5, street + 3.5, sz + SHAFT_HALF + 0.5);
  prisms.push({
    points: new Float32Array([
      sx - SHAFT_HALF - 0.5, sz - SHAFT_HALF - 0.5,
      sx + SHAFT_HALF + 0.5, sz - SHAFT_HALF - 0.5,
      sx + SHAFT_HALF + 0.5, sz + SHAFT_HALF + 0.5,
      sx - SHAFT_HALF - 0.5, sz + SHAFT_HALF + 0.5,
    ]),
    height: 0.3,
    base: street + 3.2,
  });
}

/** The station name on a blade, with two posts, at the platform's own end. */
function writeSign(
  signs: Solid,
  concrete: Solid,
  station: RailStation & { ux: number; uz: number },
  uv: readonly number[],
): void {
  const ux = station.ux;
  const uz = station.uz;
  const px = -uz;
  const pz = ux;
  const y = station.vertical === 'underground' ? station.trackY : station.trackY;
  const top = y + PLATFORM_HEIGHT;
  for (const side of [-1, 1]) {
    const o = (PLATFORM_INNER + 1.3) * side;
    const cx = station.x + px * o;
    const cz = station.z + pz * o;
    const y0 = top + SIGN_Y;
    const y1 = y0 + SIGN_HEIGHT;
    const hx = ux * (SIGN_WIDTH / 2);
    const hz = uz * (SIGN_WIDTH / 2);
    // **Two quads back to back, not one double-sided quad**, and this is not
    // belt and braces: a `DoubleSide` plate shows the *same* UVs from behind,
    // which renders the station name in mirror writing to everybody standing on
    // the other platform. Two faces with the winding and the U range both
    // reversed is a blade that reads correctly from either side, which is what a
    // real one does, and it costs four triangles.
    signs.quad(
      cx - hx, y0, cz - hz, cx + hx, y0, cz + hz, cx + hx, y1, cz + hz, cx - hx, y1, cz - hz,
      [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]],
    );
    signs.quad(
      cx + hx, y0, cz + hz, cx - hx, y0, cz - hz, cx - hx, y1, cz - hz, cx + hx, y1, cz + hz,
      [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]],
    );
    for (const t of [-1, 1]) {
      const post = 0.06;
      const qx = cx + ux * (SIGN_WIDTH / 2 - 0.25) * t;
      const qz = cz + uz * (SIGN_WIDTH / 2 - 0.25) * t;
      concrete.box(qx - post, top, qz - post, qx + post, y1, qz + post);
    }
  }
}

/**
 * The station name on a mast, at **street** level, for somebody who is not on the platform yet.
 *
 * ---------------------------------------------------------------------------
 * Reported, in these words: *"there is no sign for the train station, its not
 * obvious where i board"*. There was a sign. `writeSign` puts a 3.6 x 0.45 m
 * blade 2.6 m over the platform, which is the right object in the right place
 * for a passenger who is already standing on the platform and is no use at all
 * to the one this complaint is about -- somebody in the street, who cannot see
 * the platform, cannot see the blade under the canopy, and at a station in a
 * cutting is standing several metres above both.
 *
 * So this is a second, different object with a different job: a 5 m mast either
 * side of the tracks carrying a 4.2 x 1.1 m board, and -- the part that
 * matters -- its height is measured from `station.groundY`, the **street**, and
 * not from the platform. At Sydenham the platform is seven metres under the
 * terrain grid and the board still stands at the footpath where a person can
 * read it. At an underground station it is the only thing there is, which is
 * why it is written for those too and `writeSign` is not.
 *
 * The plate spans the track direction, so its normal points across the railway
 * and it reads from the street on both sides -- and it is written twice, back to
 * back with the U range reversed, for `writeSign`'s reason: a `DoubleSide` plate
 * shows the name in mirror writing to half the people who look at it.
 */
function boardDatum(station: { trackY: number; groundY: number }): number {
  const platform = station.trackY + PLATFORM_HEIGHT;
  return Number.isFinite(station.groundY) ? Math.max(station.groundY, platform) : platform;
}

function writeStationBoard(
  signs: Solid,
  concrete: Solid,
  station: RailStation & { ux: number; uz: number },
  uv: readonly number[],
): void {
  const ux = station.ux;
  const uz = station.uz;
  const px = -uz;
  const pz = ux;
  // The footpath, or the platform if the bake has no better idea. `groundY` is
  // the terrain the OSM station node sits on, which is the level somebody
  // walking past is at; `trackY + PLATFORM_HEIGHT` is where the train is. At a
  // surface station they are within a step of each other and this picks either.
  const platform = station.trackY + PLATFORM_HEIGHT;
  const foot = boardDatum(station);
  const y0 = foot + BOARD_Y;
  const y1 = y0 + BOARD_HEIGHT;
  for (const side of [-1, 1]) {
    const o = (PLATFORM_INNER + PLATFORM_WIDTH + 1.4) * side;
    const cx = station.x + px * o;
    const cz = station.z + pz * o;
    const hx = ux * (BOARD_WIDTH / 2);
    const hz = uz * (BOARD_WIDTH / 2);
    signs.quad(
      cx - hx, y0, cz - hz, cx + hx, y0, cz + hz, cx + hx, y1, cz + hz, cx - hx, y1, cz - hz,
      [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]],
    );
    signs.quad(
      cx + hx, y0, cz + hz, cx - hx, y0, cz - hz, cx - hx, y1, cz - hz, cx + hx, y1, cz + hz,
      [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]],
    );
    // Two posts down to the footpath, so the board is standing on something
    // rather than floating. Down to the platform as well where that is lower,
    // which is what makes it read as one structure from either level.
    const base = Math.min(foot, platform) - 0.3;
    for (const t of [-1, 1]) {
      const post = 0.09;
      const qx = cx + ux * (BOARD_WIDTH / 2 - 0.35) * t;
      const qz = cz + uz * (BOARD_WIDTH / 2 - 0.35) * t;
      concrete.box(qx - post, base, qz - post, qx + post, y1, qz + post);
    }
  }
}

/**
 * The always-on corridor layer: the whole network as flat ribbons, filed by
 * 8 km cell so the frustum can throw most of it away.
 *
 * Tunnel segments are left out, because a ribbon under the ground is a ribbon
 * nobody can see and 6,000 quads nobody needs.
 */
function buildCorridor(net: RailNetwork): Array<[string, BufferGeometry]> {
  const cells = new Map<string, Solid>();
  for (const seg of net.segments) {
    if ((seg.flags & SPAN_TUNNEL) !== 0) continue;
    const key = `${Math.floor(seg.ax / FAR_CELL_M)},${Math.floor(seg.az / FAR_CELL_M)}`;
    let s = cells.get(key);
    if (s === undefined) {
      s = new Solid();
      cells.set(key, s);
    }
    const px = -seg.uz;
    const pz = seg.ux;
    const ext = FAR_HALF_WIDTH;
    const ax = seg.ax - seg.ux * ext;
    const az = seg.az - seg.uz * ext;
    const bx = seg.bx + seg.ux * ext;
    const bz = seg.bz + seg.uz * ext;
    const ay = seg.ay - FAR_DROP;
    const by = seg.by - FAR_DROP;
    s.quad(
      ax + px * -FAR_HALF_WIDTH, ay, az + pz * -FAR_HALF_WIDTH,
      bx + px * -FAR_HALF_WIDTH, by, bz + pz * -FAR_HALF_WIDTH,
      bx + px * FAR_HALF_WIDTH, by, bz + pz * FAR_HALF_WIDTH,
      ax + px * FAR_HALF_WIDTH, ay, az + pz * FAR_HALF_WIDTH,
    );
  }
  const out: Array<[string, BufferGeometry]> = [];
  for (const [key, s] of cells) {
    const g = s.build(`rail_corridor_${key}`);
    if (g) out.push([`corridor_${key}`, g]);
  }
  return out;
}

// --- The module's own self-check -----------------------------------------------------

/**
 * Everything about the derived network that must be true before anything draws
 * it, in the shape every other subsystem here uses.
 *
 * `verifyRail` in `game/rail.ts` already proves the bake; this proves the
 * *derivation*, which is the half that is new and the half a wrong answer in is
 * invisible -- a dedup that failed leaves the North Shore line drawn four times,
 * which looks completely normal and costs four times the triangles.
 */
export function verifyRailGeometry(net: RailNetwork): string[] {
  const bad: string[] = [];
  if (net.segments.length === 0) bad.push('the network has no segments');
  if (net.segments.length >= net.directedSegments) {
    bad.push(
      `deduplication saved nothing: ${net.segments.length} unique from ` +
        `${net.directedSegments} directed, and twenty polylines over shared rails cannot be disjoint`,
    );
  }
  // No segment may appear twice, which is the invariant the whole tier rests on.
  const seen = new Set<string>();
  for (const s of net.segments) {
    const q = (v: number): number => Math.round(v * 4);
    const forward = s.ax < s.bx || (s.ax === s.bx && s.az <= s.bz);
    const key = forward
      ? `${q(s.ax)},${q(s.ay)},${q(s.az)},${q(s.bx)},${q(s.by)},${q(s.bz)}`
      : `${q(s.bx)},${q(s.by)},${q(s.bz)},${q(s.ax)},${q(s.ay)},${q(s.az)}`;
    if (seen.has(key)) {
      bad.push('the segment set contains a duplicate');
      break;
    }
    seen.add(key);
  }
  if (net.portals.length === 0) bad.push('no tunnel portals were found, and the City Circle is a tunnel');
  if (net.stations.length === 0) bad.push('no station was matched to a track');

  // --- **Every station has a board somebody in the street can read.**
  //
  // Reported as "there is no sign for the train station". The platform blade is
  // measured from the platform, and 82 of the 288 platform sites in this bake
  // sit more than a metre *below* the terrain grid -- 28 underground stations
  // and a dozen more in cuttings the heightfield does not model -- so a sign
  // referenced to the platform is a sign underground at nearly a third of the
  // network. `writeStationBoard` measures from `groundY` instead, and this is
  // the assertion that says so: the board's plate must clear the street at every
  // station, including the ones whose platform is metres under it.
  {
    let sunk = 0;
    let bladeSunk = 0;
    let checked = 0;
    let worstName = '';
    let worstBy = 0;
    for (const st of net.stations) {
      if (!Number.isFinite(st.groundY)) continue;
      checked++;
      // The plate, against the footpath it is read from. `boardDatum` is the
      // function the geometry itself uses, so this cannot pass while the board
      // is built somewhere else.
      const bottom = boardDatum(st) + BOARD_Y;
      if (bottom - st.groundY < 2.2) {
        sunk++;
        if (2.2 - (bottom - st.groundY) > worstBy) {
          worstBy = 2.2 - (bottom - st.groundY);
          worstName = st.name;
        }
      }
      // The negative control, and it is what makes the line above mean
      // something: the *platform* blade, measured from the platform as it always
      // has been, is under the footpath at this many stations. If this number is
      // zero the board is solving a problem that does not exist and the check
      // above is vacuous.
      if (st.trackY + PLATFORM_HEIGHT + SIGN_Y + SIGN_HEIGHT < st.groundY) bladeSunk++;
    }
    if (sunk > 0) {
      bad.push(
        `${sunk} of ${checked} station boards do not clear the footpath by 2.2 m` +
          (worstName ? ` (worst ${worstName}, ${worstBy.toFixed(2)} m short)` : ''),
      );
    }
    if (checked > 50 && bladeSunk === 0) {
      bad.push(
        'no station has its platform blade below the footpath, so the street-level board is ' +
          'answering a question nobody asked -- check that `groundY` is still being read',
      );
    }
  }
  // **A platform must be where its own trains stop**, which is the invariant the
  // stopping-anchor placement above exists for and the one that is invisible
  // when it fails: the station is drawn, the trains run, and they stop two
  // hundred metres up the line. Checked against the timetable rather than
  // against the station node, because the node is the thing that was wrong.
  {
    const worst = { name: '', metres: 0 };
    for (const line of net.bake.lines) {
      for (const dir of line.dirs) {
        for (const stop of dir.stops) {
          if (!stop.calls) continue;
          const c = net.bake.cum;
          let lo = dir.vertexOff;
          let hi = dir.vertexOff + dir.vertexCount - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (c[mid] <= stop.s) lo = mid;
            else hi = mid - 1;
          }
          const px = net.bake.vertices[lo * 3];
          const pz = net.bake.vertices[lo * 3 + 2];
          // The *nearest* site of that name: a station whose two directions the
          // router anchored far apart is two platform sites, and a train has
          // only to stop at one of them.
          let d = Infinity;
          for (const station of net.stations) {
            if (station.name !== stop.name) continue;
            d = Math.min(d, Math.hypot(px - station.x, pz - station.z));
          }
          if (!Number.isFinite(d)) continue;
          if (d > worst.metres) {
            worst.metres = d;
            worst.name = `${stop.name} on ${line.id} dir ${dir.index}`;
          }
        }
      }
    }
    // Half a platform. Different services stop at different ends of a long
    // station and the anchor is taken from the first that calls, so some spread
    // is correct; a train that misses the platform entirely is not.
    if (worst.metres > PLATFORM_HALF_LENGTH) {
      bad.push(
        `${worst.name} stops ${worst.metres.toFixed(0)} m from its own platform, which is over ` +
          `the ${PLATFORM_HALF_LENGTH} m half-length`,
      );
    }
  }
  for (const s of net.stations) {
    if (Math.abs(s.ux * s.ux + s.uz * s.uz - 1) > 1e-3) {
      bad.push(`${s.name} has a heading that is not a unit vector`);
      break;
    }
  }
  let filed = 0;
  for (const c of net.chunks.values()) filed += c.segments.length;
  if (filed !== net.segments.length) {
    bad.push(`${filed} segments are filed by chunk against ${net.segments.length} that exist`);
  }
  return bad;
}
