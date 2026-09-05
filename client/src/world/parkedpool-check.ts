/**
 * The parked fleet, pooled: the check that would have caught it growing.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY A NUMBER RATHER THAN AN OPINION IS THE FIX.
 *
 * The owner's report was *"it seems to be slowing down over time now"*, and the
 * console line under it said the rest: `compiles 2495 over 110 keys`, with
 * `car_paint{color,normal,position}[inst] x803` and `ShadowMaterial{...}[inst]
 * x864` at the top of `AsyncPipelines.drift()`. three r0.185 puts `object.uuid`
 * into `RenderObject.getMaterialCacheKey()` for anything instanced, so every
 * `InstancedMesh` ever constructed is its own WGSL compile in the main pass and
 * another in the shadow pass -- and `cars.buildTileCars` was making up to five
 * of them per tile, forever, while `world/instancepool.ts`' own header listed it
 * among the builders still to convert. The frame median walked 23 ms to 38 ms
 * over a session with nothing on screen to account for it.
 *
 * The conversion is a change of constructor. What is *not* trivial is that
 * `world/carlod.ts` reaches into those matrices -- it folds a parked car's box
 * flat behind a model and puts it back afterwards -- so the parked fleet is the
 * one pooled species with a second owner, and every property below is one that,
 * broken, is invisible in a screenshot:
 *
 *   - **Meshes stop growing.** The whole point. One mesh per body class for the
 *     city, not per tile, however many tiles have streamed through.
 *   - **The instance count is exactly the cars.** A claim that over- or
 *     under-asks is a span whose length disagrees with the sidecar, which is
 *     precisely what `carlod.adopt`'s capacity check refuses a tile over --
 *     because the alternative is zero-scaling a car in another suburb.
 *   - **A claimed car's box is folded flat, and comes back bit-for-bit.** Not
 *     "close": the height, the heading, the grade pitch and the 4 % size jitter
 *     `buildTileCars` sampled exist nowhere else, so the matrix in the buffer is
 *     the only copy and a restore that rebuilt it would be a different car. This
 *     is also where the pool's origin fold could go wrong in the one way that
 *     matters -- a read through `getMatrixAt` and a write back through
 *     `setMatrixAt` would add the tile offset twice, and every car a player
 *     walked past would end up one tile east. See `InstancePool.getMatrixAt`.
 *   - **An eviction gives back exactly what the tile took.** Not less, which
 *     leaks a range until the session ends, and not more, which hands another
 *     tile's cars to the allocator while they are still drawing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT OUT OF THE REAL THINGS.
 *
 * A real `InstancePool`, a real `CarAssets`, a real `CarModelFleet` and 41
 * synthetic tiles through `buildTileCars`. No mock stands in for any of them,
 * because every bug listed above lives in the *seam* between two of them and a
 * mock is a seam removed. The one thing synthesised is the model file -- one
 * geometry-less entry in the body-0 pool -- since a `.glb` fetch is not
 * something a boot check may do, and the model's own contents decide nothing
 * here: what is under test is which instance is folded flat, not what is drawn
 * in front of it.
 *
 * Sized so the pool **grows** once (`INITIAL_CAPACITY` is 8,192 and body 0 gets
 * about 8,300 instances), because growth replaces the mesh and copies the
 * matrices, and "the restore is bit-for-bit" is worth much less if it has never
 * been asked across one. `A zero counter means untested` is a rule in this
 * repo written in blood -- `0 grows` is exactly how the last instance-pool bug
 * shipped -- so every branch below increments something and the counters are
 * asserted at the bottom rather than printed.
 *
 * The three-free half is `game/staticcars.verifyParkedBins`, in both boot lists:
 * it holds the instance *layout* both ends of this machinery agree on, and it
 * can run on the Bun server where none of the nouns above can be constructed.
 */

import { BufferGeometry, Matrix4, Object3D } from 'three/webgpu';

import { createCarPose, TrafficField } from '../game/traffic.ts';
import { BODY_COUNT, CarAssets, buildTileCars } from './cars.ts';
import { CarModelFleet, CLAIM_RADIUS } from './carlod.ts';
import { InstancePool, type InstanceClaim, type PooledSet } from './instancepool.ts';
import type { TileCars } from '../game/staticcars.ts';

/** Tiles built through the pool. The brief's number, and a real ring is 56. */
const TILES = 40;
/** Cars per synthetic tile. About twice a dense inner-ring tile's ~105. */
const CARS_PER_TILE = 250;
/** Metres a side, as the pipeline bakes them. */
const TILE_SIZE = 250;

/**
 * The body mix, chosen so body 0 crosses `INITIAL_CAPACITY` and the pool grows.
 *
 * Five of six cars are body 0: 40 x 250 x 5/6 is about 8,333 against a species'
 * opening 8,192. Body 3 never appears, which is the other case worth having --
 * most tiles in Sydney have no vans, and an absent body must claim no span at
 * all rather than an empty one.
 */
const BODY_MIX = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 4];

/**
 * The probe tile: few cars, far apart, far from everything else.
 *
 * Deliberately not one of the 40. `PER_MODEL_CAPACITY` is 64 instances per model
 * file and this check loads exactly one model, so a sweep standing in a dense
 * tile would fill it and the overflow would be the check's own doing rather than
 * a fault -- and `overflows` is a number this asserts stays at zero. Eight cars
 * at 30 m spacing puts a handful inside `CLAIM_RADIUS` and nothing near the
 * ceiling.
 */
const PROBE_CARS = 8;
const PROBE_SPACING = 30;
const PROBE_ORIGIN_X = 90_000;
const PROBE_ORIGIN_Z = -90_000;

/** A synthetic sidecar. Identities are unique and dense, as a real tile's are. */
function fakeTile(count: number, first: number, spread: (i: number) => [number, number], bodyAt: (i: number) => number): TileCars {
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
    // A spread of headings so the restore is asked about a rotation rather than
    // about an identity matrix that would survive being recomputed wrongly.
    data.heading[i] = (i % 16) * 0.3927;
    data.body[i] = bodyAt(i);
    data.colour[i] = i % 8;
    data.seed[i] = (i * 2654) & 0xffff;
    data.identity[i] = first + i;
  }
  return data;
}

/** A terrain that is not flat, so a car's grade pitch is a real rotation. */
function bumpyGround(x: number, z: number): number {
  return 0.04 * ((x * 0.37 + z * 0.11) % 7);
}

/** Every matrix a tile's claims hold, as raw floats. */
function snapshot(pool: InstancePool, sets: readonly PooledSet[]): Float32Array {
  let total = 0;
  for (const set of sets) total += set.claim.count;
  const out = new Float32Array(total * 16);
  const m = new Matrix4();
  let at = 0;
  for (const set of sets) {
    for (let i = 0; i < set.claim.count; i++) {
      pool.getMatrixAt(set.claim, i, m);
      m.toArray(out, at);
      at += 16;
    }
  }
  return out;
}

/** Instances whose 16 floats differ from the snapshot, and whether each is flat. */
function diff(now: Float32Array, before: Float32Array): { changed: number; flat: number } {
  let changed = 0;
  let flat = 0;
  for (let i = 0; i * 16 < now.length; i++) {
    let same = true;
    for (let e = 0; e < 16; e++) {
      if (now[i * 16 + e] !== before[i * 16 + e]) { same = false; break; }
    }
    if (same) continue;
    changed++;
    // A folded box: the three basis columns are zero, so the whole body maps to
    // a point and rasterises nothing. Checked rather than assumed, because "the
    // matrix changed" is also what a car moved to the wrong place looks like.
    const zeroBasis =
      now[i * 16 + 0] === 0 && now[i * 16 + 1] === 0 && now[i * 16 + 2] === 0 &&
      now[i * 16 + 4] === 0 && now[i * 16 + 5] === 0 && now[i * 16 + 6] === 0 &&
      now[i * 16 + 8] === 0 && now[i * 16 + 9] === 0 && now[i * 16 + 10] === 0;
    if (zeroBasis) flat++;
  }
  return { changed, flat };
}

export function verifyParkedPool(): string[] {
  const failures: string[] = [];
  const counters: Record<string, number> = {
    tilesBuilt: 0,
    spansClaimed: 0,
    carsPlaced: 0,
    poolGrows: 0,
    tilesAdopted: 0,
    drivenHidden: 0,
    drivenRestored: 0,
    modelsClaimed: 0,
    mountSweepsForced: 0,
    mountFramesModelled: 0,
    mountBoxesFlat: 0,
    boxesFolded: 0,
    boxesRestored: 0,
    mismatchRefused: 0,
    tilesEvicted: 0,
    instancesFreed: 0,
  };

  const root = new Object3D();
  const pool = new InstancePool(root);
  const assets = new CarAssets();

  // --- The 40 tiles, laid out as a ring is: side by side, tile-local metres
  // inside, a world origin per tile. Every claim is kept, because the eviction
  // half below is about giving back exactly these.
  const built: Array<{
    key: string;
    data: TileCars;
    sets: PooledSet[];
    claims: InstanceClaim[];
    originX: number;
    originZ: number;
  }> = [];
  for (let t = 0; t < TILES; t++) {
    const originX = (t % 8) * TILE_SIZE;
    const originZ = Math.floor(t / 8) * TILE_SIZE;
    const data = fakeTile(
      CARS_PER_TILE,
      t * 10_000 + 1,
      (i) => [((i * 37) % TILE_SIZE), ((i * 61) % TILE_SIZE)],
      (i) => BODY_MIX[i % BODY_MIX.length],
    );
    const sets = buildTileCars(data, assets, pool, originX, originZ, bumpyGround);
    pool.flush();
    counters.tilesBuilt++;
    counters.spansClaimed += sets.length;
    counters.carsPlaced += data.count;
    built.push({ key: `t_${t}`, data, sets, claims: sets.map((s) => s.claim), originX, originZ });
  }

  // The probe tile, out on its own. See `PROBE_CARS`.
  const probeData = fakeTile(
    PROBE_CARS,
    900_001,
    (i) => [i * PROBE_SPACING, 0],
    () => 0,
  );
  const probeSets = buildTileCars(probeData, assets, pool, PROBE_ORIGIN_X, PROBE_ORIGIN_Z, bumpyGround);
  pool.flush();
  counters.tilesBuilt++;
  counters.spansClaimed += probeSets.length;
  counters.carsPlaced += probeData.count;
  counters.poolGrows = pool.grows;

  // --- What the whole exercise is about: meshes did not grow with the session.
  if (pool.meshes > BODY_COUNT) {
    failures.push(
      `${counters.tilesBuilt} tiles left ${pool.meshes} pooled meshes against ${BODY_COUNT} body ` +
        'classes. Each one is a WGSL compile in the main pass and another in the shadow pass, ' +
        'and this is the growth `AsyncPipelines.drift()` was reporting.',
    );
  }
  // Four, not five: body 3 is in no tile, and a body nothing parks must claim
  // nothing rather than an empty span.
  if (pool.meshes !== 4) {
    failures.push(
      `The pool holds ${pool.meshes} meshes where the tiles between them use four body classes. ` +
        'A species with no instances should never have been made.',
    );
  }
  if (pool.instances !== counters.carsPlaced) {
    failures.push(
      `The pool holds ${pool.instances} instances against ${counters.carsPlaced} cars placed. ` +
        'A span longer than its bin is somebody else\'s car; shorter is a car that draws nowhere.',
    );
  }
  if (pool.refused !== 0) {
    failures.push(`The pool refused ${pool.refused} claim(s) building ${counters.tilesBuilt} tiles.`);
  }

  // --- The carlod half. One model in body 0's pool, no file, no fetch.
  const fleet = new CarModelFleet(createCarPose());
  fleet.addModel(
    { file: 'check_probe.glb', body: 0, tris: 0, lengthM: 4.5, tint: 'multiply', license: '', attribution: '' },
    // Its own empty geometry, **never a shared one**: `CarModelFleet.dispose`
    // frees the geometry of every mesh it made, and handing it `assets
    // .geometry(0)` would delete the sedan body out from under the pool.
    { map: null, geometry: new BufferGeometry(), box: { length: 4.5, width: 1.8, height: 1.5 }, seat: 0, triangles: 0 },
    0,
  );
  for (const tile of built) {
    fleet.adopt(tile.key, tile.data, tile.sets, tile.originX, tile.originZ);
    counters.tilesAdopted++;
  }
  fleet.adopt('probe', probeData, probeSets, PROBE_ORIGIN_X, PROBE_ORIGIN_Z);
  counters.tilesAdopted++;
  if (fleet.parkedTiles.tiles !== counters.tilesAdopted) {
    failures.push(
      `\`carlod\` holds ${fleet.parkedTiles.tiles} of ${counters.tilesAdopted} tiles it was handed. ` +
        'A tile refused here is a street where every car stays a box and `E` does nothing.',
    );
  }

  const before = snapshot(pool, probeSets);
  const field = new TrafficField();
  // Far from every tile, so nothing is claimed by proximity and the only thing
  // moving an instance is the pass under test.
  const FAR_X = -400_000;
  const FAR_Z = 400_000;

  // --- WORKSTREAM S's half: a car somebody is driving has its box folded flat
  // by identity rather than by distance, which is the other consumer of the
  // pool's read-and-restore pair. Run first, and undone, so the model half
  // below starts from the untouched buffer.
  const stolen = probeData.identity[3];
  fleet.drivenIdentities = (visit) => { visit(stolen); };
  fleet.sweep(field, 0, FAR_X, FAR_Z);
  {
    const hidden = diff(snapshot(pool, probeSets), before);
    counters.drivenHidden = hidden.flat;
    if (hidden.changed !== 1 || hidden.flat !== 1) {
      failures.push(
        `Driving one car folded ${hidden.changed} instance(s) flat, ${hidden.flat} of them ` +
          'degenerate; it must be exactly one. Two of your car -- one of them furniture -- is ' +
          'the failure `syncSuppressedStatics` exists to remove.',
      );
    }
  }
  fleet.drivenIdentities = () => {};
  fleet.sweep(field, 1, FAR_X, FAR_Z);
  {
    const back = diff(snapshot(pool, probeSets), before);
    counters.drivenRestored = back.changed === 0 ? 1 : 0;
    if (back.changed !== 0) {
      failures.push(
        `A car that came home left ${back.changed} instance(s) different from the matrix it was ` +
          'parked with. The height, heading, grade pitch and size jitter exist nowhere else, so ' +
          'anything but bit-for-bit is a different car in that bay.',
      );
    }
  }

  // --- And the model claim, which is the same pair reached by distance.
  const nearX = PROBE_ORIGIN_X + (PROBE_CARS / 2) * PROBE_SPACING;
  const nearZ = PROBE_ORIGIN_Z;
  fleet.sweep(field, 2, nearX, nearZ);
  counters.modelsClaimed = fleet.claimedCount;
  if (fleet.claimedCount === 0) {
    failures.push(
      `A sweep standing among ${PROBE_CARS} parked cars inside ${CLAIM_RADIUS} m claimed none of ` +
        'them. Either the tile was never adopted or its spans hold no instance this file can find.',
    );
  }
  if (fleet.overflows !== 0) {
    failures.push(
      `${fleet.overflows} claim(s) overflowed the one model in the pool; the probe tile is sized ` +
        'not to, so this is a real capacity fault rather than the check crowding itself.',
    );
  }
  {
    const folded = diff(snapshot(pool, probeSets), before);
    counters.boxesFolded = folded.flat;
    if (folded.changed !== fleet.claimedCount || folded.flat !== fleet.claimedCount) {
      failures.push(
        `${fleet.claimedCount} car(s) became models and ${folded.changed} instance(s) changed, ` +
          `${folded.flat} of them degenerate. A claimed car drawn as both a model and a box is ` +
          'the LOD swap failing in the most visible possible way.',
      );
    }
  }

  // Away, and every box comes back. `sweep` revokes on the outer radius, which
  // is the path an eviction must never take -- see the tile release below.
  fleet.sweep(field, 3, FAR_X, FAR_Z);
  {
    const back = diff(snapshot(pool, probeSets), before);
    counters.boxesRestored = counters.boxesFolded - back.changed;
    if (back.changed !== 0) {
      failures.push(
        `Releasing the models left ${back.changed} instance(s) unrestored or restored wrongly. ` +
          'A read through `getMatrixAt` written back through `setMatrixAt` would add the tile ' +
          'origin twice and land here, one tile east of the bay.',
      );
    }
    if (fleet.claimedCount !== 0) {
      failures.push(`${fleet.claimedCount} claim(s) survived a sweep 400 km from every car.`);
    }
  }

  /*
   * --- THE MOUNT, FRAME BY FRAME. The jitter, as a number.
   *
   * The owner: *"theres a little weird jitter geting into vehicles atm"*. The
   * mechanism is entirely in the seam this file already owns and is invisible
   * to every other check, because it is not a wrong matrix -- every matrix here
   * is right -- it is a matter of *when*.
   *
   * A parked car inside `CLAIM_RADIUS` holds a **parked** claim: its box is
   * folded flat and a model stands in the bay. Get into it and `claimed()`
   * refuses the driven pose, because the claim it finds is a parked one and a
   * parked claim is written once and never re-posed. So `TrafficMovers` draws
   * the car you are sitting in as a *box*, at your body, while the *model* of
   * the same car is still standing where you took it from -- and nothing
   * reconciles that until the next `sweep`, which is at `SWEEP_HZ` = 5. Up to
   * 11 frames at 60 Hz, 28 at 144, of two coincident cars pulling apart at up
   * to 8 m/s, ending in the model teleporting onto the bonnet.
   *
   * The fix is `CarModelFleet.drivenSetChanged`, asked once a frame by the frame
   * loop and forcing the sweep on the frame the answer moves. What this drives
   * is exactly that loop, at 60 Hz, over a take -- and what it asserts is the
   * property a player sees: **zero frames** in which the car being driven is
   * not the model.
   */
  {
    // Stand among the probe cars again and let them claim.
    fleet.sweep(field, 4, nearX, nearZ);
    const mounted = probeData.identity[1];
    let driving = false;
    let driverX = PROBE_ORIGIN_X + probeData.x[1];
    const driverZ = PROBE_ORIGIN_Z + probeData.z[1];
    fleet.drivenIdentities = (visit) => { if (driving) visit(mounted); };
    const driven = createCarPose();
    driven.identity = mounted;
    driven.body = probeData.body[1];
    driven.colour = probeData.colour[1];
    driven.dx = 1;
    driven.dz = 0;
    fleet.drivenClaims = (visit) => {
      if (!driving) return;
      driven.x = driverX;
      driven.z = driverZ;
      visit(driven);
    };

    let framesAsBox = 0;
    let forced = 0;
    let sweepClock = 0;
    // 60 Hz for a fifth of a second: one whole `SWEEP_HZ` period, which is the
    // window the artefact used to fill. The take lands on frame 1, immediately
    // *after* a scheduled sweep, which is the worst case -- the longest wait
    // for the next one.
    for (let frame = 0; frame < 12; frame++) {
      const now = frame * (1000 / 60);
      if (frame === 1) {
        driving = true;
        driverX += 0.5;
      }
      // main.ts's own gate, in its own order: the change test first so the hash
      // it compares against is never stale.
      const changed = fleet.drivenSetChanged();
      if (changed || now - sweepClock >= 1000 / 5) {
        if (changed && frame > 0) forced++;
        sweepClock = now;
        fleet.sweep(field, 5 + frame, nearX, nearZ);
      }
      fleet.begin();
      if (driving) {
        driven.x = driverX;
        driven.z = driverZ;
        // `TrafficMovers` asks exactly this, and a false answer is the frame it
        // draws the box instead.
        if (!fleet.claimed(driven)) framesAsBox++;
        driverX += 8 / 60;
      }
      fleet.end();
    }
    counters.mountSweepsForced = forced;
    counters.mountFramesModelled = 11 - framesAsBox;
    if (framesAsBox !== 0) {
      failures.push(
        `A car was drawn as a box for ${framesAsBox} frame(s) after being got into, with its own ` +
          'model still standing in the bay it was taken from. That is the mount jitter: the ' +
          '`sweep` at 5 Hz is what swaps a parked claim for a driven one, and without ' +
          '`drivenSetChanged` forcing it the wait is up to 11 frames at 60 Hz.',
      );
    }
    if (forced !== 1) {
      failures.push(
        `Taking one car forced ${forced} sweep(s) over 12 frames; it must force exactly one. ` +
          'None is the jitter back; more than one is a 0.5 ms sweep running every frame because ' +
          'the driven hash is not stable while nothing changes.',
      );
    }
    // And the box of the car being driven is flat, on the frame it was taken.
    {
      const held = diff(snapshot(pool, probeSets), before);
      // Every claimed car's box is flat -- the ones claimed by distance and the
      // one claimed by being driven -- so this counts rather than identifies.
      counters.mountBoxesFlat = held.flat;
      if (held.flat === 0) {
        failures.push('Nothing was folded flat across the mount, so the parked boxes are still drawing.');
      }
    }
    driving = false;
    fleet.drivenIdentities = () => {};
    fleet.drivenClaims = () => {};
    fleet.sweep(field, 40, FAR_X, FAR_Z);
    {
      const back = diff(snapshot(pool, probeSets), before);
      if (back.changed !== 0) {
        failures.push(
          `Getting out and walking away left ${back.changed} instance(s) different from the matrix ` +
            'the car was parked with. A mount must be exactly reversible or the bay keeps the dent.',
        );
      }
    }
  }

  // --- The capacity check: a tile whose spans disagree with its sidecar is
  // refused whole. Built by handing `adopt` the probe's spans with a sidecar
  // that says there are more cars in them than there are.
  {
    const lying = fakeTile(PROBE_CARS + 2, 950_001, (i) => [i * PROBE_SPACING, 0], () => 0);
    const held = fleet.parkedTiles.tiles;
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      fleet.adopt('liar', lying, probeSets, PROBE_ORIGIN_X, PROBE_ORIGIN_Z);
    } finally {
      console.warn = warn;
    }
    counters.mismatchRefused = warned;
    if (warned === 0 || fleet.parkedTiles.tiles !== held) {
      failures.push(
        'A tile whose sidecar has more cars than its spans hold was adopted rather than refused. ' +
          'Every instance index past the span belongs to another tile, so this file would fold ' +
          'a car flat in a suburb nobody is standing in.',
      );
    }
  }

  // --- Eviction, in the streamer's own order: the sink lets go of its
  // references *first*, and only then do the spans go back to the pool. The
  // other order is not a crash -- it is this tile's hatchback restored into
  // whatever tile the allocator hands those instances to next, at this tile's
  // height, staying there.
  const meshesBefore = pool.meshes;
  const instancesBefore = pool.instances;
  let evictedCars = 0;
  for (let t = 0; t < 20; t++) {
    const tile = built[t];
    fleet.release(tile.key);
    for (const claim of tile.claims) pool.release(claim);
    evictedCars += tile.data.count;
    counters.tilesEvicted++;
  }
  counters.instancesFreed = instancesBefore - pool.instances;
  if (counters.instancesFreed !== evictedCars) {
    failures.push(
      `Evicting ${counters.tilesEvicted} tiles gave back ${counters.instancesFreed} instances ` +
        `against the ${evictedCars} cars they brought. Fewer is a range leaked for the session; ` +
        'more is another tile\'s cars handed to the allocator while they are still drawing.',
    );
  }
  if (pool.meshes !== meshesBefore) {
    failures.push(
      `The pool went from ${meshesBefore} meshes to ${pool.meshes} across an eviction. Meshes are ` +
        'the city\'s and outlive every tile; a mesh count that moves on eviction moves on arrival too.',
    );
  }
  if (fleet.parkedTiles.tiles !== counters.tilesAdopted - counters.tilesEvicted) {
    failures.push(
      `\`carlod\` holds ${fleet.parkedTiles.tiles} tiles after ${counters.tilesEvicted} evictions ` +
        `of ${counters.tilesAdopted}. A tile it keeps is a set of references into spans the pool ` +
        'has already given away.',
    );
  }

  // --- And the rule this repo learned the hard way: a branch that never ran is
  // a branch that was never tested, and `0 grows` is how the last pooling bug
  // shipped. Every counter above is asserted rather than printed.
  for (const [name, n] of Object.entries(counters)) {
    if (n === 0) {
      failures.push(
        `\`verifyParkedPool\` counter \`${name}\` is 0, so that branch never ran and the check ` +
          'below it proved nothing. Fix the check, not the counter.',
      );
    }
  }

  fleet.dispose();
  return failures;
}
