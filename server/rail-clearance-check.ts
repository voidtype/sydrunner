/**
 * The rail's clearance, measured against the real bake, as a check that fails.
 *
 *     bun run server/rail-clearance-check.ts
 *     bun run server/rail-clearance-check.ts --from Chatswood --to Roseville
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists
 *
 * `game/rail.ts` bakes a `vertexClearance` per polyline vertex -- `trackY -
 * groundY` in metres -- and RAIL-VERTICAL.md's one rule is that this number,
 * and not a discrete class, is what the geometry reads. A positive clearance is
 * a structure holding the track over the terrain; a negative one is the terrain
 * over the track, and the train renders buried.
 *
 * The bake is broken in exactly that way, and has been for a while. On the
 * current bake 264.5 km of the 937 km of watchable track -- 28% of it -- sits
 * under the terrain with no tunnel, bridge, cutting or embankment flag to say
 * why, and 3.6 km of that is flagged BRIDGE, which is a self-contradiction: a
 * span cannot be under the ground. A buried train is invisible, and "why can't
 * I see the train here" is the question this file answers, both as a network
 * total and as a per-stretch table a person can read off.
 *
 * This is the same measurement `world.ts`'s `loadRail` decodes and the browser
 * reads from `/rail/rail.bin`, run under Bun with no three and no DOM, on the
 * pattern of `server/tick-profile.ts`: it decodes the shipped bake, walks every
 * segment, prints where the ground is over the track, and **returns 1** if the
 * buried total has drifted past the budget below.
 *
 * ---------------------------------------------------------------------------
 * ## The budget, and why it is a ratchet, not a target
 *
 * `BURIED_BUDGET_KM` and `BURIED_BUDGET_PCT` are set **at a broken state**, a
 * little above what the current bake measures, on purpose. This is not a goal
 * and it is not a tolerance for a defect: it is a fence. Twenty-eight percent of
 * the watchable railway is already buried, and the only thing that number can
 * do is get worse -- a retile that re-samples the terrain grid, a flag that
 * stops reaching a span, a carve that skips a corridor -- and none of it shows
 * up anywhere else, because a buried train is invisible and an invisible train
 * is the one nobody reports.
 *
 * The fix is the terrain carve (RAIL-VERTICAL.md, the cutting and embankment
 * passes), and whoever lands it should **lower these two numbers** to the new
 * measurement, the way `tick-profile.ts`'s header says to lower a budget that
 * has come down. Raising them is how 28% would become 35% and nobody would
 * know.
 *
 * ---------------------------------------------------------------------------
 * ## What it does not count
 *
 * A buried train is **correct** in a tunnel and a subway: the track is built
 * under the ground by design, and `SPAN_TUNNEL` and `SPAN_SUBWAY` say so. Those
 * metres are reported and excluded from the buried total, exactly as the header
 * of `game/rail.ts` says a negative clearance is only a defect where no
 * structure owns it. The buried total is the track that is under the ground
 * with nothing there to explain it.
 */

import {
  decodeRail,
  SPAN_TUNNEL,
  SPAN_SUBWAY,
  SPAN_BRIDGE,
  SPAN_CUTTING,
  SPAN_EMBANKMENT,
  SPAN_ELECTRIFIED,
  type RailBake,
  type RailLine,
  type RailDirection,
} from '../client/src/game/rail.ts';
/*
 * The cut's own rule, imported rather than restated, because this file's whole
 * job is to say what a player can see and only `inCutting` knows that. It is
 * three-free and DOM-free -- a flag test and a depth comparison -- which is why
 * a server-side driver can ask it.
 */
import { inCutting } from '../client/src/world/rail-cut.ts';

// --- The budgets -----------------------------------------------------------------

/**
 * What the buried total may be, in kilometres of track.
 *
 * Set at a broken state: the current bake measures 264.5 km, and this is a
 * little above it. See the header for why a ratchet sits at a defect rather than
 * at zero, and for the carve that is the fix. Lower this with the carve; do not
 * raise it.
 */
export const BURIED_BUDGET_KM = 270;

/**
 * And what the buried total may be, as a percentage of the watchable track
 * (everything that is not a tunnel or a subway).
 *
 * The current bake measures 28.2%, and this is a little above it. The
 * percentage rather than the kilometrage is the second fence: a retile that
 * adds track but not buried track would pass the kilometrage and fail the
 * percentage, and vice versa, so the two together hold the buried fraction of
 * the watchable railway rather than either alone.
 */
export const BURIED_BUDGET_PCT = 29;

/**
 * What may be buried with **nothing carving it**, in kilometres.
 *
 * The real defect, and a much smaller number than the two above: today 3.1 km,
 * against 264.5 km buried. See the gate below for why the distinction is the
 * whole point, and `world/rail-cut.BRIDGE_BURIED_DEPTH` for the rule that
 * decides it. A little above today's measurement, and it comes down when the
 * remaining bridge decks get a discriminator better than a depth threshold.
 */
export const UNCUT_BUDGET_KM = 3.5;

// --- Options ---------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const FROM = flag('from', '');
const TO = flag('to', '');

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s;
const padR = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);

/** The `SPAN_*` flags as a short code for a table cell. See `game/rail.ts`. */
function flagCode(flags: number): string {
  let s = '';
  if ((flags & SPAN_TUNNEL) !== 0) s += 'T';
  if ((flags & SPAN_SUBWAY) !== 0) s += 'S';
  if ((flags & SPAN_BRIDGE) !== 0) s += 'B';
  if ((flags & SPAN_CUTTING) !== 0) s += 'C';
  if ((flags & SPAN_EMBANKMENT) !== 0) s += 'E';
  if ((flags & SPAN_ELECTRIFIED) !== 0) s += 'X';
  return s || '·';
}

// --- The bake --------------------------------------------------------------------

const railPath = process.env.SYDNEY_RAIL ?? new URL('../client/public/rail/rail.bin', import.meta.url).pathname;
const bootBegan = performance.now();
const bake = decodeRail(await Bun.file(railPath).arrayBuffer());
say(
  `--- rail-clearance: ${bake.lines.length} lines, ${bake.vertices.length / 3} vertices, ` +
    `${bake.vertexClearance.length} clearances, loaded in ${((performance.now() - bootBegan) / 1000).toFixed(1)} s`,
);

// --- The measurement --------------------------------------------------------------
//
// A segment is one polyline edge, `cum[v+1] - cum[v]`, and its clearance is the
// clearance of its start vertex -- the number the geometry reads at that point.
// A segment that is not positive or is absurd (> 2000 m) is a concatenation seam
// between two directions, not track, and is skipped. The clearance is per
// vertex, so the metre it classifies is the edge it starts, and the last vertex
// of a direction classifies nothing, which is the one metre this is off by.

let totalM = 0;
let tunnelM = 0;
let nonTunnelM = 0;
let buriedM = 0;
let buriedBridgeM = 0;
let uncutM = 0;
let worst = { c: 0, name: '', x: 0, z: 0 };
const perLineBuried: number[] = new Array(bake.lines.length).fill(0);

for (let li = 0; li < bake.lines.length; li++) {
  const line = bake.lines[li];
  for (const dir of line.dirs) {
    const off = dir.vertexOff;
    const cnt = dir.vertexCount;
    for (let v = off; v < off + cnt - 1; v++) {
      const L = bake.cum[v + 1] - bake.cum[v];
      if (L <= 0 || L > 2000) continue;
      totalM += L;
      const flags = bake.vertexFlags[v];
      const c = bake.vertexClearance[v];
      // A tunnel or a subway is buried by design, and is not a defect.
      if ((flags & SPAN_TUNNEL) !== 0 || (flags & SPAN_SUBWAY) !== 0) {
        tunnelM += L;
        continue;
      }
      nonTunnelM += L;
      if (c < -1) {
        buriedM += L;
        perLineBuried[li] += L;
        // **The number that is actually a defect.** `world/rail-cut.RailCut`
        // carves the corridor out of the terrain wherever `inCutting` says so
        // and `rail-geo` builds a trench in the hole, so most of the buried
        // total is a train in a trench -- visible, and correct. What is left is
        // track with the ground still standing over it, which is a train inside
        // a hill. `depth` is `groundY - railY`, the negation of the clearance.
        if (!inCutting(flags, -c)) uncutM += L;
        // A bridge is a span, and a span under the ground is a contradiction.
        if ((flags & SPAN_BRIDGE) !== 0) buriedBridgeM += L;
      }
      // The worst is the most-negative non-tunnel clearance: a tunnel's
      // negative clearance is correct and would otherwise hide the defect.
      if (c < worst.c) {
        worst = { c, name: line.name, x: bake.vertices[v * 3], z: bake.vertices[v * 3 + 2] };
      }
    }
  }
}

const buriedKm = buriedM / 1000;
const buriedPct = nonTunnelM > 0 ? (buriedM / nonTunnelM) * 100 : 0;

// --- The report -------------------------------------------------------------------

say('');
say(`  total track ............ ${(totalM / 1000).toFixed(1)} km`);
say(`  tunnel / subway ........ ${(tunnelM / 1000).toFixed(1)} km   (correctly buried, not counted)`);
say(`  buried, not tunnel ..... ${buriedKm.toFixed(1)} km = ${buriedPct.toFixed(1)}% of watchable track`);
say(`    of which BRIDGE ...... ${(buriedBridgeM / 1000).toFixed(1)} km   (a span under the ground)`);
say(`    the cut carves ....... ${((buriedM - uncutM) / 1000).toFixed(1)} km   (a train in a trench, which is visible and correct)`);
say(`    NOTHING carves ....... ${(uncutM / 1000).toFixed(1)} km   <-- the train is inside a hill here`);
say(`  worst clearance ........ ${worst.c.toFixed(1)} m  ${worst.name}  (${Math.round(worst.x)}, ${Math.round(worst.z)})`);
say('');
say('  per-line buried, worst first:');
const lineRows = bake.lines
  .map((line, i) => ({ name: line.name, km: perLineBuried[i] / 1000 }))
  .sort((a, b) => b.km - a.km);
for (const r of lineRows) {
  say(`  ${padR(r.name, 28)}${pad(r.km.toFixed(1), 8)} km`);
}
say('');

// --- The per-stretch mode ----------------------------------------------------------
//
// The mode a person uses when they ask "why can't I see the train here": two
// station names on one line, and the vertex-by-vertex table of arc length,
// clearance and flags between them. The arc is measured from the `--from`
// station, so that station is 0 and the table reads like the stretch the person
// is looking at. A direction where `--from` comes before `--to` is preferred, so
// the arc is non-negative; the two directions of a line are reverses, so one of
// them always is.

function findStretch(
  bake: RailBake, fromName: string, toName: string,
): { line: RailLine; dir: RailDirection } | null {
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const f = dir.stops.find((s) => s.name === fromName && s.calls);
      const t = dir.stops.find((s) => s.name === toName && s.calls);
      if (f && t && f.s <= t.s) return { line, dir };
    }
  }
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const f = dir.stops.find((s) => s.name === fromName && s.calls);
      const t = dir.stops.find((s) => s.name === toName && s.calls);
      if (f && t) return { line, dir };
    }
  }
  return null;
}

if (FROM && TO) {
  const stretch = findStretch(bake, FROM, TO);
  if (stretch === null) {
    say(`  no direction has both ${FROM} and ${TO} as calling stops`);
    process.exit(1);
  }
  const { line, dir } = stretch;
  const f = dir.stops.find((s) => s.name === FROM)!;
  const t = dir.stops.find((s) => s.name === TO)!;
  const lo = Math.min(f.s, t.s);
  const hi = Math.max(f.s, t.s);
  const base = f.s;

  say(`--- ${line.name} ${dir.label}: ${FROM} -> ${TO}, ${(hi - lo).toFixed(0)} m ---`);
  say('  flags: T tunnel  S subway  B bridge  C cutting  E embankment  X electrified');
  say(`  ${padR('arc(m)', 8)}${padR('clearance(m)', 14)}flags   note`);
  let buried = 0;
  let tunnelStart = -1;
  let tunnelEnd = -1;
  for (let v = dir.vertexOff; v < dir.vertexOff + dir.vertexCount - 1; v++) {
    const c0 = bake.cum[v];
    if (c0 < lo || c0 > hi) continue;
    const L = bake.cum[v + 1] - bake.cum[v];
    if (L <= 0 || L > 2000) continue;
    const arc = c0 - base;
    const flags = bake.vertexFlags[v];
    const c = bake.vertexClearance[v];
    const tunnel = (flags & SPAN_TUNNEL) !== 0 || (flags & SPAN_SUBWAY) !== 0;
    const buriedHere = !tunnel && c < -1;
    if (tunnel && tunnelStart < 0) tunnelStart = arc;
    if (tunnel) tunnelEnd = arc;
    if (buriedHere) buried += L;
    const note = tunnel ? 'TUN' : buriedHere ? '*BURIED' : '';
    say(
      `  ${pad(arc.toFixed(0), 8)}${pad(c.toFixed(1), 14)}${flagCode(flags)}   ${note}`,
    );
  }
  say('');
  say(`  ${padR('window', 8)}${(hi - lo).toFixed(0)} m`);
  say(`  ${padR('buried', 8)}${buried.toFixed(0)} m of non-tunnel track`);
  if (tunnelStart >= 0) {
    say(`  ${padR('tunnel', 8)}${tunnelStart.toFixed(0)}-${tunnelEnd.toFixed(0)} m`);
  }
  say('');
}

// --- The gate ---------------------------------------------------------------------

const failures: string[] = [];
if (buriedKm > BURIED_BUDGET_KM) {
  failures.push(
    `${buriedKm.toFixed(1)} km of track is buried against a budget of ${BURIED_BUDGET_KM} km. ` +
      `The terrain carve has not kept up with the bake; lower the budget with the carve, do not raise it.`,
  );
}
if (buriedPct > BURIED_BUDGET_PCT) {
  failures.push(
    `${buriedPct.toFixed(1)}% of the watchable track is buried against a budget of ${BURIED_BUDGET_PCT}%. ` +
      `The buried fraction of the railway has grown; the carve is the fix.`,
  );
}
/*
 * **And the gate that matters most, which is not either of the two above.**
 *
 * Buried is not invisible. The corridor cut carves 98.8% of the buried total
 * and `rail-geo` builds a trench in the hole, so nearly all of it is a train in
 * a cutting -- which is what a railway in Sydney largely is. The two budgets
 * above watch a number that is mostly *correct*, and they are kept because a
 * jump in it still means the bake moved under the cut.
 *
 * This one watches the defect: track with the ground standing over it and
 * nothing carving. Today that is 3.1 km, all of it bridge decks the DEM has
 * buried -- Circular Quay and its neighbours, where the DEM is reading the
 * roofs of the CBD rather than earth, and where `BRIDGE_BURIED_DEPTH` in
 * `world/rail-cut.ts` deliberately declines to dig. A budget close above it, so
 * a rule change that starts leaving track under a hill is caught on the run
 * that does it.
 */
if (uncutM / 1000 > UNCUT_BUDGET_KM) {
  failures.push(
    `${(uncutM / 1000).toFixed(1)} km of track has the ground over it and nothing carving, against a budget of ` +
      `${UNCUT_BUDGET_KM} km. This is the one a player sees: the train is inside a hill. ` +
      `See inCutting and BRIDGE_BURIED_DEPTH in client/src/world/rail-cut.ts.`,
  );
}

if (failures.length > 0) {
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  say('');
  say('  Read the per-line table above for where the ground is over the track, and the');
  say('  `--from/--to` mode for a single stretch. If the buried track is genuinely');
  say('  necessary, raise the budget in this file AND record the new measurement.');
  process.exit(1);
}

say(
  `  PASS -- buried ${buriedKm.toFixed(1)} / ${BURIED_BUDGET_KM} km, ` +
    `${buriedPct.toFixed(1)} / ${BURIED_BUDGET_PCT} %, ` +
    `uncarved ${(uncutM / 1000).toFixed(1)} / ${UNCUT_BUDGET_KM} km`,
);
process.exit(0);
