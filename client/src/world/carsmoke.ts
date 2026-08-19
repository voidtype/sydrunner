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
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
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
import { BURN_SMOKE_RATE } from '../game/carfire.ts';

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

const _position = /*#__PURE__*/ new Vector3();
const _scale = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _matrix = /*#__PURE__*/ new Matrix4();
const _facing = /*#__PURE__*/ new Object3D();

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
  /** Cars smoking last frame. The dev overlay, and `verifyCarSmoke`. */
  drawn = 0;
  /** ...and cars *burning* last frame, which is a subset of them. */
  alight = 0;

  private readonly geometry: BufferGeometry;
  private readonly material: MeshBasicNodeMaterial;
  private readonly flameMaterial: MeshBasicNodeMaterial;
  private count = 0;
  private flameCount = 0;
  /** Seconds since the rig was built. The plume's whole clock. */
  private clock = 0;
  /** Which way the camera is looking, for the billboard. See the header. */
  private readonly toCamera = new Vector3(0, 0, 1);

  constructor() {
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
    this.toCamera.set(cameraX, cameraY, cameraZ);
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
  }

  dispose(): void {
    this.mesh.dispose();
    this.flames.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.flameMaterial.dispose();
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

  smoke.dispose();
  return failures;
}

/**
 * How many of a plume's twelve puffs must have real size at any instant.
 *
 * Not twelve: the fade takes each puff to zero at the top of its rise and one of
 * them is always at or near that point. Eight is "the column is continuous",
 * which is the property being asserted.
 */
const PUFF_PLUME_MIN_VISIBLE = 8;
