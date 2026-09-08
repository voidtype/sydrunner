/**
 * Walking into a car, through the real `Simulation` on the shipped bake. PERMANENT.
 *
 *     bun run server/footcar-check.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * `server/carcoverage-check.ts` rams every population of car in the game with
 * another car and prints a row each, and its report ends with the hole this file
 * is the other half of: *"On foot, everything. The static fleet is not in the
 * collision prisms and no pedestrian capsule is tested against it."* Cars were
 * solid to cars and to nobody's legs.
 *
 * `game/carsolids.verifyCarSolids` and `player/controller.verifyMovementBasis`
 * cover the rule and the geometry, and both run at boot in both processes. What
 * neither of them can reach is the thing that actually broke here: **whether the
 * fleets are wired to the world a real body is really stepped through.** The
 * feature is one `setCarSolids` call per process; a check that builds its own
 * `CollisionWorld` proves the push and proves nothing about the wiring, and the
 * bug it is written for -- 1.4 M cars nobody tests against -- is exactly a
 * wiring bug. So this drives the real `Simulation` over the shipped bake, over
 * a real kerb row read out of a real `.cars.bin`.
 *
 * ---------------------------------------------------------------------------
 * FOUR SECTIONS.
 *
 *   1. **A bot walks a straight line through a kerb row.** The same walk is run
 *      twice over the same world -- once with `setCarSolids(null)` and once with
 *      the fleet in -- and the two are compared. The "before" run is not
 *      decoration: it is what makes the number mean something. It counts the
 *      ticks the capsule centre spent *inside* a car box, which before this
 *      workstream was every tick of the walk, and it is the same census the
 *      "after" run makes. `max penetration <= 0.02 m` is the bar.
 *   2. **The cost.** Sixteen bodies walking in the CBD, timed with the fleet in
 *      and out, reported as milliseconds per tick against `PERFORMANCE.md`'s
 *      8 ms p99 budget. Sixteen because that is what the brief asked for and
 *      because a `Room` is capped well under it; the per-body figure is what
 *      scales.
 *   3. **Online.** A `Room` and a real `NetClient` over a loopback transport,
 *      on `server/take-check.ts` section 5's harness exactly: the client
 *      predicts a walk into a car, the server authorises the same walk, and
 *      what is measured is `NetClient.lastCorrection` -- the distance between
 *      the two answers. A standoff the two ends disagreed about would show up
 *      here as a correction of about a car's width, and a snap.
 *   4. **The take still reaches.** A body walked up to a car and then asked
 *      `resolveTake` for it, because the one thing this feature could plausibly
 *      break is the button: a player who can no longer stand close enough to
 *      press `E` is a worse bug than a player who can walk through a Camry.
 *
 * ---------------------------------------------------------------------------
 * WHAT SECTION 3 DOES AND DOES NOT PROVE.
 *
 * The client and the server share one `ServerWorld` here, which means they share
 * one `CollisionWorld` and therefore one `CarSolidField`. That is
 * `take-check.runOnline`'s arrangement and it is stated for the same reason: it
 * proves the **wire** -- that the reconciler's replay, the authority's step and
 * the standoff agree end to end and produce no snap -- and it does *not* prove
 * that two independently fed fleets agree. That second question is
 * `verifyCarSolids`' determinism case, which walks two fields built from the
 * same bytes in different adoption orders for two hundred ticks and asserts they
 * do not part company by a bit.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import { Room, newConn, receiveInput, type Conn, type Socket } from './room.ts';
import { groundFor, loadWorld } from './world.ts';
import { EYE_HEIGHT, PLAYER_RADIUS } from '../client/src/player/controller.ts';
import { NetClient } from '../client/src/net/client.ts';
import { advance, createCombatant, type CombatInput } from '../client/src/game/combat.ts';
import { MSG, TICK_HZ, frameType, type NetTransport } from '../client/src/net/protocol.ts';
import { CAR_BODY_SIZE, trafficTick } from '../client/src/game/traffic.ts';
import { createStaticCarPose, type StaticCarPose } from '../client/src/game/staticcars.ts';
import { createDrivingScratch, resolveTake, TAKE_RADIUS } from '../client/src/game/driving.ts';

const failures: string[] = [];
const say = (s: string): void => { console.log(s); };
const fail = (s: string): void => { failures.push(s); };

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const world = await loadWorld(root);
const ground = groundFor(world);

say(`--- footcar-check: ${world.traffic.tileCount} lane tiles, spawn ${world.spawn.x.toFixed(0)}, ${world.spawn.z.toFixed(0)}`);
const statics = world.staticCars ?? null;
if (statics === null || statics.carCount === 0) {
  fail(
    'The server holds no parked cars, so every section below is vacuous. Either the bake has no ' +
      '`tiles/*.cars.bin` or the residency\'s third layer is not loading them.',
  );
}
say(`  the parked residency: ${statics?.tileCount ?? 0} tile(s), ${(statics?.carCount ?? 0).toLocaleString()} cars`);

/** One parked car, copied out of the field's reused pose. */
interface Kerb {
  identity: number;
  body: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Is (x, z) inside this car's footprint? `collision.carContains`, restated. */
function inside(car: Kerb, x: number, z: number): boolean {
  const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
  const dx = -Math.sin(car.yaw);
  const dz = -Math.cos(car.yaw);
  const rx = x - car.x;
  const rz = z - car.z;
  const along = rx * dx + rz * dz;
  const across = rx * dz - rz * dx;
  return Math.abs(along) <= size.length * 0.5 && Math.abs(across) <= size.width * 0.5;
}

/**
 * How far a capsule at (x, z) has penetrated this car, metres. 0 when clear.
 *
 * The **surface** distance, so a body correctly standing against a flank reads
 * zero rather than reading its own radius: it is `radius` minus the distance
 * from the centre to the box, floored at nought, which is exactly the quantity
 * `collision.carPenetration` ranks its pushes by.
 */
function penetration(car: Kerb, x: number, z: number): number {
  const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
  const dx = -Math.sin(car.yaw);
  const dz = -Math.cos(car.yaw);
  const rx = x - car.x;
  const rz = z - car.z;
  const along = rx * dx + rz * dz;
  const across = rx * dz - rz * dx;
  const hl = size.length * 0.5;
  const hw = size.width * 0.5;
  const overL = Math.abs(along) > hl ? Math.abs(along) - hl : 0;
  const overW = Math.abs(across) > hw ? Math.abs(across) - hw : 0;
  if (overL === 0 && overW === 0) return PLAYER_RADIUS + Math.min(hl - Math.abs(along), hw - Math.abs(across));
  const d = Math.hypot(overL, overW);
  return d >= PLAYER_RADIUS ? 0 : PLAYER_RADIUS - d;
}

// ---------------------------------------------------------------------------
// Finding a kerb row: a straight line through as many parked cars as possible.
// ---------------------------------------------------------------------------

/**
 * The densest parked cluster near the spawn, and a line through it.
 *
 * A run rather than a single car, because the reported failure is a *street*
 * you walk through and one car proves one push. The line is chosen by taking
 * the nearest car to the census centre and walking along its own heading, which
 * is how a kerb row is laid out: `parking.py` puts every bay on the carriageway
 * edge with the car's nose along the road, so "along the heading of any car in
 * the row" is "down the row".
 */
function findRow(cx: number, cz: number): { cars: Kerb[]; fromX: number; fromZ: number; toX: number; toZ: number } | null {
  if (statics === null) return null;
  const pose: StaticCarPose = createStaticCarPose();
  const near: Kerb[] = [];
  const feet = ground.groundHeight(cx, cz, 0);
  // 600 m, not the 120 the first draft used: the shipped bake's spawn disc is a
  // park and the nearest `.cars.bin` car to it is 400 m away. A radius that
  // found nothing made this whole file vacuous, which is the failure the
  // `beforeClean` census below exists to convict.
  statics.forEachStaticNear(cx, feet, cz, 600, (car) => {
    near.push({ identity: car.identity, body: car.body, x: car.x, y: car.y, z: car.z, yaw: car.yaw });
  });
  if (near.length === 0) return null;
  void pose;

  // The best line: for each candidate car, walk its own heading and count how
  // many other cars in the cluster are within a capsule's width of that line.
  let best: { cars: Kerb[]; anchor: Kerb } | null = null;
  for (const anchor of near) {
    const dx = -Math.sin(anchor.yaw);
    const dz = -Math.cos(anchor.yaw);
    const on: Kerb[] = [];
    for (const other of near) {
      const rx = other.x - anchor.x;
      const rz = other.z - anchor.z;
      const along = rx * dx + rz * dz;
      const across = rx * dz - rz * dx;
      if (Math.abs(across) > 1.2) continue;
      if (Math.abs(along) > 60) continue;
      on.push(other);
    }
    if (best === null || on.length > best.cars.length) best = { cars: on, anchor };
  }
  if (best === null || best.cars.length === 0) return null;
  const dx = -Math.sin(best.anchor.yaw);
  const dz = -Math.cos(best.anchor.yaw);
  let lo = Infinity;
  let hi = -Infinity;
  for (const car of best.cars) {
    const along = (car.x - best.anchor.x) * dx + (car.z - best.anchor.z) * dz;
    lo = Math.min(lo, along);
    hi = Math.max(hi, along);
  }
  // --- And now the *line*, which is chosen by search rather than by taste.
  //
  // The first draft walked the row's own axis and it was the wrong test in a way
  // worth recording. A body walking dead along a line of cars parked nose to
  // tail meets the flat back of the first one square on, and a flat face square
  // on has no along-face component to slide along -- so the correct answer is
  // that it stops. It walked 5.4 m of a 95 m row and every assertion about being
  // deflected *around* the rest was untestable. The second draft crossed the row
  // at four degrees and threaded the gaps between the bays: zero interiors, and
  // the census below convicted it.
  //
  // So the line is searched for: a few angles to the row and a few lateral
  // offsets, each sampled every 20 cm against the car footprints, and the one
  // that passes through the most distinct cars wins. That is a few thousand
  // point-in-box tests once, and it makes this driver's fixture a property of
  // the bake rather than of a number somebody guessed. It is also the walk a
  // player actually makes: you cross a street on the diagonal and clip the
  // parked cars on the way.
  const pad = 8;
  const lx = dz;
  const lz = -dx;
  const span = hi - lo + pad * 2;
  let bestLine: { fromX: number; fromZ: number; toX: number; toZ: number; through: number } | null = null;
  for (const degrees of [3, 6, 10, 16, 24, -3, -6, -10, -16, -24]) {
    const a = (degrees * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const wx = dx * ca + lx * sa;
    const wz = dz * ca + lz * sa;
    for (let off = -8; off <= 8; off += 1) {
      const fx = best.anchor.x + dx * (lo - pad) + lx * off;
      const fz = best.anchor.z + dz * (lo - pad) + lz * off;
      const met = new Set<number>();
      for (let t = 0; t <= span; t += 0.2) {
        const px = fx + wx * t;
        const pz = fz + wz * t;
        for (const car of best.cars) if (inside(car, px, pz)) met.add(car.identity);
      }
      if (bestLine === null || met.size > bestLine.through) {
        bestLine = { fromX: fx, fromZ: fz, toX: fx + wx * span, toZ: fz + wz * span, through: met.size };
      }
    }
  }
  if (bestLine === null || bestLine.through < 2) return null;
  return { cars: best.cars, fromX: bestLine.fromX, fromZ: bestLine.fromZ, toX: bestLine.toX, toZ: bestLine.toZ };
}

// ---------------------------------------------------------------------------
// 1. A bot walks a straight line through a kerb row.
// ---------------------------------------------------------------------------

const sim = new Simulation(world);
const out: TickOutput = { tick: 0, events: [], snapshot: null };

/** The yaw that walks from `from` toward `to`. `controller.step`'s basis. */
function yawToward(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

interface WalkResult {
  ticks: number;
  /** Ticks on which the capsule centre was inside some car's footprint. */
  ticksInside: number;
  maxPenetration: number;
  /** Distinct cars the capsule came within a metre of. */
  encountered: number;
  travelled: number;
}

function walkRow(
  p: Participant,
  row: { cars: Kerb[]; fromX: number; fromZ: number; toX: number; toZ: number },
  ticks: number,
): WalkResult {
  const feet = ground.groundHeight(row.fromX, row.fromZ, 0);
  const yaw = yawToward(row.fromX, row.fromZ, row.toX, row.toZ);
  sim.placeAt(p, row.fromX, feet + EYE_HEIGHT, row.fromZ, yaw);
  p.combat.ridingBike = 0;
  p.combat.drivingCar = 0;
  p.input.forward = 1;
  p.input.right = 0;
  p.input.sprint = false;
  p.input.jump = false;
  p.input.yaw = yaw;

  const met = new Set<number>();
  let ticksInside = 0;
  let maxPenetration = 0;
  for (let i = 0; i < ticks; i++) {
    sim.step(out);
    const x = p.combat.body.position.x;
    const z = p.combat.body.position.z;
    let insideHere = false;
    for (const car of row.cars) {
      const dx = car.x - x;
      const dz = car.z - z;
      if (dx * dx + dz * dz > 16) continue;
      met.add(car.identity);
      if (inside(car, x, z)) insideHere = true;
      const pen = penetration(car, x, z);
      if (pen > maxPenetration) maxPenetration = pen;
    }
    if (insideHere) ticksInside++;
  }
  const travelled = Math.hypot(
    p.combat.body.position.x - row.fromX,
    p.combat.body.position.z - row.fromZ,
  );
  return { ticks, ticksInside, maxPenetration, encountered: met.size, travelled };
}

const row = findRow(world.spawn.x, world.spawn.z);
if (row === null) {
  fail('No parked cars within 120 m of the spawn, so there is no kerb row to walk through.');
} else {
  say(
    `\n1. a kerb row of ${row.cars.length} car(s), ` +
      `${Math.hypot(row.toX - row.fromX, row.toZ - row.fromZ).toFixed(0)} m end to end, ` +
      `from (${row.fromX.toFixed(0)}, ${row.fromZ.toFixed(0)}) to (${row.toX.toFixed(0)}, ${row.toZ.toFixed(0)})`,
  );
  const walker = sim.join(0, null, 'walker');
  const WALK_TICKS = Math.ceil((Math.hypot(row.toX - row.fromX, row.toZ - row.fromZ) / 4.4) * TICK_HZ) + 120;

  // Before: the world as it shipped, with the fleet taken out from under the
  // simulation. `setCarSolids(null)` is the same switch `verifyCarSolids` uses.
  world.collision.setCarSolids(null);
  const before = walkRow(walker, row, WALK_TICKS);
  // `sim.step` re-installs the field at the top of every tick (see
  // `Simulation.carSolids`), so the "before" run has to keep taking it out. It
  // cannot: what it measures instead is one tick of prisms and then the fleet
  // back. So the honest "before" is measured with the field's sources cleared,
  // which is the same world with no cars in it.
  const beforeCars = { statics: sim.carSolids.statics, traffic: sim.carSolids.traffic, driven: sim.carSolids.driven };
  sim.carSolids.statics = null;
  sim.carSolids.traffic = null;
  sim.carSolids.driven = null;
  const beforeClean = walkRow(walker, row, WALK_TICKS);
  sim.carSolids.statics = beforeCars.statics;
  sim.carSolids.traffic = beforeCars.traffic;
  sim.carSolids.driven = beforeCars.driven;

  const after = walkRow(walker, row, WALK_TICKS);
  say(`   cars encountered:      ${beforeClean.encountered} before -> ${after.encountered} after`);
  say(
    `   ticks inside a car:    ${beforeClean.ticksInside} before -> ${after.ticksInside} after ` +
      `(of ${WALK_TICKS})`,
  );
  say(
    `   max penetration:       ${beforeClean.maxPenetration.toFixed(3)} m before -> ` +
      `${after.maxPenetration.toFixed(3)} m after`,
  );
  say(`   distance walked:       ${beforeClean.travelled.toFixed(1)} m before -> ${after.travelled.toFixed(1)} m after`);
  void before;

  if (after.encountered === 0) {
    fail('The walk met no cars at all. Either the row is not where it was found or the body did not move.');
  }
  if (beforeClean.ticksInside === 0) {
    fail(
      'With the fleet taken out the walk never once passed through a car, so this row does not lie in the ' +
        'body\'s path and the "after" numbers below prove nothing. Pick a different row.',
    );
  }
  if (after.ticksInside !== 0) {
    fail(`The body spent ${after.ticksInside} tick(s) inside a parked car. On foot, cars are meant to be solid.`);
  }
  if (after.maxPenetration > 0.02) {
    fail(
      `The deepest the body got into a car was ${after.maxPenetration.toFixed(3)} m, over the 0.02 m bar. ` +
        'The push is landing short of the face.',
    );
  }
  // **Progress, as a fraction of the same walk with no cars in it.** The bar is
  // half, and half is generous on purpose: `controller.step` scales the whole
  // velocity by the fraction of the wanted move it achieved rather than
  // projecting it onto the face (see `verifyMovementBasis`), so grazing a flank
  // genuinely costs a body speed. What it must not do is *stop* it. A body that
  // travelled a tenth of the free walk is caught on a bumper, which is the
  // failure this whole feature could plausibly introduce and is worse than the
  // one it fixes.
  if (after.travelled < beforeClean.travelled * 0.5) {
    fail(
      `The body travelled ${after.travelled.toFixed(1)} m against ${beforeClean.travelled.toFixed(1)} m ` +
        'with the cars taken out. It is caught on a car rather than sliding round it -- a wall you ' +
        'cannot get past is not the fix.',
    );
  }

  // ---------------------------------------------------------------------------
  // 4. And `E` still reaches. Stand beside the nearest car in the row and ask
  //    the same `resolveTake` the button goes through.
  // ---------------------------------------------------------------------------
  {
    const target = row.cars[Math.floor(row.cars.length / 2)];
    const dx = -Math.sin(target.yaw);
    const dz = -Math.cos(target.yaw);
    // The driver's side, at exactly the standoff the box now imposes plus a
    // centimetre: left of the heading is `(dz, -dx)`.
    const size = CAR_BODY_SIZE[target.body] ?? CAR_BODY_SIZE[0];
    const stand = size.width * 0.5 + PLAYER_RADIUS + 0.01;
    const sx = target.x + dz * stand;
    const sz = target.z - dx * stand;
    const feet = ground.groundHeight(sx, sz, target.y);
    sim.placeAt(walker, sx, feet + EYE_HEIGHT, sz, target.yaw);
    p0: {
      const scratch = createDrivingScratch();
      const found = resolveTake(
        world.traffic,
        walker.combat.body.position.x,
        walker.combat.body.position.y - EYE_HEIGHT,
        walker.combat.body.position.z,
        trafficTick(Date.now()),
        scratch.routes,
        scratch.pose,
        (id: number) => sim.cars.suppressed(id),
        scratch.take,
        statics,
      );
      say(
        `\n4. the take, from the standoff the box imposes (${stand.toFixed(2)} m, ` +
          `against TAKE_RADIUS ${TAKE_RADIUS}): ${found ? 'a car' : 'nothing'}`,
      );
      if (!found) {
        fail(
          `A body standing at the closest point the new box allows (${stand.toFixed(2)} m from the car's ` +
            `centre) could not take it. \`E\` reaches ${TAKE_RADIUS} m; the standoff has to be inside it.`,
        );
        break p0;
      }
    }
  }
  sim.leave(walker.id);
  sim.step(out);
}

// ---------------------------------------------------------------------------
// 2. The cost: sixteen bodies walking in the CBD, with the fleet in and out.
// ---------------------------------------------------------------------------

/**
 * The most crowded parked street this process is holding, near the spawn.
 *
 * Searched rather than named, because a coordinate written down here is a
 * coordinate that means something else after the next retile. Every car within
 * two kilometres of the spawn is listed once, two hundred of them are taken as
 * candidate centres, and the one with the most neighbours inside 30 m wins --
 * which on any bake is a terrace street with cars down both sides, and is the
 * honest place to ask what sixteen bodies cost.
 */
function densestSpot(): { x: number; z: number; count: number } | null {
  if (statics === null) return null;
  const all: Array<{ x: number; z: number }> = [];
  const feet = ground.groundHeight(world.spawn.x, world.spawn.z, 0);
  statics.forEachStaticNear(world.spawn.x, feet, world.spawn.z, 2000, (car) => {
    all.push({ x: car.x, z: car.z });
  });
  if (all.length === 0) return null;
  const stride = Math.max(1, Math.floor(all.length / 200));
  let best: { x: number; z: number; count: number } | null = null;
  for (let i = 0; i < all.length; i += stride) {
    const c = all[i];
    let n = 0;
    for (const o of all) {
      const dx = o.x - c.x;
      const dz = o.z - c.z;
      if (dx * dx + dz * dz <= 900) n++;
    }
    if (best === null || n > best.count) best = { x: c.x, z: c.z, count: n };
  }
  return best;
}
{
  // **Where the sixteen stand decides what this measures**, and the first draft
  // got it wrong: it ringed them round the spawn, which on the shipped bake is a
  // park 400 m from the nearest parked car, so every query walked an empty cell
  // and the answer was the cost of asking rather than the cost of answering.
  // They stand on the kerb row instead -- the densest parked street this driver
  // could find -- and the census beside it is printed so the number can be read
  // as "sixteen bodies in a street with this many cars in reach".
  const dense = densestSpot();
  const centreX = dense === null ? (row === null ? world.spawn.x : (row.fromX + row.toX) / 2) : dense.x;
  const centreZ = dense === null ? (row === null ? world.spawn.z : (row.fromZ + row.toZ) / 2) : dense.z;
  let inReach = 0;
  statics?.forEachStaticNear(centreX, ground.groundHeight(centreX, centreZ, 0), centreZ, 30, () => { inReach++; });
  say(
    `\n2. cost: sixteen bodies walking at (${centreX.toFixed(0)}, ${centreZ.toFixed(0)}), ` +
      `${inReach} parked cars within 30 m`,
  );
  const crowd: Participant[] = [];
  for (let i = 0; i < 16; i++) {
    const p = sim.join(0, null, `w${i}`);
    const a = (i / 16) * Math.PI * 2;
    const x = centreX + Math.cos(a) * 12;
    const z = centreZ + Math.sin(a) * 12;
    sim.placeAt(p, x, ground.groundHeight(x, z, 0) + EYE_HEIGHT, z, a + Math.PI);
    p.input.forward = 1;
    p.input.yaw = a + Math.PI;
    crowd.push(p);
  }

  /**
   * Milliseconds a tick over `n` ticks: the mean as well as the percentiles.
   *
   * The mean is here because the percentiles could not resolve the answer. On
   * the first run with the crowd standing in a real street the p50 delta came
   * out at **-0.002 ms** -- the cars measured as free, and slightly negative,
   * which is a way of saying the difference is under the noise of a 0.12 ms
   * tick sampled six hundred times. A mean over two thousand ticks is the
   * cheapest thing that has the resolution, and it is reported beside the
   * percentiles rather than instead of them because the budget in
   * `PERFORMANCE.md` is written in p99.
   */
  const time = (n: number): { mean: number; p50: number; p99: number } => {
    const samples: number[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      sim.step(out);
      const dt = performance.now() - t0;
      total += dt;
      samples.push(dt);
    }
    samples.sort((a, b) => a - b);
    return { mean: total / n, p50: samples[Math.floor(n * 0.5)], p99: samples[Math.floor(n * 0.99)] };
  };

  const TICKS = 2000;
  time(60); // warm
  const on = time(TICKS);
  const held = { statics: sim.carSolids.statics, traffic: sim.carSolids.traffic, driven: sim.carSolids.driven };
  sim.carSolids.statics = null;
  sim.carSolids.traffic = null;
  sim.carSolids.driven = null;
  const off = time(TICKS);
  sim.carSolids.statics = held.statics;
  sim.carSolids.traffic = held.traffic;
  sim.carSolids.driven = held.driven;

  say(`   with the fleet:    mean ${on.mean.toFixed(4)} ms   p50 ${on.p50.toFixed(3)} ms   p99 ${on.p99.toFixed(3)} ms`);
  say(`   without:           mean ${off.mean.toFixed(4)} ms   p50 ${off.p50.toFixed(3)} ms   p99 ${off.p99.toFixed(3)} ms`);
  const delta = on.mean - off.mean;
  say(
    `   the cars cost:     ${delta.toFixed(3)} ms a tick at 16 bodies ` +
      `(${((delta / 16) * 1000).toFixed(1)} us a body), against PERFORMANCE.md's 8 ms p99 budget`,
  );
  if (on.p99 > 8) {
    fail(`The tick's p99 with sixteen bodies is ${on.p99.toFixed(2)} ms, over PERFORMANCE.md's 8 ms.`);
  }
  if (delta > 1) {
    fail(
      `Making cars solid costs ${delta.toFixed(2)} ms a tick at sixteen bodies. The budget for one fleet ` +
        'query per body per tick is well under a millisecond; something is querying more than once.',
    );
  }
  for (const p of crowd) sim.leave(p.id);
  sim.step(out);
}

// ---------------------------------------------------------------------------
// 3. Online: prediction against authority, through a Room and a real NetClient.
// ---------------------------------------------------------------------------

/** `take-check.HeldSocket`: a `Socket` that keeps every frame instead of sending it. */
class HeldSocket {
  readonly frames: ArrayBuffer[] = [];
  closed = '';
  constructor(readonly data: Conn) {}
  send(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.frames.push(bytes.slice().buffer as ArrayBuffer);
    return bytes.byteLength;
  }
  close(_code?: number, reason?: string): void { this.closed = reason ?? 'closed'; }
  readonly pings: Uint8Array[] = [];
  ping(data?: string | ArrayBuffer | Uint8Array): number {
    if (data === undefined || typeof data === 'string') return 0;
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pings.push(b.slice());
    return b.byteLength;
  }
}

if (row !== null) {
  const roomRow = row;
  const combatWorld = groundFor(world);
  const room = new Room(0, world, 8, 0);
  const FIXED_DT = 1 / TICK_HZ;

  let socket: HeldSocket | null = null;
  let participant: Participant | null = null;
  const toServer: ArrayBuffer[] = [];
  const transport: NetTransport = {
    open: true, onframe: null, onopen: null, onclose: null,
    send(f: ArrayBuffer): void { toServer.push(f); },
    close(): void {},
  };
  const net = new NetClient('', {
    onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
    onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
  }, { name: 'walker', transport });
  transport.onopen?.();

  const pump = (): void => {
    for (const f of toServer.splice(0)) {
      if (frameType(f) === MSG.HELLO && participant === null) {
        socket = new HeldSocket(newConn(0));
        participant = room.join(socket.data, 0, 'walker');
        if (participant !== null) {
          room.conns.add(socket as unknown as Socket);
          room.welcome(socket as unknown as Socket, participant);
        }
      } else if (frameType(f) === MSG.INPUT && socket !== null) {
        receiveInput(socket.data, f);
      }
    }
  };
  const drain = (): void => {
    if (socket === null) return;
    for (const f of socket.frames.splice(0)) transport.onframe?.(f);
  };

  const local = createCombatant(0, world.spawn.x, world.spawn.z);
  const correction = local.body.velocity.clone();
  const yaw = yawToward(roomRow.fromX, roomRow.fromZ, roomRow.toX, roomRow.toZ);
  const input: CombatInput = {
    forward: 0, right: 0, jump: false, sprint: false,
    yaw, pitch: 0, punch: false, throwBall: false, mount: false,
  };
  const clientTick = (): void => {
    net.reconcile(local, combatWorld, correction);
    advance(local, input, FIXED_DT, combatWorld);
    net.sendInput(input, local.body.velocity);
  };
  const roomTick = (): void => {
    pump();
    room.step();
    drain();
  };

  clientTick();
  roomTick();
  if (participant === null) {
    fail('Online: the loopback client could not join the room.');
  } else {
    const p: Participant = participant;
    const feet = ground.groundHeight(roomRow.fromX, roomRow.fromZ, 0);
    room.sim.placeAt(p, roomRow.fromX, feet + EYE_HEIGHT, roomRow.fromZ, yaw);
    for (let i = 0; i < 30; i++) { clientTick(); roomTick(); }

    input.forward = 1;
    let worstCorrection = 0;
    let worstDrift = 0;
    const snapsBefore = net.snaps;
    const ticks = Math.ceil((Math.hypot(roomRow.toX - roomRow.fromX, roomRow.toZ - roomRow.fromZ) / 4.4) * TICK_HZ);
    for (let i = 0; i < ticks; i++) {
      clientTick();
      roomTick();
      worstCorrection = Math.max(worstCorrection, net.lastCorrection);
      worstDrift = Math.max(worstDrift, Math.hypot(
        local.body.position.x - p.combat.body.position.x,
        local.body.position.z - p.combat.body.position.z,
      ));
    }
    say('\n3. online: the same walk, predicted and authorised');
    say(`   worst reconciliation correction: ${worstCorrection.toFixed(4)} m over ${ticks} ticks`);
    say(`   worst client/server drift:       ${worstDrift.toFixed(4)} m`);
    say(`   snaps:                           ${net.snaps - snapsBefore}`);
    if (net.snaps - snapsBefore !== 0) {
      fail(
        `The reconciler snapped ${net.snaps - snapsBefore} time(s) walking a kerb row. The two ends ` +
          'disagree about where a car is.',
      );
    }
    if (worstDrift > 0.5) {
      fail(
        `Prediction and authority drifted ${worstDrift.toFixed(2)} m apart walking a kerb row. A standoff ` +
          'one end applies and the other does not is exactly this shape.',
      );
    }
  }
}

if (failures.length === 0) {
  say('\nfootcar-check: OK');
  process.exit(0);
}
say(`\nfootcar-check: ${failures.length} failure(s)`);
for (const f of failures) say(`  - ${f}`);
process.exit(1);
