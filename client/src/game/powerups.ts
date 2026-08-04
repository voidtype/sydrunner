/**
 * Spec 8.3's two powerups: the points, the pickup, the modifiers and the respawn.
 *
 * The same file `game/combat.ts` is, for the same reason and under the same
 * three rules -- this is the half of the feature a server keeps. Spec 8.3 ends
 * on *"Server-authoritative pickup"*, which is the identical sentence 8.2 ends
 * on about the punch, so this is written to be lifted whole the day the server
 * exists:
 *
 *   1. **Every function here is a pure function of explicit state.** Nothing
 *      reads a clock, a keyboard, a camera or a scene graph. `tickPowerups`
 *      takes a fixed `dt` and *the list of combatants it should be evaluated
 *      against*, which is the same seam `hitTest`'s `targets` argument is: a
 *      server passes whatever set it considers authoritative and nothing here
 *      needs to know that happened.
 *   2. **Presentation is a return value, never a side effect.** `tickPowerups`
 *      returns which pickups fired this tick; the icon's scale-pop, the chime,
 *      the FOV kick and the HUD chips are the caller's problem.
 *   3. **No import from three at all.** Combat needed `Vector3` for its impulse
 *      maths; this needs nothing but numbers, so it takes nothing.
 *
 * ---------------------------------------------------------------------------
 * The modifier state is two floats on `CombatantState`, and that is deliberate.
 *
 * The obvious shape is a list of active effects with their own expiry times,
 * and it is worse in every way that matters here. There are exactly two effects
 * and spec 8.3 defines them both completely; a list would be an array to
 * allocate, to diff, and -- the one that decides it -- to *serialise*, sixty
 * times a second, per player, into spec 10's snapshot. Two floats counting down
 * is four bytes and a subtraction, it makes "picking up again resets the timer"
 * a single assignment, and it makes the stacking rule fall out of arithmetic
 * rather than out of a resolution pass:
 *
 *     damage x1.4 (Training) x0.8 (Flat White) = x1.12
 *
 * which is the coexistence spec 8.3 implies by giving Flat White a damage
 * *penalty* -- if the two could not overlap, the penalty would never be
 * interesting.
 *
 * ---------------------------------------------------------------------------
 * Health is a float and the pips are its ceiling.
 *
 * Spec 8.2 gives three pips; 8.3 gives +40% damage. 1.4 pips is not a number of
 * pips, and the two obvious resolutions are both wrong: rounding a trained
 * punch up to 2 makes it a *two-hit* kill and rounding down makes the powerup do
 * nothing at all. So damage accumulates as a real number -- `MAX_HEALTH` is
 * 3.0, an ordinary punch is 1.0, a trained one 1.4 -- and the HUD draws
 * `ceil(health)` blocks. Three trained punches still kill (4.2 > 3), two do not
 * (2.8 < 3), and the difference the powerup actually buys is that a trained
 * player finishes a victim who has taken one ordinary hit: 2.0 - 1.4 = 0.6,
 * one pip showing, dead on the next touch.
 *
 * With no modifier anywhere the arithmetic is exactly integral -- 3, 2, 1, 0 in
 * binary floats with no residue -- which is why `verifyCombat` needed no change.
 *
 * ---------------------------------------------------------------------------
 * The jump is a velocity multiplier of sqrt(2), and that is physics rather than
 * a fudge.
 *
 * Spec 8.3 says "+100% jump height". A ballistic apex is `h = v^2 / 2g`, so
 * doubling `h` means multiplying `v` by sqrt(2) = 1.4142, not by 2 -- which
 * would quadruple the height and put a player on a second-storey balcony.
 * `controller.step` takes the velocity multiplier and says so; the conversion
 * lives here, next to the spec number it comes from, and `verifyPowerups`
 * measures the resulting apex against 2x rather than trusting either end.
 *
 * ---------------------------------------------------------------------------
 * Respawn: 90 s for a station, 45 s for a cafe.
 *
 * The 90 is spec 8.3's own -- *"Respawns 90 s after pickup"*, stated for the
 * station and for nothing else. The cafe's is a decision this file is making
 * and it is half of it, on the spec's own characterisation: a station is a
 * "natural contested objective" and a cafe is "the abundant low-stakes pickup
 * that keeps traversal interesting". A pickup that keeps traversal interesting
 * has to be back before you have finished traversing, and 45 s is one and a
 * half Flat White durations -- long enough that camping one is pointless, short
 * enough that a route through Surry Hills always has a live one on it. The
 * asymmetry is the whole reason the two respawns are different numbers rather
 * than one constant: it is what makes a station worth fighting over and a cafe
 * worth running past.
 */

/*
 * This module and `game/combat.ts` import each other, and that is deliberate
 * rather than something to unpick.
 *
 * `combat.advance` calls `advanceModifiers` and hands `speedScale`/`jumpScale`
 * to `controller.step`; `verifyPowerups` below drives real combatants through
 * `advance` and `applyHit`, because a self-check that reimplemented the tick
 * would be checking its own reimplementation. Both directions are load-bearing
 * and the alternative -- a third module holding the two floats, away from the
 * spec numbers that set them -- costs more than the cycle does.
 *
 * What makes it safe is one rule, and it is worth stating because breaking it
 * would be silent: **nothing here reads a `combat.ts` binding at module
 * evaluation time.** Every use is inside a function body, so whichever module
 * the bundler starts with has finished initialising before the other's
 * functions can run. A top-level `const` computed from `MAX_HEALTH` would be
 * `undefined` at exactly one import order out of two, which is the sort of bug
 * that survives every local run and appears in a production build.
 */
import * as combat from './combat.ts';
import { MAX_HEALTH, type CombatInput, type CombatantState } from './combat.ts';
import { EYE_HEIGHT } from '../player/controller.ts';

// --- Kinds --------------------------------------------------------------------

/** Must match `pipeline/sydney/powerups.py`'s `TRAINING` / `FLAT_WHITE`. */
export const TRAINING = 0;
export const FLAT_WHITE = 1;
export const KIND_COUNT = 2;

export type PowerupKind = 0 | 1;

/** What the HUD chip and the debug overlay call them. Spec 8.3's own names. */
export const KIND_NAME: Record<number, string> = {
  [TRAINING]: 'TRAINING',
  [FLAT_WHITE]: 'FLAT WHITE',
};

// --- Spec 8.3's numbers, verbatim ---------------------------------------------

/** "+40% punch damage and +25% movement speed, 45 s." */
export const TRAINING_SECONDS = 45;
export const TRAINING_DAMAGE = 1.4;
export const TRAINING_SPEED = 1.25;

/** "+60% movement speed, +100% jump height, -20% punch damage, 30 s." */
export const FLAT_WHITE_SECONDS = 30;
export const FLAT_WHITE_SPEED = 1.6;
export const FLAT_WHITE_DAMAGE = 0.8;
/**
 * Apex height multiplier, spec 8.3's "+100% jump height" as written.
 *
 * The *velocity* multiplier the controller wants is the square root of this --
 * see the header. Stated as the height because that is what the spec says and
 * because a reader checking this file against the spec should find the spec's
 * own number here.
 */
export const FLAT_WHITE_JUMP_HEIGHT = 2.0;

/** "Respawns 90 s after pickup." The cafe's 45 is this file's; see the header. */
export const RESPAWN_STATION = 90;
export const RESPAWN_CAFE = 45;

/**
 * How close is "touch", metres, measured on the plan.
 *
 * Spec 8.3 says "touch" and gives no radius. 1.6 m is a little over twice the
 * player capsule's 0.34 and a shade over spec 8.2's 1.2 m punch reach, which is
 * the comparison that sets it: walking into a powerup should be easier than
 * punching someone, and it should not be so easy that you collect one you were
 * running past on the other side of the footpath. At a sprint of 8.2 m/s a
 * 3.2 m diameter is 0.39 s of contact, which is 23 fixed steps -- no pickup can
 * be missed between two ticks.
 */
export const PICKUP_RADIUS = 1.6;

/**
 * And how far above or below it, metres.
 *
 * The plan test alone is wrong in a city with roofs in it: the streamer's ground
 * query happily puts a player on a warehouse roof directly over a cafe, and a
 * powerup collected through six metres of building is the same class of error
 * `hitTest`'s plan gate exists to prevent. 2.5 m admits standing on a kerb, on
 * the awning geometry, or mid-jump over the icon, and excludes a storey.
 */
export const PICKUP_HEIGHT = 2.5;

// --- The points ---------------------------------------------------------------

/**
 * One powerup, at a mapped coordinate, with the only two pieces of state it has.
 *
 * `id` is stable for the session and is what a snapshot would key on -- the
 * client composes it from the tile key and the point's index in that tile's
 * sidecar, so a tile that streams out and back in resumes the same respawn
 * clock rather than restarting it. Position is immutable and comes from the
 * pipeline; `active` and `respawnT` are the whole of the mutable state, which
 * is what makes a powerup two bytes and a float in a future snapshot.
 */
export interface PowerupPoint {
  readonly id: string;
  readonly kind: PowerupKind;
  /** World metres. `y` is the ground -- the top of the paving, from the sidecar. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  active: boolean;
  /** Seconds until it comes back. Only meaningful while `active` is false. */
  respawnT: number;
}

/** What one pickup was. Returned rather than acted on -- see the header's rule 2. */
export interface PickupEvent {
  point: PowerupPoint;
  /** Who took it. The caller plays the chime and starts the FOV kick on this one. */
  combatant: CombatantState;
}

export function createPoint(
  id: string,
  kind: PowerupKind,
  x: number,
  y: number,
  z: number,
): PowerupPoint {
  return { id, kind, x, y, z, active: true, respawnT: 0 };
}

/** How long this kind stays gone. */
export function respawnSeconds(kind: PowerupKind): number {
  return kind === TRAINING ? RESPAWN_STATION : RESPAWN_CAFE;
}

/** How long its effect lasts. */
export function effectSeconds(kind: PowerupKind): number {
  return kind === TRAINING ? TRAINING_SECONDS : FLAT_WHITE_SECONDS;
}

// --- The modifiers ------------------------------------------------------------

/**
 * Start (or refresh) an effect on a combatant.
 *
 * Refresh rather than extend, and rather than refuse: spec 8.3 says nothing
 * about it, and of the three possible rules only this one is legible from
 * inside the game. Extending stacks a player to five minutes of Training by
 * running a line of entrances, and refusing means a pickup you walk into does
 * nothing at all with no way to tell why. Resetting the clock is what every
 * player already expects, and it makes the timer on the HUD chip mean one
 * thing.
 */
export function applyPowerup(c: CombatantState, kind: PowerupKind): void {
  if (kind === TRAINING) c.trainingT = TRAINING_SECONDS;
  else c.flatWhiteT = FLAT_WHITE_SECONDS;
}

/** Clear both. Called on respawn, so death is not a way to keep a powerup. */
export function clearPowerups(c: CombatantState): void {
  c.trainingT = 0;
  c.flatWhiteT = 0;
}

/**
 * Slack on the expiry, in seconds. `combat.PHASE_EPSILON`'s argument, at a
 * different scale and for a different reason.
 *
 * 2,700 subtractions of `1/60` from 45 do not land on zero -- they land within
 * a few times 1e-13 of it, on whichever side the rounding falls. Without this
 * the effect survives one extra tick about half the time, so "45 s" is
 * 45.0167 s on alternate builds and the self-check below can only ever assert a
 * tolerance rather than the number. A microsecond is seven orders of magnitude
 * under the shorter of the two durations and four under the timestep, so it can
 * resolve nothing but this.
 */
const EXPIRY_EPSILON = 1e-6;

/**
 * Count both clocks down. Called once per fixed step from `combat.advance`.
 *
 * In `advance` rather than here so that a combatant in hitstop does not age
 * their powerups -- hitstop is that combatant's clock stopping, and a Training
 * that ticked through it would be the one thing in the game whose duration
 * depended on how often you were punched.
 */
export function advanceModifiers(c: CombatantState, dt: number): void {
  if (c.trainingT > 0) c.trainingT = c.trainingT - dt <= EXPIRY_EPSILON ? 0 : c.trainingT - dt;
  if (c.flatWhiteT > 0) c.flatWhiteT = c.flatWhiteT - dt <= EXPIRY_EPSILON ? 0 : c.flatWhiteT - dt;
}

/** Multiplicative, so Training and Flat White give 1.4 x 0.8 = 1.12. */
export function damageScale(c: CombatantState): number {
  return (c.trainingT > 0 ? TRAINING_DAMAGE : 1) * (c.flatWhiteT > 0 ? FLAT_WHITE_DAMAGE : 1);
}

/** Likewise: both running is 1.25 x 1.6 = 2.0, which is a very silly sprint. */
export function speedScale(c: CombatantState): number {
  return (c.trainingT > 0 ? TRAINING_SPEED : 1) * (c.flatWhiteT > 0 ? FLAT_WHITE_SPEED : 1);
}

/**
 * The jump *velocity* multiplier -- the square root of the height multiplier.
 *
 * Training does not touch the jump, so this is one or sqrt(2) and never a
 * product. See the header for the arithmetic and `verifyPowerups` for the
 * measurement.
 */
export function jumpScale(c: CombatantState): number {
  return c.flatWhiteT > 0 ? Math.sqrt(FLAT_WHITE_JUMP_HEIGHT) : 1;
}

// --- The tick -----------------------------------------------------------------

/**
 * Advance every point by one fixed step and return the pickups that fired.
 *
 * Respawns first, then pickups, so a point that came back this tick is
 * available on the same tick -- a one-frame dead zone at the top of a respawn
 * would be invisible and would make the 90 s a 90.017 s.
 *
 * Ties are resolved by combatant order rather than by distance, and that is a
 * netcode decision rather than a gameplay one: two players touching the same
 * cafe on the same tick have to resolve the same way on both machines, and "the
 * caller's array order" is a rule a server can state (it ticks in id order, as
 * `main.ts` already does for the punch) where "the nearer one" is a float
 * comparison that can disagree across two builds.
 *
 * `points` is the caller's resident set rather than the whole world, on the
 * same terms `hitTest`'s `targets` is: a server would pass everything, and this
 * client passes the tiles it has loaded. What that costs is that a respawn
 * clock pauses on a tile the streamer has evicted -- which is unobservable,
 * because the load radius is 1,800 m and leaving it and coming back is 3.6 km,
 * which is 450 s at a sprint against a 90 s worst-case respawn.
 */
export function tickPowerups(
  points: readonly PowerupPoint[],
  combatants: readonly CombatantState[],
  dt: number,
  out: PickupEvent[] = [],
): PickupEvent[] {
  out.length = 0;
  const radius2 = PICKUP_RADIUS * PICKUP_RADIUS;

  for (const p of points) {
    if (!p.active) {
      p.respawnT -= dt;
      // `EXPIRY_EPSILON` again, and for the same reason at six times the scale:
      // 5,400 subtractions of `1/60` from 90 miss zero by a few times 1e-13, so
      // without it a station comes back on tick 5,400 or 5,401 depending on
      // which way the last rounding went.
      if (p.respawnT > EXPIRY_EPSILON) continue;
      p.respawnT = 0;
      p.active = true;
    }

    for (const c of combatants) {
      // A knocked-out body slid 7 m into a cafe must not collect it, and a
      // combatant on 0 pips is a body. `combat.isTargetable` asks exactly this
      // question about a punch; it is the same question here and is deliberately
      // not imported, because "can be hit" and "can pick up" are two ideas that
      // happen to have the same answer today and should be free to stop.
      if (c.phase === 'ko' || c.health <= 0) continue;

      const dx = c.body.position.x - p.x;
      const dz = c.body.position.z - p.z;
      if (dx * dx + dz * dz > radius2) continue;
      // `body.position` is the eye; the point's y is the ground it stands on.
      const feet = c.body.position.y - EYE_HEIGHT;
      if (Math.abs(feet - p.y) > PICKUP_HEIGHT) continue;

      applyPowerup(c, p.kind);
      p.active = false;
      p.respawnT = respawnSeconds(p.kind);
      out.push({ point: p, combatant: c });
      break;
    }
  }

  return out;
}

// --- The field ----------------------------------------------------------------

/**
 * Every powerup the client has ever heard of, keyed by the tile it came in on.
 *
 * Three things about it are decisions rather than mechanics.
 *
 * **It never forgets a tile.** The streamer evicts a tile's geometry at 1,800 m
 * and this keeps its points, which is what makes a respawn survive walking
 * away: a `Map` re-`adopt`ed on reload returns the *same* `PowerupPoint`
 * objects, so the 90 s clock that started before you left is the one still
 * running when you come back. What it costs is the whole extent's points held
 * forever -- 884 objects over the inner ring, well under 100 kB.
 *
 * **Only resident tiles are ticked.** `resident()` is what `tickPowerups` is
 * given, which bounds the per-tick work to the loaded set rather than to the
 * city. A respawn clock therefore *pauses* on an evicted tile; see
 * `tickPowerups` for why that is unobservable at this load radius.
 *
 * **The id is the tile key and the sidecar index**, which is stable across an
 * eviction, across a reload of the page, and across two clients loading the
 * same build -- so it is already the key a server snapshot would use, and no
 * part of this has to change when one exists.
 */
export class PowerupField {
  private readonly byTile = new Map<string, PowerupPoint[]>();
  private readonly residentKeys = new Set<string>();
  private readonly scratch: PowerupPoint[] = [];
  private scratchDirty = true;

  /**
   * Take (or retake) one tile's points, in sidecar order.
   *
   * Idempotent by construction: a tile seen before returns its existing points
   * untouched, so nothing about a reload resets a clock. The coordinates are
   * world metres and the y is the ground.
   */
  adopt(
    tileKey: string,
    kind: Uint8Array,
    worldX: Float32Array,
    worldY: Float32Array,
    worldZ: Float32Array,
  ): readonly PowerupPoint[] {
    let points = this.byTile.get(tileKey);
    if (points === undefined) {
      points = [];
      for (let i = 0; i < kind.length; i++) {
        points.push(
          createPoint(
            `${tileKey}:${i}`,
            (kind[i] === TRAINING ? TRAINING : FLAT_WHITE) as PowerupKind,
            worldX[i],
            worldY[i],
            worldZ[i],
          ),
        );
      }
      this.byTile.set(tileKey, points);
    }
    if (!this.residentKeys.has(tileKey)) {
      this.residentKeys.add(tileKey);
      this.scratchDirty = true;
    }
    return points;
  }

  /** The tile's geometry has gone; stop ticking its points. Their state stays. */
  release(tileKey: string): void {
    if (this.residentKeys.delete(tileKey)) this.scratchDirty = true;
  }

  /**
   * The points worth ticking, flattened.
   *
   * Rebuilt only when the resident set changes, which is a handful of times a
   * second at a walk and not at all when standing still -- the array is handed
   * straight to `tickPowerups` sixty times a second and rebuilding it there
   * would be the most allocated-per-frame thing in the game.
   */
  resident(): readonly PowerupPoint[] {
    if (this.scratchDirty) {
      this.scratch.length = 0;
      for (const key of this.residentKeys) {
        const points = this.byTile.get(key);
        if (points) this.scratch.push(...points);
      }
      this.scratchDirty = false;
    }
    return this.scratch;
  }

  /** For the dev handle and the debug overlay: how many, and how many are up. */
  get report(): { known: number; resident: number; active: number; taken: number } {
    let known = 0;
    for (const points of this.byTile.values()) known += points.length;
    const live = this.resident();
    let active = 0;
    for (const p of live) if (p.active) active++;
    return { known, resident: live.length, active, taken: live.length - active };
  }

  /**
   * One point by its id, or null.
   *
   * What this is for is the networked case, and it is the reason the id is what
   * it is. Spec 8.3 ends on *"Server-authoritative pickup"*, so online the
   * server decides and the client mirrors -- and the server names the point it
   * took as a tile and an index, because that pair is what both ends build the
   * same id string out of, from the same sidecar, in the same order. No roster
   * is exchanged and no mapping can drift. See `net/protocol.ts`'s PICKUP event.
   *
   * A linear walk over the tile's own list rather than a second `Map` keyed by
   * id: a tile holds four points at the median and 64 in the densest block of
   * the CBD, and this runs on a pickup event rather than per frame.
   */
  find(id: string): PowerupPoint | null {
    const colon = id.lastIndexOf(':');
    if (colon < 0) return null;
    const points = this.byTile.get(id.slice(0, colon));
    if (!points) return null;
    const index = Number(id.slice(colon + 1));
    return points[index] ?? null;
  }

  /** The nearest live point to a position, for the dev handle's test recipe. */
  nearest(x: number, z: number, kind?: PowerupKind): PowerupPoint | null {
    let best: PowerupPoint | null = null;
    let bestD = Infinity;
    for (const p of this.resident()) {
      if (kind !== undefined && p.kind !== kind) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}

// --- The self-check -----------------------------------------------------------

const STEP_DT = 1 / 60;

/**
 * Spec 8.3, asserted.
 *
 * The repo's rule -- `verifySouthernHemisphere`, `verifyMovementBasis`,
 * `verifyAnimation`, `verifyCharacterRig`, `verifyCombat` -- is that a check
 * exists where the failure is *silent*: it renders, it does not throw, and it
 * reads as a taste decision. Every clause of 8.3 is one of those.
 *
 * A speed modifier that never reaches `controller.step` is a powerup that
 * chimes, lights a HUD chip, counts down for 45 s and does nothing, and there
 * is no frame in which that looks wrong. A jump multiplier applied to the
 * height instead of the velocity is 4x and puts the player on a roof, which
 * reads as a collision bug. A duration that is 46 s because a phase kept its
 * remainder is unmeasurable by eye. A respawn that never fires leaves the city
 * permanently stripped after twenty minutes of play, by which time nobody
 * remembers what it looked like full. And the stacking rule is arithmetic that
 * is either 1.12 or something else, with no picture either way.
 *
 * So each of those is measured through the code that really runs --
 * `combat.advance` and `controller.step`, not a formula -- exactly as
 * `verifyCombat`'s flight cases are.
 *
 *     node --experimental-strip-types --input-type=module \
 *       -e "import {verifyPowerups} from './src/game/powerups.ts';
 *           console.log(verifyPowerups())"
 */
export function verifyPowerups(): string[] {
  const failures: string[] = [];
  // Named here rather than at the top of the module, so the one-directional
  // shipped graph stays visible in the import list: everything `combat.ts`
  // exports that this file needs at runtime is used inside this function and
  // nowhere else. See the note beside the import.
  const { advance, applyHit, createCombatant, respawnAt } = combat;

  const flat = { collision: null, groundHeight: (): number => 0 };
  const rest = (yaw = 0): CombatInput => ({
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    yaw,
    pitch: 0,
    punch: false,
  });

  // --- Pickup: 1.6 m works and takes the point out of the world.
  {
    const c = createCombatant(0, 0, 0);
    const near = createPoint('near', FLAT_WHITE, 1.0, 0, 0);
    const far = createPoint('far', FLAT_WHITE, 4.0, 0, 0);
    const events = tickPowerups([near, far], [c], STEP_DT);
    if (events.length !== 1) {
      failures.push(
        `A combatant standing 1.0 m from one powerup and 4.0 m from another collected ` +
          `${events.length}; the pickup radius is ${PICKUP_RADIUS} m.`,
      );
    }
    if (near.active) failures.push('A collected powerup was still active.');
    if (!far.active) failures.push('A powerup 4 m away was collected.');
    if (c.flatWhiteT !== FLAT_WHITE_SECONDS) {
      failures.push(`Picking up a Flat White set the clock to ${c.flatWhiteT}, not ${FLAT_WHITE_SECONDS}.`);
    }
    // A second tick must not collect it again, and must not fire an event.
    if (tickPowerups([near], [c], STEP_DT).length !== 0) {
      failures.push('An inactive powerup fired a second pickup event.');
    }
    // Directly above, on a roof, must not reach it.
    const upstairs = createCombatant(1, 0, 0);
    upstairs.body.position.y += PICKUP_HEIGHT + 1;
    const roofPoint = createPoint('roof', FLAT_WHITE, 0, 0, 0);
    if (tickPowerups([roofPoint], [upstairs], STEP_DT).length !== 0) {
      failures.push(
        `A combatant ${(PICKUP_HEIGHT + 1).toFixed(1)} m above a powerup collected it. ` +
          `The height gate is ${PICKUP_HEIGHT} m and exists so a roof is not a shopping trip.`,
      );
    }
  }

  // --- The effects expire at exactly 45 and 30 s, through `advance`.
  for (const [kind, seconds, label] of [
    [TRAINING, TRAINING_SECONDS, 'Training'],
    [FLAT_WHITE, FLAT_WHITE_SECONDS, 'Flat White'],
  ] as Array<[PowerupKind, number, string]>) {
    const c = createCombatant(0, 0, 0);
    applyPowerup(c, kind);
    const ticks = Math.round(seconds / STEP_DT);
    for (let i = 0; i < ticks - 1; i++) advance(c, rest(), STEP_DT, flat);
    const remaining = kind === TRAINING ? c.trainingT : c.flatWhiteT;
    if (!(remaining > 0)) {
      failures.push(
        `${label} expired after ${(seconds - remaining).toFixed(2)} s of simulated time; ` +
          `spec 8.3 says ${seconds} s.`,
      );
    }
    advance(c, rest(), STEP_DT, flat);
    const after = kind === TRAINING ? c.trainingT : c.flatWhiteT;
    if (after !== 0) {
      failures.push(`${label} still had ${after.toFixed(3)} s left after its full ${seconds} s.`);
    }
  }

  // --- Damage: an ordinary punch is 1 pip, a trained one 1.4, both through
  // `applyHit`. Three trained punches kill and two do not, which is the whole
  // behavioural difference the +40% buys.
  {
    const attacker = createCombatant(0, 0, 1.0);
    const victim = createCombatant(1, 0, 0);
    applyHit(attacker, victim);
    if (Math.abs(victim.health - (MAX_HEALTH - 1)) > 1e-9) {
      failures.push(`An unmodified punch took ${(MAX_HEALTH - victim.health).toFixed(2)} pips, not 1.`);
    }
    const trained = createCombatant(2, 0, 1.0);
    const target = createCombatant(3, 0, 0);
    applyPowerup(trained, TRAINING);
    applyHit(trained, target);
    if (Math.abs(target.health - (MAX_HEALTH - TRAINING_DAMAGE)) > 1e-9) {
      failures.push(
        `A Training punch took ${(MAX_HEALTH - target.health).toFixed(2)} pips; spec 8.3's ` +
          `+40% on a 1-pip punch is ${TRAINING_DAMAGE}.`,
      );
    }
    // Two trained punches must not be a knockout; three must.
    const t2 = createCombatant(4, 0, 0);
    applyHit(trained, t2);
    applyHit(trained, t2);
    if (t2.phase === 'ko') failures.push('Two Training punches knocked a full-health victim out; 2 x 1.4 is 2.8.');
    applyHit(trained, t2);
    if (t2.phase !== 'ko') failures.push('Three Training punches did not knock a victim out; 3 x 1.4 is 4.2.');
  }

  // --- Stacking multiplies, and each pickup resets only its own clock.
  {
    const c = createCombatant(0, 0, 0);
    applyPowerup(c, TRAINING);
    applyPowerup(c, FLAT_WHITE);
    const want = TRAINING_DAMAGE * FLAT_WHITE_DAMAGE;
    if (Math.abs(damageScale(c) - want) > 1e-9) {
      failures.push(`Training and Flat White together give damage x${damageScale(c).toFixed(3)}, not x${want}.`);
    }
    const wantSpeed = TRAINING_SPEED * FLAT_WHITE_SPEED;
    if (Math.abs(speedScale(c) - wantSpeed) > 1e-9) {
      failures.push(`Both together give speed x${speedScale(c).toFixed(3)}, not x${wantSpeed}.`);
    }
    // Burn 10 s off both, then re-take the Training only.
    for (let i = 0; i < Math.round(10 / STEP_DT); i++) advance(c, rest(), STEP_DT, flat);
    applyPowerup(c, TRAINING);
    if (Math.abs(c.trainingT - TRAINING_SECONDS) > 1e-9) {
      failures.push(`Re-taking a Training left ${c.trainingT.toFixed(2)} s on the clock instead of resetting to ${TRAINING_SECONDS}.`);
    }
    if (c.flatWhiteT > FLAT_WHITE_SECONDS - 9) {
      failures.push(`Taking a Training also refreshed the Flat White (${c.flatWhiteT.toFixed(2)} s left after 10 s).`);
    }
    // And a respawn clears both -- death must not be a way to keep a powerup.
    respawnAt(c, 0, 0, 0, 0);
    if (c.trainingT !== 0 || c.flatWhiteT !== 0) {
      failures.push(`A respawned combatant kept ${c.trainingT.toFixed(1)} s of Training and ${c.flatWhiteT.toFixed(1)} s of Flat White.`);
    }
  }

  // --- The speed modifier reaches `controller.step`. Measured as distance
  // travelled over one second of simulated running, which is the only test that
  // can tell "the number is in the state" from "the number reaches the
  // integrator" -- and the second is the thing that can silently not happen.
  {
    const walk = (c: CombatantState): number => {
      const from = c.body.position.x;
      const input = rest();
      input.forward = 1;
      input.sprint = true;
      // Two seconds: one for the acceleration ramp to finish and one to measure,
      // because at 48 m/s^2 the ramp is ~0.17 s and including it would dilute
      // the ratio by about 8%.
      for (let i = 0; i < Math.round(1 / STEP_DT); i++) advance(c, input, STEP_DT, flat);
      const mark = c.body.position.x;
      for (let i = 0; i < Math.round(1 / STEP_DT); i++) advance(c, input, STEP_DT, flat);
      void from;
      return Math.abs(c.body.position.x - mark);
    };
    // Yaw -90 faces +X, so `forward` moves along x and the measurement is one
    // axis rather than a hypotenuse.
    const plain = createCombatant(0, 0, 0);
    plain.body.yaw = -Math.PI / 2;
    const base = walk(plain);

    for (const [kind, want, label] of [
      [TRAINING, TRAINING_SPEED, 'Training'],
      [FLAT_WHITE, FLAT_WHITE_SPEED, 'Flat White'],
    ] as Array<[PowerupKind, number, string]>) {
      const c = createCombatant(1, 0, 0);
      c.body.yaw = -Math.PI / 2;
      applyPowerup(c, kind);
      const ratio = walk(c) / base;
      if (Math.abs(ratio - want) > 0.02) {
        failures.push(
          `${label} moved a combatant ${ratio.toFixed(3)}x as far in a second as an ` +
            `unmodified one; spec 8.3 asks for ${want}x. The modifier is not reaching ` +
            `controller.step -- check InputSnapshot.speedScale.`,
        );
      }
    }
  }

  // --- The jump reaches 2x height, and it is the *height* that is checked
  // rather than the velocity, because the sqrt is exactly the thing that can be
  // dropped without any symptom other than a player on a roof.
  {
    const apex = (c: CombatantState): number => {
      const start = c.body.position.y;
      const input = rest();
      input.jump = true;
      advance(c, input, STEP_DT, flat);
      input.jump = false;
      let peak = c.body.position.y;
      for (let i = 0; i < 120; i++) {
        advance(c, input, STEP_DT, flat);
        peak = Math.max(peak, c.body.position.y);
        if (c.body.onGround && i > 4) break;
      }
      return peak - start;
    };
    const plain = createCombatant(0, 0, 0);
    const base = apex(plain);
    const boosted = createCombatant(1, 0, 0);
    applyPowerup(boosted, FLAT_WHITE);
    const ratio = apex(boosted) / base;
    if (Math.abs(ratio - FLAT_WHITE_JUMP_HEIGHT) > FLAT_WHITE_JUMP_HEIGHT * 0.05) {
      failures.push(
        `A Flat White jump reached ${ratio.toFixed(3)}x the ordinary apex; spec 8.3 says ` +
          `${FLAT_WHITE_JUMP_HEIGHT}x. Apex is v^2/2g, so the velocity multiplier must be ` +
          `sqrt(${FLAT_WHITE_JUMP_HEIGHT}) = ${Math.sqrt(FLAT_WHITE_JUMP_HEIGHT).toFixed(4)}; ` +
          `a ratio near 4 means the height multiplier was passed straight to the velocity.`,
      );
    }
  }

  // --- Respawn: 90 s for a station, 45 for a cafe, counted in fixed steps.
  for (const [kind, seconds, label] of [
    [TRAINING, RESPAWN_STATION, 'A station'],
    [FLAT_WHITE, RESPAWN_CAFE, 'A cafe'],
  ] as Array<[PowerupKind, number, string]>) {
    const c = createCombatant(0, 0, 0);
    const p = createPoint('r', kind, 0.5, 0, 0);
    tickPowerups([p], [c], STEP_DT);
    if (p.active) {
      failures.push(`${label} powerup was not taken by a combatant standing on it.`);
      continue;
    }
    // Move the combatant away, or it re-takes it the instant it returns.
    c.body.position.x = 40;
    let ticks = 0;
    while (!p.active && ticks < Math.round(seconds / STEP_DT) * 2) {
      tickPowerups([p], [c], STEP_DT);
      ticks++;
    }
    const elapsed = ticks * STEP_DT;
    if (Math.abs(elapsed - seconds) > 0.05) {
      failures.push(`${label} powerup came back after ${elapsed.toFixed(2)} s; it should be ${seconds} s.`);
    }
  }

  // --- A knocked-out body does not go shopping.
  {
    const attacker = createCombatant(0, 0, 1.0);
    const victim = createCombatant(1, 0, 0);
    victim.health = 1;
    applyHit(attacker, victim);
    const p = createPoint('ko', TRAINING, victim.body.position.x, 0, victim.body.position.z);
    if (tickPowerups([p], [victim], STEP_DT).length !== 0) {
      failures.push('A knocked-out combatant collected a powerup.');
    }
  }

  return failures;
}
