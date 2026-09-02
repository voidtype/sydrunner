/**
 * The clearance envelope: the volume around a corridor that nothing may stand in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS ONE OBJECT RATHER THAN SIX RULES.
 *
 * A player walked the railway and reported seven things. Six of them are the
 * same thing said six ways: *"some places intersect with ground"*, *"there
 * should always be rocks under the tracks"*, *"the roseville station is shown as
 * a brick building which is solid, that the train must pass through"*, *"rail
 * lines also pass through roads"*. Their own diagnosis is the one in this file:
 *
 *   > *"cutting (just below the tracks and like a 1m radius either side, with a
 *   > wide enough circle to include the entire train, might be safer as i notice
 *   > i pass through a lot of random solids while moving, cutting a tube around
 *   > all rail lines may be a good idea"*
 *
 * That is the **loading gauge** -- the swept volume a vehicle needs kept clear --
 * and every one of those reports is a different consumer failing to respect it.
 * Before this file each consumer had its own idea of where the corridor was:
 * `rail-cut.CUT_HALF_WIDTH` for the terrain carve, `rail-geo.PLATFORM_INNER` for
 * the platform, nothing at all for the buildings. They disagreed, and a rule that
 * is stated six times is a rule that is enforced nowhere.
 *
 * ---------------------------------------------------------------------------
 * THE ENVELOPE ITSELF.
 *
 * A corridor is a straight strip between two points carrying its own y at each
 * end. Its envelope is that strip swept:
 *
 *   - **out** `half` metres each side of the centreline;
 *   - **up** from `below` metres under the reference surface to `above` metres
 *     over it, the reference surface being the railhead for a railway and the
 *     carriageway for a road.
 *
 * For a railway those numbers are a Tangara: 3.16 m over the body, so 1.58 m of
 * half-width, plus the sway and the platform-edge tolerance a real kinematic
 * envelope carries, is 2.6 m; a double-deck set is 4.4 m to the roof and the
 * pantograph and contact wire want another half metre over that. The player then
 * asked for *"like a 1m radius either side"* of margin on top, and they are right
 * to: this envelope is what a *body* is tested against, and a body that grazes
 * the gauge is a body inside a wall.
 *
 * For a road it is `elevated.ROAD_CLEARANCE_M`, restated here rather than
 * reinvented, because the pipeline already decides what a road needs kept clear
 * over it and two answers to that question is one too many.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR: SUBTRACTION, NOT DELETION.
 *
 * The first version of this deleted any grounded prism that intersected the
 * envelope. That is wrong and the user said so in one line:
 *
 *   > *"no building should EVER cover a road nor a railroad. put a tunnel thru
 *   > any building like that at the very least. roads are roads, railroads are
 *   > railroads"*
 *
 * Westfield Hurstville over Park Road, the Eveleigh carriage workshops over the
 * Illawarra lines and the Chatswood interchange all genuinely span their
 * corridor, and all of them have an **undercroft**: the building stands, and a
 * clear tunnel runs through it. So `carve` splits a prism into up to three
 * pieces -- the part left of the corridor, the part right of it, and the part
 * *over* it carried on a raised `base` exactly as a viaduct deck is -- and drops
 * only the pieces that come out degenerate.
 *
 * `pipeline/sydney/elevated.py` already does exactly this cut for roads at bake
 * time ("cut the road corridor out and keep the largest piece on the ground").
 * This is the same rule, at runtime, where it can also see the railway.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing.** `rail-cut.ts`' argument, for the same reason:
 * the server carves the identical prisms out of the identical buildings, and a
 * `Vector3` reaching in here would drag the renderer into a process that draws
 * nothing.
 */

/**
 * Half the width of the rail loading gauge, metres, plus the player's margin.
 *
 * 1.58 m of carriage half-body, plus sway, plus the platform tolerance, is the
 * 2.6 m a kinematic envelope is drawn at; the last metre is the one the report
 * asked for in as many words. Deliberately **narrower** than
 * `rail-cut.CUT_HALF_WIDTH` (5.4 m): the carve is a hole wide enough for a
 * cutting with a cess either side, and this is the volume a train occupies. A
 * platform stands 1.62 m from the centreline and is *supposed* to -- so anything
 * that used this number to place a platform would build no platform anywhere.
 * The two are different questions and this file answers only its own.
 */
export const RAIL_HALF_M = 3.6;

/**
 * How far under the railhead the envelope's floor sits, metres.
 *
 * The ballast, and no more: `rail-geo` drops its top 0.2 m under the rail head
 * and runs it 0.55 m deep, so 0.9 m is the underside of the formation with a
 * little to spare. It is what makes *"there should always be rocks under the
 * tracks"* an invariant a check can assert -- the band from here to the railhead
 * is the ballast's, and terrain in it is terrain that has swallowed the track.
 */
export const RAIL_BELOW_M = 0.9;

/**
 * And how far over it: a double-deck set, its pantograph, and the margin.
 *
 * 4.4 m to a Tangara's roof, 0.5 m for the pantograph and the contact wire it
 * reaches, 1.0 m of the reported margin. `rail-geo.CONTACT_HEIGHT` is 5.1 m and
 * sits inside this deliberately -- the wire is part of the railway, and the
 * envelope is what has to be clear of *everything else*.
 */
export const RAIL_ABOVE_M = 5.9;

// --- The structure gauge: the volume the railway's own kit must clear ------------
//
// `RAIL_HALF_M` above is the envelope a *building* is carved out of, and it is
// 3.6 m because it carries a metre of the player's margin and the sway on top of
// the body. A platform is 1.62 m from the centreline and is *supposed* to be, so
// nothing on the railway can be tested against that number -- its own header
// says so. What the railway's own writers need is the tighter statement: the
// swept solid body of a carriage, and the smallest gap anybody may leave beside
// it.
//
// It is here rather than in `rail-geo.ts` because it has to be askable by the
// server, by the audit and by the renderer, and because a rule that lives beside
// the writer it constrains is a rule that writer can quietly disagree with. This
// is the one answer, and `structureGauge` is how it is asked.

/**
 * Half the solid body of a carriage, metres, at its widest.
 *
 * **This is the definition and `world/trains.ts` reads it**, rather than the
 * other way round: the collider that stops a player walking into a moving train
 * and the volume a platform coping must stay out of are the same box, and two
 * numbers for it is how a platform ends up 3 cm inside a train.
 *
 * The impostor's drawn skin is 1.52 m and this is three centimetres outside it,
 * so the collider sits just off the surface a body is also drawn against. One
 * box for the Tangara and the Metropolis both: they differ by 3 cm across and
 * nobody can tell, while a train that blocks when modelled and passes when
 * impostored is immediately obvious.
 */
export const CAR_BODY_HALF_M = 1.55;

/** The underside of that body, metres over the railhead. `trains.CAR_SOLID_FLOOR`. */
export const CAR_BODY_FLOOR_M = 0.25;

/** And its roof. `trains.CAR_SOLID_ROOF`. */
export const CAR_BODY_ROOF_M = 4.15;

/**
 * How much clear air the railway's own structures must leave beside the body,
 * metres.
 *
 * ---------------------------------------------------------------------------
 * **Seventy millimetres, and the number is not a choice -- it is what a
 * platform is.** `rail-solids.PLATFORM_INNER` is 1.62 m and a real platform
 * really is that close to a real train; the gap you step over at Town Hall is
 * about eight centimetres. So the margin cannot be set from comfort, because any
 * comfortable margin condemns every platform in the state. It is set from the
 * one structure that is allowed to be nearest, and everything else has to be
 * further out than the platform is.
 *
 * **Exactly `PLATFORM_INNER - CAR_BODY_HALF_M`, and five millimetres of slop
 * here cost a whole audit.** At 0.075 the limit came to 1.625 m against a
 * platform face at 1.620, so once the deck was swept and actually followed the
 * rail, every correctly-built metre of every platform in the city reported a
 * 5 mm intrusion -- 57 km of it, which read as the sweep having made things
 * worse when it had made them right. The gauge's edge has to be the platform's
 * face, and the test below is strict, so a platform exactly where a platform
 * goes is clear and anything nearer is not.
 *
 * The consequence is worth saying plainly, because it is the whole reason the
 * platform sweep exists: **the railway's tightest clearance is 70 mm, so a
 * platform placed in a frame the track leaves cannot survive.** Eighty metres of
 * a 1,000 m curve walks 3.2 m off its own tangent, which is forty-five times the
 * budget. A constant cannot absorb that and no constant was ever going to.
 */
export const STRUCTURE_MARGIN_M = 0.07;

/**
 * Is a point at lateral offset `offset` from a running line, `dy` metres over
 * its railhead, inside the volume a train sweeps?
 *
 * The one question every rail writer has to be able to answer about anything it
 * emits, and `server/platform-gauge-check.ts` asks it of everything they do
 * emit. `offset` is signed and the test is on its magnitude, so a caller never
 * has to remember which side it is working on.
 *
 * The height band matters as much as the width does and is the reason this is a
 * function rather than a comparison against `CAR_BODY_HALF_M`: a canopy 4.9 m up
 * and a footbridge soffit at 8.4 m are both nearer the centreline than the body
 * is wide, and both are correct. Only the band the body actually occupies is
 * forbidden.
 */
export function structureGauge(offset: number, dy: number): boolean {
  if (dy <= CAR_BODY_FLOOR_M || dy >= CAR_BODY_ROOF_M) return false;
  const a = offset < 0 ? -offset : offset;
  return a < CAR_BODY_HALF_M + STRUCTURE_MARGIN_M;
}

/**
 * The clearance a road needs kept over it, metres.
 *
 * `pipeline/sydney/elevated.ROAD_CLEARANCE_M`, restated. Not re-derived and not
 * rounded: the pipeline raises a building over a road to this and the runtime
 * carve has to agree with it or a structure the bake thought it had lifted is a
 * structure this file cuts a second hole in.
 */
export const ROAD_CLEARANCE_M = 5.4;

/**
 * How far under the road surface a road envelope reaches, metres.
 *
 * Small, and much smaller than the rail's: a road is drawn *on* the ground and
 * its own surface is the floor. What this covers is the difference between the
 * lane graph's y and the terrain under a kerb, which is a few tens of
 * centimetres either way.
 */
export const ROAD_BELOW_M = 0.4;

/**
 * The smallest piece of a carved footprint worth keeping, square metres.
 *
 * *"Where a piece comes out degenerate -- a sliver narrower than a metre or two,
 * or nothing left above -- drop that piece only, not the whole structure."* Two
 * square metres is a sliver a body could not stand in and a wall nobody would
 * see; keeping them would triple the prism count for no collision anybody meets.
 */
export const MIN_PIECE_M2 = 2.0;

/**
 * The shortest raised span worth carrying, metres.
 *
 * A building whose roof is 30 cm over the envelope ceiling has no honest
 * undercroft in it -- the piece above would be a slab of nothing. Below this the
 * span is dropped and the corridor simply runs through open air, which is what
 * `elevated.py`'s own ladder does one rung down.
 */
export const MIN_SPAN_M = 0.6;

/**
 * The most pieces one solid may be cut into, over every corridor near it.
 *
 * **A cap, because this is a product and not a sum.** Each corridor splits every
 * piece the last one left, so a warehouse with a road polyline running through it
 * -- twenty short corridors, all of them crossing -- is five to the twentieth
 * pieces if nothing stops it. Measured before the cap existed: a whole-world
 * carve that took 34 seconds took over ten minutes and had not finished.
 *
 * Twelve is past what any real case needs. The Eveleigh workshops are crossed by
 * six roads' worth of corridor and come out in nine; Westfield Hurstville in
 * four. Past the cap the remaining corridors are simply not applied, which
 * leaves that building with fewer holes than it should have -- the same
 * conservative direction every other clause here fails in.
 */
export const MAX_PIECES = 12;

/**
 * How much of a footprint must be inside a corridor before it is cut, m^2.
 *
 * **Bigger than `MIN_PIECE_M2`, and the two are different questions.** That one
 * asks whether a *remnant* is worth keeping; this one asks whether an overlap is
 * an undercroft or a mapping error. Almost every building the road envelope
 * touches touches it by a metre or so of kerb line -- ML-derived footprints are
 * not surveyed and a terrace's front wall lands in the carriageway all over the
 * city -- and cutting a tunnel through those achieves nothing a player can walk
 * through while turning one prism into four.
 *
 * At 2 m^2 the whole-world carve cut 68,053 prisms into 546,126 pieces, which is
 * 330,000 more collision records than the pipeline wrote and about 140 MB on a
 * server with a 450 MB cap. Eight square metres is a 2 x 4 m overlap: under it
 * the building keeps its corner, over it there is a real hole to open.
 */
export const MIN_CUT_M2 = 8.0;

/** One straight length of corridor, with the volume it keeps clear. */
export interface Corridor {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** The reference surface at each end: railhead, or carriageway. */
  ay: number;
  by: number;
  half: number;
  below: number;
  above: number;
  /** True for a railway, false for a road. Reported, never branched on here. */
  rail: boolean;
}

/** A prism as this file reads and writes one. `player/collision.Prism`'s core. */
export interface Solid {
  points: Float32Array;
  height: number;
  base: number;
  structural: boolean;
}

/** What one carve did, for the log the coordinator asked for. */
export interface CarveTally {
  /** Prisms looked at. */
  tested: number;
  /** Prisms the envelope actually cut. */
  cut: number;
  /** Pieces handed back in their place. */
  pieces: number;
  /** Pieces that came out too small to keep. */
  dropped: number;
  /** Prisms cut down to nothing at all -- a footprint entirely inside a corridor. */
  emptied: number;
}

const CELL_M = 64;

/**
 * Every corridor in the city, indexed by where it is.
 *
 * Corridors are **added**, never replaced: the rail comes from the bake at boot
 * and the roads arrive with the lane sidecars per hexagon, so this fills in over
 * a session. `carve` is written to be safe under that -- see `CollisionWorld`'s
 * own note on re-carving, and `MIN_PIECE_M2` for why carving a piece twice is
 * the same as carving the original once.
 */
export class ClearanceEnvelope {
  private readonly cells = new Map<number, number[]>();
  private readonly list: Corridor[] = [];
  /**
   * When each cell last gained a corridor, as a monotonic counter.
   *
   * **The whole of what makes re-carving affordable.** Corridors arrive per
   * hexagon over a session, and a solid already carved against everything near
   * it must not be carved again -- on the server that is fourteen thousand
   * hexagons times the prisms in reach, and in the browser it is a frame. A
   * solid carries the stamp it was last carved at (`Prism.carveStamp`); if no
   * cell it touches has changed since, there is nothing to do and the test is
   * four map lookups.
   */
  private readonly cellVersion = new Map<number, number>();
  private version = 0;

  get count(): number {
    return this.list.length;
  }

  /**
   * Add the railway, from the bake's own vertices.
   *
   * Structurally typed rather than taking `RailBake`, on `rail-cut.ts`' terms:
   * this file imports nothing, and what it needs from a bake is three arrays.
   * Tunnel spans are skipped -- a bore is a hole in the rock with its own lining
   * and a building thirty metres over one is not in its way.
   */
  addRail(
    bake: {
      vertices: Float32Array;
      vertexFlags: Uint8Array;
      lines: ReadonlyArray<{ dirs: ReadonlyArray<{ vertexOff: number; vertexCount: number }> }>;
    },
    tunnelFlag: number,
  ): void {
    const p = bake.vertices;
    const vf = bake.vertexFlags;
    for (const line of bake.lines) {
      for (const dir of line.dirs) {
        const start = dir.vertexOff;
        const end = dir.vertexOff + dir.vertexCount - 1;
        for (let i = start; i < end; i++) {
          if (((vf[i] | vf[i + 1]) & tunnelFlag) !== 0) continue;
          const ax = p[i * 3];
          const ay = p[i * 3 + 1];
          const az = p[i * 3 + 2];
          const bx = p[(i + 1) * 3];
          const by = p[(i + 1) * 3 + 1];
          const bz = p[(i + 1) * 3 + 2];
          if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
          this.add({
            ax, az, ay, bx, bz, by,
            half: RAIL_HALF_M, below: RAIL_BELOW_M, above: RAIL_ABOVE_M, rail: true,
          });
        }
      }
    }
  }

  /**
   * Add one tile's roads, from the lane graph's ways.
   *
   * The ways block is the only description of a road either end of the wire has
   * that carries a **width** and a **height** -- `game/traffic.LaneWay` -- and
   * both ends decode the identical bytes, which is what lets a building be cut
   * the same way on the server and in the browser. `halfWidth` is the
   * carriageway's own half, so a body walking the footpath is outside the
   * envelope and a car in the far lane is inside it.
   */
  addRoads(
    ways: ReadonlyArray<{ halfWidth: number; count: number; x: Float32Array; y: Float32Array; z: Float32Array }>,
    /** Grown by this much, for the re-carve box handed back. */
    margin = 0,
  ): [number, number, number, number] {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const way of ways) {
      for (let i = 0; i < way.count; i++) {
        if (way.x[i] < minX) minX = way.x[i];
        if (way.x[i] > maxX) maxX = way.x[i];
        if (way.z[i] < minZ) minZ = way.z[i];
        if (way.z[i] > maxZ) maxZ = way.z[i];
      }
    }
    for (const way of ways) {
      for (let i = 0; i + 1 < way.count; i++) {
        const ax = way.x[i];
        const az = way.z[i];
        const bx = way.x[i + 1];
        const bz = way.z[i + 1];
        if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
        this.add({
          ax, az, ay: way.y[i], bx, bz, by: way.y[i + 1],
          half: Math.max(1.5, way.halfWidth),
          below: ROAD_BELOW_M, above: ROAD_CLEARANCE_M, rail: false,
        });
      }
    }
    return [minX - margin, minZ - margin, maxX + margin, maxZ + margin];
  }

  add(c: Corridor): void {
    const i = this.list.length;
    this.list.push(c);
    this.version++;
    const x0 = Math.floor((Math.min(c.ax, c.bx) - c.half - RUN_OVERHANG_M) / CELL_M);
    const x1 = Math.floor((Math.max(c.ax, c.bx) + c.half + RUN_OVERHANG_M) / CELL_M);
    const z0 = Math.floor((Math.min(c.az, c.bz) - c.half - RUN_OVERHANG_M) / CELL_M);
    const z1 = Math.floor((Math.max(c.az, c.bz) + c.half + RUN_OVERHANG_M) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        const l = this.cells.get(k);
        if (l) l.push(i);
        else this.cells.set(k, [i]);
        this.cellVersion.set(k, this.version);
      }
    }
  }

  /**
   * The newest corridor anywhere over this plan box, as a counter.
   *
   * A caller holding a solid stamped at or after this has nothing to re-cut.
   * See `cellVersion`.
   */
  stampFor(minX: number, minZ: number, maxX: number, maxZ: number): number {
    let best = 0;
    for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
      for (let cz = Math.floor(minZ / CELL_M); cz <= Math.floor(maxZ / CELL_M); cz++) {
        const v = this.cellVersion.get(cellKey(cx, cz));
        if (v !== undefined && v > best) best = v;
      }
    }
    return best;
  }

  /**
   * Is there any corridor at all over this plan box?
   *
   * **The reject that makes the whole rule affordable**, and it exists because
   * `near` does not: that one allocates a `Set` and an array before it can say
   * "nothing", and the server offers it **2.9 million prisms** at boot, of which
   * all but a few tens of thousands are nowhere near a railway. Two point nine
   * million sets is the difference between a boot that finishes and one that was
   * reported as a server that never answered `/health`.
   *
   * Cell existence only: a corridor is filed in every cell its strip touches, so
   * a box that meets no occupied cell meets no corridor. Four lookups for a
   * building, and no allocation on the answer that matters.
   */
  anyNear(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
      for (let cz = Math.floor(minZ / CELL_M); cz <= Math.floor(maxZ / CELL_M); cz++) {
        if (this.cells.has(cellKey(cx, cz))) return true;
      }
    }
    return false;
  }

  /** Every corridor whose swept strip could touch this plan box. */
  near(minX: number, minZ: number, maxX: number, maxZ: number, out: Corridor[] = []): Corridor[] {
    out.length = 0;
    const cx0 = Math.floor(minX / CELL_M);
    const cx1 = Math.floor(maxX / CELL_M);
    const cz0 = Math.floor(minZ / CELL_M);
    const cz1 = Math.floor(maxZ / CELL_M);
    const seen = new Set<number>();
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const l = this.cells.get(cellKey(cx, cz));
        if (l === undefined) continue;
        for (const i of l) {
          if (seen.has(i)) continue;
          seen.add(i);
          const c = this.list[i];
          if (
            Math.min(c.ax, c.bx) - c.half > maxX || Math.max(c.ax, c.bx) + c.half < minX ||
            Math.min(c.az, c.bz) - c.half > maxZ || Math.max(c.az, c.bz) + c.half < minZ
          ) {
            continue;
          }
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Is this point inside any corridor's envelope?
   *
   * The one-point form, for the callers that are asking about a *place* rather
   * than about a solid: `rail-geo` asks it before it puts a platform down, and
   * the checks ask it of every prism they expect to have been cut.
   */
  contains(x: number, y: number, z: number, railOnly = false): boolean {
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    const l = this.cells.get(cellKey(cx, cz));
    if (l === undefined) return false;
    for (const i of l) {
      const c = this.list[i];
      if (railOnly && !c.rail) continue;
      const hit = alongAcross(c, x, z);
      if (hit.across > c.half) continue;
      if (y < hit.y - c.below || y > hit.y + c.above) continue;
      return true;
    }
    return false;
  }

  /**
   * The highest envelope ceiling over this point, or `-Infinity`.
   *
   * What a caller needs to know to put something *over* a corridor rather than
   * in it -- the raised `base` of an undercroft span, and the height a road deck
   * would have to reach to clear a railway.
   */
  ceilingAt(x: number, z: number, railOnly = false): number {
    const l = this.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (l === undefined) return -Infinity;
    let best = -Infinity;
    for (const i of l) {
      const c = this.list[i];
      if (railOnly && !c.rail) continue;
      const hit = alongAcross(c, x, z);
      if (hit.across > c.half) continue;
      const top = hit.y + c.above;
      if (top > best) best = top;
    }
    return best;
  }

  /**
   * Cut every corridor out of one solid, and hand back what is left of it.
   *
   * Returns `null` when nothing intersected -- the overwhelmingly common answer,
   * and the one that costs a bounding-box test -- so a caller can keep the record
   * it already has rather than rebuild an identical one.
   *
   * **The decomposition, per corridor, is the one the user asked for**: the piece
   * left of the strip and the piece right of it stay exactly as they were, and
   * the piece *between* them is lifted onto a `base` at the envelope ceiling and
   * marked `structural`, which is the flag `player/collision.solidFor` reads to
   * mean "there is air under this". The result is a tunnel through the building
   * at corridor level with the building still standing over and either side of it.
   *
   * Applied corridor by corridor over the pieces of the last one, so a building
   * over four tracks and a road comes out with the union of all five cut from it
   * and the order they arrived in does not change the answer.
   */
  carve(solid: Solid, tally?: CarveTally): Solid[] | null {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const pts = solid.points;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minZ) minZ = pts[i + 1];
      if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
    }
    // The cheap reject first, before anything is allocated. See `anyNear`.
    if (!this.anyNear(minX, minZ, maxX, maxZ)) return null;
    const corridors = this.near(minX, minZ, maxX, maxZ);
    if (corridors.length === 0) return null;
    if (tally) tally.tested++;

    let pieces: Solid[] = [solid];
    let touched = false;
    for (const c of corridors) {
      // The band, taken over the whole strip rather than interpolated along it:
      // a corridor is 40 m at most and the difference between its two ends is
      // centimetres, and a band that varied along the run would make the piece
      // above it a wedge rather than a prism.
      const lo = Math.min(c.ay, c.by) - c.below;
      const hi = Math.max(c.ay, c.by) + c.above;
      const next: Solid[] = [];
      for (const piece of pieces) {
        const top = piece.base + piece.height;
        if (top <= lo || piece.base >= hi || next.length >= MAX_PIECES) {
          next.push(piece);
          continue;
        }
        const mid = clipToStrip(piece.points, c);
        if (mid === null || polygonArea(mid) < MIN_CUT_M2) {
          next.push(piece);
          continue;
        }
        touched = true;
        // Everything outside the corridor's rectangle, still on the ground.
        for (const outer of clipOutside(piece.points, c)) {
          if (polygonArea(outer) < MIN_PIECE_M2) {
            if (tally) tally.dropped++;
            continue;
          }
          next.push({ points: outer, height: piece.height, base: piece.base, structural: piece.structural });
        }
        // What is left over the corridor, carried like a deck.
        if (top - hi >= MIN_SPAN_M) {
          next.push({ points: mid, height: top - hi, base: hi, structural: true });
        } else if (tally) {
          tally.dropped++;
        }
        // ...and what is left under it, which is a basement and is almost never
        // anything: a building's `base` is its pad, so this fires only where the
        // corridor is carried over a structure that starts below it.
        if (lo - piece.base >= MIN_SPAN_M) {
          next.push({ points: mid, height: lo - piece.base, base: piece.base, structural: piece.structural });
        }
      }
      pieces = next;
      if (pieces.length === 0) break;
    }

    if (!touched) return null;
    // **A carve never deletes a structure.** `elevated.py`'s repair ladder ends
    // on the same rung -- *"leave it alone, grounded and named in the report"* --
    // and for the same reason: a building standing wholly inside a carriageway
    // with no headroom over it is either a mapping error or a thing this rule
    // does not understand, and removing it is the one outcome that cannot be
    // undone by looking at the picture. Counted, so the report can say how often.
    if (pieces.length === 0) {
      if (tally) tally.emptied++;
      return null;
    }
    if (tally) {
      tally.cut++;
      tally.pieces += pieces.length;
    }
    return pieces;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
}

/** Where a point sits in a corridor's own frame: how far across, and the surface there. */
function alongAcross(c: Corridor, x: number, z: number): { across: number; y: number } {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 1e-9 ? ((x - c.ax) * ex + (z - c.az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (c.ax + ex * t);
  const dz = z - (c.az + ez * t);
  return { across: Math.hypot(dx, dz), y: c.ay + (c.by - c.ay) * t };
}

/**
 * How far past its own two ends a corridor still cuts, metres.
 *
 * **Not zero, and not infinite, and the first version of this file was infinite.**
 * A strip that stopped dead at its endpoints leaves an uncut wedge of building at
 * every vertex of the alignment, on the outside of the turn, because the next
 * corridor's normal has rotated -- the same failure `rail-geo.writeTrench` has
 * with its walls. So the strip overhangs, and the neighbour's overhang covers the
 * wedge.
 *
 * Infinite was worse, and measurably: with the run unbounded, a cul-de-sac cut a
 * six-metre slot across every building in line with it to the edge of the world,
 * and the whole-city carve **emptied 7,133 prisms outright**. Six metres is over
 * the widest wedge a real bend leaves (a 10 m half-width turning half a radian)
 * and is under the length of the shortest way in the graph.
 */
const RUN_OVERHANG_M = 6;

/**
 * The signed distance from the corridor's centreline, in its own plan frame.
 * Positive to the left of the run.
 */
function acrossOf(c: Corridor, x: number, z: number): number {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len = Math.hypot(ex, ez);
  if (len < 1e-6) return Infinity;
  return ((x - c.ax) * -ez + (z - c.az) * ex) / len;
}

/** How far along the run a point is, from the `a` end. */
function alongOf(c: Corridor, x: number, z: number): number {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len = Math.hypot(ex, ez);
  if (len < 1e-6) return -Infinity;
  return ((x - c.ax) * ex + (z - c.az) * ez) / len;
}

/** The run's own length. */
function runOf(c: Corridor): number {
  return Math.hypot(c.bx - c.ax, c.bz - c.az);
}

/**
 * Sutherland-Hodgman against one half-plane: keep everything on the side `keep`
 * says, where the test value is the signed across-distance minus the corridor's
 * half width.
 */
function clipHalfPlane(
  points: Float32Array,
  test: (x: number, z: number) => number,
): Float32Array | null {
  const n = points.length / 2;
  if (n < 3) return null;
  const out: number[] = [];
  let px = points[(n - 1) * 2];
  let pz = points[(n - 1) * 2 + 1];
  let pd = test(px, pz);
  for (let i = 0; i < n; i++) {
    const cx = points[i * 2];
    const cz = points[i * 2 + 1];
    const cd = test(cx, cz);
    if (cd >= 0) {
      if (pd < 0) {
        const t = pd / (pd - cd);
        out.push(px + (cx - px) * t, pz + (cz - pz) * t);
      }
      out.push(cx, cz);
    } else if (pd >= 0) {
      const t = pd / (pd - cd);
      out.push(px + (cx - px) * t, pz + (cz - pz) * t);
    }
    px = cx;
    pz = cz;
    pd = cd;
  }
  if (out.length < 6) return null;
  return new Float32Array(out);
}

/**
 * The four pieces of a footprint that lie outside the corridor's rectangle:
 * left of it, right of it, short of it and past it.
 *
 * They overlap at the corners, and that is deliberate and free -- every one of
 * them is solid, so the union is what a body meets and a region claimed twice is
 * a region claimed once. Trimming them into a partition would cost four more
 * clips per piece to remove nothing anybody can walk through.
 */
function clipOutside(points: Float32Array, c: Corridor): Array<Float32Array> {
  const run = runOf(c);
  const out: Array<Float32Array> = [];
  const add = (p: Float32Array | null): void => {
    if (p !== null) out.push(p);
  };
  add(clipHalfPlane(points, (x, z) => acrossOf(c, x, z) - c.half));
  add(clipHalfPlane(points, (x, z) => -acrossOf(c, x, z) - c.half));
  add(clipHalfPlane(points, (x, z) => -alongOf(c, x, z) - RUN_OVERHANG_M));
  add(clipHalfPlane(points, (x, z) => alongOf(c, x, z) - (run + RUN_OVERHANG_M)));
  return out;
}

/** The part of a footprint inside the corridor's own rectangle. */
function clipToStrip(points: Float32Array, c: Corridor): Float32Array | null {
  const run = runOf(c);
  let p: Float32Array | null = clipHalfPlane(points, (x, z) => c.half - acrossOf(c, x, z));
  if (p === null) return null;
  p = clipHalfPlane(p, (x, z) => acrossOf(c, x, z) + c.half);
  if (p === null) return null;
  p = clipHalfPlane(p, (x, z) => alongOf(c, x, z) + RUN_OVERHANG_M);
  if (p === null) return null;
  return clipHalfPlane(p, (x, z) => run + RUN_OVERHANG_M - alongOf(c, x, z));
}

/** Shoelace, unsigned. */
export function polygonArea(points: Float32Array): number {
  let a = 0;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (points[j * 2] + points[i * 2]) * (points[j * 2 + 1] - points[i * 2 + 1]);
  }
  return Math.abs(a) / 2;
}

/**
 * The module's own self-check. Called by `server/integration-check.ts` and by the
 * client's boot self-checks; every string it returns is a failure.
 *
 * The negative controls are the point of it: a rule that cuts holes in buildings
 * has to be shown *not* firing on the building beside the corridor, or "no prism
 * intersects the envelope" is a claim about a world with no buildings in it.
 */
export function verifyEnvelope(): string[] {
  const bad: string[] = [];
  const env = new ClearanceEnvelope();
  // One straight railway along +x at y = 10.
  env.add({ ax: -50, az: 0, ay: 10, bx: 50, bz: 0, by: 10, half: RAIL_HALF_M, below: RAIL_BELOW_M, above: RAIL_ABOVE_M, rail: true });

  const box = (x0: number, z0: number, x1: number, z1: number): Float32Array =>
    new Float32Array([x0, z0, x1, z0, x1, z1, x0, z1]);

  // A shed 20 m square straddling the line, 12 m tall on a pad at 9 m.
  const straddle: Solid = { points: box(-10, -10, 10, 10), height: 12, base: 9, structural: false };
  const cut = env.carve(straddle);
  if (cut === null) {
    bad.push('a 20 m building straddling the line was not carved at all');
  } else {
    if (cut.length !== 3) bad.push(`a straddling building came out as ${cut.length} pieces, expected 3`);
    const lifted = cut.filter((p) => p.base > 9.5);
    if (lifted.length !== 1) bad.push(`expected exactly one raised span, got ${lifted.length}`);
    else {
      if (Math.abs(lifted[0].base - (10 + RAIL_ABOVE_M)) > 1e-4) {
        bad.push(`the raised span's base is ${lifted[0].base}, expected the envelope ceiling ${10 + RAIL_ABOVE_M}`);
      }
      if (!lifted[0].structural) bad.push('the raised span is not marked structural, so nothing may walk under it');
    }
    const grounded = cut.filter((p) => p.base <= 9.5);
    if (grounded.length !== 2) bad.push(`expected two grounded remnants, got ${grounded.length}`);
    for (const g of grounded) {
      // 20 m long by (10 - 3.6) m deep.
      const want = 20 * (10 - RAIL_HALF_M);
      if (Math.abs(polygonArea(g.points) - want) > 0.5) {
        bad.push(`a grounded remnant is ${polygonArea(g.points).toFixed(1)} m2, expected ${want.toFixed(1)}`);
      }
    }
  }

  // NEGATIVE CONTROL 1: the same shed, moved clear of the gauge. Untouched.
  const beside: Solid = { points: box(-10, 6, 10, 26), height: 12, base: 9, structural: false };
  if (env.carve(beside) !== null) bad.push('a building 6 m clear of the centreline was carved; the envelope is too fat');

  // NEGATIVE CONTROL 2: the same shed, straddling but well over the envelope --
  // a footbridge deck, which is what a raised piece is and must not be re-cut.
  const over: Solid = { points: box(-10, -10, 10, 10), height: 3, base: 10 + RAIL_ABOVE_M + 0.1, structural: true };
  if (env.carve(over) !== null) bad.push('a deck already clear over the envelope was carved again');

  // NEGATIVE CONTROL 3: a building under the line -- a basement beside a viaduct.
  const under: Solid = { points: box(-10, -10, 10, 10), height: 2, base: 10 - RAIL_BELOW_M - 2.1, structural: false };
  if (env.carve(under) !== null) bad.push('a solid entirely under the envelope floor was carved');

  // A footprint entirely inside the strip loses both flanks and keeps the span.
  const inside: Solid = { points: box(-4, -2, 4, 2), height: 20, base: 9, structural: false };
  const small = env.carve(inside);
  if (small === null || small.length !== 1 || !small[0].structural) {
    bad.push(`a footprint wholly inside the gauge should leave one raised span, got ${small === null ? 'nothing' : small.length}`);
  }

  // A short building with no room over the corridor loses the span rather than
  // keeping a slab of nothing, and keeps its flanks.
  const shallow: Solid = { points: box(-10, -10, 10, 10), height: 6, base: 9, structural: false };
  const flat = env.carve(shallow);
  if (flat === null || flat.some((p) => p.base > 12)) {
    bad.push('a building with no headroom over the envelope kept a degenerate raised span');
  }

  if (!env.contains(0, 12, 0)) bad.push('a point 2 m over the railhead on the centreline is not inside the envelope');
  if (env.contains(0, 12, 5)) bad.push('a point 5 m across from the centreline is inside the envelope');
  if (env.contains(0, 20, 0)) bad.push('a point 10 m over the railhead is inside the envelope');

  return bad;
}
