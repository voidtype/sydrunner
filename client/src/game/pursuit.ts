/**
 * The patrol car drives.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL, WHICH IS ONE SENTENCE OF THE OWNER'S.
 * ===========================================================================
 *
 * *"and actually chase u when u bad"*, and beside it *"also i couldnt head on
 * collision"* -- he drove a stolen Camry straight at a highway patrol car and
 * went through it.
 *
 * Both reports are the same missing thing. `game/heat.ts` promoted
 * `NPC_KIND.HIGHWAY_PATROL` as a faction *actor*: an id, a position, six pips of
 * health, a feed line and eighteen bytes on the NPC wire. That is everything a
 * constable needs and none of what a car needs. An actor is not a body -- it is
 * in no contact sweep on either end, so it has no mass, cannot be hit and cannot
 * hit anything -- and an actor has no motion model, so the pursuit it drove was
 * a hand-rolled `steerToward` toward the nearest lane vertex that happened to be
 * closer to the suspect than the bumper was, at a fixed 25 m/s, through the
 * ambient fleet, the parked fleet and any player's car standing in the road.
 *
 * `game/driving.ts` already owns the only vehicle motion model in this project
 * and `game/rigid.ts` the only contact model, and every entry point into the
 * first takes a `DrivenCar` with a player's `driverId`. So the whole of this
 * feature is: **give the patrol car a `DrivenCar` record with a sentinel driver
 * (`driving.NPC_DRIVER_ID`) and put a lane-follower where the player's hands
 * would be.** Nothing about a contact, a shunt, a dent, a blocker or a fire
 * needed a line of new code -- `sim.resolveCarContacts` gates on
 * `driverId !== 0`, `sim.publishBlockers` publishes every record there is, and
 * `CarField.damage` does not care who is at the wheel.
 *
 * This file is that lane-follower and nothing else. It is **three-free** and is
 * imported by the Bun server; it decides *where the car goes*, and `heat.ts`
 * still decides *whether there is a car at all* (the rungs, the spawn, the
 * officers it puts out, the stand-downs). `world/highway-patrol.ts` still draws
 * it -- off the actor, whose pose this file slaves to the record, which is why
 * the light bar, the siren and the borrowed lamps all followed the new motion
 * with no change at all.
 *
 * ---------------------------------------------------------------------------
 * 1. THE LANE GRAPH IS NOT A GRAPH, AND THE NODE PICK IS THE WHOLE STEERING.
 *
 * `game/traffic.ts` has no node/edge structure to route over: it has
 * `LaneRoute`s, which are baked polylines with a timetable stapled to them, and
 * `scripts/world-round/chain-lanes.py` joins them into chains by *flagging their
 * ends* rather than by writing an adjacency list. There is no `next[]` anywhere
 * and building one at runtime -- over a streaming set of tiles, on a 1 vCPU box
 * -- is a whole subsystem for a car that is trying to get four hundred metres.
 *
 * So the pursuit does what a driver does at a junction: it looks at what leaves
 * from where it is standing and takes the one that points at you.
 *
 *   - A **node** is a lane vertex. The car's node is the nearest vertex on any
 *     route within `PURSUIT_LANE_REACH`, re-found four times a second.
 *   - The **outgoing lanes** are every direction leaving that node: both ways
 *     along its own route, and both ways along every other route with a vertex
 *     inside `PURSUIT_NODE_M` of it. Two routes that meet at a corner have
 *     coincident end vertices by construction (that is what a chain joint *is*),
 *     so this finds every real turn without an adjacency list and without ever
 *     being wrong about one that is not there.
 *   - The **score** is how much the direction closes on the suspect:
 *     `ex*ux + ez*uz`, the dot of the outgoing unit direction with the unit
 *     bearing to the suspect. One square root for the bearing and nothing else
 *     -- **no `atan2`, no `sin`, no `cos`** anywhere in the pick, which is
 *     `game/factions.ts` rule 5 and `heat.ts` section 6 held to literally.
 *   - A candidate that would be a **U-turn** (`ex*hx + ez*hz < REVERSE_DOT`
 *     against the car's own heading) is refused unless nothing else leaves the
 *     node, which is what stops a car flip-flopping between the two directions
 *     of one street every quarter second when the suspect is beside it.
 *
 * What this deliberately is not is a *route planner*. It is greedy and it can
 * be walled: a suspect on the far side of a river gets a patrol car that drives
 * to the near bank and gives up, which is `PURSUIT_STALL_TICKS` below and is a
 * far better failure than a car that swims. The design rule this satisfies is
 * DESIGN.md's -- *the chase is beatable by terrain* -- and a greedy driver is
 * the honest expression of it rather than a limitation being tolerated.
 *
 * ---------------------------------------------------------------------------
 * 2. THE SPEED, AND WHY THE COP DOES NOT GET A SPEED BUFF.
 *
 * DESIGN.md is explicit that the player is never out-run by a number: *"no
 * speed buffs to the player; the chase is beatable by terrain, not by speed"*.
 * The patrol car's want is therefore the **road's own traffic speed plus 30 %**
 * -- `laneSpeedAt`, which is the baked polyline differentiated, exactly what
 * `poseCar` gives an ambient car -- clamped by four things and by nothing else:
 *
 *     want = min( laneSpeed * PURSUIT_SPEED_MARGIN,   the road, plus 30 %
 *                 PURSUIT_TOP_SPEED,                  the machine
 *                 cornerCap(curvature),               the tyres
 *                 stoppingCap(gap ahead) )            the queue and the arrival
 *
 * `cornerCap` is the one that makes the chase losable and it is worth the
 * arithmetic being written down. A corner of radius R is taken at
 * `sqrt(PURSUIT_LAT_ACCEL * R)`, and R comes off the polyline as
 * `la * lb^2 / |cross|` -- the chord over the sine of the turn -- so a tight
 * residential corner caps the car at **under a sprint**
 * (`sqrt(5.5 * 10) = 7.4 m/s` against `driving.SPRINT_SPEED`'s 8.2) while a
 * dual carriageway does not cap it at all. That is the whole shape of the
 * mechanic: outrun it in a straight line and you lose, take it round two
 * corners of a Newtown backstreet and you are gone. `verifyPursuitDriving`
 * asserts exactly that inequality, because it is a design statement and not a
 * tuning number.
 *
 * `stoppingCap` is `sqrt(2 * PURSUIT_BRAKE * slack)`, the schoolbook stopping
 * distance, and it does **two** jobs with one line:
 *
 *   - the **queue**: `slack` is the free distance to the next car in the cone
 *     ahead less `PURSUIT_HOLD_GAP`, so the car comes to rest six metres behind
 *     a held Camry rather than driving through it. The ambient poses come out of
 *     `traffic.forEachCarNear`, which applies `HoldLedger` on the way out -- so
 *     "where the car in front actually is" is asked of the one thing that knows,
 *     and a patrol car queues behind the queue a player's abandoned car caused.
 *   - the **arrival**: `slack` is also the gap to the suspect less
 *     `PURSUIT_STOP_M`, so the car rolls to a **stop eight metres off a
 *     stationary suspect** instead of stopping wherever its brakes ran out.
 *     That is the number the brief asks for and it falls out of the same
 *     formula the queue uses rather than being a second rule with a second
 *     threshold.
 *
 * ---------------------------------------------------------------------------
 * 3. WHAT IS A BODY AND WHAT IS AN ACTOR, ON ONE TICK.
 *
 * There are three objects here and they are not the same object:
 *
 *   - the **`PursuitCar`** in this file is the driver: heading as a unit vector
 *     (never an angle, see rule 5), speed, slip, spin, and where on the lane
 *     graph it thinks it is. It is `combat.CombatantState` for a car nobody is
 *     in, and it is what `sim.fillCarBody`/`applyCarBody` read and write when a
 *     contact lands -- exactly as they read a human driver's combatant.
 *   - the **`DrivenCar` record** is the wire and the body. `CarField.follow`
 *     copies the pose off a `DriverView` this file fills, so a patrol car is
 *     carried by the identical sweep that carries a player's stolen Camry.
 *   - the **`NpcActor`** is the hit box, the health, the kill-feed line and the
 *     picture. `heat.ts` slaves its `x/y/z/dx/dz` to the `PursuitCar` at the end
 *     of every tick, which is why the siren (`main.ts`' `nearestSiren`), the
 *     beacons (`world/highway-patrol.nearestPursuit`) and the bat all followed
 *     the new motion without knowing it changed.
 *
 * The ordering is the player's own, one phase apart: this file moves the car at
 * the *end* of the tick (inside `stepFactions`), the next tick's `stepCars`
 * resolves what it drove into and writes the shunt back here, and `follow` puts
 * the result on the record before the snapshot goes out. A human driver has the
 * identical one-tick relationship between `combat.advance` and `stepCars`, and
 * `server/carcrash-check.ts`' section 1 is the paragraph that argues it.
 *
 * ---------------------------------------------------------------------------
 * 4. DETERMINISM. Every rule of `heat.ts` section 6 applies unchanged. There is
 * no `Math.sin`, `Math.cos`, `Math.atan2`, `Math.hypot` or `Math.random` in this
 * file. Headings are unit vectors turned by the cross-product rotation
 * `heat.steerToward` already uses; the only place an angle appears at all is
 * `driving.headingYaw` at the record boundary, which is `rigidYaw`'s sanctioned
 * exception -- the value is quantised to a `u16` by `encodeCars` before anybody
 * else sees it and no client ever recomputes it.
 *
 * ---------------------------------------------------------------------------
 * 5. BUDGET. O(patrol cars), which is one per suspect at three stars and is zero
 * for the state a room is in almost all of the time. The node pick is four times
 * a second and walks the vertices of the routes inside 70 m at a stride; the
 * obstacle cone is one `forEachCarNear` at 40 m per car per tick, which is the
 * same broadphase the player sweep already runs per player per tick. Nothing
 * here allocates: the scratch is the caller's and is reused.
 */

import {
  NPC_DRIVER_ID,
  SPRINT_SPEED,
  headingYaw,
  type DrivenCar,
  type DriverView,
} from './driving.ts';
import {
  createCarPose,
  forEachCarNear,
  type CarPose,
  type LaneRoute,
  type TrafficField,
} from './traffic.ts';

// --- The machine ------------------------------------------------------------------

/**
 * How fast a patrol car will ever go, m/s. 108 km/h.
 *
 * The ceiling on top of the road's own speed, and it exists because the lane
 * speed of the Warringah Freeway is not a speed anybody should be chased at
 * through a suburb the pursuit happens to reach. Above `driving.SPRINT_SPEED`
 * by a factor of three and a half, which is the point: **you do not outrun this
 * in a straight line.** See section 2 for the half of the design that says how
 * you do beat it.
 */
export const PURSUIT_TOP_SPEED = 30;

/**
 * How much faster than the traffic it drives, as a factor. The brief's 30 %.
 *
 * A factor rather than an addition, so a patrol car on a 40 km/h shared zone is
 * doing 52 and one on a 90 km/h arterial is doing 117 -- which is what a highway
 * patrol car actually does and, more usefully, means the number never has to be
 * retuned per road class. The road already carries the answer.
 */
export const PURSUIT_SPEED_MARGIN = 1.3;

/**
 * What the tyres will take sideways, m/s^2.
 *
 * **The one number that decides whether the chase is beatable**, and it is set
 * against a sprint rather than against a physics table. At a tight corner --
 * `PURSUIT_TIGHT_RADIUS`, ten metres, which is a residential street corner or a
 * laneway mouth -- this caps the car at `sqrt(5.5 * 10) = 7.4 m/s`, under
 * `driving.SPRINT_SPEED`'s 8.2. So a player who runs the corners is *faster
 * than the car through them* and loses it, and a player who runs the straights
 * is caught. DESIGN.md's rule -- no speed buff to the player, the terrain is the
 * escape -- expressed as the only kind of statement that can be checked.
 *
 * `verifyPursuitDriving` asserts that inequality directly. Moving this number
 * up past `SPRINT_SPEED^2 / PURSUIT_TIGHT_RADIUS` (6.7) makes the pursuit
 * unlosable on foot and the check says so.
 */
export const PURSUIT_LAT_ACCEL = 5.5;
/** The radius the rule above is stated at, metres. A residential corner. */
export const PURSUIT_TIGHT_RADIUS = 10;

/** Metres a second squared, on and off. A sedan; `driving.DRIVE_ACCELERATION`'s neighbour. */
export const PURSUIT_ACCEL = 6;
export const PURSUIT_BRAKE = 12;

/**
 * How hard it may turn, radians a second. `heat.PATROL_TURN_RATE`'s number,
 * kept because it was right: a sedan, not a tank.
 */
export const PURSUIT_TURN_RATE = 1.6;

/** The mass of a marked highway patrol car, kg. See `PURSUIT_BODY`. */
export const PURSUIT_MASS = 1900;
/**
 * Which `traffic.CAR_BODY_SIZE` box it collides as. 0 -- the sedan, 4.6 x 1.8 m.
 *
 * The box is the sedan's because the sedan is what is on screen:
 * `client/public/cars/nsw_police.glb` is 4.9 x 1.85 m and index 0 is the nearest
 * row to it, and `driving.carRigidBody`'s header is explicit that what a player
 * learns about a car they can see the edges of has to be the edges.
 *
 * The **mass is not** that row's 1,400 kg, and the override is deliberate: a
 * marked car carries a bull bar, a cage, a radio rack and two officers, and a
 * Camry that bounced off it the way it bounces off a hatchback would read as a
 * prop. 1,900 kg is `driving.CAR_MASS`' own SUV row reused rather than a number
 * invented here, so the fleet's mass ladder still has one author.
 */
export const PURSUIT_BODY = 0;
/** The paint index. Unused by the draw -- the actor is the picture -- but a record needs one. */
export const PURSUIT_COLOUR = 0;

// --- The graph --------------------------------------------------------------------

/** How far around itself the car looks for lane vertices, metres. */
export const PURSUIT_LANE_REACH = 70;
/** Two vertices this close are one node, metres. A chain joint is exactly coincident. */
export const PURSUIT_NODE_M = 6;
/** How far along the chosen lane the waypoint is put, metres. */
export const PURSUIT_LOOKAHEAD_M = 18;
/** Ticks between node picks. Four times a second; see `heat.ts` section 5. */
export const PURSUIT_REPICK_TICKS = 15;
/**
 * How square a candidate has to be against the car's own heading to be taken at
 * all, as a dot product. -0.2 is "anything but a genuine U-turn".
 */
export const PURSUIT_REVERSE_DOT = -0.2;

/**
 * How far off the lane graph a suspect may be before the car stops trying,
 * metres.
 *
 * The brief's *"if no lane reaches the suspect within 250 m of graph, the car
 * parks and the officers pursue on foot"*, and this is the cheap half of it: a
 * suspect standing in the middle of Centennial Park has no lane vertex within
 * thirty metres and there is nothing for a lane-follower to aim at, so it parks
 * immediately rather than driving to the nearest kerb and idling there.
 */
export const PURSUIT_SUSPECT_LANE_M = 30;
/** And how far the graph is asked to reach at all, metres. The brief's number. */
export const PURSUIT_GRAPH_M = 250;
/**
 * How long the car may sit still before it parks, ticks. Six seconds.
 *
 * The expensive half of the off-graph rule above, and the one that catches the
 * case a radius cannot: the suspect is on a road, the road is on the other side
 * of a railway cutting, and a greedy driver will nose into the fence and stay
 * there for the rest of the session. Six seconds of not moving is a wall.
 *
 * Read `stepPursuitCar`'s ledger for why this is "has not moved" and emphatically
 * not "has not got closer" -- the second is a question about the suspect and it
 * parked working pursuits.
 */
export const PURSUIT_STALL_TICKS = 6 * 60;

// --- The arrival and the queue ------------------------------------------------------

/** Where it comes to rest off a stopped suspect, metres. The brief's number. */
export const PURSUIT_STOP_M = 8;
/** How still a suspect has to be for the car to commit to stopping, m/s. */
export const PURSUIT_STOP_SPEED = 1.5;
/** Under this the car is stopped, m/s, and the officers may get out. */
export const PURSUIT_REST_SPEED = 0.6;
/**
 * How close it tails somebody who is still moving, metres.
 *
 * Inside `heat.PATROL_HIT_M`'s 2.6, deliberately: the three-star rung is a car
 * that *knocks you down on contact* and a follow law that held eight metres
 * would have quietly deleted that. Two metres is a bumper on your heels.
 */
export const PURSUIT_TAIL_M = 2;

/** How far ahead the obstacle cone reaches, metres. */
export const PURSUIT_SCAN_M = 40;
/** And how wide it is at any range, metres. A lane, near enough. */
export const PURSUIT_SCAN_HALF_M = 2.4;
/** How far behind a car it will sit, metres. `traffic.HOLD_GAP`'s six. */
export const PURSUIT_HOLD_GAP = 6;

// --- One car's driving ---------------------------------------------------------------

/**
 * Everything the authority knows about one patrol car's motion.
 *
 * `combat.CombatantState` for a car nobody is in, and held on `HeatField` beside
 * the rest of the pursuit's private state for `heat.CarDrive`'s stated reason:
 * `NpcActor` is the *wire's* shape and a steering state it does not need is a
 * field every future reader has to be told to ignore.
 */
export interface PursuitCar {
  /** The `driving.DrivenCar` record id this drives, or 0 before one was made. */
  carId: number;
  /** The `factions.NpcActor` id whose pose this drives. */
  actorId: number;
  /** The combatant being chased. */
  target: number;

  // --- The pose. `y` is feet, as everywhere else in this project.
  x: number;
  y: number;
  z: number;
  /** Unit heading. **Never an angle** -- see the header, section 4. */
  dx: number;
  dz: number;
  /** Signed along the heading, m/s, and across it, positive left. */
  speed: number;
  slip: number;
  /** Radians a second, positive left. */
  yawRate: number;

  // --- Where it is going.
  /** The waypoint, world metres. */
  wx: number;
  wz: number;
  /** The tick the node was last picked. */
  pickedAt: number;
  /** Whether the last pick found a lane at all. False is the straight-line fallback. */
  onGraph: boolean;
  /**
   * The last tick this car was **moving**. The stall test's datum.
   *
   * `factions.NpcActor.bestRange`'s twin in spirit and deliberately not in
   * substance: that field remembers a closest approach, because an officer's
   * leash is about being outrun, and this one remembers motion, because a car's
   * give-up rule is about being *stuck*. `stepPursuitCar`'s ledger carries the
   * argument for the difference, which is a bug this file shipped for an
   * afternoon.
   */
  progressTick: number;
  /** It has given up and is standing in the road. See `PURSUIT_STALL_TICKS`. */
  parked: boolean;
  /** It has come to rest beside the suspect. The officers' door. */
  stopped: boolean;
  /**
   * **Is this a car that never moves?** The RBT's, and only the RBT's.
   *
   * The breath-test site (`heat.RBT`) is an actor with a marked car drawn at it,
   * and until this round that car was scenery in the strictest sense: no mass,
   * no box, nothing in any sweep, so you drove through the one police vehicle in
   * the game that is *parked across a road on purpose*. Giving it a record with
   * this flag set is the whole fix -- `sim.fillCarBody` marks the body
   * `kinematic`, which `game/rigid.ts` defines as an inverse mass of zero, so it
   * shunts whatever hits it and is not moved by it. A wall you can dent yourself
   * on, which is what a roadblock is.
   *
   * It is a flag on this record rather than a second kind of object because
   * everything else about it is identical -- the same sentinel driver, the same
   * `follow`, the same 32 bytes -- and the only two lines that care are the two
   * that build and write back the body. `stepPursuitCar` is never called on one:
   * `heat.driveCars` filters on `NPC_KIND.HIGHWAY_PATROL` and an RBT is not one.
   *
   * The line of witches' hats either side of it stays exactly as unsolid as it
   * was, which is deliberate: `heat.RBT_LINE_HALF_M`'s drive-through is seven
   * metres wide against a 4.6 m car, so *evading* an RBT is still a thing you do
   * by going round the car -- and now ramming the car itself is a crash instead
   * of a nothing.
   */
  anchored: boolean;
  /** Whether it has already put its two officers out. Once per stop. */
  disgorged: boolean;
}

export function createPursuitCar(
  actorId: number,
  target: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  /** True for the RBT's car, which is a wall. See `PursuitCar.anchored`. */
  anchored = false,
): PursuitCar {
  return {
    carId: 0,
    actorId,
    target,
    x, y, z,
    dx, dz,
    speed: 0,
    slip: 0,
    yawRate: 0,
    wx: x + dx,
    wz: z + dz,
    pickedAt: 0,
    onGraph: false,
    progressTick: 0,
    parked: false,
    stopped: false,
    anchored,
    disgorged: false,
  };
}

/** The `driving.DriverView` a patrol car's record is carried by. One per car, reused. */
export interface PursuitView extends DriverView {
  id: number;
  drivingCar: number;
  carSpeed: number;
  carSlip: number;
  carYawRate: number;
  x: number;
  feetY: number;
  z: number;
  yaw: number;
}

/**
 * Fill the view `CarField.follow` carries the record by.
 *
 * The **one** place in this feature an angle is produced, and `driving.headingYaw`
 * is `rigid.rigidYaw`'s sanctioned exception: the value is quantised to a `u16`
 * by `encodeCars` before anybody else sees it, no client ever recomputes it, and
 * this runs once per patrol car per tick.
 */
export function pursuitView(car: PursuitCar, out: PursuitView): PursuitView {
  out.id = NPC_DRIVER_ID;
  out.drivingCar = car.carId;
  out.carSpeed = car.speed;
  out.carSlip = car.slip;
  out.carYawRate = car.yawRate;
  out.x = car.x;
  out.feetY = car.y;
  out.z = car.z;
  out.yaw = headingYaw(car.dx, car.dz);
  return out;
}

export function createPursuitView(): PursuitView {
  return {
    id: NPC_DRIVER_ID, drivingCar: 0, carSpeed: 0, carSlip: 0, carYawRate: 0,
    x: 0, feetY: 0, z: 0, yaw: 0,
  };
}

// --- The node pick ---------------------------------------------------------------------

/** One outgoing lane leaving a node. See the header, section 1. */
export interface PursuitChoice {
  /** The route it belongs to, and the vertex it leaves from. */
  route: LaneRoute | null;
  index: number;
  /** +1 or -1: which way along the polyline. */
  step: number;
  /** The unit direction it leaves in. */
  ex: number;
  ez: number;
  /** `ex*ux + ez*uz` against the bearing to the suspect. Higher closes faster. */
  score: number;
  /**
   * How much road is left **ahead of the car** in this direction, metres,
   * capped. The tie-break, and the dead-end refusal.
   *
   * Two candidates that close on the suspect equally well are a real and
   * frequent state: standing exactly at a corner with the suspect diagonally
   * beyond it, the road that ends there and the road that turns score the
   * identical dot product, and a plain `>` comparison takes whichever was
   * offered first. `verifyPursuitDriving`'s walk sat at that junction forever --
   * it kept choosing the street it had just finished, whose remaining run was
   * nought, so the waypoint came out on the car's own bumper and nothing moved.
   *
   * So a candidate with less than a node's worth of road left is not a
   * candidate, and among equals the longer road wins. Both rules are the same
   * observation: a direction with no lane in it is not a direction.
   */
  run: number;
  /** The waypoint `PURSUIT_LOOKAHEAD_M` along it. */
  wx: number;
  wz: number;
  /** What the road runs at here, m/s, and what a corner will take. */
  laneSpeed: number;
  cornerSpeed: number;
}

export function createPursuitChoice(): PursuitChoice {
  return {
    route: null, index: 0, step: 1, ex: 0, ez: 0, score: -Infinity, run: 0,
    wx: 0, wz: 0, laneSpeed: 0, cornerSpeed: Infinity,
  };
}

/**
 * What the timetable runs this stretch of lane at, m/s.
 *
 * The baked polyline differentiated -- the identical quantity `poseCar` writes
 * into `CarPose.speed` -- so a patrol car's want is the *road's* number and not
 * a constant this file invented. Walks forward over degenerate segments, because
 * a route's vertices are doubled at a red light (`traffic.SYNTHETIC_DWELL` and
 * every real signal in the bake) and a zero-length segment with a dwell on it
 * differentiates to zero: a red light is a thing the ambient fleet obeys and is
 * not a speed limit for a pursuit.
 *
 * `LANE_SPEED_FLOOR` covers the case where the whole lookahead is dwell.
 */
export const LANE_SPEED_FLOOR = 8;

export function laneSpeedAt(route: LaneRoute, index: number, step: number): number {
  for (let n = 0; n < 6; n++) {
    const i = index + step * n;
    const j = i + step;
    if (i < 0 || j < 0 || i >= route.count || j >= route.count) break;
    const dx = route.x[j] - route.x[i];
    const dz = route.z[j] - route.z[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.01) continue;
    const dt = route.t[j] - route.t[i];
    const span = dt < 0 ? -dt : dt;
    if (span < 1e-4) continue;
    const v = Math.sqrt(d2) / span;
    return v > LANE_SPEED_FLOOR ? v : LANE_SPEED_FLOOR;
  }
  return LANE_SPEED_FLOOR;
}

/**
 * The fastest this corner may be taken, m/s. `Infinity` for a straight.
 *
 * `R = la * lb^2 / |cross|` -- the chord over the sine of the turn, which is the
 * circumscribed radius to first order -- and then `sqrt(PURSUIT_LAT_ACCEL * R)`.
 * Two square roots and eight multiplies, no transcendental of any kind. See the
 * header, section 2, for why this function is the whole design and not a detail.
 */
export function cornerSpeedAt(route: LaneRoute, index: number, step: number, latAccel = PURSUIT_LAT_ACCEL): number {
  let cap = Infinity;
  // Two vertices of lookahead: a corner you can see is a corner you slow for,
  // and one you are already in is a corner you took too fast.
  for (let n = 0; n <= 2; n++) {
    const i = index + step * n;
    const back = i - step;
    const fwd = i + step;
    if (back < 0 || fwd < 0 || back >= route.count || fwd >= route.count || i < 0 || i >= route.count) continue;
    const ax = route.x[i] - route.x[back];
    const az = route.z[i] - route.z[back];
    const bx = route.x[fwd] - route.x[i];
    const bz = route.z[fwd] - route.z[i];
    const la2 = ax * ax + az * az;
    const lb2 = bx * bx + bz * bz;
    if (la2 < 0.01 || lb2 < 0.01) continue;
    let cross = ax * bz - az * bx;
    if (cross < 0) cross = -cross;
    if (cross < 1e-4) continue;
    const la = Math.sqrt(la2);
    const radius = (la * lb2) / cross;
    const v = Math.sqrt(latAccel * radius);
    if (v < cap) cap = v;
  }
  return cap;
}

/**
 * The nearest point on a set of routes to `(x, z)`, as **the vertex at the near
 * end of the nearest segment**, plus how far that point is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEGMENT TEST AND NOT A VERTEX TEST, WHICH IS A BUG THIS FILE
 * SHIPPED AND `verifyPursuitDriving` CONVICTED ON ITS FIRST RUN.
 *
 * The obvious way to find "which node is this car standing at" is to scan the
 * vertices, and the version of this file that did was wrong in a way that only
 * shows up on a coarsely-sampled road. A `LaneRoute` in the real bake has a
 * vertex every few metres, so the nearest vertex is the nearest lane and the two
 * questions have the same answer -- but nothing in the format promises that, a
 * long straight arterial has vertices hundreds of metres apart, and the check's
 * own fixture is four vertices over three hundred metres. A car sitting halfway
 * down such a segment is *on* the road and the nearest vertex is 150 m away, so
 * a vertex scan with a 70 m reach answers "there is no lane here" about a car
 * that is driving down one.
 *
 * Two things went wrong with that and both were silent: the pursuit parked
 * itself under the off-graph rule (`PURSUIT_SUSPECT_LANE_M`, which asks this
 * same question about the *suspect*), and the node it did find was behind the
 * car, so the waypoint came out on top of the bumper and the car never moved.
 *
 * So: the distance is measured to the **segment**, which is the road, and the
 * node returned is the segment's nearer endpoint, which is a real vertex and
 * therefore a real place for `pickOutgoing` to ask what leaves. Both properties
 * are needed and neither alone is enough.
 *
 * Returns false when nothing is inside `reach`.
 */
export interface NearestLane {
  route: LaneRoute | null;
  /** The vertex at the near end of the nearest segment. */
  index: number;
  /**
   * And the **segment** itself, as the index of its first vertex.
   *
   * Carried beside `index` because `pickOutgoing` needs both and they are not
   * the same question. `index` is "which node is the car at", which is what a
   * junction is asked about; this is "which piece of road is it on", which is
   * what *continuing* is asked about -- and at the far end of a polyline those
   * two disagree in the one way that matters. See `pickOutgoing`, block 3.
   */
  segment: number;
  /** Plan distance to the segment itself, metres. */
  distance: number;
}

export function createNearestLane(): NearestLane {
  return { route: null, index: 0, segment: 0, distance: Infinity };
}

export function nearestOnRoutes(
  routes: readonly LaneRoute[],
  x: number,
  z: number,
  reach: number,
  out: NearestLane,
): boolean {
  out.route = null;
  out.index = 0;
  out.distance = Infinity;
  let best2 = reach * reach;
  for (const r of routes) {
    for (let i = 0; i + 1 < r.count; i++) {
      const ax = r.x[i];
      const az = r.z[i];
      const bx = r.x[i + 1];
      const bz = r.z[i + 1];
      const sx = bx - ax;
      const sz = bz - az;
      const len2 = sx * sx + sz * sz;
      // A doubled vertex -- a red light in the bake -- is a point and not a
      // segment. Measured as its own endpoint rather than skipped, so a route
      // that is nothing but a dwell still answers.
      let t = 0;
      if (len2 > 1e-6) {
        t = ((x - ax) * sx + (z - az) * sz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const px = ax + sx * t;
      const pz = az + sz * t;
      const dx = px - x;
      const dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= best2) continue;
      best2 = d2;
      out.route = r;
      out.segment = i;
      // The **near end**, so the node is behind the car rather than in front of
      // it: `pickOutgoing` then asks what leaves a place the car has reached,
      // and `waypointAhead` walks forward from it.
      out.index = t <= 0.5 ? i : i + 1;
    }
  }
  if (out.route === null) return false;
  out.distance = Math.sqrt(best2);
  return true;
}

/** Scratch for the node search, so a pick allocates nothing. */
const _nearest: NearestLane = createNearestLane();
const _suspectLane: NearestLane = createNearestLane();

/**
 * How far along the polyline the waypoint is sampled, metres.
 *
 * The waypoint is the first point at least `PURSUIT_LOOKAHEAD_M` **from the
 * car** -- not from the node -- and this is the granularity that is searched
 * for. Two metres is a tenth of the lookahead and is under the width of the
 * lane, so the steering cannot tell the difference; solving the quadratic
 * exactly would be a dozen more lines for a number that is then handed to a
 * bounded turn rate.
 */
const WAYPOINT_SAMPLE_M = 2;

/**
 * The waypoint: the first point along the chosen lane that is far enough ahead
 * of the **car**.
 *
 * Measured from the car and not from the node, which is the other half of the
 * bug `nearestOnRoutes`' header describes: a fixed arc from the node puts the
 * waypoint on the bumper of a car that has already driven most of the way to it,
 * and a car steering at its own position does not steer.
 *
 * "Ahead" is both tests -- far enough away *and* on the leaving side -- because
 * distance alone is satisfied by a point behind a car that has overshot its
 * node. Clamped at the end of the polyline rather than continued: the end of a
 * route is a node, and the next pick will find whatever leaves it.
 */
function waypointAhead(
  route: LaneRoute,
  index: number,
  step: number,
  carX: number,
  carZ: number,
  ex: number,
  ez: number,
  minAhead: number,
  out: { x: number; z: number },
): void {
  let i = index;
  let px = route.x[i];
  let pz = route.z[i];
  const min2 = minAhead * minAhead;
  let walked = 0;
  const cap = minAhead * 8 + 60;
  while (walked <= cap) {
    const rx = px - carX;
    const rz = pz - carZ;
    if (rx * rx + rz * rz >= min2 && rx * ex + rz * ez > 0) break;
    const j = i + step;
    if (j < 0 || j >= route.count) break;
    const sx = route.x[j] - px;
    const sz = route.z[j] - pz;
    const seg = Math.sqrt(sx * sx + sz * sz);
    if (seg <= WAYPOINT_SAMPLE_M) {
      px = route.x[j];
      pz = route.z[j];
      i = j;
      walked += seg;
      continue;
    }
    const f = WAYPOINT_SAMPLE_M / seg;
    px += sx * f;
    pz += sz * f;
    walked += WAYPOINT_SAMPLE_M;
  }
  out.x = px;
  out.z = pz;
}

/** Scratch for `waypointAhead`, so a pick allocates nothing. */
const _along = { x: 0, z: 0 };

/**
 * The unit direction leaving a vertex, walking over degenerate segments.
 * Returns false when there is nothing ahead -- the end of the polyline.
 */
function outgoingDir(route: LaneRoute, index: number, step: number, out: { x: number; z: number }): boolean {
  for (let n = 0; n < 6; n++) {
    const i = index + step * n;
    const j = i + step;
    if (i < 0 || j < 0 || i >= route.count || j >= route.count) return false;
    const dx = route.x[j] - route.x[i];
    const dz = route.z[j] - route.z[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.01) continue;
    const d = Math.sqrt(d2);
    out.x = dx / d;
    out.z = dz / d;
    return true;
  }
  return false;
}

const _dir = { x: 0, z: 0 };

/**
 * One candidate, scored against the running best. `pickOutgoing`'s inner loop,
 * named so the three places that offer a candidate offer it on identical terms.
 *
 * A module-level function rather than a closure inside the pick, on
 * `traffic.poseCar`'s habit: this is called a few dozen times per pick, four
 * times a second, per car, and a fresh closure per call is the only thing in
 * the path that would allocate.
 */
function consider(
  r: LaneRoute,
  i: number,
  s: number,
  carX: number,
  carZ: number,
  headX: number,
  headZ: number,
  ux: number,
  uz: number,
  allowReverse: boolean,
  out: PursuitChoice,
): void {
  if (i < 0 || i >= r.count) return;
  if (!outgoingDir(r, i, s, _dir)) return;
  const ex = _dir.x;
  const ez = _dir.z;
  if (!allowReverse && ex * headX + ez * headZ < PURSUIT_REVERSE_DOT) return;
  const run = runAhead(r, i, s, carX, carZ);
  // A direction with no lane left in it is not a direction. See `PursuitChoice.run`.
  if (run < PURSUIT_NODE_M) return;
  const score = ex * ux + ez * uz;
  if (score < out.score - SCORE_EPS) return;
  if (score <= out.score + SCORE_EPS && run <= out.run) return;
  out.route = r;
  out.index = i;
  out.step = s;
  out.ex = ex;
  out.ez = ez;
  out.score = score;
  out.run = run;
}

/** How close two closing rates have to be to count as the same one. */
const SCORE_EPS = 1e-9;

/**
 * How much road is left ahead of the car along `(index, step)`, metres, capped.
 *
 * The arc from the vertex to the end of the polyline, less how far the car
 * already is from that vertex -- which is the right subtraction whichever side
 * of the vertex the car is standing on: a car that has passed it has eaten that
 * much of the run, and a car approaching it has that much still to cover. Capped
 * at twice the lookahead, because the only question anybody asks of this is
 * "enough, or nothing", and walking a 800 m route to the end to answer it would
 * be the most expensive line in the pursuit.
 */
function runAhead(r: LaneRoute, index: number, step: number, carX: number, carZ: number): number {
  const cap = PURSUIT_LOOKAHEAD_M * 2;
  const bx = r.x[index] - carX;
  const bz = r.z[index] - carZ;
  const back = Math.sqrt(bx * bx + bz * bz);
  // The cap is on the **answer** and not on the walk, which is the one way to
  // get this wrong: capping the arc first and subtracting afterwards reports a
  // car forty metres down a three-hundred-metre street as having no road left,
  // and every direction is then refused. The walk is still bounded -- `back` is
  // at most the search reach -- so this is at worst a hundred metres of
  // polyline, four times a second, per car.
  const want = back + cap;
  let arc = 0;
  let i = index;
  while (arc < want) {
    const j = i + step;
    if (j < 0 || j >= r.count) break;
    const dx = r.x[j] - r.x[i];
    const dz = r.z[j] - r.z[i];
    arc += Math.sqrt(dx * dx + dz * dz);
    i = j;
  }
  const run = arc - back;
  return run > cap ? cap : run;
}

/**
 * Pick the outgoing lane at a node that best closes on the suspect.
 *
 * **Pure**, and it is the function `verifyPursuitDriving` walks a synthetic
 * graph with: given a set of routes, where the car is standing, which way it is
 * pointing and where the suspect is, this is the whole of the steering. Returns
 * false when no route in `routes` has a vertex within `PURSUIT_LANE_REACH` --
 * which is the off-lane case and is the caller's fallback, not an error.
 *
 * The node is found first (the nearest vertex on any route) and the candidates
 * are taken from every vertex within `PURSUIT_NODE_M` of it, which is what makes
 * a chain joint -- two routes whose ends are exactly coincident -- a junction
 * without an adjacency list. See the header, section 1.
 */
export function pickOutgoing(
  routes: readonly LaneRoute[],
  carX: number,
  carZ: number,
  /** The car's own unit heading, for the U-turn refusal. */
  headX: number,
  headZ: number,
  targetX: number,
  targetZ: number,
  out: PursuitChoice,
  reach = PURSUIT_LANE_REACH,
): boolean {
  out.route = null;
  out.score = -Infinity;
  out.run = 0;

  // --- 1. The node: the near end of the nearest **segment**, which is the road.
  //     See `nearestOnRoutes` for the bug a vertex scan has instead.
  if (!nearestOnRoutes(routes, carX, carZ, reach, _nearest)) return false;
  const nodeRoute = _nearest.route as LaneRoute;
  const nodeIndex = _nearest.index;
  const nx = nodeRoute.x[nodeIndex];
  const nz = nodeRoute.z[nodeIndex];

  // --- 2. The bearing to the suspect **from the car**. One square root, and the
  //     only one the score needs.
  //
  // From the car and not from the node, and the difference is not cosmetic: the
  // node is the near end of the segment the car is on, so it can be most of a
  // segment ahead of the bumper -- and when the road runs straight at the
  // suspect the node can be the suspect's own vertex, which has no bearing from
  // itself at all. `verifyPursuitDriving`'s walk found exactly that on the third
  // street of its L and stopped 68 m short with "no lane here". The car is the
  // thing that is driving, so the car is where "which way are they" is asked
  // from. A suspect standing on the bumper is a suspect the caller has already
  // stopped for.
  const tx = targetX - carX;
  const tz = targetZ - carZ;
  const td = Math.sqrt(tx * tx + tz * tz);
  if (td < 1e-3) return false;
  const ux = tx / td;
  const uz = tz / td;

  // --- 3. Every direction leaving the node, scored, plus **the road the car is
  //     already on**, which is not the same set and whose absence was a bug.
  //
  // The obvious candidate set is "every direction out of the node", and it is
  // wrong at the far end of a polyline in a way `verifyPursuitDriving`'s walk
  // caught on the third street of its L: the car was 68 m short of the target,
  // the nearest segment's near end rounded to the route's **last** vertex, and
  // nothing leaves a last vertex going forwards -- so the only candidate was the
  // way back, the U-turn refusal correctly rejected it, the fallback pass then
  // allowed it, and the car turned round eighteen metres from a road that ran
  // straight at the suspect. It oscillated there for the rest of the walk.
  //
  // So the segment the car is standing on is offered explicitly, both ways,
  // before the node's own fan-out: `(segment, +1)` is "carry on down this piece
  // of road" and is a legal move whether or not its far end is a junction.
  //
  // Two passes over the same candidates: the first refuses U-turns and the
  // second runs only if the first found nothing at all -- a genuine dead end,
  // where turning round is the correct and only move. A flag rather than two
  // loops, because the candidate walk is the expensive half.
  const node2 = PURSUIT_NODE_M * PURSUIT_NODE_M;
  const segment = _nearest.segment;
  for (let pass = 0; pass < 2; pass++) {
    const allowReverse = pass === 1;
    consider(nodeRoute, segment, 1, carX, carZ, headX, headZ, ux, uz, allowReverse, out);
    consider(nodeRoute, segment + 1, -1, carX, carZ, headX, headZ, ux, uz, allowReverse, out);
    for (const r of routes) {
      for (let i = 0; i < r.count; i++) {
        const dx = r.x[i] - nx;
        const dz = r.z[i] - nz;
        if (dx * dx + dz * dz > node2) continue;
        consider(r, i, 1, carX, carZ, headX, headZ, ux, uz, allowReverse, out);
        consider(r, i, -1, carX, carZ, headX, headZ, ux, uz, allowReverse, out);
      }
    }
    // **The refusal holds only while something forward actually closes.**
    //
    // A plain "found anything at all" break was wrong on a two-way street, which
    // is most of Sydney: with the suspect *behind* the car, the only two
    // directions leaving the node are the way the car is going (which scores
    // negative -- it leads away) and the way back (which the U-turn rule
    // refuses). Pass 0 found the first, broke, and the car drove away from the
    // person it was chasing for the rest of the pursuit.
    // `server/pursuit-check.ts` section 2 caught it as 275 m opened up inside a
    // minute against somebody *jogging*.
    //
    // So a forward candidate has to be closing (`score > 0`) to end the search;
    // if nothing does, pass 1 runs and the car turns round. Which is the whole
    // rule stated properly: do not flip-flop at a junction, but do turn round
    // when they have gone past you.
    if (out.route !== null && out.score > 0) break;
  }
  if (out.route === null) return false;

  waypointAhead(out.route, out.index, out.step, carX, carZ, out.ex, out.ez, PURSUIT_LOOKAHEAD_M, _along);
  out.wx = _along.x;
  out.wz = _along.z;
  out.laneSpeed = laneSpeedAt(out.route, out.index, out.step);
  out.cornerSpeed = cornerSpeedAt(out.route, out.index, out.step);
  return true;
}

// --- The obstacle cone ----------------------------------------------------------------

/**
 * How much free road there is in front of the nose, metres.
 *
 * `PURSUIT_SCAN_M` when there is nothing in the cone, which is the overwhelming
 * case and costs one broadphase query. The cone is a *plan* test -- forward
 * distance along the heading, lateral offset across it -- rather than a swept
 * box, because a patrol car is trying to answer "is somebody in my lane" and a
 * separating-axis test against every car within forty metres would be paying
 * `rigid.ts` prices for a throttle decision.
 *
 * The visitor is fed by `traffic.forEachCarNear`, which applies `HoldLedger` on
 * the way out -- so the pose of the car in front is *where it actually is*
 * including the hold a player's abandoned car put on it, and a patrol car queues
 * behind the queue rather than through it. That is the whole of the brief's
 * "obeys the schedule fleet as an obstacle (the hold ledger)".
 */
export function coneGap(
  carX: number,
  carZ: number,
  dx: number,
  dz: number,
  obstacleX: number,
  obstacleZ: number,
  obstacleHalf: number,
): number {
  const rx = obstacleX - carX;
  const rz = obstacleZ - carZ;
  const ahead = rx * dx + rz * dz;
  if (ahead <= 0) return Infinity;
  let across = rx * -dz + rz * dx;
  if (across < 0) across = -across;
  if (across > PURSUIT_SCAN_HALF_M + obstacleHalf) return Infinity;
  const gap = ahead - obstacleHalf;
  return gap < 0 ? 0 : gap;
}

/**
 * The stopping-distance speed cap. `sqrt(2 a s)`, and it does the queue and the
 * arrival with one line. See the header, section 2.
 */
export function stoppingCap(slack: number, brake = PURSUIT_BRAKE): number {
  if (slack <= 0) return 0;
  return Math.sqrt(2 * brake * slack);
}

// --- The step ----------------------------------------------------------------------------

/** What the pursuit needs from whatever process is running it. `heat.HeatWorld`'s shape. */
export interface PursuitWorld {
  lanes: TrafficField | null;
  /** The wall-clock traffic tick, for the ambient poses. `traffic.trafficTick(Date.now())`. */
  trafficTick: number;
  /** The simulation tick, for the repick and stall clocks. */
  tick: number;
  groundHeight(x: number, z: number, hint: number): number;
  collision: {
    resolve(fx: number, fz: number, tx: number, tz: number, r: number, feetY: number, headY?: number):
      { x: number; z: number; hit: boolean };
  } | null;
}

/** Scratch one caller holds for the life of the field, so a tick allocates nothing. */
export interface PursuitScratch {
  routes: LaneRoute[];
  pose: CarPose;
  choice: PursuitChoice;
  view: PursuitView;
}

export function createPursuitScratch(): PursuitScratch {
  return { routes: [], pose: createCarPose(), choice: createPursuitChoice(), view: createPursuitView() };
}

/**
 * Turn a unit heading toward a point, at most `rate` radians a second.
 *
 * `heat.steerToward`'s rotation, restated on a `PursuitCar` rather than an
 * `NpcActor`: a first-order rotation of the heading vector toward the target
 * vector, clamped by the cross product and renormalised. **No angle is ever
 * formed.** See the header, section 4.
 */
function turnToward(car: PursuitCar, tx: number, tz: number, rate: number, dt: number): void {
  const vx = tx - car.x;
  const vz = tz - car.z;
  const d2 = vx * vx + vz * vz;
  if (d2 < 1e-6) return;
  const d = Math.sqrt(d2);
  const wx = vx / d;
  const wz = vz / d;
  // The signed sine of the angle between the heading and the want.
  const cross = car.dx * wz - car.dz * wx;
  const dot = car.dx * wx + car.dz * wz;
  let turn = cross;
  const max = rate * dt;
  // A target dead astern has a cross of ~0 and a dot of -1, which a bare cross
  // reads as "already facing it". Break the tie toward the left, deterministically.
  if (dot < 0 && turn > -1e-4 && turn < 1e-4) turn = 1;
  if (turn > max) turn = max;
  else if (turn < -max) turn = -max;
  const nx = car.dx - car.dz * turn;
  const nz = car.dz + car.dx * turn;
  const n = Math.sqrt(nx * nx + nz * nz);
  if (n < 1e-6) return;
  car.dx = nx / n;
  car.dz = nz / n;
}

/** Rotate the heading by the body's own spin, for a car that has been shunted. */
function applySpin(car: PursuitCar, dt: number): void {
  if (car.yawRate === 0) return;
  const turn = car.yawRate * dt;
  const nx = car.dx - car.dz * turn;
  const nz = car.dz + car.dx * turn;
  const n = Math.sqrt(nx * nx + nz * nz);
  if (n < 1e-6) return;
  car.dx = nx / n;
  car.dz = nz / n;
  // The spin bleeds off the way a driver's hands take it off, which is
  // `driving.CAR_SPIN_GRIP`'s rule restated for a driver made of arithmetic.
  const shed = 4 * dt;
  if (car.yawRate > 0) car.yawRate = car.yawRate > shed ? car.yawRate - shed : 0;
  else car.yawRate = car.yawRate < -shed ? car.yawRate + shed : 0;
}

/**
 * One patrol car, one tick.
 *
 * Returns the range to the suspect, which is what the caller needs for the
 * stand-downs it owns (`heat.driveCars`: the rung, the pursuit range, the
 * knockdown) and which this function has already computed.
 *
 * The suspect's speed is passed in rather than read off a combatant because this
 * file must not know what a combatant is -- `game/driving.ts`' own rule about
 * `DriverView`, one layer up.
 */
export function stepPursuitCar(
  car: PursuitCar,
  targetX: number,
  targetZ: number,
  targetSpeed: number,
  world: PursuitWorld,
  dt: number,
  scratch: PursuitScratch,
  /**
   * The ambient fleet, or null for a process with no timetable resident.
   *
   * The **driven** fleet is deliberately not a second argument here, and the
   * reason is that it is already covered twice over: a patrol car and a player's
   * car are two bodies in `sim.resolveCarContacts`, so they cannot pass through
   * each other whatever this throttle decides, and a car somebody abandoned in a
   * lane is in `sim.publishBlockers`' roster -- so the ambient cars behind it are
   * *held* (`traffic.resolveHeld`), and `forEachCarNear` hands those held poses
   * out here. The queue a player's car causes therefore reaches the pursuit
   * transitively, through the one ledger that owns it, rather than through a
   * second list this file would have to be given.
   */
  traffic: TrafficField | null = null,
): number {
  const gx = targetX - car.x;
  const gz = targetZ - car.z;
  const range = Math.sqrt(gx * gx + gz * gz);

  // --- The stall ledger, before anything is decided.
  //
  // **"Has this car moved", not "has it got closer"**, and the difference is a
  // bug `server/pursuit-check.ts` section 2 convicted. The first cut asked
  // whether the range to the suspect had improved, which is a question about the
  // *suspect* as much as about the car: a patrol car sitting eight metres off
  // somebody who then starts running is a car whose range gets worse every tick
  // while it drives after them perfectly well, and six seconds later it parked
  // itself in the middle of a working pursuit. Measured as 245 m opened up
  // against a jogger.
  //
  // What the rule is actually for is the car that *cannot get there*: wedged
  // against a fence, stopped at a kerb across a railway cutting, nosed into a
  // wall the lane graph does not know about. All of those are a car with no
  // speed, and none of them is a car that is driving. The suspect who simply
  // gets away is `PATROL_PURSUIT_M`'s three hundred metres, which is a different
  // rule with a different owner.
  if (car.progressTick === 0 || car.speed > PURSUIT_REST_SPEED) car.progressTick = world.tick;

  // --- Arrived. The car comes to rest and the officers' door opens. The stop is
  //     `PURSUIT_STOP_M` off a suspect who is standing still; a suspect who is
  //     moving is chased and the car never latches.
  const stopping = targetSpeed <= PURSUIT_STOP_SPEED && range <= PURSUIT_STOP_M;
  if (stopping) {
    car.speed = 0;
    car.slip = 0;
    car.yawRate = 0;
    car.stopped = true;
    // Still turn to face them, so it comes to rest alongside rather than
    // across the road. Free -- the wheels are not turning.
    turnToward(car, targetX, targetZ, PURSUIT_TURN_RATE, dt);
    return range;
  }
  car.stopped = false;

  // --- Parked. It gave up; it is furniture until the caller takes it away.
  if (car.parked) {
    car.speed = 0;
    car.slip = 0;
    return range;
  }

  // --- The node pick, four times a second.
  if (world.tick - car.pickedAt >= PURSUIT_REPICK_TICKS || car.pickedAt === 0) {
    car.pickedAt = world.tick;
    const lanes = world.lanes;
    let picked = false;
    if (lanes !== null) {
      lanes.near(car.x, car.z, PURSUIT_LANE_REACH, scratch.routes);
      picked = pickOutgoing(scratch.routes, car.x, car.z, car.dx, car.dz, targetX, targetZ, scratch.choice);
    }
    if (picked) {
      car.onGraph = true;
      car.wx = scratch.choice.wx;
      car.wz = scratch.choice.wz;
    } else {
      // --- Off the graph. **Still drive at them**, on `heat.spawnPatrolCar`'s
      // own argument for the straight-line spawn fallback: a browser running the
      // offline authority holds only the tiles it has streamed, so an absent
      // lane graph is a real state and not only a degraded one. The car aims at
      // the suspect and `world.collision` stops it at the kerb, exactly as an
      // officer on foot is stopped.
      car.onGraph = false;
      car.wx = targetX;
      car.wz = targetZ;
      scratch.choice.route = null;
      scratch.choice.laneSpeed = LANE_SPEED_FLOOR;
      scratch.choice.cornerSpeed = Infinity;
    }

    // --- And the two ways the pursuit gives up on driving to you.
    //
    // The suspect off the graph entirely (`PURSUIT_SUSPECT_LANE_M`) or the car
    // making no progress for six seconds (`PURSUIT_STALL_TICKS`). Either way it
    // parks and `heat.driveCars` puts the officers out on foot, which is the
    // brief's *"the car parks and the officers pursue on foot"*.
    if (lanes !== null && range <= PURSUIT_GRAPH_M) {
      lanes.near(targetX, targetZ, PURSUIT_SUSPECT_LANE_M, scratch.routes);
      // The distance to the **road** and not to a vertex on it, on
      // `nearestOnRoutes`' own argument: a suspect standing in the middle of a
      // long straight segment is standing on a road, and the version of this
      // that asked about vertices parked the pursuit against people who were
      // driving down the Hume.
      if (!nearestOnRoutes(scratch.routes, targetX, targetZ, PURSUIT_SUSPECT_LANE_M, _suspectLane)) {
        car.parked = true;
      }
    }
    if (world.tick - car.progressTick >= PURSUIT_STALL_TICKS) car.parked = true;
    if (car.parked) {
      car.speed = 0;
      car.slip = 0;
      return range;
    }
  }

  // --- What it wants to be doing. See the header, section 2.
  let want = scratch.choice.laneSpeed * PURSUIT_SPEED_MARGIN;
  if (!car.onGraph) want = LANE_SPEED_FLOOR * PURSUIT_SPEED_MARGIN;
  if (want > PURSUIT_TOP_SPEED) want = PURSUIT_TOP_SPEED;
  if (scratch.choice.cornerSpeed < want) want = scratch.choice.cornerSpeed;

  // --- ...and what is in the way of doing it. The suspect is an obstacle like
  //     any other, which is what makes the arrival and the queue one rule.
  // --- The suspect is the first obstacle, under the **car-following law** and
  //     not under the queue's.
  //
  // `stoppingCap(slack) + their speed` rather than `stoppingCap(slack)`, and the
  // extra term is what makes this a *follow* rather than a stop: you may go as
  // fast as the thing in front plus whatever you could shed in the gap that is
  // left. It is the same law `traffic.HoldLedger` encodes for the ambient fleet,
  // asked about a person instead of a car.
  //
  // The first cut had no such term and only braked for a suspect who was
  // *standing still*. Against somebody jogging the car therefore drove at them
  // at fourteen metres a second, hit them, went past, turned round, came back,
  // and repeated -- a sawtooth that `server/pursuit-check.ts` section 2
  // measured as a gap swinging up to forty metres against a suspect doing four.
  //
  // The gap it holds is **two** metres against somebody moving and
  // `PURSUIT_STOP_M`'s eight against somebody who has stopped, and the
  // difference is the design rather than tuning: `heat.ts` section 4 says a
  // patrol car *knocks you down on contact*, and two metres is inside
  // `heat.PATROL_HIT_M`, so a car that catches you still hits you. Eight is the
  // distance two officers need to get out of a car, and it is only wanted once
  // there is somebody standing still to get out at.
  let gap = PURSUIT_SCAN_M;
  const following = targetSpeed > PURSUIT_STOP_SPEED;
  const suspectCap = stoppingCap(range - (following ? PURSUIT_TAIL_M : PURSUIT_STOP_M))
    + (following ? targetSpeed : 0);
  if (traffic !== null) {
    forEachCarNear(traffic, car.x, car.z, PURSUIT_SCAN_M, world.trafficTick, scratch.routes, scratch.pose, (p) => {
      // The viaduct gate, `resolveTrafficContact`'s clause verbatim: a car on
      // the Cahill Expressway is not in front of one on Alfred Street below it.
      const dy = p.y - car.y;
      if (dy > 3 || dy < -3) return;
      const g = coneGap(car.x, car.z, car.dx, car.dz, p.x, p.z, p.halfLength) - PURSUIT_HOLD_GAP;
      if (g < gap) gap = g;
    });
  }
  const brakeCap = stoppingCap(gap);
  if (brakeCap < want) want = brakeCap;
  if (suspectCap < want) want = suspectCap;
  if (want < 0) want = 0;

  // --- Steer, then integrate. The turn is bounded and falls with speed, which
  //     is `driving.driveTurnRate`'s shape restated: a car at 30 m/s does not
  //     turn like one at walking pace, and a lane-follower that could would cut
  //     corners no polyline has.
  applySpin(car, dt);
  const rate = PURSUIT_TURN_RATE * (car.speed > 8 ? 8 / car.speed : 1);
  turnToward(car, car.wx, car.wz, rate, dt);

  const accel = want > car.speed ? PURSUIT_ACCEL : PURSUIT_BRAKE;
  const step = accel * dt;
  if (want > car.speed) car.speed = car.speed + step > want ? want : car.speed + step;
  else car.speed = car.speed - step < want ? want : car.speed - step;
  if (car.speed < 0) car.speed = 0;

  // The slip a shunt left it with bleeds off the way a tyre takes it off.
  if (car.slip !== 0) {
    const shed = 8 * dt;
    if (car.slip > 0) car.slip = car.slip > shed ? car.slip - shed : 0;
    else car.slip = car.slip < -shed ? car.slip + shed : 0;
  }

  const travel = car.speed * dt;
  const lateral = car.slip * dt;
  let nx = car.x + car.dx * travel - car.dz * lateral;
  let nz = car.z + car.dz * travel + car.dx * lateral;
  if (world.collision !== null) {
    // The player's own resolver, on `heat.driveCars`' own argument: a car takes
    // the corner a player would and cannot drive through a terrace. A car that
    // is wedged simply loses its speed, which is what `walkToward` already
    // accepts for an officer on foot.
    const moved = world.collision.resolve(car.x, car.z, nx, nz, 1.15, car.y + 0.4, car.y + 1.8);
    if (moved.x !== nx || moved.z !== nz) car.speed *= 0.4;
    nx = moved.x;
    nz = moved.z;
  }
  car.x = nx;
  car.z = nz;
  car.y = world.groundHeight(nx, nz, car.y);
  return range;
}

// --- The mirror ---------------------------------------------------------------------------

/**
 * Roll a connected client's patrol cars forward between corrections.
 *
 * **The client half of the 10 Hz broadcast**, and the exact counterpart of
 * `CarField.integrateLoose`: the authority sends a patrol car's pose at
 * `driving.LOOSE_BROADCAST_TICKS` because there is no driver's snapshot record
 * to derive it from, and what stops the record being up to 100 ms stale in
 * between -- three metres at 30 m/s, which is most of a car -- is this end
 * advancing it itself.
 *
 * It is a **dead reckon and not the pursuit**, and that is deliberate rather
 * than lazy. Running `stepPursuitCar` here would mean the browser holding a
 * `PursuitCar` per patrol car, streaming the same lane tiles the server has, and
 * agreeing with it about the node pick -- and disagreeing about any of the
 * three would put a police car down the wrong street at speed. What is
 * predictable without any of that is the next hundred milliseconds of a car that
 * is already moving in a direction, so that is what is predicted, and the next
 * `CARS` frame is the correction. `world/drivencars.ts` does not draw these at
 * all (`world/highway-patrol.ts` draws the actor, which arrives at the snapshot
 * rate); what this moves is the **body the local driver's contact prediction is
 * run against**, which is the owner's *"i couldnt head on collision"* and the
 * only reason it matters at all.
 *
 * Never called on an authority. Offline and on the server the pose comes from
 * `CarField.follow` off a real `PursuitCar`, and running both would advance the
 * car twice a tick.
 */
export function advancePursuitMirror(cars: Iterable<DrivenCar>, dt: number): void {
  if (dt <= 0) return;
  for (const car of cars) {
    if (car.driverId !== NPC_DRIVER_ID) continue;
    if (car.speed === 0 && car.slip === 0) continue;
    // The heading as a vector, from the yaw the wire carried. Two
    // transcendentals per patrol car per tick on a client, which is four of them
    // in the worst pursuit this game has, against the two `drivenCarPose`
    // already spends drawing one ordinary car.
    const dx = -Math.sin(car.yaw);
    const dz = -Math.cos(car.yaw);
    car.x += (dx * car.speed - dz * car.slip) * dt;
    car.z += (dz * car.speed + dx * car.slip) * dt;
    car.yaw += car.yawRate * dt;
  }
}

// --- The self-check ----------------------------------------------------------------------

/**
 * A `LaneRoute` made of literals, for the checks.
 *
 * Every field the decoder would have filled, with **no bays and both ends
 * flagged as chain joints** -- which is exactly what `traffic.buildParkPhases`
 * turns into "one cruise, no ramp, no dwell cap" and is the fixture a pursuit
 * wants: a piece of road, with a speed, that a car drives all of.
 *
 * Exported because `server/pursuit-check.ts` builds its street out of these and
 * a second copy of this function would be a second fixture that agreed with this
 * one on the day it was written.
 */
export function syntheticLaneRoute(
  rid: number,
  points: ReadonlyArray<readonly [number, number]>,
  speed = 11.1,
  laneY = 0,
): LaneRoute {
  const n = points.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const t = new Float32Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let clock = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = points[i][0] - points[i - 1][0];
      const dz = points[i][1] - points[i - 1][1];
      clock += Math.sqrt(dx * dx + dz * dz) / speed;
    }
    x[i] = points[i][0];
    y[i] = laneY;
    z[i] = points[i][1];
    t[i] = clock;
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (z[i] < minZ) minZ = z[i];
    if (z[i] > maxZ) maxZ = z[i];
  }
  return {
    rid,
    klass: 10,
    headway: 3600,
    phase: 0,
    duration: clock,
    count: n,
    x, y, z, t,
    minX, maxX, minZ, maxZ,
    mark: 0,
    joint0: true,
    joint1: true,
    chainX: (minX + maxX) * 0.5,
    chainZ: (minZ + maxZ) * 0.5,
    chainDwell: 0,
    parkT0: 0,
    outT: 0,
    inT: clock,
    parkT1: clock,
    outSpan: 0,
    outA: 0,
    outB: 0,
    inLen: 0,
    inSpan: 0,
    inA: 0,
    inB: 0,
    inC: 0,
    kerbShift0: 0,
    kerbShift1: 0,
    kerbOffX0: 0,
    kerbOffZ0: 0,
    kerbOffX1: 0,
    kerbOffZ1: 0,
    bay0: false,
    bay1: false,
    laneBay0: false,
    laneBay1: false,
    dwellCap0: 0,
    dwellCap1: 0,
    dwellCap: 0,
  };
}

/**
 * The synthetic graph the check drives: an L of three streets round two corners,
 * plus a spur, meeting at coincident vertices the way a real chain does.
 *
 *      A: (0,0) -> (0,-300)          north up the main road
 *      B: (0,-300) -> (240,-300)      east at the top
 *      C: (240,-300) -> (240,-540)    north again
 *      D: (0,-300) -> (-200,-300)     west, the wrong way, so a pick has to choose
 */
function graphFixture(): LaneRoute[] {
  return [
    syntheticLaneRoute(1, [[0, 0], [0, -100], [0, -200], [0, -300]]),
    syntheticLaneRoute(2, [[0, -300], [80, -300], [160, -300], [240, -300]]),
    syntheticLaneRoute(3, [[240, -300], [240, -400], [240, -540]]),
    syntheticLaneRoute(4, [[0, -300], [-100, -300], [-200, -300]]),
  ];
}

/**
 * The pursuit's arithmetic, asserted rather than looked at.
 *
 * Four claims and each is a sentence of the brief:
 *
 *   1. **The lane choice closes.** Walked node by node over `graphFixture`, the
 *      picker's chosen direction reduces the distance to a target at the far
 *      end of the L at every node, and the walk arrives.
 *   2. **The speed cap is the design.** A tight corner is taken slower than a
 *      sprint, a straight is not capped by the corner rule at all, and the road
 *      plus 30 % is what a straight actually asks for.
 *   3. **The stop-alongside rule.** A car driven at a stationary suspect comes
 *      to rest inside `PURSUIT_STOP_M` and does not roll on through them.
 *   4. **Determinism.** Six hundred ticks run twice from the same state produce
 *      the identical pose, bit for bit, which is the only thing that makes the
 *      pursuit safe to evaluate on two processes.
 */
export function verifyPursuitDriving(): string[] {
  const failures: string[] = [];

  // --- 1. The lane choice closes on the target at every node.
  {
    const routes = graphFixture();
    const choice = createPursuitChoice();
    const tx = 240;
    const tz = -540;
    // Start at the bottom of the main road, pointing north (-Z).
    let x = 0;
    let z = -4;
    let hx = 0;
    let hz = -1;
    let last = Math.sqrt((tx - x) * (tx - x) + (tz - z) * (tz - z));
    let steps = 0;
    let arrived = false;
    let regressed = 0;
    for (; steps < 200; steps++) {
      if (!pickOutgoing(routes, x, z, hx, hz, tx, tz, choice)) {
        failures.push('The picker found no lane from a point standing on the synthetic graph.');
        break;
      }
      // Walk the lookahead the pick produced, which is what the car does.
      const dx = choice.wx - x;
      const dz = choice.wz - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-4) {
        failures.push('The picker produced a waypoint on top of the car; the walk cannot advance.');
        break;
      }
      hx = dx / d;
      hz = dz / d;
      x = choice.wx;
      z = choice.wz;
      const now = Math.sqrt((tx - x) * (tx - x) + (tz - z) * (tz - z));
      // A node pick may not *always* close -- rounding a corner momentarily
      // does not -- but it must never be walking away, and the walk must arrive.
      if (now > last + 1) regressed++;
      last = now;
      if (now < PURSUIT_LOOKAHEAD_M) { arrived = true; break; }
    }
    if (!arrived) {
      failures.push(
        `The lane walk did not reach the target in ${steps} node picks; it stopped ` +
          `${last.toFixed(0)} m away. A greedy pursuit that cannot cross an L of three streets ` +
          'cannot cross a suburb.',
      );
    }
    if (regressed > 2) {
      failures.push(
        `The lane walk moved away from the target at ${regressed} of ${steps} nodes. The score is ` +
          'supposed to be the closing rate; more than a corner\'s worth of regression means it is not.',
      );
    }
    // And the wrong turn is genuinely available and genuinely refused: standing
    // at the junction, west (route 4) exists and must lose to east (route 2).
    if (pickOutgoing(routes, 0, -300, 0, -1, tx, tz, choice)) {
      if (choice.ex < 0.5) {
        failures.push(
          `At the junction with the target to the east the picker chose direction ` +
            `(${choice.ex.toFixed(2)}, ${choice.ez.toFixed(2)}), which is not the road that closes.`,
        );
      }
    } else {
      failures.push('The picker found nothing at a junction three routes meet at.');
    }
    // --- The U-turn rule, both halves, because it is a rule with an exception
    //     and asserting only the rule is how the exception went missing.
    //
    // Standing mid-street heading south with the suspect further south: the road
    // ahead closes, so the car does not turn round. That is the refusal.
    if (pickOutgoing(routes, 0, -150, 0, -1, 0, -290, choice)) {
      if (choice.ez > 0) {
        failures.push('The picker turned a car round in a street whose forward direction closes on the suspect.');
      }
    } else {
      failures.push('The picker found no lane mid-street.');
    }
    // ...and the same car with the suspect **behind** it: nothing forward
    // closes, so it turns round. Without this the pursuit drives away from
    // anybody who doubles back, which `server/pursuit-check.ts` section 2
    // measured as 275 m opened up inside a minute against a jog.
    if (pickOutgoing(routes, 0, -150, 0, -1, 0, -20, choice)) {
      if (choice.ez <= 0) {
        failures.push(
          'The picker kept driving south with the suspect to the north. A pursuit that cannot turn ' +
            'round is lost by walking backwards.',
        );
      }
    } else {
      failures.push('The picker found no lane at all with the suspect behind the car.');
    }
  }

  // --- 2. The speed rules.
  {
    // A tight corner, at the radius the design is stated at.
    const r = PURSUIT_TIGHT_RADIUS;
    const corner = syntheticLaneRoute(9, [[0, 0], [0, -r], [r, -r], [r * 2, -r]]);
    const cap = cornerSpeedAt(corner, 1, 1);
    if (!(cap < SPRINT_SPEED)) {
      failures.push(
        `A ${r} m corner caps the patrol car at ${cap.toFixed(1)} m/s against a sprint of ` +
          `${SPRINT_SPEED}. DESIGN.md says the chase is beaten by terrain and not by speed; at this ` +
          'number it is beaten by neither.',
      );
    }
    const straight = syntheticLaneRoute(10, [[0, 0], [0, -50], [0, -100], [0, -150]]);
    if (Number.isFinite(cornerSpeedAt(straight, 1, 1))) {
      failures.push('A straight road capped the corner speed; the curvature test sees a bend that is not there.');
    }
    const lane = laneSpeedAt(straight, 0, 1);
    if (Math.abs(lane - 11.1) > 0.2) {
      failures.push(`The lane speed read ${lane.toFixed(2)} m/s off a road baked at 11.1; the polyline is not being differentiated.`);
    }
    if (Math.abs(lane * PURSUIT_SPEED_MARGIN - 14.43) > 0.3) {
      failures.push('The road plus 30 % is not the road plus 30 %.');
    }
    // The floor covers a route that is all dwell, which is a red light.
    const light = syntheticLaneRoute(11, [[0, 0], [0, 0], [0, 0]]);
    if (laneSpeedAt(light, 0, 1) !== LANE_SPEED_FLOOR) {
      failures.push('A route of coincident vertices did not fall back to the lane speed floor; a pursuit would stop at a red light.');
    }
    // The stopping cap is the schoolbook one and reaches zero exactly.
    if (stoppingCap(0) !== 0) failures.push('The stopping cap is not zero with no slack; a car would not stop.');
    const s = stoppingCap(PURSUIT_STOP_M);
    if (Math.abs(s - Math.sqrt(2 * PURSUIT_BRAKE * PURSUIT_STOP_M)) > 1e-6) {
      failures.push('The stopping cap is not sqrt(2 a s).');
    }
    if (!(PURSUIT_TOP_SPEED > SPRINT_SPEED * 3)) {
      failures.push(
        `A patrol car tops out at ${PURSUIT_TOP_SPEED} m/s against a sprint of ${SPRINT_SPEED}. The ` +
          'straight line is supposed to be the half of the chase the player loses.',
      );
    }
  }

  // --- 3. The stop-alongside rule, driven through the real step.
  {
    const routes = graphFixture();
    const world = fixtureWorld(routes);
    const scratch = createPursuitScratch();
    const car = createPursuitCar(1, 7, 0, 0, -10, 0, -1);
    const tx = 0;
    const tz = -160;
    let range = Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      world.tick = i;
      range = stepPursuitCar(car, tx, tz, 0, world, 1 / 60, scratch);
      if (car.stopped) break;
    }
    if (!car.stopped) {
      failures.push(
        `A patrol car sent at a stationary suspect 150 m up a straight road never came to rest; ` +
          `it finished ${range.toFixed(1)} m away.`,
      );
    } else if (range > PURSUIT_STOP_M + 1.5) {
      failures.push(
        `The patrol car stopped ${range.toFixed(1)} m short of the suspect against a ` +
          `${PURSUIT_STOP_M} m rule. Its officers get out too far away to be a pursuit.`,
      );
    } else if (range < 2) {
      failures.push(
        `The patrol car came to rest ${range.toFixed(1)} m from the suspect, which is on top of them. ` +
          'The stopping cap is meant to leave room for two officers and a door.',
      );
    }
    // ...and it did not drive past them and come back.
    if (car.z < tz - 4) {
      failures.push(`The patrol car overshot the suspect by ${(tz - car.z).toFixed(1)} m before stopping.`);
    }
  }

  // --- 4. Determinism over 600 ticks, and the corner taken while they run.
  //
  // The suspect is put at a sprint round the junction of the L -- twenty metres
  // up to the corner and then sixty east -- so the ten seconds cover the whole
  // machine: a straight, a node pick that changes street, and a car closing on
  // somebody who is moving. Ten seconds at eight metres a second is a distance a
  // person can actually run, which matters: a fixture that teleported the
  // suspect faster than the car could drive would trip `PURSUIT_STALL_TICKS`
  // and prove nothing but that the give-up rule works.
  {
    const run = (): { car: PursuitCar; travelled: number } => {
      const routes = graphFixture();
      const world = fixtureWorld(routes);
      const scratch = createPursuitScratch();
      const car = createPursuitCar(1, 7, 0, 0, -200, 0, -1);
      let travelled = 0;
      for (let i = 0; i < 600; i++) {
        world.tick = i;
        const s = i / 600;
        const tx = s < 0.25 ? 0 : ((s - 0.25) / 0.75) * 60;
        const tz = s < 0.25 ? -280 - s * 4 * 20 : -300;
        const wasX = car.x;
        const wasZ = car.z;
        stepPursuitCar(car, tx, tz, 8, world, 1 / 60, scratch);
        travelled += Math.sqrt((car.x - wasX) * (car.x - wasX) + (car.z - wasZ) * (car.z - wasZ));
      }
      return { car, travelled };
    };
    const a = run();
    const b = run();
    for (const key of ['x', 'y', 'z', 'dx', 'dz', 'speed', 'slip', 'yawRate', 'wx', 'wz'] as const) {
      if (a.car[key] !== b.car[key]) {
        failures.push(
          `Six hundred ticks of pursuit run twice produced ${key} = ${a.car[key]} and ${b.car[key]}. ` +
            'A pursuit two processes disagree about is a pursuit that cannot be predicted.',
        );
        break;
      }
    }
    if (a.travelled !== b.travelled) {
      failures.push(`Two identical runs covered ${a.travelled} m and ${b.travelled} m.`);
    }
    // Ten seconds of chasing somebody at a sprint is at least fifty metres of
    // road, and a car that covered less than that did not drive: it parked, it
    // wedged, or it never picked a lane. A number rather than "> 0" because zero
    // is not the only way this fails silently.
    if (!(a.travelled > 50)) {
      failures.push(
        `Six hundred ticks of chasing a sprinting suspect covered ${a.travelled.toFixed(1)} m. ` +
          'The car did not drive.',
      );
    }
    // ...and it turned the corner with them rather than carrying on up the main
    // road, which is the node pick doing its job over ten seconds of real steps
    // instead of over the teleporting walk in block 1.
    if (!(a.car.x > 5)) {
      failures.push(
        `The car finished at x = ${a.car.x.toFixed(1)} against a suspect who turned east ` +
          'at the junction. It drove past the corner.',
      );
    }
  }

  return failures;
}

/** A `PursuitWorld` over a set of routes and nothing else. The checks' fixture. */
export function fixtureWorld(routes: readonly LaneRoute[]): PursuitWorld & { tick: number } {
  const field: { near(x: number, z: number, r: number, out: LaneRoute[]): LaneRoute[] } = {
    near(x, z, r, out) {
      out.length = 0;
      const r2 = r * r;
      for (const route of routes) {
        // The real broadphase is a grid; this is its answer without the grid,
        // which is the same set for a fixture of four routes.
        const cx = route.minX > x ? route.minX : route.maxX < x ? route.maxX : x;
        const cz = route.minZ > z ? route.minZ : route.maxZ < z ? route.maxZ : z;
        const dx = cx - x;
        const dz = cz - z;
        if (dx * dx + dz * dz <= r2) out.push(route);
      }
      return out;
    },
  };
  return {
    lanes: field as unknown as TrafficField,
    trafficTick: 0,
    tick: 0,
    groundHeight: () => 0,
    collision: null,
  };
}
