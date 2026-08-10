/**
 * First-person controller.
 *
 * Written to be safe to hand to the netcode later: `step()` takes an explicit
 * input snapshot and a fixed timestep and is a pure function of state plus input,
 * which is what client-side prediction and server rewind both require. Nothing
 * here reads the keyboard or the clock.
 *
 * The previous attempt's headline bug was W not going where the camera looked,
 * caused by collision resolution overriding the movement basis. Movement here is
 * derived from yaw only, collision runs strictly afterwards on the resulting
 * position, and `verifyMovementBasis()` asserts the relationship.
 */

import { Euler, Vector3 } from 'three/webgpu';

import { BODY_HEIGHT_M, type CollisionWorld } from './collision.ts';

export interface InputSnapshot {
  forward: number; // -1..1
  right: number; // -1..1
  jump: boolean;
  sprint: boolean;
  /** Absolute yaw/pitch in radians, applied by the caller from mouse deltas. */
  yaw: number;
  pitch: number;
  /**
   * Multiplier on the target ground speed. Absent means 1.
   *
   * This is spec 8.3's movement powerups arriving, and it is here rather than
   * anywhere else because there is nowhere else it can be *pure*. The three
   * alternatives were each tried on paper first:
   *
   *   - **Scale the wish vector.** `step` normalises it two lines later, so a
   *     magnitude over 1 is thrown away and one under 1 is a slow *walk* rather
   *     than the same walk at a different top speed. It cannot express +60%.
   *   - **Scale the velocity after `step` returns.** It multiplies the
   *     acceleration ramp and the friction decay along with the top speed, so a
   *     Flat White player skates rather than moves, and it breaks the very thing
   *     `step`'s header exists to guarantee: the caller would be editing state
   *     the server also owns, outside the function both ends run.
   *   - **Make WALK_SPEED and SPRINT_SPEED mutable.** A global, and the wrong
   *     shape entirely once a second combatant has a different one.
   *
   * So it is a field of the input snapshot, which is exactly what a snapshot is
   * for: everything that decides a tick, in one record, sent over the wire.
   * `step` stays a pure function of state plus input, prediction and rewind both
   * still reproduce the trajectory, and the constants below are untouched.
   * Optional, so every existing caller -- `verifyMovementBasis` included -- is
   * unchanged and means 1.
   */
  speedScale?: number;
  /** The same for the jump impulse. Absent means 1. See `speedScale`. */
  jumpScale?: number;
}

export interface PlayerState {
  position: Vector3;
  velocity: Vector3;
  onGround: boolean;
  yaw: number;
  pitch: number;
}

/** Metres. Eye height of a standing adult, and the capsule that follows them. */
export const EYE_HEIGHT = 1.68;
export const PLAYER_RADIUS = 0.34;

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 8.2;
/**
 * Metres per second squared. Deliberately snappy -- this is a brawler, not a sim.
 *
 * Exported, and only that -- the value is untouched, on `GRAVITY`'s terms below.
 * It is how much a body's speed can move in one step, which makes it the size of
 * the error a reconciler makes if it replays an acceleration ramp from the wrong
 * starting speed: `net/client.ts`'s `ackedVelocity` is the fix for having done
 * exactly that, and `integration-check.checkAccelerationRamp` derives its bound
 * from this number rather than from a literal chosen to pass.
 */
export const ACCELERATION = 48;
const AIR_ACCELERATION = 9;
const FRICTION = 34;
const AIR_FRICTION = 1.5;
/**
 * Exported, and only that -- the value is untouched.
 *
 * `game/combat.ts` integrates a knocked-out body itself rather than through
 * `step`, because a corpse has no wish velocity and does not climb kerbs. It has
 * to fall at exactly this rate: a knockout arc that differs from the arc a
 * flinching victim flies on is two different games at 2 and 3 pips, and the
 * spec's 6-8 m is asserted against both. `character.DemoDummy` duplicates the
 * number instead, deliberately, because a demonstration must never become a
 * reason to touch the controller -- combat is not a demonstration.
 */
export const GRAVITY = -22.5;
const JUMP_VELOCITY = 7.1;
/** Steps up to this height are climbed rather than blocked -- kerbs, mostly. */
const STEP_HEIGHT = 0.42;
const MAX_PITCH = Math.PI / 2 - 0.02;

export function createPlayerState(x = 0, z = 0): PlayerState {
  return {
    position: new Vector3(x, EYE_HEIGHT, z),
    velocity: new Vector3(),
    onGround: true,
    yaw: 0,
    pitch: 0,
  };
}

/**
 * Advance the player by one fixed step.
 *
 * `dt` must be fixed (the caller accumulates and calls this at a constant rate)
 * so that prediction on the client and simulation on the server produce the same
 * trajectory for the same inputs.
 */
/**
 * `groundHeightAt` is given the player's current feet height as well as their
 * position, and it needs it: since terrain, "how high is the ground" and "am I
 * on a roof" are different questions with different answers at the same (x, z),
 * and only the caller's height distinguishes standing on a warehouse from
 * standing beside it.
 */
export function step(
  state: PlayerState,
  input: InputSnapshot,
  dt: number,
  world: CollisionWorld | null,
  groundHeightAt: (x: number, z: number, feetY: number) => number,
): void {
  state.yaw = input.yaw;
  state.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch));

  // --- Movement basis: yaw only.
  // Pitch must not tilt the walk direction, and this is derived from yaw alone
  // rather than from the camera matrix so that looking at the sky cannot make the
  // player crawl. Three's default camera looks down -Z, so forward is
  // (-sin yaw, 0, -cos yaw).
  const sinY = Math.sin(state.yaw);
  const cosY = Math.cos(state.yaw);
  const forwardX = -sinY;
  const forwardZ = -cosY;
  const rightX = cosY;
  const rightZ = -sinY;

  let wishX = forwardX * input.forward + rightX * input.right;
  let wishZ = forwardZ * input.forward + rightZ * input.right;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1e-5) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  // Steer the current velocity toward the wish velocity at a bounded rate.
  // Expressed as a single move-toward rather than separate accelerate and
  // friction passes: with input it accelerates, without input the wish velocity
  // is zero so the same code decelerates. `wishLen` is already normalised, so
  // diagonal movement is not faster than straight.
  // `speedScale` multiplies the *target*, not the acceleration or the friction,
  // which is what makes a powerup change how fast you end up going without
  // changing how the controller feels getting there. See `InputSnapshot`.
  const targetSpeed =
    (input.sprint ? SPRINT_SPEED : WALK_SPEED) *
    (input.speedScale ?? 1) *
    Math.min(wishLen, 1);
  const wishVelX = wishX * targetSpeed;
  const wishVelZ = wishZ * targetSpeed;

  const dvx = wishVelX - state.velocity.x;
  const dvz = wishVelZ - state.velocity.z;
  const dvLen = Math.hypot(dvx, dvz);
  if (dvLen > 1e-6) {
    const rate = wishLen > 1e-5
      ? (state.onGround ? ACCELERATION : AIR_ACCELERATION)
      : (state.onGround ? FRICTION : AIR_FRICTION);
    const maxDelta = rate * dt;
    const scale = Math.min(1, maxDelta / dvLen);
    state.velocity.x += dvx * scale;
    state.velocity.z += dvz * scale;
  }

  // --- Vertical
  if (input.jump && state.onGround) {
    // `jumpScale` is a scale on the *velocity*, and the caller is responsible
    // for the square root -- apex height is `v^2 / 2g`, so spec 8.3's "+100%
    // jump height" is a velocity multiplier of sqrt(2), not 2. Doing the
    // conversion here instead would put a gameplay unit inside the integrator
    // and make this line lie about what it does. `game/powerups.ts` carries the
    // arithmetic and `verifyPowerups` measures the resulting apex.
    state.velocity.y = JUMP_VELOCITY * (input.jumpScale ?? 1);
    state.onGround = false;
  }
  state.velocity.y += GRAVITY * dt;

  // --- Integrate, then resolve. Never the other way round.
  const fromX = state.position.x;
  const fromZ = state.position.z;
  const toX = fromX + state.velocity.x * dt;
  const toZ = fromZ + state.velocity.z * dt;

  const feetY = state.position.y - EYE_HEIGHT;
  let resolvedX = toX;
  let resolvedZ = toZ;
  if (world) {
    // The two ends of the capsule, and only the bottom one carries the step.
    //
    // `feetY + STEP_HEIGHT` is the probe that has always been passed here: a
    // kerb whose top is inside the step is climbed rather than walked into.
    // The head is measured from the **unlifted** feet, because the step is a
    // thing the feet may do and not a thing that makes the player taller --
    // lifting both ends would demand 2.22 m of headroom to walk under a span,
    // which is over the 2.2 m `cli.WALKABLE_UNDER_M` the pipeline audits
    // against, and this controller is the body that audit is written about.
    // At 1.8 m the player clears every soffit the build calls walk-under with
    // 0.4 m to spare, and `decks.WALK_UNDER_M`'s 2.6 m with 0.8 m.
    const r = world.resolve(
      fromX,
      fromZ,
      toX,
      toZ,
      PLAYER_RADIUS,
      feetY + STEP_HEIGHT,
      feetY + BODY_HEIGHT_M,
    );
    resolvedX = r.x;
    resolvedZ = r.z;
    if (r.hit) {
      // Kill only the velocity component that went into the wall, so the player
      // slides along it instead of stopping dead.
      const movedX = resolvedX - fromX;
      const movedZ = resolvedZ - fromZ;
      const wantX = toX - fromX;
      const wantZ = toZ - fromZ;
      const wantLen2 = wantX * wantX + wantZ * wantZ;
      if (wantLen2 > 1e-9) {
        const along = (movedX * wantX + movedZ * wantZ) / wantLen2;
        state.velocity.x *= Math.max(0, Math.min(1, along));
        state.velocity.z *= Math.max(0, Math.min(1, along));
      }
    }
  }
  state.position.x = resolvedX;
  state.position.z = resolvedZ;
  state.position.y += state.velocity.y * dt;

  // --- Ground
  const ground = groundHeightAt(
    state.position.x,
    state.position.z,
    state.position.y - EYE_HEIGHT,
  );
  const floorY = ground + EYE_HEIGHT;
  if (state.position.y <= floorY) {
    state.position.y = floorY;
    state.velocity.y = 0;
    state.onGround = true;
  } else if (state.velocity.y < 0 && state.position.y - floorY < 0.02) {
    state.onGround = true;
  } else {
    state.onGround = false;
  }
}

/** Camera orientation for a state. Yaw then pitch, in that order. */
export function applyToCamera(state: PlayerState, camera: { position: Vector3; rotation: Euler }): void {
  camera.position.copy(state.position);
  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
}

/**
 * Self-check for the movement basis.
 *
 * The previous build shipped with W always moving north regardless of where the
 * camera pointed. It is a silent, high-cost bug, so it gets an explicit test:
 * pressing forward at a given yaw must move the player in the direction the
 * camera is actually facing, and pitch must not affect it at all.
 */
export function verifyMovementBasis(): string[] {
  const failures: string[] = [];
  const cases: Array<[number, string, [number, number]]> = [
    [0, 'yaw 0 (facing north, -Z)', [0, -1]],
    [Math.PI / 2, 'yaw 90 (facing west, -X)', [-1, 0]],
    [Math.PI, 'yaw 180 (facing south, +Z)', [0, 1]],
    [-Math.PI / 2, 'yaw -90 (facing east, +X)', [1, 0]],
  ];

  for (const [yaw, label, [ex, ez]] of cases) {
    for (const pitch of [0, 0.9, -0.9]) {
      const s = createPlayerState(0, 0);
      const input: InputSnapshot = {
        forward: 1,
        right: 0,
        jump: false,
        sprint: false,
        yaw,
        pitch,
      };
      // A few steps so acceleration has produced measurable movement.
      for (let i = 0; i < 12; i++) step(s, input, 1 / 60, null, () => 0);

      const dx = s.position.x;
      const dz = s.position.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) {
        failures.push(`${label}: forward produced almost no movement (${len.toFixed(3)} m).`);
        continue;
      }
      const dotExpected = (dx / len) * ex + (dz / len) * ez;
      if (dotExpected < 0.98) {
        failures.push(
          `${label}, pitch ${pitch.toFixed(1)}: moved (${dx.toFixed(2)}, ${dz.toFixed(2)}), ` +
            `expected direction (${ex}, ${ez}). Movement basis is wrong.`,
        );
      }
    }
  }

  // Strafe must be perpendicular to forward, not parallel.
  const s = createPlayerState(0, 0);
  const input: InputSnapshot = { forward: 0, right: 1, jump: false, sprint: false, yaw: 0, pitch: 0 };
  for (let i = 0; i < 12; i++) step(s, input, 1 / 60, null, () => 0);
  if (Math.abs(s.position.z) > Math.abs(s.position.x) * 0.05) {
    failures.push(
      `Strafe at yaw 0 moved (${s.position.x.toFixed(2)}, ${s.position.z.toFixed(2)}); ` +
        `it should be purely along X.`,
    );
  }

  return failures;
}
