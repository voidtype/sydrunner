/**
 * The ramps onto the Harbour Bridge, walked and driven, and every low deck in
 * the city counted. PERMANENT.
 *
 *     bun run server/ramp-check.ts
 *     SYDNEY_WORLD=<a scoped emit overlaid on the live world> bun run ...
 *     SYDNEY_WORLD_BEFORE=<round one> bun run ...     # the census, twice
 *     bun run server/ramp-check.ts --scan-only        # skip the world load
 *     bun run server/ramp-check.ts --walk-only        # skip the census
 *     bun run server/ramp-check.ts --no-relief        # the oracle: the rule out
 *     bun run server/ramp-check.ts --trace            # print the walks
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * The owner, on the world published 2026-09-11: *"the ramp onto the bridge is
 * impassible. many places witch close road walls are."* Two sentences, one
 * cause, and neither of them needs a browser to reproduce: a ramp you cannot
 * walk up is a `CollisionWorld.resolve` that refuses a move, and a low wall
 * across a road is a prism whose top is higher over the ground than a body can
 * climb. Both are questions about the shipped bytes and the shipped functions,
 * which is what this file asks.
 *
 * The mechanism, from the round that shipped it. `decks.PRISM_MIN_RISE_M` is
 * 0.35 m: under that rise a deck segment earns no collision volume at all,
 * because the terrain under it is already the floor. `RAIL-VERTICAL.md`'s
 * bare-earth pass then took 2.1 m off the ground at Milsons Point while the
 * Bradfield Highway approach -- pinned at its touchdowns -- came down only
 * 1.82 m, so a deck that used to lie on its ground at **0.02 m** now floats
 * between **0.30 and 0.65 m** over it for its whole length. Every segment
 * earns a prism, and every one of those prisms is a wall, because the budget a
 * body has is `controller.STEP_HEIGHT` (0.42) plus `solidFor`'s 0.05 epsilon:
 * **0.47 m**, and the approach never comes closer to its ground than 0.50.
 *
 * Three centimetres. That is the whole of "the ramp onto the bridge is
 * impassible", and it is why this file measures in centimetres.
 *
 * ---------------------------------------------------------------------------
 * FOUR SECTIONS.
 *
 *   1a. **The approach sweep, which is the measurement.** One walk up a ramp is
 *      a story; "the ramp onto the bridge is impassible" is a claim about **how
 *      many** of a ramp's segments admit a body at all. So every deck-form
 *      prism in an area is approached from eight compass directions, from the
 *      first genuinely open ground each of them can find, and the verdict per
 *      segment is whether a body ever ends up standing on top of it.
 *
 *      **The oracle is the same world with one switch thrown.** The sweep runs
 *      twice in one process -- `setGroundSampler(null)`, then the terrain back
 *      -- exactly as `footcar-check` measures the fleets by taking them out
 *      from under the simulation. There is no second copy of the old rule to
 *      drift, because there is no old rule: it is this rule with nothing to
 *      measure against, which is by construction the world that shipped.
 *
 *      Two things are filtered out of the gate and reported instead, because
 *      neither is the low-deck rule's to fix and both are real: a segment with
 *      a **building** over it, and one carrying a **parapet**, which is a
 *      barrier that is supposed to stop you.
 *
 *   1b. **The walks.** A capsule is stepped along the northern approach at
 *      Milsons Point and the southern one at Dawes Point with the *shipped*
 *      `controller.step`, over the *shipped* `groundFor(world).groundHeight`
 *      and the *shipped* `CollisionWorld`. Nothing here re-implements
 *      movement: a route is a list of waypoints, the body is pointed at the
 *      next one, and the verdict is whether it arrives. Where it stops, the
 *      prism that stopped it is named -- base, top, rise over the ground under
 *      its own footprint, tile -- and so is the step it faced.
 *
 *      **The naming is a diagnostic and the verdict is not.** Whether the body
 *      moved is `resolve`'s answer and nothing else's; the clauses repeated in
 *      `culprit` below are only how a number gets a name to go with it. A
 *      check that decided for itself what should have blocked the body would
 *      be a check grading its own homework.
 *
 *   2. **The drive.** The same route, in a car, through the real `Simulation`
 *      -- because a ramp is a thing you drive up and because `driving.ts`
 *      meets a step with the full crash penalty rather than a stop. Cheap: one
 *      `sim.cars.take` and a few hundred ticks, on a fresh simulation per route
 *      so that two drives meet the same city.
 *
 *   3. **The count.** Every `collision/<tile>.bin` in the build, read off the
 *      disk against every `tiles/<tile>.terr.bin`, every structural prism's
 *      rise over the ground at its own footprint, and a census of the ones in
 *      the band a body can neither climb nor see: over `STEP_HEIGHT` and under
 *      1.5 m. Clustered, so "many places" comes out as a number of *places*
 *      rather than a number of polygons, and the worst of them listed by the
 *      length of road they run along. `SYDNEY_WORLD_BEFORE` points at a second
 *      build and the regression is the difference between two integers.
 *
 * ---------------------------------------------------------------------------
 * WHICH SECTIONS SURVIVE A RETILE, AND WHICH DO NOT.
 *
 * **1a and 3 are build-independent.** The sweep finds its own segments in a
 * plan box and the census walks whatever `collision/*.bin` it is pointed at, so
 * both mean the same thing on any world and can be run against two of them.
 *
 * **1b and 2 are the published build's coordinates**, waypoint by waypoint, and
 * they are worth being blunt about. The plan alignment of a carriageway comes
 * out of OSM and survives a retile; its *heights* do not, and the routes below
 * are threaded 4.5 m off a centreline to stay inside a neighbouring
 * carriageway's parapet. Run them against a build whose ground solved
 * differently -- a scoped emit at a different stage, say, where the Bradfield
 * approach stands 3 m over its ground instead of 0.50 -- and they fail on
 * geometry that is correct. They are a repro of one report on one world, which
 * is what they were written to be; 1a is the instrument.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FORMS, AND WHY THE CENSUS SEPARATES THEM.
 *
 * `decks.prisms` writes a deck segment one of two ways and the choice is
 * visible in the bytes. With `WALK_UNDER_M` (2.6 m) of headroom the base is
 * the **soffit** and the player walks under it. Below that the base is
 * `ground - 0.5` and the volume is a solid **embankment** from under the
 * terrain up to the running surface -- which is also how the module *draws* it,
 * with the girder clamped to `ground - GIRDER_BURY_M`. So an embankment prism
 * carries its own ground in its `base`, to within half a metre, and the census
 * splits on `base < ground`: everything buried is a deck lying on the land,
 * everything else is a parapet, a pier, a soffit or a podium standing on it.
 *
 * That split matters because the two want opposite answers. An embankment 0.5 m
 * over the ground is a ramp somebody is meant to walk up. A parapet 1.05 m over
 * the deck is a barrier somebody is meant to be stopped by. They are the same
 * height and they are not the same thing, and no rule that cannot tell them
 * apart is allowed anywhere near `solidFor`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadWorld, groundFor } from './world.ts';
import { Simulation, type Participant, type TickOutput } from './sim.ts';
import {
  EYE_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
  createPlayerState,
  step as controllerStep,
  type InputSnapshot,
} from '../client/src/player/controller.ts';
import {
  BODY_HEIGHT_M,
  LOW_DECK_STEP_M,
  pointInPolygon,
  type Prism,
} from '../client/src/player/collision.ts';
import { decodeTerrain, sampleTileGrid } from '../client/src/world/terrain.ts';
import { TICK_HZ } from '../client/src/net/protocol.ts';

// --- Options ---------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const WORST = Number(flag('worst', '20'));
const SCAN_ONLY = has('scan-only');
const WALK_ONLY = has('walk-only');
const TRACE = has('trace');
/**
 * Walk the world with the low-deck rule taken out from under it.
 *
 * `setGroundSampler(null)` is the one switch, exactly as `setCarSolids(null)` is
 * for the fleets in `footcar-check`: with nothing to measure a rise against,
 * `lowStepFor` answers `false` and every structure keeps every clause it had,
 * which is by construction the world that shipped. So this is not a second copy
 * of the old rule that could drift -- it is the new rule with its evidence
 * removed, and it is what makes the "before" run in the report mean something.
 */
const NO_RELIEF = has('no-relief');

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const failures: string[] = [];

/**
 * The climb budget, and it is not `STEP_HEIGHT`.
 *
 * `controller.step` hands `resolve` a `feetY` of `feetY + STEP_HEIGHT` and
 * `solidFor`'s first clause is `feetY >= prism.top - 0.05`, so what a body
 * actually clears is the sum of the two. `driving.NOSE_STEP` is the same 0.42
 * against the same epsilon, so a car's budget is the same number -- which is
 * why one constant serves both walks and both drives.
 */
const CLIMB_M = STEP_HEIGHT + 0.05;

/** The world frame is east and **negative** north. See CLAUDE.md. */
const zOf = (north: number): number => -north;
const northOf = (z: number): number => -z;

// ---------------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------------

interface Route {
  name: string;
  why: string;
  /** `[east, north]` pairs. The first is where the body is put down. */
  points: Array<[number, number]>;
}

/**
 * Two approaches, and they are the two the owner named.
 *
 * The waypoints are not invented: they are the plan centroids of the deck
 * prisms of one carriageway, read off the shipped payload, north to south for
 * Milsons Point and south to north for Dawes Point. Following one carriageway
 * rather than cutting the corner is deliberate -- `decks.prisms` writes a
 * 1.05 m parapet down both edges of every segment with `PARAPET_MIN_CLEARANCE_M`
 * of clearance, and a diagonal that crossed between carriageways would be
 * stopped by a barrier that is *supposed* to stop it. A body walking up a road
 * walks along the road.
 */
const ROUTES: Route[] = [
  {
    name: 'MilsonsPoint',
    why: 'onto the Bradfield Highway approach at its low point, then up it onto the bridge',
    // ---------------------------------------------------------------------
    // Broadside onto the deck at N 2492.4, and every part of that is chosen.
    //
    // **Broadside**, because the approach is one 200 m carriageway whose prism
    // tops are level: a body already on it walks the length of it with nothing
    // to climb. The run has doorways at the two ends where the ground happens to
    // come up within 0.47 m and is a wall everywhere else, so "the ramp onto the
    // bridge is impassible" is not a run you cannot walk along -- it is a run
    // you cannot get onto.
    //
    // **N 2492.4**, because it is the carriageway's lowest point over its own
    // ground: 0.50 m of rise against a 0.47 m budget, three centimetres, and the
    // best a body gets anywhere on the Milsons Point side. Anywhere worse is a
    // more comfortable failure and a less honest one.
    //
    // **And 4.5 m west of the centreline the whole way**, which is not a detail:
    // the four carriageways here overlap in plan, and `decks.prisms` writes a
    // 1.05 m parapet down both edges of every segment with
    // `PARAPET_MIN_CLEARANCE_M` (0.80 m) of clearance. The Cahill carriageway's
    // western parapet runs up the middle of this one. A route down the painted
    // centreline would be stopped by a barrier that is **supposed** to stop it,
    // and would have proved nothing about the ramp.
    points: [
      [215, 2494],
      [231.3, 2492.4],
      [232.6, 2487.9],
      [233.5, 2485.0],
      [234.4, 2482.0],
      [235.3, 2479.1],
      [236.2, 2476.1],
      [237.0, 2473.2],
      [237.9, 2470.3],
      [238.8, 2467.3],
      [239.7, 2464.4],
      [240.6, 2461.4],
      [241.5, 2458.5],
      [242.3, 2455.6],
      [243.2, 2452.6],
      [244.1, 2449.7],
      [245.0, 2446.7],
      [245.8, 2443.8],
      [246.7, 2440.8],
    ],
  },
  {
    name: 'DawesPoint',
    why: 'the Bradfield/Cahill approach at Dawes Point, up from its own touchdown',
    // **The control, and it is meant to pass on both sides of the fix.** This
    // approach touches down properly -- 0.26 m of rise at its first segment,
    // inside what a body climbs -- and every step up the staircase after it is
    // under `decks.MAX_STEP_M`. So it walked before the low-deck rule and it has
    // to walk after it: a change that opens Milsons Point by loosening something
    // that also breaks a ramp which already worked is not a fix.
    points: [
      [-296, 1059],
      [-283.9, 1080.0],
      [-283.1, 1081.8],
      [-282.3, 1083.6],
      [-281.3, 1085.8],
      [-280.1, 1088.4],
      [-278.9, 1091.0],
      [-277.6, 1093.7],
      [-276.4, 1096.3],
      [-275.2, 1099.0],
    ],
  },
];

// ---------------------------------------------------------------------------------
// 3. The count. First, because it needs no world load and it is the number.
// ---------------------------------------------------------------------------------

interface Scanned {
  /** World-plan centroid. */
  x: number;
  z: number;
  base: number;
  top: number;
  ground: number;
  rise: number;
  /** The longer side of the plan bounding box, metres. */
  extent: number;
  /** True where `base` is under the ground: a deck lying on the land. */
  buried: boolean;
  key: string;
}

interface Cluster {
  n: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  rises: number[];
  buried: number;
  key: string;
}

function scanWorld(worldRoot: string): { prisms: Scanned[]; tiles: number; structural: number } {
  const index = JSON.parse(readFileSync(join(worldRoot, 'index.json'), 'utf8'));
  const gridN: number = index.terrain.grid;
  const tileSize: number = index.tile_size;
  const grids = new Map<string, Float32Array>();

  const ground = (x: number, z: number): number => {
    const tx = Math.floor(x / tileSize);
    const tz = Math.floor(-z / tileSize);
    const k = `${tx}_${tz}`;
    let g = grids.get(k);
    if (g === undefined) {
      const path = join(worldRoot, 'tiles', `${k}.terr.bin`);
      let decoded: Float32Array | null = null;
      if (existsSync(path)) {
        const buf = readFileSync(path);
        decoded = decodeTerrain(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          gridN,
        );
      }
      g = decoded ?? new Float32Array(0);
      grids.set(k, g);
    }
    if (g.length === 0) return Number.NaN;
    return sampleTileGrid(g, gridN, tileSize, x - tx * tileSize, z + tz * tileSize);
  };

  const out: Scanned[] = [];
  let tiles = 0;
  let structural = 0;
  for (const entry of index.tiles as Array<{ key: string; b: number; bounds: number[] }>) {
    const path = join(worldRoot, 'collision', `${entry.key}.bin`);
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    tiles++;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    let p = 0;
    const total = view.getUint32(p, true);
    p += 4;
    // `CollisionWorld.addTile`'s own arithmetic, clamp included: the structures
    // are written ahead of the buildings under one count word.
    const structuralCount = Math.max(0, Math.min(total, total - entry.b));
    const ox = entry.bounds[0];
    const oz = entry.bounds[1] + tileSize;
    for (let i = 0; i < total; i++) {
      if (p + 10 > ab.byteLength) break;
      const height = view.getFloat32(p, true);
      p += 4;
      const base = view.getFloat32(p, true);
      p += 4;
      const n = view.getUint16(p, true);
      p += 2;
      if (p + n * 8 > ab.byteLength) break;
      let cx = 0;
      let cz = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < n; v++) {
        const x = view.getFloat32(p, true) + ox;
        p += 4;
        const z = view.getFloat32(p, true) + oz;
        p += 4;
        cx += x;
        cz += z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (i >= structuralCount) continue;
      structural++;
      cx /= n;
      cz /= n;
      const g = ground(cx, cz);
      if (!Number.isFinite(g)) continue;
      out.push({
        x: cx,
        z: cz,
        base,
        top: base + height,
        ground: g,
        rise: base + height - g,
        extent: Math.max(maxX - minX, maxZ - minZ),
        buried: base < g - 0.05,
        key: entry.key,
      });
    }
  }
  return { prisms: out, tiles, structural };
}

/**
 * Link offenders that are within `LINK_M` of each other into one place.
 *
 * A deck segment is `decks.STATION_M` (6 m) long and 16 m wide, so 20 m links
 * the segments of one run and nothing across a street. Union-find over a 20 m
 * grid rather than an all-pairs sweep, because the offender list runs to five
 * figures and a quadratic count of it is a minute nobody has to spend.
 */
const LINK_M = 20;
function cluster(rows: Scanned[]): Cluster[] {
  const parent = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const cells = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const cx = Math.floor(rows[i].x / LINK_M);
    const cz = Math.floor(rows[i].z / LINK_M);
    const k = `${cx},${cz}`;
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const r2 = LINK_M * LINK_M;
  for (const [k, list] of cells) {
    const [cx, cz] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const other = cells.get(`${cx + dx},${cz + dz}`);
        if (!other) continue;
        for (const i of list) {
          for (const j of other) {
            if (j <= i) continue;
            const ddx = rows[i].x - rows[j].x;
            const ddz = rows[i].z - rows[j].z;
            if (ddx * ddx + ddz * ddz <= r2) union(i, j);
          }
        }
      }
    }
  }
  const by = new Map<number, Cluster>();
  for (let i = 0; i < rows.length; i++) {
    const r = find(i);
    const row = rows[i];
    let c = by.get(r);
    if (c === undefined) {
      c = {
        n: 0,
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
        rises: [],
        buried: 0,
        key: row.key,
      };
      by.set(r, c);
    }
    c.n++;
    if (row.x < c.minX) c.minX = row.x;
    if (row.x > c.maxX) c.maxX = row.x;
    if (row.z < c.minZ) c.minZ = row.z;
    if (row.z > c.maxZ) c.maxZ = row.z;
    c.rises.push(row.rise);
    if (row.buried) c.buried++;
  }
  return [...by.values()];
}

const clusterLength = (c: Cluster): number =>
  Math.hypot(c.maxX - c.minX, c.maxZ - c.minZ) + 6;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function reportScan(worldRoot: string, label: string): void {
  const began = performance.now();
  const { prisms, tiles, structural } = scanWorld(worldRoot);
  const band = prisms.filter((r) => r.rise > STEP_HEIGHT && r.rise <= 1.5);
  const unclimbable = prisms.filter((r) => r.rise > CLIMB_M && r.rise <= 1.5);
  const buriedBand = band.filter((r) => r.buried);
  const raisedBand = band.filter((r) => !r.buried);
  const relieved = prisms.filter((r) => r.buried && r.rise > CLIMB_M && r.rise <= LOW_DECK_STEP_M);
  say('');
  say(`--- ${label}`);
  say(`    ${worldRoot}`);
  say(
    `    ${tiles.toLocaleString()} collision tiles, ${structural.toLocaleString()} structural prisms, ` +
      `${prisms.length.toLocaleString()} with ground under them`,
  );
  say(
    `    rise over ${STEP_HEIGHT} m and under 1.5 m:  ${pad(band.length.toLocaleString(), 7)}` +
      `   (buried/deck ${buriedBand.length.toLocaleString()}, raised ${raisedBand.length.toLocaleString()})`,
  );
  say(
    `    of those, over the ${CLIMB_M.toFixed(2)} m budget:    ${pad(unclimbable.length.toLocaleString(), 7)}` +
      `   -- a body meets these as a wall`,
  );
  say(
    `    a deck the low-deck rule would free:  ${pad(relieved.length.toLocaleString(), 7)}` +
      `   (buried, ${CLIMB_M.toFixed(2)} < rise <= ${LOW_DECK_STEP_M.toFixed(2)} m)`,
  );
  const places = cluster(unclimbable).sort((a, b) => clusterLength(b) - clusterLength(a));
  say(`    ${places.length.toLocaleString()} distinct places, worst ${Math.min(WORST, places.length)} by length:`);
  say(
    `      ${padR('tile', 8)} ${pad('E', 8)} ${pad('N', 9)} ${pad('len m', 7)} ${pad('n', 5)} ` +
      `${pad('rise p50', 9)} ${pad('max', 6)} form`,
  );
  for (const c of places.slice(0, WORST)) {
    const rises = c.rises.slice().sort((a, b) => a - b);
    const form = c.buried === c.n ? 'deck' : c.buried === 0 ? 'raised' : `${c.buried}/${c.n} deck`;
    say(
      `      ${padR(c.key, 8)} ${pad(((c.minX + c.maxX) / 2).toFixed(0), 8)} ` +
        `${pad(northOf((c.minZ + c.maxZ) / 2).toFixed(0), 9)} ${pad(clusterLength(c).toFixed(0), 7)} ` +
        `${pad(String(c.n), 5)} ${pad(percentile(rises, 0.5).toFixed(2), 9)} ` +
        `${pad(rises[rises.length - 1].toFixed(2), 6)} ${form}`,
    );
  }
  say(`    (${((performance.now() - began) / 1000).toFixed(1)} s)`);
}

// ---------------------------------------------------------------------------------
// 1 and 2. The walks and the drive.
// ---------------------------------------------------------------------------------

interface WalkOutcome {
  arrived: boolean;
  reached: number;
  furthestX: number;
  furthestZ: number;
  ticks: number;
  /** The step the body faced where it stopped, metres over its own feet. */
  step: number;
  culprit: string;
}

async function runWalks(): Promise<void> {
  const began = performance.now();
  say(`\n=== the world: ${root}`);
  const world = await loadWorld(root, undefined, 1e12);
  const segments = world.segments;
  if (segments !== undefined) {
    // The prisms for the two approaches. The boot walk trims collision to its
    // cap and may have given a hexagon back before this file asks about it;
    // `loadNow` does not trim. `actor-ground-check` pins the same way.
    const wanted = new Set<string>();
    for (const route of ROUTES) {
      for (const [east, north] of route.points) {
        const z = zOf(north);
        for (const entry of segments.entries) {
          const [minE, minN, maxE, maxN] = entry.bounds;
          const minZ = -maxN;
          const maxZ = -minN;
          const dx = east < minE ? minE - east : east > maxE ? east - maxE : 0;
          const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
          if (dx * dx + dz * dz <= 600 * 600) wanted.add(entry.id);
        }
      }
    }
    for (const id of wanted) await segments.loadNow(id);
    await segments.settle();
    say(`    ${wanted.size} hexagons of prisms pinned for the two approaches`);
  }
  if (NO_RELIEF) {
    world.collision.setGroundSampler(null);
    say('    --no-relief: the low-deck rule has no ground to measure against');
  }
  if (!world.collision.hasGroundSampler && !NO_RELIEF) {
    failures.push(
      'The world was loaded with no ground sampler wired into its prisms, so the low-deck rule ' +
        'is inert. `server/world.loadWorld` is supposed to call `setGroundSampler`.',
    );
  }
  const g = groundFor(world);
  g.groundHeight(0, 0, 0);
  const collision = world.collision;
  say(`    loaded in ${((performance.now() - began) / 1000).toFixed(1)} s`);

  /**
   * Name the prism a stopped body is standing against.
   *
   * A diagnostic, and it says so in the header: the *verdict* is `resolve`'s,
   * and these are `solidFor`'s clauses repeated so a stop can be printed with a
   * base, a top and a tile beside it.
   *
   * **A ring rather than a single probe ahead**, and that is not thoroughness
   * for its own sake: a body that has met a low wall does not stand still facing
   * it. `controller.step` keeps the component of the velocity that ran *along*
   * the obstacle, so a capsule walking at the side of a ramp slides down it, and
   * a probe pointed at the next waypoint finds open air a metre from the thing
   * that has been turning it away for thirty seconds. Sixteen directions at
   * arm's length catch it wherever it ended up; the highest top wins, because
   * the tallest thing in reach is the one a body was not getting over.
   */
  const scratch: Prism[] = [];
  const RING = 16;
  const describe = (q: Prism): { text: string; rise: number } => {
    const gx = (q.minX + q.maxX) / 2;
    const gz = (q.minZ + q.maxZ) / 2;
    // The **bare terrain** and not `groundFor(world).groundHeight`: that one
    // already folds in `collision.roofHeight`, so asking it under a deck answers
    // with the deck and every rise printed here would come out as zero.
    const under = world.terrain.height(gx, gz);
    const tile = `${Math.floor(gx / world.index.tile_size)}_${Math.floor(-gz / world.index.tile_size)}`;
    return {
      rise: q.top - under,
      text:
        `${q.structural ? 'structure' : 'building'} ${tile} E ${gx.toFixed(1)} N ${northOf(gz).toFixed(1)} ` +
        `base ${q.base.toFixed(2)} top ${q.top.toFixed(2)} ground ${under.toFixed(2)} ` +
        `rise ${(q.top - under).toFixed(2)} m` +
        (q.structural ? ` (${q.base < under - 0.05 ? 'deck on the land' : 'standing on it'})` : ''),
    };
  };
  const culprit = (
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    feetY: number,
  ): { text: string; step: number } => {
    collision.prismsWithin(x, z, PLAYER_RADIUS + 2, scratch);
    const probeFeet = feetY + STEP_HEIGHT;
    const headY = feetY + BODY_HEIGHT_M;
    const reach = PLAYER_RADIUS + 0.3;
    const ahead: [number, number] = [x + dirX * reach, z + dirZ * reach];
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2;
      ring.push([x + Math.cos(a) * reach, z + Math.sin(a) * reach]);
    }
    const inWay: Prism[] = [];
    let straightAhead: Prism | null = null;
    for (const q of scratch) {
      if (probeFeet >= q.top - 0.05) continue;
      if (headY <= q.base) continue;
      if (pointInPolygon(q.points, ahead[0], ahead[1])) {
        inWay.push(q);
        if (straightAhead === null || q.top < straightAhead.top) straightAhead = q;
        continue;
      }
      for (const [px, pz] of ring) {
        if (pointInPolygon(q.points, px, pz)) {
          inWay.push(q);
          break;
        }
      }
    }
    if (inWay.length === 0) return { text: "nothing solid is within arm's reach of it", step: 0 };
    // **The lowest top, not the highest**, where the direction of travel has not
    // already settled it. A body stopped between a 12 m terrace and a 0.6 m deck
    // has been stopped by whichever it met, and the one worth printing is the
    // one it nearly climbed -- a tall wall beside a low one is scenery. Each
    // nominee is printed regardless, because "nearly" is a judgement and the
    // reader can make their own.
    inWay.sort((a, b) => a.top - b.top);
    const primary = straightAhead ?? inWay[0];
    const lines = inWay.slice(0, 3).map((q) => describe(q).text);
    return {
      text: lines.join('\n                 '),
      step: primary.top - feetY,
    };
  };

  /** Point the body from `(fx,fz)` at `(tx,tz)`. `controller.step`'s basis. */
  const yawToward = (fx: number, fz: number, tx: number, tz: number): number =>
    Math.atan2(-(tx - fx), -(tz - fz));

  function walk(route: Route): WalkOutcome {
    const [e0, n0] = route.points[0];
    const state = createPlayerState(e0, zOf(n0));
    state.position.y = g.groundHeight(e0, zOf(n0), Infinity) + EYE_HEIGHT;
    let target = 1;
    let ticks = 0;
    let stalled = 0;
    /**
     * The closest this body has ever been to the waypoint it is aiming at.
     *
     * **Progress toward the target and not distance travelled**, which is the
     * mistake the first version of this made and paid for: `controller.step`
     * keeps the velocity component that runs *along* an obstacle, so a capsule
     * at the side of a ramp slides up and down it for the full limit, moving
     * four metres a second and arriving nowhere. "Has not got closer in a
     * second and a half" is the honest test, and it is what a person leaning on
     * W would also conclude.
     */
    let closest = Infinity;
    const input: InputSnapshot = {
      forward: 1,
      right: 0,
      jump: false,
      sprint: false,
      yaw: 0,
      pitch: 0,
    };
    // Generous: the longest route is 230 m and a walk is 4.4 m/s, so ninety
    // seconds is many times what an unobstructed body needs. The stall detector
    // ends it long before this.
    const LIMIT = TICK_HZ * 90;
    while (target < route.points.length && ticks < LIMIT) {
      const [te, tn] = route.points[target];
      const tx = te;
      const tz = zOf(tn);
      input.yaw = yawToward(state.position.x, state.position.z, tx, tz);
      controllerStep(state, input, 1 / TICK_HZ, collision, g.groundHeight);
      ticks++;
      const dx = state.position.x - tx;
      const dz = state.position.z - tz;
      const d = Math.hypot(dx, dz);
      if (d < 3) {
        target++;
        stalled = 0;
        closest = Infinity;
        continue;
      }
      if (d < closest - 0.05) {
        closest = d;
        stalled = 0;
      } else stalled++;
      if (TRACE && ticks % 15 === 0) {
        say(
          `      t${pad(String(ticks), 5)} E ${state.position.x.toFixed(1)} ` +
            `N ${northOf(state.position.z).toFixed(1)} feet ${(state.position.y - EYE_HEIGHT).toFixed(2)} ` +
            `-> wp ${target} at ${d.toFixed(1)} m`,
        );
      }
      if (stalled > TICK_HZ * 1.5) break;
    }
    const feetY = state.position.y - EYE_HEIGHT;
    const [te, tn] = route.points[Math.min(target, route.points.length - 1)];
    const dirLen = Math.hypot(te - state.position.x, zOf(tn) - state.position.z) || 1;
    const named =
      target >= route.points.length
        ? { text: '', step: 0 }
        : culprit(
            state.position.x,
            state.position.z,
            (te - state.position.x) / dirLen,
            (zOf(tn) - state.position.z) / dirLen,
            feetY,
          );
    return {
      arrived: target >= route.points.length,
      reached: target,
      furthestX: state.position.x,
      furthestZ: state.position.z,
      ticks,
      step: named.step,
      culprit: named.text,
    };
  }

  // --- 1a. The approach sweep: how much of a ramp a body can get onto at all.
  //
  // The route below walks *one* way up, and one way up is a story rather than a
  // measurement. "The ramp onto the bridge is impassible" is a statement about
  // **how many** of its segments admit a body from the street, so that is what
  // this counts: every deck-form prism in the area, approached from eight
  // compass directions over open ground, and the verdict per prism is whether a
  // body ever ends up standing on top of it.
  //
  // Eight directions rather than one because a carriageway is 16 m wide and its
  // two sides are different questions -- a ramp with a cutting on one side and a
  // footpath on the other is reachable, and a probe that only ever tried the
  // cutting would call it a wall.
  interface Sweep {
    name: string;
    box: [number, number, number, number];
  }
  const SWEEPS: Sweep[] = [
    { name: 'MilsonsPoint', box: [185, 2420, 275, 2680] },
    { name: 'DawesPoint', box: [-300, 1055, -230, 1115] },
  ];
  const DIRS: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    DIRS.push([Math.cos(a), Math.sin(a)]);
  }
  /**
   * How far out to look for open ground, metres.
   *
   * **Not a fixed standing-back distance**, which is what this was first and why
   * it lied: the Milsons Point approach is four carriageways that overlap in
   * plan and is forty metres wide, so a body put down fourteen metres from one
   * segment's centre is standing on the next carriageway, behind its parapet,
   * with nowhere to walk from. Every one of those reads as "the ramp refuses a
   * body" and none of them is about the ramp. So each direction is scanned
   * outward for the first point that is genuinely open -- terrain under it and
   * no solid over it -- and the walk starts there.
   */
  const SCAN_FROM_M = 9;
  const SCAN_TO_M = 45;
  const sweepScratch: Prism[] = [];

  /** Is this point inside any solid a standing body would meet? */
  const blockedStart = (x: number, z: number, feetY: number): boolean => {
    collision.prismsWithin(x, z, 1.5, sweepScratch);
    for (const q of sweepScratch) {
      if (feetY + STEP_HEIGHT >= q.top - 0.05) continue;
      if (feetY + BODY_HEIGHT_M <= q.base) continue;
      if (pointInPolygon(q.points, x, z)) return true;
    }
    return false;
  };

  /** Can a body get on top of this prism from open ground? */
  const canGetOn = (q: Prism): boolean => {
    const cx = (q.minX + q.maxX) / 2;
    const cz = (q.minZ + q.maxZ) / 2;
    for (const [dx, dz] of DIRS) {
      let from = -1;
      for (let d = SCAN_FROM_M; d <= SCAN_TO_M; d += 1.5) {
        const sx = cx + dx * d;
        const sz = cz + dz * d;
        const gy = world.terrain.height(sx, sz);
        if (!Number.isFinite(gy)) continue;
        if (blockedStart(sx, sz, gy)) continue;
        from = d;
        break;
      }
      if (from < 0) continue;
      const sx = cx + dx * from;
      const sz = cz + dz * from;
      const state = createPlayerState(sx, sz);
      state.position.y = g.groundHeight(sx, sz, Infinity) + EYE_HEIGHT;
      const input: InputSnapshot = {
        forward: 1,
        right: 0,
        jump: false,
        sprint: false,
        yaw: Math.atan2(-(cx - sx), -(cz - sz)),
        pitch: 0,
      };
      // The distance walked, with a second of slack for the acceleration ramp.
      const ticks = Math.ceil(((from + 4) / 4.4 + 1) * TICK_HZ);
      for (let t = 0; t < ticks; t++) {
        controllerStep(state, input, 1 / TICK_HZ, collision, g.groundHeight);
        const feet = state.position.y - EYE_HEIGHT;
        if (feet >= q.top - 0.06 && pointInPolygon(q.points, state.position.x, state.position.z)) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Does this deck carry a parapet? Then nobody is meant to walk onto it
   * sideways, and a sweep that expected them to would be asking for a bug.
   *
   * `decks.prisms` writes the barrier as its own prism standing **on** the
   * deck's top, so that is what this looks for: a structural volume whose base
   * is this deck's top, over this deck's own plan. `PARAPET_MIN_CLEARANCE_M` is
   * 0.80 m, which is why the segments this finds are the ones between 0.8 and
   * 1.0 of rise -- inside the low-deck rule and still, correctly, walled.
   */
  const hasParapet = (q: Prism): boolean => {
    const px = (q.minX + q.maxX) / 2;
    const pz = (q.minZ + q.maxZ) / 2;
    collision.prismsWithin(px, pz, Math.max(q.maxX - q.minX, q.maxZ - q.minZ) * 0.5 + 1, sweepScratch);
    for (const b of sweepScratch) {
      if (b === q || !b.structural) continue;
      if (Math.abs(b.base - q.top) > 0.15) continue;
      const bx = (b.minX + b.maxX) / 2;
      const bz = (b.minZ + b.maxZ) / 2;
      if (bx < q.minX - 1 || bx > q.maxX + 1 || bz < q.minZ - 1 || bz > q.maxZ + 1) continue;
      return true;
    }
    return false;
  };

  /** Is this deck under a building? See the report line it feeds. */
  const underBuilding = (q: Prism): boolean => {
    const px = (q.minX + q.maxX) / 2;
    const pz = (q.minZ + q.maxZ) / 2;
    collision.prismsWithin(px, pz, 1.5, sweepScratch);
    for (const b of sweepScratch) {
      if (b.structural) continue;
      if (q.top + STEP_HEIGHT >= b.top - 0.05) continue;
      if (q.top + BODY_HEIGHT_M <= b.base) continue;
      if (pointInPolygon(b.points, px, pz)) return true;
    }
    return false;
  };

  say('\n1a. how much of each approach a body can get onto at all, from open ground');
  say("    (the same world twice: the low-deck rule's ground taken out, then put back)");
  const deckScratch: Prism[] = [];
  for (const sweep of SWEEPS) {
    const [e0, n0, e1, n1] = sweep.box;
    const cx = (e0 + e1) / 2;
    const cz = zOf((n0 + n1) / 2);
    const radius = Math.hypot(e1 - e0, n1 - n0) / 2 + 20;
    collision.prismsWithin(cx, cz, radius, deckScratch);
    const decks: Prism[] = [];
    for (const q of deckScratch) {
      if (!q.structural) continue;
      const px = (q.minX + q.maxX) / 2;
      const pz = (q.minZ + q.maxZ) / 2;
      if (px < e0 || px > e1 || northOf(pz) < n0 || northOf(pz) > n1) continue;
      const under = world.terrain.height(px, pz);
      if (!Number.isFinite(under)) continue;
      // Deck-form only: base under the ground. A parapet is a barrier and is not
      // supposed to admit anybody. See this file's header.
      if (q.base >= under - 0.05) continue;
      if (q.top - under > 1.5) continue;
      decks.push(q);
    }
    decks.sort((p1, p2) => p1.minZ - p2.minZ);
    const riseOf = (q: Prism): number =>
      q.top - world.terrain.height((q.minX + q.maxX) / 2, (q.minZ + q.maxZ) / 2);
    const roofed = decks.filter(underBuilding).length;

    const runSweep = (): Set<Prism> => {
      const got = new Set<Prism>();
      for (const q of decks) if (canGetOn(q)) got.add(q);
      return got;
    };
    const land = (x: number, z: number): number => world.terrain.height(x, z);
    collision.setGroundSampler(null);
    const before = runSweep();
    collision.setGroundSampler(NO_RELIEF ? null : land);
    const after = runSweep();

    const low = decks.filter((q) => riseOf(q) <= LOW_DECK_STEP_M);
    const walled = decks.filter(hasParapet).length;
    const lowOpen = low.filter((q) => !underBuilding(q) && !hasParapet(q));
    const stuck = lowOpen.filter((q) => !after.has(q));
    say(
      `    ${padR(sweep.name, 14)} ${pad(String(before.size), 4)} -> ${pad(String(after.size), 4)} of ` +
        `${pad(String(decks.length), 4)} deck segments admit a body` +
        (decks.length
          ? `  (${((before.size / decks.length) * 100).toFixed(0)}% -> ${((after.size / decks.length) * 100).toFixed(0)}%)`
          : ''),
    );
    say(
      `                   ${low.length} stand within ${LOW_DECK_STEP_M.toFixed(2)} m of their ground; ` +
        `of the ${decks.length}, ${roofed} have a building over them and ${walled} carry a parapet`,
    );
    const opened = [...after].filter((q) => !before.has(q));
    if (opened.length > 0) {
      opened.sort((p1, p2) => p1.minZ - p2.minZ);
      say(`                   the rule opened ${opened.length}:`);
      for (const q of opened.slice(0, 10)) {
        say(
          `                     E ${((q.minX + q.maxX) / 2).toFixed(0)} ` +
            `N ${northOf((q.minZ + q.maxZ) / 2).toFixed(0)} rise ${riseOf(q).toFixed(2)} m`,
        );
      }
    }
    if (stuck.length > 0) {
      // Informational, and deliberately not a failure. A low segment can refuse
      // a body for two reasons that are nobody's bug to fix here -- it carries a
      // parapet, or something is built over it -- and both are filtered out
      // above; what is left over is a shortlist for a person, not a verdict.
      say(`                   ${stuck.length} low segment(s) with open sky and no parapet still refuse a body:`);
      for (const q of stuck.slice(0, 8)) {
        say(
          `                     E ${((q.minX + q.maxX) / 2).toFixed(0)} ` +
            `N ${northOf((q.minZ + q.maxZ) / 2).toFixed(0)} rise ${riseOf(q).toFixed(2)} m`,
        );
      }
    }
    // **And the one thing that is a verdict: the rule is a strict widening.**
    // `verifyCollision`'s randomised sweep asserts the same property about the
    // walk-under rule and for the same reason -- a change to `solidFor` that
    // closes anything is a regression however much else it opens, and a deck
    // that stopped admitting a body would be a road somebody could reach
    // yesterday and cannot today.
    const closed = [...before].filter((q) => !after.has(q));
    if (closed.length > 0) {
      failures.push(
        `${sweep.name}: the low-deck rule made ${closed.length} deck segment(s) unreachable that ` +
          `were reachable without it. It is a widening or it is a regression.`,
      );
    }
  }

  say('\n1b. a capsule, stepped by the shipped controller over the shipped prisms');
  for (const route of ROUTES) {
    const r = walk(route);
    say(`\n   ${route.name}: ${route.why}`);
    say(
      `     ${r.arrived ? 'ARRIVED' : 'STOPPED'} at E ${r.furthestX.toFixed(1)} ` +
        `N ${northOf(r.furthestZ).toFixed(1)} after ${r.ticks} ticks, ` +
        `waypoint ${r.reached}/${route.points.length - 1}`,
    );
    if (!r.arrived) {
      say(`     the step it faced: ${r.step.toFixed(2)} m, and it climbs ${CLIMB_M.toFixed(2)} m`);
      say(`     stopped by: ${r.culprit}`);
      failures.push(
        `${route.name}: a capsule stopped ${r.reached}/${route.points.length - 1} of the way up ` +
          `at a ${r.step.toFixed(2)} m step. ${r.culprit}`,
      );
    }
  }

  // --- 2. The drive.
  say('\n2. a car, driven through the real Simulation');
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  let plate = 0x5a11e5;
  for (const route of ROUTES) {
    // **A fresh `Simulation` per route, and it is not tidiness.** Everything
    // ambient in this game is a pure function of the tick -- `traffic.poseCar`,
    // the pedestrian bands, the timetable -- so a drive that starts on tick 0
    // meets the same city every time, and one that starts on whatever tick the
    // previous drive happened to end on meets a different one. The first version
    // of this shared a simulation between the two routes and the southern drive
    // passed or failed depending on how far the northern one had got, which is a
    // gate that reports the weather.
    const sim = new Simulation(world);
    const driver: Participant = sim.join(0, null, 'driver');
    // **And a coarser route, because a car is not a pedestrian.** The walk's
    // waypoints are one per deck segment, three metres apart, which at 28 m/s is
    // a steering input every ninth of a second: the first version of this drove
    // figure-eights up the ramp and reported the oscillation as a wall. Fifteen
    // metres is about a third of a second at speed and is the same line the deck
    // runs along -- the points are a subset of the walk's, never a new path.
    const drivePoints: Array<[number, number]> = [route.points[0]];
    for (const pt of route.points.slice(1, -1)) {
      const last = drivePoints[drivePoints.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 10) drivePoints.push(pt);
    }
    drivePoints.push(route.points[route.points.length - 1]);
    const [e0, n0] = route.points[0];
    const z0 = zOf(n0);
    const y0 = g.groundHeight(e0, z0, Infinity);
    const [e1, n1] = drivePoints[1];
    const yaw = yawToward(e0, z0, e1, zOf(n1));
    sim.placeAt(driver, e0, y0 + EYE_HEIGHT, z0, yaw);
    driver.combat.ridingBike = 0;
    // By hand, exactly as `cardamage-check` does it: `CarField.take` is the
    // call `tryTakeCar` makes, and what is being exercised is the ramp rather
    // than the theft.
    const car = sim.cars.take(
      // A fresh identity per route: `CarField.take` refuses a source it already
      // has a record for, and `leave` only empties the seat.
      { identity: ++plate, body: 0, colour: 0, x: e0, y: y0, z: z0, yaw, parked: true },
      driver.combat.id,
    );
    if (car === undefined || car === null) {
      say(`   ${route.name}: no car could be taken here; skipped`);
      continue;
    }
    driver.combat.drivingCar = car.id;
    driver.input.forward = 1;
    driver.input.right = 0;
    driver.input.jump = false;
    driver.input.sprint = false;
    let target = 1;
    let ticks = 0;
    let stalled = 0;
    // Progress toward the waypoint, not distance travelled. See `walk`.
    let closest = Infinity;
    let top = 0;
    const LIMIT = TICK_HZ * 120;
    while (target < drivePoints.length && ticks < LIMIT) {
      const [te, tn] = drivePoints[target];
      driver.input.yaw = yawToward(car.x, car.z, te, zOf(tn));
      sim.step(out);
      ticks++;
      if (driver.combat.carSpeed > top) top = driver.combat.carSpeed;
      const d = Math.hypot(car.x - te, car.z - zOf(tn));
      // **Reached, or driven past**, which a walk does not need and a car does:
      // at 28 m/s a tick is half a metre and the arrival disc is crossed in
      // three of them, so a car that clips the corner of one is never inside it
      // and steers back for the rest of the run. The plane test is the one a
      // waypoint follower is supposed to use -- past the gate counts as through
      // it.
      const [pe, pn] = drivePoints[target - 1];
      const legX = te - pe;
      const legZ = zOf(tn) - zOf(pn);
      const past = (car.x - te) * legX + (car.z - zOf(tn)) * legZ > 0;
      if (d < 8 || past) {
        target++;
        stalled = 0;
        closest = Infinity;
        continue;
      }
      if (d < closest - 0.05) {
        closest = d;
        stalled = 0;
      } else stalled++;
      if (stalled > TICK_HZ * 1.5) break;
    }
    driver.input.forward = 0;
    const arrived = target >= drivePoints.length;
    say(
      `   ${route.name}: ${arrived ? 'ARRIVED' : 'STOPPED'} at E ${car.x.toFixed(1)} ` +
        `N ${northOf(car.z).toFixed(1)}, waypoint ${target}/${drivePoints.length - 1}, ` +
        `top speed ${top.toFixed(1)} m/s, health ${car.health.toFixed(1)}`,
    );
    if (!arrived) {
      const [te, tn] = drivePoints[Math.min(target, drivePoints.length - 1)];
      const len = Math.hypot(te - car.x, zOf(tn) - car.z) || 1;
      const named = culprit(car.x, car.z, (te - car.x) / len, (zOf(tn) - car.z) / len, car.y);
      say(`     stopped by: ${named.text}`);
      failures.push(
        `${route.name}: a car stopped ${target}/${drivePoints.length - 1} of the way up the ramp. ` +
          `${named.text.split('\n')[0]}`,
      );
    }
    driver.combat.drivingCar = 0;
    sim.cars.leave(car.id);
    sim.cars.remove(car.id);
  }
}

// ---------------------------------------------------------------------------------

if (!WALK_ONLY) {
  say('3. every structural prism in the build, against the ground under its own footprint');
  reportScan(root, 'this world');
  const before = process.env.SYDNEY_WORLD_BEFORE;
  if (before && existsSync(join(before, 'index.json'))) reportScan(before, 'the world before');
}
if (!SCAN_ONLY) await runWalks();

say('');
if (failures.length === 0) {
  say('ramp-check: every approach walked and driven to the top.');
  process.exit(0);
}
for (const f of failures) say(`FAIL  ${f}`);
say(`ramp-check: ${failures.length} failure(s).`);
process.exit(1);
