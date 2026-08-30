/*
 * carradio.ts -- one `<audio>` element, and the reasons it is only that.
 *
 * `game/radio.ts` holds the stations and the argument for which six they are.
 * This is the half that makes noise: it owns a single element, points it at a
 * station when the player gets into a car, and stops it when they get out.
 *
 * **A plain element rather than Web Audio**, which is a real choice and not
 * laziness. Routing this through a `MediaElementAudioSourceNode` would buy
 * ducking under the engine and a muffle when the camera is outside the car, and
 * it would cost the one failure mode nobody can debug from a bug report: the
 * Web Audio spec says such a node "MUST output silence" -- not throw, not warn
 * -- if the media was fetched cross-origin without CORS. Every station in the
 * list sends `Access-Control-Allow-Origin: *` and the element is marked
 * `crossorigin` so that door stays open, but until something actually wants
 * ducking, a bare element is the version that cannot fail quietly.
 *
 * **Stopping means dropping the source, not pausing.** A paused `<audio>` on a
 * live Icecast mount keeps its connection and keeps pulling bytes, which is a
 * player's data plan spent on a car they got out of ten minutes ago. `leave`
 * clears `src` and calls `load`, which is the only thing that actually hangs up.
 *
 * **Autoplay is allowed to refuse and that is not an error.** Getting into a car
 * is a keypress, so the gesture requirement is satisfied in the normal case --
 * but a player who has never interacted with the tab, or a browser with media
 * blocked for the site, will reject the play promise. The radio stays silent and
 * the game does not care; the next time they get in, it tries again.
 *
 * **A station that is dark is skipped, once.** Community mounts go down. An
 * `error` on the element advances to the next station rather than retrying the
 * same dead one, and gives up after a lap so a network that is entirely gone
 * does not become a loop of failing requests.
 */

import { STATIONS, stationAt, stationFor, type Station } from './game/radio.ts';

/**
 * How loud the radio sits under everything else, at full fade-in.
 *
 * 30% down on the 0.55 it shipped at, on the owner's ear: a car radio is
 * something you hear the city over, not something that replaces it.
 */
const RADIO_VOLUME = 0.385;

/**
 * How long the fade takes in each direction, seconds.
 *
 * A stream that starts at full volume the instant a door shuts is a jump-scare,
 * and one that stops dead is worse -- an Icecast mount cut mid-word reads as a
 * bug rather than as getting out of a car. A second either way is long enough
 * to feel deliberate and short enough that nobody waits for it.
 */
const FADE_S = 1;

export class CarRadio {
  private readonly el: HTMLAudioElement | null;
  private index = 0;
  /** Stations tried since the last successful `enter`, to stop a dead-air loop. */
  private tried = 0;
  private on = false;
  /** The fade, 0..1, as a fraction of `RADIO_VOLUME`. */
  private level = 0;
  private target = 0;
  /**
   * Set while a fade-out is still running, so the hang-up waits for silence.
   *
   * Dropping `src` the moment the player steps out would cut the stream mid-fade
   * and make the fade pointless; keeping the connection open forever after would
   * be the bug the header is about. So the disconnect is what happens at the
   * *end* of the fade, and this is the flag that remembers one is owed.
   */
  private hangUp = false;

  constructor(doc: Document = document) {
    if (typeof doc.createElement !== 'function') {
      this.el = null;
      return;
    }
    const el = doc.createElement('audio');
    // See the header: this costs nothing today and is what keeps Web Audio
    // available later without a silent failure.
    el.crossOrigin = 'anonymous';
    el.preload = 'none';
    el.volume = 0;
    el.addEventListener('error', () => {
      // Dark mount. Move along rather than sit on it, but only a lap's worth --
      // a player with no network would otherwise generate one request per
      // station forever.
      if (!this.on || this.tried >= STATIONS.length) return;
      this.tried++;
      this.tune(this.index + 1);
    });
    this.el = el;
  }

  /** What the HUD would say, or `null` when the radio is off. */
  get nowPlaying(): Station | null {
    return this.on ? stationAt(this.index) : null;
  }

  /**
   * Get in and turn it on. `roll` is a number in `[0, 1)`; the caller owns the
   * randomness so a check can pin the station.
   */
  enter(roll: number): void {
    if (this.el === null || this.on) return;
    this.on = true;
    this.tried = 0;
    this.hangUp = false;
    this.target = 1;
    this.tune(stationFor(roll));
  }

  /**
   * Get out. Fades down, then drops the connection -- see the header on why the
   * disconnect matters and `FADE_S` on why it waits.
   */
  leave(): void {
    if (this.el === null || !this.on) return;
    this.on = false;
    this.target = 0;
    this.hangUp = true;
  }

  /**
   * One frame of fade. Called from the frame loop.
   *
   * A linear ramp rather than the exponential ease used everywhere else in this
   * codebase, and for one reason: an exponential never actually reaches its
   * target, so the hang-up at the bottom of a fade-out would never fire and the
   * connection would stay open at an inaudible volume forever.
   */
  update(dt: number): void {
    const el = this.el;
    if (el === null) return;
    if (this.level !== this.target) {
      const rate = dt > 0 ? dt / FADE_S : 1;
      this.level =
        this.level < this.target
          ? Math.min(this.target, this.level + rate)
          : Math.max(this.target, this.level - rate);
      el.volume = this.level * RADIO_VOLUME;
    }
    if (this.hangUp && this.level <= 0) {
      this.hangUp = false;
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /** Next station, wrapping. A player pressing this has cleared the dead-air count. */
  next(): void {
    if (!this.on) return;
    this.tried = 0;
    this.tune(this.index + 1);
  }

  private tune(i: number): void {
    if (this.el === null) return;
    const n = STATIONS.length;
    this.index = ((i % n) + n) % n;
    this.el.src = stationAt(this.index).url;
    // The rejection is the autoplay policy far more often than it is a broken
    // stream, and neither is worth a console line in a game somebody is playing.
    void this.el.play().catch(() => {});
  }
}

export function verifyCarRadio(): string[] {
  const failures: string[] = [];
  // A stand-in element, because a check may not touch the real DOM.
  const make = (): Record<string, unknown> => ({
    crossOrigin: '',
    preload: '',
    volume: 0,
    src: '',
    played: 0,
    loaded: 0,
    paused: 0,
    addEventListener: () => {},
    removeAttribute(this: Record<string, unknown>) {
      this.src = '';
    },
    load(this: Record<string, unknown>) {
      this.loaded = (this.loaded as number) + 1;
    },
    pause(this: Record<string, unknown>) {
      this.paused = (this.paused as number) + 1;
    },
    play(this: Record<string, unknown>) {
      this.played = (this.played as number) + 1;
      return Promise.resolve();
    },
  });
  let el: Record<string, unknown> = make();
  const doc = { createElement: () => el } as unknown as Document;

  const radio = new CarRadio(doc);
  if (radio.nowPlaying !== null) failures.push('the radio was playing before anybody got into a car.');
  if (el.crossOrigin !== 'anonymous') {
    failures.push('the element is not marked crossorigin; routing it through Web Audio later would output silence.');
  }

  radio.enter(0);
  if (radio.nowPlaying?.name !== STATIONS[0].name) failures.push('a roll of 0 did not tune the first station.');
  if (el.src !== STATIONS[0].url) failures.push(`the element was pointed at "${String(el.src)}".`);
  if ((el.played as number) !== 1) failures.push('getting into a car did not start playback.');

  // Getting in again while already in must not restart the stream.
  radio.enter(0.9);
  if ((el.played as number) !== 1) failures.push('a second `enter` re-tuned a radio that was already on.');

  radio.next();
  if (radio.nowPlaying?.name !== STATIONS[1].name) failures.push('the dial did not advance.');

  // --- The fade in.
  //
  // It starts silent and arrives at the reduced ceiling, not at 1. A radio that
  // starts at full volume the instant a door shuts is a jump-scare.
  if ((el.volume as number) !== 0) failures.push(`the radio started at volume ${String(el.volume)} rather than silent.`);
  const frame = 1 / 60;
  for (let i = 0; i < 30; i++) radio.update(frame);
  const half = el.volume as number;
  if (half <= 0 || half >= 0.385) failures.push(`half a second into the fade the volume was ${half}; it is not ramping.`);
  for (let i = 0; i < 40; i++) radio.update(frame);
  if (Math.abs((el.volume as number) - 0.385) > 1e-9) {
    failures.push(`after a full fade the volume was ${String(el.volume)}, not the 0.385 ceiling.`);
  }

  radio.leave();
  if (radio.nowPlaying !== null) failures.push('the radio kept playing after the player got out.');
  // **The hang-up waits for silence.** Cutting the stream on the frame the
  // player steps out makes the fade pointless; never cutting it is the bug the
  // header is about. So mid-fade the source is still there and still audible.
  radio.update(frame);
  if (el.src === '') failures.push('the stream was cut on the first frame of the fade-out; the fade does nothing.');
  if ((el.volume as number) >= 0.385) failures.push('the fade-out did not start.');
  for (let i = 0; i < 90; i++) radio.update(frame);
  if ((el.volume as number) !== 0) failures.push(`the fade-out stalled at ${String(el.volume)}.`);
  // Pausing is not hanging up: a paused element on a live mount keeps pulling
  // bytes. `src` must be gone and the element reloaded.
  if (el.src !== '') failures.push('the fade finished but the source is still attached; it keeps downloading.');
  if ((el.loaded as number) < 1) failures.push('the fade finished without a `load()`; the connection stays open.');
  // And the hang-up happens once, not every frame after.
  const loadsAfter = el.loaded as number;
  for (let i = 0; i < 10; i++) radio.update(frame);
  if ((el.loaded as number) !== loadsAfter) failures.push('the element is being reloaded every frame after the fade.');

  // A play() that rejects -- the autoplay policy -- must not throw.
  el = make();
  el.play = () => Promise.reject(new Error('NotAllowedError'));
  const blocked = new CarRadio({ createElement: () => el } as unknown as Document);
  try {
    blocked.enter(0);
  } catch (err) {
    failures.push(`a browser refusing autoplay threw into the frame: ${String(err)}`);
  }

  // No document at all (a check host, a worker) must be a silent no-op.
  const headless = new CarRadio({} as unknown as Document);
  headless.enter(0.5);
  headless.next();
  headless.leave();
  if (headless.nowPlaying !== null) failures.push('a radio with no document claimed to be playing.');
  return failures;
}
