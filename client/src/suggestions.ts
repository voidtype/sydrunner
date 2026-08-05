/**
 * The suggestions panel: the bottom-right box you get by pressing Escape.
 *
 * The rules it draws are `net/suggestions.ts`'s and the ledger behind it is
 * `server/suggestions.ts`'s. This file is the interface and nothing else -- it
 * owns no counts, decides no quota and never disables a button on its own
 * arithmetic. Everything it shows arrived in a `SUGGEST_LIST`, which is the same
 * discipline `hud.leaderboard` follows: a panel that computed its own totals is
 * a panel that eventually disagrees with the server about them, and the player
 * believes the one on the screen.
 *
 * ---------------------------------------------------------------------------
 * ESCAPE, WHICH IS THE ONLY CONTENTIOUS PART OF THIS FEATURE
 *
 * The user asked for Escape, and Escape was already taken twice over. What it
 * does now, in `main.ts`'s one keydown handler, is exactly:
 *
 *     something open  ->  close it. Unchanged: this key has always meant
 *                         "get me out of this", and it still never puts up
 *                         anything while anything is up.
 *     nothing open    ->  open the suggestions panel.
 *
 * So the existing behaviour is a strict prefix of the new behaviour, and the one
 * new thing only happens in the state where the key previously did nothing at
 * all.
 *
 * **The pointer-lock double press is real and is not a bug to be fixed here.**
 * While the pointer is locked the browser eats the first Escape to release it
 * and the page never sees the event -- so from inside a game, Escape gives you
 * the cursor back and the second Escape opens the box. That is the same
 * two-press shape the control list has always had (see `main.ts`), it is
 * unavoidable from script, and it happens to be the right sequence anyway: this
 * panel needs the cursor, so the press that frees it is not a wasted one. The
 * `#help` block in `index.html` says "esc · suggestions" so the first press is
 * not a mystery.
 *
 * ---------------------------------------------------------------------------
 * THE ONE ELEMENT IN THIS INTERFACE THAT TAKES A CLICK, ALMOST
 *
 * Every other overlay in `index.html` is `pointer-events: none`, and the comment
 * on the leaderboard says why: *a panel that swallowed a click would swallow the
 * one that recaptures the pointer lock*. This panel has to take clicks -- there
 * are buttons in it -- so it takes them **only while it is shown**, and it is
 * `display: none` otherwise rather than transparent. A hidden panel is not in
 * the hit test at all, so the click that re-locks the pointer goes to the canvas
 * exactly as it did before this file existed.
 *
 * ---------------------------------------------------------------------------
 * WHO YOU ARE
 *
 * A UUID in `localStorage` under `sydney.client`, minted on first use beside the
 * `sydney.name` that is already there. It is **a claim and not proof** -- see
 * `net/suggestions.ts`'s header, which is honest about exactly how far it goes
 * -- and it is deliberately not shown anywhere in this panel: there is nothing a
 * player can do with it, and a string on screen that looks like an account
 * number invites somebody to treat it as one.
 */

import {
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  MIN_TITLE_CHARS,
  SUGGEST_RESULT,
  sanitiseBody,
  sanitiseTitle,
  type SuggestionList,
} from './net/suggestions.ts';

/**
 * This browser's vote identity, minted once and kept.
 *
 * Wrapped, because `localStorage` **throws** rather than degrades in a browser
 * with storage disabled and in a sandboxed iframe -- which is `main.ts`'s
 * `firstVisit` note, made again. A client that cannot store one gets a fresh id
 * per session, which means its votes count once and then it is a new person
 * next time. That is a strictly better failure than a panel that will not open.
 */
export function clientId(): string {
  try {
    const found = localStorage.getItem('sydney.client');
    if (found && /^[0-9a-f-]{36}$/.test(found)) return found;
    const made = crypto.randomUUID();
    localStorage.setItem('sydney.client', made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * The three requests, each answering **whether it was actually sent**.
 *
 * The boolean is not decoration and it is the one thing the first cut of this
 * file got wrong. `NetClient` refuses all three while the socket is not online,
 * and "not online" is a state a player reaches without doing anything: the
 * server drops a socket that has been silent for thirty seconds (see
 * `server/index.ts`'s `STALE_MS`), which is exactly what a tab left open in the
 * background becomes. So the panel is reachable in a state where every click is
 * a no-op -- and a click that silently does nothing is a control a player
 * decides is broken, which is the failure the whole rest of this file is written
 * against.
 *
 * With the boolean the panel can say *"lost the server"* instead, which is true,
 * actionable, and takes one line at each call site.
 */
export interface SuggestionsHandlers {
  /** Ask the server for the list. Called on open and after anything changes. */
  onRefresh(): boolean;
  onSubmit(title: string, body: string): boolean;
  onVote(localId: number, dir: number): boolean;
}

/** What the panel says when the socket has gone away under it. */
const LOST = 'lost the server — reload to reconnect';

export class SuggestionsPanel {
  private readonly root = document.getElementById('suggestions')!;
  private readonly listEl = document.getElementById('suggestions-list')!;
  private readonly noteEl = document.getElementById('suggestions-note')!;
  private readonly titleEl = document.getElementById('suggestions-title') as HTMLInputElement;
  private readonly bodyEl = document.getElementById('suggestions-body') as HTMLTextAreaElement;
  private readonly countEl = document.getElementById('suggestions-count')!;
  private readonly sendEl = document.getElementById('suggestions-send') as HTMLButtonElement;
  private readonly statusEl = document.getElementById('suggestions-status')!;
  private readonly footEl = document.getElementById('suggestions-foot')!;

  private readonly handlers: SuggestionsHandlers;
  /** Null offline. The panel still opens; see `open`. */
  private open_ = false;
  private list: SuggestionList | null = null;
  /** False on the `?offline` path, where there is no server to ask. */
  private connected = true;
  /** What was last drawn, so a refresh that changed nothing is a string compare. */
  private drawnKey = '';
  /** Which rows are expanded to show their body. Kept across refreshes. */
  private readonly expanded = new Set<number>();

  constructor(handlers: SuggestionsHandlers) {
    this.handlers = handlers;
    this.titleEl.maxLength = MAX_TITLE_CHARS;
    this.bodyEl.maxLength = MAX_BODY_CHARS;

    const onCompose = (e: KeyboardEvent): void => {
      // Stopped as well as defaulted, on `hud.askName`'s exact argument:
      // `main.ts` binds bare letters on `window` -- H, F, L, M, T, V, E -- and
      // every one of them is a character somebody may want in a sentence about
      // the game. The `hud.typing` claim below is the guard that does not depend
      // on where the focus went; this one is the guard that keeps the keystroke
      // out of the game even before that is consulted.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
      // Ctrl/Cmd-Enter submits, and a bare Enter in the title does too -- the
      // title is one line, so Enter there has no other meaning. A bare Enter in
      // the body is a newline, because the body is a few lines.
      const send = (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 'Enter' && e.target === this.titleEl);
      if (send) {
        e.preventDefault();
        this.submit();
      }
      // Deferred, because the value has not changed yet at keydown time.
      queueMicrotask(() => this.updateCounts());
    };
    this.titleEl.addEventListener('keydown', onCompose);
    this.bodyEl.addEventListener('keydown', onCompose);
    this.titleEl.addEventListener('input', () => this.updateCounts());
    this.bodyEl.addEventListener('input', () => this.updateCounts());
    this.sendEl.addEventListener('click', () => this.submit());
    // A click anywhere in the panel must not reach the window listeners that
    // swing the bat and re-lock the pointer. `main.ts` guards those on `locked`,
    // which is already false while this is open, and this is the second guard --
    // it is what makes the panel safe if that one ever changes.
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Is a field in this panel holding the keyboard? Registered with `hud`. */
  get typing(): boolean {
    return this.open_ && (document.activeElement === this.titleEl || document.activeElement === this.bodyEl);
  }

  get visible(): boolean {
    return this.open_;
  }

  /**
   * Open it, release the pointer, and ask for a fresh list.
   *
   * The pointer lock is exited explicitly rather than left to the player,
   * because the panel is reachable from a state where it is still held: `main.ts`
   * closes the other panels on the same keypress, and a player who pressed
   * Escape with the map up has a free cursor already, while one who opened this
   * from a *keyboard* shortcut path might not. A panel with buttons and a
   * captured pointer is a panel whose buttons cannot be clicked.
   */
  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.root.classList.add('shown');
    // The compact control block lives in this exact corner and would be behind
    // the panel. Hidden through a class on `body` rather than through
    // `#help.hidden`, which `hud.setHelp` owns -- two writers on one class is
    // one of them putting the block back while the other still needs it gone.
    document.body.classList.add('suggesting');
    if (document.pointerLockElement) document.exitPointerLock();
    this.draw();
    // A refresh that could not be sent means the socket died since the last
    // time the panel was open, which the player has no other way of learning:
    // the list they are looking at is whatever arrived before it went.
    if (this.connected && !this.handlers.onRefresh()) {
      this.statusEl.textContent = LOST;
      this.statusEl.className = 'bad';
    }
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('shown');
    document.body.classList.remove('suggesting');
    // Blurred explicitly. Leaving the focus in a `display: none` textarea leaves
    // `document.activeElement` pointing at it in some browsers, and `typing`
    // would then stay true with the panel shut -- which is every game key dead
    // for the rest of the session.
    this.titleEl.blur();
    this.bodyEl.blur();
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /**
   * There is no server. `?offline`, or a connection that never settled.
   *
   * The panel still opens and says so, rather than not opening: a control that
   * silently does nothing is a control a player decides is broken, which is the
   * argument `main.ts`'s `setCameraPreference` makes about the ride nudge.
   */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (this.open_) this.draw();
  }

  /** A `SUGGEST_LIST` arrived. */
  show(list: SuggestionList): void {
    this.list = list;
    if (this.open_) this.draw();
  }

  /**
   * A `SUGGEST_ACK` arrived: say what happened, in the server's own words.
   *
   * The compose box is emptied on success and on a queue, and **kept** on every
   * failure -- somebody who has just been told they are out of votes for the
   * week should not also have lost the paragraph they wrote.
   */
  ack(result: number, issue: number, message: string): void {
    const ok = result === SUGGEST_RESULT.OK || result === SUGGEST_RESULT.QUEUED;
    this.statusEl.textContent = message;
    this.statusEl.className = ok ? 'ok' : 'bad';
    if (ok && (issue > 0 || result === SUGGEST_RESULT.QUEUED) && this.titleEl.value !== '') {
      // Only the compose box, and only when this ack was about a submission --
      // a vote's ack is an `OK` too and must not empty a half-written suggestion
      // underneath it. The title being non-empty is what distinguishes them:
      // votes are cast from the list with the compose box untouched.
      this.titleEl.value = '';
      this.bodyEl.value = '';
      this.updateCounts();
    }
    this.sendEl.disabled = false;
  }

  private submit(): void {
    const title = sanitiseTitle(this.titleEl.value);
    if (title === '') {
      this.statusEl.textContent = `a title, please — at least ${MIN_TITLE_CHARS} characters`;
      this.statusEl.className = 'bad';
      this.titleEl.focus();
      return;
    }
    if (!this.connected) {
      this.statusEl.textContent = 'no server — suggestions need one. try again online.';
      this.statusEl.className = 'bad';
      return;
    }
    // Disabled until the ack, so a double click is not two issues. Re-enabled in
    // `ack`, and by the refresh that follows any change, so a lost ack cannot
    // leave the button dead.
    this.sendEl.disabled = true;
    this.statusEl.textContent = 'sending…';
    this.statusEl.className = '';
    if (!this.handlers.onSubmit(title, sanitiseBody(this.bodyEl.value))) {
      // Nothing went out, so no ack is coming to re-enable the button or clear
      // the "sending…". The compose box keeps its text, which is the point:
      // whatever they wrote is still there when they reload.
      this.sendEl.disabled = false;
      this.statusEl.textContent = LOST;
      this.statusEl.className = 'bad';
    }
  }

  private updateCounts(): void {
    const t = [...this.titleEl.value].length;
    const b = [...this.bodyEl.value].length;
    this.countEl.textContent = `${t}/${MAX_TITLE_CHARS} title · ${b}/${MAX_BODY_CHARS} detail`;
    this.countEl.className = t > MAX_TITLE_CHARS || b > MAX_BODY_CHARS ? 'bad' : '';
  }

  /**
   * Draw the whole panel.
   *
   * Rebuilt wholesale when anything changed rather than diffed, on
   * `hud.leaderboard`'s own argument one panel over: the common case is that
   * nothing changed, which is a string compare, and the uncommon case is at most
   * forty rows in a panel the player is reading rather than playing through.
   */
  private draw(): void {
    if (!this.connected) {
      this.noteEl.textContent = 'offline — suggestions live on the server. join a game to file or vote on one.';
      this.listEl.textContent = '';
      this.footEl.textContent = '';
      this.drawnKey = 'offline';
      return;
    }
    if (!this.list) {
      this.noteEl.textContent = 'asking the server…';
      this.drawnKey = 'loading';
      return;
    }
    const list = this.list;
    const key =
      `${list.votesLeft}|${list.submitsLeft}|${list.week}|${list.linked}|` +
      list.items.map((s) => `${s.localId}:${s.score}:${s.myVote}:${s.issue}:${s.title}`).join('|') +
      `|${[...this.expanded].join(',')}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;

    this.noteEl.textContent =
      list.votesLeft > 0
        ? `${list.votesLeft} of 4 votes left this week`
        : 'no votes left this week — they come back on Monday';
    this.noteEl.className = list.votesLeft > 0 ? '' : 'spent';

    this.listEl.textContent = '';
    if (list.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'nothing suggested yet. be the first.';
      this.listEl.appendChild(empty);
    }
    for (const s of list.items) {
      const row = document.createElement('div');
      row.className = 'row';

      const votes = document.createElement('div');
      votes.className = 'votes';
      // Why a button is off, said on the button rather than in a footnote: a
      // disabled control with no explanation is the single most common way an
      // interface makes somebody think it is broken.
      const why =
        s.myVote !== 0
          ? 'you voted on this one this week — again on Monday'
          : list.votesLeft <= 0
            ? 'no votes left this week'
            : '';
      for (const dir of [1, -1]) {
        const b = document.createElement('button');
        b.textContent = dir > 0 ? '▲' : '▼';
        b.className = (s.myVote === dir ? 'cast ' : '') + (dir > 0 ? 'up' : 'down');
        b.disabled = why !== '';
        b.title = why || (dir > 0 ? 'vote this up' : 'vote this down');
        b.addEventListener('click', () => {
          if (this.handlers.onVote(s.localId, dir)) return;
          this.statusEl.textContent = LOST;
          this.statusEl.className = 'bad';
        });
        votes.appendChild(b);
      }
      const score = document.createElement('div');
      score.className = 'score' + (s.score > 0 ? ' pos' : s.score < 0 ? ' neg' : '');
      score.textContent = s.score > 0 ? `+${s.score}` : String(s.score);
      votes.insertBefore(score, votes.childNodes[1]);
      row.appendChild(votes);

      const main = document.createElement('div');
      main.className = 'main';
      const title = document.createElement('div');
      title.className = 'title';
      // `textContent`, never `innerHTML`. This string came off the wire from
      // another player; the sanitiser stripped what would let it lie about its
      // own width, and this is what stops it being markup.
      title.textContent = s.title;
      title.addEventListener('click', () => {
        if (this.expanded.has(s.localId)) this.expanded.delete(s.localId);
        else this.expanded.add(s.localId);
        this.draw();
      });
      main.appendChild(title);
      if (this.expanded.has(s.localId) && s.body) {
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = s.body;
        main.appendChild(body);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      // The issue number, and deliberately **not a link**. The whole
      // requirement is that nobody has to leave the game; a hyperlink in the
      // middle of it is an invitation to. It is here so that somebody looking at
      // the repo and somebody looking at this panel can talk about the same
      // thing.
      const num = document.createElement('span');
      num.className = 'issue';
      num.textContent = s.pending ? 'queued' : `#${s.issue}`;
      if (s.pending) num.title = 'accepted and votable; posts to GitHub when the server is linked';
      meta.appendChild(num);
      const by = document.createElement('span');
      by.textContent = ` ${s.ups}▲ ${s.downs}▼ · ${s.author || 'someone'}`;
      meta.appendChild(by);
      main.appendChild(meta);
      row.appendChild(main);
      this.listEl.appendChild(row);
    }

    this.sendEl.disabled = false;
    this.titleEl.disabled = list.submitsLeft <= 0;
    this.bodyEl.disabled = list.submitsLeft <= 0;
    this.sendEl.textContent = list.submitsLeft > 0 ? 'suggest' : 'none left';

    const days = Math.max(0, Math.round(list.resetsInMs / 86400000));
    const hours = Math.max(0, Math.round(list.resetsInMs / 3600000));
    const when = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
    this.footEl.textContent =
      `${list.week} · resets in ${when} · ${list.submitsLeft} suggestion${list.submitsLeft === 1 ? '' : 's'} left` +
      // Said in the panel rather than only in a README, because it changes what
      // "queued" on a row means and the player is looking at one.
      (list.linked ? '' : ' · not linked to GitHub yet — everything is queued');
    this.updateCounts();
  }
}
