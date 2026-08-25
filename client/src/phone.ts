/**
 * The phone's screen: the overlay, the six apps, the viewfinder and the album.
 *
 * The slots that decide whether you are holding one, the rules about where the
 * map is drawn, and the album's own arithmetic all left this file when the
 * server started checking them -- they are in `game/phone.ts`, which is
 * DOM-free, and the reason is written down there. What is here is everything
 * that touches an element, plus the three string helpers the panel needs.
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
 * **The camera is the one screen that takes the pointer back**, and it is the
 * exception that proves the rule rather than a contradiction of it: a viewfinder
 * has nothing to click, and what it needs instead is the mouse turning your head
 * so you can aim the shot. Opening it from the Camera tile is a click, which is
 * a user gesture, which is the only thing `requestPointerLock` will accept -- so
 * the tile that opens the viewfinder is also the gesture that re-locks. See
 * `setCamera`.
 *
 * ---------------------------------------------------------------------------
 * ESCAPE UNWINDS ONE STEP, WHICH IT DID NOT USED TO
 *
 * Escape opens the suggestions box when nothing else is open (`main.ts`), and
 * the phone has to take precedence when it is up -- otherwise the press that
 * puts the phone away also opens a panel, which is the exact failure `main.ts`'s
 * `anyOpen` comment is written about.
 *
 * What changed with the map and the camera is that the phone now has **depth**.
 * It used to be one screen deep, so Escape could only mean "put it away". It is
 * now up to three -- a photograph, inside the gallery, inside the phone; or a
 * full-screen map that the phone opened -- and a key that closed the whole
 * device from the bottom of that would throw away two steps of navigation on a
 * press the player meant as "back".
 *
 * So `back()` unwinds exactly one level and reports whether it found one, and
 * `money.ts` composes the rest: back out of the phone's own screens, then out of
 * a map the phone opened, and only then put the phone away. The brief states the
 * rule for the map -- *"Esc closes it back to the phone home; a second Esc puts
 * the phone away"* -- and this is that rule generalised, because a device where
 * one screen goes back and the others close is a device you have to learn.
 */

import {
  CENTRELINK_PAYMENT,
  formatGameWait,
  formatMoney,
  nearestOffices,
  type CentrelinkOffice,
} from './game/cash.ts';
import { GALLERY_MAX, type Gallery, verifyPhoneModel } from './game/phone.ts';
import type { FareFrame, WalletFrame } from './net/cash.ts';

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
  /**
   * Open the big map. **The only route to it**, as of this pass: the `M` key is
   * a shortcut that equips the phone and calls the same tile. See `money.ts`.
   */
  openMap(): void;
  /**
   * Open the talents panel. Workstream V; `openMap`'s shape and its reasons.
   *
   * Optional, unlike the rest of this interface, because a `PhoneSource` is also
   * built by checks and by `?offline` -- and offline there is no ladder, so a
   * tile that did nothing is the honest behaviour rather than a hole. The tile
   * itself is always drawn: `TalentsPanel.show` refuses for a guest and offline,
   * in one place, and a tile that appeared and disappeared with the account
   * state would be a home screen that rearranges itself.
   */
  openTalents?(): void;
  /**
   * WORKSTREAM AK: the Obligations screen's markup, or undefined.
   *
   * **Markup rather than data**, which is this interface's one departure from
   * how every other app here is fed, and it is the same call `openTalents`
   * makes one line up for a different reason: the rows belong to
   * `client/src/dialog.ts`, which owns the quest model, the step labels and the
   * escaping -- and a `PhoneSource` that carried cursors and steps instead
   * would put a second renderer for them in this file.
   *
   * Optional, so a build with no quest content -- `?offline`, an older server
   * -- draws a tile that says so rather than a tile that throws.
   */
  obligations?(): string;
  /** QuestBuddy's *take me there*. See `dialog.DialogSource.aimAt`. */
  aimAt?(questId: string): void;
  /**
   * The album, owned by `money.ts`.
   *
   * Handed in rather than constructed here because a photograph is taken from
   * the *viewfinder*, which is a state of this class, and filed by the capture
   * path, which is not -- so the one object both of them touch has to belong to
   * whoever owns both, which is the installer.
   */
  gallery: Gallery;
  /**
   * Take a photograph of the frame after this one.
   *
   * Fire-and-forget: the capture is two awaits deep (a frame, then an encode)
   * and the phone has nothing useful to do while it happens. What comes back is
   * `photoFiled` or a line on the HUD.
   */
  shoot(): void;
  /**
   * Hand a photograph to the bug box with the image already attached.
   *
   * The whole of "share": there is no other outbound path in this client and
   * inventing one for photographs would mean a second uploader, a second server
   * route and a second thing to moderate. What this does have is the property
   * the brief asked for -- a photograph of something broken becomes a report in
   * two clicks -- which is the case that actually matters.
   */
  share(dataUrl: string, note: string): void;
  /** Say something in the HUD's notice pill. Saves, deletions, refusals. */
  notice(text: string): void;
  /**
   * Ask for pointer lock, from inside a click handler.
   *
   * Only the viewfinder uses it, and only ever from the Camera tile's own click
   * -- see `setCamera`. A browser refuses this from anything that is not a user
   * gesture, so it cannot be called from a timer or from the frame loop.
   */
  lockPointer(): void;
}

// --- The overlay -------------------------------------------------------------------

type AppId = 'wallet' | 'centrelink' | 'sydride' | 'map' | 'camera' | 'gallery' | 'talents' | 'obligations';

interface AppDef {
  id: AppId;
  glyph: string;
  label: string;
}

/**
 * The home screen, in the order the tiles are drawn.
 *
 * Six now, in two rows of three. Four of them were here before this pass; the
 * two new ones are the halves of one feature -- a camera that takes photographs
 * and a gallery that keeps them -- and they are two tiles rather than one
 * because they are two *modes*: one hides the phone and gives you back the
 * mouse, the other is a grid you scroll. A single tile that did both would have
 * to guess which you meant, and would guess wrong for whichever of the two you
 * had just used.
 *
 * The **Map** tile is the entry point to the big map and, since this pass, the
 * only one there is. `M` still works and goes through here; see
 * `game/phone.applyMapKey`.
 */
const APPS: readonly AppDef[] = [
  { id: 'wallet', glyph: '$', label: 'wallet' },
  { id: 'centrelink', glyph: '¢', label: 'centrelink' },
  { id: 'sydride', glyph: '⌁', label: 'sydride' },
  { id: 'map', glyph: '◎', label: 'map' },
  { id: 'camera', glyph: '◉', label: 'camera' },
  { id: 'gallery', glyph: '▤', label: 'gallery' },
  /**
   * Workstream V. A **shortcut, not a screen**, exactly like Map above it: the
   * talent trees are six columns of forty-two nodes and a 300 px handset cannot
   * draw one of them, so the tile puts the phone away and opens the full-screen
   * panel. The Escape ordering `money.ts` owns brings the phone back at its home
   * screen afterwards, which is what makes it a step rather than a dismissal.
   *
   * Seventh tile, so the grid is now three rows: two of three and one of one.
   * That is uglier than six and is still the right place for it -- the phone is
   * where a player already goes to look at things about themselves, and the
   * alternative entry points (the level line, the Escape strip) are both places
   * you have to already know about.
   */
  { id: 'talents', glyph: '✦', label: 'talents' },
  /**
   * WORKSTREAM AK. **A screen, not a shortcut**, which is what separates it
   * from Map and Talents above: what you owe Centrelink is four short rows and
   * a step you are part way through, and a 300 px handset draws that perfectly
   * well. There is nothing to take the screen for.
   *
   * Eighth tile, so the grid is three rows of three and finally square again --
   * which the seventh tile's own note apologised for and is worth saying is
   * now fixed rather than leaving the apology standing.
   *
   * `§` because it is a form. The joke is the whole point of Act 0.
   */
  // **QuestBuddy**, which is what a player calls it and therefore what the tile
  // says. The `AppId` underneath stays `obligations` on purpose: it is an
  // internal key, and Act 0's whole fiction is Centrelink's *mutual
  // obligations* -- Denise's dialog, the `act0:` flags and the register's own
  // captions are written around that word. Renaming the key would rename the
  // joke; renaming the label is what was asked for.
  { id: 'obligations', glyph: '!', label: 'QuestBuddy' },
];

/** How long the viewfinder flashes white after the shutter, milliseconds. */
const FLASH_MS = 80;

export class Phone {
  private readonly root = document.getElementById('phone');
  private readonly home = document.getElementById('phone-home');
  private readonly title = document.getElementById('phone-title');
  private readonly body = document.getElementById('phone-appbody');
  private readonly clock = document.getElementById('phone-clock');
  private readonly back = document.getElementById('phone-back');
  /** The corner brackets and the shutter hint. Null on an older `index.html`. */
  private readonly viewfinder = document.getElementById('viewfinder');
  private readonly flashEl = document.getElementById('viewfinder-flash');

  private readonly source: PhoneSource;
  private open = false;
  private app: AppId | null = null;
  /** The photograph being looked at full-screen inside the phone, or null. */
  private viewing = 0;
  /** Is the viewfinder up? The overlay is hidden while it is. See `setCamera`. */
  private camera = false;
  private readonly log: Transaction[] = [];
  /** What was last drawn, so a 4 Hz refresh is a string compare. See `tick`. */
  private drawn = '';
  private sinceRedraw = 0;
  private readonly offices: Array<{ office: CentrelinkOffice; distance: number }> = [];
  /**
   * The gallery's markup, cached, and the stamp that says whether it is stale.
   *
   * The only screen here that needs this. Every other app is a few hundred bytes
   * of rows and the `drawn` string compare below costs nothing; the gallery is
   * twelve base64 thumbnails and is a **quarter of a megabyte of string**, which
   * is not something to rebuild and compare four times a second for a screen
   * that changes when a photograph is taken or deleted and at no other time.
   *
   * Caching it also makes the compare free rather than merely cheap: the same
   * string *reference* comes back out, so `html === this.drawn` is a pointer
   * compare instead of a quarter-megabyte `memcmp`.
   */
  private galleryHtml = '';
  private galleryStamp = '';
  private flashTimer = 0;

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

  /** Is the viewfinder up? A left click takes a photograph while it is. */
  get cameraActive(): boolean {
    return this.camera;
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
    if (open) this.setCamera(false);
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

  /**
   * Open the handset straight onto the obligations register. `Q`'s route in.
   *
   * The register has been on the phone since workstream AN and it is a real
   * quest log -- every job with its standing, or the server's own sentence for
   * why it is shut -- but it sat behind a tile marked `§` that a player has to
   * know to press, and a log nobody can find is a log nobody has. `Q` is the
   * key every game with a quest log uses and it was bound to nothing.
   *
   * `setOpen` first and the app second, in that order: `setOpen(true)` resets
   * the handset to its home screen, so opening the app before it would be undone
   * on the same press.
   */
  openObligations(): void {
    this.setOpen(true);
    this.openApp('obligations');
  }

  close(): void {
    this.setCamera(false);
    this.setOpen(false);
  }

  /**
   * One step out of wherever the player is. Returns false when there is nowhere
   * left to go, which is `money.ts`'s signal to try the next thing (the map,
   * then putting the phone away). See the header.
   */
  goBack(): boolean {
    if (this.camera) {
      this.setCamera(false);
      this.setOpen(true);
      return true;
    }
    // **Nothing on screen, nothing to go back from.** The guard is load-bearing
    // rather than tidy: `app` keeps its value while the phone is shut, so
    // without this an Escape pressed with the phone away would find a stale
    // `wallet` in there, consume the key, and leave the player pressing Escape
    // at a game that appears to ignore it -- the suggestions box would never
    // open. See `money.keydown`, which treats a false here as "not mine".
    if (!this.open) return false;
    if (this.viewing !== 0) {
      this.viewing = 0;
      this.invalidate();
      this.draw();
      return true;
    }
    if (this.app !== null) {
      this.openApp(null);
      return true;
    }
    return false;
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
   * A photograph landed in the album. Redraw if the gallery is what is on screen.
   *
   * Pushed rather than polled because the album is not this class's object and
   * a 4 Hz poll of "has the list changed" over twelve records would be a
   * comparison written to avoid one call.
   */
  photoFiled(): void {
    this.invalidate();
    if (this.app === 'gallery') this.draw();
  }

  /**
   * Take the picture: flash the frame and ask for the capture.
   *
   * The flash is **before** the capture rather than after, and that is the whole
   * reason it is 80 ms rather than something longer: the grab happens on the
   * next rendered frame, so a flash that waited for the photograph to come back
   * would fire a fifth of a second after the click and read as lag. Firing it on
   * the press makes the click and the flash one event, which is what a shutter
   * is -- and the DOM flash cannot appear in the photograph in any case, because
   * the photograph is the canvas and the flash is an element over it.
   */
  shoot(): void {
    if (!this.camera) return;
    this.flash();
    this.source.shoot();
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

  /**
   * The viewfinder: the phone goes away, the brackets come up, the pointer comes
   * back.
   *
   * Hiding the overlay rather than drawing the viewfinder *through* it is the
   * only arrangement that makes sense of "raising the camera": the phone is a
   * 300 px panel in the lower right of the frame and a viewfinder is the frame.
   * `open` goes **false** while the viewfinder is up, rather than being left
   * true with the element hidden, and the reason is that `visible` is a
   * question other code asks and the honest answer is no -- there is no overlay
   * on the screen and nothing on it to click. What makes the camera a screen
   * *of* the phone rather than a mode beside it is `goBack`, which puts the
   * overlay back explicitly on the way out, so the back gesture lands where
   * every other app's does.
   *
   * The pointer lock is asked for on the way in and not given up on the way out,
   * which is deliberate asymmetry: coming in, the click on the tile is the
   * gesture that permits it; going out, `setOpen(true)` releases it again
   * because the phone needs a cursor. So the sequence camera -> back -> camera
   * works, and each leg does the one thing it can legitimately do.
   */
  private setCamera(on: boolean): void {
    if (this.camera === on) return;
    this.camera = on;
    this.viewfinder?.classList.toggle('shown', on);
    if (!on) return;
    this.open = false;
    this.root?.classList.remove('shown');
    this.source.lockPointer();
  }

  /** White for `FLASH_MS`, over the viewfinder and under nothing. */
  private flash(): void {
    const el = this.flashEl;
    if (!el) return;
    el.classList.add('on');
    if (this.flashTimer !== 0) clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      el.classList.remove('on');
      this.flashTimer = 0;
    }, FLASH_MS);
  }

  private openApp(app: AppId | null): void {
    if (app === 'map') {
      // The Map app is a shortcut and not a screen: a 300 px map is not a map.
      // Opening the real one puts the phone away, because the big map is
      // full-screen and a phone on top of it would be covering the thing it
      // just opened. Escape brings the phone back at its home screen -- see
      // `money.ts`'s Escape ordering, which is what makes that a *step back*
      // rather than a dismissal.
      this.setOpen(false);
      this.source.openMap();
      return;
    }
    if (app === 'camera') {
      this.setCamera(true);
      return;
    }
    if (app === 'talents') {
      // The Map tile's move, for the Map tile's reason: the panel is
      // full-screen and a handset on top of it would cover what it just opened.
      this.setOpen(false);
      this.source.openTalents?.();
      return;
    }
    this.app = app;
    this.viewing = 0;
    this.root?.classList.toggle('app-open', app !== null);
    this.drawn = '';
    this.sinceRedraw = 1;
    this.invalidate();
    this.draw();
  }

  /** The gallery's cached markup is stale. */
  private invalidate(): void {
    this.galleryStamp = '';
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

      case 'obligations':
        this.title.textContent = 'QuestBuddy';
        rows.push(
          this.source.obligations?.() ??
            '<div class="phone-note">no participation requirements are recorded for this session.</div>',
        );
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

      case 'gallery':
        this.title.textContent = this.viewing === 0 ? 'gallery' : 'photo';
        rows.push(this.galleryMarkup());
        break;

      default:
        break;
    }

    // `join` on a single-element array returns that element, so the gallery's
    // cached string comes through by reference and the compare below is a
    // pointer compare. See `galleryHtml`.
    const html = rows.length === 1 ? rows[0] : rows.join('');
    if (html === this.drawn) return;
    this.drawn = html;
    this.body.innerHTML = html;
    // Rebound after every rebuild, because the buttons are new elements each
    // time. One delegated pass over `[data-act]` rather than a query per
    // action: the gallery draws up to fourteen of them and a named query each
    // would be a list this method has to be kept in step with.
    for (const el of Array.from(this.body.querySelectorAll('[data-act]'))) {
      const act = (el as HTMLElement).dataset.act ?? '';
      const id = Number((el as HTMLElement).dataset.id ?? '0');
      // `data-qid` is the string half: the gallery's actions key on a photo's
      // number and QuestBuddy's key on a quest id, which is text.
      const qid = (el as HTMLElement).dataset.qid ?? '';
      el.addEventListener('click', () => this.act(act, id, qid));
    }
  }

  /**
   * What a button on the phone's body does.
   *
   * One switch rather than a closure per button, so every action this screen can
   * take is in one list -- which is what makes it obvious that `delete` is the
   * only destructive one and that it is the only one that redraws the list
   * rather than a photograph.
   */
  private act(action: string, id: number, qid = ''): void {
    switch (action) {
      case 'aim':
        // The arrow is `main.ts`'s and the register is `dialog.ts`'s, so the
        // phone only carries the press across. Redrawn immediately so the
        // button can say `guiding` on the same click that made it true.
        this.source.aimAt?.(qid);
        this.drawn = '';
        this.draw();
        break;

      case 'online':
        this.source.setOnline(!this.source.online());
        this.drawn = '';
        this.draw();
        break;

      case 'open':
        this.viewing = id;
        this.invalidate();
        this.draw();
        break;

      case 'back':
        this.goBack();
        break;

      case 'save': {
        // `<a download>` and a synthetic click, which is the only way a page can
        // hand a file to the person looking at it. A real browser writes it to
        // the downloads folder; a sandboxed artifact viewer refuses the
        // navigation entirely, which is irrelevant here and is noted only so
        // nobody re-tests it there.
        const full = this.source.gallery.full(id);
        if (full === '') {
          this.source.notice('that photo\'s original is gone — it was taken before a reload.');
          return;
        }
        const a = document.createElement('a');
        a.href = full;
        a.download = photoFilename(this.captionOf(id));
        a.click();
        this.source.notice('saved to your downloads.');
        break;
      }

      case 'share': {
        const full = this.source.gallery.full(id);
        const image = full === '' ? this.thumbOf(id) : full;
        if (image === '') return;
        this.source.share(image, `${this.captionOf(id)} · from the gallery`);
        // The bug box is a full-screen panel; a phone on top of it would be
        // covering the form it just filled in. Same call the map tile makes.
        this.setOpen(false);
        break;
      }

      case 'delete':
        if (this.source.gallery.remove(id)) {
          this.viewing = 0;
          this.invalidate();
          this.draw();
          this.source.notice('photo deleted.');
        }
        break;

      default:
        break;
    }
  }

  /**
   * The gallery, cached against a stamp of what is in it.
   *
   * The stamp is the ids and the open photograph, which is exactly the set of
   * things that change the markup: the thumbnails themselves are immutable once
   * taken, so a list with the same ids in the same order draws the same bytes.
   * See `galleryHtml` for why this is worth doing at all.
   */
  private galleryMarkup(): string {
    const photos = this.source.gallery.items;
    const stamp = `${this.viewing}|${photos.map((p) => p.id).join(',')}`;
    if (stamp === this.galleryStamp) return this.galleryHtml;
    this.galleryStamp = stamp;

    const out: string[] = [];
    if (this.viewing !== 0) {
      const thumb = this.thumbOf(this.viewing);
      const full = this.source.gallery.full(this.viewing);
      out.push(
        `<img class="photo-full" alt="a photograph you took" src="${escape(full === '' ? thumb : full)}">`,
      );
      out.push(`<div class="phone-note">${escape(this.captionOf(this.viewing))}</div>`);
      if (full === '') {
        // Said plainly rather than by a greyed-out button. The album's header
        // explains why the original cannot persist; this is the one place a
        // player meets the consequence, and "save" quietly doing nothing would
        // be the worst way to learn it.
        out.push('<div class="phone-note">original lost on reload — only the thumbnail is left.</div>');
      }
      out.push('<div class="photo-acts">');
      out.push(`<button class="phone-act" data-act="save" data-id="${this.viewing}">save</button>`);
      out.push(`<button class="phone-act" data-act="share" data-id="${this.viewing}">to bug box</button>`);
      out.push(`<button class="phone-act bad" data-act="delete" data-id="${this.viewing}">delete</button>`);
      out.push('</div>');
      out.push('<button class="phone-act" data-act="back">all photos</button>');
    } else if (photos.length === 0) {
      out.push('<div class="phone-note">no photos yet. open the camera and click.</div>');
    } else {
      out.push('<div class="photo-grid">');
      for (const p of photos) {
        out.push(
          `<button class="photo-cell" data-act="open" data-id="${p.id}" title="${escape(p.caption)}">` +
            `<img alt="${escape(p.caption)}" src="${escape(p.thumb)}"></button>`,
        );
      }
      out.push('</div>');
      out.push(`<div class="phone-note">${photos.length} of ${GALLERY_MAX} — the oldest goes when it is full.</div>`);
      const trouble = this.source.gallery.storageNote;
      if (trouble !== '') out.push(`<div class="phone-note">${escape(trouble)}</div>`);
    }
    this.galleryHtml = out.join('');
    return this.galleryHtml;
  }

  private captionOf(id: number): string {
    for (const p of this.source.gallery.items) if (p.id === id) return p.caption;
    return '';
  }

  private thumbOf(id: number): string {
    for (const p of this.source.gallery.items) if (p.id === id) return p.thumb;
    return '';
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
 * from anywhere is how a panel becomes an injection. Three of the strings on
 * this screen come from outside: `WalletFrame.note` is composed by the server,
 * an office name comes out of a generated table, and a photograph's caption
 * carries a **suburb name out of an OSM sidecar**, which is arbitrary
 * user-entered text that has travelled over the network. That last one is the
 * reason this function's existing argument stopped being hypothetical: the
 * caption is written into a `title=` attribute and an `alt=`, and an unescaped
 * quote in a suburb name would end the attribute.
 *
 * `hud.investigation` has a comment making exactly this argument about a string
 * that is a lookup today and might not be tomorrow, and reaches the same
 * conclusion: escape it anyway.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A filename for a saved photograph.
 *
 * Built from the caption, which already carries the suburb and the in-game
 * hour, so a folder full of these sorts into something a person can read:
 * `sydrunner-newtown-1842.jpg`. Everything that is not a letter, a digit or a
 * hyphen is collapsed, because a caption can contain a middle dot, a space and
 * whatever punctuation a suburb name has in it -- and a `download` attribute is
 * a filename on somebody else's filesystem.
 */
function photoFilename(caption: string): string {
  const slug = caption
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug === '' ? 'sydrunner' : slug}.jpg`;
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
 * The whole phone, from the client's side: the model's checks plus the three
 * string helpers that never left this file.
 *
 * `verifyPhoneModel` is where the slots, the map rules and the album are
 * asserted, and it is run **again in the server process** -- see
 * `server/index.ts`. It is folded in here rather than wired separately in
 * `main.ts` so that `sydney.selfChecks()` and the boot list still have one call
 * for "the phone", which is what a person looking for a phone failure will
 * reach for.
 *
 * What is added here is only what needs a browser's string semantics and cannot
 * run there:
 *
 *   - The **escaper**, on the one string that can reach it from outside. A
 *     suburb name goes into a `title=` attribute now, so a stray quote is an
 *     attribute break rather than a cosmetic wobble.
 *   - The **filename**, because `<a download>` writes it to a filesystem and a
 *     caption with a slash in it is a path.
 *   - The **relative time**, which is the only arithmetic on the wallet screen.
 *
 *     bun -e "import {verifyPhone} from './client/src/phone.ts';
 *             console.log(verifyPhone())"
 */
export function verifyPhone(): string[] {
  const failures: string[] = [...verifyPhoneModel()];

  // --- The escaper.
  {
    const nasty = '<img src=x onerror="alert(1)">';
    if (escape(nasty).includes('<')) failures.push('The phone escaper let a tag through into innerHTML.');
    if (escape('a & b') !== 'a &amp; b') failures.push(`The phone escaper made ${escape('a & b')} of "a & b".`);
    // Ampersand first, or `&lt;` becomes `&amp;lt;` and the panel draws markup
    // as text -- the classic double-escape, in the direction that is merely
    // ugly rather than dangerous, and still wrong.
    if (escape('<') !== '&lt;') failures.push(`escape('<') is ${escape('<')}; the ampersand pass must run first.`);
    // The attribute case, which is new with the gallery: a caption goes into
    // `title=` and `alt=`, and a quote in a suburb name would close it.
    if (escape('St "Peters"').includes('"')) failures.push('The phone escaper left a quote in an attribute value.');
  }

  // --- The filename, which is written to somebody's disk.
  {
    const name = photoFilename('sydrunner · Newtown · 18:42');
    if (name !== 'sydrunner-newtown-18-42.jpg') failures.push(`A saved photo would be called "${name}".`);
    if (photoFilename('').length === 0) failures.push('An empty caption produced an empty filename.');
    // A path, which is the failure that matters: nothing may reach a filesystem
    // with a separator or a traversal in it.
    const nasty = photoFilename('../../etc/passwd');
    if (nasty.includes('/') || nasty.includes('..')) failures.push(`A caption became the path "${nasty}".`);
  }

  // --- The relative time.
  {
    if (ago(0) !== 'just now') failures.push(`ago(0) is ${ago(0)}.`);
    if (ago(120_000) !== '2 min ago') failures.push(`ago(2 min) is ${ago(120_000)}.`);
    if (ago(7_200_000) !== '2 h ago') failures.push(`ago(2 h) is ${ago(7_200_000)}.`);
  }

  return failures;
}
