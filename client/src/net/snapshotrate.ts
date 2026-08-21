/**
 * How often the server sends a snapshot, as a knob rather than as a constant --
 * and, more usefully, as the arithmetic that says what lowering it costs.
 *
 * WORKSTREAM AD. PERFORMANCE.md phase 4 names two levers on per-player egress
 * and this is the second one: *"the ball section"* and *"the snapshot rate"*.
 * The first is a strict win and was taken (`AOI_MAX_BALLS`). This one is not a
 * win, it is a **trade**, and a trade that is guessed at is a trade that gets
 * taken for the wrong reason -- so what this module exists to do is make the
 * cost computable before anybody turns the knob, and make the knob itself
 * exist so a measurement can be taken at all.
 *
 * `protocol.SNAPSHOT_HZ` stays 20 and stays the default. Nothing here changes
 * what a player sees unless an operator sets `SYDNEY_SNAPSHOT_HZ`, and the
 * recommendation from the measurement (see the workstream report) is **do not
 * set it**.
 *
 * ---------------------------------------------------------------------------
 * ## Why this is a pure module in `client/src/net` and not three lines of
 * `process.env` in `server/room.ts`
 *
 * Two reasons, and the first is the repository rule (`CLAUDE.md`: a `verifyX`
 * runs in *both* boot lists). A resolver that read the environment could only
 * be checked on the server, and the thing worth checking is not the `getenv` --
 * it is the arithmetic underneath, which is a statement about the *client's*
 * interpolation buffer and belongs where the client can assert it too.
 *
 * The second is that the interesting quantity lives on this side. What decides
 * whether a rate is usable is `INTERP_DELAY_MS` against the snapshot interval,
 * and that comparison is `net/client.ts`'s business. So: the pure functions and
 * the self-check are here, and `server/index.ts` reads one environment variable
 * and hands the number in.
 *
 * ---------------------------------------------------------------------------
 * ## The arithmetic, which is what makes 15 Hz answerable without a screenshot
 *
 * `net/client.ts` draws remotes at `now - INTERP_DELAY_MS` -- 100 ms in the
 * past -- and interpolates between the two snapshots that straddle that
 * instant. The buffer works when the *newer* of those two has already arrived,
 * and fails (extrapolates, which reads as remote players sliding and snapping)
 * when it has not. So the margin is
 *
 *     coverage = INTERP_DELAY_MS - interval - jitter
 *
 * and the only term the rate changes is the interval:
 *
 *     20 Hz -> 50.0 ms interval -> **50.0 ms** of margin
 *     15 Hz -> 66.7 ms interval -> **33.3 ms** of margin
 *     12 Hz -> 83.3 ms interval -> **16.7 ms** of margin
 *     10 Hz -> 100.0 ms interval -> **0 ms** -- the buffer is exactly one
 *              interval and any jitter at all extrapolates
 *
 * The jitter to hold that against is measured rather than guessed:
 * PERFORMANCE.md phase 4 reports a client-observed snapshot interval of 50.00 ms
 * p50 with a **52.7-54.6 ms p99** on loopback, so the server's own contribution
 * is 2.7-4.6 ms. A real network adds its own, and the number that has to fit is
 * the *worst* one a player will see rather than the median: an ordinary
 * residential connection's jitter runs to 20-30 ms.
 *
 * That is the finding, and it is arithmetic rather than an opinion. **15 Hz
 * leaves 33 ms of margin against 25-35 ms of real-world jitter plus 5 ms of
 * server-side spread.** It does not fail on a LAN and it does not fail on the
 * loadtest -- both of which is exactly why it would ship -- and it lands inside
 * the noise on a domestic connection, where the symptom is not "stepping" but
 * an occasional 60 ms extrapolated slide on a remote player, at the moment they
 * change direction, for the players with the worst connections. To buy 25% of a
 * downlink that the record narrowing has already cut by more than that.
 *
 * `INTERP_DELAY_MS` could of course be raised to 133 ms to restore the margin,
 * and that is the honest version of the proposal: it costs every player 33 ms
 * of additional apparent latency on everybody else's position, in a melee game
 * where the whole point is hitting people. That is a worse trade than the
 * bandwidth is worth, which is why the recommendation is 20 Hz.
 *
 * ---------------------------------------------------------------------------
 * ## What else a lower rate touches, which is not obvious
 *
 * **`factions.FIRE_STATE_TICKS` is 3, and it is a simulation window measured in
 * ticks that has to survive being *sampled* at the snapshot rate.** At 20 Hz
 * the interval is 3 ticks and every FIRE state lands in exactly one snapshot.
 * At 15 Hz the interval is 4, so a 3-tick window can fall entirely between two
 * snapshots and the muzzle flash for that shot is never sent -- about a quarter
 * of police shots would fire silently, with the damage still applied. That
 * module's own header anticipated this ("*if snapshots ever went to 30 Hz, what
 * this should become is a question about this module*") and `verifyPolice`
 * asserts the relationship against the interval it is handed.
 *
 * `describeRate` below returns that hazard as text rather than as a failure, so
 * a host started at 15 Hz boots and says what it has given up. Refusing to boot
 * would make the rate unmeasurable, which is the one thing this module is for.
 */

import { INTERP_DELAY_MS, SNAPSHOT_HZ, TICK_HZ } from './protocol.ts';

/**
 * The rates a snapshot interval can be, which is exactly the divisors of the
 * tick rate that are worth having.
 *
 * A rate that does not divide `TICK_HZ` is not a rate -- it is a pattern of
 * long and short intervals, and the client's buffer would have to be sized
 * against the long one while paying for the short one. 60/N for N in 3..6 is
 * 20, 15, 12 and 10; anything under 10 is below `INTERP_DELAY_MS` and cannot
 * work at all without moving that number too.
 */
export const SNAPSHOT_RATES: readonly number[] = [20, 15, 12, 10];

/** What one rate costs and what it breaks. `interval` is in 60 Hz ticks. */
export interface RateFacts {
  hz: number;
  /** Ticks between snapshots. `TICK_HZ / hz`, and an integer by construction. */
  interval: number;
  /** Milliseconds between snapshots. */
  intervalMs: number;
  /**
   * Milliseconds of jitter the 100 ms interpolation buffer still absorbs at
   * this rate. Negative is a buffer that cannot cover one interval at all.
   */
  coverageMs: number;
  /** Per-client downlink as a fraction of the 20 Hz default. */
  bandwidthRatio: number;
  /** Everything a rate below the default gives up, in words. Empty at 20 Hz. */
  caveats: readonly string[];
}

/**
 * Resolve a requested rate to the nearest legal one, or to the default.
 *
 * **Clamps rather than throws**, and the reason is the one `quantiseVelocity`
 * gives about wrapping: a host that refused to start on a typo in an
 * environment variable is a host that is down, and a host that silently ran at
 * 7 Hz would be a game nobody could play with no line in the log about it. So
 * an unusable value falls back to the default and `describeRate` says so.
 */
export function resolveSnapshotHz(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return SNAPSHOT_HZ;
  const n = Math.round(requested);
  return SNAPSHOT_RATES.includes(n) ? n : SNAPSHOT_HZ;
}

/** Everything worth knowing about a rate, derived rather than tabulated. */
export function rateFacts(hz: number): RateFacts {
  const interval = TICK_HZ / hz;
  const intervalMs = 1000 / hz;
  const caveats: string[] = [];
  if (hz < SNAPSHOT_HZ) {
    caveats.push(
      `the interpolation buffer's jitter margin falls from ${(INTERP_DELAY_MS - 1000 / SNAPSHOT_HZ).toFixed(1)} ms ` +
        `to ${(INTERP_DELAY_MS - intervalMs).toFixed(1)} ms; a client whose network jitter exceeds that ` +
        `extrapolates remote players instead of interpolating them`,
    );
    // The police window, which is the one concrete thing in the simulation that
    // is sampled at this rate. See the header, and `factions.FIRE_STATE_TICKS`.
    if (interval > 3) {
      caveats.push(
        `a ${interval}-tick snapshot interval is longer than factions.FIRE_STATE_TICKS (3), so some ` +
          `police muzzle flashes fall between two snapshots and are never sent -- the shot still lands`,
      );
    }
  }
  return {
    hz,
    interval,
    intervalMs,
    coverageMs: INTERP_DELAY_MS - intervalMs,
    bandwidthRatio: hz / SNAPSHOT_HZ,
    caveats,
  };
}

/** One line for the boot log. Empty string at the default, so nothing is said. */
export function describeRate(requested: number | undefined, resolved: number): string {
  if (requested !== undefined && Number.isFinite(requested) && Math.round(requested) !== resolved) {
    return (
      `SYDNEY_SNAPSHOT_HZ=${requested} is not one of ${SNAPSHOT_RATES.join('/')}; running at ` +
      `${resolved} Hz. A rate must divide the ${TICK_HZ} Hz tick or the interval alternates.`
    );
  }
  if (resolved === SNAPSHOT_HZ) return '';
  const f = rateFacts(resolved);
  return (
    `snapshots at ${f.hz} Hz (${f.interval} ticks, ${f.intervalMs.toFixed(1)} ms), ` +
    `${(f.bandwidthRatio * 100).toFixed(0)}% of the default downlink. Giving up: ${f.caveats.join('; ')}.`
  );
}

/**
 * The self-check. Runs in both boot lists.
 *
 * What it catches is not a crash -- every failure here produces a game that
 * runs, which is this project's usual reason for a check to exist:
 *
 *   - **A rate that does not divide the tick** is a snapshot cadence that
 *     alternates between two intervals. The client's buffer is sized for the
 *     mean and stalls on the long one, so remote players stutter on a period
 *     nobody can find by looking at a profile.
 *   - **A rate whose interval exceeds `INTERP_DELAY_MS`** is a buffer that is
 *     always empty at render time. Every remote is extrapolated, always, which
 *     looks like a bad network rather than like a configuration.
 *   - **A resolver that accepted a bad value** is the same thing at whatever
 *     number was in the environment.
 *   - **A default that is not the protocol's** would mean the server and every
 *     `SNAPSHOT_HZ` arithmetic in `verifyNet` disagreed about the rate the
 *     bandwidth budget is computed at.
 */
export function verifySnapshotRate(): string[] {
  const failures: string[] = [];

  if (resolveSnapshotHz(undefined) !== SNAPSHOT_HZ) {
    failures.push(`With nothing configured the rate resolved to ${resolveSnapshotHz(undefined)}, not the protocol's ${SNAPSHOT_HZ}.`);
  }
  for (const bad of [0, -1, 7, 23, 61, NaN, 19.5]) {
    if (resolveSnapshotHz(bad) !== SNAPSHOT_HZ) {
      failures.push(`SYDNEY_SNAPSHOT_HZ=${bad} resolved to ${resolveSnapshotHz(bad)} rather than falling back to ${SNAPSHOT_HZ}.`);
    }
  }
  if (!SNAPSHOT_RATES.includes(SNAPSHOT_HZ)) {
    failures.push(`The protocol's default ${SNAPSHOT_HZ} Hz is not in the legal set ${SNAPSHOT_RATES.join('/')}.`);
  }

  for (const hz of SNAPSHOT_RATES) {
    if (resolveSnapshotHz(hz) !== hz) failures.push(`The legal rate ${hz} Hz did not resolve to itself.`);
    const f = rateFacts(hz);
    if (!Number.isInteger(f.interval)) {
      failures.push(
        `${hz} Hz is ${f.interval} ticks, which is not an integer. A cadence of alternating long and ` +
          `short intervals stutters every remote body on a period nothing profiles.`,
      );
    }
    if (f.intervalMs > INTERP_DELAY_MS) {
      failures.push(
        `${hz} Hz sends every ${f.intervalMs.toFixed(1)} ms against a ${INTERP_DELAY_MS} ms interpolation ` +
          `buffer. The buffer would be empty at render time on every frame.`,
      );
    }
    if (Math.abs(f.coverageMs - (INTERP_DELAY_MS - f.intervalMs)) > 1e-9) {
      failures.push(`${hz} Hz reported ${f.coverageMs} ms of coverage, which is not ${INTERP_DELAY_MS} minus its interval.`);
    }
    if (hz < SNAPSHOT_HZ && f.caveats.length === 0) {
      failures.push(`${hz} Hz is below the default and reported nothing given up. A trade with no stated cost is a trade nobody can refuse.`);
    }
    if (hz === SNAPSHOT_HZ && f.caveats.length !== 0) {
      failures.push(`The default rate reported ${f.caveats.length} caveats; the default costs nothing by definition.`);
    }
  }

  // The default says nothing in the boot log, and a lowered one says what it
  // cost. A silent downgrade is the failure this line exists for: the whole
  // hazard of a knob like this is that somebody sets it once, forgets, and
  // spends a month debugging remote-player stutter.
  if (describeRate(undefined, SNAPSHOT_HZ) !== '') {
    failures.push('The default rate printed a boot line; it must be silent when nothing has been configured.');
  }
  if (describeRate(15, 15) === '' || !describeRate(15, 15).includes('muzzle')) {
    failures.push('A 15 Hz host did not announce what it gave up, including the police muzzle flashes it drops.');
  }
  if (!describeRate(7, SNAPSHOT_HZ).includes('not one of')) {
    failures.push('An illegal SYDNEY_SNAPSHOT_HZ was silently ignored rather than reported.');
  }

  // And the 100 ms buffer covers the default with room, which is the property
  // the whole "20 Hz is the right answer" recommendation rests on.
  if (rateFacts(SNAPSHOT_HZ).coverageMs < 40) {
    failures.push(
      `At the default rate the interpolation buffer absorbs ${rateFacts(SNAPSHOT_HZ).coverageMs.toFixed(1)} ms ` +
        `of jitter. Under 40 there is no headroom for a domestic connection.`,
    );
  }

  return failures;
}
