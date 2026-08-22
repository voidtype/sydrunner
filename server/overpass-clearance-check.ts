/**
 * Overpasses that are lying on the road they cross, measured from the bake.
 *
 *     bun run server/overpass-clearance-check.ts
 *     bun run server/overpass-clearance-check.ts --worst 40
 *     bun run server/overpass-clearance-check.ts --near -2697,5356 --radius 1200
 *
 * ---------------------------------------------------------------------------
 * ## The report this exists for
 *
 * The owner, on a screenshot of the St Peters interchange:
 *
 *   > *"not sure what we meant to do when over passes are ON the road"*
 *
 * A four-lane elevated ramp drawn flat on the terrain with two metres of
 * concrete parapet standing up out of the grass along both edges, ambient cars
 * driving the deck at the same height as the cars on the street beside it, and
 * Canal Road running into the parapet and stopping. `pipeline/sydney/decks.py`'s
 * header has the cause: the deck solve floored a bridge at *the terrain* and had
 * never heard of the road the bridge crosses.
 *
 * ---------------------------------------------------------------------------
 * ## The predicate, which needs no tag and that is the point
 *
 * **Two drivable carriageways whose centrelines cross in plan and which share
 * no node are grade-separated, and must clear each other.**
 *
 * A crossing without a junction is a statement that you cannot turn from one
 * road into the other, and the only way that is true of two roads in the same
 * place is that one is over the other. So the rule reads nothing but geometry:
 * no `bridge` tag, no `layer`, no OSM at all -- which matters, because this
 * check has to be able to convict a place the tagging is silent about, and
 * because `RAIL-VERTICAL.md` §1 is the standing instruction to *measure the
 * relationship rather than classify it*. Six stations were buried for years
 * behind a label that said `elevated`.
 *
 * The predicate was validated against the tagging rather than derived from it.
 * Over the shipped 60 km bake this check reads 339,854 plan crossings, of which
 * 337,837 share a node and are ordinary intersections, 322 pass over a service
 * way, and **1,695** are grade separations over a public carriageway. Joined to
 * the OSM extract by way id, **1,685 of those 1,695** are places OSM
 * independently marks with `bridge` or a `layer` difference. Ten are not, and
 * nine of the ten sit at under 5 cm of separation -- crossings OSM has simply
 * not tagged, which are defects of the same kind rather than false positives.
 * So the junction test carries the whole classification on its own, at 99.4%
 * agreement with a source it never reads, and it is nowhere near the line.
 *
 * ---------------------------------------------------------------------------
 * ## What it reads, and why only one file
 *
 * `tiles/*.lanes.bin`, the ways block, through `decodeLanes` -- the decoder both
 * authorities already run. Three properties of that block make it the only
 * source this needs, and `world/road-deck.ts`' header argues all three:
 *
 *   - **`y` is absolute and it is the solved running surface**, so a bridge
 *     way's `y` is `DeckRun.deck_y` (`lanes._HeightField`) and a street's is the
 *     conformed road. The difference between them at a crossing *is* the
 *     clearance, with nothing sampled, inferred or re-derived.
 *   - **A way span is clipped to its own tile**, so a tile's roads are a fact
 *     about that tile.
 *   - **Both ends decode the identical bytes.**
 *
 * It deliberately does not read the collision payload, the GLB, or the
 * pipeline's own report. `cli.cmd_clearance_audit` says why in its own words: a
 * rule that checked the classifier's verdict against the classifier would pass
 * on the day the classifier stopped running. This asks the world.
 *
 * ---------------------------------------------------------------------------
 * ## The two numbers that are decisions
 *
 * **`MIN_CLEARANCE_M` is `decks.MIN_ROAD_CLEARANCE_M`** and must stay that
 * number. It is 5.0 m, measured to the deck's running surface here and to the
 * soffit there -- the girder is the difference and the pipeline adds it, so a
 * deck that satisfies the pipeline satisfies this with a metre in hand. Two
 * writings of one rule; if they ever drift, the bake and the gate are arguing.
 *
 * **`JUNCTION_M` and `SHARED_NODE_M` are the junction test.** A crossing counts
 * as a junction when each way has a vertex within `JUNCTION_M` of the crossing
 * point and those two vertices are within `SHARED_NODE_M` of each other -- an
 * OSM node, seen through two tiles' f32 quantisation rather than by identity,
 * because the ways block carries no node ids. Half a metre is a hundred times
 * the quantisation of a tile-local coordinate and far under the distance
 * between two carriageways that genuinely do not meet.
 *
 * ---------------------------------------------------------------------------
 * ## Service ways are not counted, and the pipeline agrees
 *
 * `decks.PRIVATE_CLASSES` excludes `service` from the demand -- a driveway, a
 * loading dock, a car-park aisle -- on `elevated.py`'s rule, so a bake that is
 * perfect by the pipeline's rule still leaves those crossings at whatever the
 * ground gives. Counting them here would be a gate the bake cannot pass by
 * doing what it was told. They are reported on their own line instead.
 *
 * ---------------------------------------------------------------------------
 * ## The budget is a ratchet
 *
 * `CLEARANCE_BUDGET` is the shipped bake's own measurement, on
 * `undrawn-solids-check.ts`' terms: a fence and not a target. Whoever runs a
 * retile lowers it to what that retile measures. Raising it is how a handful
 * becomes a thousand with nobody noticing.
 *
 * **THE RETILE OF 2026-08-23 HAS RUN, AND IT DID NOT DO WHAT THE INNER RING
 * SAID IT WOULD.** 1,646 tiles re-emitted -- every tile a deck's plan passes
 * through -- carrying `decks._crossing_demand`. Measured here, over the whole
 * 60 km bake, before and after:
 *
 *                        separations   under 5.0 m   under 4.5 m   clear p50
 *     before                   1,373         1,306         1,297      0.17 m
 *     after                    1,369         1,055         1,006      1.44 m
 *
 * A fifth of the defect, not the half the trade curve in
 * `decks.TOUCHDOWN_RAMP_GRADE`'s block projected -- and that block says why in
 * its own first line: **it was measured over the inner 8 km**, where 336 became
 * 172 and the median went to 5.17 m. The network is not the inner ring. Outside
 * it the population is motorway interchange -- the M7, the M5, the M12, Western
 * Sydney Airport -- where a ramp is pinned to the ground at both ends and
 * `_pin_ceiling` gives the clearance away rather than break a touchdown: the
 * build log's own line reads **2,834 stations could not reach the clearance,
 * worst 6.82 m short**, against `TOUCHDOWN_RAMP_GRADE` at 10%. The rule is
 * right and the tuning is inner-city. Raising the ramp grade is the next lever
 * and it is a trade against a cliff, so it wants its own round and its own
 * curve measured out here rather than at Darling Harbour.
 *
 * Some of what is left cannot come down from `decks.py` at all, and the budget
 * has to keep room for it: a crossing where **neither** way is tagged `bridge`
 * has no deck to lift, and a bridge way 16 m long between two ways that are
 * not -- the Cahill onramp and its like -- has no length to climb in.
 * `RAIL-VERTICAL.md` §6 is the precedent for naming a limit rather than
 * pretending it away.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeLanes } from '../client/src/game/traffic.ts';
import { decodeStreetNames, translateStreetNames } from '../client/src/world/tile-decode.ts';

// --- The budgets -----------------------------------------------------------------

/**
 * How much room a grade separation must leave, metres.
 *
 * `decks.MIN_ROAD_CLEARANCE_M`. See the header on why the two are one number.
 */
export const MIN_CLEARANCE_M = 5.0;

/**
 * How many grade separations may give less than that, network-wide.
 *
 * The shipped bake's measurement, 1,306 before the 2026-08-23 retile and this
 * after it. A ratchet: see the header.
 */
export const CLEARANCE_BUDGET = 1055;

/**
 * And how many may be under `TRUCK_M`, the height a heavy vehicle needs.
 *
 * The second fence, for the reason `undrawn-solids-check.ts` keeps an area
 * beside a count: a crossing at 4.9 m and a crossing at 0.0 m are different
 * defects and one number cannot tell them apart. 4.5 m is the signposted
 * clearance on a Sydney heavy-vehicle route, so under it the road is closed to
 * a truck and at 0 m it is closed to everything.
 */
export const TRUCK_M = 4.5;
/** 1,297 before the 2026-08-23 retile. A ratchet, like the one above. */
export const TRUCK_BUDGET = 1006;

/** How near a crossing a way's own vertex has to be to be the junction's. */
export const JUNCTION_M = 1.0;

/** How near two vertices are the same OSM node, through f32 tile coordinates. */
export const SHARED_NODE_M = 0.5;

/**
 * The lane classes that are not owed clearance when they are the road
 * underneath. `decks.PRIVATE_CLASSES`, restated -- see the header.
 */
export const PRIVATE_CLASSES = new Set(['service']);

// --- Options ---------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const WORST = Number(flag('worst', '30'));
const NEAR = flag('near', '');
const RADIUS = Number(flag('radius', '600'));
/**
 * Where to write the tile keys a retile would have to re-emit to fix what this
 * convicts, one to a line, for `build --only @FILE`.
 *
 * A count is what gates; a *list of tiles* is what a round is planned from, and
 * deriving it by eye off the clustered table is how a round misses a tile. The
 * list is the crossing's own tile and every tile the way over it reaches.
 *
 * **It is a floor, and a low one, and the reason is the property this file
 * relies on everywhere else.** A way span in the ways block is *clipped to its
 * own tile* -- that is the third bullet in the header, and it is what makes a
 * tile's roads a fact about that tile -- so `c.over` is one tile's worth of
 * deck and never the run. Raising a deck moves its whole profile and not the
 * metre over the crossing: `decks._demand_envelope` rolls the demand out along
 * the run at the grade ceiling, so a lift at one crossing repaints geometry a
 * kilometre away, in tiles nothing here can name. Over the shipped bake this
 * emits 406 keys for 1,306 convicted crossings, against 2,000-odd tiles the
 * pipeline's own `DeckNetwork.tile_keys()` knows carry a deck. **Scope a round
 * from that, and use this to check it covers what the gate convicts.** See
 * DEPLOY.md §B.
 */
const KEYS_OUT = flag('keys-out', '');
const ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// --- The world ---------------------------------------------------------------------

interface TileEntry { key: string; bounds: [number, number, number, number]; }
const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
const SIZE: number = index.tile_size;
const CLASSES: string[] = (index.lanes?.classes ?? []) as string[];
const tiles: TileEntry[] = index.tiles;
const byKey = new Map<string, TileEntry>(tiles.map((t) => [t.key, t]));

interface Way { osmId: number; klass: number; count: number; x: Float32Array; y: Float32Array; z: Float32Array; }

/**
 * A way's plan bounding box, memoised on the way object.
 *
 * The scan is a pair loop over a nine-tile neighbourhood -- a few hundred ways
 * against each other -- and without a box on each of them it is O(ways^2 x
 * points^2) with the inner two loops doing real arithmetic. Measured over the
 * 29 tiles round St Peters, the boxes take that run from 5 s to well under one,
 * which is the difference between a check that gates the whole world in a
 * minute and one that takes an hour and is therefore never run.
 */
const boxes = new WeakMap<Way, [number, number, number, number]>();
function boxOf(w: Way): [number, number, number, number] {
  let b = boxes.get(w);
  if (b === undefined) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < w.count; i++) {
      if (w.x[i] < x0) x0 = w.x[i];
      if (w.x[i] > x1) x1 = w.x[i];
      if (w.z[i] < z0) z0 = w.z[i];
      if (w.z[i] > z1) z1 = w.z[i];
    }
    b = [x0, z0, x1, z1];
    boxes.set(w, b);
  }
  return b;
}

/** One tile's lane ways in world metres, or an empty list. */
function waysOf(t: TileEntry): Way[] {
  const p = join(ROOT, 'tiles', `${t.key}.lanes.bin`);
  if (!existsSync(p)) return [];
  const b = readFileSync(p);
  const lanes = decodeLanes(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    t.bounds[0],
    t.bounds[1] + SIZE,
  );
  return lanes === null ? [] : lanes.ways;
}

const waysCache = new Map<string, Way[]>();
function cachedWays(key: string): Way[] {
  let w = waysCache.get(key);
  if (w === undefined) {
    const t = byKey.get(key);
    w = t === undefined ? [] : waysOf(t);
    waysCache.set(key, w);
  }
  return w;
}

/**
 * This tile's ways and its eight neighbours', with the tile's own marked.
 *
 * A crossing at a tile seam has one arm in each tile, so the scan cannot be
 * per tile alone; and every crossing would then be found up to nine times, so
 * the pair is only taken when at least one arm is the tile's own and the global
 * `seen` set below settles the rest.
 */
function neighbourhood(t: TileEntry): { ways: Way[]; ownFrom: number; ownTo: number } {
  const [tx, tz] = t.key.split('_').map(Number);
  const own = cachedWays(t.key);
  const ways: Way[] = [...own];
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      if (ax === 0 && az === 0) continue;
      ways.push(...cachedWays(`${tx + ax}_${tz + az}`));
    }
  }
  return { ways, ownFrom: 0, ownTo: own.length };
}

// --- Geometry ----------------------------------------------------------------------

/**
 * Where two plan segments cross, as the fractions along each, or `null`.
 *
 * `decks._cross_point`, written on this side. Parallel segments return `null`
 * rather than an overlap interval: two carriageways lying along each other are
 * a dual carriageway and neither owes the other room.
 */
function crossAt(
  ax0: number, az0: number, ax1: number, az1: number,
  bx0: number, bz0: number, bx1: number, bz1: number,
): [number, number] | null {
  const rx = ax1 - ax0, rz = az1 - az0;
  const sx = bx1 - bx0, sz = bz1 - bz0;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = bx0 - ax0, qz = bz0 - az0;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/** Do these two ways share a node within `JUNCTION_M` of `(x, z)`? */
function sharesNode(a: Way, b: Way, x: number, z: number): boolean {
  const r2 = JUNCTION_M * JUNCTION_M;
  const s2 = SHARED_NODE_M * SHARED_NODE_M;
  for (let i = 0; i < a.count; i++) {
    const dx = a.x[i] - x, dz = a.z[i] - z;
    if (dx * dx + dz * dz > r2) continue;
    for (let j = 0; j < b.count; j++) {
      const ex = b.x[j] - x, ez = b.z[j] - z;
      if (ex * ex + ez * ez > r2) continue;
      const fx = a.x[i] - b.x[j], fz = a.z[i] - b.z[j];
      if (fx * fx + fz * fz <= s2) return true;
    }
  }
  return false;
}

/**
 * A point `NAME_STEP_M` along a segment from the crossing, for the name lookup.
 *
 * `.names.bin` carries no OSM id, so the only way to tell the road over from
 * the road under is to ask at a point that is on one of them and not the other.
 * Fifteen metres is past the widest carriageway's half width and well inside
 * the shortest span, so it lands on the road being named and nothing else.
 */
const NAME_STEP_M = 15;
function alongFrom(seg: [number, number, number, number], x: number, z: number): [number, number] {
  const dx = seg[2] - seg[0], dz = seg[3] - seg[1];
  const n = Math.hypot(dx, dz);
  if (n < 1e-6) return [x, z];
  return [x + (dx / n) * NAME_STEP_M, z + (dz / n) * NAME_STEP_M];
}

// --- The scan ------------------------------------------------------------------------

interface Crossing {
  clear: number;
  x: number;
  z: number;
  overY: number;
  underY: number;
  overKlass: number;
  underKlass: number;
  overId: number;
  underId: number;
  /** A point along each way, clear of the crossing, so the two can be named apart. */
  overAt: [number, number];
  underAt: [number, number];
  /** The way that is over, kept only for `--keys-out`. See `KEYS_OUT`. */
  over: Way;
}

let centre: [number, number] | null = null;
if (NEAR !== '') {
  const [a, b] = NEAR.split(',').map(Number);
  centre = [a, b];
}
const scope = centre === null
  ? tiles
  : tiles.filter((t) => {
      const dx = Math.max(t.bounds[0] - centre![0], 0, centre![0] - t.bounds[2]);
      const dz = Math.max(t.bounds[1] - centre![1], 0, centre![1] - t.bounds[3]);
      return dx * dx + dz * dz <= RADIUS * RADIUS;
    });

say(
  `overpass clearance -- ${scope.length.toLocaleString()} tiles, rule` +
    ` >= ${MIN_CLEARANCE_M.toFixed(1)} m where two carriageways cross with no junction` +
    (centre === null ? '' : `, within ${RADIUS} m of (${centre[0]}, ${centre[1]})`),
);

const seen = new Set<string>();
const found: Crossing[] = [];
let junctions = 0;
let separations = 0;
let serviceUnder = 0;
const t0 = Date.now();

for (const t of scope) {
  const { ways, ownTo } = neighbourhood(t);
  if (ways.length < 2) continue;
  for (let a = 0; a < ways.length; a++) {
    const wa = ways[a];
    // At least one arm has to be this tile's own, or the pair belongs to a
    // neighbourhood that is some other tile's to walk.
    const bFrom = a < ownTo ? a + 1 : ownTo;
    for (let b = bFrom; b < ways.length; b++) {
      if (b === a) continue;
      const wb = ways[b];
      if (wa.osmId === wb.osmId && wa.osmId !== 0) continue;
      const ba = boxOf(wa);
      const bb = boxOf(wb);
      if (ba[2] < bb[0] || bb[2] < ba[0] || ba[3] < bb[1] || bb[3] < ba[1]) continue;
      for (let i = 0; i + 1 < wa.count; i++) {
        const ax0 = Math.min(wa.x[i], wa.x[i + 1]), ax1 = Math.max(wa.x[i], wa.x[i + 1]);
        const az0 = Math.min(wa.z[i], wa.z[i + 1]), az1 = Math.max(wa.z[i], wa.z[i + 1]);
        if (ax1 < bb[0] || bb[2] < ax0 || az1 < bb[1] || bb[3] < az0) continue;
        for (let j = 0; j + 1 < wb.count; j++) {
          if (ax1 < Math.min(wb.x[j], wb.x[j + 1]) || Math.max(wb.x[j], wb.x[j + 1]) < ax0) continue;
          if (az1 < Math.min(wb.z[j], wb.z[j + 1]) || Math.max(wb.z[j], wb.z[j + 1]) < az0) continue;
          const hit = crossAt(
            wa.x[i], wa.z[i], wa.x[i + 1], wa.z[i + 1],
            wb.x[j], wb.z[j], wb.x[j + 1], wb.z[j + 1],
          );
          if (hit === null) continue;
          const [ta, tb] = hit;
          const x = wa.x[i] + ta * (wa.x[i + 1] - wa.x[i]);
          const z = wa.z[i] + ta * (wa.z[i + 1] - wa.z[i]);
          // One entry per place per pair of ways, whichever tile walked it.
          const lo = Math.min(wa.osmId, wb.osmId);
          const hi = Math.max(wa.osmId, wb.osmId);
          const id = `${lo}:${hi}:${Math.round(x / 5)}:${Math.round(z / 5)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (sharesNode(wa, wb, x, z)) { junctions++; continue; }
          separations++;
          const ya = wa.y[i] + ta * (wa.y[i + 1] - wa.y[i]);
          const yb = wb.y[j] + tb * (wb.y[j + 1] - wb.y[j]);
          const aSeg: [number, number, number, number] = [wa.x[i], wa.z[i], wa.x[i + 1], wa.z[i + 1]];
          const bSeg: [number, number, number, number] = [wb.x[j], wb.z[j], wb.x[j + 1], wb.z[j + 1]];
          const over = ya >= yb ? wa : wb;
          const under = ya >= yb ? wb : wa;
          if (PRIVATE_CLASSES.has(CLASSES[under.klass] ?? '')) { serviceUnder++; continue; }
          found.push({
            clear: Math.abs(ya - yb),
            x, z,
            overY: Math.max(ya, yb),
            underY: Math.min(ya, yb),
            overKlass: over.klass,
            underKlass: under.klass,
            overId: over.osmId,
            underId: under.osmId,
            overAt: alongFrom(ya >= yb ? aSeg : bSeg, x, z),
            underAt: alongFrom(ya >= yb ? bSeg : aSeg, x, z),
            over,
          });
        }
      }
    }
  }
}

// --- The report ----------------------------------------------------------------------

const nameCache = new Map<string, ReturnType<typeof decodeStreetNames>>();
/**
 * The nearest named centreline to a point. `undrawn-solids-check.streetAt`,
 * with one difference that matters here: the tile is found **from the point**
 * rather than taken from the tile that happened to walk the crossing. A
 * neighbourhood scan finds crossings up to a tile away from the tile it is
 * standing in, and asking the wrong tile's `.names.bin` returns nothing at all
 * -- which is a table of blanks rather than a wrong answer, and took a run to
 * notice.
 */
function tileAt(x: number, z: number): TileEntry | undefined {
  return tiles.find((t) => x >= t.bounds[0] && x < t.bounds[2] && z >= t.bounds[1] && z < t.bounds[3]);
}
function streetAt(x: number, z: number): string {
  const at = tileAt(x, z);
  if (at === undefined) return '';
  const key = at.key;
  let names = nameCache.get(key);
  if (names === undefined) {
    const t = byKey.get(key);
    const p = t === undefined ? '' : join(ROOT, 'tiles', `${key}.names.bin`);
    if (t !== undefined && p !== '' && existsSync(p)) {
      const b = readFileSync(p);
      names = decodeStreetNames(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      if (names !== null) translateStreetNames(names, t.bounds[0], t.bounds[1] + SIZE);
    } else {
      names = null;
    }
    nameCache.set(key, names);
  }
  if (names === null || names === undefined) return '';
  let best = Infinity;
  let name = '';
  for (const seg of names.segments) {
    if (x < seg.minX - 60 || x > seg.maxX + 60 || z < seg.minZ - 60 || z > seg.maxZ + 60) continue;
    for (let i = 0; i < seg.points.length / 2; i++) {
      const dx = x - seg.points[i * 2];
      const dz = z - seg.points[i * 2 + 1];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; name = seg.name; }
    }
  }
  return name;
}

const secs = (Date.now() - t0) / 1000;
const short = found.filter((c) => c.clear < MIN_CLEARANCE_M);
const truck = found.filter((c) => c.clear < TRUCK_M);
const clears = found.map((c) => c.clear).sort((a, b) => a - b);
const pct = (q: number): number => (clears.length === 0 ? 0 : clears[Math.min(clears.length - 1, Math.floor(q * clears.length))]);

say(`  ${(junctions + separations + serviceUnder).toLocaleString()} plan crossings read in ${secs.toFixed(0)} s`);
say(`  ${junctions.toLocaleString()} share a node -- an intersection, not this rule's business`);
say(`  ${serviceUnder.toLocaleString()} pass over a service way, which is owed no clearance`);
say(`  ${found.length.toLocaleString()} are grade separations over a public carriageway`);
say(`  clearance p05 ${pct(0.05).toFixed(2)} m  p50 ${pct(0.5).toFixed(2)} m  p95 ${pct(0.95).toFixed(2)} m`);
say(`  ${short.length.toLocaleString()} give under ${MIN_CLEARANCE_M.toFixed(1)} m; ${truck.length.toLocaleString()} under ${TRUCK_M.toFixed(1)} m -- a truck cannot pass`);

if (short.length > 0) {
  // One row per place: an interchange is one defect and thirty rows of it is a
  // table nobody reads. `undrawn-solids-check` sorts by damage; the damage here
  // is which road is blocked, so the class of the road underneath leads.
  const RANK = new Map(
    ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'secondary', 'primary_link',
     'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
     'service', 'other'].map((n, i) => [n, i]),
  );
  const rank = (k: number): number => RANK.get(CLASSES[k] ?? '') ?? 99;
  short.sort((a, b) => rank(a.underKlass) - rank(b.underKlass) || a.clear - b.clear);
  const CLUSTER_M = 150;
  const taken: Array<[number, number]> = [];
  const rows: Crossing[] = [];
  for (const c of short) {
    if (taken.some(([x, z]) => (c.x - x) ** 2 + (c.z - z) ** 2 < CLUSTER_M * CLUSTER_M)) continue;
    taken.push([c.x, c.z]);
    rows.push(c);
    if (rows.length >= WORST) break;
  }
  say('');
  say('    clear  deck y  road y         x        z  over                                under (the road that is blocked)');
  for (const c of rows) {
    const over = `${streetAt(...c.overAt) || `way ${c.overId}`} (${CLASSES[c.overKlass] ?? '?'})`;
    const under = `${streetAt(...c.underAt) || `way ${c.underId}`} (${CLASSES[c.underKlass] ?? '?'})`;
    say(
      `  ${pad(c.clear.toFixed(2), 7)} ${pad(c.overY.toFixed(1), 7)} ${pad(c.underY.toFixed(1), 7)} ` +
        `${pad(c.x.toFixed(0), 9)} ${pad(c.z.toFixed(0), 8)}  ${padR(over, 35)} ${under}`,
    );
  }
  if (short.length > rows.length) {
    say(`  ... ${(short.length - rows.length).toLocaleString()} more, clustered at ${CLUSTER_M} m; --worst N for more`);
  }
}

// --- The retile scope, on request -------------------------------------------------------

if (KEYS_OUT !== '') {
  const keys = new Set<string>();
  const add = (x: number, z: number): void => {
    const t = tileAt(x, z);
    if (t !== undefined) keys.add(t.key);
  };
  for (const c of short) {
    add(c.x, c.z);
    // The whole run of the deck that is too low, not the crossing's own tile:
    // see `KEYS_OUT`. Sampled between vertices as well as at them, because a
    // motorway way can carry a 600 m straight that steps over four tiles.
    const w = c.over;
    for (let i = 0; i + 1 < w.count; i++) {
      const dx = w.x[i + 1] - w.x[i];
      const dz = w.z[i + 1] - w.z[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (SIZE / 4)));
      for (let s = 0; s <= steps; s++) add(w.x[i] + (dx * s) / steps, w.z[i] + (dz * s) / steps);
    }
  }
  writeFileSync(KEYS_OUT, [...keys].sort().join('\n') + '\n');
  say('');
  say(`  ${keys.size.toLocaleString()} tile keys written to ${KEYS_OUT} (a floor: see KEYS_OUT)`);
}

// --- THE CONTROL ----------------------------------------------------------------------
//
// **A count is worthless without a demonstration that the scan can see one**,
// which is `undrawn-solids-check.ts`' rule and `cli.cmd_station_clear_audit`'s
// before it. This check's whole verdict rests on one predicate -- crossing, no
// shared node -- so the control exercises exactly that predicate on synthetic
// ways, both ways round: a pair that crosses with no junction must be found and
// its clearance measured, and the same pair with a shared node at the crossing
// must not be. If either fails, the scan above is blind and the count means
// nothing whatever it said.

function runControl(): string[] {
  const bad: string[] = [];
  const mk = (pts: number[], y: number, osmId: number): Way => ({
    osmId,
    klass: 0,
    count: pts.length / 2,
    x: Float32Array.from(pts.filter((_, i) => i % 2 === 0)),
    y: Float32Array.from(new Array(pts.length / 2).fill(y)),
    z: Float32Array.from(pts.filter((_, i) => i % 2 === 1)),
  });
  // Two straight ways crossing at the origin at right angles, 3 m apart in y.
  const east = mk([-50, 0, 50, 0], 13, 1);
  const north = mk([0, -50, 0, 50], 10, 2);
  const hit = crossAt(east.x[0], east.z[0], east.x[1], east.z[1], north.x[0], north.z[0], north.x[1], north.z[1]);
  if (hit === null) {
    bad.push('the control pair does not register as crossing at all');
  } else if (sharesNode(east, north, 0, 0)) {
    bad.push('the control pair reads as a junction, so every overpass would be excused');
  }
  // The same pair with a node planted on the crossing in both.
  const eastJ = mk([-50, 0, 0, 0, 50, 0], 13, 3);
  const northJ = mk([0, -50, 0, 0, 0, 50], 10, 4);
  if (!sharesNode(eastJ, northJ, 0, 0)) {
    bad.push('a shared node at the crossing does not read as a junction, so every intersection would be counted');
  }
  // And a shared node far from the crossing must not excuse it.
  const eastF = mk([-50, 0, -40, 0, 50, 0], 13, 5);
  const northF = mk([-40, -50, -40, 0, -40, 50], 10, 6);
  if (sharesNode(eastF, northF, 0, 0)) {
    bad.push(`a node ${JUNCTION_M} m away is not the junction and must not excuse the crossing`);
  }
  return bad;
}

const control = runControl();
say('');
if (control.length > 0) {
  for (const line of control) say(`  CONTROL FAILED: ${line}`);
} else {
  say('  control: a crossing with no junction is found, one with a junction is not');
}

// --- The verdict ----------------------------------------------------------------------

if (centre !== null) {
  say('');
  say('  (a --near run measures one place and cannot move the ratchet; run it whole to gate)');
  process.exit(control.length > 0 ? 1 : 0);
}

const fail: string[] = [...control];
if (short.length > CLEARANCE_BUDGET) {
  fail.push(`${short.length} crossings under ${MIN_CLEARANCE_M.toFixed(1)} m, over the budget of ${CLEARANCE_BUDGET}`);
}
if (truck.length > TRUCK_BUDGET) {
  fail.push(`${truck.length} crossings under ${TRUCK_M.toFixed(1)} m, over the budget of ${TRUCK_BUDGET}`);
}
say('');
if (fail.length > 0) {
  for (const line of fail) say(`  FAIL: ${line}`);
  process.exit(1);
}
say(
  `  PASS: ${short.length}/${CLEARANCE_BUDGET} under ${MIN_CLEARANCE_M.toFixed(1)} m,` +
    ` ${truck.length}/${TRUCK_BUDGET} under ${TRUCK_M.toFixed(1)} m.` +
    ' Lower both when a retile lowers the measurement.',
);
