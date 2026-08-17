/**
 * Heat: five stars, and the city answers.
 *
 * ===========================================================================
 * THE DESIGN. Read this before touching a number below it.
 * ===========================================================================
 *
 * Before this file, "wanted" was a **boolean with a clock on it**: you did one
 * of five things, `game/factions.ts` opened an investigation, four officers came
 * and shot at you for forty-five seconds, and then they went home. That is a
 * good feature and it is still underneath all of this -- `MSG.INVESTIGATION` is
 * untouched and the banner it draws is now exactly the 1-star rung of a ladder.
 * What it could not do is *escalate*. Batting a bystander and knocking out three
 * officers in a row produced the identical response, which meant the only thing
 * a player could learn about the police was how long to hide.
 *
 * So: a **graded ladder**, `heat` in 0..5 stars, per player.
 *
 * ---------------------------------------------------------------------------
 * 1. THE ACQUISITION STRUCTURE, which is the part that is actually designed.
 *
 * Stars are not set; they are *read off* a hidden `wantedPoints`. That
 * indirection is the whole structure and it buys three things that a `stars++`
 * on every crime cannot:
 *
 *   - **Crimes have different weights.** Hitting a bystander and knocking out a
 *     constable are not the same event and must not cost the same rung.
 *   - **Small crimes accumulate into big ones.** Two bystanders is a 2-star
 *     response with no rule anywhere that says "two bystanders is 2 stars" --
 *     it falls out of 130 + 130 crossing the 250 line. Three is 3 stars, which
 *     is the brief's *"3+ crimes in a minute"* with no minute-long window to
 *     keep, because the points already decay on their own clock.
 *   - **Decay is continuous.** A ladder made of integers has to decide what
 *     "half a star" means; a ladder made of points has an answer already.
 *
 *     STAR_POINTS = [0, 100, 250, 380, 620, 900]
 *
 *   crime                                     points   lands you on
 *   ---------------------------------------------------------------------
 *   assault a bystander / tuned ride-by /       130     1 star
 *   harming wildlife
 *   the same again, while still at 1 star       260     2 stars
 *   steal a car / assault police /              260     2 stars
 *   dangerous driving / affray / evade an RBT
 *   knock out a police officer                  380     3 stars
 *   ...and a second officer                     760     4 stars
 *   ...and a third                             1140     5 stars (capped)
 *
 * Every one of the brief's rungs is a consequence of those two tables rather
 * than a rule of its own, which is the property worth keeping: a tuning pass
 * here is a diff of numbers, exactly as `game/factions.ts` promises of its own.
 *
 * The two rungs that are *not* points are the two the brief states as time:
 * ninety seconds at 3 stars promotes you to 4, and ninety at 4 promotes you to
 * 5. Those are written as a push of `points` up to the next threshold rather
 * than as a separate "forced tier", so there is still exactly one thing in this
 * file that decides what your star count is.
 *
 * **A crime nobody saw is not a crime.** This file does not re-implement that
 * rule and deliberately does not own it: every path into `FactionField.accuse`
 * already passes its own faction's witness test before it gets there --
 * `server/sim.reportIfWitnessed` runs `policeWitness`, `main.ts`'s `accuse`
 * runs the same one, assaulting an officer needs no witness because the officer
 * *is* the witness, and wildlife is unconditional on purpose (see
 * `game/wildlife.ts` section 3 and `server/sim.hitNpc`, which both argue it at
 * length). Putting a second witness test here would mean two answers to one
 * question, and the second one would be asked a tick later against a player who
 * has since run round a corner. So heat hooks `accuse` -- the one funnel every
 * adjudicated crime already flows through -- and `factions.addWitnessedCrime`
 * is the named door for a faction whose witness is a *bystander* rather than a
 * constable, which is the shape the characters workstream's Karen needs.
 *
 * ---------------------------------------------------------------------------
 * 2. DECAY, and why hiding is the verb.
 *
 * Points fall **only while no police actor has had line of sight for
 * `HIDDEN_TICKS`** -- eight seconds. That is one number and it is doing the
 * work of a whole mechanic: standing still in an alley for eight seconds is a
 * decision, and eight seconds is long enough that you cannot make it by
 * accident while running past a squad car.
 *
 * Once the drain starts, each tier takes progressively longer to shed:
 *
 *     1 star   20 s      3 stars   70 s       5 stars  150 s
 *     2 stars  40 s      4 stars  100 s
 *
 * The rate is *per tier* -- `(STAR_POINTS[n] - STAR_POINTS[n-1]) / SHED[n]`
 * points a second -- so falling from exactly the threshold of tier n to tier
 * n-1 takes exactly `SHED[n]` seconds, and a player who over-earned their stars
 * pays for the excess on top. Which is right: three officers down is a longer
 * hide than one.
 *
 * The witness query is `factions.policeWitness`, the same one that decides
 * whether a crime was seen. There is one answer in this build to "can a cop see
 * this" and a second implementation of it would be a second answer.
 *
 * ---------------------------------------------------------------------------
 * 3. THE TRAIN IS THE GETAWAY, and that is a design statement rather than an
 *    optimisation.
 *
 * This game has a real, timetabled, city-wide railway (`game/rail.ts`,
 * `game/riding.ts`) and until now it was scenery you could stand inside. So:
 *
 *   - **Boarding halves your remaining points on the spot.** Doors closing on a
 *     pursuit is the single most cinematic thing available in this world and it
 *     should pay immediately, not eight seconds later.
 *   - **Every station the train then pulls out of sheds a whole star.**
 *
 * A player at 4 stars who makes it onto a Bankstown service is at 2 by Sydenham,
 * which is a *route through the game* rather than a cooldown. It also gives the
 * rail network a job in the fiction: the police do not follow you onto a train,
 * because there is no version of this build where they could, and the honest
 * way to model an authority that cannot follow you is to let the network be a
 * hole in it.
 *
 * The bookkeeping is deliberately minimal -- `rideStop`, one integer per player
 * -- because the authority already knows all of this and this file must not
 * grow a second copy of the ride state. See `HeatWorld.rideStop`.
 *
 * ---------------------------------------------------------------------------
 * 4. WHAT ARRIVES AT EACH RUNG.
 *
 *   1 star   The existing feature: officers shout, walk at you, no shooting.
 *            The `MSG.INVESTIGATION` banner is this rung and keeps its wording.
 *   2 stars  Today's pursuit -- they run and they shoot. Unchanged.
 *   3 stars  **Highway Patrol.** `NPC_KIND.HIGHWAY_PATROL`, a promoted actor
 *            that is a *car*: it drives the road graph at you, knocks you down
 *            on contact the way traffic does, and puts two officers out when it
 *            stops near you.
 *   4 stars  **An RBT.** A breath-testing station across the road ahead of you,
 *            deterministically placed from where you were and which way you
 *            were facing on the tick the rung was reached. Driving through it
 *            is `REASON.RBT_EVADE`. Stopping at it and standing still is worse.
 *   5 stars  **Polair.** A helicopter on a wide, lagging orbit 180-260 m up,
 *            a searchlight that hunts you rather than holding you, every
 *            officer inside 300 m converging -- and a marksman who takes one
 *            badly-aimed shot at you each time the beam finds you. The orbit,
 *            the beam schedule and the shot schedule are all
 *            `game/polair.ts`, which is three-free and which this file steps;
 *            the airframe, the light and the puffs of grit are
 *            `world/highway-patrol.ts`. Nothing about any of it is on the wire.
 *
 * ---------------------------------------------------------------------------
 * 5. WHAT IS IN THIS FILE AND WHAT IS NOT.
 *
 * This file is **three-free** and is imported by the Bun server. It owns the
 * ladder, the two new actor kinds and their behaviour, and nothing that can be
 * seen. The patrol car's body, the light bar, the witches' hats and the Polair
 * cone are `client/src/world/highway-patrol.ts`, which is a renderer and imports
 * `three`. That is `game/bikes.ts` vs `world/bike.ts`, restated.
 *
 * The two kinds' `think` are **empty on purpose** and every one of their
 * decisions is made in `stepHeat`. `NpcKindDef.think` may not hold state between
 * calls -- see `factions.ts`'s own rule -- and a pursuit car genuinely needs
 * state: the lane waypoint it is steering at, re-picked four times a second
 * rather than sixty, because scanning the lane polylines around a car is the
 * one thing in this feature that could cost a 1 vCPU box a millisecond. That
 * state lives on `HeatField`, which is the authority's object and is exactly
 * where `server/sim.ts` keeps everything else of the sort.
 *
 * ---------------------------------------------------------------------------
 * 6. DETERMINISM. `game/factions.ts`'s rule 5 applies here unchanged: no
 * `Math.hypot`, no `sin`/`cos`/`atan2` on anything compared across the wire,
 * every random choice out of `traffic.carHash`.
 *
 * There is exactly one `Math.sin`/`Math.cos` pair in this file, in
 * `placeRbt`, turning the player's yaw into the direction they were facing. It
 * is safe because it is **authority-only and its result is transmitted**: the
 * RBT is a promoted actor, so the position this computes crosses the wire as a
 * position and no client ever recomputes it. The comment at the call site says
 * so, because the next person to copy that line somewhere else will not have
 * read this paragraph.
 *
 * ---------------------------------------------------------------------------
 * 7. SERVER BUDGET. Everything here is O(wanted players), which in practice is
 * zero: `step` returns on its first line when nobody is wanted, which is the
 * state a room is in almost all of the time. Patrol cars and RBTs are promoted
 * actors under the shared `factions.MAX_ACTORS` cap and are spawned at most one
 * per player per rung, so a room of sixteen cannot ask for more than the cap
 * gives -- `FactionField.promote` refuses and this file treats a refusal as
 * "not this tick", which is the state `factions.ts`' contract tells every
 * caller to design for.
 */

import { type CombatantState } from './combat.ts';
import {
  MAX_ACTORS,
  NPC_KIND,
  NPC_STATE,
  REASON,
  createWitness,
  npcKind,
  onCrime,
  policeWitness,
  registerNpcKind,
  setHeatReader,
  type FactionCtx,
  type FactionField,
  type NpcActor,
  type Witness,
} from './factions.ts';
import { createBeatPose, forEachPoliceNear, SHOT_DAMAGE, type BeatPose } from './factions.ts';
import { createPedPose, type PedBand, type PedPose } from './pedestrians.ts';
// The fifth rung's geometry and schedule. Three-free, so this file stays
// importable by the Bun server, and every function in it is pure except the
// trail -- see its header, section 3, for why the *hit* is decided here and the
// *presentation* is recomputed on the client rather than sent.
import {
  PolairTrail,
  createPolairPose,
  polairCycle,
  polairHitChance,
  polairPose,
  polairRoll,
  polairShotFired,
  type PolairPose,
} from './polair.ts';
import { carHash, type LaneRoute, type TrafficField } from './traffic.ts';

// --- The ladder ------------------------------------------------------------------

/** Stars run 0..5. The wire carries this as one byte; see `protocol.encodeHeat`. */
export const HEAT_MAX = 5;

/**
 * Points at which each star lights up. Index is the star count.
 *
 * Read the header's table before moving one of these: every rung the brief
 * describes is an *arithmetic consequence* of this array and `CRIME_POINTS`
 * together, so a change here silently redefines what "two bystanders" means.
 * `verifyHeat` asserts the consequences rather than the numbers, which is the
 * only way to keep that true.
 */
export const STAR_POINTS: readonly number[] = [0, 100, 250, 380, 620, 900];

/**
 * Points a player may bank, ceiling.
 *
 * Without one, a spree at 5 stars keeps banking and the hide afterwards is
 * unbounded -- fifteen minutes of drain for a player who is already at the top
 * rung and cannot get any more wanted. 1,400 is 900 plus one and a bit officers'
 * worth of headroom, so the top of the ladder still costs more to shed than the
 * bare threshold does and it still ends.
 */
export const HEAT_POINTS_CAP = 1400;

/**
 * What each `factions.REASON` is worth.
 *
 * Three tiers of value and nothing in between, because the *thresholds* are
 * where the design lives and a table of eleven distinct numbers would be eleven
 * things to retune every time one line moved. A reason with no row here scores
 * `CRIME_POINTS_DEFAULT`, which is the bystander tier -- the safe direction to
 * be wrong in for a reason a future faction invents.
 */
export const CRIME_POINTS: Readonly<Record<number, number>> = {
  [REASON.ASSAULT]: 130,
  [REASON.BIKE]: 130,
  [REASON.WILDLIFE]: 130,
  [REASON.ASSAULT_POLICE]: 260,
  [REASON.AFFRAY]: 260,
  [REASON.CAR_THEFT]: 260,
  [REASON.DANGEROUS_DRIVING]: 260,
  [REASON.RBT_EVADE]: 260,
  [REASON.MURDER_POLICE]: 380,
};
export const CRIME_POINTS_DEFAULT = 130;

export function crimePoints(reason: number): number {
  return CRIME_POINTS[reason] ?? CRIME_POINTS_DEFAULT;
}

/**
 * How long you have to be out of every officer's sight before points fall,
 * ticks. Eight seconds.
 *
 * A *threshold* rather than a ramp, and the choice is about legibility: a
 * gradual decay that started the instant you broke line of sight would be
 * invisible to a player, who cannot see the points. Eight seconds of nothing
 * and then a star that visibly starts to go is a thing you can learn by doing
 * it once.
 */
export const HIDDEN_TICKS = 8 * 60;

/**
 * Seconds of hidden time to shed one whole tier, indexed by the tier being
 * shed. Index 0 is unused and is 0 so the array reads as a ladder.
 *
 * The brief's numbers. The shape matters more than any one of them: it is
 * super-linear, so the top of the ladder is not merely higher, it is *stickier*,
 * and a player who reached 5 stars has committed to a much longer quiet period
 * than one who reached 2. That is what stops the ladder being a treadmill you
 * can ride up and down inside one street.
 */
export const SHED_SECONDS: readonly number[] = [0, 20, 40, 70, 100, 150];

/**
 * How long at 3 or 4 stars before the next rung arrives on its own, ticks.
 *
 * The brief's *"or run for 90 s at 3 stars"*. It exists because the points
 * ladder alone would let a player sit at 3 stars indefinitely by simply not
 * committing any more crimes while outrunning the pursuit, and the whole
 * promise of the top two rungs is that they are what happens when the pursuit
 * *fails*. Applied as a push of points to the next threshold rather than as a
 * separate forced tier -- see the header.
 */
export const TIER_TIMEOUT_TICKS = 90 * 60;

/**
 * Points that survive boarding a train, as a fraction. See header section 3.
 *
 * A half rather than a fixed subtraction, so it is worth the same *proportion*
 * at every rung: a 5-star player is not made safe by one boarding and a 1-star
 * player is very nearly clean.
 */
export const TRAIN_BOARD_KEEP = 0.5;

// --- The two new kinds -----------------------------------------------------------

/**
 * How far in front of the suspect a patrol car is put on the road, metres.
 *
 * Far enough to arrive rather than appear -- a car that materialised at 30 m
 * would read as a spawn, which is the exact complaint `factions.recruit`'s
 * station trickle already answers on foot -- and near enough that it reaches
 * you inside the ninety seconds the 4-star timer gives it.
 */
export const PATROL_SPAWN_M = 140;
/** And the furthest a spawn search will look for a lane to put it on. */
export const PATROL_SPAWN_MAX_M = 260;

/** How fast the highway patrol drives, m/s. 90 km/h; it is a chase, not a commute. */
export const PATROL_SPEED = 25;
/** How hard it may turn, radians a second, at speed. A sedan, not a tank. */
export const PATROL_TURN_RATE = 1.6;
/** Inside this it stops and the officers get out, metres. The brief's number. */
export const PATROL_STOP_M = 20;
/** Contact radius for the knockdown, metres. Half a car's length plus a body. */
export const PATROL_HIT_M = 2.6;
/** Ticks between lane-waypoint re-picks. Four times a second; see header section 5. */
export const PATROL_REPICK_TICKS = 15;
/** How far around itself a car looks for the lane graph, metres. */
export const PATROL_LANE_REACH = 70;
/** One patrol car per suspect. Two is a roadblock nobody asked for. */
export const PATROL_CARS_PER_SUSPECT = 1;

/**
 * How far ahead of the player the RBT goes, metres, and how far off the ideal
 * spot a road may be and still take it.
 *
 * A hundred and fifty is the brief's number and it is the right one for a
 * reason worth writing down: it has to be beyond the draw distance of a glance
 * -- so it is *found*, not watched being built -- and inside the distance a
 * player running or driving covers in twenty seconds, so it is a wall you hit
 * rather than a rumour.
 */
export const RBT_AHEAD_M = 150;
export const RBT_SEARCH_M = 90;
/** How long you have to stand still at one before they take you, seconds. */
export const RBT_STAND_SECONDS = 5;
/** How near counts as "at the RBT", metres, and how still counts as still, m/s. */
export const RBT_STAND_M = 14;
export const RBT_STILL_SPEED = 0.6;
/** Driving through one: contact radius, metres. Wider than the car -- it is a line of cones. */
export const RBT_LINE_HALF_M = 7;

/** Every officer inside this converges once Polair has you, metres. The brief's number. */
export const POLAIR_CONVERGE_M = 300;
/** And how many it will pull in, over the ordinary pursuit target. */
export const POLAIR_PURSUIT_TARGET = 8;

/**
 * The marksman's damage, in pips. **The ground officers' own number.**
 *
 * `factions.SHOT_DAMAGE` rather than a constant of its own, and the reuse is the
 * design: a round is a round. What makes the helicopter a lesser threat than a
 * constable is that it *misses* -- see `polair.polairHitChance`, about 8% falling
 * to 2% against a constable's 55% at fifteen metres -- and not that its rounds
 * are made of foam. A separate, smaller damage would have been two dials
 * expressing one intent, and the honest one to turn is the accuracy.
 */
export const POLAIR_SHOT_DAMAGE = SHOT_DAMAGE;

/** The patrol car's capsule, for `strikeNpc` and the shot test. A sedan on its side. */
const PATROL_RADIUS = 1.15;
const PATROL_HEIGHT = 1.5;
/** Pips. Six bat swings to stop a car, which is about right for a car. */
const PATROL_MAX_HEALTH = 6;

/**
 * The highway patrol car, registered as an NPC kind.
 *
 * A **kind rather than a new entity class**, which is the decision this
 * registration is. A car with a driver is not a person, and the temptation was
 * to give it its own field, its own wire section and its own renderer roster --
 * which is exactly what `game/bikes.ts` is and is the right shape for a thing
 * the *player* can occupy. This one nobody occupies: it exists to arrive, hit
 * you and stop. Everything a promoted actor already gets -- an id, a position on
 * the wire at 18 bytes, health, the shared eviction cap, `strikeNpc`'s re-hit
 * guard, a feed line -- is everything it needs, and taking it costs one byte out
 * of a table with 249 spare.
 *
 * `think` is empty. See the header, section 5.
 */
export const HIGHWAY_PATROL = registerNpcKind({
  kind: NPC_KIND.HIGHWAY_PATROL,
  name: 'highway patrol',
  radius: PATROL_RADIUS,
  height: PATROL_HEIGHT,
  maxHealth: PATROL_MAX_HEALTH,
  // Not used -- `stepHeat` drives these -- but they are the contract's fields
  // and a kind that lied about them would mislead anything that reads the
  // registry to decide how fast something moves.
  walkSpeed: 0,
  chaseSpeed: PATROL_SPEED,
  downSeconds: 12,
  // No voice. A siren is not a bark: it is continuous, it is positional, and it
  // is synthesised in `game/audio.ts` rather than fetched -- see `sirenUpdate`
  // there. `aggroClips` is the *clip* path and putting a loop in it would play
  // a one-shot of a siren every seven seconds, which is worse than silence.
  aggroClips: [],
  aggroCooldownSeconds: 0,
  feedKo: '%s got cleaned up by the highway patrol',
  scoresKo: false,
  think() {
    // Deliberately empty. See the header, section 5.
  },
});

/**
 * The RBT: one actor that *is* the whole breath-testing station.
 *
 * One actor rather than "a car, two officers and eight witches' hats", and the
 * split is worth stating because it is not the obvious one. The **two officers
 * are real promoted `POLICE` actors** placed beside this one, because they have
 * to be hittable, they have to be drawn by `world/police.PoliceSquad` (which
 * already draws every officer in the city and would have to grow a case
 * otherwise), and because an officer you cannot hit is the one thing in this
 * game that reads as scenery. The **car and the cones are this actor**, drawn by
 * `world/highway-patrol.ts` off its position and heading, because eight cones
 * are eight positions that are a pure function of one position and putting them
 * on the wire would be paying 18 bytes each to say what the client can derive.
 */
const RBT_RADIUS = 1.15;
const RBT_HEIGHT = 1.5;

export const RBT = registerNpcKind({
  kind: NPC_KIND.RBT,
  name: 'rbt',
  radius: RBT_RADIUS,
  height: RBT_HEIGHT,
  // A wall. Six pips like the patrol car, and it never moves, so this is only
  // ever "how long does it take to bat your way through the sign".
  maxHealth: 6,
  walkSpeed: 0,
  chaseSpeed: 0,
  downSeconds: 20,
  aggroClips: [],
  aggroCooldownSeconds: 0,
  // The brief's line, and it is the joke: nobody has ever passed one.
  feedKo: '%s blew over at the rbt',
  scoresKo: false,
  think() {
    // Deliberately empty. See the header, section 5.
  },
});

// --- One player's standing --------------------------------------------------------

/** What the wire carries per wanted player. See `protocol.encodeHeat`. */
export interface HeatRecord {
  playerId: number;
  stars: number;
  /**
   * The tick this player's current star would be shed on if they stayed hidden,
   * or **0 while the police can still see them**.
   *
   * Zero rather than "a long way away" because the difference the HUD wants to
   * draw is categorical -- are they still on me, or am I getting away -- and a
   * client that had to compare a tick against a threshold to answer that would
   * be re-deriving a decision the authority already made.
   */
  decayEndsTick: number;
}

/** Everything the authority knows about one player's heat. Never on the wire whole. */
interface HeatState {
  playerId: number;
  /** The hidden ladder. See the header. */
  points: number;
  /** `points` read through `STAR_POINTS`, cached so a change is an edge. */
  stars: number;
  /** Consecutive ticks with no officer in line of sight. */
  hiddenTicks: number;
  /** Ticks at the current star count. Drives the 3->4 and 4->5 timers. */
  tierTicks: number;
  /** What `HeatRecord.decayEndsTick` last read. */
  decayEndsTick: number;
  /**
   * The stop index this player's train was last standing at, or -1 while it is
   * moving, or -2 while they are on foot. The train getaway's whole memory.
   */
  rideStop: number;
  /** Whether they were aboard anything last tick, for the boarding edge. */
  aboard: boolean;
  /** The RBT actor placed for this player, or 0. One at a time. */
  rbtActor: number;
  /**
   * The two officers manning it, and where their posts are.
   *
   * Held here because they have to be **pinned**. A promoted `POLICE` actor
   * with a live investigation against it runs at the suspect -- that is the
   * whole of `factions.POLICE.think` and it is correct for every other officer
   * in the game -- so two constables posted at a roadblock 150 m up the road
   * abandon it on the tick they are created and sprint at you, which leaves an
   * unmanned line of witches' hats and two more ordinary pursuers.
   *
   * The alternative was a "stationed" state inside `factions.POLICE.think`.
   * That file is being edited by three other workstreams in this batch and a
   * new branch in the police brain is the single worst place to put a merge
   * conflict, so the pin lives here: `stepRbts` puts them back on their posts
   * every tick until the suspect is close enough that holding the line stops
   * being the point. Everything else about them -- being hittable, being drawn
   * by `world/police.PoliceSquad`, aiming and firing as you come up the road --
   * is the ordinary officer behaviour, unchanged.
   */
  rbtOfficers: number[];
  rbtPosts: number[];
  /** Ticks the player has been standing still at their own RBT. */
  rbtStandTicks: number;
  /** Patrol car actors chasing this player. Ids; length is the count. */
  cars: number[];
  /**
   * Where this player has been, for Polair's orbit to lag behind. **Null unless
   * they are at the top rung.**
   *
   * Created on the tick they reach five stars and dropped the tick they leave
   * it, which is what keeps the memory bounded by the number of people currently
   * at the top of the ladder rather than by everybody who ever was -- the same
   * bargain `cars` and `rbtActor` already make one field up. Twenty slots of
   * three floats is 240 bytes, so a room of sixteen simultaneous five-star
   * players is under four kilobytes and the 1 GB box does not notice.
   *
   * It is also the **only** state this feature has: everything else about the
   * helicopter is a pure function of `(playerId, tick)` and of this. See
   * `game/polair.ts` section 6.
   */
  polairTrail: PolairTrail | null;
}

function createHeatState(playerId: number): HeatState {
  return {
    playerId,
    points: 0,
    stars: 0,
    hiddenTicks: 0,
    tierTicks: 0,
    decayEndsTick: 0,
    rideStop: -2,
    aboard: false,
    rbtActor: 0,
    rbtOfficers: [],
    rbtPosts: [],
    rbtStandTicks: 0,
    cars: [],
    polairTrail: null,
  };
}

/** The star count a point total reads as. The one place the ladder is read. */
export function starsFor(points: number): number {
  let n = 0;
  for (let i = 1; i < STAR_POINTS.length; i++) {
    if (points >= STAR_POINTS[i]) n = i;
  }
  return n;
}

/** Points a tier sheds per tick while hidden. See the header, section 2. */
export function shedPerTick(stars: number): number {
  if (stars <= 0 || stars >= STAR_POINTS.length) return 0;
  const span = STAR_POINTS[stars] - STAR_POINTS[stars - 1];
  const seconds = SHED_SECONDS[stars] ?? SHED_SECONDS[SHED_SECONDS.length - 1];
  if (seconds <= 0) return span;
  return span / (seconds * 60);
}

// --- The pursuit car's private state ---------------------------------------------

/**
 * Where one patrol car is steering, and how fast.
 *
 * Held here rather than on `NpcActor` for the reason `factions.NpcActor` states
 * about `seen`: that record is the **wire's** shape, eighteen bytes of it are
 * encoded per snapshot, and a heading it does not need is a field every future
 * reader has to be told to ignore. The car's *pose* -- position and unit heading
 * -- is on the actor and is what the renderer draws; the steering is the
 * authority's business alone.
 */
interface CarDrive {
  /** The lane point being steered at, world metres. */
  wx: number;
  wz: number;
  /** The tick the waypoint was last chosen. See `PATROL_REPICK_TICKS`. */
  pickedAt: number;
  /** Metres a second, ramped rather than stepped. */
  speed: number;
  /** Whether it has stopped and put its officers out. Once only. */
  disgorged: boolean;
}

// --- The field ----------------------------------------------------------------------

/**
 * Every player's heat, and everything the ladder has put in the world.
 *
 * One object on the authority, beside `FactionField`, and a connected client
 * holds **none of this** -- it is told the star count and nothing else, exactly
 * as it is told an investigation and not the countdown's internals. See
 * `protocol.encodeHeat`.
 */
export class HeatField {
  private readonly heat = new Map<number, HeatState>();
  private readonly drives = new Map<number, CarDrive>();

  /**
   * Bumped whenever any player's star count changes.
   *
   * `server/sim.investigationVersion`'s twin, watched by the transport rather
   * than pushed, and for the identical reason: it keeps a broadcast out of the
   * simulation. The **decay clock deliberately does not bump it** -- it moves
   * every tick -- so the channel rides a slow refresh and the client keeps its
   * own clock between messages, which is `protocol.encodeInvestigations`' whole
   * argument reused.
   */
  version = 0;

  /** Crimes reported since the last step, drained by it. See `onCrime`. */
  private readonly pending: Array<{ playerId: number; reason: number; witness: number }> = [];

  /** Diagnostics for the overlay. */
  patrolCarsSpawned = 0;
  rbtsPlaced = 0;
  /** Rounds Polair has fired, and how many of them landed. The overlay and the check. */
  polairShots = 0;
  polairHits = 0;

  // Scratch, allocated once for the life of the field. `step` allocates nothing.
  private readonly bands: PedBand[] = [];
  private readonly ped: PedPose = createPedPose();
  private readonly beat: BeatPose = createBeatPose();
  private readonly witness: Witness = createWitness();
  private readonly routes: LaneRoute[] = [];
  /**
   * Polair's pose, and the record `damagePlayer` is handed when a round lands.
   *
   * **One of each for the whole field**, which is `sim.ts`' own reuse pattern:
   * `stepPolair` fills the pose, reads it and is done with it inside one
   * iteration, so four five-star players share one record and the step allocates
   * nothing. The actor is a *stand-in* rather than a promoted one -- it is never
   * in `field.actors`, never encoded, never hittable -- and it exists because
   * `FactionCtx.damagePlayer` takes an `NpcActor` and reads exactly one field off
   * it: `kind`, for the kill-feed line. `NPC_KIND.POLICE` is the right answer to
   * "who did this" and gives "got done by the cops", which is what being shot out
   * of a helicopter by the police is. See `verifyHeat`, which still asserts that
   * `NPC_KIND.POLAIR` is *not* registered: this is not a helicopter on the wire
   * and must not become one by accident.
   */
  private readonly polair: PolairPose = createPolairPose();
  private readonly marksman: NpcActor = {
    id: 0,
    kind: NPC_KIND.POLICE,
    x: 0, y: 0, z: 0, dx: 0, dz: 1,
    state: NPC_STATE.FIRE,
    health: 1,
    downTicks: 0,
    stateTicks: 0,
    target: -1,
    homeX: 0, homeZ: 0,
    fireCooldown: 0,
    shotsFired: 0,
    barkedAt: 0,
    struckAt: 0,
    seen: 0,
  };
  private readonly witnessCtx = {
    peds: null as FactionCtx['peds'],
    collision: null as FactionCtx['collision'],
    field: null as FactionField | null,
    bands: this.bands,
    ped: this.ped,
    beat: this.beat,
  };

  /** How many stars this player has. 0 for anybody this field has never heard of. */
  starsOf(playerId: number): number {
    return this.heat.get(playerId)?.stars ?? 0;
  }

  /** The hidden ladder, for a check and for the debug overlay. Never on the wire. */
  pointsOf(playerId: number): number {
    return this.heat.get(playerId)?.points ?? 0;
  }

  /** How many players carry any heat at all. The transport reads this. */
  get wantedCount(): number {
    return this.heat.size;
  }

  /** Every wanted player, as the wire wants them. Ascending insertion order. */
  records(out: HeatRecord[] = []): HeatRecord[] {
    out.length = 0;
    for (const h of this.heat.values()) {
      out.push({ playerId: h.playerId, stars: h.stars, decayEndsTick: h.decayEndsTick });
    }
    return out;
  }

  /**
   * Take a crime, whoever reported it. Queued rather than applied, on exactly
   * `factions.reportCrime`'s argument: a crime reported from inside a ball's
   * step and one reported from inside a swing have to resolve in the same order
   * on both ends, and the only order that is the same everywhere is the step's.
   */
  report(playerId: number, reason: number, witness: number): void {
    if (!Number.isFinite(playerId) || playerId < 0) return;
    this.pending.push({ playerId, reason, witness });
  }

  /**
   * Wipe a player's heat. A knockout and a death both do this.
   *
   * The brief's rule, and it is the third terminal state the investigation
   * countdown already has: being caught ends it. Anything this player put in the
   * world -- their patrol cars, their RBT -- is released with them, because a
   * roadblock outliving the person it was for is an actor the cap is holding for
   * nobody.
   */
  reset(playerId: number): void {
    const h = this.heat.get(playerId);
    if (h === undefined) return;
    if (h.stars > 0) this.version++;
    for (const id of h.cars) this.drives.delete(id);
    // The trail goes with them. It is 240 bytes and the row is being dropped
    // anyway, but naming it here is what keeps `polairTrail`'s "null unless they
    // are at the top rung" claim true from every exit rather than only from the
    // one `escalate` takes.
    h.polairTrail = null;
    this.heat.delete(playerId);
  }

  /** Everything. For a check that has to start from nothing. */
  clear(): void {
    this.heat.clear();
    this.drives.clear();
    this.pending.length = 0;
    this.version++;
  }

  /**
   * Set a player's stars outright. **Debug only** -- the `?heat=N` URL param.
   *
   * Offline-only by contract rather than by enforcement: this is a method on a
   * field the server also owns, and the thing that keeps it out of a session is
   * that nothing on the server side ever calls it. See `main.ts`, where the
   * param is read and is gated on `!online`.
   */
  debugSet(playerId: number, stars: number, tick: number): void {
    const n = Math.max(0, Math.min(HEAT_MAX, Math.round(stars)));
    // **Anything already queued against this player is dropped**, and finding
    // out why is what this line is for. The caller in `main.ts` opens an
    // investigation first, so the banner is up -- the 1-star rung *is* the
    // banner -- and `factions.accuse` fires the crime funnel, which queues 130
    // points here. Those points are not applied until the next `step`, so a
    // `debugSet(2)` was landing as 250 and then becoming 380 a tick later, and
    // `?heat=2` reliably produced three stars and a highway patrol car.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].playerId === playerId) this.pending.splice(i, 1);
    }
    const h = this.ensure(playerId);
    h.points = STAR_POINTS[n];
    h.tierTicks = 0;
    h.hiddenTicks = 0;
    void tick;
    if (h.stars !== n) {
      h.stars = n;
      this.version++;
    }
  }

  private ensure(playerId: number): HeatState {
    let h = this.heat.get(playerId);
    if (h === undefined) {
      h = createHeatState(playerId);
      this.heat.set(playerId, h);
    }
    return h;
  }

  /**
   * One tick of the ladder, for every player who has any.
   *
   * The order inside it is fixed and each step depends on the one before, which
   * is `FactionField.step`'s discipline restated:
   *
   *   1. **Reported crimes**, drained from the queue in the order they arrived.
   *   2. **The ride**, because boarding a train changes the points that step 3
   *      is about to read, and a player who boarded this tick should not also
   *      be told they are hidden.
   *   3. **Sight and decay.**
   *   4. **The tier timers**, so ninety seconds at 3 stars lands here rather
   *      than a tick late.
   *   5. **What each rung puts in the world**, once the star count is final.
   *   6. **The things already in the world**: the cars drive, the RBTs judge.
   */
  step(ctx: FactionCtx, world: HeatWorld): void {
    // The overwhelmingly common case, and the whole of this feature's cost in
    // a quiet room: nobody is wanted, nothing was reported, and this returns.
    if (this.pending.length === 0 && this.heat.size === 0) return;

    this.witnessCtx.peds = ctx.peds;
    this.witnessCtx.collision = ctx.collision;
    this.witnessCtx.field = ctx.field;

    // --- 1. Reported crimes.
    for (const c of this.pending) {
      const h = this.ensure(c.playerId);
      h.points = Math.min(HEAT_POINTS_CAP, h.points + crimePoints(c.reason));
      // A fresh crime is a fresh sighting whatever the witness was: somebody
      // just watched you do it, so the eight seconds of quiet starts again.
      h.hiddenTicks = 0;
    }
    this.pending.length = 0;

    for (const h of this.heat.values()) {
      const suspect = findCombatant(ctx.combatants, h.playerId);
      if (suspect === undefined) continue;
      const sx = suspect.body.position.x;
      const sz = suspect.body.position.z;

      // --- 2. The train. See the header, section 3.
      this.stepRide(h, world);

      // --- 3. Sight and decay.
      //
      // The query is `policeWitness` against the suspect's own position, which
      // is the same question the crime test asks and deliberately the same
      // implementation. It is the one per-tick cost of a wanted player and it
      // is a grid walk over the beats within 40 m: measured at 3.3 us in the
      // CBD by `factions.forEachPatrolNear`'s own note.
      const seen = policeWitness(sx, sz, ctx.tick, this.witnessCtx, this.witness).seen;
      if (seen) h.hiddenTicks = 0;
      else h.hiddenTicks++;
      if (h.hiddenTicks >= HIDDEN_TICKS && h.points > 0) {
        h.points -= shedPerTick(h.stars);
        if (h.points < 0) h.points = 0;
        // Ticks left until the current tier is shed, at the rate it is being
        // shed at. Reported rather than a threshold, so the HUD can draw a
        // clock without knowing what a point is.
        const rate = shedPerTick(h.stars);
        const floor = h.stars > 0 ? STAR_POINTS[h.stars - 1] : 0;
        h.decayEndsTick = rate > 0 ? ctx.tick + Math.ceil((h.points - floor) / rate) : 0;
      } else {
        h.decayEndsTick = 0;
      }

      // --- 4. The tier timers. See `TIER_TIMEOUT_TICKS`.
      if ((h.stars === 3 || h.stars === 4) && h.tierTicks >= TIER_TIMEOUT_TICKS) {
        h.points = Math.max(h.points, STAR_POINTS[h.stars + 1]);
        h.tierTicks = 0;
      }

      // --- The star count, read off the points exactly once.
      const stars = starsFor(h.points);
      if (stars !== h.stars) {
        h.stars = stars;
        h.tierTicks = 0;
        this.version++;
      } else {
        h.tierTicks++;
      }

      // --- 5. What the rung puts in the world.
      this.escalate(h, suspect, ctx, world);
    }

    // --- 6. And the things already in it.
    this.driveCars(ctx, world);
    this.stepRbts(ctx);
    this.sweep(ctx);
  }

  /**
   * The train getaway. One integer of memory per player; see header section 3.
   *
   * `rideStop` is the authority's answer to "what is this player's train doing":
   * -2 on foot, -1 aboard and moving, and otherwise the index of the stop it is
   * standing at. Two edges come out of it and nothing else has to be tracked:
   * **on foot -> aboard** halves the points, and **standing at a stop -> moving
   * again** is a station passed and sheds a whole star. The second edge is the
   * doors closing, which is exactly the moment the brief names.
   */
  private stepRide(h: HeatState, world: HeatWorld): void {
    const stop = world.rideStop(h.playerId);
    const aboard = stop !== -2;
    if (aboard && !h.aboard) {
      // Boarding. Halved on the spot -- the doors closing on a pursuit is worth
      // paying for immediately.
      h.points *= TRAIN_BOARD_KEEP;
      // And the hide starts now: nobody on a platform is looking through a
      // carriage wall at you.
      h.hiddenTicks = HIDDEN_TICKS;
    }
    if (aboard && h.aboard && h.rideStop >= 0 && stop === -1) {
      // Pulling out of a station. One whole star, which is a drop to just below
      // the current tier's threshold rather than a subtraction of points --
      // otherwise "one star" would mean different things at different rungs.
      const floor = h.stars > 0 ? STAR_POINTS[h.stars - 1] : 0;
      if (h.points > floor) h.points = Math.max(0, floor - 1);
    }
    h.rideStop = stop;
    h.aboard = aboard;
  }

  /**
   * Put in the world whatever this player's star count says should be there.
   *
   * Called every tick rather than on the tier edge, and that is not laziness:
   * the cap can refuse a promotion (`factions.MAX_ACTORS`), a patrol car can be
   * batted to a stop, and an RBT the player drove through is gone. A rung that
   * spawned its furniture once and never looked again would be a 3-star player
   * with no highway patrol because the cap happened to be full for one tick.
   */
  private escalate(h: HeatState, suspect: CombatantState, ctx: FactionCtx, world: HeatWorld): void {
    if (suspect.phase === 'ko') return;
    // Nothing arrives while you are on a train. There is no version of this
    // build where a Commodore drives into a carriage, and an RBT placed on the
    // road under a viaduct while the player is 40 m above it would be a
    // roadblock for nobody -- which is worse than nothing, because it holds an
    // actor slot the pursuit could have used.
    if (h.aboard) return;

    const sx = suspect.body.position.x;
    const sz = suspect.body.position.z;

    // --- 3 stars: the highway patrol.
    if (h.stars >= 3 && h.cars.length < PATROL_CARS_PER_SUSPECT) {
      this.spawnPatrolCar(h, sx, sz, ctx, world);
    }

    // --- 4 stars: the RBT, one at a time.
    if (h.stars >= 4 && h.rbtActor === 0) {
      this.placeRbt(h, suspect, ctx, world);
    }

    // --- 5 stars: Polair's marksman. **The one thing about the helicopter that
    // is the authority's**, because it is the only thing that can hurt you; the
    // airframe, the beam and the puffs are all recomputed on the client from the
    // same pure functions. See `stepPolair` and `game/polair.ts` section 3.
    //
    // Outside the `ctx.peds` gate below on purpose: the convergence needs the
    // pedestrian field to find officers to promote, and a browser or a check
    // running with no bands would then also lose the marksman -- which is the
    // class of accident that makes a rung silently do nothing.
    if (h.stars >= 5) this.stepPolair(h, suspect, ctx, world);
    else h.polairTrail = null;

    // --- And the convergence. The spotlight and the rotor are the client's --
    // `world/highway-patrol.ts` draws them off the star count alone, which is
    // why there is no actor here. What the authority owes is the officers.
    if (h.stars >= 5 && ctx.peds) {
      let onIt = 0;
      for (const a of ctx.field.actors) {
        if (a.kind === NPC_KIND.POLICE && a.target === h.playerId) onIt++;
      }
      if (onIt < POLAIR_PURSUIT_TARGET) {
        let want = POLAIR_PURSUIT_TARGET - onIt;
        forEachPoliceNear(
          ctx.peds, sx, sz, POLAIR_CONVERGE_M, ctx.tick,
          this.bands, this.ped, this.beat,
          (p) => {
            if (want <= 0) return true;
            const actor = ctx.field.promote(NPC_KIND.POLICE, p.x, p.y, p.z, p.dx, p.dz, h.playerId);
            if (actor === null) return true;
            want--;
            ctx.field.bark(actor, ctx);
          },
        );
      }
    }
  }

  /**
   * One tick of the helicopter, for one five-star player.
   *
   * Three lines of work and a paragraph of reasoning for each of them.
   *
   * **The trail** is pushed from the *authoritative* position, which is the whole
   * reason this is here rather than only on the client: the orbit is centred on
   * where the player was three seconds ago, and "where they were" has to be the
   * server's answer or a client could fly the helicopter somewhere convenient by
   * lying about its history. The client keeps its own trail off its predicted
   * position and lands within a metre or two of this one -- see `game/polair.ts`
   * section 3, which names that seam and prices it at six thousandths of a per
   * cent of hit chance.
   *
   * **The pose** is computed because the marksman's range is a *slant* range and
   * the slant range needs to know where the machine is. It is thrown away
   * afterwards; nothing about it is stored, sent or remembered.
   *
   * **The shot** is one round on the tick `polairShotFired` names, rolled against
   * `polairHitChance` of the slant, and paid through `ctx.damagePlayer` -- the
   * identical door the ground officers and the patrol car use, so the pip, the
   * knockout, the kill-feed line, the respawn and the ladder wipe are one machine
   * with one spelling. There is deliberately **no event and no message**: the
   * client is already computing the same schedule and draws the flash, the grit
   * and the delayed report itself.
   *
   * Bots are excluded. A helicopter shooting at a bot is a pip nobody sees taken
   * off somebody nobody is playing, and the convergence above already spends
   * real actors on them; adding rounds would be spending the authority's tick
   * budget on theatre with no audience. `HeatWorld.isBot` is optional so that the
   * offline browser -- which has no bots at all -- needs no change.
   */
  private stepPolair(h: HeatState, suspect: CombatantState, ctx: FactionCtx, world: HeatWorld): void {
    if (world.isBot?.(h.playerId) === true) {
      h.polairTrail = null;
      return;
    }
    const sx = suspect.body.position.x;
    const sy = suspect.body.position.y;
    const sz = suspect.body.position.z;
    // Created on the tick the rung is reached; `PolairTrail.push` back-fills its
    // whole history with this one point, so the first lap is flown around where
    // the player is and settles into its arrears over the next few seconds --
    // which is what a machine arriving on station looks like. See `push`.
    let trail = h.polairTrail;
    if (trail === null) {
      trail = new PolairTrail();
      h.polairTrail = trail;
    }
    trail.push(ctx.tick, sx, sy, sz);
    if (suspect.phase === 'ko' || suspect.health <= 0) return;
    if (!polairShotFired(h.playerId, ctx.tick)) return;

    polairPose(h.playerId, ctx.tick, sx, sy, sz, trail, this.polair);
    this.polairShots++;
    const cycle = polairCycle(ctx.tick);
    if (polairRoll(h.playerId, cycle) >= polairHitChance(this.polair.slant)) return;
    this.polairHits++;
    // The stand-in actor, posed at the airframe so that anything which ever does
    // read a position off it reads the honest one.
    this.marksman.x = this.polair.x;
    this.marksman.y = this.polair.y;
    this.marksman.z = this.polair.z;
    this.marksman.dx = this.polair.dx;
    this.marksman.dz = this.polair.dz;
    this.marksman.target = h.playerId;
    ctx.damagePlayer(suspect.id, POLAIR_SHOT_DAMAGE, this.marksman);
  }

  /**
   * A patrol car onto the road near the suspect, facing them.
   *
   * The spawn point is a **lane vertex**, not a point on a circle: a car that
   * appeared 140 m away in a park would then have to drive out of the park, and
   * the pursuit's whole readability is that it comes down the road. The search
   * widens rather than failing, on `factions.CATCHMENT_RESCUE_MAX`'s argument --
   * a suspect in the middle of Centennial Park has no lane at 140 m and the
   * honest answer is the nearest one that exists, not no car at all.
   */
  private spawnPatrolCar(h: HeatState, sx: number, sz: number, ctx: FactionCtx, world: HeatWorld): void {
    const lanes = world.lanes;
    // **No cap pre-check.** `FactionField.promote` owns the cap and its
    // eviction, and the framework's contract says to design for being refused
    // rather than to ask first -- see `factions.ts` section 2. Asking first is
    // worse than useless here: a 3-star pursuit outranks a seagull, `promote`
    // will evict the seagull, and a caller that returned early because the
    // field happened to be full of wildlife would be a highway patrol that
    // never arrives in a park. Measured, and it is not hypothetical: with six
    // officers on the suspect and the birds and loiterers a busy street carries,
    // the count sat above the cap-minus-two an earlier version of this line
    // tested for, and the 4-star RBT silently never appeared.
    // Deterministic, and the seed is the player and the tick they reached the
    // rung -- so a check that reruns the same tick gets the same car, and two
    // suspects on the same street do not get the same spawn.
    const seed = carHash(h.playerId | 0, ctx.tick | 0);
    // Loose numbers rather than a record, which is `game/traffic.CarPose`'s own
    // habit and is not only about the allocation: this is inside two nested
    // loops over every vertex of every route in range, and a fresh object per
    // improvement is a few hundred short-lived allocations for one decision.
    let found = false;
    let bx = 0;
    let by = 0;
    let bz = 0;
    let bestErr = Infinity;
    for (let reach = PATROL_SPAWN_M; lanes !== null && reach <= PATROL_SPAWN_MAX_M; reach *= 1.6) {
      lanes.near(sx, sz, reach, this.routes);
      for (const r of this.routes) {
        // Every eleventh vertex, which is a few metres of lane at the sample
        // rate the routes are baked at. A full scan of every vertex of every
        // route inside 260 m is tens of thousands of points for a decision made
        // once per suspect per rung; a stride of eleven is a metre or two of
        // error on where the car appears and is invisible.
        for (let i = (seed % 11); i < r.count; i += 11) {
          const dx = r.x[i] - sx;
          const dz = r.z[i] - sz;
          const d = Math.sqrt(dx * dx + dz * dz);
          const err = Math.abs(d - PATROL_SPAWN_M);
          if (err >= bestErr) continue;
          bestErr = err;
          found = true;
          bx = r.x[i];
          by = r.y[i];
          bz = r.z[i];
        }
      }
      if (found) break;
    }
    // --- No road. **Still send a car**, on a bearing, and drive it straight.
    //
    // This is a real state and not only a degraded one: a suspect in the middle
    // of Centennial Park has no lane within 260 m, and a *browser* running the
    // offline authority holds only the tiles it has streamed, so the lane graph
    // can be genuinely absent for the first seconds of a session or on a machine
    // that never got to the sidecars. The brief allows the straight-line
    // fallback and this is it, stated out loud: the car appears on the ground at
    // the spawn distance, drives at the suspect, and `driveCars` resolves it
    // against the prisms exactly as an officer on foot is resolved -- so it
    // stops at a kerb or a terrace rather than driving through one.
    //
    // The bearing is hashed off the player and the tick rather than taken from
    // their heading, so the car does not reliably arrive from in front (which
    // would read as spawning in your face) or from behind (which would read as
    // never arriving at all).
    if (!found) {
      const turn = (carHash(seed, 0x2f11) % 3600) / 3600;
      // A unit bearing without a `sin`: two hashed components normalised. The
      // determinism rule's whole point -- see the header, section 6 -- and it
      // costs one square root against a transcendental.
      const ux = turn * 2 - 1;
      const uz = 1 - Math.abs(ux) * 2;
      const ul = Math.sqrt(ux * ux + uz * uz);
      if (ul < 1e-6) return;
      bx = sx + (ux / ul) * PATROL_SPAWN_M;
      bz = sz + (uz / ul) * PATROL_SPAWN_M;
      by = ctx.groundHeight(bx, bz, Infinity);
      found = true;
    }
    const dx = sx - bx;
    const dz = sz - bz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) return;
    const actor = ctx.field.promote(
      NPC_KIND.HIGHWAY_PATROL,
      bx, ctx.groundHeight(bx, bz, by), bz,
      dx / d, dz / d,
      h.playerId,
    );
    if (actor === null) return;
    actor.state = NPC_STATE.CHASE;
    h.cars.push(actor.id);
    this.drives.set(actor.id, { wx: sx, wz: sz, pickedAt: 0, speed: 0, disgorged: false });
    this.patrolCarsSpawned++;
  }

  /**
   * The RBT, across the nearest road about 150 m along the player's heading.
   *
   * **Deterministic from the position and heading at the tick the rung was
   * reached**, which is the brief's word and is worth honouring literally: the
   * site is chosen once, from one instant, and never re-aimed. An RBT that
   * followed you would not be a roadblock, it would be a wall attached to your
   * face.
   */
  private placeRbt(h: HeatState, suspect: CombatantState, ctx: FactionCtx, world: HeatWorld): void {
    const lanes = world.lanes;
    // No cap pre-check; see `spawnPatrolCar`. The site is promoted first and
    // its two officers after, so a field that can only take one more actor
    // gets the roadblock rather than half of one.
    const sx = suspect.body.position.x;
    const sz = suspect.body.position.z;
    // **The one sin/cos in this file.** Authority-only and the result is
    // transmitted -- the RBT is a promoted actor, so this position crosses the
    // wire as a position and no client ever recomputes it. See the header,
    // section 6, before copying this line anywhere else.
    const fx = -Math.sin(suspect.body.yaw);
    const fz = -Math.cos(suspect.body.yaw);
    const aimX = sx + fx * RBT_AHEAD_M;
    const aimZ = sz + fz * RBT_AHEAD_M;

    // Loose numbers, on `spawnPatrolCar`'s reason one method up.
    let found = false;
    let bx = 0;
    let by = 0;
    let bz = 0;
    let bdx = 1;
    let bdz = 0;
    let best2 = RBT_SEARCH_M * RBT_SEARCH_M;
    if (lanes !== null) lanes.near(aimX, aimZ, RBT_SEARCH_M, this.routes);
    else this.routes.length = 0;
    for (const r of this.routes) {
      for (let i = 1; i < r.count; i += 7) {
        const dx = r.x[i] - aimX;
        const dz = r.z[i] - aimZ;
        const d2 = dx * dx + dz * dz;
        if (d2 >= best2) continue;
        // The road's own direction at this vertex, so the cones can be laid
        // *across* it. Taken from the polyline rather than from the player's
        // heading, because a road that crosses your path at an angle still has
        // to be blocked along its own width.
        const rx = r.x[i] - r.x[i - 1];
        const rz = r.z[i] - r.z[i - 1];
        const rd = Math.sqrt(rx * rx + rz * rz);
        if (rd < 1e-3) continue;
        best2 = d2;
        found = true;
        bx = r.x[i];
        by = r.y[i];
        bz = r.z[i];
        bdx = rx / rd;
        bdz = rz / rd;
      }
    }
    // --- No road at the aim point. **Still set it up**, square across the
    // player's own heading, at exactly the distance the road version would have
    // been. `spawnPatrolCar`'s fallback and its reasoning: a roadblock that
    // failed to appear because the lane sidecar had not streamed is a rung of
    // the ladder that silently does nothing, which is the failure mode this
    // whole project's checks exist to remove. It is still a wall across your
    // path, which is the only thing an RBT has to be.
    if (!found) {
      bx = aimX;
      bz = aimZ;
      by = ctx.groundHeight(bx, bz, Infinity);
      // Across the player's heading, which with no road is the best available
      // definition of "the direction you are travelling in".
      bdx = -fz;
      bdz = fx;
      found = true;
    }
    const ground = ctx.groundHeight(bx, bz, by);
    const site = ctx.field.promote(
      NPC_KIND.RBT, bx, ground, bz, bdx, bdz, h.playerId,
    );
    if (site === null) return;
    site.state = NPC_STATE.IDLE;
    h.rbtActor = site.id;
    h.rbtStandTicks = 0;
    h.rbtOfficers.length = 0;
    h.rbtPosts.length = 0;
    this.rbtsPlaced++;

    // The two officers, one either side of the road, as real promoted actors.
    // See the `RBT` registration for why they are not part of the site actor.
    for (let side = 0; side < 2; side++) {
      const off = side === 0 ? 4.5 : -4.5;
      const ox = bx + bdz * off;
      const oz = bz - bdx * off;
      const officer = ctx.field.promote(
        NPC_KIND.POLICE,
        ox, ctx.groundHeight(ox, oz, ground), oz,
        -bdz * (side === 0 ? 1 : -1), bdx * (side === 0 ? 1 : -1),
        h.playerId,
      );
      if (officer === null) break;
      h.rbtOfficers.push(officer.id);
      h.rbtPosts.push(ox, ctx.groundHeight(ox, oz, ground), oz);
    }
  }

  /**
   * Put the RBT's two officers back on their posts.
   *
   * Run **after** `FactionField.step` has already let `POLICE.think` move them,
   * which is the only order available and is fine: the think has advanced them
   * by a tenth of a metre and this puts them back, so the net effect is an
   * officer who stands there. Everything else the think decided this tick --
   * the aim, the fire, the bark -- is left exactly as it is, so a player walking
   * up to a roadblock is shot at by the people manning it.
   *
   * The pin is released once the suspect is inside `RBT_STAND_M`, because at
   * that point they have arrived and holding the line is no longer the point:
   * either they are stopping (and the arrest clock is running) or they are
   * going through it, and in both cases two officers rooted to the spot would
   * be the tableau outliving the scene it was set for.
   */
  private pinRbtOfficers(h: HeatState, ctx: FactionCtx, suspectFar: boolean): void {
    if (!suspectFar || h.rbtOfficers.length === 0) return;
    for (let i = 0; i < h.rbtOfficers.length; i++) {
      const id = h.rbtOfficers[i];
      const actor = ctx.field.actors.find((a) => a.id === id);
      if (actor === undefined) continue;
      if (actor.state === NPC_STATE.DOWN) continue;
      actor.x = h.rbtPosts[i * 3];
      actor.y = h.rbtPosts[i * 3 + 1];
      actor.z = h.rbtPosts[i * 3 + 2];
      // A `RETURN` officer walks home and despawns on arrival, and home is the
      // post -- so an officer whose investigation lapsed for a tick would
      // vanish out of the roadblock. Held at `IDLE` instead, which is a person
      // standing there and is what a breath test looks like.
      if (actor.state === NPC_STATE.RETURN) {
        actor.state = NPC_STATE.IDLE;
        actor.stateTicks = 0;
        actor.health = npcKind(actor.kind)?.maxHealth ?? actor.health;
      }
    }
  }

  /**
   * Every patrol car, one tick.
   *
   * The pursuit is a **lane-graph steer, not a path-find**, and the distinction
   * is the same one `factions.walkToward` makes about officers on foot: what a
   * steering car does when it loses you is end up on the wrong road, which is
   * exactly what the decay timer is for. It picks the lane vertex that most
   * reduces its distance to the suspect out of the ones near it, four times a
   * second, and turns toward it at a bounded rate. With no lanes resident it
   * drives straight at the suspect and slides off buildings, which is the
   * honest degraded mode rather than a car that stops existing.
   */
  private driveCars(ctx: FactionCtx, world: HeatWorld): void {
    if (this.drives.size === 0) return;
    for (const actor of ctx.field.actors) {
      if (actor.kind !== NPC_KIND.HIGHWAY_PATROL) continue;
      const drive = this.drives.get(actor.id);
      if (drive === undefined) continue;
      if (actor.state === NPC_STATE.DOWN) {
        actor.downTicks--;
        if (actor.downTicks <= 0) actor.health = -2;
        continue;
      }
      const suspect = findCombatant(ctx.combatants, actor.target);
      // **Stand down when the rung is gone.** A patrol car whose suspect has
      // dropped below 3 stars -- hidden long enough, or caught, or got on a
      // train -- is a car chasing somebody who is no longer wanted, and it
      // would chase them for the rest of the session because nothing else in
      // this file despawns it. `health = -2` is `FactionField.step`'s despawn
      // flag, the same one an officer walking home sets.
      if (suspect === undefined || this.starsOf(actor.target) < 3) {
        actor.health = -2;
        continue;
      }
      const tx = suspect.body.position.x;
      const tz = suspect.body.position.z;
      const dx = tx - actor.x;
      const dz = tz - actor.z;
      const d2 = dx * dx + dz * dz;

      // --- Arrived. Stop, and put two officers out. Once.
      if (d2 <= PATROL_STOP_M * PATROL_STOP_M) {
        drive.speed = 0;
        actor.state = NPC_STATE.IDLE;
        if (!drive.disgorged) {
          drive.disgorged = true;
          for (let side = 0; side < 2; side++) {
            const off = side === 0 ? 1.6 : -1.6;
            const ox = actor.x + actor.dz * off;
            const oz = actor.z - actor.dx * off;
            const officer = ctx.field.promote(
              NPC_KIND.POLICE,
              ox, ctx.groundHeight(ox, oz, actor.y), oz,
              actor.dx, actor.dz,
              actor.target,
            );
            if (officer === null) break;
            ctx.field.bark(officer, ctx);
          }
        }
        continue;
      }
      // Somebody they had stopped for has run: back on the road.
      drive.disgorged = false;
      actor.state = NPC_STATE.CHASE;

      // --- The waypoint, re-picked four times a second.
      if (ctx.tick - drive.pickedAt >= PATROL_REPICK_TICKS || drive.pickedAt === 0) {
        drive.pickedAt = ctx.tick;
        drive.wx = tx;
        drive.wz = tz;
        const lanes = world.lanes;
        if (lanes !== null) {
          lanes.near(actor.x, actor.z, PATROL_LANE_REACH, this.routes);
          let bestScore = Infinity;
          for (const r of this.routes) {
            for (let i = 0; i < r.count; i += 5) {
              const vx = r.x[i] - actor.x;
              const vz = r.z[i] - actor.z;
              const vd2 = vx * vx + vz * vz;
              // Only points genuinely ahead of the car and not on top of it:
              // a waypoint behind the bumper is a three-point turn at 90 km/h.
              if (vd2 < 36 || vd2 > PATROL_LANE_REACH * PATROL_LANE_REACH) continue;
              if (vx * actor.dx + vz * actor.dz <= 0) continue;
              const px = r.x[i] - tx;
              const pz = r.z[i] - tz;
              // Distance from the *suspect*, so the car follows the road that
              // gets it there rather than the road it is already on.
              const score = px * px + pz * pz;
              if (score >= bestScore) continue;
              bestScore = score;
              drive.wx = r.x[i];
              drive.wz = r.z[i];
            }
          }
        }
      }

      // --- Steer. A bounded turn toward the waypoint, then integrate.
      steerToward(actor, drive.wx, drive.wz, ctx.dt);
      const wantSpeed = PATROL_SPEED;
      drive.speed += Math.min(8 * ctx.dt, Math.max(-14 * ctx.dt, wantSpeed - drive.speed));
      const step = drive.speed * ctx.dt;
      let nx = actor.x + actor.dx * step;
      let nz = actor.z + actor.dz * step;
      if (ctx.collision) {
        // The player's own resolver, so a car takes the corner a player would
        // and cannot drive through a terrace. A car that is wedged simply stops,
        // which is what `walkToward` already accepts for an officer on foot.
        const moved = ctx.collision.resolve(actor.x, actor.z, nx, nz, PATROL_RADIUS, actor.y + 0.5);
        if (Math.abs(moved.x - nx) > 0.01 || Math.abs(moved.z - nz) > 0.01) drive.speed *= 0.4;
        nx = moved.x;
        nz = moved.z;
      }
      actor.x = nx;
      actor.z = nz;
      actor.y = ctx.groundHeight(nx, nz, actor.y);

      // --- Contact. The same knockdown a Camry gives, through the authority's
      // own damage door so the KO, the feed and the respawn are one machine.
      if (d2 <= PATROL_HIT_M * PATROL_HIT_M && suspect.phase !== 'ko' && suspect.health > 0) {
        ctx.damagePlayer(suspect.id, 1, actor);
      }
    }
  }

  /**
   * Every RBT, one tick: is anybody standing at it, or driving through it?
   *
   * Both branches end the same way -- you are knocked out -- and that is the
   * joke the brief asked for made structural. There is no third branch, because
   * nobody has ever passed one.
   */
  private stepRbts(ctx: FactionCtx): void {
    for (const h of this.heat.values()) {
      if (h.rbtActor === 0) continue;
      const site = ctx.field.actors.find((a) => a.id === h.rbtActor);
      if (site === undefined || site.kind !== NPC_KIND.RBT) {
        h.rbtActor = 0;
        h.rbtStandTicks = 0;
        h.rbtOfficers.length = 0;
        h.rbtPosts.length = 0;
        continue;
      }
      // And the roadblock, on the patrol car's own argument one method up: an
      // RBT left standing after its suspect got away is a wall across a public
      // road that nothing will ever remove, holding an actor slot for nobody.
      // Its two constables go with it -- they were posted to *this*.
      if (h.stars < 4) {
        site.health = -2;
        for (const id of h.rbtOfficers) {
          const officer = ctx.field.actors.find((a) => a.id === id);
          if (officer !== undefined) officer.health = -2;
        }
        h.rbtActor = 0;
        h.rbtOfficers.length = 0;
        h.rbtPosts.length = 0;
        continue;
      }
      const suspect = findCombatant(ctx.combatants, h.playerId);
      if (suspect === undefined || suspect.phase === 'ko') continue;
      const dx = suspect.body.position.x - site.x;
      const dz = suspect.body.position.z - site.z;
      const d2 = dx * dx + dz * dz;
      // The two constables, held on their posts until the suspect arrives.
      this.pinRbtOfficers(h, ctx, d2 > RBT_STAND_M * RBT_STAND_M);
      if (d2 > RBT_STAND_M * RBT_STAND_M) {
        h.rbtStandTicks = 0;
        continue;
      }
      const v = suspect.body.velocity;
      const speed2 = v.x * v.x + v.z * v.z;

      // --- Through it. The cone line is `RBT_LINE_HALF_M` either side of the
      // site across the road, and anything crossing it at speed is evading.
      const across = dx * site.dz - dz * site.dx;
      if (speed2 > 25 && Math.abs(across) < RBT_LINE_HALF_M) {
        reportHeatCrime(h.playerId, REASON.RBT_EVADE, WITNESS_KIND.POLICE);
        ctx.damagePlayer(suspect.id, 1, site);
        h.rbtStandTicks = 0;
        continue;
      }

      // --- Or stopped at it. Five seconds of standing still and they take you.
      if (speed2 <= RBT_STILL_SPEED * RBT_STILL_SPEED) {
        h.rbtStandTicks++;
        if (h.rbtStandTicks >= RBT_STAND_SECONDS * 60) {
          h.rbtStandTicks = 0;
          // Enough to drop anybody. The feed line is the kind's own `feedKo`,
          // which is how the joke reaches the kill feed without this file
          // knowing what a kill feed is.
          ctx.damagePlayer(suspect.id, 99, site);
        }
      } else {
        h.rbtStandTicks = 0;
      }
    }
  }

  /**
   * Forget the actors that are gone, and the players who are clean.
   *
   * Last in the step, after everything has read the lists -- `FactionField.step`
   * puts its despawn sweep in the same place for the same reason.
   */
  private sweep(ctx: FactionCtx): void {
    const live = new Set<number>();
    for (const a of ctx.field.actors) live.add(a.id);
    for (const id of [...this.drives.keys()]) if (!live.has(id)) this.drives.delete(id);
    for (const [id, h] of [...this.heat]) {
      for (let i = h.cars.length - 1; i >= 0; i--) {
        if (!live.has(h.cars[i])) h.cars.splice(i, 1);
      }
      if (h.rbtActor !== 0 && !live.has(h.rbtActor)) h.rbtActor = 0;
      // A player at zero points with nothing left in the world is a player this
      // field has no reason to remember. Dropping the row is what makes
      // `wantedCount` an honest number and keeps the map bounded by the number
      // of people currently in trouble rather than by everybody who ever was.
      if (h.points <= 0 && h.stars === 0 && h.cars.length === 0 && h.rbtActor === 0) {
        this.heat.delete(id);
      }
    }
  }
}

/** The nearest thing to a lookup this file needs. Ascending id; the tick order. */
function findCombatant(list: readonly CombatantState[], id: number): CombatantState | undefined {
  if (id < 0) return undefined;
  for (const c of list) if (c.id === id) return c;
  return undefined;
}

/**
 * Turn an actor's unit heading toward a point, at most `PATROL_TURN_RATE` a
 * second, without ever touching an angle.
 *
 * No `atan2` and no `sin`: the turn is done as a **rotation of the heading
 * vector toward the target vector**, clamped by the cross product, which is
 * `factions.ts`'s rule 5 taken literally. The small-angle rotation is a first
 * order step normalised back to unit length -- exact enough at 60 Hz for a
 * quantity that is re-normalised every tick, and identical in both engines
 * because it is four multiplies and a square root.
 */
function steerToward(actor: NpcActor, tx: number, tz: number, dt: number): void {
  const dx = tx - actor.x;
  const dz = tz - actor.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) return;
  const inv = 1 / Math.sqrt(d2);
  const wx = dx * inv;
  const wz = dz * inv;
  // Cross product in the plane: positive when the target is to one side.
  const cross = actor.dx * wz - actor.dz * wx;
  const dot = actor.dx * wx + actor.dz * wz;
  const maxTurn = PATROL_TURN_RATE * dt;
  // Already pointing there, within the step this tick could take.
  if (dot > 0 && Math.abs(cross) <= maxTurn) {
    actor.dx = wx;
    actor.dz = wz;
    return;
  }
  const s = cross >= 0 ? maxTurn : -maxTurn;
  const nx = actor.dx - actor.dz * s;
  const nz = actor.dz + actor.dx * s;
  const len = Math.sqrt(nx * nx + nz * nz);
  if (len < 1e-6) return;
  actor.dx = nx / len;
  actor.dz = nz / len;
}

// --- The world this needs beyond the faction context -------------------------------

/**
 * The two things the ladder needs that `factions.FactionCtx` does not carry.
 *
 * A second small record rather than two more fields on `FactionCtx`, and the
 * reason is merge surface rather than taste: `FactionCtx` is read by four
 * factions and constructed in two places, and a feature that widened it would
 * make every one of those files a conflict for anybody else working on a
 * faction at the same time. This record is constructed beside the call to
 * `stepHeat` and read by nothing else.
 */
export interface HeatWorld {
  /** The lane graph, for the pursuit and the RBT. Null before any tile is resident. */
  lanes: TrafficField | null;
  /**
   * What this player's train is doing: **-2 on foot**, **-1 aboard and moving**,
   * or the index of the stop it is standing at.
   *
   * A callback rather than a field because the ride state lives on the
   * combatant (`riding.AboardSlot`) and resolving it needs the rail bake, which
   * this file must not import -- `game/rail.ts` is 900 lines of timetable and
   * heat has no business decoding one. Both authorities already hold a bake and
   * already resolve this every tick for their own reasons.
   */
  rideStop(playerId: number): number;
  /**
   * Is this player a bot? **Optional**, and absent means "nobody here is".
   *
   * Only Polair's marksman asks (see `stepPolair`), and it is optional purely so
   * that the offline browser's `HeatWorld` -- which is built in `main.ts` and has
   * no bots to distinguish -- does not have to grow a member that would always
   * answer false. `server/sim.ts` supplies it in one line beside `rideStop`.
   *
   * Note what this deliberately does *not* do: bots still climb the ladder, still
   * get patrol cars and RBTs, and still pull officers in at five stars, because
   * all of those are visible to the people playing. What they do not get is a
   * round fired at them, which nobody would see.
   */
  isBot?(playerId: number): boolean;
}

// --- The entry points other files call ----------------------------------------------

/** Who saw it. See the header, section 1, and `factions.addWitnessedCrime`. */
export const WITNESS_KIND = {
  /** Whatever the reporting faction's own rule was. The ordinary case. */
  UNKNOWN: 0,
  POLICE: 1,
  /** A member of the public who called it in. The characters faction's Karen. */
  BYSTANDER: 2,
} as const;

/**
 * The one live `HeatField` in this process, if the authority has installed one.
 *
 * A module-level handle purely so that `factions.accuse` -- which is called from
 * inside `FactionField.step`, three files away, with no route to the heat field
 * -- can reach it. Installed by whoever owns the authority (`server/sim.ts`,
 * `main.ts` offline) and never read on the hot path: `HeatField.step` is called
 * on the object directly.
 *
 * A check that builds two authorities in one process shares this handle, which
 * is a real limit and is why `installHeat` returns the previous one -- see
 * `verifyHeat`, which installs and restores around its own field.
 */
let liveHeat: HeatField | null = null;

export function installHeat(field: HeatField | null): HeatField | null {
  const was = liveHeat;
  liveHeat = field;
  return was;
}

/** Points onto whoever did it, if this process is an authority. */
export function reportHeatCrime(playerId: number, reason: number, witness: number): void {
  liveHeat?.report(playerId, reason, witness);
}

/** How many stars a player has, for `factions.heatOf` and for the HUD. */
export function heatOf(playerId: number): number {
  return liveHeat?.starsOf(playerId) ?? 0;
}

/**
 * Wire heat into the faction framework. Called once, at module load.
 *
 * Two hooks and both are one line on the other side: `onCrime` is the funnel
 * every adjudicated crime already passes through, and `setHeatReader` is what
 * lets `factions.heatOf` answer without `factions.ts` importing this file --
 * which would be a cycle, since this file imports it.
 */
onCrime((playerId, reason, witness) => reportHeatCrime(playerId, reason, witness));
setHeatReader(heatOf);

// --- The step ------------------------------------------------------------------------

/**
 * One tick of the ladder. Called by the authority immediately after
 * `FactionField.step`, in the same place `stepStreetlife` and `stepWildlife`
 * are called and for the same reason.
 *
 * **After** the factions rather than before: the crimes reported during the
 * last tick are drained by `FactionField.step`, which is what calls `accuse`,
 * which is what feeds this. Running first would put every crime one tick late
 * and would make a 3-star escalation arrive after the officers it is supposed
 * to bring.
 */
export function stepHeat(ctx: FactionCtx, heat: HeatField, world: HeatWorld): void {
  heat.step(ctx, world);
}

// --- The HUD's voice ------------------------------------------------------------------

/**
 * What the HUD says when a rung is reached. Lower case, deadpan, r/sydney.
 *
 * A table here rather than in `hud.ts` because both ends of the game have to
 * be able to say them -- offline the browser is the authority and online the
 * star change arrives over the wire -- and because the line for a rung is a
 * property of the rung. `''` is "say nothing", which 0 and 1 are: the 1-star
 * rung already has the investigation banner, and a `hud.notice` on top of it
 * would be the interface saying the same thing twice.
 */
export const HEAT_LINES: readonly string[] = [
  '',
  '',
  'they are shooting now',
  'the highway patrol has joined the chat',
  'rbt ahead. nobody has ever passed one',
  // Not "polair has you" any more, and the edit is a correction rather than a
  // polish: as of `game/polair.ts` the beam *does not* have you -- it holds you for
  // a second or two every twelve and hunts the ground you came over the rest of the
  // time. A line that promised otherwise would have the interface telling a player
  // the opposite of what the light is doing.
  'polair is up. it is looking for you',
];

/** And what it says on the way back down. One line, whatever the rung. */
export function heatLine(from: number, to: number): string {
  if (to > from) return HEAT_LINES[Math.min(to, HEAT_LINES.length - 1)] ?? '';
  if (to === 0 && from > 0) return 'you lost them';
  return '';
}

// --- The self-check -----------------------------------------------------------------

/**
 * Everything about the ladder that fails by producing a plausible game.
 *
 * None of it throws, which is this project's criterion:
 *
 *   - A **threshold table out of order** makes `starsFor` non-monotone, so a
 *     player who commits another crime gets *fewer* stars. Nothing errors and
 *     the HUD draws a legal star count.
 *   - A **crime worth more than the whole ladder** takes a bystander assault
 *     straight to Polair, which reads as the police being broken rather than as
 *     one row of a table being wrong.
 *   - A **shed rate that does not shed** leaves a player permanently wanted, and
 *     the symptom is "the stars never go down", which reads as the decay being
 *     unimplemented.
 *   - A **kind byte that collides** with another faction's draws a patrol car as
 *     a seagull -- `factions.registerNpcKind` throws on that at load, so what is
 *     checked here is the byte *range* and the reserved neighbours.
 *   - A **reason with no points row** silently scores the bystander tier, which
 *     is the intended fallback and is asserted rather than assumed.
 *   - And the brief's own consequences: two bystander assaults must be 2 stars,
 *     three must be 3, one officer down must be 3 and two must be 4. Those are
 *     the design, and they are checked as arithmetic over the tables rather
 *     than as the tables themselves.
 */
export function verifyHeat(): string[] {
  const failures: string[] = [];

  // --- The ladder itself.
  if (STAR_POINTS.length !== HEAT_MAX + 1) {
    failures.push(
      `STAR_POINTS has ${STAR_POINTS.length} rungs and the ladder is ${HEAT_MAX} stars plus zero. ` +
        'A star count would index off the end of the table and read as undefined.',
    );
  }
  for (let i = 1; i < STAR_POINTS.length; i++) {
    if (!(STAR_POINTS[i] > STAR_POINTS[i - 1])) {
      failures.push(
        `STAR_POINTS is not strictly increasing at rung ${i} (${STAR_POINTS[i - 1]} -> ${STAR_POINTS[i]}). ` +
          'starsFor would be non-monotone, so committing a crime could lower the star count.',
      );
    }
  }
  if (STAR_POINTS[0] !== 0) failures.push('The zero rung is not at zero points; nobody would ever be clean.');
  if (starsFor(0) !== 0) failures.push('Zero points reads as more than zero stars.');
  if (starsFor(HEAT_POINTS_CAP) !== HEAT_MAX) {
    failures.push(`The points cap ${HEAT_POINTS_CAP} reads as ${starsFor(HEAT_POINTS_CAP)} stars, not ${HEAT_MAX}.`);
  }
  if (HEAT_POINTS_CAP <= STAR_POINTS[HEAT_MAX]) {
    failures.push('The points cap is at or below the top rung, so 5 stars would shed the instant it was reached.');
  }

  // --- The brief's own rungs, as consequences of the two tables.
  {
    const assault = crimePoints(REASON.ASSAULT);
    const cases: Array<[string, number, number]> = [
      ['one bystander assault', assault, 1],
      ['two bystander assaults', assault * 2, 2],
      ['three bystander assaults', assault * 3, 3],
      ['stealing a car', crimePoints(REASON.CAR_THEFT), 2],
      ['assaulting police', crimePoints(REASON.ASSAULT_POLICE), 2],
      ['dangerous driving', crimePoints(REASON.DANGEROUS_DRIVING), 2],
      ['knocking out one officer', crimePoints(REASON.MURDER_POLICE), 3],
      ['knocking out two officers', crimePoints(REASON.MURDER_POLICE) * 2, 4],
      ['knocking out three officers', crimePoints(REASON.MURDER_POLICE) * 3, 5],
    ];
    for (const [what, points, want] of cases) {
      const got = starsFor(Math.min(HEAT_POINTS_CAP, points));
      if (got !== want) {
        failures.push(
          `${what} is ${points} points, which reads as ${got} stars; the design says ${want}. ` +
            'Every rung in this feature is a consequence of STAR_POINTS and CRIME_POINTS together, ' +
            'so one of those two tables has moved.',
        );
      }
    }
  }
  for (const [name, code] of Object.entries(REASON)) {
    if (code === REASON.NONE) continue;
    const p = crimePoints(code);
    if (!(p > 0)) failures.push(`REASON.${name} is worth ${p} heat points; a crime has to cost something.`);
    if (p > STAR_POINTS[HEAT_MAX]) {
      failures.push(
        `REASON.${name} is worth ${p} points and the whole ladder is ${STAR_POINTS[HEAT_MAX]}. ` +
          'One offence would take a player straight to Polair.',
      );
    }
  }
  if (crimePoints(200) !== CRIME_POINTS_DEFAULT) {
    failures.push('A reason with no points row did not fall back to the bystander tier.');
  }

  // --- Decay. Each tier has to actually shed, and in the order the brief sets.
  if (SHED_SECONDS.length !== HEAT_MAX + 1) {
    failures.push(`SHED_SECONDS has ${SHED_SECONDS.length} entries for ${HEAT_MAX + 1} rungs.`);
  }
  for (let i = 2; i <= HEAT_MAX; i++) {
    if (!(SHED_SECONDS[i] > SHED_SECONDS[i - 1])) {
      failures.push(
        `Shedding ${i} stars takes ${SHED_SECONDS[i]} s and shedding ${i - 1} takes ${SHED_SECONDS[i - 1]}. ` +
          'The ladder has to get stickier toward the top or the top rungs are a treadmill.',
      );
    }
  }
  for (let n = 1; n <= HEAT_MAX; n++) {
    const rate = shedPerTick(n);
    if (!(rate > 0)) {
      failures.push(`Tier ${n} sheds ${rate} points a tick; a player at ${n} stars would be wanted forever.`);
      continue;
    }
    // The property the numbers are for: from exactly the threshold, shedding
    // one whole tier takes exactly the specified seconds.
    const ticks = (STAR_POINTS[n] - STAR_POINTS[n - 1]) / rate;
    const seconds = ticks / 60;
    if (Math.abs(seconds - SHED_SECONDS[n]) > 0.05) {
      failures.push(
        `Shedding tier ${n} from its own threshold takes ${seconds.toFixed(1)} s and SHED_SECONDS says ` +
          `${SHED_SECONDS[n]}. The rate and the table disagree.`,
      );
    }
  }
  if (shedPerTick(0) !== 0) failures.push('A player with no stars is still shedding points.');
  if (HIDDEN_TICKS < 60) {
    failures.push(
      `Points start falling after ${HIDDEN_TICKS / 60} s out of sight. Under a second and a player would ` +
        'shed heat by running behind a bus, which is not hiding.',
    );
  }

  // --- The train, which is the one mechanic with no numbers to check but a
  //     relation: boarding must be worth something and must not be worth
  //     everything.
  if (!(TRAIN_BOARD_KEEP > 0 && TRAIN_BOARD_KEEP < 1)) {
    failures.push(
      `Boarding a train keeps ${TRAIN_BOARD_KEEP} of the points. At 0 the railway is an instant pardon and ` +
        'at 1 it is scenery; the design is that it is a getaway.',
    );
  }

  // --- The two kinds, and the bytes around them.
  for (const [name, kind] of [['HIGHWAY_PATROL', NPC_KIND.HIGHWAY_PATROL], ['RBT', NPC_KIND.RBT]] as const) {
    if (npcKind(kind) === undefined) {
      failures.push(`NPC_KIND.${name} (${kind}) is not registered; the authority would promote nothing.`);
    }
  }
  if (npcKind(NPC_KIND.POLAIR) !== undefined) {
    failures.push(
      `NPC_KIND.POLAIR (${NPC_KIND.POLAIR}) is registered. Polair is a spotlight and a sound, not an actor -- ` +
        'a registration here means somebody has started promoting helicopters and the wire budget has not been ' +
        'reconsidered.',
    );
  }
  {
    const def = npcKind(NPC_KIND.HIGHWAY_PATROL);
    if (def && def.feedKo.indexOf('%s') < 0) {
      failures.push('The highway patrol has no %s in its feed line; every knockout would name nobody.');
    }
    const rbt = npcKind(NPC_KIND.RBT);
    if (rbt && rbt.feedKo.indexOf('%s') < 0) {
      failures.push('The RBT has no %s in its feed line.');
    }
  }

  // --- The furniture's geometry, where a wrong number is invisible.
  if (PATROL_STOP_M <= PATROL_HIT_M) {
    failures.push(
      `The patrol car stops at ${PATROL_STOP_M} m and knocks you down inside ${PATROL_HIT_M} m, so it would ` +
        'stop before it could ever hit anybody. The chase would end in a polite halt.',
    );
  }
  if (PATROL_SPAWN_M >= PATROL_SPAWN_MAX_M) {
    failures.push('The patrol spawn search cannot widen; a suspect off the road graph would never get a car.');
  }
  if (RBT_AHEAD_M <= RBT_SEARCH_M) {
    failures.push(
      `The RBT is placed ${RBT_AHEAD_M} m ahead and searches ${RBT_SEARCH_M} m around that, so it could land ` +
        'behind the player -- which is a roadblock they have already passed.',
    );
  }
  if (POLAIR_CONVERGE_M <= 0) failures.push('Polair converges nobody.');
  if (POLAIR_PURSUIT_TARGET > MAX_ACTORS) {
    failures.push(
      `Polair asks for ${POLAIR_PURSUIT_TARGET} officers and the whole world may hold ${MAX_ACTORS} actors. ` +
        'One suspect would evict every other faction in the city.',
    );
  }

  // --- The voice.
  if (HEAT_LINES.length !== HEAT_MAX + 1) failures.push('There is no HUD line for every rung.');
  for (const line of HEAT_LINES) {
    if (line !== line.toLowerCase()) failures.push(`The heat line "${line}" is not lower case; the HUD's voice is.`);
  }
  if (heatLine(3, 4) === '') failures.push('Reaching 4 stars says nothing at all.');
  if (heatLine(4, 3) !== '') failures.push('Losing a star says something; only losing them all should.');
  if (heatLine(2, 0) === '') failures.push('Getting away entirely says nothing.');

  // --- And the ladder driven end to end, over a synthetic field with no world
  //     behind it. This is the one part of the check that runs the real `step`.
  failures.push(...verifyLadder());
  // Plus the fifth rung's marksman, driven through the same synthetic field.
  // `game/polair.verifyPolair` owns the geometry and the schedule; this owns the
  // *wiring* -- that a five-star player is shot at, a four-star one is not, and a
  // bot never is.
  failures.push(...verifyMarksman());

  return failures;
}

/**
 * The ladder itself, stepped, against a field with no city in it.
 *
 * A world with no collision, no pedestrians and no lanes is a **legal** state
 * here -- it is the offline first second, and it is every self-check -- and the
 * property it exercises is the one that matters most: a wanted player with
 * nobody watching them sheds heat, and one being watched does not. With no
 * pedestrian field there are no beats, so `policeWitness` sees nothing and the
 * decay runs, which is exactly the branch this drives.
 */
function verifyLadder(): string[] {
  const failures: string[] = [];
  const heat = new HeatField();
  const was = installHeat(heat);
  try {
    const combatant = stubCombatant(7);
    const field = stubField();
    const ctx = stubCtx(field, [combatant]);
    const world: HeatWorld = { lanes: null, rideStop: () => -2 };

    // One bystander assault: one star, and the star has to appear on the very
    // next step rather than a tick later.
    heat.report(7, REASON.ASSAULT, WITNESS_KIND.POLICE);
    heat.step(ctx, world);
    if (heat.starsOf(7) !== 1) {
      failures.push(`One witnessed assault produced ${heat.starsOf(7)} stars on the next step, not 1.`);
    }
    const openedAt = heat.version;

    // Hidden: nothing for eight seconds, and then it falls.
    //
    // `HIDDEN_TICKS - 2` more steps rather than `- 1`, and the off-by-one is
    // worth a sentence because it is the check being precise rather than
    // approximate. The step above already counted one hidden tick -- the crime
    // resets the counter and the same step then increments it -- so the *last*
    // step at which nothing may have fallen is the one where the counter reads
    // `HIDDEN_TICKS - 1`. One more and the drain is correct to start.
    for (let i = 0; i < HIDDEN_TICKS - 2; i++) {
      ctx.tick++;
      heat.step(ctx, world);
    }
    const held = heat.pointsOf(7);
    if (Math.abs(held - crimePoints(REASON.ASSAULT)) > 1e-6) {
      failures.push(
        `Points fell to ${held.toFixed(1)} inside the ${HIDDEN_TICKS / 60} s grace, from ` +
          `${crimePoints(REASON.ASSAULT)}. The hidden threshold is not being counted.`,
      );
    }
    // And then all the way down. `SHED_SECONDS[1]` plus the excess over the
    // threshold, with a tick of slack either side.
    const need = HIDDEN_TICKS + Math.ceil((crimePoints(REASON.ASSAULT) - STAR_POINTS[0]) / shedPerTick(1)) + 4;
    for (let i = 0; i < need; i++) {
      ctx.tick++;
      heat.step(ctx, world);
    }
    if (heat.starsOf(7) !== 0) {
      failures.push(
        `After ${(need / 60).toFixed(0)} s out of sight a 1-star player is still at ${heat.starsOf(7)} stars. ` +
          'The decay does not reach the bottom of the ladder.',
      );
    }
    if (heat.version === openedAt) {
      failures.push('The heat version did not move when a star was lost; the transport would never say so.');
    }

    // A knockout wipes it, and takes the row with it.
    heat.report(7, REASON.MURDER_POLICE, WITNESS_KIND.POLICE);
    ctx.tick++;
    heat.step(ctx, world);
    if (heat.starsOf(7) !== 3) failures.push(`An officer down is ${heat.starsOf(7)} stars, not 3.`);
    heat.reset(7);
    if (heat.starsOf(7) !== 0) failures.push('A knockout did not reset the ladder to zero.');
    if (heat.wantedCount !== 0) failures.push('A reset player is still counted as wanted.');

    // The train. Boarding halves, and pulling out of a station sheds a star.
    let stop = -2;
    const riding: HeatWorld = { lanes: null, rideStop: () => stop };
    heat.report(7, REASON.MURDER_POLICE, WITNESS_KIND.POLICE);
    ctx.tick++;
    heat.step(ctx, riding);
    const before = heat.pointsOf(7);
    stop = -1;
    ctx.tick++;
    heat.step(ctx, riding);
    const after = heat.pointsOf(7);
    if (!(after < before * 0.75)) {
      failures.push(
        `Boarding a train took the points from ${before.toFixed(0)} to ${after.toFixed(0)}. ` +
          'The design is that boarding halves them on the spot.',
      );
    }
    stop = 4;
    ctx.tick++;
    heat.step(ctx, riding);
    const atStation = heat.starsOf(7);
    stop = -1;
    ctx.tick++;
    heat.step(ctx, riding);
    if (!(heat.starsOf(7) < atStation)) {
      failures.push(
        `Pulling out of a station left the player at ${heat.starsOf(7)} stars, the same as standing in it. ` +
          'The station getaway is not wired to the doors closing.',
      );
    }
  } finally {
    installHeat(was);
  }
  return failures;
}

/**
 * Polair's marksman, wired up and driven for half an hour of ticks.
 *
 * What this owns is the **wiring**, and each of its four assertions is a way the
 * feature fails while looking finished:
 *
 *   - **No rounds at all** is the whole third of the brief silently absent. The
 *     beam still hunts, the helicopter still flies, and nothing ever shoots -- and
 *     the only symptom is a player saying it feels safe up there.
 *   - **Rounds at four stars** is a helicopter that is not there shooting at
 *     somebody, which presents as random unexplained damage.
 *   - **Rounds at a bot** is the tick budget spent on theatre with no audience.
 *   - **A hit rate nowhere near the curve** means the roll and the threshold have
 *     come apart -- the classic version being a comparison the wrong way round,
 *     which turns a 5% marksman into a 95% one and is invisible in a diff.
 *
 * Thirty minutes of ticks is about a hundred and forty locks, so the observed
 * hit rate has enough samples to be worth an assertion but nowhere near enough to
 * be tight; the band is deliberately wide (0 exclusive to 25%) and it is the
 * *sign* of the comparison it is really testing.
 */
function verifyMarksman(): string[] {
  const failures: string[] = [];
  const heat = new HeatField();
  const was = installHeat(heat);
  try {
    const combatant = stubCombatant(11);
    const field = stubField();
    let damage = 0;
    const ctx = stubCtx(field, [combatant]);
    ctx.damagePlayer = (_id, pips) => {
      damage += pips;
    };
    // The player runs a wide reversing path so the trail's travel bias and the
    // lag both do something. `debugSet` every tick because the check's world has
    // no police in it at all, so the player is permanently hidden and would
    // otherwise shed the rung inside a couple of minutes.
    //
    // The five-star leg is twenty minutes -- about a hundred locks, which is
    // enough samples for the hit-rate band below to mean something -- and the two
    // negative legs are three, because proving a zero needs no statistics. The
    // whole check is under thirty milliseconds and it runs at every boot on both
    // ends, so the minutes are a budget rather than a preference.
    const drive = (world: HeatWorld, stars: number, minutes: number): void => {
      for (let i = 0; i < minutes * 60 * 60; i++) {
        ctx.tick++;
        combatant.body.position.x = 500 * triangleFor(i / 613);
        combatant.body.position.z = 400 * triangleFor(i / 419 + 0.4);
        heat.debugSet(11, stars, ctx.tick);
        heat.step(ctx, world);
      }
    };

    const world: HeatWorld = { lanes: null, rideStop: () => -2 };
    drive(world, 5, 20);
    if (heat.polairShots === 0) {
      failures.push(
        'Twenty minutes at five stars and Polair never fired a round. The marksman is not wired into the step, ' +
          'so the fifth rung is a light and a noise again.',
      );
    }
    if (heat.polairHits > 0 && damage <= 0) {
      failures.push('Polair scored hits and no damage reached the player; the round is going nowhere.');
    }
    if (heat.polairShots > 0) {
      const rate = heat.polairHits / heat.polairShots;
      if (!(rate > 0 && rate < 0.25)) {
        failures.push(
          `Polair landed ${heat.polairHits} of ${heat.polairShots} rounds, a ${(rate * 100).toFixed(1)}% hit ` +
            `rate. The curve says about ${(polairHitChance(240) * 100).toFixed(1)}% at a typical slant; a rate ` +
            'at zero or past a quarter means the roll and the threshold are compared the wrong way round.',
        );
      }
    }

    // --- Four stars: nothing at all.
    heat.reset(11);
    const before = heat.polairShots;
    drive(world, 4, 3);
    if (heat.polairShots !== before) {
      failures.push(
        `${heat.polairShots - before} rounds were fired at a four-star player. Polair is the fifth rung and ` +
          'there is no helicopter over a four-star pursuit to have fired them.',
      );
    }

    // --- And a bot: nothing either, even at five.
    heat.reset(11);
    const beforeBot = heat.polairShots;
    drive({ lanes: null, rideStop: () => -2, isBot: () => true }, 5, 3);
    if (heat.polairShots !== beforeBot) {
      failures.push(
        `${heat.polairShots - beforeBot} rounds were fired at a bot. HeatWorld.isBot is not being consulted, ` +
          'so the authority is spending its tick budget shooting at nobody.',
      );
    }
  } finally {
    installHeat(was);
  }
  return failures;
}

/**
 * A triangle wave, for the check's synthetic path only.
 *
 * Named apart from `polair.triangle` deliberately: importing that one would make
 * this check's *input* depend on the module under test, and a path generator that
 * broke in the same way as the thing it is driving would hide the failure rather
 * than find it.
 */
function triangleFor(u: number): number {
  const f = u - Math.floor(u);
  return f < 0.5 ? 4 * f - 1 : 3 - 4 * f;
}

/** A combatant-shaped record with nothing behind it. The check's only body. */
function stubCombatant(id: number): CombatantState {
  return {
    id,
    body: {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
    },
    health: 3,
    phase: 'idle',
  } as unknown as CombatantState;
}

/** A faction field with no city behind it: enough for `step` to walk. */
function stubField(): FactionField {
  const actors: NpcActor[] = [];
  return {
    actors,
    events: [],
    promote: () => null,
    bark: () => {},
    investigationOf: () => undefined,
  } as unknown as FactionField;
}

function stubCtx(field: FactionField, combatants: readonly CombatantState[]): FactionCtx {
  return {
    tick: 1000,
    dt: 1 / 60,
    collision: null,
    groundHeight: () => 0,
    peds: null,
    combatants,
    field,
    investigationOf: () => undefined,
    damagePlayer: () => {},
    emit: () => {},
  };
}
