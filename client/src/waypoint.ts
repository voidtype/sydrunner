/**
 * The needle and the four words under it: `game/waypoint.ts`, spent on the DOM.
 *
 * Everything that decides anything is one file over and is pure -- which way,
 * how far, which job, and when to stop. This is the shell: four elements it did
 * not create, a `transform` and three `textContent` writes. The split is
 * `client/src/dialog.ts`'s and it is made for the same reason: the rule has to
 * be checkable on a server with no screen, and a `document` in the module that
 * holds the rule would put it out of reach of both boot lists.
 *
 * ---------------------------------------------------------------------------
 * TWO CLOCKS, AND THE FAST ONE IS ONE LINE
 *
 * The **needle** is written every frame, because a needle that lags a mouse
 * turn by a quarter-second is a needle that reads as broken -- `world/
 * questmarkers.ts` says the same thing about its billboard and for the same
 * reason. That costs one `style.transform` on one element, which is a compositor
 * property and does not lay anything out.
 *
 * Everything **else** -- the text, the distance, whether the thing is up at all
 * -- is written only when it changes, guarded on a string compare, because those
 * are `textContent` writes that reflow a lozenge and there is no version of
 * "1,847 m" that is worth relaying at 120 Hz. The distance is rounded to whole
 * metres by `waypointRangeText`, so the guard catches about one write a second
 * at a walk and none at all when the player is standing still.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, WHICH IS THE ONLY THING HERE THAT IS A TASTE DECISION
 *
 * Top centre, under `#clock`. The reticle is at 50%, the minimap and the locator
 * are top right, the vitals are bottom left, the controls line is bottom right
 * and `#hint` is the bottom-centre pill -- so the strip of frame above the
 * crosshair and below the clock is the one place a persistent element can live
 * without moving anything else or covering the thing the player is walking
 * toward. It is also where Skyrim and every driving game since Test Drive puts
 * a compass, which is worth something on its own: a player who has seen one
 * knows what this is without being told.
 *
 * `#heat` and `#investigation` share that band at 13% and are `display: none`
 * except when you are wanted. The overlap is real on a short viewport and it is
 * the correct thing to lose: a player being chased by the police has a more
 * urgent question than which way Redfern is.
 */

import {
  activeWaypoint,
  screenBearing,
  waypointRange,
  waypointRangeText,
  type Waypoint,
} from './game/waypoint.ts';
import type { Quest, QuestCursors } from './game/questmodel.ts';

/**
 * Everything the banner reads, supplied by `main.ts` as closures.
 *
 * `DialogSource`'s arrangement two files over and for its reason: this object
 * reaches into nothing, and the one file that knows where the player is, which
 * way they are looking and what the server last said about their cursors is the
 * one that assembles it. These are the *same* closures the dialog panel and the
 * quest markers are built from, deliberately -- an arrow pointing at a step the
 * panel disagrees about would be two copies of the register.
 */
export interface WaypointSource {
  quests(): readonly Quest[];
  cursors(): QuestCursors;
  /** Where the player is standing and which way they are looking. */
  pose(): { x: number; z: number; yaw: number };
}

/** How often the text and the distance are re-derived. The needle is every frame. */
export const WAYPOINT_RESCAN_HZ = 4;

export class WaypointBanner {
  private readonly root = document.getElementById('waypoint');
  private readonly needle = document.getElementById('waypoint-needle');
  private readonly text = document.getElementById('waypoint-text');
  private readonly range = document.getElementById('waypoint-range');
  private readonly source: WaypointSource;

  /** The live objective, re-derived on the beat. Null is "nothing to point at". */
  private current: Waypoint | null = null;
  /** What was last written, so the slow half is a string compare. */
  private drawn = '';
  private sinceRescan = Infinity;

  constructor(source: WaypointSource) {
    this.source = source;
  }

  /** Is the banner up? For the check, and for a console poke. */
  get visible(): boolean {
    return this.current !== null;
  }

  /** Which job it is pointing at, or `''`. */
  get questId(): string {
    return this.current?.questId ?? '';
  }

  /**
   * One frame.
   *
   * The decision on the beat, the needle always. `dt` is the frame delta and is
   * not clamped by anything of its own: the only thing it integrates is the
   * rescan accumulator, and a backgrounded tab coming back should re-decide
   * immediately rather than after another quarter-second.
   */
  update(dt: number): void {
    this.sinceRescan += dt;
    const pose = this.source.pose();
    if (this.sinceRescan >= 1 / WAYPOINT_RESCAN_HZ) {
      this.sinceRescan = 0;
      this.current = activeWaypoint(this.source.quests(), this.source.cursors(), pose.x, pose.z);
      this.drawSlow(pose.x, pose.z);
    }
    const target = this.current;
    if (target === null || target.x === null || target.z === null || this.needle === null) return;
    // Degrees clockwise from straight up, which is exactly what `rotate()`
    // wants: see `game/waypoint.screenBearing`, which is written to return that
    // rather than leaving the sign of this project's yaw to a caller.
    const deg = (screenBearing(pose.x, pose.z, target.x, target.z, pose.yaw) * 180) / Math.PI;
    this.needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }

  /** The text half. Guarded on a string, because it is a reflow. */
  private drawSlow(x: number, z: number): void {
    const target = this.current;
    const distance =
      target === null || target.x === null || target.z === null
        ? ''
        : waypointRangeText(waypointRange(x, z, target.x, target.z));
    // A newline between the halves rather than a space, because the banner text
    // has spaces in it: a key two different pairs could both produce is a guard
    // that occasionally does not fire. A newline cannot appear in either half --
    // `questmodel.str` collapses all whitespace to single spaces at the parse.
    const key = target === null ? '' : `${target.text}\n${distance}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.root?.classList.toggle('shown', target !== null);
    if (target === null) return;
    if (this.text) this.text.textContent = target.text;
    if (this.range) this.range.textContent = distance;
    // A step with nowhere to point keeps the banner and loses the needle. An
    // arrow that stayed pointing at the last `goto` while the player is being
    // asked to knock three people over is worse than no arrow, and the sentence
    // is still the useful half.
    if (this.needle) this.needle.style.visibility = target.x === null ? 'hidden' : 'visible';
  }
}
