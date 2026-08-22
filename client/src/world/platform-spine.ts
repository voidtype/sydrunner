/**
 * The running line a platform is built against, as a curve.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT THIS FILE EXISTS FOR.
 *
 *   > *"the platforms are so badly aligned at curved places like woolstronecraft
 *   > ... the platforms should really generated relative to the track, because
 *   > atm im passing thru platform all the time"*
 *
 * A platform was a **box**: `PLATFORM_HALF_LENGTH` 80 m either way along one
 * heading, taken from the stopping anchor, at a constant offset across it. A box
 * has one direction and a railway does not. Over 80 m a curve of radius R walks
 * away from its own tangent by `80^2 / 2R` -- 3.2 m at R = 1000, 8 m at R = 400 --
 * and the platform face is 1.62 m off the centreline with a car body 1.55 m wide
 * beside it. **Seven centimetres of margin against metres of bow.** The box does
 * not graze the train at a curved station; the train drives through the middle of
 * it, and the two ends of the slab swing out over the six-foot.
 *
 * No constant fixes that, because the error is not in a number. The platform was
 * placed in a frame the railway leaves. So the frame goes: everything a station
 * builds along the track is swept along **this**, the polyline the trains
 * actually run on, at a constant offset from it -- which is how `ballast`, the
 * cess, the rails and the sleepers have always been built, one segment at a time.
 * A platform that follows the track by construction cannot be passed through,
 * because the distance from the rail to the coping is a constant of the sweep
 * rather than an outcome of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NODES ARE THE POLYLINE'S OWN VERTICES AND NOT A RESAMPLING.
 *
 * A resampled spine is a second approximation of a curve the bake has already
 * approximated, and the two would differ by the sagitta of whatever pitch was
 * chosen -- centimetres, in the one place where centimetres are the entire
 * budget. Taking the bake's own vertices means each swept panel is **exactly
 * parallel** to the track segment beside it, so the coping-to-rail distance is
 * `PLATFORM_INNER` at every point of every panel and not merely at the samples.
 * The clash test in `server/platform-gauge-check.ts` is then measuring a
 * property the construction guarantees rather than hoping for.
 *
 * The two ends are cut at exactly `+/- reach`, so a platform is still its stated
 * length, measured along the rail instead of along a chord.
 *
 * ---------------------------------------------------------------------------
 * WHY A FLAT SPINE COLLAPSES TO ONE PANEL, AND WHY THAT IS NOT A TOLERANCE.
 *
 * `SPINE_FLAT_M` is the one threshold here and it is a **drawing** decision, not
 * an agreement between two descriptions -- the thing `STATIONS.md` refuses. Both
 * answers are the same platform: one panel, or N collinear panels whose union is
 * that panel. Collapsing is worth doing for two reasons and neither is accuracy.
 * It keeps the 145 stations on straight track byte-for-byte what they are today,
 * which is what makes the identity test in `perf-harness.ts` able to say *nothing
 * moved at St Leonards*; and it keeps their triangle and prism counts where the
 * frame budget was measured. A station just over the line draws a few more quads
 * than a station just under it, and both are right.
 *
 * ---------------------------------------------------------------------------
 * **Three-free, and it imports only the bake's shape.** `server/world.ts` builds
 * the same spines to answer where a platform surface is, on `riding.ts`'s own
 * terms: the platform is arithmetic both ends run, and a curve the client swept
 * and the server did not is the oldest bug in this repo wearing a new coat.
 */

import type { RailBake, RailDirection } from '../game/rail.ts';
import { runBudget, type TrackAtlas } from './track-atlas.ts';

/**
 * The narrowest strip of platform worth building, metres of deck.
 *
 * ---------------------------------------------------------------------------
 * A metre and a quarter, and the number is a body. `player/controller`'s capsule
 * is 0.4 m across and `RAIL-CORRIDOR.md` is explicit that *"where no slot fits,
 * no platform is built"* -- so the question is not what looks like a platform,
 * it is what a passenger can stand on without being inside the train beside
 * them. Two capsule widths and a margin is that, and it lands where the measured
 * budgets are bimodal: an interior side of a 4 m pair gets 1.78 m of budget
 * against a 1.62 m inner face, which is 0.16 m of deck and is refused, while a
 * corridor edge gets the full 9.4 m. Almost nothing sits between the two.
 *
 * Exported from here rather than from either caller because `rail-solids` and
 * `riding` both decide it and the whole point of the pair is that they decide it
 * the same.
 */
export const MIN_PLATFORM_DECK = 1.25;

/**
 * How far out a platform may reach on each side of a running line: `[-1, +1]`.
 *
 * Zero on a side where what the budget leaves is under `MIN_PLATFORM_DECK`,
 * which is a refusal: a station with one platform is honest and a platform
 * inside a train is not.
 *
 * **The worst budget over the platform's own length**, not the budget at its
 * anchor -- see `track-atlas.runBudget`. A platform is one object and is either
 * clear along all of it or clear along none of it.
 *
 * `inner` and `outer` are the caller's own platform dimensions rather than
 * imports, because the two callers are on opposite sides of an import cycle:
 * `rail-solids` reads `riding`'s `PLATFORM_OUTER_M` and `riding` cannot
 * therefore read back. `verifyRailGeometry` asserts the two callers pass the
 * same numbers, which is the check that keeps that survivable.
 */
export function platformSlots(
  bake: RailBake,
  atlas: TrackAtlas,
  ref: SpineRef | null,
  reach: number,
  inner: number,
  outer: number,
): [number, number] {
  // No polyline to measure against: the anchor is one the network never reaches
  // and there is nothing beside it either. It keeps what it has always had.
  if (ref === null) return [outer, outer];
  const dir = bake.lines[ref.line].dirs[ref.dir];
  const first = dir.vertexOff;
  const last = dir.vertexOff + dir.vertexCount - 1;
  const c = bake.cum;
  let v0 = last;
  let v1 = first;
  for (let v = first; v <= last; v++) {
    if (c[v] < ref.s - reach || c[v] > ref.s + reach) continue;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  if (v0 > v1) {
    // Shorter than one polyline edge. The nearest vertex speaks for it: a
    // stretch with no vertex in it is straight, and its neighbour distance does
    // not change along a straight.
    let best = first;
    let bd = Infinity;
    for (let v = first; v <= last; v++) {
      const d = Math.abs(c[v] - ref.s);
      if (d < bd) { bd = d; best = v; }
    }
    v0 = best;
    v1 = best;
  }
  const out: [number, number] = [0, 0];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const room = Math.min(outer, runBudget(atlas, v0, v1, side));
    out[i] = room - inner >= MIN_PLATFORM_DECK ? room : 0;
  }
  return out;
}

/**
 * How far a platform's own running line may depart from its chord before the
 * platform is swept rather than drawn as one box, metres.
 *
 * **Five centimetres, and the number comes off the thing it protects.** The gap
 * between the platform face and the car body is `PLATFORM_INNER` 1.62 m less
 * `trains.CAR_SOLID_HALF_WIDTH` 1.55 m = **70 mm**, so a bow this file declines
 * to follow is spent directly out of that. Five centimetres leaves 20 mm and is
 * under the coping's own 25 mm lip, which is the smallest feature drawn on a
 * platform: a departure smaller than the edge detail is not a departure anybody
 * can see.
 *
 * Measured over the 361 platform sites in the shipped bake, the bow is bimodal
 * and this sits in the empty middle of it -- see the table
 * `server/platform-gauge-check.ts` prints, which is where the number was read
 * from rather than chosen.
 */
export const SPINE_FLAT_M = 0.05;

/** Where a spine came from: a direction's polyline and an arc length on it. */
export interface SpineRef {
  /** Index into `bake.lines`. */
  line: number;
  /** Index into `bake.lines[line].dirs`. */
  dir: number;
  /** The arc length, in `bake.cum`'s own space, the platform is centred on. */
  s: number;
}

/** One node of a swept platform: a point on the running line. */
export interface SpineNode {
  /** Arc length from the anchor, metres. Negative behind it. */
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * A platform's running line over the platform's own length.
 *
 * `nodes` has at least two entries, `t` ascending, with the first at exactly
 * `-reach` and the last at exactly `+reach`. The panel between nodes `i` and
 * `i+1` is a straight length of railway and is what everything a station sweeps
 * is built one of.
 */
export interface PlatformSpine {
  nodes: SpineNode[];
  /** The unit plan direction of the panel containing the anchor. */
  ux: number;
  uz: number;
  /**
   * The worst lateral departure of any node from the anchor's own tangent line,
   * metres. This is the number the box was wrong by. Zero on straight track.
   */
  bow: number;
  /** The worst turn between two consecutive panels, radians. Sizes the mitre. */
  turn: number;
  /** `bow <= SPINE_FLAT_M`: draw one panel and be byte-identical to the box. */
  flat: boolean;
}

/**
 * The spine of the platform centred at `ref`, reaching `reach` metres each way
 * along the rail.
 *
 * Clipped to the direction's own polyline: a platform whose anchor is within
 * `reach` of the end of a line gets a short spine rather than an extrapolated
 * one, because the bake stops knowing where the railway goes there and a guess
 * would put a slab across the buffer stops.
 */
export function spineAround(bake: RailBake, ref: SpineRef, reach: number): PlatformSpine {
  const dir = bake.lines[ref.line].dirs[ref.dir];
  return spineOn(bake, dir, ref.s, reach);
}

export function spineOn(
  bake: RailBake, dir: RailDirection, s0: number, reach: number,
): PlatformSpine {
  const p = bake.vertices;
  const c = bake.cum;
  const first = dir.vertexOff;
  const last = dir.vertexOff + dir.vertexCount - 1;
  const lo = Math.max(c[first], s0 - reach);
  const hi = Math.min(c[last], s0 + reach);

  const nodes: SpineNode[] = [];
  const push = (s: number): void => {
    const at = evalAt(bake, dir, s);
    nodes.push({ t: s - s0, x: at.x, y: at.y, z: at.z });
  };
  push(lo);
  for (let v = first; v <= last; v++) {
    // Strictly inside, so a vertex sitting exactly on an end is not duplicated
    // into a zero-length panel -- which would be a degenerate frame with no
    // direction, and every consumer would have to know about it.
    if (c[v] <= lo || c[v] >= hi) continue;
    nodes.push({ t: c[v] - s0, x: p[v * 3], y: p[v * 3 + 1], z: p[v * 3 + 2] });
  }
  push(hi);

  return finish(nodes);
}

/** The position on a direction's polyline at arc length `s`. `anchorAt`'s half. */
function evalAt(
  bake: RailBake, dir: RailDirection, s: number,
): { x: number; y: number; z: number } {
  const p = bake.vertices;
  const c = bake.cum;
  let a = dir.vertexOff;
  let b = dir.vertexOff + dir.vertexCount - 1;
  while (a < b) {
    const mid = (a + b + 1) >> 1;
    if (c[mid] <= s) a = mid;
    else b = mid - 1;
  }
  if (a >= dir.vertexOff + dir.vertexCount - 1) a = dir.vertexOff + dir.vertexCount - 2;
  const span = c[a + 1] - c[a];
  const u = span > 0 ? (s - c[a]) / span : 0;
  return {
    x: p[a * 3] + (p[(a + 1) * 3] - p[a * 3]) * u,
    y: p[a * 3 + 1] + (p[(a + 1) * 3 + 1] - p[a * 3 + 1]) * u,
    z: p[a * 3 + 2] + (p[(a + 1) * 3 + 2] - p[a * 3 + 2]) * u,
  };
}

/**
 * Measure a node list: the anchor's tangent, the bow away from it and the worst
 * turn. Shared by `spineOn` and by `straightSpine`, so a synthetic spine and a
 * baked one are described by the identical arithmetic.
 */
function finish(nodes: SpineNode[]): PlatformSpine {
  // Degenerate spines happen at the ends of lines and at anchors the router put
  // on a stub. One node is not a railway; give it a panel of its own length so
  // every consumer below can assume two.
  if (nodes.length < 2) {
    const n = nodes[0] ?? { t: 0, x: 0, y: 0, z: 0 };
    nodes = [{ ...n, t: n.t - 0.5 }, { ...n, t: n.t + 0.5 }];
  }

  // The anchor's panel: the one spanning t = 0, or the nearest end's.
  let ai = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    if (nodes[i].t <= 0 && nodes[i + 1].t >= 0) { ai = i; break; }
    if (nodes[i + 1].t < 0) ai = i;
  }
  const dir0 = panelDir(nodes, ai);
  const ax = nodes[ai].x + (nodes[ai + 1].x - nodes[ai].x) * anchorU(nodes, ai);
  const az = nodes[ai].z + (nodes[ai + 1].z - nodes[ai].z) * anchorU(nodes, ai);

  let bow = 0;
  for (const n of nodes) {
    const lat = Math.abs((n.x - ax) * -dir0.uz + (n.z - az) * dir0.ux);
    if (lat > bow) bow = lat;
  }

  let turn = 0;
  for (let i = 0; i + 2 < nodes.length; i++) {
    const a = panelDir(nodes, i);
    const b = panelDir(nodes, i + 1);
    // The angle between two unit plan directions, from their cross and dot. No
    // `Math.acos` of a dot alone: at the 1-2 degrees a railway actually turns,
    // `acos` is evaluating its own worst-conditioned region.
    const cross = a.ux * b.uz - a.uz * b.ux;
    const dot = a.ux * b.ux + a.uz * b.uz;
    const t = Math.abs(Math.atan2(cross, dot));
    if (t > turn) turn = t;
  }

  return { nodes, ux: dir0.ux, uz: dir0.uz, bow, turn, flat: bow <= SPINE_FLAT_M };
}

function anchorU(nodes: SpineNode[], i: number): number {
  const span = nodes[i + 1].t - nodes[i].t;
  return span > 0 ? Math.max(0, Math.min(1, (0 - nodes[i].t) / span)) : 0;
}

/** The unit plan direction of panel `i`. */
export function panelDir(nodes: readonly SpineNode[], i: number): { ux: number; uz: number } {
  const dx = nodes[i + 1].x - nodes[i].x;
  const dz = nodes[i + 1].z - nodes[i].z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9) return { ux: 1, uz: 0 };
  return { ux: dx / len, uz: dz / len };
}

/**
 * The spine a station with no polyline gets: the straight one it has always had.
 *
 * Used for the anchors nothing calls at whose nearest rail could not be resolved
 * to a direction, and by the checks as the negative control -- a straight spine
 * must reproduce the box exactly, or the sweep is not a generalisation of it.
 */
export function straightSpine(
  f: { x: number; z: number; ux: number; uz: number; trackY: number },
  reach: number,
): PlatformSpine {
  return finish([
    { t: -reach, x: f.x - f.ux * reach, y: f.trackY, z: f.z - f.uz * reach },
    { t: reach, x: f.x + f.ux * reach, y: f.trackY, z: f.z + f.uz * reach },
  ]);
}

/**
 * Project a world point into a spine's own frame: distance along the rail and
 * offset across it.
 *
 * **This is the inverse of the sweep and it has to be, or the platform a body
 * stands on is not the platform it can see.** `riding.PlatformField` answers the
 * ground query from it on both ends of the wire, and `rail-geo` draws the panels
 * this walks. The nearest panel wins, with `along` accumulated over the panels
 * before it, so the answer is arc length on the real curve rather than a
 * projection onto a chord.
 *
 * Ties -- a point equidistant from two panels, which is every point on the
 * outside of a bend -- are broken by taking the smaller `|across|`, so a point in
 * the wedge between two panels belongs to the panel it is nearer *across* rather
 * than to whichever was visited first. That is the mitre, evaluated instead of
 * built.
 */
export function projectSpine(
  spine: PlatformSpine, x: number, z: number,
): { along: number; across: number; y: number } {
  const n = spine.nodes;
  let best = Infinity;
  let out = { along: 0, across: 0, y: n[0].y };
  for (let i = 0; i + 1 < n.length; i++) {
    const ex = n[i + 1].x - n[i].x;
    const ez = n[i + 1].z - n[i].z;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-12) continue;
    let u = ((x - n[i].x) * ex + (z - n[i].z) * ez) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = n[i].x + ex * u;
    const pz = n[i].z + ez * u;
    const dx = x - px;
    const dz = z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= best) continue;
    best = d2;
    const len = Math.sqrt(len2);
    out = {
      along: n[i].t + (n[i + 1].t - n[i].t) * u,
      across: (dx * -(ez / len) + dz * (ex / len)),
      y: n[i].y + (n[i + 1].y - n[i].y) * u,
    };
  }
  return out;
}
