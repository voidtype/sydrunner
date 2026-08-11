/**
 * Collision against the pipeline's prism payload.
 *
 * Spec section 5: collision is always the simplified prism, never derived from
 * render meshes at runtime. The pipeline emits `collision/<tile>.bin` for exactly
 * this, and the same file is what the authoritative server will load.
 *
 * Binary layout, little-endian. **Format v2** -- `base` is new, and it arrived
 * with terrain:
 *     u32  building count
 *     per building:
 *       f32       height    floor to roof
 *       f32       base      the pad the building stands on
 *       u16       vertex count
 *       f32[2n]   x, z pairs, tile-local metres
 *
 * A prism occupies **[base, base + height]**. Before terrain every building
 * stood on zero and the two were the same number; now a terrace on the Surry
 * Hills ridge has a base 40 m above one in Alexandria, and every height question
 * in this file has to say which of the two it means.
 *
 * ---------------------------------------------------------------------------
 * **A body is a band too, and that is what `base` finally bought.**
 *
 * `resolve` used to ask one question of a prism -- "are my feet at or above its
 * top?" -- and so every volume in the payload was solid from the ground up. For
 * a building that is correct and stays correct (see `structural` below). For the
 * 4,522 deck, viaduct and bridge volumes the pipeline writes with their `base`
 * at the **soffit** it was a wall twenty metres over the player's head: the
 * Western Distributor at Pyrmont, the Cahill at Circular Quay, the Bradfield
 * approaches, Anzac Bridge and the Harbour Bridge itself, all of them written by
 * `decks.py` to be walked under ("`base` at the soffit puts the volume over a
 * player's head so they walk under it") and all of them stopping a player at
 * street level. It is the "invisible wall at Broadway heading towards the city".
 *
 * So the rule is now an overlap of two intervals rather than one comparison. A
 * prism blocks a body when the body's own vertical extent `[feetY, headY]`
 * overlaps the prism's `[base, top)`:
 *
 *     blocked  <=>  feetY < top - 0.05  &&  headY > base
 *
 * The first clause is exactly the test that was here before, epsilon included,
 * so a kerb whose top is inside the caller's step tolerance is still climbed
 * rather than walked into. The second is new and is the whole change. Half-open
 * at the top: a head exactly at the soffit clears it.
 *
 * See `resolve` for what `headY` defaults to and why the two ends of a body are
 * the caller's to state.
 *
 * **Nothing on the wire changed and nothing needed to.** The payload is byte for
 * byte the format it was, the protocol version is untouched, and the flag that
 * decides a soffit from a pad is recovered from the index's building count on
 * both ends. What a deploy does have is a window: a server restarted with this
 * rule while a browser tab is still predicting with the old one will mispredict
 * under every bridge, because the client thinks it is stopped where the server
 * walks on. It resolves itself -- reconciliation snaps the player to the
 * authoritative position, so the symptom is a rubber-band under a viaduct and
 * not a desync, and it ends when the tab is reloaded. Deliberately not given a
 * `BYE`-and-version path: that one is for a protocol the client cannot speak,
 * and this is a client that speaks it correctly and disagrees about a wall.
 *
 * There is no version word in the payload, deliberately -- see
 * `tiles.write_collision` for the argument. The short version is that the two
 * ends of this format ship together and a v1 file read as v2 misparses on the
 * first building rather than producing subtly wrong heights, so a stale file
 * announces itself. Re-emit every tile when this changes.
 */

export interface Prism {
  /** World-space polygon, flattened x,z pairs. */
  points: Float32Array;
  /** Floor-to-roof, metres. */
  height: number;
  /** Ground height of the building's pad, metres. */
  base: number;
  /** `base + height`: the roof, in world y. Precomputed; it is asked for often. */
  top: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /**
   * Is this a **structure** rather than a building -- a deck, a viaduct, a
   * bridge span, a landmark podium?
   *
   * `tiles.write_collision` writes the `extra` records (`landmarks.Prism`: every
   * `decks.py` segment and parapet, the Harbour Bridge's deck, the Opera House
   * podium, the tower's stalk) **before** the buildings, in one array under one
   * count word. So the split is positional and exact, and it is recoverable here
   * for nothing: the index already carries the tile's building count, and
   * anything ahead of the last `b` records is a structure. See `addTile`.
   *
   * **`resolve` reads this, and it is the one flag that decides whether `base`
   * is a soffit or a bookkeeping number.** It did not, once, and the comment
   * here said so; what changed is that the walk-under rule is only true for one
   * of the two kinds, and for exactly the reason `world/invisible-walls.ts`
   * already had to tell them apart:
   *
   *   - A **structure** is drawn at its own elevation with open air underneath.
   *     Its `base` is the soffit, `decks.py` only lifts it off the ground where
   *     there is `WALK_UNDER_M` (2.6 m) of room, and the volume between the
   *     terrain and that soffit is meant to be walked through.
   *   - A **building** is drawn from its pad *down* to the terrain: `mesh.py`
   *     runs every wall from `base_y - skirt` with the skirt sized per building
   *     to meet the ground. Its `base` is a pad, not a soffit, and there is no
   *     air under it -- **39% of the 61,068 buildings in this build clear the
   *     sampled terrain over their own footprint by more than 1.8 m**, so a
   *     walk-under rule applied to them would open a player-high hole along the
   *     downhill wall of two buildings in five. That is the same measurement
   *     `invisible-walls.ts` uses to argue the classes cannot be told apart
   *     geometrically, read the other way round.
   *
   * So a building is still solid from its top to the ground, exactly as it was,
   * and only a structure gets the band. `false` on a tile whose caller did not
   * pass a building count -- the conservative answer in both directions now,
   * since it claims no air under anything.
   */
  structural: boolean;
  /**
   * `prismsWithin`'s visit stamp, and nothing else's -- see it for the argument.
   *
   * On the record rather than in a `Set` beside it because a building 15 m
   * across is filed in one to four of the 32 m grid's cells, so a query that
   * scans a hundred cells meets a few thousand prisms and has to reject the
   * repeats. An integer compare on a field that is already in cache is free
   * where a `Set` of a few thousand object identities is a tenth of a
   * millisecond, and this runs fifteen times a second next to a frame.
   */
  seen: number;
  /**
   * The envelope version this record was last cut against. See
   * `world/envelope.ClearanceEnvelope.cellVersion`.
   *
   * Corridors arrive over a session -- the railway at boot, the carriageways
   * with each hexagon of lane graph -- so `setEnvelope` runs again and again
   * over a world that is mostly already carved. This is what makes the second
   * and every later pass free: a prism whose cells have gained no corridor
   * since it was cut is skipped for four map lookups instead of five polygon
   * clips per corridor in reach.
   */
  carveStamp: number;
}

/**
 * How far the top of a standing body is over its own feet, metres.
 *
 * 1.8, and it is not a fresh guess: it is the number the *pipeline* already
 * models the player with. `cli.WALKABLE_UNDER_M` is derived from it in as many
 * words -- "the controller's capsule is 1.8 m and it steps 0.42 m without help,
 * so anything whose base is over 2.2 m is out of reach from the road below it
 * even standing on the kerb" -- and `decks.WALK_UNDER_M` is the 2.6 m a deck is
 * *built* to, chosen to clear the same 1.8 m player with room to jump. Three
 * numbers in a line, each with slack over the next, and this is the bottom of
 * it: the geometric height of the thing that has to fit.
 *
 * Deliberately a shade over `controller.EYE_HEIGHT` (1.68) rather than equal to
 * it -- the eye is not the top of the head -- and deliberately declared here
 * rather than imported from the controller, because this file is the shared
 * authority and must not depend on the one caller that happens to be a person.
 */
export const BODY_HEIGHT_M = 1.8;

/**
 * The coarse cell a *tile* is filed under, metres. See `tileCells`.
 *
 * A tile is 500 m on this build, so one cell holds four of them and a re-carve
 * over a hexagon of carriageways visits a handful rather than the city.
 */
const TILE_CELL_M = 1024;

function tileCellKey(cx: number, cz: number): number {
  return (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
}

/**
 * The one method a body being *moved* needs from a world, as an interface.
 *
 * `CollisionWorld` satisfies it structurally and every existing caller is
 * unchanged. It exists because a second kind of world turned up that has no
 * prisms and no grid and is nonetheless a thing a player walks around inside:
 * the carriage of a train (`game/riding.carriageResolve`), which is six clamps
 * in the carriage's own frame. `controller.step` and `combat.ragdollStep` take
 * this rather than the class, so the integrator has no opinion about which one
 * it is holding -- which is what lets a rider be stepped by the identical
 * function the server, the client and the reconciler's replay all run.
 *
 * Deliberately **only** `resolve`. Everything else `CollisionWorld` offers --
 * `blocked`, `roofHeight`, the tile lifecycle -- is a question about the *city*,
 * and `game/combat.pickRespawn` still takes the real class for exactly that
 * reason: choosing a respawn point inside a moving train is not a thing.
 */
/**
 * What a `CollisionWorld` needs from `world/envelope.ClearanceEnvelope`.
 *
 * A structural type rather than the class, so this file keeps importing nothing:
 * it is the shared authority every other module depends on, and a cycle through
 * the envelope -- which the server, the browser and three checks all construct
 * differently -- would be a cycle through half the world.
 */
export interface PrismCarver {
  /** The newest corridor over this plan box. See `Prism.carveStamp`. */
  stampFor(minX: number, minZ: number, maxX: number, maxZ: number): number;
  carve(
    solid: { points: Float32Array; height: number; base: number; structural: boolean },
    tally?: CarveCount,
  ): Array<{ points: Float32Array; height: number; base: number; structural: boolean }> | null;
}

/** Running total of what the envelope has taken out of a world. */
export interface CarveCount {
  tested: number;
  cut: number;
  pieces: number;
  dropped: number;
  emptied: number;
}

export interface MoveResolver {
  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    radius: number,
    feetY: number,
    headY?: number,
  ): { x: number; z: number; hit: boolean };
}

/** Uniform grid over prisms, so a move query touches only nearby buildings. */
export class CollisionWorld implements MoveResolver {
  private readonly cells = new Map<string, Prism[]>();
  private readonly cellSize: number;
  /**
   * The corridors nothing may stand in, or `null` where nothing has said.
   *
   * **The one rule this class enforces that is not about a body.** A building
   * whose footprint covers a railway or a carriageway is a wall across a route
   * that has to stay open, and the fix the user asked for is not to delete it:
   *
   *   > *"no building should EVER cover a road nor a railroad. put a tunnel thru
   *   > any building like that at the very least."*
   *
   * So a prism arriving over a corridor is **split** -- see
   * `world/envelope.ClearanceEnvelope.carve` -- into the part either side, still
   * grounded, and the part over it, carried on a raised `base` exactly as a
   * viaduct deck is. Nothing else in this file changes: the raised piece is
   * `structural`, and `solidFor` has honoured a soffit since the walk-under
   * round.
   *
   * Held rather than applied once because the corridors arrive over a session:
   * the railway is in the bake at boot, the roads come with the lane sidecars
   * per hexagon. See `recarve`.
   */
  private envelope: PrismCarver | null = null;
  /** What the envelope has done to this world, cumulative. For the log. */
  readonly carved: CarveCount = { tested: 0, cut: 0, pieces: 0, dropped: 0, emptied: 0 };
  /**
   * Every resident tile, and the prisms it put in the grid.
   *
   * A `Map` rather than the `Set` this was, and the list is the whole reason:
   * `removeTile` has to find a tile's own records among a grid that mixes every
   * tile's together, and the only alternatives are a tile tag on each `Prism`
   * (a field on a record this class hands out by reference, read by four
   * modules) or a scan of every cell in the world. The list costs one array of
   * a few hundred references per tile and makes the eviction a walk over
   * exactly what that tile added.
   *
   * The server never removes anything -- `server/world.ts` loads all 372 tiles
   * at boot and holds them for the process -- so on that side this is the old
   * `Set` with a payload nobody reads.
   */
  private readonly tiles = new Map<string, Prism[]>();
  /**
   * Each tile's plan bounding box, so a bounded re-carve can skip it for four
   * compares instead of walking its prisms.
   *
   * Cached rather than derived, and it is the difference between a boot that
   * finishes and one that does not: the server adopts a hexagon of carriageways
   * fourteen thousand times, each of them re-offering the tiles that overlap it,
   * and recomputing a box from seventy-five polygons every time is a million
   * point reads per hexagon. See `setEnvelope`.
   */
  private readonly tileBox = new Map<string, [number, number, number, number]>();
  /**
   * Tiles by coarse cell, so a bounded re-carve visits the handful it overlaps.
   *
   * A second index over the same fourteen thousand keys, and it is the
   * difference between a server boot of half a minute and one that never
   * finishes: without it every hexagon of arriving carriageways walked the whole
   * resident set to reject it, which is fourteen thousand squared.
   */
  private readonly tileCells = new Map<number, Set<string>>();
  private count = 0;
  /** `prismsWithin`'s query counter. See `Prism.seen`. */
  private visit = 0;

  constructor(cellSize = 32) {
    this.cellSize = cellSize;
  }

  get buildingCount(): number {
    return this.count;
  }

  hasTile(key: string): boolean {
    return this.tiles.has(key);
  }

  /**
   * Decode one tile's collision payload and index it.
   *
   * `buildingCount` is the index's own `b` for this tile, and it is optional
   * because it buys nothing any collision answer needs -- it only separates the
   * structures from the buildings, for `Prism.structural`. Passing it is what
   * lets `world/invisible-walls.ts` name a deck without re-fetching or
   * re-parsing anything; leaving it out marks every prism a building, which is
   * what every caller got before this existed.
   *
   * Undercounting is the safe direction and is the reason this is a subtraction
   * rather than a flag per record: an index written before decks existed carries
   * a `b` equal to the whole payload, so `total - b` is zero and nothing is
   * claimed to be a structure.
   */
  addTile(
    key: string,
    buffer: ArrayBuffer,
    offsetX: number,
    offsetZ: number,
    buildingCount?: number,
  ): number {
    if (this.tiles.has(key)) return 0;
    const mine: Prism[] = [];
    this.tiles.set(key, mine);

    const view = new DataView(buffer);
    let p = 0;
    const total = view.getUint32(p, true);
    p += 4;
    // Clamped at zero: a `b` larger than the payload is a stale index against a
    // fresh tile, and the honest reading of that is "nothing here is a
    // structure" rather than a negative prefix that marks the whole tile.
    const structuralCount =
      buildingCount === undefined ? 0 : Math.max(0, Math.min(total, total - buildingCount));

    let added = 0;
    for (let i = 0; i < total; i++) {
      if (p + 10 > buffer.byteLength) break;
      const height = view.getFloat32(p, true);
      p += 4;
      const base = view.getFloat32(p, true);
      p += 4;
      const n = view.getUint16(p, true);
      p += 2;
      if (p + n * 8 > buffer.byteLength) break;

      const points = new Float32Array(n * 2);
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < n; v++) {
        const x = view.getFloat32(p, true) + offsetX;
        p += 4;
        const z = view.getFloat32(p, true) + offsetZ;
        p += 4;
        points[v * 2] = x;
        points[v * 2 + 1] = z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const prism: Prism = {
        points,
        height,
        base,
        top: base + height,
        minX,
        minZ,
        maxX,
        maxZ,
        structural: i < structuralCount,
        seen: 0,
        carveStamp: 0,
      };
      // The undercroft, before anything is indexed: a building over the railway
      // arrives here as one solid and goes into the grid as a tunnel through
      // itself. See `envelope`.
      for (const piece of this.split(prism)) {
        this.insert(piece);
        mine.push(piece);
        added++;
        this.count++;
      }
    }
    this.rebox(key, mine);
    return added;
  }

  /**
   * One prism, as the envelope leaves it. The identity when nothing is set.
   *
   * Allocation-free in the common case -- `carve` answers `null` for anything
   * whose bounding box no corridor reaches, which is every building in the city
   * bar a few hundred -- and the single-element array is only built for the ones
   * that were actually cut.
   */
  private split(prism: Prism): Prism[] {
    if (this.envelope === null) return [prism];
    const stamp = this.envelope.stampFor(prism.minX, prism.minZ, prism.maxX, prism.maxZ);
    prism.carveStamp = stamp;
    const pieces = this.envelope.carve(prism, this.carved);
    if (pieces === null) return [prism];
    const out: Prism[] = [];
    for (const piece of pieces) out.push(recordFor(piece, stamp));
    return out;
  }

  /**
   * Adopt the corridor set, and cut it out of everything already resident.
   *
   * Idempotent under repetition and under order: carving a piece by a corridor
   * it is already clear of answers `null`, so calling this again when a hexagon
   * of lane graph lands does the new corridors and leaves the old work alone.
   * That is what lets the browser and the server -- which learn about the same
   * road at different moments -- converge on the same holes.
   *
   * `bounds` narrows the sweep to a plan box, which is what an arriving hexagon
   * has; without it every resident tile is re-examined, which is a boot-time
   * cost on the server and never a per-frame one.
   */
  setEnvelope(envelope: PrismCarver, bounds?: readonly [number, number, number, number]): number {
    this.envelope = envelope;
    let changed = 0;
    for (const key of this.tilesIn(bounds)) {
      const mine = this.tiles.get(key);
      if (mine === undefined) continue;
      let any = false;
      const next: Prism[] = [];
      for (const prism of mine) {
        // Nothing new anywhere over this footprint since it was last cut. See
        // `Prism.carveStamp` -- this is the clause that makes the fourteen
        // thousandth hexagon cost the same as the first.
        const stamp = this.envelope.stampFor(prism.minX, prism.minZ, prism.maxX, prism.maxZ);
        if (prism.carveStamp >= stamp) {
          next.push(prism);
          continue;
        }
        prism.carveStamp = stamp;
        const pieces = this.envelope.carve(prism, this.carved);
        if (pieces === null) {
          next.push(prism);
          continue;
        }
        any = true;
        for (const piece of pieces) next.push(recordFor(piece, stamp));
      }
      if (!any) continue;
      changed++;
      // Out of the grid and back in. The tile's own list is the only record of
      // what it put there, which is exactly what `removeTile` relies on.
      this.removeTile(key);
      this.tiles.set(key, next);
      for (const prism of next) {
        this.insert(prism);
        this.count++;
      }
      this.rebox(key, next);
    }
    return changed;
  }

  /** Remember a tile's plan extent, and file it. See `tileBox` and `tileCells`. */
  private rebox(key: string, mine: readonly Prism[]): void {
    this.unbox(key);
    if (mine.length === 0) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of mine) {
      if (p.minX < minX) minX = p.minX;
      if (p.maxX > maxX) maxX = p.maxX;
      if (p.minZ < minZ) minZ = p.minZ;
      if (p.maxZ > maxZ) maxZ = p.maxZ;
    }
    this.tileBox.set(key, [minX, minZ, maxX, maxZ]);
    for (let cx = Math.floor(minX / TILE_CELL_M); cx <= Math.floor(maxX / TILE_CELL_M); cx++) {
      for (let cz = Math.floor(minZ / TILE_CELL_M); cz <= Math.floor(maxZ / TILE_CELL_M); cz++) {
        const k = tileCellKey(cx, cz);
        const set = this.tileCells.get(k);
        if (set) set.add(key);
        else this.tileCells.set(k, new Set([key]));
      }
    }
  }

  private unbox(key: string): void {
    const box = this.tileBox.get(key);
    if (box === undefined) return;
    this.tileBox.delete(key);
    for (let cx = Math.floor(box[0] / TILE_CELL_M); cx <= Math.floor(box[2] / TILE_CELL_M); cx++) {
      for (let cz = Math.floor(box[1] / TILE_CELL_M); cz <= Math.floor(box[3] / TILE_CELL_M); cz++) {
        const k = tileCellKey(cx, cz);
        const set = this.tileCells.get(k);
        if (set === undefined) continue;
        set.delete(key);
        if (set.size === 0) this.tileCells.delete(k);
      }
    }
  }

  /** Which tiles overlap this plan box. Every tile, when there is no box. */
  private tilesIn(bounds?: readonly [number, number, number, number]): string[] {
    if (bounds === undefined) return [...this.tiles.keys()];
    const out: string[] = [];
    const seen = new Set<string>();
    for (let cx = Math.floor(bounds[0] / TILE_CELL_M); cx <= Math.floor(bounds[2] / TILE_CELL_M); cx++) {
      for (let cz = Math.floor(bounds[1] / TILE_CELL_M); cz <= Math.floor(bounds[3] / TILE_CELL_M); cz++) {
        const set = this.tileCells.get(tileCellKey(cx, cz));
        if (set === undefined) continue;
        for (const key of set) {
          if (seen.has(key)) continue;
          seen.add(key);
          const box = this.tileBox.get(key);
          if (box === undefined) continue;
          if (box[0] > bounds[2] || box[2] < bounds[0] || box[1] > bounds[3] || box[3] < bounds[1]) continue;
          out.push(key);
        }
      }
    }
    return out;
  }

  /**
   * Drop one tile's prisms out of the grid. Returns how many went.
   *
   * **The client half of a lifetime that used to have only one end.** Nothing
   * ever removed a tile from this world: `main.ts` fetches collision on a 420 m
   * ring and the map only grew, while `TileStreamer` drops a tile's *geometry*
   * the moment it leaves the 1,800 m render radius. So every tile the player
   * had ever been near kept its prisms for the session, and any of them they
   * walked far enough from lost its geometry -- which makes a return trip a
   * guaranteed block of solid, invisible city. Measured on the shipped build:
   * 676 walls across 6 tiles, every lap, with no network fault in it at all.
   *
   * **This is not a decision this class makes.** It is safety-critical to drop
   * the ground out from under somebody, so the *when* lives in
   * `world/tile-lifecycle.ts` beside the radius it is compared against, and the
   * only caller is the streamer's own eviction path, which asks
   * `mayEvictCollision` first. Calling this for a tile the player is standing
   * in is a player falling through the world, and nothing in here can tell.
   *
   * Idempotent, and safe against a re-add: `addTile` re-decodes the payload
   * from scratch, so a tile that leaves and comes back is fresh records in
   * fresh cells rather than anything resurrected.
   *
   * The cell arithmetic is `insert`'s, run backwards. Recomputed rather than
   * remembered because it is a floor of a bound this record already carries and
   * a cached cell list would be a second copy of the same fact that could
   * disagree with the first. A prism 15 m across lands in one to four of the
   * 32 m cells, so this is a handful of short splices per building.
   */
  removeTile(key: string): number {
    const mine = this.tiles.get(key);
    if (mine === undefined) return 0;
    this.tiles.delete(key);
    this.unbox(key);
    const c = this.cellSize;
    for (const prism of mine) {
      for (let cx = Math.floor(prism.minX / c); cx <= Math.floor(prism.maxX / c); cx++) {
        for (let cz = Math.floor(prism.minZ / c); cz <= Math.floor(prism.maxZ / c); cz++) {
          const k = `${cx},${cz}`;
          const list = this.cells.get(k);
          if (list === undefined) continue;
          const at = list.indexOf(prism);
          if (at >= 0) list.splice(at, 1);
          // Emptied cells go, rather than being left as empty arrays: the grid
          // is keyed by string and a player who has crossed the city leaves
          // tens of thousands of them behind, every one of them a `Map` entry
          // `near` has to miss on.
          if (list.length === 0) this.cells.delete(k);
        }
      }
    }
    this.count -= mine.length;
    return mine.length;
  }

  /**
   * Index a set of prisms that never came off the wire, under a key
   * `removeTile` can take back.
   *
   * **Everything else in this class arrives as a tile payload the pipeline
   * wrote, and the railway does not.** `world/rail-geo.ts` builds viaduct decks,
   * piers, station platforms and underground station boxes on the client, out of
   * the rail bake, and they have to be solid for the same reason the road decks
   * are: a deck the player falls through is worse than no deck, and a viaduct
   * you cannot walk under is the whole thing that round was for. Routing them
   * through an encode/decode round trip purely to reuse `addTile` would put a
   * second writer of the payload format in the client -- which is exactly the
   * mistake `encodeCheckPayload`'s own comment refuses to make.
   *
   * `base` semantics are the caller's and are honoured here unchanged: a deck
   * passes its soffit and is walked under, a pier passes ground level and is
   * walked into. See this file's header.
   *
   * Same key discipline as `addTile`: a key already resident is a no-op, so a
   * caller that rebuilds a chunk must `removeTile` first.
   */
  addPrisms(
    key: string,
    prisms: ReadonlyArray<{ points: Float32Array; height: number; base: number }>,
  ): number {
    if (this.tiles.has(key)) return 0;
    const mine: Prism[] = [];
    this.tiles.set(key, mine);
    for (const source of prisms) {
      const points = source.points;
      if (points.length < 6) continue;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < points.length; v += 2) {
        const x = points[v];
        const z = points[v + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const prism: Prism = {
        points,
        height: source.height,
        base: source.base,
        top: source.base + source.height,
        minX,
        minZ,
        maxX,
        maxZ,
        // Structural, like every deck and pier the pipeline writes: this is what
        // `Prism.structural` means and what stops `world/invisible-walls.ts`
        // counting a viaduct as a building.
        structural: true,
        seen: 0,
        carveStamp: 0,
      };
      // Deliberately **not** carved. Everything on this path is the railway's own
      // solids -- a viaduct deck, a platform, a stair -- and the envelope is the
      // railway's own volume, so cutting a corridor out of a platform would take
      // the station apart to make room for the train it serves. `rail-geo.ts`
      // consults the envelope itself, at the one place it matters: which side of
      // a formation a platform may stand on. See `writePlatforms`.
      this.insert(prism);
      mine.push(prism);
      this.count++;
    }
    this.rebox(key, mine);
    return mine.length;
  }

  /** How many tiles' prisms are resident. For the overlay and the checks. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Which ones, as a fresh array. A console and check tool, not a per-frame one. */
  residentTiles(): string[] {
    return [...this.tiles.keys()];
  }

  private insert(prism: Prism): void {
    const c = this.cellSize;
    for (let cx = Math.floor(prism.minX / c); cx <= Math.floor(prism.maxX / c); cx++) {
      for (let cz = Math.floor(prism.minZ / c); cz <= Math.floor(prism.maxZ / c); cz++) {
        const k = `${cx},${cz}`;
        const list = this.cells.get(k);
        if (list) list.push(prism);
        else this.cells.set(k, [prism]);
      }
    }
  }

  /** Every prism whose bounds could contain a circle of `radius` at (x, z). */
  private near(x: number, z: number, radius: number): Prism[] {
    const c = this.cellSize;
    const out: Prism[] = [];
    const seen = new Set<Prism>();
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (seen.has(prism)) continue;
          seen.add(prism);
          out.push(prism);
        }
      }
    }
    return out;
  }

  /**
   * Every prism within `radius` of (x, z), for a reader that wants the
   * *buildings* rather than a collision answer.
   *
   * `near` above is the collision path's own query and is deliberately not this:
   * it takes the union of whole grid cells, so at a 160 m radius it would return
   * everything in a 384 m box and leave the caller to reject a fifth of it, and
   * it allocates an array and a `Set` on every call. This is the same walk with
   * the two things a per-frame reader needs -- the prism's own bounds tested
   * against the query disc, and an `out` array the caller owns and reuses.
   *
   * The test is the closest point of the prism's AABB to the centre, which is
   * `main.ts`'s own tile test at building scale: a footprint whose box merely
   * touches the disc is inside it, and one in the corner of the bounding square
   * is not.
   *
   * What this exists for is `minimap.ts`, whose 160 m is comfortably inside the
   * 420 m ring `main.ts` keeps loaded, so the answer is always complete and
   * never has to wait on a fetch. Nothing here mutates anything a caller can
   * see -- the prisms are handed out by reference because they are immutable
   * once decoded and copying a few thousand polygons at 15 Hz would be the most
   * expensive thing on the map.
   */
  prismsWithin(x: number, z: number, radius: number, out: Prism[] = []): Prism[] {
    out.length = 0;
    const c = this.cellSize;
    const r2 = radius * radius;
    // Pre-incremented, so the value on a prism from any earlier query can never
    // match this one and no clearing pass is needed.
    const stamp = ++this.visit;
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (prism.seen === stamp) continue;
          prism.seen = stamp;
          const dx = Math.max(prism.minX - x, 0, x - prism.maxX);
          const dz = Math.max(prism.minZ - z, 0, z - prism.maxZ);
          if (dx * dx + dz * dz > r2) continue;
          out.push(prism);
        }
      }
    }
    return out;
  }

  /**
   * Slide a capsule of `radius` from `from` to `to` in the XZ plane.
   *
   * Resolves by pushing out along the wall normal and re-testing, which produces
   * sliding along a facade rather than sticking. Two passes handles the inside of
   * a corner, where the first push can move the player into the other wall.
   *
   * Returns the resolved position. `feetY` and `headY` are the two ends of the
   * body and they decide whether a prism is in the way at all: you can stand on
   * top of a low building and walk over it, and you can walk *under* a deck
   * whose soffit is over your head.
   *
   * **The two ends are the caller's to state, and they are not the same
   * question.** `feetY` is a *probe* height and every caller here already lifts
   * it by the step it is allowed to climb -- `controller.step` passes
   * `feet + STEP_HEIGHT` so a kerb is climbed rather than walked into, and the
   * placement probes pass `ground + 0.42` for the same reason. Lifting the head
   * by that step as well would make the clearance a body needs 2.22 m rather
   * than its own 1.8 m, which is over `cli.WALKABLE_UNDER_M` -- the pipeline's
   * audit would be calling a volume walk-under while this file called it a wall.
   * So `headY` defaults to `feetY + BODY_HEIGHT_M`, which is right for a probe
   * asking "is a body free to stand here, kerb and all", and the two callers
   * whose body is not a standing person say so:
   *
   *   - `player/controller.ts` passes `feet + BODY_HEIGHT_M` from the *unlifted*
   *     feet. It is the one caller the pipeline's audit is written against, and
   *     it is the one that has to clear every soffit the audit excuses.
   *   - `game/footy.ts` and `main.ts`'s chase camera pass `headY === feetY`: a
   *     ball and a camera boom are points, and asking either to carry a 1.8 m
   *     head would stop the ball under a span and snap the camera in under the
   *     Cahill.
   *
   * Everything else takes the default from its own already-lifted probe and so
   * asks for 2.22 m (2.1 m for `game/wildlife.ts`, which lifts by 0.3): the
   * police, the street factions, the animals, a knocked-out body, and the four
   * placement probes that ask whether a spawn, a bike or a respawn ring is
   * clear. That is deliberately the strictest reading in the file and it costs
   * nothing real -- `decks.WALK_UNDER_M` builds every soffit in the city to
   * 2.6 m, so an officer still follows a player under the Cahill, and a spawn
   * point under a viaduct is refused only where the viaduct is within 40 cm of
   * being a wall anyway.
   */
  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    radius: number,
    feetY: number,
    headY: number = feetY + BODY_HEIGHT_M,
  ): { x: number; z: number; hit: boolean } {
    let x = toX;
    let z = toZ;
    let hit = false;

    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const prism of this.near(x, z, radius)) {
        if (!this.solidFor(prism, feetY, headY, fromX, fromZ)) continue;
        if (
          x + radius < prism.minX ||
          x - radius > prism.maxX ||
          z + radius < prism.minZ ||
          z - radius > prism.maxZ
        ) {
          continue;
        }
        const push = pushOut(prism.points, x, z, radius);
        if (push) {
          x = push.x;
          z = push.z;
          hit = true;
          moved = true;
        }
      }
      if (!moved) break;
    }

    // If resolution failed to find a free spot, refuse the move rather than
    // letting the player through a wall. It has to ask the *same* question the
    // push loop asked, `from` included -- a guard that read a prism as solid
    // when the loop had exempted it would return the player to `from` on every
    // tick they spent under a bridge, which is a freeze rather than a wall.
    if (hit && this.overlaps(x, z, radius, feetY, headY, fromX, fromZ)) {
      return { x: fromX, z: fromZ, hit: true };
    }
    return { x, z, hit };
  }

  private overlaps(
    x: number,
    z: number,
    radius: number,
    feetY: number,
    headY: number,
    fromX: number,
    fromZ: number,
  ): boolean {
    for (const prism of this.near(x, z, radius)) {
      if (!this.solidFor(prism, feetY, headY, fromX, fromZ)) continue;
      if (pointInPolygon(prism.points, x, z)) return true;
    }
    return false;
  }

  /**
   * Is this prism in the way of a body spanning `[feetY, headY]` that started
   * the move at `(fromX, fromZ)`? The whole of the band rule, in one place
   * because `resolve` and its own overlap guard must not be able to disagree.
   *
   * Four clauses, in the order they are cheapest to fail:
   *
   *   1. **Above the roofline.** The test that was here before terrain and
   *      before this, epsilon and all: against `top` rather than `height`,
   *      because a 9 m warehouse on a pad 30 m up is 39 m of obstacle. The
   *      0.05 m is what lets a caller's step tolerance land *on* a kerb instead
   *      of inside it, and every kerb-climbing behaviour in the game is that
   *      number.
   *   2. **Not a structure.** A building is solid from its top to the terrain
   *      whatever its pad says, because its walls are drawn down to the terrain.
   *      See `Prism.structural` for the measurement that settles it.
   *   3. **Wholly under the soffit.** Half-open `[base, top)`: a head exactly at
   *      the soffit clears it. This is the line the Cahill, the Western
   *      Distributor and the Harbour Bridge all fall on.
   *   4. **Already under it.** A body whose *feet* are below the soffit is under
   *      the deck, not in it; only its head is in the band, and it got there by
   *      jumping or by the ground rising. Pushing it out in plan would send it
   *      to the nearest edge of the footprint in one tick, which under a 12 m
   *      viaduct is a six-metre sideways teleport mid-jump. So a body that was
   *      already inside the footprint before the move is left where it is and
   *      clips the girder; one arriving from outside is stopped at the edge,
   *      which is what makes a street rising into a soffit a wall. Tested at
   *      `from` rather than at the running `(x, z)` so that both resolve passes
   *      and the overlap guard get the same answer.
   */
  private solidFor(
    prism: Prism,
    feetY: number,
    headY: number,
    fromX: number,
    fromZ: number,
  ): boolean {
    if (feetY >= prism.top - 0.05) return false;
    if (!prism.structural) return true;
    if (headY <= prism.base) return false;
    if (feetY < prism.base && pointInPolygon(prism.points, fromX, fromZ)) return false;
    return true;
  }

  /**
   * Is there a building between these two points?
   *
   * The one question in this file that is not about *moving*, and it exists for
   * `game/factions.ts`: a police officer cannot witness a crime through a
   * terrace. Everything else here resolves a capsule against a footprint in
   * plan; this is a **segment against a prism in three dimensions**, because the
   * whole point of it is that a shot from a rooftop clears the wall a shot from
   * the footpath does not.
   *
   * The test, per prism, in the order it is cheapest to fail:
   *
   *   1. the segment's own AABB against the prism's, which rejects almost
   *      everything for two compares an axis;
   *   2. the segment's height range against `[base, top]`, which rejects every
   *      building the sight line passes cleanly over -- the common case in a city
   *      where most of the roofline is under the eye of anybody on a rise;
   *   3. the plan segment against each edge of the footprint, and **the height of
   *      the sight line at the crossing** against the prism's own band. That
   *      third clause is the whole reason this is not a 2D test: a line that
   *      crosses a footprint's outline 30 m up has not been blocked by a 9 m
   *      warehouse, and a purely planar test would say it had -- which reads as
   *      police who cannot see you across a car park.
   *
   * It needed nothing from the walk-under rule and got nothing: this test has
   * honoured `base` since the day it was written, in both the cheap reject and
   * the crossing-height clause, so an officer on Alfred Street could always see
   * a player standing under the Cahill even while `resolve` insisted neither of
   * them could walk there. The two answers now agree, which is the state they
   * were always supposed to be in -- police who can see under a bridge they
   * cannot follow you under is the pair of bugs this half was already free of.
   *
   * A segment that *starts or ends inside* a footprint counts as blocked, which
   * is the honest answer for the two ways it happens: somebody standing in a
   * doorway the prism swallows, and a cop whose capsule centre has been pushed a
   * few centimetres into a wall by `resolve`. Both should fail to see rather than
   * see through, because the alternative is an officer shooting you from inside a
   * building.
   *
   * No `Math.hypot` and no transcendental anywhere in it: subtract, multiply,
   * divide, compare. `game/factions.ts` runs this on the server and in the
   * browser and both have to answer identically -- an LOS test that disagreed
   * across the wire is a player who is fired at by police they cannot see, with
   * nothing on either end that says so.
   */
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const minX = ax < bx ? ax : bx;
    const maxX = ax < bx ? bx : ax;
    const minZ = az < bz ? az : bz;
    const maxZ = az < bz ? bz : az;
    const minY = ay < by ? ay : by;
    const maxY = ay < by ? by : ay;

    const c = this.cellSize;
    const stamp = ++this.visit;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (prism.seen === stamp) continue;
          prism.seen = stamp;
          if (prism.maxX < minX || prism.minX > maxX || prism.maxZ < minZ || prism.minZ > maxZ) continue;
          // Wholly over the roof, or wholly under the pad. Both are common and
          // both are two compares.
          if (minY >= prism.top || maxY <= prism.base) continue;
          if (segmentThroughPrism(prism, ax, ay, az, bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * The highest roof a player at `feetY` is standing on top of, or `-Infinity`.
   *
   * Two conditions, and the second one is what terrain added. The point has to
   * be inside the footprint, as it always did -- and the player has to be at or
   * above the building's **base**. Without that test a bare "highest roof under
   * the point" rule turns every building on a hill into a floor for whoever
   * walks past its foot: the pads all used to be zero, so the base was never
   * above anybody and the question never came up.
   *
   * It cannot let a falling player through a roof, which is the failure the old
   * rule was carefully avoiding. Landing on a roof means feet at `top`, which is
   * above `base`; falling from higher still is further above it.
   *
   * **And that same `base` test is the whole of what the walk-under rule needed
   * from this function, which is why it is unchanged by it.** The sentence that
   * used to finish the paragraph above -- "the only way to be under the base and
   * inside the footprint is to be inside the building's volume, and `resolve`
   * keeps that from happening" -- is no longer true, and it does not have to be:
   * being under the base and inside the footprint is now the ordinary state of a
   * player under the Cahill, and `feetY < prism.base - 0.05` is exactly the
   * clause that refuses to hand them the deck twenty metres up as their floor.
   * Standing *on* the deck is the other side of the same test -- feet at `top`
   * are above `base`, so the deck is still the floor for whoever is on it, and
   * the deck-run continuity `checkTraffic` asserts still holds. A query that
   * looked only for "the highest top under the point" would teleport a player
   * walking under a viaduct onto it, which is the bug this shape was already
   * written to avoid one storey lower down.
   *
   * `-Infinity` rather than 0 for "nothing here", because zero is a real height
   * now: it is the ground at the ENU origin, some tens of metres above most of
   * the city.
   */
  roofHeight(x: number, z: number, feetY: number): number {
    let best = -Infinity;
    for (const prism of this.near(x, z, 0.5)) {
      if (prism.top <= best) continue;
      if (feetY < prism.base - 0.05) continue;
      if (pointInPolygon(prism.points, x, z)) best = prism.top;
    }
    return best;
  }
}

/** A carved piece, as a grid record. Bounds recomputed; the polygon changed. */
function recordFor(
  piece: { points: Float32Array; height: number; base: number; structural: boolean },
  stamp: number,
): Prism {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < piece.points.length; v += 2) {
    const x = piece.points[v];
    const z = piece.points[v + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    points: piece.points,
    height: piece.height,
    base: piece.base,
    top: piece.base + piece.height,
    minX,
    minZ,
    maxX,
    maxZ,
    structural: piece.structural,
    seen: 0,
    carveStamp: stamp,
  };
}

/**
 * Push a circle out of a polygon, or return null if it is already clear.
 *
 * Handles both cases that matter: the centre inside the polygon (push to the
 * nearest edge and out) and the centre outside but within `radius` of an edge
 * (push along that edge's normal).
 */
function pushOut(
  points: Float32Array,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } | null {
  const inside = pointInPolygon(points, x, z);

  let bestDist = Infinity;
  let bestX = 0;
  let bestZ = 0;

  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2];
    const az = points[i * 2 + 1];
    const bx = points[((i + 1) % n) * 2];
    const bz = points[((i + 1) % n) * 2 + 1];

    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-9) continue;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t;
    const pz = az + ez * t;
    const dx = x - px;
    const dz = z - pz;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      bestX = px;
      bestZ = pz;
    }
  }

  if (bestDist === Infinity) return null;
  if (!inside && bestDist >= radius) return null;

  let dx = x - bestX;
  let dz = z - bestZ;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) {
    // Dead centre on an edge: pick any direction rather than dividing by zero.
    dx = 1;
    dz = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  // Inside means the nearest-edge direction points the wrong way.
  const sign = inside ? -1 : 1;
  return {
    x: bestX + dx * sign * radius,
    z: bestZ + dz * sign * radius,
  };
}

/**
 * Does the segment A-B pass through this prism's volume? See `blocked`.
 *
 * Endpoints inside the footprint are tested first and against the prism's own
 * height band, so a sight line that starts on a roof is not blocked by the
 * building holding it up.
 */
function segmentThroughPrism(
  prism: Prism,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const points = prism.points;
  if (ay > prism.base && ay < prism.top && pointInPolygon(points, ax, az)) return true;
  if (by > prism.base && by < prism.top && pointInPolygon(points, bx, bz)) return true;

  const dx = bx - ax;
  const dz = bz - az;
  const dy = by - ay;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const px = points[j * 2];
    const pz = points[j * 2 + 1];
    const ex = points[i * 2] - px;
    const ez = points[i * 2 + 1] - pz;
    // Standard 2D segment-segment intersection by cross products. `denom` near
    // zero is a sight line parallel to the wall, which cannot cross it -- and
    // which the *endpoint* tests above already cover for a line running along
    // the inside of one.
    const denom = dx * ez - dz * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const rx = px - ax;
    const rz = pz - az;
    const t = (rx * ez - rz * ex) / denom;
    if (t < 0 || t > 1) continue;
    const u = (rx * dz - rz * dx) / denom;
    if (u < 0 || u > 1) continue;
    // The height of the sight line where it crosses the wall. This is the clause
    // that makes the test three-dimensional; see `blocked`.
    const y = ay + dy * t;
    if (y > prism.base && y < prism.top) return true;
  }
  return false;
}

/** Standard ray-crossing test. */
function pointInPolygon(points: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const zi = points[i * 2 + 1];
    const xj = points[j * 2];
    const zj = points[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// --- The self-check -------------------------------------------------------------

/**
 * A collision payload, encoded exactly as `tiles.write_collision` writes one.
 *
 * Local to the check rather than shared with `world/invisible-walls.ts`'s copy,
 * and on purpose: this is the module that *decodes* the format, so a helper it
 * borrowed from a reader could agree with that reader about a layout the
 * pipeline never wrote.
 */
function encodeCheckPayload(
  prisms: ReadonlyArray<{ height: number; base: number; points: readonly number[] }>,
): ArrayBuffer {
  let bytes = 4;
  for (const p of prisms) bytes += 10 + p.points.length * 4;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  let o = 0;
  view.setUint32(o, prisms.length, true);
  o += 4;
  for (const p of prisms) {
    view.setFloat32(o, p.height, true);
    o += 4;
    view.setFloat32(o, p.base, true);
    o += 4;
    view.setUint16(o, p.points.length / 2, true);
    o += 2;
    for (const v of p.points) {
      view.setFloat32(o, v, true);
      o += 4;
    }
  }
  return buffer;
}

/** An axis-aligned slab, as a plan ring. */
function slab(x0: number, z0: number, x1: number, z1: number): number[] {
  return [x0, z0, x1, z0, x1, z1, x0, z1];
}

/**
 * The band rule, asserted.
 *
 * Every case here is one the shipped city actually contains -- a viaduct over a
 * street, a pier standing in it, a terrace on a pad above the footpath, a ramp
 * touching down -- reduced to the smallest arrangement that can tell the right
 * answer from the wrong one. Arithmetic only: no world files, no clock, no DOM.
 *
 * The **old** rule is not reimplemented anywhere in here, which is the point of
 * how the oracle is built: a tile added without a building count marks every
 * prism a building, and `solidFor` on a building is `feetY >= top - 0.05` and
 * nothing else -- the exact test this file shipped with. So "the world before
 * this change" is the same payload added the old way, and the two can be run
 * against each other without a second copy of the rule to drift.
 */
export function verifyCollision(): string[] {
  const failures: string[] = [];
  const say = (s: string): void => void failures.push(s);

  // A viaduct 12 m wide and 60 m long with its soffit 5 m up, one pier holding
  // it up, and a terrace beside it on a pad 3 m above the footpath. The deck and
  // the pier are structures; the terrace is a building.
  const DECK = { height: 1.2, base: 5, points: slab(-6, -30, 6, 30) };
  const PIER = { height: 5, base: 0, points: slab(-1.3, -1, 1.3, 1) };
  const TERRACE = { height: 9, base: 3, points: slab(20, -10, 34, 10) };
  const city = (): CollisionWorld => {
    const w = new CollisionWorld();
    w.addTile('t', encodeCheckPayload([DECK, PIER, TERRACE]), 0, 0, 1);
    return w;
  };
  const world = city();
  const R = 0.34;
  /** A standing body, the way `controller.step` asks: feet lifted, head not. */
  const walk = (w: CollisionWorld, fx: number, fz: number, tx: number, tz: number, feet: number) =>
    w.resolve(fx, fz, tx, tz, R, feet + 0.42, feet + BODY_HEIGHT_M);

  // --- 1. Under the span, the length of it. The headline.
  //
  // Down the deck at x = 4, which is inside the 12 m footprint and clear of the
  // pier standing at the origin -- the walk-under lane, not the pier's lane.
  {
    let x = 4;
    let z = -40;
    let stopped = 0;
    for (let i = 0; i < 160; i++) {
      const r = walk(world, x, z, x, z + 0.5, 0);
      if (r.hit) stopped++;
      x = r.x;
      z = r.z;
    }
    if (stopped > 0 || z < 39) {
      say(
        `A body walked ${(z + 40).toFixed(1)} m of an 80 m course under a soffit 5 m over its ` +
          `head and was stopped ${stopped} time(s). A prism whose base is above a head is one ` +
          `the pipeline wrote to be walked under.`,
      );
    }
  }

  // --- 2. And is stopped by the pier holding it up.
  {
    const r = walk(world, 6, 0, 0, 0, 0);
    // Measured against where it was *going*, not along one axis: `pushOut` frees
    // the circle by the nearest edge, and for a body that walked into the middle
    // of a 2.6 x 2 m pier that edge is a side one.
    if (!r.hit || Math.hypot(r.x, r.z) < 0.9) {
      say(
        `Walking into a pier at the origin was not blocked (ended ` +
          `${Math.hypot(r.x, r.z).toFixed(2)} m from its centre).`,
      );
    }
  }

  // --- 3. Standing on the deck still stands on the deck.
  {
    if (walk(world, 4, -20, 4, -19, 6.2).hit) {
      say('A body standing on the deck top was pushed off it -- the roofline test regressed.');
    }
    // Against a tolerance because `base` and `height` are f32 in the payload and
    // 5 + 1.2 comes back as 6.200000047683716. The wire format is the authority
    // on that, not the literal in this file.
    const onDeck = world.roofHeight(4, -20, 6.2);
    if (Math.abs(onDeck - 6.2) > 1e-4) {
      say(`roofHeight for a body on the deck answered ${onDeck} rather than the deck top, 6.2.`);
    }
    // And under it the deck is not a floor. This is the "standing under the
    // bridge teleports you onto it" failure, and the `base` clause is what
    // refuses it.
    if (world.roofHeight(4, -20, 0) !== -Infinity) {
      say(
        `roofHeight under the deck answered ${world.roofHeight(4, -20, 0)}; a body at street ` +
          `level must not be handed a soffit 5 m over it as ground.`,
      );
    }
  }

  // --- 4. A building on a pad is solid to the ground, pad or no pad.
  //
  // The one case the band rule must *not* widen: `mesh.py` draws a building's
  // walls from its pad down to the terrain with a skirt, so the air under a
  // terrace's floor is a wall you can see. 39% of this build's buildings clear
  // the sampled terrain over their footprint by more than a body's height.
  {
    const r = walk(world, 18, 0, 24, 0, 0);
    if (!r.hit || r.x > 20) {
      say(
        `A body walked into a building on a 3 m pad and was not stopped (ended at ` +
          `x=${r.x.toFixed(2)}). Only structures get the band.`,
      );
    }
  }

  // --- 5. A street rising into a soffit closes the gap.
  //
  // Approached from outside, which is how it happens: the ground comes up under
  // the player as they walk toward the deck, and the tick their head reaches the
  // soffit is the tick they stop.
  {
    // Deep under the deck, 2 m of clearance left: still walking.
    const clear = walk(world, 4, -25, 4, -24, 3.0);
    if (clear.hit || Math.abs(clear.z + 24) > 1e-9) {
      say('A body with 2 m of clearance under the soffit was stopped early.');
    }
    const risen = walk(world, 0, -31, 0, -29.5, 3.3);
    if (!risen.hit || risen.z < -30.5) {
      say(
        `A body whose head had risen into the soffit band walked under it anyway (z=` +
          `${risen.z.toFixed(2)}). Ground rising into a deck has to become a wall.`,
      );
    }
  }

  // --- 6. Nobody is teleported out from under a bridge.
  //
  // A body already under the deck whose head enters the band -- a jump, or a
  // metre of rising ground -- is left where it is. Pushing it out in plan would
  // send it to the nearest edge of a 12 m footprint in one tick.
  {
    const jump = world.resolve(4, 0, 4, 0.1, R, 1.5 + 0.42, 1.5 + BODY_HEIGHT_M);
    const moved = Math.hypot(jump.x - 4, jump.z - 0);
    if (moved > 0.2) {
      say(
        `A body under the deck was displaced ${moved.toFixed(2)} m when its head entered the ` +
          `girder. Under a real viaduct that is a six-metre sideways teleport mid-jump.`,
      );
    }
  }

  // --- 7. Half-open at the soffit, and the step tolerance at the top untouched.
  {
    const w = new CollisionWorld();
    w.addTile(
      'k',
      encodeCheckPayload([
        { height: 4, base: 2.0, points: slab(-3, 40, 3, 46) },
        { height: 0.3, base: 0, points: slab(-3, 60, 3, 66) },
        { height: 0.6, base: 0, points: slab(-3, 80, 3, 86) },
      ]),
      0,
      0,
      0,
    );
    if (w.resolve(0, 38, 0, 43, R, 0.42, 2.0).hit) {
      say('A head exactly at the soffit was blocked; the band is half-open at `base`.');
    }
    if (!w.resolve(0, 38, 0, 43, R, 0.42, 2.0001).hit) {
      say('A head a tenth of a millimetre into the band was not blocked.');
    }
    if (w.resolve(0, 58, 0, 63, R, 0.42, 0.42 + BODY_HEIGHT_M).hit) {
      say('A 0.3 m kerb inside the step height stopped a body. STEP_HEIGHT regressed.');
    }
    if (!w.resolve(0, 78, 0, 83, R, 0.42, 0.42 + BODY_HEIGHT_M).hit) {
      say('A 0.6 m wall over the step height did not stop a body.');
    }
  }

  // --- 8. Sight lines agree with feet.
  //
  // `blocked` has honoured `base` since it was written; what this asserts is
  // that the two answers now say the same thing about the same volume, because
  // an officer who can see under a bridge they cannot walk under is the half of
  // this bug that never showed.
  {
    if (world.blocked(-20, 1.6, 0, 20, 1.6, 0) !== true) {
      say('The pier does not block a sight line through it.');
    }
    if (world.blocked(-5, 1.6, -20, 5, 1.6, -20)) {
      say('A sight line under the deck, clear of the pier, was blocked by the deck.');
    }
  }

  // --- 9. The widening property, over randomised configurations.
  //
  // The contract for this change is that it is *only* a widening: no position
  // any body could reach before may be refused now. Run against the same payload
  // added without a building count, which is the old rule exactly -- see the
  // header on this function.
  {
    let seed = 0x5eed1;
    const rnd = (): number => {
      // A 32-bit LCG. No `Math.random`: a property test that cannot be replayed
      // is a rumour, and this file's whole discipline is reproducible answers.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let newlyBlocked = 0;
    let diverged = 0;
    let flatDiverged = 0;
    let cases = 0;
    let widened = 0;
    for (let trial = 0; trial < 400; trial++) {
      // A quarter of the configurations have nothing off the ground at all,
      // which is the population the two rules must agree on to the bit.
      const flat = trial % 4 === 0;
      const prisms: Array<{ height: number; base: number; points: number[] }> = [];
      const n = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const cx = (rnd() - 0.5) * 40;
        const cz = (rnd() - 0.5) * 40;
        const w = 2 + rnd() * 10;
        const d = 2 + rnd() * 10;
        prisms.push({
          height: 0.2 + rnd() * 12,
          base: flat ? 0 : rnd() < 0.5 ? 0 : rnd() * 8,
          points: slab(cx - w * 0.5, cz - d * 0.5, cx + w * 0.5, cz + d * 0.5),
        });
      }
      const payload = encodeCheckPayload(prisms);
      const after = new CollisionWorld();
      after.addTile('t', payload, 0, 0, 0);
      const before = new CollisionWorld();
      before.addTile('t', payload, 0, 0);
      for (let q = 0; q < 25; q++) {
        const fx = (rnd() - 0.5) * 50;
        const fz = (rnd() - 0.5) * 50;
        const tx = fx + (rnd() - 0.5) * 4;
        const tz = fz + (rnd() - 0.5) * 4;
        const feet = rnd() * 12;
        const a = before.resolve(fx, fz, tx, tz, R, feet + 0.42, feet + BODY_HEIGHT_M);
        const b = after.resolve(fx, fz, tx, tz, R, feet + 0.42, feet + BODY_HEIGHT_M);
        cases++;
        // "Newly blocked" is about the *destination*, not the flag: a body that
        // reaches where it was going has not been blocked however many prisms it
        // brushed on the way.
        const reachedBefore = Math.hypot(a.x - tx, a.z - tz) < 1e-9;
        const reachedAfter = Math.hypot(b.x - tx, b.z - tz) < 1e-9;
        if (reachedBefore && !reachedAfter) newlyBlocked++;
        if (!reachedBefore && reachedAfter) widened++;
        if (b.hit && !a.hit) newlyBlocked++;
        if (a.x !== b.x || a.z !== b.z || a.hit !== b.hit) {
          diverged++;
          if (flat) flatDiverged++;
        }
      }
    }
    if (newlyBlocked > 0) {
      say(
        `${newlyBlocked} of ${cases} randomised moves became blocked that were not before. This ` +
          `change is a strict widening or it is a regression.`,
      );
    }
    if (flatDiverged > 0) {
      say(
        `${flatDiverged} moves in a city with nothing off the ground answered differently under ` +
          `the new rule. With every base at zero the two rules are the same comparison.`,
      );
    }
    if (widened === 0 || diverged === 0) {
      say('The randomised sweep never met an elevated prism; the property proves nothing.');
    }
  }

  return failures;
}
