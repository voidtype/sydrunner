/**
 * The rail corridor, as the one thing that decides where the ground is not.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS FILE EXISTS FOR.
 *
 * `index.json` says `terrain.grid 16, post_m 31.25`: the DEM carries one height
 * every 31 metres. A rail cutting is fifteen to twenty metres wide. **The
 * heightfield cannot represent one** -- there is no post inside it to pull down
 * -- so `buildTerrainMesh` draws a continuous opaque sheet straight across the
 * corridor and the railway is under it. Measured on the shipped build: 5,577 of
 * 47,273 track samples sit more than 1.5 m below the grid, the worst by 13.5 m,
 * and at Sydenham hiding the 25 meshes named `terrain` is the difference between
 * seeing nothing and seeing the whole railway.
 *
 * The fix is to cut the hole. A terrain quad the corridor crosses is subdivided
 * into roughly four-metre sub-quads and the ones inside the corridor are simply
 * not emitted; `world/rail-geo.ts` then builds a trench in the hole -- battered
 * retaining walls from the cess up to the terrain surface, and a cess strip
 * between the wall foot and the ballast toe.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWO HALVES LIVE IN ONE FILE.
 *
 * The hole and the thing that fills it are computed by two different modules,
 * on two different schedules, from two different data structures: the hole by
 * `terrain.buildTerrainMesh` when a tile streams in, the trench by
 * `rail-geo.RailWorld.buildChunk` when a 512 m rail chunk comes into range. If
 * they disagree by ten centimetres about where the corridor edge is, the seam
 * between them is a slot of daylight into the void, all the way along the
 * railway. So neither of them owns the answer. **`cutAt` is the answer**, both
 * of them call it, and `CUT_HALF_WIDTH` is read by both from here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TUNNEL TEST IS HERE TOO.
 *
 * `SPAN_CUTTING` (4) and `SPAN_SUBWAY` (32) have been in the bake since it was
 * first written and the renderer imported neither. The consequence is 1,720
 * deduplicated segments -- 43 km of Metro alignment -- drawn as **open surface
 * railway with ballast, sleepers and catenary**, most of it thirty metres under
 * the city, because `w.kind == "subway"` is the only thing that says so on a way
 * that OSM never gave a `tunnel=yes`.
 *
 * **The first version of this file got that wrong, and the measurement is worth
 * writing down because the intuition is so plausible.** The rule was "tagged
 * `subway` and deeper than 6 m is a bore", on the assumption that the Metro's
 * tunnels are the deep half of a bimodal distribution. They are not. Histogram
 * the 1,393 subway-flagged spans that carry *no* `tunnel` tag by their depth
 * below the DEM and the whole population is at or near grade:
 *
 *     <0 m  693 spans | 0-1 m  376 | 1-2 m  109 | 2-4 m   75
 *    4-6 m   69 spans | 6-8 m   56 | 8-10 m  14 | 10-14 m  1
 *
 * There is no deep half. Sydney Metro's tunnels are properly tagged `tunnel=yes`
 * in OSM and were already drawing as bores; every *untagged* subway span deeper
 * than 4 m is a real open cutting -- 1.0 km at Sydenham, 0.9 km at Chatswood,
 * 0.6 km at Bella Vista, 0.5 km at Campsie. The 6 m rule therefore did the exact
 * damage it was written to prevent, in the opposite direction: it filled in the
 * deepest 70 spans of the Sydenham cutting with a tunnel lining and left the
 * terrain sheet lying over the top of the station.
 *
 * So `SPAN_SUBWAY` earns nothing here and is not consulted. What the flags are
 * worth is the *other* one: `SPAN_CUTTING` is OSM saying "this is a cutting" and
 * the DEM agrees with it 216 times out of 249, so it is trusted to lower the
 * depth at which a trench is dug -- a way tagged `cutting=yes` that the 31 m DEM
 * only reads as 0.6 m down is a cutting the heightfield has smoothed away, not a
 * railway at grade.
 *
 *   - tagged `tunnel`                            -> bore, at any depth
 *   - ground over the ballast crown              -> the ground is cut (`inCutting`)
 *   - tagged `cutting`, deeper than 0.15 m       -> ...and walls too (`inTrench`)
 *   - anything else deeper than 0.6 m            -> ...and walls too
 *   - anything else                              -> at grade, and nothing happens
 *
 * **Two floors, not one, and the second one is this round's fix.** The ground
 * has to come away wherever it would bury the drawn formation -- which at
 * Erskineville is where the DEM reads the track as being at grade to within
 * fifteen centimetres -- but a *wall* is only worth building where the drop
 * reads as a wall. See `CUT_MIN_DEPTH` for the measurement and
 * `TRENCH_MIN_DEPTH` for what putting both on one number would have cost.
 *
 * A bridge is never a trench whatever the grid says; see `inCutting`.
 *
 * ---------------------------------------------------------------------------
 * AND THE ONE THING THE CARVE DECLINES ON THAT IS NOT A RAILWAY: A ROAD.
 *
 * The rule above says nothing about roads and that is the bug the player kept
 * reporting: *"train at St Peters STILL covers the road at king st ... Roads
 * should be uninterrupted everywhere"*, and *"if i do jump onto the fenced
 * section of road, i can fall through down into the railroad"*. Lowering the
 * Illawarra pair under King Street was right -- it clears by 6.90 m and 7.59 m --
 * but the carve then took the ground out from under the road as well, so the
 * asphalt was drawn over a trench with nothing solid in it. Measured before the
 * fix: a body walked across the crossing fell 7.1-7.6 m at every offset over the
 * 24 m of carriageway.
 *
 * So `cutAt` now declines inside a road's paved footprint, **exactly as it
 * already declines on a `SPAN_TUNNEL` strip** -- same shape of rule, new reason.
 * The ground stays, the road is drawn on it and solid, and the trench is carved
 * either side. See `world/road-deck.ts` for where the footprint comes from and
 * why the two ends of the wire cannot disagree about it.
 *
 * The road is consulted **only after a cut has already been decided**, which is
 * both the cheap ordering and the honest one: a point outside the corridor never
 * asks about roads at all, and the question being answered is not "is there a
 * road here" but "is the ground I was about to remove carrying one".
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing but the flag constants.** No three.js, on
 * `game/rail.ts`'s own terms: `server/world.ts` needs the same corridor to
 * answer "how high is the ground" for a player standing in a cutting, and a
 * `Vector3` reaching here would drag the renderer into a process that draws
 * nothing. `RoadCover` below is structural for the same reason `terrain.TileCut`
 * is: the roads live in their own module and this one only asks them a question.
 */

import { SPAN_BRIDGE, SPAN_CUTTING, SPAN_TUNNEL, type RailBake } from '../game/rail.ts';

/**
 * Half the width of the hole cut in the terrain, from the track centreline.
 *
 * Wider than the ballast, which is 3.3 m at its base, because a railway in a
 * cutting has a cess either side of the ballast before the wall starts -- the
 * strip a track worker walks along -- and because a hole exactly as wide as the
 * ballast would leave the ballast's own batter poking through the ground it was
 * supposed to be sunk into.
 *
 * Read by `terrain.buildTerrainMesh` to decide which sub-quads to drop and by
 * `rail-geo.writeTrench` to decide where the wall tops go. It is the same
 * number in both or there is a slot of daylight between them.
 */
export const CUT_HALF_WIDTH = 5.4;

/**
 * And how wide it is at a platform.
 *
 * Not a refinement -- without it the carve is wrong in the most visible place
 * there is. `rail-geo.writePlatforms` builds a 5.5 m platform starting 1.62 m
 * from the track centre, so its outer face is **7.12 m out**, and at the thirty
 * or so platform sites that sit in real cuttings -- Sydenham, Campsie, Wolli
 * Creek, Birrong, Jannali, Westmead -- a 5.4 m hole would leave the far half of
 * every platform buried in the trench wall it was supposed to stand against.
 *
 * 9.4 m clears the platform, the fence line behind it and the stairs, which is
 * what a station cutting on the Bankstown line actually measures.
 */
export const STATION_HALF_WIDTH = 9.4;

/** Half-length of the widened box at a platform site: the platform and a little. */
const STATION_HALF_LENGTH = 88;

/**
 * Over how many metres the corridor opens out from line width to station width.
 *
 * A step would be a vertical break in the trench wall at the platform end, which
 * is not what a cutting does; a real one splays. Twelve metres is about the
 * splay on the ones this is modelled on and it costs three sub-quads.
 */
const STATION_FLARE_M = 12;

/**
 * How far the terrain has to stand over the **ballast crown** before the ground
 * is cut, metres. Negative, and the sign is the whole of this round's fix.
 *
 * ---------------------------------------------------------------------------
 * **This was +0.25 m, measured from the railhead, and Erskineville is what that
 * costs.** The report is *"still has weird void under tracks (tracks should ship
 * with at least the stones they normally sit on!)"*, and the measurement behind
 * it, sampled off the running client along the segment north of the platform:
 *
 *     t     railhead   DEM      DEM - railhead
 *     0.0   -52.93    -52.88     +0.05
 *     0.3   -53.41    -53.42     -0.01
 *     0.6   -53.89    -53.95     -0.06
 *     1.0   -54.53    -54.67     -0.14
 *
 * The track is *at grade* on the DEM's own reading, to within fifteen
 * centimetres, so at a +0.25 m floor nothing was cut anywhere near it. But
 * `rail-geo` draws the ballast **under** the railhead -- crown at
 * `BALLAST_TOP_DROP` (0.2 m) down, toe at 0.75 m down -- so the entire formation
 * was inside the terrain sheet and what the player saw was two hairlines of rail
 * head lying on bare dirt. Not a void: the opposite of one. The ground had
 * swallowed the stones.
 *
 * So the question is not "is the railhead under the ground" -- which is what a
 * positive floor asks -- but **"would the ground bury the formation"**, and the
 * formation's top is the ballast crown 0.2 m under the railhead. Half a metre
 * further down would be arguing about the shoulder; ten centimetres of slack
 * under the crown is what keeps a coplanar terrain post out of a z-fight with
 * the ballast top rather than leaving it to the depth buffer.
 *
 * At Lindfield -- the reference at-grade case, ballast standing 0.9 m proud of
 * the suburb on its own embankment -- the depth is -0.9 m, which is below this
 * floor, nothing is cut, and the verge still runs the formation down to the
 * ground exactly as it did. That is the case this must not touch and does not.
 */
export const CUT_MIN_DEPTH = -0.3;

/**
 * How deep a cutting has to be before **walls** are built in the hole.
 *
 * **A second question, and the reason it is a second constant is the cost.**
 * `CUT_MIN_DEPTH` decides where the ground comes away; this decides where
 * `rail-geo.writeTrench` stands battered retaining walls, a coping and five
 * collision prisms per eight metres of run in the hole it leaves. Those are what
 * a 512 m chunk rebuild is made of, and firing them along every metre of
 * at-grade railway in Sydney -- which the new floor above would do if one number
 * answered both questions -- is a hitch every time the player walks half a
 * kilometre.
 *
 * Nothing is lost by the split, because a shallow hole already has something
 * standing in it: `rail-geo.writeVerge` draws its at-grade strip from the
 * ballast toe at 3.15 m out to the fence line at 6.4 m, which crosses the rim of
 * a `CUT_HALF_WIDTH` hole at 5.4 m with a metre to spare, and
 * `rail-geo.writeFormation` floors the corridor between the two. A wall is only
 * worth its triangles once the drop is deep enough to read as a wall --
 * `rail-geo.TRENCH_MIN_HEIGHT` is 0.45 m measured from the cess, which is 0.6 m
 * measured from the railhead, and that is this number.
 */
export const TRENCH_MIN_DEPTH = 0.6;

/**
 * How far down a `cutting`-tagged way has to be before a trench is dug.
 *
 * Lower than `TRENCH_MIN_DEPTH` because the tag is independent evidence: OSM has
 * said there is a cutting here, so a DEM that only reads half a metre of it is a
 * 31 m heightfield smoothing a 15 m-wide feature away rather than a railway at
 * grade. It moves eleven spans -- 0.7 km -- and every one of them is a cutting
 * the grid had flattened.
 */
export const CUT_TAGGED_MIN_DEPTH = 0.15;

/**
 * Is this span drawn as a tunnel bore rather than as open railway?
 *
 * **The tunnel tag, and nothing else.** `depth` is taken but deliberately not
 * used, and the parameter is kept because the header's measurement is the kind
 * of thing that gets re-litigated: the obvious next idea is "a span far enough
 * below the terrain must be a tunnel somebody forgot to tag", and the histogram
 * up there says there is no such population in this extract. Sydney Metro's
 * tunnels all carry `tunnel=yes`. What a depth rule actually caught was the
 * Sydenham cutting.
 *
 * Depth-free also buys a real invariant. `rail-geo` decides bore-or-trench once
 * per 40 m segment and the carve decides cut-or-keep once per 4 m sub-quad, so
 * any depth term in *this* function is a boundary the two evaluate at different
 * resolutions -- and a segment straddling it draws as open track over ground
 * nobody cut. With the bore test depending only on a flag, the only
 * depth-dependent decision left is `inCutting`, which both callers evaluate per
 * point, and the two cannot disagree.
 */
export function drawnAsTunnel(flags: number, _depth?: number): boolean {
  return (flags & SPAN_TUNNEL) !== 0;
}

/**
 * Is this span sunk in a cutting -- open to the sky, but below the terrain?
 *
 * The complement of `drawnAsTunnel` on the deep side and of "at grade" on the
 * shallow side. A bridge span is never in a cutting whatever the grid says: a
 * viaduct over a valley the DEM has filled in is a modelling error in the DEM,
 * and digging a trench under a viaduct would be a hole with a bridge over it.
 */
export function inCutting(flags: number, depth: number): boolean {
  if ((flags & SPAN_BRIDGE) !== 0) return false;
  if (drawnAsTunnel(flags)) return false;
  if (!Number.isFinite(depth)) return false;
  // One floor, and no tag branch: the tag exists to say "the grid has smoothed a
  // cutting away", and this floor is already below the grid's own noise. See
  // `CUT_MIN_DEPTH`, and `inTrench` for where the tag is still spent.
  return depth > CUT_MIN_DEPTH;
}

/**
 * Is this span deep enough to be worth **building a trench in**?
 *
 * The narrower of the two questions, and it is asked of the same points by the
 * same sampler -- see `TRENCH_MIN_DEPTH` for why the two are separate at all.
 * Every span this answers `true` for is one `inCutting` also answers `true` for,
 * so a trench can never be built where the ground was left standing.
 */
export function inTrench(flags: number, depth: number): boolean {
  if (!inCutting(flags, depth)) return false;
  // The tag lowers the bar. See `CUT_TAGGED_MIN_DEPTH`.
  const floor = (flags & SPAN_CUTTING) !== 0 ? CUT_TAGGED_MIN_DEPTH : TRENCH_MIN_DEPTH;
  return depth > floor;
}

/**
 * How far under a road's paved surface the railhead has to be before the road is
 * treated as carrying the ground over it, metres. Negative, and deliberately so.
 *
 * The question this answers is "which of these two is on top", and the honest
 * reading is *the road wins unless the rail is plainly above it*. A level
 * crossing measures zero here and the road must still keep its ground -- that is
 * the case where the asphalt runs between the rails and the ballast is
 * legitimately buried in it. What the tolerance excludes is the opposite
 * geometry: a road passing *under* a railway on a bridge, where the deck is
 * metres below the railhead and keeping the terrain up at the road would put a
 * lid across the underbridge.
 *
 * `inCutting` has already refused every bridge span before this is reached, and
 * it also requires the terrain to be no more than `CUT_MIN_DEPTH` (0.3 m) below
 * the railhead -- so anything that gets this far has the *ground* at rail level
 * whatever the road is doing, and a road far below that ground is a road in its
 * own cutting passing under an at-grade railway. That is the only geometry this
 * excludes and it is right to exclude it.
 *
 * **A metre, and half a metre is measurably too tight.** At -0.5 m the
 * extent-wide audit left a residual of 34 m2 of carved carriageway in four
 * clusters, and every sample in all four measured the road surface 0.50 to
 * 0.52 m under the railhead with the terrain 0.27 to 0.29 m under it -- level
 * crossings, where the road is draped a gutter's depth below a track that is
 * standing on its own ballast. A crossing 12 m wide has that much crown-to-
 * channel fall in it. A metre puts the boundary outside the noise and is still
 * four times too small to admit a road underbridge, which needs 4.5 m of
 * headroom before anybody would build one.
 */
const DECK_UNDER_RAIL_TOLERANCE_M = -1.0;

/**
 * What `RailCut` needs from `world/road-deck.RoadDeck`.
 *
 * One method, structurally typed, so this file keeps importing nothing: the
 * browser and `server/world.ts` each build their own deck from the identical
 * `.lanes.bin` bytes and hand it to their own `RailCut`, and the two agree
 * because they ask the same function rather than because they share an object.
 */
export interface RoadCover {
  /** The paved surface over this point, or `NaN` where nothing is paved. */
  deckAt(x: number, z: number): number;
}

/** The grid cell the broad phase files strips into, metres. */
const CELL_M = 64;

/**
 * Every length of open railway in the city, indexed by where it is.
 *
 * Built from the bake rather than from `rail-geo`'s deduplicated segment set,
 * for the reason `game/riding.buildPlatforms` is built from the bake: the
 * server needs this and the server has no renderer. The duplicate suppression
 * is the same quantised key `buildNetwork` uses, so the two agree about which
 * strips exist without sharing a line of code.
 */
export class RailCut {
  /** `ax, az, ay, bx, bz, by` per strip. */
  private readonly xs: Float64Array;
  /** Span flags per strip. */
  private readonly flags: Uint8Array;
  private readonly cells = new Map<number, number[]>();
  readonly count: number;
  /** `x, z, ux, uz` per platform site. See `setStations`. */
  private sites = new Float64Array(0);
  /** Those sites' offsets, filed by cell. See `setStations`. */
  private readonly siteCells = new Map<number, number[]>();
  /**
   * The roads, or null on a process that has not been given any.
   *
   * Null is a working configuration and not a broken one -- it is the world that
   * shipped, with the ground carved straight through every crossing -- so
   * everything below is written to behave exactly as it did before when this is
   * unset. The checks rely on that: the negative control for the whole rule is a
   * second `RailCut` over the same bake with no roads in it.
   */
  private roads: RoadCover | null = null;

  constructor(bake: RailBake) {
    const p = bake.vertices;
    const vf = bake.vertexFlags;
    const q = (v: number): number => Math.round(v * 4);
    const seen = new Map<string, number>();
    const xs: number[] = [];
    const flags: number[] = [];

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
          const forward = ax < bx || (ax === bx && az <= bz);
          const key = forward
            ? `${q(ax)},${q(ay)},${q(az)},${q(bx)},${q(by)},${q(bz)}`
            : `${q(bx)},${q(by)},${q(bz)},${q(ax)},${q(ay)},${q(az)}`;
          const at = seen.get(key);
          if (at !== undefined) {
            // **Union, not first-wins**, and this is not tidiness: twenty
            // stopping patterns run over shared rails, and the `subway` flag
            // reaches a stretch of the Bankstown line on the Metro's polyline
            // while T3's copy of the identical segment carries none. Keeping
            // whichever arrived first left 22 samples of track sunk under ground
            // this file had decided not to cut, because `rail-geo.buildNetwork`
            // does union them and the two were then answering different
            // questions about the same rail.
            flags[at] |= vf[i] | vf[i + 1];
            continue;
          }
          if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
          seen.set(key, flags.length);
          // A strip is only ever *asked about*, so a bore's strip is stored too:
          // `cutAt` has to know a tunnel passes here in order to decline, and a
          // strip that was left out would read as "no railway" rather than as
          // "railway, underground".
          xs.push(ax, az, ay, bx, bz, by);
          flags.push(vf[i] | vf[i + 1]);
        }
      }
    }

    this.xs = new Float64Array(xs);
    this.flags = new Uint8Array(flags);
    this.count = flags.length;

    // Broad phase. A strip goes in every cell its plan bounding box touches,
    // grown by the corridor half-width so a query at a point need only look in
    // that point's own cell.
    for (let i = 0; i < this.count; i++) {
      const ax = this.xs[i * 6];
      const az = this.xs[i * 6 + 1];
      const bx = this.xs[i * 6 + 3];
      const bz = this.xs[i * 6 + 4];
      const x0 = Math.floor((Math.min(ax, bx) - STATION_HALF_WIDTH) / CELL_M);
      const x1 = Math.floor((Math.max(ax, bx) + STATION_HALF_WIDTH) / CELL_M);
      const z0 = Math.floor((Math.min(az, bz) - STATION_HALF_WIDTH) / CELL_M);
      const z1 = Math.floor((Math.max(az, bz) + STATION_HALF_WIDTH) / CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cz);
          let list = this.cells.get(k);
          if (list === undefined) {
            list = [];
            this.cells.set(k, list);
          }
          list.push(i);
        }
      }
    }
  }

  /**
   * Where the platforms are, so the corridor can open out around them.
   *
   * Set from outside rather than derived here, and the reason is the one
   * `rail-geo.buildNetwork` spends a page on: `bake.stations[].x, z` is the OSM
   * station *node*, which at Meadowbank is 471 m from where the trains actually
   * stop. The platform sites are the routed stopping anchors, and only
   * `buildNetwork` has resolved those. Optional -- the server never calls it,
   * because a wider hole is a fact about the picture and not about the ground.
   */
  setStations(sites: ReadonlyArray<{ x: number; z: number; ux: number; uz: number }>): void {
    const out = new Float64Array(sites.length * 4);
    for (let i = 0; i < sites.length; i++) {
      out[i * 4] = sites[i].x;
      out[i * 4 + 1] = sites[i].z;
      out[i * 4 + 2] = sites[i].ux;
      out[i * 4 + 3] = sites[i].uz;
    }
    this.sites = out;
    // **Filed, because `halfWidthAt` is the hottest function in a chunk build.**
    // It is asked once per rib per side by the trench, once more by the verge and
    // once more by the formation floor -- call it twenty times per segment, five
    // hundred segments in a 512 m chunk -- and a linear scan of 461 platform
    // sites makes that four and a half million distance tests for an answer that
    // is `CUT_HALF_WIDTH` every time bar the two hundred metres either side of a
    // station. Measured: filing them took the Redfern chunk ring from 358 ms
    // back to 205, which is most of the cost this round added.
    this.siteCells.clear();
    const reach = STATION_HALF_LENGTH + 8;
    for (let i = 0; i < sites.length; i++) {
      const x0 = Math.floor((sites[i].x - reach) / CELL_M);
      const x1 = Math.floor((sites[i].x + reach) / CELL_M);
      const z0 = Math.floor((sites[i].z - reach) / CELL_M);
      const z1 = Math.floor((sites[i].z + reach) / CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cz);
          const list = this.siteCells.get(k);
          if (list) list.push(i * 4);
          else this.siteCells.set(k, [i * 4]);
        }
      }
    }
  }

  /**
   * The carriageways, so the carve stops at a road. See the header.
   *
   * Set from outside rather than built here, on `setStations`' terms: the roads
   * arrive per tile over a session, from a decoder this file may not import, and
   * both ends of the wire fill their own. Late is safe and late is normal --
   * every query is answered from whatever is registered at the moment it is
   * asked, and nothing here caches a road decision.
   */
  setRoads(roads: RoadCover | null): void {
    this.roads = roads;
  }

  /**
   * How wide the corridor is at a point **on the track centreline**.
   *
   * On the centreline specifically, and that is what makes it well defined: if
   * the width were a function of the query point, deciding whether a point is
   * inside the corridor would need the width, which would need the point. So
   * the strip asks at its own nearest centreline point and every query about
   * that stretch of track gets the same answer -- which is also what lets
   * `rail-geo.writeTrench` put the wall top exactly on the rim of the hole.
   */
  halfWidthAt(x: number, z: number): number {
    const list = this.siteCells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    // The answer everywhere but within ninety metres of a platform, for the cost
    // of one map miss. See `setStations`.
    if (list === undefined) return CUT_HALF_WIDTH;
    let half = CUT_HALF_WIDTH;
    for (const i of list) {
      const dx = x - this.sites[i];
      const dz = z - this.sites[i + 1];
      if (dx * dx + dz * dz > (STATION_HALF_LENGTH + 8) * (STATION_HALF_LENGTH + 8)) continue;
      const ux = this.sites[i + 2];
      const uz = this.sites[i + 3];
      const along = Math.abs(dx * ux + dz * uz);
      const across = Math.abs(dx * -uz + dz * ux);
      if (along > STATION_HALF_LENGTH || across > STATION_HALF_WIDTH) continue;
      // Flared rather than stepped: full width through the platform, tapering
      // back to line width over the last few metres at each end.
      const t = Math.min(1, (STATION_HALF_LENGTH - along) / STATION_FLARE_M);
      const w = CUT_HALF_WIDTH + (STATION_HALF_WIDTH - CUT_HALF_WIDTH) * t;
      if (w > half) half = w;
    }
    return half;
  }

  /**
   * The rail head the terrain must be cut down to at this point, or `NaN` where
   * the ground stands as the DEM left it.
   *
   * `groundY` is the terrain height **the caller is about to use**, and it is an
   * argument rather than something looked up here for the reason the whole file
   * exists: `buildTerrainMesh` is carving its own grid and must test against
   * that grid's own value, not against a second opinion sampled somewhere else,
   * or the hole and the sheet it is cut in disagree at the rim.
   *
   * Where several tracks overlap -- a four-road corridor is four strips 4 m
   * apart and every point in it is inside two or three of them -- the answer is
   * the **highest** rail head among the strips that want a cut. Taking the
   * lowest would cut a hole down to the deepest rail in a corridor whose near
   * road is two metres higher, and leave the near road's ballast standing in
   * mid-air over it.
   */
  cutAt(x: number, z: number, groundY: number): number {
    const railY = this.railCutAt(x, z, groundY);
    if (!Number.isFinite(railY)) return Number.NaN;
    // **And the road, last.** See the header: a road is not a reason to cut and
    // never asked about until a cut has already been decided, so a point with no
    // railway near it pays nothing for this rule at all.
    return this.decked(x, z, railY) ? Number.NaN : railY;
  }

  /**
   * The rail head a **road** is holding the ground up over, or `NaN`.
   *
   * The exact complement of `cutAt` on the corridor: finite here means the carve
   * wanted this point and a carriageway kept it. Nothing about the ground query
   * needs it -- the ground is simply still there -- but the *picture* does, and
   * so does the trench. `world/terrain.buildTerrainMesh` gives every sub-quad
   * this answers for a soffit and a fascia, because a kept sub-quad over an open
   * trench is a slab with no underside, and `rail-geo.writeTrench` stops its
   * retaining wall at that soffit rather than bringing it up through the road.
   */
  deckedAt(x: number, z: number, groundY: number): number {
    const railY = this.railCutAt(x, z, groundY);
    if (!Number.isFinite(railY)) return Number.NaN;
    return this.decked(x, z, railY) ? railY : Number.NaN;
  }

  /**
   * The paved surface over this point, or `NaN`. `RoadCover.deckAt`, forwarded.
   *
   * Forwarded rather than left to callers to hold their own reference, because
   * the whole design here is that there is one object that knows where the road
   * is and one object every consumer already has a handle on. `rail-geo` gets a
   * `RailCut` and nothing else; giving it a second field to plumb through six
   * call sites is how the two end up asking different decks.
   */
  deckSurfaceAt(x: number, z: number): number {
    return this.roads === null ? Number.NaN : this.roads.deckAt(x, z);
  }

  /** The corridor's own answer, before the road rule. See `cutAt`. */
  private railCutAt(x: number, z: number, groundY: number): number {
    const list = this.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (list === undefined) return Number.NaN;
    let best = Number.NaN;
    for (const i of list) {
      const railY = this.railYOn(i, x, z);
      if (!Number.isFinite(railY)) continue;
      if (!inCutting(this.flags[i], groundY - railY)) continue;
      if (!(railY <= best)) best = railY;
    }
    return best;
  }

  /** Is a paved surface carrying the ground over this railhead? */
  private decked(x: number, z: number, railY: number): boolean {
    if (this.roads === null) return false;
    const deckY = this.roads.deckAt(x, z);
    return Number.isFinite(deckY) && deckY - railY > DECK_UNDER_RAIL_TOLERANCE_M;
  }

  /**
   * Does the carve fire **anywhere** along this stretch of track?
   *
   * ---------------------------------------------------------------------------
   * **The one question `rail-geo.buildChunk` was asking wrong, and the bug it
   * produced is the reported one.** The carve decides cut-or-keep per sub-quad,
   * four metres at a time, against that quad's own interpolated ground. The
   * trench decided per *segment*, from a single sample of the ground at the
   * segment's **midpoint**. A forty-metre segment that runs into a bank at one
   * end has a midpoint at grade, so the ground was taken away along its far half
   * and nothing was built in the hole: a slot of daylight beside the track with
   * no wall in it, which is exactly *"i can pass through that right edge to see
   * the other bit of the rail line"*, and no cess either, which is exactly
   * *"there should always be rocks under the tracks"*.
   *
   * So the two now ask the identical function about the identical points. A
   * segment is trenched if any point along it is cut, the wall then goes to
   * nothing wherever the ground is below the cess -- `writeTrench` already
   * clamps for that -- and a hole without a wall in it is no longer
   * representable.
   *
   * Sampled every four metres, which is the carve's own sub-quad pitch: finer
   * buys nothing the terrain mesh can express, coarser is the bug again.
   */
  cutsAlong(
    ax: number, az: number, bx: number, bz: number,
    groundAt: (x: number, z: number) => number,
  ): boolean {
    return this.probeAlong(ax, az, bx, bz, groundAt).cut;
  }

  /**
   * Both answers about this stretch of track, from **one** walk of it.
   *
   * `cut` is where the ground has come away; `trench` is where that hole is deep
   * enough to want retaining walls. See `TRENCH_MIN_DEPTH` for why they are two
   * questions, and this signature for why they are one pass: the sampler is four
   * metres apart over a forty-metre span, each sample is a cell lookup and a
   * `railYOn` per strip that touches it, and at Redfern that is the single
   * hottest loop in a chunk build. Asking it twice cost 50 ms on a 512 m hop and
   * bought nothing -- every point either test looks at, the other looks at too.
   */
  probeAlong(
    ax: number, az: number, bx: number, bz: number,
    groundAt: (x: number, z: number) => number,
  ): { cut: boolean; trench: boolean } {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / 4));
    let cut = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const g = groundAt(x, z);
      if (!Number.isFinite(g)) continue;
      const list = this.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
      if (list === undefined) continue;
      // **The road rule applies here too, and it has to.** `cutAt` is the
      // ground and this is the wall that stands in the hole it leaves, so a
      // point the road saved must read as "not cut" to both or the invariant
      // this function exists to hold -- a hole is never without a wall, a wall
      // is never without a hole -- is broken in the second direction. A segment
      // that runs entirely under a wide road gets no trench, which is right:
      // there is no hole there to retain.
      //
      // Sampled once per point rather than once per strip, which matters: this
      // is the hottest loop in a chunk build and a four-road corridor asks about
      // three or four strips at every one of its points.
      const deckY = this.roads === null ? Number.NaN : this.roads.deckAt(x, z);
      const paved = Number.isFinite(deckY);
      for (const s of list) {
        const railY = this.railYOn(s, x, z);
        if (!Number.isFinite(railY)) continue;
        const depth = g - railY;
        if (paved && deckY - railY > DECK_UNDER_RAIL_TOLERANCE_M) continue;
        // A trench implies a cut -- `inTrench` says so -- so the deep answer
        // ends the walk and the shallow one only records.
        if (inTrench(this.flags[s], depth)) return { cut: true, trench: true };
        if (inCutting(this.flags[s], depth)) cut = true;
      }
    }
    return { cut, trench: false };
  }

  /**
   * Is there any strip at all within `pad` of this point?
   *
   * The broad phase on its own, for `buildTerrainMesh`'s per-quad reject: over
   * the whole 60 km world all but a few hundred tiles have no railway in them
   * and must not pay for one.
   */
  near(x: number, z: number, pad: number): boolean {
    // The widest the corridor can be anywhere, so the broad phase never rejects
    // a quad a station's flare would have reached into.
    const r = STATION_HALF_WIDTH + pad;
    const cx0 = Math.floor((x - r) / CELL_M);
    const cx1 = Math.floor((x + r) / CELL_M);
    const cz0 = Math.floor((z - r) / CELL_M);
    const cz1 = Math.floor((z + r) / CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (list === undefined) continue;
        for (const i of list) {
          if (distanceSquared(this.xs, i, x, z) <= r * r) return true;
        }
      }
    }
    return false;
  }

  /**
   * The rail head of strip `i` under a point, or `NaN` if the point is outside
   * the strip. The height is the strip's own linear interpolation, which is what
   * `rail-geo` draws the ballast along, so the cut floor and the ballast top are
   * the same surface.
   */
  private railYOn(i: number, x: number, z: number): number {
    const ax = this.xs[i * 6];
    const az = this.xs[i * 6 + 1];
    const ay = this.xs[i * 6 + 2];
    const bx = this.xs[i * 6 + 3];
    const bz = this.xs[i * 6 + 4];
    const by = this.xs[i * 6 + 5];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = 0;
    if (len2 > 1e-9) {
      t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const px = ax + ex * t;
    const pz = az + ez * t;
    const dx = x - px;
    const dz = z - pz;
    const half = this.halfWidthAt(px, pz);
    if (dx * dx + dz * dz > half * half) return Number.NaN;
    return ay + (by - ay) * t;
  }
}

function cellKey(cx: number, cz: number): number {
  // Two 20-bit signed fields. The world is 120 km across at 64 m a cell, so the
  // range is +/-940 cells and there is no chance of a collision.
  return (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
}

function distanceSquared(xs: Float64Array, i: number, x: number, z: number): number {
  const ax = xs[i * 6];
  const az = xs[i * 6 + 1];
  const bx = xs[i * 6 + 3];
  const bz = xs[i * 6 + 4];
  const ex = bx - ax;
  const ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = x - (ax + ex * t);
  const dz = z - (az + ez * t);
  return dx * dx + dz * dz;
}
