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
  waypointReached,
  type Waypoint,
} from './game/waypoint.ts';
import type { DialogNpc, Quest, QuestCursors } from './game/questmodel.ts';
import { questAim, type AimKind } from './game/questaim.ts';

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
  /** The dialog pack, for `pin`: a giver's position lives on his NPC record. */
  npcs(): readonly DialogNpc[];
  /**
   * Somewhere to point when there is no job at all, or null.
   *
   * The needle used to go out in exactly the situation a player most needs it:
   * standing in a city of sixty kilometres with nothing accepted, which is
   * where every new player and every returning one starts. `game/questtrack.ts`
   * answers "then where is the work" with the nearest hub, and this is the same
   * answer handed to the arrow so the corner and the needle agree.
   *
   * **Last, after the pin and after the live objective**, which is the whole of
   * its authority: it can never take the arrow off a job.
   */
  fallback?(): Waypoint | null;
}

/** How often the text and the distance are re-derived. The needle is every frame. */
export const WAYPOINT_RESCAN_HZ = 4;

/**
 * The waypoint, if it can actually point at something.
 *
 * A quest step is allowed to have no place attached -- "network with three
 * locals" is a real objective and there is nowhere to draw an arrow to. What it
 * must not do is take the banner off a target that *does* have a place, which
 * is what an `??` chain does the moment the locationless one comes first.
 */
export function pointable(w: Waypoint | null): Waypoint | null {
  if (w === null) return null;
  return w.x === null || w.z === null ? null : w;
}

/**
 * `pointable`, held still.
 *
 * Small, and it exists because the bug it guards was invisible in code and
 * obvious on screen: the chain read fine, and what it produced was the one
 * instrument that says which way to walk, saying a sentence with no arrow.
 */
export function verifyPointable(): string[] {
  const failures: string[] = [];
  const at = (x: number | null, z: number | null): Waypoint => ({
    questId: 'q',
    stepIndex: 0,
    text: 'do a thing',
    x,
    z,
    radius: 10,
  });
  if (pointable(null) !== null) failures.push('nothing became something.');
  if (pointable(at(null, null)) !== null) {
    failures.push('a step with no place was called pointable; it would take the banner off one that has a place.');
  }
  if (pointable(at(1, null)) !== null || pointable(at(null, 1)) !== null) {
    failures.push('a half-placed step was called pointable; the needle would aim at NaN.');
  }
  const real = at(10, 20);
  if (pointable(real) !== real) failures.push('a placed step was refused; the banner would fall through to nothing.');
  return failures;
}

export class WaypointBanner {
  private readonly root = document.getElementById('waypoint');
  private readonly needle = document.getElementById('waypoint-needle');
  private readonly text = document.getElementById('waypoint-text');
  private readonly range = document.getElementById('waypoint-range');
  private readonly source: WaypointSource;

  /** The live objective, re-derived on the beat. Null is "nothing to point at". */
  private current: Waypoint | null = null;
  /**
   * A job the player asked to be taken to, which outranks the automatic pick.
   *
   * The arrow's ordinary behaviour is "the nearest open step of a job you have
   * taken", and that is right when nobody has said otherwise. A player who
   * presses *take me there* in the register has said otherwise, and about a job
   * the automatic rule frequently cannot even see -- an untaken one has no
   * cursor and a finished one has no open step. So a pin is held here and
   * `update` prefers it.
   *
   * It is **cleared by arriving**, not by a timer and not by another rescan:
   * an arrow that gave up while you were still walking would be worse than no
   * arrow, and one that never gave up would follow you around after you got
   * there. Pinning a different job replaces it; pinning the pinned one clears
   * it, so the button is a toggle.
   */
  private pinned: string | null = null;
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
   * The live objective, for anything else that has to point at the same place.
   *
   * The **record itself** rather than a copy of its coordinates, and that is
   * the whole point of the getter existing: `main.ts` puts a marker on both
   * maps for the step the player is on, and the one way that marker and this
   * needle can be guaranteed to agree is for there to be one `activeWaypoint`
   * call in the client and one answer. Two callers of that function would agree
   * almost always -- they would drift for the quarter-second between two 4 Hz
   * beats, and on exactly the beat the cursor advances, which is the moment a
   * player is looking hardest.
   *
   * Null is "nothing to point at", and a record whose `x` is null is a step
   * with nowhere to point -- a `ko`, a `buy` -- which keeps the banner and
   * loses both the needle and the dot. See `game/waypoint.activeWaypoint`.
   */
  get objective(): Waypoint | null {
    return this.current;
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
      /*
       * **A target with nowhere to point does not get the banner while one that
       * points somewhere is available**, and that is a reversal of what this
       * used to do on purpose. `drawSlow` still says a step with no location
       * "keeps the banner and loses the needle"; the owner saw what that looks
       * like and the verdict was "not helpful, cut off too" -- a long objective
       * in 22 px uppercase, no arrow, no distance, filling the one instrument
       * on screen whose entire job is to say which way to walk.
       *
       * So the pointable ones are tried first, in the old order, and the
       * locationless ones only get a look once nothing on screen can point
       * anywhere at all. That last clause matters: an objective with no place
       * attached is still the thing the player is doing, and an empty banner
       * tells them less than a sentence does.
       */
      const pinned = this.pinnedWaypoint();
      const active = activeWaypoint(this.source.quests(), this.source.cursors(), pose.x, pose.z);
      const fallback = this.source.fallback?.() ?? null;
      this.current =
        pointable(pinned) ??
        pointable(active) ??
        pointable(fallback) ??
        pinned ??
        active ??
        fallback ??
        null;
      // Arriving is what takes the pin down. Checked here rather than in `pin`
      // for the obvious reason: the player is not standing there when they press
      // the button, and this is the beat that knows where they are now.
      if (this.pinned !== null && this.current !== null && waypointReached(this.current, pose.x, pose.z)) {
        this.pinned = null;
      }
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

  /**
   * Point at this job, or unpin it if it is already the one being pointed at.
   *
   * Returns what the arrow will now aim for, so a caller can say so; `null` is
   * "there is nowhere to point", which is a quest whose giver is not in the
   * pack -- a content fault the register still has to survive.
   */
  pin(questId: string): AimKind | null {
    if (this.pinned === questId) {
      this.pinned = null;
      this.sinceRescan = Infinity;
      return null;
    }
    const target = this.aimFor(questId);
    if (target === null) return null;
    this.pinned = questId;
    // Re-derived on the next frame rather than next beat: the button was a
    // deliberate act and a quarter-second of the old arrow reads as a miss.
    this.sinceRescan = Infinity;
    return target.kind;
  }

  /** Which job the arrow is being held on, if any. For the register's button. */
  get pinnedQuest(): string | null {
    return this.pinned;
  }

  private aimFor(questId: string): ReturnType<typeof questAim> {
    const quest = this.source.quests().find((q) => q.id === questId);
    if (quest === undefined) return null;
    return questAim(quest, this.source.npcs(), this.source.cursors()[questId]);
  }

  /** The pinned job as a `Waypoint`, or null if it went away underneath us. */
  private pinnedWaypoint(): Waypoint | null {
    if (this.pinned === null) return null;
    const target = this.aimFor(this.pinned);
    if (target === null) {
      // The job left the pack, or its giver did. Drop the pin rather than hold
      // an arrow pointing at a memory.
      this.pinned = null;
      return null;
    }
    return {
      questId: target.questId,
      stepIndex: 0,
      text: target.text,
      x: target.x,
      z: target.z,
      radius: target.radius,
    };
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
