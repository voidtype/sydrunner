/**
 * The police, as a player actually meets them: hittable, and coming for you.
 *
 *     bun run server/police-check.ts
 *     SYDNEY_POLICE_ONLY=chase bun run server/police-check.ts
 *
 * ===========================================================================
 * WHY THIS IS A DRIVER AND NOT MORE `verifyPolice`.
 * ===========================================================================
 *
 * `factions.verifyPolice` proves the arithmetic in isolation and would still
 * pass if no officer in the city could be touched: it never poses a beat, never
 * runs a swing, and never asks a `Simulation` anything. `integration-check`'s
 * `checkPolice` proves the *crime* path -- a bat lands on a bystander, an
 * officer sees it, an investigation opens, somebody fires. Neither of them ever
 * asked the two questions the owner did:
 *
 *   > *"also i cant run over police"*
 *   > *"make it so polICE are hitable like normal players"*
 *   > *"and actually chase u when u bad"*
 *
 * Both are claims about the whole tick over the real city -- the ambient tier
 * posed off the real bands, the swing adjudicated by the real `resolveStrike`,
 * the car swept by the real `stepCars`, the pursuit run by the real
 * `FactionField.step` with the real heat ladder installed -- and neither can be
 * answered by a pure function or by a check that only ever hits a *promoted*
 * officer, which is the tier that was never broken.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SECTIONS, and the failure each exists for.
 *
 *   **a. The bat.** An officer on a beat is promoted by the hit and takes the
 *      damage, and goes down on the same number of swings a player does. The
 *      failure it convicts is the one that shipped: `npcHitTest` walks
 *      `FactionField.actors` and nothing else, so the only officers in Sydney a
 *      player could touch were the ones already chasing them, and every constable
 *      you met before you had done anything was scenery. Nothing threw. The bat
 *      simply passed through.
 *
 *   **b. The car.** A car at `CAR_SPEED` through an officer knocks them down and
 *      is worth `MURDER_POLICE`'s 380 points. `stepCars`' knockdown sweep walked
 *      players and then the crowd and had never heard of a faction actor, so a
 *      Camry driven at a constable at 60 km/h went through them and the
 *      constable kept strolling.
 *
 *   **c. The chase table.** Nine scenarios -- one, two and three stars against a
 *      suspect standing still, walking and sprinting -- printed as officers
 *      promoted in ten seconds, closest approach over thirty, and whether a round
 *      landed. It is a *table* rather than a pass/fail because the shape of it is
 *      the design: the rungs have to differ, the motions have to differ, and a
 *      pursuit that reads identically at one star and at three is a five-rung
 *      ladder with four decorations on it.
 *
 *   **d. The ladder.** Each of the three ways to hurt an officer moves the heat
 *      the amount `game/heat.CRIME_POINTS` says it does, measured through the
 *      real `HeatField` rather than by reading the table back.
 *
 * ---------------------------------------------------------------------------
 * THE RATCHETS. Every number in `BUDGET` below is a floor or a ceiling measured
 * against the built world on the day it was written, not a target chosen to
 * pass. A run that comes in *better* than one should move it; a run that comes
 * in worse is a regression, and the point of writing them down is that "the
 * police feel thin" is otherwise a matter of opinion.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT DETERMINISTIC HERE, said plainly. Beats and patrols are pure
 * functions of `traffic.trafficTick(Date.now())`, so *which* officers this run
 * meets depends on the wall clock -- that is the whole of `POLICE_SLOT_BASE`'s
 * zero-wire trick and it is not something a driver can pin without pinning the
 * clock for the sim as well. The tick each run started at is printed, and the
 * ratchets are set with that spread in mind: they are the worst of a sweep of
 * runs rather than the best of one.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import { groundFor, loadWorld } from './world.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { MAX_HEALTH } from '../client/src/game/combat.ts';
import { trafficTick } from '../client/src/game/traffic.ts';
import { createPedPose, type PedBand } from '../client/src/game/pedestrians.ts';
import {
  CHASE_SPEED,
  ENGAGE_RANGE,
  MAX_ACTORS,
  NPC_KIND,
  NPC_STATE,
  POLICE_ARMED_STARS,
  POLICE_MAX_HEALTH,
  PROMOTE_RADIUS,
  PURSUIT_LEASH_M,
  PURSUIT_SURGE_STARS,
  PURSUIT_TARGET,
  PURSUIT_TARGET_HIGH,
  REASON,
  createBeatPose,
  forEachPoliceNear,
  pursuitTargetFor,
} from '../client/src/game/factions.ts';
import { CRIME_POINTS, STAR_POINTS } from '../client/src/game/heat.ts';

const failures: string[] = [];
const say = (s: string): void => console.log(s);
const check = (ok: boolean, what: string): void => {
  say(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

/**
 * The ratchets, all of them, in one table so a future round can see what this
 * round measured without reading the code around them.
 *
 * Each is annotated with the run it was set from. The rule is the one
 * `server/clash-check.ts` states: a ratchet sits at the defect, not at the
 * aspiration, so beating one is a reason to lower it and never a reason to
 * leave it.
 */
const BUDGET = {
  /**
   * Swings a bat needs to put an officer down. **Exactly** the number a player
   * needs, which is the whole of *"hitable like normal players"*:
   * `MAX_HEALTH` pips at one pip a swing, and `POLICE_MAX_HEALTH` is the same
   * three. A check that only asserted "goes down eventually" would pass on an
   * officer with thirty pips.
   */
  batSwings: POLICE_MAX_HEALTH,
  /**
   * How fast the car is driven through the officer, m/s. The brief's number,
   * and comfortably over `driving.RUN_DOWN_SPEED`'s 4 and
   * `traffic.CAR_HIT_FULL_SPEED`'s 8 -- so this is a car at a road speed rather
   * than one creeping out of a bay, and `carHitStrength` is exactly 1.
   */
  carSpeed: 12,
  /**
   * Officers who must be on a **walking** suspect within ten seconds, at every
   * rung. The floor rather than the target: `PURSUIT_TARGET` is four and the
   * lattice does not guarantee four officers on any particular corner of the
   * CBD, so this asks that the response is a *pursuit* and not a single
   * constable who happened to be looking.
   */
  pursuersWalking: 2,
  /**
   * And on a **sprinting** one, over thirty seconds. Distinct officers, so a
   * handoff counts: the point of the surge and the leash together is that a
   * suspect who outruns the pair that saw them meets somebody new.
   */
  pursuersSprintingAt3: 4,
  /**
   * How close an officer gets to a suspect who is walking away, metres. Inside
   * `ENGAGE_RANGE`, which is the constraint stated as arithmetic: an officer
   * who cannot reach shooting range on a walker is an officer a player never
   * has to think about.
   */
  closestWalking: ENGAGE_RANGE,
  /**
   * Rounds fired at a **walking** suspect at an armed rung, over thirty seconds.
   *
   * **One, and the floor is deliberately at the defect.** Before
   * `factions.ENGAGE_HOLD_M` this column read *zero* at two stars while the
   * "closest approach" column read 35 m -- four officers in shooting range for
   * half a minute who never once shot, because the aim clock was reset by the
   * engage transition three times a second. Every other number in the table was
   * healthy. A floor of one is what makes that specific regression impossible
   * to reintroduce silently; the actual measurement is printed beside it and is
   * counted in dozens.
   */
  roundsWalking: 1,
  /**
   * And to one standing still. `ENGAGE_RANGE` is where an officer *stops*, so
   * this is that plus the metre a chase step overshoots by.
   */
  closestStill: ENGAGE_RANGE + 1,
} as const;

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const only = process.env.SYDNEY_POLICE_ONLY ?? '';

say('police-check: the police are people you can hit, who come for you');
say(`  world: ${root}`);
const world = await loadWorld(root);
const probe = groundFor(world);
const startTick = trafficTick(Date.now());
say(`  clock: traffic tick ${startTick} -- the beats are a function of it; see the header`);

/**
 * How much clear ground the flight has to have, metres.
 *
 * **A hundred and eighty**, which is what a thirty-second measurement of a chase
 * actually needs and is a number the first run of this driver did not have. That
 * run staged at the Surry Hills station's own coordinates -- inside the
 * building -- flew the suspect at the nearest wall, and produced a table where
 * the sprinting rows and the walking rows were identical to the metre: 14 m
 * covered at both speeds, closest approach the same at both, and every
 * conclusion about the pursuit drawn off a body that never moved.
 *
 * `factions.walkToward` has no pathfinding and a player holding W has none
 * either, so that is not a bug in the police or in the fixture's flight; it is a
 * fixture that staged a footrace in a cupboard. A walk of 4.4 m/s covers 132 m
 * in the window and a sprint 246, so 180 is enough that the walk never touches a
 * wall and the sprint is measured over most of its run before it does.
 */
const FLIGHT_ROOM_M = 180;

/**
 * Somewhere in the CBD with police on the footpath, ground under the feet, and
 * room to run.
 *
 * Searched rather than written down, on `checkPolice.findScene`'s argument: the
 * beats are a function of the wall clock, so a coordinate that had a pair beside
 * it the day this was written has nobody on it at four in the morning. What is
 * pinned is the *property* -- officers within `PROMOTE_RADIUS`, a finite ground
 * height, and `FLIGHT_ROOM_M` of unobstructed footpath on some bearing -- and
 * the search reports which corner it found and which way it points.
 *
 * The candidates are the heavy end of `POLICE_STATIONS`, because a station at
 * weight 1.0 puts ten pairs inside 520 m and one at 0.15 puts two: a driver that
 * staged its chase in Mosman would be measuring the lattice's floor and calling
 * it the pursuit. The offsets around each are a grid rather than a ring, because
 * a station's own doorstep is frequently *inside the station* -- the coordinate
 * in `POLICE_STATIONS` is a building centroid -- and the first candidate that is
 * genuinely on a street is what this is looking for.
 *
 * The **flight bearing is chosen here rather than afterwards**, and that is the
 * repair: openness is a property of the pair (place, bearing), so a search that
 * picked the place on officers alone and then asked which way to run could only
 * ever report that there was nowhere to go.
 */
interface Scene {
  x: number;
  z: number;
  officers: number;
  where: string;
  /** Unit heading with `FLIGHT_ROOM_M` or more of clear ground on it. */
  fx: number;
  fz: number;
  open: number;
}

function findScene(tick: number): Scene | null {
  const bands: PedBand[] = [];
  const ped = createPedPose();
  const beat = createBeatPose();
  let best: Scene | null = null;
  const stations: Array<[string, number, number]> = [
    ['Day Street', -486.8, 740.3],
    ['Kings Cross', 1512.7, 452.6],
    ['Surry Hills', 416.6, 1204.6],
    ['The Rocks', -50.6, -1034.4],
    ['Woolloomooloo', 887.4, 404.4],
    ['Redfern', -821.2, 2590.4],
  ];
  for (const [name, sx, sz] of stations) {
    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -2; gz <= 2; gz++) {
        const x = sx + gx * 45;
        const z = sz + gz * 45;
        const g = probe.groundHeight(x, z, -Infinity);
        if (!Number.isFinite(g)) continue;
        const y = g + 1.1;

        // The flight first, because it is the cheap disqualifier: a candidate
        // inside a building blocks on the first ten-metre step of every bearing.
        let open = 0;
        let fx = 0;
        let fz = -1;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          let run = 0;
          for (let s = 10; s <= 260; s += 10) {
            const px = x + dx * s;
            const pz = z + dz * s;
            const pg = probe.groundHeight(px, pz, -Infinity);
            if (!Number.isFinite(pg)) break;
            // The same ray `policeWitness` uses, chest to chest. A bearing that
            // is clear to a sight line is a bearing a body can run down: the
            // prisms are the same prisms `CollisionWorld.resolve` slides a
            // pursuer off.
            if (world.collision.blocked(x, y, z, px, pg + 1.1, pz)) break;
            run = s;
          }
          if (run > open) {
            open = run;
            fx = dx;
            fz = dz;
          }
        }
        if (open < FLIGHT_ROOM_M) continue;

        let officers = 0;
        forEachPoliceNear(world.peds, x, z, PROMOTE_RADIUS, tick, bands, ped, beat, () => {
          officers++;
        });
        if (best === null || officers > best.officers) {
          best = { x, z, officers, where: name, fx, fz, open };
        }
      }
    }
  }
  return best;
}

const start = findScene(startTick);
if (start === null || start.officers === 0) {
  say(
    `  FAIL  no corner of the inner city had both an officer on the footpath and ${FLIGHT_ROOM_M} m ` +
      'of street to run down; there is nothing here to measure a chase in',
  );
  process.exit(1);
}
say(`  scene: ${start.where}, (${start.x.toFixed(0)}, ${start.z.toFixed(0)}) with ${start.officers} officer(s) inside ${PROMOTE_RADIUS} m`);
say(`  flight: bearing (${start.fx.toFixed(2)}, ${start.fz.toFixed(2)}) with ${start.open} m of unobstructed street on it`);
const FLEE: [number, number] = [start.fx, start.fz];

const sim = new Simulation(world);
const out: TickOutput = { tick: 0, events: [], snapshot: null };
const suspect = sim.join(0, null, 'Bazza');

/** Put the body somewhere, on the ground, looking a way. Input yaw too -- see `checkPolice.place`. */
function place(p: Participant, x: number, z: number, yaw: number): void {
  const g = probe.groundHeight(x, z, -Infinity);
  p.combat.body.position.set(x, (Number.isFinite(g) ? g : 0) + EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = yaw;
  p.combat.body.pitch = 0;
  p.input.yaw = yaw;
  p.input.pitch = 0;
  p.input.forward = 0;
  p.input.right = 0;
  p.input.sprint = false;
  p.input.punch = false;
  p.combat.health = MAX_HEALTH;
  p.history.seed(sim.tick, x, p.combat.body.position.y, z, yaw);
}

/** Every promoted officer in the world, and how far they are from a point. */
function officersOn(playerId: number): Array<{ id: number; range: number; state: number }> {
  const px = suspect.combat.body.position.x;
  const pz = suspect.combat.body.position.z;
  const outp: Array<{ id: number; range: number; state: number }> = [];
  for (const a of sim.factions.actors) {
    if (a.kind !== NPC_KIND.POLICE) continue;
    if (a.target !== playerId) continue;
    outp.push({ id: a.id, range: Math.hypot(a.x - px, a.z - pz), state: a.state });
  }
  return outp;
}

/** Wipe the slate: no actors, no investigation, no heat, nobody wanted. */
function reset(): void {
  sim.factions.clear();
  sim.heat.reset(suspect.id);
  suspect.combat.drivingCar = 0;
  suspect.combat.carSpeed = 0;
  for (let i = 0; i < 3; i++) sim.step(out);
}

// ===========================================================================
// a. The bat, against an officer on a beat.
// ===========================================================================

/**
 * Stand behind the nearest ambient officer and swing until they go down.
 *
 * The probe *follows* them, exactly as `checkPolice`'s bystander loop does and
 * for the identical reason: a beat is a `posePedestrian` schedule denominated in
 * wall time, a `Simulation.step` over the built world is not free, and a swing
 * takes `PUNCH_TICKS` to come round -- so an officer who was a metre away when
 * the button went down is two metres away when the bat arrives.
 *
 * A **promoted** officer is followed by position instead, because the moment the
 * first swing lands they stop being a schedule and start being an actor with a
 * chase in it.
 */
function sectionBat(): void {
  say('\n--- a. a bat, against an officer on a beat');
  reset();

  const bands: PedBand[] = [];
  const ped = createPedPose();
  const beat = createBeatPose();

  /** Where the officer this section is hitting is, ambient or promoted. */
  const target = (): { x: number; z: number; promoted: boolean } | null => {
    const mine = officersOn(suspect.id);
    if (mine.length > 0) {
      const a = sim.factions.actors.find((n) => n.id === mine[0].id)!;
      return { x: a.x, z: a.z, promoted: true };
    }
    const tick = trafficTick(Date.now());
    let bestD = Infinity;
    let bx = 0;
    let bz = 0;
    forEachPoliceNear(
      world.peds, start!.x, start!.z, PROMOTE_RADIUS, tick, bands, ped, beat,
      (p) => {
        const d = Math.hypot(p.x - start!.x, p.z - start!.z);
        if (d >= bestD) return;
        bestD = d;
        bx = p.x;
        bz = p.z;
      },
    );
    return bestD === Infinity ? null : { x: bx, z: bz, promoted: false };
  };

  /** Stand a metre behind them, facing them, and hold that every tick. */
  const standBehind = (): boolean => {
    const t = target();
    if (t === null) return false;
    const px = suspect.combat.body.position.x;
    const pz = suspect.combat.body.position.z;
    let dx = t.x - px;
    let dz = t.z - pz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    // Yaw 0 faces -Z, so the yaw that points the body at (dx, dz) is
    // `atan2(-dx, -dz)`. `player/character.ts` and `world/police.ts` both state
    // the same convention.
    place(suspect, t.x - dx * 1.0, t.z - dz * 1.0, Math.atan2(-dx, -dz));
    return true;
  };

  if (!standBehind()) {
    check(false, 'an officer on a beat could be stood behind at all');
    return;
  }
  check(
    sim.factions.actors.filter((a) => a.kind === NPC_KIND.POLICE).length === 0,
    'the scene starts with nobody promoted, so the first officer to appear was made by the bat',
  );

  /**
   * The officer this section is about, pinned by id on the tick they appear.
   *
   * **Pinned rather than "whoever is nearest", and it is the difference between
   * measuring the swing and measuring the response.** The first landed swing
   * opens an investigation, and `FactionField.recruit` answers it on the very
   * next tick by promoting the rest of `PURSUIT_TARGET` off the surrounding
   * beats -- so a section that counted bodies would report a dozen officers and
   * prove nothing about the bat. What is being measured here is one officer's
   * three pips, so one officer is followed.
   */
  let victim = 0;
  let promotedAt = -1;
  let landed = 0;
  let swings = 0;
  let lastHealth = POLICE_MAX_HEALTH;
  let downed = false;

  const mine = (): { x: number; z: number; health: number } | null => {
    for (const a of sim.factions.actors) {
      if (a.id === victim && a.kind === NPC_KIND.POLICE) return { x: a.x, z: a.z, health: a.health };
    }
    return null;
  };

  // Twelve attempts against three needed, because a bat against a walking body
  // misses -- `checkPolice` documents the same miss and answers it the same
  // way: a player who missed would swing again.
  for (let attempt = 0; attempt < 12 && !downed; attempt++) {
    if (victim === 0) {
      if (!standBehind()) break;
    } else {
      const v = mine();
      if (v === null) break;
      let dx = v.x - suspect.combat.body.position.x;
      let dz = v.z - suspect.combat.body.position.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      place(suspect, v.x - dx, v.z - dz, Math.atan2(-dx, -dz));
    }
    swings++;
    suspect.input.punch = true;
    for (let i = 0; i < 26; i++) {
      sim.step(out);
      suspect.input.punch = false;
      if (victim === 0) {
        // The first police actor in the world. Nothing else could have made
        // one: there was no investigation before this swing, so `recruit` had
        // nobody to dispatch anybody at.
        const fresh = sim.factions.actors.find((a) => a.kind === NPC_KIND.POLICE);
        if (fresh) {
          victim = fresh.id;
          promotedAt = fresh.health;
          lastHealth = fresh.health;
          landed = 1;
        }
      } else {
        const v = mine();
        if (v === null) {
          // Gone from the list: `POLICE_DOWN_SECONDS` is 0, so a knockdown is a
          // removal rather than a body on the ground. See `strikeNpc`.
          downed = true;
          landed++;
          break;
        }
        if (v.health < lastHealth) {
          landed++;
          lastHealth = v.health;
        }
        let dx = v.x - suspect.combat.body.position.x;
        let dz = v.z - suspect.combat.body.position.z;
        const d = Math.hypot(dx, dz) || 1;
        dx /= d;
        dz /= d;
        place(suspect, v.x - dx, v.z - dz, Math.atan2(-dx, -dz));
      }
    }
  }

  check(victim !== 0, `swinging at an officer on a beat promoted them into a pursuit (${swings} swing(s))`);
  check(
    promotedAt === POLICE_MAX_HEALTH - 1,
    `and the very same hit took a pip off them: they arrived on ${promotedAt} of ${POLICE_MAX_HEALTH} -- ` +
      'promoted first, then struck, through the one damage door',
  );
  check(
    downed && landed === BUDGET.batSwings,
    `${landed} landed swings put that officer on the ground, against the ${BUDGET.batSwings} a player takes ` +
      `(${MAX_HEALTH} pips at one a swing)`,
  );
  check(
    POLICE_MAX_HEALTH === MAX_HEALTH,
    `an officer carries ${POLICE_MAX_HEALTH} pips against a player's ${MAX_HEALTH}: "hitable like normal players"`,
  );
  const stars = sim.heat.starsOf(suspect.id);
  const points = sim.heat.pointsOf(suspect.id);
  check(
    points >= CRIME_POINTS[REASON.MURDER_POLICE],
    `putting an officer down banked ${points} points (${stars}★) against the ` +
      `${CRIME_POINTS[REASON.MURDER_POLICE]} the ladder prices "putting an officer down" at`,
  );
  check(
    (sim.factions.reinforcementDebt.get(suspect.id) ?? 0) >= 2,
    `and owed ${sim.factions.reinforcementDebt.get(suspect.id) ?? 0} extra pursuers -- "make 2 more cops come"`,
  );
}

// ===========================================================================
// b. The car.
// ===========================================================================

/**
 * Drive at an officer on a beat at `BUDGET.carSpeed` and run them down.
 *
 * The car is put under the driver by hand with `CarField.take`, which is
 * `server/cardamage-check.ts`' own arrangement and the same call `tryTakeCar`
 * makes -- what is being exercised is the knockdown sweep, not the theft.
 *
 * The speed is **pinned rather than driven up to**, and that is a deliberate
 * departure from `cardamage-check`'s "the car has to get there by driving": that
 * check is about the crash, where the speed is the subject; this one is about
 * whether the sweep can see a body at all, and a run-up down a real CBD street
 * would be a test of the street. `stepCars` reads the speed off the driver's
 * `carSpeed` through `driverViews`, so writing it before each step is exactly
 * what a car doing 43 km/h presents to the sweep.
 */
function sectionCar(): void {
  say('\n--- b. a car at 12 m/s, through an officer on a beat');
  reset();

  const bands: PedBand[] = [];
  const ped = createPedPose();
  const beat = createBeatPose();
  const tick = trafficTick(Date.now());
  let bestD = Infinity;
  let ox = 0;
  let oz = 0;
  forEachPoliceNear(world.peds, start!.x, start!.z, PROMOTE_RADIUS, tick, bands, ped, beat, (p) => {
    const d = Math.hypot(p.x - start!.x, p.z - start!.z);
    if (d >= bestD) return;
    bestD = d;
    ox = p.x;
    oz = p.z;
  });
  if (bestD === Infinity) {
    check(false, 'an officer on a beat could be found to drive at');
    return;
  }

  // Ten metres short of them, pointed at them: under a second at the test
  // speed, so the beat has barely moved by the time the bonnet arrives.
  const dx = (ox - start!.x) / (bestD || 1);
  const dz = (oz - start!.z) / (bestD || 1);
  const sx = ox - dx * 10;
  const sz = oz - dz * 10;
  place(suspect, sx, sz, Math.atan2(-dx, -dz));
  const car = sim.cars.take(
    {
      // A source identity nothing on the timetable can collide with: the ambient
      // fleet is keyed off route and slot, and this is a fixture with no route.
      identity: 0x9051ce,
      body: 0,
      colour: 0,
      x: sx,
      y: suspect.combat.body.position.y - EYE_HEIGHT,
      z: sz,
      yaw: suspect.combat.body.yaw,
      parked: true,
    },
    suspect.combat.id,
  );
  if (car === null) {
    check(false, 'a car could be put under the driver');
    return;
  }
  suspect.combat.drivingCar = car.id;

  const pointsBefore = sim.heat.pointsOf(suspect.id);
  let downed = false;
  let travelled = 0;
  for (let i = 0; i < 240 && !downed; i++) {
    // Held every tick: `combat.advance` integrates the throttle and would bleed
    // the speed off between steps, and what the sweep is being shown is a car
    // at a road speed rather than one accelerating.
    suspect.combat.carSpeed = BUDGET.carSpeed;
    suspect.input.forward = 1;
    const before = sim.factions.reinforcementDebt.get(suspect.id) ?? 0;
    sim.step(out);
    travelled += BUDGET.carSpeed / 60;
    if ((sim.factions.reinforcementDebt.get(suspect.id) ?? 0) > before) downed = true;
    for (const a of sim.factions.actors) {
      if (a.kind === NPC_KIND.POLICE && a.state === NPC_STATE.DOWN) downed = true;
    }
  }
  suspect.input.forward = 0;

  check(downed, `a car at ${BUDGET.carSpeed} m/s knocked an officer down (${travelled.toFixed(0)} m of road)`);
  const gained = sim.heat.pointsOf(suspect.id) - pointsBefore;
  check(
    gained >= CRIME_POINTS[REASON.MURDER_POLICE],
    `and added ${gained} heat points, at or above the ${CRIME_POINTS[REASON.MURDER_POLICE]} for ` +
      '"putting an officer down" -- the same charge as a bat',
  );
  check(
    sim.heat.starsOf(suspect.id) >= 3,
    `which is ${sim.heat.starsOf(suspect.id)} stars (${CRIME_POINTS[REASON.MURDER_POLICE]} points is ` +
      `rung ${STAR_POINTS.indexOf(380)} on the ladder)`,
  );

  suspect.combat.drivingCar = 0;
  suspect.combat.carSpeed = 0;
  sim.cars.remove(car.id);
}

// ===========================================================================
// c. The chase table.
// ===========================================================================

interface Row {
  stars: number;
  motion: 'still' | 'walking' | 'sprinting';
  /** Distinct officers who took this suspect as their target inside ten seconds. */
  in10s: number;
  /** And over the whole thirty, which is where a handoff shows up. */
  in30s: number;
  /** Closest any pursuing officer got, metres, over thirty seconds. */
  closest: number;
  /** How far away the nearest pursuer was at the end of it. */
  ended: number;
  /** Rounds fired at this suspect, and rounds that took a pip off. */
  fired: number;
  landed: number;
  /**
   * How far the suspect actually got from where they started, metres.
   *
   * **The column that keeps the rest of the table honest**, and it is in here
   * because the first run of this driver did not have it: the sprinting rows
   * came out identical to the walking ones, which reads as the chase being
   * indifferent to how fast you run and was in fact a suspect wedged against a
   * Surry Hills terrace at both speeds. A pursuit table with no distance in it
   * cannot tell "the police kept up" from "nobody moved".
   */
  moved: number;
}

/**
 * One scenario: pin the stars, open the investigation, and run.
 *
 * The two facts are **restated every tick** rather than set once, which is
 * `checkPolice.holdScenario`'s lesson: points shed while nobody has line of
 * sight, and a fixture that banked its stars and walked away slides down a rung
 * mid-measurement and reports the rung below the one it is labelled with.
 *
 * Health is topped up for the same reason and with the same caveat: this
 * measures a *pursuit*, and a suspect who is knocked out at twelve seconds
 * takes the investigation down with them (`Simulation.shoot` closes it) and the
 * remaining eighteen seconds measure an empty street. The rounds that landed are
 * counted before the top-up, so nothing about the shot model is hidden by it.
 */
function runChase(stars: number, motion: Row['motion']): Row {
  reset();
  const [fx, fz] = FLEE;
  place(suspect, start!.x, start!.z, Math.atan2(-fx, -fz));

  const row: Row = {
    stars, motion, in10s: 0, in30s: 0, closest: Infinity, ended: Infinity, fired: 0, landed: 0, moved: 0,
  };
  const seen = new Set<number>();
  let firedBefore = sim.factions.shots;

  for (let tick = 0; tick < 30 * 60; tick++) {
    if (!sim.factions.investigationOf(suspect.id)) {
      sim.factions.accuse(suspect.id, REASON.ASSAULT_POLICE, sim.tick);
    }
    sim.heat.debugSet(suspect.id, stars, sim.tick);
    suspect.input.forward = motion === 'still' ? 0 : 1;
    suspect.input.sprint = motion === 'sprinting';
    suspect.input.yaw = Math.atan2(-fx, -fz);

    const healthBefore = suspect.combat.health;
    sim.step(out);
    const rounds = sim.factions.shots - firedBefore;
    firedBefore = sim.factions.shots;
    if (rounds > 0) {
      row.fired += rounds;
      if (suspect.combat.health < healthBefore) row.landed++;
    }
    suspect.combat.health = MAX_HEALTH;
    if (suspect.combat.phase === 'ko') place(suspect, suspect.combat.body.position.x, suspect.combat.body.position.z, Math.atan2(-fx, -fz));

    const mine = officersOn(suspect.id);
    for (const o of mine) {
      seen.add(o.id);
      if (o.range < row.closest) row.closest = o.range;
    }
    if (tick === 10 * 60 - 1) row.in10s = seen.size;
    if (tick === 30 * 60 - 1) {
      row.in30s = seen.size;
      row.ended = mine.length === 0 ? Infinity : Math.min(...mine.map((o) => o.range));
      row.moved = Math.hypot(
        suspect.combat.body.position.x - start!.x,
        suspect.combat.body.position.z - start!.z,
      );
    }
  }
  suspect.input.forward = 0;
  suspect.input.sprint = false;
  return row;
}

function sectionChase(): Row[] {
  say('\n--- c. the chase table: nine scenarios over the real city');
  say(`      chase ${CHASE_SPEED} m/s against a walk of 4.4 and a sprint of 8.2; engage at ${ENGAGE_RANGE} m;`);
  say(`      pursuit target ${PURSUIT_TARGET} below ${PURSUIT_SURGE_STARS}★ and ${PURSUIT_TARGET_HIGH} at or above it;`);
  say(`      leash ${PURSUIT_LEASH_M} m of ground lost past an officer's own closest approach`);
  const rows: Row[] = [];
  for (const stars of [1, 2, 3]) {
    for (const motion of ['still', 'walking', 'sprinting'] as const) {
      rows.push(runChase(stars, motion));
    }
  }
  say('');
  say('      ★  motion      promoted@10s  distinct@30s  closest    ended     ran  fired  landed');
  for (const r of rows) {
    const f = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(0)} m` : '  --');
    say(
      `      ${r.stars}  ${r.motion.padEnd(11)} ${String(r.in10s).padStart(9)} ` +
        `${String(r.in30s).padStart(13)} ${f(r.closest).padStart(9)} ${f(r.ended).padStart(8)} ` +
        `${f(r.moved).padStart(7)} ${String(r.fired).padStart(6)} ${String(r.landed).padStart(7)}`,
    );
  }
  say('');
  // The fixture's own honesty check, before anything is concluded from the rows
  // above it: a suspect who did not move measures nothing about a chase. See
  // `Row.moved` and `fleeBearing`.
  {
    const sprint = rows.filter((r) => r.motion === 'sprinting');
    const walk = rows.filter((r) => r.motion === 'walking');
    const ranS = Math.max(...sprint.map((r) => r.moved));
    const ranW = Math.max(...walk.map((r) => r.moved));
    check(ranW > 30, `the walking suspect actually walked (${ranW.toFixed(0)} m in 30 s)`);
    check(ranS > ranW, `and the sprinting one outran them (${ranS.toFixed(0)} m against ${ranW.toFixed(0)} m)`);
    // **And how much of the sprint row to believe**, printed rather than
    // asserted. A sprint covers 246 m in the window and the inner city does not
    // reliably hold that much straight unobstructed street -- `FLIGHT_ROOM_M` is
    // the floor, not the ideal. A run that ends against a wall is a run where
    // the officers close in the last few seconds because the suspect stopped,
    // which is correct behaviour and is *not* evidence about the leash. The
    // walking rows are unaffected: 132 m is inside the floor by 48.
    if (ranS >= start!.open - 5) {
      say(
        `      note: the sprint ran ${ranS.toFixed(0)} m into ${start!.open} m of street and finished against ` +
          'the end of it, so its "ended" and "closest" columns are a suspect who stopped rather than a ' +
          'pursuit that caught up.',
      );
    }
  }

  const at = (stars: number, motion: Row['motion']): Row =>
    rows.find((r) => r.stars === stars && r.motion === motion)!;

  // --- The constraints the brief states, one assertion each.
  for (const stars of [1, 2, 3]) {
    const r = at(stars, 'walking');
    check(
      r.in10s >= BUDGET.pursuersWalking,
      `${stars}★ walking: ${r.in10s} officer(s) were on the suspect inside 10 s (floor ${BUDGET.pursuersWalking})`,
    );
    check(
      r.closest <= BUDGET.closestWalking,
      `${stars}★ walking: an officer closed to ${r.closest.toFixed(0)} m, inside the ${ENGAGE_RANGE} m engage range ` +
        `-- ${CHASE_SPEED} m/s catches a 4.4 m/s walk`,
    );
    const still = at(stars, 'still');
    check(
      still.closest <= BUDGET.closestStill,
      `${stars}★ standing still: an officer reached ${still.closest.toFixed(0)} m`,
    );
    // The half of "stay within shooting range" that being *in* range does not
    // imply. See `BUDGET.roundsWalking`.
    if (stars >= POLICE_ARMED_STARS) {
      check(
        r.fired >= BUDGET.roundsWalking,
        `${stars}★ walking: ${r.fired} round(s) were actually fired at a suspect walking away ` +
          `(floor ${BUDGET.roundsWalking}) -- being in range is not the same as shooting`,
      );
    }
  }

  // The sprinting suspect opens a gap and is still being pursued at thirty
  // seconds, by somebody -- which after the leash is not necessarily the same
  // somebody, and that is the point.
  for (const stars of [2, 3]) {
    const r = at(stars, 'sprinting');
    check(
      Number.isFinite(r.ended),
      `${stars}★ sprinting: somebody was still pursuing at 30 s (nearest ${r.ended.toFixed(0)} m)`,
    );
  }
  const sprint3 = at(3, 'sprinting');
  check(
    sprint3.in30s >= BUDGET.pursuersSprintingAt3,
    `3★ sprinting: ${sprint3.in30s} distinct officers took the pursuit over 30 s (floor ` +
      `${BUDGET.pursuersSprintingAt3}) -- the handoff to whoever is ahead`,
  );

  // The rungs differ. This is the whole of *"actually chase u when u bad"*: a
  // three-star response that is the same size as a one-star one is a ladder
  // nobody can read.
  const surge = at(PURSUIT_SURGE_STARS, 'still').in30s;
  const base = at(1, 'still').in30s;
  check(
    surge > base,
    `the response grows with the rung: ${base} officer(s) at 1★ against ${surge} at ${PURSUIT_SURGE_STARS}★ ` +
      `(pursuit target ${pursuitTargetFor(1)} -> ${pursuitTargetFor(PURSUIT_SURGE_STARS)})`,
  );
  check(
    surge <= MAX_ACTORS,
    `and stays inside the ${MAX_ACTORS}-actor wire cap (${surge} distinct officers over 30 s)`,
  );

  // --- And the two-star gate, from the other end: the rung below it fires
  //     nothing at all, and the rungs above it fire.
  const one = rows.filter((r) => r.stars === 1).reduce((a, r) => a + r.fired, 0);
  check(one === 0, `nothing left a barrel at 1★ across all three motions (${one} round(s)) -- POLICE_ARMED_STARS is ${POLICE_ARMED_STARS}`);
  const armed = rows.filter((r) => r.stars >= POLICE_ARMED_STARS && r.motion !== 'sprinting');
  const fired = armed.reduce((a, r) => a + r.fired, 0);
  const landed = armed.reduce((a, r) => a + r.landed, 0);
  check(fired > 0, `${fired} rounds were fired at a suspect at ${POLICE_ARMED_STARS}★ and up who was not sprinting`);
  check(landed > 0, `and ${landed} of them landed -- the one-in-ten roll over ${fired} rounds`);
  return rows;
}

// ===========================================================================
// d. The ladder.
// ===========================================================================

/**
 * Each way of hurting an officer is worth what `game/heat.CRIME_POINTS` says,
 * measured through the real `HeatField`.
 *
 * The table is read back as well as measured, which looks circular and is not:
 * what the pure half asserts is that the two *charges* are still distinct --
 * hitting a constable and putting one down are a 2-star and a 3-star response
 * and `REASON` carries them separately -- and what the live half asserts is that
 * the paths above actually reach them. Sections a and b measure the second
 * charge; this measures the first, which nothing else does, because a bat that
 * lands without downing anybody is the common case and is a different crime.
 */
function sectionLadder(): void {
  say('\n--- d. what each of them is worth on the ladder');
  check(
    CRIME_POINTS[REASON.ASSAULT_POLICE] === 260 && CRIME_POINTS[REASON.MURDER_POLICE] === 380,
    `hitting an officer is ${CRIME_POINTS[REASON.ASSAULT_POLICE]} points and putting one down is ` +
      `${CRIME_POINTS[REASON.MURDER_POLICE]} -- two charges, ${STAR_POINTS.indexOf(250)}★ and ${STAR_POINTS.indexOf(380)}★`,
  );

  reset();
  place(suspect, start!.x, start!.z, 0);
  sim.factions.accuse(suspect.id, REASON.ASSAULT_POLICE, sim.tick);
  for (let i = 0; i < 4; i++) sim.step(out);
  const hit = sim.heat.pointsOf(suspect.id);
  check(
    hit >= CRIME_POINTS[REASON.ASSAULT_POLICE],
    `a swing that connects without downing anybody banks ${hit} points (${sim.heat.starsOf(suspect.id)}★)`,
  );

  reset();
  place(suspect, start!.x, start!.z, 0);
  sim.factions.accuse(suspect.id, REASON.MURDER_POLICE, sim.tick);
  for (let i = 0; i < 4; i++) sim.step(out);
  const down = sim.heat.pointsOf(suspect.id);
  check(
    down > hit && sim.heat.starsOf(suspect.id) >= 3,
    `and putting one down banks ${down} (${sim.heat.starsOf(suspect.id)}★) -- strictly more, and a rung higher`,
  );
}

// ===========================================================================

if (only === '' || only === 'hit') {
  sectionBat();
  sectionCar();
}
if (only === '' || only === 'chase') sectionChase();
if (only === '' || only === 'heat') sectionLadder();

say('');
if (failures.length === 0) {
  say('police-check: PASSED');
  process.exit(0);
}
for (const f of failures) say(`  - ${f}`);
say(`police-check: ${failures.length} CHECK(S) FAILED`);
process.exit(1);
