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
 *   - tagged `cutting`, deeper than 0.5 m        -> trench, and the ground is cut
 *   - anything else deeper than 1 m              -> trench, and the ground is cut
 *   - anything else                              -> at grade, and nothing happens
 *
 * A bridge is never a trench whatever the grid says; see `inCutting`.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing but the flag constants.** No three.js, on
 * `game/rail.ts`'s own terms: `server/world.ts` needs the same corridor to
 * answer "how high is the ground" for a player standing in a cutting, and a
 * `Vector3` reaching here would drag the renderer into a process that draws
 * nothing.
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
 * How far under the terrain a track has to be before the ground is cut at all.
 *
 * One metre is about the point at which a heightfield disagreeing with a track
 * stops being noise in a 31 m DEM and starts being a cutting. Below it the
 * railway is at grade as far as anybody can see and the right amount of
 * geometry to spend on the question is none.
 */
export const CUT_MIN_DEPTH = 1.0;

/**
 * How far down a `cutting`-tagged way has to be before a trench is dug.
 *
 * Lower than `CUT_MIN_DEPTH` because the tag is independent evidence: OSM has
 * said there is a cutting here, so a DEM that only reads half a metre of it is a
 * 31 m heightfield smoothing a 15 m-wide feature away rather than a railway at
 * grade. It moves eleven spans -- 0.7 km -- and every one of them is a cutting
 * the grid had flattened.
 */
export const CUT_TAGGED_MIN_DEPTH = 0.5;

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
  // The tag lowers the bar. See `CUT_TAGGED_MIN_DEPTH`.
  const floor = (flags & SPAN_CUTTING) !== 0 ? CUT_TAGGED_MIN_DEPTH : CUT_MIN_DEPTH;
  return depth > floor;
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
    let half = CUT_HALF_WIDTH;
    for (let i = 0; i < this.sites.length; i += 4) {
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
