/**
 * Invisible walls: collision the player is stopped by with nothing drawn there.
 *
 * The city is assembled from two files per tile that arrive on two schedules and
 * are three orders of magnitude apart in size. `collision/<key>.bin` is a median
 * **9 kB** of simplified prisms, fetched by `main.ts` on its own 420 m radius,
 * one request, no decode worth the name. `tiles/<key>.glb` is a median **1.6 MB**
 * of geometry that goes through a fetch, a worker decode, and then
 * `TileStreamer`'s 2.5 ms-a-frame build queue before a single triangle is in the
 * scene. So there is a window -- and on a cold CDN a long one -- in which every
 * building in a tile is *solid and invisible*. That is the first of the two
 * things this module marks.
 *
 * The second is permanent and has nothing to do with streaming.
 * `tiles.write_collision` writes `landmarks.Prism` records -- every `decks.py`
 * viaduct segment and parapet, the Harbour Bridge's deck, the Opera House
 * podium, the tower's stalk -- into the same array as the buildings, and their
 * `base` is the **soffit**: the underside, metres above the ground, because a
 * player is meant to walk under them. `cli.cmd_carriageway_audit` reads them
 * exactly that way and excludes them from "solid standing in the road" on
 * precisely that ground.
 *
 * `CollisionWorld.resolve` does not. Its only height test is
 * `feetY >= prism.top - 0.05`; it never looks at `base`. So every one of those
 * volumes is solid from the ground up, and a player walking under the Cahill
 * Expressway or the Western Distributor is stopped by a deck twenty metres over
 * their head. Measured over the shipped build: **4,522 structural prisms, 178,279
 * m2 of plan**, concentrated on the Circular Quay viaduct, the Pyrmont deck
 * stack, the Bradfield approach and the Anzac Bridge.
 *
 * This module does not fix that -- `resolve` is shared with the authoritative
 * server and its semantics are not a map feature's to change. It *shows* it, in
 * an ink of its own, so a player can tell a wall that will appear in a moment
 * from a wall that never will.
 *
 * ---------------------------------------------------------------------------
 * Why the two classes are told apart positionally rather than geometrically.
 *
 * The obvious test is "is this prism's base above the ground under it", and it
 * does not work. A building's pad comes from `roadgrade.py` and the terrain grid
 * is 31.25 m posts, so on any slope the pad sits above the sampled ground by
 * design: **39% of the 61,068 buildings in this build clear the terrain over
 * their own footprint by more than 1.8 m**, against 66% of the structures. There
 * is no threshold in that.
 *
 * What separates them exactly is where they are in the file. `write_collision`
 * emits the `extra` records first and the buildings after, under one count word,
 * and the index already carries the building count as `b`. So the first
 * `total - b` prisms are the structures, for free, with no second source. That
 * split is `CollisionWorld.addTile`'s `buildingCount` argument and lands as
 * `Prism.structural`.
 *
 * And a building is never invisible even on a pad two metres up, which is the
 * other half of why the geometric test would have been wrong: `mesh.py` runs
 * every wall from `base_y - skirt` down, with the skirt sized per building to
 * meet the terrain (`WALL_SKIRT` 1.5 m floor, 8 m ceiling, and
 * `tiles._pad_and_skirt` lowers the pad itself on the sixteen footprints in the
 * city where even that was not enough). The geometry reaches the ground. The
 * decks do not, on purpose.
 *
 * ---------------------------------------------------------------------------
 * What it costs.
 *
 * The residency scan is a distance test over `index.tiles` -- 372 of them in
 * this build -- and four `Map.has` calls on the ones inside the ring, at 10 Hz.
 * The per-prism question the maps ask is a `WeakMap` hit or, once per structural
 * prism per session, one bilinear terrain sample. There are 6,814 structural
 * prisms in the whole city and a map sees a handful.
 *
 * Nothing here allocates in a redraw. The hazard list is a pooled array that
 * grows to its high-water mark, on `Minimap`'s marker-pool argument.
 */

import { CollisionWorld, type Prism } from '../player/collision.ts';

/**
 * What kind of invisible wall a prism is.
 *
 * Two, and they mean opposite things to a player, which is the whole reason
 * they are not one:
 *
 *   - `unbuilt`: the tile's collision is resident and its geometry is not. It is
 *     solid, it is invisible, and it will draw itself in a moment. *Wait.*
 *   - `structure`: a deck, viaduct or landmark volume whose underside is over
 *     your head. It is solid, it is invisible, and it will never draw itself,
 *     because what is drawn is twenty metres up. *Go round.*
 */
export type HazardKind = 'unbuilt' | 'structure';

/**
 * A tile whose collision is resident and whose geometry is not.
 *
 * `phase` is carried because the three that are not `built` are three different
 * stories: `loading` and `building` clear on their own, and `failed` does not --
 * `TileStreamer.update` never retries a tile that threw, so its collision is an
 * invisible wall for the rest of the session.
 */
export interface HazardTile {
  key: string;
  /** `[minX, minZ, maxX, maxZ]`, world metres -- the index's own frame. */
  bounds: readonly [number, number, number, number];
  phase: 'building' | 'loading' | 'failed' | 'absent';
  /** Buildings the index says are in it, which is how many walls this is. */
  buildings: number;
}

/** The slice of `index.json` this needs. Structural, so a test can hand it one. */
export interface TileIndexView {
  tile_size: number;
  tiles: ReadonlyArray<{
    key: string;
    bounds: [number, number, number, number];
    b: number;
  }>;
}

/** The slice of `TileStreamer` this needs. See `TileStreamer.tilePhase`. */
export interface GeometryResidency {
  tilePhase(key: string): 'built' | 'building' | 'loading' | 'failed' | 'absent';
}

/** The slice of `CollisionWorld` this needs. */
export interface CollisionResidency {
  hasTile(key: string): boolean;
}

/**
 * How high the ground is under a point, or a non-finite number where no terrain
 * has arrived.
 *
 * `main.ts` already has one of these and it is deliberately *not* the player's
 * `groundHeightAt`: that one folds in `roofHeight`, so asking it under a deck
 * would return the deck's own top and every structure would report a soffit
 * clearance of zero. What this wants is the terrain alone.
 */
export type GroundSampler = (x: number, z: number) => number;

/**
 * How much air under a structure counts as "you were meant to walk under this".
 *
 * 2.2 m, and it is `cli.WALKABLE_UNDER_M` written on this side of the wire
 * rather than a fresh guess -- the pipeline's carriageway audit uses exactly
 * this number to decide that a prism over the road is a viaduct and not a
 * defect, and a client that drew the hazard at a different height would be
 * disagreeing with the build about which volumes are bridges.
 */
const HEAD_ROOM_M = 2.2;

/** How often the residency scan runs. See the header on what it costs. */
const REFRESH_HZ = 10;
const REFRESH_DT = 1 / REFRESH_HZ;

/**
 * How far out to look for hazard tiles, metres.
 *
 * `main.ts`'s `COLLISION_RADIUS` plus a tile, because that ring is where
 * collision exists at all -- past it there are no prisms to be stopped by and a
 * tile with no geometry is just a part of the city that has not been reached.
 * The margin is one tile so a tile straddling the edge of the ring is included
 * on its near half rather than dropped on its centre.
 */
const SCAN_RADIUS_M = 420 + 500;

/**
 * The two inks, and they are chosen to be unmistakable for each other and for
 * everything else on either map.
 *
 * Amber for the streaming gap. It is the colour every interface in the world
 * uses for "not yet", it sits between the powerups' gold and the combatants'
 * red without being either at a glance, and -- the part that matters on a map
 * that is mostly one pale blue -- it is the warm end of the wheel where the
 * whole rest of the picture is the cool end.
 *
 * Magenta for the permanent one, and it is the only magenta in this client.
 * The palette in use is a pale blue-white figure, a desaturated blue harbour,
 * gold and cream powerups, a lime bike and a salmon red for anybody who can hit
 * you. Magenta is the one hue with nothing already standing on it, which is
 * exactly what a defect marker wants: it can never be misread as a thing in the
 * game, because nothing in the game is that colour.
 *
 * Both are alpha'd to sit over the building fill rather than replace it -- the
 * footprint is still drawn underneath by the ordinary path, because the prisms
 * *are* resident, and this is a wash over it that says "and this one is a lie".
 */
export const HAZARD_FILL: Record<HazardKind, string> = {
  unbuilt: 'rgba(240,168,74,0.30)',
  structure: 'rgba(232,92,168,0.34)',
};

/** The hatch and the outline, at full strength -- a 6 m footprint has no fill. */
export const HAZARD_INK: Record<HazardKind, string> = {
  unbuilt: 'rgba(247,190,110,0.85)',
  structure: 'rgba(243,138,196,0.85)',
};

/**
 * The hatch pitch in **pixels**, and the reason it is not in metres.
 *
 * A hazard region is read as a texture rather than as a shape -- the shape is
 * already carried by the footprint under it -- and a texture has to look the
 * same at every zoom or it stops reading as one thing. At 8 px the diagonals are
 * obviously a hatch on a 210 px minimap disc and still obviously a hatch on an
 * 800 px map panel.
 */
export const HATCH_PITCH_PX = 8;

export class InvisibleWalls {
  private readonly index: TileIndexView;
  private readonly collision: CollisionResidency;
  private readonly geometry: GeometryResidency;
  private readonly ground: GroundSampler;

  /** Pooled; grows to its high-water mark and stays. See the header. */
  private readonly hazards: HazardTile[] = [];
  private hazardCount = 0;
  /** The same tiles by cell key, for the per-prism question. */
  private readonly cells = new Map<string, HazardTile>();

  /**
   * Whether a structural prism's underside clears a head, decided once.
   *
   * A `WeakMap` rather than a field on the prism because this module does not
   * own that record, and rather than a plain `Map` because a prism dies with its
   * tile: the strong reference a `Map` would keep is a leak that grows with
   * every tile the player has ever walked past.
   *
   * Only a *finite* terrain answer is cached. A tile whose `.terr.bin` has not
   * arrived answers `NO_GROUND`, and caching that would decide the question
   * against a ground nobody has read yet and never revisit it.
   */
  private readonly soffitClear = new WeakMap<Prism, boolean>();

  private clock = REFRESH_DT;
  private buildingsAtRisk = 0;
  private structuresSeen = 0;

  constructor(
    index: TileIndexView,
    collision: CollisionResidency,
    geometry: GeometryResidency,
    ground: GroundSampler,
  ) {
    this.index = index;
    this.collision = collision;
    this.geometry = geometry;
    this.ground = ground;
  }

  /**
   * Rescan residency. Called every frame from `main.ts`; runs on its own clock.
   *
   * The clock resets rather than subtracting the interval, on `Minimap.update`'s
   * argument: this is a picture of the present and a late frame has nothing to
   * catch up on.
   */
  update(dt: number, px: number, pz: number): void {
    this.clock += dt;
    if (this.clock < REFRESH_DT) return;
    this.clock = 0;
    this.scan(px, pz);
  }

  /** The scan itself, exposed so a check can drive it without a clock. */
  scan(px: number, pz: number): void {
    this.hazardCount = 0;
    this.cells.clear();
    this.buildingsAtRisk = 0;
    const size = this.index.tile_size;

    for (const entry of this.index.tiles) {
      // A tile with no buildings has no prisms to be stopped by. The harbour is
      // 175 tiles of exactly that, and marking them would put a hazard over
      // every stretch of open water the moment the player got near one.
      if (entry.b <= 0) continue;

      const dx = Math.max(entry.bounds[0] - px, 0, px - entry.bounds[2]);
      const dz = Math.max(entry.bounds[1] - pz, 0, pz - entry.bounds[3]);
      if (dx * dx + dz * dz > SCAN_RADIUS_M * SCAN_RADIUS_M) continue;

      // Collision first: a tile whose prisms have not arrived either stops
      // nobody, so it is not a hazard however unbuilt its geometry is. This is
      // the test that makes the overlay mean "solid and invisible" rather than
      // "not here yet", and the two are the same picture without it.
      if (!this.collision.hasTile(entry.key)) continue;
      const phase = this.geometry.tilePhase(entry.key);
      if (phase === 'built') continue;

      let tile = this.hazards[this.hazardCount];
      if (tile === undefined) {
        tile = { key: '', bounds: [0, 0, 0, 0], phase: 'absent', buildings: 0 };
        this.hazards.push(tile);
      }
      tile.key = entry.key;
      tile.bounds = entry.bounds;
      tile.phase = phase;
      tile.buildings = entry.b;
      this.hazardCount++;
      this.buildingsAtRisk += entry.b;
      this.cells.set(cellKey(entry.bounds[0], entry.bounds[1], size), tile);
    }
  }

  /** How many tiles the last scan found solid and undrawn. */
  get tileCount(): number {
    return this.hazardCount;
  }

  /**
   * One of them, by index, `0 <= i < tileCount`.
   *
   * An indexed read rather than a `tiles` array, and the difference is a
   * per-frame allocation forever: `bigmap.ts` walks this list on every frame the
   * panel is open, and a getter that returned `hazards.slice(0, count)` would
   * allocate an array and hand out live records thirty times a second. The
   * record itself is the pool's own and is rewritten by the next scan -- a
   * caller that wants to keep one must copy it.
   */
  tileAt(i: number): HazardTile {
    return this.hazards[i];
  }

  /** Every one of them, as a fresh array. For a console session, not a redraw. */
  snapshot(): HazardTile[] {
    return this.hazards.slice(0, this.hazardCount).map((t) => ({ ...t }));
  }

  /** Walls standing in those tiles -- the number that says how bad it is. */
  get wallCount(): number {
    return this.buildingsAtRisk;
  }

  /** Structural prisms the maps asked about since the last reset. Diagnostics. */
  get structureCount(): number {
    return this.structuresSeen;
  }

  /**
   * Is this point inside a tile that is solid and undrawn?
   *
   * Cell arithmetic off the tile's own minimum corner rather than a derived
   * sign convention. The index files a tile under `[minX, minZ, ...]` where both
   * are exact multiples of the tile size, so flooring the query point by the
   * same size lands on the same cell for every point the tile contains -- and it
   * is true on both sides of both axes without a single special case, which a
   * scheme that went through the world's `z = -north` flip is not.
   */
  hazardAt(x: number, z: number): HazardKind | null {
    if (this.hazardCount === 0) return null;
    return this.cells.has(cellKey(x, z, this.index.tile_size)) ? 'unbuilt' : null;
  }

  /**
   * What kind of invisible wall this prism is, or null if it is an honest one.
   *
   * `structure` outranks `unbuilt` where a deck stands in a tile that has not
   * built yet, and that is the right way round: the tile will finish and the
   * amber will clear, and the magenta underneath it is still true.
   */
  prismHazard(prism: Prism): HazardKind | null {
    if (prism.structural && this.clearsAHead(prism)) return 'structure';
    // The centre rather than a corner: a footprint straddling a tile seam is
    // filed under one tile by the pipeline and its prism belongs to whichever
    // that was, so testing an arbitrary vertex would answer for the neighbour.
    return this.hazardAt((prism.minX + prism.maxX) * 0.5, (prism.minZ + prism.maxZ) * 0.5);
  }

  /**
   * Does this structure's underside clear a player's head?
   *
   * A deck that has come down to grade -- the last few stations before a
   * touchdown, which `decks.py` emits down to a 0.35 m rise -- is a kerb you
   * step over and not a wall you cannot see, so it is not marked. Everything
   * above `HEAD_ROOM_M` is.
   */
  private clearsAHead(prism: Prism): boolean {
    const cached = this.soffitClear.get(prism);
    if (cached !== undefined) return cached;
    const x = (prism.minX + prism.maxX) * 0.5;
    const z = (prism.minZ + prism.maxZ) * 0.5;
    const g = this.ground(x, z);
    // No terrain here yet: answer "not a hazard" for now and do not remember it.
    // The alternative -- caching against a ground nobody has read -- decides the
    // question permanently on the one frame it was least able to.
    if (!Number.isFinite(g)) return false;
    const clear = prism.base - g > HEAD_ROOM_M;
    this.soffitClear.set(prism, clear);
    if (clear) this.structuresSeen++;
    return clear;
  }

  /** For `window.sydney.invisibleWalls`. */
  stats(): {
    tiles: number;
    walls: number;
    structures: number;
    headRoomM: number;
    scanRadiusM: number;
    hz: number;
    worst: string;
  } {
    let worst = 'none';
    for (let i = 0; i < this.hazardCount; i++) {
      const t = this.hazards[i];
      // `failed` is the one that never clears itself, so it is the one to name.
      if (t.phase === 'failed' || worst === 'none') worst = `${t.key} ${t.phase} (${t.buildings})`;
      if (t.phase === 'failed') break;
    }
    return {
      tiles: this.hazardCount,
      walls: this.buildingsAtRisk,
      structures: this.structuresSeen,
      headRoomM: HEAD_ROOM_M,
      scanRadiusM: SCAN_RADIUS_M,
      hz: REFRESH_HZ,
      worst,
    };
  }
}

/**
 * The cell a world point falls in, as a string key.
 *
 * Shared by the scan and the query so the two cannot drift, and exported so the
 * check can assert it directly on the negative side of both axes -- which is
 * where the whole build lives, since the origin is at Town Hall and Sydney runs
 * south and west of it.
 */
export function cellKey(x: number, z: number, size: number): string {
  return `${Math.floor(x / size)},${Math.floor(z / size)}`;
}

/**
 * A diagonal hatch, as a canvas pattern, in the hazard's ink.
 *
 * Built once per kind per map and cached by the caller. A pattern rather than a
 * clipped set of stroked lines because the region is an arbitrary union of
 * footprints: stroking a hatch across one means solving the line/polygon
 * intersections, and filling it with a pattern means the rasteriser does it.
 *
 * Returns null where the context cannot make one, which is a headless canvas in
 * a test -- the caller falls back to the flat fill and the map still reads.
 */
export function hatchPattern(
  ctx: CanvasRenderingContext2D,
  kind: HazardKind,
  dpr: number,
): CanvasPattern | null {
  const pitch = Math.max(2, Math.round(HATCH_PITCH_PX * dpr));
  const tile = document.createElement('canvas');
  tile.width = pitch;
  tile.height = pitch;
  const tctx = tile.getContext('2d');
  if (tctx === null) return null;
  tctx.strokeStyle = HAZARD_INK[kind];
  tctx.lineWidth = Math.max(1, dpr);
  // Two strokes rather than one, so the diagonal wraps: a single line from
  // corner to corner leaves a break at every tile seam because the stroke has
  // width and half of it falls outside the bitmap.
  tctx.beginPath();
  tctx.moveTo(-pitch, pitch);
  tctx.lineTo(pitch, -pitch);
  tctx.moveTo(0, pitch * 2);
  tctx.lineTo(pitch * 2, 0);
  tctx.stroke();
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern === null) return null;
  // The pattern tile is in device pixels and the maps draw in CSS pixels, so
  // without this the hatch is `dpr` times too coarse on a retina display -- the
  // one thing about this overlay that would look like a bug rather than read as
  // one.
  if (typeof DOMMatrix === 'function') pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  return pattern;
}

/**
 * Boot check. Arithmetic only -- no canvas, no DOM, no network.
 *
 * Five things, and every one of them is a way this feature fails by drawing
 * something plausible rather than by throwing.
 */
export function verifyInvisibleWalls(): string[] {
  const failures: string[] = [];

  // --- 1. The cell arithmetic, on the side of the axes the city is actually on.
  //
  // The whole build is south and west of the origin, so every tile key in play
  // has a negative component and a scheme that was only ever tried at the origin
  // would be off by one over the entire map. Tested against the tile's own
  // minimum corner, which is what the scan files by.
  {
    const size = 500;
    const cases: Array<[number, number, number, number]> = [
      // [minX, minZ, probeX, probeZ] -- the probe is inside that tile.
      [-1000, 1500, -910, 1699], // Broadway, tile -2_-4
      [-1500, 1500, -1396, 1677],
      [0, 0, 250, 250],
      [-500, -500, -1, -1],
      [500, -1500, 999, -1001],
    ];
    for (const [minX, minZ, x, z] of cases) {
      const want = cellKey(minX, minZ, size);
      const got = cellKey(x, z, size);
      if (want !== got) {
        failures.push(
          `A point at (${x}, ${z}) falls in cell ${got}, but the tile whose corner is ` +
            `(${minX}, ${minZ}) is filed under ${want}. The hazard lookup would answer for the wrong tile.`,
        );
      }
    }
    // And the corner itself is inside its own tile, which is the case a
    // `Math.round` or a `-Math.ceil` would get wrong at exactly one point.
    if (cellKey(-1000, 1500, size) !== cellKey(-1000 + 1e-9, 1500 + 1e-9, size)) {
      failures.push('A tile\'s own minimum corner does not land in its own cell.');
    }
  }

  // --- 2. The structural split, decoded out of a real v2 payload.
  //
  // This is the one piece of format arithmetic in the feature and it is
  // positional, so it fails silently in both directions: an off-by-one marks a
  // terrace as a viaduct, and an inverted comparison marks every building in the
  // city and nothing else.
  {
    const world = new SyntheticWorld();
    // Two structures then three buildings, which is a tile whose index says
    // `b: 3` against a payload of five.
    const payload = encodePayload([
      { height: 6, base: 12, points: [0, 0, 10, 0, 10, -10, 0, -10] },
      { height: 6, base: 12, points: [10, 0, 20, 0, 20, -10, 10, -10] },
      { height: 9, base: 0, points: [40, -40, 50, -40, 50, -50, 40, -50] },
      { height: 9, base: 0, points: [60, -40, 70, -40, 70, -50, 60, -50] },
      { height: 9, base: 0, points: [80, -40, 90, -40, 90, -50, 80, -50] },
    ]);
    const added = world.collision.addTile('t', payload, 0, 0, 3);
    if (added !== 5) failures.push(`The synthetic payload decoded ${added} prisms, not 5.`);
    const got = world.collision
      .prismsWithin(50, -25, 400)
      .map((p) => (p.structural ? 'S' : 'b'))
      .sort()
      .join('');
    if (got !== 'SSbbb') {
      failures.push(
        `A payload of 2 structures and 3 buildings decoded as '${got}' rather than 'SSbbb'. ` +
          `The first \`total - b\` records are the structures -- see \`tiles.write_collision\`.`,
      );
    }
    // No count at all means nothing is claimed, which is what every caller that
    // has not been taught this gets.
    const bare = new SyntheticWorld();
    bare.collision.addTile('t', payload, 0, 0);
    if (bare.collision.prismsWithin(50, -25, 400).some((p) => p.structural)) {
      failures.push('A tile added without a building count marked prisms as structures.');
    }
  }

  // --- 3. A tile that is solid and undrawn is a hazard; one that is built is not;
  //        and one whose *collision* has not landed is not either.
  //
  // That third clause is the one worth a check. Without it the overlay marks
  // every tile the streamer has not reached, which is most of the visible city
  // at all times -- a map that is permanently on fire and therefore says nothing.
  {
    const world = new SyntheticWorld();
    const index: TileIndexView = {
      tile_size: 500,
      tiles: [
        { key: 'built', bounds: [0, 0, 500, 500], b: 40 },
        { key: 'gap', bounds: [500, 0, 1000, 500], b: 25 },
        { key: 'nocollision', bounds: [1000, 0, 1500, 500], b: 70 },
        { key: 'water', bounds: [1500, 0, 2000, 500], b: 0 },
      ],
    };
    world.resident.add('built');
    world.resident.add('gap');
    world.resident.add('water');
    world.phases.set('built', 'built');
    world.phases.set('gap', 'building');
    world.phases.set('nocollision', 'loading');
    world.phases.set('water', 'loading');

    // `world` for both, not `world.collision`: what this case is about is which
    // tiles' *payloads* have landed, and the synthetic residency set is the
    // thing that says so. Handing the real `CollisionWorld` here would report
    // every tile absent, since none of them has a payload in this case at all.
    const walls = new InvisibleWalls(index, world, world, () => 0);
    walls.scan(750, 250);
    if (walls.tileCount !== 1) {
      failures.push(
        `${walls.tileCount} hazard tiles where exactly one is solid-and-undrawn ` +
          `(built: drawn; nocollision: nothing to hit; water: no buildings).`,
      );
    }
    if (walls.wallCount !== 25) {
      failures.push(`The hazard reports ${walls.wallCount} walls at risk; the tile has 25 buildings.`);
    }
    if (walls.hazardAt(750, 250) !== 'unbuilt') {
      failures.push('A point inside the solid-and-undrawn tile did not report a hazard.');
    }
    if (walls.hazardAt(250, 250) !== null) {
      failures.push('A point inside a built tile reported a hazard.');
    }
    if (walls.hazardAt(1250, 250) !== null) {
      failures.push('A point inside a tile with no collision resident reported a hazard.');
    }

    // --- 4. And it clears when the build lands. This is the live half of the
    // feature: an overlay that lit up correctly and never went out would be
    // worse than none, because it would train the player to ignore it.
    world.phases.set('gap', 'built');
    walls.scan(750, 250);
    if (walls.tileCount !== 0 || walls.hazardAt(750, 250) !== null) {
      failures.push('The hazard did not clear when the tile finished building.');
    }
  }

  // --- 5. The soffit rule, against the terrain.
  //
  // Both directions, because the interesting failure is not "it never fires" --
  // it is that it fires on the deck's own touchdown, where the structure is at
  // grade and there is nothing to walk under. And a building is never marked
  // whatever its pad is doing, because `mesh.py` skirts its walls down to the
  // ground; that is the assumption the positional split rests on and it is
  // asserted here rather than left implicit.
  {
    const world = new SyntheticWorld();
    // One deck 8 m up, one deck at grade, one building on a 3 m pad.
    const payload = encodePayload([
      { height: 1.5, base: 8, points: [0, 0, 6, 0, 6, -4, 0, -4] },
      { height: 1.5, base: 0.4, points: [20, 0, 26, 0, 26, -4, 20, -4] },
      { height: 9, base: 3, points: [40, 0, 50, 0, 50, -10, 40, -10] },
    ]);
    world.collision.addTile('t', payload, 0, 0, 1);
    const index: TileIndexView = {
      tile_size: 500,
      tiles: [{ key: 't', bounds: [0, -500, 500, 0], b: 1 }],
    };
    world.resident.add('t');
    world.phases.set('t', 'built');
    const walls = new InvisibleWalls(index, world, world, () => 0);
    walls.scan(100, -100);

    const byX = world.collision.prismsWithin(100, -100, 400).sort((a, b) => a.minX - b.minX);
    if (byX.length !== 3) {
      failures.push(`The soffit case decoded ${byX.length} prisms, not 3.`);
    } else {
      const [high, grade, building] = byX;
      if (walls.prismHazard(high) !== 'structure') {
        failures.push(
          `A deck with its soffit ${high.base} m over the ground was not marked. ` +
            `\`resolve\` stops the player under it and nothing is drawn there.`,
        );
      }
      if (walls.prismHazard(grade) !== null) {
        failures.push(
          `A deck at grade (soffit ${grade.base} m) was marked as an invisible wall. ` +
            `There is nothing to walk under; it is a kerb.`,
        );
      }
      if (walls.prismHazard(building) !== null) {
        failures.push(
          'A building on a raised pad was marked as an invisible wall. Its walls are ' +
            'skirted down to the terrain by `mesh.build_walls`; it is drawn.',
        );
      }
    }

    // Terrain that has not arrived must not decide the question. A tile mid-load
    // answers `NaN`, and a cached `false` from that frame would leave the
    // Cahill Expressway unmarked for the rest of the session.
    const blind = new InvisibleWalls(index, world, world, () => Number.NaN);
    blind.scan(100, -100);
    const deck = world.collision.prismsWithin(100, -100, 400).sort((a, b) => a.minX - b.minX)[0];
    if (blind.prismHazard(deck) !== null) {
      failures.push('A structure was judged against terrain that had not loaded.');
    }
  }

  // --- 6. The two inks are two inks. A hazard palette that collapsed to one
  // colour would draw both classes identically, and the entire point of the
  // split is that one of them means "wait" and the other means "go round".
  if (HAZARD_FILL.unbuilt === HAZARD_FILL.structure || HAZARD_INK.unbuilt === HAZARD_INK.structure) {
    failures.push('The two hazard classes are drawn in the same ink; a player cannot tell them apart.');
  }

  return failures;
}

/** A `CollisionWorld` and a fake streamer, for the checks above. */
class SyntheticWorld implements GeometryResidency, CollisionResidency {
  readonly collision = new CollisionWorld();
  readonly resident = new Set<string>();
  readonly phases = new Map<string, 'built' | 'building' | 'loading' | 'failed' | 'absent'>();

  hasTile(key: string): boolean {
    return this.resident.has(key);
  }

  tilePhase(key: string): 'built' | 'building' | 'loading' | 'failed' | 'absent' {
    return this.phases.get(key) ?? 'absent';
  }
}

/** A v2 collision payload, written the way `tiles.write_collision` writes one. */
function encodePayload(
  prisms: Array<{ height: number; base: number; points: number[] }>,
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
