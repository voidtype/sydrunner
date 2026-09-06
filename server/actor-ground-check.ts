/**
 * Nobody walks under the street: every foot actor, against the surface drawn under them.
 *
 *     bun run server/actor-ground-check.ts
 *     bun run server/actor-ground-check.ts --worst 20
 *     bun run server/actor-ground-check.ts --area CBD
 *
 * ---------------------------------------------------------------------------
 * ## The report this exists for
 *
 *   > *"the cops walking floating below the streets"*
 *
 * ---------------------------------------------------------------------------
 * ## The two heights, and why they were never the same one
 *
 * A foot actor in this project has its height from one of exactly two places,
 * and the whole defect is the seam between them.
 *
 *   - **Ambient**, which is every officer on a beat, every patrol pair, every
 *     walker, loiterer, drunk and character in the city: the height is
 *     `PedBand.y`, which is `game/pedestrians.buildBand`'s
 *     `way.y + FOOTPATH_LIFT` -- the *lane sidecar's solved running surface*
 *     plus thirteen centimetres. That is the height the client draws the road
 *     ribbon at, so an ambient body stands on the asphalt it is drawn beside,
 *     on a bridge deck as readily as on a street.
 *   - **Dispatched**, which is the same body one tick after something promoted
 *     it into an `NpcActor`: `factions.walkToward`, `streetlife` and
 *     `characters` all end their step with
 *
 *         actor.y = ctx.groundHeight(nx, nz, actor.y);
 *
 *     and `groundHeight` is `server/world.groundFor` -- terrain, platforms,
 *     collision roofs, station boxes, the rail cut. **It has never heard of a
 *     road deck.** `world/road-deck.RoadDeck` is built on both ends out of the
 *     same ways block and is consulted by exactly one caller, `RailCut.setRoads`,
 *     to decide where the railway may *not* carve. Nothing ever asked it how
 *     high the road is.
 *
 * So an officer standing on the Bradfield Highway is at deck height until the
 * moment they start walking, and then they are at whatever the DEM says is under
 * the bridge. That is the report, verbatim, and it is one line of missing
 * precedence rather than anything geometric.
 *
 * ---------------------------------------------------------------------------
 * ## What this measures
 *
 * For every foot actor the server can place over a set of dense areas -- the
 * five populations, posed exactly as `Sim` poses them, at a fixed tick -- it
 * walks the body forward for `WALK_SECONDS` at the tick rate the authority runs,
 * stepping it with the identical `collision.resolve` + `groundHeight` pair
 * `walkToward` uses, and compares its `y` **every tick** against the surface the
 * client draws at that point -- the paving where the pipeline paved any
 * (`RoadDeck.pavedNear`, at the footprint the bake gives it), and the ground
 * itself where it did not. See `drawnAt`, which argues both terms, and `walk`,
 * which argues why the reference is carried forward instead of re-derived from
 * where the body ended up.
 *
 * Per tick and not per spawn, because a body that is placed correctly and sinks
 * on its second step is the defect being reported and a spawn-time check passes
 * it. The two counts that ratchet are actors, not samples: an actor is **under
 * the street** if its `y` is ever more than `UNDER_M` below the drawn surface,
 * and **floating** if it is ever more than `OVER_M` above it.
 *
 * ---------------------------------------------------------------------------
 * ## The budgets are ratchets
 *
 * `UNDER_BUDGET` and `OVER_BUDGET` are the measured population on the day, on
 * `undrawn-solids-check.ts`' terms: a fence and not a target. Whoever changes
 * the placement rules lowers them to what they measure. Raising one is how a
 * handful becomes a thousand with nobody noticing.
 *
 * Reads the shipped world through `server/world.loadWorld`, which is the same
 * decode both authorities run over the same bytes. ~3 minutes. Exit 1 on any
 * failure.
 */
import { loadWorld, groundFor } from './world.ts';
import {
  createPedPose,
  forEachPedestrianNear,
  type PedBand,
} from '../client/src/game/pedestrians.ts';
import {
  FactionField,
  createBeatPose,
  footGround,
  forEachPatrolNear,
  forEachPoliceNear,
  type FactionCtx,
} from '../client/src/game/factions.ts';
import {
  createStreetPose,
  forEachDrunkNear,
  forEachMethheadNear,
} from '../client/src/game/streetlife.ts';
import { createCharacterPose, forEachCharacterNear } from '../client/src/game/characters.ts';

// --- The fences ------------------------------------------------------------------

/** How far under the drawn surface a body may go before it is under the street. */
export const UNDER_M = 0.5;
/** And how far over it before it is floating. */
export const OVER_M = 0.5;

/**
 * How many of the sampled actors may ever be under the street, and how many may
 * ever float. Ratchets: see the header.
 *
 * ---------------------------------------------------------------------------
 * **206 and 0 before `factions.footGround`, 1 and 1 after**, over the same 3,630
 * bodies. `--raw` reproduces the before on demand, which is why it exists.
 *
 * The two that are left are not the defect this round is about and cannot be
 * closed from this side. Both are on the Bradfield approaches, and both are a
 * pair of surfaces the *bake* has not reconciled:
 *
 *   - **E 195.1, N 2708.4** -- paving at -34.85 m over terrain at -35.67 m, so
 *     a body at the very edge of the paved footprint stands 0.82 m under the
 *     asphalt beside it. `road-deck.DECK_CARRIES_GROUND_M` is 1.5 m and says in
 *     as many words that paving this close to the ground *is* on the ground:
 *     the terrain under it should have been conformed to it. The pipeline item
 *     is `roadgrade.conform` reaching this way.
 *   - **E -340.7, N 2238.3** -- two carriageways crossing in plan with **0.85 m**
 *     between them (-62.34 and -61.53). That is one of the 1,055 grade
 *     separations `server/overpass-clearance-check.ts` already convicts against
 *     `decks.MIN_ROAD_CLEARANCE_M` of 5.0 m, and its own header names the lever:
 *     `decks.TOUCHDOWN_RAMP_GRADE`, in a round of its own. A body walking the
 *     lower of the two is under the upper by construction, and no rule on this
 *     side can tell which of two roads 0.85 m apart it is meant to be on.
 *
 * `RAIL-VERTICAL.md` section 6 is the precedent for naming a limit rather than
 * pretending it away. Lower these the day either of those lands.
 */
export const UNDER_BUDGET = 1;
export const OVER_BUDGET = 1;

/**
 * How far the drawn reference may move in one tick before it is a different
 * structure rather than the same one continued, metres.
 *
 * ---------------------------------------------------------------------------
 * `walk` carries the drawn surface forward as its own chain -- see it -- and
 * this is the clause that keeps that chain honest at the *edge* of paving.
 * Measured, at the north pylon of the Harbour Bridge: a character stands on a
 * band whose way is solved on the harbour floor at -65.15 m, walks four metres,
 * and the seabed paving under it stops. `pavedNear` then has exactly one strip
 * left in that cell -- the bridge deck, 43 m overhead -- and without this the
 * reference would step up 43 m in one tick and convict a body that never moved.
 *
 * **Three metres, and it is bounded from both sides.** Below: the deepest true
 * defect this round measured is 3.04 m, and a cap under that would exonerate the
 * thing being measured. Above: `decks.MIN_ROAD_CLEARANCE_M` is 5.0 m, so any
 * genuinely separate structure is further off than this. It does not weaken the
 * check for a body that *falls*, because the reference is keyed on the reference
 * and not on the body: a walker whose ground drops twelve metres out from under
 * it leaves the reference standing on the deck, which is the conviction.
 */
const REFERENCE_JUMP_M = 3.0;

/** How long each body is walked, seconds, and at what rate. `sim.FIXED_DT`. */
const WALK_SECONDS = 3;
const TICK_HZ = 60;

/**
 * How fast. `factions.POLICE_WALK_SPEED`, which is the slowest of the three
 * dispatched populations -- a meth head runs at 5.8 -- and therefore the one
 * that gives the most ticks per metre of street. The defect is a height, not a
 * distance, so the slow walk measures more of it.
 */
const WALK_SPEED = 1.5;

/** `factions.walkToward`'s own two numbers, restated so the step is identical. */
const ACTOR_RADIUS = 0.35;
const STEP_HEIGHT = 0.42;

/** How many actors of one population one area contributes. Keeps the run bounded. */
const PER_POPULATION_CAP = 400;

/** The tick every pose is taken at. Fixed, so two runs sample the same city. */
const TICK = 1_000_000;

// --- Where ------------------------------------------------------------------------

interface Area {
  name: string;
  why: string;
  x: number;
  z: number;
  radius: number;
}

/**
 * The dense areas, and every one of them is a place the two heights can differ:
 * a CBD with a viaduct through it, an approach to a bridge, a highway with
 * overbridges, a station on a deck, a high street over a cutting.
 */
const AREAS: readonly Area[] = [
  { name: 'CBD', why: 'Martin Place, the Cahill viaduct along the Quay', x: 97.5, z: -126.3, radius: 700 },
  { name: 'Cahill', why: 'The Rocks and the Bradfield southern approach', x: -107.5, z: -975.2, radius: 800 },
  { name: 'Bradfield', why: 'Milsons Point, the northern approach off the bridge', x: 163.9, z: -2407.2, radius: 800 },
  { name: 'ParramattaRd', why: 'Camperdown: Parramatta Road and its overbridges', x: -2660.5, z: 2355.4, radius: 800 },
  { name: 'Chatswood', why: 'the station on its deck over the interchange', x: -2719.4, z: -7946.2, radius: 700 },
  { name: 'Newtown', why: 'King Street over the Illawarra cutting', x: -2639.3, z: 3076.3, radius: 700 },
];

// --- Options ----------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const WORST = Number(flag('worst', '12'));
const ONLY = flag('area', '');

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// --- The world --------------------------------------------------------------------

const began = performance.now();
// The whole lane graph, on `integration-check.loadWholeWorld`'s terms: the
// footpaths and the carriageways are what this file is about and a capped load
// would measure the cap.
const world = await loadWorld(root, undefined, 1e12);
const segments = world.segments;
if (segments !== undefined) {
  // And the prisms for the areas being walked. The boot walk trims collision to
  // its cap, so a hexagon over Chatswood may have been given up before this file
  // ever asks about it -- and a body's ground is a roof as often as it is the
  // terrain. `loadNow` does not trim.
  const wanted = new Set<string>();
  for (const area of AREAS) {
    for (const entry of segments.entries) {
      const [minE, minN, maxE, maxN] = entry.bounds;
      // `HexEntry.bounds` is ENU east/north; the world frame is east and
      // **negative** north. See CLAUDE.md's memory on the frame.
      const minZ = -maxN;
      const maxZ = -minN;
      const dx = area.x < minE ? minE - area.x : area.x > maxE ? area.x - maxE : 0;
      const dz = area.z < minZ ? minZ - area.z : area.z > maxZ ? area.z - maxZ : 0;
      if (dx * dx + dz * dz <= (area.radius + 400) * (area.radius + 400)) wanted.add(entry.id);
    }
  }
  for (const id of wanted) await segments.loadNow(id);
  await segments.settle();
  say(`  ${wanted.size} hexagons of prisms pinned for the sampled areas`);
}
const ground = groundFor(world).groundHeight;
const collision = world.collision;
const roads = world.roads ?? null;

/**
 * The ground a **dispatched body** gets, which is the shipped function and not a
 * copy of it.
 *
 * `factions.footGround` is what the three `walkToward`s call, so this file walks
 * bodies with the identical rule the authority steps them with -- including the
 * day somebody changes it. A copy here would be a check that passed because the
 * check agreed with itself, which is `cli.cmd_clearance_audit`'s complaint about
 * a classifier grading its own homework.
 *
 * The rest of the context is inert: `footGround` reads `groundHeight` and
 * `roads` and nothing else, and the fields around them are what the type asks
 * for. `SYDNEY_VESSELS` and the rest of the world are already inside `ground`.
 */
const actorCtx = {
  tick: TICK,
  dt: 1 / TICK_HZ,
  collision,
  groundHeight: ground,
  roads,
  peds: world.peds,
  combatants: [],
  field: new FactionField(),
  investigationOf: () => undefined,
  damagePlayer: () => {},
  emit: () => {},
} as unknown as FactionCtx;

/**
 * `--raw` steps the bodies with the bare `groundHeight` instead, which is the
 * rule that shipped before `footGround` existed.
 *
 * It is here so the *before* of this round stays measurable after the fix has
 * landed: a number in a commit message is a claim, and a flag that reproduces it
 * on demand is a measurement. Nothing in the game runs this path.
 */
const RAW = process.argv.includes('--raw');
const actorGround = RAW
  ? ground
  : (x: number, z: number, feetY: number): number => footGround(actorCtx, x, z, feetY);
say(
  `  world loaded in ${((performance.now() - began) / 1000).toFixed(1)} s, ` +
    `${world.index.tiles.length} tiles, ${world.peds.tileCount} band tiles, ` +
    `${roads === null ? 0 : roads.count} road strips`,
);

// --- The surface the client draws --------------------------------------------------

/**
 * The paving the client draws at `(x, z)`, continuing the surface `was`, or
 * `NaN` where the city paves nothing a body walking on `was` could be on.
 *
 * `RoadDeck.pavedNear` over the same ways block the renderer builds the road
 * ribbon from, at the *footprint the pipeline paved* -- `halfWidth +
 * footpathWidth` -- so a body four metres off the kerb in a park is correctly
 * told there is no paving under it. Nearest to `was` rather than `deckAt`'s
 * maximum, because a body on Alfred Street is not standing on the Cahill twelve
 * metres over its head, and a check that said it was would convict the city of
 * this file's own modelling. `REFERENCE_JUMP_M` is the rest of that argument.
 */
function pavedRef(x: number, z: number, was: number): number {
  if (roads === null) return Number.NaN;
  const paved = roads.pavedNear(x, z, ground(x, z, was), was);
  if (!Number.isFinite(paved)) return Number.NaN;
  const gap = paved > was ? paved - was : was - paved;
  return gap > REFERENCE_JUMP_M ? Number.NaN : paved;
}

/**
 * And the whole surface: the paving where there is any, the ground where there
 * is not.
 *
 * The ground term is `groundFor` verbatim -- terrain, platforms, collision
 * roofs, station boxes, the rail cut -- asked at the **same `feetY` the body's
 * own ground call used**, which is what keeps this a measurement of the city
 * rather than of the audit's own bookkeeping. A body walking under a building
 * piece the rail envelope raised over a corridor is *under* that piece by
 * construction (`CollisionWorld.roofHeight` refuses a roof whose base is over
 * your feet), and a reference asked one tick ahead of the body would climb onto
 * it and then convict the body for not following.
 *
 * What is left when the two share a `feetY` is exactly the question worth
 * asking: **is there paving over this body that the ground does not know
 * about**, and by how much.
 *
 * The max is what makes the ground a floor rather than a competitor: this file
 * convicts a body for being under what is drawn, never for being on it.
 */
function drawnAt(x: number, z: number, feetY: number, paved: number): number {
  const g = ground(x, z, feetY);
  return Number.isFinite(paved) && paved > g ? paved : g;
}

// --- One body's walk ----------------------------------------------------------------

interface Verdict {
  /** The most the body was ever under the drawn surface, metres. Positive. */
  under: number;
  /** And over it. */
  over: number;
  /** Where the worst of the two happened. */
  wx: number;
  wz: number;
  /** Its `y` there, and the surface it should have been on. */
  wy: number;
  ws: number;
  /** Was the body already wrong on the tick it was placed? */
  atSpawn: number;
}

const TICKS = Math.round(WALK_SECONDS * TICK_HZ);
const DT = 1 / TICK_HZ;

/**
 * Walk one body from where it stands, and watch its feet.
 *
 * The step is `factions.walkToward`'s, line for line: resolve the plan move
 * against the prisms at chest height, then take the ground at where it landed
 * carrying the body's own last height. Nothing here models anything; it is the
 * shipped movement with a tape measure beside it.
 */
function walk(x: number, z: number, dx: number, dz: number, y0: number): Verdict {
  let px = x;
  let pz = z;
  /** Where the ground puts the body. The authority's answer, tick by tick. */
  let y = y0;
  /**
   * And the **paving** it is walking on, carried forward from the same start.
   *
   * **Two chains rather than one, and this is the only subtle thing in the
   * file.** Asking which paving is under the body at its *current* height would
   * exonerate the very failure being measured: a body that has just been dropped
   * twelve metres off the Bradfield is standing over Hickson Road, and Hickson
   * Road is paved, so a query keyed on where it landed would answer "the street"
   * and call it fine. Keyed on where it *was*, the query answers "the bridge
   * deck", which is what the player is looking at. It heals itself: off the
   * paving `pavedNear` declines, this goes to `NaN`, and the comparison is
   * against the ground alone until the body is on asphalt again.
   */
  let paved = pavedRef(x, z, y0);
  const v: Verdict = { under: 0, over: 0, wx: x, wz: z, wy: y0, ws: y0, atSpawn: 0 };
  let worst = 0;
  const record = (px2: number, pz2: number, y2: number, ref: number): void => {
    if (!Number.isFinite(ref)) return;
    const d = y2 - ref;
    if (-d > v.under) v.under = -d;
    if (d > v.over) v.over = d;
    if (Math.abs(d) > worst) {
      worst = Math.abs(d);
      v.wx = px2;
      v.wz = pz2;
      v.wy = y2;
      v.ws = ref;
    }
  };
  // The pose itself is reported and **not** counted, and the reason is the one
  // term in `drawnAt` that needs a body to answer at all. `FactionField.promote`
  // takes the ambient height verbatim, and an ambient body's plan position is
  // sometimes inside a building footprint -- a footpath band derived from a way
  // whose kerb-to-kerb width overshoots the terrace beside it. Asked there,
  // `CollisionWorld.roofHeight` hands back the tower's roof, because feet at
  // street level are above a tower's pad and that is what "what am I standing
  // on" means. Measured in the CBD alone: eight poses inside a footprint, the
  // worst 164 m under the roof over it. None of them is under a street; every
  // one of them is pushed out of the footprint by the first `resolve`, which is
  // why the walk starts at the tick after.
  v.atSpawn = y0 - drawnAt(x, z, y0, paved);
  for (let t = 1; t <= TICKS; t++) {
    // `factions.walkToward`, line for line: the plan move is resolved against
    // the prisms first and the ground is taken at where the body landed. The
    // order matters and is not this file's choice -- a body standing inside a
    // footprint is pushed out of it *before* anything asks what it is standing
    // on, which is why the resolve cannot be skipped to save a call.
    let nx = px + dx * WALK_SPEED * DT;
    let nz = pz + dz * WALK_SPEED * DT;
    const moved = collision.resolve(px, pz, nx, nz, ACTOR_RADIUS, y + STEP_HEIGHT);
    nx = moved.x;
    nz = moved.z;
    px = nx;
    pz = nz;
    // **One `feetY` for both answers, and it is the body's own last height.**
    // The body's ground is computed from where it was, so the reference has to
    // be computed from where it was too. Asking the reference at the height the
    // ground just gave it makes the two disagree by a tick wherever the ground
    // is stepping -- measured, that alone produced one conviction and one float
    // over the sampled areas, both of them a body half way onto a kerb-height
    // prism that its own next tick would have put it on.
    const prev = y;
    paved = pavedRef(px, pz, Number.isFinite(paved) ? paved : prev);
    y = actorGround(px, pz, prev);
    record(px, pz, y, drawnAt(px, pz, prev, paved));
  }
  return v;
}

// --- The populations -----------------------------------------------------------------

interface Body {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}

function collect(area: Area): Map<string, Body[]> {
  const out = new Map<string, Body[]>();
  const scratch: PedBand[] = [];
  const push = (name: string, b: Body): void => {
    let list = out.get(name);
    if (list === undefined) {
      list = [];
      out.set(name, list);
    }
    if (list.length < PER_POPULATION_CAP) list.push(b);
  };

  const beat = createBeatPose();
  const ped = createPedPose();
  forEachPoliceNear(world.peds, area.x, area.z, area.radius, TICK, scratch, ped, beat, (p) => {
    push(p.station >= 0 ? 'police beat' : 'police patrol', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  const beat2 = createBeatPose();
  forEachPatrolNear(world.peds, area.x, area.z, area.radius, TICK, scratch, ped, beat2, (p) => {
    push('police patrol', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  const ped2 = createPedPose();
  forEachPedestrianNear(world.peds, area.x, area.z, area.radius, TICK, scratch, ped2, (p) => {
    push('pedestrian', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  const street = createStreetPose();
  forEachMethheadNear(world.peds, area.x, area.z, area.radius, TICK, scratch, street, (p) => {
    push('methhead', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  const street2 = createStreetPose();
  forEachDrunkNear(world.peds, area.x, area.z, area.radius, TICK, scratch, street2, (p) => {
    push('drunk', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  const chars = createCharacterPose();
  forEachCharacterNear(world.peds, area.x, area.z, area.radius, TICK, scratch, chars, (p) => {
    push('character', { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz });
  });
  return out;
}

// --- The measurement ------------------------------------------------------------------

interface Row {
  area: string;
  population: string;
  under: number;
  over: number;
  x: number;
  z: number;
  y: number;
  surface: number;
  atSpawn: number;
}

const rows: Row[] = [];
const areas = ONLY ? AREAS.filter((a) => a.name === ONLY) : AREAS;
let sampled = 0;

for (const area of areas) {
  const t0 = performance.now();
  const bodies = collect(area);
  let here = 0;
  for (const [population, list] of bodies) {
    for (const b of list) {
      const v = walk(b.x, b.z, b.dx, b.dz, b.y);
      rows.push({
        area: area.name,
        population,
        under: v.under,
        over: v.over,
        x: v.wx,
        z: v.wz,
        y: v.wy,
        surface: v.ws,
        atSpawn: v.atSpawn,
      });
      here++;
    }
  }
  sampled += here;
  say(
    `  ${padR(area.name, 14)}${pad(String(here), 6)} bodies walked in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}

// --- The distribution -------------------------------------------------------------------

const under = rows.filter((r) => r.under > UNDER_M);
const over = rows.filter((r) => r.over > OVER_M);

say('');
say(`--- actor-ground: ${sampled} foot actors, ${WALK_SECONDS} s of walking each, per tick`);
say('');

const BUCKETS: Array<[string, (d: number) => boolean]> = [
  ['under 10 m or more', (d) => d <= -10],
  ['under 3 to 10 m', (d) => d <= -3 && d > -10],
  ['under 0.5 to 3 m', (d) => d <= -0.5 && d > -3],
  ['within 0.5 m', (d) => d > -0.5 && d < 0.5],
  ['over 0.5 to 3 m', (d) => d >= 0.5 && d < 3],
  ['over 3 m or more', (d) => d >= 3],
];
say(`  ${padR('worst offset over the walk', 28)}${pad('bodies', 9)}${pad('share', 9)}`);
for (const [label, test] of BUCKETS) {
  const n = rows.filter((r) => {
    const d = r.under >= r.over ? -r.under : r.over;
    return test(d);
  }).length;
  say(`  ${padR(label, 28)}${pad(String(n), 9)}${pad(`${((100 * n) / Math.max(1, rows.length)).toFixed(2)}%`, 9)}`);
}

say('');
say(`  ${padR('area', 14)}${padR('population', 16)}${pad('bodies', 8)}${pad('under', 8)}${pad('floating', 10)}`);
const keys = [...new Set(rows.map((r) => `${r.area}\t${r.population}`))].sort();
for (const k of keys) {
  const [a, p] = k.split('\t');
  const mine = rows.filter((r) => r.area === a && r.population === p);
  const u = mine.filter((r) => r.under > UNDER_M).length;
  const o = mine.filter((r) => r.over > OVER_M).length;
  if (u === 0 && o === 0) continue;
  say(`  ${padR(a, 14)}${padR(p, 16)}${pad(String(mine.length), 8)}${pad(String(u), 8)}${pad(String(o), 10)}`);
}

say('');
say(`  ${under.length} bodies go under the street; ${over.length} float. The worst:`);
say(
  `  ${padR('area', 12)}${padR('population', 15)}${pad('E', 10)}${pad('N', 10)}` +
    `${pad('body y', 9)}${pad('drawn', 9)}${pad('offset', 9)}${pad('at spawn', 10)}`,
);
const worstRows = [...rows]
  .filter((r) => r.under > UNDER_M || r.over > OVER_M)
  .sort((a, b) => Math.max(b.under, b.over) - Math.max(a.under, a.over))
  .slice(0, WORST);
for (const r of worstRows) {
  const d = r.under >= r.over ? -r.under : r.over;
  say(
    `  ${padR(r.area, 12)}${padR(r.population, 15)}${pad(r.x.toFixed(1), 10)}${pad((-r.z).toFixed(1), 10)}` +
      `${pad(r.y.toFixed(2), 9)}${pad(r.surface.toFixed(2), 9)}${pad(d.toFixed(2), 9)}${pad(r.atSpawn.toFixed(2), 10)}`,
  );
}

say('');
const failures: string[] = [];
if (under.length > UNDER_BUDGET) {
  failures.push(
    `${under.length} foot actors walk more than ${UNDER_M} m under the surface drawn beneath them; ` +
      `the budget is ${UNDER_BUDGET}.`,
  );
}
if (over.length > OVER_BUDGET) {
  failures.push(
    `${over.length} foot actors float more than ${OVER_M} m over the surface drawn beneath them; ` +
      `the budget is ${OVER_BUDGET}.`,
  );
}
if (sampled === 0) {
  failures.push('No foot actors were sampled at all, which passes every budget above and measures nothing.');
}

for (const f of failures) say(`  FAIL  ${f}`);
if (failures.length === 0) {
  say(
    under.length === 0 && over.length === 0
      ? `  PASS  every one of ${sampled} bodies stays on the surface it is drawn on`
      : `  PASS  ${sampled} bodies, ${under.length} under and ${over.length} floating, both at the ` +
        'budget the bake forces -- see UNDER_BUDGET for the two and the pipeline item that removes each',
  );
}
say('');
process.exit(failures.length > 0 ? 1 : 0);
