/**
 * The patrol car, as a player actually meets it: it arrives, it keeps up, it
 * gives up, and you can crash into it.
 *
 *     bun run server/pursuit-check.ts
 *
 * ===========================================================================
 * WHY THIS IS A DRIVER AND NOT MORE `verifyPursuitDriving`.
 * ===========================================================================
 *
 * `pursuit.verifyPursuitDriving` proves the arithmetic in isolation: the node
 * pick closes on a target over a synthetic graph, a tight corner caps the car
 * under a sprint, the stopping rule lands where it says, and six hundred ticks
 * run twice come out identical. It would pass unchanged if no patrol car in the
 * game had a body, if `CarField.follow` never carried one, if the record never
 * reached the wire, and if the whole thing were never called at all -- because
 * it never asks a `Simulation` anything.
 *
 * Everything below is a claim about the **whole tick**: `stepFactions` running
 * the real heat ladder, `stepCars`' four contact sweeps in their usual order,
 * `CarField.follow` reconciling the records, `publishBlockers` feeding the hold
 * ledger, and `carDelta` producing the bytes. The owner's two reports are both
 * of that shape --
 *
 *   > *"and actually chase u when u bad"*
 *   > *"also i couldnt head on collision"*
 *
 * -- and neither can be answered by a pure function.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE SECTIONS, and the failure each exists for.
 *
 *   **1. It arrives, and it stops beside you.** A suspect at four stars standing
 *      300 m down a road gets a patrol car inside sixty seconds and it comes to
 *      rest within `PURSUIT_STOP_M` of them. The failure this convicts is the
 *      one that shipped: the old `driveCars` steered at the nearest lane vertex
 *      that happened to be nearer the suspect than the bumper was, which on a
 *      road that curves away is a car that drives past you and keeps going.
 *
 *   **2. It keeps up with somebody jogging.** Sixty seconds of a suspect on
 *      foot, and the car is inside forty metres for all of it. This is the
 *      *"actually chase u"* half, and the number it protects is
 *      `PURSUIT_SPEED_MARGIN`: a car that obeyed the timetable exactly would be
 *      overtaken by a person at a jog on a shared zone.
 *
 *   **3. It gives up rather than swimming.** A suspect who sprints round two
 *      corners and then forty metres off the road -- a park, a yard, a
 *      pedestrian mall -- is somebody no lane reaches, so the car parks and the
 *      officers carry on on foot. The failure is a lane-follower that drives at
 *      the nearest kerb forever, holding a record, a blocker and a snapshot slot
 *      for a pursuit that ended.
 *
 *      Worth saying plainly, because it is the design and not a limitation:
 *      **you do not outrun a patrol car on an open road.** `PURSUIT_TOP_SPEED`
 *      is three and a half times a sprint and DESIGN.md is explicit that the
 *      player gets no speed buff. What makes the chase losable is terrain --
 *      corners it has to slow for (`verifyPursuitDriving` block 2) and ground it
 *      cannot drive on, which is this section.
 *
 *   **4. Head-on.** A driven car into a pursuing patrol car at a real closing
 *      speed: both shunted, neither inside the other after the tick, both
 *      damaged. This is *"i couldnt head on collision"* and it is the section
 *      that would still fail if the record existed but `fillCarBody` read it
 *      instead of the `PursuitCar`, or if `applyCarBody` wrote the shunt to the
 *      record for `follow` to overwrite a phase later.
 *
 *   **5. The wire.** Four patrol cars in pursuit, one second, bytes off the real
 *      `carDelta`. DESIGN.md rule 8: every proposal states its cost.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS A SYNTHETIC SUBURB, AND THAT IS DELIBERATE.
 *
 * `server/police-check.ts` loads the real 16 GB city because what it measures --
 * which officers are on which footpath at this second -- is a property of the
 * bake. Nothing here is. What this measures is a lane-follower against a lane,
 * and a lane is four hundred floats; building one here makes the driver run in
 * seconds instead of minutes, makes every number in it reproducible, and -- on
 * the week this was written -- means it does not read a `client/public/world`
 * that a retile is halfway through rewriting.
 *
 * The corners are **filleted**, and that is the one thing about the fixture that
 * had to be got right. A ninety-degree turn written as two long segments has a
 * circumscribed radius of hundreds of metres by `cornerSpeedAt`'s arithmetic --
 * a corner the car takes flat out -- because that arithmetic is measuring the
 * polyline it is given. Real baked lanes carry a vertex every few metres and
 * turn over a proper arc, so the fixture does too: `bend` lays a ten-metre
 * radius at four-metre spacing, which is a residential corner, and the car has
 * to slow for it.
 *
 * ---------------------------------------------------------------------------
 * ONE VIRTUAL CLOCK. `server/carcrash-check.ts` carries this argument in full
 * and this file makes the identical swap for the identical reason: the ambient
 * fleet and every police beat in the game are closed-form functions of
 * `trafficTick(Date.now())`, and a driver that stepped four thousand ticks in a
 * second of real time would be watching a photograph. `Date.now` is replaced at
 * the root, in this process only, and put back before it exits.
 *
 * ---------------------------------------------------------------------------
 * THE RATCHETS. The numbers printed at the end are floors and ceilings measured
 * against this fixture on the day it was written. A run that comes in better
 * should move them; a run that comes in worse is a regression, and writing them
 * down is what stops "the police feel thin" being a matter of opinion.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import type { ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { MAX_HEALTH } from '../client/src/game/combat.ts';
import { encodeCars, CAR_RECORD_BYTES } from '../client/src/net/protocol.ts';
import {
  TRAFFIC_EPOCH_MS,
  TrafficField,
  type LaneRoute,
  type LaneWay,
} from '../client/src/game/traffic.ts';
import {
  NPC_DRIVER_ID,
  SPRINT_SPEED,
  carRigidBody,
  crashDamage,
  CAR_HEALTH_MAX,
} from '../client/src/game/driving.ts';
import { createRigidBody, createRigidContact, rigidOverlap } from '../client/src/game/rigid.ts';
import { NPC_KIND, NPC_STATE, REASON, reportCrime } from '../client/src/game/factions.ts';
import { PATROL_PURSUIT_M, WITNESS_KIND, reportHeatCrime } from '../client/src/game/heat.ts';
import { PURSUIT_STOP_M, syntheticLaneRoute } from '../client/src/game/pursuit.ts';

const TICK_HZ = 60;

// --- The fixture -----------------------------------------------------------------

/**
 * How far apart the fixture's lane vertices are, metres.
 *
 * Four metres, which is the order the real bake samples at. It matters twice:
 * `cornerSpeedAt` reads curvature off consecutive vertices, and `nearestOnRoutes`
 * measures to segments -- so a fixture sampled at three hundred metres would be
 * testing a road nothing in Sydney looks like.
 */
const SAMPLE_M = 4;
/** The closing speed the head-on section is measured at, m/s. The brief's number. */
const TARGET_CLOSING = 15;
/**
 * How far two solid cars may rest inside each other, metres. A bumper.
 *
 * Not zero, and `runHeadOn`'s assertion carries the argument: `rigid.ts` leaves
 * a resolved pair `SEPARATION_SLOP` inside each other by design, and a patrol
 * car that is still in pursuit is actively pressing against the car it hit.
 */
const PENETRATION_TOLERANCE = 0.3;
/** The radius the fixture's corners are filleted at, metres. A residential corner. */
const CORNER_R = 10;

/** A straight run of vertices from a to b, at `SAMPLE_M`, excluding the last point. */
function run(ax: number, az: number, bx: number, bz: number, out: Array<[number, number]>): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  const n = Math.max(1, Math.round(len / SAMPLE_M));
  for (let i = 0; i < n; i++) out.push([ax + (dx * i) / n, az + (dz * i) / n]);
}

/**
 * A quarter-circle fillet of radius `CORNER_R` about a centre, from one bearing
 * to another. `Math.sin`/`Math.cos` are free here and only here: this is a check
 * fixture building float arrays, not a quantity two processes have to agree
 * about. See `game/pursuit.ts` section 4 for the rule this is the exception to.
 */
function bend(cx: number, cz: number, from: number, to: number, out: Array<[number, number]>): void {
  const arc = CORNER_R * Math.abs(to - from);
  const n = Math.max(2, Math.round(arc / SAMPLE_M));
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    out.push([cx + Math.cos(a) * CORNER_R, cz + Math.sin(a) * CORNER_R]);
  }
}

/**
 * The suburb: one long road north, a right turn east, and a right turn north
 * again, both filleted. Three routes meeting at coincident vertices, which is
 * what a chain joint is and what `pickOutgoing` finds a junction by.
 *
 *   A  (0, 0)      -> (0, -600)      the main road, running north
 *   B  (0, -600)   -> (300, -600)    east along the top
 *   C  (300, -600) -> (300, -900)    north again
 *
 * Route A ends with a fillet into B's start and B ends with one into C's, so the
 * two corners are real ten-metre-radius turns rather than the infinite-radius
 * kinks two straight segments would be.
 */
const JUNCTION_A: [number, number] = [0, -600];
const JUNCTION_B: [number, number] = [300, -600];

function suburbRoutes(): LaneRoute[] {
  // --- A: north up x = 0, then a quarter turn to the east.
  const a: Array<[number, number]> = [];
  run(0, 0, 0, -600 + CORNER_R, a);
  // Centre of the fillet is CORNER_R east of the lane and CORNER_R short of the
  // junction; the arc runs from due west of it round to due south of it.
  bend(CORNER_R, -600 + CORNER_R, Math.PI, Math.PI * 1.5, a);
  a.push(JUNCTION_A);

  // --- B: east along z = -600, then a quarter turn to the north.
  const b: Array<[number, number]> = [];
  run(CORNER_R, -600, 300 - CORNER_R, -600, b);
  bend(300 - CORNER_R, -600 - CORNER_R, Math.PI * 0.5, 0, b);
  b.push(JUNCTION_B);

  // --- C: north up x = 300.
  const c: Array<[number, number]> = [];
  run(300, -600 - CORNER_R, 300, -900, c);
  c.push([300, -900]);

  return [
    syntheticLaneRoute(0xa1, a, 11.1, 0),
    syntheticLaneRoute(0xb2, b, 11.1, 0),
    syntheticLaneRoute(0xc3, c, 11.1, 0),
  ];
}

function suburbWorld(): ServerWorld {
  const traffic = new TrafficField();
  const routes = suburbRoutes();
  // A `LaneWay` per route, because `TileLanes` wants one and the obstacle index
  // reads them. The centreline is the lane's own, which for a fixture with one
  // lane a road is exactly right.
  const ways: LaneWay[] = routes.map((r) => ({
    osmId: r.rid,
    klass: r.klass,
    oneway: false,
    halfWidth: 3.75,
    footpathWidth: 3,
    count: r.count,
    x: r.x,
    y: r.y,
    z: r.z,
    // v4's band block. Nothing is parked in this fixture, so the band needs no
    // inset and no cut -- see `game/traffic.LANES_VERSION`.
    bandInset: [0, 0],
    bandCuts: [new Float32Array(0), new Float32Array(0)],
  }));
  traffic.adopt('suburb', { ways, routes });
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
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

// --- Shared helpers --------------------------------------------------------------

const out: TickOutput = { tick: 0, events: [], snapshot: null };

/**
 * The virtual clock, and the one call that moves it.
 *
 * `Date.now` is replaced by a **reader** and never by something that advances
 * itself, which is worth the sentence because the first cut of this file did the
 * latter and it was silently wrong: `server/sim.ts` calls `trafficTick(Date.now())`
 * a couple of dozen times inside one `step`, so a clock that ticked on every read
 * ran the ambient fleet, the beats and the pursuit's own repick timer a full
 * second forward inside a single 16.7 ms tick. Nothing threw; the pursuit simply
 * re-picked its lane on every call and the check reported a car that never
 * arrived. See `server/carcrash-check.ts`, which gets this right and is where the
 * shape below comes from.
 */
let clockMs = 0;

/**
 * Where every section starts its clock: **a fixed instant**, and not the one the
 * command was typed at.
 *
 * `server/police-check.ts` prints the tick it started on and sets its ratchets
 * wide enough to cover the spread, because what it measures is genuinely a
 * property of the wall clock -- which officers are on which footpath right now.
 * Nothing here is. Every input to this driver is the fixture plus the seed, and
 * the seed is `carHash(playerId, tick)` inside `heat.spawnPatrolCar` -- so a
 * start taken from `Date.now()` puts the patrol car in a different place on
 * every run and the ratchets become a range rather than a number. Two
 * consecutive runs of the first cut of this file reported 39.6 m and "never got
 * within forty" for the same section.
 *
 * Midday on the traffic epoch, which is a real second of a real timetable and is
 * the same one every time.
 */
const START_MS = TRAFFIC_EPOCH_MS + 12 * 3600 * 1000;

/** Rewind to `START_MS`. Called at the top of every section. */
function resetClock(): void {
  clockMs = START_MS;
}

/** One tick of the world, with the clock moved once. */
function step(sim: Simulation): void {
  clockMs += 1000 / TICK_HZ;
  sim.step(out);
}

/** Put a body somewhere, on the ground, looking a way. `police-check.place`. */
function place(p: Participant, sim: Simulation, x: number, z: number, yaw: number): void {
  p.combat.body.position.set(x, EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = yaw;
  p.combat.body.pitch = 0;
  p.input.yaw = yaw;
  p.input.pitch = 0;
  p.input.forward = 0;
  p.input.right = 0;
  p.input.sprint = false;
  p.input.punch = false;
  p.history.seed(sim.tick, x, p.combat.body.position.y, z, yaw);
}

/**
 * Hold a player at a star count, and open the investigation that goes with it.
 *
 * **`factions.reportCrime` and nothing else**, which is the fix for a mistake
 * this file made twice. `reportHeatCrime` feeds the ladder directly and opens no
 * countdown, so a check that used it had five-star suspects with no investigation
 * -- no constables, no RBT officers, and nothing for a stopped patrol car to put
 * out. And re-reporting on a timer *accumulates*: 380 points every two seconds
 * against `HEAT_POINTS_CAP`'s 1,400 puts every subject of this driver at five
 * stars within eight, which is Polair, a marksman, an RBT and a room full of
 * actors -- and a suspect being shot out of the air halfway through a
 * measurement of whether a car can keep up with a jog.
 *
 * `reportCrime` does both jobs and is the door the game itself uses:
 * `FactionField.step` drains it, opens the countdown, and `accuse` feeds the
 * ladder through `onCrime`. So this tops the ladder up only when it has sagged
 * below the rung under test, which is what a suspect who keeps offending looks
 * like and is self-regulating against the decay.
 *
 * Three stars is the patrol car's own rung and is what sections 2, 3 and 5 hold;
 * section 1 uses four because the brief's scenario says four.
 */
function hold(sim: Simulation, p: Participant, stars: number): void {
  // --- **The pips, pinned.** Not a convenience: without it these sections
  //     measure a gunfight.
  //
  // An investigation puts armed constables on the ground the moment the ladder
  // passes `factions.POLICE_ARMED_STARS`, and six of them shooting at a suspect
  // who is jogging in a straight line put them down inside a couple of seconds.
  // A knockout wipes the ladder (`sim.heat.reset` on the KO), which despawns the
  // patrol car -- so the first cut of section 2 reported "the pursuit stood down
  // after 1.3 s of a jog" about a pursuit that had *won*. What is under test here
  // is whether a car can follow somebody on foot, and `server/police-check.ts`
  // already measures whether officers can shoot them.
  p.combat.health = MAX_HEALTH;
  if (sim.heat.starsOf(p.id) >= stars) return;
  // --- **The first top-up opens the investigation; the rest are small.**
  //
  // `REASON.MURDER_POLICE` is 380 points, which takes a clean player straight to
  // three stars and is exactly what is wanted once. Repeating it is not: a
  // player who has sagged to 379 points and is given another 380 lands on 759,
  // which is *four* stars -- so a driver trying to hold a subject at the patrol
  // car's rung quietly gave them an RBT as well, and in this fixture the
  // roadblock was planted in the middle of the road their own patrol car was
  // driving down. The pursuit queued behind it, correctly and forever, and the
  // section reported 245 m of failure to keep up.
  //
  // So the top-ups after the first are `REASON.ASSAULT`'s 130, which cannot
  // carry three stars over into four (380 + 130 = 510 against `STAR_POINTS`'
  // 620), and they go through `reportHeatCrime` because the countdown is already
  // open and re-opening it is not what is wanted.
  if (sim.heat.starsOf(p.id) === 0) reportCrime(p.id, REASON.MURDER_POLICE);
  else reportHeatCrime(p.id, REASON.ASSAULT, WITNESS_KIND.POLICE);
}

/**
 * Keep the **countdown** alive without moving the ladder.
 *
 * The two clocks come apart, and `heat.escalate` says so in as many words: the
 * five-star shed is 150 s against `factions.MAX_COUNTDOWN_TICKS`' 120, so a
 * wanted player with no live investigation is an ordinary state. It is also a
 * state with **no constables in it**, and the two officers a patrol car puts out
 * when it stops or gives up are gated on exactly that -- so a section that ran
 * for a minute on one opening crime measured a car giving up correctly and
 * nobody getting out of it.
 *
 * `REASON.ASSAULT` rather than `MURDER_POLICE` because this is called on a
 * player who is already at the rung under test: 130 points on top of three
 * stars' 380 is 510, which is still three stars, where another 380 would be four
 * and would plant an RBT in the road.
 */
function keepInvestigating(sim: Simulation, id: number): void {
  if (sim.factions.investigationOf(id) !== undefined) return;
  reportCrime(id, REASON.ASSAULT);
}

/** The patrol car actor chasing this player, or null. */
function patrolOf(sim: Simulation, target: number): { x: number; z: number; state: number; id: number } | null {
  for (const a of sim.factions.actors) {
    if (a.kind !== NPC_KIND.HIGHWAY_PATROL) continue;
    if (a.target !== target) continue;
    return { x: a.x, z: a.z, state: a.state, id: a.id };
  }
  return null;
}

/** And its `DrivenCar` record, which is the half this whole round added. */
function patrolRecord(sim: Simulation): { id: number; x: number; z: number; speed: number; health: number } | null {
  for (const c of sim.cars.all()) {
    if (c.driverId !== NPC_DRIVER_ID) continue;
    return { id: c.id, x: c.x, z: c.z, speed: c.speed, health: c.health };
  }
  return null;
}

function rangeTo(p: Participant, x: number, z: number): number {
  const dx = p.combat.body.position.x - x;
  const dz = p.combat.body.position.z - z;
  return Math.sqrt(dx * dx + dz * dz);
}

interface Section {
  failures: string[];
}

// --- 1. It arrives, and it stops beside you ---------------------------------------

function runArrival(): Section & { arriveS: number; stopRange: number } {
  const failures: string[] = [];
  resetClock();
  const sim = new Simulation(suburbWorld());
  const suspect = sim.join(0, null, 'Bazza');
  place(suspect, sim, 0, -300, 0);

  let arriveS = Infinity;
  let stopRange = Infinity;
  let seen = false;
  for (let tick = 0; tick < 60 * 90; tick++) {
    hold(sim, suspect, 4);
    step(sim);
    const car = patrolOf(sim, suspect.id);
    if (car === null) continue;
    if (!seen) seen = true;
    const range = rangeTo(suspect, car.x, car.z);
    const record = patrolRecord(sim);
    // "Arrived" is the car at rest beside them, not merely in the same
    // postcode: the officers' door is what the rung is for.
    if (record !== null && Math.abs(record.speed) < 0.6 && range <= PURSUIT_STOP_M + 2) {
      arriveS = tick / 60;
      stopRange = range;
      break;
    }
  }
  if (!seen) {
    failures.push('No patrol car was ever promoted against a four-star suspect standing on a road.');
  } else if (!Number.isFinite(arriveS)) {
    failures.push(
      'A patrol car was promoted but never came to rest beside a stationary four-star suspect ' +
        '300 m down a straight road, in ninety seconds.',
    );
  } else {
    if (arriveS > 60) {
      failures.push(`The patrol car took ${arriveS.toFixed(1)} s to arrive; the brief's number is sixty.`);
    }
    if (stopRange > PURSUIT_STOP_M) {
      failures.push(
        `It stopped ${stopRange.toFixed(1)} m away against a ${PURSUIT_STOP_M} m rule. Its officers get ` +
          'out too far off to be a pursuit.',
      );
    }
    if (stopRange < 2) {
      failures.push(`It stopped ${stopRange.toFixed(1)} m away, which is on top of the suspect.`);
    }
  }
  console.log(
    `  1. arrival: a car reached a standing four-star suspect in ${Number.isFinite(arriveS) ? arriveS.toFixed(1) : 'never'} s ` +
      `and came to rest ${Number.isFinite(stopRange) ? stopRange.toFixed(1) : '-'} m off them ` +
      `(the rule is ${PURSUIT_STOP_M} m).`,
  );
  return { failures, arriveS, stopRange };
}

// --- 2. It keeps up with somebody jogging -----------------------------------------

function runJog(): Section & { worst: number; jogSpeed: number } {
  const failures: string[] = [];
  resetClock();
  const sim = new Simulation(suburbWorld());
  const suspect = sim.join(0, null, 'Bazza');
  place(suspect, sim, 0, -80, 0);

  // Let the car arrive first, then start jogging: the question is whether it
  // *keeps up*, and measuring the approach as well would report the spawn
  // distance as a failure to follow.
  let started = false;
  let worst = 0;
  let held = 0;
  let travelled = 0;
  let lastZ = suspect.combat.body.position.z;
  for (let tick = 0; tick < 60 * 150; tick++) {
    // **Three stars, not four.** The patrol car is the three-star rung; four
    // adds Polair, whose marksman puts rounds into the suspect on a schedule,
    // and a check whose subject is knocked out and respawned halfway through is
    // measuring a respawn. See `heat.ts` section 4.
    hold(sim, suspect, 3);
    const car = patrolOf(sim, suspect.id);
    if (car !== null && !started && rangeTo(suspect, car.x, car.z) < 40) {
      started = true;
      // North, on foot, no sprint: a jog.
      suspect.input.forward = 1;
      suspect.input.sprint = false;
      suspect.input.yaw = 0;
      suspect.combat.body.yaw = 0;
    }
    step(sim);
    if (!started) continue;
    travelled += Math.abs(suspect.combat.body.position.z - lastZ);
    lastZ = suspect.combat.body.position.z;
    const after = patrolOf(sim, suspect.id);
    if (after === null) {
      failures.push(`The pursuit stood down after ${(held / 60).toFixed(1)} s of a jog. It is meant to keep up.`);
      break;
    }
    const range = rangeTo(suspect, after.x, after.z);
    if (range > worst) worst = range;
    held++;
    if (held >= 60 * 60) break;
  }
  const jogSpeed = travelled / Math.max(1, held / 60);
  if (!started) {
    failures.push('The patrol car never got within forty metres, so there was nothing to measure keeping up against.');
  } else if (held < 60 * 60) {
    failures.push(`Only ${(held / 60).toFixed(1)} s of the sixty were held.`);
  } else if (worst > 40) {
    failures.push(
      `A suspect jogging at ${jogSpeed.toFixed(1)} m/s opened ${worst.toFixed(1)} m on the patrol car ` +
        'inside a minute. The pursuit does not keep up.',
    );
  }
  console.log(
    `  2. the jog: sixty seconds at ${jogSpeed.toFixed(1)} m/s on foot, and the car was never further than ` +
      `${worst.toFixed(1)} m (the rule is 40).`,
  );
  return { failures, worst, jogSpeed };
}

// --- 3. It gives up rather than swimming ------------------------------------------

function runLost(): Section & { parkedS: number; footOfficers: number } {
  const failures: string[] = [];
  resetClock();
  const sim = new Simulation(suburbWorld());
  const suspect = sim.join(0, null, 'Bazza');
  place(suspect, sim, 0, -560, 0);

  // The route on foot: north to the first corner, east to the second, north
  // again, and then **off the road** -- eighty metres due east into open ground
  // no lane reaches. Two corners, and then the terrain.
  const legs: Array<{ x: number; z: number; yaw: number }> = [
    { x: JUNCTION_A[0], z: JUNCTION_A[1], yaw: 0 },
    { x: JUNCTION_B[0], z: JUNCTION_B[1], yaw: -Math.PI / 2 },
    { x: 300, z: -760, yaw: 0 },
    { x: 420, z: -760, yaw: -Math.PI / 2 },
  ];
  let leg = 0;
  let parkedS = Infinity;
  let footOfficers = 0;
  let sawCar = false;
  for (let tick = 0; tick < 60 * 180; tick++) {
    // Three stars, on section 2's argument: the rung under test is the car.
    hold(sim, suspect, 3);
    // ...and a live countdown all the way through, so there are constables for
    // the car to put out when it gives up. See `keepInvestigating`.
    keepInvestigating(sim, suspect.id);
    // Steer to the next waypoint on the flight path, at a sprint.
    const px = suspect.combat.body.position.x;
    const pz = suspect.combat.body.position.z;
    const want = legs[Math.min(leg, legs.length - 1)];
    if (Math.sqrt((want.x - px) ** 2 + (want.z - pz) ** 2) < 6 && leg < legs.length - 1) leg++;
    suspect.input.yaw = legs[Math.min(leg, legs.length - 1)].yaw;
    suspect.combat.body.yaw = suspect.input.yaw;
    suspect.input.forward = 1;
    suspect.input.sprint = true;
    step(sim);

    const car = patrolOf(sim, suspect.id);
    if (car !== null) sawCar = true;
    const record = patrolRecord(sim);
    // Off the graph and standing still: the car has parked. Only counted once
    // the suspect has actually left the road, or a car that has not started yet
    // reads as one that gave up.
    if (leg >= legs.length - 1 && record !== null && Math.abs(record.speed) < 0.2) {
      parkedS = tick / 60;
      for (const a of sim.factions.actors) {
        if (a.kind === NPC_KIND.POLICE && a.target === suspect.id && a.state !== NPC_STATE.DOWN) footOfficers++;
      }
      break;
    }
    // Or it stood down outright on `PATROL_PURSUIT_M`, which is the same
    // outcome by a different door and is equally correct.
    if (sawCar && car === null && leg >= legs.length - 1) {
      parkedS = tick / 60;
      for (const a of sim.factions.actors) {
        if (a.kind === NPC_KIND.POLICE && a.target === suspect.id && a.state !== NPC_STATE.DOWN) footOfficers++;
      }
      break;
    }
  }
  if (footOfficers === 0 && Number.isFinite(parkedS)) {
    failures.push(
      'The patrol car gave up and put nobody out. The brief\'s clause is "the car parks and the ' +
        'officers pursue on foot"; see heat.driveCars, whose disgorge is gated on a live investigation.',
    );
  }
  if (!sawCar) {
    failures.push('No patrol car was promoted, so there was nothing to lose.');
  } else if (!Number.isFinite(parkedS)) {
    failures.push(
      'A suspect who sprinted round two corners and eighty metres off the road never lost the patrol car. ' +
        'The off-graph rule (pursuit.PURSUIT_SUSPECT_LANE_M) did not fire and the car is driving over ' +
        'ground it has no lane for.',
    );
  }
  console.log(
    `  3. lost: a sprint round two corners and off the road parked the car after ${
      Number.isFinite(parkedS) ? parkedS.toFixed(1) : 'never'
    } s, with ${footOfficers} officer(s) still on foot ` +
      `(the pursuit range is ${PATROL_PURSUIT_M} m).`,
  );
  return { failures, parkedS, footOfficers };
}

// --- 4. Head-on ------------------------------------------------------------------

function runHeadOn(): Section & { closing: number; overlapAfter: number; damagePlayer: number; damagePatrol: number } {
  const failures: string[] = [];
  resetClock();
  const sim = new Simulation(suburbWorld());
  const suspect = sim.join(0, null, 'Bazza');
  // Facing **south** (+Z, yaw pi) at the top of the main road, so the patrol car
  // spawned 140 m up the lane in front of them is met nose to nose.
  place(suspect, sim, 0, -300, Math.PI);
  const mine = sim.cars.take(
    { identity: 0xc0ffee, body: 0, colour: 0, x: 0, y: 0, z: -300, yaw: Math.PI, parked: true },
    suspect.combat.id,
  )!;
  suspect.combat.drivingCar = mine.id;

  const bodyA = createRigidBody();
  const bodyB = createRigidBody();
  const contact = createRigidContact();

  let closing = 0;
  let overlapAfter = 0;
  let damagePlayer = 0;
  let damagePatrol = 0;
  let hit = false;
  let lastGap = Infinity;
  // --- **The speeds from before the impact, not from the tick it was charged
  //     on**, which is the one thing this section had to be taught.
  //
  // The two are not the same tick. `combat.advance` moves a driver and its clamp
  // detector stops them dead against whatever they hit, banking the delta-v on
  // the combatant; `stepCars` drains that on the **next** tick and charges the
  // damage. So a check that read the driver's speed on the tick the health byte
  // moved read it after the crash had already taken it -- and reported a
  // thirty-metre-a-second head-on as "the contact charged damage and moved
  // nothing". What is wanted is the speed the tick before they touched, so the
  // pair is sampled continuously while the gap is closing.
  let approachSpeed = 0;
  let approachPatrol = 0;

  for (let tick = 0; tick < 60 * 120 && !hit; tick++) {
    // --- The ladder without the investigation, which is the one place in this
    //     file that wants `reportHeatCrime` rather than `hold`.
    //
    // A patrol car needs three stars and nothing else (`heat.escalate`); the
    // constables need a live countdown. Opening one here puts armed officers
    // round a stationary car and holds its driver in a permanent flinch -- and a
    // driver who is flinching does not touch the throttle, so an earlier cut of
    // this section measured a head-on into a car nobody was driving.
    if (sim.heat.starsOf(suspect.id) < 3) {
      reportHeatCrime(suspect.id, REASON.MURDER_POLICE, WITNESS_KIND.POLICE);
    }
    suspect.combat.health = MAX_HEALTH;
    const record = patrolRecord(sim);
    // Drive at it once there is something to drive at, and stand still until
    // then so the spawn lands in front rather than behind.
    if (record !== null) {
      const dx = record.x - suspect.combat.body.position.x;
      const dz = record.z - suspect.combat.body.position.z;
      const gap = Math.sqrt(dx * dx + dz * dz);
      // Yaw 0 faces -Z. Point the nose at the patrol car and floor it.
      suspect.combat.body.yaw = Math.atan2(-dx, -dz);
      suspect.input.yaw = suspect.combat.body.yaw;
      suspect.input.forward = 1;
      // Sampled every tick while they are still apart, so what survives into the
      // assertion is the pair as they were on the last tick before contact.
      // --- The player cruises rather than flooring it, so the impact lands at
      //     roughly the brief's fifteen metres a second of closing.
      //
      // The throttle is held off the **player's own speed** and not off the
      // closing rate, and the first cut got that wrong in a way worth writing
      // down: gating on the closing rate takes the throttle off early, the
      // player coasts, the patrol car's follow law (`pursuit.PURSUIT_TAIL_M`)
      // then brakes to hold two metres off them -- and the two politely come to
      // a stop nose to nose with no contact at all. A police car does not ram
      // you; the head-on is a thing the *player* does, so the player is the one
      // whose speed decides it.
      //
      // Flat out this fixture reaches thirty-two, which with the patrol car's
      // fourteen saturates `crashDamage` at its 7 hp cap and would measure the
      // clamp rather than the curve.
      if (Math.abs(suspect.combat.carSpeed) >= TARGET_CLOSING * 0.75) suspect.input.forward = 0;
      if (gap > 5.5) {
        approachSpeed = suspect.combat.carSpeed;
        approachPatrol = record.speed;
        closing = Math.abs(approachSpeed) + Math.abs(approachPatrol);
      }
      lastGap = gap;
    }
    const beforePlayer = sim.cars.get(mine.id)?.health ?? CAR_HEALTH_MAX;
    const beforePatrol = record === null ? CAR_HEALTH_MAX : record.health;

    step(sim);

    const after = patrolRecord(sim);
    if (after === null || record === null) continue;
    const nowPlayer = sim.cars.get(mine.id)?.health ?? CAR_HEALTH_MAX;
    if (nowPlayer < beforePlayer || after.health < beforePatrol) {
      hit = true;
      damagePlayer = beforePlayer - nowPlayer;
      damagePatrol = beforePatrol - after.health;
      // **Shunted**: both bodies had their velocity taken off them by the
      // contact. `applyCarBody` writes it onto the combatant for a human driver
      // and onto the `PursuitCar` for the authority, and those two lines are the
      // whole of what this round added to `sim.ts`; if either were missing the
      // corresponding body would sail on through at its approach speed.
      if (Math.abs(suspect.combat.carSpeed) > Math.abs(approachSpeed) - 1) {
        failures.push(
          `A head-on at ${closing.toFixed(1)} m/s left the driver doing ` +
            `${suspect.combat.carSpeed.toFixed(2)} against an approach of ${approachSpeed.toFixed(2)}. ` +
            'The contact charged damage and took nothing off the car.',
        );
      }
      if (Math.abs(after.speed) > Math.abs(approachPatrol) - 1) {
        failures.push(
          `The patrol car came out of the head-on doing ${after.speed.toFixed(2)} against an approach of ` +
            `${approachPatrol.toFixed(2)}. The shunt is not reaching pursuit.PursuitCar -- see sim.applyCarBody.`,
        );
      }
      // --- ...and they are not inside each other **once the throttle is off**.
      //
      // Off, and then ten ticks, and the two together are the honest question. A
      // driver who is still flooring it into the car they hit is *supposed* to be
      // a few centimetres inside it -- that is what pushing against something
      // is, and `rigid.ts` leaves a resolved pair `SEPARATION_SLOP` inside each
      // other on purpose besides. What must not happen is a pair that stays
      // interpenetrated with nothing driving them together, which is the failure
      // that reads on screen as one car swallowing another.
      suspect.input.forward = 0;
      for (let n = 0; n < 10; n++) {
        suspect.input.forward = 0;
        step(sim);
      }
      const c = sim.cars.get(mine.id);
      const q = patrolRecord(sim);
      if (c !== undefined && q !== null) {
        carRigidBody(
          {
            body: c.body,
            x: suspect.combat.body.position.x,
            z: suspect.combat.body.position.z,
            yaw: suspect.combat.body.yaw,
            speed: suspect.combat.carSpeed,
            slip: suspect.combat.carSlip,
            yawRate: suspect.combat.carYawRate,
          },
          bodyA,
        );
        carRigidBody(sim.cars.get(q.id)!, bodyB);
        if (rigidOverlap(bodyA, bodyB, contact)) overlapAfter = contact.depth;
      }
    }
  }

  if (!hit) {
    failures.push(
      `A car driven head-on into a pursuing patrol car never registered a contact (closest ${lastGap.toFixed(1)} m). ` +
        'This is the owner\'s "i couldnt head on collision" still true.',
    );
  } else {
    if (damagePlayer <= 0) failures.push('The player\'s car took no damage from a head-on with a patrol car.');
    if (damagePatrol <= 0) failures.push('The patrol car took no damage from a head-on. Both cars pay; that is the sweep\'s rule.');
    // --- **Touching, not interpenetrated**, and the tolerance is the interesting
    //     part of this assertion rather than a fudge.
    //
    // `rigid.ts` leaves a resolved pair `SEPARATION_SLOP` inside each other on
    // purpose, and the pair here is not merely resting: the patrol car is still
    // in pursuit and its follow law holds two metres to the *suspect*, whose
    // body is in the middle of the car it is pressing against. So a live
    // pursuit against a stopped car settles with its bumper a few centimetres
    // in, which is what pressing against something looks like and is nothing a
    // player would see. What must never happen -- and what the owner reported --
    // is one car inside another, which at these box sizes is metres.
    // `PENETRATION_TOLERANCE` is a bumper.
    if (overlapAfter > PENETRATION_TOLERANCE) {
      failures.push(
        `The two cars were still ${overlapAfter.toFixed(3)} m inside each other ten ticks after the ` +
          `impact with the throttle off, against a ${PENETRATION_TOLERANCE} m tolerance. They are ` +
          'passing through each other rather than touching.',
      );
    }
    if (closing < TARGET_CLOSING * 0.8) {
      failures.push(
        `The measured closing speed was only ${closing.toFixed(1)} m/s against a target of ` +
          `${TARGET_CLOSING}; the section is written for a real head-on.`,
      );
    }
  }
  console.log(
    `  4. head-on: ${closing.toFixed(1)} m/s closing cost the player's car ${damagePlayer.toFixed(1)} hp and the ` +
      `patrol car ${damagePatrol.toFixed(1)} hp, with ${overlapAfter.toFixed(3)} m of overlap left after the tick ` +
      `(the curve is driving.crashDamage: ${crashDamage(closing).toFixed(1)} hp at this speed).`,
  );
  return { failures, closing, overlapAfter, damagePlayer, damagePatrol };
}

// --- 5. The wire -----------------------------------------------------------------

/**
 * Four patrol cars in pursuit, one second, bytes off the real `carDelta`.
 *
 * Four is the interesting number rather than an arbitrary one:
 * `heat.PATROL_CARS_PER_SUSPECT` is one, so four cars means four suspects at
 * three stars at once, which is a quarter of a full room in trouble
 * simultaneously. `room.sendCars` is room-global and not interest filtered --
 * see its header for why suppression has to be world-wide -- so bytes on the
 * wire and bytes per player are the same number.
 */
function runWire(): Section & { bytes: number; cars: number } {
  const failures: string[] = [];
  resetClock();
  const sim = new Simulation(suburbWorld());
  const suspects: Participant[] = [];
  // **On four different streets**, and the reason is that the first cut of this
  // section put them a hundred metres apart on one road and measured 78 kbit/s.
  // Four patrol cars nose to tail in one lane spend their whole lives inside
  // each other, and `sim.resolveCarContacts` broadcasts both records of every
  // contact every tick as a `CAR_SHUNT` -- so what was being measured was a
  // four-car pile-up and not a pursuit. The pile-up is a real cost and it is a
  // *contact's* cost, which `carcrash-check` already prices; the number this
  // section is for is the **broadcast**.
  const starts: Array<[number, number, number]> = [
    [0, -120, 0],
    [0, -420, 0],
    [140, -600, -Math.PI / 2],
    [300, -820, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const p = sim.join(0, null, `susp${i}`);
    place(p, sim, starts[i][0], starts[i][1], starts[i][2]);
    suspects.push(p);
  }
  // Wind the pursuit up until four cars are actually driving, then measure.
  let cars = 0;
  for (let tick = 0; tick < 60 * 40; tick++) {
    for (const p of suspects) hold(sim, p, 3);
    // Keep them moving so the cars are moving: a stationary pursuit is the
    // cheap case and measuring it would flatter the number. Each keeps the
    // heading they were placed on, so they stay on their own street.
    for (const p of suspects) {
      p.input.forward = 1;
      p.input.sprint = true;
    }
    step(sim);
    sim.carDelta();
    cars = 0;
    // Patrol **actors**, not sentinel-driven records: an RBT's car carries the
    // same driver (`pursuit.PursuitCar.anchored`) and standing across a road is
    // not a pursuit. Counting records would report six for four chases.
    for (const a of sim.factions.actors) if (a.kind === NPC_KIND.HIGHWAY_PATROL) cars++;
    if (cars >= 4 && tick > 60 * 8) break;
  }

  let bytes = 0;
  for (let tick = 0; tick < TICK_HZ; tick++) {
    for (const p of suspects) hold(sim, p, 3);
    for (const p of suspects) {
      p.input.forward = 1;
      p.input.sprint = true;
    }
    step(sim);
    const delta = sim.carDelta();
    if (delta.length > 0) bytes += encodeCars(delta).byteLength;
  }

  const kbits = (bytes * 8) / 1000;
  console.log(
    `  5. the wire: ${cars} patrol car(s) in pursuit for one second cost ${bytes} B ` +
      `(${kbits.toFixed(1)} kbit/s per player) at ${CAR_RECORD_BYTES} B a record on the loose cadence. ` +
      `PERFORMANCE.md sizes a player's downlink at 130-200 kbit/s, so this is ` +
      `${((kbits / 130) * 100).toFixed(1)}% of the tighter end.`,
  );
  if (cars < 4) {
    failures.push(`Only ${cars} patrol cars were ever in pursuit at once; the wire number is measured against four.`);
  }
  // The same ceiling `carcrash-check` holds the wreck broadcast to, and for its
  // reason: a quarter of the tighter end of the measured downlink is the most a
  // single mechanic may take. See PERFORMANCE.md and DESIGN.md rule 8.
  if (kbits > 130 * 0.25) {
    failures.push(
      `Four patrol cars cost ${kbits.toFixed(1)} kbit/s a player, over a quarter of the 130 kbit/s ` +
        'PERFORMANCE.md sizes the tighter end of a downlink at.',
    );
  }
  return { failures, bytes, cars };
}

// --- The run ---------------------------------------------------------------------

function main(): void {
  console.log('--- the patrol car drives, and is a car: through the real Simulation on a synthetic suburb\n');
  const realNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => clockMs;

  const failures: string[] = [];
  const arrival = runArrival();
  failures.push(...arrival.failures);
  const jog = runJog();
  failures.push(...jog.failures);
  const lost = runLost();
  failures.push(...lost.failures);
  const head = runHeadOn();
  failures.push(...head.failures);
  const wire = runWire();
  failures.push(...wire.failures);

  (Date as unknown as { now: () => number }).now = realNow;

  console.log('\n  ratchet (none of these may get worse):');
  console.log(`    seconds to arrive beside a standing suspect       ${arrival.arriveS.toFixed(1)}  (lower is better)`);
  console.log(`    metres it stopped short                          ${arrival.stopRange.toFixed(1)}  (<= ${PURSUIT_STOP_M})`);
  console.log(`    worst gap over a minute of jogging, m            ${jog.worst.toFixed(1)}  (<= 40)`);
  console.log(`    seconds to give up off the graph                 ${lost.parkedS.toFixed(1)}`);
  console.log(`    officers on foot once it gave up                 ${lost.footOfficers}  (>= 1)`);
  console.log(`    head-on closing speed, m/s                       ${head.closing.toFixed(1)}`);
  console.log(`    damage to the player's car, hp                   ${head.damagePlayer.toFixed(1)}  (higher is better)`);
  console.log(`    damage to the patrol car, hp                     ${head.damagePatrol.toFixed(1)}  (higher is better)`);
  console.log(`    overlap left after the tick, m                   ${head.overlapAfter.toFixed(3)}  (0)`);
  console.log(`    bytes a second at four cars                      ${wire.bytes}  (lower is better)`);
  console.log(`    sprint speed the design is written against, m/s  ${SPRINT_SPEED}`);

  if (failures.length > 0) {
    console.log('');
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n  all clear');
  }
}

main();
