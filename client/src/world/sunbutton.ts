/**
 * The plinth on the hill, and the face it puts in the sky.
 *
 * `game/sunbutton.ts` is the rules -- where the button is, who may press it, how
 * long the sun screams for -- and both ends compile that file. This one is the
 * renderer, so it is the client's alone, and it holds two objects that have
 * nothing in common except the state that drives them:
 *
 *   - **The prop.** A concrete plinth with a red dome on it, a light ring that
 *     says whether the key would work, a "DO NOT PRESS" plate on a post, and a
 *     small floating readout that appears within eight metres and counts down.
 *   - **The face.** A camera-facing billboard on `sunVector` at 14 km, drawn
 *     from a Canvas texture that is redrawn fifteen times a second while it is
 *     up and not at all when it is not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACE IS A BILLBOARD AND NOT A CHANGE TO THE SKY SHADER.
 *
 * The sun disc lives inside three's `SkyMesh` -- an analytic Preetham dome with
 * the disc as a term in the fragment shader, see `sky/sky.ts`. Putting a face in
 * there would mean either branching the whole dome's shader on a uniform that is
 * false 99% of the time, or compiling a second sky material and swapping it,
 * which is a pipeline compiled in the middle of an afternoon -- exactly the
 * failure `sky/stars.ts` and `sky/moon.ts` both open by refusing. A quad costs
 * two triangles and is `visible = false` the rest of the time.
 *
 * ---------------------------------------------------------------------------
 * IT IS DEPTH-TESTED, AND THAT IS THE RECENT BUG NOT REPEATED.
 *
 * `sky/moon.ts` states it at length and this file inherits the conclusion
 * verbatim: a transparent material is drawn after every opaque triangle in the
 * frame, so an *untested* one is painted over the roof rather than behind it.
 * That was reported as "stars through roofs" and the moon had it too. So the
 * face sits at the same 14 km the moon does -- inside the 24 km far plane, in
 * front of a sky dome that writes no depth -- with `depthTest` on and
 * `depthWrite` off. Nothing in the sky can occlude it and every building can,
 * which is the correct answer for something that is meant to be *in* the sky.
 *
 * ---------------------------------------------------------------------------
 * IT BLENDS NORMALLY, WHICH IS THE ONE PLACE IT DISAGREES WITH THE MOON.
 *
 * The moon is additive because it is a physical body above the atmosphere and
 * the whole scattering column is still in front of it -- drawn with a normal
 * blend, a crescent over twilight is a black disc with a bright edge. None of
 * that applies here. This is not a body; it is a **joke drawn on the sky**, and
 * the joke needs a dark outline and a dark mouth. Additively blended, black is
 * transparent: the outline would vanish, the mouth would be a hole showing blue
 * sky through it, and the thing would read as a lens flare rather than as a
 * cartoon. So: normal alpha, over the dome, with the radiance carried by a gain
 * on the material colour instead (`FACE_RADIANCE`).
 */

import {
  BoxGeometry,
  CanvasTexture,
  Camera,
  CylinderGeometry,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import {
  SUN_BUTTON_X,
  SUN_BUTTON_Z,
  SUN_PRESS,
  SUN_PROMPT_M,
  SUN_READOUT_M,
  sunReadoutText,
  sunReady,
  sunRefusalText,
  sunScreaming,
  trySunPress,
  jawOpen,
  type SunState,
} from '../game/sunbutton.ts';
import { registerTexture, unregisterTexture } from './texture-audit.ts';

/**
 * How far along `sunVector` the billboard sits, metres.
 *
 * The moon's own number, and it is the moon's own reason: inside the 24 km far
 * plane so the depth test has something to compare against, and far enough that
 * no building in Sydney is between the camera and it by accident. Repeated as a
 * constant here rather than imported because the two are only *coincidentally*
 * equal -- if the far plane moved, both would move for their own reasons.
 */
const FACE_DISTANCE_M = 14000;

/**
 * The face's disc, in degrees of the render's own field of view.
 *
 * The real sun is 0.53 degrees. The first cut was five times that -- about 45
 * pixels of a 1080-line frame -- and in the shipped-size preview it read as a
 * dot with a red pixel in it: a face you had to be told about. This is a joke
 * that only works if it is unmissable, so it is now **twelve** times the sun,
 * roughly 110 pixels tall on a 1080 frame, a proper cartoon sun somebody drew
 * on the sky. It still reads as the sun rather than a balloon because it sits
 * exactly on the solar disc and carries the sun's own colour. `sky/moon.ts`'s `MOON_APPARENT_GAIN` argument (that the render's
 * field of view is 2.4x the player's own) is deliberately **not** applied on top:
 * that correction exists so a physically-sized moon arrives at the retina at the
 * angle memory expects, and this object has no correct size to be wrong about.
 */
const FACE_DEGREES = 0.53 * 12;

/**
 * What fraction of the canvas the face's disc occupies, edge to edge.
 *
 * The rays stick out past the disc and they have to be inside the same texture
 * -- a second quad for them would be a second draw and a second alpha seam
 * across the middle of the face -- so the quad is wider than the disc by exactly
 * this ratio and the drawing routine and this number are one decision. Change
 * one and the face changes size on screen without anything looking wrong up
 * close, which is why it is named.
 */
const DISC_SHARE = 0.62;

/**
 * The gain on the face's colour, in the same linear units the Preetham dome
 * produces.
 *
 * The sky at noon is 1 to 8 in those units and `SUN_ZENITH_INTENSITY` is 17, so
 * a texture whose brightest pixel is 1.0 would come out *dimmer than the sky
 * around it* -- a grey sticker in a blue field, which is the failure mode this
 * number exists to avoid. Seven puts the yellow at about 7 and the dark outline
 * at about 0.08, so the face blazes and the outline is genuinely darker than the
 * sky behind it. It goes through `NeutralToneMapping` and `EXPOSURE` like
 * everything else in the frame rather than being `toneMapped = false`: a sun
 * that ignored the exposure would stay the same brightness at dusk while the
 * whole world dimmed around it.
 */
const FACE_RADIANCE = 7;

/** Canvas edge, pixels. See `redrawFace` for why this is not larger. */
const FACE_TEXTURE_PX = 256;

/** How often the face is redrawn while it is up, Hz. See `redrawFace`. */
const FACE_REDRAW_HZ = 15;

/** The scream's jaw cycle, seconds. The brief's number. */
const JAW_PERIOD_S = 0.7;

/** Plinth: a concrete block you could sit on. Metres. */
const PLINTH_W = 1.0;
const PLINTH_H = 0.6;

/** The dome on top. 0.7 m across, which is 24 px at 30 m and a 72-degree fov. */
const DOME_R = 0.35;

/** Ring colours. Amber and pressable, or dark red and not. */
const READY_COLOUR: number = 0xffb648;
const COOLING_COLOUR: number = 0x5a1220;
/** And the dome's own, which is the half of the signal that reads from 30 m. */
const DOME_READY: number = 0xd6203a;
const DOME_COOLING: number = 0x33121a;

/**
 * How far away somebody else's press is still narrated as *the button*.
 *
 * Beyond this the notice says the sun has started screaming and does not mention
 * a button, because a player in Manly has no idea there is one and a line about
 * a thing they cannot see is a line that reads as a bug. The brief asks for
 * "earshot or sight"; 150 m is the distance the plinth is still a visible object
 * on the hill.
 */
const WITNESS_M = 150;

/** What the renderer needs from `main.ts` and cannot work out for itself. */
export interface SunFeatureDeps {
  /**
   * The composed ground query, at the `-Infinity` feet flavour.
   *
   * `-Infinity` rather than the player's own feet because the plinth is not
   * standing on a roof and never will be -- see `main.ts`'s `wildGround`, which
   * makes exactly this argument about a turkey. Asked every frame the player is
   * near rather than once at boot, because at boot the terrain under Sydney Park
   * may not have arrived and a prop placed on `NO_GROUND` is a prop at the
   * bottom of the world for the rest of the session.
   */
  groundAt(x: number, z: number): number;
  /**
   * Epoch milliseconds on the **server's** clock.
   *
   * `sky/sky.ts` already holds the skew (`serverSkew`, from `WELCOME`), and the
   * two numbers in `SunState` are on that clock, so this is the one place the
   * feature could silently drift and it is deliberately not re-derived here.
   */
  clockMs(): number;
  /** `hud.notice`. */
  notice(text: string): void;
}

/**
 * The prop, the face, and the small amount of state that ties them together.
 *
 * A `Group` so `main.ts` adds one object. The prop child sits at the button's
 * world position; the face child is moved to the camera every frame, which works
 * because this group is never transformed -- see `update`.
 */
export class SunFeature extends Group {
  /**
   * **The authoritative state, as this client last heard it.**
   *
   * Written by `adopt` when a `SUN` message lands, and *optimistically* by
   * `press` on the frame the key goes down. That second write is the bike's
   * bargain (`main.ts`'s `pressMount`): the sun changes on the frame you press
   * rather than a round trip later, and the server's answer -- which it sends to
   * the presser whether or not it agreed -- overwrites it. `server/room.ts`
   * replies to a *refused* press as well as an accepted one precisely so that a
   * wrong prediction has something to be corrected by.
   */
  readonly state: SunState = { screamUntilMs: 0, cooldownUntilMs: 0 };

  private readonly deps: SunFeatureDeps;

  private readonly prop = new Group();
  private readonly dome: Mesh;
  private readonly domeMat: MeshStandardNodeMaterial;
  private readonly ring: Mesh;
  private readonly ringMat: MeshBasicNodeMaterial;
  private readonly readout: Mesh;
  private readonly readoutMat: MeshBasicNodeMaterial;
  private readonly readoutTex: CanvasTexture;
  private readonly readoutCtx: CanvasRenderingContext2D | null;
  private readoutText = '';

  private readonly face: Mesh;
  private readonly faceMat: MeshBasicNodeMaterial;
  private readonly faceTex: CanvasTexture;
  private readonly faceCtx: CanvasRenderingContext2D | null;

  private readonly signMat: MeshBasicNodeMaterial;
  /** Plinth and post share one concrete. Held only so `dispose` can free it. */
  private readonly concreteMat: MeshStandardNodeMaterial;
  private readonly signTex: CanvasTexture;

  /** Animation clocks. Frame-rate driven, cosmetic, read by nothing shared. */
  private ringPhase = 0;
  private facePhase = 0;
  /** The `mouth` the last redraw used; 0 means the canvas shows a closed mouth. See `update`. */
  private faceLastMouth = 1;
  private faceRedrawDue = 0;

  /** Last ground answer we believed. See `SunFeatureDeps.groundAt`. */
  private groundY = Number.NaN;

  /**
   * The scream instant the last notice was about.
   *
   * Kept so a `SUN` message that repeats a scream already narrated -- a joiner's
   * copy, a refused press bouncing back, a re-send -- does not narrate it twice.
   * The instant rather than a boolean, on `SunState`'s own argument: two presses
   * in one day are impossible (the cooldown is three), so the instant is a
   * unique name for the event.
   */
  private narrated = 0;

  /** Set by `press` so `adopt` can tell "I did that" from "somebody did that". */
  private pressedAt = 0;

  constructor(deps: SunFeatureDeps) {
    super();
    this.deps = deps;
    this.name = 'sun_button';
    // Never culled: this group's own bounding sphere is meaningless (its two
    // children are 14 km apart and one of them moves with the camera), and it is
    // a few dozen triangles. `world/doormarker.ts` makes the same call for the
    // same reason.
    this.frustumCulled = false;

    // --- The prop ---------------------------------------------------------

    this.prop.name = 'sun_button_prop';
    this.prop.frustumCulled = false;
    this.prop.visible = false; // until the ground under it is known
    this.add(this.prop);

    const concrete = new MeshStandardNodeMaterial();
    this.concreteMat = concrete;
    concrete.name = 'sun_button_plinth';
    concrete.color.setHex(0x9a9690);
    concrete.roughness = 0.92;
    concrete.metalness = 0;
    const plinth = new Mesh(new BoxGeometry(PLINTH_W, PLINTH_H, PLINTH_W), concrete);
    plinth.position.y = PLINTH_H / 2;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.prop.add(plinth);

    // The dome. A hemisphere rather than a sphere because half of it would be
    // inside the plinth: 96 triangles that are never seen, on an object that
    // exists in one instance, is not a saving worth making and is not a cost
    // worth paying either -- what it buys is that the flat bottom sits *on* the
    // plinth instead of intersecting it, which is visible at two metres.
    this.domeMat = new MeshStandardNodeMaterial();
    this.domeMat.name = 'sun_button_dome';
    this.domeMat.roughness = 0.35;
    this.domeMat.metalness = 0.05;
    this.dome = new Mesh(
      new SphereGeometry(DOME_R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      this.domeMat,
    );
    this.dome.position.y = PLINTH_H;
    this.dome.castShadow = true;
    this.prop.add(this.dome);

    /* The ring, inset into the top face of the plinth around the dome. Unlit and
     * additive like every other diegetic signal in this renderer
     * (`world/doormarker.ts`), because it is a *light* rather than a surface: it
     * has to read the same at 3 am under a sodium lamp as at noon, and a lit
     * material would go dark at exactly the hour somebody is most likely to be
     * hunting for it. */
    this.ringMat = new MeshBasicNodeMaterial();
    this.ringMat.name = 'sun_button_ring';
    this.ringMat.transparent = true;
    this.ringMat.depthWrite = false;
    this.ringMat.side = DoubleSide;
    this.ringMat.fog = false;
    this.ringMat.toneMapped = false;
    const ring = new RingGeometry(DOME_R + 0.06, DOME_R + 0.16, 40);
    ring.rotateX(-Math.PI / 2);
    this.ring = new Mesh(ring, this.ringMat);
    this.ring.position.y = PLINTH_H + 0.005;
    this.ring.frustumCulled = false;
    this.prop.add(this.ring);

    // The plate, on a post, facing the way somebody walking up the mound from
    // the spawn disc arrives (roughly north-east). Double-sided, because the
    // half of the players who come round the other way would otherwise find a
    // blank rectangle -- and a sign you can read from one side only is the kind
    // of thing that looks like a normal-flipping bug.
    const post = new Mesh(
      new CylinderGeometry(0.035, 0.035, 1.15, 8),
      concrete,
    );
    post.position.set(-0.62, 0.575, 0.0);
    post.castShadow = true;
    this.prop.add(post);

    this.signTex = makeSignTexture();
    registerTexture(this.signTex);
    this.signMat = new MeshBasicNodeMaterial();
    this.signMat.name = 'sun_button_sign';
    this.signMat.map = this.signTex;
    this.signMat.side = DoubleSide;
    this.signMat.transparent = true;
    const sign = new Mesh(new PlaneGeometry(0.86, 0.36), this.signMat);
    sign.position.set(-0.62, 1.16, 0.0);
    sign.rotation.y = Math.PI * 0.18;
    this.prop.add(sign);

    // The readout, which is a billboard and is therefore aimed in `update`.
    const readout = makeCanvas(512, 96);
    this.readoutCtx = readout.ctx;
    this.readoutTex = new CanvasTexture(readout.canvas);
    this.readoutTex.colorSpace = SRGBColorSpace;
    this.readoutTex.minFilter = LinearFilter;
    this.readoutTex.magFilter = LinearFilter;
    this.readoutTex.generateMipmaps = false;
    this.readoutTex.anisotropy = 4;
    registerTexture(this.readoutTex);
    this.readoutMat = new MeshBasicNodeMaterial();
    this.readoutMat.name = 'sun_button_readout';
    this.readoutMat.map = this.readoutTex;
    this.readoutMat.transparent = true;
    this.readoutMat.depthWrite = false;
    this.readoutMat.fog = false;
    this.readoutMat.toneMapped = false;
    this.readout = new Mesh(new PlaneGeometry(1.28, 0.24), this.readoutMat);
    this.readout.position.y = PLINTH_H + 0.95;
    this.readout.frustumCulled = false;
    this.readout.visible = false;
    this.prop.add(this.readout);

    // --- The face ---------------------------------------------------------

    const faceCanvas = makeCanvas(FACE_TEXTURE_PX, FACE_TEXTURE_PX);
    this.faceCtx = faceCanvas.ctx;
    this.faceTex = new CanvasTexture(faceCanvas.canvas);
    this.faceTex.colorSpace = SRGBColorSpace;
    this.faceTex.minFilter = LinearFilter;
    this.faceTex.magFilter = LinearFilter;
    // No mipmaps: the quad's on-screen size barely changes (it is at a fixed
    // 14 km and a fixed angular size), so a mip chain would be rebuilt fifteen
    // times a second to serve a level nothing samples.
    this.faceTex.generateMipmaps = false;
    registerTexture(this.faceTex);

    this.faceMat = new MeshBasicNodeMaterial();
    this.faceMat.name = 'screaming_sun';
    this.faceMat.map = this.faceTex;
    this.faceMat.transparent = true;
    this.faceMat.depthWrite = false;
    // See the header: tested, so buildings occlude it, and the sky dome (which
    // writes no depth) cannot.
    this.faceMat.depthTest = true;
    this.faceMat.fog = false;
    this.faceMat.color.setScalar(FACE_RADIANCE);
    this.face = new Mesh(new PlaneGeometry(1, 1), this.faceMat);
    this.face.frustumCulled = false;
    this.face.renderOrder = 0;
    this.face.visible = false;
    this.add(this.face);

    // Sized once: the quad is at a fixed distance and a fixed angular size, so
    // its world extent is a constant and re-deriving it per frame would be
    // arithmetic in service of nothing.
    const quadDegrees = FACE_DEGREES / DISC_SHARE;
    const extent = 2 * FACE_DISTANCE_M * Math.tan((quadDegrees * Math.PI) / 360);
    this.face.scale.setScalar(extent);
  }

  /**
   * A `SUN` message landed. Adopt it, and narrate it if it is news.
   *
   * **A replacement, not a merge**, on `protocol.encodeInvestigations`'
   * argument: there are two numbers, the server owns both of them, and a client
   * that kept the larger of its own and the server's would be a client whose
   * optimistic press outlived the refusal it earned. A joiner gets the same
   * frame everybody else got, which is what makes a mid-scream join show the
   * face on the first frame.
   *
   * The player's position is passed in only to word the notice -- see
   * `WITNESS_M`. It never decides anything, because the state is global.
   */
  adopt(next: SunState, px: number, pz: number): void {
    const now = this.deps.clockMs();
    const started = next.screamUntilMs > this.state.screamUntilMs;
    this.state.screamUntilMs = next.screamUntilMs;
    this.state.cooldownUntilMs = next.cooldownUntilMs;
    if (!started || !sunScreaming(this.state, now) || this.narrated === next.screamUntilMs) return;
    this.narrated = next.screamUntilMs;
    // Mine, if the key went down within the last two seconds -- comfortably more
    // than a round trip and comfortably less than the three in-game days before
    // anybody can press it again, so the window cannot alias. `press` has
    // already said its own line.
    if (now - this.pressedAt < 2000) return;
    const dx = px - SUN_BUTTON_X;
    const dz = pz - SUN_BUTTON_Z;
    this.deps.notice(
      dx * dx + dz * dz < WITNESS_M * WITNESS_M
        ? 'somebody pressed the button — look up'
        : 'the sun has started screaming',
    );
  }

  /**
   * `E`, from `main.ts`'s `pressMount`.
   *
   * Returns **true if the press was consumed**, which is not the same as
   * "accepted": standing at a button that is recharging consumes the key and
   * puts up the refusal, because a press that fell through to the bike chain
   * from two metres away would silently mount a bike somebody was trying to
   * press a button with. Out of reach returns false and the rest of the chain
   * runs, which is what makes this safe to put first.
   *
   * `send` is the socket, or null offline. Online the state is written here too
   * and corrected by the server's reply -- see `state`.
   */
  press(px: number, py: number, pz: number, send: (() => void) | null): boolean {
    const now = this.deps.clockMs();
    // The button's own feet, or the presser's if the terrain has not arrived --
    // which makes the vertical test a no-op rather than a refusal in the one
    // case where this client genuinely does not know the answer. The server
    // always knows, and it is the one that decides.
    const buttonY = Number.isFinite(this.groundY) ? this.groundY : py;
    const result = trySunPress(this.state, now, px, pz, py, buttonY);
    if (result === SUN_PRESS.TOO_FAR) return false;
    if (result !== SUN_PRESS.OK) {
      this.deps.notice(sunRefusalText(result, this.state, now));
      return true;
    }
    this.pressedAt = now;
    this.narrated = this.state.screamUntilMs;
    /* **No `notice` here, and its absence is the point.**
     *
     * The obvious line is `notice('you pressed the button')`, and it was here
     * for one round before being taken out: a press changes the readout from
     * "READY" to "sun returns to normal in ...", so `prompt` returns a different
     * string on the very next tick, `hud.derived` writes it, and the notice is
     * gone a sixtieth of a second after it was posted. That is `hud.ts`'s
     * documented behaviour rather than a bug in it -- see `Hud.derived`, which
     * says outright that a message owned by a moment and a message owned by a
     * state must not share the pill by taking turns.
     *
     * So the press line is a *state* like everything else on this channel:
     * `prompt` returns it for `PRESSED_LINE_MS` after `pressedAt`, and the
     * countdown takes over when that runs out. One owner, one pill, no race.
     */
    send?.();
    return true;
  }

  /**
   * How long the "you pressed it" line holds the pill, milliseconds.
   *
   * Three seconds, which is long enough to read and short enough that it is
   * gone before anybody has walked out of the readout's own eight metres. It is
   * a **real** duration rather than a hold on a notice, so it survives a
   * backgrounded tab and a server correction alike -- see `press`.
   */
  private static readonly PRESSED_LINE_MS = 3000;

  /**
   * The HUD line, or the empty string. Asked every tick, never stored.
   *
   * `hud.derived`'s contract, and `bikes.ridePrompt`'s argument for it: nothing
   * here posts a message and nothing takes one off, so a player who walks away
   * from the plinth -- or dies at it, or is knocked off it -- loses the line on
   * the next tick because the answer to the question changed. There is no path
   * that can strand it.
   */
  prompt(px: number, pz: number): string {
    const now = this.deps.clockMs();
    // The press line first, and **before the distance gate** rather than after
    // it: the one thing that must not happen is that the confirmation for a key
    // you just pressed disappears because you took a step backwards. Three
    // seconds is not long enough to leave the hill.
    if (now - this.pressedAt < SunFeature.PRESSED_LINE_MS) {
      return 'you pressed the button — the sun is screaming';
    }
    const dx = px - SUN_BUTTON_X;
    const dz = pz - SUN_BUTTON_Z;
    if (dx * dx + dz * dz > SUN_PROMPT_M * SUN_PROMPT_M) return '';
    if (!sunReady(this.state, now)) return sunReadoutText(this.state, now);
    return 'E — press the button';
  }

  /**
   * One frame. Places the prop, animates the ring, and puts the face in the sky.
   *
   * `solarDirection` is the vector `sky/sky.ts` hands its own dome and its own
   * moon in the same frame, passed in rather than recomputed for `MoonDisc`'s
   * reason: a face computed from a second reading of the clock would sit beside
   * the sun rather than on it, by however far the two readings differ.
   */
  update(
    dt: number,
    camera: Camera,
    solarDirection: Readonly<{ x: number; y: number; z: number }>,
    solarAltitudeDeg: number,
    px: number,
    pz: number,
    mouth = 0,
  ): void {
    const now = this.deps.clockMs();
    const dx = px - SUN_BUTTON_X;
    const dz = pz - SUN_BUTTON_Z;
    const nearSq = dx * dx + dz * dz;

    // --- The prop.
    //
    // Only asked about while somebody could see it. 400 m is well past the
    // distance the plinth is a pixel, and the query is a terrain sample plus a
    // roof test -- cheap, but it is cheap *per frame forever*, and a player in
    // Chatswood has no business paying for a button in St Peters.
    if (nearSq < 400 * 400) {
      const g = this.deps.groundAt(SUN_BUTTON_X, SUN_BUTTON_Z);
      if (Number.isFinite(g)) this.groundY = g;
    }
    const placed = Number.isFinite(this.groundY);
    this.prop.visible = placed && nearSq < 400 * 400;
    if (this.prop.visible) {
      this.prop.position.set(SUN_BUTTON_X, this.groundY, SUN_BUTTON_Z);

      const ready = sunReady(this.state, now);
      this.ringPhase = (this.ringPhase + dt * (ready ? 2.2 : 0.7)) % (Math.PI * 2);
      const pulse = 0.5 + 0.5 * Math.sin(this.ringPhase);
      this.ringMat.color.setHex(ready ? READY_COLOUR : COOLING_COLOUR);
      // Ready: bright and breathing. Cooling: dim and almost still. The two
      // states differ in colour, in level *and* in rate, which is what makes
      // them tell apart at 20 m where the colour alone is four pixels.
      this.ringMat.opacity = ready ? 0.45 + pulse * 0.55 : 0.14 + pulse * 0.1;
      this.domeMat.color.setHex(ready ? DOME_READY : DOME_COOLING);
      this.domeMat.emissive.setHex(ready ? DOME_READY : 0x000000);
      this.domeMat.emissiveIntensity = ready ? 0.25 + pulse * 0.35 : 0;

      // The readout, within eight metres, billboarded and redrawn only when the
      // sentence changes -- which is at most once a game-minute, against a frame
      // loop that would otherwise rasterise the same string sixty times a
      // second and re-upload a 512 x 96 texture with it.
      const wantReadout = nearSq < SUN_READOUT_M * SUN_READOUT_M;
      this.readout.visible = wantReadout;
      if (wantReadout) {
        const text = sunReadoutText(this.state, now);
        if (text !== this.readoutText) {
          this.readoutText = text;
          drawReadout(this.readoutCtx, text, sunReady(this.state, now));
          this.readoutTex.needsUpdate = true;
        }
        // `lookAt` in world space. The plate is upright rather than fully
        // free -- it yaws to the camera and does not pitch -- because a label
        // that tilted to face somebody standing on the plinth would read as a
        // physics object rather than as a caption.
        this.readout.getWorldPosition(WORLD);
        this.readout.lookAt(camera.position.x, WORLD.y, camera.position.z);
      }
    }

    // --- The face.
    //
    // Below the horizon there is nothing to draw and the disc would be under
    // the ground anyway. A degree of margin so it does not pop as the centre
    // crosses zero, which is `MoonDisc.update`'s own rule.
    const screaming = sunScreaming(this.state, now);
    this.face.visible = screaming && solarAltitudeDeg > -1;
    if (!this.face.visible) return;

    this.face.position.set(
      camera.position.x + solarDirection.x * FACE_DISTANCE_M,
      camera.position.y + solarDirection.y * FACE_DISTANCE_M,
      camera.position.z + solarDirection.z * FACE_DISTANCE_M,
    );
    this.face.lookAt(camera.position);

    this.facePhase += dt;
    this.faceRedrawDue -= dt;
    if (this.faceRedrawDue <= 0) {
      this.faceRedrawDue += 1 / FACE_REDRAW_HZ;
      // Clamped rather than accumulated after a long frame: a tab that came back
      // from being backgrounded must not run twenty redraws to catch up on an
      // animation nobody watched.
      if (this.faceRedrawDue < 0) this.faceRedrawDue = 1 / FACE_REDRAW_HZ;
      // A closed mouth does not need repainting fifteen times a second: between
      // clips the only thing that would move is the wobble, and the wobble no
      // longer moves the mouth (`game/sunbutton.jawOpen`). Skip the redraw when
      // this frame and the last drawn one are both silent; the eyes' squint is
      // static too, so nothing on the canvas would change.
      if (mouth > 0 || this.faceLastMouth > 0) {
        drawScreamFace(this.faceCtx, FACE_TEXTURE_PX, this.facePhase, mouth);
        this.faceTex.needsUpdate = true;
        this.faceLastMouth = mouth;
      }
    }
  }

  dispose(): void {
    this.prop.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.face.geometry.dispose();
    this.concreteMat.dispose();
    this.domeMat.dispose();
    this.ringMat.dispose();
    this.readoutMat.dispose();
    this.signMat.dispose();
    this.faceMat.dispose();
    for (const t of [this.faceTex, this.readoutTex, this.signTex]) {
      unregisterTexture(t);
      t.dispose();
    }
  }
}

/** Scratch for `getWorldPosition`, so `update` allocates nothing. */
const WORLD = new Vector3();

/** A 2d canvas, or a context-less stand-in on a runtime without a DOM. */
function makeCanvas(w: number, h: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
} {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * "DO NOT PRESS", once, on a roadside plate.
 *
 * Cream ground and black letters inside a red border, which is the Australian
 * regulatory-sign vocabulary and is the same vocabulary `world/furniture.ts`'s
 * blades and `world/rail-geo.ts`'s station boards work in -- a sign that looked
 * like a UI element would read as a tooltip somebody forgot to hide. The joke
 * only lands if the sign is completely straight.
 */
function makeSignTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(512, 216);
  if (ctx) {
    ctx.fillStyle = '#f2ece0';
    ctx.fillRect(0, 0, 512, 216);
    ctx.strokeStyle = '#b8202c';
    ctx.lineWidth = 18;
    ctx.strokeRect(9, 9, 494, 198);
    ctx.fillStyle = '#14110e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 78px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillText('DO NOT', 256, 78, 430);
    ctx.fillText('PRESS', 256, 152, 430);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** The countdown plate. Amber when the button is charged, grey when it is not. */
function drawReadout(ctx: CanvasRenderingContext2D | null, text: string, ready: boolean): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, 512, 96);
  ctx.fillStyle = 'rgba(10, 12, 16, 0.78)';
  roundRect(ctx, 2, 2, 508, 92, 14);
  ctx.fill();
  ctx.strokeStyle = ready ? 'rgba(255, 182, 72, 0.9)' : 'rgba(150, 150, 158, 0.45)';
  ctx.lineWidth = 3;
  roundRect(ctx, 2, 2, 508, 92, 14);
  ctx.stroke();
  ctx.fillStyle = ready ? '#ffcf80' : '#c9ccd4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 40px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.fillText(text, 256, 50, 470);
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * **The face itself, drawn from scratch, fifteen times a second.**
 *
 * ---------------------------------------------------------------------------
 * WHY A CANVAS AND NOT A SHADER, AND WHY NOT A SPRITE SHEET.
 *
 * A shader would be the cheap answer and it is the wrong one: the artwork is a
 * dozen filled paths with a stroke on them, which is four lines of Canvas and
 * about two hundred of signed-distance-field arithmetic, and every one of those
 * two hundred would be recompiled by anybody who wanted the mouth a bit wider.
 * A sprite sheet of eight frames would be cheaper again and loses the *jitter*:
 * the brief asks for a jaw on a 0.7 s loop with slight wobble on top, and eight
 * frames on a loop is a thing the eye locks onto within two cycles. Redrawing
 * means the wobble can be aperiodic for free.
 *
 * At 256 px this is a 262 kB upload fifteen times a second -- 3.9 MB/s -- and
 * **only while the face is up and the sun is above the horizon**, which is at
 * most half of one in-game day in every three. The rest of the time this
 * function is not called and the material is not drawn.
 *
 * ---------------------------------------------------------------------------
 * `Math.sin` is used freely in here and that is fine. The determinism rule in
 * `game/traffic.ts`'s header is about anything **evaluated on both ends**; this
 * is a canvas on one client, driven by that client's own frame clock, and
 * nothing about it crosses the wire. What crosses the wire is two integers.
 */
function drawScreamFace(ctx: CanvasRenderingContext2D | null, size: number, t: number, mouth = 1): void {
  if (!ctx) return;
  const c = size / 2;
  const discR = (size * DISC_SHARE) / 2;

  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  /* --- The rays. Fourteen jagged spikes, each with its own phase, wobbling in
   *     length and in angle. They are drawn *first* so the disc covers their
   *     roots -- a spike whose base is visible reads as a starburst rather than
   *     as something the sun is doing. */
  const spikes = 14;
  ctx.fillStyle = '#ffca2e';
  ctx.strokeStyle = '#8a4a05';
  ctx.lineWidth = size * 0.012;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    // Two incommensurate rates per spike, so the ring of them never lines up
    // into a pulse. 3.7 and 2.3 have no small common multiple, which is the
    // whole of why those two numbers.
    const wob = Math.sin(t * 3.7 + i * 1.9) * 0.5 + Math.sin(t * 2.3 + i * 0.7) * 0.5;
    const len = discR * (1.24 + 0.17 * wob);
    const half = (Math.PI / spikes) * 0.62;
    const skew = Math.sin(t * 2.9 + i) * 0.06;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a - half) * discR * 0.98, c + Math.sin(a - half) * discR * 0.98);
    ctx.lineTo(c + Math.cos(a + skew) * len, c + Math.sin(a + skew) * len);
    ctx.lineTo(c + Math.cos(a + half) * discR * 0.98, c + Math.sin(a + half) * discR * 0.98);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // --- The disc. A radial gradient rather than a flat fill, because a flat
  //     yellow circle at this size reads as a smiley sticker and a hot centre
  //     falling to orange at the rim reads as something on fire.
  const grad = ctx.createRadialGradient(c, c * 0.9, discR * 0.15, c, c, discR);
  grad.addColorStop(0, '#fff6bd');
  grad.addColorStop(0.55, '#ffd12a');
  grad.addColorStop(1, '#ff9014');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, discR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7a3d04';
  ctx.lineWidth = size * 0.016;
  ctx.stroke();

  // --- The eyes: squinting, which is two arcs meeting at the corners rather
  //     than two circles. A circular eye is a surprised face; the brief asks for
  //     a scream, and a scream squints.
  const eyeDx = discR * 0.36;
  const eyeY = c - discR * 0.24;
  const eyeW = discR * 0.30;
  const squint = 0.30 + 0.07 * Math.sin(t * 5.1);
  ctx.fillStyle = '#3a1d02';
  for (const s of [-1, 1]) {
    const ex = c + s * eyeDx;
    ctx.beginPath();
    ctx.moveTo(ex - eyeW, eyeY);
    ctx.quadraticCurveTo(ex, eyeY - eyeW * squint * 2.4, ex + eyeW, eyeY);
    ctx.quadraticCurveTo(ex, eyeY + eyeW * squint * 2.4, ex - eyeW, eyeY);
    ctx.closePath();
    ctx.fill();
    // The brow, angled down toward the nose. This one line is the difference
    // between "screaming" and "yawning".
    ctx.strokeStyle = '#3a1d02';
    ctx.lineWidth = size * 0.026;
    ctx.beginPath();
    ctx.moveTo(ex - s * eyeW * 1.15, eyeY - eyeW * 0.95);
    ctx.lineTo(ex + s * eyeW * 1.15, eyeY - eyeW * 1.75);
    ctx.stroke();
  }

  /* --- The mouth. The jaw follows the *sound*: `mouth` is the envelope of the
   *     scream clip that is playing (0 between clips), and `jawOpen` maps it to
   *     the opening with the old 0.7 s cycle and the faster jitter surviving only
   *     as a wobble that breathes a held scream by up to 15 %. With no scream the
   *     mouth is a thin closed line -- the owner's rule: it only opens when the
   *     noise is playing. */
  const cycle = (t % JAW_PERIOD_S) / JAW_PERIOD_S;
  const wobble = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);
  const jaw = jawOpen(mouth, wobble);
  const jitter = 1 + 0.06 * Math.sin(t * 17.3) * mouth;
  const mouthW = discR * 0.52;
  const mouthH = discR * 0.56 * jaw * jitter;
  const mouthY = c + discR * 0.34;
  ctx.fillStyle = '#8c1206';
  ctx.beginPath();
  ctx.ellipse(c, mouthY, mouthW, mouthH, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a1d02';
  ctx.lineWidth = size * 0.018;
  ctx.stroke();
  // The tongue, at the bottom of the throat, moving a little slower than the
  // jaw. Four filled pixels of anatomy that stop the mouth reading as a hole.
  ctx.fillStyle = '#e0483a';
  ctx.beginPath();
  ctx.ellipse(
    c,
    mouthY + mouthH * 0.46,
    mouthW * 0.52,
    mouthH * 0.3,
    Math.sin(t * 4.1) * 0.12,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

/**
 * Startup self-check.
 *
 * The rules are checked by `game/sunbutton.verifySunButton`, which runs on both
 * ends. What is left here is the things only the *renderer* can get wrong, and
 * the test for whether one belongs is `verifyDoorMarker`'s: it has to be a
 * failure that produces a picture rather than an error. Three qualify.
 */
export function verifySunButtonRenderer(): string[] {
  const bad: string[] = [];

  // --- 1. The face is between ten and sixteen times the real sun. Under that
  //        and it is a smudge nobody can see a mouth on (five times was tried
  //        and was); over it and it is a planet, not a sun.
  const times = FACE_DEGREES / 0.53;
  if (!(times >= 10 && times <= 16)) {
    bad.push(
      `The screaming face is ${times.toFixed(2)}x the real sun's angular size; the band is 10-16x. ` +
        `Below 10 the mouth is not legible at the base field of view and above 16 it reads as a planet.`,
    );
  }

  // --- 2. It is inside the far plane. A quad outside it is clipped away
  //        entirely and the feature is simply invisible, with nothing in the
  //        console -- which is the exact shape of an afternoon lost.
  const halfExtent = FACE_DISTANCE_M * Math.tan(((FACE_DEGREES / DISC_SHARE) * Math.PI) / 360);
  if (FACE_DISTANCE_M + halfExtent > 24000) {
    bad.push(
      `The face's far corner is at ${(FACE_DISTANCE_M + halfExtent).toFixed(0)} m, past the 24 km ` +
        `far plane. It would be clipped away with nothing to say so.`,
    );
  }

  // --- 3. The two button states differ in colour on both the ring and the
  //        dome. `verifyDoorMarker`'s claim, for the same reason: a cooldown
  //        that looks like readiness is a player pressing a dead button and
  //        concluding the key is broken.
  if (READY_COLOUR === COOLING_COLOUR) bad.push('The ring is the same colour ready and cooling.');
  if (DOME_READY === DOME_COOLING) bad.push('The dome is the same colour ready and cooling.');

  // --- 4. The readout switches on further out than the prompt does. The other
  //        way round, a player would be told "the button is recharging" by the
  //        HUD with nothing on the prop agreeing, which reads as two features
  //        rather than one.
  if (!(SUN_READOUT_M > SUN_PROMPT_M)) {
    bad.push(
      `The readout reaches ${SUN_READOUT_M} m and the prompt ${SUN_PROMPT_M} m; the plinth must ` +
        `start explaining itself before the HUD does.`,
    );
  }

  return bad;
}
