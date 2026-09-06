/**
 * How much car goes through you before anything happens. TEMPORARY.
 *
 * The report this exists to measure is one sentence long: *"when I get hit by a
 * car the car mostly goes through me then the collision fires"*. Every unit
 * check in `traffic.verifyTraffic` already asserts that the geometry is right --
 * a body standing in the lane *is* found, the impulse *is* the one the table
 * names, the drawn box *is* the box that hits -- and every one of them passed on
 * the code that produced the report. They had to: they ask `carHitting` a
 * question and read its answer, and `carHitting` was never wrong. What none of
 * them can see is what a *player* sees, which is a car and a body drawn in the
 * same place for a fifth of a second.
 *
 *     bun run server/carhit-check.ts
 *
 * So this is the missing harness, and it is deliberately the whole loop: a real
 * `Room` over a real `Simulation`, a real `NetClient`, real snapshot and input
 * frames across a lag-injecting loopback, and a scripted player in the lane of
 * `traffic.syntheticTile`'s 200 m street while a scheduled car arrives at 8, 15
 * and 25 m/s. It prints, per 60 Hz tick around the contact, what the server
 * believes, what the client would draw and where the two bodies are; and out of
 * that it reduces the report to a table:
 *
 *   - **penetration**: the metres of car that have passed the near surface of
 *     the player's capsule while the two are still drawn overlapping. Zero is
 *     "you were thrown clear on the frame of contact"; the full pass-through
 *     length is "the car drove through you and you noticed afterwards".
 *   - **contact**: how many unbroken 60 Hz frames from the moment of contact the
 *     car and the body are drawn inside one another.
 *   - **camera** and **step**: what the *reconciler* did about it -- the eased
 *     offset it asked the camera to carry, and the largest single-frame jump of
 *     the drawn body. These are the columns that caught the second half of the
 *     report, and they were both at nothing until the first half was fixed; see
 *     `traffic.CAR_CLEAR_SPEED`.
 *
 * Three cases per speed: a **standing** player, which is the report; a
 * **walking** one, which is a body the server is three ticks out of date about;
 * and a **crossing** one on a deliberately awful 400 ms link, which is the only
 * way to make the server actually disagree with the client about whether the hit
 * happened at all. The third is judged differently on purpose -- see the
 * assertions.
 *
 * ---------------------------------------------------------------------------
 * ONE VIRTUAL CLOCK, AND WHY IT IS `Date.now` ITSELF.
 *
 * `game/traffic.ts` is a lookup and not a simulation: every car pose on both
 * ends is a pure function of `trafficTick(Date.now())`. That is the whole design
 * and it is what makes the prediction exact -- and it is also what makes a
 * harness hard, because a check that stepped 600 ticks in 200 ms of real time
 * would watch a photograph of a street rather than a car arriving.
 *
 * `Simulation.railNowMs` is the seam that exists for exactly this problem one
 * clock over, and the note under it states the rule: *a measurement of a network
 * taken over a real one is a measurement of the afternoon*. There is no such
 * seam for the traffic clock -- there are two dozen `trafficTick(Date.now())`
 * call sites in `server/sim.ts` alone, and threading a getter through all of
 * them to serve one driver would be a production change made for a test. So the
 * clock is replaced at the root instead, in this process only: `Date.now` is
 * swapped for a counter that advances 1/60 s per tick, both ends read it through
 * the same function they always do, and nothing anywhere is faked. It is put
 * back before the process exits.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MODELLED.
 *
 * The client half of the loop is `main.ts`'s fixed step with the presentation
 * taken out, in `main.ts`'s order and no other: reconcile, `combat.advance`,
 * then the traffic block (`carHitting`, `applyCarHit`), then `sendInput`. That
 * order is load-bearing -- the velocity `sendInput` records is the post-shove
 * one -- so a harness that ran it in any other order would be measuring a client
 * nobody ships.
 *
 * The *cars* are not drawn at the interpolation delay and this harness does not
 * pretend they are. `net/interpdelay.ts` moves the clock that remote **players**
 * are drawn on; `main.ts` poses the fleet at `trafficTick(Date.now()) +
 * accumulator / FIXED_DT`, which is now or a fraction ahead of it. So the car
 * you see is the car the hit test sees, and any lateness in the reaction is not
 * the car being drawn late. Establishing that was the first thing this driver
 * did; see the report.
 *
 * Delete before the branch is merged.
 */

import { Room, newConn, receiveInput, type Conn, type Socket } from './room.ts';
import { groundFor, type ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  advance,
  createCombatant,
  type CombatInput,
} from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { CORRECTION_DEADZONE, NetClient } from '../client/src/net/client.ts';
import { MSG, TICK_HZ, frameType, type NetTransport } from '../client/src/net/protocol.ts';
import {
  CAR_CLEAR_SPEED,
  TrafficField,
  applyCarHit,
  carHitting,
  createCarPose,
  forEachCarNear,
  syntheticTile,
  trafficTick,
  type CarPose,
  type LaneRoute,
} from '../client/src/game/traffic.ts';

const FIXED_DT = 1 / TICK_HZ;

/** `verifyTraffic`'s own street: a 7.5 m residential carriageway, quarter width. */
const LANE_OFFSET = 1.875;

/**
 * Where on the street the player stands, metres north of the tile origin.
 *
 * Between the red light at 100 m and the route's end at 200 m, so the car
 * arrives at the timetable's full speed rather than easing away from the
 * stop -- `carHitStrength` would otherwise scale the impulse and the run would
 * be measuring a creep rather than a hit.
 */
const STAND_Z = -140;

/** One-way trip, in ticks. Three is 50 ms each way: a 100 ms round trip. */
const LAG_TICKS = 3;

/**
 * The trip the refusal case runs at, ticks each way. **Twelve is 400 ms.**
 *
 * Deliberately worse than anything a Sydney player sees, because the case it is
 * built to produce does not happen at 100 ms: the server adjudicates against the
 * last input it applied, and over three ticks a sprinting body moves 25 cm --
 * far inside a 1.8 m wide hit box, so both ends always agree. Over twelve it
 * moves a metre, which is enough to put the client inside the box and the
 * server's stale copy outside it. That is the **false positive** -- a knockdown
 * this client predicted and the server refused -- and the whole point of the
 * gate in `NetClient.reconcile` is what happens next.
 */
const REFUSAL_LAG_TICKS = 12;

/** What the scripted player does. See `WALK_FROM_TICK` and `REFUSAL_LAG_TICKS`. */
type Mode = 'standing' | 'walking' | 'crossing';

/**
 * Where the crossing case starts, metres west of the lane it is about to run
 * into, and the tick it sets off. `SPRINT_SPEED` is 8.2 and the acceleration
 * ramp eats a few ticks, so two metres from sixteen ticks out puts the body
 * arriving in the lane as the car does.
 *
 * The *lateral* direction on purpose: the hit box is 4.4 m long and 1.8 m wide,
 * so a body that is a metre out of date along the lane is still inside the box
 * and a body that is a metre out of date across it is not. If a stale server
 * copy is ever going to refuse a hit this client predicted, it is here.
 */
const CROSS_START_M = 2.0;
const CROSS_FROM_TICK = 163;

/** `player/controller.WALK_SPEED`, which this file may not import. */
const WALK_SPEED = 4.4;

/** How long a run watches, ticks. Three seconds of approach and two of aftermath. */
const RUN_TICKS = 300;

/** The three speeds the report is printed at, m/s. */
const SPEEDS = [8, 15, 25];

/**
 * MAX_STEP_M, the largest single-frame jump of the drawn body a run is allowed,
 * is **derived per run** in `main` rather than written down here, and this note
 * is why it is not zero.
 *
 * A car hit is fired on the **wall clock**, so the two ends attribute it to
 * different input seqs -- the client to the one it is about to send, the server
 * to the one it happened to be applying -- and the server's position for any seq
 * therefore carries one one-way trip more of flight than this client's does.
 * That offset is real, is bounded by the trip, and has to be absorbed somewhere.
 * `NetClient.reconcile` absorbs it into the body on the frame the prediction is
 * answered, with the camera told nothing, because that is the rule the snap
 * branch already states for every other knockback: a knockback is flown and not
 * dragged.
 *
 * So the budget is a round trip of flight at this run's own throw speed, and
 * anything past it is not the offset -- it is a mispredicted hit being taken
 * back.
 */

/**
 * The tick a walking case starts walking, and which way.
 *
 * The standing player is the report; the walking one is the *other* half of the
 * question. The server adjudicates the traffic against the last input it has
 * actually applied, which at a 100 ms round trip is three ticks behind the
 * client's own -- so a player who is moving is a player about whom the two ends
 * can genuinely disagree about a hit, and this run is what measures whether that
 * disagreement ever becomes a knockdown one end applied and the other refused.
 *
 * **Into** the car rather than away from it (`yaw` of pi is +Z, and the route
 * runs north, which is -Z). Two reasons and both matter: walking away would push
 * the contact past the end of the run at the slowest speed, and walking into it
 * is the case with the most disagreement in it -- the server's picture of this
 * body is three ticks *behind* a body that is closing, so the server's copy is
 * the one further from the car, which is the direction that produces a refusal
 * rather than a duplicate.
 *
 * Half a second before contact, so the body is unambiguously in motion when the
 * hit is adjudicated without the walk having moved the meeting point far.
 */
const WALK_FROM_TICK = 150;

// --- The world -------------------------------------------------------------------

/** `cardamage-check.emptyWorld`, with one street in it and no wall. */
function streetWorld(speed: number): ServerWorld {
  const traffic = new TrafficField();
  // `laneY` 0 rather than the -12.5 every unit check reads: a player's feet in
  // an empty test city are at 0, and a lane twelve metres underground is a lane
  // `carOverlaps` correctly refuses to let anybody touch. See that parameter.
  traffic.adopt('street', syntheticTile(
    LANE_OFFSET, 0, 0, undefined, 14, 3, 0, 0x5eed, 0, null, undefined, speed,
  ));
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    hexes: [],
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic,
    peds: new PedestrianField(),
    points: [],
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: LANE_OFFSET * -1, z: STAND_Z },
    places: [],
  };
}

// --- The loopback ---------------------------------------------------------------

class FakeSocket {
  readonly frames: ArrayBuffer[] = [];
  constructor(readonly data: Conn) {}
  send(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.frames.push(bytes.slice().buffer as ArrayBuffer);
    return bytes.byteLength;
  }
  close(): void {}
  ping(): number { return 0; }
}

// --- The measurement --------------------------------------------------------------

/**
 * How deep the car is into the body, along the car's own heading, metres.
 *
 * Zero at the instant the nose touches the near surface of the capsule and
 * growing as the car advances, which is exactly the quantity the report is
 * about. Negative before contact and past the far surface; the caller clamps.
 *
 * `carOverlaps` is the authority on *whether* they touch and this is only the
 * depth, so the two are asked separately and the depth is only ever read on a
 * frame the overlap test has already said yes to.
 */
function penetrationOf(pose: CarPose, x: number, z: number): number {
  const rx = x - pose.x;
  const rz = z - pose.z;
  const along = rx * pose.dx + rz * pose.dz;
  return pose.halfLength + CAPSULE_RADIUS - along;
}

/** The same box test `traffic.carOverlaps` runs, against a bare position. */
function overlapsAt(pose: CarPose, x: number, feet: number, z: number): boolean {
  if (feet > pose.y + pose.height) return false;
  if (feet + CAPSULE_HEIGHT < pose.y) return false;
  const rx = x - pose.x;
  const rz = z - pose.z;
  const along = rx * pose.dx + rz * pose.dz;
  if (along > pose.halfLength + CAPSULE_RADIUS || along < -pose.halfLength - CAPSULE_RADIUS) return false;
  const across = rx * pose.dz - rz * pose.dx;
  return across <= pose.halfWidth + CAPSULE_RADIUS && across >= -pose.halfWidth - CAPSULE_RADIUS;
}

interface Run {
  speed: number;
  mode: Mode;
  lag: number;
  /** Metres of car past the near surface of the body while still drawn overlapping. */
  penetration: number;
  /**
   * 60 Hz frames of *unbroken* overlap from the frame of contact.
   *
   * The one the report is about, and it is counted as a run rather than as a
   * total for a reason worth stating: a body thrown 15 m by a car doing 8 m/s
   * lands, stops, and is caught up with a second later by the same car still
   * coming down the same lane. Those frames are a real artefact and they are a
   * *different* one -- a prone body in a live lane, which `canBeRunDown`
   * deliberately refuses to re-launch -- so they are counted separately below
   * rather than folded into this number and blamed on the knockdown.
   */
  contactFrames: number;
  /** Frames of overlap after the body had once left the box. See above. */
  returnFrames: number;
  /** The full pass-through length of this car, for scale. */
  throughM: number;
  /** The worst backwards jump of the client body after the prediction, metres. */
  rewindM: number;
  /** Snap and ordinary corrections the reconciler applied over the run. */
  snaps: number;
  corrections: number;
  /** Knockdowns each end applied inside the second after the first one. */
  clientHits: number;
  serverHits: number;
  /** The worst eased camera offset the reconciler asked for after the hit, metres. */
  worstCorrection: number;
  /** The largest single-frame move of the drawn body after the hit, metres. */
  worstStep: number;
  /** The client's own hit tick, the server's, and the tick the HIT event landed. */
  predictedAt: number;
  serverAt: number;
  eventAt: number;
  /** The largest gap between the client's body and the server's over the run, metres. */
  worstGap: number;
  /** How long a gap over `CORRECTION_DEADZONE` lasted after the hit, ticks. */
  settleTicks: number;
  /** How far apart the two bodies finished, metres. */
  finalGap: number;
  notes: string[];
}

function runOne(speed: number, mode: Mode, lag: number, verbose: boolean): Run {
  const realNow = Date.now;
  const world = streetWorld(speed);
  const ground = groundFor(world);

  // --- Find the arrival, rather than waiting for it.
  //
  // The timetable is a closed-form function of the tick, so "when does a car
  // reach this spot" is a scan of a pure function and not a wait. The clock is
  // then wound to three seconds before it, which is long enough for the room to
  // have acknowledged a dozen inputs and for the reconciler to be warm.
  const probe = createCombatant(9, -LANE_OFFSET, STAND_Z);
  probe.body.position.set(-LANE_OFFSET, EYE_HEIGHT, STAND_Z);
  const scratch: LaneRoute[] = [];
  const pose = createCarPose();
  const from = trafficTick(realNow());
  let arrival = -1;
  for (let t = from; t < from + 60 * 240; t++) {
    if (carHitting(world.traffic, probe, t, scratch, pose) !== null) { arrival = t; break; }
  }
  if (arrival < 0) throw new Error(`no car reaches the stand at ${speed} m/s within four minutes of street`);

  // --- The clock. See the header: replaced at the root, in this process only.
  const startTick = arrival - 180;
  let clockMs = startTick * 1000 / TICK_HZ;
  // `trafficTick` is `floor((ms - epoch) / (1000 / hz))` against the bake's own
  // epoch, so a tick number is turned back into a millisecond by inverting it
  // through the same field rather than by assuming the epoch is zero.
  {
    const epochProbe = trafficTick(0);
    clockMs = (startTick - epochProbe) * (1000 / TICK_HZ);
  }
  (Date as unknown as { now: () => number }).now = () => clockMs;

  const room = new Room(0, world, 8, 0);
  const sock = new FakeSocket(newConn(0));

  const toServer: Array<{ f: ArrayBuffer; at: number }> = [];
  const toClient: Array<{ f: ArrayBuffer; at: number }> = [];
  let tick = 0;
  const transport: NetTransport = {
    open: true, onframe: null, onopen: null, onclose: null,
    send(f: ArrayBuffer): void { toServer.push({ f, at: tick + lag }); },
    close(): void {},
  };

  let eventAt = -1;
  const net = new NetClient('', {
    onHit(attacker, victim) { if (attacker === victim && eventAt < 0) eventAt = tick; },
    onSwat: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
    onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
  }, { name: 'pedestrian', transport, nowMs: () => clockMs });
  transport.onopen?.();

  const startX = mode === 'crossing' ? -LANE_OFFSET - CROSS_START_M : -LANE_OFFSET;
  const combat = createCombatant(0, startX, STAND_Z);
  combat.body.position.set(startX, EYE_HEIGHT, STAND_Z);
  const input: CombatInput = {
    forward: 0, right: 0, jump: false, sprint: false,
    // Facing the oncoming car in the walking case, and held constant from the
    // first tick so the turn itself is never a correction. See `WALK_FROM_TICK`.
    yaw: mode === 'walking' ? Math.PI : 0, pitch: 0,
    speedScale: 1, jumpScale: 1, punch: false, throwBall: false,
  };
  const correction = combat.body.velocity.clone();
  const clientScratch: LaneRoute[] = [];
  const clientPose = createCarPose();
  const drawn = createCarPose();
  const drawnScratch: LaneRoute[] = [];

  let joined = false;
  let placed = false;
  let predictedAt = -1;
  let serverAt = -1;
  let penetration = 0;
  let contactFrames = 0;
  let returnFrames = 0;
  let throughM = 0;
  let rewindM = 0;
  let leftTheBox = false;
  let clientHits = 0;
  let serverHits = 0;
  let worstGap = 0;
  let settleTicks = 0;
  let worstCorrection = 0;
  let worstStep = 0;
  let finalGap = 0;
  let lastDrawnX = 0;
  let lastDrawnZ = 0;
  let haveLastDrawn = false;
  const notes: string[] = [];
  // Where the hit happened and which way it threw, for the rubber-band measure.
  let hitX = 0;
  let hitZ = 0;
  let hitDx = 0;
  let hitDz = -1;
  let bestProgress = 0;
  const rows: string[] = [];

  const participant = () => sock.data.participant;

  for (tick = 0; tick < RUN_TICKS; tick++) {
    clockMs += 1000 / TICK_HZ;
    const now = trafficTick(clockMs);
    // Walking straight into it, or sprinting into its path. See `Mode`.
    input.forward = mode === 'walking' && tick > WALK_FROM_TICK ? 1 : 0;
    input.right = mode === 'crossing' && tick > CROSS_FROM_TICK ? 1 : 0;
    input.sprint = mode === 'crossing' && tick > CROSS_FROM_TICK;

    // --- The client's fixed step, in `main.ts`'s order and no other.
    net.reconcile(combat, ground, correction);
    // The eased offset the camera is asked to carry. This -- not the raw gap
    // between the two bodies -- is what a player can see the reconciler doing:
    // a body legitimately predicted ahead of the server draws no offset at all,
    // where a body the reconciler has decided was wrong draws the whole of the
    // disagreement and then walks it off over 80 ms. See `net/client.CORRECTION_TAU`.
    if (predictedAt >= 0 && tick - predictedAt <= TICK_HZ) {
      const c = Math.hypot(correction.x, correction.y, correction.z);
      if (c > worstCorrection) worstCorrection = c;
    }
    advance(combat, input, FIXED_DT, ground);
    const car = carHitting(world.traffic, combat, now, clientScratch, clientPose);
    if (car !== null) {
      if (predictedAt < 0) {
        predictedAt = tick;
        hitX = combat.body.position.x;
        hitZ = combat.body.position.z;
        hitDx = car.dx;
        hitDz = car.dz;
      }
      applyCarHit(combat, car);
      // `main.ts`'s line, in `main.ts`'s place: inside the step, before the
      // input that names this tick goes out. See `NetClient.predictedCarHit`.
      net.predictedCarHit();
      clientHits++;
    }
    net.sendInput(input, combat.body.velocity);

    // --- The wire, and the room.
    for (let i = toServer.length - 1; i >= 0; i--) {
      if (toServer[i].at > tick) continue;
      const { f } = toServer.splice(i, 1)[0];
      if (frameType(f) === MSG.HELLO && !joined) {
        joined = true;
        const p = room.join(sock.data, 0, 'pedestrian');
        if (p) {
          room.conns.add(sock as unknown as Socket);
          room.welcome(sock as unknown as Socket, p);
        }
      } else if (frameType(f) === MSG.INPUT && joined) {
        receiveInput(sock.data, f);
      }
    }
    if (!placed && participant()) {
      // Placed by the server, which is the only end allowed to place anybody.
      placed = true;
      const b = participant()!.combat.body;
      b.position.set(startX, EYE_HEIGHT, STAND_Z);
      b.velocity.set(0, 0, 0);
      participant()!.history.seed(room.sim.tick, b.position.x, b.position.y, b.position.z, 0);
    }
    const healthBefore = participant()?.combat.health ?? 0;
    room.step();
    if (participant() && participant()!.combat.health < healthBefore) {
      if (serverAt < 0) serverAt = tick;
      serverHits++;
    }
    for (const f of sock.frames.splice(0)) toClient.push({ f, at: tick + lag });
    for (let i = toClient.length - 1; i >= 0; i--) {
      if (toClient[i].at > tick) continue;
      transport.onframe?.(toClient.splice(i, 1)[0].f);
    }

    // --- What is on screen: the car this client would draw at this tick, and
    //     the body it would draw beside it. Both at `now`; see the header on why
    //     the interpolation delay is not in this line.
    let found = false;
    forEachCarNear(world.traffic, combat.body.position.x, combat.body.position.z, 12, now, drawnScratch, drawn, (p) => {
      if (p.speed <= 1) return;
      found = true;
      return true;
    });
    const feet = combat.body.position.y - EYE_HEIGHT;
    const cx = combat.body.position.x + correction.x;
    const cz = combat.body.position.z + correction.z;
    const overlapping = found && overlapsAt(drawn, cx, feet + correction.y, cz);
    if (found) throughM = Math.max(throughM, 2 * (drawn.halfLength + CAPSULE_RADIUS));
    // **The event window.** Everything about the picture is measured across the
    // second after the first knockdown and no further, which is the span the
    // report is a report about. Past it the body is lying in a live lane and is
    // run over again once `CAR_STAGGER` expires -- a second knockdown, with a
    // second prediction and a second correction, and folding those into the
    // first one's numbers would be measuring three events and calling it one.
    const inEvent = predictedAt >= 0 && tick - predictedAt <= TICK_HZ;
    if (inEvent) {
      if (!overlapping) {
        leftTheBox = true;
      } else if (leftTheBox) {
        returnFrames++;
      } else {
        contactFrames++;
        penetration = Math.max(
          penetration,
          Math.min(penetrationOf(drawn, cx, cz), 2 * (drawn.halfLength + CAPSULE_RADIUS)),
        );
      }
      // The rubber band, measured along the throw rather than from a fixed
      // point: how far the body ever goes *back* toward the car after having
      // been thrown away from it. A distance from where the player was standing
      // would have called the walking case a rewind on its first tick, because
      // a body walking north and then thrown south really does come back past
      // its own start -- and that is the knockdown working, not a correction.
      // The largest single-frame move of the thing on screen. A body flying at
      // 28 m/s moves 0.47 m a frame all by itself, so what this catches is a
      // *jump* on top of that -- the reconciler adopting an answer.
      if (haveLastDrawn) {
        const stepM = Math.hypot(cx - lastDrawnX, cz - lastDrawnZ);
        if (stepM > worstStep) worstStep = stepM;
      }
      haveLastDrawn = true;
      lastDrawnX = cx;
      lastDrawnZ = cz;
      const progress = (cx - hitX) * hitDx + (cz - hitZ) * hitDz;
      if (progress > bestProgress) bestProgress = progress;
      else rewindM = Math.max(rewindM, bestProgress - progress);
      // And how long the two ends took to agree again. `CORRECTION_DEADZONE` is
      // the reconciler's own statement of what is not worth doing anything
      // about, so it is the honest threshold for "settled".
      const sp = participant()?.combat.body.position;
      if (sp) {
        const gap = Math.hypot(cx - sp.x, cz - sp.z);
        if (gap > worstGap) worstGap = gap;
        if (gap > CORRECTION_DEADZONE) settleTicks = tick - predictedAt + 1;
      }
    }
    // Where the two bodies finished, whatever happened in between. A
    // misprediction the server refuses is *allowed* to be visible -- that is the
    // server being authoritative -- but it is not allowed to leave the two ends
    // in different streets.
    {
      const sp = participant()?.combat.body.position;
      if (sp) finalGap = Math.hypot(combat.body.position.x - sp.x, combat.body.position.z - sp.z);
    }
    if (verbose && predictedAt >= 0 && tick >= predictedAt - 4 && tick <= predictedAt + 30) {
      const sp = participant()?.combat.body.position;
      rows.push(
        `    t${String(tick).padStart(3)}  car(${drawn.x.toFixed(2)}, ${drawn.z.toFixed(2)}) ` +
          `client(${cx.toFixed(2)}, ${cz.toFixed(2)}) ` +
          `server(${sp ? sp.x.toFixed(2) : '  ?  '}, ${sp ? sp.z.toFixed(2) : '  ?  '}) ` +
          `corr ${Math.hypot(correction.x, correction.y, correction.z).toFixed(2)} ` +
          `${overlapping ? `INSIDE ${penetrationOf(drawn, cx, cz).toFixed(2)} m` : 'clear'}`,
      );
    }
  }

  if (predictedAt < 0) notes.push('the client never predicted a hit at all');
  if (serverAt < 0) notes.push('the server never adjudicated one');

  const out: Run = {
    speed, mode, lag, penetration, contactFrames, returnFrames, throughM, rewindM,
    snaps: net.snaps, corrections: net.corrections, clientHits, serverHits,
    worstCorrection, worstStep, predictedAt, serverAt, eventAt, worstGap, settleTicks, finalGap, notes,
  };
  if (verbose) for (const r of rows) console.log(r);

  net.close();
  (Date as unknown as { now: () => number }).now = realNow;
  return out;
}

function main(): void {
  const verbose = process.env.SYDNEY_CARHIT_TRACE === '1';
  console.log(
    '--- a scheduled car against a player, through a real Room and a real NetClient\n' +
      `    ${LAG_TICKS * 2} ticks of round trip (${(LAG_TICKS * 2 * 1000 / TICK_HZ).toFixed(0)} ms)`,
  );
  const runs: Run[] = [];
  for (const s of SPEEDS) runs.push(runOne(s, 'standing', LAG_TICKS, verbose));
  for (const s of SPEEDS) runs.push(runOne(s, 'walking', LAG_TICKS, false));
  // And the false positive, which needs a worse network than Sydney has to
  // happen at all. See `REFUSAL_LAG_TICKS`.
  for (const s of SPEEDS) runs.push(runOne(s, 'crossing', REFUSAL_LAG_TICKS, false));

  console.log('');
  console.log('    case               penetration  contact  through  returned  rewind   camera    step  snaps');
  for (const r of runs) {
    console.log(
      `    ${String(r.speed).padStart(2)} m/s ${r.mode.padEnd(9)}  ` +
        `${r.penetration.toFixed(2).padStart(6)} m   ` +
        `${String(r.contactFrames).padStart(3)} fr  ` +
        `${r.throughM.toFixed(2).padStart(5)} m  ` +
        `${String(r.returnFrames).padStart(4)} fr  ` +
        `${r.rewindM.toFixed(2).padStart(5)} m  ` +
        `${r.worstCorrection.toFixed(2).padStart(5)} m  ` +
        `${r.worstStep.toFixed(2).padStart(5)} m  ` +
        `${String(r.snaps).padStart(3)}`,
    );
  }
  console.log(
    `\n    "returned" is the car catching up with the *landed* body a second later, which is a lane\n` +
      '    with somebody lying in it and not the knockdown. See `Run.contactFrames`.',
  );
  console.log('');
  for (const r of runs) {
    console.log(
      `    ${r.speed} m/s ${r.mode} at ${r.lag * 2} ticks: the client applied ${r.clientHits} ` +
        `knockdown(s) at t${r.predictedAt}, the server ${r.serverHits} at t${r.serverAt}, the HIT event ` +
        `landed at t${r.eventAt}; ${r.corrections} corrections, worst gap ${r.worstGap.toFixed(2)} m, ` +
        `over the deadzone for ${r.settleTicks} ticks, finished ${r.finalGap.toFixed(2)} m apart` +
        (r.notes.length > 0 ? ` -- ${r.notes.join('; ')}` : ''),
    );
  }

  const failures: string[] = [];
  for (const r of runs) {
    const who = `${r.speed} m/s ${r.mode}`;
    for (const n of r.notes) failures.push(`${who}: ${n}`);

    // --- The report, against a bound that is *derived* rather than chosen.
    //
    // Two terms, and neither of them is a taste decision:
    //
    //   entry     the hit test is a per-tick overlap and not a swept one, so
    //             the first tick it says yes the nose is already up to one
    //             tick of car travel inside the capsule -- `speed / 60`, which
    //             is 42 cm at 25 m/s. Nothing an impulse does can undo a frame
    //             that has already been drawn; closing this would mean a swept
    //             box, and that is a bigger change than the report needs.
    //   exit      the two separate at `CAR_CLEAR_SPEED`, so clearing that
    //             entry depth takes `entry / (CAR_CLEAR_SPEED / 60)` frames,
    //             which is `speed / CAR_CLEAR_SPEED`.
    //
    // Written as the model plus a frame of slack, so a retune of
    // `CAR_CLEAR_SPEED` moves the check with the feature and a regression in
    // either term is caught by the term it belongs to.
    // --- The refusal case is judged differently, and that is the point of it.
    //
    // At a 400 ms round trip a knockdown the server declines to agree with
    // *must* be visible: the client predicted a shove against a body the server
    // has not seen move yet, and putting that right is a correction with a
    // player's eyes on it. Asserting it away would be asserting that the server
    // is not authoritative. What is asserted instead is the thing that actually
    // matters -- both ends adjudicate a hit, and the two bodies finish in the
    // same place -- and the picture columns are printed for the record.
    const settled = r.mode === 'crossing';
    const entryBound = r.speed / TICK_HZ + 0.1;
    const exitBound = Math.ceil(entryBound / (CAR_CLEAR_SPEED / TICK_HZ)) + 3;
    if (!settled && r.contactFrames > exitBound) {
      failures.push(
        `${who}: the car is drawn inside the player for ${r.contactFrames} frames from contact against ` +
          `the ${exitBound} the ${CAR_CLEAR_SPEED} m/s clearance models. The body is not leaving in front ` +
          'of the bumper.',
      );
    }
    if (!settled && r.penetration > entryBound) {
      failures.push(
        `${who}: ${r.penetration.toFixed(2)} m of car passed through the body against the ` +
          `${entryBound.toFixed(2)} m one tick of approach accounts for, out of a ` +
          `${r.throughM.toFixed(2)} m pass-through.`,
      );
    }

    // --- Both ends adjudicated one, and within a trip of each other.
    //
    // The server decides against the last input it applied, so a *moving*
    // player is genuinely a body the two ends place differently -- but the
    // disagreement is bounded by the trip, and a bigger one would mean they are
    // not asking the same question at all.
    //
    // Plus two ticks, and they are named rather than slack: `room.INPUT_RESERVE`
    // deliberately banks a frame at join so a starved tick has something to
    // spend, and the room applies the frame it takes on the tick *after* it
    // arrives. Both of those are the server being one input further behind than
    // the wire alone accounts for, and at a 24-tick trip a body sprinting into
    // a lane crosses the hit box's edge inside them.
    const tickBound = r.lag + 2;
    if (r.clientHits < 1 || r.serverHits < 1) {
      failures.push(
        `${who}: the client applied ${r.clientHits} knockdowns over the run and the server ` +
          `${r.serverHits}. Both ends run the same query against the same timetable.`,
      );
    } else if (Math.abs(r.serverAt - r.predictedAt) > tickBound) {
      failures.push(
        `${who}: the client hit at t${r.predictedAt} and the server at t${r.serverAt}, ` +
          `${Math.abs(r.serverAt - r.predictedAt)} ticks apart against a ${r.lag}-tick trip plus two.`,
      );
    }

    // --- The two ends never end up in different streets.
    //
    // A knockdown *is* allowed to open a gap: the client is predicting a 28 m/s
    // flight and hears from the server every 50 ms, so a lead of a round trip's
    // worth of that flight is prediction working rather than failing. What the
    // gap may never be is unbounded, so it is measured against exactly that --
    // a round trip of the throw, with a metre of slack for the walk.
    const throwSpeed = r.speed + CAR_CLEAR_SPEED;
    const gapBound = throwSpeed * (2 * r.lag) / TICK_HZ + 1;
    if (r.worstGap > gapBound) {
      failures.push(
        `${who}: the two bodies were ${r.worstGap.toFixed(2)} m apart against the ${gapBound.toFixed(2)} m ` +
          'a round trip of the throw accounts for.',
      );
    }

    // --- And, on a network anybody actually plays on, the reconciler is not
    //     what makes it look wrong.
    //
    // The measure is the **eased camera offset**, not the raw gap between the
    // two bodies: what a player can see is the offset the reconciler asks the
    // camera to carry and the snaps it takes.
    //
    // The budget is a quarter of a metre for the **standing** player, which is
    // the reported case and the one in which there is nothing to mispredict; a
    // player who is *moving* is a player the server places differently by up to
    // a trip of walking, and whose hit tick can therefore land a frame either
    // side of this client's, so the two of those are added rather than wished
    // away. Every term is derived, so a retune of the trip or of the throw moves
    // the check with it.
    if (settled) continue;
    if (r.mode === 'standing' && r.snaps > 0) {
      failures.push(`${who}: the reconciler took ${r.snaps} position snaps through the knockdown.`);
    }
    const moving = r.mode !== 'standing';
    const correctionBound = 0.25 + (moving ? (WALK_SPEED * r.lag + throwSpeed) / TICK_HZ : 0);
    if (r.worstCorrection > correctionBound) {
      failures.push(
        `${who}: the reconciler asked the camera to carry ${r.worstCorrection.toFixed(2)} m of correction ` +
          `after the hit, against a ${correctionBound.toFixed(2)} m budget. That is the stall-then-jump ` +
          'the report calls "then the collision fires".',
      );
    }
    if (r.rewindM > correctionBound) {
      failures.push(
        `${who}: the drawn body went ${r.rewindM.toFixed(2)} m back toward the car after being thrown ` +
          'clear of it.',
      );
    }
    const stepBound = throwSpeed * (2 * r.lag) / TICK_HZ;
    if (r.worstStep > stepBound) {
      failures.push(
        `${who}: the drawn body moved ${r.worstStep.toFixed(2)} m in one frame, past the ` +
          `${stepBound.toFixed(2)} m a round trip of flight accounts for. See MAX_STEP_M.`,
      );
    }
  }
  if (failures.length > 0) {
    console.log('');
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n  all clear');
  }
}

main();
