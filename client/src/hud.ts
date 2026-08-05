/**
 * HUD and debug overlay.
 *
 * Deliberately plain. Spec section 8.2 wants health as corner pips and no
 * world-space health bars; this is the scaffolding for that plus the diagnostics
 * needed while the world pipeline is still being tuned.
 */

import type { Vector3 } from 'three/webgpu';
import type { SolarPosition } from './sky/solar.ts';
import { MAX_NAME_CHARS, MIN_NAME_CHARS, sanitiseName, type RosterEntry } from './net/protocol.ts';

export interface HudState {
  /** Median recent frame time in milliseconds. More honest than a frame count. */
  frameMs: number;
  renderScale: number;
  position: Vector3;
  time: Date;
  solar: SolarPosition;
  streamer: {
    resident: number;
    loading: number;
    /**
     * Tiles decoded and queued, waiting on the per-frame construction budget.
     *
     * The number that says whether streaming is keeping up. It should read zero
     * or one: construction retires far faster than 1.6 MB tiles can be fetched.
     * A queue that sits deep for seconds means the budget is too small for this
     * machine -- see `BUILD_BUDGET_MS` in `world/streamer.ts`.
     */
    building: number;
    failed: number;
    triangles: number;
    buildings: number;
    trees: number;
    cars: number;
    poles: number;
    spans: number;
    /** Wheelie bins, street-name posts and signal heads, added together. */
    furniture: number;
    /** Spec 8.3's icons visible, both kinds. Each is three draws; see `world/powerups.ts`. */
    powerups: number;
    /** Ibises resident, and gulls currently in the air. */
    birds: number;
    gulls: number;
    bands: number[];
    casting: number;
    receiving: number;
  };
  /**
   * Slabs in the always-resident far layer.
   *
   * Not part of `streamer` because it is not streamed: it loads once and is
   * never evicted, so unlike every count above it this one does not move. It is
   * reported next to the streamed building count because that comparison is the
   * whole point -- a thousand buildings drawn in full against thirteen thousand
   * drawn as boxes is what the far layer costs and what it buys.
   */
  farSlabs: number;
  /**
   * Triangles in the three hero landmarks, which are neither streamed nor stood
   * in for by anything.
   *
   * Reported beside the far slabs on the same argument and one more of its own:
   * every other count on this line has a fallback -- an unloaded tile has a
   * slab, an evicted slab has a tile -- and this one does not. A zero here is
   * the only thing anywhere in the client that says the harbour has no bridge
   * over it, and without the line it reads as a build that has not finished
   * streaming.
   */
  landmarkTriangles: number;
  /**
   * The moving traffic: cars placed this frame, how long placing them took, and
   * how many tiles' lane graphs are resident.
   *
   * A line of its own rather than a number on the `inst` row, because a moving
   * car is the only instanced thing in the build whose count is a **per-frame
   * CPU cost** rather than a draw cost -- every one of them is a schedule lookup,
   * a quaternion and a matrix compose, every frame. `costMs` is the budget this
   * feature was scoped against and the only place anyone can see it.
   */
  traffic: { drawn: number; parked: number; costMs: number; tiles: number; liveried: number };
  /**
   * The crowd: people posed this frame, how many of them got a real skinned rig,
   * how long the whole thing took, and how many are lying on the footpath.
   *
   * On the overlay for the traffic's reason and one of its own. A pedestrian is
   * a *per-frame CPU cost* rather than a draw cost -- a schedule lookup, a
   * quaternion and three matrix composes each, or a whole skeleton if they are
   * near -- and `costMs` is the 2 ms budget this feature was scoped against and
   * the only place anyone can see it. `rigged` is the number that says whether
   * the LOD is working: if it is pinned at its cap while `drawn` is small,
   * something is holding rigs it should have released. `down` is people actually
   * on the ground right now, not knockdowns remembered -- see
   * `PedestrianField.downCount`, where confusing the two is recorded as the
   * first thing this feature got wrong on this line.
   */
  pedestrians: { drawn: number; rigged: number; costMs: number; down: number; tiles: number };
  /**
   * The police, on the overlay for the reason everything else here is: none of
   * it has a picture of its own.
   *
   * `beats` is officers on a beat within the draw radius and `actors` is the
   * promoted ones -- the two tiers `game/factions.ts` documents -- and the split
   * is the number that says whether the *promotion* is working. Beats climbing
   * with actors pinned at zero during an investigation is the recruit path
   * failing, which from inside the game looks exactly like there being no police
   * in that suburb. `costMs` is the per-frame budget this feature was scoped
   * against, beside the traffic's and the crowd's. `shots` only ever goes up and
   * is the one line that says a hit test fired at all.
   */
  police: { beats: number; actors: number; shots: number; costMs: number; investigations: number };
  /**
   * The street factions, split the same way and for the same reason.
   *
   * `ambient` is loiterers and drinkers within the draw radius and `actors` is
   * the promoted ones, and the split is the line that says whether *aggro* is
   * working: ambient climbing as you walk into Redfern with actors pinned at
   * zero is the sight test failing, which from inside the game is
   * indistinguishable from there being no meth heads there at all.
   */
  street?: { ambient: number; actors: number; costMs: number };
  /**
   * The wildlife, split on the same line as the street factions above it.
   *
   * `ambient` is birds drawn as a pure function of the tick and `actors` is the
   * ones a player has woken, and the split is what says whether *promotion* is
   * working -- which is the one thing about this feature that cannot be seen
   * from inside the game: an ambient turkey and a promoted one are the same
   * bird in the same place until the moment it comes at you, so a wake radius
   * that never fires looks exactly like a park full of very calm turkeys.
   */
  wildlife?: { ambient: number; actors: number; costMs: number };
  collisionBuildings: number;
  /**
   * Invisible walls around the player: collision you are stopped by with nothing
   * drawn where it is. See `world/invisible-walls.ts`.
   *
   * On the overlay because this is the one class of world defect a screenshot
   * cannot contain. A player reports "there's a wall here" and the picture they
   * send is a picture of an empty street -- correct, and useless. `tiles` is how
   * many tiles are currently solid-and-undrawn, which is the streaming gap's own
   * size and should be a small number that keeps returning to zero; a number
   * that sits still while the player stands still is a tile that will never
   * build. `structures` is the permanent class -- deck and viaduct volumes whose
   * soffit is over your head and which `CollisionWorld.resolve` nonetheless
   * treats as solid to the ground -- and that one does not go away.
   */
  phantom?: { tiles: number; walls: number; structures: number; worst: string };
  /**
   * Where the ground is, and what that is in real elevation.
   *
   * World y is metres above the ground at the ENU origin, so most of the city
   * reads as a large negative number and the raw figure alone is unreadable as a
   * height. `datumAhd` is what turns it back into something checkable against a
   * contour map, which is the whole reason terrain has an audit at all.
   * `groundTiles` is how many terrain grids are resident -- the count only ever
   * goes up, because grids are never evicted.
   */
  ground: {
    height: number;
    datumAhd: number;
    tiles: number;
    /**
     * Terrain sidecars the build does not have, and ones a transient failure is
     * waiting to retry.
     *
     * On the overlay because a tile whose ground never arrived is invisible: the
     * player walks across it on the last height they knew, which looks like
     * ground. `missing` climbing means the build is short of `.terr.bin` files;
     * `retrying` climbing means the network is dropping them, which used to be
     * permanent and is what `TerrainField.ensure` was rewritten to survive.
     */
    missing: number;
    retrying: number;
  };
  /**
   * Shadow state, on the overlay because the way this fails is silently.
   *
   * Nothing throws when a shadow map is never built or never has a caster in
   * it -- the scene simply renders with face shading and no occlusion, which
   * looks like a lighting taste question rather than a bug. `map` says whether
   * three has actually allocated and rendered the map; the two counts say
   * whether anything was in it and anything could catch it.
   */
  shadow: { map: boolean; size: number; casting: number; receiving: number };
  /**
   * The fight, on the overlay because the phase machine is invisible.
   *
   * A bat swing is 150 ms of wind-up that looks like an idle if the phase never
   * advanced, and a dummy stuck in `flinch` looks like a dummy standing still.
   * Both are states with no picture of their own, which is this overlay's whole
   * criterion for inclusion.
   */
  combat: { phase: string; health: number; stamina: number; dummies: string };
  /**
   * Spec 8.3, on the overlay for the same reason the fight is: none of it has a
   * picture of its own.
   *
   * A powerup that is *known* but never *resident* is a streaming bug; one that
   * is resident and never taken is a pickup radius bug; and the two multipliers
   * are the numbers that say whether a modifier reached the integrator at all.
   * All three read as "the powerups feel off" and none of them throws.
   */
  powerups: {
    known: number;
    resident: number;
    active: number;
    speed: number;
    damage: number;
  };
  /**
   * The connection, on the overlay for the same reason everything else here is:
   * it has no picture.
   *
   * A client that never connected plays exactly like one that did -- spec 9's
   * local stub is still running underneath -- so "am I online" is unanswerable
   * from the frame. `corrections` and `snaps` are the two numbers that say
   * whether prediction is *working*: a healthy connection produces a slow trickle
   * of sub-centimetre corrections and a snap only when somebody is batted, and
   * a snap count climbing steadily is a client and a server simulating
   * differently, which reads as rubber-banding and has no other symptom.
   */
  net: {
    status: string;
    detail: string;
    players: number;
    ping: number;
    buffer: number;
    corrections: number;
    snaps: number;
    lastCorrection: number;
  } | null;
  /** The last few kills, newest first. See `Hud.kill`. */
  feed: readonly string[];
}

/**
 * The player's own condition, which is the only part of the HUD that is not a
 * diagnostic.
 *
 * Spec 8.2: *"No world-space health bars. Health pips in the corner."* Both
 * halves of that are load-bearing -- the pips are here rather than over a
 * character's head, and there are pips rather than a bar, because three discrete
 * blocks are countable at a glance where a bar at 67% is a thing you have to
 * read. The stamina under it is four blocks for exactly the same reason: what a
 * player needs to know mid-fight is "how many swings have I got", which is an
 * integer.
 */
export interface VitalsState {
  /**
   * Pips remaining, as a **real number** since spec 8.3's damage multipliers
   * arrived. Drawn as its ceiling: 1.6 pips is two blocks, because a player
   * with any part of a pip left is still standing.
   */
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  /** 0..1 through the 2 s refill. Drives the fill inside every spent block. */
  recharge: number;
  /**
   * The footy supply: balls left, how many there are, and 0..1 through the
   * refill -- exactly the stamina bar's three fields, because it is very nearly
   * the stamina bar's shape. See `game/combat.ts`'s ball constants for why the
   * two resources are separate, why this one refills a ball at a time where the
   * stamina refills all at once, and `index.html` for why the colour is not.
   */
  ballCharges: number;
  maxBallCharges: number;
  ballRecharge: number;
  /** Seconds until respawn, or 0 while alive. */
  respawnIn: number;
  /**
   * Spec 8.3's active effects, longest-lived first, as a label and a countdown.
   *
   * A list rather than two named fields so the HUD does not have to know which
   * powerups exist -- it draws what it is given, in the order it is given, which
   * is what stops a third one being a change in two files.
   */
  effects: ReadonlyArray<{ name: string; seconds: number }>;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** How long the first-visit note stays on the front of the hint line. See `Hud.ready`. */
const FIRST_VISIT_NOTE_MS = 45_000;

/**
 * The inline `width` of one block of the footy supply bar: full, filling, or
 * empty. `index` counts from the left, `charges` is how many balls are in hand,
 * `recharge` is 0..1 through the next one.
 *
 * Only the **next** ball's block fills, unlike the stamina bar beside it where
 * every spent block fills together. That is the HUD saying what the rule is: the
 * stamina comes back as one bar and the footy supply comes back one ball at a
 * time, so a bar where all three filled in step would be drawing the wrong
 * mechanic. See `game/combat.ts`'s ball constants.
 *
 * **A block that is already full returns a width rather than deferring to
 * `#balls div.full i`'s 100%**, and that clause is the whole of the fix for "my
 * 3rd footy never loads". An inline style outranks any class rule, so the moment
 * the caller writes a partial width onto a block, `full` can never take it back
 * -- only another write can. The loop this replaced started at `charges` and so
 * had no write to give: with a full bar it ran zero times, and whatever partial
 * width the last block was painted at was frozen there for the rest of the
 * session.
 *
 * Offline that was invisible, because the last width before a block filled was
 * 99.6% and rounded to 100. **Online it was the whole bug.** The client predicts
 * its own recharge and `net/client.reconcile` takes the count from the server,
 * which is a snapshot behind -- so for the 50-150 ms between the two, the client
 * holds a count rolled back by one while `ballT` has already been *consumed* by
 * the regen it predicted. The bar is painted in that window at about 1%, the
 * next snapshot confirms the charge, and the block stuck at 1% for good:
 * present, classed `full`, and drawn a quarter of a pixel wide. The first two
 * blocks escaped it only because a fresh player spawns with a full bar, so no
 * inline width has ever been written to them.
 *
 * Pulled out of `Hud.vitals` and made pure so `verifyHud` below can assert it at
 * boot. The count side of the same bug is `checkBallBar` in
 * `server/integration-check.ts`; it cannot assert this half, because
 * `server/tsconfig.json` has no DOM and importing this file there would trade a
 * real architectural invariant for one check.
 */
export function ballBlockWidth(index: number, charges: number, recharge: number): string {
  if (index < charges) return '100%';
  if (index > charges) return '0';
  return `${Math.round(Math.min(1, Math.max(0, recharge)) * 100)}%`;
}

/**
 * The footy supply bar, painted the way the DOM remembers it.
 *
 * A boot check rather than a comment because the bug this is about shipped, was
 * played for a session, and was reported in the words *"for some reason my 3rd
 * afl ball never loads"* -- and because every other check in the project passed
 * while it was live. The supply was right in `game/combat.ts`, right on the
 * wire, right in the reconciler and right in `Hud.vitals`'s `full` class. Only
 * the width was wrong, and only after a sequence.
 *
 * So `widths` here **persists across frames and is only written where the loop
 * writes**, which is the one property of the DOM that made the failure possible:
 * a block nobody paints keeps what it had. A loop that goes back to starting at
 * `s.ballCharges` cannot paint the block that just filled, and this fails at boot
 * rather than in somebody's game.
 *
 * The sequence is the online one. The client predicts its own recharge; the
 * server's count is a snapshot behind; for 50-150 ms the client holds a count
 * rolled back by one over a `ballT` its predicted regen has already spent, so the
 * bar is painted at 1% -- and then the server confirms and nothing paints it
 * again.
 */
export function verifyHud(maxBallCharges: number): string[] {
  const failures: string[] = [];

  // `Hud.vitals`'s loop, and it has to be this loop: from zero, every block.
  const widths = new Array<string>(maxBallCharges).fill('');
  const paint = (charges: number, recharge: number): void => {
    for (let i = 0; i < widths.length; i++) widths[i] = ballBlockWidth(i, charges, recharge);
  };

  paint(maxBallCharges - 1, 0.99); // the last block, all but full
  paint(maxBallCharges - 1, 0.01); // the reconcile rollback, over a spent clock
  paint(maxBallCharges, 0.01); // the server confirms -- the frame that used to freeze
  if (!widths.every((w) => w === '100%')) {
    failures.push(
      `A full footy bar draws [${widths.join(', ')}] after a reconciliation rollback; every ` +
        `block of a full bar is 100% wide. This is "my 3rd footy never loads": an inline width ` +
        `outranks #balls div.full i, so a block the paint loop skips keeps whatever partial ` +
        `width it was last given.`,
    );
  }

  // The trickle is unchanged by that: one block moves, the ones behind it are
  // full, the ones in front are empty. The other reading -- every spent block
  // filling together, which is what the stamina bar beside it does -- would draw
  // a whole-bar refill over a supply that comes back one ball at a time.
  paint(1, 0.5);
  const filling = widths.filter((w) => w !== '100%' && w !== '0');
  if (widths[0] !== '100%' || filling.length !== 1 || filling[0] !== '50%') {
    failures.push(
      `With one ball in hand and the next half way back, the bar draws ` +
        `[${widths.join(', ')}]; it should be one full block, one at 50%, and the rest empty -- ` +
        `the supply trickles a ball at a time where the stamina bar refills all at once.`,
    );
  }

  // And no block is ever left without a width of its own, at any count -- which
  // is the rule that stops the class from having to win an argument it cannot.
  for (let charges = 0; charges <= maxBallCharges; charges++) {
    for (let i = 0; i < maxBallCharges; i++) {
      if (ballBlockWidth(i, charges, 0.5) === '') {
        failures.push(`Block ${i} of a ${charges}-ball bar was given no width, so its CSS class decides it.`);
      }
    }
  }

  return failures;
}

export class Hud {
  private readonly loading = document.getElementById('loading')!;
  private readonly loadingText = document.getElementById('loading-text')!;
  private readonly debug = document.getElementById('debug')!;
  private readonly hint = document.getElementById('hint')!;
  private readonly help = document.getElementById('help')!;
  private readonly helpFull = document.getElementById('helpfull')!;
  private readonly pips = document.getElementById('pips')!;
  private readonly staminaBar = document.getElementById('stamina')!;
  private readonly ballBar = document.getElementById('balls')!;
  private readonly effects = document.getElementById('effects')!;
  private readonly ko = document.getElementById('ko')!;
  private readonly investigationEl = document.getElementById('investigation')!;
  private readonly investigationReason = document.getElementById('investigation-reason')!;
  private readonly investigationCount = document.getElementById('investigation-count')!;
  private readonly board = document.getElementById('leaderboard')!;
  private readonly boardRows = document.getElementById('leaderboard-rows')!;
  private readonly prompt = document.getElementById('nameprompt')!;
  private readonly promptInput = document.getElementById('nameprompt-input') as HTMLInputElement;
  private readonly promptJoin = document.getElementById('nameprompt-join')!;
  /**
   * Hidden by default (user order): the overlay is developer telemetry, and a
   * player's first screenful should be Sydney, not numbers. `?debug=true` (any
   * case, or a bare `?debug`) shows it from boot; the backquote still toggles
   * it either way, so it stays one keypress away when someone needs to read
   * the numbers off a live session.
   */
  private debugVisible = (() => {
    const v = new URLSearchParams(location.search).get('debug');
    const on = v !== null && v.toLowerCase() !== 'false' && v !== '0';
    // Field initializers run in declaration order and `debug` is declared
    // above, so the element exists; stamping it here keeps the DOM and the
    // flag from ever starting out of agreement.
    this.debug.style.display = on ? '' : 'none';
    return on;
  })();

  /**
   * The blocks, built on first use rather than written into `index.html`.
   *
   * How many there are is `combat.MAX_HEALTH` and `combat.MAX_STAMINA`, and those
   * are gameplay constants. Hard-coding three and four into the markup would put
   * a fourth pip's worth of health one file away from the div that would have to
   * show it.
   */
  private pipEls: HTMLElement[] = [];
  private staminaEls: HTMLElement[] = [];
  private ballEls: HTMLElement[] = [];
  /** One chip per active spec 8.3 effect, rebuilt only when the set changes. */
  private effectEls: HTMLElement[] = [];
  /** What was last written, so a per-frame call is a comparison and not a reflow. */
  private vitalsKey = '';
  private effectsKey = '';

  private gpuErrorShown = false;

  /**
   * Which build is being played, for the debug overlay.
   *
   * It arrives with the index in `ready` and is read every frame by `update`,
   * which is the whole reason it is a field. It used to be the front of the
   * hint line, in front of the controls; the controls are a corner block now
   * (see `index.html`'s `#help`) and the pill is notices-only, so the one part
   * of that line that was a *fact about the world* moved to the panel that is
   * made of those.
   */
  private world = '';

  /**
   * Report a GPU error to the player. Only the first is shown: WebGPU repeats
   * validation errors every frame, and the first one is the one that matters.
   */
  gpuError(message: string): void {
    if (this.gpuErrorShown) return;
    this.gpuErrorShown = true;
    this.fatal(`GPU error -- the scene cannot be drawn:\n\n${message}`);
  }

  /**
   * A transient message that does not stop the game, unlike `fatal`.
   *
   * An empty message empties the pill, and the pill then disappears entirely --
   * `#hint:empty` in `index.html` is what makes that true, and it is why this
   * is now three lines rather than a composition.
   *
   * It used to be a composition because the pill had permanent content under
   * every notice: the controls line, which an empty message had to put back.
   * That distinction was load-bearing while it lasted -- `main.ts` clears the
   * notice the moment the connection settles, about a second and a half into a
   * normal boot, so a `notice('')` that blanked the pill outright cost every
   * online session its controls line a second after being shown it. The
   * controls are `index.html`'s `#help` now, in the other corner, and nothing
   * lives in the pill for a notice to have to restore.
   */
  notice(message: string): void {
    this.hint.textContent = message;
    this.hint.style.opacity = '1';
  }

  /** What `derived` last put in the pill, so it knows what it is allowed to take back. */
  private derivedText = '';

  /**
   * A pill message owned by a **state** rather than by a moment.
   *
   * `notice` is a moment: something happened, the pill says so, and it stays
   * there until something else happens. That is exactly right for "the
   * connection dropped" and it is exactly wrong for anything whose truth has a
   * *duration*, because leaving that state does not run any code -- so nothing
   * takes the message down, and the pill goes on asserting something false for
   * the rest of the session.
   *
   * That is not hypothetical. It is the reported bug: *"I died on bike and saw
   * E to get off bike forever."* `main.ts` posted "E to get off the bike first"
   * with `notice` when a rider clicked, and the only line in the client that
   * cleared it was the `E` dismount branch -- which a player who is knocked out
   * while riding never reaches, because the knockout takes the bike away from
   * three files further down.
   *
   * So this is called **every frame with the truth**, and there is no set and no
   * clear. Pass the message while the state holds; pass `''` and it comes down.
   * A state that ends without anybody noticing still ends, because the next
   * frame asks again. `game/bikes.ridePrompt` is the function that decides the
   * ride's line, and it is a pure function of the riding state for this reason.
   *
   * Two properties make it safe to call at 120 Hz beside `notice`:
   *
   *   - **It is a no-op unless the message changed**, so the DOM is touched on
   *     the two frames a state begins and ends and on no others.
   *   - **It only retracts its own text.** If some other notice has taken the
   *     pill over in the meantime -- a refused pointer lock, a dropped
   *     connection -- this leaves it alone rather than deleting the one message
   *     the player actually needed. `ready`'s first-visit timer makes the same
   *     check for the same reason.
   */
  derived(message: string): void {
    if (message === this.derivedText) return;
    const previous = this.derivedText;
    this.derivedText = message;
    if (message !== '') this.notice(message);
    else if (this.hint.textContent === previous) this.notice('');
  }

  fatal(message: string): void {
    this.loading.classList.remove('hidden');
    this.loadingText.textContent = message;
    this.loadingText.classList.add('error');
    // The prompt is the one thing in this interface drawn *over* the loading
    // screen, so it is also the one thing that can hide a fatal error. A player
    // typing a name into a build that has already failed to start is the least
    // useful state this client can be in.
    this.hideNamePrompt();
  }

  // --- The name prompt --------------------------------------------------------

  /**
   * Ask who is playing, and resolve with what they said.
   *
   * Called once, on the online path only, and **not awaited where it is
   * shown**: `main.ts` puts it up the moment the world is drawable and collects
   * it half a second later when it is ready to open a socket, so the typing
   * happens during the streaming rather than in front of it. That is the whole
   * reason this returns a promise instead of taking a callback -- the two ends
   * of the wait are in different parts of the boot.
   *
   * `suggested` is prefilled rather than placeheld, so Enter on an untouched
   * field is a valid answer and the fastest path into the game is one key. The
   * field is sanitised on the way out with the same function the server will run
   * on arrival (`protocol.sanitiseName`), so what the player sees accepted here
   * is what appears over their head -- and a name that does not survive it falls
   * back to the suggestion rather than being refused, because a modal that
   * argues with you about punctuation is a modal nobody finishes.
   */
  askName(suggested: string): Promise<string> {
    return new Promise((resolve) => {
      this.promptInput.value = suggested;
      this.promptInput.placeholder = suggested;
      // Both the cap and the sentence under the field come from the constants
      // rather than from the markup, so the one place the rule is written is
      // `protocol.ts` and the note cannot go stale against the sanitiser.
      this.promptInput.maxLength = MAX_NAME_CHARS;
      const note = document.getElementById('nameprompt-note');
      if (note) note.textContent = `${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters · enter to join`;
      this.prompt.classList.add('shown');
      // Focus after the class, or the element is still `display: none` and the
      // browser refuses -- silently, leaving a prompt nobody can type into
      // without clicking it first.
      this.promptInput.focus();
      this.promptInput.select();

      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const typed = sanitiseName(this.promptInput.value);
        this.hideNamePrompt();
        this.promptInput.removeEventListener('keydown', onKey);
        this.promptJoin.removeEventListener('click', finish);
        resolve(typed || sanitiseName(suggested));
      };
      const onKey = (e: KeyboardEvent): void => {
        // Stopped as well as defaulted, because `main.ts` binds `Tab` and the
        // backquote on `window` and both are characters somebody may want in a
        // name -- and `Tab` in particular would otherwise open the leaderboard
        // behind the prompt while moving the focus off the field.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish();
        }
      };
      this.promptInput.addEventListener('keydown', onKey);
      this.promptJoin.addEventListener('click', finish);
    });
  }

  private hideNamePrompt(): void {
    this.prompt.classList.remove('shown');
  }

  // --- The leaderboard --------------------------------------------------------

  /**
   * Show or hide the board. Held on `Tab`; see `index.html` for why held.
   *
   * Cheap to call every frame: the class is only touched when it changes, so the
   * keyup path costs a boolean compare rather than a style recalculation.
   */
  setLeaderboard(visible: boolean): void {
    if (visible === this.boardVisible) return;
    this.boardVisible = visible;
    this.board.classList.toggle('shown', visible);
    // The board wins over the control list, and closes it rather than drawing
    // over it. Two panels at once is two panels at once, and of the two this is
    // the one being asked for *now* -- it is held on a key, so the hand making
    // the request is still on it.
    if (visible) this.setHelp(false);
  }

  get leaderboardVisible(): boolean {
    return this.boardVisible;
  }

  private boardVisible = false;
  /** What was last drawn, so a held key is a string compare and not a rebuild. */
  private boardKey = '';

  /**
   * Draw the board. `rows` must already be in the order they are wanted --
   * `protocol.rankRoster` is that order, and it lives there because the
   * integration check has to assert it without a DOM.
   *
   * Rebuilt wholesale when anything changed rather than diffed, on `vitals`'s own
   * argument one panel over: the common case is that nothing changed, which is a
   * string compare, and the uncommon case is at most sixteen rows.
   */
  leaderboard(rows: readonly RosterEntry[], selfId: number): void {
    if (!this.boardVisible) return;
    const key = rows.map((r) => `${r.id}:${r.name}:${r.kos}:${r.downs}:${r.ping}:${r.bot ? 1 : 0}`).join('|') + `#${selfId}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.boardRows.textContent = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.id === selfId) tr.className = 'self';
      else if (r.bot) tr.className = 'bot';
      const name = document.createElement('td');
      // `textContent`, never `innerHTML`. The string came off the wire from
      // another player: the sanitiser strips the controls that would let it lie
      // about its own width, and this is what stops it being markup.
      name.textContent = r.name || `player ${r.id}`;
      const kos = document.createElement('td');
      kos.textContent = String(r.kos);
      const downs = document.createElement('td');
      downs.textContent = String(r.downs);
      const ping = document.createElement('td');
      // A bot has no socket. A dash says so; "0 ms" would read as the best
      // connection in the game.
      if (r.bot || r.ping <= 0) {
        ping.textContent = '—';
        ping.className = 'none';
      } else {
        ping.textContent = `${r.ping}`;
      }
      tr.append(name, kos, downs, ping);
      this.boardRows.appendChild(tr);
    }
  }

  /**
   * The game is drawable: take the loading screen off, and on a first visit say
   * one sentence about why the next minute is not the game at its best.
   *
   * The controls this used to write are `index.html`'s `#help`, permanently, in
   * the bottom-right corner -- a line of them long enough to hold the whole
   * binding list was a line nobody read, and it lived in the one element that
   * also has to be able to say "the connection dropped". So the pill is
   * transient-only now and this writes to it exactly once: the first-visit
   * sentence, or nothing.
   *
   * Spec 8's HUD voice as before: lowercase, terminal-plain, no punctuation it
   * does not need. What it says is the truth about a cold cache and nothing
   * more -- the world is 350 MB and arrives while you walk, and the shaders are
   * still settling. Both halves are worked on elsewhere (the warm-up compiles
   * the pipelines up front, the build stamp makes a second visit re-use every
   * byte) and neither can make the *first* download instant, which is why this
   * exists at all.
   */
  ready(index: { stage: string; totals: Record<string, number> }, firstVisit = false): void {
    this.loading.classList.add('hidden');
    const t = index.totals;
    this.world = `stage "${index.stage}" · ${(t.buildings ?? 0).toLocaleString()} buildings`;
    // The pill's markup says "loading", so a boot that never reaches this line
    // is not a blank screen with nothing on it. This is where that stops being
    // true, and it is unconditional: on a first visit the pill becomes the note
    // below, and on every other visit it becomes nothing at all and disappears.
    // Writing it only in the `firstVisit` branch would leave "loading" on the
    // screen for the whole of every second session, which is what the first cut
    // of this pass did.
    const note = firstVisit
      ? 'first visit: streaming Sydney (~350 MB) & warming shaders — smooths out in a minute'
      : '';
    this.notice(note);
    if (note) {
      // Cleared on a timer rather than on a load event, because there is no
      // moment the streaming is "done": the city keeps arriving as the player
      // walks, for as long as they walk. Forty-five seconds is the honest span
      // of "the start", and the line has to stop claiming to be news well before
      // it stops being true.
      //
      // Only if the pill is still showing this note. Another `notice` may have
      // taken it over in the meantime -- a refused pointer lock, a dropped
      // connection -- and a timer that blanked the pill regardless would delete
      // the one message the player actually needed to read.
      setTimeout(() => {
        if (this.hint.textContent === note) this.notice('');
      }, FIRST_VISIT_NOTE_MS);
    }
  }

  // --- The controls -----------------------------------------------------------

  /**
   * Show or hide the full control list, and hide the compact block behind it
   * while it is up. See `index.html` for both elements and why `H` toggles this
   * where `Tab` holds the board.
   *
   * Cheap to call from anywhere on the same terms as `setLeaderboard`: the
   * classes are only touched when the state actually changes.
   */
  setHelp(visible: boolean): void {
    if (visible === this.helpOpen) return;
    this.helpOpen = visible;
    this.helpFull.classList.toggle('shown', visible);
    this.help.classList.toggle('hidden', visible);
  }

  toggleHelp(): void {
    this.setHelp(!this.helpOpen);
  }

  get helpVisible(): boolean {
    return this.helpOpen;
  }

  private helpOpen = false;

  /**
   * Is a text field holding the keyboard?
   *
   * Currently the name prompt and nothing else. `main.ts` binds bare letters --
   * `H`, `F`, `L`, `N`, `T`, `M` -- on `window`, and every one of them is a
   * character somebody may want in a name. The prompt's own field stops its
   * keys reaching that listener already (see `askName`), but that guard is the
   * *focus* being in the input, and a player who has clicked the join button
   * has moved it out. This is the guard that does not depend on where the focus
   * went.
   */
  get typing(): boolean {
    return this.prompt.classList.contains('shown');
  }

  setLocked(locked: boolean): void {
    this.hint.style.opacity = locked ? '0' : '1';
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debug.style.display = this.debugVisible ? '' : 'none';
  }

  /**
   * Pips, stamina and the respawn countdown.
   *
   * Called every frame, and cheap by construction: the discrete state is folded
   * into one string and compared, so the common case -- nothing changed -- is a
   * string compare, and the only unconditional writes are the recharge widths and
   * the countdown, which genuinely move every frame while they are running.
   */
  vitals(s: VitalsState): void {
    if (this.pipEls.length !== s.maxHealth) {
      this.pips.textContent = '';
      this.pipEls = Array.from({ length: s.maxHealth }, () => {
        const el = document.createElement('div');
        this.pips.appendChild(el);
        return el;
      });
    }
    if (this.staminaEls.length !== s.maxStamina) {
      this.staminaBar.textContent = '';
      this.staminaEls = Array.from({ length: s.maxStamina }, () => {
        const el = document.createElement('div');
        // The inner element is the fill. Animating a child's width rather than
        // the block's own background means the empty block keeps its outline, so
        // the bar never appears to change length while it recharges.
        el.appendChild(document.createElement('i'));
        this.staminaBar.appendChild(el);
        return el;
      });
    }

    if (this.ballEls.length !== s.maxBallCharges) {
      this.ballBar.textContent = '';
      this.ballEls = Array.from({ length: s.maxBallCharges }, () => {
        const el = document.createElement('div');
        el.appendChild(document.createElement('i'));
        this.ballBar.appendChild(el);
        return el;
      });
    }

    // The ceiling, and the reason it is not a round: spec 8.3's +40% damage
    // leaves a victim on 0.6 pips, and a player with six-tenths of a pip is
    // alive and needs to be told so. `Math.round` would draw an empty bar over
    // a standing figure, which reads as the HUD being broken rather than as the
    // last hit being survivable.
    const pips = Math.max(0, Math.ceil(s.health));
    const key = `${pips}/${s.stamina}/${s.ballCharges}`;
    if (key !== this.vitalsKey) {
      this.vitalsKey = key;
      for (let i = 0; i < this.pipEls.length; i++) {
        const full = i < pips;
        // The last pip is red. It is the only red in the interface apart from a
        // fatal error, and one pip left is the same kind of news.
        this.pipEls[i].className = full ? (pips === 1 ? 'full last' : 'full') : '';
      }
      for (let i = 0; i < this.staminaEls.length; i++) {
        this.staminaEls[i].className = i < s.stamina ? 'full' : '';
      }
      for (let i = 0; i < this.ballEls.length; i++) {
        this.ballEls[i].className = i < s.ballCharges ? 'full' : '';
      }
    }

    // Spent blocks fill together rather than one after another, because spec
    // 8.2's recovery is one 2 s beat and not four staggered ones -- the bar
    // refills all at once and the animation should say so.
    const width = `${Math.round(Math.min(1, Math.max(0, s.recharge)) * 100)}%`;
    for (let i = s.stamina; i < this.staminaEls.length; i++) {
      const fill = this.staminaEls[i].firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = width;
    }
    // The footy supply, from **block zero** every frame. See `ballBlockWidth`
    // for the rule and for why the loop cannot start at `s.ballCharges` the way
    // the stamina loop above starts at `s.stamina`.
    for (let i = 0; i < this.ballEls.length; i++) {
      const fill = this.ballEls[i].firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = ballBlockWidth(i, s.ballCharges, s.ballRecharge);
    }

    // Spec 8.3's active effects, beside the pips.
    //
    // Terminal-plain, like everything else in this file: a bordered label and a
    // whole number of seconds, no icon, no progress ring, no colour beyond the
    // one the rest of the HUD already uses. The countdown is `ceil` rather than
    // one decimal because what a player needs mid-fight is "about ten seconds",
    // and a tenths digit changing six times a second in the corner of the eye
    // is the most distracting thing a HUD can do.
    //
    // Rebuilt only when the *set of labels* changes and re-texted every frame
    // otherwise, which is the same cheap-by-comparison shape `vitals` uses
    // above: the common case is two `textContent` writes on an existing node.
    const wanted = s.effects.map((e) => e.name).join('|');
    if (wanted !== this.effectsKey) {
      this.effectsKey = wanted;
      this.effects.textContent = '';
      this.effectEls = s.effects.map(() => {
        const el = document.createElement('div');
        this.effects.appendChild(el);
        return el;
      });
    }
    for (let i = 0; i < this.effectEls.length; i++) {
      // A chip with no countdown is drawn as a bare label. Spec 8.3's two
      // powerups both expire, so every chip used to be "NAME 12"; the lime
      // e-bike's do not -- a ride lasts until you get off it and the Redfern
      // tuning lasts the session -- and "RIDING 0" is a countdown that has
      // finished, which is the one thing this row must never say about something
      // that is still running.
      const seconds = s.effects[i].seconds;
      this.effectEls[i].textContent =
        seconds > 0 ? `${s.effects[i].name} ${Math.ceil(seconds)}` : s.effects[i].name;
    }

    if (s.respawnIn > 0) {
      this.ko.style.display = '';
      this.ko.textContent = `knocked out\nrespawning in ${s.respawnIn.toFixed(1)}`;
      this.ko.style.whiteSpace = 'pre';
    } else if (this.ko.style.display !== 'none') {
      this.ko.style.display = 'none';
    }
  }

  /**
   * "Under Investigation! {reason} — Ns", or nothing.
   *
   * Called every frame with the state as it stands, and cheap on the same terms
   * `vitals` is: the reason is compared before it is written, so the common case
   * -- a countdown running with the reason unchanged -- is one string compare and
   * one `textContent` write on the number, which genuinely does move.
   *
   * The seconds are `ceil` rather than one decimal, for the reason the powerup
   * chips are: what a player needs while being shot at is "about twenty
   * seconds", and a tenths digit changing six times a second in the middle of
   * the screen is the most distracting thing this interface could do. The last
   * second reads "1" for a whole second and then the banner is gone, which is
   * the correct behaviour -- a banner that showed "0" would be claiming the
   * police are still after you when they have stopped.
   */
  investigation(reason: string, seconds: number): void {
    if (!reason || seconds <= 0) {
      if (this.investigationKey !== '') {
        this.investigationKey = '';
        this.investigationEl.classList.remove('shown');
      }
      return;
    }
    if (reason !== this.investigationKey) {
      this.investigationKey = reason;
      // `textContent`, never `innerHTML`. The string is from a table in
      // `game/factions.ts` today and nothing on the wire carries it -- the
      // reason is a byte, deliberately, see `protocol.encodeInvestigations` --
      // but a HUD that would render markup if it ever were is a HUD one protocol
      // change away from being a problem.
      this.investigationReason.textContent = reason;
      this.investigationEl.classList.add('shown');
    }
    this.investigationCount.textContent = `${Math.ceil(seconds)}s`;
  }

  private investigationKey = '';

  update(s: HudState): void {
    if (!this.debugVisible) return;
    const az = s.solar.azimuth;
    const compass = COMPASS[Math.round(az / 22.5) % 16];
    const time = s.time.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
    });
    const date = s.time.toLocaleDateString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: 'numeric',
      month: 'short',
    });

    // North is -Z in world axes, so the reported metres-north is the negated Z.
    const north = -s.position.z;
    // Report both, with the millisecond figure first: it is the number that
    // says whether there is headroom, and 16.7 ms is the 60 fps budget.
    const fps = s.frameMs > 0 ? 1000 / s.frameMs : 0;
    this.debug.textContent = [
      `${s.frameMs.toFixed(1)} ms/frame (${fps.toFixed(0)} fps)   scale ${(s.renderScale * 100).toFixed(0)}%`,
      `pos   ${s.position.x.toFixed(0)} E, ${north.toFixed(0)} N   (${s.position.y.toFixed(1)} m,` +
        ` ground ${s.ground.height.toFixed(1)} = ${(s.ground.height + s.ground.datumAhd).toFixed(0)} m AHD)`,
      `sun   ${date} ${time}  alt ${s.solar.altitude.toFixed(0)}° az ${az.toFixed(0)}° ${compass}`,
      // Which build this is. It was on the front of the old hint line and it is
      // the one part of that line that was a diagnostic rather than a control,
      // so it came here rather than into `#help` with the rest. Above the tile
      // counts because it is what they are counted out of.
      `world ${this.world}`,
      `tiles ${s.streamer.resident} resident, ${s.streamer.loading} loading` +
        // Only when there is one, because in a healthy session there never is:
        // the construction budget retires tiles faster than they can be
        // fetched, so a persistent number here is the symptom to report.
        (s.streamer.building ? `, ${s.streamer.building} building` : '') +
        (s.streamer.failed ? `, ${s.streamer.failed} failed` : ''),
      `      LOD ${s.streamer.bands.join('/')}  (0-80m / 400m / 2km / far)`,
      `drawn ${(s.streamer.triangles / 1000).toFixed(0)}k tris, ${s.streamer.buildings.toLocaleString()} buildings` +
        `, ${s.farSlabs.toLocaleString()} far slabs` +
        `, ${(s.landmarkTriangles / 1000).toFixed(0)}k landmark`,
      // Every sidecar population is counted separately from the tile triangle
      // figure above, which comes from the index and covers the GLB only. The
      // instances are not in it, so a frame cost that moved with the vegetation,
      // the parked cars or the pole lines would not have shown up anywhere
      // without this line.
      `inst  ${s.streamer.trees.toLocaleString()} trees, ${s.streamer.cars.toLocaleString()} cars,` +
        ` ${s.streamer.poles.toLocaleString()} poles, ${s.streamer.spans.toLocaleString()} spans,` +
        ` ${s.streamer.furniture.toLocaleString()} furniture, ${s.streamer.powerups} powerups`,
      // Separate from the line above because these are the only instances in the
      // build that *move*, so they are the only ones whose count is a CPU cost
      // per frame rather than a draw cost. Ibises are counted resident; only the
      // ones inside 150 m are stepped.
      `life  ${s.streamer.birds} ibises resident, ${s.streamer.gulls} gulls aloft`,
      // `parked` is the schedule cars sitting in a kerb bay between runs, which
      // is where every appearance and disappearance in the fleet now happens --
      // see `game/traffic.ts`. It is on the HUD because it is the one number
      // that says the fix for the pop is still working.
      `traf  ${s.traffic.drawn - s.traffic.parked} cars driving, ${s.traffic.parked} parked, ` +
        `${s.traffic.costMs.toFixed(2)} ms to place, ${s.traffic.tiles} lane tiles` +
        (s.traffic.liveried ? `, ${s.traffic.liveried} marked` : ''),
      `peds  ${s.pedestrians.drawn} walking (${s.pedestrians.rigged} rigged), ` +
        `${s.pedestrians.costMs.toFixed(2)} ms to place, ${s.pedestrians.tiles} footpath tiles` +
        (s.pedestrians.down ? `, ${s.pedestrians.down} down` : ''),
      `cops  ${s.police.beats} on the beat, ${s.police.actors} in pursuit, ` +
        `${s.police.costMs.toFixed(2)} ms` +
        (s.police.investigations ? `, ${s.police.investigations} under investigation` : '') +
        (s.police.shots ? `, ${s.police.shots} shots` : ''),
      ...(s.street
        ? [
            `strt  ${s.street.ambient} loitering, ${s.street.actors} on you, ` +
              `${s.street.costMs.toFixed(2)} ms`,
          ]
        : []),
      ...(s.wildlife
        ? [
            `wild  ${s.wildlife.ambient} birds about, ${s.wildlife.actors} awake, ` +
              `${s.wildlife.costMs.toFixed(2)} ms`,
          ]
        : []),
      `shdw ${s.shadow.map ? `${s.shadow.size}²` : 'NO MAP'}  ` +
        `${s.shadow.casting} casting, ${s.shadow.receiving} receiving`,
      `phys  ${s.collisionBuildings.toLocaleString()} prisms, ${s.ground.tiles} ground grids` +
        (s.ground.missing ? `, ${s.ground.missing} absent` : '') +
        (s.ground.retrying ? `, ${s.ground.retrying} retrying` : '') +
        (s.phantom
          ? `\n      invisible walls: ${s.phantom.tiles} tiles solid+undrawn ` +
            // "seen" rather than a bare count, because it is cumulative: a
            // structure is judged against the terrain once, the first time a map
            // asks about it, and remembered. The live number on that line is the
            // tile count beside it.
            `(${s.phantom.walls.toLocaleString()} walls), ${s.phantom.structures} overhead structures seen` +
            (s.phantom.tiles ? `, worst ${s.phantom.worst}` : '')
          : ''),
      `fight ${s.combat.phase}  ${s.combat.health.toFixed(2)} pips, ${s.combat.stamina} stamina`,
      `      ${s.combat.dummies}`,
      `pwr   ${s.powerups.active}/${s.powerups.resident} up nearby, ${s.powerups.known} known` +
        `   speed x${s.powerups.speed.toFixed(2)}, damage x${s.powerups.damage.toFixed(2)}`,
      s.net
        ? `net   ${s.net.status}${s.net.detail ? ` (${s.net.detail})` : ''}  ` +
            `${s.net.players} in the world, ${s.net.ping.toFixed(0)} ms ping, ` +
            `${s.net.buffer} snapshots buffered` +
            `\n      ${s.net.corrections} corrections (last ${(s.net.lastCorrection * 100).toFixed(1)} cm), ` +
            `${s.net.snaps} snaps`
        : `net   offline — local dummies, local combat`,
      ...(s.feed.length ? ['feed  ' + s.feed.join('\n      ')] : []),
    ].join('\n');
  }
}
