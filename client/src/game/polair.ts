/**
 * Polair: where the helicopter is, where its light is looking, and when the
 * bloke leaning out of it takes a shot he is going to miss.
 *
 * ===========================================================================
 * THE DESIGN. Read this before touching a number below it.
 * ===========================================================================
 *
 * Before this file, the fifth rung of the heat ladder was **one `SpotLight`
 * 140 m straight up, aimed at the player, with a little sway**. It was a good
 * first cut and `world/highway-patrol.ts` section 4 argues for it at length: a
 * modelled helicopter is a mesh, a rotor animation, a flight path and an actor
 * on the wire, and what a police helicopter *is* from the ground at night is a
 * cone of light on you that will not go away.
 *
 * Every word of that is still true and the conclusion was still wrong, because
 * a light directly overhead that tracks you perfectly is not a chase. It is a
 * **ceiling lamp**. The owner's words, verbatim:
 *
 *   *"the helicopter chase could be improved too by it having more variable and
 *   less bright lights (like its chasing u and much further) and shot
 *   inaccurately more often"*
 *
 * Three complaints and each one is a thing this file adds.
 *
 * ---------------------------------------------------------------------------
 * 1. IT IS A BODY ON AN ORBIT, NOT A POINT ABOVE YOUR HEAD.
 *
 * Polair is now at 180-260 m of altitude on a wide wobbling circle of 90-160 m
 * radius, about 40 s to the lap, and the circle is centred **not on you** but on
 * where you were two to four seconds ago, pushed a further 40 m back along the
 * way you have been running. So the default read from the ground is a machine
 * *behind and to one side*, at four times the slant range the old one sat at,
 * which is what "much further" means and is also what a real one does: it holds
 * off, it keeps you in the middle of a turn, and it does not fly over the top of
 * you because from directly above it cannot see anything but your hat.
 *
 * The radius and the altitude both drift on their own slow clocks, so no two
 * laps are the same and there is no period a player can learn. The one hard
 * guarantee is a **60 m horizontal keep-out**: however the drift and the lag
 * conspire, the airframe is never nearer than that in plan, because a
 * helicopter that clipped through the player would be the single worst frame
 * this feature could produce and there is no version of this build where it is
 * ever wanted. `verifyPolair` drives ten minutes of ticks against a moving
 * target and asserts it.
 *
 * ---------------------------------------------------------------------------
 * 2. THE LIGHT SEARCHES. IT DOES NOT HOLD.
 *
 * The old beam was welded to the player with a 0.55 s lag. The new one is a
 * **searchlight**: a 7 degree cone, forty per cent of the old intensity, from
 * nearly twice the height -- so the pool on the road is about a fifth as bright
 * as it was -- and it spends most of its time hunting the *estimated* position
 * (the same delayed point the orbit is centred on) on a figure-of-eight, with
 * an occasional **lock**: 1.5 to 3 s of holding you dead centre, once every 8 to
 * 12 s, and then it loses you again. The duty cycle works out at 12-24 %, which
 * `verifyPolair` measures rather than asserts from the constants.
 *
 * That is the whole feel change. Being at five stars used to be a constant
 * white circle; it is now a light going past you, coming back, finding you,
 * and sliding off -- and the moments it finds you are the moments you are
 * about to be shot at, which gives the lock a meaning beyond decoration.
 *
 * A dim body silhouette, a rotor disc and three nav lights are in
 * `world/highway-patrol.ts` so that there is *something up there to look at*
 * when the beam swings away, and so the feature has a read **by day**, when a
 * cone is invisible against the sun and the old build's entire daylight
 * presentation was a faint disc on the road.
 *
 * ---------------------------------------------------------------------------
 * 3. HE SHOOTS, AND HE MISSES.
 *
 * One shot per lock, and **only** while locked, at a hashed moment about half a
 * second into it. The cadence rule as written is the brief's -- *"every 4-7 s
 * while locked"* -- implemented as a cooldown against the previous shot; with
 * locks 8-12 s apart that cooldown has always expired by the time a lock
 * starts, so in practice it resolves to exactly one round per lock. Both
 * statements are true at once and the cooldown is the one that is coded,
 * because it is the one that keeps being right if the lock schedule is retuned.
 *
 * The hit chance is `factions.hitChance` -- the *same* clamped line the ground
 * officers use -- with its three coefficients passed rather than defaulted. See
 * `POLAIR_HIT_INTERCEPT`. At the slant ranges this orbit actually produces it
 * lands between 8 % and 2 %, falling with range, so a five-star player takes a
 * pip every few minutes rather than every few seconds and the shot is a *threat*
 * instead of a damage source.
 *
 * **The authority decides the hit and the client never does.** The roll lives in
 * `heat.HeatField.step`, which already runs once per wanted player on the
 * server; a hit goes down `ctx.damagePlayer`, which is the identical door the
 * ground police and the patrol car use, so the KO, the feed line and the
 * respawn are one machine. What the client draws -- the muzzle flash on the
 * body, the puff of grit 2-8 m from your feet and the report arriving three
 * quarters of a second later -- it draws from **this file's own pure functions**
 * at the same tick, with no message on the wire at all.
 *
 * That is the honest split rather than the cheap one, and the reasoning is worth
 * writing down because "just send an event" was the obvious alternative:
 *
 *   - The *schedule* (is he locked, does a round leave this tick, where does it
 *     land) is a pure function of `(playerId, tick)` and of a position both ends
 *     already have. Sending it would be paying wire for arithmetic, which is
 *     exactly what `game/traffic.ts` and `game/footy.ts` refuse to do.
 *   - The *outcome* is not: it depends on the authority's idea of where the
 *     player is, and a client that computed it would be a client that could
 *     decide it had not been hit. So the outcome is never computed on the
 *     client. It arrives as damage, through a path that already exists.
 *   - The two therefore cannot disagree in a way anybody can see: the client
 *     always draws a miss, and a hit is a miss *plus* a pip, which on screen is
 *     a puff of grit near you and your own blood flash at the same instant. A
 *     round that hit and a round that missed look different because one of them
 *     hurt, which is the only difference a player can perceive from 250 m.
 *
 * The remaining seam is that the two ends feed their trails from slightly
 * different position histories -- the server's authoritative one, the client's
 * predicted one -- so the airframe the client draws is a metre or two from the
 * one the server measured the slant range against. A metre of slant at 250 m
 * moves the hit chance by six thousandths of a per cent. It is named here so
 * nobody has to rediscover that it does not matter.
 *
 * ---------------------------------------------------------------------------
 * 4. DETERMINISM, AND WHY THERE IS NO `Math.sin` IN THIS FILE.
 *
 * `game/factions.ts` rule 5 and `game/streetlife.ts`'s `triangle` note apply
 * here in full: **no `sin`, `cos`, `atan2` or `pow` on anything two processes
 * both evaluate.** Today only the slant range is evaluated on both ends, so a
 * transcendental in the *pose* would technically be safe -- and it is banned
 * anyway, because the pose is the input to the slant range and because the day
 * somebody wants Polair as a promoted actor on the wire (or wants the client to
 * predict the marksman) is the day a `Math.sin` in here becomes a real
 * desynchronisation that nobody will find.
 *
 * So the unit circle is built out of two triangle waves a quarter period apart
 * -- which traces the L1 diamond -- and normalised onto the L2 circle with one
 * square root. Both operations are exactly specified by IEEE 754, so the two
 * engines agree bit for bit. The angular speed comes out slightly non-uniform
 * (about four degrees of wander against a true circle), which for an orbit is
 * not an error but the right behaviour: a helicopter circling a suspect does not
 * hold a constant rate.
 *
 * Everything random is `traffic.carHash`, seeded off `(playerId, index)` and
 * never off wall-clock milliseconds or `Math.random`.
 *
 * ---------------------------------------------------------------------------
 * 5. WHAT IS IN THIS FILE AND WHAT IS NOT.
 *
 * This file is **three-free** and the Bun server imports it. It owns the orbit,
 * the beam schedule, the shot schedule, the scatter, the marksman's accuracy
 * curve and every tuning constant the feature has -- including the ones only a
 * renderer reads, like the cone angle and the strobe period, because
 * `verifyPolair` runs on the server and has to be able to check them.
 *
 * `world/highway-patrol.ts` draws all of it and imports three. That is
 * `game/heat.ts` against `world/highway-patrol.ts` restated one level down, and
 * for the identical reason.
 *
 * ---------------------------------------------------------------------------
 * 6. SERVER BUDGET. One `polairPose` per five-star player per tick: about sixty
 * multiplies, four hashes, three square roots, and no allocation -- the pose and
 * the trail are both records the caller owns and reuses. A room with nobody at
 * five stars pays nothing at all, because `heat.HeatField.step` never reaches
 * this file. The trail is a fixed 20 slots of three floats, created when a
 * player reaches the rung and dropped when they leave it, so the memory is
 * bounded by the number of people currently at the top of the ladder rather
 * than by everybody who ever was.
 */

import { hitChance } from './factions.ts';
import { carHash } from './traffic.ts';

// --- The orbit ---------------------------------------------------------------------

/**
 * How long one lap takes, ticks. Forty seconds.
 *
 * Slow enough that the machine is somewhere *specific* for several seconds at a
 * time -- a player who looks up twice in ten seconds should be able to tell it
 * has moved and roughly which way it is going -- and fast enough that a whole
 * lap happens inside one pursuit. The drift clocks below are deliberately not
 * multiples of it, so the track never closes on itself.
 */
export const POLAIR_ORBIT_TICKS = 40 * 60;

/** How wide the orbit is, metres. The brief's 90-160. */
export const POLAIR_RADIUS_MIN_M = 90;
export const POLAIR_RADIUS_MAX_M = 160;
/** And how high, metres above the target's own ground. The brief's 180-260. */
export const POLAIR_ALTITUDE_MIN_M = 180;
export const POLAIR_ALTITUDE_MAX_M = 260;

/**
 * How near the airframe may ever come in plan, metres. **A hard floor.**
 *
 * The orbit radius alone cannot guarantee this: the circle is centred on a
 * *delayed* position pushed further back again, so a player who turns and
 * sprints toward the machine closes on it faster than the centre moves. Sixty
 * metres of plan separation at 180 m of altitude is a slant range of 190, which
 * is still a helicopter a long way off; the clamp exists so that the geometry
 * has a stated worst case rather than an emergent one. `verifyPolair` drives it.
 */
export const POLAIR_KEEPOUT_M = 60;

/**
 * How long the radius and the altitude take to wander through their ranges,
 * ticks.
 *
 * Two different numbers, neither a multiple of `POLAIR_ORBIT_TICKS` and not of
 * each other, because the whole point of "more variable" is that the three
 * cycles never line up. 53 s and 71 s against the 40 s lap.
 */
export const POLAIR_RADIUS_DRIFT_TICKS = 53 * 60;
export const POLAIR_ALTITUDE_DRIFT_TICKS = 71 * 60;

/**
 * How far behind the target the pursuit lags, ticks, and how long that lag
 * itself takes to wander. The brief's 2-4 s.
 *
 * The lag is what turns an orbit into a **chase**. A circle centred on where
 * you are is a machine holding station over you; a circle centred on where you
 * were three seconds ago is a machine that has to keep catching up, and at a
 * sprint that is thirty metres of visible arrears.
 */
export const POLAIR_LAG_MIN_TICKS = 2 * 60;
export const POLAIR_LAG_MAX_TICKS = 4 * 60;
export const POLAIR_LAG_DRIFT_TICKS = 37 * 60;

/**
 * And how far back along the target's recent travel the orbit's centre is
 * pushed, metres.
 *
 * On top of the lag rather than instead of it, because the two do different
 * things: the lag is arrears *in time*, so it vanishes when you stand still,
 * and this is a bias *in space* that survives you stopping. Together they mean
 * the machine is behind you when you run and off to one side of where you came
 * from when you stop, which is the read the owner asked for. Forty metres
 * against a 90-160 m radius is enough to be legible and not enough to put the
 * centre outside the orbit.
 */
export const POLAIR_TRAIL_BIAS_M = 40;

/**
 * How far behind the live player the orbit's centre may ever fall, metres.
 *
 * **This constant is here because the check found the hole.** The lag is arrears
 * in *time*, so its size in metres is the player's speed times up to four
 * seconds -- which is 32 m on foot, 90 m in a Commodore and 900 m in the check's
 * first synthetic path, which ran a target at an absurd speed precisely to find
 * out. The first cut had no cap, `verifyPolair` measured the airframe a kilometre
 * out over the harbour, and the failure it would have shipped as is a five-star
 * player in a car with a helicopter so far behind them that it is three pixels
 * and the searchlight lands in the next suburb.
 *
 * Seventy metres, and it is also a design statement rather than only a bound: a
 * helicopter is faster than anything you can drive, so however hard you run it
 * does not fall behind. What the lag buys is that it is *never quite over you*,
 * and seventy metres of that against a 90-160 m orbit is plenty.
 *
 * Everything downstream depends on this being finite: it is what makes
 * `POLAIR_SLANT_FAR_M` a number, which is what the accuracy curve is anchored on.
 */
export const POLAIR_CENTRE_MAX_M = 70;

// --- The trail --------------------------------------------------------------------

/**
 * How the delayed target position is remembered: 20 slots, 15 ticks apart.
 *
 * Five seconds of history at 4 Hz, which covers the 4 s maximum lag with a slot
 * to spare. Four hertz rather than sixty because the thing being sampled is
 * *where a person was three seconds ago* and a quarter of a second of
 * quantisation on that is a metre and a half at a sprint -- invisible under a
 * 90 m orbit radius, and a sixteenth of the memory.
 *
 * A ring indexed by `floor(tick / stride)` rather than a cursor, which is the
 * property that makes `push` **idempotent within a slot**: the client's frame
 * loop runs at whatever the display does and may push three times into one
 * slot, the server pushes once per sim tick, and both end up with the same
 * shape of history because the last write in a window wins in both.
 */
export const POLAIR_TRAIL_SLOTS = 20;
export const POLAIR_TRAIL_STRIDE = 15;
/** How far back the travel direction is measured over, ticks. A second and a half. */
export const POLAIR_TRAVEL_TICKS = 90;

/** What `PolairTrail.sample` writes. Reused by the caller; never allocated per tick. */
export interface TrailSample {
  x: number;
  y: number;
  z: number;
}

/**
 * Where the target has been, at 4 Hz, for the last five seconds.
 *
 * One of these per five-star player. It is the **only** state this feature
 * holds: everything else about Polair is a pure function of `(playerId, tick)`
 * and of this. Held by the caller -- `heat.HeatState` on the authority, one in
 * `world/highway-patrol.Polair` on the client -- rather than in a module map
 * here, because a module map is a leak with no owner and this project's rule is
 * that per-player state lives on the field that already sweeps players.
 */
export class PolairTrail {
  private readonly xs = new Float32Array(POLAIR_TRAIL_SLOTS);
  private readonly ys = new Float32Array(POLAIR_TRAIL_SLOTS);
  private readonly zs = new Float32Array(POLAIR_TRAIL_SLOTS);
  /** The tick each slot was last written at. `Float64Array` so a tick cannot wrap. */
  private readonly at = new Float64Array(POLAIR_TRAIL_SLOTS);
  private newest = 0;
  private primed = false;

  /**
   * Remember where the target is now.
   *
   * The **first** push fills every slot with the same point, back-dated so the
   * history reads as "they have been standing here". Without that, the first
   * three seconds of a five-star pursuit would sample an empty slot, and the
   * honest-looking answer -- the origin, which in this world is Town Hall --
   * would put the orbit's centre in the CBD wherever the player actually was.
   * A helicopter arriving over George Street because a buffer was cold is
   * exactly the class of failure this project's checks exist for, and it does
   * not throw.
   */
  push(tick: number, x: number, y: number, z: number): void {
    if (!this.primed) {
      this.primed = true;
      for (let i = 0; i < POLAIR_TRAIL_SLOTS; i++) {
        this.xs[i] = x;
        this.ys[i] = y;
        this.zs[i] = z;
        this.at[i] = tick - (POLAIR_TRAIL_SLOTS - 1 - i) * POLAIR_TRAIL_STRIDE;
      }
      this.newest = POLAIR_TRAIL_SLOTS - 1;
      return;
    }
    const slot = slotOf(tick);
    this.xs[slot] = x;
    this.ys[slot] = y;
    this.zs[slot] = z;
    this.at[slot] = tick;
    this.newest = slot;
  }

  /** Has anything been remembered yet? A cold trail samples as the origin. */
  get ready(): boolean {
    return this.primed;
  }

  /**
   * Where the target was `delayTicks` ago, or the newest thing known if that is
   * further back than the ring holds.
   *
   * Falling forward to the newest sample rather than to nothing, because the one
   * case that reaches it is a trail that has just been created -- and a
   * helicopter that starts its orbit around the player's *current* position and
   * settles into the lag over the next three seconds is exactly what a machine
   * arriving on station looks like.
   */
  sample(tick: number, delayTicks: number, out: TrailSample): TrailSample {
    if (!this.primed) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }
    const want = tick - delayTicks;
    const slot = slotOf(want);
    const age = tick - this.at[slot];
    // Written *after* the instant we asked about (the ring has lapped past it),
    // or older than the window the ring can hold. Either way the slot is not
    // the answer to the question asked.
    const stale = this.at[slot] > want + POLAIR_TRAIL_STRIDE
      || age > POLAIR_TRAIL_SLOTS * POLAIR_TRAIL_STRIDE
      || age < 0;
    const i = stale ? this.newest : slot;
    out.x = this.xs[i];
    out.y = this.ys[i];
    out.z = this.zs[i];
    return out;
  }

  /**
   * Which way the target has been travelling, as a unit vector, or `(0, 0)` for
   * somebody who has not moved.
   *
   * Newest minus a second and a half ago, normalised. A **zero** result is a
   * meaningful answer rather than a failure and the caller relies on it: a
   * player standing still has no "behind", so the spatial bias switches itself
   * off and the orbit centres on where they are.
   */
  travel(tick: number, out: { dx: number; dz: number }): void {
    out.dx = 0;
    out.dz = 0;
    if (!this.primed) return;
    const from = slotOf(tick - POLAIR_TRAVEL_TICKS);
    const dx = this.xs[this.newest] - this.xs[from];
    const dz = this.zs[this.newest] - this.zs[from];
    const d2 = dx * dx + dz * dz;
    // Under a metre over a second and a half is somebody shuffling on the spot,
    // and normalising it would turn jitter into a confident direction.
    if (d2 < 1) return;
    const inv = 1 / Math.sqrt(d2);
    out.dx = dx * inv;
    out.dz = dz * inv;
  }
}

/** Which ring slot a tick belongs to. Positive for every tick this build sees. */
function slotOf(tick: number): number {
  const n = Math.floor(tick / POLAIR_TRAIL_STRIDE) % POLAIR_TRAIL_SLOTS;
  return n < 0 ? n + POLAIR_TRAIL_SLOTS : n;
}

// --- The beam ---------------------------------------------------------------------

/** The searchlight's cone, degrees. The brief's 6-8; the old build's was 12. */
export const POLAIR_CONE_DEG = 7;

/**
 * The old peak intensity, kept as a constant nobody reads at runtime.
 *
 * It is here so `verifyPolair` can assert the *relation* the brief states --
 * the new cone is at most 0.45 of what it was -- rather than a bare number that
 * a future tuning pass would move without anybody noticing the brief had been
 * undone. `world/nightlights.ts` pins its own before-and-after constants the
 * same way and for the same reason.
 */
export const POLAIR_INTENSITY_WAS = 260000;
/**
 * And what it is now: forty per cent.
 *
 * Note that the *illumination on the road* falls by much more than that,
 * because the lamp also moved from 140 m up to 180-260 m up and a spot light
 * obeys an inverse square: 104000 at 220 m is about a fifth of the light 260000
 * at 140 m put on the ground. That compounding is deliberate -- "less bright"
 * and "much further" were one sentence in the brief -- and it is the reason the
 * ground disc and the visible cone in `world/highway-patrol.ts` were given more
 * to do. If the pool ever needs lifting, this is the one constant, and
 * `verifyPolair` allows anything up to 0.45.
 */
export const POLAIR_INTENSITY = 104000;

/** How far the search pattern wanders from the estimated position, metres. */
export const POLAIR_SWEEP_M = 34;
/** How long one figure-of-eight takes, ticks. Nine seconds; a light being flown. */
export const POLAIR_SWEEP_TICKS = 9 * 60;

/**
 * The lock schedule: the cycle it lives on, how long a lock lasts, and how far
 * its start may wander inside the cycle. All ticks.
 *
 * These four numbers are the feature's heartbeat and they are chosen *together*
 * to satisfy two properties at once, both of which `verifyPolair` measures over
 * ten minutes rather than deriving:
 *
 *   - the beam holds the player between 10 % and 30 % of the time, and
 *   - consecutive locks are 8-15 s apart.
 *
 * With a 12.5 s cycle, a 1.5-3 s lock and 0.75 s of jitter either side of the
 * cycle's midpoint, the duty comes out at 12-24 % and the gaps at 8-12.5 s.
 *
 * **Why the jitter is centred rather than free.** The obvious construction --
 * pick the start anywhere in the cycle -- makes the gap between one lock and
 * the next range from almost nothing to nearly two cycles, so a player would
 * occasionally get two locks back to back (and two rounds, four seconds apart,
 * which is the marksman becoming a threat by accident). Pinning the start near
 * the middle and jittering it keeps the schedule irregular to a player while
 * bounding the gap, which is the property the shot cadence depends on.
 */
export const POLAIR_LOCK_CYCLE_TICKS = 750;
export const POLAIR_LOCK_MIN_TICKS = 90;
export const POLAIR_LOCK_MAX_TICKS = 180;
export const POLAIR_LOCK_JITTER_TICKS = 45;

/** How hard the beam flickers, as a fraction either side of 1. The brief's 15 %. */
export const POLAIR_FLICKER = 0.15;
/** The two incommensurate clocks the flicker is made of, ticks. Haze, not a strobe. */
export const POLAIR_FLICKER_A_TICKS = 42;
export const POLAIR_FLICKER_B_TICKS = 19;

// --- The nav lights ---------------------------------------------------------------

/**
 * The anti-collision strobe's period, seconds, and how long each flash is.
 *
 * **Fixed**, unlike everything else in this file, and that is the point: an
 * aircraft's anti-collision light is the one thing about it that is regulated,
 * it flashes at a rate that does not vary, and a strobe whose period wandered
 * with the orbit would read as a fault rather than as an aircraft. One flash
 * every 1.05 s, 60 ms of it, plus a second flash 140 ms behind the first --
 * which is the double-pulse pattern a real one has and is far more legible at
 * 250 m than a single blink.
 *
 * The red and green position lights are **steady** while the machine is on
 * station, because that is what position lights are; the blinking is this
 * strobe's job alone. `verifyPolair` pins the period and asserts the duty is a
 * flash rather than a lamp.
 */
export const POLAIR_STROBE_PERIOD_S = 1.05;
export const POLAIR_STROBE_FLASH_S = 0.06;
export const POLAIR_STROBE_SECOND_S = 0.14;

// --- The marksman -----------------------------------------------------------------

/**
 * The shot cooldown, ticks: 4-7 s, hashed per lock. The brief's cadence.
 *
 * Measured against the previous round rather than against locked time, so the
 * rule stays legible: *he will not fire twice inside four seconds, and he will
 * not fire at all unless he has you.* With the lock schedule above the gaps are
 * always 8 s or more, so this never actually suppresses a shot -- one round per
 * lock is what the two constraints allow together. It is coded anyway because
 * it is the invariant that has to survive somebody retuning the lock cycle, and
 * `verifyPolair` asserts consecutive shots are at least `POLAIR_SHOT_MIN_TICKS`
 * apart whatever those constants become.
 */
export const POLAIR_SHOT_MIN_TICKS = 4 * 60;
export const POLAIR_SHOT_MAX_TICKS = 7 * 60;
/** How far into a lock the round leaves, ticks. Half a second: he takes aim first. */
export const POLAIR_SHOT_AIM_TICKS = 30;

/**
 * The nearest and furthest slant range the geometry above can produce, metres.
 *
 * **Derived rather than typed**, and that is the whole point of them. The
 * accuracy curve below is anchored on these two numbers, and the version of this
 * file that wrote them as literals had them describing a helicopter the orbit had
 * stopped flying within one tuning pass -- so the marksman's whole curve was
 * being evaluated off the end of itself and every round was at the floor.
 *
 *   near = hypot(keep-out, minimum altitude)         -- as close as it ever gets
 *   far  = hypot(max radius + max centre lag, max altitude)
 *
 * `verifyPolair` drives ten minutes of ticks and asserts the *measured* band sits
 * inside these, so the derivation is checked rather than trusted.
 */
export const POLAIR_SLANT_NEAR_M = /*#__PURE__*/ Math.sqrt(
  POLAIR_KEEPOUT_M * POLAIR_KEEPOUT_M + POLAIR_ALTITUDE_MIN_M * POLAIR_ALTITUDE_MIN_M,
);
export const POLAIR_SLANT_FAR_M = /*#__PURE__*/ (() => {
  const plan = POLAIR_RADIUS_MAX_M + POLAIR_CENTRE_MAX_M;
  return Math.sqrt(plan * plan + POLAIR_ALTITUDE_MAX_M * POLAIR_ALTITUDE_MAX_M);
})();

/**
 * The marksman's accuracy: `factions.hitChance`'s own clamped line, with all
 * three coefficients supplied -- and with **the two coefficients that matter
 * derived from the two probabilities a designer actually wants to set.**
 *
 * `POLAIR_HIT_NEAR` is his chance from as close as the orbit ever brings him and
 * `POLAIR_HIT_FAR` from as far as it takes him; the slope and the intercept fall
 * out of those and the geometry. So the intercept is emphatically *not* a claim
 * about a shot at point-blank range -- this machine cannot be at point-blank
 * range, the keep-out forbids it -- and nobody tuning this feature ever has to
 * reason about a line's y-intercept, which is the number people get wrong.
 *
 * Reusing the ground officers' function rather than writing a second miss model
 * is the point of parametrising it. There is one answer in this build to "did
 * that round land", it is a clamped line in range, and the difference between a
 * constable at 15 m and a bloke braced in a doorway 250 m up is three
 * coefficients rather than a second implementation. See `factions.hitChance`,
 * whose defaults are unchanged and whose ladder this does not touch.
 */
export const POLAIR_HIT_NEAR = 0.08;
export const POLAIR_HIT_FAR = 0.02;
export const POLAIR_HIT_PER_M = /*#__PURE__*/ (
  (POLAIR_HIT_NEAR - POLAIR_HIT_FAR) / (POLAIR_SLANT_FAR_M - POLAIR_SLANT_NEAR_M)
);
export const POLAIR_HIT_INTERCEPT = /*#__PURE__*/ (
  POLAIR_HIT_NEAR + POLAIR_HIT_PER_M * POLAIR_SLANT_NEAR_M
);
/**
 * And the floor, for anything past the far anchor.
 *
 * A floor rather than zero because a marksman who literally could not hit you
 * from the far side of the orbit would be a thing a player learns to ignore, and
 * the whole value of the shot is that you cannot. One and a half per cent is
 * about one round in seventy, which over a long pursuit is a pip you did not
 * expect and never two in a row.
 */
export const POLAIR_HIT_FLOOR = 0.015;

export function polairHitChance(slant: number): number {
  return hitChance(slant, POLAIR_HIT_INTERCEPT, POLAIR_HIT_PER_M, POLAIR_HIT_FLOOR);
}

/** How far from the player a miss lands, metres. Near enough to be about you. */
export const POLAIR_MISS_MIN_M = 2;
export const POLAIR_MISS_MAX_M = 8;

/**
 * How fast the round and its report travel, m/s.
 *
 * The round arrives first and the noise of the shot arrives second, which at
 * 250 m is 0.31 s against 0.73 s -- and that gap is the whole reason a rifle
 * from a helicopter is frightening in a way a pistol at 15 m is not. Both are
 * real numbers: 800 m/s is a service carbine and 343 is air at 20 degrees.
 * `world/highway-patrol.Polair` schedules the two sounds off them.
 */
export const POLAIR_ROUND_SPEED = 800;
export const POLAIR_SOUND_SPEED = 343;

// --- The pose ----------------------------------------------------------------------

/**
 * Everything about Polair at one tick, for one player.
 *
 * One record the caller owns and reuses, on `traffic.CarPose`'s own contract:
 * `polairPose` writes into it and allocates nothing, so a server stepping four
 * five-star players allocates nothing either.
 */
export interface PolairPose {
  /** The airframe, world metres. `y` is absolute, not above the target. */
  x: number;
  y: number;
  z: number;
  /** Unit heading: the orbit's tangent, so the nose points where it is flying. */
  dx: number;
  dz: number;
  /** This tick's orbit radius, and altitude above the target's feet. */
  radius: number;
  altitude: number;
  /** The point the orbit is centred on: the delayed, bias-shifted target. */
  centreX: number;
  centreZ: number;
  /** Where the beam is pointed, on the target's ground plane. */
  beamX: number;
  beamZ: number;
  /** True while the beam is holding the player rather than searching for them. */
  locked: boolean;
  /** 0..1 through the current lock, or 0 while searching. */
  lockT: number;
  /** The beam's brightness multiplier this tick: haze and flicker. Near 1. */
  flicker: number;
  /** Slant range from the airframe to the target's feet, metres. */
  slant: number;
  /** 0..1 round the lap, for the audio's pan. */
  orbitPhase: number;
}

export function createPolairPose(): PolairPose {
  return {
    x: 0, y: 0, z: 0, dx: 0, dz: 1,
    radius: POLAIR_RADIUS_MIN_M, altitude: POLAIR_ALTITUDE_MIN_M,
    centreX: 0, centreZ: 0, beamX: 0, beamZ: 0,
    locked: false, lockT: 0, flicker: 1, slant: 0, orbitPhase: 0,
  };
}

/**
 * A triangle wave in [-1, 1] with period 1.
 *
 * `game/streetlife.triangle`, copied rather than imported for that file's own
 * stated reason: it is three lines, it is not a shared abstraction anybody
 * maintains, and importing `game/streetlife.ts` for it would pull a venue table
 * and a drunk schedule into the helicopter. Exported so `verifyPolair` can
 * assert the properties every wave in this file rests on.
 */
export function triangle(u: number): number {
  const f = u - Math.floor(u);
  return f < 0.5 ? 4 * f - 1 : 3 - 4 * f;
}

/** A hash to 0..1. `traffic.unit`, which is private there. */
function unit01(h: number): number {
  return h / 4294967296;
}

/**
 * A slow wander in [0, 1], from two triangles at incommensurate rates.
 *
 * The replacement for the smooth noise this would otherwise want. Two triangles
 * averaged is not band-limited noise and does not pretend to be; what it is, is
 * a value that moves continuously, covers its whole range, has no period short
 * enough for a player to learn, and is exact arithmetic in both engines. The
 * 0.618 is the golden ratio's fractional part, which is the standard trick for
 * "as far from a rational multiple as a float gets" and is why the two never
 * beat into a visible pattern.
 */
export function drift(u: number, seed: number): number {
  const a = triangle(u + unit01(carHash(seed, 0x51d1)));
  const b = triangle(u * 0.618 + unit01(carHash(seed, 0x51d2)));
  return 0.5 + 0.25 * (a + b);
}

/**
 * The seed every deterministic choice about one player's helicopter hangs off.
 *
 * Hashed off the player id rather than being the id, so that players 1 and 2 do
 * not get orbits a fixed phase apart -- which they would, since the id goes
 * straight into a lookup of a periodic function.
 */
export function polairSeed(playerId: number): number {
  return carHash(playerId | 0, 0x90141a);
}

/**
 * A point on the unit circle at parameter `u`, without a transcendental.
 *
 * Two triangle waves a quarter period apart trace the L1 unit diamond; dividing
 * by the vector's own length projects that onto the L2 unit circle. Exactly one
 * square root, no `sin`, and the result is on the circle to the last bit in both
 * engines. See the header, section 4, for the angular non-uniformity this buys
 * and why it is welcome.
 */
export function orbitPoint(u: number, out: { dx: number; dz: number }): void {
  const ax = triangle(u);
  const az = triangle(u + 0.25);
  const l2 = ax * ax + az * az;
  // Unreachable for a triangle pair -- |ax| + |az| is exactly 1 everywhere, so
  // the length is at least the square root of a half -- and guarded anyway,
  // because a future edit to `triangle` that made it zero at some phase would
  // otherwise put the helicopter at NaN and the whole scene would vanish.
  if (l2 < 1e-12) {
    out.dx = 1;
    out.dz = 0;
    return;
  }
  const inv = 1 / Math.sqrt(l2);
  out.dx = ax * inv;
  out.dz = az * inv;
}

/** Scratch for the two vectors `polairPose` derives. Used and discarded in-call. */
const RADIAL = { dx: 0, dz: 0 };
const TRAVEL = { dx: 0, dz: 0 };
const DELAYED: TrailSample = { x: 0, y: 0, z: 0 };

/**
 * How long this tick's lock is, and when in its cycle it starts. Ticks.
 *
 * Split out of `polairPose` because the **shot schedule needs exactly this and
 * nothing else** -- `polairShotFired` has to be answerable without a trail, a
 * position or a pose, since the authority asks it before it has decided whether
 * to bother computing where the machine is.
 */
function lockStart(seed: number, cycle: number): number {
  const len = lockLength(seed, cycle);
  const mid = (POLAIR_LOCK_CYCLE_TICKS - len) / 2;
  const jitter = (unit01(carHash(seed ^ 0x6c1, cycle | 0)) * 2 - 1) * POLAIR_LOCK_JITTER_TICKS;
  return Math.round(mid + jitter);
}

function lockLength(seed: number, cycle: number): number {
  const span = POLAIR_LOCK_MAX_TICKS - POLAIR_LOCK_MIN_TICKS;
  return POLAIR_LOCK_MIN_TICKS + Math.floor(unit01(carHash(seed ^ 0x1e4, cycle | 0)) * (span + 1));
}

/** Which lock cycle a tick falls in. The shot index, and the roll's seed. */
export function polairCycle(tick: number): number {
  return Math.floor(tick / POLAIR_LOCK_CYCLE_TICKS);
}

/** Is the beam holding this player at this tick? Pure; no trail needed. */
export function polairLocked(playerId: number, tick: number): boolean {
  const seed = polairSeed(playerId);
  const cycle = polairCycle(tick);
  const start = lockStart(seed, cycle);
  const into = tick - cycle * POLAIR_LOCK_CYCLE_TICKS;
  return into >= start && into < start + lockLength(seed, cycle);
}

/**
 * The tick a round leaves the airframe in a given lock cycle.
 *
 * A whole number of ticks and a pure function, so both ends can ask "was that
 * this tick" without holding an edge -- which matters on the client, whose frame
 * loop may see the same shared tick twice or skip one entirely.
 */
export function polairShotTick(playerId: number, cycle: number): number {
  const seed = polairSeed(playerId);
  return cycle * POLAIR_LOCK_CYCLE_TICKS + lockStart(seed, cycle) + POLAIR_SHOT_AIM_TICKS;
}

/**
 * Did a round leave the airframe on exactly this tick?
 *
 * The cooldown is checked against the *previous cycle's* shot, which is the one
 * closed-form predecessor available -- there is at most one round per cycle by
 * construction, so "the previous shot" and "the previous cycle's shot" are the
 * same thing and no history has to be kept. See `POLAIR_SHOT_MIN_TICKS`.
 */
export function polairShotFired(playerId: number, tick: number): boolean {
  const cycle = polairCycle(tick);
  if (polairShotTick(playerId, cycle) !== tick) return false;
  // Only while locked. The aim offset is inside every legal lock length, so this
  // is true by construction -- and it is tested rather than assumed, because the
  // constant it rests on is one somebody will retune.
  if (!polairLocked(playerId, tick)) return false;
  const previous = polairShotTick(playerId, cycle - 1);
  const seed = polairSeed(playerId);
  const span = POLAIR_SHOT_MAX_TICKS - POLAIR_SHOT_MIN_TICKS;
  const cooldown = POLAIR_SHOT_MIN_TICKS + Math.floor(unit01(carHash(seed ^ 0x5a01, cycle | 0)) * (span + 1));
  return tick - previous >= cooldown;
}

/**
 * The roll for one round, 0..1. **The authority's alone.**
 *
 * Exported so the check can drive it and so there is one definition of the
 * number rather than a copy in `game/heat.ts`. Seeded off the player and the
 * lock cycle -- not the tick -- so that a server which recomputed a tick would
 * get the same answer, which is `factions.POLICE.think`'s own argument about
 * why its roll is a hash and not `Math.random`.
 */
export function polairRoll(playerId: number, cycle: number): number {
  return unit01(carHash(polairSeed(playerId) ^ 0x7a11, cycle | 0));
}

/** Where a missed round lands, relative to the player. Writes into `out`. */
export function polairMiss(
  playerId: number,
  cycle: number,
  px: number,
  pz: number,
  out: { x: number; z: number; distance: number },
): void {
  const seed = polairSeed(playerId);
  // The bearing off the same circle the orbit uses, so there is one definition
  // of "a direction" in this file rather than two that agree today.
  orbitPoint(unit01(carHash(seed ^ 0x3b17, cycle | 0)), RADIAL);
  const span = POLAIR_MISS_MAX_M - POLAIR_MISS_MIN_M;
  const d = POLAIR_MISS_MIN_M + unit01(carHash(seed ^ 0x3b18, cycle | 0)) * span;
  out.x = px + RADIAL.dx * d;
  out.z = pz + RADIAL.dz * d;
  out.distance = d;
}

/**
 * Where Polair is, where its light is looking, and how far it is from the
 * player, at one tick.
 *
 * `trail` must have been pushed this tick by the caller. The order matters and
 * is the caller's job rather than this function's, because the client pushes
 * from a predicted position inside its frame loop and the authority pushes from
 * the authoritative one inside its step -- and a `push` hidden in here would
 * make the two ends' call sites look identical while doing different things.
 */
export function polairPose(
  playerId: number,
  tick: number,
  tx: number,
  ty: number,
  tz: number,
  trail: PolairTrail,
  out: PolairPose,
): PolairPose {
  const seed = polairSeed(playerId);

  // --- Where the machine thinks you are: the delayed position, pushed back
  //     along the way you have been going.
  const lagSpan = POLAIR_LAG_MAX_TICKS - POLAIR_LAG_MIN_TICKS;
  const lag = POLAIR_LAG_MIN_TICKS + lagSpan * drift(tick / POLAIR_LAG_DRIFT_TICKS, seed ^ 0x0a11);
  trail.sample(tick, lag, DELAYED);
  trail.travel(tick, TRAVEL);
  let cx = DELAYED.x - TRAVEL.dx * POLAIR_TRAIL_BIAS_M;
  let cz = DELAYED.z - TRAVEL.dz * POLAIR_TRAIL_BIAS_M;
  // And the cap on how far behind that may put it. See `POLAIR_CENTRE_MAX_M`:
  // the lag is arrears in time, so in a car it is hundreds of metres, and without
  // this the machine ends up circling a street the player left ten seconds ago.
  // Everything downstream -- the slant band, and therefore the whole accuracy
  // curve -- is only bounded because this is.
  {
    const ox = cx - tx;
    const oz = cz - tz;
    const o2 = ox * ox + oz * oz;
    if (o2 > POLAIR_CENTRE_MAX_M * POLAIR_CENTRE_MAX_M) {
      const inv = POLAIR_CENTRE_MAX_M / Math.sqrt(o2);
      cx = tx + ox * inv;
      cz = tz + oz * inv;
    }
  }
  out.centreX = cx;
  out.centreZ = cz;

  // --- The lap. The phase is offset per player so two suspects in one street
  //     are not flown in formation.
  const phase = tick / POLAIR_ORBIT_TICKS + unit01(carHash(seed, 0x0b11));
  const u = phase - Math.floor(phase);
  out.orbitPhase = u;
  orbitPoint(u, RADIAL);

  const radiusSpan = POLAIR_RADIUS_MAX_M - POLAIR_RADIUS_MIN_M;
  const radius = POLAIR_RADIUS_MIN_M
    + radiusSpan * drift(tick / POLAIR_RADIUS_DRIFT_TICKS, seed ^ 0x0c11);
  const altitudeSpan = POLAIR_ALTITUDE_MAX_M - POLAIR_ALTITUDE_MIN_M;
  const altitude = POLAIR_ALTITUDE_MIN_M
    + altitudeSpan * drift(tick / POLAIR_ALTITUDE_DRIFT_TICKS, seed ^ 0x0d11);
  out.radius = radius;
  out.altitude = altitude;

  let ax = cx + RADIAL.dx * radius;
  let az = cz + RADIAL.dz * radius;

  // --- The keep-out, against the **live** target rather than the centre.
  //
  // See `POLAIR_KEEPOUT_M`: the centre is a delayed and biased point, so a
  // player sprinting at the machine can close on it faster than the centre
  // moves and the orbit radius alone does not bound the plan separation. Pushed
  // straight out along the bearing it is already on, which keeps the direction
  // it is being seen from and only changes how far away it is.
  const kx = ax - tx;
  const kz = az - tz;
  const k2 = kx * kx + kz * kz;
  if (k2 < POLAIR_KEEPOUT_M * POLAIR_KEEPOUT_M) {
    if (k2 < 1e-6) {
      // Directly overhead to the millimetre, which is the one bearing that has
      // no outward direction. Pushed out along the orbit's own radial, which is
      // always a unit vector.
      ax = tx + RADIAL.dx * POLAIR_KEEPOUT_M;
      az = tz + RADIAL.dz * POLAIR_KEEPOUT_M;
    } else {
      const inv = POLAIR_KEEPOUT_M / Math.sqrt(k2);
      ax = tx + kx * inv;
      az = tz + kz * inv;
    }
  }
  out.x = ax;
  out.y = ty + altitude;
  out.z = az;

  // --- The nose. The tangent of the circle, which for this parameterisation is
  //     the radial turned a quarter turn: the lap runs clockwise in (x, z).
  out.dx = RADIAL.dz;
  out.dz = -RADIAL.dx;

  // --- The slant range, which is the marksman's range and the rotor's distance.
  const sx = ax - tx;
  const sy = out.y - ty;
  const sz = az - tz;
  out.slant = Math.sqrt(sx * sx + sy * sy + sz * sz);

  // --- The beam: locked on you, or hunting where you were.
  const cycle = polairCycle(tick);
  const start = lockStart(seed, cycle);
  const length = lockLength(seed, cycle);
  const into = tick - cycle * POLAIR_LOCK_CYCLE_TICKS;
  const locked = into >= start && into < start + length;
  out.locked = locked;
  out.lockT = locked ? (into - start) / length : 0;
  if (locked) {
    out.beamX = tx;
    out.beamZ = tz;
  } else {
    // A figure-of-eight: one axis at the sweep rate and the other at twice it,
    // which is the 1:2 Lissajous. Made of triangles rather than sines, so it is
    // a bowtie of straight legs -- which is what a light being swung by hand
    // actually traces, and reads better than the lazy oval a sine pair gives.
    //
    // Centred on the **orbit's own centre** rather than on the raw delayed
    // sample, which is the same clamped, bias-shifted point the machine is flying
    // around -- so the beam hunts the ground the player came over and never more
    // than `POLAIR_CENTRE_MAX_M` plus the sweep away from them. Using the raw
    // sample instead put the searchlight two blocks behind a player in a car,
    // which is not a search: it is a light pointed at nothing.
    const su = tick / POLAIR_SWEEP_TICKS + unit01(carHash(seed, 0x0e11));
    out.beamX = cx + triangle(su) * POLAIR_SWEEP_M;
    out.beamZ = cz + triangle(su * 2 + 0.37) * POLAIR_SWEEP_M * 0.6;
  }

  // --- The flicker: haze and the beam moving through it. Two clocks so it does
  //     not read as a square wave, and bounded to exactly +-POLAIR_FLICKER.
  const fa = triangle(tick / POLAIR_FLICKER_A_TICKS);
  const fb = triangle(tick / POLAIR_FLICKER_B_TICKS + 0.21);
  out.flicker = 1 + POLAIR_FLICKER * 0.5 * (fa + fb);

  return out;
}

// --- The self-check -----------------------------------------------------------------

/**
 * Everything about this feature that fails by producing a plausible night.
 *
 * None of it throws, which is this project's criterion, and every one of them
 * has been available to a reader of the constants alone and was not noticed:
 *
 *   - An **orbit that drifts inside the player** is a helicopter clipping
 *     through a body at 200 km/h, and the frame it happens in looks like a
 *     glitch rather than like a bounds violation.
 *   - A **lock duty cycle near one** is the old ceiling lamp back again, with all
 *     of this file's machinery running and none of its effect. The complaint
 *     that reaches the owner is "it feels the same", which reads as the work not
 *     having been done.
 *   - A **cone as bright as the old one** is the same, one constant along.
 *   - A **shot fired while searching** is a round out of a light pointing
 *     somewhere else, which is unreadable rather than unfair.
 *   - A **hit chance at the floor of `factions.hitChance`** -- 12 % -- is a
 *     five-star player taking a pip every ten seconds from something they
 *     cannot fight, which is the exact opposite of "shot inaccurately more
 *     often".
 *   - A **shot cadence faster than its own minimum** turns a threat into a
 *     damage source with no message anywhere.
 *   - And **two processes disagreeing about the orbit** is the seam this whole
 *     file's determinism discipline exists to close; it is checked by running
 *     two independent trails through identical inputs and comparing bits.
 */
export function verifyPolair(): string[] {
  const failures: string[] = [];

  // --- The constants, and the orderings a tuning pass breaks.
  if (!(POLAIR_RADIUS_MIN_M < POLAIR_RADIUS_MAX_M)) {
    failures.push(
      `The orbit radius runs ${POLAIR_RADIUS_MIN_M}..${POLAIR_RADIUS_MAX_M} m, which is not a range. ` +
        'The drift would be a constant and the orbit would never wobble.',
    );
  }
  if (!(POLAIR_ALTITUDE_MIN_M < POLAIR_ALTITUDE_MAX_M)) {
    failures.push(`The altitude runs ${POLAIR_ALTITUDE_MIN_M}..${POLAIR_ALTITUDE_MAX_M} m, which is not a range.`);
  }
  if (!(POLAIR_KEEPOUT_M > 0 && POLAIR_KEEPOUT_M < POLAIR_RADIUS_MIN_M)) {
    failures.push(
      `The keep-out is ${POLAIR_KEEPOUT_M} m and the smallest orbit is ${POLAIR_RADIUS_MIN_M} m. ` +
        'A keep-out at or past the radius would clamp every tick of every lap, so the orbit would ' +
        'collapse onto a circle of exactly the keep-out and stop being an orbit at all.',
    );
  }
  if (!(POLAIR_LAG_MIN_TICKS > 0 && POLAIR_LAG_MIN_TICKS < POLAIR_LAG_MAX_TICKS)) {
    failures.push('The pursuit lag is not a positive range; the orbit would be centred on the player and read as a lamp.');
  }
  if (POLAIR_LAG_MAX_TICKS >= POLAIR_TRAIL_SLOTS * POLAIR_TRAIL_STRIDE) {
    failures.push(
      `The lag reaches ${POLAIR_LAG_MAX_TICKS} ticks back and the trail only holds ` +
        `${POLAIR_TRAIL_SLOTS * POLAIR_TRAIL_STRIDE}. Every sample would fall through to the newest ` +
        'position, so the lag would silently be zero and the chase would be a lamp again.',
    );
  }
  if (!(POLAIR_CONE_DEG >= 6 && POLAIR_CONE_DEG <= 8)) {
    failures.push(
      `The searchlight opens ${POLAIR_CONE_DEG} degrees and a searchlight is 6 to 8. ` +
        'Wider is a floodlight, which is the old build; narrower is a laser pointer.',
    );
  }
  if (!(POLAIR_INTENSITY <= POLAIR_INTENSITY_WAS * 0.45)) {
    failures.push(
      `The cone is ${POLAIR_INTENSITY} against the old ${POLAIR_INTENSITY_WAS}, which is ` +
        `${(POLAIR_INTENSITY / POLAIR_INTENSITY_WAS).toFixed(2)} of it. The brief is "less bright" and ` +
        'the ceiling is 0.45; anything above that is the old lamp with a new orbit.',
    );
  }
  if (!(POLAIR_INTENSITY > 0)) failures.push('The searchlight has no intensity; the beam would be invisible at night.');
  if (!(POLAIR_FLICKER > 0 && POLAIR_FLICKER < 0.5)) {
    failures.push(`The beam flickers by ${POLAIR_FLICKER}; at 0 it is a fluorescent tube and past 0.5 it is a fault.`);
  }
  if (!(POLAIR_SWEEP_M > 0)) failures.push('The search pattern has no extent; the beam would hunt one point.');
  if (!(POLAIR_MISS_MIN_M > 0 && POLAIR_MISS_MIN_M < POLAIR_MISS_MAX_M)) {
    failures.push('A miss lands between two distances that are not a range; every round would hit the same paving stone.');
  }
  if (POLAIR_ROUND_SPEED <= POLAIR_SOUND_SPEED) {
    failures.push(
      `The round travels ${POLAIR_ROUND_SPEED} m/s and its report ${POLAIR_SOUND_SPEED}. Subsonic, so the ` +
        'crack would arrive before the strike and the whole delayed-report effect would be backwards.',
    );
  }

  // --- The strobe, which is the one fixed clock in the file.
  if (!(POLAIR_STROBE_PERIOD_S > 0.6 && POLAIR_STROBE_PERIOD_S < 2)) {
    failures.push(
      `The anti-collision strobe runs at ${POLAIR_STROBE_PERIOD_S} s. An aircraft's is about a second; ` +
        'faster reads as a police light bar and slower as a fault lamp.',
    );
  }
  {
    const duty = (POLAIR_STROBE_FLASH_S * 2) / POLAIR_STROBE_PERIOD_S;
    if (!(duty > 0 && duty < 0.25)) {
      failures.push(
        `The strobe is lit ${(duty * 100).toFixed(0)}% of its period. Past a quarter it is a lamp that ` +
          'occasionally goes out rather than a flash, which is the read that makes it an aircraft.',
      );
    }
    if (POLAIR_STROBE_SECOND_S + POLAIR_STROBE_FLASH_S >= POLAIR_STROBE_PERIOD_S) {
      failures.push('The second pulse of the double flash falls outside its own period; it would never be seen.');
    }
  }

  // --- The waves everything rests on.
  if (Math.abs(triangle(0) + 1) > 1e-9) failures.push('The triangle wave does not start at -1.');
  if (Math.abs(triangle(0.5) - 1) > 1e-9) failures.push('The triangle wave does not peak at its half period.');
  if (Math.abs(triangle(0.25) - triangle(3.25)) > 1e-9) {
    failures.push('The triangle wave is not periodic; every drift in this file would walk off its range.');
  }
  {
    // The circle, which is the whole of the no-`sin` argument. Every parameter
    // has to land on the unit circle to the last few bits, or the orbit radius
    // is a lie and the keep-out is measured against the wrong distance.
    let worst = 0;
    let span = 0;
    let minDx = 1;
    let maxDx = -1;
    for (let i = 0; i <= 512; i++) {
      orbitPoint(i / 512, RADIAL);
      const l = Math.sqrt(RADIAL.dx * RADIAL.dx + RADIAL.dz * RADIAL.dz);
      worst = Math.max(worst, Math.abs(l - 1));
      minDx = Math.min(minDx, RADIAL.dx);
      maxDx = Math.max(maxDx, RADIAL.dx);
    }
    span = maxDx - minDx;
    if (worst > 1e-12) {
      failures.push(
        `orbitPoint leaves the unit circle by ${worst.toExponential(2)}. The orbit radius would not be the ` +
          'radius and the keep-out would be measured against a different distance every tick.',
      );
    }
    if (span < 1.99) {
      failures.push(
        `orbitPoint only sweeps ${span.toFixed(3)} of the x axis, so it does not go all the way round. ` +
          'The helicopter would orbit an arc and always be seen from the same side.',
      );
    }
  }
  for (let i = 0; i < 64; i++) {
    const v = drift(i / 7.3, 0x1234 + i);
    if (!(v >= -1e-9 && v <= 1 + 1e-9)) {
      failures.push(`drift reached ${v.toFixed(4)}, outside [0, 1]. Radius and altitude would leave their ranges.`);
      break;
    }
  }

  // --- The accuracy curve. The brief's numbers, as a relation.
  {
    const at200 = polairHitChance(200);
    if (!(at200 > 0 && at200 <= 0.10)) {
      failures.push(
        `A round from 200 m of slant lands ${(at200 * 100).toFixed(1)}% of the time. The design is a ` +
          'marksman who misses: above 10% he is a damage source, at 0 he is a firework.',
      );
    }
    // Monotone, and steeply so over the band the orbit actually produces. The two
    // anchors are read back through `polairHitChance` rather than compared as
    // constants, so a mistake in the *derivation* of the slope and the intercept
    // shows up here rather than shipping.
    const near = polairHitChance(POLAIR_SLANT_NEAR_M);
    const far = polairHitChance(POLAIR_SLANT_FAR_M);
    if (!(near > far)) {
      failures.push(
        `The hit chance is ${(near * 100).toFixed(1)}% at the near anchor and ${(far * 100).toFixed(1)}% at ` +
          'the far one. It has to fall with range or there is no reason to prefer the far side of the street.',
      );
    }
    if (Math.abs(near - POLAIR_HIT_NEAR) > 1e-9 || Math.abs(far - POLAIR_HIT_FAR) > 1e-9) {
      failures.push(
        `The curve reads ${(near * 100).toFixed(2)}% / ${(far * 100).toFixed(2)}% at its own two anchors and ` +
          `the design says ${(POLAIR_HIT_NEAR * 100).toFixed(2)}% / ${(POLAIR_HIT_FAR * 100).toFixed(2)}%. ` +
          'The slope and the intercept are derived from those two, so they have disagreed with their own ' +
          'derivation -- which means the clamp is biting inside the band and every round is at the floor.',
      );
    }
    if (!(near >= 0.05 && near <= 0.09)) {
      failures.push(
        `At the nearest slant this orbit allows the chance is ${(near * 100).toFixed(1)}%; the design is ` +
          '5-8%. Outside that the marksman is either free damage or pure theatre.',
      );
    }
    if (far > 0.03) {
      failures.push(`At the furthest slant the chance is still ${(far * 100).toFixed(1)}%; it should be under 3%.`);
    }
    if (!(POLAIR_SLANT_NEAR_M > 100 && POLAIR_SLANT_FAR_M > POLAIR_SLANT_NEAR_M)) {
      failures.push(
        `The slant band derives as ${POLAIR_SLANT_NEAR_M.toFixed(0)}..${POLAIR_SLANT_FAR_M.toFixed(0)} m, ` +
          'which is not a band a helicopter could fly. The accuracy curve is a division by that width.',
      );
    }
    // And the ground ladder must be untouched by the parametrisation: 55% at
    // 15 m is the number `factions.hitChance` was specified with.
    if (Math.abs(hitChance(15) - 0.55) > 1e-9) {
      failures.push(
        `A constable at 15 m now hits ${(hitChance(15) * 100).toFixed(1)}% of the time and the ladder's own ` +
          'number is 55. Parametrising the miss model has changed its defaults, which is the one thing it ' +
          'must not do -- see the brief for workstream R.',
      );
    }
  }

  // --- The whole thing driven: ten minutes of ticks against a moving target.
  failures.push(...verifyOrbit());
  failures.push(...verifyDeterminism());

  return failures;
}

/**
 * Ten minutes of ticks with a player running around, and every bound asserted
 * as a measurement rather than as arithmetic over the constants.
 *
 * The target walks a deterministic, deliberately awkward path: a fast wander
 * that reverses, so the trail's travel direction flips and the lag's arrears
 * work both ways. That is the case the keep-out exists for -- a player who turns
 * and sprints at the machine -- and it is the one a static target would never
 * exercise.
 */
function verifyOrbit(): string[] {
  const failures: string[] = [];
  const trail = new PolairTrail();
  const pose = createPolairPose();
  const ticks = 10 * 60 * 60;
  const first = 1_000_000;

  let minPlan = Infinity;
  let maxPlan = 0;
  let minAlt = Infinity;
  let maxAlt = 0;
  let minSlant = Infinity;
  let maxSlant = 0;
  let lockedTicks = 0;
  let shots = 0;
  let shotsWhileSearching = 0;
  let lastShot = -1;
  let worstShotGap = Infinity;
  let lastLockedAt = -1;
  let lockStarts = 0;
  let minLockGap = Infinity;
  let maxLockGap = 0;
  let beamOffLocked = 0;
  let flickerLow = Infinity;
  let flickerHigh = -Infinity;

  let wasLocked = false;
  for (let i = 0; i < ticks; i++) {
    const tick = first + i;
    // The path: two triangles at incommensurate rates over an 800 m box, which
    // reverses direction every couple of minutes and runs at 12 and 14 m/s on the
    // two axes -- about 18 m/s combined, which is a car in traffic. Faster than a
    // sprint on purpose: the bounds have to hold for a player who is driving, and
    // the first cut of this generator ran at 220 m/s, which is what found
    // `POLAIR_CENTRE_MAX_M`. Slopes are amplitude * 4 / period, so those two
    // periods are what the speeds are; changing one without the other quietly
    // stops testing the fast case.
    const px = 400 * triangle(i / 8000);
    const pz = 300 * triangle(i / 5300 + 0.3);
    const py = 12;
    trail.push(tick, px, py, pz);
    polairPose(9, tick, px, py, pz, trail, pose);

    const plan = Math.sqrt((pose.x - px) * (pose.x - px) + (pose.z - pz) * (pose.z - pz));
    minPlan = Math.min(minPlan, plan);
    maxPlan = Math.max(maxPlan, plan);
    minAlt = Math.min(minAlt, pose.altitude);
    maxAlt = Math.max(maxAlt, pose.altitude);
    minSlant = Math.min(minSlant, pose.slant);
    maxSlant = Math.max(maxSlant, pose.slant);
    flickerLow = Math.min(flickerLow, pose.flicker);
    flickerHigh = Math.max(flickerHigh, pose.flicker);

    if (pose.locked) {
      lockedTicks++;
      // A lock that does not put the beam on the player is a lock in name only.
      if (Math.abs(pose.beamX - px) > 1e-9 || Math.abs(pose.beamZ - pz) > 1e-9) beamOffLocked++;
      if (!wasLocked) {
        lockStarts++;
        if (lastLockedAt >= 0) {
          const gap = tick - lastLockedAt;
          minLockGap = Math.min(minLockGap, gap);
          maxLockGap = Math.max(maxLockGap, gap);
        }
        lastLockedAt = tick;
      }
    }
    wasLocked = pose.locked;

    // The two schedule functions have to agree with the pose about the lock,
    // because the authority asks them without building a pose at all.
    if (polairLocked(9, tick) !== pose.locked) {
      failures.push(`polairLocked and polairPose disagree about the lock at tick ${tick}.`);
      break;
    }
    if (polairShotFired(9, tick)) {
      shots++;
      if (!pose.locked) shotsWhileSearching++;
      if (lastShot >= 0) worstShotGap = Math.min(worstShotGap, tick - lastShot);
      lastShot = tick;
    }
  }

  // --- The geometry.
  if (minPlan < POLAIR_KEEPOUT_M - 1e-6) {
    failures.push(
      `Over ten minutes the airframe came within ${minPlan.toFixed(1)} m of the player in plan and the ` +
        `keep-out is ${POLAIR_KEEPOUT_M}. That is a helicopter flying through somebody.`,
    );
  }
  if (maxPlan > POLAIR_RADIUS_MAX_M + POLAIR_CENTRE_MAX_M + 1e-6) {
    failures.push(
      `The airframe reached ${maxPlan.toFixed(0)} m out in plan against a bound of ` +
        `${POLAIR_RADIUS_MAX_M} + ${POLAIR_CENTRE_MAX_M}. The centre cap has stopped holding, so the ` +
        'machine is circling a street the player left ten seconds ago -- and the accuracy curve, which is ' +
        'anchored on this bound, is being evaluated off the end of itself.',
    );
  }
  if (minAlt < POLAIR_ALTITUDE_MIN_M - 1e-6 || maxAlt > POLAIR_ALTITUDE_MAX_M + 1e-6) {
    failures.push(
      `The altitude ranged ${minAlt.toFixed(0)}..${maxAlt.toFixed(0)} m against the stated ` +
        `${POLAIR_ALTITUDE_MIN_M}..${POLAIR_ALTITUDE_MAX_M}. The drift has left its range.`,
    );
  }
  // The measured slant band against the **derived** one the accuracy curve is
  // anchored on. This is the assertion that keeps the geometry and the marksman
  // describing the same helicopter, and it is the one the first cut of this file
  // failed: the derivation is only as good as the bounds it is derived from.
  if (minSlant < POLAIR_SLANT_NEAR_M - 1e-6 || maxSlant > POLAIR_SLANT_FAR_M + 1e-6) {
    failures.push(
      `The slant range measured ${minSlant.toFixed(0)}..${maxSlant.toFixed(0)} m and the accuracy curve is ` +
        `anchored on ${POLAIR_SLANT_NEAR_M.toFixed(0)}..${POLAIR_SLANT_FAR_M.toFixed(0)}. Outside the ` +
        'anchors the line is clamped, so every round is at the floor and the falloff has stopped existing.',
    );
  }
  if (!(flickerLow >= 1 - POLAIR_FLICKER - 1e-9 && flickerHigh <= 1 + POLAIR_FLICKER + 1e-9)) {
    failures.push(
      `The beam's flicker ranged ${flickerLow.toFixed(3)}..${flickerHigh.toFixed(3)} against a stated ` +
        `+-${POLAIR_FLICKER}. A cone that dips to nothing reads as the light failing.`,
    );
  }

  // --- The lock, measured.
  {
    const duty = lockedTicks / ticks;
    if (!(duty >= 0.10 && duty <= 0.30)) {
      failures.push(
        `The beam holds the player ${(duty * 100).toFixed(1)}% of the time. Under 10% it never finds you ` +
          'and over 30% it is the old ceiling lamp with extra machinery.',
      );
    }
    if (lockStarts < 40) {
      failures.push(`Only ${lockStarts} locks in ten minutes; the schedule is not running.`);
    }
    if (minLockGap < 8 * 60) {
      failures.push(
        `Two locks came ${(minLockGap / 60).toFixed(1)} s apart and the design says 8 to 15. Back-to-back ` +
          'locks are back-to-back rounds, which is the marksman becoming a damage source by accident.',
      );
    }
    if (maxLockGap > 15 * 60) {
      failures.push(
        `Locks went ${(maxLockGap / 60).toFixed(1)} s apart and the design says 8 to 15. Longer and the ` +
          'beam never finds you at all within one pursuit.',
      );
    }
    if (beamOffLocked > 0) {
      failures.push(`${beamOffLocked} locked ticks aimed the beam somewhere other than the player.`);
    }
  }

  // --- The shots.
  if (shots < 40) failures.push(`Only ${shots} rounds in ten minutes of being locked onto; the marksman is asleep.`);
  if (shotsWhileSearching > 0) {
    failures.push(
      `${shotsWhileSearching} rounds left the airframe while the beam was searching. A shot out of a light ` +
        'pointing somewhere else is unreadable: the player has no way to know it was aimed at them.',
    );
  }
  if (worstShotGap < POLAIR_SHOT_MIN_TICKS) {
    failures.push(
      `Two rounds came ${(worstShotGap / 60).toFixed(1)} s apart and the cooldown is ` +
        `${POLAIR_SHOT_MIN_TICKS / 60} s. The cadence has stopped being a cadence.`,
    );
  }
  if (shots !== lockStarts) {
    failures.push(
      `${shots} rounds against ${lockStarts} locks. One round per lock is the design; a mismatch means the ` +
        'aim offset has fallen outside some lock lengths and those locks are silent.',
    );
  }

  // --- And the misses land where they are supposed to.
  {
    const at = { x: 0, z: 0, distance: 0 };
    let near = Infinity;
    let far = 0;
    for (let c = 0; c < 400; c++) {
      polairMiss(9, c, 100, -200, at);
      const d = Math.sqrt((at.x - 100) * (at.x - 100) + (at.z + 200) * (at.z + 200));
      if (Math.abs(d - at.distance) > 1e-6) {
        failures.push('polairMiss reports a distance it did not scatter to.');
        break;
      }
      near = Math.min(near, d);
      far = Math.max(far, d);
    }
    if (near < POLAIR_MISS_MIN_M - 1e-6 || far > POLAIR_MISS_MAX_M + 1e-6) {
      failures.push(
        `Misses landed ${near.toFixed(2)}..${far.toFixed(2)} m from the player against a stated ` +
          `${POLAIR_MISS_MIN_M}..${POLAIR_MISS_MAX_M}. Inside the minimum it reads as a hit that did no ` +
          'damage; outside the maximum the player never sees it.',
      );
    }
  }

  return failures;
}

/**
 * Two instances, fed identically, agreeing bit for bit.
 *
 * The property the whole no-transcendental discipline is for, and the only
 * honest way to test it: build two trails, push the same path into both, and
 * compare every field of the pose plus the beam and the scatter. A failure here
 * is a `Math.sin` somebody added, and its symptom in a session would be the
 * client drawing a helicopter a few metres from the one the server shot at you
 * with -- which nobody would ever attribute to arithmetic.
 */
function verifyDeterminism(): string[] {
  const failures: string[] = [];
  const a = new PolairTrail();
  const b = new PolairTrail();
  const pa = createPolairPose();
  const pb = createPolairPose();
  const ma = { x: 0, z: 0, distance: 0 };
  const mb = { x: 0, z: 0, distance: 0 };
  const first = 2_500_000;
  for (let i = 0; i < 4000; i++) {
    const tick = first + i;
    const px = 210 * triangle(i / 199);
    const pz = -140 * triangle(i / 111 + 0.7);
    a.push(tick, px, 3, pz);
    b.push(tick, px, 3, pz);
    polairPose(4, tick, px, 3, pz, a, pa);
    polairPose(4, tick, px, 3, pz, b, pb);
    for (const key of [
      'x', 'y', 'z', 'dx', 'dz', 'radius', 'altitude',
      'centreX', 'centreZ', 'beamX', 'beamZ', 'lockT', 'flicker', 'slant', 'orbitPhase',
    ] as const) {
      if (pa[key] !== pb[key]) {
        failures.push(
          `Two Polair instances handed the same history disagree about ${key} at tick ${tick} ` +
            `(${pa[key]} against ${pb[key]}). Something in the orbit is not exact arithmetic.`,
        );
        return failures;
      }
    }
    if (pa.locked !== pb.locked) {
      failures.push(`Two Polair instances disagree about the lock at tick ${tick}.`);
      return failures;
    }
    const cycle = polairCycle(tick);
    polairMiss(4, cycle, px, pz, ma);
    polairMiss(4, cycle, px, pz, mb);
    if (ma.x !== mb.x || ma.z !== mb.z) {
      failures.push(`Two Polair instances scatter a miss differently at tick ${tick}.`);
      return failures;
    }
    if (polairRoll(4, cycle) !== polairRoll(4, cycle)) {
      failures.push('The marksman roll is not a pure function of the player and the lock cycle.');
      return failures;
    }
  }
  return failures;
}
