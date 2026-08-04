/**
 * Timber power poles and the wires strung between them.
 *
 * Spec section 7.2 calls this the **highest recognition-per-triangle feature in
 * the project**, and the poles are only half of why. A pole on its own is a
 * post. What says *Australian inner suburb* is the pair of black catenaries
 * sagging away down the street at head height, cutting the sky into strips --
 * and that is 72 triangles a span of the cheapest geometry in the build.
 *
 * `pipeline/sydney/power.py` decides where every pole stands, how tall it is
 * and which pole pairs are wired; this file is geometry, tone and instancing.
 *
 * ---------------------------------------------------------------------------
 * The pole. An eight-sided tapered shaft, 0.16 m radius at the butt to 0.11 at
 * the top, one 1.8 m crossarm 0.55 m under the top, and two insulator stubs
 * hanging off its underside where the conductors tie on. 92 triangles; the
 * transformer variant adds a can and its brackets on the upper shaft for 140.
 *
 * Three things are done per instance and each of them is fighting the same
 * failure, which is that a procedural pole line reads as a fence:
 *
 *   - **Height**, 9.5-11.5 m from the sidecar, applied as a Y scale on the one
 *     shared geometry.
 *   - **Yaw**, so the crossarm lies *across* the street rather than along it.
 *     Nothing in the sidecar says which way that is, and nothing needs to: the
 *     spans already do. See `deriveYaw`.
 *   - **Lean**, up to 1.2 degrees in a hashed direction. Dead vertical is the
 *     single loudest tell in the whole feature -- a hundred poles in perfect
 *     plumb reads as CAD, and no pole in this city has been plumb since it was
 *     put in. The lean is applied about the *crossarm* rather than the foot, so
 *     the wire attachment stays exactly where the pipeline said it is; see
 *     `WIRE_ATTACH_FRACTION`.
 *
 * ---------------------------------------------------------------------------
 * The wire, and why it is not a line.
 *
 * Spec 7.2 says "render lines as camera-facing quads", and the obvious cheaper
 * reading of that -- `LineSegments`, one segment per span -- fails on this
 * renderer for a reason that has nothing to do with taste: WebGPU line
 * primitives are one pixel wide, full stop, and the project renders at 0.75
 * scale. A one-pixel line at 0.75 scale is three quarters of a pixel, which
 * means a wire that shimmers when the player walks and disappears entirely at
 * some angles. It is also unaffected by distance, so a wire 400 m away is
 * exactly as heavy as one overhead.
 *
 * So each catenary is a thin ribbon, and the ribbon is a **cross section**: two
 * flat strips 0.035 m wide at right angles, one horizontal and one vertical,
 * sharing a centre line. A single flat ribbon has to choose which way to face
 * and is invisible edge-on to that choice -- horizontal vanishes when seen from
 * street level along the wire, vertical vanishes when seen from a window above
 * it. Two at right angles always present at least one full width, at 36
 * triangles a catenary and 72 a span. It is the oldest trick in the book and it
 * is still the right one when the alternative is a screen-space shader for four
 * hundred triangles of geometry.
 *
 * The curve is a parabola rather than a true `cosh`, sampled at 9 segments. Over
 * a 40 m span with 0.55 m of sag the two differ by under 3 mm, which is a tenth
 * of the wire's own drawn width.
 *
 * ---------------------------------------------------------------------------
 * Colour. Every albedo below is linear, and each display value beside it was
 * produced by running the chain documented at the top of `sky/calibration.ts`
 * -- irradiance, Lambert, exposure 0.62, Neutral tone mapping, sRGB encode --
 * at the reference instant of 3 pm on 15 February. The method is checked rather
 * than assumed: the same evaluation reproduces `facade.ts`'s published sunlit
 * render (244,244,239) and shaded brick (95,40,17) exactly.
 *
 * The wire is the interesting one, because it is **unlit**. A flat ribbon has
 * one normal and a horizontal one points at the sky: lit as a standard material
 * at any albedo that survives shade, the top strip of every wire in the city
 * catches `N.L = 0.84` of the direct beam and renders at rgb(180) -- a bright
 * white line across a blue sky, which is the exact opposite of the thing being
 * drawn. Unlit at rgb(7,11,18) against a sky that tone maps to rgb(196,221,245)
 * is a hard black silhouette, which is what a conductor against the sky
 * actually is in a photograph, and it costs no lighting at all.
 *
 * ---------------------------------------------------------------------------
 * Cost. One shared geometry per pole kind and one shared material for the
 * whole game; one material for the wires. Per tile: **one `InstancedMesh` per
 * pole kind present** and **one merged `BufferGeometry` for every wire**, so
 * two or three draw calls. The inner ring carries 7,330 poles and 4,909 spans
 * at a per-tile median of 37 poles and 25 spans -- 3,400 triangles of pole and
 * 1,800 of wire against the 40,000 of trees already in the same tile. This is
 * the cheapest thing in the world by a wide margin, which is the whole argument
 * of spec 7.2.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

/** Must match `power.STANDARD` / `power.TRANSFORMER` in the pipeline. */
export const KIND_COUNT = 2;
const STANDARD = 0;
const TRANSFORMER = 1;

/** Bytes per record in a `.power.bin` sidecar. Set by `tiles.write_power`. */
const POLE_STRIDE = 20;
const WIRE_STRIDE = 24;

// --- The shared frame with the pipeline ---------------------------------------
//
// These three describe one pole geometry built at a nominal height and scaled
// per instance, and **`power.py` holds the same three numbers**. They are what
// makes a wire end exactly on an insulator instead of near one -- see
// `power.wire_attachment_y`, which is the other half of this arithmetic.

/** The height the geometry below is built at. Each instance scales Y by `height / this`. */
const NOMINAL_HEIGHT = 10.5;
/** Crossarm centre, below the top of the shaft. */
const CROSSARM_BELOW_TOP = 0.55;
/** Conductor tie-off, below the crossarm: the length of the insulator stub. */
const WIRE_BELOW_CROSSARM = 0.3;

/**
 * Where a conductor ties on, as a fraction of the pole's height.
 *
 * The single number this file and the pipeline have to agree on, because it is
 * the one the wire geometry is positioned by at one end and the pole geometry at
 * the other. It is also the pivot the lean is applied about, which is what keeps
 * the two together for a pole that is not plumb.
 */
const WIRE_ATTACH_FRACTION = 1 - (CROSSARM_BELOW_TOP + WIRE_BELOW_CROSSARM) / NOMINAL_HEIGHT;

// --- Geometry constants -------------------------------------------------------

const SHAFT_SIDES = 8;
const SHAFT_SEGMENTS = 3;
const SHAFT_RADIUS_BUTT = 0.16;
const SHAFT_RADIUS_TOP = 0.11;

const CROSSARM_LENGTH = 1.8;
const CROSSARM_THICKNESS = 0.09;
const CROSSARM_DEPTH = 0.1;

/**
 * Where the two drawn conductors sit along the crossarm, metres either side of
 * the pole. The insulator stubs are here too -- a conductor that does not land
 * on its insulator is the one detail at this scale that reads as broken.
 *
 * A real Sydney LV arm carries three phases and a neutral spread over its full
 * width; this draws two strands, close enough together that at any distance
 * over about thirty metres they merge into one heavier line, which is what the
 * eye reads a four-wire run as anyway.
 */
const STRAND_OFFSET = 0.35;

/** Maximum lean, radians. See the note at the top on why it is not zero. */
const MAX_TILT = (1.2 * Math.PI) / 180;

// --- Wire construction --------------------------------------------------------

/** Segments per catenary. 9 puts the parabola within 3 mm of a true `cosh`. */
const WIRE_SEGMENTS = 9;
/** Half-width of each ribbon strip, metres. Drawn ~4x the real conductor. */
const WIRE_HALF_WIDTH = 0.0175;
/** Sag at the reference span, metres, and the span it is quoted at. */
const SAG_AT_REFERENCE = 0.55;
const SAG_REFERENCE_SPAN = 40;
const SAG_MIN = 0.2;
const SAG_MAX = 1.2;

// --- The palette --------------------------------------------------------------

type Rgb = [number, number, number];

/**
 * Aged hardwood, linear. **Grey, not brown.**
 *
 * A new CCA-treated pole is a pale green-brown for about a year and then spends
 * the next sixty going silver: what is actually on a Sydney street is a
 * weathered grey with a warm undertone, closer to driftwood than to timber. The
 * fresh-brown version of this colour is the fastest way to make the whole
 * feature read as a fence post, so red is only seven display values over blue in
 * sun -- and the warmth that *is* there comes out in shade, where the bounce off
 * the road adds another ten.
 *
 *   sun N.L 0.54  rgb(137,135,130)    grazing N.L 0.30  rgb(103,102,100)
 *   shade         rgb( 70, 62, 53)
 *
 * Which puts a sunlit pole a long way under the sunlit footpath it stands on
 * (247,248,246) and just under sunlit asphalt (131,137,148) -- and separated
 * from the road by hue, warm against the asphalt's strong blue, exactly the way
 * `cars.ts` separates a black car from the road it is parked on.
 */
const TIMBER: Rgb = [0.15, 0.14, 0.126];

/**
 * The crossarm, at 0.9 of the shaft. Same timber, more weather: an arm is
 * horizontal, so it holds water and takes the full sun on its top face for the
 * whole of every day.
 *
 *   sun rgb(130,127,122)   shade rgb(65,57,48)
 */
const CROSSARM_TONE = 0.9;

/**
 * Insulator stubs, pale grey. Porcelain and galvanised hardware together.
 *
 *   sun rgb(195,198,198)   shade rgb(113,108,103)
 *
 * Small -- two stubs of 0.05 m radius -- and they earn their 32 triangles by
 * being the brightest thing on the pole, which is what makes the crossarm
 * legible as a crossarm at fifty metres rather than as a lump.
 */
const INSULATOR: Rgb = [0.3, 0.3, 0.29];

/**
 * The transformer can: weathered galvanised steel, cool where the timber is
 * warm so the two never merge.
 *
 *   sun rgb(144,149,155)   shade rgb(76,73,73)
 */
const TRANSFORMER_GREY: Rgb = [0.165, 0.17, 0.176];

/**
 * Aged ACSR conductor. **Unlit**, so this is not an albedo -- it is the linear
 * radiance leaving the surface, and it goes to the tone curve untouched by any
 * light in the scene.
 *
 *   display rgb(7,11,18), against a 3 pm sky that tone maps to rgb(196,221,245)
 *
 * The faint blue is deliberate and it is the only thing here that is not simply
 * "black": a wire seen against the sky picks up a little sky scatter along its
 * length, and a pure neutral at this level reads as a scratch on the lens rather
 * than as an object. See the note at the top on why this is not a lit material.
 */
const WIRE_COLOUR: Rgb = [0.03, 0.032, 0.036];

// --- Geometry -----------------------------------------------------------------

/**
 * Accumulates indexed triangles with a colour per vertex.
 *
 * Indexed, with `material.flatShading` supplying the faceting, for the reason
 * `vegetation.ts` measures at length and `cars.ts` repeats: non-indexed geometry
 * with baked face normals triples the vertex count for an identical image.
 *
 * As in `cars.ts`, vertices are never shared between two *tones* -- the shaft
 * and the crossarm meet at the same coordinates and each emits its own ring, or
 * the timber would gradient into the insulator.
 */
class PoleBuilder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];

  vertex(x: number, y: number, z: number, c: Rgb): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.color.push(c[0], c[1], c[2]);
    return i;
  }

  /** Two triangles, wound so `a -> b -> c` faces out. */
  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  /**
   * A tapered n-gon prism about the Y axis, capped at the top only.
   *
   * The bottom cap is deliberately absent on the shaft -- it is buried in the
   * footpath -- and present on nothing else that needs one, so it is not a
   * parameter. Winding: the ring runs counter-clockwise seen from +Y, which puts
   * the side quads' normals outward and lets the top cap use the ring order as
   * it stands.
   */
  prism(
    cx: number,
    cz: number,
    y0: number,
    y1: number,
    r0: number,
    r1: number,
    sides: number,
    segments: number,
    colour: Rgb,
    cap: boolean,
  ): void {
    const rings: number[][] = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const y = y0 + (y1 - y0) * t;
      const r = r0 + (r1 - r0) * t;
      const ring: number[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        ring.push(this.vertex(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, colour));
      }
      rings.push(ring);
    }
    for (let s = 0; s + 1 < rings.length; s++) {
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        this.quad(rings[s][i], rings[s + 1][i], rings[s + 1][j], rings[s][j]);
      }
    }
    if (!cap) return;
    const top = rings[rings.length - 1];
    const centre = this.vertex(cx, y1, cz, colour);
    for (let i = 0; i < sides; i++) {
      this.index.push(centre, top[i], top[(i + 1) % sides]);
    }
  }

  /** An axis-aligned box. 12 triangles, its own eight vertices. */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    colour: Rgb,
  ): void {
    const v: number[] = [];
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const sx of [-1, 1]) {
          v.push(this.vertex(cx + sx * hx, cy + sy * hy, cz + sz * hz, colour));
        }
      }
    }
    // Index order above is (y, z, x) major, so: 0 -x-z-y, 1 +x-z-y, 2 -x+z-y,
    // 3 +x+z-y, 4 -x-z+y, 5 +x-z+y, 6 -x+z+y, 7 +x+z+y.
    this.quad(v[4], v[5], v[7], v[6]); // +y
    this.quad(v[2], v[3], v[1], v[0]); // -y
    this.quad(v[2], v[6], v[7], v[3]); // +z
    this.quad(v[1], v[5], v[4], v[0]); // -z
    this.quad(v[3], v[7], v[5], v[1]); // +x
    this.quad(v[0], v[4], v[6], v[2]); // -x
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    // Computed rather than authored, and unread while `flatShading` is on. They
    // exist so that turning it off degrades to a smooth pole rather than a black
    // one -- `isFlatShading()` is also true when the normal attribute is absent.
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Multiply a tone into a colour. */
function tone(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * Build one pole kind, at `NOMINAL_HEIGHT`, base at y = 0.
 *
 * Local axes: **+Y up, +X along the crossarm.** The instance yaw is what turns
 * +X across the street, and `deriveYaw` is where that number comes from.
 */
function buildPole(kind: number): BufferGeometry {
  const m = new PoleBuilder();
  const arm = tone(TIMBER, CROSSARM_TONE);
  const armY = NOMINAL_HEIGHT - CROSSARM_BELOW_TOP;
  const tieY = NOMINAL_HEIGHT * WIRE_ATTACH_FRACTION;

  // The shaft. Three segments rather than one: an 8-sided prism 10 m tall has
  // facets 10 m long, and the taper only reads as a taper if there is more than
  // one ring between the ends of it.
  m.prism(
    0, 0, 0, NOMINAL_HEIGHT,
    SHAFT_RADIUS_BUTT, SHAFT_RADIUS_TOP,
    SHAFT_SIDES, SHAFT_SEGMENTS, TIMBER, true,
  );

  // The crossarm, through the shaft rather than butted against it, so there is
  // no seam to line up and nothing to z-fight along.
  m.box(0, armY, 0, CROSSARM_LENGTH / 2, CROSSARM_THICKNESS / 2, CROSSARM_DEPTH / 2, arm);

  // Insulator stubs, hanging from the arm's underside at the two strand
  // positions. Their *bottom* is `tieY`, which is exactly where the pipeline
  // put the wire -- see `WIRE_ATTACH_FRACTION`.
  for (const sx of [-1, 1]) {
    m.prism(
      sx * STRAND_OFFSET, 0,
      tieY, armY,
      0.05, 0.055,
      6, 1, INSULATOR, false,
    );
  }

  if (kind === TRANSFORMER) {
    // A pole-mount can, hung off one side of the upper shaft. Deliberately on
    // the +X side -- across the street rather than along it -- because that is
    // the side a real one hangs on, the side with no conductors in the way.
    const canY = NOMINAL_HEIGHT - 2.6;
    m.prism(0.34, 0, canY - 0.42, canY + 0.42, 0.3, 0.3, 8, 1, TRANSFORMER_GREY, true);
    // The bracket that carries it. Two triangles' worth of read for twelve, and
    // without it the can floats beside the pole.
    m.box(0.17, canY + 0.3, 0, 0.17, 0.04, 0.05, TRANSFORMER_GREY);
    m.box(0.17, canY - 0.3, 0, 0.17, 0.04, 0.05, TRANSFORMER_GREY);
  }

  return m.build(`pole_${kind}`);
}

// --- Shared assets ------------------------------------------------------------

/**
 * The two pole geometries and the two materials, built once for the whole game.
 *
 * Shared the way `VegetationAssets` and `CarAssets` are, and for the same
 * reason: a material created per tile is a WebGPU pipeline compiled per tile,
 * and pipeline compilation blocks the main thread.
 */
export class PowerAssets {
  private readonly geometries: BufferGeometry[] = [];
  readonly poleMaterial: MeshStandardNodeMaterial;
  readonly wireMaterial: MeshBasicNodeMaterial;
  /** Triangles per pole kind. */
  readonly triangles: number[] = [];

  constructor() {
    for (let k = 0; k < KIND_COUNT; k++) {
      const g = buildPole(k);
      this.geometries.push(g);
      this.triangles.push((g.getIndex()?.count ?? 0) / 3);
    }

    const pole = new MeshStandardNodeMaterial();
    pole.name = 'pole_timber';
    // No `colorNode`, exactly as `cars.ts` and `vegetation.ts` have none:
    // `NodeMaterial` already multiplies the material colour by the geometry
    // `color` attribute and then by `instanceColor`, so timber, crossarm,
    // insulator and per-pole tone jitter arrive through two built-in multiplies
    // and no shader graph at all.
    pole.vertexColors = true;
    pole.color = new Color(1, 1, 1);
    // Rough sawn hardwood. Nothing on a pole is glossy and a specular lobe here
    // would land on eight facets of a cylinder at once, which is the "plastic"
    // read `vegetation.ts` names.
    pole.roughness = 0.95;
    pole.metalness = 0.0;
    // Faceted, like the trees and the cars: this is a polyhedron and
    // smooth-shading a polyhedron makes it read as a melted version of itself.
    pole.flatShading = true;
    this.poleMaterial = pole;

    const wire = new MeshBasicNodeMaterial();
    wire.name = 'power_wire';
    // Unlit -- see the note at the top on why. `MeshBasicNodeMaterial` takes the
    // colour straight to the tone curve, which is the whole point: the wire is a
    // silhouette and a silhouette does not have a light side.
    wire.color = new Color().setRGB(WIRE_COLOUR[0], WIRE_COLOUR[1], WIRE_COLOUR[2]);
    // Both ribbons of the cross are single-sided strips and half of every one of
    // them faces away from any given viewer. Two-sided costs nothing here -- no
    // shadow pass, no depth prepass, 1,800 triangles a tile -- and single-sided
    // would drop half the wire.
    wire.side = DoubleSide;
    this.wireMaterial = wire;
  }

  /** The mesh for one pole kind. The single point where a kind becomes geometry. */
  geometry(kind: number): BufferGeometry {
    return this.geometries[kind] ?? this.geometries[STANDARD];
  }
}

// --- The sidecar --------------------------------------------------------------

/** One tile's poles and spans, decoded from `<key>.power.bin`. */
export interface TilePower {
  poleCount: number;
  /** Tile-local metres, renderer axes. */
  x: Float32Array;
  z: Float32Array;
  /** Absolute metres above the datum -- the terrain under the pole's foot. */
  groundY: Float32Array;
  /** Metres, ground to the top of the shaft. */
  height: Float32Array;
  kind: Uint8Array;
  tiltSeed: Uint8Array;
  wireCount: number;
  /**
   * Span endpoints, six floats each: ax, ay, az, bx, by, bz. X and Z are local
   * to *this* tile and Y is absolute, and one endpoint is routinely outside the
   * tile -- a span belongs to whichever tile holds its midpoint, so it reaches
   * up to half a span over the seam. Nothing here may clamp them.
   */
  wire: Float32Array;
}

/**
 * Decode a `.power.bin`. Returns `null` for anything that is not one, because a
 * tile with no poles must be indistinguishable from a tile whose sidecar is
 * missing -- see `streamer.ts`.
 */
export function decodePower(buffer: ArrayBuffer): TilePower | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const poleCount = view.getUint32(0, true);
  const wireBase = 4 + poleCount * POLE_STRIDE;
  if (buffer.byteLength < wireBase + 4) return null;
  const wireCount = view.getUint32(wireBase, true);
  if (buffer.byteLength < wireBase + 4 + wireCount * WIRE_STRIDE) return null;
  if (poleCount === 0 && wireCount === 0) return null;

  const out: TilePower = {
    poleCount,
    x: new Float32Array(poleCount),
    z: new Float32Array(poleCount),
    groundY: new Float32Array(poleCount),
    height: new Float32Array(poleCount),
    kind: new Uint8Array(poleCount),
    tiltSeed: new Uint8Array(poleCount),
    wireCount,
    wire: new Float32Array(wireCount * 6),
  };
  for (let i = 0; i < poleCount; i++) {
    const o = 4 + i * POLE_STRIDE;
    out.x[i] = view.getFloat32(o, true);
    out.z[i] = view.getFloat32(o + 4, true);
    out.groundY[i] = view.getFloat32(o + 8, true);
    out.height[i] = view.getFloat32(o + 12, true);
    // Clamped rather than trusted: an out-of-range kind would read past the
    // geometry table and take the whole tile out with it.
    out.kind[i] = Math.min(view.getUint8(o + 16), KIND_COUNT - 1);
    out.tiltSeed[i] = view.getUint8(o + 17);
  }
  for (let i = 0; i < wireCount * 6; i++) {
    out.wire[i] = view.getFloat32(wireBase + 4 + i * 4, true);
  }
  return out;
}

// --- Instancing ---------------------------------------------------------------

const _matrix = /*#__PURE__*/ new Matrix4();
const _pivotUp = /*#__PURE__*/ new Matrix4();
const _pivotDown = /*#__PURE__*/ new Matrix4();
const _tilt = /*#__PURE__*/ new Matrix4();
const _yaw = /*#__PURE__*/ new Matrix4();
const _scale = /*#__PURE__*/ new Matrix4();
const _axis = /*#__PURE__*/ new Vector3();
const _quaternion = /*#__PURE__*/ new Quaternion();
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
 * Which way each pole's crossarm points, derived rather than transmitted.
 *
 * A crossarm lies **across** the street, because the conductors run along it --
 * so the arm's axis is the plan-perpendicular of the span leaving the pole, and
 * the spans are already in this file. Sending a heading in the sidecar would be
 * four bytes a pole restating something the wires cannot disagree with.
 *
 * Three sources, in falling order of confidence:
 *
 *   1. A span that starts or ends at this pole. Exact, and it covers every pole
 *      whose chain has a midpoint inside this tile -- the large majority.
 *   2. The nearest other pole within a span's reach. Poles in a chain are strung
 *      out along the street, so the direction to the next one *is* the street.
 *      This is what catches a pole near a tile edge whose spans were both filed
 *      under the neighbouring tile, which is a few per cent of them.
 *   3. A hash. For a genuinely isolated pole -- a surveyed node standing on its
 *      own, with nothing to be parallel to -- where any angle is as right as any
 *      other and the only wrong answer is all of them agreeing.
 *
 * Directions are folded to a *line* rather than a ray (the `dot < 0` flip), so
 * two spans leaving a pole in opposite directions average to the street rather
 * than to zero.
 *
 * Measured over the whole inner ring, as the distance from each insulator tip to
 * the wire end it carries: **p50 3 mm, p90 3.1 cm, p99 16 cm, worst 26 cm**.
 * The 3 mm is the lean's residual at 0.35 m out along the arm and is what a
 * correct answer looks like; 11.2% of poles fall through to source 2, and the
 * tail is almost entirely poles at a *bend* in the way, where two spans leave in
 * genuinely different directions and the arm bisects them -- which is what a real
 * corner pole does, so it is the right answer rather than the error it looks like.
 */
function deriveYaw(data: TilePower, index: number, dirX: Float32Array, dirZ: Float32Array): number {
  const x = dirX[index];
  const z = dirZ[index];
  if (x * x + z * z > 1e-6) {
    // Perpendicular of the run, as a Y rotation: local +X must land on
    // (-z, x) in the (world x, world z) plane, and a Y rotation by t sends
    // local +X to (cos t, -sin t), so t = atan2(-x, -z).
    return Math.atan2(-x, -z);
  }
  return hash(data.tiltSeed[index], index, 7) * Math.PI * 2;
}

/** Accumulate a street direction per pole from the spans and, failing that, the neighbours. */
function poleDirections(data: TilePower): { dirX: Float32Array; dirZ: Float32Array } {
  const n = data.poleCount;
  const dirX = new Float32Array(n);
  const dirZ = new Float32Array(n);
  if (n === 0) return { dirX, dirZ };

  // Source 1: spans. Matched to poles by position, on a quantised key -- both
  // came out of the same float32s in the same file, so this is an equality test
  // with a tolerance rather than a spatial search.
  const key = (x: number, z: number): string => `${Math.round(x * 64)},${Math.round(z * 64)}`;
  const byPosition = new Map<string, number>();
  for (let i = 0; i < n; i++) byPosition.set(key(data.x[i], data.z[i]), i);

  for (let w = 0; w < data.wireCount; w++) {
    const o = w * 6;
    const ax = data.wire[o];
    const az = data.wire[o + 2];
    const bx = data.wire[o + 3];
    const bz = data.wire[o + 5];
    let ex = bx - ax;
    let ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 1e-4) continue;
    ex /= len;
    ez /= len;
    for (const [px, pz, sx, sz] of [
      [ax, az, ex, ez],
      [bx, bz, ex, ez],
    ] as const) {
      const i = byPosition.get(key(px, pz));
      if (i === undefined) continue;
      // Fold to a line: a pole in the middle of a chain has one span arriving
      // and one leaving, and un-folded they would cancel exactly.
      const flip = dirX[i] * sx + dirZ[i] * sz < 0 ? -1 : 1;
      dirX[i] += sx * flip;
      dirZ[i] += sz * flip;
    }
  }

  // Source 2: the nearest other pole, for the ones no span in this tile touched.
  // O(n^2) over at most a couple of hundred poles, once per tile load.
  for (let i = 0; i < n; i++) {
    if (dirX[i] * dirX[i] + dirZ[i] * dirZ[i] > 1e-6) continue;
    let best = -1;
    let bestD = 60 * 60;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = data.x[j] - data.x[i];
      const dz = data.z[j] - data.z[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const dx = data.x[best] - data.x[i];
    const dz = data.z[best] - data.z[i];
    const len = Math.hypot(dx, dz) || 1;
    dirX[i] = dx / len;
    dirZ[i] = dz / len;
  }
  return { dirX, dirZ };
}

/**
 * Build one `InstancedMesh` per pole kind present in a tile.
 *
 * Two meshes rather than the one the budget asked for, and it is forced rather
 * than chosen: a transformer pole is a different *geometry*, and geometry in
 * this engine is shared across every tile in the world -- which is what makes
 * the whole streaming model cheap. Per-instance geometry variation would need a
 * custom instanced attribute living on that shared geometry, which cannot be per
 * tile by definition. So it is the `cars.ts` arrangement, one mesh per kind
 * present, and at 7% transformers the second draw usually carries one or two
 * instances. Two draws a tile is what the trees pay four of.
 *
 * Positions are tile-local, so these are added to the tile's own group and
 * inherit its world translation -- the same arrangement that keeps float32
 * vertex precision constant across the extent for everything else.
 *
 * `groundY` comes out of the sidecar rather than being sampled from the tile's
 * height grid, unlike a tree or a car. A pole is the one instanced object whose
 * foot can be in one tile while its wire is anchored from another, so both ends
 * of that wire have to have been measured against the same ground by the same
 * code -- which is the pipeline's, once, at build time.
 */
export function buildTilePoles(data: TilePower, assets: PowerAssets): InstancedMesh[] {
  if (data.poleCount === 0) return [];
  const { dirX, dirZ } = poleDirections(data);

  const perKind: number[][] = Array.from({ length: KIND_COUNT }, () => []);
  for (let i = 0; i < data.poleCount; i++) perKind[data.kind[i]].push(i);

  const out: InstancedMesh[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    const members = perKind[k];
    if (members.length === 0) continue;

    const mesh = new InstancedMesh(assets.geometry(k), assets.poleMaterial, members.length);
    mesh.name = `poles_${k}`;

    for (let n = 0; n < members.length; n++) {
      const i = members[n];
      const seed = data.tiltSeed[i];
      const sy = data.height[i] / NOMINAL_HEIGHT;

      // The lean, about the conductor tie-off rather than about the foot. Doing
      // it the obvious way -- rotating about the base -- swings the crossarm up
      // to 20 cm sideways, and the wire endpoints in the sidecar know nothing
      // about it, so every wire in the city would end in mid-air beside its
      // insulator. About the tie-off, the *base* moves 20 cm instead, where
      // nothing marks where it was supposed to be, and the pole rises 3 mm.
      const pivot = data.height[i] * WIRE_ATTACH_FRACTION;
      const angle = MAX_TILT * hash(seed, 3);
      const azimuth = hash(seed, 5) * Math.PI * 2;
      _axis.set(Math.cos(azimuth), 0, Math.sin(azimuth));
      _quaternion.setFromAxisAngle(_axis, angle);

      _scale.makeScale(1, sy, 1);
      _pivotDown.makeTranslation(0, -pivot, 0);
      _tilt.makeRotationFromQuaternion(_quaternion);
      _pivotUp.makeTranslation(0, pivot, 0);
      _yaw.makeRotationY(deriveYaw(data, i, dirX, dirZ));

      _matrix.makeTranslation(data.x[i], data.groundY[i], data.z[i]);
      _matrix.multiply(_yaw);
      _matrix.multiply(_pivotUp);
      _matrix.multiply(_tilt);
      _matrix.multiply(_pivotDown);
      _matrix.multiply(_scale);
      mesh.setMatrixAt(n, _matrix);

      // Tonal jitter only, no hue. Two poles differ by how long they have been
      // in the weather, not by being different timbers, and a hue-jittered run
      // reads as a colour bug -- the same argument `cars.ts` makes about paint.
      const t = 0.92 + 0.16 * hash(seed, 11);
      _colour.setRGB(t, t, t);
      mesh.setColorAt(n, _colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Culled with its tile, like every other primitive the streamer loads.
    mesh.frustumCulled = false;
    // Read by `streamer.ts` for disposal, where the geometry is *shared* and
    // must not be released with the tile. Its own flag rather than sharing
    // `userData.cars`, so a future change to either cannot silently free the
    // other's geometry.
    mesh.userData.poles = true;
    out.push(mesh);
  }
  return out;
}

/**
 * Every wire in a tile, as one `BufferGeometry`.
 *
 * One mesh, not one per span: 25 spans is 25 draw calls of 72 triangles each,
 * which is the most expensive possible way to draw 1,800 triangles. Merged, it
 * is one.
 *
 * Returns `null` when the tile owns no spans, which happens on plenty of tiles
 * that do have poles -- a span is filed under the tile containing its midpoint.
 */
export function buildTileWires(data: TilePower, assets: PowerAssets): Mesh | null {
  if (data.wireCount === 0) return null;

  // Two strands, two ribbons each, `WIRE_SEGMENTS + 1` samples of two vertices.
  const perSpanVerts = 2 * 2 * (WIRE_SEGMENTS + 1) * 2;
  const perSpanIndex = 2 * 2 * WIRE_SEGMENTS * 6;
  const position = new Float32Array(data.wireCount * perSpanVerts * 3);
  const index =
    data.wireCount * perSpanVerts > 65535
      ? new Uint32Array(data.wireCount * perSpanIndex)
      : new Uint16Array(data.wireCount * perSpanIndex);

  let vp = 0; // vertex write cursor, in vertices
  let ip = 0; // index write cursor

  for (let w = 0; w < data.wireCount; w++) {
    const o = w * 6;
    const ax = data.wire[o];
    const ay = data.wire[o + 1];
    const az = data.wire[o + 2];
    const bx = data.wire[o + 3];
    const by = data.wire[o + 4];
    const bz = data.wire[o + 5];

    const dx = bx - ax;
    const dz = bz - az;
    const plan = Math.hypot(dx, dz);
    if (plan < 1e-3) continue;
    // The crossarm axis: the plan-perpendicular of the span. Both the strand
    // offsets and the horizontal ribbon's width run along it, which is why
    // nothing about either has to travel in the sidecar.
    const px = -dz / plan;
    const pz = dx / plan;

    // Sag with the square of the span, because a catenary's does: a conductor is
    // strung to a tension, and doubling the span quadruples the sag at constant
    // tension. Clamped at both ends -- a 20 m span with 0.14 m of sag reads as a
    // taut cable rather than a wire, and nothing over 1.2 m stays clear of a
    // truck.
    const ratio = plan / SAG_REFERENCE_SPAN;
    const sag = Math.min(Math.max(SAG_AT_REFERENCE * ratio * ratio, SAG_MIN), SAG_MAX);

    for (const strand of [-1, 1]) {
      const ox = px * STRAND_OFFSET * strand;
      const oz = pz * STRAND_OFFSET * strand;
      // The two ribbons of the cross. The first is horizontal, its width along
      // the crossarm axis; the second is vertical. `(0, 1, 0)` is within 3
      // degrees of the true binormal at the steepest point of the sag, which is
      // a 0.1% error on a 35 mm ribbon.
      for (const [wx, wy, wz] of [
        [px * WIRE_HALF_WIDTH, 0, pz * WIRE_HALF_WIDTH],
        [0, WIRE_HALF_WIDTH, 0],
      ] as const) {
        const first = vp;
        for (let s = 0; s <= WIRE_SEGMENTS; s++) {
          const t = s / WIRE_SEGMENTS;
          const cx = ax + dx * t + ox;
          const cz = az + dz * t + oz;
          // Parabolic sag, zero at both ends and `sag` at mid span.
          const cy = ay + (by - ay) * t - sag * 4 * t * (1 - t);
          position[vp * 3] = cx - wx;
          position[vp * 3 + 1] = cy - wy;
          position[vp * 3 + 2] = cz - wz;
          vp++;
          position[vp * 3] = cx + wx;
          position[vp * 3 + 1] = cy + wy;
          position[vp * 3 + 2] = cz + wz;
          vp++;
        }
        for (let s = 0; s < WIRE_SEGMENTS; s++) {
          const a = first + s * 2;
          index[ip++] = a;
          index[ip++] = a + 1;
          index[ip++] = a + 3;
          index[ip++] = a;
          index[ip++] = a + 3;
          index[ip++] = a + 2;
        }
      }
    }
  }

  // Only reachable if every span in the tile was degenerate in plan, which the
  // pipeline's `MIN_HALF_WIDTH` and pole spacing make impossible -- but an empty
  // geometry is a draw call that draws nothing and a bounding sphere of NaN.
  if (vp === 0) return null;

  const geometry = new BufferGeometry();
  geometry.name = 'wires';
  geometry.setAttribute('position', new BufferAttribute(position.subarray(0, vp * 3), 3));
  geometry.setIndex(new BufferAttribute(index.subarray(0, ip), 1));
  // No normals: the material is unlit and reads none, and a normal buffer here
  // would be 12 bytes a vertex of upload that nothing ever samples.
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, assets.wireMaterial);
  mesh.name = 'wires';
  mesh.frustumCulled = false;
  // Never a caster and never a receiver: a 35 mm ribbon writes a dotted line
  // into a 2048-texel shadow map covering 440 m, which is aliasing rather than a
  // shadow -- and a real wire's shadow at this sun is a grey thread nobody has
  // ever noticed. Read by `applyShadowRole` in `streamer.ts`.
  mesh.userData.noShadow = true;
  // Distinct from `userData.poles`: this geometry is built per tile and *must*
  // be disposed with it, where the poles' is shared and must not be.
  mesh.userData.wires = true;
  return mesh;
}
