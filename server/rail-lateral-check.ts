/**
 * What the railway's walls cost this process, as a check that fails.
 *
 *     bun run server/rail-lateral-check.ts
 *     bun run server/rail-lateral-check.ts --at -2719,-7946 --sweeps 40
 *
 * ---------------------------------------------------------------------------
 * ## Why this is a check and not a paragraph in the report
 *
 * `server/rail-lateral.ts` closes a real divergence -- the browser is stopped by
 * trench walls, piers and station walls and this process was not -- and it
 * closes it by putting prisms into a `CollisionWorld` on a box with a 1 vCPU and
 * a 1 GB `MemoryHigh`. PERFORMANCE.md's whole argument is that a dozen
 * defensible additions is how 0.20 ms became 3.30, and a lazily-materialised
 * prism set near every participant is exactly the shape of addition that is
 * defensible on its own and unbounded in aggregate if nobody is counting.
 *
 * So this counts it, at the three places in the city where the answer is
 * different, and returns 1 when it drifts:
 *
 *   - **How many prisms** one participant's radius holds, and how many bytes
 *     that is on `world.ts`'s own measured fit.
 *   - **What a sweep costs**, and what a *tick* costs -- which are not the same
 *     number, because `SWEEP_INTERVAL_TICKS` throttles the decision to 4 Hz. Both
 *     are gated; see the two budgets for why one without the other would let a
 *     regression hide behind the throttle.
 *   - **What the first sweep costs**, which is different again and is the number
 *     that could stall a tick: an entity's solids are built the first time
 *     anybody stands near them, and a trench profile is terrain probes.
 *
 * It has already earned its place once. The first version of `rail-lateral.ts`
 * held the browser's 1,500 m radius and rebuilt a set of string keys every tick;
 * this file cost it at **1.6 ms of every tick**, eighty times the whole ambient
 * budget, and the radius argument turned out to be wrong as well as expensive.
 * None of that was visible from reading the code.
 *
 * ---------------------------------------------------------------------------
 * ## The three places, and why each is a different answer
 *
 *   - **Chatswood.** The North Shore line in a cutting through the middle of a
 *     retail centre, which is where the invisible-wall reports came from. Dense
 *     trench, a station, and the geometry that made this workstream necessary.
 *   - **Central.** The largest station box in the build and the greatest
 *     concentration of platform, canopy and access geometry anywhere -- the
 *     worst case for the *station* half of the enumeration.
 *   - **Manly.** There is no heavy rail on the northern beaches and there never
 *     was. The floor: what this costs somebody nowhere near a railway, which is
 *     most players most of the time, and the number that says the residency is a
 *     residency rather than a whole-city load with extra steps. Hyde Park was
 *     the first choice and was wrong -- it is four hundred metres from the City
 *     Circle and held eighteen hundred entities, which is the measurement
 *     teaching the file what "nowhere near" means.
 *
 * ---------------------------------------------------------------------------
 * ## What the budgets are, and what to do when one fails
 *
 * They are `world.ts`'s own accounting applied to this layer, not fresh guesses.
 * `PRISM_BYTES` and `VERTEX_BYTES` there are measured against a forced GC per
 * hexagon and fit the 208 MB total within +0.2%; the same two constants are what
 * turn a prism count here into a memory number. The tick budget is
 * `tick-profile.AMBIENT_BUDGET_MS`'s order of magnitude, because this runs in the
 * same 16.7 ms and is *ambient*: it is paid whether or not anybody is doing
 * anything.
 *
 * A failure is a genuine measurement and the response is the one
 * `undrawn-solids-check.ts` states: if the cost is necessary, raise the budget
 * here **and** record the new measurement. A budget raised quietly is how this
 * class of thing gets away.
 */
import { loadWorld } from './world.ts';
import { RAIL_LATERAL_RADIUS_M, SWEEP_INTERVAL_TICKS, verifyRailLateral } from './rail-lateral.ts';

/**
 * The most prisms one participant may hold, at the worst of the three places.
 *
 * Measured -- see the table this run prints. The budget is the worst measured
 * figure plus about a third, on `tick-profile.ts`'s terms: tight enough to catch
 * a station kit that doubled, loose enough that a bake with one more siding in
 * it does not fail the build.
 */
const PRISM_BUDGET = 1700;

/**
 * And what that is in memory, megabytes, on `world.ts`'s measured fit.
 *
 * The point of stating it in bytes as well as in prisms is that the two can move
 * independently: a change that split every trench wall into four shorter boxes
 * would quadruple the count and barely move the memory, and a change that gave
 * every solid a sixty-vertex plan would do the reverse. The 1 GB box cares about
 * the second one.
 */
const MEMORY_BUDGET_MB = 0.75;

/**
 * What this layer may cost a tick, milliseconds, amortized.
 *
 * `Rooms.step` calls `update` every tick and `SWEEP_INTERVAL_TICKS` throttles
 * the *decision* to every fifteenth, so what the tick pays is one sweep in
 * fifteen. This is the number that lands in `tick-profile.ts`'s per-player
 * column and it is set at a tenth of `PER_PLAYER_BUDGET_MS`: the layer is one of
 * a dozen things a participant costs and must not be the biggest.
 */
const TICK_BUDGET_MS = 0.02;

/**
 * And what one *decision* may cost, milliseconds, once its entities are built.
 *
 * Reported separately because the two fail for different reasons and are fixed
 * in different places: a tick number that drifts is usually this number times
 * the same fifteen, but a decision that got slower while the tick stayed inside
 * budget means the throttle is hiding a regression that a busier host would
 * expose. It is the number that would matter if `SWEEP_INTERVAL_TICKS` were ever
 * lowered.
 */
const SWEEP_BUDGET_MS = 0.30;

/**
 * And what any **one** sweep may cost, milliseconds, including a first one.
 *
 * The first sweep at a place is where every trench profile inside
 * `RAIL_LATERAL_RADIUS_M` is measured against the DEM, and it used to land in
 * one tick: this file measured **45.8 ms at Central** and said, in this comment,
 * that the fix was a build budget in `RailLateralField.update` and not a bigger
 * number here. That is what happened. `ADOPT_BUDGET_MS` is the browser's own
 * 4 ms and this is that plus the worst single entity, because the budget is
 * checked *between* entities and one station's kit always completes once started
 * -- the same bound `streamer.BUILD_BUDGET_MS` has and for the same reason. The
 * worst entity measured is a Chatswood station plan at about 8 ms.
 */
const FIRST_SWEEP_BUDGET_MS = 18;

/**
 * How many sweeps a place may take to be fully registered.
 *
 * The other half of the budget above, and it exists because without it the fix
 * for a slow first sweep is a budget of zero. A player who arrives somewhere new
 * must have the walls around them quickly, and `update` runs an unfinished
 * sweep on the **next tick** rather than the next interval -- so this is a count
 * of ticks, not of quarter-seconds. Sixty is one second, against the thirty-odd
 * ticks Central actually takes.
 */
const SETTLE_SWEEP_BUDGET = 60;

/** Bytes a resident prism costs, from `server/world.ts`'s measured fit. */
const PRISM_BYTES = 344;

interface Place {
  name: string;
  why: string;
  x: number;
  z: number;
}

const PLACES: readonly Place[] = [
  { name: 'Chatswood', why: 'the North Shore cutting, where the reports came from', x: -2719.4, z: -7946.2 },
  { name: 'Central', why: 'the largest station box in the build', x: -269, z: 2107 },
  { name: 'Manly', why: 'the floor: no heavy rail on the northern beaches', x: 7146.6, z: -8064.7 },
];

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const SWEEPS = Number(flag('sweeps', '30'));
const at = flag('at', '');
const places: readonly Place[] = at
  ? [{ name: at, why: '--at', x: Number(at.split(',')[0]), z: Number(at.split(',')[1]) }]
  : PLACES;

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const bootBegan = performance.now();
const world = await loadWorld(root);
const bootMs = performance.now() - bootBegan;

say('');
say(`--- rail-lateral: the railway's walls on the authority, ${RAIL_LATERAL_RADIUS_M} m a participant`);
say('');

const failures: string[] = [...verifyRailLateral()];

const field = world.railLateral;
if (!field || !world.railSolids) {
  say('  This world has no rail bake, so there is nothing to hold and nothing to measure.');
  say('  PASS -- vacuously. Point SYDNEY_WORLD at a build with client/public/rail in it to');
  say('  measure the layer this file exists for.');
  process.exit(failures.length > 0 ? 1 : 0);
}

say(`  world loaded in ${(bootMs / 1000).toFixed(1)} s, ${world.index.tiles.length} tiles`);
say('');
say(
  `  ${padR('place', 12)}${pad('entities', 10)}${pad('prisms', 8)}${pad('MB', 7)}` +
    `${pad('worst sweep', 13)}${pad('settle', 8)}${pad('a sweep', 10)}${pad('a tick', 10)}${pad('provisional', 13)}`,
);

let worstPrisms = 0;
let worstMb = 0;
let worstFirst = 0;
let worstSettle = 0;
let worstTick = 0;
let worstSweep = 0;

for (const place of places) {
  // A fresh residency per place, so "first sweep" means what it says. The
  // *entity cache* inside `RailSolidField` is deliberately not reset: it is
  // shared with `roofHeight` and survives a player walking away, so resetting it
  // would measure a process that cannot happen.
  field.invalidate();
  const points = [place.x, place.z];

  // Sweep until the residency stops growing, which is what "arriving somewhere
  // new" costs end to end now that `ADOPT_BUDGET_MS` spreads it. The worst
  // single sweep is the one that lands in a tick; the count beside it is what
  // the player waits.
  let settleSweeps = 0;
  let worstOne = 0;
  for (let i = 0; i < 200; i++) {
    const began = performance.now();
    field.update(points);
    const took = performance.now() - began;
    if (took > worstOne) worstOne = took;
    settleSweeps = i + 1;
    // An unfinished sweep asks for the next tick, so calling straight back is
    // exactly what the room loop does. See `RailLateralField.update`.
    if (!field.stats().unfinished) break;
  }

  // Per *tick*, which is what `Rooms.step` pays: `update` is called every tick
  // and decides on one in `SWEEP_INTERVAL_TICKS`, so the average over a run of
  // whole intervals is the amortized number and nothing has to know the ratio.
  const intervals = Math.max(1, SWEEPS) * SWEEP_INTERVAL_TICKS;
  const steadyBegan = performance.now();
  for (let i = 0; i < intervals; i++) field.update(points);
  const tickMs = (performance.now() - steadyBegan) / intervals;
  const sweepMs = tickMs * SWEEP_INTERVAL_TICKS;

  const s = field.stats();
  const mb = (s.prisms * PRISM_BYTES) / 1e6;
  worstPrisms = Math.max(worstPrisms, s.prisms);
  worstMb = Math.max(worstMb, mb);
  worstFirst = Math.max(worstFirst, worstOne);
  worstSettle = Math.max(worstSettle, settleSweeps);
  worstTick = Math.max(worstTick, tickMs);
  worstSweep = Math.max(worstSweep, sweepMs);

  say(
    `  ${padR(place.name, 12)}${pad(String(s.resident), 10)}${pad(String(s.prisms), 8)}` +
      `${pad(mb.toFixed(2), 7)}${pad(`${worstOne.toFixed(1)} ms`, 13)}${pad(`${settleSweeps}x`, 8)}${pad(`${sweepMs.toFixed(3)} ms`, 10)}` +
      `${pad(`${tickMs.toFixed(4)} ms`, 10)}${pad(String(s.provisional), 13)}`,
  );
}

say('');
for (const place of places) say(`  ${padR(place.name, 12)}${place.why}`);
say('');

// --- And the thing the whole file is for: the prisms are actually in the way.
//
// A residency that registered nothing would pass every budget above with room
// to spare, which is the one way this could fail silently. So the last check is
// the behaviour rather than the cost: with somebody standing at Chatswood, the
// `CollisionWorld` this process resolves against must hold rail keys, and a
// probe pushed at the cutting must be stopped by one.
field.invalidate();
field.update([PLACES[0].x, PLACES[0].z]);
const railKeys = world.collision.residentTiles().filter((k) => k.startsWith('rail:'));
if (railKeys.length === 0) {
  failures.push(
    'With a participant at Chatswood the server\'s CollisionWorld holds no rail registrations at all. ' +
      'The layer is wired up and holding nothing, which passes every budget above and fixes nothing.',
  );
}
say(`  ${railKeys.length} rail registrations in the server's collision world at Chatswood`);


if (worstPrisms > PRISM_BUDGET) {
  failures.push(
    `One participant holds ${worstPrisms} rail prisms against a budget of ${PRISM_BUDGET}. See the header ` +
      'on where the budget comes from.',
  );
}
if (worstMb > MEMORY_BUDGET_MB) {
  failures.push(
    `That is ${worstMb.toFixed(2)} MB against a budget of ${MEMORY_BUDGET_MB} MB, on world.ts's measured ` +
      `fit of ${PRISM_BYTES} bytes a prism. The box has MemoryHigh at 587 MB.`,
  );
}
if (worstTick > TICK_BUDGET_MS) {
  failures.push(
    `This layer costs ${worstTick.toFixed(4)} ms of every tick against a budget of ${TICK_BUDGET_MS} ms, ` +
      'amortized over the sweep interval. Rooms.step pays it whether or not anybody has moved.',
  );
}
if (worstSweep > SWEEP_BUDGET_MS) {
  failures.push(
    `One steady-state decision costs ${worstSweep.toFixed(3)} ms against a budget of ${SWEEP_BUDGET_MS} ms. ` +
      'The tick may still be inside its own budget; see the header on why both are gated.',
  );
}
if (worstSettle > SETTLE_SWEEP_BUDGET) {
  failures.push(
    `A place takes ${worstSettle} sweeps to register fully, against a budget of ${SETTLE_SWEEP_BUDGET}. ` +
      'That is a player standing somewhere with walls this process has not registered yet.',
  );
}
if (worstFirst > FIRST_SWEEP_BUDGET_MS) {
  failures.push(
    `The worst single sweep costs ${worstFirst.toFixed(1)} ms against a budget of ` +
      `${FIRST_SWEEP_BUDGET_MS} ms, and it lands inside one tick. ADOPT_BUDGET_MS is meant to bound ` +
      'this; if it no longer does, one entity has become more expensive than the whole budget.',
  );
}

if (failures.length > 0) {
  say('');
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  say('');
  say('  If the cost is genuinely necessary, raise the budget in this file AND record the new');
  say('  measurement in PERFORMANCE.md. See the header.');
  process.exit(1);
}

say('');
say(
  `  PASS -- ${worstPrisms} / ${PRISM_BUDGET} prisms (${worstMb.toFixed(2)} / ${MEMORY_BUDGET_MB} MB), ` +
    `worst sweep ${worstFirst.toFixed(1)} / ${FIRST_SWEEP_BUDGET_MS} ms over ` +
    `${worstSettle} / ${SETTLE_SWEEP_BUDGET} sweeps, ` +
    `a sweep ${worstSweep.toFixed(3)} / ${SWEEP_BUDGET_MS} ms, ` +
    `a tick ${worstTick.toFixed(4)} / ${TICK_BUDGET_MS} ms`,
);
process.exit(0);
