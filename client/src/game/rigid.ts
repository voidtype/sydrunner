/**
 * Two things that cannot be in the same place, and what happens when they try.
 *
 * The game's 2D rigid-body layer, three-free by rule so the Bun server runs this
 * exact file -- the split `game/driving.ts` makes against `world/drivencars.ts`
 * and `game/bikes.ts` makes against `world/bike.ts`. Nothing here imports three,
 * nothing here draws, and every number a body has after a contact is decided by
 * a function in this file running identically in the browser and on the server.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THERE IS ONE LAYER AND NOT ONE PER VEHICLE.
 *
 * The brief that produced this file was about cars: *"also i noticed no car to
 * car collision"*, *"i want car collision and physics"*. The scope was then
 * widened by one sentence -- *"maybe just revamp physics in general thru these
 * changes if it makes sense"* -- and it does make sense, for a reason that is
 * visible the moment you write the car version twice.
 *
 * A car hitting a car, a car hitting a bike and a bike hitting a car are the
 * same event seen from three sides. Written per vehicle they are three files
 * that must agree about the contact normal, about which of the pair is heavier,
 * about what a restitution of 0.2 means and about the sign of a spin -- and
 * three files that agree today are three files, because the first disagreement
 * is a shunt that pushes one way on the striker's screen and the other way on
 * the struck one's. `game/traffic.drivenCarPose` already made this argument for
 * the *hit box* ("the only way 'a car knocks you down' can mean one thing in
 * this game") and it is the same argument one level down: the only way "two
 * things bounced off each other" can mean one thing is for there to be one
 * function that decides it, with the vehicles as its callers rather than as its
 * subject.
 *
 * So this file knows nothing about cars. It knows about a **box with a mass**,
 * and cars are its first client (`game/driving.ts`), bikes its second
 * (`game/bikes.ts`), and boats are the third whenever #2 on the suggestion
 * board gets its water -- see section 6 for what that one would need and what
 * it would not.
 *
 * ---------------------------------------------------------------------------
 * 2. WHY IT IS 2D, AND WHY THAT IS NOT A COMPROMISE.
 *
 * Everything this layer is for lives on the ground. A car drives on a road, a
 * bike rides on a footpath, a boat floats on the harbour; none of the three
 * leaves its surface, none of them rolls onto its roof, and the one vertical
 * question anybody asks about them -- *is that car on the Cahill Expressway or
 * on Alfred Street underneath it* -- is already answered everywhere in this
 * project by one comparison against `driving.TAKE_HEIGHT`, which is cheaper and
 * more legible than a third axis would be.
 *
 * What is left after the height gate is genuinely two-dimensional: an oriented
 * rectangle, a plan velocity, a spin about the up axis, and a mass. A 3D solver
 * would carry a quaternion, an inertia tensor and two more contact axes to
 * describe a Camry that is always flat on the road, and every one of those is a
 * quantity two processes have to agree about to the bit. Rule 5 of DESIGN.md is
 * "determinism is the aesthetic", and the cheapest way to be deterministic
 * about a number is not to have it.
 *
 * ---------------------------------------------------------------------------
 * 3. WHY NO LIBRARY, WITH THE ARITHMETIC.
 *
 * The instruction allowed one -- *"use a lib if it makes sense"* -- and it does
 * not, for four reasons that are all about this codebase rather than about the
 * libraries:
 *
 *   - **The replay.** `net/client.reconcile` replays every un-acked input
 *     through the same integrator the server ran, three to five times per
 *     snapshot. A WASM rigid-body world is a *world*: to replay an input you
 *     must rewind the whole world to the acked state and re-step it, which is a
 *     full snapshot of every body three to five times a snapshot, twenty times
 *     a second. This layer is a handful of scalars per body and a pure
 *     function, so a replay costs what the arithmetic costs.
 *   - **The collision is already ours.** Sydney's world is 1.4 million baked
 *     prisms answered by `player/collision.CollisionWorld.resolve`, which is
 *     what a player, a car, a train passenger and a pedestrian are all moved
 *     through. A physics library brings its own broadphase and its own static
 *     geometry, so adopting one means either loading the city into it twice or
 *     keeping two opinions about what is solid. Neither is a trade for the one
 *     thing wanted here, which is *boxes that push each other*.
 *   - **Determinism across two runtimes.** The server is Bun and the client is
 *     whatever browser the player has. Two builds of a WASM solver stepping
 *     with different internal orderings is a divergence nobody can debug from
 *     inside the game; two calls to `Math.sqrt` are a divergence that cannot
 *     happen. Section 5 lists what is and is not allowed on this path.
 *   - **The size.** The whole of what is needed is the separating-axis test
 *     between two rectangles, one impulse and one torque -- about two hundred
 *     lines below, all of it readable. Rapier's WASM bundle is ~500 kB
 *     compressed against a first-load budget PERFORMANCE.md already spends on
 *     the world; that is a megabyte and a half of dependency for two hundred
 *     lines of it.
 *
 * If a body ever has to leave the ground -- a stunt jump that lands on its
 * roof, a boat that pitches in a swell -- this paragraph is the one to re-read,
 * because that is the change that would make the trade go the other way.
 *
 * ---------------------------------------------------------------------------
 * 4. THE SHAPE OF A CONTACT, AND WHAT A CALLER IS EXPECTED TO DO WITH IT.
 *
 * Three steps, deliberately separate calls rather than one `step()`:
 *
 *     rigidOverlap(a, b, contact)     // is there a contact, where, how deep
 *     rigidSeparate(a, b, contact)    // how far each has to move to stop overlapping
 *     rigidResolve(a, b, contact)     // and what that does to their velocities
 *
 * They are separate because the **separation is not this file's to apply**. A
 * car pushed sideways out of another car must not be pushed into a wall, and
 * the only thing in this project that knows where the walls are is
 * `CollisionWorld.resolve`. So `rigidSeparate` reports the two displacements and
 * the caller walks each body there through whatever resolver that body is moved
 * by -- the driver's own capsule for a car somebody is in, the loose-car
 * resolver for one nobody is. A caller with no world moves the bodies directly,
 * which is what `verifyRigid` does, and is the correct failure for a self-check
 * and for the first second of a session before anything has streamed.
 *
 * `rigidResolve` *does* write velocities, because a velocity is not a place and
 * nothing else has an opinion about it.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM: WHAT THIS FILE MAY AND MAY NOT DO.
 *
 * Everything on the contact path is `+ - * /`, `Math.min/max/abs` and
 * `Math.sqrt`. There is **no `Math.sin`, `cos`, `pow`, `hypot` or `atan2`**
 * anywhere in `rigidOverlap`, `rigidSeparate`, `rigidResolve` or
 * `rigidIntegrate`, which is `game/footy.ts`' rule and `game/driving.ts`
 * section 5's, applied to the one new thing both ends evaluate.
 *
 * That is why a body carries its heading as a **unit vector** `(dx, dz)` and
 * not as a yaw: `traffic.CarPose` already made this choice for the ambient
 * fleet ("the ambient fleet carries its heading as a unit vector already and
 * must not pay for a yaw it never had"), and it is stronger here, because the
 * heading is *integrated* -- see `rigidIntegrate`, which turns a spin into a
 * rotated heading with two multiplies and one square root and never a
 * trigonometric function.
 *
 * The two conversions that do use transcendentals are named and are both
 * boundary calls: `rigidSetHeading` (a yaw in, once, when a body is created
 * from a look direction) and `rigidYaw` (a yaw out, for the wire and for the
 * renderer). `traffic.drivenCarPose` and `driving.headingYaw` are the same pair
 * and carry the same argument: a value that is quantised to a `u16` on the wire
 * cannot be made wrong by a last-bit disagreement between two `Math.atan2`s.
 *
 * ---------------------------------------------------------------------------
 * 6. WHAT A THIRD CLIENT WOULD NEED.
 *
 * Recorded because the question was asked and because the answer is short.
 * Boats (`game/boats.ts`, DESIGN.md's suggestion #2) would need **nothing new
 * from this layer** for hull-against-hull: a ferry is a long box on a plane
 * with a mass and a heading, which is what a `RigidBody` is, and a RiverCat
 * bouncing off a wharf is `kinematic` on the wharf's side exactly as a wall is
 * for a car. What they would need is *around* it and belongs to them: a
 * resolver for the water's edge to pass to `rigidSeparate`'s caller (there is
 * no `CollisionWorld` on the harbour), a drag that is quadratic in speed rather
 * than the linear rolling friction below, and a yaw damping that models a keel.
 * All three are constants and a decay rule on the caller's side, which is
 * exactly where `driving.ts`'s are.
 *
 * The one thing a boat would want that is genuinely missing is **added mass** --
 * water dragged along with the hull, which makes a vessel behave heavier in a
 * collision than it is at rest. That is one multiplier on the effective mass in
 * `rigidResolve` and would be a parameter on the body rather than a rewrite.
 *
 * ---------------------------------------------------------------------------
 * 7. A CONTACT THAT PERSISTS HAS TO **SETTLE**, AND THAT IS FOUR RULES.
 *
 * The owner's second sentence on the live build was *"there needs some
 * damp[ening] for collision otherwise can vibrate between 2 spot"*, and he is
 * describing the one failure mode this file shipped with. Everything above was
 * written about a contact that happens **once** -- two cars meet, they bounce,
 * they leave. What none of it was written about is the contact that is still
 * there on the next tick, and the next, which is most of the contacts a player
 * actually has: a car nosed against a kerb car, a car parked between two others
 * in a bay, a wreck that has rolled to a stop against a bumper.
 *
 * A persistent contact resolved by the rules above is a **limit cycle**, and it
 * is worth writing the loop out because it is invisible in every single-tick
 * check in this project:
 *
 *   1. the pair overlap by `d`; `rigidSeparate` pushes out the whole of `d`;
 *   2. `rigidResolve` gives back `0.2 * closing` of rebound however small the
 *      closing was, so the pair leaves with a velocity that was not there;
 *   3. next tick the driver's throttle (or gravity, or the other car's own
 *      rebound) closes the gap again, and the depth comes back;
 *   4. go to 1.
 *
 * The displacement per tick is millimetres, so nothing "moves"; what a player
 * sees is a car whose position **alternates in sign every tick forever**, which
 * at 60 Hz is a buzz. Two spots.
 *
 * The four rules that end it, all of them standard and all of them stated here
 * because a reader retuning one has to see the other three:
 *
 *   - **`SEPARATION_SLOP` is 2 cm and not a millimetre.** Below it no positional
 *     correction is applied at all. A pair allowed to rest 2 cm inside each
 *     other is a pair that stops asking to be moved, and 2 cm is under the
 *     panel gap between two cars parked against each other -- it is not a
 *     distance anybody can see, and it is the *only* rule of the four that can
 *     bring the loop to an exact stop rather than to a small one.
 *   - **`CONTACT_CORRECTION` is 0.4 and not 1.** What is left over the slop is
 *     pushed out four tenths at a time, so a deep overlap comes apart over about
 *     six ticks instead of being snapped apart in one. Snapping is what turns a
 *     shunt into a launch, and it is also what makes the *sign* of the next tick
 *     unpredictable: a full correction routinely overshoots into the body on the
 *     other side, which is precisely the two-spot report inside a parking bay.
 *   - **`RESTITUTION_SPEED` is 1 m/s.** Under it the contact is perfectly
 *     inelastic -- `e` is 0, the impulse removes exactly the closing velocity
 *     and adds nothing. A restitution applied at 5 cm/s is a bounce with no
 *     energy in it that nevertheless never ends, because the thing that produced
 *     the 5 cm/s is still pressing. Over it, `restitution` is what it always was
 *     and a real crash is unchanged.
 *   - **`CONTACT_SETTLE` is 0.2 on a resting contact.** A fifth of the
 *     tangential velocity and a fifth of the spin come off each dynamic body
 *     every tick it stays in a resting contact. This is the rule that stops a
 *     car *rocking* against the one it is leaning on: the normal direction is
 *     dealt with by the three above, and what is left is a slew and a slide that
 *     the caller's own grip (`driving.CAR_SLIP_GRIP`) only sheds at a fixed
 *     rate. Contact damping sheds it geometrically and only while touching.
 *
 * All four are `+ - * /` and none of them is new arithmetic; section 5's rule is
 * untouched. The pair `verifyRigid` asserts is **convergence** rather than
 * separation-in-one-tick: after 60 ticks the per-tick displacement is under a
 * centimetre and the sign of the displacement along the normal has not
 * alternated more than twice. That is the property the owner reported the
 * absence of, and it is the one a single-tick assertion cannot state.
 */

// --- The body -------------------------------------------------------------------

/**
 * One thing that rolls, as everything about it that matters in plan.
 *
 * Deliberately a flat record of numbers with no methods and no class: it is
 * built once per vehicle per tick from whatever record that vehicle lives in
 * (`driving.DrivenCar`, a combatant on a bike), filled into a caller-owned
 * scratch, and thrown away. `traffic.CarPose` is the same shape for the same
 * reason -- this runs on every driven car against every record near it and must
 * not allocate.
 */
export interface RigidBody {
  /** Where the centre is, in the world plan. Metres. */
  x: number;
  z: number;
  /**
   * Which way it points, as a **unit vector**. See section 5.
   *
   * `traffic.CarPose.dx/dz`' convention exactly, which is `controller.step`'s:
   * a yaw of 0 is `(0, -1)`, and left of a heading `(dx, dz)` is `(dz, -dx)`.
   */
  dx: number;
  dz: number;
  /** Velocity in world axes, m/s. Not along the heading -- a skidding car has both. */
  vx: number;
  vz: number;
  /**
   * How fast it is turning, radians a second, positive to the **left**.
   *
   * Left rather than right because that is the direction an increasing yaw
   * turns in this project (`shapeDriveSteering`: "yaw increasing turns left"),
   * so a spin integrated here and a spin folded into a look yaw have the same
   * sign and nobody has to remember a conversion.
   */
  yawRate: number;
  /** Kilograms. Ignored when `kinematic`; see `rigidInvMass`. */
  mass: number;
  /** Half the plan footprint, metres. Length is along the heading. */
  halfLength: number;
  halfWidth: number;
  /** How much of the closing speed comes back, 0 (dead) to 1 (perfectly elastic). */
  restitution: number;
  /** Coulomb friction at the contact, as a fraction of the normal impulse. */
  friction: number;
  /**
   * Immovable and infinitely heavy: a wall, a parked bus, the ambient fleet.
   *
   * A flag rather than `mass = Infinity` because an infinite mass propagates
   * into every intermediate -- `Infinity * 0` is `NaN`, and one `NaN` in a
   * contact silently deletes both bodies' velocities. The flag is checked once
   * in `rigidInvMass` and the arithmetic downstream only ever sees zeros.
   */
  kinematic: boolean;
}

export function createRigidBody(): RigidBody {
  return {
    x: 0, z: 0, dx: 0, dz: -1, vx: 0, vz: 0, yawRate: 0,
    mass: 1, halfLength: 0.5, halfWidth: 0.5,
    restitution: DEFAULT_RESTITUTION, friction: DEFAULT_FRICTION, kinematic: false,
  };
}

/**
 * How much of a closing speed a vehicle contact gives back. **0.2.**
 *
 * The brief's number and the right one for a reason worth stating rather than
 * inheriting: a car is a crumple zone with wheels on it, and the energy of a
 * shunt goes into the panels rather than back into the cars. At 0 two cars
 * that met would stick together and slide as one object, which reads as a bug;
 * at 0.5 a nudge in a car park would send the other car three metres, which
 * reads as a bumper car. 0.2 is a shove that stops.
 *
 * It is a *default* on the body rather than a constant of this file, because
 * the third client will want a different one -- a fibreglass hull off a timber
 * wharf is bouncier than a Camry off a Camry -- and the number belongs to
 * whoever owns the vehicle.
 */
export const DEFAULT_RESTITUTION = 0.2;

/**
 * And how much sideways grip the contact has. **0.5.**
 *
 * The tangential impulse is clamped to this times the normal one, which is
 * Coulomb's law and is what makes a T-bone *drag* the struck car along a little
 * instead of letting it slide frictionlessly out of the way. Half is steel on
 * steel with a tyre somewhere in the load path; it is not a measured figure and
 * does not need to be, because what it decides is how much of a sideswipe
 * carries the other car with you, and the readable range is wide.
 */
export const DEFAULT_FRICTION = 0.5;

/** Inverse mass, and the whole of what `kinematic` means to the arithmetic. */
export function rigidInvMass(b: RigidBody): number {
  if (b.kinematic) return 0;
  return b.mass > 0 ? 1 / b.mass : 0;
}

/**
 * Inverse moment of inertia about the up axis, 1 / (kg m^2).
 *
 * The rectangle's own `m (L^2 + W^2) / 12`, computed rather than stored,
 * because storing it would be a second number that has to be kept in step with
 * the three it is derived from -- and this is four multiplies on a path that
 * already does thirty.
 *
 * A car is not a uniform rectangular slab (the engine is over the front axle),
 * so this overstates how easily a sedan spins by a few per cent. That error is
 * a *feel* error in the forgiving direction -- a shunt that spins a car
 * slightly more than physics would -- and buying it back would mean a per-body
 * inertia constant that nobody could tune by eye.
 */
export function rigidInvInertia(b: RigidBody): number {
  if (b.kinematic) return 0;
  const l = b.halfLength * 2;
  const w = b.halfWidth * 2;
  const i = (b.mass * (l * l + w * w)) / 12;
  return i > 0 ? 1 / i : 0;
}

/**
 * Point a body down a look yaw. **One of the two boundary calls; see section 5.**
 *
 * `traffic.drivenCarPose` does the identical pair of transcendentals for the
 * identical reason and states it: this runs once per driven body per tick,
 * driven bodies are counted in ones, and the alternative is carrying a yaw
 * through the integrator where it would cost a `sin`/`cos` per *step*.
 */
export function rigidSetHeading(b: RigidBody, yaw: number): void {
  b.dx = -Math.sin(yaw);
  b.dz = -Math.cos(yaw);
}

/**
 * And back out again, for the wire and for whatever draws it.
 *
 * `driving.headingYaw`'s function, restated here rather than imported because
 * the dependency runs the other way -- `driving.ts` imports this file.
 * `verifyRigid` asserts the two agree over a full turn, which is the same
 * arrangement `driving.SPRINT_SPEED` has with the controller.
 *
 * **Never on the shared simulation path.** The value it produces is quantised
 * to a `u16` by `protocol.encodeCars` before anybody else sees it, so a last-bit
 * disagreement between two `Math.atan2` implementations cannot survive the
 * encode -- which is the whole of why this is allowed to exist at all.
 */
export function rigidYaw(b: RigidBody): number {
  return Math.atan2(-b.dx, -b.dz);
}

/** The component of a body's velocity along its own heading, m/s. Signed. */
export function rigidAlong(b: RigidBody): number {
  return b.vx * b.dx + b.vz * b.dz;
}

/**
 * And across it, positive to its **left**. `traffic`'s axes: left of `(dx, dz)`
 * is `(dz, -dx)`.
 */
export function rigidSlip(b: RigidBody): number {
  return b.vx * b.dz - b.vz * b.dx;
}

/** Set the velocity from a signed speed along the heading and a slip across it. */
export function rigidSetVelocity(b: RigidBody, along: number, slip: number): void {
  b.vx = b.dx * along + b.dz * slip;
  b.vz = b.dz * along - b.dx * slip;
}

// --- The contact ------------------------------------------------------------------

/**
 * Where two boxes met, how deep they are into each other, and which way out.
 *
 * Filled by `rigidOverlap` and consumed by the two functions after it. A record
 * the caller owns and reuses, on `traffic.CarPose`'s contract: the sweep that
 * asks this question runs per driven car per record near it, every tick, on the
 * server's hot path.
 */
export interface RigidContact {
  /**
   * The way out, as a unit vector pointing **from `a` toward `b`**.
   *
   * The minimum axis of the separating-axis test, which for two rectangles is
   * always one of the four face normals -- so it is exactly a face direction of
   * one of the two boxes and never an invented direction. That is what makes a
   * nose-to-tail shunt push straight down the road rather than at a diagonal.
   */
  nx: number;
  nz: number;
  /** How far they overlap along that axis, metres. Always positive on a hit. */
  depth: number;
  /**
   * Where the contact is, in world metres. The arm every torque is taken about.
   *
   * The midpoint of the two support points -- the point on `a` furthest along
   * the normal and the point on `b` furthest against it. For a nose-to-tail hit
   * that lands on the centreline and produces no spin, which is right; for a
   * T-bone it lands where the bonnet actually is against the other car's flank,
   * which is off that car's centre and is what makes it slew. See
   * `rigidResolve`, and `verifyRigid`'s T-bone case, which asserts the sign.
   */
  cx: number;
  cz: number;
}

export function createRigidContact(): RigidContact {
  return { nx: 0, nz: 1, depth: 0, cx: 0, cz: 0 };
}

/**
 * Are these two boxes in each other? Fills `out` and returns true if so.
 *
 * The separating-axis test over two oriented rectangles: four candidate axes
 * (each box's two face normals), and a gap on any one of them is a proof of
 * separation and an early return. `driving.carCrashClosing`'s header calls this
 * out as the thing it deliberately approximated with a circle -- *"a
 * separating-axis test over two rotated rectangles, eight dot products"* -- and
 * this is that test, written once here so the *detector* and the *response*
 * cannot disagree about whether two cars are touching.
 *
 * The projection of a box onto an axis is `|hl (d . n)| + |hw (l . n)|` where
 * `d` is its heading and `l` its left, which is the standard rectangle radius
 * and is four multiplies and two absolutes. No square roots at all on the
 * rejection path, which is the path taken by essentially every pair every tick.
 *
 * **The normal is oriented from `a` to `b`** whichever box the winning axis
 * belonged to, so a caller never has to ask whose axis won.
 */
export function rigidOverlap(a: RigidBody, b: RigidBody, out: RigidContact): boolean {
  const rx = b.x - a.x;
  const rz = b.z - a.z;

  // A cheap circular reject before any of the four axes, on `closingAlong`'s
  // own argument: the radius of a box is its half-diagonal, this is one
  // comparison, and it is false for all but a handful of the pairs a tick asks
  // about.
  const reachA = a.halfLength + a.halfWidth;
  const reachB = b.halfLength + b.halfWidth;
  const reach = reachA + reachB;
  if (rx * rx + rz * rz > reach * reach) return false;

  let bestDepth = Infinity;
  let bestX = 0;
  let bestZ = 0;

  // The four axes, in a fixed order -- `a`'s heading, `a`'s left, `b`'s
  // heading, `b`'s left. Fixed rather than incidental for `forEachCarNear`'s
  // reason: two processes testing the same pair must break a tie between two
  // equally shallow axes the same way, and "the first one found" is a rule both
  // can state where "the smallest float" is one they can disagree about.
  for (let i = 0; i < 4; i++) {
    const from = i < 2 ? a : b;
    // Even indices are the heading, odd ones the left of it.
    const nx = (i & 1) === 0 ? from.dx : from.dz;
    const nz = (i & 1) === 0 ? from.dz : -from.dx;
    const ra = boxRadius(a, nx, nz);
    const rb = boxRadius(b, nx, nz);
    const centre = rx * nx + rz * nz;
    const depth = ra + rb - (centre < 0 ? -centre : centre);
    if (depth <= 0) return false;
    if (depth < bestDepth) {
      bestDepth = depth;
      // Oriented from `a` toward `b`, whichever box the axis came from. A
      // centre offset of exactly zero -- two bodies on the same point -- keeps
      // the axis as it is; the caller is protected from that case by the
      // degenerate guard in `rigidResolve` and by the fact that two records at
      // one point is a take the claim rules make impossible.
      if (centre < 0) {
        bestX = -nx;
        bestZ = -nz;
      } else {
        bestX = nx;
        bestZ = nz;
      }
    }
  }

  out.nx = bestX;
  out.nz = bestZ;
  out.depth = bestDepth;

  // --- Where the contact is. See `RigidContact.cx`: the **centre of the
  //     overlapping face**, in the orthonormal pair the winning axis defines.
  //
  // Written this way rather than as "the support point of each box, averaged",
  // which is the obvious version and is wrong in a way that has no picture: the
  // support point of a rectangle along one of its own face normals is a
  // *corner*, so two cars meeting squarely nose to nose would be given a
  // contact at one front corner and would spin violently apart. The first draft
  // of this function did exactly that and `verifyRigid`'s head-on case caught
  // it -- the two sedans left at 1.4 m/s and 3.8 rad/s, which is a stunt driver
  // and not a shunt.
  //
  // Along the normal it is the midpoint of the interpenetration; across it, the
  // midpoint of the interval both boxes cover. For a square nose-to-nose that
  // is the centreline and the spin is nought, which is right; for a T-bone it
  // is the middle of the length of flank the bonnet is actually against, which
  // is off the struck car's centre and is what slews it.
  const tx = bestZ;
  const tz = -bestX;
  const an = a.x * bestX + a.z * bestZ + boxRadius(a, bestX, bestZ);
  const bn = b.x * bestX + b.z * bestZ - boxRadius(b, bestX, bestZ);
  const cn = (an + bn) * 0.5;
  const at = a.x * tx + a.z * tz;
  const bt = b.x * tx + b.z * tz;
  const ar = boxRadius(a, tx, tz);
  const br = boxRadius(b, tx, tz);
  const lo = Math.max(at - ar, bt - br);
  const hi = Math.min(at + ar, bt + br);
  const ct = (lo + hi) * 0.5;
  // `(n, t)` is orthonormal, so the world point is just the two components put
  // back together.
  out.cx = cn * bestX + ct * tx;
  out.cz = cn * bestZ + ct * tz;
  return true;
}

/** How far a box reaches along an axis from its own centre. The rectangle radius. */
function boxRadius(b: RigidBody, nx: number, nz: number): number {
  const along = b.dx * nx + b.dz * nz;
  const across = b.dz * nx - b.dx * nz;
  const a = along < 0 ? -along : along;
  const c = across < 0 ? -across : across;
  return b.halfLength * a + b.halfWidth * c;
}

/**
 * How far each body has to move to stop being inside the other, along the
 * contact normal, by mass ratio.
 *
 * Returns the two displacements in `out` as `[ax, az, bx, bz]` -- a flat array
 * the caller owns, on `CarField.recycleFarthest`'s argument about its flat
 * `[x, z, ...]` roster: this runs on the tick two cars touch and building a
 * pair of literals for it would be two allocations for six subtractions.
 *
 * **By mass ratio and not half each**, which is the whole of the owner's *"a 2 t
 * ute pushes a 1.4 t sedan further than the reverse"*: the heavier body moves
 * the smaller share, a kinematic one does not move at all, and the two shares
 * always sum to the depth so the pair is exactly separated whoever is heavier.
 *
 * **`SEPARATION_SLOP` and `CONTACT_CORRECTION` are the first two of section 7's
 * four settling rules**, and they are both on this line:
 *
 *     depth = (contact.depth - SEPARATION_SLOP) * CONTACT_CORRECTION
 *
 * The slop is the depth this function refuses to have an opinion about, and the
 * correction is the fraction of what is left that it asks for this tick. Read
 * section 7 before changing either; the short version is that a full correction
 * of every millimetre is what makes a pair of cars leaning on each other
 * alternate in sign at 60 Hz forever, which the owner reported as vibrating
 * between two spots.
 */
export function rigidSeparate(
  a: RigidBody,
  b: RigidBody,
  contact: RigidContact,
  out: number[],
): number[] {
  const ia = rigidInvMass(a);
  const ib = rigidInvMass(b);
  const total = ia + ib;
  let depth = (contact.depth - SEPARATION_SLOP) * CONTACT_CORRECTION;
  // --- **And never leave more than `MAX_PENETRATION` standing**, whatever the
  //     fraction says. See that constant: the fraction governs a contact that is
  //     settling and the cap governs one that is being *driven*, and the two
  //     never meet because they live at depths an order of magnitude apart.
  const excess = contact.depth - MAX_PENETRATION;
  if (excess > depth) depth = excess;
  if (total <= 0 || depth <= 0) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    return out;
  }
  // `a` goes backwards along the normal, `b` forwards -- the normal points from
  // `a` to `b`, so that is the direction that grows the gap.
  const sa = (depth * ia) / total;
  const sb = (depth * ib) / total;
  out[0] = -contact.nx * sa;
  out[1] = -contact.nz * sa;
  out[2] = contact.nx * sb;
  out[3] = contact.nz * sb;
  return out;
}

/**
 * How much overlap is left standing rather than pushed out. **2 cm.**
 *
 * Section 7's first settling rule, and it was a millimetre until the owner's
 * *"can vibrate between 2 spot"*. A millimetre is the number a solver needs to
 * stop re-detecting a contact it resolved to exactly touching; it is nowhere
 * near the number a solver needs for a pair of bodies somebody is **still
 * pressing together** to come to rest, because the press puts a fresh
 * millimetre of depth in every tick and the correction takes it straight back
 * out. What ends that loop is a dead band wider than one tick of the press: at
 * `driving.DRIVE_ACCELERATION` a car resting against another one gains 1.7 mm
 * of depth a tick, so 2 cm is a dozen ticks of dead band and the contact
 * genuinely stops moving.
 *
 * 2 cm is chosen against what it costs rather than against what it fixes, which
 * is the honest way round: it is the gap two cars parked against each other are
 * *drawn* with, it is under the panel line on any of the five bodies, and it is
 * twice `protocol.quantisePos`' own centimetre -- so a pair resting at the slop
 * is a pair the wire cannot describe as anything but touching.
 */
export const SEPARATION_SLOP = 0.02;

/**
 * And how much of what is left over the slop is pushed out per tick. **0.4.**
 *
 * Section 7's second rule. The classic Baumgarte fraction and it is here for the
 * classic reason plus one of this game's own:
 *
 *   - a correction of 1 routinely **overshoots**. The separation is computed
 *     from a depth measured before the impulse, and the impulse is about to move
 *     the pair apart as well -- so the full push lands the body past where it
 *     needed to be, and in a parking bay that is *into the car on the other
 *     side*, whose full correction then lands it back. That is the two-spot
 *     report with a car at each spot.
 *   - and a correction of 1 is a **teleport**. A car rammed 40 cm into a bus is
 *     snapped 40 cm backwards in one frame, which reads as the bus spitting it
 *     out. At 0.4 the same 40 cm comes apart over six ticks -- a tenth of a
 *     second -- and reads as the panels pushing back.
 *
 * The pair is still exactly separated in the limit, which is the property that
 * matters: 0.4 is a rate and not a share, so the depth decays geometrically to
 * the slop and stays there. Lower would leave two cars visibly interpenetrating
 * for a quarter of a second; higher walks back toward the overshoot.
 */
export const CONTACT_CORRECTION = 0.4;

/**
 * And the deepest overlap the layer will leave standing at any speed. **10 cm.**
 *
 * `CONTACT_CORRECTION`'s companion, and the reason the fraction is safe. A
 * fraction on its own has an equilibrium wherever the correction it produces
 * equals the depth the closing puts back, and for two drivers holding the
 * throttle into each other at 21 m/s apiece that is `0.7 / 0.4`, or **1.75 m** --
 * two sedans most of the way through each other for as long as both hold W.
 * `server/carcrash-check.ts` section 1 measured 0.88 m of it on the first run
 * after the settling rules landed, which is the check doing its job.
 *
 * So the correction is the *larger* of the fraction and whatever it takes to get
 * back under this cap. The two rules never argue, because they live at depths an
 * order of magnitude apart: a contact that is settling is a centimetre deep and
 * the cap is silent, and a contact that is 10 cm deep is a crash where nothing
 * about a fraction of a millimetre matters.
 *
 * **10 cm** because it is what a crumple zone looks like. Two cars meeting at
 * 150 km/h and ending a tenth of a metre inside each other for the two frames
 * before they come apart reads as panels folding; a metre reads as one car
 * inside the other, and nought reads as a wall.
 */
export const MAX_PENETRATION = 0.1;

/**
 * The closing speed under which a contact does not bounce at all, m/s. **1.**
 *
 * Section 7's third rule. `DEFAULT_RESTITUTION` is 0.2 and is right for a crash;
 * applied to a *press* it is the engine of the limit cycle, because 20 % of a
 * closing speed the throttle is about to restore is a rebound that arrives every
 * tick for the rest of the session. Under this threshold `e` is 0 and the
 * contact is perfectly inelastic -- the impulse removes exactly the closing
 * velocity and puts nothing back -- which is the standard resting-contact rule
 * and is what "the car stops against the other car" means.
 *
 * **1 m/s** because that is walking pace and is the speed below which a bounce
 * has no picture: two cars that meet at 3.6 km/h and rebound are two cars a
 * player would describe as magnetic. It is also comfortably above what a
 * persistent press generates -- a car held against another at full throttle
 * closes at the 0.1 m/s one tick of `DRIVE_ACCELERATION` buys -- and comfortably
 * below anything anybody would call a crash (`driving.CRASH_FREE_SPEED` is 12).
 */
export const RESTITUTION_SPEED = 1;

/**
 * How much of the slide and the spin a resting contact takes off, per tick. **0.2.**
 *
 * Section 7's fourth rule, and the only one of the four that is about a
 * direction the other three do not touch. Once the normal is settled what is
 * left of a shove is a body **rocking** against the one it leans on: a slip
 * across the contact and a yaw rate about it, neither of which the separation or
 * the normal impulse has any opinion about, and both of which the caller's own
 * grip only sheds at a fixed rate (`driving.CAR_SLIP_GRIP` is 8 m/s^2, which is
 * a fifth of a second from a hard shunt and is a fifth of a second of a car
 * grinding along its neighbour).
 *
 * A fifth per tick is a geometric decay with a time constant of 75 ms, so a
 * shove that has come to rest against something stops slewing inside a tenth of
 * a second -- and it is applied **only while a resting contact exists**, so a
 * car sliding freely is untouched and a hard T-bone (which is not resting) keeps
 * every radian of its spin. Both of those are properties `verifyRigid` asserts,
 * because a damping that applied everywhere would be a handling change wearing a
 * collision fix's clothes.
 */
export const CONTACT_SETTLE = 0.2;

/**
 * The impulse: what the contact does to both bodies' velocities and spins.
 *
 * Returns the magnitude of the normal impulse in newton-seconds, which is the
 * number a caller turns into damage, into a knockdown or into nothing. Zero
 * when the pair is already separating, which is the common case on the tick
 * *after* a shunt and is why this is safe to call every tick a contact persists.
 *
 * ---------------------------------------------------------------------------
 * THE SIGN OF A SPIN, DERIVED RATHER THAN GUESSED, BECAUSE IT HAS NO PICTURE.
 *
 * A torque about the up axis in this project's axes is
 *
 *     tau = r.z * J.x - r.x * J.z
 *
 * and the way to check that is a worked case rather than a right-hand rule.
 * Take a body at yaw 0, whose heading is `(0, -1)` and whose left is `(-1, 0)`.
 * Hit its nose -- the arm `r` is `(0, -1)`, one metre forward -- with an impulse
 * `J` of `(-1, 0)`, which pushes the nose toward its left. The nose going left
 * is the heading rotating from `(0, -1)` toward `(-1, 0)`, which is an
 * *increasing* yaw (`shapeDriveSteering`: "yaw increasing turns left"), so the
 * spin must come out positive. The expression gives `(-1)(-1) - (0)(0) = +1`.
 * It does.
 *
 * The velocity of a point on a spinning body follows from that by duality --
 * the power delivered by an impulse must be the same computed either way -- and
 * is `v + w * (r.z, -r.x)`. That is the pair used below and it is the pair
 * `verifyRigid`'s T-bone case asserts, because a sign error here is a shunt
 * that spins the struck car the wrong way, which looks like physics to anybody
 * who is not standing at the intersection.
 *
 * Restitution and friction are read from **the softer of the two bodies** --
 * `Math.min` on both -- rather than averaged, which is the conventional choice
 * and the legible one: a Camry into a wall behaves like a Camry, and adding a
 * hard body to the world cannot make an existing pair bouncier than it was.
 */
export function rigidResolve(a: RigidBody, b: RigidBody, contact: RigidContact): number {
  const ima = rigidInvMass(a);
  const imb = rigidInvMass(b);
  const iia = rigidInvInertia(a);
  const iib = rigidInvInertia(b);
  const inv = ima + imb;
  // Two kinematic bodies, or two of infinite mass: nothing to do and no divide
  // to risk. A wall against a wall is a legal question with a boring answer.
  if (inv <= 0) return 0;

  const rax = contact.cx - a.x;
  const raz = contact.cz - a.z;
  const rbx = contact.cx - b.x;
  const rbz = contact.cz - b.z;

  const nx = contact.nx;
  const nz = contact.nz;

  // The relative velocity at the contact point, `b` relative to `a`. See the
  // header for where the `(r.z, -r.x)` comes from.
  const vax = a.vx + a.yawRate * raz;
  const vaz = a.vz - a.yawRate * rax;
  const vbx = b.vx + b.yawRate * rbz;
  const vbz = b.vz - b.yawRate * rbx;
  const rvx = vbx - vax;
  const rvz = vbz - vaz;

  const vn = rvx * nx + rvz * nz;
  // Already moving apart. Not a contact this tick however deep they are, which
  // is what stops a resolved pair being hit a second time as they separate --
  // the standard guard, and the one that makes calling this every tick safe.
  if (vn >= 0) return 0;

  const crossAn = raz * nx - rax * nz;
  const crossBn = rbz * nx - rbx * nz;
  const denom = inv + crossAn * crossAn * iia + crossBn * crossBn * iib;
  if (denom <= 0) return 0;

  // --- Section 7's third rule. A contact that is barely closing does not bounce
  //     at all: `e` is 0, the impulse removes exactly the closing velocity, and
  //     what is left is a body resting against another body. Above the threshold
  //     the restitution is what it always was and a crash is unchanged.
  const resting = -vn <= RESTITUTION_SPEED;
  const e = resting ? 0 : Math.min(a.restitution, b.restitution);
  const j = (-(1 + e) * vn) / denom;
  if (!(j > 0)) return 0;

  applyImpulse(a, rax, raz, -j * nx, -j * nz, ima, iia);
  applyImpulse(b, rbx, rbz, j * nx, j * nz, imb, iib);

  // --- And the tangential half, which is what drags the struck car along
  //     instead of letting it slide out of the way frictionlessly.
  //
  // The tangent is the normal turned a quarter turn -- `(nz, -nx)`, the same
  // "left of" this file uses everywhere -- and the impulse along it is clamped
  // to Coulomb's `mu * j`, which is what makes a glancing hit a scrape and a
  // square one a shove.
  const tx = nz;
  const tz = -nx;
  const vt = rvx * tx + rvz * tz;
  if (vt !== 0) {
    const crossAt = raz * tx - rax * tz;
    const crossBt = rbz * tx - rbx * tz;
    const dt = inv + crossAt * crossAt * iia + crossBt * crossBt * iib;
    if (dt > 0) {
      const mu = Math.min(a.friction, b.friction);
      const limit = mu * j;
      let jt = -vt / dt;
      if (jt > limit) jt = limit;
      else if (jt < -limit) jt = -limit;
      applyImpulse(a, rax, raz, -jt * tx, -jt * tz, ima, iia);
      applyImpulse(b, rbx, rbz, jt * tx, jt * tz, imb, iib);
    }
  }

  // --- And section 7's fourth rule, last, because it is the only thing here
  //     that is not an impulse and must not be inside the Coulomb clamp.
  //
  // Only on a resting contact: a car sliding freely is untouched and a T-bone
  // keeps its spin. See `CONTACT_SETTLE`.
  if (resting) {
    settleContact(a, nx, nz);
    settleContact(b, nx, nz);
  }

  return j;
}

/**
 * Take `CONTACT_SETTLE` off a body's slide and its spin. See section 7.
 *
 * A multiply and not an `approach`, which is the opposite of the choice
 * `driving.stepCarSpeed` makes about grip and is right for the opposite reason:
 * that one has to reach *exactly* zero because it runs on every tick of every
 * drive forever, and this one only runs while two bodies are touching -- so a
 * geometric decay cannot leave a residue behind, because the thing that applies
 * it stops existing the moment the contact does. What it must be instead is
 * scale-free, so a car leaning hard and a car leaning gently settle in the same
 * *time* rather than the harder one taking longer.
 */
function settleContact(b: RigidBody, nx: number, nz: number): void {
  if (b.kinematic) return;
  b.yawRate -= b.yawRate * CONTACT_SETTLE;
  // Across the contact only. The normal direction is the impulse's and damping
  // it here would be a second opinion about the one quantity `rigidResolve`
  // exists to decide.
  const tx = nz;
  const tz = -nx;
  const vt = b.vx * tx + b.vz * tz;
  if (vt === 0) return;
  const shed = vt * CONTACT_SETTLE;
  b.vx -= shed * tx;
  b.vz -= shed * tz;
}

/** One body's share of an impulse, linear and angular. See `rigidResolve`. */
function applyImpulse(
  body: RigidBody,
  rx: number,
  rz: number,
  jx: number,
  jz: number,
  invMass: number,
  invInertia: number,
): void {
  if (invMass <= 0 && invInertia <= 0) return;
  body.vx += jx * invMass;
  body.vz += jz * invMass;
  // `tau = r.z * J.x - r.x * J.z`. The derivation is in `rigidResolve`'s header
  // and it is worked rather than asserted, because the failure has no picture.
  body.yawRate += (rz * jx - rx * jz) * invInertia;
}

// --- The integrator ----------------------------------------------------------------

/**
 * Move a body forward by `dt`, and turn it by its own spin.
 *
 * **The rotation is two multiplies and a square root and never a `sin`.** A
 * heading turned by a small angle `w dt` to first order is
 * `d + left(d) * (w dt)`, which grows the vector by a factor of
 * `sqrt(1 + (w dt)^2)` and is then renormalised -- so what actually happens is
 * an exact rotation by `atan(w dt)` rather than by `w dt`. At the spins this
 * game produces (a hard T-bone is about 3 rad/s) and a 60 Hz step that is an
 * error of 4e-5 radians a tick, which is a hundredth of the `u16` the wire
 * quantises a yaw to and is therefore not a quantity anything downstream can
 * represent. Both ends make the identical error, which is the property that
 * actually matters. See section 5.
 *
 * The **rolling decay** is applied here rather than by the caller so that a
 * body nobody is driving comes to rest without anybody having to remember to
 * stop it -- which is exactly the failure a knocked-loose car would have: a
 * Camry punted across an intersection and then sliding forever, at walking
 * pace, for the rest of the session.
 *
 * `linear` and `angular` are decay rates in units per second, subtracted
 * toward zero and never through it: `approach`'s rule, which
 * `driving.stepCarSpeed` states -- an unclamped `v -= k * dt` overshoots at
 * 60 Hz and leaves a stopped car creeping backwards.
 */
export function rigidIntegrate(
  b: RigidBody,
  dt: number,
  linear = ROLLING_DECAY,
  angular = SPIN_DECAY,
): void {
  if (dt <= 0) return;
  b.x += b.vx * dt;
  b.z += b.vz * dt;

  if (b.yawRate !== 0) {
    const turn = b.yawRate * dt;
    // Left of `(dx, dz)` is `(dz, -dx)`.
    const nx = b.dx + b.dz * turn;
    const nz = b.dz - b.dx * turn;
    const len2 = nx * nx + nz * nz;
    if (len2 > 1e-12) {
      // `Math.sqrt` and never `Math.hypot`, on `driving.crashFromClamp`'s rule
      // and this file's section 5.
      const s = 1 / Math.sqrt(len2);
      b.dx = nx * s;
      b.dz = nz * s;
    }
  }

  // The linear decay is applied to the *speed* rather than per axis, so a body
  // sliding diagonally slows at the same rate as one sliding along an axis. Per
  // axis is the bug that makes a 45-degree skid last 1.41 times as long as a
  // straight one, which nobody would ever attribute to a decay constant.
  const speed2 = b.vx * b.vx + b.vz * b.vz;
  if (speed2 > 0) {
    const speed = Math.sqrt(speed2);
    const shed = linear * dt;
    if (shed >= speed) {
      b.vx = 0;
      b.vz = 0;
    } else {
      const k = (speed - shed) / speed;
      b.vx *= k;
      b.vz *= k;
    }
  }

  if (b.yawRate !== 0) {
    const shed = angular * dt;
    if (b.yawRate > 0) b.yawRate = b.yawRate > shed ? b.yawRate - shed : 0;
    else b.yawRate = b.yawRate < -shed ? b.yawRate + shed : 0;
  }
}

/**
 * How fast a body nobody is driving sheds speed, m/s per second. **3.**
 *
 * Chosen against the one thing a player can see it in, which is how far a car
 * knocked loose travels: a Camry punted at 8 m/s rolls 10.7 m and stops in 2.7
 * seconds, and one punted at 15 m/s rolls 37 m in five. That is a shunt that
 * carries across an intersection and stops in the far gutter, which is the
 * picture; at 1 m/s a knocked car would coast half a block and read as being on
 * ice, and at 8 it would stop dead in two car lengths and read as being on
 * glue.
 *
 * Deliberately *less* than `driving.DRIVE_COAST` (4.4), which is a car with an
 * engine braking it, and deliberately more than a real free-rolling car (about
 * 0.3 m/s^2 on tarmac): a car that has been hit hard enough to be knocked loose
 * is a car with a bent wheel, and a real one would roll for two hundred metres,
 * which is a car nobody can find again.
 */
export const ROLLING_DECAY = 3;

/**
 * And how fast a spin dies, radians per second per second. **2.5.**
 *
 * Set against the same picture: a hard T-bone imparts about 3 rad/s, and at
 * 2.5 that is 1.2 seconds and about a hundred degrees of slew before it stops
 * turning -- a car spun a quarter turn out of its lane. Twice as slow would be
 * a spinning top; twice as fast would make the spin a flicker nobody sees.
 */
export const SPIN_DECAY = 2.5;

// --- Self-check --------------------------------------------------------------------

/**
 * Everything about this layer that fails by producing a perfectly plausible
 * frame.
 *
 * There is no picture for any of it, which is why this check exists at all and
 * is on both boot lists:
 *
 *   - **A separation that does not separate.** Two cars resolved to still
 *     overlapping re-contact on the next tick, which is a pair of cars welded
 *     together sliding down George Street.
 *   - **An impulse with the wrong sign on the spin.** A T-bone that slews the
 *     struck car the wrong way is *physics* to anybody who was not standing at
 *     the intersection, and there is no frame in which it looks wrong.
 *   - **A mass ratio that is not a mass ratio.** The owner's own case: a ute
 *     that a sedan pushes as far as the ute pushes it is a game in which the
 *     bodies are cosmetic.
 *   - **A body that penetrates a kinematic one.** A car that ends up inside a
 *     bus draws two cars in one parking space, which `world/carlod.ts` exists
 *     to have none of.
 *   - **A drift between two integrations.** The one that costs a session: the
 *     browser and the server integrating the same inputs to different answers
 *     is a car that rubber-bands, and it shows up as "the netcode is bad"
 *     rather than as a physics bug.
 */
export function verifyRigid(): string[] {
  const failures: string[] = [];
  const contact = createRigidContact();
  const push: number[] = [0, 0, 0, 0];

  /** A sedan-shaped body, which is what every case below is made of. */
  const sedan = (x: number, z: number, yaw: number, along: number, mass = 1400): RigidBody => {
    const b = createRigidBody();
    b.x = x;
    b.z = z;
    rigidSetHeading(b, yaw);
    b.halfLength = 2.3;
    b.halfWidth = 0.9;
    b.mass = mass;
    rigidSetVelocity(b, along, 0);
    return b;
  };

  /** One contact, separation applied directly (no world) and then resolved. */
  const collide = (a: RigidBody, b: RigidBody): number => {
    if (!rigidOverlap(a, b, contact)) return 0;
    rigidSeparate(a, b, contact, push);
    a.x += push[0];
    a.z += push[1];
    b.x += push[2];
    b.z += push[3];
    return rigidResolve(a, b, contact);
  };

  // --- The boundary pair, first, because everything below reads a heading.
  for (const yaw of [0, 0.7, 1.9, -2.6, 3.1]) {
    const b = createRigidBody();
    rigidSetHeading(b, yaw);
    const back = rigidYaw(b);
    // Compared as a heading rather than as an angle, because -pi and pi are the
    // same direction and a raw subtraction calls them 6.28 apart.
    const c = createRigidBody();
    rigidSetHeading(c, back);
    if (Math.abs(c.dx - b.dx) > 1e-9 || Math.abs(c.dz - b.dz) > 1e-9) {
      failures.push(`A heading set from yaw ${yaw} and read back does not point the same way.`);
    }
  }
  {
    const b = createRigidBody();
    rigidSetHeading(b, 0);
    if (Math.abs(b.dx) > 1e-12 || Math.abs(b.dz + 1) > 1e-12) {
      failures.push(`Yaw 0 points (${b.dx}, ${b.dz}) and not (0, -1) -- the controller's convention.`);
    }
    rigidSetVelocity(b, 10, 3);
    if (Math.abs(rigidAlong(b) - 10) > 1e-9 || Math.abs(rigidSlip(b) - 3) > 1e-9) {
      failures.push('A velocity set from (along, slip) does not read back as the same pair.');
    }
  }

  // --- 1. Two sedans head-on at 10 m/s each. They separate, they end up moving
  //        apart, and they are not overlapping after the tick.
  {
    // Nose to nose with 0.4 m of overlap: 4.6 m of car, so the centres are
    // 4.2 m apart along the shared axis.
    const a = sedan(0, 0, Math.PI, 10);      // facing +Z, driving +Z
    const b = sedan(0, 4.2, 0, 10);          // facing -Z, driving -Z
    const j = collide(a, b);
    if (j <= 0) failures.push('Two sedans meeting head-on at 10 m/s each produced no impulse at all.');
    // **Separated over a handful of ticks and not in one**, which is section 7's
    // `CONTACT_CORRECTION` and is the assertion that changed when the settling
    // rules landed. What is required of the layer is that the depth *converges*
    // to the slop; a solver that got there in one tick would be the one that
    // overshoots into whatever is on the other side.
    // The slop is where it converges *to*, so the bound is the slop plus a
    // float's worth -- a geometric decay reaches it from above and never through.
    const settled = SEPARATION_SLOP + 1e-6;
    let depthAfter = rigidOverlap(a, b, contact) ? contact.depth : 0;
    for (let i = 0; i < 60 && depthAfter > settled; i++) {
      const was = depthAfter;
      collide(a, b);
      depthAfter = rigidOverlap(a, b, contact) ? contact.depth : 0;
      if (depthAfter > was + 1e-9) {
        failures.push(
          `Two sedans resolved from ${was.toFixed(4)} m of overlap to ${depthAfter.toFixed(4)} m. A ` +
            'separation that grows the penetration is the loop the owner saw as vibration.',
        );
        break;
      }
    }
    if (depthAfter > settled) {
      failures.push(
        `Two sedans are still ${depthAfter.toFixed(4)} m inside each other a second after they met.`,
      );
    }
    // Moving apart: `a` is behind `b` along +Z, so a separating pair has `b`
    // going more positive than `a`.
    const closing = (a.vz - b.vz);
    if (!(closing < 0)) {
      failures.push(`Two sedans head-on are still closing at ${closing.toFixed(2)} m/s after the impulse.`);
    }
    // And the restitution is doing what it says: 20 % of 20 m/s of closing
    // speed comes back, so each leaves at about 2 m/s. Bounded generously --
    // what is asserted is that it is a shove and not a bounce.
    const apart = -closing;
    if (apart > 20 * DEFAULT_RESTITUTION * 1.5 + 1) {
      failures.push(`Two sedans head-on rebounded at ${apart.toFixed(2)} m/s, which is a bumper car.`);
    }
  }

  // --- 2. A T-bone spins the struck car, and the sign of the spin matches the
  //        arm. The failure here has no picture at all; see the header.
  {
    // `a` drives east (+X) into the flank of `b`, which is stationary and
    // pointing north (-Z). The contact lands **ahead** of `b`'s centre, so `b`
    // is pushed round: its nose goes east, which is to its own *right*, which
    // is a decreasing yaw and therefore a negative spin.
    const a = sedan(-3.0, -1.5, -Math.PI / 2, 12);
    const b = sedan(0, 0, 0, 0);
    const j = collide(a, b);
    if (j <= 0) {
      failures.push('A T-bone at 12 m/s produced no impulse.');
    } else if (!(b.yawRate < 0)) {
      failures.push(
        `A car T-boned ahead of its centre spun at ${b.yawRate.toFixed(3)} rad/s; the arm says it must ` +
          'turn toward its own right, which is negative. A sign error here is a shunt that slews the ' +
          'wrong way and looks exactly like physics.',
      );
    }
    // And the mirror image, which is what makes the case above a test of the
    // arm rather than of a constant: hit **behind** the centre and it spins the
    // other way.
    const c = sedan(-3.0, 1.5, -Math.PI / 2, 12);
    const d = sedan(0, 0, 0, 0);
    collide(c, d);
    if (!(d.yawRate > 0)) {
      failures.push(
        `A car T-boned behind its centre spun at ${d.yawRate.toFixed(3)} rad/s rather than the other way. ` +
          'The two halves of this pair are the whole of whether the contact arm is real.',
      );
    }
  }

  // --- 3. A car at rest struck by one at 15 m/s moves, and the striker slows.
  {
    const a = sedan(0, 2.0, 0, 15);
    const b = sedan(0, -2.2, 0, 0);
    const before = a.vz;
    const j = collide(a, b);
    if (j <= 0) failures.push('A 15 m/s rear-end produced no impulse.');
    if (!(b.vz < -0.5)) {
      failures.push(`The struck car left at ${b.vz.toFixed(2)} m/s along the hit; it should have been shoved.`);
    }
    if (!(a.vz > before)) {
      failures.push(`The striker was doing ${before.toFixed(2)} m/s and is doing ${a.vz.toFixed(2)}; it did not slow.`);
    }
  }

  // --- 4. The owner's case: a 2 t ute pushes a 1.4 t sedan further than the
  //        reverse. Measured as the separation share, which is the mass ratio
  //        made visible.
  {
    const ute = sedan(0, 2.0, 0, 0, 2100);
    const car = sedan(0, -2.2, 0, 0, 1400);
    rigidOverlap(ute, car, contact);
    rigidSeparate(ute, car, contact, push);
    const utePushed = Math.abs(push[1]);
    const carPushed = Math.abs(push[3]);
    if (!(carPushed > utePushed)) {
      failures.push(
        `Separating a ${ute.mass} kg ute from a ${car.mass} kg sedan moved the ute ${utePushed.toFixed(3)} m ` +
          `and the sedan ${carPushed.toFixed(3)} m. The lighter one has to give.`,
      );
    }
    // And the ratio is the mass ratio, not merely the right order.
    const wanted = ute.mass / car.mass;
    const got = carPushed / (utePushed > 0 ? utePushed : 1e-9);
    if (Math.abs(got - wanted) > 0.01) {
      failures.push(`The separation split ${got.toFixed(3)} against the ${wanted.toFixed(3)} mass ratio.`);
    }
  }

  // --- 5. A car against an infinite-mass box rebounds and does not penetrate.
  {
    const a = sedan(0, 2.0, 0, 20);
    const wall = sedan(0, -2.2, 0, 0);
    wall.kinematic = true;
    const j = collide(a, wall);
    if (j <= 0) failures.push('A car hitting a kinematic body produced no impulse.');
    if (wall.vx !== 0 || wall.vz !== 0 || wall.yawRate !== 0) {
      failures.push('A kinematic body was moved by being hit, which is the whole of what kinematic means.');
    }
    // Converged rather than separated-in-one, on case 1's own argument.
    for (let i = 0; i < 60; i++) {
      if (!rigidOverlap(a, wall, contact) || contact.depth <= SEPARATION_SLOP + 1e-6) break;
      collide(a, wall);
    }
    if (rigidOverlap(a, wall, contact) && contact.depth > SEPARATION_SLOP + 1e-6) {
      failures.push(`A car is still ${contact.depth.toFixed(4)} m inside the kinematic body it hit.`);
    }
    if (!(a.vz > 0)) {
      failures.push(`A car that hit a wall at 20 m/s came away at ${a.vz.toFixed(2)} m/s along the hit; it should rebound.`);
    }
  }

  // --- 6. Determinism: 200 ticks of two independent integrations from the same
  //        inputs are identical in every quantity.
  //
  //        The one that costs a session rather than a frame. Two objects rather
  //        than one run twice, so a hidden dependency on evaluation order would
  //        show up as a difference rather than being replayed identically.
  {
    const mk = (): [RigidBody, RigidBody] => {
      const a = sedan(0, 3.0, Math.PI, 14);
      const b = sedan(0.4, -2.4, 0.35, -3);
      a.yawRate = 0.6;
      b.yawRate = -0.2;
      return [a, b];
    };
    const [a1, b1] = mk();
    const [a2, b2] = mk();
    const dt = 1 / 60;
    const c1 = createRigidContact();
    const c2 = createRigidContact();
    const p1: number[] = [0, 0, 0, 0];
    const p2: number[] = [0, 0, 0, 0];
    const stepPair = (a: RigidBody, b: RigidBody, c: RigidContact, p: number[]): void => {
      if (rigidOverlap(a, b, c)) {
        rigidSeparate(a, b, c, p);
        a.x += p[0]; a.z += p[1];
        b.x += p[2]; b.z += p[3];
        rigidResolve(a, b, c);
      }
      rigidIntegrate(a, dt);
      rigidIntegrate(b, dt);
    };
    for (let i = 0; i < 200; i++) {
      stepPair(a1, b1, c1, p1);
      stepPair(a2, b2, c2, p2);
    }
    const fields: Array<keyof RigidBody> = ['x', 'z', 'dx', 'dz', 'vx', 'vz', 'yawRate'];
    for (const f of fields) {
      if (a1[f] !== a2[f] || b1[f] !== b2[f]) {
        failures.push(
          `After 200 ticks two independent integrations from the same inputs disagree about ${String(f)} ` +
            `(${String(a1[f])} against ${String(a2[f])}). Two ends that disagree about a body are a car ` +
            'that rubber-bands.',
        );
        break;
      }
    }
    // And they were actually moving, rather than agreeing about nothing: a
    // determinism check over two bodies at rest passes on any arithmetic at all.
    if (Math.abs(a1.x - 0) + Math.abs(b1.x - 0.4) < 1e-6) {
      failures.push('The determinism case never moved either body, so it proves nothing.');
    }
  }

  // --- 6b. And a knocked body comes to rest, which is what makes a loose car
  //         something that can be recycled rather than something that slides
  //         across Sydney for the rest of the session.
  {
    const a = sedan(0, 0, 0, 8);
    a.yawRate = 3;
    // `ROLLING_DECAY` is 3 m/s^2, so 8 m/s is gone in 2.67 s; three seconds is
    // the bound, and it is derived rather than chosen.
    const seconds = 8 / ROLLING_DECAY + 0.5;
    for (let i = 0; i < Math.ceil(seconds * 60); i++) rigidIntegrate(a, 1 / 60);
    if (a.vx !== 0 || a.vz !== 0) {
      failures.push(`A body knocked at 8 m/s is still doing ${Math.sqrt(a.vx * a.vx + a.vz * a.vz)} m/s after ${seconds.toFixed(1)} s.`);
    }
    if (a.yawRate !== 0) failures.push(`And still spinning at ${a.yawRate} rad/s.`);
    // It travelled the distance the decay models: v^2 / 2a, 10.7 m at 8 m/s.
    const wanted = (8 * 8) / (2 * ROLLING_DECAY);
    const went = Math.abs(a.z);
    if (Math.abs(went - wanted) > 0.5) {
      failures.push(`It rolled ${went.toFixed(2)} m against the ${wanted.toFixed(2)} m the decay models.`);
    }
  }

  // --- 7. The integrator's rotation is a rotation: a heading turned by a spin
  //        stays a unit vector, and a full circle comes back to where it began.
  {
    const b = createRigidBody();
    rigidSetHeading(b, 0);
    b.yawRate = 1;
    for (let i = 0; i < 60; i++) rigidIntegrate(b, 1 / 60, 0, 0);
    const len = Math.sqrt(b.dx * b.dx + b.dz * b.dz);
    if (Math.abs(len - 1) > 1e-9) {
      failures.push(`A heading integrated for a second is ${len} long rather than 1.`);
    }
    // One radian of spin for one second, so about a radian of yaw. The bound is
    // the first-order error the header derives, generously: `atan(w dt)` per
    // tick against `w dt` is 60 x 4.6e-6 rad over the second.
    const yaw = rigidYaw(b);
    if (Math.abs(yaw - 1) > 1e-3) {
      failures.push(`A body spinning at 1 rad/s for one second turned ${yaw.toFixed(5)} rad rather than 1.`);
    }
  }

  // --- 8. A pair with nothing between them is not a contact, which is the case
  //        every tick of every session takes.
  {
    const a = sedan(0, 0, 0, 10);
    const b = sedan(0, -20, 0, 0);
    if (rigidOverlap(a, b, contact)) failures.push('Two cars twenty metres apart were reported as touching.');
    const side = sedan(6, 0, 0, 10);
    if (rigidOverlap(a, side, contact)) failures.push('Two cars six metres apart across the road were reported as touching.');
  }

  // --- 9. **A contact that persists settles.** Section 7, and the owner's
  //        *"can vibrate between 2 spot"*.
  //
  //        Every case above this line resolves a contact **once**. The failure
  //        this file shipped with only exists on the second tick and every tick
  //        after it, so nothing above could have caught it and nothing above
  //        would catch it coming back. What is measured is convergence: the
  //        per-tick displacement along the contact normal, and how often its
  //        sign flips.
  {
    /** Below this a displacement is float noise rather than a direction. Metres. */
    const SETTLE_NOISE = 1e-5;

    /**
     * One body pressed into another for `ticks` steps, as a settling record.
     *
     * `press` is an acceleration along +Z applied to `a` every tick before the
     * contact, which is what a driver holding W against a parked car is: the
     * limit cycle needs a *sustained* push to exist at all, and a case that let
     * go after the first tick would pass on the code that produced the report.
     */
    const settle = (
      a: RigidBody,
      b: RigidBody,
      press: number,
      ticks: number,
    ): { late: number; flips: number } => {
      const dt = 1 / 60;
      let late = 0;
      let flips = 0;
      let sign = 0;
      for (let i = 0; i < ticks; i++) {
        const wasZ = a.z;
        if (press !== 0) a.vz += press * dt;
        if (rigidOverlap(a, b, contact)) {
          rigidSeparate(a, b, contact, push);
          a.x += push[0];
          a.z += push[1];
          b.x += push[2];
          b.z += push[3];
          rigidResolve(a, b, contact);
        }
        rigidIntegrate(a, dt, 0, 0);
        rigidIntegrate(b, dt, 0, 0);
        const step = a.z - wasZ;
        if (i < 60) continue;
        const mag = step < 0 ? -step : step;
        if (mag > late) late = mag;
        // Sign flips are counted down to `SETTLE_NOISE`, which is ten microns
        // and is deliberately far below anything a player could see. **The
        // amplitude is not the failure; the alternation is.** The limit cycle
        // this case exists for oscillates over 1.4 mm -- well inside the
        // centimetre bound above, and it does it four ticks out of four for the
        // rest of the session. Filtering the sign at a visible distance is how a
        // check of this shape passes on the code that produced the report.
        if (mag < SETTLE_NOISE) continue;
        const s = step > 0 ? 1 : -1;
        if (sign !== 0 && s !== sign) flips++;
        sign = s;
      }
      return { late, flips };
    };

    /** What the three cases below all want said about them. */
    const judge = (name: string, r: { late: number; flips: number }): void => {
      if (r.late >= 0.01) {
        failures.push(
          `${name}: after a second of contact the body still moves ${(r.late * 100).toFixed(2)} cm a tick. ` +
            'A contact that has settled moves under a centimetre a tick -- see rigid.ts section 7.',
        );
      }
      if (r.flips > 2) {
        failures.push(
          `${name}: the displacement along the contact normal changed sign ${r.flips} times after it should ` +
            'have settled. That is the buzz the owner reported as vibrating between two spots.',
        );
      }
    };

    // (a) A driven car nosed into a kerb car and holding the throttle. The
    //     press is `driving.DRIVE_ACCELERATION`, restated rather than imported
    //     because the dependency runs the other way.
    {
      const a = sedan(0, 0, Math.PI, 0);       // facing +Z
      const b = sedan(0, 4.5, 0, 0);           // parked nose to nose, just clear
      b.kinematic = true;
      judge('a car held against a parked one', settle(a, b, 6, 300));
    }
    // (b) The owner's own picture: a car driven into a bay between two others,
    //     where a full positional correction bounces it off one and into the
    //     next. This is the case with *two* spots in it.
    {
      // A 9.8 m bay for a 4.6 m car, so there is 30 cm of slack either side --
      // enough for a rebound to *reach* the other car, which is the whole of
      // what makes this two spots rather than one.
      const a = sedan(0, 0, Math.PI, 0);
      const front = sedan(0, 4.9, 0, 0);
      const back = sedan(0, -4.9, 0, 0);
      front.kinematic = true;
      back.kinematic = true;
      const dt = 1 / 60;
      let late = 0;
      let flips = 0;
      let sign = 0;
      for (let i = 0; i < 300; i++) {
        const wasZ = a.z;
        a.vz += 6 * dt;
        for (const other of [front, back]) {
          if (!rigidOverlap(a, other, contact)) continue;
          rigidSeparate(a, other, contact, push);
          a.x += push[0];
          a.z += push[1];
          rigidResolve(a, other, contact);
        }
        rigidIntegrate(a, dt, 0, 0);
        const step = a.z - wasZ;
        if (i < 60) continue;
        const mag = step < 0 ? -step : step;
        if (mag > late) late = mag;
        if (mag < SETTLE_NOISE) continue;
        const s = step > 0 ? 1 : -1;
        if (sign !== 0 && s !== sign) flips++;
        sign = s;
      }
      judge('a car parked in a bay between two cars', { late, flips });
    }
    // (c) And two dynamic bodies pushed together by a wall, which is the case
    //     with no kinematic body in the contact at all -- so the mass ratio,
    //     both separations and both impulses are live.
    {
      // `a` drives into `b`, and `b` has a wall 30 cm behind it: the squeeze is
      // three bodies deep, so the separation `a` gets is one `b` has to pass on.
      const a = sedan(0, 0, Math.PI, 6);
      const b = sedan(0, 5.2, Math.PI, 0);
      const wall = sedan(0, 10.1, Math.PI, 0);
      wall.kinematic = true;
      const dt = 1 / 60;
      let late = 0;
      let flips = 0;
      let sign = 0;
      for (let i = 0; i < 300; i++) {
        const wasZ = a.z;
        a.vz += 6 * dt;
        for (const pair of [[a, b], [b, wall]] as Array<[RigidBody, RigidBody]>) {
          if (!rigidOverlap(pair[0], pair[1], contact)) continue;
          rigidSeparate(pair[0], pair[1], contact, push);
          pair[0].x += push[0];
          pair[0].z += push[1];
          pair[1].x += push[2];
          pair[1].z += push[3];
          rigidResolve(pair[0], pair[1], contact);
        }
        rigidIntegrate(a, dt, 0, 0);
        rigidIntegrate(b, dt, 0, 0);
        const step = a.z - wasZ;
        if (i < 60) continue;
        const mag = step < 0 ? -step : step;
        if (mag > late) late = mag;
        if (mag < SETTLE_NOISE) continue;
        const s = step > 0 ? 1 : -1;
        if (sign !== 0 && s !== sign) flips++;
        sign = s;
      }
      judge('two cars pushed together by a wall', { late, flips });
    }
    // (d) A loose body rolling into a parked one comes to rest against it,
    //     which is the wreck half of the same rule -- and the one where the
    //     caller's own decay is running, so a residual buzz would look like
    //     the decay failing rather than like the contact failing.
    {
      const a = sedan(0, 0, Math.PI, 4);
      const b = sedan(0, 5.0, 0, 0);
      const dt = 1 / 60;
      for (let i = 0; i < 600; i++) {
        if (rigidOverlap(a, b, contact)) {
          rigidSeparate(a, b, contact, push);
          a.x += push[0];
          a.z += push[1];
          b.x += push[2];
          b.z += push[3];
          rigidResolve(a, b, contact);
        }
        rigidIntegrate(a, dt);
        rigidIntegrate(b, dt);
      }
      if (a.vx !== 0 || a.vz !== 0 || a.yawRate !== 0) {
        failures.push(
          `A loose body that rolled into a parked one is still doing (${a.vx}, ${a.vz}) m/s and ` +
            `${a.yawRate} rad/s ten seconds later. A wreck that never settles is a wreck that is never recycled.`,
        );
      }
      if (b.vx !== 0 || b.vz !== 0) {
        failures.push('And the car it hit is still rolling too, so the pair are trading a shove forever.');
      }
    }
  }

  // --- 10. The restitution threshold, in both directions. Section 7's third
  //         rule, and the half of it that has no picture is the *upper* half:
  //         a build that damped everything would have deleted the crash.
  {
    // A crawl. Perfectly inelastic, so the pair does not come apart on its own.
    const a = sedan(0, 0, Math.PI, 0.4);
    const b = sedan(0, 4.4, 0, 0);
    b.kinematic = true;
    rigidOverlap(a, b, contact);
    rigidResolve(a, b, contact);
    if (a.vz < -1e-9) {
      failures.push(
        `A car that touched a parked one at 0.4 m/s rebounded at ${(-a.vz).toFixed(4)} m/s. Under ` +
          `${RESTITUTION_SPEED} m/s a contact is inelastic -- a bounce at a crawl is the engine of the ` +
          'limit cycle rigid.ts section 7 is about.',
      );
    }
    if (a.vz > 1e-6) {
      failures.push(`...and it is still closing at ${a.vz.toFixed(4)} m/s, so the impulse did not stop it either.`);
    }
    // And a crash, which must be exactly as bouncy as it ever was.
    const c = sedan(0, 0, Math.PI, 20);
    const wall = sedan(0, 4.4, 0, 0);
    wall.kinematic = true;
    rigidOverlap(c, wall, contact);
    rigidResolve(c, wall, contact);
    const wanted = -20 * DEFAULT_RESTITUTION;
    if (Math.abs(c.vz - wanted) > 0.5) {
      failures.push(
        `A car hitting a wall at 20 m/s came away at ${c.vz.toFixed(2)} m/s rather than the ` +
          `${wanted.toFixed(2)} its restitution promises. The settling rules must not reach a crash.`,
      );
    }
  }

  // --- 11. And the contact damping is *only* on a resting contact, which is
  //         the same argument from the other side: a T-bone keeps its slew.
  {
    const a = sedan(-3.0, -1.5, -Math.PI / 2, 12);
    const b = sedan(0, 0, 0, 0);
    collide(a, b);
    const spun = b.yawRate < 0 ? -b.yawRate : b.yawRate;
    if (!(spun > 0.2)) {
      failures.push(
        `A T-bone at 12 m/s left the struck car spinning at ${spun.toFixed(3)} rad/s. Contact damping is ` +
          'for a body at rest against another; a crash that no longer slews anybody is the fix having ' +
          'eaten the feature.',
      );
    }
    // ...and a resting one does shed it, which is the rule that stops a car
    // rocking against the one it leans on.
    const c = sedan(0, 0, Math.PI, 0.3);
    c.yawRate = 1;
    const d = sedan(0, 4.4, 0, 0);
    d.kinematic = true;
    rigidOverlap(c, d, contact);
    rigidResolve(c, d, contact);
    if (!(c.yawRate < 1 - 1e-9)) {
      failures.push(
        `A car resting against another is still slewing at ${c.yawRate} rad/s after the contact. ` +
          `CONTACT_SETTLE is meant to take ${CONTACT_SETTLE} of it off every tick they touch.`,
      );
    }
  }

  return failures;
}
