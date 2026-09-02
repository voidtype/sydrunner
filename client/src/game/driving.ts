/**
 * Taking a car, and what happens to the street once you have.
 *
 * The gameplay half, and three-free by rule so the Bun server runs this exact
 * file -- the split `game/bikes.ts` against `world/bike.ts` makes, and the one
 * `game/traffic.ts` makes against `world/cars.ts`. Nothing here imports three,
 * nothing here draws, and every number a driven car has is decided by a function
 * in this file running identically in the browser and on the server.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT A "CAR" IS: BOTH FLEETS, SINCE WORKSTREAM S.
 *
 * There are two fleets of cars in Sydney and they look the same on purpose:
 *
 *   - the **static** fleet, 1,402,623 of them baked into `<tile>.cars.bin` and
 *     drawn by `world/cars.buildTileCars`. Scenery. Never moves.
 *   - the **schedule** fleet, a closed-form lookup over `<tile>.lanes.bin`
 *     (`game/traffic.poseCar`), which since the park stages landed spends a good
 *     part of each car's life *stationary in a kerb bay*, at which point
 *     `world/cars.ts`' own header says it is "indistinguishable from the 23,020
 *     already at that kerb".
 *
 * **Both are takeable now, and this paragraph used to say the opposite.** What
 * it said, for three rounds, was that only a schedule car could be stolen
 * because *"the server has no idea the first one exists"* -- `.cars.bin` was a
 * renderer file, `server/world.ts` streamed prisms and lane sidecars and nothing
 * else, and a client naming a car the server could not see is a client that can
 * conjure a vehicle. It also said what the fix would cost: *"a third streaming
 * layer over 13,362 files"*. The owner's report -- *"i also seem to no longer be
 * able to steal cars"* -- is what that deviation actually felt like from inside
 * the game. `server/take-check.ts` measured the take at 188 grants out of 188
 * presses; the cars a player walks up to are the twenty-three thousand, not the
 * forty, so the feature was green and unreachable.
 *
 * So the third layer exists: `game/staticcars.ts` holds the decoder and the
 * field, `server/world.ts`' `HexResidency` streams `.cars.bin` per hexagon under
 * `SYDNEY_STATIC_CARS_CAP_MB` beside the prisms and the lanes, and
 * `resolveTake` below asks **two** sources at the same instant and takes the
 * nearer answer. The anti-cheat story does not change by a word: `INPUT` still
 * carries ten bytes of buttons and a look direction, there is still no field in
 * which a client could name a car, and a take is still a question asked with a
 * button and answered against the server's own copy of the world.
 *
 * The schedule fleet's rule is unchanged -- **stopped or under `TAKEABLE_SPEED`**,
 * which catches a car in a park stage at the kerb, one held at a red light and
 * one easing out of a bay. A static car has no speed at all: it is furniture,
 * and every one of them qualifies.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CAR YOU ARE DRIVING IS NOT A NEW BODY. IT IS YOUR BODY, GEARED.
 *
 * The obvious implementation is a second integrator -- a chassis, a wheelbase,
 * a slip angle, a `stepCar` beside `controller.step`. `game/bikes.ts` already
 * argued that one out and refused it, and the argument is stronger here, not
 * weaker: a fork is a thing the server has to reproduce exactly, that
 * `net/client.reconcile`'s replay has to run over every un-acked input, and
 * whose first disagreement shows up as a car rubber-banding at 44 m/s.
 *
 * So there is no fork. What this file integrates is **one number** -- the car's
 * signed speed along its own heading -- and then it hands that number to the
 * *existing* controller as a target:
 *
 *     stepCarSpeed(c, input, dt, world)     // c.carSpeed += a . dt, clamped
 *     shapeDriveInput(c, movement)          // speedScale = |carSpeed| / SPRINT
 *
 * `controller.step` then accelerates the body at its usual 48 m/s^2 toward a
 * target speed that is already the car's, which in one tick is a snap -- so the
 * *body* moves at exactly the speed this file decided, through exactly the
 * collision, ground-follow, step-up and gravity every player already gets. A
 * car stops at a wall because a player stops at a wall. Nothing new is on the
 * simulation path except one scalar, and the scalar is a pure function of
 * (previous scalar, buttons, dt) evaluated the same way on both ends.
 *
 * The **steering** is `game/bikes.shapeRideSteering`'s trick verbatim: `A`/`D`
 * become a yaw delta on the client's own look, which is already a
 * client-authoritative input (`protocol.INPUT_BYTES` carries `yaw`), so the
 * server receives a driver who is simply looking somewhere new and runs the
 * step it always ran. Prediction is exact by construction rather than by
 * agreement.
 *
 * What this costs, and it is a real cost stated plainly: the car collides as a
 * 0.34 m player capsule and not as a 4.4 m box. A car can therefore thread a
 * gap no car should fit through. `stepCarSpeed` buys most of that back with a
 * **nose probe** -- one `resolve` call at the far end of the bonnet, which kills
 * the speed when the front of the car is inside something even though the
 * driver's capsule is not -- and that is where the "3 or 4 capsules along its
 * axis" of the brief ended up: two, one of which is the player's own.
 *
 * ---------------------------------------------------------------------------
 * 3. THE AMBIENT CAR HAS TO GO AWAY, AND IT IS A PREDICATE AND NOT A DELETE.
 *
 * A schedule car is a lookup, not an object. There is nothing to remove: the
 * moment you drive off in one, `poseCar` cheerfully keeps producing the original
 * on its timetable, and the street has two of your car in it -- one you are
 * steering and one continuing to Ashfield without you.
 *
 * The fix is the same shape `world/carlod.ts` already uses to stop a model and a
 * box being drawn in one parking space: a **predicate consulted inside the loop
 * that was already running**. `CarField.suppressed(identity)` answers "somebody
 * has taken this one", and it is asked by `world/cars.TrafficMovers.update`
 * (so no box, no headlights, no model claim), by `world/carlod.CarModelFleet`
 * (so an existing claim goes stale and is revoked on its own two-frame rule) and
 * by `game/traffic.carHitting` on **both ends** (so the ghost does not run
 * pedestrians down from inside the car you are sitting in).
 *
 * `identity` is `traffic.identityOf(route, slot)`, a stable 32-bit hash of the
 * route id and the departure -- exactly the "route id + departure" the brief
 * asked the record to carry, already computed, already agreed by every process
 * that read the same world.
 *
 * **A static car is suppressed by the same predicate and it is even simpler**,
 * because a static car is not a lookup that keeps producing: it is an instance
 * matrix in a tile's `InstancedMesh` and a row in a `StaticCarField`. Its
 * identity is `traffic.staticCarIdentity(tileKey, index)`, which goes on the same
 * `DrivenCar.carId` and through the same `MSG.CARS` `u32`, so every consumer of
 * `suppressed` covers it with no new code: `world/carlod.CarModelFleet` folds the
 * box flat (`hideSuppressedStatics`, which is the one *new* consumer, because a
 * box has to be un-drawn where a lookup only has to be not-asked),
 * `traffic.LaneObstacles` already tests `o.identity` against `suppress` for its
 * static half, and `resolveTake` refuses an identity somebody has.
 *
 * And when the record is recycled (`recycleFarthest`, section 6) the static car
 * is simply **there again**, in its bay, at the identity it always had -- no
 * state, no respawn, nothing to restore beyond the instance matrix `revoke`
 * writes back. That is the same "handed back rather than deleted" property the
 * schedule fleet has, arrived at from the other direction.
 *
 * ---------------------------------------------------------------------------
 * 4. WHO OWNS WHAT.
 *
 * `CarField` is `game/bikes.BikeField` with three differences and they are all
 * consequences of a car being *allocated* where a bike is *planned*:
 *
 *   - **Ids are handed out at runtime, not derived.** There is no `carPlan`,
 *     because the set is not fixed: it is however many cars have been stolen and
 *     not yet expired. So the server allocates `1..n` and the client mirrors
 *     what it is told. That is why `MSG.CARS` carries a delete flag where
 *     `MSG.BIKES` needs none.
 *   - **A record can end -- but only when the room runs out of them.** This used
 *     to be a five-minute abandonment clock and it is now a *budget*. See
 *     section 6.
 *   - **`follow` carries the pose from the driver**, not the other way round.
 *     The brief is explicit and it is also the only affordable answer: the
 *     driver's position and yaw are already in the 20 Hz snapshot, so a car that
 *     is derived from them costs zero bytes a tick, where a car with its own
 *     pose on the wire costs a record per car per snapshot forever.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM.
 *
 * Everything on the shared path is `+ - * /`, `Math.min/max/abs`, and `Math.imul`
 * by way of `traffic.carHash`. There is no `Math.sin`, `cos`, `pow` or `hypot`
 * in `stepCarSpeed`, `shapeDriveInput`, `driveTurnRate` or `CarField`. The two
 * `Math.atan2` calls in this file are both in `headingYaw`, which is called
 * *once*, in the browser, on the frame you get in, to point your head down the
 * street -- a look direction, which is client-authoritative anyway.
 *
 * `crashDamage` is one subtract, one multiply and two comparisons, for the same
 * reason: the server decides how much a crash cost and the driver's client
 * predicts the identical number off the identical delta-v, so the health bar
 * moves on the frame you hit the wall rather than 50 ms later.
 *
 * ---------------------------------------------------------------------------
 * 6. CARS DO NOT DESPAWN. THEY ARE RECYCLED, AND ONLY WHEN THE ROOM IS FULL.
 *
 * The five-minute abandonment clock is gone. The owner's words were "cars no
 * longer despawn but are broadly REAlistic and consistent when nearby", and the
 * clock was the opposite of both halves: a car you parked outside your flat and
 * came back to was simply not there, and there was no rule a player could learn
 * about when it would and would not be.
 *
 * What replaces it is a **budget**, `MAX_DRIVEN_CARS` per room, and a rule for
 * what gives when it is reached. The rule is written here because it is the only
 * part of this feature a player can be surprised by:
 *
 *   - **Nothing occupied is ever recycled.** Obvious, and it is still the first
 *     clause, because the failure is a car vanishing out from under a driver.
 *   - **Nothing within `RECYCLE_KEEP_RADIUS` of anybody is ever recycled**, and
 *     250 m is well outside the 180 m interest radius and the 420 m the traffic
 *     is *drawn* at is the wrong number to use -- what matters is that nobody
 *     can be looking at the thing that disappears, and a car 250 m away behind
 *     four terraces is not something anybody is looking at.
 *   - **Of what is left, the farthest from everybody goes**, and the longest
 *     unoccupied breaks the tie. Distance first rather than age first because
 *     "the one nobody is anywhere near" is the property that makes the removal
 *     invisible, and age is the property that makes it *fair*.
 *   - **A recycled record is not deleted from the world**, it is handed back:
 *     the ambient car it was made from was only ever suppressed (section 3), so
 *     dropping the record puts a car back on that timetable. The street it was
 *     standing in gets a car driving through it again, which is exactly what was
 *     there before anybody stole it.
 *
 * At 400 records and 27 bytes each, a joiner's full `MSG.CARS` is 12.4 kB, which
 * is the whole cost of the change and is sent once on a connection that has just
 * pulled down a megabyte of collision prisms. The server's cost is a `Map` of
 * 400 objects -- around 60 kB on a 1 GB box -- and the per-tick work is
 * unchanged, because every sweep in this class was already O(records) and 400 is
 * still counted in hundreds.
 */

import type { InputSnapshot } from '../player/controller.ts';
import { CAR_HEALTH_FULL } from '../net/protocol.ts';
import {
  // WORKSTREAM T: `verifyDriving` derives `CRASH_QUERY_RADIUS` from the body
  // table rather than trusting the literal, so a sixth body cannot outgrow it.
  CAR_BODY_SIZE,
  CAR_HEALTH_FULL_POSE,
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  HOLD_GAP,
  type CarPose,
  type LaneRoute,
  type TrafficField,
  createCarPose,
  // WORKSTREAM T: `crashIntoTraffic` fills a driven car's box from the same
  // function the knockdown test does, so "a car hit a car" is one geometry.
  drivenCarPose,
  forEachCarNear,
} from './traffic.ts';
// WORKSTREAM S: the parked fleet, as a source `resolveTake` can ask. A type-only
// import, so nothing about this file's dependency graph changes -- the *field*
// lives in `game/staticcars.ts` and is constructed by whoever owns a world.
import type { StaticCarSource } from './staticcars.ts';
// --- WORKSTREAM W (talent effects). Every read below is the identity with no
// `TeamLookup` installed, which is why `verifyDriving` and `verifyDamageGrade`
// needed no change. See `game/teamfx.ts`.
import { fxCarDamageScale, fxCrashCooldownS, fxRamFreeCrash, fxWreckLimpSpeed } from './teamfx.ts';
// --- WORKSTREAM Y (cars catch fire). The rules for what happens after a car is
// finished, in a module of its own -- see `game/carfire.ts` section 1 for why it
// is not more of this file, and section 2 for why the countdown is milliseconds
// this file's `age` sweep walks rather than a stamp.
//
// **The dependency runs this way and only this way.** `carfire.ts` restates
// `CAR_HEALTH_MAX` and `CAR_SMOKING_HEALTH` rather than importing them, because
// the ignition rule lives inside `CarField.damage` -- the one funnel every
// impact goes through -- and an import back the other way would be a cycle whose
// consumers are top-level `const`s. `verifyDriving` cross-checks the restated
// pair, which is the arrangement `SPRINT_SPEED` has with the controller.
import {
  BURN_HP_PER_S,
  CAR_HEALTH_FULL_FIRE,
  CAR_SMOKING_HEALTH_FIRE,
  // WORKSTREAM AP: the third restated constant, cross-checked below.
  CRASH_CAP_FIRE,
  FUSE_MS,
  IGNITE_CRASH_HP,
  IGNITE_LOCK_MS,
  NOT_BURNING,
  burningFromFuse,
  canIgnite,
  fuseExpired,
  ignitesOnCrash,
  isBurning,
} from './carfire.ts';

// --- The handling ---------------------------------------------------------------

/**
 * Top speed on a road, metres per second. **44 is 158 km/h.**
 *
 * *"make cars top velocity 100% faster"*, and the doubling is the whole of this
 * constant's current history: it was 22 (79 km/h), which was the original
 * brief's number and was chosen to sit a shade *under* the e-bike's 26.2 m/s so
 * that a lime bike stayed the fast way across the city.
 *
 * That trade is now deliberately the other way round, and it is worth stating
 * because the old paragraph argued the opposite at length. A car at 44 m/s
 * comfortably outruns the bike, and what the bike keeps instead is everything
 * the top speed was never the point of: it fits down a laneway, it turns inside
 * five metres at any speed (see `DRIVE_TURN_RATE_FAST` for what a car at 44 m/s
 * cannot do), it is parked on every second corner, and taking one is not a
 * crime. The car's 44 is a *highway* number -- the Cahill, the Anzac Bridge,
 * Southern Cross Drive -- and on a CBD block you will never see the top of
 * third gear.
 *
 * **Every deceleration constant below is doubled with it** so that each
 * time-to-stop is unchanged (see `DRIVE_BRAKE`), and the acceleration is
 * deliberately *not*, so the car takes twice as long to reach twice the speed --
 * which is what a power-limited top-end raise physically means and is the only
 * version where the new speed is something you build up to rather than something
 * you are handed on the first press of W.
 */
export const DRIVE_TOP_SPEED = 44;

/**
 * And off the carriageway. Half, because a sedan across a park is not a rally
 * car and the alternative -- driving being identical everywhere -- makes the
 * road network cosmetic.
 *
 * **Derived rather than written down**, which it was not before: it was the
 * literal 11 beside a literal 22, and the pair of them is exactly the kind of
 * thing that survives one of the two being doubled. The rule is the sentence
 * above -- *half* -- and the rule is now the code.
 *
 * Whether you are on a road is `DrivingWorld.onRoad`, which both ends answer
 * from the same lane graph, and which is **optional**: a world that cannot say
 * counts as road. That is the correct failure. A client whose lane sidecar has
 * not streamed in yet would otherwise crawl for a second on a street the server
 * knows is a street, and the correction for that is a visible lurch.
 */
export const DRIVE_TOP_SPEED_ROUGH = DRIVE_TOP_SPEED * 0.5;

/**
 * Metres per second squared under throttle. **0 to 44 m/s in 7.3 s.**
 *
 * Unchanged by the doubling, and that is the decision rather than an oversight:
 * the run to the top is now twice as long in time and four times as long in
 * distance (161 m against 40), so the top speed is a thing a straight road gives
 * you rather than a thing every press of W hands over. It is also what keeps
 * the *first* three seconds of driving feeling exactly as they did, which is
 * most of the driving that happens in this city.
 *
 * 7.3 s is a shade over the ~7 s the instruction asked for and is the price of
 * leaving the constant alone; the alternative was 6.3 m/s^2, a number with no
 * argument behind it that would have moved the low-speed feel to buy 0.3 s at
 * the top.
 */
export const DRIVE_ACCELERATION = 6;

/**
 * And on the brake -- `S` against a forward speed. Three times the throttle,
 * which is what makes `S` read as a brake pedal rather than as a reverse gear
 * you have to wait for.
 *
 * **Doubled with the top speed, from 9**, and the invariant it is holding is the
 * *time* on the pedal rather than the distance: 22/9 was 2.4 s from the top and
 * 44/18 is 2.4 s from the new one. The stopping distance doubles with the speed,
 * from 27 m to 54 m, which is the honest consequence of going twice as fast and
 * is the thing a driver has to learn. Holding the *distance* instead would have
 * needed 36 m/s^2 -- nearly 4 g -- and a car that stops dead from 158 km/h in
 * the length of a terrace is a car with no weight in it at all.
 */
export const DRIVE_BRAKE = 18;

/**
 * Reverse top speed, as a fraction of the forward one. `game/bikes.RIDE_REVERSE`'s
 * number and its argument: the same key means "slow down" first and "back out of
 * this laneway" second.
 *
 * **Still 30 %**, on instruction, which is now 13.2 m/s -- and that is worth a
 * line because 47 km/h in reverse is quick. It is kept as a fraction rather than
 * pinned to the old 6.6 m/s absolute because the clause it exists for is "a
 * reversing speed rather than a manoeuvre nobody asked for", and what makes
 * reverse feel like reverse is that it is visibly a third of forward, not that
 * it is any particular number of metres a second. Reverse is also the one gear
 * with no acceleration advantage: `DRIVE_ACCELERATION` is unchanged, so it takes
 * 2.2 s to reach and you are on the brake (18 m/s^2) the moment you press W.
 */
export const DRIVE_REVERSE = 0.3;

/**
 * Engine braking, with no key held at all.
 *
 * Small on purpose: a car that shed its speed as fast as it gained it would
 * never coast, and coasting is most of what driving in a city is. **Doubled
 * with the top speed, from 2.2**, on `DRIVE_BRAKE`'s rule -- at 4.4 m/s^2 a car
 * at the top speed still rolls for the ten seconds the old number gave it, and
 * now covers 220 m doing it. Leaving it at 2.2 would have been twenty seconds
 * of a car refusing to slow down, which is the one failure mode of engine
 * braking a player reads as the throttle being stuck.
 */
export const DRIVE_COAST = 4.4;

/** Space. Nearly twice the brake, and it works against a reverse too. Doubled from 16. */
export const DRIVE_HANDBRAKE = 32;

/**
 * How fast the wheel turns at a crawl, radians per second, and at the top speed.
 *
 * `game/bikes.rideTurnRate`'s shape and for its stated reason -- what a driver
 * holds constant across the range is the turn *radius*, and a linear `w(v)`
 * against a linear `v` is the closest a one-line function gets to that. The
 * crawl number is heavier than the bike's 1.6 because a car is heavier than a
 * bike: at 5 m/s the radius is 4.3 m, which is a three-point turn.
 *
 * **`DRIVE_TURN_RATE_FAST` came down from 0.5 to 0.33 when the top speed
 * doubled, and that is the one constant in this block the doubling could not
 * simply scale.** The quantity a car actually runs out of in a corner is
 * *lateral acceleration*, which is `v x w` -- so leaving the rate alone while
 * doubling the speed would have doubled it too:
 *
 *     22 m/s x 0.50 rad/s = 11.0 m/s^2   (1.1 g)  -- the old top-speed corner
 *     44 m/s x 0.50 rad/s = 22.0 m/s^2   (2.2 g)  -- a slot car, or a spin
 *     44 m/s x 0.33 rad/s = 14.5 m/s^2   (1.5 g)  -- this
 *
 * 1.5 g is still well past a real sedan and is the arcade allowance this game
 * has always taken; 2.2 g is the point at which the car stops reading as having
 * mass and starts reading as a cursor. The radius at the top is 133 m, which is
 * a motorway sweeper -- you cannot take a Sydney street corner at 158 km/h, and
 * that is the correct answer rather than a limitation. `verifyDriving` asserts
 * both the radius and the lateral figure, because the failure here has no
 * picture that says so: a car that corners at 2 g simply feels *good* to whoever
 * tuned it and wrong to everybody else.
 */
export const DRIVE_TURN_RATE = 1.35;
export const DRIVE_TURN_RATE_FAST = 0.33;
/** Where the ramp bottoms out. The top speed, so nothing in normal play is clamped. */
export const DRIVE_TURN_FULL_SPEED = DRIVE_TOP_SPEED;

/**
 * Below this speed the wheel does less and less, metres per second.
 *
 * The one thing this steering model has that the bike's does not, and it exists
 * because a bike genuinely can be turned on the spot and a car cannot. Without
 * it a stationary car spins like a turntable when you hold `D`, which is the
 * single most arcade-looking thing a car can do. Linear in speed up to 2.5 m/s,
 * so a car creeping out of a bay steers a little and a parked one not at all.
 */
export const DRIVE_TURN_GRIP = 2.5;

// --- Taking one ------------------------------------------------------------------

/**
 * How close to a car you have to be, metres. `game/bikes.MOUNT_RADIUS` exactly,
 * and deliberately the same number: `E` has one meaning in this game and one
 * reach, and a car you can stand beside and not take -- because cars used a
 * different constant -- is a bug report.
 */
export const TAKE_RADIUS = 2.2;

/** And the vertical gate, `bikes.MOUNT_HEIGHT`'s. A car under a viaduct is not yours. */
export const TAKE_HEIGHT = 2.5;

/**
 * How slow a car has to be going before you can pull the door open, m/s.
 *
 * The brief's 3. Parked is 0, a red light is 0, a pull-out ramps through this in
 * about a second, and anything on a green is well past it -- so what this
 * actually says is "stopped, or nearly". Not zero, because a car creeping the
 * last 20 cm into a bay is stationary to a player and 0.4 m/s to `poseCar`, and
 * the failure of an exact test is pressing E at a car that is obviously parked
 * and getting nothing.
 */
export const TAKEABLE_SPEED = 3;

/**
 * How far a pedestrian can be and still see you break into a car, metres.
 *
 * The brief's 15, and the line of sight is checked by the caller against the
 * same `collision.blocked` `factions.policeWitness` uses -- see
 * `bystanderSeen`. A crime nobody saw is not reported, which is the whole of
 * why this number exists: stealing a car at 3 a.m. on a back street in Marrickville
 * should be different from stealing one outside Town Hall at lunchtime.
 */
export const WITNESS_RADIUS = 15;

/** Eye height for the witness ray, and chest height at the crime. `factions.ts`' pair. */
export const WITNESS_EYE = 1.5;
export const CRIME_HEIGHT = 1.0;

// --- Leaving one, and never getting it back ----------------------------------------

/**
 * How many taken cars one room holds. See section 6 of the header.
 *
 * 400, and the number is set by the wire rather than by taste: a joiner is sent
 * every record in one `MSG.CARS`, at `protocol.CAR_RECORD_BYTES` apiece, and 400
 * is 12.8 kB (12.4 before the fire's fuse byte) -- one burst on a socket that has just carried the
 * whole collision stream. Ten times that would be a joiner stalling on a car
 * list, and a tenth of it would be a busy room recycling cars people can
 * remember parking.
 */
export const MAX_DRIVEN_CARS = 400;

/**
 * How close somebody has to be for a car to be safe from recycling, metres.
 *
 * The brief's 250. Deliberately larger than the old abandonment radius's 60,
 * because this is a rarer and more surprising event: an abandonment clock ran on
 * every car and this runs only when the four hundredth car is taken, so the one
 * that goes should be somewhere nobody could possibly be looking. 250 m is past
 * the 180 m interest radius and past any street you can see down in this city.
 */
export const RECYCLE_KEEP_RADIUS = 250;

/**
 * How close to a kerb bay a car has to stop to be snapped into it, metres.
 *
 * The brief's 3, and the whole of the difference between a car that reads as
 * *parked* and one that reads as *abandoned*. The bays are the ones
 * `pipeline/sydney/bays.py` arbitrated -- see `traffic.nearestBay` -- so this is
 * a snap onto an existing ledger and never an invented parking space.
 *
 * A snap and not a pull: outside this radius the car stays exactly where it was
 * left, in the lane, and the traffic queues behind it. That is the other half of
 * the same feature and the two have to disagree cleanly.
 */
export const PARK_SNAP_RADIUS = 3;

// --- Crashing one ------------------------------------------------------------------

/**
 * A car nobody has hit anything with. `traffic.CAR_HEALTH_FULL_POSE` and
 * `protocol.CAR_HEALTH_FULL` are the same number; `verifyDriving` asserts it.
 *
 * A hundred rather than the player's five pips, and the difference is the point:
 * a player's health is a *countable* resource you read at a glance, and a car's
 * is a continuous one you read as a bar. The damage curve below produces
 * fractions of it that no pip count could express -- an 8 m/s clip is 30 and a
 * 4 m/s kerb is 6 -- and rounding those into five buckets would make every
 * second crash free.
 */
export const CAR_HEALTH_MAX = 100;

/**
 * Below this delta-v a collision costs nothing, m/s. **Twelve, and it used to
 * be five.** The owner's *"make the threshold much higher"*.
 *
 * It is not "no damage below 12", it is **"12 m/s of every impact is free"** --
 * the curve is `(dv - 12) x 0.4` and not `dv x 0.4` above a threshold, so there
 * is no step at the boundary. That continuity is the same requirement
 * `traffic.carHitStrength`'s header states for the knockdown and it is here for
 * the identical reason: a threshold makes the last centimetre of a nudge the
 * difference between nothing and a dent, and a player who kerbed at 11.9 m/s
 * twice and got two different answers is a player who thinks the damage is
 * random.
 *
 * **Why it moved again.** The report was *"its way too easy to take vehicle
 * damage ... even small bumps in a road alone are giving damage"*, and this
 * constant is the tuning half of that sentence. (The other half was a *bug* and
 * is fixed in `stepCarSpeed`'s nose probe, which was asking the collision world
 * a question with no step allowance in it and therefore reading every kerb in
 * Sydney as a wall. Neither fix substitutes for the other: the probe fix stops
 * free-standing geometry inventing crashes, and this number decides what a
 * crash that really happened is worth.)
 *
 * **Twelve is chosen against the nose probe rather than against the speedo**,
 * which is the one piece of arithmetic worth carrying in your head here. The
 * probe reports `NOSE_SHED` -- two thirds -- of the road speed as the delta-v,
 * so a free allowance of 12 m/s of *impact* is a free allowance of
 * `12 / 0.66 = 18.2 m/s` of *driving into something*, which is 65 km/h. Read
 * plainly: **you can drive into a wall at suburban speed and the car does not
 * care.** Kerbs, bollards, the car in front, mounting a gutter to park, a
 * bridge joint, and the whole of the way anybody actually drives through a city
 * are under it. What is left above it is what the word crash is for.
 *
 * The previous paragraph here tied the five to `TAKEABLE_SPEED`'s 3 "with a
 * margin". That tie is gone for good and the reason is the same one it was cut
 * for the first time: the two answer different questions, and a number that
 * serves two is a number nobody can move.
 */
export const CRASH_FREE_SPEED = 12;

/**
 * Health lost per metre per second of impact past the free allowance. **0.4,
 * and it used to be 3.2.**
 *
 * The middle number of the second retune, and the three that moved together are
 * again worth reading as one change:
 *
 *     free speed   5    ->  12     everything up to 18 m/s of road speed is free
 *     per m/s      3.2  ->  0.4    what is left costs an eighth of what it did
 *     cap          45   ->  7      no single impact is a twelfth of a car
 *
 * What the pair (12, 0.4) is chosen to produce is the owner's own number: **a
 * full-throttle square wall costs 6.8 hp of 100.** `DRIVE_TOP_SPEED` is 44,
 * `NOSE_SHED` makes that 29.04 m/s of delta-v, and `(29.04 - 12) x 0.4` is
 * 6.816 -- fifteen flat-out runs at a brick wall to write off a healthy car,
 * against the two the old curve took.
 *
 * **The brief asked for two things that cannot both be true, and this is the
 * record of which one won.** It asked for the per-speed number to be divided by
 * "roughly 30" *and* for a 44 m/s wall to cost 5-8 hp. At `3.2 / 30 = 0.107` the
 * same wall costs 1.8 hp, which is under the floor of the stated range: with the
 * free allowance at 12 there is only 17 m/s of curve left above it, so the
 * divisor and the worked example are fighting over the same 17. The **worked
 * example won**, because it is the one a player can feel and the one the checks
 * can assert.
 *
 * And the divisor is honoured anyway, in the only sense that matters, which is
 * what a crash actually costs across the band people drive in:
 *
 *     road speed   old cost   new cost   ratio
 *     10 m/s        5.1        0         free
 *     15 m/s       15.7        0         free
 *     20 m/s       26.2        0.48        55x
 *     25 m/s       36.0        1.4         26x
 *     30 m/s       45 (cap)    3.1         14x
 *     44 m/s       45 (cap)    6.8        6.6x
 *
 * Twenty to fifty times, exactly as asked, everywhere except the deliberate
 * flat-out ram -- which is the one impact that *should* still hurt, and which no
 * driver arrives at by accident.
 *
 * The curve still compounds in the forgiving direction: a car under
 * `CAR_SMOKING_HEALTH` is capped at `CAR_SMOKING_SCALE` of the top speed, so its
 * next crash is slower than its last. At the new numbers that compounding is
 * severe and it is worth knowing about -- a smoking car cannot exceed 26.4 m/s,
 * which is 17.4 m/s of delta-v and 2.2 hp a run, so the last forty health of a
 * car takes about eighteen more runs at the wall. A car takes some killing now.
 * That is the feature.
 */
export const CRASH_DAMAGE_PER_SPEED = 0.4;

/**
 * The most one impact can cost, however fast you were going. **7, from 45.**
 *
 * **Its job changed with its value, and that is the interesting half.** At 45
 * the cap existed to stop a *wall* being fatal: a top-speed nose probe reported
 * 77 hp of raw curve and the cap clipped it to 45. At 7 the wall does not reach
 * it at all -- a flat-out square hit is 6.816 and lands just under -- so the
 * only thing left in the game that can saturate this number is **two cars
 * closing on each other**, where `closingAlong` adds both speeds and a genuine
 * head-on reports up to 88 m/s. That is what the cap is for now: the worst
 * thing two players can do to each other costs the same 7 as the worst thing one
 * player can do to a wall, and neither is a write-off.
 *
 * Seven of a hundred, said the other way: **fifteen worst-possible impacts to
 * finish a car**, and the smoking penalty stretches that to about twenty-seven
 * in practice. The old value was 45, which was two and a bit.
 *
 * The tidy property this constant used to have -- `CAR_HEALTH_MAX -
 * CRASH_DAMAGE_MAX` landing on `CAR_SMOKING_HEALTH` -- was already given up at
 * 45 and is not coming back. One maximal crash now leaves a car on 93.
 */
export const CRASH_DAMAGE_MAX = 7;

/**
 * How little a purely sideways impact costs, as a fraction of a square one.
 *
 * **The glancing-blow rule**, and the shortest statement of what it is for is
 * the case it was written for: dragging a wing along the side of a building at
 * 40 m/s is not the same event as driving into the end of it at 40 m/s, and
 * before this constant existed the game charged the same for both.
 *
 * The multiplier is `|cos|` between the contact normal and the car's own
 * heading, floored here so that even a pure scrape costs something -- a floor of
 * zero would make a wall you were parallel to completely free, which is an
 * exploit (drive down a street at full speed with one wing on the shopfronts)
 * and also just wrong.
 *
 * **It multiplies the damage rather than the delta-v**, and that is the one
 * decision in this rule worth arguing. Scaling the *speed* before the curve is
 * the physically honest reading -- only the normal component of the closing
 * velocity is destructive -- and it was rejected for two reasons. It interacts
 * with the free allowance in a way nobody can predict from inside the game (at
 * the retuned allowance of 12 a 34 m/s scrape would come out at exactly zero,
 * because `34 x 0.35` is 11.9 -- so a scrape at 30 and one at 34 are both free
 * and one at 35 is not, and raising the allowance made that cliff *wider*
 * rather than narrower), and it makes `CRASH_DAMAGE_MAX` unreachable for any impact that is
 * not perfectly square, which turns the cap into a constant that only describes
 * one geometry. Multiplying the clamped damage keeps `crashDamage(dv, 1)`
 * exactly the documented curve and makes the glancing factor a clean single
 * multiplier that composes with `Ute Life` the way every other modifier does.
 *
 * **Only the wall path supplies one.** Car against car already carries its own
 * cosine: `closingAlong` projects both velocities onto the line between the two
 * cars, so a sideswipe reports a small closing speed by construction and
 * applying the factor again would charge for the same angle twice. See
 * `stepCarSpeed`'s nose probe, which is the one impact in this game that is
 * detected as a boolean and therefore cannot tell a scrape from a head-on.
 */
export const GLANCING_FLOOR = 0.35;

/**
 * How long after an impact the next one is free, milliseconds. The brief's 0.5 s.
 *
 * Without it, dragging a wing along a wall is a collision resolve *every tick*
 * -- sixty impacts a second, each a metre or two per second of delta-v, which
 * writes a car off in about a second of scraping. One cooldown per car rather
 * than one per kind of impact, because two clocks would be two fields of state
 * for a distinction nobody can perceive: what a player notices is that a bump
 * costs a bump's worth, not which of two counters was running.
 */
export const CRASH_COOLDOWN_MS = 500;

/**
 * What running somebody down costs the car. **0.5, and it used to be 2.**
 *
 * The brief: "the human is the one hurt". A pedestrian is not a wall, and a game
 * where mowing down a crowd wrecked your car would be a game telling you not to
 * -- which is not the game `traffic.applyCarHit` and the owner's stated
 * fondness for being run over describe.
 *
 * **It moved because the wall got cheap, and what this constant means is a
 * ratio rather than an absolute.** Against the old 45 hp cap, two was 4% of the
 * worst impact in the game and read exactly as intended: a mark, not an event.
 * Left at two against the new cap of 7 it would be 29% of the worst impact -- a
 * pedestrian costing a third of a flat-out wall -- and mowing down a crowd
 * would quietly become the fastest way to destroy a car, which is the opposite
 * of what the paragraph above it promises. 0.5 restores the ratio (7%) and with
 * it the sentence: two hundred pedestrians to a write-off is not a route
 * anybody will take.
 */
export const PEDESTRIAN_DAMAGE = 0.5;

/**
 * At or below this the paint is dented and one headlight is out. The brief's 70,
 * **unchanged by WORKSTREAM AP and worth a line about why.**
 *
 * The owner's ask was *"cars should last 20-50 times longer in my hands"*, and
 * the honest way to grant it was to make the *crashes* cheap rather than to move
 * the bands they cross. So this is still 70 and what changed is how far away it
 * is: a dent used to arrive on the first heavy wall and now takes five
 * flat-out runs at one (6.816 hp each -- see `CRASH_DAMAGE_PER_SPEED`).
 *
 * That makes the visual ladder rarer, which is the intended cost and not an
 * oversight: a dented car is supposed to mean *this driver has had a bad
 * afternoon*, and it meant *this driver has hit one thing* until now.
 * `verifyDamageGrade` asserts the grade off these thresholds rather than off any
 * crash number, so it needed no retune at all.
 */
export const CAR_DENTED_HEALTH = 70;
/**
 * At or below this the bonnet smokes and the car is slow. The brief's 40, and
 * unchanged for `CAR_DENTED_HEALTH`'s reason.
 *
 * Nine flat-out walls away rather than one, and it is the point at which the
 * retune starts compounding: `CAR_SMOKING_SCALE` caps a car past this line at
 * 26.4 m/s, which is only 2.2 hp a crash, so the last forty health of a car is
 * about eighteen more runs. See `CRASH_DAMAGE_PER_SPEED`'s closing paragraph.
 */
export const CAR_SMOKING_HEALTH = 40;

/**
 * What a smoking car has left, as a fraction of the top speed and of the
 * acceleration. The brief's 0.6 for both.
 *
 * Applied to *both* rather than to the top speed alone, and the difference is
 * what makes it read as a damaged engine rather than as a speed limiter: a car
 * that still leapt off the line and merely stopped at 13 m/s would feel fine
 * until you tried to overtake, where one that also takes six seconds to get
 * there feels wrong from the first metre.
 */
export const CAR_SMOKING_SCALE = 0.6;

/**
 * How hard a smoking car pulls to one side, radians per second at full lock.
 *
 * Small -- 0.06 rad/s is 3.4 degrees a second, correctable with a tap -- because
 * the failure mode of a big number is a car that cannot be driven in a straight
 * line, and this is meant to be a nuisance you notice rather than a loss of the
 * vehicle. The *side* it pulls to is the record id's parity, so a given car
 * always pulls the same way and a player can learn it. Client-side only: it is
 * folded into the look yaw, which `protocol.INPUT_BYTES` already carries as a
 * client-authoritative input, so the server sees a driver who is simply looking
 * somewhere new -- `shapeDriveSteering`'s whole argument, one clause further on.
 */
export const CAR_SMOKING_PULL = 0.06;

/**
 * The health lost to one impact of this delta-v. The whole damage model.
 *
 * `clamp((dv - CRASH_FREE_SPEED) x CRASH_DAMAGE_PER_SPEED, 0, CRASH_DAMAGE_MAX)`
 * times the impact's head-on-ness, and it is a free function rather than a
 * method because both the authority and the prediction call it and neither has
 * any business owning it. Six operations and no transcendental, so the two ends
 * produce the same number bit for bit -- see section 5.
 *
 * `headOn` is `|cos|` between the contact normal and the car's heading, and it
 * **defaults to 1** so that every call site which has no normal to offer -- car
 * against car, car against the timetable, a pedestrian -- means exactly what it
 * meant before the glancing rule existed. See `GLANCING_FLOOR` for why only the
 * nose probe supplies one and why the factor multiplies the damage rather than
 * the speed.
 *
 * The floor is applied here rather than trusted from the caller, on
 * `CarSmoke.add`'s rule about grading inside the callee: a caller that handed
 * over a raw cosine of 0.02 would produce a free crash, and there is exactly one
 * place that decision should be made.
 */
export function crashDamage(deltaV: number, headOn = 1): number {
  const over = deltaV - CRASH_FREE_SPEED;
  if (!(over > 0)) return 0;
  const raw = over * CRASH_DAMAGE_PER_SPEED;
  const capped = raw > CRASH_DAMAGE_MAX ? CRASH_DAMAGE_MAX : raw;
  // NaN-safe by construction: `!(headOn > GLANCING_FLOOR)` catches a NaN and
  // falls to the floor, where `headOn < GLANCING_FLOOR ? ...` would let it
  // through and multiply the whole crash by NaN. `damageGrade` clamps the same
  // way and for the same reason.
  const square = !(headOn > GLANCING_FLOOR) ? GLANCING_FLOOR : headOn > 1 ? 1 : headOn;
  return capped * square;
}

/**
 * A health as the 0..1 the renderers want. `traffic.CarPose.damage`'s scale.
 *
 * Here rather than at the four places that draw a dent, so there is one
 * definition of "how wrecked is this" rather than four that agree today.
 */
export function damageFraction(health: number): number {
  if (health >= CAR_HEALTH_MAX) return 0;
  if (health <= 0) return 1;
  return 1 - health / CAR_HEALTH_MAX;
}

/** Is this car dented enough to show it? `CAR_DENTED_HEALTH`. */
export function carIsDented(health: number): boolean {
  return health <= CAR_DENTED_HEALTH;
}

/** Is this car smoking, and slow with it? `CAR_SMOKING_HEALTH`. */
export function carIsSmoking(health: number): boolean {
  return health <= CAR_SMOKING_HEALTH;
}

/** Is the engine dead? Zero exactly -- a car on 0.4 hp still runs. */
export function carIsWrittenOff(health: number): boolean {
  return health <= 0;
}

// --- What a damaged car looks like ---------------------------------------------------

/**
 * How far the body is folded at a total write-off, as a fraction of each axis.
 *
 * The three numbers are what a front-end shunt does to a silhouette: the car
 * gets **shorter** (the bonnet concertinas), **lower** (the roof and the
 * suspension both sag) and a little **wider** (the panels splay). Read together
 * at fifty metres that is unmistakably a wreck, and none of it needs a texture
 * or a second geometry.
 *
 * Deliberately small -- 12 % shorter, not half the size -- because the car still
 * has to read as the same car, and because the near-field model fleet applies
 * the identical deformation to a real 3D body, which looks melted long before a
 * box does.
 */
export const CRUMPLE_LENGTH = 0.12;
export const CRUMPLE_HEIGHT = 0.09;
export const CRUMPLE_WIDTH = 0.05;

/**
 * How far the paint is darkened at a total write-off. 0.45 of its own colour off.
 *
 * Multiplicative and toward black rather than toward grey, for the reason
 * `world/cars.PAINT`'s header gives about the tonal jitter: that material
 * multiplies the geometry's vertex colours by the instance colour, so anything
 * that is not a multiply of the paint would fight the trim tones baked into the
 * glass and the tyres. A dark red wreck is still recognisably the red car you
 * stole.
 */
export const CRUMPLE_DARKEN = 0.45;

/**
 * Puffs a second off a bonnet that is merely broken, and off one that is dead.
 *
 * The rate the plume is *driven* at, and the number `world/carsmoke.ts` turns
 * into a puff loop. Faster for a write-off, because a dead engine is a fire and
 * a broken one is a leak.
 */
export const SMOKE_RATE_BROKEN = 5.5;
export const SMOKE_RATE_DEAD = 8;

/**
 * Everything the four renderers need to know about a damaged car, in one record.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A THREE-FREE FUNCTION IN THE RULES FILE.
 *
 * The dents reach the screen through **four** separate systems -- the box fleet
 * (`world/cars.ts`), the near-field model fleet (`world/carlod.ts`), the
 * headlights (`world/nightlights.ts`) and the plume (`world/carsmoke.ts`) -- and
 * every one of them draws a car the others also draw. A car that was 12 % folded
 * as a box and 0 % folded as a model would straighten out as the player walked
 * up to it, which is precisely the "type switch at the boundary" the LOD swap
 * exists to have none of; a car whose headlight went out at a health the paint
 * had not darkened at yet would be four systems with four opinions about what
 * "dented" means.
 *
 * So the grading is **one pure function**, it lives here with the bands it is
 * derived from, and it imports nothing -- which also makes it the one part of
 * the visual half of this feature that a self-check can assert without a
 * renderer, a canvas or a browser. `verifyDamageGrade` is that check.
 *
 * The input is `traffic.CarPose.damage`, a 0..1 fraction, because that is what
 * every one of the four consumers is holding when it asks. `damageFraction`
 * converts a health into one and is the only place that conversion happens.
 *
 * Fills `out` and returns it, on `forEachCarNear`'s contract: this is called
 * once per drawn car per frame and must not allocate.
 */
export interface DamageGrade {
  /** How far the body is folded, 0 (showroom) to 1 (write-off). */
  dent: number;
  /** Multiplier on the paint. 1 is showroom, `1 - CRUMPLE_DARKEN` is a wreck. */
  darken: number;
  /** Puffs a second off the bonnet. Zero for anything above the smoke threshold. */
  smoke: number;
  /** Is the plume soot-black rather than grey? A write-off only. */
  soot: boolean;
  /** Is one headlight out after dark? */
  headlightOut: boolean;
}

export function createDamageGrade(): DamageGrade {
  return { dent: 0, darken: 1, smoke: 0, soot: false, headlightOut: false };
}

export function damageGrade(damage: number, out: DamageGrade): DamageGrade {
  const d = damage <= 0 ? 0 : damage > 1 ? 1 : damage;
  out.dent = d;
  out.darken = 1 - CRUMPLE_DARKEN * d;
  // The health this fraction came from, so the thresholds below are the *rules'*
  // thresholds and not a second set of numbers that happen to agree today.
  const health = (1 - d) * CAR_HEALTH_MAX;
  const dead = carIsWrittenOff(health);
  out.smoke = dead ? SMOKE_RATE_DEAD : carIsSmoking(health) ? SMOKE_RATE_BROKEN : 0;
  out.soot = dead;
  out.headlightOut = carIsDented(health);
  return out;
}

/**
 * The grading, asserted -- which is the whole of how the visual half of this
 * workstream is checked without a renderer.
 *
 * Every failure below draws a perfectly good frame:
 *
 *   - **A car that is never dented.** The commonest failure and the one nobody
 *     reports as a bug: crash damage that works in every number and shows in
 *     nothing.
 *   - **Four systems with four opinions.** The headlight going out at a health
 *     the paint has not darkened at, or the model fleet folding a car the box
 *     fleet drew straight. See the header: this function exists so there is one
 *     answer.
 *   - **A wreck that stops smoking.** `smoke` falling to zero at the bottom of
 *     the scale rather than at the top is the exact off-by-one that leaves a
 *     write-off the only clean-looking car in a street of dented ones.
 *   - **A negative scale.** A `dent` over 1 -- from a health byte that arrived
 *     wrong -- inverts the matrix and draws the car inside out.
 */
export function verifyDamageGrade(): string[] {
  const failures: string[] = [];
  const g = createDamageGrade();

  // --- Showroom. Every channel must be its identity, because the ambient fleet
  //     goes through this function two hundred times a frame with damage 0 and
  //     any drift here repaints the whole city.
  damageGrade(0, g);
  if (g.dent !== 0) failures.push(`An undamaged car is folded by ${g.dent}.`);
  if (g.darken !== 1) failures.push(`An undamaged car's paint is multiplied by ${g.darken}.`);
  if (g.smoke !== 0) failures.push(`An undamaged car smokes at ${g.smoke} puffs a second.`);
  if (g.soot || g.headlightOut) failures.push('An undamaged car has soot or a broken headlight.');

  // --- The bands, checked at the health the *rules* define them at rather than
  //     at a fraction this function invented.
  damageGrade(damageFraction(CAR_DENTED_HEALTH + 1), g);
  if (g.headlightOut) failures.push(`A car on ${CAR_DENTED_HEALTH + 1} hp has a headlight out; the threshold is ${CAR_DENTED_HEALTH}.`);
  if (g.smoke !== 0) failures.push(`A car above the dent threshold is already smoking.`);
  damageGrade(damageFraction(CAR_DENTED_HEALTH), g);
  if (!g.headlightOut) failures.push(`A car on exactly ${CAR_DENTED_HEALTH} hp still has both headlights.`);
  if (g.smoke !== 0) failures.push('A dented car smokes. Dents are paint; the smoke starts lower.');
  if (!(g.darken < 1)) failures.push('A dented car\'s paint was not darkened at all.');
  damageGrade(damageFraction(CAR_SMOKING_HEALTH + 1), g);
  if (g.smoke !== 0) failures.push(`A car on ${CAR_SMOKING_HEALTH + 1} hp smokes; the threshold is ${CAR_SMOKING_HEALTH}.`);
  damageGrade(damageFraction(CAR_SMOKING_HEALTH), g);
  if (g.smoke <= 0) failures.push(`A car on exactly ${CAR_SMOKING_HEALTH} hp does not smoke.`);
  if (g.soot) failures.push('A smoking car smokes black. Soot is for a write-off.');
  if (!g.headlightOut) failures.push('A smoking car has both headlights. Smoke is worse than dents.');

  // --- The write-off: every channel at its extreme, and the smoke *faster*
  //     rather than absent.
  damageGrade(1, g);
  if (g.dent !== 1) failures.push(`A write-off is folded by ${g.dent}, not 1.`);
  if (Math.abs(g.darken - (1 - CRUMPLE_DARKEN)) > 1e-9) {
    failures.push(`A write-off's paint is multiplied by ${g.darken}, not ${1 - CRUMPLE_DARKEN}.`);
  }
  if (!g.soot) failures.push('A write-off does not smoke black.');
  if (!g.headlightOut) failures.push('A write-off has both headlights.');
  if (!(g.smoke > 0)) failures.push('A write-off does not smoke at all. It is the thing that smokes most.');

  // --- Monotone in every channel, which is the property a player learns: a car
  //     that got *less* dented after a crash would be unexplainable.
  {
    let dent = -1;
    let darken = 2;
    let smoke = -1;
    for (let d = 0; d <= 1.0001; d += 0.02) {
      damageGrade(d, g);
      if (g.dent < dent) failures.push(`The dent fell from ${dent} to ${g.dent} at damage ${d.toFixed(2)}.`);
      if (g.darken > darken) failures.push(`The paint got lighter at damage ${d.toFixed(2)}.`);
      if (g.smoke < smoke) failures.push(`The smoke rate fell from ${smoke} to ${g.smoke} at damage ${d.toFixed(2)}.`);
      dent = g.dent;
      darken = g.darken;
      smoke = g.smoke;
    }
  }

  // --- Clamped at both ends, which is what stops a health byte that arrived
  //     wrong from inverting the model matrix and drawing a car inside out.
  damageGrade(-3, g);
  if (g.dent !== 0 || g.darken !== 1) failures.push('A negative damage produced a fold or a tint.');
  damageGrade(9, g);
  if (g.dent !== 1) failures.push(`A damage of 9 folded the car by ${g.dent}; the scale is 0..1.`);
  if (!(1 - CRUMPLE_LENGTH * g.dent > 0 && 1 - CRUMPLE_HEIGHT * g.dent > 0)) {
    failures.push('A fully folded car has a zero or negative scale on an axis. That draws it inside out.');
  }

  // --- The three fold constants are small enough that the car is still a car.
  if (!(CRUMPLE_LENGTH < 0.5 && CRUMPLE_HEIGHT < 0.5 && CRUMPLE_WIDTH < 0.5)) {
    failures.push('A crumple constant is over half the body. That is not a dent, it is a different vehicle.');
  }
  if (!(CRUMPLE_DARKEN > 0 && CRUMPLE_DARKEN < 1)) {
    failures.push(`CRUMPLE_DARKEN is ${CRUMPLE_DARKEN}; anything at or past 1 paints a wreck pure black.`);
  }
  if (!(SMOKE_RATE_DEAD > SMOKE_RATE_BROKEN && SMOKE_RATE_BROKEN > 0)) {
    failures.push('A write-off does not smoke harder than a merely broken car.');
  }

  return failures;
}

// --- Parking a car somebody got out of ------------------------------------------------

/** A kerb bay, as `snapToBay` wants it. `traffic.BayPose`'s shape, structurally. */
export interface BayTarget {
  x: number;
  y: number;
  z: number;
  /** Unit heading, `CarPose`'s convention. */
  dx: number;
  dz: number;
}

/** What `snapToBay` writes. A subset of `DrivenCar`. */
export interface ParkableCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  driverId: number;
}

/**
 * Put a car somebody just got out of into the kerb bay beside it, if there is
 * one within `PARK_SNAP_RADIUS`. Returns true if it moved.
 *
 * The brief's second clause: "a car you leave in a parking bay is a parked car,
 * not a car in the middle of the lane". Without it, getting out beside a bay
 * leaves the car wherever the *body* was standing when the sweep ran -- a metre
 * and a half out from the gutter at whatever angle the driver happened to be
 * looking -- which reads as abandoned rather than as parked.
 *
 * `bay` is `traffic.nearestBay`'s answer or null, supplied by the caller rather
 * than looked up here, which is what keeps this function three-free *and*
 * checkable: the geometry of finding a bay needs a `TrafficField` with a real
 * sidecar in it and is asserted in `verifyTraffic`, and the rule about what to
 * do with one is here and is asserted in `verifyDriving`. The two callers
 * (`sim.parkOnLeave` and the offline sweep in `main.ts`) run the identical pair.
 *
 * **Only an empty car**, which is the clause that stops a driver being teleported
 * into the gutter mid-corner: the snap is a consequence of getting out.
 */
export function snapToBay(car: ParkableCar, bay: BayTarget | null): boolean {
  if (car.driverId !== 0 || bay === null) return false;
  car.x = bay.x;
  car.y = bay.y;
  car.z = bay.z;
  // The bay's own heading as a look yaw, so a parked car points down the street.
  // `headingYaw`'s two `Math.atan2`s, and they are affordable here for its
  // reason twice over: this runs once per car per *getting out of it*.
  car.yaw = headingYaw(bay.dx, bay.dz);
  car.speed = 0;
  return true;
}

// --- Being run over ---------------------------------------------------------------

/**
 * How fast a driven car has to be going to knock somebody down, m/s.
 *
 * The brief's 4, and it is *not* `traffic.CAR_HIT_MIN_SPEED` (1.0) on purpose.
 * An ambient car that nudges you at 1 m/s is the city being the city; a player
 * who has taken a car is a player who will absolutely idle it into a crowd to
 * see what happens, and 4 m/s means you have to actually drive at somebody.
 */
export const RUN_DOWN_SPEED = 4;

// --- The camera and the body roll (cosmetic, client only) -------------------------

/** How far behind the car the chase camera sits, metres. The brief's 7. */
export const DRIVE_CAM_DISTANCE = 7;
/** And how far above the driver's eye. The brief's 2.5. */
export const DRIVE_CAM_LIFT = 2.5;
/** How far the body leans in a full-lock corner at speed, radians. About 5 degrees. */
/** And how far it dives under full braking. About 3.5 degrees. */

// --- The state ---------------------------------------------------------------------

/**
 * The two fields `shapeDriveInput` and `stepCarSpeed` read off a combatant.
 *
 * A structural type rather than `CombatantState`, on `game/bikes.RideState`'s
 * argument exactly: `combat.ts` imports this file, so this file must not import
 * `combat.ts`, and two fields is a small enough contract to state structurally.
 */
export interface DriveState {
  /** The `CarField` record id this combatant is driving, or 0. */
  drivingCar: number;
  /**
   * Signed speed along the driver's own heading, m/s. Negative is reverse.
   *
   * On the combatant rather than on the car record, and that is load-bearing
   * rather than tidy: it is *movement state*, it has to survive into
   * `combat.advance`'s integrator and into `net/client.reconcile`'s replay, and
   * a second copy of "how fast is this car going" living on the car would be a
   * second opinion about how fast a player is moving. `CarField.follow` copies
   * it out to the record once a tick for the wire, which is the same direction
   * every other field on a car record travels.
   */
  carSpeed: number;
  /**
   * The condition of the car being driven, 0..`CAR_HEALTH_MAX`.
   *
   * A **mirror**, and the direction it travels is the opposite of `carSpeed`'s:
   * the record owns the health and this is a copy of it, refreshed once a tick
   * by whoever owns the `CarField` (`sim.stepCars` on the authority, the car
   * block in `main.ts` on the client, from `net.cars` online and from the local
   * field offline). It exists at all because `stepCarSpeed` runs inside
   * `combat.advance`, which has a combatant and a world and no way to reach a
   * car record -- and passing the field down into the integrator would put
   * `game/combat.ts` in `game/driving.ts`'s import graph, which is the cycle
   * this file's structural `DriveState` exists to avoid.
   *
   * One tick of staleness, which at 60 Hz is 17 ms of a car driving at its
   * undamaged top speed on the tick it was written off. Nobody will see it, and
   * the alternative is a write-back path from the sweep at the end of the tick
   * into the combatant at the start of it.
   *
   * Meaningless when `drivingCar` is 0, and `stepCarSpeed` does not read it then.
   */
  carHealth: number;
  /**
   * How square the nose probe's last impact was, 0..1. **Written here, read by
   * the car sweep**, and the second half of `combat.CombatantState.carCrashDv`'s
   * one-tick outbox -- see that field, which carries the whole argument.
   *
   * **Optional on this interface and required on the combatant**, which is the
   * asymmetry that lets `verifyDriving` keep driving three-field literals
   * through `stepCarSpeed` while the real thing is a checked field on the state
   * both processes reconcile. Written unconditionally on a hit and left alone
   * otherwise, because whoever drains the outbox puts it back to 1.
   */
  carCrashHeadOn?: number;
}

/** What `stepCarSpeed`'s nose probe needs of the world. A subset of `combat.CombatWorld`. */
export interface DrivingWorld {
  /**
   * The prism resolver, or null. Absent is a legal world -- a self-check, or the
   * first second of a session before anything has streamed -- and means the nose
   * probe passes everything, which is the correct failure: a car that cannot
   * move until the collision arrives is worse than one that clips a wall once.
   */
  collision: { resolve(fx: number, fz: number, tx: number, tz: number, r: number, feetY: number, headY?: number): { x: number; z: number; hit: boolean } } | null;
  /**
   * Is this point on a carriageway? Optional; absent counts as road. See
   * `DRIVE_TOP_SPEED_ROUGH`.
   */
  onRoad?(x: number, z: number): boolean;
}

/**
 * How far ahead of the driver's capsule the bonnet reaches, metres.
 *
 * Half of a sedan's 4.4 m length less the driver's own 0.34 m radius, rounded
 * down. Deliberately **not** per-body: the probe is a broadphase for "am I about
 * to put the front of this car through a wall", and a probe whose length depends
 * on which of five models you took would make a van handle differently from a
 * hatch in a way no player would ever attribute to the van.
 */
export const NOSE_REACH = 1.8;

/** And how wide the nose is, for the probe's own radius. */
export const NOSE_RADIUS = 0.85;

/**
 * How high the nose probe lifts its feet before asking. **`controller.STEP_HEIGHT`.**
 *
 * ---------------------------------------------------------------------------
 * **THIS CONSTANT IS A BUG FIX AND THE BUG IS WORTH WRITING DOWN**, because it
 * was invisible in every unit check in this file and cost a player most of a car
 * on an ordinary drive across town.
 *
 * The owner's report was *"even small bumps in a road alone are giving
 * damage"*, and the cause was one missing argument. `CollisionWorld.solidFor`'s
 * first clause is `feetY >= prism.top - 0.05`, and its header states the
 * contract in bold: **the step allowance is the caller's to add.**
 * `controller.step` adds it -- it asks at `feetY + STEP_HEIGHT`, which is why a
 * body walks over a kerb instead of into it -- and the nose probe here asked at
 * a bare `feetY`.
 *
 * So the two halves of the same car were asking the collision world two
 * different questions about the same geometry. Every prism in Sydney shorter
 * than 0.42 m -- a kerb, a driveway lip, a bridge joint, a planter, a road-edge
 * band, the low wall round a car park -- was *not there* for the driver's own
 * capsule, which sailed over it, and was a **brick wall** for the bonnet
 * 1.8 m in front of it. The car did not stop, because nothing was stopping the
 * body; it simply shed two thirds of its speed and took a full crash's damage
 * every `CRASH_COOLDOWN_MS` for as long as the geometry kept passing under it.
 * At the old curve a 44 m/s drive over a kerb was 45 hp. Nothing rendered, and
 * the health bar moved on a car that had visibly hit nothing at all.
 *
 * It is `NOSE_STEP` and not an import for the reason `SPRINT_SPEED` one screen
 * down is a number and not an import: `controller.ts` imports three and this
 * file compiles into the Bun server. `verifyCombat` -- which imports both --
 * asserts the two have not drifted, which is a real cross-check rather than
 * this file's usual self-referential one, and it is a real cross-check because
 * *this* pair drifting is not a tuning inconsistency, it is the bug above.
 */
export const NOSE_STEP = 0.42;

/**
 * And how tall the probe stands, measured from the **unlifted** feet.
 *
 * `collision.BODY_HEIGHT_M`, and the "unlifted" is the whole of why this is a
 * separate constant rather than a default. `resolve`'s `headY` defaults to
 * `feetY + BODY_HEIGHT_M` measured from whatever feet it was handed, so passing
 * the lifted feet would silently demand 2.22 m of clearance and make the nose
 * probe refuse a soffit the driver's own body is happy to pass under -- a car
 * that took a crash for driving under the Cahill. `controller.step` passes the
 * unlifted head for exactly this reason and says so; the probe now matches it
 * argument for argument, which is the property that actually matters: **the
 * bonnet asks the same question the body asks, one car-length further on.**
 */
export const NOSE_HEAD = 1.8;

/**
 * How much speed a car keeps on the tick its bonnet enters something.
 *
 * A third, and it was a bare `0.34` inside `stepCarSpeed` until
 * `server/cardamage-check.ts` needed to predict the number: the check drives a
 * car into a real wall at a chosen speed and asserts the health it loses, and
 * that assertion is `crashDamage(speed * NOSE_SHED)` -- which is a *model* of the
 * probe rather than a literal copied out of it, and only stays a model if the
 * constant has a name. See the impulse paragraph inside `stepCarSpeed` for why
 * two thirds in one tick rather than everything.
 */
export const NOSE_KEEP = 0.34;
/** The other side of it: the fraction of the speed one bonnet-first tick sheds. */
export const NOSE_SHED = 1 - NOSE_KEEP;

// --- The integrator ------------------------------------------------------------------

/**
 * Advance one driven car's speed by `dt`. **The whole of the driving model.**
 *
 * Called once per fixed step by the authority (`server/sim.tick`) and once per
 * fixed step by the client predicting its own car (`main.ts`), from the same
 * file with the same numbers, which is what makes the prediction exact rather
 * than close. A no-op for anybody on foot.
 *
 * `yaw` is the driver's look yaw -- the car points where the driver points, on
 * `BikeField.follow`'s convention ("its yaw is the rider's") -- and is used only
 * by the nose probe, which needs to know where the bonnet is.
 *
 * **Returns the speed the nose probe took off the car this tick, m/s** -- zero
 * when nothing was hit. That used to be a boolean and it is a number now because
 * the caller has a second job with it: the delta-v *is* the impulse, and
 * `crashDamage` turns it into health off the car. Truthiness is unchanged, so
 * `if (stepCarSpeed(...))` still reads "did we bump".
 */
export function stepCarSpeed(
  c: DriveState,
  input: { forward: number; jump: boolean },
  dt: number,
  x: number,
  feetY: number,
  z: number,
  yaw: number,
  world: DrivingWorld | null,
  /**
   * --- WORKSTREAM W: who is driving, for `Ute Life`'s limp.
   *
   * `DriveState` deliberately carries no id -- it is the structural slice of a
   * combatant this file is allowed to see, and adding one would make it a
   * combatant. So the id arrives as an argument, from the one caller that has
   * one (`combat.advance`, which passes `c.id`), and defaults to 0 for the
   * self-checks that drive a bare `DriveState`.
   */
  driverId = 0,
): number {
  if (c.drivingCar === 0) {
    // Not driving. Zeroed rather than left, so a player who is knocked out of a
    // car and gets into another one does not inherit the speed they had when
    // they were thrown through the windscreen.
    c.carSpeed = 0;
    return 0;
  }

  const throttle = clamp(input.forward, -1, 1);
  const rough = world?.onRoad === undefined ? false : !world.onRoad(x, z);
  // --- What the crash damage has left of the engine. See `CAR_SMOKING_SCALE`.
  //
  // Read off the combatant's mirror of the record (see `DriveState.carHealth`)
  // and applied to the top speed and the acceleration together, so a damaged car
  // is slow off the line as well as slow at the top -- which is the difference
  // between a broken engine and a speed limiter.
  const health = c.carHealth;
  // --- WORKSTREAM W: `Ute Life`'s "written-off cars can still limp at 6 m/s".
  //
  // A wreck stops being written off *for the throttle* and becomes a car with a
  // 6 m/s ceiling, which is the whole of the talent: the smoke, the soot, the
  // dent grade and the health bar all still say write-off (they read the
  // record's health, not this), and what changes is that you can drive it home.
  // `limp` is 0 without the talent, so `dead` is exactly what it was.
  const limp = health <= 0 ? fxWreckLimpSpeed(driverId) : 0;
  const dead = health <= 0 && limp <= 0;
  const hurt = !dead && health <= CAR_SMOKING_HEALTH;
  const scale = hurt ? CAR_SMOKING_SCALE : 1;
  let top = (rough ? DRIVE_TOP_SPEED_ROUGH : DRIVE_TOP_SPEED) * scale;
  if (limp > 0 && top > limp) top = limp;
  const floor = -top * DRIVE_REVERSE;
  let v = c.carSpeed;

  if (input.jump) {
    // Handbrake. Toward zero from either side and never through it, which is the
    // one thing an unclamped `v -= HANDBRAKE * dt` gets wrong: at 60 Hz that
    // overshoots by up to 0.27 m/s and leaves a stopped car creeping backwards.
    v = approach(v, 0, DRIVE_HANDBRAKE * dt);
  } else if (dead) {
    // **Written off.** The throttle does nothing at all -- not "less", nothing --
    // and what is left is the brake, the handbrake and gravity. Written as its
    // own branch above the throttle rather than as a zero multiplier inside it,
    // because a zeroed acceleration still lets `approach` walk the speed *up*
    // toward a target of zero from a reversing car, and a wreck that crept
    // forwards when you held W would read as an engine that still worked.
    //
    // It coasts rather than stopping dead: a car whose engine died is still a
    // two-tonne object with momentum, and you can still steer it off the road,
    // which is the whole of what "you can still get out" is worth.
    v = approach(v, 0, DRIVE_COAST * dt);
  } else if (throttle > 0) {
    // Throttle. If we are rolling backwards this is the brake first and the
    // accelerator second, and the stronger constant is the right one for it --
    // the pedal you press to stop reversing is the brake.
    const rate = v < 0 ? DRIVE_BRAKE : DRIVE_ACCELERATION * scale;
    v = approach(v, top * throttle, rate * dt);
  } else if (throttle < 0) {
    const rate = v > 0 ? DRIVE_BRAKE : DRIVE_ACCELERATION * scale;
    v = approach(v, floor * -throttle, rate * dt);
  } else {
    v = approach(v, 0, DRIVE_COAST * dt);
  }

  // Re-clamped after the fact as well as inside `approach`, because `top` can
  // *fall* between ticks -- driving off a road at 44 m/s -- and a target the
  // speed is already past would otherwise be approached from the wrong side and
  // never reached.
  v = clamp(v, floor, top);

  // --- The nose probe. See the header, section 2.
  //
  // One `resolve` from the driver's own capsule to a point `NOSE_REACH` ahead of
  // it, at the nose's own radius. `hit` means the far end of the bonnet is
  // inside something the driver's 0.34 m capsule would have squeezed past, and
  // the answer is to stop the car rather than to push it back -- `controller.step`
  // is already the thing that decides where the *body* ends up, and a second
  // opinion about position here would fight it every tick.
  //
  // Only forwards. Reversing into a wall is caught by the body's own capsule at
  // the speeds reverse allows, and a rear probe would double the cost of the one
  // query per car per tick this feature is allowed.
  let lost = 0;
  if (v > 0 && world?.collision) {
    // `yaw` 0 faces -Z, exactly as `controller.step` derives it.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // **The two height arguments are the whole of the bump fix.** See
    // `NOSE_STEP`: without them this probe asked the collision world whether a
    // *point at ground level* was clear, which every kerb in Sydney answers no
    // to, while the body it belongs to was stepping over the same kerb without
    // noticing. Lifted feet and an unlifted head is `controller.step`'s own pair,
    // argument for argument, so the bonnet and the body now agree about what is
    // solid.
    const hit = world.collision.resolve(
      x, z,
      x + fx * NOSE_REACH, z + fz * NOSE_REACH,
      NOSE_RADIUS, feetY + NOSE_STEP, feetY + NOSE_HEAD,
    );
    if (hit.hit) {
      // --- **How square was it?** The glancing-blow rule, and this is the one
      // impact in the game that needs it computed rather than implied.
      //
      // `resolve` hands back the point it pushed the probe out to, and the
      // vector from where the probe *wanted* to be to where it *ended up* is the
      // contact normal -- that is what a push-out is. Dotting it with the car's
      // own heading gives `|cos|`: 1 for driving into the end of a building, and
      // near zero for dragging a wing along the side of one. See
      // `GLANCING_FLOOR`.
      //
      // A push of nothing is a degenerate answer -- the resolver reported a hit
      // and moved the probe nowhere, which happens when the probe starts inside
      // the prism -- and it falls back to 1 rather than to the floor, on the
      // rule this file uses everywhere a query cannot answer: the *conservative*
      // reading, which here is that it was a proper crash.
      const pushX = hit.x - (x + fx * NOSE_REACH);
      const pushZ = hit.z - (z + fz * NOSE_REACH);
      const push2 = pushX * pushX + pushZ * pushZ;
      if (push2 > 1e-8) {
        // `Math.sqrt` and never `Math.hypot`, on section 5's determinism rule
        // and `crashFromClamp`'s precedent one function down.
        const inv = 1 / Math.sqrt(push2);
        const dot = fx * pushX * inv + fz * pushZ * inv;
        c.carCrashHeadOn = dot < 0 ? -dot : dot;
      } else {
        c.carCrashHeadOn = 1;
      }
      // Not to zero: a hard stop at a kerb reads as the car being deleted. Two
      // thirds off per tick sheds 44 m/s in about 90 ms, which is a crunch.
      const before = v;
      v *= NOSE_KEEP;
      if (v < 0.2) v = 0;
      // **The impulse.** Two thirds of the speed in one tick is the whole of
      // what the car "lost to the wall", and it is the number `crashDamage`
      // wants -- which is why the 0.66 factor matters twice over: at 44 m/s it
      // reports 29 m/s of delta-v and therefore 6.8 hp of damage on the *first*
      // tick, and the `CRASH_COOLDOWN_MS` half-second swallows the four ticks of
      // continued grinding that follow. Reporting the whole 44 across five ticks
      // would have been the same crash costing five times as much.
      //
      // It is also the reason `CRASH_FREE_SPEED` is 12 rather than the 18 the
      // owner would have named if he were talking about the speedometer: this
      // curve's argument is two thirds of a road speed and always has been. See
      // that constant.
      lost = before - v;
    }
  }

  c.carSpeed = v;
  return lost;
}

/**
 * How much speed the *body* lost that the car's own integrator did not know
 * about, m/s -- and take it off the car while we are here.
 *
 * The second half of crash detection, and the half the nose probe cannot see.
 * `controller.step` is what actually moves a driver (section 2: "the car you are
 * driving is not a new body, it is your body, geared"), and when it resolves the
 * capsule against a prism it simply *puts the body somewhere else* -- the car's
 * scalar carries on at 44 m/s while the player stands still against a wall. The
 * nose probe catches most of that, but not a car sliding into a wall at an
 * angle, not a kerb the probe's 1.8 m reach steps over, and not a corner the
 * capsule wedges into.
 *
 * So this is measured **after the step** and from the step's own result: how far
 * the body actually travelled in plan against how far its speed said it would.
 * A shortfall is a collision, its rate is the delta-v, and the same
 * `crashDamage` curve applies to it.
 *
 * ---------------------------------------------------------------------------
 * **`hitSolid` IS A GATE AND NOT A HINT.** It is `controller.step`'s own return
 * -- did the prism resolver actually push this body -- and a shortfall reported
 * without one is thrown away unmeasured.
 *
 * The rule it enforces is the owner's, in his words: *"even small bumps in a
 * road alone are giving damage"*. **Damage comes from closing into a solid.**
 * A shortfall with nothing solid in the way is not a crash whatever its size,
 * and there are three ways to produce one that this function used to charge for
 * in full:
 *
 *   - the **wading undo** in `combat.advance`, which puts a body that tried to
 *     enter deep water straight back where it started. This function runs after
 *     it and read `moved = 0` -- so driving off a wharf at 40 m/s billed a
 *     `CRASH_DAMAGE_MAX` every half second for as long as you held W, and the
 *     comment above the call said it was ordered that way *so as not to* charge
 *     for a wave. It was charging for the wave. It is not any more.
 *   - a **train's `mover`**, which replaces the city while a body is inside a
 *     carriage: a passenger who is also nominally in a car is resolved against
 *     a bodyside that has nothing to do with the street.
 *   - anything future that undoes a step for a reason of its own. The gate makes
 *     the honest answer the default, which is the shape a rule like this has to
 *     have to survive the next feature.
 *
 * What it deliberately does *not* remove is the slip tolerance below. A body
 * genuinely wedged against a prism is a solid *and* a shortfall, and the two
 * questions are different: `hitSolid` asks whether anything was in the way and
 * `CLAMP_SLIP` asks whether it was in the way hard enough to matter.
 *
 * `SLIP` is the tolerance, and it is not zero for a reason worth writing down.
 * `controller.step` accelerates toward the target speed at 48 m/s^2 rather than
 * snapping to it, ground friction takes its cut, and a slope shortens the plan
 * distance by the cosine of its grade -- so a car driving perfectly down a
 * street routinely covers 97 % of what its speed predicts. A 15 % tolerance is
 * comfortably past all three and comfortably inside a real stop, which removes
 * 100 %.
 *
 * Runs on both ends inside `combat.advance`, which is what makes it a prediction
 * rather than a second opinion.
 */
export function crashFromClamp(
  c: DriveState,
  movedX: number,
  movedZ: number,
  dt: number,
  /** Did `controller.step`'s resolver push this body out of a prism? See above. */
  hitSolid: boolean,
): number {
  if (c.drivingCar === 0 || dt <= 1e-6) return 0;
  // The gate, first, because it is one comparison and it is true on almost no
  // tick of almost any session. A bump is free.
  if (!hitSolid) return 0;
  const speed = c.carSpeed < 0 ? -c.carSpeed : c.carSpeed;
  if (speed <= CRASH_FREE_SPEED) return 0;
  // `Math.sqrt` and never `Math.hypot`: the determinism rule in section 5, and
  // the same call `traffic.poseCar` allows itself once per pose.
  const moved = Math.sqrt(movedX * movedX + movedZ * movedZ);
  const expected = speed * dt;
  const shortfall = expected * (1 - CLAMP_SLIP) - moved;
  if (!(shortfall > 0)) return 0;
  const lost = shortfall / dt;
  // Take it off the car as well as reporting it. Without this the scalar is
  // untouched by the wall it just hit, so the very next tick asks the controller
  // for 44 m/s again and the car grinds along the prism at full throttle for as
  // long as the player holds W -- which is the bug the nose probe was written to
  // avoid and which this path reintroduces if it only *measures*.
  c.carSpeed = c.carSpeed < 0 ? c.carSpeed + lost : c.carSpeed - lost;
  if (c.carSpeed < 0.2 && c.carSpeed > -0.2) c.carSpeed = 0;
  return lost;
}

/** How much of a step's distance a car may legitimately not cover. See `crashFromClamp`. */
const CLAMP_SLIP = 0.15;

/**
 * Fold the car into the movement snapshot the combatant is about to be stepped
 * with, so `controller.step` moves the body at the speed this file decided.
 *
 * **Stateless**, and that is not incidental: it is called from
 * `combat.advance` on both ends *and* from `net/client.reconcile`'s replay, once
 * per un-acked input, and a function that integrated here would integrate three
 * to five times per snapshot on the client and once on the server. The
 * integration is `stepCarSpeed`'s and runs exactly once a tick.
 *
 * What the replay therefore uses is the *current* speed for every pending tick
 * rather than the speed as it was at each. Over the three to five ticks a replay
 * covers, at 6 m/s^2, that is at most 0.5 m/s of speed error and under a
 * centimetre of position -- an order of magnitude inside `CORRECTION_DEADZONE`.
 * Recording a speed per pending input would remove it and cost a field on every
 * queued frame; it is not worth it and this paragraph is the record of that
 * decision.
 *
 * **Doubling `DRIVE_TOP_SPEED` to 44 did not move that bound**, which is worth a
 * line because it is the obvious thing to worry about when a car gets faster.
 * The error is `DRIVE_ACCELERATION x replayTicks x dt` -- how far the *speed*
 * can drift over the replay -- and the acceleration is deliberately unchanged,
 * so it is the same 0.5 m/s it always was. What doubled is the distance the car
 * covers in those ticks, and that is not an error: both ends integrate the same
 * larger number from the same acked state.
 *
 * Runs **after** `shapeRideInput`, and the two are mutually exclusive by
 * construction: `resolveTake` refuses a car to anybody on a bike.
 */
export function shapeDriveInput(c: DriveState, movement: InputSnapshot): void {
  if (c.drivingCar === 0) return;
  // A car has one speed and it is not a function of whether shift is held, on
  // `shapeRideInput`'s own argument: forcing the sprint is what makes the scale
  // multiply `SPRINT_SPEED` rather than `WALK_SPEED`.
  movement.sprint = true;
  // No sidestep. A car does not crab, and `A`/`D` have been spent on the wheel
  // by `shapeDriveSteering` -- but this is the line that makes it a *rule*
  // rather than a client-side courtesy, because a hand-rolled client that kept
  // sending `right: 1` would strafe without it. `bikes.RIDE_STRAFE`'s reason.
  movement.right = 0;
  // The sign is the whole trick. `controller.step`'s target speed is
  // `SPRINT x speedScale x min(|forward|, 1)` along the *look* direction, so a
  // reversing car is `forward = -1` with the magnitude of the speed in the
  // scale, and a forward one is `forward = 1`.
  const v = c.carSpeed;
  movement.forward = v < 0 ? -1 : 1;
  // `PROBE_SPRINT` in `bikes.ts` is this same 8.2 and is a constant there for
  // the identical reason: this file may not import the controller, because the
  // controller imports three. `verifyDriving` asserts the two have not drifted.
  movement.speedScale = ((v < 0 ? -v : v) / SPRINT_SPEED) * (movement.speedScale ?? 1);
  // And no jumping a car. `jump` is the handbrake now -- see `stepCarSpeed` --
  // and a sedan that hops when you brake is not the feature.
  movement.jump = false;
}

/** `controller.SPRINT_SPEED`, which this file may not import. Asserted in `verifyDriving`. */
export const SPRINT_SPEED = 8.2;

/**
 * How fast the wheel turns at this speed, radians per second.
 *
 * `bikes.rideTurnRate` with a grip term on the front. Always non-negative; the
 * caller applies the sign.
 */
export function driveTurnRate(speed: number): number {
  const s = speed < 0 ? -speed : speed;
  const t = Math.min(1, s / DRIVE_TURN_FULL_SPEED);
  const base = DRIVE_TURN_RATE + (DRIVE_TURN_RATE_FAST - DRIVE_TURN_RATE) * t;
  // The grip ramp. See `DRIVE_TURN_GRIP`: a parked car does not pirouette.
  return base * Math.min(1, s / DRIVE_TURN_GRIP);
}

/** What `shapeDriveSteering` writes. `bikes.RideSteering`'s shape. */
export interface DriveSteering {
  /** What `InputSnapshot.right` must become. Zero in a car. */
  right: number;
  /** Radians to add to `InputSnapshot.yaw` this frame. Zero on foot. */
  yawDelta: number;
}

/**
 * Turn `A`/`D` from a strafe into a steer for a driver, and leave everyone else
 * alone. `bikes.shapeRideSteering`'s function, and see its header -- the whole
 * argument for why this is an input remap and not a second integrator is there.
 *
 * The one difference is the last clause: **reversing inverts the wheel**, which
 * is what a car does and what makes backing out of a driveway work. `speed` is
 * signed for exactly that.
 *
 * `dt` is the *frame* delta rather than the fixed step, on `main.ts`'s argument
 * about the arrow keys: the look is assembled once per frame and sampled by
 * however many fixed steps that frame contained.
 */
export function shapeDriveSteering(
  c: DriveState,
  right: number,
  speed: number,
  dt: number,
  out: DriveSteering,
): DriveSteering {
  if (c.drivingCar === 0) {
    out.right = right;
    out.yawDelta = 0;
    return out;
  }
  out.right = 0;
  // Negative because yaw increasing turns left -- `controller.step` derives
  // forward as `(-sin yaw, -cos yaw)`, so `D`, which is +1, takes yaw down.
  // Times the sign of the speed, so reverse steers the other way.
  const dir = speed < 0 ? -1 : 1;
  out.yawDelta = -right * driveTurnRate(speed) * dir * dt;
  // --- And the pull, if the car is smoking. See `CAR_SMOKING_PULL`.
  //
  // Added to the wheel rather than replacing it, and scaled by how fast the car
  // is actually going -- a stationary wreck does not creep round on its own, on
  // exactly `DRIVE_TURN_GRIP`'s argument one function up. The side is the record
  // id's parity, which is a stable integer both ends already hold, so a given
  // car always pulls the same way and a player can learn to hold a little wheel
  // against it.
  if (c.carHealth <= CAR_SMOKING_HEALTH) {
    const magnitude = speed < 0 ? -speed : speed;
    const grip = magnitude < DRIVE_TURN_GRIP ? magnitude / DRIVE_TURN_GRIP : 1;
    out.yawDelta += (c.drivingCar & 1 ? 1 : -1) * CAR_SMOKING_PULL * grip * dir * dt;
  }
  return out;
}

/**
 * Are these two driven cars in each other, and closing hard enough to count?
 * Returns the closing delta-v, or 0.
 *
 * **Car against car is not simulated and this does not change that.** Neither
 * one is pushed, neither one is deflected, and the header's section 2 argument
 * -- one scalar on the simulation path, no second integrator -- survives
 * untouched. What this is, is a *detector*: two 4.6 m boxes overlapping while
 * approaching each other at more than `CRASH_FREE_SPEED` is a collision that
 * happened, whatever the physics did about it, and both drivers should hear it
 * and pay for it.
 *
 * The test is plan-circular rather than the oriented-box `traffic.carOverlaps`
 * uses, and that is a deliberate downgrade with a stated reason: `carOverlaps`
 * answers "is this capsule inside this car", which is a point against a box, and
 * this is box against box -- a separating-axis test over two rotated rectangles,
 * eight dot products, run for every moving car against every record near it. A
 * circle of the body's own half-length is generous at the corners and exact
 * along the axis that matters, and the direction the error falls is the one
 * `carOverlaps`' header already argues for: a crunch you can hear for a
 * near-miss is a much smaller failure than a T-bone in silence.
 *
 * The closing speed is the rate the gap is shrinking along the line between
 * them, which is the only frame-invariant "how hard did they hit" available
 * without a real contact normal: two cars side by side at 44 m/s in the same
 * direction have a closing speed of zero and do not crash, which is exactly
 * right, and one reversing into another at 5 m/s crashes at 5.
 */
export function carCrashClosing(
  a: { x: number; z: number; yaw: number; speed: number; halfLength: number },
  b: { x: number; z: number; yaw: number; speed: number; halfLength: number },
): number {
  // `yaw` 0 faces -Z, `controller.step`'s convention, and the two
  // transcendentals that turns into are the whole reason this wrapper exists
  // separately from `ambientCrashClosing`: the ambient fleet carries its heading
  // as a unit vector already (`CarPose.dx/dz`) and must not pay for a yaw it
  // never had.
  return closingAlong(
    a.x, a.z, -Math.sin(a.yaw), -Math.cos(a.yaw), a.speed, a.halfLength,
    b.x, b.z, -Math.sin(b.yaw), -Math.cos(b.yaw), b.speed, b.halfLength,
  );
}

/**
 * The same question asked of a **driven car and an ambient one**. WORKSTREAM T.
 *
 * The owner's report was one sentence -- *"I still get knocked out of cars when
 * crashing into another car, the actual action should be damage to both cars"*
 * -- and the half of it that `carCrashClosing` could not answer is this one.
 * `carCrashClosing` needs two `DrivenCar` records and there is only ever one
 * when a player drives into the timetable: the other car is a closed-form
 * lookup, it has no record, no health and no driver, and it *carries on* -- see
 * `crashIntoTraffic` for what that means and why it is right.
 *
 * Both sides arrive as a **unit heading** rather than as a yaw, which is what
 * makes this the cheap one of the pair: `traffic.poseCar` and
 * `traffic.drivenCarPose` have both already produced `(dx, dz)`, so this runs on
 * the shared prediction path with no `Math.sin`/`Math.cos` in it at all and the
 * two ends cannot disagree about a transcendental. That is the determinism rule
 * from `game/footy.ts`' header, applied to the one new function in this change
 * that both ends evaluate.
 *
 * `speed` is **signed on the driven side and unsigned on the ambient one**, and
 * the asymmetry is not sloppiness: a player reversing into a bus at 5 m/s has
 * crashed at 5 m/s, so the driven side has to keep its sign, where a `CarPose`'s
 * speed is a magnitude along a heading it is always travelling forwards down.
 * `crashIntoTraffic` is the one caller and it states which is which.
 */
export function ambientCrashClosing(
  a: { x: number; z: number; dx: number; dz: number; speed: number; halfLength: number },
  b: { x: number; z: number; dx: number; dz: number; speed: number; halfLength: number },
): number {
  return closingAlong(
    a.x, a.z, a.dx, a.dz, a.speed, a.halfLength,
    b.x, b.z, b.dx, b.dz, b.speed, b.halfLength,
  );
}

/**
 * The shared body of the two above: overlap in plan, then closing speed.
 *
 * Twelve scalars rather than two objects, on `CarField.recycleFarthest`'s
 * argument about its flat `[x, z, ...]`: this runs once per moving car per
 * record near it on the server's hot path, and building two literals per call
 * would be two allocations for a function whose body is eight multiplies and a
 * square root. The readable shapes live in the two wrappers, where they cost
 * nothing because the compiler never has to allocate them.
 */
function closingAlong(
  ax: number, az: number, adx: number, adz: number, aSpeed: number, aHalf: number,
  bx: number, bz: number, bdx: number, bdz: number, bSpeed: number, bHalf: number,
): number {
  const rx = bx - ax;
  const rz = bz - az;
  const d2 = rx * rx + rz * rz;
  const reach = aHalf + bHalf;
  if (d2 >= reach * reach) return 0;
  // Exactly on top of each other: no direction to close along, and no answer
  // that is not a divide by zero. Two records at one point is a take that
  // happened inside another car, which the claim rules make impossible.
  if (d2 < 1e-9) return 0;
  const inv = 1 / Math.sqrt(d2);
  const nx = rx * inv;
  const nz = rz * inv;
  // Each car's velocity along its own heading, projected onto the line between
  // them.
  const av = aSpeed * (adx * nx + adz * nz);
  const bv = bSpeed * (bdx * nx + bdz * nz);
  // Positive when `a` is moving toward `b` faster than `b` is moving away.
  const closing = av - bv;
  return closing > CRASH_FREE_SPEED ? closing : 0;
}

/**
 * How far from a driven car an ambient one has to be to be worth testing, metres.
 *
 * `traffic.HIT_QUERY_RADIUS`' number and *not* its derivation, which is why it
 * is written out again rather than imported. That one is a box against a capsule
 * -- the longest car plus a player's radius -- and this is a box against a box:
 * the widest reach `closingAlong` can return non-zero for is the driven half
 * length (a van, 5.4 / 2 = 2.7, at `drivenCarPose`'s scale of exactly 1) plus
 * the ambient half length (the same van at the 4 % jitter plus `HIT_MARGIN`,
 * 2.91), which is 5.61. Six covers it with room and is a broadphase radius, so
 * it stays one number rather than being derived per candidate -- `carHitting`'s
 * header states that rule and it holds here for its reason. `verifyDriving`
 * asserts the six is still bigger than the widest pair `CAR_BODY_SIZE` allows.
 */
export const CRASH_QUERY_RADIUS = 6;

/**
 * What a driven car has crashed into out of the ambient fleet, as a delta-v.
 * Zero for the overwhelmingly common case of not having hit anything.
 *
 * **The ambient car is not damaged and does not react**, and that is a decision
 * rather than an omission. A schedule car has no record, no health field and no
 * existence between two queries of `traffic.poseCar` -- it is a closed-form
 * function of the clock, which is the whole reason a fleet of six thousand costs
 * zero bytes of protocol (`game/traffic.ts` section 1). Giving one a dent would
 * mean giving it a record, and a record per car anybody has ever nudged is the
 * per-NPC city state the performance budget exists to forbid. So the timetable
 * carries on and the player pays; the read is that you bounced off a bus.
 *
 * The **first** car found wins, which is `carHitting`'s rule and is here for its
 * reason: `forEachCarNear` has one fixed iteration order in every process, so
 * "the first" is a thing two processes can agree on where "the hardest" would
 * make them agree only if their floats did.
 *
 * Two poses because there are two cars: `mine` is filled here from the record
 * and `theirs` is the iterator's own scratch. Both are the caller's, reused
 * across ticks, so this allocates nothing.
 */
export function crashIntoTraffic(
  field: TrafficField,
  car: DrivenCar,
  tick: number,
  scratch: LaneRoute[],
  mine: CarPose,
  theirs: CarPose,
  /** `CarField.suppress`. Without it your own ambient ghost crashes into you. */
  suppressed: (identity: number) => boolean,
): number {
  // The identical box the knockdown test uses, from the identical function --
  // `traffic.drivenCarPose`' whole argument, which is that a driven car reusing
  // the ambient geometry is the only way "a car hit a car" means one thing.
  drivenCarPose(car, mine);
  // ...with one field put back. `drivenCarPose` publishes an **unsigned** speed
  // because everything downstream of a pose treats it as a magnitude, and a
  // crash is the one consumer that must not: reversing into the car behind you
  // is a crash and a magnitude would score it as driving away. See
  // `ambientCrashClosing`.
  mine.speed = car.speed;
  let dv = 0;
  forEachCarNear(field, car.x, car.z, CRASH_QUERY_RADIUS, tick, scratch, theirs, (p) => {
    // Your own ghost, skipped exactly as `carHitting` skips it and for the same
    // reason: the ambient copy of the car you stole is still on the timetable
    // and would otherwise crash into the seat you are sitting in.
    if (suppressed(p.identity)) return;
    // **The viaduct gate**, and it is here because the first run of
    // `server/cardamage-check.ts`' section (c) crashed a car on the ground into
    // one twelve and a half metres below it and reported 48 hp of damage for it.
    // `traffic.carOverlaps` has this clause, `sim.stepCars`' driven-against-
    // driven loop has it, and `traffic.resolveHeld` has it: a car on the Cahill
    // Expressway is not in the car on Alfred Street underneath, and every test
    // in this game that asks whether two things are in the same place has to say
    // so or the whole viaduct is a hazard to the street below. `TAKE_HEIGHT` is
    // the project's one answer to "the same piece of road".
    const dy = p.y - car.y;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return;
    const closing = ambientCrashClosing(mine, p);
    if (closing <= 0) return;
    dv = closing;
    return true;
  });
  return dv;
}

/**
 * The look yaw that points a body down a car's heading.
 *
 * Two `Math.atan2` inputs and therefore **presentation only**: this is called
 * once, in the browser, on the frame you get into a car, so that taking a car
 * parked at the kerb points you along the street rather than at the shopfront
 * you were facing. The result becomes the client's own look direction, which is
 * a client-authoritative input on this wire (`protocol.INPUT_BYTES` carries
 * `yaw`), so nothing about it has to agree with anything.
 *
 * `(dx, dz)` is `CarPose`'s unit heading; forward at yaw is `(-sin, -cos)`.
 */
export function headingYaw(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

// --- What is takeable ----------------------------------------------------------------

/** One car somebody could get into, as `resolveTake` hands it over. */
export interface TakeableCar {
  /**
   * `traffic.identityOf(route, slot)` for a schedule car and
   * `traffic.staticCarIdentity(tileKey, index)` for a parked one. The car's name
   * in every process, and the same 32-bit space either way -- `MSG.CARS` carries
   * it as a `u32` (`protocol.encodeCars`, `setUint32`), so the full range of both
   * hashes fits and the wire needed no change for workstream S.
   */
  identity: number;
  body: number;
  colour: number;
  x: number;
  y: number;
  z: number;
  /** The car's own heading, as a look yaw. See `headingYaw`. */
  yaw: number;
  /** True when it was stationary in a kerb bay, which is what "parked" means here. */
  parked: boolean;
}

export function createTakeable(): TakeableCar {
  return { identity: 0, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: false };
}

/**
 * The running best of a take arbitration. **Two fleets, one comparison.**
 *
 * Exists as a value rather than as three local variables inside `resolveTake`
 * because since workstream S there are two *sources* of candidate -- the
 * timetable and the parked fleet -- and the whole property that makes a take
 * predictable is that the winner is decided by one rule over the union of them
 * rather than by "schedule first, then statics if nothing" (which would make the
 * answer depend on the order the sources were asked in, and therefore on which
 * process was asking).
 *
 * It is also what makes the arbitration *testable* without a baked world:
 * `verifyDriving` drives `beginTake`/`offerTake` with hand-placed candidates from
 * both fleets, which is the one part of the take a boot-time check can assert.
 * `server/take-check.ts` covers the rest against the real city.
 */
export interface TakeQuery {
  /** Where the person pressing E is standing. Set by `beginTake`. */
  x: number;
  feetY: number;
  z: number;
  found: boolean;
  /** Squared plan distance to the best so far, or `TAKE_RADIUS^2` with none. */
  bestD2: number;
  bestIdentity: number;
}

export function createTakeQuery(): TakeQuery {
  return { x: 0, feetY: 0, z: 0, found: false, bestD2: 0, bestIdentity: 0 };
}

/**
 * Open an arbitration at a point. Nothing offered yet, the radius as the bound.
 *
 * --- WORKSTREAM W: `radius` is a parameter, defaulting to `TAKE_RADIUS`.
 *
 * `Sticky Fingers` raises the reach 2.2 → 3.2 m, and it does so **per player**,
 * which is the whole reason this is an argument rather than a module-level read
 * of the lookup: the server arbitrates every player's take through this one
 * function on the same tick, so the radius has to arrive with the query rather
 * than be a global that the last caller set. Every existing call site keeps the
 * constant by omitting it.
 */
export function beginTake(q: TakeQuery, x: number, feetY: number, z: number, radius = TAKE_RADIUS): void {
  q.x = x;
  q.feetY = feetY;
  q.z = z;
  q.found = false;
  q.bestD2 = radius * radius;
  q.bestIdentity = 0;
}

/**
 * Offer one candidate car to an open arbitration. True if it is the new best.
 *
 * The whole of the gate, in the order it was in when it was inline in
 * `resolveTake`, and unchanged:
 *
 *   - the **vertical gate** first, `bikes.MOUNT_HEIGHT`'s argument: a plan-only
 *     test lets somebody on the Cahill Expressway take a car on Alfred Street
 *     eight metres below them;
 *   - then the radius and strictly-nearer test, squared, no `sqrt`;
 *   - then **ties break on identity rather than on the float distance**, which is
 *     `BikeField.nearestFree`'s rule and is here for its reason: two cars at the
 *     same range have to resolve the same way on the client predicting the take
 *     and on the server granting it, and an integer comparison is a rule both can
 *     state where a float comparison is one two builds can disagree about. It
 *     matters more now than it did: a static car and a schedule car in the same
 *     bay row *are* the same-distance case, and they come from different files.
 *
 * The caller has already applied whatever is true of its own fleet -- the speed
 * clause for the timetable, nothing for the parked fleet -- and the suppression
 * predicate. Those are per-source and this is not.
 */
export function offerTake(
  q: TakeQuery,
  out: TakeableCar,
  identity: number,
  body: number,
  colour: number,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  parked: boolean,
): boolean {
  const dy = cy - q.feetY;
  if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return false;
  const dx = cx - q.x;
  const dz = cz - q.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > q.bestD2) return false;
  if (q.found && (d2 > q.bestD2 || (d2 === q.bestD2 && identity >= q.bestIdentity))) return false;
  q.found = true;
  q.bestD2 = d2;
  q.bestIdentity = identity;
  out.identity = identity;
  out.body = body;
  out.colour = colour;
  out.x = cx;
  out.y = cy;
  out.z = cz;
  out.yaw = yaw;
  out.parked = parked;
  return true;
}

/**
 * Scratch for `resolveTake`'s arbitration, allocated once for the life of the
 * process.
 *
 * Module state, on `traffic._obstacleBay`'s contract: not reentrant, and it does
 * not need to be. `resolveTake` is synchronous with no await and no callback that
 * can re-enter it -- the two closures it passes are its own -- so the only way to
 * observe this would be two `resolveTake` calls interleaved, which no caller on
 * either end does. The alternative, a `TakeQuery` on `createDrivingScratch()`,
 * would have changed the signature every existing caller passes.
 */
const _takeQuery: TakeQuery = createTakeQuery();

/**
 * The nearest car at this point that somebody could get into, or false.
 *
 * Runs on the server to grant a steal and in the browser to predict one and to
 * draw the prompt, off the same lookups at the same whole tick, which is what
 * makes the prompt honest: if the HUD says "E -- take the car" the server will
 * agree, because both asked the same two questions.
 *
 * ---------------------------------------------------------------------------
 * TWO SOURCES, AND WHAT AGREEMENT BETWEEN THE ENDS RESTS ON.
 *
 *   1. **The timetable**, `forEachCarNear` over a `TrafficField`. A closed-form
 *      function of the tick, asserted identical between the ends by
 *      `integration-check.checkTraffic`.
 *   2. **The parked fleet**, `statics`, or null for a process that has none.
 *      Both ends decode the same `.cars.bin` bytes into the same
 *      `StaticCarField`, so the *positions* and the *identities* are equal by
 *      construction rather than by agreement -- there is no clock in them at all.
 *
 * Where the two ends can still differ is residency and height, and both are
 * bounded rather than hoped about:
 *
 *   - **Residency.** The server's `.cars.bin` layer is wanted at
 *     `world.STATIC_CARS_NEED_MARGIN_M` (2,000 m) of any participant, and a
 *     hexagon is 6 km across; the browser holds a tile's cars only while the tile
 *     itself is built, which is a ring of a few hundred metres. So the server's
 *     set is a strict superset of the client's around any player, which is the
 *     direction that matters: the client cannot offer a car the server has not
 *     got. The reverse -- the server holding a car the client's tile has not
 *     arrived yet -- shows up as `E` working where no prompt was drawn, which is
 *     a keypress that did something rather than one that did nothing.
 *   - **Height.** See `game/staticcars.ts` section 3: two ground functions, a
 *     +/- `TAKE_HEIGHT` gate, and the server's answer wins.
 *
 * `taken` is the suppression predicate -- a car somebody is already driving is
 * not takeable, and without this clause two players would both "take" the same
 * identity and the second would get a record pointing at a suppressed ghost. It
 * is asked of both fleets, off the one `CarField.bySource` map, because
 * `DrivenCar.carId` does not record which fleet it came from and does not need
 * to.
 */
export function resolveTake(
  field: TrafficField,
  x: number,
  feetY: number,
  z: number,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
  taken: (identity: number) => boolean,
  out: TakeableCar,
  /**
   * The parked fleet, or null.
   *
   * **Last and optional** so that every existing call site keeps compiling and
   * means what it always meant: a check with no world, `verifyDriving`, and any
   * process that has not been given a `StaticCarField` simply sees the schedule
   * fleet, which is the behaviour that shipped before workstream S.
   */
  statics: StaticCarSource | null = null,
  /**
   * --- WORKSTREAM W: this taker's reach and the speed they can pull somebody
   * out at. `Sticky Fingers` moves both (2.2 → 3.2 m, 3 → 6 m/s).
   *
   * Last and optional, on the `statics` parameter's argument one line up: every
   * existing call site keeps compiling and keeps meaning what it always meant.
   * The caller supplies them rather than this function reading the lookup for
   * the reason `beginTake` states -- a take is arbitrated per player and the
   * radius belongs to the query.
   */
  radius = TAKE_RADIUS,
  takeableSpeed = TAKEABLE_SPEED,
): boolean {
  const q = _takeQuery;
  beginTake(q, x, feetY, z, radius);
  forEachCarNear(field, x, z, radius, tick, scratch, pose, (p) => {
    if (p.speed > takeableSpeed) return;
    if (taken(p.identity)) return;
    offerTake(
      q, out, p.identity, p.body, p.colour, p.x, p.y, p.z, headingYaw(p.dx, p.dz),
      p.stage === CAR_STAGE_PARKED_IN || p.stage === CAR_STAGE_PARKED_OUT,
    );
  });
  if (statics !== null) {
    statics.forEachStaticNear(x, feetY, z, radius, (c) => {
      // No speed clause: a static car is furniture and its speed is zero by
      // definition. And `parked` is unconditionally true -- it *is* the kerb.
      if (taken(c.identity)) return;
      offerTake(q, out, c.identity, c.body, c.colour, c.x, c.y, c.z, c.yaw, true);
    });
  }
  return q.found;
}

// --- The field ------------------------------------------------------------------------

/** One driven car, as both ends hold it. */
export interface DrivenCar {
  /** The allocation id, 1..n, and what `MSG.CARS` keys on. Never 0. */
  readonly id: number;
  /** `traffic.identityOf(route, slot)`: which ambient car this used to be. */
  readonly carId: number;
  /** `CAR_BODY_SIZE` index, 0..4, and the paint index. The "model". */
  readonly body: number;
  readonly colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Signed, m/s. Copied out of the driver's `carSpeed` by `follow`. */
  speed: number;
  /** The combatant driving it, or 0 for one left in the street. */
  driverId: number;
  /**
   * Milliseconds it has been standing empty. Reset the moment anybody takes it.
   *
   * This used to be the abandonment clock and it is now the *tie-break* on the
   * recycling rule -- see section 6. It still ages the same way; what changed is
   * that nothing compares it against a five-minute constant any more.
   */
  emptyMs: number;
  /**
   * Condition, 0..`CAR_HEALTH_MAX`. On the wire as a `u8`.
   *
   * Server-authoritative and predicted by the driver's client off the identical
   * `crashDamage` curve, which is what makes the health bar move on the frame
   * you hit the wall. A record adopted from `MSG.CARS` takes the authority's
   * number, so a misprediction is corrected on the next snapshot exactly as a
   * position is.
   */
  health: number;
  /**
   * Milliseconds until this car can be damaged again. See `CRASH_COOLDOWN_MS`.
   *
   * **Not on the wire**, and that is a real decision rather than an oversight.
   * It is a rate limiter and not a fact about the world: the server's copy is
   * the one that decides, and a client whose cooldown drifted by a tick would
   * mispredict one bump's worth of health and be corrected by the next
   * `MSG.CARS` -- which is the same correction that already absorbs every other
   * misprediction on this record. Twelve extra bytes a snapshot to make a rate
   * limiter authoritative is not a trade this wire makes.
   */
  damageCooldownMs: number;
  /**
   * --- WORKSTREAM W: who was last at the wheel of this car, or 0.
   *
   * Unlike `driverId` this is **not** cleared when they get out -- it is the
   * whole point of it. Two talents are about a car *you left*: `Park Anywhere`
   * makes it unrecyclable while you are online and untakeable by the other team,
   * and both questions are asked of a record whose `driverId` is already zero.
   *
   * Set on the take and on the sweep that empties a car, so it always names the
   * person who put the car where it is standing. **Not on the wire**, on
   * `damageCooldownMs`' argument one field up: the only readers are the
   * authority's recycler and its take arbitration, and a client that
   * mispredicted a refused take is corrected by the absence of a `CARS` frame.
   */
  lastDriverId: number;
  /**
   * --- THE FIRE. Milliseconds since this car caught, or `carfire.NOT_BURNING`.
   *
   * Advanced by `age` on both ends, exactly as `emptyMs` and `damageCooldownMs`
   * are, which is what makes the six-second countdown a shared closed form
   * rather than two clocks that have to agree. `game/carfire.ts` section 2 is
   * the whole argument for counting milliseconds here rather than stamping a
   * tick, and `protocol.CarRecord.fuse` is the one byte this becomes on the
   * wire.
   *
   * **On the wire, unlike the two clocks beside it**, and the difference is what
   * the field *is*: `damageCooldownMs` is a rate limiter and `emptyMs` is a
   * tie-break, both of which a client may quietly disagree about for a tick.
   * This one decides when a car ceases to exist and how long everybody standing
   * near it has to move, so every client draws it or the explosion is a surprise
   * to all but one of them.
   */
  burningMs: number;
  /**
   * Milliseconds until this car may catch fire again. `carfire.IGNITE_LOCK_MS`.
   *
   * **Not on the wire**, on `damageCooldownMs`' argument two fields up: it is a
   * rate limiter that exists to stop a fuse being re-stamped by a second blast
   * (`game/carfire.ts` section 5), the authority's copy is the one that decides,
   * and a client whose lock drifted by a tick mispredicts one ignition and is
   * corrected by the next `MSG.CARS`.
   */
  igniteLockMs: number;
}

/**
 * The contract the rest of the game holds this file by. **Do not rename** --
 * other workstreams call these two.
 */
export interface DrivingLookup {
  /** The car record id this player is driving, or 0. */
  carOf(playerId: number): number;
  /** Where a car record is, or null if there is no such record. */
  carPose(carId: number): { x: number; y: number; z: number; yaw: number; speed: number } | null;
}

/**
 * Every car anybody has taken, and the only thing allowed to change who is in
 * one.
 *
 * `game/bikes.BikeField` with the three differences section 4 of the header
 * lists. The server owns an instance and is authoritative; a connected client
 * owns one and treats it as a mirror `MSG.CARS` corrects; offline the client's
 * copy *is* the authority, which is what makes `?offline` a real test of the
 * feature rather than a second implementation of it.
 */
export class CarField implements DrivingLookup {
  private readonly byId = new Map<number, DrivenCar>();
  /** By source identity, so `suppressed` is a hash lookup and not a scan. */
  private readonly bySource = new Map<number, DrivenCar>();
  private flat: DrivenCar[] = [];
  private dirty = true;
  /**
   * The next id to hand out.
   *
   * Monotonic and **never reused**, on `protocol.AOI_ID_LIFECYCLE`'s argument:
   * an id that came back would let a `CARS` delete in flight remove the car that
   * inherited it, and the symptom -- somebody else's car vanishing when you
   * abandon yours -- is indistinguishable from a bug in the expiry. A `u16` at
   * one allocation per theft wraps after 65,535 stolen cars, which is a session
   * length nobody will reach; `alloc` skips over any id still live if it ever does.
   */
  private nextId = 1;

  /**
   * Put a car under a driver, allocating a record. Null if that ambient car is
   * already somebody's.
   *
   * The one place a claim is decided, `BikeField.claim`'s rule: everything else
   * -- the button edge, the range test, the HUD prompt -- is upstream of this
   * line, and "can two players take the same car" has exactly one answer.
   */
  take(source: TakeableCar, driverId: number): DrivenCar | null {
    if (this.bySource.has(source.identity)) return null;
    // **The budget.** See section 6: the caller is expected to have made room
    // with `recycleFarthest` first, and this is the line that makes the ceiling
    // an invariant of the class rather than a convention the callers keep. A
    // refused take is a press of `E` that did nothing, which is the correct
    // failure -- the alternative is a room whose join message grows without
    // bound.
    if (this.byId.size >= MAX_DRIVEN_CARS) return null;
    const id = this.alloc();
    const car: DrivenCar = {
      id,
      carId: source.identity,
      body: source.body,
      colour: source.colour,
      x: source.x,
      y: source.y,
      z: source.z,
      yaw: source.yaw,
      speed: 0,
      driverId,
      // WORKSTREAM W: the take *is* the last driver. See `lastDriverId`.
      lastDriverId: driverId,
      emptyMs: 0,
      health: CAR_HEALTH_MAX,
      damageCooldownMs: 0,
      // A car nobody has crashed yet. See `game/carfire.ts` for why the sentinel
      // is -1 and not 0.
      burningMs: NOT_BURNING,
      igniteLockMs: 0,
    };
    this.byId.set(id, car);
    this.bySource.set(car.carId, car);
    this.dirty = true;
    return car;
  }

  /**
   * Adopt a record the server described. The client mirror's only way in.
   *
   * Upsert by id, because `MSG.CARS` is an upsert -- see `protocol.encodeCars`.
   * The immutable half (`carId`, `body`, `colour`) is only ever written on the
   * insert, which is what makes it safe for a delta to carry it unchanged.
   */
  adopt(record: {
    id: number;
    carId: number;
    body: number;
    colour: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    driverId: number;
    /** Optional so a caller that predates the crash damage means "undamaged". */
    health?: number;
    /**
     * Deciseconds of fuse remaining, or 0/absent for a car that is not on fire.
     * `protocol.CarRecord.fuse`; optional on `health`'s argument one line up.
     */
    fuse?: number;
  }): DrivenCar {
    const existing = this.byId.get(record.id);
    if (existing) {
      existing.x = record.x;
      existing.y = record.y;
      existing.z = record.z;
      existing.yaw = record.yaw;
      existing.speed = record.speed;
      existing.driverId = record.driverId;
      // WORKSTREAM W: a record adopted with somebody in it names them as the
      // last driver too; one adopted empty keeps whoever it had. See
      // `lastDriverId` -- the field is not on the wire, so this is the only way
      // a client's mirror ever learns it, and the client only uses it to predict
      // its own refusals.
      if (record.driverId !== 0) existing.lastDriverId = record.driverId;
      // **The authority's health wins, always.** This is the line that corrects
      // a driver's prediction of their own crash, and it is unconditional for
      // the reason the position above it is: the server decided how hard you hit
      // the wall, and a client that kept its own answer whenever it was lower
      // would be a client that repaired its car by mispredicting.
      if (record.health !== undefined) existing.health = record.health;
      // **And the fire, on the health byte's terms with one clause added.** The
      // authority's answer wins when it says the car is burning, because that is
      // an event this end may not have predicted at all -- a chain ignition from
      // somebody else's explosion has no local cause. It does *not* win when it
      // says the car is not burning and this end thinks it is: a record re-sent
      // for an unrelated reason (a driver getting out) carries a fuse that was
      // quantised at the moment it was encoded, and a plain assignment would put
      // out every fire the authority happened to mention in passing. The
      // authority takes a burning car away by *removing* it, which is
      // unambiguous.
      if (record.fuse !== undefined && record.fuse > 0) {
        existing.burningMs = burningFromFuse(record.fuse);
      }
      if (record.driverId !== 0) existing.emptyMs = 0;
      return existing;
    }
    const car: DrivenCar = {
      ...record,
      lastDriverId: record.driverId,
      emptyMs: 0,
      health: record.health ?? CAR_HEALTH_MAX,
      damageCooldownMs: 0,
      burningMs: burningFromFuse(record.fuse ?? 0),
      igniteLockMs: 0,
    };
    this.byId.set(record.id, car);
    this.bySource.set(car.carId, car);
    this.dirty = true;
    // Keep the mirror's allocator ahead of the authority's, so an offline
    // session that later goes online cannot mint a colliding id.
    if (record.id >= this.nextId) this.nextId = record.id + 1;
    return car;
  }

  /**
   * The driver got out. Leaves the record standing where it is, with nobody in
   * it and no speed.
   *
   * Called by the **prediction**, and it exists because `follow` cannot cover
   * this one case: the sweep detects "the car's driver is no longer driving it"
   * by comparing ids, and offline the local player's id is 0, which is also the
   * empty sentinel -- so a deliberate exit is indistinguishable from a record
   * that was already empty. `follow`'s own header carries the same paragraph
   * from the other side. On the server this is `resolveMount`'s branch and the
   * sweep does the rest, so nothing there calls it.
   */
  leave(id: number): void {
    const car = this.byId.get(id);
    if (!car) return;
    car.driverId = 0;
    car.speed = 0;
    car.emptyMs = 0;
  }

  /** Drop a record entirely: it expired, or the server said so. */
  remove(id: number): boolean {
    const car = this.byId.get(id);
    if (!car) return false;
    this.byId.delete(id);
    // Guarded, because two records must never share a source and this is the
    // line that would silently un-suppress a live car if one ever did.
    if (this.bySource.get(car.carId) === car) this.bySource.delete(car.carId);
    this.dirty = true;
    return true;
  }

  get(id: number): DrivenCar | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Every record, in id order. Owned by this object and reused -- do not retain it. */
  all(): readonly DrivenCar[] {
    if (this.dirty) {
      this.flat = [...this.byId.values()].sort((a, b) => a.id - b.id);
      this.dirty = false;
    }
    return this.flat;
  }

  /**
   * **Is this ambient car somebody's?** Section 3 of the header: the whole of
   * how the schedule car you drove away in stops also driving to Ashfield.
   *
   * A `Map.has` rather than a scan, because this is asked once per car in view
   * per frame by `world/cars.TrafficMovers.update` -- up to 210 times a frame in
   * town -- and once per car near a combatant per tick by `traffic.carHitting`.
   */
  suppressed(identity: number): boolean {
    return this.bySource.has(identity) || this.scorched.has(identity);
  }

  /**
   * This ambient or parked car has been **destroyed** and must never come back.
   *
   * The one thing section 3 of the header did not have to answer until cars
   * could explode. Suppression there is a *loan*: the record holds the identity,
   * the timetable stops producing that car, and when the record is recycled the
   * car is simply there again in its bay -- which is exactly right for a car
   * somebody parked and walked away from.
   *
   * An exploded car is the other case, and it is the one the brief names: *"the
   * static/ambient identity stays suppressed so a burnt car does not reappear at
   * the kerb"*. `explode` removes the record, and a removal on its own hands the
   * identity back -- so the Camry you just blew up would be standing in its
   * parking space again on the very next frame, undamaged, in front of the
   * scorch mark it left. That is the single most obviously wrong thing this
   * feature could produce.
   *
   * So the identity goes into a set that is never emptied, and `suppressed`
   * answers for it forever. The memory is one number per car anybody destroys in
   * the life of a room; at a plausible worst case -- every one of
   * `MAX_DRIVEN_CARS` records destroyed and re-taken repeatedly over a long
   * session -- a few thousand entries, which is tens of kilobytes on the 1 GB
   * box and is not a budget anybody has to think about. A `Set` rather than a
   * flag on a record precisely because the record is the thing that goes away.
   */
  scorch(identity: number): void {
    this.scorched.add(identity);
  }

  /** How many cars have been destroyed here. The dev overlay and the checks. */
  get scorchedCount(): number {
    return this.scorched.size;
  }

  /** See `scorch`. Never emptied except by `clear`, which is a whole new room. */
  private readonly scorched = new Set<number>();

  /** `DrivingLookup`. Linear in driven cars, which are few by construction. */
  carOf(playerId: number): number {
    if (playerId === 0) return 0;
    for (const car of this.byId.values()) if (car.driverId === playerId) return car.id;
    return 0;
  }

  /** `DrivingLookup`. */
  carPose(carId: number): { x: number; y: number; z: number; yaw: number; speed: number } | null {
    const car = this.byId.get(carId);
    if (!car) return null;
    return { x: car.x, y: car.y, z: car.z, yaw: car.yaw, speed: car.speed };
  }

  /**
   * Reconcile every record against who is actually driving, after the
   * combatants have moved. Returns the records that changed, for the caller to
   * broadcast.
   *
   * **This is the whole of "you get thrown out"**, and doing it as a sweep
   * rather than as an event is what makes it total, exactly as
   * `BikeField.follow` argues: `combat.applyHit` clears `drivingCar` from three
   * files away, a player who disconnects simply stops being in the list, a
   * knockout has the same field cleared by the same line. All three are "the
   * car's driver is no longer driving it", all three leave the car in the road
   * where the body is, and none of them needed a message of their own.
   *
   * The occupied case is the brief's "the car pose is derived from the driver's
   * record": position and yaw are the driver's, so nothing about a moving car is
   * ever on the wire beyond what the snapshot already carried.
   */
  follow(drivers: Iterable<DriverView>, changed: DrivenCar[] = []): DrivenCar[] {
    changed.length = 0;
    const seen = new Map<number, DriverView>();
    for (const d of drivers) if (d.drivingCar !== 0) seen.set(d.drivingCar, d);

    for (const car of this.all()) {
      const driver = seen.get(car.id);
      // **Keyed on the car, not on `driverId !== 0`**, and that is not a
      // micro-optimisation -- it is the one place this class cannot borrow
      // `BikeField.follow` verbatim. Offline, `main.ts` gives the local player
      // the combatant id **0**, which is also this field's "nobody is in it"
      // sentinel and the wire's (`protocol.encodeCars`). Skipping on
      // `driverId === 0` therefore skipped the offline player's own car, which
      // stayed at the kerb it was taken from while its driver drove away --
      // invisible online, where ids start at 1, and the whole feature broken in
      // `?offline`. `factions.reportCrime`'s header documents the same trap
      // from the other side.
      //
      // So: a record somebody claims *by id* is carried, whatever that id is,
      // and a record nobody claims and nobody was in is simply left alone.
      if (driver === undefined && car.driverId === 0) continue;
      if (driver && driver.id === car.driverId) {
        car.x = driver.x;
        car.y = driver.feetY;
        car.z = driver.z;
        car.yaw = driver.yaw;
        car.speed = driver.carSpeed;
        car.emptyMs = 0;
        continue;
      }
      // Left, thrown out, knocked out or disconnected. The position is whatever
      // the last `follow` wrote, which is where the driver was, which is where
      // the car should be standing.
      // WORKSTREAM W: `lastDriverId` is deliberately *not* cleared here. See
      // the field: it is the answer to "who left this car", which is exactly the
      // question `Park Anywhere` asks about a car with no driver.
      car.driverId = 0;
      car.speed = 0;
      car.emptyMs = 0;
      changed.push(car);
    }
    return changed;
  }

  /**
   * Advance the two clocks a record carries: how long it has stood empty, and
   * how long until it can be crashed again.
   *
   * **This is what `expire` became.** It removes nothing -- see section 6: a car
   * somebody left in the street stays there for the life of the server, and the
   * only thing that ever takes one away is `recycleFarthest` running out of
   * budget. What it still does is age `emptyMs`, because that is now the
   * tie-break on which record the budget takes.
   *
   * Called at 1 Hz on the server, where the cooldown would be too coarse -- so
   * it is called every tick on both ends instead and `dtMs` is the step. Cheap:
   * O(records), two adds each, no allocation.
   */
  age(dtMs: number): void {
    for (const car of this.byId.values()) {
      if (car.driverId === 0) car.emptyMs += dtMs;
      if (car.damageCooldownMs > 0) {
        car.damageCooldownMs -= dtMs;
        if (car.damageCooldownMs < 0) car.damageCooldownMs = 0;
      }
      if (car.igniteLockMs > 0) {
        car.igniteLockMs -= dtMs;
        if (car.igniteLockMs < 0) car.igniteLockMs = 0;
      }
      // --- The fuse, and the fire eating what is left of the car.
      //
      // **This is the whole of the countdown on both ends.** `game/carfire.ts`
      // section 2: two processes that agree about when a car caught fire agree
      // about when it explodes, because the only thing either of them does is
      // add the same `dtMs` the same number of times. Nothing here removes a
      // record -- `sim.stepCars` is the authority for the bang, on the same
      // division of labour that makes `recycleFarthest` the only thing allowed
      // to drop a record.
      if (car.burningMs !== NOT_BURNING) {
        car.burningMs += dtMs;
        // The burn, applied **here rather than through `damage`** on purpose:
        // `damage` is the impact funnel and carries the half-second cooldown,
        // the talent multipliers and the ignition rules, none of which apply to
        // a fire. See `carfire.BURN_HP_PER_S`. A car that is already at zero --
        // which is nearly every burning car, because every write-off catches --
        // takes the first branch and this costs one comparison.
        if (car.health > 0) {
          car.health -= (BURN_HP_PER_S * dtMs) / 1000;
          if (car.health < 1e-9) car.health = 0;
          this.dirty = true;
        }
      }
    }
  }

  /**
   * Set this car alight. Returns the record if it caught, or null.
   *
   * Null covers three cases and no caller cares which: no such record, it is
   * already burning, and its ignition lock is still running. See
   * `carfire.canIgnite` -- the lock is the anti-re-stamp rule and its whole
   * argument is section 5 of that file.
   *
   * **The one place a car ever catches fire**, on `damage`'s own argument: a
   * crash arrives through `damage`, a chain reaction arrives through
   * `sim.explodeCar`, and both come here, so "is this car on fire and when did
   * it start" has exactly one answer rather than two that agree today.
   */
  ignite(carId: number): DrivenCar | null {
    const car = this.byId.get(carId);
    if (car === undefined) return null;
    if (!canIgnite(car.burningMs, car.igniteLockMs)) return null;
    car.burningMs = 0;
    car.igniteLockMs = IGNITE_LOCK_MS;
    this.dirty = true;
    return car;
  }

  /**
   * Take `amount` health off a car. Returns the record if it changed, or null.
   *
   * **The one place a car's condition ever falls**, on `take`'s own argument:
   * the crash detection, the car-against-car test and the pedestrian clause all
   * arrive here, so "how much did that cost and was it inside the cooldown" has
   * exactly one answer rather than three that agree today. The authority calls
   * it and the driver's client calls it with the same delta-v, which is what
   * makes the health bar move on the frame of the impact.
   *
   * Null covers three cases and the caller cares about none of them separately:
   * no such record, the cooldown is still running, and the car is already a
   * write-off. In all three, nothing to broadcast.
   */
  damage(carId: number, amount: number): DrivenCar | null {
    const car = this.byId.get(carId);
    if (car === undefined) return null;
    if (car.damageCooldownMs > 0) return null;
    if (!(amount > 0)) return null;
    if (car.health <= 0) return null;
    // --- WORKSTREAM W. Three talents meet here and this is the only funnel every
    // impact goes through -- a wall, another player's car, an ambient car and a
    // kerb all arrive on this line -- which is why the hooks are here rather
    // than at the four call sites.
    //
    // `driverId` is 0 for a car standing empty, and `fx*` of 0 is the identity,
    // so a parked car shot at by a stray crash is billed exactly as it was.
    const driver = car.driverId;
    // Northern Beaches Tunnel: a ram under 20 m/s costs the car nothing at all.
    // Above it the car pays in full, which is what stops the mega being a car
    // that cannot be written off.
    if (fxRamFreeCrash(driver, car.speed)) return null;
    // Kept for the ignition test below, which is a question about the condition
    // the car was in **before** the impact -- see `carfire.ignitesOnCrash`, and
    // `carfire.IGNITE_CRASH_HP` for why "already broken" is the reading.
    const healthBefore = car.health;
    const cost = amount * fxCarDamageScale(driver);
    car.health -= cost;
    // `applyCarHit`'s femto-pip clamp, and it matters here for its reason: a
    // health of 4e-15 is a car that is not written off, does not smoke black,
    // and has an engine that still turns over -- which is a car nobody can tell
    // apart from a wreck and which no player will ever manage to finish off.
    if (car.health < 1e-9) car.health = 0;
    // --- **And the fire.** The owner's second sentence, hung off the one funnel
    // every impact in the game already goes through.
    //
    // Here rather than at the four call sites for exactly the reason the talent
    // hooks above are here: a wall, another player's car, an ambient car, a kerb
    // and the blast from a car that has already exploded all arrive on this
    // line, and an ignition rule copied into five of them is five rules that
    // agree today. It also means the chain reaction needed no code of its own --
    // `sim.explodeCar` calls `damage` with `carfire.CHAIN_DAMAGE` and a car that
    // was already broken catches, which is the feature.
    //
    // The **cost after the talent** is what is tested, deliberately: a `Ute Life`
    // driver whose 6.8 hp wall was reduced to 4.8 took a 4.8 hp hit, and the fire
    // should read off what actually happened to the car rather than off what
    // would have happened to somebody else's. Since the retune that is the
    // difference between clearing `carfire.IGNITE_CRASH_HP` and not.
    if (ignitesOnCrash(healthBefore, car.health, cost)) this.ignite(car.id);
    // WORKSTREAM W: `Ute Life` shortens the window 500 → 300 ms. Absolute and
    // min-wins; the key is in seconds and this field is in ms.
    car.damageCooldownMs = fxCrashCooldownS(driver, CRASH_COOLDOWN_MS / 1000) * 1000;
    this.dirty = true;
    return car;
  }

  /**
   * Free one record so a take can go ahead, and say which one went. 0 for none.
   *
   * `playersXZ` is a **flat `[x, z, x, z, ...]`**, which is deliberately not an
   * array of objects: it is built once a tick in `server/sim.ts`'s hot path and
   * a list of sixteen `{x, z}` literals is sixteen allocations a tick for a
   * function that usually does nothing at all.
   *
   * The rule, and every clause of it is in section 6 of the header: never an
   * occupied car, never one within `RECYCLE_KEEP_RADIUS` of anybody, then the
   * farthest from everybody, then the longest unoccupied, then the lowest id.
   * The last tie-break exists for the reason every tie-break in this project
   * does -- two builds handed the same room must choose the same car, and an
   * integer comparison is a rule both can state where a float comparison is one
   * they can disagree about.
   *
   * Returning 0 is a legal and expected answer: a room where four hundred cars
   * are all being driven, or all parked in the same suburb as the players, has
   * nothing it can give back, and the take upstream simply fails.
   */
  recycleFarthest(
    playersXZ: readonly number[],
    /** WORKSTREAM W: is this car's last driver exempt? Null for "nobody is". */
    neverRecycles: ((playerId: number) => boolean) | null = null,
  ): number {
    if (this.byId.size === 0) return 0;
    let bestId = 0;
    let bestDistance = -1;
    let bestEmpty = -1;
    for (const car of this.all()) {
      if (car.driverId !== 0) continue;
      // --- WORKSTREAM W: `Park Anywhere`'s "never recycles while you are
      // online". Skipped outright rather than sorted to the back, because the
      // talent is a promise and a car that is recycled *last* is still recycled.
      //
      // "While you are online" is `neverRecycles`, which the caller supplies:
      // `game/teamfx.fxCarNeverRecycles` answers off the installed `TeamLookup`,
      // and the framework's lookup returns nothing for an id that has left. That
      // is what stops a departed player's fleet holding the room's four hundred
      // records forever -- the exemption evaporates with them.
      if (neverRecycles !== null && car.lastDriverId !== 0 && neverRecycles(car.lastDriverId)) continue;
      // Plan distance to the nearest person, squared until the comparison is
      // over -- the one `Math.sqrt` is taken after the winner is known, because
      // squares order the same way distances do.
      let nearest2 = Infinity;
      for (let i = 0; i + 1 < playersXZ.length; i += 2) {
        const dx = playersXZ[i] - car.x;
        const dz = playersXZ[i + 1] - car.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearest2) nearest2 = d2;
      }
      if (nearest2 < RECYCLE_KEEP_RADIUS * RECYCLE_KEEP_RADIUS) continue;
      const distance = nearest2 === Infinity ? Infinity : nearest2;
      if (bestId !== 0) {
        if (distance < bestDistance) continue;
        if (distance === bestDistance) {
          if (car.emptyMs < bestEmpty) continue;
          if (car.emptyMs === bestEmpty && car.id >= bestId) continue;
        }
      }
      bestId = car.id;
      bestDistance = distance;
      bestEmpty = car.emptyMs;
    }
    if (bestId === 0) return 0;
    // Removing the record is the whole of putting the car back: the ambient copy
    // was only ever suppressed (section 3), so `poseCar` starts drawing it again
    // on the next frame, on its own timetable, 250 m from anybody.
    this.remove(bestId);
    return bestId;
  }

  /** Empty the field. A respawn of the whole room, and the self-checks. */
  clear(): void {
    this.byId.clear();
    this.bySource.clear();
    // The scorch ledger goes too, and it is the one place it ever does: `clear`
    // means "this is a different world now", which is exactly when a car that
    // was destroyed should be back at its kerb. See `scorch`.
    this.scorched.clear();
    this.dirty = true;
  }

  private alloc(): number {
    // Skips live ids, so a wrapped `u16` cannot collide. See `nextId`.
    for (let n = 0; n < 65536; n++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!this.byId.has(id)) return id;
    }
    return 0;
  }
}

/** What `CarField.follow` needs from a combatant. `bikes.RiderView`'s shape. */
export interface DriverView {
  readonly id: number;
  readonly drivingCar: number;
  readonly carSpeed: number;
  readonly x: number;
  readonly feetY: number;
  readonly z: number;
  readonly yaw: number;
}

// --- The witness --------------------------------------------------------------------

/**
 * Did **anybody** see that?
 *
 * `factions.policeWitness` answers the same question for police only, and the
 * brief asked for a bystander variant. It lives here rather than in
 * `factions.ts` because the caller is this feature: car theft is the first crime
 * in the game a civilian is allowed to report, and every existing one is either
 * unconditional or witnessed by an officer.
 *
 * The geometry is `policeWitness`' verbatim -- a range gate and then
 * `collision.blocked` from the witness's eye to chest height at the crime -- and
 * a world with no collision counts as clear, which is that function's stated
 * failure mode and the right one: a crowd that cannot see anything until the
 * prisms arrive is a crowd that does not exist for the first second of a session.
 *
 * `forEach` is `pedestrians.forEachPedestrianNear` bound by the caller, which is
 * what keeps this file out of the pedestrian module's import graph and lets
 * `verifyDriving` drive it with three people in an array.
 */
export function bystanderSeen(
  x: number,
  y: number,
  z: number,
  forEach: (visit: (px: number, py: number, pz: number, down: boolean) => void) => void,
  blocked: ((ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean) | null,
): boolean {
  let seen = false;
  forEach((px, py, pz, down) => {
    if (seen) return;
    // Somebody face down on the footpath is not a witness. The same clause
    // `strikePedestrian` uses to refuse a second hit, for the same reason: a
    // body is not a person for the purposes of anything.
    if (down) return;
    const dx = px - x;
    const dz = pz - z;
    if (dx * dx + dz * dz > WITNESS_RADIUS * WITNESS_RADIUS) return;
    if (blocked !== null && blocked(px, py + WITNESS_EYE, pz, x, y + CRIME_HEIGHT, z)) return;
    seen = true;
  });
  return seen;
}

// --- Small shared arithmetic ----------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Move `v` toward `target` by at most `step`, never past it.
 *
 * The "never past it" is the whole of why this is a function. Every one of the
 * five branches in `stepCarSpeed` is a rate times `dt`, and at 60 Hz with a
 * 16 m/s^2 handbrake that is 0.27 m/s a tick -- enough to walk a stopped car
 * backwards forever if the clamp is missing on any one of them.
 */
function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

// --- The self-check ------------------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 * Every failure below renders. None of them throws.
 *
 *   - **A car that never stops.** A missing clamp in `approach` is a handbrake
 *     that reverses you, and it looks like a physics quirk rather than a bug.
 *   - **A car that pirouettes.** Without the grip ramp, holding `D` at a
 *     standstill spins the body on the spot -- the single most obviously wrong
 *     thing a car can do, and invisible to every test that only drives forwards.
 *   - **Two players in one car.** `take` returning a record for an identity
 *     somebody already has is two people steering one 4.4 m box.
 *   - **A ghost on the timetable.** `suppressed` failing to answer for a taken
 *     car is the ambient copy driving to Ashfield beside you, running people
 *     down on the way.
 *   - **A speed scale that means something else.** `SPRINT_SPEED` here has to be
 *     the controller's, and if it drifts every car in the city quietly changes
 *     top speed with nothing in this file edited.
 *   - **A scrape that writes a car off.** Without `CRASH_COOLDOWN_MS` a wall is
 *     sixty impacts a second, and the symptom is not "the cooldown is broken" --
 *     it is "cars break for no reason", which nobody can debug from a report.
 *   - **A wall that is free.** The nose probe returns a delta-v now, and a
 *     probe that reported zero would leave every crash in the game costless
 *     while every other part of the feature carried on working.
 *   - **A car recycled out of somebody's windscreen.** The keep radius is the
 *     one clause of the budget a player can be surprised by, and its failure is
 *     a car disappearing while somebody is looking at it.
 *   - **A car that despawned anyway.** The owner asked for cars that stay. The
 *     hour-long check below is what stops a five-minute clock creeping back in
 *     under another name.
 *   - **WORKSTREAM S: a parked car that cannot win the take.** The two fleets are
 *     arbitrated by one rule over the union of them (`beginTake`/`offerTake`), and
 *     a second source whose candidates are always rejected leaves the reported
 *     bug exactly as it was with a green check beside it. The block at the bottom
 *     of this function drives that arbitration with hand-placed candidates from
 *     both fleets, including the tie -- which a bay row in Surry Hills genuinely
 *     is, and which two builds must break the same way.
 */
export function verifyDriving(): string[] {
  const failures: string[] = [];

  // --- The integrator reaches the stated top speed and does not pass it.
  //
  // Twelve seconds of throttle rather than the ten this used to run, because the
  // top speed doubled and the acceleration did not: the ramp is 7.3 s now and a
  // ten-second window is only 37% of headroom over it. Twelve keeps the same
  // "comfortably past the ramp" property the original had.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    const dt = 1 / 60;
    for (let i = 0; i < 720; i++) stepCarSpeed(c, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
    if (Math.abs(c.carSpeed - DRIVE_TOP_SPEED) > 1e-6) {
      failures.push(`Twelve seconds of throttle reached ${c.carSpeed.toFixed(3)} m/s, not ${DRIVE_TOP_SPEED}.`);
    }
    // And it got there in about the time the constant promises: v/a = 7.33 s.
    const ramp: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    let ticks = 0;
    while (ramp.carSpeed < DRIVE_TOP_SPEED - 1e-9 && ticks < 3600) {
      stepCarSpeed(ramp, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
      ticks++;
    }
    const seconds = ticks / 60;
    const want = DRIVE_TOP_SPEED / DRIVE_ACCELERATION;
    if (Math.abs(seconds - want) > 0.1) {
      failures.push(
        `0 to ${DRIVE_TOP_SPEED} m/s took ${seconds.toFixed(2)} s against the ${want.toFixed(2)} s ` +
          `${DRIVE_ACCELERATION} m/s^2 promises.`,
      );
    }
    // **The instruction's own number, asserted rather than assumed.** *"make
    // cars top velocity 100% faster"* is a claim about a specific figure --
    // 44 m/s, 158 km/h -- and it is the one thing in this block that a future
    // tuning pass could quietly undo while every relative check above still
    // passed. `DRIVE_TOP_SPEED_ROUGH` is checked against the *rule* (half)
    // rather than against 22, because it is now derived and asserting the
    // literal would be comparing a constant with itself.
    if (DRIVE_TOP_SPEED !== 44) {
      failures.push(
        `DRIVE_TOP_SPEED is ${DRIVE_TOP_SPEED} m/s. The instruction doubled it from 22 to 44 ` +
          `(158 km/h); a change back is a change to the feature, not to a tuning knob.`,
      );
    }
    if (Math.abs(DRIVE_TOP_SPEED_ROUGH - DRIVE_TOP_SPEED * 0.5) > 1e-9) {
      failures.push(
        `Off-road is ${DRIVE_TOP_SPEED_ROUGH} m/s against a road top of ${DRIVE_TOP_SPEED}; the rule ` +
          `this constant states is "half", and half is what makes the road network worth using.`,
      );
    }
    // Every deceleration is at least the acceleration and stops the car in the
    // time the headers claim -- the invariant the doubling was carried out
    // under. Two and a half seconds is the brake's 2.44 rounded up.
    const stopSeconds = DRIVE_TOP_SPEED / DRIVE_BRAKE;
    if (stopSeconds > 2.5) {
      failures.push(
        `Full brake from the top speed takes ${stopSeconds.toFixed(2)} s. The doubling was done on ` +
          `the rule that every time-to-stop is unchanged, and the old car stopped in 2.44 s.`,
      );
    }
    const coastSeconds = DRIVE_TOP_SPEED / DRIVE_COAST;
    if (coastSeconds > 11) {
      failures.push(
        `A car coasting from the top speed rolls for ${coastSeconds.toFixed(1)} s. Over about ten ` +
          `seconds engine braking reads as a stuck throttle rather than as a car with weight.`,
      );
    }
  }

  // --- The brake is stronger than the throttle, and the handbrake than both.
  {
    const dt = 1 / 60;
    const shed = (input: { forward: number; jump: boolean }): number => {
      const c: DriveState = { drivingCar: 1, carSpeed: DRIVE_TOP_SPEED, carHealth: CAR_HEALTH_MAX };
      stepCarSpeed(c, input, dt, 0, 0, 0, 0, null);
      return DRIVE_TOP_SPEED - c.carSpeed;
    };
    const coast = shed({ forward: 0, jump: false });
    const brake = shed({ forward: -1, jump: false });
    const hand = shed({ forward: 0, jump: true });
    if (!(hand > brake && brake > coast && coast > 0)) {
      failures.push(
        `A tick sheds ${coast.toFixed(3)} coasting, ${brake.toFixed(3)} braking and ${hand.toFixed(3)} ` +
          `on the handbrake; they must be ordered.`,
      );
    }
    if (Math.abs(brake - DRIVE_BRAKE * dt) > 1e-9) {
      failures.push(`The brake shed ${brake.toFixed(4)} m/s in a tick, not ${(DRIVE_BRAKE * dt).toFixed(4)}.`);
    }
  }

  // --- The handbrake stops the car and does not walk it backwards.
  //
  // The clamp in `approach`, and it is the failure this whole function exists
  // for: at 60 Hz a 16 m/s^2 handbrake overshoots zero by up to 0.27 m/s, and an
  // unclamped subtract leaves a "stopped" car creeping down the street forever.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0.1, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 120; i++) stepCarSpeed(c, { forward: 0, jump: true }, 1 / 60, 0, 0, 0, 0, null);
    if (c.carSpeed !== 0) failures.push(`Two seconds of handbrake left the car at ${c.carSpeed} m/s, not stopped.`);
    const back: DriveState = { drivingCar: 1, carSpeed: -0.1, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 120; i++) stepCarSpeed(back, { forward: 0, jump: true }, 1 / 60, 0, 0, 0, 0, null);
    if (back.carSpeed !== 0) failures.push(`The handbrake left a reversing car at ${back.carSpeed} m/s.`);
    // And coasting settles at exactly zero too.
    const roll: DriveState = { drivingCar: 1, carSpeed: 0.01, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 120; i++) stepCarSpeed(roll, { forward: 0, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    if (roll.carSpeed !== 0) failures.push(`A coasting car settled at ${roll.carSpeed} m/s rather than stopping.`);
  }

  // --- Reverse is capped at its fraction and is not a second forward gear.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 600; i++) stepCarSpeed(c, { forward: -1, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    const want = -DRIVE_TOP_SPEED * DRIVE_REVERSE;
    if (Math.abs(c.carSpeed - want) > 1e-6) {
      failures.push(`Reverse topped out at ${c.carSpeed.toFixed(2)} m/s, not ${want.toFixed(2)}.`);
    }
  }

  // --- Off-road is slower, and a world that cannot say counts as road.
  {
    const rough: DrivingWorld = { collision: null, onRoad: () => false };
    const c: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 600; i++) stepCarSpeed(c, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, rough);
    if (Math.abs(c.carSpeed - DRIVE_TOP_SPEED_ROUGH) > 1e-6) {
      failures.push(`Off the road the car reached ${c.carSpeed.toFixed(2)} m/s, not ${DRIVE_TOP_SPEED_ROUGH}.`);
    }
    // Driving off a road at speed has to be *clamped down to* the new top rather
    // than approached from the wrong side -- see the re-clamp in `stepCarSpeed`.
    const fast: DriveState = { drivingCar: 1, carSpeed: DRIVE_TOP_SPEED, carHealth: CAR_HEALTH_MAX };
    stepCarSpeed(fast, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, rough);
    if (fast.carSpeed > DRIVE_TOP_SPEED_ROUGH + 1e-9) {
      failures.push(`A car that left the road at ${DRIVE_TOP_SPEED} m/s was still doing ${fast.carSpeed.toFixed(2)}.`);
    }
    const silent: DrivingWorld = { collision: null };
    const road: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    for (let i = 0; i < 600; i++) stepCarSpeed(road, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, silent);
    if (Math.abs(road.carSpeed - DRIVE_TOP_SPEED) > 1e-6) {
      failures.push('A world that does not know where the roads are made every car an off-road car.');
    }
  }

  // --- A player on foot is not touched by any of it.
  {
    const c: DriveState = { drivingCar: 0, carSpeed: 9, carHealth: CAR_HEALTH_MAX };
    stepCarSpeed(c, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    if (c.carSpeed !== 0) failures.push(`Somebody on foot kept a car speed of ${c.carSpeed}.`);
    const movement: InputSnapshot = { forward: 1, right: 1, jump: true, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(c, movement);
    if (!movement.jump || movement.right !== 1 || movement.speedScale !== undefined || movement.sprint) {
      failures.push('shapeDriveInput changed the input of somebody who is not in a car.');
    }
  }

  // --- The shaped input asks the controller for exactly the car's own speed.
  {
    const c: DriveState = { drivingCar: 4, carSpeed: 15, carHealth: CAR_HEALTH_MAX };
    const movement: InputSnapshot = { forward: 0, right: 1, jump: true, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(c, movement);
    if (!movement.sprint) failures.push('A driver was not put into a sprint, so the scale applies to the walk speed.');
    if (movement.right !== 0) failures.push(`A driver's strafe was ${movement.right}; a car does not crab.`);
    if (movement.jump) failures.push('A driver could jump. Space is the handbrake.');
    if (movement.forward !== 1) failures.push(`A forward driver's throttle was ${movement.forward}, not 1.`);
    // `SPRINT x speedScale x |forward|` has to come out at the car's speed.
    const target = SPRINT_SPEED * (movement.speedScale ?? 0) * Math.min(Math.abs(movement.forward), 1);
    if (Math.abs(target - 15) > 1e-9) {
      failures.push(`The controller would target ${target.toFixed(3)} m/s for a car doing 15.`);
    }
    // And in reverse, where the sign lives on `forward` and the magnitude in the
    // scale -- the one place this remap is easy to get half right.
    const back: DriveState = { drivingCar: 4, carSpeed: -5, carHealth: CAR_HEALTH_MAX };
    const rev: InputSnapshot = { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(back, rev);
    if (rev.forward !== -1) failures.push(`A reversing driver's throttle was ${rev.forward}, not -1.`);
    const revTarget = SPRINT_SPEED * (rev.speedScale ?? 0) * Math.min(Math.abs(rev.forward), 1);
    if (Math.abs(revTarget - 5) > 1e-9) {
      failures.push(`The controller would target ${revTarget.toFixed(3)} m/s for a car reversing at 5.`);
    }
    // It composes rather than replaces, exactly as `shapeRideInput` does, so a
    // Flat White taken on foot and still running does not silently vanish.
    const buffed: DriveState = { drivingCar: 4, carSpeed: 11, carHealth: CAR_HEALTH_MAX };
    const withCoffee: InputSnapshot = { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, speedScale: 2 };
    shapeDriveInput(buffed, withCoffee);
    if (Math.abs((withCoffee.speedScale ?? 0) - (11 / SPRINT_SPEED) * 2) > 1e-9) {
      failures.push('shapeDriveInput replaced the existing speed scale instead of composing with it.');
    }
  }

  // --- `SPRINT_SPEED` is still the controller's. See the constant.
  //
  // Measured the only way this file can measure it: `game/bikes.ts` keeps the
  // same literal for the same reason, so the two have to agree, and if either
  // moves without the controller the check fails here first.
  if (SPRINT_SPEED !== 8.2) {
    failures.push(`SPRINT_SPEED is ${SPRINT_SPEED}; controller.SPRINT_SPEED is 8.2 and every car's top speed rides on it.`);
  }

  // --- The wheel: nothing at rest, mirrored, falling with speed, inverted in reverse.
  {
    const out: DriveSteering = { right: 0, yawDelta: 0 };
    const onFoot: DriveState = { drivingCar: 0, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    shapeDriveSteering(onFoot, 1, 8.2, 1 / 60, out);
    if (out.right !== 1 || out.yawDelta !== 0) {
      failures.push(`A walker's A/D became right=${out.right}, yaw ${out.yawDelta}; on foot it is a strafe.`);
    }

    const parked: DriveState = { drivingCar: 2, carSpeed: 0, carHealth: CAR_HEALTH_MAX };
    shapeDriveSteering(parked, 1, 0, 1 / 60, out);
    if (out.yawDelta !== 0) {
      failures.push(`A stationary car turned ${out.yawDelta} rad holding D. A car is not a turntable.`);
    }

    const rolling: DriveState = { drivingCar: 2, carSpeed: 10, carHealth: CAR_HEALTH_MAX };
    shapeDriveSteering(rolling, 1, 10, 1 / 60, out);
    if (out.right !== 0) failures.push(`A driver holding D still had right=${out.right}; the strafe must be gone.`);
    if (!(out.yawDelta < 0)) {
      failures.push(`Holding D in a car changed yaw by ${out.yawDelta}; yaw increasing turns left, so D takes it down.`);
    }
    const left: DriveSteering = { right: 0, yawDelta: 0 };
    shapeDriveSteering(rolling, -1, 10, 1 / 60, left);
    if (Math.abs(left.yawDelta + out.yawDelta) > 1e-12) {
      failures.push(`A and D are not mirror images: ${left.yawDelta} against ${out.yawDelta}.`);
    }
    // Reverse inverts, which is what backing out of a driveway needs.
    const backing: DriveState = { drivingCar: 2, carSpeed: -4, carHealth: CAR_HEALTH_MAX };
    const rev: DriveSteering = { right: 0, yawDelta: 0 };
    shapeDriveSteering(backing, 1, -4, 1 / 60, rev);
    if (!(rev.yawDelta > 0)) {
      failures.push(`Holding D while reversing turned ${rev.yawDelta} rad; a reversing car steers the other way.`);
    }

    // Falls with speed over the range the grip ramp is finished for.
    const slow = driveTurnRate(5);
    const mid = driveTurnRate(12);
    const fast = driveTurnRate(DRIVE_TOP_SPEED);
    if (!(slow > mid && mid > fast)) {
      failures.push(`The turn rate is not falling with speed: ${slow.toFixed(2)}, ${mid.toFixed(2)}, ${fast.toFixed(2)}.`);
    }
    if (driveTurnRate(0) !== 0) failures.push(`driveTurnRate(0) is ${driveTurnRate(0)}, not zero.`);
    // And the radius stays in one order of magnitude across the range, which is
    // the property the ramp exists to hold. `bikes.verifyBikes`' own assertion.
    //
    // **140 m rather than the 70 this used to allow**, and the widening is the
    // top speed's doubling arriving here. A radius bound is a bound on `v/w`,
    // so at twice the speed the same *feel* is twice the radius; holding 70 m at
    // 44 m/s would have demanded 0.63 rad/s, which is 28 m/s^2 of lateral
    // acceleration and is the slot car `DRIVE_TURN_RATE_FAST`'s header refuses.
    const radiusTop = DRIVE_TOP_SPEED / fast;
    if (radiusTop > 140) {
      failures.push(`A car at ${DRIVE_TOP_SPEED} m/s turns in ${radiusTop.toFixed(0)} m; that is not a corner.`);
    }
    // The other side of the same number, and the one that actually decides
    // whether a car reads as having mass: **lateral acceleration at the top**.
    //
    // This check is new with the doubling and it is the one that matters, for a
    // reason the radius bound alone cannot express. A radius that is too small
    // and a radius that is too large are different failures -- one is a spin,
    // one is a barge -- and `v x w` is the quantity that distinguishes them at
    // any speed. 1.6 g is the arcade allowance; a real sedan on a dry road is
    // about 0.9 and this game has never pretended to be one. Past 2 g the car
    // stops being a car and starts being a cursor, and there is no frame that
    // says so: it simply feels good to whoever tuned it.
    const lateralTop = DRIVE_TOP_SPEED * fast;
    if (lateralTop > 1.6 * 9.81) {
      failures.push(
        `A car cornering at ${DRIVE_TOP_SPEED} m/s pulls ${(lateralTop / 9.81).toFixed(2)} g ` +
          `(${lateralTop.toFixed(1)} m/s^2). Past about 1.6 g it is a slot car; see DRIVE_TURN_RATE_FAST.`,
      );
    }
    if (12 / mid < 3) failures.push('A car at 12 m/s turns inside three metres, which is a spin.');
  }

  // --- The nose probe stops the car at a wall and leaves it alone in the open.
  {
    const open: DrivingWorld = { collision: { resolve: (fx, fz) => ({ x: fx, z: fz, hit: false }) } };
    const wall: DrivingWorld = { collision: { resolve: (fx, fz) => ({ x: fx, z: fz, hit: true }) } };
    const clear: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (stepCarSpeed(clear, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, open) !== 0) {
      failures.push('The nose probe reported a bump in an empty world.');
    }
    if (clear.carSpeed < 20) failures.push('An unobstructed car was slowed by its own nose probe.');

    const stopped: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    // The return is the **delta-v**, which is what `crashDamage` is fed. Two
    // thirds of 20 m/s is 13.2, and a bump that reported 0 would be a car that
    // hit a wall for free.
    const hitDv = stepCarSpeed(stopped, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, wall);
    if (!(hitDv > 0)) {
      failures.push('The nose probe did not report driving into a wall.');
    }
    if (Math.abs(hitDv - 20 * NOSE_SHED) > 0.5) {
      failures.push(
        `Driving into a wall at 20 m/s reported ${hitDv.toFixed(2)} m/s of delta-v; the probe sheds ` +
          `${NOSE_SHED.toFixed(2)} of it, so it is about ${(20 * NOSE_SHED).toFixed(1)}. This number is the crash damage.`,
      );
    }
    // --- **And how square it was.** The glancing-blow rule's one input, taken
    // off the resolver's push-out. See `GLANCING_FLOOR` and the probe itself.
    //
    // Both fixtures above resolve to the probe's *origin*, which is a push
    // straight back along the heading -- a car driving into the end of a wall --
    // so the head-on-ness must be 1. A probe that reported a glancing hit here
    // would make every wall in the city cost a third of what it should, and
    // there is no frame that says so.
    if (stopped.carCrashHeadOn === undefined || Math.abs(stopped.carCrashHeadOn - 1) > 1e-6) {
      failures.push(`Driving square into a wall reported a head-on-ness of ${stopped.carCrashHeadOn}, not 1.`);
    }
    // A wall the car is running *alongside* pushes the probe sideways, and that
    // is the impact the rule exists for: the same speed, a fraction of the cost.
    // `yaw` 0 faces -Z, so forward is (0, -1) and a push along +X is a pure
    // scrape down the side of a building.
    {
      const alongside: DrivingWorld = {
        collision: { resolve: (_fx, _fz, tx, tz) => ({ x: tx + 0.4, z: tz, hit: true }) },
      };
      const scrape: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
      stepCarSpeed(scrape, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, alongside);
      if (scrape.carCrashHeadOn === undefined || scrape.carCrashHeadOn > 0.01) {
        failures.push(
          `Scraping along the side of a wall reported a head-on-ness of ${scrape.carCrashHeadOn}. The push-out ` +
            'is perpendicular to the heading, so it is zero and the floor is applied by `crashDamage`.',
        );
      }
    }
    if (!(stopped.carSpeed < 20)) failures.push(`A car drove into a wall at ${stopped.carSpeed} m/s and did not slow.`);
    for (let i = 0; i < 60; i++) stepCarSpeed(stopped, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, wall);
    if (stopped.carSpeed !== 0) {
      failures.push(`A second of full throttle into a wall left the car doing ${stopped.carSpeed} m/s.`);
    }
    // Reverse is not probed -- see `stepCarSpeed` -- so backing into the same
    // wall must be untouched by it rather than mysteriously braked.
    const back: DriveState = { drivingCar: 1, carSpeed: -5, carHealth: CAR_HEALTH_MAX };
    if (stepCarSpeed(back, { forward: -1, jump: false }, 1 / 60, 0, 0, 0, 0, wall) !== 0) {
      failures.push('The nose probe fired while reversing; it only looks forwards.');
    }
  }

  // --- One car, two claimants, one driver; and the ghost is suppressed.
  {
    const field = new CarField();
    const source: TakeableCar = { identity: 0xabcd01, body: 2, colour: 3, x: 10, y: 1, z: -4, yaw: 0.5, parked: true };
    const first = field.take(source, 7);
    if (first === null) failures.push('The first take of a free car was refused.');
    if (field.take(source, 8) !== null) {
      failures.push('Two players both took the same ambient car. A claim must resolve to one driver.');
    }
    if (!field.suppressed(source.identity)) {
      failures.push('A taken car was not suppressed; the ambient copy is still driving to Ashfield.');
    }
    if (field.suppressed(source.identity ^ 1)) failures.push('An untaken car was suppressed.');
    if (field.carOf(7) !== first!.id) failures.push(`carOf(7) said ${field.carOf(7)}, not ${first!.id}.`);
    if (field.carOf(8) !== 0) failures.push('carOf named a car for somebody who is not driving.');
    if (field.carOf(0) !== 0) failures.push('carOf answered for player id 0, which is "nobody" on the wire.');
    const pose = field.carPose(first!.id);
    if (!pose || pose.x !== 10 || pose.yaw !== 0.5) failures.push('carPose did not describe the car it was asked about.');
    if (field.carPose(99999) !== null) failures.push('carPose invented a car that does not exist.');

    // Ids are never reused, so a delete in flight cannot remove the wrong car.
    field.remove(first!.id);
    if (field.suppressed(source.identity)) failures.push('Removing a record left its ambient car suppressed.');
    const second = field.take(source, 9);
    if (second === null || second.id === first!.id) {
      failures.push(`A reallocated car got id ${second?.id}, which is the id just freed.`);
    }
  }

  // --- `follow` carries a car with its driver and leaves it where they stopped.
  {
    const field = new CarField();
    const car = field.take({ identity: 11, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 5)!;
    const other = field.take({ identity: 12, body: 0, colour: 0, x: 100, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    const driver = { id: 5, drivingCar: car.id, carSpeed: 14, x: 30, feetY: 2, z: -7, yaw: 1.2 };
    field.follow([driver]);
    if (car.x !== 30 || car.y !== 2 || car.z !== -7 || car.yaw !== 1.2 || car.speed !== 14) {
      failures.push(`A driven car did not follow its driver; it is at (${car.x}, ${car.y}, ${car.z}).`);
    }
    if (other.x !== 100) failures.push('An empty car moved when somebody else drove past.');

    // Knocked out: `combat.applyHit` clears the field and the sweep does the rest.
    //
    // **Which hits those are is smaller than it was.** WORKSTREAM T removed the
    // car from the list: a bat, a footy, a fall, a respawn, pressing E and a
    // disconnect all still clear `drivingCar` and this sweep still leaves the
    // car standing where the body was, but a *car* no longer does -- see
    // `traffic.canBeRunDown`. This case is about what `follow` does once the
    // field is clear and is unchanged by that; the case that *did* encode the
    // old behaviour was in `server/sim.ts`, where the driven-car sweep threw a
    // rival driver out of their own car, and it is gated now.
    driver.drivingCar = 0;
    const changed = field.follow([driver]);
    if (changed.length !== 1 || changed[0].id !== car.id) {
      failures.push(`Throwing a driver out reported ${changed.length} changed cars, not 1.`);
    }
    if (car.driverId !== 0) failures.push('A knocked-out driver is still in their car.');
    if (car.x !== 30) failures.push('A car left by a knockout did not stay where the driver was.');
    if (car.speed !== 0) failures.push(`An empty car is still doing ${car.speed} m/s.`);
    // And it is still suppressed, because it is still standing in the street.
    if (!field.suppressed(11)) failures.push('A car left in the street stopped suppressing its ambient copy.');
    // A driver who simply vanished -- a disconnect -- leaves it too.
    field.take({ identity: 13, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 6);
    field.follow([]);
    if (field.carOf(6) !== 0) failures.push('A disconnected driver kept their car forever.');
  }

  // --- **Cars do not expire.** The check that used to prove the five-minute
  //     clock worked now proves it is gone: an empty car left in the street for
  //     an hour is still there, still suppressing its ambient copy, and still
  //     the car you parked. See section 6.
  {
    const field = new CarField();
    const car = field.take({ identity: 21, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    field.age(3_600_000);
    if (field.get(car.id) === undefined) {
      failures.push('An empty car vanished after an hour. Cars do not despawn any more; they are recycled.');
    }
    if (!field.suppressed(21)) failures.push('A car standing in the street stopped suppressing its ambient copy.');
    if (car.emptyMs !== 3_600_000) failures.push(`The empty clock read ${car.emptyMs} after an hour; it is the recycling tie-break now.`);
    // And an occupied one never ages at all, because `emptyMs` means "empty".
    const driven = field.take({ identity: 22, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 3)!;
    field.age(60_000);
    if (driven.emptyMs !== 0) failures.push(`A car with a driver in it aged its empty clock to ${driven.emptyMs}.`);
  }

  // --- The damage curve. The brief's three worked examples, and the shape
  //     between them: continuous at the free allowance, linear, capped.
  {
    if (crashDamage(CRASH_FREE_SPEED) !== 0) {
      failures.push(`A ${CRASH_FREE_SPEED} m/s bump cost ${crashDamage(CRASH_FREE_SPEED)} hp; that speed is free.`);
    }
    if (crashDamage(0) !== 0 || crashDamage(-9) !== 0) failures.push('A stationary or reversing car took crash damage.');
    // --- WORKSTREAM AP: **the second retune's headline numbers**, and the whole
    //     of *"cars should last 20-50 times longer in my hands"*.
    //
    // Three points on the curve, each re-derived here rather than copied, and
    // each stated as the owner would state it:
    //
    //   - a **15 m/s impact is free**. It used to be 32 hp. `(15 - 12) x 0.4`
    //     would be 1.2, so this one is *not* free as an impact -- but 15 m/s of
    //     impact is 22.7 m/s of driving, and what is free is the thing a player
    //     does: `NOSE_SHED` puts a 15 m/s *drive* into a wall at 9.9 m/s of
    //     delta-v, under the 12 m/s allowance, and it costs nothing at all.
    //   - a **flat-out square wall costs 6.816 hp**, which is the number the
    //     brief asked for in the range 5-8 and is fifteen runs to a write-off.
    //   - the **cap is only reachable by two cars closing on each other**.
    if (Math.abs(crashDamage(15) - 1.2) > 1e-9) {
      failures.push(`A square 15 m/s impact cost ${crashDamage(15)} hp, not 1.2. The retune has drifted.`);
    }
    if (crashDamage(15 * NOSE_SHED) !== 0) {
      failures.push(
        `Driving into a wall at 15 m/s cost ${crashDamage(15 * NOSE_SHED)} hp. The nose probe reports ` +
          `${NOSE_SHED.toFixed(2)} of the road speed, so 15 m/s is ${(15 * NOSE_SHED).toFixed(1)} m/s of delta-v ` +
          `and the ${CRASH_FREE_SPEED} m/s allowance swallows it whole. A suburban crash is free now.`,
      );
    }
    // The owner's own number, stated as arithmetic so it cannot drift silently:
    // `(44 x 0.66 - 12) x 0.4`.
    {
      const flatOut = crashDamage(DRIVE_TOP_SPEED * NOSE_SHED);
      if (!(flatOut >= 5 && flatOut <= 8)) {
        failures.push(
          `A ${DRIVE_TOP_SPEED} m/s square wall costs ${flatOut.toFixed(2)} hp of ${CAR_HEALTH_MAX}. The brief's ` +
            `range is 5 to 8 -- low enough that a careless driver never writes a car off, high enough that ` +
            `${Math.ceil(CAR_HEALTH_MAX / flatOut)} deliberate runs at a wall still does.`,
        );
      }
      if (Math.abs(flatOut - 6.816) > 1e-9) {
        failures.push(`The flat-out wall is ${flatOut} hp and the header says 6.816. One of the three constants moved.`);
      }
      // ...and the free allowance is where it was put: 18.2 m/s of road speed.
      const freeRoad = CRASH_FREE_SPEED / NOSE_SHED;
      if (crashDamage((freeRoad - 0.5) * NOSE_SHED) !== 0 || !(crashDamage((freeRoad + 0.5) * NOSE_SHED) > 0)) {
        failures.push(
          `The free/paid boundary is not at ${freeRoad.toFixed(1)} m/s of road speed, which is where ` +
            `CRASH_FREE_SPEED / NOSE_SHED puts it and what the constant's header promises.`,
        );
      }
    }
    // Continuous at the boundary: no step, so a kerb at 5.01 m/s is not a dent.
    if (crashDamage(CRASH_FREE_SPEED + 0.01) > 0.1) {
      failures.push(`The damage curve has a step at the free allowance; a ${CRASH_FREE_SPEED + 0.01} m/s kerb was a real hit.`);
    }
    // And capped, so no single impact is a twelfth of a car. See
    // `CRASH_DAMAGE_MAX`, whose job changed with the retune: a *wall* no longer
    // reaches it at any speed, and what does is two cars closing head on --
    // `closingAlong` adds both speeds, so the worst two players can do to each
    // other is 88 m/s and this is what it costs.
    if (crashDamage(DRIVE_TOP_SPEED * 2) !== CRASH_DAMAGE_MAX) {
      failures.push(
        `A head-on between two cars at ${DRIVE_TOP_SPEED} m/s cost ${crashDamage(DRIVE_TOP_SPEED * 2)} hp; ` +
          `the cap is ${CRASH_DAMAGE_MAX}.`,
      );
    }
    if (!(crashDamage(DRIVE_TOP_SPEED * NOSE_SHED) < CRASH_DAMAGE_MAX)) {
      failures.push(
        `A flat-out wall saturates the ${CRASH_DAMAGE_MAX} hp cap. It is meant to land just under it, so the ` +
          `curve is honest all the way to the top speed and the cap only catches car against car. See CRASH_DAMAGE_MAX.`,
      );
    }
    if (!(CAR_HEALTH_MAX - CRASH_DAMAGE_MAX > CAR_SMOKING_HEALTH)) {
      failures.push(
        `One maximum crash leaves a healthy car on ${CAR_HEALTH_MAX - CRASH_DAMAGE_MAX} against a smoke ` +
          `threshold of ${CAR_SMOKING_HEALTH}. The worst single impact in the game must leave the car above ` +
          `it: the first heavy crash is a warning, not a change of handling. This assertion used to demand ` +
          `the two be *equal* and the retune deliberately broke that tidiness -- see CRASH_DAMAGE_MAX.`,
      );
    }
    // --- The glancing-blow rule. See `GLANCING_FLOOR`.
    //
    // A pure scrape is `GLANCING_FLOOR` of the square cost, and the rule is
    // unchanged by the retune -- it multiplies whatever the curve produced.
    //
    // Two speeds, because they exercise the two halves of the curve. Fifteen is
    // under the cap and shows the linear part: 1.2 square, 0.42 scraped.
    // Eighty-eight -- a head-on between two cars at the top speed -- is *past*
    // it, and shows that the factor is applied to the *clamped* damage, so even
    // a saturating impact is discounted for being sideways.
    const square15 = crashDamage(15);
    const scrape15 = crashDamage(15, GLANCING_FLOOR);
    if (Math.abs(scrape15 - 1.2 * GLANCING_FLOOR) > 1e-9) {
      failures.push(`A 15 m/s scrape cost ${scrape15} hp against the ${(1.2 * GLANCING_FLOOR).toFixed(3)} the floor implies.`);
    }
    const square88 = crashDamage(88);
    const scrape88 = crashDamage(88, GLANCING_FLOOR);
    if (square88 !== CRASH_DAMAGE_MAX) failures.push(`A square 88 m/s hit cost ${square88} hp; it is past the ${CRASH_DAMAGE_MAX} cap.`);
    if (Math.abs(scrape88 - CRASH_DAMAGE_MAX * GLANCING_FLOOR) > 1e-9) {
      failures.push(
        `An 88 m/s scrape cost ${scrape88} hp against the ${(CRASH_DAMAGE_MAX * GLANCING_FLOOR).toFixed(2)} the ` +
          'floor implies. The glancing factor multiplies the *clamped* damage; see GLANCING_FLOOR.',
      );
    }
    if (!(scrape88 < square88 && scrape15 < square15)) failures.push('A scrape cost as much as a square hit.');
    // The default is the identity, which is what makes every call site that has
    // no contact normal -- car against car, the timetable, a pedestrian -- mean
    // exactly what it meant before the rule existed.
    if (crashDamage(15, 1) !== crashDamage(15)) failures.push('crashDamage(dv, 1) is not the same as crashDamage(dv).');
    // The floor holds against a head-on-ness of zero and against a cosine that
    // arrived as a NaN, which is the failure that would make every crash in the
    // game free with nothing on screen to say so.
    if (crashDamage(88, 0) !== scrape88) failures.push('A perfectly sideways impact was free; the floor is not holding.');
    if (crashDamage(88, -1) !== scrape88) failures.push('A negative head-on-ness escaped the floor.');
    if (crashDamage(88, NaN) !== scrape88) failures.push('A NaN head-on-ness multiplied the whole crash by NaN.');
    if (crashDamage(88, 9) !== square88) failures.push('A head-on-ness over 1 made a crash worse than square.');
    if (!(GLANCING_FLOOR > 0 && GLANCING_FLOOR < 1)) {
      failures.push(`GLANCING_FLOOR is ${GLANCING_FLOOR}; at 0 a wall you are parallel to is free and at 1 the rule does nothing.`);
    }
    // Monotone in the delta-v, which is the property a player actually learns,
    // and monotone in the head-on-ness too -- a hit that got *cheaper* the
    // squarer it was would be unexplainable from inside the game.
    let last = -1;
    for (let dv = 0; dv <= 100; dv += 0.5) {
      const d = crashDamage(dv);
      if (d < last) failures.push(`crashDamage fell from ${last} to ${d} at ${dv} m/s; harder must never be cheaper.`);
      last = d;
    }
    let lastSquare = -1;
    for (let k = 0; k <= 1.0001; k += 0.02) {
      const d = crashDamage(88, k);
      if (d < lastSquare - 1e-9) failures.push(`A 20 m/s hit got cheaper as it got squarer, at |cos| ${k.toFixed(2)}.`);
      lastSquare = d;
    }
    // The fraction the renderers use runs the other way and hits both ends.
    if (damageFraction(CAR_HEALTH_MAX) !== 0) failures.push('An undamaged car has a non-zero damage fraction.');
    if (damageFraction(0) !== 1) failures.push('A written-off car has a damage fraction below 1.');
    if (Math.abs(damageFraction(50) - 0.5) > 1e-9) failures.push('damageFraction(50) is not a half.');
  }

  // --- The cooldown, which is the whole of why scraping a wall is not fatal.
  {
    const field = new CarField();
    const car = field.take({ identity: 31, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 1)!;
    if (car.health !== CAR_HEALTH_MAX) failures.push(`A freshly taken car started on ${car.health} hp.`);
    if (field.damage(car.id, 18) === null) failures.push('The first hit on a fresh car was refused.');
    if (car.health !== CAR_HEALTH_MAX - 18) failures.push(`An 18 hp hit left the car on ${car.health}.`);
    // Sixty ticks of grinding along the same wall inside the cooldown, which is
    // the failure this constant exists for: without it a scrape is 60 hits a
    // second and a car is written off in about a second of leaning on a fence.
    for (let i = 0; i < 29; i++) {
      field.damage(car.id, 18);
      field.age(1000 / 60);
    }
    if (car.health !== CAR_HEALTH_MAX - 18) {
      failures.push(
        `Half a second of scraping took the car from ${CAR_HEALTH_MAX - 18} to ${car.health}. ` +
          `The ${CRASH_COOLDOWN_MS} ms cooldown is not holding.`,
      );
    }
    // ...and it lets go on time.
    field.age(CRASH_COOLDOWN_MS);
    if (field.damage(car.id, 10) === null) failures.push('The cooldown never expired.');
    if (car.health !== CAR_HEALTH_MAX - 28) failures.push(`After the cooldown the car is on ${car.health}, not ${CAR_HEALTH_MAX - 28}.`);
    // Written off is a floor, not a wrap.
    field.age(CRASH_COOLDOWN_MS);
    field.damage(car.id, 1000);
    if (car.health !== 0) failures.push(`A 1,000 hp hit left the car on ${car.health}; the floor is 0.`);
    if (!carIsWrittenOff(car.health)) failures.push('A car on 0 hp is not a write-off.');
    // And a wreck cannot be damaged again, which is what stops a record being
    // broadcast on every tick a player rams a burnt-out shell.
    field.age(CRASH_COOLDOWN_MS);
    if (field.damage(car.id, 5) !== null) failures.push('A written-off car took further damage.');
    // The three bands are ordered and the predicates agree with them.
    if (!(CAR_SMOKING_HEALTH < CAR_DENTED_HEALTH && CAR_DENTED_HEALTH < CAR_HEALTH_MAX)) {
      failures.push('The damage bands are not ordered: smoke must be worse than dents.');
    }
    if (carIsDented(CAR_HEALTH_MAX) || carIsSmoking(CAR_HEALTH_MAX) || carIsWrittenOff(CAR_HEALTH_MAX)) {
      failures.push('A car nobody has crashed reported as damaged.');
    }
    if (!carIsDented(CAR_DENTED_HEALTH) || carIsSmoking(CAR_DENTED_HEALTH)) {
      failures.push(`A car on exactly ${CAR_DENTED_HEALTH} hp is dented and not yet smoking.`);
    }
    if (!carIsSmoking(CAR_SMOKING_HEALTH) || !carIsDented(CAR_SMOKING_HEALTH)) {
      failures.push(`A car on exactly ${CAR_SMOKING_HEALTH} hp smokes, and a smoking car is also dented.`);
    }
  }

  // --- A damaged car is slower, and a written-off one does not go at all.
  {
    const dt = 1 / 60;
    const top = (health: number): number => {
      const c: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: health };
      for (let i = 0; i < 1200; i++) stepCarSpeed(c, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
      return c.carSpeed;
    };
    const well = top(CAR_HEALTH_MAX);
    const hurt = top(CAR_SMOKING_HEALTH - 1);
    if (Math.abs(well - DRIVE_TOP_SPEED) > 1e-6) failures.push(`A healthy car topped out at ${well.toFixed(2)}.`);
    if (Math.abs(hurt - DRIVE_TOP_SPEED * CAR_SMOKING_SCALE) > 1e-6) {
      failures.push(`A smoking car topped out at ${hurt.toFixed(2)}, not ${(DRIVE_TOP_SPEED * CAR_SMOKING_SCALE).toFixed(2)}.`);
    }
    // A dented but not smoking car is untouched -- the dents are cosmetic until
    // the smoke starts, which is the whole of what the two bands mean.
    if (Math.abs(top(CAR_DENTED_HEALTH) - DRIVE_TOP_SPEED) > 1e-6) {
      failures.push('A dented car lost top speed. Dents are paint; the smoke is the engine.');
    }
    // The write-off. Twenty seconds of throttle from a standstill and it has not
    // moved, forwards or backwards.
    const dead: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: 0 };
    for (let i = 0; i < 1200; i++) stepCarSpeed(dead, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
    if (dead.carSpeed !== 0) failures.push(`A written-off car reached ${dead.carSpeed} m/s under throttle.`);
    for (let i = 0; i < 1200; i++) stepCarSpeed(dead, { forward: -1, jump: false }, dt, 0, 0, 0, 0, null);
    if (dead.carSpeed !== 0) failures.push(`A written-off car reversed at ${dead.carSpeed} m/s.`);
    // ...but it still rolls to a stop rather than stopping dead, and the brake
    // still works, which is what makes it steerable off the road.
    const rolling: DriveState = { drivingCar: 1, carSpeed: 10, carHealth: 0 };
    stepCarSpeed(rolling, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
    if (!(rolling.carSpeed < 10 && rolling.carSpeed > 9)) {
      failures.push(`A written-off car doing 10 m/s went to ${rolling.carSpeed}; it should coast, not stop dead.`);
    }
    // The handbrake still bites on a wreck. Space is the one control that has to
    // keep working when the engine does not, or a write-off at 20 m/s is a car
    // you can neither drive nor stop.
    const braking: DriveState = { drivingCar: 1, carSpeed: 10, carHealth: 0 };
    stepCarSpeed(braking, { forward: 0, jump: true }, dt, 0, 0, 0, 0, null);
    if (!(10 - braking.carSpeed > DRIVE_COAST * dt * 2)) {
      failures.push(`The handbrake on a written-off car shed ${(10 - braking.carSpeed).toFixed(3)} m/s; it is not biting.`);
    }

    // --- **And the acceleration**, not only the top speed. The brief asks for
    //     both, and a car that still leapt off the line and merely stopped at
    //     13 m/s would feel fine until you tried to overtake -- which is a speed
    //     limiter, not a broken engine.
    const rampTicks = (health: number): number => {
      const c: DriveState = { drivingCar: 1, carSpeed: 0, carHealth: health };
      let n = 0;
      while (c.carSpeed < 10 && n < 3600) {
        stepCarSpeed(c, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
        n++;
      }
      return n;
    };
    const wellTicks = rampTicks(CAR_HEALTH_MAX);
    const hurtTicks = rampTicks(CAR_SMOKING_HEALTH - 1);
    // 0 to 10 m/s at 6 m/s^2 is 1.67 s; at 0.6 of that it is 2.78 s. The ratio
    // is the constant, so this survives a change to either number.
    const wantRatio = 1 / CAR_SMOKING_SCALE;
    if (Math.abs(hurtTicks / wellTicks - wantRatio) > 0.05) {
      failures.push(
        `A smoking car took ${hurtTicks} ticks to reach 10 m/s against a healthy car's ${wellTicks} -- a ratio ` +
          `of ${(hurtTicks / wellTicks).toFixed(2)} against the ${wantRatio.toFixed(2)} CAR_SMOKING_SCALE ` +
          `promises. The damage is on the top speed only, which is a speed limiter rather than a bad engine.`,
      );
    }

    // --- **You can still get out of a write-off.** The brief's own clause, and
    //     the failure is a player sealed inside a dead car forever. Getting out
    //     is `CarField.follow` seeing a driver who has stopped driving, and it
    //     must not care what condition the car is in.
    const field = new CarField();
    const wreck = field.take({ identity: 77, body: 0, colour: 0, x: 5, y: 0, z: -5, yaw: 0.4, parked: false }, 3)!;
    field.damage(wreck.id, CAR_HEALTH_MAX);
    if (wreck.health !== 0) failures.push(`The write-off check could not write the car off; it is on ${wreck.health}.`);
    const out = field.follow([{ id: 3, drivingCar: 0, carSpeed: 0, x: 5, feetY: 0, z: -5, yaw: 0.4 }]);
    if (out.length !== 1 || wreck.driverId !== 0) {
      failures.push('A driver could not get out of a written-off car. A dead engine is not a locked door.');
    }
    if (wreck.health !== 0) failures.push('Getting out of a wreck repaired it.');
    // ...and it is still there, still suppressing its ambient copy, still an
    // obstacle. That is the brief's "it stays as an obstacle" in one line.
    if (field.get(wreck.id) === undefined) failures.push('A written-off car vanished when its driver got out.');
    if (!field.suppressed(77)) failures.push('A written-off car stopped suppressing its ambient copy.');
  }

  // --- The bay snap: a car left beside a kerb bay is a *parked* car.
  //
  // The rule, here; the geometry of finding a bay needs a real lane sidecar and
  // is asserted in `verifyTraffic`. `sim.parkOnLeave` and the offline sweep in
  // `main.ts` both run this exact pair.
  {
    const bay: BayTarget = { x: 100, y: 3, z: -50, dx: 1, dz: 0 };
    const left: ParkableCar = { x: 98.2, y: 3.1, z: -51.5, yaw: 2.9, speed: 1.4, driverId: 0 };
    if (!snapToBay(left, bay)) failures.push('A car left beside a bay was not snapped into it.');
    if (left.x !== 100 || left.y !== 3 || left.z !== -50) {
      failures.push(`A snapped car is at (${left.x}, ${left.y}, ${left.z}), not in the bay.`);
    }
    if (left.speed !== 0) failures.push(`A parked car is doing ${left.speed} m/s.`);
    // The heading points down the street, which is the entire visual difference
    // between "parked" and "abandoned at an angle". `dx = 1` is due east, and
    // yaw 0 faces -Z, so east is -PI/2.
    if (Math.abs(left.yaw - -Math.PI / 2) > 1e-9) {
      failures.push(`A car parked in an east-facing bay has yaw ${left.yaw}, not ${-Math.PI / 2}.`);
    }
    // No bay within reach: the car stays exactly where it was left, in the lane,
    // and the traffic queues behind it. The two halves of the feature have to
    // disagree cleanly.
    const stranded: ParkableCar = { x: 7, y: 1, z: 3, yaw: 1.1, speed: 0, driverId: 0 };
    if (snapToBay(stranded, null)) failures.push('A car with no bay near it was snapped somewhere.');
    if (stranded.x !== 7 || stranded.z !== 3 || stranded.yaw !== 1.1) {
      failures.push('A car left in the middle of the road was moved. It must stay exactly where it was left.');
    }
    // And never a car with somebody in it, which would teleport a driver into
    // the gutter mid-corner.
    const driven: ParkableCar = { x: 7, y: 1, z: 3, yaw: 1.1, speed: 14, driverId: 9 };
    if (snapToBay(driven, bay)) failures.push('A car with a driver in it was parked out from under them.');
    if (driven.x !== 7 || driven.speed !== 14) failures.push('An occupied car was moved by the bay snap.');
    if (!(PARK_SNAP_RADIUS > 0 && PARK_SNAP_RADIUS < 10)) {
      failures.push(`PARK_SNAP_RADIUS is ${PARK_SNAP_RADIUS} m, which is not "the car stopped beside a bay".`);
    }
  }

  // --- The clamp detector: the half of the crash the nose probe cannot see.
  {
    const dt = 1 / 60;
    // A car doing 20 m/s that covered the distance it should have is fine, and
    // this is the case that has to be *silent* -- a false positive here charges
    // damage for driving down a hill.
    const clear: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(clear, 20 * dt, 0, dt, true) !== 0) failures.push('An unobstructed car was charged for a crash.');
    if (clear.carSpeed !== 20) failures.push('An unobstructed car was slowed by the clamp detector.');
    // Three per cent short is a slope, or friction, or the controller ramping.
    const slope: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(slope, 20 * dt * 0.97, 0, dt, true) !== 0) {
      failures.push('A car that covered 97 % of its step was charged for a crash. That is a slope.');
    }
    // Dead stop against a prism: the whole speed is the impulse.
    const wall: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    const dv = crashFromClamp(wall, 0, 0, dt, true);
    if (Math.abs(dv - 20 * (1 - CLAMP_SLIP)) > 1e-6) {
      failures.push(`A car stopped dead at 20 m/s reported ${dv.toFixed(2)} m/s of delta-v.`);
    }
    if (!(wall.carSpeed < 4)) {
      failures.push(
        `A car stopped dead by a prism kept ${wall.carSpeed.toFixed(2)} m/s. The detector has to *take* the ` +
          `speed as well as report it, or the next tick asks the controller for 20 m/s into the same wall.`,
      );
    }
    // --- WORKSTREAM AP: **and the same dead stop with nothing solid in it is
    //     free, and the car keeps its speed.**
    //
    // The gate, and the case it exists for is the wading undo: `combat.advance`
    // puts a body that tried to enter deep water straight back where it started,
    // which this function saw as `moved = 0` at 20 m/s and billed as the hardest
    // crash it can measure. Water is not a wall. Neither is a wave, a carriage
    // floor, or anything else that moves a body for a reason of its own.
    const shoved: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(shoved, 0, 0, dt, false) !== 0) {
      failures.push('A car that went nowhere with nothing solid in the way was charged for a crash. See the hitSolid gate.');
    }
    if (shoved.carSpeed !== 20) {
      failures.push(`A car stopped by something that is not a solid lost ${20 - shoved.carSpeed} m/s. The gate returns before the bleed.`);
    }
    // Nobody on foot, and nothing at all below the free speed.
    const walker: DriveState = { drivingCar: 0, carSpeed: 8, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(walker, 0, 0, dt, true) !== 0) failures.push('Somebody on foot crashed a car.');
    const crawl: DriveState = { drivingCar: 1, carSpeed: CRASH_FREE_SPEED, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(crawl, 0, 0, dt, true) !== 0) failures.push('A car nudging a kerb at the free speed was charged.');
  }

  // --- WORKSTREAM AP: **the bump.** A car driving over a 0.4 m step at 20 m/s
  //     takes no damage, and does not even slow down.
  //
  // The owner's sentence, as a test: *"even small bumps in a road alone are
  // giving damage"*. The fixture is not a mock of a wall; it is a mock of
  // `CollisionWorld.solidFor`'s **first clause**, which is the line the bug was
  // hiding behind:
  //
  //     if (feetY >= prism.top - 0.05) return false;
  //
  // A 0.4 m kerb is solid to a query whose feet are on the road and not solid to
  // one that has lifted them by `NOSE_STEP`. `controller.step` lifts them, which
  // is why the *body* drives over the kerb without noticing; before this
  // workstream the nose probe did not, which is why the *car* took a full crash
  // for the same kerb. Both halves are asserted, because a fixture that only
  // proved the new behaviour would pass just as happily against a probe that had
  // stopped querying at all.
  {
    const dt = 1 / 60;
    const KERB_TOP = 0.4;
    /** Every query is answered exactly as `CollisionWorld` would answer it. */
    const kerb = (): DrivingWorld => ({
      collision: {
        resolve: (fx, fz, tx, tz, _r, feetY) =>
          feetY >= KERB_TOP - 0.05
            ? { x: tx, z: tz, hit: false }
            : { x: fx, z: fz, hit: true },
      },
    });
    const over: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    const lost = stepCarSpeed(over, { forward: 1, jump: false }, dt, 0, 0, 0, 0, kerb());
    if (lost !== 0) {
      failures.push(
        `A car crossing a ${KERB_TOP} m kerb at 20 m/s reported ${lost.toFixed(2)} m/s of delta-v, which ` +
          `crashDamage turns into ${crashDamage(lost).toFixed(2)} hp. A bump the body steps over is free. ` +
          `See NOSE_STEP.`,
      );
    }
    if (crashDamage(lost) !== 0) failures.push(`A ${KERB_TOP} m bump at 20 m/s cost ${crashDamage(lost)} hp; it costs nothing.`);
    if (over.carSpeed <= 20) {
      failures.push(`A car crossing a ${KERB_TOP} m kerb at 20 m/s came out at ${over.carSpeed.toFixed(2)} m/s. It should be accelerating.`);
    }
    // ...and a kerb taller than the step still stops the car, so this is a
    // probe that got the height right rather than a probe that stopped asking.
    const tall = (): DrivingWorld => ({
      collision: {
        resolve: (fx, fz, tx, tz, _r, feetY) =>
          feetY >= 2 - 0.05 ? { x: tx, z: tz, hit: false } : { x: fx, z: fz, hit: true },
      },
    });
    const into: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (!(stepCarSpeed(into, { forward: 1, jump: false }, dt, 0, 0, 0, 0, tall()) > 0)) {
      failures.push('A 2 m wall let a car through. The nose probe is lifting its feet over everything, not over kerbs.');
    }
    // And the head, which is the other argument the fix added: a soffit high
    // enough for the driver's own capsule is not a crash for the bonnet either.
    // `solidFor`'s third clause -- `headY <= prism.base` -- for a deck whose
    // underside is at 2.6 m, which is `decks.WALK_UNDER_M`.
    const soffit = (): DrivingWorld => ({
      collision: {
        resolve: (fx, fz, tx, tz, _r, feetY, headY) =>
          (headY ?? feetY + NOSE_HEAD) <= 2.6 ? { x: tx, z: tz, hit: false } : { x: fx, z: fz, hit: true },
      },
    });
    const under: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (stepCarSpeed(under, { forward: 1, jump: false }, dt, 0, 0, 0, 0, soffit()) !== 0) {
      failures.push('Driving under a 2.6 m soffit was a crash. The probe is asking for more headroom than the body needs.');
    }
  }

  // --- Car against car: overlap plus closing speed, and neither on its own.
  {
    const box = { halfLength: 2.3 };
    // Head-on at 20 and 0: the mover crashes.
    //
    // **Twenty, and it has now been 3, then 5, then 8**, which is a fixture
    // chasing a constant and is worth one line so the next person does not chase
    // it again. `closingAlong` refuses anything at or under `CRASH_FREE_SPEED`,
    // so any fixture at or near the allowance measures the *threshold* rather
    // than the geometry it was written for. WORKSTREAM AP took the allowance to
    // 12; twenty is clear of it and is a rear-ender nobody would call a nudge.
    // The gentle-touch case at the bottom of this block is the one that is
    // *supposed* to sit on the constant, and it reads it by name.
    const still = { x: 0, z: -4, yaw: 0, speed: 0, ...box };
    const into = { x: 0, z: 0, yaw: Math.PI, speed: 20, ...box };
    // yaw = PI faces +Z; the parked car is at -4, so this is driving *away*.
    if (carCrashClosing(into, still) !== 0) failures.push('A car driving away from another one crashed into it.');
    const at = { x: 0, z: 0, yaw: 0, speed: 20, ...box };
    const ahead = { x: 0, z: -4, yaw: 0, speed: 0, ...box };
    const closing = carCrashClosing(at, ahead);
    if (Math.abs(closing - 20) > 1e-6) failures.push(`A 20 m/s rear-ender reported ${closing.toFixed(2)} m/s of closing.`);
    // ...and the same rear-ender under the allowance is nothing at all, which is
    // the owner's *"make the threshold much higher"* arriving in the car-on-car
    // path as well as in the wall one. Bumping the car in front is free now.
    const nudge = { x: 0, z: 0, yaw: 0, speed: CRASH_FREE_SPEED - 1, ...box };
    if (carCrashClosing(nudge, ahead) !== 0) {
      failures.push(`A ${CRASH_FREE_SPEED - 1} m/s rear-ender was a crash; everything under ${CRASH_FREE_SPEED} is free.`);
    }
    // Far apart is nothing, whatever the speed.
    const far = { x: 0, z: -40, yaw: 0, speed: 0, ...box };
    if (carCrashClosing(at, far) !== 0) failures.push('Two cars forty metres apart crashed.');
    // Nose to tail in convoy at the same speed is not a crash, which is the case
    // a plain overlap test gets wrong and is why this measures closing.
    const lead = { x: 0, z: -4, yaw: 0, speed: 30, ...box };
    const follow = { x: 0, z: 0, yaw: 0, speed: 30, ...box };
    if (carCrashClosing(follow, lead) !== 0) failures.push('Two cars in convoy at one speed crashed into each other.');
    // And a gentle touch is inside the free allowance.
    const gentle = { x: 0, z: 0, yaw: 0, speed: CRASH_FREE_SPEED, ...box };
    if (carCrashClosing(gentle, ahead) !== 0) failures.push('Parking against another car at the free speed was a crash.');
  }

  // --- Car against the **ambient fleet**. WORKSTREAM T, and the whole point of
  //     it is that this is the *same* rule in the other party's coordinates: an
  //     ambient car has a unit heading rather than a yaw, so the two wrappers
  //     have to agree number for number or the crash a driver feels depends on
  //     which fleet they hit.
  {
    const box = { halfLength: 2.3 };
    // The same rear-ender as the block above, stated both ways. `yaw` 0 faces
    // -Z, so its heading is (0, -1) and this is the identity `closingAlong` is
    // factored out to make checkable.
    const yawForm = carCrashClosing(
      { x: 0, z: 0, yaw: 0, speed: 20, ...box },
      { x: 0, z: -4, yaw: 0, speed: 0, ...box },
    );
    const headingForm = ambientCrashClosing(
      { x: 0, z: 0, dx: 0, dz: -1, speed: 20, ...box },
      { x: 0, z: -4, dx: 0, dz: -1, speed: 0, ...box },
    );
    if (Math.abs(yawForm - headingForm) > 1e-9) {
      failures.push(
        `The same crash scored ${yawForm.toFixed(4)} from two yaws and ${headingForm.toFixed(4)} from two ` +
          'headings. `carCrashClosing` and `ambientCrashClosing` must be one function in two coordinates.',
      );
    }

    // A stationary driven car with a bus arriving at 20 m/s. This is the case
    // the owner reported -- it used to end with the driver on the tarmac -- and
    // it is *symmetric*: the closing speed does not care which of the two was
    // doing the moving, which is what makes "a crash" one number rather than a
    // rule about fault. (Twenty rather than the twelve it was written with, on
    // the rear-ender's reason two blocks up: twelve is the free allowance now.)
    const parked = { x: 0, z: 0, dx: 0, dz: -1, speed: 0, ...box };
    const arriving = { x: 0, z: -4, dx: 0, dz: 1, speed: 20, ...box };
    const rammed = ambientCrashClosing(parked, arriving);
    if (Math.abs(rammed - 20) > 1e-6) {
      failures.push(`A bus arriving at 20 m/s into a stopped car reported ${rammed.toFixed(2)} m/s of closing.`);
    }
    // ...and it is the same number seen from the bus.
    const fromTheBus = ambientCrashClosing(arriving, parked);
    if (Math.abs(fromTheBus - rammed) > 1e-9) {
      failures.push(`One crash scored ${rammed.toFixed(4)} from one car and ${fromTheBus.toFixed(4)} from the other.`);
    }

    // Reversing into the car behind you is a crash, which is the clause
    // `crashIntoTraffic` puts the signed speed back for. `drivenCarPose`
    // publishes an unsigned speed and a magnitude here would score this as
    // driving *away* at 5 m/s, which is nothing.
    const backing = { x: 0, z: 0, dx: 0, dz: -1, speed: -20, ...box };
    const behind = { x: 0, z: 4, dx: 0, dz: -1, speed: 0, ...box };
    const reversed = ambientCrashClosing(backing, behind);
    if (Math.abs(reversed - 20) > 1e-6) {
      failures.push(`Reversing at 20 m/s into the car behind reported ${reversed.toFixed(2)} m/s; a crash keeps its sign.`);
    }

    // Overtaking a car doing the same speed in the next lane is not a crash,
    // however close it is. `carCrashClosing`'s convoy case, laterally.
    const alongside = ambientCrashClosing(
      { x: 0, z: 0, dx: 0, dz: -1, speed: 20, ...box },
      { x: 3, z: -1, dx: 0, dz: -1, speed: 20, ...box },
    );
    if (alongside !== 0) failures.push(`Two cars abreast at one speed crashed at ${alongside.toFixed(2)} m/s.`);

    // The broadphase radius has to be wider than the widest pair the body table
    // can produce, or a van into a van is a crash the query never finds. See
    // `CRASH_QUERY_RADIUS`, whose derivation this is.
    let widest = 0;
    for (const size of CAR_BODY_SIZE) if (size.length > widest) widest = size.length;
    // The driven side at `drivenCarPose`'s scale of 1, the ambient side at
    // `poseCar`'s 1.04 jitter ceiling plus its hit margin (0.1).
    const reach = widest * 0.5 + (widest * 0.5 * 1.04 + 0.1);
    if (CRASH_QUERY_RADIUS < reach) {
      failures.push(
        `CRASH_QUERY_RADIUS is ${CRASH_QUERY_RADIUS} m and two vans can touch at ${reach.toFixed(2)} m. ` +
          'The broadphase would miss the biggest crash in the game.',
      );
    }
  }

  // --- The budget, and the rule for what gives. Section 6.
  {
    const field = new CarField();
    // A hundred cars in a line, 100 m apart, so the farthest is unambiguous.
    for (let i = 0; i < 100; i++) {
      field.take({ identity: 1000 + i, body: 0, colour: 0, x: i * 100, y: 0, z: 0, yaw: 0, parked: true }, 0);
    }
    // Somebody standing at the origin. The recycling has to take the far end.
    const players = [0, 0];
    const taken = field.recycleFarthest(players);
    if (taken === 0) failures.push('Nothing was recycled from a hundred cars with one player at one end.');
    const gone = field.get(taken);
    if (gone !== undefined) failures.push('The recycled record is still in the field.');
    if (field.size !== 99) failures.push(`Recycling one car left ${field.size} of 100.`);
    // ...and it was the farthest one, id 100, at 9,900 m.
    if (field.suppressed(1099)) failures.push('The car recycled was not the one farthest from everybody.');
    if (!field.suppressed(1000)) failures.push('The car nearest the player was recycled.');

    // **Nothing within the keep radius, ever.** This is the clause the brief
    // names and the one whose failure is a car vanishing out of a windscreen.
    const close = new CarField();
    for (let i = 0; i < 5; i++) {
      close.take({ identity: 2000 + i, body: 0, colour: 0, x: i * 10, y: 0, z: 0, yaw: 0, parked: true }, 0);
    }
    if (close.recycleFarthest([0, 0]) !== 0) {
      failures.push(`A car inside the ${RECYCLE_KEEP_RADIUS} m keep radius was recycled.`);
    }
    // One step past the radius and it goes.
    close.take({ identity: 2099, body: 0, colour: 0, x: RECYCLE_KEEP_RADIUS + 1, y: 0, z: 0, yaw: 0, parked: true }, 0);
    if (close.recycleFarthest([0, 0]) === 0) {
      failures.push(`A car just past the ${RECYCLE_KEEP_RADIUS} m keep radius was spared.`);
    }

    // **Never an occupied one**, whatever the distance.
    const busy = new CarField();
    busy.take({ identity: 3000, body: 0, colour: 0, x: 100000, y: 0, z: 0, yaw: 0, parked: true }, 7);
    if (busy.recycleFarthest([0, 0]) !== 0) failures.push('A car with a driver in it was recycled out from under them.');

    // Age breaks the tie, and the id breaks that.
    const tied = new CarField();
    const older = tied.take({ identity: 4000, body: 0, colour: 0, x: 5000, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    const newer = tied.take({ identity: 4001, body: 0, colour: 0, x: 5000, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    older.emptyMs = 60_000;
    newer.emptyMs = 1_000;
    if (tied.recycleFarthest([0, 0]) !== older.id) {
      failures.push('Two cars at the same distance: the one that has stood empty longest must go first.');
    }

    // The ceiling holds even when nothing can be recycled: a take past the cap
    // is refused rather than served, so the join message cannot grow forever.
    const full = new CarField();
    for (let i = 0; i < MAX_DRIVEN_CARS; i++) {
      full.take({ identity: 5000 + i, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 0);
    }
    if (full.size !== MAX_DRIVEN_CARS) failures.push(`The field holds ${full.size} against a cap of ${MAX_DRIVEN_CARS}.`);
    if (full.take({ identity: 999999, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 1) !== null) {
      failures.push(`A take past ${MAX_DRIVEN_CARS} was granted. The budget is not a budget.`);
    }
  }

  // --- The two constants this file shares with files it may not import.
  if (CAR_HEALTH_MAX !== CAR_HEALTH_FULL) {
    failures.push(
      `CAR_HEALTH_MAX is ${CAR_HEALTH_MAX} and protocol.CAR_HEALTH_FULL is ${CAR_HEALTH_FULL}. The wire ` +
        `would quantise every car's condition against the wrong scale.`,
    );
  }
  if (CAR_HEALTH_MAX !== CAR_HEALTH_FULL_POSE) {
    failures.push(
      `CAR_HEALTH_MAX is ${CAR_HEALTH_MAX} and traffic.CAR_HEALTH_FULL_POSE is ${CAR_HEALTH_FULL_POSE}. ` +
        `Every dent in the city would be drawn at the wrong depth.`,
    );
  }
  if (TAKE_HEIGHT !== 2.5) {
    failures.push(
      `TAKE_HEIGHT is ${TAKE_HEIGHT}; traffic.ts repeats it as its own vertical gate for the hold and ` +
        `cannot import it. The two must agree.`,
    );
  }
  if (!(HOLD_GAP > 0 && HOLD_GAP < 20)) {
    failures.push(`traffic.HOLD_GAP is ${HOLD_GAP} m, which is not a car stopping behind another car.`);
  }
  // --- WORKSTREAM Y: the pair `game/carfire.ts` restates rather than imports.
  //
  // The cross-check has to live *here* and not in `verifyCarFire`, because the
  // whole reason those two constants are restated is that `carfire.ts` may not
  // import this file -- the ignition rule lives in `CarField.damage`, so the
  // dependency runs the other way and an import back is a cycle. This is the
  // same arrangement `CAR_HEALTH_FULL_POSE` and `SPRINT_SPEED` are kept honest
  // by, and the failure it catches is silent in the usual way: a fire that lit
  // cars at a health the smoke had not started at yet.
  if (CAR_HEALTH_MAX !== CAR_HEALTH_FULL_FIRE) {
    failures.push(
      `CAR_HEALTH_MAX is ${CAR_HEALTH_MAX} and carfire.CAR_HEALTH_FULL_FIRE is ${CAR_HEALTH_FULL_FIRE}.`,
    );
  }
  if (CAR_SMOKING_HEALTH !== CAR_SMOKING_HEALTH_FIRE) {
    failures.push(
      `CAR_SMOKING_HEALTH is ${CAR_SMOKING_HEALTH} and carfire.CAR_SMOKING_HEALTH_FIRE is ` +
        `${CAR_SMOKING_HEALTH_FIRE}. The two decide the same thing about the same car: whether it is broken ` +
        `enough for a heavy hit to set it alight.`,
    );
  }
  // WORKSTREAM AP: and the third of the restated trio, which is new because the
  // retune made the fire threshold a fraction of the crash cap rather than a
  // number that happened to sit under it. See `carfire.CRASH_CAP_FIRE`.
  if (CRASH_DAMAGE_MAX !== CRASH_CAP_FIRE) {
    failures.push(
      `CRASH_DAMAGE_MAX is ${CRASH_DAMAGE_MAX} and carfire.CRASH_CAP_FIRE is ${CRASH_CAP_FIRE}. That pair is ` +
        `what proves carfire.IGNITE_CRASH_HP is a threshold an impact can actually cross; drifted, the fire ` +
        `rule reads as working and never fires.`,
    );
  }

  // --- WORKSTREAM Y: the fire, through the field rather than through the pure
  //     rules -- `verifyCarFire` owns those. What is checked here is the wiring:
  //     that an impact reaches the ignition, that the clock reaches the fuse,
  //     and that a destroyed identity never comes back.
  {
    const field = new CarField();
    const car = field.take({ identity: 0xf1e, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 5)!;
    if (isBurning(car.burningMs)) failures.push('A freshly taken car was already on fire.');
    // **Every write-off catches**, which is the path essentially every fire in
    // the game takes and is the owner's sentence in one assertion.
    field.damage(car.id, CAR_HEALTH_MAX);
    if (car.health !== 0) failures.push(`The fire check could not write the car off; it is on ${car.health}.`);
    if (!isBurning(car.burningMs)) failures.push('A car driven to zero did not catch fire. Every write-off burns.');
    if (car.burningMs !== 0) failures.push(`A car that caught fire this tick is ${car.burningMs} ms into its fuse.`);
    // The fuse runs on the same sweep the other two clocks do, and it is *not*
    // this class's job to remove the record when it expires -- `sim.stepCars` is
    // the authority for the bang. A field that deleted its own records would be
    // a client blowing cars up on its own prediction.
    field.age(FUSE_MS - 100);
    if (field.get(car.id) === undefined) failures.push('CarField.age removed a burning car. Only the authority explodes one.');
    if (!fuseExpired(car.burningMs)) {
      field.age(200);
      if (!fuseExpired(car.burningMs)) failures.push(`A car ${car.burningMs} ms into a ${FUSE_MS} ms fuse had not expired.`);
    } else {
      failures.push('A fuse expired a tenth of a second early.');
    }
    // A burning car cannot be re-lit, which is the rule that stops a fuse being
    // restarted forever by a car park full of explosions. See `carfire.canIgnite`.
    const wasAt = car.burningMs;
    if (field.ignite(car.id) !== null) failures.push('A car that was already alight was set alight again.');
    if (car.burningMs !== wasAt) failures.push('A refused ignition still moved the fuse.');
    // And the destroyed identity. `remove` alone hands the ambient car back --
    // section 3 -- so a car that exploded would be standing in its bay again on
    // the next frame, undamaged, in front of its own scorch mark.
    field.scorch(car.carId);
    field.remove(car.id);
    if (!field.suppressed(0xf1e)) {
      failures.push('An exploded car stopped suppressing its ambient copy. The burnt car reappears at the kerb.');
    }
    if (field.scorchedCount !== 1) failures.push(`The scorch ledger holds ${field.scorchedCount} identities, not 1.`);
    // ...and a whole new world forgets. `clear` is the only thing that empties it.
    field.clear();
    if (field.suppressed(0xf1e)) failures.push('A cleared field still suppressed a destroyed car; that is a leak across rooms.');
  }
  // The ignition lock outlives one tick and dies with the fuse, which is the
  // only thing about it a caller can observe through this class.
  {
    const field = new CarField();
    const car = field.take({ identity: 0xf1f, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 6)!;
    field.ignite(car.id);
    if (car.igniteLockMs !== IGNITE_LOCK_MS) failures.push(`Igniting a car left a ${car.igniteLockMs} ms lock, not ${IGNITE_LOCK_MS}.`);
    field.age(IGNITE_LOCK_MS + 100);
    if (car.igniteLockMs !== 0) failures.push(`The ignition lock read ${car.igniteLockMs} ms after it should have run out.`);
  }
  // The burn eats what is left of a car that caught fire while it still had
  // condition -- the `IGNITE_CRASH_HP` path -- and it does it without going
  // through the impact cooldown, which would swallow all but two ticks of it.
  {
    const field = new CarField();
    const car = field.take({ identity: 0xf20, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 7)!;
    // Two hits with the cooldown cleared between them: 100 down to 39 -- under
    // the smoke line -- and then an `IGNITE_CRASH_HP` hit exactly, which lights
    // the car **without finishing it**. That combination is the whole point of
    // this fixture: the other ignition path (reaching zero) leaves nothing for
    // the burn rate below to eat.
    //
    // WORKSTREAM AP: the second hit is the constant and not the 30 it used to
    // be spelt as. The retune took the crash cap to 7 and `IGNITE_CRASH_HP` to
    // 4 with it, and a literal 30 here would have gone on passing while
    // describing a hit nothing in the game can land.
    field.damage(car.id, 61);
    if (!(car.health < CAR_SMOKING_HEALTH)) failures.push(`The burn fixture left the car on ${car.health}, not under the smoke line.`);
    field.age(CRASH_COOLDOWN_MS);
    field.damage(car.id, IGNITE_CRASH_HP);
    if (!isBurning(car.burningMs)) {
      failures.push(`A ${IGNITE_CRASH_HP} hp hit on a car on 39 did not light it. That is the "already broken" ignition path.`);
    }
    if (!(car.health > 0)) failures.push('The burn check needs a car that caught fire with condition left; it is at zero.');
    const before = car.health;
    field.age(1000);
    const lost = before - car.health;
    if (Math.abs(lost - BURN_HP_PER_S) > 1e-6) {
      failures.push(`A second of burning took ${lost.toFixed(2)} hp against carfire.BURN_HP_PER_S's ${BURN_HP_PER_S}.`);
    }
    // ...and it stops at zero rather than going negative, which would invert
    // every dent scale that reads this number.
    field.age(60_000);
    if (car.health !== 0) failures.push(`A minute of burning left the car on ${car.health}; the floor is 0.`);
  }

  // --- `resolveTake` end to end is not exercised here -- it needs a
  //     `TrafficField` with a real lane sidecar in it, which is
  //     `server/take-check.ts`' job. What *is* checkable without one is that the
  //     two radii it uses are the bikes', because "E has one reach" is a rule and
  //     not a coincidence.
  if (TAKE_RADIUS !== 2.2 || TAKE_HEIGHT !== 2.5) {
    failures.push(
      `A car is taken from ${TAKE_RADIUS} m and ${TAKE_HEIGHT} m up, where a bike is taken from 2.2 and 2.5. ` +
        'E has one reach.',
    );
  }
  if (!(TAKEABLE_SPEED > 0 && TAKEABLE_SPEED < DRIVE_TOP_SPEED)) {
    failures.push(`TAKEABLE_SPEED is ${TAKEABLE_SPEED}, which is not "a car that has nearly stopped".`);
  }

  // --- WORKSTREAM S: the arbitration between the two fleets, which *is*
  //     checkable here because `beginTake`/`offerTake` were split out of
  //     `resolveTake` precisely so that it would be.
  //
  // What this catches, and none of it needs a baked world:
  //
  //   - **A static car that cannot win.** The bug this workstream exists to fix
  //     wearing a disguise: the arbitration is asked twice, and a second source
  //     whose candidates are always rejected leaves the feature exactly as
  //     broken as it was, with a green check beside it.
  //   - **A schedule car that can no longer win.** The other direction. A parked
  //     car is at the kerb and a schedule car easing out of the bay beside it is
  //     50 cm nearer; if the second source overwrote rather than *competed*, the
  //     player would get whichever file was consulted last.
  //   - **A tie broken on the source rather than on the identity.** A static and
  //     a schedule car at exactly the same range is not hypothetical -- it is
  //     what a bay row in Surry Hills is -- and the two ends ask the two sources
  //     in the same order only by convention. The identity rule is what makes it
  //     a rule.
  //   - **A vertical gate that stopped applying to one of the fleets.** The
  //     Cahill/Alfred Street case, for the fleet that is actually parked on the
  //     Cahill.
  {
    const q = createTakeQuery();
    const out = createTakeable();
    // Standing at the origin, feet at 0. All four candidates are in reach in
    // plan; only the heights and the ranges differ.
    const SCHEDULE = 0x1000_0000;
    const STATIC_NEAR = 0x2000_0000;
    const STATIC_FAR = 0x3000_0000;
    // One static car, nothing else. The whole workstream in three lines.
    beginTake(q, 0, 0, 0);
    offerTake(q, out, STATIC_NEAR, 0, 0, 1, 0, 0, 0, true);
    if (!q.found || out.identity !== STATIC_NEAR) {
      failures.push(
        'A parked car one metre away, offered to an empty arbitration, was not taken. That is the ' +
          'reported bug -- 23,020 cars at the kerb and E does nothing -- with the world removed.',
      );
    }
    if (!out.parked) failures.push('A car out of the parked fleet came back with `parked` false.');
    // A schedule car nearer than a static one wins, and the other way round.
    beginTake(q, 0, 0, 0);
    offerTake(q, out, STATIC_NEAR, 0, 0, 1.5, 0, 0, 0, true);
    offerTake(q, out, SCHEDULE, 1, 1, 0.5, 0, 0, 0, false);
    if (out.identity !== SCHEDULE) {
      failures.push(
        `A schedule car 0.5 m away lost to a parked car 1.5 m away (took ${out.identity}). The two ` +
          'fleets compete on distance; they do not take turns.',
      );
    }
    if (out.body !== 1 || out.colour !== 1) {
      failures.push('The winning candidate did not carry its own body and colour out.');
    }
    beginTake(q, 0, 0, 0);
    offerTake(q, out, SCHEDULE, 0, 0, 1.5, 0, 0, 0, false);
    offerTake(q, out, STATIC_NEAR, 0, 0, 0.5, 0, 0, 0, true);
    if (out.identity !== STATIC_NEAR) {
      failures.push('A parked car 0.5 m away lost to a schedule car 1.5 m away.');
    }
    // **The tie.** Same range, either order offered, lower identity wins both
    // times -- which is the only version two processes can agree on.
    beginTake(q, 0, 0, 0);
    offerTake(q, out, STATIC_FAR, 0, 0, 1, 0, 0, 0, true);
    offerTake(q, out, SCHEDULE, 0, 0, 1, 0, 0, 0, false);
    const firstOrder = out.identity;
    beginTake(q, 0, 0, 0);
    offerTake(q, out, SCHEDULE, 0, 0, 1, 0, 0, 0, false);
    offerTake(q, out, STATIC_FAR, 0, 0, 1, 0, 0, 0, true);
    if (firstOrder !== out.identity || out.identity !== SCHEDULE) {
      failures.push(
        `A static car and a schedule car at the same range resolved to ${firstOrder} asked one way and ` +
          `${out.identity} asked the other; the rule is the lower identity (${SCHEDULE}), whatever the ` +
          'order. Two builds that disagree here disagree about which car a player got into.',
      );
    }
    // The radius, and the vertical gate, on a parked candidate.
    beginTake(q, 0, 0, 0);
    if (offerTake(q, out, STATIC_NEAR, 0, 0, TAKE_RADIUS + 0.1, 0, 0, 0, true)) {
      failures.push(`A parked car ${TAKE_RADIUS + 0.1} m away was inside a ${TAKE_RADIUS} m reach.`);
    }
    beginTake(q, 0, 0, 0);
    if (offerTake(q, out, STATIC_NEAR, 0, 0, 1, TAKE_HEIGHT + 0.1, 0, 0, true)) {
      failures.push(
        `A parked car ${TAKE_HEIGHT + 0.1} m overhead was takeable. That is the Cahill Expressway ` +
          'reaching down into Alfred Street.',
      );
    }
    beginTake(q, 0, 0, 0);
    if (offerTake(q, out, STATIC_NEAR, 0, 0, 1, -(TAKE_HEIGHT + 0.1), 0, 0, true)) {
      failures.push('The vertical gate only applies in one direction.');
    }
    if (q.found) failures.push('A refused candidate still marked the arbitration as found.');
  }

  // --- The witness sees over open ground, not through walls, and not the fallen.
  {
    const one = (px: number, pz: number, down = false) =>
      (visit: (a: number, b: number, c: number, d: boolean) => void): void => visit(px, 0, pz, down);
    if (!bystanderSeen(0, 0, 0, one(5, 0), null)) failures.push('A pedestrian five metres away saw nothing.');
    if (bystanderSeen(0, 0, 0, one(WITNESS_RADIUS + 1, 0), null)) {
      failures.push(`Somebody past the ${WITNESS_RADIUS} m range witnessed a theft.`);
    }
    if (bystanderSeen(0, 0, 0, one(5, 0), () => true)) failures.push('A witness saw a theft through a wall.');
    if (bystanderSeen(0, 0, 0, one(5, 0, true), null)) {
      failures.push('Somebody face down on the footpath was counted as a witness.');
    }
    if (bystanderSeen(0, 0, 0, () => {}, null)) failures.push('An empty street witnessed a theft.');
  }

  return failures;
}

/** Scratch a caller needs to run `resolveTake`. Here so both ends allocate it the same way. */
export function createDrivingScratch(): { routes: LaneRoute[]; pose: CarPose; take: TakeableCar } {
  return { routes: [], pose: createCarPose(), take: createTakeable() };
}
