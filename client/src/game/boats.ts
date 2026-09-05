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
 *
 * And the **jetskis**, the other half of the suggestion. A jetski is a route
 * like a ferry's -- `J1` to `J5` in `boatroutes.ts`, out and back between two
 * wharves over the same water-only paths -- at thirty knots with no calls in
 * between, so the timetable, the berthing and the docked bob are the ferry's
 * own arithmetic and nothing here is stepped for them either. Five runs:
 * Rose Bay to Watsons Bay, Double Bay across to the Zoo, Balmain to
 * Drummoyne, Manly to Watsons Bay across the Heads, Neutral Bay to
 * Kirribilli. A rider is part of the mesh; an empty jetski at thirty knots is
 * a ghost story.
 *
 * ---------------------------------------------------------------------------
 * AND WHAT SHAPE EACH ONE IS, WHICH IS HERE AND NOT IN THE FILE THAT DRAWS IT.
 *
 * `BOAT_SIZE`, `BOAT_WINDOW_ROWS` and `navLamps` are three tables of the same
 * fact -- how long a Freshwater is, where its window bands are, where its
 * sidelights hang -- and they are in this three-free file rather than beside the
 * boxes in `world/boats.ts` because **two** readers need them now. The hulls are
 * built from them, and so are the navigation lights in `world/nightlights.
 * BoatLights`, and the owner's *"boats also need lights at nigth"* is only
 * answered if the green light is on the same starboard bridge wing the cream
 * superstructure is. Two copies of a hull's beam is how a lamp ends up hanging
 * two metres off the side of the boat it belongs to, at night, over water, where
 * nothing else in the frame gives the eye a scale to notice it by.
 */
import { BOAT_ROUTES, WHARVES, SEA_Y, type BoatRoute } from './boatroutes.ts';

export const BOAT_KIND = { FRESHWATER: 0, HARBOUR: 1, RIVERCAT: 2, TINNIE: 3, JETSKI: 4 } as const;
export type BoatKind = (typeof BOAT_KIND)[keyof typeof BOAT_KIND];

/** Which kind runs which route, by the route's own id. */
export function kindForRoute(id: string): BoatKind {
  if (id === 'F1') return BOAT_KIND.FRESHWATER;
  if (id === 'F3') return BOAT_KIND.RIVERCAT;
  if (id.startsWith('J')) return BOAT_KIND.JETSKI;
  return BOAT_KIND.HARBOUR;
}

/** Metres per second, by kind. Sydney's: 20 knots, 16 knots, 18 knots. */
export const SPEED: Readonly<Record<BoatKind, number>> = { 0: 10.3, 1: 8.2, 2: 9.3, 3: 0, 4: 15.4 };

/**
 * How big each hull is, and how high the highest thing on it stands.
 *
 * `length` and `beam` are the numbers `world/boats.ts` builds every box of a
 * hull from -- its `L` and `W` -- and `mastY` is the top of the funnel, the
 * wheelhouse or the handlebar post, measured off the waterline. The Freshwater's
 * 70 by 12.6 is the real ship's; the rest are the Emerald class, the RiverCat, a
 * 4.5 m runabout and a two-seat ski.
 */
export const BOAT_SIZE: Readonly<Record<BoatKind, { length: number; beam: number; mastY: number }>> = {
  0: { length: 70, beam: 12.6, mastY: 10.65 },
  1: { length: 35, beam: 9, mastY: 5.65 },
  2: { length: 35, beam: 10, mastY: 5.15 },
  3: { length: 4.5, beam: 1.8, mastY: 0.9 },
  4: { length: 2.9, beam: 1.12, mastY: 0.96 },
};

/** One band of saloon windows: its middle, its height off the waterline, and its extent. */
export interface WindowRow {
  x: number;
  y: number;
  length: number;
  height: number;
  beam: number;
}

/**
 * The window bands, which are both the dark strip in the daytime hull and the
 * warm strip after dark.
 *
 * `world/boats.ts` emits one `WINDOW`-coloured box per row and
 * `world/nightlights.BoatLights` puts a soft additive sheet just proud of the
 * same box, so a ferry's lit saloon is exactly where its windows are. The
 * fractions are the hulls' own -- 0.80 of the length, 0.9 of the beam, and the
 * four centimetres that make the band stand proud of the cream around it.
 *
 * The tinnie and the jetski have none, because neither has a saloon: a runabout
 * is an open boat and a ski is a seat.
 */
export const BOAT_WINDOW_ROWS: Readonly<Record<BoatKind, readonly WindowRow[]>> = {
  0: [
    { x: 0, y: 2.1, length: 70 * 0.8 + 0.04, height: 0.9, beam: 12.6 * 0.9 + 0.04 },
    { x: 0, y: 4.8, length: 70 * 0.52 + 0.04, height: 0.85, beam: 12.6 * 0.78 + 0.04 },
    { x: 70 * 0.3, y: 7.4, length: 5.04, height: 0.8, beam: 12.6 * 0.5 + 0.04 },
    { x: -70 * 0.3, y: 7.4, length: 5.04, height: 0.8, beam: 12.6 * 0.5 + 0.04 },
  ],
  1: [
    { x: -35 * 0.05, y: 1.8, length: 35 * 0.72 + 0.04, height: 0.8, beam: 9 * 0.88 + 0.04 },
    { x: 35 * 0.18, y: 4.3, length: 6.04, height: 0.75, beam: 9 * 0.6 + 0.04 },
  ],
  2: [
    { x: -35 * 0.02, y: 1.7, length: 35 * 0.7 + 0.04, height: 0.8, beam: 10 * 0.86 + 0.04 },
    { x: 35 * 0.2, y: 4.0, length: 5.04, height: 0.7, beam: 10 * 0.5 + 0.04 },
  ],
  3: [],
  4: [],
};

/* --------------------------------------------------------------------------
 * Navigation lights.
 * ------------------------------------------------------------------------ */

/**
 * The four, in the order every reader below indexes them by.
 *
 * Fixed order rather than a search by colour, because the geometry is baked once
 * per kind and the self-check has to be able to say *which* lamp ended up on the
 * wrong side of the boat.
 */
export const NAV_PORT = 0;
export const NAV_STARBOARD = 1;
export const NAV_MAST = 2;
export const NAV_STERN = 3;
/** How many lamps a boat carries. `world/nightlights.BOAT_LIGHT_CAPACITY` is a multiple of it. */
export const NAV_LAMPS_PER_BOAT = 4;

/**
 * The colours, and they are the international rule rather than a palette
 * decision: **red to port, green to starboard**, white ahead and white astern.
 *
 * That is the whole reason a boat's lights are worth drawing at all. A ferry
 * crossing in front of you shows green then white; one crossing away shows red;
 * one coming at you shows both sidelights at once. It is the only thing in this
 * game that tells you which way something on the water is going when the hull is
 * a silhouette, and getting it backwards would be a specific and legible lie.
 *
 * Bright, and unapologetically: these are point sources over black water at up
 * to `world/boats.FERRY_DRAW_M`, and the additive blend puts them against a
 * frame that arrives at a few hundredths of scene-linear. See
 * `world/nightlights.ts`'s header on why a fixed amount of light is a glow at
 * night and invisible at noon.
 */
export const NAV_RED: readonly [number, number, number] = [1.0, 0.05, 0.02];
export const NAV_GREEN: readonly [number, number, number] = [0.04, 1.0, 0.18];
export const NAV_WHITE: readonly [number, number, number] = [1.0, 0.95, 0.86];

/** One lamp in the hull's own axes: +x is the bow, +y up from the waterline, +z starboard. */
export interface NavLamp {
  forward: number;
  up: number;
  starboard: number;
  colour: readonly [number, number, number];
}

/**
 * Where a hull's four lamps hang, as fractions of its own size.
 *
 * Sidelights forward and out at the bridge wings, where the screens that make
 * them 112.5-degree lights would be; the masthead high and forward of the
 * middle; the stern light low and right aft. A double-ended Freshwater has two
 * of everything in life and shows the set for whichever end is leading -- which
 * this does not model, and does not need to: `ferryPose` turns the hull round at
 * the terminal, so the bow is always the leading end and the lights are always
 * on it.
 */
export function navLamps(kind: BoatKind): readonly NavLamp[] {
  const size = BOAT_SIZE[kind] ?? BOAT_SIZE[1];
  const half = size.length / 2;
  const deck = size.mastY * 0.8;
  return [
    { forward: half * 0.6, up: deck, starboard: -size.beam * 0.44, colour: NAV_RED },
    { forward: half * 0.6, up: deck, starboard: size.beam * 0.44, colour: NAV_GREEN },
    { forward: half * 0.14, up: size.mastY + 0.25, starboard: 0, colour: NAV_WHITE },
    { forward: -half * 0.94, up: size.mastY * 0.5, starboard: 0, colour: NAV_WHITE },
  ];
}

/** Where a lamp on a posed boat is, in world metres. */
export interface NavLampPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * One lamp of one posed boat, in world metres.
 *
 * The rotation is `world/boats.BoatFleet.update`'s own -- `rotation.y =
 * atan2(-hz, hx)`, so `cos = hx` and `sin = -hz` -- written out as the two
 * multiplies it reduces to rather than composed from a matrix, because this is
 * the arithmetic the self-check needs and a check that used a `Matrix4` would be
 * checking three's rotation convention rather than this file's.
 *
 * `y` is passed rather than taken from the pose because the hull rides the bob
 * (`bobAt`), and a stern light that stayed at sea level while the boat it is
 * bolted to rose 12 cm would be the sort of thing only a still frame catches.
 */
export function navLampWorld(
  pose: BoatPose,
  lamp: NavLamp,
  y: number,
  out: NavLampPoint,
): NavLampPoint {
  out.x = pose.x + lamp.forward * pose.hx - lamp.starboard * pose.hz;
  out.y = y + lamp.up;
  out.z = pose.z + lamp.forward * pose.hz + lamp.starboard * pose.hx;
  return out;
}
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
  // Off the route's *forward* direction, not the boat's heading, so a boat
  // that turns at the terminal swings its bow and stays on its berth: the
  // heading flips at the turn and an offset taken from it would jump the
  // hull fifty metres sideways, which is what the first cut did.
  const length = t.along[t.along.length - 1];
  const nearEnd = Math.min(m, length - m);
  if (nearEnd < BERTH_BLEND_M) {
    const k = 1 - nearEnd / BERTH_BLEND_M;
    const berth = (((r * 7) % 5) - 2) * BERTH_PITCH_M * k;
    const fx = forward ? out.hx : -out.hx;
    const fz = forward ? out.hz : -out.hz;
    out.x += -fz * berth;
    out.z += fx * berth;
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
  const skis = TIMETABLES.filter((t) => t.kind === BOAT_KIND.JETSKI);
  if (skis.length < 3) failures.push(`only ${skis.length} jetski runs are baked; five are generated.`);
  for (const t of skis) {
    if (t.route.stopIndex.length !== 2) failures.push(`${t.route.id} is a jetski run with ${t.route.stopIndex.length} stops; a jetski calls nowhere.`);
    if (!(SPEED[t.kind] > SPEED[BOAT_KIND.FRESHWATER])) failures.push('a jetski is no faster than a Freshwater.');
  }
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

  /* --- The navigation lights, and the one claim in them that is a *rule*
   * rather than a taste: red is to port and green is to starboard.
   *
   * Every failure here draws a perfectly good pair of coloured dots. A boat with
   * its sidelights swapped reads as going the other way, which is worse than no
   * lights at all, and nothing on screen contradicts it -- the hull is a
   * silhouette and the wake is not modelled. So the check is made in world
   * metres against a boat on a known heading, not against the table.
   *
   * The world frame is east and negative-north (`z = -north`), so a boat heading
   * **north** has `(hx, hz) = (0, -1)` and its starboard side is **east**: the
   * green lamp's world x must be greater than the hull's. Turn it round and the
   * green goes west. That is the whole assertion, and it is the one that would
   * have caught the sign error in `navLampWorld` that this comment exists
   * because of. */
  {
    const point: NavLampPoint = { x: 0, y: 0, z: 0 };
    for (const kind of [BOAT_KIND.FRESHWATER, BOAT_KIND.HARBOUR, BOAT_KIND.RIVERCAT, BOAT_KIND.TINNIE, BOAT_KIND.JETSKI]) {
      const lamps = navLamps(kind);
      if (lamps.length !== NAV_LAMPS_PER_BOAT) {
        failures.push(`kind ${kind} carries ${lamps.length} navigation lamps; ${NAV_LAMPS_PER_BOAT} are the set.`);
        continue;
      }
      if (lamps[NAV_PORT].colour !== NAV_RED || lamps[NAV_STARBOARD].colour !== NAV_GREEN) {
        failures.push(`kind ${kind} does not carry red to port and green to starboard.`);
      }
      if (lamps[NAV_MAST].colour !== NAV_WHITE || lamps[NAV_STERN].colour !== NAV_WHITE) {
        failures.push(`kind ${kind}'s masthead or stern light is not white.`);
      }
      if (!(lamps[NAV_MAST].up > lamps[NAV_STERN].up)) {
        failures.push(`kind ${kind}'s masthead is not above its stern light.`);
      }
      if (!(lamps[NAV_MAST].forward > lamps[NAV_STERN].forward)) {
        failures.push(`kind ${kind}'s masthead is not forward of its stern light.`);
      }
      const size = BOAT_SIZE[kind];
      for (const lamp of lamps) {
        if (Math.abs(lamp.forward) > size.length / 2 + 1e-6) {
          failures.push(`a lamp on kind ${kind} hangs ${lamp.forward.toFixed(2)} m off a ${size.length} m hull.`);
          break;
        }
        if (Math.abs(lamp.starboard) > size.beam / 2 + 1e-6) {
          failures.push(`a lamp on kind ${kind} hangs ${lamp.starboard.toFixed(2)} m off a ${size.beam} m beam.`);
          break;
        }
      }

      // --- And in the world, on the two headings that make the rule readable.
      const boat = createBoatPose();
      boat.kind = kind;
      boat.x = 1000;
      boat.z = -2000;
      for (const [heading, hx, hz] of [['north', 0, -1], ['south', 0, 1]] as const) {
        boat.hx = hx;
        boat.hz = hz;
        navLampWorld(boat, lamps[NAV_STARBOARD], SEA_Y, point);
        const greenEast = point.x - boat.x;
        navLampWorld(boat, lamps[NAV_PORT], SEA_Y, point);
        const redEast = point.x - boat.x;
        const want = heading === 'north' ? 1 : -1;
        if (Math.sign(greenEast) !== want || Math.sign(redEast) !== -want) {
          failures.push(
            `Heading ${heading}, kind ${kind} puts green ${greenEast.toFixed(2)} m east of the hull ` +
              `and red ${redEast.toFixed(2)} m. Heading ${heading} the starboard side is the ` +
              `${want > 0 ? 'east' : 'west'}ern one, so the green lamp must be ` +
              `${want > 0 ? 'east' : 'west'} of centre and the red the other way.`,
          );
        }
        // The two sidelights are the beam apart and neither has drifted along
        // the hull: a rotation that mixed the two multiplies would still put
        // them either side of the centre and would shorten the gap.
        navLampWorld(boat, lamps[NAV_STARBOARD], SEA_Y, point);
        const gx = point.x, gz = point.z;
        navLampWorld(boat, lamps[NAV_PORT], SEA_Y, point);
        const gap = Math.sqrt((gx - point.x) ** 2 + (gz - point.z) ** 2);
        if (Math.abs(gap - Math.abs(lamps[NAV_STARBOARD].starboard - lamps[NAV_PORT].starboard)) > 1e-3) {
          failures.push(`heading ${heading}, kind ${kind}'s sidelights came out ${gap.toFixed(2)} m apart.`);
        }
      }
      // A heading down the world's own +x, where the two multiplies cannot
      // cover for each other: the masthead has to be ahead in x and nowhere
      // else, and the starboard lamp has to be at +z (which is south).
      boat.hx = 1;
      boat.hz = 0;
      navLampWorld(boat, lamps[NAV_MAST], SEA_Y, point);
      if (Math.abs(point.x - boat.x - lamps[NAV_MAST].forward) > 1e-3 || Math.abs(point.z - boat.z) > 1e-3) {
        failures.push(`kind ${kind}'s masthead is not straight ahead of a boat heading east.`);
      }
      navLampWorld(boat, lamps[NAV_STARBOARD], SEA_Y, point);
      if (Math.abs(point.z - boat.z - lamps[NAV_STARBOARD].starboard) > 1e-3) {
        failures.push(`kind ${kind}'s starboard lamp is not abeam of a boat heading east.`);
      }
      if (Math.abs(point.y - (SEA_Y + lamps[NAV_STARBOARD].up)) > 1e-6) {
        failures.push(`kind ${kind}'s starboard lamp did not take the hull's own height.`);
      }
    }
  }

  // --- The window bands the saloon glow is painted on: inside the hull, above
  // the waterline, and present on the three ferries and neither of the two open
  // boats. A row wider than the beam is a glow sheet hanging in the air beside
  // the ship.
  for (const kind of [BOAT_KIND.FRESHWATER, BOAT_KIND.HARBOUR, BOAT_KIND.RIVERCAT]) {
    const rows = BOAT_WINDOW_ROWS[kind];
    if (rows.length === 0) {
      failures.push(`kind ${kind} is a ferry with no window band; its saloon cannot light up.`);
      continue;
    }
    const size = BOAT_SIZE[kind];
    for (const row of rows) {
      if (row.beam > size.beam + 0.2) failures.push(`a window row on kind ${kind} is ${row.beam.toFixed(2)} m wide on a ${size.beam} m beam.`);
      if (Math.abs(row.x) + row.length / 2 > size.length / 2 + 0.2) failures.push(`a window row on kind ${kind} runs past the ends of the hull.`);
      if (!(row.y > 0) || !(row.height > 0)) failures.push(`a window row on kind ${kind} is under the waterline or has no height.`);
      if (row.y + row.height > size.mastY + 0.5) failures.push(`a window row on kind ${kind} is above its masthead.`);
    }
  }
  if (BOAT_WINDOW_ROWS[BOAT_KIND.TINNIE].length !== 0 || BOAT_WINDOW_ROWS[BOAT_KIND.JETSKI].length !== 0) {
    failures.push('an open boat has a saloon window band.');
  }

  return failures;
}
