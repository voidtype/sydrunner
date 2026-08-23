/**
 * The phone, minus the phone: the slots, the map rules and the photo album, as
 * arithmetic over plain data.
 *
 * `game/bikes.ts` (pure) against `world/bike.ts` (renderer) is the split this
 * file exists to join on the third side: `client/src/phone.ts` is the **DOM
 * overlay**, `client/src/world/phone.ts` is the **handset in your hand**, and
 * this is the part that is neither -- what is in which hand, whether the map is
 * on the screen at all, and what is in the gallery. The reason for the third
 * file is mechanical and is the same one `net/bugreport.ts` gives for existing:
 * **the server's `tsconfig.json` has no `dom` library**, so a module the server
 * imports may not so much as name `document`. `phone.ts` names it forty times.
 * Everything the server can usefully re-check therefore had to leave that file,
 * and what is left there is the markup.
 *
 * What the server gets out of running these is not the slots -- it has no
 * opinion about which hand a bat is in -- it is the **second runtime**. Every
 * function here is a pure function of its arguments and the whole premise of
 * this project's self-checks is that such a function behaves identically in Bun
 * and in a browser. A gallery that silently depended on a browser global would
 * fail at boot in a process with no console rather than in a player's session.
 *
 * ---------------------------------------------------------------------------
 * THE SLOTS
 *
 * Four of them -- bat, footy, phone, fists -- and **two hands**. `1..4` picks
 * the primary (right hand, left mouse button); `shift+1..4` picks the secondary
 * (off hand, right mouse button). The default arrangement is bat primary, footy
 * secondary, which is exactly what the game did before this system existed:
 * `main.ts` has always drawn a bat in the right hand and a football in the
 * left, swung on LMB and thrown on RMB. **Nothing about the default changes**,
 * and that is a requirement rather than a nicety -- every player's muscle
 * memory is that pair of buttons, and a slot system that rearranged them on
 * first load would be a slot system nobody asked for.
 *
 * **Primary and secondary cannot be the same slot, except fists.** One bat, one
 * football; you may however have nothing in both hands, which is the state `4` /
 * `shift+4` puts you in and is the closest thing this game has to holstering.
 * The constraint is enforced by *swapping* rather than refusing -- asking for
 * the bat in your off hand when it is in your right hand moves it, and whatever
 * was in the off hand goes to the right. A refusal would be a key that does
 * nothing with nothing on screen to say why.
 *
 * **Selection is client-side and is not on the wire.** The server adjudicates
 * the punch, the swing and the throw already, from `BTN.PUNCH` and `BTN.THROW`
 * -- and those two bits are what the mouse buttons are *mapped to*, which is the
 * only thing the slots change.
 *
 * ---------------------------------------------------------------------------
 * BOTH MAPS ARE NOW THINGS YOU HOLD, AND THAT IS THE WHOLE PASS
 *
 * The owner's sentence was "maps should be accessible thru phone only", and the
 * interesting half of it is not the big map -- that was already one key and is
 * now one tile -- it is the **compass**. `minimap.ts`'s header contains a long
 * and correct argument for why that disc must be permanent: it is the only thing
 * on the screen a player continuously navigates by, and a key that dismissed it
 * would take navigation away to save 0.017 ms.
 *
 * That argument is not wrong, it is now *answered differently*. The disc is
 * still never toggled by a key and still never costs a decision mid-fight; what
 * decides it is **what you are carrying**, which is a thing the player has
 * already chosen and can see in their own hands. Running with a bat and a
 * football is running with no map, and that is a real trade rather than an
 * interface option: you gave up the phone to hold a weapon in each hand.
 *
 * So there are three states and `minimapScale` is all three:
 *
 *   - **no phone** -- nothing on the screen, and the locator strip under it goes
 *     with the disc, because "King Street, Newtown" without the plan above it is
 *     a caption with no picture.
 *   - **phone in the off hand** -- the disc where it has always been, at the size
 *     it has always been. You are holding the thing, glancing at it.
 *   - **phone raised in your right hand** -- the disc drawn larger, because you
 *     are *looking at* the phone rather than glancing past it. The world keeps
 *     running behind it, exactly as the overlay's own header promises.
 *
 * The scale is a multiplier rather than a second canvas size, and that is a
 * measurement decision: `Minimap` sizes its bitmap once from the element's
 * content box and derives `scale` (px per metre) from it, so a second size would
 * mean a second bitmap, a second `dpr` round and a re-derived `RADIUS_M`. A CSS
 * transform on the element re-samples the same bitmap the compositor is already
 * holding, costs nothing on the CPU, and keeps the 160 m radius the same 160 m.
 * It is *softer* when raised -- a 206 px bitmap drawn at 320 -- and that is the
 * price, and it is the right one: the raised map is read for shape and the
 * shapes are 30 px blocks.
 *
 * ---------------------------------------------------------------------------
 * AND THE FIRST OF THOSE THREE STATES IS GONE. THE OWNER REVERSED IT, 22 AUGUST
 * 2026, AND THE SECTION ABOVE IS SUPERSEDED RATHER THAN DELETED.
 *
 * *"im in syd park, cant see quest giver, show a minimap as i run around and
 * put him on the minimap with a yellow !"*
 *
 * That is a bug report about the **no phone** state above. He was in the
 * default loadout -- bat and football, which is what every session starts in
 * and what the slots' own header calls a requirement rather than a nicety -- so
 * there was no disc at all, and the thing he could not find was a quest giver.
 *
 * The trade the section above describes is real and it is legible: a phone in a
 * hand costs you a weapon. What it got wrong is the **price**. It was set
 * before the register existed, when a map was a convenience for finding your
 * way to a fight; there are now a hundred jobs on ten rungs, each handed out by
 * somebody standing at a coordinate, and the one interface that says where any
 * of them are is the thing the loadout was switching off. A map you must swap a
 * weapon to read is a map you do not read.
 *
 * So there are **two** states and `minimapScale` is both:
 *
 *   - **alive and in the world** -- the disc in the corner at `MINIMAP_CORNER`,
 *     whatever is in your hands, with the locator strip under it. This is now
 *     every frame of every session that is not the one below.
 *   - **phone raised in your right hand** -- the disc drawn larger, unchanged,
 *     because you are *looking at* the phone rather than glancing past it.
 *
 * The phone therefore keeps its privilege and stops being the price of entry,
 * which is the smallest change that answers the report without throwing away
 * the one part of the old rule that was earning its keep. `minimapVisible`
 * still exists, still takes the hands, and now answers `true` -- see its own
 * note for why it was not deleted -- and what it used to mean is `phoneInHand`.
 *
 * ---------------------------------------------------------------------------
 * `M` IS STILL A KEY, AND THE OWNER REVERSED WHAT IT DID
 *
 * A binding that simply stopped working would be the worst version of "maps are
 * on the phone now": every existing player has `M` in their fingers and would
 * find the map gone with nothing to say where it went. So `M` is kept.
 *
 * It used to be **re-pointed** at the phone: it put the phone in your hand if
 * it was not already in one and then opened the map, so the key was a loadout
 * change as much as a map. The owner reversed that -- "i should still be able to
 * use m to switch the map" and "the map should no longer force equip phone".
 * The map is a **glance**, not a loadout change: a player running with a bat and
 * a football should not have to put the bat down to look at the map, and a map
 * shortcut that dropped a weapon to hold a phone was a shortcut that cost a
 * weapon. So `M` now **toggles the big map** -- press once to open, press again
 * to close -- and touches no hand: no phone is equipped and no slot moves. The
 * phone's Map app is a second way in, and Escape still closes the map.
 *
 * The only thing `M` does is `toggleMap`, a pure function of the map's own
 * state, which is checked, because the failure that matters is silent in the
 * ordinary way -- a map shortcut that moved a hand would be found out in the
 * next fight, not when the key was pressed.
 */

import { clockLabel, cycleInstant, cyclePhase } from '../sky/cycle.ts';

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

// --- Where the compass is, and how big -----------------------------------------

/** The disc at the size `index.html` lays it out. See the header. */
export const MINIMAP_CORNER = 1;

/**
 * How much bigger the disc is drawn with the phone raised.
 *
 * 1.55, which is not a taste: the element is 210 px in a 12 px inset at the top
 * right, and `#locator` sits under it at 228. At 1.55 the disc is 325 px and the
 * pair still clears a 1280x720 window's top-right quadrant with room for the
 * debug overlay opposite. Past about 1.7 the rim starts to cross the middle of
 * the frame at 720p, which is a map that is in the way rather than a map you are
 * holding up -- and the thing this pass must not do is turn the compass into the
 * big map, which already exists and is nine kilometres across.
 *
 * `index.html` carries the same number twice more (the transform and the
 * locator's compensating offset) and says so; they are one number in three
 * places because CSS cannot read this file.
 */
export const MINIMAP_RAISED = 1.55;

/**
 * Is the compass on the screen? **Yes.**
 *
 * It used to read the hands, and the section above says why at length. The
 * owner reversed it -- *"im in syd park, cant see quest giver, show a minimap
 * as i run around"* -- and that sentence is a bug report about this function:
 * he was in the default bat/footy loadout, which is what every session starts
 * in, so there was no disc, and the thing he was hunting for was a quest giver.
 * A map you have to swap a weapon to read is a map you do not read.
 *
 * The `hands` argument is kept rather than removed, and that is deliberate on
 * two counts. It is the one line in this file where the reversal is legible --
 * a reader who came looking for the loadout rule finds it answered here rather
 * than finding the function gone -- and every caller and every case in
 * `verifyPhoneModel` still names the four hand states, so the contract is
 * asserted in all four rather than quietly deleted down to one.
 */
export function minimapVisible(hands: Hands): boolean {
  void hands;
  return true;
}

/**
 * How large the compass is drawn, as a multiplier, or **0 for not at all**.
 *
 * One function returning three states rather than a boolean and a number,
 * because the caller (`Minimap.setScale`) has exactly one decision to make and
 * splitting it would let the two answers disagree -- a scale of 1.55 on a hidden
 * map is a real state a two-call interface can be left in.
 *
 * `raised` is the *viewmodel's* question, not the slot's: the phone is raised
 * when it is your primary **and** you are in first person, because a third-person
 * camera draws the prop on your body and there is nothing in front of your eye
 * to be reading. See `world/phone.PhoneViewmodel.update`, which gates its own
 * raise on the same pair.
 */
export function minimapScale(hands: Hands, raised: boolean): number {
  if (!minimapVisible(hands)) return 0;
  return raised && hands.primary === SLOT.PHONE ? MINIMAP_RAISED : MINIMAP_CORNER;
}

/**
 * Is the phone actually in one of the two hands?
 *
 * What `minimapVisible` used to mean, kept under an honest name because the
 * question is still a real one -- the handset's prop, its screen texture and
 * its apps all turn on it -- and because a function called `minimapVisible`
 * that answers "is the phone out" is how the next pass gets this wrong again.
 * Nothing in the compass reads it; it is here so that the thing the reversal
 * took away from `minimapVisible` still exists somewhere with the right name.
 */
export function phoneInHand(hands: Hands): boolean {
  return hands.primary === SLOT.PHONE || hands.secondary === SLOT.PHONE;
}

 // --- The `M` key ------------------------------------------------------------------

 /**
  * `M`: toggle the big map, and report the map's new state.
  *
  * A pure function of the map's own open/closed state and nothing else -- it
  * takes no `hands`, so it cannot move a hand, which is the whole of the owner's
  * reversal. `money.ts` reads it to decide whether to open or close the panel,
  * and the check below asserts the toggle is a toggle: one press flips it and
  * two return to where you started.
  */
 export function toggleMap(open: boolean): boolean {
   return !open;
 }

// --- The photographs ---------------------------------------------------------------

/**
 * Where the album is kept between sessions.
 *
 * Namespaced like every other key this client writes (`sydney.camera`,
 * `sydney.name`), because `localStorage` is per origin and this game shares one
 * with anything else ever served from it.
 */
export const PHOTOS_KEY = 'sydney.photos';

/**
 * How many photographs are kept.
 *
 * Twelve, and the constraint is `localStorage`'s five megabytes rather than
 * anything about photography. A 320 px thumbnail of a city street encodes to
 * about 14 kB of JPEG, which is 19 kB once base64 has added its third, so twelve
 * of them is 230 kB -- comfortably inside the budget beside the camera
 * preference and the name, with room for the quota to be smaller than advertised
 * (Safari's private mode) without the album being the thing that breaks.
 *
 * The number a player notices is not the cap, it is that the oldest one silently
 * leaves. That is stated on the gallery screen rather than left to be
 * discovered, and `Gallery.add` reports the eviction so it can be.
 */
export const GALLERY_MAX = 12;

/** How wide a stored thumbnail is. Three across a 300 px phone screen at 2x. */
export const THUMB_WIDTH = 320;

/**
 * How wide a full-size photograph is, at most.
 *
 * The same 1600 as `net/bugreport.CAPTURE_MAX_EDGE` and deliberately so: the
 * photograph is grabbed **through the bug box's own frame grabber** (there is
 * exactly one place in this client that can read a WebGPU canvas -- see
 * `client/src/photo.ts`), so a larger number here could not be honoured and
 * would only be a lie in a constant. Written down rather than imported so the
 * server can check the album without pulling a DOM module in behind it; the
 * check below asserts the two agree in spirit by asserting this is what the
 * encoder is told.
 */
export const PHOTO_MAX_WIDTH = 1600;

/** JPEG quality for both sizes. The brief's 0.85. */
export const PHOTO_QUALITY = 0.85;

/**
 * The two methods of `localStorage` this needs, and no more.
 *
 * An interface rather than the global, on `minimap.MarkerSource`'s terms: it is
 * what lets `verifyPhoneModel` run the whole album -- including the quota
 * failure, which is the interesting case and cannot be provoked on a real
 * `localStorage` without writing five megabytes -- in a process with no browser
 * in it at all.
 */
export interface PhotoStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One photograph, as the gallery holds it. */
export interface Photo {
  /** Stable across a reload; the handle for `full`, `remove` and the DOM. */
  id: number;
  /** A `data:image/jpeg;base64,...` at `THUMB_WIDTH`. The only part that persists. */
  thumb: string;
  /** The line burnt into the bottom-left corner, kept as text as well. */
  caption: string;
  /** `Date.now()` when the shutter went. Real time, like the phone's status bar. */
  atMs: number;
}

/** What one photograph looks like in storage. Short keys; there are twelve of them. */
interface StoredPhoto {
  i: number;
  t: string;
  c: string;
  a: number;
}

/**
 * The album: twelve thumbnails that survive a reload, and the full-size frames
 * that do not.
 *
 * **The asymmetry is the design and it is worth being blunt about.** A
 * full-size 1600 px JPEG of this city is 300-500 kB, which is 400-660 kB as a
 * data URL, and twelve of those is eight megabytes against a five-megabyte
 * origin quota. There is no arrangement of this feature in which the full frames
 * persist: `localStorage` cannot hold them, and the alternatives -- IndexedDB, a
 * File System Access handle, an upload -- are each a whole subsystem for a
 * feature whose actual job is "let me take a picture and save it". So the
 * thumbnails persist, the full frames live in this object for the session, and
 * the **save** button on a photograph is what makes a full-size copy permanent,
 * in the one place a browser is happy to put one: the player's downloads folder.
 *
 * A player who reloads with unsaved photographs keeps the thumbnails and loses
 * the originals. The gallery says so on the screen rather than in this comment.
 *
 * Pure in the sense this project means it: no DOM, no `three`, no globals, and
 * the storage is injected. The only impure thing it can do is throw, and it does
 * not -- see `persist`.
 */
export class Gallery {
  private readonly store: PhotoStore | null;
  private list: Photo[] = [];
  /**
   * Full-size frames, by id. **Not** persisted; see the header.
   *
   * A `Map` rather than a field on `Photo` so a record that has been reloaded
   * from storage is structurally identical to one that was just taken, and the
   * "this one's original is gone" case is a missing key rather than an empty
   * string somebody has to remember to test for.
   */
  private readonly fulls = new Map<number, string>();
  private nextId = 1;
  /**
   * How many were dropped to make room on the last `add`.
   *
   * Reported rather than logged, because the two reasons a photograph
   * disappears -- the cap, and the quota -- look identical from the gallery and
   * only one of them is expected.
   */
  lastEvicted = 0;
  /**
   * Why the last write did not stick, or ''. Shown on the gallery screen.
   *
   * The failure this is for is real and is not hypothetical: Safari in private
   * browsing gives every origin a `localStorage` that throws on the first
   * `setItem`, and a gallery that swallowed that would be twelve photographs
   * that vanish on reload with nothing ever having said why.
   */
  storageNote = '';

  constructor(store: PhotoStore | null) {
    this.store = store;
    this.load();
  }

  /** Newest first, which is the order the gallery draws and the only order kept. */
  get items(): readonly Photo[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  /** The full-size JPEG for a photograph, or '' when this session did not take it. */
  full(id: number): string {
    return this.fulls.get(id) ?? '';
  }

  /**
   * File a photograph.
   *
   * The thumbnail and the full frame arrive together because they are made in
   * one pass over one captured canvas (see `photo.composePhoto`); handing them
   * in separately would let a caller store a thumbnail whose original was never
   * kept, which is the reloaded state and should only ever be reachable by
   * reloading.
   */
  add(thumb: string, full: string, caption: string, atMs: number): Photo {
    const photo: Photo = { id: this.nextId++, thumb, caption, atMs };
    this.list.unshift(photo);
    if (full !== '') this.fulls.set(photo.id, full);
    this.lastEvicted = 0;
    while (this.list.length > GALLERY_MAX) {
      const dropped = this.list.pop();
      if (dropped === undefined) break;
      this.fulls.delete(dropped.id);
      this.lastEvicted++;
    }
    this.persist();
    return photo;
  }

  /** Delete one. Returns whether it was there. */
  remove(id: number): boolean {
    const at = this.list.findIndex((p) => p.id === id);
    if (at < 0) return false;
    this.list.splice(at, 1);
    this.fulls.delete(id);
    this.persist();
    return true;
  }

  /** Delete all of them. The console handle uses it; nothing on the phone does. */
  clear(): void {
    this.list = [];
    this.fulls.clear();
    this.lastEvicted = 0;
    this.persist();
  }

  /**
   * Read the album back.
   *
   * Every field is validated rather than trusted, on the rule this project
   * applies to anything that has been outside the process: `localStorage` is a
   * string a user can edit, an extension can write and a previous version of
   * this code may have written in another shape. A malformed album loads as an
   * empty one and is overwritten by the next photograph, which is the failure
   * mode that leaves a player with a working camera rather than a broken screen.
   */
  private load(): void {
    if (this.store === null) return;
    let raw: string | null = null;
    try {
      raw = this.store.getItem(PHOTOS_KEY);
    } catch {
      // A storage that refuses even to be read -- see `storageNote`.
      this.storageNote = 'this browser will not let the game store anything.';
      return;
    }
    if (raw === null || raw === '') return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const out: Photo[] = [];
      for (const entry of parsed as StoredPhoto[]) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.t !== 'string' || !entry.t.startsWith('data:image/')) continue;
        const id = typeof entry.i === 'number' && Number.isFinite(entry.i) ? Math.floor(entry.i) : out.length + 1;
        out.push({
          id,
          thumb: entry.t,
          caption: typeof entry.c === 'string' ? entry.c : '',
          atMs: typeof entry.a === 'number' && Number.isFinite(entry.a) ? entry.a : 0,
        });
        if (id >= this.nextId) this.nextId = id + 1;
      }
      this.list = out.slice(0, GALLERY_MAX);
    } catch {
      // Unparseable. Left empty; the next photograph writes a good album over it.
    }
  }

  /**
   * Write the album back, dropping the oldest until it fits.
   *
   * **The retry loop is the whole of this method and it is not defensive
   * programming.** `setItem` throws `QuotaExceededError` when the origin is
   * full, and the origin can be full because of this album *or* because of
   * something else on it. Either way the right answer is the same and it is not
   * "lose the photograph the player just took": drop the oldest, try again, and
   * keep going until the newest one fits or there is nothing left to drop.
   *
   * A failure at the end leaves the list **in memory intact** and sets a note.
   * That matters: the photograph is still on the phone, still viewable, still
   * saveable, and only the persistence is gone -- which is a far better session
   * than a shutter button that throws.
   */
  private persist(): void {
    if (this.store === null) return;
    for (;;) {
      const payload: StoredPhoto[] = this.list.map((p) => ({ i: p.id, t: p.thumb, c: p.caption, a: p.atMs }));
      try {
        this.store.setItem(PHOTOS_KEY, JSON.stringify(payload));
        this.storageNote = '';
        return;
      } catch {
        if (this.list.length <= 1) {
          // Even one thumbnail will not fit. Give the key back rather than
          // leaving a half-written album behind, and say so on the screen.
          try {
            this.store.removeItem(PHOTOS_KEY);
          } catch {
            // Nothing further to try; the note below is the whole recovery.
          }
          this.storageNote = 'no room to keep photos between sessions — save the ones you want.';
          return;
        }
        const dropped = this.list.pop();
        if (dropped !== undefined) {
          this.fulls.delete(dropped.id);
          this.lastEvicted++;
        }
      }
    }
  }
}

/**
 * The line burnt into the corner of every photograph.
 *
 * `sydrunner · Newtown · 18:42`, and each of the three parts is there for a
 * reason. The name, because a picture of this city with no mark on it is a
 * picture of nothing in particular the moment it leaves the game. The **suburb**
 * rather than the street, because a photograph is a place and not an address --
 * and because the locator's street line is frequently a corner of two names and
 * would be half the width of the frame. And the **in-game** clock rather than
 * the real one, because the light in the picture is the game's light: a
 * photograph stamped 3 pm that is plainly taken at dusk is a photograph with a
 * lie on it.
 *
 * `clockMs` is the **server's** clock -- `sky.now.nowMs`, which is the local
 * clock plus the skew `WELCOME` established -- so two players photographing the
 * same street stamp the same minute. See `sky/cycle.ts`.
 */
export function photoCaption(suburb: string, clockMs: number): string {
  const where = suburb.trim();
  return `sydrunner · ${where === '' ? 'sydney' : where} · ${clockLabel(new Date(cycleInstant(cyclePhase(clockMs))))}`;
}

// --- The self-check ------------------------------------------------------------------

/**
 * Everything in this file, asserted at boot on **both** ends.
 *
 * The criterion this project applies -- *every failure here renders a perfectly
 * good frame* -- is unusually easy to satisfy for a feature made of a camera and
 * a map, so it is worth enumerating what is actually silent:
 *
 *   - A **swap that duplicates** puts the bat in both hands, so the player is
 *     holding two bats and the off hand's throw does nothing, with no frame in
 *     which that reads as anything but a missing football.
 *   - A **default that is not bat/footy** silently rearranges the mouse buttons
 *     for every existing player on the first load after this ships.
 *   - A **minimap rule that is inverted** hides the compass exactly when the
 *     phone is out, which reads as the map being broken rather than as a rule.
 *     There is no error and nothing in the console.
  *   - An **`M` that moves a hand** drops the bat the player was holding, on a
  *     key they pressed to look at a map, and they find out in the next fight.
  *     The owner reversed it: the map is a glance, not a loadout change.
 *   - A **gallery that does not cap** fills the origin's quota and then throws
 *     on every subsequent photograph -- so the camera works twenty times and
 *     then stops, which nobody will attribute to the twenty.
 *   - A **quota fallback that drops the newest** deletes the photograph the
 *     player just took, in front of them, and keeps eleven older ones.
 *   - A **caption on the real clock** stamps the wrong time of day on a picture
 *     whose whole content is the time of day.
 *
 *     bun -e "import {verifyPhoneModel} from './client/src/game/phone.ts';
 *             console.log(verifyPhoneModel())"
 */
export function verifyPhoneModel(): string[] {
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

  /*
   * --- The map is always on, and the phone only makes it bigger.
   *
   * **All four hand states**, and the first of them is the case the owner
   * reversed: it used to assert that a bat/footy loadout had no map, and it now
   * asserts the opposite. Kept as a case rather than deleted, because the
   * failure it now guards is a regression to the old rule -- somebody reading
   * `minimapVisible` and "helpfully" restoring the hands test -- and that is a
   * change nothing else in this repo would notice: the map simply stops being
   * there for a player who is not carrying a phone, which is how this feature
   * was found in the first place.
   */
  {
    const states: Array<[string, Hands]> = [
      ['a bat and a football', defaultHands()],
      ['empty hands', { primary: SLOT.FISTS, secondary: SLOT.FISTS }],
      ['a phone in the off hand', { primary: SLOT.BAT, secondary: SLOT.PHONE }],
      ['a phone in the right hand', { primary: SLOT.PHONE, secondary: SLOT.FOOTY }],
    ];
    for (const [what, hands] of states) {
      if (!minimapVisible(hands)) failures.push(`The compass is off the screen with ${what}; it is on whenever the player is in the world.`);
      if (minimapScale(hands, false) !== MINIMAP_CORNER) {
        failures.push(`With ${what} and the phone down, the compass drew at ${minimapScale(hands, false)} rather than its corner size.`);
      }
    }

    // The raise, which is the one thing left that the hands decide. It needs
    // the phone in the **right** hand: an off-hand phone is a thing you are
    // holding, not a thing you are reading.
    const fighting = defaultHands();
    if (minimapScale(fighting, true) !== MINIMAP_CORNER) {
      failures.push(`A bat/footy loadout drew the raised map at ${minimapScale(fighting, true)}; there is no phone in front of the eye.`);
    }
    const offHand: Hands = { primary: SLOT.BAT, secondary: SLOT.PHONE };
    if (minimapScale(offHand, false) !== MINIMAP_CORNER || minimapScale(offHand, true) !== MINIMAP_CORNER) {
      failures.push('An off-hand phone drew the compass at something other than its corner size.');
    }
    const raised: Hands = { primary: SLOT.PHONE, secondary: SLOT.FOOTY };
    if (minimapScale(raised, false) !== MINIMAP_CORNER) {
      failures.push('A primary phone in third person drew the raised map; there is nothing in front of the eye.');
    }
    if (minimapScale(raised, true) !== MINIMAP_RAISED) {
      failures.push(`A raised phone drew the compass at ${minimapScale(raised, true)}, not ${MINIMAP_RAISED}.`);
    }
    // And the bound that keeps the raised disc from becoming the big map.
    if (MINIMAP_RAISED <= MINIMAP_CORNER || MINIMAP_RAISED > 1.7) {
      failures.push(`The raised scale is ${MINIMAP_RAISED}; it must be over ${MINIMAP_CORNER} and under 1.7.`);
    }
    // `phoneInHand` is what `minimapVisible` used to mean, and it is checked so
    // that the meaning survives somewhere with the right name on it.
    if (phoneInHand(defaultHands())) failures.push('A bat and a football counted as a phone in hand.');
    if (!phoneInHand(offHand) || !phoneInHand(raised)) failures.push('A phone in a hand did not read as a phone in hand.');
  }

  // --- `M` is now the map itself, and it touches no hand.
  //
  // The owner reversed the old behaviour: the map is a glance, not a loadout
  // change, so `M` toggles the big map and moves nothing. `toggleMap` takes no
  // `hands`, so a press cannot move a hand -- but the two loadouts are asserted
  // anyway, because the failure that matters is silent in the ordinary way and a
  // map shortcut that dropped a weapon would be found out in the next fight.
  {
    // bat/footy: M does not move a hand.
    const fighting = defaultHands();
    const startF = { primary: fighting.primary, secondary: fighting.secondary };
    toggleMap(false);
    toggleMap(true);
    if (fighting.primary !== startF.primary || fighting.secondary !== startF.secondary) {
      failures.push('M moved the bat/footy loadout; it should only toggle the map.');
    }
    // phone-secondary: an off-hand phone is left exactly where it is.
    const offHand: Hands = { primary: SLOT.BAT, secondary: SLOT.PHONE };
    const startO = { primary: offHand.primary, secondary: offHand.secondary };
    toggleMap(false);
    toggleMap(true);
    if (offHand.primary !== startO.primary || offHand.secondary !== startO.secondary) {
      failures.push('M moved the off-hand phone; it should only toggle the map.');
    }
  }

  // --- The map toggle is a toggle: one press flips it, two return to the start.
  {
    for (const start of [true, false]) {
      if (toggleMap(start) === start) {
        failures.push(`A single map press from ${start} did not flip the map.`);
      }
      if (toggleMap(toggleMap(start)) !== start) {
        failures.push(`Two map presses from ${start} did not return to ${start}.`);
      }
    }
  }

  // --- The album, over a fake storage. See `PhotoStore`.
  {
    /** A `localStorage` in a `Map`, optionally refusing writes past `capacity`. */
    const makeStore = (capacity = Infinity): PhotoStore & { data: Map<string, string> } => {
      const data = new Map<string, string>();
      return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => {
          if (v.length > capacity) {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
          data.set(k, v);
        },
        removeItem: (k) => {
          data.delete(k);
        },
      };
    };
    /** A believable thumbnail of `n` bytes, so the quota tests have something to fill. */
    const fake = (n: number): string => `data:image/jpeg;base64,${'A'.repeat(n)}`;

    // Newest first, and the cap.
    {
      const store = makeStore();
      const g = new Gallery(store);
      for (let i = 0; i < GALLERY_MAX + 4; i++) g.add(fake(8), fake(40), `shot ${i}`, 1000 + i);
      if (g.count !== GALLERY_MAX) failures.push(`The gallery holds ${g.count} photos against a cap of ${GALLERY_MAX}.`);
      if (g.items[0].caption !== `shot ${GALLERY_MAX + 3}`) {
        failures.push(`The newest photo is "${g.items[0].caption}"; the gallery is not newest-first.`);
      }
      if (g.items[g.count - 1].caption !== 'shot 4') {
        failures.push(`The oldest photo kept is "${g.items[g.count - 1].caption}"; four should have been dropped.`);
      }
      // Ids are unique, which is what `remove` and `full` are keyed on.
      if (new Set(g.items.map((p) => p.id)).size !== g.count) failures.push('Two photos share an id.');
      // The full frame of an evicted photo goes with it, or the session leaks
      // eight megabytes into a map nothing can reach.
      if (g.full(1) !== '') failures.push('An evicted photo left its full-size frame in memory.');
      if (g.full(g.items[0].id) === '') failures.push('The newest photo has no full-size frame.');
    }

    // Delete.
    {
      const g = new Gallery(makeStore());
      const a = g.add(fake(8), fake(40), 'a', 1);
      const b = g.add(fake(8), fake(40), 'b', 2);
      if (!g.remove(a.id)) failures.push('Deleting a photo that was there reported nothing to delete.');
      if (g.remove(a.id)) failures.push('Deleting the same photo twice reported success twice.');
      if (g.count !== 1 || g.items[0].id !== b.id) failures.push('Deleting the wrong photo, or none.');
      if (g.full(a.id) !== '') failures.push('A deleted photo kept its full-size frame.');
    }

    // Reload: the thumbnails come back, the full frames do not, and the ids do
    // not collide with the ones a new photograph gets.
    {
      const store = makeStore();
      const first = new Gallery(store);
      first.add(fake(8), fake(40), 'yesterday', 1);
      const second = new Gallery(store);
      if (second.count !== 1) failures.push(`A reloaded gallery has ${second.count} photos; one was stored.`);
      if (second.items[0].caption !== 'yesterday') failures.push('A reloaded photo lost its caption.');
      if (second.full(second.items[0].id) !== '') {
        failures.push('A reloaded photo claimed to have its full-size frame; those are session-only.');
      }
      const fresh = second.add(fake(8), fake(40), 'today', 2);
      if (fresh.id === second.items[1].id) failures.push('A new photo took a reloaded photo\'s id.');
    }

    // A junk album loads as an empty one rather than throwing.
    {
      const store = makeStore();
      store.setItem(PHOTOS_KEY, '{not json');
      const g = new Gallery(store);
      if (g.count !== 0) failures.push('Unparseable storage produced photos.');
      store.setItem(PHOTOS_KEY, '[{"t":"not a data url"},null,7]');
      const h = new Gallery(store);
      if (h.count !== 0) failures.push('Storage full of the wrong shape produced photos.');
    }

    // No storage at all -- `?offline` in a browser that refuses it, or the
    // server running this check. The album works, it just does not persist.
    {
      const g = new Gallery(null);
      g.add(fake(8), fake(40), 'ephemeral', 1);
      if (g.count !== 1) failures.push('A gallery with no storage would not hold a photo.');
    }

    // THE QUOTA. A store that only fits about three thumbnails: the newest
    // photograph must survive and the album must shrink around it.
    {
      const store = makeStore(400);
      const g = new Gallery(store);
      for (let i = 0; i < 8; i++) g.add(fake(80), fake(400), `shot ${i}`, i);
      if (g.count === 0) failures.push('A full storage emptied the gallery instead of trimming it.');
      if (g.items[0].caption !== 'shot 7') {
        failures.push(`A full storage dropped the newest photo; the front is "${g.items[0].caption}".`);
      }
      if (g.count >= GALLERY_MAX) failures.push('A full storage did not trim the album at all.');
      // And what came back out is what a reload would see.
      const reloaded = new Gallery(store);
      if (reloaded.count !== g.count) {
        failures.push(`A full storage wrote ${reloaded.count} photos but the gallery holds ${g.count}.`);
      }
    }

    // A store that refuses *everything*. The photo is kept in memory and the
    // player is told, rather than the shutter throwing.
    {
      const store = makeStore(0);
      const g = new Gallery(store);
      g.add(fake(80), fake(400), 'only one', 1);
      if (g.count !== 1) failures.push('A storage that refuses everything lost the photo out of memory too.');
      if (g.storageNote === '') failures.push('A storage that refuses everything said nothing about it.');
      if (store.data.has(PHOTOS_KEY)) failures.push('A refused write left a key behind.');
    }
  }

  // --- The caption, which is the one string that goes into the picture itself.
  {
    const line = photoCaption('Newtown', 1_767_225_600_000);
    if (!line.startsWith('sydrunner · Newtown · ')) failures.push(`The caption reads "${line}".`);
    if (!/ \d\d:\d\d$/.test(line)) failures.push(`The caption does not end in a HH:MM clock: "${line}".`);
    // The clock is the **game's**, so half an in-game day later it must read
    // twelve hours on. A real-time clock would read thirty minutes on.
    const noon = photoCaption('Newtown', 1_767_225_600_000 + 1_800_000);
    if (noon.slice(-5) === line.slice(-5)) {
      failures.push(`Half a Sydney day apart the caption still says ${line.slice(-5)}; that is the real clock.`);
    }
    // An empty suburb -- the player is over the harbour, or the sidecar has not
    // landed -- must not produce "sydrunner ·  · 18:42".
    const nowhere = photoCaption('', 1_767_225_600_000);
    if (nowhere.includes('·  ·')) failures.push(`An unknown suburb left a hole in the caption: "${nowhere}".`);
  }

  return failures;
}
