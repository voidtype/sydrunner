/**
 * The button on the hill in Sydney Park that makes the sun scream.
 *
 * This is the **pure** half: where the button is, how far you have to be from it
 * to press it, what pressing it does to two numbers, and how long those two
 * numbers last. `world/sunbutton.ts` draws the plinth and the face;
 * `server/room.ts` owns the numbers; this file is the only place that says what
 * they *mean*, and both ends import it. It carries no `three` import for the
 * reason the README states and `game/bikes.ts` demonstrates: the server runs
 * this file, and a module the server cannot load is a rule the server cannot
 * enforce.
 *
 * ---------------------------------------------------------------------------
 * THE STATE IS TWO INSTANTS, AND THAT IS THE WHOLE DESIGN.
 *
 *     { screamUntilMs, cooldownUntilMs }
 *
 * Not "screaming: boolean" with a timer counting down somewhere, and the
 * difference is the same one `game/traffic.ts` and `game/footy.ts` make in their
 * headers: an *instant* is a fact two processes can agree about by arithmetic,
 * where a *countdown* is a piece of mutable state that has to be stepped by
 * somebody at some rate and is therefore something two processes can disagree
 * about. A client that missed three seconds of frames because the tab was
 * backgrounded gets the right answer here for free, and a client that joins
 * halfway through a scream is told the same pair of numbers everybody else was
 * told at the start.
 *
 * It also means the message is sixteen bytes sent on change, and nothing at all
 * on the snapshot path -- which is `protocol.MSG.BIKES`' argument, made about a
 * thing that changes a handful of times an hour rather than a handful of times a
 * minute.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCREAM ENDS AT SUNSET RATHER THAN AFTER A FIXED SPAN.
 *
 * The owner's rule is "the rest of the current in-game day", and that is not a
 * duration -- it is a *boundary*. A fixed thirty minutes would mean a player who
 * pressed it at 4 pm got a screaming sunset and a player who pressed it at noon
 * got a screaming afternoon and a normal sunset, which is two different features
 * wearing the same button. Ending it at `SUNSET_PHASE` means the answer to "how
 * long does it last" is always the same sentence -- *until the sun goes down* --
 * and the face is only visible by day anyway, so a press at night quietly buys
 * the whole of the next day. That last case is deliberate rather than tolerated:
 * somebody who finds the button in the dark should get something, and what they
 * get is a sunrise.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COOLDOWN IS THREE DAYS AND WHY IT IS MEASURED IN DAYS.
 *
 * Three in-game days is three real hours, which is longer than any session. So
 * the button is, for the person who pressed it, a once-a-session thing -- which
 * is what makes it an event rather than a toy -- and for the *room* it is a
 * thing that comes back while people are still playing. Measured in cycles
 * rather than in real minutes because everything else a player can read off this
 * feature is in game-days ("until sunset"), and a readout that mixed the two
 * units would be a readout nobody could act on.
 */

import { CYCLE_EPOCH_MS, CYCLE_MS, SUNSET_PHASE } from '../sky/cycle.ts';

/**
 * **Where the button is, in world metres, and how that was arrived at.**
 *
 * `x = -2438, z = 4656`, which is `-33.910414, 151.182063` -- the top of the
 * middle-western mound in Sydney Park, St Peters.
 *
 * Derived rather than chosen. The brief's Sydney Park box (lat -33.906..-33.915,
 * lon 151.178..151.190) was converted with `pipeline/sydney/geo.py` to the world
 * rectangle `x -2822..-1695, z 4176..5155`, and `server/world.groundFor` was
 * sampled over it on a 5 m grid by a temporary driver. Local maxima over a 20 m
 * neighbourhood, clustered at 60 m, come out as:
 *
 *     (-2217, 4406)  -48.28   <- the kiln mound, NE corner: the tall one
 *     (-2438, 4656)  -49.32   <- this one
 *     (-2342, 4281)  -50.63   <- north of Sydney Park Road, outside the park
 *     (-2497, 4656)  -51.15   <- the same mound's western shoulder, 60 m away
 *     (-2122, 4781)  -59.80   <- the wetland flat, not a hill at all
 *
 * The brief says to exclude the highest cluster -- the big landmark mounds by
 * the brick kilns -- and take the second tier, so this is the second entry,
 * refined to a 1 m grid. It drops about 1.8 m over the 30 m around it, which is
 * a walkable grassy dome rather than a scarp, and it is 231 m from the spawn
 * disc at (-2236, 4543) and 11.6 m above it: far enough to be somewhere you go,
 * near enough that a new player can see the hill from where they land.
 *
 * **The heights above are the world's own datum and are negative on purpose.**
 * The DEM is not AHD; ground at Town Hall is -0.86 in these units. Only the
 * *differences* are read here, and the button's own `y` is never stored at all
 * -- it is the ground query's answer at runtime, on both ends, which is the only
 * way the prop cannot end up buried by a later terrain rebuild.
 */
export const SUN_BUTTON_X = -2438;
export const SUN_BUTTON_Z = 4656;

/**
 * How close the server insists you are, in metres, measured on the ground plane.
 *
 * Three, and the *client* prompts at 2.5 (`SUN_PROMPT_M`). The half-metre gap is
 * deliberate and it is the same gap `server/sim.ts` leaves around a bike claim:
 * the client decides when to offer, the server decides whether to allow, and if
 * the two thresholds were equal then every press made at the very edge of the
 * prompt would be refused by a server working from a position a round trip
 * older. A prompt that lies is worse than a prompt that appears late.
 */
export const SUN_REACH_M = 3;

/** Where the client puts the prompt up. Inside `SUN_REACH_M`; see above. */
export const SUN_PROMPT_M = 2.5;

/**
 * How far the vertical check tolerates, metres.
 *
 * There is nothing above this mound to press it from, so this is not defending
 * against a known exploit -- it is refusing to answer a question the horizontal
 * test cannot. A distance measured on the ground plane says yes to somebody
 * directly overhead, and "directly overhead" is a thing the streamer, a viaduct
 * or a future landmark could all quietly create. Three metres is a storey.
 */
export const SUN_REACH_VERTICAL_M = 3;

/** Where the countdown readout switches on. The brief's number. */
export const SUN_READOUT_M = 8;

/** In-game days of cooldown after a press. */
export const SUN_COOLDOWN_DAYS = 3;

/** ...as milliseconds, which is three real hours. See the header. */
export const SUN_COOLDOWN_MS = SUN_COOLDOWN_DAYS * CYCLE_MS;

/**
 * The whole of the feature's state, and the whole of what crosses the wire.
 *
 * Both fields are absolute epoch milliseconds on the **server's** clock, which
 * is the clock `protocol.Welcome.clockMs` gave the client at join and the one
 * `sky/cycle.ts` already runs the sky on. Zero means "never", which is correct
 * rather than merely convenient: 1970 is in the past, so a fresh room reads as
 * not screaming and off cooldown without a sentinel.
 */
export interface SunState {
  screamUntilMs: number;
  cooldownUntilMs: number;
}

/** A room that has never had its button pressed. */
export function newSunState(): SunState {
  return { screamUntilMs: 0, cooldownUntilMs: 0 };
}

/**
 * The next `SUNSET_PHASE` strictly after `nowMs`.
 *
 * Exactly specified arithmetic -- a subtraction, a floor, two integer products
 * and an add -- for `cyclePhase`'s reason: two processes handed the same
 * millisecond must produce the same double, because one of them is going to send
 * the answer to the other and the other is going to draw a face until it. Every
 * intermediate here is an integer well inside 2^53 (`SUNSET_PHASE * CYCLE_MS` is
 * exactly 2,700,000), so there is no rounding anywhere in it.
 *
 * Strictly after: a press made in the same millisecond as a sunset buys the
 * following day rather than zero milliseconds of scream. That is one frame in a
 * million and it is still the difference between a button that works and a
 * button that once, mysteriously, did nothing.
 */
export function nextSunsetMs(nowMs: number): number {
  const sinceEpoch = nowMs - CYCLE_EPOCH_MS;
  const cycle = Math.floor(sinceEpoch / CYCLE_MS);
  const offset = SUNSET_PHASE * CYCLE_MS;
  let sunset = CYCLE_EPOCH_MS + cycle * CYCLE_MS + offset;
  if (sunset <= nowMs) sunset += CYCLE_MS;
  return sunset;
}

/** Is the sun a face right now? The only question the renderer asks. */
export function sunScreaming(state: SunState, nowMs: number): boolean {
  return nowMs < state.screamUntilMs;
}

/**
 * The scream's level for this frame, or `null` for silence.
 *
 * Pure and three-free, so the server can run it too: a level of 1 by day when the
 * sun is screaming, a linear fade to 0 across the two degrees either side of the
 * horizon, and `null` when the sun is not screaming or is below −2°. The altitude
 * is the same `main.ts` hands `SunFeature.update`, so the scream and the face fade
 * together rather than one outlasting the other.
 */
export function sunScreamMix(screaming: boolean, sunAltDeg: number): { level: number } | null {
  if (!screaming) return null;
  const level = Math.min(1, Math.max(0, (sunAltDeg + 2) / 4));
  if (level <= 0) return null;
  return { level };
}

/**
 * The gap, in seconds, between the end of one scream clip and the start of the
 * next.
 *
 * `u1`, `u2` and `u3` are three independent uniform draws in [0, 1), and the
 * gap is `1 + 9 × max(u1, u2, u3)`; the maximum of three uniforms is a
 * Beta(3, 1), whose mean is 3/4 and whose mode is 1, so the gap's mean is
 * 1 + 9 × 3/4 = 7.75 s and its mode is 10 s -- the owner's "biased to 10 s" in
 * one sentence. Pure and three-free, so a client that cannot play audio still
 * draws the same schedule the server would.
 */
/**
 * How open the sun's jaw is, 0..1, from how loud the scream is right now.
 *
 * `mouth` is `audio.sunScreamLevel()` -- the envelope of the clip that is
 * playing, 0 between clips -- and `wobble` is the renderer's aperiodic jitter,
 * 0..1. The rule the owner asked for is that **the mouth only opens when the
 * scream noise is playing**, so the wobble is a multiplier on the level and
 * never a term of its own: at `mouth = 0` the jaw is `JAW_CLOSED`, a thin line
 * rather than a hole, whatever the wobble does. At `mouth = 1` it is wide open,
 * breathing by up to 15 % with the wobble so a held scream still moves.
 */
export const JAW_CLOSED = 0.1;
export function jawOpen(mouth: number, wobble: number): number {
  const m = mouth < 0 ? 0 : mouth > 1 ? 1 : mouth;
  const w = wobble < 0 ? 0 : wobble > 1 ? 1 : wobble;
  return JAW_CLOSED + (1 - JAW_CLOSED) * m * (0.85 + 0.15 * w);
}

export function screamGap(u1: number, u2: number, u3: number): number {
  return 1 + 9 * Math.max(u1, u2, u3);
}

/** Would the button take a press right now, ignoring where the presser is? */
export function sunReady(state: SunState, nowMs: number): boolean {
  return nowMs >= state.cooldownUntilMs;
}

/**
 * Why a press did or did not land.
 *
 * A code rather than a string, on `protocol.encodeInvestigations`' argument
 * about `REASON`: the wording belongs in this file, which both ends compile, so
 * that a server cannot phrase the refusal and a client cannot invent one. The
 * sentences are `sunRefusalText` below.
 */
export const SUN_PRESS = {
  OK: 0,
  TOO_FAR: 1,
  COOLING: 2,
} as const;

/**
 * Distance from the button on the ground plane, metres.
 *
 * `Math.hypot` is avoided deliberately -- see the determinism note in
 * `game/footy.ts`'s header. Both ends compare this against a constant, so the
 * comparison is done on the *square* and no root is taken at all.
 */
export function sunDistanceSq(x: number, z: number): number {
  const dx = x - SUN_BUTTON_X;
  const dz = z - SUN_BUTTON_Z;
  return dx * dx + dz * dz;
}

/**
 * Press it, if the rules allow. Mutates `state` on success and only on success.
 *
 * `buttonY` is the ground query's answer at the button, and `feetY` the presser's
 * feet; pass both as `0` to skip the vertical test, which is what the client's
 * own prediction does before the terrain under the mound has arrived. The
 * horizontal test is never skipped.
 *
 * The **server calls this and the client calls this**, with the same arguments
 * in the same order, which is the arrangement `bikes.claim` has: the client runs
 * it to decide whether to bother sending, and to light its own prop on the frame
 * the key goes down; the server runs it to decide what is true. A client that
 * edited these lines would see a face nobody else saw for as long as it takes
 * the next `SUN` message to arrive.
 */
export function trySunPress(
  state: SunState,
  nowMs: number,
  x: number,
  z: number,
  feetY = 0,
  buttonY = 0,
): number {
  if (sunDistanceSq(x, z) > SUN_REACH_M * SUN_REACH_M) return SUN_PRESS.TOO_FAR;
  if (Math.abs(feetY - buttonY) > SUN_REACH_VERTICAL_M) return SUN_PRESS.TOO_FAR;
  if (!sunReady(state, nowMs)) return SUN_PRESS.COOLING;
  state.screamUntilMs = nextSunsetMs(nowMs);
  state.cooldownUntilMs = nowMs + SUN_COOLDOWN_MS;
  return SUN_PRESS.OK;
}

/**
 * How long is left, in in-game days and hours: `"2 days 13 h"`.
 *
 * In-game units throughout, because that is the unit the rest of the feature
 * speaks: one cycle is a day and a twenty-fourth of a cycle is an hour, so a
 * three-day cooldown reads as three days rather than as "2 h 59 m" of the
 * player's own afternoon. Under an hour it falls back to in-game minutes, which
 * is the band a player standing at the plinth waiting is actually in.
 */
export function sunCooldownText(msLeft: number): string {
  const left = Math.max(0, msLeft);
  const days = Math.floor(left / CYCLE_MS);
  const hours = Math.floor((left % CYCLE_MS) / (CYCLE_MS / 24));
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} h`;
  if (hours > 0) return `${hours} h`;
  const minutes = Math.max(1, Math.ceil(left / (CYCLE_MS / 1440)));
  return `${minutes} min`;
}

/** The one-line refusal a player reads. See `SUN_PRESS`. */
export function sunRefusalText(result: number, state: SunState, nowMs: number): string {
  if (result === SUN_PRESS.COOLING) {
    return `the button is recharging (${sunCooldownText(state.cooldownUntilMs - nowMs)})`;
  }
  return 'stand closer to the button';
}

/**
 * What the plinth's readout says, from 8 m, in one line.
 *
 * Three states and they are ordered by what a person standing there needs to
 * know first: the sun is screaming and here is when it stops; the button is
 * charged; the button is dead and here is when it is not. The screaming case
 * wins over the cooling case even though both are true at once, because the
 * face in the sky is the thing they came to see.
 */
export function sunReadoutText(state: SunState, nowMs: number): string {
  if (sunScreaming(state, nowMs)) {
    return `sun returns to normal in ${sunCooldownText(state.screamUntilMs - nowMs)}`;
  }
  if (!sunReady(state, nowMs)) {
    return `recharges in ${sunCooldownText(state.cooldownUntilMs - nowMs)}`;
  }
  return 'READY — press it';
}

/**
 * Startup self-check, run on both ends.
 *
 * What this file gets wrong is silent by construction: every failure here is a
 * face that lasts the wrong length of time or a button that comes back on the
 * wrong day, and neither has a frame that says so -- you would have to sit and
 * watch a three-hour cooldown to notice. So the arithmetic is asserted rather
 * than eyeballed, and the four claims below are the four sentences the header
 * makes.
 */
export function verifySunButton(): string[] {
  const bad: string[] = [];
  // --- The jaw opens by the scream and by nothing else. What this catches: a
  //     renderer that let the wobble open the mouth on its own would have the sun
  //     mouthing along between clips, which is exactly the thing the owner asked
  //     to stop ("make sure the mouth only opens when scream noise playing").
  if (jawOpen(0, 0) > 0.12 || jawOpen(0, 1) > 0.12) {
    bad.push(`The jaw is ${jawOpen(0, 1).toFixed(3)} open with no scream playing; the wobble alone opened it.`);
  }
  if (jawOpen(1, 1) < 0.95) bad.push(`A full scream only opens the jaw to ${jawOpen(1, 1).toFixed(3)}.`);
  for (let k = 1; k <= 10; k++) {
    if (jawOpen(k / 10, 0.5) < jawOpen((k - 1) / 10, 0.5)) {
      bad.push('jawOpen is not monotone in the scream level.');
      break;
    }
  }
  if (jawOpen(2, 0) !== jawOpen(1, 0) || jawOpen(-1, 0) !== jawOpen(0, 0)) bad.push('jawOpen does not clamp its inputs.');


  /* --- 1. The sunset boundary. Walk a whole cycle in 200 steps and require
   *        that every instant maps to a sunset that is (a) in the future,
   *        (b) no more than a cycle away, and (c) exactly on the phase. (c) is
   *        the one with teeth: an off-by-one in the floor gives an answer that
   *        is still in the future and still within a day, and puts the face away
   *        at three in the afternoon. */
  const offset = SUNSET_PHASE * CYCLE_MS;
  for (let i = 0; i < 200; i++) {
    const now = CYCLE_EPOCH_MS + (i / 200) * CYCLE_MS * 3 + 12345;
    const set = nextSunsetMs(now);
    if (!(set > now)) {
      bad.push(`nextSunsetMs(${now}) returned ${set}, which is not in the future.`);
      break;
    }
    if (set - now > CYCLE_MS) {
      bad.push(
        `nextSunsetMs(${now}) is ${((set - now) / CYCLE_MS).toFixed(3)} cycles away; the next ` +
          `sunset is never more than one day off.`,
      );
      break;
    }
    const phaseOff = (set - CYCLE_EPOCH_MS) % CYCLE_MS;
    if (phaseOff !== offset) {
      bad.push(
        `nextSunsetMs(${now}) landed at phase ${(phaseOff / CYCLE_MS).toFixed(6)} rather than ` +
          `${SUNSET_PHASE}. The face would go away in the middle of the afternoon.`,
      );
      break;
    }
  }

  // --- 2. A press exactly on a sunset buys the *next* day, not nothing. See
  //        `nextSunsetMs`: this is the strict comparison, asserted.
  const onSunset = CYCLE_EPOCH_MS + offset;
  if (nextSunsetMs(onSunset) - onSunset !== CYCLE_MS) {
    bad.push(
      'A press made exactly at sunset did not buy a whole following day. The comparison in ' +
        'nextSunsetMs must be strict, or that press is a button that did nothing.',
    );
  }

  /* --- 3. The press rules, end to end, on a fresh state. Distance first,
   *        because a refusal for the wrong reason is a HUD line that sends a
   *        player walking away from a button that was in reach. */
  {
    const s = newSunState();
    const now = CYCLE_EPOCH_MS + 1_000_000;
    if (trySunPress(s, now, SUN_BUTTON_X + SUN_REACH_M + 0.5, SUN_BUTTON_Z) !== SUN_PRESS.TOO_FAR) {
      bad.push(`A press from ${SUN_REACH_M + 0.5} m was not refused as out of reach.`);
    }
    if (s.screamUntilMs !== 0 || s.cooldownUntilMs !== 0) {
      bad.push('A refused press still wrote the state. trySunPress must mutate only on success.');
    }
    const overhead = trySunPress(
      s, now, SUN_BUTTON_X, SUN_BUTTON_Z, SUN_REACH_VERTICAL_M + 1, 0,
    );
    if (overhead !== SUN_PRESS.TOO_FAR) {
      bad.push('A press from directly overhead was allowed; the vertical test is not being applied.');
    }
    if (trySunPress(s, now, SUN_BUTTON_X + 1, SUN_BUTTON_Z + 1) !== SUN_PRESS.OK) {
      bad.push('A press from 1.4 m away on a ready button was refused.');
    }
    if (!sunScreaming(s, now)) bad.push('The sun is not screaming on the millisecond it was pressed.');
    if (sunScreaming(s, s.screamUntilMs)) {
      bad.push('The sun is still screaming at screamUntilMs; the test must be strictly before.');
    }
    if (sunReady(s, now)) bad.push('The button is still ready on the millisecond it was pressed.');
    if (trySunPress(s, now + 1000, SUN_BUTTON_X, SUN_BUTTON_Z) !== SUN_PRESS.COOLING) {
      bad.push('A second press a second later was not refused as cooling.');
    }
    if (s.cooldownUntilMs - now !== SUN_COOLDOWN_MS) {
      bad.push(
        `The cooldown came out as ${((s.cooldownUntilMs - now) / CYCLE_MS).toFixed(3)} in-game ` +
          `days rather than ${SUN_COOLDOWN_DAYS}.`,
      );
    }
    if (!sunReady(s, s.cooldownUntilMs)) {
      bad.push('The button is not ready on the millisecond the cooldown expires.');
    }
  }

  /* --- 4. The readout is a different sentence in each of its three states, and
   *        none of them is empty. It is the only thing on the prop that tells a
   *        player *why* the key is doing nothing, and three states that read the
   *        same is the same class of failure `verifyDoorMarker` guards against. */
  {
    const now = CYCLE_EPOCH_MS + 500_000;
    const ready = newSunState();
    const screaming: SunState = { screamUntilMs: now + 60_000, cooldownUntilMs: now + SUN_COOLDOWN_MS };
    const cooling: SunState = { screamUntilMs: now - 1, cooldownUntilMs: now + SUN_COOLDOWN_MS };
    const lines = [
      sunReadoutText(ready, now),
      sunReadoutText(screaming, now),
      sunReadoutText(cooling, now),
    ];
    if (new Set(lines).size !== 3 || lines.some((l) => l.trim() === '')) {
      bad.push(`The readout's three states read as ${JSON.stringify(lines)}; they must all differ.`);
    }
    // And the cooldown wording covers the whole span it is asked about, from
    // three days down to the last minute, without ever saying "0 min".
    for (const ms of [SUN_COOLDOWN_MS, CYCLE_MS + 1, CYCLE_MS / 24 + 1, 60_000, 1, 0]) {
      const text = sunCooldownText(ms);
      if (text.trim() === '' || text.startsWith('0 min')) {
        bad.push(`sunCooldownText(${ms}) said "${text}", which tells a player nothing.`);
      }
    }
  }

  /* --- 5. The scream mix: full by day, a linear fade to silence across the
   *        horizon, and silent when the sun is not screaming. The audio is
   *        driven from this, so a wrong level is a scream that is too loud or
   *        never fades at sunset. */
  {
    const full = sunScreamMix(true, 30);
    if (!full || full.level !== 1) {
      bad.push(`sunScreamMix(true, 30) returned ${JSON.stringify(full)}; it must be level 1 by day.`);
    }
    const below = sunScreamMix(true, -5);
    if (below !== null) {
      bad.push(`sunScreamMix(true, -5) returned ${JSON.stringify(below)}; below -2° it must be null.`);
    }
    const quiet = sunScreamMix(false, 30);
    if (quiet !== null) {
      bad.push(`sunScreamMix(false, 30) returned ${JSON.stringify(quiet)}; not screaming must be null.`);
    }
  }

  /* --- 6. The scream gap: the gap between one clip's end and the next's start,
    *        `1 + 9 × max(u1, u2, u3)`. The endpoints are the two things a player
    *        would notice most -- a gap that never reaches 10 s is a sun that
    *        never stops, and a gap that never reaches 1 s is a sun that never
    *        rests -- and the distribution must sit between them, biased to the
    *        long end. */
  {
    if (screamGap(0, 0, 0) !== 1) {
      bad.push(`screamGap(0,0,0) returned ${screamGap(0, 0, 0)}; the floor must be 1 s.`);
    }
    if (screamGap(1, 0, 0) !== 10) {
      bad.push(`screamGap(1,0,0) returned ${screamGap(1, 0, 0)}; the ceiling must be 10 s.`);
    }
    // Monotone in max(u): a larger draw never gives a smaller gap. The other two
    // are held at 0, so the max is the one that moves.
    let prev = screamGap(0, 0, 0);
    for (const m of [0.1, 0.25, 0.5, 0.75, 1]) {
      const g = screamGap(m, 0, 0);
      if (g < prev) {
        bad.push(`screamGap(${m},0,0)=${g} fell below ${prev}; it must be monotone in max(u).`);
        break;
      }
      prev = g;
    }
    // Over a scripted PRNG the mean must land on the Beta(3,1) centre of 7.75 s,
    // well inside the [7.4, 8.1] band the brief allows. Mulberry32, fixed seed,
    // so the answer is the same on every boot and on the server that runs this
    // same check.
    let a = 0x1234567;
    const rand = (): number => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let sum = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) sum += screamGap(rand(), rand(), rand());
    const mean = sum / N;
    if (mean < 7.4 || mean > 8.1) {
      bad.push(`screamGap's mean over ${N} draws was ${mean.toFixed(3)}; it must be in [7.4, 8.1].`);
    }
  }

  return bad;
}
