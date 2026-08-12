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
import {
  CUT_HALF_WIDTH,
  CUT_MIN_DEPTH,
  STATION_HALF_WIDTH,
  TRENCH_MIN_DEPTH,
  drawnAsTunnel,
  type RailCut,
} from './rail-cut.ts';
import { DECK_THICKNESS_M } from './road-deck.ts';
import { RAIL_HALF_M } from './envelope.ts';
import { RAIL_FENCE_HEIGHT, createRailFenceMaterial } from './fences.ts';
// **One rule for what counts as one platform**, imported rather than restated.
// The prisms this file draws and the rectangles `game/riding.PlatformField`
// stands bodies on have to be the same set -- that is the whole reason the field
// is built from the bake instead of from the geometry -- and two copies of a
// merge rule is exactly the shape of drift that put an M1 at Epping on the T9
// platform's paperwork and no platform of its own. `riding.ts` imports nothing
// but `rail.ts`, so this drags no renderer anywhere it should not go.
import { PLATFORM_OUTER_M, samePlatform } from '../game/riding.ts';

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

/**
 * The cutting. Where the ground has been taken away by `world/rail-cut.ts`,
 * this is what stands in the hole.
 *
 * `TRENCH_BATTER` is the lean of the retaining wall, horizontal over vertical.
 * A real cutting wall is between 1:4 and 1:8 depending on whether it is
 * sandstone, brick or sprayed concrete; 1:6 reads as a wall rather than as an
 * embankment and keeps a 13 m cutting's foot 2.2 m inboard of its top, which is
 * still clear of the ballast.
 *
 * `TRENCH_STEP_M` is how often the wall re-reads the terrain along the run. The
 * bake's segments average 40 m, which is longer than a DEM post, so a wall built
 * as one ruled quad per segment would leave its top a metre off the rim of the
 * hole in the middle of every span. Eight metres tracks the grid closely enough
 * that the two never part company by more than a few centimetres.
 */
const TRENCH_BATTER = 1 / 6;
const TRENCH_STEP_M = 8;
/** The coping: how far the wall's top laps *over* the rim of the hole. */
const TRENCH_COPING = 0.5;
/** And how far it stands over the ground, so the lap is never a hairline. */
const TRENCH_COPING_RISE = 0.12;
/** The wall foot never comes inboard of this, whatever the batter says. */
const TRENCH_FOOT_MIN = BALLAST_BASE_HALF + 0.3;
/** Below this a wall is not worth its triangles; the track is at grade. */
const TRENCH_MIN_HEIGHT = 0.45;

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

// --- The corridor, past the ballast -------------------------------------------
//
// Everything between the track and the street, which before this round was
// nothing at all: the railway stopped at the toe of its own ballast and the
// suburb started, with no edge between them. Reported in those words -- *"rails
// painted on a car park"* -- and `RAIL-VERTICAL.md` section 6 names the fence as
// the mitigation for the one case no measurement can recover.

/** The boundary fence, from the track centre, where nothing else decides. */
const FENCE_OFFSET = 6.4;
/** ...and how far outside a carved corridor rim it stands where there is one. */
const FENCE_CLEAR = 0.9;
/**
 * A parallel track within this distance, on a side, means that side is **inside
 * the corridor** and gets no fence and no verge.
 *
 * The bake's polylines are one per *track*, not one per corridor: the up and
 * down roads of a double-track railway are separate OSM ways four metres apart
 * and `buildNetwork` deliberately does not merge them (see section 2). So a
 * naive fence per segment would run a fence **between the running lines** of
 * every double-track railway in Sydney, four metres from each rail, which is
 * both absurd and twice the geometry. `markCorridorEdges` decides once, at load,
 * which sides of which segments are the outside of the corridor.
 *
 * 8.2 m rather than `FENCE_OFFSET`: it must exceed the offset the fence would
 * have been built at, or a four-road corridor fences its two middle roads.
 */
const CORRIDOR_NEIGHBOUR = 8.2;
/** How often the fence and the verge re-read the ground. `TRENCH_STEP_M`'s twin. */
const VERGE_STEP_M = 8;
/** The verge never climbs or falls further than this from the formation. */
const VERGE_RELIEF = 2.4;
/** Where the ballast's toe ends and the cess begins, from the track centre. */
const CESS_INNER = BALLAST_BASE_HALF - 0.15;
/** The fence panel's own height. Must be `fences.RAIL_FENCE_HEIGHT`. */
const FENCE_HEIGHT = RAIL_FENCE_HEIGHT;

// --- Access, which is generated and never looked up ----------------------------
//
// `RAIL-VERTICAL.md` section 4, in one sentence: **a station cannot lack access,
// because the same number that made it need access generates it.** Two reports
// -- *"im at roseville and cant get up to the platform"* and a player on the
// Chatswood plaza reading "doors 23 m away" with no way down to them -- are the
// same defect, and it is the defect of treating a staircase as content.
//
// So there is no lookup here and no OSM tag consulted. There is a measured drop
// from the ground beside a platform to the top of it, and a flight of steps
// whose length is that drop divided by a gradient.

/** Riser and going. The gradient is 0.61, which is a public stair. */
const STAIR_RISE = 0.19;
const STAIR_GOING = 0.31;
/**
 * A drop smaller than this is walked, not climbed, and no flight is built.
 *
 * **It is `controller.STEP_HEIGHT` and it has to be.** That constant is what
 * decides whether a body walks up a kerb or into it, so a station whose platform
 * stands 0.5 m over the ground is a station nobody can board while a stair
 * threshold set by eye at 0.8 m would have called it "at grade" and built
 * nothing. Duplicated rather than imported for `game/rail.ts`'s reason -- this
 * module must build in a process with no player in it -- and the integration
 * check is where the two are proved equal.
 */
const STAIR_FLAT = 0.42;
/** Bounded, because a 40 m shaft is a switchback and this builder has no turn. */
const STAIR_MAX_STEPS = 170;
/**
 * The flight's band, from the track centre: outside the platform's own face and
 * in to the rim of the carved corridor.
 *
 * The platform's outer face is at `PLATFORM_INNER + PLATFORM_WIDTH` = 7.12 m and
 * `rail-cut.STATION_HALF_WIDTH` is 9.4 m, so this is exactly the strip the carve
 * already opens at every platform site and nothing else wants. In a cutting the
 * flight is therefore *cut into the trench wall*, which is section 4's own
 * instruction and is also where a real one is; at grade and on an embankment it
 * is a free-standing stair against the platform's flank.
 */
const STAIR_INNER = PLATFORM_INNER + PLATFORM_WIDTH + 0.12;
const STAIR_OUTER = STATION_HALF_WIDTH;
/** Where the flight meets the platform, along it. Clear of the canopy. */
const ACCESS_ALONG = 44;
/** How far the boundary fence opens at an entrance. See `writeVerge`. */
const FENCE_GAP_RADIUS = 10;

/**
 * The footbridge deck, above the rail head.
 *
 * Over the overhead line and over the masts that carry it: `MAST_HEIGHT` is
 * 7.4 m and the messenger is at 6.35, so a soffit at 8.05 is the first height
 * that clears the electrification rather than passing through it.
 */
const BRIDGE_CLEAR = 8.4;
const BRIDGE_DECK = 0.35;
const BRIDGE_ALONG = -50;
const BRIDGE_RUN = 2.6;
const BRIDGE_RAIL_H = 1.15;
/** Below this clearance over the ground the bridge is not built. See `writeFootbridge`. */
const BRIDGE_MIN_OVER_GROUND = 2.5;

/** The station building at the street end: a brick box with an awning. */
const HOUSE_LENGTH = 11;
const HOUSE_WIDTH = 6.5;
const HOUSE_HEIGHT = 3.9;
const HOUSE_AWNING = 1.6;

/** Platform edge: the tactile strip and the coping it sits behind. */
const TACTILE_INSET = 0.11;
const TACTILE_WIDTH = 0.42;
/** How far the coping stands over the deck, so it takes a light and drops a line. */
const COPING_RISE = 0.025;

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
/** How many times a chunk is rebuilt waiting for terrain. See `retryProvisional`. */
const PROVISIONAL_ATTEMPTS = 4;
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
    lit(assets.cess, false),
    lit(assets.tactile, false),
    lit(assets.brick, true),
    lit(assets.furniture, true),
    // The boundary fence, which casts nothing. `fences.ts`' header works out at
    // length what a 0.9 m palisade's shadow is worth at a 10.7 cm shadow texel
    // and the answer for a 1.8 m mesh fence at 300 km of it is the same one with
    // twice the cost: the mask goes solid in the depth pass, so what a corridor
    // fence would throw is a continuous soft bar down both sides of every
    // railway in Sydney. That is not what a see-through fence does, and paying
    // the whole network's depth-pass cost for it would be paying to be wrong.
    {
      geometry: warmupGeometry({ normal: true, uv: true }),
      material: assets.fence,
      owned: true,
      casts: false,
    },
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
  /**
   * Is this side of this segment the **outside of the corridor**?
   *
   * `open[0]` is the `-1` side and `open[1]` the `+1` side, in the same
   * `(px, pz) = (-uz, ux)` frame every writer here uses. Set once by
   * `markCorridorEdges` and read only by `writeVerge`. See `CORRIDOR_NEIGHBOUR`
   * for what a false answer here would build.
   */
  open: [boolean, boolean];
}

/** A tunnel mouth: where the flags flip between one vertex and the next. */
interface Portal {
  x: number; y: number; z: number;
  /** Unit plan direction, pointing **into** the tunnel. */
  ux: number; uz: number;
}

/**
 * A station as this file draws it: the bake's record, moved to where the trains
 * actually stop, with the track heading there and **the OSM node it came from**.
 *
 * `x, z` is the routed stopping anchor and `nodeX, nodeZ` is the station node,
 * and the two are as much as 248 m apart -- see `buildNetwork`, which spends a
 * page on why the platform goes at the first and not the second. `nodeX, nodeZ`
 * is kept because it is the only thing in the bake that says where the *street*
 * side of a station is: an OSM station node sits at the entrance, not on the
 * track, so the vector from the anchor to the node is the direction a passenger
 * arrives from. `writeStationHouse` is its one reader.
 */
export type PlacedStation = RailStation & {
  ux: number; uz: number;
  nodeX: number; nodeZ: number;
};

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
  stations: PlacedStation[];
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
          open: [true, true],
        });
      }
    }
  }

  markCorridorEdges(segments);

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
        // Merge with an anchor of the same name whose platform this stop already
        // stands at: the up and down roads of one station are two ways a few
        // metres apart and their arc lengths land within a carriage of each
        // other, so they are one platform pair. What must *not* merge is a
        // station whose two directions the router anchored hundreds of metres
        // apart -- and the bake has those: Meadowbank's two are 471 m up the
        // corridor from each other -- nor two platforms of a big station lying
        // side by side across the formation, which a plain radius could not tell
        // from the first case at all. `riding.samePlatform` is the test and its
        // header is the argument; both readers of the bake use it.
        const near = anchors.find((a) => a.name === stop.name && samePlatform(a, at));
        if (near) continue;
        anchors.push({ name: stop.name, ...at });
      }
    }
  }

  const byName = new Map(bake.stations.map((s) => [s.name, s]));
  const stations: PlacedStation[] = [];
  const served = new Set<string>();
  for (const a of anchors) {
    const record = byName.get(a.name);
    if (!record) continue;
    served.add(a.name);
    const index = stations.length;
    stations.push({
      ...record,
      x: a.x, z: a.z, trackY: a.y, ux: a.ux, uz: a.uz,
      nodeX: record.x, nodeZ: record.z,
    });
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
    stations.push({
      ...station,
      ux: segments[best].ux, uz: segments[best].uz,
      nodeX: station.x, nodeZ: station.z,
    });
    bucket(chunks, chunkOf(station.x, station.z)).stations.push(index);
  }

  return { bake, segments, portals, stations, chunks, directedSegments: directed };
}

/**
 * Decide, once, which sides of which segments are the outside of the corridor.
 *
 * ---------------------------------------------------------------------------
 * **The problem, which is not obvious until a fence exists.** The bake carries
 * one polyline per *track*: the up and down roads of a double-track railway are
 * two OSM ways four metres apart and `buildNetwork` deliberately keeps them
 * apart, because both are really there. Nothing before this round cared -- a
 * ballast prism per road is correct, and two of them 4 m apart simply overlap
 * into one formation, which is what a formation looks like. A *fence* per road
 * is not correct. It is a fence down the six-foot of every double-track railway
 * in Sydney, four metres from each rail, and a four-road corridor gets three of
 * them.
 *
 * So a side is fenced only when there is no other running rail on it within
 * `CORRIDOR_NEIGHBOUR`. Three samples per segment rather than one, because a
 * 40 m segment routinely has a neighbour beside half of it -- a loop, a turnout,
 * a platform road -- and the union is the safe direction: a side wrongly called
 * closed loses a fence, a side wrongly called open builds one in the six-foot.
 *
 * ---------------------------------------------------------------------------
 * The broad phase is a 16 m grid, and the containment argument is the one thing
 * in it worth stating: a segment is filed into every cell its plan bounding box
 * **grown by `CORRIDOR_NEIGHBOUR`** touches, so any segment within that distance
 * of a query point is filed in that point's own cell, and the query reads one
 * cell rather than nine. Same construction as `rail-cut.RailCut`'s broad phase
 * and for the same reason.
 *
 * One pass over 19,319 segments at load: about 230k cell insertions and 19,319
 * queries of a few dozen candidates each. Measured at 34 ms in the browser,
 * beside the 60 ms `buildNetwork` already spent, and it happens once.
 */
function markCorridorEdges(segments: Segment[]): void {
  const CELL = 16;
  const cells = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // A bore has no surface expression and cannot close a side: the North Shore
    // line running into a tunnel beside an open cutting must not unfence it.
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    const x0 = Math.floor((Math.min(s.ax, s.bx) - CORRIDOR_NEIGHBOUR) / CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + CORRIDOR_NEIGHBOUR) / CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - CORRIDOR_NEIGHBOUR) / CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + CORRIDOR_NEIGHBOUR) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    const px = -s.uz;
    const pz = s.ux;
    for (const t of [0.15, 0.5, 0.85]) {
      const qx = s.ax + (s.bx - s.ax) * t;
      const qz = s.az + (s.bz - s.az) * t;
      const list = cells.get(key(Math.floor(qx / CELL), Math.floor(qz / CELL)));
      if (list === undefined) continue;
      for (const j of list) {
        if (j === i) continue;
        const o = segments[j];
        // Parallel, or it is a junction crossing rather than a second road, and
        // a crossing must not unfence the corridor it crosses.
        if (Math.abs(s.ux * o.ux + s.uz * o.uz) < 0.9) continue;
        // The neighbour's nearest point, and which side of us it is on.
        const ex = o.bx - o.ax;
        const ez = o.bz - o.az;
        const len2 = ex * ex + ez * ez;
        let u = 0;
        if (len2 > 1e-9) {
          u = ((qx - o.ax) * ex + (qz - o.az) * ez) / len2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
        }
        const lateral = (o.ax + ex * u - qx) * px + (o.az + ez * u - qz) * pz;
        // Half a metre of dead band, so a segment's own duplicate-in-all-but-
        // quantisation -- a bend where two chains meet at a shared vertex -- does
        // not read as a second road lying on top of this one.
        const a = Math.abs(lateral);
        if (a < 0.5 || a > CORRIDOR_NEIGHBOUR) continue;
        s.open[lateral < 0 ? 0 : 1] = false;
      }
    }
  }
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
  /** Chunks rebuilt because their terrain arrived late. See `retryProvisional`. */
  provisionalRebuilds = 0;

  private readonly built = new Map<string, BuiltChunk>();
  /** Chunk keys inside the build radius that have not been built yet. */
  private pending: string[] = [];
  private readonly sleeperMesh: InstancedMesh;
  private readonly cantileverMesh: InstancedMesh;
  private readonly gantryMesh: InstancedMesh;
  private lastChunk = '';
  private lastSleeperCell = '';
  /** Frames since the last idle re-plan. See `update`. */
  private idleFrames = 0;

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
    if (this.pending.length === 0 && ++this.idleFrames >= 60) {
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
        if (this.built.has(key)) continue;
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
    const cess = new Solid();
    const fence = new Solid();
    const tactile = new Solid();
    const brick = new Solid();
    const furniture = new Solid();
    const sleepers: number[] = [];

    // --- Every station whose entrance could reach into this chunk, measured
    //     once, before anything is drawn.
    //
    // Nine chunks rather than one, and that is not caution: a station's stair,
    // its forecourt and the hole it opens in the boundary fence reach about
    // ninety metres from the platform anchor, so a station just over a chunk
    // boundary has to be able to open this chunk's fence. Cheap, because 321
    // stations over 785 chunks means the loop below finds nothing at all in the
    // overwhelming majority of builds.
    const plans: StationPlan[] = [];
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const near = this.net.chunks.get(chunkKey(cx + ox, cz + oz));
        if (near === undefined) continue;
        for (const si of near.stations) {
          plans.push(planStation(this.net, this.net.stations[si], this.rawGround, ox === 0 && oz === 0));
        }
      }
    }

    let wireSpans = 0;
    /** See `BuiltChunk.provisional`: any depth this chunk could not measure. */
    let provisional = false;
    for (const si of chunk.segments) {
      const s = this.net.segments[si];
      // **How deep this span is, honestly.** `rawGround` rather than `ground`:
      // an unknown depth must read as unknown here, not as zero. See the
      // constructor's `rawGround` argument for what a wrong answer costs.
      const depth = this.rawGround((s.ax + s.bx) / 2, (s.az + s.bz) / 2) - (s.ay + s.by) / 2;
      // Bore, trench or grade -- one rule, shared with the carve so the hole and
      // the thing standing in it cannot disagree. See `rail-cut.ts`, which also
      // records the measurement that killed the obvious version of this: reading
      // `SPAN_SUBWAY` as "Metro, therefore tunnel below 6 m" lined the deepest
      // 70 spans of the *open* cutting at Sydenham. Sydney Metro's tunnels all
      // carry `tunnel=yes`; the flag that earns its place is `SPAN_CUTTING`, and
      // `inCutting` is where it is spent.
      const tunnel = drawnAsTunnel(s.flags);
      const bridge = (s.flags & SPAN_BRIDGE) !== 0;
      // A span whose depth is unknown cannot be trenched, and a chunk built
      // without knowing is built again. See `retryProvisional`.
      if (!Number.isFinite(depth) && !tunnel && !bridge) provisional = true;
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
        // And the cutting. The ground over this span has been taken away by
        // `terrain.buildTerrainMesh`; this is the trench that stands in the hole.
        //
        // **Asked of the carve, point by point, rather than of the segment's
        // midpoint.** `inCutting(s.flags, depth)` is one sample at the middle of
        // a forty-metre span, and the carve is a sample every four metres, so
        // the two disagreed along every segment that ran into a bank: ground
        // taken away with no trench built in the hole. See `RailCut.cutsAlong`.
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
        if (carved) writeFormation(ballast, s, this.cut!, this.rawGround);
        if (trenched) {
          if (!writeTrench(concrete, prisms, s, this.cut!, this.rawGround)) provisional = true;
        }
        // ...and the corridor either side of it: the cess and verge where the
        // track is at grade, and the boundary fence everywhere. See `writeVerge`
        // for why a bridge span gets neither.
        if (!bridge) {
          writeVerge(cess, fence, s, this.cut, this.rawGround, trenched, plans);
        }
      }
      if (!tunnel) writeRails(rails, s);
      if (bridge) writeViaduct(concrete, prisms, s, this.ground);
    }

    for (const pi of chunk.portals) writePortal(concrete, lining, this.net.portals[pi]);

    for (const plan of plans) {
      if (!plan.mine) continue;
      // A station planned before its terrain arrived is a station whose stairs
      // are the wrong length. See `StationPlan.measured`.
      if (!plan.measured) provisional = true;
      const station = plan.station;
      if (station.vertical === 'underground') {
        writeUndergroundStation(concrete, lining, prisms, station);
      } else {
        writePlatforms(concrete, canopy, tactile, prisms, plan);
        // **The access, and it is generated rather than looked up.**
        // `RAIL-VERTICAL.md` section 4: the same measurement that made this
        // station need steps is the one that builds them, so a station cannot
        // be left unreachable by an OSM tag nobody wrote. Reported twice --
        // "im at roseville and cant get up to the platform", and a player on
        // the Chatswood plaza reading "doors 23 m away" with no way down.
        writePlatformFurniture(canopy, furniture, plan);
        writeStationAccess(concrete, furniture, prisms, plan);
        writeFootbridge(concrete, furniture, prisms, plan);
        writeStationHouse(brick, canopy, prisms, plan);
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
    add(cess.build(`rail_cess_${key}`), this.assets.cess, 'cess', false, true);
    add(rails.build(`rail_steel_${key}`), this.assets.rail, 'rails', false, true);
    add(concrete.build(`rail_concrete_${key}`), this.assets.concrete, 'concrete', true, true);
    add(lining.build(`rail_lining_${key}`), this.assets.lining, 'lining', false, false);
    add(canopy.build(`rail_canopy_${key}`), this.assets.canopy, 'canopy', true, true);
    add(tactile.build(`rail_tactile_${key}`), this.assets.tactile, 'tactile', false, true);
    add(brick.build(`rail_brick_${key}`), this.assets.brick, 'house', true, true);
    add(furniture.build(`rail_furniture_${key}`), this.assets.furniture, 'furniture', true, true);
    // The boundary fence, with UVs, because the whole object is a mask on them:
    // `u` is metres along the run and `v` metres up the panel, which is exactly
    // what `fences.createFenceOpenMaterial` reads. It casts nothing -- see
    // `railWarmupParts` for the arithmetic behind that.
    add(fence.build(`rail_fence_${key}`, true), this.assets.fence, 'fence', false, true);
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
      provisional,
      attempts: 0,
      sleepers: new Float32Array(sleepers),
      masts: chunk.masts,
      cx,
      cz,
    };
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
    let dropped = 0;
    for (const [key, chunk] of [...this.built]) {
      const x0 = chunk.cx * CHUNK_M;
      const z0 = chunk.cz * CHUNK_M;
      if (x0 > box[2] || x0 + CHUNK_M < box[0] || z0 > box[3] || z0 + CHUNK_M < box[1]) continue;
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
    for (const [key, chunk] of [...this.built]) {
      if (!chunk.provisional || chunk.attempts >= PROVISIONAL_ATTEMPTS) continue;
      if (chunkDistance(chunk.cx, chunk.cz, x, z) > BUILD_RADIUS) continue;
      const attempts = chunk.attempts + 1;
      this.disposeChunk(key, chunk);
      const fresh = this.buildChunk(key, chunk.cx, chunk.cz);
      fresh.attempts = attempts;
      this.built.set(key, fresh);
      this.provisionalRebuilds++;
      // One a transition. A rebuild is the same work as a first build and the
      // frame budget that made `BUILDS_PER_FRAME` two applies here identically.
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
        const deck =
          this.cut === null
            ? Number.NaN
            : this.cut.deckSurfaceAt(mx + -uz * offset, mz + ux * offset);
        if (Number.isFinite(deck) && my - 0.25 + MAST_HEIGHT > deck - DECK_THICKNESS_M) continue;
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
function writeFormation(s: Solid, seg: Segment, cut: RailCut, rawGround: GroundAt): void {
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
      cut: Number.isFinite(g) && g - rail > CUT_MIN_DEPTH,
    });
  }
  const at = (rib: Rib, o: number): [number, number, number] => [
    rib.cx + px * o, rib.y, rib.cz + pz * o,
  ];
  for (let i = 0; i < ribs.length - 1; i++) {
    const a = ribs[i];
    const b = ribs[i + 1];
    if (!a.cut && !b.cut) continue;
    // Wound to face up, which is the only side of it anybody ever sees.
    s.quad(...at(a, -a.half), ...at(b, -b.half), ...at(b, b.half), ...at(a, a.half));
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
): boolean {
  const px = -seg.uz;
  const pz = seg.ux;
  const steps = Math.max(1, Math.round(seg.len / TRENCH_STEP_M));
  // Extended half a metre each end, on `writeBallast`'s argument: consecutive
  // segments are built independently and the overlap is what keeps a bend from
  // leaving a wedge of daylight on the outside of the turn.
  const ext = 0.5;
  let complete = true;

  // One pass to measure, so the two sides can be built as strips.
  interface Station { cx: number; cz: number; rail: number; cess: number }
  const line: Station[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = -ext + t * (seg.len + 2 * ext);
    const cx = seg.ax + seg.ux * along;
    const cz = seg.az + seg.uz * along;
    const rail = seg.ay + (seg.by - seg.ay) * t;
    line.push({ cx, cz, rail, cess: rail - BALLAST_TOP_DROP - BALLAST_DEPTH });
  }

  for (const side of [-1, 1]) {
    interface Rib { rim: number; foot: number; top: number; cess: number; cx: number; cz: number }
    const ribs: Rib[] = [];
    let anyWall = false;
    for (const st of line) {
      // **The widest the corridor gets between this rib and its neighbours**,
      // not the width at the rib itself. The hole's rim follows
      // `halfWidthAt` continuously and the wall is a straight quad between ribs
      // eight metres apart, so at a platform's flare -- which opens four metres
      // over twelve -- a wall built to the rib's own width sits *inside* the rim
      // for most of the panel and leaves a slot of daylight along it. Taking the
      // maximum puts the wall outside the rim instead, where the worst it can do
      // is bury half a metre of itself in ground nobody removed.
      const half = TRENCH_STEP_M / 2;
      const rim = Math.max(
        cut.halfWidthAt(st.cx, st.cz),
        cut.halfWidthAt(st.cx - seg.ux * half, st.cz - seg.uz * half),
        cut.halfWidthAt(st.cx + seg.ux * half, st.cz + seg.uz * half),
      );
      const g = rawGround(st.cx + px * rim * side, st.cz + pz * rim * side);
      let top: number;
      if (Number.isFinite(g)) {
        top = g;
      } else {
        // Not loaded. Build to the depth the *track* says, so the chunk still
        // draws something coherent, and tell the caller it was a guess.
        // `TRENCH_MIN_DEPTH` rather than `CUT_MIN_DEPTH` since the two parted
        // company: this function only runs on a span that has already been
        // judged trenched, so the shallowest wall it could honestly be asked for
        // is the one at the trench floor, and the cut floor is now negative --
        // guessing with it would build every unmeasured wall to nothing.
        complete = false;
        top = st.rail + TRENCH_MIN_DEPTH;
      }
      // **And never up through a road**, which is the abutment case and is what
      // the player was looking at: at King Street, St Peters the retaining wall's
      // own prism stood at -52.5 m -- road level -- with a coping lapping onto
      // the asphalt, so the ground was gone from under the carriageway *and*
      // there were two walls across it. `RailCut` has already declined to carve
      // here, so there is no hole for a wall to retain above the deck; what the
      // wall is now is the thing holding the deck up, and it stops at the soffit.
      // The deck's own underside is drawn by `terrain.buildTerrainMesh`, which is
      // where the kept ground's heights are, so the two meet at one number and
      // that number is `DECK_THICKNESS_M` under the paved surface.
      const deck = cut.deckSurfaceAt(st.cx + px * rim * side, st.cz + pz * rim * side);
      if (Number.isFinite(deck) && deck - DECK_THICKNESS_M < top) top = deck - DECK_THICKNESS_M;
      // Never below the cess: at the taper where a cutting runs out to grade the
      // wall goes to nothing rather than turning inside out.
      if (top < st.cess) top = st.cess;
      const height = top - st.cess;
      if (height > TRENCH_MIN_HEIGHT) anyWall = true;
      const foot = Math.max(TRENCH_FOOT_MIN, rim - TRENCH_BATTER * height);
      ribs.push({ rim, foot, top, cess: st.cess, cx: st.cx, cz: st.cz });
    }
    if (!anyWall) continue;

    const at = (rib: Rib, o: number, y: number): [number, number, number] => [
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
    for (const [rib, flip] of [[ribs[0], true], [ribs[ribs.length - 1], false]] as const) {
      if (rib.top - rib.cess <= TRENCH_MIN_HEIGHT) continue;
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

    // ---------------------------------------------------------------------
    // The collision, **one prism per rib pair** rather than one for the wall.
    //
    // This was one box spanning the whole segment, built from the *lowest* cess
    // and the *highest* terrain over the run, with its four corners taken from
    // the first and last rib. Two failures, and the player met both:
    //
    //   - **A chord is not a wall.** The offsets are perpendicular to the run, so
    //     a segment whose corridor widens -- every one of the two hundred that
    //     runs into a platform flare -- has a wall that bows out where the box
    //     cuts straight across. The gap is up to the four metres the flare opens
    //     by, and standing in it is *"i can pass through that right edge to see
    //     the other bit of the rail line"*.
    //   - **The extremes are not the wall either.** A run-out, where a cutting
    //     climbs back to grade, got a box as tall as its deep end along its whole
    //     length: an invisible wall standing on open ground at the mouth of every
    //     cutting in the city.
    //
    // Per rib pair, both go. Each prism spans exactly the eight metres its two
    // ribs do, at exactly their own feet and rims, and it is emitted only where
    // *that* pair has a wall. Consecutive prisms share their ribs' positions, so
    // there is no seam between them to walk through; consecutive segments overlap
    // by `ext` at each end, which is what covers the bend.
    //
    // It costs about five prisms a segment where there was one. Measured on the
    // shipped bake that is 12,600 trenched segments, so tens of thousands of
    // prisms across the city and about forty in any one 512 m chunk -- against
    // the 1.2 million the pipeline already writes.
    for (let i = 0; i < ribs.length - 1; i++) {
      const a = ribs[i];
      const b = ribs[i + 1];
      const base = Math.min(a.cess, b.cess);
      const top = Math.max(a.top, b.top);
      if (top - base <= TRENCH_MIN_HEIGHT) continue;
      const foot = Math.min(a.foot, b.foot);
      prisms.push({
        points: new Float32Array([
          a.cx + px * foot * side, a.cz + pz * foot * side,
          b.cx + px * foot * side, b.cz + pz * foot * side,
          b.cx + px * (b.rim + TRENCH_COPING) * side, b.cz + pz * (b.rim + TRENCH_COPING) * side,
          a.cx + px * (a.rim + TRENCH_COPING) * side, a.cz + pz * (a.rim + TRENCH_COPING) * side,
        ]),
        height: top + TRENCH_COPING_RISE - base,
        base,
      });
    }
  }
  return complete;
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

// --- Working in the track's own frame -------------------------------------------
//
// Everything from here down is written in `(t, o, y)`: metres **along** the run,
// metres **across** it, and metres up. The map into the world is a rotation
// about Y, which preserves handedness, so a box emitted here has exactly the
// winding `Solid.box` gives an axis-aligned one -- and that matters, because a
// `FrontSide` material culls by winding and the one thing this file has already
// shipped as a bug is a mirrored frame quietly reversing it. See `writeTrench`'s
// `face`, which is the same hazard solved the other way for strips.

type Prisms = Array<{ points: Float32Array; height: number; base: number }>;

/** Anything with a position and a unit heading: a station, or a segment's end. */
interface TrackFrame {
  x: number; z: number; ux: number; uz: number;
}

function framePoint(f: TrackFrame, t: number, o: number, y: number): [number, number, number] {
  return [f.x + f.ux * t - f.uz * o, y, f.z + f.uz * t + f.ux * o];
}

/** The plan rectangle of a frame box, as the ring `addPrisms` wants. */
function framePlan(f: TrackFrame, t0: number, t1: number, o0: number, o1: number): Float32Array {
  const a = framePoint(f, t0, o0, 0);
  const b = framePoint(f, t1, o0, 0);
  const c = framePoint(f, t1, o1, 0);
  const d = framePoint(f, t0, o1, 0);
  return new Float32Array([a[0], a[2], b[0], b[2], c[0], c[2], d[0], d[2]]);
}

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

/** A box in the track frame, between two corners. */
function frameBox(
  s: Solid, f: TrackFrame,
  t0: number, t1: number, o0: number, o1: number, y0: number, y1: number,
): void {
  frameBar(s, f, t0, t1, o0, o1, Math.min(y0, y1), Math.min(y0, y1), Math.abs(y1 - y0));
}

/** A box, and the prism that makes it solid. Base semantics are section 4's. */
function frameSolid(
  s: Solid, prisms: Prisms, f: TrackFrame,
  t0: number, t1: number, o0: number, o1: number, y0: number, y1: number,
): void {
  frameBox(s, f, t0, t1, o0, o1, y0, y1);
  const base = Math.min(y0, y1);
  prisms.push({ points: framePlan(f, t0, t1, o0, o1), height: Math.abs(y1 - y0), base });
}

// --- What a station is, measured ---------------------------------------------------

/**
 * A station reduced to the numbers the geometry needs, **all of them measured**.
 *
 * `RAIL-VERTICAL.md` sections 1 and 4, applied: nothing below reads
 * `station.vertical` except to tell a bore from open air, because the label has
 * been wrong at every station anybody has complained about -- Chatswood is
 * `elevated` with its track 6.9 m *under* the terrain, and the geometry that
 * believed it built a platform slab floating in a hole with no legs and no way
 * in. What is read instead is `rawGround` beside the platform, on each side
 * separately, because the two sides of a corridor are routinely at different
 * levels and a single number per station cannot say so.
 */
interface StationPlan {
  station: PlacedStation;
  /** Built into this chunk, rather than only consulted for its fence opening. */
  mine: boolean;
  /** The platform deck. */
  top: number;
  /** What the platform's skirt stands on. */
  base: number;
  /**
   * Is the track carried on a deck here? **Measured off the spans**, not off
   * `vertical`: a station whose own segments carry `SPAN_BRIDGE` stands on a
   * viaduct that is already built, and one that does not needs a skirt to the
   * ground however the bake labelled it.
   */
  onBridge: boolean;
  /**
   * Ground at the stair's landing, **by side and by end**: `[side][end]`, with
   * index 0 the `-1` side and index 0 the `+1` end of the run.
   *
   * ---------------------------------------------------------------------------
   * **Four numbers, and it was two.** `writeStationAccess` builds a flight at
   * each end of each platform, and both of a side's flights were sized from a
   * single reading of the terrain taken at `+ACCESS_ALONG + 8` -- one end. Where
   * the ground along a platform is not level, and it never is, the far flight
   * was built to the near flight's height: its bottom tread stopped short of the
   * ground by the difference, and a tread out of reach is a wall with a stair
   * drawn on it.
   *
   * Measured at Roseville, walking it: the flight at `t = +44` climbs 39.10 to
   * 41.93 in nineteen-centimetre risers and arrives; the flight at `t = -44`
   * stands on ground at 37.80 with its lowest tread at 39.09, which is a
   * 1.29 m step against a `STEP_HEIGHT` of 0.42. Reported as *"i can get up 1/3
   * sets of stairs at roseville"*.
   */
  landing: [[number, number], [number, number]];
  /** The flight's run in metres, by side and end. Zero where the deck is already walkable. */
  run: [[number, number], [number, number]];
  /**
   * Was every height in this plan actually measured?
   *
   * False where `rawGround` had no tile under the landing and the plan fell back
   * to the bake's own `groundY`. It matters more here than anywhere else in this
   * file: a station planned blind gets a flight sized from a height taken at the
   * OSM node, which at Roseville is 2.9 m out, and the result is a staircase
   * that stops short of the ground -- a station that is drawn as reachable and
   * is not. `buildChunk` turns this into `BuiltChunk.provisional` and the chunk
   * is planned again once its tiles land.
   */
  measured: boolean;
  /** Which side of the track the OSM station node is on, and where along it. */
  houseSide: number;
  houseAlong: number;
  /**
   * How far out the station building had to be pushed to get out of a track's
   * way, metres, and which side it ended on.
   *
   * See `clearOfTrack`. Zero at the overwhelming majority of stations.
   */
  housePush: number;
  /**
   * Which sides may carry a platform at all: `[-1 side, +1 side]`.
   *
   * **Reported as *"the roseville station is shown as a brick building which is
   * solid, that the train must pass through"*, and it is not the building.** A
   * platform is built 1.62 m off the anchor's centreline on *both* sides,
   * unconditionally, and an anchor on a four-road formation has running lines
   * four to seven metres away -- inside the slab. Measured at Roseville: rails
   * at -5, -3, -1, 0, +4, +5, +6 and +7 m from the platform axis, against a slab
   * that occupies 1.62 to 7.12 m on each side. The train passes through the
   * platform, and from a carriage window a platform is a solid box.
   *
   * So a side is built only where the strip it wants is clear of every *other*
   * track's loading gauge. Both sides blocked leaves the less-blocked one --
   * `writePlatforms` is where that tie is broken -- because a station with no
   * platform at all is a worse answer than a station with one that grazes.
   */
  sideClear: [boolean, boolean];
  /**
   * The terrain under the station building, sampled at the building rather than
   * at the stair.
   *
   * A separate reading and not `landing`, because it was one first and the
   * building hung in the air at Roseville: the landing is forty metres up the
   * platform and three metres in from the building, and on an embankment those
   * are different heights. Anything that stands on the ground has to have asked
   * the ground where it is.
   */
  houseGround: number;
}

function planStation(
  net: RailNetwork,
  station: PlacedStation,
  rawGround: GroundAt,
  mine: boolean,
): StationPlan {
  const top = station.trackY + PLATFORM_HEIGHT;

  // Is there a deck under this? The station's own chunk holds every segment
  // whose midpoint is in it, which at 512 m is every span of the approach.
  let onBridge = false;
  const own = net.chunks.get(chunkOf(station.x, station.z));
  if (own) {
    for (const si of own.segments) {
      const s = net.segments[si];
      if ((s.flags & SPAN_BRIDGE) === 0) continue;
      if (pointSegmentDistanceSquared(station.x, station.z, s) < 45 * 45) {
        onBridge = true;
        break;
      }
    }
  }

  const landing: [[number, number], [number, number]] = [[top, top], [top, top]];
  const run: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  let measured = true;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const o = ((STAIR_INNER + STAIR_OUTER) / 2) * side;
    for (let e = 0; e < 2; e++) {
      const end = e === 0 ? 1 : -1;
      // Sampled at the middle of where *this* flight will be, which is a chicken
      // and an egg -- the run depends on the drop and the drop is sampled along
      // the run -- and is resolved by sampling at a fixed eight metres past the
      // stair head and letting the flight be as long as that one reading says. A
      // DEM post is 31 m, so every sample one flight could have taken is the
      // same post; the two *ends* of a 160 m platform are four posts apart, which
      // is the whole reason this loop has four iterations and not two.
      const p = framePoint(station, (ACCESS_ALONG + 8) * end, o, 0);
      let g = rawGround(p[0], p[2]);
      if (!Number.isFinite(g)) {
        measured = false;
        g = station.groundY;
      }
      if (!Number.isFinite(g)) g = top;
      landing[i][e] = g;
      const drop = Math.abs(top - g);
      // `STAIR_FLAT` is `controller.STEP_HEIGHT`: below it a body walks up
      // without being told, and a flight would be six centimetres of theatre.
      if (drop <= STAIR_FLAT) continue;
      const steps = Math.min(STAIR_MAX_STEPS, Math.round(drop / STAIR_RISE));
      run[i][e] = steps * STAIR_GOING;
    }
  }

  // The skirt. On a deck the viaduct is already there and the platform is a slab
  // on top of it; otherwise it runs to the ground, which on an embankment is the
  // retaining wall a real one has and in a cutting is a face against the trench.
  // Bounded at 14 m so a genuine viaduct station whose bridge flag went missing
  // is a tall platform rather than a 40 m blank wall.
  const groundish = Math.min(landing[0][0], landing[0][1], landing[1][0], landing[1][1], station.trackY);
  const base = onBridge ? top - 1.4 : Math.max(top - 14, groundish - 0.4);

  // Which way the street is. An OSM station node sits at the *entrance*, and
  // `buildNetwork` moved the platform to the stopping anchor without throwing
  // the node away for exactly this.
  const dx = station.nodeX - station.x;
  const dz = station.nodeZ - station.z;
  const along = dx * station.ux + dz * station.uz;
  const across = dx * -station.uz + dz * station.ux;
  const far = dx * dx + dz * dz > 250 * 250;
  let houseSide = !far && across < 0 ? -1 : 1;
  const houseAlong = far ? -18 : Math.max(-62, Math.min(62, along));

  // --- Nothing this station builds may stand in another track's way ----------
  //
  // See `StationPlan.sideClear`. The measurement that forced it is Roseville's:
  // an anchor with running lines four to seven metres off its own centreline,
  // and a platform slab that occupies exactly that strip on both sides.
  const sideClear: [boolean, boolean] = [
    trackClear(net, station, -L_PLATFORM, L_PLATFORM, PLATFORM_INNER, STAIR_OUTER, -1),
    trackClear(net, station, -L_PLATFORM, L_PLATFORM, PLATFORM_INNER, STAIR_OUTER, 1),
  ];

  // And the station building, which is the one thing here that can simply be
  // moved: it has no relationship to the platform beyond being beside it, so
  // where the strip it wants carries a track, it is pushed further out -- and
  // failing that, put on the other side. Reported as *"the actual roseville
  // station is shown as a brick building which is solid, that the train must
  // pass through"*, which at that anchor is a house at 13.85 m over rails at
  // 11, 13 and 14.
  let housePush = 0;
  const houseInner = STAIR_OUTER + 1.2;
  const houseFits = (side: number, push: number): boolean =>
    trackClear(
      net, station,
      houseAlong - HOUSE_LENGTH / 2 - 0.5, houseAlong + HOUSE_LENGTH / 2 + 0.5,
      houseInner + push, houseInner + push + HOUSE_WIDTH + HOUSE_AWNING, side,
    );
  if (!houseFits(houseSide, 0)) {
    let placed = false;
    for (const side of [houseSide, -houseSide]) {
      for (const push of [0, 3, 6, 9, 12]) {
        if (!houseFits(side, push)) continue;
        houseSide = side;
        housePush = push;
        placed = true;
        break;
      }
      if (placed) break;
    }
    // Nowhere clear within twelve metres of either side. Take the far side of
    // the formation anyway and push the full distance: a building a little way
    // off the forecourt is a nuisance, and one with a railway through it is the
    // bug. Named in `verifyRailGeometry`.
    if (!placed) housePush = 12;
  }

  const hp = framePoint(station, houseAlong, (houseInner + housePush + HOUSE_WIDTH / 2) * houseSide, 0);
  const hg = rawGround(hp[0], hp[2]);
  return {
    station, mine, top, base, onBridge, landing, run, measured,
    houseSide, houseAlong, housePush, sideClear,
    houseGround: Number.isFinite(hg) ? hg : landing[houseSide < 0 ? 0 : 1][0],
  };
}

/** `PLATFORM_HALF_LENGTH`, named for `planStation`'s own arithmetic. */
const L_PLATFORM = PLATFORM_HALF_LENGTH;

/**
 * Is the strip `[t0, t1] x [o0, o1]` on `side` of this station clear of every
 * track but the station's own?
 *
 * ---------------------------------------------------------------------------
 * **`world/envelope.RAIL_HALF_M` is the width, and that is the point of this
 * function**: the loading gauge is the one statement in the build of how much
 * room a train needs, and a station is the place most likely to build something
 * inside it. The test is per rail segment rather than per envelope query because
 * what is being asked is not "is this point clear" but "is this whole rectangle
 * clear", and a rectangle against a swept strip is a handful of point-segment
 * distances where the point query would be a grid of them.
 *
 * A track is *this* station's own when it runs within `OWN_TRACK_M` of the
 * anchor's centreline: a platform is built against its own formation by
 * definition, and a test that counted it would refuse every platform in Sydney.
 */
function trackClear(
  net: RailNetwork,
  f: TrackFrame & { x: number; z: number },
  t0: number, t1: number, o0: number, o1: number, side: number,
): boolean {
  const chunk = net.chunks.get(chunkOf(f.x, f.z));
  if (chunk === undefined) return true;
  // Sampled along the strip rather than solved: eight metres is a quarter of the
  // shortest segment in the bake and a tenth of what a platform is long.
  const steps = Math.max(2, Math.ceil((t1 - t0) / 8));
  for (const si of chunk.segments) {
    const s = net.segments[si];
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    // Its offset from this station's own axis, at its own midpoint.
    const mx = (s.ax + s.bx) / 2 - f.x;
    const mz = (s.az + s.bz) / 2 - f.z;
    const own = Math.abs(mx * -f.uz + mz * f.ux);
    if (own < OWN_TRACK_M) continue;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + ((t1 - t0) * i) / steps;
      for (const o of [o0, (o0 + o1) / 2, o1]) {
        const p = framePoint(f, t, o * side, 0);
        if (pointSegmentDistanceSquared(p[0], p[2], s) < RAIL_HALF_M * RAIL_HALF_M) return false;
      }
    }
  }
  return true;
}

/**
 * How far off a station's own centreline a rail is still the station's own.
 *
 * Two metres: a platform's inner face is at 1.62 m, so anything inside this is
 * the road the platform is built against and cannot be an obstruction to it.
 */
const OWN_TRACK_M = 2.0;

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
    flags: SPAN_TUNNEL, len: 15.5, ux, uz, open: [false, false],
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
/**
 * Which sides of this station carry a platform. **Both, for now.**
 *
 * ---------------------------------------------------------------------------
 * `StationPlan.sideClear` measures something real and this function deliberately
 * does not act on it yet. The measurement: a platform is built 1.62 m off the
 * anchor's centreline on both sides, and at Roseville there are running lines
 * at -5, -3, +4, +5, +6 and +7 m from that axis -- inside the slab. The train
 * passes through the platform, and about a hundred anchors on four-road
 * formations are the same.
 *
 * Suppressing the blocked side was tried and reverted the same hour, by walking
 * it. `game/riding.PlatformField` -- the analytic copy of the platform that
 * **the server** holds and that `groundHeightAt` prefers over the terrain --
 * answers for both sides of every site unconditionally, from the bake, with no
 * notion of a side at all. Not drawing one leaves a platform that is still a
 * floor on both ends of the wire and is invisible, which is a worse bug than the
 * one being fixed and is exactly the class of bug -- geometry and field
 * disagreeing about a surface -- that `PlatformField` was written to end.
 *
 * The honest fix is for `buildPlatforms` to decide the side, from the bake,
 * where both ends can see it, and for this to follow. Until then `sideClear` is
 * computed, carried on the plan, and not obeyed -- kept rather than deleted
 * because the measurement is the expensive half and it is right.
 */
function platformSides(_plan: StationPlan): number[] {
  return [-1, 1];
}

function writePlatforms(
  concrete: Solid,
  canopy: Solid,
  tactile: Solid,
  prisms: Prisms,
  plan: StationPlan,
): void {
  const f = plan.station;
  const top = plan.top;
  const base = plan.base;
  const L = PLATFORM_HALF_LENGTH;

  for (const side of platformSides(plan)) {
    const inner = PLATFORM_INNER;
    const outer = PLATFORM_INNER + PLATFORM_WIDTH;
    /**
     * How far the *drawn* deck reaches, which is further than the platform is.
     *
     * `game/riding.PLATFORM_OUTER_M` and the whole of the report
     * *"i also cant seem to stand on top of ANY platforms"*: the terrain carve
     * opens to `STATION_HALF_WIDTH` at a platform site and the deck stopped at
     * `outer`, leaving 2.28 m of open trench down the back of every platform in
     * the city -- 304 of 358 sites, 221,658 m2, up to 16 m deep. A body walking
     * at a platform fell into it and could not climb the 1.05 m face out again.
     *
     * Drawn to the same number the field stands bodies on, which is the same
     * number the carve opens, because any two of those three being different is
     * the slot again. Everything below -- coping, tactile, canopy -- stays on
     * `outer`, because those are about the platform a passenger uses and this is
     * about the ground under their feet.
     */
    const deckOuter = PLATFORM_OUTER_M;

    // The deck, as one solid box rather than five loose quads.
    //
    // **This also fixes a face that was culled.** The five quads it replaces
    // were emitted in one winding for both sides of the track, and a mirrored
    // frame reverses handedness -- `writeTrench` spends a paragraph on exactly
    // this hazard and solves it for strips. So the platform *face*, described in
    // the line it replaced as "the one surface of a station a passenger ever
    // looks straight at", was invisible on one of the two platforms at every
    // station in Sydney. `frameBar` sorts its extents, so it cannot happen here.
    frameSolid(concrete, prisms, f, -L, L, inner * side, deckOuter * side, base, top);

    // The coping: a 25 mm lip along the platform edge.
    //
    // It is the smallest object in this file and it earns its six quads for the
    // reason `fences.COPING` gives about a garden wall -- what makes an edge
    // read at distance is a light line with a dark one under it, and without it
    // a platform and the ballast beside it are two grey rectangles that meet.
    frameBox(concrete, f, -L, L, inner * side, (inner + 0.14) * side, top, top + COPING_RISE);

    // ...and the tactile strip, which is the thing everybody actually looks at.
    //
    // A 6 mm lid rather than a coplanar inlay: two surfaces at the same height
    // is a z-fight down 160 m of platform, and six millimetres is under the
    // depth buffer's argument and over its precision. AS 1428.4's real strip
    // starts one tile back from the edge, which is what `TACTILE_INSET` is.
    frameBox(
      tactile, f, -L, L,
      (inner + TACTILE_INSET) * side, (inner + TACTILE_INSET + TACTILE_WIDTH) * side,
      top, top + 0.006,
    );

    // Canopy: a flat roof on four posts over the middle third. Enough to say
    // "station" from the train and cheap enough to build at all 195 of them.
    const C = CANOPY_HALF_LENGTH;
    const rise = top + CANOPY_HEIGHT;
    frameBox(
      canopy, f, -C, C,
      (inner - CANOPY_OVERHANG) * side, (outer + CANOPY_OVERHANG) * side,
      rise - 0.28, rise,
    );
    for (const t of [-C + 3, -C / 3, C / 3, C - 3]) {
      const o = ((inner + outer) / 2) * side;
      frameBox(canopy, f, t - 0.11, t + 0.11, o - 0.11, o + 0.11, top, rise - 0.28);
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
  const back = PLATFORM_INNER + PLATFORM_WIDTH;

  for (const side of platformSides(plan)) {
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
function writeStairs(
  s: Solid,
  prisms: Prisms,
  f: TrackFrame,
  o0: number, o1: number,
  tA: number, yA: number,
  tB: number, yB: number,
  baseY: number,
): number {
  const drop = Math.abs(yB - yA);
  if (drop <= STAIR_FLAT) return 0;
  const n = Math.min(STAIR_MAX_STEPS, Math.max(2, Math.round(drop / STAIR_RISE)));
  const dt = (tB - tA) / n;
  const dy = (yB - yA) / n;
  for (let k = 0; k < n; k++) {
    const t0 = tA + dt * k;
    const t1 = tA + dt * (k + 1);
    const tread = Math.max(yA + dy * k, yA + dy * (k + 1));
    frameSolid(s, prisms, f, t0, t1, o0, o1, baseY, tread);
  }
  return n;
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
  prisms: Prisms,
  plan: StationPlan,
): void {
  const f = plan.station;
  // Only where there is a platform to climb onto. See `platformSides`.
  for (const side of platformSides(plan)) {
    const i = side < 0 ? 0 : 1;
    const o0 = STAIR_INNER * side;
    const o1 = STAIR_OUTER * side;

    // **One flight at each end**, and the second one is not symmetry for its own
    // sake. A 160 m platform with a single six-metre stair on it is a station a
    // player can walk the whole length of without finding the way in -- which is
    // what a reconnaissance pass reported at Roseville *after* the first flight
    // was built: "a 2.5 m retaining wall with palisade and no gate, stair or
    // ramp anywhere along it". The flight was there. It was 44 m up the platform
    // and it may as well not have been. Two of them, one at each end, is what
    // every real station of this size has and it costs forty triangles.
    for (const end of [1, -1]) {
      // **This flight's own ground, at this flight's own end.** See
      // `StationPlan.landing`: sharing one reading between the two ends is what
      // left three of Roseville's four flights with their bottom tread in the
      // air.
      const e = end > 0 ? 0 : 1;
      const run = plan.run[i][e];
      const street = plan.landing[i][e];
      const baseY = Math.min(plan.top, street, plan.base) - 0.5;
      const head = ACCESS_ALONG * end;
      // **The landing at the platform end used to be built here and is now the
      // deck itself.** `writePlatforms` draws to `PLATFORM_OUTER_M`, which is
      // `STAIR_OUTER`, so the slab this used to add is coplanar with the deck
      // over its whole footprint -- the same top over the same 2.16 x 2.6 m, four
      // times a station, which is a z-fight and not a landing. What it was for is
      // still true and is still there; it is simply no longer a separate box.
      if (run <= 0) continue;

      const foot = head + run * end;
      writeStairs(concrete, prisms, f, o0, o1, head, plan.top, foot, street, baseY);
      // And a landing at the foot, so the bottom tread lands on something flat
      // even where the terrain under it is not.
      frameSolid(concrete, prisms, f, foot, foot + 2.6 * end, o0, o1, baseY, street);
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
  prisms: Prisms,
  plan: StationPlan,
): void {
  if (plan.station.platforms < 2) return;
  const f = plan.station;
  const deck = plan.station.trackY + BRIDGE_CLEAR;
  const ground = Math.max(plan.landing[0][0], plan.landing[0][1], plan.landing[1][0], plan.landing[1][1]);
  if (deck - ground < BRIDGE_MIN_OVER_GROUND) return;

  const rise = deck - plan.top;
  if (rise <= STAIR_FLAT) return;
  const run = Math.min(STAIR_MAX_STEPS, Math.round(rise / STAIR_RISE)) * STAIR_GOING;
  // The flights stand on the platforms, which is where a real one's do -- and
  // they stand at the **back** of them. Put in front, against the tactile, they
  // read as a wall along the platform edge and leave a passenger walking round
  // the yellow line to get past, which is the one place on a platform nobody
  // should be sent. Behind, the whole 3.1 m of platform in front of them is
  // clear the length of the station.
  const s1 = PLATFORM_INNER + PLATFORM_WIDTH - 0.4;
  const s0 = s1 - 2.0;

  // The deck, spanning between the two stair heads. `base` is its soffit, so a
  // body under it is under it -- `player/collision.ts` has honoured that since
  // the walk-under round and it is what makes a viaduct a viaduct.
  frameBox(concrete, f, BRIDGE_ALONG, BRIDGE_ALONG + BRIDGE_RUN, -s1, s1, deck - BRIDGE_DECK, deck);
  prisms.push({
    points: framePlan(f, BRIDGE_ALONG, BRIDGE_ALONG + BRIDGE_RUN, -s1, s1),
    height: BRIDGE_DECK + 0.6,
    base: deck - BRIDGE_DECK,
  });
  for (const t of [BRIDGE_ALONG, BRIDGE_ALONG + BRIDGE_RUN]) {
    frameBox(furniture, f, t - 0.05, t + 0.05, -s1, s1, deck, deck + BRIDGE_RAIL_H);
  }

  for (const side of [-1, 1]) {
    const o0 = s0 * side;
    const o1 = s1 * side;
    writeStairs(
      concrete, prisms, f, o0, o1,
      BRIDGE_ALONG, deck, BRIDGE_ALONG - run, plan.top,
      plan.top - 0.2,
    );
    for (const o of [o0, o1]) {
      writeBalustrade(furniture, f, BRIDGE_ALONG, deck, BRIDGE_ALONG - run, plan.top, o, BRIDGE_RAIL_H);
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
  prisms: Prisms,
  plan: StationPlan,
): void {
  const f = plan.station;
  const side = plan.houseSide;
  const t = plan.houseAlong;
  const o = (STAIR_OUTER + 1.2 + plan.housePush + HOUSE_WIDTH / 2) * side;
  const y = plan.houseGround;
  const t0 = t - HOUSE_LENGTH / 2;
  const t1 = t + HOUSE_LENGTH / 2;
  const o0 = o - (HOUSE_WIDTH / 2) * side;
  const o1 = o + (HOUSE_WIDTH / 2) * side;

  frameSolid(brick, prisms, f, t0, t1, o0, o1, y - 2.5, y + HOUSE_HEIGHT);
  // A parapet, which is what a 1920s station building has instead of eaves.
  frameBox(brick, f, t0 - 0.2, t1 + 0.2, o0 - 0.2 * side, o1 + 0.2 * side, y + HOUSE_HEIGHT, y + HOUSE_HEIGHT + 0.35);
  // The awning over the footpath, on the street face. The one thing that makes
  // this read as a station entrance rather than as a substation.
  frameBox(
    canopy, f, t0 - 0.5, t1 + 0.5,
    o1, o1 + HOUSE_AWNING * side,
    y + 2.85, y + 3.05,
  );
  for (const e of [t0 + 0.4, t1 - 0.4]) {
    frameBox(canopy, f, e - 0.06, e + 0.06, o1 + (HOUSE_AWNING - 0.15) * side, o1 + HOUSE_AWNING * side, y, y + 2.85);
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
function writeVerge(
  cess: Solid,
  fence: Solid,
  seg: Segment,
  cut: RailCut | null,
  rawGround: GroundAt,
  trenched: boolean,
  plans: readonly StationPlan[],
): void {
  const px = -seg.uz;
  const pz = seg.ux;
  const steps = Math.max(1, Math.round(seg.len / VERGE_STEP_M));
  const ext = 0.4;

  for (const side of [-1, 1]) {
    if (!seg.open[side < 0 ? 0 : 1]) continue;
    interface Rib {
      cx: number; cz: number; fx: number; fz: number;
      o: number; formation: number; verge: number; foot: number;
      u: number; open: boolean;
    }
    const ribs: Rib[] = [];
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
      // cutting that is the street ten metres over the formation, which is
      // where a corridor fence goes and is the whole reason this is not
      // measured from the rail. Bounded either way, so one wild DEM post cannot
      // put a fence panel thirty metres in the air.
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
      // at a road bridge -- that is what the parapet is for -- and the mechanism
      // for stopping it already exists here: a rib that is `open` gets no panel.
      // Same rule, second reason, exactly as the carve itself.
      //
      // **Gated on the panel's own head against the soffit**, on `refillMasts`'
      // terms and for the same measured reason: a road *viaduct* ten metres over
      // a corridor is a deck too, and a fence standing on the ground under one is
      // a real fence with real headroom. What must go is the panel that would
      // come through the carriageway, which is the one whose foot is the kept
      // ground the road is drawn on.
      const deckY = cut === null ? Number.NaN : cut.deckSurfaceAt(fx, fz);
      const decked = Number.isFinite(deckY) && foot + FENCE_HEIGHT > deckY - DECK_THICKNESS_M;
      ribs.push({
        cx, cz, fx, fz, o, formation, verge, foot, u,
        open: decked || entranceOpens(plans, fx, fz),
      });
    }

    // `writeTrench`'s own hazard, in its own words: `px * o * side` mirrors the
    // frame, a mirror reverses handedness, and the same four corners in the same
    // order give one side its normal and the other side the opposite of it. The
    // verge is a `FrontSide` strip and would be culled on one whole side of
    // every railway in Sydney without this.
    const at = (rib: Rib, o: number, y: number): [number, number, number] => [
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
      if (!trenched) {
        face(
          at(a, CESS_INNER, a.formation),
          at(b, CESS_INNER, b.formation),
          at(b, b.o, b.verge),
          at(a, a.o, a.verge),
        );
      }
      if (a.open && b.open) continue;
      // The fence panel. Double-sided, so the winding above does not apply and
      // is not repeated: see `fences.createRailFenceMaterial`.
      const p0 = at(a, a.o, a.foot);
      const p1 = at(b, b.o, b.foot);
      const p2 = at(b, b.o, b.foot + FENCE_HEIGHT);
      const p3 = at(a, a.o, a.foot + FENCE_HEIGHT);
      fence.quad(
        ...p0, ...p1, ...p2, ...p3,
        [a.u, 0, b.u, 0, b.u, FENCE_HEIGHT, a.u, FENCE_HEIGHT],
      );
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
