/**
 * Where you are, in words: "King Street, Newtown".
 *
 * One line of text under the minimap, recomputed twice a second, naming the
 * street the player is standing on and the suburb it is in -- and at a junction,
 * naming both streets, because "cnr King St & Carillon Ave" is how a Sydneysider
 * would say it and "King Street" alone is how a GPS would.
 *
 * The map itself is a figure-ground plan with no labels in it and should stay
 * that way -- `minimap.ts` argues at length that the streets read as the void
 * between the buildings, and lettering that void would fill the one part of the
 * picture that carries the shape. So the naming happens in a strip *beside* the
 * drawing rather than on it, which also means it costs the 15 Hz redraw nothing.
 *
 * ---------------------------------------------------------------------------
 * The projection.
 *
 * Every named centreline run within `SEARCH_M` of the player is projected onto,
 * point-to-polyline, clamped per segment -- `world/streetnames.ts` holds the
 * maths. The result is reduced to one distance per *distinct name*, which is the
 * whole reason this is not just "nearest run": OSM splits a street into a way
 * per block and the pipeline clips those to tiles, so Crown Street arrives as
 * eleven separate runs and a naive nearest-two would offer "cnr Crown Street &
 * Crown Street" at every corner of it.
 *
 * The cost is 40-90 runs at the median viewpoint, a few hundred points, twice a
 * second. That is three orders of magnitude under the minimap redraw it sits
 * next to, which is itself two orders under its own budget, so nothing here is
 * indexed, cached or decimated beyond what the sidecar already is.
 *
 * ---------------------------------------------------------------------------
 * The corner rule, and why it is about the *gap* rather than the distances.
 *
 * The obvious reading of "show a corner when you are near two streets" is a
 * distance test on both: within some metres of A and within some metres of B.
 * It does not work, and the reason is geometric rather than a matter of tuning.
 * Two centrelines *cross* at a junction, so the region where both distances are
 * small is a disc of a few metres around the crossing point -- while the place a
 * player actually stands to read a corner is the footpath, which is half a
 * carriageway plus a kerb away from one centreline and often fifteen metres back
 * from the other. Tuned loose enough to catch the footpath, that test fires half
 * way down every block that has a lane coming off it.
 *
 * What separates "at the corner" from "on the street" is not being near both,
 * it is being **near-equidistant from both**. Walk ten metres down King Street
 * and the gap to Carillon Avenue opens by ten metres; stand on the corner and it
 * is nearly nothing, wherever on the corner you are standing. So the test is
 * `dB - dA < CORNER_GAP_M`, with `CORNER_NEAR_M` as a sanity bound so that two
 * streets equally far away across a park do not make a corner out of open
 * ground.
 *
 * ---------------------------------------------------------------------------
 * Hysteresis, and what it is defending against.
 *
 * The gap is a continuous function of position and the test is a threshold on
 * it, so a player standing still at the exact gap -- which is a real place, a
 * few metres wide, on every approach to every junction -- would have the readout
 * flip on every evaluation as the position jitters by centimetres. Twice a
 * second, that is a line of text strobing between one street and two.
 *
 * So the threshold is two thresholds: `CORNER_GAP_M` to *enter* the corner
 * reading and `CORNER_GAP_M + CORNER_HYST_M` to leave it, and the same band on
 * the distance bound. The cost is that the corner reading persists about a metre
 * and a half further down the street than it strictly should, which nobody can
 * see; what it buys is that walking through a junction reads one, two, one
 * rather than one, two, one, two, one.
 */

import type { NamedSegment } from '../world/streetnames.ts';
import { distanceToPolylineSquared } from '../world/streetnames.ts';

/**
 * Where a locator gets its streets. Structural, so `game/` states what it needs
 * and `world/TileStreamer` satisfies it without either importing the other's
 * class -- the same shape `PowerupSink` uses in the other direction.
 */
export interface StreetSource {
  namedStreetsNear(x: number, z: number, radius: number, out: NamedSegment[]): NamedSegment[];
}

/** One suburb label node, world metres, as it arrives in `world/suburbs.json`. */
export interface SuburbNode {
  name: string;
  x: number;
  z: number;
}

/**
 * How far from the player a street can be and still be the one you are on.
 *
 * A Sydney inner-suburb block is 80-120 m across, so a point in the middle of
 * one is 40-60 m from the streets around it. 40 is deliberately under that: the
 * readout should go quiet -- suburb only -- when you are genuinely inside a
 * block, in a park or on the harbour, rather than confidently naming a street
 * two gardens away that you cannot see. On a footpath the answer is 8-14 m and
 * on the carriageway it is under 6, so this has thirty metres of headroom for
 * the case it exists to serve and none of the case it exists to refuse.
 */
const SEARCH_M = 40;

/**
 * How much nearer the second street may be before the readout is a corner.
 *
 * The user's number, and it survives contact with the geometry: at 3 m of gap
 * the corner reading covers the footpaths and the crossings of a junction and
 * gives out about eight metres down each leg, which is the length of the corner
 * as anyone would point at it.
 */
const CORNER_GAP_M = 3;

/**
 * Both streets must be at least this near for a corner to be read at all.
 *
 * The bound that stops near-equidistance from meaning anything on its own. Stand
 * in the middle of Prince Alfred Park and City Road and Chalmers Street are both
 * a hundred metres off and within a metre of each other; that is not a corner,
 * it is a park. 18 m clears the widest junction a player can stand in the middle
 * of -- Broadway's centrelines are 11 m from its own kerb -- and excludes
 * everything past the far footpath.
 */
const CORNER_NEAR_M = 18;

/**
 * The band the two thresholds are separated by, metres. See the header.
 *
 * 1.5 m at a walk is about a second, which is the right order: long enough that
 * jitter and the 2 Hz clock cannot cross it, short enough that a player who
 * deliberately walks off a corner sees the readout follow them.
 */
const CORNER_HYST_M = 1.5;

/** Seconds between projections. */
const STREET_INTERVAL = 0.5;

/**
 * Seconds between suburb lookups.
 *
 * Six times the street clock, because the two answers change on completely
 * different scales: the street under you changes every block, and the suburb
 * changes every kilometre or so. At a sprint's 8.2 m/s three seconds is 25 m,
 * which is a fortieth of the median distance between two suburb label nodes.
 */
const SUBURB_INTERVAL = 3;

/**
 * The type words a corner reading is allowed to shorten, and to what.
 *
 * The same table as `pipeline/sydney/furniture.py`'s `_ROAD_TYPE_ABBREV`, which
 * is signage practice rather than a data cleanup -- no blade in Australia is
 * lettered "Sydney Park Road". It is repeated here rather than shipped in the
 * sidecar on purpose: the sidecar carries the **full** name because a readout is
 * prose and because "St" cannot be expanded back (Sydney has both a Sussex
 * Street and a St Johns Road), so the client is the only place that can decide
 * to shorten and the only place that knows it has two names to fit.
 *
 * Deliberately absent, exactly as in the pipeline's table: Broadway, Circus,
 * Mall, Row, Wharf -- the types nobody abbreviates -- and every single-word
 * name, which the guard in `abbreviateStreet` handles.
 */
const ROAD_TYPE_SHORT: Record<string, string> = {
  street: 'St',
  road: 'Rd',
  avenue: 'Ave',
  lane: 'Ln',
  place: 'Pl',
  drive: 'Dr',
  court: 'Ct',
  crescent: 'Cres',
  parade: 'Pde',
  terrace: 'Tce',
  highway: 'Hwy',
  boulevard: 'Bvd',
  boulevarde: 'Bvd',
  circuit: 'Cct',
  close: 'Cl',
  esplanade: 'Esp',
  grove: 'Gr',
  square: 'Sq',
  parkway: 'Pwy',
  walk: 'Wk',
  gardens: 'Gdns',
  expressway: 'Xwy',
  freeway: 'Fwy',
  motorway: 'Mwy',
};

/**
 * Shorten one street's type word, for the corner form only.
 *
 * Last word only, so "Broadway" and "Missenden Road" both come out right, and
 * a name that is one word is returned untouched -- which is what stops Broadway
 * being read as "Broadwk".
 *
 * Unlike the pipeline's version this does *not* peel trailing modifiers
 * ("Alfred Street North", "Macquarie Street Offramp"). The pipeline needs that
 * because a blade has a fixed plate width it must fit; here the modifier cases
 * are motorway ramps, a player is never standing on the corner of one, and a
 * peel that fires wrongly would rename a street rather than merely widen it.
 */
export function abbreviateStreet(name: string): string {
  const words = name.split(' ');
  if (words.length < 2) return name;
  const short = ROAD_TYPE_SHORT[words[words.length - 1].toLowerCase()];
  if (short === undefined) return name;
  words[words.length - 1] = short;
  return words.join(' ');
}

/** What the locator worked out. Exposed whole so a caller can format its own. */
export interface Readout {
  /** The street the player is on, full form, or null in the middle of a block. */
  street: string | null;
  /** The second street of a corner, full form, or null when it is not one. */
  cross: string | null;
  /** Nearest suburb label node, or null before `world/suburbs.json` lands. */
  suburb: string | null;
  /** Metres to `street`. `Infinity` when there is none. */
  distance: number;
  /** The one line the HUD draws. Empty when nothing at all is known. */
  text: string;
}

export class Locator {
  private readonly source: StreetSource;
  private readonly baseUrl: string;

  /** Grows to its high-water mark and stays there; see `namedStreetsNear`. */
  private readonly segments: NamedSegment[] = [];
  /**
   * Best squared distance per distinct street name, rebuilt each evaluation.
   *
   * A `Map` cleared and refilled rather than one allocated per pass: it holds a
   * few dozen entries twice a second forever, and `clear` keeps the buckets.
   */
  private readonly byName = new Map<string, number>();

  private suburbs: SuburbNode[] = [];
  private suburbsRequested = false;

  private streetClock = STREET_INTERVAL;
  private suburbClock = SUBURB_INTERVAL;
  /** The last position a projection was run at, so a still player costs nothing. */
  private lastX = NaN;
  private lastZ = NaN;
  private suburbName: string | null = null;

  /** True while the readout is showing a corner. The hysteresis' one bit of state. */
  private atCorner = false;
  /**
   * The corner pair as it was last *written*, which is not always the order it
   * was computed in. See `compose`.
   */
  private shownA: string | null = null;
  private shownB: string | null = null;

  private readout: Readout = {
    street: null,
    cross: null,
    suburb: null,
    distance: Infinity,
    text: '',
  };

  private evaluations = 0;
  private lastSegments = 0;
  private lastMs = 0;

  /** The build stamp, as a query suffix. See `world/version.ts`. */
  private readonly version: string;

  constructor(source: StreetSource, baseUrl = '/world', version = '') {
    this.source = source;
    this.baseUrl = baseUrl;
    this.version = version;
  }

  /**
   * Fetch the suburb label nodes.
   *
   * Never throws and never has to be awaited: a world with no `suburbs.json` --
   * one built before this existed -- produces a readout with street names and no
   * place on the end of them, which is a worse readout and a working game. The
   * flag makes a second call a no-op rather than a second request, so a caller
   * may fire and forget.
   */
  async loadSuburbs(): Promise<number> {
    if (this.suburbsRequested) return this.suburbs.length;
    this.suburbsRequested = true;
    try {
      const resp = await fetch(`${this.baseUrl}/suburbs.json${this.version}`);
      if (!resp.ok) return 0;
      const raw = (await resp.json()) as SuburbNode[];
      // Filtered rather than trusted: one malformed record with a NaN
      // coordinate would win every nearest test from then on, because every
      // comparison against NaN is false and the incumbent never gets replaced.
      this.suburbs = raw.filter(
        (s) =>
          typeof s?.name === 'string' &&
          s.name.length > 0 &&
          Number.isFinite(s.x) &&
          Number.isFinite(s.z),
      );
      // The next `update` re-evaluates rather than waiting out the clock, so
      // the suburb appears as soon as it lands instead of up to three seconds
      // later.
      this.suburbClock = SUBURB_INTERVAL;
      return this.suburbs.length;
    } catch {
      return 0;
    }
  }

  /**
   * Called every frame; evaluates on its own two clocks.
   *
   * Both reset to zero rather than subtracting their interval, on `Minimap`'s
   * argument: this is a picture of the present and a frame that arrives late has
   * nothing to catch up on.
   */
  update(dt: number, x: number, z: number): void {
    this.streetClock += dt;
    this.suburbClock += dt;

    if (this.suburbClock >= SUBURB_INTERVAL) {
      this.suburbClock = 0;
      this.suburbName = this.nearestSuburb(x, z);
    }
    if (this.streetClock >= STREET_INTERVAL) {
      this.streetClock = 0;
      // A player who has not moved since the last projection gets the last
      // answer. Standing still is most of a session -- a menu, a chat, a
      // respawn -- and the street under a stationary player is not a thing that
      // changes. The suburb above is still refreshed, because it is what changes
      // when a *file* lands rather than when the player does.
      if (x !== this.lastX || z !== this.lastZ) {
        this.lastX = x;
        this.lastZ = z;
        this.project(x, z);
      }
      this.compose();
    }
  }

  /** The current answer. A live object -- read it, do not keep it. */
  get current(): Readonly<Readout> {
    return this.readout;
  }

  /** The one line the HUD draws. */
  get text(): string {
    return this.readout.text;
  }

  private project(x: number, z: number): void {
    const t0 = performance.now();
    const segs = this.source.namedStreetsNear(x, z, SEARCH_M, this.segments);
    const byName = this.byName;
    byName.clear();
    const limit = SEARCH_M * SEARCH_M;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const d2 = distanceToPolylineSquared(seg.points, x, z);
      if (d2 > limit) continue;
      const prev = byName.get(seg.name);
      if (prev === undefined || d2 < prev) byName.set(seg.name, d2);
    }

    // The two best distinct names, in one pass. A sort would be clearer and is
    // not worth an allocation on a clock: two running minima over a few dozen
    // entries is the same code a sort's first two elements would cost.
    let bestName: string | null = null;
    let best2 = Infinity;
    let nextName: string | null = null;
    let next2 = Infinity;
    for (const [name, d2] of byName) {
      if (d2 < best2) {
        next2 = best2;
        nextName = bestName;
        best2 = d2;
        bestName = name;
      } else if (d2 < next2) {
        next2 = d2;
        nextName = name;
      }
    }

    const dA = Math.sqrt(best2);
    const dB = Math.sqrt(next2);
    // Two thresholds rather than one, and which pair applies depends on what is
    // already showing -- that is the whole of the hysteresis. See the header.
    const gapLimit = this.atCorner ? CORNER_GAP_M + CORNER_HYST_M : CORNER_GAP_M;
    const nearLimit = this.atCorner ? CORNER_NEAR_M + CORNER_HYST_M : CORNER_NEAR_M;
    const corner =
      bestName !== null && nextName !== null && dB - dA < gapLimit && dB <= nearLimit;

    this.atCorner = corner;
    this.readout.street = bestName;
    this.readout.cross = corner ? nextName : null;
    this.readout.distance = bestName === null ? Infinity : dA;

    this.evaluations++;
    this.lastSegments = segs.length;
    this.lastMs = performance.now() - t0;
  }

  /**
   * The nearest suburb label node. A linear scan over 94 points, every 3 s.
   *
   * Nearest-node is not a boundary test and cannot be made into one: OSM's
   * `place=suburb` node is where a renderer draws the suburb's *name*, roughly
   * its centre of mass, so this is right in the middle of a suburb and a coin
   * toss in a band along every boundary. At King Street and Carillon Avenue --
   * which sits on the Newtown/Darlington/Camperdown tri-point -- it says
   * Darlington, and Darlington is 440 m away while Newtown is 930.
   *
   * The fix is the admin boundary polygons, which OSM has for Sydney as
   * `admin_level=10` relations; they are hundreds of way members each, which is
   * a pipeline pass to assemble and a point-in-polygon test here, against the
   * 4.7 kB and one `Math.hypot` this costs. `pipeline/sydney/sources/osm.py`'s
   * `read_places` says the same thing from the other end and is where that
   * would start.
   */
  private nearestSuburb(x: number, z: number): string | null {
    let best: string | null = null;
    let best2 = Infinity;
    for (const s of this.suburbs) {
      const dx = s.x - x;
      const dz = s.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) {
        best2 = d2;
        best = s.name;
      }
    }
    return best;
  }

  /**
   * The line itself.
   *
   * Three forms, and the rule for each is about how much room there is:
   *
   *   * one street -- **full name**, because there is room and because the full
   *     name is how the address is written: `King Street, Newtown`;
   *   * a corner -- **both abbreviated**, because two names plus a suburb is the
   *     only form in this feature where width is actually scarce:
   *     `cnr King St & Carillon Ave, Newtown`. Swept over the inner ring, a
   *     single-street line is 26 characters at the median and a corner is 40
   *     against the ~30 the strip fits on a line -- the abbreviation is what
   *     keeps the corner inside the two lines `#locator` clamps to;
   *   * no street within `SEARCH_M` -- the suburb alone, which is the honest
   *     answer in the middle of a block, in a park or on the water.
   *
   * The suburb is always last and always comma-separated, so the line has one
   * shape whatever is in it and a player reads the end of it for place without
   * having to parse the front.
   *
   * **The pair's order is held, and that is the second half of the hysteresis.**
   * The corner *state* latches, but which of the two streets is nearer does not
   * -- crossing a junction swaps it, and near the crossing it swaps on
   * centimetres. Without this, walking through King Street and Carillon Avenue
   * reads `cnr City Rd & Carillon Ave`, then `cnr Carillon Ave & City Rd`, then
   * back, which is the same line rewriting itself for no reason a player can
   * see. So a corner naming the same *pair* as the last one keeps the order the
   * last one used; a corner naming a different pair takes the nearest first,
   * which is the street you are standing on. Measured on the walk through that
   * junction it takes the line from six changes over twenty metres to four, and
   * every one of the four is a real change of street.
   */
  private compose(): void {
    const r = this.readout;
    r.suburb = this.suburbName;
    const place = this.suburbName;
    let head: string;
    if (r.street !== null && r.cross !== null) {
      let a = r.street;
      let b = r.cross;
      if (a === this.shownB && b === this.shownA) {
        a = this.shownA;
        b = this.shownB;
      }
      this.shownA = a;
      this.shownB = b;
      head = `cnr ${abbreviateStreet(a)} & ${abbreviateStreet(b)}`;
    } else {
      this.shownA = null;
      this.shownB = null;
      head = r.street ?? '';
    }
    r.text = head === '' ? (place ?? '') : place === null ? head : `${head}, ${place}`;
  }

  /**
   * Force an evaluation at a point, ignoring both clocks and the still-player
   * skip. For the self-check below and for `window.sydney` -- it is the only
   * way to ask "what would this say over there" without teleporting.
   */
  evaluateAt(x: number, z: number): Readonly<Readout> {
    this.lastX = x;
    this.lastZ = z;
    this.suburbName = this.nearestSuburb(x, z);
    this.project(x, z);
    this.compose();
    return this.readout;
  }

  /** What the last evaluation cost and what it looked at, for `window.sydney`. */
  stats(): {
    text: string;
    street: string | null;
    cross: string | null;
    suburb: string | null;
    distanceM: number;
    atCorner: boolean;
    segments: number;
    suburbs: number;
    evaluations: number;
    lastMs: number;
    hz: number;
    searchM: number;
    cornerGapM: number;
    cornerNearM: number;
    hysteresisM: number;
  } {
    return {
      text: this.readout.text,
      street: this.readout.street,
      cross: this.readout.cross,
      suburb: this.readout.suburb,
      distanceM: Math.round(this.readout.distance * 100) / 100,
      atCorner: this.atCorner,
      segments: this.lastSegments,
      suburbs: this.suburbs.length,
      evaluations: this.evaluations,
      lastMs: Math.round(this.lastMs * 1000) / 1000,
      hz: 1 / STREET_INTERVAL,
      searchM: SEARCH_M,
      cornerGapM: CORNER_GAP_M,
      cornerNearM: CORNER_NEAR_M,
      hysteresisM: CORNER_HYST_M,
    };
  }
}

// --- Self-check ---------------------------------------------------------------

/** A straight run of one street, as a segment the locator will accept. */
function straightSegment(
  name: string,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): NamedSegment {
  return {
    name,
    points: new Float32Array([x0, z0, x1, z1]),
    minX: Math.min(x0, x1),
    minZ: Math.min(z0, z1),
    maxX: Math.max(x0, x1),
    maxZ: Math.max(z0, z1),
  };
}

/**
 * The locator, against a crossroads it is handed rather than a city.
 *
 * On this project's own criterion for what earns a self-check: every failure
 * here is silent. The strip renders, nothing throws, and the line under the map
 * is a plausible street name -- it is simply the *wrong* one, or the right one
 * flickering, and there is no frame that says so. Four of them specifically:
 *
 *   * a **sign error in the projection**, which names the street behind you.
 *     A clamp dropped from the segment parameter is the same class of bug and
 *     names a street a hundred metres past the end of a way, which in a city of
 *     block-length ways is most of them;
 *   * the **corner rule read as two distance tests** rather than as a gap,
 *     which fires halfway down every block with a lane off it -- see the header;
 *   * the **hysteresis inverted**, which is worse than absent: it would make the
 *     readout harder to enter *and* harder to leave the corner state, so it
 *     would oscillate at both edges instead of one;
 *   * **the same street named twice** -- "cnr Crown St & Crown St" -- which is
 *     what a nearest-two over runs rather than over distinct names produces, and
 *     which happens at every corner of every street OSM splits per block, i.e.
 *     all of them.
 *
 * Built on a synthetic crossroads so the distances are exact and the assertions
 * are about the rule rather than about Sydney: King Street runs north-south
 * through the origin, Carillon Avenue runs east-west through it, and Crown
 * Street is deliberately delivered as two separate runs of the same name.
 */
export function verifyLocator(): string[] {
  const failures: string[] = [];

  const segments: NamedSegment[] = [
    // Through the origin, north-south. World z is south, so this runs 'up' the
    // map from z = -100 to z = 100.
    straightSegment('King Street', 0, -100, 0, 100),
    // Through the origin, east-west.
    straightSegment('Carillon Avenue', -100, 0, 100, 0),
    // The same street as two runs meeting at z = -30, which is how OSM splits a
    // street per block and how the pipeline clips one to a tile.
    straightSegment('Crown Street', 40, -100, 40, -30),
    straightSegment('Crown Street', 40, -30, 40, 100),
    // A short stub that does not reach the query point in the clamp test below,
    // but whose infinite line passes 5 m from it.
    straightSegment('Foley Street', 20, -60, 20, -40),
  ];
  const source: StreetSource = {
    namedStreetsNear(x, z, radius, out) {
      out.length = 0;
      const r2 = radius * radius;
      for (const seg of segments) {
        const dx = Math.max(seg.minX - x, 0, x - seg.maxX);
        const dz = Math.max(seg.minZ - z, 0, z - seg.maxZ);
        if (dx * dx + dz * dz <= r2) out.push(seg);
      }
      return out;
    },
  };
  const loc = new Locator(source);

  // --- Mid-block: one street, the near one, and no corner.
  {
    const r = loc.evaluateAt(6, -30);
    if (r.street !== 'King Street') {
      failures.push(
        `6 m east of King Street and 30 m up it, the locator said ${JSON.stringify(r.street)}.` +
          ' A point beside a street must name that street.',
      );
    }
    if (r.cross !== null) {
      failures.push(
        `30 m from the junction the locator still called it a corner with ${JSON.stringify(r.cross)}.` +
          ` The gap there is ~24 m against a ${CORNER_GAP_M} m rule.`,
      );
    }
    if (Math.abs(r.distance - 6) > 1e-3) {
      failures.push(
        `Distance to a street 6 m away came out as ${r.distance.toFixed(3)} m.` +
          ' The projection is clamped per segment; this is the clamp or the sign.',
      );
    }
  }

  // --- Past the end of a run: the clamp, which is the projection's one trap.
  //
  // (25, -20) is 5 m from the *line* through Foley Street's stub and 20.6 m from
  // the stub itself, because the stub stops 20 m short. Crown Street is 15 m
  // away and is the right answer. Drop the clamp on the segment parameter and
  // Foley wins at 5 m -- a street the player is nowhere near, named confidently.
  // In a city of block-length ways that failure is not an edge case, it is every
  // block.
  {
    const r = loc.evaluateAt(25, -20);
    if (r.street !== 'Crown Street') {
      failures.push(
        `20.6 m from the end of Foley Street and 15 m from Crown Street, the locator named` +
          ` ${JSON.stringify(r.street)}. Distance must be to the segment, not to the infinite` +
          ' line through it -- the clamp is missing.',
      );
    }
    if (Math.abs(r.distance - 15) > 1e-3) {
      failures.push(`That distance came out as ${r.distance.toFixed(3)} m rather than 15.`);
    }
  }

  // --- On the corner: both names, and the near one first.
  {
    const r = loc.evaluateAt(2, 2);
    if (r.street !== 'King Street' && r.street !== 'Carillon Avenue') {
      failures.push(`On the crossroads the locator named ${JSON.stringify(r.street)}.`);
    }
    if (r.cross === null) {
      failures.push(
        'Standing 2 m from both centrelines of a crossroads did not read as a corner.' +
          ` The gap is 0 m against a ${CORNER_GAP_M} m rule.`,
      );
    }
    if (r.street === r.cross) {
      failures.push('A corner named the same street twice.');
    }
    if (!r.text.startsWith('cnr ') || !r.text.includes(' & ')) {
      failures.push(`A corner composed as ${JSON.stringify(r.text)} rather than 'cnr A & B'.`);
    }
    // The abbreviation only fires in the corner form.
    if (!r.text.includes('King St') || r.text.includes('King Street')) {
      failures.push(
        `The corner form did not abbreviate the road type: ${JSON.stringify(r.text)}.`,
      );
    }
  }

  // --- Ten metres down one leg: the corner drops, which is the user's own test.
  {
    const r = loc.evaluateAt(0.5, 12);
    if (r.street !== 'King Street') {
      failures.push(`12 m down King Street the locator named ${JSON.stringify(r.street)}.`);
    }
    if (r.cross !== null) {
      failures.push(
        `12 m down one leg of a crossroads still read as a corner with ${JSON.stringify(r.cross)}.` +
          ` The gap there is ~11.5 m against ${CORNER_GAP_M} + ${CORNER_HYST_M} m of hysteresis.`,
      );
    }
    // And the single-street form keeps the full name.
    if (r.text !== 'King Street') {
      failures.push(
        `A single street composed as ${JSON.stringify(r.text)}; the long form is the point of` +
          ' the sidecar carrying unabbreviated names.',
      );
    }
  }

  // --- The hysteresis, in the direction it exists for.
  //
  // A point where the gap is between the two thresholds. Entering from a
  // mid-block reading it must NOT latch; entering from a corner reading it must
  // hold. Same point, opposite answers, which is the whole of what hysteresis
  // means and is not testable one call at a time.
  {
    // On King Street, at the z where Carillon is 3.8 m further away: gap = 3.8,
    // which is above CORNER_GAP_M (3) and below CORNER_GAP_M + CORNER_HYST_M
    // (4.5).
    const x = 0;
    const z = 3.8;
    loc.evaluateAt(0.5, 40); // mid-block first: not a corner
    const entering = loc.evaluateAt(x, z);
    if (entering.cross !== null) {
      failures.push(
        `Arriving from mid-block, a ${z} m gap latched the corner. The enter threshold is` +
          ` ${CORNER_GAP_M} m and this is above it.`,
      );
    }
    loc.evaluateAt(0, 0); // on the corner: a corner
    const leaving = loc.evaluateAt(x, z);
    if (leaving.cross === null) {
      failures.push(
        `Leaving a corner, a ${z} m gap dropped it immediately. The leave threshold is` +
          ` ${CORNER_GAP_M + CORNER_HYST_M} m -- the hysteresis is absent or inverted.`,
      );
    }
  }

  // --- One street split into two runs is one street, never a corner with itself.
  //
  // (38, -30) is 2 m from the point where Crown Street's two runs meet, so it is
  // 2 m from *both* of them. A nearest-two over runs rather than over distinct
  // names reads a gap of zero there and composes 'cnr Crown St & Crown St'.
  // Every corner of every street OSM splits per block is that point, which is
  // all of them.
  {
    const r = loc.evaluateAt(38, -30);
    if (r.street !== 'Crown Street') {
      failures.push(`2 m from Crown Street the locator named ${JSON.stringify(r.street)}.`);
    }
    if (r.cross === 'Crown Street') {
      failures.push(
        'Two runs of the same street were read as a corner with itself. The reduction to one' +
          ' distance per distinct name is missing.',
      );
    }
  }

  // --- Out in the middle of a block: no street at all, rather than a far one.
  {
    const r = loc.evaluateAt(0, 200);
    if (r.street !== null) {
      failures.push(
        `100 m from every street the locator named ${JSON.stringify(r.street)};` +
          ` the search radius is ${SEARCH_M} m.`,
      );
    }
    if (r.text !== '') {
      failures.push(
        `With no street and no suburb the readout was ${JSON.stringify(r.text)} rather than empty.`,
      );
    }
  }

  // --- The pair's order holds while the pair does, and resets when it changes.
  {
    // Approach along Carillon Avenue so it is the nearer of the two, which
    // fixes the order as 'Carillon Ave & King St'.
    loc.evaluateAt(3, 0.5);
    const first = loc.current.text;
    if (!first.startsWith('cnr Carillon Ave & King St')) {
      failures.push(`Approaching along Carillon Avenue composed ${JSON.stringify(first)}.`);
    }
    // Now step across so King Street is nearer. The pair has not changed, so
    // the line must not either.
    const held = loc.evaluateAt(0.5, 3).text;
    if (held !== first) {
      failures.push(
        `Crossing the junction rewrote the same pair as ${JSON.stringify(held)}.` +
          ' The order is held while the pair is -- otherwise the line swaps itself on' +
          ' centimetres of movement at every corner.',
      );
    }
    // A different pair does re-order, nearest first.
    loc.evaluateAt(0, 200);
    const fresh = loc.evaluateAt(0.5, 3).text;
    if (!fresh.startsWith('cnr King St & Carillon Ave')) {
      failures.push(
        `A corner seen fresh composed ${JSON.stringify(fresh)} rather than nearest-first.`,
      );
    }
  }

  // --- The abbreviation table's two refusals.
  if (abbreviateStreet('Broadway') !== 'Broadway') {
    failures.push("A one-word name was abbreviated: 'Broadway' became" +
      ` ${JSON.stringify(abbreviateStreet('Broadway'))}.`);
  }
  if (abbreviateStreet('Missenden Road') !== 'Missenden Rd') {
    failures.push(
      `'Missenden Road' abbreviated to ${JSON.stringify(abbreviateStreet('Missenden Road'))}.`,
    );
  }

  return failures;
}
