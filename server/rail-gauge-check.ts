/**
 * What the railway builds inside its own trains.
 *
 *     bun run server/rail-gauge-check.ts
 *     bun run server/rail-gauge-check.ts --station Wollstonecraft
 *     bun run server/rail-gauge-check.ts --spacing
 *
 * ---------------------------------------------------------------------------
 * ## The report
 *
 *   > *"the platforms are so badly aligned at curved places like woolstronecraft
 *   > ... im passing thru platform all the time"* -- *"passing through a lot of
 *   > rail assets, but the platforms are the worst"* -- *"i think part of it is
 *   > that adjascent tracks' assets overlay other tracks"*
 *
 * Three sentences and three different theories of the same defect, and the point
 * of this file is that **nobody has to pick one**. It sweeps the solid body of a
 * carriage along every direction in the bake -- the exact polylines the trains
 * are animated on -- and asks of every solid the rail builder emits whether it
 * is inside that swept volume. An intrusion is reported with its asset kind, the
 * station or segment that wrote it, and *which of the three mechanisms put it
 * there*, because the three are separable by measurement:
 *
 *   - **own** -- the asset belongs to the very track the train is on. That can
 *     only be the platform-box-versus-curve error: a 160 m straight slab against
 *     a curving running line.
 *   - **neighbour** -- the asset belongs to a *different* track of the same
 *     corridor and laps over this one. That is the fixed-lateral-offset error:
 *     every writer builds to a constant with no idea another road is 4 m away.
 *   - **crossing** -- the asset belongs to a track that is not parallel here at
 *     all: a junction, a flyover, a turnout. Reported separately because a
 *     lateral budget cannot help it and a diamond crossing genuinely has track
 *     through everything.
 *
 * ---------------------------------------------------------------------------
 * ## Section A exists so the fix is not guessed
 *
 * Before any of that it measures the **corridor spacing**: for every length of
 * open track, how far is the nearest parallel running line on each side. That
 * one distribution decides whether a lateral budget is the fix or a distraction,
 * because the writers' extents are all constants and can simply be laid against
 * it. If the median spacing is under twice a writer's reach, that writer has
 * been overlapping its neighbour since the day it was written and no amount of
 * curve-following will help.
 *
 * ---------------------------------------------------------------------------
 * ## Why the gauge is `world/envelope.structureGauge` and not a number here
 *
 * `envelope.RAIL_HALF_M` is 3.6 m and is the volume a *building* is carved out
 * of; a platform stands at 1.62 m and is meant to. Testing the railway's own kit
 * against the building rule would condemn every platform in the state, so the
 * rail's rule is the tighter one -- the drawn car body plus the smallest gap a
 * real platform leaves -- and it lives in `envelope.ts` where the writers, the
 * server and this file all read the same one. See `STRUCTURE_MARGIN_M`: the
 * budget is **seventy millimetres**, which is why the box could never work.
 */

import {
  decodeRail,
  SPAN_TUNNEL,
  type RailBake,
} from '../client/src/game/rail.ts';
import {
  buildNetwork,
  planStation,
  stationSolids,
  framePoint,
  PLATFORM_INNER,
  PLATFORM_WIDTH,
  PLATFORM_HALF_LENGTH,
  CANOPY_HALF_LENGTH,
  CANOPY_OVERHANG,
  CANOPY_HEIGHT,
  PLATFORM_HEIGHT,
  TACTILE_INSET,
  TACTILE_WIDTH,
  MAST_OFFSET,
  MAST_HEIGHT,
  MAST_RADIUS,
  GANTRY_HALF_SPAN,
  FENCE_OFFSET,
  BALLAST_BASE_HALF,
  BALLAST_TOP_DROP,
  CESS_INNER,
  SOLID_PLATFORM_DECK,
  SOLID_STAIR,
  SOLID_LANDING,
  SOLID_FOOTBRIDGE_DECK,
  SOLID_FOOTBRIDGE_STAIR,
  SOLID_HOUSE,
  SOLID_BOX_PLATFORM,
  SOLID_SHAFT_HEAD,
  type FrameSolid,
  type PlacedStation,
  type TrackFrame,
} from '../client/src/world/rail-solids.ts';
import {
  CAR_BODY_HALF_M,
  CAR_BODY_FLOOR_M,
  CAR_BODY_ROOF_M,
  STRUCTURE_MARGIN_M,
} from '../client/src/world/envelope.ts';
import { spineAround, straightSpine } from '../client/src/world/platform-spine.ts';
import {
  buildTrackAtlas,
  atlasFaults,
  corridorBudget,
  ownsAlignment,
  COINCIDENT_M,
  CORRIDOR_M,
  BUDGET_MARGIN_M,
} from '../client/src/world/track-atlas.ts';

// --- The budgets -------------------------------------------------------------------

/**
 * How many metres of running line may have **anything at all** inside the car
 * body's swept volume.
 *
 * ---------------------------------------------------------------------------
 * **A target, not a ratchet, and this is the one check in the family that is
 * deliberately red.** `rail-clearance-check.ts` sets its budgets a little above
 * a broken measurement so the defect cannot grow; that is right for a number
 * nobody is going to fix this month. This one is different because
 * `RAIL-CORRIDOR.md` says so in as many words:
 *
 *   > The gauge audit is the acceptance for all of it, and **it must be red
 *   > today**: if P0's audit does not convict the current build of exactly what
 *   > the owner rode through, the audit is measuring the wrong thing.
 *
 * So the budget is set where the railway has to end up, and the check fails
 * until it gets there. Ten kilometres of the 976 km swept is one per cent, and
 * it is not zero for one honest reason: a diamond crossing genuinely has another
 * railway's ballast inside the gauge, and no lateral budget can or should move
 * it. The `crossing` row in section C is that population, and when the other two
 * rows reach zero this number comes down to whatever it measures.
 */
export const FOULED_BUDGET_M = 10000;

/**
 * And of that, how much may be **the platform**. Zero.
 *
 * Split out and set at nothing because it is the one the owner can see from a
 * seat: a platform inside a train is not a tolerance, it is the report. A
 * crossing has no platform in it, so unlike the total above this has no honest
 * residue to allow for.
 */
export const FOULED_PLATFORM_BUDGET_M = 0;

// --- Options -----------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const ONLY = flag('station', '');
const TOP = Number(flag('top', '30'));

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// --- The bake ----------------------------------------------------------------------

const railPath = process.env.SYDNEY_RAIL
  ?? new URL('../client/public/rail/rail.bin', import.meta.url).pathname;
const began = performance.now();
const bake: RailBake = decodeRail(await Bun.file(railPath).arrayBuffer());
const net = buildNetwork(bake);
say(
  `--- rail-gauge: ${net.segments.length} segments, ${net.stations.length} platform sites, ` +
    `loaded in ${((performance.now() - began) / 1000).toFixed(1)} s`,
);
say(
  `    the gauge: body half-width ${CAR_BODY_HALF_M} m, margin ${STRUCTURE_MARGIN_M} m, ` +
    `band ${CAR_BODY_FLOOR_M}..${CAR_BODY_ROOF_M} m over the railhead`,
);

// ===================================================================================
// SECTION A -- how much room has a track actually got?
// ===================================================================================
//
// For every open segment, the nearest *parallel* running line on each side, at
// the segment's own midpoint. Parallel is |cos| > 0.94 (about 20 degrees), which
// is the same discrimination `markCorridorEdges` makes and for the same reason:
// a crossing is not a neighbour, it is a crossing.

const NEIGHBOUR_REACH = 40;
const CELL_M = 64;
const cells = new Map<number, number[]>();
const cellKey = (cx: number, cz: number): number => (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
for (let i = 0; i < net.segments.length; i++) {
  const s = net.segments[i];
  if ((s.flags & SPAN_TUNNEL) !== 0) continue;
  const x0 = Math.floor((Math.min(s.ax, s.bx) - NEIGHBOUR_REACH) / CELL_M);
  const x1 = Math.floor((Math.max(s.ax, s.bx) + NEIGHBOUR_REACH) / CELL_M);
  const z0 = Math.floor((Math.min(s.az, s.bz) - NEIGHBOUR_REACH) / CELL_M);
  const z1 = Math.floor((Math.max(s.az, s.bz) + NEIGHBOUR_REACH) / CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = cellKey(cx, cz);
      const l = cells.get(k);
      if (l) l.push(i);
      else cells.set(k, [i]);
    }
  }
}

/** The nearest parallel track on each side of a point, or Infinity. */
function neighbourSpacing(
  x: number, z: number, ux: number, uz: number, skip: number,
): [number, number] {
  const out: [number, number] = [Infinity, Infinity];
  const list = cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
  if (list === undefined) return out;
  for (const j of list) {
    if (j === skip) continue;
    const o = net.segments[j];
    if (Math.abs(ux * o.ux + uz * o.uz) < 0.94) continue;
    const ex = o.bx - o.ax;
    const ez = o.bz - o.az;
    const len2 = ex * ex + ez * ez;
    let u = 0;
    if (len2 > 1e-9) {
      u = ((x - o.ax) * ex + (z - o.az) * ez) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
    }
    const dx = o.ax + ex * u - x;
    const dz = o.az + ez * u - z;
    // Only a neighbour if it is actually beside us rather than in front: a
    // segment's own continuation is parallel and at zero lateral offset.
    const along = Math.abs(dx * ux + dz * uz);
    if (along > 8) continue;
    const lateral = dx * -uz + dz * ux;
    const a = Math.abs(lateral);
    if (a < 0.5 || a > NEIGHBOUR_REACH) continue;
    const side = lateral < 0 ? 0 : 1;
    if (a < out[side]) out[side] = a;
  }
  return out;
}

const spacings: number[] = [];
let unpaired = 0;
for (let i = 0; i < net.segments.length; i++) {
  const s = net.segments[i];
  if ((s.flags & SPAN_TUNNEL) !== 0) continue;
  const mx = (s.ax + s.bx) / 2;
  const mz = (s.az + s.bz) / 2;
  const [l, r] = neighbourSpacing(mx, mz, s.ux, s.uz, i);
  if (!Number.isFinite(l) && !Number.isFinite(r)) { unpaired++; continue; }
  if (Number.isFinite(l)) spacings.push(l);
  if (Number.isFinite(r)) spacings.push(r);
}
spacings.sort((a, b) => a - b);
const q = (p: number): number => (spacings.length === 0 ? NaN : spacings[Math.min(spacings.length - 1, Math.floor(spacings.length * p))]);

// --- The atlas, which is the same question asked properly -----------------------
//
// The scan above is over the *deduplicated* segment set, which is what the
// writers see, and it is kept because it is the writers' own view. The atlas is
// over the direction polylines, where the coincident pairs still exist, and it is
// what `RAIL-CORRIDOR.md` prescribes. Reporting both is the point: their
// disagreement is exactly the doubled geometry nobody has reported.
const atlas = buildTrackAtlas(bake);
const faults = atlasFaults(atlas);

say('');
say('=== A. how much room has a track got? =============================================');
say('');
say(`  segments with no parallel neighbour within ${NEIGHBOUR_REACH} m ... ${unpaired} of ${net.segments.length}`);
say(`  neighbour distances measured (both sides) .............. ${spacings.length}`);
say(
  `  spacing  p5 ${q(0.05).toFixed(2)}   p25 ${q(0.25).toFixed(2)}   ` +
    `median ${q(0.5).toFixed(2)}   p75 ${q(0.75).toFixed(2)}   p95 ${q(0.95).toFixed(2)}  m`,
);
say('');
say(`  --- the track atlas (built in ${atlas.buildMs.toFixed(0)} ms) ---`);
say(`  vertices that own their alignment ...... ${atlas.ownedVertices}`);
say(
  `  vertices that follow another's ......... ${atlas.followerVertices}` +
    `   <-- drawn twice on one alignment today (within ${COINCIDENT_M} m)`,
);
{
  const hist = new Map<number, number>();
  for (let v = 0; v < atlas.corridorTracks.length; v++) {
    if (!ownsAlignment(atlas, v)) continue;
    const c = atlas.corridorTracks[v];
    if (c === 0) continue;
    hist.set(c, (hist.get(c) ?? 0) + 1);
  }
  const widths = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  say(
    `  corridor width (parallel roads within ${CORRIDOR_M} m), by owned vertex:  ` +
      widths.map(([w, c]) => `${w}x${c}`).join('  '),
  );
}
if (faults.length > 0) for (const f of faults) say(`  ATLAS FAULT: ${f}`);
{
  const budgets: number[] = [];
  const edges = { left: 0, right: 0 };
  for (let v = 0; v < atlas.owner.length; v++) {
    if (!ownsAlignment(atlas, v)) continue;
    for (const side of [-1, 1]) {
      if (!Number.isFinite(side < 0 ? atlas.gapLeft[v] : atlas.gapRight[v])) {
        if (side < 0) edges.left++; else edges.right++;
        continue;
      }
      budgets.push(corridorBudget(atlas, v, side));
    }
  }
  budgets.sort((a, b) => a - b);
  const bq = (pp: number): number => (budgets.length === 0 ? NaN : budgets[Math.min(budgets.length - 1, Math.floor(budgets.length * pp))]);
  say(
    `  interior budget (half the gap less ${BUDGET_MARGIN_M} m):  p5 ${bq(0.05).toFixed(2)}   ` +
      `median ${bq(0.5).toFixed(2)}   p95 ${bq(0.95).toFixed(2)}  m`,
  );
  say(`  sides with no neighbour at all (corridor edge): ${edges.left + edges.right}`);
  say('');
  say('  what each writer reaches, against the interior budget it would be clipped to:');
  say(`  ${padR('writer', 26)}${pad('reach(m)', 10)}${pad('budget(m)', 11)}   verdict at the median interior side`);
  const median = bq(0.5);
  const writers: Array<[string, number]> = [
    ['ballast base', BALLAST_BASE_HALF],
    ['cess strip', CESS_INNER],
    ['catenary mast', MAST_OFFSET + MAST_RADIUS],
    ['platform deck (own)', PLATFORM_INNER + PLATFORM_WIDTH],
    ['platform deck (to rim)', 9.4],
    ['canopy', PLATFORM_INNER + PLATFORM_WIDTH + CANOPY_OVERHANG],
    ['boundary fence', FENCE_OFFSET],
    ['the car body it must clear', CAR_BODY_HALF_M + STRUCTURE_MARGIN_M],
  ];
  for (const [name, reach] of writers) {
    const verdict = reach <= median ? 'fits' : `OVER BUDGET by ${(reach - median).toFixed(2)} m`;
    say(`  ${padR(name, 26)}${pad(reach.toFixed(2), 10)}${pad(median.toFixed(2), 11)}   ${verdict}`);
  }
}

if (has('spacing')) process.exit(0);

// ===================================================================================
// SECTION B -- every solid the rail builder emits, in one list
// ===================================================================================
//
// A solid is a box in a frame, which is `rail-solids.FrameSolid` and is the
// definition every other reading of the railway is derived from. The station kit
// comes straight out of `stationSolids`, so the audit is looking at the same
// boxes `CollisionWorld` is handed and `RailSolidField` evaluates -- not at a
// transcription of them.
//
// What `stationSolids` does *not* carry is the decoration: the coping, the
// tactile strip, the canopy and its columns, the platform furniture, the masts
// and the boundary fence are drawn by `rail-geo` and register no prism. Those are
// added here from **the same exported constants the writers use**, which is one
// definition with two readers rather than two definitions. They are marked so the
// report can say whether the offenders are solid or scenery -- a player passes
// through scenery and is stopped by a solid, and the owner is reporting both.

interface Asset {
  kind: string;
  where: string;
  f: TrackFrame;
  t0: number; t1: number;
  o0: number; o1: number;
  /** World y. */
  y0: number; y1: number;
  /** Which running line wrote it, as a frame to compare a train's against. */
  ownUx: number; ownUz: number;
  ownX: number; ownZ: number;
  solid: boolean;
}

const assets: Asset[] = [];
const push = (a: Asset): void => { assets.push(a); };

const KIND_NAME = new Map<number, string>([
  [SOLID_PLATFORM_DECK, 'platform deck'],
  [SOLID_STAIR, 'access stair'],
  [SOLID_LANDING, 'stair landing'],
  [SOLID_FOOTBRIDGE_DECK, 'footbridge deck'],
  [SOLID_FOOTBRIDGE_STAIR, 'footbridge stair'],
  [SOLID_HOUSE, 'station house'],
  [SOLID_BOX_PLATFORM, 'box platform'],
  [SOLID_SHAFT_HEAD, 'shaft head'],
]);

// The plan is measured against the bake's own `groundY` rather than against
// terrain tiles, which this process has none of. Every lateral extent in a plan
// is a constant, and the heights that are not -- the skirt's base, a stair's
// landing -- only ever reach *down*, so a plan measured this way cannot hide an
// intrusion into a band that starts a quarter of a metre over the railhead.
const noGround = (): number => Number.NaN;

for (const st of net.stations) {
  if (ONLY && st.name !== ONLY) continue;
  const plan = planStation(net, st, noGround, true);
  const boxes: FrameSolid[] = [];
  stationSolids(plan, boxes);
  for (const b of boxes) {
    push({
      kind: KIND_NAME.get(b.kind) ?? `solid ${b.kind}`,
      where: st.name,
      f: b.f, t0: b.t0, t1: b.t1, o0: b.o0, o1: b.o1,
      y0: Math.min(b.y0, b.y1), y1: Math.max(b.y0, b.y1),
      ownUx: st.ux, ownUz: st.uz, ownX: st.x, ownZ: st.z,
      solid: true,
    });
  }
  if (st.vertical === 'underground') continue;

  // The decoration, from the writers' own constants. See the note above.
  const top = st.trackY + PLATFORM_HEIGHT;
  const L = PLATFORM_HALF_LENGTH;
  const inner = PLATFORM_INNER;
  const outer = PLATFORM_INNER + PLATFORM_WIDTH;
  const deco = (kind: string, t0: number, t1: number, o0: number, o1: number, y0: number, y1: number): void =>
    push({
      kind, where: st.name, f: st, t0, t1, o0, o1, y0, y1,
      ownUx: st.ux, ownUz: st.uz, ownX: st.x, ownZ: st.z, solid: false,
    });
  for (const side of [-1, 1]) {
    deco('platform coping', -L, L, inner * side, (inner + 0.14) * side, top, top + 0.025);
    deco(
      'tactile strip', -L, L,
      (inner + TACTILE_INSET) * side, (inner + TACTILE_INSET + TACTILE_WIDTH) * side,
      top, top + 0.006,
    );
    const C = CANOPY_HALF_LENGTH;
    const rise = top + CANOPY_HEIGHT;
    deco('canopy', -C, C, (inner - CANOPY_OVERHANG) * side, (outer + CANOPY_OVERHANG) * side, rise - 0.28, rise);
    for (const t of [-C + 3, -C / 3, C / 3, C - 3]) {
      const o = ((inner + outer) / 2) * side;
      deco('canopy column', t - 0.11, t + 0.11, o - 0.11, o + 0.11, top, rise - 0.28);
    }
    for (const t of [-62, -21, 21, 62]) deco('platform seat', t - 0.9, t + 0.9, (outer - 1.76) * side, (outer - 1.16) * side, top, top + 0.92);
    for (const t of [-38, 38]) deco('platform bin', t - 0.3, t + 0.3, (outer - 1.4) * side, (outer - 0.8) * side, top, top + 1.0);
    for (const t of [-72, -46, 46, 72]) deco('platform lamp', t - 0.28, t + 0.28, (outer - 0.98) * side, (outer - 0.42) * side, top, top + 4.22);
    deco('waiting shelter', -CANOPY_HALF_LENGTH - 15.4, -CANOPY_HALF_LENGTH - 4.6, (inner + 0.8) * side, (outer + 0.2) * side, top, top + 2.6);
  }
}

// The corridor kit, per segment. Ballast and cess are what the railway stands
// on and are *supposed* to be under the train, so they are recorded with a
// height band that stops at the railhead and can only foul something by being a
// neighbour's.
if (!ONLY) {
  for (let i = 0; i < net.segments.length; i++) {
    const s = net.segments[i];
    if ((s.flags & SPAN_TUNNEL) !== 0) continue;
    const f: TrackFrame = { x: (s.ax + s.bx) / 2, z: (s.az + s.bz) / 2, ux: s.ux, uz: s.uz };
    const y = (s.ay + s.by) / 2;
    const half = s.len / 2;
    const seg = (kind: string, o0: number, o1: number, y0: number, y1: number): void =>
      push({
        kind, where: `segment ${i}`, f, t0: -half, t1: half, o0, o1, y0, y1,
        ownUx: s.ux, ownUz: s.uz, ownX: f.x, ownZ: f.z, solid: false,
      });
    for (const side of [-1, 1]) {
      seg('ballast shoulder', BALLAST_BASE_HALF * side * 0.66, BALLAST_BASE_HALF * side, y - 0.75, y - BALLAST_TOP_DROP);
      if (s.open[side < 0 ? 0 : 1]) {
        seg('boundary fence', (FENCE_OFFSET - 0.05) * side, (FENCE_OFFSET + 0.05) * side, y, y + 1.8);
      }
    }
  }

  // The catenary masts, from the bake's own stanchion list rather than from a
  // pitch. **A mast is a post and not a bar**, and modelling it as a bar down the
  // whole segment was this file's own first answer: it reported 868 km of fouled
  // line, which is a measurement of the mistake and not of the railway. The bake
  // decides where every mast stands and `rail-geo` draws them there, so that list
  // is the only honest source. `dx, dz` is the mast's own outward normal.
  const stan = bake.stanchions;
  for (let i = 0; i < bake.stanchionKinds.length; i++) {
    const x = stan[i * 5];
    const y = stan[i * 5 + 1];
    const z = stan[i * 5 + 2];
    const f: TrackFrame = { x, z, ux: stan[i * 5 + 3], uz: stan[i * 5 + 4] };
    const kind = bake.stanchionKinds[i];
    // `refillMasts`' own arithmetic: kind 1 stands to the `-1` side, kind 0 to
    // the `+1`, and a portal gantry straddles on two legs at its half span.
    const offsets = kind === 2
      ? [-GANTRY_HALF_SPAN, GANTRY_HALF_SPAN]
      : [MAST_OFFSET * (kind === 1 ? -1 : 1)];
    for (const o of offsets) {
      push({
        kind: kind === 2 ? 'gantry leg' : 'catenary mast',
        where: `mast ${i}`, f,
        t0: -MAST_RADIUS, t1: MAST_RADIUS,
        o0: o - MAST_RADIUS, o1: o + MAST_RADIUS,
        y0: y - 0.25, y1: y - 0.25 + MAST_HEIGHT,
        ownUx: f.ux, ownUz: f.uz, ownX: x, ownZ: z, solid: false,
      });
    }
  }
}

say('');
say(`=== B. ${assets.length} rail solids enumerated ===================================`);

// A broad phase over the assets, by their plan bounding box.
const acells = new Map<number, number[]>();
for (let i = 0; i < assets.length; i++) {
  const a = assets[i];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [t, o] of [[a.t0, a.o0], [a.t1, a.o0], [a.t1, a.o1], [a.t0, a.o1]] as const) {
    const p = framePoint(a.f, t, o, 0);
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
  }
  for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
    for (let cz = Math.floor(z0 / CELL_M); cz <= Math.floor(z1 / CELL_M); cz++) {
      const k = cellKey(cx, cz);
      const l = acells.get(k);
      if (l) l.push(i);
      else acells.set(k, [i]);
    }
  }
}

/** How far a point is from an asset's plan rectangle, in metres. */
function planDistance(a: Asset, x: number, z: number): number {
  const dx = x - a.f.x;
  const dz = z - a.f.z;
  const t = dx * a.f.ux + dz * a.f.uz;
  const o = dx * -a.f.uz + dz * a.f.ux;
  const lt = Math.min(a.t0, a.t1);
  const ht = Math.max(a.t0, a.t1);
  const lo = Math.min(a.o0, a.o1);
  const ho = Math.max(a.o0, a.o1);
  const et = t < lt ? lt - t : t > ht ? t - ht : 0;
  const eo = o < lo ? lo - o : o > ho ? o - ho : 0;
  return Math.sqrt(et * et + eo * eo);
}

// ===================================================================================
// SECTION C -- sweep the car body and see what it hits
// ===================================================================================

const STEP_M = 2;

interface Hit {
  kind: string;
  where: string;
  depth: number;
  cause: 'own' | 'neighbour' | 'crossing';
  x: number; z: number;
  metres: number;
  solid: boolean;
}
const hits: Hit[] = [];
/** Per (kind, where, cause), the worst depth and the metres of line affected. */
const rollup = new Map<string, Hit>();

let sweptM = 0;
/** Running line with **anything** in the gauge, counted once however many hit it. */
let fouledM = 0;
/** ...and of that, metres where the thing in the gauge is a station's platform. */
let platformFouledM = 0;
const platformStations = new Set<string>();
const p = bake.vertices;
for (const line of bake.lines) {
  for (const dir of line.dirs) {
    const first = dir.vertexOff;
    const last = dir.vertexOff + dir.vertexCount - 1;
    for (let v = first; v < last; v++) {
      const flags = bake.vertexFlags[v] | bake.vertexFlags[v + 1];
      if ((flags & SPAN_TUNNEL) !== 0) continue;
      // **Physical track, not service path.** Two services on one alignment are
      // one railway, and sweeping both would report the same foul twice and
      // inflate every metre in the table by the amount OSM happened to
      // double-map. `RAIL-CORRIDOR.md`'s first idea, spent immediately.
      if (!ownsAlignment(atlas, v)) continue;
      const ax = p[v * 3], ay = p[v * 3 + 1], az = p[v * 3 + 2];
      const bx = p[(v + 1) * 3], by = p[(v + 1) * 3 + 1], bz = p[(v + 1) * 3 + 2];
      const ex = bx - ax, ez = bz - az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (len < 0.05 || len > 2000) continue;
      const ux = ex / len, uz = ez / len;
      const steps = Math.max(1, Math.round(len / STEP_M));
      for (let k = 0; k < steps; k++) {
        const u = (k + 0.5) / steps;
        const x = ax + ex * u;
        const z = az + ez * u;
        const railY = ay + (by - ay) * u;
        const runM = len / steps;
        sweptM += runM;
        const list = acells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
        if (list === undefined) continue;
        let anyHere = false;
        let platformHere = false;
        for (const ai of list) {
          const a = assets[ai];
          // The height band first: it is one comparison and it throws away the
          // canopy, the footbridge and the mast without any plan arithmetic.
          if (a.y1 <= railY + CAR_BODY_FLOOR_M || a.y0 >= railY + CAR_BODY_ROOF_M) continue;
          const d = planDistance(a, x, z);
          const limit = CAR_BODY_HALF_M + STRUCTURE_MARGIN_M;
          if (d >= limit) continue;
          // Whose asset is it? The writer's own frame against the train's.
          const par = Math.abs(a.ownUx * ux + a.ownUz * uz);
          let cause: Hit['cause'];
          if (par < 0.94) cause = 'crossing';
          else {
            // Its own track, or the one beside it: the lateral offset of the
            // writer's centreline from this train's, at this point.
            const dx = a.ownX - x;
            const dz = a.ownZ - z;
            const lat = Math.abs(dx * -uz + dz * ux);
            cause = lat < 2.0 ? 'own' : 'neighbour';
          }
          const depth = limit - d;
          anyHere = true;
          if (a.kind.startsWith('platform ') || a.kind === 'tactile strip' || a.kind === 'canopy') {
            platformHere = true;
            platformStations.add(a.where);
          }
          const key = `${a.kind}|${a.where}|${cause}`;
          const prev = rollup.get(key);
          if (prev === undefined) {
            rollup.set(key, {
              kind: a.kind, where: a.where, depth, cause, x, z, metres: runM, solid: a.solid,
            });
          } else {
            prev.metres += runM;
            if (depth > prev.depth) { prev.depth = depth; prev.x = x; prev.z = z; }
          }
        }
        if (anyHere) fouledM += runM;
        if (platformHere) platformFouledM += runM;
      }
    }
  }
}
for (const h of rollup.values()) hits.push(h);

// --- The report --------------------------------------------------------------------

const byKind = new Map<string, { depth: number; metres: number; sites: number; worst: Hit }>();
const byCause = new Map<string, number>();
for (const h of hits) {
  const g = byKind.get(h.kind);
  if (g === undefined) byKind.set(h.kind, { depth: h.depth, metres: h.metres, sites: 1, worst: h });
  else {
    g.metres += h.metres;
    g.sites++;
    if (h.depth > g.depth) { g.depth = h.depth; g.worst = h; }
  }
  byCause.set(h.cause, (byCause.get(h.cause) ?? 0) + h.metres);
}

say('');
say('=== C. what the car body passes through ===========================================');
say('');
say(`  open track swept ......... ${(sweptM / 1000).toFixed(1)} km at ${STEP_M} m (physical track, followers dropped)`);
say(
  `  FOULED ................... ${(fouledM / 1000).toFixed(1)} km = ` +
    `${((fouledM / sweptM) * 100).toFixed(1)}% of it has rail geometry inside the car body`,
);
say(
  `    of which the platform .. ${(platformFouledM / 1000).toFixed(1)} km` +
    `   across ${platformStations.size} of ${net.stations.length} platform sites`,
);
say(`  distinct fouled assets ... ${hits.length}`);
say('');
say('  by mechanism, in **asset**-metres (one length of line counted once per asset on it):');
for (const c of ['own', 'neighbour', 'crossing'] as const) {
  say(`    ${padR(c, 12)}${pad(((byCause.get(c) ?? 0)).toFixed(0), 10)} m`);
}
say('');
say(`  ${padR('asset kind', 22)}${pad('sites', 7)}${pad('metres', 10)}${pad('worst(m)', 10)}   worst instance`);
const kindRows = [...byKind.entries()].sort((a, b) => b[1].metres - a[1].metres);
for (const [kind, g] of kindRows) {
  say(
    `  ${padR(kind, 22)}${pad(String(g.sites), 7)}${pad(g.metres.toFixed(0), 10)}` +
      `${pad(g.depth.toFixed(2), 10)}   ${g.worst.where} (${g.worst.cause})`,
  );
}

say('');
say(`  the ${TOP} worst individual intrusions:`);
say(`  ${padR('asset', 22)}${padR('where', 24)}${pad('depth(m)', 10)}${pad('metres', 9)}  cause     kind`);
for (const h of hits.sort((a, b) => b.depth - a.depth).slice(0, TOP)) {
  say(
    `  ${padR(h.kind, 22)}${padR(h.where, 24)}${pad(h.depth.toFixed(2), 10)}${pad(h.metres.toFixed(0), 9)}` +
      `  ${padR(h.cause, 10)}${h.solid ? 'solid' : 'scenery'}`,
  );
}

// --- The curve, measured on its own --------------------------------------------------
//
// Section C says whether the platform is fouled and by whom. This says *how much
// of it is the box*: the bow of each platform's own running line away from the
// tangent the box was built on. It is the number `platform-spine.SPINE_FLAT_M`
// was read off, and it is here rather than in a scratch script because the
// threshold has to stay answerable to the distribution it came from.

interface Bow { name: string; bow: number; turn: number; radius: number }
const bows: Bow[] = [];
for (const st of net.stations as PlacedStation[]) {
  if (ONLY && st.name !== ONLY) continue;
  const sp = st.spine === null
    ? straightSpine(st, PLATFORM_HALF_LENGTH)
    : spineAround(bake, st.spine, PLATFORM_HALF_LENGTH);
  // The circle through the chord: `bow = L^2 / 2R`, inverted.
  const radius = sp.bow > 1e-6 ? (PLATFORM_HALF_LENGTH * PLATFORM_HALF_LENGTH) / (2 * sp.bow) : Infinity;
  bows.push({ name: st.name, bow: sp.bow, turn: (sp.turn * 180) / Math.PI, radius });
}
bows.sort((a, b) => b.bow - a.bow);
const bowVals = bows.map((b) => b.bow).sort((a, b) => a - b);
const bq = (pp: number): number => bowVals[Math.min(bowVals.length - 1, Math.floor(bowVals.length * pp))];

say('');
say('=== D. how far each platform\'s own track leaves the box it was drawn in ===========');
say('');
say(
  `  bow over +/-${PLATFORM_HALF_LENGTH} m:  p25 ${bq(0.25).toFixed(3)}   median ${bq(0.5).toFixed(3)}   ` +
    `p75 ${bq(0.75).toFixed(3)}   p90 ${bq(0.9).toFixed(3)}   worst ${bq(1).toFixed(2)}  m`,
);
say(`  the platform's whole margin is ${(PLATFORM_INNER - CAR_BODY_HALF_M).toFixed(3)} m.`);
const overBudget = bows.filter((b) => b.bow > PLATFORM_INNER - CAR_BODY_HALF_M).length;
say(`  sites whose bow alone exceeds it: ${overBudget} of ${bows.length}`);
say('');
say(`  ${padR('station', 26)}${pad('bow(m)', 9)}${pad('radius(m)', 11)}${pad('max turn', 10)}`);
for (const b of bows.slice(0, TOP)) {
  say(
    `  ${padR(b.name, 26)}${pad(b.bow.toFixed(2), 9)}` +
      `${pad(Number.isFinite(b.radius) ? b.radius.toFixed(0) : 'straight', 11)}${pad(b.turn.toFixed(1) + '°', 10)}`,
  );
}
say('');

// --- The gate ---------------------------------------------------------------------

const platformM = platformFouledM;
const failures: string[] = [];
if (fouledM > FOULED_BUDGET_M) {
  failures.push(
    `${fouledM.toFixed(0)} m of running line has rail geometry inside the car body, against a budget ` +
      `of ${FOULED_BUDGET_M} m. Read section C for which writer and which mechanism.`,
  );
}
if (platformM > FOULED_PLATFORM_BUDGET_M) {
  failures.push(
    `${platformM.toFixed(0)} m of it is the platform, against a budget of ${FOULED_PLATFORM_BUDGET_M} m. ` +
      `That is the one the player sees from the window.`,
  );
}
if (failures.length > 0) {
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  process.exit(1);
}
say(`  PASS -- ${fouledM.toFixed(0)} / ${FOULED_BUDGET_M} m fouled, platform ${platformM.toFixed(0)} / ${FOULED_PLATFORM_BUDGET_M} m`);
process.exit(0);
