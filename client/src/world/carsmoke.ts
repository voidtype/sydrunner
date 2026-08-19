/**
 * Smoke out of a broken bonnet, and black smoke out of a dead one.
 *
 * The picture for the bottom two bands of `game/driving.ts`' crash damage: a car
 * under `CAR_SMOKING_HEALTH` smokes grey and one that has been written off
 * smokes black. Everything else about the damage is a deformation and a paint
 * tone (`world/cars.crumpleScale`, `crumpleTone`) and reads at fifty metres;
 * this is the part that reads at two hundred, and it is the part that tells a
 * player across the street that the car by the kerb is not just parked badly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TWELVE QUADS AND NOT A PARTICLE SYSTEM.
 *
 * `world/swatpuff.ts` refused to introduce a general emitter for an effect that
 * happens a few times a minute, and this refuses it again for the opposite
 * reason: a smoke plume is not an *event*, it is a *state*, and the thing a
 * state needs is to be cheap forever rather than cheap once. A pooled emitter
 * with lifetimes and a sorted transparent draw would be a per-frame CPU walk
 * over hundreds of quads for as long as a wreck stands in the street -- and the
 * budget says a room may have four hundred wrecks standing in the street.
 *
 * So a plume is **one `InstancedMesh` of one quad**, `PUFFS_PER_CAR` instances
 * per smoking car, and the animation is a closed form: puff `k` of car `c` is at
 * a height and a size and an opacity that are pure functions of
 * `(hash(identity, k), time)`. There is no per-puff state anywhere, nothing is
 * born and nothing dies, and the whole rig is one draw call however many cars
 * are burning.
 *
 * `world/vegetation.ts` makes the same move for the same reason and
 * `game/traffic.ts`'s header states the general principle in one line: a lookup,
 * not a simulation.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BILLBOARDED WHERE THE SWAT PUFF IS NOT.
 *
 * `swatpuff.ts` chose a 3D spike burst over a billboard, and gave the reason:
 * it marks a *point in space* and two players either side of it should be told
 * the same thing about where it is. Smoke is the other case. It is a *volume*
 * seen against the sky, it has no shape a player could be wrong about, and the
 * one thing it must never do is turn edge-on and vanish -- which is precisely
 * what a fixed quad does when you drive past it. So the quads face the camera,
 * and the cost is a `lookAt` per frame on one object rather than per instance:
 * the mesh is oriented as a whole and the instances are laid out in its local
 * plane.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT ADDITIVE.
 *
 * The other departure from `swatpuff.ts`, and the reason is the same one that
 * file gives from the other side: a puff is a *flash*, which is light, and this
 * is soot, which is the absence of it. Additive black is invisible. So it is a
 * plain alpha blend with `depthWrite` off, the colour is a grey the sky can be
 * seen through, and the write-off variant is nearly black -- which against a
 * sunlit Sydney sky (Y' 247, `world/contact.ts` measured it) is the highest
 * contrast this renderer can produce without a second material.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE FLAMES *ARE* A SECOND MATERIAL, WHEN THE SOOT IS NOT.
 *
 * `add` below accepts one visible compromise -- the last written-off car in a
 * frame decides the plume colour for all of them -- on the grounds that a second
 * WebGPU pipeline compiled at the moment somebody writes a car off is a hitch on
 * a frame the player is watching. The fire (workstream Y) does not get the same
 * answer, and the difference is the *blend*.
 *
 * Smoke is an alpha blend of a dark colour: grey and soot are two points on one
 * ramp and one material can be walked between them. A flame is **additive
 * light**, which is the opposite operation -- `world/bike.buildBikeGlow`'s whole
 * argument -- and there is no colour you can put in an alpha-blended material
 * that reads as fire against a sunlit Sydney sky. So there is a second
 * `InstancedMesh` with an additive orange material, built in the same
 * constructor and therefore reached by `world/warmup.ts`' scene walk before the
 * first frame, which is what makes it free at the moment it is first needed.
 *
 * Additive is also the reason there is no point light in this feature. The brief
 * asked for "a flickering point light at night"; a real light in this renderer
 * is a per-car cost and a budget negotiation with `world/nightlights.ts`, and an
 * additive quad is *already* a thing that is a tint at noon and a glow at dusk
 * with no day/night term anywhere. That is the lime bike marker's exact
 * argument, applied to a fire. What is genuinely lost is that a burning car does
 * not light the wall beside it, and that is a thing only an eye can judge.
 *
 * ---------------------------------------------------------------------------
 * AND THEN AN EYE JUDGED IT. WHAT THE PARAGRAPH ABOVE GOT RIGHT AND WRONG.
 *
 * It was right that the light does not belong *here*, and it is not here: the
 * budget negotiation it refused to have has now been had, in the one file that
 * is allowed to have it. `world/nightlights.ts` owns two `PointLight`s for
 * burning cars, constructed at boot with every other real light and held at zero
 * intensity when nothing is alight -- which is the only shape a light in this
 * renderer may take, because the *set* of lights is in every material's cache
 * key and one that appeared when a car caught fire would recompile the scene on
 * the frame it caught. See that file's header, at length.
 *
 * What this file contributes is the half nightlights cannot know: **which cars
 * are on fire and where they are.** `add` is already handed every driven car in
 * view once a frame together with its burn level, so the list is free -- it is
 * written into `fireAt` on the same pass that places the tongues, and
 * `nearestFires` hands the nearest few to the rig on the `LampSource` pattern.
 * The alternative was a second sweep over the car field with its own idea of
 * which cars were burning, which is the "a plume hanging over an empty parking
 * space" failure this file's `add` comment already argues about.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD SET: WHAT IS LEFT WHERE A CAR WENT OFF.
 *
 * A scorch mark on the road and a scatter of debris, both hung off the same
 * `booms` list and drawn by the same new material. Three decisions in it:
 *
 *   - **They are here rather than in `world/teamlook.ts`,** which is where the
 *     shockwave ring is drawn. The ring is there because the *ring pool* is
 *     there -- `TeamRingField` already existed and a shockwave is a shockwave --
 *     and nothing else about a car bomb has anything to do with teams. A mark on
 *     the road and a chunk of bonnet are what a burning car leaves behind, which
 *     is this file's subject; putting them here also means they ride the
 *     `begin`/`end` bracket `world/drivencars.ts` already runs every frame, so
 *     the whole feature costs `main.ts` one `scene.add` and one call on the
 *     event -- there is no sweep, no list and no expiry over there to get out of
 *     step with the one in here.
 *   - **One mesh, one material, one geometry, for both of them.** A scorch is a
 *     soft-edged disc lying flat and 1.75 m across; a chunk of car is the same
 *     disc billboarded at the camera and 8 cm across. That is one instance pool
 *     and one draw call for the entire aftermath of an explosion, and it is
 *     worth spending triangles on: a chunk drawn as a disc is sixty triangles
 *     where a quad would be two, and sixty triangles is not a number this
 *     renderer can measure -- where a *second material* is a second pipeline,
 *     which is the only cost `world/warmup.ts` and every material comment in
 *     this project are actually about. `verifyCarSmoke` holds the whole set to
 *     four thousand triangles at once.
 *   - **Black, alpha-blended, and faded per instance through an instanced float
 *     attribute.** `world/contact.ts` builds most of this material for the
 *     building skirts -- `colorNode` pinned to black, `opacityNode` off
 *     `vertexColor().w` -- and the one thing it does not need is a per-instance
 *     strength. There is exactly one way to have that here and it is worth
 *     naming, because the obvious route does not work: `instanceColor` is a
 *     **vec3 multiplied into the diffuse**, which fades an additive ring
 *     beautifully -- `teamlook.TeamRingField` rides precisely that -- and can do
 *     nothing whatever for an alpha-blended black mark, whose visibility is
 *     entirely in its alpha and not at all in its colour. So the fade is its own
 *     `InstancedBufferAttribute` read through `instancedBufferAttribute()`,
 *     which is not an exotic path but the identical one three itself uses to
 *     deliver `instanceColor` (`three/src/nodes/accessors/Instance.js`), one
 *     type narrower.
 *   - **The scorch is a lookup off the age and nothing else,** exactly as the
 *     plume is a lookup off the clock: there is no per-mark animation state, a
 *     mark is a position and an age, and the fade is `scorchFade(age)`. Debris
 *     goes further and is a pure function of *(the blast's position, the chunk
 *     index, the age)* -- see `debrisChunk` -- so two players either side of a
 *     car park watch the same fourteen chunks land in the same fourteen places,
 *     which is `game/traffic.ts`' determinism rule applied to a thing nobody
 *     sends.
 */

import { instancedBufferAttribute, vec3, vertexColor } from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { carHash, type CarPose } from '../game/traffic.ts';
// The grading -- how fast the plume runs and whether it is soot -- comes from
// the three-free rules file, so the four systems that draw a damaged car cannot
// disagree about what "smoking" means. See `game/driving.damageGrade`.
import { SMOKE_RATE_DEAD, createDamageGrade, damageGrade } from '../game/driving.ts';
// --- WORKSTREAM Y: how thick a burning bonnet smokes. The flame *shape* is this
// file's; the rate is the rules', so the plume, the wreck's pose and the crackle
// cannot disagree about how far along a fire is. See `game/carfire.ts`.
//
// The four that arrived with the scorch and the debris are the same bargain: how
// wide the mark is, how long it lasts, and how many chunks come off for how long
// are all facts about *the explosion*, and the explosion's rules live in the
// three-free file so that the ring, the mark and the blast cannot disagree.
import {
  BURN_SMOKE_RATE,
  DEBRIS_COUNT,
  DEBRIS_LIFE_S,
  SCORCH_M,
  SCORCH_S,
} from '../game/carfire.ts';

/**
 * How many puffs stand in one car's plume.
 *
 * Twelve, which is enough for a column that reads as continuous at walking pace
 * and few enough that a room at the four-hundred-car budget with a dozen wrecks
 * in view is 144 instances -- one draw call and a rounding error on a frame that
 * already places two hundred cars.
 */
const PUFFS_PER_CAR = 12;

/**
 * How many smoking cars can be drawn at once.
 *
 * 24, against `world/nightlights.CAR_BRAKE_CAPACITY`'s 48 and for its argument:
 * the cars that smoke are the cars a *player* crashed, the wire caps the players
 * a client can see at forty, and a client with two dozen burning cars in one
 * frame is looking at a scene nobody will construct twice. Over the cap the
 * newest are simply not drawn, which is the right failure -- a plume missing
 * from the twenty-fifth wreck at the back of a pile is not a thing anybody can
 * notice.
 */
const MAX_SMOKING_CARS = 24;

/** How long one puff takes to rise and fade, seconds. */
const PUFF_LIFE = 2.2;

/** How far it rises in that time, metres, and how far it drifts sideways. */
const PUFF_RISE = 3.4;
const PUFF_DRIFT = 0.9;

/** Its size at birth and at the end, metres. Smoke expands as it cools. */
const PUFF_SIZE_FROM = 0.35;
const PUFF_SIZE_TO = 1.5;

/** Peak opacity of one puff. Low, because twelve of them overlap. */
const PUFF_ALPHA = 0.34;

/**
 * Where the plume comes out, as a fraction of the body's half-length forward of
 * the centre, and how high.
 *
 * 0.72 puts it at the front of the bonnet rather than at the bumper, which is
 * where an engine is, and 0.9 m is bonnet height on a sedan -- `CAR_BODY_SIZE`
 * has the real heights but a plume that started at the exact roof line of a van
 * and the exact bonnet line of a hatch would be a difference nobody could
 * attribute, and `NOSE_REACH` in `game/driving.ts` refuses a per-body number for
 * the identical reason.
 */
const VENT_FORWARD = 0.72;
const VENT_HEIGHT = 0.9;

/**
 * How many flame tongues lick one burning bonnet.
 *
 * Eight against the plume's twelve, and fewer on purpose: a flame is bright and
 * short where a puff is faint and tall, so eight overlapping additive quads
 * inside a metre read as a fire where eight faint ones would read as a smudge.
 * At the cap that is 192 instances in one extra draw call.
 */
const FLAMES_PER_CAR = 8;

/** How high a tongue licks, metres, and how far it wanders doing it. A bonnet fire. */
const FLAME_RISE = 1.1;
const FLAME_DRIFT = 0.35;

/**
 * Its size at birth and at the top of its rise, metres.
 *
 * **Shrinking, where a puff of smoke grows.** That is the whole difference
 * between the two effects and it is physics rather than taste: smoke expands as
 * it cools and a flame narrows as it is consumed. Getting it the wrong way round
 * makes a fire look like brown smoke lit orange.
 */
const FLAME_SIZE_FROM = 0.62;
const FLAME_SIZE_TO = 0.16;

/** How long one tongue takes to rise and go out, seconds. Fast: fire is not smoke. */
const FLAME_LIFE = 0.45;

/**
 * Peak brightness of one tongue. Additive, so these stack -- eight at 0.5 is a
 * white core with orange edges, which is what a fire looks like.
 */
const FLAME_ALPHA = 0.5;

/** Orange, linear. Hot enough to bloom, not so hot it reads as a torch. */
const FLAME_COLOUR: [number, number, number] = [1.0, 0.42, 0.08];

/** Grey, for a car that is merely broken. Linear, and light enough to see sky through. */
const SMOKE_GREY: [number, number, number] = [0.42, 0.42, 0.44];
/** And soot, for a write-off. Not pure black: nothing in this renderer is. */
const SMOKE_BLACK: [number, number, number] = [0.06, 0.06, 0.07];

// --- What a car leaves behind --------------------------------------------------------

/**
 * How many scorch marks are on the ground at once. The brief's 24.
 *
 * The same number `MAX_SMOKING_CARS` is, arrived at separately and worth stating
 * separately: a plume is capped at two dozen because a client cannot see more
 * than two dozen burning cars at once and be looking at a scene anybody will
 * construct twice, and a *mark* is capped at two dozen because it outlives the
 * car by thirty seconds. Those are different arguments about different clocks
 * that happen to land on the same number, and tying them together with one
 * constant would mean a change to either quietly retuning the other.
 *
 * Over the cap the **oldest goes**, which is the opposite of the plume's rule
 * one screen up, and the difference is the whole reason to say so: the
 * twenty-fifth plume in a frame is one nobody can pick out of a pile, so
 * refusing the newcomer is free. A mark is the record of an explosion the player
 * probably just watched, so the newest is the one they are looking for and the
 * oldest is the one that has already faded to a smudge. See `boom`.
 */
const MAX_SCORCH = 24;

/** The scorch's radius, from the diameter the rules state. See `carfire.SCORCH_M`. */
const SCORCH_R = SCORCH_M / 2;

/**
 * How the disc is built: segments round, and where the soft edge starts.
 *
 * Twenty segments at 1.75 m of radius is a 55 cm chord, which is under the
 * resolution of a mark whose whole edge is a gradient -- nobody can see the
 * polygon in a shape with no hard boundary. The core fraction is where the
 * gradient begins: inside 0.52 of the radius the mark is at full strength and
 * from there it runs to nothing at the rim, so the read is a dark centre with no
 * edge at all rather than a dark disc with one, which is the difference between
 * a burn and a manhole cover.
 *
 * Sixty triangles a mark (a fan plus a ring of quads) and 1,440 at the cap, in
 * one draw call. `teamlook.TRI_BUDGET` is the standard being kept to here: the
 * tent is ~170 triangles and there are four of them, and this is that order.
 */
const SCORCH_SEGMENTS = 20;
const SCORCH_CORE = 0.52;

/**
 * How dark the middle of a fresh mark is, as display alpha over the road.
 *
 * Not 1. A scorch is soot on asphalt and asphalt is already dark; a mark at full
 * black would be a hole in the road, which is the exact artefact
 * `world/contact.ts` tunes `CONTACT_GAIN` down to 0.55 to avoid on a surface
 * that is genuinely occluded. 0.62 is a shade stronger than that because a burn
 * is a real deposit rather than an ambient-occlusion approximation, and because
 * this one has to read on grass and on a footpath as well as on tarmac.
 */
const SCORCH_ALPHA = 0.62;

/**
 * How far the mark floats over the ground, metres, on top of the polygon offset.
 *
 * Both, and neither is redundant. The **lift** covers the disagreement between
 * where the client thinks the ground is and where the road deck was actually
 * laid -- `world/street.ts` floats the carriageway 0.02 m over the terrain, so a
 * mark placed at the terrain height is under the road it is meant to be on. The
 * **polygon offset** covers what a lift cannot: depth quantisation at distance,
 * which `street.ts` measures at under one depth step by about 180 m, at which
 * point a 4 cm lift has stopped being a number the depth buffer can represent.
 * `world/contact.ts` carries the whole derivation and uses the same -8.
 */
const SCORCH_LIFT = 0.04;

/**
 * How many explosions can have debris in the air at once.
 *
 * Three, against the marks' twenty-four, and the ratio is the two clocks: a
 * chunk is airborne for `DEBRIS_LIFE_S` (0.9 s) where a mark lies there for
 * `SCORCH_S` (30). Three overlapping explosions inside nine hundred milliseconds
 * is a chain reaction in a car park -- which this feature can produce, see
 * `carfire.CHAIN_M` -- and the fourth simultaneous one losing its chunks while
 * keeping its ring, its plume and its mark is not a thing anybody can notice.
 *
 * The cap is applied to **chunks rather than to explosions**, which is a shade
 * more generous than the name and is the right way round: three simultaneous
 * bangs fill it exactly, and a fourth arriving a few hundred milliseconds later
 * picks up whatever slots the first one's chunks have already landed and
 * vacated, rather than being refused by a counter that has not caught up.
 */
const DEBRIS_BOOMS = 3;

/**
 * A chunk's size, metres **across**. A wing mirror at the bottom, a door card at
 * the top.
 *
 * A diameter rather than a radius for `carfire.SCORCH_M`'s reason -- every
 * dimension a person could pace out is stated as a width in this feature -- and
 * the one halving lives where the disc is scaled, next to the scorch's own.
 */
const DEBRIS_SIZE_MIN = 0.09;
const DEBRIS_SIZE_MAX = 0.22;

/**
 * How hard a chunk is thrown: metres per second out, and metres per second up.
 *
 * The vertical range is the one that matters and it is chosen *against the
 * gravity below* rather than for its own sake: at `DEBRIS_GRAVITY` a chunk
 * thrown up at `u` is in the air for `2u/g` and reaches `u²/2g`, so 5.0 to
 * 7.5 m/s is a flight of 0.59 to 0.88 s over an apex of 0.74 to 1.65 m. Every
 * one of them is back on the road inside `DEBRIS_LIFE_S`, so the effect ends by
 * *finishing* rather than by fading out mid-arc -- "landing and gone" is the
 * brief's phrase and this is the arithmetic that makes it literal -- and the
 * lowest of them still clears a bonnet, which is the floor `verifyCarSmoke`
 * holds it to.
 *
 * The horizontal spread puts the far chunks 8 or 9 m out, which is a little past
 * `carfire.BLAST_M` -- debris outruns the blast that threw it, and a chunk
 * landing beyond the ring is the one part of this that says the explosion had a
 * direction rather than a radius.
 */
const DEBRIS_SPEED_MIN = 3.5;
const DEBRIS_SPEED_MAX = 10;
const DEBRIS_UP_MIN = 5.0;
const DEBRIS_UP_MAX = 7.5;

/**
 * The gravity a chunk falls under, m/s². **Not 9.8**, and not an error.
 *
 * 17 is most of twice earth's, which is the oldest trick in game animation and
 * is here for a specific reason rather than out of habit: a chunk on a real
 * ballistic arc that reaches 3 m of height hangs there for most of a second, and
 * an explosion whose debris *floats* reads as weightless polystyrene. Heavier
 * gravity with a harder throw gives the same height in half the time, which is
 * what a piece of steel looks like. `player/controller.ts` makes the identical
 * departure for the same reason and states it in the same words.
 */
const DEBRIS_GRAVITY = 17;

/** Where in a chunk's life it starts to fade, as a fraction of `DEBRIS_LIFE_S`. */
const DEBRIS_FADE_FROM = 0.7;

/**
 * Slots in the one instance pool the marks and the debris share.
 *
 * Every mark that can be on the ground plus every chunk that can be in the air,
 * added rather than maxed: the two are simultaneous by construction -- an
 * explosion writes a mark *and* fourteen chunks on the same frame -- so a pool
 * sized at the larger of them would drop the debris of the twenty-fifth bang
 * and, worse, would do it silently.
 */
const MARK_CAPACITY = MAX_SCORCH + DEBRIS_BOOMS * DEBRIS_COUNT;

/** Scratch for `damageGrade`. Asked once per smoking car per frame; never allocated. */
const _grade = /*#__PURE__*/ createDamageGrade();

/** One flat quad, one metre across, centred on its own origin. */
function puffGeometry(): BufferGeometry {
  const h = 0.5;
  const position = new Float32Array([
    -h, -h, 0, h, -h, 0, h, h, 0,
    -h, -h, 0, h, h, 0, -h, h, 0,
  ]);
  const normal = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  const g = new BufferGeometry();
  g.name = 'car_smoke';
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  return g;
}

/**
 * The scorch disc: radius 1 in the XZ plane, facing up, with the soft edge in
 * the **alpha of its vertex colour**.
 *
 * Radius 1 so that an instance's scale *is* its radius in metres, which is
 * `teamlook.ringGeometry`'s bargain and is what lets one geometry serve a mark
 * of any size. The colour attribute is a `vec4` and only its `w` is ever read:
 * `world/contact.ts` builds the same pair -- a black `colorNode` and an
 * `opacityNode` off `vertexColor().w` -- for the building skirts, and the reason
 * is the same one here. A soft edge is a *gradient in coverage*, and putting it
 * in the alpha means it costs one attribute rather than a texture, a fragment
 * function or a second mesh.
 *
 * Three rings of vertices and not two: the centre point, a core ring at
 * `SCORCH_CORE` still at full alpha, and the rim at zero. A plain fan from the
 * centre to a zero-alpha rim would be a cone -- darkest at one *point* -- and
 * would read as a splat rather than as a burn. The flat core is what makes it a
 * mark with a soft edge.
 *
 * **Double-sided**, deliberately, where `contact.ts` is not: a flat disc laid on
 * ground that slopes can be seen from below at its downhill edge, exactly as
 * `teamlook.TeamRingField`'s rings can, and a single-sided one disappears in
 * patches there. The two-pass cost `contact.ts` measured is bought off with
 * `forceSinglePass` on the material, which is safe here for the reason it is not
 * safe there: this disc never overlaps itself, so there is no back-to-front
 * ordering within it to get wrong.
 */
function scorchGeometry(): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const colour: number[] = [];
  const index: number[] = [];

  const push = (x: number, z: number, alpha: number): void => {
    position.push(x, 0, z);
    normal.push(0, 1, 0);
    // The RGB is white and unread -- the material pins the colour to black and
    // takes only `w`. Written as white rather than as black so that a future
    // material that *did* read the colour would draw a visible disc rather than
    // an invisible one, which is the same "fail loud" argument `contact.ts`
    // makes about `vertexColor()`'s fallback.
    colour.push(1, 1, 1, alpha);
  };

  push(0, 0, 1);
  for (let i = 0; i < SCORCH_SEGMENTS; i++) {
    const a = (i / SCORCH_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    push(c * SCORCH_CORE, s * SCORCH_CORE, 1);
    push(c, s, 0);
  }

  for (let i = 0; i < SCORCH_SEGMENTS; i++) {
    const j = (i + 1) % SCORCH_SEGMENTS;
    // 0 is the centre; core and rim of segment `i` are at 1 + 2i and 2 + 2i.
    const ci = 1 + i * 2;
    const ri = 2 + i * 2;
    const cj = 1 + j * 2;
    const rj = 2 + j * 2;
    index.push(0, ci, cj);
    index.push(ci, ri, rj, ci, rj, cj);
  }

  const g = new BufferGeometry();
  g.name = 'car_scorch';
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colour), 4));
  g.setIndex(new BufferAttribute(new Uint16Array(index), 1));
  return g;
}

/**
 * How much of a scorch mark is left, `age` seconds after the car went off.
 *
 * 1 at the bang, 0 at `carfire.SCORCH_S`, and a **smoothstep** between rather
 * than a straight line. The shape is doing one job: a linear fade spends its
 * last second going from "faint" to "gone" at a rate the eye tracks, and a mark
 * that visibly *switches off* thirty seconds after an explosion is the kind of
 * thing a player reports as flickering. Easing at both ends means the mark holds
 * near full for the first few seconds -- while the wreck is still the thing
 * being looked at -- and then thins out of existence with no last frame.
 *
 * Pure, exported and swept by `verifyCarSmoke`: it is the whole of "the mark
 * fades", and every way of getting it wrong renders a perfectly good frame.
 */
export function scorchFade(ageS: number): number {
  if (!(ageS > 0)) return 1;
  if (ageS >= SCORCH_S) return 0;
  const t = ageS / SCORCH_S;
  // `3t² - 2t³`, which is flat at both ends. No `Math.pow`: two multiplies, on
  // `game/traffic.ts`' rule about closed forms with no transcendental in them.
  return 1 - t * t * (3 - 2 * t);
}

/** What is left of a chunk `age` seconds in: full, then linear out over the tail. */
export function debrisFade(ageS: number): number {
  if (!(ageS > 0)) return 1;
  if (ageS >= DEBRIS_LIFE_S) return 0;
  const t = ageS / DEBRIS_LIFE_S;
  if (t <= DEBRIS_FADE_FROM) return 1;
  return 1 - (t - DEBRIS_FADE_FROM) / (1 - DEBRIS_FADE_FROM);
}

/** Where one chunk is, relative to the centre of the blast. See `debrisChunk`. */
export interface DebrisChunk {
  /** Metres east and south of the blast, and metres above it. */
  dx: number;
  dy: number;
  dz: number;
  /** How big the chunk is, metres. Constant over its life: a lump does not grow. */
  size: number;
  /** False once it has landed or its life has run out. A landed chunk is not drawn. */
  alive: boolean;
}

export function createDebrisChunk(): DebrisChunk {
  return { dx: 0, dy: 0, dz: 0, size: 0, alive: false };
}

/**
 * Chunk `k` of the blast identified by `seed`, `age` seconds after it went off.
 *
 * **A pure function of three integers and a clock**, which is the property the
 * whole thing is built around: `seed` is a hash of the blast's *position*, the
 * position comes off the wire quantised, and every client therefore hashes the
 * same integer and watches the same fourteen chunks land in the same fourteen
 * places. That is `game/traffic.ts`' determinism rule -- ambient things are pure
 * functions of `(anchor, index, tick)` -- applied to a thing nobody sends.
 *
 * The direction is drawn as **two hashed components and a normalise, not an
 * angle**, and that is the one line here worth explaining. An azimuth would want
 * `Math.cos`/`Math.sin`, which is exactly what the determinism rule tells this
 * project not to lean on across processes; `Math.sqrt` is exactly rounded by
 * IEEE 754 on every engine there is, so a normalised pair of hashed floats is
 * bit-identical everywhere in a way a trig call is not promised to be. It is
 * also the same trick `add` already uses for the plume's drift, one loop up.
 *
 * Fills `out` and returns it: called `DEBRIS_COUNT` times per live blast per
 * frame and must not allocate.
 */
export function debrisChunk(seed: number, k: number, ageS: number, out: DebrisChunk): DebrisChunk {
  const h = carHash(seed, 0x2b17 + k);
  const size = DEBRIS_SIZE_MIN + unit(carHash(h, 5)) * (DEBRIS_SIZE_MAX - DEBRIS_SIZE_MIN);
  out.size = size;

  let dirX = unit(carHash(h, 1)) * 2 - 1;
  let dirZ = unit(carHash(h, 2)) * 2 - 1;
  const length = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (length > 1e-6) {
    dirX /= length;
    dirZ /= length;
  } else {
    // A hash that lands on the origin has no direction. Straight up the +X axis
    // rather than a divide by zero, on `carfire.applyBlastHit`'s own epsilon
    // argument: an arbitrary but *stable* answer is the one that is the same on
    // both clients, and a NaN is a chunk that vanishes on one of them.
    dirX = 1;
    dirZ = 0;
  }

  const speed = DEBRIS_SPEED_MIN + unit(carHash(h, 3)) * (DEBRIS_SPEED_MAX - DEBRIS_SPEED_MIN);
  const up = DEBRIS_UP_MIN + unit(carHash(h, 4)) * (DEBRIS_UP_MAX - DEBRIS_UP_MIN);

  const t = ageS > 0 ? ageS : 0;
  const height = up * t - 0.5 * DEBRIS_GRAVITY * t * t;
  out.dx = dirX * speed * t;
  out.dz = dirZ * speed * t;
  out.dy = height;
  // Gone the moment it is back on the road, which is what "landing and gone"
  // means and is why the throw above is tuned so that every chunk gets there
  // inside its own life. A chunk that outlived its arc would sink through the
  // tarmac, which is the one failure a closed-form ballistic can have.
  out.alive = height > 0 && ageS < DEBRIS_LIFE_S;
  return out;
}

/** Scratch for the debris loop. One per process; `end` fills it and reads it back. */
const _chunk = /*#__PURE__*/ createDebrisChunk();

const _position = /*#__PURE__*/ new Vector3();
const _scale = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _matrix = /*#__PURE__*/ new Matrix4();
const _facing = /*#__PURE__*/ new Object3D();
/** The identity rotation, for a mark that lies flat and is never turned. */
const _flat = /*#__PURE__*/ new Quaternion();
/**
 * Squared distances of whatever `nearestFires` has written into its caller's
 * buffer so far, so the insertion does not have to recompute them.
 *
 * Eight rather than `nightlights.FIRE_REAL_COUNT`'s two, because a scratch sized
 * from another file's constant is a crash the day that file changes and this one
 * is not rebuilt. `nearestFires` never writes past `max`, and `verifyCarSmoke`
 * asserts that a caller asking for more than this gets clamped rather than
 * scribbling.
 */
const _fireDistance = /*#__PURE__*/ new Float64Array(8);
/** The most any one caller may ask `nearestFires` for. See `_fireDistance`. */
const MAX_FIRE_QUERY = 8;

/** `carHash` as a 0..1 float. `traffic.unit`, which is not exported. */
function unit(h: number): number {
  return h / 4294967296;
}

/**
 * Every smoking car's plume, as one instanced quad set.
 *
 * One of these, owned by `main.ts`, added to the scene once and fed from
 * `world/drivencars.DrivenCarView.update` -- which is the loop that already
 * poses every driven car every frame, on `world/cars.TrafficMovers`' own
 * argument about the headlights and the models: the car you see smoking has to
 * be the car that is there, and a second pass that had to *agree* with the first
 * is how you end up with a plume hanging over an empty parking space.
 *
 * `begin`/`add`/`end` is `CarLightSink`'s bracket, deliberately, so the two
 * behave the same way at the call site.
 */
export class CarSmoke {
  readonly mesh: InstancedMesh;
  /**
   * WORKSTREAM Y: the flames, as a second additive set. Added to the scene by
   * the same caller that adds `mesh` -- one more line in `main.ts` and one more
   * draw call. See the header for why this is a second material where the soot
   * is not.
   */
  readonly flames: InstancedMesh;
  /**
   * The scorch marks **and** the debris: the third set, and the only one in
   * this file that is an *event* rather than a state. Added to the scene by the
   * same caller that adds the other two.
   *
   * One mesh for both, which is the header's third section: a mark is a disc
   * lying flat and a chunk is the same disc billboarded and a twentieth of the
   * size, so they are one pool, one draw and one pipeline.
   */
  readonly marks: InstancedMesh;
  /** Cars smoking last frame. The dev overlay, and `verifyCarSmoke`. */
  drawn = 0;
  /** ...and cars *burning* last frame, which is a subset of them. */
  alight = 0;
  /** Scorch marks on the ground after the last `end()`. For the console and the check. */
  scorched = 0;
  /** ...and chunks of car in the air. */
  flying = 0;

  private readonly geometry: BufferGeometry;
  private readonly material: MeshBasicNodeMaterial;
  private readonly flameMaterial: MeshBasicNodeMaterial;
  private readonly markGeometry: BufferGeometry;
  private readonly markMaterial: MeshBasicNodeMaterial;
  /**
   * The per-instance fade, 0 to 1, one float per slot of `marks`.
   *
   * Its own attribute rather than the instance colour, and the header's third
   * section is the argument: a black mark's whole visibility is its alpha, and
   * `instanceColor` cannot reach an alpha. Read by the material through
   * `instancedBufferAttribute`, written by `writeMarks`, uploaded once a frame.
   */
  private readonly markFade: InstancedBufferAttribute;
  private count = 0;
  private flameCount = 0;

  /**
   * Every explosion still worth drawing: where it was, the hash its debris is
   * scattered from, and how long ago.
   *
   * An array of records rather than a parallel `Float32Array`, on the grounds
   * that it is at most twenty-four entries touched once a frame and that
   * `world/teamlook.TentSpec` sets the precedent for a handful of live props
   * being a plain list. The *instances* are packed into typed buffers, which is
   * where the count actually matters.
   */
  private readonly booms: Array<{ x: number; y: number; z: number; seed: number; age: number }> = [];

  /**
   * Where the burning cars were on the last completed frame -- x, y, z each --
   * and how many there were. The half of the night light `world/nightlights.ts`
   * cannot work out for itself; see `nearestFires` and the header.
   */
  private readonly fireAt = new Float32Array(MAX_SMOKING_CARS * 3);
  private fireCount = 0;
  /** The same, being filled by this frame's `add` calls. Swapped in by `end`. */
  private readonly fireFilling = new Float32Array(MAX_SMOKING_CARS * 3);
  private fireFilled = 0;
  /** Seconds since the rig was built. The plume's whole clock. */
  private clock = 0;
  /** Which way the camera is looking, for the billboard. See the header. */
  private readonly toCamera = new Vector3(0, 0, 1);

  constructor() {
    // **First**, because the mark material's `opacityNode` closes over it and a
    // node built against `undefined` is a shader that never compiles. Dynamic
    // usage because it is rewritten every frame a mark is on the road.
    this.markFade = new InstancedBufferAttribute(new Float32Array(MARK_CAPACITY), 1);
    this.markFade.setUsage(DynamicDrawUsage);

    this.geometry = puffGeometry();
    const material = new MeshBasicNodeMaterial();
    material.name = 'car_smoke';
    material.transparent = true;
    // No depth write, so twelve overlapping puffs do not carve holes in each
    // other -- `swatpuff.ts` and `world/contact.ts` both set this flag for the
    // same reason and state it in the same words: an overlay is not a surface.
    material.depthWrite = false;
    // **Normal and not additive.** See the header: additive black is nothing at
    // all, and the whole point of a write-off's plume is that it is dark.
    material.blending = NormalBlending;
    material.side = DoubleSide;
    // Fogged, unlike every other overlay in this renderer, and it is the one
    // flag here that is not `swatpuff.ts`'s. Smoke *is* atmosphere: a plume two
    // hundred metres away that stayed at full contrast while the building behind
    // it faded would read as a decal on the lens.
    material.fog = true;
    material.toneMapped = true;
    material.opacity = PUFF_ALPHA;
    material.color.setRGB(SMOKE_GREY[0], SMOKE_GREY[1], SMOKE_GREY[2]);
    this.material = material;

    this.mesh = new InstancedMesh(this.geometry, material, MAX_SMOKING_CARS * PUFFS_PER_CAR);
    this.mesh.name = 'car_smoke';
    this.mesh.count = 0;
    // Culled by the draw radius the poses already came through, not by a
    // bounding sphere that would have to be recomputed every frame. Every
    // instanced set in this project says this.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Visible at construction so `world/warmup.ts`'s scene walk reaches it and
    // compiles the pipeline before the first frame -- `CarLights`' constructor
    // carries the whole paragraph about why an invisible set is skipped by
    // three's `_projectObject` in `compileAsync` exactly as it is in `render`.
    this.mesh.visible = true;

    // --- The flames. The same quad and the same billboard, additively blended
    // and with no fog: fire is light, and a light source that faded into the
    // distance haze the way its own smoke does would read as being *behind*
    // the smoke. `world/bike.buildBikeGlow` makes the same two calls for the
    // same reason.
    const flame = new MeshBasicNodeMaterial();
    flame.name = 'car_flame';
    flame.transparent = true;
    flame.depthWrite = false;
    flame.blending = AdditiveBlending;
    flame.side = DoubleSide;
    flame.fog = false;
    flame.toneMapped = true;
    flame.opacity = FLAME_ALPHA;
    flame.color.setRGB(FLAME_COLOUR[0], FLAME_COLOUR[1], FLAME_COLOUR[2]);
    this.flameMaterial = flame;
    this.flames = new InstancedMesh(this.geometry, flame, MAX_SMOKING_CARS * FLAMES_PER_CAR);
    this.flames.name = 'car_flames';
    this.flames.count = 0;
    this.flames.frustumCulled = false;
    this.flames.castShadow = false;
    this.flames.receiveShadow = false;
    // Over the world's opaque geometry and under the smoke, so a tongue is
    // drawn *inside* the plume rising off it rather than over the top of it.
    this.flames.renderOrder = 5;
    this.flames.visible = true;

    // --- The marks. One material, one geometry and one mesh for the scorch and
    // the debris both; see the header's third section for the whole argument.
    const mark = new MeshBasicNodeMaterial();
    mark.name = 'car_mark';
    mark.transparent = true;
    // Black, with everything in the alpha. `world/contact.ts` line for line, and
    // for its reason: a scorch is soot and a chunk of car seen against a Sydney
    // sky is a silhouette, and neither of them has a colour worth carrying.
    mark.colorNode = vec3(0, 0, 0);
    // The soft edge (per vertex) times the fade (per instance). Two attributes
    // and a multiply, because the two terms live on different things: the shape
    // of a mark is the same for every mark and the strength of one is not.
    mark.opacityNode = vertexColor().w.mul(instancedBufferAttribute(this.markFade, 'float'));
    // A decal on a surface that has already established this pixel's depth, so
    // it must not write: two marks overlapping in a car park after a chain
    // reaction have to composite rather than one of them punching a hole in the
    // other. `contact.ts` argues the same point about two building skirts.
    mark.depthWrite = false;
    mark.blending = NormalBlending;
    // Two-sided but one pass. See `scorchGeometry` for why both halves of that
    // are needed and why it is safe here where `contact.ts` decided it was not.
    mark.side = DoubleSide;
    mark.forceSinglePass = true;
    // Fogged, like the smoke and unlike the flames: a mark on the road three
    // hundred metres away that stayed at full contrast while the road faded
    // would read as a decal on the lens rather than as soot on the tarmac.
    mark.fog = true;
    mark.toneMapped = true;
    // The depth bias, which is the whole reason a mark laid on a road is visible
    // at all past a hundred metres. -8 is `world/contact.ts`' number against the
    // same problem: eight depth quanta scales with the precision it is
    // correcting for, where a metric lift does not. It costs the debris nothing
    // -- a chunk in the air is nowhere near anything to fight with.
    mark.polygonOffset = true;
    mark.polygonOffsetUnits = -8;
    mark.polygonOffsetFactor = 0;
    this.markMaterial = mark;

    this.markGeometry = scorchGeometry();
    this.marks = new InstancedMesh(this.markGeometry, mark, MARK_CAPACITY);
    this.marks.name = 'car_marks';
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.marks.castShadow = false;
    this.marks.receiveShadow = false;
    // Under the team rings (`teamlook` uses 6) and level with the flames: a mark
    // is the ground the whole event happened on, and everything else about a car
    // bomb belongs over the top of it.
    this.marks.renderOrder = 4;
    this.marks.visible = true;
    this.marks.instanceMatrix.setUsage(DynamicDrawUsage);
  }

  /**
   * A car went off here. Leaves a mark and throws fourteen chunks.
   *
   * Called once, on the `TEAM_EVENT_KIND.CARBOOM` that arrives with the wreck's
   * removal -- an event, where everything else this class draws is a state. That
   * asymmetry is the reason the ageing lives in `begin` and not in the caller:
   * `main.ts` files the bang and never thinks about it again, exactly as it
   * files a `hud.notice`.
   *
   * `y` is the **ground**, not the car's roof: the mark is laid on it and the
   * debris is thrown from it. The caller passes its own ground query rather than
   * the wire's decimetre `y` for `teamlook.TentSet.set`'s reason -- a mark 5 cm
   * under the road is a mark nobody ever sees.
   *
   * At the cap the **oldest** goes; see `MAX_SCORCH` for why this is the
   * opposite of the plume's rule.
   */
  boom(x: number, y: number, z: number): void {
    if (this.booms.length >= MAX_SCORCH) this.booms.shift();
    // The seed is the *position*, quantised to a decimetre before it is hashed.
    // Quantising is what makes it survive the wire: two clients decode the same
    // `TEAM_EVENT` to the same coordinates, and rounding first means that even a
    // one-ULP difference between two decoders cannot land them on two different
    // integers and therefore on two different scatters. See `debrisChunk`.
    const seed = carHash(Math.round(x * 10) | 0, Math.round(z * 10) | 0);
    this.booms.push({ x, y, z, seed, age: 0 });
  }

  /**
   * The nearest burning cars to `(x, y, z)`, for the night rig's two real
   * lights. `world/nightlights.FireSource`, implemented.
   *
   * The list is last frame's, which is the one thing worth knowing at the call
   * site: `main.ts` updates the night rig before it poses the driven cars, so
   * the fire this answers with caught somewhere in the previous sixteen
   * milliseconds of wall clock. That is the same staleness the torch mount
   * already accepts one call up, and for a light that is being flickered at 9 Hz
   * anyway it is not a thing that exists.
   *
   * A selection sort into `out` rather than a sort of the candidates, because
   * `max` is two and the candidate list is at most `MAX_SMOKING_CARS`: 48
   * comparisons and no allocation beats any arrangement that builds a list.
   */
  nearestFires(x: number, y: number, z: number, radius: number, out: Float32Array, max: number): number {
    let written = 0;
    const wanted = max > MAX_FIRE_QUERY ? MAX_FIRE_QUERY : max;
    const limit = radius * radius;
    for (let i = 0; i < this.fireCount; i++) {
      const fx = this.fireAt[i * 3];
      const fy = this.fireAt[i * 3 + 1];
      const fz = this.fireAt[i * 3 + 2];
      const dx = fx - x;
      const dy = fy - y;
      const dz = fz - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > limit) continue;
      // Where in the (short) sorted output this one belongs.
      let slot = written;
      while (slot > 0 && d2 < _fireDistance[slot - 1]) slot--;
      if (slot >= wanted) continue;
      // Shuffle the ones behind it down, dropping whatever falls off the end.
      for (let j = Math.min(written, wanted - 1); j > slot; j--) {
        _fireDistance[j] = _fireDistance[j - 1];
        out[j * 3] = out[(j - 1) * 3];
        out[j * 3 + 1] = out[(j - 1) * 3 + 1];
        out[j * 3 + 2] = out[(j - 1) * 3 + 2];
      }
      _fireDistance[slot] = d2;
      out[slot * 3] = fx;
      out[slot * 3 + 1] = fy;
      out[slot * 3 + 2] = fz;
      if (written < wanted) written++;
    }
    return written;
  }

  /**
   * Start a frame. `cameraX/Y/Z` is where the view is, for the billboard.
   *
   * `dt` is the **frame** delta and not the fixed step, on `main.ts`'s standing
   * rule about presentation: the simulation is fixed so prediction and rewind
   * agree, and a plume has to rise smoothly at whatever rate the display runs.
   */
  begin(dt: number, cameraX: number, cameraY: number, cameraZ: number): void {
    this.clock += dt;
    this.count = 0;
    this.flameCount = 0;
    this.fireFilled = 0;
    this.toCamera.set(cameraX, cameraY, cameraZ);

    // The explosions age here rather than in `end`, so that a mark filed by
    // `boom` on this very frame is drawn at age 0 rather than at one frame old.
    // Walked backwards because the expired ones are spliced out as they are
    // found, which is `main.ts`' own sweep of the shockwave list.
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      b.age += dt;
      if (b.age >= SCORCH_S) this.booms.splice(i, 1);
    }
  }

  /**
   * One smoking car's plume. Nothing at all for a car that is not smoking, which
   * is every car in Sydney bar the two or three somebody has crashed.
   *
   * The threshold is the **rules'** and is asked here rather than trusted from
   * the caller: `damageGrade(...).smoke` is zero for anything above
   * `driving.CAR_SMOKING_HEALTH`, faster for a write-off, and is the same
   * function the box fleet, the model fleet and the headlights grade off. A
   * caller that asked for a plume on an undamaged car gets nothing and costs one
   * comparison.
   */
  add(pose: CarPose, burn = 0): void {
    // **Before the counter**, which is the one ordering that matters here: both
    // the count and the instance block are packed front to back, and a car that
    // took the early return after claiming a slot would leave twelve unwritten
    // instances inside `mesh.count` -- last frame's matrices, which is a plume
    // hanging over a street where a wreck used to be.
    //
    // WORKSTREAM Y: a burning car smokes at `carfire.BURN_SMOKE_RATE` rather
    // than at the damage grade's rate, and the choice is a `Math.max` rather
    // than a branch so that a fire can only ever make a plume *thicker*. A fire
    // that thinned the smoke on a car that was already a write-off would read as
    // the wreck recovering, which is `verifyDamageGrade`'s monotonicity argument
    // arriving from a third direction.
    const graded = damageGrade(pose.damage, _grade).smoke;
    const rate = burn > 0 && BURN_SMOKE_RATE > graded ? BURN_SMOKE_RATE : graded;
    if (!(rate > 0)) return;
    if (this.count >= MAX_SMOKING_CARS) return;
    const car = this.count;
    this.count = car + 1;

    // The vent, at the front of the bonnet. Local +X is the nose, which is the
    // convention every other consumer of a `CarPose` uses.
    const reach = pose.halfLength * VENT_FORWARD;
    const vx = pose.x + pose.dx * reach;
    const vz = pose.z + pose.dz * reach;
    const vy = pose.y + VENT_HEIGHT;

    // Face the camera. One quaternion for the whole plume rather than one per
    // puff: twelve quads within two metres of each other, seen from at least
    // ten, are indistinguishable from twelve individually-aimed ones and this is
    // one `lookAt` instead of twelve.
    _facing.position.set(vx, vy, vz);
    _facing.lookAt(this.toCamera);
    _quaternion.copy(_facing.quaternion);

    for (let k = 0; k < PUFFS_PER_CAR; k++) {
      // **The whole animation, as a pure function.** Puff `k` is offset around
      // the cycle by a per-puff constant drawn from the car's identity, so two
      // wrecks side by side do not pulse in step -- and so that a car that goes
      // out of range and comes back resumes exactly where it would have been,
      // which is the brief's "no pop" clause applied to the smoke.
      const seed = carHash(pose.identity, 0x5307 + k);
      const phase = unit(seed);
      // `%` on a positive double is exact, and there is no `Math.sin` here for
      // `game/traffic.ts`'s determinism reason -- not that this is on the
      // simulation path, but because a closed form with no transcendental in it
      // is also the cheap one, twelve times per car per frame.
      // The plume runs at the rate the *rules* set for this much damage -- a
      // write-off's fire is faster than a broken engine's leak -- so the loop
      // period is `SMOKE_RATE_DEAD / rate` times the nominal life rather than a
      // constant. See `driving.SMOKE_RATE_BROKEN`.
      const life = PUFF_LIFE * (SMOKE_RATE_DEAD / rate);
      const t = ((this.clock / life) + phase) % 1;
      const rise = t * PUFF_RISE;
      // The drift is a fixed direction per puff rather than a wind: this project
      // has no wind, and a plume that all leaned the same way would need one.
      const dirX = unit(carHash(seed, 1)) * 2 - 1;
      const dirZ = unit(carHash(seed, 2)) * 2 - 1;
      const size = PUFF_SIZE_FROM + (PUFF_SIZE_TO - PUFF_SIZE_FROM) * t;
      _position.set(vx + dirX * PUFF_DRIFT * t, vy + rise, vz + dirZ * PUFF_DRIFT * t);
      // Fades in over the first tenth and out over the rest, so nothing ever
      // appears or disappears at the vent -- which is the one artefact a
      // closed-form loop can produce and the reason the alpha is baked into the
      // *scale* rather than into a per-instance colour this material does not
      // have: a puff at zero size is a puff nobody can see, and it costs no
      // second attribute.
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      _scale.setScalar(size * fade);
      _matrix.compose(_position, _quaternion, _scale);
      this.mesh.setMatrixAt(car * PUFFS_PER_CAR + k, _matrix);
    }

    // --- WORKSTREAM Y: the flames, on the plume's own closed form and at the
    // same vent, with three numbers changed.
    //
    // The loop is deliberately the same shape rather than a second effect: a
    // tongue is a puff that is faster (`FLAME_LIFE` against `PUFF_LIFE`),
    // shorter (`FLAME_RISE`) and *narrows* as it rises instead of spreading --
    // see `FLAME_SIZE_FROM`. Everything else -- the per-instance phase off the
    // car's identity, the billboard quaternion, the "no pop" property of a
    // closed form -- is inherited, which is what makes a burning car's fire
    // resume where it would have been when the car comes back into range.
    //
    // The seed is offset from the smoke's `0x5307` so the tongues are not in
    // lockstep with the puffs above them.
    // --- And the fire's *position*, for the night rig. Recorded at the vent,
    // which is where the tongues are drawn -- a real light at the centre of the
    // car would be under the bonnet lighting the engine block, and the whole
    // point of a light for a burning car is the wall it throws on. Filled on
    // this pass rather than by a second sweep for the reason the plume itself is
    // filled here; see the header's second section.
    if (burn > 0 && this.fireFilled < MAX_SMOKING_CARS) {
      const slot = this.fireFilled;
      this.fireFilled = slot + 1;
      this.fireFilling[slot * 3] = vx;
      this.fireFilling[slot * 3 + 1] = vy;
      this.fireFilling[slot * 3 + 2] = vz;
    }

    if (burn > 0 && this.flameCount < MAX_SMOKING_CARS) {
      const flameSlot = this.flameCount;
      this.flameCount = flameSlot + 1;
      for (let k = 0; k < FLAMES_PER_CAR; k++) {
        const seed = carHash(pose.identity, 0x7f1a + k);
        const phase = unit(seed);
        const t = (this.clock / FLAME_LIFE + phase) % 1;
        const dirX = unit(carHash(seed, 1)) * 2 - 1;
        const dirZ = unit(carHash(seed, 2)) * 2 - 1;
        // Spread across the bonnet rather than all out of one point, because a
        // fire is a surface burning and a plume is a hole venting.
        const spreadX = (unit(carHash(seed, 3)) * 2 - 1) * pose.halfWidth * 0.7;
        const spreadZ = (unit(carHash(seed, 4)) * 2 - 1) * pose.halfLength * 0.25;
        const size = FLAME_SIZE_FROM + (FLAME_SIZE_TO - FLAME_SIZE_FROM) * t;
        _position.set(
          vx + spreadX + dirX * FLAME_DRIFT * t,
          vy + t * FLAME_RISE,
          vz + spreadZ + dirZ * FLAME_DRIFT * t,
        );
        // Fades in fast and out slower, which is the opposite of the smoke's
        // gentle 10% ramp: a tongue *appears*. Scaled by `burn`, so the fire
        // comes up over `carfire.FLAME_RISE_S` rather than switching on -- the
        // artefact that makes every instanced effect look like a decal.
        const fade = t < 0.05 ? t / 0.05 : 1 - (t - 0.05) / 0.95;
        _scale.setScalar(size * fade * burn);
        _matrix.compose(_position, _quaternion, _scale);
        this.flames.setMatrixAt(flameSlot * FLAMES_PER_CAR + k, _matrix);
      }
    }

    // The soot. One material for the whole rig, so the *last* written-off car in
    // the frame decides the colour for all of them -- which is visibly wrong
    // only when a grey plume and a black one are in shot at once, and which
    // `swatpuff.ts` accepted on identical terms rather than compile a second
    // pipeline for a quarter-second discrepancy. Here the discrepancy is
    // permanent, so it is worth being explicit: two wrecks in one frame, one
    // merely smoking and one written off, both smoke the darker of the two. A
    // second material would be a second WebGPU pipeline compiled the first time
    // anybody wrote a car off, which is a hitch on a frame the player is already
    // paying attention to.
    if (damageGrade(pose.damage, _grade).soot) {
      this.material.color.setRGB(SMOKE_BLACK[0], SMOKE_BLACK[1], SMOKE_BLACK[2]);
      this.sooty = true;
    }
  }

  /** Whether anything in this frame was a write-off. Reset by `end`. */
  private sooty = false;

  end(): void {
    const n = this.count * PUFFS_PER_CAR;
    if (n > 0 || this.mesh.count > 0) this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = n;
    this.drawn = this.count;
    // The flames, on the plume's own rule: the count is set from what was
    // written this frame, so a frame with nothing alight leaves no stale tongues
    // burning over an empty parking space. That is the leak `verifyCarSmoke`
    // exists to catch, one effect over.
    const f = this.flameCount * FLAMES_PER_CAR;
    if (f > 0 || this.flames.count > 0) this.flames.instanceMatrix.needsUpdate = true;
    this.flames.count = f;
    this.alight = this.flameCount;
    if (!this.sooty) {
      this.material.color.setRGB(SMOKE_GREY[0], SMOKE_GREY[1], SMOKE_GREY[2]);
    }
    this.sooty = false;

    // The fires this frame found, published for the night rig to read on the
    // next one. Copied rather than swapped so that `fireAt` is always a whole
    // frame's answer: a reader that arrived between `begin` and `end` would
    // otherwise see half of this frame's cars and half of last frame's.
    this.fireAt.set(this.fireFilling);
    this.fireCount = this.fireFilled;

    this.writeMarks();
  }

  /**
   * The scorch marks and the debris, written from the `booms` list.
   *
   * Both are **lookups off the age** and hold no state of their own, which is
   * the property the whole file is built on: a mark is a position and a number
   * of seconds, and a chunk is `debrisChunk(seed, k, age)`. Nothing is born and
   * nothing dies inside this loop -- the list is what lives, and it is swept by
   * `begin`.
   */
  private writeMarks(): void {
    let written = 0;
    let scorch = 0;
    let flying = 0;
    const fade = this.markFade.array as Float32Array;

    // Newest first, because the caps bite at the far end of the list and the
    // newest explosion is the one the player is looking at. See `MAX_SCORCH`.
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];

      if (scorch < MAX_SCORCH) {
        const left = scorchFade(b.age) * SCORCH_ALPHA;
        // Below this a mark is under a code value of display and is costing a
        // 9.6 square metre blend for nothing. `teamlook.TeamRingField` drops an
        // expired ring on the same threshold.
        if (left > 0.004) {
          _position.set(b.x, b.y + SCORCH_LIFT, b.z);
          // Scaled in x and z only, exactly as a team ring is: a uniform scale
          // would multiply the 4 cm lift by the radius and float the mark 7 cm
          // over the road.
          _scale.set(SCORCH_R, 1, SCORCH_R);
          _matrix.compose(_position, _flat, _scale);
          this.marks.setMatrixAt(written, _matrix);
          fade[written] = left;
          written++;
          scorch++;
        }
      }

      if (b.age < DEBRIS_LIFE_S && flying < DEBRIS_BOOMS * DEBRIS_COUNT) {
        // One billboard quaternion for the whole scatter rather than one per
        // chunk, on the plume's own argument: fourteen discs within ten metres
        // of each other, seen from at least ten, are indistinguishable from
        // fourteen individually-aimed ones and this is one `lookAt`.
        _facing.position.set(b.x, b.y + 1, b.z);
        _facing.lookAt(this.toCamera);
        _quaternion.copy(_facing.quaternion);
        const left = debrisFade(b.age);
        for (let k = 0; k < DEBRIS_COUNT; k++) {
          if (flying >= DEBRIS_BOOMS * DEBRIS_COUNT || written >= MARK_CAPACITY) break;
          debrisChunk(b.seed, k, b.age, _chunk);
          if (!_chunk.alive) continue;
          _position.set(b.x + _chunk.dx, b.y + _chunk.dy, b.z + _chunk.dz);
          // Half, because the disc has radius 1 and a chunk's size is stated
          // across. The scorch above halves `SCORCH_M` in exactly the same place
          // and for exactly the same reason.
          _scale.setScalar(_chunk.size / 2);
          _matrix.compose(_position, _quaternion, _scale);
          this.marks.setMatrixAt(written, _matrix);
          fade[written] = left;
          written++;
          flying++;
        }
      }
    }

    // The counts, on the plume's rule: what was written this frame and nothing
    // carried over, so a frame with no explosions in it leaves no mark hanging
    // over a street where a wreck used to be.
    if (written > 0 || this.marks.count > 0) {
      this.marks.instanceMatrix.needsUpdate = true;
      this.markFade.needsUpdate = true;
    }
    this.marks.count = written;
    this.scorched = scorch;
    this.flying = flying;
  }

  dispose(): void {
    this.mesh.dispose();
    this.flames.dispose();
    this.marks.dispose();
    this.geometry.dispose();
    this.markGeometry.dispose();
    this.material.dispose();
    this.flameMaterial.dispose();
    this.markMaterial.dispose();
  }
}

/**
 * What this catches that a typecheck cannot.
 *
 *   - **A plume that never appears.** The single most likely failure, and it
 *     renders as a perfectly good frame: a count left at zero, or a scale that
 *     collapses every quad to nothing.
 *   - **A plume that leaks.** `mesh.count` left high on a frame with no smoking
 *     cars is twelve stale quads hanging over a street where a wreck used to be
 *     -- the same class of bug `swatpuff.ts`' pool check exists for.
 *   - **A plume that pulses in step.** Two wrecks side by side puffing on the
 *     same beat is the one thing that makes a closed-form loop look like a loop,
 *     and it happens the moment the per-puff phase stops depending on the car.
 *   - **A written-off car that smokes grey.** The black plume is the whole read
 *     for "this one is finished", and the colour never coming back is the same
 *     bug from the other side: a city where every crash smokes like a tyre fire.
 *
 *     bun -e "import {verifyCarSmoke} from './client/src/world/carsmoke.ts';
 *             console.log(verifyCarSmoke())"
 */
export function verifyCarSmoke(): string[] {
  const failures: string[] = [];
  const smoke = new CarSmoke();

  const pose = (identity: number, x: number, damage: number): CarPose => ({
    route: 0, slot: 0, x, y: 0, z: 0, dx: 1, dz: 0,
    body: 0, colour: 0, scale: 1, halfLength: 2.3, halfWidth: 0.9, height: 1.45,
    stage: 2, routeT: 0, speed: 0, identity, damage, held: 0,
    // The pass offset and the two life stamps `game/traffic.ts` added with the
    // obstacle rule. Nothing in this file reads them -- a plume is a function of
    // damage and position -- and they are here because a `CarPose` is a whole
    // record, and a literal that goes stale against it is a compile error rather
    // than a bug, which is the point of building the fixture this way.
    swerve: 0, bornAgo: 10, endsIn: 10,
  });

  // --- One car draws its whole plume, and an empty frame draws nothing.
  smoke.begin(0, 0, 10, 0);
  smoke.add(pose(0x1234, 0, 0.7));
  smoke.end();
  if (smoke.drawn !== 1) failures.push(`One smoking car reported ${smoke.drawn} plumes.`);
  if (smoke.mesh.count !== PUFFS_PER_CAR) {
    failures.push(`One plume drew ${smoke.mesh.count} instances against ${PUFFS_PER_CAR} puffs.`);
  }
  smoke.begin(0, 0, 10, 0);
  smoke.end();
  if (smoke.mesh.count !== 0) failures.push(`A frame with no smoking cars left ${smoke.mesh.count} quads drawn.`);

  // --- The puffs are at different heights, which is the whole of "a plume".
  {
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(0x1234, 0, 0.7));
    smoke.end();
    const m = new Matrix4();
    const heights: number[] = [];
    let visible = 0;
    for (let i = 0; i < PUFFS_PER_CAR; i++) {
      smoke.mesh.getMatrixAt(i, m);
      heights.push(m.elements[13]);
      // elements[0] is the x scale after a compose with an axis-aligned-ish
      // quaternion; a quad scaled to nothing is a quad nobody can see.
      const sx = Math.sqrt(m.elements[0] ** 2 + m.elements[1] ** 2 + m.elements[2] ** 2);
      if (sx > 0.05) visible++;
    }
    const spread = Math.max(...heights) - Math.min(...heights);
    if (spread < PUFF_RISE * 0.5) {
      failures.push(`A plume's twelve puffs span ${spread.toFixed(2)} m of height; that is a blob, not a column.`);
    }
    if (visible < PUFF_PLUME_MIN_VISIBLE) {
      failures.push(`Only ${visible} of ${PUFFS_PER_CAR} puffs had any size at all; the plume is invisible.`);
    }
    if (Math.min(...heights) < 0) failures.push('A puff was below the road surface.');
  }

  // --- Two cars do not pulse in step. The phase is drawn from the identity, so
  //     two different identities must produce two different columns.
  {
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(0xaaaa, 0, 0.7));
    smoke.add(pose(0xbbbb, 0, 0.7));
    smoke.end();
    const a = new Matrix4();
    const b = new Matrix4();
    let same = 0;
    for (let k = 0; k < PUFFS_PER_CAR; k++) {
      smoke.mesh.getMatrixAt(k, a);
      smoke.mesh.getMatrixAt(PUFFS_PER_CAR + k, b);
      if (Math.abs(a.elements[13] - b.elements[13]) < 1e-6) same++;
    }
    if (same > 2) {
      failures.push(
        `${same} of ${PUFFS_PER_CAR} puffs are at identical heights on two different cars. The phase must ` +
          `come off the identity, or every wreck in the city puffs on the same beat.`,
      );
    }
  }

  // --- The same car, sampled twice at the same clock, is in the same place --
  //     which is the "no pop" clause: a wreck that goes out of range and comes
  //     back resumes where it would have been rather than restarting its loop.
  {
    const fresh = new CarSmoke();
    fresh.begin(7.5, 0, 10, 0);
    fresh.add(pose(0xc0ffee, 0, 1));
    fresh.end();
    const first = new Matrix4();
    fresh.mesh.getMatrixAt(3, first);
    const again = new CarSmoke();
    again.begin(7.5, 0, 10, 0);
    again.add(pose(0xc0ffee, 0, 1));
    again.end();
    const second = new Matrix4();
    again.mesh.getMatrixAt(3, second);
    if (Math.abs(first.elements[13] - second.elements[13]) > 1e-9) {
      failures.push('Two rigs at the same clock put the same car\'s puff at different heights; the plume is not a lookup.');
    }
    fresh.dispose();
    again.dispose();
  }

  // --- An undamaged car draws nothing at all, and does not eat a slot.
  //
  // The threshold is `driving.damageGrade`'s and is asked *inside* `add`, so a
  // caller that hands over every driven car -- which is what
  // `drivencars.DrivenCarView.update` does -- must get one plume for the wreck
  // and none for the four healthy cars beside it. A slot claimed and then
  // abandoned would leave twelve unwritten instances inside `mesh.count`, which
  // is a plume hanging over a street where a wreck used to be.
  {
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(1, 0, 0));
    smoke.add(pose(2, 5, 0.1));
    smoke.add(pose(3, 10, 0.7));
    smoke.add(pose(4, 15, 0));
    smoke.end();
    if (smoke.drawn !== 1) failures.push(`One wreck among four healthy cars drew ${smoke.drawn} plumes.`);
    if (smoke.mesh.count !== PUFFS_PER_CAR) {
      failures.push(`Four cars with one wreck drew ${smoke.mesh.count} quads against ${PUFFS_PER_CAR}.`);
    }
    // And the one plume is at the wreck's own x, not at the first car's -- which
    // is what a claimed-then-abandoned slot would produce.
    // Tolerance is the sideways drift (`PUFF_DRIFT`), because a puff wanders as
    // it rises; what is being asserted is that the plume is over the wreck at 10
    // and not over the healthy car at 0.
    const m = new Matrix4();
    smoke.mesh.getMatrixAt(0, m);
    if (Math.abs(m.elements[12] - (10 + 2.3 * VENT_FORWARD)) > PUFF_DRIFT + 0.1) {
      failures.push(`The plume is at x = ${m.elements[12].toFixed(2)}; the only smoking car is at 10.`);
    }
  }

  // --- A write-off smokes black, and the grey comes back.
  {
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(1, 0, 0.7));
    smoke.end();
    const grey = smoke.mesh.material as MeshBasicNodeMaterial;
    if (grey.color.r < 0.2) failures.push('A merely damaged car smoked black.');
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(1, 0, 1));
    smoke.end();
    if (grey.color.r > 0.2) failures.push('A written-off car did not smoke black.');
    smoke.begin(0, 0, 10, 0);
    smoke.add(pose(1, 0, 0.7));
    smoke.end();
    if (grey.color.r < 0.2) {
      failures.push('The soot never washed out: once one car was written off, every plume in the city stayed black.');
    }
  }

  // --- The cap holds, so a pile-up cannot overrun the instance buffer.
  {
    smoke.begin(0, 0, 10, 0);
    for (let i = 0; i < MAX_SMOKING_CARS * 3; i++) smoke.add(pose(i + 1, i * 5, 0.7));
    smoke.end();
    if (smoke.drawn !== MAX_SMOKING_CARS) {
      failures.push(`${MAX_SMOKING_CARS * 3} smoking cars drew ${smoke.drawn} plumes against a cap of ${MAX_SMOKING_CARS}.`);
    }
    if (smoke.mesh.count > MAX_SMOKING_CARS * PUFFS_PER_CAR) {
      failures.push(`The instance count overran its buffer: ${smoke.mesh.count}.`);
    }
  }

  // --- WORKSTREAM Y: the flames. Same class of failure as the plume's and the
  //     same shape of check, because it is the same closed form with three
  //     numbers changed.
  //
  //   - **A fire nobody can see.** A `burn` of 0 reaching the loop, or a scale
  //     that collapses, and the symptom is a car that explodes out of a clear
  //     sky with no warning at all.
  //   - **Flames on a car that is not on fire.** The mirror, and much worse: the
  //     plume is handed *every* driven car in range, so a burn argument that was
  //     ignored would set the whole city alight.
  //   - **Tongues left burning over an empty street.** `flames.count` left high,
  //     which is the leak the plume's own check exists for.
  {
    const fresh = new CarSmoke();
    fresh.begin(0, 0, 10, 0);
    fresh.add(pose(0xb00, 0, 1), 1);
    fresh.end();
    if (fresh.alight !== 1) failures.push(`One burning car reported ${fresh.alight} fires.`);
    if (fresh.flames.count !== FLAMES_PER_CAR) {
      failures.push(`One fire drew ${fresh.flames.count} tongues against ${FLAMES_PER_CAR}.`);
    }
    // A write-off that is *not* alight smokes and does not burn, which is the
    // difference between a wreck at a kerb and a wreck about to be a crater.
    fresh.begin(0, 0, 10, 0);
    fresh.add(pose(0xb00, 0, 1));
    fresh.end();
    if (fresh.alight !== 0) failures.push('A write-off that is not on fire drew flames.');
    if (fresh.flames.count !== 0) {
      failures.push(`A frame with nothing alight left ${fresh.flames.count} tongues drawn over the street.`);
    }
    // The tongues have real size and are spread up the bonnet rather than
    // stacked at one point, which is the "it is a fire and not a blob" property.
    fresh.begin(0, 0, 10, 0);
    fresh.add(pose(0xb01, 0, 1), 1);
    fresh.end();
    const m = new Matrix4();
    const heights: number[] = [];
    let visible = 0;
    for (let i = 0; i < FLAMES_PER_CAR; i++) {
      fresh.flames.getMatrixAt(i, m);
      heights.push(m.elements[13]);
      if (Math.sqrt(m.elements[0] ** 2 + m.elements[1] ** 2 + m.elements[2] ** 2) > 0.02) visible++;
    }
    if (visible < FLAMES_PER_CAR / 2) {
      failures.push(`Only ${visible} of ${FLAMES_PER_CAR} tongues had any size; the fire is invisible.`);
    }
    if (Math.max(...heights) - Math.min(...heights) < FLAME_RISE * 0.25) {
      failures.push('The flame tongues are all at one height; that is a disc, not a fire.');
    }
    // A fire coming up (`carfire.fireGrade`'s ramp) is smaller than an
    // established one. This is the whole of "it does not switch on".
    const early = new CarSmoke();
    early.begin(0, 0, 10, 0);
    early.add(pose(0xb02, 0, 1), 0.1);
    early.end();
    const late = new CarSmoke();
    late.begin(0, 0, 10, 0);
    late.add(pose(0xb02, 0, 1), 1);
    late.end();
    const a = new Matrix4();
    const b = new Matrix4();
    early.flames.getMatrixAt(0, a);
    late.flames.getMatrixAt(0, b);
    const scaleOf = (mm: Matrix4): number => Math.sqrt(mm.elements[0] ** 2 + mm.elements[1] ** 2 + mm.elements[2] ** 2);
    if (!(scaleOf(a) < scaleOf(b))) {
      failures.push(`A fire that has just caught (${scaleOf(a).toFixed(3)}) is not smaller than an established one (${scaleOf(b).toFixed(3)}).`);
    }
    // And a burning car smokes *thicker*, never thinner -- the `Math.max` in
    // `add`. A fire that thinned the plume would read as the wreck recovering.
    if (!(BURN_SMOKE_RATE > SMOKE_RATE_DEAD)) {
      failures.push(`A burning car smokes at ${BURN_SMOKE_RATE} against a write-off's ${SMOKE_RATE_DEAD}.`);
    }
    // The cap holds on the flames as well, so a car park on fire cannot overrun
    // the second instance buffer either.
    fresh.begin(0, 0, 10, 0);
    for (let i = 0; i < MAX_SMOKING_CARS * 3; i++) fresh.add(pose(i + 1, i * 5, 1), 1);
    fresh.end();
    if (fresh.flames.count > MAX_SMOKING_CARS * FLAMES_PER_CAR) {
      failures.push(`The flame instance count overran its buffer: ${fresh.flames.count}.`);
    }
    fresh.dispose();
    early.dispose();
    late.dispose();
  }

  // --- The scorch mark. What this catches:
  //
  //   - **A mark nobody can see.** A fade that starts at zero, a radius read as
  //     a diameter, or an instance colour never written -- and every one of them
  //     is a perfectly good frame with an explosion that leaves nothing behind.
  //   - **A mark that never goes.** The mirror, and the one that accumulates: a
  //     sweep that does not expire is a city with a black disc at every
  //     intersection somebody has ever crashed at, arrived at over an hour.
  //   - **A mark under the road.** The lift dropped, or applied to the wrong
  //     axis, which reads as the feature not having shipped rather than as a
  //     depth bug.
  {
    // The curve, swept rather than asserted at three points.
    if (scorchFade(0) !== 1) failures.push(`A fresh scorch is at ${scorchFade(0)} of full, not 1.`);
    if (scorchFade(SCORCH_S) !== 0) failures.push(`A ${SCORCH_S} s old scorch is still at ${scorchFade(SCORCH_S)}.`);
    if (scorchFade(SCORCH_S * 3) !== 0) failures.push('A long-expired scorch came back.');
    let previous = Infinity;
    for (let t = 0; t <= SCORCH_S * 1.2; t += 0.25) {
      const f = scorchFade(t);
      if (f < 0 || f > 1) failures.push(`scorchFade(${t}) is ${f}, outside 0..1.`);
      if (f > previous + 1e-9) failures.push(`The scorch got darker with age at ${t.toFixed(2)} s.`);
      previous = f;
    }
    // It has to *hold* early and be gone late, or the curve is a straight line
    // wearing a smoothstep's name: a mark that is half faded five seconds after
    // the bang is one nobody connects to the explosion they just watched.
    if (!(scorchFade(SCORCH_S * 0.15) > 0.85)) {
      failures.push(`A scorch is already at ${scorchFade(SCORCH_S * 0.15).toFixed(2)} after 15% of its life; it has to hold while the wreck is still the story.`);
    }
    if (!(scorchFade(SCORCH_S * 0.9) < 0.1)) {
      failures.push(`A scorch is still at ${scorchFade(SCORCH_S * 0.9).toFixed(2)} at 90% of its life; the tail has to thin out rather than switch off.`);
    }

    const marks = new CarSmoke();
    marks.begin(0, 0, 10, 0);
    marks.boom(120, 7.5, -40);
    marks.end();
    if (marks.scorched !== 1) failures.push(`One explosion left ${marks.scorched} scorch marks.`);
    if (marks.marks.count !== 1) failures.push(`One mark drew ${marks.marks.count} instances.`);
    {
      const m = new Matrix4();
      marks.marks.getMatrixAt(0, m);
      const radius = Math.sqrt(m.elements[0] ** 2 + m.elements[1] ** 2 + m.elements[2] ** 2);
      if (Math.abs(radius - SCORCH_R) > 1e-6) {
        failures.push(`The scorch is ${(radius * 2).toFixed(2)} m across against carfire.SCORCH_M's ${SCORCH_M}; a radius read as a diameter is a mark half the size it was specified at.`);
      }
      // The vertical scale is exactly 1, or the lift is multiplied by the radius.
      const lifted = Math.sqrt(m.elements[4] ** 2 + m.elements[5] ** 2 + m.elements[6] ** 2);
      if (Math.abs(lifted - 1) > 1e-6) failures.push(`The scorch is scaled ${lifted} in y; a flat disc must be scaled in x and z only.`);
      if (Math.abs(m.elements[12] - 120) > 1e-6 || Math.abs(m.elements[14] - -40) > 1e-6) {
        failures.push(`The scorch is at (${m.elements[12]}, ${m.elements[14]}) rather than at the blast.`);
      }
      const lift = m.elements[13] - 7.5;
      if (!(lift > 0 && lift < 0.2)) {
        failures.push(`The scorch sits ${lift.toFixed(3)} m over the ground it was laid on. Under it is invisible; a fifth of a metre over it is a disc hovering above the road.`);
      }
      const alpha = markAlphaAt(marks, 0);
      if (Math.abs(alpha - SCORCH_ALPHA) > 1e-6) {
        failures.push(`A fresh mark's instance alpha is ${alpha.toFixed(3)} rather than ${SCORCH_ALPHA}; the fade rides in that attribute and the shader reads nothing else.`);
      }
    }

    // It ages, it dims, and eventually it is not drawn at all.
    marks.begin(SCORCH_S * 0.5, 0, 10, 0);
    marks.end();
    {
      const alpha = markAlphaAt(marks, 0);
      if (!(alpha < SCORCH_ALPHA && alpha > 0)) {
        failures.push(`Half way through its life a mark is at ${alpha.toFixed(3)} of alpha; it is meant to be fading.`);
      }
    }
    marks.begin(SCORCH_S, 0, 10, 0);
    marks.end();
    if (marks.scorched !== 0 || marks.marks.count !== 0) {
      failures.push(`A mark ${SCORCH_S} s old is still on the road (${marks.marks.count} instances). Marks that never expire accumulate at every intersection in the city.`);
    }

    // The cap, and which end of the queue it takes from. The *newest* survive.
    marks.begin(0, 0, 10, 0);
    for (let i = 0; i < MAX_SCORCH + 6; i++) marks.boom(i * 20, 0, 0);
    marks.end();
    if (marks.scorched !== MAX_SCORCH) {
      failures.push(`${MAX_SCORCH + 6} explosions drew ${marks.scorched} marks against a cap of ${MAX_SCORCH}.`);
    }
    {
      const m = new Matrix4();
      let oldest = Infinity;
      for (let i = 0; i < marks.marks.count; i++) {
        marks.marks.getMatrixAt(i, m);
        oldest = Math.min(oldest, m.elements[12]);
      }
      // The first six were at x 0..100 and are the ones that should have gone.
      if (oldest < 6 * 20) {
        failures.push(`Over the cap the mark at x ${oldest} survived; the oldest six should have been evicted, not the newest.`);
      }
    }
    marks.dispose();
  }

  // --- The debris. What this catches:
  //
  //   - **Two clients watching different explosions.** The scatter is a pure
  //     function of the blast's position, and a seed drawn from a clock or a
  //     counter instead is the failure nobody can see alone and everybody
  //     notices together.
  //   - **Chunks that never land**, which is a closed-form ballistic whose
  //     gravity does not finish the arc inside the chunk's life: the effect ends
  //     with fourteen lumps of car hanging in mid-air and vanishing.
  //   - **Debris left in the sky.** `debris.count` held high, which is the same
  //     leak the plume's own check exists for.
  {
    if (debrisFade(0) !== 1) failures.push(`A fresh chunk is at ${debrisFade(0)}, not 1.`);
    if (debrisFade(DEBRIS_LIFE_S) !== 0) failures.push('A spent chunk did not fade out.');
    let previous = Infinity;
    for (let t = 0; t <= DEBRIS_LIFE_S * 1.5; t += 0.01) {
      const f = debrisFade(t);
      if (f < 0 || f > 1) failures.push(`debrisFade(${t.toFixed(2)}) is ${f}, outside 0..1.`);
      if (f > previous + 1e-9) failures.push(`A chunk got brighter with age at ${t.toFixed(2)} s.`);
      previous = f;
    }

    // Every chunk goes up, comes down and is finished inside its own life.
    const chunk = createDebrisChunk();
    for (let k = 0; k < DEBRIS_COUNT; k++) {
      let apex = 0;
      let reach = 0;
      let landed = -1;
      for (let t = 0.01; t <= DEBRIS_LIFE_S; t += 0.01) {
        debrisChunk(0xbeef, k, t, chunk);
        if (chunk.alive) {
          apex = Math.max(apex, chunk.dy);
          reach = Math.max(reach, Math.hypot(chunk.dx, chunk.dz));
        } else if (landed < 0 && apex > 0) {
          landed = t;
        }
      }
      if (!(apex > 0.5)) failures.push(`Chunk ${k} reached ${apex.toFixed(2)} m; that is a chunk sliding along the road, not one thrown off a car.`);
      if (!(reach > 0.5)) failures.push(`Chunk ${k} travelled ${reach.toFixed(2)} m from the blast.`);
      if (landed < 0) failures.push(`Chunk ${k} is still in the air after ${DEBRIS_LIFE_S} s; the gravity does not finish its arc and it vanishes in mid-flight.`);
      if (!(chunk.size >= DEBRIS_SIZE_MIN - 1e-9 && chunk.size <= DEBRIS_SIZE_MAX + 1e-9)) {
        failures.push(`Chunk ${k} is ${chunk.size.toFixed(3)} m across, outside ${DEBRIS_SIZE_MIN}..${DEBRIS_SIZE_MAX}.`);
      }
    }

    // Determinism: the same blast, asked twice, scatters identically -- and two
    // blasts a decimetre apart do not.
    const a = createDebrisChunk();
    const b = createDebrisChunk();
    for (let k = 0; k < DEBRIS_COUNT; k++) {
      debrisChunk(0xbeef, k, 0.3, a);
      debrisChunk(0xbeef, k, 0.3, b);
      if (a.dx !== b.dx || a.dy !== b.dy || a.dz !== b.dz) {
        failures.push(`Chunk ${k} of one blast is in two places when asked twice; the scatter is not a lookup and two clients would see different debris.`);
        break;
      }
    }
    {
      let same = 0;
      for (let k = 0; k < DEBRIS_COUNT; k++) {
        debrisChunk(0xbeef, k, 0.3, a);
        debrisChunk(0xf00d, k, 0.3, b);
        if (Math.abs(a.dx - b.dx) < 1e-9 && Math.abs(a.dz - b.dz) < 1e-9) same++;
      }
      if (same > 2) {
        failures.push(`${same} of ${DEBRIS_COUNT} chunks scatter identically for two different blasts; the seed is not reaching the hash and every explosion in the city throws the same fourteen chunks.`);
      }
    }
    // ...and the seed is the *position*, so two clients decoding the same
    // `TEAM_EVENT` agree. Asserted through the public door rather than on the
    // hash, because what has to be true is that `boom` derives it from x and z.
    {
      const one = new CarSmoke();
      const two = new CarSmoke();
      one.begin(0, 0, 10, 0);
      one.boom(-1204.5, 6.3, 331.25);
      one.end();
      two.begin(0, 0, 10, 0);
      two.boom(-1204.5, 6.3, 331.25);
      two.end();
      one.begin(0.3, 0, 10, 0);
      one.end();
      two.begin(0.3, 0, 10, 0);
      two.end();
      if (one.flying !== two.flying) {
        failures.push(`Two clients drew ${one.flying} and ${two.flying} chunks for the same explosion.`);
      } else {
        const ma = new Matrix4();
        const mb = new Matrix4();
        for (let i = 0; i < one.marks.count; i++) {
          one.marks.getMatrixAt(i, ma);
          two.marks.getMatrixAt(i, mb);
          if (Math.abs(ma.elements[12] - mb.elements[12]) > 1e-9 || Math.abs(ma.elements[13] - mb.elements[13]) > 1e-9) {
            failures.push('Two clients put the same explosion\'s chunk in two places; the scatter must be seeded from the position and nothing else.');
            break;
          }
        }
      }
      one.dispose();
      two.dispose();
    }

    // In the air, then gone, and never left drawn.
    const rig = new CarSmoke();
    rig.begin(0, 0, 10, 0);
    rig.boom(0, 0, 0);
    rig.end();
    rig.begin(0.15, 0, 10, 0);
    rig.end();
    if (!(rig.flying >= DEBRIS_COUNT - 1)) {
      failures.push(`An explosion 0.15 s old has ${rig.flying} chunks in the air against ${DEBRIS_COUNT} thrown.`);
    }
    if (rig.marks.count !== rig.flying + rig.scorched) {
      failures.push(`The pool holds ${rig.marks.count} instances against ${rig.scorched} marks and ${rig.flying} chunks; the two share one buffer and the count is their sum.`);
    }
    rig.begin(DEBRIS_LIFE_S, 0, 10, 0);
    rig.end();
    if (rig.flying !== 0) {
      failures.push(`${rig.flying} chunks are still drawn ${DEBRIS_LIFE_S} s after the bang, hanging over the street.`);
    }
    // The mark is still there long after the chunks have gone, which is the one
    // relationship between the two effects that matters.
    if (rig.scorched !== 1) failures.push('The scorch mark went with the debris; it is meant to outlast it by half a minute.');
    // And the buffers cannot be overrun by a chain reaction in a car park.
    rig.begin(0, 0, 10, 0);
    for (let i = 0; i < DEBRIS_BOOMS * 4; i++) rig.boom(i * 12, 0, 0);
    rig.end();
    rig.begin(0.2, 0, 10, 0);
    rig.end();
    if (rig.flying > DEBRIS_BOOMS * DEBRIS_COUNT || rig.marks.count > MARK_CAPACITY) {
      failures.push(`A car park chain reaction overran the mark pool: ${rig.flying} chunks and ${rig.marks.count} of ${MARK_CAPACITY} instances.`);
    }
    rig.dispose();
  }

  // --- The fires the night rig lights. What this catches:
  //
  //   - **A light on a car that is not burning**, or none on one that is, which
  //     is the whole feature failing silently after dark.
  //   - **The wrong two.** The budget is two and they are the nearest two; a
  //     list handed over in insertion order lights the fire behind you and
  //     leaves the one you are standing next to dark.
  //   - **A light that reaches across the harbour.** The radius compared as a
  //     distance against a square, which is the classic and which lights every
  //     burning car in the city.
  {
    const fires = new CarSmoke();
    const out = new Float32Array(6);
    fires.begin(0, 0, 10, 0);
    fires.add(pose(1, 0, 1));
    fires.end();
    if (fires.nearestFires(0, 0, 0, 60, out, 2) !== 0) {
      failures.push('A write-off that is not alight was offered to the night rig as a fire.');
    }
    fires.begin(0, 0, 10, 0);
    fires.add(pose(1, 30, 1), 1);
    fires.add(pose(2, 5, 1), 1);
    fires.add(pose(3, 12, 1), 1);
    fires.end();
    const n = fires.nearestFires(0, 0, 0, 60, out, 2);
    if (n !== 2) failures.push(`Three burning cars and a budget of two produced ${n} lights.`);
    else {
      // Nearest first: the car at 5 then the car at 12, and never the one at 30.
      if (Math.abs(out[0] - (5 + 2.3 * VENT_FORWARD)) > 1e-3) {
        failures.push(`The nearest fire is at x ${out[0].toFixed(2)}; the closest burning car is at 5.`);
      }
      if (Math.abs(out[3] - (12 + 2.3 * VENT_FORWARD)) > 1e-3) {
        failures.push(`The second fire is at x ${out[3].toFixed(2)}; the second closest burning car is at 12.`);
      }
      // At the vent rather than at the axle: a light inside the engine bay is a
      // light that lights nothing.
      if (!(out[1] > 0.3)) failures.push(`The fire light is ${out[1].toFixed(2)} m off the ground; it belongs at the burning bonnet.`);
    }
    if (fires.nearestFires(0, 0, 0, 4, out, 2) !== 0) {
      failures.push('A fire 5 m away was found inside a 4 m radius; the search compares a distance against a square somewhere.');
    }
    if (fires.nearestFires(200, 0, 0, 60, out, 2) !== 0) {
      failures.push('A fire was lit from 170 m away, well past the search radius.');
    }
    // A caller asking for more than the scratch holds is clamped rather than
    // scribbling past the end of it. See `_fireDistance`.
    const big = new Float32Array(MAX_FIRE_QUERY * 3 + 9);
    if (fires.nearestFires(0, 0, 0, 60, big, MAX_FIRE_QUERY + 3) > MAX_FIRE_QUERY) {
      failures.push('nearestFires wrote past its own scratch when asked for more than it holds.');
    }
    // And a frame with nothing alight empties the list rather than leaving the
    // last fire burning in an empty street forever.
    fires.begin(0, 0, 10, 0);
    fires.end();
    if (fires.nearestFires(0, 0, 0, 60, out, 2) !== 0) {
      failures.push('A car that stopped burning is still lighting the street; the light is never released.');
    }
    fires.dispose();
  }

  // --- And the shapes these two effects are, against the rules that own them.
  {
    if (!(SCORCH_M > 2 && SCORCH_M < BLAST_M_FOR_CHECK)) {
      failures.push(`The scorch is ${SCORCH_M} m across against a ${BLAST_M_FOR_CHECK} m blast. A mark wider than the explosion is a crater with the bang inside it; one under about 2 m is invisible from a car.`);
    }
    if (!(DEBRIS_COUNT >= 8 && DEBRIS_COUNT <= 32)) {
      failures.push(`${DEBRIS_COUNT} chunks is outside "a car coming apart" -- under about eight reads as litter and over thirty as a puff, which the plume is already for.`);
    }
    if (!(DEBRIS_LIFE_S > 0 && DEBRIS_LIFE_S < SCORCH_S)) {
      failures.push(`Debris lives ${DEBRIS_LIFE_S} s against a mark's ${SCORCH_S}; the chunks must be gone long before the mark is.`);
    }
    // The triangle budget, in `teamlook.TRI_BUDGET`'s spirit: the two sets
    // together are a rounding error on a frame that places two hundred cars, and
    // this is the line that says so out loud when somebody raises a segment
    // count for a screenshot.
    const markTris = MARK_CAPACITY * SCORCH_SEGMENTS * 3;
    if (markTris > 4000) {
      failures.push(`Every scorch and every chunk at once is ${markTris} triangles, past the 4,000 this effect is budgeted at. One geometry for both is worth a lot of triangles and not an unbounded number of them; see the header.`);
    }
  }

  smoke.dispose();
  return failures;
}

/**
 * The fade written into instance `i` of a rig's mark pool.
 *
 * Reaches into the private attribute because there is nowhere else for it to
 * come from: the whole point of the fade is that it is a number the *shader*
 * reads, and a check that could only see the matrices would pass with every
 * mark at full strength forever. `verifyBigNightKit` reads `instanceColor` off
 * the ring field for the same reason.
 */
function markAlphaAt(rig: CarSmoke, i: number): number {
  const fade = (rig as unknown as { markFade: InstancedBufferAttribute }).markFade;
  return (fade.array as Float32Array)[i];
}

/**
 * `carfire.BLAST_M`, restated for the one check that compares against it.
 *
 * Not imported, on `carfire.CAR_SMOKING_HEALTH_FIRE`'s own arrangement: this
 * file already imports four constants from the rules and a fifth used by nothing
 * but an assertion would be an import that exists to be checked. Seven metres,
 * and `verifyCarFire` owns the real one.
 */
const BLAST_M_FOR_CHECK = 7;

/**
 * How many of a plume's twelve puffs must have real size at any instant.
 *
 * Not twelve: the fade takes each puff to zero at the top of its rise and one of
 * them is always at or near that point. Eight is "the column is continuous",
 * which is the property being asserted.
 */
const PUFF_PLUME_MIN_VISIBLE = 8;
