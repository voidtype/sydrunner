/**
 * Every stall this session, what it cost, and -- the point of the file -- what
 * was happening on the same frame.
 *
 * ---------------------------------------------------------------------------
 * ## What this replaces
 *
 * A `console.warn` on frames over 66 ms, rate-limited to one every five
 * seconds. Two things were wrong with it and they compounded: 66 ms is four
 * times the budget, so a cluster of 25-40 ms frames -- which is what a player
 * calls a judder -- was invisible; and a five-second cooldown against a symptom
 * reported as "about every ten seconds" samples, at best, every other one, and
 * samples the *first* frame of a cluster rather than the worst.
 *
 * So: a ring, a 25 ms threshold, and no cooldown at all. A bad minute fills the
 * ring instead of filling the console, which is what the cooldown was protecting
 * against and is a better way to protect against it.
 *
 * ---------------------------------------------------------------------------
 * ## STOLEN TIME, AND WHY IT NEEDS A BASELINE
 *
 * `FrameProfile` tiles the animation-frame callback: every nanosecond between
 * `begin()` and `stop()` is charged to one of nineteen named sections. That is
 * exactly right for finding out which of our systems is slow, and it is
 * structurally incapable of reporting time we did not spend. A garbage
 * collection, a compositor stall, a driver hiccup, a texture upload -- each is
 * silently charged to whichever section happened to be open.
 *
 * The fix is a subtraction: the gap between consecutive animation-frame
 * timestamps, minus the sum of our own sections, is time nobody in our code
 * spent.
 *
 * **That number is never zero, and a reader who does not know that will not
 * trust it.** It contains the browser's own compositing, the previous frame's
 * GPU work, and the callback dispatch itself -- several milliseconds, every
 * frame, forever, on a machine that is behaving perfectly. Reported raw, the
 * first person to look at it concludes the browser is stealing 4 ms a frame and
 * stops reading.
 *
 * So the gap is observed on **every** frame and the ordinary band of it is
 * measured. `stolen` is the excess over the top of that band, and only the
 * excess means *something stopped us*.
 *
 * **The gate is the 95th percentile, not the 5th, and that was a correction.**
 * The first version took the 5th -- the cheapest frame in the window -- as the
 * floor, which is the right description of "what a frame costs when nothing goes
 * wrong" and the wrong thing to subtract: ninety-five per cent of *healthy*
 * frames then sit above it and report a few tenths of a millisecond of theft
 * each. `server/stall-check.ts` caught it in one line, and it is exactly the
 * failure the whole design was warned about -- a number that reads non-zero on
 * an idle machine is a number the first reader stops trusting.
 *
 * At the 95th, an ordinary frame reads **zero** and a 60 ms stall reads 60 less
 * the width of the ordinary band, which under-reports theft by a fraction of a
 * millisecond. Under-reporting is the right direction to be wrong in: this
 * number's job is to accuse the browser, and it should not do so on a hunch.
 *
 * A percentile rather than a maximum for the same reason it is not a minimum:
 * one unlucky frame must not set the gate for the session.
 *
 * ---------------------------------------------------------------------------
 * ## `summarise` IS THE DELIVERABLE
 *
 * The ring is not the point; the sentence is. What the investigation needs is
 * *"in the last minute there were seven stalls; five were time stolen outside
 * our sections averaging 38 ms; two were the render section with pipelines
 * compiling; six of the seven landed on a frame that crossed a tile boundary"*.
 *
 * That last clause is the whole of the distance-versus-timer question, and it is
 * why `StallRecord` carries `crossed`. A person can read the answer off one
 * drive instead of inferring it from a stopwatch.
 *
 * Pure, three-free, DOM-free: the classification and the arithmetic are what can
 * be wrong, so they are what `verifyStallRing` checks on both boot lists.
 */

/**
 * The floor under the stall threshold, milliseconds.
 *
 * **An absolute threshold was wrong and the first session proved it in seven
 * seconds.** 25 ms was chosen as "four fifths of a 30 Hz frame" on the
 * assumption that an ordinary frame is 16. On the owner's machine the *median*
 * frame is 29 ms, so every frame qualified, the ring filled in 7.2 seconds, and
 * an instrument built to find a ten-second period could not span ten seconds.
 *
 * So the threshold is relative to the machine and this is only its floor: on a
 * 120 Hz machine a 25 ms frame really is a stall, and no factor applied to a
 * median of 8 ms should say otherwise.
 */
export const STALL_FLOOR_MS = 25;

/**
 * How much worse than this machine's ordinary frame counts as a stall.
 *
 * Two. Not a taste decision: a frame that takes twice as long as its neighbours
 * is a dropped frame at any refresh rate, which is the thing a player perceives
 * as a hitch. At the owner's 29 ms median this asks for 58 ms, which would have
 * recorded the 535 ms freeze and ignored the ninety-five ordinary frames it was
 * buried in.
 */
export const STALL_FACTOR = 2;

/** How many stalls are kept. A bad minute is about sixty. */
export const STALL_CAPACITY = 96;

/** How many frames the ordinary band is measured over. Four seconds at 60 Hz. */
export const BASELINE_WINDOW = 240;

/**
 * The top of the ordinary band. Above this is theft; at or below it is Tuesday.
 *
 * Stalls are rare enough not to move it -- a player crossing a tile boundary at
 * 44 m/s stalls on one frame in 682 -- so the 95th percentile of *all* frames is
 * still the 95th percentile of the healthy ones.
 */
export const BASELINE_PERCENTILE = 0.95;

/** What a stall was, in one word. See `classify`. */
export type StallKind = 'stolen' | 'compile' | 'stream' | 'work';

export interface StallRecord {
  /** Wall clock, so two stalls can be spaced. */
  atMs: number;
  frameMs: number;
  /** Time outside our own sections, over the quiet floor. See the header. */
  stolenMs: number;
  /** Metres per second, so the speed-interval question answers itself. */
  speed: number;
  /** Fixed steps this frame ran. `game/framestep.ts`. */
  steps: number;
  /** Shader pipelines compiled on this frame. */
  compiles: number;
  /** Tiles built and ground sheets placed on this frame. */
  tiles: number;
  sheets: number;
  /** Distance boundaries crossed on this frame. `world/boundarylog.ts`. */
  crossed: string;
  /** The heaviest profiler section, `name ms`. */
  worst: string;
  /** The longest `longtask` entry that overlapped this frame, or 0. */
  longtaskMs: number;
}

export interface StallSummary {
  stalls: number;
  /** This machine's ordinary frame and its tail. A rate problem, not a stutter one. */
  medianFrameMs: number;
  p95FrameMs: number;
  worstFrameMs: number;
  /** Seconds between the first and last stall held. */
  spanS: number;
  /** Mean seconds between consecutive stalls, or -1 with fewer than two. */
  intervalS: number;
  worstMs: number;
  byKind: Record<StallKind, number>;
  /** Mean stolen milliseconds over the stalls classified `stolen`. */
  stolenMeanMs: number;
  /** The share of stalls that landed on a frame which crossed a boundary. */
  crossedShare: number;
  /** Mean player speed over the stalls, m/s. The distance-versus-timer tell. */
  meanSpeed: number;
  /** One sentence. What actually gets read. */
  line: string;
}

/**
 * What a stall was.
 *
 * Ordered, and the order is the argument. **Stolen time wins**, because if the
 * browser stopped us for 40 ms it does not matter what our sections were doing;
 * they were not running. Then compilation, because a pipeline compiled inside a
 * frame is a specific, fixable, known fault. Then streaming, because a tile that
 * arrived is a cause with a cure. What is left is our own code being slow, which
 * is the only one of the four the frame profiler was ever able to see.
 */
export function classify(rec: StallRecord): StallKind {
  if (rec.stolenMs >= rec.frameMs * 0.5) return 'stolen';
  if (rec.compiles > 0) return 'compile';
  if (rec.tiles > 0 || rec.sheets > 0) return 'stream';
  return 'work';
}

/** The p-th percentile of `values`, nearest-rank. Sorts a copy. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at];
}

export class StallRing {
  private readonly gaps: number[] = [];
  private gapAt = 0;
  /** Every frame's duration, so the threshold can be about *this* machine. */
  private readonly frames: number[] = [];
  private frameAt = 0;
  private worstFrameMs = 0;
  private readonly rows: StallRecord[] = [];
  private cursor = 0;
  private seen = 0;

  /**
   * Every frame, whatever happened: the raw gap between what the clock says the
   * frame took and what our sections say they spent.
   */
  observe(gapMs: number, frameMs = 0): void {
    if (!Number.isFinite(gapMs)) return;
    const v = gapMs > 0 ? gapMs : 0;
    if (this.gaps.length < BASELINE_WINDOW) this.gaps.push(v);
    else {
      this.gaps[this.gapAt] = v;
      this.gapAt = (this.gapAt + 1) % BASELINE_WINDOW;
    }
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;
    if (frameMs > this.worstFrameMs) this.worstFrameMs = frameMs;
    if (this.frames.length < BASELINE_WINDOW) this.frames.push(frameMs);
    else {
      this.frames[this.frameAt] = frameMs;
      this.frameAt = (this.frameAt + 1) % BASELINE_WINDOW;
    }
  }

  /** This machine's ordinary frame, milliseconds. The threshold is built on it. */
  medianFrameMs(): number {
    return percentile(this.frames, 0.5);
  }

  /**
   * Is this frame a stall *for this machine*?
   *
   * The floor and the factor together: see their notes. Before enough frames
   * have been seen to have a median, only the floor applies -- which is the
   * right behaviour for the first four seconds of a session, where a real stall
   * is worth catching and there is nothing to compare it to.
   */
  isStall(frameMs: number): boolean {
    const median = this.medianFrameMs();
    const relative = median > 0 ? median * STALL_FACTOR : 0;
    return frameMs >= Math.max(STALL_FLOOR_MS, relative);
  }

  /**
   * The top of the ordinary band: the most a healthy frame spends outside our
   * own sections. Anything past this is what `stolen` reports.
   */
  baseline(): number {
    return percentile(this.gaps, BASELINE_PERCENTILE);
  }

  /** How much of `gapMs` is worth calling a stall. Never negative. */
  stolen(gapMs: number): number {
    const over = gapMs - this.baseline();
    return over > 0 ? over : 0;
  }

  add(rec: StallRecord): void {
    if (this.rows.length < STALL_CAPACITY) this.rows.push(rec);
    else this.rows[this.cursor] = rec;
    this.cursor = (this.cursor + 1) % STALL_CAPACITY;
    this.seen++;
  }

  /** Every stall held, oldest first. */
  all(): StallRecord[] {
    if (this.rows.length < STALL_CAPACITY) return this.rows.slice();
    return [...this.rows.slice(this.cursor), ...this.rows.slice(0, this.cursor)];
  }

  /** How many stalls this session, including the ones the ring has dropped. */
  get total(): number {
    return this.seen;
  }

  summarise(): StallSummary {
    const rows = this.all();
    const byKind: Record<StallKind, number> = { stolen: 0, compile: 0, stream: 0, work: 0 };
    let worstMs = 0;
    let stolenSum = 0;
    let crossed = 0;
    let speedSum = 0;
    for (const r of rows) {
      const kind = classify(r);
      byKind[kind]++;
      if (r.frameMs > worstMs) worstMs = r.frameMs;
      if (kind === 'stolen') stolenSum += r.stolenMs;
      if (r.crossed !== '') crossed++;
      speedSum += r.speed;
    }
    const spanS = rows.length < 2 ? 0 : (rows[rows.length - 1].atMs - rows[0].atMs) / 1000;
    const intervalS = rows.length < 2 ? -1 : spanS / (rows.length - 1);
    const stolenMeanMs = byKind.stolen === 0 ? 0 : stolenSum / byKind.stolen;
    const crossedShare = rows.length === 0 ? 0 : crossed / rows.length;
    const meanSpeed = rows.length === 0 ? 0 : speedSum / rows.length;

    const parts: string[] = [];
    if (rows.length === 0) parts.push('no stalls recorded');
    else {
      parts.push(`${rows.length} stall(s) over ${spanS.toFixed(0)} s`);
      if (intervalS >= 0) parts.push(`one every ${intervalS.toFixed(1)} s`);
      parts.push(`worst ${worstMs.toFixed(0)} ms`);
      const kinds = (Object.keys(byKind) as StallKind[])
        .filter((k) => byKind[k] > 0)
        .map((k) => (k === 'stolen' ? `${byKind[k]} stolen (mean ${stolenMeanMs.toFixed(0)} ms)` : `${byKind[k]} ${k}`));
      parts.push(kinds.join(', '));
      // The clause the whole investigation turns on.
      parts.push(`${Math.round(crossedShare * 100)}% crossed a boundary`);
      parts.push(`mean speed ${meanSpeed.toFixed(1)} m/s`);
    }
    const medianFrameMs = this.medianFrameMs();
    // The frame picture goes first, because it is the thing that turned out to
    // matter and it is a different problem from the stalls: a machine holding
    // 34 fps has a rate problem, and no amount of stall-hunting fixes it.
    const fps = medianFrameMs > 0 ? 1000 / medianFrameMs : 0;
    parts.unshift(`frame ${medianFrameMs.toFixed(0)} ms median (${fps.toFixed(0)} fps)`);
    return {
      stalls: rows.length, medianFrameMs, p95FrameMs: percentile(this.frames, 0.95),
      // The worst of both, so the two numbers cannot disagree: a stall in the
      // ring is by definition a frame, and a summary reporting a worst frame
      // smaller than its own worst stall would be caught by a reader before it
      // was caught by a test.
      worstFrameMs: Math.max(this.worstFrameMs, worstMs),
      spanS, intervalS, worstMs, byKind,
      stolenMeanMs, crossedShare, meanSpeed, line: parts.join(' | '),
    };
  }

  /** The ring as a table, for a console handle. Newest last. */
  table(): string {
    const rows = this.all();
    if (rows.length === 0) return 'no stalls recorded';
    const head = ['at', 'ms', 'stolen', 'kind', 'm/s', 'stp', 'cmp', 'tile', 'sht', 'longt', 'crossed', 'worst'];
    const lines = [head.join('\t')];
    const first = rows[0].atMs;
    for (const r of rows) {
      lines.push([
        `${((r.atMs - first) / 1000).toFixed(1)}s`,
        r.frameMs.toFixed(0),
        r.stolenMs.toFixed(0),
        classify(r),
        r.speed.toFixed(0),
        String(r.steps),
        String(r.compiles),
        String(r.tiles),
        String(r.sheets),
        r.longtaskMs > 0 ? r.longtaskMs.toFixed(0) : '-',
        r.crossed === '' ? '-' : r.crossed,
        r.worst,
      ].join('\t'));
    }
    lines.push('');
    lines.push(this.summarise().line);
    return lines.join('\n');
  }
}

export function verifyStallRing(): string[] {
  const failures: string[] = [];
  const rec = (over: Partial<StallRecord> = {}): StallRecord => ({
    atMs: 0, frameMs: 40, stolenMs: 0, speed: 0, steps: 1,
    compiles: 0, tiles: 0, sheets: 0, crossed: '', worst: 'render 30.0',
    longtaskMs: 0, ...over,
  });

  // --- THE ONE THAT MATTERS. A constant overhead is not a stall, and the
  //     injection reports its own size and not the overhead's as well.
  {
    const ring = new StallRing();
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(4);
    const base = ring.baseline();
    if (Math.abs(base - 4) > 0.001) failures.push(`A constant 4 ms overhead gave a band top of ${base}.`);
    const stolen = ring.stolen(64);
    if (Math.abs(stolen - 60) > 0.001) {
      failures.push(`A 60 ms injection over a 4 ms band reported ${stolen} ms of stolen time, not 60.`);
    }
    if (ring.stolen(4) !== 0) failures.push('A perfectly ordinary frame reported stolen time.');
    if (ring.stolen(2) !== 0) failures.push('A frame below the band reported negative stolen time.');
  }

  // --- THE CORRECTION. A healthy machine jitters, and jitter is not theft.
  //     This is the assertion `server/stall-check.ts` convicted the 5th
  //     percentile with; it belongs here so the module carries its own proof.
  {
    const ring = new StallRing();
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(4 + (i % 7) * 0.1);
    for (let i = 0; i < BASELINE_WINDOW; i++) {
      const healthy = 4 + (i % 7) * 0.1;
      if (ring.stolen(healthy) !== 0) {
        failures.push(`An ordinary frame of ${healthy.toFixed(1)} ms reported ${ring.stolen(healthy)} ms stolen.`);
        break;
      }
    }
    const real = ring.stolen(4 + 60);
    if (real < 59 || real > 60.01) failures.push(`A 60 ms stall over a jittery band reported ${real}.`);
  }

  // --- One unlucky frame does not set the gate for the session.
  {
    const ring = new StallRing();
    ring.observe(400);
    for (let i = 0; i < BASELINE_WINDOW - 1; i++) ring.observe(5);
    const base = ring.baseline();
    if (base > 6) failures.push(`One 400 ms frame pushed the band top to ${base}; a maximum never recovers.`);
  }

  // --- ...and it moves with the machine rather than remembering one moment.
  {
    const ring = new StallRing();
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(2);
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(9);
    const base = ring.baseline();
    if (Math.abs(base - 9) > 0.001) failures.push(`After the machine got busier the band top stayed at ${base}.`);
  }

  // --- The four kinds, and the order they are decided in.
  {
    const cases: Array<[StallRecord, StallKind]> = [
      [rec({ frameMs: 40, stolenMs: 30, compiles: 5, tiles: 2 }), 'stolen'],
      [rec({ frameMs: 40, stolenMs: 2, compiles: 5, tiles: 2 }), 'compile'],
      [rec({ frameMs: 40, stolenMs: 2, compiles: 0, tiles: 2 }), 'stream'],
      [rec({ frameMs: 40, stolenMs: 2, compiles: 0, tiles: 0, sheets: 1 }), 'stream'],
      [rec({ frameMs: 40, stolenMs: 2, compiles: 0, tiles: 0 }), 'work'],
    ];
    for (const [r, want] of cases) {
      const got = classify(r);
      if (got !== want) failures.push(`A stall with stolen=${r.stolenMs} compiles=${r.compiles} tiles=${r.tiles} classified as "${got}", not "${want}".`);
    }
  }

  // --- The ring wraps and keeps the newest, oldest first.
  {
    const ring = new StallRing();
    for (let i = 0; i < STALL_CAPACITY + 20; i++) ring.add(rec({ atMs: i * 1000, frameMs: 30 + i }));
    const all = ring.all();
    if (all.length !== STALL_CAPACITY) failures.push(`The ring held ${all.length}, not ${STALL_CAPACITY}.`);
    if (all[0].atMs >= all[all.length - 1].atMs) failures.push('The ring came back newest first.');
    if (all[all.length - 1].atMs !== (STALL_CAPACITY + 19) * 1000) failures.push('The ring dropped the newest stall rather than the oldest.');
    if (ring.total !== STALL_CAPACITY + 20) failures.push(`The session total read ${ring.total}, not ${STALL_CAPACITY + 20}.`);
  }

  // --- The summary answers the question the investigation is actually asking.
  {
    const ring = new StallRing();
    for (let i = 0; i < 6; i++) ring.add(rec({ atMs: i * 10_000, speed: 44, crossed: i < 5 ? 'grid' : '', tiles: 1, stolenMs: 1 }));
    const s = ring.summarise();
    if (Math.abs(s.intervalS - 10) > 0.01) failures.push(`Six stalls ten seconds apart reported an interval of ${s.intervalS}.`);
    if (Math.abs(s.crossedShare - 5 / 6) > 0.001) failures.push(`The boundary share read ${s.crossedShare}, not 5/6.`);
    if (Math.abs(s.meanSpeed - 44) > 0.001) failures.push(`The mean speed read ${s.meanSpeed}.`);
    if (s.byKind.stream !== 6) failures.push(`Six streaming stalls classified as ${JSON.stringify(s.byKind)}.`);
    if (!s.line.includes('every 10.0 s')) failures.push(`The summary line does not name the interval: "${s.line}"`);
    if (!s.line.includes('83% crossed')) failures.push(`The summary line does not name the boundary share: "${s.line}"`);
  }

  /*
   * --- THE CORRECTION THE FIRST SESSION FORCED.
   *
   * A machine whose ordinary frame is 29 ms must not report every frame as a
   * stall. The first build used an absolute 25 ms and did exactly that: the ring
   * filled with ninety-five ordinary frames in 7.2 seconds, and the one real
   * freeze in the session -- 535 ms -- was buried in them.
   */
  {
    const ring = new StallRing();
    // A laptop holding about 34 fps, which is what the owner's session was.
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(4, 29 + (i % 5));
    if (ring.isStall(31)) failures.push('An ordinary frame on a 34 fps machine was recorded as a stall.');
    if (ring.isStall(57)) failures.push('A frame under twice the median was recorded as a stall.');
    if (!ring.isStall(535)) failures.push('A 535 ms freeze was not recorded as a stall.');
    const median = ring.medianFrameMs();
    if (Math.abs(median - 31) > 2) failures.push(`The median frame read ${median}, not about 31.`);
  }

  // --- ...and the floor still bites on a fast machine, where 25 ms really is a stall.
  {
    const ring = new StallRing();
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(1, 8);
    if (ring.isStall(15)) failures.push('A 15 ms frame on a 120 Hz machine was called a stall; twice 8 is 16.');
    if (!ring.isStall(25)) failures.push('A 25 ms frame on a 120 Hz machine was not a stall; the floor did not bite.');
  }

  // --- Before there is a median, the floor is the whole rule.
  {
    const ring = new StallRing();
    if (ring.isStall(24)) failures.push('A cold ring called a 24 ms frame a stall.');
    if (!ring.isStall(26)) failures.push('A cold ring missed a 26 ms frame; the floor must apply from the first frame.');
  }

  // --- The frame picture reaches the summary, because it is its own problem.
  {
    const ring = new StallRing();
    for (let i = 0; i < BASELINE_WINDOW; i++) ring.observe(4, 29);
    ring.add(rec({ atMs: 0, frameMs: 535, stolenMs: 504 }));
    const s = ring.summarise();
    if (Math.abs(s.medianFrameMs - 29) > 0.01) failures.push(`The summary's median frame read ${s.medianFrameMs}.`);
    if (s.worstFrameMs !== 535) failures.push(`The worst frame read ${s.worstFrameMs}, not 535.`);
    if (!s.line.includes('34 fps')) failures.push(`The summary does not lead with the frame rate: "${s.line}"`);
  }

  // --- An empty ring says so rather than dividing by zero.
  {
    const s = new StallRing().summarise();
    if (s.stalls !== 0 || s.intervalS !== -1 || !Number.isFinite(s.crossedShare)) {
      failures.push(`An empty ring summarised as ${JSON.stringify(s)}.`);
    }
    if (new StallRing().table() !== 'no stalls recorded') failures.push('An empty ring drew a table.');
  }

  // --- Rubbish does not poison the floor.
  {
    const ring = new StallRing();
    for (let i = 0; i < 10; i++) ring.observe(5);
    ring.observe(NaN);
    ring.observe(-3);
    if (!Number.isFinite(ring.baseline())) failures.push('A non-finite gap poisoned the baseline.');
  }

  return failures;
}
