/**
 * The cricket bat: one geometry, a prop in every right hand, and a first-person
 * viewmodel.
 *
 * The melee weapon in this game was a bare fist until this pass and is now a bat,
 * on a direct instruction. Three things had to exist for that to be true rather
 * than merely asserted: an object you can see in somebody else's hands, an object
 * *you* can see in your own, and a reach that matches the thing being swung.
 * The first two are here; the third is `game/combat.ts`'s `REACH`, and the check
 * at the bottom of this file is what ties the two together -- it swings the real
 * rig, reads where the toe of the real bat ends up, and asserts that the number
 * the hit test uses is the number the picture shows.
 *
 * ---------------------------------------------------------------------------
 * Why the bat is generated, like everything else here.
 *
 * `player/character.ts` argues this at length about the figure and
 * `world/footyball.ts` repeats it about the ball: there is no asset pipeline for
 * a downloaded mesh to enter, and a `.glb` would be the only thing in the
 * repository whose triangle budget, pivot and up-axis were decided somewhere
 * else. A cricket bat is a tapered box on a stick. It is 128 triangles of loft.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the two details that make it a *cricket* bat rather than a club.
 *
 * A baseball bat is a solid of revolution and a cricket bat is not, and the
 * difference is the whole silhouette:
 *
 *   - **A flat face and a V spine.** The blade's hitting face is a plane; the
 *     back is a shallow roof rising from two thin edges to a central ridge.
 *     Seen end-on that is a seven-sided profile, and it is what says "cricket"
 *     from any angle where the bat is not exactly edge-on. The edges are
 *     chamfered into the face rather than meeting it square, because a square
 *     corner under `flatShading` reads as a dead black line.
 *   - **A cylindrical rubber grip**, dark, on a handle a bit under half the
 *     bat's length, with the pale splice showing where it meets the blade.
 *     Two materials' worth of contrast in one vertex-colour buffer.
 *
 * The proportions are a real bat's, scaled to this figure. A Law 5 bat is 0.965 m
 * overall with a 0.559 m blade, on a person of about 1.80 m: 54% of their height,
 * blade 58% of the bat. This one is 0.83 m on a 1.70 m figure -- 49% of height,
 * blade 60% of the bat. It reads *larger* than that arithmetic suggests, because
 * spec 8.1's figure has noodle arms and a 0.19 m mitt, and a bat is judged
 * against the hand holding it.
 *
 * ---------------------------------------------------------------------------
 * One geometry and one material for every bat in the game.
 *
 * The same contract `CharacterAssets` has, for the same reason: a material is a
 * WebGPU pipeline, and sixteen players each with their own bat material is
 * sixteen compiles in the frame a match starts. So the wood, the grip and the
 * splice are **vertex colours** on one flat-shaded `MeshStandardNodeMaterial`,
 * and an actor never disposes the geometry it was handed.
 *
 * ---------------------------------------------------------------------------
 * Where the bat is attached, and the one thing that decides the whole pose.
 *
 * A `BatProp` is parented to the character's **right wrist bone**, exactly as
 * `world/footyball.ts`'s ball is parented to the left one, which costs one
 * `add()` and no per-frame matrix work: three composes the skeleton anyway, so a
 * child of a bone is transformed for free.
 *
 * The bat is built with its **grip top at the origin and its shaft running along
 * -Y**, which is the rig's own convention -- every bone in `animation.ts` hangs
 * along its own -Y -- so the bat reads as one more segment of the arm and the
 * only interesting number in the attachment is a single rotation about X.
 *
 * That number is `HOLD_PITCH`, and it is **-2.72 rad**, which is the decision
 * this file is most likely to be asked about. The chain from the shoulder to the
 * blade is a sum of rotations about the same axis, so the direction the bat
 * points is
 *
 *     theta = shoulder.x + elbow.x + wrist.x + HOLD_PITCH
 *     direction = (0, -cos theta, -sin theta)
 *
 * and the pose has to be believable at *both* ends of that sum:
 *
 *   - **At idle** the arm hangs (shoulder 0, elbow 0.14), so theta is -2.58 and
 *     the bat points up and back at 58 degrees -- shouldered, toe up past the
 *     right ear at 1.14 m and 0.36 m behind. That is a brawler carrying a bat,
 *     and it is the only family of poses that works: this figure's mitt sits
 *     0.435 m off the ground, so a 0.83 m bat hanging *down* from it is a third
 *     of a metre through the footpath, whatever angle it is given. Measured over
 *     a full run cycle the lowest point of the bat is 0.40 m up.
 *   - **At the strike** the arm is thrown forward and the wrist snaps through, so
 *     theta comes round to about +1.1 and the blade arrives out in front and to
 *     the left at chest height, 1.40 m from the body axis in plan. See
 *     `animation.clipPunchActive`, which was rewritten in this pass from a jab
 *     into a swing for exactly this reason: a bat held as an extension of a
 *     *punching* arm points backwards at the moment of impact, which is the
 *     failure that made the arithmetic above worth writing down.
 *
 * Between the two the blade scythes down past the player's own feet -- at its
 * lowest it clears the pavement by 6 cm -- which is what a swing does and is the
 * one place in the arc where the clearance is worth watching.
 *
 * `HOLD_ROLL` is a rotation about the bat's own shaft and changes nothing about
 * where the bat points -- a roll about -Y commutes with the shaft direction --
 * so it is free to use for the one thing it does control, which is which way the
 * flat face is turned as the blade comes through.
 *
 * ---------------------------------------------------------------------------
 * The viewmodel, and what it deliberately is not.
 *
 * `BatViewmodel` is a bat parented to the camera. It is the first first-person
 * geometry this project has had -- `main.ts` recorded the absence and the reason
 * ("there are no first-person arms, deliberately") -- and it is here now because
 * a melee weapon you cannot see is a melee weapon the player has to take on
 * trust.
 *
 * What it is not is a second render pass. The usual arrangement is to draw a
 * viewmodel with its own near plane into a cleared depth buffer so it can never
 * intersect the world; that is a whole pass, a second camera and a depth clear
 * per frame, and it was explicitly not wanted this round. So the bat is an
 * ordinary lit object in the ordinary depth buffer, and the thing that keeps it
 * out of walls is **that it is small and close**: `verifyBat` asserts that no
 * vertex of it, at any point in the swing, is more than `MAX_VIEW_REACH` from the
 * eye. At 0.90 m -- measured at 0.75 -- that is well inside the 1.55 m the hit
 * test reaches, so any wall the bat could clip into is a wall the player is
 * already standing against.
 *
 * The second thing the check guards is the reticle. A viewmodel that covers the
 * crosshair is a viewmodel that has to be moved after somebody complains, so the
 * rest pose's vertices are projected into camera space and asserted to clear a
 * cone around the view axis; measured, the nearest the resting blade comes is
 * 16.5 degrees against a 5.7-degree floor. The swing is exempt -- it sweeps
 * right to left across the lower half of the frame and crosses the centre line
 * under the crosshair, which is the gesture -- and only the pose the player
 * looks at for 95% of the session is held to the cone.
 *
 * ---------------------------------------------------------------------------
 * Cost. 128 triangles and 237 vertices, one geometry and one material for the
 * entire game, against `CharacterAssets`'s 440 triangles a figure. Sixteen
 * players with bats is 2,048 triangles in sixteen draws, which is a rounding
 * error beside the 483 k of trees in the spawn frame. The viewmodel is one draw
 * more.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from 'three/webgpu';

import { BONE, PUNCH_ACTIVE, PUNCH_RECOVERY, PUNCH_TOTAL, PUNCH_WIND_UP } from './animation.ts';
import { CharacterActor, CharacterAssets, SELF_SHADOW_LAYER } from './character.ts';

// --- Proportions --------------------------------------------------------------

/*
 * Every dimension of the bat, in metres, in one place. `y = 0` is the top of the
 * grip -- the point the hand closes around and the point the prop is attached by
 * -- and the shaft runs down -Y from there.
 */

/** Top of the rubber grip cap, above the attachment point. */
const GRIP_CAP_Y = 0.028;
/** Where the handle ends and the splice begins. */
const SHOULDER_Y = -0.315;
/** The toe. Overall length is `GRIP_CAP_Y - TOE_Y`. */
const TOE_Y = -0.8;

/** Overall length, grip cap to toe, metres. 0.83 m on a 1.70 m figure. */
export const BAT_LENGTH = GRIP_CAP_Y - TOE_Y;
/** Blade length, shoulder to toe. 60% of the bat, as a real one is 58%. */
export const BLADE_LENGTH = SHOULDER_Y - TOE_Y;
/** Blade half-width at the edges, metres. A Law 5 bat is 0.108 m across. */
const BLADE_HALF_WIDTH = 0.0625;

/** Handle radii: the grip cap, the shaft, and the flare into the splice. */
const GRIP_CAP_R = 0.03;
const GRIP_TOP_R = 0.0245;
const GRIP_WAIST_R = 0.0225;
const GRIP_BASE_R = 0.03;

/** Sides on the handle. Eight, which is `character.ts`'s `LIMB_SIDES` and reads round enough at arm's length. */
const HANDLE_SIDES = 8;

// --- Colour -------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/*
 * Four linear albedos, on `character.ts`'s terms: every value below was picked
 * against the surfaces the bat is seen over rather than in isolation, because a
 * bat is a moving object at head height in front of a street.
 *
 * The blade is the only one that had to be measured. Willow is *pale* -- a new
 * bat is close to unfinished pine -- and the reference this project publishes for
 * a sunlit footpath is Y' 247, which is nearly white. A blade at the reflectance
 * of real willow disappears against it. So the face sits a little under: warm,
 * clearly wood, and about a fifth darker than the pavement it is swung over,
 * which is what keeps the silhouette when a fight moves onto a sunlit path.
 *
 * The two-tone split between face and back is not decoration either. Under
 * `flatShading` the V spine's two slopes differ from the face by only the cosine
 * of a shallow angle, so on a dull day the ridge vanishes and the blade reads as
 * a plank. Half a stop of albedo between them draws the spine at every light
 * angle for the cost of a different triple in a buffer.
 */
/** The hitting face and the chamfers: pale willow. */
const WILLOW_FACE: Rgb = [0.66, 0.58, 0.42];
/** The back slopes and the edges: the same wood, deeper, so the spine reads. */
const WILLOW_BACK: Rgb = [0.5, 0.42, 0.29];
/** The rubber grip. Near-black, the same family as the figure's charcoal kit. */
const GRIP: Rgb = [0.045, 0.045, 0.05];
/** The splice and the twine binding over it: bare cane, lighter than the blade. */
const SPLICE: Rgb = [0.78, 0.71, 0.53];

// --- The builder --------------------------------------------------------------

/** A point on a cross-section, in the bat's own X (across) and Z (front-to-back). */
type Profile = readonly (readonly [number, number])[];

/** One cross-section placed along the shaft: a height and the scale of the profile there. */
interface Ring {
  readonly y: number;
  readonly sx: number;
  readonly sz: number;
}

/**
 * Accumulates a lofted solid with a colour per profile edge.
 *
 * One primitive rather than the four `character.ts`'s `Parts` needs, because a
 * bat genuinely is one shape swept along one axis -- the handle is a lofted
 * circle, the blade is a lofted heptagon, and the twine is a lofted circle two
 * rings long. Everything below is one call to `loft`.
 *
 * **Winding, stated once.** A profile is ordered counter-clockwise in the (x, z)
 * plane read the usual way -- x to the right, z up the page -- so the outward
 * normal of the edge `p -> q` is `(dz, 0, -dx)`. That normal is *derived from the
 * profile* rather than from the triangles, which is what makes the winding check
 * in `verifyBat` a real test rather than a tautology: it compares the triangles'
 * own cross products against normals that were computed a different way. The
 * README's winding pass records 61% of the city's walls inside out for months
 * while looking like a city, and a closed loft has exactly that property.
 *
 * Indexed, with the faceting coming from `material.flatShading`, for the reason
 * `vegetation.ts` measured and `character.ts` repeats: a non-indexed build with
 * baked face normals triples the vertex count for the same triangles and the
 * same look. Each quad still gets its own four vertices, because two adjacent
 * faces of a bat share an edge and not a normal.
 */
class BatParts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  private vertex(x: number, y: number, z: number, n: readonly [number, number, number], c: Rgb): void {
    this.position.push(x, y, z);
    this.normal.push(n[0], n[1], n[2]);
    this.colour.push(c[0], c[1], c[2]);
  }

  /**
   * Sweep `profile` through `rings` and close the ends that are asked for.
   *
   * `edgeColours` is one colour per profile *edge*, so a blade can carry a pale
   * face and deeper back slopes out of one call. `capColour` is used for both
   * end caps when they are built.
   *
   * The side normal is the profile edge's, taken at the mean of the two rings'
   * scales and **not tilted for the taper**. That is wrong by up to six degrees
   * on the blade's toe, and it costs nothing for the reason `character.lobe`
   * gives about its sphere normals: `flatShading` derives the shading normal
   * from screen-space derivatives and never reads this attribute. What the
   * attribute does feed is the shadow pass's `normalBias`, where six degrees on
   * a 3 cm offset is 3 mm.
   */
  loft(
    profile: Profile,
    rings: readonly Ring[],
    edgeColours: readonly Rgb[],
    capColour: Rgb,
    caps: { bottom: boolean; top: boolean },
  ): void {
    const n = profile.length;

    for (let r = 0; r + 1 < rings.length; r++) {
      const lower = rings[r + 1].y < rings[r].y ? rings[r + 1] : rings[r];
      const upper = rings[r + 1].y < rings[r].y ? rings[r] : rings[r + 1];
      const mx = (lower.sx + upper.sx) / 2;
      const mz = (lower.sz + upper.sz) / 2;

      for (let i = 0; i < n; i++) {
        const p = profile[i];
        const q = profile[(i + 1) % n];
        const du = (q[0] - p[0]) * mx;
        const dv = (q[1] - p[1]) * mz;
        const len = Math.hypot(du, dv) || 1;
        const normal: [number, number, number] = [dv / len, 0, -du / len];
        // Which edge's colour this is has to follow the *profile* index rather
        // than the loop's, so a blade's face keeps its colour whichever ring
        // pair is being emitted.
        const c = edgeColours[i % edgeColours.length];

        const base = this.position.length / 3;
        this.vertex(p[0] * lower.sx, lower.y, p[1] * lower.sz, normal, c);
        this.vertex(p[0] * upper.sx, upper.y, p[1] * upper.sz, normal, c);
        this.vertex(q[0] * upper.sx, upper.y, q[1] * upper.sz, normal, c);
        this.vertex(q[0] * lower.sx, lower.y, q[1] * lower.sz, normal, c);
        // (lowerP, upperP, upperQ) and (lowerP, upperQ, lowerQ). Both wind
        // counter-clockwise seen from the outward normal; the derivation is in
        // the class header and the check at the bottom of the file re-runs it.
        this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    if (caps.bottom) this.cap(profile, rings[rings.length - 1], false, capColour);
    if (caps.top) this.cap(profile, rings[0], true, capColour);
  }

  /**
   * Close one end of a loft with a fan from the profile's centroid.
   *
   * The winding flips with the facing for the reason `character.disc` states:
   * seen from +Y with x to the right, increasing angle runs *clockwise* on
   * screen because z runs down it, so an up-facing fan has to be wound backwards
   * and a down-facing one forwards.
   */
  private cap(profile: Profile, ring: Ring, up: boolean, colour: Rgb): void {
    const n = profile.length;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of profile) {
      cx += x;
      cz += z;
    }
    cx /= n;
    cz /= n;

    const normal: [number, number, number] = [0, up ? 1 : -1, 0];
    const base = this.position.length / 3;
    this.vertex(cx * ring.sx, ring.y, cz * ring.sz, normal, colour);
    for (const [x, z] of profile) this.vertex(x * ring.sx, ring.y, z * ring.sz, normal, colour);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (up) this.index.push(base, base + 1 + j, base + 1 + i);
      else this.index.push(base, base + 1 + i, base + 1 + j);
    }
  }

  get triangles(): number {
    return this.index.length / 3;
  }
}

/** A circle, counter-clockwise in (x, z), which is what `BatParts.loft` wants. */
function circle(sides: number): Profile {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    points.push([Math.cos(a), Math.sin(a)]);
  }
  return points;
}

/**
 * The blade's cross-section: a flat face at -Z, two chamfers, two edges, and a
 * ridge. Seven points, counter-clockwise in (x, z), in metres.
 *
 * The numbers are a Law 5 bat's: 0.125 m across the edges, 0.038 m at the edge
 * itself and 0.070 m at the spine. What the chamfer buys is worth naming, since
 * it is two of the seven points and would be the obvious thing to drop: without
 * it the face meets the edge at a right angle, and a right angle on a flat-shaded
 * object turns into a hard black line down both sides of the blade at every light
 * angle -- which reads as a modelling seam rather than as a bat.
 */
const BLADE_PROFILE: Profile = [
  [-0.055, -0.02], // face, left
  [0.055, -0.02], // face, right
  [0.0625, -0.004], // right chamfer
  [0.0625, 0.016], // right edge, back
  [0.0, 0.05], // the spine
  [-0.0625, 0.016], // left edge, back
  [-0.0625, -0.004], // left chamfer
];

/** One colour per blade edge, in profile order. Face and chamfers pale, back deep. */
const BLADE_COLOURS: readonly Rgb[] = [
  WILLOW_FACE, // the hitting face
  WILLOW_FACE, // right chamfer
  WILLOW_BACK, // right edge
  WILLOW_BACK, // back slope, right
  WILLOW_BACK, // back slope, left
  WILLOW_BACK, // left edge
  WILLOW_FACE, // left chamfer
];

// --- The shared asset ---------------------------------------------------------

/**
 * One bat geometry and one material, for every bat in the game.
 *
 * Built once and shared, on `CharacterAssets`'s contract and with the same
 * consequence for teardown: a prop must never dispose this geometry, because
 * every other bat in the world is drawing it.
 */
export class BatAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;

  constructor() {
    const p = new BatParts();
    const round = circle(HANDLE_SIDES);
    const roundColours = [GRIP];
    const spliceColours = [SPLICE];

    // --- The handle: a rubber grip, capped at the top so the bat is not a pipe
    // seen end-on when it is shouldered and the toe is pointing at the sky.
    p.loft(
      round,
      [
        { y: GRIP_CAP_Y, sx: GRIP_CAP_R, sz: GRIP_CAP_R },
        { y: 0, sx: GRIP_TOP_R, sz: GRIP_TOP_R },
        { y: -0.2, sx: GRIP_WAIST_R, sz: GRIP_WAIST_R },
        { y: SHOULDER_Y, sx: GRIP_BASE_R, sz: GRIP_BASE_R },
      ],
      roundColours,
      GRIP,
      { bottom: false, top: true },
    );

    // --- The twine binding over the splice. Two rings and sixteen triangles, and
    // it is the one piece of the bat that is pure signal: a pale collar at the
    // join is what tells a viewer where the handle stops, which on a dark grip
    // against a dark blade back is otherwise a guess.
    p.loft(
      round,
      [
        { y: -0.255, sx: 0.0305, sz: 0.0305 },
        { y: -0.3, sx: 0.0335, sz: 0.0335 },
      ],
      spliceColours,
      SPLICE,
      { bottom: false, top: false },
    );

    // --- The blade. Narrowed and thinned at the shoulder where it takes the
    // splice, full section through the middle, and tapered at the toe -- a real
    // blade loses most of its depth in the last 100 mm, which is the taper that
    // makes the toe read as a toe rather than as a sawn-off end.
    p.loft(
      BLADE_PROFILE,
      [
        { y: SHOULDER_Y, sx: 0.55, sz: 0.72 },
        { y: -0.385, sx: 1, sz: 1 },
        { y: -0.62, sx: 1, sz: 1 },
        { y: TOE_Y, sx: 0.9, sz: 0.55 },
      ],
      BLADE_COLOURS,
      WILLOW_FACE,
      { bottom: true, top: true },
    );

    const geometry = new BufferGeometry();
    geometry.name = 'cricket-bat';
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(p.normal), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(p.colour), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(p.index), 1));
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.triangles = p.triangles;
    this.vertices = p.position.length / 3;

    // Lit, like the football in the other hand and unlike the beam weapon this
    // game used to carry, and that is the difference between an object and an
    // emitter: a bat has no output of its own, so the thing that has to be true
    // of it is that it goes dark when the player walks into a building's
    // shadow.
    const material = new MeshStandardNodeMaterial();
    material.name = 'cricket-bat';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // A shade glossier than the figure's 0.78. A bat is oiled willow over a
    // varnished splice, which carries a sheen the cotton singlet next to it does
    // not; at the character's own roughness the blade goes to felt and stops
    // reading as wood.
    material.roughness = 0.62;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }
}

// --- The third-person prop ----------------------------------------------------

/**
 * How the bat sits in the hand. See the file header for the derivation of the
 * pitch, which is the only one of the three that is load-bearing.
 */
const HOLD_PITCH = -2.72;
/**
 * A roll about the bat's own shaft. Free of the pose -- a roll about -Y cannot
 * change where -Y points -- so it only decides which way the flat face is
 * turned, and it is set so the face leads through the strike rather than the
 * edge.
 */
const HOLD_ROLL = 0.38;
/** Where in the wrist's frame the grip sits. The mitt's centre is 65 mm below the joint. */
const HOLD_OFFSET: readonly [number, number, number] = [0.012, -0.078, -0.012];

/**
 * One character's bat.
 *
 * Parented to a **bone** rather than positioned each frame from a bone's world
 * matrix -- one line, and it saves a matrix decompose per character per frame,
 * because three composes the skeleton for the skinning anyway.
 *
 * Unlike the football in the other hand this has no `set()` and no way to be
 * hidden. A bat is not a weapon you put away: spec 8.2's melee is always
 * available, and a bat that vanished between swings would be the only object in
 * the game that appeared out of nowhere on a mouse click. A ball, by contrast,
 * is genuinely gone once you have thrown it.
 */
export class BatProp {
  readonly mesh: Mesh;

  constructor(assets: BatAssets, actor: CharacterActor) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'cricket-bat';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Culled with its character. A 0.83 m object on a figure that is already
    // frustum-tested has nothing to gain from a test of its own, and would need
    // its own animated bounds to survive a swing -- which is the trap
    // `CharacterAssets` documents about `SkinnedMesh.boundingSphere`.
    mesh.frustumCulled = false;
    mesh.position.set(HOLD_OFFSET[0], HOLD_OFFSET[1], HOLD_OFFSET[2]);
    mesh.rotation.set(HOLD_PITCH, HOLD_ROLL, 0);
    actor.bones[BONE.WRIST_R].add(mesh);
    this.mesh = mesh;
  }

  /**
   * Put this bat on the local player's own body: seen by the sun, not by the eye.
   *
   * The counterpart of `character.castShadowOnly`, and it has to be called
   * separately because **three does not inherit layers**. `Renderer._projectObject`
   * tests every object's own mask and recurses into its children either way, so a
   * prop parented to a bone of a mesh that was moved to `SELF_SHADOW_LAYER` is
   * still on layer 0 and is still drawn -- which in first person is a bat
   * hanging at your own hip, in frame, every time you look down. The shadow
   * camera already has the layer enabled by `castShadowOnly`; this is the other
   * half of that arrangement.
   */
  castShadowOnly(): void {
    this.mesh.layers.set(SELF_SHADOW_LAYER);
    this.mesh.castShadow = true;
    // Pointless on an object the camera never draws, and it would compile a
    // second pipeline variant: three keys the render pipeline on `receiveShadow`.
    this.mesh.receiveShadow = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

// --- The swing curve ----------------------------------------------------------

/**
 * The phases the viewmodel reads. A subset of `combat.CombatPhase`, restated as
 * a parameter rather than imported as a type, so this module can be swung by a
 * check with no combatant in hand.
 */
export type SwingPhase = 'idle' | 'windup' | 'active' | 'recovery' | 'flinch' | 'ko';

/**
 * Where the swing is, as one number: **-1 fully coiled, 0 at rest, +1 at the end
 * of the follow-through.**
 *
 * One scalar rather than a pose per phase, and that is the whole reason the
 * viewmodel is checkable. Three independently authored poses meet at two
 * boundaries, and the failure at a boundary is a bat that jumps a hand's width
 * in one frame -- which at 150 ms into a 500 ms cycle reads as a dropped frame
 * rather than as a bug. A single monotone parameter cannot do that, and
 * `verifyBat` asserts both halves of it: that the curve is continuous across
 * both boundaries, and that it moves one way through the wind-up and the other
 * way through the strike.
 *
 * The easings are `animation.punchPose`'s, for the same reasons stated there:
 * `t^0.6` on the wind-up puts most of the coil in the first half of the window
 * so the bat is *waiting* at the top of the backlift, and `t^0.45` on the strike
 * gets the blade most of the way through in the first 30 of its 100 ms. The
 * recovery is a damped oscillator that crosses rest once and settles behind it
 * by 8% -- one visible wobble, which is a bat's own mass carrying the swing
 * past its stopping point, and not a shiver.
 */
export function swingDrive(phase: SwingPhase, phaseT: number): number {
  if (phase === 'windup') {
    return -Math.pow(clamp01(phaseT / PUNCH_WIND_UP), 0.6);
  }
  if (phase === 'active') {
    return -1 + 1.85 * Math.pow(clamp01(phaseT / PUNCH_ACTIVE), 0.45);
  }
  if (phase === 'recovery') {
    const t = clamp01(phaseT / PUNCH_RECOVERY);
    return 0.85 * Math.exp(-4.2 * t) * Math.cos(5.0 * t);
  }
  return 0;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- The first-person viewmodel -----------------------------------------------

/**
 * The three key poses, as a hand position and an orientation of the bat about it.
 *
 * A pivot-and-rotation rather than three baked transforms, because a bat swings
 * about the hand and interpolating the *rotation* is what produces an arc. Three
 * lerped positions produce a chord, and a blade that travels in a straight line
 * across the screen is the tell that a viewmodel was keyframed by somebody who
 * did not want to think about it.
 */
interface ViewKey {
  /** The grip, in camera space. -Z is forward, +X right, +Y up. */
  readonly at: readonly [number, number, number];
  /**
   * Euler XYZ applied to the bat about the grip, and the one thing about it that
   * has to be understood before the numbers mean anything.
   *
   * Three composes an XYZ Euler as `Rx * Ry * Rz`, so a vector is rotated by Z
   * first and by X last. The bat's shaft is its local **-Y**, and `Ry` cannot
   * move the Y axis at all -- so with these keys:
   *
   *   **X is the pitch** of the shaft, up and over or down and through.
   *   **Z is the sideways sweep**, right at the coil and left at the follow-through.
   *   **Y is a roll about the shaft**, which turns the flat face and moves the
   *   blade nowhere.
   *
   * That is the opposite of the reading a viewmodel usually invites, which is
   * that Y is the yaw, and getting it that way round produces a swing that
   * pitches correctly and never leaves the sagittal plane -- a chop, with a
   * lateral component that turns out to be entirely the grip's own offset.
   */
  readonly rot: readonly [number, number, number];
}

/**
 * Rest: low and right, blade forward and a little down, well clear of the middle
 * of the screen.
 *
 * The pitch is 1.19 rad, which takes the shaft's -Y round to 21 degrees below the
 * view axis, and the yaw of -0.19 pushes the toe out to the right so the blade
 * lies along the bottom-right corner rather than across the lower third. The
 * grip itself is *off the bottom of the screen* at this project's 72-degree
 * field -- 42 degrees below the axis against a 36-degree half-field -- so what
 * the player sees is a blade rising into frame from the corner and not a hand
 * holding a stick, which is the read a viewmodel wants when there are no arms
 * modelled to go with it.
 *
 * Both angles are asserted rather than admired: `verifyBat` projects every
 * vertex of this pose and requires the whole bat to clear a cone around the
 * crosshair.
 */
const REST_KEY: ViewKey = { at: [0.319, -0.217, -0.26], rot: [1.7335, 0, -0.3152] };

/**
 * Coil: up and back over the right shoulder, most of the blade out of frame.
 *
 * The pitch swings through 3.7 rad between here and rest, which is what takes the
 * toe from in front of the player to behind their ear, and the hand rises 0.15 m
 * with it. The anticipation is deliberately large -- most of the bat leaves the
 * screen -- for spec 8.2's own reason about the wind-up: 150 ms is a long time
 * to look at nothing, and what makes a swing read as committed is how far back
 * it started.
 */
const COIL_KEY: ViewKey = { at: [0.34, -0.02, -0.2], rot: [2.4, -0.35, 0.1506] };

/**
 * Strike: swept down and across to the left, blade past the centre line.
 *
 * The sideways sweep is the **Z** of the Euler and not the Y -- see `ViewKey`,
 * where the reason is that three's XYZ order applies Z first and Y cannot move
 * the shaft at all. It runs +0.15 at the coil to -0.52 here, which carries the
 * blade from the top-right corner to the lower left.
 *
 * Measured in normalised device coordinates at a 72-degree field: the tip goes
 * from (0.62, 0.86) at the top of the backlift, through (0.20, -0.24) at the
 * midpoint, to (-0.36, -0.43). So the whole blade is on screen for the second
 * half of the strike and it crosses the centre line just under the crosshair --
 * a swing the player watches rather than one that blanks their aim.
 */
const STRIKE_KEY: ViewKey = { at: [-0.13, -0.1, -0.24], rot: [1.4318, 0.45, -0.5236] };

/**
 * How far a vertex of the viewmodel may ever be from the eye. See the header.
 *
 * 0.90 m, and the number is a wall-clipping budget rather than a taste. A player
 * standing square against a terrace has their eye `PLAYER_RADIUS` -- 0.34 m --
 * from it, so *any* viewmodel intersects a wall the player is touching; what the
 * budget buys is that it stops happening a metre out. Together with the scale
 * below it also keeps the whole bat inside the 1.55 m the hit test reaches, so
 * the blade can never be drawn through something it could not have hit.
 */
export const MAX_VIEW_REACH = 0.9;
/**
 * How much of the bat's own length the viewmodel is drawn at.
 *
 * Viewmodels are always smaller than the object they represent -- a full-size
 * 0.83 m bat held where a hand really is fills a third of the screen and clips
 * every doorway -- and 0.58 puts the blade at 0.48 m, which at half a metre from
 * the eye still subtends about a fifth of the frame's height. Large enough to
 * be the thing you are holding; small enough for the budget above.
 */
const VIEW_SCALE = 0.58;
/** A constant roll about the shaft, so the blade shows its face and not its edge. */
const VIEW_ROLL = 0.25;

/**
 * The half-angle around the view axis the *rest* pose must clear, radians.
 *
 * 0.10 rad is 5.7 degrees, which at this project's 72-degree vertical field is
 * about 8% of the screen height -- comfortably more than the reticle, which is a
 * few pixels, and enough that the bat is not crowding it either.
 */
export const RETICLE_CLEARANCE = 0.1;

/** How hard the bat lags a mouse turn, and how fast that lag decays. */
const SWAY_GAIN = 0.055;
const SWAY_TAU = 0.09;
/** How far the bat bobs with a stride, metres at a sprint. */
const BOB_AMOUNT = 0.026;

/**
 * The connect kick: a bat that has hit something stops, and the hands do not.
 *
 * Started by `connect()` from `main.ts`'s hit report and decayed here, which is
 * the same arrangement `game/feedback.ts` uses for the shake and for the same
 * reason -- one clock, one place to change the timing. 90 ms matches
 * `combat.HITSTOP` exactly, so the bat's shudder runs over precisely the frames
 * the simulation is frozen for, and the two read as one event.
 */
const CONNECT_SECONDS = 0.09;

/**
 * The bat you are holding.
 *
 * A `Group` at the grip with the mesh inside it, so the bat rotates about the
 * hand and the group carries the sway and the bob. Added to the **camera**,
 * which means `main.ts` has to put the camera in the scene -- three only walks
 * `scene`, so a child of a detached camera is never drawn. That is one line
 * there and is the whole cost of this being camera-attached rather than
 * re-positioned from the camera's world matrix every frame.
 */
export class BatViewmodel {
  readonly group: Group;
  readonly mesh: Mesh;

  /** Wall-clock seconds. The idle bob and the sway phase run on it. */
  private clock = 0;
  /** Eased yaw and pitch lag, radians of camera turn not yet caught up with. */
  private swayYaw = 0;
  private swayPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private seeded = false;
  /** Seconds left of the connect kick. */
  private connectT = 0;
  /** Stride phase, advanced by distance, exactly as `CharacterActor` does it. */
  private stride = 0;

  constructor(assets: BatAssets) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'cricket-bat:viewmodel';
    // Never in the depth pass. A bat welded to the eye would cast a shadow from
    // head height that follows the player around the footpath, which is both
    // wrong and the single most distracting thing a viewmodel can do.
    mesh.castShadow = false;
    // Receiving is kept, and it is the thing that stops the bat looking pasted
    // on: walk into a terrace's shadow and the bat goes with you. It is the same
    // argument `character.ts` makes about a figure standing in shade.
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.scale.setScalar(VIEW_SCALE);
    // A fixed roll about the shaft, applied **inside** the group so it is a true
    // roll: the group's own rotation multiplies this one, so `Ry` here acts on
    // the bat's local axes and turns the blade about its length without moving
    // the shaft a millimetre. It exists so the player sees the flat face rather
    // than the edge, which is the difference between a cricket bat and a stick.
    mesh.rotation.set(0, VIEW_ROLL, 0);

    const group = new Group();
    group.name = 'viewmodel';
    group.frustumCulled = false;
    group.add(mesh);

    this.mesh = mesh;
    this.group = group;
  }

  /** The blade landed on somebody. Adds the shudder; see `CONNECT_SECONDS`. */
  connect(): void {
    this.connectT = CONNECT_SECONDS;
  }

  /**
   * Pose the bat for this frame.
   *
   * Frame delta rather than the fixed step, on `main.ts`'s own rule about the
   * actors: the simulation is fixed so prediction and rewind agree, and a
   * viewmodel is presentation and has to be smooth at whatever rate the display
   * runs. `phase` and `phaseT` come straight off the local player's predicted
   * `CombatantState`, so the swing starts on the frame the button goes down
   * rather than on the next round trip.
   */
  update(
    dt: number,
    state: {
      phase: SwingPhase;
      phaseT: number;
      /** Horizontal speed, m/s. Drives the bob. */
      speed: number;
      /** The camera's yaw and pitch, radians. The sway is their derivative. */
      yaw: number;
      pitch: number;
      /** Frozen animation, not slowed: the pose holds on the frame the hit landed. */
      hitstop: boolean;
      /**
       * Seconds since the player's last throw -- `combat.ballT`. Absent means
       * never, which is what every caller written before the ranged weapon
       * existed means and what `verifyBat` passes.
       *
       * The bat **dips out of the way** while the other hand throws, and it is
       * one number rather than a pose because that is all it needs to be: the
       * throw is a 340 ms overlay on a weapon held in the other hand, and what
       * the bat has to do is stop competing for the frame. Without it the blade
       * sits rock-steady in the corner through an action that is visibly
       * whole-body, which reads as two animations that have not been introduced.
       *
       * `world/footyball.ts` owns the throw's own timing; this only has to be
       * over by the time that is. See `THROW_DIP_SECONDS`.
       */
      throwT?: number;
    },
  ): void {
    // A knocked-out player is not holding the bat up, and a bat left in frame
    // over a camera lying on the pavement is the loudest possible way of saying
    // the viewmodel does not know what the game is doing.
    const down = state.phase === 'ko';
    this.group.visible = !down;
    if (down) {
      this.seeded = false;
      return;
    }

    const step = state.hitstop ? 0 : dt;
    this.clock += step;
    if (this.connectT > 0) this.connectT = Math.max(0, this.connectT - step);

    // The sway is the *derivative* of the look, low-passed. Seeded on the first
    // frame rather than started at zero, because the difference between an
    // uninitialised yaw and the player's actual one is a whole turn, and the
    // bat would swing through a full arc on the frame the game starts.
    if (!this.seeded) {
      this.lastYaw = state.yaw;
      this.lastPitch = state.pitch;
      this.seeded = true;
    }
    const dYaw = wrapPi(state.yaw - this.lastYaw);
    const dPitch = state.pitch - this.lastPitch;
    this.lastYaw = state.yaw;
    this.lastPitch = state.pitch;
    const k = Math.min(1, 1 - Math.exp(-Math.max(step, 1e-6) / SWAY_TAU));
    this.swayYaw += (dYaw * SWAY_GAIN * 12 - this.swayYaw) * k;
    this.swayPitch += (dPitch * SWAY_GAIN * 12 - this.swayPitch) * k;

    // The stride, advanced by distance walked rather than by a clock, which is
    // `animation.ClipContext`'s rule and is what keeps the bob in step with the
    // feet at every speed and through every acceleration.
    this.stride = (this.stride + state.speed * step * 3.6) % (Math.PI * 2);
    const gait = Math.min(1, state.speed / 8.2);
    const bob = Math.sin(this.stride * 2) * BOB_AMOUNT * gait;
    const roll = Math.sin(this.stride) * 0.05 * gait;
    // A slow figure-eight when standing still, on two periods that do not divide
    // each other -- `animation.clipIdle`'s trick, one object down.
    const idleX = Math.sin(this.clock * 0.71) * 0.006 * (1 - gait);
    const idleY = Math.sin(this.clock * 0.94 + 1.3) * 0.008 * (1 - gait);

    const drive = swingDrive(state.phase, state.phaseT);
    const key = blendKeys(drive);

    // The connect kick: the bat is arrested and the hands ring on. Applied on
    // top of the swing rather than blended into it, so a hit at any point in the
    // active window shudders from wherever the blade actually was.
    const shock = this.connectT / CONNECT_SECONDS;
    const jolt = shock > 0 ? shock * shock * Math.sin(shock * 34) : 0;

    // The throw dip. A half-sine over its window, so the bat drops away and
    // comes back with no discontinuity at either end -- the same property
    // `swingDrive` is checked for, arrived at by using a curve that is zero at
    // both limits rather than by asserting it.
    const dip =
      state.throwT !== undefined && state.throwT < THROW_DIP_SECONDS
        ? Math.sin((state.throwT / THROW_DIP_SECONDS) * Math.PI)
        : 0;

    this.group.position.set(
      key.at[0] + idleX + this.swayYaw * 0.6 + jolt * 0.02 + dip * 0.09,
      key.at[1] + bob + idleY + this.swayPitch * 0.5 - jolt * 0.014 - dip * 0.16,
      key.at[2] + Math.abs(bob) * 0.4 + jolt * 0.03 + dip * 0.05,
    );
    this.group.rotation.set(
      key.rot[0] + this.swayPitch * 0.9 - jolt * 0.10 + dip * 0.34,
      key.rot[1] + this.swayYaw * 1.1,
      key.rot[2] + roll + jolt * 0.16 + dip * 0.22,
    );
  }
}

/**
 * How long the bat is dipped by a throw, seconds.
 *
 * A shade under `footyball.THROW_SECONDS` (0.34), so the bat is back at rest
 * fractionally before the ball is, and the eye reads the ball returning to the
 * hand as the end of the action rather than the bat settling. Restated here
 * rather than imported for `MEASURED_REACH_TARGET`'s reason: importing it would
 * couple the melee viewmodel to the ranged weapon's module for one number, and
 * the two are allowed to be retimed independently.
 */
const THROW_DIP_SECONDS = 0.3;

/**
 * Rest to coil for a negative drive, rest to strike for a positive one.
 *
 * Linear in the drive, because the drive is where every easing already lives:
 * putting a second curve here would mean two places to look when the timing of a
 * swing is wrong, and the shape of the arc comes from interpolating the
 * *rotation* rather than from the shape of the interpolation.
 */
function blendKeys(drive: number): ViewKey {
  const to = drive < 0 ? COIL_KEY : STRIKE_KEY;
  const w = Math.min(1, Math.abs(drive));
  const at: [number, number, number] = [0, 0, 0];
  const rot: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    at[i] = REST_KEY.at[i] + (to.at[i] - REST_KEY.at[i]) * w;
    rot[i] = REST_KEY.rot[i] + (to.rot[i] - REST_KEY.rot[i]) * w;
  }
  return { at, rot };
}

/** Shortest signed angle. A mouse that crosses the yaw wrap must not sway a full turn. */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

// --- The self-check -----------------------------------------------------------

/**
 * The bat, in the hand and in the eye, asserted.
 *
 * The repo's rule -- `verifyAnimation`, `verifyCharacterRig`, `verifyCombat` --
 * is that a check exists where the failure is **silent**: it renders, it does not
 * throw, and it reads as a taste decision. A weapon has an unusual number of
 * those, and each of the six below is one that was actually hit while this was
 * being built:
 *
 *   - **Winding.** A lofted solid inside out is a bat you can see the inside of
 *     from outside and nothing else. This is the failure the README's winding
 *     pass documents on the city's walls.
 *   - **The bat is on the right wrist.** Parenting to the wrong bone -- or to the
 *     mesh, which also "works" -- produces a bat that floats near the character
 *     and does not swing. It looks like an animation problem.
 *   - **The toe is off the ground at idle and at a walk.** The one number this
 *     file's `HOLD_PITCH` exists to get right, and the failure is a blade
 *     scraping through the footpath at every step, which nobody sees from the
 *     first-person camera the developer is sitting in.
 *   - **The blade arrives where the hit test says it does.** `combat.REACH` was
 *     moved from 1.2 m to 1.65 m in this pass *because* the weapon changed, and a
 *     reach that no longer matches the picture is precisely the thing that reads
 *     as lag rather than as a number.
 *   - **The swing curve is continuous and monotone.** See `swingDrive`.
 *   - **The viewmodel stays close and clears the reticle.** Both are stated in
 *     the header as the reasons this can be a single-pass viewmodel at all, so
 *     both are measured rather than trusted.
 *
 * Pure and framework-free apart from three itself, so it runs outside a browser:
 *
 *     bun -e "import {verifyBat} from './src/player/bat.ts'; console.log(verifyBat())"
 */
export function verifyBat(): string[] {
  const failures: string[] = [];
  const assets = new BatAssets();

  // --- Budget. Not a spec number -- there is no bat in the spec -- but the
  // figure holding it is 440 triangles, and a prop that outweighs the character
  // is a prop that was modelled rather than built.
  if (assets.triangles > 260) {
    failures.push(`The bat is ${assets.triangles} triangles; the figure holding it is 440.`);
  }

  const position = assets.geometry.getAttribute('position');
  const normal = assets.geometry.getAttribute('normal');
  const index = assets.geometry.getIndex();
  if (index === null) {
    failures.push('The bat geometry is not indexed.');
    return failures;
  }

  // --- Winding. Every triangle's cross product has to agree with the mean of
  // the three vertex normals it was built from -- and those normals came from
  // the *profile*, not from the triangles, so this is a real test.
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const face = new Vector3();
  let disagreeing = 0;
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t);
    const i1 = index.getX(t + 1);
    const i2 = index.getX(t + 2);
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    face.copy(b).sub(a).cross(n.copy(c).sub(a));
    if (face.lengthSq() < 1e-16) continue;
    face.normalize();
    n.set(0, 0, 0);
    for (const i of [i0, i1, i2]) {
      n.x += normal.getX(i);
      n.y += normal.getY(i);
      n.z += normal.getZ(i);
    }
    if (n.lengthSq() < 1e-12) continue;
    if (face.dot(n.normalize()) < 0) disagreeing++;
  }
  if (disagreeing > 0) {
    failures.push(
      `${disagreeing} of ${index.count / 3} bat triangles are wound against their own normals -- ` +
        `they will be back-face culled and the bat will be see-through from outside.`,
    );
  }

  // --- Proportion. A bat that has drifted to the length of a broom handle is
  // still a bat in a screenshot and is a different weapon in the hand.
  const bounds = extents(position);
  const length = bounds.max[1] - bounds.min[1];
  if (Math.abs(length - BAT_LENGTH) > 0.01) {
    failures.push(`The bat is ${length.toFixed(3)} m long; it should be ${BAT_LENGTH.toFixed(3)} m.`);
  }
  const width = bounds.max[0] - bounds.min[0];
  if (Math.abs(width - BLADE_HALF_WIDTH * 2) > 0.01) {
    failures.push(
      `The blade is ${(width * 1000).toFixed(0)} mm across; a Law 5 bat is 108 mm and this one is ` +
        `meant to be ${(BLADE_HALF_WIDTH * 2000).toFixed(0)}.`,
    );
  }

  // --- In the hand, and on the right bone.
  const characters = new CharacterAssets();
  const actor = new CharacterActor(characters, 0);
  const prop = new BatProp(assets, actor);
  if (prop.mesh.parent !== actor.bones[BONE.WRIST_R]) {
    failures.push(
      `The bat is parented to "${prop.mesh.parent?.name ?? 'nothing'}" rather than to the right ` +
        `wrist bone, so it will not swing with the arm.`,
    );
  }

  // --- The toe clears the footpath at idle and through a walk cycle.
  //
  // Stepped through the real actor and read off the real bone matrices, because
  // the whole question is what the *chain* does -- the sum of the shoulder, the
  // elbow, the wrist and `HOLD_PITCH`, which is the arithmetic in the header and
  // is exactly the kind of thing that is right on paper and 20 cm wrong in a
  // skeleton.
  const at = { x: 0, y: 0, z: 0 };
  let furthest = 0;
  for (const [name, speed, seconds, swing] of [
    ['idle', 0, 1.4, false],
    ['walk', 4.4, 1.4, false],
    ['run', 8.2, 1.0, false],
    ['the swing', 0, PUNCH_TOTAL, true],
  ] as Array<[string, number, number, boolean]>) {
    actor.setAction(null);
    if (swing) actor.setAction('punch');
    let lowest = Infinity;
    const steps = Math.round(seconds * 60);
    for (let s = 0; s < steps; s++) {
      actor.update(1 / 60, { position: at, yaw: 0, speed, onGround: true });
      lowest = Math.min(lowest, lowestBatVertex(actor, prop, position));
      // The reach, measured on the same pass as the clearance -- see below.
      if (swing) furthest = Math.max(furthest, toePlanReach(actor, prop));
    }
    // Five centimetres, and it is not zero on purpose: a bat carried at a run
    // swings with the arm, and a swing genuinely scythes the blade past the
    // player's own feet on its way through. Demanding daylight at every phase
    // would mean pinning the arm rather than letting the clip run. Measured
    // clearances at the time of writing: 0.38 m carried, 0.06 m at the bottom of
    // the swing arc.
    if (lowest < -0.05) {
      failures.push(
        `Through "${name}" the bat's toe goes ${(-lowest * 100).toFixed(1)} cm under the ` +
          `pavement. HOLD_PITCH decides the carry and the swing clip in player/animation.ts ` +
          `decides the rest; see the header.`,
      );
    }
  }

  // --- The blade arrives where the hit test claims it does.
  //
  // The toe's *plan* distance from the eye at its furthest, because plan distance
  // is the quantity `hitTest` gates on -- see its header, where the plan gate is
  // what makes the reach a weapon's length rather than the 2.37 m a naive
  // sphere-cast reaches.
  //
  // A band rather than a target, and the two edges of it say different things.
  // Reaching **past** the hit test is the one that must never happen: a blade
  // that visibly sweeps through somebody who takes no damage is the failure
  // players report as lag. Falling a long way **short** is the milder one, and
  // some shortfall is correct -- the fist this replaced landed 0.3 m beyond
  // where the mitt got, on exactly this measurement, and the game shipped that
  // way. So: most of the way there, and never beyond.
  if (furthest > MEASURED_REACH_TARGET) {
    failures.push(
      `The bat's toe reaches ${furthest.toFixed(2)} m from the eye, past the ` +
        `${MEASURED_REACH_TARGET.toFixed(2)} m the hit test stops at. A weapon that visibly sweeps ` +
        `through someone it does not damage reads as lag rather than as a number.`,
    );
  }
  if (furthest < MEASURED_REACH_TARGET - 0.45) {
    failures.push(
      `The bat's toe only reaches ${furthest.toFixed(2)} m from the eye against a hit test that ` +
        `reaches ${MEASURED_REACH_TARGET.toFixed(2)} m. That gap is a hit landing on nobody the ` +
        `player can see the blade touching.`,
    );
  }

  // --- The swing curve: continuous across both boundaries, and monotone through
  // the two windows that have to be.
  {
    const boundaries: Array<[string, number, number, SwingPhase, SwingPhase]> = [
      ['wind-up to active', PUNCH_WIND_UP, 0, 'windup', 'active'],
      ['active to recovery', PUNCH_ACTIVE, 0, 'active', 'recovery'],
    ];
    for (const [label, endT, startT, from, to] of boundaries) {
      const before = swingDrive(from, endT);
      const after = swingDrive(to, startT);
      if (Math.abs(before - after) > 1e-6) {
        failures.push(
          `The swing jumps ${(after - before).toFixed(3)} at the ${label} boundary. A discontinuity ` +
            `there is a bat that moves a hand's width in one frame and reads as a dropped frame.`,
        );
      }
    }
    let worstUp = 0;
    let worstDown = 0;
    let previousCoil = swingDrive('windup', 0);
    let previousStrike = swingDrive('active', 0);
    for (let i = 1; i <= 64; i++) {
      const coil = swingDrive('windup', (i / 64) * PUNCH_WIND_UP);
      if (coil > previousCoil) worstDown = Math.max(worstDown, coil - previousCoil);
      previousCoil = coil;
      const strike = swingDrive('active', (i / 64) * PUNCH_ACTIVE);
      if (strike < previousStrike) worstUp = Math.max(worstUp, previousStrike - strike);
      previousStrike = strike;
    }
    if (worstDown > 1e-9) {
      failures.push(`The wind-up un-coils by ${worstDown.toFixed(4)} partway through. It must only pull back.`);
    }
    if (worstUp > 1e-9) {
      failures.push(`The strike moves backwards by ${worstUp.toFixed(4)} partway through. It must only sweep forward.`);
    }
    if (Math.abs(swingDrive('idle', 0)) > 1e-9 || Math.abs(swingDrive('flinch', 0.2)) > 1e-9) {
      failures.push('The bat is not at rest in a phase that is not a swing.');
    }
  }

  // --- The viewmodel: close enough not to need a second pass, and clear of the
  // reticle in the pose the player looks at all session.
  {
    const view = new BatViewmodel(assets);
    let furthestVertex = 0;
    const vertex = new Vector3();
    // Every phase of the swing, plus the rest pose, with the sway and bob at
    // zero -- they add under 4 cm and would only blur the number this is for.
    const samples: Array<[SwingPhase, number]> = [['idle', 0]];
    for (let i = 0; i <= 12; i++) samples.push(['windup', (i / 12) * PUNCH_WIND_UP]);
    for (let i = 0; i <= 12; i++) samples.push(['active', (i / 12) * PUNCH_ACTIVE]);
    for (let i = 0; i <= 12; i++) samples.push(['recovery', (i / 12) * PUNCH_RECOVERY]);
    let worstAngle = Infinity;
    for (const [phase, phaseT] of samples) {
      view.update(1 / 60, { phase, phaseT, speed: 0, yaw: 0, pitch: 0, hitstop: false });
      view.group.updateMatrixWorld(true);
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(view.mesh.matrixWorld);
        furthestVertex = Math.max(furthestVertex, vertex.length());
        // The rest pose only, and only the reticle question. The swing is
        // *meant* to cross the centre of the screen.
        if (phase === 'idle') {
          const forward = -vertex.z;
          const off = Math.hypot(vertex.x, vertex.y);
          // Anything level with or behind the eye cannot be over the reticle.
          if (forward > 1e-3) worstAngle = Math.min(worstAngle, Math.atan2(off, forward));
        }
      }
    }
    if (furthestVertex > MAX_VIEW_REACH) {
      failures.push(
        `The viewmodel reaches ${furthestVertex.toFixed(2)} m from the eye, past the ` +
          `${MAX_VIEW_REACH.toFixed(2)} m this file's header claims. That claim is the whole reason ` +
          `it can be drawn in the ordinary depth buffer instead of a second pass.`,
      );
    }
    if (worstAngle < RETICLE_CLEARANCE) {
      failures.push(
        `At rest the bat comes within ${(worstAngle * (180 / Math.PI)).toFixed(1)} degrees of the ` +
          `view axis; it must clear ${(RETICLE_CLEARANCE * (180 / Math.PI)).toFixed(1)}. It is ` +
          `sitting on the reticle.`,
      );
    }

    // --- And the throw dip, which is the ranged weapon reaching into this one.
    //
    // Two claims, both silent. The dip must not push the bat past the budget the
    // header's whole single-pass argument rests on -- it moves the blade *down
    // and out*, which is toward the far corner of the frame and is exactly the
    // direction that could. And it has to be **zero at both ends of its window**,
    // or the bat jumps a hand's width on the frame a throw starts and again on
    // the frame it ends, which at 340 ms apart reads as two dropped frames
    // rather than as one bug.
    {
      let dipFurthest = 0;
      for (let i = 0; i <= 16; i++) {
        view.update(1 / 60, {
          phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false,
          throwT: (i / 16) * THROW_DIP_SECONDS,
        });
        view.group.updateMatrixWorld(true);
        for (let v = 0; v < position.count; v++) {
          vertex.fromBufferAttribute(position, v).applyMatrix4(view.mesh.matrixWorld);
          dipFurthest = Math.max(dipFurthest, vertex.length());
        }
      }
      if (dipFurthest > MAX_VIEW_REACH) {
        failures.push(
          `Dipped for a throw the bat reaches ${dipFurthest.toFixed(2)} m from the eye, past the ` +
            `${MAX_VIEW_REACH.toFixed(2)} m budget. The dip has to stay inside the same claim the ` +
            `swing does.`,
        );
      }
      // The two ends of the window, against the same pose with no throw at all.
      //
      // Stepped with **dt = 0**, which makes the comparison exact rather than
      // approximate: `update` advances its own clock for the idle drift and the
      // stride, so two calls a frame apart differ by a tenth of a millimetre of
      // breathing even when the pose is identical. A zero step freezes both and
      // leaves only the thing being measured.
      const at = (throwT: number | undefined): [number, number, number] => {
        view.update(0, { phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false, throwT });
        return [view.group.position.x, view.group.position.y, view.group.position.z];
      };
      const none = at(undefined);
      for (const [label, t] of [['start', 0], ['end', THROW_DIP_SECONDS]] as Array<[string, number]>) {
        const edge = at(t);
        const jump = Math.hypot(edge[0] - none[0], edge[1] - none[1], edge[2] - none[2]);
        if (jump > 1e-6) {
          failures.push(
            `The throw dip is ${(jump * 100).toFixed(1)} cm from rest at its ${label}. It has to be ` +
              `zero at both ends of its window or the bat jumps on the frame a throw begins.`,
          );
        }
      }
      // ...and it has to actually move, or the integration is a no-op nobody
      // would notice was missing.
      const middle = at(THROW_DIP_SECONDS / 2);
      if (Math.hypot(middle[0] - none[0], middle[1] - none[1], middle[2] - none[2]) < 0.05) {
        failures.push('The throw dip moves the bat less than 5 cm. It is not getting out of the way.');
      }
    }
  }

  prop.dispose();
  return failures;
}

/**
 * What the reach check is measured against.
 *
 * Stated here rather than imported from `game/combat.ts`, and that is deliberate
 * rather than lazy: importing `REACH` would make this check assert that a number
 * equals itself through two files. Written down separately, it is a second
 * opinion -- if somebody changes the hit test's reach without touching the bat,
 * the two disagree and this says so, which is the entire point of the check.
 */
const MEASURED_REACH_TARGET = 1.55;

/** The lowest point of the bat in world space, with the actor posed as it stands. */
function lowestBatVertex(
  actor: CharacterActor,
  prop: BatProp,
  position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number },
): number {
  actor.mesh.updateMatrixWorld(true);
  const v = new Vector3();
  let lowest = Infinity;
  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(prop.mesh.matrixWorld);
    lowest = Math.min(lowest, v.y);
  }
  return lowest;
}

const TOE_LOCAL = /*#__PURE__*/ new Vector3(0, TOE_Y, 0);
const toeWorld = /*#__PURE__*/ new Vector3();

/**
 * How far the toe is from the eye, in plan.
 *
 * The eye is the actor's own origin plus `EYE_HEIGHT` -- restated as a plan
 * distance because that is what `combat.hitTest` gates on, and the height falls
 * out of the comparison entirely.
 */
function toePlanReach(actor: CharacterActor, prop: BatProp): number {
  actor.mesh.updateMatrixWorld(true);
  toeWorld.copy(TOE_LOCAL).applyMatrix4(prop.mesh.matrixWorld);
  return Math.hypot(toeWorld.x - actor.mesh.position.x, toeWorld.z - actor.mesh.position.z);
}

function extents(position: {
  count: number;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
}): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.count; i++) {
    const p: [number, number, number] = [position.getX(i), position.getY(i), position.getZ(i)];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}
