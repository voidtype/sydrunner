/**
 * What to do when the GPU goes away.
 *
 * "when i tabbed back, the game crashed" is the whole of the report, and the
 * reason it reads as a crash rather than as an error is that nothing in this
 * client was listening. WebGPU hands you a `device.lost` promise and then stops
 * accepting work; three keeps calling into a dead backend, every submission
 * rejects, and the player sees a still frame with a HUD clock that has stopped.
 * No message, no console they will ever open, nothing to press.
 *
 * A lost device cannot be recovered in place. Every texture, buffer, pipeline
 * and bind group belonged to it, three holds them all, and there is no supported
 * way to re-adopt a scene onto a new device. The honest response is to say what
 * happened, say that nothing was lost, and get the player back in with one
 * gesture -- so this file is a decision, some copy, and a reload.
 *
 * ## The decisions, and why they are worth separating out
 *
 * There are three inputs and they interact in ways worth checking rather than
 * reasoning about at three in the morning:
 *
 * - **Did we cause it?** `device.lost` also resolves with `'destroyed'` when
 *   something calls `device.destroy()`, and a page being navigated away from
 *   does exactly that. Showing "the graphics device was lost" over a page that
 *   is already unloading is a scare with no cause, so a deliberate teardown is
 *   recorded first and suppresses everything.
 * - **Is anyone looking?** The overwhelmingly common case is a tab that was in
 *   the background, which means the loss is discovered while nobody can see the
 *   message and an immediate reload happens to an empty room -- and then a
 *   *second* load sits burning a slot on a machine whose owner is elsewhere. So
 *   a hidden tab arms the reload and waits for the player to come back.
 * - **Why did it go?** `'unknown'` is the browser or the driver reclaiming the
 *   device, which is what a backgrounded tab full of pipelines gets, and it is
 *   worth reloading from. A `'destroyed'` we did not ask for is the tab having
 *   been discarded, and is the same answer.
 *
 * ## Its relationship to `world/pipereclaim.ts`
 *
 * That file is the cure and this one is the dressing. The device was being lost
 * because a session accumulated every pipeline it had ever built -- 8,183 of
 * them after a five-minute drive -- and a browser under memory pressure takes
 * the device back from the tab that is holding the most. Reclaiming evicted
 * tiles' pipelines should make this file's overlay a thing players do not see.
 * It ships in the same batch precisely so that if the reclaim is wrong, the way
 * anybody finds out is a clear message and a working reload rather than a frozen
 * frame.
 *
 * Nothing here touches three, the DOM or `window`: it is the decision and the
 * words, and `main.ts` supplies the rest. That is what puts it on both boot
 * lists.
 */

/** What the caller should do about a lost device. */
export interface LostPlan {
  /** Tell the player at all? False only when we destroyed the device ourselves. */
  readonly show: boolean;
  /** Reload the page. */
  readonly reload: boolean;
  /** Reload only once the tab is visible again, rather than now. */
  readonly whenVisible: boolean;
  /** The heading, and the body under it. */
  readonly title: string;
  readonly detail: string;
  /** What the button says. */
  readonly action: string;
}

/**
 * The message, which is three sentences and every one of them is doing a job.
 *
 * It names what happened in words a player can act on rather than in the word
 * WebGPU uses; it gives the cause, because "you had the tab in the background"
 * turns an alarming event into an ordinary one; and it says the account is
 * safe, because the first thing anybody wonders when a game stops is whether
 * they lost the last hour. All three were absent from the previous behaviour,
 * which was to show nothing at all.
 */
const TITLE = 'The graphics card handed this tab back.';
const DETAIL =
  'Browsers do this to a tab that has been in the background a while, or when another ' +
  'program wants the GPU. Nothing is lost -- your level, your cash and your jobs are on ' +
  'the server, not in this page.';
const ACTION = 'Reload and rejoin';

/**
 * Decide, from the reason the device gave and what we know about the page.
 *
 * `deliberate` is the flag `main.ts` sets when the page is being unloaded or is
 * otherwise tearing itself down on purpose; `visible` is `!document.hidden` at
 * the moment the loss is discovered.
 */
export function lostPlan(reason: string, deliberate: boolean, visible: boolean): LostPlan {
  if (deliberate) {
    return { show: false, reload: false, whenVisible: false, title: '', detail: '', action: '' };
  }
  return {
    show: true,
    reload: true,
    whenVisible: !visible,
    title: TITLE,
    detail: reason === 'destroyed' ? DETAIL + ' (This tab was discarded.)' : DETAIL,
    action: ACTION,
  };
}

/** The overlay text, as one string, the way `Hud.fatal` takes it. */
export function lostMessage(plan: LostPlan): string {
  return `${plan.title}\n\n${plan.detail}`;
}

/** Self-check. On both boot lists. */
export function verifyDeviceLost(): string[] {
  const failures: string[] = [];

  // --- A device we destroyed on the way out says nothing.
  //
  // Every navigation away from the page ends in `device.destroy()`, and an
  // error banner painted over a page that is already leaving is a scare with no
  // cause. This is the single most likely way to get this file wrong.
  {
    for (const reason of ['destroyed', 'unknown', '']) {
      const p = lostPlan(reason, true, true);
      if (p.show) failures.push(`a deliberate teardown (reason "${reason}") showed an error to the player.`);
      if (p.reload) failures.push(`a deliberate teardown (reason "${reason}") reloaded a page that was already leaving.`);
    }
  }

  // --- A loss nobody is looking at waits for them.
  {
    const hidden = lostPlan('unknown', false, false);
    if (!hidden.show) failures.push('a loss in a hidden tab was not going to be shown at all.');
    if (!hidden.reload) failures.push('a loss in a hidden tab was not going to reload.');
    if (!hidden.whenVisible) {
      failures.push('a loss in a hidden tab would reload immediately, into a room nobody is watching.');
    }
    const seen = lostPlan('unknown', false, true);
    if (seen.whenVisible) failures.push('a loss the player is watching would wait for a visibility change that has already happened.');
    if (!seen.reload) failures.push('a loss the player is watching offered no way back.');
  }

  // --- Both reasons are recoverable, and both say so.
  {
    for (const reason of ['unknown', 'destroyed']) {
      const p = lostPlan(reason, false, true);
      if (!p.reload) failures.push(`reason "${reason}" was treated as unrecoverable; the player would be stuck.`);
      if (p.action.length === 0) failures.push(`reason "${reason}" offered a button with no label.`);
      if (p.title.length === 0 || p.detail.length === 0) failures.push(`reason "${reason}" produced empty copy.`);
    }
    // A discarded tab is worth naming, because it is the one the player can do
    // something about next time.
    const discarded = lostPlan('destroyed', false, true);
    const reclaimed = lostPlan('unknown', false, true);
    if (discarded.detail === reclaimed.detail) {
      failures.push('a discarded tab and a reclaimed device read identically; the one cause a player can act on is not named.');
    }
  }

  // --- The copy answers the question everybody asks first.
  {
    const m = lostMessage(lostPlan('unknown', false, true));
    if (!m.includes('\n\n')) failures.push('the overlay message has no break between the heading and the body.');
    if (!/level|cash|server/i.test(m)) {
      failures.push('the message never says the player\'s progress is safe, which is the first thing anybody wonders.');
    }
    if (/WebGPU|GPUDevice|adapter/i.test(m)) {
      failures.push('the message uses the API\'s words rather than the player\'s.');
    }
  }

  return failures;
}
