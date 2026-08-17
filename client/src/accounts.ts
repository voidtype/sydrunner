/**
 * The browser's side of accounts: the landing panel, the token, and the gates.
 *
 * Three surfaces and one object. `JoinGate` owns `#nameprompt` -- which used to
 * be `hud.askName`'s name box and is now two tabs -- owns the session token in
 * `localStorage`, and owns the "sign up to send feedback" panels in the Escape
 * box. They are one class because they are one *state*: whether this browser is
 * logged in, and as whom. Three objects sharing that would be three copies of it
 * to keep in step, and the failure mode of getting that wrong is a client that
 * shows a sign-up button to somebody who is signed in.
 *
 * The rules -- what a handle is, what a password must be, what a level is --
 * are `net/accounts.ts`, shared with the server, and this file imports them
 * rather than restating them. That is the same arrangement `hud.askName` had
 * with `protocol.sanitiseName`: what the player sees accepted in the field is
 * what the server will accept, because it is the same function.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HANDLE IS CHECKED AS IT IS TYPED
 *
 * *"game handle is now globally unique per account and checked at landing"*.
 *
 * The check is a debounced `GET /auth/check` against the quick-play field, and
 * it exists because of what the alternative looks like. Without it, a guest who
 * types a registered handle gets all the way through the join -- the world
 * streams, 350 MB of Sydney arrives, the socket opens -- and *then* the server
 * refuses the hello with a `BYE`. Three hundred megabytes and forty seconds to
 * be told a name is taken. So the field says so while the finger is still on the
 * keyboard, and the `BYE` stays as the backstop for the stale tab and the
 * hand-built client (see `server/index.ts`'s hello handler).
 *
 * 300 ms of debounce, from the brief. Short enough that it feels like the field
 * answering and long enough that typing "Bazza" is one request rather than five.
 *
 * ---------------------------------------------------------------------------
 * WHAT SIGNING UP MID-GAME CAN AND CANNOT DO
 *
 * The token binds to a participant **on the `HELLO`** (see
 * `protocol.encodeHello`), which is the right design -- it makes the participant
 * correct on the tick it is created rather than renaming a live body -- and it
 * has one honest consequence: a player who signs up from the Escape panel is
 * signed up, their wallet has been migrated, their account exists and their
 * level will persist, but *this* session is still the guest session it started
 * as. The socket does not know.
 *
 * Rather than hide that, this file says it: `tokenAtJoin` records whether the
 * connection was made with a token, and the feedback gates read it. A player who
 * signs up mid-game is told "reload to send feedback as Bazza" instead of being
 * shown a compose box whose submissions the server will refuse. The bug reporter
 * is the exception and works immediately, because it is an HTTP route carrying
 * its own bearer header and has no socket in the path at all.
 *
 * The rejected alternative was a mid-session rebind message -- a rename, a
 * wallet swap and a roster rewrite on a live body, all to save a reload that a
 * player who has just filled in a sign-up form is entirely willing to do.
 */

import {
  MAX_NAME_CHARS,
  MIN_NAME_CHARS,
  sanitiseName,
} from './net/protocol.ts';
import {
  MIN_PASSWORD_CHARS,
  feedbackGate,
  joinPane,
  passwordRefusal,
  sanitiseHandle,
  type AccountView,
} from './net/accounts.ts';

/** How long the quick-play field waits after a keystroke before asking. */
export const CHECK_DEBOUNCE_MS = 300;

/** Where the token lives, beside `sydney.name` and `sydney.client`. */
const TOKEN_KEY = 'sydney.token';

/**
 * What this gate needs from the rest of the client.
 *
 * Deliberately three functions and not the `Hud`: this file draws its own panel
 * and the only thing it wants from the HUD is the pill, which is one method.
 * `endpoint` is a function rather than a string because it is resolved during
 * boot, and this object is constructed before that resolution finishes.
 */
export interface JoinGateDeps {
  /** The game server's HTTP origin, or `''` when there is none. */
  endpoint(): string;
  /** `hud.notice`. One sentence in the pill. */
  notice(message: string): void;
}

/** What `landing()` resolves with: everything the socket needs to open. */
export interface JoinChoice {
  /** The name to put on the hello. The handle when logged in. */
  name: string;
  /** The session token, or `''`. */
  token: string;
}

export class JoinGate {
  private readonly deps: JoinGateDeps;

  // --- The panel. Every element it owns, resolved once.
  private readonly panel = document.getElementById('nameprompt')!;
  private readonly who = document.getElementById('nameprompt-who')!;
  private readonly tabs = document.getElementById('nameprompt-tabs')!;
  private readonly quickPane = document.getElementById('nameprompt-quick')!;
  private readonly loginPane = document.getElementById('nameprompt-login')!;
  private readonly signedInPane = document.getElementById('nameprompt-signedin')!;
  private readonly playButton = document.getElementById('account-play') as HTMLButtonElement;
  private readonly nameInput = document.getElementById('nameprompt-input') as HTMLInputElement;
  private readonly joinButton = document.getElementById('nameprompt-join') as HTMLButtonElement;
  private readonly nameNote = document.getElementById('nameprompt-note')!;
  private readonly handleInput = document.getElementById('account-handle') as HTMLInputElement;
  private readonly passwordInput = document.getElementById('account-password') as HTMLInputElement;
  private readonly confirmField = document.getElementById('account-confirm-field') as HTMLElement;
  private readonly confirmInput = document.getElementById('account-confirm') as HTMLInputElement;
  private readonly submitButton = document.getElementById('account-submit') as HTMLButtonElement;
  private readonly switchButton = document.getElementById('account-switch') as HTMLButtonElement;
  private readonly accountNote = document.getElementById('account-note')!;
  /** The two "sign up to send feedback" blocks in the Escape panel. */
  private readonly gates: HTMLElement[] = ['suggestions-gate', 'bug-gate']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  /**
   * What the gate replaces: the two compose surfaces behind it.
   *
   * Hidden here rather than by `SuggestionsPanel` and `BugReportForm`, so
   * neither of those files has to learn what an account is. They still own
   * their fields, their counters and their send buttons; this owns whether the
   * whole block is on the screen, which is the same seam the gate blocks sit on
   * in `index.html`.
   *
   * The **lists stay visible** in the suggestions panel and only the compose box
   * goes -- a guest can read the week's suggestions and their scores, which is
   * how the panel advertises what signing up is for. See
   * `SuggestionHub.handle`, which gates `SUBMIT` and `VOTE` and deliberately
   * leaves `LIST` open for exactly this.
   */
  private readonly composers: HTMLElement[] = [
    'suggestions-compose',
    'bug-title',
    'bug-body',
    'bug-attach',
    'bug-row',
  ]
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);

  /** The token this browser holds, or `''`. Mirrored into `localStorage`. */
  private token = '';
  /** Who that token belongs to, once `/auth/me` has answered. */
  private account: AccountView | null = null;
  /**
   * Whether the **socket** was opened with a token.
   *
   * The difference between "signed in" and "signed in *as this participant*".
   * See the header's last section, which is the whole reason this field exists
   * rather than being derived from `token !== ''`.
   */
  private tokenAtJoin = false;
  /** 'signup' or 'login'. One set of fields, two modes; see `index.html`. */
  private mode: 'login' | 'signup' = 'login';
  /**
   * Which tab is selected. Held rather than read off the DOM because the *pane*
   * that is actually shown is a function of this **and** of whether the player
   * is logged in -- a logged-in player on the quick-play tab is shown the
   * signed-in pane, because the name box is a question they have answered. One
   * function (`applyPanes`) decides, and two callers set this.
   */
  private tab: 'quick' | 'account' = 'quick';
  /** Set while the panel is up for the landing join, as opposed to mid-game. */
  private resolveJoin: ((choice: JoinChoice) => void) | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rising counter, so a slow check that lands after a newer one is dropped. */
  private checkSeq = 0;
  private busy = false;

  constructor(deps: JoinGateDeps) {
    this.deps = deps;
    this.token = readToken();
    this.bind();
  }

  // --- What the rest of the client asks -----------------------------------------

  /** Is this browser logged in? True the moment a token exists, before `/auth/me`. */
  get signedIn(): boolean {
    return this.token !== '';
  }

  /** The handle, or `''`. Only known once `/auth/me` or a login has answered. */
  get handle(): string {
    return this.account?.handle ?? '';
  }

  /** The token, for `NetClient` and for the bug reporter's bearer header. */
  get sessionToken(): string {
    return this.token;
  }

  /**
   * Confirm the stored token with the server, and learn who it belongs to.
   *
   * Called once at boot **before** the panel goes up, so a returning player sees
   * "playing as Bazza" rather than an empty name box that is corrected a moment
   * later. A token the server does not recognise -- expired, or from a box whose
   * accounts file was moved aside -- is discarded here rather than being carried
   * into a hello that would silently join as a guest.
   *
   * Never throws and never blocks the boot: a server that does not answer leaves
   * the token in place and the player as a guest for this session, which is the
   * same thing an offline session is.
   */
  async restore(): Promise<void> {
    if (this.token === '') return;
    const base = this.deps.endpoint();
    if (base === '') return;
    try {
      const res = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${this.token}` } });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; account?: AccountView } | null;
      if (body?.ok && body.account) this.account = body.account;
      else this.forget();
    } catch {
      // Unreachable server. The token stays; see the note above.
    }
    this.paint();
  }

  /**
   * Put the panel up and resolve with what the player chose.
   *
   * `hud.askName`'s contract, widened: it is still shown the moment the world is
   * drawable and still collected eight hundred lines later when there is a
   * socket to send on, so the typing happens over a city that is streaming in.
   * What changed is that the answer is now a name *and a token*.
   *
   * A player who is already logged in **is not asked anything**: the panel goes
   * up showing who they are with a join button, because the alternative is
   * making somebody re-type a handle the browser already knows. They can still
   * log out from the corner of it.
   */
  landing(suggested: string): Promise<JoinChoice> {
    return new Promise((resolve) => {
      this.resolveJoin = resolve;
      this.nameInput.value = suggested;
      this.nameInput.placeholder = suggested;
      // The cap and the sentence under the field come from the constants rather
      // than the markup, so the one place the rule is written is `protocol.ts`.
      this.nameInput.maxLength = MAX_NAME_CHARS;
      this.setNameNote(`${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters · enter to join`, '');
      this.show();
      // Focus after the class, or the element is still `display: none` and the
      // browser refuses -- silently, leaving a panel nobody can type into
      // without clicking it first. `hud.askName` learnt this the hard way.
      this.nameInput.focus();
      this.nameInput.select();
      // And check what is already in the box, which is usually a name from last
      // session that somebody may have registered in the meantime.
      this.scheduleCheck();
    });
  }

  /**
   * Open the same panel over a running game, on the account tab.
   *
   * The brief's *"the same form component as landing, reachable from the Esc
   * panel"*, and it is the same component in the literal sense -- one set of
   * elements, one set of listeners, one mode flag. The only difference is that
   * there is no `resolveJoin`, so finishing closes the panel and returns the
   * player to the game rather than starting a session.
   *
   * `hud.typing` is true while `#nameprompt` is shown (see its getter), so
   * `main.ts`'s keydown listener stands down for the whole time this is up --
   * including Escape, which is why this class binds its own.
   */
  openSignup(): void {
    this.mode = this.signedIn ? 'login' : 'signup';
    this.showTab('account');
    this.applyMode();
    this.show();
    this.handleInput.focus();
  }

  /** Is the panel currently up? For `main.ts`'s pointer-lock decision. */
  get open(): boolean {
    return this.panel.classList.contains('shown');
  }

  /**
   * Called once, when the socket is built, with the token that went on the
   * hello. See `tokenAtJoin`.
   */
  markJoined(token: string): void {
    this.tokenAtJoin = token !== '';
    this.paint();
  }

  // --- The panel ------------------------------------------------------------------

  private bind(): void {
    for (const button of this.tabs.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => this.showTab(button.dataset.join === 'account' ? 'account' : 'quick'));
    }
    // Every key in these fields is stopped as well as defaulted, for
    // `hud.askName`'s reason verbatim: `main.ts` binds bare letters and `Tab` on
    // `window`, and `Tab` in particular would otherwise open the leaderboard
    // behind this panel while moving the focus off the field.
    const onKey = (e: KeyboardEvent, submit: () => void): void => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    };
    this.nameInput.addEventListener('keydown', (e) => onKey(e, () => this.quickPlay()));
    this.nameInput.addEventListener('input', () => this.scheduleCheck());
    this.joinButton.addEventListener('click', () => this.quickPlay());
    this.playButton.addEventListener('click', () => {
      if (this.resolveJoin === null) this.hide();
      else this.finishJoin({ name: this.handle, token: this.token });
    });
    for (const field of [this.handleInput, this.passwordInput, this.confirmInput]) {
      field.addEventListener('keydown', (e) => onKey(e, () => void this.submitAccount()));
    }
    this.submitButton.addEventListener('click', () => void this.submitAccount());
    this.switchButton.addEventListener('click', () => {
      this.mode = this.mode === 'login' ? 'signup' : 'login';
      this.applyMode();
    });
    // The gates in the Escape panel. Delegated off the buttons themselves rather
    // than the panels, so `client/src/suggestions.ts` and `bugreport.ts` do not
    // have to know this feature exists -- they own their compose boxes and this
    // owns the block that hides them.
    for (const gate of this.gates) {
      for (const button of gate.querySelectorAll<HTMLButtonElement>('button[data-signup]')) {
        button.addEventListener('click', () => {
          // Two jobs, decided by the state the gate is describing. A guest is
          // shown the sign-up form; somebody who signed up *after* joining is
          // shown a reload, because that is the actual remaining step -- see
          // the header's last section. One button rather than two because
          // exactly one of them is ever the right thing to press.
          if (feedbackGate(this.signedIn, this.tokenAtJoin) === 'reload') location.reload();
          else this.openSignup();
        });
      }
    }
    this.paint();
  }

  private show(): void {
    this.panel.classList.add('shown');
    this.paint();
  }

  private hide(): void {
    this.panel.classList.remove('shown');
  }

  /**
   * Escape, or the panel being dismissed mid-game.
   *
   * **Refuses to close during the landing join.** There is no game behind it
   * yet: the socket has not been opened and nothing downstream of `landing()`
   * can proceed without an answer, so a dismissable panel would be a boot that
   * stops. Mid-game there is a game to go back to, and Escape goes back to it.
   */
  private cancel(): void {
    if (this.resolveJoin !== null) return;
    this.hide();
  }

  private showTab(which: 'quick' | 'account'): void {
    this.tab = which;
    this.applyPanes();
    if (which === 'account') this.applyMode();
    else if (!this.signedIn) this.nameInput.focus();
  }

  /**
   * Which of the three panes is on, and which tab is lit.
   *
   * The one place that decision is made, from the two inputs it depends on.
   * Split out of `showTab` because `paint` has to make it too -- logging out
   * from the corner of the panel changes which pane is right without touching
   * the tab -- and two copies of a three-way rule is one copy that drifts.
   */
  private applyPanes(): void {
    // The decision itself is `net/accounts.joinPane`, which is a pure function
    // in the shared module so `verifyAccounts` can drive it. What is left here
    // is three `classList` calls, which is the part a check cannot assert.
    const pane = joinPane(this.signedIn, this.tab);
    this.signedInPane.classList.toggle('on', pane === 'signedin');
    this.quickPane.classList.toggle('on', pane === 'quick');
    this.loginPane.classList.toggle('on', pane === 'account');
    for (const button of this.tabs.querySelectorAll<HTMLButtonElement>('button')) {
      button.classList.toggle('on', (button.dataset.join === 'account') === (pane === 'account'));
    }
  }

  private applyMode(): void {
    const signup = this.mode === 'signup';
    this.confirmField.hidden = !signup;
    this.submitButton.textContent = signup ? 'sign up' : 'log in';
    this.switchButton.textContent = signup ? 'log in instead' : 'sign up instead';
    this.passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    this.setAccountNote(
      signup
        ? `handles are unique · ${MIN_PASSWORD_CHARS}+ characters · there is no password reset`
        : 'handles are unique · there is no password reset',
      '',
    );
  }

  /** "playing as Bazza · log out", and the state of the two feedback gates. */
  private paint(): void {
    this.who.textContent = '';
    if (this.signedIn) {
      const label = document.createElement('span');
      // `textContent`, never `innerHTML`: the handle came off the wire. It is
      // the server's own sanitised string and so is safe by construction, and
      // this is what keeps that true if the shape of the answer ever changes.
      label.textContent = `playing as ${this.handle || 'your account'} \u00b7`;
      const out = document.createElement('button');
      out.type = 'button';
      out.textContent = 'log out';
      out.addEventListener('click', () => void this.logout());
      this.who.append(label, out);
      this.playButton.textContent = this.handle ? `play as ${this.handle}` : 'play';
    }
    this.applyPanes();
    // The feedback gates. Shown for a guest, and shown with a different sentence
    // for somebody who signed up after joining -- see the header's last section.
    // Which of the three states the gate is in, decided by the shared pure
    // function so the rule is checkable. See `net/accounts.feedbackGate`.
    const gateState = feedbackGate(this.signedIn, this.tokenAtJoin);
    const needed = gateState !== 'none';
    for (const el of this.composers) el.hidden = needed;
    for (const gate of this.gates) {
      gate.classList.toggle('shown', needed);
      if (!needed) continue;
      const line = gate.firstChild;
      if (line && line.nodeType === Node.TEXT_NODE) {
        line.nodeValue =
          gateState === 'reload'
            ? ` reload to send feedback as ${this.handle || 'your account'} — this session joined as a guest. `
            : ' sign up to send feedback — this needs an account. ';
      }
      const button = gate.querySelector('button');
      if (button) button.textContent = gateState === 'reload' ? 'reload' : 'sign up';
    }
  }

  // --- Quick play -------------------------------------------------------------------

  /**
   * Ask the server whether what is in the name box is free, 300 ms after the
   * last keystroke.
   *
   * `checkSeq` is what makes this correct rather than merely debounced: two
   * checks can be in flight when somebody types fast on a slow link, and the
   * older one landing second would paint a stale answer over a newer one. The
   * counter means a reply that is not the latest is dropped.
   */
  private scheduleCheck(): void {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.runCheck();
    }, CHECK_DEBOUNCE_MS);
  }

  private async runCheck(): Promise<void> {
    const base = this.deps.endpoint();
    const typed = sanitiseName(this.nameInput.value);
    if (base === '' || typed === '') {
      this.setNameNote(`${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters · enter to join`, '');
      return;
    }
    const seq = ++this.checkSeq;
    try {
      const res = await fetch(`${base}/auth/check?handle=${encodeURIComponent(typed)}`);
      const body = (await res.json().catch(() => null)) as { available?: boolean; reason?: string } | null;
      if (seq !== this.checkSeq) return;
      if (body?.available) this.setNameNote('that name is free · enter to join', 'ok');
      else this.setNameNote(body?.reason || 'that name cannot be used', 'bad');
    } catch {
      // A check that cannot reach the server says nothing rather than guessing.
      // The join itself is the authority and will refuse with a `BYE` if it has
      // to; a red field on a network blip would be a wrong answer stated firmly.
      if (seq === this.checkSeq) this.setNameNote(`${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters · enter to join`, '');
    }
  }

  /**
   * Join as a guest with whatever is in the box.
   *
   * The check above is **advice and not a gate**: this does not wait for it and
   * does not refuse on a red note. The server has the last word (it refuses a
   * registered handle with a `BYE`), and a client that blocked on its own
   * advisory check would be a client that cannot join when `/auth/check` is
   * unreachable. A name that does not survive the sanitiser falls back to the
   * suggestion, which is `hud.askName`'s rule and the reason it existed: a modal
   * that argues with you about punctuation is a modal nobody finishes.
   */
  private quickPlay(): void {
    const resolve = this.resolveJoin;
    if (!resolve) {
      // Quick play from the mid-game panel is just "close this".
      this.hide();
      return;
    }
    const typed = sanitiseName(this.nameInput.value) || sanitiseName(this.nameInput.placeholder);
    this.finishJoin({ name: typed, token: '' });
  }

  // --- The account tab ----------------------------------------------------------------

  private async submitAccount(): Promise<void> {
    if (this.busy) return;
    const base = this.deps.endpoint();
    if (base === '') {
      this.setAccountNote('no server — accounts live on one. try again online.', 'bad');
      return;
    }
    const handle = sanitiseHandle(this.handleInput.value);
    if (handle === '') {
      this.setAccountNote(`a handle of ${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters, please`, 'bad');
      this.handleInput.focus();
      return;
    }
    const password = this.passwordInput.value;
    if (this.mode === 'signup') {
      // Both checks run in the browser as well as on the server, for
      // `sanitiseName`'s reason: what the player sees refused here is what the
      // server would refuse, because it is the same function -- and a round trip
      // to be told a password is too short is a round trip nobody needed.
      const refusal = passwordRefusal(password);
      if (refusal !== '') {
        this.setAccountNote(refusal, 'bad');
        this.passwordInput.focus();
        return;
      }
      if (this.confirmInput.value !== password) {
        this.setAccountNote('those two passwords are not the same', 'bad');
        this.confirmInput.focus();
        return;
      }
    }

    this.busy = true;
    this.submitButton.disabled = true;
    this.setAccountNote(this.mode === 'signup' ? 'signing up…' : 'logging in…', '');
    try {
      const res = await fetch(`${base}/auth/${this.mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle,
          password,
          // What this browser has been playing as, so the server can move the
          // guest wallet onto the new account -- the whole of "would you like to
          // save progress?". Only sent on sign-up; a login has an account
          // already and its balance is not a guest's to claim.
          guestName: this.mode === 'signup' ? readName() : '',
        }),
      });
      // Every message here is a literal in `server/accounts.ts`, including the
      // failures, which is what makes showing it verbatim safe.
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; token?: string; account?: AccountView }
        | null;
      const message = typeof body?.message === 'string' ? body.message : 'the server did not explain itself.';
      if (!body?.ok || !body.token) {
        this.setAccountNote(message, 'bad');
        return;
      }
      this.remember(body.token, body.account ?? null);
      // The password fields are cleared the moment they are no longer needed,
      // rather than left holding a plaintext password in the DOM for the rest of
      // the session. It is a small thing and it costs two lines.
      this.passwordInput.value = '';
      this.confirmInput.value = '';
      this.setAccountNote(message, 'ok');
      if (this.resolveJoin !== null) {
        this.finishJoin({ name: body.account?.handle ?? handle, token: body.token });
        return;
      }
      // Mid-game. The account exists and the wallet has moved; the *session* is
      // still a guest session until the socket is rebuilt. See the header.
      this.deps.notice(`${message} · reload to play as ${body.account?.handle ?? handle}`);
      this.paint();
      this.hide();
    } catch {
      this.setAccountNote('could not reach the server. try again.', 'bad');
    } finally {
      this.busy = false;
      this.submitButton.disabled = false;
    }
  }

  private async logout(): Promise<void> {
    const base = this.deps.endpoint();
    const token = this.token;
    this.forget();
    this.paint();
    this.showTab('quick');
    if (base === '' || token === '') return;
    try {
      // Told to the server as well as forgotten here, so the token stops working
      // rather than merely stopping being sent -- a bearer credential that is
      // dropped by the client and left live on the server is a credential still
      // sitting in whatever it was copied into.
      await fetch(`${base}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    } catch {
      // Logged out locally regardless. The token expires on its own in 30 days.
    }
  }

  // --- Plumbing --------------------------------------------------------------------

  private finishJoin(choice: JoinChoice): void {
    const resolve = this.resolveJoin;
    if (!resolve) return;
    this.resolveJoin = null;
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    this.hide();
    resolve(choice);
  }

  private remember(token: string, account: AccountView | null): void {
    this.token = token;
    this.account = account;
    writeToken(token);
  }

  private forget(): void {
    this.token = '';
    this.account = null;
    writeToken('');
  }

  private setNameNote(text: string, kind: '' | 'ok' | 'bad'): void {
    this.nameNote.textContent = text;
    this.nameNote.className = kind;
  }

  private setAccountNote(text: string, kind: '' | 'ok' | 'bad'): void {
    this.accountNote.textContent = text;
    this.accountNote.className = kind;
  }
}

/**
 * `localStorage`, wrapped, for `main.ts`'s `firstVisit` reason verbatim: it
 * **throws** rather than degrading in a browser with site data disabled or in a
 * private window with a strict policy, and an exception here would take the boot
 * down over a preference.
 */
function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeToken(token: string): void {
  try {
    if (token === '') localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A session-only login. Everything works; it does not survive a reload.
  }
}

/** The guest name this browser last played as. `main.ts` owns writing it. */
function readName(): string {
  try {
    return sanitiseName(localStorage.getItem('sydney.name') ?? '');
  } catch {
    return '';
  }
}
