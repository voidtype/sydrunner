/**
 * The bug box: a player's words, a picture of what they were looking at, and
 * the GitHub issue both end up in.
 *
 * `server/suggestions.ts` is the file this one is written against, and most of
 * what is true there is true here: the token is read from the environment and
 * never seen by a client, the repo is `SYDNEY_GITHUB_REPO` and nothing a client
 * sends can name it, no GitHub response text ever reaches a player, and a server
 * with no token **accepts the report and queues it** rather than refusing.
 *
 * What is new here, and what the whole of this file is about, is that this is a
 * public unauthenticated endpoint that **writes bytes into a public
 * repository**. A suggestion is at worst a sentence in an issue. A bug report
 * carries a file, that file is committed, and a commit cannot be un-made. So
 * every byte is treated as hostile:
 *
 *   - **The size is capped before the body is buffered.** `readCappedBody`
 *     refuses on `content-length` first and then counts chunks as they arrive,
 *     so a client that lies about its length or sends a chunked stream with no
 *     length at all is cut off mid-flight rather than after the server has held
 *     the whole thing in memory. A cap enforced after buffering is not a cap.
 *   - **The bytes are proved to be an image by their magic numbers**, not by a
 *     content type and not by a file extension -- neither of which is evidence
 *     of anything, both of which are supplied by the sender.
 *   - **The image is rebuilt rather than forwarded.** `sanitiseImage` walks the
 *     container and emits a new file made only of the chunks or segments a
 *     picture needs. A phone photograph carries EXIF, EXIF carries GPS, and a
 *     player attaching a photo of their screen would otherwise publish the
 *     coordinates of their house into a public repository. That is the single
 *     worst thing this feature could do and it is stopped structurally.
 *   - **The filename is generated here.** Nothing a client sends reaches a
 *     path, and `SAFE_NAME` asserts it before the URL is built. There is no
 *     shell in this file at all.
 *   - **Three rate limits**, all of them `FloodGuard` from `server/suggestions.ts`
 *     rather than a second mechanism: per client id, per address, and a global
 *     ceiling on issues per hour. The third is the one that matters, because the
 *     first two are per-identity and identities are free.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE GOES THROUGH THE CONTENTS API
 *
 * GitHub has **no public API for attaching an image to an issue**. The web
 * interface uploads to `uploads.github.com` with a session credential and a
 * per-repository upload policy; that endpoint is undocumented, unversioned and
 * not usable from a token. The routes that are public and were considered:
 *
 *   - **A gist.** Raw gist content is served as `text/plain` with a nosniff
 *     header, so an `![](...)` pointing at one renders as a broken image.
 *   - **A data URI in the body.** GitHub's markdown pipeline strips `data:`
 *     image sources; it renders as nothing.
 *   - **A release asset.** Works, and is worse: it needs a release to exist,
 *     the asset URL is on `github.com` rather than `raw.githubusercontent.com`,
 *     and it puts player uploads into the same namespace as the world builds
 *     (see DEPLOY.md, where the world *is* a release).
 *
 * So: `PUT /contents/bugs/<id>.png` commits the file, the response carries a
 * `download_url` on `raw.githubusercontent.com`, and that URL goes in the issue
 * body as an image. The cost is a commit per report, which is the reason for the
 * hourly ceiling.
 *
 *     SYDNEY_GITHUB_TOKEN=...              Contents + Issues, that repo only
 *     SYDNEY_GITHUB_REPO=owner/name        defaults to voidtype/sydrunner
 *     SYDNEY_BUGS=/path/dir                defaults to data/bugs/
 */

import { sanitiseBody, sanitiseText, sanitiseTitle, validClientId } from '../client/src/net/suggestions.ts';
import { FloodGuard } from './suggestions.ts';

// --- The budgets ---------------------------------------------------------------

/**
 * The largest image this will commit, **after** it has been rebuilt.
 *
 * Four megabytes. A 2560x1440 PNG of a city at dusk is about 3 MB, which is the
 * biggest thing the in-game capture can produce; a phone photograph is 2-4 MB.
 * Above that the request is refused rather than downscaled, because downscaling
 * needs a decoder and a decoder is the one thing this file deliberately does not
 * have: decoding attacker-supplied pixels is a much larger attack surface than
 * walking a container format, and the walk is what strips the metadata anyway.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The largest request body, which is the image plus base64's third.
 *
 * Base64 costs 4 bytes per 3, so a 4 MB image is 5.34 MB of text, and the rest
 * is a title, a paragraph and a couple of dozen metadata fields -- call it
 * 32 kB. Six megabytes covers it with room and is small enough that a hundred
 * concurrent uploads is not this process's memory.
 */
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;

/**
 * The largest edge, in pixels, in either dimension.
 *
 * A decompression-bomb guard, and it is cheap because the dimensions are in the
 * header: a 64,000 x 64,000 PNG of one colour compresses to a few kilobytes and
 * would pass every byte cap here, then destroy whatever eventually opened it.
 * 16,384 is over twice the longest edge any real display or phone camera
 * produces.
 */
export const MAX_DIMENSION = 16_384;

/** Metadata: how many fields, and how long a key and a value may be. */
export const MAX_META_FIELDS = 28;
export const MAX_META_KEY = 40;
export const MAX_META_VALUE = 240;

/**
 * The rate limits, as token buckets, in **two tiers** -- and the two tiers are
 * not over-engineering, they are a bug this endpoint had and was caught with.
 *
 * `FloodGuard` unchanged from `server/suggestions.ts` -- the same continuously
 * refilling bucket, given different numbers. Reusing it rather than writing a
 * second limiter is deliberate: two rate limiters is two sets of edge cases at
 * the boundary, and that one has already been argued about and tuned once.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO TIERS
 *
 * The first cut had one bucket, charged as soon as the client id was known.
 * That is the natural place to put it -- in front of the expensive work -- and
 * it is wrong, because **a rejected request spent a filing slot**. A player who
 * attached a GIF, was told PNG or JPEG, attached the right file and pressed send
 * had used two of their three, and the third was gone the next time they
 * mistyped a title. Their honest report was then refused as flooding. That is
 * the single most likely way this feature would have annoyed the one person it
 * exists for, and no test that sent one well-formed request would have found it.
 *
 * So:
 *
 *   - **The admission bucket** is charged on every well-formed request, before
 *     anything expensive: 20, refilling one a second. It exists to stop a loop,
 *     not a person -- a person cannot press a button twenty times a second, and
 *     a loop cannot do anything else. Being generous here costs nothing, which
 *     is `SUGGEST_BURST`'s own argument one file over.
 *   - **The filing budget** is charged only when a report is *about to become an
 *     issue*: validated, image accepted, everything decided. Three per client,
 *     five per address, twelve an hour for everybody. A refusal never touches it.
 *
 * The three filing numbers:
 *
 *   - **Per client id: 3, refilling one every ten minutes.** A player who has
 *     just found three bugs can file three; the fourth waits.
 *   - **Per address: 5 on the same refill.** Looser than per-client because a
 *     household or a university shares an address, and tighter than nothing
 *     because a client id is a `localStorage` string that costs nothing to mint.
 *     **Behind Caddy this address is Caddy**, which is the same honest
 *     limitation `server/suggestions.addressOf` states, and it is exactly why
 *     the third limit exists.
 *   - **Globally: 12 an hour.** The one that is actually load-bearing, because
 *     it is the only one an attacker cannot get around by being somebody else.
 *     Twelve commits an hour into a public repository is a bad afternoon rather
 *     than a catastrophe, and it is far more bug reports than this game will
 *     ever receive in an hour.
 */
export const ADMIT_BURST = 20;
export const ADMIT_REFILL_PER_SEC = 1;
export const CLIENT_BURST = 3;
export const CLIENT_REFILL_PER_SEC = 1 / 600;
export const IP_BURST = 5;
export const IP_REFILL_PER_SEC = 1 / 600;
export const HOURLY_ISSUES = 12;

/** How long an idle bucket is kept before it is forgotten. See `sweep`. */
const BUCKET_TTL_MS = 6 * 60 * 60 * 1000;

// --- What arrives --------------------------------------------------------------

export interface BugReport {
  clientId: string;
  title: string;
  body: string;
  /** Flat, string-valued, already sanitised. Drawn into a `<details>` block. */
  meta: Array<[string, string]>;
  /** The rebuilt image, or null. */
  image: SafeImage | null;
}

export interface SafeImage {
  kind: 'png' | 'jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
  /** What the container carried before the rebuild, for the log and the checks. */
  strippedBytes: number;
}

export interface BugOutcome {
  /** HTTP status. The client reads the message, not this. */
  status: number;
  result: 'filed' | 'queued' | 'rejected' | 'rate' | 'error';
  /** The issue number, or 0. */
  issue: number;
  /** The issue's URL, or ''. Sent so the panel can show one, not to be parsed. */
  url: string;
  /** One sentence for the player. **Always a literal in this file.** */
  message: string;
}

// --- Magic numbers -------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * What these bytes actually are, from the first eight of them.
 *
 * **Not from a content type and not from a file name.** Both of those are
 * supplied by the sender and neither is evidence: a file called `shot.png`
 * declared as `image/png` whose first bytes are `<?php` is the oldest upload
 * attack there is, and the only thing that catches it is looking.
 *
 * PNG and JPEG only. GIF, WebP, AVIF, SVG and BMP are all refused, and SVG is
 * the reason the list is an allowlist rather than a denylist: SVG is a document
 * with script in it, it is served from `raw.githubusercontent.com` with a
 * content type that makes it inert *today*, and a format whose safety depends on
 * a third party's response headers is not a format this endpoint accepts.
 */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  // FF D8 FF is SOI followed by the marker prefix of whatever segment is first.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

// --- CRC32, for the PNG chunks -------------------------------------------------

/**
 * The PNG CRC, table-driven, built once.
 *
 * Written here rather than reached for from Bun so that every pure function in
 * this file can be exercised by anything that can run TypeScript, and because
 * the check wants to *corrupt* a CRC and watch this refuse the file -- which
 * needs the same implementation the validator uses.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The PNG chunks a picture needs, and nothing else.
 *
 * Everything not on this list is dropped, which is where the metadata goes:
 * `tEXt`, `iTXt` and `zTXt` (arbitrary text, and the editor's name), `eXIf`
 * (the whole EXIF block, GPS included), `tIME`, and the `acTL`/`fcTL`/`fdAT`
 * triple that makes a PNG an animation. Colour is kept -- `sRGB` and `gAMA` are
 * four and eight bytes and dropping them changes what the picture looks like,
 * which is the one thing a bug report must not do.
 */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'IDAT', 'IEND']);

/**
 * Rebuild a PNG from its critical chunks, or refuse it.
 *
 * A walk rather than a decode. Every chunk's declared length is checked against
 * what is left of the file and **every kept chunk's CRC is verified**, which is
 * what makes "these bytes really are a PNG" a fact rather than a hope: a file
 * that is a PNG header stapled to something else fails at the first chunk whose
 * length runs off the end or whose CRC does not match.
 *
 * Returns the new bytes and the header's dimensions, or null.
 */
export function rebuildPng(bytes: Uint8Array): SafeImage | null {
  if (sniffImage(bytes) !== 'png') return null;
  const out: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
  let at = 8;
  let width = 0;
  let height = 0;
  let idats = 0;
  let ended = false;
  let kept = 0;
  while (at + 8 <= bytes.length) {
    const length = readU32(bytes, at);
    // The chunk, its header and its CRC must all be inside the file. This is the
    // check that stops a declared length of 0xFFFFFFFF walking off the end.
    if (length > 0x7fffffff || at + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const crcAt = at + 8 + length;
    if (PNG_KEEP.has(type)) {
      // Over the type and the data, which is what the PNG spec's CRC covers.
      if (crc32(bytes, at + 4, crcAt) !== readU32(bytes, crcAt)) return null;
      if (type === 'IHDR') {
        if (length !== 13 || kept !== 0) return null; // IHDR is first and is 13 bytes
        width = readU32(bytes, at + 8);
        height = readU32(bytes, at + 12);
        if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
      } else if (kept === 0) {
        return null; // something before IHDR
      }
      if (type === 'IDAT') idats++;
      if (type === 'IEND') ended = true;
      out.push(bytes.subarray(at, crcAt + 4));
      kept++;
    }
    at = crcAt + 4;
    if (ended) break;
  }
  if (!ended || idats === 0 || width === 0) return null;
  return { kind: 'png', bytes: concat(out), width, height, strippedBytes: bytes.length };
}

/**
 * Rebuild a JPEG without its application segments, or refuse it.
 *
 * **Every `APPn` and every `COM` goes**, which is a slightly bigger hammer than
 * strictly necessary and is the right one. EXIF is `APP1` and so is XMP -- both
 * carry location, both carry a device serial, and XMP carries whatever the
 * editing software felt like writing. `APP0` is JFIF and `APP14` is Adobe's
 * colour-transform hint; dropping them is safe for the baseline and progressive
 * YCbCr files that browsers and phones actually produce, and keeping a
 * *selection* of application segments would mean auditing each one's contents
 * forever. This is what `exiftool -all=` does.
 *
 * The scan is copied verbatim from `SOS` to the end: entropy-coded data is not
 * segment-structured and must not be walked as if it were.
 */
export function rebuildJpeg(bytes: Uint8Array): SafeImage | null {
  if (sniffImage(bytes) !== 'jpeg') return null;
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let width = 0;
  let height = 0;
  let scanned = false;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null; // not on a marker boundary; not a JPEG
    // Fill bytes: a run of FFs before a marker is legal padding.
    let markerAt = at;
    while (markerAt + 1 < bytes.length && bytes[markerAt + 1] === 0xff) markerAt++;
    const marker = bytes[markerAt + 1];
    if (marker === 0xd9) {
      out.push(new Uint8Array([0xff, 0xd9]));
      scanned = true;
      break;
    }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(bytes.subarray(markerAt, markerAt + 2));
      at = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) return null;
    const length = (bytes[markerAt + 2] << 8) | bytes[markerAt + 3];
    if (length < 2 || markerAt + 2 + length > bytes.length) return null;
    const end = markerAt + 2 + length;
    // A start-of-frame: the dimensions live at a fixed offset inside it. Every
    // SOF variant except DHP (C4/C8/CC are not frames) has the same layout.
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (length < 8) return null;
      height = (bytes[markerAt + 5] << 8) | bytes[markerAt + 6];
      width = (bytes[markerAt + 7] << 8) | bytes[markerAt + 8];
      if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
    }
    const drop = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(bytes.subarray(markerAt, end));
    if (marker === 0xda) {
      // The scan. Everything from here to the end of the file is entropy-coded
      // and is copied without interpretation -- including the EOI, if there is
      // one. A JPEG truncated before its EOI is still a picture every decoder
      // renders, so its absence is not a refusal; `scanned` is.
      out.push(bytes.subarray(end));
      scanned = true;
      break;
    }
    at = end;
  }
  if (!scanned || width === 0) return null;
  return { kind: 'jpeg', bytes: concat(out), width, height, strippedBytes: bytes.length };
}

/**
 * The one entry point: bytes in, a rebuilt image or a refusal out.
 *
 * The size is checked on **both** the incoming and the outgoing bytes. The
 * first is the obvious one; the second is because a rebuild can only ever be
 * smaller, so a rebuilt file over the cap means the walk agreed with a file that
 * was already over it -- which would be a bug in this file rather than in the
 * upload, and it should not become a commit either way.
 */
export function sanitiseImage(bytes: Uint8Array): SafeImage | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const kind = sniffImage(bytes);
  const safe = kind === 'png' ? rebuildPng(bytes) : kind === 'jpeg' ? rebuildJpeg(bytes) : null;
  if (!safe || safe.bytes.length === 0 || safe.bytes.length > MAX_IMAGE_BYTES) return null;
  return safe;
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- The filename --------------------------------------------------------------

/**
 * The path a report's image is committed at, generated **here**.
 *
 * Nothing a client sends is anywhere in this string. The date is for a human
 * reading the directory listing; the sixteen hex characters are
 * `crypto.randomUUID`'s, so two reports in one millisecond cannot collide and
 * the name cannot be guessed by somebody wanting to overwrite one.
 *
 * `SAFE_PATH` is asserted against the result before it is ever interpolated into
 * a URL. That assertion can only fail if this function changes, which is the
 * point of it: it is a tripwire on a future edit rather than a check on the
 * present one.
 */
const SAFE_PATH = /^bugs\/\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.(png|jpg)$/;

export function imagePath(kind: 'png' | 'jpeg', now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const path = `bugs/${day}-${id}.${kind === 'png' ? 'png' : 'jpg'}`;
  if (!SAFE_PATH.test(path)) throw new Error('generated an unsafe path'); // unreachable
  return path;
}

// --- Reading the request -------------------------------------------------------

export interface CappedBody {
  ok: boolean;
  /** The bytes, when `ok`. */
  text: string;
  /** Why not, when not. A literal. */
  why: string;
}

/**
 * Read a request body with a hard ceiling, refusing before buffering.
 *
 * Three gates in order, and the order is the whole point:
 *
 *   1. **`content-length`, before a byte is read.** An honest client that is
 *      about to send eight megabytes is told no while its body is still in its
 *      own socket buffer.
 *   2. **A missing length is not a pass.** `Transfer-Encoding: chunked` has no
 *      length, so a rule that only checked the header would be trivially
 *      bypassed by omitting it.
 *   3. **A running total as chunks arrive**, cancelling the stream the moment it
 *      is exceeded. This is what makes a lying `content-length` harmless, and it
 *      is why this reads the stream itself rather than calling `req.text()` --
 *      `req.text()` buffers the whole thing and *then* returns it, which is
 *      exactly the failure mode the requirement names.
 */
export async function readCappedBody(req: Request, max = MAX_REQUEST_BYTES): Promise<CappedBody> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return { ok: false, text: '', why: 'that request made no sense' };
    if (n > max) return { ok: false, text: '', why: 'too big — keep it under a few megabytes' };
  }
  const stream = req.body;
  if (stream === null) return { ok: false, text: '', why: 'nothing arrived' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // Cancelled rather than drained: the sender is told to stop and this
        // process stops holding what it already has.
        void reader.cancel().catch(() => {});
        return { ok: false, text: '', why: 'too big — keep it under a few megabytes' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, text: '', why: 'that upload did not finish' };
  }
  return { ok: true, text: new TextDecoder().decode(concat(chunks)), why: '' };
}

/**
 * Base64 to bytes, refusing anything that is not base64.
 *
 * `atob` is lenient about a lot and throws on the rest; the length gate in front
 * of it is what stops a 40 MB string of `A`s being decoded into 30 MB of zeroes
 * before anybody looks at it. The `data:` prefix a browser's `toDataURL`
 * produces is stripped here, and the media type in it is **ignored**: it is a
 * claim by the sender and `sniffImage` is the fact.
 */
export function decodeImagePayload(raw: string, max = MAX_IMAGE_BYTES): Uint8Array | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const comma = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  if (raw.startsWith('data:') && comma < 0) return null;
  const b64 = (comma >= 0 ? raw.slice(comma + 1) : raw).trim();
  // 4 characters carry 3 bytes; refuse before decoding rather than after.
  if (b64.length === 0 || (b64.length / 4) * 3 > max) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.length === 0 || out.length > max ? null : out;
  } catch {
    return null;
  }
}

/**
 * The metadata block, sanitised into pairs.
 *
 * Everything a client sends here is drawn into a GitHub issue body, so it goes
 * through `net/suggestions.sanitiseText` -- the same function a suggestion's
 * prose goes through, including the part that breaks `<!--`, which is what stops
 * a metadata value ending the `<details>` block it sits inside and writing
 * markup into the issue underneath.
 *
 * Capped in three dimensions -- fields, key length, value length -- because the
 * client composes this object and a client is not to be trusted about how many
 * facts there are about it.
 */
export function sanitiseMeta(raw: unknown): Array<[string, string]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= MAX_META_FIELDS) break;
    // Keys are constrained hard: they are labels this server prints, and a key
    // is never prose. Anything with a character outside this set is dropped
    // rather than cleaned, because a key that needed cleaning was not one of
    // ours.
    const key = rawKey.slice(0, MAX_META_KEY);
    if (!/^[a-z][a-z0-9 /]*$/i.test(key)) continue;
    const value =
      typeof rawValue === 'string'
        ? sanitiseText(rawValue, false).slice(0, MAX_META_VALUE)
        : typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? String(Math.round(rawValue * 1000) / 1000)
          : typeof rawValue === 'boolean'
            ? String(rawValue)
            : '';
    if (value === '') continue;
    out.push([key, value]);
  }
  return out;
}

// --- The store -----------------------------------------------------------------

export interface BugStoreOptions {
  /** A directory. Queued reports live here until a token appears. */
  dir: string;
  repo: string;
  token: string;
  /** Off in tests, which drive `drain` by hand. */
  timers?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Where a report goes, and what it becomes.
 *
 * Holds no per-connection state and no rate limits -- those are `BugGuards`,
 * which the HTTP route owns. This is the part that talks to GitHub and to the
 * disk, and it is separated on the same seam `SuggestionStore` and
 * `SuggestionHub` are separated on.
 */
export class BugStore {
  private readonly dir: string;
  readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  /** The last thing GitHub said, as a status. For `/health` and the log. */
  lastGithubError = '';
  filed = 0;
  queued = 0;

  constructor(options: BugStoreOptions) {
    this.dir = options.dir;
    this.repo = options.repo;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    if (options.timers !== false) {
      // A minute, matching the suggestions flush, and for the same reason: the
      // only thing this drains is a queue that fills when GitHub is down or the
      // token is missing, and neither is a state that resolves in seconds.
      this.drainTimer = setInterval(() => void this.drain(), 60_000);
    }
  }

  /** Whether a token is configured. Says nothing about the token. */
  get linked(): boolean {
    return this.token.length > 0;
  }

  describe(): string {
    return this.linked
      ? `GitHub ${this.repo} (token set), ${this.filed} filed this run`
      : `GitHub ${this.repo} unlinked (no SYDNEY_GITHUB_TOKEN) — reports queue in ${this.dir}`;
  }

  async close(): Promise<void> {
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.drainTimer = null;
    await this.drain();
  }

  /**
   * File one report.
   *
   * With a token: the image is committed, then the issue is posted, and the
   * player is told the number. **Without one, or when GitHub will not answer,
   * the report is written to disk and the player is told it is queued** --
   * which is `SuggestionStore.submit`'s behaviour exactly, and for its reason:
   * a box that refuses input until a credential appears is a box nobody can try.
   */
  async file(report: BugReport): Promise<BugOutcome> {
    if (!this.linked) {
      const ok = await this.enqueue(report);
      return ok
        ? {
            status: 200,
            result: 'queued',
            issue: 0,
            url: '',
            message: "thanks — queued. it'll be filed on GitHub once the server's link is set up.",
          }
        : {
            status: 200,
            result: 'queued',
            issue: 0,
            url: '',
            message: 'thanks — noted, but this server could not store it. tell somebody in chat.',
          };
    }
    const posted = await this.post(report);
    if (posted) return posted;
    await this.enqueue(report);
    return {
      status: 200,
      result: 'queued',
      issue: 0,
      url: '',
      message: 'thanks — GitHub did not answer, so it is queued and will post shortly.',
    };
  }

  /**
   * The two GitHub calls, in the order that makes a partial failure survivable.
   *
   * The image first, then the issue. If the image fails the issue is posted
   * **anyway**, with a line saying the picture did not upload: a bug report
   * without its screenshot is worth much less, and losing the player's words as
   * well because a file upload 500'd would be worth nothing at all.
   *
   * If the *issue* fails, `file` queues the whole report and it is retried --
   * which can leave an orphaned image committed under `bugs/`. That is stated
   * rather than solved: deleting it needs a second Contents call that can also
   * fail, and an unused 2 MB file in a repository is a smaller problem than the
   * code to avoid it.
   */
  private async post(report: BugReport): Promise<BugOutcome | null> {
    let imageUrl = '';
    let imageFailed = false;
    if (report.image) {
      imageUrl = await this.commitImage(report.image);
      imageFailed = imageUrl === '';
    }
    const issue = await this.createIssue(report, imageUrl, imageFailed);
    if (issue === null) return null;
    this.filed++;
    return {
      status: 200,
      result: 'filed',
      issue: issue.number,
      url: issue.url,
      message:
        `thanks — filed as #${issue.number}` +
        (imageFailed ? ', though the screenshot would not upload.' : '.'),
    };
  }

  private api(path: string): string {
    return `https://api.github.com/repos/${this.repo}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sydney-bugs',
    };
    // The one place the token is used. Never a URL, never a log, never an error.
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** PUT the image into the repo. Returns its raw URL, or ''. */
  private async commitImage(image: SafeImage): Promise<string> {
    const path = imagePath(image.kind, this.now());
    if (!SAFE_PATH.test(path)) return ''; // unreachable; see `imagePath`
    try {
      const res = await this.fetchImpl(this.api(`/contents/${path}`), {
        method: 'PUT',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          // The commit message is a literal. Not the player's title: a commit
          // subject written by a stranger is a line of text in `git log`
          // forever, and the issue is where their words belong.
          message: `Bug report screenshot (${path})`,
          content: toBase64(image.bytes),
        }),
      });
      if (!res.ok) {
        // **The status and nothing else.** `server/suggestions.createIssue`
        // gives the whole argument: GitHub's error bodies quote request context
        // back, and the credential this process holds is broad.
        this.lastGithubError = `PUT /contents -> ${res.status}`;
        return '';
      }
      const body = (await res.json()) as { content?: { download_url?: string } };
      const url = body.content?.download_url ?? '';
      // The URL is GitHub's answer, so it is checked before it is written into
      // an issue body as an image source. Anything not on their raw host is
      // discarded rather than embedded.
      if (!/^https:\/\/raw\.githubusercontent\.com\//.test(url)) return '';
      this.lastGithubError = '';
      return url;
    } catch (err) {
      this.lastGithubError = `PUT /contents threw: ${String(err).slice(0, 200)}`;
      return '';
    }
  }

  private async createIssue(
    report: BugReport,
    imageUrl: string,
    imageFailed: boolean,
  ): Promise<{ number: number; url: string } | null> {
    try {
      const res = await this.fetchImpl(this.api('/issues'), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: report.title,
          body: issueBody(report, imageUrl, imageFailed),
          // The label the user created. One label, named here, and it is the
          // only one this endpoint can ever apply.
          labels: ['bug'],
        }),
      });
      if (!res.ok) {
        this.lastGithubError = `POST /issues -> ${res.status}`;
        return null;
      }
      const issue = (await res.json()) as { number?: number; html_url?: string };
      if (typeof issue.number !== 'number') return null;
      this.lastGithubError = '';
      console.log(`[sydney] bugs: filed "${report.title}" as ${this.repo}#${issue.number}`);
      return { number: issue.number, url: typeof issue.html_url === 'string' ? issue.html_url : '' };
    } catch (err) {
      this.lastGithubError = `POST /issues threw: ${String(err).slice(0, 200)}`;
      return null;
    }
  }

  /**
   * Write a report to the queue directory.
   *
   * The image goes beside the JSON as its own file rather than base64 inside it,
   * so a queue of ten reports is ten pictures on disk rather than 40 MB of text
   * that has to be parsed to be counted. `data/` is gitignored in full and is
   * not served by anything -- which is the point `defaultLedgerPath` makes at
   * length about where a suggestions ledger must not live.
   */
  private async enqueue(report: BugReport): Promise<boolean> {
    try {
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      const id = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
      await Bun.$`mkdir -p ${this.dir}`.quiet();
      if (report.image) {
        await Bun.write(`${this.dir}/${id}.${report.image.kind === 'png' ? 'png' : 'jpg'}`, report.image.bytes);
      }
      await Bun.write(
        `${this.dir}/${id}.json`,
        JSON.stringify(
          {
            clientId: report.clientId,
            title: report.title,
            body: report.body,
            meta: report.meta,
            imageKind: report.image?.kind ?? null,
            at: this.now(),
          },
          null,
          1,
        ),
      );
      this.queued++;
      return true;
    } catch (err) {
      console.error(`[sydney] bugs: could not queue a report: ${String(err)}`);
      return false;
    }
  }

  /**
   * Post everything in the queue, oldest first.
   *
   * Guarded by `draining` on `SuggestionStore.sync`'s argument: two concurrent
   * drains would file the same report twice, and a duplicate issue cannot be
   * un-filed. A report that posts is deleted from the queue; one that does not
   * is left where it is and tried again next minute.
   */
  async drain(): Promise<number> {
    if (this.draining || !this.linked) return 0;
    this.draining = true;
    let posted = 0;
    try {
      const listing = await Bun.$`ls -1 ${this.dir}`.quiet().nothrow();
      const names = listing.stdout
        .toString()
        .split('\n')
        .filter((n) => n.endsWith('.json'))
        .sort();
      for (const name of names) {
        const path = `${this.dir}/${name}`;
        let stored: {
          clientId?: string;
          title?: string;
          body?: string;
          meta?: Array<[string, string]>;
          imageKind?: 'png' | 'jpeg' | null;
        };
        try {
          stored = (await Bun.file(path).json()) as typeof stored;
        } catch {
          continue; // a half-written file; the next pass will find it whole
        }
        let image: SafeImage | null = null;
        if (stored.imageKind) {
          const ext = stored.imageKind === 'png' ? 'png' : 'jpg';
          const imgPath = `${this.dir}/${name.replace(/\.json$/, `.${ext}`)}`;
          try {
            const bytes = new Uint8Array(await Bun.file(imgPath).arrayBuffer());
            // Re-sanitised on the way out, not trusted because it was
            // sanitised on the way in. The queue is a file on a disk and the
            // cheapest possible assumption is that something else touched it.
            image = sanitiseImage(bytes);
          } catch {
            image = null;
          }
        }
        const out = await this.post({
          clientId: stored.clientId ?? '',
          title: sanitiseTitle(stored.title ?? '') || 'a bug report',
          body: sanitiseBody(stored.body ?? ''),
          meta: Array.isArray(stored.meta) ? stored.meta : [],
          image,
        });
        if (out === null) break; // GitHub is unwell; stop rather than hammer it
        posted++;
        await Bun.$`rm -f ${path}`.quiet().nothrow();
        if (stored.imageKind) {
          const ext = stored.imageKind === 'png' ? 'png' : 'jpg';
          await Bun.$`rm -f ${`${this.dir}/${name.replace(/\.json$/, `.${ext}`)}`}`.quiet().nothrow();
        }
      }
    } finally {
      this.draining = false;
    }
    if (posted > 0) console.log(`[sydney] bugs: drained ${posted} queued report(s)`);
    return posted;
  }
}

/**
 * The issue body: the player's words first, then the picture, then the machine's
 * facts folded away.
 *
 * The order is the whole design, and it is the same argument
 * `SuggestionStore.issueBody` makes: somebody triaging this opens it to find out
 * what is broken, so the sentence a human wrote is at the top and the twenty
 * fields a program assembled are inside a `<details>` that is shut. The
 * metadata is *available* without being *in the way*, which is what the
 * requirement asked for -- a bug report with a position is worth ten without
 * one, right up until the position is the first thing you have to read past.
 */
export function issueBody(report: BugReport, imageUrl: string, imageFailed: boolean): string {
  const parts: string[] = [report.body || '_(no detail given)_', ''];
  if (imageUrl) {
    // The alt text is a literal. The player's title in an image alt would be
    // their text in a position markdown treats specially, for no gain.
    parts.push(`![screenshot](${imageUrl})`, '');
  } else if (imageFailed) {
    parts.push('_A screenshot was attached but would not upload._', '');
  }
  parts.push('<details>', '<summary>Where and when — attached automatically</summary>', '');
  parts.push('| | |', '|---|---|');
  for (const [key, value] of report.meta) {
    // Pipes escaped, because a value containing one would otherwise add a
    // column to this table and push the rest of the row out of it.
    parts.push(`| ${key} | ${value.replace(/\|/g, '\\|')} |`);
  }
  parts.push('', '_Filed from the in-game bug box. Everything in this block was collected by the game, not typed._', '</details>');
  return parts.join('\n');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In 32 kB windows: `String.fromCharCode(...bytes)` on a four-megabyte array
  // is an argument list a few million long, which throws a range error on every
  // engine. This is the one line in this file where the size cap is not the
  // thing protecting it.
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

// --- The rate limits -----------------------------------------------------------

/**
 * Three buckets and a sweeper.
 *
 * `FloodGuard` does the arithmetic; this holds one per identity and one for
 * everybody. The sweep is not tidiness -- without it, a map keyed on a
 * client-supplied string is a memory leak with a public endpoint in front of it,
 * which is the whole attack.
 */
export class BugGuards {
  private readonly admitClient = new Map<string, { guard: FloodGuard; at: number }>();
  private readonly admitIp = new Map<string, { guard: FloodGuard; at: number }>();
  private readonly byClient = new Map<string, { guard: FloodGuard; at: number }>();
  private readonly byIp = new Map<string, { guard: FloodGuard; at: number }>();
  private readonly hourly: FloodGuard;
  /** So a full map cannot be grown without bound even inside the TTL. */
  private static readonly MAX_KEYS = 20_000;

  constructor(now = Date.now()) {
    this.hourly = new FloodGuard(now, HOURLY_ISSUES, HOURLY_ISSUES / 3600);
  }

  /**
   * May this request be *looked at*? The cheap tier.
   *
   * Charged on every well-formed request, valid or not, and in front of the
   * image decode -- which is the expensive work this exists to make
   * unreachable. Twenty is far above what a person clicking a button can do and
   * far below what a loop does in a millisecond, and those two are three orders
   * of magnitude apart, so there is no tuning to get wrong.
   */
  admit(clientId: string, ip: string, now = Date.now()): { ok: boolean; why: string } {
    this.sweep(now);
    const client = this.bucket(this.admitClient, clientId, ADMIT_BURST, ADMIT_REFILL_PER_SEC, now);
    const address = this.bucket(this.admitIp, ip, ADMIT_BURST, ADMIT_REFILL_PER_SEC, now);
    // Both are charged rather than short-circuited, so a client that is over one
    // limit cannot get free tokens on the other by continuing to try.
    const clientOk = client.allow(now);
    const addressOk = address.allow(now);
    if (clientOk && addressOk) return { ok: true, why: '' };
    return { ok: false, why: 'slow down a moment.' };
  }

  /**
   * May this report become an issue? The expensive tier.
   *
   * Called **only when everything else has already passed**, so a refused
   * upload, a missing title or a GIF costs a player nothing. Checked in the
   * order that gives the best message: global last, deliberately, because a
   * player who is over their own limit should be told it is their own limit --
   * that is a thing they can wait out. Being told "the game has had enough
   * reports this hour" when in fact they personally filed four in a minute
   * would be true and useless.
   */
  claim(clientId: string, ip: string, now = Date.now()): { ok: boolean; why: string } {
    const client = this.bucket(this.byClient, clientId, CLIENT_BURST, CLIENT_REFILL_PER_SEC, now);
    if (!client.allow(now)) {
      return { ok: false, why: 'you have filed a few already — give it ten minutes and try again.' };
    }
    const address = this.bucket(this.byIp, ip, IP_BURST, IP_REFILL_PER_SEC, now);
    if (!address.allow(now)) {
      return { ok: false, why: 'this connection has filed its share — give it ten minutes.' };
    }
    if (!this.hourly.allow(now)) {
      return { ok: false, why: 'the bug box is full for this hour. it opens again shortly.' };
    }
    return { ok: true, why: '' };
  }

  private bucket(
    map: Map<string, { guard: FloodGuard; at: number }>,
    key: string,
    burst: number,
    refill: number,
    now: number,
  ): FloodGuard {
    let found = map.get(key);
    if (!found) {
      // A map at its ceiling stops admitting new keys rather than evicting old
      // ones: evicting is what an attacker with twenty thousand identities
      // wants, because the key it evicts is theirs from a minute ago.
      if (map.size >= BugGuards.MAX_KEYS) return new FloodGuard(now, 0, 0);
      found = { guard: new FloodGuard(now, burst, refill), at: now };
      map.set(key, found);
    }
    found.at = now;
    return found.guard;
  }

  private sweep(now: number): void {
    for (const map of [this.admitClient, this.admitIp, this.byClient, this.byIp]) {
      if (map.size < 64) continue; // nothing worth walking
      for (const [key, entry] of map) {
        if (now - entry.at > BUCKET_TTL_MS) map.delete(key);
      }
    }
  }
}

// --- The route -----------------------------------------------------------------

/**
 * `POST /bug`, and the whole of what a client can reach.
 *
 * Every rejection is a literal in this file and none of them says anything
 * about GitHub, the token, the repository or the filesystem. The status codes
 * are for a proxy log; the player reads `message`.
 *
 * The order is: rate limit, then size, then parse, then validate, then the
 * image, then GitHub. Everything cheap is in front of everything expensive,
 * which is the property that makes the endpoint survivable under a flood made
 * entirely of individually legal requests.
 */
export async function handleBugRequest(
  req: Request,
  ip: string,
  store: BugStore,
  guards: BugGuards,
  /**
   * The handle of the account this report is filed by, or `null` for a guest.
   *
   * Resolved by `server/index.ts` from the request's `Authorization: Bearer`
   * header before this is called, on the same seam the IP arrives on: this file
   * knows what a bug report is and nothing about tokens, exactly as it knows
   * nothing about how `ip` was obtained.
   *
   * A **handle rather than a boolean**, because the gate is not the only thing
   * the account is good for -- see where it is used below.
   */
  author: string | null,
  now = Date.now(),
): Promise<Response> {
  if (req.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));
  if (req.method !== 'POST') {
    return bugJson({ status: 405, result: 'rejected', issue: 0, url: '', message: 'POST a report here.' });
  }

  const body = await readCappedBody(req);
  if (!body.ok) {
    return bugJson({
      // 413 for the size and 400 for everything else, which is the difference
      // between "smaller" and "again".
      status: /too big/.test(body.why) ? 413 : 400,
      result: 'rejected',
      issue: 0,
      url: '',
      message: body.why,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(body.text) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    parsed = raw as Record<string, unknown>;
  } catch {
    return bugJson({ status: 400, result: 'rejected', issue: 0, url: '', message: 'that report did not arrive intact.' });
  }

  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : '';
  if (!validClientId(clientId)) {
    return bugJson({ status: 400, result: 'rejected', issue: 0, url: '', message: 'this client has no id — reload the page.' });
  }

  /*
   * --- The account gate. Workstream G: *"the bug reporter requires an
   * account"*.
   *
   * **In front of the image decode and behind the client id**, which is the
   * ordering this whole route is built on: everything cheap before everything
   * expensive. A guest attaching a four-megabyte screenshot should be refused
   * before the base64 is decoded, not after -- but they should also be told
   * something better than "no id", so the id check stays first.
   *
   * 401 rather than 403: the request is not forbidden, it is unauthenticated,
   * and the difference is what the client's status line says. The player reads
   * `message`; the code is for whoever is reading a proxy log at three in the
   * morning wondering why the bug box went quiet.
   *
   * Worth saying why the bug box is gated at all, since it is the one surface
   * here whose value goes *down* with friction: it is the only public endpoint
   * in this process that writes bytes into a public repository (see the file
   * header). Every other rate limit here is about volume; this one is about the
   * fact that a report which cannot be traced to a durable identity cannot be
   * followed up, and a repository full of anonymous single-line issues is a
   * repository nobody reads.
   */
  if (author === null) {
    return bugJson({
      status: 401,
      result: 'rejected',
      issue: 0,
      url: '',
      message: 'sign up to send feedback — bug reports need an account.',
    });
  }

  // The cheap tier, **before** the image is decoded. Decoding four megabytes of
  // base64 for a client that is hammering this route is the work this ordering
  // exists to skip. The expensive tier is at the bottom, after everything has
  // been validated -- see `BugGuards` for why the two are separate.
  const admitted = guards.admit(clientId, ip, now);
  if (!admitted.ok) {
    return bugJson({ status: 429, result: 'rate', issue: 0, url: '', message: admitted.why });
  }

  const title = sanitiseTitle(typeof parsed.title === 'string' ? parsed.title : '');
  if (title === '') {
    return bugJson({
      status: 400,
      result: 'rejected',
      issue: 0,
      url: '',
      message: 'give it a title — one line about what went wrong.',
    });
  }
  const reportBody = sanitiseBody(typeof parsed.body === 'string' ? parsed.body : '');

  let image: SafeImage | null = null;
  const rawImage = typeof parsed.image === 'string' ? parsed.image : '';
  if (rawImage !== '') {
    const bytes = decodeImagePayload(rawImage);
    if (bytes === null) {
      return bugJson({
        status: 413,
        result: 'rejected',
        issue: 0,
        url: '',
        message: 'that image is too big — a few megabytes at most.',
      });
    }
    image = sanitiseImage(bytes);
    if (image === null) {
      return bugJson({
        status: 415,
        result: 'rejected',
        issue: 0,
        url: '',
        message: 'that file is not a PNG or a JPEG. attach a screenshot instead.',
      });
    }
  }

  // The filing budget, claimed **here**: everything about this report is now
  // decided and the next thing that happens is a commit into a public
  // repository. Charging it any earlier is what made a rejected GIF cost a
  // player one of their three reports. See `BugGuards`.
  const claimed = guards.claim(clientId, ip, now);
  if (!claimed.ok) {
    return bugJson({ status: 429, result: 'rate', issue: 0, url: '', message: claimed.why });
  }

  // The handle goes into the report's metadata rather than into its title, so
  // an issue says who filed it without the board becoming a list of names. It
  // is the **server's** answer to who this is (a verified token), which is what
  // makes it worth recording at all -- `SuggestionHub.handle` makes the same
  // argument about taking the author off the participant rather than the frame.
  const meta = sanitiseMeta(parsed.meta);
  meta.unshift(['account', author]);
  const outcome = await store.file({
    clientId,
    title,
    body: reportBody,
    meta,
    image,
  });
  return bugJson(outcome);
}

function bugJson(outcome: BugOutcome): Response {
  return corsResponse(
    new Response(
      JSON.stringify({
        ok: outcome.result === 'filed' || outcome.result === 'queued',
        result: outcome.result,
        issue: outcome.issue,
        url: outcome.url,
        message: outcome.message,
      }),
      { status: outcome.status, headers: { 'content-type': 'application/json' } },
    ),
  );
}

/**
 * The CORS headers, which this route needs and `/rooms` does not.
 *
 * A `POST` with `content-type: application/json` is not a simple request, so a
 * browser sends a preflight `OPTIONS` first -- which is why that method is
 * answered above. In production Caddy proxies this on the page's own origin and
 * none of it fires; in development the page is on vite's 5173 and every one of
 * these headers is load-bearing.
 */
function corsResponse(res: Response): Response {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  res.headers.set('access-control-max-age', '600');
  return res;
}

// --- Where the queue lives -----------------------------------------------------

/**
 * `SYDNEY_BUGS`, or `data/bugs/`.
 *
 * `data/` for `defaultLedgerPath`'s reasons, restated because they are the ones
 * that matter most here: it is this project's durable-state directory, it is
 * `.gitignore`d in full, and **nothing serves it**. A queue of bug reports under
 * `client/public/` would be a public directory of screenshots of players'
 * screens, live on the web, with a `git add -A` waiting to make it permanent.
 */
export function defaultBugDir(): string {
  return process.env.SYDNEY_BUGS ?? new URL('../data/bugs', import.meta.url).pathname;
}

// --- The self-check ------------------------------------------------------------

/**
 * Run at boot, beside `verifySuggestions`, on the same criterion: **every way
 * this breaks leaves a server that runs.**
 *
 * The six silent failures it exists to catch, in the order they would hurt:
 *
 *   - A **sniffer that trusts a content type** commits whatever it was sent
 *     under a `.png` name. Nothing throws; the repository grows a file that is
 *     not a picture.
 *   - A **rebuild that copies the file through** leaves EXIF in place, and the
 *     first player to attach a phone photo publishes their home coordinates.
 *     There is no error and no symptom -- the picture looks identical.
 *   - A **CRC that is not checked** accepts a PNG header with anything after it.
 *   - A **JPEG walker that walks the scan** treats entropy-coded bytes as
 *     markers and either mangles the image or loops.
 *   - A **cap enforced after buffering** is not a cap, and the way to tell is
 *     that it still passes every test that sends a small body.
 *   - A **path built from a client string** is the whole endpoint, given away.
 *
 *     bun -e "import {verifyBugs} from './server/bugs.ts'; console.log(verifyBugs())"
 */
export function verifyBugs(): string[] {
  const failures: string[] = [];

  // --- The sniffer, including everything it must refuse.
  {
    const png = makePng(2, 3, [['tEXt', new TextEncoder().encode('Comment hi')]]);
    if (sniffImage(png) !== 'png') failures.push('a real PNG was not recognised as one.');
    if (sniffImage(makeJpeg(4, 5, true)) !== 'jpeg') failures.push('a real JPEG was not recognised as one.');
    const refuse: Array<[string, Uint8Array]> = [
      ['a GIF', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0])],
      ['a WebP', new TextEncoder().encode('RIFF    WEBPVP8 ')],
      ['an SVG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
      ['a PHP file', new TextEncoder().encode('<?php system($_GET["c"]); ?>')],
      ['an ELF binary', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])],
      ['empty bytes', new Uint8Array(0)],
      ['a PNG signature and nothing else', new Uint8Array(PNG_SIGNATURE)],
    ];
    for (const [what, bytes] of refuse) {
      if (sanitiseImage(bytes) !== null) failures.push(`${what} was accepted as an image.`);
    }
  }

  // --- The PNG rebuild: the text chunk goes, the picture stays, the CRC bites.
  {
    const gps = new TextEncoder().encode('GPSLatitude -33.8688');
    const withText = makePng(8, 8, [
      ['tEXt', gps],
      ['eXIf', gps],
      ['tIME', new Uint8Array(7)],
    ]);
    const safe = sanitiseImage(withText);
    if (safe === null) {
      failures.push('a PNG carrying text chunks was refused rather than cleaned.');
    } else {
      if (safe.width !== 8 || safe.height !== 8) {
        failures.push(`the rebuilt PNG reports ${safe.width}x${safe.height}, not 8x8.`);
      }
      if (contains(safe.bytes, gps)) failures.push('EXIF/text bytes survived the PNG rebuild.');
      if (!contains(safe.bytes, new TextEncoder().encode('IDAT'))) {
        failures.push('the rebuilt PNG has no image data in it.');
      }
      if (safe.bytes.length >= withText.length) {
        failures.push('the rebuilt PNG is no smaller than the one with metadata in it.');
      }
      // And it is still a PNG by its own rules, which is what makes the strip
      // safe rather than merely small.
      if (sanitiseImage(safe.bytes) === null) failures.push('the rebuilt PNG does not survive its own validator.');
    }
    // A corrupted CRC on a kept chunk must be refused, not repaired.
    const broken = makePng(8, 8, []);
    broken[broken.length - 5] ^= 0xff; // inside IEND's CRC
    if (rebuildPng(broken) !== null) failures.push('a PNG with a bad chunk CRC was accepted.');
    // A declared length that runs off the end must be refused rather than read.
    const overrun = makePng(8, 8, []);
    overrun[8] = 0x7f; // IHDR length becomes enormous
    if (rebuildPng(overrun) !== null) failures.push('a PNG whose chunk length runs past the file was accepted.');
    // A bomb: the header alone claims more pixels than anything can hold.
    const huge = makePng(65_000, 65_000, []);
    if (rebuildPng(huge) !== null) failures.push(`a ${MAX_DIMENSION}+ pixel PNG was accepted.`);
  }

  // --- The JPEG rebuild: APP1 goes, the scan survives byte for byte.
  {
    const exif = new TextEncoder().encode('Exif  MM*GPSLatitudeRef');
    const jpeg = makeJpeg(16, 9, true, exif);
    const safe = sanitiseImage(jpeg);
    if (safe === null) {
      failures.push('a JPEG carrying an EXIF segment was refused rather than cleaned.');
    } else {
      if (safe.width !== 16 || safe.height !== 9) {
        failures.push(`the rebuilt JPEG reports ${safe.width}x${safe.height}, not 16x9.`);
      }
      if (contains(safe.bytes, exif)) failures.push('EXIF bytes survived the JPEG rebuild.');
      if (safe.bytes[0] !== 0xff || safe.bytes[1] !== 0xd8) failures.push('the rebuilt JPEG has no SOI.');
      const n = safe.bytes.length;
      if (safe.bytes[n - 2] !== 0xff || safe.bytes[n - 1] !== 0xd9) failures.push('the rebuilt JPEG has no EOI.');
      if (sanitiseImage(safe.bytes) === null) failures.push('the rebuilt JPEG does not survive its own validator.');
      // The scan is copied verbatim: a walker that treated an FF inside the
      // entropy data as a marker would have truncated or corrupted it here,
      // because `makeJpeg` puts a stuffed FF00 in the scan on purpose.
      if (!contains(safe.bytes, new Uint8Array([0xff, 0x00, 0x42]))) {
        failures.push('the JPEG scan was altered; a stuffed FF00 did not survive.');
      }
    }
    // A JPEG that is only a header is not a picture.
    if (rebuildJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) !== null) {
      failures.push('a JPEG with no frame and no scan was accepted.');
    }
  }

  // --- Base64, and the length gate in front of the decoder.
  {
    if (decodeImagePayload('') !== null) failures.push('an empty payload decoded to something.');
    if (decodeImagePayload('not base64 at all!!') !== null) failures.push('a non-base64 payload decoded.');
    if (decodeImagePayload('A'.repeat(MAX_IMAGE_BYTES * 2)) !== null) {
      failures.push('an over-long base64 string was decoded rather than refused by its length.');
    }
    const round = decodeImagePayload(`data:image/png;base64,${btoa('hello')}`);
    if (round === null || new TextDecoder().decode(round) !== 'hello') {
      failures.push('a data URI did not round-trip through the decoder.');
    }
    // The declared media type is ignored: these bytes are PNG whatever the URI
    // says, and `sniffImage` is the only thing that decides.
    const lying = decodeImagePayload(`data:image/jpeg;base64,${toBase64(makePng(2, 2, []))}`);
    if (lying === null || sniffImage(lying) !== 'png') {
      failures.push('the media type in a data URI was believed over the bytes.');
    }
  }

  // --- The generated path, which is the one string that must never be theirs.
  {
    for (let i = 0; i < 50; i++) {
      const path = imagePath(i % 2 === 0 ? 'png' : 'jpeg');
      if (!SAFE_PATH.test(path)) failures.push(`imagePath produced "${path}", which is not a safe path.`);
    }
    const a = imagePath('png');
    const b = imagePath('png');
    if (a === b) failures.push('two generated paths collided; one report would overwrite another.');
  }

  // --- The metadata sanitiser.
  {
    const meta = sanitiseMeta({
      street: 'cnr King St & Carillon Ave',
      'x/z': '-2492.5 / 4281.6',
      'evil key': '<!-- ends the details block -->',
      'not a key!': 'dropped for its key',
      frame: 16.6667,
      riding: true,
      nothing: null,
      long: 'x'.repeat(1000),
    });
    const asMap = new Map(meta);
    if (!asMap.has('street')) failures.push('a plain metadata field was dropped.');
    if (asMap.has('not a key!')) failures.push('a metadata key with punctuation in it was kept.');
    if (asMap.has('nothing')) failures.push('a null metadata value was kept.');
    if (asMap.get('riding') !== 'true') failures.push('a boolean metadata value was not rendered.');
    if ((asMap.get('long') ?? '').length > MAX_META_VALUE) failures.push('a metadata value was not clipped.');
    if (/<!--/.test(asMap.get('evil key') ?? '')) {
      failures.push('a comment marker survived into a metadata value; it would end the details block.');
    }
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`field ${i}`] = 'x';
    if (sanitiseMeta(many).length > MAX_META_FIELDS) failures.push('the metadata field cap did not hold.');
    if (sanitiseMeta('a string').length !== 0) failures.push('a non-object metadata block produced fields.');
  }

  // --- The issue body: the words first, the facts folded, the pipes escaped.
  {
    const body = issueBody(
      {
        clientId: '',
        title: 'the train has no floor',
        body: 'i fell through it at Redfern',
        meta: [
          ['street', 'Gibbons St'],
          ['pipe', 'a | b'],
        ],
        image: null,
      },
      'https://raw.githubusercontent.com/voidtype/sydrunner/main/bugs/x.png',
      false,
    );
    if (body.indexOf('i fell through it') > body.indexOf('<details>')) {
      failures.push("the player's words are below the metadata block, not above it.");
    }
    if (!body.includes('![screenshot](https://raw.githubusercontent.com/')) {
      failures.push('the image URL is not embedded in the issue body.');
    }
    if (!body.includes('| pipe | a \\| b |')) failures.push('a pipe in a metadata value was not escaped.');
    if (!/<details>[\s\S]*<\/details>/.test(body)) failures.push('the details block is not closed.');
  }

  // --- The rate limits, both tiers, and the thing the two tiers exist for.
  {
    const one = 'aaaaaaaa-1111-4111-8111-111111111111';
    const guards = new BugGuards(0);
    let filed = 0;
    for (let i = 0; i < 6; i++) {
      if (guards.claim(one, '10.0.0.1', i).ok) filed++;
    }
    if (filed !== CLIENT_BURST) {
      failures.push(`one client filed ${filed} reports in a burst; the cap is ${CLIENT_BURST}.`);
    }

    // **The regression this pair of tiers exists for.** Ten requests that never
    // reached a filing decision -- a GIF, a missing title, a mistyped word --
    // must leave the filing budget untouched, so the eleventh, which is a real
    // report, still goes. The first cut charged one bucket at admission and
    // this is exactly what it got wrong.
    const patient = new BugGuards(0);
    for (let i = 0; i < 10; i++) patient.admit(one, '10.0.0.1', i);
    let after = 0;
    for (let i = 0; i < 5; i++) {
      if (patient.claim(one, '10.0.0.1', 10 + i).ok) after++;
    }
    if (after !== CLIENT_BURST) {
      failures.push(
        `after ten rejected requests a client could file ${after} reports, not ${CLIENT_BURST}; ` +
          'refusals are spending the filing budget.',
      );
    }

    // And the cheap tier still stops a loop.
    const flooded = new BugGuards(0);
    let admitted = 0;
    for (let i = 0; i < 200; i++) {
      if (flooded.admit(one, '10.0.0.1', 0).ok) admitted++; // all in the same millisecond
    }
    if (admitted !== ADMIT_BURST) {
      failures.push(`a loop got ${admitted} requests admitted in one millisecond; the burst is ${ADMIT_BURST}.`);
    }

    // Fresh identities from fresh addresses, until the hourly ceiling stops
    // them. This is the limit that an attacker cannot buy their way past, and
    // it is the only one that holds when both of the others are trivially
    // defeated by minting a new UUID from a new address.
    const fresh = new BugGuards(0);
    let total = 0;
    for (let i = 0; i < 60; i++) {
      if (fresh.claim(crypto.randomUUID(), `10.0.${i >> 8}.${i & 255}`, i).ok) total++;
    }
    if (total !== HOURLY_ISSUES) {
      failures.push(`sixty fresh identities filed ${total} reports in an hour; the ceiling is ${HOURLY_ISSUES}.`);
    }
  }

  return failures;
}

/** Do these bytes appear in that buffer? For the strip assertions. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * A syntactically valid PNG with whatever ancillary chunks are asked for.
 *
 * Not a *renderable* PNG -- the IDAT is a fixed deflate stream that no decoder
 * is asked to read -- because nothing in this file decodes pixels. What it has
 * to be is structurally exact, chunk lengths and CRCs included, or the validator
 * under test would refuse it for the wrong reason and the check would pass while
 * asserting nothing. Exported so the integration check builds its fixtures the
 * same way.
 */
export function makePng(width: number, height: number, extra: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunks.push(pngChunk('IHDR', ihdr));
  for (const [type, data] of extra) chunks.push(pngChunk(type, data));
  chunks.push(pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])));
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * A syntactically valid JPEG: SOI, an optional APP1, an SOF0, an SOS, a scan
 * with a stuffed `FF00` in it, and an EOI.
 *
 * The stuffed byte is the point of the fixture. Entropy-coded data contains
 * `FF 00` wherever the encoder emitted a literal `FF`, and a rebuilder that
 * walked the scan looking for markers would stop at it or corrupt it -- so the
 * check looks for those exact three bytes on the far side.
 */
export function makeJpeg(width: number, height: number, withScan: boolean, app1?: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (app1) {
    const seg = new Uint8Array(4 + app1.length);
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg[2] = ((app1.length + 2) >> 8) & 0xff;
    seg[3] = (app1.length + 2) & 0xff;
    seg.set(app1, 4);
    parts.push(seg);
  }
  if (withScan) {
    // SOF0: length 11, 8-bit, height, width, one component.
    parts.push(
      new Uint8Array([
        0xff, 0xc0, 0x00, 0x0b, 0x08,
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x01, 0x01, 0x11, 0x00,
      ]),
    );
    // SOS: length 8, one component, then the entropy data.
    parts.push(new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
    parts.push(new Uint8Array([0x9a, 0xff, 0x00, 0x42, 0x17]));
  }
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(parts);
}
