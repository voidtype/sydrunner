/**
 * The job list panel: `game/questlog.ts` spent on the DOM.
 *
 * `client/src/suggestions.ts` is the file this one is shaped after -- a panel
 * that owns its own listeners, its own Escape discipline and its own DOM,
 * handed a small source object by `main.ts` and reaching into nothing else.
 * Everything structural is that file's and is not re-argued here.
 *
 * ---------------------------------------------------------------------------
 * ## A panel and not a phone screen, which is a departure worth defending
 *
 * DESIGN.md rule 4: *"The phone is the interface. Maps, quests, dialog, the
 * camera, the app -- meta-UI lives on the phone."* This is full-screen, so it
 * needs an argument.
 *
 * The argument is the one `phone.ts` already made twice, in its own words, about
 * the Map tile and then the Talents tile: **a shortcut, not a screen.** A 300 px
 * handset cannot draw a nine-kilometre map or a six-column talent tree, so the
 * tile puts the phone away and opens the real thing, and the Escape ordering
 * brings the phone back at its home screen afterwards -- which is what makes it
 * a step rather than a dismissal. The phone is still the way in. The register
 * has grown from a hundred and nine jobs to six hundred, grouped by where they
 * are rather than by rung, and it has joined the list of things a handset cannot
 * hold. So the QuestBuddy tile now does what the Map tile does.
 *
 * `J` is the accelerator, the way `M` is for the map.
 *
 * ## Time does not stop, and the pointer lock does
 *
 * `client/src/dialog.ts`'s two rules, and they are the house's rather than this
 * file's: cars keep driving and you can be knocked over while you read this,
 * because there is no version of a pause that works in a multiplayer game; and
 * the pointer lock is released, because the rows are clickable and a browser
 * under pointer lock has no cursor to click them with.
 *
 * ## The list is rebuilt, and the guard is a signature
 *
 * `client/src/questtracker.ts`'s arrangement and its reasons. A hundred rows
 * rebuilt four times a second is four parses a second; a hundred rows rebuilt
 * when a word in them changes is nothing. The signature covers every drawn
 * field, so there is no way to add a column and forget the guard.
 *
 * Rows are built as elements rather than as markup, so a quest title that
 * arrived over HTTP from a GitHub pack cannot carry a tag into this panel. Same
 * reasoning as the tracker: the better answer to escaping, where it is
 * available, is not to build markup.
 */

import { logRangeText, questLogRows, type LogRow } from './game/questlog.ts';
import type { QuestHub } from './game/questhubs.ts';
import type { ContentBundle, PlayerFacts, QuestCursors } from './game/questmodel.ts';
import type { LogGiver } from './game/questlog.ts';

/** The six closures this needs, all of them ones `main.ts` already has. */
export interface QuestLogSource {
  bundle(): ContentBundle;
  cursors(): QuestCursors;
  facts(): PlayerFacts;
  /** The tracker's hubs, so the two cannot disagree about where Redfern is. */
  hubs(): readonly QuestHub[];
  /** The giver list `hubs()` was clustered from. Indices must line up. */
  givers(): readonly LogGiver[];
  pose(): { x: number; z: number };
  /** Point the arrow at this job. `waypoint.pin`, passed through by `main.ts`. */
  aimAt(questId: string): void;
  /** Which job the arrow is held on, or `''`, so the row can say so. */
  pinned(): string;
}

/** How often the rows are re-derived while the panel is up. */
export const LOG_RESCAN_HZ = 3;

export class QuestLogPanel {
  private readonly root = document.getElementById('questlog');
  private readonly list = document.getElementById('questlog-list');
  private readonly foot = document.getElementById('questlog-foot');
  private readonly source: QuestLogSource;
  private open = false;
  private drawn = '';
  private sinceScan = 0;

  constructor(source: QuestLogSource) {
    this.source = source;
    // One delegated listener on the container rather than one per row: the rows
    // are replaced on every rebuild and a listener per row is a list this class
    // would have to be kept in step with. `dialog.ts` and `phone.ts` both do
    // this and for the same reason.
    this.list?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement | null)?.closest('[data-qid]') as HTMLElement | null;
      const id = row?.dataset.qid ?? '';
      if (id === '') return;
      this.source.aimAt(id);
      // Redrawn on this click rather than on the next beat, so the row can show
      // it took: a quarter-second of nothing reads as a dead button.
      this.drawn = '';
      this.draw();
    });
  }

  get visible(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  close(): void {
    this.setOpen(false);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root?.classList.toggle('shown', open);
    if (open) {
      this.drawn = '';
      this.sinceScan = 0;
      this.draw();
    }
  }

  tick(dt: number): void {
    if (!this.open) return;
    this.sinceScan += dt;
    if (this.sinceScan < 1 / LOG_RESCAN_HZ) return;
    this.sinceScan = 0;
    this.draw();
  }

  private draw(): void {
    const list = this.list;
    if (!list) return;
    const rows = questLogRows(
      this.source.bundle(),
      this.source.cursors(),
      this.source.facts(),
      this.source.hubs(),
      this.source.givers(),
      this.source.pose(),
    );
    const pinned = this.source.pinned();
    const signature = `${pinned}\n` + rows.map(rowKey).join('\n');
    if (signature === this.drawn) return;
    this.drawn = signature;

    list.replaceChildren(...rows.map((r) => this.element(r, pinned)));
    if (this.foot) {
      const jobs = rows.filter((r) => r.kind === 'job').length;
      this.foot.textContent =
        jobs === 0
          ? 'click a job to point the arrow at it — esc to close'
          : 'click a job to point the arrow at it — j or esc to close';
    }
  }

  private element(row: LogRow, pinned: string): HTMLElement {
    const el = document.createElement('div');
    if (row.kind === 'section') {
      el.className = 'r section';
      const n = document.createElement('span');
      n.textContent = row.label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = row.value;
      el.append(n, v, blank());
      return el;
    }
    if (row.kind === 'note') {
      el.className = 'note';
      el.textContent = row.label;
      return el;
    }
    el.className = `r ${row.kind}`;
    const name = document.createElement('span');
    if (row.kind === 'hub') name.className = 'n';
    name.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'v';
    value.textContent = row.value;
    const dist = document.createElement('span');
    dist.className = 'd';
    dist.textContent = logRangeText(row.rangeM);
    el.append(name, value, dist);
    if (row.kind === 'job') {
      el.dataset.qid = row.questId;
      el.classList.add(row.standing === '' ? 'available' : row.standing);
      if (row.questId === pinned) el.classList.add('aimed');
      // Reachable and pressable from the keyboard. `Enter` and `Space` both,
      // because a row that looks like a button and answers only one of them is
      // the kind of thing nobody notices until somebody cannot use a mouse.
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.source.aimAt(row.questId);
        this.drawn = '';
        this.draw();
      });
    }
    return el;
  }
}

function blank(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'd';
  return el;
}

function rowKey(r: LogRow): string {
  return `${r.kind}|${r.label}|${r.value}|${r.questId}|${Math.round(r.rangeM)}|${r.standing}`;
}

/**
 * The panel's own boot check: the DOM half is present.
 *
 * Thin on purpose. The thing that has broken before in this interface is an id
 * renamed in `index.html` and not in the module, which fails by drawing nothing
 * forever and saying nothing about it. Everything with an opinion is
 * `verifyQuestLog`'s, one file over, where a server can read it.
 */
export function verifyQuestLogPanel(): string[] {
  const failures: string[] = [];
  for (const id of ['questlog', 'questlog-list', 'questlog-foot']) {
    if (document.getElementById(id) === null) {
      failures.push(`#${id} is not in index.html; the job list would open onto nothing.`);
    }
  }
  return failures;
}
