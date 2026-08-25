/**
 * How much of a frame the streamer may spend building, given how the frame is
 * already going.
 *
 * ---------------------------------------------------------------------------
 * ## Why a function rather than the constant it replaces
 *
 * `BUILD_BUDGET_MS` is 2.5, and its own paragraph explains the number well:
 * *"chosen against the frame, not against the work... 2.5 ms is a sixth of the
 * frame and comfortably inside what is left"*. That reasoning is sound and it
 * has one silent premise -- **that there is a sixth of a frame left** -- which is
 * exactly the premise that fails on the machines the budget exists to protect.
 * A client holding 60 Hz can spare 2.5 ms and never notices. A client already
 * taking 34 ms a frame is the one that gets the flat 2.5 ms anyway, on top of a
 * frame that is already twice its budget, and it is the only client where those
 * milliseconds are felt.
 *
 * So the budget bends: full on a frame with room, tapering as the frame runs
 * long, and **never to nothing**.
 *
 * ## The floor is the important half
 *
 * A budget that reaches zero is a client that stops building the world. On a
 * weak machine -- the one this taper is for -- that is a permanently blank city
 * rather than an occasionally janky one, and the player cannot get out of it by
 * playing better: a blank world is cheap to draw, so the frames stay fast, so
 * the budget stays zero. `MIN_BUDGET_MS` is what stops that loop, and the taper
 * is deliberately gentle so a client at 30 Hz still gets more than half.
 *
 * ## It reads the last frame, not this one
 *
 * There is no way to know how long the current frame will take before spending
 * the budget in it, so this reads the interval since the streamer last ran --
 * which is one frame late and, on anything that is not a step change, is the
 * same number. A step change one frame late is one frame of over-spend, and the
 * hitch that costs is smaller than the hitch not tapering at all costs.
 */

/** The frame this is all sized against: 60 Hz. */
export const TARGET_FRAME_MS = 1000 / 60;

/** Past this the taper has bottomed out. 30 Hz. */
export const SLOW_FRAME_MS = 1000 / 30;

/**
 * The least the streamer may ever be given, whatever the frame is doing.
 * See the header: zero is a world that never builds.
 */
export const MIN_BUDGET_MS = 0.8;

/**
 * The budget for a frame that took `frameMs`, against a nominal `baseMs`.
 *
 * A frame at or under 60 Hz gets the whole thing; one at or over 30 Hz gets
 * `MIN_BUDGET_MS`; between them it is linear. A `frameMs` of zero or NaN -- the
 * first frame, or a clock that went backwards -- gets the base, because an
 * unknown frame is not evidence of a slow one.
 */
export function buildBudgetFor(baseMs: number, frameMs: number): number {
  if (!Number.isFinite(frameMs) || frameMs <= 0) return baseMs;
  if (frameMs <= TARGET_FRAME_MS) return baseMs;
  if (frameMs >= SLOW_FRAME_MS) return Math.min(baseMs, MIN_BUDGET_MS);
  const t = (frameMs - TARGET_FRAME_MS) / (SLOW_FRAME_MS - TARGET_FRAME_MS);
  const floor = Math.min(baseMs, MIN_BUDGET_MS);
  return baseMs + (floor - baseMs) * t;
}

export function verifyBuildBudget(): string[] {
  const failures: string[] = [];
  const base = 2.5;

  if (!(MIN_BUDGET_MS > 0)) {
    failures.push('The floor is zero or less: a client that stops building never gets the world back, because a blank world is cheap and stays fast.');
  }
  if (!(SLOW_FRAME_MS > TARGET_FRAME_MS)) {
    failures.push(`The taper runs from ${TARGET_FRAME_MS} ms to ${SLOW_FRAME_MS} ms, which is not a range.`);
  }

  // A healthy frame is not taxed at all.
  for (const ms of [0, 8, TARGET_FRAME_MS]) {
    if (buildBudgetFor(base, ms) !== base) {
      failures.push(`A ${ms} ms frame got ${buildBudgetFor(base, ms).toFixed(2)} ms rather than the full ${base}.`);
    }
  }
  // An unknown frame is not evidence of a slow one.
  if (buildBudgetFor(base, Number.NaN) !== base) failures.push('A NaN frame time was treated as a slow frame.');

  // A slow frame is tapered, but never to nothing.
  const slow = buildBudgetFor(base, SLOW_FRAME_MS);
  if (slow !== MIN_BUDGET_MS) failures.push(`A 30 Hz frame got ${slow.toFixed(2)} ms rather than the ${MIN_BUDGET_MS} ms floor.`);
  const awful = buildBudgetFor(base, 500);
  if (awful !== MIN_BUDGET_MS) failures.push(`A 500 ms frame got ${awful.toFixed(2)} ms rather than the floor.`);
  if (awful <= 0) failures.push('The worst case reached zero; the world would never finish building.');

  // Monotonic: a worse frame never gets more.
  let last = Infinity;
  for (let ms = 1; ms <= 60; ms++) {
    const b = buildBudgetFor(base, ms);
    if (b > last + 1e-9) failures.push(`A ${ms} ms frame got more budget than a ${ms - 1} ms one.`);
    last = b;
  }

  // And the taper is gentle: 30 Hz still builds, so a weak machine still gets a
  // city -- just later. Halfway between the two marks should keep over a third.
  const mid = buildBudgetFor(base, (TARGET_FRAME_MS + SLOW_FRAME_MS) / 2);
  if (mid < base * 0.3) failures.push(`A 40 Hz frame kept only ${mid.toFixed(2)} ms of ${base}; the taper is too steep to build a world through.`);

  // A base under the floor is not raised by the taper.
  if (buildBudgetFor(0.5, 500) > 0.5) failures.push('A base below the floor was raised by the taper.');

  return failures;
}
