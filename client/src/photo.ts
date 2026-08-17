/**
 * Turning a grabbed frame into a photograph: the one browser-only function in
 * this feature.
 *
 * ---------------------------------------------------------------------------
 * HOW THE PIXELS ARE READ, AND WHY THIS FILE DOES NOT READ THEM
 *
 * A WebGPU drawing buffer is presented and released. `canvas.toDataURL()` from a
 * click handler returns a valid image of nothing -- no throw, no warning -- and
 * `client/src/bugreport.ts` has a header written at length about that being the
 * failure mode that matters, because a picture of black looks like the game
 * rendering black.
 *
 * The renderer is constructed as `new WebGPURenderer({ canvas, antialias: true })`
 * with no `preserveDrawingBuffer` (there is no such option on the WebGPU path in
 * any case), so the only arrangement that works is to read the canvas **inside
 * the frame**, one line after `renderer.render`. That arrangement already
 * exists, exactly once, and it is `FrameGrabber`: a request queue drained from
 * `grabber.afterRender()` in `main.ts`'s render loop.
 *
 * **So the camera does not capture anything.** It calls `grabber.request()`, the
 * same call the bug box's "attach what I'm looking at" button makes, and this
 * file starts from the PNG that comes back. Three things fall out of that and
 * every one of them is worth more than the encode it costs:
 *
 *   - There is still exactly **one** place in this client that reads the canvas.
 *     A second one would be a second way to produce an empty file, and it would
 *     be the one nobody tested because it only runs when somebody presses the
 *     shutter.
 *   - The **blank check** comes for free. `looksBlank` already refuses a uniform
 *     frame and says why, so a photograph taken on a machine whose readback
 *     failed is a message on the phone rather than a black rectangle in the
 *     gallery.
 *   - The **1600 px cap** comes for free too: `CAPTURE_MAX_EDGE` is already
 *     1600, which is the number the brief asks for, for the same reason (it is
 *     what keeps an encode of a 5K frame under the bug server's 4 MB cap).
 *
 * The price is one PNG encode and one decode per photograph -- a few tens of
 * milliseconds, once, on a frame where the player has just pressed a shutter and
 * is expecting a shutter's worth of pause. Re-encoding through PNG is lossless,
 * so nothing about the picture is worse for the round trip; only the clock is.
 *
 * **Nothing in this file is covered by a self-check and that is stated rather
 * than hidden.** It is a `drawImage`, a `fillText` and two `toDataURL` calls
 * against a real 2D context, and a fake context asserting that `fillText` was
 * called with the right string would be a test of the fake. What *is* checked,
 * in `game/phone.ts` and on both ends, is everything either side of it: the
 * caption string, the album, the cap, the quota. This function is the seam
 * between them and is deliberately the smallest thing that could sit there.
 *
 * ---------------------------------------------------------------------------
 * THE HUD IS NOT IN THE PICTURE, AND THAT IS FREE
 *
 * The brief asks for a photograph with no HUD in it. Every overlay in this game
 * -- the vitals, the pips, the notice pill, the compass, the phone itself -- is
 * DOM over the canvas rather than anything drawn into it, so a `drawImage` of
 * `#viewport` is the world and only the world. The viewfinder brackets are DOM
 * for exactly this reason as well as the obvious one.
 */

import { PHOTO_MAX_WIDTH, PHOTO_QUALITY, THUMB_WIDTH } from './game/phone.ts';

/** What a photograph is, once it has been composed. */
export interface Photograph {
  /** The full-size JPEG. Session-only; see `game/phone.Gallery`. */
  full: string;
  /** A `THUMB_WIDTH`-wide JPEG, which is the part that persists. */
  thumb: string;
  width: number;
  height: number;
}

/**
 * Where the caption sits and how big it is.
 *
 * The inset is in **fractions of the width** rather than pixels, so the mark
 * lands in the same place on a 1600 px photograph and on the 900 px one a small
 * window produces. 1/48 of the width is about 33 px at 1600, which is a little
 * under the 40 px `#locator` sits in from the right edge of a 1080p window --
 * the same visual margin, on a picture rather than on a screen.
 */
const CAPTION_INSET = 1 / 48;

/**
 * Caption size, as a fraction of the width, and the floor under it.
 *
 * 1/78 puts it at 20 px on a 1600 px frame -- which is large for a watermark and
 * is meant to be: this mark is the only thing that says where the picture was
 * taken once it has left the game, and a 10 px stamp on a photograph that will
 * be looked at on a phone is a smudge. The floor is what stops a small window
 * producing an illegible one.
 */
const CAPTION_SIZE = 1 / 78;
const CAPTION_MIN_PX = 13;

/**
 * The caption's ink and its shadow.
 *
 * `#cfe2f2` is the interface's one pale blue and `#locator`'s own colour, which
 * is the point: the mark on a photograph should look like it came from this
 * game's HUD rather than from a watermarking tool. The shadow is `#locator`'s
 * too (`0 1px 2px rgba(0,0,0,.85)`), and it is not decoration -- it is the only
 * thing that keeps pale text legible over a photograph of a white wall at noon.
 */
const CAPTION_INK = '#cfe2f2';
const CAPTION_SHADOW = 'rgba(0,0,0,0.85)';

/** The HUD's font stack, written out because a canvas cannot inherit CSS. */
const CAPTION_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * Compose a photograph from a grabbed frame.
 *
 * `source` is the PNG data URL `FrameGrabber.request()` resolved with -- already
 * capped at 1600 px on its longest edge and already known not to be blank.
 *
 * Rejects rather than returning a broken photograph, because every caller has
 * something better to do with a failure than store it: the phone puts the reason
 * on its own screen. The one failure worth naming is a browser with no 2D
 * context, which is the same thing `FrameGrabber.grab` guards and for the same
 * reason -- a canvas element is not a promise that `getContext('2d')` returns
 * one.
 */
export async function composePhoto(source: string, caption: string): Promise<Photograph> {
  const image = await decode(source);
  // The cap is applied a second time even though the grabber has already
  // applied it. It costs a `Math.min` and it means this function's contract is
  // about its own arguments rather than about who called it -- which matters
  // the day somebody composes a photograph from a file rather than a frame.
  const scale = Math.min(1, PHOTO_MAX_WIDTH / Math.max(1, image.width));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const full = document.createElement('canvas');
  full.width = width;
  full.height = height;
  const ctx = full.getContext('2d');
  if (!ctx) throw new Error('this browser gave no 2D context');
  ctx.drawImage(image, 0, 0, width, height);
  drawCaption(ctx, caption, width, height);

  // The thumbnail is scaled from the **composed** canvas rather than from the
  // source, so the caption is in it. That is deliberate: the gallery is a grid
  // of small pictures and the mark is what makes two shots of the same street at
  // different hours tell themselves apart at 320 px, even when the words
  // themselves are too small to read.
  const thumbWidth = Math.min(THUMB_WIDTH, width);
  const thumb = document.createElement('canvas');
  thumb.width = thumbWidth;
  thumb.height = Math.max(1, Math.round((height * thumbWidth) / width));
  const thumbCtx = thumb.getContext('2d');
  if (!thumbCtx) throw new Error('this browser gave no 2D context');
  // Told to interpolate properly rather than left to the default, because the
  // default is implementation-defined and a nearest-neighbour 5:1 downscale of a
  // city full of window mullions is a field of aliasing.
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.imageSmoothingQuality = 'high';
  thumbCtx.drawImage(full, 0, 0, thumb.width, thumb.height);

  return {
    full: full.toDataURL('image/jpeg', PHOTO_QUALITY),
    thumb: thumb.toDataURL('image/jpeg', PHOTO_QUALITY),
    width,
    height,
  };
}

/**
 * Burn the caption into the bottom-left corner.
 *
 * Separated from the composition above only so the two things that can go wrong
 * are in different functions: a photograph with no caption is a bug in here and
 * a photograph of nothing is a bug up there, and they have entirely different
 * causes.
 */
function drawCaption(ctx: CanvasRenderingContext2D, caption: string, width: number, height: number): void {
  if (caption === '') return;
  const size = Math.max(CAPTION_MIN_PX, Math.round(width * CAPTION_SIZE));
  const inset = Math.round(width * CAPTION_INSET);
  ctx.save();
  ctx.font = `${size}px ${CAPTION_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CAPTION_INK;
  // A shadow rather than a plate behind the text. A filled bar would be a
  // rectangle of interface sitting on a photograph -- the one thing a burnt-in
  // mark should not be -- where a drop shadow reads as lettering *on* the
  // picture and disappears the moment you stop looking at it.
  ctx.shadowColor = CAPTION_SHADOW;
  ctx.shadowBlur = Math.max(2, Math.round(size * 0.18));
  ctx.shadowOffsetY = Math.max(1, Math.round(size * 0.07));
  ctx.fillText(caption, inset, height - inset);
  ctx.restore();
}

/**
 * A data URL as a decoded image.
 *
 * `img.decode()` where it exists, because it resolves when the bitmap is
 * genuinely ready rather than when `onload` says the bytes arrived -- the
 * difference is a `drawImage` of a half-decoded image, which is rare, silent and
 * produces a grey photograph. The `onload` path is the fallback for anything
 * that does not implement it.
 */
function decode(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  if (typeof image.decode === 'function') {
    return image.decode().then(() => image);
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the captured frame would not decode'));
  });
}
