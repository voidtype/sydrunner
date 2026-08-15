/**
 * The change feed's shape, its parser and its dates -- the half with no DOM in
 * it.
 *
 * Split from `client/src/changelog.ts` (the tab that draws it) on
 * `net/suggestions.ts`'s exact precedent, and for that file's exact reason:
 * **the server's `tsconfig.json` has no `dom` library**, deliberately, so that a
 * shared module which silently reached for a browser global fails at a type
 * check rather than three hours into a match. `server/integration-check.ts`
 * runs `verifyChangelog` and asserts `parseChangelog` against the real
 * generated file, and it can only do that if this half never touches a
 * `document`.
 *
 * So: types, the parser, the date arithmetic and the self-check live here.
 * Everything that creates an element lives one directory up.
 */

/** One change, as `scripts/changelog.mjs` writes it. */
export interface ChangeEntry {
  /** The short hash. Provenance, and the only thing here that is not prose. */
  hash: string;
  /** `YYYY-MM-DD`, the author date. */
  at: string;
  title: string;
  /** The first paragraph of the body, clipped. May be empty. */
  detail: string;
}

export interface Changelog {
  /** The commit this bundle was built from. `''` when unknown. */
  build: string;
  /** Was the tree dirty when it was built? True on a developer's machine. */
  dirty: boolean;
  entries: ChangeEntry[];
}

/** Nothing known. Distinguishable from "known to be empty" only by `entries`. */
export const NO_CHANGELOG: Changelog = { build: '', dirty: false, entries: [] };

/** How many are ever drawn, whatever the file holds. */
export const SHOWN = 3;

/**
 * Turn whatever came back into a changelog, or into nothing.
 *
 * Total by construction: every field is read defensively, every string is
 * clipped, and anything that is not the shape this expects produces
 * `NO_CHANGELOG` rather than a throw. The three inputs that are not
 * hypothetical:
 *
 *   - **`undefined`** -- the fetch failed, or the file is not there. A fresh
 *     clone that has never run `scripts/changelog.mjs` is exactly this.
 *   - **A string of HTML** -- vite's dev server and most static hosts answer an
 *     unknown path with `index.html`, so a missing file arrives as a successful
 *     200 whose body is a document. `JSON.parse` throws on it, which is caught
 *     by the caller; this function never sees it. It is named here because the
 *     first cut of this feature treated a 200 as proof and drew "undefined".
 *   - **An older or newer file** -- a field added or removed by a later version
 *     of the generator. Reading each field independently means a file with an
 *     extra key still works and one with a missing key degrades to a default.
 */
export function parseChangelog(raw: unknown): Changelog {
  if (raw === null || typeof raw !== 'object') return NO_CHANGELOG;
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.entries) ? obj.entries : [];
  const entries: ChangeEntry[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const hash = text(e.hash, 12);
    const title = text(e.title, 160);
    // A hash *and* a title, both. An entry with neither is a row that says
    // nothing; an entry with a hash and no title is a row that says a hash.
    if (hash === '' || title === '') continue;
    entries.push({ hash, at: text(e.at, 10), title, detail: text(e.detail, 200) });
    if (entries.length >= SHOWN) break;
  }
  if (entries.length === 0) return NO_CHANGELOG;
  return { build: text(obj.build, 12), dirty: obj.dirty === true, entries };
}

/**
 * A string field, cleaned to something safe to put in a `textContent`.
 *
 * Control characters out and length capped, which is the same shape
 * `net/suggestions.sanitiseText` applies to a player's prose and for a weaker
 * reason: this text comes from the repository's own history rather than from a
 * stranger. It is done anyway because "the input is trusted" is a claim that
 * survives exactly until somebody points the generator at a fork.
 */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...cleaned].slice(0, max).join('');
}

/**
 * `2026-08-13` as something a person reads.
 *
 * Relative for the first fortnight -- "yesterday", "4 days ago" -- and a date
 * after that. The switch is deliberate: "3 days ago" is what somebody wants to
 * know about a change that is new, and "12 Aug" is what they want about one
 * that is not, because by then the day of the week has stopped meaning anything.
 *
 * `at` is a date and not an instant, and the arithmetic is done in **local
 * days** rather than in milliseconds: a commit made at 23:00 and read at 01:00
 * is "yesterday", which a 24-hour subtraction would call "today".
 */
export function whenText(at: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
  if (!m) return '';
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return then.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/**
 * The self-check, on `verifySuggestions`' criterion: **every way this breaks
 * produces text**, and text renders perfectly.
 *
 * The four silent failures it exists to catch, all of which leave a game that
 * runs and a panel that opens:
 *
 *   - A **parser that trusts the shape** draws `undefined` three times when the
 *     file is missing and the host answered with `index.html`. That is the
 *     failure this feature is most likely to have in production, because it is
 *     the one that only happens on a host nobody tested against.
 *   - A **date difference in milliseconds** calls a commit made at 23:00
 *     "today" when it is read at 01:00 the next morning, so the newest entry is
 *     dated wrong exactly when somebody is looking to see whether their fix
 *     shipped.
 *   - **More than three entries** drawn from a file that happens to hold more
 *     turns a compact feed into a scrolling list of the whole history.
 *   - A **clip that counts UTF-16 units** cuts an emoji in a commit subject in
 *     half, which renders as a black diamond and looks like a corrupt file.
 *
 *     bun -e "import {verifyChangelog} from './client/src/changelog.ts';
 *             console.log(verifyChangelog())"
 */
export function verifyChangelog(): string[] {
  const failures: string[] = [];

  // --- The shapes that are not a changelog. None may throw, all draw nothing.
  {
    const nothing: unknown[] = [
      undefined,
      null,
      '',
      '<!doctype html><html><body>vite</body></html>',
      42,
      [],
      {},
      { entries: 'three' },
      { entries: [null, 3, 'x'] },
      { entries: [{ hash: 'abc' }] },
      { entries: [{ title: 'a change with no hash' }] },
    ];
    for (const raw of nothing) {
      let got: Changelog;
      try {
        got = parseChangelog(raw);
      } catch (err) {
        failures.push(`parseChangelog(${JSON.stringify(raw) ?? 'undefined'}) threw ${String(err)}.`);
        continue;
      }
      if (got.entries.length !== 0) {
        failures.push(`parseChangelog(${JSON.stringify(raw)}) produced ${got.entries.length} entries, not 0.`);
      }
    }
  }

  // --- A real file, and the cap.
  {
    const many = {
      build: '7555009',
      dirty: false,
      entries: Array.from({ length: 9 }, (_, i) => ({
        hash: `abcdef${i}`,
        at: '2026-08-13',
        title: `a change number ${i}`,
        detail: 'why it happened',
      })),
    };
    const got = parseChangelog(many);
    if (got.entries.length !== SHOWN) {
      failures.push(`a file with 9 entries produced ${got.entries.length}, not ${SHOWN}.`);
    }
    if (got.build !== '7555009') failures.push(`the build hash came back as "${got.build}".`);
    if (got.entries[0]?.hash !== 'abcdef0') {
      failures.push('the first entry is not the first in the file; the feed would show the oldest three.');
    }
  }

  // --- Control characters and code points.
  {
    const got = parseChangelog({
      build: 'deadbee',
      entries: [{ hash: 'deadbee', at: '2026-08-13', title: 'a\u0007line\nbreak', detail: '' }],
    });
    if (/[\u0000-\u001f]/.test(got.entries[0]?.title ?? '')) {
      failures.push('a control character survived into a title that is drawn as textContent.');
    }
    // Ten astral code points are twenty UTF-16 units. A cap applied to `.length`
    // would cut the tenth in half.
    const emoji = '🚉'.repeat(40);
    const clipped = parseChangelog({
      entries: [{ hash: 'abc1234', at: '2026-08-13', title: emoji, detail: '' }],
    }).entries[0]?.title;
    if (clipped !== undefined && /�/.test(clipped)) {
      failures.push('clipping a title of astral characters split a code point.');
    }
    if (clipped !== undefined && [...clipped].length > 160) {
      failures.push(`a 40-character title clipped to ${[...clipped].length} characters, over the 160 cap.`);
    }
  }

  // --- The dates, in local days rather than in milliseconds.
  {
    // 23:00 on the 12th, read at 01:00 on the 13th, is yesterday.
    const lateNight = new Date(2026, 7, 13, 1, 0, 0);
    if (whenText('2026-08-12', lateNight) !== 'yesterday') {
      failures.push(
        `a commit dated the 12th read at 01:00 on the 13th is "${whenText('2026-08-12', lateNight)}", not "yesterday".`,
      );
    }
    if (whenText('2026-08-13', lateNight) !== 'today') {
      failures.push(`a commit dated today reads as "${whenText('2026-08-13', lateNight)}".`);
    }
    if (whenText('2026-08-09', lateNight) !== '4 days ago') {
      failures.push(`four days back reads as "${whenText('2026-08-09', lateNight)}".`);
    }
    // Past a fortnight it becomes a date, and it must not be empty.
    const old = whenText('2026-06-01', lateNight);
    if (old === '' || /ago/.test(old)) failures.push(`an old commit reads as "${old}", which is not a date.`);
    if (whenText('not a date') !== '') failures.push('a malformed date produced something rather than nothing.');
  }

  return failures;
}
