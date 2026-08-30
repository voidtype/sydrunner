/*
 * suspension.ts -- the chassis is carried, not dragged.
 *
 * A driven car's rendered height is the driver's simulated height, taken raw:
 * `world/drivencars.ts` writes `out.y = d.y` once a frame. That is correct and
 * it is also why the car reads as a brick. The ground under it is a polygonal
 * approximation of Sydney -- kerbs, tile seams, a terrain mesh quantised to the
 * metre -- and every one of those edges arrives at the body as a step. The
 * owner asked for
 *
 *     "vehicles largely compliant to surfaces, as if they have amazing
 *      suspension or almost as if the suspension is too good to be true"
 *
 * and was explicit about why: it is there to hide the roughness of the surface
 * rather than to model a spring. So this is deliberately over-damped. A real
 * car's suspension is tuned to keep the tyre on the road; this one is tuned to
 * keep the *body* off the geometry, which is the opposite job.
 *
 * **Cosmetic, and that word is load-bearing.** It moves what is drawn and
 * nothing else. The simulated position, the collision probe, the wire and
 * `net/client.reconcile`'s replay all keep the raw height, because a filter in
 * front of any of those is a second opinion about where a car is -- and two
 * opinions about a position is the whole family of bugs `game/driving.ts`'s
 * `DriveState` comment exists to avoid. Nothing here may be read by the
 * authority.
 *
 * **Why there is a travel limit at all.** A first-order ease with no bound
 * rubber-bands: drive off the Gladesville Bridge and the body floats down after
 * the car, which is the "too good to be true" note taken past the joke and into
 * a bug. Real suspension has a bump stop, and past it the chassis is carried by
 * the axle. So beyond `TRAVEL_M` the filter stops easing and simply holds that
 * distance -- the body keeps its offset and falls at the car's own rate, which
 * is what a car on its bump stops actually does.
 */

/**
 * How long the body takes to give up most of a bump, seconds.
 *
 * Longer than a real damper by a good margin, which is the request. At 0.18 s a
 * kerb-height step is two thirds gone in a fifth of a second and invisible
 * inside a third, while a slope the car is genuinely climbing is tracked with a
 * lag nobody can see because the whole car is moving with it.
 */
export const SUSPENSION_TAU = 0.18;

/**
 * The bump stop, metres.
 *
 * Roughly a wheel's worth of travel. Small enough that a real drop is a drop
 * rather than a descent, large enough to swallow every kerb, seam and terrain
 * facet in the world -- which, measured against `world/road-deck.ts`'s grades,
 * is the whole of what this is for.
 */
export const SUSPENSION_TRAVEL_M = 0.8;

/**
 * One frame of suspension travel.
 *
 * `current` is where the body was drawn last frame and `target` is where the
 * car actually is. Returns where to draw it now.
 *
 * A clamped linear approach rather than `Math.exp`: it converges, it costs a
 * divide, and it keeps this file free of the transcendentals the determinism
 * rule in CLAUDE.md is written about -- this is client-only and cosmetic, so
 * the rule does not bind it, but a filter that cannot be run on both ends is a
 * filter nobody can move later without re-deriving it.
 */
export function suspensionY(current: number, target: number, dt: number): number {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  const gap = target - current;
  // Past the bump stop the chassis is carried: hold the offset and fall with
  // the car, rather than floating down after it.
  if (gap > SUSPENSION_TRAVEL_M) return target - SUSPENSION_TRAVEL_M;
  if (gap < -SUSPENSION_TRAVEL_M) return target + SUSPENSION_TRAVEL_M;
  const step = !(dt > 0) ? 1 : Math.min(1, dt / SUSPENSION_TAU);
  return current + gap * step;
}

export function verifySuspension(): string[] {
  const failures: string[] = [];
  const frame = 1 / 60;

  // A first sighting has nothing to ease from and must not start at zero, which
  // would drop every car through the road on the frame it is first drawn.
  if (suspensionY(Number.NaN, 12.5, frame) !== 12.5) {
    failures.push('a car drawn for the first time did not start at its own height.');
  }

  // A kerb: gone inside a third of a second, and never overshooting.
  let y = 0;
  let overshoot = 0;
  for (let i = 0; i < 20; i++) {
    y = suspensionY(y, 0.15, frame);
    if (y > 0.15 + 1e-9) overshoot++;
  }
  if (overshoot > 0) failures.push(`the body overshot a 15 cm kerb ${overshoot} times; that is a bounce, not a damper.`);
  // 85% of the step, not all of it: at `SUSPENSION_TAU` a third of a second
  // leaves about a seventh, which is the lag that *is* the feature. The
  // assertion is that the body is most of the way there and still moving, not
  // that it has arrived -- a filter that arrives in a third of a second is a
  // filter the owner would call a brick again.
  const left = 0.15 - y;
  if (left > 0.15 * 0.2) {
    failures.push(`a 15 cm step was still ${(left * 100).toFixed(1)} cm out after a third of a second; too stiff to hide a kerb.`);
  }
  if (left <= 0) failures.push('a 15 cm step was fully absorbed in a third of a second; that is no suspension at all.');

  // Convergence, from either side. A filter that does not settle is a car that
  // never quite sits on the road.
  let up = 5;
  let down = -5;
  for (let i = 0; i < 600; i++) {
    up = suspensionY(up, 0, frame);
    down = suspensionY(down, 0, frame);
  }
  if (Math.abs(up) > 1e-6 || Math.abs(down) > 1e-6) {
    failures.push(`the filter did not settle: ${up} from above, ${down} from below.`);
  }

  // The bump stop. Drive off something tall and the body must fall *with* the
  // car at a fixed offset, not float down after it.
  const held = suspensionY(0, -40, frame);
  if (Math.abs(held - (-40 + SUSPENSION_TRAVEL_M)) > 1e-9) {
    failures.push(`a 40 m drop left the body at ${held}; past the bump stop the chassis is carried, not cushioned.`);
  }
  const lifted = suspensionY(0, 40, frame);
  if (Math.abs(lifted - (40 - SUSPENSION_TRAVEL_M)) > 1e-9) {
    failures.push(`a 40 m lift left the body at ${lifted}; the stop must hold in both directions.`);
  }

  // A frame delta of zero (a paused tab coming back) must not divide by it.
  // Inside the travel, so the bump stop is not what is being tested here.
  if (suspensionY(3, 3.5, 0) !== 3.5) {
    failures.push('a zero frame delta did not snap; a tab coming back would divide by it or hang the body.');
  }
  return failures;
}
