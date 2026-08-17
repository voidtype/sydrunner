/**
 * "Back where you left off" -- the one sentence the restore is visible as.
 *
 * The owner asked for two things in one line: *"if i sign up it should
 * automatically transfer my level and location to the new account. logging off
 * should save my location till next log in (persisted to end of week)."* Almost
 * all of that is server-side and invisible by design -- the store keeps a
 * `lastPos`, the join reads it, the body starts there. This file is the small
 * part that has to happen in a browser, and it is here rather than as ten lines
 * inside `main.ts` for the reason every module in this directory is: `main.ts`
 * is nine thousand lines of wiring and a rule buried in it is a rule nobody
 * finds.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUBURB IS THE CLIENT'S JOB
 *
 * The sentence wanted is *"back where you left off — Newtown"*, and the server
 * cannot write it. Suburb names live in the map atlas the browser downloads
 * (`client/src/mapatlas.ts`, read by `game/locator.ts`) and there is no copy on
 * the server: adding one would mean loading a few hundred kilobytes of polygon
 * centroids into a 1 GB box so that one join in a hundred can put a word in a
 * pill. So the server sends **one bit** -- `WELCOME.restored`, protocol v15 --
 * and the client, which already has the atlas open to draw the minimap readout,
 * says where that is. The sign-up response takes the other half of the same
 * decision from the other end and simply omits the suburb; see
 * `net/accounts.carriedLine`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT WAITS, AND WHY IT GIVES UP
 *
 * `Locator.loadSuburbs` is a fetch, and the welcome arrives before it finishes
 * -- reliably, because the socket is opened while the world is still streaming.
 * So this polls the locator briefly rather than reading it once, and the poll
 * has a deadline: after `SUBURB_WAIT_MS` the sentence is said **without** the
 * suburb rather than not said at all. That order was the whole decision. A
 * player who was put back in Newtown and told nothing has no way to know the
 * feature worked, and "back where you left off" on its own is completely true;
 * the suburb is decoration on a fact, and a decoration is not worth losing the
 * fact over.
 *
 * It is also **once per session**. There is exactly one welcome, and the timer
 * stops the moment the sentence is said.
 */

/** How long to wait for the suburb atlas before saying it without one. */
export const SUBURB_WAIT_MS = 4000;

/** How often to look, while waiting. Cheap: it is a field read on an object. */
export const SUBURB_POLL_MS = 250;

/**
 * The pill sentence, from the one fact that varies.
 *
 * A pure function in its own right, rather than a template literal at the call
 * site, on `net/accounts.joinPane`'s argument: it is the only part of this file
 * with a decision in it, and it is the part that can be *wrong* in a way nothing
 * reports -- an empty suburb rendered into the string is "back where you left
 * off — ", with a dangling dash, which is the sort of thing that ships because
 * it only happens when a fetch is slow.
 *
 * `hud.notice` is a small pill; the em dash and the suburb are what
 * `game/locator.ts` already composes its readout with, so this reads like the
 * rest of the interface rather than like a new voice.
 */
export function restoredLine(suburb: string): string {
  const where = suburb.trim();
  return where === '' ? 'back where you left off' : `back where you left off — ${where}`;
}

/** What the notice needs from the rest of the client. Three functions. */
export interface RestoredDeps {
  /** Did the server restore this join? `NetClient.welcome.restored`, or false. */
  restored(): boolean;
  /** The suburb under the player, or `''`. `locator.stats().suburb`. */
  suburb(): string;
  /** `hud.notice`. */
  notice(message: string): void;
  /** Injected so the check can drive the timer. Defaults to the real one. */
  setTimer?(fn: () => void, ms: number): unknown;
}

/**
 * Say it, once, as soon as there is a suburb to say -- or without one.
 *
 * Returns immediately when this join was not a restore, which is every guest and
 * every ordinary login: the common path costs one function call and one boolean.
 */
export function installRestoredNotice(deps: RestoredDeps): void {
  if (!deps.restored()) return;
  const timer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let waited = 0;
  const look = (): void => {
    const suburb = deps.suburb();
    if (suburb !== '' || waited >= SUBURB_WAIT_MS) {
      deps.notice(restoredLine(suburb));
      return;
    }
    waited += SUBURB_POLL_MS;
    timer(look, SUBURB_POLL_MS);
  };
  look();
}

// --- The self-check ------------------------------------------------------------

/**
 * The two things here that fail silently.
 *
 * A dangling em dash in a pill is invisible to every test that checks the
 * feature "worked", and a poll that never gives up is a sentence that is simply
 * never said -- which looks exactly like the restore not having happened. Both
 * are one line each and both are checked with a fake timer, so this runs in the
 * server's boot list too: the sentence is a property of the feature and not of
 * the browser that happens to draw it, which is `verifyAccounts`' own argument
 * for living in a shared file.
 */
export function verifyCarry(): string[] {
  const failures: string[] = [];

  if (restoredLine('Newtown') !== 'back where you left off — Newtown') {
    failures.push(`The restore sentence is ${JSON.stringify(restoredLine('Newtown'))}, not the composed one.`);
  }
  for (const empty of ['', '   ']) {
    const got = restoredLine(empty);
    if (got !== 'back where you left off') {
      failures.push(`A missing suburb produced ${JSON.stringify(got)}; the dash must go with the word.`);
    }
  }

  // A join that was not a restore says nothing at all.
  {
    let said = 0;
    installRestoredNotice({
      restored: () => false,
      suburb: () => 'Newtown',
      notice: () => { said++; },
      setTimer: () => 0,
    });
    if (said !== 0) failures.push('An ordinary join was told it was back where it left off.');
  }

  // A suburb that is already known is said on the first look, with no timer.
  {
    const said: string[] = [];
    let timers = 0;
    installRestoredNotice({
      restored: () => true,
      suburb: () => 'Erskineville',
      notice: (m) => said.push(m),
      setTimer: () => { timers++; return 0; },
    });
    if (said.length !== 1 || said[0] !== 'back where you left off — Erskineville') {
      failures.push(`A restore with the atlas already loaded said ${JSON.stringify(said)}.`);
    }
    if (timers !== 0) failures.push('A restore that could answer immediately still set a timer.');
  }

  // An atlas that never arrives says it anyway, once, inside the deadline.
  {
    const said: string[] = [];
    const queue: Array<() => void> = [];
    installRestoredNotice({
      restored: () => true,
      suburb: () => '',
      notice: (m) => said.push(m),
      setTimer: (fn) => { queue.push(fn); return 0; },
    });
    // Drain the fake timer, with a bound well past the deadline: a poll that
    // never gives up would spin here forever in the real client, which is the
    // failure this bound is standing in for.
    for (let i = 0; i < 200 && queue.length > 0; i++) (queue.shift() as () => void)();
    if (said.length !== 1) failures.push(`A restore with no atlas said ${said.length} sentences; it must say exactly one.`);
    else if (said[0] !== 'back where you left off') failures.push(`It said ${JSON.stringify(said[0])}.`);
    if (queue.length > 0) failures.push('The suburb poll is still running after its deadline; it never gives up.');
  }

  // And a suburb that turns up late is used.
  {
    const said: string[] = [];
    const queue: Array<() => void> = [];
    let known = '';
    installRestoredNotice({
      restored: () => true,
      suburb: () => known,
      notice: (m) => said.push(m),
      setTimer: (fn) => { queue.push(fn); return 0; },
    });
    known = 'Redfern';
    for (let i = 0; i < 200 && queue.length > 0; i++) (queue.shift() as () => void)();
    if (said.length !== 1 || said[0] !== 'back where you left off — Redfern') {
      failures.push(`A suburb that arrived after the first look was not used; said ${JSON.stringify(said)}.`);
    }
  }

  if (!(SUBURB_WAIT_MS >= SUBURB_POLL_MS && SUBURB_WAIT_MS <= 15_000)) {
    failures.push(`The suburb wait is ${SUBURB_WAIT_MS} ms, which is either shorter than a poll or long enough to be a different session.`);
  }

  return failures;
}
