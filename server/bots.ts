/**
 * Two bots, so one human online still has something to hit.
 *
 * This is `game/dummies.ts`'s `think()` and nothing else. That file's header
 * says outright what would survive the move to a server -- *"The only thing here
 * that a server would delete is the `think()` method -- three dozen lines of
 * behaviour standing in for a second player's input packet"* -- and it turns out
 * the correct action was the opposite: `think()` is the only thing that moves
 * *to* the server, because it is the only part of a dummy that is not
 * presentation. The `ActorDriver`, the `CharacterActor` and the pose stay in the
 * browser, where a bot arrives as an ordinary entry in the snapshot with an
 * ordinary animation byte, and no client has any way to tell it from a person.
 *
 * That last clause is the whole design and is worth being explicit about: a bot
 * here is a `CombatantState` in the same array, advanced by the same
 * `combat.advance`, hit by the same `hitTest`, rewound by the same buffer and
 * serialised into the same snapshot record. There is no bot branch anywhere in
 * `sim.ts` except the one line that calls this file instead of reading a socket.
 *
 * ---------------------------------------------------------------------------
 * The behaviour is `dummies.ts`'s two useful personalities, not a third one.
 *
 * The **pacer** walks a fixed line. It is the moving target that makes it
 * visible whether a hit is evaluated once at the start of the active window or
 * continuously -- at 2.2 m/s it crosses 3 cm a tick, so a punch that tracks
 * reads as sticky. Online it does a second job the local build did not need: it
 * is a remote whose position is *predictable*, so a client whose interpolation
 * is wrong shows it as a stutter against a straight line rather than against
 * noise.
 *
 * The **aggressor** closes and punches. It exists because the flinch, the
 * vignette, the pip loss and the knockout-and-respawn are all things a player
 * has to be on the receiving end of to have been tested at all -- and online
 * that is doubly true, because taking a hit from a remote is the one path that
 * exercises reconciliation under a correction the client did not predict.
 *
 * The **post** is not here. It stood still, which was exactly what made it the
 * clean read on the sphere-cast's reach in a local build where you could walk up
 * to it and stare; online it is a coat stand, and the two bots that do something
 * are more useful than three where one is furniture.
 *
 * ---------------------------------------------------------------------------
 * One thing is new, and it is here because the local version could not need it.
 *
 * The aggressor **chases**. `dummies.ts`'s stood at its post and waited for the
 * player to come within 1.5 m, which is right for a test dummy four metres in
 * front of a spawn and useless for a bot in a city: a human who has connected
 * over a network is somewhere else, and a bot that will not walk is a bot nobody
 * ever meets. So it walks toward the nearest live combatant inside 40 m and
 * punches at the same 1.5 m dwell. It cannot open doors, path around a terrace
 * or jump, which means it gets stuck on corners -- and that is left rather than
 * solved, because the fix is a navigation mesh and this is a punching bag.
 */

import {
  type CombatInput,
  type CombatantState,
} from '../client/src/game/combat.ts';

export type BotKind = 'pacer' | 'aggressor';

/**
 * What a bot is called, and the pool a nameless human is given one from.
 *
 * "bot 1" was the previous answer and it is the exact thing this pass exists to
 * remove: a kill feed reading *"bot 2 batted player 1"* is a sentence about
 * process ids. These are the names, and they are chosen to be sayable rather
 * than to be jokes -- a scoreboard that reads Bazza, Shazza, Davo is a
 * scoreboard from a park in Sydney, which is where the game is set.
 *
 * Short on purpose: every one fits inside `MAX_NAME_CHARS` with a dedupe suffix
 * still to come, so "Bazza (2)" never has to clip its stem.
 */
export const BOT_NAMES: readonly string[] = [
  'Bazza',
  'Shazza',
  'Davo',
  'Macca',
  'Johnno',
  'Rusty',
  'Sheila',
  'Bluey',
  'Dazza',
  'Wozza',
  'Gazza',
  'Robbo',
  'Kez',
  'Nugget',
  'Snags',
  'Chook',
];

/**
 * The name for a given index, wrapping with a number past the end of the pool.
 *
 * Deterministic in the index rather than random, which is worth the sentence:
 * the two bots a server starts with are always Bazza and Shazza, so a bug report
 * that says "Shazza is standing in a wall" identifies the pacer without anybody
 * having to correlate an id. Past sixteen it wraps to "Bazza 2" -- a *space*
 * rather than the parenthesis `uniqueName` uses, so a wrapped bot and a deduped
 * human are still distinguishable at a glance.
 */
export function botName(index: number): string {
  const i = Math.max(0, Math.floor(index));
  const base = BOT_NAMES[i % BOT_NAMES.length];
  const lap = Math.floor(i / BOT_NAMES.length);
  return lap === 0 ? base : `${base} ${lap + 1}`;
}

/** The pacer's line, metres end to end, and how hard it walks it. */
const PACE_LENGTH = 14;
const PACE_SPEED_INPUT = 0.55;

/** The aggressor's three ranges. Notice, close to, and punch. */
const AGGRO_NOTICE = 40;
const AGGRO_RANGE = 1.5;
const AGGRO_DWELL = 0.8;

/**
 * The band a bot throws a football in, metres, and how long it dwells first.
 *
 * The floor is well outside `AGGRO_RANGE` so a bot in contact swings rather than
 * throws -- the melee has to stay the answer to contact, which is the constraint
 * `game/footy.ts` is shaped by and it applies to the AI too. The ceiling is
 * inside what a flat throw actually carries, so a bot never lobs one into the
 * pavement at 40 m and looks broken.
 *
 * 2.2 s of dwell against a 4 s refill means a bot throws roughly half as often
 * as its bar allows and spends the rest of its time closing, which is the
 * behaviour that makes it a fight rather than a turret.
 */
const THROW_MIN = 6;
const THROW_MAX = 26;
const THROW_DWELL = 2.2;

/**
 * How long a bot keeps walking at a target it has lost sight of, seconds.
 *
 * Without it a bot that loses its target -- because the target was knocked out,
 * or walked past 40 m -- stops dead on the same tick, which at a distance reads
 * as the server hitching. Two seconds of continuing to walk where it was going
 * is both better-looking and better behaviour: a real player who loses someone
 * round a corner keeps going round the corner.
 */
const PURSUE_MEMORY = 2.0;

export class Bot {
  readonly kind: BotKind;
  readonly combat: CombatantState;
  readonly input: CombatInput;
  /** Where it was put. The pacer's line runs through here; the aggressor comes back. */
  readonly home: { x: number; z: number };
  readonly homeYaw: number;

  private paceDir = 1;
  private dwell = 0;
  /** The throw's own dwell, separate from the swing's. See `aggress`. */
  private throwDwell = 0;
  private pursuing = 0;
  private lastTargetX = 0;
  private lastTargetZ = 0;

  constructor(kind: BotKind, combat: CombatantState, homeYaw: number) {
    this.kind = kind;
    this.combat = combat;
    this.homeYaw = homeYaw;
    this.home = { x: combat.body.position.x, z: combat.body.position.z };
    this.input = {
      forward: 0,
      right: 0,
      jump: false,
      sprint: false,
      yaw: homeYaw,
      pitch: 0,
      punch: false,
      throwBall: false,
    };
  }

  /** Called on respawn: the bot goes back to its post rather than 30 m up the road. */
  reset(x: number, z: number): void {
    this.home.x = x;
    this.home.z = z;
    this.dwell = 0;
    this.throwDwell = 0;
    this.pursuing = 0;
    this.input.punch = false;
    this.input.throwBall = false;
    this.input.forward = 0;
    this.input.yaw = this.homeYaw;
  }

  /**
   * One tick of behaviour. Writes `this.input`; touches no combat state.
   *
   * `dummies.ts`'s rule, kept exactly: anything that reached into `this.combat`
   * would be a behaviour that arrives at the client as a position it cannot
   * account for -- which is precisely what a cheating client looks like from the
   * other end, and is the one thing an authoritative server exists to make
   * impossible.
   */
  think(others: readonly CombatantState[], dt: number): CombatInput {
    const input = this.input;
    input.punch = false;
    input.throwBall = false;
    input.forward = 0;
    input.right = 0;
    input.sprint = false;

    // A knocked-out or flinching bot has no say. `advance` ignores the movement
    // half anyway; zeroing it keeps the packet honest, which matters more here
    // than locally because this packet is now indistinguishable from a human's.
    if (this.combat.phase === 'ko' || this.combat.phase === 'flinch') {
      this.dwell = 0;
      this.throwDwell = 0;
      this.pursuing = 0;
      return input;
    }

    if (this.kind === 'pacer') return this.pace(input);
    return this.aggress(input, others, dt);
  }

  private pace(input: CombatInput): CombatInput {
    // Distance along the pacing axis from home, where the axis is the heading it
    // was placed with. Yaw 0 faces -Z, so the heading vector is (-sin, -cos) --
    // `controller.step`'s own forward, not a second convention.
    const ax = -Math.sin(this.homeYaw);
    const az = -Math.cos(this.homeYaw);
    const along =
      (this.combat.body.position.x - this.home.x) * ax +
      (this.combat.body.position.z - this.home.z) * az;
    if (along * this.paceDir > PACE_LENGTH / 2) this.paceDir = -this.paceDir;
    // Turning the *body* rather than walking backwards, because the walk clip is
    // keyed to forward travel and a reversed one moonwalks -- and the animation
    // byte the client is sent says `WALK`, so it would moonwalk on every screen.
    input.yaw = this.paceDir > 0 ? this.homeYaw : this.homeYaw + Math.PI;
    input.forward = PACE_SPEED_INPUT;
    return input;
  }

  private aggress(input: CombatInput, others: readonly CombatantState[], dt: number): CombatInput {
    const me = this.combat.body.position;
    let target: CombatantState | null = null;
    let bestRange = AGGRO_NOTICE;
    for (const c of others) {
      if (c.id === this.combat.id) continue;
      // A body on the pavement is not a target. `combat.isTargetable` asks the
      // same question about a punch; it is deliberately re-asked here rather
      // than imported, because "can be hit" and "is worth walking toward" are
      // two ideas that agree today and should be free to stop.
      if (c.phase === 'ko' || c.health <= 0) continue;
      const range = Math.hypot(c.body.position.x - me.x, c.body.position.z - me.z);
      if (range < bestRange) {
        bestRange = range;
        target = c;
      }
    }

    if (target) {
      this.lastTargetX = target.body.position.x;
      this.lastTargetZ = target.body.position.z;
      this.pursuing = PURSUE_MEMORY;
    } else if (this.pursuing > 0) {
      this.pursuing = Math.max(0, this.pursuing - dt);
    }

    const goX = this.pursuing > 0 ? this.lastTargetX : this.home.x;
    const goZ = this.pursuing > 0 ? this.lastTargetZ : this.home.z;
    const dx = goX - me.x;
    const dz = goZ - me.z;
    const range = Math.hypot(dx, dz);

    if (range > 1e-3) {
      // Solving `forward = (-sin yaw, -cos yaw)` for yaw is `atan2(-dx, -dz)`.
      // Getting the two negations wrong produces a bot that walks and punches
      // exactly 180 degrees away from its target, which looks like the hit test
      // is broken rather than the heading -- `dummies.ts` records the same trap.
      input.yaw = Math.atan2(-dx, -dz);
    }

    // Walk when there is somewhere to be. The 0.6 m floor on the home case stops
    // a bot at its post oscillating across the last centimetre of it, which at
    // 60 Hz is a figure vibrating.
    if (range > (target ? AGGRO_RANGE * 0.8 : 0.6)) {
      input.forward = 1;
      // Sprint only in pursuit and only from a distance, so closing the last few
      // metres is a walk. A bot that sprints into contact overshoots by half a
      // metre a tick and spends the fight orbiting.
      input.sprint = target !== null && range > 6;
    }

    // Dwell rather than a range check alone: a target who runs past should not
    // be punched, and one who stops in front of it should be. `dummies.ts`'s
    // rule, and the only one here that makes the fight the human's decision.
    if (target && bestRange < AGGRO_RANGE) {
      this.dwell += dt;
      if (this.dwell >= AGGRO_DWELL) {
        input.punch = true;
        this.dwell = 0;
      }
    } else {
      this.dwell = 0;
    }

    // And the football, at range, on its own dwell.
    //
    // Deliberately **bad at it**, and that is the whole design of this branch. A
    // bot that led its target perfectly would be an aimbot with a projectile
    // weapon, which is the least fun thing in any game; what it does instead is
    // throw flat at where the target *is*, which at 26 m/s and 20 m of travel
    // lands behind anybody who is moving and squarely on anybody who is not.
    // Standing still in the open is the mistake it punishes, which is exactly
    // the mistake this weapon exists to punish.
    //
    // The window is `THROW_MIN` to `THROW_MAX` so it never throws at somebody it
    // could be hitting with the bat -- the melee has to stay the answer to
    // contact -- and the dwell is long enough that a bot spends most of its bar
    // on the approach rather than emptying it in the first second.
    if (target && bestRange > THROW_MIN && bestRange < THROW_MAX && this.combat.ballCharges > 0) {
      this.throwDwell += dt;
      if (this.throwDwell >= THROW_DWELL) {
        // Pitched up by a fixed amount rather than by a computed lob, for the
        // reason above: `game/footy.ts` already lofts every throw by 9 degrees,
        // and a further 6 gets a flat-ish ball to about 25 m. Beyond that it
        // falls short, which is a thing a player can watch and learn.
        input.pitch = 0.1;
        input.throwBall = true;
        this.throwDwell = 0;
      }
    } else {
      this.throwDwell = 0;
    }

    return input;
  }
}
