/**
 * The lime e-bike, as an object you can see.
 *
 * The rendering half of the feature. `game/bikes.ts` is the rules -- where they
 * are, who is on one, how fast that makes you -- and imports nothing from three;
 * this draws what that file decides, on exactly the split `world/powerups.ts`
 * and `game/powerups.ts` already make. Nothing here decides anything.
 *
 * ---------------------------------------------------------------------------
 * IT IS BUILT TO THE RIDER, NOT THE OTHER WAY ROUND.
 *
 * Every dimension that touches the rider comes from `player/animation.ts`:
 * `SADDLE_Y`, `BAR_Y`, `BAR_Z`, `BAR_HALF_WIDTH`, `PEDAL_Y`, `PEDAL_Z`. That
 * direction is deliberate and it was not free -- the rig is fixed, the arm is
 * 0.64 m long, and a seated figure's hands land where they land, so a bike drawn
 * to a nice-looking side elevation puts its bars 15 cm past the end of the
 * rider's reach. (That is not hypothetical: it is what the first version of
 * these two files did, and `verifyCharacterRig` is what caught it.) So the pose
 * was solved against the real skeleton, the constants record the answer, and
 * this file draws a bike around them.
 *
 * ---------------------------------------------------------------------------
 * ONE GEOMETRY, INSTANCED, AND NO SHADER.
 *
 * A share bike is the same object every time, so it is one `BufferGeometry` with
 * baked vertex colours and one `MeshStandardNodeMaterial` with `vertexColors`,
 * which is the same arrangement `player/character.ts` uses for its seven kits
 * and for the same reason: `NodeMaterial` already multiplies the material colour
 * by the geometry's own, so a five-colour object costs one built-in multiply and
 * no shader graph.
 *
 * **Deliberately not in the powerups' three-pass visual language.** Those get a
 * depth-free ghost and a shell so they can be seen through buildings, because
 * spec 8.3 asks for it. A bike is not a pickup and must not read as one: it is a
 * physical object parked on a footpath, it is occluded by the terrace in front of
 * it, and finding one is meant to be a find. What makes it visible at range is
 * that it is bright yellow-green in a city of brick and sandstone, which is
 * exactly what makes the real ones visible.
 */

import { float, sin, time } from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  Quaternion,
  Sphere,
  Vector3,
} from 'three/webgpu';

import {
  BAR_HALF_WIDTH,
  BAR_Y,
  BAR_Z,
  PEDAL_Y,
  PEDAL_Z,
  SADDLE_Y,
  SADDLE_Z,
} from '../player/animation.ts';
import type { Bike } from '../game/bikes.ts';
import { TUNING_RADIUS, TUNING_X, TUNING_Z } from '../game/bikes.ts';

type Point = readonly [number, number, number];
type Rgb = readonly [number, number, number];

// --- The palette --------------------------------------------------------------

/**
 * Lime green, **linear**, as every colour in this project is.
 *
 * The user asked for "a lime green" and named the share bike, so this is that
 * one: sRGB #9BC53D, the bright yellow-green that reads as a bike rather than as
 * a leaf. Converted properly rather than pasted -- `((c + 0.055) / 1.055)^2.4`
 * per channel -- because a sRGB triple dropped into a linear pipeline comes out
 * a washed-out sage, which is the single most common way a colour goes wrong in
 * this renderer, and then nudged a few percent up: the frame is tone-mapped at
 * `calibration.EXPOSURE` under a Sydney sun, and the point of the colour is to be
 * findable from the other end of a street.
 */
const LIME: Rgb = [0.35, 0.6, 0.05];
/** Tyres. Near-black rather than black, so the facets still read in shade. */
const TYRE: Rgb = [0.028, 0.028, 0.03];
/** Rims, forks, cranks, kickstand. */
const METAL: Rgb = [0.34, 0.35, 0.38];
/** The battery on the downtube, and the saddle. Both are dark mouldings. */
const DARK: Rgb = [0.055, 0.058, 0.065];
/** The front mudguard, and the flash on the battery. */
const WHITE: Rgb = [0.8, 0.81, 0.79];
/** The basket, a grey moulding a shade off the metal so the two do not merge. */
const BASKET: Rgb = [0.16, 0.17, 0.17];

// --- Dimensions ---------------------------------------------------------------

/**
 * Wheel radius, metres. A 26" tyre is 0.34 m, and the bike is drawn at 1:1 --
 * everything else in this world is, and a bike that was not would be obvious
 * next to a 1.70 m rider sitting on it.
 */
const WHEEL_R = 0.33;
const FRONT_Z = -0.62;
const REAR_Z = 0.53;
/** Frame tube radius. Fat, because a share bike's tubes are fat. */
const TUBE_R = 0.032;

/** Sides on a frame tube and on a wheel's rim loop. See `verifyBikeMesh`. */
const TUBE_SIDES = 5;
const WHEEL_SIDES = 12;
const TYRE_SIDES = 4;

/**
 * How far a ridden bike leans into a full-rate turn, radians.
 *
 * 0.22 is 12.6 degrees, which is roughly what a commuter does at a roundabout
 * and about half what a bike at 26 m/s would really need -- the honest angle
 * for the speed is nearer 40 degrees and it looks like a crash from behind,
 * because the camera is 3.5 m back and level and the rider does not lean with
 * it. What this is for is *reading the turn*: at 12 degrees the silhouette
 * changes enough to say "you are cornering" and not enough to say "you have
 * fallen over".
 *
 * The roll is about the bike's own -Z, which passes through the tyre contact
 * patch at the origin, so leaning does not lift the wheels off the road.
 * Cosmetic in the strictest sense: `main.ts` applies it to one instance matrix
 * and nothing in the simulation can see it.
 */
export const BIKE_LEAN = 0.22;

// --- The builder --------------------------------------------------------------

/**
 * Indexed triangles with a colour per vertex.
 *
 * `character.Parts` with the skinning taken out and a colour put in, and the
 * winding is lifted from it verbatim rather than re-derived -- the README's
 * winding pass is about exactly this, and a tube wound inside out is a bike you
 * can see straight through from one side and not the other.
 */
class BikeParts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  private vertex(p: Point, n: Point, c: Rgb): void {
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.colour.push(c[0], c[1], c[2]);
  }

  /** A ring-to-ring tube between two points, open at both ends. */
  tube(from: Point, to: Point, r0: number, r1: number, sides: number, c: Rgb): void {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const len = Math.hypot(ax, ay, az) || 1;
    const dx = ax / len;
    const dy = ay / len;
    const dz = az / len;
    // The reference vector switches on a near-vertical axis, exactly as
    // `character.Parts.tube` does: a seat tube is vertical and a chainstay is
    // horizontal, and one fixed reference collapses the cross product on one of
    // them.
    const vertical = Math.abs(dy) > 0.9;
    let ux = vertical ? 0 : dz;
    let uy = vertical ? -dz : 0;
    let uz = vertical ? dy : -dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const base = this.position.length / 3;
    for (const [o, r] of [[from, r0], [to, r1]] as Array<[Point, number]>) {
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = ux * ca + vx * sa;
        const ny = uy * ca + vy * sa;
        const nz = uz * ca + vz * sa;
        this.vertex([o[0] + nx * r, o[1] + ny * r, o[2] + nz * r], [nx, ny, nz], c);
      }
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.index.push(base + i, base + j, base + sides + j);
      this.index.push(base + i, base + sides + j, base + sides + i);
    }
  }

  /**
   * A wheel: a torus in the XY plane at `centre`, so it rolls along Z.
   *
   * A real torus rather than a flat ring, because a ring seen edge-on -- which
   * is how you see a bike parked beside you on a footpath -- disappears
   * entirely, and a bike with no wheels from one angle is worse than a bike with
   * cheap ones from all of them.
   */
  wheel(centre: Point, major: number, minor: number, c: Rgb): void {
    const base = this.position.length / 3;
    for (let i = 0; i < WHEEL_SIDES; i++) {
      const a = (i / WHEEL_SIDES) * Math.PI * 2;
      // The ring runs in the YZ plane -- a wheel's axle is along X.
      const ry = Math.sin(a);
      const rz = Math.cos(a);
      for (let j = 0; j < TYRE_SIDES; j++) {
        const b = (j / TYRE_SIDES) * Math.PI * 2;
        const cb = Math.cos(b);
        const sb = Math.sin(b);
        // Normal points out of the tube: along the ring's own radius, plus the
        // axle direction.
        const nx = sb;
        const ny = ry * cb;
        const nz = rz * cb;
        this.vertex(
          [
            centre[0] + minor * sb,
            centre[1] + ry * (major + minor * cb),
            centre[2] + rz * (major + minor * cb),
          ],
          [nx, ny, nz],
          c,
        );
      }
    }
    for (let i = 0; i < WHEEL_SIDES; i++) {
      const i2 = (i + 1) % WHEEL_SIDES;
      for (let j = 0; j < TYRE_SIDES; j++) {
        const j2 = (j + 1) % TYRE_SIDES;
        const a = base + i * TYRE_SIDES + j;
        const b = base + i * TYRE_SIDES + j2;
        const d = base + i2 * TYRE_SIDES + j;
        const e = base + i2 * TYRE_SIDES + j2;
        this.index.push(a, e, d);
        this.index.push(a, b, e);
      }
    }
  }

  /** An axis-aligned box. Six quads, flat-shaded, one colour. */
  box(centre: Point, half: Point, c: Rgb): void {
    const [cx, cy, cz] = centre;
    const [hx, hy, hz] = half;
    const faces: Array<[Point, Point, Point]> = [
      [[0, 0, 1], [hx, 0, 0], [0, hy, 0]],
      [[0, 0, -1], [-hx, 0, 0], [0, hy, 0]],
      [[1, 0, 0], [0, 0, -hz], [0, hy, 0]],
      [[-1, 0, 0], [0, 0, hz], [0, hy, 0]],
      [[0, 1, 0], [hx, 0, 0], [0, 0, -hz]],
      [[0, -1, 0], [hx, 0, 0], [0, 0, hz]],
    ];
    for (const [n, u, v] of faces) {
      const base = this.position.length / 3;
      const o: Point = [cx + n[0] * hx, cy + n[1] * hy, cz + n[2] * hz];
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) {
        this.vertex(
          [o[0] + u[0] * su + v[0] * sv, o[1] + u[1] * su + v[1] * sv, o[2] + u[2] * su + v[2] * sv],
          n,
          c,
        );
      }
      this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /**
   * A curved strip over a wheel: the mudguard.
   *
   * Two-sided, because it is a single surface with no thickness and a player
   * standing on the wrong side of the bike would otherwise see through the front
   * wheel's guard into the tyre.
   */
  guard(centre: Point, radius: number, halfWidth: number, from: number, to: number, steps: number, c: Rgb): void {
    for (let s = 0; s < steps; s++) {
      const a0 = from + ((to - from) * s) / steps;
      const a1 = from + ((to - from) * (s + 1)) / steps;
      for (const [a, b] of [[a0, a1], [a1, a0]] as Array<[number, number]>) {
        const base = this.position.length / 3;
        // Flipping the pair flips the winding, which is what makes the second
        // pass the back face rather than a duplicate of the front.
        const n: Point = [0, Math.sin((a + b) / 2), Math.cos((a + b) / 2)];
        const sign = a < b ? 1 : -1;
        for (const [ang, w] of [[a, -1], [a, 1], [b, 1], [b, -1]] as Array<[number, number]>) {
          this.vertex(
            [centre[0] + halfWidth * w, centre[1] + Math.sin(ang) * radius, centre[2] + Math.cos(ang) * radius],
            [n[0], n[1] * sign, n[2] * sign],
            c,
          );
        }
        this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
}

/**
 * The bike itself, in bike-local metres.
 *
 * The origin is **on the ground under the rider**, with -Z forward and the rider
 * facing -Z, which is the frame every character in this project already uses.
 * That is what lets a bike be drawn at its rider's feet position and yaw with no
 * offset at all while it is being ridden, and at its own parked position when it
 * is not.
 */
function buildBike(): BikeParts {
  const p = new BikeParts();

  // --- Wheels and the running gear.
  p.wheel([0, WHEEL_R, FRONT_Z], WHEEL_R - 0.04, 0.04, TYRE);
  p.wheel([0, WHEEL_R, REAR_Z], WHEEL_R - 0.04, 0.04, TYRE);
  // Hubs, so the wheels have a centre to be a wheel around.
  p.tube([-0.045, WHEEL_R, FRONT_Z], [0.045, WHEEL_R, FRONT_Z], 0.035, 0.035, 6, METAL);
  p.tube([-0.055, WHEEL_R, REAR_Z], [0.055, WHEEL_R, REAR_Z], 0.05, 0.05, 6, METAL);

  // --- The fork: two blades from the head down to the front hub.
  const headTop: Point = [0, BAR_Y - 0.06, BAR_Z + 0.06];
  const headBottom: Point = [0, 0.66, FRONT_Z + 0.05];
  for (const side of [-1, 1]) {
    p.tube([side * 0.045, 0.62, FRONT_Z + 0.03], [side * 0.05, WHEEL_R, FRONT_Z], 0.022, 0.018, 4, METAL);
  }
  // The head tube, which is the steerer and is what the bars sit on.
  p.tube(headBottom, headTop, 0.036, 0.032, TUBE_SIDES, LIME);
  p.tube([0, 0.62, FRONT_Z + 0.03], headBottom, 0.03, 0.032, TUBE_SIDES, METAL);

  // --- The step-through frame. One deep curved spine from the head tube back to
  // the seat tube, which is the silhouette that says "share bike" rather than
  // "road bike" -- there is no top tube at all, and that absence is the read.
  const spine: Point[] = [
    [0, 0.86, FRONT_Z + 0.18],
    [0, 0.62, FRONT_Z + 0.34],
    [0, 0.46, -0.1],
    [0, 0.44, 0.12],
    [0, 0.5, 0.28],
  ];
  for (let i = 0; i < spine.length - 1; i++) {
    p.tube(spine[i], spine[i + 1], TUBE_R, TUBE_R, TUBE_SIDES, LIME);
  }
  // Head tube to the spine's front end.
  p.tube(headBottom, spine[0], 0.03, TUBE_R, TUBE_SIDES, LIME);
  // The seat tube, up to the saddle.
  p.tube([0, 0.5, 0.28], [0, SADDLE_Y - 0.05, SADDLE_Z + 0.16], 0.033, 0.026, TUBE_SIDES, LIME);
  // Chainstays and seatstays, one pair each, to the rear hub.
  for (const side of [-1, 1]) {
    p.tube([side * 0.03, 0.44, 0.2], [side * 0.055, WHEEL_R, REAR_Z], 0.02, 0.016, 4, LIME);
    p.tube([side * 0.025, SADDLE_Y - 0.1, SADDLE_Z + 0.14], [side * 0.05, WHEEL_R, REAR_Z], 0.018, 0.014, 4, LIME);
  }

  // --- The battery, on the downtube where an e-bike carries it. The one detail
  // that makes it an *e*-bike at a glance, so it is a real box rather than a
  // bulge, with a white flash along it.
  p.box([0, 0.55, -0.16], [0.055, 0.085, 0.24], DARK);
  p.box([0.057, 0.55, -0.16], [0.004, 0.02, 0.19], WHITE);
  p.box([-0.057, 0.55, -0.16], [0.004, 0.02, 0.19], WHITE);

  // --- The bottom bracket and cranks, at the height the rider's feet actually
  // are. See `animation.PEDAL_Y`: this is the constant the pose was solved to.
  p.tube([-0.06, PEDAL_Y, PEDAL_Z], [0.06, PEDAL_Y, PEDAL_Z], 0.045, 0.045, 6, METAL);
  // Chainring, a flat disc of a cylinder on the drive side.
  p.tube([0.065, PEDAL_Y, PEDAL_Z], [0.075, PEDAL_Y, PEDAL_Z], 0.11, 0.11, 10, METAL);
  for (const side of [-1, 1]) {
    // Crank arms, opposed, so the bike is parked with one pedal up like a real
    // one. The pedal itself is a small plate at the end.
    const up = side > 0 ? 1 : -1;
    p.tube(
      [side * 0.07, PEDAL_Y, PEDAL_Z],
      [side * 0.07, PEDAL_Y + up * 0.15, PEDAL_Z + up * 0.05],
      0.016, 0.014, 4, METAL,
    );
    p.box([side * 0.11, PEDAL_Y + up * 0.15, PEDAL_Z + up * 0.05], [0.035, 0.012, 0.045], DARK);
  }

  // --- The saddle, and the handlebars at the rider's own grips.
  p.box([0, SADDLE_Y, SADDLE_Z], [0.075, 0.03, 0.13], DARK);
  p.tube([-BAR_HALF_WIDTH, BAR_Y, BAR_Z], [BAR_HALF_WIDTH, BAR_Y, BAR_Z], 0.019, 0.019, 5, METAL);
  // The stem, from the head tube up and forward to the middle of the bar.
  p.tube(headTop, [0, BAR_Y, BAR_Z], 0.024, 0.022, 5, LIME);
  // Grips, where the mitts land.
  for (const side of [-1, 1]) {
    p.tube(
      [side * (BAR_HALF_WIDTH - 0.09), BAR_Y, BAR_Z],
      [side * BAR_HALF_WIDTH, BAR_Y, BAR_Z],
      0.026, 0.026, 5, DARK,
    );
  }

  // --- The front basket. Optional in the brief and included because it is half
  // the silhouette of a share bike from the front, and because it is 12
  // triangles. Open-topped: five faces would need a five-face box, so it is a
  // shallow closed one with a lighter rim, which reads the same at any distance
  // anybody sees it from.
  p.box([0, 0.95, BAR_Z - 0.11], [0.13, 0.085, 0.09], BASKET);
  p.box([0, 1.04, BAR_Z - 0.11], [0.135, 0.012, 0.095], METAL);

  // --- The mudguard over the front wheel. Small and white, as ordered.
  p.guard([0, WHEEL_R, FRONT_Z], WHEEL_R + 0.055, 0.045, 0.5, 2.2, 5, WHITE);

  // --- The kickstand, which is why a parked bike stands up rather than lying on
  // the footpath. Down and to the left, as every kickstand is.
  p.tube([-0.05, PEDAL_Y - 0.02, PEDAL_Z + 0.16], [-0.16, 0.01, PEDAL_Z + 0.26], 0.014, 0.014, 4, METAL);

  return p;
}

// --- The glow under a parked one ----------------------------------------------

/**
 * The pickup marker: a lime disc on the road under every idle bike, with a few
 * soft rays standing out of it.
 *
 * *"Lime bikes should show with a light green glow under that also rays out a
 * bit."*
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE POWERUPS' THREE PASSES, AND NOT A LIGHT.
 *
 * The header above argues that a bike must not read as a floating pickup -- it
 * is a physical object on a footpath, it is occluded by the terrace in front of
 * it, and that occlusion is what makes finding one a find. None of that changes
 * here. What the glow fixes is the *other* half of findability: a lime frame in
 * a city of brick works at 60 m in daylight and does nothing at all at dusk,
 * when the whole street goes the same blue-grey and the one bright thing in it
 * is a bus. So the marker is on the **ground**, where a real share bike's
 * puddle of light would be, it is occluded exactly as the bike is, and it makes
 * the bike findable without making it a HUD element.
 *
 * A real light was considered and is not affordable: `PointLight` is a shadow
 * decision, a clustered-lighting cost and a per-instance object, and there are
 * up to 64 of these on screen. This is one geometry, one material, one draw.
 *
 * ---------------------------------------------------------------------------
 * ADDITIVE, WHICH IS WHY IT SURVIVES BOTH ENDS OF THE DAY.
 *
 * The requirement was "a pickup marker at dusk without blowing out at noon",
 * and additive blending is the one composite that does that on its own. The
 * frame is tone-mapped at `calibration.EXPOSURE` through `NeutralToneMapping`,
 * so a sunlit footpath arrives at the blend at something like 4-5 in
 * scene-linear and a night one at a few hundredths. Adding a fixed ~0.85 of
 * green to both is a **tint** on the first -- the tone curve is compressing
 * hard up there and the disc reads as a faint green wash -- and a **glow** on
 * the second, where it is an order of magnitude above the surface it is lying
 * on. No day/night term, no uniform to keep in sync with the sky, and it cannot
 * be wrong at an hour nobody tested: the exposure does the work.
 *
 * The falloff is baked into vertex colours rather than sampled from a texture,
 * on this file's own standing argument -- black is invisible under an additive
 * blend, so a colour ramp to black *is* a soft edge, and it costs no sampler,
 * no image and no mip chain. The only animated term is one shared opacity
 * uniform.
 *
 * ---------------------------------------------------------------------------
 * DEPTH: it tests, it does not write, and it never touches the bike.
 *
 * `depthWrite` off and `transparent` on, so it is drawn in three's transparent
 * pass after every opaque surface and cannot occlude the bike standing in it,
 * the rider walking up to it, or the next bike's glow overlapping it. It still
 * depth *tests*, which is what keeps a glow inside a warehouse inside the
 * warehouse.
 *
 * The disc floats 3 cm over the bike's own ground plane and carries the contact
 * skirt's polygon offset for the reason `world/contact.ts` sets out at length:
 * a transparent surface that loses the depth fight does not z-fight, it
 * disappears, and 3 cm quantises to under one depth step somewhere in the
 * mid-distance. The rays cannot z-fight anything, because they stand *up* out
 * of the road and are coplanar with nothing.
 */

/** Disc radius, metres. The order was about 1.6 m across. */
const GLOW_RADIUS = 0.8;
/** How high the disc floats over the road. See the header on the polygon offset. */
const GLOW_LIFT = 0.03;
/** Segments round the disc, and the number of falloff bands across it. */
const GLOW_SEGMENTS = 18;
/**
 * The falloff, as `[radius fraction, brightness]`.
 *
 * **Front-loaded, and that is a tone-mapping decision rather than a taste one.**
 * The first cut of this was a gentle ramp -- 0.78 of full brightness still at
 * 40% of the radius -- and on a night street it drew a flat saturated ellipse
 * with a hard rim, because `NeutralToneMapping` compresses the top of its range
 * hard: 0.78 and 1.0 land within a few sRGB steps of each other, so most of the
 * disc was one colour and the entire visible gradient was crammed into the last
 * 28% of the radius, which is exactly what a hard edge is.
 *
 * So the brightness is spent early, where the curve is still steep and a
 * difference is a visible difference: half gone by a fifth of the way out, a
 * quarter left at the halfway mark, and a long dim tail to the rim. The bright
 * core ends up under the bike, where it belongs -- what a player actually reads
 * is the soft ring around it.
 *
 * The last stop is exactly zero: under an additive blend that is the edge, and
 * anything above it is a circle drawn on the road.
 */
const GLOW_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.22, 0.76],
  [0.5, 0.46],
  [0.78, 0.18],
  [1, 0],
];

/** How many rays stand out of the disc. */
const RAY_COUNT = 5;
/** How tall they are, metres -- a shade over the bars, so they read against the frame. */
const RAY_HEIGHT = 1.15;
/** Where a ray's foot and its head sit, as fractions of the disc radius. */
const RAY_FOOT = 0.34;
const RAY_HEAD = 0.62;
/**
 * Half-widths at the foot and the head, metres. Tapered, so a ray ends rather
 * than stops.
 *
 * Narrow, for the disc's reason: an 11 cm blade at full brightness for most of
 * its length reads as a solid green plank standing in the road, which is what
 * the first cut of this drew at night. What "rays out a bit" wants is haze.
 */
const RAY_HALF_BASE = 0.038;
const RAY_HALF_TIP = 0.01;
/**
 * How bright a ray is at the height it is brightest, and where that is.
 *
 * A ray is at its dimmest where it leaves the road -- the disc is already
 * bright there and adding a second full-brightness surface on top of it is what
 * made the feet of the rays glare -- comes up to its peak a fifth of the way
 * along, and fades to nothing well before the tip. Three stops rather than two,
 * because a straight ramp from bright to black spends half its length in the
 * part of the tone curve where everything looks the same.
 */
const RAY_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5],
  [0.2, 1],
  [0.55, 0.34],
  [1, 0],
];

/**
 * The glow's own lime, **linear**, and brighter than `LIME`.
 *
 * A different constant from the frame's on purpose. `LIME` is a *paint*: it is
 * multiplied by whatever light is falling on it and it has to look like a
 * powder-coated tube in the sun. This is an *emission*: it is added to the
 * frame after everything else and it has to look like light, which means high
 * green, a real amount of red so it is a lime rather than a laser, and almost
 * no blue.
 */
const GLOW_LIME: Rgb = [0.3, 0.85, 0.12];
/** And the rays', dimmer, so they read as haze standing in the disc's light. */
const RAY_LIME: Rgb = [0.14, 0.4, 0.06];

/** The pulse: a mean opacity, a depth, and a rate in radians per second. */
const GLOW_MEAN = 0.82;
const GLOW_PULSE = 0.18;
const GLOW_PULSE_RATE = 1.5;
/**
 * How fast the rays turn, radians per second. Slow -- a full revolution takes
 * most of a minute, which is movement you notice out of the corner of an eye
 * and never catch spinning.
 */
const RAY_SPIN = 0.11;

/**
 * Build the disc and the rays as one geometry, in bike-local metres.
 *
 * One buffer rather than two meshes because they are drawn together, animated
 * together and never separately: a bike either has a marker or does not. The
 * disc is radially symmetric, so the slow spin the instance matrix applies for
 * the rays' sake is invisible on it, which is what lets the two share a matrix.
 */
function buildBikeGlow(): BikeParts {
  const p = new BikeParts();

  // --- The disc. A fan at the centre and a ring per band, wound
  // counter-clockwise seen from above so it faces the sky.
  for (let band = 0; band < GLOW_FALLOFF.length - 1; band++) {
    const [r0f, c0] = GLOW_FALLOFF[band];
    const [r1f, c1] = GLOW_FALLOFF[band + 1];
    const r0 = r0f * GLOW_RADIUS;
    const r1 = r1f * GLOW_RADIUS;
    const inner: Rgb = [GLOW_LIME[0] * c0, GLOW_LIME[1] * c0, GLOW_LIME[2] * c0];
    const outer: Rgb = [GLOW_LIME[0] * c1, GLOW_LIME[1] * c1, GLOW_LIME[2] * c1];
    for (let i = 0; i < GLOW_SEGMENTS; i++) {
      const a0 = (i / GLOW_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / GLOW_SEGMENTS) * Math.PI * 2;
      const base = p.position.length / 3;
      const at = (a: number, r: number, c: Rgb): void => {
        p.position.push(Math.cos(a) * r, GLOW_LIFT, Math.sin(a) * r);
        p.normal.push(0, 1, 0);
        p.colour.push(c[0], c[1], c[2]);
      };
      // **Wound with the angle running backwards**, which is what makes the
      // disc face the sky. `+Y` up over an XZ plane read with x to the right is
      // left-handed from above, so the intuitive counter-clockwise-in-increasing
      // -angle order comes out with a downward normal and the disc is invisible
      // to the only person who will ever look at it -- back-face culled from
      // above, drawn perfectly from underneath the road. `verifyBikeGlow`
      // asserts the sign rather than trusting this paragraph.
      if (r0 === 0) {
        // The centre band is a fan: one vertex at the middle, so there is no
        // degenerate zero-radius ring for the winding check to trip over.
        at(0, 0, inner);
        at(a0, r1, outer);
        at(a1, r1, outer);
        p.index.push(base, base + 2, base + 1);
        continue;
      }
      at(a0, r0, inner);
      at(a0, r1, outer);
      at(a1, r1, outer);
      at(a1, r0, inner);
      p.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  // --- The rays. Each is a tapered strip leaning outward, dim at the road,
  // brightest just above it and gone before the tip -- see `RAY_STOPS` -- and
  // each is emitted **twice with opposite winding** rather than drawn with
  // `DoubleSide`. `world/contact.ts` records what that setting costs in this
  // renderer, and `BikeParts.guard` already solves it this way for the mudguard.
  // A ray you could only see from one side of the bike would be worse than no
  // ray at all.
  for (let i = 0; i < RAY_COUNT; i++) {
    // The golden angle rather than an even spacing, so the ring does not read as
    // a rotating pentagon once the spin is on it.
    const a = (i / RAY_COUNT) * Math.PI * 2 + i * 0.39996;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Tangent, for the width of the strip.
    const tx = -sa;
    const tz = ca;
    /** One rung of the ladder at height fraction `t`: two points and a colour. */
    const rung = (t: number, brightness: number) => {
      const radius = (RAY_FOOT + (RAY_HEAD - RAY_FOOT) * t) * GLOW_RADIUS;
      const half = RAY_HALF_BASE + (RAY_HALF_TIP - RAY_HALF_BASE) * t;
      const y = GLOW_LIFT + (RAY_HEIGHT - GLOW_LIFT) * t;
      const c: Rgb = [RAY_LIME[0] * brightness, RAY_LIME[1] * brightness, RAY_LIME[2] * brightness];
      return {
        left: [ca * radius - tx * half, y, sa * radius - tz * half] as Point,
        right: [ca * radius + tx * half, y, sa * radius + tz * half] as Point,
        c,
      };
    };
    for (let s = 0; s < RAY_STOPS.length - 1; s++) {
      const lower = rung(RAY_STOPS[s][0], RAY_STOPS[s][1]);
      const upper = rung(RAY_STOPS[s + 1][0], RAY_STOPS[s + 1][1]);
      const corners: Array<[Point, Rgb]> = [
        [lower.left, lower.c],
        [lower.right, lower.c],
        [upper.right, upper.c],
        [upper.left, upper.c],
      ];
      for (const flip of [false, true]) {
        const base = p.position.length / 3;
        const order = flip ? [3, 2, 1, 0] : [0, 1, 2, 3];
        // The face normal, for the winding check. **Radial**, not tangential:
        // the quad's own cross product works out to roughly -R for the
        // unflipped order -- it faces the bike -- so the flipped copy is the one
        // a player walking past sees. Flipping it with the winding is what makes
        // the second copy a back face rather than a duplicate, and `FrontSide`
        // then draws exactly one of the two from any viewpoint, so a ray is
        // never added to the frame twice.
        const nx = (flip ? 1 : -1) * ca;
        const nz = (flip ? 1 : -1) * sa;
        for (const k of order) {
          const [pt, c] = corners[k];
          p.position.push(pt[0], pt[1], pt[2]);
          p.normal.push(nx, 0, nz);
          p.colour.push(c[0], c[1], c[2]);
        }
        p.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  return p;
}

// --- The beacon over a parked one ---------------------------------------------

/**
 * The beam: a lime shaft of light standing 72 m out of every idle bike.
 *
 * *"Make the e bikes put a green beam in the air to make them super
 * spottable."*
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SIBLING OF THE GLOW AND NOT A SECOND SYSTEM.
 *
 * The glow above solves findability *in the street you are standing in*: it is
 * a puddle of light on the road, it is occluded exactly as the bike is, and it
 * is gated at `BIKE_GLOW_RANGE` because 64 discs strewn across 400 m of city
 * would be a field of green blobs on the horizon. That gate is also its
 * limitation, and it is the one the order is about: a bike two blocks away is
 * behind a terrace, its disc is on the wrong side of the wall, and there is
 * nothing to see. A share bike you cannot find is a share bike that does not
 * exist.
 *
 * So the beam is the **long-range** half of the same signal, drawn to the
 * bike's own `BIKE_DRAW_RANGE`, and it is built from the same parts: the same
 * `BikeParts` builder, the same additive-under-a-tone-curve argument, the same
 * `FrontSide`-with-both-windings trick, one geometry, one material, one
 * `InstancedMesh` filled **from the same loop** as the bikes themselves. A bike
 * and its beam cannot disagree about who is riding, because there is no second
 * pass over the bikes in which they could.
 *
 * ---------------------------------------------------------------------------
 * THREE PLANES AT 60 DEGREES, WHICH IS WHAT MAKES IT A COLUMN.
 *
 * A billboard would be the cheap answer and it is the wrong one: a quad turned
 * to face the camera is a HUD element that happens to be in the world, it
 * shears visibly when you strafe past it, and 64 of them all turning together
 * reads as one animation. Crossed planes are a *fixed object* -- they occlude
 * and are occluded like anything else standing in the street.
 *
 * Three rather than two, because two cross at 90 degrees and go nearly edge-on
 * twice per half-turn; three at 60 degrees never leave a gap. The additive sum
 * of the projected widths runs 1.73 to 2.73 of one plane's across a full turn,
 * a 58% swing that reads as a soft flicker only if every beam in the city is at
 * the same angle -- so the instance matrix carries a per-id yaw (`BEAM_PHASE`)
 * and a street's worth of beams are all at different points of that swing. It
 * is a *fixed* offset and not a spin: the rays under the bike turn, and a
 * 72 m column that turned would be the only thing in Sydney doing it.
 *
 * The three planes all pass through the axis, so they overlap in screen space
 * along the centre line and separate toward the edges: a bright core with
 * dimmer flanks, which is what a shaft of light through air looks like and
 * which costs nothing to get because additive blending does it on its own.
 *
 * ---------------------------------------------------------------------------
 * THE GRADIENT IS FRONT-LOADED, FOR THE DISC'S REASON.
 *
 * `GLOW_FALLOFF` records what happened the first time this project ramped a
 * brightness gently under `NeutralToneMapping`: the curve compresses its top
 * hard, so 0.78 and 1.0 land within a few sRGB steps of each other and the
 * entire visible gradient crams into the last quarter -- which is a hard edge,
 * not a fade. The same trick applies here and the same way: the brightness is
 * spent early, where the curve is still steep, so two thirds of it is gone by
 * a fifth of the way up and the top half is a long dim tail. The last stop is
 * **exactly zero**, because under an additive blend that is what an end is; a
 * beam that stopped at 0.05 would be a green line ruled across the sky with a
 * visible top.
 *
 * The foot is the other half of that lesson. `RAY_STOPS` dims the rays where
 * they leave the road because the disc is already bright there and a second
 * full-brightness surface on top of it glared. The beam's foot sits at
 * `BEAM_BASE` -- inside the frame, so the light reads as coming *out of the
 * bike* -- at a third of full, and comes to its own peak about five metres up,
 * above head height. That is also what stops the column washing out the bike
 * you walked over to mount, which is the one place a player is guaranteed to
 * be standing inside it.
 *
 * ---------------------------------------------------------------------------
 * NOON AND MIDNIGHT, ON THE GLOW'S OWN ARGUMENT.
 *
 * Additive, and that is the whole day/night term. The frame is tone-mapped at
 * `calibration.EXPOSURE` = 0.62 through `NeutralToneMapping`, so a sunlit
 * sandstone wall arrives at the blend at 4-5 in scene-linear and the same wall
 * at night at a few hundredths. Adding ~2 of green at the core is a strong
 * green *shift* on the first and an order-of-magnitude *glow* on the second.
 * There is no uniform to keep in sync with the sky and no hour nobody tested.
 *
 * The two places the beam departs from the disc are both consequences of the
 * one thing additive cannot do on its own, which is beat a *bright* background.
 * Against a night street the beam is an order of magnitude over what it is
 * drawn on and any reasonable number works. Against a 3 pm sky it is a small
 * addition to something already bright, and the first cut of this -- the disc's
 * own emission over a 1.4 m column -- was a faint scratch on the sky at 60 m,
 * a beacon that worked at exactly the hours nobody needs one.
 *
 * So: it runs **hotter**, which it can afford because it is thin -- a disc
 * pushed that far is a saturated ellipse with a rim, where a 2 m column at
 * 400 m is four or five pixels and a four-pixel line going near-white-green at
 * midday is not a blown surface, it is a beacon working. And it runs
 * **narrower in hue**, at a fifth the red of the disc rather than a third,
 * because what a player picks out of a skyline is a hue shift and every unit
 * spent on red and blue pushes the result toward white -- which is what the sky
 * already is. Both were arrived at by looking, at 3 pm and at 21:30, from six
 * metres and from three hundred.
 *
 * ---------------------------------------------------------------------------
 * DEPTH: IT TESTS. THE OCCLUSION *IS* THE EFFECT.
 *
 * `depthWrite` off, `depthTest` **on**, which was the one real decision here
 * and it went the way it did after looking at both.
 *
 * Off is tempting -- it is the only way to guarantee a beam is never hidden --
 * and it is wrong three times over. It draws every beam within 400 m through
 * the terrain, so a bike behind a hill in Surry Hills paints a green column up
 * the face of the hill; it draws them through the road, so a beam below you on
 * a hill comes up through the footpath you are standing on; and 64 of them
 * composited over everything is a green haze on the whole frame rather than 64
 * findable objects. It also makes the thing a HUD element, which is precisely
 * what this file's header spends four paragraphs arguing a bike must not be.
 *
 * On, the terrace in front of the bike clips the bottom of its beam and the
 * top half stands clear over the roofline -- which is the *entire* read the
 * order asked for. A Sydney terrace is 10-20 m at the ridge and the beam is 72,
 * so better than two thirds of it is above every roofline in the inner suburbs
 * and the gradient is tuned so that the part above the roof is still around
 * half of peak. The canyon case -- a beam five metres behind a wall you are
 * standing against -- loses the column and keeps the glow, which is the right
 * division of labour between the two: at that range the disc is already on.
 * The CBD towers are the only place a beam is genuinely swallowed, and a bike
 * on the far side of the AMP tower is not one a player was going to reach.
 */

/**
 * How tall it stands, metres, measured from the road.
 *
 * 72 rather than 30 or 200. The floor is the roofline it has to clear plus the
 * distance it has to clear it *by*: a terrace ridge is 10-20 m, and a column
 * that ended at 25 would be a stub peeking over a roof at close range and
 * hidden behind the next street's roof at 300 m, because the sight line drops
 * as you back away. At 72 m the beam is above every inner-suburb roofline from
 * anywhere inside its own draw range. The ceiling is that this is a city with a
 * skyline in it -- past about 100 m the columns start reading as buildings, and
 * Sydney Tower is 305.
 */
const BEAM_HEIGHT = 72;
/**
 * Where the foot sits, metres. On the downtube, not on the road.
 *
 * The light comes out of the bike rather than out of the pavement beside it,
 * which is the difference between a beacon attached to an object and a marker
 * dropped near one. It also keeps the beam's own base clear of the glow disc
 * lying at 3 cm, so the two do not stack into a glare at the one place a player
 * stands closest.
 */
const BEAM_BASE = 0.55;
/**
 * Half-widths at the foot and the tip, metres. A slight taper, not a cone.
 *
 * 2.2 m across at the base, and the width is a *daylight* number rather than a
 * look. Against a night street the beam is an order of magnitude over its
 * background and a hand's width of it would do; against a 3 pm sky it is a hue
 * shift on something already bright, and a hue shift is only as findable as it
 * is large. The first cut of this was 1.4 m and it read as a faint scratch on
 * the sky at 60 m, which is a beacon that works at exactly the hours you do not
 * need one.
 *
 * The upper bound is that it must still read as a beam standing in a parking
 * spot rather than a searchlight: at 2.2 m over 72 m the column is a 33:1
 * spike, which is unmistakably a line and not a wall. The taper takes it to
 * 1.1 m at the tip -- at 400 m the 1.9 m it leaves at a roofline is about five
 * pixels of a 1080-line frame, and five pixels is a line you can pick out of a
 * skyline.
 */
const BEAM_HALF_BASE = 1.1;
const BEAM_HALF_TIP = 0.5;
/** How many planes cross through the axis. Three, at 60 degrees. See the header. */
const BEAM_PLANES = 3;
/**
 * The gradient, as `[height fraction, brightness]`. See the header for both
 * ends of it: the dim foot is `RAY_STOPS`' lesson and the front-loading is
 * `GLOW_FALLOFF`'s.
 *
 * **Both ends reach exactly zero**, and the bottom one is not symmetry for its
 * own sake. A plane's foot is a straight cut across the geometry, and at a
 * brightness above zero that cut is a visible hard edge -- standing six metres
 * off a bike you could read the three rectangles the column is made of, sliced
 * flat where they meet the road, which is the one distance at which a beacon
 * has to look least like three rectangles. Ramping from nothing over the first
 * metre puts the edge where an additive blend cannot show it, and what a player
 * sees instead is light welling up out of the frame. It costs one stop.
 *
 * The stop at 0.2 is the load-bearing one. 0.2 of the span is 15 m, which is a
 * terrace ridge, and 0.78 is what the beam is still worth where it clears one.
 * Everything above that is the part seen from three blocks away.
 *
 * The middle of the curve is deliberately fuller than the disc's equivalent,
 * and it is the one place this departs from `GLOW_FALLOFF`. The disc's job is
 * to have a soft edge, so it spends everything early and tails off. The beam's
 * gradient runs the *wrong way against its own backgrounds* -- the bottom is
 * seen against brick and road, where anything reads, and the top against the
 * sky, which is the brightest thing in the frame and where a fade to nothing
 * costs the most. It still has to be brightest at the base or it is a floating
 * bar rather than a beam, so the answer is not to move the peak but to make the
 * descent from it gentle through the 15-40 m band, which is precisely the band
 * that is over the rooftops and against sky from three streets away.
 */
const BEAM_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.014, 0.34],
  [0.06, 1],
  [0.2, 0.78],
  [0.44, 0.5],
  [0.74, 0.22],
  [1, 0],
];
/**
 * The beam's lime, **linear**, and half again over the disc's emission.
 *
 * A separate constant from `GLOW_LIME` and a hotter one, because the two are
 * capped by different things. The disc is a square metre of road: pushed past
 * about 1.3 it stops being light on a surface and becomes a saturated ellipse
 * with a rim. The beam is a 2 m column seen at up to 400 m, and what caps it is
 * `NeutralToneMapping`'s **desaturation shoulder** -- the curve rolls high
 * values toward white, so past roughly 3 in scene-linear the core of the column
 * stops being lime and starts being a white stripe with green edges, which is
 * less findable than the dimmer version because white is what the sky already
 * is. 1.13 of green per plane against three overlapping planes and a 0.78 mean
 * opacity puts the core at 2.6, which is under that shoulder with room to
 * spare and about twice what the first cut drew.
 *
 * The **ratio** is where this last differs from the disc, and it is the other
 * half of the daylight problem. Against a night street any additive colour
 * reads, because the background is nearly zero and the beam simply *is* the
 * colour. Against a 3 pm sky the beam is a small addition to something already
 * bright in every channel, and what a player picks out of a skyline is a hue
 * shift rather than a brightness one -- so every unit spent on red and blue is
 * a unit spent pushing the result toward white, which is what the sky already
 * is. Red at 0.21 of green rather than the disc's 0.35: still visibly a
 * yellow-green rather than a laser at night, and a materially stronger shift
 * per unit of luminance in the one condition that was hard.
 *
 * Converted, never pasted, for the reason `LIME`'s own comment gives at length.
 */
const BEAM_LIME: Rgb = [0.24, 1.13, 0.09];
/**
 * The pulse: a mean and a depth, breathing on the **glow's own rate**.
 *
 * One clock, and that is the point of reusing `GLOW_PULSE_RATE` rather than
 * picking a second number. Both nodes are built from the shared `time` uniform
 * at the same rate, so the disc under a bike and the column over it swell and
 * fade together; two rates a few percent apart would beat against each other on
 * a period of a minute and read as a fault in the renderer.
 *
 * Shallower than the disc's, because the swing is multiplied by however many
 * planes overlap at a given pixel and a 0.18 depth at the core is a 0.5 swing.
 */
const BEAM_MEAN = 0.78;
const BEAM_PULSE = 0.11;
/**
 * How far each bike's beam is turned from the last, radians per id.
 *
 * Fixed, not animated. The three planes give an azimuthal brightness swing with
 * a 60-degree period; 0.61 rad is a little over a third of that, so
 * consecutive ids sit at different points of the swing and a street of beams
 * never dims in unison. A shared angle would make a row of them one object.
 */
const BEAM_PHASE = 0.61;

/**
 * Build the beam as one geometry, in bike-local metres.
 *
 * Each plane is emitted **twice with opposite winding** rather than drawn with
 * `DoubleSide`, exactly as the rays and the mudguard are: `world/contact.ts`
 * records what a two-pass transparent material costs in this renderer, and
 * `FrontSide` over a mirrored pair draws exactly one of the two from any
 * viewpoint, so a plane is never added to the frame twice.
 */
function buildBikeBeam(): BikeParts {
  const p = new BikeParts();
  const span = BEAM_HEIGHT - BEAM_BASE;

  for (let i = 0; i < BEAM_PLANES; i++) {
    // Over a half-turn, not a full one: a plane at 180 degrees is the same
    // plane as one at 0. Three of them is one every 60.
    const a = (i / BEAM_PLANES) * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // The plane's own normal: horizontal, perpendicular to the vertical sheet
    // it lies in. Carried for `verifyBikeGlow` and read by nothing else -- an
    // unlit material never looks at a normal, and the check has to be able to
    // ask whether a face agrees with the side it was built to be.
    const nx = -sa;
    const nz = ca;
    /** One rung of the ladder at height fraction `t`: two points and a colour. */
    const rung = (t: number, brightness: number) => {
      const half = BEAM_HALF_BASE + (BEAM_HALF_TIP - BEAM_HALF_BASE) * t;
      const y = BEAM_BASE + span * t;
      const c: Rgb = [BEAM_LIME[0] * brightness, BEAM_LIME[1] * brightness, BEAM_LIME[2] * brightness];
      return { left: [-ca * half, y, -sa * half] as Point, right: [ca * half, y, sa * half] as Point, c };
    };
    for (let s = 0; s < BEAM_STOPS.length - 1; s++) {
      const lower = rung(BEAM_STOPS[s][0], BEAM_STOPS[s][1]);
      const upper = rung(BEAM_STOPS[s + 1][0], BEAM_STOPS[s + 1][1]);
      const corners: Array<[Point, Rgb]> = [
        [lower.left, lower.c],
        [lower.right, lower.c],
        [upper.right, upper.c],
        [upper.left, upper.c],
      ];
      for (const flip of [false, true]) {
        const base = p.position.length / 3;
        const order = flip ? [3, 2, 1, 0] : [0, 1, 2, 3];
        // The cross product of the unflipped order works out to exactly
        // `(-sin a, 0, cos a)` -- the sheet's own perpendicular -- and the
        // reversed order to its negative. Flipping the normal *with* the
        // winding is what makes the second copy a back face rather than a
        // duplicate of the first.
        const sign = flip ? -1 : 1;
        for (const k of order) {
          const [pt, c] = corners[k];
          p.position.push(pt[0], pt[1], pt[2]);
          p.normal.push(nx * sign, 0, nz * sign);
          p.colour.push(c[0], c[1], c[2]);
        }
        p.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  return p;
}

// --- Assets -------------------------------------------------------------------

/**
 * The one geometry and the one material every bike in the city shares.
 *
 * Built once at boot beside the character and bat assets so the shader warm-up
 * can reach the material -- see `main.ts`, where the same argument is made about
 * every other procedural mesh in this client.
 */
export class BikeAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;
  readonly bounds: Sphere;
  /** The marker under a parked one: one geometry, shared by every bike. */
  readonly glowGeometry: BufferGeometry;
  /**
   * And **one** material for all of them.
   *
   * Stated as an invariant rather than as an implementation detail, because it
   * is the thing this project has been burned by: a marker built per bike would
   * be 115 `MeshBasicNodeMaterial`s, 115 pipeline compilations at whatever
   * moment the player first rounds a corner onto a street with bikes in it, and
   * a frame-time cliff nobody can attribute afterwards. `verifyBikeGlow`
   * asserts that two `BikeAssets` hand out geometry of the same shape and that
   * `BikeMeshes` draws the lot in one call.
   */
  readonly glowMaterial: MeshBasicNodeMaterial;
  readonly glowTriangles: number;
  /** The beacon over a parked one: one geometry and **one** material, as above. */
  readonly beamGeometry: BufferGeometry;
  readonly beamMaterial: MeshBasicNodeMaterial;
  readonly beamTriangles: number;

  constructor() {
    const parts = buildBike();
    const count = parts.position.length / 3;

    const geometry = new BufferGeometry();
    geometry.name = 'lime-bike';
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(parts.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(parts.normal), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(parts.colour), 3));
    geometry.setIndex(parts.index);
    geometry.computeBoundingSphere();
    // A bike is rigid, so its own computed sphere is exact -- unlike the
    // character's, which has to be inflated because the mesh deforms.
    this.bounds = geometry.boundingSphere ?? new Sphere(new Vector3(0, 0.6, 0), 1.2);
    this.geometry = geometry;
    this.triangles = parts.index.length / 3;
    this.vertices = count;

    const material = new MeshStandardNodeMaterial();
    material.name = 'lime-bike';
    // No `colorNode`, exactly as the character has none: `NodeMaterial` already
    // multiplies the material colour by the geometry's `color` attribute.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Painted steel and rubber. Rougher than the bat, nowhere near foliage: a
    // powder-coated frame in the sun has a definite sheen and it is most of what
    // makes the green read as paint rather than as a flat fill.
    material.roughness = 0.55;
    material.metalness = 0.05;
    // Faceted, like every other procedural mesh here. The build is indexed and
    // the faceting comes from the material, which is what keeps the vertex count
    // at a third of a non-indexed build for the same look.
    material.flatShading = true;
    this.material = material;

    // --- The glow. See `buildBikeGlow`'s header for every decision below.
    const glowParts = buildBikeGlow();
    const glowGeometry = new BufferGeometry();
    glowGeometry.name = 'lime-bike:glow';
    glowGeometry.setAttribute('position', new BufferAttribute(new Float32Array(glowParts.position), 3));
    glowGeometry.setAttribute('color', new BufferAttribute(new Float32Array(glowParts.colour), 3));
    // The normals are carried for `verifyBikeGlow` and for nothing else: an
    // unlit material never reads them, and the check has to be able to ask
    // whether a face agrees with the side it was built to be.
    glowGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(glowParts.normal), 3));
    glowGeometry.setIndex(glowParts.index);
    glowGeometry.computeBoundingSphere();
    this.glowGeometry = glowGeometry;
    this.glowTriangles = glowParts.index.length / 3;

    const glow = new MeshBasicNodeMaterial();
    glow.name = 'lime-bike:glow';
    // Unlit. A marker's readability must not depend on whether the terrace
    // beside it is between it and the sun -- which is exactly where a player
    // most needs to find a bike. `world/powerups.ts` makes the identical call.
    glow.vertexColors = true;
    glow.color = new Color(1, 1, 1);
    glow.transparent = true;
    glow.blending = AdditiveBlending;
    // Tests, never writes. See the header: writing would let one bike's disc
    // occlude the next one's where two overlap on a corner, and would put a
    // hard-edged hole in the frame where the rays cross the frame's own tubes.
    glow.depthWrite = false;
    // One winding is drawn from any given side, because the geometry carries
    // both. `DoubleSide` on a transparent material is two passes in this
    // renderer -- `world/contact.ts` measures what that costs.
    glow.side = FrontSide;
    // The pulse. **One shared uniform for every bike in the city**, evaluated in
    // the shader from `time`, so a slow breath across 64 instances costs one
    // sine per fragment and nothing per frame on the CPU. Opacity rather than
    // colour, because `NodeMaterial` folds opacity into the alpha the blend
    // uses and an additive blend scales by exactly that.
    glow.opacityNode = float(GLOW_MEAN).add(sin(time.mul(GLOW_PULSE_RATE)).mul(GLOW_PULSE));
    // The disc lies 3 cm over the road and has to keep winning the depth test at
    // range. `world/contact.ts` works out why a metric lift is not enough and
    // why this is -8: a transparent surface that loses simply disappears.
    glow.polygonOffset = true;
    glow.polygonOffsetUnits = -8;
    glow.polygonOffsetFactor = 0;
    this.glowMaterial = glow;

    // --- The beam. See `buildBikeBeam`'s header for every decision below.
    const beamParts = buildBikeBeam();
    const beamGeometry = new BufferGeometry();
    beamGeometry.name = 'lime-bike:beam';
    beamGeometry.setAttribute('position', new BufferAttribute(new Float32Array(beamParts.position), 3));
    beamGeometry.setAttribute('color', new BufferAttribute(new Float32Array(beamParts.colour), 3));
    // Carried for `verifyBikeGlow` and for nothing else, exactly as the glow's
    // are: an unlit material never reads a normal.
    beamGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(beamParts.normal), 3));
    beamGeometry.setIndex(beamParts.index);
    beamGeometry.computeBoundingSphere();
    this.beamGeometry = beamGeometry;
    this.beamTriangles = beamParts.index.length / 3;

    const beam = new MeshBasicNodeMaterial();
    beam.name = 'lime-bike:beam';
    beam.vertexColors = true;
    beam.color = new Color(1, 1, 1);
    beam.transparent = true;
    beam.blending = AdditiveBlending;
    // Never writes: a column of light must not punch a hole through the bike it
    // stands in, through the next beam behind it, or through the rider walking
    // up to mount.
    beam.depthWrite = false;
    // **And it does test.** This is the decision the header argues at length --
    // the terrace clipping the bottom of the beam is what leaves the top half
    // standing over the roofline, which is the effect the order asked for, and
    // it is also the only thing keeping 64 columns from being drawn through the
    // terrain as a green haze over the whole frame. Stated rather than left at
    // the default, because `verifyBikeGlow` asserts it and a future hand
    // reaching for `depthTest = false` to "fix" a beam behind a wall should
    // find a sentence here first.
    beam.depthTest = true;
    // One winding drawn from any side, because the geometry carries both.
    beam.side = FrontSide;
    // The pulse, on the glow's own rate and off the same shared `time` uniform:
    // one clock, so the disc under the bike and the column over it breathe
    // together. See `BEAM_MEAN`.
    beam.opacityNode = float(BEAM_MEAN).add(sin(time.mul(GLOW_PULSE_RATE)).mul(BEAM_PULSE));
    // No polygon offset, unlike the disc's. That exists because a surface lying
    // *on* the road loses the depth fight and vanishes; a vertical sheet is
    // coplanar with nothing and biasing it toward the camera would only let it
    // creep through the wall in front of it.
    this.beamMaterial = beam;
  }
}

// --- Drawing them -------------------------------------------------------------

/**
 * How far away a bike is still drawn, metres.
 *
 * Generous, because the whole design of a rare pickup is that you can spot one
 * from a distance and go to it -- a bike that faded in at 60 m would be a bike
 * you could only find by walking past it. 400 m is inside `main.ts`'s own
 * collision radius, so any bike drawn is one on ground the client has loaded.
 */
export const BIKE_DRAW_RANGE = 400;

/**
 * Every bike near the camera, in one draw call.
 *
 * The capacity is fixed and the count moves, which is `InstancedMesh`'s own
 * contract: `count` is what is drawn and the buffer is what is allocated. 64 is
 * about four times the most that can be inside `BIKE_DRAW_RANGE` at the inner
 * ring's density, and it costs 4 kB of matrix buffer -- cheaper than being
 * wrong.
 */
const CAPACITY = 64;

/**
 * How far away the **marker** is drawn, metres.
 *
 * Much shorter than the bike itself, and that is a decision rather than a
 * saving. A glow is a "there is one here" and it belongs at the range a player
 * could act on it; 64 discs strewn across 400 m of city would be a field of
 * green blobs on the horizon, which is the floating-UI failure this whole file
 * is written against. At 120 m a marker is one street away.
 */
export const BIKE_GLOW_RANGE = 120;

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _lean = /*#__PURE__*/ new Quaternion();
const _one = /*#__PURE__*/ new Vector3(1, 1, 1);
const _axis = /*#__PURE__*/ new Vector3(0, 1, 0);
/** The roll axis: the bike's own forward, which is -Z. See `BIKE_LEAN`. */
const _roll = /*#__PURE__*/ new Vector3(0, 0, -1);

export class BikeMeshes {
  readonly mesh: InstancedMesh;
  /**
   * The markers, in a second draw call over the same instance loop.
   *
   * Separate from `mesh` because the two need different materials -- one lit and
   * opaque, one unlit and additive -- and three binds a material per draw. They
   * are filled from the same pass over the same bikes, so a bike is either in
   * both or in neither and the two can never disagree about who is riding.
   *
   * `main.ts` adds it to the scene; this class never touches the graph.
   */
  readonly glow: InstancedMesh;
  /**
   * The beacons, in a third draw over the same instance loop.
   *
   * Its own mesh for the glow's reason -- a different material, and three binds
   * one per draw -- and filled on the **same row** as the bike itself rather
   * than on a counter of its own. That is not a saving, it is the invariant:
   * every bike this class draws has a beam and nothing else does, so "the beam
   * over a bike somebody is riding away" is not a bug that can be introduced
   * here without deleting a line that says `row`.
   */
  readonly beam: InstancedMesh;
  /** How many were drawn last update. Reported on the debug overlay. */
  drawn = 0;
  /** And how many markers, which is the shorter range. */
  glowDrawn = 0;
  /** And how many beams, which is always exactly `drawn`. See `beam`. */
  beamDrawn = 0;

  constructor(assets: BikeAssets) {
    const mesh = new InstancedMesh(assets.geometry, assets.material, CAPACITY);
    mesh.name = 'lime-bikes';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Culled per instance would be right and three does not do it; culled as a
    // whole is wrong, because the set spans the city and its bounding sphere is
    // always on screen. So the range test in `update` is the culling, and this
    // is off so a bike behind the camera is not also rejected by a sphere that
    // covers everything.
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.mesh = mesh;

    const glow = new InstancedMesh(assets.glowGeometry, assets.glowMaterial, CAPACITY);
    glow.name = 'lime-bikes:glow';
    // **Neither**, and both matter. Casting would put a black disc-shaped
    // shadow on the road under every bike, which is the exact inverse of a
    // glow; receiving would let the building opposite darken the light the
    // marker is supposed to be emitting.
    glow.castShadow = false;
    glow.receiveShadow = false;
    glow.frustumCulled = false;
    glow.count = 0;
    // After the opaque pass by virtue of being transparent, and after the other
    // transparents by virtue of this. The contact skirt is an alpha-blended
    // ribbon lying on the same road; sorted by distance the two trade places as
    // the player walks, and a skirt drawn over the marker darkens it. Additive
    // last is order-independent against everything.
    glow.renderOrder = 2;
    this.glow = glow;

    const beam = new InstancedMesh(assets.beamGeometry, assets.beamMaterial, CAPACITY);
    beam.name = 'lime-bikes:beam';
    // Neither, on the glow's argument doubled: a 72 m column casting into the
    // sun's depth pass would lay a green-black stripe across half a suburb, and
    // one receiving shadow would go out every time a cloud shadow crossed it.
    beam.castShadow = false;
    beam.receiveShadow = false;
    // The set spans the city, so its bounding sphere is always on screen and
    // culling it as a whole is meaningless. The range test in `update` is the
    // culling. See `mesh` above.
    beam.frustumCulled = false;
    beam.count = 0;
    // With the glow, after every other transparent. Additive is
    // order-independent, so the two need no order between themselves -- what
    // this buys is being drawn after the contact skirt, which is alpha-blended
    // and would otherwise darken whichever of them sorted behind it.
    beam.renderOrder = 2;
    this.beam = beam;
  }

  /**
   * Place every bike within range, and hide the rest.
   *
   * **A ridden bike is skipped**, and that is the one rule here. While somebody
   * is on it, the bike is drawn at its rider -- which this class does not do,
   * because `main.ts` already has the rider's interpolated position and this
   * only has the snapshot's. Drawing it here as well would be two bikes 100 ms
   * apart, which is the same argument `net/client.ts` makes about not drawing
   * the authoritative copy of your own football.
   *
   * The same skip is what makes the marker disappear the instant somebody gets
   * on and come back where they drop it: there is no state and no fade, only
   * the same test asked once per frame. A glow under a bike that is being
   * ridden away would be a puddle of light left on an empty footpath.
   *
   * `seconds` drives the rays' slow rotation and defaults to the wall clock, so
   * the ordinary call site passes four arguments exactly as it did before.
   */
  update(
    bikes: readonly Bike[],
    cameraX: number,
    cameraZ: number,
    ridden: (id: number) => boolean,
    seconds: number = performance.now() * 0.001,
  ): void {
    let row = 0;
    let glowRow = 0;
    const range2 = BIKE_DRAW_RANGE * BIKE_DRAW_RANGE;
    const glowRange2 = BIKE_GLOW_RANGE * BIKE_GLOW_RANGE;
    for (const bike of bikes) {
      if (row >= CAPACITY) break;
      if (bike.rider !== 0 || ridden(bike.id)) continue;
      const dx = bike.x - cameraX;
      const dz = bike.z - cameraZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > range2) continue;
      _position.set(bike.x, bike.y, bike.z);
      _quaternion.setFromAxisAngle(_axis, bike.yaw);
      _matrix.compose(_position, _quaternion, _one);
      this.mesh.setMatrixAt(row, _matrix);
      // The beacon, on the bike's own row and inside the bike's own gate, so
      // the two counts are the same number by construction rather than by two
      // tests that agree today. Turned by a fixed per-id angle -- see
      // `BEAM_PHASE`: the three planes have an azimuthal brightness swing and a
      // street of beams all at the same angle would dim in unison.
      _quaternion.setFromAxisAngle(_axis, bike.id * BEAM_PHASE);
      _matrix.compose(_position, _quaternion, _one);
      this.beam.setMatrixAt(row, _matrix);
      row++;

      if (d2 > glowRange2) continue;
      // The rays turn, slowly, and **out of phase per bike**: a shared angle
      // would have every marker in the street rotating in lockstep, which reads
      // as one animation rather than as a lot of objects. The id is the phase,
      // so a given bike's marker is at the same angle in every client.
      _quaternion.setFromAxisAngle(_axis, seconds * RAY_SPIN + bike.id * 0.7);
      _matrix.compose(_position, _quaternion, _one);
      this.glow.setMatrixAt(glowRow, _matrix);
      glowRow++;
    }
    this.mesh.count = row;
    this.drawn = row;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glow.count = glowRow;
    this.glowDrawn = glowRow;
    this.glow.instanceMatrix.needsUpdate = true;
    this.beam.count = row;
    this.beamDrawn = row;
    this.beam.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.glow.removeFromParent();
    this.glow.dispose();
    this.beam.removeFromParent();
    this.beam.dispose();
  }
}

/**
 * One bike attached to a rider, drawn at their interpolated position.
 *
 * A plain `InstancedMesh` of one rather than a `Mesh`, purely so it shares the
 * instanced pipeline variant the field above already compiled -- a second
 * non-instanced draw of the same geometry would compile a second shader the
 * first time anybody mounted anything.
 */
export class RiddenBike {
  readonly mesh: InstancedMesh;

  constructor(assets: BikeAssets) {
    const mesh = new InstancedMesh(assets.geometry, assets.material, 1);
    mesh.name = 'lime-bike:ridden';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.mesh = mesh;
  }

  /**
   * Put it under a rider whose **feet** are at `(x, y, z)`, facing `yaw`, leaned
   * `lean` radians into the turn -- positive to the rider's right.
   *
   * The roll is composed *after* the yaw, so it happens in the bike's own frame
   * and about its own forward axis: `q = yaw x roll`, which pivots the bike
   * around the line through both tyre contact patches. Composing the other way
   * would roll it about the world's -Z and lift a bike facing east clean off
   * the road.
   *
   * `lean` defaults to zero, so a remote rider -- whose steering this client
   * cannot see, since the wire carries a yaw and not a yaw *rate* -- is drawn
   * upright rather than guessed at.
   */
  set(x: number, y: number, z: number, yaw: number, lean = 0): void {
    _position.set(x, y, z);
    _quaternion.setFromAxisAngle(_axis, yaw);
    if (lean !== 0) {
      _lean.setFromAxisAngle(_roll, lean);
      _quaternion.multiply(_lean);
    }
    _matrix.compose(_position, _quaternion, _one);
    this.mesh.setMatrixAt(0, _matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 1;
  }

  hide(): void {
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

// --- The tuning stall ---------------------------------------------------------

/**
 * The thing in Redfern you ride to, built as a small stall rather than a marker.
 *
 * Diegetic, on the brief's terms and on the same instinct `world/powerups.ts`
 * has about its icons: this world has no floating UI in it, and a waypoint arrow
 * over Redfern Street would be the first. What it is instead is a bike-repair
 * stall -- a bench under a lime awning with a workstand and a wheel leaning
 * against it -- which is a thing that exists on Australian high streets and which
 * says what it does by being the same green as the bikes.
 *
 * It is one small `Object3D` of static meshes at a fixed point, so it costs a
 * handful of draw calls and no per-frame work at all. `game/bikes.TUNING_X/Z` is
 * the authority on where it is; this is handed the ground height, because only
 * the caller has streamed the terrain.
 */
export function buildTuningStall(assets: BikeAssets, groundY: number): Object3D {
  const p = new BikeParts();
  const R = TUNING_RADIUS;

  // --- The bench, and the two trestles under it.
  p.box([0, 0.9, 0], [0.9, 0.045, 0.34], LIME);
  for (const side of [-1, 1]) {
    p.tube([side * 0.75, 0, -0.24], [side * 0.72, 0.86, -0.22], 0.035, 0.03, 5, METAL);
    p.tube([side * 0.75, 0, 0.24], [side * 0.72, 0.86, 0.22], 0.035, 0.03, 5, METAL);
  }

  // --- The awning: four posts and a flat lime canopy, so the stall has a
  // silhouette from a distance rather than only from ten metres.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
    p.tube([sx * 1.05, 0, sz * 0.6], [sx * 1.05, 2.2, sz * 0.6], 0.04, 0.035, 5, METAL);
  }
  p.box([0, 2.26, 0], [1.15, 0.05, 0.72], LIME);
  // A white valance along the front edge, which is what a market awning has and
  // what stops the canopy reading as a slab.
  p.box([0, 2.16, -0.72], [1.15, 0.07, 0.02], WHITE);

  // --- The workstand: a post with a clamp, and a wheel leaning on the bench
  // leg. Both are there to say "bikes" without a sign.
  p.tube([0.62, 0.9, 0.1], [0.62, 1.65, 0.1], 0.035, 0.03, 5, METAL);
  p.box([0.62, 1.68, 0.1], [0.05, 0.05, 0.14], DARK);
  p.wheel([-0.95, WHEEL_R + 0.02, 0.42], WHEEL_R - 0.04, 0.04, TYRE);
  p.tube([-1.0, WHEEL_R + 0.02, 0.42], [-0.9, WHEEL_R + 0.02, 0.42], 0.035, 0.035, 6, METAL);

  // --- A painted ring on the pavement, the width of the zone. Flat, a
  // centimetre proud of the paving so it does not z-fight, and the one part of
  // this that is a *game* object rather than a piece of street furniture: it is
  // how a player knows where to stand, and it is drawn as road marking because
  // that is what road marking is for.
  for (let i = 0; i < 24; i++) {
    const a0 = (i / 24) * Math.PI * 2;
    const a1 = ((i + 0.55) / 24) * Math.PI * 2;
    for (const [inner, outer] of [[R - 0.16, R]] as Array<[number, number]>) {
      const base = p.position.length / 3;
      for (const [a, r] of [[a0, inner], [a0, outer], [a1, outer], [a1, inner]] as Array<[number, number]>) {
        p.position.push(Math.cos(a) * r, 0.012, Math.sin(a) * r);
        p.normal.push(0, 1, 0);
        p.colour.push(LIME[0], LIME[1], LIME[2]);
      }
      p.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.name = 'tuning-stall';
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.position), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(p.normal), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(p.colour), 3));
  geometry.setIndex(p.index);
  geometry.computeBoundingSphere();

  const group = new Object3D();
  group.name = 'tuning-stall';
  const mesh = new InstancedMesh(geometry, assets.material, 1);
  mesh.name = 'tuning-stall:mesh';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  _matrix.compose(_position.set(0, 0, 0), _quaternion.identity(), _one);
  mesh.setMatrixAt(0, _matrix);
  mesh.count = 1;
  group.add(mesh);
  group.position.set(TUNING_X, groundY, TUNING_Z);
  // Square to the street. Redfern Street runs roughly east-west here, so the
  // stall faces the footpath rather than the traffic.
  group.rotation.y = Math.PI / 2;
  return group;
}

// --- The self-check -----------------------------------------------------------

/**
 * The bike's geometry, asserted.
 *
 * Every failure here is silent in this project's sense -- it renders, it does not
 * throw, and it reads as a modelling decision:
 *
 *   - **Winding.** A tube wound against its own normals is back-face culled, so
 *     the frame is see-through from one side and solid from the other. This is
 *     the exact failure the README's winding pass documents on the city's walls,
 *     and it is invisible until somebody walks round the bike.
 *   - **A bike that does not fit its rider.** The saddle, bars and cranks are
 *     drawn to `player/animation.ts`'s constants, and the rider is posed to the
 *     same ones. If the geometry drifts off them, the figure floats over the
 *     seat with its hands in the air -- which reads as a rigging bug and is
 *     really two files disagreeing. `verifyCharacterRig` asserts the other half
 *     of the same contract.
 *   - **A bike underground, or one the size of a tram.** The origin convention
 *     is "on the ground under the rider", and getting it wrong by the wheel
 *     radius buries every bike in the city to its axles.
 */
export function verifyBikeMesh(): string[] {
  const failures: string[] = [];
  const assets = new BikeAssets();

  if (assets.triangles > 700) {
    failures.push(`The bike is ${assets.triangles} triangles; the budget for a street prop is about 600.`);
  }
  if (assets.triangles < 150) {
    failures.push(`The bike is only ${assets.triangles} triangles, which is not a bike.`);
  }

  const position = assets.geometry.getAttribute('position');
  const normal = assets.geometry.getAttribute('normal');
  const colour = assets.geometry.getAttribute('color');
  const index = assets.geometry.getIndex();
  if (index === null) {
    failures.push('The bike geometry is not indexed.');
    return failures;
  }
  if (colour.count !== position.count) {
    failures.push(`The bike has ${colour.count} colours against ${position.count} positions.`);
  }

  // --- Winding, exactly as `verifyCharacterRig` tests it: a face's cross
  // product must agree with the mean of its three vertex normals.
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
      `${disagreeing} of ${index.count / 3} bike triangles are wound against their own normals -- ` +
        `they will be back-face culled and the frame will be see-through from one side.`,
    );
  }

  // --- Extents. The origin is the ground under the rider.
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < position.count; i++) {
    minY = Math.min(minY, position.getY(i));
    maxY = Math.max(maxY, position.getY(i));
    minZ = Math.min(minZ, position.getZ(i));
    maxZ = Math.max(maxZ, position.getZ(i));
    maxX = Math.max(maxX, Math.abs(position.getX(i)));
  }
  if (minY < -0.02) {
    failures.push(`The bike reaches ${minY.toFixed(3)} m, which is under the pavement it is parked on.`);
  }
  if (maxY > 1.35 || maxY < 0.9) {
    failures.push(`The bike is ${maxY.toFixed(2)} m tall at the bars; a share bike is about 1.1.`);
  }
  const wheelbase = maxZ - minZ;
  if (wheelbase < 1.0 || wheelbase > 2.0) {
    failures.push(`The bike is ${wheelbase.toFixed(2)} m long; a bicycle is about 1.7 including the wheels.`);
  }
  if (maxX > 0.5) {
    failures.push(`The bike is ${(maxX * 2).toFixed(2)} m wide, which is a car.`);
  }

  // --- It fits the rider `player/animation.ts` poses. Sampled as "is there
  // geometry near where the constant says the part is", which is the weakest
  // claim that still catches a saddle drawn 20 cm from the hips.
  const near = (x: number, y: number, z: number, radius: number): boolean => {
    for (let i = 0; i < position.count; i++) {
      const dx = position.getX(i) - x;
      const dy = position.getY(i) - y;
      const dz = position.getZ(i) - z;
      if (dx * dx + dy * dy + dz * dz < radius * radius) return true;
    }
    return false;
  };
  if (!near(0, SADDLE_Y, SADDLE_Z, 0.16)) {
    failures.push(`There is no saddle within 16 cm of (0, ${SADDLE_Y}, ${SADDLE_Z}), where the rider's hips are.`);
  }
  for (const side of [-1, 1]) {
    if (!near(side * BAR_HALF_WIDTH, BAR_Y, BAR_Z, 0.14)) {
      failures.push(
        `There is no handlebar grip within 14 cm of (${(side * BAR_HALF_WIDTH).toFixed(2)}, ${BAR_Y}, ${BAR_Z}), ` +
          `where the rider's mitt is. The bike and the pose have drifted apart.`,
      );
    }
  }
  if (!near(0, PEDAL_Y, PEDAL_Z, 0.2)) {
    failures.push(`There is no bottom bracket within 20 cm of (0, ${PEDAL_Y}, ${PEDAL_Z}), where the rider's feet are.`);
  }

  // --- The colour really is a lime green: green dominant, red present, blue
  // almost gone. A frame that came out grey means somebody dropped an sRGB
  // triple into this linear pipeline, which is the failure this palette's
  // comment exists for and which no other check here would notice.
  let limeVerts = 0;
  for (let i = 0; i < colour.count; i++) {
    const r = colour.getX(i);
    const g = colour.getY(i);
    const bl = colour.getZ(i);
    if (g > 0.3 && g > r * 1.4 && g > bl * 4) limeVerts++;
  }
  if (limeVerts < position.count * 0.15) {
    failures.push(
      `Only ${limeVerts} of ${position.count} bike vertices are lime green. The frame is the whole point ` +
        `of the object being findable; check LIME has not been given an sRGB triple.`,
    );
  }

  // --- And the stall in Redfern builds, stands on the ground it is given, and
  // is big enough to be seen from the other end of the street.
  {
    const stall = buildTuningStall(assets, -31.75);
    if (Math.abs(stall.position.x - TUNING_X) > 1e-6 || Math.abs(stall.position.z - TUNING_Z) > 1e-6) {
      failures.push(`The tuning stall was built at (${stall.position.x}, ${stall.position.z}), not at the Redfern site.`);
    }
    if (Math.abs(stall.position.y - -31.75) > 1e-6) {
      failures.push(`The tuning stall ignored the ground height it was handed; it is at y ${stall.position.y}.`);
    }
    const mesh = stall.children[0] as InstancedMesh;
    const geom = mesh.geometry;
    const sphere = geom.boundingSphere;
    if (!sphere || sphere.radius < 1.5) {
      failures.push(`The tuning stall's bounding radius is ${sphere?.radius.toFixed(2)}; it is meant to be a stall, not a sign.`);
    }
    const sp = geom.getAttribute('position');
    let stallMaxY = -Infinity;
    let stallMinY = Infinity;
    let stallReach = 0;
    for (let i = 0; i < sp.count; i++) {
      stallMaxY = Math.max(stallMaxY, sp.getY(i));
      stallMinY = Math.min(stallMinY, sp.getY(i));
      stallReach = Math.max(stallReach, Math.hypot(sp.getX(i), sp.getZ(i)));
    }
    if (stallMaxY < 2 || stallMaxY > 3.2) {
      failures.push(`The stall's awning is at ${stallMaxY.toFixed(2)} m; it should be a little over head height.`);
    }
    if (stallMinY < -0.02) {
      failures.push(`The stall reaches ${stallMinY.toFixed(3)} m, below the pavement it stands on.`);
    }
    // The painted ring has to reach the edge of the zone, or a player standing
    // on the paint is outside the radius that actually unlocks anything.
    if (Math.abs(stallReach - TUNING_RADIUS) > 0.2) {
      failures.push(
        `The stall's painted ring reaches ${stallReach.toFixed(2)} m against a ${TUNING_RADIUS} m zone. ` +
          `The mark on the ground has to be the thing the zone tests, or standing on it does nothing.`,
      );
    }
  }

  return failures;
}

/**
 * The light a parked bike gives off -- the marker under it and the beam over
 * it -- asserted.
 *
 * Both, in one function, because they are one feature with one fill loop: the
 * invariant that matters most here is that a bike, its disc and its column
 * agree about who is riding, and that is a claim about the three of them
 * together which neither could make alone.
 *
 * Separate from `verifyBikeMesh` because it is a separate object with a separate
 * failure mode, and every one of them is silent in this project's sense -- the
 * frame renders, nothing throws, and the glow is simply not there or not right:
 *
 *   - **Winding.** The disc is a flat horizontal surface, and `+Y` up over an XZ
 *     plane is left-handed read from above, so the intuitive vertex order comes
 *     out facing the ground. A back-face-culled marker is drawn perfectly for
 *     anybody standing under the road and is invisible to every actual player.
 *     This is the failure the README's winding pass exists for, on the one
 *     surface where the correct answer is counter-intuitive.
 *   - **A marker that is drawn under a bike somebody is riding.** A puddle of
 *     light left on an empty footpath, or worse, one following a rider at
 *     26 m/s.
 *   - **A material per bike.** This project has died of that before. The
 *     invariant is one material and one geometry for the whole city.
 *   - **A glow that writes depth**, which punches a hole through the frame
 *     wherever a ray crosses the bike's own tubes, or **casts a shadow**, which
 *     is a black disc under a thing whose entire job is to emit light.
 *   - **A colour that is not a lime**, which is the sRGB-into-a-linear-pipeline
 *     mistake `LIME`'s comment documents, arriving a second time in a second
 *     constant.
 *
 * And the beam over it, which adds four of its own:
 *
 *   - **A gradient that does not reach zero at the top.** Under an additive
 *     blend that is not a fade, it is a green line ruled across the sky with a
 *     visible end, and it is the failure `GLOW_FALLOFF` already documents on
 *     the other axis.
 *   - **A beam that stopped being a beacon.** The whole order is "spottable
 *     from blocks away over the rooftops", and every number that delivers it --
 *     the 72 m height, the brightness still left at a terrace ridge, the width
 *     that survives 400 m -- is a constant somebody could tune to something
 *     that looks fine from ten metres and is gone from three streets away.
 *   - **`depthTest` turned off.** The tempting one-line "fix" for a beam behind
 *     a wall, which trades the whole effect for a green haze drawn through the
 *     terrain. Asserted on, so the fix has to argue with a check.
 *   - **A beam and a bike that disagree.** They are filled on the same row of
 *     the same loop; the check is that the counts come out identical through a
 *     mount, a knock-off and a drop, because a 72 m column left standing over
 *     an empty parking spot -- or worse, following a rider at 26 m/s -- is the
 *     most visible artefact this feature can produce.
 */
export function verifyBikeGlow(): string[] {
  const failures: string[] = [];
  const assets = new BikeAssets();
  const geometry = assets.glowGeometry;

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const colour = geometry.getAttribute('color');
  const index = geometry.getIndex();
  if (index === null) {
    failures.push('The bike glow geometry is not indexed.');
    return failures;
  }
  if (colour.count !== position.count) {
    failures.push(`The glow has ${colour.count} colours against ${position.count} positions.`);
  }

  // --- Budget. A marker is 64 instances of this, drawn every frame.
  if (assets.glowTriangles > 260) {
    failures.push(
      `The glow is ${assets.glowTriangles} triangles; at ${CAPACITY} instances that is ` +
        `${assets.glowTriangles * CAPACITY} for a decoration on the ground.`,
    );
  }
  if (assets.glowTriangles < 40) {
    failures.push(`The glow is only ${assets.glowTriangles} triangles, which cannot be a disc and five rays.`);
  }

  // --- Winding, exactly as `verifyBikeMesh` tests the bike's: a face's cross
  // product must agree with the mean of its three vertex normals. The disc
  // carries `+Y` normals and the rays carry radial ones, so this one test
  // covers both the "faces the sky" and the "both sides exist" claims.
  {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    const face = new Vector3();
    let disagreeing = 0;
    let upFacing = 0;
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
      if (face.y > 0.9) upFacing++;
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
        `${disagreeing} of ${index.count / 3} glow triangles are wound against their own normals. ` +
          `The disc would be back-face culled from above, which is the only direction anybody sees it from.`,
      );
    }
    // And the disc really is most of it, facing up. A count of zero is the
    // inverted-winding bug that the dot-product test above would miss if the
    // normals had been inverted to match.
    if (upFacing < GLOW_SEGMENTS) {
      failures.push(
        `Only ${upFacing} glow triangles face the sky; the disc alone is at least ${GLOW_SEGMENTS}. ` +
          `A marker on the road that faces the road is invisible.`,
      );
    }
    // The rays are emitted in mirrored pairs, so a ray seen from the wrong side
    // of the bike is still a ray. A short count means one winding was dropped.
    const rayTriangles = index.count / 3 - upFacing;
    const expected = RAY_COUNT * (RAY_STOPS.length - 1) * 4;
    if (rayTriangles !== expected) {
      failures.push(
        `There are ${rayTriangles} ray triangles against ${RAY_COUNT} rays x ${RAY_STOPS.length - 1} ` +
          `segments x 2 windings x 2 triangles = ${expected}. A ray with one winding disappears when ` +
          `you walk round the bike.`,
      );
    }
  }

  // --- Extents. It lies on the road, it is about 1.6 m across, and the rays
  // stand up rather than out.
  {
    let minY = Infinity;
    let maxY = -Infinity;
    let reach = 0;
    for (let i = 0; i < position.count; i++) {
      minY = Math.min(minY, position.getY(i));
      maxY = Math.max(maxY, position.getY(i));
      reach = Math.max(reach, Math.hypot(position.getX(i), position.getZ(i)));
    }
    if (minY < 0) {
      failures.push(`The glow reaches ${minY.toFixed(3)} m, under the road it is lying on.`);
    }
    if (minY > 0.1) {
      failures.push(`The glow floats ${minY.toFixed(3)} m over the road; it is meant to be on it.`);
    }
    if (maxY < 0.6 || maxY > 2) {
      failures.push(`The rays reach ${maxY.toFixed(2)} m; "rays out a bit" is about a bike's height, not a beacon.`);
    }
    if (Math.abs(reach - GLOW_RADIUS) > 0.02) {
      failures.push(`The glow is ${(reach * 2).toFixed(2)} m across, not the ${(GLOW_RADIUS * 2).toFixed(1)} m ordered.`);
    }
    // And it is wider than the bike is long, or the marker is hidden under the
    // thing it is marking.
    if (GLOW_RADIUS * 2 < 1.2) {
      failures.push(`A ${(GLOW_RADIUS * 2).toFixed(2)} m disc disappears under a 1.7 m bike.`);
    }
  }

  // --- The falloff really falls to black, which is what an additive edge is.
  {
    let brightest = 0;
    let darkest = Infinity;
    let lime = 0;
    for (let i = 0; i < colour.count; i++) {
      const r = colour.getX(i);
      const g = colour.getY(i);
      const bl = colour.getZ(i);
      const sum = r + g + bl;
      brightest = Math.max(brightest, sum);
      darkest = Math.min(darkest, sum);
      if (g > 0.2 && g > r * 1.4 && g > bl * 4) lime++;
    }
    if (darkest > 1e-6) {
      failures.push(
        `The dimmest glow vertex still sums to ${darkest.toFixed(3)}. Under an additive blend the falloff ` +
          `has to reach exactly zero, or the marker is a hard-edged circle painted on the road.`,
      );
    }
    if (brightest > 3) {
      failures.push(`The glow peaks at ${brightest.toFixed(2)} in linear; that will blow out at noon.`);
    }
    if (brightest < 0.4) {
      failures.push(`The glow peaks at ${brightest.toFixed(2)} in linear; it will not be visible at dusk.`);
    }
    if (lime < colour.count * 0.25) {
      failures.push(
        `Only ${lime} of ${colour.count} glow vertices are a lime green. Check GLOW_LIME has not been ` +
          `given an sRGB triple -- the frame's own LIME documents the same mistake.`,
      );
    }
  }

  // --- The material: additive, unlit, no depth write, and exactly one of it.
  {
    const m = assets.glowMaterial;
    if (m.blending !== AdditiveBlending) failures.push('The glow is not additively blended, so it is paint rather than light.');
    if (!m.transparent) failures.push('The glow is not transparent, so it is drawn in the opaque pass and never blended.');
    if (m.depthWrite) failures.push('The glow writes depth; it will punch a hole through the bike standing in it.');
    if (!m.depthTest) failures.push('The glow does not depth test; a marker inside a warehouse would be visible from the street.');
    if (m.side !== FrontSide) {
      failures.push('The glow is not FrontSide; a transparent DoubleSide material is two passes in this renderer.');
    }
    if (m.opacityNode === null) failures.push('The glow has no pulse.');

    // One material and one geometry for the whole city -- the invariant this
    // project has been burned by. Two separately-built asset sets must produce
    // geometry of identical shape, and one set must hand the same material to
    // every mesh that draws it.
    const second = new BikeAssets();
    if (second.glowTriangles !== assets.glowTriangles) {
      failures.push('Two BikeAssets built different glow geometry; the marker is not deterministic.');
    }
    const meshes = new BikeMeshes(assets);
    if (meshes.glow.material !== assets.glowMaterial) {
      failures.push('BikeMeshes built its own glow material instead of sharing the one in BikeAssets.');
    }
    if (meshes.glow.geometry !== assets.glowGeometry) {
      failures.push('BikeMeshes built its own glow geometry instead of sharing the one in BikeAssets.');
    }
    if (meshes.glow.castShadow) failures.push('The glow casts a shadow: a black disc under a thing that emits light.');
    if (meshes.glow.receiveShadow) failures.push('The glow receives shadow, so the building opposite dims the marker.');
    if (meshes.glow.count !== 0) failures.push('The glow starts with instances drawn before any bike exists.');

    // --- And it is drawn for a parked bike and not for a ridden one, which is
    // the whole of "disappears while ridden, reappears on drop".
    const bikes: Bike[] = [
      { id: 1, x: 0, y: 0, z: 0, yaw: 0, rider: 0 },
      { id: 2, x: 4, y: 0, z: 0, yaw: 0, rider: 9 },
      { id: 3, x: 8, y: 0, z: 0, yaw: 0, rider: 0 },
      // Beyond the marker's range but inside the bike's, so the two counts are
      // asserted to be different things rather than the same test twice.
      { id: 4, x: BIKE_GLOW_RANGE + 30, y: 0, z: 0, yaw: 0, rider: 0 },
      // And beyond the bike's own range, which is the beam's: a column of light
      // over a bike too far away to draw would be the one thing on screen
      // pointing at nothing.
      { id: 5, x: BIKE_DRAW_RANGE + 50, y: 0, z: 0, yaw: 0, rider: 0 },
    ];
    meshes.update(bikes, 0, 0, (id) => id === 3, 0);
    if (meshes.drawn !== 2) {
      failures.push(
        `${meshes.drawn} bikes were drawn. Only 1 and 4 qualify: 2 has a rider on the wire, 3 is ` +
          `predicted ridden locally -- and a ridden bike is drawn at its rider instead -- and 5 is ` +
          `past ${BIKE_DRAW_RANGE} m.`,
      );
    }
    if (meshes.glowDrawn !== 1) {
      failures.push(
        `${meshes.glowDrawn} markers were drawn. Only bike 1 qualifies: 2 has a rider, 3 is predicted ` +
          `ridden locally, and 4 and 5 are past ${BIKE_GLOW_RANGE} m -- which is what makes the two ` +
          `ranges a different test rather than the same one twice.`,
      );
    }
    // --- And the beam is exactly the bikes, every fill. Not "roughly", and not
    // the marker's count either: the disc is gated at 120 m and the column at
    // the bike's own 400, so the two are deliberately different numbers and the
    // relation between them is one-way. What must never drift is the beam
    // against the *bike*, because they are filled on the same row.
    if (meshes.beamDrawn !== meshes.drawn) {
      failures.push(
        `${meshes.beamDrawn} beams against ${meshes.drawn} bikes. They are filled on the same row of ` +
          `the same loop, so a difference means somebody gave the beam a gate of its own -- and a ` +
          `beam without a bike under it is a column of light over an empty parking spot.`,
      );
    }
    if (meshes.beamDrawn < meshes.glowDrawn) {
      failures.push(
        `${meshes.beamDrawn} beams against ${meshes.glowDrawn} markers. The beam is drawn to ` +
          `${BIKE_DRAW_RANGE} m and the marker to ${BIKE_GLOW_RANGE}, so every marker must have a beam ` +
          `standing in it; fewer means the ranges have been swapped.`,
      );
    }
    // Dropped again: the marker and the beam come back with no state to reset.
    bikes[1].rider = 0;
    meshes.update(bikes, 0, 0, () => false, 0);
    if (meshes.drawn !== 4) {
      failures.push(`${meshes.drawn} bikes after the riders got off; four are parked and inside ${BIKE_DRAW_RANGE} m.`);
    }
    if (meshes.glowDrawn !== 3) {
      failures.push(`${meshes.glowDrawn} markers after the riders got off; three bikes are in range and parked.`);
    }
    if (meshes.beamDrawn !== 4) {
      failures.push(
        `${meshes.beamDrawn} beams after the riders got off. A beam is meant to return where the bike ` +
          `is dropped, with no state and no fade -- the same test asked once per frame.`,
      );
    }
    // Two beams are turned differently, which is what stops a street of them
    // dimming in unison. See `BEAM_PHASE`.
    {
      const one = new Matrix4();
      const two = new Matrix4();
      meshes.beam.getMatrixAt(0, one);
      meshes.beam.getMatrixAt(1, two);
      if (one.elements[0] === two.elements[0] && one.elements[2] === two.elements[2]) {
        failures.push('Two bikes’ beams are at the same angle; a row of them would be one object.');
      }
    }
    // The rays turn, and out of phase between two bikes.
    const first = new Matrix4();
    const later = new Matrix4();
    meshes.glow.getMatrixAt(0, first);
    meshes.update(bikes, 0, 0, () => false, 12);
    meshes.glow.getMatrixAt(0, later);
    if (first.equals(later)) failures.push('The rays did not turn over twelve seconds.');
    const other = new Matrix4();
    meshes.glow.getMatrixAt(1, other);
    if (later.elements[0] === other.elements[0] && later.elements[2] === other.elements[2]) {
      failures.push('Two bikes’ markers are at the same angle; the whole street would rotate in lockstep.');
    }
    meshes.dispose();
  }

  // --- The beam ---------------------------------------------------------------
  //
  // Everything below is about the one claim the order made: that a parked bike
  // is spottable over the rooftops from blocks away. Each check is a number
  // that delivers it and that would look perfectly reasonable set to something
  // that does not.
  {
    const beamGeometry = assets.beamGeometry;
    const bp = beamGeometry.getAttribute('position');
    const bn = beamGeometry.getAttribute('normal');
    const bc = beamGeometry.getAttribute('color');
    const bi = beamGeometry.getIndex();
    if (bi === null) {
      failures.push('The bike beam geometry is not indexed.');
      return failures;
    }
    if (bc.count !== bp.count) {
      failures.push(`The beam has ${bc.count} colours against ${bp.count} positions.`);
    }

    // --- Budget. Thin, tall and cheap: the fragment cost is a few pixels wide
    // and the vertex cost has to stay near nothing at 64 instances.
    const expectedTriangles = BEAM_PLANES * (BEAM_STOPS.length - 1) * 4;
    if (assets.beamTriangles !== expectedTriangles) {
      failures.push(
        `The beam is ${assets.beamTriangles} triangles against ${BEAM_PLANES} planes x ` +
          `${BEAM_STOPS.length - 1} segments x 2 windings x 2 triangles = ${expectedTriangles}. ` +
          `A plane with one winding vanishes when you walk round the bike.`,
      );
    }
    if (assets.beamTriangles > 120) {
      failures.push(
        `The beam is ${assets.beamTriangles} triangles; at ${CAPACITY} instances that is ` +
          `${assets.beamTriangles * CAPACITY} for a column of light.`,
      );
    }

    // --- Winding, on `verifyBikeMesh`'s test: a face's cross product must
    // agree with the mean of its three vertex normals. And every face is
    // *vertical*: a horizontal triangle in here is a plane built lying down,
    // which draws a lime saucer 72 m over the street.
    {
      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();
      const n = new Vector3();
      const face = new Vector3();
      let disagreeing = 0;
      let leaning = 0;
      for (let t = 0; t < bi.count; t += 3) {
        const i0 = bi.getX(t);
        const i1 = bi.getX(t + 1);
        const i2 = bi.getX(t + 2);
        a.fromBufferAttribute(bp, i0);
        b.fromBufferAttribute(bp, i1);
        c.fromBufferAttribute(bp, i2);
        face.copy(b).sub(a).cross(n.copy(c).sub(a));
        if (face.lengthSq() < 1e-16) continue;
        face.normalize();
        if (Math.abs(face.y) > 1e-4) leaning++;
        n.set(0, 0, 0);
        for (const i of [i0, i1, i2]) {
          n.x += bn.getX(i);
          n.y += bn.getY(i);
          n.z += bn.getZ(i);
        }
        if (n.lengthSq() < 1e-12) continue;
        if (face.dot(n.normalize()) < 0) disagreeing++;
      }
      if (disagreeing > 0) {
        failures.push(
          `${disagreeing} of ${bi.count / 3} beam triangles are wound against their own normals. ` +
            `Half the column would be back-face culled and the beam would thin out as you walked past it.`,
        );
      }
      if (leaning > 0) {
        failures.push(`${leaning} beam triangles are not vertical; the planes are meant to stand, not lie.`);
      }
    }

    // --- Extents: it comes out of the bike, it clears a roofline by a long way,
    // and it tapers.
    {
      let minY = Infinity;
      let maxY = -Infinity;
      let footReach = 0;
      let tipReach = 0;
      for (let i = 0; i < bp.count; i++) {
        const y = bp.getY(i);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        const r = Math.hypot(bp.getX(i), bp.getZ(i));
        if (y < BEAM_BASE + 1e-6) footReach = Math.max(footReach, r);
        if (y > BEAM_HEIGHT - 1e-6) tipReach = Math.max(tipReach, r);
      }
      if (minY <= 0 || minY > 1.2) {
        failures.push(
          `The beam's foot is at ${minY.toFixed(2)} m. It is meant to sit on the frame -- a beam ` +
            `starting at the road stacks onto the glow disc, and one starting above the bars floats ` +
            `free of the object it is marking.`,
        );
      }
      if (maxY < 60 || maxY > 90) {
        failures.push(
          `The beam is ${maxY.toFixed(0)} m tall. Under 60 it drops behind the next street's roofline ` +
            `as you back away, which is exactly the range it exists to cover; over 90 the columns start ` +
            `reading as buildings in a city with a skyline in it.`,
        );
      }
      if (!(tipReach < footReach)) {
        failures.push(`The beam is ${(tipReach * 2).toFixed(2)} m across at the tip and ${(footReach * 2).toFixed(2)} at the foot; it is meant to taper.`);
      }
      // Wide enough to survive its own draw range. At 400 m, a metre subtends
      // about 2.6 px of a 1080-line frame at this camera -- so a column under a
      // metre across is a line that disappears at exactly the distance it is
      // for.
      if (footReach * 2 < 1) {
        failures.push(
          `The beam is ${(footReach * 2).toFixed(2)} m across. At ${BIKE_DRAW_RANGE} m that is under ` +
            `three pixels, and the whole point of it is being seen from there.`,
        );
      }
    }

    // --- The gradient, read off the geometry rather than off the table -- a
    // builder that dropped the interpolation would pass a check on `BEAM_STOPS`
    // and draw a flat green slab. Brightest near the foot, descending from
    // there, and exactly zero at the top.
    {
      const levels = new Map<number, number>();
      for (let i = 0; i < bc.count; i++) {
        const y = Math.round(bp.getY(i) * 1000) / 1000;
        const sum = bc.getX(i) + bc.getY(i) + bc.getZ(i);
        levels.set(y, Math.max(levels.get(y) ?? 0, sum));
      }
      const ys = [...levels.keys()].sort((a, b) => a - b);
      let peakY = ys[0];
      let peak = 0;
      for (const y of ys) {
        const v = levels.get(y) as number;
        if (v > peak) {
          peak = v;
          peakY = y;
        }
      }
      // The peak is low: "brightest at the base, fading to nothing at the top".
      if (peakY > BEAM_HEIGHT * 0.2) {
        failures.push(
          `The beam is brightest ${peakY.toFixed(1)} m up. It is meant to be brightest near its foot ` +
            `and fade to nothing at the top, not to be a glowing band in the sky.`,
        );
      }
      // And from the peak it only ever falls. A bump anywhere above it reads as
      // a bright ring around the column at one height, which is a defect and
      // not a beam.
      let previous = Infinity;
      let rising = 0;
      for (const y of ys) {
        if (y < peakY) continue;
        const v = levels.get(y) as number;
        if (v > previous + 1e-9) rising++;
        previous = v;
      }
      if (rising > 0) {
        failures.push(
          `The beam brightens again ${rising} time(s) above its peak. Above the brightest point the ` +
            `gradient has to fall monotonically, or the column has a bright band across it.`,
        );
      }
      const top = levels.get(ys[ys.length - 1]) as number;
      if (top > 1e-6) {
        failures.push(
          `The beam's top vertex still sums to ${top.toFixed(3)}. Under an additive blend the fade has ` +
            `to reach exactly zero, or the beam is a green line ruled across the sky with a visible end.`,
        );
      }
      // Still worth something where it clears a terrace. This is the check that
      // says the *order* was met rather than that the code runs: a gradient
      // front-loaded a little harder would be beautiful at ten metres and gone
      // above every roofline in the inner west.
      let atRoofline = 0;
      for (const y of ys) {
        if (y < 14 || y > 16) continue;
        atRoofline = Math.max(atRoofline, levels.get(y) as number);
      }
      if (atRoofline === 0) {
        // No vertex lands in the band, so interpolate from the table instead.
        const t = (15 - BEAM_BASE) / (BEAM_HEIGHT - BEAM_BASE);
        for (let s = 0; s < BEAM_STOPS.length - 1; s++) {
          const [t0, b0] = BEAM_STOPS[s];
          const [t1, b1] = BEAM_STOPS[s + 1];
          if (t < t0 || t > t1) continue;
          atRoofline = (b0 + ((b1 - b0) * (t - t0)) / (t1 - t0)) * peak;
          break;
        }
      }
      if (atRoofline < peak * 0.35) {
        failures.push(
          `At a 15 m terrace ridge the beam is down to ${(atRoofline / peak).toFixed(2)} of its peak. ` +
            `The part above the roofline is the only part a player three blocks away can see.`,
        );
      }
      // Bright enough to punch through noon and not so bright it is a white
      // stripe. Per *plane*: the core stacks up to three of them, so the ceiling
      // is `NeutralToneMapping`'s desaturation shoulder divided by three, and
      // over it the column goes white -- which is less findable than the dimmer
      // version, because white is what the sky already is.
      if (peak > 2.4) failures.push(`The beam peaks at ${peak.toFixed(2)} in linear; three planes of that is a white stripe at noon.`);
      if (peak < 0.9) failures.push(`The beam peaks at ${peak.toFixed(2)} in linear; it will wash out against a daylight sky.`);
    }

    // --- And it is a lime, which is the sRGB-in-a-linear-pipeline mistake
    // arriving in a third constant.
    {
      let lime = 0;
      let lit = 0;
      for (let i = 0; i < bc.count; i++) {
        const r = bc.getX(i);
        const g = bc.getY(i);
        const bl = bc.getZ(i);
        if (r + g + bl < 1e-6) continue;
        lit++;
        if (g > 0.05 && g > r * 1.4 && g > bl * 4) lime++;
      }
      if (lime < lit) {
        failures.push(
          `${lit - lime} of ${lit} lit beam vertices are not a lime green. Check BEAM_LIME has not been ` +
            `given an sRGB triple -- the frame's own LIME documents the same mistake.`,
        );
      }
    }

    // --- The material: additive, unlit, no depth write, depth test **on**, and
    // exactly one of it for the whole city.
    {
      const m = assets.beamMaterial;
      if (m.blending !== AdditiveBlending) failures.push('The beam is not additively blended, so it is paint rather than light.');
      if (!m.transparent) failures.push('The beam is not transparent, so it is drawn in the opaque pass and never blended.');
      if (m.depthWrite) failures.push('The beam writes depth; it will punch a 72 m hole through everything behind it.');
      if (!m.depthTest) {
        failures.push(
          'The beam does not depth test. That is the tempting one-line fix for a beam behind a wall ' +
            'and it costs the whole effect: every column within 400 m gets drawn through the terrain ' +
            'and through the road, and the result is a green haze rather than 64 findable bikes. The ' +
            'terrace clipping the bottom of a beam is what leaves the top standing over the roofline.',
        );
      }
      if (m.side !== FrontSide) {
        failures.push('The beam is not FrontSide; a transparent DoubleSide material is two passes in this renderer.');
      }
      if (m.opacityNode === null) failures.push('The beam has no pulse.');
      if (m === assets.glowMaterial) {
        failures.push('The beam and the marker share a material; the marker carries a polygon offset the beam must not.');
      }
      // The pulse stays inside the range an alpha means. Over one is a silent
      // clamp and a pulse with a flat top; under zero inverts the blend.
      if (BEAM_MEAN + BEAM_PULSE > 1 || BEAM_MEAN - BEAM_PULSE <= 0) {
        failures.push(
          `The beam's pulse runs ${(BEAM_MEAN - BEAM_PULSE).toFixed(2)} to ${(BEAM_MEAN + BEAM_PULSE).toFixed(2)}; ` +
            `an opacity outside (0, 1] clamps flat at the top or inverts at the bottom.`,
        );
      }

      // One material and one geometry, the invariant this project has been
      // burned by -- 115 bikes would be 115 pipeline compilations at whatever
      // moment a player first rounds a corner onto a street with bikes in it.
      const second = new BikeAssets();
      if (second.beamTriangles !== assets.beamTriangles) {
        failures.push('Two BikeAssets built different beam geometry; the beacon is not deterministic.');
      }
      const meshes = new BikeMeshes(assets);
      if (meshes.beam.material !== assets.beamMaterial) {
        failures.push('BikeMeshes built its own beam material instead of sharing the one in BikeAssets.');
      }
      if (meshes.beam.geometry !== assets.beamGeometry) {
        failures.push('BikeMeshes built its own beam geometry instead of sharing the one in BikeAssets.');
      }
      if (meshes.beam.castShadow) failures.push('The beam casts a shadow: a 72 m stripe laid across a suburb by a thing that emits light.');
      if (meshes.beam.receiveShadow) failures.push('The beam receives shadow, so a cloud passing over would put it out.');
      if (meshes.beam.count !== 0) failures.push('The beam starts with instances drawn before any bike exists.');
      meshes.dispose();
    }
  }

  // --- The lean is a roll about the contact patch, not a tip that lifts the
  // wheels off the road, and a remote rider is drawn upright.
  {
    const ridden = new RiddenBike(assets);
    const upright = new Matrix4();
    const leaned = new Matrix4();
    ridden.set(10, 5, -20, 0.8);
    ridden.mesh.getMatrixAt(0, upright);
    ridden.set(10, 5, -20, 0.8, BIKE_LEAN);
    ridden.mesh.getMatrixAt(0, leaned);
    if (upright.equals(leaned)) failures.push('The lean did nothing to the bike’s matrix.');
    // The origin is the contact patch, so the translation is untouched by the
    // roll: a lean that moved the bike would slide it sideways out of the lane.
    for (const i of [12, 13, 14]) {
      if (Math.abs(upright.elements[i] - leaned.elements[i]) > 1e-9) {
        failures.push('Leaning moved the bike off its own contact patch.');
        break;
      }
    }
    // And a point out on the left bar comes up while the right one goes down,
    // which is what "leaned to the right" means. Taken in the bike's own frame
    // at yaw 0 so the test is about the roll and not about the heading.
    ridden.set(0, 0, 0, 0, BIKE_LEAN);
    ridden.mesh.getMatrixAt(0, leaned);
    const left = new Vector3(-BAR_HALF_WIDTH, BAR_Y, BAR_Z).applyMatrix4(leaned);
    const right = new Vector3(BAR_HALF_WIDTH, BAR_Y, BAR_Z).applyMatrix4(leaned);
    if (!(left.y > right.y)) {
      failures.push(
        `A bike leaned by +${BIKE_LEAN} put its left bar at ${left.y.toFixed(3)} and its right at ` +
          `${right.y.toFixed(3)}; positive lean is to the rider’s right, so the left bar rises.`,
      );
    }
    if (BIKE_LEAN <= 0 || BIKE_LEAN > 0.6) {
      failures.push(`A ${(BIKE_LEAN * 57.3).toFixed(0)}-degree lean is a crash, not a corner.`);
    }
    ridden.dispose();
  }

  return failures;
}
