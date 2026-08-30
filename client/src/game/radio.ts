/*
 * radio.ts -- what plays when you get in, and why the list is six stations long.
 *
 * The owner asked for real Australian radio in the car: get in, a random station
 * starts. The research that shaped this file is worth stating, because every
 * constraint below is a decision somebody will otherwise reopen.
 *
 * **The blocker is legal, not technical.** Every commercial stream tested is
 * HTTPS with open CORS and would play today. What stops them is their own terms:
 * SCA (Triple M, 2Day FM) expressly prohibits making its content available from
 * another service *including in-line links and frames*; ARN (KIIS, WSFM) bars
 * linking beyond its homepage and framing without written permission; SBS
 * prohibits embedding and deep-linking. And *Warner v TuneIn* [2021] EWCA Civ
 * 441 held that an aggregator linking to third-party streams while keeping
 * users on its own page infringes -- not binding in Australia, but it is the end
 * of the "it is only a link" defence. So the list is the ABC, whose terms carry
 * no anti-framing clause, plus two Sydney community stations. It is shorter than
 * it could be on purpose.
 *
 * **No proxy, ever.** `PERFORMANCE.md` puts the box at a 20 GB monthly egress
 * cap and calls it egress-bound. Proxied radio is about 22 MB per listener-hour
 * at 48 kbps and double that inbound; five people listening continuously is four
 * times the monthly cap. Played direct from the station, the box pays nothing
 * at all, and that is the entire argument.
 *
 * **No runtime call to radio-browser.info either**, although that is where the
 * list came from. Their AU-and-HTTPS query is 545 kB of JSON for 472 stations,
 * their `is_https` flag under-reports, and entries rot. A curated list is
 * smaller than the query that would have found it.
 *
 * **The URLs are the ones the stream actually lives at, not the ones the ABC
 * publishes.** `live-radio01.mediahubaustralia.com/2LRW/aac/` is a 301 to
 * `abc.streamguys1.com/live/localsydney/icecast.audio`, and the redirect itself
 * carries no `Access-Control-Allow-Origin`. A plain `<audio src>` would not care
 * -- it needs no CORS at all, only https -- but the moment this is routed
 * through Web Audio for ducking or muffling, CORS becomes mandatory and a
 * redirect without it fails. Worse, the Web Audio spec says the node "MUST
 * output silence" rather than erroring, so the failure would be a car radio that
 * is simply quiet. Following the redirect here costs nothing and closes that
 * door before somebody walks into it.
 *
 * If a station moves, this list is wrong and the fix is to edit it. That is the
 * trade for having no runtime dependency, and `verifyRadio` holds the shape
 * while `scripts/radio-audit.sh` is what re-checks the liveness.
 */

/** One station. `name` is what the HUD says; `url` is what the element plays. */
export interface Station {
  readonly name: string;
  readonly url: string;
  /** For the audit script and for a reader deciding what to add. */
  readonly codec: 'aac' | 'mp3';
}

/**
 * The stations, Sydney first.
 *
 * Every one verified by hand: HTTPS, 200, `Access-Control-Allow-Origin: *`, and
 * a host that is a name rather than a bare IP -- browsers do not upgrade
 * `http://<ip>` to https, so an IP host is a stream that can never be played
 * from this page whatever its terms say.
 */
export const STATIONS: readonly Station[] = [
  { name: 'ABC Radio Sydney', url: 'https://abc.streamguys1.com/live/localsydney/icecast.audio', codec: 'aac' },
  { name: 'triple j', url: 'https://abc.streamguys1.com/live/triplejnsw/icecast.audio', codec: 'aac' },
  { name: 'Double J', url: 'https://abc.streamguys1.com/live/doublejnsw/icecast.audio', codec: 'aac' },
  { name: 'ABC Radio National', url: 'https://abc.streamguys1.com/live/rnnsw/icecast.audio', codec: 'aac' },
  { name: 'FBi 94.5', url: 'https://streamer.fbiradio.com/stream', codec: 'mp3' },
  { name: '2SER 107.3', url: 'https://icecast1.myradio.click/streamrelay', codec: 'mp3' },
];

/** The station at `i`, wrapped. Negative indices wrap too, so `prev` is free. */
export function stationAt(i: number): Station {
  const n = STATIONS.length;
  return STATIONS[((i % n) + n) % n];
}

/**
 * A station index from a number in `[0, 1)`.
 *
 * Takes the roll rather than making it, so the caller owns the randomness and
 * a check can pin it. Nothing here is simulated on both ends -- a radio is
 * cosmetic and client-only -- but a function that reaches for `Math.random`
 * itself is one a check cannot hold still.
 */
export function stationFor(roll: number): number {
  const r = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return Math.floor(r * STATIONS.length);
}

export function verifyRadio(): string[] {
  const failures: string[] = [];
  if (STATIONS.length === 0) failures.push('no stations; getting into a car would do nothing.');
  const seen = new Set<string>();
  for (const s of STATIONS) {
    if (!s.url.startsWith('https://')) {
      failures.push(`${s.name} is not https; the page is, so the browser would block it as mixed content.`);
    }
    let host = '';
    try {
      host = new URL(s.url).hostname;
    } catch {
      failures.push(`${s.name} has a URL the browser cannot parse: ${s.url}`);
      continue;
    }
    // A bare IP is never upgraded to https by the browser and can never carry a
    // certificate this page will accept.
    if (/^[0-9.]+$/.test(host) || host.includes(':')) {
      failures.push(`${s.name} points at a bare IP (${host}); that stream can never play from an https page.`);
    }
    if (s.name.trim() === '') failures.push(`a station with url ${s.url} has no name for the HUD.`);
    if (seen.has(s.url)) failures.push(`${s.name} repeats a url already in the list; one station would never be heard.`);
    seen.add(s.url);
  }

  // The roll covers every station and only those.
  const hit = new Set<number>();
  for (let i = 0; i <= 1000; i++) hit.add(stationFor(i / 1000));
  if (hit.size !== STATIONS.length) {
    failures.push(`a full sweep of the roll reached ${hit.size} of ${STATIONS.length} stations.`);
  }
  if (stationFor(0) !== 0) failures.push('a roll of 0 did not pick the first station.');
  if (stationFor(1) !== STATIONS.length - 1) failures.push('a roll of 1 fell off the end of the list.');
  if (stationFor(Number.NaN) !== 0) failures.push('a NaN roll did not fall back to a real station.');

  // Wrapping, in both directions, so `next` and `prev` are one function.
  if (stationAt(STATIONS.length) !== STATIONS[0]) failures.push('the dial did not wrap forwards.');
  if (stationAt(-1) !== STATIONS[STATIONS.length - 1]) failures.push('the dial did not wrap backwards.');
  return failures;
}
