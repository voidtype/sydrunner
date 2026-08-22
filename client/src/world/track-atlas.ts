/**
 * How much of the corridor a track may believe it owns.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT. `RAIL-CORRIDOR.md` is the design; this is its first idea.
 *
 *   > *"i think part of it is that adjascent tracks' assets overlay other
 *   > tracks"*
 *
 * Every writer in `world/rail-geo.ts` builds at a fixed lateral offset from the
 * polyline it is drawing: ballast to 3.3 m, cess to 3.15, masts at 3.15, fence
 * at 6.4, platform 1.62 to 7.12. **None of them can see that another running
 * line is four metres away.** Measured on the shipped bake, the nearest parallel
 * track is at a median of 4.05 m, and a car body is 3.1 m wide -- so a
 * neighbour's train sweeps the band 2.4 to 5.6 m out from our centreline, and
 * every one of those writers is inside it. The foul is not a bug at a station or
 * on a curve. It is guaranteed by construction, everywhere, and has been since
 * the first offset was written down.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ATLAS IS GLOBAL, AND WHY THAT IS NOT AN OPTIMISATION.
 *
 * A track's nearest neighbour is routinely in the next chunk. Two chunks that
 * each computed adjacency over their own contents would answer differently for
 * the same metre of railway -- one seeing the neighbour, one not -- and the
 * geometry either side of the seam would be built to two different budgets. That
 * is `rail-cut.ts`'s header restated one level up: the hole and the thing that
 * fills it must come from one function, and here the two things that must agree
 * are two chunks. So the atlas is computed once over the whole bake, before any
 * chunk exists, and a chunk only ever *reads* it.
 *
 * ---------------------------------------------------------------------------
 * THREE FACTS PER VERTEX, AND WHY EACH ONE IS NEEDED.
 *
 * **1. Who owns this alignment.** A line is a *service pattern*, not a pair of
 * rails. Where OSM mapped one way for both directions -- 137 samples on Central
 * Coast & Newcastle -- two direction polylines lie on top of each other, within
 * half a metre, and today both draw a full set of ballast, sleepers, masts and
 * fences into the same space. Doubled geometry, z-fighting, and twice the
 * triangles for one railway. `owner` names the lowest-ranked direction on an
 * alignment and every other one draws nothing there, which is a saving before it
 * is a fix.
 *
 * **2. How far to the nearest *other* physical track, each side.** The number
 * `corridorBudget` divides. Stored per vertex rather than solved per query
 * because it is asked once per rib per side by six writers, and because a value
 * that is looked up cannot drift between two of them.
 *
 * **3. Which corridor this belongs to.** Slots -- `RAIL-CORRIDOR.md`'s third
 * idea -- are gaps *between* the tracks of one corridor, so something has to say
 * which tracks are in it. Transitive within 20 m and parallel, which is the same
 * closure `STATIONS.md`'s formation grouping arrived at for the same reason: two
 * tracks that both claim a piece of ground would have had to be one corridor.
 *
 * ---------------------------------------------------------------------------
 * THE PARALLELISM TEST IS LOAD-BEARING AND IS NOT A TIDINESS RULE. Two
 * directions fifteen metres apart on *diverging* service paths are not
 * neighbours; a junction where a branch peels away is not a four-track corridor
 * and must not budget as one, or a platform would be refused at every station
 * with a turnout in it. `PARALLEL_COS` is the same 0.94 -- about twenty degrees
 * -- that `rail-solids.markCorridorEdges` already uses to tell a second road
 * from a crossing, and it is the same number for the same reason.
 *
 * ---------------------------------------------------------------------------
 * **Three-free, and it imports only the bake's shape.** `server/world.ts` has to
 * be able to answer where a platform is, and a platform's position now depends on
 * the budget, so the budget has to exist in a process with no renderer. Same
 * argument as `rail-cut.ts` and `rail-solids.ts`, one layer earlier.
 */

import { SPAN_TUNNEL } from '../game/rail.ts';

/**
 * What the atlas needs from the bake, structurally.
 *
 * A `RailBake` satisfies it, and so does a dozen lines of synthetic railway --
 * which is the point. `verifyTrackAtlas` builds four cases whose right answers
 * are known by construction (a coincident pair, a 4 m pair, a crossing, a lone
 * track) and runs the real builder over them. A self-check that could only be
 * run against the shipped bake could only ever say *"the same as last time"*.
 */
export interface AtlasBake {
  vertices: Float32Array;
  vertexFlags: Uint8Array;
  lines: ReadonlyArray<{ dirs: ReadonlyArray<{ vertexOff: number; vertexCount: number }> }>;
}

/**
 * How close two polylines have to be before they are **the same rails**, metres.
 *
 * A metre and a half. Real adjacent tracks are 3.2 m apart at the very tightest
 * -- the p5 of the measured distribution -- and a pair of OSM ways digitised for
 * one physical alignment differ by the width of a mapper's mouse, which is tens
 * of centimetres. There is nothing in the distribution between 0.5 m and 3.2 m,
 * so this threshold sits in an empty band rather than cutting through a
 * population, and that is the only property that makes it safe.
 */
export const COINCIDENT_M = 1.5;

/** How near two tracks must be to share a corridor, metres. */
export const CORRIDOR_M = 20;

/** And how parallel. About twenty degrees. See the header. */
export const PARALLEL_COS = 0.94;

/**
 * How much clear air a track leaves between what it builds and the midpoint of
 * the gap to its neighbour, metres.
 *
 * The budget is half the gap **less this**, so two neighbouring tracks that both
 * build to their budget leave twice this between them. Twenty-five centimetres
 * each: enough that two swept ribbons on curving track do not touch where the
 * spacing narrows between two stored vertices, and small enough that at the
 * measured 4.05 m median a track still gets 1.78 m of its own -- which is more
 * than the 1.625 m the structure gauge needs and is therefore the difference
 * between a corridor that can be built in at all and one that cannot.
 */
export const BUDGET_MARGIN_M = 0.25;

/**
 * What a track may build on a side with **no** neighbour, metres.
 *
 * `rail-cut.STATION_HALF_WIDTH`, deliberately: the outside edge of a corridor is
 * where a platform and its access already go, the carve already opens to that
 * width there, and a budget that answered anything else would be a second
 * opinion about the same edge. Beyond it the writers have their own limits and
 * this stops being the binding constraint.
 */
export const EDGE_BUDGET_M = 9.4;

/**
 * Every direction vertex in the bake, told what it is allowed to be.
 *
 * Parallel arrays over `bake.vertices`, so a reader that has a vertex index has
 * every answer in three loads and no search.
 */
export interface TrackAtlas {
  /**
   * The vertex that owns this alignment, or the vertex's own index.
   *
   * `owner[v] === v` is *"draw here"*. Anything else is a follower: a second
   * service's polyline lying on the first's rails, whose geometry the owner has
   * already written. The value is the owning **vertex**, not the owning
   * direction, because two services share an alignment for part of their length
   * and part is the interesting part.
   */
  owner: Int32Array;
  /** Distance to the nearest other physical track on the `-1` side, metres. */
  gapLeft: Float32Array;
  /** ...and on the `+1` side. `Infinity` where the corridor's edge is. */
  gapRight: Float32Array;
  /**
   * How many physical tracks run parallel through this point, including this
   * one.
   *
   * ---------------------------------------------------------------------------
   * **A count here, not a corridor id, and the first draft of this file got that
   * wrong in a way worth recording.** `RAIL-CORRIDOR.md` calls for tracks
   * "grouped into corridors", and the obvious reading is a global partition:
   * union two directions wherever they run together, and every track gets a
   * corridor number. Run it and **the whole of Sydney comes out as one
   * corridor** -- twenty-two directions, one id -- because the relation is
   * transitive and the network is connected. The doc names this trap for
   * junctions and it is worse than that: it is unconditional.
   *
   * A corridor is not a global object. It is *how many roads are beside you,
   * here*, and that is local, well defined and exactly what a slot needs. So the
   * atlas stores the count and the ordinal below, and there is no partition at
   * all.
   */
  corridorTracks: Uint8Array;
  /**
   * Where this track sits across that corridor: 0 is the `-1`-most road.
   *
   * With the count above this says *"the third of four"*, which is the whole
   * input a slot assignment needs -- an edge track can carry a side platform,
   * an interior pair can share an island -- and it is the thing a hand-authored
   * schematic overrides.
   */
  corridorOrdinal: Uint8Array;
  /** How many vertices are owners: the count of physical track the world has. */
  ownedVertices: number;
  /** How many are followers: the doubled geometry today's build draws. */
  followerVertices: number;
  /** The widest corridor anywhere: the most parallel roads at one point. */
  widestCorridor: number;
  /** What the build cost, milliseconds. Printed at boot beside `buildNetwork`'s. */
  buildMs: number;
}

/**
 * How far this track may build on this side, here.
 *
 * **The one answer, and the reason it is a function of a vertex rather than of a
 * point**: a writer draws a rib at a vertex and a panel between two ribs, so a
 * budget sampled anywhere else would be a third opinion about the same panel.
 * Between two vertices a caller interpolates its own two answers, which is what
 * the geometry does with every other quantity it sweeps.
 *
 * `side` is `-1` or `+1` in the `(-uz, ux)` frame every writer here uses.
 */
export function corridorBudget(atlas: TrackAtlas, v: number, side: number): number {
  const gap = side < 0 ? atlas.gapLeft[v] : atlas.gapRight[v];
  if (!Number.isFinite(gap)) return EDGE_BUDGET_M;
  const half = gap / 2 - BUDGET_MARGIN_M;
  return half > 0 ? half : 0;
}

/** Is this vertex the one that draws its alignment? See `TrackAtlas.owner`. */
export function ownsAlignment(atlas: TrackAtlas, v: number): boolean {
  return atlas.owner[v] === v;
}

/**
 * The budget a **run** of track gets on one side: the worst of it, over the run.
 *
 * ---------------------------------------------------------------------------
 * **The worst and not the average, and the difference is the whole bug at
 * Wollstonecraft.** A platform is one object 160 m long, so it is either clear
 * of the neighbouring train for its whole length or it is not clear at all. A
 * mean would let the middle of a platform be legal because its two ends have
 * room, which is exactly the geometry that fails: two tracks converging through
 * a station have plenty of space at one end and none at the other, and the
 * offending forty metres is what the owner rides through.
 *
 * `v0` and `v1` are vertex indices on one direction's polyline, inclusive. A run
 * that covers no vertex at all -- a short platform between two distant vertices
 * -- answers from the nearer of them, because a stretch of track with no vertex
 * in it is straight and its neighbour distance does not change along it.
 */
export function runBudget(atlas: TrackAtlas, v0: number, v1: number, side: number): number {
  let worst = Infinity;
  for (let v = v0; v <= v1; v++) {
    const b = corridorBudget(atlas, v, side);
    if (b < worst) worst = b;
  }
  return Number.isFinite(worst) ? worst : corridorBudget(atlas, v0, side);
}

const CELL_M = 32;
const cellKey = (cx: number, cz: number): number => (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);

/**
 * The atlas for a bake, built once however many callers ask.
 *
 * ---------------------------------------------------------------------------
 * **A cache, and it is here for correctness before it is here for the 90 ms.**
 * Three separate things need the atlas -- `rail-solids.buildNetwork`, which
 * gives it to the writers; `riding.buildPlatforms`, which gives it to the field
 * both ends stand on; and `world/corridor.ts` -- and they are constructed in a
 * different order in `main.ts`, in `server/world.ts` and in the checks. Passing
 * it between them would make that order a thing somebody has to get right, and
 * two of them building their own would put a platform's drawn edge and its
 * standable edge on two objects that merely happen to agree.
 *
 * Keyed on the bake by identity, so a process that loads a second bake -- which
 * `perf-harness.ts` and the checks do -- gets a second atlas rather than the
 * first one's answers about somebody else's railway.
 */
const cache = new WeakMap<object, TrackAtlas>();

export function atlasFor(bake: AtlasBake): TrackAtlas {
  const hit = cache.get(bake);
  if (hit !== undefined) return hit;
  const built = buildTrackAtlas(bake);
  cache.set(bake, built);
  return built;
}

/**
 * Build the atlas. One pass at decode, and the only pass.
 *
 * The broad phase files every polyline **edge** -- not vertex -- into every cell
 * its bounding box grown by `CORRIDOR_M` touches, so a query at a vertex reads
 * one cell and finds every edge that could possibly be within reach of it. Same
 * construction and same containment argument as `rail-solids.markCorridorEdges`
 * and `rail-cut.RailCut`; three copies of it now exist and all three are hot
 * enough to want their own.
 */
export function buildTrackAtlas(bake: AtlasBake): TrackAtlas {
  const t0 = performance.now();
  const p = bake.vertices;
  const n = p.length / 3;
  const owner = new Int32Array(n);
  const gapLeft = new Float32Array(n).fill(Infinity);
  const gapRight = new Float32Array(n).fill(Infinity);
  const corridorTracks = new Uint8Array(n);
  const corridorOrdinal = new Uint8Array(n);

  // Per vertex: which direction it belongs to, as a rank, and the direction's
  // own unit tangent there. Both are wanted at every step below and neither is
  // cheap to recover from a bare vertex index.
  const rank = new Int32Array(n).fill(-1);
  const ux = new Float32Array(n);
  const uz = new Float32Array(n);
  const tunnel = new Uint8Array(n);
  /** `[vertexIndex]` per edge, and the edge's own direction. */
  const edgeV: number[] = [];

  let r = 0;
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const first = dir.vertexOff;
      const last = dir.vertexOff + dir.vertexCount - 1;
      for (let v = first; v <= last; v++) {
        rank[v] = r;
        tunnel[v] = (bake.vertexFlags[v] & SPAN_TUNNEL) !== 0 ? 1 : 0;
        // The tangent is the edge ahead, or the edge behind at the last vertex.
        const a = v < last ? v : v - 1;
        const dx = p[(a + 1) * 3] - p[a * 3];
        const dz = p[(a + 1) * 3 + 2] - p[a * 3 + 2];
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 1e-6) { ux[v] = dx / len; uz[v] = dz / len; }
        else { ux[v] = 1; uz[v] = 0; }
        if (v < last) edgeV.push(v);
      }
      r++;
    }
  }

  const cells = new Map<number, number[]>();
  for (const v of edgeV) {
    const ax = p[v * 3], az = p[v * 3 + 2];
    const bx = p[(v + 1) * 3], bz = p[(v + 1) * 3 + 2];
    const x0 = Math.floor((Math.min(ax, bx) - CORRIDOR_M) / CELL_M);
    const x1 = Math.floor((Math.max(ax, bx) + CORRIDOR_M) / CELL_M);
    const z0 = Math.floor((Math.min(az, bz) - CORRIDOR_M) / CELL_M);
    const z1 = Math.floor((Math.max(az, bz) + CORRIDOR_M) / CELL_M);
    // A concatenation seam between two directions is a single absurd edge across
    // the city; it would file into ten thousand cells and is not a railway.
    if ((x1 - x0) > 8 || (z1 - z0) > 8) continue;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        const l = cells.get(k);
        if (l) l.push(v);
        else cells.set(k, [v]);
      }
    }
  }

  /**
   * Walk every edge near a vertex, handing the visitor the nearest point on it,
   * that point's signed lateral offset in the vertex's own frame, and the edge's
   * direction rank. The one traversal all three facts are read from, so the
   * three cannot be computed over different neighbourhoods.
   */
  const eachNear = (
    v: number,
    visit: (otherV: number, otherRank: number, lateral: number, dist: number, par: number) => void,
  ): void => {
    const x = p[v * 3], z = p[v * 3 + 2];
    const list = cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (list === undefined) return;
    const px = -uz[v], pz = ux[v];
    for (const w of list) {
      if (rank[w] === rank[v]) continue;
      const ax = p[w * 3], az = p[w * 3 + 2];
      const bx = p[(w + 1) * 3], bz = p[(w + 1) * 3 + 2];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      let u = ((x - ax) * ex + (z - az) * ez) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u;
      const qz = az + ez * u;
      const dx = qx - x, dz = qz - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > CORRIDOR_M) continue;
      const el = Math.sqrt(len2);
      const par = Math.abs(ux[v] * (ex / el) + uz[v] * (ez / el));
      visit(w, rank[w], dx * px + dz * pz, dist, par);
    }
  };

  // --- 1. Ownership. The lowest-ranked direction on an alignment draws it.
  //
  // Resolved to a *vertex* and not to a direction, because two services share
  // rails over part of their length. The follower points at the coincident
  // vertex it found, so a reader that wants the geometry knows where it went.
  for (let v = 0; v < n; v++) {
    owner[v] = v;
    if (rank[v] < 0) continue;
    let bestRank = rank[v];
    let bestV = v;
    eachNear(v, (w, wr, _lat, dist, par) => {
      if (dist > COINCIDENT_M || par < PARALLEL_COS) return;
      // The nearer end of the coincident edge, so the follower names a real
      // vertex of the owning polyline rather than a point on one.
      const a = w;
      const b = w + 1;
      const da = Math.hypot(p[a * 3] - p[v * 3], p[a * 3 + 2] - p[v * 3 + 2]);
      const db = Math.hypot(p[b * 3] - p[v * 3], p[b * 3 + 2] - p[v * 3 + 2]);
      const at = da <= db ? a : b;
      if (wr < bestRank) { bestRank = wr; bestV = at; }
    });
    owner[v] = bestV;
  }

  // **And then flatten the chains, because one pass does not give one hop.** A
  // follower points at the nearest vertex of the lowest-ranked coincident
  // alignment, and *that* vertex may itself have found a lower rank a few metres
  // further on -- three ways in a triangle, or a shared alignment that ends
  // mid-edge. Measured on this bake: two vertices, both at a throat. Path
  // compression is the fix and the bound is the fix's own proof: rank is
  // strictly decreasing along a chain, so a chain cannot be longer than the
  // number of directions and cannot contain a cycle.
  for (let v = 0; v < n; v++) {
    let hops = 0;
    while (owner[v] !== owner[owner[v]] && hops++ < r) owner[v] = owner[owner[v]];
  }

  // --- 2. The cross-section here, and the two gaps that fall out of it.
  //
  // **One pass for both, because both are the same walk.** The gap is the
  // nearest distinct road each side and the cross-section is all of them, so
  // asking twice was 50 ms of the atlas's build for an answer the first walk
  // already had. Coincident edges are skipped throughout: they are this same
  // alignment wearing another service's number, and budgeting against your own
  // rails would give every shared track a budget of nothing. That is what the
  // ownership pass above buys, and why the two are in this order.
  //
  // The offsets are deduplicated at `COINCIDENT_M` so a shared alignment counts
  // as one road, and the ordinal is how many of them lie to the `-1` side.
  const lat: number[] = [];
  for (let v = 0; v < n; v++) {
    if (rank[v] < 0) continue;
    lat.length = 0;
    eachNear(v, (_w, _wr, lateral, dist, par) => {
      if (par < PARALLEL_COS || dist <= COINCIDENT_M) return;
      if (lateral < 0) { if (dist < gapLeft[v]) gapLeft[v] = dist; }
      else if (dist < gapRight[v]) gapRight[v] = dist;
      for (const o of lat) if (Math.abs(o - lateral) <= COINCIDENT_M) return;
      lat.push(lateral);
    });
    let before = 0;
    for (const o of lat) if (o < 0) before++;
    // Clamped at 255 because the field is a byte and a corridor with 255 roads
    // in it is a bug in the bake, not a railway.
    corridorTracks[v] = Math.min(255, lat.length + 1);
    corridorOrdinal[v] = Math.min(255, before);
  }

  let owned = 0;
  let followers = 0;
  let widest = 0;
  for (let v = 0; v < n; v++) {
    if (rank[v] < 0) continue;
    if (owner[v] === v) owned++;
    else followers++;
    if (corridorTracks[v] > widest) widest = corridorTracks[v];
  }

  return {
    owner, gapLeft, gapRight, corridorTracks, corridorOrdinal,
    ownedVertices: owned, followerVertices: followers,
    widestCorridor: widest,
    buildMs: performance.now() - t0,
  };
}

/**
 * The atlas over four railways whose answers are known by construction.
 *
 * ---------------------------------------------------------------------------
 * **Synthetic, and that is the whole value of it.** Running the builder over the
 * shipped bake and comparing the totals to last week's totals proves the file
 * has not changed; it cannot prove the file is right, because nobody knows what
 * the right answer for 27,645 vertices is. Here the right answer is written down
 * beside the input:
 *
 *   0. a lone track          -> owns itself, no neighbour, corridor of 1
 *   1. a coincident pair     -> the lower rank owns, the other follows
 *   2. a pair 4.0 m apart    -> both own, gap 4.0 each way, corridor of 2, and
 *                               a budget of 1.75 m -- which is 12 cm more than
 *                               the structure gauge needs, and is the entire
 *                               reason the corridor is buildable at all
 *   3. a crossing at 90 deg  -> neither is the other's neighbour at any distance
 *
 * Case 3 is the negative control and it is the one that matters: a parallelism
 * test that had been dropped would still pass 0, 1 and 2 and would then budget
 * every station with a turnout in it down to nothing.
 */
export function verifyTrackAtlas(): string[] {
  const bad: string[] = [];
  // Four separated railways, 2 km apart so no case can see another.
  const pts: number[] = [];
  const dirs: Array<{ vertexOff: number; vertexCount: number }> = [];
  const addWay = (x0: number, z0: number, dx: number, dz: number, n: number): void => {
    dirs.push({ vertexOff: pts.length / 3, vertexCount: n });
    for (let i = 0; i < n; i++) pts.push(x0 + dx * i, 0, z0 + dz * i);
  };
  addWay(0, 0, 20, 0, 6);              // 0: lone
  addWay(2000, 0, 20, 0, 6);           // 1: coincident pair, first
  addWay(2000, 0.4, 20, 0, 6);         // 1: ...and second, 0.4 m off
  addWay(4000, 0, 20, 0, 6);           // 2: parallel pair at 4 m
  addWay(4000, 4, 20, 0, 6);
  addWay(6000, 0, 20, 0, 6);           // 3: crossing
  addWay(6050, -50, 0, 20, 6);
  const bake: AtlasBake = {
    vertices: new Float32Array(pts),
    vertexFlags: new Uint8Array(pts.length / 3),
    lines: dirs.map((d) => ({ dirs: [d] })),
  };
  const a = buildTrackAtlas(bake);
  const at = (dirIndex: number, i: number): number => dirs[dirIndex].vertexOff + i;

  // 0. Alone.
  if (a.owner[at(0, 2)] !== at(0, 2)) bad.push('a track with nothing near it does not own itself');
  if (Number.isFinite(a.gapLeft[at(0, 2)]) || Number.isFinite(a.gapRight[at(0, 2)])) {
    bad.push('a track with nothing near it was given a neighbour');
  }
  if (a.corridorTracks[at(0, 2)] !== 1) {
    bad.push(`a lone track reads as ${a.corridorTracks[at(0, 2)]} roads across`);
  }

  // 1. Coincident: rank 1 owns, rank 2 follows, and the follower's owner is a
  // real vertex of the owning way.
  if (a.owner[at(1, 2)] !== at(1, 2)) bad.push('the lower-ranked of a coincident pair does not own the alignment');
  const follower = a.owner[at(2, 2)];
  if (follower === at(2, 2)) bad.push('the higher-ranked of a coincident pair still owns its own alignment');
  else if (follower < dirs[1].vertexOff || follower >= dirs[1].vertexOff + dirs[1].vertexCount) {
    bad.push('a follower points at a vertex outside the way that owns it');
  }
  // ...and neither budgets against the other, or a shared alignment would get
  // nothing. This is the ordering `buildTrackAtlas` step 2 depends on.
  if (Number.isFinite(a.gapLeft[at(1, 2)]) || Number.isFinite(a.gapRight[at(1, 2)])) {
    bad.push('a coincident alignment was counted as its own neighbour');
  }

  // 2. A real pair.
  const l = at(3, 2);
  const rr = at(4, 2);
  if (Math.abs(a.gapRight[l] - 4) > 0.01) bad.push(`a 4 m neighbour measured ${a.gapRight[l].toFixed(2)} m`);
  if (Math.abs(a.gapLeft[rr] - 4) > 0.01) bad.push(`the same neighbour measured ${a.gapLeft[rr].toFixed(2)} m the other way`);
  if (a.corridorTracks[l] !== 2 || a.corridorOrdinal[l] !== 0) {
    bad.push(`a pair reads as ${a.corridorTracks[l]} roads with the first at ordinal ${a.corridorOrdinal[l]}`);
  }
  if (a.corridorOrdinal[rr] !== 1) bad.push('the second road of a pair is not ordinal 1');
  const want = 4 / 2 - BUDGET_MARGIN_M;
  if (Math.abs(corridorBudget(a, l, 1) - want) > 1e-6) {
    bad.push(`the budget on a 4 m interior side is ${corridorBudget(a, l, 1).toFixed(3)} and should be ${want}`);
  }
  if (corridorBudget(a, l, -1) !== EDGE_BUDGET_M) bad.push('the budget on a corridor edge is not the edge allowance');

  // 3. The negative control: a crossing is not a neighbour.
  for (let i = 0; i < 6; i++) {
    const v = at(5, i);
    if (Number.isFinite(a.gapLeft[v]) || Number.isFinite(a.gapRight[v])) {
      bad.push('a track crossing at 90 degrees was budgeted against as a neighbour');
      break;
    }
  }

  return bad.concat(atlasFaults(a));
}

/**
 * The structural properties of a built atlas, asserted over the real one.
 *
 * Three, each of which failed at least once while this was written: ownership is
 * one hop (a chain means the rank comparison is not total, and two vertices on
 * this bake were exactly that); every stored gap is positive; and no track is
 * the Nth of fewer than N roads.
 */
export function atlasFaults(atlas: TrackAtlas): string[] {
  const bad: string[] = [];
  const n = atlas.owner.length;
  let chains = 0;
  let negative = 0;
  let stray = 0;
  for (let v = 0; v < n; v++) {
    const o = atlas.owner[v];
    if (o !== v && atlas.owner[o] !== o) chains++;
    if (atlas.gapLeft[v] <= 0 || atlas.gapRight[v] <= 0) negative++;
    if (atlas.corridorTracks[v] > 0 && atlas.corridorOrdinal[v] >= atlas.corridorTracks[v]) stray++;
  }
  if (chains > 0) {
    bad.push(
      `${chains} vertices follow an alignment whose owner is itself a follower. ` +
        `Ownership is by lowest rank and must therefore be one hop; a chain means the ` +
        `rank comparison in buildTrackAtlas is not total.`,
    );
  }
  if (negative > 0) bad.push(`${negative} vertices carry a non-positive neighbour gap`);
  if (stray > 0) bad.push(`${stray} vertices are the Nth of fewer than N roads across their corridor`);
  if (atlas.ownedVertices === 0) bad.push('the atlas says no vertex owns its own alignment');
  return bad;
}
