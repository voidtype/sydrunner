/**
 * The local stub: three combat dummies, and the thing that puts a pose on one.
 *
 * Spec 9's build order is "punch and powerups **against a local stub**" before
 * any server exists, and this file is the stub. What matters about it is what it
 * is *not*: it is not a separate simulation with its own rules. Each dummy holds
 * the same `CombatantState` the player holds and is advanced by the same
 * `combat.advance`, hit by the same `combat.hitTest` and thrown by the same
 * `combat.applyHit`. The only thing here that a server would delete is the
 * `think()` method -- three dozen lines of behaviour standing in for a second
 * player's input packet.
 *
 * That is the whole point of building it this way. The alternative -- a "training
 * dummy" object with a health number and a hit box of its own -- is faster to
 * write and produces a punch that has never once been evaluated against the
 * arrangement it will ship in, where both parties are `CombatantState` and the
 * hit test is symmetric. Here the aggressor punches the player through exactly
 * the code path the player punches it through, which is why standing next to it
 * is a test of the flinch, the knockback, the hitstop and the respawn *from the
 * receiving end* rather than a demonstration of the giving end twice.
 *
 * ---------------------------------------------------------------------------
 * Three dummies rather than one, and each of them tests something the others
 * cannot:
 *
 *   - **the post** stands still. It is the only one that gives a clean read on
 *     the sphere-cast's reach, because it is the only one whose distance is not
 *     changing while the 150 ms wind-up runs.
 *   - **the pacer** walks a 6 m line. A moving target is the only way to see
 *     whether the hit is evaluated at the *start* of the active window rather
 *     than continuously -- at 2.2 m/s it crosses 3 cm per tick, so a punch that
 *     tracks its target reads as sticky and one that does not reads as a punch.
 *   - **the aggressor** punches back. It exists because the flinch, the red
 *     vignette, the 200 ms shake, the pip loss and the knockout-and-respawn are
 *     all things the player has to be on the wrong end of to have been tested at
 *     all, and there is no other way to get there in a single-player build.
 *
 * ---------------------------------------------------------------------------
 * Why a knocked-out dummy respawns at its post rather than through
 * `combat.pickRespawn`.
 *
 * `pickRespawn` puts a combatant 25-40 m away, which is right for a player and
 * wrong for a piece of test furniture: knock the aggressor out twice and it is
 * eighty metres up Botany Road and the thing you were testing is a walk. The
 * dummies go back where they were put, and `pickRespawn` is exercised in play by
 * the player's own death, which is the case that actually has to work.
 */

import { Vector3 } from 'three/webgpu';

import type { CharacterActor } from '../player/character.ts';
import { EYE_HEIGHT } from '../player/controller.ts';
import {
  createCombatant,
  feetY,
  planSpeed,
  respawnAt,
  type CombatInput,
  type CombatPhase,
  type CombatantState,
} from './combat.ts';

// --- Driving an actor from combat state ---------------------------------------

/**
 * How long spec 8.3's Training gag runs, and how fast the legs go.
 *
 * 1.2 s is about four strides at 3x, which is long enough to register as a
 * deliberate animation and short enough that it is over before the player has
 * finished walking past the entrance they picked it up at. Three is the
 * multiplier at which a run cycle stops reading as running and starts reading
 * as a cartoon -- two is just a fast run, four is a blur with no legs in it.
 */
const CELEBRATE_SECONDS = 1.2;
const CELEBRATE_RATE = 3;

/**
 * Turns a `CombatantState` into a pose, once per frame.
 *
 * The seam between simulation and presentation, and it is one-way by
 * construction: this reads combat state and writes an actor, and nothing it does
 * can be observed by `combat.ts`. That is what lets the poses run on the **frame
 * delta** while the simulation runs on the fixed step -- the choice `main.ts`
 * already made for the character build, and for the same reason: a 100 ms punch
 * quantised to six positions on a 144 Hz display buys nothing.
 *
 * Reactions fire on a phase *change* rather than while a phase is current,
 * because `CharacterActor.setAction` restarts a clip every time it is called and
 * a flinch re-triggered sixty times a second is a figure vibrating at its own
 * attack envelope.
 */
export class ActorDriver {
  readonly actor: CharacterActor;
  private lastPhase: CombatPhase = 'idle';
  /** Whether this body was on a bike last frame. See `update`. */
  private lastRiding = false;
  private readonly feet = { x: 0, y: 0, z: 0 };
  /** Seconds left of spec 8.3's Training pickup gag. See `celebrate`. */
  private celebrateT = 0;

  constructor(actor: CharacterActor) {
    this.actor = actor;
  }

  /**
   * Spec 8.3's Training pickup: *"sprinting on the spot with comically fast
   * legs"*, which is the only pickup animation the spec asks for by name and is
   * a joke, so it had better land.
   *
   * Two lines, and both of them are the joke:
   *
   *   - **`setAction('run')` pins the run clip.** `CharacterActor.update`
   *     already handles a pinned locomotion with no movement under it -- it
   *     drives the stride phase at `PINNED_RUN_SPEED` and slides the feet
   *     deliberately, which is exactly "on the spot" and was written for
   *     console inspection rather than for this. Nothing in `character.ts`
   *     had to change.
   *   - **The pose clock runs at `CELEBRATE_RATE`.** The stride advances by
   *     `speed * dt`, so multiplying the *delta* handed to the actor is the
   *     whole of "comically fast" -- three times the leg frequency, on a clip
   *     that is already a sprint. It is presentation-only by construction: the
   *     actor's clock is not the simulation's, the position still comes from
   *     `CombatantState`, and a frozen `hitstopT` still wins over it below.
   *
   * For the local player this plays on `main.ts`'s `self` body, which the
   * camera excludes and the sun's shadow camera includes -- so what you see of
   * your own is the shadow on the footpath in front of you doing a cartoon
   * sprint. That is the entire first-person feedback this pass ships and it is
   * the right one: it is funny, it is in the world, and it costs no new rig.
   */
  celebrate(): void {
    this.celebrateT = CELEBRATE_SECONDS;
    this.actor.setAction('run');
  }

  /**
   * A football has just left this body's hand: play the throw overlay.
   *
   * Called rather than derived, and that is the difference between this and
   * every other clip `update` fires below. Those are dispatched off a *phase
   * change*, because the swing, the flinch and the knockout are all phases the
   * combat machine holds for a while. A throw is not a phase -- `combat.advance`
   * spends a ball and returns `ballThrown` on one tick and the combatant stays
   * in `idle` throughout, which is deliberate (it is why you can throw mid-swing
   * and while running). So there is no state for `update` to notice, and the
   * caller that saw the event tells the actor directly.
   *
   * `server/sim.ts` reaches the same place by a different route -- it puts a
   * flag in the snapshot and the receiving client fires the overlay on its
   * rising edge -- because a remote's throw has to arrive on the interpolation
   * clock with the ball it threw. Locally there is no clock to wait for.
   */
  threw(): void {
    this.actor.setAction('throw');
  }

  update(c: CombatantState, dt: number): void {
    // The gag first, so a punch or a flinch landing during it wins -- a reaction
    // is a one-shot overlay and it plays over the pinned run without clearing
    // it, which is the correct precedence: being hit while celebrating should
    // show the flinch.
    if (this.celebrateT > 0) {
      this.celebrateT = Math.max(0, this.celebrateT - dt);
      if (this.celebrateT > 0) {
        dt *= CELEBRATE_RATE;
      } else {
        this.actor.setAction(null);
        // `setAction(null)` clears the *reaction* as well as the pin, so a
        // flinch or a punch that started inside the 1.2 s window would be cut
        // off at the exact moment the gag ended. `update`'s own dispatch below
        // only fires on a phase *change*, so nothing would put it back. Three
        // lines to re-issue it; the clip restarts, which is visibly better than
        // a figure snapping out of a flinch mid-recoil.
        if (c.phase === 'windup') this.actor.setAction('punch');
        else if (c.phase === 'flinch') this.actor.setAction('flinch');
        else if (c.phase === 'ko') this.actor.setAction('knockout');
      }
    }

    if (c.phase !== this.lastPhase) {
      if (c.phase === 'windup') this.actor.setAction('punch');
      else if (c.phase === 'flinch') this.actor.setAction('flinch');
      else if (c.phase === 'ko') this.actor.setAction('knockout');
      else if (this.lastPhase === 'ko') this.actor.setAction(null);
      this.lastPhase = c.phase;
    }

    // The lime e-bike's seated pose, on the **edges** of `ridingBike` rather
    // than while it is set, which is the rule every dispatch in this class
    // follows: `setAction` restarts a clip every time it is called.
    //
    // It is *after* the phase dispatch above, so mounting on the frame you are
    // punched still shows the flinch -- a reaction is a one-shot overlay and it
    // replaces the held ride, which is the correct precedence and is moot in
    // practice, since `combat.applyHit` takes the bike away in the same tick.
    // ...and a car's, which is the *same* clip and deliberately so. `clipRide`
    // is "seated, hands forward, torso down", which is a rider on a bike and is
    // also, at this rig's level of detail, somebody at a steering wheel -- and
    // the alternative is a second seated clip that differs from this one by a
    // couple of centimetres of elbow. What it buys is that a driver **sits**
    // rather than standing in the middle of their own car with their head
    // through the roof, which is the one thing about a driven car anybody would
    // notice. `FLAG.RIDING` is set for a driver on the wire for exactly this
    // reason -- see `protocol.ENTER_FLAG.DRIVING` -- so a remote gets it from
    // `main.ts`'s snapshot path with nothing else edited.
    const riding = c.ridingBike !== 0 || c.drivingCar !== 0;
    if (riding !== this.lastRiding) {
      // Cleared to `null` rather than to a locomotion: the ride is a held
      // reaction and what belongs underneath it is the actor's own derived
      // locomotion, which is what `null` restores.
      if (c.phase === 'idle' || riding) this.actor.setAction(riding ? 'ride' : null);
      this.lastRiding = riding;
    }

    const ko = c.phase === 'ko';
    this.feet.x = c.body.position.x;
    this.feet.y = feetY(c);
    this.feet.z = c.body.position.z;
    // Hitstop is frozen *animation*, not a slowed one: the pose holds on the
    // frame the punch landed. Zero is safe through every clip -- the blend
    // weights move by `1 - exp(0)`, the stride advances by zero distance, and
    // the reaction clock does not tick.
    this.actor.update(c.hitstopT > 0 ? 0 : dt, {
      position: this.feet,
      yaw: c.body.yaw,
      // A knocked-out body is travelling at 10 m/s and is not running. The
      // crumple is a whole-body overlay at full weight so the locomotion under
      // it never shows, but feeding it a sprint would still drive the stride
      // phase and leave the legs mid-cycle on the frame it gets up.
      speed: ko ? 0 : planSpeed(c),
      onGround: ko ? true : c.body.onGround,
    });
  }
}

// --- The dummies --------------------------------------------------------------

export type DummyKind = 'post' | 'pacer' | 'aggressor';

/** How far the pacer walks, end to end. */
const PACE_LENGTH = 6;
const PACE_SPEED_INPUT = 0.5; // fraction of WALK_SPEED, via the controller's `forward`

/** Spec-free, and the crudest aggression that produces a fight: stand here, get hit. */
const AGGRO_RANGE = 1.5;
const AGGRO_DWELL = 1.0;
/** Beyond this the aggressor stops tracking and returns to its post heading. */
const AGGRO_NOTICE = 14;

/**
 * The band the aggressor throws a football in, metres, and its own dwell.
 *
 * `server/bots.ts` carries the same three numbers for the same behaviour, and
 * they are deliberately restated rather than shared: this is the *client's*
 * stub and that is a server's opinion, and the two are allowed to diverge -- a
 * bot in a real match has 40 m of street to work with where this one is standing
 * in an arc five metres from the spawn.
 *
 * The floor is outside `AGGRO_RANGE` so a dummy in contact swings rather than
 * throws: the melee has to stay the answer to contact, which is the constraint
 * `game/footy.ts` is shaped by and it applies to a stub as much as to a player.
 * The ceiling is `AGGRO_NOTICE`, because a dummy should not throw at somebody it
 * has already stopped tracking.
 *
 * It exists at all because the stub is only worth having if it is the same code
 * path: without it the third-person throw clip, the ball leaving somebody
 * else's hand and the prop disappearing from their off hand are reachable only
 * with two browsers and a server running, which is exactly the kind of thing
 * that rots.
 */
const THROW_MIN = 5;
const THROW_DWELL = 2.5;

const toPlayer = /*#__PURE__*/ new Vector3();

export class Dummy {
  readonly kind: DummyKind;
  readonly combat: CombatantState;
  readonly driver: ActorDriver;
  /** Where it was placed. A knocked-out dummy comes back here -- see the header. */
  readonly home: Vector3;
  readonly homeYaw: number;

  /** The input packet `think()` fills in and `main.ts` hands to `combat.advance`. */
  readonly input: CombatInput;

  /** +1 or -1 along the pacing axis. */
  private paceDir = 1;
  /** Seconds the player has been inside `AGGRO_RANGE`. */
  private dwell = 0;
  /** The throw's own dwell, separate from the swing's. See `THROW_MIN`. */
  private throwDwell = 0;

  constructor(kind: DummyKind, id: number, actor: CharacterActor, home: Vector3, yaw: number) {
    this.kind = kind;
    this.combat = createCombatant(id, home.x, home.z);
    this.combat.body.position.y = home.y + EYE_HEIGHT;
    this.combat.body.yaw = yaw;
    this.driver = new ActorDriver(actor);
    this.home = home.clone();
    this.homeYaw = yaw;
    this.input = {
      forward: 0,
      right: 0,
      jump: false,
      sprint: false,
      yaw,
      pitch: 0,
      punch: false,
      throwBall: false,
    };
    actor.mesh.name = `character:dummy:${kind}`;
  }

  /** Send it back to its post, at full health. Called on `respawnDue`. */
  respawn(groundAt: (x: number, z: number) => number): void {
    respawnAt(this.combat, this.home.x, groundAt(this.home.x, this.home.z), this.home.z, this.homeYaw);
    this.dwell = 0;
    this.throwDwell = 0;
    this.input.punch = false;
    this.input.throwBall = false;
    this.input.forward = 0;
    this.input.yaw = this.homeYaw;
  }

  /**
   * One tick of behaviour. Writes `this.input`; touches no combat state.
   *
   * Kept strictly to producing an input packet, which is the shape a second
   * player's arriving datagram has. Anything that reached into `this.combat`
   * here would be a behaviour the server could not reproduce.
   */
  think(player: CombatantState, dt: number): CombatInput {
    const input = this.input;
    input.punch = false;
    input.throwBall = false;
    input.forward = 0;
    input.right = 0;

    // A knocked-out or flinching dummy has no say in anything. `advance` ignores
    // the movement half anyway; zeroing it here keeps the packet honest.
    if (this.combat.phase === 'ko' || this.combat.phase === 'flinch') {
      this.dwell = 0;
      return input;
    }

    if (this.kind === 'pacer') {
      // Distance along the pacing axis from home, where the axis is the heading
      // the dummy was placed with. Yaw 0 faces -Z, so the heading vector is
      // (-sin, -cos) -- `controller.step`'s own forward, not a second convention.
      const ax = -Math.sin(this.homeYaw);
      const az = -Math.cos(this.homeYaw);
      const along =
        (this.combat.body.position.x - this.home.x) * ax +
        (this.combat.body.position.z - this.home.z) * az;
      if (along * this.paceDir > PACE_LENGTH / 2) this.paceDir = -this.paceDir;
      // Turning the *body* rather than walking backwards, because the walk clip
      // is keyed to forward travel and a reversed one moonwalks.
      input.yaw = this.paceDir > 0 ? this.homeYaw : this.homeYaw + Math.PI;
      input.forward = PACE_SPEED_INPUT;
      return input;
    }

    if (this.kind === 'aggressor') {
      toPlayer.set(
        player.body.position.x - this.combat.body.position.x,
        0,
        player.body.position.z - this.combat.body.position.z,
      );
      const range = toPlayer.length();
      if (range < AGGRO_NOTICE && range > 1e-3) {
        // Face them. Solving `forward = (-sin yaw, -cos yaw)` for yaw is
        // `atan2(-dx, -dz)`, and getting the two negations wrong produces a
        // dummy that punches exactly 180 degrees away from the player, which
        // looks like the hit test is broken rather than the heading.
        input.yaw = Math.atan2(-toPlayer.x, -toPlayer.z);
      } else {
        input.yaw = this.homeYaw;
      }

      // Dwell rather than a range check alone. A player who walks past should not
      // be punched, and a player who stops in front of it should be -- which is
      // the only rule here that makes the fight the player's decision.
      if (range < AGGRO_RANGE && player.phase !== 'ko') {
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
      // Deliberately **bad at it**: it throws flat at where the player *is*,
      // which at 26 m/s over 8 m lands behind anybody who is moving and squarely
      // on anybody who is not. Standing still in the open is the mistake it
      // punishes, which is the mistake this weapon exists to punish -- and a
      // stub that led its target perfectly would be a stub nobody could learn
      // the arc against.
      if (
        range > THROW_MIN &&
        range < AGGRO_NOTICE &&
        player.phase !== 'ko' &&
        this.combat.ballCharges > 0
      ) {
        this.throwDwell += dt;
        if (this.throwDwell >= THROW_DWELL) {
          input.throwBall = true;
          this.throwDwell = 0;
        }
      } else {
        this.throwDwell = 0;
      }
      return input;
    }

    // The post. Faces where it was put and does nothing at all.
    input.yaw = this.homeYaw;
    return input;
  }

  /** For the dev handle, and for the debug overlay's one-line summary. */
  get report(): { kind: DummyKind; phase: CombatPhase; health: number; stamina: number; dwell: number } {
    return {
      kind: this.kind,
      phase: this.combat.phase,
      health: this.combat.health,
      stamina: this.combat.stamina,
      dwell: this.dwell,
    };
  }
}
