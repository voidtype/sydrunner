/**
 * Every car in the near field is drawn by exactly one fleet, every frame.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `verifyParkedPool`.
 *
 * The owner, on the live build: *"i think some of the car models are
 * invisible"*. That sentence has been true of this machinery twice already and
 * both times for a different reason -- `d8b7598` because `carlod.end()` was
 * never called and no claimed car ever uploaded, and `e035953`'s round because
 * a pooled span is a second owner of the same matrices -- so the third time it
 * is worth having a check whose subject is *the picture* rather than the
 * bookkeeping.
 *
 * `verifyParkedPool` asserts the bookkeeping: spans are the right length, a
 * folded box comes back bit-for-bit, an eviction gives back what it took. Every
 * one of those can hold while a car is invisible, because the two things that
 * decide whether a car is on screen are not in it:
 *
 *   - **`InstancedMesh.count`**, which is what the draw call asks for. A claim
 *     whose index landed past it is a car that is not drawn, and the box was
 *     suppressed *because* it was claimed.
 *   - **`BufferAttribute.version`**, which is what actually reaches the GPU. A
 *     matrix written into the array and never uploaded draws at whatever the
 *     GPU last had -- all zeroes on a mesh that has never uploaded, which is a
 *     point rather than a car. That is `d8b7598` exactly, and nothing in this
 *     repo watches for it.
 *
 * So this check never reads `claim.matrix` or any other field of the fleet's
 * own bookkeeping. It reads **the last array contents that were uploaded** --
 * snapshotted whenever an attribute's `version` moves, which is precisely the
 * renderer's own trigger -- and the current `count`, and from those two it
 * reconstructs what a frame would actually rasterise. A car is then required to
 * be drawn by exactly one of the two fleets:
 *
 *     drawn(car) == 1, every car, every frame, or it is a bug.
 *
 * Zero is the owner's report. Two is the double-draw the LOD swap exists to
 * avoid, and is how the same seam fails in the other direction.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRIVES.
 *
 * A real `InstancePool`, a real `CarAssets`, real `buildTileCars` spans, a real
 * `TrafficField` out of `syntheticTile`, and a real `CarModelFleet` whose pools
 * are built from `CAR_FLEET` -- the shipped manifest's own order and weights, so
 * the modulus under test is the city's. 900 frames of the frame loop `main.ts`
 * actually runs, in its order: `drivenSetChanged` -> gated `sweep` -> `begin` ->
 * `claimed` per posed car -> `end`.
 *
 * Five populations, because "some of the car models are invisible" does not say
 * which and the answer has to be a number:
 *
 *   1. **Parked**, over a 3 x 3 ring of tiles, walked through at road speed.
 *   2. **Schedule movers**, on a street of synthetic routes, through the same
 *      `forEachCarNear` walk `TrafficMovers.update` uses.
 *   3. **Driven**, taken and given back, including a record that is in
 *      `drivenIdentities` but out of `drivenClaims`' range gate -- a car
 *      somebody else is driving in the next suburb, which is the one case where
 *      the two feeds legitimately disagree.
 *   4. **Overflow**, a tile dense enough that one model's 64 instances are all
 *      spoken for. A car that finds its model full must stay a box; a car that
 *      is refused *after* its box was folded is invisible.
 *   5. **A hole**, one manifest row that failed to load, holding `weight` slots
 *      so the modulus is unchanged. The cars that hash to it must stay boxes.
 *
 * And an eviction and a re-adopt in the middle of all of it, because a span
 * handed back to the allocator while `carlod` still points into it is the one
 * failure mode that survives every static check.
 *
 * Every branch increments a counter and a zero counter is a failure, on the
 * repo's own rule -- `0 grows` is how the last instance-pool bug shipped.
 *
 * ---------------------------------------------------------------------------
 * AND IT WAS PROVED TO FAIL, WHICH IS THE OTHER HALF OF THAT RULE.
 *
 * A check nobody has watched go red is a counter that reads zero. Two mutations
 * of `world/carlod.ts` were applied and reverted while writing this:
 *
 *   - deleting `instanceMatrix.needsUpdate = true` from `end()` -- which *is*
 *     `d8b7598` -- turned it red at frame 12 with 10,796 parked-car occurrences
 *     across five body classes, plus the driven car;
 *   - setting `mesh.count = claims.length - 1` in `consider` turned it red on
 *     frame 0 with "43 claim(s) but 32 model instance(s) would be drawn".
 *
 * Neither mutation moves `verifyParkedPool`, `verifyParkedBins`,
 * `verifyRangeAlloc`, `verifyCarLabels` or `verifyTraffic` off green. That gap
 * is why this file exists.
 *
 * **What it does not cover, stated so the next person does not assume it
 * does.** The `game/viewlatch.ts` gate is not modelled -- `TrafficMovers` skips
 * `fill` for a latched car, so `claimed()` is not called for it, while
 * `carlod.sweep` claims it anyway; that produces a model drawn where the latch
 * meant to draw nothing, which is over-draw rather than absence and belongs to
 * `verifyViewLatch`. Nor does it cover the shader: a model whose geometry is
 * merged and whose matrix is uploaded can still be black if its atlas fails, and
 * only eyes or `scripts/render-car-sheet.mjs` can judge that.
 */

import { BufferGeometry, InstancedMesh, Object3D } from 'three/webgpu';

import { CAR_FLEET } from '../game/carlabels.ts';
import { binCarsByBody } from '../game/staticcars.ts';
import type { TileCars } from '../game/staticcars.ts';
import {
  createCarPose,
  forEachCarNear,
  syntheticTile,
  TrafficField,
  type LaneRoute,
} from '../game/traffic.ts';
import { BODY_COUNT, CarAssets, buildTileCars, TRAFFIC_DRAW_RADIUS } from './cars.ts';
import { CarModelFleet, CLAIM_RADIUS, SWEEP_HZ } from './carlod.ts';
import { InstancePool, type InstanceClaim, type PooledSet } from './instancepool.ts';

// --- The fixture's numbers ------------------------------------------------------

/** Metres a side, as the pipeline bakes them. */
const TILE_SIZE = 250;
/** A 3 x 3 ring around the walk. Enough for a claim radius to span a seam. */
const RING = 3;
/** Cars per ring tile. A dense inner-ring tile is about 105. */
const CARS_PER_TILE = 140;
/** Frames driven, at 60 Hz. Fifteen seconds is seventy-five sweeps. */
const FRAMES = 900;
/** How far a car moves in a frame, metres. Road speed. */
const STEP = 20 / 60;

/**
 * The tile that overflows one model, and where it stands.
 *
 * `PER_MODEL_CAPACITY` is 64 and body 1's pool is five parts Corolla to one part
 * Golf, so 400 hatchbacks inside `CLAIM_RADIUS` offer the Corolla about 333
 * claims against 64 places. The overflow is the point: a car whose model is full
 * must draw as the box it already was, and the failure this catches is the
 * refusal landing *after* something folded its box.
 */
const DENSE_CARS = 400;
const DENSE_ORIGIN_X = 40_000;
const DENSE_ORIGIN_Z = 40_000;

/** The route street, far from every parked car so a mover's model cannot be mistaken for one. */
const STREET_X = -80_000;
const STREET_Z = -80_000;

/** How close two matrices' translations have to be to be the same car, metres. */
const SAME_PLACE = 0.05;

/**
 * The manifest row this check refuses to load, and why one is refused at all.
 *
 * `reserveHole` takes `weight` slots rather than one, which is the fix in
 * `888f366` -- and a hole is the one pool entry that can hand `consider` a
 * `null` slot. A city where the first failed fetch is untested is a city where
 * the cars that hash to that row are drawn by nobody if the null is mishandled.
 */
const HOLED_FILE = 'mazda_cx5_tnnv.glb';

// --- Reading what the GPU would actually draw ------------------------------------

/**
 * The last contents of an instance buffer that were *uploaded*.
 *
 * three re-sends an attribute when its `version` moves, and `needsUpdate = true`
 * is the only thing that moves it. So a snapshot taken whenever the version
 * changes is exactly the bytes the GPU holds, and comparing it against the live
 * array is how "written but never uploaded" -- the `d8b7598` failure -- becomes
 * a number instead of a screenshot.
 */
class Uploaded {
  private version = -1;
  private bytes = new Float32Array(0);

  /** Re-read if the attribute was uploaded since the last call. Returns the GPU's copy. */
  poll(mesh: InstancedMesh): Float32Array {
    const attr = mesh.instanceMatrix;
    if (attr.version !== this.version) {
      this.version = attr.version;
      const src = attr.array as Float32Array;
      if (this.bytes.length !== src.length) this.bytes = new Float32Array(src.length);
      this.bytes.set(src);
    }
    return this.bytes;
  }
}

/** Does an instance rasterise anything? A zero basis maps the whole body to a point. */
function drawsAt(m: Float32Array, at: number): boolean {
  for (let e = 0; e < 12; e++) if (!Number.isFinite(m[at + e])) return false;
  const basis =
    m[at + 0] !== 0 || m[at + 1] !== 0 || m[at + 2] !== 0 ||
    m[at + 4] !== 0 || m[at + 5] !== 0 || m[at + 6] !== 0 ||
    m[at + 8] !== 0 || m[at + 9] !== 0 || m[at + 10] !== 0;
  return basis;
}

// --- The fixture -----------------------------------------------------------------

/** A synthetic sidecar. Identities are unique and dense, as a real tile's are. */
function fakeTile(
  count: number,
  first: number,
  spread: (i: number) => [number, number],
  bodyAt: (i: number) => number,
): TileCars {
  const data: TileCars = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    heading: new Float32Array(count),
    body: new Uint8Array(count),
    colour: new Uint8Array(count),
    seed: new Uint16Array(count),
    identity: new Uint32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const [x, z] = spread(i);
    data.x[i] = x;
    data.z[i] = z;
    data.heading[i] = (i % 16) * 0.3927;
    data.body[i] = bodyAt(i);
    data.colour[i] = i % 8;
    data.seed[i] = (i * 2654) & 0xffff;
    data.identity[i] = first + i;
  }
  return data;
}

/** Not flat, so a parked car's matrix carries a real grade pitch. */
function bumpyGround(x: number, z: number): number {
  return 0.04 * ((x * 0.37 + z * 0.11) % 7);
}

/** One parked car, as this check has to be able to find it without asking `carlod`. */
interface Car {
  identity: number;
  /** World metres. */
  x: number;
  z: number;
  body: number;
  /** The species mesh's own key, and the absolute instance within it. */
  poolKey: string;
  poolIndex: number;
}

/** A tile of the fixture, and everything needed to evict and re-adopt it. */
interface Tile {
  key: string;
  data: TileCars;
  sets: PooledSet[];
  claims: InstanceClaim[];
  originX: number;
  originZ: number;
  cars: Car[];
  live: boolean;
}

/**
 * The cars in a tile, with the pool address `buildTileCars` gave each one.
 *
 * Re-derived from `binCarsByBody` and `PooledSet.claim` rather than read off
 * `carlod`, deliberately: this check must be able to say "the box of car X is
 * folded" without believing anything the file under test says about where car
 * X's box is.
 */
function addressCars(data: TileCars, sets: readonly PooledSet[], originX: number, originZ: number): Car[] {
  const byBody = new Map<number, InstanceClaim>();
  for (const set of sets) {
    const match = /^cars_(\d+)$/.exec(set.claim.key);
    if (match) byBody.set(Number(match[1]), set.claim);
  }
  const bins = binCarsByBody(data.body, data.count, BODY_COUNT);
  const out: Car[] = [];
  for (let i = 0; i < data.count; i++) {
    const claim = byBody.get(data.body[i]);
    if (claim === undefined) continue;
    out.push({
      identity: data.identity[i],
      x: data.x[i] + originX,
      z: data.z[i] + originZ,
      body: data.body[i],
      poolKey: claim.key,
      poolIndex: claim.start + bins.slot[i],
    });
  }
  return out;
}

/** A stand-in `CarField`, on the two feeds `main.ts` wires into the fleet. */
class Driven {
  readonly records = new Map<number, { x: number; z: number; body: number; colour: number }>();
  /** The range gate `drivencars.DrivenCarView.near` applies to `claims` but not to identities. */
  gate: (x: number, z: number) => boolean = () => true;

  suppress = (identity: number): boolean => this.records.has(identity);
  identities = (visit: (identity: number) => void): void => {
    for (const id of this.records.keys()) visit(id);
  };
}

export function verifyCarVisibility(): string[] {
  const failures: string[] = [];
  const counters: Record<string, number> = {
    ringTiles: 0,
    ringCars: 0,
    denseCars: 0,
    modelsLoaded: 0,
    holesReserved: 0,
    routesAdopted: 0,
    framesDriven: 0,
    framesWithParkedModels: 0,
    framesWithMoverModels: 0,
    framesWithDrivenModel: 0,
    sweepsForced: 0,
    overflowsSeen: 0,
    holeCarsSeen: 0,
    remoteBoxesFolded: 0,
    boxesRestored: 0,
    tilesEvicted: 0,
    tilesReadopted: 0,
    uploadsSeen: 0,
    poolGrows: 0,
  };
  /** Every distinct fault, once, with the frame it first happened on. */
  const faults = new Map<string, { frame: number; n: number }>();
  const fault = (frame: number, what: string): void => {
    const seen = faults.get(what);
    if (seen === undefined) faults.set(what, { frame, n: 1 });
    else seen.n++;
  };

  const root = new Object3D();
  const pool = new InstancePool(root);
  const assets = new CarAssets();

  // --- The fleet, from the shipped manifest's own order and weights.
  const fleet = new CarModelFleet(createCarPose());
  for (const entry of CAR_FLEET) {
    const body = typeof entry.body === 'number' ? entry.body : entry.body === 'police' ? 'police' : null;
    if (body === null) continue;
    if (entry.file === HOLED_FILE) {
      fleet.reserveHole(body, entry.file, 'fetch failed (fixture)', entry.weight);
      counters.holesReserved++;
      continue;
    }
    fleet.addModel(
      { file: entry.file, body: entry.body, tris: 0, lengthM: 4.5, tint: 'multiply', weight: entry.weight, license: '', attribution: '' },
      // Its own geometry, never a shared one: `dispose` frees the geometry of
      // every mesh this made, and handing it a pooled body would delete a sedan
      // out from under the pool. See `verifyParkedPool`.
      { map: null, geometry: new BufferGeometry(), box: { length: 4.5, width: 1.8, height: 1.5 }, seat: 0, triangles: 0 },
      body,
    );
    counters.modelsLoaded++;
  }
  // The modulus is the city's, or this check is testing a different Sydney.
  {
    const sizes = fleet.poolSizes();
    const wanted: Record<string, number> = {};
    for (const entry of CAR_FLEET) {
      const key = typeof entry.body === 'number' ? String(entry.body) : entry.body;
      if (key !== 'police' && Number.isNaN(Number(key))) continue;
      wanted[key] = (wanted[key] ?? 0) + Math.max(1, Math.min(16, Math.round(entry.weight)));
    }
    for (const [key, n] of Object.entries(wanted)) {
      if (sizes[key] !== n) {
        failures.push(
          `Pool ${key} is ${sizes[key]} long against the manifest's ${n}. A hole that does not take ` +
            "`weight` slots is a different modulus, which is a different model on every car in the class.",
        );
      }
    }
  }

  // --- The parked ring, and the dense tile that overflows a model.
  const tiles: Tile[] = [];
  for (let t = 0; t < RING * RING; t++) {
    const originX = (t % RING) * TILE_SIZE;
    const originZ = Math.floor(t / RING) * TILE_SIZE;
    // A lattice rather than a hash, so no two cars share a position and the
    // "which car is this model standing on" question has one answer.
    const data = fakeTile(
      CARS_PER_TILE,
      t * 10_000 + 1,
      (i) => [8 + (i % 14) * 17, 8 + Math.floor(i / 14) * 23],
      (i) => (i * 7 + t) % BODY_COUNT,
    );
    const sets = buildTileCars(data, assets, pool, originX, originZ, bumpyGround);
    pool.flush();
    tiles.push({
      key: `ring_${t}`,
      data,
      sets,
      claims: sets.map((s) => s.claim),
      originX,
      originZ,
      cars: addressCars(data, sets, originX, originZ),
      live: true,
    });
    counters.ringTiles++;
    counters.ringCars += data.count;
  }
  {
    const data = fakeTile(
      DENSE_CARS,
      500_001,
      (i) => [4 + (i % 20) * 6, 4 + Math.floor(i / 20) * 6],
      () => 1,
    );
    const sets = buildTileCars(data, assets, pool, DENSE_ORIGIN_X, DENSE_ORIGIN_Z, bumpyGround);
    pool.flush();
    tiles.push({
      key: 'dense',
      data,
      sets,
      claims: sets.map((s) => s.claim),
      originX: DENSE_ORIGIN_X,
      originZ: DENSE_ORIGIN_Z,
      cars: addressCars(data, sets, DENSE_ORIGIN_X, DENSE_ORIGIN_Z),
      live: true,
    });
    counters.denseCars = data.count;
  }
  for (const tile of tiles) fleet.adopt(tile.key, tile.data, tile.sets, tile.originX, tile.originZ);

  // --- The street the schedule fleet runs on, well away from every parked car.
  //
  // **A distinct `rid` per tile, and it is not cosmetic.** `traffic.carHash` is
  // a hash of `(rid, slot)`, so three copies of one synthetic route produce
  // three cars carrying the *same* identity -- and `claimed()` is keyed on
  // identity, so all three suppress their boxes and one model is drawn between
  // them. That is a fixture producing the exact picture this check is hunting,
  // which would have made it fail for a reason the city cannot have.
  const field = new TrafficField();
  for (let i = 0; i < 3; i++) {
    field.adopt(
      `street_${i}`,
      syntheticTile(1.875, STREET_X, STREET_Z - i * 200, undefined, undefined, 3, 0, 0x21 + i),
    );
    counters.routesAdopted++;
  }

  // --- Where the player is, and which car they are in. Declared before the two
  // feeds below, which close over both.
  let px = 40;
  let pz = 300;
  let takenId = -1;
  let drivenX = 0;
  let drivenZ = 0;

  // --- The two driven feeds, on `main.ts`'s wiring.
  const driven = new Driven();
  fleet.suppress = driven.suppress;
  fleet.drivenIdentities = driven.identities;
  const drivenPose = createCarPose();
  fleet.drivenClaims = (visit) => {
    for (const [identity, rec] of driven.records) {
      const x = identity === takenId ? drivenX : rec.x;
      const z = identity === takenId ? drivenZ : rec.z;
      // The range gate. `drivencars.DrivenCarView.near` applies it here and not
      // to `drivenIdentities`, and this check exists partly because that is the
      // one place the two feeds legitimately disagree.
      if (!driven.gate(x, z)) continue;
      drivenPose.identity = identity;
      drivenPose.body = rec.body;
      drivenPose.colour = rec.colour;
      drivenPose.x = x;
      drivenPose.y = 0.2;
      drivenPose.z = z;
      drivenPose.dx = 1;
      drivenPose.dz = 0;
      drivenPose.damage = 0;
      drivenPose.scale = 1;
      visit(drivenPose);
    }
  };

  // --- The uploaded snapshots, one per mesh that can draw a car.
  const modelUploads = fleet.meshes.map(() => new Uploaded());
  const poolUploads = new Map<string, Uploaded>();
  const poolMeshOf = (key: string): InstancedMesh | null => {
    for (const child of root.children) {
      // Looked up by **name every frame** and never cached, because
      // `InstancePool.resize` replaces the mesh outright when a species grows --
      // a cached reference would go on reading a buffer nothing draws from, and
      // this check would then be reporting the state of a dead object.
      if (child.name === `pool_${key}`) return child as InstancedMesh;
    }
    return null;
  };
  /** Is this car's box standing, in the bytes the GPU holds? */
  const boxDrawnOf = (car: Car): boolean => {
    const mesh = poolMeshOf(car.poolKey);
    if (mesh === null) return false;
    let up = poolUploads.get(car.poolKey);
    if (up === undefined) { up = new Uploaded(); poolUploads.set(car.poolKey, up); }
    const bytes = up.poll(mesh);
    const at = car.poolIndex * 16;
    return at + 16 <= bytes.length && drawsAt(bytes, at);
  };

  const scratch: LaneRoute[] = [];
  const moverPose = createCarPose();

  /** Where the model instances the GPU would draw this frame actually are. */
  const modelAt: Array<{ x: number; z: number }> = [];
  /** Cars `claimed()` said yes to this frame, so a model must stand on each. */
  const modelWanted: Array<{ x: number; z: number; what: string }> = [];
  /** Cars `claimed()` said no to, so the box fleet drew them and no model may. */
  const modelUnwanted: Array<{ x: number; z: number; what: string }> = [];
  /** `TrafficMovers`' own per-body instance counters, so its capacity gate is real here too. */
  const moverCounts = new Int32Array(BODY_COUNT);
  /** Identities the schedule walk offered this frame, so a fixture collision convicts itself. */
  const posedThisFrame = new Set<number>();

  let sweepClock = -1000;
  /** The car somebody *else* takes, so its two halves can be counted. See frame 280. */
  let remoteCar: Car | null = null;
  /**
   * Held only so the filler tile's spans stay claimed for the rest of the run.
   *
   * Giving them back would shrink the species again and the growth this exists
   * to force would be undone half way through the frames that test it.
   */
  const fillerSets: PooledSet[] = [];

  for (let frame = 0; frame < FRAMES; frame++) {
    const now = frame * (1000 / 60);

    // --- Where the player is. Four phases, so each population is walked through
    // in turn and the answer to "which one goes invisible" is a number rather
    // than a guess.
    if (frame < 300) {
      px += STEP; // across the parked ring, over two tile seams
    } else if (frame === 300) {
      px = DENSE_ORIGIN_X + 60; // into the overflow tile
      pz = DENSE_ORIGIN_Z + 60;
    } else if (frame < 420) {
      px += STEP;
    } else if (frame === 420) {
      px = STREET_X; // onto the street the schedule fleet runs on
      pz = STREET_Z;
    } else if (frame < 600) {
      pz -= STEP;
    } else {
      // --- Churn. Teleported between two spots in the ring every third frame,
      // which is a claim taken and given back on nearly every sweep -- the
      // compaction path (`revoke` moving the last claim into the vacated
      // instance) run hundreds of times rather than twice.
      const a = frame % 6 < 3;
      px = a ? 60 : 60 + 2 * CLAIM_RADIUS;
      pz = a ? 300 : 300;
    }

    // --- The events, in the order a session produces them.
    if (frame === 60) {
      // Take the nearest parked car: `predictTakeCar` on the frame `E` is pressed.
      let best: Car | null = null;
      let bestD = Infinity;
      for (const car of tiles[0].cars.concat(tiles[1].cars, tiles[3].cars, tiles[4].cars)) {
        const d = (car.x - px) ** 2 + (car.z - pz) ** 2;
        if (d < bestD) { bestD = d; best = car; }
      }
      if (best !== null) {
        takenId = best.identity;
        drivenX = best.x;
        drivenZ = best.z;
        driven.records.set(best.identity, { x: best.x, z: best.z, body: best.body, colour: 0 });
      }
    }
    if (frame > 60 && frame < 200 && takenId >= 0) {
      drivenX += 12 / 60;
      // Out of the bay and into the lane, which is what a car pulling out does
      // and which also keeps a driven model off the lattice this fixture parks
      // on -- two cars at the identical coordinates would make "which car is
      // this model standing on" ambiguous, and the question has to have one
      // answer for the count below to mean anything.
      drivenZ = driven.records.get(takenId)!.z + 1.9;
    }
    if (frame === 200) {
      // A species grows **while claims are standing in it**: `InstancePool
      // .resize` replaces the mesh, and every `PooledSet` held by `carlod` now
      // addresses a buffer that did not exist when the claim was taken. Not
      // adopted into the fleet -- the growth is the point, not these cars.
      const filler = fakeTile(9000, 800_001, (i) => [(i % 90) * 2.5, Math.floor(i / 90) * 2.5], () => 0);
      fillerSets.push(...buildTileCars(filler, assets, pool, 200_000, 200_000, bumpyGround));
      pool.flush();
      counters.poolGrows = pool.grows;
    }
    if (frame === 240 && takenId >= 0) {
      // `recycleFarthest`, or the driver's client leaving: the record goes and
      // the box has to come back in the bay it was taken from.
      driven.records.delete(takenId);
      takenId = -1;
    }
    if (frame === 280) {
      // Somebody else's take, in a tile this player is standing in but out of
      // the `drivenClaims` range gate: `drivenIdentities` sees it, `claims` does
      // not. The box must be folded and nothing must be drawn in its place.
      remoteCar = tiles[8].cars[10];
      driven.records.set(remoteCar.identity, {
        x: remoteCar.x, z: remoteCar.z, body: remoteCar.body, colour: 3,
      });
      driven.gate = (x, z) => (x - px) ** 2 + (z - pz) ** 2 < 150 * 150;
    }
    if (frame === 460) {
      driven.records.clear();
      driven.gate = () => true;
      takenId = -1;
    }
    if (frame === 340) {
      // An eviction while claims are standing in the tile, in the streamer's own
      // order: the sink lets go first, then the spans go back to the pool.
      const tile = tiles[2];
      if (tile.live) {
        fleet.release(tile.key);
        for (const claim of tile.claims) pool.release(claim);
        tile.live = false;
        counters.tilesEvicted++;
      }
    }
    if (frame === 380) {
      const tile = tiles[2];
      if (!tile.live) {
        tile.sets = buildTileCars(tile.data, assets, pool, tile.originX, tile.originZ, bumpyGround);
        pool.flush();
        tile.claims = tile.sets.map((s) => s.claim);
        tile.cars = addressCars(tile.data, tile.sets, tile.originX, tile.originZ);
        fleet.adopt(tile.key, tile.data, tile.sets, tile.originX, tile.originZ);
        tile.live = true;
        counters.tilesReadopted++;
      }
    }

    // --- `main.ts`'s frame loop, in `main.ts`'s order.
    const changed = fleet.drivenSetChanged();
    if (changed || now - sweepClock >= 1000 / SWEEP_HZ) {
      if (changed && frame > 0) counters.sweepsForced++;
      sweepClock = now;
      fleet.sweep(field, frame * 2, px, pz);
    }

    const modelling = fleet.begin();
    let moverModels = 0;
    // Where a car that `claimed()` said yes to has to be drawn, and where one it
    // said no to must **not** be -- the box fleet is drawing that one, and a
    // model standing on it as well is the double-draw the swap exists to avoid.
    modelWanted.length = 0;
    modelUnwanted.length = 0;
    if (modelling) {
      // `TrafficMovers.update`'s own walk, with its own suppression clause and
      // its own per-body capacity gate, and the driven half after it -- both ask
      // `claimed()` and both are how a claimed car's matrix gets written.
      for (let b = 0; b < BODY_COUNT; b++) moverCounts[b] = 0;
      posedThisFrame.clear();
      forEachCarNear(field, px, pz, TRAFFIC_DRAW_RADIUS, frame * 2, scratch, moverPose, (p) => {
        if (driven.suppress(p.identity)) return;
        // **The fixture's own honesty check, and it caught itself.** `claimed()`
        // is keyed on identity and `traffic.carHash` is a hash of `(rid, slot)`,
        // so two synthetic tiles built from the same route id produce two cars
        // carrying one identity -- both suppress their boxes and one model is
        // drawn between them, which is exactly the picture this file is hunting
        // and would be a fault the city cannot have. See the `rid` argument
        // where the street is adopted.
        if (posedThisFrame.has(p.identity)) {
          fault(frame, `the fixture posed identity ${p.identity} twice in one frame; two routes share a rid`);
          return;
        }
        posedThisFrame.add(p.identity);
        if (moverCounts[p.body] >= 384) return; // `cars.MOVER_CAPACITY`
        if (fleet.claimed(p)) {
          moverModels++;
          modelWanted.push({ x: p.x, z: p.z, what: `schedule car ${p.identity}` });
        } else {
          moverCounts[p.body]++;
          modelUnwanted.push({ x: p.x, z: p.z, what: `schedule car ${p.identity} drawn as a box` });
        }
      });
      fleet.drivenClaims((p) => {
        if (fleet.claimed(p)) {
          counters.framesWithDrivenModel++;
          modelWanted.push({ x: p.x, z: p.z, what: `driven car ${p.identity}` });
        } else {
          modelUnwanted.push({ x: p.x, z: p.z, what: `driven car ${p.identity} drawn as a box` });
        }
      });
    }
    fleet.end();
    counters.framesDriven++;
    if (moverModels > 0) counters.framesWithMoverModels++;

    // --- And now: what would this frame actually draw?
    modelAt.length = 0;
    let liveModelInstances = 0;
    for (let m = 0; m < fleet.meshes.length; m++) {
      const mesh = fleet.meshes[m];
      const bytes = modelUploads[m].poll(mesh);
      if (mesh.count > (mesh.instanceMatrix.array as Float32Array).length / 16) {
        fault(frame, `model mesh ${mesh.name} draws ${mesh.count} instances past its buffer`);
      }
      for (let i = 0; i < mesh.count; i++) {
        const at = i * 16;
        if (at + 16 > bytes.length) {
          fault(frame, `model mesh ${mesh.name} instance ${i} is past the last upload`);
          continue;
        }
        if (!drawsAt(bytes, at)) {
          fault(
            frame,
            `model mesh ${mesh.name} instance ${i} of ${mesh.count} is degenerate in the uploaded ` +
              'buffer: a claimed car with its box suppressed and nothing drawn in its place',
          );
          continue;
        }
        liveModelInstances++;
        modelAt.push({ x: bytes[at + 12], z: bytes[at + 14] });
      }
    }
    if (liveModelInstances !== fleet.claimedCount) {
      fault(
        frame,
        `${fleet.claimedCount} claim(s) but ${liveModelInstances} model instance(s) would be drawn; ` +
          'every claim suppresses a box, so the difference is cars drawn by nobody',
      );
    }
    if (liveModelInstances > 0) counters.uploadsSeen++;

    // --- The moving half, which is the population `verifyParkedPool` cannot
    // reach at all: a car `claimed()` answered *true* for is a car whose box was
    // deliberately not filled, so if no model instance stands where it is, that
    // car is drawn by nobody. This is `d8b7598`'s failure -- "moving cars appear
    // to be invisible" -- stated as an invariant instead of as a bug report.
    for (const want of modelWanted) {
      let here = 0;
      for (const p of modelAt) {
        if (Math.abs(p.x - want.x) < SAME_PLACE && Math.abs(p.z - want.z) < SAME_PLACE) here++;
      }
      if (here === 0) {
        fault(
          frame,
          `${want.what} was claimed -- so its box was suppressed -- and no model instance the GPU ` +
            'would draw stands where it is. That car is drawn by nobody.',
        );
      } else if (here > 1) {
        fault(frame, `${want.what} has ${here} model instances standing on it`);
      }
    }
    for (const nope of modelUnwanted) {
      let here = 0;
      for (const p of modelAt) {
        if (Math.abs(p.x - nope.x) < SAME_PLACE && Math.abs(p.z - nope.z) < SAME_PLACE) here++;
      }
      if (here > 0) fault(frame, `${nope.what} also has ${here} model instance(s) on it`);
    }

    // --- Every parked car, in every resident tile: drawn exactly once.
    let parkedModels = 0;
    for (const tile of tiles) {
      if (!tile.live) continue;
      const meshCache = new Map<string, Float32Array | null>();
      for (const car of tile.cars) {
        let bytes = meshCache.get(car.poolKey);
        if (bytes === undefined) {
          const mesh = poolMeshOf(car.poolKey);
          if (mesh === null) bytes = null;
          else {
            let up = poolUploads.get(car.poolKey);
            if (up === undefined) { up = new Uploaded(); poolUploads.set(car.poolKey, up); }
            bytes = up.poll(mesh);
          }
          meshCache.set(car.poolKey, bytes);
        }
        if (bytes === null) continue;
        const at = car.poolIndex * 16;
        const boxDrawn = at + 16 <= bytes.length && drawsAt(bytes, at);
        // How many model instances stand on this car's bay.
        let here = 0;
        for (const p of modelAt) {
          if (Math.abs(p.x - car.x) < SAME_PLACE && Math.abs(p.z - car.z) < SAME_PLACE) here++;
        }
        parkedModels += here;
        const isDriven = driven.records.has(car.identity);
        const drawn = (boxDrawn ? 1 : 0) + here;
        if (isDriven) {
          // The car is not furniture any more: its box must be folded. Whether a
          // model stands here depends on where the driver is -- a car that has
          // not moved off the bay yet is legitimately drawn on it.
          const atBay =
            Math.abs((car.identity === takenId ? drivenX : car.x) - car.x) < SAME_PLACE &&
            Math.abs((car.identity === takenId ? drivenZ : car.z) - car.z) < SAME_PLACE;
          if (boxDrawn) {
            fault(frame, `a car somebody is driving is still standing as a box in its bay`);
          } else if (!atBay && here > 0) {
            fault(frame, `${here} model(s) stand in a bay whose car has been driven ${Math.round(Math.hypot(drivenX - car.x, drivenZ - car.z))} m away`);
          }
          continue;
        }
        if (drawn === 0) {
          fault(
            frame,
            `parked car in ${tile.key} (body ${car.body}) is drawn by nobody: its box is folded flat ` +
              'and no model instance stands in its place -- this is "some of the car models are invisible"' +
              ` [claimed=${fleet.bandBox(car.identity) !== null}]`,
          );
        } else if (drawn > 1) {
          fault(
            frame,
            `parked car in ${tile.key} (body ${car.body}, identity ${car.identity}) is drawn ` +
              `${drawn} times over (box ${boxDrawn ? 'up' : 'flat'}, ${here} model(s), ` +
              `claimed=${fleet.bandBox(car.identity) !== null})`,
          );
        }
      }
    }
    if (parkedModels > 0) counters.framesWithParkedModels++;

    // --- WORKSTREAM S's two halves, counted rather than assumed. A box folded
    // because somebody in the next suburb is driving that car, and the same box
    // standing again when they give it back: both are things this check has to
    // have *seen* happen, or the clauses above them proved nothing.
    if (remoteCar !== null) {
      const up = boxDrawnOf(remoteCar);
      if (driven.records.has(remoteCar.identity)) { if (!up) counters.remoteBoxesFolded++; }
      else if (up) counters.boxesRestored++;
    }
  }

  counters.overflowsSeen = fleet.overflows;
  // The hole: cars that hash to it get no claim, so the count of body-2 cars
  // whose remainder lands on a null slot is what "stayed a box" was measured on.
  {
    const pools = fleet.poolFiles();
    const body2 = pools['2'] ?? [];
    for (const tile of tiles) {
      for (const car of tile.cars) {
        if (car.body !== 2) continue;
        if (body2[car.identity % body2.length] === HOLED_FILE) counters.holeCarsSeen++;
      }
    }
  }

  for (const [what, seen] of faults) {
    failures.push(`${what} (first at frame ${seen.frame}, ${seen.n} occurrence(s) over ${FRAMES} frames)`);
  }

  for (const [name, n] of Object.entries(counters)) {
    if (n === 0) {
      failures.push(
        `\`verifyCarVisibility\` counter \`${name}\` is 0, so that branch never ran and the check ` +
          'below it proved nothing. Fix the check, not the counter.',
      );
    }
  }

  fleet.dispose();
  return failures;
}
