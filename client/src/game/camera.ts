/**
 * How far the camera sits behind the player, as **one number**.
 *
 * This file exists because the control it describes was, for one round, a
 * boolean. The wheel was bound to a two-state toggle -- scroll down for third
 * person, scroll up for first -- and the report that came back was *"cant zoom
 * out anymore by scrolling"*, which is exactly right: a toggle is not a zoom.
 * Every game with a chase camera puts a **continuous distance** on that wheel,
 * and a player who scrolls out and sees the view stop dead at 4 m reads it as
 * the feature having been taken away rather than as a design.
 *
 * So the preference is a distance in metres and nothing else:
 *
 *   - **0 is first person.** Not "a very short boom" -- zero, exactly, and the
 *     viewmodels are on. `isThirdPerson` is the only test anybody should make
 *     about which camera is live, and it is a threshold rather than `!== 0` so
 *     that a hand-edited storage value of 1e-9 cannot leave the game in a state
 *     where the body is drawn *and* a bat is welded to the eye.
 *   - **`CAMERA_MIN`..`CAMERA_MAX` is third person**, and nothing lands between
 *     0 and `CAMERA_MIN`. That gap is deliberate and is the reason `stepCameraDistance`
 *     exists rather than a bare `d += step`: a camera 1 m behind the head is
 *     inside the player's own shoulders with the near plane clipping their neck,
 *     so the ladder steps *over* that range in one notch in both directions.
 *
 * The numbers, and why these ones:
 *
 *   - `CAMERA_MIN` 3.2 m is where the old fixed chase sat (3.5 m), which is
 *     close enough to walk a footpath without the camera in the shop window
 *     behind you.
 *   - `CAMERA_MAX` 12.8 m, which is the honest end of the useful range **in
 *     this city**. Sydney's streets are 12-20 m building face to building face,
 *     so a boom longer than this does not buy a wider shot; it buys the inside
 *     of a terrace, and the occlusion pull-in then spends the whole session
 *     dragging the camera back in to somewhere near 5 m anyway. Fourteen was
 *     tried and is indistinguishable from this except on the harbour.
 *   - `CAMERA_STEP` 1.6 m, so the whole range is seven notches out of first
 *     person and seven back. A mouse notch is one step, which is the feel every
 *     other game has trained; the trackpad accumulates to the same step in
 *     `main.ts`.
 *   - `CAMERA_DEFAULT` 4.8 m is one notch past the minimum, and is what `V`
 *     gives somebody who has never touched the wheel. It is the distance the
 *     previous build's chase camera averaged, so a player who only ever presses
 *     `V` sees no change from the build before this one.
 *
 * `RIDE_MIN` is the one place the player's number is overridden: **third person
 * must always be available** (the user's words), and a bike is the one situation
 * where the reverse also holds -- a first-person bicycle is a floating camera
 * with no bicycle in it. So riding raises the floor to the near stop and never
 * lowers the ceiling: a rider who has asked for 9.6 m keeps 9.6 m, and a rider
 * in first person gets 3.2 m for the duration and their own choice back on
 * dismount. Nothing here ever *writes* the player's preference, which is the
 * property that makes "and their own choice back" true for free.
 *
 * Deliberately three.js-free and DOM-free -- the storage functions take the
 * store as an argument -- so `verifyCamera` runs anywhere, including the Bun
 * integration check, with a Map standing in for `localStorage`.
 */

/** Exactly first person. The viewmodels are on and the local body is off. */
export const CAMERA_FIRST_PERSON = 0;
/** The closest third person gets. See the header: the gap under it is skipped. */
export const CAMERA_MIN = 3.2;
/** The furthest. Seven notches past `CAMERA_MIN`, and the width of a city street. */
export const CAMERA_MAX = 12.8;
/** One wheel notch. `CAMERA_MIN + 6 * CAMERA_STEP === CAMERA_MAX`, exactly. */
export const CAMERA_STEP = 1.6;
/** What `V` gives somebody with no third-person distance yet. */
export const CAMERA_DEFAULT = 4.8;
/**
 * The floor while riding. See the header -- a floor, not a forced value.
 */
export const RIDE_MIN = CAMERA_MIN;
/**
 * Anything at or under this is first person.
 *
 * A threshold rather than `=== 0` because the value can arrive from
 * `localStorage`, where it is a string a user can edit, and because float
 * arithmetic on the ladder should never be trusted to land on a literal zero.
 * Well under `CAMERA_MIN`, so no reachable third-person distance can be mistaken
 * for first person.
 */
export const CAMERA_FIRST_PERSON_MAX = 0.05;

/** The `localStorage` key, beside `sydney.name` and `sydney.server`. */
export const CAMERA_STORAGE_KEY = 'sydney.camera';

/** What `loadCameraDistance` and `saveCameraDistance` need, and no more. */
export interface CameraStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Any number -- from storage, from a devtools poke, from arithmetic -- reduced
 * to a distance the rest of the game can use.
 *
 * The middle branch is the point: a value inside the dead zone is resolved to
 * **first person**, not to `CAMERA_MIN`, because the only ways to get one are a
 * hand-edited store and a constant that moved, and of the two answers the safe
 * one is the game's default camera.
 */
export function clampCameraDistance(metres: number): number {
  if (!Number.isFinite(metres) || metres < CAMERA_MIN) return CAMERA_FIRST_PERSON;
  return Math.min(CAMERA_MAX, metres);
}

/** Which camera a distance means. The only test anybody should make. */
export function isThirdPerson(metres: number): boolean {
  return metres > CAMERA_FIRST_PERSON_MAX;
}

/**
 * Move `steps` notches out (positive) or in (negative).
 *
 * Direction-aware across the dead zone, and that is what stops the boundary
 * flickering. A distance-only rule -- "under 1.6 m means first person" -- has to
 * pick a side for the midpoint, and a trackpad that lands a player on it toggles
 * the viewmodels every few pixels. Here the *gesture* decides: out of first
 * person always lands on `CAMERA_MIN`, and in from `CAMERA_MIN` always lands on
 * first person, so the ladder is a function of where you were and which way you
 * pushed and never of a rounding error.
 *
 * Looped rather than multiplied because the dead zone is not a multiple of the
 * step: two notches out from first person is `CAMERA_MIN + CAMERA_STEP`, which
 * `0 + 2 * CAMERA_STEP` is not.
 */
export function stepCameraDistance(current: number, steps: number): number {
  let d = clampCameraDistance(current);
  const n = Math.min(Math.abs(Math.trunc(steps)), 64);
  for (let i = 0; i < n; i++) {
    if (steps > 0) {
      d = isThirdPerson(d) ? Math.min(CAMERA_MAX, d + CAMERA_STEP) : CAMERA_MIN;
    } else {
      d = d <= CAMERA_MIN + 1e-6 ? CAMERA_FIRST_PERSON : Math.max(CAMERA_MIN, d - CAMERA_STEP);
    }
    // Quantised to the micrometre after every notch, because 3.2 + 1.6 is not
    // 4.8 in binary and six notches of that drift is enough that the top of the
    // ladder needs an eighth notch to reach a `CAMERA_MAX` it is 2e-15 short of.
    // It also keeps what goes into `localStorage` readable.
    d = Math.round(d * 1e6) / 1e6;
  }
  return d;
}

/**
 * `V`: first person and back to the distance you last used.
 *
 * `remembered` is what the player last had in third person; `CAMERA_DEFAULT`
 * covers the session where they have never been there. Falling back to
 * `CAMERA_MIN` instead would make `V` and one wheel notch the same control,
 * which wastes the key.
 */
export function toggleCameraDistance(current: number, remembered: number): number {
  if (isThirdPerson(current)) return CAMERA_FIRST_PERSON;
  const back = clampCameraDistance(remembered);
  return isThirdPerson(back) ? back : CAMERA_DEFAULT;
}

/**
 * The distance actually used this frame: the player's, with the ride floor.
 *
 * Pure, and called every frame rather than on the mount event, for the reason
 * every other derived line in this project is: a rider can stop being a rider
 * for reasons no event fires for -- knocked out, respawned, the bike claimed by
 * somebody else -- and one `Math.max` a frame cannot go stale.
 */
export function liveCameraDistance(chosen: number, riding: boolean, underground = false): number {
  const d = clampCameraDistance(chosen);
  // Below grade -- in a station box under the street -- the camera is first
  // person whatever was chosen. A third-person camera in a 32 m wide cavity
  // is a camera inside the tunnel wall, looking at the back of the city
  // through it; the owner: "when underground it should be first person".
  if (underground) return 0;
  return riding ? Math.max(d, RIDE_MIN) : d;
}

/**
 * The preference from last session.
 *
 * Wrapped, because `localStorage` **throws** rather than degrades in a browser
 * with storage disabled or in a partitioned third-party context, and a camera
 * preference is not worth a boot failure. The failure mode of the catch is a
 * first-person boot, which is the game's default.
 */
export function loadCameraDistance(store?: CameraStore): number {
  try {
    const s = store ?? (localStorage as CameraStore);
    return clampCameraDistance(Number.parseFloat(s.getItem(CAMERA_STORAGE_KEY) ?? ''));
  } catch {
    return CAMERA_FIRST_PERSON;
  }
}

/** And on the way out. See above for the wrapping. */
export function saveCameraDistance(metres: number, store?: CameraStore): void {
  try {
    const s = store ?? (localStorage as CameraStore);
    s.setItem(CAMERA_STORAGE_KEY, String(clampCameraDistance(metres)));
  } catch {
    // Not being remembered is not a failure worth reporting.
  }
}

// --- The occlusion march ------------------------------------------------------

/**
 * The radius of the sphere marched out for occlusion, and how far apart the
 * probes are.
 *
 * `CHASE_RADIUS` is a shade over the camera's own 0.1 m near plane, so a wall
 * the sphere clears is a wall the frustum clears.
 *
 * `CHASE_PROBE` is a **length**, and that is the whole reason this function
 * exists rather than a loop in the caller. The version before the zoom cut the
 * boom into a fixed eight steps, which at the old fixed 4.5 m was 56 cm a step
 * -- just under the sphere's own diameter, so nothing thinner than a step could
 * be tunnelled through. Eight steps of a 12.8 m boom is 1.6 m a step: every
 * garden wall in Surry Hills is thinner than that and the camera would march
 * straight through them into somebody's lounge room. A fixed 45 cm keeps the
 * sphere overlapping itself at every distance the zoom can ask for, and costs
 * probes rather than correctness when the boom is long -- 29 at the far end,
 * once a frame.
 *
 * `CHASE_REFINE` then bisects the gap between the last clear probe and the first
 * blocked one. Two halvings take the quantisation from 45 cm to about 11 cm,
 * which is under the sphere's own radius: the difference between a camera that
 * steps in visible jerks as the player slides along a terrace and one that
 * slides with them.
 */
export const CHASE_RADIUS = 0.28;
export const CHASE_PROBE = 0.45;
export const CHASE_REFINE = 2;

/**
 * How far back the boom can actually reach, given what is in the way.
 *
 * `blocked(d)` answers "would a sphere of `CHASE_RADIUS` at `d` metres back be
 * inside something" -- geometry, ground, whatever the caller decides. `near` is
 * the closest the camera may be driven; inside that the player's own body fills
 * the frame, and snapping to first person on a wall would be a jump cut, so it
 * stops instead.
 *
 * The returned distance is always one the caller **probed and found clear**,
 * less a 5 cm margin. No amount of refining can return a distance that was only
 * interpolated, which is the property that keeps the camera out of the wall.
 */
export function marchCameraBoom(want: number, near: number, blocked: (d: number) => boolean): number {
  const probes = Math.max(2, Math.ceil(want / CHASE_PROBE));
  for (let s = 1; s <= probes; s++) {
    const d = (want * s) / probes;
    if (!blocked(d)) continue;
    let lo = (want * (s - 1)) / probes;
    let hi = d;
    for (let i = 0; i < CHASE_REFINE; i++) {
      const mid = (lo + hi) * 0.5;
      if (blocked(mid)) hi = mid;
      else lo = mid;
    }
    return Math.max(near, lo - 0.05);
  }
  return want;
}

// --- The self-check -----------------------------------------------------------

/**
 * What this catches that a typecheck cannot. Every failure below renders, none
 * throws, and every one of them reads as somebody's taste rather than as a bug.
 *
 *   - **A ladder that cannot get back to first person.** The reported bug in
 *     its next form: a clamp that floors the distance at `CAMERA_MIN` leaves a
 *     player permanently in third person with no way out but `V`.
 *   - **A ladder that cannot reach the far end**, which is the reported bug
 *     itself -- scrolling out that stops early.
 *   - **A dead zone somebody can land in.** A camera at 1.4 m is inside the
 *     player's own shoulders, and it looks like a clipping bug in the character
 *     model rather than like a camera that was allowed somewhere it should not be.
 *   - **A ride that takes third person away**, or worse, a ride that *writes*
 *     the preference and hands back a camera the player never asked for.
 *   - **A round trip through storage that is not the identity**, which presents
 *     as a camera that quietly resets every reload.
 */
export function verifyCamera(): string[] {
  const failures: string[] = [];
  if (liveCameraDistance(8, false, true) !== 0 || liveCameraDistance(8, true, true) !== 0) failures.push('underground, the camera is not first person.');
  if (liveCameraDistance(8, false, false) === 0) failures.push('above ground, a chosen third person went first person.');

  // --- The constants agree with each other. `CAMERA_MAX` has to be a whole
  // number of notches past `CAMERA_MIN` or the last step out is a stub and the
  // ladder is not symmetric with the way back in.
  const notches = (CAMERA_MAX - CAMERA_MIN) / CAMERA_STEP;
  if (Math.abs(notches - Math.round(notches)) > 1e-9) {
    failures.push(
      `CAMERA_MIN..CAMERA_MAX is ${notches.toFixed(2)} notches of CAMERA_STEP; it must be a whole ` +
        'number or the last step out is shorter than every other one.',
    );
  }
  if (!(CAMERA_DEFAULT >= CAMERA_MIN && CAMERA_DEFAULT <= CAMERA_MAX)) {
    failures.push(`CAMERA_DEFAULT ${CAMERA_DEFAULT} is outside the range V would put the camera in.`);
  }
  if (!(CAMERA_FIRST_PERSON_MAX > 0 && CAMERA_FIRST_PERSON_MAX < CAMERA_MIN)) {
    failures.push(
      `The first-person threshold ${CAMERA_FIRST_PERSON_MAX} does not sit between zero and CAMERA_MIN, ` +
        'so a real third-person distance can be mistaken for first person or the reverse.',
    );
  }

  // --- Out of first person and back, one notch at a time, and every stop is a
  // camera somebody could actually use.
  {
    let d = CAMERA_FIRST_PERSON;
    if (isThirdPerson(d)) failures.push('Zero is not first person; the viewmodels would never come back.');
    const stops: number[] = [];
    for (let i = 0; i < 40; i++) {
      d = stepCameraDistance(d, 1);
      stops.push(d);
      if (d >= CAMERA_MAX - 1e-9) break;
    }
    if (Math.abs(d - CAMERA_MAX) > 1e-9) {
      failures.push(
        `Forty notches out reached ${d.toFixed(2)} m, not CAMERA_MAX ${CAMERA_MAX}. This is the reported ` +
          'bug: the wheel stops zooming out before the far end.',
      );
    }
    if (stops.length !== Math.round(notches) + 1) {
      failures.push(
        `First person to the far end took ${stops.length} notches; the ladder says ${Math.round(notches) + 1}.`,
      );
    }
    if (Math.abs(stops[0] - CAMERA_MIN) > 1e-9) {
      failures.push(
        `One notch out of first person landed at ${stops[0]} m rather than CAMERA_MIN ${CAMERA_MIN}; ` +
          'the dead zone under the near stop has to be crossed in one move.',
      );
    }
    for (const stop of stops) {
      if (!isThirdPerson(stop)) failures.push(`A stop at ${stop} m does not read as third person.`);
      if (stop < CAMERA_MIN - 1e-9 || stop > CAMERA_MAX + 1e-9) {
        failures.push(`A stop at ${stop} m is outside ${CAMERA_MIN}..${CAMERA_MAX}.`);
      }
    }

    // And back in, which must end at first person rather than at the near stop.
    for (let i = 0; i < 40 && isThirdPerson(d); i++) d = stepCameraDistance(d, -1);
    if (isThirdPerson(d)) {
      failures.push(
        `Forty notches in left the camera at ${d.toFixed(2)} m. Scrolling all the way in has to reach ` +
          'first person, or V is the only way back and most players never find it.',
      );
    }
    // The exact boundary, both ways, since it is the one the trackpad sits on.
    if (stepCameraDistance(CAMERA_MIN, -1) !== CAMERA_FIRST_PERSON) {
      failures.push('One notch in from the near stop did not reach first person.');
    }
    if (Math.abs(stepCameraDistance(CAMERA_FIRST_PERSON, 1) - CAMERA_MIN) > 1e-9) {
      failures.push('One notch out of first person did not reach the near stop.');
    }
    // A multi-notch flick is the same as the notches taken one at a time, which
    // is what makes a fast mouse scroll and a slow one land in the same place.
    let one = CAMERA_FIRST_PERSON;
    for (let i = 0; i < 3; i++) one = stepCameraDistance(one, 1);
    if (Math.abs(stepCameraDistance(CAMERA_FIRST_PERSON, 3) - one) > 1e-9) {
      failures.push('Three notches in one event is not three separate notches; a fast scroll would go further.');
    }
    // Both ends are stable under further pushing, or a player who keeps
    // scrolling banks up distance they then have to unwind.
    if (stepCameraDistance(CAMERA_MAX, 1) !== CAMERA_MAX) failures.push('Scrolling out past the far end moved the camera.');
    if (stepCameraDistance(CAMERA_FIRST_PERSON, -1) !== CAMERA_FIRST_PERSON) {
      failures.push('Scrolling in past first person moved the camera.');
    }
  }

  // --- Nothing lands in the dead zone, from any starting point -- including the
  // ones no control can produce, because storage and a devtools poke can.
  {
    const landings: string[] = [];
    for (let i = 0; i * 0.1 <= CAMERA_MAX + 2; i++) {
      const start = i * 0.1;
      for (const dir of [-1, 1]) {
        const out = stepCameraDistance(start, dir);
        if (out > CAMERA_FIRST_PERSON_MAX && out < CAMERA_MIN - 1e-9) {
          landings.push(`${start.toFixed(1)} ${dir > 0 ? 'out' : 'in'} -> ${out.toFixed(2)}`);
        }
      }
    }
    if (landings.length) {
      failures.push(
        `${landings.length} steps landed between first person and the near stop, which is inside the ` +
          `player's own shoulders: ${landings.slice(0, 4).join(', ')}.`,
      );
    }
  }

  // --- V, and the distance it remembers.
  {
    if (isThirdPerson(toggleCameraDistance(6.4, 6.4))) failures.push('V from third person did not return to first person.');
    if (Math.abs(toggleCameraDistance(CAMERA_FIRST_PERSON, 9.6) - 9.6) > 1e-9) {
      failures.push('V did not go back to the distance the player last used.');
    }
    if (Math.abs(toggleCameraDistance(CAMERA_FIRST_PERSON, 0) - CAMERA_DEFAULT) > 1e-9) {
      failures.push('V with nothing remembered did not use CAMERA_DEFAULT.');
    }
    if (Math.abs(toggleCameraDistance(CAMERA_FIRST_PERSON, 999) - CAMERA_MAX) > 1e-9) {
      failures.push('V trusted a remembered distance past the far end rather than clamping it.');
    }
  }

  // --- The ride floor: it raises, it never lowers, and it never writes.
  {
    if (!isThirdPerson(liveCameraDistance(CAMERA_FIRST_PERSON, true))) {
      failures.push('A rider in first person got a first-person camera, so the bike is invisible under them.');
    }
    if (Math.abs(liveCameraDistance(CAMERA_FIRST_PERSON, true) - RIDE_MIN) > 1e-9) {
      failures.push(`A rider's floor was ${liveCameraDistance(CAMERA_FIRST_PERSON, true)} m, not RIDE_MIN ${RIDE_MIN}.`);
    }
    if (Math.abs(liveCameraDistance(CAMERA_MAX, true) - CAMERA_MAX) > 1e-9) {
      failures.push('Getting on a bike pulled a long boom back in; the floor must not be a ceiling.');
    }
    // The property the whole "you get your camera back" claim rests on.
    const chosen = CAMERA_FIRST_PERSON;
    liveCameraDistance(chosen, true);
    if (liveCameraDistance(chosen, false) !== CAMERA_FIRST_PERSON) {
      failures.push('Riding changed the stored preference, so dismounting left a camera nobody asked for.');
    }
    // And the wheel still moves while riding -- the floor is applied downstream
    // of the preference, so a rider scrolling out is not scrolling against a wall.
    if (!(stepCameraDistance(RIDE_MIN, 1) > RIDE_MIN)) {
      failures.push('A rider at the floor could not scroll further out.');
    }
  }

  // --- The occlusion march, against walls this file makes up.
  //
  // Three properties, and all three of them became load-bearing the day the boom
  // stopped being 4.5 m long.
  {
    const near = 0.9;
    // 1. A wall is never marched through. The blocked interval here is the
    // narrowest the real world can present -- a sphere of `CHASE_RADIUS` against
    // an infinitely thin wall is blocked over `2 * CHASE_RADIUS`, which is 56 cm
    // against a 45 cm probe. Swept over every wall distance in millimetres,
    // because tunnelling is a *sampling* failure and it hides between samples.
    let through = 0;
    let worstGap = 0;
    let last = -1;
    for (let mm = 500; mm <= 13000; mm += 1) {
      const wall = mm / 1000;
      const blocked = (d: number): boolean => Math.abs(d - wall) <= CHASE_RADIUS;
      const reach = marchCameraBoom(CAMERA_MAX, near, blocked);
      if (reach > wall - CHASE_RADIUS + 1e-9 && reach > near) through++;
      if (wall - CHASE_RADIUS > near) worstGap = Math.max(worstGap, wall - CHASE_RADIUS - reach);
      // 2. It does not jitter. A wall a millimetre further away may not move the
      // camera by more than the refinement's own resolution -- a boom that hops
      // is a camera that stutters as the player slides along a terrace, which is
      // the thing this looks fine while doing.
      if (last >= 0 && Math.abs(reach - last) > CHASE_PROBE / 2 ** CHASE_REFINE + 0.01) {
        failures.push(
          `A wall 1 mm further out moved the boom from ${last.toFixed(3)} to ${reach.toFixed(3)} m. ` +
            'That is a hop, and sliding along a wall would show it as a stutter.',
        );
        last = -1;
        break;
      }
      last = reach;
    }
    if (through) {
      failures.push(
        `The march went through a wall at ${through} of the distances swept. The probe length has to ` +
          `stay under the ${(2 * CHASE_RADIUS).toFixed(2)} m a sphere of CHASE_RADIUS is blocked over.`,
      );
    }
    if (worstGap > CHASE_PROBE / 2 ** CHASE_REFINE + 0.06) {
      failures.push(
        `The camera stopped ${worstGap.toFixed(2)} m short of the nearest wall it could have used. ` +
          'That is the refinement not refining, and it reads as a camera that will not go where it is asked.',
      );
    }
    // 3. Nothing in the way is nothing done, at every distance the zoom offers.
    for (let d = CAMERA_MIN; d <= CAMERA_MAX + 1e-9; d = stepCameraDistance(d, 1)) {
      if (marchCameraBoom(d, near, () => false) !== d) {
        failures.push(`An unobstructed boom of ${d} m did not reach ${d} m.`);
      }
      if (d >= CAMERA_MAX - 1e-9) break;
    }
    // And a wall the player is standing against drives it to the floor rather
    // than to zero -- snapping to first person on a wall is a jump cut.
    if (marchCameraBoom(CAMERA_MAX, near, () => true) !== near) {
      failures.push('A camera with nowhere to go did not stop at the near floor.');
    }
  }

  // --- Storage, round-tripped through a store that is not a browser's.
  {
    const map = new Map<string, string>();
    const store: CameraStore = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    };
    if (loadCameraDistance(store) !== CAMERA_FIRST_PERSON) {
      failures.push('A first session did not boot in first person.');
    }
    for (let d = CAMERA_FIRST_PERSON; d <= CAMERA_MAX + 1e-9; d = stepCameraDistance(d, 1)) {
      saveCameraDistance(d, store);
      if (Math.abs(loadCameraDistance(store) - d) > 1e-9) {
        failures.push(`A camera distance of ${d} m came back from storage as ${loadCameraDistance(store)}.`);
      }
      if (d >= CAMERA_MAX - 1e-9) break;
    }
    // What a devtools poke, a stale key from an older build, or a truncated
    // write leaves behind. None of these may produce a camera in the dead zone.
    for (const junk of ['', 'third', 'NaN', '-4', '1.4', '1e9', 'Infinity']) {
      map.set(CAMERA_STORAGE_KEY, junk);
      const got = loadCameraDistance(store);
      if (got !== CAMERA_FIRST_PERSON && (got < CAMERA_MIN || got > CAMERA_MAX)) {
        failures.push(`The stored value ${JSON.stringify(junk)} loaded as ${got} m.`);
      }
    }
  }

  return failures;
}
