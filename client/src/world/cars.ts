/**
 * Parked cars.
 *
 * Spec section 7.7 asks for "left-hand traffic with parked cars facing
 * accordingly", and this is the half of that sentence the client is responsible
 * for. The pipeline decides where every car stands and which way it points --
 * `pipeline/sydney/parking.py` holds that argument and the numeric audit that
 * proves the sign. Everything here is geometry, paint and instancing.
 *
 * ---------------------------------------------------------------------------
 * Shape. Five bodies, at the sizes they actually are:
 *
 *   0 sedan   4.6 x 1.8 x 1.45
 *   1 hatch   4.2 x 1.75 x 1.50
 *   2 SUV     4.7 x 1.9 x 1.70
 *   3 ute     5.2 x 1.85 x 1.80
 *   4 van     5.4 x 1.9 x 2.00
 *
 * Deliberately toy-like, per spec 8.1's comic character direction -- there is no
 * attempt at a wing mirror, a door shut line, a badge or a number plate, and the
 * wheels are flat discs. But the *dimensions* are not stylised at all, and that
 * is the one thing about a car that cannot be, because a parked car is the
 * measuring stick every player already owns: a 4.6 m sedan against a 3.5 m lane
 * against a 3 m footpath is what tells you how wide the street is. Get the
 * proportions wrong and the whole city changes scale.
 *
 * The silhouette does the recognition work. A hatch has no boot, a ute has a
 * tray, a van's roof runs the full length, an SUV's greenhouse sits high on a
 * tall body. At the distance these are seen -- twenty metres and up -- that is
 * all five of them are, and it is enough.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and the display value beside it was
 * produced by running the chain documented at the top of `sky/calibration.ts`
 * -- irradiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode -- at
 * the reference instant of 3 pm on 15 February. The method is checked rather
 * than assumed: the same evaluation reproduces `street.ts`'s published asphalt
 * (131,137,148) exactly and its footpath (247,248,246) to within six code
 * values.
 *
 * Two things anchor the palette:
 *
 *   - **A white car roof in sun lands at rgb(240,244,249)**, against the sunlit
 *     footpath's rgb(241,245,248). White is 30% of the Australian car park, so
 *     this is the single most common bright surface in a street view after the
 *     footpath itself, and the two sitting at the same level is what stops a row
 *     of parked cars reading as either a glowing highlight or a grey smear.
 *   - **A black car in shade lands at rgb(31,27,32)**, against shaded asphalt's
 *     rgb(24,40,59). Close in level, and separated by *hue*: the car is neutral,
 *     the road is a strong blue. That separation is deliberate -- a black car
 *     dissolving into the road it is parked on is the failure mode here, and it
 *     is a failure that only ever shows up in shade.
 *
 * Every albedo is above the true reflectance of the paint it names. A car's
 * clearcoat reflects the sky across the whole body, and this renderer has no
 * environment map and no ambient specular -- the only specular it has is the
 * sun's own lobe, which reaches a handful of facets at roughness 0.35 and
 * nothing else. Left at their measured reflectances, black came out at
 * rgb(11,8,12) and every dark car in shade was a hole. The lift is the missing
 * sky reflection, put where the renderer can actually deliver it.
 *
 * ---------------------------------------------------------------------------
 * Cost. One geometry per body type, built once for the whole game and shared by
 * every tile; one material, likewise. **102-110 triangles and 108-116 vertices**
 * a car, against the 150-300 this feature was scoped at. Coming in under budget
 * is the point rather than an accident: the inner ring carries 23,020 of these
 * at a per-tile median of 110, and measured at the spawn point on the streamer's
 * own 1.8 km radius and frustum, the worst heading holds **3,759 cars in 398 k
 * triangles, 421 k vertices and 140 instanced draws** -- alongside the 5,914
 * trees and 520 k triangles already in that frame. There was no room to spend
 * more. A tile's cars are one `InstancedMesh` per body type *present in that
 * tile*, so five draws at worst and five in practice.
 *
 * The one material is why the glass and the tyres are vertex colours rather than
 * a second material slot. `instanceColor` is a property of the *object*, not the
 * material, so a two-slot car would have its glass multiplied by the paint
 * colour anyway -- and a second `InstancedMesh` to escape that would double the
 * draw calls for a difference that is invisible at twenty metres, because dark
 * times anything is dark. See `TRIM` for the arithmetic.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import { CAR_BODY_SIZE } from '../game/traffic.ts';
import {
  createCarPose,
  forEachCarNear,
  type CarPose,
  type LaneRoute,
  type TrafficField,
} from '../game/traffic.ts';
import { policeLiveried } from '../game/factions.ts';

/** Must match `parking.SEDAN` .. `parking.VAN` in the pipeline. */
export const BODY_COUNT = 5;
const SEDAN = 0;
const HATCH = 1;
const SUV = 2;
const UTE = 3;
const VAN = 4;

/** Bytes per instance in a `.cars.bin` sidecar. Set by `tiles.write_parking`. */
const CAR_STRIDE = 16;

/**
 * Carriageway clearance above the ground, metres. Must match
 * `streets.CARRIAGEWAY_Y` in the pipeline: a parked car stands on the road, and
 * the road is 2 cm over the terrain the sidecar's position is sampled against.
 */
const CARRIAGEWAY_Y = 0.02;

// --- The palette --------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Paint albedo per `colourIndex`, linear. Must match `parking.WHITE` .. `BEIGE`.
 *
 * The mix behind these is the pipeline's problem and it is worth naming here
 * anyway, because it is what the palette has to survive: white 30%, silver 15%,
 * grey 10%, black 15%, blue 10%, red 8%, beige 7%, green 5%. Seventy per cent of
 * an Australian kerb is achromatic. A palette that spends its variety budget on
 * hue rather than on *value* is the fastest way to make a street of parked cars
 * look like a car park in a racing game, and the four neutrals below are
 * deliberately spread across the whole tonal range instead of clustering.
 *
 * Each row states the display value for a roof in sun, a flank in sun, and a
 * flank in shade -- the three a parked car actually presents. The flank in sun
 * is the one to judge the colour by; the roof is the brightest facet and the
 * shade figure is where the palette can fail without anyone noticing.
 */
const PAINT: Rgb[] = [
  // White. The anchor: a roof in sun at rgb(240,244,249) is the sunlit footpath
  // to within a code value, which is where a white car belongs.
  //          roof sun rgb(240,244,249)  flank sun rgb(232,236,240)  shade rgb(146,141,138)
  [0.805, 0.81, 0.808],
  // Silver. Half a stop under white and very slightly blue -- a metallic silver
  // is grey paint with an aluminium flake reading the sky.
  //          roof sun rgb(217,223,233)  flank sun rgb(175,179,187)  shade rgb( 98, 95, 95)
  [0.4, 0.41, 0.428],
  // Mid grey / gunmetal. Sits just above sunlit asphalt (131,137,148), which is
  // deliberate: a grey car on a grey road has to stay separable and the margin
  // it has is five code values plus the sun on its roof.
  //          roof sun rgb(136,141,151)  flank sun rgb(104,108,116)  shade rgb( 44, 41, 44)
  [0.153, 0.158, 0.172],
  // Black. See the note at the top: this is far above the ~0.05 a black paint
  // actually reflects, and the difference is the clearcoat's sky reflection that
  // this renderer cannot produce any other way. It still reads as the darkest
  // car on the street by 30 code values, and it survives shade.
  //          roof sun rgb(113,116,127)  flank sun rgb( 84, 87, 95)  shade rgb( 31, 27, 31)
  [0.11, 0.112, 0.124],
  // Blue. Mid, slightly toward navy. Fully saturated blue paint is rare on a
  // real kerb and reads as a toy immediately.
  //          roof sun rgb( 47, 97,179)  flank sun rgb( 27, 74,142)  shade rgb(  4, 36, 77)
  [0.036, 0.082, 0.24],
  // Red. Kept hot -- 182 red against 36 green is a proper Australian red, and
  // the temptation to lift the other two channels for "realism" is what turns a
  // red car pink under this tone curve.
  //          roof sun rgb(182, 36, 29)  flank sun rgb(147, 23, 15)  shade rgb( 90,  7,  1)
  [0.268, 0.026, 0.022],
  // Dark green, standing in for every colour outside the six above. Bottle
  // green, not grass: a green car in Australia is a Territory or an old Falcon.
  //          roof sun rgb( 52,104, 79)  flank sun rgb( 31, 79, 56)  shade rgb(  5, 39, 19)
  [0.04, 0.092, 0.058],
  // Beige / champagne. The other half of "other", and the one that carries the
  // fifteen-year-old cars on the kerb.
  //          roof sun rgb(197,190,175)  flank sun rgb(156,150,137)  shade rgb( 85, 74, 59)
  [0.32, 0.288, 0.23],
];

/**
 * The dark parts, as a multiplier on the car's own paint colour rather than as
 * an absolute albedo -- glass, tyres, the sill band and the bumpers.
 *
 * This is the compromise that keeps every car in one draw call. `instanceColor`
 * multiplies the whole object, so a second material slot for the glass would be
 * multiplied by the paint too and would buy nothing; a second `InstancedMesh`
 * would buy neutrality at twice the draw calls. Instead the glass is a vertex
 * colour, and because it multiplies rather than replaces, the result is dark on
 * every car regardless of paint: the brightest possible case is glass on a white
 * car at 0.805 x 0.075 = 0.060 linear, which renders at rgb(63,70,82) in sun and
 * rgb(9,11,17) in shade. Dark times anything is dark, and at the twenty metres
 * these are seen from, a faintly paint-tinted window is indistinguishable from a
 * neutral one -- it also happens to be what a clearcoated pillar actually does.
 *
 * The tyres go darker still, and the sill band sits between the two so the body
 * has a visible waist rather than meeting the road as a slab.
 */
const TRIM = {
  /** Windscreen, backlight and side glass. Blue-shifted: it is reflecting sky. */
  glass: [0.062, 0.07, 0.094] as Rgb,
  /** Tyre and wheel. */
  tyre: [0.05, 0.05, 0.052] as Rgb,
  /** Sill, bumper and the shadow band under the doors. */
  sill: [0.24, 0.24, 0.25] as Rgb,
  /** Roof and bonnet, marginally brighter -- these face the sky. */
  upper: [1.0, 1.0, 1.0] as Rgb,
};

// --- Geometry -----------------------------------------------------------------

/**
 * One cross-section of a body, in the car's local frame.
 *
 * Local axes, stated once because the pipeline's heading depends on them:
 * **+X is the nose, +Y is up, +Z is the car's right.** A rotation of `heading`
 * about Y sends +X to world `(cos h, 0, -sin h)`, and the pipeline writes
 * `heading = atan2(facingNorth, facingEast)` for exactly that reason -- world
 * X is east and world Z is south, so the two cancel with no axis flip.
 */
interface Station {
  /** Distance along the car; negative is toward the tail. */
  x: number;
  /** Half-width at this station. */
  hw: number;
  /** Floor of this band. */
  y0: number;
  /** Ceiling of this band. */
  y1: number;
}

/**
 * Accumulates indexed triangles with a colour per vertex.
 *
 * Indexed, with `material.flatShading` supplying the faceting, for the reason
 * `vegetation.ts` measures at length: non-indexed geometry with baked face
 * normals triples the vertex count for an identical image, and with thousands of
 * instances in frame the vertex count is the axis this feature is expensive on.
 *
 * The one thing that must *not* be shared is a vertex between a painted face and
 * a trim face, because the trim is a vertex colour and a shared vertex would
 * gradient the window into the door. Every `loft` call below therefore emits its
 * own ring vertices even where two bands meet at the same coordinates -- a dozen
 * duplicated vertices a car, against a smeared waistline.
 */
class CarBuilder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];

  private vertex(x: number, y: number, z: number, c: Rgb): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.color.push(c[0], c[1], c[2]);
    return i;
  }

  /** Two triangles, wound so `a -> b -> c` faces out. */
  private quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  /**
   * Sweep a rectangular cross-section through a list of stations.
   *
   * Winding is the whole of the correctness here, and it is worth stating rather
   * than trusting: with the ring ordered right-bottom, right-top, left-top,
   * left-bottom, the ring's own normal is -X, so the tail cap takes that order
   * and the nose cap takes it reversed. A wall quad between station `i` and
   * `i + 1` is then `(Pk[i], Pk[i+1], Pk+1[i+1], Pk+1[i])`, which puts the right
   * flank's normal at +Z. Get either backwards and the face is invisible from
   * outside and the car is a hollow shell with a hole in it.
   */
  loft(
    stations: Station[],
    colour: Rgb,
    faces: { sides?: boolean; top?: boolean; bottom?: boolean; nose?: boolean; tail?: boolean },
  ): void {
    // Ring order: right-bottom, right-top, left-top, left-bottom.
    const rings = stations.map((s) => [
      this.vertex(s.x, s.y0, s.hw, colour),
      this.vertex(s.x, s.y1, s.hw, colour),
      this.vertex(s.x, s.y1, -s.hw, colour),
      this.vertex(s.x, s.y0, -s.hw, colour),
    ]);

    const wall = [faces.sides ?? true, faces.top ?? true, faces.sides ?? true, faces.bottom ?? false];
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < 4; k++) {
        if (!wall[k]) continue;
        const n = (k + 1) % 4;
        this.quad(rings[i][k], rings[i + 1][k], rings[i + 1][n], rings[i][n]);
      }
    }
    const tail = rings[0];
    const nose = rings[rings.length - 1];
    if (faces.tail ?? true) this.quad(tail[0], tail[1], tail[2], tail[3]);
    if (faces.nose ?? true) this.quad(nose[3], nose[2], nose[1], nose[0]);
  }

  /**
   * A flat n-gon disc facing +Z or -Z. This is the wheel, and it is flat on
   * purpose: a wheel is a dark circle from anywhere a player looks at a parked
   * car, and the sill band below carries it from the one angle a disc fails at.
   */
  disc(x: number, y: number, z: number, radius: number, sides: number, colour: Rgb): void {
    const centre = this.vertex(x, y, z, colour);
    const rim: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      rim.push(this.vertex(x + Math.cos(a) * radius, y + Math.sin(a) * radius, z, colour));
    }
    // CCW in the local (x, y) plane gives a +Z normal; the far wheel is the same
    // ring wound the other way.
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (z > 0) this.index.push(centre, rim[i], rim[j]);
      else this.index.push(centre, rim[j], rim[i]);
    }
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    // Normals are computed rather than authored, and are unread while
    // `flatShading` is on. They exist so that turning it off degrades to a
    // smooth car rather than to a black one: `isFlatShading()` is also true when
    // the normal attribute is simply absent.
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Multiply a trim tone into a paint-relative colour. */
function trim(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * Build one body type.
 *
 * Every car is three pieces: a lower body swept through five stations, a
 * greenhouse swept through four, and four wheels. What separates the five is
 * where the greenhouse sits and how long it is -- which is, genuinely, what
 * separates them in life.
 */
function buildBody(body: number): BufferGeometry {
  const m = new CarBuilder();

  // (length, width, height, ride height, sill top, greenhouse start/end as a
  // fraction of length from the tail, roof height).
  const spec = BODY_SPEC[body];
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const halfL = L / 2;
  const halfW = W / 2;

  const glass = trim(TRIM.glass, 1);
  const tyre = trim(TRIM.tyre, 1);
  const sill = trim(TRIM.sill, 1);
  const paint = TRIM.upper;

  // --- Lower body -----------------------------------------------------------
  // Five stations: tail, rear shoulder, waist, front shoulder, nose. The pinch
  // at the two end stations is what stops this reading as a shoebox -- a car is
  // widest at the doors and drawn in at both bumpers, and at six per cent that
  // is small enough to be subliminal and large enough to matter.
  const beltline = spec.beltline;
  const sillTop = spec.ride + 0.26;
  const stations = (y0: number, y1: (t: number) => number): Station[] =>
    [0, 0.12, 0.5, 0.88, 1].map((t) => ({
      x: -halfL + t * L,
      hw: halfW * planTaper(t),
      y0,
      y1: y1(t),
    }));

  // The bonnet and the boot deck sit below the beltline; the middle is the
  // beltline itself. `bonnet` is how far the nose drops and `boot` how far the
  // tail does, and those two numbers are most of what separates a sedan from a
  // hatch from a van without any other change.
  const deck = (t: number) => beltline - spec.bonnet * Math.max(0, Math.min(t * 2.2 - 1.2, 1))
    - spec.boot * Math.max(0, Math.min(1 - t * 2.2, 1));

  // Sill band, dark: ride height up to the sill top. No top face -- the painted
  // body starts at exactly `sillTop`, so it would be eight triangles of hidden
  // geometry on every car in the city.
  m.loft(stations(spec.ride, () => sillTop), sill, { top: false });
  // Upper body, painted: sill top to the deck line.
  m.loft(stations(sillTop, deck), paint, {});

  // --- Greenhouse -----------------------------------------------------------
  // Glass on the sides and both ends, paint on the roof, so the two are separate
  // lofts over the same stations -- see `CarBuilder` on why they cannot share
  // vertices.
  //
  // `cabin0`/`cabin1` are fractions of the length measured from the **tail**,
  // and they are doing the species recognition on their own: a sedan's cabin
  // starts a quarter of the way in because there is a boot behind it, a hatch's
  // starts at the tailgate, a ute's stops well short of it because the rest is
  // tray.
  const c0 = -halfL + spec.cabin0 * L;
  const c1 = -halfL + spec.cabin1 * L;
  const cabin = (): Station[] =>
    [0, 0.22, 0.78, 1].map((t) => {
      const x = c0 + t * (c1 - c0);
      // Zero at the two ends, one across the middle: the windscreen and the
      // backlight lie down, and the A- and C-pillars pull in in plan.
      const s = Math.min(1, Math.min(t, 1 - t) / 0.22);
      return {
        x,
        hw: halfW * (0.70 + 0.20 * s),
        y0: deck((x + halfL) / L),
        y1: H - spec.rake * (1 - s),
      };
    });
  // The backlight, except on the van, where the cabin's rear wall is buried
  // inside the painted box behind it.
  m.loft(cabin(), glass, { top: false, tail: !spec.rearBox });
  m.loft(cabin(), paint, { sides: false, nose: false, tail: false, top: true });

  // A van is a box with a cab stuck on the front, not a car with a long
  // greenhouse: everything behind the B-pillar is painted panel. So the upper
  // structure aft of the cabin is its own painted loft rather than more glass,
  // which is the single change that stops it reading as a minibus.
  if (spec.rearBox) {
    m.loft(
      [-halfL + 0.03 * L, c0 + 0.05].map((x) => ({
        x,
        hw: halfW * 0.90,
        y0: deck((x + halfL) / L),
        y1: H - spec.rake * 0.25,
      })),
      paint,
      // The forward cap butts against the cab and is never seen.
      { nose: false },
    );
  }

  // --- Tub, for the ute -----------------------------------------------------
  // A closed box behind the cab -- a tonneau or a hard lid, which is what most
  // of them have and what saves modelling the inside of an open tray. Its floor
  // sits *below* the body deck so the two interlock, and its lid stands 0.40 m
  // proud, which is the proportion that makes a ute a ute in silhouette.
  if (body === UTE) {
    m.loft(
      [-halfL * 0.96, c0].map((x) => ({
        x,
        hw: halfW * 0.96,
        y0: beltline - 0.2,
        y1: beltline + 0.4,
      })),
      paint,
      { nose: false },
    );
  }

  // --- Wheels ---------------------------------------------------------------
  // Set slightly proud of the widest station so the disc is never coplanar with
  // the flank, which would z-fight along the whole side of every car in the city.
  const wheelZ = halfW * planTaper(0.5) + 0.01;
  for (const ax of [-halfL + spec.axle * L, halfL - spec.axle * L]) {
    for (const z of [wheelZ, -wheelZ]) {
      m.disc(ax, spec.ride + spec.wheel * 0.55, z, spec.wheel, 8, tyre);
    }
  }

  return m.build(`car_${body}`);
}

/** Plan taper: full width through the doors, drawn in at both bumpers. */
function planTaper(t: number): number {
  return 0.94 + 0.06 * Math.min(1, Math.min(t, 1 - t) / 0.14);
}

/**
 * Per-body dimensions and proportions, metres and fractions of length measured
 * from the tail.
 */
const BODY_SPEC: Record<
  number,
  {
    length: number;
    width: number;
    height: number;
    /** Ground clearance to the bottom of the sill. */
    ride: number;
    /** Top of the doors -- where the body stops and the glass starts. */
    beltline: number;
    /** How far the bonnet drops below the beltline. */
    bonnet: number;
    /** How far the boot deck drops. */
    boot: number;
    /** How far the roof falls at the windscreen and the backlight. */
    rake: number;
    /** Greenhouse start and end, as fractions of length from the tail. */
    cabin0: number;
    cabin1: number;
    /** Axle inset from each end, as a fraction of length. */
    axle: number;
    /** Wheel radius. */
    wheel: number;
    /** Painted upper box behind the cabin. The van, and only the van. */
    rearBox?: boolean;
  }
> = {
  [SEDAN]: {
    // Three boxes: boot to 26%, cabin to 70%, bonnet to the nose.
    length: 4.6, width: 1.8, height: 1.45, ride: 0.16, beltline: 1.02,
    bonnet: 0.16, boot: 0.11, rake: 0.26, cabin0: 0.26, cabin1: 0.70, axle: 0.17, wheel: 0.32,
  },
  [HATCH]: {
    // Two boxes. The cabin starts at the tailgate and the boot drop is nearly
    // nothing, which is the entire difference from the sedan.
    length: 4.2, width: 1.75, height: 1.5, ride: 0.16, beltline: 1.0,
    bonnet: 0.15, boot: 0.02, rake: 0.24, cabin0: 0.08, cabin1: 0.66, axle: 0.17, wheel: 0.31,
  },
  [SUV]: {
    // Tall body, tall greenhouse, big wheels, short rear overhang. This is 35%
    // of the kerb, so it is the one whose proportions matter most.
    length: 4.7, width: 1.9, height: 1.7, ride: 0.21, beltline: 1.16,
    bonnet: 0.12, boot: 0.03, rake: 0.2, cabin0: 0.12, cabin1: 0.7, axle: 0.17, wheel: 0.36,
  },
  [UTE]: {
    // Cab from 42% to 74%; everything behind it is tray.
    length: 5.2, width: 1.85, height: 1.8, ride: 0.24, beltline: 1.24,
    bonnet: 0.14, boot: 0.0, rake: 0.18, cabin0: 0.42, cabin1: 0.74, axle: 0.16, wheel: 0.37,
  },
  [VAN]: {
    // Cab-over: a short blunt nose, a small glasshouse at the front, and a
    // painted box for the other 60% of the length.
    length: 5.4, width: 1.9, height: 2.0, ride: 0.2, beltline: 1.14,
    bonnet: 0.2, boot: 0.0, rake: 0.14, cabin0: 0.56, cabin1: 0.95, axle: 0.15, wheel: 0.34,
    rearBox: true,
  },
};

// --- Shared assets ------------------------------------------------------------

/**
 * The five geometries and the one material, built once for the whole game.
 *
 * Shared the way `VegetationAssets` is, and for the same reason: a material
 * created per tile is a WebGPU pipeline compiled per tile, and pipeline
 * compilation blocks the main thread.
 */
export class CarAssets {
  private readonly geometries: BufferGeometry[] = [];
  readonly material: MeshStandardNodeMaterial;
  /** Triangles per body type. */
  readonly triangles: number[] = [];
  /** Vertices per body type. */
  readonly vertices: number[] = [];

  constructor() {
    for (let b = 0; b < BODY_COUNT; b++) {
      const g = buildBody(b);
      this.geometries.push(g);
      this.triangles.push((g.getIndex()?.count ?? 0) / 3);
      this.vertices.push(g.getAttribute('position')?.count ?? 0);
    }

    const material = new MeshStandardNodeMaterial();
    material.name = 'car_paint';
    // No `colorNode`, exactly as `vegetation.ts` has none: `NodeMaterial` already
    // multiplies the material colour by the geometry `color` attribute and then
    // by `instanceColor`, so paint, glass, tyre and sill arrive through two
    // built-in multiplies and no shader graph at all.
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // Automotive paint under a clearcoat. Roughness 0.35 is a broad, soft
    // highlight rather than a mirror -- a sharper one turns every facet of every
    // car into a separate white star as the player walks, which is the single
    // worst thing low-poly geometry can do with a specular lobe.
    material.roughness = 0.35;
    // A dielectric with flake in it, not a metal. The 0.4 costs 40% of the
    // diffuse -- every albedo above is set with that factor already applied --
    // and buys a tinted highlight, which is the difference between metallic and
    // flat paint. It is also why the palette had to be lifted: metalness moves
    // energy from the diffuse term, which is everywhere, into a specular lobe
    // that only lands on the facets aimed at the sun.
    material.metalness = 0.4;
    // Faceted, like the trees, and for the same reason: these are polyhedra and
    // smooth-shading a polyhedron makes it read as a melted version of itself.
    material.flatShading = true;
    this.material = material;
  }

  /** The mesh for one body type. The single point where a body becomes geometry. */
  geometry(body: number): BufferGeometry {
    return this.geometries[body] ?? this.geometries[SEDAN];
  }
}

// --- The sidecar --------------------------------------------------------------

/** One tile's cars, decoded from `<key>.cars.bin` as a structure of arrays. */
export interface TileCars {
  count: number;
  /** Tile-local metres, renderer axes. */
  x: Float32Array;
  z: Float32Array;
  /** Radians, applied as the instance's Y rotation. */
  heading: Float32Array;
  body: Uint8Array;
  colour: Uint8Array;
  seed: Uint16Array;
}

/**
 * Decode a `.cars.bin`. Returns `null` for anything that is not one, because a
 * tile with no cars must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodeCars(buffer: ArrayBuffer): TileCars | null {
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count === 0 || buffer.byteLength < 4 + count * CAR_STRIDE) return null;

  const out: TileCars = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    heading: new Float32Array(count),
    body: new Uint8Array(count),
    colour: new Uint8Array(count),
    seed: new Uint16Array(count),
  };
  for (let i = 0; i < count; i++) {
    const o = 4 + i * CAR_STRIDE;
    out.x[i] = view.getFloat32(o, true);
    out.z[i] = view.getFloat32(o + 4, true);
    out.heading[i] = view.getFloat32(o + 8, true);
    // Clamped rather than trusted: an out-of-range index would read past the
    // geometry or palette table and take the whole tile out with it.
    out.body[i] = Math.min(view.getUint8(o + 12), BODY_COUNT - 1);
    out.colour[i] = Math.min(view.getUint8(o + 13), PAINT.length - 1);
    out.seed[i] = view.getUint16(o + 14, true);
  }
  return out;
}

// --- Instancing ---------------------------------------------------------------

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
const _scale = /*#__PURE__*/ new Vector3();
const _up = /*#__PURE__*/ new Vector3(0, 1, 0);
const _colour = /*#__PURE__*/ new Color();

/** Deterministic hash over the sidecar seed. Author-time only. */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/**
 * Build one `InstancedMesh` per body type present in a tile.
 *
 * Positions are tile-local, so these are added to the tile's own group and
 * inherit its world translation -- the same arrangement that keeps float32
 * vertex precision constant across the extent for the buildings and the trees.
 *
 * `groundAt` is the tile's own terrain grid, in the same tile-local metres, and
 * a car sits on it *level* rather than on the road's own pitch. That is wrong by
 * the gradient of the street -- a couple of degrees on anything the pipeline
 * parks on -- and it is the right kind of wrong: pitching a body needs the
 * road's direction as well as its slope, and a car parked half a centimetre out
 * of a 1:20 camber is invisible where a car banked the wrong way is not.
 */
export function buildTileCars(
  data: TileCars,
  assets: CarAssets,
  groundAt: (x: number, z: number) => number = () => 0,
): InstancedMesh[] {
  const perBody: number[][] = Array.from({ length: BODY_COUNT }, () => []);
  for (let i = 0; i < data.count; i++) perBody[data.body[i]].push(i);

  const out: InstancedMesh[] = [];
  for (let b = 0; b < BODY_COUNT; b++) {
    const members = perBody[b];
    if (members.length === 0) continue;

    const mesh = new InstancedMesh(assets.geometry(b), assets.material, members.length);
    mesh.name = `cars_${b}`;

    for (let n = 0; n < members.length; n++) {
      const i = members[n];
      const seed = data.seed[i];
      // The carriageway is 2 cm over the ground and a kerbside bay is on it, so
      // the wheels go on the terrain plus that same clearance rather than on the
      // terrain itself -- otherwise every car in the city is buried to the rims
      // in its own road.
      _position.set(data.x[i], groundAt(data.x[i], data.z[i]) + CARRIAGEWAY_Y, data.z[i]);
      _quaternion.setFromAxisAngle(_up, data.heading[i]);
      // A few per cent of size variation, uniform so the proportions hold. Five
      // body types over a hundred cars in view is five silhouettes repeated
      // twenty times each, and a 4% spread is enough to stop the eye locking on
      // to the repeat without anything looking like a different model.
      const s = 0.96 + 0.08 * hash(seed, 11);
      _scale.set(s, s, s);
      _matrix.compose(_position, _quaternion, _scale);
      mesh.setMatrixAt(n, _matrix);

      // Paint, plus a small tonal jitter. Weighted toward value rather than hue:
      // two white cars differ by how faded and how dirty they are, not by being
      // different whites, and a hue-jittered fleet reads as a colour bug.
      const paint = PAINT[data.colour[i]];
      const tone = 0.9 + 0.2 * hash(seed, 13);
      _colour.setRGB(paint[0] * tone, paint[1] * tone, paint[2] * tone);
      mesh.setColorAt(n, _colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Culled with its tile, like every other primitive the streamer loads.
    mesh.frustumCulled = false;
    // Read by `streamer.ts` in two places -- the shadow role and, critically,
    // disposal, where the geometry is *shared* and must not be released with the
    // tile. Same flag name pattern as `userData.vegetation`, and it has to be a
    // separate one so a future change to either cannot silently free the other's
    // geometry.
    mesh.userData.cars = true;
    out.push(mesh);
  }
  return out;
}

// --- The ones that move --------------------------------------------------------

/**
 * The five body sizes, for `game/traffic.ts` to build its hit boxes from.
 *
 * Handed over rather than imported the other way, because `traffic.ts` compiles
 * into the Bun server and must not pull three in behind it -- see its header.
 * `verifyTraffic` is passed this table and asserts the two agree, which is the
 * check that stops a car knocking you over from somewhere other than where it
 * looks.
 */
export function carBodySizes(): ReadonlyArray<{ length: number; width: number; height: number }> {
  const out: Array<{ length: number; width: number; height: number }> = [];
  for (let b = 0; b < BODY_COUNT; b++) {
    const s = BODY_SPEC[b];
    out.push({ length: s.length, width: s.width, height: s.height });
  }
  return out;
}

/**
 * How far from the player a moving car is drawn, metres.
 *
 * A trade, and both sides of it are measured rather than guessed. The traffic is
 * about 124 cars per square kilometre citywide and roughly three times that in
 * the CBD, so this radius holds ~70 cars in the suburbs and ~210 in town -- 23 k
 * triangles at the worst, against the 398 k the *parked* cars already put in the
 * same frame. That is small enough to let the movers cast shadows, which matters
 * more than the count does: a car with no shadow does not sit on the road, and
 * the bar of shade a car throws across a lane is the thing that makes it read as
 * moving through the world rather than over it.
 *
 * Pushing it further is cheap in triangles and expensive in *pops*: a car exists
 * for one traversal of its route, so the further out they are drawn the more
 * often one is seen appearing. 420 m puts the appearances beyond the distance a
 * player is reading individual cars at.
 */
export const TRAFFIC_DRAW_RADIUS = 420;

/**
 * Fleet white, linear. `PAINT[0]` exactly, and the same number deliberately.
 *
 * A marked car and a white civilian car are the same white, which is what makes
 * the chequer band the thing that distinguishes them rather than the paint. The
 * value is not re-derived here for the reason `PAINT` states about the whole
 * palette: white is the anchor the rest of the fleet is judged against, and two
 * whites in one street is two whites.
 */
const LIVERY_WHITE: Rgb = [0.805, 0.81, 0.808];

/**
 * The chequer band, as a unit ring the instance matrix scales onto a body.
 *
 * A closed loop of alternating quads at door height, one unit in each axis so a
 * scale of `(halfLength, height, halfWidth)` lands it on any of the five bodies.
 * Sixteen facets round the loop, which is even -- an odd count puts two of one
 * colour together at the seam, which is the one place a chequer stops being a
 * chequer, and it is the same assertion `world/police.verifyPoliceKit` makes
 * about the band on an officer's chest.
 *
 * Drawn as an open band with no top or bottom: it is a decal, seen from the
 * side, and a capped one would be a box floating around a car.
 */
function chequerBand(): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const colour: number[] = [];
  const index: number[] = [];
  // Door height on a unit body: a shade under half-way up, which is where a
  // Sillitoe band sits on every marked car in the country.
  const lo = 0.34;
  const hi = 0.5;
  const SIDES = 16;
  // The loop, as a rounded rectangle in plan -- a square ring would cut the
  // corners off a car. `cos`/`sin` on a superellipse-ish blend is overkill; the
  // body is a box, so the ring is a box with the corners chamfered by the same
  // parametrisation the loop already has.
  const at = (t: number): [number, number] => {
    const a = t * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Push toward the box: raising the magnitude flattens the sides.
    const k = 1 / Math.max(Math.abs(c), Math.abs(s), 1e-6);
    const blend = 0.82;
    return [c * (1 + (k - 1) * blend), s * (1 + (k - 1) * blend)];
  };
  for (let i = 0; i < SIDES; i++) {
    const [x0, z0] = at(i / SIDES);
    const [x1, z1] = at((i + 1) / SIDES);
    const c = i & 1 ? LIVERY_CHEQUER_BLUE : LIVERY_CHEQUER_WHITE;
    const base = position.length / 3;
    // Outward-facing, on the same winding rule the officer's band uses: bottom
    // near, bottom far, top far, top near.
    const pts: Array<[number, number, number]> = [
      [x0, lo, z0], [x1, lo, z1], [x1, hi, z1], [x0, hi, z0],
    ];
    // The face normal points out of the loop, which for a ring is the radial
    // direction at the facet's own midpoint.
    let nx = (x0 + x1) * 0.5;
    let nz = (z0 + z1) * 0.5;
    const len = Math.sqrt(nx * nx + nz * nz) || 1;
    nx /= len;
    nz /= len;
    for (const p of pts) {
      position.push(p[0], p[1], p[2]);
      normal.push(nx, 0, nz);
      colour.push(c[0], c[1], c[2]);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.name = 'police-livery-band';
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colour), 3));
  g.setIndex(new BufferAttribute(new Uint16Array(index), 1));
  g.computeBoundingSphere();
  return g;
}

/** The band's two colours, linear. `world/police.ts`'s pair, so one force wears one livery. */
const LIVERY_CHEQUER_WHITE: Rgb = [0.82, 0.85, 0.88];
const LIVERY_CHEQUER_BLUE: Rgb = [0.05, 0.14, 0.44];

/**
 * Is this car one of the liveried ones?
 *
 * The rule itself lives in `game/factions.policeLiveried` -- it is a claim about
 * where the police are, not about how a car is drawn, and a renderer that owned
 * it made it impossible for a headless check to assert. What stays here is the
 * chequer band, the fleet white and the instancing, which is all this file has
 * ever actually been about.
 */
const liveried = policeLiveried;

/**
 * Instances per body type. Five times this is the ceiling on cars in frame.
 *
 * Sedans are 30% of the mix, so the busiest body type sees about a third of the
 * ~210 the radius above admits. 256 is an order of magnitude of headroom on the
 * measured worst case, and an `InstancedMesh` costs its capacity in buffer bytes
 * and its *count* in draw work -- so the headroom is 100 kB and no frame time.
 */
const MOVER_CAPACITY = 256;

/**
 * Every moving car in view, as five instanced sets.
 *
 * **Not parented to a tile.** Every other instanced thing in this project lives
 * on its tile's group and inherits its translation, which is what keeps float32
 * vertex precision constant -- and it works because none of those things moves.
 * A car crosses a tile boundary every few seconds, so binning the fleet by tile
 * every frame would mean rebuilding several `InstancedMesh` sets per second for
 * nothing. Instead there is one set for the whole visible world, positions are
 * world-space (`decodeLanes` applies the tile origin once, at load), and the
 * float32 argument is answered by the draw radius: the matrices are absolute
 * coordinates but they are never further than `TRAFFIC_DRAW_RADIUS` from the
 * camera, and at 4 km from the origin a float32 has 0.5 mm of precision.
 *
 * `update` allocates nothing. It is called once per frame with the *fractional*
 * tick, so the cars move smoothly at any frame rate while the simulation reads
 * whole ticks -- the picture is a function of the same lookup the hit test uses,
 * evaluated a fraction of a tick later.
 */
export class TrafficMovers {
  readonly meshes: InstancedMesh[] = [];
  /** Cars drawn last update. Read by the HUD's diagnostics line. */
  drawn = 0;
  /** How long the last update took, milliseconds. Likewise. */
  costMs = 0;
  /** Of those, how many wore a police livery. Diagnostics only. */
  liveried = 0;

  private readonly counts: number[] = [];
  private readonly scratch: LaneRoute[] = [];
  private readonly pose: CarPose = createCarPose();
  /**
   * The chequer band, as one instanced set over every liveried body.
   *
   * A *separate* mesh rather than a wider car geometry, because the livery is on
   * one car in twelve near a station and a chequer baked into the body would be
   * a sixth set of geometry carried by every car in the city. It is a flat ring
   * at door height, scaled per instance to whichever body it is going round --
   * `CAR_BODY_SIZE` is the same table the hit box comes from, so the band is on
   * the car rather than near it.
   */
  private readonly band: InstancedMesh;
  private bandCount = 0;

  constructor(assets: CarAssets) {
    this.band = new InstancedMesh(chequerBand(), assets.material, MOVER_CAPACITY);
    this.band.name = 'traffic_livery';
    this.band.count = 0;
    this.band.frustumCulled = false;
    // Neither casts nor receives: it is a 4 cm skin 1 mm proud of a body that
    // already does both, so its own shadow is the body's shadow drawn twice.
    this.band.castShadow = false;
    this.band.receiveShadow = false;
    this.band.userData.traffic = true;
    for (let b = 0; b < BODY_COUNT; b++) {
      const mesh = new InstancedMesh(assets.geometry(b), assets.material, MOVER_CAPACITY);
      mesh.name = `traffic_${b}`;
      mesh.count = 0;
      // Culled by the draw radius rather than by the frustum, for the reason
      // every other instanced set in this project has: the bounding sphere of a
      // set that changes every frame would have to be recomputed every frame,
      // and a radius test the fill loop is already doing is free.
      mesh.frustumCulled = false;
      // Casts like a parked car and for the same reason -- see `buildTileCars`.
      // It does not receive: the shadow it throws down the lane is worth more
      // than the one it catches, and a mover is never inside the volume long
      // enough for the difference to be noticed.
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Distinct from `userData.cars`, which is the *parked* flag the streamer's
      // disposal path reads. These are never owned by a tile and must never be
      // freed by an eviction -- the geometry is shared with every parked car in
      // the city.
      mesh.userData.traffic = true;
      this.meshes.push(mesh);
      this.counts.push(0);
    }
    // **After** the five bodies, because `update` indexes `this.meshes[body]`.
    this.meshes.push(this.band);
  }

  /**
   * Place every car within the radius, at `tick` plus a frame fraction.
   *
   * `tick` may be fractional. That is the one place in this feature where a
   * non-integer tick is correct: the hit test runs on whole ticks so the client
   * and the server agree, and the *picture* runs between them so a 144 Hz
   * display does not see 60 Hz cars.
   */
  update(field: TrafficField, tick: number, x: number, z: number): void {
    const at = performance.now();
    for (let b = 0; b < BODY_COUNT; b++) this.counts[b] = 0;
    this.bandCount = 0;

    forEachCarNear(field, x, z, TRAFFIC_DRAW_RADIUS, tick, this.scratch, this.pose, (p) => {
      const n = this.counts[p.body];
      if (n >= MOVER_CAPACITY) return;
      const mesh = this.meshes[p.body];
      _position.set(p.x, p.y, p.z);
      // The heading, straight off the pose's unit direction and with no
      // `Math.atan2` in it. The car's local +X is its nose (see `Station`), so
      // the rotation that sends +X to (dx, 0, dz) is a yaw of `atan2(-dz, dx)`
      // -- and the half-angle form of that quaternion is two square roots and no
      // transcendental at all. `w = sqrt((1 + cos)/2)`, `y = sin/(2w)`, with
      // `cos` and `sin` read directly off the direction vector.
      //
      // Not for determinism -- nothing here is on the simulation path -- but
      // because this runs on every car in frame on every frame, and `atan2` plus
      // `setFromAxisAngle`'s own `sin`/`cos` is three transcendentals a car
      // where this is one square root.
      const c = p.dx;
      const s = -p.dz;
      const w2 = (1 + c) * 0.5;
      if (w2 > 1e-12) {
        const w = Math.sqrt(w2);
        _quaternion.set(0, s / (2 * w), 0, w);
      } else {
        // Facing exactly backwards along +X: the half-angle is a right angle
        // about Y and the formula above divides by zero.
        _quaternion.set(0, 1, 0, 0);
      }
      _scale.set(p.scale, p.scale, p.scale);
      _matrix.compose(_position, _quaternion, _scale);
      mesh.setMatrixAt(n, _matrix);

      const wearsLivery = liveried(p.route, p.slot, p.x, p.z);
      // White, flat, with **no tonal jitter** -- which is the point of the
      // exception. Every other car in the city gets a +/-10% tone off the same
      // hash so a street reads as a fleet of individuals; a marked car is a
      // *fleet vehicle* and the thing that says so is that it is the same white
      // as the one behind it.
      const paint = wearsLivery ? LIVERY_WHITE : (PAINT[p.colour] ?? PAINT[0]);
      const tone = wearsLivery ? 1 : 0.9 + 0.2 * hash(p.route, p.slot);
      _colour.setRGB(paint[0] * tone, paint[1] * tone, paint[2] * tone);
      mesh.setColorAt(n, _colour);
      this.counts[p.body] = n + 1;

      if (wearsLivery && this.bandCount < MOVER_CAPACITY) {
        // The band's geometry is a unit ring; scaling it to the body's own
        // dimensions is what puts it on the doors of a van and on the doors of a
        // hatch. `CAR_BODY_SIZE` is the hit box's table, so this cannot drift
        // from the shape it is drawn around.
        const size = CAR_BODY_SIZE[p.body] ?? CAR_BODY_SIZE[0];
        _scale.set(
          (size.length * 0.5 + 0.01) * p.scale,
          size.height * p.scale,
          (size.width * 0.5 + 0.01) * p.scale,
        );
        _matrix.compose(_position, _quaternion, _scale);
        this.band.setMatrixAt(this.bandCount, _matrix);
        this.bandCount++;
      }
    });

    let drawn = 0;
    for (let b = 0; b < BODY_COUNT; b++) {
      const mesh = this.meshes[b];
      const n = this.counts[b];
      // Only upload what changed. A tile of the buffer nobody is drawing does
      // not need to be correct, and `needsUpdate` on an untouched set is a
      // pointless re-upload of 16 kB every frame.
      if (n > 0 || mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = n;
      drawn += n;
    }
    if (this.bandCount > 0 || this.band.count > 0) this.band.instanceMatrix.needsUpdate = true;
    this.band.count = this.bandCount;
    this.liveried = this.bandCount;
    this.drawn = drawn;
    this.costMs = performance.now() - at;
  }

  /**
   * Release the instance buffers. **Not the geometry or the material**, which
   * are `CarAssets`' and are shared with every parked car in the city -- the
   * same trap `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
  }
}
