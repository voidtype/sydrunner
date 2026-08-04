/**
 * Analytic sky and sun light, driven by the real solar position.
 *
 * Spec section 7.1: no downloaded HDRI. Almost every HDRI on the market is a
 * northern-hemisphere capture, so it puts the sun in the southern sky and no
 * amount of rotating fixes the way the light wraps. Preetham's analytic model
 * (Three's `SkyMesh`, which is already TSL/WebGPU) takes a sun direction, so
 * feeding it `solar.ts` gives a sky that is correct by construction.
 *
 * Light character the spec asks for: harsh, high contrast, deep shadows, blown
 * highlights, hard blue sky. Not soft, not grey, not European. The numbers that
 * produce it -- sun intensity, its falloff with altitude, the fill level and its
 * colour, and the bounce off the sunlit pavement -- live in `calibration.ts`
 * alongside the arithmetic that justifies them and the self-check that stops
 * them drifting. This file is the plumbing: the dome, the shadow camera, and
 * applying the rig each time the clock moves.
 *
 * Three lights, and the third is the one that is not obvious. The sun and a
 * hemisphere fill model direct beam and skylight, which between them make shade
 * a blue silhouette -- real shade in a street is mostly light that bounced off
 * the sunlit road and the sunlit wall opposite, and that is warm, large, and
 * arrives from a *direction*. `bounce` below is that term.
 */

import {
  Color,
  DirectionalLight,
  Frustum,
  HemisphereLight,
  LinearSRGBColorSpace,
  Matrix4,
  Scene,
  Vector3,
  type Camera,
} from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

import { bounceDirection, solarRig, verifyLightRig } from './calibration.ts';
import { CloudLayer, verifyCloudRig } from './clouds.ts';
import { solarPosition, sydneyTime, type SolarPosition } from './solar.ts';

export interface SkyOptions {
  latitude: number;
  longitude: number;
  /** Half-extent of the shadow-casting volume, metres. */
  shadowRadius?: number;
  shadowMapSize?: number;
}

/**
 * Sydney's atmosphere. Turbidity 2.2 is a clean coastal sky -- the value that
 * produces the hard, saturated blue and the crisp shadow edges that read as
 * Australian. European overcast sits at 6-10 and looks grey and soft.
 *
 * These four were originally chosen blind and have now been evaluated against
 * the calibrated exposure rather than assumed: at 3 pm on 15 February the dome
 * comes out at linear (0.31, 0.97, 2.73) at the zenith and (6.5, 7.9, 8.3) at
 * the horizon, which through Neutral at 0.62 is rgb(114, 166, 249) overhead
 * falling to rgb(238, 250, 254) in the haze band. Hard blue that does not wash
 * to white, over Sydney's pale horizon. Sweeping turbidity across 2.0-3.0 and
 * rayleigh across 1.2-1.45 moves the zenith by under six code values in any
 * channel, so they are kept as they are -- the sky was never the problem.
 */
const TURBIDITY = 2.2;
const RAYLEIGH = 1.35;
const MIE_COEFFICIENT = 0.004;
const MIE_DIRECTIONAL_G = 0.82;

/**
 * Height of the tallest thing the shadow volume is asked to hold, metres.
 *
 * Sydney's tallest massing is Salesforce Tower at 263 m, and the pipeline caps
 * out there because Sydney Tower is a spire the footprint data does not carry.
 * This sets two things: how far up the light-space box has to reach, and where
 * the shadow camera's near plane can sit. 300 leaves headroom without inflating
 * the depth range, which is what `bias` is measured against.
 */
const CASTER_CEILING = 300;

/**
 * How far back the bounce light sits. Only its *direction* matters -- a
 * directional light takes `position - target` and normalises -- so this is
 * arbitrary and is never updated per frame. It is stated rather than left at 1
 * so nothing downstream mistakes the light for being at the origin.
 */
const BOUNCE_DISTANCE = 1000;

export class SydneySky {
  readonly sky: SkyMesh;
  readonly sun: DirectionalLight;
  readonly ambient: HemisphereLight;

  /**
   * Bounce off the sunlit pavement and the sunlit facade opposite: the large
   * warm term a hemisphere fill cannot express, because the hemisphere has no
   * azimuth and this needs one.
   *
   * A second `DirectionalLight` rather than more ambient, for one reason that
   * decides everything: it points *away* from the sun, so `max(0, N.L)` clamps
   * it off every surface the sun can see. That is what let this pass open the
   * shade up by a factor of two without moving the calibrated sunlit values --
   * red brick, sandstone and the footpath do not move at all, and asphalt by
   * three code values. The numbers and the canyon integration that produced them
   * are in `calibration.ts`; this is the plumbing.
   *
   * It costs one extra `N.L` per fragment and nothing else: no shadow map, no
   * depth pass, no second scene traversal.
   */
  readonly bounce: DirectionalLight;

  /**
   * Cumulus and cirrus, composited into the dome's own colour node.
   *
   * Deliberately not a light of any kind. It reads `calibration.ts`'s rig to
   * decide how bright a cloud is and writes nothing back -- no cloud shadows, no
   * change to the sun, the fill or the bounce. See the head of `clouds.ts` for
   * why scattered cumulus at this scale should not cast anyway.
   */
  readonly clouds: CloudLayer;

  /** Half-extent of the shadow volume, metres. Read by the streamer. */
  readonly shadowRadius: number;

  /**
   * The shadow camera's frustum, in world space, refreshed by `update()`.
   *
   * Published because the streamer has to know it. Three renders the shadow map
   * by walking the *same* scene graph the main camera walks, so anything the
   * streamer has hidden -- for any reason, including being behind the player --
   * is skipped by the depth pass too and casts nothing. See `streamer.ts`.
   */
  readonly shadowVolume = new Frustum();

  private readonly latitude: number;
  private readonly longitude: number;
  private readonly sunDistance: number;
  private readonly shadowProjScreen = new Matrix4();
  /** Light-space basis, rebuilt each frame for the texel snap below. */
  private readonly lightRight = new Vector3();
  private readonly lightUp = new Vector3();
  private readonly snapCentre = new Vector3();
  private sunVector = new Vector3();
  private current: SolarPosition;
  private date: Date;

  constructor(scene: Scene, opts: SkyOptions) {
    this.latitude = opts.latitude;
    this.longitude = opts.longitude;
    this.shadowRadius = opts.shadowRadius ?? 220;

    this.sky = new SkyMesh();
    // The sky is a fixed backdrop; scaling it large and disabling frustum
    // culling keeps it behind everything without it ever being clipped away.
    this.sky.scale.setScalar(45000);
    this.sky.frustumCulled = false;
    this.sky.turbidity.value = TURBIDITY;
    this.sky.rayleigh.value = RAYLEIGH;
    this.sky.mieCoefficient.value = MIE_COEFFICIENT;
    this.sky.mieDirectionalG.value = MIE_DIRECTIONAL_G;
    // The dome must not be fogged, and this line is the single biggest thing in
    // this file. `SkyMesh`'s material is a plain `NodeMaterial`, which defaults
    // to `fog = true`, and the WebGPU range fog is `smoothstep(near, far, viewZ)`
    // against the *view-space* position -- which for a box scaled to 45,000 is
    // roughly 22 km, far past any sensible fog far plane. The result is a fog
    // factor of exactly 1 over the entire dome: Preetham is computed, then
    // thrown away, and the sky renders as a flat wash of `scene.fog.color`. That
    // is precisely the "overcast northern-Europe" reading, and no amount of
    // turbidity or exposure tuning could ever have fixed it.
    this.sky.material.fog = false;
    // `SkyMesh` ships with `cloudCoverage` at 0.4 and its procedural layer
    // resolves to about 0.015 of linear radiance against a sky of 0.3 to 8.0,
    // so it reads as dark grey blotches rather than cloud. That measurement now
    // has a cause and a verdict: the layer builds a 0-1.5 reflectance triple and
    // scales it by `vSunE * 0.00002`, which is 0.00998 at the reference sun,
    // where the dome beside it scales a term of order 10-100 by 0.04. It was
    // authored for an exposure regime where the whole sky sits under 1.0. A
    // radiance multiplier would fix the level and leave four other faults that
    // no exposed uniform can reach -- `clouds.ts` documents them. So this stays
    // at zero permanently, and the clouds are composited into this same
    // material's colour node below.
    this.sky.cloudCoverage.value = 0;

    // The clouds go *inside* this material rather than on a second dome, and the
    // fog comment above is the reason. A second mesh needs its own render order,
    // its own depth state and its own `fog = false`, and forgetting the last of
    // those puts the flat wash of `scene.fog.color` straight back over the sky.
    // Wrapping the colour node inherits all three, correct, by construction.
    // `SkyMesh` always assigns `colorNode` in its constructor; the check is here
    // because a null would otherwise surface as an untextured black dome three
    // layers downstream.
    if (this.sky.material.colorNode === null) {
      throw new Error('[sky] SkyMesh built no colorNode; the cloud layer has nothing to composite over.');
    }
    this.clouds = new CloudLayer(this.sky.material.colorNode, this.sky.sunPosition);
    this.sky.material.colorNode = this.clouds.colourNode;
    scene.add(this.sky);

    // Intensity and colour are both a function of solar altitude and are set by
    // the first `applySolar()` below, so constructing at zero is deliberate --
    // it means there is exactly one place in the codebase that decides how
    // bright the sun is, and it is `calibration.ts`.
    this.sun = new DirectionalLight(0xffffff, 0);
    this.sun.castShadow = true;
    // 4096 over a 440 m volume is 10.7 cm per texel. 2048 is 21.5 cm, and at
    // that size a shadow edge five metres from the player is quantised into
    // steps 50 screen pixels across at 1440p -- visible as staircasing on every
    // wall base, which is worse than no shadow. The cost is a 4096 depth pass
    // over the near tiles only (see the casting range in `streamer.ts`), which
    // is a few tens of thousands of triangles; the fill is the expensive half.
    // Left as an option, and `window.sydney.setShadowMapSize()` changes it live,
    // because this is the first number to drop if the iGPU cannot hold frame.
    const size = opts.shadowMapSize ?? 4096;
    this.sun.shadow.mapSize.set(size, size);

    // Where the sun sits relative to the volume, and hence the depth range.
    //
    // The light-space depth of anything inside the box runs from
    // `sunDistance - shadowRadius - CASTER_CEILING` (the top of the tallest
    // tower on the near side) to `sunDistance + shadowRadius` (ground at the far
    // edge). Putting the sun exactly far enough back that the first of those
    // lands on `shadowRadius` gives a near plane that is comfortably positive
    // and a depth range no wider than the geometry needs -- which matters
    // because `bias` below is in normalised depth, so its effect in metres is
    // `bias * (far - near)`.
    //
    // Checked against the real solar track for 15 February: the depth of the
    // box's corners stays inside [220, 960] from about 6 degrees of altitude
    // upward -- [333, 878] at noon, [323, 906] at 3 pm, [422, 949] at 6 pm.
    // Below that it does not, and cannot: as the sun approaches the horizon the
    // ground region the box covers stretches to kilometres along the sun's
    // bearing. Widening `far` to chase it would cost bias precision all day for
    // a few minutes at dusk when the beam is already down to 5% of noon, and
    // the failure is graceful anyway -- ground past the far plane falls outside
    // the shadow map and comes back fully lit rather than wrong.
    this.sunDistance = this.shadowRadius * 2 + CASTER_CEILING;
    const cam = this.sun.shadow.camera;
    cam.near = this.shadowRadius;
    cam.far = this.sunDistance + this.shadowRadius;
    cam.left = -this.shadowRadius;
    cam.right = this.shadowRadius;
    cam.top = this.shadowRadius;
    cam.bottom = -this.shadowRadius;
    cam.updateProjectionMatrix();

    // Bias, and the reason it is two orders of magnitude smaller than it was.
    //
    // Three renders shadow casters back-face-only (`_shadowSide` flips
    // `FrontSide` to `BackSide` for every non-VSM shadow pass), so a sunlit wall
    // is compared against the depth of the *far* side of its own building --
    // metres of margin. On top of that, nothing that receives here also casts:
    // the ground plane and every street surface have `castShadow = false`, so
    // they cannot appear in the depth map and cannot self-shadow. Acne is
    // therefore close to impossible in this scene and peter-panning is the only
    // real failure mode, which flips the usual trade: bias as small as will
    // hold.
    //
    // `bias` is normalised depth over `far - near`, which is 740 m here, so:
    //   -0.00003 * 740 = 2.2 cm along the light ray
    //                  = 2.2 / sin(57 deg) = 2.6 cm of shadow displacement
    // The old -0.0004 over the old 879 m range was 35 cm along the ray and
    // 42 cm of displacement -- a hand's width of daylight under every wall,
    // which is exactly the "shadow detached from the object" tell.
    this.sun.shadow.bias = -0.00003;
    // Along the surface normal instead, so it does not move the shadow's
    // position at all -- 3 cm is under a third of a texel at 4096 and well
    // inside the 3-35 cm reveal depths the facade parallax fakes, so it cannot
    // open a light leak along a window head or a wall base.
    this.sun.shadow.normalBias = 0.03;
    // PCF spread, in texels, and one is enough. The filter takes five Vogel-disk
    // taps over a disc of this radius with hardware 2x2 PCF under each, so the
    // transition comes out about two texels wide: 21 cm at 4096 over a 440 m
    // volume. The sun's disc is 0.53 degrees, so a real penumbra is 0.0093 of
    // the throw distance -- 19 cm at 20 m from the caster. The default is
    // already almost exactly physical. Widening it is how shadows start reading
    // as overcast, and spec 7.1 asks for the opposite.
    //
    // **Inert as `main.ts` currently stands**, and left set rather than deleted.
    // `PCFSoftShadowFilter` locks its spread to the texel grid -- four
    // `textureGather`s over a fixed 3x3 footprint -- and reads nothing from
    // here. It landed the same two texels wide, which is why the swap did not
    // move the look; `main.ts` carries why the swap happened, and this number is
    // what comes back if `PCFShadowMap` ever does.
    this.sun.shadow.radius = 1;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Deliberately weak relative to the sun. The spec wants deep shadows, and a
    // strong hemisphere fill is exactly what makes a scene read as overcast
    // Europe. This is the *skylight* half of shade only -- sky colour on top,
    // a token warm floor underneath for soffits and undersides. The large warm
    // term that makes shade readable is the bounce light below, which has an
    // azimuth and can therefore be kept off the sunlit side; a hemisphere cannot,
    // which is why raising this was the wrong way to solve it. Both halves are
    // driven from `calibration.ts`; the constructor values are placed here only
    // so the light exists before the first `applySolar()`.
    this.ambient = new HemisphereLight(new Color(), new Color(), 0);
    scene.add(this.ambient);

    // The bounce card. Intensity, colour and direction all come from
    // `applySolar()` below, for the same reason the sun's do.
    this.bounce = new DirectionalLight(0xffffff, 0);
    // Never. A bounce is the light that arrives *after* the geometry has had its
    // way with the beam, so occluding it a second time is double-counting -- and
    // it would put a second full-resolution depth pass in the frame, from a
    // direction where the shadow camera's depth range was never solved. Stated
    // rather than left to the default because the shadow rig above is tuned
    // against exactly one caster and a second one would silently share its
    // settings.
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    // 3 pm, mid-February -- the spec's own reference for "looks like Sydney".
    this.date = sydneyTime(2026, 2, 15, 15, 0);
    this.current = solarPosition(this.date, this.latitude, this.longitude);
    this.applySolar();

    // Same philosophy as `verifySouthernHemisphere()`: the failures this project
    // actually suffers are the silent ones. A sun:shade ratio that has drifted
    // out of band throws nothing and costs no frame time -- it just quietly
    // stops looking like Sydney. A warning rather than a fatal, because a
    // mis-calibrated scene is still playable and the exposure stack is a thing
    // people will legitimately experiment with.
    for (const failure of verifyLightRig()) {
      console.warn(`[sky] ${failure}`);
    }
    // Same reasoning, same treatment. A cloud layer that has drifted dark reads
    // as a taste decision rather than as a bug, which is exactly how the one
    // this replaced survived in `SkyMesh` for as long as it did.
    for (const failure of verifyCloudRig()) {
      console.warn(`[sky] ${failure}`);
    }
  }

  /** The instant being rendered. */
  get time(): Date {
    return this.date;
  }

  get solar(): SolarPosition {
    return this.current;
  }

  setTime(date: Date): void {
    this.date = date;
    this.current = solarPosition(date, this.latitude, this.longitude);
    this.applySolar();
  }

  /** Advance the clock by `minutes` of Sydney time. */
  advance(minutes: number): void {
    this.setTime(new Date(this.date.getTime() + minutes * 60_000));
  }

  private applySolar(): void {
    const d = this.current.direction;
    this.sunVector.set(d.x, d.y, d.z);
    this.sky.sunPosition.value.copy(this.sunVector);

    // One pure function decides the whole rig from the sun's altitude, so the
    // renderer and the startup self-check can never disagree about what the
    // numbers are. Intensity now falls off by Beer-Lambert against air mass
    // rather than an invented power curve, so the sun dims and reddens together
    // and actually reaches zero at the horizon.
    const rig = solarRig(this.current.altitude);

    this.sun.intensity = rig.sunIntensity;
    // `setRGB` writes in the *working* colour space, which is linear -- these
    // are radiometric multipliers, not swatches, so the colour space is stated
    // rather than left to a default that a future working-space change would
    // silently invert.
    this.sun.color.setRGB(...rig.sunColour, LinearSRGBColorSpace);

    // Night ramps the fill across civil twilight to a dim blue-grey, so the city
    // silhouette and the lit windows carry the image, per spec section 6.4.
    this.ambient.intensity = rig.hemisphereIntensity;
    this.ambient.color.setRGB(...rig.skyColour, LinearSRGBColorSpace);
    this.ambient.groundColor.setRGB(...rig.groundColour, LinearSRGBColorSpace);

    // The bounce, aimed on the sun's bearing plus 180 at a low altitude. The
    // direction is rebuilt here rather than in `update()` because it depends
    // only on where the sun is, which is exactly what has just changed -- and
    // because a directional light reads `position - target`, so with the target
    // left at the origin this is the whole of placing it.
    //
    // Intensity is `BOUNCE_FRACTION * sunIntensity * sin(altitude)` and needs no
    // night handling: it is a fraction of the beam that landed on the pavement,
    // so it goes to zero exactly when the beam does. `KeyN` at 21:30 gets a rig
    // identical to the one before this light existed.
    const b = bounceDirection(this.current.azimuth);
    this.bounce.position.set(
      b.x * BOUNCE_DISTANCE,
      b.y * BOUNCE_DISTANCE,
      b.z * BOUNCE_DISTANCE,
    );
    this.bounce.intensity = rig.bounceIntensity;
    this.bounce.color.setRGB(...rig.bounceColour, LinearSRGBColorSpace);

    // The clouds, from the same altitude and in the same place, so a cloud lit
    // for 3 pm can never be left over a 6 pm city. This is the only call in this
    // file that touches them: they take the rig and give nothing back.
    this.clouds.setSolarAltitude(this.current.altitude);
  }

  /**
   * Keep the shadow volume centred on the player.
   *
   * A single directional shadow map cannot cover a 30 km city, so it follows the
   * camera and covers the near field where contact shadows are legible; distant
   * geometry relies on the sky's own gradient and aerial perspective. Snapping the
   * centre to texel-sized steps stops the shadow edges shimmering as you walk.
   *
   * 220 m of half-extent is the right size and it is worth stating why, because
   * it looks arbitrary. At 3 pm on 15 February the sun is 57.1 degrees up, so a
   * shadow is 1/tan(57.1) = 0.647 of the caster's height: a 12 m terrace throws
   * 7.8 m, a 20 m warehouse 13 m, a 60 m apartment block 39 m. Everything the
   * player is walking past therefore has its shadow inside a few tens of metres,
   * and the volume only has to be wide enough that the *casters* for the ground
   * you can see are inside it. Doubling the radius to 440 would quarter the
   * texel density for shadows nobody reads at that distance; the far field is
   * carried by aerial perspective, not by contact shadows.
   */
  update(camera: Camera): void {
    // Texel snapping, and it has to be done in the *light's* frame rather than
    // in world XZ, which is what was here before.
    //
    // The shadow map's texel grid is axis-aligned to the shadow camera, and that
    // camera is rotated to face down the sun vector -- at 3 pm, 303 degrees of
    // azimuth. Rounding the centre to a multiple of the texel size along world x
    // and z therefore snaps it to a lattice rotated 57 degrees away from the one
    // that matters, which quantises the movement without ever landing the map on
    // the same texels twice. The edges keep crawling, which is exactly what the
    // snap exists to stop.
    //
    // So: project the centre onto the light's right and up axes, round *those*,
    // and rebuild. The basis is three's own `lookAt` convention -- z away from
    // the target toward the eye, x = up cross z -- so it matches the matrix the
    // shadow camera will build for itself a few lines below.
    const texelWorld = (this.shadowRadius * 2) / this.sun.shadow.mapSize.x;
    this.snapCentre.set(camera.position.x, 0, camera.position.z);
    this.lightRight.set(0, 1, 0).cross(this.sunVector);
    // Degenerate only with the sun exactly overhead, which at latitude 33.87
    // south cannot happen -- 79 degrees at the December solstice is the maximum.
    // Guarded anyway: an unsnapped centre shimmers, a NaN one draws nothing.
    if (this.lightRight.lengthSq() > 1e-6) {
      this.lightRight.normalize();
      this.lightUp.copy(this.sunVector).cross(this.lightRight).normalize();
      const right = Math.round(this.snapCentre.dot(this.lightRight) / texelWorld) * texelWorld;
      const up = Math.round(this.snapCentre.dot(this.lightUp) / texelWorld) * texelWorld;
      // The depth axis is left alone: nothing along it is sampled on a grid.
      const depth = this.snapCentre.dot(this.sunVector);
      this.snapCentre
        .copy(this.lightRight)
        .multiplyScalar(right)
        .addScaledVector(this.lightUp, up)
        .addScaledVector(this.sunVector, depth);
      // The reconstructed centre no longer sits exactly on y = 0, because the
      // light's up axis has a vertical component and rounding along it lifts or
      // drops the point. It is at most half a texel -- 5 cm at 4096 -- against a
      // 440 m box, so it is carried rather than projected back down: flattening
      // it would put the horizontal offset straight back and undo the snap.
    }
    this.sun.target.position.copy(this.snapCentre);
    // Below the horizon the sun vector points down and this would put the light
    // underground, so the height is floored. The horizontal offset is left
    // alone: at night the intensity is zero and nothing is being lit, and a
    // light left roughly where the sun set is a better place to ramp back up
    // from at dawn than one snapped to the zenith.
    this.sun.position.set(
      this.snapCentre.x + this.sunVector.x * this.sunDistance,
      Math.max(this.snapCentre.y + this.sunVector.y * this.sunDistance, 20),
      this.snapCentre.z + this.sunVector.z * this.sunDistance,
    );
    // The ortho volume never changes shape, so its projection matrix is built
    // once in the constructor and rebuilt only by three itself, which fixes the
    // camera's coordinate system to the renderer's on the first material build.
    // Recomputing it here every frame would race that.
    //
    // The world matrix, though, has to be current before the frustum below is
    // read: three's own shadow pass calls `updateMatrices` for itself, but that
    // happens later in the frame than the streamer needs the answer.
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.updateMatrices(this.sun);
    const shadowCamera = this.sun.shadow.camera;
    this.shadowProjScreen.multiplyMatrices(
      shadowCamera.projectionMatrix,
      shadowCamera.matrixWorldInverse,
    );
    this.shadowVolume.setFromProjectionMatrix(
      this.shadowProjScreen,
      shadowCamera.coordinateSystem,
    );

    this.sky.position.set(camera.position.x, 0, camera.position.z);
  }

  /**
   * Whether the shadow map has actually been created and rendered.
   *
   * In the same spirit as `verifySouthernHemisphere()` and `verifyLightRig()`:
   * the failure this rig suffers is silent. Three only builds the shadow node --
   * and therefore only ever allocates the map or runs the depth pass -- while a
   * *visible object with `receiveShadow`* is being drawn under a light with
   * `castShadow`. Get any one of `renderer.shadowMap.enabled`, the light's
   * `castShadow`, or the receivers' flags wrong and there is no error anywhere:
   * the scene just renders with N.L shading and no occlusion, which reads as
   * "the sun is a bit flat" rather than as a bug. This is the one call that
   * distinguishes the two.
   */
  get shadowMapReady(): boolean {
    return this.sun.shadow.map !== null;
  }
}
