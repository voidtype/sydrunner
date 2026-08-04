/**
 * Lime e-bikes: where they are, who is on one, and how fast that makes you.
 *
 * The gameplay half of the feature, and deliberately the half that imports
 * nothing from three -- `world/bike.ts` is the mesh and this is the rules, on
 * exactly the split `game/powerups.ts` and `world/powerups.ts` already make.
 * The server runs this file; the browser runs this file; neither runs the other
 * one's copy of it.
 *
 * ---------------------------------------------------------------------------
 * THE SPEED, AND WHY IT IS EXPRESSED IN COFFEES.
 *
 * The order was "2x coffee run speed", and a coffee run is a real, already-tuned
 * thing in this game: spec 8.3's Flat White multiplies the sprint by
 * `powerups.FLAT_WHITE_SPEED`. So a bike is **two of those** and a tuned bike is
 * **three**, and both are written here as a count of coffees rather than as a
 * number, so that re-tuning the powerup re-tunes the bike with it. A bike that
 * was "3.2" would be a bike that silently stopped being twice a coffee run the
 * first time anybody touched spec 8.3.
 *
 * At the constants as they stand -- sprint 8.2 m/s, Flat White 1.6 -- that is:
 *
 *     coffee run   8.2 x 1.6       = 13.1 m/s   47 km/h
 *     bike         8.2 x 1.6 x 2   = 26.2 m/s   94 km/h
 *     tuned bike   8.2 x 1.6 x 3   = 39.4 m/s  142 km/h
 *
 * `verifyBikes` measures all three by running the real integrator rather than
 * quoting them, because the whole point of deriving the multiplier is that these
 * numbers are allowed to move.
 *
 * **It composes with the powerups rather than replacing them**, which is the
 * same rule wading already follows one file over: a Flat White on a bike is
 * faster than a bike, because both are multipliers on a target speed and
 * neither is a special case. That is reachable and silly and it is the correct
 * behaviour -- the alternative is a rule about which buff wins, which is a rule
 * a player has to be told.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MULTIPLIER IS NEVER ON THE WIRE.
 *
 * `shapeRideInput` reads the *combatant's own* riding state and writes the
 * scales into the movement snapshot, which is precisely what `combat.advance`
 * already does with `powerups.speedScale`. The client sends buttons and a look
 * direction and nothing else -- see `protocol.INPUT_BYTES` -- so a client that
 * would like to go three times as fast has nowhere to say so: the server decides
 * whether you are on a bike, whether that bike is tuned, and therefore what the
 * number is. `checkBikes` asserts exactly that by trying it.
 *
 * The same function runs in the client's own prediction and in
 * `net/client.reconcile`'s replay, and it has to be the *same function* rather
 * than the same arithmetic twice: a replay that forgot the bike would rewind the
 * player 26 m/s worth of trajectory every snapshot, which reads as a rubber band
 * and not as a bug.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BIKES ARE: a plan, and then a placement.
 *
 * Two steps, and the split is what makes a streaming client and a fully-loaded
 * server agree.
 *
 *   1. **The plan** (`bikePlan`) needs only `index.json` -- the tile list both
 *      ends already have before anything streams. It hashes each tile key and
 *      decides whether that tile has a bike and roughly where, which fixes the
 *      *set* and, more importantly, fixes the **ids**: they are handed out in
 *      the index's own tile order, so bike 31 is the same bike in every process
 *      that read the same index.
 *   2. **The placement** (`placeBike`) needs the tile's collision prisms and
 *      terrain, and snaps the planned point to the ground, out of any building
 *      it landed in, or gives up. The server can do this for the whole city at
 *      boot; a browser can only do it for tiles it has actually loaded.
 *
 * Online, the placement never happens in the browser at all -- the server sends
 * the positions (`protocol.encodeBikes`) and the client mirrors them. That is
 * belt and braces on purpose: the plan is deterministic, but the *placement*
 * consults prisms, and a browser holding 420 m of city has fewer prisms than a
 * server holding all of it, so a building straddling a tile edge could nudge the
 * two ends to different spots. One 15-byte record per bike at join removes the
 * whole class of disagreement for about a kilobyte.
 *
 * Offline there is no server, the client is the authority, and it places bikes
 * itself as tiles arrive -- which is the same code path, with `?offline` as the
 * only difference.
 */

import type { InputSnapshot } from '../player/controller.ts';
import { FLAT_WHITE_SPEED } from './powerups.ts';

// --- The ride -----------------------------------------------------------------

/** How many coffee runs a bike is worth, and a tuned one. The user's order, verbatim. */
export const BIKE_COFFEES = 2;
export const BIKE_TUNED_COFFEES = 3;

/**
 * How much of a strafe survives being on a bike. None of it.
 *
 * A bicycle does not sidestep. Reducing the lateral input rather than forking
 * the integrator is the whole trick here: `controller.step` still runs exactly
 * once, with exactly the same physics, and the *steering* changes because the
 * wish vector it is handed changed. A second integrator for "vehicle physics"
 * would be a second thing for the server to reproduce and the first thing
 * prediction would drift on.
 *
 * **This was 0.35, and the third was the wrong answer to a real problem.** The
 * argument for keeping some of it was that zero is unrideable in a city: at
 * 26 m/s the yaw needed to correct a line at speed is more than a mouse gives
 * you in the width of a lane, and a rider who cannot nudge sideways clips every
 * awning post on Cleveland Street. That problem is real and a damped strafe is
 * not its fix -- what it produced was a bike that crabbed down George Street
 * facing straight ahead, which is the single thing players said about riding
 * one. The fix is `shapeRideSteering`: A and D now *turn the bars*, which is
 * both what a rider expects and a strictly better way to hold a line at speed.
 *
 * So the lateral input is gone and this is the constant that says so. It is
 * kept rather than deleted because it is what the **server** multiplies by --
 * see `shapeRideInput` -- and that is the half that makes it a rule rather than
 * a client-side courtesy: the steering remap lives in the browser's input
 * builder, where it belongs, and a hand-rolled client that simply kept sending
 * `right: 1` while riding would strafe unless this line also existed. Both ends
 * run `shapeRideInput`, so clamping here costs prediction exactly nothing.
 */
export const RIDE_STRAFE = 0;

/**
 * How much of a *reverse* survives, as a fraction of the throttle.
 *
 * `S` on foot walks you backwards at the full speed; on a bike the same key
 * would back you down Broadway at 26 m/s, which is not a manoeuvre. What a
 * rider means by `S` is "slow down", and the nearest thing this controller can
 * express is a small negative wish -- the target speed is
 * `SPRINT x speedScale x |forward|`, so a third of a reverse against the bike's
 * own multiplier is about 8 m/s of back-pedal, which sheds a top-speed run in
 * well under a second and then trickles backwards. That reads as a brake.
 *
 * On both ends, for `RIDE_STRAFE`'s reason exactly.
 */
export const RIDE_REVERSE = 0.3;

/**
 * How fast the bars turn at a standstill, radians per second.
 *
 * A shade over a quarter turn a second, so a U-turn is about two seconds of
 * held key. That is deliberately slower than the mouse -- the mouse is still
 * the fast way to look and to steer, exactly as it is on foot, and this is the
 * key that lets a rider hold a curve without dragging the pointer across the
 * desk. `KEY_TURN_RATE` in `main.ts` is 1.9 for the arrow keys on foot, so a
 * bike turns a little heavier than a body does, which is what a bike is.
 */
export const RIDE_TURN_RATE = 1.6;

/**
 * And at the tuned top speed. Slower, because 39 m/s is 142 km/h.
 *
 * The reason is legibility rather than physics. At the standstill rate a tuned
 * bike crosses a 10 m carriageway sideways in a fifth of a second, and the
 * screen at that speed is mostly motion -- a rider who taps `D` to line up a
 * laneway ends up facing the terrace beside it. Scaling the rate down with
 * speed keeps the *turn radius* in the same order across the whole range
 * (v/w: 5 m walking, 23 m on a bike, 43 m tuned) rather than making the fastest
 * state the twitchiest one.
 *
 * Not so low that the bike understeers: 0.9 rad/s at 39 m/s is still a full
 * 180 in three and a half seconds, which is 150 m of Cleveland Street.
 */
export const RIDE_TURN_RATE_FAST = 0.9;

/**
 * The speed at which the rate has fallen all the way to `RIDE_TURN_RATE_FAST`.
 *
 * A round number just past the tuned top speed (`bikeSpeedScale(true)` x the
 * controller's 8.2 m/s sprint is 39.4), so the fast end of the ramp is the fast
 * end of the game and nothing is clamped in normal play. A constant rather than
 * a derivation from `SPRINT_SPEED` because this file imports nothing from the
 * controller -- the same rule that keeps it runnable on the server -- and
 * `verifyBikes` asserts the two have not drifted apart.
 */
export const RIDE_TURN_FULL_SPEED = 40;

/**
 * And how much of a jump. "Jumping allowed but modest" -- a bunny hop over a
 * kerb rather than the 2 m the Flat White grants on foot.
 *
 * A velocity multiplier, so the apex goes as its square: 0.75 is 56% of the
 * height, which clears the controller's 0.42 m step and nothing else.
 */
export const RIDE_JUMP = 0.75;

/**
 * How close you have to be to a parked bike to get on it, metres.
 *
 * A shade over `powerups.PICKUP_RADIUS`, and for the opposite reason that one is
 * tight: a powerup is collected by walking into it and should not be collectable
 * across a footpath, where a bike is *aimed at* deliberately and the failure mode
 * is pressing E beside one and nothing happening. 2.2 m is about an arm and a
 * bike's length, which is what "reach out and take it" looks like from inside
 * the game.
 */
export const MOUNT_RADIUS = 2.2;

/**
 * And how far above or below, metres. `powerups.PICKUP_HEIGHT`'s argument
 * exactly: a plan-only test lets a player standing on a warehouse roof mount a
 * bike six metres below them.
 */
export const MOUNT_HEIGHT = 2.5;

/**
 * The state `shapeRideInput` reads.
 *
 * A structural type rather than `CombatantState`, and that is what keeps this
 * file out of the import cycle `game/combat.ts` and `game/powerups.ts` are
 * already in: combat.ts imports this file, so this file must not import
 * combat.ts. Two fields is a small enough contract to state structurally, and
 * `CombatantState` satisfies it by having them.
 */
export interface RideState {
  /** The bike this combatant is on, or 0. Ids come from `bikePlan`. */
  ridingBike: number;
  /** Whether this combatant has visited Redfern this session. */
  bikeTuned: boolean;
}

/**
 * The target-speed multiplier a rider gets, as a multiple of the sprint.
 *
 * A function rather than a `const`, and that is load-bearing rather than a
 * style choice. `powerups.ts` imports `combat.ts`, `combat.ts` imports this
 * file, and this file imports `powerups.ts` -- a cycle, and a legal one, so long
 * as nothing here *reads* a binding from powerups while that module is still
 * evaluating. A top-level `const BIKE = 2 * FLAT_WHITE_SPEED` would do exactly
 * that and would throw a temporal-dead-zone error, but only when the module
 * graph happened to be entered through `powerups.ts` -- which is to say, on some
 * builds and not others. Reading it inside a call cannot: by the time anybody
 * rides a bike, every module has finished.
 */
export function bikeSpeedScale(tuned: boolean): number {
  return (tuned ? BIKE_TUNED_COFFEES : BIKE_COFFEES) * FLAT_WHITE_SPEED;
}

/**
 * Fold a bike into the movement snapshot a combatant is about to be stepped
 * with. A no-op for anybody on foot.
 *
 * Called from `combat.advance` and from `net/client.reconcile`'s replay, and it
 * must stay exactly one function for the reason the header gives: two copies of
 * this arithmetic are two copies that drift, and the symptom is a rubber band
 * rather than an error.
 *
 * Multiplies whatever is already there rather than assigning, so the powerups
 * and the wading rule that ran before it survive.
 */
export function shapeRideInput(c: RideState, movement: InputSnapshot): void {
  if (c.ridingBike === 0) return;
  // A bike has one speed, and it is not a function of whether the player is
  // holding shift. Forcing the sprint is what makes the multiplier apply to
  // `SPRINT_SPEED` rather than to `WALK_SPEED`, which is what "2x coffee run"
  // means -- a coffee run is a sprint.
  movement.sprint = true;
  movement.right *= RIDE_STRAFE;
  // The brake. Only the reverse half is touched, so a throttle is a throttle --
  // see `RIDE_REVERSE`.
  if (movement.forward < 0) movement.forward *= RIDE_REVERSE;
  movement.speedScale = (movement.speedScale ?? 1) * bikeSpeedScale(c.bikeTuned);
  movement.jumpScale = (movement.jumpScale ?? 1) * RIDE_JUMP;
}

// --- Steering -----------------------------------------------------------------

/**
 * How fast the bars turn at this speed, radians per second.
 *
 * A straight ramp between the two constants rather than a curve, because the
 * thing being corrected is linear in speed: what a rider is actually holding
 * constant across the range is the turn radius, `v / w`, and a linear `w(v)`
 * against a linear `v` is the closest a one-line function gets to that.
 */
export function rideTurnRate(speed: number): number {
  const t = Math.min(1, Math.max(0, Math.abs(speed) / RIDE_TURN_FULL_SPEED));
  return RIDE_TURN_RATE + (RIDE_TURN_RATE_FAST - RIDE_TURN_RATE) * t;
}

/** What `shapeRideSteering` writes: the lateral input, and a yaw to add. */
export interface RideSteering {
  /** What `InputSnapshot.right` must become. Zero on a bike. */
  right: number;
  /** Radians to add to `InputSnapshot.yaw` this frame. Zero on foot. */
  yawDelta: number;
}

/**
 * Turn `A`/`D` from a strafe into a steer, for a rider, and leave a walker alone.
 *
 * **This is the whole of the feature, and it is deliberately not in `step`.**
 *
 * The obvious implementation of "a bike steers" is a second integrator: a
 * heading, a lean, a wheelbase, and a `stepBike` beside `controller.step`. That
 * is a fork, and a fork is the one thing this project's netcode cannot afford
 * -- the server would have to reproduce it exactly, `net/client.reconcile`'s
 * replay would have to run it over every un-acked input, and the first
 * disagreement between the two would show up as a rider rubber-banding at
 * 26 m/s, which is a metre of visible correction every snapshot.
 *
 * So there is no fork. `yaw` and `right` are already **client-authoritative
 * inputs** -- see `protocol.INPUT_BYTES`, which carries both -- and this shapes
 * them before they are written into the snapshot that gets sent, predicted with
 * and replayed. The server receives a rider who is simply *looking* somewhere
 * new and not strafing, runs the identical `step` it always did, and prediction
 * is exact by construction rather than by agreement. The mouse keeps steering
 * too, for free, because the mouse was always writing this same field.
 *
 * `dt` is the frame delta rather than the fixed step, on `main.ts`'s own
 * argument about the arrow keys: the look is assembled once per *frame* and
 * sampled by however many fixed steps that frame turned out to contain, so a
 * rate applied per tick would turn on the frame rate.
 */
export function shapeRideSteering(
  c: RideState,
  right: number,
  speed: number,
  dt: number,
  out: RideSteering,
): RideSteering {
  if (c.ridingBike === 0) {
    out.right = right;
    out.yawDelta = 0;
    return out;
  }
  out.right = 0;
  // Negative, because yaw increasing turns *left*: `controller.step` derives
  // forward as `(-sin yaw, -cos yaw)`, so `D` -- which is +1 here -- has to take
  // yaw down. The arrow keys in `main.ts` carry the same sign for the same
  // reason, and getting it backwards is a bike that steers into the kerb you
  // were avoiding.
  out.yawDelta = -right * rideTurnRate(speed) * dt;
  return out;
}

// --- The nudge, which is a state and not a moment --------------------------------

/**
 * The nudge itself, here rather than at the call site so the check and the HUD
 * are asserting the same string.
 */
export const RIDE_PROMPT = 'E to get off the bike first';

/**
 * The one line the HUD may say about riding, and the state that owns it.
 *
 * *"I died on bike and saw E to get off bike forever."*
 *
 * That was a real bug and it was not in the bikes at all: `main.ts` wrote this
 * string into the HUD pill with `hud.notice` on the frame a rider clicked, and
 * the **only** line in the client that took it back down again was the `E`
 * dismount branch. A player who was knocked out while riding never ran that
 * branch -- the knockout clears `ridingBike` from three files away -- so the
 * pill kept giving an instruction about a bike the player was no longer on, for
 * the rest of the session, through every respawn.
 *
 * The fix is not another clear site. Another clear site is another line that
 * has to be remembered, and the next state that ends a ride without pressing a
 * key (a disconnect, a server correction, a car) would strand it again. The fix
 * is that the pill's content is a **pure function of the riding state**,
 * evaluated every frame: there is no "set" and no "clear", there is only what is
 * true now. `hud.derived` is the channel that draws it. This is the function
 * that decides it, and it lives here rather than in `main.ts` so that
 * `verifyBikes` can assert the knockout case without a browser.
 *
 * `holdT` is a seconds-remaining hold so the line does not vanish the instant
 * the mouse button comes up; it is a *shortener*, never the thing keeping the
 * line alive. Riding is.
 */
export function ridePrompt(c: RideState, phase: string, holdT: number, message: string): string {
  // Not on a bike: there is nothing to get off. This is the clause that could
  // not stick, because it is re-asked sixty times a second.
  if (c.ridingBike === 0) return '';
  // And a body on the pavement is told nothing at all, even in the tick before
  // the sweep clears the field -- `combat.advance` clears `ridingBike` on the
  // knockout, but belt and braces is cheap and this is the exact state the bug
  // was reported from.
  if (phase === 'ko') return '';
  if (holdT <= 0) return '';
  return message;
}

// --- The tuning stall in Redfern ----------------------------------------------

/**
 * Where the 3x is unlocked, in world metres.
 *
 * **Measured against the shipped world data rather than guessed**, which is the
 * only way a coordinate in this project is ever right: the brief offered a
 * rough (-970, -2710), the tile index puts Redfern's own label node at
 * (-440.5, 2703.8) -- note the sign, since the renderer's z runs *south* -- and
 * this point was chosen by sweeping the walkable ground around it for somewhere
 * a stall could plausibly stand.
 *
 * It is 3 m off the centreline of **Redfern Street**, the suburb's main strip,
 * about 80 m east of the Pitt Street corner and a short walk from the station.
 * The ground there is flat to within 6 cm over a 3 m radius, there is no
 * building within 3.5 m in any direction, and it is dry. `checkBikes` re-asserts
 * all of that against the real files, so a world rebuild that moves the street
 * fails the check rather than leaving the stall in somebody's front room.
 */
export const TUNING_X = -364;
export const TUNING_Z = 2682;

/**
 * How close counts as arriving, metres.
 *
 * Generous compared with a powerup's 1.6, and deliberately so: this is a
 * destination rather than something collected in passing, it fires once per
 * session, and a player who has ridden across the city to find it should not
 * have to hunt for the exact paving stone. 4 m is about the footprint of the
 * stall and its awning.
 */
export const TUNING_RADIUS = 4;

/** And the vertical gate, on `MOUNT_HEIGHT`'s argument. A roof over it is not it. */
export const TUNING_HEIGHT = 3;

/**
 * Is this combatant standing in the stall?
 *
 * Takes the *feet* rather than the eye, because the height gate is about which
 * storey you are on and the eye is 1.68 m into the answer.
 */
export function inTuningZone(x: number, feetY: number, z: number, groundY: number): boolean {
  const dx = x - TUNING_X;
  const dz = z - TUNING_Z;
  if (dx * dx + dz * dz > TUNING_RADIUS * TUNING_RADIUS) return false;
  return Math.abs(feetY - groundY) < TUNING_HEIGHT;
}

// --- Where the bikes are ------------------------------------------------------

/**
 * Bumped whenever the spawn scheme changes, and mixed into every hash.
 *
 * It is what makes "deterministic per build" true rather than "deterministic
 * forever": moving a bike is a one-character change here, and every process
 * that reads the same number lays out the same city.
 */
export const BIKE_STAMP = 0x5ed1;

/**
 * One in this many tiles gets a bike.
 *
 * The order was "rare -- a find, not a fleet". The inner ring is 221 tiles, so a
 * third of them is about 74 bikes over 55 km^2: roughly one every 750 m of
 * street, which is far enough apart that finding one is an event and close
 * enough that a player who wants one can go and look. `verifyBikes` asserts the
 * count lands in 40..120 against the real index, so a pipeline stage change that
 * quadrupled the tile count would be caught here rather than by a city full of
 * bikes.
 */
export const BIKE_TILE_RARITY = 3;

/** Keep a planned point this far inside its tile, metres. See `bikePlan`. */
const TILE_INSET = 40;

/** How many hashed candidates a tile gets before it is declared unrideable. */
const PLACEMENT_TRIES = 12;

/**
 * A 32-bit mix of a string and a salt.
 *
 * FNV-1a over the key, then a final avalanche, because FNV alone leaves the low
 * bits of short similar strings correlated -- and every key here is a short
 * similar string ("-1_-6", "-1_-5"). Without the avalanche, `% 3` on the raw
 * hash selects whole *rows* of tiles, which is a city with three stripes of
 * bikes in it and none anywhere else.
 */
export function bikeHash(key: string, salt: number): number {
  let h = 0x811c9dc5 ^ (salt >>> 0);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hash as a fraction in [0, 1). */
function hashFraction(key: string, salt: number): number {
  return bikeHash(key, salt) / 4294967296;
}

/** The tile shape `bikePlan` needs, which is a subset of what `index.json` carries. */
export interface BikeTile {
  readonly key: string;
  /** `[minX, minZ, maxX, maxZ]`. World metres in both axes -- see `bikePlan`. */
  readonly bounds: readonly [number, number, number, number] | readonly number[];
}

/** One planned bike: a stable id, the tile it belongs to, and where to try first. */
export interface BikePlanEntry {
  readonly id: number;
  readonly tileKey: string;
  /** World metres, before the ground and the buildings have had their say. */
  readonly x: number;
  readonly z: number;
  /** Which way it is parked. Cosmetic, and stable so every client parks it the same way. */
  readonly yaw: number;
}

/**
 * Decide the whole city's bike set from the tile index alone.
 *
 * Ids are handed out in the index's own order starting at 1, which is what makes
 * them agree across processes: 0 is reserved for "not on a bike" in
 * `RideState.ridingBike` and for "no bike" on the wire.
 *
 * The bounds are used directly as world coordinates in both axes. That reads
 * oddly against `server/world.ts`, which offsets prisms by `bounds[1] +
 * tile_size` -- but that offset exists because the *sidecar's* local z runs
 * negative, and the two cancel: a tile's world x spans `bounds[0]..bounds[2]`
 * and its world z spans `bounds[1]..bounds[3]`. Verified against the shipped
 * index by locating Redfern's label node in the tile the suburb file agrees it
 * is in.
 */
export function bikePlan(tiles: readonly BikeTile[]): BikePlanEntry[] {
  const out: BikePlanEntry[] = [];
  let id = 1;
  for (const tile of tiles) {
    if (bikeHash(tile.key, BIKE_STAMP) % BIKE_TILE_RARITY !== 0) continue;
    const [minX, minZ, maxX, maxZ] = tile.bounds;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    // Inset so a planned point cannot land on a tile seam, where the prisms of
    // the neighbouring tile decide whether it is inside a building and a
    // streaming client may not have them yet.
    const insetX = Math.min(TILE_INSET, width * 0.3);
    const insetZ = Math.min(TILE_INSET, depth * 0.3);
    out.push({
      id: id++,
      tileKey: tile.key,
      x: minX + insetX + hashFraction(tile.key, BIKE_STAMP + 1) * (width - insetX * 2),
      z: minZ + insetZ + hashFraction(tile.key, BIKE_STAMP + 2) * (depth - insetZ * 2),
      yaw: hashFraction(tile.key, BIKE_STAMP + 3) * Math.PI * 2,
    });
  }
  return out;
}

/** What `placeBike` needs to know about the world. A subset of `combat.CombatWorld`. */
export interface BikeGround {
  /** The ground under a point, or a non-finite value where the tile is not loaded. */
  groundHeight(x: number, z: number, feetY: number): number;
  /** True if a bike-sized circle at this point is clear of every building. */
  clear(x: number, z: number, groundY: number): boolean;
  /** The water surface over a point, or a non-finite value where there is none. */
  waterSurface?(x: number, z: number): number;
}

/** A bike standing in the world. */
export interface BikeSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Put a planned bike on the ground, out of any building, or return null.
 *
 * The search is a deterministic ring rather than a random walk, so two processes
 * that both reach this code place the bike identically: the same hash that
 * chose the point chooses the sequence of nudges away from it.
 *
 * Returning null is a real outcome and not a failure. A tile that is all
 * building, all water or all harbour has nowhere to park, and a bike forced into
 * one anyway would be a bike inside a wall -- visible, unmountable, and the kind
 * of thing that reads as the feature being broken.
 */
export function placeBike(plan: BikePlanEntry, world: BikeGround): BikeSpot | null {
  for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
    // Attempt 0 is the planned point itself; after that, a widening deterministic
    // spiral. The angle comes off the hash so the spiral is not always the same
    // shape, which would bias every nudged bike in the city the same direction.
    const radius = attempt === 0 ? 0 : 3 + attempt * 2.5;
    const angle =
      hashFraction(plan.tileKey, BIKE_STAMP + 16 + attempt) * Math.PI * 2 + attempt * 2.399963;
    const x = plan.x + Math.cos(angle) * radius;
    const z = plan.z + Math.sin(angle) * radius;
    // `-Infinity` for the feet, so the query answers "the terrain here" rather
    // than "the roof I am standing on": a bike is parked on the street, and a
    // planned point over a warehouse must not put one on its roof.
    const y = world.groundHeight(x, z, -Infinity);
    if (!Number.isFinite(y)) continue;
    if (!world.clear(x, z, y)) continue;
    const surface = world.waterSurface?.(x, z) ?? Number.NaN;
    // Parked in the harbour. `NaN` compares false, which is the dry case.
    if (Number.isFinite(surface) && surface > y + 0.15) continue;
    return { x, y, z, yaw: plan.yaw };
  }
  return null;
}

// --- The world's bikes, and who is on them ------------------------------------

/** One bike, as both ends hold it. */
export interface Bike {
  readonly id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The combatant id riding it, or 0 for a bike standing on its kickstand. */
  rider: number;
}

/**
 * Every bike in the world, and the only thing allowed to change who is on one.
 *
 * The server owns an instance of this and is authoritative; a connected client
 * owns one too and treats it as a mirror that the server's `BIKES` messages
 * correct. Offline the client's copy *is* the authority, which is what makes
 * `?offline` a real test of the feature rather than a different implementation
 * of it.
 *
 * Claims are resolved here rather than at the two call sites for the reason the
 * whole file exists: "can two players take the same bike" must have exactly one
 * answer, and `claim` returning false is it.
 */
export class BikeField {
  private readonly byId = new Map<number, Bike>();
  /** Rebuilt lazily; a flat list is what the renderer and the tick both want. */
  private flat: Bike[] = [];
  private dirty = true;

  /** Put a bike in the world, or move one already there. Returns it. */
  adopt(id: number, spot: BikeSpot): Bike {
    const existing = this.byId.get(id);
    if (existing) {
      existing.x = spot.x;
      existing.y = spot.y;
      existing.z = spot.z;
      existing.yaw = spot.yaw;
      return existing;
    }
    const bike: Bike = { id, x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, rider: 0 };
    this.byId.set(id, bike);
    this.dirty = true;
    return bike;
  }

  get(id: number): Bike | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Every bike, in id order. Owned by this object and reused -- do not retain it. */
  all(): readonly Bike[] {
    if (this.dirty) {
      this.flat = [...this.byId.values()].sort((a, b) => a.id - b.id);
      this.dirty = false;
    }
    return this.flat;
  }

  /**
   * The nearest free bike a combatant at this point could mount, or null.
   *
   * Ties break on id rather than on the float distance, which is a netcode
   * decision and not a gameplay one: two bikes at the same range have to resolve
   * the same way on the client predicting the mount and on the server granting
   * it, and an id comparison is a rule both can state where "the nearer one" is
   * a float comparison that two builds can disagree about.
   */
  nearestFree(x: number, feetY: number, z: number): Bike | null {
    let best: Bike | null = null;
    let bestD2 = MOUNT_RADIUS * MOUNT_RADIUS;
    for (const bike of this.all()) {
      if (bike.rider !== 0) continue;
      if (Math.abs(bike.y - feetY) > MOUNT_HEIGHT) continue;
      const dx = bike.x - x;
      const dz = bike.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD2) continue;
      // Strictly nearer, so an equal distance keeps the lower id already held.
      if (best !== null && d2 >= bestD2) continue;
      best = bike;
      bestD2 = d2;
    }
    return best;
  }

  /**
   * Give a bike to a rider. False if somebody already has it.
   *
   * The one place a claim is decided. Everything else -- the button edge, the
   * range test, the HUD nudge -- is upstream of this line.
   */
  claim(id: number, rider: number): boolean {
    const bike = this.byId.get(id);
    if (!bike) return false;
    if (bike.rider !== 0 && bike.rider !== rider) return false;
    bike.rider = rider;
    return true;
  }

  /** Park a bike where its rider left it. */
  release(id: number, x: number, y: number, z: number, yaw: number): void {
    const bike = this.byId.get(id);
    if (!bike) return;
    bike.rider = 0;
    bike.x = x;
    bike.y = y;
    bike.z = z;
    bike.yaw = yaw;
  }

  /**
   * Reconcile every bike against who is actually riding, after the combatants
   * have moved. Returns the bikes that changed, for the caller to broadcast.
   *
   * **This is the whole of "you get knocked off"**, and doing it as a sweep
   * rather than as an event is what makes it total. `combat.applyHit` sets a
   * batted rider's `ridingBike` to 0 and knows nothing about this class; a
   * player who disconnects mid-ride simply stops being in the list; a player who
   * is knocked out has the same field cleared by the same line. All three are
   * "the bike's rider is no longer riding this bike", all three drop the bike
   * where the body is, and none of them needed a message of their own.
   */
  follow(riders: Iterable<RiderView>, changed: Bike[] = []): Bike[] {
    changed.length = 0;
    const seen = new Map<number, RiderView>();
    for (const r of riders) if (r.ridingBike !== 0) seen.set(r.ridingBike, r);

    for (const bike of this.all()) {
      if (bike.rider === 0) continue;
      const rider = seen.get(bike.id);
      if (rider && rider.id === bike.rider) {
        // Still aboard: the bike is wherever the body is. Its yaw is the rider's,
        // so a parked bike remembers the direction it was last travelling.
        bike.x = rider.x;
        bike.y = rider.feetY;
        bike.z = rider.z;
        bike.yaw = rider.yaw;
        continue;
      }
      // Dropped: batted off, knocked out, disconnected, or dismounted. The
      // position is whatever the last `follow` left, which is where the rider
      // was, which is where the bike should be.
      bike.rider = 0;
      changed.push(bike);
    }
    return changed;
  }
}

/** What `BikeField.follow` needs from a combatant. */
export interface RiderView {
  readonly id: number;
  readonly ridingBike: number;
  readonly x: number;
  readonly feetY: number;
  readonly z: number;
  readonly yaw: number;
}

// --- The self-check -----------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 * Every failure below is silent in this project's sense: it renders, it does not
 * throw, and it reads as a tuning decision somebody made on purpose.
 *
 *   - **A bike that is not two coffee runs.** The multiplier is derived, so the
 *     only way to know it survived a refactor is to measure the resulting speed
 *     through the real integrator.
 *   - **A plan that is not stable.** Two calls returning different ids is a
 *     world where your bike is somebody else's bike, and it looks exactly like
 *     lag.
 *   - **A claim that both players win.** Two riders on one bike is two people
 *     moving at 26 m/s with one mesh between them.
 *   - **A rarity that quietly became a fleet.** A tile-count change upstream
 *     turns "a find" into a bike on every corner with nothing in this file
 *     edited.
 */
export function verifyBikes(): string[] {
  const failures: string[] = [];

  // --- The speeds, measured rather than quoted. A flat world with no buildings,
  // stepped to terminal velocity, exactly as `verifyPowerups` measures its own.
  const measure = (scale: number | undefined): number => {
    const state = createBikeProbeState();
    const input: InputSnapshot = {
      forward: 1, right: 0, jump: false, sprint: true, yaw: 0, pitch: 0, speedScale: scale,
    };
    // 4 s at 60 Hz. The controller's acceleration is 48 m/s^2, so even the tuned
    // top speed is reached in under a second; the rest is proving it is a
    // plateau and not a ramp.
    for (let i = 0; i < 240; i++) stepProbe(state, input);
    return Math.hypot(state.vx, state.vz);
  };

  const sprint = measure(1);
  const coffee = measure(FLAT_WHITE_SPEED);
  const bike = measure(bikeSpeedScale(false));
  const tuned = measure(bikeSpeedScale(true));

  if (Math.abs(bike - coffee * BIKE_COFFEES) > 0.05) {
    failures.push(
      `A bike tops out at ${bike.toFixed(2)} m/s against a coffee run's ${coffee.toFixed(2)}; ` +
        `it must be ${BIKE_COFFEES}x that (${(coffee * BIKE_COFFEES).toFixed(2)}).`,
    );
  }
  if (Math.abs(tuned - coffee * BIKE_TUNED_COFFEES) > 0.05) {
    failures.push(
      `A tuned bike tops out at ${tuned.toFixed(2)} m/s against a coffee run's ${coffee.toFixed(2)}; ` +
        `it must be ${BIKE_TUNED_COFFEES}x that (${(coffee * BIKE_TUNED_COFFEES).toFixed(2)}).`,
    );
  }
  if (!(tuned > bike && bike > coffee && coffee > sprint)) {
    failures.push(
      `The four speeds are not ordered: sprint ${sprint.toFixed(1)}, coffee ${coffee.toFixed(1)}, ` +
        `bike ${bike.toFixed(1)}, tuned ${tuned.toFixed(1)} m/s.`,
    );
  }

  // --- `shapeRideInput` composes rather than replaces, and leaves a walker alone.
  {
    const onFoot: InputSnapshot = { forward: 1, right: 1, jump: false, sprint: false, yaw: 0, pitch: 0 };
    shapeRideInput({ ridingBike: 0, bikeTuned: false }, onFoot);
    if (onFoot.sprint || onFoot.right !== 1 || onFoot.speedScale !== undefined) {
      failures.push('shapeRideInput changed the input of somebody who is not on a bike.');
    }

    const riding: InputSnapshot = {
      forward: 1, right: 1, jump: false, sprint: false, yaw: 0, pitch: 0,
      speedScale: FLAT_WHITE_SPEED, jumpScale: 2,
    };
    shapeRideInput({ ridingBike: 7, bikeTuned: false }, riding);
    if (!riding.sprint) failures.push('A rider was not put into a sprint, so the multiplier applies to the walk speed.');
    if (Math.abs((riding.speedScale ?? 0) - FLAT_WHITE_SPEED * bikeSpeedScale(false)) > 1e-9) {
      failures.push(
        `A Flat White on a bike gave ${riding.speedScale}; the two multipliers must compose to ` +
          `${FLAT_WHITE_SPEED * bikeSpeedScale(false)}.`,
      );
    }
    if (Math.abs((riding.jumpScale ?? 0) - 2 * RIDE_JUMP) > 1e-9) {
      failures.push(`A rider's jump scale was ${riding.jumpScale}, not the composed ${2 * RIDE_JUMP}.`);
    }
    if (Math.abs(riding.right - RIDE_STRAFE) > 1e-9) {
      failures.push(`A rider's strafe was ${riding.right}, not ${RIDE_STRAFE}. A bicycle does not sidestep.`);
    }
    if (riding.forward !== 1) {
      failures.push(`A rider's throttle was scaled to ${riding.forward}; only the reverse half is damped.`);
    }

    // The brake, which is the other half of `RIDE_REVERSE` and the one that is
    // easy to write as an unconditional multiply and never notice.
    const reversing: InputSnapshot = { forward: -1, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
    shapeRideInput({ ridingBike: 7, bikeTuned: false }, reversing);
    if (Math.abs(reversing.forward + RIDE_REVERSE) > 1e-9) {
      failures.push(`A rider's reverse was ${reversing.forward}, not ${-RIDE_REVERSE}.`);
    }
  }

  // --- The steering remap: A and D turn the bars and move nobody sideways.
  //
  // The user's report was "I can strafe while riding but should instead be able
  // to turn", and the failure this catches is the half-done version of the fix:
  // a yaw that is applied *as well as* the strafe, which reads as a bike that
  // turns and crabs at the same time.
  {
    const out: RideSteering = { right: 0, yawDelta: 0 };

    // On foot, untouched. `right` passes through and no yaw is invented, or
    // every player in the game turns when they sidestep.
    shapeRideSteering({ ridingBike: 0, bikeTuned: false }, 1, 8.2, 1 / 60, out);
    if (out.right !== 1 || out.yawDelta !== 0) {
      failures.push(`A walker's A/D became right=${out.right}, yaw ${out.yawDelta}; on foot it is a strafe.`);
    }

    // Riding: no lateral input at all, and a yaw that goes the way the key does.
    shapeRideSteering({ ridingBike: 3, bikeTuned: false }, 1, 0, 1 / 60, out);
    if (out.right !== 0) failures.push(`A rider holding D still had right=${out.right}; the strafe must be gone entirely.`);
    if (!(out.yawDelta < 0)) {
      failures.push(
        `Holding D on a bike changed yaw by ${out.yawDelta}; yaw increasing turns left, so D must take it down.`,
      );
    }
    const dLeft = { right: 0, yawDelta: 0 };
    shapeRideSteering({ ridingBike: 3, bikeTuned: false }, -1, 0, 1 / 60, dLeft);
    if (Math.abs(dLeft.yawDelta + out.yawDelta) > 1e-12) {
      failures.push(`A and D are not mirror images: ${dLeft.yawDelta} against ${out.yawDelta}.`);
    }
    // Held for a second at a standstill, which is the rate as stated.
    if (Math.abs(out.yawDelta * 60 + RIDE_TURN_RATE) > 1e-9) {
      failures.push(
        `A second of held D at rest turned ${(-out.yawDelta * 60).toFixed(3)} rad, not ${RIDE_TURN_RATE}.`,
      );
    }

    // And it slows down with speed rather than staying twitchy at 142 km/h.
    const atRest = rideTurnRate(0);
    const atBike = rideTurnRate(26.2);
    const atTop = rideTurnRate(39.4);
    if (!(atRest > atBike && atBike > atTop)) {
      failures.push(
        `The turn rate is not falling with speed: ${atRest.toFixed(2)}, ${atBike.toFixed(2)}, ${atTop.toFixed(2)} rad/s.`,
      );
    }
    if (atTop < RIDE_TURN_RATE_FAST - 1e-6 || atTop > RIDE_TURN_RATE) {
      failures.push(`At the tuned top speed the rate is ${atTop.toFixed(2)} rad/s, outside its own two constants.`);
    }
    // A tuned bike must not be off the end of the ramp, or the fastest state in
    // the game is the one the curve was never fitted to. 8.2 is
    // `controller.SPRINT_SPEED`, which this file may not import.
    const topSpeed = 8.2 * bikeSpeedScale(true);
    if (topSpeed > RIDE_TURN_FULL_SPEED + 1e-6) {
      failures.push(
        `A tuned bike does ${topSpeed.toFixed(1)} m/s against a steering ramp that ends at ` +
          `${RIDE_TURN_FULL_SPEED}; the ramp has to cover the top speed.`,
      );
    }
    // The turn radius stays in one order of magnitude across the range, which is
    // the property the ramp exists to hold. Below 5 m at a standstill is a
    // pirouette; over 60 m at the top is a bike that will not corner.
    if (26.2 / atBike > 60 || 39.4 / atTop > 60) {
      failures.push(
        `The turn radius is ${(26.2 / atBike).toFixed(0)} m on a bike and ${(39.4 / atTop).toFixed(0)} m tuned; ` +
          `either is wider than a city block.`,
      );
    }
  }

  // --- The nudge that stuck: it is a function of the state, not a thing set.
  //
  // Every clause below is the reported bug at a different stage. The one that
  // matters is the knockout: the pill said "E to get off the bike first" for the
  // rest of the session because nothing ran the line that took it down.
  {
    const message = RIDE_PROMPT;
    const riding: RideState = { ridingBike: 4, bikeTuned: false };
    const onFoot: RideState = { ridingBike: 0, bikeTuned: false };
    if (ridePrompt(riding, 'idle', 1.5, message) !== message) {
      failures.push('A rider who just clicked was not told to get off the bike first.');
    }
    if (ridePrompt(onFoot, 'idle', 1.5, message) !== '') {
      failures.push('Somebody on foot was told to get off a bike. The prompt is not derived from the ride.');
    }
    if (ridePrompt(riding, 'ko', 1.5, message) !== '') {
      failures.push(
        'A knocked-out rider was still being told to press E. This is the reported bug: the prompt has to ' +
          'come down because the state changed, not because somebody remembered to clear it.',
      );
    }
    if (ridePrompt(riding, 'idle', 0, message) !== '') {
      failures.push('The nudge outlived its own hold timer.');
    }
    // And the whole point: the *only* way to keep it on screen is to still be
    // riding. Nothing else in the client can pin it.
    for (const phase of ['idle', 'flinch', 'windup', 'active', 'recovery', 'ko']) {
      if (ridePrompt(onFoot, phase, 99, message) !== '') {
        failures.push(`The prompt survived being on foot in phase "${phase}".`);
      }
    }
  }

  // --- The plan is stable, dense enough to be findable and sparse enough to be rare.
  {
    const tiles: BikeTile[] = [];
    for (let tx = -8; tx < 8; tx++) {
      for (let tz = -8; tz < 8; tz++) {
        tiles.push({ key: `${tx}_${tz}`, bounds: [tx * 500, tz * 500, tx * 500 + 500, tz * 500 + 500] });
      }
    }
    const a = bikePlan(tiles);
    const b = bikePlan(tiles);
    if (a.length !== b.length || a.some((e, i) => e.id !== b[i].id || e.x !== b[i].x || e.z !== b[i].z)) {
      failures.push('bikePlan is not deterministic: two calls over the same tiles disagreed.');
    }
    const share = a.length / tiles.length;
    if (share < 0.2 || share > 0.45) {
      failures.push(
        `${a.length} of ${tiles.length} tiles got a bike (${(share * 100).toFixed(0)}%); ` +
          `the rarity is meant to be about 1 in ${BIKE_TILE_RARITY}.`,
      );
    }
    // Ids are dense from 1, which is what the wire's u16 and the "0 means no
    // bike" convention both assume.
    if (a.some((e, i) => e.id !== i + 1)) failures.push('bikePlan ids are not 1..n in index order.');
    // And a planned point is inside its own tile, which is what the inset is for.
    for (const e of a) {
      const [tx, tz] = e.tileKey.split('_').map(Number);
      if (e.x < tx * 500 || e.x > tx * 500 + 500 || e.z < tz * 500 || e.z > tz * 500 + 500) {
        failures.push(`Bike ${e.id} was planned at (${e.x.toFixed(0)}, ${e.z.toFixed(0)}), outside tile ${e.tileKey}.`);
        break;
      }
    }
    // The hash spreads. A `% 3` over correlated low bits selects whole rows,
    // which is a city with three stripes of bikes and none anywhere else -- so
    // the chosen tiles must not all share a coordinate.
    const rows = new Set(a.map((e) => e.tileKey.split('_')[1]));
    if (rows.size < 8) {
      failures.push(`The chosen tiles fall in only ${rows.size} rows; the tile hash is not mixing.`);
    }
  }

  // --- Placement rejects a building and finds the pavement beside it.
  {
    const plan: BikePlanEntry = { id: 1, tileKey: '0_0', x: 0, z: 0, yaw: 0 };
    const solid: BikeGround = { groundHeight: () => 0, clear: () => false };
    if (placeBike(plan, solid) !== null) {
      failures.push('A bike was placed in a tile where every point is inside a building.');
    }
    // Clear everywhere except a 6 m disc over the planned point: the spiral has
    // to walk out of it.
    const donut: BikeGround = {
      groundHeight: () => 12,
      clear: (x, z) => Math.hypot(x, z) > 6,
    };
    const spot = placeBike(plan, donut);
    if (spot === null) failures.push('The placement spiral did not escape a 6 m obstruction.');
    else if (Math.hypot(spot.x, spot.z) <= 6) failures.push('placeBike returned a point inside the obstruction.');
    else if (spot.y !== 12) failures.push(`placeBike put the bike at y=${spot.y}, not on the ground at 12.`);
    // And the harbour is not a car park.
    const wet: BikeGround = { groundHeight: () => -3, clear: () => true, waterSurface: () => 0 };
    if (placeBike(plan, wet) !== null) failures.push('A bike was parked under three metres of water.');
  }

  // --- One bike, two claimants, one rider.
  {
    const field = new BikeField();
    field.adopt(1, { x: 0, y: 0, z: 0, yaw: 0 });
    if (!field.claim(1, 5)) failures.push('The first claim on a free bike was refused.');
    if (field.claim(1, 6)) failures.push('Two combatants both claimed bike 1. A claim must resolve to one rider.');
    if (field.get(1)?.rider !== 5) failures.push(`Bike 1 ended up with rider ${field.get(1)?.rider}, not 5.`);
    // Re-claiming your own is not a conflict; it is the mount button repeating.
    if (!field.claim(1, 5)) failures.push('A rider could not re-claim the bike they are already on.');

    // Dropped where the body is, not where it was picked up.
    field.release(1, 40, 2, -13, 1.5);
    const dropped = field.get(1);
    if (!dropped || dropped.rider !== 0 || dropped.x !== 40 || dropped.z !== -13) {
      failures.push(`A released bike is at (${dropped?.x}, ${dropped?.z}) with rider ${dropped?.rider}.`);
    }
    // And it is now claimable by the person who knocked you off it.
    if (!field.claim(1, 6)) failures.push('A dropped bike could not be claimed by anybody else.');
  }

  // --- `follow` carries a bike with its rider and drops it when they stop riding.
  {
    const field = new BikeField();
    field.adopt(1, { x: 0, y: 0, z: 0, yaw: 0 });
    field.adopt(2, { x: 100, y: 0, z: 0, yaw: 0 });
    field.claim(1, 5);
    const rider = { id: 5, ridingBike: 1, x: 10, feetY: 3, z: -4, yaw: 0.5 };
    field.follow([rider]);
    const carried = field.get(1);
    if (!carried || carried.x !== 10 || carried.y !== 3 || carried.z !== -4) {
      failures.push(`A ridden bike did not follow its rider; it is at (${carried?.x}, ${carried?.y}, ${carried?.z}).`);
    }
    if (field.get(2)?.x !== 100) failures.push('A parked bike moved when somebody else rode past.');

    // Batted off: `applyHit` clears the field, and the sweep drops the bike here.
    rider.ridingBike = 0;
    const changed = field.follow([rider]);
    if (changed.length !== 1 || changed[0].id !== 1) {
      failures.push(`Knocking a rider off reported ${changed.length} changed bikes, not 1.`);
    }
    if (field.get(1)?.rider !== 0) failures.push('A knocked-off rider is still holding their bike.');
    if (field.get(1)?.x !== 10) failures.push('A bike dropped by a knockback did not stay where the rider was.');

    // And a rider who simply vanished -- a disconnect -- drops it too.
    field.claim(1, 5);
    field.follow([]);
    if (field.get(1)?.rider !== 0) failures.push('A disconnected rider kept their bike forever.');
  }

  // --- Mount, knockout, respawn: the sequence the bug report describes.
  //
  // The state machine end to end, over the real `BikeField` and the real
  // `ridePrompt`, with the combatant reduced to the four fields either of them
  // reads. What it asserts is that a knockout leaves **no trace of the ride**:
  // the bike is on the footpath where the body fell, its rider is nobody, the
  // player is on foot, and the HUD has nothing to say. `checkBikes` runs the
  // same sequence through the real server and the real wire; this runs it at
  // boot, in the browser, in a millisecond.
  {
    const message = RIDE_PROMPT;
    const field = new BikeField();
    field.adopt(9, { x: 200, y: 5, z: -300, yaw: 0 });
    const player = { id: 3, ridingBike: 0, bikeTuned: false, phase: 'idle', x: 200, feetY: 5, z: -300, yaw: 0 };

    // 1. Mount, and ride 40 m up the street.
    if (!field.claim(9, player.id)) failures.push('The probe could not mount a free bike.');
    player.ridingBike = 9;
    player.x = 240;
    player.z = -300;
    field.follow([player]);
    if (field.get(9)?.x !== 240) failures.push('The bike did not follow its rider up the street.');
    if (ridePrompt(player, player.phase, 1.5, message) !== message) {
      failures.push('A rider who clicked mid-ride was not nudged.');
    }

    // 2. Knocked out. `combat.advance` and `combat.applyHit` both clear the
    // field -- this is that clear, and nothing else about the knockout.
    player.phase = 'ko';
    player.ridingBike = 0;
    const dropped = field.follow([player]);
    if (dropped.length !== 1 || dropped[0].id !== 9) {
      failures.push(`The knockout reported ${dropped.length} dropped bikes, not 1. Nobody would be told.`);
    }
    if (field.get(9)?.rider !== 0) failures.push('A knocked-out player is still holding their bike.');
    if (field.get(9)?.x !== 240) {
      failures.push(`The bike was left at x=${field.get(9)?.x}, not at the death spot (240).`);
    }
    if (ridePrompt(player, player.phase, 1.5, message) !== '') {
      failures.push('The HUD still said "E to get off the bike" over a body on the pavement.');
    }

    // 3. Respawned 30 m away, on foot, with the bike still where it was left.
    player.phase = 'idle';
    player.x = 213;
    player.z = -276;
    field.follow([player]);
    if (player.ridingBike !== 0) failures.push('The respawned player came back on a bike.');
    if (field.get(9)?.x !== 240 || field.get(9)?.z !== -300) {
      failures.push('The bike teleported to the respawn point instead of staying where the rider fell.');
    }
    if (ridePrompt(player, player.phase, 99, message) !== '') {
      failures.push('The prompt came back with the player. It is meant to be a function of the ride.');
    }

    // 4. And the dropped bike is a bike again: somebody else can take it.
    if (!field.claim(9, 12)) failures.push('The bike dropped by a knockout could not be claimed by anybody.');
  }

  // --- The tuning zone is a place, not everywhere.
  {
    const ground = 0;
    if (!inTuningZone(TUNING_X, 0, TUNING_Z, ground)) failures.push('The tuning stall does not contain its own centre.');
    if (!inTuningZone(TUNING_X + TUNING_RADIUS - 0.1, 0, TUNING_Z, ground)) {
      failures.push('The tuning stall does not reach its own radius.');
    }
    if (inTuningZone(TUNING_X + TUNING_RADIUS + 1, 0, TUNING_Z, ground)) {
      failures.push('The tuning stall extends past its radius.');
    }
    // A player on a roof above it has not arrived.
    if (inTuningZone(TUNING_X, 20, TUNING_Z, ground)) {
      failures.push('The tuning stall unlocked somebody standing 20 m above it.');
    }
    // And it is in Redfern rather than at the origin, which is the mistake a
    // half-finished coordinate makes.
    if (Math.hypot(TUNING_X, TUNING_Z) < 100) {
      failures.push('The tuning stall is at the ENU origin; it is meant to be in Redfern.');
    }
  }

  return failures;
}

/**
 * A standing player on flat ground, for the speed measurements above.
 *
 * Deliberately a local three-line integrator rather than `controller.step`,
 * because `step` needs a `Vector3` and this file imports nothing from three --
 * the same constraint every module under `server/` works under. It is the same
 * *arithmetic* as `step`'s horizontal half, which is all these measurements
 * read, and `verifyPowerups` already asserts the real integrator honours
 * `speedScale`; what is being measured here is the multiplier, not the physics.
 */
interface ProbeState {
  vx: number;
  vz: number;
}

const PROBE_SPRINT = 8.2;
const PROBE_ACCELERATION = 48;
const PROBE_DT = 1 / 60;

function createBikeProbeState(): ProbeState {
  return { vx: 0, vz: 0 };
}

function stepProbe(state: ProbeState, input: InputSnapshot): void {
  const target = PROBE_SPRINT * (input.speedScale ?? 1) * Math.min(Math.abs(input.forward), 1);
  // Yaw 0 faces -Z, exactly as `controller.step` derives it.
  const wishZ = -target;
  const dvz = wishZ - state.vz;
  const dvx = 0 - state.vx;
  const len = Math.hypot(dvx, dvz);
  if (len > 1e-6) {
    const scale = Math.min(1, (PROBE_ACCELERATION * PROBE_DT) / len);
    state.vx += dvx * scale;
    state.vz += dvz * scale;
  }
}
