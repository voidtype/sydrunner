/**
 * The handset: a rounded slab with a lit screen, held up when the phone is out.
 *
 * `player/bat.ts` in miniature, and deliberately so -- the two objects have the
 * same job (a thing in your hand, drawn twice: once on your body for its shadow
 * and once in front of your eye for you) and copying its arrangement is what
 * keeps `main.ts`'s two call sites symmetrical. Everything structural here is
 * `bat.ts`'s and is not re-argued:
 *
 *   - **Two classes.** `PhoneProp` parents itself to `BONE.WRIST_R` so it moves
 *     with the skeleton for free and costs no matrix decompose a frame;
 *     `PhoneViewmodel` parents to the camera and is what the player looks at.
 *   - **`castShadowOnly` on the prop**, because three does not inherit layers
 *     and a prop on a bone of a shadow-layer mesh is otherwise drawn in front
 *     of your own eye at hip height.
 *   - **`frustumCulled = false`** on both, because a 14 cm object on a figure
 *     that is already frustum-tested has nothing to gain from a test of its own.
 *   - **One shared `PhoneAssets`**, so every phone in the world is one geometry
 *     and two materials.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCREEN IS A SECOND MATERIAL AND NOT A TEXTURE
 *
 * The screen has to be **emissive** -- it is a light source at night, which is
 * the whole reason a phone reads as a phone in a dark street -- and it has to
 * be a different colour from the body. Both of those are material properties,
 * and this project's one texture-free rule for props (see `BatAssets`, which
 * paints its splice with vertex colours rather than a map) means the choice is
 * between a vertex-colour blend on one material and two materials on two
 * groups.
 *
 * Two materials, because emission is not a vertex attribute in this pipeline:
 * an emissive term driven by a vertex colour would light the whole slab at the
 * screen's intensity wherever the blend was non-zero, and the bezel would glow.
 * Two draw calls for an object that exists at most twice on screen (your prop
 * and your viewmodel) is not a cost worth avoiding.
 *
 * ---------------------------------------------------------------------------
 * IT IS 71 x 146 x 8 MILLIMETRES
 *
 * A real phone, because everything else in this world is measured: the city is
 * geometrically accurate, the bat is a real cricket bat's 0.83 m, and a handset
 * that was 20 cm long would be the one object in Sydney that is not the size of
 * the thing it is. The viewmodel scales it up (see `VIEW_SCALE`) for the same
 * reason `BatViewmodel` scales the bat *down* -- a viewmodel is drawn at
 * whatever size reads, and for something this small that means bigger.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import { BONE } from '../player/animation.ts';
import { CharacterActor, SELF_SHADOW_LAYER } from '../player/character.ts';
import type { WarmupPart } from './warmup.ts';

/** Metres. A phone, at the size a phone is. */
const WIDTH = 0.071;
const HEIGHT = 0.146;
const DEPTH = 0.008;
/** How far in from the edge the glass starts. A 3 mm bezel, as phones have. */
const BEZEL = 0.003;

/**
 * How far the screen stands proud of the body, metres.
 *
 * A quarter of a millimetre, which is not a design decision about phones -- it
 * is z-fighting. Two coplanar quads at this distance from the eye flicker
 * between them per pixel per frame, and the viewmodel is 50 cm from the camera
 * where the depth buffer's precision is at its best and the artefact is at its
 * most visible.
 */
const SCREEN_LIFT = 0.00025;

/**
 * The body colour and the screen's.
 *
 * The body is the near-black the phone overlay's bezel is (`#0b0f14` in
 * `index.html`), so the object in your hand and the panel it opens are the same
 * device. The screen is the interface's blue at full value, emissive, which is
 * the same `#cfe2f2` every readable thing in this game is drawn in.
 */
const BODY_COLOUR = 0x0b0f14;
const SCREEN_COLOUR = 0xcfe2f2;

/**
 * How brightly the screen glows.
 *
 * 1.4 rather than 1.0: at 1.0 the emissive term is exactly the albedo and the
 * screen reads as a light-grey sticker in daylight. Above about 2 it blooms
 * into the bezel at night and the phone becomes a torch, which is `KeyF`'s job
 * and not this object's.
 */
const SCREEN_GLOW = 1.4;

/**
 * Geometry and materials, built once and shared by every phone in the world.
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN SHOWS THE MAP, AND IT IS THE MINIMAP'S OWN BITMAP
 *
 * "Maps live on the phone" is a claim about the interface, and the object in
 * your hand should not contradict it by being a blank glowing rectangle. So the
 * screen is textured with `Minimap.canvas` -- the 2D canvas the compass is
 * already rasterising into, fifteen times a second, whether or not this exists.
 * There is no second draw, no second clear and no second `prismsWithin`: this is
 * a `CanvasTexture` over the same bitmap, uploaded on the frames it changed.
 *
 * **It is the `emissiveMap` and not the `map`.** The screen is a light source at
 * night, which is the whole reason it reads as a phone in a dark street, and an
 * albedo texture is not lit by anything at 2 am. Driving the *emission* with the
 * map means the pale ink glows and the transparent parts of the minimap canvas
 * -- everything outside the disc, which is most of the corners -- emit nothing
 * and read as dark glass. That is what a phone showing a dark map looks like.
 *
 * The square canvas lands in the **top** of a portrait screen and the bottom
 * stays dark, which is done in the UVs rather than by compositing a second
 * canvas: `quad` puts v = 1 at the top edge and lets v run negative below the
 * square, and `ClampToEdgeWrapping` extends the canvas's bottom row -- which is
 * outside the disc and therefore transparent -- down to the chin. A stretched
 * compass would have been the alternative and it is not one: a rotating map at a
 * 2:1 vertical stretch is unreadable and, worse, wrong.
 *
 * A phone with no canvas handed in keeps the flat emissive screen it had before
 * this pass, and that is a working configuration rather than an error path --
 * see `verifyPhoneModel`'s counterpart argument about a `Gallery` with no
 * storage. It is also what a caller gets in a test.
 */
export class PhoneAssets {
  readonly body: BufferGeometry;
  readonly screen: BufferGeometry;
  readonly bodyMaterial: MeshStandardNodeMaterial;
  readonly screenMaterial: MeshStandardNodeMaterial;
  /** The map on the glass, or null on a phone that was given no canvas. */
  private readonly screenTexture: CanvasTexture | null;

  constructor(screenCanvas: HTMLCanvasElement | null = null) {
    this.body = slab(WIDTH, HEIGHT, DEPTH);
    // A flat quad rather than a second slab: the glass has no thickness worth
    // drawing and a box here would be twelve triangles instead of two.
    this.screen = quad(WIDTH - BEZEL * 2, HEIGHT - BEZEL * 2, DEPTH / 2 + SCREEN_LIFT);
    this.bodyMaterial = new MeshStandardNodeMaterial({
      color: BODY_COLOUR,
      // Glassy-plastic: a phone back is not a matte object, and at this size the
      // only thing roughness buys is a highlight that says which way it is
      // facing.
      roughness: 0.34,
      metalness: 0.1,
    });
    this.screenMaterial = new MeshStandardNodeMaterial({
      color: SCREEN_COLOUR,
      emissive: SCREEN_COLOUR,
      emissiveIntensity: SCREEN_GLOW,
      roughness: 0.9,
      metalness: 0,
    });

    let texture: CanvasTexture | null = null;
    if (screenCanvas !== null) {
      try {
        texture = new CanvasTexture(screenCanvas);
        // Clamped, because the UVs deliberately run outside [0,1] below the
        // square -- see the header. Repeating would tile the compass down the
        // chin of the phone, and mirroring would put an upside-down one there.
        texture.wrapS = ClampToEdgeWrapping;
        texture.wrapT = ClampToEdgeWrapping;
        // No mipmaps: this bitmap is replaced fifteen times a second and
        // regenerating a chain each time is the one cost that would make this
        // arrangement expensive. Linear both ways is right for an object that is
        // 7 cm across and never seen at a distance where a mip would help.
        texture.generateMipmaps = false;
        texture.minFilter = LinearFilter;
        texture.magFilter = LinearFilter;
        this.screenMaterial.emissiveMap = texture;
        // The albedo stays the flat screen colour. Only the emission is the map;
        // see the header for why that is the readable half.
      } catch {
        // A renderer or a canvas that will not make a texture. The phone keeps
        // its plain lit screen, which is exactly what it had before this pass.
        texture = null;
      }
    }
    this.screenTexture = texture;
  }

  /**
   * The map on the glass has changed. Called from the frame loop.
   *
   * A flag rather than an upload: three re-uploads the canvas at the next draw
   * that uses the material, so setting this every frame costs one boolean write
   * and setting it never means a screen frozen on the first frame the phone was
   * drawn. It is set unconditionally rather than gated on the minimap's own
   * 15 Hz clock because the two clocks are not synchronised and a missed frame
   * would be a visibly stuttering screen -- the upload is the same bitmap and
   * the driver's own dirty tracking is the thing that makes it cheap.
   */
  refreshScreen(): void {
    if (this.screenTexture !== null) this.screenTexture.needsUpdate = true;
  }

  /** Is the handset showing the compass, or a blank lit rectangle? */
  get screenIsMap(): boolean {
    return this.screenTexture !== null;
  }

  get triangles(): number {
    return 12 + 2;
  }
}

/**
 * Where in the wrist's frame the phone sits, and how it is turned.
 *
 * `BatProp.HOLD_OFFSET`'s numbers, adjusted for an object held flat in the palm
 * rather than gripped in a fist: 6 cm below the wrist joint is the middle of
 * the hand, and the pitch stands the phone up so the screen faces the face
 * rather than the ceiling. A phone lying flat in the palm is what a phone looks
 * like when you are *not* using it, which is the one pose this prop never
 * needs -- it is only ever attached while the phone is the primary slot.
 */
const HOLD_OFFSET: readonly [number, number, number] = [0.008, -0.062, 0.02];
const HOLD_PITCH = -1.15;
const HOLD_YAW = 0.22;

/**
 * The boot warm-up entries: the slab and the glass, in the three configurations
 * the two objects between them are ever drawn in.
 *
 * WORKSTREAM AE. The viewmodel is in the scene from `installMoney` onward and
 * so the boot scene pass does reach it -- but only because `PhoneViewmodel`
 * starts `visible` and nothing has posed it yet when that pass runs. The moment
 * one `update` lands first, `raise = 0` sets `visible = false` and both its
 * pipelines move to the frame the player first presses the key. That is a
 * one-line change away at all times, and `main.ts` has already paid for the same
 * accident twice (see the `sky.stars.visible` paragraph at the scene pass).
 *
 * **`PhoneProp` is not a maybe.** It is built on a slot change and destroyed on
 * the next one, so it is never in the scene at boot at all: its casting body was
 * a compile on the frame somebody first took their phone out, every session.
 * Its colour pipeline is the viewmodel's -- same material, same layout, same
 * `receiveShadow` -- and what it adds is the **depth** variant, which is why the
 * casting entry is here on its own terms rather than folded into the row above.
 */
export function phoneWarmupParts(assets: PhoneAssets): WarmupPart[] {
  return [
    // The viewmodel's slab: welded to the eye, so out of the depth pass, but it
    // keeps `receiveShadow` so it darkens under an awning. See `PhoneViewmodel`.
    { geometry: assets.body, material: assets.bodyMaterial, casts: false, receives: [true] },
    // The prop's slab on a character's wrist, which is the same colour pipeline
    // and one depth pipeline more.
    { geometry: assets.body, material: assets.bodyMaterial, casts: true, receives: [true] },
    // The glass, in both objects: never in the depth pass -- it is inside the
    // slab's silhouette -- and never receiving, because it is emissive.
    { geometry: assets.screen, material: assets.screenMaterial, casts: false, receives: [false] },
  ];
}

/**
 * One character's phone. Attaches on construction, detaches on `dispose`.
 *
 * **Unlike `BatProp`, this is created and destroyed rather than hidden**, and
 * the asymmetry is the difference between the two objects: a bat is never put
 * away (spec 8.2's melee is always available, and `BatProp` says so in as many
 * words), where a phone is out only while it is the slot you have selected. So
 * `main.ts` builds one when the slot changes and disposes it when it changes
 * again, which costs one `Mesh` allocation on a keypress and keeps the
 * scene graph honest about what is being held.
 */
export class PhoneProp {
  readonly group: Group;

  constructor(assets: PhoneAssets, actor: CharacterActor, hand: 'right' | 'left' = 'right') {
    const group = new Group();
    group.name = 'phone';
    group.frustumCulled = false;
    group.position.set(HOLD_OFFSET[0], HOLD_OFFSET[1], HOLD_OFFSET[2]);
    // The off hand is a mirror of the near one about the body's plane, which is
    // one sign rather than a second set of numbers -- the same trick
    // `character.ts` uses for the arms.
    group.rotation.set(HOLD_PITCH, hand === 'right' ? HOLD_YAW : -HOLD_YAW, 0);

    const body = new Mesh(assets.body, assets.bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    const screen = new Mesh(assets.screen, assets.screenMaterial);
    // The glass casts nothing: it is inside the slab's silhouette, so its
    // shadow is the slab's, and asking the depth pass to draw it again is two
    // triangles per shadow cascade for a shape that is already there.
    screen.castShadow = false;
    screen.receiveShadow = false;
    screen.frustumCulled = false;
    group.add(body, screen);

    actor.bones[hand === 'right' ? BONE.WRIST_R : BONE.WRIST_L].add(group);
    this.group = group;
  }

  /** Seen by the sun, not by the eye. `BatProp.castShadowOnly`'s counterpart. */
  castShadowOnly(): void {
    for (const child of this.group.children) {
      child.layers.set(SELF_SHADOW_LAYER);
    }
    this.group.layers.set(SELF_SHADOW_LAYER);
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

/**
 * How much bigger than life the viewmodel is drawn.
 *
 * 1.25, where `BatViewmodel` uses 0.58 -- and the two are the same decision in
 * opposite directions. A viewmodel is drawn at the size that reads on screen,
 * not at the size the object is: a real bat held where a hand really is fills a
 * third of the frame, and a real phone at the same distance is a postage stamp
 * you cannot tell from a wallet.
 *
 * **It was 2.2 and that was measured, not guessed at.** At 2.2 and 40 cm the
 * handset was 500 px tall on a 1440x773 frame -- two thirds of the screen
 * height, reading as a wall rather than as a phone, and covering the DOM
 * overlay it exists to introduce. 1.25 at 52 cm puts it at about a quarter of
 * the frame, in the lower right, under the panel and beside it rather than
 * behind it.
 */
const VIEW_SCALE = 1.25;

/**
 * Where the raised phone sits relative to the eye, metres. Right, down, forward.
 *
 * Pushed right and down from where a bat sits, because the DOM overlay it opens
 * is in the lower right and the object and the panel should read as one thing.
 */
const VIEW_REST: readonly [number, number, number] = [0.26, -0.26, -0.52];
/** And how it is angled: tipped back towards the face, turned slightly inward. */
const VIEW_PITCH = -0.34;
const VIEW_YAW = -0.28;

/** How hard it lags a mouse turn, and how fast the lag decays. `BatViewmodel`'s. */
const SWAY_GAIN = 0.045;
const SWAY_TAU = 0.1;
/** How far it bobs with a stride, metres at a sprint. Under the bat's 0.026. */
const BOB_AMOUNT = 0.016;

/**
 * The phone in front of your eye.
 *
 * `BatViewmodel`'s shape with the swing taken out, which is most of it: a phone
 * has no phases, so what is left is the sway, the bob and the raise. The raise
 * is the one thing here the bat does not have -- see `update`.
 */
export class PhoneViewmodel {
  readonly group: Group;

  private clock = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private seeded = false;
  private stride = 0;
  /** 0 down and out of frame, 1 fully raised. Eased in `update`. */
  private raise = 0;

  constructor(assets: PhoneAssets) {
    const group = new Group();
    group.name = 'phone:viewmodel';
    group.frustumCulled = false;
    group.scale.setScalar(VIEW_SCALE);

    const body = new Mesh(assets.body, assets.bodyMaterial);
    // Never in the depth pass, on `BatViewmodel`'s argument: a phone welded to
    // the eye would cast a shadow from head height that follows the player
    // around the footpath.
    body.castShadow = false;
    // Receiving is kept, and is what stops it looking pasted on: walk into a
    // terrace's shadow and the phone goes with you.
    body.receiveShadow = true;
    body.frustumCulled = false;
    const screen = new Mesh(assets.screen, assets.screenMaterial);
    screen.castShadow = false;
    screen.receiveShadow = false;
    screen.frustumCulled = false;
    group.add(body, screen);

    this.group = group;
  }

  /**
   * Pose it for this frame.
   *
   * Frame delta rather than the fixed step, on `BatViewmodel.update`'s rule: the
   * simulation is fixed so prediction and rewind agree, and a viewmodel is
   * presentation and has to be smooth at whatever rate the display runs.
   *
   * **The raise is eased rather than snapped**, and it is the one piece of
   * animation in this class. A phone that appeared fully raised on the frame
   * the key went down would read as a UI element rather than as an object; a
   * quarter-second ease reads as a hand coming up, which is what makes the
   * overlay that follows feel like it belongs to something. It is also what
   * hides the object cleanly: at `raise = 0` the group is below the frame and
   * `visible` goes false, so a phone that is not out costs nothing.
   */
  update(
    dt: number,
    state: {
      /** Is the phone the primary slot? Drives the raise. */
      out: boolean;
      /** Horizontal speed, m/s. Drives the bob. */
      speed: number;
      /** The camera's yaw and pitch, radians. The sway is their derivative. */
      yaw: number;
      pitch: number;
      /** First person only. A third-person camera draws the prop instead. */
      firstPerson: boolean;
    },
  ): void {
    this.clock += dt;

    // Seeded on the first frame, or the sway starts with the whole of the
    // camera's initial yaw as its derivative and the phone swings in from
    // off-screen. `BatViewmodel` seeds for the same reason.
    if (!this.seeded) {
      this.lastYaw = state.yaw;
      this.lastPitch = state.pitch;
      this.seeded = true;
    }

    const target = state.out && state.firstPerson ? 1 : 0;
    // An exponential ease, framerate-independent: `1 - exp(-dt/tau)` is the
    // same curve at 30 fps and at 240, where a plain `lerp(a, b, 0.2)` is four
    // times faster on the fast display. The project makes this argument in
    // `game/feedback.ts` and in the sway below.
    this.raise += (target - this.raise) * (1 - Math.exp(-dt / 0.07));
    this.group.visible = this.raise > 0.01;
    if (!this.group.visible) return;

    // Sway: the camera's angular velocity, low-passed, applied as a lag.
    const dYaw = wrap(state.yaw - this.lastYaw);
    const dPitch = state.pitch - this.lastPitch;
    this.lastYaw = state.yaw;
    this.lastPitch = state.pitch;
    const decay = 1 - Math.exp(-dt / SWAY_TAU);
    this.swayYaw += (dYaw * SWAY_GAIN - this.swayYaw) * decay;
    this.swayPitch += (dPitch * SWAY_GAIN - this.swayPitch) * decay;

    // Bob, advanced by **distance** rather than by time, exactly as
    // `CharacterActor` advances its stride: a phone that bobbed on a clock
    // would keep bobbing while you stood still.
    this.stride += state.speed * dt;
    const bob = Math.sin(this.stride * 3.4) * BOB_AMOUNT * Math.min(1, state.speed / 8.2);
    const sideBob = Math.sin(this.stride * 1.7) * BOB_AMOUNT * 0.6 * Math.min(1, state.speed / 8.2);

    // The raise itself: 18 cm of travel, so at 0 the phone is out of frame.
    const drop = (1 - this.raise) * 0.18;
    this.group.position.set(
      VIEW_REST[0] + sideBob - this.swayYaw,
      VIEW_REST[1] + bob - drop - this.swayPitch,
      VIEW_REST[2],
    );
    this.group.rotation.set(
      VIEW_PITCH + this.swayPitch * 2 - (1 - this.raise) * 0.5,
      VIEW_YAW + this.swayYaw * 2,
      0,
    );
  }
}

/** Shortest signed difference between two angles. `game/camera.ts`'s. */
function wrap(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

// --- Geometry -------------------------------------------------------------------

/**
 * A box, centred on the origin, with flat normals.
 *
 * Written out rather than `BoxGeometry`, for `BatAssets`' reason: three's box
 * carries UVs and a groups array this material never reads, and the whole
 * object is twelve triangles. Corners are **not** rounded -- a 3 mm fillet on
 * an object that is 8 mm thick and drawn at 40 cm is four extra rings of
 * vertices for a silhouette change of about one pixel.
 */
function slab(w: number, h: number, d: number): BufferGeometry {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  // Six faces, four vertices each, flat-shaded -- so each face's four vertices
  // carry that face's normal and nothing is shared between faces.
  const faces: Array<[number[], number[]]> = [
    [[-x, -y, z, x, -y, z, x, y, z, -x, y, z], [0, 0, 1]], // front (the screen side)
    [[x, -y, -z, -x, -y, -z, -x, y, -z, x, y, -z], [0, 0, -1]],
    [[x, -y, z, x, -y, -z, x, y, -z, x, y, z], [1, 0, 0]],
    [[-x, -y, -z, -x, -y, z, -x, y, z, -x, y, -z], [-1, 0, 0]],
    [[-x, y, z, x, y, z, x, y, -z, -x, y, -z], [0, 1, 0]],
    [[-x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z], [0, -1, 0]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [quadPositions, normal] of faces) {
    const base = positions.length / 3;
    positions.push(...quadPositions);
    for (let i = 0; i < 4; i++) normals.push(normal[0], normal[1], normal[2]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * A single front-facing quad at `z`, for the glass -- with UVs that put a
 * **square** texture in the top of a portrait screen.
 *
 * The one piece of arithmetic in this file that is not obvious, so it is worth
 * deriving. The screen is `w` by `h` metres with `h > w`, and the thing being
 * mapped onto it is a square bitmap (the compass). Filling the quad with
 * v ∈ [0, 1] would stretch that square to the screen's 1 : `h/w` aspect, which
 * for this handset is 1 : 2.16 -- a rotating map two-and-a-bit times taller than
 * it is wide, which is not a map.
 *
 * So the square is laid into the **top** of the screen at the screen's own
 * width, occupying `w / h` of its height, and the UVs are chosen to make that
 * true: v = 1 at the top edge (three's `flipY` puts the image's first row
 * there), and v = 1 − h/w at the bottom, which is negative for any portrait
 * screen. Everything below the square samples outside the texture and is
 * `ClampToEdgeWrapping`'d to the bitmap's bottom row -- which, on a circular
 * minimap in a square canvas, is fully transparent, so the chin of the phone
 * emits nothing and reads as dark glass. See `PhoneAssets`.
 *
 * A quad with no texture on it ignores all of this, which is why the attribute
 * is written unconditionally rather than only when a canvas was handed in: one
 * geometry, shared, and eight floats is not a cost.
 */
function quad(w: number, h: number, z: number): BufferGeometry {
  const x = w / 2;
  const y = h / 2;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-x, -y, z, x, -y, z, x, y, z, -x, y, z]), 3),
  );
  geometry.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  // Vertices are (bottom-left, bottom-right, top-right, top-left); see the
  // positions above.
  const vBottom = 1 - h / w;
  geometry.setAttribute(
    'uv',
    new BufferAttribute(new Float32Array([0, vBottom, 1, vBottom, 1, 1, 0, 1]), 2),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}
