/**
 * The day/night cycle: one real hour is one Sydney day.
 *
 * **This is the "what time is it and how dark is it" module.** Everything that
 * wants to know -- the sky, the light rig, the street lamps, the lit windows,
 * the clock on the HUD, and anything that behaves differently after dark -- asks
 * `skyClock()` and nothing else. It is the only clock in the project that
 * produces a *time of day*, and it has one property that decides its whole
 * shape:
 *
 *   **It is a pure function of the wall clock, so every player has the same
 *   sky without a single byte crossing the wire.**
 *
 * That is `game/traffic.ts`'s trick, deliberately reused. `TRAFFIC_EPOCH_MS`
 * makes the timetable a pure function of `Date.now()`, so a client that has
 * never spoken to the server still places every car where the server would --
 * and the same argument applies here with more force, because the sky is drawn
 * before the socket is open and would otherwise pop the moment a welcome
 * arrived. There is no protocol field for the time of day and there must not be
 * one: two machines whose clocks agree to a second agree about the sky to within
 * a fortieth of a game-minute, far tighter than anything a snapshot stream could
 * hold.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING, in one paragraph.
 *
 * A cycle is **one real hour**, and it is cut into four quarters at the four
 * moments that matter:
 *
 *     phase 0.00   the dead of night   (solar midnight, sun 56 deg *under*)
 *     phase 0.25   sunrise             (SUNRISE_PHASE)
 *     phase 0.50   solar noon          (sun 56.3 deg up, due north)
 *     phase 0.75   sunset              (SUNSET_PHASE)
 *     phase 1.00   the dead of night again -- and the loop closes
 *
 * So the sun is up for exactly the middle half hour and down for exactly the
 * other, which is the brief's 30/30. Inside each stretch the rate is eased so
 * the sun loiters near the horizon -- see `HORIZON_DWELL`, which is where the
 * sunset gets its running time.
 *
 * **The loop closes at solar midnight, and that is the one structural decision
 * in this file.** A replayed day has to jump a date somewhere: the segment that
 * ends the cycle is a *different night* from the one that begins it, one day
 * later, and at the equinox one day of declination drift moves the sun by about
 * 0.4 degrees. Put that seam at sunrise -- the obvious place, and where the
 * first cut of this file put it -- and the rising sun hops backwards by
 * three-quarters of its own diameter, once every real hour, in the one part of
 * the sky everybody is looking at. Put it at solar midnight and the same 0.4
 * degrees happens to a sun that is 56 degrees below the horizon, in a black sky,
 * with `nightLevel` pinned at 1 on both sides. Nothing renders differently at
 * all. `verifyCycle` measures the step and bounds it.
 *
 * Everything downstream then works in *real Sydney time on a real date*, so
 * `solar.ts` does the celestial mechanics and nothing here has to know which way
 * the sun goes round. This module's entire job is `wall clock -> a Date`.
 * ---------------------------------------------------------------------------
 */

import { solarPosition, sydneyTime, type SolarPosition } from './solar.ts';
import { nightLevel } from './calibration.ts';

/**
 * Sydney. Repeated from `main.ts` so this file can be run standalone, and
 * **exported** so `sky.ts` can assert that the coordinates it was constructed
 * with are the ones the cycle was solved against -- the sunrise and sunset
 * instants below are latitude-dependent, so a `SydneySky` built for anywhere
 * else would run a cycle whose seams are not on its own horizon.
 */
export const SYDNEY_LATITUDE = -33.87;
export const SYDNEY_LONGITUDE = 151.21;
const LATITUDE = SYDNEY_LATITUDE;
const LONGITUDE = SYDNEY_LONGITUDE;

/**
 * One real hour per game day, in milliseconds.
 *
 * The user's number, and it is a good one for a reason worth writing down: a
 * session of this game is twenty minutes to an hour, so a player who stays sees
 * the whole cycle exactly once, and a player who drops in twice in an evening
 * gets a different sky each time. A four-hour cycle would mean most players only
 * ever saw the game in daylight; a ten-minute one would mean the sun visibly
 * moved while you crossed a street, which is what makes a day/night cycle read
 * as a gimmick rather than as weather.
 */
export const CYCLE_MS = 3_600_000;

/**
 * Phase zero. **2026-01-01T00:00:00Z**, the same instant as
 * `game/traffic.ts`'s `TRAFFIC_EPOCH_MS`; the two are asserted equal in
 * `server/integration-check.ts` rather than imported across, because this file
 * must stay free of the traffic decoder.
 *
 * It divides exactly by `CYCLE_MS`, and that is not a coincidence -- it is the
 * property that makes the cycle *legible from outside the game*. The hour turns
 * in the dead of night; the sun comes up at quarter past, is overhead at half
 * past, and sets at quarter to. Somebody who wants to show a friend the sunset
 * can look at their watch. Nothing depends on it -- the arithmetic is a modulo
 * either way -- but a shared clock nobody can predict is a shared clock that
 * feels random, and this one costs nothing to make predictable.
 */
export const CYCLE_EPOCH_MS = 1_767_225_600_000;

/** Where sunrise and sunset sit on the dial. The sun is up for the middle half. */
export const SUNRISE_PHASE = 0.25;
export const SUNSET_PHASE = 0.75;

/**
 * The fraction of the cycle the sun is up for. Half, by the brief: thirty
 * minutes of day and thirty of night.
 *
 * Derived from the two phases above rather than stated, so there is one place to
 * change and the three cannot drift apart. `verifyCycle` asserts the split
 * against the actual solar altitude rather than against this number, which is
 * the check that has teeth.
 */
export const DAY_SHARE = SUNSET_PHASE - SUNRISE_PHASE;

/**
 * **The date the cycle replays, and the single most consequential choice here.**
 *
 * 20 March 2026: the March equinox, and it wins on three separate counts.
 *
 *   1. **It is already 12/12, so the forced 30/30 is not a lie.** Measured with
 *      this project's own `solar.ts`, geometric sunrise to sunset on that date
 *      in Sydney is 12.016 h and the night either side of it is 11.96 to 12.00 h.
 *      Squeezed into half an hour each, the day runs at 24.03x real time and the
 *      night at 23.92-23.99x -- a spread of under half a per cent. So the sun's
 *      angular rate is continuous across sunrise and sunset to better than a part
 *      in two hundred, and the "Minecraft trick" the brief allows is not visible
 *      at all. A solstice was the alternative and it is a real one: 21 December
 *      gives 14.26 h of day against 9.75 h of night, so the sun would cross the
 *      sky at 28.5x by day and 19.5x by night -- a **46% step in speed at the two
 *      moments a player is most likely to be watching it**. That step is the whole
 *      cost of the dramatic light, and the light is not that different: December
 *      noon is 79.6 degrees against the equinox's 56.3.
 *
 *   2. **56.34 degrees is where this renderer is calibrated.** The entire light
 *      rig in `calibration.ts` -- the sun:shade ratios, the bounce fraction, the
 *      exposure, every predicted display value in that file and in `facade.ts` --
 *      was measured at 3 pm on 15 February, where the sun is at **57.11 degrees**.
 *      The measured transit on this date is 56.34. So the game's own noon lands
 *      0.77 degrees off the instant the whole renderer was tuned at, and
 *      `verifyLightRig`'s reference does not have to move by a hair. December
 *      would have put the game's brightest hour 22 degrees above anything anyone
 *      has ever checked.
 *
 *   3. **It reads well on a clock.** Sunrise 07:02, solar noon 13:03, sunset
 *      19:03, all AEDT -- daylight saving is still in force on 20 March (NSW ends
 *      it on the first Sunday in April) and `sydneyTime` knows. "The sun comes up
 *      at seven and goes down at seven" is a thing a player can hold in their
 *      head, and the HUD clock is more legible for it.
 */
export const CYCLE_DATE = { year: 2026, month: 3, day: 20 } as const;

/**
 * How much the clock slows down near the horizon, and **this is where the
 * sunset gets its running time.**
 *
 * Without it the mapping inside each stretch is linear: 12 hours in 30 minutes,
 * flat, 24x throughout. That is defensible, and it is also a sunset that is over
 * before you have turned round. Civil twilight at this latitude and date -- the
 * sun from +6 degrees to -6 -- is 58 minutes of real Sydney, which at a flat 24x
 * is **two minutes twenty**, split between a golden hour and a dusk. The best two
 * minutes of a real Sydney sunset would get about seventy seconds of them.
 *
 * So the rate inside each stretch is eased:
 *
 *     v(u) = u - (k / 2pi) * sin(2 pi u)        k = HORIZON_DWELL
 *     dv/du = 1 - k cos(2 pi u)
 *
 * which runs at `1 - k` at both ends and `1 + k` in the middle. At k = 0.5 the
 * sun moves at **half rate** through sunrise and sunset and at 1.5x through the
 * middle of the day and the middle of the night, and the areas cancel exactly --
 * `v(0) = 0`, `v(1/2) = 1/2`, `v(1) = 1` -- so the halves are still exactly
 * thirty minutes each and solar noon is still exactly on the half. Measured
 * through the finished mapping: **the golden hour (the sun above the horizon and
 * under 6 degrees) lasts 139 real seconds and the dusk that follows it (0 down to
 * -6) another 139**, at each end of the day.
 *
 * The honest justification is the brief's own: this is a game, and a real Sydney
 * sunset's best two minutes deserve to be two minutes of a thirty-minute day.
 * What it costs is that the sun is not moving at a constant multiple of real
 * time -- but it is moving along an exactly real arc, in the right direction, at
 * a rate that varies smoothly and has no corner in it anywhere, which is a long
 * way from the thing the brief warns about. Nobody can see a rate that changes by
 * half a per cent per game-second; everybody can see a sunset that lasts a
 * minute.
 *
 * **Must stay under 1.** At k = 1 the derivative touches zero at the horizon and
 * the clock stops dead there; above it the clock runs backwards, which would put
 * the sun back up after it had set. `verifyCycle` asserts monotonicity directly
 * rather than trusting this paragraph.
 */
export const HORIZON_DWELL = 0.5;

/* ---------------------------------------------------------------------------
 * The four instants the mapping is stretched between, solved from `solar.ts` at
 * module load rather than written down.
 *
 * A literal here would be a second source of truth about where the sun is, and
 * the failure mode is a seam: the cycle would hand the renderer an instant at
 * which the sun is a tenth of a degree under the horizon, and the day would
 * begin with the lamps on and the sky black for two seconds. Solving means the
 * seams land on altitude zero by construction, whatever anyone later does to
 * `solar.ts` or to `CYCLE_DATE`.
 *
 * The solve is a one-minute scan for each sign change followed by 40 bisections
 * -- about 4,500 evaluations of a 60-flop function, comfortably under two
 * milliseconds, once, at import. Measured at 5.2 ms including `verifyCycle`'s
 * own 23,000-sample sweep.
 * ------------------------------------------------------------------------- */

function altitudeAt(ms: number): number {
  return solarPosition(new Date(ms), LATITUDE, LONGITUDE).altitude;
}

/** Bisect an altitude sign change bracketed by `[a, b]` down to under a millisecond. */
function horizonCrossing(a: number, b: number): number {
  const startSign = Math.sign(altitudeAt(a));
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    if (Math.sign(altitudeAt(mid)) === startSign) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

/** Sunrise and sunset (geometric -- altitude exactly zero) for one Sydney date. */
function horizonsOn(year: number, month: number, day: number): { rise: number; set: number } {
  const midnight = sydneyTime(year, month, day, 0).getTime();
  let rise = 0;
  let set = 0;
  let previous = altitudeAt(midnight);
  for (let minute = 1; minute <= 24 * 60; minute++) {
    const t = midnight + minute * 60_000;
    const altitude = altitudeAt(t);
    if (previous < 0 && altitude >= 0) rise = horizonCrossing(t - 60_000, t);
    if (previous > 0 && altitude <= 0) set = horizonCrossing(t - 60_000, t);
    previous = altitude;
  }
  return { rise, set };
}

const YESTERDAY = /*#__PURE__*/ horizonsOn(CYCLE_DATE.year, CYCLE_DATE.month, CYCLE_DATE.day - 1);
const TODAY = /*#__PURE__*/ horizonsOn(CYCLE_DATE.year, CYCLE_DATE.month, CYCLE_DATE.day);
const TOMORROW = /*#__PURE__*/ horizonsOn(CYCLE_DATE.year, CYCLE_DATE.month, CYCLE_DATE.day + 1);

/** Sunrise on `CYCLE_DATE`, epoch ms. Phase `SUNRISE_PHASE`. */
export const SUNRISE_MS = TODAY.rise;
/** Sunset on `CYCLE_DATE`, epoch ms. Phase `SUNSET_PHASE`. */
export const SUNSET_MS = TODAY.set;

/**
 * The two nights either side of the replayed day, as `[sunset, sunrise]` pairs.
 *
 * There are two of them rather than one because the cycle's *ends* are both the
 * middle of a night, and the middle that closes the loop is one day after the
 * middle that opens it. `NIGHT_BEFORE` carries the small hours that lead into
 * `SUNRISE_MS`; `NIGHT_AFTER` carries the ones that follow `SUNSET_MS`. They
 * differ in length by 128 seconds of real Sydney, which is 0.3% of a night --
 * see `verifyCycle`'s rate check.
 */
const NIGHT_BEFORE = { from: YESTERDAY.set, to: TODAY.rise };
const NIGHT_AFTER = { from: TODAY.set, to: TOMORROW.rise };

/** How long the replayed day is, in real Sydney ms. */
export const DAY_LENGTH_MS = SUNSET_MS - SUNRISE_MS;
/** And the night that follows it. The one before it is 128 s shorter. */
export const NIGHT_LENGTH_MS = NIGHT_AFTER.to - NIGHT_AFTER.from;

/**
 * The dwell easing. Maps `[0, 1]` onto `[0, 1]`: monotone, symmetric about the
 * half, slower at the ends. See `HORIZON_DWELL`.
 */
export function cycleEase(u: number): number {
  return u - (HORIZON_DWELL / (2 * Math.PI)) * Math.sin(2 * Math.PI * u);
}

/**
 * Where in the cycle a wall-clock instant falls: 0 in the dead of night, 0.25 at
 * sunrise, 0.75 at sunset, wrapping at 1.
 *
 * Exactly specified arithmetic -- a subtraction, a `%` and a divide -- so two
 * processes handed the same millisecond produce the same double. That is the
 * whole basis of the shared sky.
 */
export function cyclePhase(nowMs: number): number {
  const t = (nowMs - CYCLE_EPOCH_MS) % CYCLE_MS;
  return (t < 0 ? t + CYCLE_MS : t) / CYCLE_MS;
}

/**
 * The Sydney instant a phase corresponds to, in epoch ms.
 *
 * Three stretches -- the back half of one night, the day, the front half of the
 * next -- each with the dwell easing inside it. The two joins are `SUNRISE_MS`
 * and `SUNSET_MS` *exactly*, from both sides, so the sky is continuous through
 * both of the moments anybody watches. The only jump is at phase 0, and it is a
 * whole day, taken in the dark. See the header.
 */
export function cycleInstant(phase: number): number {
  if (phase < SUNRISE_PHASE) {
    // The small hours: the second half of the night before. `u` runs 0.5 -> 1.
    const u = 0.5 + phase / DAY_SHARE;
    return NIGHT_BEFORE.from + cycleEase(u) * (NIGHT_BEFORE.to - NIGHT_BEFORE.from);
  }
  if (phase < SUNSET_PHASE) {
    return SUNRISE_MS + cycleEase((phase - SUNRISE_PHASE) / DAY_SHARE) * DAY_LENGTH_MS;
  }
  // The evening: the first half of the night after. `u` runs 0 -> 0.5.
  const u = (phase - SUNSET_PHASE) / DAY_SHARE;
  return NIGHT_AFTER.from + cycleEase(u) * NIGHT_LENGTH_MS;
}

/**
 * Everything anyone needs to know about the time of day at one instant.
 *
 * **This interface is the contract with the rest of the game.** Read `night` if
 * you want to know how dark it is, `isDay` if you want a boolean, `phase` if you
 * want to place something on the cycle, and `date` if you want to ask `solar.ts`
 * something it has not been asked yet. Nothing outside `sky/` should be
 * computing a solar position of its own or comparing an altitude against a
 * threshold it picked -- there is exactly one night ramp in this project and it
 * is `night` below.
 */
export interface SkyClock {
  /** The wall-clock instant this was computed for, scrub included. */
  nowMs: number;
  /** 0..1 through the cycle. 0.25 is sunrise, 0.75 is sunset, 0 is the dead of night. */
  phase: number;
  /** The sun is above the horizon: `SUNRISE_PHASE <= phase < SUNSET_PHASE`. */
  isDay: boolean;
  /** The in-game Sydney instant: a real date, for `solar.ts` and for display. */
  date: Date;
  /** Where the sun is at `date`. */
  solar: SolarPosition;
  /**
   * **How dark it is: 0 in daylight, 1 once night has fully arrived.**
   *
   * `calibration.nightLevel` of the current solar altitude, which is the single
   * ramp the torch, the street lamps and every additive sprite in
   * `world/nightlights.ts` already share, and which anything that wants to
   * behave differently after dark should share too. It leaves zero at +2 degrees
   * of solar altitude and reaches one at -6, which through this cycle is a ramp
   * lasting **187 real seconds** -- long enough to watch, short enough that "is
   * it night yet" is never an interesting question for long.
   */
  night: number;
  /** Sydney wall-clock time as `HH:MM`, for the HUD. */
  label: string;
  /**
   * Real seconds until the sun sets (by day) or rises (by night).
   *
   * Real rather than game seconds, because it is a countdown a player reads
   * against their own sense of time passing, and because it is what the HUD
   * clock's dread state is driven by. At most 1800 either way.
   */
  secondsToEdge: number;
}

/**
 * The clock, at a wall-clock instant with an optional scrub applied.
 *
 * `scrubMs` is **real** milliseconds added to the wall clock, which makes the
 * composition law trivial and exact: `skyClock(t, s)` and `skyClock(t + s)` are
 * the same answer. That is asserted in `verifyCycle`, and it is the property
 * that lets the debug scrub be one number added in one place rather than a
 * second clock running beside the first.
 *
 * **A scrubbing player disagrees with the server about the sky, and that is
 * fine.** Nothing in the simulation reads this. The light rig, the cloud rig,
 * the twilight grade, the fog, the lit windows (`globals.nightFactor`), the
 * street lamps and the torch are all client-side appearance, and there is no
 * server-side quantity anywhere that varies with the time of day -- no
 * night-time damage, no curfew, no spawn rule; `server/sim.ts` never asks. What
 * a scrubbing player gets is their own sky over everyone else's city, which is
 * exactly what a debug scrub should be. Anything that later wants the *shared*
 * time regardless of the scrub calls `skyClock()` with no second argument, and
 * this is the sentence to point at when it does.
 */
export function skyClock(nowMs: number = Date.now(), scrubMs = 0): SkyClock {
  const at = nowMs + scrubMs;
  const phase = cyclePhase(at);
  const date = new Date(cycleInstant(phase));
  const solar = solarPosition(date, LATITUDE, LONGITUDE);
  const isDay = phase >= SUNRISE_PHASE && phase < SUNSET_PHASE;
  // Forward to the next edge, wrapping: by day that is sunset, by night it is
  // the next sunrise, which may be on the other side of phase 0.
  const edge = isDay ? SUNSET_PHASE : phase < SUNRISE_PHASE ? SUNRISE_PHASE : 1 + SUNRISE_PHASE;
  return {
    nowMs: at,
    phase,
    isDay,
    date,
    solar,
    night: nightLevel(solar.altitude),
    label: clockLabel(date),
    secondsToEdge: ((edge - phase) * CYCLE_MS) / 1000,
  };
}

/**
 * Sydney's UTC offset on `CYCLE_DATE`, derived from `sydneyTime` rather than
 * assumed, so a change to the daylight-saving rule cannot leave the clock an
 * hour out while everything else stays right. Constant for the whole cycle: the
 * three dates it touches are all inside daylight saving.
 */
const SYDNEY_OFFSET_MS = /*#__PURE__*/ (() =>
  Date.UTC(CYCLE_DATE.year, CYCLE_DATE.month - 1, CYCLE_DATE.day, 12) -
  sydneyTime(CYCLE_DATE.year, CYCLE_DATE.month, CYCLE_DATE.day, 12).getTime())();

/**
 * `HH:MM` in Sydney.
 *
 * Built by hand rather than through `toLocaleTimeString`, because the HUD clock
 * calls this every frame and `Intl` formatting is a few microseconds against
 * this one's few tens of nanoseconds -- irrelevant on its own and exactly the
 * kind of thing that turns up in a profile because nobody thought about it. The
 * debug overlay still uses `Intl`, once, because it also wants the date.
 */
export function clockLabel(date: Date): string {
  const local = date.getTime() + SYDNEY_OFFSET_MS;
  const minutes = Math.floor(local / 60_000) % 1440;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}

/**
 * How many **real** seconds the evening takes to fall from one solar altitude to
 * another.
 *
 * The unit the sunset's length is actually judged in, and the only honest way to
 * state it: it is a function of the date, the latitude, the cycle length and the
 * dwell all at once, so it cannot be read off any one constant. Used by
 * `verifyCycle` and quoted throughout this file and `dusk.ts`.
 */
export function realSecondsBetweenAltitudes(fromDeg: number, toDeg: number): number {
  // Search the evening only -- solar noon forward to the end of the cycle -- so
  // the altitude is monotonically falling and a bisection is well defined.
  const phaseAt = (targetDeg: number): number => {
    let lo = 0.5;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (solarPosition(new Date(cycleInstant(mid)), LATITUDE, LONGITUDE).altitude > targetDeg) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return ((phaseAt(toDeg) - phaseAt(fromDeg)) * CYCLE_MS) / 1000;
}

/**
 * Startup self-check, in the same spirit as `verifySouthernHemisphere()` and
 * `verifyLightRig()`: **every way this file breaks is silent.**
 *
 * A cycle that is not monotone runs the sun backwards for a few seconds, which
 * reads as a stutter. A join that does not close puts a hard cut in the sky, once
 * an hour, which reads as a streaming hitch. A day half that is not half an hour
 * is a feature that quietly does not do what it was asked to. A scrub that does
 * not compose means a developer looking at a sunset is looking at a different
 * sunset from the one that ships. And a mapping that is not a pure function of
 * the wall clock means two players in the same room see two different skies --
 * which is the one failure here that **no single player can ever observe**.
 *
 * None of them throws and none of them has a frame that says so.
 */
export function verifyCycle(): string[] {
  const failures: string[] = [];

  // --- 1. The halves are exactly half an hour of real time each, measured
  //        against the *sun* rather than against `DAY_SHARE`.
  //
  //        Taking it off the sun is what makes this worth running: it fails if
  //        either seam drifts off the horizon for any reason at all, including a
  //        change to `solar.ts`, to `CYCLE_DATE`, or to the easing.
  const SAMPLES = 3600; // one per real second of the cycle
  let up = 0;
  for (let i = 0; i < SAMPLES; i++) {
    if (solarPosition(new Date(cycleInstant((i + 0.5) / SAMPLES)), LATITUDE, LONGITUDE).altitude > 0) {
      up++;
    }
  }
  const dayMinutes = (up / SAMPLES) * (CYCLE_MS / 60_000);
  if (Math.abs(dayMinutes - 30) > 0.05) {
    failures.push(
      `The sun is above the horizon for ${dayMinutes.toFixed(2)} real minutes of the ` +
        `${(CYCLE_MS / 60_000).toFixed(0)}-minute cycle; the brief asks for 30 and 30. Measured by ` +
        `sampling the actual solar altitude at ${SAMPLES} points, so this fails if either seam has ` +
        `drifted off the horizon -- check SUNRISE_MS/SUNSET_MS and CYCLE_DATE.`,
    );
  }

  // --- 2. Monotone. The sun must never go backwards.
  //
  //        Checked within each of the three stretches rather than across the
  //        whole cycle, because the cycle deliberately jumps a day at phase 0
  //        (see the header) and case 5 is what bounds *that*. A dwell pushed past
  //        1 is the one way this breaks by a single constant, and it breaks
  //        inside a stretch.
  let worstBack = 0;
  for (const [from, to] of [[0, SUNRISE_PHASE], [SUNRISE_PHASE, SUNSET_PHASE], [SUNSET_PHASE, 1]] as const) {
    let previous = cycleInstant(from);
    for (let i = 1; i <= 8000; i++) {
      const t = cycleInstant(from + ((to - from) * i) / 8000);
      worstBack = Math.min(worstBack, t - previous);
      previous = t;
    }
  }
  if (worstBack < 0) {
    failures.push(
      `The cycle runs backwards by up to ${(-worstBack / 1000).toFixed(3)} s of Sydney time inside a ` +
        `stretch. HORIZON_DWELL is ${HORIZON_DWELL} and must stay under 1 -- at 1 the clock stops ` +
        `dead at the horizon, and above it the sun sets and then rises again.`,
    );
  }

  // --- 3 and 4. The two joins anybody can see. Both are `SUNRISE_MS` and
  //        `SUNSET_MS` from both sides, so both must be exactly on the horizon
  //        and continuous in azimuth to the last digit that matters.
  for (const [name, at] of [['sunrise', SUNRISE_PHASE], ['sunset', SUNSET_PHASE]] as const) {
    const before = solarPosition(new Date(cycleInstant(at - 1e-9)), LATITUDE, LONGITUDE);
    const after = solarPosition(new Date(cycleInstant(at + 1e-9)), LATITUDE, LONGITUDE);
    const step = Math.abs(((before.azimuth - after.azimuth + 540) % 360) - 180);
    if (Math.abs(before.altitude) > 0.02 || Math.abs(after.altitude) > 0.02 || step > 0.01) {
      failures.push(
        `The ${name} join is not on the horizon and continuous: altitude ` +
          `${before.altitude.toFixed(4)} deg going in and ${after.altitude.toFixed(4)} coming out, ` +
          `azimuth step ${step.toFixed(4)} deg. Both stretches are stretched between solved horizon ` +
          `crossings on the same date, so anything but zero on both counts means a stretch is ` +
          `anchored to the wrong instant -- which is a visible cut in the sky at the one moment ` +
          `everybody is watching it.`,
      );
    }
  }

  // --- 5. The join nobody can see, and the reason the cycle is cut where it is.
  //
  //        Phase 1 and phase 0 are the same *time of night* one day apart, so the
  //        sun steps by a day of declination drift. It has to happen somewhere;
  //        this asserts it happens in the dark. Both sides must be deep night by
  //        `nightLevel`'s own definition, or the step is on screen.
  const closeOut = solarPosition(new Date(cycleInstant(1 - 1e-9)), LATITUDE, LONGITUDE);
  const openIn = solarPosition(new Date(cycleInstant(0)), LATITUDE, LONGITUDE);
  const altStep = Math.abs(closeOut.altitude - openIn.altitude);
  const azStep = Math.abs(((closeOut.azimuth - openIn.azimuth + 540) % 360) - 180);
  if (
    closeOut.altitude > -30 ||
    openIn.altitude > -30 ||
    nightLevel(closeOut.altitude) !== 1 ||
    nightLevel(openIn.altitude) !== 1 ||
    altStep > 1 ||
    azStep > 1
  ) {
    failures.push(
      `The cycle's wrap is visible. It closes at altitude ${closeOut.altitude.toFixed(2)} deg / ` +
        `azimuth ${closeOut.azimuth.toFixed(2)} and reopens at ${openIn.altitude.toFixed(2)} / ` +
        `${openIn.azimuth.toFixed(2)} -- a step of ${altStep.toFixed(2)} deg of altitude and ` +
        `${azStep.toFixed(2)} of azimuth, with nightLevel ${nightLevel(closeOut.altitude).toFixed(3)} ` +
        `and ${nightLevel(openIn.altitude).toFixed(3)}. The whole reason the loop is cut at solar ` +
        `midnight rather than at sunrise is that a replayed day must jump a date somewhere, and 0.4 ` +
        `degrees of declination drift is three-quarters of the sun's diameter -- invisible under a ` +
        `black sky, and a hop backwards in the rising sun if this moves.`,
    );
  }

  // --- 6. A pure function of the wall clock, and therefore the same on every
  //        machine. Two things: that the answer depends on nothing but
  //        `nowMs mod CYCLE_MS`, and that recomputing it gives the same bits --
  //        which is what "client and server agree" reduces to once there is no
  //        state anywhere in the path.
  for (const t of [CYCLE_EPOCH_MS, 1_800_000_000_000, 1_800_000_123_456, Date.now()]) {
    const a = skyClock(t);
    const b = skyClock(t + CYCLE_MS * 8760); // a year of cycles later
    if (a.date.getTime() !== b.date.getTime() || a.phase !== b.phase) {
      failures.push(
        `The cycle is not periodic in CYCLE_MS: at ${t} it gives phase ${a.phase} and a year of ` +
          `cycles later it gives ${b.phase}. Two players who joined an hour apart would be looking ` +
          `at different skies, which no single player can ever notice.`,
      );
    }
    if (skyClock(t).date.getTime() !== a.date.getTime()) {
      failures.push(`skyClock(${t}) is not a pure function -- two calls gave two answers.`);
    }
  }

  // --- 7. The scrub composes, or a developer holding `]` is looking at a sky the
  //        shipped build never produces.
  for (const scrub of [-CYCLE_MS * 3.7, -60_000, 0, 1, 937_411, CYCLE_MS * 2.25]) {
    const t = 1_800_000_123_456;
    const scrubbed = skyClock(t, scrub);
    const shifted = skyClock(t + scrub);
    if (scrubbed.date.getTime() !== shifted.date.getTime() || scrubbed.phase !== shifted.phase) {
      failures.push(
        `The scrub does not compose at ${scrub} ms: scrubbing gives phase ${scrubbed.phase} and ` +
          `moving the wall clock by the same amount gives ${shifted.phase}. The scrub is real ` +
          `milliseconds added to the clock and it is nothing else.`,
      );
    }
  }

  // --- 8. The easing itself: fixed ends, fixed middle, and actually *slower* at
  //        the horizon. The last clause is what fails if somebody flips the sign,
  //        which would halve the sunset and leave every other check here passing.
  if (cycleEase(0) !== 0 || cycleEase(1) !== 1 || Math.abs(cycleEase(0.5) - 0.5) > 1e-12) {
    failures.push(
      `cycleEase does not pin its ends: ${cycleEase(0)}, ${cycleEase(0.5)}, ${cycleEase(1)} should be ` +
        `0, 0.5, 1. Anything else moves the seams off the horizon and solar noon off the half.`,
    );
  }
  const horizonRate = cycleEase(0.001) / 0.001;
  const middleRate = (cycleEase(0.501) - cycleEase(0.499)) / 0.002;
  if (!(horizonRate < middleRate * 0.75)) {
    failures.push(
      `The clock is not dwelling at the horizon: it runs at ${horizonRate.toFixed(3)}x there against ` +
        `${middleRate.toFixed(3)}x in the middle. HORIZON_DWELL (${HORIZON_DWELL}) is what buys the ` +
        `sunset its running time, and a sign flip leaves every other check passing while making the ` +
        `sunset twice as fast as a linear mapping would.`,
    );
  }

  // --- 9. And the thing the brief actually asked for, stated as a number: how
  //        long the sunset lasts in real seconds. Bounded rather than pinned,
  //        because it is a taste decision -- but one that has been made, and a
  //        later change to the date or the dwell that halves it should have to
  //        notice.
  const twilight = realSecondsBetweenAltitudes(6, -6);
  if (!(twilight > 180 && twilight < 420)) {
    failures.push(
      `Civil twilight -- the sun from +6 to -6 degrees -- lasts ${twilight.toFixed(0)} real seconds, ` +
        `outside the 180-420 s window this cycle was designed to. It is 278 s as tuned: 58 real ` +
        `Sydney minutes at 24x, doubled by HORIZON_DWELL. Under three minutes and the sunset is over ` +
        `before a player has turned round, which is the thing the dwell exists to prevent.`,
    );
  }

  // --- 10. The three stretches run at the same rate, which is the equinox's
  //         whole argument (see `CYCLE_DATE`). If a later date change makes the
  //         night twice the day's rate, the sun visibly changes gear at sunset.
  const dayRate = DAY_LENGTH_MS / (DAY_SHARE * CYCLE_MS);
  const nightRates = [NIGHT_BEFORE, NIGHT_AFTER].map((n) => (n.to - n.from) / (DAY_SHARE * CYCLE_MS));
  const spread = Math.max(dayRate, ...nightRates) / Math.min(dayRate, ...nightRates) - 1;
  if (spread > 0.05) {
    failures.push(
      `The sun changes speed by ${(spread * 100).toFixed(1)}% between day and night: ` +
        `${dayRate.toFixed(2)}x by day against ${nightRates.map((r) => r.toFixed(2)).join('/')}x by ` +
        `night. CYCLE_DATE is an equinox precisely so this stays under a per cent; a solstice puts it ` +
        `at 46%, which is a visible change of gear at the two moments a player is watching the sun.`,
    );
  }

  return failures;
}
