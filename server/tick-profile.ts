/**
 * The tick's budget, measured against the real world, as a check that fails.
 *
 *     bun run server/tick-profile.ts
 *     bun run server/tick-profile.ts --ticks 3000 --players 0,1,8
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists
 *
 * PERFORMANCE.md phase 1 measured 0.20 ms p50 at *sixteen* players and wrote it
 * down. A year later the same host was spending **3.30 ms on one player**, and
 * the way that happened is worth stating plainly because it is the failure this
 * file exists to make impossible: nothing regressed in a single merge. A dozen
 * workstreams each added an ambient system that cost 0.1 ms, every one of them
 * defensible on its own, and the only number that would have shown the sum was
 * a `curl /stats` nobody ran.
 *
 * A capacity curve in a document is a measurement of the past. This is the same
 * measurement wired to an exit code, on the pattern of `server/take-check.ts`
 * and `server/cardamage-check.ts`: it boots the shipped world, steps a real
 * `Simulation` three thousand times with nobody, one person and eight people in
 * it, prints where every microsecond went, and **returns 1** if the ambient tick
 * has drifted past the budget below.
 *
 * ---------------------------------------------------------------------------
 * ## The budget, and where the number comes from
 *
 * `AMBIENT_BUDGET_MS` is what a tick costs with **nobody connected**. That is
 * the number that matters most, because it is the part of the tick that is not
 * anybody's fault: every player-driven cost at least scales with something the
 * operator can point at, and a sweep over every powerup in Sydney does not.
 *
 * Measured on an M-series MacBook, 2026-08-20, over 3,000 ticks against the
 * `middle` bake, six runs:
 *
 *                              0 players        1 player        8 players
 *     before workstream AA     0.157 ms         0.485 ms        0.793 ms
 *     after                    0.012-0.015 ms   0.035-0.038 ms  0.152-0.168 ms
 *
 * The budgets are the **worst** of those runs plus about a third: `0.020`
 * ambient and `0.050` at one player. Deliberately not tighter -- a check that
 * fails because the laptop was compiling something else is a check people stop
 * running, and these still catch a 35% regression on the day it lands. If it
 * fails on a loaded machine, run it on an idle one; do not raise the number to
 * make it pass.
 *
 * ---------------------------------------------------------------------------
 * ## Workstream AC: a 32-player column, and a budget on the slope
 *
 * AA left `characters` and `streetlife` at 0.15 ms of the 0.20 at eight players
 * and said so; AC took the per-player cell and anchor enumerations out of both.
 * Same laptop, 2026-08-21, the two builds run **alternately** -- before, after,
 * before, after, eight minutes end to end -- rather than one after the other.
 * That is not fussiness: half of what these two sections cost depends on the
 * **time of day**, because the eshays' bias is gated off in daylight and the
 * Karens', tradies', influencer's and agent's are gated off at night. A run at
 * two in the afternoon and a run at midnight are measuring different cities, and
 * a before/after pair an hour apart is measuring the clock. The ranges below are
 * the two runs of each; this pair was measured at cycle phase 0.02, which is the
 * small hours, so the 267-station scan behind the eshays was live.
 *
 *                              0 players    1 player      8 players     32 players
 *     characters, before       0.0002       0.0087-0.0106 0.0778-0.0804 0.2802-0.2898
 *     characters, after        0.0001       0.0012-0.0013 0.0058        0.0203-0.0213
 *     streetlife, before       0.0004       0.0069-0.0078 0.0479-0.0526 0.1772-0.1854
 *     streetlife, after        0.0003-0.0004 0.0026-0.0027 0.0107-0.0115 0.0358-0.0382
 *     TOTAL, before            0.0111-0.0135 0.0330-0.0404 0.1896-0.1902 0.6003-0.6876
 *     TOTAL, after             0.0139-0.0140 0.0231-0.0242 0.0607-0.0692 0.1805-0.2105
 *
 * The two sections together are **0.017 ms at eight players against 0.129**, and
 * 0.058 against 0.466 at thirty-two. What is left of them is mostly the one
 * evaluation per cell and per anchor that a tick genuinely owes, which is why
 * the eight- and thirty-two-player columns are now within a factor of four of
 * each other rather than a factor of eight.
 *
 * The **32-player column** is new and it is the point: at eight players the two
 * sections were 0.15 ms and the honest question was what that becomes at the
 * room cap of 100. Extrapolating a straight line off two points is how a
 * capacity curve in a document becomes wrong, so the column is measured.
 *
 * `SOLO_BUDGET_MS` comes down from 0.050 to 0.035 on the same rule as before --
 * the worst of the runs plus about a third -- and `AMBIENT_BUDGET_MS` stays at
 * 0.020, because nothing AC did touches a room with nobody in it and moving a
 * budget that is not under pressure is just noise in the diff.
 *
 * The new gate is `PER_PLAYER_BUDGET_MS`, on the **slope** rather than on a
 * column: `(total at 32 - total at 1) / 31`, which is what one more person costs
 * this host. That is the number the header's whole story is about -- a system
 * that sweeps the world once per player does not show up as a big constant, it
 * shows up as a slope -- and unlike the 8- and 32-player totals it does not
 * depend on how many synthetic bodies happen to be standing on one spawn tile.
 * Measured at 0.0051-0.0060 ms after AC against 0.0183-0.0209 before it.
 *
 * The same four fixes took the **live host** -- `server/index.ts` with
 * `server/loadtest.ts` against it, which is the measurement the brief started
 * from -- from **1.30 ms to 0.46 ms** median per host tick at one player, and
 * from 1.17 ms to 0.78 ms at eight. The production box is roughly 2.5x slower
 * than this laptop on the same work (3.30 ms there against 1.30 ms here,
 * before), so one player is now about **1.2 ms** of a 16.67 ms tick.
 *
 * A second budget at one player is not what the brief asked for and is here
 * anyway, because the ambient row cannot see the two systems that were actually
 * the most expensive: `stepCharacters` and `stepStreetlife` are loops over
 * combatants, so with nobody in the room they are free, and a check that only
 * gated the empty room would have let the whole `O(players x world)` class back
 * in. The eight-player row is printed and not gated, because eight synthetic
 * bodies standing on one spawn tile is a fair CPU measurement and an unfair
 * *world* measurement -- they share a hexagon, and the residency work a real
 * eight is spread over does not happen.
 *
 * ---------------------------------------------------------------------------
 * ## What it does not measure
 *
 * There are no sockets, so `aoi`, `encode` and `broadcast` are near zero. Those
 * are the three sections that *do* scale with the player count in the way
 * everybody expects, they are measured properly by `server/loadtest.ts` against
 * a real host, and duplicating them here would mean maintaining a fake
 * transport for the privilege of a worse number. This file is about the part of
 * the tick that runs whether or not anybody is listening.
 */

import { RoomHost } from './room.ts';
import { loadWorld } from './world.ts';
import { ProfileReader, SECTION_NAMES, topSections } from './profile.ts';

// --- The budgets ----------------------------------------------------------------

/**
 * What a tick may cost with nobody in the room, on the machine described in the
 * header. See there for the derivation; it is the measured figure plus 25%.
 *
 * If this fails on your machine and you believe the machine rather than the
 * code, the honest fix is to run it on the reference laptop or to raise the
 * number **and say so in PERFORMANCE.md with a fresh measurement**. Raising it
 * quietly is exactly how 0.20 ms became 3.30.
 */
export const AMBIENT_BUDGET_MS = 0.020;

/** And with one person standing in it. See the header for why both are gated. */
export const SOLO_BUDGET_MS = 0.035;

/**
 * What **one more player** may cost, milliseconds per tick.
 *
 * The slope between the 1- and 32-player columns, which is the shape of every
 * regression this file exists to catch: a sweep over the world per combatant is
 * invisible in the ambient row, small in the solo row, and ruinous at the room
 * cap. Workstream AC measured 0.0051-0.0060 here against 0.0183-0.0209 before
 * it; the budget is the worse of those plus a third, because the 32-player
 * column is the noisiest one on the table -- it is the only column where the
 * `advance` integrator and the rewind index are doing real work beside the
 * ambient systems, and `events` alone moved by 0.017 ms between two runs of the
 * same build.
 *
 * At the room cap of 100 this budget is 0.8 ms of a 16.67 ms tick, on a laptop
 * that is about 2.5x the production box. That is the number to hold.
 */
export const PER_PLAYER_BUDGET_MS = 0.008;

// --- Options ----------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const TICKS = Number(flag('ticks', '3000'));
// WORKSTREAM AC: 32 by default. The column costs about twenty seconds of wall
// clock and it is the only place the slope of the tick against the player count
// is a measurement rather than a guess. See the header.
const COUNTS = flag('players', '0,1,8,32').split(',').map((s) => Number(s.trim()));

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s;
const padR = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);

// --- The world --------------------------------------------------------------------

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const bootBegan = performance.now();
const world = await loadWorld(root);
say(
  `--- tick-profile: ${world.index.tiles.length} tiles, ${world.points.length} powerups, ` +
    `${world.bikeSpots?.length ?? 0} bikes, loaded in ${((performance.now() - bootBegan) / 1000).toFixed(1)} s`,
);

/**
 * Let the event loop run for a moment.
 *
 * `HexResidency.update` starts file reads and forgets them; the decode happens
 * on later ticks inside its own budget. A profile taken before the residency
 * had settled would be measuring a city with holes in it -- fewer lane routes,
 * fewer parked cars, fewer of everything the sweeps below walk -- and would
 * report a tick that gets *slower* the longer the process lives, which is the
 * opposite of a useful budget.
 */
const breathe = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- One measurement ---------------------------------------------------------------

interface Row {
  players: number;
  /** Milliseconds per tick, per section. */
  phases: Record<string, number>;
  /** The sum of the sections: what a tick of this room costs. */
  total: number;
  /** What the profiler itself cost per tick, in microseconds. */
  overheadUs: number;
}

async function measure(players: number): Promise<Row> {
  // A host rather than a bare `Simulation`, for one reason: `RoomHost.step`
  // is where the residency is pumped, and a simulation stepped without it
  // would walk a city that never changes -- which is both the wrong
  // measurement and, at 3,000 ticks, a slowly emptying one.
  //
  // **Zero bots**, unlike the real host's two, because a bot is a player for
  // every purpose in this file: it is in `ordered`, it is advanced, it is
  // indexed, and every `O(players x world)` sweep runs for it. Two free ones
  // would make the "0 players" row a lie.
  const host = new RoomHost(world, 1, 100, 0);
  const room = host.rooms[0];
  for (let i = 0; i < players; i++) room.sim.join(0, null);

  // --- Warm up. Three things need it and they need different amounts.
  //
  // The residency has to reach its caps (a second or two of real time, because
  // the reads are asynchronous and the decode is budgeted per tick); the JIT
  // has to see every branch of a tick that only takes some of them on some
  // ticks -- the snapshot phase is one tick in three; and the powerup respawn
  // clocks have to reach steady state.
  for (let warm = 0; warm < 12; warm++) {
    for (let i = 0; i < 60; i++) host.step();
    await breathe(60);
  }

  // --- And the measurement, in one uninterrupted run.
  //
  // No `await` inside it: an `await` yields to the residency's decode, whose
  // cost would land on whichever section happened to be open. The 3,000 ticks
  // below are 50 s of game time run in well under a second of wall clock, which
  // is the whole point of a driver over a live host.
  const reader = new ProfileReader();
  reader.take(room.sim.profile);
  for (let i = 0; i < TICKS; i++) host.step();
  const phases = reader.take(room.sim.profile);

  let total = 0;
  for (const v of Object.values(phases)) total += v;
  return {
    players,
    phases,
    total,
    overheadUs: reader.lastTicks > 0 ? (reader.lastOverheadMs / reader.lastTicks) * 1000 : 0,
  };
}

// --- The report ---------------------------------------------------------------------

const rows: Row[] = [];
for (const n of COUNTS) rows.push(await measure(n));

say('');
say(`  ${TICKS} ticks per column, real world, no sockets. Milliseconds per tick.`);
say('');
say(`  ${padR('section', 14)}${rows.map((r) => pad(`${r.players}p`, 11)).join('')}`);
say(`  ${'-'.repeat(14 + rows.length * 11)}`);
for (const name of SECTION_NAMES) {
  // A section that is zero in every column is a section with no sockets under
  // it or no feature exercising it, and printing thirty rows of zeroes buries
  // the six that matter.
  if (!rows.some((r) => (r.phases[name] ?? 0) >= 0.0005)) continue;
  say(`  ${padR(name, 14)}${rows.map((r) => pad((r.phases[name] ?? 0).toFixed(4), 11)).join('')}`);
}
say(`  ${'-'.repeat(14 + rows.length * 11)}`);
say(`  ${padR('TOTAL', 14)}${rows.map((r) => pad(r.total.toFixed(4), 11)).join('')}`);
say(`  ${padR('profiler us', 14)}${rows.map((r) => pad(r.overheadUs.toFixed(2), 11)).join('')}`);
say('');
for (const r of rows) {
  say(`  ${r.players} player(s): ${r.total.toFixed(3)} ms = ${topSections(r.phases, 6, 0)}`);
}
say('');

// --- The gate --------------------------------------------------------------------------

const failures: string[] = [];
const ambient = rows.find((r) => r.players === 0);
const solo = rows.find((r) => r.players === 1);
if (ambient && ambient.total > AMBIENT_BUDGET_MS) {
  failures.push(
    `The ambient tick is ${ambient.total.toFixed(4)} ms against a budget of ${AMBIENT_BUDGET_MS} ms. ` +
      `The most expensive section is "${topSections(ambient.phases, 1, 0)}". ` +
      `Something now runs per tick that does not depend on anybody being here.`,
  );
}
if (solo && solo.total > SOLO_BUDGET_MS) {
  failures.push(
    `One player costs ${solo.total.toFixed(4)} ms against a budget of ${SOLO_BUDGET_MS} ms. ` +
      `The most expensive section is "${topSections(solo.phases, 1, 0)}". ` +
      `Something is O(players x world) again.`,
  );
}
// --- WORKSTREAM AC: the slope, which is the shape of the failure this file is
// about. Only gated when both ends of it were actually measured, so
// `--players 0,1` still runs and still gates what it can.
const crowd = rows.find((r) => r.players === 32);
if (solo && crowd) {
  const perPlayer = (crowd.total - solo.total) / (crowd.players - solo.players);
  if (perPlayer > PER_PLAYER_BUDGET_MS) {
    // Which section grew the most between the two columns, which is almost
    // always the answer and is a great deal more useful than the biggest
    // section in either one.
    const growth: Record<string, number> = {};
    for (const name of SECTION_NAMES) {
      growth[name] = ((crowd.phases[name] ?? 0) - (solo.phases[name] ?? 0)) / (crowd.players - solo.players);
    }
    failures.push(
      `Each additional player costs ${perPlayer.toFixed(4)} ms against a budget of ${PER_PLAYER_BUDGET_MS} ms ` +
        `(${solo.total.toFixed(4)} ms at 1, ${crowd.total.toFixed(4)} at 32). The sections that grew per player ` +
        `are ${topSections(growth, 4, 0)}. At the room cap that is ${(perPlayer * 100).toFixed(2)} ms a tick.`,
    );
  }
}

if (failures.length > 0) {
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  say('');
  say('  Read the section table above, then `server/profile.ts` for what each name covers.');
  say('  If the cost is genuinely necessary, raise the budget in this file AND record the');
  say('  new measurement in PERFORMANCE.md. A budget raised quietly is how 0.20 ms became 3.30.');
  process.exit(1);
}

const slope = solo && crowd ? (crowd.total - solo.total) / (crowd.players - solo.players) : null;
say(`  PASS -- ambient ${ambient?.total.toFixed(4) ?? '?'} / ${AMBIENT_BUDGET_MS} ms, ` +
  `solo ${solo?.total.toFixed(4) ?? '?'} / ${SOLO_BUDGET_MS} ms, ` +
  `per player ${slope === null ? '?' : slope.toFixed(4)} / ${PER_PLAYER_BUDGET_MS} ms`);
process.exit(0);
