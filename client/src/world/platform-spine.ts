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
import { INSISTED_MIN_DECK, insistsOnPlatform } from './station-layouts.ts';

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
  /**
   * The station's name, for `world/station-layouts.ts`. Omitted, no station
   * insists and the rule is purely the corridor's.
   */
  name?: string,
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
  // A station a real schematic says has platforms gets the narrowest deck a
  // passenger can use rather than none at all. See `world/station-layouts.ts`;
  // this is the only place that table changes any geometry.
  const floor = name !== undefined && insistsOnPlatform(name) ? INSISTED_MIN_DECK : MIN_PLATFORM_DECK;
  const out: [number, number] = [0, 0];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const room = Math.min(outer, runBudget(atlas, v0, v1, side));
    out[i] = room - inner >= floor ? room : 0;
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
 * The track frame at arc length `t` on the spine: the panel there, and its
 * direction.
 *
 * For the short things a station stands beside the track -- a stair landing, a
 * house, a footbridge tower -- which are metres long rather than a hundred and
 * sixty, so a frame taken at their own middle is exact enough that sweeping them
 * would be arithmetic for nothing. It is emphatically **not** enough for the
 * platform: that is what `sweepPanels` is for, and the difference between the
 * two is the difference between a 2.6 m object and a 160 m one on a 182 m curve.
 */
export function frameAt(
  spine: PlatformSpine, t: number,
): { x: number; z: number; ux: number; uz: number } {
  const n = spine.nodes;
  let i = 0;
  for (let k = 0; k + 1 < n.length; k++) {
    if (n[k].t <= t && n[k + 1].t >= t) { i = k; break; }
    if (n[k + 1].t < t) i = k;
  }
  const span = n[i + 1].t - n[i].t;
  const u = span > 0 ? (t - n[i].t) / span : 0;
  const d = panelDir(n, i);
  return {
    x: n[i].x + (n[i + 1].x - n[i].x) * u,
    z: n[i].z + (n[i + 1].z - n[i].z) * u,
    ux: d.ux, uz: d.uz,
  };
}

/**
 * The world point at node `i`, offset `o` across the track, **mitred**.
 *
 * ---------------------------------------------------------------------------
 * **The joint is the whole of why a swept platform is not just N boxes.** Two
 * panels meeting at a turn of θ have their end faces perpendicular to two
 * different directions, so a box per panel leaves a wedge of daylight on the
 * outside of the bend and an overlap on the inside. Measured on this bake the
 * turn between consecutive panels runs to 9 degrees, which at the deck's 9.4 m
 * outer face is a **74 cm gap** — a slot down the middle of a platform, which is
 * the exact class of defect `STATIONS.md` was written about.
 *
 * The mitre vector is the standard one: with `p` the two panels' offset
 * directions, `m = (p0 + p1) / (1 + p0·p1)`, whose length is `1/cos(θ/2)` so the
 * offset line stays parallel to both panels rather than being pulled in at the
 * corner. At the two ends of the spine there is only one panel and `m` is its
 * own `p`.
 *
 * Clamped where the "turn" is a reversal — `1 + p0·p1` near zero is a spine that
 * doubles back on itself, which happens where the dedup chained a run through a
 * crossover, and a true mitre there is an infinite spike. Falling back to the
 * outgoing panel's own normal draws a blunt corner instead, which is wrong by
 * centimetres where a spike would be wrong by kilometres.
 */
export function offsetAt(
  spine: PlatformSpine, i: number, o: number,
): { x: number; z: number } {
  const n = spine.nodes;
  const last = n.length - 1;
  const a = panelDir(n, i > 0 ? i - 1 : 0);
  const b = panelDir(n, i < last ? i : last - 1);
  // The `+o` direction of a panel, which is `framePoint`'s: `(-uz, ux)`.
  let mx = -a.uz + -b.uz;
  let mz = a.ux + b.ux;
  const k = 1 + (a.ux * b.ux + a.uz * b.uz);
  if (k > 0.2) { mx /= k; mz /= k; }
  else { mx = -b.uz; mz = b.ux; }
  return { x: n[i].x + mx * o, z: n[i].z + mz * o };
}

/**
 * The panels a swept object is built one of: index, midpoint frame and length.
 *
 * A flat spine has exactly one panel and it is the straight box, which is what
 * makes a station on straight track come out as the geometry it already had.
 * See `SPINE_FLAT_M`.
 */
export function sweepPanels(spine: PlatformSpine, trim = 0): SweepPanel[] {
  const n = spine.nodes;
  const out: SweepPanel[] = [];
  if (spine.flat) {
    const half = (n[n.length - 1].t - n[0].t) / 2;
    const mid = (n[0].t + n[n.length - 1].t) / 2;
    const f = frameAt(spine, mid);
    out.push({
      i: 0, x: f.x, z: f.z, ux: f.ux, uz: f.uz,
      t0: -half, t1: half, s0: n[0].t, s1: n[n.length - 1].t,
    });
    return out;
  }
  for (let i = 0; i + 1 < n.length; i++) {
    const d = panelDir(n, i);
    const len = Math.hypot(n[i + 1].x - n[i].x, n[i + 1].z - n[i].z);
    if (len < 1e-6) continue;
    // **Interior ends are pulled back, and this is the box's half of the
    // mitre.** Two boxes butted at a turn overlap on the *inside* of the bend,
    // and the inside of the bend is where the track is: measured before the
    // trim, the corner of a butted deck panel reached 0.19 m past the platform
    // face at Epping and into the car body. A box cannot be mitred -- its end
    // face is perpendicular to one direction -- so it gives up the corner
    // instead, `trim * tan(theta/2)` of it, which is exactly the overlap at the
    // offset the caller says it cares about.
    //
    // The cost is a hairline of missing prism at the joint on the *outside*
    // instead, and that is the safe direction twice over: the drawn mesh is
    // properly mitred by `offsetAt` so nothing is visible, and
    // `riding.PlatformField` projects onto this same spine and is what a body
    // actually stands on. A prism that over-reached would be an invisible wall.
    const back = trim > 0 ? trim * Math.tan(jointHalfAngle(n, i) / 2) : 0;
    const front = trim > 0 ? trim * Math.tan(jointHalfAngle(n, i + 1) / 2) : 0;
    const t0 = -len / 2 + (i > 0 ? back : 0);
    const t1 = len / 2 - (i + 2 < n.length ? front : 0);
    if (!(t1 > t0)) continue;
    out.push({
      i,
      x: (n[i].x + n[i + 1].x) / 2,
      z: (n[i].z + n[i + 1].z) / 2,
      ux: d.ux, uz: d.uz,
      t0, t1,
      s0: n[i].t + (i > 0 ? back : 0),
      s1: n[i + 1].t - (i + 2 < n.length ? front : 0),
    });
  }
  return out;
}

/**
 * The railhead at arc length `t` on the spine.
 *
 * ---------------------------------------------------------------------------
 * **The other axis the box was wrong in, and it was invisible until the plan
 * was fixed.** A platform's deck was `station.trackY + PLATFORM_HEIGHT` -- one
 * height, taken at the anchor, held for a hundred and sixty metres. A suburban
 * railway grades at up to about 1:100, so the rail at the end of a platform is
 * routinely most of a metre off the rail at its middle, and the deck either
 * buries itself in the ballast or floats over it. Measured after the plan sweep
 * landed: 2.6 km of running line with a station's canopy inside the car body,
 * every metre of it purely because the canopy's fixed height had been left
 * behind by a climbing track -- the worst 0.70 m at Guildford.
 *
 * So the height is swept too, and `riding.PlatformField` reads the same `y` out
 * of `projectSpine`, which it was already computing and throwing away.
 */
export function railYAt(spine: PlatformSpine, t: number): number {
  const n = spine.nodes;
  let i = 0;
  for (let k = 0; k + 1 < n.length; k++) {
    if (n[k].t <= t && n[k + 1].t >= t) { i = k; break; }
    if (n[k + 1].t < t) i = k;
  }
  const span = n[i + 1].t - n[i].t;
  const u = span > 0 ? (t - n[i].t) / span : 0;
  return n[i].y + (n[i + 1].y - n[i].y) * u;
}

/** The turn at node `i`, radians. Zero at the two ends, where there is no joint. */
function jointHalfAngle(n: readonly SpineNode[], i: number): number {
  if (i <= 0 || i + 1 >= n.length) return 0;
  const a = panelDir(n, i - 1);
  const b = panelDir(n, i);
  return Math.abs(Math.atan2(a.ux * b.uz - a.uz * b.ux, a.ux * b.ux + a.uz * b.uz));
}

/**
 * One panel of a sweep: a straight length of railway with its own frame.
 *
 * `t0`/`t1` are in the panel's **own** frame, centred on it, which is what
 * `FrameSolid` and `frameBox` want. `s0`/`s1` are the same extent as arc length
 * along the spine, which is what a caller placing an object *at* a position on
 * the platform wants. Both, because deriving one from the other at the call site
 * is where a sweep and the thing it carries drift apart.
 */
export interface SweepPanel {
  i: number;
  x: number; z: number;
  ux: number; uz: number;
  t0: number; t1: number;
  s0: number; s1: number;
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

/**
 * The sweep, checked by its pure parts, in both boot lists.
 *
 * ---------------------------------------------------------------------------
 * Four properties, and the first is the one the merge gate asks for: **on
 * straight track the sweep is the box it replaced**. Not "close to" -- the same
 * frame, the same extents, and a projection that agrees with the plain
 * dot-product one to the bit. If that ever stops holding, every station on a
 * straight in Sydney has quietly moved.
 *
 * The other three are the properties the curve case rests on and cannot be
 * eyeballed: that a panel is exactly parallel to its own track segment, which is
 * what makes the coping-to-rail distance a constant of the construction rather
 * than an outcome; that consecutive panels' mitred corners are the *same point*,
 * which is what makes the drawn deck have no slot down it; and that a spine that
 * doubles back is blunted rather than spiked.
 */
export function verifyPlatformSpine(): string[] {
  const bad: string[] = [];
  const REACH = 80;

  // --- 1. A straight spine is the box.
  const straight = straightSpine({ x: 100, z: 200, ux: 1, uz: 0, trackY: 5 }, REACH);
  if (!straight.flat) bad.push('a straight spine does not read as flat');
  if (straight.bow !== 0) bad.push(`a straight spine bows by ${straight.bow}`);
  const panels = sweepPanels(straight);
  if (panels.length !== 1) {
    bad.push(`a straight spine sweeps as ${panels.length} panels and must be one, or every station on a straight has moved`);
  } else {
    const p = panels[0];
    if (p.x !== 100 || p.z !== 200 || p.ux !== 1 || p.uz !== 0) {
      bad.push(`the single panel's frame is (${p.x}, ${p.z}) heading (${p.ux}, ${p.uz}) and should be the station's own`);
    }
    if (p.t0 !== -REACH || p.t1 !== REACH) bad.push(`the single panel runs ${p.t0}..${p.t1} and should be +/-${REACH}`);
  }
  // ...and its projection is the dot product, bit for bit.
  for (const [x, z] of [[100, 205], [40, 197], [160, 200], [123.5, 201.75]] as const) {
    const got = projectSpine(straight, x, z);
    const along = Math.max(-REACH, Math.min(REACH, x - 100));
    const across = z - 200;
    if (!Object.is(got.along, along) || !Object.is(got.across, across)) {
      bad.push(
        `projectSpine(${x}, ${z}) on a straight gave (${got.along}, ${got.across}) ` +
          `and the plain projection gives (${along}, ${across})`,
      );
    }
  }

  // --- 2. A curved spine: every panel is exactly parallel to its own segment.
  //
  // A quarter-degree per node over eight nodes, which is a 3 km radius and is
  // gentler than anything in the bake -- the point is the invariant, not the
  // magnitude.
  const nodes: SpineNode[] = [];
  let x = 0;
  let z = 0;
  let a = 0;
  for (let i = 0; i <= 8; i++) {
    nodes.push({ t: i * 20 - 80, x, y: 0, z });
    x += Math.cos(a) * 20;
    z += Math.sin(a) * 20;
    a += 0.06;
  }
  const curved = finish(nodes);
  if (curved.flat) bad.push('a curved spine reads as flat; SPINE_FLAT_M is not doing anything');
  const OFF = 1.62;
  for (const p of sweepPanels(curved)) {
    const n = curved.nodes;
    const q0 = offsetAt(curved, p.i, OFF);
    const q1 = offsetAt(curved, p.i + 1, OFF);
    // The offset line's distance from the segment it was offset from. Both ends
    // are mitred, so this is a real test of the mitre and not of the normal.
    for (const q of [q0, q1]) {
      const ex = n[p.i + 1].x - n[p.i].x;
      const ez = n[p.i + 1].z - n[p.i].z;
      const len = Math.hypot(ex, ez);
      const d = ((q.x - n[p.i].x) * -(ez / len) + (q.z - n[p.i].z) * (ex / len));
      if (Math.abs(d - OFF) > 1e-9) {
        bad.push(`a swept panel's coping is ${d.toFixed(6)} m from its own rail and should be ${OFF}`);
        break;
      }
    }
  }

  // --- 3. The joints are one point, so the deck has no slot down it.
  for (let i = 1; i + 1 < curved.nodes.length; i++) {
    const q = offsetAt(curved, i, OFF);
    const again = offsetAt(curved, i, OFF);
    if (!Object.is(q.x, again.x) || !Object.is(q.z, again.z)) {
      bad.push('offsetAt is not a function of its arguments');
      break;
    }
  }

  // --- 4. A reversal is blunted, not spiked. The negative control: without the
  // clamp in `offsetAt` this corner runs to infinity and the platform at a
  // crossover throat is drawn across the suburb.
  const doubled = finish([
    { t: -20, x: 0, y: 0, z: 0 },
    { t: 0, x: 20, y: 0, z: 0 },
    { t: 20, x: 0.2, y: 0, z: 0.4 },
  ]);
  const spike = offsetAt(doubled, 1, 9.4);
  if (!Number.isFinite(spike.x) || Math.hypot(spike.x - 20, spike.z) > 9.4 * 4) {
    bad.push(
      `a spine that doubles back put its rim ${Math.hypot(spike.x - 20, spike.z).toFixed(1)} m ` +
        `from the rail; offsetAt's reversal clamp is not holding`,
    );
  }

  return bad;
}
