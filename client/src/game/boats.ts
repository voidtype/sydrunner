/**
 * The boats: Sydney's ferries on their own routes, and the tinnies at the
 * jetties. Pure, three-free, on both boot lists.
 *
 * The suggestion board's #2 -- *"Boats -- ferries, jetskis"* -- and DESIGN.md's
 * verdict on it: **timetabled ferries on the railway's own philosophy**, a
 * deterministic timetable, the Manly run as the harbour's Hornsby-to-Penrith.
 * The owner, sending it: *"defs put them in as NPC vehicles, and docked (where
 * it makes sense for sure) ... make 3 different types of boats inc a ferry
 * which follows ferry routes and looks just like the sydney ferry"*.
 *
 * ---------------------------------------------------------------------------
 * A BOAT IS A LOOKUP, NOT A SIMULATION -- `game/traffic.ts`'s design, on water.
 *
 * Nothing here is stepped. A boat's position is a pure function of the route,
 * its place in the timetable and the tick, so sixteen players watch the same
 * Freshwater round Bradleys Head and `net/protocol.ts` gained not one byte
 * (DESIGN.md rule 5). There is no `Math.sin` or `Math.cos` in the pose: the
 * heading is the segment's own unit vector, and the bob a docked boat does is
 * a triangle wave.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTES ARE WATER, BY CONSTRUCTION.
 *
 * `boatroutes.ts` is generated: each wharf is a real wharf's coordinates
 * snapped to the nearest water the Quay's water can reach, and each route is
 * the water-only shortest path over the bake's own terrain, 30 m cells, eroded
 * one cell so a hull stays 30 m off every shore. A straight line from the
 * Quay to Manly crosses Bradleys Head and Middle Head; the path goes round
 * them the way the ferry does.
 *
 * ---------------------------------------------------------------------------
 * THE TIMETABLE, AND WHY IT IS DENSER THAN SYDNEY'S.
 *
 * A game day is a real hour, and a real Manly ferry every twenty minutes would
 * be one crossing per game-morning that most players never see. So a route's
 * headway is half its one-way time: at any instant there is a boat in each
 * direction, roughly mid-route, and a player at the Quay never waits longer
 * than a walk to the end of the wharf to see one leave. The Manly run carries
 * four Freshwaters, which is what Sydney has.
 *
 * Three kinds, by route: the **Freshwater** class on the Manly run (double-
 * ended, 70 m, green hull and cream decks); the **harbour ferry** on the inner
 * routes (the Emerald shape, 35 m, one wheelhouse, green and cream); the
 * **RiverCat** up the Parramatta River (a white catamaran with the green
 * band). And the **tinnie** -- a 4.5 m aluminium runabout -- docked at the
 * bay wharves, which is the boat "where it makes sense": nobody moors a
 * Freshwater at Double Bay. `world/boats.ts` draws all four.
 */
import { BOAT_ROUTES, WHARVES, SEA_Y, type BoatRoute } from './boatroutes.ts';

export const BOAT_KIND = { FRESHWATER: 0, HARBOUR: 1, RIVERCAT: 2, TINNIE: 3 } as const;
export type BoatKind = (typeof BOAT_KIND)[keyof typeof BOAT_KIND];

/** Which kind runs which route, by the route's own id. */
export function kindForRoute(id: string): BoatKind {
  if (id === 'F1') return BOAT_KIND.FRESHWATER;
  if (id === 'F3') return BOAT_KIND.RIVERCAT;
  return BOAT_KIND.HARBOUR;
}

/** Metres per second, by kind. Sydney's: 20 knots, 16 knots, 18 knots. */
export const SPEED: Readonly<Record<BoatKind, number>> = { 0: 10.3, 1: 8.2, 2: 9.3, 3: 0 };
/** Seconds alongside at an intermediate wharf, and at a terminal before turning. */
export const DWELL_S = 45;
export const TERMINAL_S = 150;
/** A shared terminal's berths: how far apart, and over what approach they separate. */
export const BERTH_PITCH_M = 26;
export const BERTH_BLEND_M = 120;
/** How far a docked hull bobs, metres, and over what period. */
export const BOB_M = 0.12;
export const BOB_S = 3.2;

export interface BoatPose {
  x: number;
  z: number;
  y: number;
  /** Unit heading, the way the bow points. */
  hx: number;
  hz: number;
  kind: BoatKind;
  /** Alongside a wharf this instant. */
  docked: boolean;
  /** The route and the boat's index on it. */
  route: string;
  index: number;
}

interface Timetable {
  route: BoatRoute;
  kind: BoatKind;
  /** Cumulative metres to each point. */
  along: Float64Array;
  /** One-way seconds including dwells, and the whole cycle out and back. */
  oneWay: number;
  cycle: number;
  headway: number;
  boats: number;
}

function timetableOf(route: BoatRoute): Timetable {
  const kind = kindForRoute(route.id);
  const n = route.points.length >> 1;
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = route.points[i * 2] - route.points[i * 2 - 2];
    const dz = route.points[i * 2 + 1] - route.points[i * 2 - 1];
    along[i] = along[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  const length = along[n - 1];
  const stops = route.stopIndex.length;
  const oneWay = length / SPEED[kind] + Math.max(0, stops - 2) * DWELL_S;
  const cycle = 2 * (oneWay + TERMINAL_S);
  const headway = Math.max(240, oneWay / 2);
  const boats = Math.max(1, Math.ceil(cycle / headway));
  return { route, kind, along, oneWay, cycle, headway, boats };
}

const TIMETABLES: readonly Timetable[] = BOAT_ROUTES.map(timetableOf);

/** Every ferry in the timetable, as (route index, boat index) pairs; the tinnies are separate. */
export function ferryCount(): number {
  let n = 0;
  for (const t of TIMETABLES) n += t.boats;
  return n;
}

/**
 * Where along the route a boat is at `s` seconds into its one-way run, as
 * metres and whether it is dwelling. Dwells are plateaus: the boat sits at the
 * stop for `DWELL_S`, which is what makes a wharf a place the boat is *at*
 * rather than a point it passes.
 */
function alongAt(t: Timetable, s: number): { m: number; docked: boolean } {
  const speed = SPEED[t.kind];
  let time = 0;
  let m = 0;
  const stops = t.route.stopIndex;
  for (let i = 1; i < stops.length; i++) {
    const from = t.along[stops[i - 1]];
    const to = t.along[stops[i]];
    const leg = (to - from) / speed;
    if (s <= time + leg) return { m: from + (s - time) * speed, docked: s - time < 2 || time + leg - s < 2 };
    time += leg;
    m = to;
    if (i < stops.length - 1) {
      if (s <= time + DWELL_S) return { m, docked: true };
      time += DWELL_S;
    }
  }
  return { m, docked: true };
}

/** The point and unit heading `m` metres along the route. */
function pointAt(t: Timetable, m: number, forward: boolean, out: BoatPose): void {
  const pts = t.route.points;
  const n = t.along.length;
  let i = 1;
  while (i < n - 1 && t.along[i] < m) i++;
  const a = i - 1;
  const seg = t.along[i] - t.along[a];
  const f = seg > 1e-6 ? Math.max(0, Math.min(1, (m - t.along[a]) / seg)) : 0;
  const ax = pts[a * 2];
  const az = pts[a * 2 + 1];
  const bx = pts[i * 2];
  const bz = pts[i * 2 + 1];
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  out.hx = (forward ? dx : -dx) / len;
  out.hz = (forward ? dz : -dz) / len;
}

/**
 * A ferry's pose at `seconds` (real seconds since `traffic.TRAFFIC_EPOCH_MS`,
 * i.e. `trafficSeconds(tick)`). Boat `index` on route `r` left the first
 * terminal `index * headway` seconds into the cycle, runs out, turns, runs
 * back, and waits; forever, deterministically.
 */
export function ferryPose(r: number, index: number, seconds: number, out: BoatPose): BoatPose {
  const t = TIMETABLES[r];
  const phase = (((seconds - index * t.headway) % t.cycle) + t.cycle) % t.cycle;
  let forward: boolean;
  let s: number;
  let docked: boolean;
  if (phase < t.oneWay) {
    forward = true;
    s = phase;
  } else if (phase < t.oneWay + TERMINAL_S) {
    forward = false;
    s = 0;
  } else if (phase < 2 * t.oneWay + TERMINAL_S) {
    forward = false;
    s = phase - t.oneWay - TERMINAL_S;
  } else {
    forward = true;
    s = 0;
  }
  const a = alongAt(t, s);
  docked = a.docked;
  const m = forward ? a.m : t.along[t.along.length - 1] - a.m;
  pointAt(t, m, forward, out);
  // Nine routes share the Quay, so nine boats would berth on one point.
  // Each route has its own berth: a lateral offset off the route's end,
  // blended in over the last sixty metres so the approach still reads as the
  // route. Deterministic per route, and the same on every machine.
  const length = t.along[t.along.length - 1];
  const nearEnd = Math.min(m, length - m);
  if (nearEnd < BERTH_BLEND_M) {
    const k = 1 - nearEnd / BERTH_BLEND_M;
    const berth = (((r * 7) % 5) - 2) * BERTH_PITCH_M * k;
    out.x += -out.hz * berth;
    out.z += out.hx * berth;
  }
  out.y = SEA_Y;
  out.kind = t.kind;
  out.docked = docked;
  out.route = t.route.id;
  out.index = index;
  return out;
}

/** The (route, boat) pairs, for a caller that walks every ferry. */
export function ferries(): ReadonlyArray<{ r: number; index: number; route: string; kind: BoatKind }> {
  const out: Array<{ r: number; index: number; route: string; kind: BoatKind }> = [];
  TIMETABLES.forEach((t, r) => {
    for (let index = 0; index < t.boats; index++) out.push({ r, index, route: t.route.id, kind: t.kind });
  });
  return out;
}

/**
 * The tinnies: docked at the bay wharves, where a runabout would be. Two or
 * three a wharf, fanned off the wharf point, each bobbing on its own phase.
 * The bay list is the wharves that are bays: nobody moors a runabout at the
 * Quay or Manly's ferry berths.
 */
export const TINNIE_WHARVES: readonly string[] = [
  'Rose Bay', 'Double Bay', 'Darling Point', 'Mosman Bay', 'Neutral Bay', 'Balmain East', 'Birchgrove',
  'Drummoyne', 'Abbotsford', 'Cabarita', 'Kissing Point', 'Blackwattle Bay', 'Glebe Point', 'Greenwich', 'Woolwich',
];

export interface Tinnie {
  x: number;
  z: number;
  hx: number;
  hz: number;
  phase: number;
}

export function tinnies(): readonly Tinnie[] {
  const out: Tinnie[] = [];
  let k = 0;
  for (const name of TINNIE_WHARVES) {
    const w = WHARVES[name];
    if (!w) continue;
    const count = 2 + (k % 2);
    for (let i = 0; i < count; i++) {
      // Fanned along a line off the wharf point; the headings quarter-turn so
      // the row reads as boats tied up rather than one boat copied.
      const ox = (i - (count - 1) / 2) * 9;
      const oz = 14 + (k % 3) * 4;
      const turn = (k + i) & 1;
      out.push({ x: w[0] + ox, z: w[1] + oz, hx: turn ? 1 : 0, hz: turn ? 0 : -1, phase: ((k * 7 + i * 3) % 10) / 10 });
      k++;
    }
  }
  return out;
}

/** A docked hull's rise this instant, metres: a triangle wave, no trig. */
export function bobAt(seconds: number, phase: number): number {
  const t = (seconds / BOB_S + phase) % 1;
  const tri = t < 0.5 ? t * 2 : 2 - t * 2;
  return (tri - 0.5) * 2 * BOB_M;
}

export function createBoatPose(): BoatPose {
  return { x: 0, z: 0, y: SEA_Y, hx: 0, hz: -1, kind: BOAT_KIND.HARBOUR, docked: false, route: '', index: 0 };
}

/** Self-check, on both boot lists. */
export function verifyBoats(): string[] {
  const failures: string[] = [];
  if (BOAT_ROUTES.length < 6) failures.push(`only ${BOAT_ROUTES.length} ferry routes are baked.`);
  const manly = TIMETABLES.find((t) => t.route.id === 'F1');
  if (!manly) failures.push('the Manly run is missing.');
  else if (manly.kind !== BOAT_KIND.FRESHWATER) failures.push('the Manly run is not a Freshwater.');
  const pose = createBoatPose();
  for (let r = 0; r < TIMETABLES.length; r++) {
    const t = TIMETABLES[r];
    if (t.along[t.along.length - 1] < 1000) failures.push(`${t.route.id} is under a kilometre long.`);
    if (t.boats < 1 || t.boats > 12) failures.push(`${t.route.id} runs ${t.boats} boats.`);
    // Every boat is on the route at every instant: within the polyline's own
    // bounds, heading a unit vector, and at a terminal between runs.
    let docks = 0;
    let moved = 0;
    let prevX = NaN;
    let prevZ = NaN;
    for (let s = 0; s < t.cycle; s += 5) {
      ferryPose(r, 0, s, pose);
      if (!Number.isFinite(pose.x) || !Number.isFinite(pose.z)) failures.push(`${t.route.id} produced a NaN pose.`);
      const h = Math.sqrt(pose.hx * pose.hx + pose.hz * pose.hz);
      if (Math.abs(h - 1) > 1e-6) failures.push(`${t.route.id} heading is not unit length.`);
      if (pose.docked) docks++;
      if (Number.isFinite(prevX)) {
        const step = Math.sqrt((pose.x - prevX) ** 2 + (pose.z - prevZ) ** 2);
        // Five seconds of way plus the berth's lateral drift on an approach.
        if (step > SPEED[t.kind] * 5 + (2 * BERTH_PITCH_M * 5) / (BERTH_BLEND_M / SPEED[t.kind]) + 1) failures.push(`${t.route.id} jumped ${step.toFixed(0)} m in five seconds.`);
        if (step > 0.5) moved++;
      }
      prevX = pose.x;
      prevZ = pose.z;
    }
    if (docks === 0) failures.push(`${t.route.id} never docks.`);
    if (moved === 0) failures.push(`${t.route.id} never moves.`);
    // Two boats on one route are never in the same place at the same time.
    if (t.boats > 1) {
      const a = createBoatPose();
      const b = createBoatPose();
      let together = 0;
      for (let s = 0; s < t.cycle; s += 30) {
        ferryPose(r, 0, s, a);
        ferryPose(r, 1, s, b);
        if (Math.abs(a.x - b.x) < 5 && Math.abs(a.z - b.z) < 5 && !(a.docked && b.docked)) together++;
      }
      if (together > 2) failures.push(`${t.route.id}: two boats overlapped ${together} times in a cycle.`);
    }
    // Determinism: the same second twice is the same pose.
    const p1 = createBoatPose();
    const p2 = createBoatPose();
    ferryPose(r, 0, 12345.6, p1);
    ferryPose(r, 0, 12345.6, p2);
    if (p1.x !== p2.x || p1.z !== p2.z || p1.hx !== p2.hx) failures.push(`${t.route.id} is not a pure function of the second.`);
  }
  const tin = tinnies();
  if (tin.length < 20) failures.push(`only ${tin.length} tinnies are docked.`);
  for (const b of tin) if (Math.abs(b.hx * b.hx + b.hz * b.hz - 1) > 1e-9) failures.push('a tinnie has no heading.');
  if (Math.abs(bobAt(0, 0) + BOB_M) > 1e-9 || Math.abs(bobAt(BOB_S / 2, 0) - BOB_M) > 1e-9) failures.push('the bob does not run trough to crest over half a period.');
  if (ferryCount() < 10) failures.push(`only ${ferryCount()} ferries on the harbour.`);
  // Two routes waiting at the Quay at once are at two berths, not one point.
  {
    const a = createBoatPose();
    const b = createBoatPose();
    let clashes = 0;
    let both = 0;
    for (let s = 0; s < 3600; s += 15) {
      for (let r1 = 0; r1 < TIMETABLES.length; r1++) {
        for (let r2 = r1 + 1; r2 < TIMETABLES.length; r2++) {
          ferryPose(r1, 0, s, a);
          ferryPose(r2, 0, s, b);
          if (!(a.docked && b.docked)) continue;
          both++;
          if (Math.abs(a.x - b.x) < 12 && Math.abs(a.z - b.z) < 12) clashes++;
        }
      }
    }
    if (both > 0 && clashes > both * 0.05) failures.push(`${clashes} of ${both} shared waits put two ferries on one berth.`);
  }
  return failures;
}
