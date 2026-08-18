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
  /** The commit closed a player's suggestion. False on an old file. */
  suggestion: boolean;
  /** The issue number the suggestion closed; `0` when none was found. */
  issue: number;
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

/**
 * How many rows the feed draws at a time. The list is an infinitely scrollable
 * column: the first page is drawn on load, and each time the reader nears the
 * bottom the next page is appended, until the filtered entries are exhausted.
 */
export const PAGE_SIZE = 30;

/** How near the bottom (in px) counts as "nearing", before the next page loads. */
export const NEAR_BOTTOM = 200;

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
    // `suggestion` and `issue` read with defaults, so a file written by an
    // older generator (before the two existed) still renders: a missing flag is
    // false and a missing number is zero, neither of which draws a row wrong.
    entries.push({
      hash,
      at: text(e.at, 10),
      title,
      detail: text(e.detail, 200),
      suggestion: e.suggestion === true,
      issue: num(e.issue),
    });
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
 * An issue number, or `0`.
 *
 * The number the row links to, and the one thing a malformed file could hand
 * the renderer: a string, a negative, a NaN. Every one of those is "no number",
 * which is the same as a missing field, so they all fall to `0` rather than
 * drawing a link to `.../issues/NaN`.
 */
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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

/** The two things the filter bar can show. */
export type FeedFilter = 'all' | 'suggestion';

/**
 * The one line a row shows until it is hovered or focused.
 *
 * The date first, then the subject, and nothing else: `2026-08-17 · the
 * railway is visible`. The date is the raw `at` and not a relative "yesterday",
 * because a collapsed line is a list a player scans, and a scan reads dates
 * better than it reads "4 days ago" repeated down a column. The renderer draws
 * this and lets CSS clip it to the row width; the function only decides the
 * text, so it can be checked without a DOM.
 */
export function collapsedLine(entry: ChangeEntry): string {
  return `${entry.at} · ${entry.title}`;
}

/**
 * Which rows the filter shows.
 *
 * `all` is the whole feed; `suggestion` is only the rows the generator marked as
 * a player's suggestion. Pure, so the pager can run over the same list the
 * renderer does and the two cannot disagree about how many rows there are.
 */
export function filterEntries(entries: ChangeEntry[], filter: FeedFilter): ChangeEntry[] {
  return filter === 'suggestion' ? entries.filter((e) => e.suggestion) : entries;
}

/**
 * The next page of rows, or the empty array when there is no more to append.
 *
 * The pager is a slice, not a window: `rendered` is how many rows the column
 * already holds, and this returns the next `PAGE_SIZE` after them. It returns
 * `[]` rather than throwing when the feed is exhausted, because the caller's
 * only job then is to stop listening for scroll and an empty array is the
 * cleanest way to say "stop".
 */
export function pagerNext(entries: ChangeEntry[], rendered: number): ChangeEntry[] {
  if (rendered >= entries.length) return [];
  return entries.slice(rendered, rendered + PAGE_SIZE);
}

/**
 * The issue number a subject or body names, or `null`.
 *
 * The same test the generator runs over a commit's subject and body
 * (`scripts/changelog.mjs`), kept here so the self-check can assert it without a
 * git. A row is a suggestion when the text carries `(suggestion #N)`,
 * `suggestion #N`, or a `closes`/`fixes`/`resolves #N` trailer; the number is
 * what the row links to. `#4 platform` and `suggested by` are not: the first
 * has no keyword before the number, the second has a word that is not the
 * keyword.
 */
export function suggestMatch(text: string): number | null {
  const m = /(suggestion|closes|fixes|resolves)\s+#(\d+)/i.exec(text);
  return m ? Number(m[2]) : null;
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
 *   - A **file that holds more entries than the panel shows** used to be a bug;
 *     now the feed is a scrollable column, so the parser holds them all and the
 *     pager (checked in `verifyChangeFeed`) decides how many to draw at a time.
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

  // --- A real file, with no cap: every entry is held, and the new fields
  // default.
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
    if (got.entries.length !== 9) {
      failures.push(`a file with 9 entries produced ${got.entries.length}, not 9.`);
    }
    if (got.build !== '7555009') failures.push(`the build hash came back as "${got.build}".`);
    if (got.entries[0]?.hash !== 'abcdef0') {
      failures.push('the first entry is not the first in the file; the feed would show the oldest entries.');
    }
    // A file written before `suggestion`/`issue` existed still renders: a missing
    // flag is false and a missing number is zero, neither of which draws wrong.
    if (got.entries.some((e) => e.suggestion || e.issue !== 0)) {
      failures.push('an entry without suggestion/issue did not default to false and 0.');
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

/**
 * The self-check for the feed's new half: the suggestion regex, the collapsed
 * line, the filter and the pager.
 *
 * `verifyChangelog` above covers the parser and the dates; this covers the four
 * things added when the feed became a scrollable column with a suggestion
 * filter. All of them are pure, so the server can run this too, and the one
 * most likely to be wrong -- the regex, which the generator and this module
 * each keep a copy of -- is the one asserted against named samples.
 *
 *     bun -e "import {verifyChangeFeed} from './client/src/net/changelog.ts';
 *             console.log(verifyChangeFeed())"
 */
export function verifyChangeFeed(): string[] {
  const failures: string[] = [];

  // --- The suggestion regex, on five named samples.
  {
    const positives: [string, number][] = [
      ['(suggestion #4)', 4],
      ['closes #12', 12],
      ['resolves #5', 5],
    ];
    for (const [text, want] of positives) {
      const got = suggestMatch(text);
      if (got !== want) failures.push(`suggestMatch(${JSON.stringify(text)}) is ${got}, not ${want}.`);
    }
    const negatives: string[] = ['#4 platform', 'suggested by'];
    for (const text of negatives) {
      if (suggestMatch(text) !== null) {
        failures.push(`suggestMatch(${JSON.stringify(text)}) matched, but it should not.`);
      }
    }
  }

  // --- The collapsed line: date first, then the subject, and nothing else.
  {
    const got = collapsedLine({
      hash: 'abc1234', at: '2026-08-17', title: 'the railway is visible', detail: '', suggestion: false, issue: 0,
    });
    if (got !== '2026-08-17 · the railway is visible') {
      failures.push(`collapsedLine is "${got}", not "2026-08-17 · the railway is visible".`);
    }
  }

  // --- The filter: all, and only-suggestions.
  {
    const entries: ChangeEntry[] = [
      { hash: 'a', at: '2026-08-17', title: 'x', detail: '', suggestion: true, issue: 1 },
      { hash: 'b', at: '2026-08-17', title: 'y', detail: '', suggestion: false, issue: 0 },
      { hash: 'c', at: '2026-08-17', title: 'z', detail: '', suggestion: true, issue: 2 },
    ];
    if (filterEntries(entries, 'all').length !== 3) {
      failures.push(`the "all" filter returned ${filterEntries(entries, 'all').length}, not 3.`);
    }
    const only = filterEntries(entries, 'suggestion');
    if (only.length !== 2 || !only.every((e) => e.suggestion)) {
      failures.push(`the "suggestion" filter returned ${only.length} rows, some not a suggestion.`);
    }
  }

  // --- The pager: 30, then 30 more, then the rest, then nothing.
  {
    const entries: ChangeEntry[] = Array.from({ length: 65 }, (_, i) => ({
      hash: `h${i}`, at: '2026-08-17', title: `change ${i}`, detail: '', suggestion: false, issue: 0,
    }));
    const first = pagerNext(entries, 0);
    if (first.length !== PAGE_SIZE) {
      failures.push(`the first page returned ${first.length}, not ${PAGE_SIZE}.`);
    }
    const second = pagerNext(entries, PAGE_SIZE);
    if (second.length !== PAGE_SIZE) {
      failures.push(`the second page returned ${second.length}, not ${PAGE_SIZE}.`);
    }
    // The two pages must not overlap and must be in order.
    if (first[0]?.hash !== 'h0' || second[0]?.hash !== 'h30') {
      failures.push('the pages are not the right slice of the feed, in order.');
    }
    const rest = pagerNext(entries, 2 * PAGE_SIZE);
    if (rest.length !== 5) {
      failures.push(`the third page returned ${rest.length}, not 5 (65 - 60).`);
    }
    // Past the end it is empty, and stays empty: that is the signal to stop.
    if (pagerNext(entries, 65).length !== 0 || pagerNext(entries, 1000).length !== 0) {
      failures.push('the pager did not return an empty page past the end.');
    }
  }

  return failures;
}
