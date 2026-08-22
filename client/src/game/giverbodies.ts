/**
 * Who a quest giver *is*, when nobody has drawn one yet: a kit, a heading, a
 * stance and a place in the queue for a rig.
 *
 * `world/questmarkers.ts` closes its header with the gap this file opens
 * against, and it is worth quoting because it is the whole brief:
 *
 *   > A dialog NPC in a content pack is an `(x, z)` and a radius. Nothing in
 *   > this client draws a body for one yet -- Denise is a conversation and a
 *   > prompt at a coordinate in Redfern, not a figure -- so the marker is placed
 *   > at the ground height under that coordinate plus a person's height [...]
 *   > when somebody gives the givers bodies, the height here should come off the
 *   > rig's head bone the way `main.ts` feeds the plate field.
 *
 * There are a hundred and three of them now -- Denise, the two faction handlers
 * and a hundred pool givers, "Roz, twenty-four hour tow" and "Barry, possession
 * protection officer" and the rest -- and every one is a floating exclamation
 * mark over an empty footpath. This is the **decision** half of giving them
 * bodies; `world/giverbodies.ts` is the half that draws, on the split
 * `game/characters.ts` and `world/characters.ts` already use, and for the same
 * reason: the Bun server compiles this file and must never see three.
 *
 * ---------------------------------------------------------------------------
 * NOT AN ACTOR. NOT ON THE WIRE. AND YOU CAN WALK THROUGH ONE.
 *
 * A giver is **client-side content**: there is no `NPC_KIND` byte, nothing in
 * `server/sim.ts`, no snapshot field and no collision prism. `game/characters.
 * engageable` cannot be asked about one because a giver is not a `CombatantState`
 * and never becomes one; a bat swung at Denise passes through her.
 *
 * That is a deliberate refusal and not an omission, and the argument is the one
 * `fix/invisible-wall` made from the other side: **a body you cannot push is a
 * worse invisible wall than no body at all.** A collidable giver is a 0.35 m
 * post standing in the doorway of the shop she works in, and the first thing a
 * player does with a post is try to get past it. A giver you walk through is a
 * hologram for a quarter of a second and then never thought about again --
 * which is the correct amount of attention to spend on the fact that the woman
 * at the counter is not a physics object. Nothing here may ever grow a
 * `resolve()` call without that trade being re-argued.
 *
 * The same refusal is what makes the cost claim true. A giver costs exactly one
 * more pedestrian: a pooled `CharacterActor` out of the seven kits the crowd
 * already wears, on `CharacterAssets`' shared geometry and shared material.
 * There is no new mesh, no new material and therefore **no new pipeline** --
 * which is why this feature adds nothing to `world/warmup.ts`'s parts list and
 * why `perf-harness --coverage` has nothing new to audit. The skinned-character
 * pipeline is warmed at boot by `main.ts`'s two throwaway characters, and a
 * giver's rig is that same 17-bone skeleton, that same attribute layout and that
 * same material object.
 *
 * ---------------------------------------------------------------------------
 * THE APPEARANCE IS THE ID, WHICH IS THE ONLY WAY "ROZ" CAN BE ONE PERSON
 *
 * `giverKit` is a hash of the npc id modulo `PEDESTRIAN_KIT_COUNT`, and that is
 * the whole wardrobe system. Three consequences, all wanted:
 *
 *   - Roz looks the same on every client, on every visit, and after a server
 *     restart, because nothing about her look is stored anywhere. It is
 *     recomputed, and the input is a string in a JSON file.
 *   - She looks like a **pedestrian**, because those are literally the seven
 *     kits `game/pedestrians.ts` dresses nineteen thousand walkers in. A giver
 *     who stood out by her clothes would be a second thing telling the player
 *     "quest here", and the `!` over her head already does that job better than
 *     a costume can. `DESIGN.md` rule 6: the city does not shout.
 *   - The hash is the **id**, not the index in the bundle, on `questmarkers.
 *     bobPhase`'s reasoning: the index changes the moment somebody edits a
 *     content file, and a publish would re-dress every giver in Sydney.
 *
 * `bobPhase` and `giverKit` and `giverIdlePhase` are all the same FNV-1a over
 * the same string, which is why `questmarkers` now imports `giverHash` rather
 * than keeping its own copy: the mark's bob and the body's breath are the same
 * person's number.
 *
 * ---------------------------------------------------------------------------
 * WHICH WAY A GIVER FACES, AND THE RULE IS WRITTEN DOWN HERE BECAUSE NOTHING
 * IN THE CONTENT FILES SAYS
 *
 * A `DialogNpc` has no heading. It has an `(x, z)` an author picked off a map,
 * and every one of the hundred pool givers is at an *address* -- a shopfront in
 * Erskineville, an office above a tile showroom in Artarmon, a tow yard. So the
 * heading is derived, and the rule is:
 *
 *  1. **Face the street.** The nearest point on the nearest footpath band
 *     within `FOOTPATH_PROBE_M` of the giver, and the yaw that points at it.
 *     For somebody standing at an address that is the way a player will arrive,
 *     which is the direction a person waiting for you stands facing.
 *  2. **On the footpath, face the road.** If that nearest point is within
 *     `ON_BAND_M` the giver is standing on the band and the vector to it says
 *     nothing, so the heading becomes the band's own perpendicular *toward the
 *     carriageway*. `PedBand.side` is exactly that fact -- 0 walks on the left
 *     of the way's direction of travel, so the road is the other way -- and
 *     `buildBand`'s offset sign is where the arithmetic below comes from.
 *  3. **Nothing nearby, the id decides.** No band inside the probe -- a giver in
 *     a paddock, or one whose tile has not streamed its lane sidecar yet -- and
 *     the heading is the hash quantised to sixteen compass points. It is not a
 *     *good* heading. It is a **stable** one, which is the property that
 *     actually matters: a giver who re-derived a heading every time a tile
 *     loaded would pirouette on the spot as the player walked toward her.
 *
 * Rule 3 is also why the drawing side caches the answer per id the first time a
 * band answers and never asks again.
 *
 * ---------------------------------------------------------------------------
 * THE STANCE, AND WHY THERE IS NO SECOND IDLE ANIMATION IN THIS FILE
 *
 * `player/animation.clipIdle` is already a breath, a weight shift, a sway and a
 * slow look around on four periods that do not divide each other. Writing a
 * second one here would be a different person standing next to the crowd, which
 * is the exact failure this feature is supposed to avoid. What the rig's idle
 * cannot do by itself is two things, and they are all this file adds:
 *
 *   - **Not in unison.** A pool of twelve actors built in one instant shares a
 *     clock, so twelve givers would breathe together. `giverIdlePhase` is a
 *     per-id offset in seconds that the drawing side spends once, on the frame a
 *     slot is assigned, by advancing that actor's own clock.
 *   - **Facing.** `poseGiver` turns the body toward the nearest player inside
 *     `TURN_RANGE_SCALE` times the giver's dialog radius -- so she is already
 *     looking at you by the time the `E` prompt appears -- and lets the **head
 *     lead the body** by up to `HEAD_LEAD_MAX` while the turn is in progress,
 *     which is what stops a turn reading as a turret. Out of range the body
 *     returns to its authored heading plus `swayYaw`, a two-degree weight shift
 *     on a six-second period, phased by the hash.
 *
 * The sway is a smoothed triangle rather than a sine, on `world/characters.
 * holdCup`'s grounds: this project already has one shape of cheap wave and a
 * second kind in the same build would be a second thing to reason about.
 *
 * `poseGiver` writes into a caller-owned `GiverStance` and allocates nothing;
 * `selectGivers` writes into caller-owned typed arrays and allocates nothing.
 * Both are asserted below, because "allocates nothing" is a claim no frame can
 * disprove until the session is an hour old.
 *
 * ---------------------------------------------------------------------------
 * WHO GETS A BODY: THE MARK'S OWN DECISION, ONE BEAT LATER
 *
 * The same range (`GIVER_BODY_RANGE_M` is `questmarkers.MARKER_RANGE_M`), the
 * same cap (`MAX_GIVER_BODIES` is `MAX_MARKERS`), and the same 4 Hz beat --
 * literally the same beat: `QuestMarkerField.beats` counts its own rescans and
 * the body field re-decides when that number changes, so this feature adds no
 * second clock to the frame. `world/giverbodies.ts` asserts the first two
 * against the marker field's own constants, which is the only place both are
 * importable.
 *
 * One difference, and it is not an oversight: the marker field selects givers
 * with something to *say* (`markerFor !== 'none'`) in bundle order, and this
 * selects the **nearest** givers full stop. A giver whose job you have already
 * done has no mark and still has a body, because she is still a person standing
 * in a shop. Within the cap the body set is therefore a superset of the marked
 * set, which is the property `verifyGiverBodies` asserts and the one that
 * matters: there is never a mark floating over nobody.
 */

import { BONE, FIGURE_HEIGHT, RIG } from '../player/animation.ts';
import { PEDESTRIAN_KIT_COUNT, buildBands, syntheticGrid, type PedBand } from './pedestrians.ts';
import {
  markerFor,
  parseDialogPack,
  parseQuestPack,
  questView,
  type DialogNpc,
  type PlayerFacts,
} from './questmodel.ts';

// --- Distances and counts --------------------------------------------------------

/**
 * How far a giver is worth a body, metres. `questmarkers.MARKER_RANGE_M`.
 *
 * Restated as a literal rather than imported, because that module imports three
 * and this one is compiled into the Bun server. `verifyGiverBodyField` asserts
 * the two agree, which is the relationship `world/people.HIP_Y` has with
 * `animation.HIP_HEIGHT`: checked, not shared.
 *
 * A hundred and fifty metres is also `world/characters.CHARACTER_DRAW_RADIUS`,
 * the radius the Karens and tradies are drawn to. A giver with no body at a
 * hundred metres standing beside a Karen who has one would be the one
 * inconsistency a player could actually catch.
 */
export const GIVER_BODY_RANGE_M = 150;

/**
 * How many bodies may be drawn at once. `questmarkers.MAX_MARKERS`.
 *
 * Twelve is a cap rather than a budget, and the measurement says so: over the
 * hundred and three givers in `content/dialog/`, the worst crowding anywhere in
 * Sydney is **three** within 55 m and **five** within 150 m (Wollstonecraft, and
 * a pair in Erskineville). So the pool runs at under half even at its densest
 * and the cap exists for the content nobody has written yet -- the day somebody
 * puts a dozen givers on one CBD block, this is what stops it being twelve
 * unbudgeted draw calls instead of five.
 *
 * A slot costs a `SkinnedMesh`, a `Skeleton` and seventeen `Bone`s at
 * construction, all of them cheap and none of them drawn while the slot is
 * unheld, so an empty pool is a dozen invisible objects in the scene graph and
 * no frame time at all.
 */
export const MAX_GIVER_BODIES = 12;

/**
 * How far a giver looks for a footpath to face, metres.
 *
 * Thirty. An address is set back from the street by a footpath and a shopfront,
 * which is five to fifteen metres; thirty covers a service station forecourt and
 * a tow yard without letting a giver in a park face a road two blocks away that
 * has nothing to do with where she is standing.
 */
export const FOOTPATH_PROBE_M = 30;

/**
 * Closer than this to the band and the giver is standing *on* the footpath.
 *
 * 1.2 m is a little over half `NARROW_FOOTPATH_M`, so a giver anywhere on a
 * narrow path counts as on it, and rule 2 takes over from rule 1.
 */
export const ON_BAND_M = 1.2;

/**
 * The turn-to-face range, as a multiple of the giver's own dialog radius.
 *
 * Two, so a radius-5 giver looks up at ten metres -- about four paces before the
 * `E` prompt appears. `dialog.ts` opens at the radius; being *noticed* before
 * being *promptable* is the order those two things happen in when you walk up to
 * somebody in the street, and getting it backwards would make every giver in the
 * game react a beat late.
 */
export const TURN_RANGE_SCALE = 2;

/** How fast a giver turns, radians a second. A quarter turn in two thirds of a second. */
export const TURN_RATE = 2.2;

/** How far the head may lead the body during a turn, radians. About 34 degrees. */
export const HEAD_LEAD_MAX = 0.6;

/** The idle weight shift: amplitude in radians of yaw, and its period in seconds. */
const SWAY_RAD = 0.035;
const SWAY_PERIOD = 6.1;

/**
 * How wide the per-giver idle phase is spread, seconds.
 *
 * Sixty, against `clipIdle`'s longest period of 7.3 s and the beats between its
 * four -- so two givers who happen to hash near each other are still most of a
 * cycle apart on every one of the four oscillators.
 */
const IDLE_SPREAD = 60;

// --- Where the head is -----------------------------------------------------------

/**
 * The head bone's height in the bind pose, metres, summed off the rig itself.
 *
 * Derived rather than written down, because this is the number the mark now
 * hangs off and a change to the skeleton that silently moved it would put every
 * exclamation mark in Sydney at the wrong height with nothing in either file
 * looking wrong.
 */
export const HEAD_BONE_HEIGHT =
  RIG[BONE.HIPS].rest[1] +
  RIG[BONE.SPINE].rest[1] +
  RIG[BONE.CHEST].rest[1] +
  RIG[BONE.NECK].rest[1] +
  RIG[BONE.HEAD].rest[1];

/**
 * From the head **bone** to the crown, metres.
 *
 * `BONE.HEAD`'s origin is at the base of the skull -- `world/characters.
 * verifyCharacterKit` opens with the trap that costs, a hat at a plausible 0.2
 * being dead centre inside the head -- so a mark hung off `headPosition()`
 * without this would sit in the giver's hair.
 */
export const CROWN_OVER_HEAD_BONE = FIGURE_HEIGHT - HEAD_BONE_HEIGHT;

/**
 * Clearance from the crown to the mark's baseline, metres.
 *
 * `questmarkers.MARKER_LIFT_M` was `FIGURE_HEIGHT + 0.62` and this is that
 * `0.62`, moved here so the two ways of computing the mark's height -- off a
 * body's head bone, and off the bare ground when there is no body -- are the
 * same number plus the same clearance and cannot drift apart. In the bind pose
 * they agree to a millimetre, which is what `verifyGiverBodies` asserts and what
 * makes a body appearing under an existing mark invisible rather than a jump.
 */
export const MARK_CLEARANCE_M = 0.62;

/** Where the mark floats, given the world y of a giver's head **bone**. */
export function markYFromHeadBone(headBoneY: number): number {
  return headBoneY + CROWN_OVER_HEAD_BONE + MARK_CLEARANCE_M;
}

/** ...and where it floats when there is no body, given the ground under her. */
export function markYFromGround(groundY: number): number {
  return groundY + FIGURE_HEIGHT + MARK_CLEARANCE_M;
}

// --- The id, and everything derived from it ---------------------------------------

/**
 * FNV-1a over the npc id, as an unsigned 32-bit number.
 *
 * The one hash for this feature and for `questmarkers.bobPhase`, which now calls
 * it. A string rather than an index, for that function's reason restated in the
 * header: an index is a property of the bundle and changes on a publish.
 */
export function giverHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A final avalanche over the hash, for everything derived from it below.
 *
 * FNV-1a's last operation is a multiply, and a multiply barely stirs the top
 * bits of a short string: `giverHash('a')`, `('b')` and `('c')` agree in their
 * whole top nibble, so a heading quantised off those put three givers on one
 * compass point -- which the check below caught on the first run. The *low* bits
 * are well mixed, which is why `questmarkers.bobPhase` has always been right to
 * take `h % 628` and why that function is left exactly as it was. The fix
 * belongs here, over the three derivations that want the hash to look random in
 * every bit. Murmur3's finaliser, verbatim.
 *
 * `giverHash` itself stays raw, because it is the number `bobPhase` is defined
 * as and changing it would re-phase every mark in Sydney for no reason.
 */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Which of the seven kits this giver wears. See the header.
 *
 * `PEDESTRIAN_KIT_COUNT` rather than `COLOURWAYS.length`, because that array
 * lives in a module that imports three -- and `verifyPedestrians` already
 * asserts the two are equal, which is the assertion that makes this safe.
 */
export function giverKit(id: string): number {
  return mix32(giverHash(id)) % PEDESTRIAN_KIT_COUNT;
}

/** This giver's offset into the rig's own idle cycle, seconds. See the header. */
export function giverIdlePhase(id: string): number {
  // A different slice of the mixed word from the one the kit takes, so a giver's
  // clothes and her breathing are not one fact: seven kits each with one phase
  // would be seven people rather than a hundred.
  return ((mix32(giverHash(id)) >>> 5) % 10007) * (IDLE_SPREAD / 10007);
}

/** The fallback heading: the hash, quantised to sixteen compass points. Rule 3. */
export function hashHeading(id: string): number {
  return wrapPi(((mix32(giverHash(id)) >>> 19) % 16) * ((Math.PI * 2) / 16));
}

// --- Angles ------------------------------------------------------------------------

/** An angle folded into [-pi, pi). */
export function wrapPi(a: number): number {
  const turn = Math.PI * 2;
  return a - Math.floor((a + Math.PI) / turn) * turn;
}

/**
 * The yaw that points a figure standing at `(x, z)` at `(tx, tz)`.
 *
 * Yaw 0 faces -Z, the rig's convention everywhere in this project, so the yaw
 * that sends the figure's forward to `(dx, dz)` is `atan2(-dx, -dz)` --
 * `world/characters.drive` says the same thing over the same `atan2`. A zero
 * vector returns 0 rather than a `NaN`: a `NaN` yaw is an invisible person, and
 * `game/characters.faceToward` guards it in exactly one place for that reason.
 */
export function yawToward(x: number, z: number, tx: number, tz: number): number {
  const dx = tx - x;
  const dz = tz - z;
  if (dx * dx + dz * dz < 1e-12) return 0;
  return Math.atan2(-dx, -dz);
}

/** The yaw of a unit direction. `yawToward` without the subtraction. */
export function yawOf(dx: number, dz: number): number {
  if (dx * dx + dz * dz < 1e-12) return 0;
  return Math.atan2(-dx, -dz);
}

/** `current` moved toward `target` by at most `maxStep`, the short way round. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const delta = wrapPi(target - current);
  if (delta > maxStep) return wrapPi(current + maxStep);
  if (delta < -maxStep) return wrapPi(current - maxStep);
  return wrapPi(target);
}

/**
 * A smooth wave in [-1, 1] with period 1: a triangle through a cubic ease.
 *
 * No transcendental, `world/characters.holdCup`'s argument. Smooth at the folds
 * as well, because smoothstep's derivative is zero at both ends -- a bare
 * triangle would put a corner in the body's angular velocity twice a cycle, and
 * at two degrees over six seconds that is the only part of this motion anybody
 * could notice.
 */
function wave(u: number): number {
  const f = u - Math.floor(u);
  const t = f < 0.5 ? f * 2 : 2 - f * 2;
  return t * t * (3 - 2 * t) * 2 - 1;
}

/** The idle weight shift, radians of yaw. A pure function of `(hash, t)`. */
export function swayYaw(hash: number, t: number): number {
  return SWAY_RAD * wave(t / SWAY_PERIOD + (mix32(hash) % 1024) / 1024);
}

// --- The heading -------------------------------------------------------------------

/**
 * Rules 1 and 2 of the heading, over the footpath bands near a giver.
 *
 * `null` means no band answered inside `FOOTPATH_PROBE_M` and the caller should
 * fall back to `hashHeading`. `bands` is whatever `PedestrianField.near` handed
 * back, which is a loose bounds test -- so the distance is re-checked here
 * against the real nearest point rather than trusted.
 *
 * Allocates nothing, and the drawing side caches the first answer it gets (see
 * the header on rule 3), so in practice this runs once per giver per session and
 * at worst once per giver per beat while a tile's lanes are still in flight. The
 * O(segments) walk is a few hundred iterations either way and is nowhere near
 * the profile.
 */
export function bandHeading(x: number, z: number, bands: readonly PedBand[]): number | null {
  let bestD2 = Infinity;
  let bestX = 0;
  let bestZ = 0;
  let bestUx = 0;
  let bestUz = 0;
  let bestSide = 0;
  for (const band of bands) {
    for (let i = 0; i + 1 < band.count; i++) {
      const ax = band.x[i];
      const az = band.z[i];
      const ex = band.x[i + 1] - ax;
      const ez = band.z[i + 1] - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-12 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const dx = px - x;
      const dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      bestD2 = d2;
      bestX = px;
      bestZ = pz;
      bestUx = band.ux[i];
      bestUz = band.uz[i];
      bestSide = band.side;
    }
  }
  if (bestD2 > FOOTPATH_PROBE_M * FOOTPATH_PROBE_M) return null;
  // Rule 1: set back from the path, so face it.
  if (bestD2 > ON_BAND_M * ON_BAND_M) return yawToward(x, z, bestX, bestZ);
  // Rule 2: standing on it, so face the carriageway. `buildBand` offsets a band
  // from its way by `(uz, -ux) * sign` with `sign > 0` on side 0, so the road is
  // back the other way -- `(-uz, ux)` on side 0 and its negation on side 1.
  const s = bestSide === 0 ? 1 : -1;
  return yawOf(-bestUz * s, bestUx * s);
}

// --- The stance ---------------------------------------------------------------------

/**
 * One giver's stance this instant. **Reused; never allocated per frame.**
 *
 * `yaw` is carried *in* as well as out, because the turn is rate-limited and
 * therefore has history -- which is the one thing in this file that is not a
 * pure function of `(id, t)`. What is pure is where it settles: with nobody in
 * range the yaw converges on `restYaw + swayYaw(hash, t)` from any starting
 * angle, and `verifyGiverBodies` proves it by running two different starts to
 * the same number.
 */
export interface GiverStance {
  /** Body yaw, radians. Yaw 0 faces -Z. */
  yaw: number;
  /** Head yaw *relative to the body*, radians. Written onto `BONE.HEAD`. */
  headYaw: number;
  /** Whether this giver is currently turned to a player rather than to her post. */
  engaged: boolean;
}

export function createGiverStance(restYaw = 0): GiverStance {
  return { yaw: restYaw, headYaw: 0, engaged: false };
}

/**
 * Advance one giver's stance by `dt`. Writes into `out`; allocates nothing.
 *
 * `turnRange` is `TURN_RANGE_SCALE` times the giver's own dialog radius, passed
 * in rather than recomputed so a caller with a hundred givers reads `npc.radius`
 * once on the beat instead of once a frame.
 */
export function poseGiver(
  out: GiverStance,
  hash: number,
  restYaw: number,
  x: number,
  z: number,
  playerX: number,
  playerZ: number,
  turnRange: number,
  t: number,
  dt: number,
): void {
  const dx = playerX - x;
  const dz = playerZ - z;
  const engaged = dx * dx + dz * dz <= turnRange * turnRange;
  const target = engaged ? yawToward(x, z, playerX, playerZ) : wrapPi(restYaw + swayYaw(hash, t));
  out.engaged = engaged;
  out.yaw = turnToward(out.yaw, target, TURN_RATE * (dt > 0 ? dt : 0));
  // The head leads the body through the turn and is level with it once the turn
  // has landed, so `headYaw` is simply whatever the body has not caught up on.
  const lead = wrapPi(target - out.yaw);
  out.headYaw = lead > HEAD_LEAD_MAX ? HEAD_LEAD_MAX : lead < -HEAD_LEAD_MAX ? -HEAD_LEAD_MAX : lead;
}

// --- Who gets one ----------------------------------------------------------------------

/**
 * The nearest givers in range, and how many did not fit. **Caller-owned.**
 *
 * Typed arrays sized once at construction, `questmarkers`' buffers' own
 * arrangement: a selection that ran four times a second and allocated an array
 * each time would be sixteen small arrays a second for the whole session, which
 * is not a leak and is exactly the kind of steady garbage a long session is made
 * of.
 */
export interface GiverSelection {
  /** Indices into the npc list handed to `selectGivers`, nearest first. */
  readonly index: Int32Array;
  /** Squared plan distance to each, in the same order. */
  readonly dist2: Float64Array;
  count: number;
  /** Givers inside the range that the cap turned away. Should stay at zero. */
  dropped: number;
}

export function createGiverSelection(cap: number = MAX_GIVER_BODIES): GiverSelection {
  return { index: new Int32Array(cap), dist2: new Float64Array(cap), count: 0, dropped: 0 };
}

/**
 * Fill `out` with the nearest givers within `range` of `(x, z)`.
 *
 * An insertion sort into a bounded array rather than a sort of the whole list:
 * `PedestrianCrowd.assign`'s trade, and here it is even more one-sided. The cap
 * is twelve and the bundle is a hundred and three, so the worst case is about a
 * thousand comparisons four times a second -- against a sort that would allocate
 * and would reorder equal distances differently from one beat to the next, which
 * is a giver swapping bodies with the giver beside her.
 *
 * **Nearest** rather than bundle order, which is where this deliberately differs
 * from `QuestMarkerField.rescan`; the header says why, and `verifyGiverBodies`
 * asserts the consequence that matters.
 */
export function selectGivers(
  out: GiverSelection,
  npcs: readonly DialogNpc[],
  x: number,
  z: number,
  range: number = GIVER_BODY_RANGE_M,
): void {
  const cap = out.index.length;
  const range2 = range * range;
  let count = 0;
  let dropped = 0;
  for (let n = 0; n < npcs.length; n++) {
    const npc = npcs[n];
    const dx = npc.x - x;
    const dz = npc.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > range2) continue;
    if (count === cap && d2 >= out.dist2[cap - 1]) {
      dropped++;
      continue;
    }
    // Where it lands. Strictly-greater, so equal distances keep bundle order and
    // the answer is stable from one beat to the next.
    let at = count < cap ? count : cap - 1;
    while (at > 0 && out.dist2[at - 1] > d2) {
      out.dist2[at] = out.dist2[at - 1];
      out.index[at] = out.index[at - 1];
      at--;
    }
    out.dist2[at] = d2;
    out.index[at] = n;
    if (count < cap) count++;
    else dropped++;
  }
  out.count = count;
  out.dropped = dropped;
}

// --- The self-check ---------------------------------------------------------------------

/**
 * What is wrong with a giver's body in a way no frame shows.
 *
 * Every case here is silent in this repo's sense, and four of them are the
 * reasons this file exists at all rather than the arithmetic being inlined into
 * the renderer:
 *
 *   - **An appearance that is not stable.** A kit derived from anything but the
 *     id looks completely correct in a screenshot and is a different person on
 *     the next visit, or on the player standing beside you. Nobody reports it;
 *     they just never learn who Roz is.
 *   - **A pose that is not a function of the time.** The turn has history, which
 *     is legitimate, and the way that goes wrong is that the *resting* pose
 *     inherits it -- two clients that saw a giver from different directions
 *     leave her at two different headings forever. The convergence case is the
 *     one that catches it.
 *   - **The facing rule inverted.** A giver on a footpath facing the shopfront
 *     instead of the road is a person standing with her nose against a wall, and
 *     it is one sign in one expression. Asserted against a synthetic street
 *     whose geometry is known exactly.
 *   - **The mark and the head disagreeing.** The whole point of this feature for
 *     `questmarkers.ts` is that the mark now comes off a head, and the failure is
 *     not that it vanishes -- it is that it moves by a few centimetres on the
 *     beat a body appears, or by half a metre if the crown offset is forgotten.
 *   - **The cap not holding**, which writes past the end of a typed array and is
 *     silent, exactly as it is one file over.
 *   - **A mark with nobody under it**: a giver inside the marker range that the
 *     body selection turned away while there was still room. That is the one
 *     property tying the two features together and the only one that would show
 *     up as a floating `!` over an empty footpath -- which is the thing this
 *     whole workstream was asked to remove.
 */
export function verifyGiverBodies(): string[] {
  const failures: string[] = [];

  // --- The hash, and everything hung off it.
  if (giverHash('roz-bondi') !== giverHash('roz-bondi')) failures.push('The giver hash is not stable for one id.');
  if (giverHash('roz-bondi') === giverHash('roz-bondj')) {
    failures.push('Two ids one character apart hash the same; every giver on the street would be twins.');
  }
  if (giverKit('a') !== giverKit('a')) failures.push('A giver’s kit is not stable; she changes clothes between visits.');
  {
    // Every kit reachable, and none outside the wardrobe. A modulo of a hash
    // that quietly returned a negative number would index `COLOURWAYS[-3]`.
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const kit = giverKit(`giver-${i}`);
      if (!Number.isInteger(kit) || kit < 0 || kit >= PEDESTRIAN_KIT_COUNT) {
        failures.push(`giverKit returned ${kit}, outside the ${PEDESTRIAN_KIT_COUNT} kits a pedestrian wears.`);
        break;
      }
      seen.add(kit);
    }
    if (seen.size < PEDESTRIAN_KIT_COUNT) {
      failures.push(`Four hundred givers wore only ${seen.size} of the ${PEDESTRIAN_KIT_COUNT} kits.`);
    }
  }
  {
    let spread = 0;
    for (let i = 0; i < 64; i++) {
      const phase = giverIdlePhase(`giver-${i}`);
      if (!(phase >= 0 && phase < IDLE_SPREAD)) {
        failures.push(`An idle phase of ${phase} s is outside the ${IDLE_SPREAD} s spread.`);
        break;
      }
      if (phase > spread) spread = phase;
    }
    // Every giver on one phase is a street of people breathing in time, which is
    // the single thing that would give the pool away.
    if (spread < IDLE_SPREAD * 0.5) failures.push(`Sixty-four givers spread their idle over only ${spread.toFixed(1)} s.`);
    if (giverIdlePhase('a') !== giverIdlePhase('a')) failures.push('The idle phase is not stable per id.');
  }
  {
    // Sixteen compass points, and a hundred givers should reach most of them.
    // This is the case that caught `mix32`'s absence: without the avalanche,
    // "a", "b" and "c" all faced the same way.
    const points = new Set<number>();
    for (let i = 0; i < 128; i++) points.add(hashHeading(`giver-${i}`));
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) points.add(hashHeading(id));
    if (points.size < 12) failures.push(`A hundred and thirty-six ids used only ${points.size} of the 16 compass points.`);
    if (new Set(['a', 'b', 'c'].map(hashHeading)).size === 1) {
      failures.push('Three one-character ids share a heading; the hash is not avalanched before it is quantised.');
    }
  }
  for (const id of ['a', 'roz', 'centrelink-clerk', 'zzz']) {
    const h = hashHeading(id);
    if (!(h >= -Math.PI && h < Math.PI)) failures.push(`The fallback heading for "${id}" is ${h}, outside [-pi, pi).`);
  }

  // --- The angle helpers, which every other rule here is built out of.
  for (const a of [0, 1, -1, Math.PI, -Math.PI, 7, -7, 100]) {
    const w = wrapPi(a);
    if (!(w >= -Math.PI && w < Math.PI)) failures.push(`wrapPi(${a}) is ${w}, outside [-pi, pi).`);
    if (Math.abs(Math.sin(w) - Math.sin(a)) > 1e-9) failures.push(`wrapPi(${a}) is not the same angle.`);
  }
  // Yaw 0 faces -Z. Somebody due north of a giver -- toward -Z -- is straight ahead.
  if (Math.abs(yawToward(0, 0, 0, -10)) > 1e-9) failures.push('A giver does not face yaw 0 toward -Z.');
  // A rotation of `yaw` about +Y sends the figure's forward to `(-sin yaw, -cos
  // yaw)`, so facing +X is a **negative** quarter turn. Getting this sign
  // backwards is a city of givers standing with their backs to the street, and
  // it is the one thing here that reads correctly in prose either way.
  if (Math.abs(wrapPi(yawToward(0, 0, 10, 0) + Math.PI / 2)) > 1e-9) {
    failures.push('The yaw toward +X is not a negative quarter turn; the facing sign is inverted.');
  }
  if (yawToward(3, 3, 3, 3) !== 0) failures.push('A degenerate facing did not return 0; a NaN yaw is an invisible person.');
  // The short way round, and across the seam: 3.0 to -3.0 is 0.28 rad *forward*
  // through pi, not 6.0 rad backward.
  if (Math.abs(wrapPi(turnToward(3.0, -3.0, 0.1) - 3.1)) > 1e-9) {
    failures.push('A turn across the -pi seam went the long way round.');
  }
  if (Math.abs(turnToward(0, 0.2, 1) - 0.2) > 1e-9) failures.push('A turn overshot a target inside one step.');
  if (Math.abs(turnToward(0, 3, 0.25) - 0.25) > 1e-9) failures.push('A rate-limited turn did not take exactly one step.');

  // --- The sway: bounded, smooth and not in unison.
  {
    let min = Infinity;
    let max = -Infinity;
    let prev = swayYaw(7, 0);
    for (let i = 1; i <= 2000; i++) {
      const t = i * 0.02;
      const v = swayYaw(7, t);
      if (v < min) min = v;
      if (v > max) max = v;
      if (Math.abs(v - prev) > SWAY_RAD * 0.2) failures.push(`The sway jumped ${(v - prev).toFixed(4)} rad in 20 ms.`);
      prev = v;
    }
    if (max > SWAY_RAD + 1e-9 || min < -SWAY_RAD - 1e-9) failures.push(`The sway reaches ${max}, outside its amplitude.`);
    if (max - min < SWAY_RAD) failures.push('The sway barely moves; a giver would be a statue.');
    if (swayYaw(giverHash('a'), 3) === swayYaw(giverHash('b'), 3)) {
      failures.push('Two givers sway in unison; the phase is not derived from the id.');
    }
  }

  // --- The stance: pure in `(id, t)` where it settles, and no allocation.
  {
    const rest = 1.1;
    const hash = giverHash('erko-nella');
    const a = createGiverStance(-2.9);
    const b = createGiverStance(2.9);
    // Ten seconds of frames with nobody anywhere near, from two opposite starts.
    for (let i = 1; i <= 600; i++) {
      const t = i / 60;
      poseGiver(a, hash, rest, 0, 0, 9000, 9000, 10, t, 1 / 60);
      poseGiver(b, hash, rest, 0, 0, 9000, 9000, 10, t, 1 / 60);
    }
    if (Math.abs(wrapPi(a.yaw - b.yaw)) > 1e-9) {
      failures.push('Two givers with the same id settled at different headings; the resting pose keeps history.');
    }
    if (Math.abs(wrapPi(a.yaw - (rest + swayYaw(hash, 10)))) > 1e-6) {
      failures.push('A settled giver is not at her authored heading plus the sway.');
    }
    if (a.engaged) failures.push('A giver with the player nine kilometres away is engaged.');
    if (Math.abs(a.headYaw) > 1e-6) failures.push('A settled giver’s head is not level with her body.');

    // And the turn: a player inside twice the radius is looked at, head first.
    const want = yawToward(0, 0, 8, 0);
    const c = createGiverStance(0);
    poseGiver(c, hash, 0, 0, 0, 8, 0, 10, 0, 1 / 60);
    if (!c.engaged) failures.push('A player 8 m from a radius-5 giver did not engage her; the 2x range is wrong.');
    if (Math.abs(c.yaw) >= Math.PI / 2) failures.push('A giver snapped the whole way round in one frame; the turn is not rate-limited.');
    if (Math.abs(c.headYaw) < 1e-3) failures.push('The head does not lead the body into the turn.');
    if (Math.sign(c.headYaw) !== Math.sign(wrapPi(want - c.yaw))) failures.push('The head leads away from the player.');
    if (Math.abs(c.headYaw) > HEAD_LEAD_MAX + 1e-9) failures.push(`The head leads by ${c.headYaw} rad, past the clamp.`);
    for (let i = 0; i < 300; i++) poseGiver(c, hash, 0, 0, 0, 8, 0, 10, i / 60, 1 / 60);
    if (Math.abs(wrapPi(c.yaw - want)) > 1e-6) failures.push('A giver never finished turning to the player.');
    if (Math.abs(c.headYaw) > 1e-6) failures.push('The head is still leading after the body caught up.');
    // Twelve metres is past 2 x 5, and she goes back to her post.
    poseGiver(c, hash, 0, 0, 0, 12, 0, 10, 5, 1 / 60);
    if (c.engaged) failures.push('A player 12 m from a radius-5 giver still holds her attention.');

    // Allocation, asserted by structure: the stance a caller holds is the stance
    // it keeps, and nothing is attached to it on the way through.
    const keys = Object.keys(a).sort().join(',');
    if (keys !== 'engaged,headYaw,yaw') failures.push(`A stance carries ${keys}; something is being attached per frame.`);
  }

  // --- The heading, against a street whose geometry is known exactly.
  {
    const tile = syntheticGrid();
    if (tile === null) failures.push('The synthetic street fixture did not encode; the heading rule is untested.');
    else {
      const bands = buildBands(tile, () => 1);
      if (bands.length === 0) failures.push('The synthetic street produced no footpath bands.');
      // `syntheticGrid`'s first way runs due north (dz = -300) from x = 0, so its
      // footpaths lie 5.4 m either side of x = 0 -- half the carriageway, the
      // kerb, and half the path -- and the road is between them. Due east is
      // +X, which is a yaw of -pi/2; see the sign note above.
      const EAST = -Math.PI / 2;
      const setBack = bandHeading(-12, -150, bands);
      if (setBack === null) failures.push('A giver 12 m from a street found no footpath at all.');
      else if (Math.abs(wrapPi(setBack - EAST)) > 0.2) {
        failures.push(`A giver set back west of a north-south street faces ${setBack.toFixed(2)} rad, not east.`);
      }
      // ...and one standing on that western footpath faces the road, which is
      // still east. Rule 2, and it is the sign that is being tested: get
      // `PedBand.side` backwards and she faces the shopfront.
      const onPath = bandHeading(-(3.75 + 0.15 + 1.5), -150, bands);
      if (onPath === null) failures.push('A giver standing on a footpath found no band under her.');
      else if (Math.abs(wrapPi(onPath - EAST)) > 0.2) {
        failures.push(`A giver on the western footpath faces ${onPath.toFixed(2)} rad, not east toward the road.`);
      }
      // The eastern footpath of the same street faces the other way, or the
      // perpendicular has no sign in it at all.
      const eastSide = bandHeading(3.75 + 0.15 + 1.5, -150, bands);
      if (eastSide !== null && onPath !== null && Math.abs(wrapPi(eastSide - onPath)) < 1) {
        failures.push('Both footpaths of one street face the same way; the side sign is not read.');
      }
      // Rule 3's precondition: nothing within the probe, and the caller is told so.
      if (bandHeading(6000, 6000, bands) !== null) {
        failures.push('A giver six kilometres from the nearest street was still handed a footpath heading.');
      }
    }
  }

  // --- Who gets a body: nearest first, the cap, and the mark that must not float.
  {
    const npc = (id: string, x: number, z: number): DialogNpc =>
      parseDialogPack(
        {
          npcs: [
            {
              id,
              x,
              z,
              radius: 5,
              nodes: [{ id: 'hello', line: 'gday', choices: [{ text: 'the job', accept: 'j' }] }],
            },
          ],
        },
        'fixture',
      ).value.npcs[0];

    const sel = createGiverSelection();
    selectGivers(sel, [], 0, 0);
    if (sel.count !== 0 || sel.dropped !== 0) failures.push('An empty bundle selected somebody.');

    // Deliberately out of order in the bundle, so bundle order cannot pass this.
    const scattered = [npc('far', 90, 0), npc('near', 4, 0), npc('mid', 40, 0), npc('gone', 600, 0)];
    selectGivers(sel, scattered, 0, 0);
    if (sel.count !== 3) failures.push(`Three givers in range selected ${sel.count}.`);
    if (sel.count === 3 && (scattered[sel.index[0]].id !== 'near' || scattered[sel.index[2]].id !== 'far')) {
      failures.push('The selection is not nearest-first; it is bundle order.');
    }
    for (let i = 1; i < sel.count; i++) {
      if (sel.dist2[i] < sel.dist2[i - 1]) failures.push('The selection is not sorted by distance.');
    }
    if (sel.dropped !== 0) failures.push(`${sel.dropped} givers were dropped with room to spare.`);

    // The cap, and that it keeps the *nearest* rather than the first it met. A
    // write past the end of a typed array is silent, which is why this is here.
    const crowd: DialogNpc[] = [];
    for (let i = MAX_GIVER_BODIES + 6; i >= 0; i--) crowd.push(npc(`n${i}`, (i + 1) * 3, 0));
    selectGivers(sel, crowd, 0, 0);
    if (sel.count !== MAX_GIVER_BODIES) failures.push(`${crowd.length} givers filled ${sel.count} of ${MAX_GIVER_BODIES} slots.`);
    if (sel.dropped !== crowd.length - MAX_GIVER_BODIES) {
      failures.push(`${crowd.length} givers over a ${MAX_GIVER_BODIES} cap dropped ${sel.dropped}.`);
    }
    if (sel.count === MAX_GIVER_BODIES && crowd[sel.index[0]].id !== 'n0') {
      failures.push('The cap kept the first givers it met rather than the nearest.');
    }
    if (sel.index.length !== MAX_GIVER_BODIES || sel.dist2.length !== MAX_GIVER_BODIES) {
      failures.push('The selection buffers were resized; the whole point is that they are not.');
    }

    // **No mark over an empty footpath.** Every giver the marker field would
    // mark, inside the shared range and under the shared cap, has a body.
    const quests = parseQuestPack(
      { quests: [{ id: 'j', giver: 'a', level: 1, steps: [{ kind: 'ko', count: 1 }] }] },
      'fixture',
    ).value.quests;
    const view = questView(quests, {});
    const facts: PlayerFacts = { level: 1, faction: '', story: new Set(), cash: 0 };
    const marked = [npc('a', 30, 0), npc('b', 10, 0), npc('c', GIVER_BODY_RANGE_M + 20, 0)];
    selectGivers(sel, marked, 0, 0);
    const bodied = new Set<string>();
    for (let i = 0; i < sel.count; i++) bodied.add(marked[sel.index[i]].id);
    for (const person of marked) {
      const dx = person.x;
      const dz = person.z;
      if (dx * dx + dz * dz > GIVER_BODY_RANGE_M * GIVER_BODY_RANGE_M) continue;
      if (markerFor(person, facts, view) === 'none') continue;
      if (!bodied.has(person.id)) failures.push(`"${person.id}" is marked inside the range and has no body under the mark.`);
    }
  }

  // --- The mark's height, which is the contract with `world/questmarkers.ts`.
  if (Math.abs(HEAD_BONE_HEIGHT - 1.25) > 1e-9) {
    failures.push(`The head bone is at ${HEAD_BONE_HEIGHT} m; the rig moved and every mark in Sydney moved with it.`);
  }
  if (!(CROWN_OVER_HEAD_BONE > 0.2 && CROWN_OVER_HEAD_BONE < 0.7)) {
    failures.push(`The crown is ${CROWN_OVER_HEAD_BONE} m over the head bone, which is not a head.`);
  }
  {
    // A giver standing on ground `g` has her head bone at `g + HEAD_BONE_HEIGHT`
    // in the bind pose, and the two ways of siting the mark must agree there --
    // or a mark jumps on the beat a body appears under it.
    const g = 12.5;
    const fromHead = markYFromHeadBone(g + HEAD_BONE_HEIGHT);
    const fromGround = markYFromGround(g);
    if (Math.abs(fromHead - fromGround) > 1e-9) {
      failures.push(`A mark sits at ${fromHead} m off a head and ${fromGround} m off the ground; it would jump.`);
    }
    if (fromHead - (g + FIGURE_HEIGHT) < 0.2) failures.push('The mark is less than 20 cm over the crown; it is in her hair.');
    // A head bone lowered -- crouched, or lying down -- takes the mark with it.
    if (markYFromHeadBone(g + 0.4) >= fromHead) failures.push('The mark does not follow the head bone down.');
  }

  return failures;
}
