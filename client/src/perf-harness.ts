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
 * No node imports and no bun types: the client's `tsconfig.json` has neither in
 * `types`, and adding them there to please one file would put `process` and
 * `Buffer` in scope for nine thousand lines of browser code. The three host
 * facilities this needs -- reading a file, reading `argv`, reading `env` -- go
 * through the narrow declared shims at the top of the file instead.
 */

import { PerspectiveCamera, Scene } from 'three/webgpu';

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
import { BatAssets } from './player/bat.ts';
import { FootyAssets, footyWarmupParts } from './world/footyball.ts';
import { Tracers, policeWarmupParts } from './world/police.ts';
import { highwayPatrolWarmupParts } from './world/highway-patrol.ts';
import { streetlifeWarmupParts } from './world/streetlife.ts';
import { characterWarmupParts } from './world/characters.ts';
import { eventWarmupParts } from './world/events.ts';
import { RaveAssets, raveWarmupParts } from './world/rave.ts';
import { RailAssets, railWarmupParts } from './world/rail-geo.ts';
import { BigNightKit, TeamRingField, teamLookWarmupParts } from './world/teamlook.ts';
import { warmupSignature, type WarmupPart } from './world/warmup.ts';

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

/**
 * How much of the boot shader warm-up is the same pipeline twice.
 *
 * The other half of what this file is for. `main.ts` assembles the parts list
 * out of nine independent contributors and none of them can see the others, so
 * the collisions are only visible in aggregate -- which is to say, only from
 * something that builds all nine and counts. That is exactly what a harness is,
 * and it is why this lives here rather than in a comment somebody has to
 * believe.
 *
 * The streamer's twenty slot materials and the nameplate field are missing: the
 * first needs a `TileStreamer` and therefore `fetch`, the second builds a canvas
 * texture. Both are named in the output so the total is not read as the whole
 * boot pass.
 */
function warmupCensus(): void {
  const chars = new CharacterAssets();
  const bats = new BatAssets();
  const groups: Array<[string, readonly WarmupPart[]]> = [
    ['footy', footyWarmupParts(new FootyAssets())],
    ['bat', [{ geometry: bats.geometry, material: bats.material, casts: true }]],
    ['police', policeWarmupParts(new PoliceAssets(chars), new Tracers())],
    ['patrol', highwayPatrolWarmupParts(new HighwayPatrolAssets())],
    ['street', streetlifeWarmupParts(new StreetlifeAssets(chars))],
    ['characters', characterWarmupParts(new CharacterKitAssets(chars))],
    ['events', eventWarmupParts(new EventAssets())],
    ['rave', raveWarmupParts(new RaveAssets())],
    ['rail', railWarmupParts(new RailAssets())],
    ['teams', teamLookWarmupParts(new BigNightKit(chars), chars, new TeamRingField())],
  ];
  console.log('');
  console.log('--- the boot shader warm-up, deduped');
  console.log(`    ${'group'.padEnd(12)}${'parts'.padStart(6)}${'draws'.padStart(7)}${'pipelines'.padStart(11)}`);
  const all = new Set<string>();
  let draws = 0;
  for (const [name, parts] of groups) {
    const seen = new Set<string>();
    let d = 0;
    for (const part of parts) {
      for (const receive of part.receives ?? [false, true]) {
        d++;
        const signature = warmupSignature(part, receive);
        seen.add(signature);
        all.add(signature);
      }
    }
    draws += d;
    console.log(`    ${name.padEnd(12)}${String(parts.length).padStart(6)}${String(d).padStart(7)}${String(seen.size).padStart(11)}`);
  }
  console.log(
    `    ${'TOTAL'.padEnd(12)}${''.padStart(6)}${String(draws).padStart(7)}${String(all.size).padStart(11)}  ` +
      `-- ${draws - all.size} duplicate draws dropped (${((1 - all.size / draws) * 100).toFixed(0)}%)`,
  );
  console.log('    (the streamer\'s 20 slot materials and the nameplate field need fetch/canvas and are not counted)');
}

async function main(): Promise<void> {
  const argv = host.process?.argv ?? [];
  const frames = Number(argv[argv.indexOf('--frames') + 1]) || 600;
  const only = argv.indexOf('--scene') >= 0 ? argv[argv.indexOf('--scene') + 1] : null;

  console.log(`SYDNEY frame harness -- CPU-side only, no device. world=${WORLD_DIR}`);
  const rig = buildRenderers();
  for (const spec of SCENES) {
    if (only && spec.key !== only) continue;
    printTable(spec, await runScene(spec, frames, rig));
  }
  warmupCensus();
  console.log('');
  console.log('Sections marked "not covered" need a browser; the ?perf=1 strip reports them.');
}

// `import.meta.main` is bun's; it is absent in the browser, where this module is
// never loaded at all (nothing imports it, so vite never sees it).
if ((import.meta as unknown as { main?: boolean }).main) {
  await main();
}
