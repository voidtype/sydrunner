/**
 * The city, on the server, off the disk.
 *
 * Spec section 5: *"collision is always the simplified prism, never derived from
 * render meshes at runtime"*, and `player/collision.ts`'s own header says the
 * quiet part -- *"the same file is what the authoritative server will load"*.
 * This is that day. Nothing here parses anything: `CollisionWorld.addTile`,
 * `decodeTerrain` and `decodePowerups` are the client's decoders, imported
 * across the directory boundary and handed bytes.
 *
 * ---------------------------------------------------------------------------
 * Everything is loaded at boot, and the alternative was measured rather than
 * assumed.
 *
 * The client streams because it has to draw 326 MB of geometry and cannot hold
 * it. The server draws nothing, and what it needs is 2.4 MB of collision
 * prisms, 249 kB of terrain grids and 14 kB of powerup points -- 2.7 MB for the
 * whole inner ring, which is less than a single tile's GLB. A lazy per-tile
 * loader would be a cache, an eviction policy, an in-flight map and a await
 * inside the 60 Hz tick, all to avoid holding three megabytes.
 *
 * The 15 km middle ring is about twelve times the tiles, so 32 MB, which is
 * still nothing. If the full extent ever changes that, the seam is `loadWorld`
 * taking a radius.
 *
 * ---------------------------------------------------------------------------
 * The one thing this file must get exactly right is the tile origin, because
 * getting it wrong is invisible.
 *
 * Collision prisms are stored **tile-local** and are offset into world space on
 * decode. `main.ts` passes `(bounds[0], bounds[1] + tile_size)`, which reads
 * oddly until you write the frame down: a tile's bounds are
 * `[minX, minZ, maxX, maxZ]` in a **north-positive** frame, and the renderer's
 * z runs *south*. So the tile's local origin -- its south-west corner in ENU --
 * is at world z `-(bounds[1])`... except that the sidecar's local z is already
 * negative-going, which makes the offset `bounds[1] + tile_size`. It is copied
 * from `main.ts` verbatim rather than re-derived for that reason: a server whose
 * prisms are one tile north of the client's produces a game where players walk
 * through buildings and are stopped by empty air, and there is no frame on
 * either end that says so.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField, decodeTerrain } from '../client/src/world/terrain.ts';
import { decodePowerups } from '../client/src/world/powerups.ts';
import { PowerupField, type PowerupPoint } from '../client/src/game/powerups.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { TrafficField, decodeLanes } from '../client/src/game/traffic.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { spawnCentre } from '../client/src/game/spawn.ts';
import type { CombatWorld } from '../client/src/game/combat.ts';

export interface TileEntry {
  key: string;
  /** `[minX, minZ, maxX, maxZ]`, north-positive. */
  bounds: [number, number, number, number];
  /**
   * Buildings in the tile.
   *
   * Picks a spawn, as `main.ts` does -- and, since the walk-under rule, splits
   * this tile's payload into structures and buildings for `CollisionWorld`. See
   * the `addTile` call in `loadWorld`.
   */
  b: number;
  /**
   * The water surface over this tile, world y, absent where there is none.
   *
   * The only field in the index this process reads that is not about *finding* a
   * file, and it is here because the wading rule has to be authoritative: a
   * client that predicted wading and a server that did not would fight over
   * every shoreline in the city. Both build the same table from this same field
   * -- see `client/src/world/wading.ts`, which is the whole of the agreement.
   */
  wy?: number;
}

export interface WorldIndex {
  stage: string;
  /**
   * The radius this build actually covers, metres -- the pipeline's own
   * statement of what it wrote. Read by `integration-check`'s coverage gate so
   * a table baked for a stage the world has not been rebuilt to yet is judged
   * against the ground that exists rather than against the ground it will have.
   */
  radius_m: number;
  tile_size: number;
  terrain: { grid: number; datum_ahd: number; sea_level_y: number };
  tiles: TileEntry[];
}

/**
 * The loaded world, plus the `CombatWorld` the shared simulation runs against.
 *
 * `ground` is deliberately **not** `CombatWorld.groundHeight`: that signature
 * takes a feet height and answers "how high is the world here", which folds in
 * roofs and therefore depends on who is asking. See `groundFor`.
 */
export interface ServerWorld {
  index: WorldIndex;
  collision: CollisionWorld;
  terrain: TerrainField;
  /**
   * Where the water is, from the index. Built here rather than derived per
   * combatant because it is immutable for the life of the process and is the
   * same object every `CombatWorld` reads.
   */
  water: WaterLevels;
  powerups: PowerupField;
  /** Every point, flat, in the order the fields were adopted. Ticked whole. */
  points: readonly PowerupPoint[];
  /** Tile keys that had a powerup sidecar, so a pickup can name its tile. */
  tileOf: Map<string, { tileX: number; tileZ: number }>;
  /**
   * Every lane graph in the extent, and therefore every moving car.
   *
   * Adopted whole at boot like everything else here: the routes for the inner
   * ring are 1.4 MB, which is half a tile's GLB, and a server that streamed them
   * would be a cache with an `await` in a 60 Hz tick to avoid holding a
   * megabyte. Nothing about a car is ever sent to a client -- both ends evaluate
   * the same baked timetable at the same wall-clock tick. See `game/traffic.ts`.
   */
  traffic: TrafficField;
  /**
   * The footpaths, and therefore every walker and every officer on a beat.
   *
   * Derived from the **same decoded lane sidecar** the traffic is, in the same
   * loop, at no extra I/O -- `buildBands` reads the ways block the routes come
   * from and offsets it, which `game/pedestrians.ts` documents at length. That
   * is the whole reason this could be added to the server without a new file
   * format: the pipeline already emitted the geometry a footpath is derived
   * from, for the traffic.
   *
   * The server needs it for one reason and it is the police: a crime has to be
   * witnessed *here* rather than claimed by a client, and a witness is an
   * officer on a beat, and a beat is a reserved slot on one of these bands. The
   * crowd itself is still cosmetic and still client-local -- nothing on this
   * process poses a pedestrian except to re-run a strike a client claims to have
   * landed, which is exactly what `Sim.resolveStrike` now does.
   */
  peds: PedestrianField;
  bytes: { collision: number; terrain: number; powerups: number; lanes: number };
  /**
   * The decoded powerup sidecars, kept so a second room can have its own field
   * without a second read of the disk. See `roomWorld`.
   *
   * 14 kB for the inner ring, held for the life of the process. The alternative
   * -- re-reading and re-decoding 372 files per room -- would be 2.9 MB of I/O
   * and about 300 ms of boot **per room**, to produce arrays identical to these.
   */
  powerupSource: ReadonlyArray<{
    tileKey: string;
    kind: Uint8Array;
    worldX: Float32Array;
    worldY: Float32Array;
    worldZ: Float32Array;
  }>;
  /**
   * The **centre** of the join disc: Sydney Park, or the nearest point to it the
   * built extent can hold. See `game/spawn.ts`, which both ends compute from
   * this same index -- nobody is placed *on* it. `Sim.joinSpot` draws a
   * dithered point out of the disc around it, per join.
   */
  spawn: { x: number; z: number };
}

/**
 * Read the whole extent.
 *
 * `root` is the directory the client serves tiles from -- `client/public/world`
 * -- which is the same path a browser fetches them over. Spec 9's answer was
 * "static tiles", so the server reads the files and serves none of them: vite
 * (or any static host) keeps that job, and this process never learns what a GLB
 * is.
 */
export async function loadWorld(root: string): Promise<ServerWorld> {
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as WorldIndex;

  const collision = new CollisionWorld();
  const terrain = new TerrainField(index.terrain.grid, index.tile_size, root);
  const powerups = new PowerupField();
  const tileOf = new Map<string, { tileX: number; tileZ: number }>();
  const points: PowerupPoint[] = [];
  const traffic = new TrafficField();
  const peds = new PedestrianField();
  const bytes = { collision: 0, terrain: 0, powerups: 0, lanes: 0 };
  const powerupSource: Array<{
    tileKey: string;
    kind: Uint8Array;
    worldX: Float32Array;
    worldY: Float32Array;
    worldZ: Float32Array;
  }> = [];

  // In parallel, because 663 small reads serialised behind each other is two
  // seconds of boot on a spinning disk and about 300 ms on this one -- and
  // because nothing here depends on anything else here.
  await Promise.all(
    index.tiles.map(async (entry) => {
      const [tileX, tileZ] = entry.key.split('_').map(Number);
      tileOf.set(entry.key, { tileX, tileZ });

      const prisms = await readOptional(join(root, 'collision', `${entry.key}.bin`));
      if (prisms) {
        bytes.collision += prisms.byteLength;
        // The offset `main.ts` uses, verbatim. See the header.
        //
        // **And the building count with it, which is now physics rather than a
        // map feature.** It marks the deck, viaduct and bridge volumes written
        // ahead of the buildings as `Prism.structural`, and `resolve` reads that
        // flag to decide whether a prism's `base` is a soffit to walk under or a
        // pad with a skirt drawn to the ground. A server that left it out would
        // hold the Cahill solid at street level while every client walked under
        // it -- the two authorities running different worlds, which is the one
        // thing this file exists to prevent. Client side it is `main.ts`'s
        // `entry.b` on the same index.
        collision.addTile(
          entry.key,
          prisms,
          entry.bounds[0],
          entry.bounds[1] + index.tile_size,
          entry.b,
        );
      }

      const grid = await readOptional(join(root, 'tiles', `${entry.key}.terr.bin`));
      if (grid) {
        const decoded = decodeTerrain(grid, index.terrain.grid);
        if (decoded) {
          bytes.terrain += grid.byteLength;
          terrain.adopt(entry.key, decoded);
        }
      }

      const picks = await readOptional(join(root, 'tiles', `${entry.key}.pow.bin`));
      if (picks) {
        const data = decodePowerups(picks);
        if (data) {
          bytes.powerups += picks.byteLength;
          // Tile-local to world, the conversion `streamer.ts` makes once on its
          // side. The tile group sits at `(bounds[0], 0, bounds[1] + tile_size)`
          // and `groundY` is already absolute.
          const originX = entry.bounds[0];
          const originZ = entry.bounds[1] + index.tile_size;
          const worldX = new Float32Array(data.count);
          const worldZ = new Float32Array(data.count);
          for (let i = 0; i < data.count; i++) {
            worldX[i] = data.x[i] + originX;
            worldZ[i] = data.z[i] + originZ;
          }
          powerups.adopt(entry.key, data.kind, worldX, data.groundY, worldZ);
          // Kept for `roomWorld`. `PowerupField.adopt` builds fresh
          // `PowerupPoint` objects from these arrays, so a second field built
          // from the same four typed arrays shares no mutable state with the
          // first -- which is the whole property a room needs.
          powerupSource.push({ tileKey: entry.key, kind: data.kind, worldX, worldY: data.groundY, worldZ });
        }
      }

      // The lane graph. Decoded straight into world metres by the same offset
      // the prisms use, because a car route runs out of its own tile and has no
      // group to inherit a translation from -- the client applies the identical
      // pair in `streamer.loadLanes`, and the two agreeing is what makes a
      // predicted knockdown and an authoritative one the same event.
      const lanes = await readOptional(join(root, 'tiles', `${entry.key}.lanes.bin`));
      if (lanes) {
        const decoded = decodeLanes(
          lanes,
          entry.bounds[0],
          entry.bounds[1] + index.tile_size,
        );
        if (decoded) {
          bytes.lanes += lanes.byteLength;
          traffic.adopt(entry.key, decoded);
          // The footpaths, off the same decoded object. One file, two consumers,
          // and no second decode -- `PedestrianField.adopt` derives its bands
          // from the ways block the routes were built beside.
          peds.adopt(entry.key, decoded);
        }
      }
    }),
  );

  // Every tile is resident on the server, so `resident()` is the whole world and
  // is snapshotted once rather than rebuilt per tick. `PowerupField` rebuilds
  // its flat array only when the resident set changes, which after boot is
  // never -- but taking a copy makes that a guarantee rather than an
  // implementation detail being relied on from another package.
  points.push(...powerups.resident());

  return {
    index,
    collision,
    terrain,
    // One table for the process, off the index that has already been read. No
    // file is opened for it and none needs to be: a tile's water *level* is one
    // float in the index, and the sheets themselves are geometry this process
    // never draws.
    water: WaterLevels.fromIndex(index.tiles, index.tile_size),
    powerups,
    traffic,
    peds,
    points,
    tileOf,
    bytes,
    powerupSource,
    spawn: spawnCentre(index),
  };
}

/**
 * A world for one room: the same city, its own coffees.
 *
 * PERFORMANCE.md phase 3. A host process runs R rooms and **loads the city
 * once** -- 2.4 MB of collision prisms, 249 kB of terrain and 1.4 MB of lane
 * graphs, which at eight rooms would otherwise be 33 MB and eight times the boot
 * -- so everything in a `ServerWorld` that is read-only is shared by reference
 * and nothing else is.
 *
 * **Exactly one field is not read-only, and finding it is the whole of this
 * function.** `PowerupPoint.active` and `PowerupPoint.respawnT` are mutated by
 * `tickPowerups` sixty times a second, so two rooms sharing a `PowerupField`
 * would be taking each other's coffees: a flat white collected in room 3 would
 * vanish from the pavement in room 5 and come back on room 3's clock. The
 * integration check already knew this -- `checkSpatialHash` builds its two
 * `Simulation`s against two separately-loaded worlds and says so in as many
 * words -- and this is that observation turned into the seam it implied.
 *
 * Everything else was audited and is genuinely immutable after load:
 *
 *   - `CollisionWorld` holds a per-query `seen` stamp on each prism, which is
 *     scratch *within* one synchronous query. Rooms tick one after another and
 *     never interleave inside a query, so the stamp is never observed across
 *     rooms. (This is the same property `game/powerups.ts`'s module scratch
 *     already relies on, asserted by `checkSpatialHash` section 7.)
 *   - `TerrainField`, `WaterLevels` and `TrafficField` are lookup tables. A car
 *     is a pure function of `trafficTick(Date.now())` -- see `game/traffic.ts`
 *     -- so every room sees the same fleet on the same timetable, which is
 *     correct: the traffic is the city, not the match.
 *   - `PedestrianField` is bands derived from the lane graph; the crowd's poses
 *     are computed into caller-owned scratch (`Simulation` holds its own).
 *   - `index`, `tileOf` and `spawn` are data.
 *
 * The bikes are **not** here and are per room by construction: `BikeField` lives
 * on the `Simulation`, so each room lays out and claims its own 74 bikes from
 * the same deterministic plan. Two rooms therefore have a bike 12 in the same
 * place with different riders, which is exactly right.
 */
export function roomWorld(shared: ServerWorld): ServerWorld {
  const powerups = new PowerupField();
  for (const src of shared.powerupSource) {
    powerups.adopt(src.tileKey, src.kind, src.worldX, src.worldY, src.worldZ);
  }
  return {
    ...shared,
    powerups,
    // Snapshotted once, exactly as `loadWorld` does it and for its reason: every
    // tile is resident on a server, so the resident set never changes after
    // this and the flat array can be taken as a guarantee rather than as an
    // implementation detail relied on from another package.
    points: [...powerups.resident()],
  };
}

async function readOptional(path: string): Promise<ArrayBuffer | null> {
  try {
    const buf = await readFile(path);
    // `Buffer` is a view into a pooled `ArrayBuffer`, so handing `buf.buffer`
    // to a `DataView` reads whatever else Node put in that pool. The slice is
    // not defensive; without it every decoder in this project reads garbage.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

/**
 * A `CombatWorld` for one combatant, carrying its own last-known ground.
 *
 * Per combatant rather than one for the process, and `main.ts` makes the same
 * split for the same reason: `groundHeightAt` folds in `collision.roofHeight`,
 * which asks "what am I standing on" and can only be answered relative to how
 * high the asker already is. One shared `lastGround` would let a player walking
 * past a warehouse inherit the height of whoever was standing on its roof.
 *
 * The `NaN` fallback is `main.ts`'s verbatim: an unloaded tile must hold the
 * last height rather than claim zero, because zero is the ENU datum and is
 * thirty to forty metres above most of the city. On the server every tile is
 * loaded, so the only place it fires is over the harbour -- where there is no
 * tile at all and never will be until something renders water.
 */
export function groundFor(world: ServerWorld): CombatWorld {
  let lastGround = 0;
  return {
    collision: world.collision,
    groundHeight(x: number, z: number, feetY: number): number {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      return Math.max(lastGround, world.collision.roofHeight(x, z, feetY));
    },
    // Shared rather than per combatant, unlike the ground above it: this one
    // carries no state at all, because where the water is does not depend on who
    // is asking. The client's `main.ts` passes the identical closure over the
    // identical table, which is what makes a predicted wade and an authoritative
    // one the same trajectory.
    waterSurface(x: number, z: number): number {
      return world.water.surfaceAt(x, z);
    },
  };
}

/** The eye height at a spawn point, which is what `PlayerState.position` carries. */
export function eyeAt(world: CombatWorld, x: number, z: number): number {
  // `Infinity` for the feet, exactly as `main.ts` does when it places the local
  // player: a spawn is a tile centre and a tile centre lands inside a footprint
  // often enough to matter, and standing on the building has always been a
  // better answer there than starting inside it.
  return world.groundHeight(x, z, Infinity) + EYE_HEIGHT;
}
