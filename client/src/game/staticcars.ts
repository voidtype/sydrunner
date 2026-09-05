/**
 * The 1.4 million cars parked at the kerb, as data both ends can hold.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THIS FILE EXISTS, AND WHAT IT RETIRES.
 *
 * `game/driving.ts` section 1 has, since the take shipped, carried a deviation
 * stated in as many words: *"the server has no idea the first one exists"*. The
 * static fleet -- 1,402,623 cars baked into `tiles/<key>.cars.bin`, 23,020 of
 * them inside the inner ring alone -- is scenery drawn by `world/cars.ts`, and
 * `server/world.ts` deliberately never opened the file. So only a *schedule*
 * car could be stolen, about forty of them within the 420 m draw radius, and
 * every one of the other twenty-three thousand identical-looking cars on the
 * same street answered `E` with nothing. The owner's report was the obvious
 * consequence: *"i also seem to no longer be able to steal cars"* -- not because
 * the take was broken (`server/take-check.ts` measures it at 188/188 through the
 * button and the wire) but because the car you happen to walk up to is almost
 * certainly one of the twenty-three thousand.
 *
 * This module is the third streaming layer that closes it. It is
 * **three-free by rule**, exactly as `game/traffic.ts` is and for the same
 * reason: the Bun server imports it, so nothing here may draw, and everything
 * here has to be evaluable in a headless process so a `verify*` can assert it.
 * `world/cars.ts` keeps the *rendering* -- the geometry, the palette, the
 * instancing, the per-car pitch off the terrain grid -- and now imports its
 * decoder from here rather than owning one.
 *
 * ---------------------------------------------------------------------------
 * 2. WHAT A STATIC CAR COSTS, AND WHY THE FIELD IS SoA WITH NO INDEX.
 *
 * The whole point of a residency is that the number is small enough to hold.
 * Per car this keeps six numbers -- world x, world z, heading, body, colour,
 * identity -- which is **18 bytes of typed array**:
 *
 *     x        Float32   4
 *     z        Float32   4
 *     heading  Float32   4
 *     body     Uint8     1
 *     colour   Uint8     1
 *     identity Uint32    4
 *
 * `seed` is dropped on the way in (it is a rendering jitter and nothing here
 * asks about it), and **y is not stored at all** -- see section 3. Measured in
 * Bun over the whole 13,362-tile bake, 1,402,623 cars, the cost is **30 bytes a
 * car of RSS** and about **46 MB for all of Sydney**; see
 * `BYTES_PER_STATIC_CAR`, which also says why RSS and not `heapUsed`. Against
 * `server/world.ts`'s 193 MB of prisms and 132 MB of lane graph on a world a
 * third the radius, this is the cheapest of the three layers by an order of
 * magnitude, which is why its cap is 24 MB rather than 300.
 *
 * **There is no spatial index and that is the design, not a shortcut.** A grid
 * over 1.4 M cars is more memory than the cars: at a 32 m cell the extent has
 * ~140,000 populated cells, and a `Map` of that many bucket arrays measured
 * larger than the whole SoA it indexes. What the queries actually are is the
 * argument: every caller asks about a `TAKE_RADIUS` of **2.2 m**, so a per-tile
 * bounds rejection (four comparisons against a 250 m tile's own extent) leaves
 * one or two tiles, and a linear walk of a tile's ~105 cars is ~200 distance
 * tests. `world/carlod.CarModelFleet.sweep` makes exactly this trade for exactly
 * this fleet at a 90 m radius and measures it inside a 0.5 ms budget; at 2.2 m
 * it is not measurable. The server pays it once per press of `E`; the browser
 * pays it once a frame for the prompt.
 *
 * ---------------------------------------------------------------------------
 * 3. THE HEIGHT IS ASKED FOR, NOT STORED. (A deviation from the brief, stated.)
 *
 * The brief asked for `y` in the per-tile arrays. It is not here, and the reason
 * is that a stored `y` would have to be *computed by somebody* at adopt time --
 * which on the server means a ground query per car per tile inside the
 * residency's decode budget (1.4 M of them city-wide, for a number that is read
 * about once a minute), and which on the browser means the streamer handing this
 * module the terrain grid it built the instance matrices from.
 *
 * Instead the field holds a `groundAt(x, z, near)` closure -- the *same
 * signature* `game/combat.CombatWorld.groundHeight` has, so the server passes
 * `server/world.groundFor(world)` and `main.ts` passes its own composed
 * `groundHeightAt` -- and asks it only for the cars a query has already accepted
 * on plan distance. At `TAKE_RADIUS` that is nought to two cars per query.
 *
 * `STATIC_CAR_CLEARANCE_Y` is added on top, because a parked car stands on the
 * *carriageway* and the carriageway is 2 cm over the terrain the pipeline
 * sampled -- `world/cars.buildTileCars` adds the identical constant to the
 * identical query, and the constant now lives here so there is one of it.
 *
 * The consequence to be honest about: the two ends compute `y` from two
 * different ground functions. They agree to within a centimetre on a street --
 * both are the same terrain grid with the same roofs folded in -- and the only
 * thing `y` decides is `driving.TAKE_HEIGHT`, a +/- 2.5 m gate. A disagreement
 * therefore needs a car within 2.2 m horizontally whose ground differs across
 * that 2.5 m threshold, which is a car under a bridge deck one end resolves and
 * the other does not. The server's answer wins and the client snaps out, which
 * is the same correction every other misprediction on this path already takes.
 *
 * ---------------------------------------------------------------------------
 * 4. DETERMINISM: THE LOOK YAW IS A SUBTRACTION.
 *
 * `TileCars.heading` is the instance's Y rotation, and `buildTileCars` states
 * the convention it implies: *"the car's local +X is its nose ... so the nose
 * direction in the tile plan is (cos, -sin) of it"*. The rest of the game speaks
 * look yaws, where forward is `(-sin, -cos)` (`driving.headingYaw`). Solving the
 * two against each other gives `look = heading - PI/2` exactly, with no
 * transcendental at all -- so `staticLookYaw` is one subtraction and both ends
 * produce bit-identical yaws for the same car. `verifyStaticCars` asserts it
 * against `headingYaw(cos h, -sin h)` rather than trusting the derivation.
 *
 * Everything else on the shared path is `+ - * /` and comparisons.
 * `staticCarIdentity` is `game/traffic.ts`' (it lives there because that file
 * was already three-free when `world/cars.ts` was not), and is `Math.imul` only.
 */

import { CAR_BODY_SIZE, staticCarIdentity } from './traffic.ts';

// --- The sidecar's shape -----------------------------------------------------

/** Bytes per instance in a `.cars.bin`. Set by the pipeline's `tiles.write_parking`. */
export const STATIC_CAR_STRIDE = 16;

/**
 * How many body types the sidecar may name, and how many paints.
 *
 * Mirrors of `world/cars.BODY_COUNT` and `world/cars.CAR_PAINT.length`, kept
 * here because `decodeCars` clamps against them and this file may not import the
 * module that owns the geometry and the palette. `verifyStaticCars` takes the
 * renderer's own numbers as arguments and asserts they agree -- the same seam
 * `verifyTraffic(carBodySizes())` already makes for the hit boxes, and for the
 * same reason: an index that ran past `PAINT` would read `undefined` and take
 * the tile's whole draw call out with it.
 */
export const STATIC_BODY_COUNT = 5;
export const STATIC_PAINT_COUNT = 8;

/**
 * Carriageway clearance over the terrain, metres. `streets.CARRIAGEWAY_Y` in the
 * pipeline, and `world/cars.buildTileCars`' own constant, now defined once.
 */
export const STATIC_CAR_CLEARANCE_Y = 0.02;

/** One tile's cars, decoded from `<key>.cars.bin` as a structure of arrays. */
export interface TileCars {
  count: number;
  /** Tile-local metres, renderer axes. */
  x: Float32Array;
  z: Float32Array;
  /** Radians, applied as the instance's Y rotation. See `staticLookYaw`. */
  heading: Float32Array;
  body: Uint8Array;
  colour: Uint8Array;
  seed: Uint16Array;
  /**
   * Who each of these cars *is*, as a stable 32-bit number. See
   * `traffic.staticCarIdentity`; empty when `decodeCars` was not told the tile
   * key.
   */
  identity: Uint32Array;
}

/**
 * Decode a `.cars.bin`. Returns `null` for anything that is not one, because a
 * tile with no cars must be indistinguishable from a tile whose sidecar is
 * missing -- see `world/streamer.ts`, and `StaticCarField.adopt` below, which
 * relies on the same equivalence for a `.cars.bin` the box was never sent.
 *
 * **Moved here verbatim from `world/cars.ts`**, which now re-exports it. The
 * only change is that the two clamps read this file's constants instead of the
 * renderer's `BODY_COUNT` and `PAINT.length`; see `STATIC_BODY_COUNT`.
 */
export function decodeCars(buffer: ArrayBuffer, tileKey = ''): TileCars | null {
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count === 0 || buffer.byteLength < 4 + count * STATIC_CAR_STRIDE) return null;

  const out: TileCars = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    heading: new Float32Array(count),
    body: new Uint8Array(count),
    colour: new Uint8Array(count),
    seed: new Uint16Array(count),
    // Filled only when the caller named the tile. The sidecar carries no
    // identity of its own -- it does not need to, because the tile key is
    // already the file's own name and the index is already the order the bytes
    // are in. See `traffic.staticCarIdentity`.
    identity: new Uint32Array(tileKey === '' ? 0 : count),
  };
  if (tileKey !== '') {
    for (let i = 0; i < count; i++) out.identity[i] = staticCarIdentity(tileKey, i);
  }
  for (let i = 0; i < count; i++) {
    const o = 4 + i * STATIC_CAR_STRIDE;
    out.x[i] = view.getFloat32(o, true);
    out.z[i] = view.getFloat32(o + 4, true);
    out.heading[i] = view.getFloat32(o + 8, true);
    // Clamped rather than trusted: an out-of-range index would read past the
    // geometry or palette table and take the whole tile out with it.
    out.body[i] = Math.min(view.getUint8(o + 12), STATIC_BODY_COUNT - 1);
    out.colour[i] = Math.min(view.getUint8(o + 13), STATIC_PAINT_COUNT - 1);
    out.seed[i] = view.getUint16(o + 14, true);
  }
  return out;
}

/**
 * A parked car's heading as a **look yaw**. One subtraction. See section 4.
 *
 * Deliberately not `driving.headingYaw(Math.cos(h), -Math.sin(h))`, which is the
 * same number by way of two transcendentals and an `atan2` -- three functions
 * the determinism rule in `game/footy.ts`' header names specifically. This is
 * evaluated on both ends for the same car and has to give the same bits.
 */
export function staticLookYaw(heading: number): number {
  return heading - Math.PI / 2;
}

// --- The residency's accounting ----------------------------------------------

/**
 * What one parked car and one adopted tile cost resident, bytes.
 *
 * **Measured on `server/world.BYTES_PER_PRISM`'s terms, with one deliberate
 * difference in the denomination that has to be stated.** Those two constants are
 * live-heap figures read off `heapUsed`, and the caps derived from them are then
 * compared against RSS with a measured ~1.9x ratio. That method does not work
 * here: this layer is almost entirely `ArrayBuffer` backing store, which JSC
 * accounts as *external* memory and does not report in `heapUsed` at all -- the
 * first sweep measured a 4 MB field at zero bytes of heap growth, repeatably.
 *
 * So these are **RSS deltas**, and the number is therefore directly what the box
 * pays with no ratio in front of it. The method: a fresh Bun process, adopt N
 * `.cars.bin` into a fresh `StaticCarField`, `Bun.gc(true)`, settle a tick,
 * `Bun.gc(true)` again, read `process.memoryUsage.rss()`. Two sweeps over the
 * shipped 13,362-tile bake:
 *
 *   - **Six cumulative batches**, ~2,227 tiles each: every increment landed
 *     between 29.8 and 30.9 bytes a car, over 1.17 M cars.
 *   - **The car term isolated**, by adopting the 4,000 *emptiest* sidecars
 *     (94,554 cars) and the 4,000 *fullest* (848,434) -- same tile count, so the
 *     difference is cars alone: 23.05 MB for 753,880 cars, **30.6 B/car**.
 *
 * Thirty is that, rounded down to the flat figure the batch sweep agrees with.
 * The gap from the 18 bytes of typed array in section 2 is allocation overhead on
 * six small `ArrayBuffer`s per tile plus page granularity, and it is *why* this is
 * measured rather than added up.
 *
 * The **300 per tile** is not measured and is not claimed to be: it is the
 * `StaticTile` record, its `Map` entry and the string key, counted by hand. The
 * sweeps could not separate it from the read path's own transient allocations
 * (fits ranged over 300-1,300 B/tile depending on the sample), and at ~105 cars a
 * tile it is a tenth of the car term either way. It is here so that a residency
 * holding thousands of nearly-empty outer-ring sidecars is not accounted at zero.
 *
 * Whole city: 46.1 MB. Re-derive with a fresh sweep whenever `StaticTile` gains
 * or loses a field; `verifyStaticCars` asserts the estimator is monotone and that
 * the city still fits the 50 MB this layer was sized against, which catches a
 * field added without a re-measure.
 */
export const BYTES_PER_STATIC_CAR = 30;
export const BYTES_PER_STATIC_TILE = 300;

/** What a set of tiles' parked cars is estimated to cost resident. */
export function estimateStaticCarBytes(cars: number, tiles: number): number {
  return cars * BYTES_PER_STATIC_CAR + tiles * BYTES_PER_STATIC_TILE;
}

// --- What a query gets back --------------------------------------------------

/**
 * One parked car, as `StaticCarSource` hands it over.
 *
 * The same six fields `driving.TakeableCar` needs plus the identity, in world
 * space and in the game's own yaw convention -- so `resolveTake` can compare a
 * static car and a schedule car on identical terms without knowing which is
 * which. **Owned by the source and reused**, which is `traffic.CarPose`'s
 * contract and is here for its reason: a query asked once a frame for the HUD
 * prompt must not allocate.
 */
export interface StaticCarPose {
  /** `traffic.staticCarIdentity(tileKey, index)`. */
  identity: number;
  /** `world/cars.CAR_BODY_SIZE` index, 0..4. */
  body: number;
  /** `world/cars.CAR_PAINT` index, 0..7. */
  colour: number;
  x: number;
  /** Absolute, from the source's own ground plus `STATIC_CAR_CLEARANCE_Y`. */
  y: number;
  z: number;
  /** A look yaw. See `staticLookYaw`. */
  yaw: number;
}

/**
 * Where the parked fleet is, as `game/driving.resolveTake` asks it.
 *
 * One method, and it is an interface rather than the class below so that the
 * two ends can answer it from different places: the server from its residency
 * (`StaticCarField` under `server/world.ts`'s third `HexLayer`) and the browser
 * from the same class fed by the streamer. A check can answer it from an array.
 *
 * `feetY` is the asker's own feet, and is passed **into** the query rather than
 * being the caller's business afterwards because it is the `near` hint the
 * ground functions on both ends take: "the ground under this car, on the level
 * the person asking is standing on". Without it a car on Alfred Street and the
 * Cahill Expressway over it are one query with two answers and no way to choose.
 */
export interface StaticCarSource {
  forEachStaticNear(
    x: number,
    feetY: number,
    z: number,
    radius: number,
    visit: (car: StaticCarPose) => void,
  ): void;
}

// --- Who sits where in a tile's spans -----------------------------------------

/** A tile's cars sorted into one bucket per body, and where each car landed. */
export interface CarBodyBins {
  /** `members[b]` is the sidecar rows of body `b`, in sidecar order. */
  members: number[][];
  /** `slot[i]` is row `i`'s instance index inside its own body's span. */
  slot: Uint16Array;
}

/**
 * Bin a tile's cars by body, and number each one inside its bin.
 *
 * **One function because it is one fact, and it used to be two.**
 * `world/cars.buildTileCars` bins the sidecar by body and writes the n-th car of
 * body `b` into instance `n` of that body's span; `world/carlod.adopt` has to
 * re-derive the identical numbering, because the handle it needs -- "which
 * instance is this car" -- is not in the sidecar and is not on the span. The two
 * loops were written a fortnight apart, they agreed, and nothing but a comment
 * said they had to: a body ordering changed in one of them zero-scales a
 * *different* car than the one a player is standing next to, which looks like a
 * car flickering out somewhere behind you and is unfindable.
 *
 * It lives here rather than in `world/cars.ts` for the reason `decodeCars` does:
 * this file is three-free, so `verifyParkedBins` runs on the Bun server as well
 * as in the browser, and a check the deploy gate cannot see is a check that goes
 * green on a broken build. It is `+` and array pushes; there is nothing in it a
 * renderer needs to be present for.
 *
 * `bodyCount` is the caller's own table size -- `world/cars.BODY_COUNT` from the
 * renderer, `STATIC_BODY_COUNT` from anything headless, and `verifyStaticCars`
 * is what asserts those are the same number. A row naming a body outside it is
 * left out of every bin and given slot 0, which is what a decoder that clamps
 * already guarantees cannot happen and what stops this throwing if one ever
 * stops clamping.
 */
export function binCarsByBody(
  body: Uint8Array,
  count: number,
  bodyCount: number = STATIC_BODY_COUNT,
): CarBodyBins {
  const members: number[][] = Array.from({ length: bodyCount }, () => []);
  const slot = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const b = body[i];
    if (b >= bodyCount) continue;
    slot[i] = members[b].length;
    members[b].push(i);
  }
  return { members, slot };
}

/**
 * How the browser's tile streamer tells a field about a tile's parked cars.
 *
 * `world/streamer.setStaticCarSink`, on `setParkedCarSink`'s terms and from the
 * same two call sites -- adopted when a tile is committed, dropped when it is
 * disposed. Narrower than `ParkedCarSink` on purpose: that one is handed the
 * spans a tile took out of the shared car meshes, because `carlod` has to reach
 * into the matrix buffer, and this one must not be, because it is three-free.
 *
 * A separate sink rather than a second job for `carlod.CarModelFleet`, which
 * already receives the same three arguments, because that object is **optional**:
 * `main.ts` builds it behind a `withDeadline` and a slow model load leaves it
 * null. A client that could not steal a parked car because the model manifest
 * timed out is the shape of coupling this workstream exists to remove.
 */
export interface StaticCarSink {
  adopt(tileKey: string, data: TileCars, originX: number, originZ: number): void;
  drop(tileKey: string): void;
}

// --- The field ---------------------------------------------------------------

/** One tile's parked cars, in world space. See section 2 on the layout. */
interface StaticTile {
  count: number;
  /** World metres: the sidecar's tile-local pair with the tile origin folded in. */
  x: Float32Array;
  z: Float32Array;
  /** Radians, as the sidecar holds them. Converted per query by `staticLookYaw`. */
  heading: Float32Array;
  body: Uint8Array;
  colour: Uint8Array;
  identity: Uint32Array;
  /** The tile's own extent, so a query rejects it on four comparisons. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Every parked car this process is holding, by tile.
 *
 * `game/traffic.TrafficField`'s lifecycle exactly -- `adopt(key, ...)` and
 * `drop(key)`, keyed on the tile, idempotent, with the residency above deciding
 * *which* tiles -- and none of its indexing, for the reason in section 2.
 *
 * The server owns one behind `HexResidency`'s third layer. The browser owns one
 * fed by `world/streamer.ts` on exactly the terms `setParkedCarSink` is fed, so
 * a tile's cars arrive with its meshes and leave when they are disposed. Neither
 * copy is authoritative over the other: they are two decodes of the same bytes,
 * and a car either end is missing is a car neither can take (the server refuses
 * and the client's prompt never appears).
 */
export class StaticCarField implements StaticCarSource {
  private readonly tiles = new Map<string, StaticTile>();
  /** Cars and estimated bytes held, maintained incrementally for the cap. */
  private cars = 0;
  private estimated = 0;

  /**
   * The ground under a point, on `combat.CombatWorld.groundHeight`'s signature.
   *
   * Set by the owner: `server/world.groundFor(world)` on the server, `main.ts`'s
   * composed `groundHeightAt` in the browser. See section 3 for why the height
   * is asked for rather than stored.
   *
   * The default answers "wherever the asker is", which is the only honest answer
   * a field with no world can give and is what lets `verifyStaticCars` drive
   * this class with four cars in an array. It makes the vertical gate vacuous,
   * which is correct for a process that has no terrain: refusing every take
   * because nothing knows where the ground is would be worse.
   */
  groundAt: (x: number, z: number, near: number) => number = (_x, _z, near) => near;

  /** Reused, per this file's contract on `StaticCarPose`. Not reentrant. */
  private readonly pose: StaticCarPose = {
    identity: 0, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0,
  };

  /**
   * Take one tile's decoded sidecar, in the tile's own local metres, and hold it
   * in world space.
   *
   * `originX`/`originZ` are the tile group's translation -- the same pair
   * `carlod.CarModelFleet.adopt` and `traffic.LaneObstacles.adoptStatics` take,
   * and on the server the `bounds[0]` / `bounds[1] + tile_size` pair
   * `server/world.readTiles` precomputes for the prisms. Folded in **once, here**
   * rather than per query, for `decodeLanes`' stated reason: a route (or a car)
   * has no group to inherit a translation from once it is out of the browser.
   *
   * A tile with no identities -- `decodeCars` called without its key -- is
   * refused rather than held, because an identity is the only thing anything
   * downstream can name a car by. Re-adopting a key replaces it, so a hexagon
   * two layers both claim cannot double-count.
   */
  adopt(tileKey: string, data: TileCars, originX: number, originZ: number): void {
    if (data.identity.length !== data.count) return;
    if (this.tiles.has(tileKey)) this.drop(tileKey);

    const count = data.count;
    const x = new Float32Array(count);
    const z = new Float32Array(count);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const wx = data.x[i] + originX;
      const wz = data.z[i] + originZ;
      x[i] = wx;
      z[i] = wz;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    // `heading`, `body`, `colour` and `identity` are taken by reference rather
    // than copied: `decodeCars` allocated them for this caller and nothing else
    // retains the decoded object once the streamer's build step is over. The two
    // that *are* copied are the two that change meaning (tile-local to world).
    this.tiles.set(tileKey, {
      count,
      x,
      z,
      heading: data.heading,
      body: data.body,
      colour: data.colour,
      identity: data.identity,
      minX,
      maxX,
      minZ,
      maxZ,
    });
    this.cars += count;
    this.estimated += estimateStaticCarBytes(count, 1);
  }

  /** One tile's parked cars, out again. Idempotent. */
  drop(tileKey: string): void {
    const held = this.tiles.get(tileKey);
    if (held === undefined) return;
    this.tiles.delete(tileKey);
    this.cars -= held.count;
    this.estimated -= estimateStaticCarBytes(held.count, 1);
  }

  /** Is this tile's sidecar already held? `HexLayer.spec.has`. */
  has(tileKey: string): boolean {
    return this.tiles.has(tileKey);
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  get carCount(): number {
    return this.cars;
  }

  /** Estimated resident bytes. What the cap is counted in. See `BYTES_PER_STATIC_CAR`. */
  get bytes(): number {
    return this.estimated;
  }

  /** Empty it. A room torn down, and the self-checks. */
  clear(): void {
    this.tiles.clear();
    this.cars = 0;
    this.estimated = 0;
  }

  /**
   * Every parked car within `radius` of a point, posed. `StaticCarSource`.
   *
   * Allocation-free: the tile walk is over a `Map` this object owns, the pose is
   * the one reused scratch, and the ground query happens only for cars already
   * inside the radius on plan distance. See section 2 for why there is no grid
   * and section 3 for why `y` costs a call.
   */
  forEachStaticNear(
    x: number,
    feetY: number,
    z: number,
    radius: number,
    visit: (car: StaticCarPose) => void,
  ): void {
    if (this.tiles.size === 0) return;
    const r2 = radius * radius;
    const pose = this.pose;
    for (const tile of this.tiles.values()) {
      // Four comparisons against the tile's own extent. At `TAKE_RADIUS` this
      // rejects every tile but the one the player is standing in and, on a seam,
      // its neighbour.
      if (
        tile.maxX < x - radius || tile.minX > x + radius ||
        tile.maxZ < z - radius || tile.minZ > z + radius
      ) continue;
      for (let i = 0; i < tile.count; i++) {
        const dx = tile.x[i] - x;
        const dz = tile.z[i] - z;
        if (dx * dx + dz * dz > r2) continue;
        pose.identity = tile.identity[i];
        pose.body = tile.body[i];
        pose.colour = tile.colour[i];
        pose.x = tile.x[i];
        pose.z = tile.z[i];
        pose.y = this.groundAt(pose.x, pose.z, feetY) + STATIC_CAR_CLEARANCE_Y;
        pose.yaw = staticLookYaw(tile.heading[i]);
        visit(pose);
      }
    }
  }

  /**
   * Where a named car is, or false. Linear over everything held.
   *
   * The one query that is not bounded by a radius, and it is deliberately not on
   * `StaticCarSource`: nothing in the take path calls it. It exists for the
   * checks and for `server/take-check.ts`, which has to answer "is the car I
   * stole standing in its bay again?" after a recycle, and the only handle it has
   * at that point is the identity off the record it just removed.
   *
   * A full sweep is one `Uint32Array` comparison per resident car -- about 20
   * microseconds over a browser's ring and a few milliseconds over the whole
   * city -- so it is fine per theft and wrong per frame. `world/carlod.ts` does
   * the same scan over its *own* tiles rather than calling this, because what it
   * needs back is an instance index in a mesh and this class has no meshes.
   */
  findStatic(identity: number, feetY: number, out: StaticCarPose): boolean {
    for (const tile of this.tiles.values()) {
      for (let i = 0; i < tile.count; i++) {
        if (tile.identity[i] !== identity) continue;
        out.identity = identity;
        out.body = tile.body[i];
        out.colour = tile.colour[i];
        out.x = tile.x[i];
        out.z = tile.z[i];
        out.y = this.groundAt(out.x, out.z, feetY) + STATIC_CAR_CLEARANCE_Y;
        out.yaw = staticLookYaw(tile.heading[i]);
        return true;
      }
    }
    return false;
  }
}

/** A pose a caller can own, for `findStatic` and for the checks. */
export function createStaticCarPose(): StaticCarPose {
  return { identity: 0, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0 };
}

// --- The self-check ----------------------------------------------------------

/** Build a `.cars.bin` in memory. The checks', and nothing ships this. */
function fakeSidecar(
  cars: ReadonlyArray<{ x: number; z: number; heading: number; body: number; colour: number; seed: number }>,
): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + cars.length * STATIC_CAR_STRIDE);
  const v = new DataView(buffer);
  v.setUint32(0, cars.length, true);
  for (let i = 0; i < cars.length; i++) {
    const o = 4 + i * STATIC_CAR_STRIDE;
    v.setFloat32(o, cars[i].x, true);
    v.setFloat32(o + 4, cars[i].z, true);
    v.setFloat32(o + 8, cars[i].heading, true);
    v.setUint8(o + 12, cars[i].body);
    v.setUint8(o + 13, cars[i].colour);
    v.setUint16(o + 14, cars[i].seed, true);
  }
  return buffer;
}

/**
 * What this catches that a typecheck cannot.
 *
 *   - **A decoder that reads the wrong stride.** Sixteen bytes per car is the
 *     pipeline's number, and a decoder that drifted from it would place every
 *     car in Sydney at a plausible-looking wrong position -- the one class of
 *     bug in this feature that renders perfectly.
 *   - **A palette index that runs off the end.** `decodeCars` clamps, and the
 *     clamp is against constants this file owns rather than the renderer's. If
 *     `world/cars.PAINT` ever gains a colour and this does not, every car past
 *     index 7 is quietly repainted; if it *loses* one, `PAINT[c]` is `undefined`
 *     and the tile's draw call dies. Both are caught by passing the renderer's
 *     own counts in, exactly as `verifyTraffic(carBodySizes())` does.
 *   - **A yaw that is a quarter turn out.** `staticLookYaw`'s subtraction is
 *     derived from `buildTileCars`' rotation and `driving.headingYaw`'s
 *     convention, and a car you get into facing the footpath is the symptom.
 *     Checked against the transcendental form it replaces.
 *   - **A field that leaks a tile.** The residency's cap is counted off
 *     `bytes`, so an `adopt` that did not pair with its `drop` is a server that
 *     evicts hexagons forever and never gets under cap.
 *   - **A query that cannot see a car it is standing on.** The bounds rejection
 *     is four comparisons and an inverted one silently answers "no cars here" --
 *     which is indistinguishable, from outside, from the bug this whole
 *     workstream exists to fix.
 *   - **An origin folded twice, or not at all.** A tile whose cars are 250 m out
 *     is a street where `E` does nothing and the boxes are somewhere else.
 *
 * `bodyCount`/`paintCount` are the renderer's own, passed by `main.ts` where
 * three is loadable. Omitted on the server, where they cannot be.
 */
export function verifyStaticCars(bodyCount?: number, paintCount?: number): string[] {
  const failures: string[] = [];

  // --- The renderer's tables, where the caller has them.
  if (bodyCount !== undefined && bodyCount !== STATIC_BODY_COUNT) {
    failures.push(
      `world/cars.BODY_COUNT is ${bodyCount} and staticcars.STATIC_BODY_COUNT is ${STATIC_BODY_COUNT}. ` +
        `\`decodeCars\` clamps against the second, so the fleet would index past the geometry table.`,
    );
  }
  if (paintCount !== undefined && paintCount !== STATIC_PAINT_COUNT) {
    failures.push(
      `world/cars.CAR_PAINT has ${paintCount} colours and staticcars.STATIC_PAINT_COUNT is ` +
        `${STATIC_PAINT_COUNT}. Cars would be repainted, or painted \`undefined\`.`,
    );
  }
  if (CAR_BODY_SIZE.length !== STATIC_BODY_COUNT) {
    failures.push(
      `traffic.CAR_BODY_SIZE has ${CAR_BODY_SIZE.length} entries against ${STATIC_BODY_COUNT} bodies. ` +
        `A taken static car's hit box would come from the wrong row.`,
    );
  }

  // --- The decoder, over a sidecar built to the pipeline's own layout.
  const sample = [
    { x: 10, z: -20, heading: 0, body: 0, colour: 0, seed: 1 },
    { x: 11.5, z: -20.25, heading: Math.PI / 3, body: 4, colour: 7, seed: 65535 },
    // Out of range on purpose: both must clamp rather than be trusted.
    { x: -30, z: 40, heading: -1, body: 200, colour: 200, seed: 7 },
  ];
  const decoded = decodeCars(fakeSidecar(sample), '3_-4');
  if (decoded === null) {
    failures.push('`decodeCars` refused a sidecar it wrote the header of itself.');
  } else {
    if (decoded.count !== sample.length) {
      failures.push(`\`decodeCars\` found ${decoded.count} cars in a ${sample.length}-car sidecar.`);
    }
    if (Math.abs(decoded.x[1] - 11.5) > 1e-4 || Math.abs(decoded.z[1] + 20.25) > 1e-4) {
      failures.push(
        `\`decodeCars\` put car 1 at (${decoded.x[1]}, ${decoded.z[1]}) where the sidecar says ` +
          `(11.5, -20.25). The stride or the field order is wrong.`,
      );
    }
    if (decoded.body[2] !== STATIC_BODY_COUNT - 1 || decoded.colour[2] !== STATIC_PAINT_COUNT - 1) {
      failures.push(
        `\`decodeCars\` passed a body of ${decoded.body[2]} and a colour of ${decoded.colour[2]} ` +
          'through unclamped. Both index fixed tables.',
      );
    }
    if (decoded.seed[1] !== 65535) failures.push('`decodeCars` lost the seed word.');
    for (let i = 0; i < sample.length; i++) {
      if (decoded.identity[i] !== staticCarIdentity('3_-4', i)) {
        failures.push(`\`decodeCars\` named car ${i} something other than \`staticCarIdentity\`.`);
      }
    }
    if (decoded.identity[0] === decoded.identity[1]) {
      failures.push('Two cars in one tile share an identity; the whole fleet is one car.');
    }
  }
  // A tile with no key gets no identities, and the field must refuse it -- see
  // `adopt`. This is how a `.cars.bin` reaches a process that cannot name it.
  const anonymous = decodeCars(fakeSidecar(sample));
  if (anonymous === null || anonymous.identity.length !== 0) {
    failures.push('`decodeCars` invented identities for a tile it was not given the key of.');
  }
  if (decodeCars(new ArrayBuffer(2)) !== null) failures.push('`decodeCars` accepted a two-byte file.');
  if (decodeCars(fakeSidecar([])) !== null) {
    failures.push('`decodeCars` accepted a sidecar with no cars in it; a tile with none must read as absent.');
  }
  {
    // Truncated: the header promises three and the file holds one and a half.
    const whole = fakeSidecar(sample);
    if (decodeCars(whole.slice(0, 4 + STATIC_CAR_STRIDE)) !== null) {
      failures.push('`decodeCars` accepted a sidecar whose header outruns its bytes.');
    }
  }

  // --- The yaw, against the form it replaces.
  for (const h of [0, 0.5, 1.25, Math.PI, -2.2, 5.9]) {
    const viaAtan = Math.atan2(-Math.cos(h), Math.sin(h));
    const mine = staticLookYaw(h);
    // Compared as a *direction*, because the two differ by whole turns off the
    // atan2 branch and a yaw is only ever consumed through sin and cos.
    const dd = Math.abs(Math.sin(mine) - Math.sin(viaAtan)) + Math.abs(Math.cos(mine) - Math.cos(viaAtan));
    if (dd > 1e-9) {
      failures.push(
        `\`staticLookYaw(${h})\` is ${mine.toFixed(4)} where the heading (cos, -sin) resolves to ` +
          `${viaAtan.toFixed(4)}. A driver would get in facing the wrong way.`,
      );
    }
  }

  // --- The field: adopt, query, account, drop.
  const field = new StaticCarField();
  const tile = decodeCars(fakeSidecar(sample), '3_-4');
  if (tile !== null) {
    // A 250 m tile origin, so an origin that is not folded in is unmissable.
    field.adopt('3_-4', tile, 750, -1000);
    if (field.tileCount !== 1 || field.carCount !== sample.length) {
      failures.push(`\`adopt\` holds ${field.tileCount} tile(s) and ${field.carCount} car(s).`);
    }
    if (field.bytes !== estimateStaticCarBytes(sample.length, 1)) {
      failures.push(`\`bytes\` is ${field.bytes} where the estimator says ${estimateStaticCarBytes(sample.length, 1)}.`);
    }
    // Adopting the same key twice must replace, not double-count: two hexagons
    // can both claim a tile on a seam.
    field.adopt('3_-4', tile, 750, -1000);
    if (field.carCount !== sample.length) {
      failures.push(`Re-adopting a tile left ${field.carCount} cars where the tile has ${sample.length}.`);
    }

    // Car 0 is at local (10, -20), so world (760, -1020).
    let seen = 0;
    let sawIdentity = 0;
    let sawY = 0;
    field.groundAt = () => 12;
    field.forEachStaticNear(760, 5, -1020, 1, (car) => {
      seen++;
      sawIdentity = car.identity;
      sawY = car.y;
    });
    if (seen !== 1) {
      failures.push(
        `A 1 m query at the exact world position of car 0 found ${seen} car(s). The tile origin is ` +
          'not being folded in, or the bounds rejection is inverted.',
      );
    }
    if (sawIdentity !== staticCarIdentity('3_-4', 0)) {
      failures.push('The query named a car other than the one it was standing on.');
    }
    if (Math.abs(sawY - (12 + STATIC_CAR_CLEARANCE_Y)) > 1e-6) {
      failures.push(
        `The query put the car at y ${sawY} where the ground says 12 plus ${STATIC_CAR_CLEARANCE_Y} of ` +
          'carriageway. A parked car must stand on the road, not in it.',
      );
    }
    let far = 0;
    field.forEachStaticNear(760 + 500, 5, -1020, 1, () => { far++; });
    if (far !== 0) failures.push(`A query 500 m from the tile still found ${far} car(s).`);
    // The radius is a radius: car 1 is 1.5 m east and 0.25 m north of car 0.
    let both = 0;
    field.forEachStaticNear(760, 5, -1020, 2.2, () => { both++; });
    if (both !== 2) {
      failures.push(`A 2.2 m query around car 0 found ${both} of the 2 cars inside it.`);
    }

    const probe = createStaticCarPose();
    if (!field.findStatic(staticCarIdentity('3_-4', 1), 0, probe)) {
      failures.push('`findStatic` could not find a car the field is holding.');
    } else if (Math.abs(probe.x - 761.5) > 1e-3) {
      failures.push(`\`findStatic\` put car 1 at x ${probe.x} where the world says 761.5.`);
    }
    if (field.findStatic(0xdeadbeef, 0, probe)) {
      failures.push('`findStatic` found a car nothing ever adopted.');
    }

    field.drop('3_-4');
    if (field.tileCount !== 0 || field.carCount !== 0 || field.bytes !== 0) {
      failures.push(
        `After \`drop\` the field holds ${field.tileCount} tile(s), ${field.carCount} car(s) and ` +
          `${field.bytes} byte(s). The cap is counted off these and a leak here never gets under it.`,
      );
    }
    field.drop('3_-4');
    if (field.bytes !== 0) failures.push('A second `drop` of the same key double-counted the release.');
  }

  // --- A tile decoded without its key is refused rather than held nameless.
  if (anonymous !== null) {
    const nameless = new StaticCarField();
    nameless.adopt('3_-4', anonymous, 0, 0);
    if (nameless.tileCount !== 0) {
      failures.push('The field adopted a tile with no identities; nothing could ever name those cars.');
    }
  }

  // --- The estimator, and the whole-city number the cap is set against.
  if (estimateStaticCarBytes(2, 1) <= estimateStaticCarBytes(1, 1)) {
    failures.push('`estimateStaticCarBytes` is not monotone in the car count.');
  }
  const wholeCity = estimateStaticCarBytes(1_402_623, 13_362);
  if (wholeCity > 50e6) {
    failures.push(
      `The whole static fleet estimates at ${(wholeCity / 1e6).toFixed(1)} MB, over the 50 MB this ` +
        'layer was sized against. Re-measure `BYTES_PER_STATIC_CAR` and re-argue the cap in DEPLOY.md.',
    );
  }

  return failures;
}

/**
 * The three-free half of the parked-car pooling check. Both boot lists.
 *
 * `world/parkedpool-check.verifyParkedPool` is the whole of it -- it builds real
 * tiles through a real `InstancePool` and claims a real car through `carlod` --
 * and it cannot run here, because every one of those nouns is three. What *can*
 * run here is the seam the two ends of that machinery meet at, which is
 * `binCarsByBody`: the builder lays a tile's instances out in this order and
 * `carlod` addresses them in this order, and a disagreement is a car folded flat
 * somewhere the player is not looking.
 *
 * The properties, and what each one is worth:
 *
 *   - **Every car is in exactly one bin.** A row lost here is a car that draws
 *     and can never be claimed; a row in two bins is two cars sharing an
 *     instance, so hiding one hides the other.
 *   - **A bin's slots are `0 .. n-1`, in sidecar order, with no gaps.** This is
 *     what makes `claim.count === members[b].length` a sufficient capacity
 *     check rather than a coincidence, and that check is the one thing standing
 *     between a mismatched sidecar and `carlod` zero-scaling the wrong car.
 *   - **The bins sum to the tile's count** for every distribution, including the
 *     ones the streamer meets most: a tile of one body, and a tile with a body
 *     class entirely absent (which is the common case -- most tiles have no
 *     vans) and therefore a span that is never claimed at all.
 *
 * Cheap and total over a synthetic tile rather than sampled: 500 rows is 500
 * comparisons and it is run once at boot.
 */
export function verifyParkedBins(): string[] {
  const failures: string[] = [];

  // A distribution with all five bodies, a heavy majority, and one body class
  // that never appears -- the tile shape the streamer actually sees most.
  const count = 500;
  const body = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    // 3 is deliberately never produced: an absent body must yield an empty bin
    // rather than an off-by-one in every bin after it.
    body[i] = [0, 0, 0, 1, 2, 4][i % 6];
  }
  const bins = binCarsByBody(body, count, STATIC_BODY_COUNT);

  if (bins.members.length !== STATIC_BODY_COUNT) {
    failures.push(
      `\`binCarsByBody\` returned ${bins.members.length} bins for ${STATIC_BODY_COUNT} bodies.`,
    );
  }
  if (bins.members[3]?.length !== 0) {
    failures.push(
      `The body-3 bin holds ${bins.members[3]?.length} cars in a tile that has none of them. ` +
        'An absent body must be an empty bin, because `buildTileCars` claims no span for it and ' +
        '`carlod` must then find no instance rather than somebody else\'s.',
    );
  }

  // Every row in exactly one bin, at the slot the bins claim, in sidecar order.
  const seen = new Uint8Array(count);
  let binned = 0;
  for (let b = 0; b < bins.members.length; b++) {
    const members = bins.members[b];
    for (let n = 0; n < members.length; n++) {
      const i = members[n];
      binned++;
      if (seen[i] !== 0) failures.push(`Row ${i} is in two bins; two cars would share one instance.`);
      seen[i] = 1;
      if (body[i] !== b) failures.push(`Row ${i} is body ${body[i]} and was binned as ${b}.`);
      if (bins.slot[i] !== n) {
        failures.push(
          `Row ${i} is the ${n}-th car of body ${b} and \`slot\` says ${bins.slot[i]}. ` +
            '`carlod` would fold a different car flat than the one the player is standing at.',
        );
      }
      if (n > 0 && members[n - 1] > i) {
        failures.push(
          `Body ${b}'s bin runs ${members[n - 1]} then ${i}, which is not sidecar order. ` +
            '`buildTileCars` writes its instances in that order and nothing records it afterwards.',
        );
      }
    }
  }
  if (binned !== count) {
    failures.push(
      `The bins hold ${binned} of ${count} cars. A row in no bin is a car that draws and can ` +
        'never be claimed.',
    );
  }

  // A tile of one body, which is where an off-by-one hides: every slot is its
  // own row index, so a bin that started at 1 would still look plausible.
  const single = new Uint8Array(7);
  const one = binCarsByBody(single, single.length, STATIC_BODY_COUNT);
  if (one.members[0].length !== 7 || one.slot[0] !== 0 || one.slot[6] !== 6) {
    failures.push(
      `A seven-car single-body tile binned to ${one.members[0].length} cars with slots ` +
        `${one.slot[0]}..${one.slot[6]}; it must be 7 cars at 0..6.`,
    );
  }

  // And a body the decoder should never emit. It is dropped rather than thrown
  // on, because a build that stops clamping must lose one car and not a tile.
  const rogue = new Uint8Array([0, 200, 1]);
  const out = binCarsByBody(rogue, rogue.length, STATIC_BODY_COUNT);
  if (out.members[0].length !== 1 || out.members[1].length !== 1) {
    failures.push('A row naming a body outside the table disturbed the bins around it.');
  }

  return failures;
}
