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
 * 1. WHAT A "CAR" IS, AND WHY IT IS A TRAFFIC CAR AND NOT A KERB CAR.
 *
 * There are two fleets of cars in Sydney and they look the same on purpose:
 *
 *   - the **static** fleet, ~875,000 of them baked into `<tile>.cars.bin` and
 *     drawn by `world/cars.buildTileCars`. Scenery. Never moves.
 *   - the **schedule** fleet, a closed-form lookup over `<tile>.lanes.bin`
 *     (`game/traffic.poseCar`), which since the park stages landed spends a good
 *     part of each car's life *stationary in a kerb bay*, at which point
 *     `world/cars.ts`' own header says it is "indistinguishable from the 23,020
 *     already at that kerb".
 *
 * The brief asked for both to be stealable. Only the second one is, and the
 * reason is not laziness -- it is that **the server has no idea the first one
 * exists.** `server/world.ts` streams two layers per hexagon, collision prisms
 * and lane sidecars; `.cars.bin` is a renderer file and is never read outside
 * the browser. Making a kerb car stealable server-authoritatively means a third
 * streaming layer over 13,362 files and 14 MB of parked cars on a 1 GB box, and
 * making it stealable *without* that means the client naming a car the server
 * cannot see -- which is a client that can conjure a vehicle.
 *
 * So every takeable car is a schedule car, and the rule is the brief's own
 * second clause: **stopped or under `TAKEABLE_SPEED`**. That catches a car in a
 * park stage at the kerb (speed exactly 0, and visually a parked car), a car
 * held at a red light, and a car easing out of a bay. `world/cars.TrafficMovers`
 * reports about 41 kerb-parked schedule cars inside its 420 m draw radius at a
 * measured moment in town, which is one every 4,300 m^2 -- so "walk down the
 * street and press E at a car" holds, even though "any car you can see" does
 * not. See the report; this is the one deliberate deviation in the workstream.
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
  CAR_HEALTH_FULL_POSE,
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  HOLD_GAP,
  type CarPose,
  type LaneRoute,
  type TrafficField,
  createCarPose,
  forEachCarNear,
} from './traffic.ts';

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
 * is 12.4 kB -- one MTU-bounded burst on a socket that has just carried the
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
 * Below this delta-v a collision costs nothing, m/s. The brief's 3.
 *
 * It is not "no damage below 3", it is **"3 m/s of every impact is free"** --
 * the curve is `(dv - 3) x 6` and not `dv x 6` above a threshold, so there is no
 * step at the boundary. That continuity is the same requirement
 * `traffic.carHitStrength`'s header states for the knockdown and it is here for
 * the identical reason: a threshold makes the last centimetre of a nudge the
 * difference between nothing and a dent, and a player who kerbed at 3.1 m/s
 * twice and got two different answers is a player who thinks the damage is
 * random.
 *
 * 3 m/s is also, deliberately, the speed a car is allowed to be *taken* at
 * (`TAKEABLE_SPEED`): manoeuvring a car in and out of a space is free, and
 * anything you would describe as driving into something is not.
 */
export const CRASH_FREE_SPEED = 3;

/**
 * Health lost per metre per second of impact past the free allowance.
 *
 * Six, which is the brief's, and the two numbers it is chosen to produce are:
 * a 6 m/s hit is 18 -- a scrape you can see and carry on from -- and a
 * `DRIVE_TOP_SPEED` wall is `(0.66 x 44 - 3) x 6 = 156`, clamped to
 * `CRASH_DAMAGE_MAX`... which is only 60, so a full-speed wall is *not* an
 * instant write-off from full health. That is intentional and it took a round
 * of thinking to keep: an instant write-off from one mistake makes the whole
 * feature a punishment, where the first heavy crash being a warning makes it a
 * thing you learn. The car ends up on exactly 40, which is where the smoke
 * starts.
 *
 * And the curve compounds in the *forgiving* direction, which is worth stating
 * because it is not obvious from the constants. A car under 40 is capped at
 * `CAR_SMOKING_SCALE` of the top speed, so its *next* crash is slower than its
 * last: `server/cardamage-check.ts` drives the real thing at a wall and
 * measures 60 for the first, which leaves it smoking on exactly 40.
 *
 * **The doubling of `DRIVE_TOP_SPEED` changed the tail of that and is worth
 * recording, because the headline number did not move.** A top-speed wall was
 * 114 raw against a cap of 60 before and is 156 against the same 60 now -- the
 * curve saturated long before the old top speed and it saturates harder -- so
 * the *first* crash costs exactly what it always did and a full-health car is
 * still not written off by one mistake. What changed is the second one: a
 * smoking car is capped at 0.6 of the top speed, which used to be 13.2 m/s and a
 * 61 hp raw hit, and is now 26.4 and a 141 hp raw hit. Both clamp to 60, and 60
 * is more than the 40 a smoking car has left.
 *
 * So a car is **two** heavy walls rather than three. That is a smaller change
 * than it sounds and it is left alone deliberately: the property the whole
 * feature is built on -- *the first heavy crash is a warning rather than the
 * end* -- is untouched, and it is the only one anybody experiences. Pulling
 * `CRASH_DAMAGE_PER_SPEED` down to restore the third run would make every
 * *light* knock cheaper too, which is the wrong end of the curve to pay from.
 * What *also* changed is how much road you need to reach the top at all -- see
 * `DRIVE_ACCELERATION` -- and 161 m of clear carriageway is rarer in this city
 * than 40 was.
 */
export const CRASH_DAMAGE_PER_SPEED = 6;

/** The most one impact can cost, however fast you were going. See above. */
export const CRASH_DAMAGE_MAX = 60;

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
 * What running somebody down costs the car. Two, and it is cosmetic on purpose.
 *
 * The brief: "the human is the one hurt". A pedestrian is not a wall, and a game
 * where mowing down a crowd wrecked your car would be a game telling you not to
 * -- which is not the game `traffic.applyCarHit` and the owner's stated
 * fondness for being run over describe. Two hp is enough that a spree leaves a
 * mark, and forty pedestrians to a write-off is not a route anybody will take.
 */
export const PEDESTRIAN_DAMAGE = 2;

/** At or below this the paint is dented and one headlight is out. The brief's 70. */
export const CAR_DENTED_HEALTH = 70;
/** At or below this the bonnet smokes and the car is slow. The brief's 40. */
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
 * `clamp((dv - CRASH_FREE_SPEED) x CRASH_DAMAGE_PER_SPEED, 0, CRASH_DAMAGE_MAX)`,
 * and it is a free function rather than a method because both the authority and
 * the prediction call it and neither has any business owning it. Four operations
 * and no transcendental, so the two ends produce the same number bit for bit --
 * see section 5.
 */
export function crashDamage(deltaV: number): number {
  const over = deltaV - CRASH_FREE_SPEED;
  if (!(over > 0)) return 0;
  const raw = over * CRASH_DAMAGE_PER_SPEED;
  return raw > CRASH_DAMAGE_MAX ? CRASH_DAMAGE_MAX : raw;
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
export const DRIVE_ROLL_MAX = 0.09;
/** And how far it dives under full braking. About 3.5 degrees. */
export const DRIVE_PITCH_MAX = 0.06;

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
  const dead = health <= 0;
  const hurt = !dead && health <= CAR_SMOKING_HEALTH;
  const scale = hurt ? CAR_SMOKING_SCALE : 1;
  const top = (rough ? DRIVE_TOP_SPEED_ROUGH : DRIVE_TOP_SPEED) * scale;
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
    const hit = world.collision.resolve(
      x, z,
      x + fx * NOSE_REACH, z + fz * NOSE_REACH,
      NOSE_RADIUS, feetY,
    );
    if (hit.hit) {
      // Not to zero: a hard stop at a kerb reads as the car being deleted. Two
      // thirds off per tick sheds 44 m/s in about 90 ms, which is a crunch.
      const before = v;
      v *= 0.34;
      if (v < 0.2) v = 0;
      // **The impulse.** Two thirds of the speed in one tick is the whole of
      // what the car "lost to the wall", and it is the number `crashDamage`
      // wants -- which is why the 0.66 factor matters twice over: at 44 m/s it
      // reports 29 m/s of delta-v and therefore a 60 hp write-off's worth of
      // damage on the *first* tick, and the `CRASH_COOLDOWN_MS` half-second
      // swallows the four ticks of continued grinding that follow. Reporting
      // the whole 44 across five ticks would have been the same crash costing
      // five times as much.
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
export function crashFromClamp(c: DriveState, movedX: number, movedZ: number, dt: number): number {
  if (c.drivingCar === 0 || dt <= 1e-6) return 0;
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
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const d2 = rx * rx + rz * rz;
  const reach = a.halfLength + b.halfLength;
  if (d2 >= reach * reach) return 0;
  // Exactly on top of each other: no direction to close along, and no answer
  // that is not a divide by zero. Two records at one point is a take that
  // happened inside another car, which the claim rules make impossible.
  if (d2 < 1e-9) return 0;
  const inv = 1 / Math.sqrt(d2);
  const nx = rx * inv;
  const nz = rz * inv;
  // Each car's velocity along its own heading, projected onto the line between
  // them. `yaw` 0 faces -Z, `controller.step`'s convention.
  const av = a.speed * (-Math.sin(a.yaw) * nx + -Math.cos(a.yaw) * nz);
  const bv = b.speed * (-Math.sin(b.yaw) * nx + -Math.cos(b.yaw) * nz);
  // Positive when `a` is moving toward `b` faster than `b` is moving away.
  const closing = av - bv;
  return closing > CRASH_FREE_SPEED ? closing : 0;
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

/** One schedule car somebody could get into, as `resolveTake` hands it over. */
export interface TakeableCar {
  /** `traffic.identityOf(route, slot)`. The car's name in every process. */
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
 * The nearest car at this point that somebody could get into, or false.
 *
 * Runs on the server to grant a steal and in the browser to predict one and to
 * draw the prompt, off the same `TrafficField` lookup at the same whole tick,
 * which is what makes the prompt honest: if the HUD says "E -- take the car" the
 * server will agree, because both asked `poseCar` the same question.
 *
 * **Ties break on identity rather than on the float distance**, which is
 * `BikeField.nearestFree`'s rule and is here for its reason: two cars at the
 * same range have to resolve the same way on the client predicting the take and
 * on the server granting it, and an integer comparison is a rule both can state
 * where a float comparison is one two builds can disagree about.
 *
 * `taken` is the suppression predicate -- a car somebody is already driving is
 * not takeable, and without this clause two players would both "take" the same
 * identity and the second would get a record pointing at a suppressed ghost.
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
): boolean {
  let bestD2 = TAKE_RADIUS * TAKE_RADIUS;
  let bestIdentity = 0;
  let found = false;
  forEachCarNear(field, x, z, TAKE_RADIUS, tick, scratch, pose, (p) => {
    if (p.speed > TAKEABLE_SPEED) return;
    if (taken(p.identity)) return;
    // The vertical gate. `bikes.MOUNT_HEIGHT`'s argument: a plan-only test lets
    // somebody on the Cahill Expressway take a car on Alfred Street eight metres
    // below them.
    const dy = p.y - feetY;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return;
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2) return;
    // Strictly nearer, or the same distance and a lower identity. See the header.
    if (found && (d2 > bestD2 || (d2 === bestD2 && p.identity >= bestIdentity))) return;
    found = true;
    bestD2 = d2;
    bestIdentity = p.identity;
    out.identity = p.identity;
    out.body = p.body;
    out.colour = p.colour;
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.yaw = headingYaw(p.dx, p.dz);
    out.parked = p.stage === CAR_STAGE_PARKED_IN || p.stage === CAR_STAGE_PARKED_OUT;
  });
  return found;
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
      emptyMs: 0,
      health: CAR_HEALTH_MAX,
      damageCooldownMs: 0,
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
  }): DrivenCar {
    const existing = this.byId.get(record.id);
    if (existing) {
      existing.x = record.x;
      existing.y = record.y;
      existing.z = record.z;
      existing.yaw = record.yaw;
      existing.speed = record.speed;
      existing.driverId = record.driverId;
      // **The authority's health wins, always.** This is the line that corrects
      // a driver's prediction of their own crash, and it is unconditional for
      // the reason the position above it is: the server decided how hard you hit
      // the wall, and a client that kept its own answer whenever it was lower
      // would be a client that repaired its car by mispredicting.
      if (record.health !== undefined) existing.health = record.health;
      if (record.driverId !== 0) existing.emptyMs = 0;
      return existing;
    }
    const car: DrivenCar = {
      ...record,
      emptyMs: 0,
      health: record.health ?? CAR_HEALTH_MAX,
      damageCooldownMs: 0,
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
    return this.bySource.has(identity);
  }

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
    }
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
    car.health -= amount;
    // `applyCarHit`'s femto-pip clamp, and it matters here for its reason: a
    // health of 4e-15 is a car that is not written off, does not smoke black,
    // and has an engine that still turns over -- which is a car nobody can tell
    // apart from a wreck and which no player will ever manage to finish off.
    if (car.health < 1e-9) car.health = 0;
    car.damageCooldownMs = CRASH_COOLDOWN_MS;
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
  recycleFarthest(playersXZ: readonly number[]): number {
    if (this.byId.size === 0) return 0;
    let bestId = 0;
    let bestDistance = -1;
    let bestEmpty = -1;
    for (const car of this.all()) {
      if (car.driverId !== 0) continue;
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
    if (Math.abs(hitDv - 20 * 0.66) > 0.5) {
      failures.push(
        `Driving into a wall at 20 m/s reported ${hitDv.toFixed(2)} m/s of delta-v; the probe sheds ` +
          `two thirds, so it is about 13.2. This number is the crash damage.`,
      );
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
    // The brief: "a 6 m/s hit is about 18 hp".
    if (Math.abs(crashDamage(6) - 18) > 1e-9) failures.push(`A 6 m/s hit cost ${crashDamage(6)} hp, not 18.`);
    // Continuous at the boundary: no step, so a kerb at 3.01 m/s is not a dent.
    if (crashDamage(CRASH_FREE_SPEED + 0.01) > 0.1) {
      failures.push('The damage curve has a step at the free allowance; a 3.01 m/s kerb was a real hit.');
    }
    // And capped, so one wall is a warning rather than a write-off. See
    // `CRASH_DAMAGE_MAX`: full throttle into a wall leaves the car on exactly
    // the smoke threshold, which is the number that makes the second crash the
    // one that ends it.
    if (crashDamage(DRIVE_TOP_SPEED) !== CRASH_DAMAGE_MAX) {
      failures.push(`A ${DRIVE_TOP_SPEED} m/s wall cost ${crashDamage(DRIVE_TOP_SPEED)} hp; the cap is ${CRASH_DAMAGE_MAX}.`);
    }
    if (CAR_HEALTH_MAX - CRASH_DAMAGE_MAX !== CAR_SMOKING_HEALTH) {
      failures.push(
        `One maximum crash leaves a car on ${CAR_HEALTH_MAX - CRASH_DAMAGE_MAX} against a smoke threshold of ` +
          `${CAR_SMOKING_HEALTH}. The two are meant to be the same number: the worst single crash is exactly ` +
          `the one that starts the smoke.`,
      );
    }
    // Monotone, which is the property a player actually learns.
    let last = -1;
    for (let dv = 0; dv <= 30; dv += 0.5) {
      const d = crashDamage(dv);
      if (d < last) failures.push(`crashDamage fell from ${last} to ${d} at ${dv} m/s; harder must never be cheaper.`);
      last = d;
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
    if (crashFromClamp(clear, 20 * dt, 0, dt) !== 0) failures.push('An unobstructed car was charged for a crash.');
    if (clear.carSpeed !== 20) failures.push('An unobstructed car was slowed by the clamp detector.');
    // Three per cent short is a slope, or friction, or the controller ramping.
    const slope: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(slope, 20 * dt * 0.97, 0, dt) !== 0) {
      failures.push('A car that covered 97 % of its step was charged for a crash. That is a slope.');
    }
    // Dead stop against a prism: the whole speed is the impulse.
    const wall: DriveState = { drivingCar: 1, carSpeed: 20, carHealth: CAR_HEALTH_MAX };
    const dv = crashFromClamp(wall, 0, 0, dt);
    if (Math.abs(dv - 20 * (1 - CLAMP_SLIP)) > 1e-6) {
      failures.push(`A car stopped dead at 20 m/s reported ${dv.toFixed(2)} m/s of delta-v.`);
    }
    if (!(wall.carSpeed < 4)) {
      failures.push(
        `A car stopped dead by a prism kept ${wall.carSpeed.toFixed(2)} m/s. The detector has to *take* the ` +
          `speed as well as report it, or the next tick asks the controller for 20 m/s into the same wall.`,
      );
    }
    // Nobody on foot, and nothing at all below the free speed.
    const walker: DriveState = { drivingCar: 0, carSpeed: 8, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(walker, 0, 0, dt) !== 0) failures.push('Somebody on foot crashed a car.');
    const crawl: DriveState = { drivingCar: 1, carSpeed: CRASH_FREE_SPEED, carHealth: CAR_HEALTH_MAX };
    if (crashFromClamp(crawl, 0, 0, dt) !== 0) failures.push('A car nudging a kerb at the free speed was charged.');
  }

  // --- Car against car: overlap plus closing speed, and neither on its own.
  {
    const box = { halfLength: 2.3 };
    // Head-on at 5 and 0: the mover crashes.
    const still = { x: 0, z: -4, yaw: 0, speed: 0, ...box };
    const into = { x: 0, z: 0, yaw: Math.PI, speed: 5, ...box };
    // yaw = PI faces +Z; the parked car is at -4, so this is driving *away*.
    if (carCrashClosing(into, still) !== 0) failures.push('A car driving away from another one crashed into it.');
    const at = { x: 0, z: 0, yaw: 0, speed: 5, ...box };
    const ahead = { x: 0, z: -4, yaw: 0, speed: 0, ...box };
    const closing = carCrashClosing(at, ahead);
    if (Math.abs(closing - 5) > 1e-6) failures.push(`A 5 m/s rear-ender reported ${closing.toFixed(2)} m/s of closing.`);
    // Far apart is nothing, whatever the speed.
    const far = { x: 0, z: -40, yaw: 0, speed: 0, ...box };
    if (carCrashClosing(at, far) !== 0) failures.push('Two cars forty metres apart crashed.');
    // Nose to tail in convoy at the same speed is not a crash, which is the case
    // a plain overlap test gets wrong and is why this measures closing.
    const lead = { x: 0, z: -4, yaw: 0, speed: 18, ...box };
    const follow = { x: 0, z: 0, yaw: 0, speed: 18, ...box };
    if (carCrashClosing(follow, lead) !== 0) failures.push('Two cars in convoy at one speed crashed into each other.');
    // And a gentle touch is inside the free allowance.
    const gentle = { x: 0, z: 0, yaw: 0, speed: CRASH_FREE_SPEED, ...box };
    if (carCrashClosing(gentle, ahead) !== 0) failures.push('Parking against another car at the free speed was a crash.');
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

  // --- `resolveTake` is not exercised here -- it needs a `TrafficField` with a
  //     real lane sidecar in it, which is `server/integration-check.ts`' job.
  //     What *is* checkable without one is that the two radii it uses are the
  //     bikes', because "E has one reach" is a rule and not a coincidence.
  if (TAKE_RADIUS !== 2.2 || TAKE_HEIGHT !== 2.5) {
    failures.push(
      `A car is taken from ${TAKE_RADIUS} m and ${TAKE_HEIGHT} m up, where a bike is taken from 2.2 and 2.5. ` +
        'E has one reach.',
    );
  }
  if (!(TAKEABLE_SPEED > 0 && TAKEABLE_SPEED < DRIVE_TOP_SPEED)) {
    failures.push(`TAKEABLE_SPEED is ${TAKEABLE_SPEED}, which is not "a car that has nearly stopped".`);
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
