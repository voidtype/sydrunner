/**
 * The city itself, underneath everything: a pink bed that breathes.
 *
 * The owner, after the cars were made to decay faster: *"maybe we need some
 * ambient noise but not sure what,,,, just a swelling randomly pink noise at
 * like 35dB ?"*. The uncertainty in that sentence is the design. He is not
 * asking for a *sound* -- every sound in this project is a cue, and a cue that
 * is always on is not a cue, which is the argument `RAVE_AUDIBLE_RANGE` and
 * `ANNOUNCE_RANGE` both had. He is asking for the thing under the cues: the
 * reason a real street is never silent even when nothing on it is making a
 * noise you could name.
 *
 * So this is the **floor of the mix** and nothing else. It has no position, no
 * range, no gate and no trigger; it does not know where the player is and never
 * will. What it has is a level 35 dB down and a very slow swell, and the whole
 * test of it is `ENGINE_BED_GAIN`'s test one storey lower: *a player must never
 * identify it as a sound at all until they walk somewhere it is not* -- and
 * there is nowhere it is not, so the only way to notice it is to turn the sound
 * off.
 *
 * ---------------------------------------------------------------------------
 * 1. THIS IS NOT `carsound`'s BED, AND THE TWO MUST NOT BE MERGED.
 *
 * `game/carsound.ts` section 5 already has a bed, and it is *cars*: a count of
 * moving vehicles inside `BED_RANGE` driving a saturating curve on one rumble,
 * so Broadway sounds different from a lane in Hunters Hill. It is a measurement
 * of the world.
 *
 * This one is the opposite in every respect. It is not measured, it is not
 * spatial, it does not vary with anything a player can walk toward, and it never
 * goes away. Folding them together would destroy both: the traffic bed would
 * stop being able to reach zero on a quiet street, which is the only thing it is
 * for, and this one would inherit a gate, which is the only thing it must not
 * have. They also live at different levels for that reason -- 0.10 * `ENGINE_TRIM`
 * against `CITY_BED_GAIN`'s 0.018 -- and the ordering is the design: the cars are
 * a thing you hear, this is the thing you hear them *over*.
 *
 * ---------------------------------------------------------------------------
 * 2. PINK, AND WHICH PINK.
 *
 * White noise is the wrong colour and it is not a close call. Equal energy per
 * hertz puts most of the power in the top two octaves, which is what tape hiss
 * is and what a mix sounds like when somebody has left a channel open; the ear
 * reads it as a fault in the equipment. **Pink** -- equal energy per *octave*,
 * a 3 dB/octave fall -- is what distance and air and buildings do to broadband
 * noise, and it is the spectrum of essentially every environmental sound there
 * is: traffic four streets away, wind in a street, a city from a balcony.
 *
 * The generator is **Paul Kellet's refined method**: six one-pole sections plus
 * a direct term, run over a white source, accurate to about ±0.05 dB against a
 * true 1/f slope from 9 Hz up. It is chosen over the two alternatives for
 * reasons that are about *this* file rather than about spectra:
 *
 *   - the **Voss-McCartney** octave-sum generator is the textbook one and is
 *     structurally periodic -- it updates its k-th row every 2^k samples, which
 *     puts a repeating pattern in the output at exactly the timescale a loop is
 *     most likely to expose;
 *   - an **FFT** shaped to 1/f and inverse-transformed is exact and is circular
 *     by construction, which would have solved the seam for free -- and needs an
 *     FFT in a file that otherwise contains six multiplies and an add. It is the
 *     right answer for an offline asset and the wrong one for thirty lines that
 *     have to compile into the Bun server.
 *
 * Kellet is six multiply-accumulates a sample, has no period of its own beyond
 * the white source's, and its coefficients are the whole of the spectrum -- so
 * `verifyCityBed` can assert the *tilt* directly and a white buffer put through
 * the same measurement fails it. See `bandEnergy`.
 *
 * The 2 kHz low-pass that makes it read as *distant* city rather than as pink
 * noise is not here: it is one `BiquadFilterNode` in `game/audio.ts`, next to
 * the oscillator it belongs beside, on `game/carsound.ts`' split exactly. This
 * file is the schedule and the sample data; that one is the graph.
 *
 * ---------------------------------------------------------------------------
 * 3. THE SEAM, WHICH IS THE ONLY WAY THIS CAN FAIL AUDIBLY.
 *
 * One buffer loops forever, so there is one join in it, and a click every
 * `CITY_BED_SECONDS` for the rest of the session is a bug report that says "the
 * audio ticks" with no way to reproduce it. In *white* noise a join is
 * inaudible -- a random step between random steps -- but the whole point of pink
 * is that it has slow content, and a slow waveform cut and butted against itself
 * has a genuine discontinuity in it.
 *
 * The fix is the one a sampling library uses and it costs a quarter of a second
 * of extra generation: make `CITY_BED_SECONDS + CITY_BED_SEAM_S` of noise, keep
 * the first `CITY_BED_SECONDS` of it, and **crossfade the surplus tail into the
 * head**. Written the way it is written, sample 0 of the loop is exactly
 * `x[N]` -- the sample the generator produced *after* the last one in the buffer
 * -- so the join is not smoothed over, it is the honest continuation of the
 * signal, and the crossfade region behind it is where the two streams are
 * reconciled instead.
 *
 * Equal-power (`sqrt`) rather than linear weights, because the two streams are
 * uncorrelated: linear weights would sum to 0.707 of the amplitude in the middle
 * of the fade and put a 3 dB dip in the bed once a loop, which is a slow pulse
 * and is worse than the click it replaced.
 *
 * ---------------------------------------------------------------------------
 * 4. THE SWELL IS A PURE FUNCTION OF TIME, AND THAT IS WHY IT CAN BE TESTED.
 *
 * *"swelling randomly"*. The obvious implementation is `Math.random` on a timer
 * and it is wrong twice over: nothing in this project's audio is allowed to be
 * irreproducible (`game/footy.ts` and `game/traffic.ts` state the rule -- ambient
 * things are pure functions of `(anchor, index, tick)`), and a check cannot
 * assert anything about a random walk except that it stayed in its bounds.
 *
 * So `citySwell(t)` is four slow waves on **incommensurate periods** -- 37, 53,
 * 71 and 97 seconds, four primes -- summed onto 1. Their beat repeats after
 * 37 * 53 * 71 * 97 seconds, which is 156 days, so it never audibly repeats
 * inside any session anybody will ever play; and because it is a sum of four
 * bounded continuous waves it can never lurch, which a random walk absolutely
 * can. `verifyCityBed` asserts both properties directly rather than trusting the
 * arithmetic: it bounds the first difference over ten minutes of samples, and
 * it searches every candidate period under ten minutes for one that repeats.
 *
 * The wave is `giverbodies.wave`'s -- a triangle through a smoothstep, no
 * transcendental -- for that function's stated reason and for one more of its
 * own: this check runs in the Bun server as well as in the browser, and a
 * `Math.sin` in a thing evaluated on both ends is the habit `CLAUDE.md` bans.
 *
 * ---------------------------------------------------------------------------
 * 5. WHAT IT COSTS, WHICH IS AS CLOSE TO NOTHING AS AN ALWAYS-ON SOUND GETS.
 *
 * Three nodes for the session -- a looping `AudioBufferSourceNode`, one biquad
 * and one gain -- built on the first frame the context is running and never
 * rebuilt, and a single `setTargetAtTime` a frame. Nothing is allocated after
 * the buffer, nothing is scheduled, and with the sound off or the context
 * suspended nothing is built at all: the update returns on a null check before
 * it has read the clock. The buffer is `CITY_BED_SECONDS` of mono float at the
 * context's own rate -- 768 kB at 48 kHz -- which is the one number here worth
 * knowing and is the price of never allocating again.
 */

// --- The buffer ------------------------------------------------------------------

/**
 * How long the loop is, seconds, and how much of it the seam fold eats.
 *
 * Four seconds is chosen against the two failure modes at either end of it. Too
 * short and the loop is *findable*: pink noise has content down to a few hertz
 * and a one-second loop of it has an audible pulse at 1 Hz, which is the same
 * fault as a badly looped room tone. Too long and the buffer stops being free --
 * ten seconds at 48 kHz is 1.9 MB of float held for the session, for a
 * difference nobody can hear. At four seconds the lowest full cycle in the loop
 * is 0.25 Hz, well under the swell's own 37-second slowest wave, so the two
 * never beat against each other in a way that reads as rhythm.
 *
 * The seam is a quarter of a second: long enough that the crossfade region is
 * statistically settled, short enough that it is 6 % of the buffer. See section 3.
 */
export const CITY_BED_SECONDS = 4;
export const CITY_BED_SEAM_S = 0.25;

/**
 * The seed the shipped bed is generated from.
 *
 * A constant rather than `Math.random`, so that every player in a room is
 * standing in the *same* noise and a bug report about "a weird tone in the
 * ambience" is reproducible by anybody. It is noise; which noise is arbitrary;
 * that it is the same noise is not.
 */
export const CITY_BED_SEED = 0x5d9e17 | 0;

/**
 * Paul Kellet's refined pink filter: six poles, six input weights, and the
 * direct term.
 *
 * Exported because they are the *spectrum* -- the claim this file makes about
 * what it produces is entirely in these fourteen numbers, and `verifyCityBed`
 * measures the buffer they generate rather than reading them back. Do not tune
 * them by ear: the set is fitted, and moving one pole tilts the whole slope.
 */
export const PINK_POLES: readonly number[] = [0.99886, 0.99332, 0.969, 0.8665, 0.55, -0.7616];
export const PINK_WEIGHTS: readonly number[] = [
  0.0555179, 0.0750759, 0.153852, 0.3104856, 0.5329522, -0.016898,
];
/** The white that goes straight through, and the one-sample-delayed tail. */
export const PINK_DIRECT = 0.5362;
export const PINK_TAIL = 0.115926;

/**
 * How loud the whole thing is: the owner's 35 dB.
 *
 * `10 ^ (-35 / 20)` is 0.0178, and 0.018 is that to the two figures every other
 * level in `game/audio.ts` is written to. It is **the smallest gain in the
 * mix**, and deliberately: `ENGINE_BED_GAIN`'s 0.10 through `ENGINE_TRIM` is
 * 0.0167 of traffic and `SUN_SCREAM_GAIN` is 0.12, so this sits with the
 * traffic bed at the very bottom and a factor of seven under the scream. See the
 * level-budget block at the foot of `game/audio.ts` for where it lands against
 * the limiter, which is nowhere: 0.55 * 0.018 * 1.4 at the top of a swell is
 * 0.014 against a threshold of 0.398.
 *
 * The swell multiplies it, so the real range is 0.011 to 0.025 -- about
 * -39 to -32 dB.
 */
export const CITY_BED_GAIN = 0.018;

/**
 * Where the bed is low-passed, hertz, and how fast the applied gain may move.
 *
 * 2 kHz is what makes it *a city* instead of *noise*. Untouched pink still has
 * real energy at 10 kHz and that top octave is the one the ear files under
 * "hiss"; a gentle two-pole corner at 2 kHz takes it off and what is left reads
 * as a very large distant thing, which is the correct lie -- there is no single
 * source out there, so the sound has to arrive already having been through a
 * kilometre of air and a suburb of brick.
 *
 * The glide is the rate limiter section 4's swell is applied through. 0.75 s is
 * far slower than `ENGINE_GLIDE_S`' 50 ms because nothing here is tracking an
 * event: the fastest the swell itself can move is 3.6 % of the level a second,
 * and a follower an order of magnitude quicker than that guarantees the applied
 * gain is a slide under any frame rate, including the 4 fps of a tab that has
 * just come back.
 */
export const CITY_BED_LOWPASS_HZ = 2000;
export const CITY_BED_GLIDE_S = 0.75;

// --- The swell --------------------------------------------------------------------

/**
 * The four periods, seconds, and how much of the swell each one owns.
 *
 * Four primes, so nothing divides anything: the sum repeats after their product,
 * 13.5 million seconds, which is 156 days of continuous play. The weights add to
 * `CITY_SWELL_DEPTH` and are ordered so the slowest wave is the loudest -- the
 * thing a player should half-notice is the two-minute breath, and the 37-second
 * one is there to stop the two-minute breath from being a shape you can predict.
 */
export const CITY_SWELL_PERIODS: readonly number[] = [97, 71, 53, 37];
export const CITY_SWELL_WEIGHTS: readonly number[] = [0.16, 0.11, 0.08, 0.05];
/** How far the swell may move the level either way. The weights' sum. */
export const CITY_SWELL_DEPTH = 0.4;

/**
 * A smooth wave in [-1, 1] with period 1: a triangle through a cubic ease.
 *
 * `game/giverbodies.wave` exactly, restated rather than imported for the reason
 * `SOUND_SPEED` is restated in `game/carsound.ts`: this file must not depend on
 * the giver bodies, the dependency would run the wrong way, and a smoothstep is
 * not a thing either of them can get wrong. Smooth at the folds as well as
 * between them, because a bare triangle would put a corner in the swell's rate
 * twice a cycle and a corner in a gain is the one artefact this whole file is
 * arranged to avoid.
 */
function wave(u: number): number {
  const f = u - Math.floor(u);
  const t = f < 0.5 ? f * 2 : 2 - f * 2;
  return t * t * (3 - 2 * t) * 2 - 1;
}

/**
 * How loud the city is right now, as a multiple of `CITY_BED_GAIN`. 0.6 to 1.4.
 *
 * Pure in `t` and in nothing else -- no state, no clock of its own, no
 * `Math.random` -- which is what lets `verifyCityBed` sample twenty minutes of it
 * in a boot list and what makes two clients standing in the same street hear the
 * same breath. `t` is seconds; the caller passes `ctx.currentTime`, so it starts
 * at zero when the context does and that is fine: there is no wrong phase for
 * this.
 */
export function citySwell(t: number): number {
  let v = 1;
  for (let i = 0; i < CITY_SWELL_PERIODS.length; i++) {
    v += CITY_SWELL_WEIGHTS[i] * wave(t / CITY_SWELL_PERIODS[i]);
  }
  return v;
}

// --- Making the noise ---------------------------------------------------------------

/** xorshift32, `world/birds.ts`' generator: three shifts, three xors, exact. */
function nextWhite(state: number): number {
  let s = state | 0;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s | 0;
}

/**
 * Fill `out` with one seamless loop of pink noise at `rate` samples a second.
 *
 * `out.length` is the loop; the generator runs `CITY_BED_SEAM_S` longer than
 * that and folds the surplus back over the head. See sections 2 and 3. Peak
 * normalised to 0.9 rather than left as it comes, because Kellet's output is
 * Gaussian-ish and its peak depends on how long you ran it -- an un-normalised
 * buffer would make `CITY_BED_GAIN` mean a slightly different level every time
 * the seed or the length changed, which is exactly the kind of drift a level
 * budget written in a comment cannot survive.
 */
export function fillCityBed(out: Float32Array, rate: number, seed: number = CITY_BED_SEED): void {
  const n = out.length;
  if (n <= 0) return;
  const seam = Math.min(Math.floor(rate * CITY_BED_SEAM_S), n - 1);
  const total = n + seam;
  const buf = new Float32Array(total);

  let s = seed | 0;
  if (s === 0) s = 1;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  // The twelve coefficients into locals before the loop. Read out of the exported
  // arrays a sample at a time this is measurably slower, and it runs 200,000
  // times on the frame the context opens.
  const p0 = PINK_POLES[0], p1 = PINK_POLES[1], p2 = PINK_POLES[2];
  const p3 = PINK_POLES[3], p4 = PINK_POLES[4], p5 = PINK_POLES[5];
  const w0 = PINK_WEIGHTS[0], w1 = PINK_WEIGHTS[1], w2 = PINK_WEIGHTS[2];
  const w3 = PINK_WEIGHTS[3], w4 = PINK_WEIGHTS[4], w5 = PINK_WEIGHTS[5];
  // A warm-up so the buffer does not open on the filter's own settling
  // transient, which at the 0.99886 pole is a slow slide over the first
  // thousand samples and would be the loudest thing in the loop.
  const warm = 4096;
  for (let i = -warm; i < total; i++) {
    s = nextWhite(s);
    // xorshift32's int32 to [-1, 1), by 2^31 rather than by 0xffffffff, so the
    // sign of the sample is the sign of the integer and the source is symmetric
    // about zero without a subtraction.
    const white = s / 2147483648;
    b0 = p0 * b0 + white * w0;
    b1 = p1 * b1 + white * w1;
    b2 = p2 * b2 + white * w2;
    b3 = p3 * b3 + white * w3;
    b4 = p4 * b4 + white * w4;
    b5 = p5 * b5 + white * w5;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * PINK_DIRECT;
    b6 = white * PINK_TAIL;
    if (i >= 0) buf[i] = pink;
  }

  // --- The seam. `out[0]` is `buf[n]`, the sample that would have come next, so
  // the join is a continuation rather than a smoothing; the fade behind it is
  // where the two streams meet. Equal-power weights: see section 3.
  for (let i = 0; i < n; i++) out[i] = buf[i];
  for (let i = 0; i < seam; i++) {
    const u = i / seam;
    out[i] = buf[i] * Math.sqrt(u) + buf[n + i] * Math.sqrt(1 - u);
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = out[i] < 0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
}

// --- Measuring it, which is the only way the colour can be checked ------------------

/**
 * Mean square of `x` after a one-pole low-pass at `hz`, and after its complement.
 *
 * A **band-sum, not an FFT**, and the choice is the same one section 2 made
 * about the generator: what has to be proved is that the spectrum *falls*, which
 * is an inequality between two numbers, and an inequality between two numbers
 * does not need a transform. Two one-poles cost eight multiplies a sample and
 * have no transcendental in them -- the coefficient is the RC form written with
 * 2 pi as a literal -- so this runs in the Bun server's boot list like everything
 * else in this file.
 *
 * Returns `[below, above]`: the energy the low-pass kept and the energy it
 * rejected. Neither is brickwall and neither needs to be; what the check reads
 * is the ratio, and a white buffer and a pink buffer are two orders of magnitude
 * apart on it.
 */
export function bandEnergy(x: Float32Array, rate: number, hz: number): [number, number] {
  const a = 1 / (1 + rate / (6.283185307179586 * hz));
  let lp = 0;
  let below = 0;
  let above = 0;
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp);
    below += lp * lp;
    const hi = x[i] - lp;
    above += hi * hi;
  }
  const n = x.length || 1;
  return [below / n, above / n];
}

/**
 * How far the spectrum tilts: low-band energy over high-band energy at 1 kHz.
 *
 * One number, and its whole job is to separate two cases that are not close.
 * Pink noise has equal energy per octave, so the six octaves under 1 kHz that
 * this generator actually fills carry more than the four and a half over it and
 * the ratio comes out above 1. White noise has equal energy per hertz, so the
 * 23 kHz over the corner swamp the 1 kHz under it and the ratio comes out near
 * 0.03. `verifyCityBed` asserts pink passes *and* that white fails, which is the
 * negative control that stops this test from being a thing that always passes.
 */
export function spectralTilt(x: Float32Array, rate: number): number {
  const [below, above] = bandEnergy(x, rate, 1000);
  return above > 0 ? below / above : Infinity;
}

// --- The check ----------------------------------------------------------------------

/**
 * Everything in this file that can be wrong without anybody being able to see it.
 *
 * Which is all of it. A bed is by construction the sound a player never
 * consciously hears, so every failure here is silent in this repo's sense: a
 * swell that steps is a gain zipper somebody will describe as "the audio
 * crackles sometimes"; a swell with a short period is a rhythm under the whole
 * game that reads as a bug in something else entirely; a buffer that is white
 * instead of pink is hiss; and a seam that clicks is a tick every four seconds
 * for as long as the tab is open. None of them can be screenshotted and none of
 * them will ever appear in a stack trace.
 *
 * Runs in both boot lists on `CLAUDE.md`'s rule, which this file can satisfy
 * because there is no `AudioContext` in it -- only the sample data and the
 * arithmetic that decides what the graph does with it.
 */
export function verifyCityBed(): string[] {
  const f: string[] = [];

  // --- The swell: bounds, over an hour.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 36000; i++) {
    const v = citySwell(i / 10);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const floor = 1 - CITY_SWELL_DEPTH;
  const ceil = 1 + CITY_SWELL_DEPTH;
  if (lo < floor - 1e-12 || hi > ceil + 1e-12) {
    f.push(`citySwell leaves [${floor}, ${ceil}]: ${lo.toFixed(4)} .. ${hi.toFixed(4)}`);
  }
  // And it must actually swell. A depth nobody can hear is the same bug as no
  // bed at all, arrived at from the other side.
  if (hi - lo < 0.25) f.push(`citySwell barely moves: ${(hi - lo).toFixed(4)} over an hour`);
  {
    let weights = 0;
    for (const w of CITY_SWELL_WEIGHTS) weights += w;
    if (Math.abs(weights - CITY_SWELL_DEPTH) > 1e-12) {
      f.push(`CITY_SWELL_WEIGHTS sum to ${weights}, not CITY_SWELL_DEPTH ${CITY_SWELL_DEPTH}`);
    }
    if (CITY_SWELL_WEIGHTS.length !== CITY_SWELL_PERIODS.length) {
      f.push('CITY_SWELL_WEIGHTS and CITY_SWELL_PERIODS are different lengths');
    }
  }

  // --- Pure in t. The same second twice is the same number, and the answer
  // cannot depend on what was asked before it: a cached state, a stray
  // `Math.random` or a `Date.now` all fail here.
  for (let i = 0; i < 500; i++) {
    const t = i * 3.7;
    const a = citySwell(t);
    citySwell(t * 13 + 1);
    const b = citySwell(t);
    if (a !== b) f.push(`citySwell is not pure at t=${t}: ${a} then ${b}`);
  }

  // --- No lurch. The first difference over ten minutes at 100 Hz, against the
  // analytic bound: the smoothstep triangle's steepest slope is 6 per period, so
  // the sum cannot move faster than 6 * sum(weight / period) a second.
  let slope = 0;
  for (let i = 0; i < CITY_SWELL_PERIODS.length; i++) {
    slope += CITY_SWELL_WEIGHTS[i] / CITY_SWELL_PERIODS[i];
  }
  slope *= 6;
  {
    const step = 0.01;
    let worst = 0;
    let prev = citySwell(0);
    for (let i = 1; i <= 60000; i++) {
      const v = citySwell(i * step);
      const d = v > prev ? v - prev : prev - v;
      if (d > worst) worst = d;
      prev = v;
    }
    if (worst > slope * step * 1.05) {
      f.push(`citySwell steps: ${worst.toExponential(3)} in ${step}s, bound ${(slope * step).toExponential(3)}`);
    }
    // And the bound itself has to be slow enough to be a swell rather than a
    // wobble: an eighth of the depth a second would be a tremolo.
    if (slope > CITY_SWELL_DEPTH / 8) f.push(`citySwell moves at ${slope.toFixed(4)}/s, which is a wobble`);
  }

  // --- No period under ten minutes.
  //
  // Every candidate shift from half a second to ten minutes, at a tenth of a
  // second, scored against **how far the swell could have moved in that shift**
  // rather than against a fixed number. That normalisation is the whole test: a
  // shift of a tenth of a second disagrees by almost nothing on any slow wave,
  // so a flat threshold would report every short candidate as a repeat and
  // nothing would ever have been checked. What a real period looks like is a
  // shift the wave *could* have wandered over and did not. The measured worst
  // case over the whole range is 0.49 of what was available, at 484.9 s; a
  // quarter is the line, so this fails long before two of the periods start
  // sharing a factor.
  {
    let found = 0;
    let foundAt = 0;
    let tightest = Infinity;
    for (let p10 = 5; p10 <= 6000; p10++) {
      const period = p10 / 10;
      const possible = Math.min(CITY_SWELL_DEPTH, slope * period);
      let worst = 0;
      for (let k = 0; k < 40; k++) {
        const t = k * 13.7;
        const v = citySwell(t + period) - citySwell(t);
        const d = v > 0 ? v : -v;
        if (d > worst) worst = d;
        if (worst > possible * 0.25) break;
      }
      const rel = worst / possible;
      if (rel < tightest) tightest = rel;
      if (rel <= 0.25) { found++; if (foundAt === 0) foundAt = period; }
    }
    if (found > 0) {
      f.push(`citySwell nearly repeats inside ten minutes: ${found} shift(s), first at ${foundAt}s (${tightest.toFixed(3)} of the available drift)`);
    }
    // The primes are the reason it does not, so check they are still pairwise
    // coprime: an edit that gives two of them a common factor shortens the beat
    // by that factor, and this is the line that says so in one word rather than
    // as a mysterious near-repeat above.
    for (let i = 0; i < CITY_SWELL_PERIODS.length; i++) {
      for (let j = i + 1; j < CITY_SWELL_PERIODS.length; j++) {
        let a = CITY_SWELL_PERIODS[i];
        let b = CITY_SWELL_PERIODS[j];
        while (b !== 0) { const r = a % b; a = b; b = r; }
        if (a !== 1) {
          f.push(`swell periods ${CITY_SWELL_PERIODS[i]} and ${CITY_SWELL_PERIODS[j]} share a factor of ${a}`);
        }
      }
    }
  }

  // --- The noise. A second of it at 48 kHz, which is the same code path the
  // four-second buffer takes and a quarter of the boot cost.
  const rate = 48000;
  const bed = new Float32Array(rate);
  fillCityBed(bed, rate);

  let rms = 0;
  {
    let peak = 0;
    let energy = 0;
    let dc = 0;
    let bad = false;
    for (let i = 0; i < bed.length; i++) {
      const a = bed[i] < 0 ? -bed[i] : bed[i];
      if (a > peak) peak = a;
      energy += bed[i] * bed[i];
      dc += bed[i];
      if (!bad && !Number.isFinite(bed[i])) { f.push(`fillCityBed produced ${bed[i]} at ${i}`); bad = true; }
    }
    if (Math.abs(peak - 0.9) > 1e-6) f.push(`fillCityBed peak is ${peak}, want 0.9`);
    rms = Math.sqrt(energy / bed.length);
    // Kellet pink peaks at about four times its RMS: measured 0.221 against the
    // 0.9 peak. A buffer whose crest factor has collapsed is one the filter has
    // gone unstable in, and one whose RMS has collapsed is a buffer with a single
    // spike in it and silence either side.
    if (rms < 0.12 || rms > 0.4) f.push(`fillCityBed RMS is ${rms.toFixed(4)}; the filter is not doing what it did`);
    if (Math.abs(dc / bed.length) > 0.02) f.push(`fillCityBed has a DC offset of ${(dc / bed.length).toFixed(4)}`);
  }

  // --- The warm-up. Without it the loop opens on the 0.99886 pole's settling
  // slide -- a second of near-silence rising into the noise, once every four
  // seconds, which is the loop made audible in the most obvious way there is.
  {
    let head = 0;
    const k = Math.floor(rate * 0.005);
    for (let i = 0; i < k; i++) head += bed[i] * bed[i];
    const headRms = Math.sqrt(head / k);
    if (headRms < rms * 0.4 || headRms > rms * 2.5) {
      f.push(`the loop opens at ${headRms.toFixed(4)} against an RMS of ${rms.toFixed(4)}: the generator is not warmed up`);
    }
  }

  // --- The crossfade region holds its level. Equal-power weights on two
  // uncorrelated streams keep the RMS flat; the linear weights somebody will
  // eventually "simplify" this to put a 3 dB dip in the middle of the fade, which
  // is a pulse once a loop and is worse than the click it was avoiding.
  {
    const seamLen = Math.floor(rate * CITY_BED_SEAM_S);
    const from = Math.floor(seamLen * 0.35);
    const to = Math.floor(seamLen * 0.65);
    let e = 0;
    for (let i = from; i < to; i++) e += bed[i] * bed[i];
    const mid = Math.sqrt(e / (to - from));
    if (mid < rms * 0.8 || mid > rms * 1.3) {
      f.push(`the crossfade dips or bulges: ${mid.toFixed(4)} against an RMS of ${rms.toFixed(4)}`);
    }
  }

  // --- The seam itself, at two timescales.
  //
  // By construction `out[0]` is the sample the generator produced *after*
  // `out[n - 1]`, so the join is a continuation and should be indistinguishable
  // from any other adjacency in the buffer. That is what is asserted, rather than
  // "the step is small": in pink noise at 48 kHz a single-sample step is
  // HF-dominated and averages 0.11, so a threshold picked out of the air would
  // either pass everything or fail the honest signal. The seam is measured
  // against the buffer's *own* distribution of steps, sample to sample and over
  // ten-millisecond blocks -- the second one being where a slow discontinuity
  // would show, because that is the timescale a click actually lives at.
  {
    let sum = 0;
    let worst = 0;
    for (let i = 1; i < bed.length; i++) {
      const d = bed[i] > bed[i - 1] ? bed[i] - bed[i - 1] : bed[i - 1] - bed[i];
      sum += d;
      if (d > worst) worst = d;
    }
    const mean = sum / (bed.length - 1);
    const seam = Math.abs(bed[0] - bed[bed.length - 1]);
    if (seam > worst) f.push(`the loop seam steps further than anything inside it: ${seam.toFixed(4)} > ${worst.toFixed(4)}`);
    if (seam > mean * 6) f.push(`the loop seam clicks: ${seam.toFixed(4)} against a mean step of ${mean.toFixed(4)}`);

    const block = Math.floor(rate * 0.01);
    const blocks = Math.floor(bed.length / block);
    const means = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let s = 0;
      for (let i = 0; i < block; i++) s += bed[b * block + i];
      means[b] = s / block;
    }
    const adj: number[] = [];
    for (let b = 1; b < blocks; b++) {
      const d = means[b] - means[b - 1];
      adj.push(d > 0 ? d : -d);
    }
    adj.sort((a, b) => a - b);
    const p95 = adj[Math.floor(adj.length * 0.95)];
    const blockSeam = Math.abs(means[0] - means[blocks - 1]);
    if (blockSeam > p95) {
      f.push(`the loop seam moves the ten-millisecond average further than 95% of the buffer does: ${blockSeam.toExponential(2)} > ${p95.toExponential(2)}`);
    }
  }

  // --- Pink, measured, with white through the same measurement as the control.
  // A colour test that passes on white is a colour test that tests nothing.
  {
    const white = new Float32Array(bed.length);
    let s = CITY_BED_SEED | 0;
    for (let i = 0; i < white.length; i++) {
      s = nextWhite(s);
      white[i] = (s / 2147483648) * 0.9;
    }
    const pinkTilt = spectralTilt(bed, rate);
    const whiteTilt = spectralTilt(white, rate);
    // Measured: 1.99 against 0.074, a factor of 27. The thresholds are set at a
    // third and three times those, so this catches a generator that has lost its
    // colour long before it catches an arithmetic drift.
    if (!(pinkTilt > 1)) f.push(`the bed is not pink: low/high energy at 1 kHz is ${pinkTilt.toFixed(3)}, want > 1`);
    if (!(whiteTilt < 0.2)) f.push(`the negative control is broken: white measures ${whiteTilt.toFixed(3)}, want < 0.2`);
    if (!(pinkTilt > whiteTilt * 8)) {
      f.push(`pink and white are not separated: ${pinkTilt.toFixed(3)} against ${whiteTilt.toFixed(3)}`);
    }

    // And the fall is a *slope*, not one lucky pair of bands. Energy per hertz in
    // five successive octaves, each of which must be well under the octave below
    // it. Pink is 3 dB an octave, so each band is measured at about half the one
    // under it (0.50, 0.49, 0.48, 0.47, 0.46); white comes out at 0.97 to 0.74 and
    // fails the same line, which is asserted rather than assumed.
    const corners = [125, 250, 500, 1000, 2000, 4000, 8000];
    const density = (x: Float32Array): number[] => {
      const out: number[] = [];
      let prev = bandEnergy(x, rate, corners[0])[0];
      for (let i = 1; i < corners.length; i++) {
        const below = bandEnergy(x, rate, corners[i])[0];
        out.push((below - prev) / (corners[i] - corners[i - 1]));
        prev = below;
      }
      return out;
    };
    const pinkD = density(bed);
    const whiteD = density(white);
    let whiteFell = 0;
    for (let i = 1; i < pinkD.length; i++) {
      const ratio = pinkD[i] / pinkD[i - 1];
      if (!(ratio < 0.65)) {
        f.push(`the bed's energy does not fall from ${corners[i]} Hz to ${corners[i + 1]} Hz: ${ratio.toFixed(3)} of the octave below`);
      }
      if (whiteD[i] / whiteD[i - 1] < 0.65) whiteFell++;
    }
    if (whiteFell > 0) {
      f.push(`the octave test is too generous: white passes it in ${whiteFell} band(s)`);
    }
  }

  // --- The level's place in the mix. See `CITY_BED_GAIN`.
  {
    // `ENGINE_BED_GAIN * ENGINE_TRIM` from `game/audio.ts`, restated here for the
    // reason the speed of sound is restated in `game/carsound.ts`: this file must
    // not import the sound system, the dependency runs the other way, and what is
    // being asserted is an *ordering* that is a decision rather than a
    // measurement -- this is the floor, and the traffic sits on it.
    const trafficBed = 0.1 / 6;
    if (!(CITY_BED_GAIN < 0.1)) f.push(`CITY_BED_GAIN ${CITY_BED_GAIN} is not under the 0.10 at the bottom of the mix`);
    if (!(CITY_BED_GAIN * (1 + CITY_SWELL_DEPTH) < 0.1)) {
      f.push('CITY_BED_GAIN at the top of its swell is over the 0.10 at the bottom of the mix');
    }
    if (CITY_BED_GAIN > trafficBed * 1.5) {
      f.push(`CITY_BED_GAIN ${CITY_BED_GAIN} is loud beside the traffic bed's ${trafficBed.toFixed(4)}`);
    }
    // 35 dB down, which is the number the owner asked for, to a decibel.
    const dB = 20 * Math.log10(CITY_BED_GAIN);
    if (dB < -36 || dB > -34) f.push(`CITY_BED_GAIN is ${dB.toFixed(1)} dB, not the 35 dB down that was asked for`);
    if (!(CITY_BED_LOWPASS_HZ >= 1000 && CITY_BED_LOWPASS_HZ <= 4000)) {
      f.push(`CITY_BED_LOWPASS_HZ ${CITY_BED_LOWPASS_HZ} is not a distant-city corner`);
    }
    if (!(CITY_BED_GLIDE_S > 0.2)) f.push('CITY_BED_GLIDE_S is short enough to let the swell step');
    if (!(CITY_BED_SEAM_S > 0 && CITY_BED_SEAM_S < CITY_BED_SECONDS / 4)) {
      f.push(`CITY_BED_SEAM_S ${CITY_BED_SEAM_S} is not a small fold at the head of a ${CITY_BED_SECONDS}s loop`);
    }
  }

  return f;
}
