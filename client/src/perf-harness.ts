/**
 * The CPU half of a browser frame, measured without a browser.
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists, and why it is not a screenshot loop
 *
 * The server tick has `server/tick-profile.ts`: a driver that builds a real
 * `Simulation` against the real world and steps it a thousand times with no
 * socket in sight, so "the tick costs 0.20 ms at eight players" is a command
 * anybody can run rather than a thing somebody once saw. The frame had no such
 * thing, and the reason given was always that a frame needs a GPU.
 *
 * It does not -- not the half that is regressing. Every renderer in `world/` is
 * the same shape: a pure CPU pass that walks whatever is near the camera, writes
 * instance matrices and bone rotations, and raises `needsUpdate`. The GPU work
 * begins at `renderer.render`. Everything before it -- which on this client is
 * fourteen of the nineteen sections in `client/src/frameprofile.ts` -- is
 * ordinary JavaScript over ordinary typed arrays, and it runs under bun exactly
 * as it runs in Chrome. Three's `InstancedMesh`, `BufferGeometry`, `Matrix4` and
 * the node materials all construct without a device; only `renderer.render`
 * needs one, and `renderer.render` is not what this file is for.
 *
 * So this is `tick-profile.ts`'s sibling: `bun run client/src/perf-harness.ts`
 * builds the real renderers against the real `.lanes.bin` tiles off disk, steps
 * them N times with a scripted camera at three places in Sydney, and prints the
 * same section table the `?perf=1` strip shows. It is repeatable, it is free,
 * and it is the thing that makes "the crowd got 30% cheaper" a number rather
 * than an impression.
 *
 * ---------------------------------------------------------------------------
 * ## What it covers, and -- more importantly -- what it does not
 *
 * Covered, with the real objects and the real world data:
 *
 *   - `traffic`  -- `TrafficMovers` over a `TrafficField` adopted from the
 *     shipped `.lanes.bin` sidecars, through the identical `decodeLanes` the
 *     server reads them with (`server/world.ts`).
 *   - `crowd`    -- `PedestrianCrowd` over a `PedestrianField` adopted from the
 *     same bytes, which is where the footpath bands come from in the game.
 *   - `police`   -- `PoliceSquad`, `StreetCrowd`, `CharacterCrowd`,
 *     `WildlifeFlock` and `EventScene`, all five over the same field.
 *   - `lights`   -- `NightLights` against a synthetic `LampSource` (see below).
 *   - `heat`     -- `HighwayPatrolFleet` and `Polair`.
 *   - `actors`   -- a pool of real `CharacterActor`s posed on the frame delta,
 *     standing in for the fighters, the dummies and the remotes.
 *
 * **Not** covered, and each omission is a deliberate one rather than an
 * oversight, because a harness that quietly measures a subset and calls it the
 * frame is worse than no harness:
 *
 *   - `render` -- needs a device. That is the point of the split.
 *   - `plates` -- `NameplateField` builds a `CanvasTexture` off
 *     `document.createElement('canvas')` in its constructor. Stubbing a canvas
 *     would measure the stub.
 *   - `stream`, `sky`, `rail`, `hud`, `sim`, `camera`, `bikes`, `npcvoice`,
 *     `teams`, `present` -- these are either DOM, or the streamer's fetch path,
 *     or logic that lives in `main.ts`'s closure rather than in a module. They
 *     are measured by the `?perf=1` strip in a real session and are named here
 *     so the absence is visible in the output rather than inferred from it.
 *   - the near-field car models (`world/carlod.ts`) -- 2.4 MB of glTF over
 *     `fetch`, which does not resolve against the filesystem under bun. The box
 *     fleet is measured; the model sweep is not.
 *
 * The table prints `-- not covered --` for every section in the second list, so
 * a reader can never mistake this for the whole frame.
 *
 * ---------------------------------------------------------------------------
 * ## The three scenes
 *
 * From the brief, and each is chosen because it loads a *different* half of the
 * frame:
 *
 *   1. **the spawn park** -- Hyde Park at midday. The crowd and the ambient
 *      events at their densest, the traffic at arterial density, no lights.
 *   2. **a CBD street at night** -- George Street at 21:30. Everything above
 *      plus the night rig, the lit sprites and the near-field cars.
 *   3. **a five-star chase at night** -- the same street with Polair up, six
 *      highway patrol cars, four officers and the street factions promoted,
 *      which is the worst case the game can currently produce.
 *
 * The camera walks rather than stands: 4 m/s forward with a slow yaw sweep, so
 * every renderer's "did the near set change" fast path is exercised the way a
 * player exercises it. A stationary camera measures the cheap case and reports
 * it as the answer, which is how a renderer that rebuilds its whole set on
 * every camera move ships.
 *
 * ---------------------------------------------------------------------------
 * ## The synthetic parts, named
 *
 * Two inputs are not real, and both are called out where they are built:
 *
 *   - **the lamp source.** In the game `NightLights` asks `TileStreamer` for the
 *     nearest luminaires, which come off each tile's `power.bin`. Without the
 *     streamer this file hands it a grid of lamps at real Sydney spacing (30 m,
 *     both sides, over a 600 m box). What that measures honestly is the *search*
 *     -- which is what the night rig's per-frame cost actually is.
 *   - **the actor roster.** In the game `policeField()` is a `FactionField` the
 *     offline simulation steps or a mirror the server fills. Stepping a
 *     `FactionField` here would be measuring `server/sim.ts`, which belongs to
 *     the tick profile and not to this one, so the roster is built directly: a
 *     fixed cast of the right kinds in the right places. The *renderers* cannot
 *     tell the difference, which is the only thing being measured.
 *
 * ---------------------------------------------------------------------------
 * ## Running it
 *
 *   bun run client/src/perf-harness.ts                # 600 frames, all scenes
 *   bun run client/src/perf-harness.ts --frames 2000
 *   bun run client/src/perf-harness.ts --scene chase
 *   SYDNEY_WORLD=/path/to/world bun run client/src/perf-harness.ts
 *
 *   bun run client/src/perf-harness.ts --coverage     # the warm-up audit alone
 *
 * `--coverage` runs in about two seconds and **exits non-zero** on any of three
 * things: a mesh the renderers build with no matching entry in the boot warm-up
 * (see "the coverage audit" below), a rail chunk that comes out differently
 * built one step at a time than built in one go, or a part-built chunk that
 * leaves something behind when the player walks away from it. That is the cheap
 * repeatable check for the whole subject. The full run does all three too, at
 * the end, with the same exit code.
 *
 * ---------------------------------------------------------------------------
 * ## The rail chunk sections, which are a measurement and two assertions
 *
 * WORKSTREAM AF. `railChunkProfile` rides Emu Plains -> Berowra along the bake's
 * own vertices and reports what a building frame costs, which is how the "little
 * freezes on the train" were sized in the first place. Since a chunk is built
 * across frames rather than inside one (`rail-geo.ChunkBuild`), it also reports
 * the **worst single step**, because the bound on a building frame is
 * `RAIL_BUILD_BUDGET_MS` plus that and nothing else.
 *
 * `railChunkIdentity` and `railChunkAbandon` are the two assertions that make
 * the split safe rather than plausible: the same chunk built one step per slice
 * and built in one slice must agree buffer for buffer, and a build the player
 * walks out of `KEEP_RADIUS` on must leave nothing in any of the three states
 * and no geometry alive. Both are ordinary functions returning failure lists, so
 * they cost a second and fail a shell.
 *
 * ---------------------------------------------------------------------------
 * ## The coverage audit, which is the other thing a headless renderer is for
 *
 * WORKSTREAM AE. The report was *"looking around on the train has little
 * freezes, feels like something being pulled from network when i turn around"*,
 * and it is not the network: the streamer's prefetch does not know where the
 * camera points. What knows where the camera points is which pipelines the
 * renderer is asked to build, and three's WebGPU backend builds a missing one
 * **inside `render`** -- `Pipelines.getForRender`'s blocking branch -- on the
 * frame the object first appears.
 *
 * `world/warmup.ts` exists to make that impossible, and the recurring way it
 * fails is not a missing renderer but a warm-up entry that has *drifted from the
 * mesh it stands in for*. The overhead wire is the confirmed case: it was warmed
 * with `{ normal: true, uv: true }` and the real catenary carries position and
 * an index and nothing else. A pipeline is keyed on the attribute layout as much
 * as on the material, so the boot pass compiled a wire that does not exist and
 * the real one compiled on the frame the first catenary came into view -- while
 * riding, which is exactly where it was felt.
 *
 * Neither file can catch that by being read, because the fault is that the two
 * agree in prose and differ in a flag. `auditWarmup` catches it in a live
 * session and only after somebody has looked. So this does it here, before the
 * commit: build every renderer, walk the scene graphs it produces, reduce each
 * mesh to the things three's cache key reads -- through `geometryLayout`, the
 * same function `warmupSignature` builds its layout half from, so the two sides
 * cannot disagree about what an attribute layout *is* -- and diff the two sets.
 *
 * Three rules decide what has to be covered, and each is a property of three's
 * cache key rather than a convention of this project:
 *
 *   - **An ordinary `Mesh` must have a stand-in.** Its key is (material,
 *     attribute layout, `receiveShadow`), all of which a throwaway can copy.
 *     A real mesh with no matching part is a hitch, and is what the audit fails
 *     on.
 *   - **An `InstancedMesh` cannot have one**, ever: `getMaterialCacheKey`
 *     appends `object.uuid`. Those are counted and skipped -- the scene pass and
 *     `TileStreamer.setPrecompiler` cover them, and `world/warmup.ts` sets out
 *     why at length.
 *   - **`castShadow` is in the audit's key** even though it is not in the colour
 *     pipeline's, because it decides whether the nested depth render draws the
 *     mesh at all, and the depth pipelines are half of what the pass is for. A
 *     part warmed `casts: false` over a mesh that casts is the same defect with
 *     a later symptom: the stall arrives when the sun moves its volume over the
 *     thing rather than when you turn towards it.
 *
 * Both directions are printed. The one that matters is real-without-warm. The
 * other -- warm-without-real -- is boot time spent on a pipeline nothing draws,
 * and it is usually the *other half* of a mismatch, as the wire's was.
 *
 * What it cannot reach is listed by name in the output rather than skipped
 * silently: a coverage audit that quietly omits half the world is worse than
 * none. Today that is the streamer's twenty slot materials, the terrain, the
 * water, the power wires and the far city (all need `fetch` and a decode
 * worker), the nameplates and the sun button (both build a `CanvasTexture` off
 * `document`), and the two hero trains (10.5 MB of glTF, and covered by
 * `trains.warm` rather than by a stand-in anyway).
 *
 * ---------------------------------------------------------------------------
 * No node imports and no bun types: the client's `tsconfig.json` has neither in
 * `types`, and adding them there to please one file would put `process` and
 * `Buffer` in scope for nine thousand lines of browser code. The three host
 * facilities this needs -- reading a file, reading `argv`, reading `env` -- go
 * through the narrow declared shims at the top of the file instead.
 */

import {
  InstancedMesh,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
} from 'three/webgpu';

import { FRAME_SECTION_NAMES, FSEC, FrameProfile } from './frameprofile.ts';
import { CharacterActor, CharacterAssets } from './player/character.ts';
import { ActorDriver } from './game/dummies.ts';
import { createCombatant, type CombatantState } from './game/combat.ts';
import { NPC_KIND, NPC_STATE, type NpcActor } from './game/factions.ts';
import { TrafficField, decodeLanes, trafficTick } from './game/traffic.ts';
import { PedestrianField } from './game/pedestrians.ts';
import { CarAssets, TrafficMovers } from './world/cars.ts';
import { PedestrianAssets, PedestrianCrowd } from './world/people.ts';
import { PoliceAssets, PoliceSquad } from './world/police.ts';
import { StreetlifeAssets, StreetCrowd } from './world/streetlife.ts';
import { CharacterCrowd, CharacterKitAssets } from './world/characters.ts';
import { WildlifeAssets, WildlifeFlock } from './world/wildlife.ts';
import { EventAssets, EventScene } from './world/events.ts';
import {
  HighwayPatrolAssets,
  HighwayPatrolFleet,
  Polair,
  createPolairView,
} from './world/highway-patrol.ts';
import { NightLights, type LampSource } from './world/nightlights.ts';
import { uploadStats } from './world/instupload.ts';
import { BatAssets, BatProp, BatViewmodel } from './player/bat.ts';
import { FootyAssets, FootyPool, FootyProp, FootyViewmodel, footyWarmupParts } from './world/footyball.ts';
import { Tracers, policeWarmupParts } from './world/police.ts';
import { highwayPatrolWarmupParts } from './world/highway-patrol.ts';
import { streetlifeWarmupParts } from './world/streetlife.ts';
import { characterWarmupParts } from './world/characters.ts';
import { eventWarmupParts } from './world/events.ts';
import { RaveAssets, RaveWorld, raveWarmupParts } from './world/rave.ts';
import {
  CHUNK_ABSENT,
  RailAssets,
  RailWorld,
  buildNetwork,
  chunkPhaseNames,
  railWarmupParts,
  type BuiltChunk,
  type RailNetwork,
} from './world/rail-geo.ts';
import { KEEP_RADIUS, CHUNK_M, type SolidPrism } from './world/rail-solids.ts';
import {
  TunnelLightAssets,
  TunnelLights,
  buildTunnelLamps,
  tunnelLightWarmupParts,
} from './world/tunnellights.ts';
import { decodeRail, type RailBake, type RailDirection } from './game/rail.ts';
import {
  BigNightKit,
  HornProp,
  TeamRingField,
  TentSet,
  teamLookWarmupParts,
} from './world/teamlook.ts';
import { SwatPuffs } from './world/swatpuff.ts';
import { HandsAssets, HandsViewmodel, handsWarmupParts } from './player/hands.ts';
import { PhoneAssets, PhoneProp, PhoneViewmodel, phoneWarmupParts } from './world/phone.ts';
import { CashNoteAssets, CashNotePiles, cashNoteWarmupParts } from './world/cashnote.ts';
import { DoorMarker } from './world/doormarker.ts';
import { WallGhosts } from './world/wallghosts.ts';
import { QuestMarkerField } from './world/questmarkers.ts';
import { geometryLayout, type WarmupPart } from './world/warmup.ts';

// --- The host, through the smallest possible window ----------------------------
//
// Declared rather than imported. See the header: the client tsconfig carries
// neither `@types/node` nor `@types/bun`, deliberately, and this file is not
// worth changing that for.

interface HostFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
}
interface Host {
  Bun?: { file(path: string): HostFile };
  process?: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): void };
}
const host = globalThis as unknown as Host;

/** The world tree. Overridable so this can be pointed at a retile before it ships. */
const WORLD_DIR =
  host.process?.env.SYDNEY_WORLD ??
  new URL('../public/world', import.meta.url).pathname;

/** Metres a tile covers. The bake's `tile_size`; every world this client has ever had. */
const TILE_SIZE = 500;

// --- The world, off the disk ---------------------------------------------------

/**
 * Adopt every `.lanes.bin` within `radius` of `(x, z)` into a traffic field and
 * a pedestrian field.
 *
 * The identical two-consumers-one-decode arrangement `server/world.ts` uses at
 * boot, down to the origin arithmetic: `decodeLanes(buffer, minX, maxZ)`, where
 * a tile keyed `tx_tz` spans x from `tx * TILE_SIZE` and z **up to**
 * `-tz * TILE_SIZE`. The z flip is the world's own convention -- north is -z --
 * and getting it wrong puts every car in the harbour, which is a mistake this
 * file would rather make loudly here than quietly in a number.
 */
async function loadLanes(
  x: number,
  z: number,
  radius: number,
): Promise<{ traffic: TrafficField; peds: PedestrianField; tiles: number; bytes: number }> {
  const traffic = new TrafficField();
  const peds = new PedestrianField();
  let tiles = 0;
  let bytes = 0;
  const bun = host.Bun;
  if (!bun) throw new Error('perf-harness needs a host with Bun.file; run it with `bun run`.');

  const txMin = Math.floor((x - radius) / TILE_SIZE);
  const txMax = Math.floor((x + radius) / TILE_SIZE);
  // z is south-positive and the tile index runs the other way, so the loop
  // bounds swap. Same flip as the origin above.
  const tzMin = Math.floor(-(z + radius) / TILE_SIZE);
  const tzMax = Math.floor(-(z - radius) / TILE_SIZE);

  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      const key = `${tx}_${tz}`;
      const file = bun.file(`${WORLD_DIR}/tiles/${key}.lanes.bin`);
      if (!(await file.exists())) continue;
      const buffer = await file.arrayBuffer();
      const decoded = decodeLanes(buffer, tx * TILE_SIZE, -tz * TILE_SIZE);
      if (!decoded) continue;
      traffic.adopt(key, decoded);
      peds.adopt(key, decoded);
      tiles++;
      bytes += buffer.byteLength;
    }
  }
  return { traffic, peds, tiles, bytes };
}

// --- The synthetic inputs, each named where it is built ------------------------

/**
 * A grid of street lamps at Sydney spacing, standing in for the streamer's.
 *
 * `NightLights` asks this six times a second for whatever is inside 44 m and
 * sorts the answers; what it costs is the *search*, and a search over an array
 * of the right length with the right hit rate costs what the real one costs. 30
 * m spacing on both sides of a 30 m street grid over 600 m is 1,600 poles, which
 * is about what a CBD ring of resident tiles carries.
 *
 * Stored as a flat `Float32Array` of (x, y, z, sodium) because that is the shape
 * `TileStreamer` keeps them in, so the inner loop here is the inner loop there.
 */
class GridLamps implements LampSource {
  private readonly poles: Float32Array;
  readonly count: number;

  constructor(centreX: number, centreZ: number) {
    const rows: number[] = [];
    for (let gx = -300; gx <= 300; gx += 30) {
      for (let gz = -300; gz <= 300; gz += 30) {
        rows.push(centreX + gx, 6.5, centreZ + gz, gx % 60 === 0 ? 1 : 0);
      }
    }
    this.poles = new Float32Array(rows);
    this.count = rows.length / 4;
  }

  nearestLamps(x: number, y: number, z: number, radius: number, out: Float32Array, max: number): number {
    const r2 = radius * radius;
    let written = 0;
    for (let i = 0; i < this.poles.length; i += 4) {
      const dx = this.poles[i] - x;
      const dy = this.poles[i + 1] - y;
      const dz = this.poles[i + 2] - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (written >= max) break;
      out[written * 4] = this.poles[i];
      out[written * 4 + 1] = this.poles[i + 1];
      out[written * 4 + 2] = this.poles[i + 2];
      out[written * 4 + 3] = this.poles[i + 3];
      written++;
    }
    return written;
  }
}

/**
 * One promoted actor, with every field on the record filled.
 *
 * Built literally rather than through `FactionField.promote`, because promotion
 * is the *simulation* and stepping it here would fold `server/sim.ts`'s cost
 * into a frame number. The renderers read `kind`, `x`, `y`, `z`, `dx`, `dz`,
 * `state` and `health` and nothing else; the rest is filled so the record is a
 * real `NpcActor` and cannot drift from one.
 */
function actor(id: number, kind: number, x: number, z: number, state: number): NpcActor {
  return {
    id,
    kind,
    x,
    y: 0,
    z,
    dx: 0,
    dz: 1,
    state,
    health: 3,
    downTicks: 0,
    stateTicks: 40,
    target: -1,
    homeX: x,
    homeZ: z,
    fireCooldown: 0,
    shotsFired: 0,
    barkedAt: 0,
    struckAt: 0,
    seen: 0,
  };
}

/** What a scene asks the harness to build. */
interface SceneSpec {
  key: string;
  name: string;
  /** Where the camera starts. World metres. */
  x: number;
  z: number;
  /** Sun altitude in degrees. Negative is night; the night rig ramps below +6. */
  solarAltitudeDeg: number;
  /** 0 by day, 1 after dark. `SkyClock.night`, which Polair's beam reads. */
  night: number;
  /** Five stars: Polair up and shooting. */
  fiveStar: boolean;
  /** The promoted roster, built around the camera's start. */
  roster(x: number, z: number): NpcActor[];
}

/**
 * The three scenes.
 *
 * The coordinates are the world's own: x east, z south, origin Town Hall. Hyde
 * Park is 400 m east and 200 m north of it; George Street outside the QVB is
 * essentially on the origin. Both are checked by the tile count the harness
 * prints -- a scene that loaded three tiles is a scene in the ocean.
 */
const SCENES: SceneSpec[] = [
  {
    key: 'park',
    name: 'the spawn park (Hyde Park, midday)',
    x: 400,
    z: -200,
    solarAltitudeDeg: 62,
    night: 0,
    fiveStar: false,
    // Midday in a park: a couple of officers on a beat and the ambient wildlife
    // the flock promotes when somebody walks at it. Nothing is chasing anybody.
    roster: (x, z) => [
      actor(1, NPC_KIND.POLICE, x + 18, z + 8, NPC_STATE.WALK),
      actor(2, NPC_KIND.POLICE, x - 24, z + 30, NPC_STATE.IDLE),
      actor(3, NPC_KIND.IBIS, x + 6, z - 5, NPC_STATE.WALK),
      actor(4, NPC_KIND.IBIS, x + 9, z - 7, NPC_STATE.IDLE),
      actor(5, NPC_KIND.TURKEY, x - 12, z - 18, NPC_STATE.WALK),
      actor(6, NPC_KIND.MAGPIE, x + 30, z + 22, NPC_STATE.AIM),
      actor(7, NPC_KIND.INFLUENCER, x + 4, z + 3, NPC_STATE.IDLE),
      actor(8, NPC_KIND.TRADIE, x - 8, z + 12, NPC_STATE.WALK),
    ],
  },
  {
    key: 'cbd',
    name: 'a CBD street at night (George St, 21:30)',
    x: 20,
    z: 40,
    solarAltitudeDeg: -14,
    night: 1,
    fiveStar: false,
    roster: (x, z) => [
      actor(1, NPC_KIND.POLICE, x + 14, z + 6, NPC_STATE.WALK),
      actor(2, NPC_KIND.METHHEAD, x - 9, z + 4, NPC_STATE.CHASE),
      actor(3, NPC_KIND.DRUNK, x + 22, z - 11, NPC_STATE.WALK),
      actor(4, NPC_KIND.ESHAY, x - 16, z - 6, NPC_STATE.WALK),
      actor(5, NPC_KIND.KAREN, x + 7, z + 19, NPC_STATE.IDLE),
      actor(6, NPC_KIND.INFLUENCER, x - 3, z + 9, NPC_STATE.IDLE),
      actor(7, NPC_KIND.IBIS, x + 11, z + 14, NPC_STATE.WALK),
      actor(8, NPC_KIND.HIGHWAY_PATROL, x + 40, z + 25, NPC_STATE.IDLE),
    ],
  },
  {
    key: 'chase',
    name: 'a 5-star chase at night (George St, 21:30)',
    x: 20,
    z: 40,
    solarAltitudeDeg: -14,
    night: 1,
    fiveStar: true,
    // The worst case the ladder can produce: six patrol cars, an RBT, four
    // officers, the street factions out, and Polair overhead with its beam on.
    roster: (x, z) => {
      const list: NpcActor[] = [];
      let id = 1;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        list.push(actor(id++, NPC_KIND.HIGHWAY_PATROL, x + Math.cos(a) * 70, z + Math.sin(a) * 70, NPC_STATE.CHASE));
      }
      list.push(actor(id++, NPC_KIND.RBT, x + 120, z - 40, NPC_STATE.IDLE));
      for (let i = 0; i < 4; i++) {
        list.push(actor(id++, NPC_KIND.POLICE, x + 8 + i * 4, z + 12 + i * 3, NPC_STATE.AIM));
      }
      list.push(actor(id++, NPC_KIND.METHHEAD, x - 9, z + 4, NPC_STATE.CHASE));
      list.push(actor(id++, NPC_KIND.DRUNK, x + 22, z - 11, NPC_STATE.CHASE));
      list.push(actor(id++, NPC_KIND.ESHAY, x - 16, z - 6, NPC_STATE.WALK));
      list.push(actor(id++, NPC_KIND.POLAIR, x, z, NPC_STATE.CHASE));
      return list;
    },
  },
];

/** Sections this harness genuinely drives. Everything else prints as uncovered. */
const COVERED = new Set([
  FSEC.traffic, FSEC.crowd, FSEC.police, FSEC.lights, FSEC.heat, FSEC.actors,
]);

/**
 * Everything the renderers need, built once and shared across all three scenes
 * -- exactly as `main.ts` builds one of each for the session.
 *
 * Shared deliberately: a per-scene rebuild would give each scene a cold rig pool
 * and an empty near set, and the first fifty frames of every scene would measure
 * the acquisition rather than the steady state.
 */
function buildRenderers(): {
  scene: Scene;
  camera: PerspectiveCamera;
  movers: TrafficMovers;
  crowd: PedestrianCrowd;
  squad: PoliceSquad;
  street: StreetCrowd;
  characters: CharacterCrowd;
  flock: WildlifeFlock;
  events: EventScene;
  patrol: HighwayPatrolFleet;
  polair: Polair;
  nightLights: NightLights;
  fighters: Array<{ driver: ActorDriver; combat: CombatantState }>;
} {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 4000);
  const chars = new CharacterAssets();

  const movers = new TrafficMovers(new CarAssets());
  const crowd = new PedestrianCrowd(new PedestrianAssets(), chars);
  const squad = new PoliceSquad(new PoliceAssets(chars), chars);
  const street = new StreetCrowd(new StreetlifeAssets(chars), chars);
  const characters = new CharacterCrowd(new CharacterKitAssets(chars), chars);
  const flock = new WildlifeFlock(new WildlifeAssets());
  const events = new EventScene(new EventAssets());
  const patrolAssets = new HighwayPatrolAssets();
  const patrol = new HighwayPatrolFleet(patrolAssets);
  const polair = new Polair(scene, patrolAssets);
  const nightLights = new NightLights(scene);

  // Sixteen bodies posed on the frame delta -- the local player, three dummies
  // and twelve remotes, which is a full room. `CharacterActor.update` is the
  // same call `main.ts` makes for every fighter and every remote.
  const fighters: Array<{ driver: ActorDriver; combat: CombatantState }> = [];
  for (let i = 0; i < 16; i++) {
    fighters.push({ driver: new ActorDriver(new CharacterActor(chars, i % 4)), combat: createCombatant(i) });
  }

  return { scene, camera, movers, crowd, squad, street, characters, flock, events, patrol, polair, nightLights, fighters };
}

/** Flat ground. The harness has no DEM and none of the renderers below need one. */
const FLAT = (): number => 0;

/**
 * Step one scene N times and return the profile.
 *
 * The order of the calls is `main.ts`'s order, because two of these renderers
 * genuinely depend on it -- `NightLights.update` fills `carLights` for the
 * traffic that follows it, and the crowd is posed before the factions that
 * claim its ambient slots. Reordering them here would measure a frame this game
 * never draws.
 */
async function runScene(
  spec: SceneSpec,
  frames: number,
  rig: ReturnType<typeof buildRenderers>,
): Promise<{ profile: FrameProfile; tiles: number; bytes: number; census: string; upload: string }> {
  const { traffic, peds, tiles, bytes } = await loadLanes(spec.x, spec.z, 1400);
  const roster = { actors: spec.roster(spec.x, spec.z) };
  const lamps = new GridLamps(spec.x, spec.z);
  const profile = new FrameProfile();

  const polairView = createPolairView(FLAT, () => {}, () => {});
  polairView.night = spec.night;
  polairView.on = spec.fiveStar;
  polairView.playerId = 7;

  const dt = 1 / 60;
  /**
   * The instance-upload ledger, snapshotted per scene.
   *
   * `uploadStats` is monotonic for the process (see `world/instupload.ts` on
   * why), so a scene's share is the difference across its own frames -- the
   * `ProfileReader` arrangement, done by hand because there is exactly one
   * reader.
   */
  let uploadBase = { ...uploadStats };
  // A walk rather than a stand: 4 m/s along +x with a 12 deg/s yaw sweep, so
  // every "has the near set changed" fast path is crossed the way a player
  // crosses it. See the header.
  let x = spec.x;
  let z = spec.z;

  // Two hundred frames of warm-up before the ring starts being read: the rig
  // pools acquire, the near sets fill, and the JIT gets to see each of these
  // update loops more than once. Measuring the first frames of a cold pool is
  // measuring the pool, and the answer this file is for is the steady state.
  const warm = 200;

  for (let f = 0; f < frames + warm; f++) {
    const t = f * dt;
    x = spec.x + t * 4;
    z = spec.z + Math.sin(t * 0.25) * 12;
    const yaw = t * 0.21;
    rig.camera.position.set(x, 1.62, z);
    rig.camera.rotation.set(0, yaw, 0);
    rig.camera.updateMatrixWorld();
    // The fractional tick every ambient system in this client shares. Driven off
    // the harness's own clock rather than `Date.now()` so two runs of the same
    // command sample the same instants and are comparable -- which is the whole
    // reason for a harness over a stopwatch.
    const tick = trafficTick(1_760_000_000_000 + t * 1000);

    profile.begin();

    profile.at(FSEC.lights);
    rig.nightLights.update(dt, rig.camera, spec.solarAltitudeDeg, 4, lamps, null, null);

    profile.at(FSEC.traffic);
    rig.movers.update(traffic, tick, x, z, x, z, -Math.sin(yaw), -Math.cos(yaw));

    profile.at(FSEC.crowd);
    rig.crowd.update(peds, tick, dt, x, z);

    profile.at(FSEC.police);
    rig.squad.update(peds, roster, tick, dt, x, z);
    rig.street.update(peds, roster, tick, dt, x, z);
    rig.characters.update(peds, roster, tick, dt, x, z);
    rig.flock.update(peds, roster, tick, x, z, FLAT);
    rig.events.update(tick, x, z, FLAT, peds);

    profile.at(FSEC.heat);
    rig.patrol.update(roster, dt, x, z);
    polairView.tick = Math.floor(tick);
    polairView.dt = dt;
    polairView.x = x;
    polairView.y = 1.62;
    polairView.z = z;
    polairView.groundY = 0;
    rig.polair.update(polairView);

    profile.at(FSEC.actors);
    for (const f2 of rig.fighters) f2.driver.update(f2.combat, dt);

    profile.stop();

    // Drop the warm-up out of the window by simply starting the measurement
    // late: the ring is 120 frames deep, so anything before `frames - 120` is
    // gone anyway, but the lifetime accumulators would carry it. Cheapest
    // correct answer is a second profile; the first is discarded.
    if (f === warm - 1) {
      uploadBase = { ...uploadStats };
      // Re-arm by building a fresh ring. Two hundred frames of garbage in the
      // lifetime totals would make `totalOf` -- which the report prints as the
      // session share -- wrong by exactly the cold pass this is excluding.
      (profile.acc as Float64Array).fill(0);
    }
  }

  const uploadKb = (uploadStats.bytes - uploadBase.bytes) / 1024 / frames;
  const fullKb = (uploadStats.fullBytes - uploadBase.fullBytes) / 1024 / frames;
  return {
    profile,
    tiles,
    bytes,
    upload:
      `instance upload ${uploadKb.toFixed(1)} kB/frame ` +
      `(was ${fullKb.toFixed(1)} kB/frame whole-buffer, ${(fullKb / Math.max(uploadKb, 1e-6)).toFixed(1)}x)`,
    /**
     * What the scene actually contained, printed above the table.
     *
     * Not decoration. A table of small numbers can mean "this is cheap" or it
     * can mean "the scene was empty and nobody noticed", and those two readings
     * are indistinguishable without a population count beside them. Every one of
     * these is the renderer's own counter -- the same fields the in-game debug
     * overlay reads -- so a harness run and a real session can be compared
     * directly.
     */
    census:
      `${rig.movers.drawn} cars drawn / ${rig.movers.parked} parked, ` +
      `${rig.crowd.drawn} pedestrians (${rig.crowd.rigged} rigged), ` +
      `${rig.squad.beats}+${rig.squad.actors} police, ` +
      `${rig.street.ambient}+${rig.street.actors} street, ` +
      `${rig.flock.ambient}+${rig.flock.actors} birds, ` +
      `${rig.events.sites} event sites, ${rig.patrol.cars} patrol cars, ` +
      `polair ${rig.polair.intensity.toFixed(2)}`,
  };
}

/**
 * The table.
 *
 * Uncovered sections are printed with a dash rather than omitted, on
 * `ProfileReader.take`'s rule about a report that changes shape: a reader
 * comparing this output to the `?perf=1` strip has to be able to see at a glance
 * which rows are missing and why.
 */
function printTable(spec: SceneSpec, result: Awaited<ReturnType<typeof runScene>>): void {
  const report = result.profile.report();
  console.log('');
  console.log(`--- ${spec.name}`);
  console.log(
    `    ${result.tiles} lane tiles (${(result.bytes / 1024).toFixed(0)} kB), ` +
      `${report.frames}-frame window over ${report.lifetimeFrames} frames\n    ${result.census}\n    ${result.upload}`,
  );
  console.log(`    ${'section'.padEnd(10)}${'mean ms'.padStart(9)}${'worst ms'.padStart(10)}`);
  let covered = 0;
  for (const name of FRAME_SECTION_NAMES) {
    const index = FRAME_SECTION_NAMES.indexOf(name);
    const row = report.sections.find((s) => s.name === name);
    if (!COVERED.has(index as never)) {
      console.log(`    ${name.padEnd(10)}${'--'.padStart(9)}${'not covered'.padStart(14)}`);
      continue;
    }
    covered += row?.meanMs ?? 0;
    console.log(
      `    ${name.padEnd(10)}${(row?.meanMs ?? 0).toFixed(3).padStart(9)}${(row?.worstMs ?? 0).toFixed(3).padStart(10)}`,
    );
  }
  console.log(
    `    ${'COVERED'.padEnd(10)}${covered.toFixed(3).padStart(9)}${report.worstMs.toFixed(3).padStart(10)}  ` +
      `(profiler ${report.overheadUs.toFixed(1)} us/frame, clock grain ${report.grainUs.toFixed(2)} us)`,
  );
}

// --- The warm-up coverage audit ------------------------------------------------
//
// See the header section "the coverage audit" for why this exists and what its
// three rules are. Everything below is the machinery.

/**
 * One renderer family: what it asks the boot warm-up for, and what it actually
 * puts in the scene.
 *
 * The two halves are built from the **same asset instance**, and that is the
 * only thing here that is not obvious. A pipeline is keyed on the material
 * itself, so a group that constructed `new PoliceAssets(chars)` twice
 * -- once for its parts and once for its squad -- would report every one of its
 * materials as both uncovered and unused, and the audit would be a list of its
 * own mistakes. One `assets`, threaded through both.
 */
interface WarmGroup {
  name: string;
  /** What this group contributes to `main.ts`'s boot list. May be empty. */
  parts: readonly WarmupPart[];
  /** Roots of the real scene graph the renderers build. Traversed, not drawn. */
  real: readonly Object3D[];
  /**
   * Objects `main.ts` hands to `warmUpPipelines` **whole** rather than as
   * stand-ins -- today only the two throwaway characters, because a skinned
   * mesh's cache key folds in its skeleton and no triangle can fake one. They
   * warm their own exact pipelines, so their signatures count as covered.
   */
  extras?: readonly Object3D[];
  /**
   * Asset objects to read material names off, so the report can say
   * `rail.wire` rather than `MeshBasicNodeMaterial#7f3a`. Own enumerable
   * properties only, one level deep, arrays included.
   */
  label?: Record<string, unknown>;
}

/**
 * One drawable, reduced to the things three's cache key actually reads.
 *
 * ---------------------------------------------------------------------------
 * **A mesh needs up to two pipelines and they are keyed differently**, and
 * getting that wrong is the difference between a useful audit and a list of
 * false alarms. Read out of `RenderObject.getMaterialCacheKey` and
 * `getDynamicCacheKey` rather than assumed:
 *
 *   - The **colour** pipeline's key is the material's own properties, the
 *     geometry's attribute layout, the skeleton's bone count and
 *     `object.receiveShadow`. `castShadow` is **not** in it.
 *   - The **depth** pipeline's key is the same list with the material replaced
 *     by one shared `ShadowMaterial` per light -- `ShadowNode.updateBefore` sets
 *     it as `scene.overrideMaterial` -- so the object's own material drops out
 *     entirely and only the layout, the bones and `receiveShadow` remain. It is
 *     needed only when `castShadow` is true, because
 *     `getShadowRenderObjectFunction` draws nothing else.
 *
 * So a part warmed `casts: true` over a mesh that does not cast has warmed the
 * colour pipeline the mesh does need and one depth pipeline it does not; that is
 * a little boot time and no hitch. The reverse -- a caster with no casting part
 * at its layout -- is a stall the first time the sun's volume covers it, and is
 * a failure. `warmupSignature` folds both into one string because for the
 * *warm-up* that is the conservative thing to do; the audit has to be exact.
 */
interface RealMesh {
  /** `material | layout | bones | receiveShadow`. */
  colourKey: string;
  /** `layout | bones | receiveShadow`, or '' when the mesh never casts. */
  depthKey: string;
  group: string;
  material: Material;
  layout: string;
  casts: boolean;
  receives: boolean;
  /** An object name a reader can grep for. */
  example: string;
  /**
   * Whether it was visible when the audit walked it, which is the closest this
   * can get to "the boot scene pass would have reached it". That pass walks the
   * real scene once, and `_projectObject` skips anything invisible; so a
   * hidden-until-used mesh -- the footy in its pool, the swat puff, the door
   * marker -- can only ever be warmed by a stand-in. Nor does the pass reach
   * anything built *after* it: every rail chunk mesh is made on demand while the
   * player moves, so `visible` here means only that a stand-in is not the sole
   * possible cover, never that one is unnecessary.
   */
  visibleAtBoot: boolean;
}

const colourKeyOf = (material: Material, layout: string, bones: number, receives: boolean): string =>
  `${material.uuid}|${layout}|${bones}|${receives}`;
const depthKeyOf = (layout: string, bones: number, receives: boolean): string =>
  `${layout}|${bones}|${receives}`;

/** How many bones are in this object's cache key. Zero for everything unskinned. */
const bonesOf = (object: Object3D): number =>
  (object as SkinnedMesh).skeleton?.bones.length ?? 0;

/** The nearest named thing at or above `object`, so the report can be grepped for. */
function nameOfObject(object: Object3D): string {
  for (let o: Object3D | null = object; o; o = o.parent) {
    if (o.name) return o === object ? o.name : `${o.name}/${object.type}`;
  }
  return object.type;
}

/** Name every material reachable one level down from an asset object. */
function labelMaterials(prefix: string, source: Record<string, unknown>, into: Map<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value instanceof Material) into.set(value.uuid, `${prefix}.${key}`);
    else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] instanceof Material) into.set((value[i] as Material).uuid, `${prefix}.${key}[${i}]`);
      }
    }
  }
}

/**
 * Every real mesh under `roots`, keyed exactly as the warm-up keys its parts.
 *
 * `InstancedMesh` is skipped and counted rather than reported: three appends
 * `object.uuid` to an instanced draw's material cache key, so no stand-in can
 * ever cover one and listing them here would be listing the design. Skinned
 * meshes *are* reported, because `main.ts` covers them with real extras and a
 * rig whose shadow flags drifted from those extras is a genuine miss.
 */
function collectReal(
  group: string,
  roots: readonly Object3D[],
  into: Map<string, RealMesh>,
  instanced: { count: number },
): void {
  for (const root of roots) {
    // Visibility is inherited, so it has to be carried down rather than read off
    // the mesh: a `visible = false` pool group hides balls whose own flag is
    // true, and `_projectObject` stops at the group.
    const walk = (object: Object3D, visible: boolean): void => {
      const shown = visible && object.visible;
      const mesh = object as Mesh;
      const material = mesh.material;
      if (material && mesh.geometry) {
        if ((mesh as InstancedMesh).isInstancedMesh) {
          instanced.count++;
        } else {
          const layout = geometryLayout(mesh.geometry);
          const bones = bonesOf(object);
          for (const m of Array.isArray(material) ? material : [material]) {
            // Keyed for the report by everything, including `casts`, so a mesh
            // that casts and one that does not are two rows a reader can tell
            // apart. The *coverage* test below uses the two narrower keys.
            const row = `${colourKeyOf(m, layout, bones, mesh.receiveShadow)}|${mesh.castShadow}`;
            const existing = into.get(row);
            if (existing) {
              // Keep the most favourable visibility: one mesh of a kind being
              // shown at boot is enough for the scene pass to compile the
              // pipeline the rest of them share.
              if (shown) existing.visibleAtBoot = true;
              continue;
            }
            into.set(row, {
              colourKey: colourKeyOf(m, layout, bones, mesh.receiveShadow),
              depthKey: mesh.castShadow ? depthKeyOf(layout, bones, mesh.receiveShadow) : '',
              group,
              material: m,
              layout,
              casts: mesh.castShadow,
              receives: mesh.receiveShadow,
              example: nameOfObject(object),
              visibleAtBoot: shown,
            });
          }
        }
      }
      for (const child of object.children) walk(child, shown);
    };
    walk(root, true);
  }
}

/** The rail bake, off disk. `main.ts` fetches the identical bytes from `/rail/`. */
const RAIL_BAKE = new URL('../public/rail/rail.bin', import.meta.url).pathname;

/** A `RailWorld` and the route to ride it along. See `railChunkProfile`. */
interface RailRide {
  world: RailWorld;
  bake: RailBake;
  /** The derived network, shared with the identity check's own world. */
  net: RailNetwork;
  /** The longest direction in the bake, which is the longest ride available. */
  route: RailDirection;
}

/**
 * Build every renderer the audit can build, and pair it with its warm-up parts.
 *
 * The rail world is the one that needs the disk: `RailWorld` is driven through
 * `update` at a real Sydney position so its chunk ring actually builds, because
 * the chunk meshes -- ballast, rails, platforms, canopies, the overhead wire --
 * are made on demand and a `RailWorld` that has never been updated contains
 * only the corridor. That is also the geometry `railChunkProfile` times.
 */
async function warmGroups(): Promise<{ groups: WarmGroup[]; rail: RailRide | null }> {
  const chars = new CharacterAssets();
  const groups: WarmGroup[] = [];

  // --- The two throwaway characters, which is the whole of `warmupExtras`.
  //
  // Both variants, exactly as `main.ts` builds them: `CharacterActor` sets
  // `receiveShadow = true` on every body and `castShadowOnly` turns it off again
  // for the local player's own, and three keys the pipeline on that flag.
  const warmA = new CharacterActor(chars, 0);
  const warmB = new CharacterActor(chars, 0);
  warmA.mesh.receiveShadow = true;
  warmB.mesh.receiveShadow = false;
  groups.push({ name: 'player', parts: [], real: [], extras: [warmA.mesh, warmB.mesh] });

  const footy = new FootyAssets();
  const footyActor = new CharacterActor(chars, 0);
  const footyProp = new FootyProp(footy, footyActor);
  groups.push({
    name: 'footy',
    parts: footyWarmupParts(footy),
    real: [new FootyPool(footy).group, new FootyViewmodel(footy).group, footyActor.mesh],
    label: { footy },
  });
  void footyProp;

  const bats = new BatAssets();
  const batActor = new CharacterActor(chars, 0);
  const batProp = new BatProp(bats, batActor);
  groups.push({
    name: 'bat',
    parts: [{ geometry: bats.geometry, material: bats.material, casts: true }],
    real: [new BatViewmodel(bats).group, batActor.mesh],
    label: { bat: bats },
  });
  void batProp;

  const puffs = new SwatPuffs();
  groups.push({
    name: 'swatpuff',
    // `main.ts` writes this one inline rather than through a `*WarmupParts`
    // function, so it is repeated here in the same shape. See the block around
    // `swatPuffs.meshes[0]` there.
    parts: [
      {
        geometry: puffs.meshes[0].geometry,
        material: puffs.meshes[0].material as Material,
        casts: false,
        receives: [false],
      },
    ],
    real: puffs.meshes,
  });

  const policeAssets = new PoliceAssets(chars);
  const tracers = new Tracers();
  const squad = new PoliceSquad(policeAssets, chars);
  groups.push({
    name: 'police',
    parts: policeWarmupParts(policeAssets, tracers),
    real: [...squad.rigs.map((r) => r.mesh), ...tracers.meshes],
    label: { police: policeAssets, tracer: tracers },
  });

  const patrolAssets = new HighwayPatrolAssets();
  const fleet = new HighwayPatrolFleet(patrolAssets);
  const polairScene = new Scene();
  const polair = new Polair(polairScene, patrolAssets);
  groups.push({
    name: 'patrol',
    parts: highwayPatrolWarmupParts(patrolAssets),
    real: [fleet.group, polair.group, polairScene],
    label: { patrol: patrolAssets },
  });

  const streetAssets = new StreetlifeAssets(chars);
  const street = new StreetCrowd(streetAssets, chars);
  groups.push({
    name: 'street',
    parts: streetlifeWarmupParts(streetAssets),
    real: street.rigs.map((r) => r.mesh),
    label: { street: streetAssets },
  });

  const kitAssets = new CharacterKitAssets(chars);
  const kitCrowd = new CharacterCrowd(kitAssets, chars);
  groups.push({
    name: 'characters',
    parts: characterWarmupParts(kitAssets),
    real: kitCrowd.rigs.map((r) => r.mesh),
    label: { kit: kitAssets },
  });

  const eventAssets = new EventAssets();
  const events = new EventScene(eventAssets);
  groups.push({
    name: 'events',
    parts: eventWarmupParts(eventAssets),
    real: events.meshes,
    label: { events: eventAssets },
  });

  const raveAssets = new RaveAssets();
  const raves = new RaveWorld(raveAssets, new PedestrianAssets(), chars);
  groups.push({
    name: 'rave',
    parts: raveWarmupParts(raveAssets),
    real: [...raves.meshes, raves.banner, ...raves.rigs.map((r) => r.mesh)],
    label: { rave: raveAssets },
  });

  const bigNight = new BigNightKit(chars);
  const rings = new TeamRingField();
  const hornActor = new CharacterActor(chars, 0);
  const horns = new HornProp(bigNight, chars, hornActor);
  groups.push({
    name: 'teams',
    parts: teamLookWarmupParts(bigNight, chars, rings),
    real: [new TentSet(bigNight, chars).mesh, rings.mesh, hornActor.mesh],
    label: { teamring: rings },
  });
  void horns;

  // --- The railway, which is the one that reads the disk.
  const railAssets = new RailAssets();
  let rail: RailRide | null = null;
  const bun = host.Bun;
  if (bun && (await bun.file(RAIL_BAKE).exists())) {
    const bake = decodeRail(await bun.file(RAIL_BAKE).arrayBuffer());
    if (bake) {
      const net = buildNetwork(bake);
      const world = new RailWorld(net, railAssets, FLAT);
      // The longest direction in the bake, which is the route the profile below
      // rides. Its first vertex is where the ring is filled: `BUILDS_PER_FRAME`
      // caps a frame's chunks, so this is driven until the queue drains.
      const route = bake.lines.flatMap((line) => line.dirs)
        .reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
      const first = route.vertexOff * 3;
      for (let i = 0; i < 400; i++) world.update(bake.vertices[first], bake.vertices[first + 2]);
      rail = { world, bake, net, route };
    }
  }
  groups.push({
    name: 'rail',
    parts: railWarmupParts(railAssets),
    real: rail ? [rail.world.group] : [],
    label: { rail: railAssets },
  });

  // --- WORKSTREAM AI: the tunnel lamps, which are the whole reason that feature
  // is a plain `Mesh` and not an `InstancedMesh`.
  //
  // `world/tunnellights.ts` section 4 argues it at length: instancing would have
  // put `object.uuid` in the pipeline key, this audit would have counted the set
  // among its "instanced draws skipped", and a layout mistake would have shown
  // up as a compile on the frame the train enters the bore instead of as a line
  // here. Driven at the same place the rail ride starts, so the mesh in `real`
  // has a real draw range rather than the empty one a fresh set carries.
  const tunnelAssets = new TunnelLightAssets();
  let tunnel: TunnelLights | null = null;
  if (rail) {
    tunnel = new TunnelLights(buildTunnelLamps(rail.bake), tunnelAssets);
    const first = rail.route.vertexOff * 3;
    tunnel.update(rail.bake.vertices[first], rail.bake.vertices[first + 2]);
  }
  groups.push({
    name: 'tunnellight',
    parts: tunnelLightWarmupParts(tunnelAssets),
    real: tunnel ? [tunnel.group] : [],
    label: { tunnellight: tunnelAssets },
  });

  // --- The world-wide instanced populations, which contribute no parts at all
  // and are here to be counted rather than covered. Every one of them is warmed
  // by the scene pass at the bottom of `main.ts`; see `world/warmup.ts`.
  const movers = new TrafficMovers(new CarAssets());
  const crowd = new PedestrianCrowd(new PedestrianAssets(), chars);
  const flock = new WildlifeFlock(new WildlifeAssets());
  const lightScene = new Scene();
  void new NightLights(lightScene);
  groups.push({
    name: 'instanced',
    parts: [],
    real: [...movers.meshes, ...crowd.meshes, ...crowd.rigs.map((r) => r.mesh), ...flock.meshes, lightScene],
  });

  // --- The viewmodels and the props built on demand.
  //
  // These four are `main.ts`'s late block: they are constructed below
  // `hud.ready` and so cannot be in the boot list, and two of them are built on
  // demand and so are not in the scene for the scene pass either. Their parts
  // ride into the scene pass on `warmupStandins`; here they are one group like
  // any other, because from the audit's side the question is the same.
  const handsAssets = new HandsAssets();
  const phoneAssets = new PhoneAssets();
  const phoneActor = new CharacterActor(chars, 0);
  const phoneProp = new PhoneProp(phoneAssets, phoneActor);
  const cashScene = new Scene();
  const cashAssets = new CashNoteAssets();
  const cash = new CashNotePiles(cashScene, cashAssets);
  // One bundle, because a pile is built on demand and a `CashNotePiles` nobody
  // has handed money to holds nothing.
  cash.update(1 / 60, [{ id: 1, x: 0, y: 0, z: 0, amount: 250 }]);
  const doorMarker = new DoorMarker();
  /*
   * WORKSTREAM AN: the quest markers, and the reason they are auditable at all.
   *
   * `world/questmarkers.ts` draws its `!` and `?` as **geometry** rather than as
   * a canvas raster, and that was chosen partly so this line could exist: the
   * plate field and the sun button are two rows down in `UNAUDITED` because they
   * build a `CanvasTexture` in their constructors and this harness has no
   * `document`. A field built out of quads has no such problem, so the one
   * warm-up part it offers is diffed against the one mesh it draws, here, before
   * the commit -- which is the difference between the boarding marker's kind of
   * mistake being caught in review and being felt on the frame a player walks up
   * to their first quest giver.
   *
   * The mesh's geometry is empty until a giver is in range, which is exactly why
   * it needs a stand-in and exactly why the stand-in is *itself*: an empty
   * geometry still carries the attribute layout the pipeline is keyed on.
   */
  const questMarkers = new QuestMarkerField();
  groups.push({
    name: 'viewmodels',
    parts: [
      ...handsWarmupParts(handsAssets),
      ...phoneWarmupParts(phoneAssets),
      ...cashNoteWarmupParts(cashAssets),
      ...doorMarker.warmupParts(),
      ...questMarkers.warmupParts(),
    ],
    real: [
      new HandsViewmodel(handsAssets).group,
      new PhoneViewmodel(phoneAssets).group,
      phoneProp.group,
      cashScene,
      doorMarker.group,
      questMarkers.mesh,
    ],
    label: { hands: handsAssets, phone: phoneAssets, cash: cashAssets, questmarker: questMarkers },
  });

  // WORKSTREAM AQ: the undrawn-wall silhouette. One instanced box set over one
  // unlit translucent material, and **no parts** -- the audit skips an instanced
  // draw exactly as it skips the bikes and the crowd, because no stand-in can
  // warm one. See `world/warmup.ts`'s rule and `WallGhosts`' constructor, which
  // is where the real warm-up lives. Declared here anyway, with an empty list,
  // because a renderer with no row in this table is one a reader cannot see is
  // missing -- which is the failure this whole audit exists to make impossible.
  const ghostScene = new Scene();
  const ghosts = new WallGhosts(
    ghostScene,
    { prismsWithin: (_x, _z, _r, out) => ((out.length = 0), out) },
    { hazardAt: () => null },
  );
  groups.push({
    name: 'wallghost',
    parts: [],
    real: [ghosts.mesh],
  });

  return { groups, rail };
}

/** Renderers this harness cannot build, and why. Printed, never skipped silently. */
const UNAUDITED: ReadonlyArray<readonly [string, string]> = [
  ['streamer (20 slot materials)', 'needs a TileStreamer, which spawns decode workers and fetches tiles'],
  ['terrain / water / contact skirt', 'built from a tile\'s .terr.bin inside the streamer'],
  ['power wires (world/power.ts)', 'merged per tile by the streamer'],
  ['street-name blades', 'a CanvasTexture per legend, off document'],
  ['far city (world/far.ts)', 'fetches the hex bake; covered by precompileGroup, not by a stand-in'],
  ['nameplates (world/nameplates.ts)', 'builds a CanvasTexture in its constructor'],
  ['sun button (world/sunbutton.ts)', 'builds a CanvasTexture in its constructor'],
  ['trains (world/trains.ts)', '10.5 MB of glTF; covered by trains.warm(precompileGroup)'],
  ['near-field car models (world/carlod.ts)', '2.4 MB of glTF over fetch'],
  ['landmarks', 'a streamed GLB group; covered by compileAsync on the group'],
  // WORKSTREAM AQ. Its `real` mesh *is* collected below and lands in the
  // instanced-draws-skipped count; what cannot be done is warm it with a
  // stand-in, so it has no census row and is named here instead. The overlay's
  // own warm-up is that the mesh is visible from construction with `count = 0`,
  // which puts it in the boot's scene pass. See `world/wallghosts.ts`.
  ['undrawn-wall silhouette (world/wallghosts.ts)', 'one instanced box set; covered by the scene pass'],
];

/**
 * The census and the coverage diff, printed together.
 *
 * Returns the failures -- real meshes with no warm-up entry -- so the caller can
 * set an exit code. Nothing here throws: a coverage audit that dies halfway
 * through reports less than one that finishes and says what it could not reach.
 */
async function warmupAudit(): Promise<{ failures: string[]; rail: RailRide | null }> {
  const { groups, rail } = await warmGroups();

  const names = new Map<string, string>();
  for (const group of groups) if (group.label) {
    for (const [prefix, source] of Object.entries(group.label)) {
      labelMaterials(prefix, source as Record<string, unknown>, names);
    }
  }
  const nameOf = (m: Material): string =>
    names.get(m.uuid) ?? `${m.name || m.type}#${m.uuid.slice(0, 4)}`;

  // --- Half one: the dedupe census, which is what this table has always been.
  console.log('');
  console.log('--- the boot shader warm-up, deduped');
  console.log(`    ${'group'.padEnd(12)}${'parts'.padStart(6)}${'draws'.padStart(7)}${'pipelines'.padStart(11)}`);
  /** A warmed pipeline, flattened to the same fields a real mesh carries. */
  interface WarmEntry {
    group: string;
    material: Material;
    layout: string;
    bones: number;
    casts: boolean;
    receives: boolean;
  }
  /** Colour pipelines the boot pass compiles, and the depth pipelines with them. */
  const warmColour = new Map<string, WarmEntry>();
  const warmDepth = new Map<string, WarmEntry>();
  let draws = 0;
  for (const group of groups) {
    if (group.parts.length === 0 && !group.extras) continue;
    const seen = new Set<string>();
    let d = 0;
    const submit = (entry: WarmEntry): void => {
      d++;
      seen.add(`${colourKeyOf(entry.material, entry.layout, entry.bones, entry.receives)}|${entry.casts}`);
      const colour = colourKeyOf(entry.material, entry.layout, entry.bones, entry.receives);
      if (!warmColour.has(colour)) warmColour.set(colour, entry);
      if (entry.casts) {
        const depth = depthKeyOf(entry.layout, entry.bones, entry.receives);
        if (!warmDepth.has(depth)) warmDepth.set(depth, entry);
      }
    };
    for (const part of group.parts) {
      for (const receive of part.receives ?? [false, true]) {
        submit({
          group: group.name,
          material: part.material,
          layout: geometryLayout(part.geometry),
          bones: 0,
          casts: part.casts ?? true,
          receives: receive,
        });
      }
    }
    // An extra warms exactly the pipelines its own meshes need -- it *is* the
    // real object -- so every mesh under it counts as warm, bones and all.
    const extras = new Map<string, RealMesh>();
    collectReal(group.name, group.extras ?? [], extras, { count: 0 });
    for (const mesh of extras.values()) {
      submit({
        group: group.name,
        material: mesh.material,
        layout: mesh.layout,
        bones: Number(mesh.colourKey.split('|')[2]),
        casts: mesh.casts,
        receives: mesh.receives,
      });
    }
    draws += d;
    console.log(
      `    ${group.name.padEnd(12)}${String(group.parts.length).padStart(6)}${String(d).padStart(7)}${String(seen.size).padStart(11)}`,
    );
  }
  const distinct = warmColour.size + warmDepth.size;
  console.log(
    `    ${'TOTAL'.padEnd(12)}${''.padStart(6)}${String(draws).padStart(7)}${String(distinct).padStart(11)}  ` +
      `-- ${warmColour.size} colour + ${warmDepth.size} depth, from ${draws} draws`,
  );

  // --- Half two: what the renderers really build.
  const real = new Map<string, RealMesh>();
  const instanced = { count: 0 };
  for (const group of groups) collectReal(group.name, group.real, real, instanced);

  console.log('');
  console.log('--- warm-up coverage: every mesh the renderers build, against every part the boot pass submits');
  console.log(
    `    ${real.size} distinct real draws over ${groups.length} groups, ` +
      `${instanced.count} instanced draws skipped (no stand-in can warm one -- see world/warmup.ts)`,
  );

  /** What a real mesh is missing, in words, or '' when it is covered. */
  const missing = (m: RealMesh): string => {
    const gaps: string[] = [];
    if (!warmColour.has(m.colourKey)) gaps.push('colour');
    if (m.depthKey && !warmDepth.has(m.depthKey)) gaps.push('depth');
    return gaps.join(' + ');
  };
  const uncovered = [...real.values()]
    .map((m) => [m, missing(m)] as const)
    .filter(([, gap]) => gap !== '');

  const failures: string[] = [];
  console.log('');
  if (uncovered.length === 0) {
    console.log('    real meshes with no warm-up entry: none.');
  } else {
    console.log(`    !!! ${uncovered.length} real draws have no warm-up entry. Each is a hitch on first sight.`);
    for (const [m, gap] of uncovered) {
      // The nearest thing that *was* warmed on the same material, which is
      // nearly always the drifted part and is what a reader wants next to the
      // miss. Exactly how the overhead wire read before it was fixed.
      const near = [...warmColour.values()].find((w) => w.material === m.material);
      const line =
        `[${m.group}] ${nameOf(m.material)} needs ${gap}: ` +
        `layout={${m.layout}} casts=${m.casts} receives=${m.receives}  e.g. ${m.example}` +
        (near ? `\n          warmed instead: layout={${near.layout}} casts=${near.casts}` : '\n          warmed instead: nothing -- this material has no part at all') +
        (m.visibleAtBoot ? '' : '\n          hidden at boot, so only a stand-in can ever warm it');
      failures.push(line.replace(/\n\s+/g, ' | '));
      console.log(`      - ${line}`);
    }
  }

  const realColour = new Set([...real.values()].map((m) => m.colourKey));
  const realDepth = new Set([...real.values()].filter((m) => m.depthKey).map((m) => m.depthKey));
  const unusedColour = [...warmColour.entries()].filter(([key]) => !realColour.has(key));
  const unusedDepth = [...warmDepth.entries()].filter(([key]) => !realDepth.has(key));

  console.log('');
  if (unusedColour.length === 0 && unusedDepth.length === 0) {
    console.log('    warm-up parts covering nothing real: none.');
  } else {
    console.log(
      `    ${unusedColour.length} colour and ${unusedDepth.length} depth pipelines are warmed for nothing ` +
        `this harness can build -- boot time, and often the other half of a miss:`,
    );
    for (const [, entry] of unusedColour) {
      // Distinguish the cases a reader has to act on differently. A part whose
      // layout matches nothing real is the overhead wire's bug. A part that
      // merely warmed the other `receiveShadow` variant is the default in
      // `WarmupPart.receives` doing its job -- the streamer really does flip a
      // tile from one to the other mid-walk -- and is not a defect.
      const sameMaterial = [...real.values()].filter((m) => m.material === entry.material);
      const sameLayout = sameMaterial.filter((m) => m.layout === entry.layout);
      const why = sameMaterial.length === 0
        ? 'no real mesh with this material (unbuildable here, or dead)'
        : sameLayout.length === 0
          ? `LAYOUT MISMATCH: the real mesh carries {${sameMaterial[0].layout}}`
          // A stand-in is a plain `Mesh` and has no skeleton, so its cache key
          // carries no bone count. Nothing can stand in for a skinned draw --
          // see `main.ts`'s `warmupExtras`, which hands over real actors -- and
          // a part built on a skinned *layout* is warming a pipeline that cannot
          // exist.
          : entry.bones === 0 && sameLayout.every((m) => Number(m.colourKey.split('|')[2]) > 0)
            ? `SKINNED: the real mesh has ${Number(sameLayout[0].colourKey.split('|')[2])} bones in its key and a stand-in Mesh has none`
            : 'only the other receiveShadow variant is real -- defensible, see WarmupPart.receives';
      console.log(
        `      - colour [${entry.group}] ${nameOf(entry.material)}  layout={${entry.layout}} ` +
          `receives=${entry.receives}  -- ${why}`,
      );
    }
    for (const [, entry] of unusedDepth) {
      console.log(
        `      - depth  [${entry.group}] ${nameOf(entry.material)}  layout={${entry.layout}} ` +
          `receives=${entry.receives}  -- nothing real with this layout casts a shadow`,
      );
    }
  }

  console.log('');
  console.log('    not audited, because this harness cannot build them:');
  for (const [what, why] of UNAUDITED) console.log(`      - ${what}: ${why}`);

  return { failures, rail };
}

/**
 * What a rail chunk costs to build, which is the *other* candidate for the same
 * report.
 *
 * Rail geometry is made and thrown away per 512 m chunk while the player moves
 * (`rail-geo.ts` section 3), so riding a train is a chunk build every few
 * seconds on a schedule set by the train's speed. That is real main-thread work
 * and it is position-driven rather than look-driven, so it would feel like a
 * regular tick rather than a hitch on turning -- which is why it is measured
 * here rather than assumed either way.
 *
 * Measured the way the streamer's budget would have to see it: one chunk at a
 * time, over a corridor with viaducts, tunnels and stations in it, reporting the
 * median and the worst rather than a mean. A mean over 900 chunks is dominated
 * by the empty ones.
 */
function railChunkProfile(rail: RailRide | null): void {
  console.log('');
  console.log('--- rail chunk builds (the per-512 m work a train ride pays for)');
  if (!rail) {
    console.log('    client/public/rail/rail.bin is missing; not measured.');
    return;
  }
  const { world, bake, route } = rail;
  // **A ride down the real polyline**, not a straight line across the map. The
  // ring is reshaped by where the player is, and a rule like "30 m west a step"
  // leaves the corridor inside a kilometre and then measures an empty ring
  // forever -- which reads as "chunk builds are free" and is the opposite of the
  // truth. The bake's own densified vertices for the longest direction are
  // exactly the path a train takes, so this is the schedule the report was made
  // on: `world/trains.ts` drives carriages along the same array.
  //
  // `rebuildMs` is the renderer's own counter, the one the debug overlay shows,
  // so a number argued with here is the same number argued with in a session.
  // Every densified vertex, which is a step of about 40 m -- a second and a bit
  // at line speed. Finer would be more frames reporting no work and would not
  // change what a build costs; coarser starts merging two transitions into one
  // step and flatters the count.
  const samples: number[] = [];
  const steps = route.vertexCount;
  for (let v = route.vertexOff; v < route.vertexOff + steps; v++) {
    const before = world.rebuildMs;
    world.update(bake.vertices[v * 3], bake.vertices[v * 3 + 2]);
    // `rebuildMs` is only written on a frame that built something, so an
    // unchanged value is a frame that did not -- which is most of them, and is
    // the point: the cost is a spike on a transition, not a per-frame load.
    if (world.rebuildMs !== before && world.rebuildMs > 0) samples.push(world.rebuildMs);
  }
  if (samples.length === 0) {
    console.log('    no chunks were built along the sample route.');
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const worst = sorted[sorted.length - 1];
  const km = route.lengthM / 1000;
  console.log(
    `    ${route.label}, ${km.toFixed(1)} km, ridden as ${steps} steps of ~${(route.lengthM / steps).toFixed(0)} m: ` +
      `${samples.length} of them built chunks, ${world.residentChunks} resident at the end.`,
  );
  console.log(
    `    median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, worst ${worst.toFixed(2)} ms per building frame.`,
  );
  console.log(
    `    ${(samples.length / km).toFixed(2)} building frames per km, so about one every ` +
      `${(1000 / (samples.length / km) / 30.5).toFixed(1)} s at a 110 km/h line speed -- which is the ` +
      `rate at which a rider meets one of the numbers above.`,
  );
  // --- What the worst frame is *made of*, which is the number that says whether
  //     the split is finished.
  //
  // WORKSTREAM AF. A chunk build is a cursor over steps under
  // `RAIL_BUILD_BUDGET_MS`, and the ceiling is a check between steps rather than
  // a pre-emption -- so the bound on a building frame is the budget plus the
  // worst single step, and the worst single step is the only part of that sum
  // that can grow silently. Printed by phase, because "4 ms" means three
  // different next moves depending on whether it is a station writer, a
  // `Solid.build` or one forty-metre segment.
  const names = chunkPhaseNames();
  const byPhase = [...world.worstStepByPhase]
    .map((ms, i) => `${names[i]} ${ms.toFixed(2)}`)
    .join(', ');
  console.log(
    `    ${world.chunksBuilt} chunks landed. Worst single step ${world.worstStepMs.toFixed(2)} ms ` +
      `(${world.worstStep || 'none'}); by phase: ${byPhase}.`,
  );
  console.log(
    `    A building frame is bounded by RAIL_BUILD_BUDGET_MS plus that worst step, because one ` +
      `segment, one station writer, one portal or one Solid.build always completes once started. ` +
      `A bun run is not a browser: read the shape, not the absolute.`,
  );
}

// --- The chunk builder's identity test -----------------------------------------
//
// WORKSTREAM AF. A chunk is built across frames now: eleven order-dependent
// accumulators advanced a step at a time, resuming on a cursor. The failure that
// arrangement invites is not a crash -- it is one segment written twice, or a
// station's stairs written before its platform, and both come out as
// ordinary-looking geometry that is quietly wrong somewhere in Sydney.
//
// So the same chunk is built twice through the same builder, once **one step per
// slice** and once **in a single slice**, and every buffer is compared.
//
// **What that does and does not prove, said plainly**, because an assertion
// whose limit is not written down gets trusted past it. It proves that no step
// depends on the frame it happens to run in: a writer that read the clock, a
// counter kept in a local instead of in the state, a resumption that lost a
// cursor would all show here, and so would a mesh order, a sleeper set or a
// prism list that is not a pure function of the chunk. It does **not** prove
// that the seams are where the old single-pass `buildChunk` wrote, because both
// runs go through the new builder.
//
// That second thing was proved once, at the commit, the only way it can be: by
// building 63 chunks -- the busiest station, the busiest junction throat, the
// most portals, the most masts and an even sweep of the rest -- through the
// pre-split `buildChunk` at `HEAD` and through this builder, and comparing 380
// meshes and **902,352 vertices**. They were identical, signs included. The old
// function is gone, so that check cannot live here; this one is what guards the
// seams from here on.

/** Exact, element for element. `Object.is` so a NaN vertex compares equal to itself. */
function sameNumbers(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Every buffer of one built chunk against another's. Empty when they agree. */
function sameChunk(
  key: string,
  sliced: { chunk: BuiltChunk; prisms: readonly SolidPrism[] },
  whole: { chunk: BuiltChunk; prisms: readonly SolidPrism[] },
): string[] {
  const bad: string[] = [];
  const a = sliced.chunk.group.children as Mesh[];
  const b = whole.chunk.group.children as Mesh[];
  if (a.length !== b.length) {
    bad.push(`chunk ${key}: ${a.length} meshes sliced, ${b.length} in one go`);
    return bad;
  }
  for (let i = 0; i < a.length; i++) {
    // The order of the meshes is the order the materials are built in, and it is
    // read by `countDraws` and by anything that greps the scene graph.
    if (a[i].name !== b[i].name) {
      bad.push(`chunk ${key}: mesh ${i} is "${a[i].name}" sliced and "${b[i].name}" in one go`);
      continue;
    }
    for (const attr of ['position', 'normal', 'uv']) {
      const pa = a[i].geometry.getAttribute(attr) as { array?: ArrayLike<number> } | undefined;
      const pb = b[i].geometry.getAttribute(attr) as { array?: ArrayLike<number> } | undefined;
      if (!sameNumbers(pa?.array, pb?.array)) {
        bad.push(
          `chunk ${key}: ${a[i].name}.${attr} differs ` +
            `(${pa?.array?.length ?? 'absent'} vs ${pb?.array?.length ?? 'absent'} values)`,
        );
      }
    }
    if (!sameNumbers(a[i].geometry.getIndex()?.array, b[i].geometry.getIndex()?.array)) {
      bad.push(`chunk ${key}: ${a[i].name} index differs`);
    }
  }
  // The sleeper source, which is order-dependent in exactly the same way and is
  // written from the segment phase rather than from a material.
  if (!sameNumbers(sliced.chunk.sleepers, whole.chunk.sleepers)) {
    bad.push(
      `chunk ${key}: the sleeper set differs ` +
        `(${sliced.chunk.sleepers.length} vs ${whole.chunk.sleepers.length} values)`,
    );
  }
  if (sliced.chunk.provisional !== whole.chunk.provisional) {
    bad.push(`chunk ${key}: provisional is ${sliced.chunk.provisional} sliced, ${whole.chunk.provisional} whole`);
  }
  // ...and the prisms, which are what a *body* meets. A chunk whose triangles
  // agree and whose collision does not is the worse of the two failures.
  if (sliced.prisms.length !== whole.prisms.length) {
    bad.push(`chunk ${key}: ${sliced.prisms.length} prisms sliced, ${whole.prisms.length} whole`);
  } else {
    for (let i = 0; i < sliced.prisms.length; i++) {
      const p = sliced.prisms[i];
      const q = whole.prisms[i];
      if (!sameNumbers(p.points, q.points) || !Object.is(p.height, q.height) || !Object.is(p.base, q.base)) {
        bad.push(`chunk ${key}: prism ${i} differs`);
        break;
      }
    }
  }
  return bad;
}

/** Free a specimen chunk. It never joined a scene, so its geometries are all it owns. */
function disposeSpecimen(built: { chunk: BuiltChunk }): void {
  for (const g of built.chunk.geometries) g.dispose();
}

/**
 * Build a spread of chunks both ways and prove they agree.
 *
 * The sample is chosen by what a chunk *contains* rather than by where it is,
 * because the phases are what is being tested: the busiest station, the busiest
 * junction throat, the most tunnel portals, a median plain-track chunk, and then
 * an even sweep of the rest so nothing about the choice is special pleading.
 *
 * A second `RailAssets` with its sign atlas prepared, and a second `RailWorld`
 * over the same network, so the last of the seven station steps -- the platform
 * blade and the street board, both of which need a name to have a cell in the
 * atlas -- is actually reached. The ride above keeps the unprepared assets, so
 * its numbers stay comparable with the ones in `RAIL_BUILD_BUDGET_MS`' header.
 */
function railChunkIdentity(rail: RailRide | null): string[] {
  console.log('');
  console.log('--- rail chunk identity: one step per slice against one slice, buffer for buffer');
  if (!rail) {
    console.log('    client/public/rail/rail.bin is missing; not checked.');
    return [];
  }
  const { net } = rail;
  const signed = new RailAssets();
  signed.prepareSigns(net.stations.map((s) => s.name));
  const world = new RailWorld(net, signed, FLAT);

  const entries = [...net.chunks.entries()];
  const pick = (label: string, score: (c: (typeof entries)[number][1]) => number): [string, string] | null => {
    let best: (typeof entries)[number] | null = null;
    let bestScore = 0;
    for (const e of entries) {
      const s = score(e[1]);
      if (s > bestScore) {
        bestScore = s;
        best = e;
      }
    }
    return best ? [best[0], `${label} (${bestScore})`] : null;
  };

  const chosen = new Map<string, string>();
  const add = (entry: [string, string] | null): void => {
    if (entry && !chosen.has(entry[0])) chosen.set(entry[0], entry[1]);
  };
  add(pick('the busiest station chunk', (c) => c.stations.length * 1000 + c.segments.length));
  add(pick('the busiest junction throat', (c) => c.segments.length));
  add(pick('the most tunnel portals', (c) => c.portals.length));
  add(pick('the most masts', (c) => c.masts.length));
  // A plain-track chunk at the median of the plain-track chunks: the common case,
  // and the one the other four are not.
  const plain = entries
    .filter(([, c]) => c.stations.length === 0 && c.portals.length === 0 && c.segments.length > 0)
    .sort((p, q) => p[1].segments.length - q[1].segments.length);
  if (plain.length) add([plain[plain.length >> 1][0], `a median plain-track chunk (${plain[plain.length >> 1][1].segments.length} segments)`]);
  // ...and an even sweep of everything else, so the sample is not four chunks
  // chosen because they are interesting.
  const stride = Math.max(1, Math.floor(entries.length / 20));
  for (let i = 0; i < entries.length; i += stride) add([entries[i][0], 'the even sweep']);

  const bad: string[] = [];
  let meshes = 0;
  let values = 0;
  for (const [key, why] of chosen) {
    // A negative budget is a deadline already past when the first step returns,
    // which is one step per slice -- the most divided the builder can be.
    const sliced = world.buildChunkSliced(key, -1);
    const whole = world.buildChunkSliced(key, Infinity);
    if (!sliced || !whole) {
      bad.push(`chunk ${key} (${why}) could not be built`);
      continue;
    }
    const failures = sameChunk(key, sliced, whole);
    if (failures.length) {
      bad.push(...failures.map((f) => `${f}  -- ${why}`));
    }
    meshes += sliced.chunk.group.children.length;
    for (const m of sliced.chunk.group.children as Mesh[]) {
      values += (m.geometry.getAttribute('position') as { count?: number } | undefined)?.count ?? 0;
    }
    disposeSpecimen(sliced);
    disposeSpecimen(whole);
  }
  console.log(
    `    ${chosen.size} chunks, ${meshes} meshes, ${values} vertices compared both ways ` +
      `(${[...chosen.values()].filter((v) => v !== 'the even sweep').join('; ')}).`,
  );
  if (bad.length === 0) console.log('    every buffer identical.');
  else for (const line of bad) console.log(`      - ${line}`);
  return bad;
}

/**
 * Walk away from a chunk while it is being built, and prove nothing is left.
 *
 * The invariant the split put at risk. Before it, a chunk that existed had
 * finished and the only way to stop owning one was `disposeChunk`; now a player
 * can cross `KEEP_RADIUS` with a station chunk half assembled behind them, and a
 * partial build holds geometries that no map is pointing at.
 *
 * Three assertions, and the third is the one that would not show up in a test
 * written without meaning to: the key is in none of the three states, the scene
 * holds nothing but finished chunks, and `RailWorld.liveGeometries` -- which
 * counts up in `addMesh` and down at every `dispose()` the class performs -- is
 * back to zero.
 */
function railChunkAbandon(rail: RailRide | null): string[] {
  console.log('');
  console.log('--- rail chunk abandonment: walk out of KEEP_RADIUS mid-build');
  if (!rail) {
    console.log('    client/public/rail/rail.bin is missing; not checked.');
    return [];
  }
  const { world, net } = rail;
  const bad: string[] = [];
  // Fixtures of the scene that are not chunks: the always-on corridor group and
  // the three instanced sets. Everything above this is a resident chunk.
  world.clear();
  const fixtures = world.group.children.length;
  if (world.liveGeometries !== 0) {
    bad.push(`clear() left ${world.liveGeometries} chunk geometries alive`);
  }

  // The busiest station chunk, because it is the one that cannot finish inside a
  // frame and so is certain to be caught half built.
  let key = '';
  let most = -1;
  for (const [k, c] of net.chunks) {
    const score = c.stations.length * 1000 + c.segments.length;
    if (score > most) {
      most = score;
      key = k;
    }
  }
  const [cx, cz] = key.split(',').map(Number);
  const x = (cx + 0.5) * CHUNK_M;
  const z = (cz + 0.5) * CHUNK_M;

  let caught = '';
  for (let f = 0; f < 400 && caught === ''; f++) {
    world.update(x, z);
    // The scene may never hold a part-built chunk. Checked every frame rather
    // than at the end, because "it appears atomically" is a claim about every
    // instant and not about the last one.
    if (world.group.children.length !== fixtures + world.residentChunks) {
      bad.push(
        `the scene holds ${world.group.children.length - fixtures} chunk groups ` +
          `for ${world.residentChunks} resident chunks`,
      );
      break;
    }
    if (world.buildingChunks === 1) caught = key;
  }
  if (caught === '' && bad.length === 0) {
    bad.push('no chunk was ever caught part-built, so this check proved nothing');
  }

  const resident = world.residentChunks;
  const live = world.liveGeometries;
  // Straight out of every radius, which is the teleport and also the walk taken
  // to its conclusion.
  world.update(x + KEEP_RADIUS * 4, z);
  if (world.buildingChunks !== 0) bad.push('a build survived the walk out of KEEP_RADIUS');
  if (world.residentChunks !== 0) bad.push(`${world.residentChunks} chunks survived out of range`);
  if (world.chunkStateOf(key) !== CHUNK_ABSENT) {
    bad.push(`the abandoned chunk ${key} is still in state ${world.chunkStateOf(key)}`);
  }
  if (world.group.children.length !== fixtures) {
    bad.push(`${world.group.children.length - fixtures} chunk groups are still in the scene`);
  }
  if (world.liveGeometries !== 0) {
    bad.push(`${world.liveGeometries} chunk geometries leaked (was ${live} before the walk)`);
  }
  console.log(
    `    caught chunk ${key} part-built with ${resident} resident and ${live} geometries live; ` +
      `after walking ${(KEEP_RADIUS * 4 / 1000).toFixed(1)} km off: ` +
      `${world.residentChunks} resident, ${world.buildingChunks} building, ${world.liveGeometries} live.`,
  );
  if (bad.length === 0) console.log('    nothing left behind.');
  else for (const line of bad) console.log(`      - ${line}`);
  return bad;
}

async function main(): Promise<void> {
  const argv = host.process?.argv ?? [];
  const frames = Number(argv[argv.indexOf('--frames') + 1]) || 600;
  const only = argv.indexOf('--scene') >= 0 ? argv[argv.indexOf('--scene') + 1] : null;
  // The audit alone, in about a second. That is the form this belongs in on a
  // pre-commit or in a reviewer's terminal: the scene tables take a minute and
  // answer a different question.
  const coverageOnly = argv.includes('--coverage');

  console.log(`SYDNEY frame harness -- CPU-side only, no device. world=${WORLD_DIR}`);
  if (!coverageOnly) {
    const rig = buildRenderers();
    for (const spec of SCENES) {
      if (only && spec.key !== only) continue;
      printTable(spec, await runScene(spec, frames, rig));
    }
  }
  const { failures, rail } = await warmupAudit();
  railChunkProfile(rail);
  // WORKSTREAM AF. The ride above is a measurement and these two are assertions,
  // so they run after it and in this order: the identity check builds its own
  // world and cannot disturb the ride's, and the abandonment check teleports the
  // ride's world and so must be the last thing to touch it.
  failures.push(...railChunkIdentity(rail));
  failures.push(...railChunkAbandon(rail));
  console.log('');
  if (!coverageOnly) {
    console.log('Sections marked "not covered" need a browser; the ?perf=1 strip reports them.');
  }
  if (failures.length > 0) {
    // Non-zero, on `server/tick-profile.ts`'s terms: a check nobody can fail is
    // a check nobody runs. The list above is the whole message; this line is for
    // the shell.
    console.log(`FAIL: ${failures.length} checks failed (warm-up coverage, chunk identity, abandonment).`);
    host.process?.exit(1);
  }
  console.log('warm-up coverage OK, chunk identity OK, abandonment OK.');
}

// `import.meta.main` is bun's; it is absent in the browser, where this module is
// never loaded at all (nothing imports it, so vite never sees it).
if ((import.meta as unknown as { main?: boolean }).main) {
  await main();
}
