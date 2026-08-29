/**
 * How many fixed steps this frame runs, and what it is allowed to remember.
 *
 * ---------------------------------------------------------------------------
 * ## The four lines this exists for
 *
 * `main.ts` ran the standard accumulator:
 *
 *     accumulator += frameDt;
 *     while (accumulator >= FIXED_DT && steps < 8) { simulate(FIXED_DT); ... }
 *
 * The step cap is right and prevents a spiral. What it does not do is stop the
 * *leftover* being carried: after a 400 ms stall the accumulator holds 400 ms,
 * eight steps take 133 of it, and 267 ms goes into the next frame, which runs
 * eight more, and the frame after that runs eight more. One stall becomes a
 * three-frame stutter at eight times the simulation cost, which is a much
 * better description of what a player calls "a freeze" than one long frame is.
 *
 * So the carry is clamped to a single frame's worth. **Time the simulation
 * cannot run is time the simulation will never run**, and that is the correct
 * trade: nobody can perceive four milliseconds of missing simulated time, and
 * everybody can perceive the two frames after a hitch doing eight steps each to
 * catch up on it.
 *
 * ## Why a module, for four lines
 *
 * Because the assertion is worth more than the code. `verifyFrameStep` runs on
 * both boot lists and asserts the thing that is actually easy to regress: not
 * that the cap holds -- it always held -- but that **the frame after a spike
 * runs at most two steps**. Somebody restoring the "obvious" accumulator would
 * pass a review and fail this.
 *
 * Three-free and DOM-free, so the server's boot list reads it too.
 */

/** The most fixed steps one frame may run. `main.ts`'s number, moved here. */
export const MAX_CATCHUP_STEPS = 8;

export interface StepPlan {
  /** How many times to call `simulate(fixedDt)` this frame. */
  steps: number;
  /** What to carry into the next frame. Never more than one `fixedDt`. */
  carry: number;
}

/**
 * Plan this frame's fixed steps.
 *
 * `carry` is the previous frame's leftover, `frameDt` the real elapsed time.
 * Pure, so the whole of the stall-amplification rule is one testable function.
 */
export function planSteps(
  carry: number,
  frameDt: number,
  fixedDt: number,
  maxSteps: number = MAX_CATCHUP_STEPS,
): StepPlan {
  // A non-finite or negative delta is a tab that was backgrounded, a clock that
  // went backwards, or a test being unkind. None of them should run a step, and
  // none of them should poison the carry.
  const dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
  let acc = (Number.isFinite(carry) && carry > 0 ? carry : 0) + dt;
  let steps = 0;
  while (acc >= fixedDt && steps < maxSteps) {
    acc -= fixedDt;
    steps++;
  }
  // The clamp. See the header: what the cap could not consume is discarded
  // rather than owed.
  if (acc > fixedDt) acc = fixedDt;
  return { steps, carry: acc };
}

export function verifyFrameStep(): string[] {
  const failures: string[] = [];
  const FIXED = 1 / 60;

  // --- A steady 60 Hz runs exactly one step a frame and carries nothing much.
  {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 600; i++) {
      const plan = planSteps(carry, FIXED, FIXED);
      carry = plan.carry;
      total += plan.steps;
    }
    if (total !== 600) failures.push(`600 frames at 60 Hz ran ${total} steps, not 600.`);
  }

  // --- A steady 30 Hz runs two, and a steady 144 runs one every other frame.
  {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const plan = planSteps(carry, 1 / 30, FIXED);
      carry = plan.carry;
      total += plan.steps;
    }
    if (Math.abs(total - 600) > 2) failures.push(`300 frames at 30 Hz ran ${total} steps, not about 600.`);
  }
  {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 1440; i++) {
      const plan = planSteps(carry, 1 / 144, FIXED);
      carry = plan.carry;
      total += plan.steps;
    }
    if (Math.abs(total - 600) > 2) failures.push(`1440 frames at 144 Hz ran ${total} steps, not about 600.`);
  }

  // --- The cap holds.
  {
    const plan = planSteps(0, 2.0, FIXED);
    if (plan.steps !== MAX_CATCHUP_STEPS) {
      failures.push(`A two-second frame ran ${plan.steps} steps rather than capping at ${MAX_CATCHUP_STEPS}.`);
    }
  }

  // --- THE ONE THAT MATTERS. A spike does not spill into the frames after it.
  {
    let carry = 0;
    const spike = planSteps(carry, 0.4, FIXED);
    carry = spike.carry;
    if (spike.steps !== MAX_CATCHUP_STEPS) failures.push(`The 400 ms frame ran ${spike.steps} steps.`);
    const after = planSteps(carry, FIXED, FIXED);
    if (after.steps > 2) {
      failures.push(
        `The frame after a 400 ms spike ran ${after.steps} steps. The carry is spilling, ` +
          'which is one stall becoming three.',
      );
    }
    const later = planSteps(after.carry, FIXED, FIXED);
    if (later.steps > 1) failures.push(`Two frames after the spike still ran ${later.steps} steps.`);
  }

  // --- The carry is never more than one step, whatever it is handed.
  {
    for (const [c, dt] of [[9, 9], [0.5, 0.5], [1e6, 1e6]] as Array<[number, number]>) {
      const plan = planSteps(c, dt, FIXED);
      if (plan.carry > FIXED + 1e-12) failures.push(`planSteps(${c}, ${dt}) carried ${plan.carry}, over one step.`);
      if (plan.steps > MAX_CATCHUP_STEPS) failures.push(`planSteps(${c}, ${dt}) ran ${plan.steps} steps.`);
    }
  }

  // --- Rubbish in does not become steps or a poisoned carry.
  {
    for (const dt of [NaN, -1, Infinity]) {
      const plan = planSteps(0, dt, FIXED);
      if (plan.steps !== 0 || !Number.isFinite(plan.carry)) {
        failures.push(`A frame delta of ${dt} produced ${plan.steps} steps and a carry of ${plan.carry}.`);
      }
    }
    const fromBadCarry = planSteps(NaN, FIXED, FIXED);
    if (!Number.isFinite(fromBadCarry.carry) || fromBadCarry.steps !== 1) {
      failures.push('A non-finite carry was not recovered from.');
    }
  }

  return failures;
}
