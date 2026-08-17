/**
 * The bug box: the tab where a player says what broke, with a picture of it.
 *
 * The third tab of the panel `client/src/suggestions.ts` owns, sharing its
 * shell, its Escape discipline and its one exception to the `pointer-events:
 * none` rule. What is here is the part that is not the suggestions box: a frame
 * grabbed out of the render loop, a file picker, a thumbnail, and one POST to
 * `/bug` on the game server -- which is the only route in this client that sends
 * anything over HTTP rather than over the socket.
 *
 * ---------------------------------------------------------------------------
 * THE CAPTURE, WHICH IS THE WHOLE FEATURE
 *
 * A week of this project's defects were only ever legible as a picture. So the
 * button that matters is "attach what I'm looking at", and the way it has to
 * work is not obvious:
 *
 * **`canvas.toDataURL()` on a WebGPU canvas returns a blank image unless it is
 * read in the same frame as a render.** The drawing buffer is presented and
 * released; by the time a click handler runs, the browser has nothing to give
 * back and hands over a transparent or black rectangle. It does not throw, it
 * does not warn, and the result is a valid PNG of nothing -- which is the exact
 * failure this feature must not have, because a bug report with a black
 * rectangle attached is worse than one with nothing attached: it looks like the
 * game rendered black.
 *
 * So the button does not read the canvas. It **queues a request**, and
 * `main.ts` calls `FrameGrabber.afterRender()` immediately after
 * `renderer.render(scene, camera)` -- inside the same frame, with the buffer
 * still there -- and that is where the pixels are taken. The player waits one
 * frame, which is sixteen milliseconds.
 *
 * And then it is **checked**. `looksBlank` samples the captured frame and the
 * panel refuses to attach a uniform one, saying so. That check is the only
 * thing standing between this feature and its silent failure mode, which is why
 * it is a pure function with its own negative control in `verifyBugReport`.
 *
 * ---------------------------------------------------------------------------
 * THE METADATA IS COLLECTED, NOT ASKED FOR
 *
 * A bug report with a position is worth ten without one, and no player will
 * ever type "world x -2492.5, z 4281.6" into a box. `main.ts` supplies a
 * callback that reads what it already knows -- the position, the street and
 * suburb the minimap is showing, the in-game clock, whether they are on a
 * train, the frame time, the build, the protocol version -- and it rides along
 * in a `<details>` block the server writes shut. The player's own words stay at
 * the top of the issue, which is `server/bugs.issueBody`'s decision and the
 * reason the block is collapsed rather than merely last.
 *
 * Nothing here is asked for and nothing is a surprise: the panel shows the
 * collected fields under a disclosure of its own, so somebody who wants to know
 * what they are about to send can read it before they send it.
 */

import { CAPTURE_MAX_EDGE, PROBE_EDGE, looksBlank } from './net/bugreport.ts';
import { MAX_BODY_CHARS, MAX_TITLE_CHARS, MIN_TITLE_CHARS, sanitiseBody, sanitiseTitle } from './net/suggestions.ts';

export { CAPTURE_MAX_EDGE, PROBE_EDGE, looksBlank, verifyBugReport } from './net/bugreport.ts';

/**
 * The frame grabber: a request queue drained inside the render loop.
 *
 * Holds no DOM of its own beyond two scratch canvases and knows nothing about
 * the panel -- `main.ts` owns it and calls `afterRender`, so the one line that
 * has to be in the right place is one line in the render loop rather than a
 * reach from a UI file into the renderer.
 */
export class FrameGrabber {
  private readonly canvas: HTMLCanvasElement;
  /** Where the capture is scaled into. Also what is encoded. */
  private readonly scratch = document.createElement('canvas');
  /** A `PROBE_EDGE`-square render of the same frame, for `looksBlank`. */
  private readonly probe = document.createElement('canvas');
  private waiting: Array<(shot: Capture) => void> = [];
  /** Frames grabbed this session, and how many came back blank. For the log. */
  grabbed = 0;
  blanks = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.probe.width = PROBE_EDGE;
    this.probe.height = PROBE_EDGE;
  }

  /**
   * Ask for the next presented frame.
   *
   * Resolves with a capture on the next `afterRender`, or with a failure after
   * `timeoutMs` -- because the render loop is not guaranteed to run. A tab in
   * the background gets no `requestAnimationFrame` at all, and a loop that has
   * thrown its way to a stop (see `renderGuard` in `main.ts`) never calls this
   * again. Both are states a player can be in while looking at a panel, and
   * both would otherwise be a button that hangs.
   */
  request(timeoutMs = 1500): Promise<Capture> {
    return new Promise<Capture>((resolve) => {
      let settled = false;
      const done = (shot: Capture): void => {
        if (settled) return;
        settled = true;
        this.waiting = this.waiting.filter((w) => w !== done);
        resolve(shot);
      };
      this.waiting.push(done);
      setTimeout(() => done({ ok: false, dataUrl: '', width: 0, height: 0, why: 'no frame arrived' }), timeoutMs);
    });
  }

  /**
   * Called from the render loop, immediately after `renderer.render`.
   *
   * Costs nothing when nobody is waiting, which is every frame but one or two
   * in a session: a length check on an array. When somebody *is* waiting it
   * costs one `drawImage` of the canvas into a smaller canvas, one 24x24
   * `getImageData`, and one PNG encode -- a few tens of milliseconds, once, on
   * a frame the player has already stopped playing.
   */
  afterRender(): void {
    if (this.waiting.length === 0) return;
    const waiting = this.waiting;
    this.waiting = [];
    let shot: Capture;
    try {
      shot = this.grab();
    } catch (err) {
      shot = { ok: false, dataUrl: '', width: 0, height: 0, why: `could not read the canvas (${String(err).slice(0, 80)})` };
    }
    for (const resolve of waiting) resolve(shot);
  }

  private grab(): Capture {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w < 2 || h < 2) return { ok: false, dataUrl: '', width: 0, height: 0, why: 'the canvas has no size yet' };
    const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(w, h));
    this.scratch.width = Math.max(1, Math.round(w * scale));
    this.scratch.height = Math.max(1, Math.round(h * scale));
    const ctx = this.scratch.getContext('2d');
    const probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    if (!ctx || !probeCtx) {
      return { ok: false, dataUrl: '', width: 0, height: 0, why: 'this browser gave no 2D context' };
    }
    // **This is the line that has to happen inside the frame.** Drawing the
    // WebGPU canvas into a 2D one copies the presented buffer; a moment later
    // there is nothing to copy. Everything after this point is working on a
    // copy and can take as long as it likes.
    ctx.drawImage(this.canvas, 0, 0, this.scratch.width, this.scratch.height);
    probeCtx.drawImage(this.canvas, 0, 0, PROBE_EDGE, PROBE_EDGE);
    this.grabbed++;

    const probe = probeCtx.getImageData(0, 0, PROBE_EDGE, PROBE_EDGE).data;
    if (looksBlank(probe)) {
      this.blanks++;
      // Refused rather than attached, and said out loud. A black rectangle in a
      // bug report is a claim that the game rendered black, and somebody will
      // spend an afternoon on it.
      return {
        ok: false,
        dataUrl: '',
        width: this.scratch.width,
        height: this.scratch.height,
        why: 'the capture came back blank — try again, or attach a file',
      };
    }
    return {
      ok: true,
      dataUrl: this.scratch.toDataURL('image/png'),
      width: this.scratch.width,
      height: this.scratch.height,
      why: '',
    };
  }
}

export interface Capture {
  ok: boolean;
  /** A `data:image/png;base64,...`, or ''. */
  dataUrl: string;
  width: number;
  height: number;
  /** Why not, when not. Shown to the player verbatim. */
  why: string;
}

/**
 * What the game knows about where the player is, supplied by `main.ts`.
 *
 * A callback rather than a set of fields this file reads, because every one of
 * these lives somewhere different -- the locator, the sky, the streamer, the
 * combat state -- and a UI file that reached into all of them would be a UI file
 * that has to be updated whenever any of them moves. `main.ts` is already the
 * one place that knows all of it.
 */
export type MetaSource = () => Record<string, string | number | boolean>;

export interface BugReportHandlers {
  /** The HTTP origin of the game server, or '' offline. */
  endpoint(): string;
  clientId(): string;
  /**
   * This browser's session token, or `''` for a guest. Workstream G.
   *
   * A **callback rather than a value**, exactly as `endpoint` and `clientId`
   * are, and for the same reason: this form is constructed once at boot and a
   * player can log in from the Escape panel afterwards, so a token captured at
   * construction would be a form that stayed logged out for the session. Asked
   * for at the moment a report is sent, which is when it matters.
   */
  token(): string;
  meta: MetaSource;
  /** Ask the render loop for the next frame. */
  capture(): Promise<Capture>;
}

/**
 * Everything about this browser that a bug report should carry.
 *
 * The GPU string is the reason this is asynchronous. `navigator.gpu.requestAdapter()`
 * is a promise, and its `info` is the single most useful field in a report about
 * a renderer -- "it is black on my machine" and "it is black on every Intel
 * integrated GPU" are different bugs and the difference is one string. It is
 * fetched once at construction and whatever has arrived by the time somebody
 * files a report is what goes; an empty string is a fine answer and much better
 * than a form that waits.
 */
async function describeGpu(): Promise<string> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu) {
      const adapter = (await gpu.requestAdapter()) as { info?: Record<string, string> } | null;
      const info = adapter?.info;
      if (info) {
        const parts = [info.vendor, info.architecture, info.device, info.description].filter((s) => s);
        if (parts.length > 0) return parts.join(' · ');
      }
      if (adapter) return 'webgpu adapter (no info exposed)';
    }
  } catch {
    // An adapter request can reject on a machine with no usable GPU, which is
    // itself a thing worth knowing and is covered by the fallback below.
  }
  // WebGL's unmasked strings, which most browsers still expose and which name
  // the same hardware. A last resort, and never a reason to fail.
  try {
    const gl = document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext | null;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    if (gl && ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    // Nothing further to try.
  }
  return '';
}

/**
 * The form.
 *
 * Owns its own DOM subtree inside the shared panel and nothing outside it. The
 * panel asks it whether it is `typing` and tells it when the panel opens; every
 * other decision -- what is attached, whether the button is live, what the
 * status line says -- is this file's.
 */
export class BugReportForm {
  private readonly titleEl = document.getElementById('bug-title') as HTMLInputElement;
  private readonly bodyEl = document.getElementById('bug-body') as HTMLTextAreaElement;
  private readonly countEl = document.getElementById('bug-count') as HTMLElement;
  private readonly shotEl = document.getElementById('bug-shot') as HTMLButtonElement;
  private readonly pickEl = document.getElementById('bug-pick') as HTMLButtonElement;
  private readonly fileEl = document.getElementById('bug-file') as HTMLInputElement;
  private readonly thumbEl = document.getElementById('bug-thumb') as HTMLElement;
  private readonly sendEl = document.getElementById('bug-send') as HTMLButtonElement;
  private readonly statusEl = document.getElementById('bug-status') as HTMLElement;
  private readonly metaEl = document.getElementById('bug-meta') as HTMLElement;

  private readonly handlers: BugReportHandlers;
  /** The attached image as a data URL, or ''. The only copy. */
  private attached = '';
  private attachedNote = '';
  private gpu = '';
  private sending = false;

  constructor(handlers: BugReportHandlers) {
    this.handlers = handlers;
    this.titleEl.maxLength = MAX_TITLE_CHARS;
    this.bodyEl.maxLength = MAX_BODY_CHARS;
    void describeGpu().then((s) => {
      this.gpu = s;
    });

    // The keyboard discipline the panel established, restated here because it is
    // per-element: `main.ts` binds bare letters on `window` -- H, F, L, M, T, V,
    // E -- and every one of them is a character somebody types into a sentence
    // about a bug. Stopped as well as defaulted, so the keystroke never reaches
    // the game even before `hud.typing` is consulted. A text field that let W
    // walk the player would be a bug filed from inside the bug box.
    const onCompose = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.onEscape();
        return;
      }
      const send = (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 'Enter' && e.target === this.titleEl);
      if (send) {
        e.preventDefault();
        void this.submit();
      }
      queueMicrotask(() => this.updateCounts());
    };
    this.titleEl.addEventListener('keydown', onCompose);
    this.bodyEl.addEventListener('keydown', onCompose);
    this.titleEl.addEventListener('input', () => this.updateCounts());
    this.bodyEl.addEventListener('input', () => this.updateCounts());

    this.shotEl.addEventListener('click', () => void this.grabFrame());
    this.pickEl.addEventListener('click', () => this.fileEl.click());
    this.fileEl.addEventListener('change', () => void this.takeFile());
    this.sendEl.addEventListener('click', () => void this.submit());
  }

  /** Set by the panel, so Escape in a field closes the whole thing. */
  onEscape: () => void = () => {};

  /** Is a field here holding the keyboard? Folded into the panel's `typing`. */
  get typing(): boolean {
    return document.activeElement === this.titleEl || document.activeElement === this.bodyEl;
  }

  /**
   * Let the keyboard go.
   *
   * Called by the panel on close, and it is not tidiness: leaving the focus in
   * an input inside a `display: none` subtree leaves `document.activeElement`
   * pointing at it in some browsers, so `typing` stays true with the panel shut
   * -- which is every game key dead for the rest of the session.
   * `SuggestionsPanel.close` makes the same call for the same reason.
   */
  blur(): void {
    this.titleEl.blur();
    this.bodyEl.blur();
  }

  /** The tab became visible. Refresh what the metadata block is showing. */
  show(): void {
    this.drawMeta();
    this.updateCounts();
  }

  /**
   * Grab the frame behind the panel.
   *
   * The panel stays open while this happens and that is on purpose: what the
   * player is looking at *includes* the panel, and hiding the interface to take
   * the picture would produce a screenshot of a different thing from the one
   * they pressed the button about. The overlay is small and in a corner.
   */
  private async grabFrame(): Promise<void> {
    this.shotEl.disabled = true;
    this.say('grabbing the next frame…', '');
    const shot = await this.handlers.capture();
    this.shotEl.disabled = false;
    if (!shot.ok) {
      // The failure is named rather than swallowed. A blank capture is the one
      // this feature exists to be honest about.
      this.say(shot.why, 'bad');
      return;
    }
    this.attach(shot.dataUrl, `${shot.width}x${shot.height} · from the game`);
    this.say('attached — that is the frame you were looking at.', 'ok');
  }

  /**
   * Take a file the player chose.
   *
   * Read as a data URL and **checked here for shape and size** even though the
   * server checks both again: a two-hundred-megabyte file rejected in the
   * browser costs nothing, and rejected after a five-minute upload costs the
   * report. The server's check is the one that is load-bearing -- this one is a
   * courtesy, and `server/bugs.ts` is written as if this file did not exist.
   */
  private async takeFile(): Promise<void> {
    const file = this.fileEl.files?.[0];
    // Cleared immediately so choosing the same file twice fires `change` again,
    // which it otherwise would not -- and "I picked it and nothing happened" is
    // the second most common way a file input feels broken.
    this.fileEl.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      this.say('PNG or JPEG only — the server will not take anything else.', 'bad');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      this.say(`that file is ${(file.size / 1048576).toFixed(1)} MB — the limit is 4.`, 'bad');
      return;
    }
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('unreadable'));
        reader.readAsDataURL(file);
      });
      if (!/^data:image\/(png|jpeg);base64,/.test(url)) {
        this.say('that file did not read as a PNG or a JPEG.', 'bad');
        return;
      }
      this.attach(url, `${(file.size / 1024).toFixed(0)} kB · ${file.name.slice(0, 40)}`);
      this.say('attached.', 'ok');
    } catch {
      this.say('that file would not read.', 'bad');
    }
  }

  /** Show the thumbnail, with the button that takes it away again. */
  private attach(dataUrl: string, note: string): void {
    this.attached = dataUrl;
    this.attachedNote = note;
    this.drawThumb();
  }

  private drawThumb(): void {
    this.thumbEl.textContent = '';
    if (this.attached === '') {
      this.thumbEl.classList.remove('has');
      return;
    }
    this.thumbEl.classList.add('has');
    const img = document.createElement('img');
    img.src = this.attached;
    img.alt = 'the image attached to this report';
    this.thumbEl.appendChild(img);

    const side = document.createElement('div');
    side.className = 'side';
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = this.attachedNote;
    side.appendChild(note);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'remove';
    remove.addEventListener('click', () => {
      this.attached = '';
      this.attachedNote = '';
      this.drawThumb();
      this.say('', '');
    });
    side.appendChild(remove);
    this.thumbEl.appendChild(side);
  }

  /**
   * Everything that will be attached, listed where the player can read it.
   *
   * Shown rather than merely sent. It is collected without being asked for,
   * which is the right call -- nobody types their world coordinates -- and the
   * honest counterpart of that is that it is visible before the button is
   * pressed rather than discovered in the issue afterwards.
   */
  private drawMeta(): void {
    const fields = this.collectMeta();
    this.metaEl.textContent = '';
    for (const [key, value] of fields) {
      const row = document.createElement('div');
      row.className = 'metarow';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = String(value);
      row.appendChild(k);
      row.appendChild(v);
      this.metaEl.appendChild(row);
    }
  }

  /**
   * The metadata, composed here from what `main.ts` knows and what the browser
   * knows.
   *
   * The browser's half is this file's because it is the same on every machine
   * regardless of what the game is doing; the game's half arrives through the
   * callback. Nothing here can throw: a handler that fails produces a report
   * with less in it, never a button that does nothing.
   */
  private collectMeta(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    try {
      for (const [key, value] of Object.entries(this.handlers.meta())) {
        const text = String(value).trim();
        // An empty field is dropped rather than shown as a blank row, and that
        // is the rule `main.ts` leans on: the locator has no street when the
        // player is in the middle of a park, and a row reading "street:"
        // followed by nothing is worse than no row -- it reads as a bug in the
        // collector. `server/bugs.sanitiseMeta` drops the same thing at the
        // other end, so the issue body and this list agree.
        if (text === '') continue;
        out.push([key, text]);
      }
    } catch {
      out.push(['game state', 'unavailable']);
    }
    // The user agent whole rather than parsed: every attempt to parse one is
    // wrong within a year, and the person reading the issue can read it.
    out.push(['browser', navigator.userAgent.slice(0, 200)]);
    if (this.gpu) out.push(['gpu', this.gpu]);
    out.push(['screen', `${window.innerWidth}x${window.innerHeight} @ ${window.devicePixelRatio}x`]);
    return out;
  }

  private updateCounts(): void {
    const t = [...this.titleEl.value].length;
    const b = [...this.bodyEl.value].length;
    this.countEl.textContent = `${t}/${MAX_TITLE_CHARS} title · ${b}/${MAX_BODY_CHARS} detail`;
    this.countEl.className = t > MAX_TITLE_CHARS || b > MAX_BODY_CHARS ? 'bad' : '';
  }

  private say(message: string, tone: '' | 'ok' | 'bad'): void {
    this.statusEl.textContent = message;
    this.statusEl.className = tone;
  }

  /**
   * Send it.
   *
   * The compose box is emptied **only on success**, on `SuggestionsPanel.ack`'s
   * argument exactly: somebody who has just been told the server is unreachable
   * should not also have lost the paragraph they wrote about what broke.
   */
  private async submit(): Promise<void> {
    if (this.sending) return;
    const title = sanitiseTitle(this.titleEl.value);
    if (title === '') {
      this.say(`a title, please — at least ${MIN_TITLE_CHARS} characters`, 'bad');
      this.titleEl.focus();
      return;
    }
    const base = this.handlers.endpoint();
    if (base === '') {
      this.say('no server — bug reports need one. try again online.', 'bad');
      return;
    }
    this.sending = true;
    this.sendEl.disabled = true;
    this.say('sending…', '');
    const payload = {
      clientId: this.handlers.clientId(),
      title,
      body: sanitiseBody(this.bodyEl.value),
      image: this.attached,
      meta: Object.fromEntries(this.collectMeta()),
    };
    try {
      // The bearer header, when there is one. `server/bugs.handleBugRequest`
      // refuses a report with no account (workstream G's feedback gate), and
      // the panel puts a sign-up button in front of the send button so this
      // ought to be unreachable -- but the header is what makes the request
      // *correct*, and the gate has to hold against a client that is out of
      // step with itself rather than only against the one that is not.
      const token = this.handlers.token();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== '') headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}/bug`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      // The server's message is a literal in `server/bugs.ts` in every case,
      // including the failures, which is what makes showing it verbatim safe.
      const answer = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; issue?: number } | null;
      const message = typeof answer?.message === 'string' ? answer.message : 'the server did not explain itself.';
      if (answer?.ok) {
        this.say(message, 'ok');
        this.titleEl.value = '';
        this.bodyEl.value = '';
        this.attached = '';
        this.attachedNote = '';
        this.drawThumb();
        this.updateCounts();
      } else {
        this.say(message, 'bad');
      }
    } catch {
      // A network failure, a server that is not there, a CORS refusal. One
      // sentence, and the text stays in the box.
      this.say('could not reach the server. your words are still here — try again.', 'bad');
    } finally {
      this.sending = false;
      this.sendEl.disabled = false;
    }
  }
}

