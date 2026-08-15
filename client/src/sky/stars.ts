/**
 * The southern sky: five thousand real stars, both Magellanic Clouds, and the
 * Southern Cross in the right place.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CATALOGUE AND NOT NOISE.
 *
 * A procedural star field is four lines of shader and it is wrong in the one way
 * that matters here: **this is Sydney**. The Southern Cross is on the flag, on
 * the coins and tattooed on a non-trivial fraction of the population, and it
 * sits with the Pointers in a specific arrangement that an Australian recognises
 * without looking. Getting it wrong is not "the stars are a bit generic", it is
 * the same class of error as putting the midday sun in the south -- which is
 * what `solar.ts` exists to prevent and what spec 7.1 calls the highest-priority
 * item in the document.
 *
 * So: **the Yale Bright Star Catalogue** (BSC5, Hoffleit & Warren, the standard
 * public bright-star catalogue), cut at visual magnitude 6.0 -- the naked-eye
 * limit at a dark site, which is exactly the right cut for a game whose whole
 * night model is about how much of that limit the city takes away. 5,080 stars,
 * J2000 positions, V magnitudes and B-V colour indices, baked to
 * `client/public/stars.bin` at **45,768 bytes** including the two galaxies.
 *
 * Eight bytes a record, and each field is sized against what the eye can resolve
 * rather than against what a float would give:
 *
 *     u16 right ascension   360/65536 = 20 arcsec   (the moon is 1,800 arcsec)
 *     i16 declination       90/32767  = 10 arcsec
 *     u8  V magnitude       1/16 mag                (1.5% of flux)
 *     i8  B-V index         0.02 mag                (a few kelvin of colour)
 *     u8  soft radius       arcminutes; 0 for a star
 *     u8  padding           keeps the record 8-byte aligned
 *
 * ---------------------------------------------------------------------------
 * THE MAGELLANIC CLOUDS are in the same buffer and are not a special case, which
 * is the nicest thing in this file.
 *
 * They are not in BSC5 -- they are galaxies, not stars -- and the obvious
 * implementation is a second pass with a texture. But the LMC and SMC are
 * *resolved*: what a naked eye sees is a haze of stars too faint to separate. So
 * the bake scatters them as Gaussian clouds of soft points -- 420 and 220 -- in
 * an ellipse matching each galaxy's real centre, extent and position angle, with
 * fluxes that sum to its real integrated magnitude (V 0.9 and V 2.7). Their
 * surface brightness therefore comes out right by construction, and they go
 * through **exactly** the same extinction, moon-wash and skyglow-wash the real
 * stars do, in the same draw call, with no code that knows they exist. Drive out
 * of town on a clear moonless night and they come up with everything else.
 *
 * ---------------------------------------------------------------------------
 * ONE DRAW CALL, and how.
 *
 * WebGPU has no `gl_PointSize` -- the point-list primitive is fixed at one pixel
 * -- so a `Points` object cannot draw a star of any size at all, and three's own
 * answer (`InstancedPointsNodeMaterial`) is a different material stack again. So
 * this is one `InstancedBufferGeometry`: a single quad, 5,720 instances, one
 * `NodeMaterial` with a `vertexNode` that billboards in clip space. One pipeline,
 * one draw, one buffer.
 *
 * The whole sphere is rotated by **one mat4 uniform** rather than per star,
 * because the sky is rigid: sidereal rotation and precession are a rotation of
 * the celestial sphere, so the CPU builds the matrix once a frame and the vertex
 * shader multiplies. That is what keeps the per-star work down to a matrix
 * multiply, a clip-space offset and a magnitude lookup.
 *
 * **Capacity is allocated at construction and never changes**, because the
 * catalogue arrives asynchronously and the pipeline must not be compiled twice.
 * The buffers are sized for `MAX_STARS` up front, the mesh is in the scene before
 * `main.ts`'s scene-wide `compileAsync` runs, and the fetch only fills them in
 * and sets `instanceCount` -- which is a draw parameter and not part of three's
 * render-pipeline cache key. Nothing recompiles when the sky fills with stars.
 *
 * ---------------------------------------------------------------------------
 * CALIBRATED BY EYE, and the brief says why: additive blending in this renderer
 * happens in sRGB rather than in linear, so two sources of equal radiance do not
 * sum to twice the brightness and no amount of radiometry predicts where a star
 * lands. The *ratios* are physical -- flux is `10^(-0.4 m)`, extinction is the
 * same Beer-Lambert against the same Meinel air mass the sun goes through, and
 * the Gaussian is flux-normalised so a soft point and a sharp one of the same
 * magnitude put the same total light on the screen. `STAR_GAIN` and
 * `STAR_ENCODE` are the two numbers that were turned until it looked right, and
 * they are named as such.
 */

import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  cos,
  exp,
  float,
  length,
  max,
  mix,
  modelViewMatrix,
  pow,
  saturate,
  smoothstep,
  time,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NodeMaterial,
  Vector2,
  type Camera,
  type PerspectiveCamera,
} from 'three/webgpu';

import { AIR_MASS_POWER, SUN_EXTINCTION } from './calibration.ts';
import { siderealDegrees } from './lunar.ts';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** `SYDS`, little-endian. Must match the header the bake writes. */
const STAR_MAGIC = 0x53445953;

/**
 * Capacity. The shipped catalogue is 5,720 records; this leaves room to raise
 * the magnitude cut to 6.5 (8,404 stars) without touching the allocation
 * argument in the header. Anything past it is dropped with a warning rather than
 * silently truncated.
 */
export const MAX_STARS = 9000;

/**
 * How far away the sphere is drawn, metres.
 *
 * The camera's far plane is 24,000 and the sky dome is a box of half-extent
 * 22,500, so this has to clear the far plane by enough that no star is clipped
 * at the corner of the frustum where the distance to the plane is shortest.
 * 15,000 is comfortably inside it and comfortably outside anything in the world.
 * Depth is not written and not tested (see the material), so the only thing this
 * number does is stay inside the clip volume.
 */
const SPHERE_RADIUS = 15000;

/**
 * The core size of a star on screen, in pixels of Gaussian sigma.
 *
 * 0.9 rather than something smaller because a star narrower than a pixel
 * *aliases*: it lands entirely inside one pixel or gets split between two as the
 * sky rotates, so the field crawls and flickers with the camera in a way that
 * reads as a rendering fault rather than as twinkling. Just under a pixel of
 * sigma is a two-pixel core, which resamples smoothly.
 */
const STAR_CORE_SIGMA_PX = 0.9;

/** How far the quad extends, in sigmas. 2.8 leaves 0.02% of the flux outside. */
const QUAD_SIGMA = 2.8;

/**
 * The overall level: what a magnitude-zero star peaks at before the encode.
 *
 * **1.0, and the reason it is exactly 1.0 is a bug worth recording.** It was
 * 7.6 -- the value of `2 pi sigma^2` at the core size, put there to undo the
 * flux normalisation. But the normalisation in the vertex shader already
 * multiplies the core's own `2 pi sigma^2` back in, so the two cancelled and
 * every star came out 7.6 times over: **everything brighter than magnitude 2.2
 * clipped at white**, which is Sirius, Canopus, both Pointers, all four of the
 * Cross and about eighty others, all at exactly the same brightness. On screen
 * that is a dense field of identical dots with no constellations in it -- and it
 * reads as "too many stars" rather than as "the bright ones are broken", which
 * is why it survived a first look.
 *
 * At 1.0 the whole scale falls out of `10^(-0.4 m)` and the encode, and the
 * spread is what a sky looks like: Sirius clips (it should -- it is magnitude
 * -1.46 and the brightest star there is), magnitude 1 lands at 147 code values,
 * magnitude 3 at 49, and magnitude 6 at 9, which is right at the edge of visible
 * and is what magnitude 6 means.
 */
const STAR_GAIN = 1.0;

/**
 * The perceptual encode on the star's amplitude.
 *
 * A six-magnitude range is 250:1 in flux, and 250:1 written straight into an
 * additive sRGB blend puts the whole faint half of the catalogue under one code
 * value -- a sky with thirty stars in it. So some compression is needed, and the
 * question is how much.
 *
 * **The first cut used 1/2.2, the full sRGB curve, and it was too much.** It
 * flattened 250:1 to 30:1, which put a magnitude-6 star at 21 code values
 * against a magnitude-0 star's 255 -- and a sky where the faintest star in the
 * catalogue is a *fifth* as bright as Vega is not a night sky, it is a
 * screensaver. The measured look was the giveaway: five hundred stars in frame,
 * all much the same brightness, none of them standing out.
 *
 * 1/1.7 compresses to 70:1 instead: magnitude 6 lands at 9 code values -- right
 * at the edge of visible, which is what magnitude 6 *means* -- magnitude 3 at
 * 47, and the first-magnitude stars still carry the frame. The constellations
 * come back, which is the only test that matters, because a constellation is a
 * pattern of the *bright* stars and it disappears the moment the faint ones are
 * as loud.
 *
 * It is applied to the *amplitude* and after everything physical has been
 * multiplied in and the sky background subtracted, so extinction, the moon and
 * the skyglow all still act on real flux ratios and only the final write is
 * perceptual.
 */
const STAR_ENCODE = 1 / 1.7;

/**
 * Extra gain on the soft points, i.e. the Magellanic Clouds.
 *
 * 1.9, and it is compensating for something specific rather than being a taste
 * knob: the flux normalisation is exact in *linear* light, but the encode above
 * is applied per point and the points then add in sRGB, so N overlapping points
 * sum to far less than the N-times-brighter patch the linear arithmetic
 * predicts. This puts the clouds back where the integrated magnitude says they
 * should be. It is the clearest single example of the brief's warning about
 * additive blending in sRGB, and it is the reason the value is a measurement of
 * the renderer rather than of the sky.
 */
const SOFT_GAIN = 1.9;

/** Twinkle: how strong at one air mass of excess, and how fast. */
const TWINKLE_AMOUNT = 0.42;
const TWINKLE_SPEED = 7.3;

/** A decoded catalogue, ready to upload. */
export interface StarCatalogue {
  count: number;
  /** J2000 mean-equator unit vectors, xyz interleaved: x to the equinox, z to the pole. */
  direction: Float32Array;
  /** V magnitude, B-V index, and soft radius in arcminutes, interleaved. */
  data: Float32Array;
}

/**
 * Decode a `stars.bin`. Returns `null` for anything that is not one, on
 * `decodeFar`'s terms: a missing or malformed catalogue means a sky with no
 * stars, which is a worse night and not a broken game.
 */
export function decodeStars(buffer: ArrayBuffer): StarCatalogue | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== STAR_MAGIC) return null;
  if (view.getUint16(4, true) !== 1) return null;
  const stored = view.getUint16(6, true);
  if (stored === 0 || buffer.byteLength < 8 + stored * 8) return null;
  const count = Math.min(stored, MAX_STARS);
  if (stored > MAX_STARS) {
    console.warn(
      `[sky] stars.bin holds ${stored} records against MAX_STARS ${MAX_STARS}; the tail is dropped. ` +
        `Raise the capacity rather than the magnitude cut.`,
    );
  }

  const direction = new Float32Array(count * 3);
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = 8 + i * 8;
    const ra = (view.getUint16(o, true) / 65536) * 360 * RAD;
    const dec = (view.getInt16(o + 2, true) / 32767) * 90 * RAD;
    const cosDec = Math.cos(dec);
    // The standard equatorial frame: x at the vernal equinox, z at the north
    // celestial pole. The rotation built below takes it from here to the world.
    direction[i * 3] = cosDec * Math.cos(ra);
    direction[i * 3 + 1] = cosDec * Math.sin(ra);
    direction[i * 3 + 2] = Math.sin(dec);
    data[i * 3] = view.getUint8(o + 4) / 16 - 2;
    data[i * 3 + 1] = view.getInt8(o + 5) / 50;
    data[i * 3 + 2] = view.getUint8(o + 6);
  }
  return { count, direction, data };
}

/**
 * The rotation from J2000 mean equatorial coordinates to this renderer's world
 * axes, for an instant and a latitude.
 *
 * Three rotations composed on the CPU once a frame, so the shader does one
 * matrix multiply per star:
 *
 *   1. **Precession**, J2000 to the mean equator of date (IAU 1976). Small --
 *      50 arcsec a year, so 0.36 degrees between J2000 and 2026 -- and included
 *      because it is fifteen lines and because the self-check asserts the
 *      Southern Cross to within a degree, where a third of that budget spent on
 *      an omission nobody would ever find is a bad trade.
 *   2. **Sidereal rotation** about the celestial pole, by the local sidereal
 *      time. This is the one that has a sign trap in it: right ascension
 *      increases *eastward* and hour angle increases *westward*, so the matrix
 *      is a reflection composed with a rotation and its determinant is -1. Get
 *      it wrong and the sky wheels backwards, which is invisible in a still and
 *      obvious in motion.
 *   3. **The horizon transform** for the latitude, into x = east, y = up,
 *      z = south. Its determinant is also -1, so the product is a proper
 *      rotation -- which `verifyStars` checks, because a stray reflection is a
 *      mirrored sky that looks entirely plausible until somebody who knows the
 *      Cross sees it.
 *
 * At latitude -33.87 this puts the **south** celestial pole 33.87 degrees above
 * the southern horizon and turns the sky clockwise as seen from under it, which
 * is the opposite of every northern-hemisphere reference anybody will check
 * against.
 */
export function skyRotation(date: Date, latitude: number, longitude: number, into: Matrix4): Matrix4 {
  // --- Precession, IAU 1976, arcseconds.
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
  const S = (1 / 3600) * RAD;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * S;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * S;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * S;
  const cZ = Math.cos(zeta);
  const sZ = Math.sin(zeta);
  const cT = Math.cos(theta);
  const sT = Math.sin(theta);
  const cZ2 = Math.cos(z);
  const sZ2 = Math.sin(z);
  // P = Rz(-z) Ry(theta) Rz(-zeta), written out because three has no Matrix3
  // multiply chain that is cheaper than nine multiply-adds.
  const p00 = cZ * cT * cZ2 - sZ * sZ2;
  const p01 = -sZ * cT * cZ2 - cZ * sZ2;
  const p02 = -sT * cZ2;
  const p10 = cZ * cT * sZ2 + sZ * cZ2;
  const p11 = -sZ * cT * sZ2 + cZ * cZ2;
  const p12 = -sT * sZ2;
  const p20 = cZ * sT;
  const p21 = -sZ * sT;
  const p22 = cT;

  // --- Sidereal. See the note above on why this is a reflection.
  const lst = (siderealDegrees(date) + longitude) * RAD;
  const cL = Math.cos(lst);
  const sL = Math.sin(lst);
  const q00 = cL;
  const q01 = sL;
  const q10 = sL;
  const q11 = -cL;

  // --- Horizon. Rows are (east, up, south) in terms of (x_HA, y_HA, z_pole).
  const phi = latitude * RAD;
  const cP = Math.cos(phi);
  const sP = Math.sin(phi);

  // W = M_lat . M_lst . P, expanded. M_lst's third row is (0, 0, 1) and its
  // third column is (0, 0, 1), which is what makes this short.
  const m00 = q00 * p00 + q01 * p10;
  const m01 = q00 * p01 + q01 * p11;
  const m02 = q00 * p02 + q01 * p12;
  const m10 = q10 * p00 + q11 * p10;
  const m11 = q10 * p01 + q11 * p11;
  const m12 = q10 * p02 + q11 * p12;
  const m20 = p20;
  const m21 = p21;
  const m22 = p22;

  into.set(
    -m10, -m11, -m12, 0,
    cP * m00 + sP * m20, cP * m01 + sP * m21, cP * m02 + sP * m22, 0,
    sP * m00 - cP * m20, sP * m01 - cP * m21, sP * m02 - cP * m22, 0,
    0, 0, 0, 1,
  );
  return into;
}

/**
 * The star field: one mesh, one draw, one pipeline.
 *
 * Constructed empty-but-allocated and added to the scene immediately, so the
 * boot warm-up compiles it; `adopt` fills it in when the catalogue lands.
 */
export class StarField extends Mesh {
  private readonly rotation4 = new Matrix4();
  private readonly directionAttr: InstancedBufferAttribute;
  private readonly dataAttr: InstancedBufferAttribute;

  private readonly uSkyRotation = uniform(new Matrix4());
  private readonly uViewport = uniform(new Vector2(1920, 1080));
  private readonly uPixelsPerDegree = uniform(20);
  private readonly uVisibility = uniform(0);
  /** The sky background, subtracted from every star's peak. See `NightSkyRig`. */
  private readonly uThreshold = uniform(0);

  /** How many instances actually hold a star. Zero until the catalogue lands. */
  private loaded = 0;

  constructor() {
    const geometry = new InstancedBufferGeometry();
    // One quad, as two triangles. `corner` runs -1..1 so the fragment can read
    // its own radius straight off it, and it is a **plain** BufferAttribute --
    // per vertex, not per instance, which is the distinction three turns into
    // the WebGPU vertex-buffer step mode. Getting it the wrong way round gives
    // one star drawn four times rather than four corners of one star.
    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    geometry.setAttribute('corner', new BufferAttribute(quad, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const direction = new InstancedBufferAttribute(new Float32Array(MAX_STARS * 3), 3);
    const data = new InstancedBufferAttribute(new Float32Array(MAX_STARS * 3), 3);
    // Below the horizon and impossibly faint, so an un-filled instance draws
    // nothing at all on the frames between the pipeline warm-up and the fetch.
    for (let i = 0; i < MAX_STARS; i++) {
      direction.array[i * 3 + 2] = -1;
      data.array[i * 3] = 99;
    }
    geometry.setAttribute('starDirection', direction);
    geometry.setAttribute('starData', data);
    geometry.instanceCount = MAX_STARS;
    // Never culled: the bounding volume of a sphere drawn around the camera is
    // meaningless, and three would compute it from the *instance-zero* quad.
    geometry.boundingSphere = null;

    const material = new NodeMaterial();
    material.name = 'stars';
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    /**
     * **Depth-tested, and it was not, and that is the whole of "for some reason
     * stars are visible thru roofs".**
     *
     * The old pairing was `depthWrite = false, depthTest = false`, with a comment
     * arguing that `renderOrder = -1` put this after the sky dome and before
     * anything else transparent -- which is true, and is *not* what decides
     * whether a roof hides a star. Three sorts the render list into an opaque
     * pass and then a transparent one, and `renderOrder` only orders **within**
     * a pass. A transparent material is therefore always drawn after every
     * opaque triangle in the frame, so with the test off the field is painted
     * over the finished picture: the roof, the awning, the inside of a station
     * concourse, the tunnel lining. Stars through the ceiling, every night.
     *
     * Turning the test on is the whole fix and it costs nothing:
     *
     *   - The sky dome cannot eat them. `SkyMesh` ships `depthWrite = false`, so
     *     the far field is still the cleared depth of 1.0 and this sphere at
     *     15 km is comfortably in front of it. (`main.ts`'s far plane is 24 km,
     *     which is what makes 15 km a real depth rather than a clipped one.)
     *   - Nothing about the *look* moves anywhere the sky is actually visible: a
     *     star only fails the test where geometry is already in front of it, and
     *     where geometry is in front of it the star was wrong.
     *   - `depthWrite` stays **false**. This is still an additive layer and it
     *     must not write; the moon at 14 km is drawn after it and would start
     *     failing a test against stars it is supposed to sit among.
     */
    material.depthTest = true;
    // The dome is not fogged and neither is this, for `sky.ts`'s reason: at
    // 15 km the range fog would resolve to exactly 1 and replace every star with
    // the fog colour.
    material.fog = false;

    super(geometry, material);
    this.directionAttr = direction;
    this.dataAttr = data;
    this.frustumCulled = false;
    // First of the transparents, so the moon and every additive night sprite
    // composite over the field rather than under it. Ordering only: what decides
    // whether a roof hides a star is the depth test above, and confusing the two
    // is what put stars through every ceiling in the game.
    this.renderOrder = -1;

    const altitude = varying(float(0), 'starAltitude');
    const amplitude = varying(float(0), 'starAmplitude');
    const tint = varying(vec3(0), 'starTint');
    const corner = varying(vec2(0), 'starCorner');

    material.vertexNode = Fn(() => {
      const dir: any = attribute('starDirection', 'vec3');
      const info: any = attribute('starData', 'vec3');
      const quad: any = attribute('corner', 'vec2');

      // The whole sphere, rotated at once. See `skyRotation`.
      const world: any = this.uSkyRotation.mul(vec4(dir, 0.0)).xyz.toVar();
      altitude.assign(world.y);

      const view: any = modelViewMatrix.mul(vec4(world.mul(SPHERE_RADIUS), 1.0));
      const clip: any = cameraProjectionMatrix.mul(view).toVar();

      /* Size, in pixels of Gaussian sigma. A sharp star is the core size; a soft
       * point -- a Magellanic Cloud member -- is its own angular radius, which is
       * why the clouds keep their real angular extent as the field of view
       * changes and a star does not. */
      const softPx: any = info.z.div(60.0).mul(this.uPixelsPerDegree);
      const sigma: any = max(float(STAR_CORE_SIGMA_PX), softPx).toVar();

      /* The offset is applied **after** projection and scaled by `w`, which is
       * what makes the size exactly constant in pixels regardless of how far
       * away the sphere is or what the projection is doing. Doing it in view
       * space instead would make stars near the edge of a wide frame larger,
       * which reads as a lens artefact. */
      const half: any = sigma.mul(QUAD_SIGMA);
      clip.assign(
        vec4(
          clip.xy.add(quad.mul(half).mul(2.0).div(this.uViewport).mul(clip.w)),
          clip.zw,
        ),
      );

      /* Flux, extinction and the twinkle, all per star and all in the vertex
       * shader because none of them varies across four pixels. */
      const flux: any = pow(float(10.0), info.x.mul(-0.4));

      // Meinel extinction against the Kasten-Young air mass, exactly as
      // `calibration.solarRig` does it for the sun. Below the horizon the whole
      // star is killed rather than extinguished, because the air mass series
      // has no meaning there.
      const altDeg: any = altitude.mul(DEG).toVar();
      const airMass: any = float(1.0).div(
        max(altitude, 0.0).add(pow(max(altDeg, 0.0).add(3.885), -1.253).mul(0.15)),
      );
      const extinction: any = exp(pow(airMass, AIR_MASS_POWER).sub(1.0).mul(-SUN_EXTINCTION));

      /* Twinkle. Scintillation is a property of the *path*, so it scales with
       * the excess air mass: a star overhead is rock steady and one near the
       * horizon boils. Two incommensurate sines off a per-star phase, which is
       * cheaper than noise and, at four pixels across, indistinguishable from
       * it. The soft points do not twinkle -- a galaxy ten degrees wide averages
       * over so many independent air columns that it cannot. */
      const phase: any = info.y.mul(37.0).add(info.x.mul(11.0)).add(dir.x.mul(53.0));
      const wobble: any = cos(time.mul(TWINKLE_SPEED).add(phase))
        .mul(0.6)
        .add(cos(time.mul(TWINKLE_SPEED * 0.41).add(phase.mul(1.7))).mul(0.4));
      const sharp: any = smoothstep(0.5, 0.0, info.z);
      const twinkle: any = float(1.0).add(
        wobble.mul(TWINKLE_AMOUNT).mul(saturate(airMass.sub(1.0).mul(0.35))).mul(sharp),
      );

      // The flux normalisation: a 2D Gaussian of this sigma integrates to
      // `2 pi sigma^2`, so dividing by it keeps the *total* light of a star
      // constant as its size changes. It is what makes a soft point and a sharp
      // one of the same magnitude physically comparable.
      const peak: any = flux
        .mul(STAR_GAIN)
        .mul(mix(float(1.0), float(SOFT_GAIN), sharp.oneMinus()))
        .div(sigma.mul(sigma).mul(2.0 * Math.PI))
        .mul(float(2.0 * Math.PI * STAR_CORE_SIGMA_PX * STAR_CORE_SIGMA_PX));

      amplitude.assign(peak.mul(extinction).mul(twinkle).mul(this.uVisibility));
      tint.assign(colourFromBv(info.y));
      corner.assign(quad);
      return clip;
    })();

    material.colorNode = Fn(() => {
      const r: any = length(corner);
      // The Gaussian, in units where the quad edge is `QUAD_SIGMA` sigmas.
      const g: any = exp(r.mul(QUAD_SIGMA).pow(2.0).mul(-0.5));
      /* The sky background, **subtracted** rather than multiplied. A star is
       * visible when it stands out from the sky, not when the sky is dim, so a
       * brightening sky takes the faint ones away entirely and leaves the bright
       * ones almost untouched -- and, because the subtraction happens inside the
       * Gaussian, a star near the limit *shrinks* as it goes, which is what a
       * real one does. See `STAR_THRESHOLD_GAIN` in `skyglow.ts`. */
      const lit: any = max(amplitude.mul(g).sub(this.uThreshold), 0.0).mul(
        smoothstep(0.0, 0.01, altitude),
      );
      // The perceptual encode, last, on everything physical. See `STAR_ENCODE`.
      const value: any = pow(saturate(lit), STAR_ENCODE);
      return vec4(tint.mul(value), 1.0);
    })();
    // Additive: the alpha channel is never read, and saying so rather than
    // leaving `opacityNode` at its default keeps three from building an alpha
    // path this material has no use for.
    material.opacityNode = float(1);
  }

  /** Fill the buffers from a decoded catalogue. Does not touch the pipeline. */
  adopt(catalogue: StarCatalogue): void {
    this.directionAttr.array.set(catalogue.direction);
    this.dataAttr.array.set(catalogue.data);
    this.directionAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
    this.loaded = catalogue.count;
    (this.geometry as InstancedBufferGeometry).instanceCount = catalogue.count;
  }

  get starCount(): number {
    return this.loaded;
  }

  /**
   * Point the sphere at the sky for this instant, and set how visible it is.
   *
   * `visibility` is `NightSkyRig.starVisibility` -- the night ramp and the cloud
   * in front of them -- and `threshold` is `NightSkyRig.starThreshold`, the sky
   * background that takes the faint ones away. At a visibility of effectively
   * zero the mesh is hidden outright, which is the common case (every daylight
   * frame, and every heavily overcast one) and skips the draw entirely.
   */
  update(
    date: Date,
    latitude: number,
    longitude: number,
    camera: Camera,
    visibility: number,
    threshold: number,
  ): void {
    this.visible = visibility > 0.002;
    if (!this.visible) return;
    this.position.copy(camera.position);
    skyRotation(date, latitude, longitude, this.rotation4);
    this.uSkyRotation.value.copy(this.rotation4);
    this.uVisibility.value = visibility;
    this.uThreshold.value = threshold;
  }

  /** Tell the field how big the frame is. Called on resize, not per frame. */
  setViewport(widthPx: number, heightPx: number, camera: PerspectiveCamera): void {
    this.uViewport.value.set(widthPx, heightPx);
    // Vertical pixels per degree, which is what an angular size has to be
    // converted through. Taken off the camera's own fov so a zoom keeps the
    // Magellanic Clouds the right size relative to the constellations.
    this.uPixelsPerDegree.value = heightPx / Math.max(camera.fov, 1e-3);
  }
}

/**
 * B-V colour index to a linear RGB tint, normalised so the luminance is roughly
 * constant and the magnitude alone decides brightness.
 *
 * Four control points from blackbody chromaticity at the Ballesteros
 * temperatures -- `T = 4600 (1/(0.92 BV + 1.7) + 1/(0.92 BV + 0.62))` -- which
 * is the standard closed-form B-V to temperature fit:
 *
 *     B-V -0.30   T ~ 22,000 K   Spica, Acrux          blue-white
 *     B-V  0.00   T ~ 10,000 K   Vega, by definition   white
 *     B-V  0.65   T ~  5,700 K   the sun               faintly yellow
 *     B-V  1.60   T ~  3,300 K   Betelgeuse, Antares   orange
 *
 * Deliberately **undersaturated** against the true chromaticities. Real stellar
 * colours are subtle -- the eye sees them at all only for the brightest few, and
 * a field of saturated red and blue points reads as a screensaver. This keeps
 * Antares visibly warmer than Acrux and does not go further.
 */
function colourFromBv(bv: any): any {
  const t: any = saturate(bv.add(0.3).div(1.9));
  const cool: any = mix(vec3(0.72, 0.80, 1.0), vec3(0.94, 0.95, 1.0), saturate(t.div(0.158)));
  const warm: any = mix(
    vec3(0.94, 0.95, 1.0),
    vec3(1.0, 0.82, 0.62),
    saturate(t.sub(0.158).div(0.842)),
  );
  return mix(cool, warm, smoothstep(0.15, 0.17, t));
}

/**
 * Startup self-check. **The failure this file has is that the sky is beautiful
 * and wrong**, which is the hardest kind to notice and the easiest kind to ship.
 *
 * The Southern Cross is the assertion that matters, and it is asserted against
 * the *rendered* direction -- the full chain of decode, precession, sidereal
 * rotation and horizon transform -- rather than against the catalogue entries,
 * because every interesting way this breaks is in that chain and none of them
 * touches the bytes.
 */
export function verifyStars(catalogue: StarCatalogue | null, latitude = -33.87, longitude = 151.21): string[] {
  const failures: string[] = [];
  if (catalogue === null) {
    return ['The star catalogue did not decode; the sky has no stars in it. Check client/public/stars.bin.'];
  }

  // Name, J2000 RA and Dec (degrees), V magnitude. The Cross and the Pointers,
  // plus the two brightest stars in the sky as controls.
  const NAMED: readonly (readonly [string, number, number, number])[] = [
    ['Acrux (alpha Cru)', 186.6496, -63.0991, 1.33],
    ['Mimosa (beta Cru)', 191.9303, -59.6888, 1.25],
    ['Gacrux (gamma Cru)', 187.7915, -57.1132, 1.63],
    ['Imai (delta Cru)', 183.7863, -58.7489, 2.8],
    ['Rigil Kent (alpha Cen)', 219.9021, -60.834, 1.33],
    ['Hadar (beta Cen)', 210.9559, -60.373, 0.61],
    ['Canopus', 95.988, -52.6957, -0.72],
    ['Sirius', 101.2872, -16.7161, -1.46],
  ];

  // --- 1. Every one of them is in the shipped catalogue, at its catalogue
  //        position and its catalogue magnitude. This is the encode.
  for (const [name, ra, dec, mag] of NAMED) {
    let best = -1;
    let bestSep = 1e9;
    for (let i = 0; i < catalogue.count; i++) {
      const sep = separationTo(catalogue, i, ra, dec);
      if (sep < bestSep) {
        bestSep = sep;
        best = i;
      }
    }
    if (bestSep > 0.05) {
      failures.push(
        `${name} is not in stars.bin: the nearest record is ${bestSep.toFixed(3)} degrees away. The ` +
          `Southern Cross and the Pointers are the one thing an Australian checks without being ` +
          `asked, and 20 arcsec is all the RA encoding costs.`,
      );
      continue;
    }
    const got = catalogue.data[best * 3];
    if (Math.abs(got - mag) > 0.1) {
      failures.push(
        `${name} is magnitude ${got.toFixed(2)} in stars.bin against a catalogue ${mag}. The u8 ` +
          `encoding is (m + 2) x 16 and resolves a sixteenth of a magnitude.`,
      );
    }
  }

  /* --- 2. THE ROTATION, against positions computed independently.
   *
   * A known instant -- 2026-06-21 12:00 UTC, which is 22:00 on a winter evening
   * in Sydney -- and the altitude and azimuth of each star worked out from the
   * textbook spherical-trigonometry formulae rather than from the matrix. Two
   * independent derivations of the same fact, which is the only kind of check
   * that can catch a matrix that is self-consistently wrong. */
  const when = new Date('2026-06-21T12:00:00Z');
  const matrix = skyRotation(when, latitude, longitude, new Matrix4());
  const lst = ((siderealDegrees(when) + longitude) % 360 + 360) % 360;
  let worstDirect = 0;
  for (const [name, ra, dec] of NAMED) {
    const i = nearestIndex(catalogue, ra, dec);
    const e = matrix.elements;
    const [dx, dy, dz] = [
      catalogue.direction[i * 3],
      catalogue.direction[i * 3 + 1],
      catalogue.direction[i * 3 + 2],
    ];
    // Three's Matrix4 is column-major in `elements`.
    const wx = e[0] * dx + e[4] * dy + e[8] * dz;
    const wy = e[1] * dx + e[5] * dy + e[9] * dz;
    const wz = e[2] * dx + e[6] * dy + e[10] * dz;

    const ha = (lst - ra) * RAD;
    const d = dec * RAD;
    const phi = latitude * RAD;
    const alt = Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(ha));
    const az = Math.atan2(
      Math.sin(ha),
      Math.cos(ha) * Math.sin(phi) - Math.tan(d) * Math.cos(phi),
    ) + Math.PI;
    const ex = Math.cos(alt) * Math.sin(az);
    const ey = Math.sin(alt);
    const ez = -Math.cos(alt) * Math.cos(az);
    const sep = Math.acos(Math.min(1, Math.max(-1, wx * ex + wy * ey + wz * ez))) * DEG;
    worstDirect = Math.max(worstDirect, sep);
    if (sep > 1) {
      failures.push(
        `${name} lands ${sep.toFixed(2)} degrees from where the spherical-trigonometry formulae put ` +
          `it at ${when.toISOString()}. The matrix in skyRotation is wrong -- and the two ways it goes ` +
          `wrong without looking wrong are a sidereal rotation of the wrong handedness (right ` +
          `ascension runs east, hour angle runs west) and a latitude of the wrong sign, either of ` +
          `which gives a plausible sky that no Australian would recognise.`,
      );
    }
  }

  // --- 3. The matrix is a *proper* rotation. Two determinants of -1 multiply to
  //        +1; if only one of them has been fixed the sky is mirrored, which
  //        leaves every altitude right and every constellation backwards.
  const e = matrix.elements;
  const det =
    e[0] * (e[5] * e[10] - e[6] * e[9]) -
    e[4] * (e[1] * e[10] - e[2] * e[9]) +
    e[8] * (e[1] * e[6] - e[2] * e[5]);
  if (Math.abs(det - 1) > 1e-6) {
    failures.push(
      `The sky rotation has determinant ${det.toFixed(6)}; it must be exactly +1. At -1 the whole ` +
        `celestial sphere is mirrored: every star is at the right altitude, the Cross is the right ` +
        `size, and it is back to front.`,
    );
  }

  // --- 4. THE POLE. At latitude -33.87 the *south* celestial pole must sit
  //        33.87 degrees above the southern horizon, and stay there all night.
  //        This is the check that would have caught a northern-hemisphere sky
  //        wholesale, and it is run at four times of night because a pole that
  //        moves is a rotation about the wrong axis.
  for (const hour of [10, 13, 16, 19]) {
    const t = new Date(Date.UTC(2026, 5, 21, hour));
    const m = skyRotation(t, latitude, longitude, new Matrix4());
    const el = m.elements;
    // The south celestial pole is -z in the equatorial frame.
    const px = -el[8];
    const py = -el[9];
    const pz = -el[10];
    const alt = Math.asin(Math.min(1, Math.max(-1, py))) * DEG;
    const az = ((Math.atan2(px, -pz) * DEG) % 360 + 360) % 360;
    if (Math.abs(alt - Math.abs(latitude)) > 0.6 || Math.abs(az - 180) > 0.6) {
      failures.push(
        `The south celestial pole is at altitude ${alt.toFixed(2)}, azimuth ${az.toFixed(2)} at ` +
          `${t.toISOString()}; it must be ${Math.abs(latitude).toFixed(2)} degrees up, due south ` +
          `(180), and it must not move. The sky turns about the pole and nothing else does.`,
      );
      break;
    }
  }

  // --- 5. THE SKY WHEELS THE RIGHT WAY. Seen from Sydney, looking south, the
  //        stars turn *clockwise* about the pole. This is invisible in any still
  //        image and is the single most-often-inverted thing in a game sky.
  const a = new Matrix4();
  const b = new Matrix4();
  skyRotation(new Date(Date.UTC(2026, 5, 21, 12, 0)), latitude, longitude, a);
  skyRotation(new Date(Date.UTC(2026, 5, 21, 12, 30)), latitude, longitude, b);
  {
    // A star on the eastern horizon must be *higher* half an hour later.
    const i = nearestIndex(catalogue, 186.6496, -63.0991); // Acrux
    const [dx, dy, dz] = [
      catalogue.direction[i * 3],
      catalogue.direction[i * 3 + 1],
      catalogue.direction[i * 3 + 2],
    ];
    const ya = a.elements[1] * dx + a.elements[5] * dy + a.elements[9] * dz;
    const yb = b.elements[1] * dx + b.elements[5] * dy + b.elements[9] * dz;
    // Acrux is west of the meridian at this instant, so it must be setting.
    if (!(yb < ya)) {
      failures.push(
        `Acrux rises rather than sets over the half hour after 2026-06-21T12:00Z, when it is already ` +
          `west of the meridian. The sky is turning the wrong way -- check the sign of the sidereal ` +
          `angle in skyRotation.`,
      );
    }
  }

  // --- 6. The Magellanic Clouds are there, are soft, and are in the far south.
  //        They are the reward for driving out of the city and nothing else in
  //        the file would notice if the bake dropped them.
  for (const [name, ra, dec, extent] of [
    ['Large Magellanic Cloud', 80.894, -69.756, 6.0],
    ['Small Magellanic Cloud', 13.187, -72.829, 3.2],
  ] as const) {
    let n = 0;
    for (let i = 0; i < catalogue.count; i++) {
      if (catalogue.data[i * 3 + 2] > 0 && separationTo(catalogue, i, ra, dec) < extent) n++;
    }
    if (n < 100) {
      failures.push(
        `The ${name} has only ${n} soft points within ${extent} degrees of its centre; the bake ships ` +
          `hundreds. They are what a clear moonless night away from the city is for.`,
      );
    }
  }

  return failures;
}

function separationTo(c: StarCatalogue, i: number, raDeg: number, decDeg: number): number {
  const ra = raDeg * RAD;
  const dec = decDeg * RAD;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);
  const d = c.direction[i * 3] * x + c.direction[i * 3 + 1] * y + c.direction[i * 3 + 2] * z;
  return Math.acos(Math.min(1, Math.max(-1, d))) * DEG;
}

function nearestIndex(c: StarCatalogue, raDeg: number, decDeg: number): number {
  let best = 0;
  let bestSep = 1e9;
  for (let i = 0; i < c.count; i++) {
    const sep = separationTo(c, i, raDeg, decDeg);
    if (sep < bestSep) {
      bestSep = sep;
      best = i;
    }
  }
  return best;
}
