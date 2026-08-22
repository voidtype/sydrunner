/**
 * What the traffic sounds like, decided here and made of oscillators next door.
 *
 * The owner's brief was four words -- *"cars need to make car noises"* -- and the
 * silence it names is total: your own stolen Camry, the two cars the other
 * players are in, and the six thousand deterministic ambient cars all move
 * through Sydney without a sound. A city whose only voices are a siren, a rave
 * and a magpie is not a quiet city; it is a city with the traffic muted, which
 * is a stranger thing to hear than either.
 *
 * This file is the **schedule** half of that, and `game/audio.ts` is the
 * synthesis half. The split is `game/rail-audio.ts`' exactly, for that file's
 * stated reason: this one computes *what should be audible* -- which cars, how
 * loud, at what pitch, panned where -- and knows nothing about a biquad, so the
 * Bun server can compile it and `verifyCarSound` can run in both boot lists with
 * no `AudioContext` within a mile of it. Every number below is a level, a range
 * or a ratio. Not one of them is in hertz; the hertz live in `audio.ts` beside
 * the oscillator they set, and what crosses the boundary is a **rate** -- a
 * dimensionless multiple of an idling engine.
 *
 * ---------------------------------------------------------------------------
 * 1. THREE TIERS, AND THE THIRD ONE IS THE WHOLE PROBLEM.
 *
 *   - **Your own car.** One voice, no distance, no Doppler -- you are inside it.
 *     It is the loudest thing in the mix, it revs when you accelerate, and it
 *     chirps when you throw the wheel over at speed.
 *   - **The cars other players are driving.** The same voice, attenuated, panned
 *     and Doppler-shifted. There are at most fifteen of them in a room and
 *     usually none, so they need no special handling at all: they go through the
 *     pool below like anything else.
 *   - **The ambient fleet.** `game/traffic.ts` will hand you a hundred cars
 *     inside two hundred metres in the CBD, and a hundred engine voices is not a
 *     city, it is a denial-of-service against the audio thread. So the fleet is
 *     answered in two parts: the nearest `ENGINE_VOICES` moving cars get a real
 *     pooled voice each, and **everything else is one number** -- a count, which
 *     drives a single faint rumble. See sections 3 and 5.
 *
 * The dividing line between the second tier and the third is deliberately
 * nothing at all. A car with a player in it and a car the timetable is driving
 * make the same noise, because they are the same car -- `world/drivencars.ts`
 * exists to make sure the one you steal does not stop looking like traffic, and
 * it would be an odd thing for it to stop *sounding* like traffic at the moment
 * somebody got in.
 *
 * ---------------------------------------------------------------------------
 * 2. WHY THIS IS NOT A SECOND SWEEP OVER THE CITY.
 *
 * The obvious implementation is a `forEachCarNear` of its own at the audible
 * range, once a frame. It is also the one `world/cars.ts` argues against three
 * times in its own comments, about the headlights, about the near-field models
 * and about the stolen-car suppression: *"this loop already visits every car in
 * view, and a second pass that had to agree with it"* is how two systems end up
 * disagreeing about which cars exist.
 *
 * So the offers arrive from inside the draw loop, through `EngineSink`, exactly
 * as the headlights and the model claims do. `TrafficMovers.update` already
 * poses every car within `TRAFFIC_DRAW_RADIUS` and already knows which ones
 * somebody has stolen; this takes a copy of the six numbers it needs and adds a
 * squared-distance test per car. The measured alternative was a fresh 170 m walk
 * costing about a sixth of the traffic section again, for information that had
 * just been computed twenty lines earlier.
 *
 * The one thing it does **not** inherit is the view latch. A car that
 * `game/viewlatch.ts` is declining to draw because it materialised inside your
 * field of view is still a car, and the whole point of engine noise is that it
 * reaches you from behind. See the offer site in `world/cars.ts`.
 *
 * ---------------------------------------------------------------------------
 * 3. THE POOL, AND WHY A VOICE IS A SLOT RATHER THAN A CAR.
 *
 * `ENGINE_VOICES` chains are built once and run for the session. They are not
 * created per car and never could be: a car crosses the audible range in four
 * seconds at 44 m/s, so a voice-per-car policy is an `OscillatorNode` allocation
 * every few hundred milliseconds, forever, and a garbage collector pause in a
 * 16.7 ms frame is a stutter you can see.
 *
 * Instead a **slot** owns a chain and rents it to whichever car is currently
 * near enough. The handover is the delicate part, and there are three rules:
 *
 *   - **Nothing is ever restarted.** The chain's oscillators and its noise loop
 *     run continuously from the first frame anything is audible; a handover
 *     changes a frequency and a gain and nothing else, so there is no transient
 *     to click. This is why the pitch crosses the boundary as a *rate* rather
 *     than as a note to play.
 *   - **A handover is a dip, not a cut.** `HANDOVER_S` out, key change,
 *     `HANDOVER_S` back in. Around a quarter of a second, and it happens at the
 *     *outer* edge of the set by construction -- the slot being reassigned is the
 *     one holding the furthest of the seven, which is also the quietest -- so
 *     what is actually heard is a faint thing getting fainter.
 *   - **The incumbent is favoured.** Without hysteresis, two cars a metre apart
 *     at the boundary swap the slot every few frames and the dip becomes a
 *     tremolo. `HANDOVER_MARGIN_M` is the distance a newcomer has to beat the
 *     sitting tenant by, applied when the candidate set is ranked rather than
 *     when it is resolved, which makes it one subtraction instead of a second
 *     pass.
 *
 * The pool cannot exceed its size, and that is structural rather than checked: a
 * mix has exactly `ENGINE_VOICES` voices, they are the same objects every frame,
 * and a car that is not holding one is not in the mix at all.
 *
 * ---------------------------------------------------------------------------
 * 4. DOPPLER, WHICH IS ONE DOT PRODUCT AND IS MOST OF THE FEELING.
 *
 * A car going past at speed is the single most recognisable sound a street
 * makes, and what makes it recognisable is not the engine -- it is the pitch
 * falling as the car passes. The physics is `f' = f (1 + v/c)` with `v` the rate
 * the gap is closing, which is `heatUpdate`'s helicopter model exactly, and the
 * rate is one dot of the relative velocity with the unit vector to the listener.
 *
 * It is exaggerated by `DOPPLER_GAIN` because the honest amount is too polite:
 * a 44 m/s pass swings the pitch by 12.8 % either way, which reads as a wobble.
 * At 1.6 it is 20.5 % either way -- about a tone and a half up on approach and
 * the same down on departure, a total sweep of a fifth -- which is what a car
 * going past a bus stop actually sounds like from the bus stop.
 *
 * The clamp is set to bite at exactly `DRIVE_TOP_SPEED` of closing rate, and the
 * reason it is needed at all is that two cars can close on each other at *twice*
 * the top speed. Unclamped, a head-on pass at 88 m/s would double the sweep and
 * turn a car into a cartoon slide whistle. `verifyCarSound` asserts the clamp
 * holds at 44 and still holds at 88.
 *
 * ---------------------------------------------------------------------------
 * 5. THE BED IS A COUNT, AND IT IS THE CHEAPEST THING HERE.
 *
 * Beyond the seven, a car contributes exactly one integer: whether it is moving
 * and within `BED_RANGE`. That count drives `bedLevel`, a saturating curve on one
 * broadband rumble. It is not spatial, it has no pitch and it does not move,
 * which is right -- what you hear from four streets of traffic in a real city is
 * not forty cars, it is *a level*, and the moment you can pick an individual car
 * out of it you are close enough for the pool to have given it a voice.
 *
 * The count is the thing that makes Parramatta Road sound different from a cul
 * de sac in Hunters Hill without either of them costing a node, and it is the
 * one part of this file that is straightforwardly rule 1 of `DESIGN.md`: it is
 * loud where the baked road network says Sydney is busy.
 *
 * ---------------------------------------------------------------------------
 * 6. THE LISTENER IS ONE FRAME BEHIND, ON PURPOSE, AND ONLY FOR RANKING.
 *
 * `offer` runs inside the draw loop and `end` runs later in the frame, which
 * means the offers are ranked against **last** frame's listener position. That is
 * deliberate and it is the whole reason the sink can live where it lives.
 *
 * What matters is *what the staleness is used for*. It picks which seven cars are
 * nearest -- a decision that at 44 m/s is 0.73 m out of date and cannot change
 * the answer for anything but a tie. Every quantity you can actually hear --
 * distance gain, Doppler, pan -- is recomputed in `end` from the fresh listener,
 * so nothing audible is ever a frame late. Before the first `end` the field is
 * not `ready` and declines every offer, which costs one silent frame at boot.
 */

import { DRIVE_ACCELERATION, DRIVE_TOP_SPEED } from './driving.ts';

// --- How far, how many, how loud ----------------------------------------------

/**
 * How many pooled voices the ambient fleet gets. **Seven.**
 *
 * The brief asked for six to eight and the argument for the middle of it is what
 * a street actually holds. Standing on a two-lane arterial in Marrickville, the
 * cars inside `ENGINE_RANGE` that are moving number about five; on Parramatta
 * Road at a green light it is nearer thirty. Seven covers the first case
 * completely -- every car you can see has its own voice -- and in the second it
 * covers the ones close enough to pick out, with the other twenty-three going
 * into the bed where they belong.
 *
 * The cost is stated where it is paid: about ten `AudioNode`s a voice, so seventy
 * for the pool. See `CombatAudio.engineBuild`.
 */
export const ENGINE_VOICES = 7;

/**
 * How far one car's engine carries, metres, and where it is half as loud.
 *
 * 95 m is a block and a half, and it is chosen against the two neighbours in this
 * project rather than against a physical measurement: `SIREN_RANGE` is 300
 * because a siren's whole job is to be heard before it is seen, and
 * `ANNOUNCE_RANGE` is 110 because a platform announcement should not narrate the
 * next street. An engine is the quietest of the three and the most numerous, and
 * the failure mode of a generous range here is not "too loud" -- it is that the
 * nearest seven cars are all 80 m away and the street immediately around you is
 * represented by whichever of them happened to win a slot.
 *
 * The half-distance is `bark`'s 22 pulled in slightly, which puts the level at
 * the gate at 0.17 of the level at the source -- the same near-inaudible point
 * `RAVE_AUDIBLE_RANGE` and `ANNOUNCE_RANGE` both cut at, so nothing pops when a
 * car crosses out.
 */
export const ENGINE_RANGE = 95;
export const ENGINE_HALF_DISTANCE = 19;

/**
 * How far the bed hears, metres.
 *
 * Nearly twice the engine range, because the bed is the *sum* of things you
 * cannot individually hear and a sum reaches further than its terms. 170 m is
 * about four city blocks, which is the distance at which a busy road stops
 * contributing to the noise floor of the street you are standing in.
 *
 * It is also the outer gate on the whole file: a car further than this is
 * rejected by one squared comparison and costs nothing else. `TRAFFIC_DRAW_RADIUS`
 * is 420, so about five sixths of the cars the draw loop offers are dismissed on
 * that line.
 */
export const BED_RANGE = 170;

/**
 * Below this, a car is not making engine noise worth a voice, m/s.
 *
 * A tenth of a metre a second rather than zero, because `game/traffic.ts` ramps a
 * car continuously out of a bay and there is no instant at which it is
 * definitively moving. The three quarters of the fleet that are *parked* -- both
 * parked stages report exactly zero -- fall out here, which is the point: a
 * parked car has its engine off, and a street where every stationary car idles
 * is a street with a fault.
 *
 * The bed uses a higher bar. A car creeping at half a metre a second is one you
 * can see moving and cannot hear from two streets away.
 */
export const VOICE_MOVING = 0.1;
export const BED_MOVING = 1.5;

/**
 * How many moving cars the bed needs before it is half as loud as it can get.
 *
 * Twelve. `bedLevel` is `n / (n + BED_HALF)`, so four cars is a quarter of the
 * level, twelve is a half, thirty-six is three quarters and it never reaches one
 * -- which is the right shape for a count, because the difference between forty
 * cars and eighty cars in earshot is nothing you can hear and the difference
 * between two and six is the difference between a lane and a road.
 */
export const BED_HALF = 12;

/**
 * How long a slot takes to hand its chain from one car to the next, seconds.
 *
 * 0.11 out and 0.11 back. Short enough that a car arriving in the set is audible
 * within a quarter of a second of getting there -- any longer and a car
 * overtaking you fades in *behind* where it is -- and long enough that the
 * gain change is a slide rather than a step. A step in a running gain is a click,
 * which is the one artefact this whole arrangement exists to avoid.
 */
export const HANDOVER_S = 0.11;

/**
 * How much closer a newcomer has to be than the sitting tenant to take its slot,
 * metres.
 *
 * Eight, and without it the boundary of the set chatters: two cars in adjacent
 * lanes at 70 m trade places every few frames as their paths converge and
 * diverge, and every trade costs a 0.22 s dip. Eight metres is two car lengths,
 * which is longer than any wobble a lane change produces and shorter than the
 * distance a car covers in half a second, so a genuine overtake still swaps
 * promptly.
 *
 * Applied as a *bonus to the incumbent* when the candidate set is ranked, which
 * is one subtraction inside a loop that is already computing a distance. The
 * alternative -- resolving the set and then re-examining the losers -- is a
 * second pass over the same seven records for the same answer.
 */
export const HANDOVER_MARGIN_M = 8;

/**
 * The speed of sound, m/s, and how much the Doppler shift is exaggerated.
 *
 * 343 is restated rather than imported for `BOOM_SOUND_SPEED`'s reason: this file
 * must not import the sound system, the dependency runs the other way, and the
 * speed of sound is not a constant either of them can get wrong.
 *
 * `DOPPLER_GAIN` is 1.6 against `ROTOR_DOPPLER`'s 1, and the difference is the
 * difference between the two machines. A helicopter's orbit closes at 40 m/s at
 * the worst and the shift is a continuous cue you hear for a minute; a car's pass
 * is over in a second and a half and the shift is the entire event. See section 4.
 */
export const SOUND_SPEED = 343;
export const DOPPLER_GAIN = 1.6;

/**
 * The clamp, either side of unity, set to bite at exactly `DRIVE_TOP_SPEED`.
 *
 * Written as the expression rather than as 0.205 so it cannot drift from the top
 * speed the way `SHATTER_STRENGTH` did: the number that has to stay put is "one
 * car at full noise going past a standing listener is the loudest legal shift",
 * and a bare literal here would have been silently wrong the day the top speed
 * doubled. Two cars closing head-on reach twice this and are clamped, which is
 * what the constant is for.
 */
export const DOPPLER_MAX = (DOPPLER_GAIN * DRIVE_TOP_SPEED) / SOUND_SPEED;

/**
 * The top of the pitch sweep, as a multiple of an idling engine.
 *
 * 6.8. `audio.ENGINE_IDLE_HZ` is a four-cylinder four-stroke at about 810 rpm, so
 * this is 5,500 rpm -- a car being driven hard and not one being destroyed, which
 * is the right top end for a game where 44 m/s is reached on a straight and held.
 *
 * The *shape* between the two is `engineRate` and it is deliberately not linear;
 * see that function.
 */
export const ENGINE_RATE_TOP = 6.8;

/**
 * What an engine is doing when nothing is asked of it, and how much of the load
 * comes from speed alone.
 *
 * `load` is 0..1 and drives brightness rather than level -- an engine under
 * throttle does not get much louder, it gets *harsher*, because the exhaust pulse
 * sharpens and the induction roar arrives. A car coasting at 40 m/s is still
 * working against the air, which is `LOAD_FROM_SPEED`; a car pulling away from
 * the lights is barely moving and is working very hard indeed, which is the
 * acceleration term.
 */
export const IDLE_LOAD = 0.12;
export const LOAD_FROM_SPEED = 0.28;
export const LOAD_FROM_ACCEL = 0.72;

/**
 * How fast the rev envelope follows, seconds.
 *
 * Asymmetric, because a throttle is: an engine picks up in a tenth of a second
 * and falls away over most of a second, and a symmetric follower makes every
 * gear change sound like a synthesiser filter. These are time constants for an
 * exponential approach, `driving.ts`' own style of smoothing.
 */
export const REV_ATTACK_S = 0.09;
export const REV_RELEASE_S = 0.45;

/**
 * When the tyres start to complain: the speed it takes and the lock it takes.
 *
 * A **hint**, and the word is the brief's. There is no tyre model in this project
 * and there should not be one for a sound: `driving.shapeDriveSteering` already
 * decides how much of the wheel a car at speed is allowed, and all this does is
 * notice when a player is using most of it fast. Below 9 m/s nothing squeals
 * because a car at walking pace does not, and below 0.55 of full lock nothing
 * squeals because ordinary cornering is not a skid.
 */
export const SKID_SPEED_MIN = 9;
export const SKID_STEER_MIN = 0.55;

/**
 * How wide the pool pans, -1..1.
 *
 * 0.75 rather than 1, so a car passing on your left is unmistakably on your left
 * and is still *in* the mix. A hard-panned voice on headphones reads as a fault
 * in one ear, which is the same lesson `ROTOR_ORBIT_HZ`'s pan learned about a
 * helicopter, and unlike the helicopter there can be seven of these at once.
 */
export const PAN_WIDTH = 0.75;

// --- What crosses the boundary --------------------------------------------------

/** One engine's worth of instruction to the sound system. */
export interface EngineVoice {
  /** Nothing is running on this voice when false. Every other field is stale. */
  active: boolean;
  /**
   * Which car this is -- `CarPose.identity`, so a schedule car's stable hash or a
   * `CarField` record id.
   *
   * A change means the slot has been rented to somebody else, and the sound
   * system does not have to notice: the gain has already been taken to zero and
   * brought back by the fade below, so the key is here for the checks and for the
   * dev overlay rather than for the synthesis.
   */
  key: number;
  /**
   * The firing frequency as a multiple of an idling engine, Doppler included.
   *
   * A rate rather than hertz so that this file owns the *curve* -- which is a
   * design decision, tested by `verifyCarSound` -- and `game/audio.ts` owns the
   * engine, which is a synthesis decision. Between about 0.8 (a slow car
   * receding) and 8.2 (a fast car closing).
   */
  rate: number;
  /** How hard it is working, 0..1. Brightness, not level. See `IDLE_LOAD`. */
  load: number;
  /** Final level, 0..1, fade included. `game/audio.ts` scales it to its own bus. */
  gain: number;
  /** Where it is across the head, -1..1. */
  pan: number;
}

/**
 * What the sound system is handed each frame, exactly as `RaveMix` and
 * `RailAnnounceMix` are.
 *
 * Built once by `createCarSoundMix` and refilled in place forever after. Nothing
 * in this file allocates after construction, which is not tidiness: this runs at
 * 60 Hz over up to five hundred offers and it is the only audio in the project
 * that does.
 */
export interface CarSoundMix {
  /** The car the local player is in. Inactive when they are on foot. */
  own: EngineVoice;
  /** The local car's tyres, 0..1. See `SKID_SPEED_MIN`. */
  skid: number;
  /** The pool. Always `ENGINE_VOICES` long and always the same objects. */
  voices: EngineVoice[];
  /** The city, 0..1. See section 5. */
  bed: number;
  /** Whether anything at all is audible, so the rig can be torn down when not. */
  wanted: boolean;
}

/**
 * Where the ears are, and what the car under them is doing.
 *
 * A filled record rather than eleven arguments, on `polairView`'s pattern in
 * `main.ts`: it is constructed once and written in place, and a call site that
 * forgets a field gets a stale number rather than a shifted argument list.
 */
export interface CarListener {
  x: number;
  y: number;
  z: number;
  /** How fast the listener is moving, m/s, in the world plan. Doppler needs both ends. */
  vx: number;
  vz: number;
  /** Where the camera looks, as a unit vector in the plan. The pan is measured off it. */
  fwdX: number;
  fwdZ: number;
  /** The frame's delta, seconds. Drives the fades and the rev envelopes. */
  dt: number;
  /** The `CarField` record id of the car the local player is driving, or 0. */
  ownCar: number;
  /**
   * The local car's **signed** speed along its heading, m/s.
   *
   * `CombatantState.carSpeed`, which is the number this client's own integrator
   * produced this frame -- not the one on the record and not the one on the pose.
   * The difference is a frame of lag on the thing the player is holding a key
   * down to change, which is the one place in this file where lag would be felt.
   */
  ownSpeed: number;
  /** The wheel, -1..1. `DriveSteering.right`. */
  ownSteer: number;
}

export function createCarListener(): CarListener {
  return {
    x: 0, y: 0, z: 0, vx: 0, vz: 0, fwdX: 0, fwdZ: -1,
    dt: 0, ownCar: 0, ownSpeed: 0, ownSteer: 0,
  };
}

function createVoice(): EngineVoice {
  return { active: false, key: 0, rate: 1, load: IDLE_LOAD, gain: 0, pan: 0 };
}

export function createCarSoundMix(): CarSoundMix {
  const voices: EngineVoice[] = [];
  for (let i = 0; i < ENGINE_VOICES; i++) voices.push(createVoice());
  return { own: createVoice(), skid: 0, voices, bed: 0, wanted: false };
}

/**
 * Where the offers come from. `CarLightSink`'s shape, and for its reason.
 *
 * `begin` returning false is the whole of the "audio is off, or nothing has told
 * this thing where the player is yet" case, and costs the draw loop one
 * comparison a frame rather than a call per car.
 */
export interface EngineSink {
  begin(): boolean;
  /**
   * One car, in world coordinates. `dirX`/`dirZ` is its unit heading and `speed`
   * is its magnitude along that heading, which between them are its velocity --
   * the two numbers Doppler needs and the two `CarPose` already carries.
   */
  offer(key: number, x: number, y: number, z: number, dirX: number, dirZ: number, speed: number): void;
}

// --- The curves, which are the design and are what the check tests --------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Speed to firing rate. **Monotonic, bounded, and deliberately not linear.**
 *
 * A linear map spends most of its range where a player almost never is. Sydney's
 * streets are 30 m of straight between corners; the speeds actually held are 5 to
 * 20 m/s, and a linear curve gives that band a quarter of the pitch sweep while
 * reserving three quarters for a motorway nobody is on.
 *
 * So it is a blend, 65 % square root and 35 % linear:
 *
 *     10 m/s   rate 2.5    pulling away from lights, unmistakably accelerating
 *     20 m/s   rate 3.7    the speed a suburban street is driven at
 *     30 m/s   rate 4.9    an arterial
 *     44 m/s   rate 6.8    flat out
 *
 * A pure square root would have been better still in the low band and is rejected
 * for one reason: its slope at zero is infinite, so the first centimetre of
 * movement jumps the pitch by a fifth and a car rolling forward at a red light
 * blips. The linear third is there to hold the origin down.
 *
 * `Math.sqrt` rather than `Math.pow` on `CLAUDE.md`'s determinism rule -- this
 * function runs in the Bun boot list as well as the browser one, and `pow` is on
 * the list of things the two engines are not required to agree about.
 */
export function engineRate(speed: number): number {
  const s = speed < 0 ? -speed : speed;
  const u = clamp01(s / DRIVE_TOP_SPEED);
  const shaped = 0.35 * u + 0.65 * Math.sqrt(u);
  return 1 + (ENGINE_RATE_TOP - 1) * shaped;
}

/**
 * Distance to level, `bark`'s hyperbola. Monotonic down, 1 at the ear, cut at the
 * range so a car in the next suburb is not a running node's worth of nothing.
 */
export function engineGain(distance: number): number {
  const d = distance > 0 ? distance : 0;
  if (d >= ENGINE_RANGE) return 0;
  return 1 / (1 + d / ENGINE_HALF_DISTANCE);
}

/**
 * How hard an engine is working, 0..1, from what it is doing rather than from
 * what anybody pressed.
 *
 * **Derived, not read.** `world/drivencars.BRAKE_THRESHOLD` makes the identical
 * choice about brake lights and states the reason: "the player is holding S" is
 * wrong in the case that matters, and the observable -- the speed actually
 * changing -- catches every cause for free. Here it buys something more: an
 * ambient car has no keyboard at all, and a rev derived from acceleration means
 * the timetable's cars pull away from a red light with exactly the sound the
 * player's car makes doing the same thing, out of one function.
 *
 * `DRIVE_ACCELERATION` is the normaliser because it is the most a car can ask of
 * itself. Braking is not negative load -- an engine on the overrun is quieter but
 * it is not *below* idle -- so the acceleration term is clamped at zero from
 * below and the speed term holds the floor up.
 */
export function engineLoad(speed: number, accel: number): number {
  const s = speed < 0 ? -speed : speed;
  const a = accel > 0 ? accel : 0;
  return clamp01(
    IDLE_LOAD +
      LOAD_FROM_SPEED * clamp01(s / DRIVE_TOP_SPEED) +
      LOAD_FROM_ACCEL * clamp01(a / DRIVE_ACCELERATION),
  );
}

/**
 * Closing rate to pitch multiplier. See section 4.
 *
 * `closing` is positive inbound, which is `HeatMix.rotorClosing`'s convention and
 * is the one this project has already chosen once.
 */
export function dopplerRate(closing: number): number {
  const shift = (DOPPLER_GAIN * closing) / SOUND_SPEED;
  return 1 + (shift > DOPPLER_MAX ? DOPPLER_MAX : shift < -DOPPLER_MAX ? -DOPPLER_MAX : shift);
}

/** How loud the city is, from how many cars are in it. See section 5. */
export function bedLevel(moving: number): number {
  const n = moving > 0 ? moving : 0;
  return n / (n + BED_HALF);
}

/** How much the tyres are complaining, 0..1. See `SKID_SPEED_MIN`. */
export function skidLevel(speed: number, steer: number): number {
  const s = speed < 0 ? -speed : speed;
  if (s <= SKID_SPEED_MIN) return 0;
  const lock = (steer < 0 ? -steer : steer) - SKID_STEER_MIN;
  if (lock <= 0) return 0;
  const fast = clamp01((s - SKID_SPEED_MIN) / (DRIVE_TOP_SPEED - SKID_SPEED_MIN));
  return fast * clamp01(lock / (1 - SKID_STEER_MIN));
}

// --- The pool -------------------------------------------------------------------

/** One car being considered for a slot this frame. Reused; never allocated. */
interface Candidate {
  key: number;
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  /** Squared metres, with the incumbent's `HANDOVER_MARGIN_M` already taken off. */
  rank: number;
  /** Which slot took it, or -1. Written by `end`. */
  slot: number;
}

/** One chain's tenancy. */
interface Slot {
  /** The car currently sounding, or 0 for an idle chain. */
  key: number;
  /** The car that *should* be sounding. A disagreement is a handover in progress. */
  want: number;
  /** 0 while handing over, 1 while settled. */
  fade: number;
  /** The last speed this car was seen at, or -1 for "no history". Drives the rev. */
  last: number;
  /** The smoothed load, held across frames so the envelope has somewhere to live. */
  load: number;
  /**
   * The last audible geometry computed for this tenant, held so that a slot
   * fading a departed car out has something to fade. The car may be gone --
   * suppressed, out of range, off the end of its schedule -- and a chain that
   * jumped to silence to start its own fade would be the click the fade exists to
   * prevent.
   */
  rate: number;
  gain: number;
  pan: number;
}

function createSlot(): Slot {
  return { key: 0, want: 0, fade: 0, last: -1, load: IDLE_LOAD, rate: 1, gain: 0, pan: 0 };
}

function createCandidate(): Candidate {
  return { key: 0, x: 0, y: 0, z: 0, dirX: 0, dirZ: 1, speed: 0, rank: 0, slot: -1 };
}

/**
 * The whole of the decision, as a `begin`/`offer`/`end` sink.
 *
 * `world/carsmoke.ts` and `CarLights` have the same three-call shape and it is the
 * right one here for the same reason: the caller is a loop that already exists,
 * and the thing being built needs to see every member of it before it can decide
 * anything.
 */
export class CarSoundField implements EngineSink {
  /** Whether the sound system wants anything at all. Set by the owner. */
  on = false;

  private readonly cand: Candidate[] = [];
  private candN = 0;
  private readonly slots: Slot[] = [];

  /** Where the offers are ranked from. Last frame's listener; see section 6. */
  private selX = 0;
  private selZ = 0;
  private ready = false;

  /** Cars within `BED_RANGE` moving faster than `BED_MOVING`, this frame. */
  private moving = 0;

  /** The local car's speed history and smoothed load, exactly as a slot's. */
  private ownLast = -1;
  private ownLoad = IDLE_LOAD;

  /** How many voices sounded last frame. Diagnostics, and the check reads it. */
  voiced = 0;

  constructor() {
    for (let i = 0; i < ENGINE_VOICES; i++) {
      this.cand.push(createCandidate());
      this.slots.push(createSlot());
    }
  }

  begin(): boolean {
    this.candN = 0;
    this.moving = 0;
    return this.on && this.ready;
  }

  offer(key: number, x: number, y: number, z: number, dirX: number, dirZ: number, speed: number): void {
    const dx = x - this.selX;
    const dz = z - this.selZ;
    const d2 = dx * dx + dz * dz;
    // The outer gate, and about five sixths of the draw loop's offers end here.
    if (d2 > BED_RANGE * BED_RANGE) return;
    const mag = speed < 0 ? -speed : speed;
    if (mag > BED_MOVING) this.moving++;
    if (d2 > ENGINE_RANGE * ENGINE_RANGE || mag < VOICE_MOVING) return;

    // The incumbent's bonus, applied to the *ranking* rather than to the
    // resolution. See `HANDOVER_MARGIN_M`.
    let rank = d2;
    if (this.holds(key)) {
      const near = Math.sqrt(d2) - HANDOVER_MARGIN_M;
      rank = near > 0 ? near * near : 0;
    }

    // A bounded insertion sort over seven records. Quadratic in `ENGINE_VOICES`
    // and linear in the offers, which is the right way round: there are seven of
    // the first and up to five hundred of the second, and the common case is the
    // early return on the line below.
    const full = this.candN === ENGINE_VOICES;
    if (full && rank >= this.cand[ENGINE_VOICES - 1].rank) return;
    let i = full ? ENGINE_VOICES - 1 : this.candN++;
    while (i > 0 && this.cand[i - 1].rank > rank) {
      const to = this.cand[i];
      const from = this.cand[i - 1];
      to.key = from.key;
      to.x = from.x;
      to.y = from.y;
      to.z = from.z;
      to.dirX = from.dirX;
      to.dirZ = from.dirZ;
      to.speed = from.speed;
      to.rank = from.rank;
      i--;
    }
    const c = this.cand[i];
    c.key = key;
    c.x = x;
    c.y = y;
    c.z = z;
    c.dirX = dirX;
    c.dirZ = dirZ;
    c.speed = mag;
    c.rank = rank;
  }

  /** Is this car already renting a chain? Seven comparisons. */
  private holds(key: number): boolean {
    for (let s = 0; s < ENGINE_VOICES; s++) {
      const slot = this.slots[s];
      if (slot.key === key || slot.want === key) return true;
    }
    return false;
  }

  /**
   * Resolve the frame: bind candidates to slots, advance every fade and envelope,
   * and fill the mix.
   *
   * Called unconditionally, including on frames where `begin` returned false, so
   * that a rig with nothing left to say fades out rather than stopping.
   */
  end(l: CarListener, out: CarSoundMix): void {
    const dt = l.dt > 0 ? l.dt : 0;

    // --- 1. Who wants which chain.
    for (let i = 0; i < this.candN; i++) this.cand[i].slot = -1;
    for (let s = 0; s < ENGINE_VOICES; s++) this.slots[s].want = 0;

    // The local player's car is not in the pool: it gets `own`, and a candidate
    // matching it is dropped so it cannot also rent a chain and be heard twice.
    if (l.ownCar !== 0) {
      for (let i = 0; i < this.candN; i++) {
        if (this.cand[i].key === l.ownCar) this.cand[i].slot = -2;
      }
    }

    // Incumbents first, so a car that is still in the set keeps the chain it is
    // already sounding on and never hands over to itself.
    for (let s = 0; s < ENGINE_VOICES; s++) {
      const slot = this.slots[s];
      if (slot.key === 0) continue;
      for (let i = 0; i < this.candN; i++) {
        const c = this.cand[i];
        if (c.slot !== -1 || c.key !== slot.key) continue;
        slot.want = slot.key;
        c.slot = s;
        break;
      }
    }
    // Then newcomers, nearest first -- the candidates are already in that order --
    // into genuinely idle chains before chains that have somebody to fade out. A
    // newcomer put on a fading chain waits `HANDOVER_S` to be heard, and there is
    // no reason to make it wait when an empty one is sitting there.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.candN; i++) {
        const c = this.cand[i];
        if (c.slot !== -1) continue;
        for (let s = 0; s < ENGINE_VOICES; s++) {
          const slot = this.slots[s];
          if (slot.want !== 0) continue;
          if (pass === 0 && slot.key !== 0) continue;
          slot.want = c.key;
          c.slot = s;
          break;
        }
      }
    }

    // --- 2. Every chain, whether or not anything wants it.
    let voiced = 0;
    for (let s = 0; s < ENGINE_VOICES; s++) {
      const slot = this.slots[s];
      const voice = out.voices[s];
      const settled = slot.key !== 0 && slot.key === slot.want;

      if (settled) {
        // Find the candidate that won this chain and recompute everything
        // audible from the *fresh* listener. See section 6.
        for (let i = 0; i < this.candN; i++) {
          const c = this.cand[i];
          if (c.slot !== s) continue;
          this.voiceFrom(slot, c, l, dt);
          break;
        }
        slot.fade = dt <= 0 ? 1 : Math.min(1, slot.fade + dt / HANDOVER_S);
      } else {
        // Handing over, or emptying. The remembered geometry is held exactly as
        // it was and only the fade moves, so what is heard is the last thing the
        // departing car was doing, getting quieter.
        slot.fade = dt <= 0 ? 0 : Math.max(0, slot.fade - dt / HANDOVER_S);
        if (slot.fade <= 0) {
          slot.key = slot.want;
          slot.last = -1;
          slot.load = IDLE_LOAD;
          if (slot.key === 0) slot.gain = 0;
        }
      }

      voice.key = slot.key;
      voice.rate = slot.rate;
      voice.load = slot.load;
      voice.pan = slot.pan;
      voice.gain = slot.gain * slot.fade;
      voice.active = slot.key !== 0 && voice.gain > 0.0005;
      if (voice.active) voiced++;
    }
    this.voiced = voiced;

    // --- 3. The local car, which has no distance and no Doppler because the
    // listener is sitting in it. `bark`'s convention for the local player exactly:
    // the event is not given a distance at all rather than a distance of zero.
    const own = out.own;
    if (l.ownCar !== 0) {
      const speed = l.ownSpeed < 0 ? -l.ownSpeed : l.ownSpeed;
      const accel = this.ownLast < 0 || dt <= 0 ? 0 : (speed - this.ownLast) / dt;
      this.ownLast = speed;
      this.ownLoad = follow(this.ownLoad, engineLoad(speed, accel), dt);
      own.active = true;
      own.key = l.ownCar;
      own.rate = engineRate(speed);
      own.load = this.ownLoad;
      own.gain = 1;
      own.pan = 0;
      out.skid = skidLevel(speed, l.ownSteer);
    } else {
      own.active = false;
      own.key = 0;
      own.gain = 0;
      this.ownLast = -1;
      this.ownLoad = IDLE_LOAD;
      out.skid = 0;
    }

    // --- 4. Everything else, as one number. The seven that got chains are taken
    // off the count so the loudest contributors are not also in the sum.
    out.bed = bedLevel(this.moving - voiced);
    out.wanted = own.active || voiced > 0 || out.bed > 0.01;

    // And the ranking origin for next frame's offers.
    this.selX = l.x;
    this.selZ = l.z;
    this.ready = true;
    // Cleared here as well as in `begin`, so that a frame on which the draw loop
    // did not run at all -- and therefore never called `begin` -- fades the whole
    // pool out instead of re-voicing last frame's cars at last frame's positions.
    // Silence is the right failure for a sink whose feeder has stopped.
    this.candN = 0;
  }

  /** One settled tenant's level, pitch, pan and rev, from the fresh listener. */
  private voiceFrom(slot: Slot, c: Candidate, l: CarListener, dt: number): void {
    const dx = c.x - l.x;
    const dy = c.y - l.y;
    const dz = c.z - l.z;
    // The full slant, not the plan distance: a car on the Anzac Bridge deck is
    // thirty metres above somebody underneath it and should sound like it.
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    slot.gain = engineGain(d);

    // The Doppler. One dot product: the *relative* velocity against the unit
    // vector from the listener to the car, negated because the convention is
    // positive inbound and that dot is positive outbound. Both ends move -- you
    // driving past a stationary car hears the same shift the stationary car
    // hears of you.
    let closing = 0;
    let pan = 0;
    if (d > 0.001) {
      const ux = dx / d;
      const uz = dz / d;
      closing = -((c.dirX * c.speed - l.vx) * ux + (c.dirZ * c.speed - l.vz) * uz);
      // Across the head: the camera's right in the plan is `(-fwdZ, fwdX)` with y
      // up, so this is the second dot product and the last multiply in the file.
      pan = (ux * -l.fwdZ + uz * l.fwdX) * PAN_WIDTH;
    }
    slot.pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    slot.rate = engineRate(c.speed) * dopplerRate(closing);

    const accel = slot.last < 0 || dt <= 0 ? 0 : (c.speed - slot.last) / dt;
    slot.last = c.speed;
    slot.load = follow(slot.load, engineLoad(c.speed, accel), dt);
  }
}

/**
 * One step of an asymmetric exponential follower. See `REV_ATTACK_S`.
 *
 * `1 - dt/tau` clamped rather than an exponential, which is the cheap first-order
 * form every smoothing step in this project uses and is exact enough at 60 Hz:
 * the error against `exp(-dt/tau)` at the shorter of the two constants is under
 * two per cent of a value that is itself a brightness.
 */
function follow(current: number, target: number, dt: number): number {
  if (dt <= 0) return current;
  const tau = target > current ? REV_ATTACK_S : REV_RELEASE_S;
  const k = dt / tau;
  return current + (target - current) * (k >= 1 ? 1 : k);
}

// --- The check ------------------------------------------------------------------

/**
 * Everything in this file that can be wrong without anybody hearing it wrong.
 *
 * The sound itself is ears-only and says so in the report; what is *not*
 * ears-only is every property the pool rests on. A curve that is not monotonic is
 * a car that gets quieter as it approaches and nobody would ever attribute that
 * to a curve; a selection that is not deterministic is two players on the same
 * street hearing different cars, which is the one thing `DESIGN.md` rule 5 will
 * not have; a pool that hands over badly is a click, and a click in a loop is a
 * bug report about "the audio breaking" with no way to reproduce it.
 *
 * Runs in both boot lists on `CLAUDE.md`'s rule, which this file can satisfy
 * because it has no `AudioContext` in it -- see the header.
 */
export function verifyCarSound(): string[] {
  const f: string[] = [];

  // --- The curves.
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const s = (i / 200) * DRIVE_TOP_SPEED;
    const r = engineRate(s);
    if (!(r >= prev)) f.push(`engineRate not monotonic at ${s.toFixed(2)} m/s: ${r} < ${prev}`);
    if (r < 1 || r > ENGINE_RATE_TOP + 1e-9) f.push(`engineRate out of bounds at ${s.toFixed(2)}: ${r}`);
    prev = r;
  }
  if (Math.abs(engineRate(0) - 1) > 1e-9) f.push(`engineRate(0) is ${engineRate(0)}, want 1`);
  if (Math.abs(engineRate(DRIVE_TOP_SPEED) - ENGINE_RATE_TOP) > 1e-9) {
    f.push(`engineRate(top) is ${engineRate(DRIVE_TOP_SPEED)}, want ${ENGINE_RATE_TOP}`);
  }
  // Past the top speed it must not keep climbing: a car boosted by a hill or by a
  // crash impulse is still a car.
  if (engineRate(DRIVE_TOP_SPEED * 3) !== ENGINE_RATE_TOP) f.push('engineRate does not clamp above the top speed');
  if (engineRate(-20) !== engineRate(20)) f.push('engineRate is not symmetric in reverse');

  prev = Infinity;
  for (let d = 0; d <= ENGINE_RANGE + 40; d += 0.5) {
    const g = engineGain(d);
    if (!(g <= prev)) f.push(`engineGain not monotonic at ${d} m: ${g} > ${prev}`);
    if (g < 0 || g > 1) f.push(`engineGain out of bounds at ${d} m: ${g}`);
    prev = g;
  }
  if (engineGain(0) !== 1) f.push(`engineGain(0) is ${engineGain(0)}, want 1`);
  if (engineGain(ENGINE_RANGE) !== 0) f.push('engineGain does not cut at ENGINE_RANGE');
  if (engineGain(ENGINE_RANGE - 0.01) > 0.2) f.push('engineGain is still loud at the gate; it will pop');

  for (let i = 0; i <= 40; i++) {
    const s = (i / 40) * DRIVE_TOP_SPEED;
    let last = -Infinity;
    for (let j = 0; j <= 40; j++) {
      const a = -DRIVE_ACCELERATION + (j / 40) * DRIVE_ACCELERATION * 3;
      const load = engineLoad(s, a);
      if (load < 0 || load > 1) f.push(`engineLoad out of bounds at (${s}, ${a}): ${load}`);
      if (!(load >= last)) f.push(`engineLoad not monotonic in accel at ${s} m/s`);
      last = load;
    }
    if (engineLoad(s, 0) < IDLE_LOAD) f.push(`engineLoad below idle at ${s} m/s coasting`);
    if (i > 0) {
      const below = engineLoad((i - 1) / 40 * DRIVE_TOP_SPEED, 0);
      if (engineLoad(s, 0) < below) f.push(`engineLoad not monotonic in speed at ${s} m/s`);
    }
  }

  // --- The Doppler clamp, which is the one number a pass-by lives or dies on.
  if (dopplerRate(0) !== 1) f.push(`dopplerRate(0) is ${dopplerRate(0)}, want 1`);
  const up = dopplerRate(DRIVE_TOP_SPEED);
  const down = dopplerRate(-DRIVE_TOP_SPEED);
  if (Math.abs(up - (1 + DOPPLER_MAX)) > 1e-12) f.push(`dopplerRate(+44) is ${up}, want ${1 + DOPPLER_MAX}`);
  if (Math.abs(down - (1 - DOPPLER_MAX)) > 1e-12) f.push(`dopplerRate(-44) is ${down}, want ${1 - DOPPLER_MAX}`);
  // And it holds past it: two cars closing head-on reach twice the top speed.
  if (dopplerRate(DRIVE_TOP_SPEED * 2) !== up) f.push('dopplerRate does not hold its clamp at +88 m/s');
  if (dopplerRate(-DRIVE_TOP_SPEED * 2) !== down) f.push('dopplerRate does not hold its clamp at -88 m/s');
  if (up <= 1.1 || up >= 1.35) f.push(`dopplerRate at the top speed is ${up}; a pass-by should be a whoosh, not a cartoon`);
  prev = -Infinity;
  for (let v = -120; v <= 120; v += 1) {
    const r = dopplerRate(v);
    if (!(r >= prev)) f.push(`dopplerRate not monotonic at ${v} m/s`);
    prev = r;
  }

  prev = -Infinity;
  for (let n = 0; n <= 200; n++) {
    const b = bedLevel(n);
    if (!(b >= prev)) f.push(`bedLevel not monotonic at ${n}`);
    if (b < 0 || b >= 1) f.push(`bedLevel out of bounds at ${n}: ${b}`);
    prev = b;
  }
  if (bedLevel(0) !== 0) f.push('bedLevel(0) is not silence');
  if (Math.abs(bedLevel(BED_HALF) - 0.5) > 1e-12) f.push('bedLevel is not half at BED_HALF');

  if (skidLevel(40, 0.2) !== 0) f.push('skidLevel squeals on ordinary cornering');
  if (skidLevel(3, 1) !== 0) f.push('skidLevel squeals at walking pace');
  if (skidLevel(DRIVE_TOP_SPEED, 1) !== 1) f.push('skidLevel does not reach 1 at full lock and full speed');
  if (skidLevel(30, -1) !== skidLevel(30, 1)) f.push('skidLevel is not symmetric in the wheel');

  // --- The pool. A field, forty cars in a line, and the seven nearest.
  const mix = createCarSoundMix();
  const l = createCarListener();
  l.dt = 1 / 60;
  const field = new CarSoundField();
  field.on = true;

  // The very first frame declines everything: nothing has said where the ears
  // are. See section 6.
  if (field.begin()) f.push('the field accepted offers before it had a listener');
  field.end(l, mix);

  /** Drive one frame: a line of cars along +X at 10 m/s, the listener at the origin. */
  const frame = (count: number, offsetM: number, speed = 10): void => {
    field.begin();
    for (let i = 0; i < count; i++) {
      field.offer(1000 + i, offsetM + i * 5, 0, 0, 1, 0, speed);
    }
    field.end(l, mix);
  };

  for (let i = 0; i < 60; i++) frame(40, 10);
  if (field.voiced !== ENGINE_VOICES) f.push(`forty cars produced ${field.voiced} voices, want ${ENGINE_VOICES}`);
  for (let s = 0; s < ENGINE_VOICES; s++) {
    const want = 1000 + s;
    if (mix.voices[s].key === 0) f.push(`voice ${s} is idle with forty cars in earshot`);
    if (!mix.voices.some((v) => v.key === want)) f.push(`car ${want}, one of the seven nearest, has no voice`);
  }
  for (const v of mix.voices) {
    if (v.key >= 1000 + ENGINE_VOICES) f.push(`car ${v.key} took a voice ahead of a nearer car`);
    if (v.gain < 0 || v.gain > 1) f.push(`voice gain out of bounds: ${v.gain}`);
  }
  // The mix is the same objects it started as -- nothing here reallocates.
  if (mix.voices.length !== ENGINE_VOICES) f.push('the mix grew a voice');

  // Determinism: a second field fed the same offers in the same order agrees
  // exactly. This is `DESIGN.md` rule 5 applied to the audio -- two players on
  // one street hear the same seven cars.
  const twin = new CarSoundField();
  twin.on = true;
  const twinMix = createCarSoundMix();
  const twinL = createCarListener();
  twinL.dt = 1 / 60;
  twin.begin();
  twin.end(twinL, twinMix);
  for (let n = 0; n < 60; n++) {
    twin.begin();
    for (let i = 0; i < 40; i++) twin.offer(1000 + i, 10 + i * 5, 0, 0, 1, 0, 10);
    twin.end(twinL, twinMix);
  }
  for (let s = 0; s < ENGINE_VOICES; s++) {
    const a = mix.voices[s];
    const b = twinMix.voices[s];
    if (a.key !== b.key || a.gain !== b.gain || a.rate !== b.rate) {
      f.push(`two fields fed identically disagree on voice ${s}: ${a.key}/${a.gain} vs ${b.key}/${b.gain}`);
    }
  }

  // --- Hysteresis. A newcomer inside the margin does not get the slot; one
  // clearly past it does.
  const held = mix.voices.find((v) => v.key === 1000 + ENGINE_VOICES - 1);
  if (!held) {
    f.push('the seventh-nearest car is not in the pool, so the hysteresis case cannot be set up');
  } else {
    const boundary = 10 + (ENGINE_VOICES - 1) * 5;
    const nudge = (newcomerAt: number): number | undefined => {
      for (let n = 0; n < 30; n++) {
        field.begin();
        for (let i = 0; i < ENGINE_VOICES; i++) field.offer(1000 + i, 10 + i * 5, 0, 0, 1, 0, 10);
        field.offer(7777, newcomerAt, 0, 0, 1, 0, 10);
        field.end(l, mix);
      }
      return mix.voices.find((v) => v.key === 7777)?.key;
    };
    if (nudge(boundary - HANDOVER_MARGIN_M * 0.4) !== undefined) {
      f.push('a newcomer inside HANDOVER_MARGIN_M took a slot; the boundary will chatter');
    }
    if (nudge(boundary - HANDOVER_MARGIN_M * 2) === undefined) {
      f.push('a newcomer well inside the margin never took a slot; the pool is stuck');
    }
  }

  // --- How a chain changes hands, which is two different cases and only one of
  // them is a crossfade.
  //
  // **With a chain going spare, nobody waits.** A car arriving while six of the
  // seven are idle takes an idle one on the frame it arrives and is at level
  // within `HANDOVER_S`, because the assignment prefers a genuinely empty chain
  // over one that still has somebody to fade out. Getting this wrong is a car
  // that pulls up beside you and is heard a quarter of a second later, which
  // reads as lag rather than as a crossfade.
  const hand = new CarSoundField();
  hand.on = true;
  const handMix = createCarSoundMix();
  const handL = createCarListener();
  handL.dt = 1 / 60;
  hand.begin();
  hand.end(handL, handMix);
  for (let n = 0; n < 40; n++) {
    hand.begin();
    hand.offer(11, 20, 0, 0, 1, 0, 12);
    hand.end(handL, handMix);
  }
  const alone = handMix.voices.find((v) => v.key === 11);
  if (!alone || alone.gain <= 0) f.push('a single car never settled on a chain');
  hand.begin();
  hand.offer(22, 20, 0, 0, 1, 0, 12);
  hand.end(handL, handMix);
  if (!handMix.voices.some((v) => v.key === 22)) {
    f.push('a car arriving with six chains idle had to queue behind the seventh');
  }
  for (let n = 0; n < 10; n++) {
    hand.begin();
    hand.offer(22, 20, 0, 0, 1, 0, 12);
    hand.end(handL, handMix);
  }
  const fresh = handMix.voices.find((v) => v.key === 22);
  if (!fresh || fresh.gain < engineGain(20) * 0.9) {
    f.push('a car on an idle chain was not at level within HANDOVER_S');
  }

  // **With the pool full, it is a dip.** Seven cars settled and then an eighth
  // nearer than all of them: there is no spare chain, so the one holding the
  // furthest car has to be taken to silence, change hands and come back. The
  // count must never exceed the pool, the key must change exactly once, and the
  // gain must actually reach zero on the way -- a key change at a live gain is a
  // pitch jump, which is the click this whole arrangement exists to avoid.
  const pool = new CarSoundField();
  pool.on = true;
  const poolMix = createCarSoundMix();
  const poolL = createCarListener();
  poolL.dt = 1 / 60;
  pool.begin();
  pool.end(poolL, poolMix);
  const street = (eighth: boolean): void => {
    pool.begin();
    for (let i = 0; i < ENGINE_VOICES; i++) pool.offer(11 + i, 20 + i * 6, 0, 0, 1, 0, 12);
    if (eighth) pool.offer(22, 5, 0, 0, 1, 0, 12);
    pool.end(poolL, poolMix);
  };
  for (let n = 0; n < 60; n++) street(false);
  const evicted = 11 + ENGINE_VOICES - 1;
  const chain = poolMix.voices.findIndex((v) => v.key === evicted);
  if (chain < 0) {
    f.push('the furthest of seven cars never got a chain, so the eviction case cannot be set up');
  } else {
    const before = poolMix.voices[chain].gain;
    let changes = 0;
    let seen = evicted;
    let dipped = false;
    let overflow = false;
    for (let n = 0; n < 90; n++) {
      street(true);
      const v = poolMix.voices[chain];
      if (v.key !== seen) {
        changes++;
        seen = v.key;
      }
      if (v.gain <= 0.0006) dipped = true;
      let live = 0;
      for (const each of poolMix.voices) if (each.active) live++;
      if (live > ENGINE_VOICES) overflow = true;
    }
    if (changes !== 1) f.push(`the chain changed hands ${changes} times for one eviction`);
    if (seen !== 22) f.push(`the chain ended up on ${seen}, want 22`);
    if (!dipped) f.push('the eviction never took the gain to zero; that is a pitch jump, which is a click');
    if (overflow) f.push('the pool exceeded ENGINE_VOICES during an eviction');
    if (poolMix.voices[chain].gain <= before) {
      f.push('the chain did not come back louder for the nearer car that took it');
    }
  }

  // --- The local car is not also in the pool.
  const solo = new CarSoundField();
  solo.on = true;
  const soloMix = createCarSoundMix();
  const soloL = createCarListener();
  soloL.dt = 1 / 60;
  solo.begin();
  solo.end(soloL, soloMix);
  soloL.ownCar = 99;
  soloL.ownSpeed = 25;
  for (let n = 0; n < 40; n++) {
    solo.begin();
    solo.offer(99, 0.5, 0, 0, 1, 0, 25);
    solo.offer(100, 30, 0, 0, 1, 0, 25);
    solo.end(soloL, soloMix);
  }
  if (!soloMix.own.active) f.push('the local car has no voice while it is being driven');
  if (soloMix.voices.some((v) => v.key === 99)) f.push('the local car took a pooled voice as well as its own');
  if (!soloMix.voices.some((v) => v.key === 100)) f.push('a second car was crowded out by the local one');
  if (soloMix.own.rate <= 1) f.push('the local car is idling at 25 m/s');
  soloL.ownCar = 0;
  solo.begin();
  solo.end(soloL, soloMix);
  if (soloMix.own.active) f.push('the local car is still running after the player got out');
  if (soloMix.skid !== 0) f.push('the tyres are still squealing after the player got out');

  return f;
}
