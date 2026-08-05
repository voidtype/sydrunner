/**
 * The chat box: a scrollback that fades, and a line you type into.
 *
 * Its own module rather than three more methods on `Hud`, on the same argument
 * `bigmap.ts` and `minimap.ts` already make in this directory: `hud.ts` is the
 * *game's* readout -- pips, stamina, the banner, the board -- and every element
 * in it is written to from the frame loop with a string compare in front of it.
 * This is a text widget with focus, an expiry timer and a keyboard of its own,
 * and none of that belongs in a class whose contract is "cheap to call sixty
 * times a second".
 *
 * The one thing it does reach into `hud.ts` for is `Hud.chatTyping`, and that is
 * not decoration either -- see `open()`.
 *
 * ---------------------------------------------------------------------------
 * ## WHERE IT SITS, and what it is not allowed to touch
 *
 * Bottom-left, **above** the vitals. The four corners are taken: vitals bottom
 * left, controls bottom right, map and locator top right, debug top left, and
 * the notice pill along the bottom centre. The log grows *upwards* out of the
 * bottom-left stack so a quiet game shows one line and a busy one shows eight,
 * and neither ever moves the pips -- which are read by glancing down mid-fight
 * and must be in the same place every time.
 *
 * Width is capped at `min(460px, 42vw)`, which mirrors the controls block's own
 * `min(340px, 44vw)` on the opposite side: at any window width the two can never
 * meet in the middle. Long words wrap rather than overflow (`overflow-wrap:
 * anywhere`), because a 120-character message with no spaces in it is a thing
 * somebody will send within a minute of this shipping.
 *
 * ---------------------------------------------------------------------------
 * ## THE FADE, and the one moment it must not happen
 *
 * The log fades out after `IDLE_FADE_MS` of nothing being said, because a
 * permanent block of other people's conversation in the corner of a brawler is a
 * permanent hole in the picture -- the same argument `index.html` makes about
 * why the notice pill is transient and the controls block has no background.
 *
 * It is **held fully visible for as long as the composer is open**, without a
 * timer, because that is precisely when the player is reading: you open the box
 * to answer somebody, and a log that faded while you typed would be a log that
 * hid the message you were replying to.
 *
 * ---------------------------------------------------------------------------
 * ## THE KEYBOARD: who owns Escape
 *
 * `I` opens it, from `main.ts`. While it is open:
 *
 *   - `Hud.chatTyping` is true, so `Hud.typing` is true, so **the whole of
 *     `main.ts`'s keydown listener returns at its first line**. That is the
 *     existing name-prompt guard and it is what stops `wasd` walking the player
 *     and `f`/`l` swinging while a sentence is being typed. It is also what
 *     settles Escape between this and every other panel: the guard is above the
 *     Escape branch, so nothing else in that listener -- the control list, the
 *     map, the suggestions panel -- can see the key while the composer has it.
 *   - This module's own listener is on the **input element**, and it
 *     `stopPropagation()`s everything. So even a build where something binds a
 *     key on `document` in the capture phase gets nothing, which is the guard
 *     `askName` already uses and for the same reason.
 *   - `Enter` sends and closes. Sending and *staying* open is the other
 *     defensible choice and it is wrong for this game: the box holds the
 *     keyboard, and a brawler where a player is still disarmed after they
 *     finished their sentence is a brawler that punishes chatting. One key in,
 *     one key out.
 *   - `Escape` closes and discards. The draft is thrown away rather than kept,
 *     because a box that reopens holding a half-sentence from four minutes ago
 *     is a box that sends it by accident.
 *
 * Pointer lock is released on open. Not because the keyboard needs it -- a
 * locked pointer still delivers keydowns -- but because the mouse does not stop
 * turning the camera while you type, and because the browser eats the first
 * Escape to release the pointer, which would make Escape take two presses to
 * close a text box. Releasing it up front costs one click to resume and makes
 * both problems go away.
 */

import { MAX_CHAT_CHARS, sanitiseChat, CHAT_FLAG, CHAT_ROOM_NONE, type ChatLine } from './net/chat.ts';

/** How many lines the scrollback holds. Older ones are dropped from the top. */
export const CHAT_SCROLLBACK = 8;
/** Silence for this long and the log fades away. See the header. */
export const IDLE_FADE_MS = 15000;

/** What `ChatBox` needs from the rest of the client, so it can be built without one. */
export interface ChatBoxHooks {
  /**
   * Send this text. Return what was actually sent, or the empty string if the
   * client refused it -- which offline it always does.
   *
   * A function rather than a `NetClient` because `main.ts` builds the box before
   * it knows whether there is a server, and a box that had to be reconstructed
   * on connect would be a box whose scrollback was thrown away by connecting.
   */
  send(text: string): string;
  /** Told whenever the composer takes or releases the keyboard. Wired to `Hud.chatTyping`. */
  onTypingChange(typing: boolean): void;
  /** This client's own id, for marking its own lines. 0 offline and before WELCOME. */
  selfId(): number;
  /** This client's own room, for deciding which lines are from elsewhere. -1 if unknown. */
  selfRoom(): number;
}

export class ChatBox {
  private readonly root = document.getElementById('chat')!;
  private readonly logEl = document.getElementById('chatlog')!;
  // `#chatcompose` is shown and hidden by `#chat.open` in CSS rather than from
  // here, so there is deliberately no handle to it: one class on the root is one
  // place the open state lives, and a second element toggled in script would be
  // a second place for it to be wrong.
  private readonly input = document.getElementById('chatinput') as HTMLInputElement;

  private readonly hooks: ChatBoxHooks;
  private opened = false;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hooks: ChatBoxHooks) {
    this.hooks = hooks;
    // The cap comes from the shared constant rather than from the markup, so the
    // one place the rule is written is `net/chat.ts` and the field cannot go
    // stale against the sanitiser that will clip what it accepts anyway.
    //
    // In **characters**, because that is what `maxlength` counts and what a
    // person is typing. The byte cap is the server's and is stricter for
    // non-Latin text; a field that tried to enforce it would be a field that
    // stopped accepting Japanese two thirds of the way along with no
    // explanation. Clipping quietly on send is the better failure.
    this.input.maxLength = MAX_CHAT_CHARS;
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // A blur that is not a close -- the player clicked the canvas -- closes the
    // box, because a composer holding the keyboard while the focus is somewhere
    // else is the exact state `Hud.typing` exists to prevent and the exact state
    // `askName`'s comment describes going wrong.
    this.input.addEventListener('blur', () => {
      if (this.opened) this.close();
    });
  }

  get open(): boolean {
    return this.opened;
  }

  /**
   * Take the keyboard and show the log.
   *
   * `chatTyping` is set **before** the class is added, so there is no frame in
   * which the box is on screen and `main.ts`'s guard is still false. The order
   * matters here in a way it does not in `close`: opening races a keydown that is
   * already in flight, and the one that gets through is a `w` that walks you into
   * traffic while you type.
   */
  openBox(): void {
    if (this.opened) return;
    this.opened = true;
    this.hooks.onTypingChange(true);
    this.root.classList.add('open');
    this.wake();
    // Released so Escape reaches this box on the first press and so the mouse
    // stops steering. See the header.
    if (document.pointerLockElement) document.exitPointerLock();
    // After the class, or the element is still `display: none` and the browser
    // refuses the focus silently -- `askName`'s own trap, one panel over.
    this.input.focus();
    this.input.select();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.input.value = '';
    this.root.classList.remove('open');
    this.hooks.onTypingChange(false);
    this.input.blur();
    // The log was pinned visible while the box was up; from here it is on the
    // ordinary timer again, starting now rather than from the last message --
    // somebody who just closed a box has just finished reading.
    this.wake();
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.openBox();
  }

  private onKey(e: KeyboardEvent): void {
    // Everything, unconditionally, on `askName`'s argument: `main.ts` binds bare
    // letters on `window` and every one of them is a character somebody may want
    // in a sentence. `Hud.typing` already stops that listener, and this is the
    // guard that does not depend on another module keeping its promise.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      this.submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    // Tab would move the focus out of the field and leave `chatTyping` true with
    // the keyboard somewhere else. There is nowhere to tab to inside the box.
    if (e.key === 'Tab') e.preventDefault();
  }

  private submit(): void {
    const typed = sanitiseChat(this.input.value);
    this.close();
    if (typed.length === 0) return;
    const sent = this.hooks.send(typed);
    if (sent.length === 0) {
      // The one place this module invents a line rather than drawing one it was
      // sent. Offline (`?offline`) there is no socket and never will be; on a
      // dropped connection there is one that is not answering. Both produce the
      // same honest sentence rather than a message that appears to have been
      // said to nobody.
      this.system('no server — chat needs a connection (you are playing offline)');
    }
    // And **nothing on success**. The line comes back off the wire like
    // everybody else's, which is what makes "did that send?" answerable: an echo
    // drawn locally would show the player their own message whether or not the
    // server ever saw it, and the rate limiter's silent drops would be invisible
    // to the one person who needs to know about them.
  }

  /** A line off the wire. See `net/chat.ts`. */
  push(line: ChatLine): void {
    const el = document.createElement('div');
    el.className = 'chatline';

    const system = (line.flags & CHAT_FLAG.SYSTEM) !== 0;
    if (system) {
      el.classList.add('system');
      const body = document.createElement('span');
      body.className = 'body';
      // `textContent`, never `innerHTML`, everywhere in this method. Every
      // string here came off a socket: the sanitiser strips what would let it
      // lie about its width or its direction, and this is what stops it being
      // markup. `hud.leaderboard` makes the same note about the same wire.
      body.textContent = line.text;
      el.appendChild(body);
    } else {
      const mine = line.sender !== 0 && line.sender === this.hooks.selfId();
      if (mine) el.classList.add('mine');
      // The room marker: shown only when the line came out of a room that is not
      // this client's. Cross-room lines are the *norm* under the least-full
      // gateway rule, so marking every line with its room would be marking
      // everything; marking only the ones from elsewhere is one glyph that means
      // "this person is not near you", which is the only thing a reader wants
      // from it. Skipped entirely until the WELCOME has said which room we are
      // in, rather than guessing that -1 differs from everything.
      const here = this.hooks.selfRoom();
      if (here >= 0 && line.room !== CHAT_ROOM_NONE && line.room !== here) {
        const tag = document.createElement('span');
        tag.className = 'room';
        tag.textContent = `r${line.room}`;
        el.appendChild(tag);
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (line.name || `player ${line.sender}`) + ':';
      const body = document.createElement('span');
      body.className = 'body';
      body.textContent = line.text;
      el.append(name, body);
    }

    this.logEl.appendChild(el);
    // Dropped from the top rather than scrolled, because there is no scrollbar
    // to reach: the log is `pointer-events: none` over a game. Eight lines is
    // what a glance holds.
    while (this.logEl.childElementCount > CHAT_SCROLLBACK) this.logEl.firstElementChild!.remove();
    this.wake();
  }

  /** A locally-invented line, drawn like a server notice. */
  system(text: string): void {
    this.push({ sender: 0, room: CHAT_ROOM_NONE, flags: CHAT_FLAG.SYSTEM | CHAT_FLAG.PRIVATE, name: '', text });
  }

  /**
   * Show the log and restart the idle clock -- unless the composer is open, in
   * which case there is no clock. See the header.
   */
  private wake(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    this.logEl.classList.remove('faded');
    if (this.opened) return;
    // An empty log is nothing at all rather than an empty faded block; the CSS
    // `:empty` rule does that, and this only avoids arming a timer for it.
    if (this.logEl.childElementCount === 0) return;
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      // Re-checked rather than trusted: fifteen seconds is long enough for the
      // box to have been opened since this timer was armed, and `wake` clears
      // the handle but a timer that had already fired would not be cleared.
      if (!this.opened) this.logEl.classList.add('faded');
    }, IDLE_FADE_MS);
  }
}

/**
 * The parts of the box that are arithmetic rather than DOM, asserted.
 *
 * Deliberately small: everything with a real failure mode -- the sanitiser, the
 * caps, the rate limiter, the two frame layouts -- is in `net/chat.ts` and is
 * checked by `verifyChat`, which the server runs too. What is left here is the
 * scrollback's own two numbers, and they are worth one line because both are
 * read by `index.html`'s layout: a scrollback longer than the block can hold
 * pushes the vitals off the bottom of the screen, and a fade shorter than a
 * sentence takes to read is a chat nobody can follow.
 */
export function verifyChatBox(): string[] {
  const failures: string[] = [];
  if (CHAT_SCROLLBACK < 1 || CHAT_SCROLLBACK > 12) {
    failures.push(`the scrollback holds ${CHAT_SCROLLBACK} lines; the block above the vitals fits about 8.`);
  }
  if (IDLE_FADE_MS < 5000) {
    failures.push(`the log fades after ${IDLE_FADE_MS} ms, which is less than a sentence takes to read.`);
  }
  return failures;
}
