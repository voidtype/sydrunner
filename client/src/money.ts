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
import { CashNotePiles } from './world/cashnote.ts';

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
import { Phone, SLOT, SLOT_NAME, defaultHands, selectSlot, type Slot } from './phone.ts';
import { PhoneAssets, PhoneProp, PhoneViewmodel } from './world/phone.ts';

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
  /** Open the big map. The phone's Map app and nothing else calls this. */
  openMap(): void;
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
    report(): { hands: string[]; balance: number; bundles: number; fare: string; online: boolean };
  };
}

export function installMoney(deps: MoneyDeps): MoneyHooks {
  const hands = defaultHands();

  // --- The handset, in the hand and in front of the eye.
  const phoneAssets = new PhoneAssets();
  const viewmodel = new PhoneViewmodel(phoneAssets);
  deps.camera.add(viewmodel.group);
  // The prop on your own body is created and destroyed with the slot, unlike
  // the bat's, which is never put away. See `PhoneProp`.
  let prop: PhoneProp | null = null;

  const phone = new Phone({
    wallet: () => walletOf(deps),
    fare: () => fareOf(deps),
    position: () => deps.position(),
    online: () => online,
    claim: (officeId) => deps.net()?.claimCentrelink(officeId),
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
    openMap: () => deps.openMap(),
  });
  let online = false;

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
    viewmodel.update(dt, {
      out: hands.primary === SLOT.PHONE,
      speed: deps.speed(),
      yaw: angles.yaw,
      pitch: angles.pitch,
      firstPerson: deps.firstPerson(),
    });

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
  function equip(slot: Slot, hand: 'primary' | 'secondary'): void {
    if (!selectSlot(hands, slot, hand)) return;
    const wantProp = hands.primary === SLOT.PHONE || hands.secondary === SLOT.PHONE;
    if (wantProp && prop === null) {
      prop = new PhoneProp(phoneAssets, deps.selfActor, hands.primary === SLOT.PHONE ? 'right' : 'left');
      // On your own body, so what it contributes is a shadow. The viewmodel is
      // the one you look at. `BatProp.castShadowOnly`'s arrangement exactly.
      prop.castShadowOnly();
    } else if (!wantProp && prop !== null) {
      prop.dispose();
      prop = null;
    } else if (wantProp && prop !== null) {
      // It moved hands: rebuild rather than re-parent, because the hold pose is
      // mirrored and re-parenting would leave the near hand's rotation on the
      // off hand's bone.
      prop.dispose();
      prop = new PhoneProp(phoneAssets, deps.selfActor, hands.primary === SLOT.PHONE ? 'right' : 'left');
      prop.castShadowOnly();
    }
    // Putting the phone away closes what it had open. The reverse is not true:
    // selecting the phone raises it and does **not** open the overlay, because
    // an overlay that appeared on a number key would take the pointer away from
    // a player who was reaching for the footy.
    if (hands.primary !== SLOT.PHONE) phone.close();
    deps.hud.notice(`${SLOT_NAME[hands.primary]} · ${SLOT_NAME[hands.secondary]}`);
  }

  return {
    frame,
    keydown(code, shift, repeat) {
      if (repeat) return false;
      // The number row. `Digit1`..`Digit4` rather than `e.key`, so a French
      // keyboard -- where the unshifted digits are letters -- still selects
      // slots by position, which is the same reason every other binding in this
      // project is a `code`.
      const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code);
      if (digit >= 0) {
        equip(digit as Slot, shift ? 'secondary' : 'primary');
        return true;
      }
      if (code === 'Escape' && phone.visible) {
        phone.close();
        return true;
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
      // The phone answers whichever button its hand is on, so a player who put
      // the phone in the off hand opens it with the right button. Consumed, so
      // `main.ts` does not also arm a swing with it.
      const wantsPhone =
        (button === 0 && hands.primary === SLOT.PHONE) ||
        (button === 2 && hands.secondary === SLOT.PHONE);
      if (!wantsPhone) return false;
      phone.toggle();
      return true;
    },
    isPhoneVisible: () => phone.visible,
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
      report: () => ({
        hands: [SLOT_NAME[hands.primary], SLOT_NAME[hands.secondary]],
        balance: walletOf(deps).balance,
        bundles: walletOf(deps).bundles.length,
        fare: fareOf(deps).state,
        online,
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
