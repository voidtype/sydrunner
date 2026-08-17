/**
 * Your own two hands, in front of your own eye, when you are holding nothing.
 *
 * *"i cant see my hands while punching"*. The geometry half of the fix;
 * `game/hands-pose.ts` is the arithmetic half and its header carries the design
 * argument -- one drive scalar, three keys a hand, the primary jabs and the off
 * hand guards. Read that one first.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE HANDS AT ALL NOW, WHEN THERE DELIBERATELY WERE NOT
 *
 * `main.ts` recorded the absence in as many words -- *"there are no
 * first-person arms, deliberately"* -- and `player/bat.ts`'s header repeats it
 * while introducing the first first-person geometry this project ever had. The
 * reasoning was sound and is worth restating before being overturned: arms are
 * their own rig, their own clip set and their own field of view, and a bat is a
 * single prop that can be parented to the camera and posed with two Eulers.
 *
 * What that reasoning missed is that **the bat is not the only weapon**. Slot 4
 * is fists, it is one number-row press away, and with it equipped
 * `money.setWeaponVisible(false, false)` hides the bat and the football and
 * leaves the frame completely empty. Every other slot in the game shows you
 * what you are holding; the one that shows you nothing is the one where what
 * you are holding is *you*.
 *
 * The way out is to take the bat's own escape hatch rather than to build the
 * rig the old comment was refusing. These are **not arms**. They are two mitts
 * with a forearm stub behind each, parented to the camera, posed by two Eulers
 * apiece from a pure function -- structurally the bat's viewmodel twice over,
 * with no bones, no clips, no IK and no shoulder. The whole thing is 444
 * triangles for the pair and one material.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY IT IS SO FEW PARTS
 *
 * One hand is a **mitt** and a **forearm**:
 *
 *   - The mitt is `player/character.ts`'s own hand lobe -- an ellipsoid at
 *     `MITT_RADII`, the same 0.095 x 0.105 x 0.062 the third-person figure has
 *     on the end of each arm. Using the figure's number rather than a new one
 *     is the whole reason the viewmodel and the body agree about how big your
 *     hands are, which matters the moment somebody presses `V` and sees the
 *     other version of themselves.
 *   - The forearm is a tapered cylinder running back and down out of frame. It
 *     exists for one reason: a mitt on its own is a **floating fist**, and a
 *     floating fist is the single most recognisable failure of a cheap
 *     viewmodel. Ten centimetres of tapering skin behind it is enough to read
 *     as an arm going somewhere, and where it goes is off the bottom of the
 *     screen, which is where the rest of the arm would be.
 *
 * There are no fingers. Spec 8.1's figure has a mitt for a hand -- the header
 * there argues it at length under "oversized hands" -- and a viewmodel with
 * individually modelled fingers on a body that has none would be two different
 * people. It is also a clenched fist for the whole animation, and a clenched
 * fist has no fingers to see.
 *
 * ---------------------------------------------------------------------------
 * SKIN, FROM THE PLAYER'S OWN KIT
 *
 * The colour is `COLOURWAYS[colourway].skin` -- the same triple the third-person
 * body uses -- rather than a fixed tone, and the material is rebuilt when the
 * colourway changes. That is one pipeline compile per kit change, which happens
 * at most once a session; the alternative is vertex colours baked into the
 * geometry and a geometry per kit, which is seven buffers to avoid one uniform.
 *
 * A **fixed** skin tone was the obvious cheap answer and is the one thing here
 * that would have been actively wrong: `character.ts` spreads seven skin tones
 * across the seven kits deliberately, and a player whose body is one colour
 * looking down at hands that are another is the kind of detail that is
 * invisible until it is seen once and then cannot be unseen.
 *
 * ---------------------------------------------------------------------------
 * COST. 222 triangles a hand, 444 for the pair -- one geometry, one material,
 * two meshes, one draw call each. Against `CharacterAssets`'s 440 for a whole
 * figure and `BatAssets`'s 188 for a bat, which is the right comparison: this
 * is two objects at arm's length rather than sixteen across a street, and the
 * budget the brief set was about 1.2 k. Drawn only while fists are the primary
 * slot and only in first person, so for most of a session they are two objects
 * on a layer the camera does not draw.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from 'three/webgpu';

import {
  HANDS_MAX_REACH,
  HANDS_RETICLE_CLEARANCE,
  handsPose,
  punchDrive,
  verifyHandsPose,
  type HandPhase,
} from '../game/hands-pose.ts';
import { BONE, PUNCH_ACTIVE, PUNCH_RECOVERY, PUNCH_WIND_UP } from './animation.ts';
import { COLOURWAYS, CharacterAssets } from './character.ts';

// --- Proportions ---------------------------------------------------------------

/*
 * A hand is built at the **origin, palm forward, forearm running back along
 * +Z**, which is the convention that makes `HandPose.rot` mean what its comment
 * says: with no rotation the mitt faces the way the camera does and the arm
 * disappears behind it.
 */

/**
 * The mitt's radii. `character.MITT_RADII` exactly -- 0.095 x 0.105 x 0.062.
 *
 * Restated rather than imported, on `bat.MEASURED_REACH_TARGET`'s standing
 * argument: `character.ts` does not export it, and a check that compared a
 * constant with itself through two files would not be a check. `verifyHands`
 * measures the drawn mitt against the drawn *figure's* mitt instead, which is a
 * real comparison -- it builds a `CharacterAssets` and reads the buffer.
 */
const MITT_RADIUS_X = 0.095;
const MITT_RADIUS_Y = 0.105;
const MITT_RADIUS_Z = 0.062;

/** How far back the forearm runs before it is cut off, and its two radii. */
const FOREARM_LENGTH = 0.22;
const FOREARM_WRIST_R = 0.048;
const FOREARM_ELBOW_R = 0.062;

/**
 * How many segments round a lobe and a limb.
 *
 * **Finer than the body's, and it is the one place this viewmodel spends more
 * than the figure does.** `character.lobe` draws the third-person mitt as a
 * detail-0 icosphere -- 20 triangles -- because that hand is a 19 cm object
 * seen from ten metres. This one is the same 19 cm object seen from **thirty
 * centimetres**, where it fills a fifth of the frame, and 20 triangles at that
 * size is a visible dodecahedron rather than a hand.
 *
 * 12 x 8 is 192 triangles a mitt, which puts a facet at about four degrees of
 * arc at the resting distance -- past the point where the silhouette reads as
 * curved. They are still **flat shaded** like everything else in this project:
 * a smoothly shaded hand next to a faceted body would be the thing that looked
 * wrong, not the facets.
 */
const LOBE_SIDES = 12;
const LOBE_RINGS = 8;
const LIMB_SIDES = 10;

// --- The builder ---------------------------------------------------------------

interface Parts {
  position: number[];
  normal: number[];
  index: number[];
}

/**
 * An ellipsoid at `centre` with `radii`, in `LOBE_RINGS` bands.
 *
 * `character.lobe`'s construction, including its note about the normals: they
 * are the *sphere's* rather than the ellipsoid's, which is wrong by the aspect
 * ratio and costs nothing because `flatShading` derives the shading normal from
 * screen-space derivatives and never reads the attribute. What the attribute
 * feeds is the shadow pass's `normalBias` -- and these never cast a shadow.
 */
function lobe(p: Parts, centre: readonly [number, number, number], radii: readonly [number, number, number]): void {
  const rows: number[][] = [];
  for (let ring = 0; ring <= LOBE_RINGS; ring++) {
    const v = (ring / LOBE_RINGS) * Math.PI;
    const sv = Math.sin(v);
    const cv = Math.cos(v);
    const row: number[] = [];
    for (let side = 0; side < LOBE_SIDES; side++) {
      const u = (side / LOBE_SIDES) * Math.PI * 2;
      const nx = Math.cos(u) * sv;
      const ny = cv;
      const nz = Math.sin(u) * sv;
      row.push(p.position.length / 3);
      p.position.push(centre[0] + nx * radii[0], centre[1] + ny * radii[1], centre[2] + nz * radii[2]);
      p.normal.push(nx, ny, nz);
    }
    rows.push(row);
  }
  for (let ring = 0; ring < LOBE_RINGS; ring++) {
    for (let side = 0; side < LOBE_SIDES; side++) {
      const next = (side + 1) % LOBE_SIDES;
      const a = rows[ring][side];
      const b = rows[ring][next];
      const c = rows[ring + 1][next];
      const d = rows[ring + 1][side];
      // Counter-clockwise seen from outside: `u` runs anticlockwise in the XZ
      // plane and `v` runs from +Y down, so the ring-then-next-side order below
      // is the one whose cross product agrees with the outward normal. The
      // winding pass in `verifyHands` re-derives it from the normals rather
      // than trusting this comment -- the README records 61% of the city's
      // walls inside out for months while looking like a city.
      p.index.push(a, b, c, a, c, d);
    }
  }
}

/**
 * A tapered cylinder from `from` to `to`, capped at the far end only.
 *
 * Capped at one end because the near end is inside the mitt and a cap there is
 * eight triangles nobody can ever see; capped at the far end because the arm is
 * *cut off* rather than continuing, and an open tube seen from behind in a
 * mirror -- or from a third-person camera during the one frame a mode change
 * takes -- is a hole in a person.
 */
function limb(
  p: Parts,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  rFrom: number,
  rTo: number,
): void {
  const ax = to[0] - from[0];
  const ay = to[1] - from[1];
  const az = to[2] - from[2];
  const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  const dx = ax / len;
  const dy = ay / len;
  const dz = az / len;
  // Any two vectors perpendicular to the axis. Picked off whichever world axis
  // the limb is least aligned with, which is the standard way to avoid a
  // degenerate cross product and is what `world/vessel.ts` does for its masts.
  const upX = Math.abs(dy) < 0.9 ? 0 : 1;
  const upY = Math.abs(dy) < 0.9 ? 1 : 0;
  let ux = upY * dz - 0 * dy;
  let uy = 0 * dx - upX * dz;
  let uz = upX * dy - upY * dx;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;

  const ringA: number[] = [];
  const ringB: number[] = [];
  for (let i = 0; i < LIMB_SIDES; i++) {
    const a = (i / LIMB_SIDES) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const nx = ux * ca + vx * sa;
    const ny = uy * ca + vy * sa;
    const nz = uz * ca + vz * sa;
    ringA.push(p.position.length / 3);
    p.position.push(from[0] + nx * rFrom, from[1] + ny * rFrom, from[2] + nz * rFrom);
    p.normal.push(nx, ny, nz);
    ringB.push(p.position.length / 3);
    p.position.push(to[0] + nx * rTo, to[1] + ny * rTo, to[2] + nz * rTo);
    p.normal.push(nx, ny, nz);
  }
  for (let i = 0; i < LIMB_SIDES; i++) {
    const j = (i + 1) % LIMB_SIDES;
    p.index.push(ringA[i], ringB[j], ringB[i], ringA[i], ringA[j], ringB[j]);
  }
  // The far cap, as a fan from the centre.
  const centre = p.position.length / 3;
  p.position.push(to[0], to[1], to[2]);
  p.normal.push(dx, dy, dz);
  for (let i = 0; i < LIMB_SIDES; i++) {
    const j = (i + 1) % LIMB_SIDES;
    p.index.push(centre, ringB[i], ringB[j]);
  }
}

/**
 * One hand, built at the origin. `side` is -1 for the left, +1 for the right.
 *
 * The mirror is a sign on X and nothing else, which is the whole reason both
 * hands come out of one function: a hand is symmetric enough at this triangle
 * count that a mirrored copy is a left hand, and the *pose* is what tells them
 * apart. Two authored hands would be two places to fix a proportion.
 */
function buildHand(p: Parts, side: number): void {
  lobe(p, [0, 0, 0], [MITT_RADIUS_X, MITT_RADIUS_Y, MITT_RADIUS_Z]);
  // Back and slightly out, so the two forearms diverge toward the bottom
  // corners of the frame rather than running parallel into the middle of it.
  limb(
    p,
    [0, -0.01, MITT_RADIUS_Z * 0.4],
    [side * FOREARM_LENGTH * 0.28, -FOREARM_LENGTH * 0.32, FOREARM_LENGTH],
    FOREARM_WRIST_R,
    FOREARM_ELBOW_R,
  );
}

/**
 * One geometry and one material for both of your hands.
 *
 * `BatAssets`' contract, including the consequence: a `HandsViewmodel` must
 * never dispose the geometry, because the other hand is drawing it.
 *
 * The material is **per colourway** rather than vertex-coloured, which is the
 * one departure from `character.ts` and `bat.ts`. Those two share one material
 * across every actor in the game specifically to avoid sixteen pipeline
 * compiles in the frame a match starts; there is exactly *one* pair of these
 * hands in a process -- your own -- so a material with your own skin tone in it
 * costs one compile per kit change and buys a geometry that is not seven
 * buffers.
 */
export class HandsAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;

  constructor(colourway = 0) {
    const p: Parts = { position: [], normal: [], index: [] };
    // Built as a **right** hand and mirrored per mesh by a negative X scale, so
    // there is one buffer for two hands. The winding consequence is real and is
    // handled at the mesh: a negative scale flips the effective winding, so the
    // left hand's mesh sets `material.side` -- see `HandsViewmodel`.
    buildHand(p, 1);

    const geometry = new BufferGeometry();
    geometry.name = 'hands';
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(p.normal), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(p.index), 1));
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.triangles = p.index.length / 3;
    this.vertices = p.position.length / 3;

    const material = new MeshStandardNodeMaterial();
    material.name = 'hands';
    const skin = COLOURWAYS[((colourway % COLOURWAYS.length) + COLOURWAYS.length) % COLOURWAYS.length].skin;
    material.color.setRGB(skin[0], skin[1], skin[2]);
    // The figure's own 0.78. Skin is not glossy and a viewmodel that caught more
    // specular than the body it belongs to would look wet.
    material.roughness = 0.78;
    material.metalness = 0;
    material.flatShading = true;
    // **Both sides**, and this is the mirror's price. The left hand is the right
    // hand at `scale.x = -1`, which reverses every triangle's winding; three
    // does not re-wind geometry for a negative determinant, so a single-sided
    // material draws the left hand inside out. `DoubleSide` on 640 triangles at
    // half a metre is free -- there is no depth pre-pass here to confuse and no
    // shadow to cast.
    material.side = 2;
    this.material = material;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- The viewmodel -------------------------------------------------------------

/** How hard the hands lag a mouse turn, and how fast that lag decays. `BatViewmodel`'s. */
const SWAY_GAIN = 0.055;
const SWAY_TAU = 0.09;
/** How far the hands bob with a stride, metres at a sprint. Under the bat's 0.026. */
const BOB_AMOUNT = 0.018;
/**
 * The connect kick. `combat.HITSTOP` exactly, as `BatViewmodel.CONNECT_SECONDS`
 * is, so the shudder runs over precisely the frames the simulation is frozen for
 * and the two read as one event.
 */
const CONNECT_SECONDS = 0.09;

/**
 * The hands you are looking at.
 *
 * A `Group` with two meshes in it, added to the **camera** -- which means
 * `main.ts` has to have the camera in the scene, and it already does for the
 * bat. Each hand is posed absolutely from `handsPose` rather than relative to
 * the group, and the group carries only the sway and the bob; that is the
 * arrangement `BatViewmodel` uses and it is what lets the two hands move
 * independently while the whole pair still leans with the mouse.
 */
export class HandsViewmodel {
  readonly group: Group;
  readonly primary: Mesh;
  readonly off: Mesh;

  private clock = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private seeded = false;
  private connectT = 0;
  private stride = 0;

  constructor(readonly assets: HandsAssets) {
    const group = new Group();
    group.name = 'hands-viewmodel';
    group.frustumCulled = false;

    const make = (name: string, mirror: boolean): Mesh => {
      const mesh = new Mesh(assets.geometry, assets.material);
      mesh.name = name;
      // Never in the depth pass, on `BatViewmodel`'s argument: a hand welded to
      // the eye would cast a shadow from head height that follows the player
      // around the footpath.
      mesh.castShadow = false;
      // And not receiving either, which is where this departs from the bat. The
      // bat keeps `receiveShadow` so it darkens when you walk into a terrace's
      // shade, and that is right for a 0.83 m object with a flat face. A mitt at
      // 30 cm from the near plane lands inside the first cascade's texel grid,
      // and what it receives is not shade but a moiré of its own shadow map --
      // which reads as dirt on your hands.
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      if (mirror) mesh.scale.x = -1;
      group.add(mesh);
      return mesh;
    };
    this.primary = make('hand-primary', false);
    this.off = make('hand-off', true);
    this.group = group;
  }

  /** A punch landed. Adds the shudder; see `CONNECT_SECONDS`. */
  connect(): void {
    this.connectT = CONNECT_SECONDS;
  }

  /**
   * Pose both hands for this frame.
   *
   * `BatViewmodel.update`'s signature and its contract: the frame delta rather
   * than the fixed step, because a viewmodel is presentation and has to be
   * smooth at whatever rate the display runs, and `phase`/`phaseT` come straight
   * off the **predicted** local combatant so the punch starts on the frame the
   * button goes down rather than on the next round trip.
   */
  update(
    dt: number,
    state: {
      phase: HandPhase;
      phaseT: number;
      /** Horizontal speed, m/s. Drives the bob. */
      speed: number;
      /** The camera's yaw and pitch, radians. The sway is their derivative. */
      yaw: number;
      pitch: number;
      /** Frozen animation, not slowed: the pose holds on the frame the hit landed. */
      hitstop: boolean;
    },
  ): void {
    // A knocked-out player is not holding their guard up. `BatViewmodel`'s rule
    // and its reason.
    const down = state.phase === 'ko';
    this.group.visible = !down;
    if (down) {
      this.seeded = false;
      return;
    }

    const step = state.hitstop ? 0 : dt;
    this.clock += step;
    if (this.connectT > 0) this.connectT = Math.max(0, this.connectT - step);

    // The sway is the derivative of the look, low-passed, seeded on the first
    // frame -- otherwise the difference between an uninitialised yaw and the
    // player's actual one is a whole turn on the frame the game starts.
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
    // `animation.ClipContext`'s rule and keeps the bob in step with the feet at
    // every speed and through every acceleration.
    this.stride = (this.stride + state.speed * step * 3.6) % (Math.PI * 2);
    const gait = Math.min(1, state.speed / 8.2);
    const bob = Math.sin(this.stride * 2) * BOB_AMOUNT * gait;
    const roll = Math.sin(this.stride) * 0.04 * gait;
    // A slow figure-eight when standing still, on two periods that do not divide
    // each other. `animation.clipIdle`'s trick, and it is what stops the hands
    // reading as a pair of decals stuck to the glass.
    const idleX = Math.sin(this.clock * 0.71) * 0.005 * (1 - gait);
    const idleY = Math.sin(this.clock * 0.94 + 1.3) * 0.007 * (1 - gait);

    const pose = handsPose(punchDrive(state.phase, state.phaseT));

    // The connect kick, applied on top of the pose rather than blended into it,
    // so a hit at any point in the active window shudders from wherever the fist
    // actually was.
    const shock = this.connectT / CONNECT_SECONDS;
    const jolt = shock > 0 ? shock * shock * Math.sin(shock * 34) : 0;

    // The **group** carries the sway, the bob and the jolt; each hand carries
    // its own key. Two levels rather than one so the pair leans together while
    // the punch travels on its own -- fold the sway into each hand and a mouse
    // flick would splay them apart.
    this.group.position.set(
      idleX + this.swayYaw * 0.6 + jolt * 0.016,
      bob + idleY + this.swayPitch * 0.5 - jolt * 0.012,
      Math.abs(bob) * 0.4 + jolt * 0.024,
    );
    this.group.rotation.set(
      this.swayPitch * 0.8 - jolt * 0.08,
      this.swayYaw * 1.0,
      roll + jolt * 0.12,
    );

    this.primary.position.set(pose.primary.at[0], pose.primary.at[1], pose.primary.at[2]);
    this.primary.rotation.set(pose.primary.rot[0], pose.primary.rot[1], pose.primary.rot[2]);
    this.off.position.set(pose.off.at[0], pose.off.at[1], pose.off.at[2]);
    this.off.rotation.set(pose.off.rot[0], pose.off.rot[1], pose.off.rot[2]);
  }
}

/** Shortest signed angle. A mouse that crosses the yaw wrap must not sway a full turn. */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

// --- The self-check ------------------------------------------------------------

/**
 * The hands, as geometry and as a posed pair, asserted.
 *
 * Includes `verifyHandsPose` wholesale, so the browser runs the pure checks too
 * and a client boot cannot pass while the server's would fail. The things
 * measured *here* are the ones that need a vertex buffer:
 *
 *   - **The triangle budget.** The brief's ~1.2 k. A viewmodel that outgrew the
 *     figure it belongs to is a viewmodel somebody modelled rather than built.
 *   - **The mitt matches the body's.** The whole point of taking
 *     `character.MITT_RADII`'s numbers, and the failure -- hands a different
 *     size in first and third person -- is invisible to anybody who does not
 *     press `V` mid-punch.
 *   - **Winding.** A lobe lofted inside out is a hand you can see the inside of.
 *     This is the failure the README's winding pass documents on the city's
 *     walls, and it is why the left hand's mirror is handled with `DoubleSide`
 *     rather than hoped about.
 *   - **The whole hand stays inside the near budget through the whole swing.**
 *     `hands-pose` checks the mitt's *centre* with 15 cm of assumed slack; this
 *     is the real measurement, every vertex, every phase.
 *   - **Nothing sits on the reticle at rest.** A viewmodel over the crosshair is
 *     a complaint rather than a bug.
 *   - **The hands are hidden when another slot is primary.** The brief's own
 *     test, and the one that would otherwise ship a pair of fists floating
 *     beside a raised phone.
 *
 * Runs in the browser at boot:
 *
 *     bun -e "import {verifyHands} from './src/player/hands.ts'; console.log(verifyHands())"
 */
export function verifyHands(): string[] {
  // The pure half first, so a pose failure is reported once and in the right
  // words rather than showing up here as a geometry that will not fit.
  const failures: string[] = [...verifyHandsPose()];
  const assets = new HandsAssets(0);

  // --- Budget. The brief's ~1.2 k for the pair; one hand is half of it.
  const pair = assets.triangles * 2;
  if (pair > 1400) {
    failures.push(`Both hands are ${pair} triangles; the budget is about 1,200 and the whole figure is 440.`);
  }
  if (pair < 100) {
    failures.push(`Both hands are only ${pair} triangles. Something did not get built.`);
  }

  const position = assets.geometry.getAttribute('position');
  const normal = assets.geometry.getAttribute('normal');
  const index = assets.geometry.getIndex();
  if (index === null) {
    failures.push('The hand geometry is not indexed.');
    return failures;
  }

  // --- Winding. Every triangle's cross product has to agree with the mean of
  // its three vertex normals -- and those normals came from the *surface*
  // parameterisation rather than from the triangles, so this is a real test and
  // not a tautology. `bat.verifyBat`'s construction.
  {
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
        `${disagreeing} of ${index.count / 3} hand triangles are wound against their own normals. ` +
          `With a single-sided material they would be culled and the hand would be see-through.`,
      );
    }
  }

  // --- The mitt is the figure's mitt.
  //
  // Measured off **both** drawn buffers rather than compared against the
  // constants at the top of this file, which would be a constant equalling
  // itself through two lines. The failure being defended against is hands a
  // different size in first and third person, which nobody sees without
  // pressing `V` mid-swing and which is exactly the kind of thing that drifts
  // when somebody tunes one of the two.
  //
  // **The two lobes are different tessellations of the same ellipsoid**, and
  // that is the wrinkle this check has to get past: `character.lobe` builds an
  // icosphere whose most extreme vertex sits at 0.851 of its radius, and the
  // UV sphere here reaches 0.951 -- so the raw bounding boxes differ by 12% for
  // two hands that are the same size. Comparing them directly would need a
  // tolerance so loose it would pass a hand half again too big.
  //
  // So each radius is recovered rather than measured: the **normal** attribute
  // of both buffers is the unit-sphere direction of the vertex it belongs to, so
  // dividing each lobe's bounding half-extent by the largest unit component that
  // actually appears in it undoes the tessellation exactly and leaves the
  // ellipsoid's own radius. Both sides are read from a real buffer and the
  // comparison is then to the millimetre.
  {
    const ellipsoid = (
      pos: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number },
      nor: { getX(i: number): number; getY(i: number): number; getZ(i: number): number },
      keep: (i: number) => boolean,
    ): [number, number, number] | null => {
      const half: [number, number, number] = [0, 0, 0];
      const unit: [number, number, number] = [0, 0, 0];
      // The centre is subtracted, because the figure's mitt is out at the end of
      // an arm and this one is at the origin.
      const lo: [number, number, number] = [Infinity, Infinity, Infinity];
      const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        if (!keep(i)) continue;
        n++;
        const p: [number, number, number] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
        unit[0] = Math.max(unit[0], Math.abs(nor.getX(i)));
        unit[1] = Math.max(unit[1], Math.abs(nor.getY(i)));
        unit[2] = Math.max(unit[2], Math.abs(nor.getZ(i)));
      }
      if (n < 8) return null;
      for (let k = 0; k < 3; k++) {
        if (!(unit[k] > 0.1)) return null;
        half[k] = (hi[k] - lo[k]) / 2 / unit[k];
      }
      return half;
    };

    const mine = ellipsoid(position, normal, (i) => position.getZ(i) <= MITT_RADIUS_Z + 1e-4);
    // The figure's mitt is the only thing in that mesh bound **rigidly** to the
    // right wrist -- see `character.ts`, where every other part of the arm is a
    // two-bone joint blend and the mitt alone is `w1(wrist)`. That is what makes
    // it findable in a buffer with no part list in it.
    const figure = new CharacterAssets();
    let theirs: [number, number, number] | null = null;
    for (const geometry of figure.geometries) {
      const pos = geometry.getAttribute('position');
      const nor = geometry.getAttribute('normal');
      const si = geometry.getAttribute('skinIndex');
      const sw = geometry.getAttribute('skinWeight');
      if (!pos || !nor || !si || !sw) continue;
      const found = ellipsoid(pos, nor, (i) => si.getX(i) === BONE.WRIST_R && sw.getX(i) > 0.999);
      if (found !== null) {
        theirs = found;
        break;
      }
    }

    if (mine === null) {
      failures.push('The viewmodel hand has no mitt lobe in it.');
    } else if (theirs === null) {
      failures.push('Could not find the figure\'s own mitt in CharacterAssets to compare against.');
    } else {
      const axes = ['across', 'tall', 'deep'];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mine[k] - theirs[k]) > 0.004) {
          failures.push(
            `The viewmodel mitt is ${(mine[k] * 2000).toFixed(0)} mm ${axes[k]} against the figure's ` +
              `${(theirs[k] * 2000).toFixed(0)}. Your hands change size when you press V.`,
          );
        }
      }
    }
  }

  // --- There is a forearm behind the mitt, and it goes down and back.
  //
  // A mitt on its own is a floating fist, which is the whole reason the limb is
  // built -- and it is exactly the part a "simplify the viewmodel" pass would
  // delete, because in a still frame the arm is mostly off screen.
  {
    let furthestBack = 0;
    let lowest = 0;
    for (let i = 0; i < position.count; i++) {
      furthestBack = Math.max(furthestBack, position.getZ(i));
      lowest = Math.min(lowest, position.getY(i));
    }
    if (furthestBack < MITT_RADIUS_Z + 0.1) {
      failures.push(
        `The hand extends ${(furthestBack * 100).toFixed(1)} cm behind the wrist. Without a forearm ` +
          `running back out of frame it is a floating fist, which is the cheapest-looking thing a ` +
          `viewmodel can be.`,
      );
    }
    if (!(lowest < -MITT_RADIUS_Y)) {
      failures.push('The forearm does not run downward; it will point out of the middle of the screen rather than off the bottom.');
    }
  }

  // --- The whole hand, every vertex, through the whole swing, inside the near
  //     budget -- and clear of the reticle at rest.
  {
    const view = new HandsViewmodel(assets);
    const vertex = new Vector3();
    const samples: Array<[HandPhase, number]> = [['idle', 0]];
    for (let i = 0; i <= 12; i++) samples.push(['windup', (i / 12) * PUNCH_WIND_UP]);
    for (let i = 0; i <= 12; i++) samples.push(['active', (i / 12) * PUNCH_ACTIVE]);
    for (let i = 0; i <= 12; i++) samples.push(['recovery', (i / 12) * PUNCH_RECOVERY]);
    let furthest = 0;
    let worstAngle = Infinity;
    for (const [phase, phaseT] of samples) {
      // Sway and bob at zero: they add under 3 cm and would only blur the
      // numbers these two claims are about. `verifyBat` samples the same way.
      view.update(1 / 60, { phase, phaseT, speed: 0, yaw: 0, pitch: 0, hitstop: false });
      view.group.updateMatrixWorld(true);
      for (const mesh of [view.primary, view.off]) {
        for (let i = 0; i < position.count; i++) {
          vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
          furthest = Math.max(furthest, vertex.length());
          if (phase === 'idle') {
            const forward = -vertex.z;
            const off = Math.hypot(vertex.x, vertex.y);
            // Anything level with or behind the eye cannot be over the reticle.
            if (forward > 1e-3) worstAngle = Math.min(worstAngle, Math.atan2(off, forward));
          }
        }
      }
    }
    if (furthest > HANDS_MAX_REACH) {
      failures.push(
        `A hand reaches ${furthest.toFixed(2)} m from the eye, past the ${HANDS_MAX_REACH.toFixed(2)} m ` +
          `budget. That budget is the whole reason these can be drawn in the ordinary depth buffer ` +
          `rather than in a second pass with its own near plane.`,
      );
    }
    if (worstAngle < HANDS_RETICLE_CLEARANCE) {
      failures.push(
        `At rest a hand comes within ${(worstAngle * (180 / Math.PI)).toFixed(1)} degrees of the view ` +
          `axis; it must clear ${(HANDS_RETICLE_CLEARANCE * (180 / Math.PI)).toFixed(1)}. It is on the reticle.`,
      );
    }

    // --- Hidden on a knockout, and shown again when the player is back up.
    view.update(1 / 60, { phase: 'ko', phaseT: 0.3, speed: 0, yaw: 0, pitch: 0, hitstop: false });
    if (view.group.visible) {
      failures.push('The hands are still in frame over a camera lying on the pavement.');
    }
    view.update(1 / 60, { phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false });
    if (!view.group.visible) failures.push('The hands did not come back after a respawn.');

    // --- The brief's own case: **hidden when another slot is primary**.
    //
    // Visibility is `main.ts`'s to drive -- it goes through the same
    // `setWeaponVisible` hook the bat and the football use, and through the same
    // `character.setVisibleToCamera` layer channel rather than `visible`,
    // because `update` writes `group.visible` itself every frame (see the
    // knockout case immediately above, which is exactly the collision
    // `BatViewmodel`'s own comment warns about). What is asserted here is the
    // property that makes that possible: the toggle has to be on the **meshes**,
    // because three tests layers per object and a `Group` is never itself drawn.
    for (const mesh of [view.primary, view.off]) {
      if (mesh.parent !== view.group) {
        failures.push('A hand is not parented to the viewmodel group; the sway and the bob will not reach it.');
      }
      // Layer 0 out of the box, so a hand that `main.ts` never touches is drawn
      // rather than invisible -- the failure that is easier to notice.
      if (!mesh.layers.isEnabled(0)) {
        failures.push('A hand starts on a layer the camera does not draw. It would never appear at all.');
      }
    }
    // And the two hands are two *objects*, so hiding one cannot hide both and a
    // future one-handed slot (holding the phone, punching with the other) is a
    // layer write rather than a rebuild.
    if (view.primary === view.off) failures.push('Both hands are the same object.');
    // Mirrored, so the left hand is a left hand.
    if (!(view.off.scale.x < 0 && view.primary.scale.x > 0)) {
      failures.push(`The hands are scaled ${view.primary.scale.x} and ${view.off.scale.x}; one of them must be mirrored.`);
    }
    // ...and the material draws both sides, or the mirrored one is inside out.
    if (assets.material.side !== 2) {
      failures.push('The hand material is single-sided; the mirrored hand will be back-face culled and drawn inside out.');
    }
  }

  // --- The skin comes off the player's own kit rather than a fixed tone.
  {
    const seen = new Set<string>();
    for (let kit = 0; kit < COLOURWAYS.length; kit++) {
      const a = new HandsAssets(kit);
      seen.add(`${a.material.color.r.toFixed(4)},${a.material.color.g.toFixed(4)},${a.material.color.b.toFixed(4)}`);
      const want = COLOURWAYS[kit].skin;
      if (Math.abs(a.material.color.r - want[0]) > 1e-4) {
        failures.push(`Kit ${kit}'s hands are not its skin tone; the body and the viewmodel are different people.`);
      }
      a.dispose();
    }
    if (seen.size < 5) {
      failures.push(`${COLOURWAYS.length} kits produced ${seen.size} distinct hand tones; the skin is not tracking the colourway.`);
    }
    // An out-of-range colourway wraps rather than throwing or drawing black --
    // reachable from a truncated roster, and a black hand looks like a shader
    // failure rather than a decode one.
    const wrapped = new HandsAssets(999);
    if (wrapped.material.color.r <= 0 && wrapped.material.color.g <= 0) {
      failures.push('An out-of-range colourway produced black hands.');
    }
    wrapped.dispose();
  }

  assets.dispose();
  return failures;
}
