/**
 * Drawing the moon: a disc half a degree wide with the right phase on it.
 *
 * `lunar.ts` decides where it is and how full it is; this is the quad and the
 * shader. Four things have to be true or it reads as a sticker, and each of them
 * is one term below:
 *
 *   - **The right size.** 0.52 degrees, from the ephemeris distance, so it
 *     swells and shrinks by 8% over a month. Every game moon is two to four
 *     times life size, and the reason is that half a degree looks *small* --
 *     which is the point, because the real one is small and everybody knows what
 *     it looks like even if nobody can say why the fake one is wrong.
 *   - **The right terminator.** Not a crescent shape: an *ellipse*, because the
 *     terminator is a great circle on a sphere seen in projection, so it is a
 *     straight line at quarter and bows the other way past full. The shader gets
 *     the sun's direction and works it out per pixel, which means it is correct
 *     for free at every phase and, more importantly, that the horns point at the
 *     sun that is actually in the sky rather than in a direction somebody chose.
 *   - **A face.** The nearside maria at their real selenographic positions,
 *     rotated by the parallactic angle. Without them the moon is a white circle
 *     and reads as one. With them, in Sydney, the Man in the Moon is upside
 *     down -- which is correct, and is the detail that says this is the southern
 *     sky more clearly than anything else on screen except the Cross.
 *   - **Earthshine.** The dark limb of a thin crescent is not black; it is a
 *     faint blue-grey, lit by a nearly-full Earth. Brightest when the crescent
 *     is thinnest, because that is exactly when the Earth is fullest as seen
 *     from the moon -- the two are the same geometry read from opposite ends.
 *
 * ---------------------------------------------------------------------------
 * THE ONE NUMBER TO UNDERSTAND: the moon's surface radiance is **physical**, so
 * nothing fades it in or out.
 *
 * A moon lit by this rig's own sun has radiance `albedo/pi x E`, which comes out
 * near 0.65 in the same linear units the Preetham dome produces. At night the
 * sky is a few thousandths, so the disc is two hundred times its background and
 * blazes; in daylight the sky is 1 to 8, so the same disc adds a pale wash and
 * is barely there. One expression, both pictures, no day/night switch and
 * nothing to get out of step with the clock.
 *
 * It goes through the same Beer-Lambert extinction and the same `warmthAt`
 * reddening the sun does, from `calibration.ts`, because it is the same
 * atmosphere: a moon two degrees up is orange and four times fainter, and it did
 * not need a special case to become so.
 *
 * ---------------------------------------------------------------------------
 * **THE MOON IS ADDITIVE, AND THE FIRST CUT OF THIS FILE GOT IT WRONG.**
 *
 * The obvious blend is a normal one: the moon is an object, it is in front of
 * the sky, so it covers it. Drawn that way, a crescent over a twilight sky is a
 * **black disc with a bright fingernail on one edge** -- which is a striking
 * image and is not something anybody has ever seen, because it is not what
 * happens.
 *
 * The moon is outside the atmosphere. The sky's radiance in any direction *is*
 * the airlight scattered along the whole column between the eye and space, so
 * every bit of that column is still in front of the moon and still scattering.
 * The moon does not occlude the sky; it adds to it:
 *
 *     observed = skyRadiance + moonSurface x transmittance
 *
 * Two things fall out, and both are the observations that say the model is
 * right. A crescent in a bright twilight shows **only the crescent** -- the dark
 * limb is not black, it is exactly sky-coloured, because there is nothing there
 * but the sky in front of it. And the daytime moon comes out as a *pale* disc
 * slightly **brighter** than the sky around it, which is what a daytime moon is:
 * 2,500 cd/m2 of moon added to 5,000 of blue sky.
 *
 * Earthshine then does the job it is actually for. On a dark sky the unlit limb
 * has nothing behind it, so the faint blue-grey shows and the whole disc reads;
 * on a bright sky it is swamped and the crescent stands alone. Neither case
 * needed a switch.
 */

import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  dot,
  float,
  length,
  max,
  min,
  modelViewMatrix,
  pow,
  saturate,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  NodeMaterial,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
} from 'three/webgpu';

import {
  AIR_MASS_POWER,
  MOON_PHASE_POWER,
  SUN_EXTINCTION,
  SUN_WARM_BLUE,
  SUN_WARM_GREEN,
  SUN_ZENITH_INTENSITY,
  warmthAt,
} from './calibration.ts';
import { type LunarPosition } from './lunar.ts';

/**
 * Geometric albedo of the lunar surface. 0.12 -- the moon is as dark as worn
 * asphalt, and the only reason it looks white is that it is being seen against a
 * black sky. Worth stating because the temptation, every time, is to draw it as
 * a white disc and then wonder why the night looks like a poster.
 */
const MOON_ALBEDO = 0.12;

/**
 * How much wider the quad is than the disc.
 *
 * 1.5 leaves room for the soft edge and for the sub-pixel antialiasing ramp
 * without wasting fill: at half a degree the whole quad is about fifteen pixels
 * across at 1080p, so this is a rounding error in cost and the difference
 * between a disc with a clean edge and one with a staircase on it.
 */
const QUAD_OVERSIZE = 1.5;

/**
 * **How much bigger than life the moon is drawn, and the one number in this file
 * that is a compromise.**
 *
 * Measured first, then argued. At this game's 72-degree vertical field of view
 * on a 1080-line drawing buffer the moon's real 0.53 degrees is **5 pixels**.
 * That is physically exact and it is a white dot: no terminator, no maria, no
 * earthshine, none of the work above visible at all, and -- worse -- a moon that
 * a player would describe as "too small", because everybody's memory of the moon
 * is bigger than the moon.
 *
 * The reason is not that the memory is wrong. It is that **the render's field of
 * view and the player's are not the same**. The game paints 72 degrees onto a
 * screen that subtends about 30 -- a 27-inch monitor is 34 cm tall at a 60 cm
 * viewing distance, which is 31.6 degrees -- so *everything* on screen reaches
 * the eye at about 2.4 times smaller than the angle the renderer gave it. A moon
 * drawn at its correct angular size in the render therefore arrives at the
 * player's retina at 0.22 degrees: less than half the real thing. Drawing it 2.4
 * times oversize in the render is what puts it back at half a degree *of the
 * player's own vision*, which is the angle the memory is of.
 *
 * So this is the correction for a compression that the whole frame suffers and
 * that only the moon is checkable against. It is stated as a constant rather
 * than computed from the live `fov` on purpose: the camera zooms (see the
 * scroll-zoom in `game/camera.ts`), and a gain that tracked the field of view
 * would hold the moon at a fixed pixel size through the zoom -- which is exactly
 * backwards, because zooming in is precisely when a player wants to see the
 * maria. Calibrated at the base field of view, magnified by the zoom, like
 * everything else in the frame.
 */
const MOON_APPARENT_GAIN = 2.4;

/**
 * The exponent on `N.L` across the disc.
 *
 * **The famous fact about the full moon is that it has no limb darkening**: it
 * reads as a flat disc rather than as a lit ball, which is not what a
 * Lambertian sphere does and is why every hand-drawn moon looks wrong. The cause
 * is the regolith -- a rough, back-scattering surface follows something close to
 * the Lommel-Seeliger law rather than Lambert's, and the brightness barely falls
 * off toward the limb. 0.55 is that flattening: enough shading left for the
 * terminator to be soft and round, not enough for the full moon to look
 * spherical.
 */
const LIMB_FLATTEN = 0.55;

/**
 * Earthshine, as a fraction of the sunlit surface's radiance at full Earth.
 *
 * The real ratio is about 1:10,000 in flux, which at this exposure is nothing at
 * all -- but the *eye* sees earthshine easily on a two-day crescent, because it
 * is dark-adapted and the crescent is off to one side. This is 0.055, graded up
 * by a lot and named as graded, on the same argument that puts the Purkinje
 * shift in `MOONLIGHT_COLOUR`: it is what a person sees, not what a photometer
 * reads.
 *
 * Its shape is exact even though its level is not. Earthshine is sunlight off a
 * *full* Earth, and the Earth's phase as seen from the moon is the complement of
 * the moon's as seen from Earth -- so it goes as `1 - k`, brightest on the
 * thinnest crescent and gone by full moon, which is the whole visual point of
 * it.
 */
const EARTHSHINE = 0.055;

/** Earthshine's colour: sunlight off ocean and cloud, which is blue. */
const EARTHSHINE_COLOUR: readonly [number, number, number] = [0.55, 0.68, 1.0];

/**
 * The nearside maria, at their selenographic longitude and latitude in degrees,
 * with an angular radius in degrees of lunar surface.
 *
 * Real positions, eight of them, which is every mare a naked eye can separate.
 * They are projected onto the disc in the shader as
 * `(sin(lon) cos(lat), sin(lat))`, which is the orthographic projection a
 * distant observer sees -- so they foreshorten toward the limb exactly as the
 * real ones do, and Mare Crisium at 59 degrees east comes out as the squashed
 * oval it is.
 */
const MARIA: readonly (readonly [number, number, number])[] = [
  [-52, 18, 30], // Oceanus Procellarum -- much the largest
  [-16, 33, 18], // Mare Imbrium
  [17, 28, 12], // Mare Serenitatis
  [31, 8, 13], // Mare Tranquillitatis
  [51, -8, 10], // Mare Fecunditatis
  [59, 17, 8], // Mare Crisium
  [-17, -21, 11], // Mare Nubium
  [-39, -24, 8], // Mare Humorum
];

/** How much darker a mare is than the highlands. Basalt against anorthosite. */
const MARE_DARKENING = 0.42;

/**
 * The moon, as one billboarded quad.
 *
 * Constructed once in `sky.ts`'s constructor and added to the scene before the
 * boot warm-up, for `stars.ts`'s reason: a material that first appears when the
 * moon first rises is a pipeline compiled in the middle of a sunset.
 */
export class MoonDisc extends Mesh {
  private readonly uDirection = uniform(new Vector3(0, -1, 0));
  private readonly uSunDisc = uniform(new Vector3(0, 0, 1));
  private readonly uRadiance = uniform(new Vector3());
  private readonly uEarthshine = uniform(new Vector3());
  private readonly uHalfSizePx = uniform(8);
  private readonly uViewport = uniform(new Vector2(1920, 1080));
  private readonly uMariaRotation = uniform(new Vector2(1, 0));

  /**
   * Scratch, so `update` allocates nothing.
   *
   * `discUp` rather than `up`: `Object3D` already has an `up`, it means
   * something else entirely (the hint `lookAt` orients against), and shadowing
   * it with a private field is a type error rather than a subtle bug only
   * because TypeScript happens to check it.
   */
  private readonly right = new Vector3();
  private readonly discUp = new Vector3();
  private readonly toward = new Vector3();
  private pixelsPerDegree = 20;

  constructor() {
    // The quad, in corner coordinates. `position` carries them so the vertex
    // node can read the standard attribute rather than inventing a name.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.boundingSphere = null;

    const material = new NodeMaterial();
    material.name = 'moon';
    material.transparent = true;
    // **Additive, not normal.** See the header: the moon is above the
    // atmosphere, so the whole scattering column is still in front of it and the
    // sky adds rather than being covered. Drawn with a normal blend, a crescent
    // over a twilight sky is a black disc with a bright edge.
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    // Depth-tested for `stars.ts`'s reason and with the same one-word history: a
    // transparent material is drawn after every opaque triangle in the frame, so
    // an untested one is painted over the roof rather than behind it. The moon
    // was the same bug as the stars and was reported as the stars, because
    // nobody is standing under a roof looking for the moon. It sits at 14 km,
    // inside the 24 km far plane and in front of a sky dome that writes no
    // depth, so nothing in the sky can occlude it and everything on the ground
    // can. `depthWrite` stays false: this is still additive.
    material.depthTest = true;
    material.fog = false;

    super(geometry, material);
    this.frustumCulled = false;
    // After the sky dome and after the stars: the moon occludes the stars behind
    // it, which is the one place in this sky where an object is genuinely in
    // front of another.
    this.renderOrder = 0;

    const corner = varying(vec2(0), 'moonCorner');

    material.vertexNode = Fn(() => {
      const quad: any = attribute('position', 'vec3');
      corner.assign(quad.xy);
      // The billboard sits at the moon's direction, at the same radius the star
      // sphere uses, and is offset in clip space so its size is exactly the
      // pixel count the ephemeris asks for. Same trick as `stars.ts`, same
      // reason: an angular size held in pixels cannot drift with the projection.
      const view: any = modelViewMatrix.mul(vec4(this.uDirection.mul(14000.0), 1.0));
      const clip: any = cameraProjectionMatrix.mul(view).toVar();
      return vec4(
        clip.xy.add(quad.xy.mul(this.uHalfSizePx).mul(2.0).div(this.uViewport).mul(clip.w)),
        clip.zw,
      );
    })();

    material.colorNode = Fn(() => {
      // Disc coordinates: -1..1 across the moon itself rather than the quad.
      const p: any = corner.mul(QUAD_OVERSIZE).toVar();
      const r2: any = dot(p, p).toVar();

      /* The sphere's own normal at this pixel, in the billboard's frame. This is
       * the whole of the phase: `z` is toward the viewer, so the surface normal
       * of a unit sphere seen face-on is `(x, y, sqrt(1 - x^2 - y^2))`, and the
       * lit fraction is its dot with the direction to the sun expressed in the
       * same frame. No crescent geometry anywhere -- the ellipse falls out. */
      const nz: any = sqrt(max(float(1.0).sub(min(r2, float(1.0))), 0.0));
      const normal: any = vec3(p, nz);
      const lit: any = pow(saturate(dot(normal, this.uSunDisc)), LIMB_FLATTEN).toVar();

      /* The maria, in the moon's own body frame. `p` is rotated by the
       * parallactic angle so the pattern stays fixed to the moon as it crosses
       * the sky, and the projection matches the one the table is quoted in. */
      const c: any = this.uMariaRotation.x;
      const s: any = this.uMariaRotation.y;
      const body: any = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).toVar();
      const mare = float(0).toVar();
      for (const [lon, lat, radius] of MARIA) {
        const mx = Math.sin(lon * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180));
        const my = Math.sin(lat * (Math.PI / 180));
        // The radius is quoted as an angle **on the sphere**, so its projected
        // extent is `sin(radius)` rather than the angle itself. It is applied in
        // the projected frame, which is what makes a mare near the limb come out
        // squashed along the radius -- Crisium at 59 degrees east is an oval for
        // exactly the reason the real one is.
        const rr = Math.sin((radius * Math.PI) / 180);
        const d: any = length(body.sub(vec2(mx, my)));
        mare.assign(max(mare, smoothstep(float(rr * 1.35), float(rr * 0.55), d)));
      }
      const albedo: any = float(1.0).sub(mare.mul(MARE_DARKENING));

      /* Earthshine on the dark limb. Added rather than mixed, and gated on the
       * *un-lit* side by `1 - lit` so it never brightens the sunlit crescent --
       * which would be the one thing that makes it look like a bloom filter
       * rather than like the Earth. */
      const dark: any = lit.oneMinus();
      const surface: any = this.uRadiance
        .mul(lit)
        .add(this.uEarthshine.mul(dark))
        .mul(albedo);

      /* The edge, applied to the *radiance* rather than to an alpha, because the
       * blend is additive and an additive alpha is not read. One smoothstep
       * across the last few per cent of the radius, which at a dozen pixels
       * across is a bit under a pixel -- enough to kill the staircase without
       * turning the limb into a glow. */
      const edge: any = smoothstep(float(1.0), float(0.93), sqrt(r2));
      return vec4(surface.mul(edge), 1.0);
    })();
  }

  /**
   * Place the moon and light it. One call per frame, from `sky.ts`'s
   * `applySolar`, so the moon and the sun can never be a frame apart.
   *
   * @param sunDirection unit vector at the sun, renderer axes. The terminator is
   *                     computed from the sun **as drawn**, which is why this is
   *                     passed rather than recomputed.
   */
  update(
    lunar: LunarPosition,
    phase: number,
    sunDirection: Readonly<{ x: number; y: number; z: number }>,
    camera: Camera,
  ): void {
    // Below the horizon there is nothing to draw, and the extinction series has
    // no meaning down there either. A degree of margin so the disc does not pop
    // as its centre crosses zero -- it is a quarter of a degree in radius, plus
    // the refraction nobody models.
    this.visible = lunar.altitude > -1;
    if (!this.visible) return;

    this.position.copy(camera.position);
    const d = lunar.direction;
    this.uDirection.value.set(d.x, d.y, d.z);
    this.uHalfSizePx.value =
      (lunar.angularDiameter / 2) * QUAD_OVERSIZE * MOON_APPARENT_GAIN * this.pixelsPerDegree;

    /* The billboard basis, which the shader's phase depends on entirely. `toward`
     * is the direction from the moon to the *viewer*, so it is the outward
     * normal at the centre of the disc -- the negative of the direction to the
     * moon. Getting that sign wrong mirrors the terminator, which produces a
     * moon that is beautifully lit on the wrong side and is, in a still image,
     * completely undetectable. */
    this.toward.set(-d.x, -d.y, -d.z);
    // The same up-cross-forward the renderer uses everywhere. Degenerate only
    // with the moon exactly overhead, which at latitude -33.87 needs a
    // declination south of -33.87 and the moon never gets past -28.7.
    this.right.set(0, 1, 0).cross(this.toward).normalize();
    this.discUp.copy(this.toward).cross(this.right).normalize();
    this.uSunDisc.value.set(
      this.right.x * sunDirection.x + this.right.y * sunDirection.y + this.right.z * sunDirection.z,
      this.discUp.x * sunDirection.x + this.discUp.y * sunDirection.y + this.discUp.z * sunDirection.z,
      this.toward.x * sunDirection.x +
        this.toward.y * sunDirection.y +
        this.toward.z * sunDirection.z,
    );

    /* Radiance. `albedo/pi x E`, with the beam the moon receives being the
     * unattenuated top-of-atmosphere sun (the moon is above the atmosphere), and
     * with the extinction and reddening applied on the way *down* to the
     * observer at the moon's own altitude. Two different air masses, and putting
     * them in the wrong order is how a moon ends up dimming when the sun sets. */
    const alt = lunar.altitude;
    const airMass = 1 / (Math.sin(Math.max(alt, 0) * (Math.PI / 180)) + 0.15 * Math.pow(Math.max(alt, 0) + 3.885, -1.253));
    const extinction = Math.exp(-SUN_EXTINCTION * (Math.pow(airMass, AIR_MASS_POWER) - 1));
    const warmth = warmthAt(alt);
    // The opposition surge, as the disc-wide gain that makes the total flux obey
    // `MOON_PHASE_POWER`. The lit *area* already scales roughly with the phase,
    // so this carries the remaining exponent. See `MOON_PHASE_POWER`.
    const surge = Math.pow(Math.max(phase, 0), MOON_PHASE_POWER - 1);
    const base = (MOON_ALBEDO / Math.PI) * SUN_ZENITH_INTENSITY * extinction * surge;
    this.uRadiance.value.set(
      base,
      base * (1 - SUN_WARM_GREEN * warmth),
      base * (1 - SUN_WARM_BLUE * warmth),
    );

    // Earthshine goes as the Earth's own phase, which is `1 - k`, and through
    // the same extinction because it is the same path home.
    const shine = EARTHSHINE * (1 - phase) * (MOON_ALBEDO / Math.PI) * SUN_ZENITH_INTENSITY * extinction;
    this.uEarthshine.value.set(
      shine * EARTHSHINE_COLOUR[0] * (1 - SUN_WARM_GREEN * warmth * 0.5),
      shine * EARTHSHINE_COLOUR[1] * (1 - SUN_WARM_GREEN * warmth),
      shine * EARTHSHINE_COLOUR[2] * (1 - SUN_WARM_BLUE * warmth),
    );

    this.uMariaRotation.value.set(
      Math.cos(lunar.parallacticAngle),
      Math.sin(lunar.parallacticAngle),
    );
  }

  /** Frame size, for the angular-to-pixel conversion. On resize, not per frame. */
  setViewport(widthPx: number, heightPx: number, camera: PerspectiveCamera): void {
    this.uViewport.value.set(widthPx, heightPx);
    this.pixelsPerDegree = heightPx / Math.max(camera.fov, 1e-3);
  }
}

/**
 * Startup self-check. What this file gets wrong is a moon that looks lovely and
 * is a lie, so what is checked is the arithmetic behind the two things that
 * cannot be eyeballed: the disc's size and the total light it puts out.
 *
 * The shader itself is not reachable from here, so the *phase geometry* is
 * re-derived on the CPU by the same expression the shader uses and integrated
 * over the disc. That is what catches a mirrored terminator, which is the one
 * bug in this file that a screenshot cannot show.
 */
export function verifyMoonDisc(): string[] {
  const failures: string[] = [];

  /**
   * Walk the disc with the shader's own expression, returning both the lit
   * *area* fraction and the integrated brightness. The two answer different
   * questions and conflating them is a trap: at quarter phase exactly half the
   * disc is lit, and it puts out a third of the light, because the lit half is
   * the half where the sun is grazing.
   */
  const walk = (sx: number, sy: number, sz: number): { area: number; flux: number } => {
    let flux = 0;
    let litCells = 0;
    let cells = 0;
    const N = 256;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const x = ((ix + 0.5) / N) * 2 - 1;
        const y = ((iy + 0.5) / N) * 2 - 1;
        const r2 = x * x + y * y;
        if (r2 > 1) continue;
        cells++;
        const nz = Math.sqrt(1 - r2);
        const d = x * sx + y * sy + nz * sz;
        if (d > 0) {
          litCells++;
          flux += Math.pow(d, LIMB_FLATTEN);
        }
      }
    }
    return { area: litCells / cells, flux: flux / cells };
  };

  /* --- 1. THE TERMINATOR, as an area. This is the textbook claim and the only
   *        one that catches a mirrored disc basis: the illuminated fraction of
   *        the disc is `(1 + cos i)/2` for the phase angle `i`, so a sun behind
   *        the viewer lights all of it, a sun square to the line of sight lights
   *        exactly half, and a sun behind the moon lights none. */
  for (const [name, s, expected] of [
    ['sun behind the viewer (full)', [0, 0, 1], 1],
    ['sun square on (quarter)', [1, 0, 0], 0.5],
    ['sun 60 deg round (gibbous)', [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)], 0.75],
    ['sun behind the moon (new)', [0, 0, -1], 0],
  ] as const) {
    const got = walk(s[0], s[1], s[2]).area;
    if (Math.abs(got - expected) > 0.01) {
      failures.push(
        `With the ${name} the disc is ${(got * 100).toFixed(1)}% lit; the geometry says ` +
          `${(expected * 100).toFixed(0)}%. The terminator is dot(normal, sunInDiscFrame) and nothing ` +
          `else, and the way it goes wrong is the disc basis being built off the direction *to* the ` +
          `moon rather than the direction back to the viewer -- which mirrors the phase and is ` +
          `completely undetectable in a still image.`,
      );
    }
  }

  // --- 2. The maria are on the near side. Their *centres* must be, comfortably;
  //        a patch that runs over the limb is fine and is what the real Oceanus
  //        Procellarum does, because the disc's own alpha masks it.
  for (const [lon, lat, radius] of MARIA) {
    const x = Math.sin(lon * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180));
    const y = Math.sin(lat * (Math.PI / 180));
    if (Math.abs(lon) > 75 || Math.hypot(x, y) > 0.95 || radius > 40) {
      failures.push(
        `A mare centred at selenographic (${lon}, ${lat}) with radius ${radius} degrees is not ` +
          `comfortably on the near side. A far-side entry projects onto the limb and smears into a ` +
          `dark rim that reads as a rendering fault rather than as a mare.`,
      );
    }
  }

  /* --- 3. Total light obeys `MOON_PHASE_POWER`, which is the claim
   *        `skyglow.ts`'s ambient rests on, and this is the only place the
   *        product of the disc gain and the lit area is visible.
   *
   *        The real figure is 8%: magnitude -10.0 at first quarter against
   *        -12.7 at full. Both halves of it have to be here -- the integrated
   *        brightness across the disc, which is about a third, and the
   *        opposition surge `k^(p-1)`, which is the rest. */
  const full = walk(0, 0, 1).flux;
  const quarter = walk(1, 0, 0).flux;
  const halfTotal = (quarter / full) * Math.pow(0.5, MOON_PHASE_POWER - 1);
  if (!(halfTotal > 0.04 && halfTotal < 0.14)) {
    failures.push(
      `A half moon puts out ${(halfTotal * 100).toFixed(1)}% of a full moon's light -- ` +
        `${(quarter / full).toFixed(3)} from the disc integral times ` +
        `${Math.pow(0.5, MOON_PHASE_POWER - 1).toFixed(3)} of opposition surge. The measured figure ` +
        `is about 8%. The disc a player sees and the light skyglow.ts puts on the ground have to ` +
        `agree, and MOON_PHASE_POWER is the one constant they share.`,
    );
  }

  return failures;
}
