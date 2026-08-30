/**
 * HUD and debug overlay.
 *
 * Deliberately plain. Spec section 8.2 wants health as corner pips and no
 * world-space health bars; this is the scaffolding for that plus the diagnostics
 * needed while the world pipeline is still being tuned.
 */

// The one place a balance becomes text. See `game/cash.formatMoney` for why
// it is not `Intl.NumberFormat`.
import { formatMoney } from './game/cash.ts';
// The two team names and their two colours, from the one file they are spelt
// in. Workstream V; see `game/teams.ts`, whose `verifyTeams` is what makes
// drawing `TEAM_NAME[team]` rather than a literal a rule with a check behind it.
import { TEAM, TEAM_COLOUR, TEAM_NAME, type Team } from './game/teams.ts';

// The level line and the XP bar's width, both of them pure. This file cannot be
// imported outside a browser -- it reaches for `document` in a field
// initialiser -- so every string and every number it draws that is worth
// asserting lives one module away and is checked on both ends. Same arrangement
// `formatMoney` above is here under. See `game/levelhud.ts`.
import { levelLine, xpBarWidth } from './game/levelhud.ts';
import type { Vector3 } from 'three/webgpu';
import type { SolarPosition } from './sky/solar.ts';
import { type RosterEntry } from './net/protocol.ts';

/**
 * What `Hud.level` is handed: the four facts drawn on one line about one player.
 *
 * `team` and `unspent` are part of *this* record rather than a second
 * `hud.team(...)` call, and that is the decision worth recording: they are drawn
 * on the same line, they move on the same events, and two setters writing one
 * line is two setters that disagree for a frame -- which here would be a chip
 * saying Marita over a sentence saying level 1 in a week where the reset has
 * just cleared both.
 */
export interface LevelHudState {
  level: number;
  kills: number;
  /** No account. Changes the sentence, not the chip. See `game/levelhud.levelLine`. */
  guest: boolean;
  /** `game/teams.TEAM.*`. `NONE` collapses the chip. */
  team: Team;
  /** Points earned and not yet spent. 0 draws nothing at all. */
  unspent: number;
}

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
    /**
     * Tiles whose last load failed transiently and which are waiting on a
     * backoff. **Not a death sentence** -- see `TileStreamer.tilePhase`. This
     * used to be a set nothing ever emptied, and a non-zero here meant that
     * much of the city was solid and invisible for the rest of the session.
     */
    failed: number;
    /** Seconds to the soonest of those retries; `Infinity` when none is due. */
    nextRetryS: number;
    /**
     * Tiles the build does not contain: a 404 or 410, suppressed for the
     * session. A **build defect** rather than a streaming state, which is why
     * it is a number of its own -- one of these with collision resident is an
     * invisible wall that will never draw itself.
     */
    missing: number;
    /**
     * Tiles whose prisms went out with their geometry, this session.
     *
     * The counter for the second half of the invisible-wall fix. It should
     * climb steadily as the player crosses the city and leaves tiles behind;
     * one that stays at zero over a long walk means collision is accumulating
     * for the session again and every return trip is a guaranteed block of
     * solid, invisible city. See `TileStreamer.setCollisionSink`.
     */
    collisionEvicted: number;
    /**
     * Evictions that had to keep the prisms because the tile was inside the
     * safety radius. Should read zero forever; see `parityHolds`.
     */
    collisionHeld: number;
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
  traffic: {
    drawn: number;
    parked: number;
    costMs: number;
    tiles: number;
    liveried: number;
    /**
     * Cars inside the near field drawn as real 3D models rather than boxes, and
     * what the assignment sweep that decided it cost.
     *
     * `sweepMs` is on the overlay beside the traffic's own `costMs` because it
     * is the budget that feature was scoped against (0.5 ms) and because the two
     * are the same trade seen from both ends: the sweep runs at 5 Hz precisely
     * so that it does not join `costMs` in the per-frame column.
     */
    modelled: number;
    sweepMs: number;
  };
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
  /**
   * The illegal raves, on the same line as the three ambient systems above it.
   *
   * `costMs` is the number the feature is judged on. The rest is here for a
   * reason none of the others need: **a rave that is not there is the correct
   * answer almost every night.** Six sites are live across 448 on any given
   * night, so "I walked to Sydney Park and there was nothing" is usually the
   * design working and is occasionally the draw being broken, and nothing inside
   * the game can tell those two apart. `drawn` says how many are in range at
   * all and `nearest` names the one the mixer is playing, which between them
   * answer it. See `game/rave.ts` section 3.
   */
  raves?: {
    drawn: number;
    beams: number;
    attendees: number;
    rigged: number;
    costMs: number;
    tracks: number;
    nearest: { name: string; metres: number; stage: string; deck: string; bpm: number; into: number } | null;
  };
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
   * build. `structures` used to be a second, permanent class -- deck and viaduct
   * volumes whose soffit is over your head and which `CollisionWorld.resolve`
   * treated as solid to the ground -- and it is not a defect any more:
   * `resolve` tests a body's band against `[base, top)`, so those volumes are
   * walked under. The field stays as the *count of them the maps have measured*,
   * which is the tripwire for the way that regresses: a zero here while the
   * player stands under a viaduct means nothing is being marked
   * `Prism.structural`, and every deck in the city is solid to the ground again.
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
    /**
     * How far in the past remotes are drawn, and how often the buffer ran dry.
     * See `net/interpdelay.ts`.
     *
     * These are the two numbers that say whether *other people* look right, and
     * nothing else here answers that: `ping` is a round trip and says nothing
     * about whether packets arrive evenly, and a remote freezing for 80 ms on a
     * 40 ms ping is the ordinary complaint. `interpMs` is what the client
     * decided it needed; `starved` is how often it decided too late, and a count
     * that climbs while you play is a symptom with no other tell.
     */
    interpMs: number;
    starved: number;
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
  /**
   * The condition of the car being driven, as a width and a band -- or null for
   * anybody on foot, which collapses the row.
   *
   * **A width and a class rather than a number**, which is deliberate and is
   * `ballBlockWidth`'s lesson applied before the bug rather than after it: the
   * two are computed by pure functions in `world/drivencars.ts`
   * (`carHealthWidth`, `carHealthClass`) that `verifyDrivenCars` asserts at
   * boot, so the DOM write in this file has no arithmetic in it at all. The
   * failure that function exists to prevent -- a bar painted at 1 % by a
   * mispredicted frame and never repainted -- is exactly available here, because
   * a crash is predicted by the driver's client and corrected by the next
   * `MSG.CARS`.
   *
   * Under the speed readout, which is the `DRIVING - 79 km/h` chip in `effects`
   * above it: the brief asked for it there, and the reason it is right is that a
   * bar with no label is only legible next to the thing it is about.
   */
  carHealth: { width: string; band: string } | null;
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
  /** The car's condition, under the bars. Hidden unless somebody is driving. */
  private readonly carBar = document.getElementById('carhealth')!;
  private readonly effects = document.getElementById('effects')!;
  /**
   * The dollar balance, above the pips. See `money`.
   *
   * Non-null-asserted like every other element here, which is this class's
   * standing bet that `index.html` and this file ship together.
   */
  private readonly moneyEl = document.getElementById('money')!;
  /**
   * `LVL 1 · 3/10` and its XP bar, under the balance. See `level`.
   *
   * Three elements rather than one because the row is a line of text over a
   * progress track now, and the track's fill has to be addressable on its own:
   * `#level` is the block that collapses, `#level-text` is the sentence, and
   * `#level-xp i` is the width that moves. Same non-null-asserted bet the rest
   * of this class makes that `index.html` and this file ship together.
   */
  private readonly levelEl = document.getElementById('level')!;
  /**
   * The sentence, the side and the nudge -- three spans inside `#level-text`
   * rather than one, since workstream V.
   *
   * `#level-line` is what `levelLine` writes and is unchanged; `#level-team` is
   * the coloured chip and `#level-spend` is *"· 2 to spend"*. Split because the
   * chip carries a *background colour* that the sentence must not, and because
   * `client/src/teams.ts` binds a click to the last two and a click target has
   * to be an element. Non-null-asserted on the same bet the rest of this file
   * makes about `index.html`.
   */
  private readonly levelLine = document.getElementById('level-line')!;
  private readonly levelTeam = document.getElementById('level-team')!;
  private readonly levelSpend = document.getElementById('level-spend')!;
  private readonly levelBarFill = document.getElementById('level-xp')!.firstElementChild as HTMLElement;
  private readonly ko = document.getElementById('ko')!;
  private readonly investigationEl = document.getElementById('investigation')!;
  private readonly investigationReason = document.getElementById('investigation-reason')!;
  private readonly investigationCount = document.getElementById('investigation-count')!;
  private readonly board = document.getElementById('leaderboard')!;
  private readonly boardRows = document.getElementById('leaderboard-rows')!;
  /**
   * The join panel, which this class no longer *drives* -- only hides.
   *
   * Everything about what is in it (the two tabs, the availability check, the
   * password fields, the logged-in line) belongs to `client/src/accounts.ts`,
   * because it is a conversation with the server rather than a readout of the
   * game and because it has to be reachable a second time from the Escape panel.
   * What is left here is the one thing the HUD legitimately has an opinion
   * about: a fatal error must be able to take it off the screen. See `fatal`.
   */
  private readonly prompt = document.getElementById('nameprompt')!;
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

  /**
   * WORKSTREAM AJ: what the loading screen is waiting for, in words.
   *
   * The markup ships one static line -- "Starting renderer…" -- and until this
   * existed that was the entire content of the screen for its whole life,
   * whether that was half a second or twenty. The screen now stays up until the
   * ground under the spawn is drawn (see `world/ground-first.ts`), which is a
   * wait with a *number* in it, and a wait with a number that shows a spinner
   * instead is a wait the player cannot tell from a hang.
   *
   * Refused once anything else has claimed this line, and both claimants matter.
   * `ready` is the ordinary one: the reveal is driven by a poll and a poll has a
   * frame of latency, so without the lock a tick landing after the curtain went
   * up would write "laying the ground" into a hidden element and leave it there
   * for the fatal handler to show later. `fatal` is the one that would actually
   * hurt: the gate polls every frame and the boot's error is written once, so
   * the very next tick would paint over the only explanation the player is ever
   * going to get.
   */
  loadingProgress(message: string): void {
    if (this.loadingLocked) return;
    if (this.loadingText.textContent === message) return;
    this.loadingText.textContent = message;
  }

  /**
   * Whether the loading line has been claimed by `ready` or `fatal`.
   *
   * One flag for the two, because what it guards is the element rather than
   * either event, and a progress poll must lose to both. Never cleared: neither
   * of those two states is left.
   */
  private loadingLocked = false;

  /**
   * A fatal error the player can actually do something about.
   *
   * `fatal` is for a build that cannot run: a missing self-check, an atlas too
   * big for the GPU, no WebGPU at all. Nothing the player does will change any
   * of those, so it correctly offers nothing to press. A lost graphics device is
   * the opposite -- the page is fine, the account is fine, and a reload fixes it
   * completely -- so it gets the same overlay with a way out attached.
   *
   * The button is created once and reused, because this can fire twice: a device
   * can be lost while the reload the first loss armed is still waiting for the
   * player to come back to the tab. See `devicelost.ts`.
   */
  recoverable(message: string, label: string, onAction: () => void): void {
    this.fatal(message);
    if (this.actionButton === null) {
      const b = document.createElement('button');
      b.id = 'loading-action';
      b.type = 'button';
      this.loadingText.insertAdjacentElement('afterend', b);
      this.actionButton = b;
    }
    this.actionButton.textContent = label;
    this.actionButton.onclick = onAction;
    this.actionButton.style.display = '';
  }

  /** The button `recoverable` shows, made once. */
  private actionButton: HTMLButtonElement | null = null;

  fatal(message: string): void {
    this.loadingLocked = true;
    this.loading.classList.remove('hidden');
    this.loadingText.textContent = message;
    this.loadingText.classList.add('error');
    // The prompt is the one thing in this interface drawn *over* the loading
    // screen, so it is also the one thing that can hide a fatal error. A player
    // typing a name into a build that has already failed to start is the least
    // useful state this client can be in.
    this.hideJoin();
  }

  // --- The join panel -----------------------------------------------------------

  /**
   * Take the join panel off the screen.
   *
   * The only thing this class does to that panel, and it exists for one caller:
   * `fatal`. The prompt is drawn *over* the loading screen, so it is also the
   * one element that can hide a fatal error -- and a player typing a handle into
   * a build that has already failed to start is the least useful state this
   * client can be in.
   *
   * It used to be a private half of `askName`, which lived here and asked for a
   * name. That method is `client/src/accounts.ts`'s `JoinGate` now: what the
   * panel asks has grown a live availability check and a password, both of which
   * are conversations with the server, and a HUD that held them would be a HUD
   * that knew what a session token was.
   */
  hideJoin(): void {
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
    // The level is in the key as well as in the row. Without it a level-up
    // while the board is held open would not redraw -- the comparison is what
    // makes this cheap, and a field left out of it is a field that goes stale
    // exactly when somebody is looking at it.
    const key = rows.map((r) => `${r.id}:${r.name}:${r.kos}:${r.downs}:${r.ping}:${r.level}:${r.kills}:${r.bot ? 1 : 0}`).join('|') + `#${selfId}`;
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
      // The level column. A dash at level 1 rather than "1", on the ping
      // column's own argument two blocks down: every guest and every bot is
      // level 1, and a column of ones is a column that says nothing. The dash
      // says "no ladder here" and the number says "this many".
      const level = document.createElement('td');
      if (r.level <= 1) {
        level.textContent = '—';
        level.className = 'none';
      } else {
        level.textContent = String(r.level);
      }
      // The XP column: the ladder's own kill count, which is this week's for an
      // account and this session's for a guest. See `RosterEntry.kills`.
      //
      // A **whole number rather than the `3/10` the HUD draws**, and that is a
      // column-width decision rather than an inconsistency: the vitals line is
      // about *this* player and wants the fraction, and a board of sixteen rows
      // wants a sortable number that fits in three characters. A dash at zero,
      // on the ping column's rule two blocks down -- a column of noughts is a
      // column that says nothing.
      const xp = document.createElement('td');
      if (r.kills <= 0) {
        xp.textContent = '—';
        xp.className = 'none';
      } else {
        xp.textContent = String(r.kills);
      }
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
      tr.append(name, level, xp, kos, downs, ping);
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
    this.loadingLocked = true;
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
   * True while the chat composer holds the keyboard. Set by `client/src/chat.ts`.
   *
   * A **field written from outside** rather than another element this class
   * reads, and that is deliberate: the chat box owns its own DOM and its own
   * focus (it is not a HUD readout -- see that file's header), so `Hud` should
   * not know which element it is or what class it wears. What `Hud` owns is the
   * one question everything else asks, which is `typing` below.
   */
  chatTyping = false;

  /**
   * Is a text field holding the keyboard?
   *
   * The name prompt and the chat composer. `main.ts` binds bare letters --
   * `H`, `F`, `L`, `N`, `T`, `M`, `I` -- on `window`, and every one of them is a
   * character somebody may want in a name or a sentence. Both fields stop their
   * own keys reaching that listener already (see `askName` and `ChatBox.onKey`),
   * but that guard is the *focus* being in the input, and a player who has
   * clicked the join button has moved it out. This is the guard that does not
   * depend on where the focus went.
   *
   * It is also what settles **Escape** between the text fields and the panels.
   * `main.ts` returns on this at the top of its keydown listener, above the
   * branch that closes the control list and the map, so whichever text UI has
   * the keyboard handles its own Escape and nothing else in that listener sees
   * the key at all.
   */
  /**
   * The suggestions box's compose fields have the keyboard.
   *
   * A second flag beside `chatTyping` rather than a shared one, and the reason
   * is that they go false at different moments: the chat composer closes when
   * you send, and this stays open with the focus moving between a title, a
   * textarea and a row of vote buttons. One flag written by two owners is one
   * owner clearing it while the other is still typing -- which is every game key
   * live under a half-written sentence.
   *
   * Written by `SuggestionsPanel` through `main.ts`, every frame's worth of
   * focus change. See `client/src/suggestions.ts`.
   */
  suggestTyping = false;

  /**
   * The talents panel has the screen. Workstream V.
   *
   * A third flag beside the two above rather than a shared one, on
   * `suggestTyping`'s argument: they go false at different moments, and this one
   * is not about *typing* at all -- it is a modal overlay with a cursor, whose
   * whole point is that WASD must not walk and `f` must not swing while it is
   * up. It rides in `typing` because that is the one interlock `main.ts`'s
   * keydown listener already returns on, and adding a fourth condition to that
   * line for every panel would be four conditions that drift.
   *
   * Written by `client/src/teams.ts` directly, on open and on close, rather than
   * mirrored every frame from `main.ts` the way `suggestTyping` is. The panel
   * holds this object and there is nothing to sample: the two moments it changes
   * are two function calls.
   */
  talentsOpen = false;

  get typing(): boolean {
    return this.chatTyping || this.suggestTyping || this.talentsOpen || this.prompt.classList.contains('shown');
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

    // --- The car's condition, under the bars and under the speed chip.
    //
    // Written from the state every frame with **no arithmetic here at all** --
    // `world/drivencars.carHealthWidth` and `carHealthClass` are pure functions
    // that `verifyDrivenCars` asserts at boot. That split is `ballBlockWidth`'s
    // lesson taken before the bug rather than after it: an inline width outranks
    // every class rule and can only be taken back by another write, so the write
    // must happen every frame and the number in it must be checkable somewhere
    // that is not a running game.
    //
    // Display, not a class, for the collapse: the row has a child so `:empty`
    // cannot reach it, and a bar that reserved its own height while the player
    // was on foot would move the pips up and down every time somebody got out of
    // a car.
    const car = s.carHealth;
    if (car === null) {
      if (this.carBar.style.display !== 'none') this.carBar.style.display = 'none';
    } else {
      if (this.carBar.style.display === 'none') this.carBar.style.display = '';
      if (this.carBar.className !== car.band) this.carBar.className = car.band;
      const fill = this.carBar.firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = car.width;
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
   * `$1,234`, at the top of the vitals block.
   *
   * Called every frame with the balance as it stands, and cheap on `vitals`'
   * own terms: the string is compared before it is written, so the common case
   * -- a balance that has not moved -- is one string compare and no reflow.
   *
   * **Above the pips rather than beside the effects**, which is a layout
   * decision worth a line: the effect chips are a row that appears and
   * disappears, and a number that moved up and down the screen depending on
   * whether you had a Flat White would be a number you have to look for. The
   * balance is the one thing in this cluster that is always there.
   *
   * Hidden entirely at zero **only before the first frame arrives**, which the
   * caller signals by passing `null`: `$0` is a real balance a player can be
   * on (drop everything, spend it all) and blanking it would be the HUD lying
   * about a state the player is in. What must not show is a `$0` during the
   * second before the first `WALLET` lands on an `?offline` session that is
   * never getting one.
   */
  money(balance: number | null): void {
    const text = balance === null ? '' : formatMoney(balance);
    if (text === this.moneyText) return;
    this.moneyText = text;
    this.moneyEl.textContent = text;
  }

  private moneyText = '\u0000';

  /**
   * `LVL 1 · 3/10`, the side, and a thin bar under it, in the vitals cluster
   * beside the balance.
   *
   * **Beside the dollars rather than under the name on the leaderboard alone**,
   * because a level that is only visible when you hold Tab is a level you
   * discover by accident. The two numbers together are what a player has
   * accumulated -- one this session, one this week -- and putting them on one
   * line means the cluster still reads as three groups (what you have, what
   * you are carrying, what you are made of) rather than four.
   *
   * **The level-1 suppression is gone**, and its removal is the whole of the
   * report *"i cant se my level or XP anywhere"*. The paragraph that used to
   * live here argued that every guest and every bot is level 1, so a `lvl 1` on
   * screen would be a permanent label saying nothing about anybody -- which is
   * true of a bare `lvl 1` and is exactly why the line now carries the fraction
   * instead. A player at 3/10 is being told something that changes every thirty
   * seconds. See `game/levelhud.ts`, which owns every character of the string,
   * argues the reversal at length and is checked on both ends.
   *
   * `null` still draws nothing, and that case is now the *only* one: it is
   * `?offline` and the second before the first roster lands, where there is no
   * ladder rather than an empty one.
   *
   * Cheap to call every frame on `money`'s terms exactly: the composed string is
   * compared before anything is written, and the bar's width rides in the same
   * key -- so a frame in which neither the level, the kills nor the guest flag
   * moved is one string comparison and no reflow. The width is *in* the key
   * rather than compared separately so the two can never be written out of
   * step, which would be a bar that disagrees with the number above it.
   */
  level(state: LevelHudState | null): void {
    const text = state === null ? '' : levelLine(state.level, state.kills, state.guest);
    const width = state === null ? '0' : xpBarWidth(state.level, state.kills);
    // The side and the unspent points ride in the same key as the sentence and
    // the bar, on the width's argument exactly: three things that describe one
    // player must be written together or a frame exists where the chip says
    // Marita and the line says level 1. `TEAM_NAME` rather than a literal --
    // `game/teams.ts`'s header is emphatic and this is the HUD it is about.
    const team = state === null ? TEAM.NONE : state.team;
    const spend = state === null || state.unspent <= 0 ? 0 : state.unspent;
    const key = `${text}|${width}|${team}|${spend}`;
    if (key === this.levelText) return;
    this.levelText = key;
    this.levelLine.textContent = text;
    const chip = this.levelTeam;
    const showTeam = text !== '' && team !== TEAM.NONE;
    chip.textContent = showTeam ? TEAM_NAME[team] : '';
    chip.classList.toggle('shown', showTeam);
    if (showTeam) {
      // Inline from the contract rather than a class per team, for the reason
      // `index.html`'s rule says: the colours live in one file and a stylesheet
      // copy of them is a copy that goes stale.
      chip.style.background = TEAM_COLOUR[team].css;
      chip.style.color = TEAM_COLOUR[team].ink;
    }
    // "· 2 to spend", which is the whole of what makes the panel worth
    // reopening. Nothing at all when there is nothing to spend, rather than
    // "· 0 to spend": a permanent zero is a label that says nothing, which is
    // the argument `levelLine`'s own header makes about a bare `lvl 1`.
    this.levelSpend.textContent = spend > 0 ? ` · ${spend} to spend` : '';
    this.levelSpend.classList.toggle('shown', spend > 0);
    // The row is hidden explicitly rather than through `#level:empty`, which is
    // how `#money` next to it collapses: an element with children is never
    // `:empty`, and this one has a label and a bar in it now. One `display`
    // write on the two frames a session where the answer changes.
    const show = text !== '';
    if ((this.levelEl.style.display === 'none') === show) {
      this.levelEl.style.display = show ? '' : 'none';
    }
    this.levelBarFill.style.width = width;
  }

  private levelText = '\u0000';

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

  /**
   * The star row over the banner: `★★☆☆☆`, or nothing at all.
   *
   * **Above the banner rather than replacing it**, which is the whole layout
   * decision here. The banner answers *why* -- "assaulting a bystander" -- and
   * the stars answer *how much*, and they are different questions a player asks
   * at different moments: the reason once, when it appears, and the tier every
   * few seconds for as long as it lasts. Stacking them puts the number that
   * changes above the words that do not, in the column the eye is already on.
   *
   * The same 3x scale the vitals cluster carries, through `--vitals-scale` in
   * `index.html` -- one number, one reason, and the only thing to touch if "3x"
   * is ever "4x". A star row drawn at the banner's own 13 px would be the one
   * element on this HUD that did not get bigger when the player asked for
   * everything to get bigger.
   *
   * Written the way `investigation` above is written and for its reason: the
   * glyph string is compared before it is assigned, so the common case -- a
   * tier holding steady while the countdown runs -- is one string compare and
   * no DOM write at all.
   */
  heat(stars: number): void {
    const n = Math.max(0, Math.min(5, Math.round(stars)));
    const row = n <= 0 ? '' : '★'.repeat(n) + '☆'.repeat(5 - n);
    if (row === this.heatKey) return;
    this.heatKey = row;
    if (row === '') {
      this.heatEl.classList.remove('shown');
      return;
    }
    // `textContent`, never `innerHTML`. The string is built from two literals
    // here and could never be markup -- and a HUD that would render markup if it
    // ever were is a HUD one change away from being a problem. The same rule the
    // banner one method up states.
    this.heatEl.textContent = row;
    this.heatEl.classList.add('shown');
    // The top two rungs get their own class, because at 4 and 5 stars the thing
    // the player needs is not information, it is alarm. See `#heat.hot` in
    // `index.html`.
    this.heatEl.classList.toggle('hot', n >= 4);
  }

  private heatKey = ' ';
  private readonly heatEl = document.getElementById('heat')!;

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
        // "failed" with a countdown, because that is now what it means: a
        // transient failure on a backoff, not a tile written off for the
        // session. The seconds are the whole point of printing it -- a reader
        // who can see the next attempt coming knows to wait rather than reload.
        (s.streamer.failed
          ? `, ${s.streamer.failed} retrying` +
            (Number.isFinite(s.streamer.nextRetryS) ? ` (next in ${Math.ceil(s.streamer.nextRetryS)}s)` : '')
          : '') +
        // And the ones that will never arrive, which is a different sentence
        // and a different audience: the player can do nothing about a tile the
        // pipeline did not emit, and whoever runs the pipeline can.
        (s.streamer.missing ? `, ${s.streamer.missing} not in build` : '') +
        // The collision lifetime, reported beside the geometry's because the
        // entire class of invisible wall this fixes is the two disagreeing.
        // `held` should never appear at all -- see `HudStats.collisionHeld`.
        (s.streamer.collisionEvicted ? `, ${s.streamer.collisionEvicted} collision evicted` : '') +
        (s.streamer.collisionHeld ? `, ${s.streamer.collisionHeld} HELD` : ''),
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
      `near  ${s.traffic.modelled} cars as models, ${s.traffic.sweepMs.toFixed(2)} ms to assign`,
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
      ...(s.raves
        ? [
            `rave  ${s.raves.drawn} in range, ${s.raves.beams} beams, ${s.raves.attendees} dancing ` +
              `(${s.raves.rigged} rigged), ${s.raves.costMs.toFixed(2)} ms` +
              (s.raves.nearest
                ? `\n      ${s.raves.nearest.name} ${s.raves.nearest.metres} m, ${s.raves.nearest.stage}, ` +
                  `"${s.raves.nearest.deck}" ${s.raves.nearest.bpm} bpm @${s.raves.nearest.into}s`
                : `\n      nothing within earshot (${s.raves.tracks} track${s.raves.tracks === 1 ? '' : 's'} in the bag)`),
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
            `${s.net.snaps} snaps` +
            `\n      drawing remotes ${s.net.interpMs.toFixed(0)} ms back` +
            `${s.net.starved > 0 ? `, buffer ran dry ${s.net.starved}x` : ''}`
        : `net   offline — local dummies, local combat`,
      ...(s.feed.length ? ['feed  ' + s.feed.join('\n      ')] : []),
    ].join('\n');
  }
}
