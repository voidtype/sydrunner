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

/** How loud the radio sits under everything else. */
const RADIO_VOLUME = 0.55;

export class CarRadio {
  private readonly el: HTMLAudioElement | null;
  private index = 0;
  /** Stations tried since the last successful `enter`, to stop a dead-air loop. */
  private tried = 0;
  private on = false;

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
    el.volume = RADIO_VOLUME;
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
    this.tune(stationFor(roll));
  }

  /** Get out. Drops the connection rather than pausing it -- see the header. */
  leave(): void {
    if (this.el === null || !this.on) return;
    this.on = false;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
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

  radio.leave();
  if (radio.nowPlaying !== null) failures.push('the radio kept playing after the player got out.');
  // Pausing is not hanging up: a paused element on a live mount keeps pulling
  // bytes. `src` must be gone and the element reloaded.
  if (el.src !== '') failures.push('leaving the car left a source on the element; it keeps downloading.');
  if ((el.loaded as number) < 1) failures.push('leaving the car did not `load()`; the connection stays open.');

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
