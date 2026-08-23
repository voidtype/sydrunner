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
 * will. What it has is a level under everything else in the mix and a swell that
 * takes it from silence to that level and back, and the whole test of it is
 * `ENGINE_BED_GAIN`'s test one storey lower: *a player must never identify it as
 * a sound at all until they walk somewhere it is not* -- and there is nowhere it
 * is not, so the only way to notice it is to turn the sound off. Both of those
 * numbers were got wrong on the first cut and set by ear on the second; see
 * `CITY_BED_GAIN` and section 4.
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
 * is 0.0167 of traffic against `CITY_BED_GAIN`'s 0.006 -- and the ordering is the
 * design: the cars are a thing you hear, this is the thing you hear them *over*.
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
 * 4. THE SWELL: ALL THE WAY DOWN, ALL THE WAY UP, AND AT A TEMPO THAT WANDERS.
 *
 * The owner heard the first cut and replaced the spec: *"the pink noise should
 * swell from 0-100% vol with a random frequency that shifts between 0.1 and
 * 0.01hz"*. Three things in one sentence, and each of them is a change from what
 * was here before.
 *
 *   - **0 to 100 %, not a shallow wobble.** `citySwell(t)` returns 0..1 and it
 *     really does reach both -- the bed goes *silent* at the bottom of every
 *     breath and to the whole of `CITY_BED_GAIN` at the top. The first cut moved
 *     between 0.6 and 1.4 of the level, which is a bed that is always on with a
 *     tremor in it; this is a bed that arrives and leaves. `verifyCityBed`
 *     asserts the silence, because "never quite reaching zero" is the exact
 *     failure this spec exists to rule out and it is the one a smoothing constant
 *     can reintroduce by accident (see `CITY_BED_GLIDE_S`).
 *   - **A tempo, not a period.** The swell's own frequency wanders between
 *     `CITY_SWELL_SLOW_HZ` and `CITY_SWELL_FAST_HZ` -- 0.01 to 0.1 Hz, breaths of
 *     100 seconds down to 10 -- and the wander itself takes minutes, driven by
 *     two very slow incommensurate terms (`CITY_TEMPO_PERIODS`, 311 s and 173 s,
 *     both prime). So the thing that is "random" is not the level, it is the
 *     rate, which is what the sentence asks for and is a much better description
 *     of a city than a fixed pulse at any speed.
 *   - **Still pure in `t`.** No accumulator, no state, no `Math.random`, for the
 *     reasons the rest of this project gives (`game/footy.ts` and
 *     `game/traffic.ts`: ambient things are pure functions of their clock) and
 *     for the one that matters here -- a check cannot assert anything about a
 *     random walk except that it stayed in its bounds.
 *
 * **How a wandering frequency stays pure**, which is the whole trick of this
 * section. The naive implementation integrates the frequency by accumulating
 * `phase += f(t) * dt` every frame, and that is state: it depends on the frame
 * rate, it drifts between two clients, it cannot be sampled at an arbitrary `t`
 * by a test, and a dropped frame changes it forever. Instead the phase is the
 * **closed-form integral** of the frequency function:
 *
 * ```
 *   f(t)  = SLOW + (FAST - SLOW) * m(t)          m(t) in [0, 1]
 *   phi(t) = integral of f from 0 to t            -- in turns, evaluated directly
 *   swell = shape(phi(t))                         -- the triangle, 0..1
 * ```
 *
 * so `citySwell(1000.25)` is one expression with no history behind it.
 *
 * That constrains what `m` may be, and this is the fork the brief named. A
 * sinusoidal `m` integrates to a cosine and is the textbook answer -- and it
 * would put `Math.sin` and `Math.cos` into a file that both processes evaluate,
 * which is the habit `CLAUDE.md` bans and which section 4 of the first cut
 * claimed this file did not have. Rather than leave a claim in a header that the
 * code no longer honours, **the polynomial path was taken**: `m` is built from
 * the same smoothstep triangle `giverbodies.wave` uses, and a smoothstep triangle
 * is piecewise polynomial, so its integral is piecewise polynomial too and is
 * written out in `tempoIntegral`. The claim stands: there is not a transcendental
 * in this file, and `verifyCityBed` checks the integral against the integrand by
 * differentiating it numerically -- which is the test that would catch an algebra
 * slip in that polynomial, and is worth more than the elegance of a cosine.
 *
 * **Evenly in frequency, or evenly in period?** The band is a factor of ten wide,
 * and the two ways of wandering across it do not sound alike. Uniform in
 * *frequency* spends half its life above 0.055 Hz -- breaths shorter than 18
 * seconds -- because most of a linear frequency band is the fast end; that reads
 * as a pulse. Uniform in *period* is the geometric feel, half the time above 55
 * seconds, which is a tide. The second is what a city does and what the brief
 * wants, and it is what an exponential mapping would give -- and an exponential
 * is exactly the transcendental this file has just refused. So the bias is put in
 * the *modulator* instead: `m` is the smoothstep triangle **cubed**, which is
 * flat for long stretches near zero and only briefly near one, and lands between
 * the two extremes and much nearer the good one. Measured over ten hours:
 *
 * ```
 *                        mean breath   >30 s   >50 s   <15 s
 *   uniform in frequency       18 s     26 %    11 %    41 %
 *   this, cubed                26 s     48 %    31 %    12 %
 *   uniform in period          55 s     78 %    56 %     6 %
 * ```
 *
 * Both ends of the band are still reached rather than approached: the cube keeps
 * `m` in [0, 1] and both terms sit at their own extremes often enough that an
 * hour of sampling sees 0.0100 Hz and 0.0993 Hz. `verifyCityBed` asserts that
 * too, because a band that is never used is a constant that lies.
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
 * is 0.25 Hz, and the swell above it never breathes faster than 0.1 Hz, so the
 * two are more than a factor of two apart at their closest and never beat
 * against each other in a way that reads as rhythm.
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
 * How loud the whole thing is. **0.006, and it was 0.018.**
 *
 * The first cut of this constant was arithmetic: the brief said *"like 35dB ?"*,
 * `10 ^ (-35 / 20)` is 0.0178, and 0.018 was written down as though that settled
 * it. The owner listened to it and said it was three times too loud, which it
 * was.
 *
 * **The conversion was not wrong; it was answering a different question.** A
 * level in decibels has no referent until something plays it -- 35 dB below what,
 * through what, against what else in the mix, on what the player is listening
 * on. What he meant by the number was a *description*: a floor you notice when
 * it stops. What the conversion produced was a floor you can hear on an empty
 * street, which is a different sound and is the one thing section 1 says this
 * must never be.
 *
 * So **this number is an ear measurement now, not a conversion, and it must not
 * be "restored"** to `10 ^ (-35 / 20)` by anybody who finds the arithmetic and
 * assumes a typo. `verifyCityBed` has a line that fails if it is set back to
 * 0.0178, with this paragraph named in the message, because that is exactly the
 * tidy-minded edit this file will attract.
 *
 * Where 0.006 lands: -44.4 dB, a third of what was shipped, and under a third of
 * `ENGINE_BED_GAIN`'s 0.0167 played level -- so the traffic bed is now clearly
 * *over* the city bed rather than beside it, which is the right order. The swell
 * multiplies it between 0 and 1 (see section 4), so what is actually heard runs
 * from silence to 0.006, and the average over a breath is half of that. Against
 * the limiter it is nothing at all: `master` is 0.55, so the peak is
 * 0.55 * 0.006 = **0.0033** against a threshold of 0.398.
 */
export const CITY_BED_GAIN = 0.006;

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
 * The glide is the rate limiter section 4's swell is applied through, and
 * **0.2 s, where it was 0.75.** `setTargetAtTime` is a one-pole, so it is a
 * low-pass on the swell as well as a smoother of it, and the swell is no longer
 * slow: at `CITY_SWELL_FAST_HZ` it completes a breath in ten seconds. Measured
 * attenuation `1 / sqrt(1 + (2 pi f tau)^2)` at the two edges of the band:
 *
 * ```
 *   tau      at 0.01 Hz        at 0.1 Hz            lag at 0.1 Hz
 *   0.75 s   0.9989 (-0.01)    0.9046 (-0.87 dB)    0.70 s
 *   0.35 s   0.9998            0.9767 (-0.21 dB)    0.35 s
 *   0.20 s   0.9999            0.9922 (-0.07 dB)    0.20 s
 *   0.10 s   1.0000            0.9980 (-0.02 dB)    0.10 s
 * ```
 *
 * 0.75 would have eaten a tenth of the swell's depth at the fast end, and a tenth
 * of the depth is precisely the failure the new spec exists to rule out: the bed
 * would stop reaching silence exactly when the breathing got quick, which is
 * where the silence is most of the effect. 0.2 s passes 99.2 % of it, lags by a
 * fifth of a second on a ten-second breath (2 % of a cycle, and a bed has no
 * transient to be late for), and is still twelve frames of averaging at 60 fps --
 * so a stutter in the frame rate cannot show up as a step in the level, which is
 * the job the glide was here to do in the first place. `verifyCityBed` computes
 * that attenuation from the two constants rather than trusting this table.
 */
export const CITY_BED_LOWPASS_HZ = 2000;
export const CITY_BED_GLIDE_S = 0.2;

// --- The swell --------------------------------------------------------------------

/**
 * The band the swell's own frequency wanders in, hertz. The owner's numbers.
 *
 * *"a random frequency that shifts between 0.1 and 0.01hz"* -- breaths of ten
 * seconds at the fast end and a hundred at the slow one, a factor of ten apart.
 * Both ends are reached rather than approached; see section 4 and the check.
 *
 * They are exported because two other things are derived from them and must not
 * be allowed to disagree: the steepest the level can move (`3 * FAST`, which is
 * what `CITY_BED_GLIDE_S` was chosen against) and the longest a breath can take,
 * which is what bounds how long the check has to sample before it can insist the
 * bed has been silent at least once.
 */
export const CITY_SWELL_SLOW_HZ = 0.01;
export const CITY_SWELL_FAST_HZ = 0.1;

/**
 * How the tempo itself wanders: two very slow periods, seconds, and their share.
 *
 * 311 and 173, both prime, so the pair does not come back into step for
 * 53,803 seconds -- fifteen hours -- and the *pattern of speeding up and slowing
 * down* is therefore never a pattern anybody can learn. Minutes rather than
 * seconds because this is the thing the brief calls "random": a tempo that
 * changed every few seconds would read as wow and flutter, and one that changed
 * every hour would read as a fixed rate.
 *
 * The shares add to 1 by construction -- they are a weighted average of two
 * numbers in [0, 1], so the modulator is in [0, 1] and the frequency cannot leave
 * its band no matter what is done to the weights. 0.62 / 0.38 rather than an even
 * split so that neither term is a half the other can cancel: with equal weights
 * the sum has a preferred value in the middle and the extremes get rarer.
 */
export const CITY_TEMPO_PERIODS: readonly number[] = [311, 173];
export const CITY_TEMPO_WEIGHTS: readonly number[] = [0.62, 0.38];
/** Where the second term starts, in turns, so the two do not rise together at t=0. */
const CITY_TEMPO_PHASE: readonly number[] = [0, 0.37];

/**
 * A smooth wave in [0, 1] with period 1: a triangle through a cubic ease.
 *
 * `game/giverbodies.wave` on the unit interval instead of on [-1, 1], restated
 * rather than imported for the reason `SOUND_SPEED` is restated in
 * `game/carsound.ts`: this file must not depend on the giver bodies, the
 * dependency would run the wrong way, and a smoothstep is not a thing either of
 * them can get wrong.
 *
 * It is used for two different jobs here and the shape suits both. As the
 * **level** it reaches exactly 0 and exactly 1 once a cycle and is flat at both,
 * so the bed lingers in silence and lingers at full rather than crossing them --
 * which is what a swell is. As the **tempo modulator** its flatness at the ends
 * is what puts the wander at the ends of the band instead of in the middle of it.
 */
function shape(u: number): number {
  const f = u - Math.floor(u);
  const t = f < 0.5 ? f * 2 : 2 - f * 2;
  return t * t * (3 - 2 * t);
}

/**
 * The modulator: `shape` cubed, in [0, 1]. See section 4 on why it is cubed.
 *
 * The cube is the whole of the "spend more time on long breaths" decision. It
 * costs two multiplies and it is the closest this file can get to an exponential
 * mapping without becoming a file with an exponential in it.
 */
function tempoShape(u: number): number {
  const s = shape(u);
  return s * s * s;
}

/**
 * The area under half a cycle of `tempoShape`, and the running integral of it.
 *
 * This is the closed form section 4 promised, and it is the one piece of algebra
 * in this file that could be silently wrong -- so it is written out rather than
 * simplified, and `verifyCityBed` differentiates it numerically and compares
 * against `citySwellHz`.
 *
 * On the rising half, with `t = 2u`, `shape` is `3t^2 - 2t^3` and its cube is
 * `t^6 (3 - 2t)^3` = `27t^6 - 54t^7 + 36t^8 - 8t^9`. Integrating in `u` (hence
 * the half) gives `(27/7)t^7 - (27/4)t^8 + 4t^9 - (4/5)t^10`, all over two. The
 * falling half is the mirror of it, so the whole cycle is twice the half and any
 * `u` is (whole cycles) + (a mirror or not).
 */
const TEMPO_HALF_AREA = 0.5 * (27 / 7 - 27 / 4 + 4 - 4 / 5);

function tempoRise(t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t7 = t4 * t3;
  const t8 = t7 * t;
  const t9 = t8 * t;
  const t10 = t9 * t;
  return 0.5 * ((27 / 7) * t7 - (27 / 4) * t8 + 4 * t9 - (4 / 5) * t10);
}

/** The integral of `tempoShape` from 0 to `u`, in turns. */
function tempoIntegral(u: number): number {
  const whole = Math.floor(u);
  const f = u - whole;
  const part = f < 0.5 ? tempoRise(2 * f) : 2 * TEMPO_HALF_AREA - tempoRise(2 * (1 - f));
  return whole * 2 * TEMPO_HALF_AREA + part;
}

/**
 * How fast the city is breathing at second `t`, in hertz. 0.01 to 0.1.
 *
 * Exported because it is the honest description of what this file does -- "the
 * swell's frequency wanders" is a claim about *this function*, and a check that
 * could only see the level would have to infer the frequency from zero crossings
 * and would be measuring its own inference. `verifyCityBed` reads it directly.
 */
export function citySwellHz(t: number): number {
  let m = 0;
  for (let i = 0; i < CITY_TEMPO_PERIODS.length; i++) {
    m += CITY_TEMPO_WEIGHTS[i] * tempoShape(t / CITY_TEMPO_PERIODS[i] + CITY_TEMPO_PHASE[i]);
  }
  return CITY_SWELL_SLOW_HZ + (CITY_SWELL_FAST_HZ - CITY_SWELL_SLOW_HZ) * m;
}

/**
 * How many whole breaths have been taken by second `t`, including the fraction.
 *
 * The integral of `citySwellHz` from 0 to `t`, in **turns** rather than radians,
 * because the wave that consumes it has period 1. Evaluated directly from the
 * closed form -- there is no accumulator anywhere in this file, which is what
 * makes `citySwell` a function rather than a state machine, and is what lets the
 * check sample it at t = 3,127.4 s without having simulated the 3,127 seconds in
 * front of it.
 *
 * Strictly increasing, because the frequency is strictly positive. That is
 * asserted rather than assumed: a phase that went backwards would be a swell that
 * ran in reverse for a while, which is not a thing anybody would look for.
 */
export function citySwellPhase(t: number): number {
  let integral = 0;
  for (let i = 0; i < CITY_TEMPO_PERIODS.length; i++) {
    const period = CITY_TEMPO_PERIODS[i];
    const phase = CITY_TEMPO_PHASE[i];
    integral += CITY_TEMPO_WEIGHTS[i] * period
      * (tempoIntegral(t / period + phase) - tempoIntegral(phase));
  }
  return CITY_SWELL_SLOW_HZ * t + (CITY_SWELL_FAST_HZ - CITY_SWELL_SLOW_HZ) * integral;
}

/**
 * How loud the city is right now, as a fraction of `CITY_BED_GAIN`. **0 to 1.**
 *
 * *"swell from 0-100% vol"*: at the bottom of a breath this returns exactly zero
 * and the bed is silent, at the top it returns exactly one. See section 4 for why
 * that is the spec and what changed from the first cut.
 *
 * Pure in `t` and in nothing else -- no state, no clock of its own, no
 * `Math.random` -- which is what lets `verifyCityBed` sample an hour of it in a
 * boot list. `t` is seconds; the caller passes `ctx.currentTime`, so it starts at
 * zero when the context does, and that is fine: there is no wrong phase for a
 * thing with no event in it.
 */
export function citySwell(t: number): number {
  return shape(citySwellPhase(t));
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

  // --- The swell: it must reach both ends, and never leave them.
  //
  // 0 and 1 exactly, not "about" -- `shape` is flat at both, so the bed sits in
  // silence and sits at full rather than crossing them, and a swell that came out
  // 0.05..0.95 would be one somebody had put a smoother or a bias in front of.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 36000; i++) {
    const v = citySwell(i / 10);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo < 0 || hi > 1) f.push(`citySwell leaves [0, 1]: ${lo} .. ${hi}`);
  if (lo > 1e-6) f.push(`citySwell never reaches silence: its floor over an hour is ${lo.toExponential(2)}`);
  if (hi < 1 - 1e-6) f.push(`citySwell never reaches full: its ceiling over an hour is ${hi.toFixed(6)}`);

  // And it reaches both **often**, which is the part a player experiences. The
  // slowest breath the band allows is 1 / CITY_SWELL_SLOW_HZ = 100 s, so every
  // window of 150 s must contain a whole cycle -- a silence and a peak -- wherever
  // it is taken. Measured over the first hour: no window has a floor above
  // 2.2e-6 or a ceiling below 0.999999.
  {
    const window = 150;
    let worstFloor = 0;
    let worstCeil = 1;
    for (let w = 0; w < 24; w++) {
      const t0 = w * window;
      let a = Infinity;
      let b = -Infinity;
      for (let i = 0; i <= window * 20; i++) {
        const v = citySwell(t0 + i / 20);
        if (v < a) a = v;
        if (v > b) b = v;
      }
      if (a > worstFloor) worstFloor = a;
      if (b < worstCeil) worstCeil = b;
    }
    if (worstFloor > 1e-3) f.push(`a ${window}s window never went quiet: floor ${worstFloor.toExponential(2)}`);
    if (worstCeil < 0.999) f.push(`a ${window}s window never reached full: ceiling ${worstCeil.toFixed(4)}`);
  }

  // --- The tempo. Inside the owner's band, and using the whole of it.
  //
  // Two separate claims. Staying inside is structural -- the modulator is a
  // weighted average of two numbers in [0, 1] -- and is checked anyway, because a
  // weight edit that broke the average would take the frequency out of the band
  // and produce a bed that pulsed. *Using* the band is not structural at all: two
  // slow terms that never coincided would leave the ends of it unvisited, and a
  // constant nobody ever reaches is a constant that lies. Measured over an hour:
  // 0.0100 Hz to 0.0993 Hz.
  {
    let fastest = 0;
    let slowest = Infinity;
    for (let i = 0; i <= 14400; i++) {
      const v = citySwellHz(i / 4);
      if (v > fastest) fastest = v;
      if (v < slowest) slowest = v;
    }
    if (slowest < CITY_SWELL_SLOW_HZ - 1e-12 || fastest > CITY_SWELL_FAST_HZ + 1e-12) {
      f.push(`citySwellHz leaves its band: ${slowest.toFixed(5)} .. ${fastest.toFixed(5)} Hz`);
    }
    const span = CITY_SWELL_FAST_HZ - CITY_SWELL_SLOW_HZ;
    if (slowest > CITY_SWELL_SLOW_HZ + span * 0.02) {
      f.push(`the tempo never slows to the bottom of its band: ${slowest.toFixed(5)} Hz in an hour`);
    }
    if (fastest < CITY_SWELL_FAST_HZ - span * 0.15) {
      f.push(`the tempo never reaches the top of its band: ${fastest.toFixed(5)} Hz in an hour`);
    }
    let weights = 0;
    for (const w of CITY_TEMPO_WEIGHTS) weights += w;
    if (Math.abs(weights - 1) > 1e-12) {
      f.push(`CITY_TEMPO_WEIGHTS sum to ${weights}, not 1: the tempo can leave its band`);
    }
    if (CITY_TEMPO_WEIGHTS.length !== CITY_TEMPO_PERIODS.length) {
      f.push('CITY_TEMPO_WEIGHTS and CITY_TEMPO_PERIODS are different lengths');
    }
  }

  // --- The phase really is the integral of the frequency.
  //
  // The one piece of algebra in this file that a careful reader cannot check by
  // eye: `tempoIntegral` is a tenth-degree polynomial written out by hand, and a
  // wrong coefficient in it would produce a swell that still looked plausible --
  // bounded, smooth, aperiodic -- while breathing at a rate that had nothing to do
  // with the band above. Differentiating the closed form numerically and comparing
  // it against the integrand is the whole test, and it agrees to 4e-10.
  {
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const t = i * 1.7 + 0.13;
      const h = 1e-4;
      const d = (citySwellPhase(t + h) - citySwellPhase(t - h)) / (2 * h);
      const want = citySwellHz(t);
      const err = d > want ? d - want : want - d;
      if (err > worst) worst = err;
    }
    if (worst > 1e-6) {
      f.push(`citySwellPhase does not integrate citySwellHz: off by ${worst.toExponential(2)} Hz`);
    }
    // Strictly increasing, because the frequency is strictly positive. A phase
    // that went backwards is a swell running in reverse.
    let prev = citySwellPhase(0);
    for (let i = 1; i <= 20000; i++) {
      const v = citySwellPhase(i * 0.25);
      if (!(v > prev)) { f.push(`citySwellPhase stalls or reverses at t=${i * 0.25}`); break; }
      prev = v;
    }
  }

  // --- Pure in t. The same second twice is the same number, and the answer
  // cannot depend on what was asked before it: a cached state, an accumulator, a
  // stray `Math.random` or a `Date.now` all fail here. This is the line that
  // would catch somebody "optimising" the closed-form phase into a running sum.
  for (let i = 0; i < 500; i++) {
    const t = i * 3.7;
    const a = citySwell(t);
    citySwell(t * 13 + 1);
    const b = citySwell(t);
    if (a !== b) f.push(`citySwell is not pure at t=${t}: ${a} then ${b}`);
  }

  // --- No lurch, against a bound derived from the band rather than typed in.
  //
  // `shape` climbs at most 3 per turn, and a turn takes at least
  // 1 / CITY_SWELL_FAST_HZ seconds, so the level cannot move faster than
  // 3 * CITY_SWELL_FAST_HZ a second -- 0.3, with the band as it stands. Measured
  // over ten minutes at 100 Hz the worst first difference is 0.00245 against a
  // bound of 0.00300, and over a hundred minutes it is 0.00298: the bound is
  // attained rather than approximated, because the fast end of the band really is
  // reached and the wave really does run at its steepest there. Which is also why
  // the margin here is 2 % and not 50 % -- there is nothing slack about it.
  const slope = 3 * CITY_SWELL_FAST_HZ;
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
    if (worst > slope * step * 1.02) {
      f.push(`citySwell steps: ${worst.toExponential(3)} in ${step}s, bound ${(slope * step).toExponential(3)}`);
    }
  }

  // --- No period under ten minutes.
  //
  // Every candidate shift from half a second to ten minutes, at a tenth of a
  // second, scored against **how far the swell could have moved in that shift**
  // rather than against a fixed number. That normalisation is the whole test: a
  // shift of a tenth of a second cannot disagree by much whatever the wave is
  // doing, so a flat threshold would report every short candidate as a repeat and
  // nothing would have been checked. What a real period looks like is a shift the
  // wave *could* have wandered over and did not. The measured worst case over the
  // whole range is 0.70 of what was available, at 3 s; a quarter is the line.
  {
    let found = 0;
    let foundAt = 0;
    let tightest = Infinity;
    for (let p10 = 5; p10 <= 6000; p10++) {
      const period = p10 / 10;
      const possible = Math.min(1, slope * period);
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
    // The primes are the reason it does not: the two tempo terms come back into
    // step only after their product. An edit that gives them a common factor
    // shortens that by the factor, and this says so in one line rather than as a
    // mysterious near-repeat above.
    for (let i = 0; i < CITY_TEMPO_PERIODS.length; i++) {
      for (let j = i + 1; j < CITY_TEMPO_PERIODS.length; j++) {
        let a = CITY_TEMPO_PERIODS[i];
        let b = CITY_TEMPO_PERIODS[j];
        while (b !== 0) { const r = a % b; a = b; b = r; }
        if (a !== 1) {
          f.push(`tempo periods ${CITY_TEMPO_PERIODS[i]} and ${CITY_TEMPO_PERIODS[j]} share a factor of ${a}`);
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
    // measurement -- this is the floor, and the traffic sits on top of it.
    const trafficBed = 0.1 / 6;
    if (!(CITY_BED_GAIN < trafficBed)) {
      f.push(`CITY_BED_GAIN ${CITY_BED_GAIN} is not under the traffic bed's ${trafficBed.toFixed(4)}`);
    }
    // **The restore guard.** The number is an ear measurement and the arithmetic
    // it replaced is still sitting in its header where somebody will find it. This
    // is the line that stops "35 dB means 0.0178, this must be a typo".
    if (Math.abs(CITY_BED_GAIN - 0.0178) < 1e-3 || Math.abs(CITY_BED_GAIN - 0.018) < 1e-4) {
      f.push('CITY_BED_GAIN has been restored to the dB conversion; read its header -- 0.006 is an ear measurement, not arithmetic');
    }
    // A floor, with room either side of it: quiet enough to be under everything
    // and not so quiet it is a constant that does nothing.
    if (!(CITY_BED_GAIN > 0.002 && CITY_BED_GAIN < 0.012)) {
      f.push(`CITY_BED_GAIN ${CITY_BED_GAIN} is outside the range an ear settled on: 0.002 to 0.012`);
    }
    if (!(CITY_BED_LOWPASS_HZ >= 1000 && CITY_BED_LOWPASS_HZ <= 4000)) {
      f.push(`CITY_BED_LOWPASS_HZ ${CITY_BED_LOWPASS_HZ} is not a distant-city corner`);
    }
    if (!(CITY_BED_SEAM_S > 0 && CITY_BED_SEAM_S < CITY_BED_SECONDS / 4)) {
      f.push(`CITY_BED_SEAM_S ${CITY_BED_SEAM_S} is not a small fold at the head of a ${CITY_BED_SECONDS}s loop`);
    }
  }

  // --- The glide, against the fastest breath the band allows.
  //
  // `setTargetAtTime` is a one-pole, so it attenuates the swell as well as
  // smoothing it: `1 / sqrt(1 + (2 pi f tau)^2)`. Both halves of this matter and
  // they pull opposite ways. Too slow and the fast end of the band is flattened --
  // at the 0.75 s this shipped with, a ten-second breath arrives at 0.905 of its
  // depth and the bed stops reaching silence, which is the whole point of the
  // spec. Too quick and the follower stops covering a frame-rate stutter, and a
  // stutter in a gain is a step. The table is in `CITY_BED_GLIDE_S`; this computes
  // it from the constants so the table cannot go stale in secret.
  {
    const w = 6.283185307179586 * CITY_SWELL_FAST_HZ * CITY_BED_GLIDE_S;
    const passed = 1 / Math.sqrt(1 + w * w);
    if (passed < 0.99) {
      f.push(`CITY_BED_GLIDE_S ${CITY_BED_GLIDE_S}s passes only ${passed.toFixed(3)} of a ${(1 / CITY_SWELL_FAST_HZ).toFixed(0)}s breath: the bed will stop reaching silence`);
    }
    // Three frames at 60 fps is the floor: below that the follower is not
    // averaging anything and a dropped frame reaches the gain unsmoothed.
    if (!(CITY_BED_GLIDE_S >= 0.05)) {
      f.push(`CITY_BED_GLIDE_S ${CITY_BED_GLIDE_S}s is under three frames; a frame-rate stutter will step the level`);
    }
  }

  return f;
}
