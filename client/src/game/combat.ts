/**
 * The melee attack: phases, hit detection, knockback, knockout and respawn.
 *
 * Spec 8.2 in full, against a local stub, which is the order spec 9's build
 * mandate insists on -- *"asset pipeline -> client renderer -> walkable
 * single-player -> punch and powerups against a local stub"*. The stub is
 * `game/dummies.ts`; this file is the part of it the server is meant to keep.
 *
 * ---------------------------------------------------------------------------
 * The weapon is a **cricket bat**, and the names in this file are not.
 *
 * Spec 8.2 says punch and this module says `punch`, `punched` and `PUNCH_WIND_UP`
 * throughout. On a direct instruction the melee weapon became a bat: it is in
 * every character's right hand (`player/bat.ts`), it is in front of your own eye
 * as a viewmodel, the attack clip is a swing rather than a jab, and `REACH` and
 * `CAST_RADIUS` moved to the numbers a 0.83 m blade justifies.
 *
 * The identifiers did not move with it, and that is a decision rather than an
 * oversight. `punch` is a bit in `net/protocol.ts`'s button table, a field of the
 * input packet `server/sim.ts` decodes and `server/bots.ts` fills, and a member
 * of the events record three call sites in `main.ts` read. Renaming it is a
 * cross-process rename for a word, and the one property a constant shared by two
 * processes must never lose is that both of them spell it the same. What *is*
 * user-facing -- the kill feed, the controls line, the sounds -- says bat.
 *
 * ---------------------------------------------------------------------------
 * Why this file is in `game/` and what that costs.
 *
 * Everything else the player touches lives in `player/`, which is the *client's*
 * view of a person. This is not that. Spec 8.2 says the punch is
 * **server-authoritative with lag compensation**, and spec 10 caps the rewind at
 * 250 ms, so within a few weeks the authority for every line below moves to a
 * process that has no renderer, no camera and no DOM. A module that is going to
 * be lifted wholesale should be in its own directory from the first day rather
 * than extracted from `player/` later, when three files import it and two of
 * them import three.js.
 *
 * The discipline that makes the lift possible is the one `controller.step`
 * already set, and it is worth stating as three rules rather than as a wish:
 *
 *   1. **Every function here is a pure function of explicit state.** Nothing
 *      reads a clock, a keyboard, a camera or a scene graph. `advance()` takes a
 *      fixed `dt`; `hitTest()` takes the attacker and *the list of targets it
 *      should be evaluated against*. That last one is the whole of lag
 *      compensation: a server rewinds remote combatants to the attacker's view
 *      time and passes the rewound array. Nothing in the hit test has to know
 *      that happened, and nothing here needs a single line of netcode today.
 *   2. **Presentation is a return value, never a side effect.** `advance()`
 *      returns which events fired this tick and `applyHit()` returns a report;
 *      screen shake, audio, hitstop animation and the HUD are the *caller's*
 *      problem. The server calls the same two functions and throws the reports
 *      into a snapshot.
 *   3. **The only import from three is `Vector3`**, which is the precedent
 *      `player/controller.ts` set for exactly this reason -- it is a math type,
 *      it drags in no renderer, and a server that never calls `renderer.init()`
 *      pays nothing for it. `player/collision.ts` is imported as a *type* only,
 *      and it is the same decoder the server will load its prisms with; spec 5
 *      is explicit that collision is the pipeline's prism payload on both ends.
 *
 * ---------------------------------------------------------------------------
 * Where a combatant's position lives, and why it is not a field of this state.
 *
 * `CombatantState` embeds a `PlayerState` rather than carrying its own
 * `position`, `yaw` and `pitch`. That is a deliberate departure from the obvious
 * shape and it is the single decision in this file most likely to be questioned,
 * so: two objects that each hold a copy of where a player is have exactly one
 * behaviour, which is to disagree. The disagreement is silent -- the renderer
 * draws one of them and the hit test reads the other -- and it presents as
 * "punches sometimes miss when they clearly connected", which is the most
 * expensive bug in a melee game to chase and the easiest to design out. So the
 * movement state is `c.body`, it is the same object `controller.step` advances,
 * and there is one of it.
 *
 * The convention `body.position` carries is the controller's: it is the **eye**,
 * at `feet + EYE_HEIGHT`. `feetY()` is the one-line conversion, and it is used
 * rather than open-coded because a character mesh's origin is its sole and the
 * capsule's origin is its feet, so the subtraction happens in three places and
 * has to be the same subtraction in all of them.
 *
 * ---------------------------------------------------------------------------
 * The phase machine, and why the hit test fires exactly once.
 *
 * 150 ms wind-up, 100 ms active, 250 ms recovery, straight out of 8.2 and
 * imported from `player/animation.ts` rather than restated, because the clip and
 * the simulation drifting apart is a punch whose animation lands before or after
 * its damage does.
 *
 * The hit test fires on the **first tick of the active window and on no other**.
 * A per-frame test across the 100 ms window is the intuitive reading and it is
 * wrong twice over: it makes damage a function of frame rate (six tests at 60 Hz,
 * fourteen at 144), and under rewind it makes the server evaluate a *different
 * number* of tests than the client predicted, so prediction and authority
 * disagree on any punch that grazes. One test, at a defined instant, is a thing
 * two machines can agree about. It costs the ability to punch someone who walks
 * into the swing 60 ms late, which is not a feature anybody asked for.
 *
 * ---------------------------------------------------------------------------
 * Hitstop is per-combatant, and that is the point.
 *
 * 8.2 asks for "brief hitstop on the attacker". The cheap implementation is a
 * global pause, and it is unshippable the moment there are sixteen players: two
 * people trading punches on George Street would strobe the entire city for
 * everyone in it. So hitstop is `hitstopT` on the two combatants involved, and
 * `advance()` returns early while it is running -- their own tick accumulation
 * is scaled to zero, nobody else's clock is touched, and the server can apply
 * exactly the same rule per player with no notion of a global timescale at all.
 *
 * ---------------------------------------------------------------------------
 * The knockback numbers, measured rather than chosen.
 *
 * 8.2 asks for "6-8 m of flight, not 1 m of stagger". The impulse below is 11
 * m/s horizontal and 5.5 m/s vertical, and what makes those the right numbers is
 * that they are run through `controller.step`'s own gravity (-22.5) and friction
 * (34 on the ground, 1.5 in the air) in `verifyCombat` and the resulting distance
 * asserted. The arithmetic, for a reader who wants to check it: a 5.5 m/s launch
 * against 22.5 m/s^2 is 0.49 s of air, which at 11 m/s carries about 5.1 m; the
 * landing speed of ~10.3 m/s against ground friction then adds ~1.5 m of skid,
 * for a shade under 6.7 m. Both halves matter -- the flight alone is under six
 * metres and would fail the spec, and the skid alone is a stagger.
 *
 * One line of that is load-bearing and easy to miss: `applyHit` sets
 * `onGround = false`. Without it the first tick after the punch runs the
 * *ground* friction rate (34 m/s^2, because the victim was standing a moment
 * ago) against the horizontal impulse and takes 0.57 m/s off it before the
 * victim has left the pavement. It is a metre of flight, and it is invisible.
 *
 * ---------------------------------------------------------------------------
 * The ragdoll is ballistic and the crumple is canned. Deliberately.
 *
 * 8.2 says "ragdoll on knockout, 3 s". What is here is a knocked-out body flying
 * as a **projectile** with `player/animation.ts`'s crumple clip playing over it,
 * sliding to a stop against the same prisms a walking player collides with.
 * There is no constrained-body solver and no per-limb collision, and skipping
 * them is a choice rather than a shortfall:
 *
 *   - A real ragdoll needs a collision representation for a character, and this
 *     project has none -- `collision.ts` is building prisms and nothing else. The
 *     server would need the same solver, bit-exact, or knockouts would desync.
 *   - The failure mode of an articulated ragdoll in a city of terrace houses is
 *     a limb inside a wall, and the fix for that is a whole pass on its own.
 *   - Spec 2 says the characters are "broad and silly". A body that holds one
 *     comic shape through a six-metre arc and lands in a heap is *funnier* than a
 *     physically-plausible flop, for the same reason a cartoon anvil does not
 *     tumble. `animation.clipKnockout`'s header already offered this seam --
 *     "one function of `t` that ends with the figure on the ground and holds" --
 *     and this is the thing it was left for.
 *
 * ---------------------------------------------------------------------------
 * Respawn is "somewhere on the street 25-40 m away", not a corner, and it is
 * honest about the difference.
 *
 * 8.2 says "respawn at a nearby street corner". The client cannot know where a
 * corner is: `pipeline/furniture.py` derives the whole junction network -- three
 * rules, 3,358 candidate points, merged to 2,807 -- and emits none of it, because
 * nothing needed it. So `pickRespawn` samples the annulus instead and takes a
 * point that is clear of every prism with 1.5 m of clearance around it, which in
 * this city means the carriageway, the footpath or a park. The bias toward
 * streets is real rather than hoped for: a terrace's back garden is 4 m wide and
 * fails the clearance cross, and the road is the only continuous open surface in
 * the inner suburbs.
 *
 * The follow-up, stated so it does not have to be rediscovered: `furniture.py`
 * already computes junction centres and the legs that meet at them. A
 * `<tile>.junc.bin` sidecar of (x, z, leg count) would be a few hundred bytes a
 * tile and would turn this into the literal clause, and it is a pipeline change,
 * which this pass is not allowed to make.
 */

import { Vector3 } from 'three/webgpu';

import type { CollisionWorld, MoveResolver } from '../player/collision.ts';
import { createAboardSlot, type AboardSlot } from './riding.ts';
import {
  EYE_HEIGHT,
  GRAVITY,
  PLAYER_RADIUS,
  createPlayerState,
  step,
  type InputSnapshot,
  type PlayerState,
} from '../player/controller.ts';
import {
  FIGURE_HEIGHT,
  PUNCH_ACTIVE,
  PUNCH_RECOVERY,
  PUNCH_TOTAL,
  PUNCH_WIND_UP,
} from '../player/animation.ts';
// Spec 8.3's modifiers. `game/powerups.ts` imports this module back, and the
// note at the top of that file states the one rule that makes the cycle safe:
// neither side reads the other at module-evaluation time.
import {
  advanceModifiers,
  clearPowerups,
  damageScale,
  jumpScale,
  speedScale,
} from './powerups.ts';
// The lime e-bikes. Third leg of the same cycle -- this module imports
// `powerups.ts`, which imports this one -- and it obeys the same rule: nothing
// in `game/bikes.ts` reads a powerup binding until it is called. See
// `bikes.bikeSpeedScale`, where that is the whole reason it is a function.
import { shapeRideInput } from './bikes.ts';
// The wading rule. A pure module with no import of its own -- see its header for
// why the water level reaches both ends of the wire without going over it.
import {
  NO_WATER,
  WADE_BLOCK_DAMPING,
  wadeBlocked,
  wadeSpeedScale,
  waterDepth,
} from '../world/wading.ts';

// --- Constants ----------------------------------------------------------------

/**
 * Spec 8.2: "Health pips in the corner." Three of them.
 *
 * A **float** since spec 8.3 arrived, and the reason is in that file's header:
 * +40% punch damage on a 1-pip punch is 1.4 pips, which is not a number of
 * pips, and both integer resolutions of it are wrong gameplay. Health
 * accumulates as a real number and the HUD draws its ceiling. With no modifier
 * in play the arithmetic is exactly integral -- 3, 2, 1, 0, no float residue --
 * which is why nothing in `verifyCombat` had to change.
 */
export const MAX_HEALTH = 3;
/** Spec 8.2: "4 punches then 2 s recovery." */
export const MAX_STAMINA = 4;
export const STAMINA_RECOVERY = 2.0;

/*
 * The footy supply's three clocks. Not in the spec -- see `game/footy.ts`'s
 * header for the deviation and the instruction it came from.
 *
 * They are here rather than beside the ball because they govern fields of
 * `CombatantState` that `advance` maintains every tick, exactly as
 * `MAX_STAMINA` and `STAMINA_RECOVERY` do, and because putting them in
 * `game/footy.ts` would make this module import that one and close a cycle for
 * three numbers. The split that falls out is a clean one: what the *supply* does
 * is here, what the *ball* does -- flight, bounce, damage, knockback -- is
 * there.
 *
 * **The refill is one ball at a time, and that is the one place this bar
 * deliberately differs from the stamina bar beside it.** Spec 8.2 argues for a
 * hard stop and a whole-bar refill, on the grounds that a trickle is a resource
 * nobody has to think about; that argument is right about the *melee*, where
 * every swing that reaches its window connects or misses by aim alone. A thrown
 * ball can miss by a metre for reasons the thrower could not have known -- a
 * target that changed direction during the 0.8 s of flight -- and a whole-bar
 * rule would punish that with four seconds of being unarmed at range. One ball
 * back every four seconds means a miss costs four seconds and a burst of three
 * costs twelve, which is the same total scarcity with the penalty in proportion
 * to what was actually spent.
 *
 * The 0.55 s floor between throws is what stops the whole bar going in one
 * frame. It is short enough to burst all three at a closing opponent, which is
 * the play the arc is meant to make available.
 */
export const BALL_CHARGES = 3;
/** Seconds per ball returned, counted from the last throw. See above. */
export const BALL_RECHARGE = 4.0;
export const BALL_COOLDOWN = 0.55;

/**
 * How long being hit takes control away, in seconds.
 *
 * Shorter than `animation.FLINCH_DURATION` (0.38 s) on purpose. The clip is
 * presentation and is allowed to tail out past the lockout; the lockout is
 * simulation and every millisecond of it is a millisecond the player is not
 * playing. 300 ms is spec 8.2's number and the clip's last 80 ms plays while the
 * player already has their controls back, which nobody notices and everybody
 * would notice the other way round.
 */
export const FLINCH_LOCKOUT = 0.3;

/**
 * Frozen frames on a landed hit, in seconds, for both parties.
 *
 * 90 ms is a shade over five frames at 60 Hz. Under about four the impact reads
 * as a dropped frame rather than as a hit; over about eight it reads as a stall.
 */
export const HITSTOP = 0.09;

/** Spec 8.2: "Ragdoll on knockout, 3 s, respawn at a nearby street corner." */
export const KO_SECONDS = 3.0;

/**
 * The melee sphere-cast. Spec 8.2 specifies "~1.2 m reach, ~0.4 m radius" for a
 * bare fist; **the melee weapon in this game is a cricket bat**, so both numbers
 * moved, and this is the only gameplay change the bat pass makes.
 *
 *   reach   1.2 m -> 1.55 m      cast radius   0.40 m -> 0.48 m
 *
 * The reach is measured rather than chosen. `player/bat.ts` steps the real rig
 * through the real swing clip and reads where the toe of the real 0.83 m blade
 * ends up: 1.40 m from the body axis in plan at full extension. 1.55 leaves the
 * hit test a little ahead of the picture, which is the direction the error has to
 * fall -- the fist's 1.2 m was 0.3 m ahead of where the mitt actually got, on the
 * same arithmetic, and a weapon that visibly passes *through* someone without
 * connecting is the version of this mistake players notice. The check in
 * `bat.ts` asserts both halves: the blade gets most of the way to the reach, and
 * never past it.
 *
 * The radius is what a wider weapon buys. It forgives aim rather than adding
 * distance -- see `hitTest` -- and 0.48 m is roughly the half-width of the arc a
 * 0.125 m blade sweeps through, against the 0.4 m a fist was given. In practice
 * it is the difference between a swing at somebody's head from a metre away
 * connecting and whiffing, which is the right way for a bat to differ from a jab.
 *
 * Both numbers are compiled from this module by the **client and the server**
 * alike (`server/sim.ts` imports it), so there is nothing on the wire to change:
 * the protocol carries inputs, and reach is a property of the shared simulation.
 */
export const REACH = 1.55;
export const CAST_RADIUS = 0.48;
/** The body being cast against. The controller's own capsule, so the two agree. */
export const CAPSULE_RADIUS = PLAYER_RADIUS;
export const CAPSULE_HEIGHT = FIGURE_HEIGHT;

/**
 * The impulse, m/s. See the header for the measured flight distance and for why
 * both numbers had to be checked against the controller's friction rather than
 * against a ballistic formula.
 */
export const KNOCKBACK_HORIZONTAL = 11.0;
export const KNOCKBACK_VERTICAL = 5.5;

/**
 * How hard a knocked-out body skids, m/s^2.
 *
 * Lower than the controller's 34, because that number is a person deliberately
 * stopping and this one is a person who has stopped deciding things. It is not
 * free to choose: the ragdoll's total travel is asserted into the same 6-8 m
 * band as a live victim's, so this trades directly against the airborne half.
 */
const RAGDOLL_FRICTION = 26.0;

/** What a body loses to the wall it hits. A limp body does not bounce off a terrace. */
const RAGDOLL_WALL_DAMPING = 0.15;

/**
 * Slack on every phase boundary, in seconds.
 *
 * A microsecond, and it is not a fudge -- it is the difference between a punch
 * that takes 500 ms and one that takes 517. Nine additions of `1/60` sum to
 * 0.14999999999999997, which is *less* than the 0.15 wind-up, so a naive
 * comparison spends a tenth tick in a window that is already over and every
 * subsequent phase inherits the same off-by-one. The cycle comes out 31 ticks
 * instead of 30 and there is nothing on screen that says so. The epsilon is
 * eleven orders of magnitude under the smallest window here and four under the
 * timestep, so it can only ever resolve this exact case.
 */
const PHASE_EPSILON = 1e-6;

/**
 * `controller.step`'s pitch clamp, restated for the one path that does not run
 * through it. Not exported from there because it is a detail of a function that
 * has always applied it itself; the knockout branch below is the first caller in
 * the project that sets a pitch without going via `step`.
 */
const MAX_PITCH = Math.PI / 2 - 0.02;

export { PUNCH_ACTIVE, PUNCH_RECOVERY, PUNCH_TOTAL, PUNCH_WIND_UP };

// --- State --------------------------------------------------------------------

/**
 * What a combatant is doing, and the only thing that decides what they may do.
 *
 * `windup`, `active` and `recovery` are spec 8.2's three punch windows. `flinch`
 * and `ko` are the two ways of being on the receiving end. `idle` is the only
 * phase a punch can start from -- which is what makes the 500 ms cycle a rhythm
 * rather than a queue, and is why there is no `blocking` here: there is no block
 * in this game and adding a phase for one would be inventing a mechanic.
 */
export type CombatPhase = 'idle' | 'windup' | 'active' | 'recovery' | 'flinch' | 'ko';

export interface CombatantState {
  /** Stable across a respawn. The identity a hit report and a future snapshot use. */
  readonly id: number;
  /**
   * Position, velocity, yaw, pitch and ground contact -- the controller's state,
   * embedded rather than duplicated. `position` is the **eye**. See the header.
   */
  readonly body: PlayerState;
  /** Pips remaining, 0..MAX_HEALTH, as a real number. See `MAX_HEALTH`. */
  health: number;
  /** Punches remaining before the lockout, 0..MAX_STAMINA. */
  stamina: number;
  /** Seconds since the last punch *started*. Drives the 2 s refill. */
  staminaT: number;
  phase: CombatPhase;
  /** Seconds into the current phase. Meaningless in `idle`. */
  phaseT: number;
  /** Seconds since the knockout. Only advances in `ko`. */
  koT: number;
  /** Seconds until respawn. Only meaningful in `ko`; the HUD counts it down. */
  respawnT: number;
  /** Seconds of frozen simulation remaining. See the header: per-combatant, never global. */
  hitstopT: number;
  /**
   * Spec 8.3's two powerups, as seconds remaining on each.
   *
   * Two floats rather than a list of effects, and `game/powerups.ts`'s header
   * argues it out: there are exactly two, the spec defines both completely, and
   * these are the fields a 60 Hz snapshot has to carry per player. They live on
   * `CombatantState` rather than beside the powerup points for the reason the
   * whole file exists -- the punch reads `damageScale` and the controller reads
   * `speedScale`, and a second record of who is buffed would disagree with this
   * one exactly as a second record of where a player is would.
   */
  trainingT: number;
  flatWhiteT: number;
  /**
   * Balls left to throw, 0..`BALL_CHARGES`.
   *
   * The ranged weapon is a user-ordered addition rather than a spec one -- see
   * `game/footy.ts`'s header -- and the one design constraint it came with was
   * that it must not share the melee's stamina. So it has a bar of its own, and
   * the bar lives here rather than beside the ball for the reason `trainingT`
   * does: this record *is* what a snapshot carries per player, and a second
   * record of how many balls someone has left would disagree with this one.
   */
  ballCharges: number;
  /**
   * Seconds since the last throw. Drives both of the supply's clocks.
   *
   * One number rather than two, and it is the same shape `staminaT` is: the
   * per-throw cooldown is "is this over 0.55" and the refill is "is this over
   * 4", measured from the same instant, so a second field would only ever be the
   * first one copied. It is also what the animation reads -- a thrower is
   * mid-throw for the first fraction of a second of it -- which is why the
   * snapshot carries no separate clock for the pose.
   */
  ballT: number;
  /**
   * The lime e-bike this combatant is riding, or 0 for on foot.
   *
   * Here rather than beside the bikes on exactly `trainingT`'s argument, and the
   * argument is stronger for this one: `game/bikes.shapeRideInput` reads it on
   * the way into the integrator, so it *is* movement state, and a second record
   * of who is on a bike would be a second opinion about how fast somebody is
   * going. It is also what makes the multiplier unforgeable -- see
   * `protocol.INPUT_BYTES`, which carries buttons and a look direction and no
   * numbers at all.
   *
   * The id is `game/bikes.bikePlan`'s, which both ends derive from the same tile
   * index. `game/bikes.BikeField` owns the other half of the relationship (which
   * bike thinks it has *this* rider) and reconciles the two once a tick.
   */
  ridingBike: number;
  /**
   * Whether this combatant has found the tuning stall in Redfern this session.
   *
   * Per session and never persisted, on spec 12's terms. It is on the combatant
   * rather than on the connection because `advance` needs it -- it is the
   * difference between a 2x bike and a 3x one -- and because that makes it
   * survive a respawn, which is the point: walking to Redfern is a thing you do
   * once, not a thing you do again every time you are knocked over.
   */
  bikeTuned: boolean;
  /**
   * The train this combatant is riding, in the carriage's own coordinates.
   *
   * Here on `ridingBike`'s argument and for the same reason it is stronger than
   * `trainingT`'s: this **is** movement state. `advance` steps the body against
   * the carriage rather than against the city while it is set, so a second
   * record of who is on a train would be a second opinion about which floor
   * somebody is standing on.
   *
   * A record rather than eight loose fields, and a record allocated once by
   * `createCombatant` rather than a nullable one, so that boarding allocates
   * nothing during the one moment the feature is on screen. `line < 0` is "on
   * foot" and is what `riding.isAboard` asks.
   *
   * **`advance` does not read it and must not.** Deciding to board needs the
   * timetable, which lives in `game/rail.ts`, and this file may not import it
   * for the reason the bikes may not import `BikeField`: the callers that own a
   * bake do the deciding and hand `advance` a world. The one thing this file
   * does with it is the sweep in the knockout branch below.
   */
  readonly aboard: AboardSlot;
}

/** The controller's input plus the swing bit and the throw one. */
export interface CombatInput extends InputSnapshot {
  /** Left click. Level-triggered: a swing starts only from `idle` with stamina. */
  punch: boolean;
  /**
   * Right click, or `L`. Level-triggered on the same terms as `punch`.
   *
   * Optional so that every caller written before the ranged weapon existed --
   * the two self-checks in this file and in `game/powerups.ts`, and every
   * synthetic input in them -- still compiles and still means "not throwing".
   */
  throwBall?: boolean;
  /**
   * `E`. Get on the bike beside you, or off the one you are on.
   *
   * **Level-triggered on the wire and edge-triggered by the reader**, which
   * `protocol.BTN.MOUNT` argues out at length: this field is "the key is down",
   * and both `server/sim.ts` and `main.ts` keep the previous tick's value and act
   * on the rising edge, because a toggle read once a tick while held would mount
   * and dismount sixty times a second.
   *
   * Deliberately **not** consumed by `combat.advance`. Mounting needs the set of
   * bikes in the world to decide anything at all, and that set lives in
   * `game/bikes.BikeField` -- which this file must not import, since bikes.ts is
   * the third leg of the powerups cycle. So `advance` reads the *result*
   * (`CombatantState.ridingBike`) and the two callers that own a `BikeField` do
   * the deciding. Optional, so every caller written before the bikes still
   * compiles and still means "not pressing E".
   */
  mount?: boolean;
}

/**
 * The world a combatant is simulated against.
 *
 * Two members, and the split is the one `main.ts` already makes: the prisms
 * answer "can I move here" and the terrain-plus-roofs function answers "how high
 * is the world here". Passed as an interface rather than as concrete objects so
 * that a server -- which has the same `CollisionWorld` and a different ground
 * source -- satisfies it without this file knowing.
 */
export interface CombatWorld {
  collision: CollisionWorld | null;
  groundHeight(x: number, z: number, feetY: number): number;
  /**
   * A resolver that stands in for `collision` while this body is being moved.
   *
   * Absent on every world written before trains were rideable, which is what
   * "the city" means. Present only on the throwaway world a caller builds around
   * an aboard player for the duration of one `advance`, where it is the carriage
   * (`game/riding.carriageResolve`) and `groundHeight` is the carriage floor. See
   * `moverOf`, and see `game/riding.ts`'s header for why a rider is stepped in
   * the carriage's coordinates rather than the world's.
   */
  mover?: MoveResolver | null;
  /**
   * Where the water surface is over a point, or `NaN` where there is none.
   *
   * Optional, and absent is a working configuration rather than a broken one: it
   * means a world with no water in it, which is what every self-check in this
   * file runs against and what an index written before the water pass describes.
   *
   * A third member rather than folding into `groundHeight`, because it is a
   * different question with a different answer at the same point: the ground is
   * where you stand and this is what you are standing *in*, and at Circular Quay
   * the two are three and a half metres apart. Both ends supply it from
   * `index.json` through `world/wading.ts`, which is what lets the wading rule
   * be predicted on the client and enforced on the server with nothing new on
   * the wire.
   */
  waterSurface?(x: number, z: number): number;
}

/** What happened to one combatant on one tick. Presentation reads this; nothing here does. */
export interface CombatEvents {
  /** A punch started this tick. The caller plays the clip and the whiff. */
  punched: boolean;
  /**
   * The active window opened this tick, and the hit test must run **now**.
   * Exactly one tick per punch carries it. See the header.
   */
  strike: boolean;
  /** The 3 s knockout elapsed. The caller picks a spot and calls `respawnAt`. */
  respawnDue: boolean;
  /** A punch was refused for want of stamina. The HUD flashes the bar. */
  outOfStamina: boolean;
  /**
   * A ball left the hand this tick, and the caller must spawn it **now**.
   *
   * The counterpart of `strike`, with one difference that is the whole of what
   * changed when the beam became a ball: `strike` is a request to run a hit test
   * *this instant*, and this is a request to put an object into the world that
   * will decide for itself, over the next second, whether it hits anybody. So
   * the caller does not pass a target list here at all -- it calls
   * `footy.FootyField.add` and the field's own step does the rest. There is no
   * wind-up, so the request and the input arrive on the same tick.
   */
  ballThrown: boolean;
  /** Thrown with no ball or inside the cooldown. The HUD flashes the supply bar. */
  ballRefused: boolean;
}

/** What one landed punch did. Returned rather than acted on -- see the header's rule 2. */
export interface HitReport {
  attacker: number;
  victim: number;
  /** The victim's last pip went. */
  ko: boolean;
  /** Pips left on the victim after the hit. */
  health: number;
  /** Where the impact reads from: the victim's chest, in world space. */
  point: Vector3;
}

export function createCombatant(id: number, x = 0, z = 0): CombatantState {
  return {
    id,
    body: createPlayerState(x, z),
    health: MAX_HEALTH,
    stamina: MAX_STAMINA,
    // Starts at the refill threshold rather than at zero, so a combatant is not
    // born two seconds into a recovery they never spent.
    staminaT: STAMINA_RECOVERY,
    phase: 'idle',
    phaseT: 0,
    koT: 0,
    respawnT: 0,
    hitstopT: 0,
    trainingT: 0,
    flatWhiteT: 0,
    ballCharges: BALL_CHARGES,
    // At the refill threshold rather than at zero, for `staminaT`'s reason: a
    // combatant is not born inside a cooldown they never spent.
    ballT: BALL_RECHARGE,
    // On foot, and untuned. Both are session state a joiner starts without.
    ridingBike: 0,
    bikeTuned: false,
    // On foot. See `CombatantState.aboard`: the record is allocated here once
    // and mutated forever after, never replaced.
    aboard: createAboardSlot(),
  };
}

/**
 * An empty `HitReport`, for a caller that has to supply one.
 *
 * Exists because `game/footy.ts` imports nothing from three and therefore
 * cannot construct the `Vector3` a report carries -- so `applyFootyHit` takes
 * its report rather than allocating one, and both of its call sites need a way
 * to make one that does not involve `server/sim.ts` importing three. See that
 * file's note on why no module under `server/` may.
 */
export function createHitReport(): HitReport {
  return { attacker: 0, victim: 0, ko: false, health: 0, point: new Vector3() };
}

/** Feet height, metres. The mesh origin, the capsule origin, and the ground query's argument. */
export function feetY(c: CombatantState): number {
  return c.body.position.y - EYE_HEIGHT;
}

/** Can this combatant be punched? A body already on the ground cannot be. */
export function isTargetable(c: CombatantState): boolean {
  return c.phase !== 'ko' && c.health > 0;
}

/** Horizontal speed, m/s. What the animation's stride is keyed to. */
export function planSpeed(c: CombatantState): number {
  return Math.hypot(c.body.velocity.x, c.body.velocity.z);
}

/**
 * The view direction, as the camera builds it.
 *
 * Three's camera is `rotation.set(pitch, yaw, 0, 'YXZ')` looking down -Z, which
 * makes forward `(-sin yaw cos pitch, sin pitch, -cos yaw cos pitch)`. Derived
 * here rather than read off a camera matrix for the reason `controller.step`
 * derives its movement basis from yaw: the server has no camera, and a hit test
 * that depended on one could not be re-run there.
 */
export function viewDirection(c: CombatantState, out: Vector3): Vector3 {
  const cp = Math.cos(c.body.pitch);
  return out.set(-Math.sin(c.body.yaw) * cp, Math.sin(c.body.pitch), -Math.cos(c.body.yaw) * cp);
}

// --- The tick -----------------------------------------------------------------

const NO_MOVE: InputSnapshot = { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };

/**
 * The snapshot `advance` actually hands to `controller.step`, filled each tick.
 *
 * Module-scoped and reused, on the same terms as `castStart` and `impulseDir`
 * below -- one allocation for the process rather than one per combatant per
 * tick at 60 Hz.
 *
 * It exists because `advance` now has to *add* two fields to the caller's input
 * (spec 8.3's speed and jump scales, which come from the combatant's own state
 * and not from their keyboard), and writing them into `input` would mutate an
 * object the caller owns -- which for a server is the arriving datagram, and
 * for `game/dummies.ts` is a packet it fills once and reuses. Copying is eight
 * numbers. It also folds in the flinch case, which used to be a second scratch
 * object with the same shape: a flinch is exactly "this tick's movement is
 * zero", and that is now one pair of ternaries rather than a branch and a
 * separate record.
 */
const movement: InputSnapshot = {
  forward: 0,
  right: 0,
  jump: false,
  sprint: false,
  yaw: 0,
  pitch: 0,
  speedScale: 1,
  jumpScale: 1,
};

/**
 * Advance one combatant by one fixed step.
 *
 * `dt` must be the fixed timestep for the reason `controller.step` states: two
 * machines simulating the same inputs have to produce the same trajectory, and a
 * variable step guarantees they do not. `advance` is what a server would call at
 * spec 10's 60 Hz, once per player, in id order.
 *
 * The return value is the whole of this function's coupling to the rest of the
 * game. In particular `strike` is a *request* -- the caller runs `hitTest`
 * against whatever set of targets it considers authoritative, which on a server
 * is the rewound set, and calls `applyHit`.
 */
export function advance(
  c: CombatantState,
  input: CombatInput,
  dt: number,
  world: CombatWorld | null,
): CombatEvents {
  const events: CombatEvents = {
    punched: false,
    strike: false,
    respawnDue: false,
    outOfStamina: false,
    ballThrown: false,
    ballRefused: false,
  };

  // Hitstop, first and on its own. This combatant's clock is stopped: no phase
  // advances, no gravity, no stamina, no movement. Everyone else's frame is
  // untouched, which is the whole design -- see the header.
  if (c.hitstopT > 0) {
    c.hitstopT = Math.max(0, c.hitstopT - dt);
    return events;
  }

  // Spec 8.3's clocks, after the hitstop return and before everything else.
  //
  // After, so a combatant frozen mid-punch does not age their Training -- the
  // whole design of hitstop is that it is *that combatant's* clock stopping,
  // and a powerup whose 45 s ran shorter the more you were hit would be the one
  // duration in the game that depended on someone else's actions.
  //
  // Before the knockout branch, so they *do* run while a body is on the
  // pavement. That is the right way round for the same reason: three seconds of
  // knockout is three seconds of a Flat White you are not using, and pausing it
  // would make dying a way to bank one.
  advanceModifiers(c, dt);

  // --- Knockout. A ballistic body with a canned crumple over it, and no phase
  // machine at all: nothing a knocked-out player presses does anything.
  if (c.phase === 'ko') {
    c.koT += dt;
    c.respawnT = Math.max(0, KO_SECONDS - c.koT);
    // You are not on a bike. **A level, swept every tick, rather than a clear at
    // each of the places a knockout comes from**, and that difference is the fix
    // for a real bug rather than tidiness.
    //
    // `applyHit` clears the field, and so do `footy.applyFootyHit`,
    // `traffic.runDown` and `sim.shoot` -- four sites, one line each, and every
    // future way to knock somebody out is a fifth that somebody has to remember.
    // The reported symptom was a player who died on a bike and kept the ride's
    // HUD state; the structural version of that report is that "knocked out" and
    // "riding" were two facts that nothing forced to agree. This is the line
    // that forces it, in the one function the browser, the server and
    // `net/client.reconcile`'s replay all run, so all three agree by
    // construction rather than by four coincidences.
    //
    // `BikeField.follow` does the rest on the same tick: it sweeps every bike
    // whose rider has stopped riding and parks it where the body is, which is
    // the death spot. Nothing here knows that class exists.
    c.ridingBike = 0;
    ragdollStep(c, dt, world);
    // Look is left alone. A dead camera that will not turn reads as a crash.
    // Clamped here rather than trusted, because this is the one path that does
    // not go through `controller.step` and therefore the one place a pitch past
    // vertical would flip the view upside down with nothing to stop it.
    c.body.yaw = input.yaw;
    c.body.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch));
    if (c.koT + PHASE_EPSILON >= KO_SECONDS) events.respawnDue = true;
    return events;
  }

  // --- Stamina. Spec 8.2 is "4 punches then 2 s recovery", so the refill is the
  // whole bar at once and it is timed from the last punch rather than from the
  // last *empty* bar. Regenerating pips one at a time is the other obvious rule
  // and it is a different mechanic: it turns a rhythm with a hard stop into a
  // trickle nobody has to think about, which is the opposite of what the spec
  // says the stamina is for.
  c.staminaT += dt;
  if (c.staminaT + PHASE_EPSILON >= STAMINA_RECOVERY && c.stamina < MAX_STAMINA) c.stamina = MAX_STAMINA;

  // --- The footy supply. One ball back per `BALL_RECHARGE`, not the whole bar
  // at once -- see the constants for why this is the one resource in the game
  // that trickles.
  //
  // The clock is *consumed* rather than reset to zero, so a flinch or a
  // hitstop does not restart the count -- partial progress toward the next
  // ball survives an interruption. (It does NOT run while knocked out: the ko
  // branch above never reaches this line, which is fine because `respawn`
  // refills the bag anyway -- measured during the checkPolice flake hunt,
  // 2026-08-05.) `while` rather than `if` for the same reason as the
  // consumption: eight seconds of accrued clock is two balls, and a rule that
  // returned one would silently make the refill depend on how often `advance`
  // was called.
  c.ballT += dt;
  while (c.ballCharges < BALL_CHARGES && c.ballT + PHASE_EPSILON >= BALL_RECHARGE) {
    c.ballCharges += 1;
    c.ballT -= BALL_RECHARGE;
  }
  // With a full bar the clock is pinned rather than left to run, so a player who
  // has not thrown for a minute is not carrying fifteen banked balls' worth of
  // credit into their next three throws.
  if (c.ballCharges >= BALL_CHARGES && c.ballT > BALL_RECHARGE) c.ballT = BALL_RECHARGE;

  // --- The throw. Before the punch, and from any phase but flinch and ko.
  //
  // Both halves of that are decisions. It is *before* the punch so that a
  // player holding both buttons gets the throw they can afford rather than a
  // swing that locks them out of it for 500 ms -- the ball is the answer to
  // range and the bat is the answer to contact, and the ambiguous frame should
  // resolve toward the one the player pressed a second button for.
  //
  // It is allowed *during* a swing because the ball is in the other hand.
  // `animation.UPPER_BODY` already lets a walk and a swing run together; this is
  // the same argument one limb over, and a weapon that could only be thrown from
  // a standing idle would be unusable in the only situation it exists for.
  // Flinch and knockout are the exceptions because those are the two phases in
  // which a combatant is not deciding anything at all.
  if (input.throwBall === true && c.phase !== 'flinch') {
    if (c.ballCharges > 0 && c.ballT + PHASE_EPSILON >= BALL_COOLDOWN) {
      c.ballCharges -= 1;
      c.ballT = 0;
      events.ballThrown = true;
    } else {
      events.ballRefused = true;
    }
  }

  // --- The punch. Only from idle, which is what makes the cycle a rhythm.
  if (c.phase === 'idle' && input.punch) {
    if (c.stamina > 0) {
      c.phase = 'windup';
      c.phaseT = 0;
      c.stamina -= 1;
      c.staminaT = 0;
      events.punched = true;
    } else {
      events.outOfStamina = true;
    }
  }

  // The three windows of 8.2, each accumulating in its own phase and carrying
  // the remainder across the boundary so the total is exactly 500 ms of
  // simulated time regardless of where the step lands inside a window.
  if (c.phase === 'windup') {
    c.phaseT += dt;
    if (c.phaseT + PHASE_EPSILON >= PUNCH_WIND_UP) {
      c.phase = 'active';
      c.phaseT = Math.max(0, c.phaseT - PUNCH_WIND_UP);
      // The one hit test, on the first tick of the active window.
      events.strike = true;
    }
  } else if (c.phase === 'active') {
    c.phaseT += dt;
    if (c.phaseT + PHASE_EPSILON >= PUNCH_ACTIVE) {
      c.phase = 'recovery';
      c.phaseT = Math.max(0, c.phaseT - PUNCH_ACTIVE);
    }
  } else if (c.phase === 'recovery') {
    c.phaseT += dt;
    if (c.phaseT + PHASE_EPSILON >= PUNCH_RECOVERY) {
      c.phase = 'idle';
      c.phaseT = 0;
    }
  } else if (c.phase === 'flinch') {
    c.phaseT += dt;
    if (c.phaseT + PHASE_EPSILON >= FLINCH_LOCKOUT) {
      c.phase = 'idle';
      c.phaseT = 0;
    }
  }

  // --- Movement, through the controller.
  //
  // A flinch takes the *movement* away and leaves the look alone. Taking the
  // camera as well was tried on paper and rejected: 90 ms of hitstop with the
  // view frozen is an impact, and 390 ms of it is a disconnection, and the thing
  // a player does when they are hit is look for who hit them.
  //
  // Punching does not lock movement at all, which is why `animation.UPPER_BODY`
  // exists -- you can throw one while walking and the legs keep walking.
  const locked = c.phase === 'flinch';
  movement.forward = locked ? 0 : input.forward;
  movement.right = locked ? 0 : input.right;
  movement.jump = locked ? false : input.jump;
  movement.sprint = locked ? false : input.sprint;
  movement.yaw = input.yaw;
  movement.pitch = input.pitch;
  // Spec 8.3, arriving at the integrator. Read off this combatant's own state
  // rather than off the input, because a powerup is something the *world* did
  // to them and a server must not accept a client's word for it -- which is the
  // same reason `stamina` is here and not in `CombatInput`.
  //
  // Wading multiplies that rather than replacing it, and the composition is the
  // only one that is not a special case: a Flat White in the shallows is fast
  // for a wading player and slow for a running one. It is read off the *world*
  // for the same reason the powerup is read off the combatant -- where the water
  // is is a fact about Sydney, and a client must not be able to tell a server it
  // is somewhere else. See `world/wading.ts`.
  const feetBefore = c.body.position.y - EYE_HEIGHT;
  const depthBefore = waterDepth(
    world?.waterSurface?.(c.body.position.x, c.body.position.z) ?? NO_WATER,
    feetBefore,
  );
  movement.speedScale = speedScale(c) * wadeSpeedScale(depthBefore);
  movement.jumpScale = jumpScale(c);
  // And the bike, last, multiplying both of the above rather than replacing
  // them -- see `game/bikes.ts`. Read off the combatant for the identical
  // reason the powerup above it is: whether you are on a bike is something the
  // *world* decided, and `INPUT` carries no number a client could lie with.
  //
  // It also forces the sprint, which is why it runs after `movement.sprint` was
  // set from the input and not before.
  shapeRideInput(c, movement);

  const fromX = c.body.position.x;
  const fromZ = c.body.position.z;
  step(c.body, movement, dt, moverOf(world), groundOf(world));

  // And the deep-entry limit, after the step rather than inside it, because it
  // is a question about where the step *landed*. Undoing the move rather than
  // pushing back: a force would need tuning against the controller's own
  // acceleration to avoid either oscillating or being walked through, and this
  // is exactly what `controller.step` already does to a player who walks into a
  // wall. Directional, so a player who fell off a wharf can always walk out --
  // see `wadeBlocked`.
  const feetAfter = c.body.position.y - EYE_HEIGHT;
  const depthAfter = waterDepth(
    world?.waterSurface?.(c.body.position.x, c.body.position.z) ?? NO_WATER,
    feetAfter,
  );
  if (wadeBlocked(depthBefore, depthAfter)) {
    c.body.position.x = fromX;
    c.body.position.z = fromZ;
    c.body.velocity.x *= WADE_BLOCK_DAMPING;
    c.body.velocity.z *= WADE_BLOCK_DAMPING;
    // The step also placed `y` against the ground at the position just undone,
    // which on a seabed falling at 1:10 is a few centimetres out. Re-seated
    // here so the two coordinates always describe the same point -- and only
    // upward, so this can never drop a player through the bed.
    const floorY = (world ? world.groundHeight(fromX, fromZ, feetAfter) : 0) + EYE_HEIGHT;
    if (c.body.position.y < floorY) {
      c.body.position.y = floorY;
      c.body.velocity.y = 0;
      c.body.onGround = true;
    }
  }

  return events;
}

/** The ground query, or a flat floor at zero when there is no world (self-checks). */
function groundOf(world: CombatWorld | null): (x: number, z: number, feet: number) => number {
  return world ? (x, z, feet) => world.groundHeight(x, z, feet) : () => 0;
}

/**
 * Which resolver this body is moving against: the carriage if there is one.
 *
 * `CombatWorld.mover` is set only while a body is being stepped inside a
 * vehicle, and when it is it *replaces* the city rather than adding to it --
 * a rider walking around a carriage must not be stopped by the warehouse the
 * train is passing, and must not be able to walk out through the bodyside into
 * open air at 130 km/h. Everything else on the world is unchanged, which is why
 * `pickRespawn` below still reads `collision` directly: choosing where to put a
 * respawned body is a question about the city and never about the carriage.
 */
function moverOf(world: CombatWorld | null): MoveResolver | null {
  if (world === null) return null;
  return world.mover ?? world.collision;
}

/**
 * One step of a knocked-out body.
 *
 * Deliberately *not* `controller.step`: a corpse has no wish velocity, does not
 * accelerate, does not climb kerbs and does not stand up. What it shares with the
 * controller is the only two things that must not differ -- the same gravity, so
 * a knockout arc matches a flinch arc, and the same `resolve`, so a body cannot
 * be knocked through a wall the living cannot walk through.
 */
function ragdollStep(c: CombatantState, dt: number, world: CombatWorld | null): void {
  const p = c.body.position;
  const v = c.body.velocity;

  v.y += GRAVITY * dt;

  const fromX = p.x;
  const fromZ = p.z;
  const toX = fromX + v.x * dt;
  const toZ = fromZ + v.z * dt;
  const feet = p.y - EYE_HEIGHT;

  let x = toX;
  let z = toZ;
  const mover = moverOf(world);
  if (mover) {
    // No step height in the query: a body sliding along the pavement does not
    // climb a kerb, and passing the controller's STEP_HEIGHT here would let a
    // knockout mount a 0.4 m wall it was thrown at.
    const r = mover.resolve(fromX, fromZ, toX, toZ, PLAYER_RADIUS, feet);
    x = r.x;
    z = r.z;
    if (r.hit) {
      v.x *= RAGDOLL_WALL_DAMPING;
      v.z *= RAGDOLL_WALL_DAMPING;
    }
  }
  p.x = x;
  p.z = z;
  p.y += v.y * dt;

  const floorY = (world ? world.groundHeight(p.x, p.z, p.y - EYE_HEIGHT) : 0) + EYE_HEIGHT;
  if (p.y <= floorY) {
    p.y = floorY;
    v.y = 0;
    c.body.onGround = true;
  } else {
    c.body.onGround = false;
  }

  if (c.body.onGround) {
    const speed = Math.hypot(v.x, v.z);
    if (speed > 1e-4) {
      const drop = Math.min(speed, RAGDOLL_FRICTION * dt);
      v.x -= (v.x / speed) * drop;
      v.z -= (v.z / speed) * drop;
    } else {
      v.x = 0;
      v.z = 0;
    }
  }
}

// --- The hit test -------------------------------------------------------------

const castStart = /*#__PURE__*/ new Vector3();
const castEnd = /*#__PURE__*/ new Vector3();
const castDir = /*#__PURE__*/ new Vector3();

/**
 * Spec 8.2's sphere-cast, and the one clause that is not in the spec.
 *
 * The cast is `REACH` of `CAST_RADIUS` sphere swept from the attacker's eye
 * along their view direction, tested against each target's 0.34 x 1.7 m capsule.
 * That much is the spec verbatim, at the bat's numbers rather than the fist's.
 * What is added is a **plan-distance gate at the same `REACH`**, and it is added
 * because the spec's two numbers do not on their own mean what they say:
 *
 *   a sphere of radius 0.48 swept 1.55 m, touching a capsule of radius 0.34,
 *   first makes contact with a target whose axis is **2.37 m** away.
 *
 * That is not a 1.55 m reach, it is a swing that lands from three body-widths off
 * and reads as a magnet -- and it is the exact failure a naive capsule-versus-
 * sweep test produces while looking perfectly principled in code. So the two
 * halves are separated and each does the job it is good at: the **sweep decides
 * aim** -- whether you are looking at them, at what height, within the cone the
 * 0.48 m radius forgives -- and the **plan distance decides reach**, at the
 * 1.55 m a bat in an outstretched arm actually is. A target dead ahead at 1.5 m
 * is hit; the same target at 1.8 m is not; a target at 1.0 m with the attacker
 * looking 40 degrees over their head is not, because at that range 40 degrees
 * clears a 1.7 m figure's crown by more than the blade is wide.
 *
 * The one behaviour that changed with the weapon, stated so it is not read as
 * drift: **31 degrees over a target's head now connects, where the fist's 0.4 m
 * cast missed.** That is what a wider cast radius is for, and it is the right
 * asymmetry -- a bat is swung through an arc almost a metre across and a fist is
 * a fist.
 *
 * Nearest wins when several qualify, by plan distance. Not by cast parameter:
 * two dummies at 0.9 m and 1.15 m either side of the crosshair should resolve to
 * the closer one, and the swept sphere reaches the shoulder of the further one
 * first when it is a few degrees better aimed.
 *
 * There is no headshot multiplier and no per-limb hitbox. Spec 2 is a comic
 * brawler; 8.2's damage is one pip, whatever it lands on.
 *
 * `targets` is explicit because that is spec 8.2's lag compensation seam: the
 * server passes remote combatants **rewound to the attacker's view time**, capped
 * at spec 10's 250 ms, and this function neither knows nor cares.
 */
export function hitTest(
  attacker: CombatantState,
  targets: readonly CombatantState[],
): CombatantState | null {
  viewDirection(attacker, castDir);
  castStart.copy(attacker.body.position);
  castEnd.copy(castDir).multiplyScalar(REACH).add(castStart);

  const overlap = CAST_RADIUS + CAPSULE_RADIUS;
  let best: CombatantState | null = null;
  let bestPlan = Infinity;

  for (const t of targets) {
    if (t.id === attacker.id) continue;
    if (!isTargetable(t)) continue;

    const dx = t.body.position.x - castStart.x;
    const dz = t.body.position.z - castStart.z;
    const plan = Math.hypot(dx, dz);
    if (plan > REACH) continue;
    if (plan >= bestPlan) continue;

    const foot = feetY(t);
    const d = segmentDistance(
      castStart.x, castStart.y, castStart.z,
      castEnd.x, castEnd.y, castEnd.z,
      t.body.position.x, foot + CAPSULE_RADIUS, t.body.position.z,
      t.body.position.x, foot + CAPSULE_HEIGHT - CAPSULE_RADIUS, t.body.position.z,
    );
    if (d > overlap) continue;

    best = t;
    bestPlan = plan;
  }

  return best;
}

/**
 * Shortest distance between two line segments.
 *
 * The standard clamped-parameter solve. Written out rather than pulled from
 * three's `Line3` because it has to be callable from a server that never
 * constructs a three object, and because the degenerate cases -- a zero-length
 * cast when the view direction is somehow null, and two parallel segments, which
 * is *every* level punch at a standing target -- have to be handled rather than
 * divided by.
 *
 * Exported for `game/footy.ts`, which asks the same question about a thrown
 * ball: one tick of a ball's flight against a standing capsule is the same
 * geometry as a swing against one, and two solves of it would be two chances to
 * disagree about whether something connected.
 */
export function segmentDistance(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, dx2: number, dy2: number, dz2: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = dx2 - cx;
  const vy = dy2 - cy;
  const vz = dz2 - cz;
  const wx = ax - cx;
  const wy = ay - cy;
  const wz = az - cz;

  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const cc = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const denom = a * cc - b * b;

  // Parallel, or one segment degenerate: pin the first parameter at its start
  // and let the solve below place the second. That case is not exotic here, it
  // is *every* level punch at an upright capsule -- a horizontal cast against a
  // vertical axis with `denom` at exactly zero.
  let s = denom < 1e-9 ? 0 : (b * e - cc * d) / denom;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  // Solve and clamp the second parameter against the clamped first, then the
  // first against the clamped second. Both re-solves are required: clamping each
  // independently reports the distance between two points that are not the
  // closest pair, which on this geometry over-reports and turns clean hits into
  // misses at the edge of the sweep.
  let t = cc > 1e-9 ? (e + b * s) / cc : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  s = a > 1e-9 ? (b * t - d) / a : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;

  const px = wx + s * ux - t * vx;
  const py = wy + s * uy - t * vy;
  const pz = wz + s * uz - t * vz;
  return Math.hypot(px, py, pz);
}

// --- The consequence ----------------------------------------------------------

const impulseDir = /*#__PURE__*/ new Vector3();

/**
 * Pips off a combatant with nobody to blame. True if it was a knockout.
 *
 * The knockout is spelled **once**, here, and that is the whole reason this
 * function exists. Four things in the game hurt somebody without a puncher --
 * a police round, a car, the ground at the end of a fall, and now jumping out of
 * a train at 130 km/h -- and each of them was reaching for the same six lines:
 * clamp the health, set the phase, zero the two clocks, set the respawn, drop
 * the bike. Six lines copied four times is four places a future fifth cause can
 * be spelled *nearly* right, and the failure mode is a body that is at zero pips
 * and still walking.
 *
 * Deliberately **not** `applyHit` with the victim as their own attacker, which
 * is the other way this could have gone. That function sets a knockback from the
 * attacker's *view direction*, applies hitstop to both parties and fills in a
 * `HitReport` -- none of which mean anything when the thing that hurt you is
 * gravity, and the first of which would throw a body along whatever it happened
 * to be looking at.
 *
 * The caller owns the velocity, the event and the killfeed. `server/sim.hurt`
 * emits a `HIT` with the victim as their own attacker (the sentinel a car
 * already uses, meaning "the world did this"), and `main.ts` does the same thing
 * offline by simply not emitting one.
 */
export function applyWorldDamage(c: CombatantState, pips: number): boolean {
  if (c.phase === 'ko' || c.health <= 0) return false;
  c.health = Math.max(0, c.health - pips);
  // `applyHit`'s float snap, for its reason: a victim alive by half a femto-pip
  // draws one pip on the HUD and cannot be knocked out by any finite number of
  // further hits.
  if (c.health < 1e-9) c.health = 0;
  if (c.health > 0) return false;
  c.phase = 'ko';
  c.phaseT = 0;
  c.koT = 0;
  c.respawnT = KO_SECONDS;
  c.ridingBike = 0;
  return true;
}

/**
 * One pip, one comic launch, one flinch or one knockout, and hitstop on both.
 *
 * The impulse is **set, not added**, and that is a gameplay decision rather than
 * a physics one: a sprinting victim punched from behind would otherwise arrive
 * carrying 8.2 m/s of their own and fly nineteen metres, and spec 8.2's "6-8 m"
 * would be true only of a stationary target. Setting it makes every punch throw
 * the same arc, which is what makes the distance a thing a player learns.
 *
 * The direction is the attacker's view, flattened to the ground plane, so a
 * victim flies where you were looking rather than along the line between your
 * navels -- which is the comic read and also the one that lets a player aim a
 * knockout off a kerb. Looking straight up or straight down flattens to nothing,
 * so that degenerate case falls back to attacker-to-victim.
 */
export function applyHit(attacker: CombatantState, victim: CombatantState, out?: HitReport): HitReport {
  viewDirection(attacker, impulseDir);
  impulseDir.y = 0;
  if (impulseDir.lengthSq() < 1e-6) {
    impulseDir.set(
      victim.body.position.x - attacker.body.position.x,
      0,
      victim.body.position.z - attacker.body.position.z,
    );
    if (impulseDir.lengthSq() < 1e-6) impulseDir.set(0, 0, -1);
  }
  impulseDir.normalize();

  // One pip, times spec 8.3's multipliers -- 1.4 with Training, 0.8 with a Flat
  // White, 1.12 with both. The *knockback* is deliberately not scaled: 8.2's
  // "6-8 m of flight" is what makes the distance a thing a player learns, and a
  // trained punch that threw someone 9 m would break the only spatial constant
  // in the fight. Training makes you hit harder, not further.
  victim.health = Math.max(0, victim.health - damageScale(attacker));
  // Snapped to zero a shade above it, and this is the float equivalent of
  // `PHASE_EPSILON`. 3 - 1.4 - 1.4 - 0.2 lands at 4.4e-16 in binary floats: a
  // victim who is alive by half a femto-pip, whose HUD draws `ceil(4.4e-16)` =
  // one pip, and who cannot be knocked out by any finite number of further
  // punches. Clamped here rather than tested for in three places downstream, so
  // "0 pips" means the same thing to the knockout branch, to `isTargetable` and
  // to `powerups.tickPowerups`.
  if (victim.health < 1e-9) victim.health = 0;
  victim.body.velocity.set(
    impulseDir.x * KNOCKBACK_HORIZONTAL,
    KNOCKBACK_VERTICAL,
    impulseDir.z * KNOCKBACK_HORIZONTAL,
  );
  // The line the header calls load-bearing: without it the first tick after the
  // punch charges the victim ground friction for a metre of flight they spend in
  // the air.
  victim.body.onGround = false;
  // And you are off the bike. Getting batted at 26 m/s and staying seated would
  // be the one impact in this game with no consequence, and a rider who kept the
  // multiplier through the knockback would fly about eighty metres.
  //
  // Clearing the field is the *whole* of it here: `game/bikes.BikeField.follow`
  // sweeps the bikes after every tick and parks any whose rider has stopped
  // riding, so the bike is dropped where the body was with nothing in this file
  // knowing that class exists. That is deliberate -- `applyFootyHit` below and a
  // disconnect three files away get the same behaviour from the same sweep.
  victim.ridingBike = 0;

  const ko = victim.health <= 0;
  if (ko) {
    victim.phase = 'ko';
    victim.koT = 0;
    victim.respawnT = KO_SECONDS;
  } else {
    victim.phase = 'flinch';
    victim.phaseT = 0;
  }

  attacker.hitstopT = HITSTOP;
  victim.hitstopT = HITSTOP;

  const report = out ?? { attacker: 0, victim: 0, ko: false, health: 0, point: new Vector3() };
  report.attacker = attacker.id;
  report.victim = victim.id;
  report.ko = ko;
  report.health = victim.health;
  report.point.set(
    victim.body.position.x,
    feetY(victim) + CAPSULE_HEIGHT * 0.62,
    victim.body.position.z,
  );
  return report;
}

/** Put a combatant back in the world at full health, facing `yaw`. `y` is the ground. */
export function respawnAt(c: CombatantState, x: number, y: number, z: number, yaw: number): void {
  c.body.position.set(x, y + EYE_HEIGHT, z);
  c.body.velocity.set(0, 0, 0);
  c.body.onGround = true;
  c.body.yaw = yaw;
  c.body.pitch = 0;
  c.health = MAX_HEALTH;
  c.stamina = MAX_STAMINA;
  c.staminaT = STAMINA_RECOVERY;
  c.phase = 'idle';
  c.phaseT = 0;
  c.koT = 0;
  c.respawnT = 0;
  c.hitstopT = 0;
  // You come back with a full bag, on the same argument the stamina bar does: a
  // player who has just spent three seconds on the pavement should not also
  // spend the next twelve unarmed at range.
  c.ballCharges = BALL_CHARGES;
  c.ballT = BALL_RECHARGE;
  // You come back on foot. The bike you were on is already parked where you fell
  // -- `bikes.BikeField.follow` did that on the tick `applyHit` cleared this --
  // and respawning 30 m away still holding it would teleport it across Redfern.
  //
  // `bikeTuned` is deliberately **not** cleared beside it: the coffees are
  // cleared above because a powerup is a thing you were carrying, and the tuning
  // is a place you went. Making a player walk back to Redfern every knockout
  // would turn a one-off discovery into a chore.
  c.ridingBike = 0;
  // Spec 8.3 says nothing about death, and the only defensible reading is that
  // a coffee does not survive a knockout. Keeping them would make dying with 40
  // seconds of Training left a *cheap* way to reposition; clearing them makes
  // holding one a reason to stay alive, which is what a contested objective is
  // for.
  clearPowerups(c);
}

// --- Respawn placement --------------------------------------------------------

/** Spec 8.2's "nearby". Far enough not to be a free rematch, near enough to be the same fight. */
const RESPAWN_MIN = 25;
const RESPAWN_MAX = 40;
/**
 * Two rings of probes, and they do different jobs.
 *
 * The inner ring at 1.5 m is a **veto**: a point that fails it is a point where a
 * player would spawn with a wall inside their own capsule's swing, and no score
 * redeems that. The outer ring at 3.5 m is a **score**, and it is what actually
 * finds a street: a carriageway is 6-10 m wide so all eight clear, a 3 m laneway
 * clears about half, and the gap between two terraces clears two. Without the
 * graded ring every surviving candidate ties and the pick collapses onto
 * whichever tiebreak comes second -- which, when that tiebreak was range, put
 * every respawn in the outer 3 m of the annulus.
 */
const RESPAWN_VETO_RADIUS = 1.5;
const RESPAWN_SCORE_RADIUS = 3.5;
const RESPAWN_SAMPLES = 32;

/**
 * A place to come back to: open ground 25-40 m away, which in this city is a
 * street. See the header for what this is not, and for the sidecar that would
 * make it the spec's literal clause.
 *
 * `rand` is a parameter rather than a call to `Math.random` so that a server can
 * seed it and replay a match. Returns null when nothing qualifies -- a tile whose
 * terrain has not arrived, or a courtyard -- and the caller must have an answer
 * for that, because a respawn that silently does not happen is a player stuck
 * looking at the pavement forever.
 */
export function pickRespawn(
  x: number,
  z: number,
  world: CombatWorld,
  rand: () => number = Math.random,
): { x: number; y: number; z: number } | null {
  if (!world.collision) return null;
  let best: { x: number; y: number; z: number } | null = null;
  let bestClearance = -1;

  for (let i = 0; i < RESPAWN_SAMPLES; i++) {
    // Stratified bearings with jitter rather than uniform sampling: 32 uniform
    // draws leave 60-degree gaps often enough to matter, and the one direction
    // with open ground in it is the one that gets missed.
    const bearing = ((i + rand()) / RESPAWN_SAMPLES) * Math.PI * 2;
    const range = RESPAWN_MIN + rand() * (RESPAWN_MAX - RESPAWN_MIN);
    const cx = x + Math.sin(bearing) * range;
    const cz = z + Math.cos(bearing) * range;

    // -Infinity for the feet height asks the ground question without roofs in
    // it: `roofHeight` refuses every prism the query is below, so what comes
    // back is the terrain. Respawning on a warehouse roof is worse than not
    // respawning there.
    const y = world.groundHeight(cx, cz, -Infinity);
    if (!Number.isFinite(y)) continue;

    // The veto. Not inside a prism, and not within 1.5 m of one on any of four
    // sides -- which is what turns "not inside a building" into "somewhere a
    // fight could start".
    if (blocked(world.collision, cx, cz, y)) continue;
    let vetoed = false;
    for (const [ox, oz] of RESPAWN_CROSS) {
      if (blocked(world.collision, cx + ox * RESPAWN_VETO_RADIUS, cz + oz * RESPAWN_VETO_RADIUS, y)) {
        vetoed = true;
        break;
      }
    }
    if (vetoed) continue;

    // The score. How much of a 3.5 m ring is open, which is a direct measure of
    // how street-like the spot is. The range term is a hundredth of a probe and
    // exists only to break exact ties in favour of the further point.
    let open = 0;
    for (const [ox, oz] of RESPAWN_RING) {
      if (!blocked(world.collision, cx + ox * RESPAWN_SCORE_RADIUS, cz + oz * RESPAWN_SCORE_RADIUS, y)) {
        open++;
      }
    }
    // Ties broken at random rather than by range, and that is not a detail: a
    // deterministic tiebreak over a set that is usually all-equal -- in this
    // city most clear ground scores 8 of 8 -- collapses the whole 25-40 m
    // annulus onto whichever end the tiebreak favours. Measured against a
    // synthetic terrace street, the range tiebreak put every respawn between
    // 38.8 and 39.9 m. The jitter is under one probe, so a genuinely more open
    // spot still always wins.
    const score = open + rand() * 0.9;
    if (score > bestClearance) {
      bestClearance = score;
      best = { x: cx, y, z: cz };
    }
  }
  return best;
}

const RESPAWN_CROSS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const RESPAWN_RING: ReadonlyArray<readonly [number, number]> = /*#__PURE__*/ Array.from(
  { length: 8 },
  (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)] as const,
);

/**
 * Is a standing capsule at (x, z) intersecting a prism?
 *
 * Asked of `resolve` with a zero-length move, which is the cheapest honest
 * version: `resolve` pushes a circle out of anything it overlaps and reports
 * whether it had to, so a null move that comes back `hit` was overlapping. The
 * step height is included because a player who can walk onto something is not
 * blocked by it -- a kerb must not disqualify half the street.
 */
function blocked(collision: CollisionWorld, x: number, z: number, ground: number): boolean {
  return collision.resolve(x, z, x, z, PLAYER_RADIUS, ground + 0.42).hit;
}

// --- The self-check -----------------------------------------------------------

const FLAT_WORLD: CombatWorld = { collision: null, groundHeight: () => 0 };
const STEP_DT = 1 / 60;

function idleInput(yaw = 0, pitch = 0): CombatInput {
  return { ...NO_MOVE, yaw, pitch, punch: false };
}

/**
 * Spec 8.2, asserted.
 *
 * The repo's rule -- `verifySouthernHemisphere`, `verifyMovementBasis`,
 * `verifyAnimation`, `verifyCharacterRig` -- is that a check exists where the
 * failure is *silent*: it renders, it does not throw, and it reads as a taste
 * decision. Combat is full of those. A punch cycle that is 560 ms because a
 * phase boundary lost a remainder is a punch that feels sluggish and that nobody
 * can measure by eye. A hit test that reaches 1.9 m is a game where punches
 * connect at a distance nobody can see, which reads as lag. A knockback that
 * lands 4 m is spec 8.2's "1 m of stagger" wearing a costume, and the only way to
 * know is to integrate it against the controller's own friction, which is what
 * the flight cases below actually do -- they run `advance` and `controller.step`
 * rather than a closed-form parabola, so friction, ground contact, the flinch
 * lockout and the hitstop are all in the measured number.
 *
 *     node --experimental-strip-types --input-type=module \
 *       -e "import {verifyCombat} from './src/game/combat.ts';
 *           console.log(verifyCombat())"
 */
export function verifyCombat(): string[] {
  const failures: string[] = [];

  // --- The cycle is 500 ms, in simulated time, through the real phase machine.
  {
    const c = createCombatant(0);
    const punch: CombatInput = { ...idleInput(), punch: true };
    let ticks = 0;
    let strikes = 0;
    let sawActive = false;
    advance(c, punch, STEP_DT, FLAT_WORLD);
    ticks++;
    if (c.phase !== 'windup') failures.push(`A punch from idle did not enter wind-up; phase is "${c.phase}".`);
    const idleAfter: CombatInput = idleInput();
    for (let i = 0; i < 200 && c.phase !== 'idle'; i++) {
      const e = advance(c, idleAfter, STEP_DT, FLAT_WORLD);
      ticks++;
      if (e.strike) strikes++;
      if (c.phase === 'active') sawActive = true;
    }
    const seconds = ticks * STEP_DT;
    if (Math.abs(seconds - PUNCH_TOTAL) > 1e-9) {
      failures.push(
        `A punch took ${(seconds * 1000).toFixed(1)} ms of simulated time; spec 8.2's ` +
          `150 + 100 + 250 is ${(PUNCH_TOTAL * 1000).toFixed(0)} ms.`,
      );
    }
    if (!sawActive) failures.push('A punch never entered its active window.');
    if (strikes !== 1) {
      failures.push(
        `A punch fired ${strikes} hit tests. It must fire exactly one, on the first tick ` +
          `of the active window, or damage becomes a function of frame rate.`,
      );
    }
  }

  // --- Reach: 1.5 m lands, 1.8 m misses. The bat's numbers, not the fist's --
  // see the constants, where the 1.55 m is measured off the real blade through
  // the real swing rather than chosen. See `hitTest`'s header for why the
  // sphere-cast alone would put the second one at 2.37 m.
  //
  // Both bounds matter and they fail differently. The near one going wrong is a
  // weapon that visibly passes through somebody without connecting; the far one
  // is a weapon that connects from outside the picture, which reads as lag.
  {
    for (const [distance, shouldHit] of [[1.5, true], [1.8, false]] as Array<[number, boolean]>) {
      const attacker = createCombatant(0, 0, distance);
      const victim = createCombatant(1, 0, 0);
      attacker.body.yaw = 0; // faces -Z, which is toward the victim
      const hit = hitTest(attacker, [victim]);
      if (shouldHit && hit === null) {
        failures.push(`A bat swing at ${distance} m missed. The reach is ${REACH} m.`);
      }
      if (!shouldHit && hit !== null) {
        failures.push(
          `A bat swing at ${distance} m landed. That is beyond the ${REACH} m reach and reads as a magnet.`,
        );
      }
    }
    // Facing away must miss whatever the distance.
    const attacker = createCombatant(0, 0, 1.0);
    attacker.body.yaw = Math.PI;
    if (hitTest(attacker, [createCombatant(1, 0, 0)]) !== null) {
      failures.push('A bat swung with the target directly behind the attacker landed.');
    }
    // Looking well over their head must miss. 40 degrees rather than the fist's
    // 31: the 0.48 m cast radius deliberately forgives more aim than a 0.4 m one
    // did, so the angle that proves the sweep is still *aiming* is a steeper one.
    // The old 31-degree case now connects, and that is the intended difference
    // between a bat and a knuckle -- see `hitTest`.
    const overhead = createCombatant(0, 0, 1.0);
    overhead.body.pitch = 0.7; // ~40 degrees up
    if (hitTest(overhead, [createCombatant(1, 0, 0)]) !== null) {
      failures.push('A bat swung 40 degrees over a target 1 m away landed. The sphere-cast is not aiming.');
    }
    // ...and the forgiveness it *is* meant to have, asserted from the other side,
    // so a future narrowing of the cast shows up here rather than as "melee feels
    // fussy".
    const nearMiss = createCombatant(0, 0, 1.0);
    nearMiss.body.pitch = 0.55; // ~31 degrees up
    if (hitTest(nearMiss, [createCombatant(1, 0, 0)]) === null) {
      failures.push(
        `A bat swung 31 degrees over a target 1 m away missed. A ${CAST_RADIUS} m cast is meant to ` +
          `forgive that much aim; at 0.4 m it did not, which is what a wider weapon buys.`,
      );
    }
    // A combatant cannot hit themselves, whatever the geometry.
    const solo = createCombatant(7, 0, 0);
    if (hitTest(solo, [solo]) !== null) failures.push('A combatant hit themselves.');
  }

  // --- Three hits is a knockout, and a knocked-out body cannot be hit again.
  {
    const attacker = createCombatant(0, 0, 1.0);
    const victim = createCombatant(1, 0, 0);
    for (let i = 0; i < MAX_HEALTH; i++) {
      const target = hitTest(attacker, [victim]);
      if (target === null) {
        failures.push(`Hit ${i + 1} of ${MAX_HEALTH} missed a stationary target at 1.0 m.`);
        break;
      }
      const report = applyHit(attacker, target);
      // Put the victim back where they were so the next hit is the same test.
      victim.body.position.set(0, EYE_HEIGHT, 0);
      victim.body.velocity.set(0, 0, 0);
      victim.hitstopT = 0;
      attacker.hitstopT = 0;
      if (i < MAX_HEALTH - 1 && report.ko) {
        failures.push(`Hit ${i + 1} knocked the victim out; ${MAX_HEALTH} pips should take ${MAX_HEALTH} hits.`);
      }
      if (i === MAX_HEALTH - 1 && !report.ko) {
        failures.push(`Hit ${MAX_HEALTH} did not knock the victim out. Health is ${victim.health}.`);
      }
    }
    if (victim.phase !== 'ko') failures.push(`A victim at 0 pips is in phase "${victim.phase}", not "ko".`);
    if (hitTest(attacker, [victim]) !== null) failures.push('A knocked-out body was still a valid target.');
  }

  // --- A knocked-out combatant is on foot, whoever knocked them out.
  //
  // The sweep in `advance`'s knockout branch, asserted against the case the four
  // clear sites cannot cover: a knockout that arrived from **outside** all of
  // them. `net/client.reconcile` adopting the server's `ko` phase is exactly
  // that on the browser side, and a bike-shaped police round or a future weapon
  // would be it on the server's. The bug this stops is a player who died on a
  // bike, kept `ridingBike` set, and therefore kept the ride's camera and its
  // HUD chip through the whole knockout -- which is what was reported.
  {
    const c = createCombatant(0);
    c.ridingBike = 17;
    c.bikeTuned = true;
    // Set directly, as `reconcile` does when the server says you are down.
    c.phase = 'ko';
    c.koT = 0;
    c.respawnT = KO_SECONDS;
    advance(c, idleInput(), STEP_DT, null);
    if (c.ridingBike !== 0) {
      failures.push(
        `A combatant put into the knockout phase from outside applyHit is still on bike ${c.ridingBike} ` +
          `after a tick. Being knocked out and being on a bike must not be able to disagree.`,
      );
    }
    if (!c.bikeTuned) {
      failures.push('The knockout cleared the Redfern unlock. It is a place you went, not a thing you were carrying.');
    }
  }

  // --- The flight. Both cases, integrated through the code that really runs.
  const live = measureFlight(false);
  const ko = measureFlight(true);
  for (const [label, m] of [['a flinching victim', live], ['a knocked-out body', ko]] as const) {
    if (m.total < 6 || m.total > 8) {
      failures.push(
        `Knockback threw ${label} ${m.total.toFixed(2)} m (${m.airborne.toFixed(2)} m of flight, ` +
          `${(m.total - m.airborne).toFixed(2)} m of skid). Spec 8.2 asks for 6-8 m of flight, ` +
          `not 1 m of stagger.`,
      );
    }
    if (m.peak < 0.5) {
      failures.push(`${label} never left the ground -- peak height ${m.peak.toFixed(2)} m.`);
    }
  }

  // --- Stamina: four punches, then locked, then a full bar 2 s later.
  {
    const c = createCombatant(0);
    const punch: CombatInput = { ...idleInput(), punch: true };
    const rest: CombatInput = idleInput();
    let thrown = 0;
    let refused = 0;
    // Six attempts, each given a full 500 ms cycle to complete.
    for (let attempt = 0; attempt < 6; attempt++) {
      const e = advance(c, punch, STEP_DT, FLAT_WORLD);
      if (e.punched) thrown++;
      if (e.outOfStamina) refused++;
      for (let i = 0; i < 29; i++) advance(c, rest, STEP_DT, FLAT_WORLD);
    }
    if (thrown !== MAX_STAMINA) {
      failures.push(`${thrown} punches were thrown back to back; spec 8.2 allows ${MAX_STAMINA}.`);
    }
    if (refused === 0) failures.push('A fifth punch was not refused. The stamina lock does nothing.');
    if (c.stamina !== 0) failures.push(`Stamina is ${c.stamina} after spending the bar; it should be 0.`);

    // Six punch cycles is 3 s of simulated time, which is past the 2 s refill --
    // so the bar has to have come back inside that loop and been spent again.
    // Check the refill directly instead, from a known-empty bar.
    const d = createCombatant(0);
    d.stamina = 0;
    d.staminaT = 0;
    for (let i = 0; i < Math.round(STAMINA_RECOVERY / STEP_DT) - 1; i++) advance(d, rest, STEP_DT, FLAT_WORLD);
    if (d.stamina !== 0) {
      failures.push(`Stamina refilled after ${(d.staminaT).toFixed(2)} s; spec 8.2 says ${STAMINA_RECOVERY} s.`);
    }
    advance(d, rest, STEP_DT, FLAT_WORLD);
    advance(d, rest, STEP_DT, FLAT_WORLD);
    if (d.stamina !== MAX_STAMINA) {
      failures.push(`Stamina is ${d.stamina} after ${STAMINA_RECOVERY} s of not punching; it should be ${MAX_STAMINA}.`);
    }
  }

  // --- The footy supply: a floor between throws, a hard stop at three, and one
  // ball back every four seconds.
  //
  // The bar lives in this file even though the ball does not (see the constants),
  // so it is checked here. Every failure is silent in the repo's sense: a floor
  // that does nothing is three balls in one frame, which is the click-spam the
  // stamina bar exists to prevent reintroduced by a second weapon; a refill that
  // fires the whole bar at once is a different resource from the one the header
  // argues for; and a refill that never fires is a weapon that works once.
  {
    const c = createCombatant(0);
    const throwing: CombatInput = { ...idleInput(), throwBall: true };
    const rest: CombatInput = idleInput();
    let thrown = 0;
    let refused = 0;
    let seconds = 0;
    let thirdAt = 0;
    for (let i = 0; i < Math.round(10 / STEP_DT); i++) {
      const e = advance(c, throwing, STEP_DT, FLAT_WORLD);
      if (e.ballThrown) {
        thrown++;
        if (thrown === 3) thirdAt = seconds;
      }
      if (e.ballRefused) refused++;
      seconds += STEP_DT;
    }
    if (refused === 0) {
      failures.push('Holding the throw button never refused a ball. The supply bar does nothing.');
    }
    // Three balls at a 0.55 s floor puts the third 1.10 s after the first, which
    // is thrown on tick 0.
    if (Math.abs(thirdAt - BALL_COOLDOWN * 2) > 0.05) {
      failures.push(
        `The third ball came ${thirdAt.toFixed(2)} s after the first; a ${BALL_COOLDOWN} s floor ` +
          `between throws makes that ${(BALL_COOLDOWN * 2).toFixed(2)} s.`,
      );
    }
    // Ten seconds of held button is 600 ticks. The floor alone would allow
    // eighteen; the bar plus the 4 s-per-ball refill caps it near five.
    if (thrown > 7) {
      failures.push(`Holding the throw button for 10 s threw ${thrown} balls. The bar is not limiting anything.`);
    }

    // The refill, from a known-empty bar, and the thing that distinguishes it
    // from the stamina bar: **one** ball back, not three.
    const d = createCombatant(1);
    d.ballCharges = 0;
    d.ballT = 0;
    for (let i = 0; i < Math.round(BALL_RECHARGE / STEP_DT) - 1; i++) advance(d, rest, STEP_DT, FLAT_WORLD);
    if (d.ballCharges !== 0) {
      failures.push(`The supply refilled after ${d.ballT.toFixed(2)} s; the recharge is ${BALL_RECHARGE} s a ball.`);
    }
    advance(d, rest, STEP_DT, FLAT_WORLD);
    advance(d, rest, STEP_DT, FLAT_WORLD);
    if (d.ballCharges !== 1) {
      failures.push(
        `The bar holds ${d.ballCharges} balls after one ${BALL_RECHARGE} s recharge; it should hold 1. ` +
          `A whole-bar refill is the stamina bar's rule and deliberately not this one.`,
      );
    }
    // ...and it keeps going, to the cap and no further.
    for (let i = 0; i < Math.round((BALL_RECHARGE * 3) / STEP_DT); i++) advance(d, rest, STEP_DT, FLAT_WORLD);
    if (d.ballCharges !== BALL_CHARGES) {
      failures.push(`The bar holds ${d.ballCharges} balls after 16 s of not throwing; the cap is ${BALL_CHARGES}.`);
    }
    // And the clock is pinned at the cap, so a long quiet spell does not bank
    // credit that would come back as three instant refills after a burst.
    if (d.ballT > BALL_RECHARGE + 1e-6) {
      failures.push(
        `A combatant who has not thrown for 16 s has banked ${d.ballT.toFixed(1)} s of refill ` +
          `credit. The clock has to be pinned at the cap.`,
      );
    }
  }

  // --- Hitstop stops one clock and no others.
  {
    const attacker = createCombatant(0, 0, 1.0);
    const victim = createCombatant(1, 0, 0);
    const bystander = createCombatant(2, 50, 50);
    applyHit(attacker, victim);
    if (attacker.hitstopT <= 0 || victim.hitstopT <= 0) {
      failures.push('A landed hit did not put both parties into hitstop.');
    }
    const victimAt = victim.body.position.clone();
    const bystanderClock = bystander.staminaT;
    const rest = idleInput();
    // Run until the hitstop is spent rather than for a computed count: 90 ms is
    // 5.4 ticks at 60 Hz, so "how many frames is 90 ms" has no integer answer and
    // the honest test is to wait for the state to say it is over.
    let frozen = 0;
    while (victim.hitstopT > 0 && frozen < 20) {
      advance(victim, rest, STEP_DT, FLAT_WORLD);
      advance(bystander, rest, STEP_DT, FLAT_WORLD);
      frozen++;
    }
    if (frozen !== Math.ceil(HITSTOP / STEP_DT)) {
      failures.push(`Hitstop lasted ${frozen} ticks; ${HITSTOP * 1000} ms at ${1 / STEP_DT} Hz is ${Math.ceil(HITSTOP / STEP_DT)}.`);
    }
    if (victim.body.position.distanceTo(victimAt) > 1e-9) {
      failures.push('A combatant in hitstop moved. Their simulated dt must be zero.');
    }
    // The bystander is on flat ground and does not move, so what proves their
    // clock ran is that it ran -- and that is the whole claim being tested, that
    // hitstop is one combatant's timescale rather than the world's.
    if (Math.abs(bystander.staminaT - (bystanderClock + frozen * STEP_DT)) > 1e-9) {
      failures.push("A bystander's clock stopped during someone else's hitstop. Hitstop must not be global.");
    }
    advance(victim, rest, STEP_DT, FLAT_WORLD);
    if (victim.body.position.distanceTo(victimAt) < 1e-6) {
      failures.push(`A victim did not start moving after ${HITSTOP * 1000} ms of hitstop.`);
    }
  }

  // --- A knockout ends in a respawn at full health.
  {
    const attacker = createCombatant(0, 0, 1.0);
    const victim = createCombatant(1, 0, 0);
    victim.health = 1;
    applyHit(attacker, victim);
    victim.hitstopT = 0;
    const rest = idleInput();
    let respawned = false;
    let ticks = 0;
    for (let i = 0; i < 400; i++) {
      const e = advance(victim, rest, STEP_DT, FLAT_WORLD);
      ticks++;
      if (e.respawnDue) {
        respawned = true;
        break;
      }
    }
    if (!respawned) failures.push('A knocked-out combatant never asked to respawn.');
    const seconds = ticks * STEP_DT;
    if (Math.abs(seconds - KO_SECONDS) > 0.02) {
      failures.push(`The knockout lasted ${seconds.toFixed(2)} s; spec 8.2 says ${KO_SECONDS} s.`);
    }
    respawnAt(victim, 12, 3, -8, 1.2);
    if (victim.health !== MAX_HEALTH || victim.stamina !== MAX_STAMINA) {
      failures.push(`A respawned combatant has ${victim.health} pips and ${victim.stamina} stamina; both should be full.`);
    }
    if (victim.phase !== 'idle' || victim.koT !== 0) {
      failures.push(`A respawned combatant is in phase "${victim.phase}" with koT ${victim.koT}.`);
    }
    if (Math.abs(victim.body.position.y - (3 + EYE_HEIGHT)) > 1e-6) {
      failures.push('A respawn placed the eye at the ground height rather than an eye height above it.');
    }
  }

  return failures;
}

/**
 * Throw a combatant with a real punch and follow them until they stop.
 *
 * Everything is in the loop on purpose: the hitstop, the flinch lockout, the
 * controller's air and ground friction, and -- in the knockout case -- the
 * ragdoll integrator, which is a different code path with a different friction
 * and therefore a separate measurement.
 */
function measureFlight(knockout: boolean): { total: number; airborne: number; peak: number } {
  const attacker = createCombatant(0, 0, 1.0);
  const victim = createCombatant(1, 0, 0);
  if (knockout) victim.health = 1;
  applyHit(attacker, victim);

  const startX = victim.body.position.x;
  const startZ = victim.body.position.z;
  const rest = idleInput();
  let airborne = 0;
  let peak = 0;
  let landed = false;

  for (let i = 0; i < 600; i++) {
    advance(victim, rest, STEP_DT, FLAT_WORLD);
    peak = Math.max(peak, victim.body.position.y - EYE_HEIGHT);
    if (!landed && victim.body.onGround && i > 2) {
      landed = true;
      airborne = Math.hypot(victim.body.position.x - startX, victim.body.position.z - startZ);
    }
    if (landed && planSpeed(victim) < 0.05) break;
    // Stop before the respawn fires, or the measurement follows a teleport.
    if (victim.phase === 'ko' && victim.koT >= KO_SECONDS - STEP_DT * 2) break;
  }

  const total = Math.hypot(victim.body.position.x - startX, victim.body.position.z - startZ);
  return { total, airborne: landed ? airborne : total, peak };
}
