/**
 * The browser's half of the talent abilities: three keys, and one prediction.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT TWENTY LINES IN `main.ts`.
 *
 * `main.ts` is nine thousand lines and is edited by every workstream at once;
 * the standing instruction is that a workstream's changes there are one import
 * and one call, with the real logic in a module it owns. This is that module.
 * It is also the only client-side piece of this workstream that has any state,
 * so having it somewhere with a header is worth more than the two lines saved.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT DECIDES, WHICH IS ALMOST NOTHING.
 *
 * The three keys are sent as level bits (`protocol.BTN.ABILITY_V/G/T`) and
 * `server/sim.resolveAbilities` does every decision: which ability the key is,
 * whether the cooldown is up, whether the wallet can pay, who gets knocked down.
 * That is not caution, it is the same rule the whole game runs on -- `INPUT`
 * carries buttons and nothing a client could lie with.
 *
 * The **dash impulse** is the one exception and the reason is in
 * `game/abilities.ts`' header: it is the only ability that is a movement the
 * player is steering, and 80 ms of round trip on a 300 ms burst is the whole of
 * it. So the browser sets the same velocity the server is about to set, on the
 * same tick, and `net/client.reconcile` corrects any disagreement from the next
 * snapshot exactly as it corrects a mispredicted mount.
 *
 * The consequence, stated so it is not a surprise: a client that dashes into a
 * cooldown the server refuses gets 300 ms of movement the server did not grant
 * and is then snapped back. That is the same failure a mispredicted mount has,
 * it is self-correcting, and it is not exploitable -- the cooldown table here is
 * the same code with the same numbers, so the two only disagree when a packet
 * was lost.
 *
 * **Offline** (`?offline`) the browser *is* the authority, and the difference
 * shows up in exactly one place: `tryAbility` is called with `-1` for the wallet
 * (there is no wallet offline) and nothing consumes the abilities that need a
 * server -- no slam, no teleport, no tent. The dash and the burst work, which is
 * what makes `?offline` a real test of the feel.
 *
 * ---------------------------------------------------------------------------
 * `V` IS ALREADY THE CAMERA TOGGLE, and this file does not resolve that.
 *
 * `main.ts` has bound `V` to the third-person camera since long before talents
 * existed. The brief for this workstream assigns `V` to the dash. Both are
 * right and they cannot both have the key.
 *
 * What ships is: **the ability wins when the player has one**, and `V` is the
 * camera for everybody else -- which is every player below level 2, every guest,
 * and everybody who did not spend a point on Bolt or Merge Late. That keeps the
 * key doing what it has always done for almost everybody, and it is reversible
 * in one line. It is flagged for the owner rather than decided quietly, because
 * "my camera key stopped working when I took a talent" is exactly the kind of
 * thing that reads as a bug.
 */

import { EYE_HEIGHT } from '../player/controller.ts';
import type { CombatInput, CombatantState } from './combat.ts';
import {
  ABILITY,
  CAR_BURST_SLIDE_M,
  G_RESULT,
  abilityForV,
  dashSpeedFor,
  feedG,
  tryAbility,
  type Ability,
} from './abilities.ts';
import { FX } from './teams.ts';
import { fxNow, fxScalar } from './teamfx.ts';

/** The local player's id offline. `server/sim.allocateId` never hands out 0. */
export const LOCAL_ID = 0;

/** `V` last frame, for the rising edge. `main.ts`'s `mountHeld`, one key over. */
let vHeld = false;
/** `T` last frame, the same. */
let tHeld = false;

/** Reset the edge latches. For a fresh session and for the self-checks. */
export function resetTalentKeys(): void {
  vHeld = false;
  tHeld = false;
}

/**
 * Does this player have something on `V` other than the camera?
 *
 * The question `main.ts`'s key handler asks before toggling the boom. See the
 * header: the ability wins, and everybody without one keeps their camera.
 */
export function vIsAnAbility(playerId: number): boolean {
  return abilityForV(playerId) !== ABILITY.NONE;
}

/**
 * Read the three keys into the input, and predict the dash.
 *
 * Called once per fixed step from `main.ts`, immediately after the bike's `E`
 * and before `combat.advance` -- so an impulse set here is integrated by the
 * same step, through the same collision world, on the same tick the server
 * integrates its own copy.
 */
export function tickTalentKeys(
  c: CombatantState,
  input: CombatInput,
  keys: ReadonlySet<string>,
  /** The id the local player is known by. `net.selfId` online, `LOCAL_ID` off. */
  playerId: number = LOCAL_ID,
): void {
  const v = keys.has('KeyV');
  const g = keys.has('KeyG');
  const t = keys.has('KeyT');
  input.abilityV = v;
  input.abilityG = g;
  input.abilityT = t;

  const rising = v && !vHeld;
  vHeld = v;
  tHeld = t;
  if (!rising || c.phase === 'ko') return;

  // Only the dash and the on-foot slide are predicted. Everything else on `V`
  // -- the in-car burst window -- is a state the server owns and the client is
  // told about, so there is nothing to do here for it.
  const which = abilityForV(playerId);
  if (which === ABILITY.NONE) return;
  if (c.drivingCar !== 0) return;
  const metres = which === ABILITY.DASH ? fxScalar(playerId, FX.DASH) : CAR_BURST_SLIDE_M;
  if (!(metres > 0)) return;
  // The same cooldown table the server keeps, so the two agree unless a packet
  // was lost. `-1` for the wallet: neither of these two costs anything, and the
  // browser has no authoritative balance to check against anyway.
  const day = Math.floor(fxNow() / 3_600_000);
  if (tryAbility(playerId, which, fxNow(), day, -1) !== '') return;
  applyDash(c, input, metres);
}

/**
 * Set the dash impulse. Exported so `verifyTalentKeys` can measure it against
 * the real controller without going through a keyboard.
 *
 * The direction is the move input where there is one and the facing where there
 * is not, and the speed is `abilities.dashSpeedFor` -- see that function for why
 * `v^2 / (2 * FRICTION)` is the whole of the distance arithmetic. **Set rather
 * than added**, on `combat.applyHit`'s argument: a sprinting player who added
 * twenty metres a second would cover fourteen metres, and the distance would
 * stop being a thing anybody could learn.
 *
 * The vertical velocity is left exactly as it is, which is what makes the
 * tooltip's "works mid-air" true for free: a dash off a kerb keeps its fall.
 */
export function applyDash(c: CombatantState, input: CombatInput, metres: number): void {
  const speed = dashSpeedFor(metres);
  // `player/controller.step`'s yaw basis: forward is (-sin, -cos), right is
  // (cos, -sin). Restated rather than imported because that function builds it
  // from `input.yaw` inside its own body and exports nothing.
  const sinY = Math.sin(c.body.yaw);
  const cosY = Math.cos(c.body.yaw);
  let dx = -sinY * input.forward + cosY * input.right;
  let dz = -cosY * input.forward - sinY * input.right;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-4) {
    dx = -sinY;
    dz = -cosY;
  } else {
    dx /= len;
    dz /= len;
  }
  c.body.velocity.x = dx * speed;
  c.body.velocity.z = dz * speed;
}

/** Feet, for a caller that has an eye. `combat.feetY` without the import cycle. */
export function feetOf(c: CombatantState): number {
  return c.body.position.y - EYE_HEIGHT;
}

/** Which ability `V` resolved to for this player. For the HUD's cooldown pip. */
export function talentKeyV(playerId: number): Ability {
  return abilityForV(playerId);
}

/** The `G` reader, exposed so the HUD can show a hold filling. */
export function talentKeyG(playerId: number, down: boolean, nowMs: number): number {
  return feedG(playerId, down, nowMs);
}

/** `T` last frame. Read by nothing yet; here so the latch is not write-only. */
export function talentKeyTHeld(): boolean {
  return tHeld;
}

/** The three constants a caller comparing against `feedG`'s answer needs. */
export { G_RESULT };
