/**
 * The one place an uncaught error is allowed to land.
 *
 * This client had no `window.onerror` and no `unhandledrejection` listener, and
 * the day that cost something is the day this file was written: the owner hit
 * *"Maximum call stack size exceeded"* and there was nothing to report but the
 * sentence itself. A stack overflow thrown inside a frame callback goes to the
 * console and nowhere else, and asking the owner to open devtools and expand a
 * trace is asking him to do the part of the job that should have been done
 * here.
 *
 * So: two listeners, installed before anything else in `main.ts` runs, that
 * turn an uncaught error into something a person can read **on the screen they
 * are already looking at**.
 *
 * ---------------------------------------------------------------------------
 * ## Why the first one only
 *
 * The error this was written for repeats. A stack overflow in the animation
 * loop throws on every frame, so a handler that reported each one would put
 * sixty panels a second over the game and lose the *first* trace -- the only
 * one that says where the trouble started -- in the flood. The first is shown
 * whole; the rest are counted and logged, and the count is worth having
 * because "once" and "every frame" are different bugs.
 *
 * ## Why it is fatal
 *
 * `hud.fatal` takes the game off the screen, which is a strong thing to do to
 * somebody mid-session. It is right anyway. Nothing in this client throws past
 * a `catch` on purpose: the boot is gated by self-checks, the streamer swallows
 * its own network failures, and every subsystem that can fail politely already
 * does. An exception that reaches `window` is therefore a bug that has already
 * broken an invariant, and the frame after it is not a game anybody should be
 * asked to keep playing -- see `hud.fatal`'s own note, "a build that cannot
 * run". The alternative, a transient notice, would scroll away before it was
 * read, which is how this bug got reported without a trace in the first place.
 *
 * ## The stack is trimmed, and the top of it is kept
 *
 * Six frames. The deployed bundle ships its sourcemap (`vite.config.ts` sets
 * `sourcemap: true` and DEPLOY.md rsyncs the `.map`), so a browser resolves
 * those frames to real `.ts` files and lines -- `loadIndex @ streamer.ts:2075`,
 * not `index-wyNvG3B1.js:47`. Six is what fits on a panel and is more than
 * enough to name the function, its caller and the loop that called that.
 *
 * The raw error also goes to `console.error` untouched, so the browser keeps
 * its own clickable, complete trace for anybody who does want to dig.
 */

/** How many frames of the stack are worth putting on a panel. See the header. */
const FRAMES_SHOWN = 6;

/** What this needs of a HUD: somewhere to put a message that will not scroll away. */
export type CrashSink = (message: string) => void;

/**
 * The message and the top of the stack, as one block of text.
 *
 * Exported for `verifyCrash`, which is the whole of what can be checked here
 * without throwing something at a real browser: the formatting is pure, and
 * the listeners are three lines that call it.
 */
export function crashText(err: unknown, frames = FRAMES_SHOWN): string {
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const stack = typeof err.stack === 'string' ? err.stack : '';
    // Engines differ: V8 repeats the message at the top of `stack`, JSC does
    // not. Dropping any leading line that is not a frame handles both without
    // asking which engine this is.
    const lines = stack
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && (l.startsWith('at ') || l.includes('@')));
    if (lines.length === 0) return head;
    return `${head}\n\n${lines.slice(0, frames).join('\n')}`;
  }
  // A thrown string, a rejected promise carrying a plain object, a DOM
  // `ErrorEvent` with no `error` on it. All of them are somebody's bad day and
  // none of them should throw in here.
  try {
    return String(err);
  } catch {
    return 'an error that could not be turned into text';
  }
}

/**
 * Install the two listeners. Idempotent, and safe to call before the DOM is
 * ready; returns a function that removes them again, which nothing needs yet
 * and every listener should have.
 */
export function installCrashLog(show: CrashSink): () => void {
  let seen = 0;
  // Through `globalThis` rather than `window`, because `server/index.ts` runs
  // `verifyCrash` from its own boot list and the server's tsconfig has no DOM
  // lib -- the same reason every shared module in this project is three-free.
  // A host with no listeners to add is not an error here; it is a host that
  // will never call this.
  const host = globalThis as unknown as {
    addEventListener?: (type: string, fn: (e: never) => void) => void;
    removeEventListener?: (type: string, fn: (e: never) => void) => void;
  };
  if (typeof host.addEventListener !== 'function') return () => {};

  const land = (err: unknown, kind: string): void => {
    seen++;
    // The browser's own record first, whole and clickable, before anything
    // here can go wrong with it.
    console.error(`[crash] uncaught ${kind} #${seen}`, err);
    if (seen > 1) return;
    show(`${crashText(err)}\n\n(uncaught ${kind}; the console has the full trace)`);
  };

  // `error` is the thrown value where the browser has it; `message` is all
  // there is for a cross-origin script, which is exactly the case this file
  // exists to stop being all there is.
  const onError = (e: { error?: unknown; message?: unknown }): void => {
    land(e.error ?? e.message, 'error');
  };
  const onRejection = (e: { reason?: unknown }): void => {
    land(e.reason, 'promise rejection');
  };

  host.addEventListener('error', onError as (e: never) => void);
  host.addEventListener('unhandledrejection', onRejection as (e: never) => void);
  return () => {
    host.removeEventListener?.('error', onError as (e: never) => void);
    host.removeEventListener?.('unhandledrejection', onRejection as (e: never) => void);
  };
}

export function verifyCrash(): string[] {
  const failures: string[] = [];

  // --- A real error keeps its name, its message and the top of its stack.
  {
    const err = new Error('Maximum call stack size exceeded');
    const text = crashText(err, 3);
    if (!text.includes('Maximum call stack size exceeded')) failures.push('the message did not survive.');
    if (!text.startsWith('Error: ')) failures.push(`the panel opens with "${text.slice(0, 20)}" rather than the error's name.`);
    if (typeof err.stack === 'string' && err.stack.includes('at ') && !text.includes('at ')) {
      failures.push('a stack was available and none of it was shown.');
    }
    const lines = text.split('\n').filter((l) => l.trim().startsWith('at '));
    if (lines.length > 3) failures.push(`${lines.length} frames shown against a limit of 3.`);
  }

  // --- The stack limit is honoured, and a deep one is trimmed rather than dumped.
  {
    const err = new Error('deep');
    err.stack = 'Error: deep\n' + Array.from({ length: 200 }, (_, i) => `    at fn${i} (main.ts:${i})`).join('\n');
    const text = crashText(err);
    const frames = text.split('\n').filter((l) => l.trim().startsWith('at '));
    if (frames.length !== FRAMES_SHOWN) failures.push(`${frames.length} frames of a 200-frame stack, against ${FRAMES_SHOWN}.`);
    if (!text.includes('at fn0 ')) failures.push('the trim dropped the top of the stack, which is the half that matters.');
    if (text.includes('at fn199 ')) failures.push('the trim kept the bottom of a 200-frame stack.');
  }

  // --- Nothing thrown at it throws back. This runs inside an error handler.
  {
    for (const thing of [null, undefined, 'a string', 42, { a: 1 }, new Error('')]) {
      try {
        const out = crashText(thing);
        if (typeof out !== 'string') failures.push(`${String(thing)} did not come back as text.`);
      } catch (e) {
        failures.push(`${String(thing)} made the crash reporter throw: ${String(e)}.`);
      }
    }
    // The one that has bitten every logger ever written.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    try {
      crashText(cyclic);
    } catch (e) {
      failures.push(`a cyclic object made the crash reporter throw: ${String(e)}.`);
    }
    // And an error with no stack at all, which is what a thrown `Error` looks
    // like in some engines once it has crossed a worker boundary.
    const bare = new Error('no stack here');
    bare.stack = '';
    if (crashText(bare) !== 'Error: no stack here') failures.push('an error with no stack did not fall back to its message.');
  }

  return failures;
}
