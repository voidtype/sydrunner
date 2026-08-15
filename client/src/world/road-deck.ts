/**
 * The carriageways, as the one thing that decides where the ground stays.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS FILE EXISTS FOR, IN THE PLAYER'S OWN WORDS.
 *
 *   > *"train at St Peters STILL covers the road at king st, it goes
 *   > underground but the assets still go onto the road and block it. Roads
 *   > should be uninterrupted everywhere."*
 *   > *"if i do jump onto the fenced section of road, i can fall through down
 *   > into the railroad, not good"*
 *
 * Those are one defect with two faces. The rail *height* at St Peters is right
 * -- the Illawarra pair clears King Street by 6.90 m and 7.59 m, measured -- and
 * lowering the track is what opened the hole: `world/rail-cut.RailCut` carves the
 * terrain along the whole corridor and has never heard of a road. So the carve
 * took the ground out from under King Street, the road ribbon was left hanging
 * over a trench with nothing solid in it, and the trench walls and the portal
 * gantry came up through the asphalt on either side of the gap. Measured on the
 * shipped build, before this file: a body walked south along King Street fell
 * **7.1 to 7.6 m** at every one of seven offsets across the 24 m of carriageway,
 * and was then stopped by a retaining wall whose prism top stood at -52.5 m --
 * road level.
 *
 * The rule the player has now stated twice, and which this file is:
 *
 *   > **roads are roads, railroads are railroads, and a road is uninterrupted
 *   > everywhere.**
 *
 * Wherever a paved carriageway is drawn, the ground under it is not removed. Not
 * "where OSM says bridge", not "where the clearance is over some threshold" --
 * wherever the road *is*, because the road ribbon is drawn there either way and a
 * drawn road with no ground under it is a hole a player falls through.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LANE SIDECAR AND NOT A NEW PIPELINE PRODUCT.
 *
 * `tiles.write_lanes` writes a **ways block** whose entire purpose is this kind
 * of consumer, and says so: *"the street network as reusable geometry --
 * centreline, solved height, kerb-to-kerb half width and the footpath band
 * beside it -- so that a pass which wants people walking the footpaths can derive
 * them ... from a file that already exists"*. Three properties make it the right
 * source and all three are load-bearing here:
 *
 *   - **`y` is absolute and it is the solved road surface**, not the DEM. A road
 *     over a cutting is at the height `roadgrade.py` put it, which is the height
 *     the ribbon is drawn at.
 *   - **A way span is clipped to its own tile.** Unlike a car route, which runs
 *     out of its tile by up to a kilometre, a way stops at the seam -- so a
 *     tile's roads are a fact about that tile and dropping the tile drops
 *     exactly them.
 *   - **Both ends decode the identical bytes.** `server/world.ts` reads the same
 *     file with the same `decodeLanes` and the same origin pair the browser uses.
 *     That is what lets the ground query agree on the two ends of the wire, which
 *     is the whole reason this is a shared module and not two rules.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing**, on `world/rail-cut.ts`' terms and for the same
 * reason: `server/world.ts` needs the identical answer to "is there a road over
 * this point" and a `Vector3` reaching in here would drag the renderer into a
 * process that draws nothing.
 *
 * ---------------------------------------------------------------------------
 * ON ORDER INDEPENDENCE, WHICH IS NOT A DETAIL.
 *
 * Tiles arrive in whatever order the network and the disk produce, and the two
 * ends never see the same order. `deckAt` therefore takes the **maximum** paved
 * surface over the strips covering a point, and a maximum over a set does not
 * depend on the order the set was built in -- so the browser and the server
 * compute the same float from the same bytes whatever sequence the sidecars
 * landed in. Anything order-sensitive here (a first-wins, a running average)
 * would be a ground height that differs by tile arrival order, which is the
 * flavour of desynchronisation that is impossible to reproduce.
 */

/**
 * How thick the deck a road is carried on is, metres.
 *
 * The distance from the paved surface down to the **soffit** -- the underside a
 * player standing in the cutting looks up at. It is what `world/terrain.ts`
 * offsets the soffit sheet by and what `world/rail-geo.writeTrench` clamps a
 * retaining wall to, so the wall stops under the deck it is holding up instead of
 * coming through the road.
 *
 * **0.45 m, and the number is bounded from both sides by things already built.**
 * Below: a slab thinner than this reads as paper from underneath, and the two
 * surfaces would z-fight wherever the terrain grid runs nearly flat. Above: the
 * catenary messenger wire is drawn at `rail-geo.MESSENGER_HEIGHT` = 6.35 m over
 * the railhead, and the *tightest* road clearance this has to survive is King
 * Street at St Peters at 6.90 m. A deck 0.55 m thick would put the soffit exactly
 * on the wire. 0.45 m leaves ten centimetres, which is the whole of the headroom
 * that exists there in reality too.
 *
 * The proper decked structure -- girders, bearings, an abutment with a parapet --
 * is `elevated.py` learning about railways, which is a world rebuild and is not
 * this round.
 */
export const DECK_THICKNESS_M = 0.45;

/**
 * How far over the ground foot paving is drawn, metres. `streets.FOOTPATH_Y`.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND HALF OF THE SAME DEFECT, AND WHY IT NEEDED A DIFFERENT SHAPE.
 *
 * The player reported the same three symptoms a third time, standing at
 * -33.907002, 151.181545 -- world (-2492.54, 4281.58), on the King Street
 * overbridge at St Peters:
 *
 *   > *"still a fence blocking the road on king st, i still fall through the
 *   > road and can still see rail components penetrating thru the road"*
 *
 * The carriageway rule above was working there: measured over the shipped build,
 * **0 m2 of King Street's carriageway is carved**. What was carved was the
 * *footway* -- 120 m2 of it within 60 m of that point, dropping up to 7.94 m --
 * because `streets.py:642` draws standalone foot paving and `lanes.py:602`
 * excludes exactly that class from the ways block this file is filled from. The
 * deck could not know it was there. Four ways: St Peter's Plaza (97 m2), the
 * **King Street Railway Bridge Path** (19 m2 -- the cycleway on the deck the
 * player was standing on), and two Sydney Park Road crossings (6 m2).
 *
 * The footprint now rides in `rail.bin`; see `RoadDeck.adoptPaving`.
 *
 * ---------------------------------------------------------------------------
 * WHY A PAVING STRIP CARRIES NO HEIGHT, AND THIS CONSTANT DOES.
 *
 * A carriageway has a height of its own -- `roadgrade.py` solves it and a bridge
 * deck stands above the ground -- so `.lanes.bin` carries one per point and
 * `deckAt` interpolates it. **Foot paving has no height of its own.**
 * `streets.py` drapes it: every square metre is `terrain.sample(x, z) +
 * FOOTPATH_Y`, so its surface *is* the ground plus this constant, and the only
 * processes that know the ground exactly are the two that load the terrain
 * sidecars -- this browser and `server/world.ts`.
 *
 * That is why `deckAt` takes a `groundY`. The alternative was to bake a height in
 * the pipeline, and it was measured and rejected: `rail.build_all` loads the DEM
 * **unconformed**, and against the shipped `.terr.bin` lattice at 15,149 foot
 * paving vertices near a corridor that surface differs by a median of 0.56 m and
 * a maximum of 29.66 m. A height from there would be a second opinion about the
 * ground inside the one file whose whole purpose is that there is only one.
 */
export const PAVING_RISE_M = 0.15;

/**
 * The narrowest a carriageway is taken to be, half-width in metres.
 *
 * `world/envelope.addRoads`' own floor, restated because it is the same
 * question: a laneway whose OSM width is a default of two metres still has a car
 * on it and still has a person walking across it, and a one-metre-wide deck over
 * a fifteen-metre cutting is a plank. Nothing in the shipped extract is actually
 * this narrow -- `streets.MIN_ROAD_WIDTH` already floors it -- so this only ever
 * catches a way whose sidecar predates that.
 */
const MIN_HALF_M = 1.5;

/**
 * And the same floor for a strip of foot paving, half-width in metres.
 *
 * Lower than `MIN_HALF_M` because the thing being described really is that
 * narrow: `streets.FOOTWAY_HALF_WIDTH` is 1.0 m, a two-metre ribbon, and
 * rounding a footway out to three would put a deck over a metre of open trench
 * either side of every path in the city. This only catches a bake that emitted
 * something narrower still.
 */
const MIN_PAVING_HALF_M = 1.0;

/** The grid cell strips are filed into, metres. `rail-cut.CELL_M`'s twin. */
const CELL_M = 64;

/**
 * One length of paved road, swept.
 *
 * `half` is the **paved** half-width, not the carriageway's: `streets.py` builds
 * the footpath band as `centreline.buffer(half_width + footpath_width)` and the
 * carriageway as `centreline.buffer(half_width)`, so the outer edge of everything
 * paved is the sum, and that is the edge a road bridge's parapet would stand on.
 * Taking only the carriageway would leave a slot of open trench between the kerb
 * and the fence line at every crossing in the city -- a hole exactly where a
 * pedestrian walks.
 */
interface Strip {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  half: number;
  /**
   * True where the surface is the ground plus `PAVING_RISE_M` rather than `ay`
   * and `by`, which are then unused. See `PAVING_RISE_M` and `adoptPaving`.
   *
   * A flag on the same record in the same list rather than a second collection,
   * and that is the whole point: `deckAt` stays one query over one set, so
   * `RailCut.cutAt` still asks exactly one question and there is no second
   * predicate that can disagree with the first.
   */
  draped: boolean;
}

/** What this module needs from `game/traffic.LaneWay`. Structural, as ever. */
export interface DeckWay {
  /** Centreline to kerb, metres. */
  halfWidth: number;
  /** The paved band beyond the kerb, metres. Zero on a motorway. */
  footpathWidth: number;
  count: number;
  x: Float32Array;
  /** **Absolute** metres: the solved road surface, not the DEM. */
  y: Float32Array;
  z: Float32Array;
}

/**
 * Every paved surface in the city, indexed by where it is, filed by tile.
 *
 * Filed by tile because that is the unit that arrives and leaves on both ends:
 * `streamer.dispose` drops a tile's traffic and its footpaths, and this goes with
 * them; `HexResidency`'s lane layer does the same per hexagon. A deck that never
 * dropped would be a slow leak of the whole extent into a process that only ever
 * needs the part near a player.
 */
export class RoadDeck {
  private readonly byKey = new Map<string, Strip[]>();
  private readonly cells = new Map<number, Strip[]>();

  /** How many tiles' worth of road this holds. */
  get tiles(): number {
    return this.byKey.size;
  }

  /** How many swept strips. */
  get count(): number {
    let n = 0;
    for (const strips of this.byKey.values()) n += strips.length;
    return n;
  }

  /**
   * Adopt one tile's ways. Idempotent: a tile already held is left alone, which
   * is `TerrainField.adopt`'s contract and for the same reason -- the answers
   * already given were given from what is there.
   *
   * Returns the plan bounding box of what was added, grown by `margin`, or
   * `null` when the tile contributed nothing. The box is what the streamer
   * re-cuts the ground over: a road arriving after a neighbouring tile's terrain
   * mesh was already built has to be able to close the hole in it.
   */
  adopt(
    key: string,
    ways: ReadonlyArray<DeckWay>,
    margin = 0,
  ): [number, number, number, number] | null {
    if (this.byKey.has(key)) return null;
    const strips: Strip[] = [];
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const way of ways) {
      const half = Math.max(MIN_HALF_M, way.halfWidth) + Math.max(0, way.footpathWidth);
      for (let i = 0; i + 1 < way.count; i++) {
        const ax = way.x[i];
        const az = way.z[i];
        const bx = way.x[i + 1];
        const bz = way.z[i + 1];
        // The same 5 cm floor `envelope.addRoads` and `RailCut`'s constructor
        // both use: a zero-length strip has no direction and its projection is
        // undefined, and the pipeline emits a few wherever two OSM nodes
        // coincide.
        if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
        strips.push({ ax, az, ay: way.y[i], bx, bz, by: way.y[i + 1], half, draped: false });
        if (ax - half < minX) minX = ax - half;
        if (bx - half < minX) minX = bx - half;
        if (ax + half > maxX) maxX = ax + half;
        if (bx + half > maxX) maxX = bx + half;
        if (az - half < minZ) minZ = az - half;
        if (bz - half < minZ) minZ = bz - half;
        if (az + half > maxZ) maxZ = az + half;
        if (bz + half > maxZ) maxZ = bz + half;
      }
    }
    // Recorded even when empty, so `adopt` stays idempotent for a tile with no
    // drivable street on it and `drop` has something to delete.
    this.byKey.set(key, strips);
    if (strips.length === 0) return null;
    for (const strip of strips) this.file(strip, true);
    return [minX - margin, minZ - margin, maxX + margin, maxZ + margin];
  }

  /**
   * Adopt the corridor's foot paving, straight out of `rail.bin`. Five floats a
   * strip: `ax, az, bx, bz, half`. Returns how many strips were taken.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS ONE CALL AT BOOT AND NOT A TILE LAYER.
   *
   * Everything else here arrives and leaves with a tile, because `.lanes.bin` is
   * a per-tile sidecar and a deck that never dropped would be a slow leak of the
   * whole extent. This does not: it is 12,161 strips for the entire 60 km build,
   * 238 kB, filed once from a file both ends already load in full, and it is
   * resident for the same reason `RailCut` itself is.
   *
   * That is not only a size argument, it is a **correctness** one. The bug this
   * fixes has a timing half: a `rail-geo` chunk decides once where its fence
   * panels go, so a chunk built before its street landed keeps a palisade across
   * the carriageway -- which is what `anyStrip` and `main.ts`' road sink exist to
   * repair. Paving that is present before the first chunk is built can never have
   * that problem, so there is nothing to repair.
   *
   * Filed under a fixed key so `adopt`'s idempotence covers it too: calling this
   * twice on one deck is a no-op rather than a double-filed strip list.
   */
  adoptPaving(paving: Float32Array): number {
    const key = 'rail:paving';
    if (this.byKey.has(key)) return 0;
    const strips: Strip[] = [];
    for (let i = 0; i + 4 < paving.length; i += 5) {
      const ax = paving[i];
      const az = paving[i + 1];
      const bx = paving[i + 2];
      const bz = paving[i + 3];
      // `adopt`'s 5 cm floor, for `adopt`'s reason. The pipeline drops these too;
      // this is the decoder refusing to trust that it did.
      if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
      const half = Math.max(MIN_PAVING_HALF_M, paving[i + 4]);
      // `ay`/`by` are never read on a draped strip -- `deckAt` takes the ground
      // instead -- and are set to NaN rather than to zero so that anything that
      // did read them would produce an obviously wrong answer rather than a
      // plausible one at the datum.
      strips.push({ ax, az, ay: Number.NaN, bx, bz, by: Number.NaN, half, draped: true });
    }
    this.byKey.set(key, strips);
    for (const strip of strips) this.file(strip, true);
    return strips.length;
  }

  /**
   * Walk one tile's strips until `over` accepts one, roughly every `stepM`.
   *
   * **The filter that keeps a late road from thrashing the rail chunk ring.**
   * A `world/rail-geo.RailWorld` chunk is built once and decides there and then
   * where its fence panels and retaining walls go, so a chunk built before its
   * street landed still has a palisade across the carriageway -- which is
   * exactly the frame the player photographed. The fix is to rebuild those
   * chunks, and the reason this method exists rather than a blanket rebuild is
   * that a chunk rebuild is the same work as a first build: doing it for all
   * three thousand tiles as they stream would thrash the ring for the whole of
   * the boot, to fix the few dozen tiles where a street actually crosses a
   * railway.
   *
   * Sampled rather than exact, and the step is safe because the only caller
   * probes `RailCut.near`, whose radius is `STATION_HALF_WIDTH` (9.4 m) plus the
   * pad it is given -- so a sample every eight metres cannot step over a
   * corridor.
   */
  anyStrip(
    key: string,
    over: (x: number, z: number, half: number) => boolean,
    stepM = 8,
  ): boolean {
    const strips = this.byKey.get(key);
    if (strips === undefined) return false;
    for (const s of strips) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      const steps = Math.max(1, Math.ceil(len / stepM));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (over(s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t, s.half)) return true;
      }
    }
    return false;
  }

  /** Give back one tile's roads. Safe for a key that was never adopted. */
  drop(key: string): void {
    const strips = this.byKey.get(key);
    if (strips === undefined) return;
    this.byKey.delete(key);
    for (const strip of strips) this.file(strip, false);
  }

  /** File or unfile one strip in every cell its swept box touches. */
  private file(strip: Strip, add: boolean): void {
    const x0 = Math.floor((Math.min(strip.ax, strip.bx) - strip.half) / CELL_M);
    const x1 = Math.floor((Math.max(strip.ax, strip.bx) + strip.half) / CELL_M);
    const z0 = Math.floor((Math.min(strip.az, strip.bz) - strip.half) / CELL_M);
    const z1 = Math.floor((Math.max(strip.az, strip.bz) + strip.half) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        const list = this.cells.get(k);
        if (add) {
          if (list) list.push(strip);
          else this.cells.set(k, [strip]);
          continue;
        }
        if (list === undefined) continue;
        const at = list.indexOf(strip);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) this.cells.delete(k);
      }
    }
  }

  /**
   * The paved surface over this point, or `NaN` where nothing is paved.
   *
   * The **highest** paved surface where several overlap, which is the answer
   * that matters at an interchange: a slip road under a flyover is a road and so
   * is the flyover, and the ground has to be kept up at the top of the stack or
   * the deck of the thing on top has a hole in it. Order-independent, which is
   * the property this whole file is arranged around -- see the header.
   *
   * ---------------------------------------------------------------------------
   * `groundY` IS AN ARGUMENT, AND IT IS REQUIRED. Both halves are deliberate.
   *
   * Foot paving is *draped*: `streets.py` puts it at `terrain.sample(x, z) +
   * FOOTPATH_Y`, so its surface is not a number this file can hold -- it is a
   * number the caller is already holding, and `world/rail-cut.ts`' header spends
   * a page on why the caller's own value is the only correct one to use ("not
   * against a second opinion sampled somewhere else, or the hole and the sheet it
   * is cut in disagree at the rim"). See `PAVING_RISE_M`.
   *
   * Required rather than defaulted to `NaN`, because a default is how a call site
   * that forgot it would quietly go on answering the carriageway question
   * correctly and the footway question wrongly -- which is the exact failure this
   * round is fixing, and it went unnoticed for three reports. With no default the
   * compiler finds every one of them. Passing `NaN` on purpose is still allowed
   * and still means "I do not know the ground here": draped strips then
   * contribute nothing and the answer degrades to the carriageways alone.
   */
  deckAt(x: number, z: number, groundY: number): number {
    const list = this.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (list === undefined) return Number.NaN;
    const draped = groundY + PAVING_RISE_M;
    const drapedKnown = Number.isFinite(draped);
    let best = Number.NaN;
    for (const s of list) {
      if (s.draped && !drapedKnown) continue;
      const ex = s.bx - s.ax;
      const ez = s.bz - s.az;
      const len2 = ex * ex + ez * ez;
      let t = 0;
      if (len2 > 1e-9) {
        t = ((x - s.ax) * ex + (z - s.az) * ez) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const dx = x - (s.ax + ex * t);
      const dz = z - (s.az + ez * t);
      if (dx * dx + dz * dz > s.half * s.half) continue;
      const y = s.draped ? draped : s.ay + (s.by - s.ay) * t;
      if (!(y <= best)) best = y;
    }
    return best;
  }

  /**
   * Every strip this deck holds, once each.
   *
   * For the audits and for nothing that draws. `checkPavedIntegrity` walks the
   * paving rather than sampling a disc around a coordinate, and it has to walk
   * the deck's **own** list: a sweep that rebuilt the footprint from the sidecars
   * would be asserting a second model of where paving is, which is the mistake
   * three rounds of green lights were made of.
   *
   * A visitor rather than an array because the whole extent is 37,000 strips and
   * the caller wants none of them kept.
   */
  eachStrip(
    visit: (
      ax: number, az: number, bx: number, bz: number,
      half: number, ay: number, by: number, draped: boolean,
    ) => void,
  ): void {
    // `adoptPaving` files the bake's foot paving under its own key in this same
    // map, so the corridor's footways come out of this walk too.
    for (const strips of this.byKey.values()) {
      for (const s of strips) visit(s.ax, s.az, s.bx, s.bz, s.half, s.ay, s.by, s.draped);
    }
  }

  /**
   * Is there any paved surface within `pad` of this point? The broad phase.
   *
   * Cell existence plus a distance test, `RailCut.near`'s shape exactly. Used by
   * the audits rather than by anything that draws: the hot path is `deckAt`, and
   * it is only ever reached from inside a rail corridor.
   */
  near(x: number, z: number, pad: number): boolean {
    const cx0 = Math.floor((x - pad) / CELL_M);
    const cx1 = Math.floor((x + pad) / CELL_M);
    const cz0 = Math.floor((z - pad) / CELL_M);
    const cz1 = Math.floor((z + pad) / CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (list === undefined) continue;
        for (const s of list) {
          const ex = s.bx - s.ax;
          const ez = s.bz - s.az;
          const len2 = ex * ex + ez * ez;
          let t = 0;
          if (len2 > 1e-9) {
            t = ((x - s.ax) * ex + (z - s.az) * ez) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
          }
          const dx = x - (s.ax + ex * t);
          const dz = z - (s.az + ez * t);
          const r = s.half + pad;
          if (dx * dx + dz * dz <= r * r) return true;
        }
      }
    }
    return false;
  }
}

function cellKey(cx: number, cz: number): number {
  // `rail-cut.cellKey`, to the bit. Two 20-bit signed fields; the world is 120 km
  // across at 64 m a cell, so the range is +/-940 cells and nothing collides.
  return (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
}

/**
 * The module's own self-check, on `verifyEnvelope`'s terms: the browser is not
 * in CI, and a self-check nothing runs is one that rots. Returns a list of
 * failures; empty is the healthy answer.
 *
 * Four properties, and each one is a way this could be wrong without looking
 * wrong:
 *
 *   1. A point on the centreline is covered, at the height the way carries.
 *   2. A point beyond the paved band is **not** covered -- if it were, the deck
 *      would swallow the trench for tens of metres either side of every road.
 *   3. The footpath band counts. A deck that stopped at the kerb leaves a slot
 *      of open cutting where a pedestrian walks.
 *   4. `drop` really gives the ground back, so a tile leaving does not leave a
 *      permanent lid over the railway.
 */
export function verifyRoadDeck(): string[] {
  const out: string[] = [];
  const deck = new RoadDeck();
  const way: DeckWay = {
    halfWidth: 6,
    footpathWidth: 2,
    count: 2,
    x: new Float32Array([0, 100]),
    y: new Float32Array([10, 20]),
    z: new Float32Array([0, 0]),
  };
  deck.adopt('t', [way]);
  // The ground, for the calls below. A carriageway's answer must not depend on
  // it at all, which is asserted directly at the end of §6.
  const G = 3;

  const mid = deck.deckAt(50, 0, G);
  if (!(Math.abs(mid - 15) < 1e-4)) out.push(`centreline midpoint reads ${mid}, expected 15`);
  if (!Number.isFinite(deck.deckAt(50, 7.5, G))) {
    out.push('a point 7.5 m off the centreline of a 6 + 2 m road is not covered');
  }
  if (Number.isFinite(deck.deckAt(50, 9, G))) {
    out.push('a point 9 m off the centreline of a 6 + 2 m road is covered and must not be');
  }
  if (Number.isFinite(deck.deckAt(-20, 0, G))) {
    out.push('a point 20 m off the end of a 100 m way is covered and must not be');
  }
  if (!deck.near(50, 12, 5)) out.push('near() misses a road 4 m outside the pad');
  deck.drop('t');
  if (Number.isFinite(deck.deckAt(50, 0, G))) out.push('drop() left the deck standing');
  if (deck.count !== 0 || deck.tiles !== 0) out.push('drop() left strips filed');

  // 5. Two tiles adopted in either order give the same answer. The header's
  //    order-independence claim, asserted rather than argued.
  const upper: DeckWay = { ...way, y: new Float32Array([30, 40]) };
  const a = new RoadDeck();
  a.adopt('lo', [way]);
  a.adopt('hi', [upper]);
  const b = new RoadDeck();
  b.adopt('hi', [upper]);
  b.adopt('lo', [way]);
  if (!Object.is(a.deckAt(50, 0, G), b.deckAt(50, 0, G))) {
    out.push(`two adoption orders give ${a.deckAt(50, 0, G)} and ${b.deckAt(50, 0, G)}`);
  }

  // 6. THE PAVING, and each of these is a way the draped strip could be wrong
  //    without looking wrong.
  //
  //    The geometry is the same negative-control shape as §1-§4: on the ribbon,
  //    off the ribbon, past the end. What is new is the *height*, and it has two
  //    properties nothing above can catch -- a draped surface tracks the ground
  //    it is given rather than any number stored here, and it vanishes rather
  //    than inventing a height when the ground is unknown. The second one is what
  //    keeps a chunk built before its terrain landed from claiming a deck at the
  //    datum, twenty metres under the city.
  const p = new RoadDeck();
  const took = p.adoptPaving(new Float32Array([0, 0, 40, 0, 1]));
  if (took !== 1) out.push(`adoptPaving took ${took} strips from a one-strip array`);
  if (p.adoptPaving(new Float32Array([0, 0, 40, 0, 1])) !== 0) {
    out.push('adoptPaving is not idempotent; a second call filed the strips again');
  }
  const on = p.deckAt(20, 0, 7);
  if (!(Math.abs(on - (7 + PAVING_RISE_M)) < 1e-6)) {
    out.push(`a draped strip over ground 7 reads ${on}, expected ${7 + PAVING_RISE_M}`);
  }
  const moved = p.deckAt(20, 0, -50);
  if (!(Math.abs(moved - (-50 + PAVING_RISE_M)) < 1e-6)) {
    out.push(`a draped strip does not follow its ground: reads ${moved} over -50`);
  }
  if (Number.isFinite(p.deckAt(20, 0, Number.NaN))) {
    out.push('a draped strip claims a surface where the ground is unknown');
  }
  if (Number.isFinite(p.deckAt(20, 1.5, 7))) {
    out.push('a point 1.5 m off the centreline of a 1 m half-width footway is covered');
  }
  if (Number.isFinite(p.deckAt(-10, 0, 7))) {
    out.push('a point 10 m off the end of a 40 m footway is covered');
  }
  //    ...and the two kinds in one deck: the carriageway wins where it is higher,
  //    the answer is still order-independent, and the road's own height is not
  //    disturbed by the ground it is asked about.
  const both = new RoadDeck();
  both.adopt('t', [way]);
  both.adoptPaving(new Float32Array([0, 0, 100, 0, 1]));
  const over = both.deckAt(50, 0, 0);
  if (!(Math.abs(over - 15) < 1e-4)) {
    out.push(`a road at 15 m under a footway draped on ground 0 reads ${over}, expected 15`);
  }
  const under = both.deckAt(50, 0, 100);
  if (!(Math.abs(under - (100 + PAVING_RISE_M)) < 1e-4)) {
    out.push(`a footway draped on ground 100 over a road at 15 reads ${under}`);
  }
  if (!Object.is(both.deckAt(50, 8, 0), 15)) {
    out.push(`the carriageway band answers ${both.deckAt(50, 8, 0)} where no paving reaches it`);
  }
  return out;
}
