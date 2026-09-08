/**
 * The world is drawn on one clock, and that clock only ever goes forwards.
 *
 * ---------------------------------------------------------------------------
 * ## WHY THIS EXISTS
 *
 * The owner, on the live build: *"shadows can flicker"*, *"as can ppl and other
 * objects"*. Nothing in this client's quality machinery oscillates -- the shadow
 * radius, the render scale and the map size are all static -- and the two
 * populations named are drawn by completely different files. What they share is
 * one number.
 *
 * Everything ambient in Sydney is a pure function of `(anchor, index, tick)`:
 * `game/traffic.ts` looks a car up in a baked timetable, `game/pedestrians.ts`
 * evaluates a walker's phase in closed form, and `world/characters.ts` hangs its
 * rigs off both. There is nothing to integrate and nothing to interpolate, which
 * is the whole design and is what makes a backgrounded tab free. The price is
 * that the tick is not a convenience: **it is the world's only state**, and a
 * tick that goes backwards is a world that goes backwards.
 *
 * `main.ts` used to hand every one of those sinks
 *
 *     trafficTick(Date.now()) + accumulator / FIXED_DT
 *
 * -- a whole tick of the wall clock, plus the leftover of the *simulation's*
 * fixed-step accumulator, added as though the second were the fractional part of
 * the first. It is not. They are two independent 60 Hz sawteeth: the floor steps
 * on `Date.now()`, and the carry steps on `requestAnimationFrame` deltas through
 * `framestep.planSteps`. Nothing ties their phases together, so on any display
 * that is not exactly 60 Hz the sum runs *backwards*.
 *
 * ## WHAT THAT DID TO THE PICTURE, MEASURED
 *
 * Section 3 below is the driver, over real `buildBands` walkers off a real
 * synthetic lane sidecar and a real `TrafficField` of eight routes -- thirty
 * seconds of frames at each cadence. On the superseded expression at 120 Hz,
 * which is what a ProMotion panel runs at:
 *
 *   - **117,372 direction reversals in 117,530 lived pedestrian-frames.** Not a
 *     tail: essentially every walker, on essentially every frame, stepping back
 *     and forth by up to 3.9 cm. A crowd doing that is the shimmer.
 *   - **19,200 reversals in 43,248 car-frames**, worst 29.7 cm. A car twitching
 *     30 cm every other frame drags its own shadow with it, which is the other
 *     half of the report.
 *   - **twenty walkers and sixteen cars gone for exactly one frame** -- a walker
 *     whose `u >= trip` gate the clock crossed and re-crossed, or a schedule car
 *     whose stage boundary it did. `TrafficMovers.update` writes `mesh.count`
 *     from the walk each frame, so a car that leaves the walk for one frame is
 *     not drawn on it. That is whole-object blinking, from arithmetic.
 *
 * At 60 Hz exactly: none of it. Which is why this was reported as intermittent
 * and unattributable rather than as an obvious bug.
 *
 * `traffic.drawTick` is the fix and it is subtraction rather than addition:
 * there was never a second quantity to add, because the fraction of a tick that
 * has elapsed is already inside the multiply `trafficTick` floors away. Every
 * number above goes to **zero** on it, at every cadence.
 *
 * ## AND IT HAS BEEN WATCHED GOING RED
 *
 * Section 2 drives the superseded expression on purpose and **requires** it to
 * fail: a check whose counter-example is only described is a counter-example
 * nobody has run. So this file holds both, and the day somebody adds a second
 * clock to the render tick again, section 3 convicts it with a number.
 *
 * Three-free and DOM-free, so both boot lists read it.
 */

import { planSteps } from './framestep.ts';
import { UNIFORM_CROWD } from './density.ts';
import { buildBands, createPedPose, posePedestrian, type PedBand } from './pedestrians.ts';
import {
  createCarPose,
  drawTick,
  forEachCarNear,
  syntheticTile,
  TRAFFIC_EPOCH_MS,
  TRAFFIC_HZ,
  trafficSeconds,
  trafficTick,
  TrafficField,
  type LaneRoute,
} from './traffic.ts';

/** `main.ts`'s own numbers, so the timeline below is the one it runs. */
const SIMULATION_HZ = 60;
const FIXED_DT = 1 / SIMULATION_HZ;

/**
 * The display cadences this is driven at, and why these four.
 *
 * 60 is the one everything was written on and the one where the old expression
 * is clean -- which is exactly why it shipped. 120 is a MacBook's ProMotion
 * panel and is the owner's own machine. 144 and 165 are the two commonest
 * gaming panels. Anything that is *not* an integer multiple of the simulation
 * rate is where the two sawteeth beat against each other.
 */
const CADENCES = [60, 120, 144, 165] as const;

/** Frames per cadence. Thirty seconds is long enough for the beat to come round. */
const FRAMES = 30 * 60;

/**
 * One frame timeline, as a list of ticks, on either clock.
 *
 * `old` is the superseded expression, reproduced here and nowhere else in the
 * tree: `planSteps` is the real one, so the carry is the carry `main.ts` would
 * actually have been holding.
 */
function timeline(hz: number, frames: number, which: 'old' | 'now'): number[] {
  const periodMs = 1000 / hz;
  let carry = 0;
  // An arbitrary hour past the epoch, so nothing here depends on when it is run.
  let wall = TRAFFIC_EPOCH_MS + 3_600_000;
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    wall += periodMs;
    const plan = planSteps(carry, periodMs / 1000, FIXED_DT);
    carry = plan.carry;
    out.push(which === 'now' ? drawTick(wall) : trafficTick(wall) + carry / FIXED_DT);
  }
  return out;
}

/** How far a run of ticks steps backwards, and how often. */
function backwards(ticks: readonly number[]): { frames: number; worst: number } {
  let n = 0;
  let worst = 0;
  for (let i = 1; i < ticks.length; i++) {
    const d = ticks[i] - ticks[i - 1];
    if (d < 0) {
      n++;
      if (-d > worst) worst = -d;
    }
  }
  return { frames: n, worst };
}

/** What the picture does over one timeline. */
interface Picture {
  /** Walkers or cars that were there, gone for a frame, and back. */
  blinks: number;
  /** Frames on which a body moved against its own heading. */
  reversals: number;
  /** The worst such backward step, metres. */
  worstStep: number;
  /** How much was actually on screen, so a zero above cannot be a zero sample. */
  livePeds: number;
  liveCars: number;
}

function picture(ticks: readonly number[], bands: readonly PedBand[], field: TrafficField): Picture {
  const out: Picture = { blinks: 0, reversals: 0, worstStep: 0, livePeds: 0, liveCars: 0 };
  const pose = createPedPose();

  // --- The walkers. Existence and position, per band and slot, per frame.
  for (const band of bands) {
    for (let slot = 0; slot < band.slots; slot++) {
      let was2 = false;
      let was1 = false;
      let ax = NaN;
      let az = NaN;
      let bx = NaN;
      let bz = NaN;
      for (let f = 0; f < ticks.length; f++) {
        const on = posePedestrian(band, slot, trafficSeconds(ticks[f]), undefined, pose);
        if (on) out.livePeds++;
        // Present, gone, present -- or its mirror. Either way the walker was
        // drawn on one frame and not on the frame beside it.
        if (f >= 2 && was1 !== was2 && was1 !== on) out.blinks++;
        if (on && was1 && was2 && Number.isFinite(ax)) {
          const d1x = bx - ax;
          const d1z = bz - az;
          const d2x = pose.x - bx;
          const d2z = pose.z - bz;
          if (d1x * d2x + d1z * d2z < 0) {
            out.reversals++;
            const m = Math.sqrt(d2x * d2x + d2z * d2z);
            if (m > out.worstStep) out.worstStep = m;
          }
        }
        ax = bx;
        az = bz;
        bx = on ? pose.x : NaN;
        bz = on ? pose.z : NaN;
        was2 = was1;
        was1 = on;
      }
    }
  }

  // --- And the schedule fleet, through the one iterator every consumer of it
  //     goes through -- the box fleet, the model fleet and the hit test alike.
  const carPose = createCarPose();
  const scratch: LaneRoute[] = [];
  const seen: Array<Set<number>> = [];
  const where: Array<Map<number, [number, number]>> = [];
  for (const tick of ticks) {
    const ids = new Set<number>();
    const at = new Map<number, [number, number]>();
    forEachCarNear(field, 0, -60, 200, tick, scratch, carPose, (p) => {
      ids.add(p.identity);
      at.set(p.identity, [p.x, p.z]);
    });
    seen.push(ids);
    where.push(at);
  }
  for (let f = 2; f < seen.length; f++) {
    out.liveCars += seen[f].size;
    for (const id of seen[f]) {
      // There two frames ago, gone last frame, back now: `TrafficMovers.update`
      // writes `mesh.count` from this walk, so the missing frame drew nothing.
      if (!seen[f - 1].has(id) && seen[f - 2].has(id)) out.blinks++;
      const c = where[f - 2].get(id);
      const a = where[f - 1].get(id);
      const b = where[f].get(id);
      if (c === undefined || a === undefined || b === undefined) continue;
      const d1x = a[0] - c[0];
      const d1z = a[1] - c[1];
      const d2x = b[0] - a[0];
      const d2z = b[1] - a[1];
      if (d1x * d2x + d1z * d2z < 0) {
        out.reversals++;
        const m = Math.sqrt(d2x * d2x + d2z * d2z);
        if (m > out.worstStep) out.worstStep = m;
      }
    }
  }
  return out;
}

export function verifyDrawClock(): string[] {
  const failures: string[] = [];

  // --- 1. The identity that keeps the picture and the hit test on one clock.
  //
  // `trafficTick` is the floor of this function's own value, so a car drawn
  // between two ticks is drawn on the timetable the whole tick either side of it
  // was hit-tested against. If these two ever stop agreeing, the car you are
  // drawn being hit by stops being the car that hit you.
  {
    let checked = 0;
    for (let ms = TRAFFIC_EPOCH_MS; ms < TRAFFIC_EPOCH_MS + 4000; ms += 1) {
      if (Math.floor(drawTick(ms)) !== trafficTick(ms)) {
        failures.push(
          `\`drawTick\` and \`trafficTick\` disagree at ${ms - TRAFFIC_EPOCH_MS} ms past the epoch: ` +
            `floor(${drawTick(ms)}) is not ${trafficTick(ms)}. The picture and the hit test are on two clocks.`,
        );
        break;
      }
      checked++;
    }
    // ...and far out, where a float32 would have given up long ago.
    for (let day = 1; day <= 400; day += 7) {
      const ms = TRAFFIC_EPOCH_MS + day * 86_400_000 + 12_345;
      if (Math.floor(drawTick(ms)) !== trafficTick(ms)) {
        failures.push(`\`drawTick\` and \`trafficTick\` disagree ${day} days past the epoch.`);
        break;
      }
      checked++;
    }
    if (checked === 0) failures.push('`verifyDrawClock` checked no milliseconds; section 1 proved nothing.');
  }

  // --- 2. The counter-example, run rather than described.
  //
  // The superseded expression must still be **broken**, or section 3's zero is
  // a zero nobody earned: a driver that cannot distinguish a fixed clock from a
  // broken one is a driver that would pass on both. See the header.
  {
    const at120 = backwards(timeline(120, FRAMES, 'old'));
    if (at120.frames === 0) {
      failures.push(
        '`verifyDrawClock` section 2 could not reproduce the clock it exists to have removed: the ' +
          'superseded `trafficTick(now) + accumulator / FIXED_DT` stepped forwards on every one of ' +
          `${FRAMES} frames at 120 Hz. Either \`framestep.planSteps\` or \`TRAFFIC_HZ\` has changed ` +
          'underneath this file, and section 3 below is now proving nothing. Fix the driver, not the counter.',
      );
    } else if (at120.worst * (1000 / TRAFFIC_HZ) < 1) {
      failures.push(
        `Section 2's counter-example stepped backwards by only ${(at120.worst * (1000 / TRAFFIC_HZ)).toFixed(2)} ms; ` +
          'it used to be 8.3, and a millisecond is not enough for section 3 to be measuring anything.',
      );
    }
  }

  // --- 3. The picture, on the clock that ships.
  //
  // Real bands off a real synthetic sidecar, and a real route field: eight
  // routes on one street, which is what `forEachCarNear` walks in a suburb.
  const bands: PedBand[] = [];
  for (let i = 0; i < 16; i++) {
    const tile = syntheticTile(3.75, 0, i * 400, UNIFORM_CROWD, undefined, 3, 0, 0x40 + i);
    if (tile === null) {
      failures.push('`verifyDrawClock` could not round-trip its own synthetic lane sidecar.');
      return failures;
    }
    bands.push(...buildBands(tile, UNIFORM_CROWD));
  }
  const field = new TrafficField();
  for (let i = 0; i < 8; i++) {
    const tile = syntheticTile(1.875, 0, 0, UNIFORM_CROWD, undefined, 3, 0, 0x21 + i);
    if (tile === null) {
      failures.push('`verifyDrawClock` could not round-trip its own synthetic route sidecar.');
      return failures;
    }
    field.adopt(`street_${i}`, tile);
  }
  if (bands.length === 0) {
    failures.push('`verifyDrawClock` built no pedestrian bands, so section 3 sampled nobody.');
    return failures;
  }

  for (const hz of CADENCES) {
    const ticks = timeline(hz, FRAMES, 'now');
    const back = backwards(ticks);
    if (back.frames > 0) {
      failures.push(
        `At ${hz} Hz the draw clock stepped **backwards** on ${back.frames} of ${FRAMES} frames, worst ` +
          `${(back.worst * (1000 / TRAFFIC_HZ)).toFixed(1)} ms. Everything ambient in this game is a pure ` +
          'function of that number, so a clock that goes backwards is a world that goes backwards.',
      );
    }
    const seen = picture(ticks, bands, field);
    if (seen.livePeds === 0) {
      failures.push(`At ${hz} Hz no walker was on the footpath on any frame; section 3 measured nothing.`);
    }
    if (seen.liveCars === 0) {
      failures.push(`At ${hz} Hz no schedule car was in range on any frame; section 3 measured nothing.`);
    }
    if (seen.blinks > 0) {
      failures.push(
        `At ${hz} Hz ${seen.blinks} body/bodies were drawn, gone for exactly one frame, and back -- over ` +
          `${seen.livePeds} lived pedestrian-frames and ${seen.liveCars} car-frames. \`TrafficMovers.update\` ` +
          'writes `mesh.count` from its walk, so a frame out of the walk is a frame not drawn: this is a ' +
          'person or a car blinking out of the world.',
      );
    }
    if (seen.reversals > 0) {
      failures.push(
        `At ${hz} Hz ${seen.reversals} body-frames moved *against* their own heading, worst ` +
          `${seen.worstStep.toFixed(3)} m. Nothing ambient in this game ever reverses: they are closed-form ` +
          'functions of the tick, so this is the clock jittering and the whole street shimmering with it.',
      );
    }
  }

  return failures;
}
