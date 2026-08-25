/**
 * Everything the money feature needs from `main.ts`, in one install call.
 *
 * `main.ts` is 9,400 lines and is the wiring hub; five branches are editing it
 * in this pass. So this workstream's whole footprint there is **one import line
 * and one `installMoney(...)`**, and every decision that could have been a
 * scattered `if` in the frame loop lives here instead. The shape is
 * deliberately the one `game/teleport.ts` and `client/src/chat.ts` already use:
 * a `deps` record of narrow accessors in, a small object of hooks out, and no
 * import of `main.ts` in either direction.
 *
 * What is wired:
 *
 *   - the `$1,234` on the HUD, every frame, from `NetClient`'s wallet mirror;
 *   - the four weapon slots and the number row that picks them;
 *   - the phone -- the handset in your hand, the viewmodel in front of your
 *     eye, and the overlay it opens;
  *   - **both maps**: the big one is the phone's Map app and is also `M`, which
  *     toggles it directly, and the compass is always on the screen -- larger
  *     while the phone is raised in your right hand. Both of those are the owner
  *     reversing an earlier rule: `M` used to equip the phone, and the compass
  *     used to require one in a hand. The map is a glance, not a loadout change.
  *     See `game/phone.ts`, which is where those rules are written and checked;
 *   - **the camera**: the viewfinder, the shutter, and the album on the phone;
 *   - the cash bundles lying in the street, drawn from the wallet frame;
 *   - the Centrelink prompt and the `E` that claims;
 *   - the Centrelink and SydRide markers on both maps;
 *   - and the fare's HUD line.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HOOKS ARE RETURNED RATHER THAN LISTENED FOR
 *
 * This module registers **no** keyboard or mouse listener of its own, and that
 * is the one structural rule it follows. `main.ts`'s keydown handler has an
 * interlock at its very first line -- `if (hud.typing) return` -- that gives the
 * chat composer and the name prompt the keyboard ahead of everything else, and
 * a listener added from here would sit *outside* that interlock and would
 * switch weapon slots while somebody typed "1 more thing" into the chat box.
 * The same argument applies to Escape's ordering, which `main.ts` comments at
 * length.
 *
 * So the hooks are functions `main.ts` calls from inside its own handlers, at
 * the point in the sequence where they belong, and each returns whether it
 * consumed the event.
 *
 * ---------------------------------------------------------------------------
 * `E` IS ALREADY THE BIKE KEY, AND THE TWO DO NOT FIGHT
 *
 * `E` mounts and dismounts a lime e-bike, as a **level bit** the server edges
 * (`protocol.BTN.MOUNT`). Claiming at a Centrelink is an edge handled here, and
 * the two coexist without a mode: a claim is only attempted when the player is
 * standing within six metres of an office *and* is not riding, and the mount
 * bit still goes out on the same press. In the one case where both could fire
 * -- a bike parked on the footpath outside the Redfern office -- the mount wins
 * on the wire and the claim wins on the HUD, which is the honest outcome: you
 * get on the bike and you get your hundred dollars.
 */

import type { Camera, Scene } from 'three/webgpu';
// --- Workstream I: the piles of cash are fanned Australian fifties now.
//
// The three meshes and two geometry constructors this import used to bring in
// built the stubby gold cylinder that stood for a bundle; all of that -- the
// pool, the spin, the placement -- has moved to `world/cashnote.ts`, which is
// one class and one `update` call. Nothing else in this file changed.
import { CashNotePiles, cashNoteWarmupParts } from './world/cashnote.ts';

import type { Capture } from './bugreport.ts';
import type { Hud } from './hud.ts';
import type { NetClient } from './net/client.ts';
import type { MarkerSink } from './minimap.ts';
import type { FareFrame, WalletFrame } from './net/cash.ts';
import type { CharacterActor } from './player/character.ts';
import {
  CENTRELINKS,
  CENTRELINK_PAYMENT,
  formatGameWait,
  formatMoney,
  officeAt,
} from './game/cash.ts';
import {
  Gallery,
  SLOT,
  SLOT_NAME,
  defaultHands,
  minimapScale,
  photoCaption,
  selectSlot,
  toggleMap,
  type PhotoStore,
  type Slot,
} from './game/phone.ts';
import { Phone } from './phone.ts';
import { composePhoto } from './photo.ts';
import { PhoneAssets, PhoneProp, PhoneViewmodel, phoneWarmupParts } from './world/phone.ts';
import type { WarmupPart } from './world/warmup.ts';

/**
 * How far out Centrelink offices are offered to the minimap.
 *
 * 300 m is the brief's. The minimap's own radius is 160 m and its `mark` culls
 * at that radius (see `Minimap.mark`), so in practice the compass shows an
 * office from 160 m and this number decides nothing there -- it is the **big
 * map** that reads all of them, through the same source, at whatever radius its
 * current zoom is asking for. Offering the wider set costs one extra distance
 * test per office per redraw over a table of thirty-one.
 */
const MINIMAP_OFFICE_RADIUS = 300;

/** What `installMoney` needs from `main.ts`. Accessors, never state. */
export interface MoneyDeps {
  hud: Hud;
  /** The camera the viewmodel parents to. `main.ts` has already put it in the scene. */
  camera: Camera;
  /** The scene the cash bundles are added to. */
  scene: Scene;
  /** The local player's own (shadow-layer) body, for the third-person handset. */
  selfActor: CharacterActor;
  /** The live socket, or null offline. Read every frame; may become non-null later. */
  net(): NetClient | null;
  /** Where the player is, world metres. */
  position(): { x: number; y: number; z: number };
  /** The camera's angles, for the viewmodel's sway. */
  angles(): { yaw: number; pitch: number };
  /** Plan speed, m/s, for the bob. */
  speed(): number;
  /** Is the camera at the eye? A third-person camera draws the prop instead. */
  firstPerson(): boolean;
  /** Is the player on a bike? Suppresses the Centrelink prompt; see the header. */
  riding(): boolean;
  /**
   * Open the big map, and close whatever else was covering the screen.
   *
   * **The phone's Map app and the `M` shortcut are the only two callers, and
   * they are now the only two ways into that map at all.** The key used to open
   * it directly from `main.ts`'s keydown listener; that block is gone and this
   * is what replaced it. See `MAPS ARE THINGS YOU HOLD` in `game/phone.ts`.
   */
  openMap(): void;
  /**
   * Open the talents panel. Workstream V; `openMap`'s shape and its reasons.
   *
   * The phone's Talents tile is the only caller. It is `openMap`'s twin in every
   * respect -- a full-screen thing the handset gets out of the way for -- but it
   * deliberately does **not** set `mapFromPhone`'s equivalent: the panel owns its
   * own Escape (it refuses to close before a side is picked, see
   * `client/src/teams.ts`), so there is no back-to-the-phone step for this file
   * to compose.
   */
  openTalents(): void;
  /**
   * WORKSTREAM AK: the Obligations screen's markup. Optional.
   *
   * Threaded through here rather than reached for, on `openTalents`' route one
   * line up and for its reason: this file owns the handset and `main.ts` owns
   * everything the handset shows, so a screen whose content belongs to a third
   * file arrives as a closure like every other one. See `PhoneSource.obligations`.
   */
  obligations?(): string;
  /** QuestBuddy's *take me there*, passed through to the handset. */
  aimAt?(questId: string): void;
  /** Put the big map away. Escape from a map the phone opened; see `keydown`. */
  closeMap(): void;
  /** Is the big map up? Sampled before Escape decides what a press meant. */
  mapVisible(): boolean;
  /**
   * How large the compass should be drawn this frame, or 0 for not at all.
   *
   * A push rather than a pull for `setWeaponVisible`'s reason exactly: it keeps
   * `main.ts`'s frame loop at the one `money.frame(dt)` line it already has,
   * where a predicate would need a second call beside `minimap.update`. The
   * value is `game/phone.minimapScale`, which is where the rule is written and
   * checked.
   */
  setMinimapScale(scale: number): void;
  /**
   * The compass's bitmap, for the handset's screen. Null on a page without one.
   *
   * `Minimap.canvas`. The handset shows the map that is already being drawn
   * rather than a second one -- see `world/phone.PhoneAssets`, which is written
   * about why that is one rasterisation and not two.
   */
  minimapCanvas(): HTMLCanvasElement | null;
  /**
   * Ask the render loop for the next presented frame.
   *
   * `FrameGrabber.request`, the bug box's. There is exactly one thing in this
   * client that can read a WebGPU canvas and this is it -- see
   * `client/src/photo.ts` for the whole argument.
   */
  capture(): Promise<Capture>;
  /** The suburb the locator is showing, or '' before the sidecar lands. */
  suburb(): string;
  /** The **server's** clock, for the photograph's in-game timestamp. */
  clockMs(): number;
  /** Open the bug box with an image already attached. The photo's "share". */
  shareToBugBox(dataUrl: string, note: string): void;
  /** The shutter click. `game/audio.CombatAudio.shutter`. */
  shutter(): void;
  /** `canvas.requestPointerLock()`, from inside a click. See `Phone.setCamera`. */
  lockPointer(): void;
  /** Register a marker source with the minimap, which the big map reads through. */
  addMarkerSource(source: (sink: MarkerSink, cx: number, cz: number, radius: number) => void): void;
  /**
   * Draw (or stop drawing) the bat and football viewmodels this frame.
   *
   * A setter rather than `main.ts` asking, because the block there that owns
   * viewmodel visibility only runs when the camera mode changes -- see the call
   * site. `main.ts` still applies its own `thirdPerson` on top, so this says
   * what the *slots* want and never what the camera does.
   */
  setWeaponVisible(bat: boolean, footy: boolean): void;
}

/** What `main.ts` calls back into. Everything else about this feature is internal. */
export interface MoneyHooks {
  /** Once per rendered frame, after the simulation. */
  frame(dt: number): void;
  /**
   * The shader pipelines this feature draws with, for the boot warm-up.
   *
   * WORKSTREAM AE. `installMoney` runs thousands of lines below the boot
   * stand-in pass, so nothing this file owns could be in that list -- and two of
   * its three objects are built on demand and are therefore not in the scene for
   * the scene pass either. The handset's prop appears on a slot change and a
   * pile of fifties appears when somebody drops one, so both used to compile
   * inside `render` on the frame they were first wanted. `main.ts` puts these
   * stand-ins into the scene pass instead; see `world/warmup.warmupStandins`.
   */
  warmupParts(): WarmupPart[];
  /**
   * A keydown, from inside `main.ts`'s own handler and after its `hud.typing`
   * interlock. Returns true when it consumed the key.
   */
  keydown(code: string, shift: boolean, repeat: boolean): boolean;
  /**
   * A mouse button, from inside `main.ts`'s own handler and after its `locked`
   * guard. Returns true when it consumed the click -- which it does only when
   * the phone is the hand's slot, so the bat and the footy are untouched.
   */
  mousedown(button: number): boolean;
  /** Which of `BTN.PUNCH` / `BTN.THROW` this button maps to, given the slots. */
  isPhoneVisible(): boolean;
  /**
   * Is the viewfinder up?
   *
   * A separate question from `isPhoneVisible`, because the two are never true
   * at once: raising the camera hides the overlay. Exposed so a future caller
   * -- a screenshot key, a cinematic mode -- can tell "the player is composing a
   * shot" from "the player is reading their wallet", which look the same from
   * outside and want opposite things from the interface.
   */
  cameraActive(): boolean;
  /** Put the phone away. `main.ts`'s Escape branch calls this first. */
  closePhone(): void;
  /** The slot in each hand. Read by the phone's own prop logic and by checks. */
  readonly hands: { primary: Slot; secondary: Slot };
  /**
   * Should `main.ts` draw the bat viewmodel this frame, and the football?
   *
   * Two predicates rather than exposing `SLOT` to `main.ts`, so the number row
   * can grow a fifth slot without a second file learning what the numbers mean.
   *
   * The **bat** is drawn only in the right hand and the **football** only in
   * the off hand, which is not a limitation so much as the truth about the two
   * viewmodels that exist: `BatViewmodel` is posed for a fist at the right of
   * the frame and `FootyViewmodel` for a hand at the left, and swapping them
   * would need two more poses rather than a flag. A player who puts the footy
   * in their right hand still throws it on the left button -- the *action*
   * follows the slot, which is the half that matters in a fight -- and sees an
   * empty hand while they do. Stated rather than hidden; closing it is a pose,
   * not a decision.
   */
  showsBat(): boolean;
  showsFooty(): boolean;
  /** A balance movement arrived. Wire this to `NetHandlers.onMoney`. */
  onMoney(note: string, balance: number): void;
  /**
   * The console handle, hung off `sydney.money` by `main.ts`.
   *
   * Every feature in this project has one -- `sydney.panel`, `sydney.bikes`,
   * `sydney.powerups`, `sydney.rail` -- and they exist for the reason
   * `sydney.panel.grab()`'s comment gives: *a thing one person saw once* should
   * be reproducible from a console. For this feature the specific case is the
   * phone, which needs a **pointer** to be operated, and a pointer needs
   * pointer lock to have been released -- so a browser that refuses pointer
   * lock (an iframe without `allow="pointer-lock"`, an automated session)
   * cannot open the phone by any sequence of clicks at all. `sydney.money.open()`
   * is the way in from there.
   */
  readonly debug: {
    open(): void;
    close(): void;
    equip(slot: Slot, hand?: 'primary' | 'secondary'): string;
    /**
     * Take a photograph from the console, with no viewfinder and no click.
     *
     * The camera's own path needs a pointer, a raised phone and a left button,
     * which is three preconditions a headless or embedded session cannot meet --
     * the same argument `open()` above makes about the overlay. This is the way
     * in from there, and it is also how a photograph gets taken while something
     * that would be dismissed by a click is on screen.
     */
    photo(): Promise<string>;
    report(): {
      hands: string[];
      balance: number;
      bundles: number;
      fare: string;
      online: boolean;
      /** How many photographs are in the album, and whether they can be kept. */
      photos: number;
      photoStorage: string;
    };
  };
}

export function installMoney(deps: MoneyDeps): MoneyHooks {
  const hands = defaultHands();

  // --- The handset, in the hand and in front of the eye, with the compass on
  // its screen. See `world/phone.PhoneAssets`.
  const phoneAssets = new PhoneAssets(deps.minimapCanvas());
  const viewmodel = new PhoneViewmodel(phoneAssets);
  deps.camera.add(viewmodel.group);
  // The prop on your own body is created and destroyed with the slot, unlike
  // the bat's, which is never put away. See `PhoneProp`.
  let prop: PhoneProp | null = null;

  /**
   * The album, and the storage it is kept in.
   *
   * `localStorage` is reached through a `try` rather than named directly,
   * because a browser can throw on the *property access* -- not on `setItem`,
   * on `window.localStorage` itself -- when storage is disabled by policy, and
   * an exception here would be an exception in the middle of `installMoney` and
   * therefore no money, no slots and no phone. A null store is a working
   * gallery that does not persist, which `Gallery` is written to handle and
   * `verifyPhoneModel` checks.
   */
  const photoStore = ((): PhotoStore | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const gallery = new Gallery(photoStore);

  /**
   * One photograph at a time.
   *
   * The capture is two awaits deep -- a frame, then an encode -- and a player
   * leaning on the button would otherwise queue a dozen overlapping grabs, each
   * holding a full-size canvas. The dropped presses are not a loss: they were
   * all going to be the same picture.
   */
  let shooting = false;

  /**
   * Take the photograph the viewfinder just asked for.
   *
   * The sound goes first and is not awaited on anything, because a shutter that
   * arrived after the picture would be a shutter that arrived after the moment.
   * Everything after it can fail, and each failure says which one it was: a
   * blank readback is `FrameGrabber`'s own sentence (see `bugreport.ts`, which
   * is written at length about why that check exists), and an encode that throws
   * is a browser without a 2D context or without JPEG.
   */
  async function takePhoto(): Promise<string> {
    if (shooting) return '';
    shooting = true;
    deps.shutter();
    try {
      const shot = await deps.capture();
      if (!shot.ok) {
        deps.hud.notice(shot.why);
        return '';
      }
      const caption = photoCaption(deps.suburb(), deps.clockMs());
      const photo = await composePhoto(shot.dataUrl, caption);
      gallery.add(photo.thumb, photo.full, caption, Date.now());
      phone.photoFiled();
      // The count is in the line because the cap is the one thing about this
      // feature a player has to know and nobody reads a gallery footer until
      // something has already gone missing.
      deps.hud.notice(`photo taken — ${gallery.count} in the gallery`);
      return photo.full;
    } catch (err) {
      deps.hud.notice(`the photo would not save (${String(err).slice(0, 60)})`);
      return '';
    } finally {
      shooting = false;
    }
  }

  const phone = new Phone({
    wallet: () => walletOf(deps),
    fare: () => fareOf(deps),
    position: () => deps.position(),
    online: () => online,
    claim: (officeId) => deps.net()?.claimCentrelink(officeId),
    gallery,
    shoot: () => {
      void takePhoto();
    },
    share: (dataUrl, note) => deps.shareToBugBox(dataUrl, note),
    notice: (text) => deps.hud.notice(text),
    lockPointer: () => deps.lockPointer(),
    setOnline: (on) => {
      // Echoed locally so the button flips on the frame it is pressed. The
      // server has the last word and there is nothing to correct it *with* --
      // `FareJob.online` is not on the wire, deliberately, because the only
      // observable consequence of being online is being offered a fare, which
      // is. So a rejected toggle would show as no fares ever arriving, which is
      // exactly what being offline looks like. See `net/cash.PHONE_OP`.
      online = on;
      deps.net()?.setRideshareOnline(on);
    },
    openMap: () => {
      deps.openMap();
      mapFromPhone = true;
    },
    openTalents: () => deps.openTalents(),
    obligations: () => deps.obligations?.() ?? '',
    aimAt: (questId: string) => deps.aimAt?.(questId),
  });
  let online = false;
  /**
   * Did the phone's Map app open the map that is currently up?
   *
   * The flag is what lets Escape mean *back to the phone* rather than merely
   * *close*: the map is reached **through** the phone, so leaving it lands where
   * it was entered from. `M` does not set it -- `M` toggles the map directly and
   * Escape just closes it -- so this is only the phone's Map app path. It is a
   * flag rather than an assumption because the map is still reachable from
   * `sydney.bigmap.toggle()` on a console, and when it is stale `deps.mapVisible()`
   * is false and the branch is skipped, so a stale true cannot do any harm.
   */
  let mapFromPhone = false;

  // --- Workstream I: the piles of cash in the street.
  //
  // Was a stubby gold cylinder, allocated 48-deep at install and shown or hidden
  // per frame; is now a fanned stack of Australian fifties, on the instruction
  // *"as its ausie make it look like aussie $50s"*. The whole of the geometry,
  // the texture, the pooling and the lift-and-vanish on pickup is
  // `world/cashnote.ts`; this is the one line that owns it.
  //
  // The pool is keyed by bundle id in there rather than by index into the wallet
  // frame, which fixed a bug the cylinder had and nobody had noticed: the
  // server's list *compacts* when somebody collects, so an index-keyed pool
  // teleports every pile after the collected one. See `CashNotePiles`.
  const piles = new CashNotePiles(deps.scene);

  // --- And the compass, put at its corner size before a frame is drawn.
  //
  // `frame` pushes this every frame anyway, so this call is only about the gap
  // between construction and the first one. It used to matter a great deal --
  // the default bat/footy loadout had no map, so without this there was exactly
  // one composited frame showing one -- and now it agrees with where `Minimap`
  // starts, which is laid out at scale 1. Kept because the agreement is a
  // coincidence of two defaults rather than a contract, and because the day
  // somebody gives the compass a third state this is the line that would have
  // been missing.
  deps.setMinimapScale(minimapScale(hands, false));

  // --- The markers, on one source that both maps read. See `Minimap.collect`.
  deps.addMarkerSource((sink, cx, cz, radius) => {
    const reach = Math.max(radius, MINIMAP_OFFICE_RADIUS);
    for (const office of CENTRELINKS) {
      const dx = office.x - cx;
      const dz = office.z - cz;
      if (dx * dx + dz * dz > reach * reach) continue;
      sink.mark(office.x, office.z, 'centrelink');
    }
    const fare = fareOf(deps);
    if (fare.state === 'offered' || fare.state === 'toPickup') {
      sink.mark(fare.px, fare.pz, 'fare-pickup');
      // The dropoff is drawn from the moment the job is offered, because the
      // whole decision a driver makes about a fare is "is that a direction I
      // want to be going" -- and a marker that only appeared after the pickup
      // would answer it too late.
      sink.mark(fare.dx, fare.dz, 'fare-dropoff');
    } else if (fare.state === 'toDropoff') {
      sink.mark(fare.dx, fare.dz, 'fare-pickup');
    }
  });

  // --- The frame.
  //
  // One function, called once, doing five small things in a fixed order: the
  // balance, the bundles, the viewmodel, the Centrelink prompt and the fare
  // line. Every one of them is a compare-then-write, so a frame in which
  // nothing about money has changed costs five comparisons.
  let promptShown = '';
  /**
   * Seconds the pill is held for a **moment** before the state takes it back.
   *
   * Found the hard way, in the first end-to-end run: `hud.derived` is called
   * every frame with the Centrelink prompt, and `derived` writes through to
   * `notice` -- so the "+$100 centrelink" the claim produced was on screen for
   * exactly one frame before the prompt overwrote it with "come back in 6 days
   * 23 h". The player saw the countdown change and was never told they had been
   * paid.
   *
   * Two and a half seconds is long enough to read six words and short enough
   * that the state -- which is the thing that is *true* -- is never withheld for
   * long. It is deliberately a hold on the **derived** line rather than a queue
   * on the notice: a moment beats a state for a moment, and then the state wins
   * again, which is the rule `Hud.derived`'s header sets out.
   */
  const NOTE_HOLD_SECONDS = 2.5;
  let noteHoldT = 0;

  function frame(dt: number): void {
    const net = deps.net();
    const wallet = walletOf(deps);
    const here = deps.position();

    // 1. The balance. Null before the first frame arrives, which draws nothing
    //    -- see `Hud.money` for why `$0` and "no answer yet" must differ.
    deps.hud.money(net !== null && net.status === 'online' ? wallet.balance : null);

    // 2. The piles. One call: `CashNotePiles` owns the meshes, the slow turn and
    //    the lift a collected pile makes on its way out. Nothing about them can
    //    affect the pickup, which is the server's and is a plan distance.
    piles.update(dt, wallet.bundles);

    // 3. The handset, and what the other two hands are holding.
    //
    // The viewmodel poses itself; the prop is created and destroyed by the slot
    // change below. The bat and the football are `main.ts`'s objects and are
    // told once a frame whether the slots want them -- see `setWeaponVisible`
    // for why this is a push rather than a pull.
    deps.setWeaponVisible(hands.primary === SLOT.BAT, hands.secondary === SLOT.FOOTY);
    const angles = deps.angles();
    // `phone.visible`, not the hands: `Q` is what puts it in front of you now.
    syncPhoneProp();
    const raised = phone.visible && deps.firstPerson();
    viewmodel.update(dt, {
      out: phone.visible,
      speed: deps.speed(),
      yaw: angles.yaw,
      pitch: angles.pitch,
      firstPerson: deps.firstPerson(),
    });

    // And the glass, which shows whatever the compass last drew. One boolean
    // write when there is no phone out, which is most frames of most sessions.
    if (prop !== null || raised) phoneAssets.refreshScreen();

    // 3b. And the compass, which is always up and is only *sized* here.
    //
    // The same pair the viewmodel's raise is gated on -- primary and first
    // person -- so the disc grows on exactly the frames the handset comes up in
    // front of the eye, and sits in the corner every other frame of the session.
    // `Minimap.setScale` is a class toggle and a boolean compare when nothing
    // has changed, which is every frame but the two a raise produces. See
    // `game/phone.minimapScale`.
    deps.setMinimapScale(minimapScale(hands, raised));

    // 4. The Centrelink prompt, and the fare line, sharing one pill.
    //
    // Through `hud.derived` rather than `hud.notice`, which is the whole reason
    // `derived` exists: both of these are **states** rather than moments -- you
    // are standing at an office, you are driving to a pickup -- and a `notice`
    // for either would still be on the screen after you walked away. See
    // `Hud.derived`, whose comment is about exactly this bug in the bike pill.
    let prompt = '';
    const office = deps.riding() ? null : officeAt(here.x, here.z);
    if (office !== null) {
      const wait = wallet.centrelinkNextMs;
      prompt = wait > 0
        ? `centrelink: come back in ${formatGameWait(wait)}`
        : `e — claim your centrelink (${formatMoney(CENTRELINK_PAYMENT)})`;
    } else {
      const fare = fareOf(deps);
      if (fare.state === 'offered' || fare.state === 'toPickup') {
        prompt = `fare: pickup ${metresTo(here, fare.px, fare.pz)}`;
      } else if (fare.state === 'toDropoff') {
        prompt = `fare: dropoff ${metresTo(here, fare.dx, fare.dz)} — ${formatMoney(fare.payout)}`;
      }
    }
    if (prompt !== promptShown) promptShown = prompt;
    // See `NOTE_HOLD_SECONDS`: a balance movement owns the pill briefly, and
    // the state takes it back when the hold runs out.
    if (noteHoldT > 0) noteHoldT -= dt;
    else deps.hud.derived(prompt);

    // 5. The phone's own redraw, at its own rate. See `Phone.tick`.
    phone.tick(dt);
  }

  /**
   * Put a slot in a hand and rebuild what that means on the body.
   *
   * The prop is the only thing that has to be *built*: the bat and the football
   * already exist on every actor and are always drawn (see `BatProp`, which
   * argues that a bat is never put away), so what the slots change for those
   * two is which mouse button they answer to and nothing about the scene graph.
   * The phone is the exception, and it is created here and disposed here.
   */
  /**
   * **The phone is not a hand slot any more, and this is the one door it is
   * refused at.**
   *
   * It was `3`, it lived in a hand, and everything about it was a loadout
   * decision: the prop, the viewmodel, the raised compass and the overlay all
   * keyed off `hands.primary === SLOT.PHONE`. That made the map, the wallet and
   * the register cost you your bat -- you put the weapon down to look something
   * up, which is a trade nothing in this game should ask for. `Q` shows it now
   * and your hands never move.
   *
   * `SLOT.PHONE` survives as a constant because it is what `PhoneProp` and
   * `PhoneViewmodel` are keyed on and it is a wire value; what does not survive
   * is any way for a player to put it in a hand. Everything the hands used to
   * decide is decided by `phone.visible` -- see `syncPhoneProp`.
   */
  function equip(slot: Slot, hand: 'primary' | 'secondary'): void {
    if (slot === SLOT.PHONE) return;
    if (!selectSlot(hands, slot, hand)) return;
    handsChanged();
  }

  /**
   * Rebuild what the hands mean, after something has moved them.
   *
   * Split out from `equip` because the number row and the `equip` helper share
   * the consequences and differ only in how they decided. `M` no longer changes
   * hands -- it toggles the map -- so this is called only by the number row.
   */
  /**
   * The handset in the world, which now tracks the overlay rather than a hand.
   *
   * Reconciled once a frame instead of on a slot change, because the thing it
   * follows -- `phone.visible` -- is moved by `Q`, by Escape, by the Map tile
   * and by `close()` from half a dozen places, and a push from each of them is
   * six chances to miss one. Two boolean compares a frame is cheaper than that
   * bookkeeping and cannot drift.
   */
  function syncPhoneProp(): void {
    const want = phone.visible;
    if (want && prop === null) {
      prop = new PhoneProp(phoneAssets, deps.selfActor, 'right');
      prop.castShadowOnly();
    } else if (!want && prop !== null) {
      prop.dispose();
      prop = null;
    }
  }

  function handsChanged(): void {
    // The prop used to be built here, because the phone was a slot and a slot
    // change was the only thing that could move it. It follows the overlay now
    // -- `syncPhoneProp`, once a frame -- so what is left of this function is
    // the notice, and changing weapons neither opens nor closes the phone.
    deps.hud.notice(`${SLOT_NAME[hands.primary]} · ${SLOT_NAME[hands.secondary]}`);
  }

  return {
    frame,
    // The handset and the fifties, on the assets this closure owns -- which is
    // the whole reason it is a method here rather than a line in `main.ts`: the
    // pipeline is keyed on the material *instance*, so a second `PhoneAssets`
    // built to describe this one would warm a pipeline nothing draws. See
    // `world/warmup.WarmupPart`.
    warmupParts: () => [...phoneWarmupParts(phoneAssets), ...cashNoteWarmupParts(piles.assets)],
    keydown(code, shift, repeat) {
      if (repeat) return false;
      // The number row. `Digit1`..`Digit4` rather than `e.key`, so a French
      // keyboard -- where the unshifted digits are letters -- still selects
      // slots by position, which is the same reason every other binding in this
      // project is a `code`.
      const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code);
      if (digit >= 0) {
        // `3` was the phone and is now nothing a hand can hold. It is answered
        // rather than ignored, because a key that used to do something and now
        // silently does not is the worst of the three options -- and the notice
        // is where a player finds out `Q` replaced it.
        if ((digit as Slot) === SLOT.PHONE) {
          deps.hud.notice('the phone is on q now');
          return true;
        }
        equip(digit as Slot, shift ? 'secondary' : 'primary');
        return true;
      }
      /**
       * `M`: the map shortcut, which toggles the big map and touches no hand.
       *
       * **This branch replaced the `KeyM` block in `main.ts`**, which called
       * `bigmap.toggle()` directly. It has to be here rather than there because
       * the key's job is a decision about the panels, and the panels are this
       * module's.
       *
       * It **toggles** rather than only opening, which is the owner's reversal:
       * the map is a glance, not a loadout change, so the key that opened it must
       * be the one that closes it. Press once to open, press again to close, and
       * nothing in the hands moves -- no phone is equipped and no slot changes.
       * `toggleMap` is the checked transition; `deps.openMap` and `deps.closeMap`
       * are what the panel costs. Consumed, so `main.ts` sees nothing.
       */
      if (code === 'KeyM') {
        if (toggleMap(deps.mapVisible())) deps.openMap();
        else deps.closeMap();
        return true;
      }
      /*
       * `Q`: QuestBuddy, and the phone under it. It **toggles** on `KeyM`'s
       * argument exactly -- a log is a glance, so the key that opens it is the
       * one that closes it.
       *
       * It moves no hands, which is the whole of the change that came with it:
       * the phone used to be slot `3` and looking anything up cost you your
       * bat. Nothing is equipped or unequipped here; `syncPhoneProp` sees
       * `phone.visible` go true on the next frame and puts the handset in the
       * player's hand for the look of it.
       */
      if (code === 'KeyQ') {
        if (phone.visible) phone.close();
        else phone.openObligations();
        return true;
      }
      /**
       * Escape: **one step back**, and the ladder is the phone's.
       *
       * Three rungs, tried in the order a player would expect to leave them: a
       * screen inside the phone (a photograph, the gallery, the viewfinder),
       * then the big map, then the phone itself. Only the last of those existed
       * before this pass, when the phone was one screen deep.
       *
       * The middle rung closes the map whenever it is up -- whether `M` opened it
       * or the phone's Map app did. It reopens the phone home only when the
       * phone's Map app opened it (`mapFromPhone`), because then the map was
       * reached **through** the phone and leaving it should land where it was
       * entered from; `M` opened it directly, so leaving it just closes it.
       *
       * `main.ts` calls this before its own Escape branch, which is what keeps
       * the press that leaves the map from also opening the suggestions box.
       */
      if (code === 'Escape') {
        if (phone.goBack()) return true;
        if (deps.mapVisible()) {
          deps.closeMap();
          if (mapFromPhone) {
            mapFromPhone = false;
            phone.setOpen(true);
          }
          return true;
        }
        if (phone.visible) {
          phone.close();
          return true;
        }
        return false;
      }
      // `E` at a Centrelink. Not consumed -- the mount bit still goes out on
      // this press; see the header for why the two can share the key.
      if (code === 'KeyE' && !deps.riding()) {
        const here = deps.position();
        const office = officeAt(here.x, here.z);
        if (office !== null) deps.net()?.claimCentrelink(office.id);
      }
      return false;
    },
    mousedown(button) {
      // The viewfinder takes **both** buttons and gives neither back. Left is
      // the shutter, which is the whole point; right is consumed and does
      // nothing, because a player composing a shot with a football in their off
      // hand would otherwise throw it down the street while framing.
      //
      // `main.ts` has already checked pointer lock before reaching here, which
      // is why the click that re-locks after leaving the phone overlay does not
      // also fire the shutter -- see its `locked` guard, and `Phone.setCamera`
      // for why the viewfinder asks for the lock on the way in.
      if (phone.cameraActive) {
        if (button === 0) phone.shoot();
        return true;
      }
      // The phone answers whichever button its hand is on, so a player who put
      // the phone in the off hand opens it with the right button. Consumed, so
      // `main.ts` does not also arm a swing with it.
      const wantsPhone =
        // **Not the hands any more.** This asked whether the phone was the
        // slot under the button, which was the old "3 then left click" flow and
        // has been unanswerable since the phone stopped being equippable. What
        // it means now is the honest version of what it always meant: while the
        // handset is up, a click belongs to the handset and not to the bat.
        button === 0 && phone.visible;
      if (!wantsPhone) return false;
      return true;
    },
    isPhoneVisible: () => phone.visible,
    cameraActive: () => phone.cameraActive,
    showsBat: () => hands.primary === SLOT.BAT,
    showsFooty: () => hands.secondary === SLOT.FOOTY,
    closePhone: () => phone.close(),
    hands,
    debug: {
      open: () => phone.setOpen(true),
      close: () => phone.close(),
      equip: (slot, hand = 'primary') => {
        equip(slot, hand);
        return `${SLOT_NAME[hands.primary]} · ${SLOT_NAME[hands.secondary]}`;
      },
      photo: () => takePhoto(),
      report: () => ({
        hands: [SLOT_NAME[hands.primary], SLOT_NAME[hands.secondary]],
        balance: walletOf(deps).balance,
        bundles: walletOf(deps).bundles.length,
        fare: fareOf(deps).state,
        online,
        photos: gallery.count,
        // Empty when the album is persisting normally, which is the answer to
        // "why did my photos not come back" in one field rather than in a
        // console session.
        photoStorage: photoStore === null ? 'no storage in this browser' : gallery.storageNote,
      }),
    },
    onMoney(note) {
      phone.record(note);
      deps.hud.notice(note);
      noteHoldT = NOTE_HOLD_SECONDS;
    },
  };
}

/**
 * The wallet and the fare as the server last described them, or empty offline.
 *
 * Two module-level constants rather than a fresh object per call, because these
 * are read several times per frame: `?offline` is a whole mode of this game (no
 * socket, no server, the client is the authority) and it must not allocate two
 * records a frame to say that there is no money in it. Nothing mutates them --
 * the only writer of a wallet frame is `NetClient`, into its own.
 */
const OFFLINE_WALLET: WalletFrame = { balance: 0, centrelinkNextMs: -1, note: '', bundles: [] };
const OFFLINE_FARE: FareFrame = { state: 'none', px: 0, pz: 0, dx: 0, dz: 0, offeredMs: 0, payout: 0 };

function walletOf(deps: MoneyDeps): WalletFrame {
  return deps.net()?.wallet ?? OFFLINE_WALLET;
}

function fareOf(deps: MoneyDeps): FareFrame {
  return deps.net()?.fare ?? OFFLINE_FARE;
}

/** "340 m" or "1.2 km", whichever a driver can read at a glance. */
function metresTo(from: { x: number; z: number }, x: number, z: number): string {
  const dx = x - from.x;
  const dz = z - from.z;
  // `Math.sqrt` of a sum rather than `Math.hypot`, on `game/footy.ts`'s rule.
  const d = Math.sqrt(dx * dx + dz * dz);
  return d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
}
