/**
 * The clock: top centre, and the one part of this HUD that is about *when* you
 * are rather than what you have.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, and why it is this one.
 *
 * Majora's Mask drew the day as a horizontal bar with the sun sliding along it,
 * and the reason it worked is not the bar -- it is that the marker's **position
 * answered two questions at once**: how far through, and how long left. Neither
 * had to be read; both were seen. The numerals underneath were confirmation.
 *
 * This is that, laid out so the *form itself* says which half of the cycle you
 * are in before you have looked at anything:
 *
 *     [moon]  (   · · · | · · ·   )  [sun]
 *                    19:04
 *
 *   - **The dial is one full cycle, and it starts at sunset.** Left edge is the
 *     moment the sun goes down, the middle is sunrise, the right edge is the
 *     next sunset. So the left half is the night, the right half is the day, and
 *     the marker crossing the centre line *is* dawn. Nothing has to be labelled.
 *   - **The two glyphs live outside the dial, one at each end**, and they are the
 *     halves rather than decoration: the moon owns the night half it sits beside
 *     and the sun owns the day half. Whichever half you are in is lit and the
 *     other is dimmed, so the answer to "is it day" is legible at the edge of
 *     vision, at a glance, with no reading at all.
 *   - **The travelling marker is the body that is actually up** -- a sun by day, a
 *     crescent by night -- crossfaded on `nightLevel`, so it changes over at
 *     exactly the moment the street lamps do.
 *   - **Twelve ticks**, one per 1/12 of the cycle: five real minutes, two game
 *     hours. They are what make it read as an instrument rather than as a
 *     progress bar, and they give the eye something to measure the marker
 *     against.
 *
 * The first version of this was a thin arc with a dot riding it, drawn as bare
 * strokes over the world, and it read as a progress widget rather than as a
 * clock. Two things changed: it **commits to being a dial** -- ends, ticks, a
 * divider, real glyphs -- and it sits on **the interface's own panel**.
 *
 * ---------------------------------------------------------------------------
 * WHY IT HAS A BACKGROUND WHEN `#help` AND `#locator` DO NOT.
 *
 * `index.html` states the rule those two follow -- a persistent element with a
 * background is a persistent hole in the picture -- and this deliberately does
 * not follow it, for `#minimap`'s reason. The map is the other permanent
 * *instrument* in this HUD and it carries the same `rgba(10,14,20,.55)` panel,
 * because an instrument has to be readable against every background the game can
 * put behind it. The background this one is guaranteed to sit over is **a bright
 * noon sky**, which tone maps to rgb(114, 166, 249) at the zenith and
 * rgb(238, 250, 254) in the haze band -- and `#cfe2f2` is rgb(207, 226, 242).
 * Bare strokes in the interface colour over the haze band are a two-code-value
 * contrast. There is no drop shadow that fixes that; the panel does.
 *
 * ---------------------------------------------------------------------------
 * DREAD.
 *
 * The other half of what Majora's clock did was communicate that something was
 * coming, and that matters more here than it would have a month ago: raves and
 * police both behave differently after dark, so nightfall happens *to* the
 * player rather than being a change of palette.
 *
 * Three things escalate together over the last five real minutes of daylight,
 * all driven by one number -- `secondsToEdge` off `SkyClock`:
 *
 *   - the last stretch of the day half warms from the interface blue-grey to the
 *     amber `#e8b9a8`, which is the *existing* warm tone in this stylesheet (the
 *     footy bar, a player's own chat line) rather than a new colour. Red is
 *     `#f0a9a0` and `index.html` states it means exactly one thing -- the last
 *     health pip, and the police -- so a sunset must not borrow it.
 *   - a countdown appears under the numerals: `sundown 2:41`.
 *   - the dial takes a slow two-second pulse, at the shallow depth
 *     `#investigation` uses, off under `prefers-reduced-motion`.
 *
 * The same countdown runs for the last five minutes before sunrise, saying
 * `sunup 1:12`, without the warmth or the pulse: a player who has survived the
 * night wants that number, and it is news rather than a warning.
 * ---------------------------------------------------------------------------
 *
 * Cost: the SVG is written once. Per frame this compares five numbers and writes
 * a `transform` when the marker has moved a third of a unit -- at 220 units of
 * track per real hour, about once every 16 seconds -- plus a `textContent` when
 * the game minute rolls over, about once every 2.5 real seconds. A frame that
 * changes nothing touches the DOM not at all.
 */

import { SUNRISE_PHASE, SUNSET_PHASE, type SkyClock } from './cycle.ts';

/* ===========================================================================
 * The dial's geometry, in the SVG's own user units. The element is scaled by
 * CSS, so these are a layout rather than a pixel size.
 * ========================================================================= */

/** The dial panel's viewBox. */
export const DIAL_WIDTH = 252;
export const DIAL_HEIGHT = 45;

/** The track: the two ends of the run the marker makes, and its height. */
export const TRACK_X0 = 18;
export const TRACK_X1 = 234;
export const TRACK_Y = 16;

/** How many divisions the track is marked into. See the header: 1/12 is 2 game hours. */
export const TICKS = 12;

/**
 * Where the marker sits for a given cycle phase, in dial units.
 *
 * Pure and exported so `verifyClock` can assert it without a DOM, which is the
 * only way to check the thing that actually goes wrong here: a dial whose
 * landmarks have quietly shifted. The symptom of getting it wrong is a clock
 * that looks like a clock and is a quarter of a cycle out, which reads as the
 * time of day being wrong rather than as this function being wrong.
 *
 *     phase 0.75 (sunset)   -> the left end        (dial 0.00)
 *     phase 0.00 (midnight) -> a quarter along     (dial 0.25)
 *     phase 0.25 (sunrise)  -> the centre line     (dial 0.50)
 *     phase 0.50 (noon)     -> three quarters      (dial 0.75)
 *     phase 0.75 (sunset)   -> the right end       (dial 1.00)
 *
 * Sunset is both ends, because it is where the dial is cut -- and it is cut
 * there rather than at midnight so that the night is the left half and the day
 * is the right, which is what lets the two glyphs outside the ends mean the two
 * halves.
 */
export function dialProgress(phase: number): number {
  return (((phase - SUNSET_PHASE) % 1) + 1) % 1;
}

/** The same, as an x in dial units. */
export function dialX(phase: number): number {
  return TRACK_X0 + dialProgress(phase) * (TRACK_X1 - TRACK_X0);
}

/**
 * How much dread: 0 with the edge comfortably away, 1 at the moment it arrives.
 *
 * Five real minutes, which is a sixth of a half-cycle and is the same span the
 * light itself spends changing -- the golden hour, the sunset and the dusk
 * together run 278 real seconds. So the clock starts warning at almost exactly
 * the moment the sky starts to turn, and the two escalate as one event rather
 * than the HUD announcing something the window has not shown yet.
 *
 * Squared, so the first three of those five minutes are a hint and the last two
 * are the warning. A linear ramp reads as "this is always a bit on".
 */
export const DREAD_SECONDS = 300;

export function dreadLevel(secondsToEdge: number): number {
  const t = Math.min(Math.max(1 - secondsToEdge / DREAD_SECONDS, 0), 1);
  return t * t;
}

/** `m:ss`, for the countdown. */
function countdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A sun: a disc and eight rays, drawn about the origin so the same markup serves
 * both the end glyph and the travelling marker at two different scales.
 */
function sunGlyph(id: string, radius: number, ray: number): string {
  const rays: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const inner = radius + ray * 0.55;
    const outer = radius + ray * 1.55;
    rays.push(
      `M ${(c * inner).toFixed(2)} ${(s * inner).toFixed(2)} L ${(c * outer).toFixed(2)} ${(s * outer).toFixed(2)}`,
    );
  }
  return (
    `<g id="${id}" class="sun">` +
    `<circle r="${radius}"/>` +
    `<path class="rays" id="${id}-rays" d="${rays.join(' ')}"/>` +
    `</g>`
  );
}

/**
 * A crescent, as a single closed **path** -- two arcs, one out and one back.
 *
 * The obvious cheap crescent is a light disc with a dark disc drawn over it, and
 * it only works over a solid background; this one travels over a translucent
 * panel over a city, so the bite has to be genuinely absent. A mask does that
 * and was the first version. A path does it too, and does one more thing a mask
 * cannot: **it has an outline.** The end glyphs are drawn hollow when their half
 * of the cycle is not the current one (see `SkyClockHud.update`), and a hollow
 * shape needs a stroke to still be a shape.
 *
 * That mattered more than it sounds. The first version dimmed the inactive glyph
 * to 0.3 opacity, and `#cfe2f2` at 0.3 over the noon haze band -- rgb(238, 250,
 * 254) -- is invisible. Half the widget's meaning disappeared in exactly the
 * conditions it has to work in.
 *
 * The outer arc is the moon's limb and the inner one is the terminator, drawn at
 * 1.3x the radius so the crescent is about a third of the disc: any fatter and
 * it reads as a bitten circle, any thinner and it disappears at 10 px.
 */
function moonGlyph(id: string, radius: number): string {
  const r = radius.toFixed(2);
  const inner = (radius * 1.3).toFixed(2);
  return (
    `<g id="${id}" class="moon">` +
    `<path d="M 0 ${-radius} A ${r} ${r} 0 0 1 0 ${radius} A ${inner} ${inner} 0 0 0 0 ${-radius} Z"/>` +
    `</g>`
  );
}

/**
 * The dial's own markup, built once.
 *
 * Written here rather than in `index.html` for the reason the health pips are:
 * where everything sits is derived from constants that belong to this feature,
 * and putting the geometry in the markup would put the dial's shape a file away
 * from the arithmetic that places the marker on it. `index.html` owns one empty
 * `<div id="clock">` and the CSS.
 *
 * Two details are load-bearing:
 *
 *   - `vector-effect: non-scaling-stroke` on the track and the ticks, so the CSS
 *     transform that shrinks the dial on a short window does not thin the lines
 *     away to nothing.
 *   - the sun and the moon are **both always present** in the marker group, one
 *     of them at zero opacity. Building or removing a node at sunset would be a
 *     layout and a paint at the one moment of the cycle with the most going on.
 */
function markup(): string {
  const mid = (TRACK_X0 + TRACK_X1) / 2;
  const ticks: string[] = [];
  for (let i = 1; i < TICKS; i++) {
    if (i === TICKS / 2) continue; // the sunrise divider is drawn on its own
    const x = TRACK_X0 + ((TRACK_X1 - TRACK_X0) * i) / TICKS;
    ticks.push(`<line x1="${x.toFixed(2)}" y1="${TRACK_Y - 3.5}" x2="${x.toFixed(2)}" y2="${TRACK_Y + 3.5}"/>`);
  }
  return `
<div class="glyph left">
  <svg viewBox="-14 -14 28 28" aria-hidden="true">${moonGlyph('clock-moon-end', 8)}</svg>
</div>
<div class="dial">
  <svg viewBox="0 0 ${DIAL_WIDTH} ${DIAL_HEIGHT}" aria-hidden="true">
    <line class="track night" x1="${TRACK_X0}" y1="${TRACK_Y}" x2="${mid}" y2="${TRACK_Y}"/>
    <line class="track day" x1="${mid}" y1="${TRACK_Y}" x2="${TRACK_X1}" y2="${TRACK_Y}"/>
    <line class="track dusk" id="clock-dusk" x1="${mid}" y1="${TRACK_Y}" x2="${TRACK_X1}" y2="${TRACK_Y}"/>
    <g class="ticks">${ticks.join('')}</g>
    <line class="divider" x1="${mid}" y1="${TRACK_Y - 7}" x2="${mid}" y2="${TRACK_Y + 7}"/>
    <line class="cap" x1="${TRACK_X0}" y1="${TRACK_Y - 6}" x2="${TRACK_X0}" y2="${TRACK_Y + 6}"/>
    <line class="cap" x1="${TRACK_X1}" y1="${TRACK_Y - 6}" x2="${TRACK_X1}" y2="${TRACK_Y + 6}"/>
    <g id="clock-marker">
      <circle class="halo" id="clock-halo" r="10"/>
      ${sunGlyph('clock-sun', 4.2, 2.2)}
      ${moonGlyph('clock-moon', 5)}
    </g>
    <text class="time" id="clock-time" x="${mid}" y="35">--:--</text>
    <text class="edge" id="clock-edge" x="${mid}" y="44"></text>
  </svg>
</div>
<div class="glyph right">
  <svg viewBox="-14 -14 28 28" aria-hidden="true">${sunGlyph('clock-sun-end', 5.4, 2.6)}</svg>
</div>`;
}


/**
 * Write an opacity that a stylesheet rule cannot take back.
 *
 * See the note in `update`: `setAttribute('opacity', ...)` is a presentation
 * attribute and loses to `#clock .halo { opacity: .26 }`, so the halo drew a
 * grey disc behind the moon all night while the code that was supposed to hide
 * it ran correctly every frame.
 */
function setOpacity(el: SVGElement | null, value: number): void {
  if (el) el.style.opacity = value.toFixed(3);
}

function setFillOpacity(el: SVGElement | null, value: number): void {
  if (el) el.style.fillOpacity = value.toFixed(3);
}

/**
 * The clock, wired to a `#clock` element.
 *
 * Constructed once by `main.ts` and fed the `SkyClock` the sky already computed
 * for the frame, rather than reading the wall clock itself. That is not a
 * micro-optimisation: it is what makes the HUD agree with the window while a
 * developer is scrubbing with `[` and `]`, which a clock with its own
 * `Date.now()` would not.
 */
export class SkyClockHud {
  private readonly root = document.getElementById('clock');
  private readonly marker: SVGGElement | null;
  private readonly sun: SVGGElement | null;
  private readonly moon: SVGGElement | null;
  private readonly halo: SVGCircleElement | null;
  private readonly sunEnd: SVGGElement | null;
  private readonly sunRays: SVGPathElement | null;
  private readonly moonEnd: SVGGElement | null;
  private readonly duskTrack: SVGLineElement | null;
  private readonly timeText: SVGTextElement | null;
  private readonly edgeText: SVGTextElement | null;

  /** What was last written, so a frame that changes nothing writes nothing. */
  private lastX = NaN;
  private lastLabel = '';
  private lastEdge = '';
  private lastDread = -1;
  private lastNight = -1;

  constructor() {
    if (!this.root) {
      // Not fatal and not silent. The clock is cosmetic, but a missing element
      // means `index.html` and this file have come apart, and the symptom -- no
      // clock -- is indistinguishable from a feature nobody merged.
      console.warn('[clock] No #clock element in the document; the day/night clock will not draw.');
    }
    if (this.root) this.root.innerHTML = markup();
    const pick = <T extends Element>(id: string): T | null =>
      (document.getElementById(id) as unknown as T) ?? null;
    this.marker = pick<SVGGElement>('clock-marker');
    this.sun = pick<SVGGElement>('clock-sun');
    this.moon = pick<SVGGElement>('clock-moon');
    this.halo = pick<SVGCircleElement>('clock-halo');
    this.sunEnd = pick<SVGGElement>('clock-sun-end');
    this.sunRays = pick<SVGPathElement>('clock-sun-end-rays');
    this.moonEnd = pick<SVGGElement>('clock-moon-end');
    this.duskTrack = pick<SVGLineElement>('clock-dusk');
    this.timeText = pick<SVGTextElement>('clock-time');
    this.edgeText = pick<SVGTextElement>('clock-edge');
  }

  /**
   * Draw. Called every frame with the sky's own clock.
   *
   * Every write is guarded by a comparison, and the thresholds are chosen so
   * that the guards are the common case.
   */
  update(clock: SkyClock): void {
    if (!this.root) return;

    const x = dialX(clock.phase);
    if (!(Math.abs(x - this.lastX) < 0.33)) {
      this.lastX = x;
      // `transform` on the group rather than `cx` on three shapes: one attribute
      // instead of several, and the crescent's mask is authored around the
      // origin so it travels with the moon rather than staying behind it.
      this.marker?.setAttribute('transform', `translate(${x.toFixed(2)} ${TRACK_Y})`);
    }

    if (clock.label !== this.lastLabel) {
      this.lastLabel = clock.label;
      if (this.timeText) this.timeText.textContent = clock.label;
    }

    // Sun or moon, on the marker and on the two end glyphs, crossfaded on
    // `nightLevel` rather than switched on `isDay`. The marker is sitting on the
    // centre line at exactly the moment `isDay` flips, which is the most visible
    // possible place to put a hard swap -- and crossfading on the light rig's own
    // ramp means the dial changes over as the street lamps come on.
    if (Math.abs(clock.night - this.lastNight) > 0.01) {
      this.lastNight = clock.night;
      const night = clock.night;
      // **`style`, not `setAttribute`.** A presentation attribute loses to any
      // stylesheet rule, and this file animates the opacity of elements the
      // stylesheet also gives a resting opacity to -- `#clock .halo` and
      // `#clock .track.dusk`. Written as attributes, the halo stayed at its CSS
      // 0.26 forever and drew a grey disc behind the moon all night. An inline
      // style outranks the rule, which is the same lesson `hud.ballBlockWidth`
      // records one file over, arrived at from the opposite direction.
      setOpacity(this.sun, 1 - night);
      setOpacity(this.halo, 0.26 * (1 - night));
      setOpacity(this.moon, night);
      // **The ends go hollow rather than faint.** They are the labels for the
      // two halves and a label that disappears stops labelling -- and dimming
      // them was exactly that: `#cfe2f2` at 0.3 opacity over the noon haze band,
      // rgb(238, 250, 254), cannot be seen at all. So the outline stays at full
      // strength and the *fill* is what carries the state. Solid is now, hollow
      // is the other half, and both read against any sky.
      setFillOpacity(this.sunEnd, 0.16 + 0.84 * (1 - night));
      setFillOpacity(this.moonEnd, 0.16 + 0.84 * night);
      // The sun's rays are strokes and have no fill to carry it, so they take
      // the state as their own opacity -- never to zero, or the inactive sun
      // stops being a sun and becomes a circle.
      setOpacity(this.sunRays, 0.3 + 0.7 * (1 - night));
    }

    // Dread, and it is the *sundown* half only. The warmth and the pulse are a
    // warning; the sunrise countdown below is news, and dressing news as a
    // warning is how a warning stops being read.
    const dread = clock.isDay ? dreadLevel(clock.secondsToEdge) : 0;
    if (Math.abs(dread - this.lastDread) > 0.005) {
      this.lastDread = dread;
      setOpacity(this.duskTrack, dread);
      // A class rather than an inline animation, so `prefers-reduced-motion` can
      // turn it off in the stylesheet -- where every other motion decision in
      // this interface is made.
      this.root.classList.toggle('dread', dread > 0.35);
    }

    const caption =
      clock.secondsToEdge < DREAD_SECONDS
        ? `${clock.isDay ? 'sundown' : 'sunup'} ${countdown(clock.secondsToEdge)}`
        : '';
    if (caption !== this.lastEdge) {
      this.lastEdge = caption;
      if (this.edgeText) this.edgeText.textContent = caption;
    }
  }
}

/**
 * Startup self-check, on this project's usual criterion: **every way the dial
 * breaks draws a plausible clock.**
 *
 * A dial cut at the wrong phase puts the marker on the centre line at noon and
 * reads as a clock running six hours fast. A progress that does not wrap leaves
 * the marker stuck at one end for half the cycle. A dread ramp that is linear
 * reads as "this is always a bit on", which is a warning nobody looks at. None
 * of them throws, and none of them has a frame that says otherwise.
 *
 * No DOM here at all -- it checks `dialProgress`, `dialX` and `dreadLevel`,
 * which is where all of the above live.
 */
export function verifyClock(): string[] {
  const failures: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

  // 1. The four landmarks, which is where a mis-cut dial shows up.
  const span = TRACK_X1 - TRACK_X0;
  const landmarks: Array<[string, number, number]> = [
    ['sunset', SUNSET_PHASE, TRACK_X0],
    ['the dead of night', 0, TRACK_X0 + span * 0.25],
    ['sunrise', SUNRISE_PHASE, TRACK_X0 + span * 0.5],
    ['solar noon', 0.5, TRACK_X0 + span * 0.75],
  ];
  for (const [name, phase, x] of landmarks) {
    if (!near(dialX(phase), x)) {
      failures.push(
        `The clock dial puts ${name} (phase ${phase}) at x=${dialX(phase).toFixed(2)} rather than ` +
          `${x.toFixed(2)}. The dial is cut at sunset so that the night is its left half and the day ` +
          `is its right, which is the whole reason the two glyphs outside the ends can mean the two ` +
          `halves. Cut anywhere else and the clock looks correct and is a quarter of a cycle out.`,
      );
    }
  }

  // 2. The left half is the night and the right half is the day, sampled
  //    against the actual definition rather than against the landmarks. This is
  //    the case that fails if the cut moves and somebody adjusts the landmarks
  //    above to match it.
  for (let i = 0; i < 2000; i++) {
    const phase = (i + 0.5) / 2000;
    const daylight = phase >= SUNRISE_PHASE && phase < SUNSET_PHASE;
    const rightHalf = dialProgress(phase) >= 0.5;
    if (daylight !== rightHalf) {
      failures.push(
        `At phase ${phase.toFixed(4)} the sun is ${daylight ? 'up' : 'down'} but the marker is in the ` +
          `${rightHalf ? 'right' : 'left'} half of the dial. The halves are the whole of what this ` +
          `widget says without being read.`,
      );
      break;
    }
  }

  // 3. Monotone and inside the track, everywhere. A marker that backs up by a
  //    unit reads as a rendering fault; one that runs off the end reads as a
  //    clipping bug.
  //
  //    Swept from sunset forward and stopping **one step short of a full turn**,
  //    because the wrap back to the left end is the one place the marker is
  //    supposed to jump -- it is where the dial is cut, and it happens at the
  //    instant the sun sets. Including it would fail this check on the feature.
  let previous = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const phase = SUNSET_PHASE + i / 4000;
    const x = dialX(phase % 1);
    if (x < previous - 1e-9 || x < TRACK_X0 - 1e-9 || x > TRACK_X1 + 1e-9) {
      failures.push(
        `The clock marker leaves its track or moves backwards: x=${x.toFixed(3)} after ` +
          `${previous.toFixed(3)}, against a track of ${TRACK_X0}..${TRACK_X1}.`,
      );
      break;
    }
    previous = x;
  }

  // 4. The dread ramp: nothing at the far end, everything at the near one, and
  //    genuinely back-loaded.
  if (dreadLevel(DREAD_SECONDS) !== 0 || dreadLevel(1e6) !== 0 || dreadLevel(0) !== 1) {
    failures.push(
      `dreadLevel does not pin its ends: ${dreadLevel(DREAD_SECONDS)} at ${DREAD_SECONDS} s out and ` +
        `${dreadLevel(0)} on arrival. It must be exactly zero outside the window and exactly one at ` +
        `the edge.`,
    );
  }
  if (!(dreadLevel(DREAD_SECONDS / 2) < 0.3)) {
    failures.push(
      `dreadLevel is ${dreadLevel(DREAD_SECONDS / 2).toFixed(2)} half way through its window; it is ` +
        `squared so the first three minutes are a hint and the last two are the warning. A ramp ` +
        `already at half strength with two and a half minutes to go is a warning nobody reads.`,
    );
  }

  // 5. The ticks divide the cycle into a whole number of pieces and the divider
  //    lands on one of them. An odd count would put the sunrise line between two
  //    ticks, which is the sort of thing that looks like a rendering offset.
  if (TICKS % 2 !== 0) {
    failures.push(
      `TICKS is ${TICKS}; it has to be even so the sunrise divider falls exactly on the middle ` +
        `division rather than between two of them.`,
    );
  }

  return failures;
}
