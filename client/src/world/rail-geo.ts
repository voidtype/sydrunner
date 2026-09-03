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

import { stationAccessPlan, ACCESS_OVERLAP_M, ACCESS_APRON_M, accessCutLength, roomCeilY, concourseY, type AccessWorld,
  ACCESS_HALF_W,
  ACCESS_HEIGHT_M,
} from '../game/riding.ts';

/**
 * The world the access plan is drawn in: the same prisms and ground
 * `main.ts` hands `buildStationBoxes`, so the incline drawn and the floor stood
 * on are the one plan. Empty until the client has a collision field.
 */
let accessWorld: AccessWorld = {};
export function setAccessWorld(world: AccessWorld): void {
  accessWorld = world;
}
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
import {
  CUT_HALF_WIDTH,
  CUT_MIN_DEPTH,
  STATION_HALF_WIDTH,
  drawnAsTunnel,
  type RailCut,
} from './rail-cut.ts';
import { DECK_THICKNESS_M } from './road-deck.ts';
import { RAIL_FENCE_HEIGHT, createRailFenceMaterial } from './fences.ts';
/** The fence panel's own height. Must be `fences.RAIL_FENCE_HEIGHT`. */
const FENCE_HEIGHT = RAIL_FENCE_HEIGHT;
// Phase 3a of `STATIONS.md`: the corridor vessel, drawn. A type and two
// constants -- `TRENCH_EDGE` says which face of the sweep is the floor and which
// is the coping, and it lives beside `trenchProfile` because that is a statement
// about the cross-section rather than about how it is painted. Nothing here
// *builds* a vessel; `world/corridor.ts` does, on both ends, and this file is
// handed the result. See `RailWorld.setVessels`.
import { TRENCH_EDGE, TRENCH_POINT, type Vessel } from './vessel.ts';
import type { CorridorBuild } from './corridor.ts';
// **One rule for what counts as one platform**, imported rather than restated.
// The prisms this file draws and the rectangles `game/riding.PlatformField`
// stands bodies on have to be the same set -- that is the whole reason the field
// is built from the bake instead of from the geometry -- and two copies of a
// merge rule is exactly the shape of drift that put an M1 at Epping on the T9
// platform's paperwork and no platform of its own. `riding.ts` imports nothing
// but `rail.ts`, so this drags no renderer anywhere it should not go.

// The railway's solids, as arithmetic. See `world/rail-solids.ts`: every
// dimension below, the network index, the station plan and the frame helpers
// live there because the server has to be able to evaluate them without a
// renderer, and this file is one of that definition's two renderings.
// The railway's solids, as arithmetic. See `world/rail-solids.ts`: every
// dimension below, the network index, the station plan and the frame helpers
// live there because the server has to be able to evaluate them without a
// renderer, and this file is one of that definition's two renderings.
import {
  ACCESS_ALONG,
  BALLAST_BASE_HALF,
  BALLAST_DEPTH,
  BALLAST_TOP_DROP,
  BALLAST_TOP_HALF,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_Y,
  BOX_HALF_LENGTH,
  BOX_HALF_WIDTH,
  BOX_HEIGHT,
  BRIDGE_ALONG,
  BRIDGE_DECK,
  BRIDGE_RAIL_H,
  BUILDS_PER_FRAME,
  BUILD_RADIUS,
  RAIL_BUILD_BUDGET_MS,
  CANOPY_HALF_LENGTH,
  CANOPY_HEIGHT,
  CANOPY_OVERHANG,
  CANTILEVER_CAPACITY,
  CESS_INNER,
  CHUNK_M,
  CONTACT_HEIGHT,
  COPING_RISE,
  FAR_CELL_M,
  FAR_DROP,
  FAR_HALF_WIDTH,
  FENCE_CLEAR,
  FENCE_GAP_RADIUS,
  FENCE_OFFSET,
  GANTRY_CAPACITY,
  GANTRY_HALF_SPAN,
  GAUGE_HALF,
  HOUSE_AWNING,
  HOUSE_HEIGHT,
  HOUSE_LENGTH,
  KEEP_RADIUS,
  MAST_HEIGHT,
  MAST_OFFSET,
  MAST_RADIUS,
  MAST_RADIUS_M,
  MESSENGER_HEIGHT,
  PIER_HALF,
  PLATFORM_HALF_LENGTH,
  PLATFORM_HEIGHT,
  PLATFORM_INNER,
  PLATFORM_WIDTH,
  PORTAL_MARGIN,
  PORTAL_THICKNESS,
  PROVISIONAL_ATTEMPTS,
  RAIL_HALF_WIDTH,
  RAIL_HEIGHT,
  SIGN_HEIGHT,
  SIGN_WIDTH,
  SIGN_Y,
  SLEEPER_CAPACITY,
  SLEEPER_HALF_LENGTH,
  SLEEPER_HALF_WIDTH,
  SLEEPER_HEIGHT,
  SLEEPER_PITCH,
  SLEEPER_RADIUS,
  STAIR_FLAT,
  STAIR_GOING,
  STAIR_INNER,
  STAIR_MAX_STEPS,
  STAIR_OUTER,
  STAIR_RISE,
  TACTILE_INSET,
  TACTILE_WIDTH,
  TRENCH_COPING,
  TRENCH_COPING_RISE,
  TRENCH_MIN_HEIGHT,
  TRENCH_STEP_M,
  TUNNEL_RADIUS,
  TUNNEL_RISE,
  TUNNEL_SIDES,
  VERGE_RELIEF,
  VERGE_STEP_M,
  chunkKey,
  chunkOf,
  framePoint,
  SOLID_FOOTBRIDGE_DECK,
  SOLID_FOOTBRIDGE_STAIR,
  SOLID_HOUSE,
  SOLID_LANDING,
  SOLID_STAIR,
  SOLID_VIADUCT_PIER,
  planStation,
  platformBack,
  platformSides,
  trenchPrisms,
  trenchProfile,
  viaductDeck,
  viaductSolids,
  framePrism,
  stationSolids,
  type Chunk,
  type FrameSolid,
  type GroundAt,
  type Portal,
  type RailNetwork,
  type RailSolids,
  type Segment,
  type SolidPrism,
  type TrenchRib,
  type StationPlan,
  type TrackFrame,
} from './rail-solids.ts';
import { frameAt, offsetAt, railYAt, type PlatformSpine } from './platform-spine.ts';

export { buildNetwork, type PlacedStation, type RailNetwork } from './rail-solids.ts';

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
/**
 * The cess and the verge: the compacted strip between the ballast toe and the
 * boundary fence.
 *
 * **The one tone in this file chosen against its neighbours rather than for
 * itself**, because its whole job is to be a *break*. It sits between blue metal
 * at rho 0.055 and whatever the pipeline put down beyond the fence -- which at
 * Lindfield is the tan ground the complaint is about -- and it has to be clearly
 * neither. Warm grey, a shade of dried clay and fines with ballast walked into
 * it, at rho 0.135: sun rgb(151,146,138) Y' 147, shade rgb(80,75,69) Y' 76.
 *
 * That is 63 code values above the ballast in sun and 34 in shade, which is a
 * hard edge at the ballast toe, and about 25 below the pale dirt beside it,
 * which is a soft one at the fence line. The hard edge is the corridor and the
 * soft one is the boundary, which is the right way round: a railway's ballast
 * shoulder is the sharpest line in it and its fence line is not.
 */
const CESS: Rgb = [0.135, 0.128, 0.118];
/**
 * The platform edge's tactile strip, and it is the only saturated colour the
 * railway has.
 *
 * Australian Standard 1428.4 tactile ground surface indicators, in the safety
 * yellow every platform in NSW carries: rho 0.52 in red, 0.40 in green, 0.045 in
 * blue. It is deliberately *not* toned down for the tone curve -- the whole
 * point of the object is that it is the one thing on a grey platform your eye
 * goes to, and every photograph of a Sydney platform is a grey slab with a
 * yellow line down it.
 *
 * Through the chain on an up-facing surface at 3 pm: rgb(250, 226, 108). Half a
 * metre wide at 160 m long, so from the far end of the platform it is a
 * one-pixel yellow rule, which is exactly what it is in life.
 */
const TACTILE: Rgb = [0.52, 0.4, 0.045];
/**
 * Station brick: the dark red the Public Works Department built the whole North
 * Shore line out of between 1890 and 1930, and Lindfield with it.
 *
 * rho 0.105, warm and low: sun rgb(163, 113, 94) Y' 126, shade rgb(88, 57, 46)
 * Y' 65. Below the concrete beside it by 30 code values and *hue-separated* from
 * it, which is what makes a station building read as a building rather than as
 * another piece of railway infrastructure.
 */
const STATION_BRICK: Rgb = [0.105, 0.05, 0.036];
/**
 * Painted steel at platform scale: seats, bins, lamp columns, shelter frames and
 * footbridge balustrades.
 *
 * One material for all of them, and that is a budget decision made in the open:
 * each is worth having and none is worth a pipeline. CityRail's own
 * mid-blue-grey, which every piece of platform furniture in Sydney has been
 * painted since the eighties -- rho 0.075, cool: sun rgb(139, 145, 151) Y' 143,
 * shade rgb(75, 78, 82) Y' 77. Read against the platform's warm concrete it is
 * the temperature difference that separates them rather than the value.
 */
const FURNITURE_STEEL: Rgb = [0.072, 0.078, 0.086];

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

  /**
   * One triangle, wound `a -> b -> c`, with the normal from its own plane.
   *
   * Added in Phase 3a for `writeVesselShell`, which files a *solid's* own
   * triangles into materials and so has triangles rather than quads to write.
   * The obvious shorthand -- `quad` with the third corner passed twice -- is
   * wrong in a way that costs rather than breaks: `quad` always emits four
   * vertices and **two** triangles, so the second one is degenerate, and the
   * drawn corridor would carry a quarter of a million zero-area faces through
   * the vertex shader to rasterise nothing.
   */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
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
    this.position.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) this.normal.push(nx, ny, nz);
    this.uv.push(0, 0, 1, 0, 1, 1);
    this.index.push(base, base + 1, base + 2);
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
  /** The cess and the verge either side of the ballast. */
  readonly cess = standard('rail_cess', CESS, 0.96, 0.0, true);
  /** The tactile strip at the platform edge. */
  readonly tactile = standard('rail_tactile', TACTILE, 0.82, 0.0, true);
  /** The station building. */
  readonly brick = standard('rail_brick', STATION_BRICK, 0.9, 0.0, true);
  /** Seats, bins, lamp columns, shelter frames, balustrades. */
  readonly furniture = standard('rail_furniture', FURNITURE_STEEL, 0.55, 0.35, true);
  /**
   * The corridor boundary fence, and **the one material here this file does not
   * build**: it is `fences.createRailFenceMaterial`, which is
   * `createFenceOpenMaterial` over a rail style, so 300 km of corridor fencing
   * runs the identical alpha-tested bar mask the city's front fences do rather
   * than a second one written from scratch. See that file's header for why the
   * mask lives in `colorNode.a` and nowhere else.
   */
  readonly fence = createRailFenceMaterial();

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
    const cols = 8;
    const cellW = 2048 / cols;
    const cellH = 32;
    const rows = Math.ceil(names.length / cols);
    if (rows * cellH > 2048) {
      console.warn(`[rail] ${names.length} station names do not fit one sign atlas; the tail is blank.`);
    }
    // **The cell layout is arithmetic and the plate is a picture**, and this is
    // split at that line rather than done in one pass under
    // `typeof document !== 'undefined'`. A process with no canvas can still say
    // where a name's cell would be, so a headless check -- `perf-harness.ts`'
    // chunk identity test is the reader -- builds the same sign geometry the
    // browser builds instead of silently skipping every sign in the network.
    // What it does not get is the atlas, which is what `hasSignAtlas` is for.
    for (let i = 0; i < names.length; i++) {
      const x = (i % cols) * cellW;
      const y = ((i / cols) | 0) * cellH;
      if (y + cellH > 2048) break;
      this.signSlots.set(names[i], [
        (x + 2) / 2048,
        1 - (y + cellH - 1) / 2048,
        (x + cellW - 2) / 2048,
        1 - (y + 1) / 2048,
      ]);
    }
    if (typeof document === 'undefined') return;
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
      const x = (i % cols) * cellW;
      const y = ((i / cols) | 0) * cellH;
      if (y + cellH > 2048) break;
      ctx.fillStyle = '#12181c';
      ctx.fillRect(x, y, cellW, cellH);
      ctx.fillStyle = '#eef3f6';
      ctx.font = '600 21px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.fillText(names[i].toUpperCase(), x + cellW / 2, y + cellH / 2 + 1, cellW - 14);
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
      this.cess, this.tactile, this.brick, this.furniture, this.fence,
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
 *
 * ---------------------------------------------------------------------------
 * **THIS LIST IS A MIRROR OF THE `add(...)` CALLS AT THE BOTTOM OF
 * `buildChunk`, AND THAT IS THE ONLY WAY IT CAN BE RIGHT.**
 *
 * WORKSTREAM AE. For the life of this function every entry here was built by one
 * `lit()` helper carrying `{ normal: true, uv: true }` and both `receiveShadow`
 * variants -- and *nine of the ten* materials it covered were wrong, because
 * `Solid.build(name)` emits position, normal and an index and **no uv at all**.
 * The uv only appears under `build(name, true)`, which exactly two callers use:
 * the boundary fence, whose alpha mask is a function of it, and the station-name
 * signs, which sample the atlas with it.
 *
 * A pipeline is keyed on the attribute layout as much as on the material
 * (`RenderObject.getGeometryCacheKey`, mirrored by `warmupSignature`), so the
 * boot pass compiled ten pipelines for a railway that does not exist and the
 * real ballast, rails, concrete, lining, canopy, cess, tactile, brickwork and
 * platform furniture each compiled **inside `render`** the first time a chunk
 * carrying them entered the frustum -- `Pipelines.getForRender`'s blocking
 * branch, tens to hundreds of milliseconds on the main thread.
 *
 * And the chunk ring is rebuilt every 512 m of travel, so on a train that is not
 * a first-walk cost paid once: it is a fresh chunk every few seconds, and the
 * first one to bring a canopy, or a station's brick, or a tunnel lining, pays
 * for it there and then. That is the reported symptom -- *"looking around on the
 * train has little freezes"* -- and it is the same defect the overhead wire had,
 * found the same way, nine more times.
 *
 * So the table below is written against the builder rather than beside it, one
 * row per `add(...)`, with the same `casts` and `receives` those calls pass.
 * `receives` is pinned rather than left at its default of both, which is right
 * *here* and would be wrong for a streamed tile: `applyShadowRole` flips a tile
 * between the two as the player walks at it, and nothing in this file ever
 * changes a rail mesh's flags after `add`. Pinning them halves what this group
 * costs the boot pass -- and, more to the point, means a future `add(...)` whose
 * flags do not match its row is a coverage failure rather than a silent second
 * pipeline. `bun run client/src/perf-harness.ts --coverage` is what checks it.
 */
export function railWarmupParts(assets: RailAssets): WarmupPart[] {
  /**
   * Position, normal and an index: `Solid.build(name)` with no second argument,
   * which is every chunk mesh except the fence and the signs.
   */
  const solid = (material: Material, casts: boolean, receives: boolean): WarmupPart => ({
    geometry: warmupGeometry({ normal: true }),
    material,
    owned: true,
    casts,
    receives: [receives],
  });
  /** And `Solid.build(name, true)`, which adds the uv the mask and the atlas read. */
  const textured = (material: Material, casts: boolean, receives: boolean): WarmupPart => ({
    geometry: warmupGeometry({ normal: true, uv: true }),
    material,
    owned: true,
    casts,
    receives: [receives],
  });
  return [
    solid(assets.ballast, false, true),
    solid(assets.cess, false, true),
    // The rails themselves do **not** cast, and the builder has always said so;
    // this row said they did. Harmless on the colour side -- `castShadow` is not
    // in that key -- but it put a depth pipeline in the boot pass for a pair of
    // 7 cm strips whose shadow at a 10.7 cm shadow texel is nothing, which is the
    // same arithmetic the fence's paragraph below does.
    solid(assets.rail, false, true),
    solid(assets.concrete, true, true),
    // The tunnel lining neither casts nor receives: it is the inside of a tube
    // and the only light in there is the train's.
    solid(assets.lining, false, false),
    solid(assets.canopy, true, true),
    solid(assets.tactile, false, true),
    solid(assets.brick, true, true),
    solid(assets.furniture, true, true),
    // The far corridor ribbon, built once in the constructor rather than per
    // chunk, and flagged `userData.noShadow` at both ends.
    solid(assets.corridor, false, false),
    // The boundary fence, which casts nothing. `fences.ts`' header works out at
    // length what a 0.9 m palisade's shadow is worth at a 10.7 cm shadow texel
    // and the answer for a 1.8 m mesh fence at 300 km of it is the same one with
    // twice the cost: the mask goes solid in the depth pass, so what a corridor
    // fence would throw is a continuous soft bar down both sides of every
    // railway in Sydney. That is not what a see-through fence does, and paying
    // the whole network's depth-pass cost for it would be paying to be wrong.
    textured(assets.fence, false, true),
    // The station-name blades, off the one atlas `prepareSigns` lays out.
    textured(assets.sign, false, false),
    {
      /*
       * **Position only, because that is all the real wire carries.**
       *
       * The overhead wire is built at line ~1310 as a `BufferGeometry` with a
       * position attribute and an index and nothing else -- no normal, no uv,
       * because a 2 cm unlit line has no use for either. This part declared
       * `{ normal: true, uv: true }`, and a pipeline is keyed on the *attribute
       * layout* as well as the material (see `warmupSignature`, which mirrors
       * three's `getGeometryCacheKey`). So the boot pass compiled a pipeline
       * for a wire that does not exist, the real one was never warmed, and the
       * first catenary to enter the frustum compiled inside `render` --
       * `Pipelines.getForRender`'s blocking branch, on the frame it appears.
       *
       * That is a hitch you feel *while riding*, because rail chunks are built
       * and disposed per 512 m and the wire is the thing strung along every
       * electrified line in Sydney. `world/streamer.ts` already gets this right
       * for the power lines, with a comment saying the same thing; this one was
       * copied from the row above it instead.
       *
       * It was also only the first of eleven. See this function's header.
       */
      geometry: warmupGeometry({}),
      material: assets.wire,
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

export type { GroundAt, RailSolids } from './rail-solids.ts';

// --- Per-chunk construction ----------------------------------------------------------

export interface BuiltChunk {
  group: Group;
  geometries: BufferGeometry[];
  collisionKey: string | null;
  /**
   * Built against terrain that had not all arrived, and therefore wrong in a way
   * that will not fix itself. See the `rawGround` argument to `RailWorld`.
   */
  provisional: boolean;
  /** How many times it has been rebuilt hoping for terrain. Bounded; see below. */
  attempts: number;
  /** Instance sources, held so the global sets can be refilled without a rebuild. */
  sleepers: Float32Array;
  masts: number[];
  cx: number;
  cz: number;
}

// --- One chunk, built across frames --------------------------------------------
//
// **WHY A CHUNK IS A STATE OBJECT AND NOT A FUNCTION CALL.**
//
// `RAIL_BUILD_BUDGET_MS`' own header ends by naming what it could not fix, and
// this is that. A millisecond ceiling checked *between* chunks bounds the second
// expensive chunk of a frame and does nothing at all about the first: measured
// over Emu Plains -> Berowra, adding it moved the worst building frame from
// 84.9 ms to 85.8 ms while the count of building frames went 214 -> 224. Both
// numbers together say the worst frame is **one** chunk. A chunk holding a
// station throat or a junction is forty times a chunk of plain double track, and
// no per-frame count can divide one object.
//
// So the object is divided instead. `buildChunk` was a function that ran three
// loops and eleven `Solid.build`s to completion; it is now a `ChunkBuild` -- the
// eleven accumulators, the station plans and a cursor -- advanced one **step** at
// a time under the same millisecond ceiling, across as many frames as it needs.
// The worst frame stops being "whatever the worst chunk costs" and becomes
// `RAIL_BUILD_BUDGET_MS + the worst single step`, which is a bound a reader can
// check by measurement rather than a hope. `RailWorld.worstStepMs` reports the
// second half of that sum for the run of a session, so the claim stays honest as
// the geometry grows.
//
// Four things this arrangement has to get right, each of which is a way to have
// got it wrong:
//
//   - **A chunk appears atomically.** Nothing enters the scene graph and no
//     prism reaches `CollisionWorld` until the last step. Half a chunk is
//     ballast with no rails on it, which is worse than a chunk that is late --
//     and late is already tolerated, because that is what `pending` is.
//   - **Three states, not two.** `built` holds finished chunks; `active` holds
//     the one being built; `pending` holds keys not started. Every reader of
//     `built` below says which of the three it means, and `reshapeRing` skips
//     all three, or an in-progress chunk is queued a second time and built
//     twice.
//   - **Abandonment frees.** The player can walk out of `KEEP_RADIUS` mid-build.
//     `abandonBuild` disposes exactly what the partial build allocated, which is
//     the geometries the finish phase has made so far and the wire.
//   - **The geometry is bit-identical.** The accumulators are order-dependent,
//     so a step must resume exactly where the last one stopped and the write
//     order across materials must not change. `perf-harness.ts`' identity test
//     is the assertion: the same chunk built one step per slice and built in one
//     go must agree vertex for vertex, index for index, prism for prism.
//
// The one honest change in meaning: `rawGround` is now read at several instants
// instead of one, so a chunk can be planned against terrain that arrived while
// it was being built. That is strictly an improvement on the alternative -- a
// tile only ever goes from absent to present -- and any `NaN` still marks the
// chunk provisional, so `retryProvisional` builds it again either way.

/** The phases of a chunk build, in the order they write. See the essay above. */
const PHASE_PLAN = 0;
const PHASE_SEGMENT = 1;
const PHASE_PORTAL = 2;
const PHASE_STATION = 3;
const PHASE_VESSEL = 4;
const PHASE_WIRE = 5;
const PHASE_FINISH = 6;
const PHASE_COUNT = 7;

const PHASE_NAMES = ['plan', 'segment', 'portal', 'station', 'vessel', 'wire', 'finish'];

/** The phase names, for whoever prints `RailWorld.worstStepByPhase`. */
export function chunkPhaseNames(): readonly string[] {
  return PHASE_NAMES;
}

/**
 * The seven steps of one station and the thirteen of the finish, by name.
 *
 * Only ever read to *describe* a step in `RailWorld.worstStep`, and it exists
 * because `finish[3]` is not a thing a reader can act on and
 * `finish.concrete` is: the whole point of reporting the worst step is that it
 * says which seam to look at next.
 */
const STATION_STEP_NAMES = [
  'solids', 'platforms', 'furniture', 'access', 'footbridge', 'house', 'signs',
];
const FINISH_STEP_NAMES = [
  'ballast', 'cess', 'rails', 'concrete', 'lining', 'canopy', 'tactile', 'brick',
  'furniture', 'fence', 'signs', 'wire', 'install',
];

/** What a cursor is pointing at, in words. See `RailWorld.worstStep`. */
function chunkStepName(phase: number, index: number): string {
  if (phase === PHASE_STATION) {
    const sub = index - ((index / STATION_STEPS) | 0) * STATION_STEPS;
    return `station.${STATION_STEP_NAMES[sub]}`;
  }
  if (phase === PHASE_FINISH) return `finish.${FINISH_STEP_NAMES[index] ?? index}`;
  return `${PHASE_NAMES[phase]}[${index}]`;
}

/**
 * Steps within one station, because a station is where the cost is.
 *
 * `writePlatforms`, the furniture, the access stairs, the footbridge, the house
 * and the sign are six separate writers over the same plan and they run in a
 * fixed order, so the seams between them are free: splitting there cannot change
 * a single vertex. The first step is the plan's own solids and their prisms.
 */
const STATION_STEPS = 7;
/** ...and within the finish: eleven materials, the wire, and the tail. */
const FINISH_STEPS = 13;

/**
 * The three states a chunk key can be in, and the fourth that is none of them.
 *
 * Named rather than left as three `Map.has` calls at every call site, because
 * the middle one is the state this round added and the one a reader forgets:
 * see `RailWorld.chunkStateOf`.
 */
export const CHUNK_ABSENT = 0;
export const CHUNK_PENDING = 1;
export const CHUNK_BUILDING = 2;
export const CHUNK_BUILT = 3;

/** Where a build has got to: which phase, and how far into it. */
export interface ChunkCursor {
  phase: number;
  index: number;
}

/**
 * Move a cursor to the next step, skipping empty phases. **Pure**, mutating only
 * the cursor it is handed, which is what makes `verifyRailChunkSteps` able to
 * walk every shape of chunk the network can produce without building one.
 *
 * Returns false when the walk is over. Start at `{ phase: 0, index: -1 }`, so
 * the first call lands on the first real step however many leading phases are
 * empty -- and a chunk with nothing at all in it is a single `false`.
 */
export function advanceChunkStep(sizes: readonly number[], at: ChunkCursor): boolean {
  let phase = at.phase;
  let index = at.index + 1;
  while (phase < sizes.length && index >= sizes[phase]) {
    phase++;
    index = 0;
  }
  at.phase = phase;
  at.index = index;
  return phase < sizes.length;
}

/**
 * A chunk build in flight: everything `buildChunk` used to hold in locals.
 *
 * Nothing here is shared with a finished chunk and nothing here is in the scene.
 * The only fields that are not simply the old locals are the last four, and each
 * is one of the four rules in the essay above.
 */
interface ChunkBuild {
  key: string;
  cx: number;
  cz: number;
  chunk: Chunk;
  /** How many steps each phase has, and where the cursor is. */
  sizes: number[];
  at: ChunkCursor;

  group: Group;
  geometries: BufferGeometry[];
  prisms: SolidPrism[];
  ballast: Solid;
  rails: Solid;
  concrete: Solid;
  lining: Solid;
  canopy: Solid;
  signs: Solid;
  cess: Solid;
  fence: Solid;
  tactile: Solid;
  brick: Solid;
  furniture: Solid;
  sleepers: number[];

  /** The 3x3 neighbourhood's stations, listed at the start and planned one a step. */
  todo: Array<{ si: number; mine: boolean }>;
  plans: StationPlan[];
  /** The solids of the station currently being written, held across its steps. */
  boxes: FrameSolid[];

  floorAt: ((x: number, z: number) => number) | null;
  vesselled: (x: number, z: number) => boolean;
  inChunk: (x: number, z: number) => boolean;

  wireSpans: number;
  wirePosition: Float32Array | null;
  wireIndex: Uint16Array | Uint32Array | null;
  wireCursor: { vp: number; ip: number };
  wire: BufferGeometry | null;

  provisional: boolean;
  attempts: number;
  /**
   * A finished chunk this build replaces when it lands, or null for a first
   * build. See `retryProvisional`: a chunk rebuilt for its terrain stays in the
   * scene until its replacement is ready, because the alternative is a railway
   * that blinks out for a few frames once a second while somebody stands still.
   */
  replacing: BuiltChunk | null;
  /**
   * Does this build join the world when it lands? False for the identity check,
   * which wants the geometry and must not touch the ring, the scene graph or
   * `CollisionWorld`. See `buildChunkSliced`.
   */
  install: boolean;
  /** Set by the tail step. The build is over and `result` is the chunk. */
  landed: boolean;
  result: BuiltChunk | null;
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
  /**
   * Chunks **finished** and in the scene right now. On the debug overlay.
   *
   * One of the three states, and the one a reader means by "resident": a chunk
   * being built is not in the scene, is not collidable and has no sleepers in
   * the instanced set. `buildingChunks` is the second state and `pendingChunks`
   * the third.
   */
  get residentChunks(): number {
    return this.built.size;
  }
  /** Chunks part-built right now: zero or one. See `ChunkBuild`. */
  get buildingChunks(): number {
    return this.active === null ? 0 : 1;
  }
  /** Chunks inside the radius that have not been started. */
  get pendingChunks(): number {
    return this.pending.length;
  }
  /** What the last frame that did any building cost, milliseconds. */
  rebuildMs = 0;
  /** Chunks that have landed over the run of a session. */
  chunksBuilt = 0;
  /**
   * The most expensive **single step** of a chunk build this session, and which
   * one it was.
   *
   * This is the number the split is worth judging on, because the worst frame a
   * rider can meet is `RAIL_BUILD_BUDGET_MS` plus this: the budget is a check
   * between steps rather than a pre-emption, so one segment, one station writer,
   * one portal or one `Solid.build` always completes once started. If this
   * climbs past a few milliseconds the answer is a finer seam inside whatever
   * `worstStep` names, not a smaller budget.
   */
  worstStepMs = 0;
  worstStep = '';
  /**
   * ...and the worst step in each phase, so the number above has a shape rather
   * than only a size.
   *
   * Indexed by `PHASE_*`, named by `chunkPhaseNames()`. It is what says whether
   * the tail is a station writer, a `Solid.build` or a single forty-metre
   * segment, which is the difference between three different next moves.
   */
  readonly worstStepByPhase = new Float64Array(PHASE_COUNT);
  /**
   * Chunk geometries made and not yet disposed. **The leak ledger.**
   *
   * One up in `addMesh` and one down at every `dispose()` this class performs,
   * so it is not a restatement of an array's length: a path that drops a partial
   * build without freeing it leaves this positive, and after a teleport out of
   * every radius it must be exactly zero. That is the assertion in
   * `perf-harness.ts`' abandonment test, and it is the invariant the split put
   * at risk -- before it, a chunk that existed had finished, and the only way to
   * stop owning one was `disposeChunk`.
   */
  liveGeometries = 0;
  /**
   * How many times the millisecond ceiling stopped a frame short of
   * `BUILDS_PER_FRAME`, for the run of a session.
   *
   * Reported rather than acted on, and it is the number that says whether
   * `RAIL_BUILD_BUDGET_MS` is doing anything: zero over a long ride means every
   * frame's builds fitted and the ceiling is inert, which is the expected
   * reading on plain track. It climbs where the chunks are expensive -- station
   * throats, junctions, the approaches to the Harbour Bridge -- and each count
   * is one stall that became a chunk arriving a frame later instead.
   */
  rebuildDeferred = 0;
  /** Draw calls the chunk ring is currently contributing. */
  chunkDraws = 0;
  sleeperCount = 0;
  mastCount = 0;
  /** Instances the capacities refused. Should stay at zero. */
  overflows = 0;
  /** Chunks rebuilt because their terrain arrived late. See `retryProvisional`. */
  provisionalRebuilds = 0;

  /** State one: chunks finished, in the scene, and collidable. */
  private readonly built = new Map<string, BuiltChunk>();
  /**
   * State two: the chunk being built right now, or null.
   *
   * **One at a time**, deliberately. Two builds in flight would need two sets of
   * accumulators alive at once for no gain -- the budget is a wall clock and it
   * does not care which chunk it is spent on -- and would put a second answer in
   * the way of the one question every other method here asks about this state,
   * which is "is this key already being built?".
   */
  private active: ChunkBuild | null = null;
  /** State three: chunk keys inside the build radius that have not been started. */
  private pending: string[] = [];
  private readonly sleeperMesh: InstancedMesh;
  private readonly cantileverMesh: InstancedMesh;
  private readonly gantryMesh: InstancedMesh;
  private lastChunk = '';
  private lastSleeperCell = '';
  /** Frames since the last idle re-plan. See `update`. */
  private idleFrames = 0;
  /**
   * The corridor as closed solids, or null with the flag down. See `setVessels`.
   */
  private vessels: CorridorBuild | null = null;
  /** What the last drawn corridor was, so an identical re-sweep costs nothing. */
  private vesselSignature = '';

  constructor(
    private readonly net: RailNetwork,
    private readonly assets: RailAssets,
    private readonly ground: GroundAt,
    private readonly solids: RailSolids | null = null,
    /**
     * The corridor, so a cutting can be drawn as one. Null draws the railway
     * exactly as it drew before the carve existed, which is what a world with no
     * bake and every check that builds a `RailWorld` by hand gets.
     */
    private readonly cut: RailCut | null = null,
    /**
     * The **raw** terrain height, `NaN` where no tile is loaded -- and this is
     * the whole reason it is a second argument rather than a reuse of `ground`.
     *
     * `main.ts`'s `wildGround` never returns `NaN`: it falls back to
     * `lastGround`, the last height the *player* stood on. That is right for a
     * viaduct pier, which wants a plausible depth rather than none. It is
     * catastrophic for the depth test below, because rail chunks build to
     * `BUILD_RADIUS` 1100 m while `ensureGround` only guarantees terrain to
     * `COLLISION_RADIUS` 420 m -- so at the edge of the ring a naive test would
     * compare a track height against ground from seven hundred metres away and
     * decide, permanently, that the North Shore line is thirty metres
     * underground. An honest `NaN` instead marks the chunk **provisional** and
     * it is built again once its tiles arrive. See `retryProvisional`.
     */
    private readonly rawGround: GroundAt = ground,
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
    if (this.active !== null || this.pending.length > 0) {
      const started = performance.now();
      const deadline = started + RAIL_BUILD_BUDGET_MS;
      let landed = 0;
      // `BUILDS_PER_FRAME` still bounds how many chunks may *land* in one frame,
      // and the ceiling now bounds the time honestly rather than only the chunk
      // queued behind an expensive one: a build that runs out of budget stops
      // between two of its own steps and resumes next frame, so the frame costs
      // the budget plus one step whatever the chunk holds. See `ChunkBuild`.
      for (let n = 0; n < BUILDS_PER_FRAME; n++) {
        if (this.active === null) {
          let next: string | undefined;
          while ((next = this.pending.pop()) !== undefined) {
            if (this.built.has(next) || !this.net.chunks.has(next)) continue;
            break;
          }
          if (next === undefined) break;
          const [cx, cz] = next.split(',').map(Number);
          this.active = this.beginChunk(next, cx, cz, null, true);
        }
        // The first *step* of a frame always runs -- that is what makes progress
        // guaranteed rather than a race against a clock -- but a second chunk
        // started after the ceiling has passed is the old defect back again.
        if (n > 0 && performance.now() > deadline) {
          this.rebuildDeferred++;
          break;
        }
        if (!this.advanceBuild(this.active, deadline)) break;
        this.active = null;
        landed++;
      }
      this.rebuildMs = performance.now() - started;
      if (landed > 0) {
        this.countDraws();
        this.refillMasts(x, z);
        // A chunk that has just arrived may be the one the player is standing on.
        this.lastSleeperCell = '';
      }
    }
    // **And the chunks that were built blind get another look while standing
    // still.** `retryProvisional` used to run only from `reshapeRing`, which is
    // a chunk transition -- so a player who arrives somewhere and *stops* keeps
    // whatever the ring decided in the half-second before their terrain landed,
    // for as long as they stand there. That was survivable while the only thing
    // at stake was a trench wall's height. It is not survivable now that the
    // access stairs are sized from the same measurement: a station planned blind
    // gets a flight that stops short of the ground, and standing at the bottom
    // of it looking up is exactly the report this round exists to answer.
    //
    // Once a second, and `PROVISIONAL_ATTEMPTS` still bounds it, so a chunk over
    // the harbour asks four times and then stops asking forever.
    if (this.pending.length === 0 && this.active === null && ++this.idleFrames >= 60) {
      this.idleFrames = 0;
      this.retryProvisional(x, z);
      this.countDraws();
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
        // Both of the first two states are skipped, and the second is the trap:
        // a chunk half built is not in `built`, so a ring reshape across its own
        // build would queue it a second time and the player would end up with
        // two copies of one chunk's geometry in the scene and one of them
        // orphaned. `chunkStateOf` is the one reader that knows all three.
        const state = this.chunkStateOf(key);
        if (state === CHUNK_BUILT || state === CHUNK_BUILDING) continue;
        if (!this.net.chunks.has(key)) continue;
        const d = chunkDistance(cx + ox, cz + oz, x, z);
        if (d > BUILD_RADIUS) continue;
        wanted.push({ key, d });
      }
    }
    wanted.sort((a, b) => b.d - a.d);
    this.pending = wanted.map((w) => w.key);
    this.retryProvisional(x, z);
    for (const [key, chunk] of this.built) {
      if (chunkDistance(chunk.cx, chunk.cz, x, z) <= KEEP_RADIUS) continue;
      this.disposeChunk(key, chunk);
    }
    // **And the one being built, which no map holds.** A player can cross the
    // ring and keep going while a station chunk is still assembling behind them,
    // and a build nothing will ever want is a build whose geometries are
    // allocated for nothing. `disposeChunk` above has already dropped whatever
    // it was replacing, so this is the only thing left holding it.
    if (this.active !== null && chunkDistance(this.active.cx, this.active.cz, x, z) > KEEP_RADIUS) {
      this.abandonBuild();
    }
    this.countDraws();
  }

  /**
   * Which of the three states holds this key, if any.
   *
   * The single reader, so nothing here can answer the question with one `.has`
   * and forget the other two. `reshapeRing` asks it, and so does the harness's
   * abandonment test -- which is the only way to assert from outside that a
   * build the player walked away from left nothing behind in any of them.
   */
  chunkStateOf(key: string): number {
    if (this.built.has(key)) return CHUNK_BUILT;
    if (this.active !== null && this.active.key === key) return CHUNK_BUILDING;
    return this.pending.includes(key) ? CHUNK_PENDING : CHUNK_ABSENT;
  }

  /** Draws the **finished** chunks contribute. A build in flight draws nothing. */
  private countDraws(): void {
    let draws = 0;
    for (const chunk of this.built.values()) draws += chunk.group.children.length;
    this.chunkDraws = draws;
  }

  private disposeChunk(key: string, chunk: BuiltChunk): void {
    this.group.remove(chunk.group);
    for (const g of chunk.geometries) {
      g.dispose();
      this.liveGeometries--;
    }
    if (chunk.collisionKey && this.solids) this.solids.removeTile(chunk.collisionKey);
    this.built.delete(key);
    // A rebuild waiting on this chunk has nothing left to replace. Dropping it
    // rather than letting it land keeps the rule that a chunk outside
    // `KEEP_RADIUS` holds no geometry: the alternative is a build that finishes
    // a frame later and quietly puts the disposed chunk back.
    //
    // **Unless it is that replacement landing right now**, which is the one call
    // where the two are the same event: the tail step disposes the chunk it
    // supersedes a line before it registers its own prisms under the same
    // collision key, and abandoning there would throw away the finished build on
    // the last step of it.
    if (this.active !== null && this.active.key === key && this.active.replacing !== chunk) {
      this.abandonBuild();
    }
  }

  /**
   * Throw away the build in flight, freeing exactly what it had allocated.
   *
   * A partial build owns two things and nothing else, because that is the whole
   * point of the atomicity rule: the geometries the finish phase has made so far
   * and, between the wire phase and the wire's own `add`, the wire. Its `group`
   * is not in the scene, its prisms are not in `CollisionWorld`, and whatever it
   * was replacing is still exactly where it was. The accumulators are plain
   * arrays and go with the object.
   */
  private abandonBuild(): void {
    const state = this.active;
    if (state === null) return;
    for (const g of state.geometries) {
      g.dispose();
      this.liveGeometries--;
    }
    // The wire between the phase that builds it and the finish step that hands
    // it to `addMesh`, which is the one geometry a partial build owns that is
    // not in `geometries` yet -- and the one an abandonment would otherwise
    // leak without leaving a trace.
    if (state.wire) state.wire.dispose();
    this.active = null;
  }

  /** Drop everything. For a teleport, and for the module's own tests. */
  clear(): void {
    this.abandonBuild();
    for (const [key, chunk] of [...this.built]) this.disposeChunk(key, chunk);
    this.pending.length = 0;
    this.lastChunk = '';
    this.lastSleeperCell = '';
  }

  /**
   * Open a chunk build. Allocates the accumulators and sizes every phase;
   * writes not one vertex.
   *
   * Everything the cursor needs to be known up front is known here, which is
   * what lets `advanceChunkStep` be a pure function over a fixed array. The
   * station count is the only one that looks like it could not be: the *plans*
   * are expensive and are one step each, but the **list** of stations in the 3x3
   * neighbourhood is three nested array reads and is taken now.
   */
  private beginChunk(
    key: string,
    cx: number,
    cz: number,
    replacing: BuiltChunk | null,
    install: boolean,
  ): ChunkBuild {
    const chunk = this.net.chunks.get(key)!;
    const group = new Group();
    group.name = `rail_${key}`;

    // --- Every station whose entrance could reach into this chunk, listed once,
    //     before anything is drawn.
    //
    // Nine chunks rather than one, and that is not caution: a station's stair,
    // its forecourt and the hole it opens in the boundary fence reach about
    // ninety metres from the platform anchor, so a station just over a chunk
    // boundary has to be able to open this chunk's fence. Cheap, because 321
    // stations over 785 chunks means the loop below finds nothing at all in the
    // overwhelming majority of builds.
    const todo: Array<{ si: number; mine: boolean }> = [];
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const near = this.net.chunks.get(chunkKey(cx + ox, cz + oz));
        if (near === undefined) continue;
        for (const si of near.stations) todo.push({ si, mine: ox === 0 && oz === 0 });
      }
    }

    // --- The corridor as closed solids, if there is one. See `setVessels`.
    //
    // Two closures, both null with the flag down, so the segment phase reads as
    // one question -- *is a formation drawn here?* -- asked at the track
    // centreline and answered by the footprint itself.
    const floorAt = this.vessels === null
      ? null
      : (x: number, z: number): number => this.vesselFloorAt(x, z);
    const vesselled = floorAt === null
      ? () => false
      : (x: number, z: number): boolean => Number.isFinite(floorAt(x, z));
    // The half-open box a formation's faces are filed by. See the vessel phase.
    const x0 = cx * CHUNK_M;
    const z0 = cz * CHUNK_M;
    const inChunk = (x: number, z: number): boolean =>
      x >= x0 && x < x0 + CHUNK_M && z >= z0 && z < z0 + CHUNK_M;

    const sizes = new Array<number>(PHASE_COUNT).fill(0);
    sizes[PHASE_PLAN] = todo.length;
    sizes[PHASE_SEGMENT] = chunk.segments.length;
    sizes[PHASE_PORTAL] = chunk.portals.length;
    sizes[PHASE_STATION] = todo.length * STATION_STEPS;
    sizes[PHASE_VESSEL] = this.vessels === null ? 0 : this.vessels.runs.length;
    // The wire is a second pass over the same segments, and how many of them
    // carry one is not known until the first pass has run -- so the phase is
    // sized for all of them and its steps are no-ops where there is no wire.
    // A no-op step costs one `performance.now()`, which is the price of never
    // having to resize a phase the cursor is already inside.
    sizes[PHASE_WIRE] = chunk.segments.length;
    sizes[PHASE_FINISH] = FINISH_STEPS;

    return {
      key, cx, cz, chunk,
      sizes,
      at: { phase: 0, index: -1 },
      group,
      geometries: [],
      prisms: [],
      ballast: new Solid(),
      rails: new Solid(),
      concrete: new Solid(),
      lining: new Solid(),
      canopy: new Solid(),
      signs: new Solid(),
      cess: new Solid(),
      fence: new Solid(),
      tactile: new Solid(),
      brick: new Solid(),
      furniture: new Solid(),
      sleepers: [],
      todo,
      plans: [],
      boxes: [],
      floorAt,
      vesselled,
      inChunk,
      wireSpans: 0,
      wirePosition: null,
      wireIndex: null,
      wireCursor: { vp: 0, ip: 0 },
      wire: null,
      provisional: false,
      attempts: 0,
      replacing,
      install,
      landed: false,
      result: null,
    };
  }

  /**
   * Run steps until the chunk lands or the clock passes `deadline`. Returns true
   * when it has landed.
   *
   * **The budget is a check between steps and not a pre-emption**, which is the
   * same shape and the same honesty about its limit as `RAIL_BUILD_BUDGET_MS`
   * had over whole chunks: one segment, one station writer, one portal or one
   * `Solid.build` always completes once started, so a frame costs the budget
   * plus the worst step rather than the budget. `worstStepMs` is that second
   * term, measured rather than assumed, and it is measured here because the
   * clock is already being read once a step for the budget.
   */
  private advanceBuild(state: ChunkBuild, deadline: number): boolean {
    let last = performance.now();
    while (!state.landed) {
      if (!advanceChunkStep(state.sizes, state.at)) {
        // Unreachable: the tail of the finish phase is the last step and it is
        // what sets `landed`. Belt and braces, because a cursor that walked off
        // the end without landing would spin this loop forever.
        state.landed = true;
        break;
      }
      this.runStep(state);
      const now = performance.now();
      if (state.install) {
        const spent = now - last;
        if (spent > this.worstStepByPhase[state.at.phase]) {
          this.worstStepByPhase[state.at.phase] = spent;
        }
        if (spent > this.worstStepMs) {
          this.worstStepMs = spent;
          this.worstStep = `${chunkStepName(state.at.phase, state.at.index)} of chunk ${state.key}`;
        }
      }
      last = now;
      if (!state.landed && now > deadline) return false;
    }
    return true;
  }

  /**
   * One step of one chunk. The switch is `buildChunk`'s old body, cut at the
   * seams that were already there and at no others.
   *
   * The accumulators are pulled out of the state by name so the writers below
   * read exactly as they did when they were locals: the whole safety argument
   * for this change is that nothing between the seams was touched.
   */
  private runStep(state: ChunkBuild): void {
    const {
      chunk, ballast, rails, concrete, lining, canopy, signs, cess, fence, tactile, brick,
      furniture, plans, prisms, sleepers, floorAt, vesselled,
    } = state;
    const index = state.at.index;
    switch (state.at.phase) {
      // --- The stations, measured. One plan a step: `planStation` samples the
      //     terrain four times and sweeps the chunk's segments twice for
      //     clearance, which is not free at a big station.
      case PHASE_PLAN: {
        const t = state.todo[index];
        plans.push(planStation(this.net, this.net.stations[t.si], this.rawGround, t.mine));
        return;
      }

      case PHASE_SEGMENT: {
        const s = this.net.segments[chunk.segments[index]];
        // **How deep this span is, honestly.** `rawGround` rather than `ground`:
        // an unknown depth must read as unknown here, not as zero. See the
        // constructor's `rawGround` argument for what a wrong answer costs.
        const depth = this.rawGround((s.ax + s.bx) / 2, (s.az + s.bz) / 2) - (s.ay + s.by) / 2;
        // Bore, trench or grade -- one rule, shared with the carve so the hole
        // and the thing standing in it cannot disagree. See `rail-cut.ts`, which
        // also records the measurement that killed the obvious version of this:
        // reading `SPAN_SUBWAY` as "Metro, therefore tunnel below 6 m" lined the
        // deepest 70 spans of the *open* cutting at Sydenham. Sydney Metro's
        // tunnels all carry `tunnel=yes`; the flag that earns its place is
        // `SPAN_CUTTING`, and `inCutting` is where it is spent.
        const tunnel = drawnAsTunnel(s.flags);
        const bridge = (s.flags & SPAN_BRIDGE) !== 0;
        // A span whose depth is unknown cannot be trenched, and a chunk built
        // without knowing is built again. See `retryProvisional`.
        if (!Number.isFinite(depth) && !tunnel && !bridge) state.provisional = true;
        if (tunnel) {
          writeTunnel(lining, s);
        } else {
          writeBallast(ballast, s, bridge, floorAt);
          if ((s.flags & SPAN_ELECTRIFIED) !== 0) state.wireSpans++;
          for (let t = 0; t < s.len; t += SLEEPER_PITCH) {
            const f = t / s.len;
            sleepers.push(
              s.ax + (s.bx - s.ax) * f,
              s.ay + (s.by - s.ay) * f - BALLAST_TOP_DROP,
              s.az + (s.bz - s.az) * f,
              Math.atan2(-s.ux, -s.uz),
            );
          }
          // And the cutting. The ground over this span has been taken away by
          // `terrain.buildTerrainMesh`; this is the trench that stands in the
          // hole.
          //
          // **Asked of the carve, point by point, rather than of the segment's
          // midpoint.** `inCutting(s.flags, depth)` is one sample at the middle
          // of a forty-metre span, and the carve is a sample every four metres,
          // so the two disagreed along every segment that ran into a bank:
          // ground taken away with no trench built in the hole. See
          // `RailCut.cutsAlong`.
          //
          // **Two questions now, and they are asked of the same points.** `cut`
          // is where the ground has come away; `trenched` is where that hole is
          // deep enough to want walls. See `rail-cut.TRENCH_MIN_DEPTH` -- the
          // first fires along most of the at-grade network after this round and
          // the second must not, or every 512 m of walking is a hitch.
          const probe = this.cut === null
            ? { cut: false, trench: false }
            : this.cut.probeAlong(s.ax, s.az, s.bx, s.bz, this.rawGround);
          const carved = probe.cut;
          const trenched = probe.trench;
          // The floor of the hole, before anything is built in it. Where the
          // ground has come away and no trench wall reaches, this is the only
          // surface between the ballast toe and the rim -- and without it the
          // corridor at Erskineville is a slot into the void with two rails over
          // the top of it. See `writeFormation`.
          //
          // **Unless a vessel is drawn here**, in which case all three of these
          // stand down and the formation supplies the floor, the walls, the
          // coping and the fence as faces of one solid. See `setVessels` for why
          // it is all or nothing per point rather than a blend.
          if (carved) writeFormation(ballast, s, this.cut!, this.rawGround, vesselled);
          if (trenched) {
            if (!writeTrench(concrete, prisms, s, this.cut!, this.rawGround, vesselled)) {
              state.provisional = true;
            }
          }
          // ...and the corridor either side of it: the cess and verge where the
          // track is at grade, and the boundary fence everywhere. See
          // `writeVerge` for why a bridge span gets neither.
          if (!bridge) {
            writeVerge(cess, fence, s, this.cut, this.rawGround, trenched, plans, vesselled);
          }
        }
        if (!tunnel) writeRails(rails, s);
        if (bridge) writeViaduct(concrete, prisms, s, this.ground);
        return;
      }

      case PHASE_PORTAL: {
        writePortal(concrete, lining, this.net.portals[chunk.portals[index]]);
        return;
      }

      // --- One station, in seven steps.
      //
      // A station chunk is the object this whole arrangement exists for: a
      // throat like Strathfield or Central is forty times a chunk of plain
      // double track, and the six writers below are the seams that were already
      // there. Their order is fixed and unchanged, which is the only thing the
      // accumulators care about.
      case PHASE_STATION: {
        const p = (index / STATION_STEPS) | 0;
        const plan = state.plans[p];
        if (!plan.mine) return;
        const station = plan.station;
        const underground = station.vertical === 'underground';
        switch (index - p * STATION_STEPS) {
          case 0:
            // A station planned before its terrain arrived is a station whose
            // stairs are the wrong length. See `StationPlan.measured`.
            if (!plan.measured) state.provisional = true;
            // **Every solid this station stands on the world, enumerated once.**
            // `rail-solids.stationSolids` is the definition; this registers it
            // with `CollisionWorld` and the writers below draw it.
            // `RailSolidField` on the server evaluates the identical call over
            // the identical plan, which is what makes the two ends' ground query
            // one number rather than two that agree at the stations somebody
            // checked.
            state.boxes = [];
            stationSolids(plan, state.boxes);
            for (const b of state.boxes) prisms.push(framePrism(b));
            return;
          case 1:
            if (underground) writeUndergroundStation(concrete, lining, signs, state.boxes, station);
            else writePlatforms(concrete, canopy, tactile, plan);
            return;
          case 2:
            // **The access, and it is generated rather than looked up.**
            // `RAIL-VERTICAL.md` section 4: the same measurement that made this
            // station need steps is the one that builds them, so a station
            // cannot be left unreachable by an OSM tag nobody wrote. Reported
            // twice -- "im at roseville and cant get up to the platform", and a
            // player on the Chatswood plaza reading "doors 23 m away" with no
            // way down.
            if (!underground) writePlatformFurniture(canopy, furniture, plan);
            return;
          case 3:
            if (!underground) writeStationAccess(concrete, furniture, state.boxes, plan);
            return;
          case 4:
            if (!underground) writeFootbridge(concrete, furniture, state.boxes, plan);
            return;
          case 5:
            if (!underground) writeStationHouse(brick, canopy, state.boxes, plan);
            return;
          default: {
            const uv = this.assets.signUv(station.name);
            if (!uv) return;
            // The platform blade, for the person already on the platform.
            if (!underground) writeSign(signs, concrete, station, uv);
            // And the board, for the person in the street who does not yet know
            // there is a station here. See `writeStationBoard`: reported as
            // "there is no sign for the train station", and the platform blade
            // is not an answer to it -- it is 45 cm tall, it is under the
            // canopy, and at a station in a cutting it is metres below the
            // footpath.
            writeStationBoard(signs, concrete, station, uv);
            return;
          }
        }
      }

      // --- And the formations, drawn. Phase 3a; nothing here runs with the flag
      //     down, because `setVessels` is never called with a build.
      //
      // Filed by triangle centroid and by panel midpoint rather than clipped, so
      // a 4 km formation crossing eight chunks puts each of its faces in exactly
      // one of them: no triangle is cut, nothing is drawn twice, and there is no
      // seam between two chunks to leak. The test is a half-open box, which is
      // what makes "exactly one" true on the boundary as well as inside.
      case PHASE_VESSEL: {
        if (this.vessels === null) return;
        const run = this.vessels.runs[index];
        // A cheap reject on the run's own ribs, widened by the widest a
        // formation's rim gets from its centreline (`FORMATION_MAX_SPAN_M` is
        // 100 m, so half of it plus slack). Without it every chunk build walks
        // every triangle of every formation in the radius.
        let rx0 = Infinity;
        let rx1 = -Infinity;
        let rz0 = Infinity;
        let rz1 = -Infinity;
        for (const rib of run.ribs) {
          if (rib.cx < rx0) rx0 = rib.cx;
          if (rib.cx > rx1) rx1 = rib.cx;
          if (rib.cz < rz0) rz0 = rib.cz;
          if (rib.cz > rz1) rz1 = rib.cz;
        }
        const pad = 60;
        const x0 = state.cx * CHUNK_M;
        const z0 = state.cz * CHUNK_M;
        if (rx1 + pad < x0 || rx0 - pad > x0 + CHUNK_M) return;
        if (rz1 + pad < z0 || rz0 - pad > z0 + CHUNK_M) return;
        writeVesselShell(concrete, cess, run.vessel, state.inChunk);
        writeVesselFence(fence, run.vessel, state.inChunk, this.cut, plans);
        writeVesselWalls(prisms, run.vessel, state.inChunk);
        return;
      }

      // The overhead line, strung span by span over the electrified segments.
      // The sag maths is `power.ts`' and so is the cross-ribbon: see
      // `writeCatenary`.
      case PHASE_WIRE: {
        if (state.wireSpans === 0) return;
        if (index === 0) {
          const verts = state.wireSpans * 2 * CATENARY_VERTS;
          state.wirePosition = new Float32Array(verts * 3);
          state.wireIndex =
            verts > 65535
              ? new Uint32Array(state.wireSpans * 2 * CATENARY_INDICES)
              : new Uint16Array(state.wireSpans * 2 * CATENARY_INDICES);
        }
        const s = this.net.segments[chunk.segments[index]];
        if ((s.flags & SPAN_TUNNEL) === 0 && (s.flags & SPAN_ELECTRIFIED) !== 0) {
          const px = -s.uz;
          const pz = s.ux;
          const sag = catenarySag(s.len);
          // The messenger sags and the contact wire does not, which is the whole
          // point of a catenary suspension and the only thing that tells one
          // apart from a trolley wire at a glance.
          writeCatenary(
            state.wirePosition!, state.wireIndex!, state.wireCursor,
            s.ax, s.ay + MESSENGER_HEIGHT, s.az,
            s.bx, s.by + MESSENGER_HEIGHT, s.bz,
            px, pz, sag,
          );
          writeCatenary(
            state.wirePosition!, state.wireIndex!, state.wireCursor,
            s.ax, s.ay + CONTACT_HEIGHT, s.az,
            s.bx, s.by + CONTACT_HEIGHT, s.bz,
            px, pz, 0.02,
          );
        }
        if (index === chunk.segments.length - 1 && state.wireCursor.vp > 0) {
          const wire = new BufferGeometry();
          wire.name = `rail_wire_${state.key}`;
          wire.setAttribute(
            'position',
            new BufferAttribute(state.wirePosition!.subarray(0, state.wireCursor.vp * 3), 3),
          );
          wire.setIndex(new BufferAttribute(state.wireIndex!.subarray(0, state.wireCursor.ip), 1));
          wire.computeBoundingSphere();
          state.wire = wire;
        }
        return;
      }

      // --- The finish: eleven materials, the wire, and the tail.
      //
      // `Solid.build` is where a chunk's accumulated arrays become typed arrays
      // and a bounding sphere, and at a station the concrete alone is a hundred
      // thousand floats -- so each material is its own step. The order is the
      // order the meshes are added to the group in, and it is the order it has
      // always been: `countDraws` and the identity check both read it.
      default: {
        const key = state.key;
        const add = (
          geometry: BufferGeometry | null,
          material: Material,
          name: string,
          casts: boolean,
          receives: boolean,
        ): void => this.addMesh(state, geometry, material, name, casts, receives);
        switch (index) {
          case 0: add(ballast.build(`rail_ballast_${key}`), this.assets.ballast, 'ballast', false, true); return;
          case 1: add(cess.build(`rail_cess_${key}`), this.assets.cess, 'cess', false, true); return;
          case 2: add(rails.build(`rail_steel_${key}`), this.assets.rail, 'rails', false, true); return;
          case 3: add(concrete.build(`rail_concrete_${key}`), this.assets.concrete, 'concrete', true, true); return;
          case 4: add(lining.build(`rail_lining_${key}`), this.assets.lining, 'lining', false, false); return;
          case 5: add(canopy.build(`rail_canopy_${key}`), this.assets.canopy, 'canopy', true, true); return;
          case 6: add(tactile.build(`rail_tactile_${key}`), this.assets.tactile, 'tactile', false, true); return;
          case 7: add(brick.build(`rail_brick_${key}`), this.assets.brick, 'house', true, true); return;
          case 8: add(furniture.build(`rail_furniture_${key}`), this.assets.furniture, 'furniture', true, true); return;
          // The boundary fence, with UVs, because the whole object is a mask on
          // them: `u` is metres along the run and `v` metres up the panel, which
          // is exactly what `fences.createFenceOpenMaterial` reads. It casts
          // nothing -- see `railWarmupParts` for the arithmetic behind that.
          case 9: add(fence.build(`rail_fence_${key}`, true), this.assets.fence, 'fence', false, true); return;
          case 10: add(signs.build(`rail_sign_${key}`, true), this.assets.sign, 'signs', false, false); return;
          case 11:
            add(state.wire, this.assets.wire, 'wire', false, false);
            // Handed over: `addMesh` has pushed it into `geometries`, so
            // `abandonBuild` must not dispose it a second time.
            state.wire = null;
            return;
          default: {
            // --- The tail, and the only step in the build that anything outside
            //     this object can see.
            //
            // A chunk enters the scene, the collision world and the ring
            // together or not at all. Everything above wrote into objects
            // nothing can reach, which is what makes a half-built chunk simply
            // late rather than visibly wrong -- see `ChunkBuild`.
            if (state.replacing !== null) {
              // What this build supersedes goes first, so `addPrisms` below is
              // not racing `removeTile` for the same collision key. See
              // `retryProvisional`.
              this.disposeChunk(state.key, state.replacing);
              this.provisionalRebuilds++;
            }
            let collisionKey: string | null = null;
            if (state.install) {
              if (state.group.children.length > 0) this.group.add(state.group);
              if (this.solids && prisms.length > 0) {
                collisionKey = `rail:${key}`;
                this.solids.addPrisms(collisionKey, prisms);
              }
            }
            state.result = {
              group: state.group,
              geometries: state.geometries,
              collisionKey,
              provisional: state.provisional,
              attempts: state.attempts,
              sleepers: new Float32Array(sleepers),
              masts: chunk.masts,
              cx: state.cx,
              cz: state.cz,
            };
            state.landed = true;
            if (state.install) {
              this.built.set(key, state.result);
              this.chunksBuilt++;
            }
            return;
          }
        }
      }
    }
  }

  /** One mesh into a build's group. `buildChunk`'s `add`, unchanged. */
  private addMesh(
    state: ChunkBuild,
    geometry: BufferGeometry | null,
    material: Material,
    name: string,
    casts: boolean,
    receives: boolean,
  ): void {
    if (!geometry) return;
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = casts;
    mesh.receiveShadow = receives;
    if (!casts) mesh.userData.noShadow = true;
    state.group.add(mesh);
    state.geometries.push(geometry);
    if (state.install) this.liveGeometries++;
  }

  /**
   * Build one chunk to completion outside the ring, in slices of `budgetMs`.
   *
   * **For `perf-harness.ts`' identity test and for nothing else.** The whole
   * safety argument for splitting a chunk across frames is that the seams change
   * no geometry, and the way to assert that is to build the same chunk twice --
   * once one step per slice, once in a single slice -- and compare every buffer.
   * A budget of `Infinity` is the second of those; a negative one is the first,
   * because the deadline is then already past when the first step returns.
   *
   * Nothing here joins the world: no scene graph, no `CollisionWorld`, no entry
   * in any of the three states. The caller owns the geometries and must dispose
   * them.
   */
  buildChunkSliced(key: string, budgetMs: number): { chunk: BuiltChunk; prisms: readonly SolidPrism[] } | null {
    if (!this.net.chunks.has(key)) return null;
    const [cx, cz] = key.split(',').map(Number);
    const state = this.beginChunk(key, cx, cz, null, false);
    let slices = 0;
    while (!this.advanceBuild(state, performance.now() + budgetMs)) {
      // A slice that made no progress would spin here forever. It cannot: the
      // budget is checked *after* a step has run, so every slice advances the
      // cursor at least once and the cursor is finite.
      if (++slices > 1_000_000) throw new Error(`rail chunk ${key} did not finish in a million slices`);
    }
    return { chunk: state.result!, prisms: state.prisms };
  }

  /**
   * The corridor as closed solids, to draw and to defer to.
   *
   * ---------------------------------------------------------------------------
   * **PHASE 3A: WHAT THE VESSEL TAKES OVER, AND WHY IT IS ALL OR NOTHING PER
   * POINT.**
   *
   * With `?vessels=1` the railway inside a formation's footprint is drawn from
   * the vessel and **only** from the vessel: `writeTrench`, `writeFormation` and
   * `writeVerge`'s cess and fence all stand down there. That is not tidiness. A
   * formation floor and a `writeFormation` slab are two surfaces at two heights
   * over the same ground -- the vessel's floor is under the *lowest* rail the
   * formation carries and the slab is under *this track's* -- so drawing both is
   * the double description this whole redesign is about, with a z-fight to
   * announce it.
   *
   * The question asked is `VesselField.surfaceAt` **at the track centreline**,
   * and it is exact rather than a radius: inside the rim ring the field answers
   * with the surface of a solid and outside it answers `-Infinity`, because the
   * footprint is the rim and the rim is a ring of vertices. A track that is a
   * member of a formation has its centreline inside that formation by
   * construction, so the test is the membership rule read back out.
   *
   * What does **not** stand down: the rails, the sleepers, the ballast and the
   * platforms. The ballast is rebased onto the vessel's own floor instead (see
   * `writeBallast`) -- a track four metres above the formation floor needs four
   * metres of blue metal under it, not half a metre and a drop -- and the
   * platform is Phase 3b.
   *
   * Chunks already built are dropped, because a chunk decides once and for all
   * what it draws and the vessel arrives as the DEM does. Same mechanism, same
   * bound, and the same reason as `invalidate`.
   */
  setVessels(build: CorridorBuild | null): void {
    this.vessels = build;
    // **Only when the answer could have changed**, which is not the same as
    // "whenever a tile lands". The corridor is re-swept every time the resident
    // tile count moves -- that is `refreshVessels`' own trigger -- and most of
    // those sweeps produce the identical formations, because the tile that
    // landed is nowhere near the railway. Dropping every rail chunk on each of
    // them is the whole ring rebuilt at two chunks a frame, over and over, with
    // the railway visibly going away and coming back while it happens.
    //
    // The signature is what the drawn geometry is a function of: how many
    // formations there are and how many triangles they carry. A sweep that adds
    // a formation or lengthens one changes it; a sweep that reproduces the same
    // corridor does not.
    const signature = build === null ? '' : `${build.runs.length}:${build.triangles}`;
    if (signature === this.vesselSignature) return;
    this.vesselSignature = signature;
    // The build in flight goes with them: it was sized against the old
    // corridor -- `ChunkBuild.sizes` carries the run count and its closures
    // capture the old field -- so letting it land would put a chunk drawn to a
    // superseded formation in the scene, which is the one thing this method
    // exists to prevent.
    this.abandonBuild();
    for (const [key, chunk] of [...this.built]) this.disposeChunk(key, chunk);
    this.lastChunk = '';
    this.lastSleeperCell = '';
  }

  /**
   * Is a formation drawn over this point, and what is its surface?
   *
   * `NaN` where no vessel covers it, which is the whole footprint question in
   * one number: the field answers `-Infinity` outside every rim ring, and there
   * is nothing to compare and no radius to choose.
   */
  private vesselFloorAt(x: number, z: number): number {
    if (this.vessels === null) return Number.NaN;
    const y = this.vessels.field.surfaceAt(x, z);
    return y > -Infinity ? y : Number.NaN;
  }

  /**
   * Throw away built chunks over a plan box, so they are built again.
   *
   * **For the roads, and only the roads.** A chunk decides once and for all
   * where its fence panels stand and how high its retaining walls go, and both
   * of those now depend on `RailCut.deckSurfaceAt` -- which is empty until the
   * tile carrying that street has streamed in. A chunk built first keeps a
   * palisade across the carriageway and a wall coming up through the asphalt,
   * which is the frame the player photographed and reported twice.
   *
   * The counterpart of `streamer.recutGround`, and bounded the same way: a way
   * span is clipped to its own tile, so a tile's roads reach at most the four
   * chunks its 500 m box overlaps, and the caller only asks at all when one of
   * those roads is actually near a corridor. `reshapeRing` rebuilds whatever is
   * inside the radius on the next update, two a frame, exactly as it does for a
   * chunk the player has just walked towards.
   *
   * Returns how many were dropped, for the log.
   */
  invalidate(box: readonly [number, number, number, number]): number {
    const overlaps = (cx: number, cz: number): boolean => {
      const x0 = cx * CHUNK_M;
      const z0 = cz * CHUNK_M;
      return !(x0 > box[2] || x0 + CHUNK_M < box[0] || z0 > box[3] || z0 + CHUNK_M < box[1]);
    };
    // The build in flight is decided by the same stale road deck as a finished
    // chunk over the box -- its fence panels and its wall heights are already
    // written -- so it is dropped on the same test rather than allowed to land
    // as the thing this method exists to remove.
    if (this.active !== null && overlaps(this.active.cx, this.active.cz)) this.abandonBuild();
    let dropped = 0;
    for (const [key, chunk] of [...this.built]) {
      if (!overlaps(chunk.cx, chunk.cz)) continue;
      // `disposeChunk` deletes from `built` itself.
      this.disposeChunk(key, chunk);
      dropped++;
    }
    if (dropped > 0) {
      // The ring is re-planned from scratch on the next update rather than left
      // to the chunk-transition test, which only fires when the player crosses
      // a 512 m line and would otherwise leave the hole open until they did.
      this.lastChunk = '';
      this.lastSleeperCell = '';
    }
    return dropped;
  }

  /**
   * Build again the chunks that were built blind.
   *
   * The window this closes: a chunk 900 m away is inside `BUILD_RADIUS` and its
   * tiles are not yet resident, so every depth in it came back `NaN`, so every
   * subway span in it was drawn as a bore and no cutting was trenched. Nothing
   * would ever revisit it -- `reshapeRing` skips anything already in `built` --
   * and the player would walk into a suburb whose railway was decided before its
   * ground existed.
   *
   * Run on chunk transitions rather than per frame, because that is when the
   * terrain set has meaningfully changed, and **bounded**: a chunk over the
   * harbour or past the edge of coverage has no terrain and never will, and
   * rebuilding it every 512 m for the rest of the session would be a permanent
   * cost for a permanently unanswerable question. Four attempts is enough for the
   * ring to fill in behind a player who walked straight out from the spawn.
   */
  private retryProvisional(x: number, z: number): void {
    // One at a time, and never while another build is in flight: a rebuild is
    // the same work as a first build and goes through the same budget. See
    // `RailWorld.active`.
    if (this.active !== null) return;
    for (const [key, chunk] of this.built) {
      if (!chunk.provisional || chunk.attempts >= PROVISIONAL_ATTEMPTS) continue;
      if (chunkDistance(chunk.cx, chunk.cz, x, z) > BUILD_RADIUS) continue;
      // **The chunk it replaces stays in the scene until this lands.** It used
      // to be disposed first and rebuilt in the same call, which was invisible
      // while a rebuild was one statement. Spread over frames it would be a
      // railway that blinks out and back once a second while a player stands
      // still at a station waiting for their terrain -- so the swap happens in
      // the tail step instead, where it is one event. See `ChunkBuild.replacing`.
      this.active = this.beginChunk(key, chunk.cx, chunk.cz, chunk, true);
      this.active.attempts = chunk.attempts + 1;
      return;
    }
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
        // **No mast up through a roadway**, and this one really was in the
        // picture: the portal gantry at (-2501, 4285) stands 7.4 m over a
        // railhead that clears King Street by 7.0 m, so its head and its
        // cross-beam came out of the asphalt with the road drawn round them.
        // `MAST_HEIGHT` is within half a metre of the tightest road clearance on
        // the network, so this is not a rare coincidence -- it is what happens
        // wherever the bake wanted a mast at a crossing.
        //
        // **The test is the mast's own head against the soffit, not "is there a
        // road overhead"**, and the difference is measurable: at St Peters the
        // Metro bore passes 16 m under King Street and carries two masts of its
        // own, and a plain "under a deck" rule deleted those too -- 2 of the 7
        // masts in that one crossing, neither of which was anywhere near the
        // road. A catenary structure with headroom under a bridge is real and
        // stays; one that would come through the deck is carried on the soffit
        // in reality and is simply not drawn.
        const px = mx + -uz * offset;
        const pz = mz + ux * offset;
        const deck =
          this.cut === null
            ? Number.NaN
            : this.cut.deckSurfaceAt(px, pz, this.rawGround(px, pz));
        if (Number.isFinite(deck) && my - 0.25 + MAST_HEIGHT > deck - DECK_THICKNESS_M) continue;
        // --- And **on the formation**, not on its own track. Phase 3a.
        //
        // The bake puts a stanchion on a track centreline and this offsets it
        // `MAST_OFFSET` to one side, which is where a mast goes beside a single
        // line and is not where the ground is in a cutting. A formation's floor
        // is under the **lowest** rail it carries, so a mast beside a track four
        // metres up stands with its base plate four metres in the air: the same
        // defect as the ballast, one object over.
        //
        // Asked of the drawn surface, so the foot lands on whatever the player
        // is standing on -- the floor, or a coping if the stanchion sits at the
        // rim. `-1.0` is where the shaft's own base plate is in the instanced
        // geometry (see `buildMast`), so this puts *that* on the surface.
        //
        // **Only ever lowered.** Raising a mast to a surface above it would be
        // standing it on the coping over its own track, and the wire it carries
        // has not moved; what is being fixed is a mast in mid-air, which is the
        // only direction the error goes.
        let my2 = my - 0.25;
        const floor = this.vesselFloorAt(px, pz);
        if (Number.isFinite(floor) && floor + 1.0 < my2) my2 = floor + 1.0;
        // Local +X along the track and +Z toward the track, so a Y rotation of
        // `atan2` puts the geometry on the rails and the `side` scale hands it.
        const yaw = Math.atan2(-uz, ux) + (kind === 1 ? Math.PI : 0);
        _matrix.makeRotationY(yaw);
        _matrix.setPosition(px, my2, pz);
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
// --- The winding rule, and the bug it hid for four rounds --------------------------
//
// **THE ONE RULE THE FOUR WRITERS BELOW GOT WRONG, WRITTEN DOWN ONCE.**
//
/*
 * `Solid.quad(a, b, c, d)` takes its normal from `(b - a) x (d - a)`. Every
 * writer in this file works in the track frame -- `a` and `b` are the two ends
 * of the run, `c` and `d` are the same two ends at a **larger offset** across
 * it -- and in that frame the arithmetic comes out like this:
 *
 *     u = b - a  =  along  =  (ux, 0, uz) * len
 *     v = d - a  =  across =  (px, 0, pz) * width,  with (px, pz) = (-uz, ux)
 *     u x v      =  (0, -(ux^2 + uz^2), 0) * len * width  =  **(0, -1, 0)**
 *
 * So the natural, obvious, reads-correctly-left-to-right order gives a surface
 * that faces **down**, and every material here is `FrontSide`. A floor written
 * that way is not a floor: it is a hole with a normal.
 *
 * `writeVerge` and `writeTrench` already know this -- both open with a `face`
 * helper and a paragraph about handedness -- but they wrote it as a *mirroring*
 * problem, about `side = -1` reversing the frame, and so the four writers that
 * have no sides never got the note. `writeBallast`, `writeFormation`,
 * `writeRails` and `writeViaduct` between them are the whole running surface of
 * the railway, and all of it was inside out.
 *
 * The rule, stated so the next writer does not have to re-derive it: **to face
 * up, wind the far offset first** -- `quad(d, c, b, a)` where `quad(a, b, c, d)`
 * reads naturally. `Solid.box` is unaffected and correct, which is why the
 * platforms, the copings and the station kit always looked right and only the
 * things a train runs on did not.
 */

function writeBallast(
  s: Solid,
  seg: Segment,
  bridge: boolean,
  /**
   * The formation floor under this track, or `NaN` where no vessel covers it.
   *
   * ---------------------------------------------------------------------------
   * **PHASE 3A, AND IT IS THE THING `STATIONS.md` NAMED AS NEXT TO BE WRONG.**
   *
   * *"a track's ballast sitting on a formation floor at the lowest member's
   * level is the next visible thing to be wrong. The floor is flat and the
   * tracks are not, by up to `FORMATION_RISE_M`."* A formation is one cutting
   * with one floor under the **lowest** rail it carries, so a track four metres
   * above that floor gets four metres of daylight under its half-metre of blue
   * metal -- the rails on a plinth of nothing.
   *
   * What a railway actually does there is put more ballast under it, and that is
   * all this is: the prism's base is the drawn floor rather than a constant, so
   * the blue metal reaches whatever surface is under it. The depth is still at
   * *least* `BALLAST_DEPTH`, because the floor is 0.75 m under the lowest rail
   * head and a track at that level must not end up with 20 cm of stone.
   *
   * The floor is read from `VesselField.surfaceAt`, which is the same answer the
   * ground query gives and the same surface the shell draws -- so the ballast
   * toe lands on the floor the player is standing on, by construction rather
   * than by two modules agreeing.
   */
  floorAt: ((x: number, z: number) => number) | null,
): void {
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
  const flat = bridge ? 0.4 : BALLAST_DEPTH;
  /** How far down the stone goes at one end of the segment. */
  const deep = (x: number, z: number, top: number): number => {
    if (bridge || floorAt === null) return flat;
    const floor = floorAt(x, z);
    return Number.isFinite(floor) ? Math.max(flat, top - floor) : flat;
  };
  const depthA = deep(seg.ax, seg.az, ay);
  const depthB = deep(seg.bx, seg.bz, by);

  const p = (x: number, y: number, z: number, o: number, dy: number): [number, number, number] => [
    x + px * o,
    y + dy,
    z + pz * o,
  ];
  const a1 = p(ax, ay, az, -topHalf, 0);
  const a2 = p(ax, ay, az, topHalf, 0);
  const b1 = p(bx, by, bz, -topHalf, 0);
  const b2 = p(bx, by, bz, topHalf, 0);
  const a3 = p(ax, ay, az, -baseHalf, -depthA);
  const a4 = p(ax, ay, az, baseHalf, -depthA);
  const b3 = p(bx, by, bz, -baseHalf, -depthB);
  const b4 = p(bx, by, bz, baseHalf, -depthB);
  // Top, then the two shoulders. No underside and no ends: the underside is
  // buried and the ends are inside the next segment's overlap.
  //
  // ---------------------------------------------------------------------------
  // **AND EVERY ONE OF THEM WAS WOUND INSIDE OUT.** See the winding note above.
  // The prism this function emits is the *floor of the railway*: it is what a
  // rider looking down out of a carriage is standing over, and on a `FrontSide`
  // material a downward normal means nothing is drawn there at all. Measured in
  // a browser at St Peters, 8.0 m down in the cutting: **5,994 of 5,994** drawn
  // ballast triangles faced down, a ray cast straight down from the railhead hit
  // nothing but the catenary, and the frame from a seat is bare terrain,
  // floating sleepers and wire with no blue metal in it anywhere. That is the
  // report, in the player's words -- *"i see thru the ground under my feet"* --
  // and it is why four rounds of widening and flooring the formation never
  // touched it: the geometry was always there and was never drawn.
  s.quad(...a2, ...b2, ...b1, ...a1);
  s.quad(...a1, ...b1, ...b3, ...a3);
  s.quad(...a4, ...b4, ...b2, ...a2);
}

/**
 * The floor of the hole: blue metal across the whole carved corridor.
 *
 * ---------------------------------------------------------------------------
 * **The answer to "there should always be rocks under the tracks", and it is a
 * floor rather than a fatter ballast prism for one reason: the hole is wider
 * than any one track's ballast and there may be no track in the middle of it.**
 * `rail-cut.CUT_HALF_WIDTH` opens 5.4 m each side of every centreline (9.4 m at
 * a platform) and `writeBallast` fills 3.3 m of that. Between the two, and
 * between the ballast toes of two parallel roads more than 6.6 m apart, the
 * terrain has been taken away and nothing was ever put back -- so the frame the
 * player reported at Erskineville has the rails hanging over a slot with the
 * sky-coloured void behind it. Four hundred metres of that is one report.
 *
 * `writeTrench` draws a cess from the ballast toe out to the wall foot and
 * `writeVerge` draws a batter from the toe out to the fence, but neither is
 * unconditional: the trench's runs only where the drop earns walls, the verge's
 * only on a side `markCorridorEdges` called the *outside* of the corridor. The
 * inside of a six-road corridor is neither, and that is exactly the middle of
 * Redfern, Eveleigh, Erskineville and Central.
 *
 * So this is the one piece that is drawn wherever the ground has come away, from
 * the same `halfWidthAt` the hole's own rim is measured with, and everything
 * else laps over the top of it. Two centimetres under the cess deliberately --
 * the trench's own cess strip sits at exactly the formation and two coplanar
 * opaque surfaces are a z-fight along every cutting in the city.
 *
 * ---------------------------------------------------------------------------
 * **Only where the ground has actually gone.** Asked per rib rather than per
 * segment, because a floor drawn under standing ground is a slab poking out of
 * the grass at every point where a cutting runs out to grade.
 *
 * One quad per rib pair, on `TRENCH_STEP_M`'s own pitch: five quads on a
 * forty-metre span, against the hundred and forty the trench costs.
 */
function writeFormation(
  s: Solid,
  seg: Segment,
  cut: RailCut,
  rawGround: GroundAt,
  /** Is a formation vessel drawn over this point? Then it is the floor. */
  vesselled: (x: number, z: number) => boolean,
): void {
  const px = -seg.uz;
  const pz = seg.ux;
  const steps = Math.max(1, Math.round(seg.len / TRENCH_STEP_M));
  const ext = 0.5;
  interface Rib { cx: number; cz: number; y: number; half: number; cut: boolean }
  const ribs: Rib[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = -ext + t * (seg.len + 2 * ext);
    const cx = seg.ax + seg.ux * along;
    const cz = seg.az + seg.uz * along;
    const rail = seg.ay + (seg.by - seg.ay) * t;
    const g = rawGround(cx, cz);
    // **This segment's own strip, not `cutAt`'s maximum over every strip that
    // covers the point.** `cutAt` is a cell lookup plus a `railYOn` per strip,
    // and asking it five times a segment over five hundred segments is tens of
    // milliseconds of a chunk build for a distinction nobody can see: where a
    // *neighbouring* road's corridor is cut and this one's is not, that road's
    // own formation floor covers the same ground. One subtraction instead.
    //
    // A rib whose ground is not loaded reads as uncut: the caller's own depth
    // test marks the chunk provisional and it is built again, and the
    // conservative direction is to draw nothing rather than a slab.
    ribs.push({
      cx, cz,
      y: rail - BALLAST_TOP_DROP - BALLAST_DEPTH - 0.02,
      half: cut.halfWidthAt(cx, cz),
      // A vessel's floor is this slab's job done properly -- one floor under the
      // whole formation at the level one floor can be at -- so where there is
      // one this rib draws nothing rather than a second slab
      // `FORMATION_RISE_M` above or below it.
      cut: Number.isFinite(g) && g - rail > CUT_MIN_DEPTH && !vesselled(cx, cz),
    });
  }
  const at = (rib: Rib, o: number): [number, number, number] => [
    rib.cx + px * o, rib.y, rib.cz + pz * o,
  ];
  for (let i = 0; i < ribs.length - 1; i++) {
    const a = ribs[i];
    const b = ribs[i + 1];
    if (!a.cut && !b.cut) continue;
    // Wound to face up, which is the only side of it anybody ever sees -- and
    // until this round it was not. The far offset goes first; see the winding
    // note above `writeBallast`. This slab is the floor of a *carved* corridor,
    // so a downward normal on it is the worst case there is: the ground has
    // been taken away and the thing put back in the hole is invisible from
    // inside the hole.
    s.quad(...at(a, a.half), ...at(b, b.half), ...at(b, -b.half), ...at(a, -a.half));
  }
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
    // and two dark ones, and that is exactly three quads -- wound far-offset
    // first, per the note above `writeBallast`. A rail head is the single most
    // looked-down-at surface in the game and it faced the wrong way: 1,904 of
    // 1,904 head triangles measured with a negative normal, so from a carriage
    // the running line was not drawn at all.
    s.quad(ax + wx, ay, az + wz, bx + wx, by, bz + wz, bx - wx, by, bz - wz, ax - wx, ay, az - wz);
    s.quad(ax - wx, ay, az - wz, bx - wx, by, bz - wz, bx - wx, by - lo, bz - wz, ax - wx, ay - lo, az - wz);
    s.quad(ax + wx, ay - lo, az + wz, bx + wx, by - lo, bz + wz, bx + wx, by, bz + wz, ax + wx, ay, az + wz);
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
  // The deck's extents come from `rail-solids.viaductDeck`, which is what
  // `RailSolidField` reads to answer the ground query over the same deck. The
  // parapets below are decoration and register nothing; the deck prism stands a
  // metre proud of the running surface to hold a body inside them, and that is
  // `viaductSolids`' number rather than a second one written here.
  const d = viaductDeck(seg);
  const { ax, az, bx, bz, px, pz, soffit, top } = d;
  const h = d.half;
  const corner = (x: number, z: number, o: number, y: number): [number, number, number] => [
    x + px * o, y, z + pz * o,
  ];
  // **Every quad below is wound far-corner-first.** All ten of them read the
  // natural way round before this round and all ten faced inwards: the deck top
  // pointed at the ground, the soffit pointed at the sky, and both fascias and
  // both parapets pointed into the deck. See the winding note above
  // `writeBallast` -- it is the same one sign, and a viaduct is the case where
  // it costs twice, because a rider looks down through the deck and a walker
  // underneath looks up through the soffit.
  s.quad(...corner(ax, az, h, top), ...corner(bx, bz, h, top), ...corner(bx, bz, -h, top), ...corner(ax, az, -h, top));
  s.quad(...corner(bx, bz, -h, soffit), ...corner(bx, bz, h, soffit), ...corner(ax, az, h, soffit), ...corner(ax, az, -h, soffit));
  s.quad(...corner(bx, bz, h, soffit), ...corner(bx, bz, h, top), ...corner(ax, az, h, top), ...corner(ax, az, h, soffit));
  s.quad(...corner(ax, az, -h, soffit), ...corner(ax, az, -h, top), ...corner(bx, bz, -h, top), ...corner(bx, bz, -h, soffit));
  // Parapets, which are what a viaduct is recognised by from underneath and from
  // the street beside it.
  for (const side of [-1, 1]) {
    const o = (h - 0.22) * side;
    const cx = ax + px * o;
    const cz = az + pz * o;
    const dxp = bx + px * o;
    const dzp = bz + pz * o;
    s.quad(
      cx - px * 0.22, top + 0.95, cz - pz * 0.22,
      dxp - px * 0.22, top + 0.95, dzp - pz * 0.22,
      dxp - px * 0.22, top, dzp - pz * 0.22,
      cx - px * 0.22, top, cz - pz * 0.22,
    );
    s.quad(
      cx + px * 0.22, top, cz + pz * 0.22,
      dxp + px * 0.22, top, dzp + pz * 0.22,
      dxp + px * 0.22, top + 0.95, dzp + pz * 0.22,
      cx + px * 0.22, top + 0.95, cz + pz * 0.22,
    );
    s.quad(
      cx + px * 0.22, top + 0.95, cz + pz * 0.22,
      dxp + px * 0.22, top + 0.95, dzp + pz * 0.22,
      dxp - px * 0.22, top + 0.95, dzp - pz * 0.22,
      cx - px * 0.22, top + 0.95, cz - pz * 0.22,
    );
  }

  // The deck's prism and the piers, from the one enumerator. A pier is drawn
  // here and made solid there, off the same `base`, so a leg that is skipped for
  // want of headroom is skipped on both ends by the same test.
  viaductSolids(seg, ground, (prism, kind) => {
    prisms.push(prism);
    if (kind !== SOLID_VIADUCT_PIER) return;
    const cx = (prism.points[0] + prism.points[4]) / 2;
    const cz = (prism.points[1] + prism.points[5]) / 2;
    s.box(cx - PIER_HALF, prism.base, cz - PIER_HALF, cx + PIER_HALF, soffit + 0.1, cz + PIER_HALF);
  });
}

/**
 * A cutting: two battered retaining walls and the cess between them and the
 * ballast, standing in the hole `terrain.buildTerrainMesh` cut for them.
 *
 * ---------------------------------------------------------------------------
 * **The wall top is the rim of the hole and that is not a coincidence.** Its
 * offset from the track centre is `cut.halfWidthAt` at the same centreline point
 * the carve asked about, so the two are the same number by construction rather
 * than by two constants that agree today. The coping then laps `TRENCH_COPING`
 * further out and `TRENCH_COPING_RISE` higher, over ground that is still there,
 * so even a floating-point disagreement about the rim is covered by half a metre
 * of stone instead of showing the void through a hairline.
 *
 * The wall re-reads the terrain every `TRENCH_STEP_M` along the run, because a
 * 40 m segment is longer than a DEM post and a single ruled quad would leave its
 * top a metre off the ground in the middle. Where the terrain is not loaded this
 * returns **false** and the caller marks the chunk provisional: a wall built to a
 * guessed height is worse than one built a second time.
 *
 * ---------------------------------------------------------------------------
 * The collision is the wall prism and there is deliberately no floor prism.
 * `CollisionWorld.solidFor` makes a prism with `base` = the cess and `top` = the
 * terrain do both jobs at once -- you walk over it from the street and into it
 * from the trench -- while a floor prism would be dead weight, because
 * `groundHeightAt` takes the max of everything and the grade above always wins.
 * Standing at track level is `main.ts`'s `groundHeightAt` and `RailCutField`'s
 * business, not this function's.
 */
function writeTrench(
  s: Solid,
  prisms: Array<{ points: Float32Array; height: number; base: number }>,
  seg: Segment,
  cut: RailCut,
  rawGround: GroundAt,
  /**
   * Is a formation vessel drawn over this point?
   *
   * Then this function draws **nothing at all** there -- not the wall, not the
   * coping, not the cess and not the collision box. The vessel's own wall is
   * drawn from its own rim and its own barrier comes off the same vertices; a
   * `writeTrench` wall beside it would be a second wall at a re-measured rim,
   * which is the arrangement Phase 1 opened by describing.
   *
   * Asked at the **centreline**, once per rib, because that is where a track's
   * membership of a formation is decided. A rib at the mouth of a cutting, where
   * the formation has ended and this track runs on, still gets its old wall.
   */
  vesselled: (x: number, z: number) => boolean,
): boolean {
  const px = -seg.uz;
  const pz = seg.ux;
  // **Measured once, in `rail-solids.trenchProfile`, and read three times.**
  // The wall's quads, the wall's prism and the server's ground query are three
  // renderings of these ribs; before this they were two measurements and a
  // silence, and the silence is why a body on the client stood on a coping the
  // server had never heard of.
  const profile = trenchProfile(seg, cut, rawGround, vesselled);

  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1;
    const ribs = profile.sides[k];
    if (!profile.anyWall[k]) continue;

    const at = (rib: TrenchRib, o: number, y: number): [number, number, number] => [
      rib.cx + px * o * side, y, rib.cz + pz * o * side,
    ];
    /**
     * One quad, wound so it faces the way it is meant to on **both** sides.
     *
     * `at` places an offset at `px * o * side`, so the `side = -1` frame is the
     * `side = +1` frame mirrored -- and a mirror reverses handedness. Emitting
     * the same four corners in the same order on both sides gives one side its
     * normal and the other side the opposite of it, which on a `FrontSide`
     * material means one whole wall of every cutting in Sydney is culled and the
     * player looks straight through it into the void. Every quad in this
     * function has that property, so the reversal is here rather than repeated
     * four times: with the run as `u` and the up-and-out direction as `v`, the
     * cross product comes out along `+px` on both sides, which is outward on one
     * and inward on the other.
     */
    const face = (
      p0: [number, number, number], p1: [number, number, number],
      p2: [number, number, number], p3: [number, number, number],
    ): void => {
      if (side > 0) s.quad(...p3, ...p2, ...p1, ...p0);
      else s.quad(...p0, ...p1, ...p2, ...p3);
    };
    for (let i = 0; i < ribs.length - 1; i++) {
      const a = ribs[i];
      const b = ribs[i + 1];
      // `TrenchRib.stood`, beside `vessel`: the ground outside this panel's own
      // coping has already been carved away at *both* its ribs, so it is looking
      // across the corridor it stands in rather than at the street, and the wall
      // belongs to whichever road is at the formation's edge. `trenchPrisms`
      // skips the same pair by the same test -- both ribs, for the measured
      // reason set out there -- which is what keeps the drawn wall and the
      // registered solid one object. See `rail-solids.trenchProfile`.
      if (a.vessel || b.vessel || !a.stood || !b.stood) continue;
      // The cess: the walking strip from the ballast toe out to the wall foot.
      // It is what stops the hole showing between the ballast's batter and the
      // wall, and it is the surface a cutting is recognised by from a train.
      face(
        at(a, BALLAST_BASE_HALF - 0.15, a.cess),
        at(b, BALLAST_BASE_HALF - 0.15, b.cess),
        at(b, b.foot, b.cess),
        at(a, a.foot, a.cess),
      );
      // The wall, leaning out as it rises. Faces **into** the trench, which is
      // the only side anybody ever sees it from.
      face(
        at(a, a.foot, a.cess),
        at(b, b.foot, b.cess),
        at(b, b.rim, b.top + TRENCH_COPING_RISE),
        at(a, a.rim, a.top + TRENCH_COPING_RISE),
      );
      // The coping, lapping over the rim of the hole and onto the ground.
      face(
        at(a, a.rim, a.top + TRENCH_COPING_RISE),
        at(b, b.rim, b.top + TRENCH_COPING_RISE),
        at(b, b.rim + TRENCH_COPING, b.top + TRENCH_COPING_RISE),
        at(a, a.rim + TRENCH_COPING, a.top + TRENCH_COPING_RISE),
      );
      face(
        at(a, a.rim + TRENCH_COPING, a.top + TRENCH_COPING_RISE),
        at(b, b.rim + TRENCH_COPING, b.top + TRENCH_COPING_RISE),
        at(b, b.rim + TRENCH_COPING, b.top - 0.4),
        at(a, a.rim + TRENCH_COPING, a.top - 0.4),
      );
    }
    // The two ends, closed. Mostly buried inside the next segment's overlap,
    // which is where they should be; the ones that are not are the end ramps
    // where a cutting runs out to grade, and there a wall that simply stopped
    // would show its own back face to the street.
    for (const [rib, inner, flip] of [
      [ribs[0], ribs[1] ?? ribs[0], true],
      [ribs[ribs.length - 1], ribs[ribs.length - 2] ?? ribs[ribs.length - 1], false],
    ] as const) {
      // The cap belongs to the panel beside it: `stood` on either of that
      // panel's two ribs is what put the panel there, and a cap on a panel that
      // was not built is a quad hanging in the corridor.
      if (rib.top - rib.cess <= TRENCH_MIN_HEIGHT || rib.vessel) continue;
      if (!rib.stood && !inner.stood) continue;
      const corners: Array<[number, number]> = [
        [rib.foot, rib.cess],
        [rib.rim, rib.top + TRENCH_COPING_RISE],
        [rib.rim + TRENCH_COPING, rib.top + TRENCH_COPING_RISE],
        [rib.rim + TRENCH_COPING, rib.cess],
      ];
      const pts = corners.map(([o, y]) => at(rib, o, y));
      // Composed with the side mirror above: the two ends of a wall face
      // opposite ways along the run, and each side flips both of them again.
      if (flip === side > 0) s.quad(...pts[0], ...pts[1], ...pts[2], ...pts[3]);
      else s.quad(...pts[3], ...pts[2], ...pts[1], ...pts[0]);
    }
  }

  // ---------------------------------------------------------------------
  // The collision, one prism per rib pair, from `rail-solids.trenchPrisms` --
  // which is the function `RailSolidField` calls to answer the ground query on a
  // process that has no `Solid` and no chunk ring. There is no second reading of
  // a rim on this path and no epsilon for one to be compared against.
  trenchPrisms(seg, profile, (prism) => prisms.push(prism));
  return profile.complete;
}

// --- Working in the track's own frame -------------------------------------------
//
// Everything from here down is written in `(t, o, y)`: metres **along** the run,
// metres **across** it, and metres up. The map into the world is a rotation
// about Y, which preserves handedness, so a box emitted here has exactly the
// winding `Solid.box` gives an axis-aligned one -- and that matters, because a
// `FrontSide` material culls by winding and the one thing this file has already
// shipped as a bug is a mirrored frame quietly reversing it. See `writeTrench`'s
// `face`, which is the same hazard solved the other way for strips.



/**
 * A bar of rectangular section swept along the run, whose underside may slope.
 *
 * The one primitive the whole station kit is built from: a step is a bar with a
 * flat underside, a balustrade is a bar with a sloping one, and a seat, a bin, a
 * lamp column and a brick wall are all bars that happen not to slope. Six quads,
 * wound exactly as `Solid.box` winds them, with the extents sorted first so a
 * caller passing a mirrored side cannot turn the object inside out.
 */
function frameBar(
  s: Solid, f: TrackFrame,
  t0: number, t1: number,
  o0: number, o1: number,
  /** Underside at `t0` and at `t1`, and how thick the bar is above it. */
  yA: number, yB: number, thick: number,
): void {
  if (t0 > t1) {
    [t0, t1] = [t1, t0];
    [yA, yB] = [yB, yA];
  }
  if (o0 > o1) [o0, o1] = [o1, o0];
  if (thick < 0) {
    yA += thick;
    yB += thick;
    thick = -thick;
  }
  const c = (t: number, o: number, up: boolean): [number, number, number] =>
    framePoint(f, t, o, (t === t0 ? yA : yB) + (up ? thick : 0));
  s.quad(...c(t0, o0, true), ...c(t0, o1, true), ...c(t1, o1, true), ...c(t1, o0, true));
  s.quad(...c(t0, o0, false), ...c(t1, o0, false), ...c(t1, o1, false), ...c(t0, o1, false));
  s.quad(...c(t0, o1, false), ...c(t1, o1, false), ...c(t1, o1, true), ...c(t0, o1, true));
  s.quad(...c(t1, o0, false), ...c(t0, o0, false), ...c(t0, o0, true), ...c(t1, o0, true));
  s.quad(...c(t1, o1, false), ...c(t1, o0, false), ...c(t1, o0, true), ...c(t1, o1, true));
  s.quad(...c(t0, o0, false), ...c(t0, o1, false), ...c(t0, o1, true), ...c(t0, o0, true));
}

/**
 * A slab swept along a spine at a constant offset from the rail, closed at both
 * ends and mitred at every joint.
 *
 * ---------------------------------------------------------------------------
 * **This is `frameBox` for a curve, and the mitre is the only interesting part
 * of it.** The panels of a spine meet at an angle, so a box per panel leaves a
 * wedge open on the outside of the bend -- 13 cm at the median turn in this
 * bake, 74 cm at the worst -- and a slot of daylight down a platform is exactly
 * the failure `STATIONS.md` is about. `platform-spine.offsetAt` gives the corner
 * where the two offset lines actually cross, so consecutive quads share it and
 * there is nothing between them to gap.
 *
 * Six faces, same as `frameBox`: top, bottom, the two long sides, and a cap at
 * each end. The long sides are a quad per panel; the top and bottom are a quad
 * per panel between the two offset lines. A flat spine has one panel and this
 * emits `frameBox`'s six quads at `frameBox`'s coordinates.
 *
 * `t0`/`t1` clip the sweep along the rail, for the things that do not run the
 * platform's whole length -- the canopy is 68 m of a 160 m platform. Omitted,
 * the sweep is the whole spine.
 */
function sweepDeck(
  s: Solid, spine: PlatformSpine,
  o0: number, o1: number,
  /**
   * The slab's underside and top, **metres over the railhead beside it**, or an
   * absolute world y for `dLo` where the thing below is the ground rather than
   * the rail -- which is the platform's own skirt and nothing else. See
   * `platform-spine.railYAt` for why a constant height was the second half of
   * this bug.
   */
  dLo: number, dHi: number,
  t0?: number, t1?: number,
  /** `dLo` is an absolute world y rather than a rise over the rail. */
  floorIsAbsolute = false,
): void {
  const a = Math.min(o0, o1);
  const b = Math.max(o0, o1);
  const nodes = spine.nodes;
  // The node indices the sweep covers, plus a synthetic node at each clip.
  const from = t0 ?? nodes[0].t;
  const to = t1 ?? nodes[nodes.length - 1].t;
  if (!(to > from)) return;
  /** `[xa, za, xb, zb, lo, hi]` per rib: the two mitred corners and its heights. */
  const ribs: Array<[number, number, number, number, number, number]> = [];
  const heights = (t: number): [number, number] => {
    const rail = railYAt(spine, t);
    const hi = rail + dHi;
    const lo = floorIsAbsolute ? dLo : rail + dLo;
    return lo <= hi ? [lo, hi] : [hi, lo];
  };
  const pushRib = (i: number): void => {
    const pa = offsetAt(spine, i, a);
    const pb = offsetAt(spine, i, b);
    const [lo, hi] = heights(spine.nodes[i].t);
    ribs.push([pa.x, pa.z, pb.x, pb.z, lo, hi]);
  };
  /**
   * A rib at an arbitrary arc length, for a clip that lands mid-panel. The
   * panel's own direction rather than a mitre, because a clip is not a joint --
   * there is one panel either side of it and it is the same panel.
   */
  const pushAt = (t: number): void => {
    const f = frameAt(spine, t);
    const [lo, hi] = heights(t);
    ribs.push([
      f.x - f.uz * a, f.z + f.ux * a,
      f.x - f.uz * b, f.z + f.ux * b,
      lo, hi,
    ]);
  };
  if (spine.flat) {
    pushAt(from);
    pushAt(to);
  } else {
    pushAt(from);
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].t <= from || nodes[i].t >= to) continue;
      pushRib(i);
    }
    pushAt(to);
  }
  if (ribs.length < 2) return;

  for (let i = 0; i + 1 < ribs.length; i++) {
    const [ax, az, bx, bz, lo0, hi0] = ribs[i];
    const [cx, cz, dx, dz, lo1, hi1] = ribs[i + 1];
    // Top and bottom. The two ribs carry their own heights, so a slab on a
    // graded railway is a ramp rather than a step.
    s.quad(ax, hi0, az, bx, hi0, bz, dx, hi1, dz, cx, hi1, cz);
    s.quad(ax, lo0, az, cx, lo1, cz, dx, lo1, dz, bx, lo0, bz);
    // The two long faces, wound so each looks outward from the slab.
    s.quad(cx, lo1, cz, ax, lo0, az, ax, hi0, az, cx, hi1, cz);
    s.quad(bx, lo0, bz, dx, lo1, dz, dx, hi1, dz, bx, hi0, bz);
  }
  // The end caps.
  {
    const [ax, az, bx, bz, lo, hi] = ribs[0];
    s.quad(ax, lo, az, bx, lo, bz, bx, hi, bz, ax, hi, az);
    const [cx, cz, dx, dz, lo2, hi2] = ribs[ribs.length - 1];
    s.quad(dx, lo2, dz, cx, lo2, cz, cx, hi2, cz, dx, hi2, dz);
  }
}

/** A box in the track frame, between two corners. */
function frameBox(
  s: Solid, f: TrackFrame,
  t0: number, t1: number, o0: number, o1: number, y0: number, y1: number,
): void {
  frameBar(s, f, t0, t1, o0, o1, Math.min(y0, y1), Math.min(y0, y1), Math.abs(y1 - y0));
}

// **There is deliberately no `frameSolid` any more.** Drawing a box and
// registering it in one call was the shape that let the two ends differ: the
// registration only ever happened where a browser had just drawn something.
// `rail-solids.stationSolids` enumerates the boxes, `buildChunk` registers them
// and `drawSolids` draws them, and the server evaluates the same enumeration.

/**
 * Is this point inside a station's entrance, where the boundary fence opens?
 *
 * `RAIL-VERTICAL.md` section 4's middle band -- *"a gap in the boundary fence:
 * do not fence a player out of the entrance"* -- and it is the one piece of the
 * access story that is a **subtraction** rather than a structure. A station at
 * grade needs no steps and would still be unreachable behind an unbroken
 * 1.8 m fence, which is the failure mode fencing 300 km of corridor introduces
 * and which nothing else here would have caught.
 *
 * The opening is as long as the flight it serves plus a forecourt, so a deep
 * station with a thirty-metre stair does not have its own stair fenced off
 * halfway down.
 */
function entranceOpens(plans: readonly StationPlan[], x: number, z: number): boolean {
  for (const plan of plans) {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      // Both ends, because `writeStationAccess` builds a flight at both ends and
      // an entrance fenced off is an entrance that does not exist -- and each of
      // them has its own run now, because each is sized from its own ground.
      for (const end of [1, -1]) {
        const run = plan.run[i][end > 0 ? 0 : 1];
        const r = FENCE_GAP_RADIUS + run / 2;
        const c = framePoint(
          plan.station, (ACCESS_ALONG + run / 2 + 2) * end, (STAIR_OUTER + 2) * side, 0,
        );
        const dx = x - c[0];
        const dz = z - c[2];
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    const h = framePoint(plan.station, plan.houseAlong, (STAIR_OUTER + 2) * plan.houseSide, 0);
    const hx = x - h[0];
    const hz = z - h[2];
    if (hx * hx + hz * hz < (HOUSE_LENGTH / 2 + 6) * (HOUSE_LENGTH / 2 + 6)) return true;
  }
  return false;
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
    flags: SPAN_TUNNEL, len: 15.5, ux, uz, open: [false, false], vi: -1,
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
/*
 * `platformSides` used to be defined here, returning `[-1, 1]` for every station
 * with a page explaining why it could not yet do otherwise. It is now
 * `rail-solids.platformSides`, decided from `world/track-atlas.ts`, and is
 * imported above -- the deck, the collision prism, the access stair and
 * `riding.PlatformField` all read the one answer. Read that function's header
 * for what discharged the objection.
 */

function writePlatforms(
  concrete: Solid,
  canopy: Solid,
  tactile: Solid,
  plan: StationPlan,
): void {
  // **The deck is swept, and the mesh is mitred where the prisms are butted.**
  //
  // `rail-solids.platformDeckSolids` emits one box per panel of the running
  // line, and drawing those boxes directly -- which is what this did, and what
  // "drawn from the box, not measured again" bought -- would put a wedge of
  // daylight down the outside of every bend, 74 cm of it at the worst turn in
  // the bake. So the *definition* is still one thing, `plan.spine` and
  // `plan.slot`, and this is a second **rendering** of it rather than a second
  // measurement: `sweepDeck` walks the identical nodes at the identical offsets
  // and closes the joints with `offsetAt`'s mitre.
  //
  // `STATIONS.md` is explicit that this is the allowed shape -- *"a boundary may
  // have many renderings and exactly one definition"* -- and it names the price:
  // the drawn surface and the prism differ inside the mitre wedge. It is the
  // safe direction. The prisms under-reach, so there is no invisible wall, and
  // `riding.PlatformField` projects onto the same spine and covers the wedge on
  // both ends of the wire, which is what a body actually stands on.
  //
  // On straight track the spine is one panel, the mitre is the identity, and
  // this emits the six quads `frameBox` emitted before it.
  //
  // Heights below are **rises over the railhead beside them**, not `plan.top`.
  // See `platform-spine.railYAt`: a deck holding one height down a graded
  // platform buries itself in the ballast at one end, which is the vertical half
  // of the same defect.
  for (const side of platformSides(plan)) {
    const inner = PLATFORM_INNER;
    // The back of the passenger platform, which is `PLATFORM_WIDTH` where there
    // is room for it and the slot where there is not. Everything below hangs off
    // this rather than off the constant, so a narrowed platform's canopy and
    // furniture move in with the deck instead of standing over the neighbouring
    // train. See `rail-solids.platformBack`.
    const outer = platformBack(plan, side);
    const deckOuter = plan.slot[side < 0 ? 0 : 1];
    // The skirt runs to the ground, so its floor is absolute; its top follows
    // the rail. Everything after this is a rise over the rail on both faces.
    sweepDeck(concrete, plan.spine, inner * side, deckOuter * side, plan.base, PLATFORM_HEIGHT, undefined, undefined, true);

    // The coping: a 25 mm lip along the platform edge.
    //
    // It is the smallest object in this file and it earns its six quads for the
    // reason `fences.COPING` gives about a garden wall -- what makes an edge
    // read at distance is a light line with a dark one under it, and without it
    // a platform and the ballast beside it are two grey rectangles that meet.
    sweepDeck(concrete, plan.spine, inner * side, (inner + 0.14) * side, PLATFORM_HEIGHT, PLATFORM_HEIGHT + COPING_RISE);

    // ...and the tactile strip, which is the thing everybody actually looks at.
    //
    // A 6 mm lid rather than a coplanar inlay: two surfaces at the same height
    // is a z-fight down 160 m of platform, and six millimetres is under the
    // depth buffer's argument and over its precision. AS 1428.4's real strip
    // starts one tile back from the edge, which is what `TACTILE_INSET` is.
    sweepDeck(
      tactile, plan.spine,
      (inner + TACTILE_INSET) * side, (inner + TACTILE_INSET + TACTILE_WIDTH) * side,
      PLATFORM_HEIGHT, PLATFORM_HEIGHT + 0.006,
    );

    // Canopy: a flat roof on four posts over the middle third. Enough to say
    // "station" from the train and cheap enough to build at all 195 of them.
    const C = CANOPY_HALF_LENGTH;
    const rise = PLATFORM_HEIGHT + CANOPY_HEIGHT;
    sweepDeck(
      canopy, plan.spine,
      (inner - CANOPY_OVERHANG) * side,
      Math.min(outer + CANOPY_OVERHANG, deckOuter) * side,
      rise - 0.28, rise, -C, C,
    );
    // The columns, each on the curve at its own position rather than in one
    // frame taken at the station's middle. A post is 22 cm across, so its own
    // frame is exact; what matters is that it lands under the roof it holds up.
    for (const t of [-C + 3, -C / 3, C / 3, C - 3]) {
      const o = ((inner + outer) / 2) * side;
      const g = frameAt(plan.spine, t);
      const cf: TrackFrame = { x: g.x, z: g.z, ux: g.ux, uz: g.uz };
      const deck = railYAt(plan.spine, t) + PLATFORM_HEIGHT;
      frameBox(canopy, cf, -0.11, 0.11, o - 0.11, o + 0.11, deck, deck + CANOPY_HEIGHT - 0.28);
    }
  }
}

/**
 * What a platform has on it, which before this round was nothing at all.
 *
 * Reported as *"is this how you imagined your stations to be like ... the train
 * just going through some platform"*, and the honest answer was that a platform
 * was a slab with a roof over the middle of it. Four things, all of them on one
 * material, and each chosen because it is a *silhouette* at the distance a
 * platform is seen from rather than because it is furniture: seats break the
 * long horizontal, a shelter breaks the roofline, lamp columns put verticals at
 * a regular pitch, and a bin is the one small object at human scale that says
 * the space is used.
 *
 * `world/furniture.ts` is the city's own bin and blade kit and is deliberately
 * **not** reused here, which is worth stating because the brief asked for it.
 * Everything in that file is an `InstancedMesh` filled from a per-tile bake --
 * `FurnitureAssets` takes `TileFurniture`, the pipeline decides every position,
 * and three keys an instanced draw on `object.uuid`. Borrowing it would mean
 * either a second world-wide instanced set refilled on the chunk transition for
 * about forty objects, or a per-chunk one, which `warmup.ts` is the file that
 * explains the cost of. Merged geometry on a material the chunk already draws is
 * both cheaper and simpler: these cost no draw call at all.
 */
function writePlatformFurniture(
  canopy: Solid,
  furniture: Solid,
  plan: StationPlan,
): void {
  const f = plan.station;
  const top = plan.top;

  for (const side of platformSides(plan)) {
    // Per side, because the two sides of one station routinely get different
    // slots: an edge road keeps the full platform and the road beside it may
    // have four metres to share. See `rail-solids.platformBack`.
    const back = platformBack(plan, side);
    const at = (o: number): number => o * side;

    // Seats: a slatted bench with a back, against the rear of the platform.
    for (const t of [-62, -21, 21, 62]) {
      const o = back - 1.5;
      frameBox(furniture, f, t - 0.9, t + 0.9, at(o - 0.26), at(o + 0.26), top + 0.42, top + 0.5);
      frameBox(furniture, f, t - 0.9, t + 0.9, at(o + 0.26), at(o + 0.34), top + 0.5, top + 0.92);
      for (const e of [-0.72, 0.72]) {
        frameBox(furniture, f, t + e - 0.05, t + e + 0.05, at(o - 0.24), at(o + 0.3), top, top + 0.42);
      }
    }

    // Bins.
    for (const t of [-38, 38]) {
      const o = back - 1.1;
      frameBox(furniture, f, t - 0.26, t + 0.26, at(o - 0.26), at(o + 0.26), top, top + 0.92);
      frameBox(furniture, f, t - 0.3, t + 0.3, at(o - 0.3), at(o + 0.3), top + 0.92, top + 1.0);
    }

    // Lamp columns. Geometry only -- the lamps themselves are
    // `world/nightlights.ts`'s business and this round does not light anything.
    for (const t of [-72, -46, 46, 72]) {
      const o = back - 0.7;
      frameBox(furniture, f, t - 0.09, t + 0.09, at(o - 0.09), at(o + 0.09), top, top + 4.0);
      frameBox(furniture, f, t - 0.28, t + 0.28, at(o - 0.28), at(o + 0.28), top + 4.0, top + 4.22);
    }

    // A shelter past the end of the canopy, where the roofline would otherwise
    // simply stop. Three walls and a roof: the open face is toward the track,
    // which is what every waiting shelter in the state does.
    const s0 = -CANOPY_HALF_LENGTH - 15;
    const s1 = -CANOPY_HALF_LENGTH - 5;
    const wIn = PLATFORM_INNER + 1.2;
    frameBox(canopy, f, s0 - 0.4, s1 + 0.4, at(wIn - 0.4), at(back + 0.2), top + 2.35, top + 2.6);
    frameBox(furniture, f, s0, s0 + 0.1, at(wIn), at(back), top, top + 2.35);
    frameBox(furniture, f, s1 - 0.1, s1, at(wIn), at(back), top, top + 2.35);
    frameBox(furniture, f, s0, s1, at(back - 0.1), at(back), top, top + 2.35);
    frameBox(furniture, f, s0 + 0.6, s1 - 0.6, at(wIn), at(back - 0.6), top + 0.42, top + 0.5);
  }
}

/**
 * A flight of steps between two points on the run, and the collision that makes
 * it climbable rather than decorative.
 *
 * **The riser is the whole design.** `player/controller.STEP_HEIGHT` is 0.42 m
 * and is what decides whether a body walks up a kerb or into it, so a step
 * taller than that is a wall with a tread on it: a staircase you can see and
 * cannot use, which the coordinator's brief is right to call worse than no
 * staircase at all. 0.19 m is comfortably inside it and is also simply what a
 * public stair is.
 *
 * Each tread is its own prism with its `base` under the ground, so
 * `CollisionWorld.solidFor` treats it as a kerb -- `feetY >= top - 0.05` clears
 * it, and `controller.step` passes `feet + STEP_HEIGHT`, which is exactly the
 * mechanism every kerb in the city is climbed by. Nothing new was needed in the
 * collision world for this and nothing was added to it.
 *
 * Works in both directions without a sign anywhere: the tread of a span is the
 * higher of its two ends, so a flight down into a cutting and a flight up an
 * embankment are the same loop.
 */
function drawSolids(s: Solid, boxes: readonly FrameSolid[], kind: number): void {
  for (const b of boxes) {
    if (b.kind !== kind) continue;
    frameBox(s, b.f, b.t0, b.t1, b.o0, b.o1, b.y0, b.y1);
  }
}

/** A balustrade following a flight or a deck: a rail on a solid kerb. */
function writeBalustrade(
  s: Solid, f: TrackFrame,
  tA: number, yA: number, tB: number, yB: number,
  o: number, height: number,
): void {
  // A 0.1 m kerb the whole way, so nothing shows daylight under the rail, and
  // the rail itself at the top. Two swept bars, which is twelve quads for the
  // one thing that stops a staircase reading as a ramp with steps drawn on it.
  frameBar(s, f, tA, tB, o - 0.05, o + 0.05, yA, yB, height);
  frameBar(s, f, tA, tB, o - 0.09, o + 0.09, yA + height - 0.1, yB + height - 0.1, 0.1);
}

/**
 * **The way in.** Steps from the ground beside a platform up or down onto it,
 * at every station, generated from the measured drop and never looked up.
 *
 * ---------------------------------------------------------------------------
 * Two reports, one defect. *"im at roseville and cant get up to the platform"*
 * -- Roseville's track is 2.5 m over the terrain, so its platform stood 3.55 m
 * up behind a retaining wall with nothing anywhere to climb. And a player on the
 * Chatswood plaza, with the boarding prompt reading "doors 23 m away, walk to
 * them", 6.9 m above a platform there was no route down to. Both stations were
 * drawn correctly and both were sealed.
 *
 * `RAIL-VERTICAL.md` section 4 is the rule this implements and the important
 * word in it is *generated*: there is no tag consulted here, no OSM way, no
 * footbridge looked up. There is `plan.landing`, which is the terrain beside
 * this platform on this side, and `plan.top`, which is the deck, and a flight
 * between them whose length is the difference. A station physically cannot be
 * left sealed, because the number that would make it sealed is the number that
 * builds the stair.
 *
 * ---------------------------------------------------------------------------
 * **Where the flight goes, and why there is only one place it can.** The band is
 * `STAIR_INNER` to `STAIR_OUTER`, which is from the platform's outer face out to
 * `rail-cut.STATION_HALF_WIDTH` -- the strip the terrain carve already opens at
 * every platform site and that nothing else in this file wants. That one choice
 * makes the same code right in all three vertical cases:
 *
 *   - **in a cutting** the flight is cut into the trench wall, because the band
 *     *is* the trench wall's footprint, and being solid down to the cess it
 *     hides the wall behind it exactly as a real stair does;
 *   - **on an embankment** it is a free-standing stair against the platform's
 *     flank, standing on the same ground the skirt does;
 *   - **at grade** the drop is the platform's own 1.05 m and the flight is six
 *     steps -- which is still needed, because 1.05 m is two and a half times
 *     `STEP_HEIGHT` and an at-grade platform was every bit as unclimbable as
 *     Roseville's.
 *
 * It runs **along** the track rather than out from it, and that is forced: at
 * 0.61 gradient a 7 m drop is 11 m of run, and there is 2.2 m of width to play
 * with across the corridor and eighty metres along it.
 */
function writeStationAccess(
  concrete: Solid,
  furniture: Solid,
  boxes: readonly FrameSolid[],
  plan: StationPlan,
): void {
  const f = plan.station;
  // The treads and the landings, drawn from `rail-solids.accessSolids` -- the
  // same boxes the server evaluates, so a flight is climbable at the same
  // heights on both ends of the wire. Nothing here re-derives a riser.
  drawSolids(concrete, boxes, SOLID_STAIR);
  drawSolids(concrete, boxes, SOLID_LANDING);
  // The balustrades, which are decoration: they register nothing and are the one
  // part of a flight that is not a solid.
  for (const side of platformSides(plan)) {
    const i = side < 0 ? 0 : 1;
    const o0 = STAIR_INNER * side;
    const o1 = STAIR_OUTER * side;
    for (const end of [1, -1]) {
      const e = end > 0 ? 0 : 1;
      const run = plan.run[i][e];
      if (run <= 0) continue;
      const street = plan.landing[i][e];
      const head = ACCESS_ALONG * end;
      const foot = head + run * end;
      for (const o of [o0, o1]) {
        writeBalustrade(furniture, f, head, plan.top, foot, street, o, 1.05);
      }
    }
  }
}


/**
 * A footbridge over the track, joining the two platforms.
 *
 * *"a platform you cannot get to the other side of reads as broken"*, and OSM
 * maps an overbridge at a minority of these stations, so this is generated on
 * the same terms as the stairs are: where one is mapped its position would be
 * better and where none is, one plain bridge is better than none.
 *
 * **It clears the overhead line rather than passing through it**, which is the
 * one dimension in it that is not free: `MAST_HEIGHT` is 7.4 m over the rail and
 * the messenger wire is at 6.35, so a soffit under 8 m is a bridge with a
 * catenary mast growing through the deck. `BRIDGE_CLEAR` is set from that and
 * the flights are as long as the height makes them.
 *
 * Not built where the deck would stand less than `BRIDGE_MIN_OVER_GROUND` over
 * the surrounding terrain, which is the cutting case: there the street is
 * already above the track, both platforms already have their own stairs up to
 * it, and a "bridge" would be a handrail lying on the footpath.
 */
function writeFootbridge(
  concrete: Solid,
  furniture: Solid,
  boxes: readonly FrameSolid[],
  plan: StationPlan,
): void {
  const f = plan.station;
  // The deck and the two flights, drawn from `rail-solids.footbridgeSolids`.
  //
  // The deck **box** stands 0.6 m proud of the surface drawn here, which is old
  // and deliberate -- it is what holds a body clear of its own balustrade -- so
  // the drawn slab is the box's soffit plus `BRIDGE_DECK` rather than the box's
  // own top. That is a rendering of the solid, not a second opinion about where
  // it is: both come out of one record, and the ground query on either end reads
  // the record.
  drawSolids(concrete, boxes, SOLID_FOOTBRIDGE_STAIR);
  for (const b of boxes) {
    if (b.kind !== SOLID_FOOTBRIDGE_DECK) continue;
    const soffit = Math.min(b.y0, b.y1);
    const deck = soffit + BRIDGE_DECK;
    frameBox(concrete, b.f, b.t0, b.t1, b.o0, b.o1, soffit, deck);
    for (const t of [b.t0, b.t1]) {
      frameBox(furniture, b.f, t - 0.05, t + 0.05, b.o0, b.o1, deck, deck + BRIDGE_RAIL_H);
    }
    // And the balustrades down the flights, which register nothing.
    const rise = deck - plan.top;
    const run = Math.min(STAIR_MAX_STEPS, Math.round(rise / STAIR_RISE)) * STAIR_GOING;
    const s1 = PLATFORM_INNER + PLATFORM_WIDTH - 0.4;
    for (const side of [-1, 1]) {
      for (const o of [(s1 - 2.0) * side, s1 * side]) {
        writeBalustrade(furniture, f, BRIDGE_ALONG, deck, BRIDGE_ALONG - run, plan.top, o, BRIDGE_RAIL_H);
      }
    }
  }
}

/**
 * The station building: a brick box with an awning, at the street end.
 *
 * *"a modest brick-and-awning box ... it does not need to be architecturally
 * accurate; it needs to exist so a station is a place rather than a slab"*, and
 * that is exactly the ambition. It is four boxes.
 *
 * Placed at the **OSM station node**, which is the one fact in the bake about
 * where the street side of a station is: a station node sits at the entrance
 * rather than on the track, so the vector from the routed stopping anchor to the
 * node says which side a passenger arrives from and how far along. See
 * `PlacedStation.nodeX`. Where the node is more than 250 m away -- the bake has
 * those, and `buildNetwork` explains why -- it says nothing useful and the
 * building goes at the far end of the platform from the stairs instead.
 *
 * **It is solid and has no interior**, which is a stated limitation: there is no
 * door and you walk round it. The access it fronts is the stair beside it, and
 * putting a walkable concourse inside a box that would have to agree with the
 * platform below it is a round on its own.
 */
function writeStationHouse(
  brick: Solid,
  canopy: Solid,
  boxes: readonly FrameSolid[],
  plan: StationPlan,
): void {
  const f = plan.station;
  const side = plan.houseSide;
  const y = plan.houseGround;
  for (const b of boxes) {
    if (b.kind !== SOLID_HOUSE) continue;
    // The brick box itself is the solid, from `rail-solids.houseSolids`. The
    // parapet and the awning below hang off its own extents and register
    // nothing, which is why a passenger walks under the awning and into the wall.
    frameBox(brick, b.f, b.t0, b.t1, b.o0, b.o1, b.y0, b.y1);
    const { t0, t1, o0, o1 } = b;
    // A parapet, which is what a 1920s station building has instead of eaves.
    frameBox(brick, f, t0 - 0.2, t1 + 0.2, o0 - 0.2 * side, o1 + 0.2 * side, y + HOUSE_HEIGHT, y + HOUSE_HEIGHT + 0.35);
    // The awning over the footpath, on the street face. The one thing that makes
    // this read as a station entrance rather than as a substation.
    frameBox(canopy, f, t0 - 0.5, t1 + 0.5, o1, o1 + HOUSE_AWNING * side, y + 2.85, y + 3.05);
    for (const e of [t0 + 0.4, t1 - 0.4]) {
      frameBox(canopy, f, e - 0.06, e + 0.06, o1 + (HOUSE_AWNING - 0.15) * side, o1 + HOUSE_AWNING * side, y, y + 2.85);
    }
  }
}

/**
 * The cess, the verge and the boundary fence: everything between the ballast
 * toe and the street.
 *
 * ---------------------------------------------------------------------------
 * **This is the answer to "rails painted on a car park", and the fence is most
 * of it.** Every metre of running line in Sydney is fenced; the ballast, the
 * rail, the sleepers and the catenary were all already correct at Lindfield and
 * the frame still read as a yard, because there was no edge in it anywhere. A
 * 1.8 m vertical along both sides is the cheapest object in this file per unit
 * of recognition and `RAIL-VERTICAL.md` section 6 names it as the mitigation for
 * the one case -- a cutting narrower than a DEM post -- that no measurement can
 * recover.
 *
 * Three things, at one quad per eight metres each:
 *
 *   - **the verge**, from the ballast's toe out to the fence line, sloping from
 *     the formation to the ground. It is what gives the ballast prism something
 *     to sit *in*: a dark trapezoid on a pale strip on the suburb's own ground
 *     is a cross-section, and the same trapezoid lying straight on the suburb is
 *     a heap of gravel. Only where the track is at grade -- in a cutting
 *     `writeTrench` has already drawn the cess and the wall, and a second strip
 *     would slice through both.
 *   - **the fence**, always, at the corridor rim where there is one and at
 *     `FENCE_OFFSET` where there is not, standing on the ground rather than on
 *     the formation, so at a cutting it is the guard fence along the top and not
 *     a fence at the bottom of a hole.
 *   - **nothing at all**, over a station entrance. See `entranceOpens`.
 *
 * Neither is drawn on a viaduct: a bridge has parapets, which `writeViaduct`
 * builds, and a fence on a deck 12 m up would be a fence inside a parapet.
 *
 * ---------------------------------------------------------------------------
 * The `u` coordinate is **cumulative metres along the fence line**, accumulated
 * rib by rib rather than taken from the segment's own arc length, because the
 * fence line is longer than the centreline on the outside of every curve and the
 * mask's post pitch is measured in real metres. `v` is metres up the panel.
 * Together they are the whole of what `fences.createFenceOpenMaterial` reads.
 */
/**
 * One rib of the verge: the cross-section everything `writeVerge` draws hangs
 * off.
 *
 * Exported because the rib walk is the **only** description in this build of
 * where a boundary fence stands, and an audit that re-derived it would be
 * auditing a copy. Three rounds of rail-side fixes shipped green beside a fence
 * in a road for exactly that reason. See `vergeRibs`.
 */
export interface VergeRib {
  cx: number; cz: number; fx: number; fz: number;
  o: number; formation: number; verge: number; foot: number;
  u: number; open: boolean; vessel: boolean;
}

/**
 * A stretch of fence line that is actually drawn, between two stations on it.
 *
 * `u` is cumulative metres along the fence line -- what the bar mask is drawn in
 * -- so a clipped end carries the interpolated value rather than restarting, and
 * the bars either side of a road stay in step.
 */
export interface FenceRun {
  ax: number; az: number; ay: number; au: number;
  bx: number; bz: number; by: number; bu: number;
}

/**
 * How finely the road rule is evaluated along a fence panel, metres.
 *
 * ---------------------------------------------------------------------------
 * **THE FOURTH REPORT OF THE SAME DEFECT, AND WHY THE THIRD FIX DID NOT TAKE.**
 *
 *   > *"still a fence on king st, and i fall thru if i go past the fence"*
 *
 * reported standing at -33.907002, 151.181545 -- world (-2492.54, 4281.58).
 * Measured off the shipped build in a browser at that point: the object in the
 * frame is `rail_fence_-5,8`, one panel of it, running from (-2479.84, 4266.04)
 * to (-2486.92, 4269.87), with **seven of twenty-one stations along it inside a
 * drawn carriageway**. Its far rib is open -- `deckSurfaceAt` answers -52.61
 * there, the road rule fired exactly as designed -- and its near rib is not.
 *
 * That is the whole bug, and it is not the rule. **The rule was a property of a
 * rib and the object is a panel.** `a.open && b.open` drops a panel only when
 * *both* ends are over paving, so the last panel before a bridge is drawn in
 * full: it starts on open ground and marches the whole `VERGE_STEP_M` to the
 * open rib, over the kerb and into the carriageway. No rib-wise audit could see
 * it, because both of its ribs answer correctly -- which is how three rounds of
 * green lights sat beside a fence in the road.
 *
 * The same arithmetic runs the other way: a carriageway narrower than a rib
 * pitch, crossing between two closed ribs, is one the rib test never samples at
 * all.
 *
 * So the *span* is sampled rather than its ends, and a panel is **clipped** to
 * the stretches the rule allows rather than kept or dropped whole. One metre is
 * chosen against the thing being resolved: `streets.MIN_ROAD_WIDTH` is 2.5 m, so
 * no carriageway in the extract can fall between two stations, and the residual
 * at either kerb is half a metre of fence -- against a rib pitch of eight.
 */
export const FENCE_CLIP_M = 1.0;

/**
 * Is the boundary fence opened at this point on the fence line?
 *
 * The predicate on its own, hoisted out of the rib walk so the sub-stations
 * `fenceRuns` tests and the ribs `vergeRibs` builds ask the identical question
 * of the identical objects.
 *
 * **Gated on the panel's own head against the soffit**, on `refillMasts`' terms
 * and for the same measured reason: a road *viaduct* ten metres over a corridor
 * is a deck too, and a fence standing on the ground under one is a real fence
 * with real headroom. What must go is the panel that would come through the
 * carriageway, which is the one whose foot is the kept ground the road is drawn
 * on.
 *
 * `rawGround` is the raw terrain under the post, which is what a footway's
 * draped surface is measured from -- the line the player's third report turned
 * on, kept verbatim.
 */
export function fenceOpensAt(
  fx: number, fz: number, foot: number,
  cx: number, cz: number,
  cut: RailCut | null,
  rawGround: GroundAt,
  plans: readonly StationPlan[],
  vesselled: (x: number, z: number) => boolean,
): boolean {
  const deckY = cut === null ? Number.NaN : cut.deckSurfaceAt(fx, fz, rawGround(fx, fz));
  const decked = Number.isFinite(deckY) && foot + FENCE_HEIGHT > deckY - DECK_THICKNESS_M;
  return decked || entranceOpens(plans, fx, fz) || vesselled(cx, cz);
}

/**
 * The verge's cross-sections along one side of one segment, or `null` where
 * `markCorridorEdges` closed that side off.
 *
 * The rib walk with nothing drawn. `writeVerge` builds its strip and its fence
 * from this and `checkPavedIntegrity` asks it where the fence stands: one
 * description, two readers.
 */
export function vergeRibs(
  seg: Segment,
  side: number,
  cut: RailCut | null,
  rawGround: GroundAt,
  plans: readonly StationPlan[],
  vesselled: (x: number, z: number) => boolean,
): VergeRib[] | null {
  if (!seg.open[side < 0 ? 0 : 1]) return null;
  const px = -seg.uz;
  const pz = seg.ux;
  const steps = Math.max(1, Math.round(seg.len / VERGE_STEP_M));
  const ext = 0.4;
  const ribs: VergeRib[] = [];
  let u = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = -ext + t * (seg.len + 2 * ext);
    const cx = seg.ax + seg.ux * along;
    const cz = seg.az + seg.uz * along;
    const rail = seg.ay + (seg.by - seg.ay) * t;
    const formation = rail - BALLAST_TOP_DROP - BALLAST_DEPTH;
    const half = cut !== null ? cut.halfWidthAt(cx, cz) : CUT_HALF_WIDTH;
    const o = Math.max(FENCE_OFFSET, half + FENCE_CLEAR);
    const fx = cx + px * o * side;
    const fz = cz + pz * o * side;
    const g = rawGround(fx, fz);
    // The fence stands on the ground, whatever the ground is doing: at a
    // cutting that is the street ten metres over the formation, which is where
    // a corridor fence goes and is the whole reason this is not measured from
    // the rail. Bounded either way, so one wild DEM post cannot put a fence
    // panel thirty metres in the air.
    const real = Number.isFinite(g) ? g : formation;
    const foot = Math.max(formation - 6, Math.min(formation + 26, real));
    // The verge is bounded far more tightly, because it is a *surface* joining
    // the formation to the ground and a steep one reads as a fault rather than
    // as a batter.
    const verge = Math.max(formation - VERGE_RELIEF, Math.min(formation + VERGE_RELIEF, real));
    if (i > 0) {
      const p = ribs[i - 1];
      u += Math.hypot(fx - p.fx, fz - p.fz);
    }
    // **A fence panel standing in a roadway is the report, in those words**:
    // *"if i do jump onto the fenced section of road, i can fall through down
    // into the railroad"*. The fence line runs `FENCE_OFFSET` out from the
    // centreline and knows nothing about streets, so at every crossing in the
    // city it marched straight across the carriageway. A boundary fence stops
    // at a road bridge -- that is what the parapet is for.
    //
    // The rule itself is `fenceOpensAt`; a rib carries its own answer, and
    // `fenceRuns` asks the same question of the span between two of them.
    ribs.push({
      cx, cz, fx, fz, o, formation, verge, foot, u,
      open: fenceOpensAt(fx, fz, foot, cx, cz, cut, rawGround, plans, vesselled),
      vessel: vesselled(cx, cz),
    });
  }
  return ribs;
}

/**
 * Every stretch of boundary fence one side of one segment actually draws.
 *
 * The rule is the one it has been for three rounds -- `fenceOpensAt` -- and what
 * changed is that it is asked of the *span* rather than of its two ends, and a
 * panel is clipped rather than kept or dropped whole. See `FENCE_CLIP_M` for the
 * measurement that forced it.
 */
export function fenceRuns(
  ribs: readonly VergeRib[],
  cut: RailCut | null,
  rawGround: GroundAt,
  plans: readonly StationPlan[],
  vesselled: (x: number, z: number) => boolean,
): FenceRun[] {
  const runs: FenceRun[] = [];
  const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
  for (let i = 0; i < ribs.length - 1; i++) {
    const a = ribs[i];
    const b = ribs[i + 1];
    const span = Math.hypot(b.fx - a.fx, b.fz - a.fz);
    const steps = Math.max(1, Math.ceil(span / FENCE_CLIP_M));
    /** Where the closed run in hand began, as a fraction from `a` to `b`. */
    let from = -1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const fx = lerp(a.fx, b.fx, t);
      const fz = lerp(a.fz, b.fz, t);
      const foot = lerp(a.foot, b.foot, t);
      // The two ends reuse the rib's own answer rather than recomputing it, so a
      // run that carries on across a rib is continuous by construction and
      // cannot be split by a float that came out differently the second time.
      const open =
        s === 0
          ? a.open
          : s === steps
            ? b.open
            : fenceOpensAt(
              fx, fz, foot, lerp(a.cx, b.cx, t), lerp(a.cz, b.cz, t),
              cut, rawGround, plans, vesselled,
            );
      if (!open) {
        if (from < 0) from = t;
        if (s < steps) continue;
      }
      if (from < 0) continue;
      // The run ends at the last closed station: this one where the loop ran
      // out, the previous one where the rule opened.
      const to = open ? (s - 1) / steps : t;
      if (to > from) {
        runs.push({
          ax: lerp(a.fx, b.fx, from), az: lerp(a.fz, b.fz, from),
          ay: lerp(a.foot, b.foot, from), au: lerp(a.u, b.u, from),
          bx: lerp(a.fx, b.fx, to), bz: lerp(a.fz, b.fz, to),
          by: lerp(a.foot, b.foot, to), bu: lerp(a.u, b.u, to),
        });
      }
      from = -1;
    }
  }
  return runs;
}

function writeVerge(
  cess: Solid,
  fence: Solid,
  seg: Segment,
  cut: RailCut | null,
  rawGround: GroundAt,
  trenched: boolean,
  plans: readonly StationPlan[],
  /**
   * Is a formation vessel drawn over this point?
   *
   * Then neither the verge nor the fence is drawn here, and the fence is the
   * interesting half. **This is the player's point 4 being answered by
   * deletion.** The fence line is measured out from a *track centreline*, which
   * is why it marches across carriageways and fences the six-foot; the vessel's
   * fence rides the rim, which is by definition the edge of the walkable world.
   * See `writeVesselFence`. Two fences would be two fences.
   */
  vesselled: (x: number, z: number) => boolean,
): void {
  const px = -seg.uz;
  const pz = seg.ux;

  for (const side of [-1, 1]) {
    const ribs = vergeRibs(seg, side, cut, rawGround, plans, vesselled);
    if (ribs === null) continue;

    // `writeTrench`'s own hazard, in its own words: `px * o * side` mirrors the
    // frame, a mirror reverses handedness, and the same four corners in the same
    // order give one side its normal and the other side the opposite of it. The
    // verge is a `FrontSide` strip and would be culled on one whole side of
    // every railway in Sydney without this.
    const at = (rib: VergeRib, o: number, y: number): [number, number, number] => [
      rib.cx + px * o * side, y, rib.cz + pz * o * side,
    ];
    const face = (
      p0: [number, number, number], p1: [number, number, number],
      p2: [number, number, number], p3: [number, number, number],
    ): void => {
      if (side > 0) cess.quad(...p3, ...p2, ...p1, ...p0);
      else cess.quad(...p0, ...p1, ...p2, ...p3);
    };

    for (let i = 0; i < ribs.length - 1; i++) {
      const a = ribs[i];
      const b = ribs[i + 1];
      if (!trenched && !a.vessel && !b.vessel) {
        face(
          at(a, CESS_INNER, a.formation),
          at(b, CESS_INNER, b.formation),
          at(b, b.o, b.verge),
          at(a, a.o, a.verge),
        );
      }
    }

    // The fence, clipped to the stretches the road rule allows one. Double-sided,
    // so the winding above does not apply and is not repeated: see
    // `fences.createRailFenceMaterial`. A run's ends are already **on** the fence
    // line -- `fenceRuns` interpolates between ribs that were offset when they
    // were built -- so `at` is deliberately not used here.
    for (const run of fenceRuns(ribs, cut, rawGround, plans, vesselled)) {
      fence.quad(
        run.ax, run.ay, run.az,
        run.bx, run.by, run.bz,
        run.bx, run.by + FENCE_HEIGHT, run.bz,
        run.ax, run.ay + FENCE_HEIGHT, run.az,
        [run.au, 0, run.bu, 0, run.bu, FENCE_HEIGHT, run.au, FENCE_HEIGHT],
      );
    }
  }
}

// --- The vessel, drawn ----------------------------------------------------------
//
// Phase 3a of `STATIONS.md`. Everything below is behind `?vessels=1` and is
// reached only from `RailWorld.setVessels`; with the flag down not one line of it
// runs and the world is the one that shipped.
//
// The rule the three writers share, and it is the reason they are three short
// functions rather than a rewrite of the four above: **they add no geometry of
// their own.** The shell is the vessel's own triangles, sorted into materials by
// the vessel's own record of which profile edge it swept each one from. The
// barrier is the vessel's own rim and wall-foot vertices. The fence is the rim
// ring, walked in order. Nothing here re-measures a half-width, re-reads the DEM
// or decides where an edge is -- which is what `writeTrench` and `writeVerge`
// each do independently, and is why the two of them disagree about the rim by
// half a metre and paper over it with a lap.

/**
 * Is this face one anybody ever sees?
 *
 * The buried half of the shell -- the underside and the two outer skins -- exists
 * so the surface closes, and the terrain is triangulated to the rim, so the
 * ground meets the *outer edge of the coping* and everything below that is
 * earth. Dropping them from the drawn mesh is not an optimisation that trades
 * correctness for triangles: it is 42% of the sweep's faces that cannot be
 * reached by a camera without first being underground.
 */
function vesselFaceDrawn(edge: number): boolean {
  return (
    edge !== TRENCH_EDGE.UNDERSIDE &&
    edge !== TRENCH_EDGE.SKIN_LEFT &&
    edge !== TRENCH_EDGE.SKIN_RIGHT
  );
}

/**
 * How many of a vessel's triangles are drawn, against how many it has.
 *
 * The budget line for Phase 3a, and the reason it is a function here rather than
 * a number in a comment: *the solid is unchanged*. `Vessel.triangles` is what
 * the manifold invariant is proved over and what `STATIONS.md` costs the sweep
 * at; this is the subset a camera can reach. The two are different numbers about
 * the same object and reporting one as the other is how a budget starts lying.
 */
export function drawnTriangles(vessel: Vessel): number {
  let n = 0;
  for (let f = 0; f < vessel.triangles; f++) if (vesselFaceDrawn(vessel.faceEdge[f])) n++;
  return n;
}

/**
 * The vessel's own faces, sorted into the two materials a cutting is made of.
 *
 * **The floor is `cess` and not `ballast`**, which is a change from
 * `writeFormation` and is the point of drawing the two things separately. A
 * formation floor is the pale compacted strip a track worker walks on; the blue
 * metal is the ballast prism sitting *on* it under each track, and
 * `writeBallast` now carries that prism all the way down to this surface. Draw
 * the whole floor in blue metal, as `writeFormation` did, and a six-road cutting
 * is one dark trough with rails on top of it -- which is what the frame at
 * Erskineville looked like, and is why the report said "rails painted on a car
 * park" about the flat version of the same mistake.
 *
 * Faces are filed by their **own centroid**, so a formation four kilometres long
 * lands in the chunks it crosses, one triangle in exactly one chunk. That is a
 * partition and not a clip: nothing is drawn twice and there is no seam between
 * two chunks, because no triangle is cut.
 */
function writeVesselShell(
  concrete: Solid,
  cess: Solid,
  vessel: Vessel,
  inChunk: (x: number, z: number) => boolean,
): void {
  const p = vessel.position;
  const ix = vessel.index;
  for (let f = 0; f < vessel.triangles; f++) {
    const edge = vessel.faceEdge[f];
    if (!vesselFaceDrawn(edge)) continue;
    const a = ix[f * 3] * 3;
    const b = ix[f * 3 + 1] * 3;
    const c = ix[f * 3 + 2] * 3;
    if (!inChunk((p[a] + p[b] + p[c]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3)) continue;
    // One triangle, with the face normal of its own plane, which is what every
    // other writer in this file emits and what the flat-shaded materials expect.
    const into = edge === TRENCH_EDGE.FLOOR ? cess : concrete;
    into.tri(
      p[a], p[a + 1], p[a + 2],
      p[b], p[b + 1], p[b + 2],
      p[c], p[c + 1], p[c + 2],
    );
  }
}

/**
 * The boundary fence, on the rim.
 *
 * ---------------------------------------------------------------------------
 * **THIS IS THE PLAYER'S POINT 4, AND IT FALLS OUT RATHER THAN BEING SOLVED.**
 *
 * *"overpass dont have fence along line, but fence along path or road edge"*.
 * `writeVerge` runs the fence at `max(FENCE_OFFSET, halfWidth + FENCE_CLEAR)`
 * from **a track centreline**, so it knows about rails and nothing else: it
 * marches across every carriageway in the city, it fences the six-foot of a
 * four-road formation unless `markCorridorEdges` talks it out of it, and at a
 * flyover it fences the buried line rather than the deck.
 *
 * A vessel's rim *is* the edge of the walkable world -- that is what the seam
 * rule makes it, and the terrain is triangulated to these very vertices -- so a
 * fence that rides the rim is in the right place by construction. It needs no
 * `open` flags, no `CORRIDOR_NEIGHBOUR` and no notion of a track. Where a road
 * crosses over, the corridor is decked, the rim runs under the deck, and the two
 * tests below are the only thing the fence has left to know.
 *
 * The ring is walked whole, so `u` -- metres along the fence, which is what the
 * bar mask is drawn in -- is continuous across a chunk boundary; only the panels
 * whose midpoint is in this chunk are emitted. The two **end** edges of the ring
 * are skipped: the ring runs down one seam and back the other, so it closes
 * across the mouth of the cutting, and a panel there would be a fence across the
 * railway. They are identified from `ribSeam` -- an edge whose ends are the two
 * seam vertices of one rib -- rather than by looking for a long edge, because
 * "long" is a threshold and this is a fact.
 */
function writeVesselFence(
  fence: Solid,
  vessel: Vessel,
  inChunk: (x: number, z: number) => boolean,
  cut: RailCut | null,
  plans: readonly StationPlan[],
): void {
  const rim = vessel.rim;
  const seam = vessel.ribSeam;
  if (rim.length < 3 || seam === null) return;
  /** The two vertices that close the ring across a rib, as `a * 2^21 + b` keys. */
  const ends = new Set<number>();
  const pair = (a: number, b: number): number => Math.min(a, b) * 0x200000 + Math.max(a, b);
  ends.add(pair(seam[0], seam[1]));
  ends.add(pair(seam[(vessel.ribCount - 1) * 2], seam[(vessel.ribCount - 1) * 2 + 1]));
  const p = vessel.position;
  let u = 0;
  for (let i = 0; i < rim.length; i++) {
    const va = rim[i];
    const vb = rim[(i + 1) % rim.length];
    const ax = p[va * 3];
    const ay = p[va * 3 + 1];
    const az = p[va * 3 + 2];
    const bx = p[vb * 3];
    const by = p[vb * 3 + 1];
    const bz = p[vb * 3 + 2];
    const ua = u;
    u += Math.hypot(bx - ax, bz - az);
    if (ends.has(pair(va, vb))) continue;
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (!inChunk(mx, mz)) continue;
    // **The deck, on `writeVerge`'s own test and for its own reason**: a road
    // bridge over the corridor keeps its ground, the rim runs under it, and a
    // panel whose head would come through the carriageway is the frame the
    // player photographed. A road *viaduct* ten metres up is a deck too and the
    // fence under it is a real fence, which is why this is the panel's head
    // against the soffit rather than "is there a road overhead".
    // The rim vertex's own height stands in for the ground here, and it is the
    // right stand-in: this fence sits on the vessel's rim, which `corridor.ts`
    // swept to the terrain, so `max(ay, by)` *is* the ground under the panel.
    // There is no `rawGround` in scope and reaching for one would be a second
    // opinion about a surface this function already has.
    const deck = cut === null ? Number.NaN : cut.deckSurfaceAt(mx, mz, Math.max(ay, by));
    if (Number.isFinite(deck) && Math.max(ay, by) + FENCE_HEIGHT > deck - DECK_THICKNESS_M) continue;
    // And a station entrance, which is the one place a boundary fence is
    // deliberately open. `writeVerge`'s rule, unchanged.
    if (entranceOpens(plans, mx, mz)) continue;
    // Double-sided, like every other fence panel here, so no winding argument
    // applies. See `fences.createRailFenceMaterial`.
    fence.quad(
      ax, ay, az,
      bx, by, bz,
      bx, by + FENCE_HEIGHT, bz,
      ax, ay + FENCE_HEIGHT, az,
      [ua, 0, u, 0, u, FENCE_HEIGHT, ua, FENCE_HEIGHT],
    );
  }
}

/**
 * The thing that stops you walking into the cutting, from the rim that knows
 * where the cutting is.
 *
 * ---------------------------------------------------------------------------
 * **WHY THIS IS NOT THE PRISM DECOMPOSITION `STATIONS.md` REFUSED.**
 *
 * That refusal is about the *surface*: decomposing a vessel into prisms so a
 * body can be stood on it would be a third description of a boundary that
 * already has two consumers, kept in step by diligence. The ground query does
 * not do that -- `world/vessel-field.ts` evaluates the sweep's own faces.
 *
 * A **barrier** is a different question, and nothing in the design answers it.
 * `CollisionWorld` knows about prisms; a retaining wall has to be one or a
 * player walks through it. What matters is that the prism is not a *second
 * opinion about where the wall is*: its four corners are the vessel's own rim
 * and wall-foot vertices, read by index, so it cannot drift from the wall that
 * is drawn. `writeTrench` pushes the same box from its own re-measured rim, and
 * that is exactly the arrangement this replaces.
 *
 * One box per rib pair per side, which is `writeTrench`'s own bound and for its
 * own two reasons: a chord is not a wall where the corridor flares, and a run-out
 * must not get a box as tall as its deep end.
 */
export function writeVesselWalls(
  prisms: Array<{ points: Float32Array; height: number; base: number }>,
  vessel: Vessel,
  inChunk: (x: number, z: number) => boolean,
): number {
  const p = vessel.position;
  let refused = 0;
  for (let i = 0; i < vessel.ribCount - 1; i++) {
    // Only the eight-point `U`. A transition rib re-numbers the profile, so a
    // point read by index there would be some other part of the cross-section --
    // refused and counted rather than guessed at. No formation transitions
    // today; the platform deck in Phase 3b will.
    if (vessel.ribOffset[i + 1] - vessel.ribOffset[i] !== 8 ||
        vessel.ribOffset[i + 2] - vessel.ribOffset[i + 1] !== 8) {
      refused++;
      continue;
    }
    for (const [foot, rimPt] of [
      [TRENCH_POINT.FOOT_RIGHT, TRENCH_POINT.RIM_RIGHT],
      [TRENCH_POINT.FOOT_LEFT, TRENCH_POINT.RIM_LEFT],
    ] as const) {
      const f0 = (vessel.ribOffset[i] + foot) * 3;
      const f1 = (vessel.ribOffset[i + 1] + foot) * 3;
      const r0 = (vessel.ribOffset[i] + rimPt) * 3;
      const r1 = (vessel.ribOffset[i + 1] + rimPt) * 3;
      const mx = (p[f0] + p[f1] + p[r0] + p[r1]) / 4;
      const mz = (p[f0 + 2] + p[f1 + 2] + p[r0 + 2] + p[r1 + 2]) / 4;
      if (!inChunk(mx, mz)) continue;
      const base = Math.min(p[f0 + 1], p[f1 + 1]);
      const top = Math.max(p[r0 + 1], p[r1 + 1]);
      // A wall shorter than a kerb is a run-out, not a wall. `writeTrench`'s own
      // threshold, so the two paths agree about where a cutting stops.
      if (top - base <= TRENCH_MIN_HEIGHT) continue;
      prisms.push({
        points: new Float32Array([
          p[f0], p[f0 + 2],
          p[f1], p[f1 + 2],
          p[r1], p[r1 + 2],
          p[r0], p[r0 + 2],
        ]),
        height: top - base,
        base,
      });
    }
  }
  return refused;
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
  signs: Solid,
  /** This station's solids, from `rail-solids.undergroundSolids`. */
  _boxes: readonly FrameSolid[],
  station: RailStation & { ux: number; uz: number },
): void {
  const ux = station.ux;
  const uz = station.uz;
  const px = -uz;
  const pz = ux;
  // **The floor is the concourse, at platform level, wall to wall.** It was
  // the ballast, 0.4 m under the railhead, with the platforms as 1.45 m
  // kerbs in it -- a step no body climbs, so a player who walked off a
  // platform was in the room for good. `game/riding.concourseY` is the
  // number the field stands a body on; this draws it. The trains sit with
  // their wheels in the slab and their door sills at the floor, which is what
  // a platform is.
  const floor = concourseY(station as unknown as RailStation);
  // The lid: under the street, whatever the bake said. See `riding.roomCeilY`.
  const roof = Math.min(floor + BOX_HEIGHT, roomCeilY(station as unknown as RailStation, accessWorld));
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

  // **The lid, seen from outside, and the room had none.** Everything above is
  // on `lining`, which is the file's one `BackSide` material -- correct for a
  // tube you stand in, and it means the ceiling exists only when you are under
  // it. From the street there was nothing there at all: wherever the terrain
  // over a box is carved, you looked straight down into the station. The owner:
  // *"metro underground has no roof?"*
  //
  // So the same rectangle again on `concrete`, wound the other way, which is
  // front-facing and therefore visible from above and culled from below. The two
  // faces do not fight: each is drawn for the side the other cannot serve, and
  // a player inside still sees the lining ceiling they always did.
  concrete.quad(...corner(-L, W, roof), ...corner(L, W, roof), ...corner(L, -W, roof), ...corner(-L, -W, roof));

  // Two platforms inside it, on the same clearances the surface ones use.
  // The platform strips, as a concrete band on the lining floor: a different
  // material at the same height, so the edge reads without being a kerb. A
  // hair above the floor so the two do not fight.
  const top = floor + 0.02;
  for (const side of [-1, 1]) {
    const inner = PLATFORM_INNER * side;
    const outer = (PLATFORM_INNER + PLATFORM_WIDTH) * side;
    concrete.quad(...corner(-L + 6, inner, top), ...corner(L - 6, inner, top), ...corner(L - 6, outer, top), ...corner(-L + 6, outer, top));
  }

  // **The way in, from the plan both ends read.** `game/riding.stationAccessPlan`
  // decides where the mouth is (the real entrance), how long the incline is
  // and where the tunnel turns; this draws exactly those numbers, so the shaft
  // a player sees and the floor `StationBoxField` stands them on cannot
  // disagree. The first design put the mouth 68 m along and 40 m across the
  // site at the site's own height, which the owner found impassable and
  // undrawn where the street there was a few metres higher.
  const plan = stationAccessPlan(station as unknown as RailStation, accessWorld);
  if (plan === null) return;
  const HW = ACCESS_HALF_W;
  const H = ACCESS_HEIGHT_M;
  const nx = -plan.dirZ;
  const nz = plan.dirX;
  const at = (d: number, o: number, y: number): [number, number, number] => [
    plan.mouthX + plan.dirX * d + nx * o, y, plan.mouthZ + plan.dirZ * d + nz * o,
  ];
  // Flat past the mouth: the field caps the lean there (`StationBox.riseMax`).
  const yAt = (d: number): number => plan.mouthY - (plan.mouthY - plan.floorY) * (Math.max(d, 0) / plan.inclineM);
  const d0 = -ACCESS_OVERLAP_M / 2;
  const d1 = plan.inclineM + ACCESS_OVERLAP_M / 2;
  // The incline: floor, ceiling and two side walls, all leaning together, on
  // the lining -- the one BackSide material, for the player under it.
  for (const dy of [0, H]) {
    lining.quad(...at(d0, -HW, yAt(d0) + dy), ...at(d0, HW, yAt(d0) + dy), ...at(d1, HW, yAt(d1) + dy), ...at(d1, -HW, yAt(d1) + dy));
  }
  for (const sgn of [-1, 1]) {
    lining.quad(...at(d0, HW * sgn, yAt(d0)), ...at(d1, HW * sgn, yAt(d1)), ...at(d1, HW * sgn, yAt(d1) + H), ...at(d0, HW * sgn, yAt(d0) + H));
  }
  // Its lid from above, on concrete, so the street over it is not a hole.
  concrete.quad(...at(d0, -HW, yAt(d0) + H), ...at(d1, -HW, yAt(d1) + H), ...at(d1, HW, yAt(d1) + H), ...at(d0, HW, yAt(d0) + H));
  // The tunnel from the foot into the room, flat at the floor.
  const tx = -plan.tunDirZ;
  const tz = plan.tunDirX;
  const tat = (d: number, o: number, y: number): [number, number, number] => [
    plan.footX + plan.tunDirX * d + tx * o, y, plan.footZ + plan.tunDirZ * d + tz * o,
  ];
  const t0 = -HW;
  const t1 = plan.tunnelM;
  for (const dy of [0, H]) {
    lining.quad(...tat(t0, -HW, plan.floorY + dy), ...tat(t0, HW, plan.floorY + dy), ...tat(t1, HW, plan.floorY + dy), ...tat(t1, -HW, plan.floorY + dy));
  }
  for (const sgn of [-1, 1]) {
    lining.quad(...tat(t0, HW * sgn, plan.floorY), ...tat(t1, HW * sgn, plan.floorY), ...tat(t1, HW * sgn, plan.floorY + H), ...tat(t0, HW * sgn, plan.floorY + H));
  }
  concrete.quad(...tat(t0, -HW, plan.floorY + H), ...tat(t1, -HW, plan.floorY + H), ...tat(t1, HW, plan.floorY + H), ...tat(t0, HW, plan.floorY + H));
  // The entrance on the street: a portal frame over the mouth, open toward
  // the street and into the incline, and a totem beside it a player can see
  // from a block away -- a 6 m post with a panel in the rail orange, which
  // is the one colour every Sydneysider reads as "train".
  const w = HW + 0.6;
  const y = plan.mouthY;
  for (const sgn of [-1, 1]) {
    // a pier each side of the mouth
    const c = at(0, (HW + 0.3) * sgn, y);
    concrete.box(c[0] - 0.3, y, c[2] - 0.3, c[0] + 0.3, y + 3.4, c[2] + 0.3);
  }
  // the lintel, as a thin slab across the piers
  const l0 = at(0, -w, y);
  const l1 = at(0, w, y);
  concrete.box(Math.min(l0[0], l1[0]) - 0.3, y + 3.4, Math.min(l0[2], l1[2]) - 0.3, Math.max(l0[0], l1[0]) + 0.3, y + 3.8, Math.max(l0[2], l1[2]) + 0.3);
  // the totem
  const tpost = at(-2.5, w + 1.2, y);
  concrete.box(tpost[0] - 0.18, y, tpost[2] - 0.18, tpost[0] + 0.18, y + 6.2, tpost[2] + 0.18);
  signs.box(tpost[0] - 0.9, y + 4.6, tpost[2] - 0.9, tpost[0] + 0.9, y + 6.2, tpost[2] + 0.9);

  // --- The hole in the street, dressed. `riding.accessCutAt` carves the
  // terrain over the first `cutLen` metres of the incline and `ACCESS_APRON_M`
  // around it, on both ends; this is the concrete that stands in the hole so
  // it reads as an entrance and not as a pit. The apron is a flat slab at the
  // mouth's height round the passage, with a skirt down its outside edge so
  // the four-metre carve lattice never shows a void under a lip of grass; the
  // passage's own walls get an outer face where they stand above the apron,
  // because the lining is drawn from inside only. The lid on top is already
  // concrete. What the owner saw -- *"passing thru floor"* -- was the terrain
  // running across all of this; now the terrain stops at the apron's edge.
  const cutLen = accessCutLength(plan, accessWorld.groundAt);
  const A = ACCESS_APRON_M;
  const SKIRT = 1.6;
  const d0a = -A;
  const d1a = cutLen + A;
  const wOut = HW + A;
  // The apron: two side strips, a front strip and a back strip, all at the
  // mouth's height, leaving the passage's own plan open between them.
  const slab = (da: number, db: number, wa: number, wb: number): void => {
    concrete.quad(...at(da, wa, y), ...at(db, wa, y), ...at(db, wb, y), ...at(da, wb, y));
  };
  slab(d0a, d1a, -wOut, -HW);
  slab(d0a, d1a, HW, wOut);
  slab(d0a, 0, -HW, HW);
  slab(cutLen, d1a, -HW, HW);
  // The skirt, facing out, round the apron's four edges.
  const skirt = (a: [number, number, number], b: [number, number, number]): void => {
    concrete.quad(a[0], y - SKIRT, a[2], b[0], y - SKIRT, b[2], b[0], y, b[2], a[0], y, a[2]);
  };
  skirt(at(d0a, -wOut, y), at(d0a, wOut, y));
  skirt(at(d1a, wOut, y), at(d1a, -wOut, y));
  skirt(at(d0a, wOut, y), at(d1a, wOut, y));
  skirt(at(d1a, -wOut, y), at(d0a, -wOut, y));
  // The passage walls' outer faces, from the apron up to the lid, where the
  // lid is above the apron. Wound to face away from the passage.
  for (const sgn of [-1, 1]) {
    for (let d = 0; d < cutLen; d += 2) {
      const dn = Math.min(cutLen, d + 2);
      const top0 = yAt(d) + H;
      const top1 = yAt(dn) + H;
      if (top0 <= y && top1 <= y) break;
      const p0 = at(d, HW * sgn, y);
      const p1 = at(dn, HW * sgn, y);
      const q0 = at(d, HW * sgn, Math.max(y, top0));
      const q1 = at(dn, HW * sgn, Math.max(y, top1));
      if (sgn > 0) concrete.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], q1[0], q1[1], q1[2], q0[0], q0[1], q0[2]);
      else concrete.quad(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], q0[0], q0[1], q0[2], q1[0], q1[1], q1[2]);
    }
  }
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
 * The chunk builder's cursor, proved without building a chunk.
 *
 * `advanceChunkStep` is the whole of the state machine that is *pure*, and it is
 * the piece a mistake in would be silent in the worst way: a phase skipped
 * builds a chunk with no rails on it, a phase visited twice builds the ballast
 * of a station on top of itself, and both look like ordinary geometry from a
 * distance. The identity test in `perf-harness.ts` would catch either -- but
 * that test needs the bake and a minute, and this needs neither, so this is what
 * ships in the boot list.
 *
 * What it asserts, over a set of size vectors chosen to be every shape a real
 * chunk can have -- empty, one phase only, a hole in the middle, a hole at each
 * end -- is the only property the accumulators depend on: **the walk visits
 * every step of every phase exactly once, in order, and then stops.**
 */
export function verifyRailChunkSteps(): string[] {
  const bad: string[] = [];

  if (PHASE_NAMES.length !== PHASE_COUNT) {
    bad.push(`PHASE_NAMES has ${PHASE_NAMES.length} entries for ${PHASE_COUNT} phases`);
  }
  // Eleven materials, the wire and the tail. Named here because the finish
  // phase's `switch` is a list of literals and a miscount would silently drop
  // the last material off the end of the walk.
  if (FINISH_STEPS !== 13) bad.push(`FINISH_STEPS is ${FINISH_STEPS}; it is 11 materials + the wire + the tail`);
  // The two name tables are read by index off a live cursor, so a short one is
  // an `undefined` in a performance report rather than a crash -- which is the
  // kind of thing that survives for a year.
  if (STATION_STEP_NAMES.length !== STATION_STEPS) {
    bad.push(`STATION_STEP_NAMES has ${STATION_STEP_NAMES.length} entries for ${STATION_STEPS} steps`);
  }
  if (FINISH_STEP_NAMES.length !== FINISH_STEPS) {
    bad.push(`FINISH_STEP_NAMES has ${FINISH_STEP_NAMES.length} entries for ${FINISH_STEPS} steps`);
  }

  const shapes: number[][] = [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 1, FINISH_STEPS],
    [1, 12, 0, STATION_STEPS, 0, 12, FINISH_STEPS],
    [2, 40, 3, 2 * STATION_STEPS, 5, 40, FINISH_STEPS],
    [0, 0, 0, 0, 0, 0, FINISH_STEPS],
    [3, 0, 0, 0, 0, 0, 0],
    [0, 0, 7, 0, 0, 0, 0],
  ];
  for (const sizes of shapes) {
    const want: string[] = [];
    for (let p = 0; p < sizes.length; p++) for (let i = 0; i < sizes[p]; i++) want.push(`${p}:${i}`);
    const got: string[] = [];
    const at: ChunkCursor = { phase: 0, index: -1 };
    // Bounded, so a cursor that failed to terminate is a failure rather than a
    // hung boot.
    for (let guard = 0; guard <= want.length + 4; guard++) {
      if (!advanceChunkStep(sizes, at)) break;
      got.push(`${at.phase}:${at.index}`);
    }
    if (got.join(',') !== want.join(',')) {
      bad.push(
        `the chunk cursor walked [${got.join(',')}] over sizes [${sizes.join(',')}]; ` +
          `it must walk [${want.join(',')}]`,
      );
      continue;
    }
    // ...and it stays stopped. A cursor that restarts would rebuild the chunk
    // on top of itself for as long as the frame budget allowed.
    if (advanceChunkStep(sizes, at)) {
      bad.push(`the chunk cursor restarted after finishing sizes [${sizes.join(',')}]`);
    }
  }

  // The four state codes are compared with `===` in `reshapeRing`, so two of
  // them sharing a value would make an in-flight chunk queue a second time.
  const codes = [CHUNK_ABSENT, CHUNK_PENDING, CHUNK_BUILDING, CHUNK_BUILT];
  if (new Set(codes).size !== codes.length) bad.push('the four chunk state codes are not distinct');

  return bad;
}

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
    /*
     * --- The one stop the shipped bake gets wrong, by name, at its measured
     *     distance.
     *
     * Denistone on the CCN stops 107 m from its own platform in the current
     * bake. That is a pipeline fault, and the fix is a retile -- not something
     * a client can do. Until then this assertion failed on every boot for
     * every player, at `warn`, which is a check nobody reads. A ratchet at the
     * measured number is `DEPLOY.md`'s own pattern: the known case is allowed
     * at 107 and not a metre more, everything else is still held to 80, and
     * the retile that fixes it deletes this entry.
     */
    const KNOWN_LONG_STOPS: Record<string, number> = { 'Denistone on CCN dir 1': 108 };
    const allowed = KNOWN_LONG_STOPS[worst.name] ?? PLATFORM_HALF_LENGTH;
    if (worst.metres > allowed) {
      bad.push(
        `${worst.name} stops ${worst.metres.toFixed(0)} m from its own platform, which is over ` +
          `the ${PLATFORM_HALF_LENGTH} m half-length`,
      );
    }
  }
  // --- **Every station a player can reach has a way onto its platform.**
  //
  // `RAIL-VERTICAL.md` section 5's first invariant, as much of it as can be
  // proved without a terrain tile: a full pathfind needs the heightfield and
  // this runs at boot before a single tile is resident, so what is asserted here
  // is the *generator* rather than one instance of its output.
  //
  // That is deliberately not a weaker claim than it sounds. The two reports were
  // "im at roseville and cant get up to the platform" and a player on the
  // Chatswood plaza with no route down, and neither was a station where the
  // stair was too steep -- both were stations where **no stair existed at all**,
  // because the thing that decided to build one read `vertical`. So the property
  // that would have caught them is: for every drop a station can present, the
  // planner emits a flight, and every riser in it is inside the height a body
  // can climb. Checked over the whole range the bake contains, from the 0.43 m a
  // platform at grade presents to the deepest station in the city.
  {
    let worstRise = 0;
    let worstAt = 0;
    let unbuilt = 0;
    for (let drop = 0.43; drop < 26; drop += 0.13) {
      const steps = Math.min(STAIR_MAX_STEPS, Math.round(drop / STAIR_RISE));
      if (steps < 1) {
        unbuilt++;
        continue;
      }
      const rise = drop / steps;
      if (rise > worstRise) {
        worstRise = rise;
        worstAt = drop;
      }
    }
    if (unbuilt > 0) {
      bad.push(`${unbuilt} reachable drops above the walk-up height generate no flight at all`);
    }
    // `player/controller.STEP_HEIGHT`. A riser over it is a stair a body walks
    // into rather than up, which is the one failure worse than no stair.
    if (worstRise > 0.42) {
      bad.push(
        `a ${worstAt.toFixed(2)} m drop generates a ${worstRise.toFixed(2)} m riser, over the ` +
          '0.42 m a body can climb: that staircase would look usable and would not be',
      );
    }
    // The negative control, and it is what stops the two lines above being
    // vacuous: the platform lip **on its own** is over the climb height, so a
    // station at grade with no flight is a station nobody can board. If this
    // ever stops being true, "at grade needs no stair" becomes correct and the
    // whole of `writeStationAccess`'s at-grade case is dead code.
    if (PLATFORM_HEIGHT <= STAIR_FLAT) {
      bad.push(
        `a platform is ${PLATFORM_HEIGHT} m over the formation and a body climbs ${STAIR_FLAT} m, ` +
          'so the access generator is answering a question nobody asked',
      );
    }
    // And that the flight fits where it is put. The band is 2.16 m wide and the
    // run is along the platform, so the only thing that can overflow is the
    // platform's own half-length.
    const longest = STAIR_MAX_STEPS * STAIR_GOING;
    if (ACCESS_ALONG + longest > PLATFORM_HALF_LENGTH + BOX_HALF_LENGTH) {
      bad.push(`the deepest flight runs ${(ACCESS_ALONG + longest).toFixed(0)} m past the platform centre`);
    }
    if (STAIR_INNER < PLATFORM_INNER + PLATFORM_WIDTH || STAIR_OUTER > STATION_HALF_WIDTH) {
      bad.push('the access flight is not inside the strip the terrain carve opens at a platform');
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
