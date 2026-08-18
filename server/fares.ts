/**
 * SydRide: one small state machine per online driver, and where a kerb is.
 *
 * Lifted out of `server/sim.ts` rather than written inside it, and the reason
 * is the same one `server/rewind.ts` and `server/aoi.ts` were lifted for: the
 * simulation is 2,700 lines that six people are editing at once, and a feature
 * that is eleven branches of a state machine plus a spatial search is a feature
 * that should be one file with one self-check. What `sim.ts` gains is four call
 * sites; what this gains is being testable with no city loaded.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE: O(online drivers), and allocation-free in the tick
 *
 * The box is 1 vCPU. A fare is a **record on the participant** that `stepFare`
 * advances by one fixed step, and the whole per-tick cost of an active fare is
 * four subtractions and two squared distances -- no allocation, no search, no
 * iteration over anything. The only expensive thing this file does is
 * `pickKerbPoint`, which runs **once per offer** (a few times a minute across
 * a whole room) and is bounded by the pedestrian field's broadphase.
 *
 * A driver who is not online costs one boolean test.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PICKUP IS A FOOTPATH POINT AND NOT A ROAD POINT
 *
 * A fare's pickup is somewhere a *passenger* is standing, which is a footpath,
 * and `PedestrianField`'s bands are exactly the footpath network -- the same
 * one the ambient crowd walks, the police lattice is laid on and the drunks
 * stand outside pubs on. `TrafficField`'s lane routes are the *carriageway*,
 * which is where the car goes, and a pickup point in the middle of one would be
 * a marker the driver has to stop on top of rather than beside.
 *
 * They are the same place to within a footpath's width -- a band is offset to
 * the kerb line by the pipeline -- so stopping within `PICKUP_STOP_M` (5 m) of
 * a band vertex is stopping at the kerb outside it, which is what a pickup is.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SELECTION IS HASHED RATHER THAN RANDOM
 *
 * `Math.random` would be fine here -- the pickup is chosen on the server and
 * sent, so no client re-derives it. It is still not used, for one reason: a
 * check that drives a hundred fares through this file has to be able to get the
 * same hundred fares twice, or a failure is not reproducible. `game/traffic.ts`
 * made this call for the whole car fleet and this is the same call at a much
 * smaller scale. The seed is `(playerId, tick)`, so two drivers on one tick get
 * different fares and one driver never gets the same fare twice running.
 */

import {
  ABANDON_SECONDS,
  DROPOFF_STOP_M,
  FARE_COOLDOWN_SECONDS,
  PICKUP_MAX_M,
  PICKUP_MIN_M,
  PICKUP_STOP_M,
  STOPPED_SPEED,
  STOP_SECONDS,
  TRIP_MAX_M,
  TRIP_MIN_M,
  farePayout,
  type FareState,
} from '../client/src/game/cash.ts';
import type { PedBand } from '../client/src/game/pedestrians.ts';
// WORKSTREAM W (talent effects): the fare multipliers. Both are the identity
// with no `TeamLookup` installed. See `client/src/game/teamfx.ts`.
import { fxFareRadiusM, fxFareScale, fxFareTip } from '../client/src/game/teamfx.ts';

/**
 * The one thing this file wants from the footpath network.
 *
 * A structural interface rather than `PedestrianField` itself, and the reason
 * is the self-check at the bottom: `PedestrianField.adopt` takes a `TileLanes`
 * out of the pipeline and runs `buildBands` over it, so a check that used the
 * real class would need a built world to test a state machine that has nothing
 * to do with one. `PedestrianField` satisfies this interface exactly as it
 * stands -- see its `near`, whose contract this copies verbatim, including that
 * it appends into `out` and returns it.
 */
export interface BandSource {
  near(x: number, z: number, radius: number, out: PedBand[]): PedBand[];
}

/**
 * How long the "offered" ping sits on screen before the meter starts.
 *
 * Two seconds, and it is the one state in this machine that does nothing except
 * be visible. Without it, a fare goes from nothing to a pickup marker 600 m
 * away in one frame and the player's first knowledge of the job is a HUD line
 * that has already started counting -- so the state exists to give the offer a
 * *moment*, in the same way `combat`'s windup exists to give the swing one.
 *
 * There is deliberately **no accept or decline**. The brief's flow is "go
 * online and the server offers you fares", and an accept button would be a
 * second thing to press while driving. Declining is getting out of the car.
 */
export const OFFER_SECONDS = 2;

/** One driver's job, or the absence of one. Reused; never reallocated. */
export interface FareJob {
  state: FareState;
  /** Is this driver on shift? Independent of whether a fare is running. */
  online: boolean;
  /** Pickup and dropoff, world metres. Meaningless while `state` is `none`. */
  px: number;
  pz: number;
  dx: number;
  dz: number;
  /** Straight-line pickup-to-dropoff distance, metres. What the fare is paid on. */
  tripM: number;
  /** `Date.now()` the offer was made, and the moment the passenger boarded. */
  offeredMs: number;
  boardedMs: number;
  /** What the trip will pay if it finishes now. Recomputed on the paying tick. */
  payout: number;
  /** Seconds held still inside the stop radius. Resets the moment you move. */
  stopT: number;
  /** Seconds spent out of a car with a fare running. See `ABANDON_SECONDS`. */
  abandonT: number;
  /** Seconds until the next offer. */
  cooldownT: number;
  /** Has this driver knocked anybody down since the passenger boarded? */
  rough: boolean;
  /** Bumped on every change worth sending. `Room` compares it. */
  version: number;
  /** What the passenger said last, for the HUD. Consumed by the reader. */
  line: string;
}

export function createFare(): FareJob {
  return {
    state: 'none',
    online: false,
    px: 0, pz: 0, dx: 0, dz: 0,
    tripM: 0,
    offeredMs: 0,
    boardedMs: 0,
    payout: 0,
    stopT: 0,
    abandonT: 0,
    cooldownT: 0,
    rough: false,
    version: 0,
    line: '',
  };
}

/** Everything one step of one fare needs to know. Built by the caller, reused. */
export interface FareContext {
  /** The driver, for the seed and for nothing else. */
  playerId: number;
  tick: number;
  dt: number;
  nowMs: number;
  /** Where the driver's body is. The car's pose when driving, theirs when not. */
  x: number;
  z: number;
  /** Plan speed, m/s. What "stopped" is measured against. */
  speed: number;
  /** Is this player at the wheel of something? `DrivingLookup.carOf() !== 0`. */
  inCar: boolean;
  /** Knocked out. Cancels any running fare outright. */
  ko: boolean;
  /** The footpath network to hang pickups off. `world.peds` in the server. */
  peds: BandSource;
  /** Scratch for the band query. Owned by the caller, reused every call. */
  bands: PedBand[];
  /**
   * --- WORKSTREAM W: the day/night phase, `sky/cycle.cyclePhase(clockMs)`.
   *
   * `Surge` pays +40% between sunset and sunrise and `Tradie Rates` +25% from
   * sunrise to 15:00, so the payout needs to know what time it is. It arrives on
   * the context rather than being computed here because this file has no clock
   * of its own -- `nowMs` beside it is wall time and the in-game hour is the
   * server's `clockMs`, which only `Simulation` holds.
   *
   * Optional and defaulting to 0.5 -- the middle of the afternoon, which is
   * inside neither window -- so `verifyFares` and every existing caller keep
   * paying exactly what they paid.
   */
  phase?: number;
}

/** What a step did that the caller has to act on. */
export interface FareStepResult {
  /** Dollars to credit, or 0. */
  paid: number;
  /** A one-line HUD notice, or empty. Lower case, `factions.REASON_TEXT`'s voice. */
  notice: string;
  /** Did anything change that a `FARE` frame should carry? */
  changed: boolean;
}

const result: FareStepResult = { paid: 0, notice: '', changed: false };

/**
 * Advance one driver's fare by one fixed step.
 *
 * Returns a **shared, reused** record -- read it before the next call, which is
 * the contract `TickOutput` and `Simulation.roster` already have and is what
 * keeps this allocation-free in a 60 Hz loop over every player in the room.
 *
 * The order inside is deliberate and is the same order `Simulation.step` uses:
 * the things that *cancel* are tested before the things that *progress*, so a
 * driver who is knocked out on the tick they reach the dropoff is cancelled
 * rather than paid. A knockout is the more specific event and the player can
 * see it happen.
 */
export function stepFare(job: FareJob, ctx: FareContext): FareStepResult {
  result.paid = 0;
  result.notice = '';
  result.changed = false;

  if (job.cooldownT > 0) {
    job.cooldownT -= ctx.dt;
    if (job.cooldownT <= 0) {
      job.cooldownT = 0;
      if (job.state === 'done') {
        job.state = 'none';
        job.version++;
        result.changed = true;
      }
    }
  }

  // --- Off shift. A fare running when the player clocks off is cancelled, and
  // that is stated rather than left to fall out: "go offline" has to be a way
  // to get rid of a fare you do not want, or the only way to decline one is to
  // abandon the car for twenty seconds.
  if (!job.online) {
    if (job.state !== 'none') {
      reset(job);
      result.notice = 'shift over';
      result.changed = true;
    }
    return result;
  }

  const running = job.state === 'offered' || job.state === 'toPickup' || job.state === 'toDropoff';

  // --- The two cancellations, before anything can progress.
  if (running) {
    if (ctx.ko) {
      reset(job);
      job.cooldownT = FARE_COOLDOWN_SECONDS;
      result.notice = 'fare cancelled — you were knocked out';
      result.changed = true;
      return result;
    }
    if (!ctx.inCar) {
      job.abandonT += ctx.dt;
      if (job.abandonT >= ABANDON_SECONDS) {
        reset(job);
        job.cooldownT = FARE_COOLDOWN_SECONDS;
        result.notice = 'fare cancelled — you left the car';
        result.changed = true;
        return result;
      }
    } else if (job.abandonT !== 0) {
      // Back in the car inside the grace window: the clock resets rather than
      // pausing. Getting out to move a bin is not a fare you should lose, and
      // twenty seconds of *cumulative* absence would be a rule nobody could
      // feel.
      job.abandonT = 0;
    }
  }

  switch (job.state) {
    case 'none': {
      // A fare is only ever offered to somebody at the wheel. On foot you are
      // online and idle, which is the state the phone's app shows.
      if (!ctx.inCar || job.cooldownT > 0) break;
      if (!offer(job, ctx)) break;
      result.notice = 'fare offered';
      result.changed = true;
      break;
    }
    case 'offered': {
      if (ctx.nowMs - job.offeredMs >= OFFER_SECONDS * 1000) {
        job.state = 'toPickup';
        job.version++;
        result.changed = true;
      }
      break;
    }
    case 'toPickup': {
      if (!held(job, ctx, job.px, job.pz, PICKUP_STOP_M)) break;
      job.state = 'toDropoff';
      job.stopT = 0;
      job.boardedMs = ctx.nowMs;
      job.rough = false;
      job.version++;
      result.notice = 'passenger in';
      result.changed = true;
      break;
    }
    case 'toDropoff': {
      if (!held(job, ctx, job.dx, job.dz, DROPOFF_STOP_M)) break;
      const seconds = Math.max(0, (ctx.nowMs - job.boardedMs) / 1000);
      // --- WORKSTREAM W: the talent multiplier and the tip. `fxFareScale` folds
      // Surge, Tradie Rates and Tip Jar's collective cut into one number; the
      // tip is Surge's $10 and is only paid on a quick trip (`farePayout` gates
      // it on the same test the fast bonus uses).
      job.payout = farePayout(
        job.tripM,
        seconds,
        job.rough,
        fxFareScale(ctx.playerId, ctx.phase ?? 0.5),
        fxFareTip(ctx.playerId),
      );
      job.state = 'done';
      job.stopT = 0;
      job.cooldownT = FARE_COOLDOWN_SECONDS;
      job.version++;
      result.paid = job.payout;
      result.changed = true;
      break;
    }
    default:
      break;
  }

  return result;
}

/**
 * Stopped inside `radius` of a point for `STOP_SECONDS`.
 *
 * The stop clock **resets rather than pausing** when you move or drift out of
 * the circle, and that is the rule that makes a pickup a stop rather than a
 * drive-by: a car that rolls through the circle at 3 m/s accumulates a tenth of
 * a second on each of fifteen ticks and would board a passenger through a
 * pausing clock. It also has to be a stop the player can *feel* they made, and
 * "I stopped for a second and a half" is that where "I was near it for a second
 * and a half in total" is not.
 */
function held(job: FareJob, ctx: FareContext, px: number, pz: number, radius: number): boolean {
  const dx = ctx.x - px;
  const dz = ctx.z - pz;
  if (dx * dx + dz * dz > radius * radius || ctx.speed > STOPPED_SPEED) {
    job.stopT = 0;
    return false;
  }
  job.stopT += ctx.dt;
  // `powerups.EXPIRY_EPSILON`'s problem, at a tenth of the scale and in the
  // other direction: ninety additions of 1/60 land a few times 1e-16 *below*
  // 1.5, so a bare `>=` needs a ninety-first tick about half the time and the
  // stop is 1.5167 s on alternate builds. A microsecond is six orders of
  // magnitude under the requirement and four under the timestep, so it can
  // resolve nothing but this.
  return job.stopT + 1e-6 >= STOP_SECONDS;
}

/** Everything back to idle, keeping `online` and the cooldown. */
function reset(job: FareJob): void {
  job.state = 'none';
  job.px = 0;
  job.pz = 0;
  job.dx = 0;
  job.dz = 0;
  job.tripM = 0;
  job.offeredMs = 0;
  job.boardedMs = 0;
  job.payout = 0;
  job.stopT = 0;
  job.abandonT = 0;
  job.rough = false;
  job.version++;
}

/**
 * Try to compose a fare. False if the footpath network has nothing to offer,
 * which happens in the middle of a park and in the outer extent where the
 * bands have not streamed in.
 *
 * A failure is **silent and retried on the next tick**, deliberately: telling a
 * player "no fares available" while they drive through Centennial Park would be
 * a message they get sixty times a second, and the honest state is exactly what
 * they are already looking at -- online, no fare.
 */
function offer(job: FareJob, ctx: FareContext): boolean {
  const seed = hash2(ctx.playerId, ctx.tick);
  // WORKSTREAM W: `Surge` widens the pickup band 900 → 1400 m. Absolute and
  // max-wins; the *minimum* is untouched, because a talent that made pickups
  // start further away as well would be a downgrade dressed as a buff.
  const pickupMax = fxFareRadiusM(ctx.playerId, PICKUP_MAX_M);
  if (!pickKerbPoint(ctx.peds, ctx.x, ctx.z, PICKUP_MIN_M, pickupMax, seed, ctx.bands, point)) return false;
  const px = point.x;
  const pz = point.z;
  if (!pickKerbPoint(ctx.peds, px, pz, TRIP_MIN_M, TRIP_MAX_M, hash2(seed, 0x9e3779b9), ctx.bands, point)) {
    return false;
  }
  job.px = px;
  job.pz = pz;
  job.dx = point.x;
  job.dz = point.z;
  const tx = job.dx - px;
  const tz = job.dz - pz;
  job.tripM = Math.sqrt(tx * tx + tz * tz);
  job.offeredMs = ctx.nowMs;
  job.boardedMs = 0;
  job.stopT = 0;
  job.abandonT = 0;
  job.rough = false;
  // What it would pay driven at the target pace with nobody run over: the
  // number the HUD shows while you decide whether to bother.
  // The estimate carries the same multiplier the real payout will, or the HUD
  // would offer $18 and pay $25 -- which reads as a bug rather than as a bonus.
  job.payout = farePayout(
    job.tripM,
    job.tripM / 12,
    false,
    fxFareScale(ctx.playerId, ctx.phase ?? 0.5),
    fxFareTip(ctx.playerId),
  );
  job.state = 'offered';
  job.version++;
  return true;
}

/** Where `pickKerbPoint` writes. Module-level and consumed synchronously. */
const point = { x: 0, z: 0 };

/**
 * A footpath vertex between `minM` and `maxM` of a point, chosen by a hash.
 *
 * **Reservoir sampling in one pass**, which is the whole implementation and is
 * why there is no candidate array: the bands within `maxM` can hold tens of
 * thousands of vertices in the CBD, and collecting them to pick one would be
 * the largest allocation in the server. Instead each qualifying vertex is
 * counted and replaces the held one with probability `1/n` -- so every
 * qualifying vertex is equally likely, one pass, one pair of floats of state.
 *
 * The "probability" is a hash rather than `Math.random`, for the reason in the
 * header. `hash2(seed, n) % n === 0` is a `1/n` test that is deterministic in
 * `(seed, n)`, which is exactly what a reproducible check needs.
 *
 * Every fourth vertex, not every vertex. A band is a polyline whose points are
 * a few metres apart; sampling all of them is four times the work for a
 * distribution nobody can tell apart, and the stride is what keeps a CBD query
 * inside a millisecond.
 */
export function pickKerbPoint(
  peds: BandSource,
  x: number,
  z: number,
  minM: number,
  maxM: number,
  seed: number,
  bands: PedBand[],
  out: { x: number; z: number },
): boolean {
  peds.near(x, z, maxM, bands);
  const min2 = minM * minM;
  const max2 = maxM * maxM;
  let seen = 0;
  let foundX = 0;
  let foundZ = 0;
  for (const band of bands) {
    for (let i = 0; i < band.count; i += 4) {
      const bx = band.x[i];
      const bz = band.z[i];
      const dx = bx - x;
      const dz = bz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < min2 || d2 > max2) continue;
      seen++;
      // 1/n, deterministically. The first qualifying vertex is always taken
      // (n = 1), which is what makes a single-candidate query succeed.
      if (seen === 1 || hash2(seed, seen) % seen === 0) {
        foundX = bx;
        foundZ = bz;
      }
    }
  }
  if (seen === 0) return false;
  out.x = foundX;
  out.z = foundZ;
  return true;
}

/**
 * Two integers to one, 32-bit, exactly. `game/traffic.carHash`'s construction.
 *
 * `Math.imul` rather than `*` because a 32-bit multiply overflows a double's
 * exact integer range and the two ends would round it differently -- which does
 * not matter for this file today (only the server calls it) and does matter the
 * moment anything here becomes shared. Cheap enough that there is no reason to
 * write the version that will be wrong later.
 */
function hash2(a: number, b: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// --- The self-check ---------------------------------------------------------------

/**
 * The state machine, driven tick by tick through the real `stepFare`.
 *
 * Every failure in this file is silent in this repo's sense -- the fare runs,
 * the marker appears, and the money is wrong or never arrives:
 *
 *   - A **stop clock that pauses rather than resets** boards a passenger from a
 *     car that never stopped, which reads as the pickup radius being enormous.
 *   - An **abandon clock that accumulates** cancels a fare from a driver who
 *     got out three times for four seconds each, with a message that says they
 *     left the car -- and they did not.
 *   - A **cooldown that never expires** gives a driver exactly one fare per
 *     session and no indication why the second never comes.
 *   - A **`rough` flag cleared at the wrong moment** applies the -50% to the
 *     trip *after* the one you drove badly.
 *   - And a **reservoir sampler that always takes the first candidate** offers
 *     every driver in the CBD the same corner of Haymarket forever.
 *
 *     bun -e "import {verifyFares} from './server/fares.ts';
 *             console.log(verifyFares())"
 */
export function verifyFares(): string[] {
  const failures: string[] = [];
  const DT = 1 / 60;

  // A footpath network with two straight bands: one 500 m east (inside the
  // pickup band) and one 2 km east of that (inside the trip band from it).
  const peds = fakeField();
  const bands: PedBand[] = [];

  const ctx = (over: Partial<FareContext> = {}): FareContext => ({
    playerId: 7,
    tick: 100,
    dt: DT,
    nowMs: 1_800_000_000_000,
    x: 0,
    z: 0,
    speed: 0,
    inCar: true,
    ko: false,
    peds,
    bands,
    ...over,
  });

  // --- The whole happy path, tick by tick, with a clock that really advances.
  {
    const job = createFare();
    job.online = true;
    let now = 1_800_000_000_000;
    const step = (over: Partial<FareContext> = {}): FareStepResult => {
      now += DT * 1000;
      return stepFare(job, ctx({ nowMs: now, ...over }));
    };

    // Read the state through a call rather than off the record.
    //
    // TypeScript narrows `job.state` at the first `!==` below and does **not**
    // widen it again across `step`, because narrowing on a property survives an
    // arbitrary function call -- so every later comparison in this block would
    // be a compile error against a union member the compiler believes has been
    // ruled out. The state really is whatever the last step left; this is how
    // the check says so.
    const state = (): string => job.state;

    const first = step();
    if (state() !== 'offered') {
      failures.push(`An online driver in a car was not offered a fare; the state is ${job.state}.`);
      return failures;
    }
    if (!first.changed) failures.push('The offer did not report a change, so no FARE frame would be sent.');
    if (!(job.tripM >= TRIP_MIN_M && job.tripM <= TRIP_MAX_M)) {
      failures.push(`The trip is ${job.tripM.toFixed(0)} m, outside the ${TRIP_MIN_M}-${TRIP_MAX_M} m band.`);
    }
    const pickupD = Math.sqrt(job.px * job.px + job.pz * job.pz);
    if (!(pickupD >= PICKUP_MIN_M && pickupD <= PICKUP_MAX_M)) {
      failures.push(`The pickup is ${pickupD.toFixed(0)} m away, outside the ${PICKUP_MIN_M}-${PICKUP_MAX_M} m band.`);
    }

    // The offer sits for two seconds and then the meter starts.
    for (let i = 0; i < Math.round(OFFER_SECONDS / DT) + 2; i++) step();
    if (state() !== 'toPickup') failures.push(`After ${OFFER_SECONDS} s the state is ${job.state}, not toPickup.`);

    // Roll through the pickup without stopping: the clock must not accumulate.
    for (let i = 0; i < 60; i++) step({ x: job.px, z: job.pz, speed: STOPPED_SPEED + 2 });
    if (state() !== 'toPickup') failures.push('A car that drove through the pickup at speed boarded a passenger.');
    if (job.stopT !== 0) failures.push(`The stop clock held ${job.stopT.toFixed(2)} s after driving through.`);

    // Now stop there, and be a second short of the requirement.
    for (let i = 0; i < Math.round(STOP_SECONDS / DT) - 2; i++) step({ x: job.px, z: job.pz, speed: 0 });
    if (state() !== 'toPickup') failures.push('A passenger boarded before the full stop had elapsed.');
    const board = step({ x: job.px, z: job.pz, speed: 0 });
    step({ x: job.px, z: job.pz, speed: 0 });
    if (state() !== 'toDropoff') failures.push(`A ${STOP_SECONDS} s stop at the pickup left the state at ${job.state}.`);
    if (board.notice === '' && state() === 'toDropoff') {
      failures.push('Boarding produced no notice; the player is told nothing at the one moment the job starts.');
    }

    // Drive there instantly and stop. Fast, so the bonus applies.
    let paid = 0;
    for (let i = 0; i < Math.round(STOP_SECONDS / DT) + 4; i++) {
      const r = step({ x: job.dx, z: job.dz, speed: 0 });
      if (r.paid > 0) paid = r.paid;
    }
    if (state() !== 'done') failures.push(`A ${STOP_SECONDS} s stop at the dropoff left the state at ${job.state}.`);
    if (paid <= 0) failures.push('A completed fare paid nothing.');
    // The whole trip took about three seconds of simulated time over a
    // kilometre and a half, so it is unambiguously inside the bonus window and
    // the elapsed figure cannot change which side of it the trip falls on.
    const want = farePayout(job.tripM, 3, false);
    if (paid !== want) failures.push(`A fast clean fare paid $${paid}; the formula gives $${want}.`);

    // And the cooldown. `done` is **held** for the whole ten seconds rather
    // than dropping straight to `none`, which is what lets the HUD keep saying
    // what the last trip paid instead of blanking on the frame the money
    // arrives; `none` is reached only when the cooldown expires, and the next
    // offer follows on the tick after that.
    for (let i = 0; i < Math.round((FARE_COOLDOWN_SECONDS - 1) / DT); i++) step();
    if (state() !== 'done') failures.push(`Mid-cooldown the state is ${job.state}, not done.`);
    for (let i = 0; i < Math.round(2 / DT); i++) step();
    if (state() === 'none' || state() === 'done') {
      failures.push(`No second fare was offered ${FARE_COOLDOWN_SECONDS} s after the first; the state is ${job.state}.`);
    }
  }

  // --- Abandonment: the clock resets on re-entry rather than accumulating.
  {
    const job = createFare();
    job.online = true;
    let now = 1_800_000_000_000;
    const step = (over: Partial<FareContext> = {}): FareStepResult => {
      now += DT * 1000;
      return stepFare(job, ctx({ nowMs: now, ...over }));
    };
    step();
    for (let i = 0; i < Math.round(OFFER_SECONDS / DT) + 2; i++) step();
    // Out for fifteen, back in for one, out for fifteen: not a cancellation.
    for (let i = 0; i < Math.round(15 / DT); i++) step({ inCar: false });
    if (job.state === 'none') failures.push(`A fare was cancelled after 15 s out of the car; the rule is ${ABANDON_SECONDS} s.`);
    step({ inCar: true });
    for (let i = 0; i < Math.round(15 / DT); i++) step({ inCar: false });
    if (job.state === 'none') {
      failures.push('Two 15 s absences with a moment in the car between them cancelled the fare; the clock must reset.');
    }
    // And a genuine twenty-one seconds does cancel it, with a message.
    let notice = '';
    for (let i = 0; i < Math.round((ABANDON_SECONDS + 1) / DT); i++) {
      const r = step({ inCar: false });
      if (r.notice !== '') notice = r.notice;
    }
    if (job.state !== 'none') failures.push(`${ABANDON_SECONDS + 1} s out of the car did not cancel the fare.`);
    if (!notice.includes('left the car')) failures.push(`The abandonment notice was ${JSON.stringify(notice)}.`);
  }

  // --- A knockout cancels outright, and beats the dropoff on the same tick.
  {
    const job = createFare();
    job.online = true;
    let now = 1_800_000_000_000;
    const step = (over: Partial<FareContext> = {}): FareStepResult =>
      stepFare(job, ctx({ nowMs: (now += DT * 1000), ...over }));
    step();
    for (let i = 0; i < Math.round(OFFER_SECONDS / DT) + 2; i++) step();
    for (let i = 0; i < Math.round(STOP_SECONDS / DT) + 4; i++) step({ x: job.px, z: job.pz, speed: 0 });
    if (job.state !== 'toDropoff') failures.push('The knockout case could not get a passenger aboard.');
    const dx = job.dx;
    const dz = job.dz;
    for (let i = 0; i < Math.round(STOP_SECONDS / DT) - 1; i++) step({ x: dx, z: dz, speed: 0 });
    const r = step({ x: dx, z: dz, speed: 0, ko: true });
    if (r.paid !== 0) failures.push(`A driver knocked out on the dropoff tick was paid $${r.paid}.`);
    if (job.state !== 'none') failures.push(`A knocked-out driver's fare is in state ${job.state}.`);
  }

  // --- Going offline cancels, and the rough flag halves the payout.
  {
    const job = createFare();
    job.online = true;
    stepFare(job, ctx());
    job.online = false;
    const r = stepFare(job, ctx());
    if (job.state !== 'none') failures.push('Going offline left a fare running.');
    if (r.notice !== 'shift over') failures.push(`Going offline said ${JSON.stringify(r.notice)}.`);

    const clean = farePayout(2000, 1000, false);
    const rough = farePayout(2000, 1000, true);
    if (!(rough < clean)) failures.push(`A rough 2 km fare paid $${rough} against a clean $${clean}.`);
  }

  // --- The sampler: every candidate is reachable, and it never returns a
  // point outside the band it was asked for.
  {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const out = { x: 0, z: 0 };
      if (!pickKerbPoint(peds, 0, 0, PICKUP_MIN_M, PICKUP_MAX_M, seed, bands, out)) {
        failures.push(`pickKerbPoint found nothing at seed ${seed} on a field that has candidates.`);
        break;
      }
      const d = Math.sqrt(out.x * out.x + out.z * out.z);
      if (d < PICKUP_MIN_M - 0.01 || d > PICKUP_MAX_M + 0.01) {
        failures.push(`pickKerbPoint returned a point ${d.toFixed(1)} m away, outside its own band.`);
        break;
      }
      seen.add(`${out.x},${out.z}`);
    }
    if (seen.size < 4) {
      failures.push(
        `Two hundred seeds produced ${seen.size} distinct pickups. The reservoir sampler is stuck on ` +
          'the first candidate, so every driver in the city is sent to one corner.',
      );
    }
    // Deterministic in the seed, which is what makes a failure reproducible.
    const a = { x: 0, z: 0 };
    const b = { x: 0, z: 0 };
    pickKerbPoint(peds, 0, 0, PICKUP_MIN_M, PICKUP_MAX_M, 42, bands, a);
    pickKerbPoint(peds, 0, 0, PICKUP_MIN_M, PICKUP_MAX_M, 42, bands, b);
    if (a.x !== b.x || a.z !== b.z) failures.push('pickKerbPoint is not a pure function of its seed.');
    // A band with nothing in range returns false rather than a point at the
    // origin, which would put every fare at Town Hall.
    const empty = { x: -1, z: -1 };
    if (pickKerbPoint(peds, 0, 0, 1e6, 2e6, 1, bands, empty)) {
      failures.push('pickKerbPoint invented a candidate a thousand kilometres away.');
    }
  }

  return failures;
}

/**
 * Two straight footpaths, as a `BandSource`. See that interface for why the
 * real `PedestrianField` is not used here.
 *
 * One band 500-900 m east of the origin (inside the pickup band from a driver
 * standing there) and one 1.4-3.4 km east of that (inside the trip band from
 * anywhere on the first). The bounds test is the real one's -- loose, on the
 * plan bounds -- so the sampler is exercised through the same shape of input it
 * sees in the city.
 */
function fakeField(): BandSource {
  const all = [straight(500, 0, 900, 0), straight(1400, 0, 3400, 0)];
  return {
    near(x: number, z: number, radius: number, out: PedBand[]): PedBand[] {
      out.length = 0;
      for (const band of all) {
        if (
          band.maxX < x - radius || band.minX > x + radius ||
          band.maxZ < z - radius || band.minZ > z + radius
        ) continue;
        out.push(band);
      }
      return out;
    },
  };
}

/** One straight band from (x0,z0) to (x1,z1), a vertex every 10 m. */
function straight(x0: number, z0: number, x1: number, z1: number): PedBand {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.sqrt(dx * dx + dz * dz);
  const count = Math.max(2, Math.round(length / 10) + 1);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const s = new Float32Array(count);
  const ux = new Float32Array(count - 1);
  const uz = new Float32Array(count - 1);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    x[i] = x0 + dx * t;
    z[i] = z0 + dz * t;
    s[i] = length * t;
  }
  for (let i = 0; i < count - 1; i++) {
    ux[i] = dx / length;
    uz[i] = dz / length;
  }
  return {
    osmId: 0, side: 0, klass: 0, seed: 1, count,
    x, y, z, s, ux, uz, length, slots: 0,
    minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
  };
}
