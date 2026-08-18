#!/usr/bin/env node
/**
 * What changed lately, taken from git and written where the client can read it.
 *
 * Standalone and idempotent, on `scripts/stationcad.py`'s terms: it imports
 * nothing from `client/`, `server/` or `pipeline/`, it reads one thing (the git
 * log of the repo it is sitting in) and writes one thing
 * (`client/public/changelog.json`), and running it twice on an unchanged repo
 * leaves the file byte-identical and its mtime untouched -- which matters,
 * because vite reloads the page on a `public/` write and this runs before every
 * `npm run dev`.
 *
 *   export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
 *   node scripts/changelog.mjs            # write it
 *   node scripts/changelog.mjs --print    # write it and show what it wrote
 *
 * It is wired into `client/package.json` as `prebuild` and `predev`, so the feed
 * is **current as of the build** rather than as of whenever somebody last
 * remembered to run this. The deploy builds from a `git worktree` (see
 * DEPLOY.md), so git is present there; a tarball or a `git archive` export has
 * no `.git` at all, and that case is the whole reason for the next paragraph.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER FAILS A BUILD. That is a decision, not an oversight.
 *
 * Every failure path here -- no git binary, not a repository, a repository with
 * no commits, an unwritable `public/` -- prints one line and exits 0, leaving
 * whatever file was already there alone. The feature this feeds is three lines
 * of prose in a corner of a panel; a build that refused to produce a game
 * because it could not find out what changed last Tuesday would be trading
 * something that matters for something that does not. `client/src/changelog.ts`
 * is written to the same contract from the other side: a missing file, a 404
 * that returns `index.html`, or JSON of the wrong shape all draw nothing at all
 * rather than an error.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUBJECT LINE IS USED AS PROSE
 *
 * Commit subjects in this repo are written as sentences for humans -- "Roads are
 * uninterrupted: a carriageway survives the carve it sits over" -- so the
 * subject *is* the changelog entry and rewriting it would only make it worse.
 * What this script adds is the metadata around it: when it landed, the short
 * hash as provenance, and one line of the body as the detail.
 *
 * The one case the subject cannot carry is a subject that says nothing --
 * `wip`, `fix`, `more`, a bare filename. `uninformative()` names that case, and
 * when it fires the first real line of the body is promoted to the title
 * instead, because in a commit written that way the body is where the summary
 * actually is.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How many commits the feed carries. The panel used to show three; now it is an
 * infinitely scrollable column (see `client/src/changelog.ts`), so the file
 * holds the whole recent history the player can scroll through. The number is a
 * ceiling, not a promise: a repository with fewer commits yields fewer entries.
 */
const ENTRIES = 200;

/**
 * The already-shipped suggestions, by short hash.
 *
 * The feed marks a row as a suggestion when a commit's subject or body carries
 * `(suggestion #N)`, `suggestion #N`, or a `closes`/`fixes`/`resolves #N`
 * trailer -- but the first four shipped before that convention existed, so their
 * numbers are kept here by hand. **Future commits should carry `(suggestion
 * #N)` in the subject** and can be dropped from this map, because the regex
 * below then finds them on its own. The value is the issue number, which the
 * row links to on `github.com/voidtype/sydrunner`.
 */
const SHIPPED_SUGGESTIONS = {
  '82fae87': 1, // the bat swats the footy
  '388e401': 4, // SydRide, the crazy-taxi rideshare
  '45417ba': 3, // the railway
  '408b968': 5, // the screaming sun
};

/**
 * The character budgets, and the reason there are two of them.
 *
 * A title is one line in a 400 px panel and a detail is two; both are clipped
 * at a word boundary rather than mid-word, because a sentence that ends in
 * "carriagew…" reads as a bug in the panel rather than as a long commit
 * message.
 */
const TITLE_CHARS = 120;
const DETAIL_CHARS = 150;

/** Repo root, from this file's own location. `scripts/` is one below it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'client/public/changelog.json');

/**
 * Run git, or return null.
 *
 * `execFileSync` rather than `execSync`: there is no shell in this path and
 * therefore no quoting to get wrong, which matters less here than it does on
 * the server -- nothing in this script comes from a user -- but the habit is
 * the same one `server/bugs.ts` is built on and there is no reason to keep two.
 */
function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Strip what a terminal shows and a `textContent` does not.
 *
 * The panel draws these strings with `textContent`, which is what stops a
 * commit message being markup -- but it also means `**King Street**` arrives on
 * screen with its asterisks. So the light markdown a commit body uses for
 * emphasis is removed here, at the one point that knows the destination is
 * plain text. Backticks go the same way: `` `rail.py` `` is a filename, not a
 * pair of quotes.
 */
function plain(text) {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/^[\s>#*\-+]+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clip at a word boundary, with an ellipsis, or return it unchanged. */
function clip(text, max) {
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—-]+$/, '')}…`;
}

/**
 * A subject that does not say what changed.
 *
 * Deliberately narrow. The test is not "is this a good commit message" -- it is
 * "is this so short or so generic that the body is certainly better", and a
 * false positive costs a reader the subject line they could have had. One word,
 * or under twenty characters, or one of the handful of words that are only ever
 * placeholders.
 */
function uninformative(subject) {
  const s = subject.trim().toLowerCase().replace(/[.!]+$/, '');
  if (s.length < 20) return true;
  if (!s.includes(' ')) return true;
  return /^(wip|fixes?|fixup|update[sd]?|misc|cleanup|tweaks?|more|stuff|tmp|temp|checkpoint|minor|small fix(es)?|address (review|comments)|rebase|merge branch.*)$/.test(s);
}

/**
 * Trailers and the noise that is not a summary.
 *
 * `Co-Authored-By:` is on every commit in this repo (see the commit template in
 * CLAUDE.md), so a body-first rule that did not skip it would promote the
 * co-author line to the changelog on every uninformative subject.
 */
function isTrailer(line) {
  return /^(co-authored-by|signed-off-by|reviewed-by|refs?|fixes|closes|see-also|change-id)\s*:/i.test(line.trim());
}

/**
 * The first paragraph of a body, rejoined into one sentence.
 *
 * **A paragraph and not a line**, which the first cut got wrong and which
 * produced a feed that looked right and read as if it had been cut off. Commit
 * bodies in this repo are hard-wrapped at about 75 columns, so the first line
 * of one is "Three rounds, gated together: typecheck clean, 1050 checks, build
 * clean," -- a fragment ending in a comma, which is exactly what a truncation
 * bug looks like to a reader who cannot see the source. Joining the paragraph
 * and then clipping at `DETAIL_CHARS` ends the string where this file decided
 * to end it, on a word, with an ellipsis that says so.
 */
function firstBodyParagraph(body) {
  const lines = [];
  for (const raw of body.split('\n')) {
    const line = plain(raw);
    if (isTrailer(raw)) continue;
    // A line that is only a heading rule or a table divider carries nothing.
    if (/^[-=_|\s]*$/.test(line)) {
      if (lines.length > 0) break; // the paragraph ended
      continue; // leading blank lines
    }
    lines.push(line);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a commit is a shipped suggestion, and which issue it closed.
 *
 * A row is a suggestion when the subject or body carries `(suggestion #N)`,
 * `suggestion #N`, or a `closes`/`fixes`/`resolves #N` trailer -- the same
 * regex `net/changelog.ts` asserts in `verifyChangeFeed`, kept identical here so
 * the two ends cannot disagree. The four that shipped before the convention
 * exist in `SHIPPED_SUGGESTIONS` instead: their subject says nothing of the
 * number, so the regex would miss them and the map fills the gap. The issue
 * number is what the row links to; `0` means "no number was found".
 */
function detectSuggestion(subject, body, hash) {
  const m = /(suggestion|closes|fixes|resolves)\s+#(\d+)/i.exec(`${subject}\n${body}`);
  if (m) return { suggestion: true, issue: Number(m[2]) };
  // `%h` is at least seven characters; the map keys are seven, so a longer
  // abbreviation still matches its own prefix.
  const mapped = SHIPPED_SUGGESTIONS[hash] ?? SHIPPED_SUGGESTIONS[hash.slice(0, 7)];
  if (mapped !== undefined) return { suggestion: true, issue: mapped };
  return { suggestion: false, issue: 0 };
}

/**
 * The log, parsed with separators that cannot occur in a commit message.
 *
 * `%x1e` between records and `%x1f` between fields: git will emit them
 * literally and a commit body cannot contain them, because they are control
 * characters and every editor that writes a commit message strips or refuses
 * them. Splitting on newlines instead -- which the first cut did -- puts the
 * second line of every multi-paragraph body into the next record's hash field.
 */
function readLog() {
  const raw = git('log', `-n${ENTRIES}`, '--no-merges', '--format=%x1e%h%x1f%aI%x1f%s%x1f%b');
  if (raw === null) return null;
  const entries = [];
  for (const record of raw.split('\u001e')) {
    if (record.trim() === '') continue;
    const [hash, iso, subject, body = ''] = record.split('\u001f');
    if (!hash || !iso) continue;
    // `--no-merges` already drops real merges; this also drops a plain commit
    // whose subject is a merge, the one case that one does not catch.
    if (subject.trim().startsWith('Merge ')) continue;
    const subjectText = plain(subject ?? '');
    const detailText = firstBodyParagraph(body);
    // The promotion: an empty or generic subject hands the title to the body,
    // and then there is no detail left to show under it -- which is correct.
    // Showing the same sentence twice is worse than showing it once.
    const promote = subjectText === '' || (uninformative(subjectText) && detailText !== '');
    const { suggestion, issue } = detectSuggestion(subject ?? '', body, hash.trim());
    const entry = {
      hash: hash.trim(),
      at: iso.slice(0, 10),
      title: clip(promote ? detailText : subjectText, TITLE_CHARS),
      detail: promote ? '' : clip(detailText, DETAIL_CHARS),
      suggestion,
    };
    // The issue number is only meaningful when a number was found, so it is
    // omitted rather than written as a zero the reader would have to ignore.
    if (issue > 0) entry.issue = issue;
    entries.push(entry);
  }
  return entries;
}

function main() {
  const entries = readLog();
  if (entries === null) {
    console.log('[changelog] no git here — leaving client/public/changelog.json as it is');
    return;
  }
  if (entries.length === 0) {
    console.log('[changelog] a repository with no commits — nothing to write');
    return;
  }

  // The build the bundle is made of, which `client/src/bugreport.ts` attaches to
  // every report. Taken from the same command as the feed so there is exactly
  // one generator and one artifact: a bug report whose "bundle" disagreed with
  // the changelog the player was reading would be worse than not having either.
  const dirty = (git('status', '--porcelain') ?? '').trim() !== '';

  const file = {
    build: entries[0].hash,
    // Honest rather than tidy. The deploy builds from a clean worktree, so this
    // is false in production; it is true on a developer's machine with edits in
    // the tree, and a bug report that says so saves somebody an afternoon
    // comparing a stack trace against a commit that is not what ran.
    dirty,
    generated: new Date().toISOString(),
    entries,
  };

  // No byte budget: the feed is a scrollable column of up to two hundred rows,
  // not a few hundred bytes, so the file is written whole. Idempotency below is
  // what keeps it from being rewritten when nothing changed.
  const text = JSON.stringify(file);

  // `--print` shows the entries the file holds, whether or not the run below
  // rewrites it, so it runs before the idempotent early return.
  if (process.argv.includes('--print')) {
    for (const e of file.entries) {
      console.log(`  ${e.at}  ${e.hash}  ${e.title}`);
      if (e.detail) console.log(`                      ${e.detail}`);
      // The marker is written as it appears in the JSON, so a `grep` for the
      // flag over this output and over the file agree.
      if (e.suggestion) {
        console.log(
          `                      "suggestion": true${e.issue ? ` · issue #${e.issue}` : ''}`,
        );
      }
    }
  }

  // Idempotent to the byte, `generated` excepted -- which is why the comparison
  // ignores it. Rewriting the file every time would be a vite full reload every
  // time somebody starts the dev server, and a git diff on every build.
  try {
    const before = JSON.parse(readFileSync(OUT, 'utf8'));
    const same =
      before.build === file.build &&
      before.dirty === file.dirty &&
      JSON.stringify(before.entries) === JSON.stringify(file.entries);
    if (same) {
      console.log(`[changelog] unchanged at ${file.build} — ${Buffer.byteLength(text)} B`);
      return;
    }
  } catch {
    // No file, or one that will not parse. Either way it is about to be one.
  }

  try {
    mkdirSync(dirname(OUT), { recursive: true });
    // Written beside and renamed, on `SuggestionStore.save`'s argument: vite
    // watches this directory, and a reader that caught a half-written file
    // would serve a truncated JSON to a page that is already running.
    const tmp = `${OUT}.tmp-${process.pid}`;
    writeFileSync(tmp, `${text}\n`);
    renameSync(tmp, OUT);
    console.log(`[changelog] ${file.entries.length} entries at ${file.build}${dirty ? ' (dirty tree)' : ''} — ${Buffer.byteLength(text)} B`);
  } catch (err) {
    console.log(`[changelog] could not write ${OUT}: ${String(err)}`);
    return;
  }
}

main();
