/**
 * The AFL football, as an object you can see: one geometry, a prop in every
 * off hand, a pool of them in the air, and a first-person one.
 *
 * The gameplay is in `game/footy.ts`, which is shared with the server and knows
 * nothing about three. This is the half a browser needs, and it is the same
 * split `player/bat.ts` makes about the melee weapon -- what the ball *is* is
 * over there, what it looks like is here.
 *
 * ---------------------------------------------------------------------------
 * Why the ball is generated, like everything else in this client.
 *
 * `player/character.ts` argues it at length about the figure and `player/bat.ts`
 * repeats it about the bat: there is no asset pipeline for a downloaded mesh to
 * enter, and a `.glb` would be the only thing in the repository whose triangle
 * budget, pivot and up-axis were decided somewhere else. A football is a
 * spheroid. It is 80 triangles of arithmetic.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the two details that make it a *football* rather than a rugby
 * ball or an egg.
 *
 *   - **The proportions are a Sherrin's.** 0.28 m on the long axis and 0.174 m
 *     across the girth, which is a ratio of 1.61 -- and that ratio is the whole
 *     silhouette. A rugby ball is blunter (about 1.45) and an American football
 *     is sharper and pointed rather than rounded. The poles here stay *round*,
 *     because an AFL ball's ends are domed and not tipped.
 *   - **Four white lace stitches on one meridian.** The single most recognisable
 *     thing on the object and twenty-four triangles: against a deep red-brown
 *     the laces are the only high-contrast feature, so they are what the eye
 *     tracks through a tumble, and they are what says which way the ball is
 *     pointing at 30 m where the outline alone says nothing.
 *
 * The colour is Sherrin red rather than the yellow a night game uses. Both were
 * considered and the city decides it, exactly as it decided the beam's magenta
 * before it: this project's own measurement puts a sunlit footpath at Y' 247 and
 * the sky between rgb(114, 166, 249) and rgb(200, 233, 254), so the upper half
 * of every frame is pale blue and the lower half is pale grey. A yellow ball
 * against that pavement is a low-contrast smudge; a deep red-brown is dark
 * against both halves and is the one hue no large surface in the inner suburbs
 * carries -- the brick is lighter and oranger, the roofs are terracotta, the
 * render is cream.
 *
 * ---------------------------------------------------------------------------
 * The tumble is derived from the velocity, and that is what keeps it honest.
 *
 * A footy in flight spins end over end. That could be simulated -- an angular
 * velocity, an orientation, both on the wire -- and `game/footy.ts`'s header
 * says why it is not: the orientation has no gameplay consequence, so carrying
 * it would be bytes and a synchronisation problem for a picture.
 *
 * So the orientation is a **pure function of the ball's velocity and its age**,
 * computed here, per frame, from numbers the renderer already has. The long axis
 * is turned to lie along the flight; the ball then rotates about the horizontal
 * axis perpendicular to it at a fixed rate. Both ends compute the same picture
 * from the same snapshot without agreeing about anything extra, and the picture
 * cannot drift from the simulation because it *is* a function of the simulation.
 *
 * One consequence worth stating: the tumble does not slow down when the ball
 * does. A real ball's spin decays with its speed. Keying the rate to the speed
 * was tried on paper and is worse -- a ball that has bounced twice and is
 * rolling looks *stopped* if it is not turning, and a slowly-turning ball at
 * 4 m/s reads as a bug rather than as physics.
 *
 * ---------------------------------------------------------------------------
 * Cost. 120 triangles -- 80 for the spheroid, 40 for the lacing -- and one
 * material for every ball in the game, against the bat's 128 and the figure's
 * 440. Sixteen players carrying one, twenty in the air and one in front of the
 * eye is 4,440 triangles in 37 draws: a rounding error beside the 483 k of trees
 * in the spawn frame.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import { BALL_RADIUS } from '../game/footy.ts';
import { BONE } from '../player/animation.ts';
import { CharacterActor, CharacterAssets, SELF_SHADOW_LAYER } from '../player/character.ts';
// The breath the bat's viewmodel has, which this file used to have four
// slightly-different lines of. See `player/viewmodel-idle.ts`: the owner asked for
// the held ball to *"idle breathe like the bat"*, and the only way to make that
// true tomorrow as well as today is for the two of them to call one function.
import { type IdleSway, viewmodelIdle, verifyViewmodelIdle } from '../player/viewmodel-idle.ts';
import type { WarmupPart } from './warmup.ts';

// --- Proportions ---------------------------------------------------------------

/**
 * Half the long axis, metres. A Sherrin is 0.28 m end to end.
 *
 * The long axis is the mesh's local **+Y**, which is `player/bat.ts`'s
 * convention and the rig's: every bone in `animation.ts` hangs along its own
 * axis, so a prop built along Y is one rotation away from any pose.
 */
const SEMI_LONG = 0.14;
/** Half the girth. 0.174 m across gives the 1.61 ratio the header argues for. */
const SEMI_GIRTH = 0.087;

/** Segments around the girth and bands along the axis. 8 x 6 is 80 triangles. */
const SEGMENTS = 8;
const BANDS = 6;

/**
 * How many laces, and how big one is: length across the seam, height along it,
 * and how far the lacing sits off the leather.
 *
 * The lift is 1.5 mm and the box is 1.8 mm thick, so the lacing stands 3.3 mm
 * proud -- which is a real one, and the number matters more than it looks like
 * it should. The *silhouette* of this object is its whole identity, and
 * `verifyFootyBall` measures the long-axis-to-girth ratio against a Sherrin's
 * 1.61 over every vertex including these: at the 11 mm the first draft stood
 * them off, four laces fattened the measured girth by 13% and turned the ball
 * into a 1.42 rugby ball without a single triangle of the body changing.
 */
const LACES = 4;
const LACE_HALF_X = 0.014;
const LACE_HALF_Y = 0.006;
const LACE_LIFT = 0.0015;

type Rgb = readonly [number, number, number];

/**
 * Linear albedos, on `player/bat.ts`'s terms: picked against the surfaces the
 * ball is seen over rather than in isolation.
 *
 * The leather is a shade lighter and less saturated than a real Sherrin, for the
 * reason the bat's willow is a shade darker than real willow -- a ball at the
 * true reflectance of oiled red leather is nearly black in shadow, and half of
 * this city is in the shadow of a terrace. This keeps its hue at every light
 * level.
 */
const LEATHER: Rgb = [0.35, 0.075, 0.035];
/** The seam the laces sit on: the same leather, darker, so the meridian reads. */
const SEAM: Rgb = [0.2, 0.04, 0.02];
/** The lacing. Not pure white -- a lace is waxed cotton and takes the sun. */
const LACE: Rgb = [0.82, 0.8, 0.74];

// --- The builder ---------------------------------------------------------------

/**
 * Accumulates the spheroid and its laces into one indexed, flat-shaded buffer.
 *
 * **Winding and normals, stated once.** Every vertex normal here is the
 * *analytic* normal of the ellipsoid at that point -- `(x/b^2, y/a^2, z/b^2)`,
 * normalised -- and never a cross product of the triangle it belongs to. That is
 * what makes the winding check in `verifyFootyBall` a real test rather than a
 * tautology: it compares the triangles' own cross products against normals
 * derived a completely different way. The README's winding pass records 61% of
 * the city's walls inside out for months while looking like a city, and a closed
 * surface has exactly that property -- an inside-out ball is invisible from
 * outside and perfect from within.
 *
 * The parameterisation, so the winding is checkable by reading rather than by
 * running: a point is `p(t, f) = (b sin t cos f, a cos t, b sin t sin f)` for
 * polar angle `t` from +Y and azimuth `f`. The outward normal is
 * `dp/df x dp/dt`, so a quad emitted in the order (+f, then +t) has its first
 * two edges along `df` and `dt` in that order and therefore winds outward.
 */
class BallParts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  vertex(x: number, y: number, z: number, n: readonly [number, number, number], c: Rgb): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.normal.push(n[0], n[1], n[2]);
    this.colour.push(c[0], c[1], c[2]);
    return i;
  }

  triangle(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  get triangles(): number {
    return this.index.length / 3;
  }
}

/** A point on the spheroid, with its analytic normal. See `BallParts`. */
function surfacePoint(
  theta: number,
  phi: number,
): { p: [number, number, number]; n: [number, number, number] } {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const cf = Math.cos(phi);
  const sf = Math.sin(phi);
  const x = SEMI_GIRTH * st * cf;
  const y = SEMI_LONG * ct;
  const z = SEMI_GIRTH * st * sf;
  // The gradient of `(x/b)^2 + (y/a)^2 + (z/b)^2 = 1`, which is the outward
  // normal of an ellipsoid and is *not* the position direction -- the two differ
  // by up to 22 degrees on this eccentricity, which is exactly the shading error
  // that makes a spheroid read as a stretched sphere.
  let nx = x / (SEMI_GIRTH * SEMI_GIRTH);
  let ny = y / (SEMI_LONG * SEMI_LONG);
  let nz = z / (SEMI_GIRTH * SEMI_GIRTH);
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  return { p: [x, y, z], n: [nx, ny, nz] };
}

// --- The shared asset ----------------------------------------------------------

/**
 * One ball geometry and one material, for every football in the game.
 *
 * The same contract `CharacterAssets` and `BatAssets` have, for the same reason:
 * a material is a WebGPU pipeline, and twenty balls in the air each with their
 * own material is twenty compiles in the frame a fight gets busy. So the
 * leather, the seam and the lacing are **vertex colours** on one flat-shaded
 * `MeshStandardNodeMaterial`, and nothing that holds one of these ever disposes
 * the geometry it was handed.
 */
export class FootyAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;

  constructor() {
    const b = new BallParts();

    // --- The spheroid. Each quad gets its own four vertices, because two
    // adjacent faces of a faceted ball share an edge and not a normal -- the
    // same build `player/bat.ts` uses and for the reason `vegetation.ts`
    // measured: a non-indexed build with baked face normals triples the vertex
    // count for the same triangles and the same look.
    for (let band = 0; band < BANDS; band++) {
      const t0 = (band / BANDS) * Math.PI;
      const t1 = ((band + 1) / BANDS) * Math.PI;
      for (let seg = 0; seg < SEGMENTS; seg++) {
        const f0 = (seg / SEGMENTS) * Math.PI * 2;
        const f1 = ((seg + 1) / SEGMENTS) * Math.PI * 2;
        // The seam band: one segment's worth of the surface, darkened, running
        // pole to pole under the lacing. It costs nothing -- it is a different
        // triple in the colour buffer -- and it is what stops the laces looking
        // like four objects stuck on a plain ball.
        const colour = seg === SEAM_SEGMENT ? SEAM : LEATHER;

        const a = surfacePoint(t0, f0);
        const bb = surfacePoint(t0, f1);
        const c = surfacePoint(t1, f1);
        const d = surfacePoint(t1, f0);

        // (+f, then +t), which winds outward. See `BallParts`.
        const ia = b.vertex(a.p[0], a.p[1], a.p[2], a.n, colour);
        const ib = b.vertex(bb.p[0], bb.p[1], bb.p[2], bb.n, colour);
        const ic = b.vertex(c.p[0], c.p[1], c.p[2], c.n, colour);
        const id = b.vertex(d.p[0], d.p[1], d.p[2], d.n, colour);
        // The two polar bands degenerate to triangles -- their far ring has zero
        // radius, so two of the four corners are the same point. Emitting the
        // triangle rather than the quad keeps the buffer free of zero-area
        // faces, which would otherwise be sixteen triangles that draw nothing
        // and defeat the winding check by being skipped.
        if (band === 0) {
          b.triangle(ia, ic, id);
        } else if (band === BANDS - 1) {
          b.triangle(ia, ib, ic);
        } else {
          b.triangle(ia, ib, ic);
          b.triangle(ia, ic, id);
        }
      }
    }

    // --- The lacing: four small boxes standing off the seam, evenly spaced
    // along the middle of the long axis.
    //
    // Boxes rather than a swept ribbon because at any range a ball is seen from,
    // a lace is three pixels: what has to be right is that there are four of
    // them, that they are pale, and that they are in a row down one meridian.
    const seamPhi = ((SEAM_SEGMENT + 0.5) / SEGMENTS) * Math.PI * 2;
    for (let i = 0; i < LACES; i++) {
      // Spread over the middle 45% of the axis, which is where a real lacing
      // sits -- out past that the surface is falling away and a flat box would
      // sink into it.
      const y = ((i + 0.5) / LACES - 0.5) * (SEMI_LONG * 0.9);
      const st = Math.sqrt(Math.max(0, 1 - (y / SEMI_LONG) * (y / SEMI_LONG)));
      const r = SEMI_GIRTH * st + LACE_LIFT;
      lace(b, Math.cos(seamPhi) * r, y, Math.sin(seamPhi) * r, seamPhi);
    }

    const geometry = new BufferGeometry();
    geometry.name = 'footy';
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(b.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(b.normal), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(b.colour), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(b.index), 1));
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.triangles = b.triangles;
    this.vertices = b.position.length / 3;

    // Lit, like the bat and unlike the beam this replaced, and that is the
    // difference between an object and an emitter: a ball has no output of its
    // own, so the thing that has to be true of it is that it goes dark when it
    // sails into a building's shadow.
    const material = new MeshStandardNodeMaterial();
    material.name = 'footy';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Glossier than the bat's 0.62. A match ball is waxed leather and carries a
    // distinct highlight, and that highlight is most of what makes a tumbling
    // ball legible against a busy street -- it flashes once a revolution.
    material.roughness = 0.45;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }
}

/** Which segment of the girth the seam and its lacing run down. */
const SEAM_SEGMENT = 2;

/** One lace: a small box standing off the surface, aligned across the seam. */
function lace(b: BallParts, cx: number, cy: number, cz: number, phi: number): void {
  // The box's local axes: `across` runs around the girth, `out` is the surface
  // normal, and Y is along the ball. Built from the seam's own angle rather than
  // axis-aligned, so a lace on a seam at any azimuth lies flat on the leather.
  const ax = -Math.sin(phi);
  const az = Math.cos(phi);
  const ox = Math.cos(phi);
  const oz = Math.sin(phi);
  const t = 0.0018; // half the lace's own thickness. See LACE_LIFT.

  const corner = (sx: number, sy: number, so: number): [number, number, number] => [
    cx + ax * sx * LACE_HALF_X + ox * so * t,
    cy + sy * LACE_HALF_Y,
    cz + az * sx * LACE_HALF_X + oz * so * t,
  ];
  const n = (x: number, y: number, z: number): [number, number, number] => [x, y, z];

  // Only the outward face and the four short sides; the underside is against the
  // leather and is never seen. Twenty triangles for four laces.
  const outward = n(ox, 0, oz);
  const top = corner(-1, 1, 1);
  const t2 = corner(1, 1, 1);
  const t3 = corner(1, -1, 1);
  const t4 = corner(-1, -1, 1);
  const b1 = corner(-1, 1, -1);
  const b2 = corner(1, 1, -1);
  const b3 = corner(1, -1, -1);
  const b4 = corner(-1, -1, -1);

  const quad = (
    p: [number, number, number], q: [number, number, number],
    r: [number, number, number], s: [number, number, number],
    nn: [number, number, number],
  ): void => {
    const i0 = b.vertex(p[0], p[1], p[2], nn, LACE);
    const i1 = b.vertex(q[0], q[1], q[2], nn, LACE);
    const i2 = b.vertex(r[0], r[1], r[2], nn, LACE);
    const i3 = b.vertex(s[0], s[1], s[2], nn, LACE);
    b.triangle(i0, i1, i2);
    b.triangle(i0, i2, i3);
  };

  // The face, wound counter-clockwise seen from outside: +Y edge first, then
  // down. `top -> t2` runs along +across, `t2 -> t3` runs along -Y, and
  // `across x -Y` is the outward normal.
  quad(top, t2, t3, t4, outward);
  // The two ends and the two long sides, each with its own flat normal.
  quad(t2, b2, b3, t3, n(ax, 0, az));
  quad(b1, top, t4, b4, n(-ax, 0, -az));
  quad(b1, b2, t2, top, n(0, 1, 0));
  quad(t4, t3, b3, b4, n(0, -1, 0));
}

// --- The third-person prop -----------------------------------------------------

/**
 * How the ball sits in the off hand.
 *
 * The **left** wrist, and that is forced rather than chosen: `player/bat.ts`
 * puts the bat in the right hand and `animation.punchPose` swings that arm
 * through 230 degrees. A ball in the same hand would be swung through the
 * pavement every time somebody took a swipe, and would leave the hand at the
 * bottom of the arc.
 */
const HOLD_OFFSET: readonly [number, number, number] = [-0.01, -0.085, -0.015];
/**
 * Cradled rather than aligned with the forearm. A ball held with its long axis
 * down the arm reads as a rugby ball tucked away; turned across the palm it
 * reads as a ball about to be thrown, which is what it is.
 */
const HOLD_ROTATION: readonly [number, number, number] = [1.15, 0, 0.4];

/**
 * One character's football, in their off hand.
 *
 * Parented to a **bone** rather than positioned each frame from a bone's world
 * matrix -- one line, and it saves a matrix decompose per character per frame,
 * because three composes the skeleton for the skinning anyway.
 *
 * Unlike the raygun this replaced, there is no stowed position: a ball is either
 * in your hand or it is in the air. `set(false)` hides it, which is what a
 * player with an empty bar or a ball in flight looks like -- and being able to
 * see at fifteen metres whether somebody is holding one is a real read, because
 * it is the difference between closing on them and staying out of range.
 */
export class FootyProp {
  readonly mesh: Mesh;

  constructor(assets: FootyAssets, actor: CharacterActor) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'footy:hand';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Culled with its character. A 0.28 m object on a figure that is already
    // frustum-tested has nothing to gain from a test of its own, and would need
    // its own animated bounds to survive a throw -- the trap `CharacterAssets`
    // documents about `SkinnedMesh.boundingSphere`.
    mesh.frustumCulled = false;
    mesh.position.set(HOLD_OFFSET[0], HOLD_OFFSET[1], HOLD_OFFSET[2]);
    mesh.rotation.set(HOLD_ROTATION[0], HOLD_ROTATION[1], HOLD_ROTATION[2]);
    actor.bones[BONE.WRIST_L].add(mesh);
    this.mesh = mesh;
  }

  /** In hand, or not. Called every frame from the ball count. */
  set(carrying: boolean): void {
    this.mesh.visible = carrying;
  }

  /**
   * Put this ball on the local player's own body: seen by the sun, not by the eye.
   *
   * The counterpart of `character.castShadowOnly`, and it has to be called
   * separately because **three does not inherit layers**. `Renderer._projectObject`
   * tests every object's own mask and recurses into its children either way, so
   * a prop parented to a bone of a mesh that was moved to `SELF_SHADOW_LAYER` is
   * still on layer 0 and is still drawn -- which in first person is an object
   * hanging at your own hip, in frame, every time you look down.
   *
   * **The raygun this replaced never called this**, which is exactly the bug
   * described: every player could see their own gun floating at their waist. It
   * is written down here because the failure is invisible to anyone testing in
   * third person and obvious to every player.
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

// --- The balls in the air ------------------------------------------------------

/**
 * How fast a ball tumbles, radians a second. See the header for why it is fixed
 * rather than keyed to the speed.
 *
 * 13 rad/s is a shade over two revolutions a second, which is a real drop punt's
 * rate and -- more usefully -- is slow enough that the laces are trackable and
 * fast enough that the ball never reads as frozen in a still frame.
 */
const TUMBLE_RATE = 13;

/**
 * How many balls can be drawn at once.
 *
 * Spec 2 caps the game at sixteen players, each with three in the bar, so the
 * hard ceiling is 48 -- but a ball lives 5 s and the bar returns one every 4 s,
 * so the steady state at that cap is closer to twenty. 32 is the ceiling this
 * pays for; past it the oldest is recycled, which is the better failure than
 * not drawing a ball somebody threw.
 */
const BALL_POOL = 32;

const WORLD_UP = /*#__PURE__*/ new Vector3(0, 1, 0);
const LOCAL_LONG_AXIS = /*#__PURE__*/ new Vector3(0, 1, 0);
const flightDir = /*#__PURE__*/ new Vector3();
const spinAxis = /*#__PURE__*/ new Vector3();
const alongFlight = /*#__PURE__*/ new Quaternion();
const tumble = /*#__PURE__*/ new Quaternion();

/**
 * Every football in the air, as a pool.
 *
 * One `Group` added to the scene once, holding pre-built meshes hidden when
 * idle -- the same trick `minimap.ts` uses for its markers and `world/birds.ts`
 * for its flocks, and the same one the beam pool this replaced used.
 *
 * The interface is deliberately **declarative per frame**: `begin()`, an `add()`
 * for every live ball wherever it came from, `end()`. That is what lets the
 * caller feed it from two completely different sources without this class
 * knowing -- the local player's own predicted throws, which are simulated in
 * this process, and every remote ball, which arrives interpolated out of the
 * snapshot stream. An id-keyed pool would have needed those two to agree about
 * identity, and they deliberately do not. See `net/client.ts`.
 */
export class FootyPool {
  readonly group = new Group();
  private readonly meshes: Mesh[] = [];
  private cursor = 0;

  constructor(assets: FootyAssets) {
    this.group.name = 'footballs';
    // Never culled as a group: its bounds would have to cover every ball in the
    // world and would be recomputed every frame. The cost of skipping the test
    // on 32 mostly-hidden meshes is nothing; the cost of a ball culled because
    // the group's bounds were stale is a throw that did not appear.
    this.group.frustumCulled = false;
    for (let i = 0; i < BALL_POOL; i++) {
      const mesh = new Mesh(assets.geometry, assets.material);
      mesh.name = `footy:${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Individually culled, unlike the props: a ball in the air is its own
      // object anywhere in a 100 m radius, and its bounding sphere is the
      // geometry's own and never animates -- the tumble is a rotation, which a
      // sphere does not notice.
      mesh.frustumCulled = true;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Start a frame. Everything not `add`ed before `end` is hidden. */
  begin(): void {
    this.cursor = 0;
  }

  /**
   * Draw one ball at a position, tumbling along a velocity.
   *
   * `age` is what advances the spin, so a ball drawn from an interpolated
   * snapshot and one simulated locally tumble identically given the same age --
   * which is the property that lets the two sources share a pool.
   */
  add(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    age: number,
  ): void {
    if (this.cursor >= this.meshes.length) return;
    const mesh = this.meshes[this.cursor++];
    mesh.position.set(x, y, z);

    const speed = Math.hypot(vx, vy, vz);
    if (speed > 0.5) {
      flightDir.set(vx / speed, vy / speed, vz / speed);
      // The long axis onto the flight. `setFromUnitVectors` handles the
      // antiparallel case, which a ball thrown straight down at the end of its
      // arc genuinely reaches.
      alongFlight.setFromUnitVectors(LOCAL_LONG_AXIS, flightDir);
      // ...then end over end about the horizontal perpendicular to the flight.
      spinAxis.crossVectors(flightDir, WORLD_UP);
      if (spinAxis.lengthSq() < 1e-8) spinAxis.set(1, 0, 0);
      spinAxis.normalize();
      tumble.setFromAxisAngle(spinAxis, age * TUMBLE_RATE);
      mesh.quaternion.copy(tumble).multiply(alongFlight);
    } else {
      // Nearly stopped -- a ball settling after its last bounce. Lay it on its
      // side rather than leaving it standing on a point, which is the one pose
      // a real one never holds.
      mesh.quaternion.setFromAxisAngle(WORLD_UP, age);
      mesh.rotateZ(Math.PI / 2);
    }
    mesh.visible = true;
  }

  /** Finish a frame: hide every slot that was not used. */
  end(): void {
    for (let i = this.cursor; i < this.meshes.length; i++) {
      if (!this.meshes[i].visible) break;
      this.meshes[i].visible = false;
    }
  }

  /** How many are being drawn. For the debug overlay. */
  get active(): number {
    return this.cursor;
  }
}

// --- The first-person ball -----------------------------------------------------

/**
 * How long the throw disturbs the viewmodel, seconds.
 *
 * Not a simulation number, and **the ordering it used to rest on has inverted**.
 *
 * *(Read the paragraph about `BALL_RECHARGE` at the end of this comment with
 * `FootyViewmodel.update`'s own note about `sinceThrow` beside it: this window is
 * driven by `combat.throwT`, which counts from a throw and from nothing else. It
 * used to be driven by `ballT`, which the refill consumes, and the whole of this
 * comment's "outside a burst" reasoning was quietly false because of it.)*
 *
 * It used to read: `game/combat.BALL_COOLDOWN` is 0.55 s and this is 0.34, so
 * the hand is back at rest with a fresh ball in it a fifth of a second before
 * the next throw is allowed, because a viewmodel still recovering when the
 * weapon is ready makes the weapon feel slower than it is.
 *
 * `BALL_COOLDOWN` is now 0.22 -- the player asked for the supply to restore 2.5x
 * faster and the floor between throws went with it -- so during a burst the next
 * throw arrives 0.12 s *before* this window closes and `sinceThrow` restarts
 * from zero.
 *
 * That is left as it is rather than shortened to 0.20 to restore the old
 * ordering, and the reason is what the two look like. The window is 0.09 s of
 * ball visibly leaving the hand and then an empty hand -- see
 * `RELEASE_SECONDS`. Restarting it early means a burst of three reads as three
 * releases back to back, which is what a burst of three is. Shortening the
 * window instead would put the resting ball back in frame for 20 ms between
 * each pair, and a ball flickering into and out of the hand three times in half
 * a second is the worse of the two by a distance.
 *
 * The old invariant still holds where it was actually about feel: outside a
 * burst, the bar refills every `BALL_RECHARGE` -- 1.6 s -- and the hand is long
 * since back at rest by then.
 */
export const THROW_SECONDS = 0.34;

/**
 * How long the ball is visibly leaving the hand, seconds.
 *
 * The ball is released on the tick the button goes down -- the simulation spawns
 * it immediately, and it has to, or the throw would not be predicted. So there
 * is no wind-up to draw: what the viewmodel shows is the *release*, 90 ms of the
 * ball accelerating out of frame, and then an empty hand recovering.
 *
 * That is the honest picture of what happened and it is also the responsive one.
 * A 150 ms wind-up like the bat's would look better in isolation and would mean
 * the visible throw began after the ball already had.
 */
const RELEASE_SECONDS = 0.09;

/** Where the ball rests in the frame: low and left, opposite the bat's corner. */
const REST_AT: readonly [number, number, number] = [-0.26, -0.235, -0.35];
/**
 * Where it is heading as it leaves: up, forward and toward the middle.
 *
 * The forward reach is 0.74 m rather than the metre the gesture would like,
 * and the constraint is `VIEW_REACH_BUDGET`: the ball's furthest vertex over the
 * whole release has to stay inside the same 0.90 m the bat's does, or this stops
 * being drawable in the ordinary depth buffer. Measured, this pose puts it at
 * 0.78 m. The lost distance costs nothing visible because the ball is also
 * shrinking as it goes -- see the scale at the end of `update`.
 */
const THROW_AT: readonly [number, number, number] = [-0.04, 0.03, -0.74];

/**
 * How the ball sits in the hand in first person, as three fixed angles.
 *
 *   > *"stop the football rotating in the hand, make it idle breathe like the
 *   > bat"*
 *
 * The Y here used to be `clock * 0.35` -- a lazy roll about the ball's own long
 * axis, put there so the laces would not be a static decal in the corner of the
 * frame all session. The reasoning was sound and the result was not: a roll about
 * the long axis moves the silhouette nowhere, so what the player actually sees is
 * the *lacing* crawling around a ball that is otherwise still, which reads as the
 * ball spinning in a closed hand. Nobody rotates a football they are holding.
 *
 * So it is a constant, and 0.62 rad is the value: far enough round from zero that
 * the seam and its four laces are across the visible face of the ball rather than
 * hidden behind the girth, which is the whole of what the roll was chasing. The X
 * and Z are the previous pose's own numbers -- the Z of -0.72 is the one that
 * matters, and `update` explains it -- so the resting silhouette is unchanged.
 *
 * Named for `FootyProp`'s `HOLD_ROTATION` deliberately: the third-person ball has
 * been a fixed cradle in the wrist since it was written, and after this the
 * first-person one is the same kind of object.
 */
const VIEW_HOLD_ROTATION: readonly [number, number, number] = [0.34, 0.62, -0.72];

/**
 * How far the first-person ball is scaled down.
 *
 * Viewmodels are always smaller than the object they represent -- see
 * `bat.MAX_VIEW_REACH` for the argument -- and a 0.28 m ball held where a hand
 * really is fills a quarter of the screen. 0.52 puts it at 0.146 m long, which
 * at the 0.44 m `REST_AT` holds it from the eye subtends 18 degrees: a quarter
 * of this project's 72-degree vertical field, with the whole outline inside the
 * frame rather than cropped by the corner.
 */
const VIEW_SCALE = 0.52;

/**
 * The football you are holding, in the corner of your own eye.
 *
 * A `Group` added to the **camera**, exactly as `BatViewmodel` is, which is why
 * `main.ts` has to put the camera in the scene: three walks `scene` and nothing
 * else, so a child of a detached camera is never drawn.
 *
 * It shares the bat's argument for being an ordinary lit object in the ordinary
 * depth buffer rather than a second render pass: it is small, it is close, and
 * `verifyFootyBall` asserts that no vertex of it at any point in the throw is
 * further from the eye than the bat's own `MAX_VIEW_REACH` -- so any wall it
 * could clip is a wall the player is already standing against.
 */
export class FootyViewmodel {
  readonly group: Group;
  readonly mesh: Mesh;

  private clock = 0;
  private stride = 0;
  /** Where `viewmodelIdle` writes. Owned rather than allocated per frame. */
  private readonly idle: IdleSway = { x: 0, y: 0 };

  constructor(assets: FootyAssets) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'footy:viewmodel';
    // Never in the depth pass, on `BatViewmodel`'s argument: an object welded to
    // the eye would cast a shadow from head height that follows the player
    // around the footpath.
    mesh.castShadow = false;
    // Receiving is kept, and it is what stops the ball looking pasted on: walk
    // into a terrace's shadow and it goes with you.
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.scale.setScalar(VIEW_SCALE);

    const group = new Group();
    group.name = 'footy:viewmodel:root';
    group.frustumCulled = false;
    group.add(mesh);

    this.mesh = mesh;
    this.group = group;
  }

  /**
   * Pose the ball for this frame.
   *
   * `sinceThrow` is the local player's own predicted `combat.throwT`, so the
   * release starts on the frame the button goes down rather than on the next
   * round trip -- the same argument `BatViewmodel` makes about reading the
   * predicted phase.
   *
   * **It was `combat.ballT` until this round, and that was the "recharge
   * animation" the owner asked to have removed.** `ballT` is the *supply's* clock
   * and the refill **consumes** it -- `advance` does `ballT -= BALL_RECHARGE` every
   * time a ball comes back -- so it returns to zero every 1.6 s while the bar is
   * filling, and every one of those wraps looked exactly like a throw to this
   * function. What the player saw was the ball flinging itself out of frame and a
   * new one appearing, twice, after every single throw, with no input: the release
   * below is a perfectly good animation being fired by a clock that was not
   * measuring what its reader thought. `combat.throwT` is the second clock added
   * for this, counted from a throw and never consumed, and its header carries the
   * argument for why the two genuinely are different numbers.
   */
  update(
    dt: number,
    state: {
      /** Seconds since the last throw. `combat.throwT` -- **not** `ballT`. */
      sinceThrow: number;
      /** Balls left. With none there is nothing in the hand to draw. */
      charges: number;
      /** Horizontal speed, m/s. Drives the bob. */
      speed: number;
      /** A knocked-out player is not holding anything up. */
      down: boolean;
      hitstop: boolean;
    },
  ): void {
    const step = state.hitstop ? 0 : dt;
    this.clock += step;
    this.stride = (this.stride + state.speed * step * 3.6) % (Math.PI * 2);

    const t = state.sinceThrow;
    const throwing = t < THROW_SECONDS;
    // Nothing to draw when the bar is empty and the last throw has landed, when
    // the ball is mid-flight, or when the player is on the pavement.
    if (state.down || (!throwing && state.charges <= 0)) {
      this.group.visible = false;
      return;
    }
    if (throwing && t >= RELEASE_SECONDS) {
      // Released and gone. The hand is empty for the rest of the window, which
      // is what makes the next ball appearing read as picking one up rather
      // than as the same one bouncing back.
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const gait = Math.min(1, state.speed / 8.2);
    const bob = Math.sin(this.stride * 2) * 0.022 * gait;
    // A slow drift when standing still, and **it is now the bat's own, from the
    // one module both viewmodels call**. It used to be four lines here on 0.67 and
    // 0.91 Hz against the bat's 0.71 and 0.94 -- nobody chose that difference, and
    // two nearly-equal periods on two objects that share the frame beat against
    // each other over about half a minute. See `player/viewmodel-idle.ts`, and
    // `verifyFootyBall`, which asserts this is what is applied rather than a copy.
    const idle = viewmodelIdle(this.clock, gait, this.idle);
    const idleX = idle.x;
    const idleY = idle.y;

    // The release: 90 ms from the resting hand to out of frame, eased so the
    // ball is already moving fast on the first frame. A linear launch reads as
    // the ball being carried away rather than thrown.
    const k = throwing ? clamp01(t / RELEASE_SECONDS) : 0;
    const eased = k * (2 - k);
    this.group.position.set(
      REST_AT[0] + (THROW_AT[0] - REST_AT[0]) * eased + idleX,
      REST_AT[1] + (THROW_AT[1] - REST_AT[1]) * eased + bob + idleY,
      REST_AT[2] + (THROW_AT[2] - REST_AT[2]) * eased,
    );
    // Turning over as it goes, and **nothing at all in the hand**: the ball sits
    // at `VIEW_HOLD_ROTATION` until a throw tips it out, and the only thing that
    // moves it at rest is the walk.
    //
    // The Y used to be `clock * 0.35` and the owner asked for it to stop; the
    // constant's own comment carries that argument. What is left is:
    //
    //   **X** tips the ball forward through the release. `eased` is zero for every
    //   frame that is not part of a throw, so this term is the release and nothing
    //   else -- there is no clock in it.
    //   **Y** is a fixed roll about the ball's own long axis (the mesh's local +Y),
    //   which moves the silhouette nowhere and only decides where the laces face.
    //   **Z** is what lays the ball diagonally across the corner, and it is the one
    //   of the three that decides whether this reads as a football at all: left
    //   upright by a Z of zero the ball is an egg standing on end, which is the one
    //   pose a real one never holds in a hand. The stride term on it is the same
    //   walk-driven roll `BatViewmodel` has, and like the bat's it is exactly zero
    //   standing still.
    this.group.rotation.set(
      VIEW_HOLD_ROTATION[0] - eased * 1.5,
      VIEW_HOLD_ROTATION[1],
      VIEW_HOLD_ROTATION[2] + Math.sin(this.stride) * 0.05 * gait,
    );
    // Shrinking as it leaves, which does the work a motion blur would: at 26 m/s
    // a real ball covers its own length in 11 ms, so a viewmodel that stayed
    // full size for 90 ms would read as floating.
    this.mesh.scale.setScalar(VIEW_SCALE * (1 - eased * 0.55));
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The one (geometry, material) pair every football is drawn with, for the warm-up. */
export function footyWarmupParts(assets: FootyAssets): WarmupPart[] {
  return [{ geometry: assets.geometry, material: assets.material, casts: true }];
}

// --- The self-check ------------------------------------------------------------

/**
 * The ball's model and its two mountings, asserted.
 *
 * The repo's rule -- `verifyBat`, `verifyCharacterRig`, `verifyCombat` -- is
 * that a check exists where the failure is **silent**: it renders, it does not
 * throw, and it reads as a taste decision. Four here, and two of them are
 * failures this project has actually shipped:
 *
 *   - **Winding.** A closed surface built inside out is invisible from outside
 *     and perfect from within, which is the README's own winding pass on the
 *     city's walls, one object down.
 *   - **Proportion.** A ball that has drifted toward a sphere is still a ball in
 *     a screenshot and is a rugby ball in the air. The 1.61 ratio is the whole
 *     silhouette.
 *   - **The prop is layered.** The ray-gun this weapon replaced never called
 *     `castShadowOnly`, so every player saw their own weapon floating at their
 *     hip for the life of that feature. It is invisible to anyone testing in
 *     third person. This is the check that would have caught it.
 *   - **The viewmodel stays close.** The claim that lets it be drawn in the
 *     ordinary depth buffer instead of a second pass, so it is measured rather
 *     than trusted.
 *
 *     bun -e "import {verifyFootyBall} from './client/src/world/footyball.ts';
 *             console.log(verifyFootyBall())"
 */
export function verifyFootyBall(): string[] {
  // The shared breath, from here as well as from `verifyBat`. Running it twice
  // costs a millisecond and means the ball's check is complete on its own: this
  // file's claim is "the held ball breathes like the bat", and half of that claim
  // is that the function it calls is sane.
  const failures: string[] = [...verifyViewmodelIdle()];
  const assets = new FootyAssets();

  // --- Budget. Not a spec number, but the figure carrying it is 440 triangles
  // and the bat in its other hand is 128; a ball that outweighs either is a ball
  // that was modelled rather than built.
  if (assets.triangles > 180) {
    failures.push(`The football is ${assets.triangles} triangles; the bat beside it is 128.`);
  }

  const position = assets.geometry.getAttribute('position');
  const normal = assets.geometry.getAttribute('normal');
  const index = assets.geometry.getIndex();
  if (index === null) {
    failures.push('The football geometry is not indexed.');
    return failures;
  }

  // --- Winding. Every triangle's cross product has to agree with the mean of
  // the three vertex normals it was built from -- and those came from the
  // ellipsoid's analytic gradient, not from the triangles, so this is a real
  // test rather than a tautology.
  {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    const face = new Vector3();
    let disagreeing = 0;
    let degenerate = 0;
    for (let t = 0; t < index.count; t += 3) {
      const i0 = index.getX(t);
      const i1 = index.getX(t + 1);
      const i2 = index.getX(t + 2);
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      c.fromBufferAttribute(position, i2);
      face.copy(b).sub(a).cross(n.copy(c).sub(a));
      if (face.lengthSq() < 1e-16) {
        degenerate++;
        continue;
      }
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
        `${disagreeing} of ${index.count / 3} football triangles are wound against their own ` +
          `normals -- they will be back-face culled and the ball will be see-through.`,
      );
    }
    if (degenerate > 0) {
      failures.push(
        `${degenerate} football triangles have no area. The polar bands are meant to be emitted ` +
          `as triangles rather than as collapsed quads, or the winding check silently skips them.`,
      );
    }
  }

  // --- Proportion. The ratio is the silhouette; a drifted one is another sport.
  {
    let minY = Infinity;
    let maxY = -Infinity;
    let maxR = 0;
    const v = new Vector3();
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
      maxR = Math.max(maxR, Math.hypot(v.x, v.z));
    }
    const length = maxY - minY;
    const girth = maxR * 2;
    if (Math.abs(length - SEMI_LONG * 2) > 0.005) {
      failures.push(`The football is ${(length * 1000).toFixed(0)} mm long; a Sherrin is 280.`);
    }
    const ratio = length / girth;
    if (ratio < 1.45 || ratio > 1.75) {
      failures.push(
        `The football's long axis is ${ratio.toFixed(2)}x its girth. An AFL ball is 1.61; ` +
          `at 1.45 it is a rugby ball and at 1.2 it is an egg.`,
      );
    }
    // The collision sphere the simulation uses has to be somewhere between the
    // two semi-axes, or the picture and the hit test are different objects.
    if (BALL_RADIUS < girth / 2 - 1e-6 || BALL_RADIUS > length / 2 + 1e-6) {
      failures.push(
        `game/footy.ts tests a ${BALL_RADIUS} m sphere against a ball that is ${(girth / 2).toFixed(3)} m ` +
          `by ${(length / 2).toFixed(3)} m. The hit test is not the object being drawn.`,
      );
    }
  }

  // --- The prop: on the off hand, and on the shadow layer when it is asked to
  // be. The second half is the raygun's bug -- see the header.
  {
    const characters = new CharacterAssets();
    const actor = new CharacterActor(characters, 0);
    const prop = new FootyProp(assets, actor);
    if (prop.mesh.parent !== actor.bones[BONE.WRIST_L]) {
      failures.push(
        `The football is parented to "${prop.mesh.parent?.name ?? 'nothing'}" rather than to the ` +
          `left wrist bone. The right hand holds the bat and swings through 230 degrees.`,
      );
    }
    prop.castShadowOnly();
    if (!prop.mesh.layers.isEnabled(SELF_SHADOW_LAYER) || prop.mesh.layers.isEnabled(0)) {
      failures.push(
        `castShadowOnly left the football on layer 0, so the local player sees their own ball ` +
          `floating at their hip. three does not inherit layers -- this is the bug the raygun ` +
          `this replaced shipped with.`,
      );
    }
    if (!prop.mesh.castShadow) {
      failures.push('A shadow-only football does not cast a shadow, which leaves it drawing nothing at all.');
    }
    prop.dispose();
  }

  // --- The viewmodel stays inside the bat's own wall-clipping budget, over the
  // whole release. See `bat.MAX_VIEW_REACH` for what the number buys.
  {
    const view = new FootyViewmodel(assets);
    const vertex = new Vector3();
    let furthest = 0;
    for (let i = 0; i <= 16; i++) {
      view.update(1 / 60, {
        sinceThrow: (i / 16) * THROW_SECONDS,
        charges: 3,
        speed: 0,
        down: false,
        hitstop: false,
      });
      view.group.updateMatrixWorld(true);
      if (!view.group.visible) continue;
      for (let v = 0; v < position.count; v++) {
        vertex.fromBufferAttribute(position, v).applyMatrix4(view.mesh.matrixWorld);
        furthest = Math.max(furthest, vertex.length());
      }
    }
    if (furthest > VIEW_REACH_BUDGET) {
      failures.push(
        `The first-person football reaches ${furthest.toFixed(2)} m from the eye, past the ` +
          `${VIEW_REACH_BUDGET.toFixed(2)} m budget that lets a viewmodel be drawn in the ordinary ` +
          `depth buffer rather than in a second pass.`,
      );
    }
    // And it goes away when there is nothing to hold, which is the read that
    // makes the bar legible without looking at the HUD.
    view.update(1 / 60, { sinceThrow: 10, charges: 0, speed: 0, down: false, hitstop: false });
    if (view.group.visible) failures.push('The first-person football is drawn with an empty bar.');
    view.update(1 / 60, { sinceThrow: 10, charges: 3, speed: 0, down: true, hitstop: false });
    if (view.group.visible) failures.push('The first-person football is drawn over a knocked-out player.');
  }

  // --- The held ball is **still**, and the supply refilling does not move it.
  //
  //   > *"remove the recharge animation for the football, and stop the football
  //   > rotating in the hand, make it idle breathe like the bat"*
  //
  // Three claims, and all three are silent in this repo's sense: every one of them
  // draws a perfectly good frame, and the previous version of this file drew two
  // of them for the whole life of the feature.
  //
  //   1. **No spin.** The rotation of a ball in the hand is a constant. It was
  //      `clock * 0.35` about the long axis, which turned the lacing without moving
  //      the outline -- a ball rotating inside a closed hand.
  //   2. **No recharge motion.** This is the one that was a *wiring* bug rather
  //      than a taste one: the release was driven by `combat.ballT`, which the
  //      refill consumes, so the ball threw itself out of frame every 1.6 s with no
  //      input. Asserted by driving a bar that is filling against one that is
  //      already full and requiring the two poses to be identical to the bit.
  //   3. **The breath is the bat's**, from the shared module and not a copy.
  {
    const idleView = new FootyViewmodel(assets);
    const rest = new FootyViewmodel(assets);
    const want: IdleSway = { x: 0, y: 0 };
    // 3 s at 50 ms, which is 60 frames and two and a half of the 1.6 s recharge
    // the owner's note is about.
    const STEP = 0.05;
    const FRAMES = 60;
    let clock = 0;
    let worstIdle = 0;
    let spun = 0;
    let refillMoved = 0;
    for (let i = 0; i < FRAMES; i++) {
      clock += STEP;
      // The filling bar: one ball at 1.6 s and another at 3.2, and a throw clock
      // that keeps counting because a refill is not a throw. This is exactly the
      // state a player is in for the three seconds after they throw one ball.
      idleView.update(STEP, {
        sinceThrow: 2 + clock,
        charges: clock >= 3.2 ? 3 : clock >= 1.6 ? 2 : 1,
        speed: 0,
        down: false,
        hitstop: false,
      });
      // And the same three seconds with a full bag: nothing recharging at all.
      rest.update(STEP, { sinceThrow: 2 + clock, charges: 3, speed: 0, down: false, hitstop: false });

      // (1) The rotation is the hold pose, exactly, with no clock in it.
      const r = idleView.group.rotation;
      if (
        r.x !== VIEW_HOLD_ROTATION[0] ||
        r.y !== VIEW_HOLD_ROTATION[1] ||
        r.z !== VIEW_HOLD_ROTATION[2]
      ) {
        spun++;
      }
      // (2) The refill changed nothing. `Object.is` rather than a tolerance,
      // because the two runs are the same arithmetic on the same clock and any
      // difference at all is a term keyed to the supply.
      const a = idleView.group.position;
      const b = rest.group.position;
      if (!Object.is(a.x, b.x) || !Object.is(a.y, b.y) || !Object.is(a.z, b.z)) refillMoved++;
      if (idleView.group.visible !== rest.group.visible) refillMoved++;
      // (3) The position is the rest pose plus the shared idle and nothing else.
      viewmodelIdle(clock, 0, want);
      worstIdle = Math.max(
        worstIdle,
        Math.abs(a.x - REST_AT[0] - want.x),
        Math.abs(a.y - REST_AT[1] - want.y),
        Math.abs(a.z - REST_AT[2]),
      );
    }
    if (spun > 0) {
      failures.push(
        `Over 3 s of standing still holding a ball, the viewmodel's rotation left the hold pose on ` +
          `${spun} of ${FRAMES} frames. A held football does not turn in the hand -- see ` +
          `VIEW_HOLD_ROTATION, which is what the owner asked for by name.`,
      );
    }
    if (refillMoved > 0) {
      failures.push(
        `The ball moved on ${refillMoved} of ${FRAMES} frames purely because the supply bar was ` +
          `refilling. That is the "recharge animation": the release must be driven by combat.throwT, ` +
          `which counts from a throw, and never by ballT, which the refill consumes.`,
      );
    }
    if (worstIdle > 1e-9) {
      failures.push(
        `At rest the held ball's offset differs from viewmodelIdle by ${(worstIdle * 1000).toFixed(2)} mm ` +
          `-- so it is not breathing with the bat. Both viewmodels call ` +
          `player/viewmodel-idle.ts; a copy of those four lines here is the drift that module exists ` +
          `to stop.`,
      );
    }
    // And the bar emptying does not move it either, which is the same failure
    // wearing the other sign: the last ball leaving the hand is a throw and the
    // *count* going to zero is not.
    rest.update(0, { sinceThrow: 9, charges: 3, speed: 0, down: false, hitstop: false });
    const held: [number, number, number] = [rest.group.position.x, rest.group.position.y, rest.group.position.z];
    rest.update(0, { sinceThrow: 9, charges: 1, speed: 0, down: false, hitstop: false });
    if (
      !Object.is(rest.group.position.x, held[0]) ||
      !Object.is(rest.group.position.y, held[1]) ||
      !Object.is(rest.group.position.z, held[2])
    ) {
      failures.push(
        'The number of balls in the bar moves the one in the hand. The count is the HUD bar\'s job; ' +
          'the viewmodel only knows whether there is a ball at all.',
      );
    }
  }

  return failures;
}

/**
 * `player/bat.ts`'s `MAX_VIEW_REACH`, restated rather than imported.
 *
 * The same second-opinion argument `verifyBat` makes about
 * `MEASURED_REACH_TARGET`: importing the constant would make this assert that a
 * number equals itself through two files, where writing it down separately means
 * a change to the budget in one weapon shows up as a disagreement here.
 */
const VIEW_REACH_BUDGET = 0.9;
