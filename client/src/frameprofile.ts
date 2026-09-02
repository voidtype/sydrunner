/**
 * Where the browser frame went, section by section, permanently and for nothing.
 *
 * ---------------------------------------------------------------------------
 * ## Why this file exists
 *
 * `server/profile.ts` was written because the tick had ten phase labels and
 * thirty systems, so a regression could hide inside somebody else's bucket. The
 * frame had it worse: it had **no labels at all**. `medianFrameMs` in `main.ts`
 * reports one number for the whole `requestAnimationFrame` callback, and a
 * handful of renderers -- `TrafficMovers.costMs`, `PedestrianCrowd.costMs`,
 * `PoliceSquad.costMs`, `StreetCrowd.costMs`, `WildlifeFlock.costMs`,
 * `RaveWorld.costMs` -- each time themselves and report onto the debug overlay.
 * Six self-timers and one total is not a breakdown: everything *not* in those
 * six (the camera boom's occlusion march, the night rig, the nameplates' forced
 * matrix walk, the team look, the HUD, and `renderer.render` itself) was
 * invisible, and between them they are most of a frame.
 *
 * Since the last frame-cost pass this client gained team tint and rings and
 * horns, car smoke and flames and scorch, driven cars, the character crowd, the
 * ambient events, Polair, the hands viewmodel, the cash notes, and two more real
 * lights. Not one of those arrived with a number beside it. So this is the same
 * fix `server/profile.ts` made, on the other side of the wire: named sections
 * that **tile** the frame, and a place to see them.
 *
 * ---------------------------------------------------------------------------
 * ## The cursor, and why there are no begin/end pairs
 *
 * Taken wholesale from `server/profile.ts`, including the argument. The obvious
 * shape is `const t = now(); ...; acc.x += now() - t`, which costs **two** clock
 * reads per section and silently loses every line that falls between one pair
 * and the next. At the granularity a frame needs -- twenty sections over eighteen
 * hundred lines of `main.ts` -- the lost fraction is not a rounding error, it is
 * the answer.
 *
 * This is a cursor instead. `at(FSEC.foo)` closes whatever section was open,
 * charges it the elapsed time, and opens `foo`. One clock read per boundary, and
 * the sections tile the callback: between `begin()` at the top and `stop()` at
 * the bottom, every nanosecond is charged to somebody. The discipline that buys
 * is the same one: **a section is not a scope**. A helper that marks a section
 * must mark its caller's back on the way out. `main.ts`'s frame loop is a flat
 * sequence and never nests, which is what makes that easy to keep true.
 *
 * ---------------------------------------------------------------------------
 * ## A ring of frames, not a monotonic counter with readers
 *
 * This is the one place the design departs from the server's, and it departs
 * deliberately.
 *
 * `TickProfile` accumulates forever and hands each consumer a `ProfileReader`
 * that subtracts, because a tick profile has several consumers on different
 * clocks (`/stats`, the ten-second line, `tick-profile.ts`) and a shared
 * resettable counter is a bug this project has already paid for once.
 *
 * A frame profile has a different question to answer. Nobody wants "the mean
 * since boot" -- boot includes the first ten seconds when the streamer is
 * hammering and half the world is missing, and that mean never washes out. What
 * a person staring at a stutter wants is *the last two seconds*, and the **worst
 * single frame** in them, broken down. A mean cannot show a hitch; a hitch is
 * precisely the frame the mean is hiding.
 *
 * So the store is a ring of the last `WINDOW` frames, one row of sections each.
 * `at()` accumulates straight into the current row, `stop()` closes it and
 * advances. 120 rows of 20 float64s is 19 kB, allocated once at construction and
 * never again. The mean over the window and the worst row in it both fall out of
 * one pass over 19 kB, which happens four times a second for the overlay and
 * never otherwise.
 *
 * A monotonic `acc` is kept alongside for the session total, because "this
 * session has spent 41 s in `renderer.render`" is a different and occasionally
 * useful question, and it is two adds a frame.
 *
 * ---------------------------------------------------------------------------
 * ## Always on
 *
 * Twenty-one boundaries a frame at the clock cost measured below. On an M-series
 * Mac `performance.now()` is about 30 ns, so 0.6 us against a 16,667 us budget:
 * 0.004%. In a browser the clock is *coarsened* for cross-origin isolation
 * reasons -- Chrome quantises to 100 us without COOP/COEP, 5 us with -- which
 * makes each read cheap but each *reading* grainy. That grain is why the report
 * is a mean over a window rather than a single frame's numbers, and it is why
 * `CLOCK_MS` is measured at load on the machine that is actually running rather
 * than quoted from the dev box.
 *
 * A profile you have to switch on is a profile that is not running the day
 * something regresses, which is the entire history of `server/profile.ts`. So
 * the *measuring* is unconditional. Only the **overlay** is behind `?perf=1`,
 * because that is a DOM write and a string build, and those genuinely are not
 * free at 165 Hz.
 *
 * `overheadUs()` reports what it cost, so the claim above is a measurement in
 * the report rather than a comment.
 *
 * ---------------------------------------------------------------------------
 * ## Three-free, and DOM-free until asked
 *
 * Nothing here imports three, and nothing here touches `document` at module
 * scope. That is not tidiness: it is what lets `client/src/perf-harness.ts` run
 * the identical profiler over the identical renderers under bun, with no browser
 * and no WebGPU device, and get a table that means the same thing as the
 * overlay. See that file's header -- the whole point of it is that the CPU half
 * of a frame can be measured without a GPU, and this is the instrument both
 * halves share.
 */

/**
 * Every section of a frame, in the order `main.ts`'s `setAnimationLoop` runs
 * them.
 *
 * Integers rather than strings, on `server/profile.SEC`'s argument: `at()` is
 * called twenty times a frame at up to 165 Hz and a string key would be a hash
 * lookup on the hot path for the benefit of a report that runs four times a
 * second and can afford the array lookup instead.
 *
 * The grouping is "what a person would cut", not "what a file is called". Three
 * of these deserve their reasoning written down because the obvious grouping is
 * the wrong one:
 *
 *   - **`camera`** holds the occlusion march. It is the only per-frame call into
 *     `CollisionWorld` and it is a variable number of sphere probes, so it can
 *     be the worst thing in a frame while standing in a lane between two
 *     terraces -- and it would be invisible folded into `sim`.
 *   - **`npcvoice`** is separate from `police` even though it walks the same
 *     actor list. The renderers are O(actors near the camera); the five voice
 *     scans are O(**all** actors) with a `Set` probe each, and separating them
 *     is what makes it possible to say which of the two is the cost.
 *   - **`plates`** is separate from `actors` because it forces a world-matrix
 *     recompose per remote (`updateMatrixWorld(true)`), which is a different
 *     kind of expensive from posing a skeleton and is the one this file was
 *     written expecting to find.
 *
 * `carSmoke` has no section of its own: `DrivenCarView.update` calls its
 * `begin`/`end` from inside the walk that poses every driven car, deliberately
 * (see `world/drivencars.ts`), so its cost is `traffic`'s and splitting it would
 * mean marking a boundary inside another module's loop.
 */
export const FSEC = {
  /** Reading the keyboard, the two steering shapers, the lean. */
  input: 0,
  /** The fixed-step accumulator: `simulate(FIXED_DT)`, up to eight of them. */
  sim: 1,
  /**
   * `applyToCamera`, the net correction, the chase boom's occlusion march, the
   * feedback shake, and the swat puffs that ride on the same frame delta.
   */
  camera: 2,
  /** The vitals, the chips, the level, the talents panel, the maps, the money, the locator. */
  hud: 3,
  /** `sky.update`, the clock strip and the two global uniforms. */
  sky: 4,
  /** `streamer.update`, the rail prefetch, the far hexes, `updateLife`, and the ground poll. */
  stream: 5,
  /** `railWorld.update`, `trains.update`, the announcement mix, the door marker, the sun. */
  rail: 6,
  /** `nightLights.update` and the sprite visibility flag. */
  lights: 7,
  /** The car LOD sweep, the driven fleet (and its smoke), the box fleet. */
  traffic: 8,
  /** The ferries and the tinnies: a pose per boat, and the distance cull. */
  boats: 9,
  /** `PedestrianCrowd.update` and the raves that share its rig pool. */
  crowd: 10,
  /** The squad, the street factions, the flock, the five characters, the ambient events. */
  police: 11,
  /** The five rising-edge scans over every actor, the tracers, the barks. */
  npcvoice: 12,
  /** The investigation banner, the star row, the patrol fleet, Polair, the mixes. */
  heat: 13,
  /** Every rig posed on the frame delta: the fighters, the three viewmodels, the remotes. */
  actors: 14,
  /** The parked and ridden bikes, their headlights, and every football in the air. */
  bikes: 15,
  /** `nameplates`, and the forced world-matrix recompose per plate that it needs. */
  plates: 16,
  /** `updateTeamLook`: the tinted bodies, the horns, the ground rings and the tents. */
  teams: 17,
  /** `renderer.render`. Everything above this line is what the CPU did to prepare it. */
  render: 18,
  /** The bug box's grab, the frame ring, and the 2.5 Hz debug overlay. */
  present: 19,
} as const;

/** Parallel to `FSEC`; index by the constant to get the label. */
export const FRAME_SECTION_NAMES: readonly string[] = [
  'input', 'sim', 'camera', 'hud', 'sky', 'stream', 'rail', 'lights',
  'traffic', 'boats', 'crowd', 'police', 'npcvoice', 'heat', 'actors', 'bikes',
  'plates', 'teams', 'render', 'present',
];

export const FRAME_SECTION_COUNT = FRAME_SECTION_NAMES.length;

/**
 * How many frames the ring remembers. The brief's number, and it is the right
 * one: at 60 Hz it is two seconds, which is about as long as a person holds a
 * stutter in their head before deciding the game is bad.
 */
export const WINDOW = 120;

/**
 * What one `performance.now()` costs on this machine, in milliseconds.
 *
 * Measured at module load rather than quoted, exactly as `server/profile.ts`
 * does, and for a sharper reason here: the client runs on whatever the player
 * has, and browsers deliberately degrade this clock. Chrome coarsens
 * `performance.now()` to 100 us on a page that is not cross-origin isolated and
 * to 5 us on one that is, Firefox to 1 ms by default. A *coarse* clock is not
 * necessarily a *slow* one -- the read is still tens of nanoseconds and the
 * quantisation washes out over a window -- but the two failure modes look
 * identical from a report, so the cost is measured and the grain is inferred
 * from `CLOCK_GRAIN_MS` below.
 *
 * Ten thousand reads rather than the server's hundred thousand: this runs on the
 * boot path of a page a player is waiting for, and 10 k is about 0.3 ms while
 * still leaving the loop's own overhead in the noise. The sink is kept and
 * consumed for the reason the server's is -- a JIT that sank the call would
 * report an absurdly small number rather than a silently wrong one.
 */
function measureClock(): number {
  const N = 10_000;
  let sink = 0;
  for (let i = 0; i < 1_000; i++) sink += performance.now();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) sink += performance.now();
  const t1 = performance.now();
  if (sink === -1) throw new Error('unreachable');
  return (t1 - t0) / N;
}

export const CLOCK_MS = measureClock();

/**
 * The smallest non-zero step this machine's clock will report, in milliseconds.
 *
 * The number that says whether a section reading 0.00 means "free" or means
 * "below the resolution of the instrument", which are very different findings
 * and are indistinguishable without it. Measured by spinning until the clock
 * moves and taking the smallest move seen; a handful of samples is enough
 * because quantisation is exact rather than noisy.
 */
function measureGrain(): number {
  let smallest = Infinity;
  for (let s = 0; s < 32; s++) {
    const t0 = performance.now();
    let t1 = performance.now();
    // Spin until it actually moves. Bounded, so a pathological clock cannot
    // hang a boot.
    for (let guard = 0; t1 === t0 && guard < 2_000_000; guard++) t1 = performance.now();
    const d = t1 - t0;
    if (d > 0 && d < smallest) smallest = d;
  }
  return smallest === Infinity ? 0 : smallest;
}

export const CLOCK_GRAIN_MS = measureGrain();

/** One section of a report: its label and what it cost. */
export interface SectionRow {
  name: string;
  /** Mean milliseconds per frame over the window. */
  meanMs: number;
  /** What this section cost in the *worst* frame of the window. */
  worstMs: number;
}

/** What `FrameProfile.report()` answers, and what `sydney.frame()` prints. */
export interface FrameReport {
  /** Frames in the window -- `WINDOW` once the ring has filled. */
  frames: number;
  /** Mean total milliseconds per frame over the window. */
  meanMs: number;
  /** The worst single frame in the window, milliseconds. */
  worstMs: number;
  /** Sections, sorted by mean cost, worst first. */
  sections: SectionRow[];
  /** What the profiler itself cost per frame, microseconds. */
  overheadUs: number;
  /** The clock's quantum, microseconds. A section under this is unmeasurable. */
  grainUs: number;
  /** Frames profiled since the page loaded, for reading `totalMs` as a rate. */
  lifetimeFrames: number;
}

/**
 * One client's frame, sectioned.
 *
 * There is exactly one of these per page and it lives in `main.ts`'s closure
 * beside the frame loop. It is not a singleton and not a module global, because
 * `perf-harness.ts` builds several -- one per scene -- and comparing two scenes
 * means comparing two of these side by side.
 */
export class FrameProfile {
  /**
   * The ring: `WINDOW` rows of `FRAME_SECTION_COUNT` milliseconds.
   *
   * Flat rather than an array of arrays, so the whole window is one allocation
   * and one cache-friendly pass. Row `r` starts at `r * FRAME_SECTION_COUNT`.
   */
  private readonly ring = new Float64Array(WINDOW * FRAME_SECTION_COUNT);
  /** Total milliseconds charged in each row, so the worst frame is one scan. */
  private readonly totals = new Float64Array(WINDOW);
  /** Milliseconds charged to each section since the page loaded. */
  readonly acc = new Float64Array(FRAME_SECTION_COUNT);

  /** The row `at()` is currently writing into. */
  private row = 0;
  /** Rows written; caps at `WINDOW` for the mean's divisor. */
  private filled = 0;
  /** Frames profiled since the page loaded. */
  frames = 0;
  /** Boundaries crossed since the page loaded, for `overheadUs`. */
  marks = 0;

  /** The section currently accumulating, or -1 between frames. */
  private cursor = -1;
  /** The clock at the last boundary. */
  private lastAt = 0;

  /**
   * The clock this profiler reads. `performance.now` in the game; a counter in
   * the self-check.
   *
   * ---------------------------------------------------------------------------
   * **Injected so the self-check can stop measuring the machine.**
   *
   * Almost everything `verifyFrameProfile` asserts is *bookkeeping* -- that a
   * row is zeroed before it is reused, that the sections of a frame add up to
   * that frame, that a frame still being written is not in the window. None of
   * it is about the clock. But the only way to put a known duration into a
   * profiler that reads `performance.now()` itself is to burn that long in a
   * spin loop, so every one of those assertions was really asserting *"and the
   * browser did not deschedule this tab for two milliseconds in the middle"*.
   *
   * It does, and when it did the game refused to boot: `A hitch pushed 120
   * frames into the past still reports as the worst frame (5.000 ms)`, reported
   * by the owner against a build in which the ring was perfectly fine. A
   * self-check that locks players out when a laptop hiccups is worse than the
   * bug it is guarding, and loosening the tolerance only makes the flake rarer
   * and the check weaker at the same time.
   *
   * With a counter the durations are exact and the tolerances go from 0.3 ms to
   * a rounding error, so the check is both unbreakable by the scheduler and
   * *stricter* than it was. What genuinely needs the real clock -- the grain
   * measurement and the per-boundary overhead -- still uses it, and says so.
   *
   * **The hot path pays a monomorphic call** in place of a direct one. It is
   * one call site with one implementation for the life of the process, which is
   * the shape every JIT inlines, and `overheadUs()` is measured against a 30 us
   * budget by this file's own check -- so a regression here is caught by the
   * one number that would notice.
   */
  private readonly clock: () => number;

  /** `performance.now` unless a caller says otherwise. See `clock`. */
  constructor(clock?: () => number) {
    this.clock = clock ?? (() => performance.now());
  }

  /**
   * Open a frame. Zeroes the row about to be written and arms the cursor.
   *
   * The zeroing is nineteen stores and it has to happen *here* rather than at
   * `stop()`: a frame that threw out of `renderer.render` -- which `RenderGuard`
   * exists because it happens -- would otherwise leave a half-filled row in the
   * ring forever, and the worst-frame scan would keep finding it.
   */
  /** The frame just closed: what our own sections spent, milliseconds. */
  lastMs = 0;
  /** Its heaviest section and what that section cost. */
  lastWorstMs = 0;
  lastWorstSection = 0;

  /** `render 214.0`, for a stall record. Allocates; only called on a stall. */
  lastWorst(): string {
    return `${FRAME_SECTION_NAMES[this.lastWorstSection] ?? '?'} ${this.lastWorstMs.toFixed(1)}`;
  }

  begin(): void {
    const base = this.row * FRAME_SECTION_COUNT;
    for (let i = 0; i < FRAME_SECTION_COUNT; i++) this.ring[base + i] = 0;
    this.cursor = -1;
    this.lastAt = this.clock();
    this.marks++;
  }

  /**
   * Close the open section and open `sec`.
   *
   * The one hot-path function in this file: two array reads, a subtract, an
   * array write and a clock read. No allocation, no strings, no map.
   */
  at(sec: number): void {
    const now = this.clock();
    if (this.cursor >= 0) this.ring[this.row * FRAME_SECTION_COUNT + this.cursor] += now - this.lastAt;
    this.cursor = sec;
    this.lastAt = now;
    this.marks++;
  }

  /**
   * Close the frame: charge the open section, fold the row into the lifetime
   * accumulator, record the total, and advance the ring.
   *
   * Called at the bottom of the animation callback. A profile that was never
   * stopped would charge the *gap between frames* -- up to 16 ms of the browser
   * doing compositing and input -- to whichever section happened to be open
   * last, which is a report saying `present` costs 16 ms. That is
   * `TickProfile.stop`'s lesson and it is the same one here.
   */
  stop(): void {
    const now = this.clock();
    const base = this.row * FRAME_SECTION_COUNT;
    if (this.cursor >= 0) this.ring[base + this.cursor] += now - this.lastAt;
    this.cursor = -1;
    this.marks++;

    let total = 0;
    let worst = 0;
    let worstAt = 0;
    for (let i = 0; i < FRAME_SECTION_COUNT; i++) {
      const v = this.ring[base + i];
      this.acc[i] += v;
      total += v;
      if (v > worst) {
        worst = v;
        worstAt = i;
      }
    }
    this.totals[this.row] = total;
    // The frame just closed, kept for one reader: `game/stallring.ts` needs
    // *this* frame's total to subtract from the animation-frame delta, and
    // `report()` cannot answer that -- it folds a two-second window, which is
    // the right shape for "what is this session costing" and the wrong one for
    // "what did the browser take from us on the frame we just missed".
    this.lastMs = total;
    this.lastWorstMs = worst;
    this.lastWorstSection = worstAt;
    this.row = (this.row + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
    this.frames++;
  }

  /** What the profiler itself cost per frame over its life, microseconds. */
  overheadUs(): number {
    if (this.frames === 0) return 0;
    return (this.marks * CLOCK_MS * 1000) / this.frames;
  }

  /** Milliseconds charged to one section since the page loaded. */
  totalOf(sec: number): number {
    return this.acc[sec];
  }

  /**
   * The window, folded: mean per section, the worst frame, and that frame's
   * breakdown.
   *
   * One pass to find the worst row and sum the columns, then one sort. Called
   * from the overlay at 2.5 Hz and from `sydney.frame()` by hand, so it is
   * allowed to allocate -- and does, because a report is a thing you look at
   * rather than a thing the frame budget pays for.
   */
  report(): FrameReport {
    const n = this.filled;
    if (n === 0) {
      return {
        frames: 0, meanMs: 0, worstMs: 0, sections: [],
        overheadUs: 0, grainUs: CLOCK_GRAIN_MS * 1000, lifetimeFrames: 0,
      };
    }
    /*
     * **The row that is still being written is not in the window.**
     *
     * It used to be, and it cost the stall investigation a week. `begin()`
     * zeroes `ring[row]` and the frame refills it live, but `totals[row]` is
     * only written by `stop()` -- so mid-frame that row carries a *total* from
     * `WINDOW` frames ago and *sections* from the frame now running. A caller
     * asking "what did this frame do" got a worst-row chosen from one frame and
     * a breakdown read from another, with nothing on the line to say so, and
     * the console printed `269 ms, render 29.3ms` for twenty frames whose
     * render never took 29.3 ms.
     *
     * The overlay loses one frame in 120 and does not care; the single-frame
     * question was never this method's to answer and is served by `lastMs` and
     * `lastWorst()`, which `stop()` fills and which are exactly in phase.
     */
    const open = this.cursor >= 0 ? this.row : -1;
    let worstRow = -1;
    let worstMs = -1;
    let sum = 0;
    let counted = 0;
    for (let r = 0; r < n; r++) {
      if (r === open) continue;
      const t = this.totals[r];
      sum += t;
      counted++;
      if (t > worstMs) {
        worstMs = t;
        worstRow = r;
      }
    }
    // The first frame of a session, asked mid-flight: there is no closed frame
    // to report yet. An empty report is the honest answer; the alternative is
    // handing back row zero's zeroes as if they were a measurement.
    if (counted === 0 || worstRow < 0) {
      return {
        frames: 0, meanMs: 0, worstMs: 0, sections: [],
        overheadUs: this.overheadUs(), grainUs: CLOCK_GRAIN_MS * 1000, lifetimeFrames: this.frames,
      };
    }
    const worstBase = worstRow * FRAME_SECTION_COUNT;
    const sections: SectionRow[] = [];
    for (let i = 0; i < FRAME_SECTION_COUNT; i++) {
      let colSum = 0;
      for (let r = 0; r < n; r++) {
        if (r === open) continue;
        colSum += this.ring[r * FRAME_SECTION_COUNT + i];
      }
      sections.push({
        name: FRAME_SECTION_NAMES[i],
        meanMs: colSum / counted,
        worstMs: this.ring[worstBase + i],
      });
    }
    // Sorted by mean rather than by the worst frame, because the question the
    // overlay answers first is "what is this frame made of" and the hitch is the
    // second question. `worstMs` rides on every row, so the hitch is one glance
    // down the second column rather than a second sort.
    sections.sort((a, b) => b.meanMs - a.meanMs);
    return {
      frames: counted,
      meanMs: sum / counted,
      worstMs,
      sections,
      overheadUs: this.overheadUs(),
      grainUs: CLOCK_GRAIN_MS * 1000,
      lifetimeFrames: this.frames,
    };
  }

  /**
   * The report as one line, for the on-screen strip.
   *
   * `topSections`' format from `server/profile.ts` so an operator reads one
   * shape in both places, with the window's mean and worst in front of it
   * because on a frame budget those are the two numbers that decide whether to
   * keep reading.
   */
  line(top = 6): string {
    const r = this.report();
    if (r.frames === 0) return 'frame: no samples yet';
    const parts = r.sections
      .filter((s) => s.meanMs > 0)
      .slice(0, top)
      .map((s) => `${s.name} ${s.meanMs.toFixed(2)}`);
    return `${r.meanMs.toFixed(2)} ms/f  worst ${r.worstMs.toFixed(1)}  |  ${parts.join(', ')}`;
  }

  /**
   * The full table, as text. What `sydney.frame()` prints and what
   * `perf-harness.ts` puts under each scene.
   *
   * A fixed-width table rather than `console.table`, because this has to read
   * the same in a browser console, in a bun terminal and pasted into a commit
   * message -- and `console.table` does none of those three.
   */
  table(label = ''): string {
    const r = this.report();
    const head = `${label ? label + '  ' : ''}${r.frames} frames  mean ${r.meanMs.toFixed(2)} ms  worst ${r.worstMs.toFixed(2)} ms  ` +
      `profiler ${r.overheadUs.toFixed(1)} us/f  clock grain ${r.grainUs.toFixed(1)} us`;
    const rows = r.sections.map(
      (s) => `  ${s.name.padEnd(9)} ${s.meanMs.toFixed(3).padStart(8)}  ${s.worstMs.toFixed(3).padStart(8)}`,
    );
    return [head, `  ${'section'.padEnd(9)} ${'mean ms'.padStart(8)}  ${'worst ms'.padStart(8)}`, ...rows].join('\n');
  }
}

/**
 * The on-screen strip, behind `?perf=1`.
 *
 * A separate class from the profile because the profile must stay DOM-free --
 * `perf-harness.ts` imports it under bun, where `document` does not exist -- and
 * because the two have different clocks: the profile is written every frame and
 * the strip is read four times a second. `hud.ts`' own rule, which every panel
 * in this client follows: compose, compare, and only then touch the DOM.
 *
 * Two and a half hertz rather than every frame, and the number is not arbitrary.
 * `report()` is a pass over 19 kB plus a sort plus a string build; at 165 Hz that
 * is a measurable fraction of the thing it is measuring, and a profiler that
 * changes the answer is not a profiler. At 2.5 Hz it is 0.4% of one frame in
 * sixty-six, which is under the clock's own grain.
 */
export class FrameOverlay {
  private el: HTMLElement | null = null;
  private lastPaint = 0;
  private lastText = '';

  /**
   * `enabled` is the caller's decision, not this class's, so `main.ts` reads
   * `?perf=1` in the same place it reads every other flag and this file needs no
   * opinion about query strings.
   */
  constructor(readonly enabled: boolean) {}

  /**
   * Paint if it is time and anything changed. Two comparisons on every frame the
   * flag is off, which is every frame of every real session.
   */
  update(profile: FrameProfile, nowMs: number): void {
    if (!this.enabled) return;
    if (nowMs - this.lastPaint < 400) return;
    this.lastPaint = nowMs;
    if (typeof document === 'undefined') return;
    if (this.el === null) {
      const el = document.createElement('div');
      el.id = 'perf-strip';
      // Inline rather than a class in `index.html`, because this is a debug
      // surface that must work on a build where the stylesheet failed to load
      // -- which is one of the situations somebody turns it on to diagnose.
      el.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:50;pointer-events:none;' +
        'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;' +
        'color:#cfe8ff;background:rgba(0,0,0,0.55);padding:6px 8px;border-radius:4px;' +
        'max-width:46ch';
      document.body.appendChild(el);
      this.el = el;
    }
    const r = profile.report();
    if (r.frames === 0) return;
    // The five worst by mean, then the worst frame's own top three -- which are
    // frequently a different three, and that difference is the whole reason to
    // have a strip rather than a single number. A hitch is not a slow mean.
    const byWorst = [...r.sections].sort((a, b) => b.worstMs - a.worstMs).slice(0, 3);
    const text =
      `${r.meanMs.toFixed(2)} ms/f  worst ${r.worstMs.toFixed(1)} ms  (${r.frames}f)\n` +
      r.sections
        .slice(0, 5)
        .map((s) => `${s.name.padEnd(9)}${s.meanMs.toFixed(2).padStart(6)}`)
        .join('\n') +
      `\nhitch: ${byWorst.map((s) => `${s.name} ${s.worstMs.toFixed(1)}`).join(', ')}`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.el.textContent = text;
  }
}

// --- The self-check -------------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 * Every failure below is silent in this project's sense: the game runs, the
 * frame draws, and the *report* is wrong -- which is the one failure mode that
 * matters for a file whose entire job is to be believed. `server/profile.ts`'s
 * `verifyProfile` makes the same argument and this is deliberately its sibling,
 * check for check, with two additions the ring brings:
 *
 *   - **Sections that do not tile.** The property the cursor exists for, checked
 *     against a real elapsed interval rather than against itself.
 *   - **A label that drifted from its constant.** `FSEC` and
 *     `FRAME_SECTION_NAMES` are two lists nothing in the type system keeps
 *     parallel. A swap mislabels a section forever and reads as one system
 *     mysteriously becoming another.
 *   - **A frame that keeps charging after it ended.** `stop` not clearing the
 *     cursor puts the browser's compositing between frames onto the last
 *     section.
 *   - **A ring that does not forget.** The whole value of the window is that a
 *     hitch two minutes ago is gone; a ring that never wrapped, or one whose row
 *     was not cleared before reuse, reports a stale worst frame forever.
 *   - **A worst frame that is not the worst frame.** The scan has to find the
 *     right row *and* report that row's breakdown, not the mean's.
 */
export function verifyFrameProfile(): string[] {
  const failures: string[] = [];

  // --- The two lists are parallel, and every constant is in range.
  const seen = new Set<number>();
  for (const [name, idx] of Object.entries(FSEC)) {
    if (idx < 0 || idx >= FRAME_SECTION_COUNT) {
      failures.push(`FSEC.${name} is ${idx}, outside the ${FRAME_SECTION_COUNT} names. The report would index undefined.`);
      continue;
    }
    if (FRAME_SECTION_NAMES[idx] !== name) {
      failures.push(`FSEC.${name} is ${idx}, which FRAME_SECTION_NAMES calls "${FRAME_SECTION_NAMES[idx]}". The report is mislabelled.`);
    }
    if (seen.has(idx)) failures.push(`Two sections share index ${idx}; one of them can never be reported.`);
    seen.add(idx);
  }
  if (seen.size !== FRAME_SECTION_COUNT) {
    failures.push(`${seen.size} constants for ${FRAME_SECTION_COUNT} names; a section has no way to be marked.`);
  }

  /**
   * The clock the bookkeeping checks below run on: a counter, in milliseconds.
   *
   * **Not `performance.now()`, and that is the whole point.** See
   * `FrameProfile.clock`: every assertion from here to the overhead
   * measurement is about the *ring* -- rows zeroed before reuse, sections that
   * add up to their frame, an open frame kept out of the window -- and none of
   * them is about time. Driving them with a spin loop meant every one of them
   * also asserted that the browser did not deschedule the tab in the middle,
   * which it does, and which locked the owner out of the game with `A hitch
   * pushed 120 frames into the past still reports as the worst frame (5.000
   * ms)` on a build whose ring was perfectly correct.
   *
   * On a counter the durations are exact, so the tolerances below are rounding
   * errors rather than the third of a millisecond a spin loop needed. The
   * check is unbreakable by the scheduler *and* stricter than it was.
   */
  let fake = 0;
  const burn = (ms: number): void => {
    fake += ms;
  };
  const profiler = (): FrameProfile => new FrameProfile(() => fake);

  // --- The sections tile the frame they cover.
  {
    const p = profiler();
    const began = fake;
    p.begin();
    p.at(FSEC.sim);
    burn(2);
    p.at(FSEC.traffic);
    burn(2);
    p.at(FSEC.render);
    burn(2);
    p.stop();
    const wall = fake - began;
    const r = p.report();
    const sum = r.sections.reduce((a, s) => a + s.meanMs, 0);
    if (Math.abs(sum - wall) > 1e-9) {
      failures.push(
        `Three sections over ${wall.toFixed(3)} ms accumulated ${sum.toFixed(3)} ms. ` +
          `The sections do not tile the frame, so the breakdown does not add up to the frame it is breaking down.`,
      );
    }
    const of = (name: string): number => r.sections.find((s) => s.name === name)?.meanMs ?? -1;
    if (Math.abs(of('sim') - 2) > 1e-9 || Math.abs(of('traffic') - 2) > 1e-9 || Math.abs(of('render') - 2) > 1e-9) {
      failures.push(
        `A 2 ms section was charged sim=${of('sim').toFixed(3)}, traffic=${of('traffic').toFixed(3)}, ` +
          `render=${of('render').toFixed(3)}. \`at\` is charging the section it opens rather than the one it closes.`,
      );
    }
    if (of('hud') !== 0) failures.push('A section nobody marked was charged time.');
    if (Math.abs(r.meanMs - r.worstMs) > 1e-9) {
      failures.push(`One frame reported mean ${r.meanMs.toFixed(3)} and worst ${r.worstMs.toFixed(3)}; they must be the same frame.`);
    }

    // --- Nothing accrues between frames.
    const parked = p.totalOf(FSEC.render);
    burn(3);
    if (p.totalOf(FSEC.render) !== parked) {
      failures.push('`stop` left the cursor open; the gap between frames is being charged to a section.');
    }

    // --- A frame in flight is not in the window.
    //
    // **This is the bug that cost the stall investigation a week**, encoded so
    // it cannot come back quietly. Mid-frame, `begin` has zeroed `ring[row]`
    // but `totals[row]` still holds the frame from `WINDOW` ago -- so a scan
    // that includes the open row can pick a worst out of a stale total and
    // read its breakdown out of a row being refilled live. The console printed
    // `[frame] 269 ms, render 29.3ms` for twenty frames whose render never took
    // 29.3 ms, and the whole team read it as time stolen by the browser.
    //
    // **It only appears once the ring has wrapped**, which is why the first
    // version of this check passed against the broken code: before the wrap
    // `row` equals `filled` and is already outside the scan. So fill it.
    //
    // The assertion is the invariant that actually failed, not a frame count:
    // a breakdown must add up to the total it is breaking down.
    {
      const q = profiler();
      // The heavy frame goes in row 0, which is the row the wrap lands on.
      q.begin();
      q.at(FSEC.render);
      burn(4);
      q.stop();
      for (let i = 1; i < WINDOW; i++) {
        q.begin();
        q.at(FSEC.sim);
        // One honest peak inside the window, so the fixed path has a real frame
        // to report rather than passing on a window of zeroes.
        if (i === 5) burn(1);
        q.stop();
      }
      q.begin();
      q.at(FSEC.hud);
      const mid = q.report();
      const breakdown = mid.sections.reduce((a, sec) => a + sec.worstMs, 0);
      if (Math.abs(breakdown - mid.worstMs) > 1e-9) {
        failures.push(
          `Mid-frame, \`report\` called the worst frame ${mid.worstMs.toFixed(3)} ms and broke it down ` +
            `into ${breakdown.toFixed(3)} ms. The frame still being written is in the window, so its ` +
            `stale total picked a row whose sections have been zeroed -- one line, two frames, no warning.`,
        );
      }
      if (mid.frames !== WINDOW - 1) {
        failures.push(`Mid-frame, \`report\` folded ${mid.frames} frames; ${WINDOW - 1} have closed.`);
      }
      q.stop();
      // And once it closes it counts. Permanently dropping the newest frame
      // would be the opposite mistake and just as quiet.
      if (q.report().frames !== WINDOW) {
        failures.push(`After \`stop\`, the window holds ${q.report().frames} of ${WINDOW}; a closed frame was dropped.`);
      }
    }
  }

  // --- The ring forgets, and the worst frame is the worst frame.
  //
  // One deliberately expensive frame among cheap ones, then enough cheap frames
  // to push it out of the window. The first read must find the hitch *and*
  // attribute it to the section that caused it; the second must not see it at
  // all. A ring that failed to clear a row before reusing it would keep
  // reporting the hitch forever, which is the exact bug that would make a
  // profiler lie about a stutter that has already been fixed.
  {
    const p = profiler();
    const cheap = (): void => {
      p.begin();
      p.at(FSEC.sim);
      burn(0.2);
      p.stop();
    };
    for (let i = 0; i < 5; i++) cheap();
    p.begin();
    p.at(FSEC.plates);
    burn(4);
    p.stop();
    for (let i = 0; i < 5; i++) cheap();

    const hit = p.report();
    if (Math.abs(hit.worstMs - 4) > 1e-9) {
      failures.push(`A 4 ms frame among 0.2 ms frames reported a worst of ${hit.worstMs.toFixed(3)} ms; the ring is not keeping per-frame rows.`);
    }
    const plates = hit.sections.find((s) => s.name === 'plates');
    if (!plates || Math.abs(plates.worstMs - 4) > 1e-9) {
      failures.push(
        `The worst frame's breakdown charged plates ${(plates?.worstMs ?? -1).toFixed(3)} ms; ` +
          `the worst-frame column is not that frame's own row.`,
      );
    }
    // Eleven frames: ten at 0.2 and one at 4, which is 6.0 over 11.
    if (Math.abs(hit.meanMs - 6 / 11) > 1e-9) {
      failures.push(`Eleven frames, one of them 4 ms, reported a mean of ${hit.meanMs.toFixed(3)} ms; the mean is not dividing by the window.`);
    }

    // Push the hitch out of the window entirely. `WINDOW` cheap frames is
    // guaranteed to wrap past it whatever the ring's current cursor.
    for (let i = 0; i < WINDOW; i++) cheap();
    const after = p.report();
    if (after.frames !== WINDOW) {
      failures.push(`After ${WINDOW + 11} frames the window holds ${after.frames}; the ring is not capping at ${WINDOW}.`);
    }
    if (Math.abs(after.worstMs - 0.2) > 1e-9) {
      failures.push(
        `A hitch pushed ${WINDOW} frames into the past still reports as the worst frame (${after.worstMs.toFixed(3)} ms). ` +
          `The ring is not being cleared before a row is reused, so the report can never show a fix.`,
      );
    }
    const stalePlates = after.sections.find((s) => s.name === 'plates');
    if (stalePlates && stalePlates.meanMs !== 0) {
      failures.push(`A section idle for ${WINDOW} frames still reports ${stalePlates.meanMs.toFixed(3)} ms/frame; rows are accumulating across wraps.`);
    }
    if (!after.sections.some((s) => s.name === 'plates')) {
      failures.push('The report omits idle sections; its shape changes under load, which makes two readings incomparable.');
    }
  }

  // --- The overhead claim is a measurement, not a hope.
  //
  // The brief's threshold: 30 us a frame. Twenty-one boundaries at any clock this
  // project will run on is a fiftieth of that, so a failure here means either the
  // clock is pathological or somebody has put a mark inside a loop.
  {
    const p = new FrameProfile();
    p.begin();
    for (let i = 0; i < FRAME_SECTION_COUNT; i++) p.at(i);
    p.stop();
    const perFrame = p.overheadUs();
    if (perFrame > 30) {
      failures.push(
        `A full sweep of ${FRAME_SECTION_COUNT} sections costs ${perFrame.toFixed(1)} us at this machine's ` +
          `${(CLOCK_MS * 1e6).toFixed(0)} ns clock, over the 30 us the profiler is allowed. Cut sections.`,
      );
    }
  }

  // --- The clock is usable at all.
  //
  // Not a property of this file, but the one fact that decides whether anything
  // it reports means anything. A 100 us grain -- Chrome without cross-origin
  // isolation -- makes a 60 us section read as 0 or 100 with nothing in between,
  // which the window's mean recovers and a single frame's breakdown does not.
  // Reported rather than failed: it is the player's browser, not a defect.
  if (CLOCK_GRAIN_MS > 0.2) {
    console.debug(
      `[frame] performance.now() is quantised to ${(CLOCK_GRAIN_MS * 1000).toFixed(0)} us here; ` +
        `per-frame section numbers are grainy and only the window mean is trustworthy.`,
    );
  }

  return failures;
}
