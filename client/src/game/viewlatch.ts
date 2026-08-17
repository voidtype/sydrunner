/**
 * Nothing appears or disappears while you are looking at it.
 *
 * The owner's report was one clause of one sentence: *"car spawing and de
 * spawning should always happen off camera"*. The residency round had already
 * bought the hard half of that -- `game/traffic.ts`' five stages mean a car is
 * always **stationary in a kerb bay** on the first and last tick of its life,
 * never mid-lane at 50 km/h, and `verifyTraffic`'s "endpoints" section asserts it
 * to the centimetre. What is left is that a car standing up in a bay eight metres
 * in front of you is still a car standing up in a bay eight metres in front of
 * you, and no amount of parking it makes that not an event.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CLIENT RULE AND CANNOT BE ANYTHING ELSE.
 *
 * "In view" is per player. Sixteen people are looking at the same street from
 * sixteen places, and the whole design of the ambient fleet is that a car's
 * existence is a pure function of the clock that every process agrees on with
 * nothing on the wire (`game/traffic.ts`' header). A rule that changed *whether
 * a car exists* according to where somebody's camera is pointing would be a rule
 * that made the fleet per player, which is the one thing that arrangement cannot
 * survive.
 *
 * So this file changes only whether a car is **drawn**. The server is untouched:
 * it evaluates existence and runs the knockdown off the schedule, exactly as
 * before. Two consequences, both accepted deliberately:
 *
 *   - **A latched-invisible car can knock you over.** A car whose bay window has
 *     just opened inside your view is not drawn, and the server does not know
 *     that. It is also *at rest in a bay* -- `carHitStrength` scales the knockback
 *     with the car's own speed and returns zero below `CAR_HIT_MIN_SPEED`, so a
 *     stationary car does nothing at all to anybody standing next to it. The
 *     failure is therefore a car you cannot see failing to hurt you, which is
 *     not a failure. The window is at most the couple of seconds it takes you to
 *     look away, and `LATCH_MAX_S` bounds it absolutely.
 *   - **A ghost is not a car.** A car whose window has *closed* while you were
 *     looking at it goes on being drawn at its last pose until you look away.
 *     The server thinks it is gone, so walking through one does nothing. It is
 *     parked, so nobody walks through it on purpose; and it is one car at a kerb
 *     for a second or two rather than a car vanishing out of a photograph.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS IN `game/` WHEN NOTHING IN `game/` DRAWS ANYTHING.
 *
 * Because `verifyViewLatch` has to run in Bun. Every rendering decision in this
 * project that could not be tested headless has been wrong at some point -- the
 * near-field swap, the paint buffer, the pull-out that dragged a kerb offset
 * round a corner -- and this one is a state machine with four transitions and a
 * bounded table, which is exactly the kind of thing a scripted camera can prove
 * and a screenshot cannot. So it imports nothing from three, holds no three
 * types, and `world/cars.ts` is where it is *used*: `TrafficMovers.update` asks
 * `shows()` before it fills an instance and walks `forEachGhost` after. The same
 * split `staticCarIdentity` makes for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE IS SMALL BECAUSE IT ONLY WATCHES THE INTERESTING CARS.
 *
 * There are 500 cars in view in the CBD and this holds an entry for two kinds of
 * them: the ones being *hidden* (born in view, not yet drawn) and the ones about
 * to die in view (`endsIn` under `LATCH_WATCH_S`). Everything else is a lookup
 * that misses. `LATCH_MAX` caps it anyway, evicting the furthest first, because a
 * bounded table that is usually empty is the same argument `HoldLedger` and
 * `world/drivencars.ts`' speed map both make.
 */

import {
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  createCarPose,
  type CarPose,
} from './traffic.ts';

/**
 * How far away a (dis)appearance still has to be hidden, metres.
 *
 * The brief's 140. `cars.TRAFFIC_DRAW_RADIUS` is 420, so the outer two thirds of
 * the drawn fleet is not latched at all -- and that is right rather than a
 * shortcut: a car appearing 300 m away is four pixels, and a rule that latched it
 * would hold entries for the whole city to hide something nobody can resolve.
 */
export const VIEW_LATCH_M = 140;

/**
 * The half-angle of "you can see it", as a cosine.
 *
 * Deliberately **wider than the camera's own frustum**: the client's vertical
 * field of view is 70 degrees and its horizontal is about 100 on a 16:9 display,
 * so a 150-degree cone (cos -> 0.259 at 75 degrees off the axis) covers the
 * frustum with room for a fast flick of the mouse. Being generous costs a car
 * that appears just outside the frame staying hidden a moment longer, which
 * nobody can see; being tight costs a pop in the corner of the screen, which is
 * the entire bug. A plan cone rather than a real frustum test for the same
 * reason: the pitch of the camera does not change what a player notices about a
 * car at ground level, and a plan test needs no projection matrix -- which is
 * also what lets this file stay free of three.
 */
export const VIEW_LATCH_COS = 0.259;

/**
 * How new a car has to be to count as having just appeared, seconds.
 *
 * `CarPose.bornAgo` is exact, so this only has to be longer than one frame at
 * the worst frame rate this client tolerates -- 100 ms at 10 fps -- and shorter
 * than the time it takes a player to walk somewhere the car would legitimately
 * come into range from. A third of a second is twenty frames at 60 Hz.
 *
 * It has to exist at all because a car that *drives into the latch radius* must
 * be drawn immediately, and nothing about its position distinguishes it from one
 * that was created there. The schedule does, which is why `bornAgo` is computed
 * in `poseCar` rather than guessed here.
 */
export const LATCH_FRESH_S = 1 / 3;

/**
 * How close to the end of its life a car has to be before its pose is
 * remembered, seconds.
 *
 * The ghost needs a *last pose* to freeze, and a pose is only worth keeping for
 * a car that is about to stop existing. One second at 60 Hz is sixty frames of
 * warning, and it is the entire reason the table is small.
 */
export const LATCH_WATCH_S = 1;

/**
 * The absolute ceiling on either latch, seconds.
 *
 * A player who stands still and stares at one kerb bay would otherwise hold a
 * car invisible for the whole of its bay window -- minutes, on a quiet street
 * whose headway `density.trafficMultiplier` has stretched twentyfold -- or hold a
 * ghost forever. Ten seconds is long enough that the player has to be *trying*,
 * and the failure at the ceiling is the pop this file exists to remove, which is
 * the correct thing to degrade to: one pop after ten seconds of staring beats a
 * car that is permanently not there.
 */
export const LATCH_MAX_S = 10;

/** How many identities are watched at once. See the header. */
export const LATCH_MAX = 128;

/** What state one watched car is in. */
const STATE_WATCH = 0;
const STATE_HIDDEN = 1;
const STATE_GHOST = 2;
/**
 * Hidden once, released, and **not to be hidden again**.
 *
 * Without this state the release is not sticky: the entry is dropped when the
 * player looks away, the car is still younger than `LATCH_FRESH_S` when they look
 * back, and the first-sighting branch hides it a second time -- a car that
 * flickers as you turn your head, which is worse than the pop. The entry is kept
 * until the car is old enough that no branch could hide it, which is a third of a
 * second.
 */
const STATE_SHOWN = 3;

interface LatchEntry {
  identity: number;
  state: number;
  /** The tick this entry was created at, for `LATCH_MAX_S`. */
  since: number;
  /** The last tick this identity was offered to `shows`. */
  seen: number;
  /** The last pose it was seen at. A ghost is drawn from this. */
  pose: CarPose;
}

/**
 * Is this point inside the cone a player can see, and near enough to matter?
 *
 * Pure, and the whole geometric content of this file. `(camDx, camDz)` is the
 * camera's plan forward, not necessarily normalised -- it is compared against the
 * squared length of the offset, so a caller handing over an unnormalised
 * direction gets the same answer as long as it is consistent.
 */
export function inLatchView(
  px: number,
  pz: number,
  camX: number,
  camZ: number,
  camDx: number,
  camDz: number,
): boolean {
  const rx = px - camX;
  const rz = pz - camZ;
  const d2 = rx * rx + rz * rz;
  if (d2 > VIEW_LATCH_M * VIEW_LATCH_M) return false;
  // Standing on top of it. There is no direction to be in front of, and a car
  // that materialises inside the player is the worst case rather than an
  // exception to it.
  if (d2 < 1e-6) return true;
  const ahead = rx * camDx + rz * camDz;
  // Behind the camera: `ahead <= 0` is the brief's "has been behind the camera",
  // and it is tested on the plan so a player looking at their feet still counts
  // as looking at the street in front of them.
  if (ahead <= 0) return false;
  const len2 = camDx * camDx + camDz * camDz;
  // `ahead / (|r| * |cam|) >= cos`, squared to keep the root out of it. Both
  // sides are non-negative here because `ahead > 0`.
  return ahead * ahead >= VIEW_LATCH_COS * VIEW_LATCH_COS * d2 * len2;
}

/**
 * Should a car that has just come into existence be drawn this frame?
 *
 * The brief's `shouldDrawSpawn(pos, cam, frustum, age)`, with the frustum as the
 * cone above and the age as `CarPose.bornAgo`. False only for a car that is both
 * *new* and *in view*: everything else -- an old car that has driven into range,
 * a new car behind you, a new car 300 m away -- is drawn at once.
 */
export function shouldDrawSpawn(
  px: number,
  pz: number,
  camX: number,
  camZ: number,
  camDx: number,
  camDz: number,
  bornAgo: number,
): boolean {
  if (bornAgo >= LATCH_FRESH_S) return true;
  return !inLatchView(px, pz, camX, camZ, camDx, camDz);
}

/**
 * Must a car that has stopped existing go on being drawn?
 *
 * The brief's `ghostUntil(...)`: true while the place it died is still in view.
 * The same predicate as `shouldDrawSpawn`'s, read the other way round, which is
 * the point -- a car appears and disappears under one rule, so the pair cannot
 * drift into disagreeing about what "off camera" means.
 */
export function ghostUntil(
  px: number,
  pz: number,
  camX: number,
  camZ: number,
  camDx: number,
  camDz: number,
): boolean {
  return inLatchView(px, pz, camX, camZ, camDx, camDz);
}

/**
 * The per-client latch table: who is being hidden, and who is being kept.
 *
 * Driven by the one loop that already poses every car in view --
 * `cars.TrafficMovers.update` -- in three calls: `begin` with the camera,
 * `shows` per car (before the instance is filled), and `forEachGhost` after the
 * walk, which hands back the frozen poses that must still be drawn. Nothing else
 * in the client is allowed to hold one, because two latches would disagree about
 * which frame a car appeared on.
 */
export class ViewLatch {
  /** Cars hidden and cars ghosted on the last frame. The HUD's diagnostics line. */
  hidden = 0;
  ghosts = 0;

  private readonly entries = new Map<number, LatchEntry>();
  private camX = 0;
  private camZ = 0;
  private camDx = 0;
  private camDz = 1;
  private tick = 0;
  private frame = 0;

  /**
   * The camera, and the tick, for this frame.
   *
   * `tick` is the traffic clock (fractional is fine -- `TrafficMovers` draws
   * between ticks) and is used only for the two ceilings, so its absolute value
   * does not matter as long as it advances.
   */
  begin(tick: number, camX: number, camZ: number, camDx: number, camDz: number): void {
    this.tick = tick;
    this.camX = camX;
    this.camZ = camZ;
    this.camDx = camDx;
    this.camDz = camDz;
    this.frame++;
    this.hidden = 0;
    this.ghosts = 0;
  }

  /**
   * Should this car be drawn? Call once per live car, per frame.
   *
   * Also the point at which a pose is remembered, so a car that is about to stop
   * existing has something to be frozen at. Returns false only for a latched
   * spawn.
   */
  shows(pose: CarPose): boolean {
    const entry = this.entries.get(pose.identity);
    if (entry !== undefined) {
      entry.seen = this.frame;
      if (entry.state === STATE_SHOWN) {
        // Released already. Held only until it is too old to be hidden again.
        if (pose.bornAgo >= LATCH_FRESH_S) this.entries.delete(pose.identity);
        return true;
      }
      if (entry.state === STATE_HIDDEN) {
        // Released the moment the place it appeared in is out of view or behind
        // the camera -- the brief's condition exactly -- or at the ceiling.
        if (
          !inLatchView(pose.x, pose.z, this.camX, this.camZ, this.camDx, this.camDz) ||
          this.tick - entry.since > LATCH_MAX_S * 60
        ) {
          entry.state = STATE_SHOWN;
          if (pose.bornAgo >= LATCH_FRESH_S) this.entries.delete(pose.identity);
          return true;
        }
        this.hidden++;
        return false;
      }
      // A watched car: keep its pose fresh, and let it go once it is no longer
      // about to die (a schedule car that got a new lease -- which cannot happen
      // today, but a table that only ever grows is how it would be found out).
      if (pose.endsIn > LATCH_WATCH_S) {
        this.entries.delete(pose.identity);
        return true;
      }
      copyPose(pose, entry.pose);
      return true;
    }

    // First sighting. Two reasons to make an entry and one to make none.
    if (
      pose.bornAgo < LATCH_FRESH_S &&
      inLatchView(pose.x, pose.z, this.camX, this.camZ, this.camDx, this.camDz)
    ) {
      this.remember(pose, STATE_HIDDEN);
      this.hidden++;
      return false;
    }
    if (
      pose.endsIn <= LATCH_WATCH_S &&
      inLatchView(pose.x, pose.z, this.camX, this.camZ, this.camDx, this.camDz)
    ) {
      this.remember(pose, STATE_WATCH);
    }
    return true;
  }

  /**
   * The cars that have stopped existing in view, at the pose they stopped at.
   *
   * Called once after the ambient walk, with the *same* fill the walk used --
   * `TrafficMovers.update` passes its own closure -- so a ghost is drawn by the
   * same instanced set, in the same paint, at the same LOD as the car it was a
   * moment ago. A second draw path for ghosts is how you get a car that changes
   * colour as it dies.
   */
  forEachGhost(visit: (pose: CarPose) => void): void {
    for (const entry of this.entries.values()) {
      // Anything offered to `shows` this frame still exists; only the ones the
      // walk did not visit are candidates, and `end` is what promotes them.
      if (entry.state !== STATE_GHOST) continue;
      this.ghosts++;
      visit(entry.pose);
    }
  }

  /**
   * Close the frame: promote the cars that vanished, retire the ghosts that can
   * be retired.
   *
   * Split from `begin` rather than folded into it because the promotion has to
   * happen *after* the walk (that is what says a car was not visited) and the
   * ghost draw has to happen after the promotion. Three calls, in order, and
   * `verifyViewLatch` asserts what each one does.
   */
  end(): void {
    for (const [identity, entry] of this.entries) {
      if (entry.seen === this.frame) continue;
      if (entry.state === STATE_HIDDEN || entry.state === STATE_SHOWN) {
        // Hidden and gone: a car whose whole life happened inside the latch.
        // Nothing to ghost -- the player never saw it, which is the outcome this
        // rule wanted. Shown and gone: out of range, and nothing owed either.
        this.entries.delete(identity);
        continue;
      }
      if (entry.state === STATE_WATCH) {
        // The moment it stops being offered, it has stopped existing. Ghost it
        // if the place it died is in view, drop it otherwise.
        if (ghostUntil(entry.pose.x, entry.pose.z, this.camX, this.camZ, this.camDx, this.camDz)) {
          entry.state = STATE_GHOST;
          entry.since = this.tick;
        } else {
          this.entries.delete(identity);
        }
        continue;
      }
      // A ghost: keep it until the place it died leaves the view, or the ceiling.
      if (
        !ghostUntil(entry.pose.x, entry.pose.z, this.camX, this.camZ, this.camDx, this.camDz) ||
        this.tick - entry.since > LATCH_MAX_S * 60
      ) {
        this.entries.delete(identity);
      }
    }
  }

  /** How many identities are watched. Diagnostics, and the leak check. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.hidden = 0;
    this.ghosts = 0;
  }

  private remember(pose: CarPose, state: number): void {
    if (this.entries.size >= LATCH_MAX) this.evict();
    const entry: LatchEntry = {
      identity: pose.identity,
      state,
      since: this.tick,
      seen: this.frame,
      pose: createCarPose(),
    };
    copyPose(pose, entry.pose);
    this.entries.set(pose.identity, entry);
  }

  /**
   * Room for one more, taken from the furthest away.
   *
   * Distance rather than age, because the entry that matters least is the one the
   * player is least likely to be looking at -- and because a table full of stale
   * entries is impossible: `end` drops everything the walk stopped offering.
   */
  private evict(): void {
    let worst: number | null = null;
    let worstD2 = -1;
    for (const [identity, entry] of this.entries) {
      const rx = entry.pose.x - this.camX;
      const rz = entry.pose.z - this.camZ;
      const d2 = rx * rx + rz * rz;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = identity;
      }
    }
    if (worst !== null) this.entries.delete(worst);
  }
}

/** Every field of a pose, into another one. No allocation, no `Object.assign`. */
function copyPose(from: CarPose, to: CarPose): void {
  to.route = from.route;
  to.slot = from.slot;
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.dx = from.dx;
  to.dz = from.dz;
  to.body = from.body;
  to.colour = from.colour;
  to.scale = from.scale;
  to.halfLength = from.halfLength;
  to.halfWidth = from.halfWidth;
  to.height = from.height;
  to.stage = from.stage;
  to.routeT = from.routeT;
  // Frozen at rest, whatever it was doing: a ghost is a car that has stopped
  // existing, and the one thing it must not do is knock anybody over on the
  // client while the server knows nothing about it. `carHitStrength` reads this.
  to.speed = 0;
  to.identity = from.identity;
  to.damage = from.damage;
  to.held = from.held;
  to.swerve = from.swerve;
  to.bornAgo = from.bornAgo;
  to.endsIn = from.endsIn;
}

/**
 * The self-check. A scripted camera, and the four transitions.
 *
 *     bun -e "import {verifyViewLatch} from './client/src/game/viewlatch.ts';
 *             console.log(verifyViewLatch())"
 */
export function verifyViewLatch(): string[] {
  const failures: string[] = [];
  const fail = (why: string): void => {
    failures.push(why);
  };

  // --- 1. The cone, as pure geometry.
  {
    // Looking north (-z). A car 20 m north is in view; the same car 20 m south is
    // behind the camera; the same car 300 m north is out of range.
    if (!inLatchView(0, -20, 0, 0, 0, -1)) fail('a car 20 m up the street the camera faces is in view');
    if (inLatchView(0, 20, 0, 0, 0, -1)) fail('a car behind the camera is not in view');
    if (inLatchView(0, -300, 0, 0, 0, -1)) fail(`a car beyond ${VIEW_LATCH_M} m is not in view`);
    // Exactly abreast: 90 degrees off the axis is outside a 150-degree cone.
    if (inLatchView(20, 0, 0, 0, 0, -1)) fail('a car exactly abreast of the camera is outside the cone');
    // 60 degrees off the axis is inside it.
    if (!inLatchView(17.3, -10, 0, 0, 0, -1)) fail('a car 60 degrees off the axis is inside the cone');
    // An unnormalised camera direction gives the same answer as a normalised one.
    if (inLatchView(0, -20, 0, 0, 0, -1) !== inLatchView(0, -20, 0, 0, 0, -7)) {
      fail('the cone test does not care how long the camera direction vector is');
    }
  }

  // --- 2. `shouldDrawSpawn` and `ghostUntil` agree about what "off camera" is.
  {
    if (shouldDrawSpawn(0, -20, 0, 0, 0, -1, 0.01)) fail('a car born in view is not drawn');
    if (!shouldDrawSpawn(0, 20, 0, 0, 0, -1, 0.01)) fail('a car born behind the camera is drawn at once');
    if (!shouldDrawSpawn(0, -20, 0, 0, 0, -1, 30)) {
      fail('a car that has been alive for 30 s and drove into range is drawn at once');
    }
    if (!ghostUntil(0, -20, 0, 0, 0, -1)) fail('a car that died in view is ghosted');
    if (ghostUntil(0, 20, 0, 0, 0, -1)) fail('a car that died behind the camera is not ghosted');
  }

  // --- 3. The table, over a scripted camera.
  //
  // A fresh car 20 m up the street: hidden while the camera faces it, drawn on
  // the first frame the camera looks away, and drawn from then on even when the
  // camera looks back.
  {
    const latch = new ViewLatch();
    const pose = createCarPose();
    pose.identity = 0xabc;
    pose.x = 0;
    pose.z = -20;
    pose.stage = CAR_STAGE_PARKED_IN;
    pose.bornAgo = 0.01;
    pose.endsIn = 500;

    latch.begin(0, 0, 0, 0, -1);
    if (latch.shows(pose)) fail('a car that appears in front of the camera is not drawn');
    latch.end();
    if (latch.size !== 1) fail(`the latch remembers the one hidden car (size ${latch.size})`);

    // Still looking, a frame later. Still hidden.
    latch.begin(1, 0, 0, 0, -1);
    pose.bornAgo = 0.02;
    if (latch.shows(pose)) fail('and stays hidden while the camera stays on it');
    latch.end();

    // The player turns round.
    latch.begin(2, 0, 0, 0, 1);
    if (!latch.shows(pose)) fail('the moment it is behind the camera it starts being drawn');
    latch.end();
    // The entry stays, in `STATE_SHOWN`, precisely so that looking back cannot
    // hide it a second time -- see that constant.
    if (latch.size !== 1) fail(`the released car is remembered as shown (size ${latch.size})`);

    // And looking back does not hide it again.
    latch.begin(3, 0, 0, 0, -1);
    pose.bornAgo = 0.03;
    if (!latch.shows(pose)) fail('looking back at a released car does not hide it again');
    latch.end();

    // Once it is too old to be hidden by anything, the entry goes.
    latch.begin(4, 0, 0, 0, -1);
    pose.bornAgo = LATCH_FRESH_S + 1;
    if (!latch.shows(pose)) fail('an old car is drawn');
    latch.end();
    if (latch.size !== 0) fail(`and its entry is dropped once it is older than the latch (size ${latch.size})`);
  }

  // --- 4. The ceiling: staring at the spot does not hide a car forever.
  {
    const latch = new ViewLatch();
    const pose = createCarPose();
    pose.identity = 0xdef;
    pose.z = -20;
    pose.bornAgo = 0.01;
    pose.endsIn = 500;
    latch.begin(0, 0, 0, 0, -1);
    if (latch.shows(pose)) fail('the ceiling case starts hidden');
    latch.end();
    latch.begin(LATCH_MAX_S * 60 + 1, 0, 0, 0, -1);
    if (!latch.shows(pose)) fail(`a car is not hidden for longer than ${LATCH_MAX_S} s of staring`);
    latch.end();
  }

  // --- 5. A car that dies in view is ghosted at its last pose, and retired the
  // moment the player looks away.
  {
    const latch = new ViewLatch();
    const pose = createCarPose();
    pose.identity = 0x555;
    pose.x = 3;
    pose.z = -25;
    pose.y = 12;
    pose.body = 2;
    pose.colour = 4;
    pose.scale = 1.02;
    pose.stage = CAR_STAGE_PARKED_OUT;
    pose.bornAgo = 90;
    pose.endsIn = 0.5;
    pose.speed = 0;

    latch.begin(0, 0, 0, 0, -1);
    if (!latch.shows(pose)) fail('a car about to die is still drawn while it exists');
    latch.end();
    if (latch.size !== 1) fail(`its pose is remembered (size ${latch.size})`);

    // Next frame it no longer exists, so the walk never offers it.
    latch.begin(1, 0, 0, 0, -1);
    latch.end();
    let ghosts = 0;
    let gx = 0;
    let gz = 0;
    let gBody = -1;
    let gSpeed = -1;
    latch.forEachGhost((p) => {
      ghosts++;
      gx = p.x;
      gz = p.z;
      gBody = p.body;
      gSpeed = p.speed;
    });
    if (ghosts !== 1) fail(`a car that stopped existing in view is still drawn (${ghosts} ghosts)`);
    if (gx !== 3 || gz !== -25) fail(`the ghost is frozen at the pose it died at (${gx}, ${gz})`);
    if (gBody !== 2) fail(`and is the same car (body ${gBody})`);
    if (gSpeed !== 0) fail(`and is stationary, so it cannot knock anybody over (speed ${gSpeed})`);

    // The player turns away: the ghost is retired.
    latch.begin(2, 0, 0, 0, 1);
    latch.end();
    let after = 0;
    latch.forEachGhost(() => { after++; });
    if (after !== 0) fail(`the ghost is dropped once the spot is off camera (${after} left)`);
    if (latch.size !== 0) fail(`and the table is empty again (size ${latch.size})`);
  }

  // --- 6. A car that dies *behind* the camera is never ghosted at all.
  {
    const latch = new ViewLatch();
    const pose = createCarPose();
    pose.identity = 0x777;
    pose.z = 30;
    pose.bornAgo = 90;
    pose.endsIn = 0.5;
    latch.begin(0, 0, 0, 0, -1);
    if (!latch.shows(pose)) fail('a car behind the camera is drawn while it exists');
    latch.end();
    if (latch.size !== 0) fail('a car dying behind the camera is not even watched');
    latch.begin(1, 0, 0, 0, -1);
    latch.end();
    let ghosts = 0;
    latch.forEachGhost(() => { ghosts++; });
    if (ghosts !== 0) fail(`and is not ghosted (${ghosts})`);
  }

  // --- 7. The table is bounded, whatever a street throws at it.
  {
    const latch = new ViewLatch();
    const pose = createCarPose();
    latch.begin(0, 0, 0, 0, -1);
    for (let i = 0; i < LATCH_MAX * 4; i++) {
      pose.identity = 0x1000 + i;
      pose.x = (i % 17) - 8;
      pose.z = -10 - (i % 100);
      pose.bornAgo = 0.01;
      pose.endsIn = 500;
      latch.shows(pose);
    }
    if (latch.size > LATCH_MAX) fail(`the latch table is bounded at ${LATCH_MAX} (held ${latch.size})`);
    latch.clear();
    if (latch.size !== 0) fail('and clears');
  }

  return failures;
}
