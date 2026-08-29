/**
 * The tracker in the corner, spent on the DOM.
 *
 * `game/questtrack.ts` decides every word; this is six elements it did not
 * create, a pool of rows, and a string compare. The split is `client/src/
 * waypoint.ts`'s and is made for its reason: the rule has to be checkable on a
 * server with no screen, and a `document` in the module holding the rule would
 * put it out of reach of both boot lists.
 *
 * ---------------------------------------------------------------------------
 * ## One clock, and it is slow
 *
 * The waypoint has two -- a needle written every frame and text written on a
 * beat -- because a needle that lags a mouse turn reads as broken. Nothing here
 * turns. Four words, a distance and up to six rows, none of which mean anything
 * different at 120 Hz than at 4, so this is entirely on the slow clock and
 * costs a frame nothing at all.
 *
 * The guard is a **signature string** rather than a per-field compare. Six
 * fields and a variable-length list would be six compares and a loop, and the
 * one thing that must not happen in a redraw path is a partial write -- a title
 * from this beat over a step list from the last, which is what a per-field guard
 * produces the moment somebody adds a seventh field and forgets one place. One
 * string, one compare, one rebuild.
 *
 * ## The rows are pooled
 *
 * `minimap.MarkerSource`'s rule, applied to the DOM: this runs forever, and
 * `innerHTML = rows.join('')` four times a second is four parses a second and a
 * fresh set of nodes for the compositor to lay out. The pool grows to its
 * high-water mark -- six, `MAX_TRACK_STEPS` -- and stays there, and a beat that
 * changes one counter writes one `textContent`.
 *
 * Pooling also means **no HTML is built here at all**, so there is no escaping
 * question. A quest title is authored content that arrived over HTTP from a
 * GitHub pack; `client/src/dialog.ts` escapes it because it builds markup, and
 * the better answer where it is available is not to build markup.
 */

import { MAX_TRACK_STEPS, othersText, trackFrame, type TrackFrame } from './game/questtrack.ts';
import { hubRangeText, type QuestHub } from './game/questhubs.ts';
import type { ContentBundle, QuestCursors } from './game/questmodel.ts';

/**
 * The five closures this needs, all of which `main.ts` already has.
 *
 * The same objects the dialog panel, the giver marks and the waypoint are built
 * from, deliberately: a tracker that disagreed with the arrow about which job
 * you are on would be two copies of the register.
 */
export interface QuestTrackSource {
  bundle(): ContentBundle;
  cursors(): QuestCursors;
  pose(): { x: number; z: number };
  /** `game/questhubs.questHubs`, rebuilt on its own slower beat by `main.ts`. */
  hubs(): readonly QuestHub[];
  /** The job the register asked to be taken to, or `''`. */
  pinned(): string;
}

/** How often the frame is re-derived. The waypoint's beat, for its reasons. */
export const TRACK_RESCAN_HZ = 4;

export class QuestTracker {
  private readonly root = document.getElementById('questtrack');
  private readonly titleEl = document.getElementById('questtrack-title');
  private readonly rangeEl = document.getElementById('questtrack-range');
  private readonly noteEl = document.getElementById('questtrack-note');
  private readonly stepsEl = document.getElementById('questtrack-steps');
  private readonly footEl = document.getElementById('questtrack-foot');
  private readonly source: QuestTrackSource;

  /** The pooled rows. Each is a `div.row` holding a `b` and an `i`. */
  private readonly rows: Array<{ row: HTMLElement; label: HTMLElement; count: HTMLElement }> = [];

  /** What was last drawn. See the header for why one string and not six. */
  private drawn = '';
  private sinceScan = 0;
  /** The live frame, so `main.ts` can point the needle at what the corner says. */
  private frameNow: TrackFrame | null = null;

  constructor(source: QuestTrackSource) {
    this.source = source;
  }

  /** What the corner is currently about, for the needle and the console handle. */
  get frame(): TrackFrame | null {
    return this.frameNow;
  }

  tick(dt: number): void {
    this.sinceScan += dt;
    if (this.sinceScan < 1 / TRACK_RESCAN_HZ) return;
    this.sinceScan = 0;
    const frame = trackFrame(
      this.source.bundle(),
      this.source.cursors(),
      this.source.pose(),
      this.source.hubs(),
      this.source.pinned(),
    );
    this.frameNow = frame;
    this.draw(frame);
  }

  private draw(frame: TrackFrame): void {
    const root = this.root;
    if (!root || !this.titleEl || !this.rangeEl || !this.noteEl || !this.stepsEl || !this.footEl) return;
    if (frame.kind === 'idle') {
      if (this.drawn !== '') {
        this.drawn = '';
        root.classList.remove('shown');
      }
      return;
    }

    const range = frame.rangeM >= 0 ? hubRangeText(frame.rangeM) : '';
    // The hub state is the one that names a key, and only that state. A player
    // with a job on the go knows where the list is; a player with nothing to do
    // is the one who needs telling, and that is exactly when the line is free.
    const foot = frame.kind === 'hub' ? 'J — the job list' : othersText(frame.others);
    const signature =
      `${frame.kind}|${frame.title}|${range}|${frame.note}|${foot}|` +
      frame.steps.map((s) => `${s.state}${s.label}${s.counter}`).join('');
    if (signature === this.drawn) return;
    this.drawn = signature;

    this.titleEl.textContent = frame.title;
    this.rangeEl.textContent = range;
    this.noteEl.textContent = frame.note;
    this.footEl.textContent = foot;

    const shown = Math.min(frame.steps.length, MAX_TRACK_STEPS);
    while (this.rows.length < shown) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('b');
      const count = document.createElement('i');
      row.append(label, count);
      this.stepsEl.append(row);
      this.rows.push({ row, label, count });
    }
    for (let i = 0; i < this.rows.length; i++) {
      const slot = this.rows[i];
      if (i >= shown) {
        slot.row.style.display = 'none';
        continue;
      }
      const step = frame.steps[i];
      slot.row.style.display = '';
      slot.row.className = `row ${step.state}`;
      slot.label.textContent = step.label;
      slot.count.textContent = step.counter;
    }

    root.classList.add('shown');
  }
}

/**
 * The tracker's own boot check: the DOM half is present.
 *
 * Deliberately thin, and the thing it asserts is the one that has actually
 * broken before in this interface -- an element renamed in `index.html` and not
 * in the module, which fails by silently drawing nothing forever. Everything
 * with an opinion is `verifyQuestTrack`'s.
 */
export function verifyQuestTracker(): string[] {
  const failures: string[] = [];
  const ids = [
    'questtrack',
    'questtrack-title',
    'questtrack-range',
    'questtrack-note',
    'questtrack-steps',
    'questtrack-foot',
  ];
  for (const id of ids) {
    if (document.getElementById(id) === null) {
      failures.push(`#${id} is not in index.html; the quest tracker would draw nothing and say nothing about it.`);
    }
  }
  return failures;
}
