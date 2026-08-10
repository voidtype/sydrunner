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
 */
import { NetClient } from '../client/src/net/client.ts';
import { TICK_HZ } from '../client/src/net/protocol.ts';
import { advance, createCombatant } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { decodeRail, railSeconds } from '../client/src/game/rail.ts';
import {
  RIDE_ON, aboardFrame, aboardPose, boardHere, clearAboard, consistOf, createBoardOffer, createCarFrame,
  createCarriageStand, dirOf, exitLocal, interiorOfCar, isAboard, nextDwell, rideEnter,
  worldToLocal,
} from '../client/src/game/riding.ts';
import type { CombatWorld } from '../client/src/game/combat.ts';

const URL_ = process.env.SYDNEY_SERVER ?? 'ws://localhost:8788';
const FROM = process.env.SYDNEY_RIDE_FROM ?? 'St Peters';
const FIXED_DT = 1 / TICK_HZ;

const bake = decodeRail(await Bun.file('./client/public/rail/rail.bin').arrayBuffer());

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
      onHit: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
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
    if (world !== city) exitLocal(this.combat.aboard, this.combat.body, this.frame);
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

const say = (s: string): void => { console.log(s); };
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
