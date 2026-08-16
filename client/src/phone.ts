/**
 * What is in your hands, and the phone that is one of the things it can be.
 *
 * Two features in one file because they are one idea: the phone is a **weapon
 * slot** that happens to open a screen instead of hitting somebody, and
 * splitting "the slots" from "the phone UI" would put the rule that pressing
 * `3` raises a handset in one file and the handset in another.
 *
 * ---------------------------------------------------------------------------
 * THE SLOTS
 *
 * Four of them -- bat, footy, phone, fists -- and **two hands**. `1..4` picks
 * the primary (right hand, left mouse button); `shift+1..4` picks the secondary
 * (off hand, right mouse button). The default arrangement is bat primary, footy
 * secondary, which is exactly what the game did before this file existed:
 * `main.ts` has always drawn a bat in the right hand and a football in the
 * left, swung on LMB and thrown on RMB. **Nothing about the default changes**,
 * and that is a requirement rather than a nicety -- every player's muscle
 * memory is that pair of buttons, and a slot system that rearranged them on
 * first load would be a slot system nobody asked for.
 *
 * What the slots buy is the three arrangements the default cannot express:
 * a phone in your hand, bare fists (which punch, because `combat`'s strike is a
 * punch whatever is drawn), and the footy in your *right* hand for anybody who
 * wants to throw on LMB.
 *
 * **Primary and secondary cannot be the same slot, except fists.** One bat,
 * one football; you may however have nothing in both hands, which is the state
 * `4` / `shift+4` puts you in and is the closest thing this game has to
 * holstering. The constraint is enforced by *swapping* rather than refusing --
 * asking for the bat in your off hand when it is in your right hand moves it,
 * and whatever was in the off hand goes to the right. A refusal would be a key
 * that does nothing with nothing on screen to say why.
 *
 * **Selection is client-side and is not on the wire.** This was a real
 * decision. The server adjudicates the punch, the swing and the throw already,
 * from `BTN.PUNCH` and `BTN.THROW` -- and those two bits are what the mouse
 * buttons are *mapped to*, which is the only thing the slots change. So a
 * player with the footy primary sends `THROW` on LMB and the server sees
 * exactly what it saw when they pressed RMB, which is correct without knowing
 * anything about slots. What the server does *not* learn is which model is in
 * which hand on a remote body, so a remote player holding a phone is drawn
 * holding a bat -- that is a cosmetic gap, it costs a protocol field to close,
 * and this pass is not spending one on it. The phone's actual *actions* travel
 * on `MSG.PHONE`, which the server does validate.
 *
 * ---------------------------------------------------------------------------
 * THE PHONE DOES NOT STOP TIME, AND IT DOES RELEASE THE POINTER
 *
 * The brief's requirement is that the world keeps moving while the phone is up,
 * and it does: nothing here touches the fixed step, the renderer or the socket.
 * Cars keep driving past, the crowd keeps walking, you keep taking damage, and
 * `wasd` still walks -- the movement keys are read from `main.ts`'s `keys` set,
 * which this file never touches.
 *
 * What it *does* do is **release pointer lock**, and that is unavoidable rather
 * than chosen: the phone has app tiles you click, and a browser under pointer
 * lock has no cursor to click them with. The alternatives were both worse. A
 * keyboard-driven phone would need arrow keys, which are the no-pointer-lock
 * look fallback, and a number row, which is the slot selector -- so the phone
 * would fight the two bindings it sits between. A gaze-driven phone (aim at a
 * tile, click) is a different feature.
 *
 * So opening the phone is the same gesture the suggestions panel already is:
 * the cursor comes back, the world keeps running behind it, `wasd` keeps
 * walking, and drag-to-look still turns the camera. Clicking anywhere outside
 * the phone puts it away and re-locks, which is `main.ts`'s existing canvas
 * click doing what it always did.
 *
 * ---------------------------------------------------------------------------
 * ESCAPE, AND WHY THE ORDER MATTERS
 *
 * Escape opens the suggestions box when nothing else is open (`main.ts`), and
 * the phone has to take precedence when it is up -- otherwise the press that
 * puts the phone away also opens a panel, which is the exact failure `main.ts`'s
 * `anyOpen` comment is written about. `visible` is what `main.ts` samples, and
 * the phone is closed before the `anyOpen` branch is evaluated. See the
 * `install` return value.
 */

import {
  CENTRELINK_PAYMENT,
  formatGameWait,
  formatMoney,
  nearestOffices,
  type CentrelinkOffice,
} from './game/cash.ts';
import type { FareFrame, WalletFrame } from './net/cash.ts';

// --- The slots ------------------------------------------------------------------

/** The four things a hand can hold. The index is the number key minus one. */
export const SLOT = {
  BAT: 0,
  FOOTY: 1,
  PHONE: 2,
  FISTS: 3,
} as const;

export type Slot = 0 | 1 | 2 | 3;

/** What the HUD and the help list call them. Lower case, like every string here. */
export const SLOT_NAME: readonly string[] = ['bat', 'footy', 'phone', 'fists'];

/**
 * Which slot is in which hand.
 *
 * A two-field record rather than an array, because the two hands are not
 * interchangeable: one is bound to the left mouse button and one to the right,
 * and indexing them by number would make every read `hands[0]` with a comment
 * beside it saying which hand that is.
 */
export interface Hands {
  primary: Slot;
  secondary: Slot;
}

/** Bat right, footy left -- exactly what the game did before slots existed. */
export function defaultHands(): Hands {
  return { primary: SLOT.BAT, secondary: SLOT.FOOTY };
}

/**
 * Put `slot` in one hand, moving whatever was there if it has to.
 *
 * The swap rather than a refusal, and fists exempt from the uniqueness rule --
 * see the header. Returns whether anything changed, so the caller can skip the
 * model rebuild on a key that asked for what is already held.
 */
export function selectSlot(hands: Hands, slot: Slot, hand: 'primary' | 'secondary'): boolean {
  const other = hand === 'primary' ? 'secondary' : 'primary';
  if (hands[hand] === slot) return false;
  // Fists are not an object, so both hands may be empty at once. Everything
  // else is one physical thing and moves rather than duplicating.
  if (hands[other] === slot && slot !== SLOT.FISTS) hands[other] = hands[hand];
  hands[hand] = slot;
  return true;
}

// --- What the phone is shown -----------------------------------------------------

/** One line in the wallet's history. Client-side only; nothing on the wire. */
export interface Transaction {
  /** The server's own sentence -- "+$34 fare". See `net/cash.WalletFrame.note`. */
  note: string;
  /** `Date.now()` when it arrived, for the "2 min ago" column. */
  atMs: number;
}

/**
 * The last ten movements, kept **here and only here**.
 *
 * The server does not keep a transaction log and is not asked to: a ledger of
 * every fare ever paid is a file that grows without bound to serve one screen
 * nobody reads twice, and the balance -- the thing that actually matters -- is
 * already persisted. So the phone remembers what it was told this session and
 * says so honestly in the app ("this session").
 */
const MAX_TRANSACTIONS = 10;

/** Everything the phone reads. Supplied by `main.ts`; the phone owns none of it. */
export interface PhoneSource {
  /** The live wallet mirror off `NetClient`. Read every frame the phone is open. */
  wallet(): WalletFrame;
  /** The live fare mirror. */
  fare(): FareFrame;
  /** Where the player is, world metres. */
  position(): { x: number; z: number };
  /** Is the rideshare shift on? Client-side echo; the server has the last word. */
  online(): boolean;
  /** Ask the server for a Centrelink payment at this office. */
  claim(officeId: string): void;
  /** Clock on or off. */
  setOnline(on: boolean): void;
  /** Open the big map (M). The phone's Map app is a shortcut to the real one. */
  openMap(): void;
}

// --- The overlay -------------------------------------------------------------------

type AppId = 'wallet' | 'centrelink' | 'sydride' | 'map';

interface AppDef {
  id: AppId;
  glyph: string;
  label: string;
}

/**
 * The home screen, in the order the tiles are drawn.
 *
 * Four apps and no more. Every one of them is something the player can only do
 * from here (the balance history, the claim countdown, the shift toggle) or is
 * the one shortcut worth having (the map). A Camera app was in the brief as an
 * optional and is **not built**: the artifact CSP story around a
 * script-initiated download is genuinely annoying, the browser's own screenshot
 * key already exists on every platform, and a tile that opened a dialog nobody
 * could dismiss under pointer lock would be the worst thing on this screen.
 */
const APPS: readonly AppDef[] = [
  { id: 'wallet', glyph: '$', label: 'wallet' },
  { id: 'centrelink', glyph: '¢', label: 'centrelink' },
  { id: 'sydride', glyph: '⌁', label: 'sydride' },
  { id: 'map', glyph: '◎', label: 'map' },
];

export class Phone {
  private readonly root = document.getElementById('phone');
  private readonly home = document.getElementById('phone-home');
  private readonly title = document.getElementById('phone-title');
  private readonly body = document.getElementById('phone-appbody');
  private readonly clock = document.getElementById('phone-clock');
  private readonly back = document.getElementById('phone-back');

  private readonly source: PhoneSource;
  private open = false;
  private app: AppId | null = null;
  private readonly log: Transaction[] = [];
  /** What was last drawn, so a 4 Hz refresh is a string compare. See `tick`. */
  private drawn = '';
  private sinceRedraw = 0;
  private readonly offices: Array<{ office: CentrelinkOffice; distance: number }> = [];

  constructor(source: PhoneSource) {
    this.source = source;
    if (this.home) {
      for (const app of APPS) {
        const el = document.createElement('button');
        el.type = 'button';
        el.innerHTML = '';
        const glyph = document.createElement('b');
        glyph.textContent = app.glyph;
        const label = document.createElement('span');
        label.textContent = app.label;
        el.append(glyph, label);
        el.addEventListener('click', () => this.openApp(app.id));
        this.home.appendChild(el);
      }
    }
    this.back?.addEventListener('click', () => this.openApp(null));
  }

  /** Is the phone up? `main.ts` samples this before its Escape branch. */
  get visible(): boolean {
    return this.open;
  }

  /**
   * Show or hide it.
   *
   * Releasing the pointer is done **here** rather than by the caller, so there
   * is one place that knows the phone needs a cursor. Re-locking on close is
   * deliberately *not* done here: `requestPointerLock` from anything other than
   * a user gesture is refused by every browser, so the click that puts the
   * phone away is what re-locks, through `main.ts`'s existing canvas handler.
   */
  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root?.classList.toggle('shown', open);
    if (open) {
      this.openApp(null);
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  close(): void {
    this.setOpen(false);
  }

  /**
   * Remember a balance movement. Called from `NetClient`'s `onMoney`.
   *
   * Newest first and capped at ten, which is what the app shows. Kept even
   * while the phone is closed, because the interesting case is opening it after
   * a run of fares to see where the money came from.
   */
  record(note: string): void {
    if (note === '') return;
    this.log.unshift({ note, atMs: Date.now() });
    if (this.log.length > MAX_TRANSACTIONS) this.log.length = MAX_TRANSACTIONS;
  }

  /**
   * Redraw, at 4 Hz rather than per frame.
   *
   * The phone shows distances and countdowns that genuinely move, so it cannot
   * be drawn once on open -- and it is a DOM rebuild, so it must not be drawn at
   * 120 Hz. Four times a second is the same call `Minimap`'s 15 Hz redraw makes
   * one order of magnitude down: it is the rate at which a number a person is
   * *reading* stops looking stale, where the map is a thing they are glancing
   * at. The whole body is compared as a string before it is written, so a phone
   * open on a screen with nothing changing costs one `join` and one compare.
   */
  tick(dt: number): void {
    if (!this.open) return;
    this.sinceRedraw += dt;
    if (this.sinceRedraw < 0.25) return;
    this.sinceRedraw = 0;
    this.draw();
  }

  private openApp(app: AppId | null): void {
    if (app === 'map') {
      // The Map app is a shortcut and not a screen: a 300 px map is not a map.
      // Opening the real one puts the phone away, because the big map is
      // full-screen and a phone on top of it would be covering the thing it
      // just opened.
      this.close();
      this.source.openMap();
      return;
    }
    this.app = app;
    this.root?.classList.toggle('app-open', app !== null);
    this.drawn = '';
    this.sinceRedraw = 1;
    this.draw();
  }

  private draw(): void {
    if (!this.body || !this.title) return;
    // The status bar's clock is the **real** time, not the game's, which is
    // the one place in this interface those two differ on purpose: a phone
    // shows the time on the phone, and the game's clock runs a day an hour.
    if (this.clock) {
      this.clock.textContent = new Date().toLocaleTimeString('en-AU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    if (this.app === null) return;

    const rows: string[] = [];
    switch (this.app) {
      case 'wallet':
        this.title.textContent = 'wallet';
        rows.push(`<div class="phone-big">${escape(formatMoney(this.source.wallet().balance))}</div>`);
        if (this.log.length === 0) {
          rows.push('<div class="phone-note">nothing yet this session</div>');
        } else {
          for (const t of this.log) {
            rows.push(row(t.note, ago(Date.now() - t.atMs)));
          }
          rows.push('<div class="phone-note">this session only</div>');
        }
        break;

      case 'centrelink': {
        this.title.textContent = 'centrelink';
        const here = this.source.position();
        nearestOffices(here.x, here.z, 5, this.offices);
        rows.push(
          `<div class="phone-note">${escape(formatMoney(CENTRELINK_PAYMENT))} once a week, per office.</div>`,
        );
        for (const { office, distance } of this.offices) {
          rows.push(row(office.name, `${(distance / 1000).toFixed(distance < 1000 ? 2 : 1)} km`));
        }
        // The countdown is for the office you are standing at, which is the
        // only one the server sends a timer for -- see
        // `net/cash.WalletFrame.centrelinkNextMs` for why one and not thirty.
        const next = this.source.wallet().centrelinkNextMs;
        if (next === 0) rows.push('<div class="phone-note">there is money waiting here — press e</div>');
        else if (next > 0) rows.push(`<div class="phone-note">come back in ${escape(formatGameWait(next))}</div>`);
        break;
      }

      case 'sydride': {
        this.title.textContent = 'sydride';
        const fare = this.source.fare();
        const on = this.source.online();
        const here = this.source.position();
        if (!on) {
          rows.push('<div class="phone-note">drive people around. you need a car.</div>');
        } else if (fare.state === 'none') {
          rows.push('<div class="phone-note">online. get in a car and wait for a job.</div>');
        } else if (fare.state === 'done') {
          rows.push(`<div class="phone-big">${escape(formatMoney(fare.payout))}</div>`);
          rows.push('<div class="phone-note">dropped off. another one shortly.</div>');
        } else {
          const toPickup = fare.state === 'offered' || fare.state === 'toPickup';
          const tx = (toPickup ? fare.px : fare.dx) - here.x;
          const tz = (toPickup ? fare.pz : fare.dz) - here.z;
          const away = Math.sqrt(tx * tx + tz * tz);
          rows.push(row(toPickup ? 'pickup' : 'dropoff', `${away.toFixed(0)} m`));
          rows.push(row('pays about', formatMoney(fare.payout)));
          rows.push('<div class="phone-note">stop within a few metres and hold still.</div>');
        }
        rows.push(
          `<button class="phone-act${on ? ' on' : ''}" data-act="online">${on ? 'go offline' : 'go online'}</button>`,
        );
        break;
      }

      default:
        break;
    }

    const html = rows.join('');
    if (html === this.drawn) return;
    this.drawn = html;
    this.body.innerHTML = html;
    // Rebound after every rebuild, because the button is a new element each
    // time. One listener on one button; a delegated listener on the body would
    // be cheaper and would have to know which app is open to interpret a click.
    const act = this.body.querySelector('[data-act="online"]');
    act?.addEventListener('click', () => {
      this.source.setOnline(!this.source.online());
      this.drawn = '';
      this.draw();
    });
  }
}

/** One `label / value` line. */
function row(label: string, value: string): string {
  return `<div class="phone-row"><span>${escape(label)}</span><span>${escape(value)}</span></div>`;
}

/**
 * Everything drawn in here goes through this, without exception.
 *
 * The phone renders with `innerHTML` -- which is a deliberate choice for a
 * panel that is a list of rows rebuilt four times a second, where the
 * alternative is fifty `createElement` calls -- and `innerHTML` plus a string
 * from anywhere is how a panel becomes an injection. Two of the strings on this
 * screen come off the **wire**: `WalletFrame.note` is composed by the server
 * and an office name comes out of a generated table. Neither is player-supplied
 * today. `hud.investigation` has a comment making exactly this argument about a
 * string that is a lookup today and might not be tomorrow, and reaches the same
 * conclusion: escape it anyway, because the day one of these carries a player's
 * name is a day nobody will re-read this file.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "just now", "2 min ago", "1 h ago". Real time, like the status bar's clock. */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

// --- The self-check ------------------------------------------------------------------

/**
 * The slot rules and the two pure helpers, asserted at boot on the client.
 *
 * The DOM half is deliberately not checked -- `verifyHud`'s own boundary -- but
 * every failure in the slot logic is silent in this repo's sense:
 *
 *   - A **swap that duplicates** puts the bat in both hands, so the player is
 *     holding two bats and the off hand's throw does nothing, with no frame in
 *     which that reads as anything but a missing football.
 *   - A **uniqueness rule that catches fists** makes `4` / `shift+4` a pair of
 *     keys that fight each other, and there is no way to have empty hands.
 *   - And a **default that is not bat/footy** silently rearranges the mouse
 *     buttons for every existing player on the first load after this ships,
 *     which is the one thing this feature must not do.
 *
 *     bun -e "import {verifyPhone} from './client/src/phone.ts';
 *             console.log(verifyPhone())"
 */
export function verifyPhone(): string[] {
  const failures: string[] = [];

  // --- The default is what the game already did.
  {
    const h = defaultHands();
    if (h.primary !== SLOT.BAT || h.secondary !== SLOT.FOOTY) {
      failures.push(
        `The default hands are ${SLOT_NAME[h.primary]}/${SLOT_NAME[h.secondary]}, not bat/footy. ` +
          'Every existing player has left click on the bat and right click on the footy.',
      );
    }
  }

  // --- Selecting what is already held changes nothing and says so.
  {
    const h = defaultHands();
    if (selectSlot(h, SLOT.BAT, 'primary')) failures.push('Re-selecting the held slot reported a change.');
    if (h.primary !== SLOT.BAT || h.secondary !== SLOT.FOOTY) failures.push('A no-op selection moved something.');
  }

  // --- The swap: asking for the bat in the off hand moves it, and the right
  // hand takes what the off hand had.
  {
    const h = defaultHands();
    if (!selectSlot(h, SLOT.BAT, 'secondary')) failures.push('Moving the bat to the off hand reported no change.');
    if (h.secondary !== SLOT.BAT) failures.push(`The off hand holds ${SLOT_NAME[h.secondary]}, not the bat.`);
    if (h.primary !== SLOT.FOOTY) {
      failures.push(`After the swap the right hand holds ${SLOT_NAME[h.primary]}; it should have taken the footy.`);
    }
  }

  // --- One bat. Never two, from any starting arrangement.
  {
    for (const slot of [SLOT.BAT, SLOT.FOOTY, SLOT.PHONE] as Slot[]) {
      const h = defaultHands();
      selectSlot(h, slot, 'primary');
      selectSlot(h, slot, 'secondary');
      if (h.primary === h.secondary) {
        failures.push(`Both hands ended up holding the ${SLOT_NAME[slot]}.`);
      }
    }
  }

  // --- Fists are the exception: both hands may be empty.
  {
    const h = defaultHands();
    selectSlot(h, SLOT.FISTS, 'primary');
    selectSlot(h, SLOT.FISTS, 'secondary');
    if (h.primary !== SLOT.FISTS || h.secondary !== SLOT.FISTS) {
      failures.push('Fists in both hands was refused; there is no other way to hold nothing.');
    }
  }

  // --- Every slot is reachable in both hands, which is the whole of what the
  // number row promises.
  {
    for (const slot of [SLOT.BAT, SLOT.FOOTY, SLOT.PHONE, SLOT.FISTS] as Slot[]) {
      for (const hand of ['primary', 'secondary'] as const) {
        const h = defaultHands();
        selectSlot(h, slot, hand);
        if (h[hand] !== slot) failures.push(`Slot ${SLOT_NAME[slot]} could not be put in the ${hand} hand.`);
      }
    }
    if (SLOT_NAME.length !== 4) failures.push(`${SLOT_NAME.length} slot names against four slots.`);
  }

  // --- The escaper, on the one string that can reach it from outside.
  {
    const nasty = '<img src=x onerror="alert(1)">';
    if (escape(nasty).includes('<')) failures.push('The phone escaper let a tag through into innerHTML.');
    if (escape('a & b') !== 'a &amp; b') failures.push(`The phone escaper made ${escape('a & b')} of "a & b".`);
    // Ampersand first, or `&lt;` becomes `&amp;lt;` and the panel draws markup
    // as text -- the classic double-escape, in the direction that is merely
    // ugly rather than dangerous, and still wrong.
    if (escape('<') !== '&lt;') failures.push(`escape('<') is ${escape('<')}; the ampersand pass must run first.`);
  }

  // --- And the relative time, which is the only arithmetic on this screen.
  {
    if (ago(0) !== 'just now') failures.push(`ago(0) is ${ago(0)}.`);
    if (ago(120_000) !== '2 min ago') failures.push(`ago(2 min) is ${ago(120_000)}.`);
    if (ago(7_200_000) !== '2 h ago') failures.push(`ago(2 h) is ${ago(7_200_000)}.`);
  }

  return failures;
}
