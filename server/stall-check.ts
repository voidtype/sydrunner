/**
 * stall-check.ts -- does the instrument answer the question it was built for?
 *
 *     bun run server/stall-check.ts
 *
 * ---------------------------------------------------------------------------
 * ## Why this is not covered by the three `verify*` functions
 *
 * `verifyFrameStep`, `verifyStallRing` and `verifyBoundaryLog` each check one
 * module in isolation, and all three pass on a build where the instrument as a
 * whole is useless. The question the instrument exists to answer is not "does
 * the percentile work" -- it is:
 *
 *     Given a session, can this thing tell a distance-driven stall from a
 *     timer-driven one?
 *
 * That is a property of the three modules *composed*, and if the answer is no
 * then `docs/instructions.md` phase 0 produces a confident wrong result and the
 * next fortnight is spent in the wrong place. So this drives three synthetic
 * sessions through the real `BoundaryLog` and the real `StallRing` at a real
 * 60 Hz, and asserts the summary reaches the right verdict about each.
 *
 * Synthetic on purpose. A driver over a live client would be a browser test,
 * which this repo does not do, and it would prove less: what is being checked
 * here is that the *inference* is sound, and for that the ground truth has to be
 * something the test chose.
 *
 * ## The three sessions
 *
 *   A. **Distance-driven at speed.** 44 m/s, a stall on every tile boundary.
 *      Truth: streaming. The summary must show a high boundary share and an
 *      interval near 11.4 s.
 *   B. **Timer-driven at the same speed.** 44 m/s, a stall every 10 s on the
 *      clock, ignoring where the player is. Truth: not streaming. The boundary
 *      share must come out low -- this is the discrimination that matters, and
 *      it is the one that fails if the boundary log is subtly wrong.
 *   C. **Distance-driven at a walk.** 5 m/s, a stall on every tile boundary.
 *      Truth: streaming, and the interval must stretch to about 100 s. This is
 *      the speed-scaling prediction the whole hypothesis rests on.
 */

import { StallRing, type StallRecord } from '../client/src/game/stallring.ts';
import { BoundaryLog } from '../client/src/world/boundarylog.ts';

const DT = 1 / 60;
const GRID_M = 500;
/** A healthy machine's overhead outside our own sections, milliseconds. */
const FLOOR_MS = 4;

interface Session {
  name: string;
  speed: number;
  seconds: number;
  /** Given the frame's crossing and the clock, does this frame stall? */
  stalls: (crossed: string, tMs: number) => boolean;
  /** Is the stall the browser taking the thread, or our own code being slow? */
  stolen?: boolean;
}

function run(session: Session): ReturnType<StallRing['summarise']> {
  const ring = new StallRing();
  const log = new BoundaryLog(GRID_M);
  const frames = Math.round(session.seconds / DT);
  let x = 0;
  let lastStallMs = -1e9;
  for (let f = 0; f < frames; f++) {
    const tMs = f * DT * 1000;
    x += session.speed * DT;
    const crossing = log.note(x, 0, DT);
    // Every frame feeds the floor, exactly as the client does.
    ring.observe(FLOOR_MS);
    if (!session.stalls(crossing.crossed, tMs)) continue;
    // One stall per event, not one per frame it is still true on.
    if (tMs - lastStallMs < 500) continue;
    lastStallMs = tMs;
    /*
     * **A streaming stall is time *we* spent**, so the gap outside our sections
     * stays ordinary and only the frame gets long. The first draft of this file
     * handed every synthetic stall 60 ms of stolen time and then asserted the
     * classifier would call it streaming, which it correctly refused to do --
     * `classify` puts stolen time first precisely because if the browser took
     * the thread it does not matter what our sections were doing. The check was
     * wrong, not the classifier.
     */
    const outside = session.stolen ? FLOOR_MS + 60 : FLOOR_MS;
    const rec: StallRecord = {
      atMs: tMs,
      frameMs: 64,
      stolenMs: ring.stolen(outside),
      speed: crossing.speed,
      steps: 1,
      compiles: 0,
      tiles: crossing.crossed.includes('grid') ? 2 : 0,
      sheets: 0,
      crossed: crossing.crossed,
      worst: 'render 40.0',
      longtaskMs: 0,
    };
    ring.add(rec);
  }
  return ring.summarise();
}

const failures: string[] = [];
const check = (ok: boolean, what: string, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

console.log('\n--- A. distance-driven at 44 m/s: the streaming case ---');
{
  const s = run({
    name: 'A',
    speed: 44,
    seconds: 300,
    stalls: (crossed) => crossed.includes('grid'),
  });
  console.log(`  ${s.line}`);
  check(s.stalls > 20, 'five minutes at speed produced enough stalls to reason about', `${s.stalls}`);
  check(Math.abs(s.intervalS - GRID_M / 44) < 1.0, 'the interval matches the tile grid at this speed',
    `${s.intervalS.toFixed(1)} s against ${(GRID_M / 44).toFixed(1)} s`);
  check(s.crossedShare > 0.95, 'nearly every stall landed on a boundary crossing',
    `${Math.round(s.crossedShare * 100)}%`);
  check(s.byKind.stream === s.stalls, 'and they classify as streaming', JSON.stringify(s.byKind));
  check(Math.abs(s.meanSpeed - 44) < 1, 'the recorded speed is the real one', `${s.meanSpeed.toFixed(1)} m/s`);
}

console.log('\n--- B. timer-driven at 44 m/s: the case that must NOT look like streaming ---');
{
  let next = 10_000;
  const s = run({
    name: 'B',
    speed: 44,
    seconds: 300,
    stalls: (_crossed, tMs) => {
      if (tMs < next) return false;
      next += 10_000;
      return true;
    },
    // A timer-driven stall in this game would be a collection or a driver, so
    // it is modelled as time taken from outside our sections.
    stolen: true,
  });
  console.log(`  ${s.line}`);
  check(Math.abs(s.intervalS - 10) < 0.6, 'the interval is the timer, not the grid', `${s.intervalS.toFixed(1)} s`);
  check(s.byKind.stolen === s.stalls, 'and a browser stall classifies as stolen, not as our work', JSON.stringify(s.byKind));
  /*
   * **The assertion this whole file exists for.** A player moving at 44 m/s
   * crosses a tile boundary on 1 frame in 682, so a stall that has nothing to do
   * with streaming should almost never coincide with one. If this share comes
   * out high, the boundary log is over-reporting and phase 0 would conclude
   * "streaming" from a session that had nothing to do with it.
   */
  check(s.crossedShare < 0.1, 'and almost none of them coincided with a boundary',
    `${Math.round(s.crossedShare * 100)}% — a false positive here would send the investigation to the wrong place`);
}

console.log('\n--- C. distance-driven at a walk: the speed-scaling prediction ---');
{
  const s = run({
    name: 'C',
    speed: 5,
    seconds: 1200,
    stalls: (crossed) => crossed.includes('grid'),
  });
  console.log(`  ${s.line}`);
  check(Math.abs(s.intervalS - GRID_M / 5) < 4, 'walking stretches the interval to about 100 s',
    `${s.intervalS.toFixed(0)} s against ${(GRID_M / 5).toFixed(0)} s`);
  check(s.crossedShare > 0.95, 'and it is still every crossing', `${Math.round(s.crossedShare * 100)}%`);
}

console.log('\n--- D. the ordinary band: a healthy session records nothing ---');
{
  const ring = new StallRing();
  // A machine at 4.0-4.6 ms of overhead: the band top belongs at 4.6, not at 4.0.
  // `baseline()` names the *top* of the ordinary band, which is the thing worth
  // subtracting -- see `stallring.ts` on why the 5th percentile was wrong.
  for (let i = 0; i < 3600; i++) ring.observe(FLOOR_MS + (i % 7) * 0.1);
  const base = ring.baseline();
  check(Math.abs(base - (FLOOR_MS + 0.6)) < 0.15, 'the band top sits at the top of the jitter, not the bottom',
    `${base.toFixed(2)} ms against ${(FLOOR_MS + 0.6).toFixed(2)}`);
  check(ring.stolen(FLOOR_MS + 0.6) === 0, 'and a healthy frame is not reported as theft',
    `${ring.stolen(FLOOR_MS + 0.6).toFixed(2)} ms — the 5th percentile failed this and the 95th passes`);
  check(Math.abs(ring.stolen(FLOOR_MS + 60) - 60) < 1.0, 'while a 60 ms injection reports 60, not 64',
    `${ring.stolen(FLOOR_MS + 60).toFixed(1)} ms`);
  check(ring.summarise().stalls === 0, 'a session with no stalls summarises as none');
}

if (failures.length > 0) {
  console.error(`\nstall-check: ${failures.length} failure(s).`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nstall-check: the instrument tells distance from time.');
