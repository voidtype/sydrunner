/**
 * Where the tick went, section by section, permanently and for nothing.
 *
 * ---------------------------------------------------------------------------
 * ## Why this file exists
 *
 * `Simulation.phaseMs` already measured ten phases, and it was enough to write
 * PERFORMANCE.md phase 1's capacity curve with -- 0.20 ms p50 at sixteen
 * players. A year and a dozen merges later the same host was spending 3.30 ms a
 * tick on **one** player, and nothing anywhere said so. The ten phases were
 * still being reported; they had simply grown coarse. "powerups 0.48 ms" is a
 * bucket that by then contained the pickups, the cash bundles, the fares and
 * the sizzle tents, and "npc 0.34 ms" contained seven separate ambient systems
 * that had been added one at a time, each of them cheap on its own, each of
 * them invisible inside somebody else's label.
 *
 * So the regression was not that nobody was measuring. It was that the
 * measurement had no *resolution* and no *place to be seen*. This file fixes
 * both: thirty named sections instead of ten, and a breakdown of the top six
 * printed on the ten-second stats line the operator is already reading.
 *
 * ---------------------------------------------------------------------------
 * ## The cursor, and why there are no begin/end pairs
 *
 * The obvious shape is `const t = now(); ...; acc.x += now() - t`, which is what
 * `phaseMs` did. It costs **two** clock reads per section and it silently loses
 * every line that falls between one pair and the next -- which at ten sections
 * was a third of the tick and was reported as nothing at all.
 *
 * This is a cursor instead. `at(SEC.foo)` closes whatever section was open,
 * charges it the elapsed time, and opens `foo`. One clock read per boundary,
 * and the sections *tile* the tick rather than sampling it: between `at` of the
 * first section and `stop()` at the end, every nanosecond is charged to
 * somebody. What is left over -- the host's pump, the socket reads, the
 * timers -- shows up as `rest` in the report, computed by subtraction from the
 * host tick, which is the honest place for it.
 *
 * The cost of that is a strict discipline: a section is not a scope, so a
 * function that marks a section must mark its caller's section back on the way
 * out. `Simulation.resolveStrike` is the one place that nests (`melee` inside
 * `advance`) and it does exactly that. Everything else is a flat sequence.
 *
 * ---------------------------------------------------------------------------
 * ## Always on
 *
 * Thirty boundaries a tick at 31 ns per `performance.now()` -- measured on the
 * dev box by `CLOCK_NS` below, and re-measured at boot on whatever the host
 * turns out to be -- is **0.9 us against a 16,667 us budget**, 0.006%. A
 * profile you have to remember to switch on is a profile that is not running
 * the day something regresses, which is the entire history of this file's
 * existence. So it is not behind a flag, not behind an env var, and not
 * sampled: it runs on every tick of every room forever.
 *
 * `overheadMs()` reports what it actually cost, so the claim above is a
 * measurement in the log rather than a comment.
 *
 * ---------------------------------------------------------------------------
 * ## Per room, not per process
 *
 * A `TickProfile` belongs to a `Simulation`, and its room borrows it for the
 * send path -- so the cursor is shared down the whole of one room's tick and
 * the sections tile it end to end. The host sums across rooms, which is what
 * `/stats` already did with `phaseMs` and is the right total: the budget is one
 * 16.67 ms tick for all the rooms together, not each.
 *
 * A `Simulation` built by a check driver with no `Room` around it still has
 * one, still fills it, and nothing reads it. That is what makes
 * `server/tick-profile.ts` possible without a socket.
 */

/**
 * Every section of a tick, in the order a tick runs them.
 *
 * Integers rather than strings, because `at()` is called thirty times a tick
 * and a string key would be a hash lookup on the hot path for the benefit of
 * the report, which runs once every ten seconds and can afford the array
 * lookup instead.
 *
 * The names are what appears in the log line, so they are short and lower case
 * on `phaseMs`' established voice. The order here is the order of the tick,
 * which makes the full listing in `tick-profile` readable top to bottom as the
 * thing it is describing.
 */
export const SEC = {
  /** `Room.step`: taking one input frame per socket, before the simulation. */
  input: 0,
  /** Reaping participants who have gone, and the rebuild that follows. */
  departures: 1,
  /** `buildRewindIndex` -- the melee's candidate grid, from the position ring. */
  rewind: 2,
  /** Every bot's `think`, from the state at the top of the tick. */
  bots: 3,
  /** `resolveMount` and `resolveAbilities`, before anybody has moved. */
  mount: 4,
  /** The integrator: `combat.advance` for every participant. */
  advance: 5,
  /** `resolveStrike`, nested inside `advance` and charged separately. */
  melee: 6,
  /** `buildLiveIndex` -- where everybody finished. */
  liveidx: 7,
  /** `buildTeamIndex` -- the aura index, off the same positions. */
  teamidx: 8,
  /** Bats against balls in the air, before the balls are stepped. */
  swat: 9,
  /** `FootyField.step` plus the pedestrian and officer sweeps behind it. */
  balls: 10,
  /** The ambient fleet running players over. */
  traffic: 11,
  /** `tickPowerups`. */
  powerups: 12,
  /** `tickBundles` -- money on the pavement. */
  bundles: 13,
  /** `stepFares` -- SydRide. */
  fares: 14,
  /** `stepTents` -- the sizzle tents. */
  tents: 15,
  /** The rider sweep and `BikeField.follow`. */
  bikes: 16,
  /** `stepRideBy` -- a tuned e-bike past the police. */
  rideby: 17,
  /** `stepCars` -- the driven fleet, its crashes and its blocker roster. */
  cars: 18,
  /** `FactionField.step` -- every dispatched actor's `think`. */
  factions: 19,
  /** `stepStreetlife` -- the ambient promotion scan. */
  streetlife: 20,
  /** `stepWildlife`. */
  wildlife: 21,
  /** `stepHeat` and the Polair it dispatches. */
  heat: 22,
  /** `sweepEvents` and `stepEvents` -- the standoff and the burnout. */
  events: 23,
  /** `stepCharacters` -- the eshay, the Karen, the tradie, the influencer. */
  characters: 24,
  /** The position ring, recorded at the end of the tick. */
  history: 25,
  /** `Room`'s reliable frames: roster, investigations, heat, bikes, cars, wallets, fares. */
  send: 26,
  /** Interest management: who each client can see. */
  aoi: 27,
  /** Snapshot encoding. */
  encode: 28,
  /** Handing the encoded frames to the sockets. */
  broadcast: 29,
} as const;

/** Parallel to `SEC`; index by the constant to get the label. */
export const SECTION_NAMES: readonly string[] = [
  'input', 'departures', 'rewind', 'bots', 'mount', 'advance', 'melee',
  'liveidx', 'teamidx', 'swat', 'balls', 'traffic', 'powerups', 'bundles',
  'fares', 'tents', 'bikes', 'rideby', 'cars', 'factions', 'streetlife',
  'wildlife', 'heat', 'events', 'characters', 'history', 'send', 'aoi',
  'encode', 'broadcast',
];

export const SECTION_COUNT = SECTION_NAMES.length;

/**
 * What one `performance.now()` costs on this machine, in milliseconds.
 *
 * Measured once at module load rather than quoted, because the whole point of
 * `overheadMs` is to be able to say "the profiler cost 0.9 us of the 800 it
 * measured" on the box as well as on the dev machine -- and the box is a shared
 * vCPU where a clock read is not the same 31 ns it is on an M-series Mac.
 *
 * A hundred thousand reads is about 3 ms of boot, which is nothing beside the
 * six seconds the world takes, and it is enough that the loop's own overhead is
 * in the noise. The subtraction of the empty loop is deliberately *not* done:
 * an empty loop optimises to nothing and subtracting nothing from something is
 * the same something, but a JIT that sank the `now()` call would show up as an
 * absurdly small number rather than as a silently wrong one -- so the sum is
 * kept and consumed, which is what stops the sink.
 */
function measureClock(): number {
  const N = 100_000;
  let sink = 0;
  for (let i = 0; i < 5_000; i++) sink += performance.now();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) sink += performance.now();
  const t1 = performance.now();
  // Consume the sink so nothing can be eliminated. Never true in practice.
  if (sink === -1) throw new Error('unreachable');
  return (t1 - t0) / N;
}

export const CLOCK_MS = measureClock();

/**
 * One room's tick, sectioned.
 *
 * **The accumulators are monotonic and are never cleared.** That is the one
 * structural decision in this class and it is taken from a bug this codebase
 * has already paid for once: `Room.logBytes` exists as a second counter beside
 * `bytesSent` because two readers sharing one resettable counter meant a
 * console line landing between two `/stats` polls stole that window's bytes,
 * and the harness reported a downlink alternating between 47 and 186 kbit/s.
 *
 * There are three readers here -- `/stats`, the ten-second log line, and
 * `server/tick-profile.ts` -- and duplicating the accumulator three times would
 * be three times the hot-path work for the same wrong shape. So the profile
 * counts forever and each reader owns a `ProfileReader` that remembers what it
 * last saw and subtracts. Readers cannot steal from each other because there is
 * nothing to take.
 */
export class TickProfile {
  /** Milliseconds charged to each section since the process began. */
  readonly acc = new Float64Array(SECTION_COUNT);
  /** Boundaries crossed since the process began, for `overheadMs`. */
  marks = 0;
  /** Ticks begun since the process began, so a reader can divide. */
  ticks = 0;
  /** The section currently accumulating, or -1 between ticks. */
  private cursor = -1;
  /** The clock at the last boundary. */
  private last = 0;

  /**
   * Close the open section and open `sec`.
   *
   * The one hot-path function in this file: an array read, a subtract, an array
   * write and a clock read. No allocation, no strings, no map.
   */
  at(sec: number): void {
    const now = performance.now();
    if (this.cursor >= 0) this.acc[this.cursor] += now - this.last;
    this.cursor = sec;
    this.last = now;
    this.marks++;
  }

  /**
   * Close the open section and charge nothing further until the next `at`.
   *
   * Called at the bottom of `Room.step`. A profile that was never stopped would
   * charge the *gap between ticks* -- 15 ms of the host sitting in `setTimeout`
   * -- to whichever section happened to be open last, which is a report saying
   * broadcast costs 15 ms.
   */
  stop(): void {
    if (this.cursor < 0) return;
    this.acc[this.cursor] += performance.now() - this.last;
    this.cursor = -1;
    this.marks++;
  }

  /** One more tick has been sectioned. Called by `Room.step` and by the driver. */
  countTick(): void {
    this.ticks++;
  }

  /**
   * What the profiler itself cost over the window, in milliseconds.
   *
   * Boundaries times the measured clock cost. It is an estimate and it is
   * deliberately the *pessimistic* one: it counts the clock read and ignores
   * the fact that a section boundary would have needed some of that work
   * anyway. If this number is ever a meaningful fraction of the tick, the
   * answer is fewer sections, and the number is here so that is a decision
   * somebody makes rather than a thing somebody suspects.
   */
  overheadMs(): number {
    return this.marks * CLOCK_MS;
  }

  /** Milliseconds charged to one section since the process began. */
  totalOf(sec: number): number {
    return this.acc[sec];
  }

  /** Every section's milliseconds, summed, since the process began. */
  total(): number {
    let sum = 0;
    for (let i = 0; i < SECTION_COUNT; i++) sum += this.acc[i];
    return sum;
  }
}

/**
 * One reader's view of one profile: what has happened since *this* reader last
 * looked at *that* profile.
 *
 * **One reader per (consumer, profile) pair**, and the pairing is not
 * negotiable: the subtraction is against a remembered copy of one profile's
 * accumulators, so pointing a reader at a second profile would report the
 * *difference between two rooms* rather than the second room's window. A host
 * with three rooms and two consumers has six readers, and they live where they
 * belong -- `Room.logProfile` and `Room.statsProfile`. `take` is additive into
 * the caller's record so the six still fold into two totals.
 */
export class ProfileReader {
  private readonly prev = new Float64Array(SECTION_COUNT);
  private prevMarks = 0;
  private prevTicks = 0;

  /** Ticks in the window this reader last took. */
  lastTicks = 0;
  /** What the profiler itself cost over the window this reader last took, ms. */
  lastOverheadMs = 0;

  /**
   * Fold the delta since the last `take` into `into` as `{ name: msPerTick }`.
   *
   * Additive, so a host with several rooms calls it once per room and gets the
   * sum -- which is what a host tick actually costs and is what `/stats` has
   * always reported. Zero sections are still written, because a section that
   * vanished from the report because it happened to be idle would be a report
   * whose shape changes under load.
   */
  take(p: TickProfile, into: Record<string, number> = {}): Record<string, number> {
    const ticks = p.ticks - this.prevTicks;
    const d = ticks > 0 ? ticks : 1;
    for (let i = 0; i < SECTION_COUNT; i++) {
      const delta = p.acc[i] - this.prev[i];
      this.prev[i] = p.acc[i];
      into[SECTION_NAMES[i]] = (into[SECTION_NAMES[i]] ?? 0) + delta / d;
    }
    this.lastTicks = ticks;
    this.lastOverheadMs = (p.marks - this.prevMarks) * CLOCK_MS;
    this.prevMarks = p.marks;
    this.prevTicks = p.ticks;
    return into;
  }
}

/**
 * The top `n` sections of a folded report, as `lanes 1.10, teams 0.62, ...`.
 *
 * Shared by the ten-second log line and by `tick-profile`, so the operator sees
 * one format in two places. Milliseconds with two decimals rather than
 * microseconds, because the number beside it on that line -- the host tick --
 * is in milliseconds and a line that mixes units is a line that gets misread.
 *
 * `rest` is passed in rather than derived here: only the caller knows what the
 * whole tick cost, and the difference between that and the sum of the sections
 * is the pump, the timers and the socket reads, which are real and are nobody's
 * section.
 */
export function topSections(phases: Record<string, number>, n: number, rest: number): string {
  const rows = Object.entries(phases).filter(([, v]) => v > 0);
  rows.sort((a, b) => b[1] - a[1]);
  const parts = rows.slice(0, n).map(([k, v]) => `${k} ${v.toFixed(2)}`);
  if (rest > 0.005) parts.push(`rest ${rest.toFixed(2)}`);
  return parts.join(', ');
}

// --- The self-check -------------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 * Every failure below is silent in this project's sense: the server boots, the
 * game plays, and the *report* is wrong -- which is the one failure mode that
 * matters for a file whose entire job is to be believed. A profiler that
 * under-reports is worse than no profiler, because the next person to look at a
 * slow tick will believe it and go and optimise something else.
 *
 *   - **Sections that do not tile.** If `at` charged the new section instead of
 *     the old one, or if the cursor were not carried across, the accumulated
 *     total would not equal the wall time between the first mark and `stop`.
 *     That is the property the whole cursor design exists for and it is checked
 *     against a real elapsed interval rather than against itself.
 *   - **A label that drifted from its constant.** `SEC` and `SECTION_NAMES` are
 *     two lists that have to stay parallel, and nothing in the type system says
 *     so. A swap there mislabels a section forever and reads as one system
 *     mysteriously becoming another system's cost.
 *   - **A profile that keeps charging between ticks.** `stop` not clearing the
 *     cursor puts the 15 ms the host spends asleep onto the last section.
 *   - **A reset that does not reset.** Two readers share this object; a window
 *     that carried over would make every reading after the first cumulative and
 *     the log line would grow without bound.
 */
export function verifyProfile(): string[] {
  const failures: string[] = [];

  // --- The two lists are parallel, and every constant is in range.
  const seen = new Set<number>();
  for (const [name, idx] of Object.entries(SEC)) {
    if (idx < 0 || idx >= SECTION_COUNT) {
      failures.push(`SEC.${name} is ${idx}, outside the ${SECTION_COUNT} names. The report would index undefined.`);
      continue;
    }
    if (SECTION_NAMES[idx] !== name) {
      failures.push(`SEC.${name} is ${idx}, which SECTION_NAMES calls "${SECTION_NAMES[idx]}". The report is mislabelled.`);
    }
    if (seen.has(idx)) failures.push(`Two sections share index ${idx}; one of them can never be reported.`);
    seen.add(idx);
  }
  if (seen.size !== SECTION_COUNT) {
    failures.push(`${seen.size} constants for ${SECTION_COUNT} names; a section has no way to be marked.`);
  }

  // --- The sections tile the interval they cover.
  //
  // Busy-work rather than a sleep, because `performance.now()` is the thing
  // being tested and a timer would be testing the event loop. Three sections
  // over a measurable interval; the sum must be the interval, to the resolution
  // of the clock plus the four extra reads the check itself makes.
  {
    const p = new TickProfile();
    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    const began = performance.now();
    p.at(SEC.advance);
    spin(2);
    p.at(SEC.powerups);
    spin(2);
    p.at(SEC.send);
    spin(2);
    p.stop();
    const wall = performance.now() - began;
    const sum = p.total();
    if (Math.abs(sum - wall) > 0.2) {
      failures.push(
        `Three sections over ${wall.toFixed(3)} ms of wall clock accumulated ${sum.toFixed(3)} ms. ` +
          `The sections do not tile the tick, so the breakdown does not add up to the tick it is breaking down.`,
      );
    }
    if (p.totalOf(SEC.advance) < 1 || p.totalOf(SEC.powerups) < 1 || p.totalOf(SEC.send) < 1) {
      failures.push(
        `A 2 ms section was charged advance=${p.totalOf(SEC.advance).toFixed(3)}, ` +
          `powerups=${p.totalOf(SEC.powerups).toFixed(3)}, send=${p.totalOf(SEC.send).toFixed(3)}. ` +
          `\`at\` is charging the section it opens rather than the one it closes.`,
      );
    }
    if (p.totalOf(SEC.melee) !== 0) failures.push('A section nobody marked was charged time.');

    // --- Nothing accrues between ticks.
    const parked = p.total();
    spin(3);
    if (p.total() !== parked) failures.push('`stop` left the cursor open; the gap between ticks is being charged to a section.');

    // --- And a reader sees each window exactly once.
    //
    // Two takes with a section in between: the first must carry the whole of
    // what has happened so far and the second must carry only the new part.
    // A reader that did not subtract would report every window as cumulative
    // and the log line would grow without bound.
    const r = new ProfileReader();
    const first = r.take(p);
    if (!(first.advance > 0)) failures.push('The first take saw nothing; a reader with no history must report everything.');
    p.at(SEC.bikes);
    spin(2);
    p.stop();
    const second = r.take(p);
    if (second.advance !== 0) {
      failures.push(`A second take re-reported ${second.advance.toFixed(3)} ms of advance; the reader is not subtracting.`);
    }
    if (!(second.bikes > 1)) failures.push('A second take missed a section marked after the first; the reader is stuck.');
    if (r.lastTicks !== 0) failures.push(`A window with no countTick reported ${r.lastTicks} ticks.`);
  }

  // --- The overhead claim is a measurement, not a hope.
  //
  // The threshold is the brief's: 20 us a tick. Thirty boundaries at any clock
  // this project will ever run on is a fiftieth of that, so a failure here means
  // either the clock is pathological (a VM with a syscall per read) or somebody
  // has put a mark inside a loop.
  {
    const p = new TickProfile();
    for (let i = 0; i < SECTION_COUNT; i++) p.at(i);
    p.stop();
    const perTick = p.overheadMs() * 1000;
    if (perTick > 20) {
      failures.push(
        `A full sweep of ${SECTION_COUNT} sections costs ${perTick.toFixed(1)} us at this machine's ` +
          `${(CLOCK_MS * 1e6).toFixed(0)} ns clock, over the 20 us the profiler is allowed. Cut sections.`,
      );
    }
  }

  // --- `take` is additive across rooms and divides by the tick count.
  //
  // Two profiles standing in for two rooms, folded into one record by one
  // reader: the host's breakdown is the *sum*, because the budget is one
  // 16.67 ms tick for every room together and not one each.
  {
    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    const a = new TickProfile();
    const b = new TickProfile();
    for (const p of [a, b]) {
      p.countTick();
      p.countTick();
      p.at(SEC.advance);
      spin(2);
      p.stop();
    }
    // A reader each, which is the contract: see `ProfileReader`'s header for
    // why one reader over two profiles reports the difference between them.
    const both: Record<string, number> = {};
    new ProfileReader().take(a, both);
    new ProfileReader().take(b, both);
    const solo = new ProfileReader().take(a);
    if (Math.abs(both.advance - solo.advance * 2) > 0.3) {
      failures.push(
        `Two rooms of ${solo.advance.toFixed(3)} ms folded to ${both.advance.toFixed(3)}; ` +
          `take is not additive and a multi-room host would report one room's tick as the whole.`,
      );
    }
    if (!(solo.advance > 0.8 && solo.advance < 1.2)) {
      failures.push(`2 ms over 2 ticks reported ${solo.advance.toFixed(3)} ms/tick; take is not dividing by the tick count.`);
    }
    if (!('melee' in both)) failures.push('take omits idle sections; the report changes shape under load.');
  }

  return failures;
}
