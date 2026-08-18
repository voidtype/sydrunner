/**
 * "what's new": the recent changes to the game, in the panel.
 *
 * The tab beside the suggestions box. `scripts/changelog.mjs` writes
 * `client/public/changelog.json` from `git log` before every build, and this
 * fetches it once per session and draws it. There is no server in this path at
 * all -- it is a static file beside the world tiles -- which is why the feed
 * works in `?offline`, where the suggestions tab beside it cannot.
 *
 * The feed is an infinitely scrollable column rather than three rows: the
 * generator now writes up to two hundred commits, and this draws them in pages
 * of thirty, appending the next page as the reader nears the bottom. Every row
 * is collapsed to one line -- the date and the subject -- and expands on hover
 * or keyboard focus to the full subject, the body and the hash. A filter above
 * the list shows all of them or only the ones that closed a player's
 * suggestion, which the generator marks by a regex over the subject and body
 * (and a small hand-kept map for the four that shipped before the convention).
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

import {
  NO_CHANGELOG, NEAR_BOTTOM, parseChangelog,
  collapsedLine, filterEntries, pagerNext,
  type ChangeEntry, type Changelog, type FeedFilter,
} from './net/changelog.ts';

export { verifyChangelog, verifyChangeFeed, whenText } from './net/changelog.ts';
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
  private readonly allBtn: HTMLButtonElement;
  private readonly sugBtn: HTMLButtonElement;
  private log: Changelog = NO_CHANGELOG;
  private loaded = false;
  private filter: FeedFilter = 'all';
  private filtered: ChangeEntry[] = [];
  private shown = 0;

  constructor(listEl: HTMLElement, footEl: HTMLElement) {
    this.listEl = listEl;
    this.footEl = footEl;

    // The filter bar, built here and set above the list, because the panel's
    // markup is fixed and this is the one place that knows the list's parent.
    const filterBar = document.createElement('div');
    filterBar.className = 'filter';
    this.allBtn = document.createElement('button');
    this.allBtn.type = 'button';
    this.allBtn.className = 'toggle on';
    this.allBtn.textContent = 'all';
    this.sugBtn = document.createElement('button');
    this.sugBtn.type = 'button';
    this.sugBtn.className = 'toggle';
    this.sugBtn.textContent = 'from suggestions';
    this.allBtn.addEventListener('click', () => this.setFilter('all'));
    this.sugBtn.addEventListener('click', () => this.setFilter('suggestion'));
    filterBar.appendChild(this.allBtn);
    filterBar.appendChild(this.sugBtn);
    listEl.parentElement?.insertBefore(filterBar, listEl);

    // The infinite scroll: when the reader nears the bottom, the next page is
    // appended, until the filtered entries are exhausted.
    this.listEl.addEventListener('scroll', () => this.maybeAppend());
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

  /** Switch the filter and redraw from the top, keeping the panel's colours. */
  private setFilter(f: FeedFilter): void {
    if (f === this.filter) return;
    this.filter = f;
    this.allBtn.classList.toggle('on', f === 'all');
    this.sugBtn.classList.toggle('on', f === 'suggestion');
    this.draw();
  }

  /** Append the next page when the reader is within `NEAR_BOTTOM` of the end. */
  private maybeAppend(): void {
    const nearBottom =
      this.listEl.scrollHeight - (this.listEl.scrollTop + this.listEl.clientHeight) <= NEAR_BOTTOM;
    if (nearBottom && this.shown < this.filtered.length) this.renderPage();
  }

  private renderPage(): void {
    const page = pagerNext(this.filtered, this.shown);
    for (const e of page) this.listEl.appendChild(this.row(e));
    this.shown += page.length;
    // A tall panel may not fill its scroll area after a page, so no scroll event
    // would ever fire; check again so the feed fills the panel before it stops.
    this.maybeAppend();
  }

  /**
   * One row: a collapsed line that is always shown, and an expanded block that
   * appears on hover or focus. Built the same way `SuggestionsPanel.draw`
   * builds its rows -- `textContent` and `createElement`, never `innerHTML` --
   * for the reason that file gives: this string arrived from outside the
   * program and the only thing that reliably stops it being markup is never
   * treating it as markup.
   */
  private row(e: ChangeEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'change';
    // Rows are focusable so a keyboard reader can expand them without a mouse.
    row.tabIndex = 0;

    // The collapsed line, always visible: the date and the subject, clipped to
    // the row width by CSS, with the suggestion badge after it when it is one.
    const collapsed = document.createElement('div');
    collapsed.className = 'collapsed';
    const line = document.createElement('span');
    line.className = 'line';
    line.textContent = collapsedLine(e);
    collapsed.appendChild(line);
    if (e.suggestion) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'suggestion';
      collapsed.appendChild(badge);
    }
    row.appendChild(collapsed);

    // The expanded block, hidden until hover or focus (see the CSS).
    const expanded = document.createElement('div');
    expanded.className = 'expanded';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = e.title;
    expanded.appendChild(title);
    if (e.detail) {
      const detail = document.createElement('div');
      detail.className = 'body';
      detail.textContent = e.detail;
      expanded.appendChild(detail);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    // The hash, in the `issue` tone the suggestions rows use for their number
    // and for the same reason: it is provenance rather than prose, it is the
    // string somebody types into `git show`, and it is deliberately not a
    // link -- the whole point of this panel is that nobody has to leave the
    // game to read it.
    const hash = document.createElement('span');
    hash.className = 'issue';
    hash.textContent = e.hash;
    hash.title = `git show ${e.hash}`;
    meta.appendChild(hash);
    // The one link in the panel: a suggestion's issue, opened outside the game.
    if (e.issue > 0) {
      const link = document.createElement('a');
      link.className = 'issue';
      link.href = `https://github.com/voidtype/sydrunner/issues/${e.issue}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `suggestion #${e.issue}`;
      meta.appendChild(link);
    }
    expanded.appendChild(meta);
    row.appendChild(expanded);
    return row;
  }

  draw(): void {
    this.listEl.textContent = '';
    this.filtered = filterEntries(this.log.entries, this.filter);
    this.shown = 0;
    if (this.filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      // Two different sentences for two different states: a feed that is not
      // there, and a filter that matched nothing.
      empty.textContent =
        this.log.entries.length === 0
          ? this.loaded ? 'no change feed in this build.' : 'reading the change feed…'
          : 'no suggestions yet.';
      this.listEl.appendChild(empty);
      this.footEl.textContent = '';
      return;
    }
    this.renderPage();
    this.footEl.textContent =
      `built from ${this.log.build}${this.log.dirty ? ' + uncommitted changes' : ''} · ` +
      `${this.log.entries.length} recent changes, as of this build`;
  }
}

