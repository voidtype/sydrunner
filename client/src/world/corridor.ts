/**
 * One assembly of the railway as vessels, built the same way on both ends.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND IS NOT SPLIT BETWEEN THE TWO CALLERS.
 *
 * A vessel is only worth having if the client and the server build the *same*
 * one. The whole argument of `STATIONS.md` is that a boundary has exactly one
 * definition; two processes each assembling a corridor from the bake by their
 * own route would be two definitions with a shared ancestor, which is how
 * `PlatformField` came to exist and what its header spends a page on.
 *
 * So the assembly is here, once, three-free, and `main.ts` and
 * `server/world.ts` both call it. What comes out is three things over one
 * definition:
 *
 *   - the **vessels**, closed solids, for whatever draws them;
 *   - a `SeamField`, which is what the terrain withholds ground to and
 *     triangulates against;
 *   - a `VesselField`, which is what a body's feet ask.
 *
 * ---------------------------------------------------------------------------
 * **THE THING THIS FOUND, WHICH IS SHIPPING TODAY.**
 *
 * `RailCut.setStations` opens the corridor out to 9.4 m through a platform, and
 * **the two ends seed it from different lists.** `main.ts` hands it
 * `rail-geo.buildNetwork().stations`; `server/world.ts` hands it
 * `riding.buildPlatforms().sites`, with a comment saying the two resolve *"the
 * same anchors from the same bake, which is what makes the two answers the same
 * number rather than two numbers that agree today"*.
 *
 * They are not the same list. Measured on this bake: 358 sites on the server,
 * 361 on the client, and the three extra are `buildNetwork`'s fallback for
 * stations *nothing calls at* -- a rail within 60 m of a platform the modelled
 * network never reaches. Sampled every 6 m along every platform in the city,
 * **87 of 29,479 points get a different half-width, by up to the full 4.00 m of
 * the flare.**
 *
 * Today that is nearly harmless: it is a carve on one end and a ground query on
 * the other, and nothing stands in the difference. It stops being harmless here.
 * The rim becomes the edge of the walkable world on both ends -- the terrain is
 * withheld to it and `VesselField` answers inside it -- so four metres of
 * disagreement is four metres of ground that exists on one end only, which is
 * the exact failure this design is for.
 *
 * So this file builds its **own** `RailCut` and seeds it from
 * `riding.buildPlatforms`, on both ends, from the same bake. Its own, rather
 * than the one either process already holds, because those feed the *old* path
 * and the flag being off must change nothing.
 */

import { buildPlatforms } from '../game/riding.ts';
import { SPAN_BRIDGE, SPAN_TUNNEL, type RailBake } from '../game/rail.ts';
import { RailCut, inTrench } from './rail-cut.ts';
import { Footprint, SeamField, latticeCuts, type Lattice } from './seam.ts';
import { VesselField, type FieldRun } from './vessel-field.ts';
import { buildCorridorVessel, type Rib, type SpinePoint, type Vessel } from './vessel.ts';

/**
 * How often the sweep re-reads the ground, metres.
 *
 * `rail-geo.TRENCH_STEP_M`, restated for the reason `vessel.ts`' constants are:
 * this module cannot import a renderer. Eight metres is what the trench walls
 * have always used, so a vessel and the wall it replaces sample the DEM in the
 * same places and there is nothing new to disagree about.
 */
export const CORRIDOR_STEP_M = 8;

/**
 * How nearly parallel two tracks must be to be one formation.
 *
 * `rail._track_counts.PARALLEL_COS` in the pipeline, the same ~20 degrees, and
 * deliberately the same number: the bake counts a block's companions with it to
 * decide a portal gantry from a cantilever mast, and a corridor that is one
 * formation for the overhead and two for the ground would be two opinions about
 * the same railway.
 */
export const FORMATION_COS = 0.94;

/**
 * How wide one formation may get, metres.
 *
 * Not a shape preference: a bound on how far the *transitive* rule below may
 * reach. A track is absorbed when its corridor overlaps the formation's, which
 * chains -- track A pulls in B, B's width pulls in C -- and without any stop the
 * chain has nothing in principle to keep it from running from Central to
 * Strathfield and sweeping one vessel over Chippendale.
 *
 * **Measured, it does not bind, and that is the point of reporting it.** Over the
 * whole extract the widest formation the rule produces is **89.8 m**, with a p99
 * of 58.7 m -- Redfern's ten roads and its platforms measure 58 m, and the
 * widest is Central's throat, which really is that wide. So a hundred metres is a
 * guard against a failure mode nobody has seen rather than a knob that decides
 * the answer, and where it fires the track is refused **by name** and counted,
 * never clamped. See `CorridorBuild.wide`, which is 0 m on this bake.
 *
 * It was 60 m in the first draft, on the reasoning that Redfern is the widest
 * railway in Sydney. That refused 15.3 km of track into formations of their own,
 * which then overlapped the ones that had refused them -- so a cap set to what
 * looked reasonable was itself generating the defect the phase is about.
 */
export const FORMATION_MAX_SPAN_M = 100;

/**
 * How fast the rim may close in on the tracks, metres out per metre along.
 *
 * A member that starts or ends mid-formation steps the span by its own width in
 * one rib, and a step is legal -- the sweep and the manifold check do not care.
 * It just is not what a railway looks like: a throat opens out over tens of
 * metres. So the span is dilated by a cone, which only ever *widens* it, so no
 * ground a track needs can be lost to the smoothing.
 */
export const FORMATION_FLARE = 0.25;

/**
 * How near a track has to come to the formation to count as overlapping it,
 * metres.
 *
 * **Not slop, and the number is derived rather than tuned.** The membership test
 * is "does this track's corridor overlap the formation's", and taken literally
 * it puts the split between two formations at the exact point where two rims
 * stop touching -- which is the least stable place in the whole construction. A
 * formation is sampled every `CORRIDOR_STEP_M`, so a point is assigned to a rib
 * up to half a step away along the run (4 m of lateral error on a bend), and the
 * cone above then widens both spans afterwards. Splitting where the gap is zero
 * means both of those act *into* the neighbour.
 *
 * So the split is made where there is real daylight instead. Absorbing a little
 * more than overlaps is always safe -- the formation's rim spans whatever it
 * absorbs, so no ground goes unclaimed -- and measured at Redfern it is the
 * difference between 1.2% of the claimed cells being claimed twice and **none**
 * of them.
 */
export const FORMATION_MARGIN_M = 5;

/**
 * How far apart in height two tracks may be and still be one formation, metres.
 *
 * **A formation has one floor, so it has one level** -- `RAIL-VERTICAL.md` §1 in
 * its own terms: not a label, but `trackY(a) - trackY(b)` measured at the rib,
 * deciding the geometry rather than describing it. Without any such test the
 * rule "absorb whatever overlaps in plan" pulled tracks **6.14 m** apart into one
 * cutting at the Erskineville throat, which is the Illawarra flying over the
 * Main South and is not a cutting at all.
 *
 * The number is `envelope.RAIL_ABOVE_M`, restated here for the reason
 * `vessel.ts`' constants are restated: 5.9 m is a double-deck set, its pantograph
 * and the margin -- the height a railway needs clear over its own rail head. Two
 * tracks closer together than that **cannot** be one over the other, because the
 * upper one would be standing inside the lower one's envelope; so they are
 * side by side in one cutting on a gradient, however uneven the bake's cone
 * solve leaves them. Two tracks further apart than that are a **grade
 * separation** -- one ought to be a bridge or a bore, the bake does not always
 * say which (`RAIL-VERTICAL.md` §3 gives OSM that authority and §6 admits where
 * the data is silent), and they are swept as two formations, counted and named.
 * See `CorridorBuild.crossings`.
 *
 * Deriving it rather than picking it matters here: at a metre and a half, which
 * is what a cess and a cant suggest, Redfern's own roads come apart -- the bake
 * puts one of them 3 m above its neighbours -- and two formations end up
 * overlapping where there is one flat station.
 */
export const FORMATION_RISE_M = 5.9;

/** One run of corridor, and everything derived from it. */
export interface CorridorRun {
  vessel: Vessel;
  /** The sweep itself. See `world/vessel-field.ts` on why this is the authority. */
  ribs: readonly Rib[];
  spine: readonly SpinePoint[];
  /** Metres of centreline. */
  metres: number;
  /** Rim vertices the terrain lattice added. See `seam.latticeCuts`. */
  cuts: number;
  /** How many tracks this one vessel carries, at its widest. */
  tracks: number;
}

/** What one build produced, and what it refused. */
export interface CorridorBuild {
  runs: CorridorRun[];
  seam: SeamField;
  field: VesselField;
  /** Runs refused, with the reason. Junctions, mostly; see `STATIONS.md`. */
  refused: string[];
  /** Runs skipped because the DEM was not resident under them. */
  noTerrain: number;
  triangles: number;
  /** Track-metres that could not join the formation beside them. See `FORMATION_MAX_SPAN_M`. */
  wide: number;
  /** How many track runs went in, against how many formations came out. */
  tracks: number;
  /**
   * Lattice cells any formation claims, and how many of them more than one does.
   *
   * **The headline of Phase 3**, kept on the build rather than left to a check to
   * rediscover. Phase 2a measured 61.5% of the claimed cells at Erskineville
   * claimed by more than one run, because each track was its own vessel. What is
   * left is the grade separations -- see `crossings` -- and it is a number the
   * build can be asked for rather than a fact somebody has to go and measure.
   */
  claimedCells: number;
  doubleCells: number;
  /** Cells more than one formation claims **whole**. Ground owned twice. */
  doubleInside: number;
  /**
   * Where two formations still overlap, and by how much vertically.
   *
   * A formation is one level (`FORMATION_RISE_M`), so two formations overlapping
   * in plan is one railway crossing another -- a flyover or a dive. That is not
   * the defect this phase is about and it cannot be fixed by grouping: it needs
   * the *disposition* to change, a bridge or a bore, which is Phase 1's third
   * strain and is unbuilt. Named and counted rather than discovered.
   */
  crossings: string[];
}

/** Where the ground is. `NaN` for a tile this process does not hold. */
export type GroundAt = (x: number, z: number) => number;

/**
 * One strip of track, as the corridor needs it: two ends, a height at each, and
 * the union of the flags of every line that runs over it.
 */
interface Strip {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  flags: number;
}

/**
 * The bake's polylines, deduplicated into strips.
 *
 * `RailCut`'s constructor does exactly this and keeps the result private;
 * `rail-geo.buildNetwork` does it again and adds chunking, portals and station
 * placement, and imports three on the way. Neither is usable from here, so the
 * loop is repeated -- with the **same quarter-metre key and the same flag
 * union**, because a third opinion about which strips exist would put a vessel
 * where the carve has none.
 *
 * The flag union specifically, not first-wins: twenty stopping patterns run over
 * shared rails and the `subway` flag reaches a stretch of the Bankstown line on
 * the Metro's polyline while T3's copy of the same rail carries none. `RailCut`
 * learned that the expensive way and says so; this inherits the lesson rather
 * than the bug.
 */
export function corridorStrips(bake: RailBake): Strip[] {
  const p = bake.vertices;
  const vf = bake.vertexFlags;
  const q = (v: number): number => Math.round(v * 4);
  const seen = new Map<string, number>();
  const out: Strip[] = [];
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        const ax = p[i * 3];
        const ay = p[i * 3 + 1];
        const az = p[i * 3 + 2];
        const bx = p[(i + 1) * 3];
        const by = p[(i + 1) * 3 + 1];
        const bz = p[(i + 1) * 3 + 2];
        if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
        const forward = ax < bx || (ax === bx && az <= bz);
        const key = forward
          ? `${q(ax)},${q(ay)},${q(az)},${q(bx)},${q(by)},${q(bz)}`
          : `${q(bx)},${q(by)},${q(bz)},${q(ax)},${q(ay)},${q(az)}`;
        const at = seen.get(key);
        if (at !== undefined) {
          out[at].flags |= vf[i] | vf[i + 1];
          continue;
        }
        seen.set(key, out.length);
        out.push({ ax, ay, az, bx, by, bz, flags: vf[i] | vf[i + 1] });
      }
    }
  }
  return out;
}

/**
 * A `RailCut` that knows where the platforms are. Both ends, identically.
 *
 * See the header: with a vessel in the ground the flare stops being a fact about
 * the picture.
 */
export function corridorCut(bake: RailBake): RailCut {
  const cut = new RailCut(bake);
  cut.setStations(buildPlatforms(bake).sites);
  return cut;
}

/**
 * Is this strip one the corridor should put a trench in?
 *
 * `RailCut.probeAlong`'s own question, asked over the strip's own length. Kept
 * as a function rather than inlined so a caller can hand a different rule in --
 * `checkVessels` sweeps everything trenched in the extract, and a station build
 * will want everything trenched *near one station*.
 */
export function trenchedStrip(cut: RailCut, s: Strip, ground: GroundAt): boolean {
  if ((s.flags & (SPAN_BRIDGE | SPAN_TUNNEL)) !== 0) return false;
  return cut.probeAlong(s.ax, s.az, s.bx, s.bz, ground).trench;
}

/** A node of a chained run: a shared endpoint of two strips. */
interface Node {
  x: number;
  y: number;
  z: number;
}

/**
 * Strips chained into continuous runs.
 *
 * **Phase 1's one finding that changed the plan.** A closed vessel per segment
 * does not give a closed corridor: two abutting at a shared endpoint leave a
 * wedge on the outside of the bend, and over the 7,443 shared endpoints in the
 * extract 1,908 of them gap by more than half a metre. `writeTrench` survives
 * that by overlapping consecutive segments 0.5 m, which is available to a
 * surface and not to a solid.
 *
 * So the corridor is not cut up. A run is extended through a node onto whichever
 * unused strip continues most nearly **straight ahead**, and stops where nothing
 * does -- a portal, a bridge, the end of the cutting, or a branch that turns
 * harder than `CHAIN_STRAIGHT_COS`. The bend is **mitred** because the rib at
 * that node is one rib whose vertices both panels share by index. There is no
 * interior join to gap because there is no interior join.
 *
 * ---------------------------------------------------------------------------
 * **PHASE 3 CHANGED THE RULE AT A JUNCTION, AND MEASURED WHY.**
 *
 * Phase 2a stopped a run dead wherever more than two strips met. That is safe
 * and it is what produced the 22 refused runs and, less visibly, the residual
 * this phase went looking for: at Erskineville the corridor is *one* cutting and
 * the network breaks it at every throat, so eight runs came out where there is
 * one railway, and where two of them met end to end their two footprints
 * overlapped around the shared node. A formation cannot fix that, because the
 * formation rule is about tracks running *beside* each other and these run into
 * each other.
 *
 * So the run continues through the junction, on the branch that is straight
 * ahead. That is what a railway does -- the main line runs through and the
 * branch diverges -- and the straightness gate is what keeps it from being the
 * bug Phase 1 found, where the deduplicated network chained a run through a
 * crossover and reversed it. A reversal is a turn of 180 degrees and is refused
 * by the same test that lets a two-degree bend through.
 */
export const CHAIN_STRAIGHT_COS = 0.85;

export function chainRuns(strips: readonly Strip[]): Node[][] {
  const q = (v: number): number => Math.round(v * 4);
  const key = (x: number, z: number): string => `${q(x)},${q(z)}`;
  const at = new Map<string, Strip[]>();
  for (const s of strips) {
    for (const k of [key(s.ax, s.az), key(s.bx, s.bz)]) {
      const l = at.get(k);
      if (l) l.push(s);
      else at.set(k, [s]);
    }
  }
  const used = new Set<Strip>();
  /** A strip's unit plan direction, pointing **away** from the node keyed `k`. */
  const away = (s: Strip, k: string): [number, number] => {
    const fromA = key(s.ax, s.az) === k;
    const dx = fromA ? s.bx - s.ax : s.ax - s.bx;
    const dz = fromA ? s.bz - s.az : s.az - s.bz;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const step = (k: string, from: Strip): Strip | null => {
    const l = at.get(k);
    if (l === undefined) return null;
    // The direction the run arrives in, which is `from` pointing *into* the node.
    const [ix, iz] = away(from, k);
    let best: Strip | null = null;
    let bestDot = CHAIN_STRAIGHT_COS;
    for (const other of l) {
      if (other === from || used.has(other)) continue;
      const [ox, oz] = away(other, k);
      // `-i` is the run's heading through the node; `o` leaves along the branch.
      const dot = -ix * ox + -iz * oz;
      if (dot > bestDot) {
        bestDot = dot;
        best = other;
      }
    }
    return best;
  };
  const runs: Node[][] = [];
  for (const s of strips) {
    if (used.has(s)) continue;
    used.add(s);
    const pts: Node[] = [
      { x: s.ax, z: s.az, y: s.ay },
      { x: s.bx, z: s.bz, y: s.by },
    ];
    let cur = s;
    let k = key(s.bx, s.bz);
    for (;;) {
      const n = step(k, cur);
      if (n === null) break;
      used.add(n);
      const fromA = key(n.ax, n.az) === k;
      pts.push(fromA ? { x: n.bx, z: n.bz, y: n.by } : { x: n.ax, z: n.az, y: n.ay });
      k = fromA ? key(n.bx, n.bz) : key(n.ax, n.az);
      cur = n;
    }
    cur = s;
    k = key(s.ax, s.az);
    for (;;) {
      const n = step(k, cur);
      if (n === null) break;
      used.add(n);
      const fromB = key(n.bx, n.bz) === k;
      pts.unshift(fromB ? { x: n.ax, z: n.az, y: n.ay } : { x: n.bx, z: n.bz, y: n.by });
      k = fromB ? key(n.ax, n.az) : key(n.bx, n.bz);
      cur = n;
    }
    runs.push(pts);
  }
  return runs;
}

/**
 * One track, resampled every `CORRIDOR_STEP_M` and carrying its own frame and
 * half-width. The unit the grouping below moves around.
 *
 * Resampled **keeping its own vertices**, with the frame at each point taken
 * from its two neighbours. Keeping the vertices is the whole trick: a rib
 * sitting exactly on a network bend, with a direction averaged across it, is a
 * mitre.
 */
export interface TrackPoint {
  x: number;
  z: number;
  /** Rail head, as the bake interpolates it. */
  y: number;
  ux: number;
  uz: number;
  /** `RailCut.halfWidthAt` at this point. */
  half: number;
}

/** A track's centreline, resampled. */
export function trackForRun(pts: readonly Node[], cut: RailCut): TrackPoint[] | null {
  const raw: Node[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / CORRIDOR_STEP_M));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      raw.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (raw.length < 2) return null;
  const out: TrackPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const prev = raw[Math.max(0, i - 1)];
    const next = raw[Math.min(raw.length - 1, i + 1)];
    let ux = next.x - prev.x;
    let uz = next.z - prev.z;
    const l = Math.hypot(ux, uz);
    if (!(l > 1e-9)) return null;
    out.push({ x: p.x, z: p.z, y: p.y, ux: ux / l, uz: uz / l, half: cut.halfWidthAt(p.x, p.z) });
  }
  return out;
}

/** One rib of a formation: where it is, how far it reaches, and what it carries. */
export interface FormationPoint {
  x: number;
  z: number;
  ux: number;
  uz: number;
  /** The **lowest** rail head the formation carries here. The floor goes under it. */
  railY: number;
  /** How far the corridor reaches across, `[left, right]`, in the `(-uz, ux)` frame. */
  span: [number, number];
  /** How many tracks are in the formation here. */
  tracks: number;
  /** The spread of rail heights across those tracks, metres. */
  rise: number;
}

/** One formation: a run of cutting, and every track it carries. */
export interface Formation {
  pts: FormationPoint[];
  /** Metres of centreline. */
  metres: number;
  /** The widest it gets. */
  tracks: number;
  /** The worst spread of member rail heights, metres. One floor has to serve all of them. */
  rise: number;
}

/**
 * Every trenched track grouped into formations, one vessel's worth each.
 *
 * ---------------------------------------------------------------------------
 * **WHY THIS EXISTS, WHICH IS PHASE 2A'S THIRD FINDING.**
 *
 * Phase 2a swept one vessel per *track*, because each track in the bake is its
 * own polyline. Two running lines four metres apart with a 5.4 m half-width
 * occupy the same ground along their whole length, so **61.5% of the lattice
 * cells the railway claims at Erskineville were claimed by more than one run**,
 * 22% of them disagreeing about the surface by over three metres and the worst
 * by 9.36 m. The terrain side handled it exactly, by pooling the footprints.
 * The geometry side could not: where two runs' floors are at different depths
 * the shallower one's solid contains the deeper one's void, and its coping is
 * drawn as a strip of stone across an open cutting.
 *
 * No amount of per-vessel correctness fixes that, because every vessel is
 * individually right. **A four-track railway is one formation** -- one cutting,
 * one floor, two outer walls -- carrying four tracks, and it is not four
 * trenches that happen to overlap.
 *
 * ---------------------------------------------------------------------------
 * **THE RULE, WHICH IS THE ONE THAT MAKES THE FOOTPRINTS DISJOINT.**
 *
 * A track joins the formation beside it exactly where **its corridor overlaps
 * the formation's**. Not "where it is near", not "where it is parallel" -- those
 * are heuristics and would leave a residue nobody could bound. Overlap is the
 * condition the double-claim *is*, so making it the membership test makes the
 * claim disjoint by construction: two formations that both claim a piece of
 * ground would have had to be one formation.
 *
 * It is transitive, which is what makes a six-road corridor come out as one
 * object rather than three pairs, and transitivity is also what has to be
 * bounded -- see `FORMATION_MAX_SPAN_M`.
 *
 * A track that overlaps for part of its length is **split**, not rejected: the
 * covered part joins, the rest goes back in the pool and becomes (or joins)
 * another formation. That is what a junction throat is, and it terminates,
 * because every split strictly shortens something.
 *
 * ---------------------------------------------------------------------------
 * **WHAT DOES NOT NEED A TRANSITION RIB, AND THIS SURPRISED ME.**
 *
 * `STATIONS.md` scoped this phase expecting the transition rib to be what makes
 * a formation possible: *"a formation gains and loses tracks at throats and
 * junctions, so the profile must be able to change along the sweep."* It must,
 * and it does -- but the change is **dimensional, not topological**. A formation
 * that gains a fourth track gets a rim four metres further out; the cross-section
 * is the same eight-point `U` it was, and the sweep has moved a rim like that
 * since Phase 1, because that is what the platform flare is. The transition rib
 * is built (see `vessel.ts`) and is needed for the platform deck and the road
 * lid; it is not needed here, and saying so is cheaper than pretending.
 */
export function buildFormations(
  runs: readonly Node[][],
  cut: RailCut,
): { formations: Formation[]; wide: number; tracks: number } {
  const pool: TrackPoint[][] = [];
  for (const r of runs) {
    const t = trackForRun(r, cut);
    if (t !== null) pool.push(t);
  }
  const tracks = pool.length;
  const lengthOf = (t: readonly TrackPoint[]): number => {
    let m = 0;
    for (let i = 0; i < t.length - 1; i++) m += Math.hypot(t[i + 1].x - t[i].x, t[i + 1].z - t[i].z);
    return m;
  };
  pool.sort((a, b) => lengthOf(b) - lengthOf(a));

  const out: Formation[] = [];
  let wide = 0;
  /** A serial number per absorbed piece, so `tracks` counts tracks and not points. */
  let nextMember = 0;
  while (pool.length) {
    const spine = pool.shift()!;
    /** The formation, as ribs on the spine's own points. */
    const pts: FormationPoint[] = spine.map((p) => ({
      x: p.x, z: p.z, ux: p.ux, uz: p.uz,
      railY: p.y,
      span: [-p.half, p.half] as [number, number],
      tracks: 1,
      rise: 0,
    }));
    /** Which member tracks touch each rib, so `tracks` counts tracks and not points. */
    const at: Array<Set<number>> = pts.map(() => new Set([-1]));
    /** Rib lookup by plan cell, so absorbing does not rescan the spine per point. */
    const CELL = 32;
    const cells = new Map<number, number[]>();
    const key = (cx: number, cz: number): number => (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
    for (let i = 0; i < pts.length; i++) {
      const cx = Math.floor(pts[i].x / CELL);
      const cz = Math.floor(pts[i].z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(cx + dx, cz + dz);
          const l = cells.get(k);
          if (l) l.push(i);
          else cells.set(k, [i]);
        }
      }
    }
    /**
     * Which rib of the formation a point belongs to, and how far across it is,
     * or null where the point is not in this formation's corridor at all.
     *
     * The *nearest* rib, not a projection onto the polyline: a formation is
     * sampled every eight metres, so the nearest rib is within four metres along
     * and the lateral offset is what the answer turns on. Ends are excluded --
     * a track running past the end of the formation is beyond it, not beside it,
     * and absorbing it there would claim ground the sweep never covers.
     */
    const locate = (q: TrackPoint): { rib: number; d: number } | null => {
      const list = cells.get(key(Math.floor(q.x / CELL), Math.floor(q.z / CELL)));
      if (list === undefined) return null;
      let best = -1;
      let bestD2 = Infinity;
      for (const i of list) {
        const dx = q.x - pts[i].x;
        const dz = q.z - pts[i].z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      if (best < 0) return null;
      const p = pts[best];
      // Past the end rather than beside it: the nearest rib is a terminal one and
      // the point is on the outboard side of it.
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const along = dx * p.ux + dz * p.uz;
      if ((best === 0 && along < 0) || (best === pts.length - 1 && along > 0)) return null;
      if (Math.abs(q.ux * p.ux + q.uz * p.uz) < FORMATION_COS) return null;
      return { rib: best, d: dx * -p.uz + dz * p.ux };
    };
    /**
     * Does this point's corridor overlap what the formation already claims, at a
     * height one floor can serve?
     */
    const overlaps = (q: TrackPoint, hit: { rib: number; d: number }): boolean => {
      const p = pts[hit.rib];
      if (Math.abs(q.y - p.railY) > FORMATION_RISE_M) return false;
      const reach = q.half + FORMATION_MARGIN_M;
      return hit.d + reach > p.span[0] && hit.d - reach < p.span[1];
    };

    /**
     * The cone: how fast the rim may close in on the tracks.
     *
     * **Applied inside the fixpoint, not after it**, and that is not tidiness.
     * Coning only ever widens the span, so a span coned *after* membership was
     * settled reaches ground that was never offered to the overlap test -- which
     * at Redfern put two formations' rims a quarter of a metre inside each other
     * along their whole length, seven per cent of the claimed cells, for no
     * reason anybody could have found by reading the membership rule. Widen,
     * then re-offer, until nothing changes.
     */
    const cone = (): void => {
      for (let i = 1; i < pts.length; i++) {
        const step = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) * FORMATION_FLARE;
        pts[i].span[0] = Math.min(pts[i].span[0], pts[i - 1].span[0] + step);
        pts[i].span[1] = Math.max(pts[i].span[1], pts[i - 1].span[1] - step);
      }
      for (let i = pts.length - 2; i >= 0; i--) {
        const step = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) * FORMATION_FLARE;
        pts[i].span[0] = Math.min(pts[i].span[0], pts[i + 1].span[0] + step);
        pts[i].span[1] = Math.max(pts[i].span[1], pts[i + 1].span[1] - step);
      }
    };

    for (let pass = 0; ; pass++) {
      cone();
      let absorbed = false;
      for (let c = 0; c < pool.length; c++) {
        const cand = pool[c];
        const inside: boolean[] = new Array(cand.length);
        let any = false;
        for (let j = 0; j < cand.length; j++) {
          const hit = locate(cand[j]);
          inside[j] = hit !== null && overlaps(cand[j], hit);
          if (inside[j]) any = true;
        }
        if (!any) continue;
        // The longest contiguous stretch that belongs. The rest goes back in the
        // pool: a track that runs beside a formation and then leaves it is two
        // tracks as far as the ground is concerned, and pretending otherwise is
        // how one vessel ends up spanning a city block.
        let bi = 0;
        let bn = 0;
        for (let j = 0; j < cand.length; ) {
          if (!inside[j]) { j++; continue; }
          let k = j;
          while (k < cand.length && inside[k]) k++;
          if (k - j > bn) { bn = k - j; bi = j; }
          j = k;
        }
        if (bn < 2) continue;
        // Would taking it make the formation wider than a formation gets? Then it
        // is a junction fanning out, and it is refused rather than swallowed.
        let over = false;
        for (let j = bi; j < bi + bn; j++) {
          const hit = locate(cand[j])!;
          const s = pts[hit.rib].span;
          if (Math.max(s[1], hit.d + cand[j].half) - Math.min(s[0], hit.d - cand[j].half) > FORMATION_MAX_SPAN_M) {
            over = true;
            break;
          }
        }
        if (over) {
          wide += lengthOf(cand.slice(bi, bi + bn));
          continue;
        }
        const id = nextMember++;
        for (let j = bi; j < bi + bn; j++) {
          const q = cand[j];
          const hit = locate(q)!;
          const p = pts[hit.rib];
          if (hit.d - q.half < p.span[0]) p.span[0] = hit.d - q.half;
          if (hit.d + q.half > p.span[1]) p.span[1] = hit.d + q.half;
          const lo = Math.min(p.railY, q.y);
          p.rise = Math.max(p.rise, Math.abs(q.y - p.railY), p.railY - lo);
          p.railY = lo;
          at[hit.rib].add(id);
          p.tracks = at[hit.rib].size;
        }
        // What is left of the candidate goes back in the pool. A leftover of a
        // **single** point is dropped rather than kept, and it costs nothing to
        // drop: a piece of one point spans no segment, so it is zero metres of
        // centreline, and the half-step of track either side of it is inside the
        // neighbour's `FORMATION_MARGIN_M` (a half-step is 4 m, the margin is 5).
        // A one-point piece kept would be a track run `trackForRun` would refuse
        // anyway, and refusing it here says so where it happens.
        const rest: TrackPoint[][] = [];
        if (bi >= 2) rest.push(cand.slice(0, bi));
        if (cand.length - (bi + bn) >= 2) rest.push(cand.slice(bi + bn));
        pool.splice(c, 1, ...rest);
        c += rest.length - 1;
        absorbed = true;
      }
      if (!absorbed || pass > 8) break;
    }
    cone();

    // **Re-centred on the formation, not on the track that named it.**
    //
    // The spine is one of the tracks -- the longest -- so a six-road formation
    // has its rim 5.4 m out on one side and thirty on the other. The rim is the
    // same ground either way, but the *sweep* is not: a profile offset thirty
    // metres from a curving centreline reverses on a radius three times larger
    // than one offset fifteen, and a reversed sweep is a `FOLD` and a refusal.
    // Shifting the centreline to the middle of the span moves no rim vertex and
    // halves the worst offset.
    for (const p of pts) {
      const c = (p.span[0] + p.span[1]) / 2;
      p.x += -p.uz * c;
      p.z += p.ux * c;
      p.span[0] -= c;
      p.span[1] -= c;
    }
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-9) {
        pts[i].ux = dx / l;
        pts[i].uz = dz / l;
      }
    }

    let metres = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      metres += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    }
    let wideCount = 1;
    let rise = 0;
    for (const p of pts) {
      if (p.tracks > wideCount) wideCount = p.tracks;
      if (p.rise > rise) rise = p.rise;
    }
    out.push({ pts, metres, tracks: wideCount, rise });
  }
  return { formations: out, wide, tracks };
}

/**
 * One formation's spine, with the ground read at the rim it is about to place.
 *
 * The three measurements are the ones `writeTrench` makes, in the same places:
 * the rail head is the bake's own linear interpolation (the **lowest** of the
 * tracks the formation carries, because one floor has to be under all of them),
 * the reach is `RailCut.halfWidthAt` at every member's own centreline, and the
 * ground is the DEM sampled at the rim on each side separately. Returns null
 * where the DEM is not resident: a vessel built on a guessed depth proves
 * nothing about the world, and `buildVessel` would refuse the NaN anyway.
 */
export function spineForFormation(f: Formation, ground: GroundAt): SpinePoint[] | null {
  const out: SpinePoint[] = [];
  for (const p of f.pts) {
    // The rim, per side, in `buildCorridorVessel`'s own frame: the cross
    // direction is `(-uz, ux)`, so offset `o` lands at `(x - uz*o, z + ux*o)`.
    // Sampled here at exactly the coordinates the sweep will place the vertex,
    // so the rim vertex and the terrain under it are the same number and the
    // ground meets the coping with no step as well as no gap.
    const gl = ground(p.x - p.uz * p.span[0], p.z + p.ux * p.span[0]);
    const gr = ground(p.x - p.uz * p.span[1], p.z + p.ux * p.span[1]);
    if (!Number.isFinite(gl) || !Number.isFinite(gr)) return null;
    out.push({ x: p.x, z: p.z, railY: p.railY, groundY: [gl, gr], span: [p.span[0], p.span[1]] });
  }
  return out.length >= 2 ? out : null;
}

/**
 * Sweep every trenched run near a point, and index what comes out.
 *
 * ---------------------------------------------------------------------------
 * **THE TWO SWEEPS, WHICH ARE NOT A WASTE.**
 *
 * Each run is swept twice. The first sweep exists only to have a rim; the rim is
 * then handed to `seam.latticeCuts`, which says where it crosses the terrain
 * lattice; and the second sweep absorbs those crossings as vertices of its own.
 * *That* vessel is the artifact -- the mesh, the footprint and the collision
 * answer all come off it.
 *
 * The alternative is the terrain putting its own vertex on the interior of an
 * edge the vessel drew as one quad, which is a T-junction: not a hole, but two
 * descriptions of one edge, which is this project's oldest bug wearing a smaller
 * hat. See `world/seam.ts`.
 *
 * The second sweep is free in the terms that matter -- 55-100 us on a run that
 * takes milliseconds to check -- and the ribs, the profile and every measurement
 * are identical between the two, so the crossings computed against the first are
 * exactly valid against the second.
 */
export function buildCorridor(
  bake: RailBake,
  cut: RailCut,
  ground: GroundAt,
  lattice: Lattice,
  opts: { at?: { x: number; z: number }; radius?: number } = {},
): CorridorBuild {
  const strips = corridorStrips(bake);
  const centre = opts.at;
  const radius = opts.radius ?? Infinity;
  const wanted = strips.filter((s) => {
    if (centre !== undefined && Number.isFinite(radius)) {
      const mx = (s.ax + s.bx) / 2;
      const mz = (s.az + s.bz) / 2;
      if (Math.hypot(mx - centre.x, mz - centre.z) > radius) return false;
    }
    return trenchedStrip(cut, s, ground);
  });

  const seam = new SeamField(lattice);
  const field = new VesselField();
  const runs: CorridorRun[] = [];
  const refused: string[] = [];
  const prints: Array<{ print: Footprint; f: Formation }> = [];
  let noTerrain = 0;
  let triangles = 0;

  const grouped = buildFormations(chainRuns(wanted), cut);
  for (const f of grouped.formations) {
    const where = `${f.pts[0].x.toFixed(0)}, ${f.pts[0].z.toFixed(0)}`;
    const spine = spineForFormation(f, ground);
    if (spine === null) {
      noTerrain++;
      continue;
    }
    const first = buildCorridorVessel('trench', spine);
    if (first.vessel === null) {
      refused.push(`${where}: ${f.tracks} tracks, ${f.metres.toFixed(0)} m: ${first.faults[0]}`);
      continue;
    }
    const cuts = latticeCuts(first.vessel, lattice);
    const built = buildCorridorVessel('trench', spine, cuts);
    if (built.vessel === null || built.ribs === undefined) {
      refused.push(`${where}: cut sweep: ${built.faults[0]}`);
      continue;
    }
    const vessel = built.vessel;
    const print = new Footprint(vessel.position, vessel.rim, lattice);
    seam.add(print);
    prints.push({ print, f });
    const run: FieldRun = { vessel, ribs: built.ribs };
    field.add(run);
    triangles += vessel.triangles;
    runs.push({
      vessel, ribs: built.ribs, spine, metres: f.metres, cuts: cuts.length, tracks: f.tracks,
    });
  }

  // --- Who claims what, which is the number this phase exists for.
  //
  // Walked over the cells each footprint actually claims, not over its bounding
  // box: a 4.8 km formation's box is a million cells and its claim is nine
  // thousand of them. A cell claimed twice is reported as a **crossing**, with
  // the vertical gap between the two formations, because after `FORMATION_RISE_M`
  // that is the only thing it can be.
  const owner = new Map<number, number>();
  const insideOwner = new Map<number, number>();
  let claimedCells = 0;
  let doubleCells = 0;
  let doubleInside = 0;
  const pairs = new Map<string, { cells: number; gap: number; x: number; z: number }>();
  for (let i = 0; i < prints.length; i++) {
    for (const [key, whole] of prints[i].print.claimed()) {
      const had = owner.get(key);
      if (had === undefined) {
        owner.set(key, i);
        claimedCells++;
      } else if (had !== i) {
        doubleCells++;
        const a = prints[had].f;
        const b = prints[i].f;
        const k = `${Math.min(had, i)}:${Math.max(had, i)}`;
        const got = pairs.get(k);
        if (got) got.cells++;
        else {
          pairs.set(k, {
            cells: 1,
            gap: Math.abs(a.pts[a.pts.length >> 1].railY - b.pts[b.pts.length >> 1].railY),
            x: b.pts[0].x,
            z: b.pts[0].z,
          });
        }
      }
      if (!whole) continue;
      const hadIn = insideOwner.get(key);
      if (hadIn === undefined) insideOwner.set(key, i);
      else if (hadIn !== i) doubleInside++;
    }
  }
  const crossings = [...pairs.values()]
    .sort((a, b) => b.cells - a.cells)
    .map((p) => `${p.cells} cells near ${p.x.toFixed(0)}, ${p.z.toFixed(0)}: two formations ${p.gap.toFixed(1)} m apart in height`);

  return {
    runs, seam, field, refused, noTerrain, triangles,
    wide: grouped.wide,
    tracks: grouped.tracks,
    claimedCells, doubleCells, doubleInside, crossings,
  };
}

/** Re-exported so a caller needs one import for the whole corridor path. */
export { inTrench };
