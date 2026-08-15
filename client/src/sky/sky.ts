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
  Fog,
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
import {
  CYCLE_EPOCH_MS,
  CYCLE_MS,
  DAY_LENGTH_MS,
  DAY_SHARE,
  LUNAR_PERIOD_CYCLES,
  SYDNEY_LATITUDE,
  SYDNEY_LONGITUDE,
  cyclePhase,
  skyClock,
  verifyCycle,
  type SkyClock,
} from './cycle.ts';
import { DuskGrade, duskRig, verifyDuskRig } from './dusk.ts';
import { verifyLunar } from './lunar.ts';
import { MoonDisc, verifyMoonDisc } from './moon.ts';
import {
  NightGlow,
  UrbanField,
  cloudCover,
  nightSkyRig,
  verifySkyglow,
  type NightSkyRig,
} from './skyglow.ts';
import { StarField, decodeStars, verifyStars, type StarCatalogue } from './stars.ts';
import { type SolarPosition } from './solar.ts';

export interface SkyOptions {
  latitude: number;
  longitude: number;
  /** Half-extent of the shadow-casting volume, metres. */
  shadowRadius?: number;
  shadowMapSize?: number;
}

/**
 * The clock's default step for `advance()`, in **game** minutes.
 *
 * The debug scrub is expressed in game minutes because that is what a developer
 * means by "half an hour later", and it is converted here rather than in
 * `cycle.ts` because the conversion is not exact: the cycle's rate varies with
 * the dwell, so half an hour of Sydney is 75 real seconds in the middle of the
 * day and 150 at the horizon. The average rate is used, so one call moves
 * *about* half an hour and always the same amount of real time -- which is the
 * property that keeps the scrub composable (see `skyClock`'s contract).
 */
const SCRUB_MS_PER_GAME_MINUTE = (DAY_SHARE * CYCLE_MS * 60_000) / DAY_LENGTH_MS;

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

  /**
   * The twilight grade, composited **under** the clouds.
   *
   * `SkyMesh` is a daylight model and goes to black 2.3 degrees below the
   * horizon; this is the horizon burn, the anti-twilight arch and the zenith
   * wash that a real dusk has and Preetham does not. See `dusk.ts` for the
   * measurement and for why it must never become a material variant.
   *
   * The ordering is load-bearing: the dome's node goes through this and the
   * result is handed to `CloudLayer`, so the clouds composite over an already
   * burning sky and read as silhouettes against it. Wrapping the other way round
   * -- grading the composited result -- would put the glow *on* the clouds and
   * is the difference between a sunset with clouds in it and a sunset with
   * clouds painted on top.
   */
  readonly dusk: DuskGrade;

  /**
   * The night sky's own light -- skyglow and scattered moonlight -- composited
   * **between** the twilight grade and the clouds.
   *
   * The ordering is the same argument `dusk` makes one paragraph up, run again
   * for the night: the clouds have to composite over an already-glowing sky, so
   * that an overcast urban night reads as a lid lit from below rather than as
   * grey shapes over an orange wash. Same material, same single node graph, no
   * night-only variant to be compiled the frame the sun goes down.
   */
  readonly nightGlow: NightGlow;

  /**
   * Five thousand real stars and both Magellanic Clouds, in one draw.
   *
   * Added to the scene in this constructor with its buffers already allocated,
   * so `main.ts`'s scene-wide `compileAsync` reaches it -- the catalogue arrives
   * over the network some milliseconds later and only fills the buffers in. See
   * the capacity note in `stars.ts`.
   */
  readonly stars: StarField;

  /** The moon: one billboarded quad, real ephemeris, real phase. */
  readonly moon: MoonDisc;

  /**
   * Moonlight, as a third `DirectionalLight`.
   *
   * **It exists from the constructor and is never added or removed**, because
   * three's WebGPU lights node is built from the lights that are in the scene
   * when a material first compiles: adding a light at moonrise would rebuild the
   * node graph and recompile *every material in the world*, which is the single
   * most expensive thing this project knows how to do by accident. At intensity
   * zero it costs one clamped `N.L` per fragment, which is the same price the
   * bounce light has always paid.
   *
   * `castShadow` is false and must stay false -- see `MOON_LIGHT_INTENSITY`.
   */
  readonly moonLight: DirectionalLight;

  /** The baked urban-density field. See `skyglow.ts` for why it is baked. */
  readonly urban = new UrbanField();

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

  private readonly sunDistance: number;
  private readonly shadowProjScreen = new Matrix4();
  /** Light-space basis, rebuilt each frame for the texel snap below. */
  private readonly lightRight = new Vector3();
  private readonly lightUp = new Vector3();
  private readonly snapCentre = new Vector3();
  private sunVector = new Vector3();
  private clock: SkyClock;

  /**
   * The scene, kept so `applySolar` can colour the fog.
   *
   * `scene.fog` is created by `main.ts` *after* this constructor runs, so it is
   * read lazily rather than captured -- see `applySolar`. Aerial perspective
   * stands in for the sky behind the thing it is fading, which is exactly why it
   * cannot be a constant once the sky changes colour: a pale blue haze over a
   * burning horizon reads as a bug in the renderer rather than as distance.
   */
  private readonly scene: Scene;

  /**
   * **How far this machine's wall clock is from the server's**, milliseconds,
   * as `serverNow - localNow`.
   *
   * Written once by `setServerClock` when `WELCOME` lands, and thereafter the
   * only difference between what this client thinks the time of day is and what
   * the host does. Zero offline, which is not a fallback so much as the honest
   * answer: with nobody to ask, this machine's clock is the best clock there is,
   * and it is exactly what the cycle ran on before the server owned it.
   *
   * **This is not the scrub and the two must not be merged.** They are added
   * together at every read and both are milliseconds on the same clock, so
   * merging them would work perfectly and would destroy the one property that
   * matters: that a client can say whether it is showing the shared sky or its
   * own. See `desync`.
   */
  private serverSkewMs = 0;

  /**
   * The **developer** scrub, in real milliseconds added on top of the server's
   * clock.
   *
   * One number, added in one place, because `skyClock` guarantees
   * `skyClock(t, s) === skyClock(t + s)` -- so this is genuinely an offset and
   * not a second clock.
   *
   * ---------------------------------------------------------------------------
   * **NOTHING A PLAYER CAN PRESS MOVES THIS ANY MORE, AND THAT IS THE POINT.**
   *
   * It used to be `T`, `N`, `[` and `]` -- four bare letters and brackets, on a
   * keyboard, in a shipped build, next to the movement keys. A player who leaned
   * on the bracket key had a private time of day: their street lights on while
   * everyone else's were off, their police behaving like night police, their
   * rave list an hour out. The old comment here said that was safe because
   * "nothing in the simulation reads this", and that sentence was already
   * stretching -- `game/rave.ts` reads `SkyClock.nowMs`, and the whole reason
   * this project publishes `vessels` on `/health` is that a flag with two owners
   * and no way to compare them is a trap rather than a flag.
   *
   * So the keys are gone (see `main.ts`'s keydown listener) and the handles are
   * on the console -- `sydney.sky.advance(30)`, `scrubTo`, `scrubToMoon` --
   * where reaching them is a deliberate act by somebody who has opened dev
   * tools. A developer who does scrub is **loudly** out of step rather than
   * quietly: `desync` is non-zero, `tick` warns to the console every time it
   * changes, and `sydney.nightsky.now()` reports it in minutes. Deliberately
   * *not* on the HUD -- that belongs to the player, and this is a state only a
   * developer can reach. What cannot happen any more is a **player** disagreeing
   * with the server about the time without either end knowing.
   */
  private scrubMs = 0;

  /** The decoded catalogue, kept so the debug overlay can report the count. */
  private starCatalogue: StarCatalogue | null = null;

  /** Where the player is, for the urban field. Refreshed by `update`. */
  private readonly here = new Vector3();

  /** The night rig for the current frame. Published through `night`. */
  private nightRig: NightSkyRig = nightSkyRig(90, -90, 0, 0, 0);

  /**
   * The weather override, `null` when the shared clock is in charge.
   *
   * A scrubbing player already disagrees with everyone else about the sky and
   * `cycle.ts` explains why that is safe; this is the same bargain for the
   * weather, and it exists because two of the four pictures this feature is
   * about -- the overcast CBD and the overcast bush -- are otherwise reachable
   * only by waiting up to twenty minutes for the noise to come round.
   *
   * There is deliberately **no moon override**. The moon is reached by scrubbing
   * to a night that has one (`scrubToMoon`), which exercises the ephemeris
   * instead of stepping around it -- so a screenshot of a full moon is a
   * screenshot of something the shipped game will actually produce.
   */
  private coverOverride: number | null = null;

  constructor(scene: Scene, opts: SkyOptions) {
    this.scene = scene;
    this.shadowRadius = opts.shadowRadius ?? 220;
    // The coordinates are `cycle.ts`'s now, because the cycle's two seams are
    // *solved horizon crossings* and a horizon is a function of latitude -- a
    // sky built for Perth would run Sydney's sunrise over Perth's sun. The
    // options are kept rather than removed so the call site still reads as a
    // statement of where this is, and checked rather than ignored so that
    // statement cannot quietly become false.
    if (opts.latitude !== SYDNEY_LATITUDE || opts.longitude !== SYDNEY_LONGITUDE) {
      console.warn(
        `[sky] Built at ${opts.latitude}, ${opts.longitude} but the day/night cycle is solved for ` +
          `${SYDNEY_LATITUDE}, ${SYDNEY_LONGITUDE}. The sun will be right and the sunrise and sunset ` +
          `seams will not be on the horizon. See cycle.ts.`,
      );
    }

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
    // Dome -> twilight grade -> clouds, in that order, and the order is the
    // whole design. The grade adds the horizon burn and the anti-twilight arch
    // to the *sky*, and the clouds then composite over it, so at dusk they read
    // as silhouettes against a burning horizon rather than as bright shapes with
    // a glow painted over them. Both are one node graph on one material, built
    // here and never rebuilt: no dusk-only variant exists to be compiled the
    // frame the sun goes down. See `dusk.ts`'s header on why that matters.
    this.dusk = new DuskGrade(this.sky.material.colorNode, this.sky.sunPosition);
    this.nightGlow = new NightGlow(this.dusk.colourNode, new Vector3(0, -1, 0));
    this.clouds = new CloudLayer(this.nightGlow.colourNode, this.sky.sunPosition);
    this.sky.material.colorNode = this.clouds.colourNode;
    scene.add(this.sky);

    // The stars and the moon, in the scene from here so the boot warm-up
    // compiles them. Both draw nothing until the sun is down -- `StarField`
    // hides itself outright below a visibility threshold and the moon hides
    // below the horizon -- so the daytime cost of both is one visibility test.
    this.stars = new StarField();
    scene.add(this.stars);
    this.moon = new MoonDisc();
    scene.add(this.moon);
    void this.loadNightAssets();

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

    // Moonlight. See the field's own note for why it is constructed here rather
    // than the first time the moon comes up, and why it never casts.
    this.moonLight = new DirectionalLight(0xffffff, 0);
    this.moonLight.castShadow = false;
    scene.add(this.moonLight);
    scene.add(this.moonLight.target);

    // The shared clock. Not a fixed reference instant any more: the time of day
    // is a pure function of the wall clock, identical on every machine, and this
    // is simply the first read of it. See `cycle.ts`.
    this.clock = skyClock(Date.now() + this.serverSkewMs, this.scrubMs);
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
    // And the two this pass adds, on identical terms. A cycle whose halves are
    // not half an hour is a feature that quietly does not do what it was asked;
    // a twilight grade that leaks into daylight lifts every horizon in the game
    // by a few code values. Neither throws, neither costs frame time, and both
    // read as taste decisions from inside the game.
    for (const failure of verifyCycle()) {
      console.warn(`[sky] ${failure}`);
    }
    for (const failure of verifyDuskRig()) {
      console.warn(`[sky] ${failure}`);
    }
    // And the night's three, on identical terms. A moon a degree out of place, a
    // sky that wheels backwards and a city that does not glow are all things
    // that render perfectly and are wrong.
    for (const failure of verifyLunar(SYDNEY_LATITUDE, SYDNEY_LONGITUDE)) {
      console.warn(`[sky] ${failure}`);
    }
    for (const failure of verifySkyglow()) {
      console.warn(`[sky] ${failure}`);
    }
    for (const failure of verifyMoonDisc()) {
      console.warn(`[sky] ${failure}`);
    }
  }

  /**
   * Fetch the star catalogue and the urban field.
   *
   * Fire-and-forget, and neither is awaited by anything: the sky renders
   * correctly without either -- no stars, and a uniformly lit city -- so
   * blocking the first frame on 62 kB of static assets would trade a real cost
   * for an imaginary one. Both are decoded into structures that were already
   * allocated in the constructor, so nothing recompiles when they land.
   *
   * `import.meta.env.BASE_URL` rather than a bare path, because the game is
   * served from a sub-path in some deployments and a leading slash would fetch
   * the index page and decode it as a star catalogue.
   */
  private async loadNightAssets(): Promise<void> {
    const base = import.meta.env.BASE_URL ?? '/';
    try {
      const response = await fetch(`${base}stars.bin`);
      if (response.ok) {
        const catalogue = decodeStars(await response.arrayBuffer());
        if (catalogue === null) {
          console.warn('[sky] stars.bin did not decode; the sky has no stars in it.');
        } else {
          this.starCatalogue = catalogue;
          this.stars.adopt(catalogue);
          for (const failure of verifyStars(catalogue, SYDNEY_LATITUDE, SYDNEY_LONGITUDE)) {
            console.warn(`[sky] ${failure}`);
          }
        }
      }
    } catch {
      // A star catalogue that will not load is a worse night, not a broken game.
    }
    if (!(await this.urban.load(`${base}skyglow.bin`))) {
      console.warn(
        '[sky] skyglow.bin did not load; the whole world will glow like the inner city. ' +
          'See the header of skyglow.ts.',
      );
    }
  }

  /**
   * **The clock, and the answer to "what time is it and how dark is it".**
   *
   * Refreshed once per `update()`, so everything in a frame reads one consistent
   * instant rather than sampling `Date.now()` at four different points. Anything
   * outside `sky/` that wants the time of day should read this rather than
   * calling `skyClock()` itself -- not for the cost (it is a few hundred
   * nanoseconds) but so that a scrubbing developer's `sydney.sky.advance` moves the whole
   * world's appearance together instead of half of it.
   *
   * `night` on it is `calibration.nightLevel` and is the single ramp everything
   * after dark shares.
   */
  get now(): SkyClock {
    return this.clock;
  }

  /** The Sydney instant being rendered. */
  get time(): Date {
    return this.clock.date;
  }

  get solar(): SolarPosition {
    return this.clock.solar;
  }

  /**
   * Re-read the shared clock. Called at the top of `update()`, which is the only
   * caller -- the clock advances by itself and nothing has to drive it.
   */
  private tick(): void {
    this.clock = skyClock(Date.now() + this.serverSkewMs, this.scrubMs);
    this.applySolar();
    /* **A scrub says so, out loud, every time it changes.**
     *
     * `hud.ts` belongs to the interface and a developer-only state has no
     * business on a player's screen, so the console is where this goes -- and it
     * goes there rather than nowhere because the failure this whole pass is
     * about is a disagreement neither end could see. `?vessels=1` was correct on
     * both sides in isolation; what cost the afternoon was that nothing said the
     * two had come apart. A scrubbed sky is the same shape of state: it looks
     * completely normal, and the person looking at it is the one person who
     * cannot tell.
     *
     * On the change rather than every frame, so scrubbing an hour forward is one
     * line rather than sixty a second, and once more on the way back to zero so
     * the log ends with "in step" rather than trailing off. */
    if (this.scrubMs !== this.warnedScrubMs) {
      this.warnedScrubMs = this.scrubMs;
      if (this.scrubMs === 0) {
        console.warn('[sky] Back on the server clock: this tab now agrees with everyone else about the time.');
      } else {
        console.warn(
          `[sky] Scrubbed ${(this.scrubMs / 60_000).toFixed(1)} real minutes off the server clock. ` +
            `This tab's sky, street lights, police and rave list are its own until you reload; ` +
            `nobody else can see it and no screenshot of it is evidence about the shipped game. ` +
            `sydney.nightsky.now() reports the offset.`,
        );
      }
    }
  }

  /** The last scrub the line above complained about, so it complains once. */
  private warnedScrubMs = 0;

  /**
   * **Adopt the host's wall clock.** Called once, by `main.ts`, when `WELCOME`
   * lands; `skewMs` is `net/client.clockSkew`.
   *
   * The whole of "the server owns the time of day" on this side. Everything
   * downstream is unchanged: the cycle is still the same pure function of an
   * instant, still evaluated here, still identical arithmetic to the server's --
   * what this line decides is *which instant*. A client whose own clock is four
   * minutes fast used to be four minutes into a different evening from everybody
   * else in the room, with no symptom except that its street lights came on
   * first.
   *
   * Applied immediately rather than at the next frame, because the frame after a
   * welcome is also the frame the world becomes visible, and a sky that jumped a
   * few minutes on the first drawn frame is a flash nobody could account for.
   * (Offline this is never called and the skew stays zero, which is the same sky
   * this file has always drawn.)
   */
  setServerClock(skewMs: number): void {
    if (!Number.isFinite(skewMs)) return;
    this.serverSkewMs = skewMs;
    this.tick();
  }

  /**
   * Scrub the sky by `minutes` of Sydney time. **A console handle**, not a key:
   * `sydney.sky.advance(30)`.
   *
   * An **offset on the shared clock**, not a second clock: the sky keeps
   * running, and what changes is where in the cycle it is running. Half an hour
   * of Sydney is not a fixed amount of real time (the dwell sees to that), so
   * the average rate is used -- one call moves the same 75 real seconds every
   * time, which is what keeps `skyClock(t, s) === skyClock(t + s)` true and what
   * makes the scrub a single number rather than a piece of state with its own
   * rules.
   *
   * Whoever calls this is off the server's clock until they reload; see
   * `scrubMs` and `desync`.
   */
  advance(minutes: number): void {
    this.scrubMs += minutes * SCRUB_MS_PER_GAME_MINUTE;
    this.tick();
  }

  /**
   * Scrub to a given point in the cycle: 0.25 is sunrise, 0.5 solar noon, 0.75
   * sunset, 0 the dead of night. The handle to reach for from the console when
   * looking at a sunset -- `sydney.sky.scrubTo(0.752)`.
   *
   * This was `T` and `N`. It is not a key any more, for the reason `scrubMs`
   * gives at length: a player who can set their own time of day is a player who
   * disagrees with the server and with everybody else in the room about whether
   * the street lights are on, with nothing on either end able to notice.
   *
   * Always forward, so the sky never runs backwards to get there.
   */
  scrubTo(phase: number): void {
    const wanted = ((phase % 1) + 1) % 1;
    const current = cyclePhase(Date.now() + this.serverSkewMs + this.scrubMs);
    // Parenthesised rather than relying on `%` and `*` having equal precedence,
    // which they do and which nobody should have to remember while reading a
    // line whose whole job is to wrap.
    this.scrubMs += ((((wanted - current) % 1) + 1) % 1) * CYCLE_MS;
    this.tick();
  }

  /** How far the sky has been scrubbed from the shared clock, in real ms. Zero in a shipped session. */
  get scrub(): number {
    return this.scrubMs;
  }

  /**
   * The offset between the host's clock and this machine's, in real ms. Zero
   * offline, and whatever the one-way latency was on a live socket.
   */
  get serverSkew(): number {
    return this.serverSkewMs;
  }

  /**
   * **How far out of step with the server this client's sky is, in real ms.**
   *
   * `scrubMs` and nothing else: the server skew is what *brings* the two into
   * agreement, so it is not a desync. Non-zero only after somebody has called
   * `advance`, `scrubTo` or `scrubToMoon` from a console.
   *
   * Exists so that a scrub cannot be silent. The `?vessels=1` link that outlived
   * its server flag is the story this project keeps: the cost was not that the
   * two ends could differ, it was that nothing published enough for anybody to
   * see that they did. The server now publishes its clock on `/health`; this is
   * the same fact from the client's end, and `main.ts` prints it in the debug
   * overlay and returns it from `sydney.nightsky.now()`.
   */
  get desync(): number {
    return this.scrubMs;
  }

  /**
   * What the night sky is doing this frame: cloud cover, the urban field at the
   * player, the skyglow, the moonlight and the derived ambient.
   *
   * Published for the debug overlay and for the integration check, and for the
   * same reason `now` is: anything that wants to know how dark it is should read
   * one answer that the whole frame shares rather than recomputing it.
   */
  get night(): NightSkyRig {
    return this.nightRig;
  }

  /** How many stars are in the field. Zero until the catalogue lands. */
  get starCount(): number {
    return this.starCatalogue?.count ?? 0;
  }

  /**
   * Force the weather and the moon, or hand them back to the shared clock with
   * `null`. See `coverOverride`.
   *
   * The four pictures this feature exists for are a clear high moon, a clear
   * moonless sky, an overcast CBD and an overcast bush, and three of the four
   * are otherwise reachable only by waiting for the weather. `null` on both is a
   * shipped session.
   */
  setNightOverride(cover: number | null): void {
    this.coverOverride = cover === null ? null : Math.min(Math.max(cover, 0), 1);
    this.applySolar();
  }

  /**
   * Scrub forward to a night whose moon is closest to a wanted illuminated
   * fraction, and stop at the given point in the cycle.
   *
   * **A search rather than an override**, and that is the whole point of it. The
   * moon walks one day per cycle (see `cycle.ts`), so somewhere in the next
   * 2,160 cycles there is a night with any moon you like -- and scrubbing to it
   * means what you are looking at is a sky the shipped game genuinely produces
   * on some evening, not a debug state. It is what the four verification
   * screenshots were taken through.
   *
   * `sydney.sky.scrubToMoon(1)` for a full moon at solar midnight;
   * `scrubToMoon(0)` for a moonless one; `scrubToMoon(0.15, 0.78)` for a thin
   * crescent just after sunset, which is the prettiest thing this sky does.
   *
   * The cost is 2,160 evaluations of the lunar series, about 4 ms, once, from a
   * console. `altitudeWeight` breaks ties toward a moon that is actually *up*,
   * because half the nights with a given phase have it below the horizon and
   * those are not the ones anybody is looking for.
   */
  scrubToMoon(illumination = 1, atPhase = 0, altitudeWeight = 0.35): number {
    let bestScore = Infinity;
    let bestAt = 0;
    const from = Date.now() + this.serverSkewMs + this.scrubMs;
    const startIndex = Math.floor((from - CYCLE_EPOCH_MS) / CYCLE_MS);
    for (let step = 0; step < LUNAR_PERIOD_CYCLES; step++) {
      const at = (startIndex + step + atPhase) * CYCLE_MS + CYCLE_EPOCH_MS;
      const clock = skyClock(at);
      const wanted = Math.abs(clock.moonPhase - illumination);
      // Reward altitude, but only up to 45 degrees: past that the difference is
      // not worth trading phase accuracy for.
      const up = Math.min(Math.max(clock.lunar.altitude, 0) / 45, 1);
      const score = wanted - altitudeWeight * up;
      if (score < bestScore) {
        bestScore = score;
        bestAt = at;
      }
    }
    this.scrubMs += bestAt - from;
    this.tick();
    return this.clock.moonPhase;
  }

  /**
   * Tell the star field and the moon how big the frame is.
   *
   * On resize rather than per frame, and it has to be called at least once or
   * both will draw at the 1920x1080 they were constructed assuming -- which
   * would make the moon the wrong angular size on any other display, and is
   * exactly the kind of thing that looks like a tuning problem.
   */
  setViewport(widthPx: number, heightPx: number, camera: Camera): void {
    const perspective = camera as Camera & { fov?: number; isPerspectiveCamera?: boolean };
    if (!perspective.isPerspectiveCamera) return;
    this.stars.setViewport(widthPx, heightPx, perspective as never);
    this.moon.setViewport(widthPx, heightPx, perspective as never);
  }

  private applySolar(): void {
    const d = this.clock.solar.direction;
    this.sunVector.set(d.x, d.y, d.z);
    this.sky.sunPosition.value.copy(this.sunVector);

    // One pure function decides the whole rig from the sun's altitude, so the
    // renderer and the startup self-check can never disagree about what the
    // numbers are. Intensity now falls off by Beer-Lambert against air mass
    // rather than an invented power curve, so the sun dims and reddens together
    // and actually reaches zero at the horizon.
    const altitude = this.clock.solar.altitude;
    const rig = solarRig(altitude);

    /* The night, before the ambient is written, because it is what the ambient
     * now is. Three inputs and they come from three different places on purpose:
     * the clock (deterministic, shared), the weather (deterministic, shared) and
     * the *place* (the baked urban field, which is why an overcast night in the
     * CBD and one in the foothills are different pictures). */
    const cover = this.coverOverride ?? cloudCover(this.clock.nowMs);
    const moonlight = this.clock.moonlight;
    const night = nightSkyRig(
      altitude,
      this.clock.lunar.altitude,
      moonlight,
      cover,
      this.urban.sample(this.here.x, this.here.z),
    );
    this.nightRig = night;

    this.sun.intensity = rig.sunIntensity;
    // `setRGB` writes in the *working* colour space, which is linear -- these
    // are radiometric multipliers, not swatches, so the colour space is stated
    // rather than left to a default that a future working-space change would
    // silently invert.
    this.sun.color.setRGB(...rig.sunColour, LinearSRGBColorSpace);

    /* The ambient, and this is where the night stopped being a constant.
     *
     * `solarRig` still owns the *floor*: it ramps the fill across civil twilight
     * from `HEMISPHERE_DAY` down to `HEMISPHERE_NIGHT`, and that bottom end
     * carries the ten per cent a player who had spent an evening in the game
     * asked for. What is new is that the floor is no longer where the night
     * stops. `nightSkyRig` returns an *additional* intensity and the
     * intensity-weighted colour that goes with it -- so a moonlit night is
     * brighter and blue, an overcast city night is brighter and orange, and a
     * moonless clear night in the mountains reduces to exactly the value that
     * shipped before, to the last bit. `verifySkyglow` asserts that last clause
     * from both ends, which is what keeps `NIGHT_AMBIENT_FLOOR_MAX` meaningful.
     *
     * `max` rather than a sum against the day value, because the two overlap
     * across twilight: the sky fill is still 3.4 at dusk while the night terms
     * are already ramping up, and adding them would put a moonlit gain on top of
     * a daylit hemisphere. Every night term is gated on `nightLevel`, which is
     * zero above +2 degrees, so by day this reduces to `rig.hemisphereIntensity`
     * exactly and the whole daytime calibration is untouched. */
    const litIntensity = Math.max(rig.hemisphereIntensity, night.ambientIntensity);
    const nightShare =
      litIntensity > 1e-9 ? Math.min(night.ambientBoost / litIntensity, 1) : 0;
    this.ambient.intensity = litIntensity;
    this.ambient.color.setRGB(
      ...(rig.skyColour.map(
        (c, i) => c + (night.ambientColour[i] - c) * nightShare,
      ) as [number, number, number]),
      LinearSRGBColorSpace,
    );
    this.ambient.groundColor.setRGB(...rig.groundColour, LinearSRGBColorSpace);

    /* Moonlight as a direction. The light is placed the way the sun is -- a
     * directional light reads `position - target`, and the target is left at the
     * origin -- so this is the whole of aiming it. */
    const m = this.clock.lunar.direction;
    this.moonLight.position.set(m.x * BOUNCE_DISTANCE, m.y * BOUNCE_DISTANCE, m.z * BOUNCE_DISTANCE);
    this.moonLight.intensity = night.moonIntensity;
    this.moonLight.color.setRGB(...night.moonColour, LinearSRGBColorSpace);

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
    const b = bounceDirection(this.clock.solar.azimuth);
    this.bounce.position.set(
      b.x * BOUNCE_DISTANCE,
      b.y * BOUNCE_DISTANCE,
      b.z * BOUNCE_DISTANCE,
    );
    this.bounce.intensity = rig.bounceIntensity;
    this.bounce.color.setRGB(...rig.bounceColour, LinearSRGBColorSpace);

    // The clouds, from the same altitude and in the same place, so a cloud lit
    // for 3 pm can never be left over a 6 pm city. They now also take the cover
    // -- which slides their coverage window and holds their night opacity up --
    // and the city's glow, which lands on the underside of the deck and is where
    // the orange lid actually comes from. They still give nothing back.
    this.clouds.setSolarAltitude(altitude, cover);
    this.clouds.setGlow(night.glowRadiance);

    // The twilight, from the same altitude, into the same kind of uniforms. Two
    // of the four things it sets are `SkyMesh`'s *own* parameters -- turbidity
    // and the Mie coefficient -- which are uniforms on the dome's existing
    // material and therefore cost nothing to move: no new node, no new key, no
    // recompile. Ramping them is the cheapest large improvement in this whole
    // pass, because Preetham already knows how to draw a hazy sunset and was
    // only ever being asked for a clear noon.
    const twilight = duskRig(altitude);
    this.sky.turbidity.value = twilight.turbidity;
    this.sky.mieCoefficient.value = twilight.mieCoefficient;
    this.dusk.setSolarAltitude(altitude);
    // And the night's own grade, from the same rig, into the same kind of
    // uniforms on the same material.
    this.nightGlow.set(night, this.clock.lunar.direction);

    // And the aerial perspective, which has to follow all of it.
    //
    // Read off `scene.fog` each time rather than captured in the constructor,
    // because `main.ts` creates the fog *after* this object exists -- so the
    // first few `applySolar` calls legitimately find nothing there. Guarded on
    // the type as well as on the null: `Fog` and `FogExp2` both have a `color`,
    // but only the linear one is what `main.ts`'s 500/9000 range was solved for,
    // and silently colouring the wrong kind of fog would be worse than not
    // colouring it.
    //
    // Mutating `color` is free and safe. Three's `NodeManager.updateFog` builds
    // the fog node from `reference('color', 'color', sceneFog)` and caches it
    // against the *fog object*, so the colour is a live uniform and the material
    // cache key does not contain it. Replacing `scene.fog` would rebuild every
    // pipeline in the scene; writing to it does nothing at all.
    if (this.scene.fog instanceof Fog) {
      this.scene.fog.color.setRGB(...twilight.fog, LinearSRGBColorSpace);
    }
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
    // **The clock advances here, and nowhere else.**
    //
    // Deliberately inside the call `main.ts` already makes every frame, rather
    // than as a second call it would have to remember: the time of day is a pure
    // function of the wall clock, so there is nothing to step and nothing that
    // can fall behind -- reading it is the whole of advancing it. A frame that
    // never runs simply produces a sky for whenever the next one does, which is
    // exactly right for a backgrounded tab.
    //
    // Costed rather than assumed: `skyClock` is one `solarPosition` (about 60
    // flops), `applySolar` is three pure rig functions and eleven uniform
    // writes, and the fog is one `setRGB`. 5.4 microseconds a frame measured, or
    // 0.03% of a 16.7 ms budget. Nothing here allocates except the `Date` inside
    // `skyClock`, which is one short-lived object a frame.
    /* Where the player is, read **before** the tick so `applySolar` can sample
     * the urban field at this frame's position rather than the last one's. It is
     * the only spatially-varying input the sky has, and one frame of lag in it
     * would be invisible -- it is read first because the ordering is free and a
     * reader should not have to work out whether it matters. */
    this.here.copy(camera.position);

    this.tick();

    /* The stars and the moon. Both are placed at the camera and rotated by the
     * shared clock, so they cost one matrix build and two uniform writes a
     * frame; the star field hides itself outright whenever its visibility is
     * effectively zero, which is every daylight frame and every overcast one. */
    this.stars.update(
      this.clock.date,
      SYDNEY_LATITUDE,
      SYDNEY_LONGITUDE,
      camera,
      this.nightRig.starVisibility,
      this.nightRig.starThreshold,
    );
    this.moon.update(
      this.clock.lunar,
      this.clock.moonPhase,
      this.clock.solar.direction,
      camera,
    );

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
