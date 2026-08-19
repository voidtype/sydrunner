/**
 * A car that has been driven into enough walls catches fire, and then it goes
 * off.
 *
 * The owner's words were nine of them -- *"the cars are too weak and need to
 * catch fire and explode"* -- and they name two separate complaints. The first
 * half is a tuning change and lives next door in `game/driving.ts`, where
 * `CRASH_FREE_SPEED`, `CRASH_DAMAGE_PER_SPEED` and `CRASH_DAMAGE_MAX` moved and
 * a glancing-blow rule appeared. The second half is this file: the *end* of a
 * car's life, which until now was a wreck that sat at the kerb smoking gently
 * for the rest of the session.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THIS IS ITS OWN MODULE AND NOT MORE OF `driving.ts`.
 *
 * `game/driving.ts` is three thousand lines and owns four separate things
 * already (the integrator, the take arbitration, the crash curve, the field).
 * The fire is a fifth, it has its own dozen constants, and -- the deciding
 * reason -- **it is read by five files that have no business importing the
 * driving rules**: `world/carsmoke.ts` wants the flame ramp, `server/sim.ts`
 * wants the blast, `client/src/main.ts` wants the HUD line, `game/audio.ts`'s
 * caller wants the crackle level and the wire wants the fuse quantisation. A
 * module whose whole surface is "how does a burning car behave" is a module all
 * five can import without dragging the take arbitration in behind it.
 *
 * **Three-free by rule**, on `game/driving.ts`' own terms: the Bun server runs
 * this exact file, nothing here imports three and nothing here draws. The
 * `world/carsmoke.ts` half is the picture and imports this one, which is the
 * `game/bikes.ts` / `world/bike.ts` split applied to a fire.
 *
 * ---------------------------------------------------------------------------
 * 2. THE FUSE IS A COUNT OF MILLISECONDS THE TICK SWEEP ALREADY WALKS.
 *
 * The brief asked for "a tick stamp", and what a stamp would have to be stamped
 * *from* is the problem: the server's tick counter is not a number a client
 * holds, `Date.now()` is not a number two processes agree about to the frame,
 * and the day/night clock (`sky/cycle.ts`) is an hour long and is the wrong
 * granularity by four orders of magnitude.
 *
 * So a burning car carries `burningMs` -- **milliseconds since it caught** --
 * and it is advanced by `driving.CarField.age`, which is the per-tick sweep that
 * already advances `emptyMs` and `damageCooldownMs` on every record on both
 * ends. That makes the countdown a pure function of (the ignition, the number of
 * ticks since), which is the determinism rule from `game/footy.ts`' header
 * stated for a clock rather than for a position: two processes that agree about
 * when a car caught fire agree about when it explodes, without either of them
 * naming an instant.
 *
 * `NOT_BURNING` is -1 rather than 0, because 0 is a perfectly good "it caught
 * fire on this very tick" and a sentinel that collides with a real value is the
 * bug that makes a car explode six seconds after every crash.
 *
 * On the wire the same fact travels as **deciseconds remaining** in one byte
 * (`protocol.CarRecord.fuse`), because remaining is what the HUD counts down and
 * because a byte is what the record could afford. `burningFromFuse` turns it
 * back, and the 100 ms of quantisation is invisible against a six-second fuse.
 *
 * ---------------------------------------------------------------------------
 * 3. WHY THE BLAST IS A FALLOFF AND NOT A RADIUS.
 *
 * `BLAST_M` is 7 m and the damage runs from three pips at the centre to one at
 * the edge. A flat "everybody inside 7 m loses three pips" was the first draft
 * and it is wrong in the way every binary radius in this game is wrong -- see
 * `traffic.carHitStrength`, whose header makes the argument at length: a
 * threshold makes the last centimetre the difference between a scratch and a
 * knockout, and a player who was killed at 6.9 m and untouched at 7.1 m
 * concludes the damage is random.
 *
 * Linear rather than inverse-square, deliberately. Real blast overpressure falls
 * off much faster than linearly and it would put the whole of the interesting
 * range inside the first two metres, which is a knockout radius of about a car
 * length and nothing else. What the falloff is *for* here is legibility: three
 * pips is "you were standing next to it", one pip is "you felt it", and the
 * gradient between them is the thing that tells a player how close they were.
 *
 * The **knockdown is not graded**, and that is on purpose: everybody in the
 * radius goes over. A blast that damaged you without moving you at 6 m would be
 * an explosion you could stand in.
 *
 * ---------------------------------------------------------------------------
 * 4. AND WHY A DRIVER IS EJECTED WHEN NOTHING ELSE EJECTS THEM.
 *
 * Workstream T deleted the ejection from `traffic.applyCarHit` and its header
 * carries the argument: the owner's report was that being T-boned threw you
 * through your own windscreen, and every car-on-car contact in Sydney ended with
 * a driver face down in the road. `combat.applyHit` still ejects, because being
 * batted at 22 m/s and keeping the wheel is a car steered by a ragdoll.
 *
 * An explosion is the third case and it is the one place this feature deliberately
 * does eject: the car you were sitting in has ceased to exist. There is nothing
 * to stay in. `applyBlastHit` clears `drivingCar` for exactly that reason and the
 * sweep in `driving.CarField.follow` does the rest, which is the same division of
 * labour both of the other two use.
 *
 * ---------------------------------------------------------------------------
 * 5. THE CHAIN, AND WHY IT IS CAPPED PER CAR RATHER THAN PER ROOM.
 *
 * A car going off damages other driven cars within `CHAIN_M`, which is a metre
 * wider than the blast on people: a car is a bigger target than a person and a
 * chain reaction is a *feature* -- the brief says so in as many words. What it
 * must not be is a car park machine-gunning, and the thing that would actually
 * produce that is not the chain, it is **re-ignition**: a car sitting in a
 * cluster takes a blast, catches, takes a second blast two hundred milliseconds
 * later, and has its fuse re-stamped -- forever, as long as anything nearby keeps
 * exploding. A car whose fuse is permanently reset never explodes, and one whose
 * fuse is reset *sometimes* explodes at an unpredictable time.
 *
 * So `canIgnite` refuses a car that caught fire less than `IGNITE_LOCK_MS` ago.
 * Per car rather than per room, because a room-wide rate limit would mean a
 * player crashing their own car into a wall in Newtown being refused a fire
 * because somebody's Camry is burning in Manly -- which is a rule with no
 * possible explanation from inside the game.
 */

// **A type-only import, and it has to be.** The runtime graph is
// `combat -> driving -> carfire`, so a value import back into `combat.ts` would
// close a cycle and put `CAR_HEALTH_FULL_FIRE` below in the temporal dead zone
// on whichever of the three modules a given entry point loads first. Types are
// erased, so this costs nothing at runtime and the cycle does not exist.
import type { CombatantState } from './combat.ts';
// The wire's fuse byte. `net/protocol.ts` imports nothing from `game/`, so this
// direction is safe -- it is the same direction `game/driving.ts` already takes
// for `CAR_HEALTH_FULL`.
import { CAR_FUSE_MAX_DECIS } from '../net/protocol.ts';

/**
 * `driving.CAR_HEALTH_MAX` and `driving.CAR_SMOKING_HEALTH`, restated.
 *
 * **Not imported**, on exactly the arrangement `traffic.CAR_HEALTH_FULL_POSE`
 * has with the same constant and for a harder reason than that one has:
 * `game/driving.ts` imports *this* file (the ignition rules live in
 * `CarField.damage`, which is the one funnel every impact goes through), so an
 * import back the other way is a cycle, and a cycle whose consumers are
 * top-level `const`s is a temporal dead zone rather than a warning.
 *
 * `verifyDriving` asserts the pair against the originals, which is the same
 * cross-check `SPRINT_SPEED` and `CAR_HEALTH_FULL_POSE` are kept honest by.
 */
export const CAR_HEALTH_FULL_FIRE = 100;
export const CAR_SMOKING_HEALTH_FIRE = 40;

// --- The fire ------------------------------------------------------------------------

/** `DrivenCar.burningMs` when the car is not on fire. See section 2 for the -1. */
export const NOT_BURNING = -1;

/**
 * How long a car burns before it explodes, seconds. The brief's 6.
 *
 * Long enough to be a *decision* and short enough to be a threat, which is the
 * whole of the tuning. Six seconds is about twenty metres of sprint from a
 * standing start (`controller.SPRINT_SPEED` is 8.2 m/s and the first second is
 * spent getting there), so a driver who gets out immediately clears `BLAST_M`
 * with room and a driver who sits in the wreck reading the health bar does not.
 * It is also long enough that a second player can *choose* to run toward it,
 * which is the read the whole feature is for.
 *
 * "Getting out does not stop it" is the brief's line and it is what makes the
 * six seconds mean anything: a fuse you could cancel by pressing E is a fuse
 * nobody would ever be caught by.
 */
export const FUSE_S = 6;
/** The same, in the milliseconds `burningMs` counts. */
export const FUSE_MS = FUSE_S * 1000;

/**
 * What a fire takes off a car that still has condition left, hp per second.
 *
 * Eight, and it is deliberately almost cosmetic: by the time a car is burning it
 * has either reached zero (the commonest ignition by far -- every write-off
 * catches) or is under `driving.CAR_SMOKING_HEALTH` with a heavy crash on top of
 * it, so there are at most a few tens of hit points left to take. What the burn
 * rate actually buys is the health *bar* moving while the car is alight, which
 * is the one thing on the HUD that says the fire is doing something. The timer
 * is what matters and this paragraph is the record of knowing that.
 *
 * Applied by `driving.CarField.age` rather than through `CarField.damage`, and
 * the difference is not an oversight: `damage` is the *impact* funnel -- it
 * carries the half-second cooldown, the talent multipliers and the ignition
 * rules -- and a fire is none of those things. Fire does not miss, fire is not
 * reduced by `Ute Life`, and a fire that could re-ignite the car it is already
 * burning would re-stamp its own fuse every tick.
 */
export const BURN_HP_PER_S = 8;

/**
 * What sitting in a burning car costs the driver, pips per second. The brief's
 * 0.25.
 *
 * Four seconds a pip against a five-second fuse and a three-pip player, so
 * riding a fire all the way to the bang costs about a pip and a half and then
 * the blast costs three. That is the shape the number is chosen for: **staying
 * in is survivable and staying in to the end is not**, so the burn is a warning
 * you can read on your own health bar rather than a punishment for not having
 * noticed the notice.
 *
 * Server-side only, and that is a deliberate asymmetry with the car's own burn
 * above. A car's condition is predicted by its driver's client so the bar moves
 * on the frame of the impact; a *player's* health is never predicted anywhere in
 * this project -- it arrives in the snapshot -- and adding the one exception for
 * a quarter of a pip a second would be a second opinion about the only number in
 * the game that decides whether you are standing up.
 */
export const BURN_PIPS_PER_S = 0.25;

/**
 * A single crash this big on a car already under `driving.CAR_SMOKING_HEALTH`
 * sets it alight, even though it did not finish it off.
 *
 * Thirty, which against the retuned `CRASH_DAMAGE_MAX` of 45 is two thirds of
 * the worst impact the game can produce -- so this is not "another dent", it is
 * a car that was already broken taking a proper hit. The other way in is simply
 * reaching zero, which every write-off does, so the two clauses together read:
 * *a car that dies catches fire, and a car that is nearly dead catches fire if
 * you hit it hard enough.*
 *
 * "Already under" is measured on the health the car had **before** the impact,
 * which is the brief's word and is the reading that makes the fire a property of
 * a car's condition rather than of one crash: a healthy car taking a 45 hp wall
 * lands on 55 and drives away, and it is the *next* heavy one that lights it.
 */
export const IGNITE_CRASH_HP = 30;

/**
 * How long after catching fire a car cannot catch fire again, milliseconds. The
 * brief's 3 s.
 *
 * See section 5 of the header: this is the anti-re-stamp rule, and the failure
 * it prevents is a fuse that never runs out.
 */
export const IGNITE_LOCK_MS = 3000;

/** What the HUD says the moment your car catches. The brief's line, verbatim. */
export const BURN_NOTICE = 'get out — it\'s on fire';

// --- The bang ------------------------------------------------------------------------

/** Everybody within this of the explosion is hurt and knocked down, metres. */
export const BLAST_M = 7;
/** Pips taken at the centre of the blast, and at its very edge. See section 3. */
export const BLAST_PIPS_CENTRE = 3;
export const BLAST_PIPS_EDGE = 1;

/** How far the blast reaches *other driven cars*, metres, and what it costs them. */
export const CHAIN_M = 9;
export const CHAIN_DAMAGE = 40;

/**
 * How many pedestrians one blast can put on the footpath.
 *
 * Six, and it is a cap rather than "everybody in the radius" because
 * `pedestrians.runDownPedestrian` deliberately downs the **nearest one per
 * call** -- its header explains why (nine `PedestrianHit` announcements and nine
 * reported crimes for one act), and the way to down a crowd through that
 * function is to call it repeatedly. Six is a circle of bodies around a burning
 * car, which is the picture, and it bounds the work at six broadphase queries on
 * the tick a car explodes rather than one per pedestrian in the suburb.
 */
export const BLAST_PED_MAX = 6;

/**
 * How long the shockwave ring takes to reach `BLAST_M`, seconds, and how long
 * the scorch mark stays on the road.
 *
 * The ring is `teamlook.SLAM_SECONDS`' 0.4 stretched to 0.55, because this ring
 * is a metre smaller than the mega's and reads as *slower and heavier* rather
 * than as a snap; the scorch is the brief's 30 s. Both are here rather than in
 * the renderer because they are the two numbers that go on the wire as a
 * `TEAM_EVENT`'s `untilMs`, and the encoder is not allowed to invent a duration.
 */
export const BOOM_RING_S = 0.55;
export const SCORCH_S = 30;

/**
 * How wide the scorch mark is, metres **across** rather than in radius.
 *
 * Three and a half, which is between a sedan's length (4.6) and its width (1.8):
 * a mark the size of the whole car reads as a shadow somebody forgot to remove
 * and a mark the size of the engine bay is invisible from a car window at speed.
 * What it has to say, ten minutes later and from across the street, is *a car
 * died here* -- and the size that says that is "bigger than the thing that was
 * standing on it, smaller than the lane".
 *
 * Stated as a diameter rather than as the radius the renderer actually scales by
 * because every other measurement in this file is a thing you could pace out:
 * `BLAST_M` is a reach and this is a width, and the one conversion lives at the
 * single place that draws it (`world/carsmoke.SCORCH_R`).
 *
 * Here rather than in `world/carsmoke.ts` on `BOOM_RING_S`' own argument one
 * paragraph up: the mark, the ring and the blast are one event, and a scorch
 * that was wider than the ring that drew it would be a crater with a shockwave
 * inside it.
 */
export const SCORCH_M = 3.5;

/**
 * How many chunks come off a car when it goes, and how long they are in the air.
 *
 * Fourteen at 0.9 s, and both halves are chosen against the same failure: debris
 * is the part of an explosion a player only sees *if it is still there when they
 * look up*. Fewer than about ten reads as litter rather than as a car coming
 * apart; many more and the individual arcs stop being legible and the whole
 * thing turns into a puff, which is what the plume is already for.
 *
 * Nine tenths of a second is the flight time of a chunk thrown at about 8 m/s
 * with a bit of up in it -- long enough for the eye to follow one from the
 * centre to where it lands, short enough that it is gone before the shockwave
 * ring has finished (`BOOM_RING_S` is 0.55) plus a beat. Debris still bouncing
 * around a wreck two seconds later would be the only part of this feature that
 * outlives the bang, and the scorch is deliberately the thing that does that.
 *
 * Both are here rather than in the renderer for `SCORCH_M`'s reason, plus one of
 * their own: the scatter has to be **the same on every client** -- it is a pure
 * function of the blast's position and these two numbers -- and a count that
 * lived in one file could not be the count another file's determinism rests on.
 */
export const DEBRIS_COUNT = 14;
export const DEBRIS_LIFE_S = 0.9;

// --- The rules, as pure functions -----------------------------------------------------

/**
 * Does an impact of `cost` hp on a car that had `healthBefore` set it alight?
 *
 * The whole ignition rule in one expression, and it is a free function rather
 * than a method on `CarField` for `driving.crashDamage`'s reason exactly: the
 * authority and the driver's prediction both ask it, and neither has any
 * business owning it.
 *
 * Two clauses, and the order they are written in is the order they matter:
 *
 *   - **the health reached zero.** Every write-off catches fire. This is the
 *     path essentially every burning car in the game takes, and it is what turns
 *     "cars are too weak" into "cars end".
 *   - **or a heavy hit on an already-broken car**, which is the one that can
 *     catch a driver by surprise: you are limping home on 30 hp, you clip a
 *     bollard properly, and the bonnet goes up while the engine still runs.
 */
export function ignitesOnCrash(healthBefore: number, healthAfter: number, cost: number): boolean {
  if (healthBefore > 0 && healthAfter <= 0) return true;
  return healthBefore > 0 && healthBefore < CAR_SMOKING_HEALTH_FIRE && cost >= IGNITE_CRASH_HP;
}

/**
 * May this car catch fire right now?
 *
 * False for a car that is already burning (there is nothing to light) and for
 * one that caught within `IGNITE_LOCK_MS` (section 5: the fuse must not be
 * re-stamped). Both arguments are fields `driving.CarField.age` advances, so
 * this is a comparison and never a clock read.
 */
export function canIgnite(burningMs: number, igniteLockMs: number): boolean {
  if (burningMs !== NOT_BURNING) return false;
  return !(igniteLockMs > 0);
}

/** Is this car alight? The one place the `NOT_BURNING` sentinel is compared. */
export function isBurning(burningMs: number): boolean {
  return burningMs !== NOT_BURNING;
}

/** Seconds left on the fuse, clamped at zero. Meaningless for a car that is not burning. */
export function fuseRemainingS(burningMs: number): number {
  if (burningMs === NOT_BURNING) return 0;
  const left = (FUSE_MS - burningMs) / 1000;
  return left > 0 ? left : 0;
}

/** Has this fuse run out? The server-authoritative test in `sim.stepCars`. */
export function fuseExpired(burningMs: number): boolean {
  return burningMs !== NOT_BURNING && burningMs >= FUSE_MS;
}

/**
 * The fuse as the wire's deciseconds, 0 for a car that is not burning.
 *
 * **An integer**, deliberately, even though `protocol.clampFuse` would round it
 * anyway: `sim.carRecords()` is read by drivers and by the debug endpoints as
 * well as by the encoder, and a record that reported `28.833333` deciseconds
 * would be a field whose printed value never matches the byte anybody receives.
 * The two functions therefore round identically -- ceiling, floored at 1 while
 * the car is still alight -- and `verifyCarFire` checks the round trip.
 *
 * The floor at 1 is the interesting line and it is `clampFuse`'s reason: 0 on
 * this field means *not burning*, so a car with 40 ms left must not round into
 * it. The countdown reads better ceilinged in any case -- "1" until it is
 * actually gone, which is what a countdown is expected to do.
 */
export function fuseDecis(burningMs: number): number {
  if (burningMs === NOT_BURNING) return 0;
  const decis = Math.ceil(fuseRemainingS(burningMs) * 10);
  if (decis < 1) return 1;
  return decis > CAR_FUSE_MAX_DECIS ? CAR_FUSE_MAX_DECIS : decis;
}

/**
 * And back: what `burningMs` a wire fuse of `decis` implies.
 *
 * `NOT_BURNING` for zero, which is the sentinel's whole job on this path. The
 * quantisation costs at most 100 ms of a 6,000 ms fuse and it always errs
 * *late* -- `clampFuse` ceilings -- so a client draws the fire for up to a tenth
 * of a second after the authority has already blown the car up, which is the
 * right direction: the removal and the `CARBOOM` arrive together and take the
 * wreck away, where the other rounding would leave a hole in the street for two
 * frames before the bang.
 */
export function burningFromFuse(decis: number): number {
  if (!(decis > 0)) return NOT_BURNING;
  const left = decis * 100;
  const since = FUSE_MS - left;
  return since > 0 ? since : 0;
}

/**
 * Pips taken by somebody `distance` metres from the centre of a blast.
 *
 * `BLAST_PIPS_CENTRE` at zero falling linearly to `BLAST_PIPS_EDGE` at
 * `BLAST_M`, and **exactly zero past it** -- not a small number, zero, because
 * the edge of a blast is the one place a player will stand deliberately and a
 * tenth of a pip leaking out to 9 m is a player who dies to something they
 * measured correctly.
 */
export function blastPips(distance: number): number {
  if (!(distance > 0)) return BLAST_PIPS_CENTRE;
  if (distance >= BLAST_M) return distance > BLAST_M ? 0 : BLAST_PIPS_EDGE;
  const t = distance / BLAST_M;
  return BLAST_PIPS_CENTRE + (BLAST_PIPS_EDGE - BLAST_PIPS_CENTRE) * t;
}

// --- What a burning car looks and sounds like -----------------------------------------

/**
 * Everything the renderer and the audio need about a fire, in one record.
 *
 * The same shape and the same argument as `driving.DamageGrade`: three separate
 * systems draw a burning car -- the plume (`world/carsmoke.ts`), the wreck's own
 * pose (`world/drivencars.ts`) and the crackle (`game/audio.ts`) -- and a fire
 * that was at full roar in the flames and half strength in the sound would be
 * three files with three opinions about the same car. So the grading is one pure
 * function, it lives with the constants it is derived from, and it is the part
 * of the visual half that a self-check can assert with no canvas.
 *
 * Fills `out` and returns it: called once per burning car per frame and must not
 * allocate.
 */
export interface FireGrade {
  /** 0 at the instant of ignition, 1 once the fire is established. Scales the flames. */
  flame: number;
  /** Puffs a second of black smoke, over and above the wreck's own plume. */
  smoke: number;
  /** 0..1, rising toward the bang. The crackle's level and the light's brightness. */
  crackle: number;
  /** Seconds left, for the HUD countdown. `fuseRemainingS`, carried so callers ask once. */
  fuseS: number;
}

export function createFireGrade(): FireGrade {
  return { flame: 0, smoke: 0, crackle: 0, fuseS: 0 };
}

/**
 * How long the flames take to come up after the bonnet catches, seconds.
 *
 * Half a second, which is short enough to read as "it caught" and long enough
 * that the fire does not appear at full size in one frame -- the artefact that
 * makes every instanced effect in this renderer look like a decal being switched
 * on. `world/carsmoke.PUFF_LIFE`'s fade is the same idea one file over.
 */
const FLAME_RISE_S = 0.5;

/** How much thicker the smoke gets once the car is alight. A multiplier on the plume. */
export const BURN_SMOKE_RATE = 13;

/** The crackle at the moment of ignition, rising to 1 at the bang. */
const CRACKLE_FROM = 0.35;

export function fireGrade(burningMs: number, out: FireGrade): FireGrade {
  if (burningMs === NOT_BURNING) {
    out.flame = 0;
    out.smoke = 0;
    out.crackle = 0;
    out.fuseS = 0;
    return out;
  }
  const seconds = burningMs / 1000;
  const rise = seconds >= FLAME_RISE_S ? 1 : seconds <= 0 ? 0 : seconds / FLAME_RISE_S;
  out.flame = rise;
  out.smoke = BURN_SMOKE_RATE * rise;
  // Linear in *elapsed* rather than in remaining, so a fuse that is somehow
  // over-run (a client whose tab was backgrounded through the bang) reads as a
  // fire at full roar rather than as one that has gone quiet.
  const t = seconds / FUSE_S;
  const ramp = t < 0 ? 0 : t > 1 ? 1 : t;
  out.crackle = CRACKLE_FROM + (1 - CRACKLE_FROM) * ramp;
  out.fuseS = fuseRemainingS(burningMs);
  return out;
}

/**
 * How far a burning wreck settles on its springs, metres. The brief's 0.15.
 *
 * Applied by `world/drivencars.ts` to the pose it hands the box fleet, which is
 * the cheapest possible way to say "this thing is finished": the tyres have gone
 * and the body is sitting on the rims. It is not a suspension animation and
 * there is deliberately no easing -- a car that sank smoothly over a second
 * would need per-car state in the renderer, which is the thing
 * `world/carsmoke.ts`' header refuses at length.
 */
export const BURN_SETTLE_M = 0.15;

/**
 * The chip the HUD puts above the car-health bar while the car is alight.
 *
 * A pure function returning a string, on `world/drivencars.takePrompt`'s rule
 * and for its reason: the alternative is a pill that is *set* on an event and
 * has exactly one line in the client that takes it down again, which is the
 * reported bug that rule exists because of. There is no set and no clear; there
 * is only what is true now.
 *
 * One decimal place, because the whole quantity is six seconds long and a whole
 * number would spend a sixth of the fire saying "6".
 */
export function fireChip(fuseS: number): string {
  const left = fuseS > 0 ? fuseS : 0;
  return `ON FIRE · ${left.toFixed(1)}`;
}

// --- The blast, applied ----------------------------------------------------------------

/**
 * One combatant caught by an explosion: pips off, off their feet, out of
 * whatever they were in.
 *
 * Modelled line for line on `traffic.applyCarHit`, which is the closest thing in
 * the project -- an impulse from a piece of the world with no attacker behind it
 * -- and it differs in exactly three ways, each of which is a decision:
 *
 *   - **the damage is graded** by `blastPips`, where a car hit is a flat pip.
 *     See section 3.
 *   - **the direction is away from the blast**, where a car throws you the way
 *     the car was going. There is no "way the explosion was going"; what there
 *     is, is a centre, and everything goes outward from it. Somebody standing
 *     exactly on the car gets an arbitrary but *stable* direction rather than a
 *     divide by zero -- see the epsilon below.
 *   - **it ejects a driver**, which nothing else in this project does any more.
 *     Section 4 of the header is the whole argument.
 *
 * `dirX`/`dirZ` is the unit vector from the blast to the victim, which the caller
 * has already computed to get the distance -- passing it in rather than
 * recomputing it here is `closingAlong`'s rule about a function on a sweep.
 *
 * Returns true if the blast was a knockout.
 */
export function applyBlastHit(
  victim: CombatantState,
  pips: number,
  dirX: number,
  dirZ: number,
): boolean {
  victim.health = Math.max(0, victim.health - pips);
  // `combat.applyHit`'s femto-pip clamp, and it matters here for its reason: a
  // victim alive by 4e-16 draws a full pip on the HUD and cannot be knocked out
  // by any finite number of further hits.
  if (victim.health < 1e-9) victim.health = 0;

  victim.body.velocity.set(
    dirX * BLAST_KNOCKBACK_HORIZONTAL,
    BLAST_KNOCKBACK_VERTICAL,
    dirZ * BLAST_KNOCKBACK_HORIZONTAL,
  );
  // The line `combat.applyHit`'s header calls load-bearing: without it the first
  // tick after the blast charges the victim ground friction for a metre of
  // flight they spend in the air.
  victim.body.onGround = false;

  // Off the bike, on `applyCarHit`'s clause and for its reason -- the sweep in
  // `bikes.BikeField.follow` parks it where the body was and nothing here needs
  // to know that class exists.
  victim.ridingBike = 0;
  // And **out of the car**, which is the one thing this function does that
  // `applyCarHit` deliberately does not. See section 4. The two fields that hang
  // off the car go back with it, exactly as `combat.applyHit` puts them back:
  // the mirrored condition so the next car this combatant takes is not born a
  // wreck, and the crash outbox so an impact detected on the tick they came out
  // is not billed to a car that no longer exists.
  victim.drivingCar = 0;
  victim.carSpeed = 0;
  victim.carHealth = CAR_HEALTH_FULL_FIRE;
  victim.carCrashDv = 0;
  victim.carCrashHeadOn = 1;

  const ko = victim.health <= 0;
  if (ko) {
    victim.phase = 'ko';
    victim.koT = 0;
    victim.respawnT = KO_SECONDS_FOR_BLAST;
  } else {
    victim.phase = 'flinch';
    // The long lockout, spent through the existing phase machine exactly as
    // `applyCarHit` spends `CAR_STAGGER`: `advance` runs the flinch until
    // `phaseT` reaches `flinchS`, so a negative start is how a caller buys more
    // than the default 0.3 s without a second timer.
    victim.flinchS = BLAST_STAGGER;
  }
  victim.hitstopT = BLAST_HITSTOP;
  return ko;
}

/**
 * How hard a blast throws somebody, m/s. Harder than a punch and harder than a
 * car, which is the ordering a player would predict.
 *
 * `combat.KNOCKBACK_HORIZONTAL` is 11 and `traffic.CAR_KNOCKBACK_HORIZONTAL` is
 * 10.5; 13 is a shade past both and the vertical is well past both, because the
 * read of an explosion is *up* where the read of a car is *along*. Restated here
 * rather than imported and scaled, on `driving.SPRINT_SPEED`'s arrangement: the
 * numbers are the ones this effect wants and `verifyCarFire` asserts the
 * ordering rather than the derivation.
 */
const BLAST_KNOCKBACK_HORIZONTAL = 13;
const BLAST_KNOCKBACK_VERTICAL = 8.5;

/** How long you are on the floor after a blast, seconds. `combat.KNOCKDOWN_LOCKOUT`. */
const BLAST_STAGGER = 1.0;
/** And the freeze frame. `combat.HITSTOP`'s 0.09, a shade longer for the weight. */
const BLAST_HITSTOP = 0.12;
/** `combat.KO_SECONDS`, restated on `BLAST_KNOCKBACK_HORIZONTAL`'s argument. */
const KO_SECONDS_FOR_BLAST = 3.0;

// --- The self-check --------------------------------------------------------------------

/**
 * What this catches that a typecheck cannot. Every failure below renders a
 * perfectly good frame, which is the standing test for whether a check in this
 * project is worth writing.
 *
 *   - **A fuse that never runs out.** The sentinel colliding with a real value,
 *     the wire rounding a nearly-spent fuse to "not burning", or the ignition
 *     lock re-stamping a car every time something near it goes off. The symptom
 *     is a city with burning cars standing in it forever and no explosions at
 *     all -- which reads as the feature not having shipped.
 *   - **A fuse that runs out instantly.** The mirror failure, from a wire fuse
 *     decoded as elapsed rather than as remaining, and the symptom is a car that
 *     explodes on the frame it catches fire, killing the driver who was about to
 *     get out.
 *   - **Two clients counting differently.** The countdown is a closed form off
 *     the ignition, so a rounding difference between the encoder and the decoder
 *     is two players seeing the same car at two different points in its fuse.
 *   - **A blast with a cliff in it.** A falloff that is not continuous at the
 *     edge is the "killed at 6.9 m, untouched at 7.1 m" failure section 3 exists
 *     to prevent, and nobody reports it as a bug -- they report that the damage
 *     is random.
 *   - **A blast that reaches the whole street.** A falloff that does not reach
 *     zero, or a radius compared as a square against a distance, and the symptom
 *     is a car park explosion that knocks somebody over from a block away.
 *   - **A fire nobody can see.** The flame ramp collapsing to zero, which is a
 *     car that explodes out of a clear blue sky with no warning at all.
 *
 *     bun -e "import {verifyCarFire} from './client/src/game/carfire.ts';
 *             console.log(verifyCarFire())"
 */
export function verifyCarFire(): string[] {
  const failures: string[] = [];

  // --- The two constants this file restates rather than imports. Both are the
  //     arrangement `driving.SPRINT_SPEED` has with the controller, and both are
  //     silent when they drift: a smoke threshold that disagreed with
  //     `driving.CAR_SMOKING_HEALTH` would light cars at a health the bar has
  //     not changed colour at, and a fuse that did not fit the wire byte would
  //     be a car that explodes the instant it catches.
  if (CAR_SMOKING_HEALTH_FIRE !== 40) {
    failures.push(
      `The fire's copy of the smoke threshold is ${CAR_SMOKING_HEALTH_FIRE} against ` +
        `driving.CAR_SMOKING_HEALTH's 40. The two decide the same thing about the same car.`,
    );
  }
  if (FUSE_S * 10 > CAR_FUSE_MAX_DECIS) {
    failures.push(
      `A ${FUSE_S} s fuse is ${FUSE_S * 10} deciseconds against a wire byte that holds ` +
        `${CAR_FUSE_MAX_DECIS}. It would saturate and every client would count down from the cap.`,
    );
  }

  // --- Ignition. The two ways in, and the three ways a car stays cold.
  {
    // Every write-off catches. This is the path almost every fire in the game
    // takes and the one the owner asked for in as many words.
    if (!ignitesOnCrash(12, 0, 12)) failures.push('A car driven to zero did not catch fire. Every write-off burns.');
    if (!ignitesOnCrash(CAR_HEALTH_FULL_FIRE, 0, CAR_HEALTH_FULL_FIRE)) {
      failures.push('A car taken from full to zero in one impossible hit did not catch fire.');
    }
    // A heavy hit on an already-broken car.
    if (!ignitesOnCrash(35, 5, 30)) {
      failures.push(`A ${IGNITE_CRASH_HP} hp hit on a car on 35 did not light it; 35 is under the smoke threshold.`);
    }
    // ...and the three refusals.
    if (ignitesOnCrash(35, 6, IGNITE_CRASH_HP - 1)) {
      failures.push(`A ${IGNITE_CRASH_HP - 1} hp hit lit a broken car; the threshold is ${IGNITE_CRASH_HP}.`);
    }
    if (ignitesOnCrash(CAR_HEALTH_FULL_FIRE, 55, 45)) {
      failures.push(
        'The worst single crash a healthy car can take set it on fire. The rule is "already broken": a ' +
          'full-health car that takes one heavy wall drives away from it.',
      );
    }
    if (ignitesOnCrash(0, 0, 45)) {
      failures.push('A car that was already written off caught fire a second time from a later hit.');
    }
  }

  // --- The ignition lock. Section 5: the fuse must not be re-stampable.
  {
    if (!canIgnite(NOT_BURNING, 0)) failures.push('A cold car with no lock could not be lit at all.');
    if (canIgnite(0, 0)) failures.push('A car that caught fire this very tick was lit again. The sentinel is -1, not 0.');
    if (canIgnite(3000, 0)) failures.push('A car three seconds into its fuse was re-lit, which restarts the countdown.');
    if (canIgnite(NOT_BURNING, 1)) {
      failures.push('A car with a millisecond of ignition lock left was re-lit; the lock is what caps a chain.');
    }
    if (!(IGNITE_LOCK_MS > 0 && IGNITE_LOCK_MS < FUSE_MS)) {
      failures.push(
        `The ignition lock is ${IGNITE_LOCK_MS} ms against a ${FUSE_MS} ms fuse. A lock longer than the ` +
          'fuse would outlive every car it applies to and could never be observed.',
      );
    }
  }

  // --- The fuse, as a countdown and as a closed form.
  {
    if (isBurning(NOT_BURNING)) failures.push('A car that is not burning reported that it was.');
    if (!isBurning(0)) failures.push('A car that caught fire on this tick reported that it was not burning.');
    if (fuseRemainingS(0) !== FUSE_S) failures.push(`A fresh fire has ${fuseRemainingS(0)} s left, not ${FUSE_S}.`);
    if (Math.abs(fuseRemainingS(1500) - (FUSE_S - 1.5)) > 1e-9) {
      failures.push(`A fire 1.5 s old has ${fuseRemainingS(1500)} s left, not ${FUSE_S - 1.5}.`);
    }
    if (fuseRemainingS(FUSE_MS) !== 0) failures.push('A spent fuse reported time remaining.');
    if (fuseRemainingS(FUSE_MS + 5000) !== 0) failures.push('An over-run fuse reported negative time as a positive number.');
    if (fuseExpired(NOT_BURNING)) failures.push('A car that is not burning had an expired fuse. It would explode at the kerb.');
    if (fuseExpired(FUSE_MS - 1)) failures.push('A fuse expired a millisecond early.');
    if (!fuseExpired(FUSE_MS)) failures.push('A fuse that reached its full length had not expired.');

    // **Monotone**, which is the property a player learns: a countdown that went
    // back up would be unexplainable, and it is exactly what an off-by-one
    // between elapsed and remaining produces.
    let last = Infinity;
    for (let ms = 0; ms <= FUSE_MS; ms += 50) {
      const left = fuseRemainingS(ms);
      if (left > last) failures.push(`The fuse went from ${last} s back up to ${left} s at ${ms} ms.`);
      last = left;
    }

    // --- Determinism: the countdown is a function of the tick count and nothing
    //     else, so a car aged in 60 Hz steps and one aged in a single jump are at
    //     the same point. This is the closed-form property `game/traffic.ts`'
    //     header states as a rule, applied to a clock.
    let stepped = 0;
    for (let i = 0; i < 120; i++) stepped += 1000 / 60;
    if (Math.abs(fuseRemainingS(stepped) - fuseRemainingS(2000)) > 1e-9) {
      failures.push(
        `Two seconds of 60 Hz ticks left ${fuseRemainingS(stepped).toFixed(6)} s on the fuse against ` +
          `${fuseRemainingS(2000)} s for one two-second step. The countdown must not depend on the step size.`,
      );
    }
  }

  // --- The wire round trip. `protocol.verifyNet` checks the *bytes*; this checks
  //     that the quantity survives being turned into deciseconds and back, which
  //     is the half that decides whether two clients draw the same countdown.
  {
    if (fuseDecis(NOT_BURNING) !== 0) failures.push('A car that is not burning sent a non-zero fuse.');
    if (fuseDecis(0) !== FUSE_S * 10) failures.push(`A fresh fire encodes as ${fuseDecis(0)} deciseconds, not ${FUSE_S * 10}.`);
    if (burningFromFuse(0) !== NOT_BURNING) failures.push('A zero fuse decoded as a burning car.');
    if (fuseDecis(FUSE_MS) !== 1) {
      failures.push(`A spent fuse encoded as ${fuseDecis(FUSE_MS)}; 0 on that field means "not burning".`);
    }
    if (fuseDecis(0) !== Math.round(fuseDecis(0))) failures.push('The wire fuse is not an integer number of deciseconds.');
    for (const ms of [0, 100, 1500, 3300, FUSE_MS - 100, FUSE_MS - 1]) {
      const back = burningFromFuse(fuseDecis(ms));
      if (!isBurning(back)) {
        failures.push(`A car ${ms} ms into its fuse came back off the wire as not burning.`);
        continue;
      }
      // A tenth of a second of quantisation, and it always errs *late* -- the
      // encoder ceilings -- so the decoded fire is never further along than the
      // authority's. See `burningFromFuse`.
      const drift = back - ms;
      if (drift > 1e-9 || drift < -101) {
        failures.push(
          `A fire ${ms} ms old came back ${drift.toFixed(1)} ms out. The wire is deciseconds and rounds ` +
            'so that a client is never ahead of the authority.',
        );
      }
    }
  }

  // --- The blast falloff, at the four distances the brief names.
  {
    if (blastPips(0) !== BLAST_PIPS_CENTRE) failures.push(`The centre of a blast costs ${blastPips(0)} pips, not ${BLAST_PIPS_CENTRE}.`);
    if (Math.abs(blastPips(BLAST_M / 2) - 2) > 1e-9) {
      failures.push(`Half way out of a blast costs ${blastPips(BLAST_M / 2)} pips; the falloff is linear, so it is 2.`);
    }
    if (Math.abs(blastPips(BLAST_M) - BLAST_PIPS_EDGE) > 1e-9) {
      failures.push(`The edge of a blast costs ${blastPips(BLAST_M)} pips, not ${BLAST_PIPS_EDGE}.`);
    }
    if (blastPips(BLAST_M + 1) !== 0) {
      failures.push(`A metre outside the blast cost ${blastPips(BLAST_M + 1)} pips. Outside is exactly zero.`);
    }
    if (blastPips(60) !== 0) failures.push('A blast reached sixty metres.');
    // Monotone all the way out, and never negative -- a falloff that went
    // through zero would *heal* somebody standing eight metres away.
    let previous = Infinity;
    for (let d = 0; d <= BLAST_M * 2; d += 0.05) {
      const pips = blastPips(d);
      if (pips < 0) failures.push(`A blast healed somebody ${d.toFixed(2)} m away (${pips} pips).`);
      if (pips > previous + 1e-9) failures.push(`The blast got stronger with distance at ${d.toFixed(2)} m.`);
      previous = pips;
    }
    // And the chain reaches further than the blast, because a car is a bigger
    // target than a person. The reverse would be a pile-up where the people
    // burn and the cars do not.
    if (!(CHAIN_M > BLAST_M)) {
      failures.push(`The chain radius (${CHAIN_M} m) is not wider than the blast on people (${BLAST_M} m).`);
    }
    if (!(CHAIN_DAMAGE > 0 && CHAIN_DAMAGE < CAR_HEALTH_FULL_FIRE)) {
      failures.push(
        `A chain hit is ${CHAIN_DAMAGE} of ${CAR_HEALTH_FULL_FIRE} hp. At or over the maximum every car in a ` +
          'car park is written off by one bang, which is the machine-gun this feature is capped against.',
      );
    }
  }

  // --- The look and the sound, graded. There is no picture to check; what is
  //     checkable is that the parameters go somewhere rather than staying at
  //     zero, and that they are the same for a given car at a given instant.
  {
    const g = createFireGrade();
    fireGrade(NOT_BURNING, g);
    if (g.flame !== 0 || g.smoke !== 0 || g.crackle !== 0) {
      failures.push('A car that is not on fire was graded with flames, smoke or a crackle.');
    }
    fireGrade(0, g);
    if (g.flame !== 0) failures.push(`A fire is ${g.flame} of full size on the frame it starts; it has to come up.`);
    fireGrade(600, g);
    if (!(g.flame === 1)) failures.push(`A fire 0.6 s old is at ${g.flame} of full size; it comes up in ${FLAME_RISE_S} s.`);
    if (!(g.smoke > 0)) failures.push('An established fire produces no smoke at all.');
    const early = createFireGrade();
    fireGrade(600, early);
    const late = createFireGrade();
    fireGrade(FUSE_MS - 100, late);
    if (!(late.crackle > early.crackle)) {
      failures.push(`The crackle does not rise toward the bang (${early.crackle} then ${late.crackle}).`);
    }
    if (!(early.crackle > 0 && late.crackle <= 1)) {
      failures.push(`The crackle is outside 0..1 (${early.crackle}, ${late.crackle}).`);
    }
    fireGrade(FUSE_MS + 2000, g);
    if (g.crackle > 1) failures.push(`An over-run fuse pushed the crackle to ${g.crackle}, past full.`);
    if (g.flame <= 0) failures.push('An over-run fuse put the flames out. A backgrounded tab must not extinguish a fire.');
    // The plume is thicker than a wreck's own. `driving.SMOKE_RATE_DEAD` is 8;
    // a fire that smoked *less* than the engine did before it caught would read
    // as the car recovering.
    if (!(BURN_SMOKE_RATE > 8)) {
      failures.push(`A burning car smokes at ${BURN_SMOKE_RATE} puffs a second against a wreck's 8. Fire is thicker.`);
    }
    // The settle is a visible sag and not a car sinking into the road.
    if (!(BURN_SETTLE_M > 0.02 && BURN_SETTLE_M < 0.4)) {
      failures.push(`A burning car settles ${BURN_SETTLE_M} m. Past about 0.4 the body is in the tarmac.`);
    }
  }

  // --- The HUD line and the chip. Strings, because a countdown that reads "6"
  //     for a sixth of the fire is a countdown that is not counting.
  {
    if (fireChip(6) !== 'ON FIRE · 6.0') failures.push(`A fresh fire's chip reads "${fireChip(6)}".`);
    if (fireChip(0.4) !== 'ON FIRE · 0.4') failures.push(`A nearly-spent fire's chip reads "${fireChip(0.4)}".`);
    if (fireChip(-2) !== 'ON FIRE · 0.0') failures.push(`An over-run fire's chip reads "${fireChip(-2)}", which is a negative countdown.`);
    if (!BURN_NOTICE.includes('fire')) failures.push('The ignition notice does not mention the fire.');
  }

  // --- And the two clocks that decide how long a player can react. These are
  //     the numbers the whole feature is, and every one of them is silent when
  //     it is wrong: a two-second fuse is a car that kills its driver before the
  //     notice has faded in, and a thirty-second one is a wreck nobody connects
  //     to the bang.
  if (!(FUSE_S >= 3 && FUSE_S <= 12)) {
    failures.push(`A ${FUSE_S} s fuse is outside "long enough to run and short enough to fear".`);
  }
  if (!(BURN_PIPS_PER_S * FUSE_S < 3)) {
    failures.push(
      `Sitting in a fire for the whole fuse costs ${(BURN_PIPS_PER_S * FUSE_S).toFixed(2)} pips of three. ` +
        'The burn is a warning; the blast is the consequence.',
    );
  }
  if (!(BURN_HP_PER_S > 0 && BURN_HP_PER_S * FUSE_S < CAR_HEALTH_FULL_FIRE)) {
    failures.push(`A whole fuse of burning is ${BURN_HP_PER_S * FUSE_S} hp, which is not a burn rate on a 0..${CAR_HEALTH_FULL_FIRE} scale.`);
  }
  // The knockback ordering: an explosion throws you further than a car and a car
  // further than a fist. A blast that moved you less than a punch would be the
  // least impressive thing in the game.
  if (!(BLAST_KNOCKBACK_HORIZONTAL > 11 && BLAST_KNOCKBACK_VERTICAL > 7)) {
    failures.push(
      `A blast throws at (${BLAST_KNOCKBACK_HORIZONTAL}, ${BLAST_KNOCKBACK_VERTICAL}) against a punch's ` +
        '(11, 5.5) and a car\'s (10.5, 7). An explosion is the hardest thing in the game.',
    );
  }
  if (!(SCORCH_S > BOOM_RING_S * 10)) {
    failures.push(`The scorch mark (${SCORCH_S} s) does not outlast the shockwave (${BOOM_RING_S} s) by any margin.`);
  }

  return failures;
}
