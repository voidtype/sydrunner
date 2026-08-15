/**
 * "what's new": the three most recent changes to the game, in the panel.
 *
 * The tab beside the suggestions box. `scripts/changelog.mjs` writes
 * `client/public/changelog.json` from `git log` before every build, and this
 * fetches it once per session and draws it. There is no server in this path at
 * all -- it is a static file beside the world tiles -- which is why the feed
 * works in `?offline`, where the suggestions tab beside it cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE HONEST SOURCE, AND WHAT IT COSTS
 *
 * The alternative was a hand-written list in a constant, and the reason not to
 * is that a hand-written list is *wrong by default*: it is right on the day
 * somebody writes it and then silently ages, so a player reading it is told
 * about a change that shipped a fortnight ago as if it were the news. Generated
 * from git, the feed cannot be stale relative to the bundle -- it is generated
 * from the commit the bundle is built from.
 *
 * What it costs is that the entries read like commit subjects, because they are
 * commit subjects. In this repo that is a feature: the subjects are written as
 * sentences for humans. In a repo where they were `fix` and `wip` it would be
 * useless, and `scripts/changelog.mjs` handles that case by promoting the body.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE DRAWS NOTHING
 *
 * A missing file, a 404, a dev server that answers a 404 with `index.html`, a
 * JSON of the wrong shape, an entry with no hash -- all of them end in an empty
 * tab with one line saying so, and none of them throw. `parseChangelog` is the
 * one function that decides and it is total; it lives in `net/changelog.ts`
 * with its own self-check, because the server's check runs it and the server has
 * no DOM to run it in.
 */

import { NO_CHANGELOG, parseChangelog, whenText, type Changelog } from './net/changelog.ts';

export { NO_CHANGELOG, SHOWN, parseChangelog, verifyChangelog, whenText } from './net/changelog.ts';
export type { ChangeEntry, Changelog } from './net/changelog.ts';

/**
 * Fetch it once. Never throws, never rejects.
 *
 * `cache: 'no-cache'` rather than the default, and it is the one line here that
 * is about deployment: the file sits beside `index.html` on a host that is
 * configured to cache static assets hard (see `scripts/precompress-dist.sh`),
 * and a feed the player is told is current while a proxy serves last week's is
 * worse than no feed. It is 900 bytes and it is fetched once per session, so
 * revalidating it costs one conditional request.
 */
export async function loadChangelog(url = '/changelog.json'): Promise<Changelog> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return NO_CHANGELOG;
    // `res.json()` rather than `res.text()` then parse, because the throw is
    // the same and this way the JSON is parsed by the engine. The catch below
    // is what handles a host that answered the 404 with a document.
    return parseChangelog(await res.json());
  } catch {
    return NO_CHANGELOG;
  }
}

/**
 * The tab's DOM: three rows and a footer, or one line saying there is nothing.
 *
 * Built the same way `SuggestionsPanel.draw` builds its rows -- `textContent`
 * and `createElement`, never `innerHTML` -- for the reason that file gives:
 * this string arrived from outside the program and the only thing that reliably
 * stops it being markup is never treating it as markup. That a commit subject
 * is unlikely to contain a `<script>` is not the point; the point is that the
 * rule has no exceptions and so cannot be forgotten.
 */
export class ChangelogFeed {
  private readonly listEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private log: Changelog = NO_CHANGELOG;
  private loaded = false;

  constructor(listEl: HTMLElement, footEl: HTMLElement) {
    this.listEl = listEl;
    this.footEl = footEl;
  }

  /** The commit this bundle was built from, for a bug report's metadata. */
  get build(): string {
    return this.log.build;
  }

  get dirty(): boolean {
    return this.log.dirty;
  }

  /**
   * Start the fetch. Idempotent, and safe to call before the panel is ever
   * opened -- which is what `main.ts` does, so the first open is drawn rather
   * than spending a moment saying "loading".
   */
  load(url = '/changelog.json'): void {
    if (this.loaded) return;
    this.loaded = true;
    void loadChangelog(url).then((log) => {
      this.log = log;
      this.draw();
    });
    this.draw();
  }

  draw(): void {
    this.listEl.textContent = '';
    if (this.log.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      // Two different sentences would need two different states and the
      // difference is not one a player can act on either way.
      empty.textContent = this.loaded
        ? 'no change feed in this build.'
        : 'reading the change feed…';
      this.listEl.appendChild(empty);
      this.footEl.textContent = '';
      return;
    }
    for (const e of this.log.entries) {
      const row = document.createElement('div');
      row.className = 'change';

      const head = document.createElement('div');
      head.className = 'title';
      head.textContent = e.title;
      row.appendChild(head);

      if (e.detail) {
        const detail = document.createElement('div');
        detail.className = 'body';
        detail.textContent = e.detail;
        row.appendChild(detail);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const when = document.createElement('span');
      when.textContent = whenText(e.at);
      meta.appendChild(when);
      // The hash, in the `issue` tone the suggestions rows use for their number
      // and for the same reason: it is provenance rather than prose, it is the
      // string somebody types into `git show`, and it is deliberately not a
      // link -- the whole point of this panel is that nobody has to leave the
      // game to read it.
      const hash = document.createElement('span');
      hash.className = 'issue';
      hash.textContent = ` · ${e.hash}`;
      hash.title = `git show ${e.hash}`;
      meta.appendChild(hash);
      row.appendChild(meta);

      this.listEl.appendChild(row);
    }
    this.footEl.textContent =
      `built from ${this.log.build}${this.log.dirty ? ' + uncommitted changes' : ''} · ` +
      'the three most recent commits, as of this build';
  }
}

