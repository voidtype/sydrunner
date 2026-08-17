/**
 * Where a session starts: Sydney Park, plus a hundred metres of dither.
 *
 * The instruction was a dropped pin -- `-33.9094023, 151.1842644` -- and a
 * radius: "init you right in sydney park with some random dither for ~100m".
 * This file is the whole of that, and it is shared rather than duplicated
 * because three call sites have to agree about it:
 *
 *   - `client/src/main.ts`, which places the offline player at boot;
 *   - `server/world.ts`, which resolves the disc centre once per process;
 *   - `server/sim.ts`, which draws one point out of the disc per join.
 *
 * A client whose idea of the spawn differs from the server's is a client that
 * loads the wrong tiles at boot and then gets teleported when the welcome
 * arrives, so the *centre* is a pure function of `index.json` and is computed
 * identically on both ends. Only the dither is random, and it is drawn per join
 * rather than per build: sixteen players landing on one point spawn inside each
 * other, which is what the ring in `sim.joinSpot` used to exist to prevent.
 *
 * This module is deliberately three.js-free, on `world/wading.ts`'s argument:
 * the server imports it and the server draws nothing. It takes its world as a
 * structural interface (`SpawnWorld`) that `game/combat.ts`'s `CombatWorld`
 * already satisfies, so neither end has to build anything new to ask it a
 * question.
 *
 * ---------------------------------------------------------------------------
 * The one thing worth reading before changing anything here: **the pin is
 * outside the built world**, and by more than a rounding error.
 *
 * The pin projects to ENU (east -2,236.4, north -4,543.3), which is 5,063.9 m
 * from the Town Hall origin. Stage `inner` is a 4,000 m radius (see
 * `pipeline/sydney/config.py`), and the tile test is "any part of the tile
 * within the radius", so the furthest tile in that bearing is `-4_-8` and the
 * world simply stops at world z = 4,000 west of x = -1,500. Sydney Park -- all
 * of it, ponds, kilns and hills -- is in the hole.
 *
 * Hard-coding the pin would therefore spawn the player over nothing: no terrain
 * grid, no collision, no water table, and `groundHeight` answering with whoever
 * asked last. So `spawnCentre` **aims** at the pin and lands on the closest
 * point to it where a whole dither disc is still on built ground. Today that is
 * ~753 m short, in Erskineville. The day the extent grows past 5.2 km -- stage
 * `middle` is 15 km -- the same function returns the pin itself with no code
 * change, which is the reason it is a search over `index.json` rather than a
 * second hard-coded coordinate.
 */

import { NO_WATER, waterDepth } from '../world/wading.ts';

// --- The pin ------------------------------------------------------------------

/**
 * The dropped pin, and its projection into the local frame.
 *
 * The ENU pair is `pipeline/sydney/geo.lonlat_to_enu` run over the geodetic
 * pair, i.e. EPSG:4326 -> EPSG:7856 (MGA2020 zone 56) minus the projected
 * origin at Town Hall (-33.8688, 151.2093):
 *
 *     from pyproj import Transformer
 *     t = Transformer.from_crs('EPSG:4326', 'EPSG:7856', always_xy=True)
 *     ox, oy = t.transform(151.2093, -33.8688)
 *     e, n = t.transform(151.1842644, -33.9094023)
 *     (e - ox, n - oy)  # (-2236.379, -4543.317)
 *
 * Written out rather than computed because nothing on either end of this game
 * links a projection library, and a pin does not move.
 */
export const SPAWN_PIN = {
  lat: -33.9094023,
  lon: 151.1842644,
  /** Metres east of the origin. */
  east: -2236.379,
  /** Metres north of the origin, so negative for anything south of Town Hall. */
  north: -4543.317,
} as const;

/**
 * The pin in renderer coordinates: x = east, **z = -north**.
 *
 * The sign is the one thing in this file that would be invisible if it were
 * wrong -- it would put the spawn in Chatswood rather than St Peters -- so it is
 * derived here from `SPAWN_PIN` rather than typed twice, and `verifySpawn`
 * asserts it against the tile-key arithmetic that `world/wading.ts` and
 * `world/terrain.ts` both use.
 */
export const SPAWN_TARGET = { x: SPAWN_PIN.east, z: -SPAWN_PIN.north } as const;

// --- The disc -----------------------------------------------------------------

/** "~100 m", as asked. Points are drawn uniformly over the disc, not the radius. */
export const SPAWN_DITHER_RADIUS = 100;

/**
 * How much built ground a centre needs around it before it is allowed.
 *
 * The dither radius plus a margin: a player at the rim still has to have terrain
 * under the whole capsule, prisms loaded to be pushed out of, and somewhere to
 * walk. Twenty metres is about four seconds at a walk, which is long enough for
 * the streamer to have answered by the time anybody reaches the edge.
 */
export const SPAWN_FIT_RADIUS = SPAWN_DITHER_RADIUS + 20;

/**
 * How many candidates a draw gets before it gives up and takes the centre.
 *
 * Bounded because this runs inside `join`, on the tick thread, and a spawn rule
 * that can spin is a server that can stall. Sixty-four uniform draws over a disc
 * where even a third of the area is valid miss with probability 1e-11.
 */
export const SPAWN_ATTEMPTS = 64;

/**
 * The deepest water a spawn may stand in, metres.
 *
 * Sydney Park's ponds are the reason this exists at all -- they are wide, they
 * are shallow, and `world/wading.ts` starts slowing a player at 0.15 m. A spawn
 * that begins already wading is a spawn that begins at 45% speed, so the
 * threshold sits just above the wading floor rather than at the ceiling.
 */
export const SPAWN_MAX_DEPTH = 0.2;

/**
 * How far a candidate's ground may differ from the centre's, metres.
 *
 * A sanity bound rather than a taste one. Sydney Park's own hills are about
 * 20 m of relief, so this cannot be tight; what it catches is a sample that came
 * back with a stale height because a tile has not decoded yet, or one standing
 * on top of something the prism test let through.
 */
export const SPAWN_MAX_RELIEF = 25;

/**
 * The capsule the clearance probes use, and the height they ignore obstacles
 * below.
 *
 * Copies of `player/controller.ts`'s `PLAYER_RADIUS` and its private
 * `STEP_HEIGHT`, duplicated here for the reason `world/wading.ts` duplicates
 * `TerrainField`'s tile arithmetic: that module imports three and this one must
 * not. The duplication is guarded rather than trusted -- `checkSpawn` in
 * `server/integration-check.ts` asserts this against the real constant.
 */
export const SPAWN_PROBE_RADIUS = 0.34;
export const SPAWN_STEP_HEIGHT = 0.42;

/**
 * How much elbow room a spawn needs, metres, checked on four sides.
 *
 * `pickRespawn` uses 1.5 m for a KO respawn because that is a point a fight
 * resumes at. This is a fraction lower: a spawn in parkland is not a spawn in a
 * street, and 1.2 m is "not wedged against a fence" rather than "in the open".
 */
export const SPAWN_CLEARANCE = 1.2;

// --- What this needs of a world ------------------------------------------------

/**
 * The world, as this file wants it: a ground query, the prisms, and where the
 * water is.
 *
 * Structural rather than an import of `CombatWorld`, so this module stays free
 * of everything that type drags in. Both ends' `CombatWorld` satisfies it as
 * written, and `collision` is allowed to be null -- offline, at boot, before the
 * first sidecar has landed, that is exactly the state the client is in.
 */
export interface SpawnWorld {
  collision: {
    resolve(
      fromX: number,
      fromZ: number,
      toX: number,
      toZ: number,
      radius: number,
      feetY: number,
    ): { hit: boolean };
  } | null;
  groundHeight(x: number, z: number, feetY: number): number;
  waterSurface?(x: number, z: number): number;
}

/** As much of `index.json` as the centre depends on. */
export interface SpawnIndex {
  tile_size: number;
  tiles: ReadonlyArray<{ key: string; bounds: readonly number[] }>;
}

// --- The centre ----------------------------------------------------------------

/** Grid resolution of the coarse scan, metres. A tile is 500 m, so 51x51 points. */
const SCAN_STEP = 10;
/** Bisections used to slide the coarse pick toward the pin. 24 lands inside a millimetre. */
const REFINE_STEPS = 24;

/**
 * The centre of the spawn disc: the pin, or the closest point to it that the
 * built world can actually hold.
 *
 * Pure, deterministic, and a function of `index.json` alone -- that is what lets
 * `main.ts` and `server/world.ts` compute it separately and agree. It is called
 * once per process; the ~50k set lookups it costs in the miss case are boot-time
 * and invisible.
 *
 * The fit test is a **tile-box** test rather than a disc test: a 120 m disc
 * spans at most a 2x2 block of 500 m tiles, so "every tile the disc's bounding
 * square touches exists" is exact enough to be safe and errs, by at most 35 m of
 * reach, on the side of not spawning anybody over a hole.
 *
 * The shrinking fit radii are for a world that is too small to hold a disc at
 * all -- a synthetic index in a test, or a single-tile build. A tighter spawn is
 * a better answer there than no spawn.
 */
export function spawnCentre(index: SpawnIndex): { x: number; z: number } {
  const size = index.tile_size > 0 ? index.tile_size : 500;
  const keys = new Set<string>();
  for (const t of index.tiles) keys.add(t.key);

  /**
   * Is every tile under this disc built?
   *
   * `tz` is derived from `-z` because world z runs south and ENU north does not
   * -- the same three lines `WaterLevels.surfaceAt` and `TerrainField.height`
   * both carry, and the same three lines that put the harbour 500 m from where
   * it is drawn when they are got wrong.
   */
  const covered = (x: number, z: number, fit: number): boolean => {
    const tx0 = Math.floor((x - fit) / size);
    const tx1 = Math.floor((x + fit) / size);
    const tz0 = Math.floor((-z - fit) / size);
    const tz1 = Math.floor((-z + fit) / size);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let tz = tz0; tz <= tz1; tz++) {
        if (!keys.has(`${tx}_${tz}`)) return false;
      }
    }
    return true;
  };

  const nearest = (fit: number): { x: number; z: number } | null => {
    // The whole point of the exercise: if the pin itself is buildable ground,
    // the answer is the pin and nothing below runs.
    if (covered(SPAWN_TARGET.x, SPAWN_TARGET.z, fit)) {
      return { x: SPAWN_TARGET.x, z: SPAWN_TARGET.z };
    }

    // Nearest tiles first, so the scan stops after a handful rather than walking
    // 221 tiles on the far side of the city.
    const order = index.tiles
      .map((t) => ({ bounds: t.bounds, gap: rectGap(t.bounds, SPAWN_TARGET.x, SPAWN_TARGET.z) }))
      .sort((a, b) => a.gap - b.gap);

    let best: { x: number; z: number } | null = null;
    let bestGap = Infinity;
    for (const { bounds, gap } of order) {
      if (gap > bestGap) break;
      const stepsX = Math.max(1, Math.round((bounds[2] - bounds[0]) / SCAN_STEP));
      const stepsZ = Math.max(1, Math.round((bounds[3] - bounds[1]) / SCAN_STEP));
      for (let i = 0; i <= stepsX; i++) {
        const x = bounds[0] + ((bounds[2] - bounds[0]) * i) / stepsX;
        for (let j = 0; j <= stepsZ; j++) {
          const z = bounds[1] + ((bounds[3] - bounds[1]) * j) / stepsZ;
          const d = Math.hypot(x - SPAWN_TARGET.x, z - SPAWN_TARGET.z);
          if (d >= bestGap) continue;
          if (!covered(x, z, fit)) continue;
          bestGap = d;
          best = { x, z };
        }
      }
    }
    if (!best) return null;

    // The scan lands on a 10 m lattice; this slides the pick along the line to
    // the pin until the disc stops fitting, which is worth up to another 10 m of
    // Sydney Park and costs 24 box tests.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < REFINE_STEPS; i++) {
      const mid = (lo + hi) / 2;
      const x = best.x + (SPAWN_TARGET.x - best.x) * mid;
      const z = best.z + (SPAWN_TARGET.z - best.z) * mid;
      if (covered(x, z, fit)) lo = mid;
      else hi = mid;
    }
    return {
      // Rounded to the centimetre so the number that ends up in a log, a welcome
      // packet and a bug report is the same number. Both ends round identically.
      x: Math.round((best.x + (SPAWN_TARGET.x - best.x) * lo) * 100) / 100,
      z: Math.round((best.z + (SPAWN_TARGET.z - best.z) * lo) * 100) / 100,
    };
  };

  for (const fit of [SPAWN_FIT_RADIUS, SPAWN_FIT_RADIUS / 2, 0]) {
    const found = nearest(fit);
    if (found) return found;
  }
  // An index with no tiles in it. The origin is as good an answer as exists, and
  // the callers all treat the ground under it as unknown anyway.
  return { x: 0, z: 0 };
}

/** Distance from a point to a tile's rectangle, zero inside it. */
function rectGap(bounds: readonly number[], x: number, z: number): number {
  const dx = Math.max(bounds[0] - x, 0, x - bounds[2]);
  const dz = Math.max(bounds[1] - z, 0, z - bounds[3]);
  return Math.hypot(dx, dz);
}

// --- The dither ----------------------------------------------------------------

/**
 * Can somebody stand here?
 *
 * Four questions, in the order that answers most cheaply first: is there ground,
 * is it plausible ground, is it under water, is something already standing in
 * it. `y` is the **feet** height a caller got from `spawnGround`, not an eye
 * height -- everything in this file works in feet and the call sites add
 * `EYE_HEIGHT` themselves, as `respawnAt` and `eyeAt` do.
 */
export function isSpawnable(x: number, z: number, y: number, world: SpawnWorld): boolean {
  if (!Number.isFinite(y)) return false;

  // Water. `waterSurface` is optional and absent means a world with no water in
  // it, which is a working configuration rather than a broken one -- see
  // `CombatWorld`.
  const surface = world.waterSurface ? world.waterSurface(x, z) : NO_WATER;
  if (waterDepth(surface, y) > SPAWN_MAX_DEPTH) return false;

  const collision = world.collision;
  if (!collision) return true;

  // A null move against the prisms: `resolve` pushes a circle out of anything it
  // overlaps and reports whether it had to, so a zero-length move that comes
  // back `hit` was overlapping. The step height is included because a player who
  // can walk onto something is not blocked by it -- the query `pickRespawn` and
  // `main.placeClear` both make, for the same reason.
  if (blocked(collision, x, z, y)) return false;
  for (const [ox, oz] of CLEARANCE_CROSS) {
    if (blocked(collision, x + ox * SPAWN_CLEARANCE, z + oz * SPAWN_CLEARANCE, y)) return false;
  }
  return true;
}

const CLEARANCE_CROSS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function blocked(collision: NonNullable<SpawnWorld['collision']>, x: number, z: number, y: number): boolean {
  return collision.resolve(x, z, x, z, SPAWN_PROBE_RADIUS, y + SPAWN_STEP_HEIGHT).hit;
}

/**
 * The ground under a point, as a spawn wants it: the terrain, without roofs.
 *
 * `-Infinity` for the feet asks the ground question with the roofs taken out --
 * `roofHeight` refuses every prism the query is below, so what comes back is the
 * terrain. Spawning on a warehouse roof is worse than not spawning there, which
 * is `pickRespawn`'s reasoning and holds twice over for a session's first frame.
 */
export function spawnGround(world: SpawnWorld, x: number, z: number): number {
  return world.groundHeight(x, z, -Infinity);
}

/**
 * One spawn: a point drawn uniformly from the disc, rejection-sampled against
 * the ground under it.
 *
 * `rand` is a parameter rather than a call to `Math.random` for the reason
 * `pickRespawn`'s is: a server that wants to replay a session, or a check that
 * wants two hundred reproducible draws, needs to supply its own. The default is
 * the honest one -- the dither is meant to be different every join.
 *
 * `sqrt` on the radius is not a detail. Drawing `r` uniformly puts half the
 * spawns in the inner quarter of the disc, which over a hundred metres reads as
 * "everybody starts in the same place" -- the thing the dither exists to stop.
 *
 * Returns feet height in `y`. Falls back to the disc centre when nothing passes,
 * because a spawn that silently does not happen is a player looking at the
 * inside of the datum, and the centre is by construction the point the world was
 * proven to cover.
 */
export function pickSpawnPoint(
  centre: { x: number; z: number },
  world: SpawnWorld,
  rand: () => number = Math.random,
  radius: number = SPAWN_DITHER_RADIUS,
): { x: number; y: number; z: number } {
  const base = spawnGround(world, centre.x, centre.z);

  for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
    const bearing = rand() * Math.PI * 2;
    const r = radius * Math.sqrt(rand());
    const x = centre.x + Math.sin(bearing) * r;
    const z = centre.z + Math.cos(bearing) * r;
    const y = spawnGround(world, x, z);
    if (Number.isFinite(base) && Math.abs(y - base) > SPAWN_MAX_RELIEF) continue;
    if (!isSpawnable(x, z, y, world)) continue;
    return { x, y, z };
  }

  return { x: centre.x, y: Number.isFinite(base) ? base : 0, z: centre.z };
}

// --- Somewhere you have already been ---------------------------------------------

/**
 * Is a **remembered** spot still somewhere a person can stand? The point, or null.
 *
 * `pickSpawnPoint` draws a candidate and tests it; this is handed one and does
 * nothing but the test. It exists because an account's saved position (see
 * `net/accounts.LastPos`) is the one point in this game that was valid *at some
 * other time* -- everything else in this file is validated in the same tick it
 * is produced -- and the world between then and now is not the same world:
 *
 *   - the pipeline can rebuild, and a building can now stand where somebody
 *     logged off in a car park;
 *   - the stage can change, and a spot in a tile that is no longer in the build
 *     is a spot over nothing;
 *   - the terrain can move under it, which is the quiet one: a saved `y` several
 *     metres under the ground it was taken from means a body that spawns inside
 *     the hill and is corrected upward through it.
 *
 * So the ground is **re-sampled** rather than trusted, the stored `y` is used
 * only as evidence about whether this is still the same place (the
 * `SPAWN_MAX_RELIEF` test `pickSpawnPoint` applies to its own draws, for the
 * same reason), and the rest is `isSpawnable` unchanged -- the identical water,
 * prism and clearance tests a fresh spawn passes. A restored player has to
 * satisfy everything a new one does; the only thing being skipped is the dither.
 *
 * Returns the point with its **feet** `y` re-derived, so a caller that adds
 * `EYE_HEIGHT` gets today's ground rather than last Tuesday's.
 */
export function restoreSpawnPoint(
  saved: { x: number; y: number; z: number },
  world: SpawnWorld,
): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.z)) return null;
  const y = spawnGround(world, saved.x, saved.z);
  if (!Number.isFinite(y)) return null;
  // The stored height against today's. Over the relief bound means the ground
  // has moved, the tile is missing and `groundHeight` is answering with whoever
  // asked last, or the spot was saved on a roof that is no longer there --
  // three different faults with one honest answer, which is "not here".
  if (Number.isFinite(saved.y) && Math.abs(y - saved.y) > SPAWN_MAX_RELIEF) return null;
  if (!isSpawnable(saved.x, saved.z, y, world)) return null;
  return { x: saved.x, y, z: saved.z };
}

// --- The self-check -------------------------------------------------------------

/**
 * The three things here that fail silently.
 *
 * A sign error on z spawns the session in Chatswood and everything still runs.
 * A uniform radius draw clusters every player at the centre and everything still
 * runs. A rejection loop that never rejects spawns people in ponds and inside
 * warehouses, and everything still runs -- until somebody boots into the dark
 * under a building and reports it as "the game didn't load".
 *
 *     node --experimental-strip-types --input-type=module \
 *       -e "import {verifySpawn} from './src/game/spawn.ts';
 *           console.log(verifySpawn())"
 */
export function verifySpawn(): string[] {
  const failures: string[] = [];

  // --- The pin is south and west of Town Hall, and z is the negation of north.
  if (SPAWN_TARGET.z <= 0) {
    failures.push(`Sydney Park is south of Town Hall, so its world z must be positive; got ${SPAWN_TARGET.z}.`);
  }
  if (SPAWN_TARGET.x >= 0) {
    failures.push(`Sydney Park is west of Town Hall, so its world x must be negative; got ${SPAWN_TARGET.x}.`);
  }

  // --- A world that covers the pin returns the pin. The tile keys here are the
  //     ones the pin's own coordinates produce, worked by hand: x -2236.4 over
  //     500 is tile -5, and -z -4543.3 over 500 is tile -10.
  {
    const tiles: Array<{ key: string; bounds: readonly number[] }> = [];
    for (let tx = -7; tx <= -3; tx++) {
      for (let tz = -12; tz <= -8; tz++) {
        tiles.push({ key: `${tx}_${tz}`, bounds: [tx * 500, -(tz + 1) * 500, (tx + 1) * 500, -tz * 500] });
      }
    }
    const centre = spawnCentre({ tile_size: 500, tiles });
    if (Math.hypot(centre.x - SPAWN_TARGET.x, centre.z - SPAWN_TARGET.z) > 1e-6) {
      failures.push(
        `A world built around the pin should spawn on it, but the centre came back ` +
          `${Math.hypot(centre.x - SPAWN_TARGET.x, centre.z - SPAWN_TARGET.z).toFixed(1)} m away ` +
          `at (${centre.x}, ${centre.z}) -- check the tile-key sign on z.`,
      );
    }
  }

  // --- A world that does not cover the pin returns a point it does cover, as
  //     close to the pin as the fit radius allows.
  {
    const tiles = [{ key: '-2_-2', bounds: [-1000, 500, -500, 1000] as readonly number[] }];
    const centre = spawnCentre({ tile_size: 500, tiles });
    const insetX = centre.x >= -1000 + SPAWN_FIT_RADIUS - 0.01 && centre.x <= -500 - SPAWN_FIT_RADIUS + 0.01;
    const insetZ = centre.z >= 500 + SPAWN_FIT_RADIUS - 0.01 && centre.z <= 1000 - SPAWN_FIT_RADIUS + 0.01;
    if (!insetX || !insetZ) {
      failures.push(
        `A one-tile world put the spawn centre at (${centre.x}, ${centre.z}), which is not ` +
          `${SPAWN_FIT_RADIUS} m inside the only tile there is.`,
      );
    }
    // And it should be the *near* corner of that tile: the pin is to the south
    // and west, so the fitted point is the low-x, high-z inset corner.
    if (Math.abs(centre.x - (-1000 + SPAWN_FIT_RADIUS)) > 0.02 || Math.abs(centre.z - (1000 - SPAWN_FIT_RADIUS)) > 0.02) {
      failures.push(
        `The fitted centre should be the tile corner nearest the pin ` +
          `(${-1000 + SPAWN_FIT_RADIUS}, ${1000 - SPAWN_FIT_RADIUS}); got (${centre.x}, ${centre.z}).`,
      );
    }
  }

  // --- The dither covers the disc rather than clustering at its middle, and
  //     never leaves it.
  {
    const flat: SpawnWorld = { collision: null, groundHeight: () => 0 };
    const centre = { x: 100, z: -200 };
    let outside = 0;
    let inner = 0;
    let seed = 12345;
    const rand = (): number => {
      // A tiny LCG, so this check is the same every time it runs.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 400; i++) {
      const p = pickSpawnPoint(centre, flat, rand);
      const d = Math.hypot(p.x - centre.x, p.z - centre.z);
      if (d > SPAWN_DITHER_RADIUS + 1e-6) outside++;
      if (d < SPAWN_DITHER_RADIUS / 2) inner++;
    }
    if (outside > 0) failures.push(`${outside} of 400 dithered spawns landed outside the ${SPAWN_DITHER_RADIUS} m disc.`);
    // A uniform draw over the disc puts a quarter of the points inside half the
    // radius. Anything over 40% is the `sqrt` having been dropped.
    if (inner > 160) {
      failures.push(`${inner} of 400 spawns landed in the inner half-radius; a uniform disc gives about 100.`);
    }
  }

  // --- Water and prisms are actually rejected, and the fallback is the centre.
  {
    const pond: SpawnWorld = { collision: null, groundHeight: () => 0, waterSurface: () => 1.5 };
    const p = pickSpawnPoint({ x: 0, z: 0 }, pond);
    if (p.x !== 0 || p.z !== 0) {
      failures.push(`A world that is entirely 1.5 m under water still produced a spawn at (${p.x}, ${p.z}).`);
    }
    if (isSpawnable(0, 0, 0, pond)) failures.push('A point under 1.5 m of water was reported spawnable.');

    const walled: SpawnWorld = {
      collision: { resolve: () => ({ hit: true }) },
      groundHeight: () => 0,
    };
    if (isSpawnable(0, 0, 0, walled)) failures.push('A point inside a collision prism was reported spawnable.');
  }

  // --- A remembered spot is re-validated against **today's** world.
  //
  //     Every one of these fails silently in the game: a restore that refuses a
  //     good spot puts a returning player back at the park and reads as the
  //     feature not working, and a restore that accepts a bad one drops them
  //     inside a building and reads as the game not loading.
  {
    const flat: SpawnWorld = { collision: null, groundHeight: () => 0 };
    const here = restoreSpawnPoint({ x: 120, y: 0, z: -40 }, flat);
    if (!here || here.x !== 120 || here.z !== -40) {
      failures.push(`A spot on open flat ground was refused; got ${JSON.stringify(here)}.`);
    }
    // The ground is re-derived rather than echoed: the saved `y` is evidence,
    // not an answer.
    const raised: SpawnWorld = { collision: null, groundHeight: () => 7 };
    const lifted = restoreSpawnPoint({ x: 0, y: 0, z: 0 }, raised);
    if (lifted?.y !== 7) failures.push(`A restored spot kept its stored height (${lifted?.y}) instead of today's ground.`);
    // ...but only while the two are the same place. Terrain that has moved by
    // more than the relief bound is a different world.
    if (restoreSpawnPoint({ x: 0, y: -SPAWN_MAX_RELIEF - 5, z: 0 }, flat) !== null) {
      failures.push('A spot saved far under today\'s terrain was restored; the body would start inside the hill.');
    }
    // And every refusal a fresh spawn gets, a restored one gets.
    const walled: SpawnWorld = { collision: { resolve: () => ({ hit: true }) }, groundHeight: () => 0 };
    if (restoreSpawnPoint({ x: 0, y: 0, z: 0 }, walled) !== null) {
      failures.push('A spot with a building now standing on it was restored.');
    }
    const pond: SpawnWorld = { collision: null, groundHeight: () => 0, waterSurface: () => 1.5 };
    if (restoreSpawnPoint({ x: 0, y: 0, z: 0 }, pond) !== null) {
      failures.push('A spot under 1.5 m of water was restored.');
    }
    const hole: SpawnWorld = { collision: null, groundHeight: () => Number.NaN };
    if (restoreSpawnPoint({ x: 0, y: 0, z: 0 }, hole) !== null) {
      failures.push('A spot over a tile that is no longer built was restored.');
    }
    if (restoreSpawnPoint({ x: Number.NaN, y: 0, z: 0 }, flat) !== null) {
      failures.push('A spot with a NaN coordinate was restored.');
    }
  }

  return failures;
}
