/**
 * What a train says, and when: the announcements, as arithmetic on the clock.
 *
 * `game/rail.ts` says where every train in Sydney is at any instant, in closed
 * form. This file says what the public-address system in that train is playing
 * at that instant, and it says it the same way -- **a lookup on the timetable,
 * not an event queue.**
 *
 * ---------------------------------------------------------------------------
 * 1. THERE IS NO SCHEDULER HERE, AND THAT IS THE WHOLE DESIGN.
 *
 * The obvious way to do this is a queue: watch for the moment a train comes
 * within twenty-five seconds of a platform, push a "play the approach clip"
 * event, hold the handle, cancel it if the player walks away. That design has
 * three failures this one cannot have:
 *
 *   - **A player who arrives mid-announcement hears it from the start**, or
 *     hears nothing at all, depending on which. Both are wrong. What they should
 *     hear is the middle of it, because the middle of it is what is being said.
 *   - **Two players in one carriage hear different instants of it**, because
 *     each client started its own copy when its own frame loop noticed.
 *   - **A backgrounded tab comes back with a queue full of announcements** for
 *     stations the train left four minutes ago.
 *
 * So, exactly as `game/traffic.ts` and `game/rail.ts` argue for the vehicles
 * themselves: nothing here is stepped, no state survives a frame, and "is the
 * approach announcement playing right now, and how far into it" is a binary
 * search and two subtractions over `dir.arrivals`. Sixteen players in one
 * carriage are on the same syllable because they all evaluated the same function
 * at the same millisecond, and `net/protocol.ts` gains not one byte.
 *
 * `game/rave.ts` reached the same conclusion for a DJ set and is the direct
 * precedent: a record's position is `(clock - set start) mod length`, so a
 * player walking into a warehouse joins the track where the track is.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CLIPS ARE ANCHORED TO THE DWELL, WHICH IS WHERE THE BAKE PUTS THEM.
 *
 * A dwell is a phase with `v0 = 0` and `a = 0` -- see `rail.dwellElapsed`, which
 * is what the doors are driven from -- and it begins `dir.arrivals[c]` seconds
 * after the trip departed. That one number anchors both clips; everything else
 * is a constant the recordings arrived with:
 *
 *                 A = dir.arrivals[c]        the doors open
 *                 A + dwell                  the doors close (dwell is 15 s)
 *
 *     approach    starts at A - 25, runs 27.35 s, ending 2.35 s into the stand
 *     departure   starts at A + dwell - 15, runs 65.25 s
 *
 * With the bake's 15 s dwell the departure clip therefore starts **exactly as
 * the doors open** and runs about fifty seconds into the journey. That is not a
 * bug to be trimmed at the doors: a real "this train goes to Central, first stop
 * Sydenham" carries on long after the train has left, and the recording is 65
 * seconds long because it is a recording of one that did.
 *
 * The 2.35 s where the two overlap is left alone for the same reason. It is what
 * the numbers produce, one clip is trailing off as the other begins, and it is
 * two seconds. It is also the only reason `RailAnnounceMix` has two channels.
 *
 * ---------------------------------------------------------------------------
 * 3. PRE-EMPTION, WHICH THE REAL TIMETABLE MAKES UNAVOIDABLE.
 *
 * 159 of the bake's 408 hops are shorter than ninety seconds, so a 65-second
 * departure announcement is very often still talking when the train is
 * twenty-five seconds off the *following* platform. Two different messages at
 * full level for twenty seconds is not a station, it is a fault.
 *
 * So a clip is cut when the next one starts, which is what one speaker with two
 * things to say does:
 *
 *     end(c, kind) = min( start(c, kind) + length,
 *                         start(c + 1, kind),          the next of its own kind
 *                         start(c + 1, approach),      only for a departure
 *                         dir.duration )
 *
 * And the mirror of it at the front. **The shortest hop in the bake is 21.0 s**
 * -- Richmond to East Richmond on the T5 -- which is shorter than the approach
 * lead, so an unclamped approach clip for East Richmond would begin four seconds
 * *before the train had even reached Richmond*, naming the wrong station while
 * the HUD named the right one. So an approach clip never starts before the train
 * has arrived at the previous station:
 *
 *     start(c, approach) = max( A[c] - 25, A[c - 1] )
 *
 * `A[c - 1]` and not `A[c - 1] + dwell` because that is the instant the HUD
 * changes: `riding.rideBanner` reads `nextCall(dir, s + 30)`, and a train
 * standing at Richmond is already thirty metres short of nothing, so the banner
 * says "next: East Richmond" from the moment it stops. The announcement and the
 * banner therefore change together, which `checkRailAnnouncements` asserts.
 *
 * One consequence, stated rather than hidden: on that 21-second hop the
 * departure announcement's window closes before it opens, so it does not play at
 * all. A train that is six seconds from the next platform has nothing to say.
 *
 * ---------------------------------------------------------------------------
 * 4. THE ORIGIN GETS NOTHING AND THE TERMINUS GETS ONE.
 *
 * `dir.arrivals[0]` is 0 and `dir.arrivals[last]` is `dir.duration` on every one
 * of the twenty directions: a trip starts moving the instant it exists and stops
 * existing the instant it stops. Neither end has a dwell, so neither has doors:
 *
 *   - **no departure announcement at the origin.** A train that never opened its
 *     doors there never told anybody where it was going.
 *   - **an approach announcement into the terminus**, because the last thing a
 *     train says is that it terminates. Its window runs off the end of the trip
 *     and is cut at `dir.duration`, which loses the final couple of seconds and
 *     is the honest consequence of a train that vanishes at the buffers.
 *
 * ---------------------------------------------------------------------------
 * 5. THE SOURCE IS A CARRIAGE, NOT A STATION.
 *
 * The announcement comes out of the train, so what drives the level is the
 * distance to the **nearest carriage**, refined to the nearest point on that
 * carriage's own axis. `world/trains.ts` places the carriages with
 * `riding.consistOffset` and this reads the identical function, so the thing you
 * hear is at the position of the thing you can see.
 *
 * Three consequences, each of them a feature rather than a cost:
 *
 *   - **On a platform the whole train is beside you.** An eight-car Tangara is
 *     163 m long, so anywhere along the platform the nearest carriage is a few
 *     metres away and the announcement is at platform level for the length of
 *     it -- with no station-shaped special case anywhere.
 *   - **The approach announcement arrives with the train.** Twenty-five seconds
 *     out a train is 344 m away and doing 27 m/s, far outside `ANNOUNCE_RANGE`,
 *     so somebody waiting hears the last eight seconds of it sweep in with the
 *     vehicle. A passenger already *on board* hears all of it, which is who an
 *     approach announcement has always been for.
 *   - **A rider hears their own train at zero.** See section 6.
 *
 * ---------------------------------------------------------------------------
 * 6. A RIDER IS INSIDE, AND INSIDE IS NOT A DISTANCE OF ZERO METRES.
 *
 * The rest of `game/audio.ts` handles the local player by not passing a distance
 * at all -- `audio.thwack()` against `audio.thwack(range)` -- so the local event
 * plays at unity. This does that and one thing more: a rider gets
 * `distance = 0` **and** `inside = true`, and the second flag is what takes the
 * shell off. Outside, the PA is heard through a steel box, which is a level cut
 * and a low-pass; inside there is nothing between the speaker and the ear.
 * Without the flag a rider would get the muffled version at full volume, which
 * sounds like a broken speaker rather than like being in a carriage.
 *
 * A rider also hears **only their own train**. Another service announcing across
 * the island platform does not reach into a sealed air-conditioned carriage, and
 * declining to mix it is both truer and cheaper: the city sweep below collapses
 * to a single trip.
 *
 * ---------------------------------------------------------------------------
 * **This file imports `game/rail.ts` and `game/riding.ts` and nothing else** --
 * no three, and not `game/audio.ts`. It computes *what should be audible*; the
 * sound system decides what that is made of, exactly as `world/rave.ts` hands
 * `CombatAudio.raveUpdate` a `RaveMix` and knows nothing about a convolver. That
 * is what lets the Bun server compile this file and re-derive the whole schedule
 * in `checkRailAnnouncements` with no `AudioContext` within a mile of it.
 */

import {
  createTrainPose,
  dwellElapsed,
  liveTripCount,
  poseTrain,
  sampleAlong,
  trainIdentity,
  tripIndexAt,
  type RailBake,
  type RailDirection,
  type TrainPose,
  railUnderground,
} from './rail.ts';
import {
  consistOf,
  consistOffset,
  dirOf,
  nextCall,
  type AboardRef,
} from './riding.ts';

// --- The clips -----------------------------------------------------------------------

/** The approach announcement, which starts before the train arrives. */
export const ANNOUNCE_ARRIVE = 0;
/** The "this train goes to" announcement, which starts as the doors open. */
export const ANNOUNCE_DEPART = 1;

export const ARRIVE_URL = '/audio/rail/25s_before_arrive.mp3';
export const DEPART_URL = '/audio/rail/15s_before_leave.mp3';

/** Both, in `ANNOUNCE_*` order, for the prefetch and for the check. */

/**
 * Inside a moving train, recorded by the owner on a Sydney train and handed
 * over as *"sometimes when the train is moving its silent"*.
 *
 * `ANNOUNCE_RANGE`'s comment has been admitting this gap for a while -- *"the
 * PA is the only train voice in this build, there is no rolling-stock sound at
 * all"*. A carriage between stations was silent, which is the one place in this
 * city that is never silent.
 */
export const RIDE_URL = '/audio/rail/trainride.m4a';

/**
 * The recording's length, seconds.
 *
 * Wanted for the same reason `game/rave.ts` wants a record's: the bed is
 * positioned at `clock mod length` rather than started when a client noticed,
 * so two people in one carriage hear the same rattle at the same instant and
 * somebody who boards at Redfern joins it where it already is. Measured off the
 * file rather than guessed -- 79.189333 s -- and truncated, because running a
 * few milliseconds short of the end loops early and running past it plays
 * silence.
 */
export const RIDE_SECONDS = 79.18;

/**
 * Where in the recording a leg of a journey joins it.
 *
 * The bed used to be positioned at `t mod length` alone, which is right about
 * the thing that matters -- two people in one carriage are on the same rattle,
 * because both evaluated the same function at the same millisecond -- and wrong
 * about the thing a rider notices. Phase-locked to the wall clock, the loop
 * comes round to the same place at the same time of day forever, and a run from
 * Central to Epping crosses the same seam in the recording at the same point of
 * every leg. Seventy-nine seconds is short enough to learn.
 *
 * So the clock still drives it, and a hash of *which leg of which trip this is*
 * displaces it. `key` is the ride key -- trip, direction and the call the train
 * is running towards -- so:
 *
 *   - every client in the carriage still computes the same instant, because
 *     nothing here is random in the sense of `Math.random`; it is random in the
 *     sense the city's traffic and its footy crowds are, a pure function of
 *     identity that no two legs agree on;
 *   - somebody who boards at Redfern still joins where the carriage already is,
 *     because the clock term is untouched;
 *   - and the leg out of Redfern enters the file three quarters of the way in
 *     while the leg before it entered it at nine seconds.
 *
 * **It hashes the key itself rather than trusting the caller to have.** The
 * first draft took the top 24 bits and assumed the ride key arrived avalanched;
 * `verifyRideBed` convicted it in a line, because keys 1 and 2 shift to the same
 * zero and two consecutive legs entered at the same second. A function whose
 * correctness depends on its caller's arithmetic is a function that is wrong the
 * first time somebody calls it from somewhere else, so the finaliser is here.
 */
export function rideEntry(key: number, t: number): number {
  let h = key >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const jump = (h / 0x100000000) * RIDE_SECONDS;
  const at = (t + jump) % RIDE_SECONDS;
  return at < 0 ? at + RIDE_SECONDS : at;
}

/**
 * Which call the train is running towards: the number of arrivals already past.
 *
 * `dir.arrivals` is sorted, so this is the same upper-bound search `dwellElapsed`
 * does over the phases, and it changes exactly once per leg -- during the dwell,
 * where `ridePlays` has the bed stood down anyway. That is what makes it safe to
 * mix into the ride key: the key moves only in silence.
 */
function callIndexAt(dir: RailDirection, age: number): number {
  const a = dir.arrivals;
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= age) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Does the carriage bed play?
 *
 * Stated as its own function of four booleans because the owner's rule is
 * exactly four booleans -- *"play it when the train is MOVING/underway and when
 * the other 2 sounds arent playing"* -- and a rule that small is worth being
 * able to check exhaustively rather than reading out of a loop that is also
 * doing binary searches over a timetable.
 *
 * The announcements win, and that is the whole of the priority: a PA sentence
 * is the thing a player is meant to hear, and a bed under it is what makes it
 * unintelligible. Dwell wins too -- a stopped train with its doors open is a
 * platform, not a ride.
 */
export function ridePlays(
  aboard: boolean, underway: boolean, arriving: boolean, departing: boolean,
): boolean {
  return aboard && underway && !arriving && !departing;
}

/**
 * Seconds before the doors open that the approach clip starts, and its length.
 *
 * The recording's own name, and its **decoded** duration after the loudness
 * pass, which is not the same as its container duration: `ffprobe` reports
 * 27.396 s and Chrome's `decodeAudioData` returns 27.352, because an MP3 frame
 * is 1,152 samples and the encoder pads the tail. The shorter of the two is
 * what goes here and it is rounded down again -- a schedule that outlives its
 * own audio ends every approach announcement with a few milliseconds of a
 * buffer that is not there, and the guard in `CombatAudio.announceVoice` would
 * silently decline to start one entered in that window.
 *
 * 27.35 against a 25 s lead means it ends 2.35 s into the stand, which is where
 * a real one ends.
 */
export const ARRIVE_LEAD_S = 25;
export const ARRIVE_SECONDS = 27.35;

/**
 * Seconds before the doors **close** that the departure clip starts, and its
 * length.
 *
 * Written as a lead on the close rather than as "at the arrival", which with the
 * bake's 15 s dwell is the same instant, because the two stop being the same
 * instant the moment a bake lengthens a dwell -- and then this belongs at the
 * end of the stand, not at the start of it.
 */
export const DEPART_LEAD_S = 15;
export const DEPART_SECONDS = 65.25;

/** Seconds of clip, by `ANNOUNCE_*`. */
const CLIP_SECONDS: readonly number[] = [ARRIVE_SECONDS, DEPART_SECONDS];

/** The longest consist in the fleet, metres: eight Tangara cars at 20.4 m. */
const CONSIST_M = 170;

// --- When, as a function of the trip's own age ----------------------------------------

/**
 * The trip age at which `kind` starts playing for calling stop `call`.
 *
 * Monotonic in `call` for each kind, which is what `lastStartAtOrBefore` rests
 * on. See section 3 for the `Math.max` on the approach clip.
 */
export function announceStart(
  bake: RailBake, dir: RailDirection, call: number, kind: number,
): number {
  const a = dir.arrivals[call];
  if (kind === ANNOUNCE_ARRIVE) {
    const lead = a - ARRIVE_LEAD_S;
    if (call <= 0) return lead;
    const previous = dir.arrivals[call - 1];
    return lead > previous ? lead : previous;
  }
  return a + bake.physics.dwell - DEPART_LEAD_S;
}

/**
 * The trip age at which it stops -- the clip running out, the next announcement
 * pre-empting it, or the trip itself ending. Section 3.
 *
 * May be at or before `announceStart`, which is how the 21-second Richmond hop
 * ends up with no departure announcement rather than with a truncated one.
 */
export function announceEnd(
  bake: RailBake, dir: RailDirection, call: number, kind: number,
): number {
  let end = announceStart(bake, dir, call, kind) + CLIP_SECONDS[kind];
  if (call + 1 < dir.arrivals.length) {
    // Its own kind pre-empts it, and the approach clip pre-empts a departure
    // clip as well -- a new message wins whatever the last one was about.
    const own = announceStart(bake, dir, call + 1, kind);
    if (own < end) end = own;
    if (kind === ANNOUNCE_DEPART) {
      const approach = announceStart(bake, dir, call + 1, ANNOUNCE_ARRIVE);
      if (approach < end) end = approach;
    }
  }
  if (end > dir.duration) end = dir.duration;
  return end;
}

/**
 * Whether calling stop `call` gets an announcement of this kind at all.
 *
 * Section 4: the origin never opened its doors, and nothing approaches the
 * station it started from.
 */
export function announces(dir: RailDirection, call: number, kind: number): boolean {
  if (call < 0 || call >= dir.arrivals.length) return false;
  if (kind === ANNOUNCE_ARRIVE) return call > 0;
  return dir.arrivals[call] > 0 && dir.arrivals[call] < dir.duration;
}

/** One announcement in progress. Filled by `announcementAt`, never allocated per frame. */
export interface RailAnnouncement {
  kind: number;
  /** Index into `dir.arrivals`: which *calling* stop this is about. */
  call: number;
  /** Index into `dir.stops`: the same station, the way the HUD indexes them. */
  stop: number;
  /** Seconds into the clip. */
  offset: number;
  /** Trip age the clip started at, and the age it is cut at. */
  startAge: number;
  endAge: number;
}

export function createRailAnnouncement(): RailAnnouncement {
  return { kind: -1, call: -1, stop: -1, offset: 0, startAge: 0, endAge: 0 };
}

/**
 * The largest `call` whose clip of this kind has started by `age`, or -1.
 *
 * `rail.evalCurve`'s binary search with `announceStart` in place of the phase
 * table, which costs six evaluations of three arithmetic operations. Searching
 * the start rather than `dir.arrivals` directly matters: the approach clip's
 * `Math.max` means the two are not the same ordering near a short hop, and a
 * search over the wrong one silently returns the station after the one that is
 * actually talking.
 */
function lastStartAtOrBefore(
  bake: RailBake, dir: RailDirection, kind: number, age: number,
): number {
  let lo = 0;
  let hi = dir.arrivals.length - 1;
  if (hi < 0 || announceStart(bake, dir, 0, kind) > age) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (announceStart(bake, dir, mid, kind) <= age) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Is `kind` playing on this trip at `age` seconds, and how far into it.
 *
 * **One binary search, no scan and no state.** Windows of one kind never overlap
 * -- `verifyRailAudio` asserts it over the whole bake -- so the only candidate
 * is the last station whose clip has started, and if that one has finished then
 * nothing of this kind is playing.
 */
export function announcementAt(
  bake: RailBake, dir: RailDirection, age: number, kind: number, out: RailAnnouncement,
): boolean {
  const call = lastStartAtOrBefore(bake, dir, kind, age);
  if (call < 0 || !announces(dir, call, kind)) return false;
  const start = announceStart(bake, dir, call, kind);
  const end = announceEnd(bake, dir, call, kind);
  if (age < start || age >= end) return false;
  out.kind = kind;
  out.call = call;
  out.stop = callToStop(dir, call);
  out.offset = age - start;
  out.startAge = start;
  out.endAge = end;
  return true;
}

/**
 * The `dir.stops` index of the `call`-th *calling* stop.
 *
 * 82 of the bake's 510 stops are stations a service runs through, so the two
 * indexings genuinely differ and `riding.nextCall` -- the thing the HUD reads --
 * returns the `dir.stops` one. A walk rather than a table because a table is
 * state, the array is tens long, and this is called once per announcement rather
 * than once per station. `rail.nextArrivals` does the same walk.
 */
export function callToStop(dir: RailDirection, call: number): number {
  let c = 0;
  for (let k = 0; k < dir.stops.length; k++) {
    if (!dir.stops[k].calls) continue;
    if (c === call) return k;
    c++;
  }
  return -1;
}

// --- What is audible, and from where --------------------------------------------------

/** One channel of the train PA. There are two; see `RailAnnounceMix`. */
export interface RailVoice {
  /** Nothing is playing on this channel when false. Every other field is stale. */
  active: boolean;
  /**
   * The announcement's identity: this trip, this station, this clip.
   *
   * A change is a *different* announcement and restarts the source. It is stable
   * for the whole of one announcement, so a player walking the length of a
   * platform does not restart the sentence at every step.
   */
  key: number;
  url: string;
  /** Seconds into the clip, from the shared clock. */
  offset: number;
  /** Metres to the nearest point on the nearest carriage. Zero aboard. */
  distance: number;
  /** The listener is in this train: no shell, no muffle. See section 6. */
  inside: boolean;
  /**
   * Play the buffer round and round rather than once.
   *
   * True only for the carriage bed. A sentence that looped would be a sentence
   * said twice, which is why this is a property of the voice rather than of the
   * channel it lands on.
   */
  loop?: boolean;
  /** The station it is about. The HUD must agree; see `checkRailAnnouncements`. */
  station: string;
  /** For the debug overlay. */
  line: string;
}

/**
 * What the sound system is handed each frame, exactly as `RaveMix` is.
 *
 * Two channels rather than one, and rather than many. One could not carry the
 * approach clip's deliberate 2.4 s overlap with the departure clip; many would
 * make a busy platform a wall of voices. Two is what one train can produce, and
 * each channel takes the nearest claimant, so the worst case anywhere in the
 * city is one arriving train and one departing train talking over each other --
 * which is a description of Central.
 */
export interface RailAnnounceMix {
  arrive: RailVoice;
  depart: RailVoice;
  /** The carriage bed, playing whenever `ridePlays` says so. */
  ride: RailVoice;
  /**
   * A train close enough that the clips are worth having decoded.
   *
   * `world/rave.ts`' prefetch rule in one boolean: **a player who never goes
   * near a railway never downloads an announcement.**
   */
  wanted: boolean;
}

function createVoice(url: string): RailVoice {
  return {
    active: false, key: 0, url, offset: 0, distance: 0,
    inside: false, station: '', line: '',
  };
}

export function createRailAnnounceMix(): RailAnnounceMix {
  return {
    arrive: createVoice(ARRIVE_URL),
    depart: createVoice(DEPART_URL),
    ride: createVoice(RIDE_URL),
    wanted: false,
  };
}

/**
 * How far a train announcement carries, metres.
 *
 * **Platform length, not suburb length.** `RAVE_AUDIBLE_RANGE`'s own comment
 * records what happens when this number is generous: the rave's 520 m was cut to
 * 175 m because a cue that is on most of the time is not a cue. An announcement
 * is a far worse offender than a warehouse party, because there is one at every
 * station every two minutes, all day, on ten lines -- at rave range a walk
 * through Newtown would be narrated.
 *
 * **90 m, and it was 110.** The owner: *"make the sound of cars and trains decay
 * faster"*. The PA is the only train voice in this build -- there is no
 * rolling-stock sound at all, so "trains" is this -- and the same reduction the
 * engines got applies here for a sharper version of the reason: an announcement
 * is *speech*, and speech carries a long way past the point where it is
 * intelligible. Being able to hear that an announcement is happening two streets
 * away, without being able to make out a word of it, is worse than not hearing
 * it: it is the sound of a public address system somewhere else, which is a
 * thing nobody has ever wanted in a game.
 *
 * 90 m is a platform and the doors it opens onto, measured from the carriage
 * rather than from the station, so what it buys is exactly: the whole platform
 * hears the train it is standing beside, the concourse hears the end of it, and
 * the next street does not know the railway is there. **The platform is the
 * constraint that was checked rather than assumed.** A Sydney platform is about
 * 160 m and a consist is `CONSIST_M`'s 170, so a train that has stopped is
 * alongside every metre of it -- with the distance taken to the nearest carriage,
 * nobody standing on the platform is more than about 25 m from the source, where
 * the level is 0.128 of full scale against a traffic bed of 0.017 and a city bed
 * of 0.006 under that. The far end of a
 * platform is not close to the gate and was never in danger from this change;
 * what is now outside 90 m is the concourse stairs, the street, and the next
 * platform but two.
 *
 * `ANNOUNCE_RANGE / ANNOUNCE_HALF_DISTANCE` is 6.0, against the 4.78 it was --
 * so the level at the gate is 0.143 of the level at the carriage side rather
 * than 0.173. Both are inside the band this project has decided is inaudible
 * (`RAVE_AUDIBLE_RANGE` cuts at 0.108 and `ENGINE_RANGE` at 0.125), so nothing
 * pops when you walk away; it is simply reached sooner.
 */
export const ANNOUNCE_RANGE = 90;

/**
 * How close before a byte is fetched, metres.
 *
 * Wider than the audible range, for a plain reason: 220 kB has to arrive and
 * decode before the train does. At the 27 m/s a train is doing twenty-five
 * seconds out, 500 m is eighteen seconds of warning, and the clips are fetched
 * once for the session.
 */
export const ANNOUNCE_FETCH_RANGE = 500;

const _pose: TrainPose = /*#__PURE__*/ createTrainPose();
const _car: TrainPose = /*#__PURE__*/ createTrainPose();
const _ann: RailAnnouncement = /*#__PURE__*/ createRailAnnouncement();

/**
 * Every announcement audible at (x, z) at rail-clock second `t`, as two channels.
 *
 * Pure but for the scratch it writes into, allocation-free but for `consistOf`,
 * and it takes its clock from the caller for `TrainFleet.update`'s reason: a
 * backgrounded tab costs nothing and comes back with the right sentence half
 * said.
 *
 * `aboard` is the local player's carriage, or null. When it is not null the
 * whole city sweep collapses to one trip -- section 6 -- so a rider pays less
 * for this than somebody standing on a platform does.
 */
export function railAnnounceMix(
  bake: RailBake,
  t: number,
  x: number,
  z: number,
  aboard: AboardRef | null,
  out: RailAnnounceMix,
  /**
   * Whether the listener is below the street -- in a station box or its
   * incline. A train in a bore is heard from the platform and never from the
   * footpath over it, and a listener on the footpath hears the surface
   * railway and never the one under their feet. `railUnderground` is the
   * other half of the test; together they are the cheap occlusion the owner
   * asked for -- *"tunnel trains should only be hearable like in eyesight"*.
   */
  listenerUnderground = false,
): void {
  out.arrive.active = false;
  out.depart.active = false;
  out.ride.active = false;
  out.wanted = false;
  /** Set by the rider's own train, below, and read after the sweep. */
  let rideUnderway = false;
  let rideKey = 0;

  const ridingDir = aboard === null ? null : dirOf(bake, aboard.line, aboard.dir);
  const reach = ANNOUNCE_FETCH_RANGE + CONSIST_M;
  const reach2 = reach * reach;
  let bestArrive = Infinity;
  let bestDepart = Infinity;

  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      if (ridingDir !== null) {
        if (dir !== ridingDir) continue;
      } else if (
        x + reach < dir.minX || x - reach > dir.maxX ||
        z + reach < dir.minZ || z - reach > dir.maxZ
      ) continue;

      const live = liveTripCount(dir);
      for (let j = 0; j <= live; j++) {
        const trip = tripIndexAt(dir, t, j);
        const mine = ridingDir !== null && aboard !== null && trip === aboard.trip;
        if (ridingDir !== null && !mine) continue;
        if (!poseTrain(bake, dir, trip, t, _pose)) continue;
        if (!mine) {
          // The head of the train, a consist-length from the far end of it. One
          // rejection ahead of eight polyline searches.
          const hx = _pose.x - x;
          const hz = _pose.z - z;
          if (hx * hx + hz * hz > reach2) continue;
        }
        const age = _pose.age;
        const s = _pose.s;
        // The occlusion. The rider's own train is always heard.
        if (!mine && railUnderground(bake, dir, s) !== listenerUnderground) continue;
        if (mine) {
          // **Underway is the absence of a dwell**, which is the same fact the
          // doors are driven from rather than a second opinion about it:
          // `dwellElapsed` answers non-zero only inside a phase with no speed
          // and no acceleration. A train braking into a platform is still
          // moving and still sounds like it.
          rideUnderway = dwellElapsed(bake, dir, age) === 0;
          // Stable for one leg, so the bed is not restarted every frame; zero
          // is `announceRelease`'s "nothing playing", so it must not collide.
          // The leg is in it because `rideEntry` wants a different entry point
          // for every hop, and it only ever changes inside a dwell.
          const leg = callIndexAt(dir, age);
          let h = (Math.imul(dir.line.id.length + 1, 0x9e3779b1) ^ (trip * 2654435761)) >>> 0;
          h = Math.imul(h ^ (leg + 1), 0x85ebca6b) >>> 0;
          rideKey = (h ^ (h >>> 13)) >>> 0 || 1;
        }
        // Once for both kinds: in the 2.4 s they overlap they are the same train
        // standing in the same place.
        let distance = -1;
        for (let kind = 0; kind < 2; kind++) {
          if (!announcementAt(bake, dir, age, kind, _ann)) continue;
          if (distance < 0) distance = mine ? 0 : consistDistance(bake, dir, trip, s, x, z);
          if (distance > ANNOUNCE_FETCH_RANGE) continue;
          out.wanted = true;
          if (distance > ANNOUNCE_RANGE) continue;
          if (kind === ANNOUNCE_ARRIVE) {
            if (distance >= bestArrive) continue;
            bestArrive = distance;
          } else {
            if (distance >= bestDepart) continue;
            bestDepart = distance;
          }
          const voice = kind === ANNOUNCE_ARRIVE ? out.arrive : out.depart;
          voice.active = true;
          voice.key = announceKey(dir, trip, _ann.call, kind);
          voice.offset = _ann.offset;
          voice.distance = distance;
          voice.inside = mine;
          voice.station = _ann.stop >= 0 ? dir.stops[_ann.stop].name : '';
          voice.line = dir.line.id;
        }
      }
    }
  }

  // The bed, after the sweep, because it is defined against what the sweep
  // found. Inside and at zero distance: there is nothing between the carriage
  // and the ear, which is `RailVoice.inside`'s whole purpose.
  if (ridePlays(aboard !== null, rideUnderway, out.arrive.active, out.depart.active)) {
    out.ride.active = true;
    out.ride.key = rideKey;
    out.ride.offset = rideEntry(rideKey, t);
    out.ride.distance = 0;
    out.ride.inside = true;
    out.ride.loop = true;
  }
  // Fetched on being aboard rather than on `wanted`: the bed is only ever heard
  // from inside, so a player on a platform should not pay three megabytes for
  // it.
  if (aboard !== null) out.wanted = true;
}

/**
 * A stable 32-bit name for one announcement. `rail.trainIdentity`'s argument and
 * its arithmetic: `Math.imul`, xor and unsigned shift, so every process names
 * the same sentence the same thing.
 *
 * The train's own identity mixed with the station and the clip, so one sentence
 * keeps one key for the whole of its 65 seconds and two never share.
 */
export function announceKey(
  dir: RailDirection, trip: number, call: number, kind: number,
): number {
  let h = trainIdentity(dir, trip);
  h ^= Math.imul((call * 2 + kind + 1) | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  // Never zero, because zero is what `AnnounceChannel.key` means by "nothing is
  // playing". A one-in-four-billion hash would otherwise restart its own
  // sentence sixty times a second for a minute, which is the kind of bug that
  // is found by a player and never by a test.
  return (h >>> 0) || 1;
}

/**
 * Metres from (x, z) to the nearest point on the nearest carriage's axis.
 *
 * Two steps, and the second is what makes it a train rather than eight points:
 * the nearest **carriage centre** comes from `riding.consistOffset` -- the
 * function `world/trains.ts` places the carriages with, so the sound is where
 * the metal is -- and then the listener is projected onto that carriage's own
 * heading and clamped to its length. Without the projection a passenger walking
 * a platform would hear the level swell and dip once every twenty metres; with
 * it, the train is a 163 m line source, which is what a train with a speaker in
 * every car is.
 *
 * `Math.sqrt` and not `Math.hypot`, on `game/rail.ts`'s rule: the root is the
 * only one ECMAScript specifies exactly.
 */
function consistDistance(
  bake: RailBake, dir: RailDirection, trip: number, s: number, x: number, z: number,
): number {
  const consist = consistOf(dir, trip);
  const n = consist.cars.length;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  let bdx = 1;
  let bdz = 0;
  for (let k = 0; k < n; k++) {
    const centre = consistOffset(s, k, n, consist.pitch);
    // The tail of a train that has only just left is behind the start of the
    // line. `world/trains.ts` parks those carriages; this ignores them.
    if (centre < 0) continue;
    sampleAlong(bake, dir, centre, _car);
    const dx = _car.x - x;
    const dz = _car.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      bx = _car.x;
      bz = _car.z;
      bdx = _car.dx;
      bdz = _car.dz;
    }
  }
  if (best === Infinity) return Infinity;
  const half = consist.pitch * 0.5;
  let along = (x - bx) * bdx + (z - bz) * bdz;
  if (along > half) along = half;
  else if (along < -half) along = -half;
  const px = bx + bdx * along - x;
  const pz = bz + bdz * along - z;
  return Math.sqrt(px * px + pz * pz);
}

// --- The HUD is right ------------------------------------------------------------------

/**
 * What `riding.rideBanner` would put after "next:" at arc length `s`.
 *
 * Its exact expression, lifted so a check can compare the announcement with the
 * banner without building a `RideBanner` and without a second reading of the
 * 30 m rule. **If the two ever disagree the HUD is right and this file has a
 * bug**, which is why the comparison is written against the banner's own call
 * rather than against a restatement of what it should return.
 */
export function bannerNextStop(dir: RailDirection, s: number): number {
  return nextCall(dir, s + 30);
}

// --- The module's own self-check --------------------------------------------------------

/**
 * Everything about the schedule that must be true before anything plays it.
 *
 * Run by `checkRailAnnouncements` in the integration suite and by the browser at
 * boot, for `verifyRail`'s reason: a self-check nothing runs is a self-check that
 * rots, and the browser is not in CI.
 *
 * The claims, in the order they would break:
 *
 *   1. **Every announcement is anchored to a real dwell.** `dir.arrivals[c]` is
 *      asserted to be an actual stationary phase by asking `rail.dwellElapsed`
 *      -- the function the doors are driven from -- what it says halfway through
 *      the stand. If a bake ever moved `arrivals` off the dwell, the doors and
 *      the announcements would drift together and neither would look wrong.
 *   2. **Nothing is announced for a station the service runs through**, which is
 *      the whole point of `callToStop` and the one thing a wrong index here
 *      would produce silently.
 *   3. **No two announcements of one kind overlap on one trip**, which is what
 *      licenses the single binary search in `announcementAt`.
 *   4. **A departure clip never runs into the next approach clip**, section 3.
 */
/**
 * The carriage bed's rule, over all sixteen states it can be asked about.
 *
 * The owner's sentence was *"play it when the train is MOVING/underway and when
 * the other 2 sounds arent playing"*, which is four booleans and one answer --
 * small enough that checking every case is cheaper than reasoning about any of
 * them, and worth doing because three of the four are things a bed getting
 * wrong would be heard as a bug in something else: a bed under a PA sentence
 * reads as the announcement being muddy, and a bed at a platform reads as the
 * doors being open on a moving train.
 */
export function verifyRideBed(): string[] {
  const failures: string[] = [];
  for (let mask = 0; mask < 16; mask++) {
    const aboard = (mask & 1) !== 0;
    const underway = (mask & 2) !== 0;
    const arriving = (mask & 4) !== 0;
    const departing = (mask & 8) !== 0;
    const want = aboard && underway && !arriving && !departing;
    const got = ridePlays(aboard, underway, arriving, departing);
    if (got !== want) {
      failures.push(
        `the carriage bed ${got ? 'plays' : 'is silent'} when aboard=${aboard},` +
          ` underway=${underway}, arriving=${arriving}, departing=${departing}`,
      );
    }
  }
  // The three that are worth naming, because each is a different complaint.
  if (ridePlays(true, false, false, false)) {
    failures.push('the bed plays at a dwell: a stopped train would sound like a moving one.');
  }
  if (ridePlays(true, true, true, false) || ridePlays(true, true, false, true)) {
    failures.push('the bed plays under an announcement, which is heard as the announcement being muddy.');
  }
  if (ridePlays(false, true, false, false)) {
    failures.push('the bed plays for somebody who is not on the train.');
  }
  if (RIDE_SECONDS <= 0 || !Number.isFinite(RIDE_SECONDS)) {
    failures.push(`RIDE_SECONDS is ${RIDE_SECONDS}; the loop position is a modulo by it.`);
  }

  // The entry point. In range for every key, because `source.start` with an
  // offset past the buffer plays silence and the rider hears a train that
  // stopped making noise; and spread across the file, because a jump that
  // clusters is the phase-lock this replaced.
  const buckets = new Set<number>();
  let spread = 0;
  for (let i = 0; i < 512; i++) {
    const key = (Math.imul(i + 1, 0x9e3779b1) ^ (i * 2654435761)) >>> 0 || 1;
    const at = rideEntry(key, 1234.5);
    if (!(at >= 0 && at < RIDE_SECONDS)) {
      failures.push(`rideEntry(${key}) is ${at}, outside [0, ${RIDE_SECONDS}).`);
      break;
    }
    if (rideEntry(key, 1234.5) !== at) {
      failures.push('rideEntry is not a function of its arguments; a carriage would disagree with itself.');
      break;
    }
    buckets.add(Math.floor((at / RIDE_SECONDS) * 8));
    spread++;
  }
  if (spread === 512 && buckets.size < 8) {
    failures.push(`512 legs entered the recording in ${buckets.size} of 8 places; the jump is not spreading.`);
  }
  // Two legs of one trip must not land together, which is the whole point.
  if (rideEntry(1, 0) === rideEntry(2, 0)) {
    failures.push('consecutive legs enter the recording at the same second.');
  }
  return failures;
}

export function verifyRailAudio(bake: RailBake): string[] {
  const bad: string[] = [];
  const half = bake.physics.dwell * 0.5;
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const A = dir.arrivals;
      const where = `${line.id} dir ${dir.index}`;
      if (A.length === 0) {
        bad.push(`${where} has no arrivals`);
        continue;
      }
      let calling = 0;
      for (const st of dir.stops) if (st.calls) calling++;
      if (calling !== A.length) {
        bad.push(`${where} calls at ${calling} stations and has ${A.length} arrivals`);
      }
      for (let c = 1; c < A.length; c++) {
        if (A[c] <= A[c - 1]) {
          bad.push(`${where} reaches call ${c} at ${A[c]} s, not after call ${c - 1} at ${A[c - 1]} s`);
          break;
        }
      }
      for (let c = 0; c < A.length; c++) {
        const stop = callToStop(dir, c);
        // 2.
        if (stop < 0 || !dir.stops[stop].calls) {
          bad.push(`${where} call ${c} maps to stop ${stop}, which is not a call`);
          continue;
        }
        const name = dir.stops[stop].name;
        // 1.
        if (announces(dir, c, ANNOUNCE_DEPART)) {
          const stood = dwellElapsed(bake, dir, A[c] + half);
          if (Math.abs(stood - half) > 1e-9) {
            bad.push(
              `${where} at ${name}: arrivals says the doors open at ${A[c].toFixed(1)} s, but ` +
                `${half} s later the train has been standing ${stood.toFixed(3)} s`,
            );
          }
        }
        // 3 and 4.
        for (let kind = 0; kind < 2; kind++) {
          if (!announces(dir, c, kind)) continue;
          const end = announceEnd(bake, dir, c, kind);
          const label = kind === ANNOUNCE_ARRIVE ? 'approach' : 'departure';
          if (end > dir.duration + 1e-9) {
            bad.push(`${where}: the ${label} clip for ${name} runs ${(end - dir.duration).toFixed(1)} s past the trip`);
          }
          for (let d = c + 1; d < A.length; d++) {
            if (announces(dir, d, kind) && announceStart(bake, dir, d, kind) < end - 1e-9) {
              bad.push(
                `${where}: the ${label} clip for ${name} runs to ${end.toFixed(1)} s and the next ` +
                  `one starts at ${announceStart(bake, dir, d, kind).toFixed(1)} s`,
              );
            }
            if (
              kind === ANNOUNCE_DEPART && announces(dir, d, ANNOUNCE_ARRIVE) &&
              announceStart(bake, dir, d, ANNOUNCE_ARRIVE) < end - 1e-9
            ) {
              bad.push(
                `${where}: the departure clip for ${name} runs to ${end.toFixed(1)} s and the approach ` +
                  `into ${dir.stops[callToStop(dir, d)]?.name ?? '?'} starts at ` +
                  `${announceStart(bake, dir, d, ANNOUNCE_ARRIVE).toFixed(1)} s`,
              );
            }
            break;
          }
        }
      }
    }
  }
  return bad;
}
