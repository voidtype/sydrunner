/**
 * The acceptance run: two real WebSocket clients against a real server process.
 *
 *     bun run server/index.ts &
 *     bun run server/ride-acceptance.ts          # RIDE_S=230 for two stops
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHY IT IS NOT THE CHECK.
 *
 * `integration-check.checkRidingOnline` is the check. It runs in a second, it
 * asserts, it goes red, and it belongs in the gate. What it does *not* have is
 * an operating system: its room is in the same process, its socket is a class
 * with an array in it, and its clock is a variable. Everything real about a
 * deployment that is not the protocol -- the WebSocket framing, the scheduler,
 * two processes disagreeing about the millisecond -- is out of its scope.
 *
 * This is the other half, and it is the half the rolled-back round never ran:
 * a separately-launched `server/index.ts`, two OS sockets, the real wall clock,
 * and a real ninety-second wait for a real dwell. It prints rather than
 * asserts, because the numbers worth reading here are the ones you have to
 * interpret -- see the along/across split on the position gap, which is the
 * difference between "the snapshot I am holding is 168 ms old" and "the two
 * ends disagree about where in the carriage I am".
 *
 * ---------------------------------------------------------------------------
 * It drives the SAME seam the browser does -- `riding.boardHere` and
 * `riding.rideEnter` -- and it asks the SERVER to place it, through
 * `/platform`. There is no client-side teleport anywhere in it, because the
 * previous harness had one and that is precisely why the feature shipped
 * broken.
 *
 * ---------------------------------------------------------------------------
 * SECTION 0 IS OFFLINE, AND ON PURPOSE.
 *
 * The gangway case below the imports runs **before anything opens a socket**,
 * against the shipped bake and nothing else, and `RIDE_GANGWAY=only` runs it and
 * exits. That is not a shortcut around the networked half; it is what the case
 * actually needs. Walking the length of a Metropolis between stations requires a
 * Metro that is *moving*, and the online harness is built round waiting ninety
 * seconds for a train to *stop* -- so the two want opposite halves of the same
 * timetable, and solving for a moving train is a division rather than a wait.
 * What it drives is the real seam either way: `rideEnter`, `combat.advance`,
 * `rideExit`, tick by tick, which is the same three calls `sim.step` makes.
 */
import { NetClient } from '../client/src/net/client.ts';
import {
  ABOARD_STEP_M, TICK_HZ, createSnapshot, decodeSnapshot, encodeSnapshot,
  quantiseAcross, quantiseAlong, quantiseRise,
  type SnapshotAboard,
} from '../client/src/net/protocol.ts';
import { advance, createCombatant } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { createTrainPose, decodeRail, poseTrain, railSeconds } from '../client/src/game/rail.ts';
import {
  RIDE_ON, aboardFrame, aboardPose, boardHere, clearAboard, consistOf, consistOffset,
  createBoardOffer, createCarFrame, createCarriageStand, carSign, dirOf, findBoarding,
  interiorOfCar, isAboard,
  nextDwell, projectAboard, rideEnter, rideExit, verifyGangway, worldToLocal,
} from '../client/src/game/riding.ts';
import type { CombatWorld } from '../client/src/game/combat.ts';

const URL_ = process.env.SYDNEY_SERVER ?? 'ws://localhost:8788';
const FROM = process.env.SYDNEY_RIDE_FROM ?? 'St Peters';
const FIXED_DT = 1 / TICK_HZ;

const bake = decodeRail(await Bun.file('./client/public/rail/rail.bin').arrayBuffer());

/** Scratch pose for section 0's solve. `game/rail.ts` never allocates one either. */
const posePad = createTrainPose();

const say = (s: string): void => { console.log(s); };

// --- 0. The gangway: walking a Metropolis end to end while it is moving.
//
// See the header for why this is offline and why it is first. `RIDE_GANGWAY=off`
// skips it, `RIDE_GANGWAY=only` runs it and stops.
if ((process.env.RIDE_GANGWAY ?? 'on') !== 'off') {
  say('--- 0. walking between Metro carriages, between stations ---');
  const failures = verifyGangway();
  say(`riding.verifyGangway: ${failures.length === 0 ? 'clean' : `${failures.length} failure(s)`}`);
  for (const f of failures) say(`  ! ${f}`);

  // A real Metro trip on the real bake, at an instant it is **moving**. Solved
  // rather than polled, on `nextDwell`'s own argument: a Metro's doors are open
  // for fifteen seconds in every couple of minutes, so stepping the clock a
  // second at a time from now until `poseTrain` says the train is running with
  // its doors shut and real speed under it is one short loop and no waiting.
  const FIXED = 1 / TICK_HZ;
  let found: { li: number; di: number; trip: number; t: number } | null = null;
  const now = railSeconds(Date.now());
  outer: for (let li = 0; li < bake.lines.length && found === null; li++) {
    const line = bake.lines[li];
    if (!line.metro) continue;
    for (const dir of line.dirs) {
      const live = Math.floor(dir.duration / line.period) + 2;
      for (let j = 0; j <= live; j++) {
        const trip = Math.floor((now - dir.offset) / line.period) - j;
        for (let dt = 0; dt < 240; dt += 1) {
          const t = now + dt;
          if (!poseTrain(bake, dir, trip, t, posePad)) continue;
          // Moving, doors shut, and far enough into the run that a 132 m consist
          // is entirely on the line -- `consistOffset` clamps a carriage whose
          // centre is behind the start and a clamped carriage is not a carriage
          // anybody can walk into.
          if (posePad.doorsOpen || posePad.speed < 20 || posePad.s < 200) continue;
          // And it has to stay between stations for the whole walk. A rider
          // covers 4.4 m/s and a six-car Metropolis is 132 m, so the walk is
          // thirty seconds; sampled rather than swept because `doorsOpen` is a
          // fifteen-second phase and four probes ten seconds apart cannot miss
          // one. A train that pulls in halfway through is not a wrong answer, it
          // is a weaker one -- the request was for a walk on a moving train.
          let stays = true;
          for (let ahead = 10; ahead <= 40 && stays; ahead += 10) {
            stays = poseTrain(bake, dir, trip, t + ahead, posePad) && !posePad.doorsOpen;
          }
          if (!stays) continue;
          found = { li, di: dir.index, trip, t };
          break outer;
        }
      }
    }
  }

  if (found === null) {
    say('  ! no Metro service in the bake is between stations in the next four minutes');
  } else {
    const dir = dirOf(bake, found.li, found.di)!;
    const consist = consistOf(dir, found.trip);
    const n = consist.cars.length;
    const combat = createCombatant(0, 0, 0);
    const a = combat.aboard;
    const frame = createCarFrame();
    const stand = createCarriageStand();
    const it0 = interiorOfCar(consist, n - 1)!;
    a.line = found.li;
    a.dir = found.di;
    a.trip = found.trip;
    // The rear driving car, standing at its cab end, facing down the train. A
    // local yaw of pi/2 is a forward of (-1, 0) in the carriage's own plan --
    // `controller.step`'s `(-sin yaw, -cos yaw)` -- so "hold W" walks -X.
    a.car = n - 1;
    a.x = it0.xMax - 1;
    a.y = it0.vestibuleY + EYE_HEIGHT;
    a.z = 0;
    a.yaw = Math.PI / 2;
    if (!aboardFrame(bake, a, found.t, frame)) throw new Error('the trip vanished');
    projectAboard(a, combat.body, frame);
    combat.body.onGround = true;

    // --- `Opal Hop`, tested on the one thing in the bake that is hard to
    // stage: a train that is moving.
    //
    // The section already had to find a service between stations with its doors
    // shut, which is exactly the fixture this node is about, so the assertions
    // cost one `findBoarding` each and no server at all.
    //
    // The probe is placed by `projectAboard` rather than by a hand-rolled
    // rotation, and that is not fussiness: `findBoarding` locates a door with
    // `worldToLocal`, and a world position built by a second, independently
    // written transform tests my arithmetic instead of the rule. Placed *at* a
    // door bay too -- `doorBayAt` refuses any x more than 0.35 m off one, for
    // everybody and every talent.
    {
      const probe = createBoardOffer();
      const beside = createCombatant(0, 0, 0);
      const it = interiorOfCar(consist, a.car)!;
      const at = (lateral: number): void => {
        const spot = { ...a, x: it.doors[0].x, y: it.vestibuleY + EYE_HEIGHT, z: it.halfWidth + lateral };
        projectAboard(spot, beside.body, frame);
      };
      const ask = (moving: boolean): boolean =>
        findBoarding(
          bake, beside.body.position.x, beside.body.position.y - EYE_HEIGHT, beside.body.position.z,
          found.t, probe, { moving },
        );

      at(1.5);
      const without = ask(false);
      const with_ = ask(true);
      say(`  Opal Hop: 1.5 m off a moving door -- without the node ${without ? 'BOARDED' : 'refused'}, with it ${with_ ? 'boarded' : 'REFUSED'}`);
      if (without) say('  ! FAILED: a moving train was boardable without Opal Hop; the doors-open gate is gone for everybody');
      if (!with_) say('  ! FAILED: Opal Hop did not open the moving door it is sold as');

      // And the extra metre is bounded rather than a free pass.
      at(6);
      const tooFar = ask(true);
      say(`  Opal Hop: six metres off the side -- ${tooFar ? 'BOARDED (FAILED: the reach is unbounded)' : 'refused, as the 4 m reach says'}`);
    }

    const input = {
      forward: 1, right: 0, jump: false, sprint: false,
      yaw: a.yaw, pitch: 0, speedScale: 1, jumpScale: 1,
      punch: false, throwBall: false, mount: false,
    };
    const snap = createSnapshot();
    const wire: SnapshotAboard[] = [{
      id: 1, line: 0, dir: 0, tripLow: 0, car: 0, x: 0, y: 0, z: 0,
    }];

    let ticks = 0;
    let crossings = 0;
    let lastCar = a.car;
    let lastArc = -Infinity;
    let arcBackwards = 0;
    let offConsist = 0;
    let skipped = 0;
    let wireBad = 0;
    let wireCarBad = 0;
    let minSpeed = Infinity;
    let ended = '';
    const startArc = (() => {
      const p = aboardPose(bake, a, found.t)!;
      return consistOffset(p.s, a.car, n, consist.pitch) + carSign(consist, a.car) * a.x - p.s;
    })();
    let endArc = startArc;

    // 4.4 m/s over 132 m of train, with room for the two cab ends and a margin.
    for (; ticks < 2600; ticks++) {
      const t = found.t + ticks * FIXED;
      const got = rideEnter(bake, a, combat.body, t, frame, stand);
      if (got !== RIDE_ON) { ended = `rideEnter said ${got}`; break; }
      advance(combat, input, FIXED, stand as unknown as CombatWorld);
      input.yaw += rideExit(bake, a, combat.body, t, frame);

      const pose = aboardPose(bake, a, t);
      if (pose === null) { ended = 'the trip stopped running'; break; }
      if (pose.speed < minSpeed) minSpeed = pose.speed;

      // (a) never off the end of the consist, and one coupling at a time.
      if (a.car < 0 || a.car >= n) { offConsist++; break; }
      if (a.car !== lastCar) {
        crossings++;
        if (Math.abs(a.car - lastCar) !== 1) skipped++;
        lastCar = a.car;
      }
      // (b) the carriage index and the position along the train move together:
      //     the rider's arc length relative to the train's own reference point
      //     never goes backwards while they hold W.
      const arc =
        consistOffset(pose.s, a.car, n, consist.pitch) + carSign(consist, a.car) * a.x - pose.s;
      if (arc < lastArc - 1e-6) arcBackwards++;
      lastArc = arc;
      endArc = arc;

      // (c) the wire carries the change. Encoded and decoded every tick, so the
      //     three bits of carriage are exercised at every index the walk visits
      //     rather than at the one it finishes on.
      wire[0].line = a.line;
      wire[0].dir = a.dir;
      wire[0].tripLow = a.trip & 0xff;
      wire[0].car = a.car;
      wire[0].x = a.x;
      wire[0].y = a.y;
      wire[0].z = a.z;
      const back = decodeSnapshot(encodeSnapshot(ticks, 0, [], [], [], wire), snap);
      const rec = back?.aboard[0];
      if (!rec || rec.car !== a.car) wireCarBad++;
      else if (
        Math.abs(rec.x - quantiseAlong(a.x) * ABOARD_STEP_M) > 1e-9 ||
        Math.abs(rec.y - quantiseRise(a.y) * ABOARD_STEP_M) > 1e-9 ||
        Math.abs(rec.z - quantiseAcross(a.z) * ABOARD_STEP_M) > 1e-9
      ) wireBad++;

      if (a.car === 0 && a.x > (interiorOfCar(consist, 0)!.xMax - 1.5)) {
        ended = 'reached the leading cab';
        break;
      }
    }

    const walked = endArc - startArc;
    say(
      `  ${bake.lines[found.li].id} trip ${found.trip}, ${n} cars at ` +
        `${(minSpeed * 3.6).toFixed(0)} km/h minimum: walked ${walked.toFixed(1)} m of train in ` +
        `${ticks} ticks (${(ticks * FIXED).toFixed(1)} s), ${crossings} gangway crossing(s) -- ${ended}`,
    );
    say(
      `  carriage ${n - 1} -> ${a.car}; skipped couplings ${skipped}, left the consist ` +
        `${offConsist} time(s), went backwards along the train ${arcBackwards} tick(s)`,
    );
    say(
      `  the wire round-tripped the rider on ${ticks - wireCarBad - wireBad}/${ticks} ticks ` +
        `(${wireCarBad} wrong carriage, ${wireBad} outside the 2.5 cm quantiser)`,
    );
    const ok =
      crossings === n - 1 && skipped === 0 && offConsist === 0 && arcBackwards === 0 &&
      wireCarBad === 0 && wireBad === 0 && a.car === 0;
    say(`  gangway walk: ${ok ? 'PASS' : 'FAILED'}`);
    if (!ok) process.exit(1);
  }
  if ((process.env.RIDE_GANGWAY ?? 'on') === 'only') process.exit(0);
}

/** The city, as far as a headless pilot needs one: flat, and never consulted aboard. */
let lastGround = -55;
const city: CombatWorld = {
  collision: null as never,
  groundHeight: (): number => lastGround,
  waterSurface: (): number => -1e9,
};

class Pilot {
  readonly net: NetClient;
  readonly combat = createCombatant(0, 0, 0);
  readonly frame = createCarFrame();
  readonly stand = createCarriageStand();
  readonly offer = createBoardOffer();
  readonly input = {
    forward: 0, right: 0, jump: false, sprint: false,
    yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1,
    punch: false, throwBall: false, mount: false,
  };
  readonly correction = this.combat.body.velocity.clone();
  rideEnded = 0;
  worstGap = 0;
  worstGapAt = '';
  worstCorrection = 0;
  corrections0 = 0;

  constructor(readonly name: string) {
    this.net = new NetClient(URL_, {
      onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
      onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
    }, { name });
    this.net.setRail(bake);
  }

  get aboard(): boolean { return isAboard(this.combat.aboard); }
  get pos() { return this.combat.body.position; }

  /** The server's own last word about this body, straight off the decoded snapshot. */
  serverSelf(): { x: number; y: number; z: number } | null {
    const held = (this.net as unknown as {
      snapshots: Array<{ players: Array<{ id: number; x: number; y: number; z: number }> }>;
    }).snapshots;
    const newest = held.length > 0 ? held[held.length - 1] : null;
    return newest?.players.find((p) => p.id === this.net.id) ?? null;
  }

  serverAboard(): { id: number; line: number; dir: number; car: number; x: number; y: number; z: number } | null {
    const held = (this.net as unknown as {
      snapshots: Array<{ aboard: Array<{ id: number; line: number; dir: number; car: number; x: number; y: number; z: number }> }>;
    }).snapshots;
    const newest = held.length > 0 ? held[held.length - 1] : null;
    return newest?.aboard.find((a) => a.id === this.net.id) ?? null;
  }

  step(judge: boolean): void {
    this.net.reconcile(this.combat, city, this.correction);
    const c = Math.hypot(this.correction.x, this.correction.y, this.correction.z);
    if (judge && c > this.worstCorrection) this.worstCorrection = c;

    let world: CombatWorld = city;
    if (this.aboard) {
      const got = rideEnter(bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame, this.stand);
      if (got === RIDE_ON) world = this.stand as unknown as CombatWorld;
      else { this.rideEnded++; clearAboard(this.combat.aboard); }
    } else {
      lastGround = this.pos.y - EYE_HEIGHT;
    }
    advance(this.combat, this.input, FIXED_DT, world);
    // `rideExit` rather than `exitLocal`, which is the browser's own line and the
    // server's: the crossing between two Metro carriages happens here, inside the
    // step, before the composition. The yaw delta goes on `input.yaw` because
    // while aboard that field *is* the rider's carriage-local heading, exactly as
    // it is in `main.ts` -- see `riding.crossGangway`.
    if (world !== city) {
      this.input.yaw += rideExit(
        bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame,
      );
    }
    this.net.sendInput(this.input, this.combat.body.velocity);
    this.net.update(FIXED_DT);

    if (judge) {
      const s = this.serverSelf();
      if (s) {
        const g = Math.hypot(this.pos.x - s.x, this.pos.y - s.y, this.pos.z - s.z);
        if (g > this.worstGap) {
          this.worstGap = g;
          // Split along the railway and across it. A gap that is purely ALONG
          // the track is the snapshot being one interval old at 44 m/s -- an
          // artefact of what this script can see, since a real client never
          // compares itself to a stale snapshot. A gap ACROSS the track is a
          // genuine disagreement about where in the carriage this body is.
          const pose = isAboard(this.combat.aboard)
            ? aboardPose(bake, this.combat.aboard, railSeconds(Date.now()))
            : null;
          const dx = this.pos.x - s.x;
          const dz = this.pos.z - s.z;
          const along = pose ? Math.abs(dx * pose.dx + dz * pose.dz) : NaN;
          const across = pose ? Math.abs(dx * -pose.dz + dz * pose.dx) : NaN;
          const speed = pose ? pose.speed : 0;
          this.worstGapAt =
            `${((Date.now() - judgeFrom) / 1000).toFixed(1)} s in, ` +
            `${this.aboard ? 'aboard' : 'NOT aboard'}; ` +
            `${along.toFixed(2)} m along the track and ${across.toFixed(2)} m across it, ` +
            `at ${(speed * 3.6).toFixed(0)} km/h -- the along-track part is ` +
            `${speed > 1 ? ((along / speed) * 1000).toFixed(0) : '?'} ms of train`;
        }
      }
    }
  }

  board(): boolean {
    if (!boardHere(bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame, this.offer, EYE_HEIGHT)) {
      return false;
    }
    this.net.predictedAboardChange();
    return true;
  }
}

const until = async (want: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (want()) return true; await Bun.sleep(20); }
  return want();
};

const rider = new Pilot('acc-rider');
const watcher = new Pilot('acc-watch');
const pilots = [rider, watcher];

let judging = false;
let judgeFrom = Date.now();
let running = true;
const loop = (async (): Promise<void> => {
  let next = Date.now();
  while (running) {
    next += 1000 / TICK_HZ;
    for (const p of pilots) if (p.net.status === 'online') p.step(judging);
    const slack = next - Date.now();
    if (slack > 0) await Bun.sleep(slack);
    else next = Date.now();
  }
})();

const ok = await until(() => pilots.every((p) => p.net.status === 'online'), 15000);
if (!ok) { say(`FAILED to connect to ${URL_}: ${pilots.map((p) => p.net.status).join(', ')}`); process.exit(1); }
say(`connected to ${URL_}: rider id ${rider.net.id}, watcher id ${watcher.net.id}`);

// --- 1. Ask the SERVER to put us on the platform.
const before = { x: rider.pos.x, z: rider.pos.z };
rider.net.armTeleport();
rider.net.sendChat(`/platform ${FROM}`);
watcher.net.armTeleport();
await Bun.sleep(150);
watcher.net.sendChat(`/platform ${FROM}`);
const moved = await until(() => Math.hypot(rider.pos.x - before.x, rider.pos.z - before.z) > 20, 8000);
say(moved
  ? `/platform moved the rider to (${rider.pos.x.toFixed(1)}, ${rider.pos.z.toFixed(1)}) -- the server placed us`
  : 'FAILED: /platform did not move us');
if (!moved) process.exit(1);

// --- 2. Wait for the doors, solved rather than polled.
const dwell = nextDwell(bake, FROM, railSeconds(Date.now()), {});
if (!dwell) { say(`no service calls at ${FROM}`); process.exit(1); }
const wait = dwell.opensAt - railSeconds(Date.now());
say(`${dwell.lineId} to ${dwell.towards}: doors open in ${wait.toFixed(1)} s`);
await Bun.sleep(Math.max(0, wait + 2) * 1000);

// --- 3. Board, both of them, and check the SERVER agrees.
const got = rider.board();
rider.input.mount = true;
watcher.input.mount = true;
say(`the rider's own findBoarding: ${got ? `carriage ${rider.offer.car}, bay ${rider.offer.bay}` : 'REFUSED'}`);
await Bun.sleep(120);
rider.input.mount = false;
watcher.input.mount = false;

const agreed = await until(() => rider.serverAboard() !== null, 3000);
say(agreed
  ? `the SERVER put the rider aboard: its snapshot carries the aboard section for id ${rider.net.id}`
  : 'FAILED: the server never put the rider aboard');
if (!agreed) process.exit(1);
const watchAboard = watcher.serverAboard() !== null;
say(`the watcher (which predicted nothing, only pressed the button) is aboard: ${watchAboard}`);

// --- 4. Ride. Judged from three seconds after the server confirmed the
//     boarding, so the transition itself -- which is a real correction, and is
//     supposed to be -- is not counted as riding.
await Bun.sleep(3000);
judgeFrom = Date.now();
judging = true;
const startPos = { x: rider.pos.x, z: rider.pos.z };
const rideFor = Number(process.env.RIDE_S ?? 100);
let insideChecks = 0;
let insideHits = 0;
let worstOut = 0;
let lostServer = 0;
const wf = createCarFrame();
const scratch = { x: 0, y: 0, z: 0 };
const t0 = Date.now();
while (Date.now() - t0 < rideFor * 1000) {
  await Bun.sleep(250);
  if (rider.serverAboard() === null) { lostServer++; continue; }
  // What the SECOND client draws for the rider, pushed back into the carriage.
  const remote = watcher.net.remotes.get(rider.net.id);
  const a = rider.combat.aboard;
  if (remote && isAboard(a)) {
    const dir = dirOf(bake, a.line, a.dir);
    const it = dir === null ? null : interiorOfCar(consistOf(dir, a.trip), a.car);
    if (it && aboardFrame(bake, a, railSeconds(Date.now()), wf)) {
      worldToLocal(wf, remote.position.x, remote.position.y, remote.position.z, scratch);
      insideChecks++;
      const out = Math.max(it.xMin - scratch.x, scratch.x - it.xMax, Math.abs(scratch.z) - it.halfWidth, 0);
      if (out > worstOut) worstOut = out;
      if (out < 0.6) insideHits++;
    }
  }
}
const travelled = Math.hypot(rider.pos.x - startPos.x, rider.pos.z - startPos.z);
say(`rode ${rideFor} s and moved ${travelled.toFixed(0)} m; the ride ended under the client ${rider.rideEnded} time(s)`);
say(`worst client-vs-server world position gap: ${rider.worstGap.toFixed(3)} m (${rider.worstGapAt})`);
say(`worst eased camera correction: ${rider.worstCorrection.toFixed(4)} m; corrections ${rider.net.corrections}, snaps ${rider.net.snaps}`);
say(`the second client drew the rider inside the carriage on ${insideHits}/${insideChecks} samples (worst ${worstOut.toFixed(2)} m outside the box)`);
say(`snapshots in which the server said "not aboard": ${lostServer}`);

// --- 5. And a swing, aboard, at line speed.
if (watcher.serverAboard() !== null && rider.serverAboard() !== null) {
  const before = rider.combat.health;
  const w = watcher.combat.aboard;
  const r = rider.combat.aboard;
  watcher.input.yaw = Math.atan2(-(r.x - w.x), -(r.z - w.z));
  watcher.input.punch = true;
  await Bun.sleep(60);
  watcher.input.punch = false;
  await Bun.sleep(1200);
  say(`bat aboard: the rider's health went ${before.toFixed(1)} -> ${rider.combat.health.toFixed(1)} ` +
    `(${(Math.hypot(r.x - w.x, r.z - w.z)).toFixed(2)} m apart in the carriage)`);
}

// --- 6. Off.
judging = false;
clearAboard(rider.combat.aboard);
rider.net.predictedAboardChange();
rider.input.mount = true;
clearAboard(watcher.combat.aboard);
watcher.net.predictedAboardChange();
watcher.input.mount = true;
await Bun.sleep(150);
rider.input.mount = false;
watcher.input.mount = false;
await Bun.sleep(1500);
const off = rider.serverAboard() === null;
const s = rider.serverSelf();
say(`E got the rider off: server aboard = ${!off ? 'STILL ABOARD' : 'no'}; ` +
  `client at (${rider.pos.x.toFixed(1)}, ${rider.pos.z.toFixed(1)}), server at ` +
  `(${s?.x.toFixed(1)}, ${s?.z.toFixed(1)}), ` +
  `${s ? Math.hypot(rider.pos.x - s.x, rider.pos.z - s.z).toFixed(2) : '?'} m apart, ` +
  `onGround ${rider.combat.body.onGround}`);

running = false;
await loop;
for (const p of pilots) p.net.close();
process.exit(0);
