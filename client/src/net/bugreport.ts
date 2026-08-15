/**
 * The bug box's judgement about a captured frame -- the half with no DOM in it.
 *
 * Split from `client/src/bugreport.ts` (the tab, the grabber and the form) on
 * `net/suggestions.ts`'s exact precedent: **the server's `tsconfig.json` has no
 * `dom` library**, deliberately, so a shared module that reached for a browser
 * global fails at a type check rather than in a match. What is here is
 * `looksBlank` and its self-check, and they are here rather than beside the
 * canvas they judge because they are the one part of this feature whose failure
 * is completely silent -- a valid PNG of nothing, attached to a bug report, that
 * looks like the game rendering black. `server/integration-check.ts` runs both,
 * with the negative controls, in a process that has no GPU at all.
 */

/**
 * The longest edge a capture is scaled to before it is encoded.
 *
 * 1600 px, and the number is a trade against the server's four-megabyte cap
 * (`server/bugs.MAX_IMAGE_BYTES`). A 2560x1440 PNG of a city at dusk is around
 * 3 MB and a 5K display would put it over the cap and get the report refused --
 * which the player would experience as the button not working. Scaled to 1600
 * the same frame is under a megabyte and every defect this project has actually
 * chased is still legible in it: a gap under a platform, a car in the ground, a
 * wall through a road.
 */
export const CAPTURE_MAX_EDGE = 1600;

/**
 * The edge of the square the blank test is run on. Small on purpose: 576
 * pixels is plenty to tell a picture from a cleared buffer, and it is a
 * `getImageData` that costs nothing next to the full-size encode beside it.
 */
export const PROBE_EDGE = 24;

/**
 * Is this frame blank?
 *
 * Takes the RGBA bytes of a small probe render and answers whether they carry a
 * picture. The test is deliberately **tight rather than clever**: a failed
 * WebGPU readback is exactly uniform -- every pixel identical, usually all
 * zeroes -- and a real frame of this game never is, not even a night sky, which
 * has a gradient and stars in it.
 *
 * So blankness is two conditions together: almost no distinct colours *and*
 * almost no luminance range. Either alone would be wrong. A player standing in
 * a tunnel at midnight has a dark frame with a range of about four levels and
 * a hundred distinct buckets; a failed readback has one bucket and a range of
 * zero. Requiring both keeps a legitimately dark screenshot attachable, which
 * matters, because "it is pitch black in here and it should not be" is itself a
 * bug somebody will want to report.
 *
 * Pure, and separated from every canvas in this file, because it is the one
 * function whose failure is silent and it has to be testable without a GPU.
 */
export function looksBlank(rgba: Uint8ClampedArray | number[]): boolean {
  if (rgba.length < 16) return true; // nothing to judge; treat as blank
  const buckets = new Set<number>();
  let min = 255;
  let max = 0;
  let opaque = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (rgba[i + 3] > 8) opaque++;
    // Quantised to 4 bits a channel: a frame that differs only in dither noise
    // is not a frame with content in it, and 4096 buckets is plenty of room for
    // one that does.
    buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    const luma = (r * 77 + g * 151 + b * 28) >> 8;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  // A fully transparent readback is the other shape the failure takes: the
  // pixels are all zero *and* the alpha is too, which some browsers produce
  // where others give opaque black.
  if (opaque === 0) return true;
  return buckets.size <= 2 && max - min <= 6;
}

/**
 * The self-check, on `verifySuggestions`' criterion: **every way this breaks
 * produces a bug report**, and a bug report renders perfectly.
 *
 * The failures it exists to catch, all silent:
 *
 *   - A **blank detector that is not tight enough** rejects a legitimate night
 *     frame, so the one player reporting "it is pitch black in this tunnel"
 *     cannot attach the evidence.
 *   - A **blank detector that is too loose** accepts the failed WebGPU readback
 *     this whole design exists to catch, and every report comes with a black
 *     rectangle that looks like the game rendering black.
 *   - A **detector that only counts colours** passes a two-tone gradient of
 *     nothing; one that only measures range passes a uniform mid-grey.
 *   - A **transparent readback** -- all zeroes including alpha -- is the shape
 *     the failure takes in some browsers, and a luminance-only test calls it
 *     black-and-uniform correctly by luck rather than by rule.
 *
 *     bun -e "import {verifyBugReport} from './client/src/bugreport.ts';
 *             console.log(verifyBugReport())"
 */
export function verifyBugReport(): string[] {
  const failures: string[] = [];

  /** n x n pixels from a function. RGBA, opaque unless said otherwise. */
  const frame = (n: number, at: (x: number, y: number) => [number, number, number, number]): number[] => {
    const out: number[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out.push(...at(x, y));
    }
    return out;
  };

  // --- The failures it must catch.
  {
    const black = frame(PROBE_EDGE, () => [0, 0, 0, 255]);
    if (!looksBlank(black)) failures.push('an all-black readback was not detected as blank.');
    const transparent = frame(PROBE_EDGE, () => [0, 0, 0, 0]);
    if (!looksBlank(transparent)) failures.push('a fully transparent readback was not detected as blank.');
    const grey = frame(PROBE_EDGE, () => [128, 128, 128, 255]);
    if (!looksBlank(grey)) failures.push('a uniform mid-grey readback was not detected as blank.');
    const white = frame(PROBE_EDGE, () => [255, 255, 255, 255]);
    if (!looksBlank(white)) failures.push('an all-white readback was not detected as blank.');
    // The near-miss: a readback that is uniform except for one channel being
    // one level off, which is what a cleared buffer with a clear colour is.
    const almost = frame(PROBE_EDGE, (x, y) => [0, 0, (x + y) % 2, 255]);
    if (!looksBlank(almost)) failures.push('a cleared buffer with a one-level dither was not detected as blank.');
  }

  // --- THE NEGATIVE CONTROL: frames it must NOT reject.
  //
  // Without these the detector could return `true` unconditionally and every
  // assertion above would pass while the feature was entirely broken -- nobody
  // could ever attach anything.
  {
    const day = frame(PROBE_EDGE, (x, y) => [40 + x * 8, 90 + y * 5, 160 - x * 3, 255]);
    if (looksBlank(day)) failures.push('THE NEGATIVE CONTROL: a daylight frame was rejected as blank.');
    // A night sky: very dark, low range, but with a gradient and two stars in
    // it. This is the frame a naive "is it dark" test throws away, and it is a
    // frame somebody legitimately wants to file a bug about.
    const night = frame(PROBE_EDGE, (x, y) => {
      if (x === 4 && y === 3) return [220, 220, 230, 255];
      if (x === 17 && y === 9) return [200, 205, 220, 255];
      return [2 + (y >> 2), 3 + (y >> 3), 8 + (y >> 2), 255];
    });
    if (looksBlank(night)) failures.push('THE NEGATIVE CONTROL: a night frame with stars in it was rejected as blank.');
    // A dark tunnel: no stars, but a real gradient across the frame.
    const tunnel = frame(PROBE_EDGE, (x, y) => [3 + (x >> 1), 3 + (x >> 1), 4 + (y >> 1), 255]);
    if (looksBlank(tunnel)) failures.push('THE NEGATIVE CONTROL: a dark gradient was rejected as blank.');
  }

  // --- Degenerate inputs, which must not throw.
  {
    try {
      if (!looksBlank([])) failures.push('an empty buffer was judged to carry a picture.');
      if (!looksBlank([1, 2, 3])) failures.push('a truncated buffer was judged to carry a picture.');
    } catch (err) {
      failures.push(`looksBlank threw on a degenerate input: ${String(err)}`);
    }
  }

  // --- The capture budget, which is what keeps a 5K frame under the server cap.
  {
    if (CAPTURE_MAX_EDGE > 2048) {
      failures.push(`the capture edge is ${CAPTURE_MAX_EDGE}px, which encodes past the server's 4 MB cap.`);
    }
  }

  return failures;
}
