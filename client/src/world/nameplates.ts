/**
 * Nameplates: a name and a large health bar over every **other** player's head.
 *
 * A user-ordered feature, and one that deliberately overrules the spec: 8.2's
 * "health pips in the corner" line goes on to say there are no world-space
 * health bars, and there are now. The order was "put a large health bar and name
 * above all other players names", so what is drawn here is exactly that -- the
 * roster name, and under it a bar wide enough to read across a street.
 *
 * Who gets one: **players and bots, and nobody else.** Not the local player, who
 * has the HUD and does not need to be told their own name; not the pedestrians,
 * the faction NPCs, the police or the ibises, who are scenery and would turn the
 * city into a labelled diagram. Offline, the three training dummies get plates
 * because they stand in for players -- see `main.ts`, which is the only file
 * that decides who is a player.
 *
 * --- Why this is one mesh, one material and one draw call ---
 *
 * The obvious build is a `Sprite` per player with a `SpriteNodeMaterial` and a
 * canvas texture of its own. That is fifteen materials, and this project has
 * already been killed once by per-object materials: a material is a WebGPU
 * pipeline, pipeline compilation blocks the main thread, and a pipeline compiled
 * the frame somebody joins is a hitch at the worst possible moment. Every other
 * shared-asset class in `world/` states the same rule (`PowerupAssets`,
 * `VegetationAssets`, `streamer.ts`'s facades) and this file keeps it.
 *
 * So: **one dynamic geometry, rewritten on the CPU every frame.** A plate is
 * five quads -- the bar's dark backing, the coloured fill, two pip ticks and the
 * name -- and the whole field at a full sixteen-player lobby is fifteen plates,
 * 75 quads, 300 vertices. Writing 300 vertices a frame is nothing; it is less
 * work than the matrix maths an instanced path would need to do anyway, because
 * the billboard has to be recomputed per frame either way. What it buys is that
 * *everything* varies per plate for free -- position, fill fraction, colour,
 * fade alpha, and the name's own sub-rectangle of the atlas -- with no instance
 * attributes, no custom TSL, and one pipeline for the feature.
 *
 * The name text is the one thing that cannot be computed: it is a canvas raster.
 * All of them live in **one atlas texture**, one name per 64-pixel row, and a
 * plate selects its name with UVs. The cache is keyed by the string, exactly as
 * a text cache should be -- two players called Bazza and Bazza would share a
 * row, and the same player asked for twenty times a second draws once ever.
 *
 * --- Occlusion ---
 *
 * Plates are drawn **through walls** (`depthTest = false`). This was a choice
 * against the alternative, which is free -- leave the depth test on and let the
 * city hide them:
 *
 *   - It is a sixteen-player brawler in a dense CBD. Knowing that Shazza is on
 *     two pips somewhere behind the Queen Victoria Building is the read the
 *     feature exists to give. Depth-tested plates blink in and out behind every
 *     awning, veranda post and parked car between you and them, which is worse
 *     than either extreme.
 *   - It costs nothing. The alternative that gets *both* -- solid in the open,
 *     dimmed through geometry -- is an occlusion raycast per player per frame,
 *     and this file will not spend that.
 *   - The distance fade is what bounds the noise. Nothing is drawn past 65 m, so
 *     "through walls" means through the block you are fighting in, not a map of
 *     the whole city painted over the sky.
 *
 * --- Shadows ---
 *
 * Nothing here casts. `castShadow` is left false on the mesh, which is enough:
 * `character.castShadowOnly` explains the layer scheme this project uses, and
 * the sun's shadow camera only picks up layer 0 objects that opt in with
 * `castShadow`. A translucent unlit quad in the depth pass would put a hard
 * rectangle of shadow on the footpath under every player.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  SRGBColorSpace,
} from 'three/webgpu';
import { texture } from 'three/tsl';
import { FIGURE_HEIGHT } from '../player/animation.ts';

// --- Sizes, in world metres ---------------------------------------------------

/**
 * The bar. "Large" was the whole of the order, so this is 1.25 m across and 13
 * cm tall -- three quarters of the width of the figure it sits over, and about
 * as tall as its head is wide. At 10 m that is roughly 100 x 11 screen pixels on
 * a 1080p display, which is a bar you read rather than a bar you squint at.
 */
export const BAR_WIDTH = 1.25;
export const BAR_HEIGHT = 0.13;

/**
 * The dark margin around the bar.
 *
 * Not decoration. Sydney at 3 pm is the brightest surface this game has, and a
 * green bar against a white-rendered wall in full sun has no edge at all
 * without it. The same argument the HUD makes with its text shadows, in world
 * space.
 */
const BAR_BORDER = 0.022;

/** The two ticks that cut the bar into thirds. See `MAX_PIPS`. */
const TICK_WIDTH = 0.016;

/**
 * Pips, and the reason this file has the number at all.
 *
 * `combat.MAX_HEALTH` is 3 and this must agree with it, but importing the combat
 * module into a rendering one to read a single integer would drag the whole
 * simulation into the render path's dependency graph. It is restated here and
 * `verifyNameplates` is handed the real value by `main.ts` to check against --
 * the same shape `game/dummies.ts` uses for the three ranges it restates from
 * `server/bots.ts`.
 */
export const MAX_PIPS = 3;

/** The name band's height. The bar is the loud half; this is the label. */
export const NAME_HEIGHT = 0.27;
/** A long name is scaled down rather than allowed to overhang the bar. */
const NAME_MAX_WIDTH = 1.45;
/** Between the top of the bar's backing and the bottom of the name. */
const NAME_GAP = 0.06;

/**
 * How far over the head bone the bottom of the bar sits.
 *
 * The order asked for the plate to be above the head, and the head bone is not
 * the top of the head: `character.ts` puts `HEAD_CENTRE` at 1.445 with a
 * vertical radius of 0.25, so the crown is at 1.695 -- against a head bone whose
 * rest chain in `animation.RIG` adds to 1.25. That is 0.445 m of skull above the
 * bone, and 0.55 m of clear air above the skull is what this adds to it.
 *
 * Measured from the **bone** rather than from the figure's feet on purpose. The
 * bone is where the head actually is: a knocked-out body is face down in the
 * street with its head 30 cm off the ground, a rider on a lime bike is seated
 * and 20 cm lower than they stand, and a fixed offset over the feet would leave
 * the plate hanging in the air over both. See `verifyNameplates`, which pins the
 * standing case against `FIGURE_HEIGHT`.
 */
export const PLATE_RISE = 1.0;

// --- Distance behaviour -------------------------------------------------------

/** Full opacity out to here. A city block. */
export const FADE_FULL = 35;
/** Gone by here. Past this nothing is drawn at all. */
export const FADE_OUT = 65;

/**
 * The screen-size floor.
 *
 * Without it a plate fades out from something that was already illegible, which
 * reads as a bug rather than as a fade -- the bar "disappears" long before the
 * fade is doing anything to it. Past `CLAMP_FROM` the plate grows with distance
 * to the power `CLAMP_POWER`, which is neither a fixed world size (a bar one
 * pixel tall) nor a fixed screen size (a distant player's plate looming the same
 * size as the one in front of you, which destroys the depth read completely).
 *
 * **The first cut of this was far too timid and was caught in a screenshot.** At
 * 18 m and a square-root curve, a 13 cm bar at 45 m came out about a pixel and a
 * half tall on a 1080p display -- there was nothing there to fade. These numbers
 * hold the bar between roughly 5 and 8 pixels tall all the way from 12 m to the
 * cut-off, which is a bar, while a plate at 60 m still comes out at about 62% of
 * the apparent size of one at 12 m, which is still a distance. `CLAMP_MAX` is a
 * guard rather than a working limit: the curve does not reach it before the fade
 * has removed the plate anyway.
 */
const CLAMP_FROM = 12;
const CLAMP_POWER = 0.7;
const CLAMP_MAX = 3.4;

// --- Colour -------------------------------------------------------------------

/**
 * Everything is multiplied by this before it goes in the buffer.
 *
 * The renderer's node pipeline tone maps every material -- `Material.toneMapped`
 * is honoured by the WebGL renderer only, and this project is WebGPU -- so a
 * plate written as pure white comes out grey. `main.ts` runs Neutral at an
 * exposure of 0.62, under which a linear 1.0 lands at about 0.79 sRGB. At 1.45
 * it lands at 0.93, which is the near-white the order asked for. This is the
 * whole of the compensation and it is deliberately one number: the palette below
 * is written in the sRGB hex the HUD uses, so the two can be compared by eye in
 * a stylesheet rather than in a shader.
 */
const PLATE_GAIN = 1.45;

/**
 * The three bar colours, and where they come from.
 *
 * Red is `#f0a9a0`, which is not a new decision -- `index.html` establishes it as
 * the only red in the interface, on the last health pip and on the knockout
 * banner, and a bar that turns a *different* red at one pip would be saying
 * something the HUD is not. Amber is its warm neighbour at the same lightness.
 *
 * Green is the one addition. The HUD has no green at all, which is exactly why
 * it is safe: nothing else in this game is this colour, so a full bar cannot be
 * mistaken for anything. It is a mint rather than a grass green because the two
 * backdrops that matter are a hard blue sky and buff Hawkesbury sandstone (spec
 * 7.1 and 7.3), and a leaf green sits badly on both -- and this suburb is full
 * of trees, which a bar must not read as.
 *
 * All three are more saturated than they look here, and deliberately: `PLATE_GAIN`
 * multiplies every channel, which brightens toward white, so a colour picked to
 * look right in a stylesheet comes out washed on screen. These were picked
 * against a screenshot at the far end of that chain rather than in a swatch.
 */
const HEALTHY = /*#__PURE__*/ new Color().setHex(0x4ed292, SRGBColorSpace);
const HURT = /*#__PURE__*/ new Color().setHex(0xf2c25a, SRGBColorSpace);
const DANGER = /*#__PURE__*/ new Color().setHex(0xf0a9a0, SRGBColorSpace);

/** The bar's backing and the pip ticks. The page background, at `index.html`'s `#0b0d10`. */
const BACKING = /*#__PURE__*/ new Color().setHex(0x0b0d10, SRGBColorSpace);
const BACKING_ALPHA = 0.66;
/** The ticks sit *over* the fill, so they are the backing again at a lighter touch. */
const TICK_ALPHA = 0.5;

/**
 * A downed player's plate: dimmed, and the empty bar's track goes red.
 *
 * Tuned against a screenshot rather than picked, and the first numbers were too
 * timid -- 0.45 over the backing's own 0.5 left a hollow bar at 0.22 alpha,
 * which against sunlit grass was a smudge. The read this has to deliver is
 * "somebody is down over there, and they are getting up in a moment", so it has
 * to survive being glanced at. Dim enough to lose to a living player's plate,
 * bright enough to be one.
 */
const DOWN_DIM = 0.6;
const DOWN_BACKING_ALPHA = 0.9;

// --- The name atlas -----------------------------------------------------------

const ATLAS_WIDTH = 512;
const ATLAS_HEIGHT = 1024;
/** One name per row. */
const SLOT_HEIGHT = 64;
/** Room around the glyphs so a mip level does not bleed the row above into it. */
const SLOT_PAD_X = 10;
const SLOT_PAD_Y = 6;

/**
 * Row 0 is not a name. It holds the flat white patch every non-text quad samples,
 * which is what lets the bar and the labels share one material and one draw call.
 */
const WHITE_PATCH = 24;

/**
 * Fifteen names, which is not an arbitrary number: spec 2 caps this game at
 * sixteen players and the local one never has a plate, so fifteen is every other
 * player in a full lobby at once. Churn past that evicts the least recently
 * asked-for row, and a name that comes back simply redraws -- see `slotFor`.
 */
export const NAME_SLOTS = ATLAS_HEIGHT / SLOT_HEIGHT - 1;

/**
 * Fitted down from here when a name is too wide for the row.
 *
 * Sized to fill the row rather than to sit in it: `NAME_HEIGHT` is the height of
 * the whole 64-pixel slot in world metres, so every pixel of the row the glyphs
 * do *not* use is name that is smaller than the space reserved for it. At 46 in
 * a 64-pixel row with 6 pixels of padding, the ascender-to-descender box fills
 * about three quarters of the slot, which is as far as it can go before a `g`
 * clips.
 */
const FONT_PX = 46;
const FONT_MIN_PX = 22;
/** The interface font, as `index.html` sets it. A name should look like the HUD's. */
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// --- Budget -------------------------------------------------------------------

/**
 * Plates the buffers have room for.
 *
 * Fifteen remotes at the player cap, plus the three offline dummies, plus
 * headroom for the moment a leaver and a joiner overlap. Past this `add` drops
 * the plate and counts it rather than writing off the end of the array, which is
 * the only failure in this file that could corrupt something other than itself.
 */
export const MAX_PLATES = 24;

/** Backing, fill, two ticks, name. See the header. */
export const QUADS_PER_PLATE = 5;

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

// --- Pure maths, so the checks can reach it ------------------------------------

/**
 * Plate opacity at a distance. Monotonically non-increasing, 1 near, 0 past
 * `FADE_OUT`, and smooth in between -- a linear ramp pops at both ends.
 */
export function plateAlpha(distance: number): number {
  if (distance <= FADE_FULL) return 1;
  if (distance >= FADE_OUT) return 0;
  const t = (distance - FADE_FULL) / (FADE_OUT - FADE_FULL);
  // Ascending smoothstep, inverted. Written this way for the reason
  // `powerups.distanceFade` gives about the descending form in WGSL, and kept
  // here so the CPU and any future shader copy agree by construction.
  return 1 - t * t * (3 - 2 * t);
}

/** World-space scale multiplier at a distance. See `CLAMP_FROM`. */
export function plateScale(distance: number): number {
  if (distance <= CLAMP_FROM) return 1;
  return Math.min(CLAMP_MAX, Math.pow(distance / CLAMP_FROM, CLAMP_POWER));
}

/**
 * The bar's colour at a health fraction, into `out`.
 *
 * Continuous rather than one colour per pip, because health is a real number --
 * `combat.MAX_HEALTH`'s own header explains why a 1.4-pip punch exists -- and a
 * bar that only ever showed three colours would be throwing away the half pip
 * that decides whether to commit.
 *
 * **The knees sit on pip boundaries, not at halfway.** That is the whole of the
 * tuning here and it was wrong on the first cut: with the knee at 0.5, two pips
 * out of three and one pip out of three both came out amber, so the bar had four
 * states and three colours and the two that matter most were the pair that
 * looked alike. Anchored to the pips instead, three reads green, two reads
 * amber, one reads red, and the partial pips ramp between them. Written against
 * `MAX_PIPS` rather than against 3 so it stays anchored if the pip count moves.
 */
export function healthColour(fraction: number, out: Color): Color {
  const f = Math.max(0, Math.min(1, fraction));
  const onePip = 1 / MAX_PIPS;
  const nearlyFull = (MAX_PIPS - 1) / MAX_PIPS;
  if (f >= nearlyFull) return out.lerpColors(HURT, HEALTHY, (f - nearlyFull) / (1 - nearlyFull));
  if (f >= onePip) return out.lerpColors(DANGER, HURT, (f - onePip) / (nearlyFull - onePip));
  return out.copy(DANGER);
}

// --- One player's plate, as the caller describes it ---------------------------

/**
 * One player's plate, as the caller describes it.
 *
 * **`add` copies every field out of this and keeps no reference**, so a caller
 * is free to hand the same scratch record over for every player in the frame --
 * which `main.ts` does. That is the difference between this feature allocating
 * nothing per frame and allocating fifteen short-lived objects sixty times a
 * second, and it is the same bargain `world/footyball.ts`'s pool strikes by
 * taking loose numbers.
 */
export interface PlateInput {
  /** Whose it is. Only used to keep the local player out; see `NameplateField.add`. */
  id: number;
  /** The roster name. Empty draws the bar alone rather than a blank row. */
  name: string;
  /** Pips remaining, 0..`MAX_PIPS`. Straight off the snapshot. */
  health: number;
  /** The **head bone** in world metres. The plate hangs `PLATE_RISE` over it. */
  headX: number;
  headY: number;
  headZ: number;
  /** Knocked out: the bar empties, the plate dims and the empty track goes red. */
  down: boolean;
}

/** A copy of a `PlateInput`, plus its range. Pooled; see `NameplateField.pending`. */
interface PendingPlate extends PlateInput {
  distance: number;
}

export interface Slot {
  name: string;
  /** Which row of the atlas, 1..`NAME_SLOTS`. Row 0 is the white patch. */
  row: number;
  /** How much of the row the glyphs actually use, in pixels. Decides the quad's width. */
  widthPx: number;
  /** The frame this slot was last asked for. The eviction order. */
  used: number;
}

/**
 * The whole feature: one geometry, one material, one texture, one draw call.
 *
 * Filled declaratively each frame -- `begin`, `add` per player, `end` -- which is
 * the idiom `main.ts` already uses for the football pool, and for the same
 * reason: the callers are two unrelated lists (remotes online, dummies offline)
 * that must not have to agree about identity or about who owns the pool.
 */
export class NameplateField {
  readonly mesh: Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly texture: CanvasTexture;

  /** Plates written by the last `end()`. For the console and the checks. */
  live = 0;
  /** Plates `add` refused because the buffers were full. Should be 0 forever. */
  dropped = 0;
  /** Name rasterisations since boot. One per distinct name, ever, unless evicted. */
  redraws = 0;

  /** The atlas is reached through `ctx.canvas` where it is needed; see `draw`. */
  private readonly ctx: CanvasRenderingContext2D;
  private readonly slots = new Map<string, Slot>();
  /** Rows in use, indexed by row. `null` is free. */
  private readonly rows: (Slot | null)[] = new Array(NAME_SLOTS + 1).fill(null);
  private clock = 0;
  private atlasDirty = false;

  private readonly position: Float32Array;
  private readonly uv: Float32Array;
  private readonly colour: Float32Array;
  private readonly positionAttr: BufferAttribute;
  private readonly uvAttr: BufferAttribute;
  private readonly colourAttr: BufferAttribute;

  /** Write cursor, in quads. */
  private quads = 0;

  /** The camera basis for this frame, from `begin`. */
  private readonly camPos = { x: 0, y: 0, z: 0 };
  private readonly camRight = { x: 1, y: 0, z: 0 };
  private readonly camUp = { x: 0, y: 1, z: 0 };

  /**
   * This frame's plates, sorted far to near before writing.
   *
   * A fixed pool filled in place rather than an array built per frame, with
   * `pendingCount` as the live length. Two allocations per player per frame is
   * nothing measured on its own and is exactly the kind of nothing that this
   * project's frame budget is made of; more usefully, copying the caller's
   * record here is what lets the caller pass one scratch object for everybody.
   */
  private readonly pending: PendingPlate[] = Array.from({ length: MAX_PLATES }, () => ({
    id: 0, name: '', health: 0, headX: 0, headY: 0, headZ: 0, down: false, distance: 0,
  }));
  private pendingCount = 0;

  private readonly scratch = new Color();

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_WIDTH;
    canvas.height = ATLAS_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('nameplates: no 2d context for the name atlas');
    this.ctx = ctx;

    // The white patch every bar quad samples. Everything else starts transparent.
    ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WHITE_PATCH, WHITE_PATCH);

    const tex = new CanvasTexture(canvas);
    tex.name = 'nameplate_atlas';
    // sRGB, because the glyphs are drawn with the same hex the stylesheet uses
    // and they should come out the same colour.
    tex.colorSpace = SRGBColorSpace;
    // **Not flipped.** The UV maths below reads straight off canvas coordinates,
    // which is one fewer sign to get wrong in a file where getting it wrong
    // means every name is upside down and the bar is fine.
    tex.flipY = false;
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    // Text at a distance is the one thing in this project that genuinely
    // shimmers without it, and a plate is on screen for as long as its owner is.
    tex.anisotropy = 4;
    this.texture = tex;

    const verts = MAX_PLATES * QUADS_PER_PLATE * VERTS_PER_QUAD;
    this.position = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.colour = new Float32Array(verts * 4);

    this.positionAttr = new BufferAttribute(this.position, 3);
    this.uvAttr = new BufferAttribute(this.uv, 2);
    // Four components: the alpha is the distance fade and the knockout dim, and
    // it varies per plate. `NodeMaterial` multiplies a vec4 `color` attribute
    // into the diffuse whole -- see `contact.ts`, which leans on the same thing.
    this.colourAttr = new BufferAttribute(this.colour, 4);
    this.positionAttr.setUsage(DynamicDrawUsage);
    this.uvAttr.setUsage(DynamicDrawUsage);
    this.colourAttr.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.name = 'nameplates';
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('uv', this.uvAttr);
    geometry.setAttribute('color', this.colourAttr);
    // The index never changes: quad q is vertices 4q..4q+3, wound
    // bottom-left, bottom-right, top-right, top-left. Counter-clockwise seen
    // from the camera the quad was built to face, which is what lets the
    // material stay single-sided -- see `material.side` below.
    const index = new Uint16Array(MAX_PLATES * QUADS_PER_PLATE * INDICES_PER_QUAD);
    for (let q = 0; q < MAX_PLATES * QUADS_PER_PLATE; q++) {
      const b = q * VERTS_PER_QUAD;
      const i = q * INDICES_PER_QUAD;
      index[i] = b;
      index[i + 1] = b + 1;
      index[i + 2] = b + 2;
      index[i + 3] = b;
      index[i + 4] = b + 2;
      index[i + 5] = b + 3;
    }
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);

    const material = new MeshBasicNodeMaterial();
    material.name = 'nameplate';
    // The atlas is the whole colour graph. `vertexColors` then multiplies the
    // per-plate tint and the fade alpha into it, which `NodeMaterial` does for
    // free when the geometry has a `color` attribute -- no shader of ours.
    material.colorNode = texture(tex);
    material.vertexColors = true;
    material.transparent = true;
    // Through walls. The header argues this out.
    material.depthTest = false;
    material.depthWrite = false;
    // Single-sided, and the index buffer above is what makes it safe.
    // `contact.ts` measured what `DoubleSide` plus `transparent` costs in this
    // renderer -- two passes and two pipelines -- and a billboard has a front.
    material.side = FrontSide;
    this.material = material;

    const mesh = new Mesh(geometry, material);
    mesh.name = 'nameplates';
    // One geometry spanning the whole city has no useful bounding sphere, and
    // the field is one draw call of at most 360 triangles. Culling it would cost
    // more than drawing it.
    mesh.frustumCulled = false;
    // After the world's own transparents -- the contact skirts, the powerup
    // ghosts, the bike glow. A plate is the last thing composited.
    mesh.renderOrder = 12;
    // Never a caster. See the header on shadows.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;
  }

  /**
   * Start a frame. `camera` is read for its world matrix only.
   *
   * Typed structurally rather than as a `PerspectiveCamera` so the checks can
   * drive this with a bare matrix and no renderer.
   */
  begin(camera: { matrixWorld: Matrix4 }): void {
    const e = camera.matrixWorld.elements;
    this.camRight.x = e[0];
    this.camRight.y = e[1];
    this.camRight.z = e[2];
    this.camUp.x = e[4];
    this.camUp.y = e[5];
    this.camUp.z = e[6];
    this.camPos.x = e[12];
    this.camPos.y = e[13];
    this.camPos.z = e[14];
    this.pendingCount = 0;
    this.quads = 0;
    this.clock++;
  }

  /**
   * Offer one player a plate. Silently ignores anyone out of range or invisible,
   * which is what keeps the caller a single unconditional loop.
   *
   * `localId` is passed on every call rather than held on the field, because the
   * local id is the server's to assign and arrives *after* this object is built
   * -- holding a copy would be a second record of it that could be stale for the
   * one frame that matters.
   */
  add(input: PlateInput, localId: number): void {
    // The local player has the HUD. This is the rule the whole feature turns on
    // and it is enforced here rather than at the call site, so a second caller
    // added later cannot forget it.
    if (input.id === localId) return;

    const dx = input.headX - this.camPos.x;
    const dy = input.headY - this.camPos.y;
    const dz = input.headZ - this.camPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance >= FADE_OUT) return;
    if (this.pendingCount >= MAX_PLATES) {
      this.dropped++;
      return;
    }
    // Copied field by field, which is the contract `PlateInput` states: the
    // caller keeps its record and may reuse it for the next player.
    const slot = this.pending[this.pendingCount++];
    slot.id = input.id;
    slot.name = input.name;
    slot.health = input.health;
    slot.headX = input.headX;
    slot.headY = input.headY;
    slot.headZ = input.headZ;
    slot.down = input.down;
    slot.distance = distance;
  }

  /** Write the frame's plates into the buffers and hand them to the renderer. */
  end(): void {
    // Far to near, because the material does not depth-test: two plates that
    // overlap on screen composite in draw order and nothing else, so painter's
    // order is the only thing that makes the nearer one win.
    //
    // An insertion sort over the live prefix rather than `Array.sort`, which
    // would sort the pool's dead tail along with it. At fifteen entries that are
    // nearly in order from one frame to the next this is the faster of the two
    // anyway, and it allocates neither a subarray nor a comparator closure.
    // Reordering the pool is harmless: `add` overwrites every field of whichever
    // record it is handed, so the records have no identity between frames.
    for (let i = 1; i < this.pendingCount; i++) {
      const held = this.pending[i];
      let j = i - 1;
      while (j >= 0 && this.pending[j].distance < held.distance) {
        this.pending[j + 1] = this.pending[j];
        j--;
      }
      this.pending[j + 1] = held;
    }
    // Counted from what was actually written rather than from what was offered:
    // `write` declines a plate that has already faded to nothing, and a `live`
    // that disagreed with the draw range would make the console readout lie
    // about the one number anyone would check it for.
    this.live = 0;
    for (let i = 0; i < this.pendingCount; i++) {
      if (this.write(this.pending[i], this.pending[i].distance)) this.live++;
    }

    this.mesh.geometry.setDrawRange(0, this.quads * INDICES_PER_QUAD);
    this.positionAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.colourAttr.needsUpdate = true;
    if (this.atlasDirty) {
      // The whole atlas, and only when a name was rasterised -- which is on a
      // roster change and never on a snapshot. Re-uploading 2 MB per frame is
      // exactly the cost this cache exists to avoid.
      this.texture.needsUpdate = true;
      this.atlasDirty = false;
    }
  }

  /** Give the atlas back. Nothing else here allocates GPU memory. */
  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }

  // --- The name cache ---------------------------------------------------------

  /**
   * The atlas row for a name, drawing it if this is the first time.
   *
   * Keyed by the string, so the same name is the same row forever: two players
   * who happen to share one share the raster, and a player asked for twenty
   * times a second costs a `Map` lookup. Eviction is least-recently-asked-for,
   * and a name that comes back after being evicted simply draws again -- there
   * is no correctness in the cache, only cost.
   */
  slotFor(name: string): Slot {
    const found = this.slots.get(name);
    if (found) {
      found.used = this.clock;
      return found;
    }

    let row = -1;
    for (let r = 1; r <= NAME_SLOTS; r++) {
      if (this.rows[r] === null) {
        row = r;
        break;
      }
    }
    if (row < 0) {
      let oldest: Slot | null = null;
      for (let r = 1; r <= NAME_SLOTS; r++) {
        const s = this.rows[r];
        if (s && (oldest === null || s.used < oldest.used)) oldest = s;
      }
      // Unreachable while `NAME_SLOTS` is positive, and cheaper to assert than
      // to reason about: `rows` is fixed-length and every entry is either null
      // or a slot, so one of the two branches above has found something.
      if (!oldest) throw new Error('nameplates: no atlas row and nothing to evict');
      this.slots.delete(oldest.name);
      row = oldest.row;
    }

    const slot: Slot = { name, row, widthPx: this.draw(name, row), used: this.clock };
    this.rows[row] = slot;
    this.slots.set(name, slot);
    this.redraws++;
    this.atlasDirty = true;
    return slot;
  }

  /**
   * Rasterise one name into its row. Returns the pixels the glyphs occupy,
   * padding included.
   *
   * White with a dark outline, which is the same answer `index.html` reaches
   * with `text-shadow` and for the same reason: this text is read against a
   * sunlit sandstone wall as often as against sky, and neither a light nor a
   * dark fill survives both on its own.
   */
  private draw(name: string, row: number): number {
    const ctx = this.ctx;
    const top = row * SLOT_HEIGHT;
    ctx.clearRect(0, top, ATLAS_WIDTH, SLOT_HEIGHT);
    if (name === '') return 0;

    // Fitted down until it fits, rather than clipped: a name the server accepted
    // is a name that has to be readable, and `protocol.MAX_NAME_CHARS` allows
    // sixteen of them. The starting size is capped by the row's own height as
    // well as by `FONT_PX`, so the fit loop can never be the reason ascenders
    // from one name bleed into the row above it at a mip level.
    let px = Math.min(FONT_PX, SLOT_HEIGHT - SLOT_PAD_Y * 2);
    let width = 0;
    for (;;) {
      ctx.font = `${px}px ${FONT_STACK}`;
      width = ctx.measureText(name).width;
      if (width <= ATLAS_WIDTH - SLOT_PAD_X * 2 || px <= FONT_MIN_PX) break;
      px -= 2;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    // The outline first and thick, then the fill over it -- stroking after the
    // fill eats half the glyph weight at this size.
    ctx.strokeStyle = 'rgba(4, 6, 8, 0.92)';
    ctx.lineWidth = Math.max(3, px * 0.16);
    ctx.strokeText(name, SLOT_PAD_X, top + SLOT_HEIGHT / 2);
    // `#e6eef6`: the brightest text in the interface, off the same stylesheet.
    ctx.fillStyle = '#e6eef6';
    ctx.fillText(name, SLOT_PAD_X, top + SLOT_HEIGHT / 2);

    return Math.min(ATLAS_WIDTH, Math.ceil(width) + SLOT_PAD_X * 2);
  }

  // --- Writing one plate ------------------------------------------------------

  private write(input: PlateInput, distance: number): boolean {
    const alpha = plateAlpha(distance) * (input.down ? DOWN_DIM : 1);
    if (alpha <= 0.004) return false;
    const scale = plateScale(distance);

    const anchor = {
      x: input.headX,
      y: input.headY + PLATE_RISE * scale,
      z: input.headZ,
    };

    const halfW = (BAR_WIDTH / 2) * scale;
    const barH = BAR_HEIGHT * scale;
    const border = BAR_BORDER * scale;

    // --- The backing, and the empty track. One quad doing both jobs: the fill
    // is drawn over it, so whatever is left showing *is* the empty part of the
    // bar. A separate track quad would be a third of a draw for nothing.
    const c = this.scratch;
    if (input.down) {
      // Down: the track goes red rather than dark. A hollow red bar over a body
      // in the street says "out, and coming back" at a glance, which is a real
      // read in a fight -- see `combat`'s respawn clock.
      c.copy(DANGER);
      this.quad(anchor, -halfW - border, halfW + border, -border, barH + border, 0, 0, WHITE_PATCH, WHITE_PATCH, c, alpha * DOWN_BACKING_ALPHA);
    } else {
      c.copy(BACKING);
      this.quad(anchor, -halfW - border, halfW + border, -border, barH + border, 0, 0, WHITE_PATCH, WHITE_PATCH, c, alpha * BACKING_ALPHA);
    }

    // --- The fill, from the left edge.
    const fraction = Math.max(0, Math.min(1, input.health / MAX_PIPS));
    healthColour(fraction, c);
    // A zero-width quad is still four vertices and six indices to the renderer,
    // so an empty bar writes a degenerate one rather than skipping: the quad
    // count per plate has to be constant or the index buffer's fixed layout --
    // and every budget check that reads it -- stops being true.
    this.quad(anchor, -halfW, -halfW + BAR_WIDTH * scale * fraction, 0, barH, 0, 0, WHITE_PATCH, WHITE_PATCH, c, alpha);

    // --- The two pip ticks, over the fill, cutting the bar into thirds.
    c.copy(BACKING);
    for (let i = 1; i < MAX_PIPS; i++) {
      const at = -halfW + BAR_WIDTH * scale * (i / MAX_PIPS);
      const half = (TICK_WIDTH * scale) / 2;
      this.quad(anchor, at - half, at + half, 0, barH, 0, 0, WHITE_PATCH, WHITE_PATCH, c, alpha * TICK_ALPHA);
    }
    // `MAX_PIPS - 1` ticks were written; the buffer layout wants exactly two.
    // Both numbers are the same today and `verifyNameplates` is what keeps them
    // that way if `combat.MAX_HEALTH` ever moves.

    // --- The name, centred over the bar.
    const slot = this.slotFor(input.name);
    if (slot.widthPx > 0) {
      let nameH = NAME_HEIGHT * scale;
      let nameW = nameH * (slot.widthPx / SLOT_HEIGHT);
      const cap = NAME_MAX_WIDTH * scale;
      if (nameW > cap) {
        // Shrink both, so a long name gets smaller rather than squashed.
        nameH *= cap / nameW;
        nameW = cap;
      }
      const bottom = barH + border + NAME_GAP * scale;
      const u0 = 0;
      const u1 = slot.widthPx;
      const v0 = slot.row * SLOT_HEIGHT;
      const v1 = v0 + SLOT_HEIGHT;
      // White, so the canvas's own colours pass through untouched.
      c.setRGB(1, 1, 1);
      this.quad(anchor, -nameW / 2, nameW / 2, bottom, bottom + nameH, u0, v0, u1, v1, c, alpha);
    } else {
      // No name: still five quads. See the note on the degenerate fill.
      c.setRGB(1, 1, 1);
      this.quad(anchor, 0, 0, 0, 0, 0, 0, 0, 0, c, 0);
    }
    return true;
  }

  /**
   * One billboarded quad, in plate space.
   *
   * `l`/`r`/`b`/`t` are metres from the anchor along the camera's right and up
   * axes; the UV rectangle is in **canvas pixels**, which is the whole reason
   * the texture is unflipped.
   */
  private quad(
    anchor: { x: number; y: number; z: number },
    l: number,
    r: number,
    b: number,
    t: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    colour: Color,
    alpha: number,
  ): void {
    const base = this.quads * VERTS_PER_QUAD;
    this.quads++;

    const rx = this.camRight.x;
    const ry = this.camRight.y;
    const rz = this.camRight.z;
    const ux = this.camUp.x;
    const uy = this.camUp.y;
    const uz = this.camUp.z;

    // Bottom-left, bottom-right, top-right, top-left. The index buffer's
    // winding depends on this order and on nothing else.
    const xs = [l, r, r, l];
    const ys = [b, b, t, t];
    const us = [u0, u1, u1, u0];
    // Canvas y grows downward and the quad is built bottom-up, so the bottom
    // edge takes the *larger* canvas row.
    const vs = [v1, v1, v0, v0];

    const cr = colour.r * PLATE_GAIN;
    const cg = colour.g * PLATE_GAIN;
    const cb = colour.b * PLATE_GAIN;

    for (let i = 0; i < 4; i++) {
      const p = (base + i) * 3;
      this.position[p] = anchor.x + rx * xs[i] + ux * ys[i];
      this.position[p + 1] = anchor.y + ry * xs[i] + uy * ys[i];
      this.position[p + 2] = anchor.z + rz * xs[i] + uz * ys[i];
      const q = (base + i) * 2;
      this.uv[q] = us[i] / ATLAS_WIDTH;
      this.uv[q + 1] = vs[i] / ATLAS_HEIGHT;
      const k = (base + i) * 4;
      this.colour[k] = cr;
      this.colour[k + 1] = cg;
      this.colour[k + 2] = cb;
      this.colour[k + 3] = alpha;
    }
  }
}

// --- The check ----------------------------------------------------------------

/**
 * Boot self-check, on this project's usual criterion: does every way it breaks
 * still *render*, and render something plausible?
 *
 * Every failure below does. A texture cache that misses puts a rasterisation on
 * every frame -- 2 MB of atlas re-uploaded twenty times a second, which is a
 * frame rate problem that looks like a streaming problem. A fade that is not
 * monotonic makes distant plates brighter than near ones, which reads as a
 * lighting bug. A budget that is wrong writes past the end of a `Float32Array`,
 * which in JavaScript is silence and a plate that is simply missing. A winding
 * that is backwards leaves every plate invisible on a single-sided material,
 * which reads as the feature not being wired up. And a plate for the local
 * player is a name floating in front of your own face that you cannot get rid
 * of, which is the one failure a player would report -- and the one this
 * feature's whole rule is about.
 *
 * `maxHealth` is `combat.MAX_HEALTH`, handed in by the caller so this file's
 * restated `MAX_PIPS` cannot drift from it. The figure's height is imported
 * rather than passed, because `animation.ts` is a rendering module this file is
 * already entitled to depend on -- `world/people.ts` reads the same constant.
 */
export function verifyNameplates(maxHealth: number): string[] {
  const figureHeight = FIGURE_HEIGHT;
  const failures: string[] = [];

  if (MAX_PIPS !== maxHealth) {
    failures.push(`Nameplates draw ${MAX_PIPS} pips; combat has ${maxHealth}. The ticks would cut the bar in the wrong places.`);
  }
  // The tick loop writes `MAX_PIPS - 1` quads and the buffer layout budgets for
  // exactly `QUADS_PER_PLATE`. Everything else in a plate is one quad each.
  if (QUADS_PER_PLATE !== 3 + (MAX_PIPS - 1)) {
    failures.push(`A plate writes ${3 + (MAX_PIPS - 1)} quads but ${QUADS_PER_PLATE} are budgeted; the index buffer's layout is wrong.`);
  }

  // --- The fade. Monotonic, and anchored at both ends.
  if (plateAlpha(0) !== 1 || plateAlpha(FADE_FULL) !== 1) {
    failures.push(`Plates are not at full opacity inside ${FADE_FULL} m.`);
  }
  if (plateAlpha(FADE_OUT) !== 0 || plateAlpha(FADE_OUT + 20) !== 0) {
    failures.push(`Plates are still visible at ${FADE_OUT} m, where they should be gone.`);
  }
  let previous = Infinity;
  for (let d = 0; d <= 90; d += 0.5) {
    const a = plateAlpha(d);
    if (a > previous + 1e-9) {
      failures.push(`Plate opacity rises with distance at ${d} m: ${a} after ${previous}.`);
      break;
    }
    if (a < -1e-9 || a > 1 + 1e-9) {
      failures.push(`Plate opacity at ${d} m is ${a}, which is not an opacity.`);
      break;
    }
    previous = a;
  }

  // --- The screen-size clamp. Also monotonic, and it must never *shrink* a
  // plate: a floor that dips below 1 would make near plates smaller than their
  // world size, which is the opposite of the thing it exists for.
  let previousScale = 0;
  for (let d = 0; d <= 90; d += 0.5) {
    const s = plateScale(d);
    if (s < 1 - 1e-9 || s > CLAMP_MAX + 1e-9) {
      failures.push(`Plate scale at ${d} m is ${s}; it must stay between 1 and ${CLAMP_MAX}.`);
      break;
    }
    if (s < previousScale - 1e-9) {
      failures.push(`Plate scale falls with distance at ${d} m: ${s} after ${previousScale}.`);
      break;
    }
    previousScale = s;
  }
  // The clamp is squeezed from both sides, and both were real bugs waiting to
  // happen. Apparent size must still FALL with distance, or the clamp has become
  // a fixed screen size and the depth read is gone; and it must not fall too far,
  // or the plate has vanished to a pixel before the fade got to it -- which is
  // exactly what the first cut of these numbers did, and it took a screenshot at
  // 45 m to notice.
  const nearApparent = plateScale(CLAMP_FROM) / CLAMP_FROM;
  const farApparent = plateScale(FADE_OUT) / FADE_OUT;
  if (farApparent >= nearApparent) {
    failures.push('A plate at the fade distance is not smaller on screen than one at the clamp distance.');
  }
  if (farApparent < nearApparent * 0.45) {
    failures.push(
      `A plate at ${FADE_OUT} m is ${(farApparent / nearApparent * 100).toFixed(0)}% the apparent size of one at ` +
        `${CLAMP_FROM} m; below about 45% there is nothing left to fade out.`,
    );
  }

  // --- The rise. A standing figure's head bone is `figureHeight` less the skull
  // above it; the bar must clear the crown and not float a storey over it.
  const crownOverBone = 0.445;
  const barOverCrown = PLATE_RISE - crownOverBone;
  if (barOverCrown < 0.3 || barOverCrown > 0.9) {
    failures.push(`The bar sits ${barOverCrown.toFixed(2)} m over the crown; the order asked for about 0.55.`);
  }
  const plateHeight = BAR_HEIGHT + BAR_BORDER * 2 + NAME_GAP + NAME_HEIGHT;
  if (plateHeight > figureHeight * 0.45) {
    failures.push(`A plate is ${plateHeight.toFixed(2)} m tall against a ${figureHeight} m figure; it would dominate the body.`);
  }
  if (BAR_WIDTH < 1.1 || BAR_WIDTH > 1.4 || BAR_HEIGHT < 0.1 || BAR_HEIGHT > 0.14) {
    failures.push(`The bar is ${BAR_WIDTH} x ${BAR_HEIGHT} m; the order asked for large, which was scoped at 1.1-1.4 by 0.10-0.14.`);
  }

  // --- The colours. A full bar must not be the HUD's danger red, and an empty
  // one must be.
  // Compared as hex in sRGB rather than as objects, because what matters is that
  // `lerpColors` lands exactly on its endpoints -- a lerp that undershot would
  // give a full bar a colour that is *nearly* the healthy one, which nobody
  // would ever notice was wrong.
  const probe = new Color();
  if (healthColour(1, probe).getHex(SRGBColorSpace) !== HEALTHY.getHex(SRGBColorSpace)) {
    failures.push('A full bar is not the healthy colour.');
  }
  if (healthColour(0, probe).getHex(SRGBColorSpace) !== DANGER.getHex(SRGBColorSpace)) {
    failures.push('An empty bar is not the danger colour.');
  }
  // The knees, pinned to the pips. This is the check that keeps three pips
  // reading green, two amber and one red rather than two of them looking alike --
  // see `healthColour`, where getting it wrong was the first cut's actual bug.
  if (healthColour((MAX_PIPS - 1) / MAX_PIPS, probe).getHex(SRGBColorSpace) !== HURT.getHex(SRGBColorSpace)) {
    failures.push(`A bar at ${MAX_PIPS - 1} of ${MAX_PIPS} pips is not the hurt colour; the ramp's knee has come off the pip boundary.`);
  }
  if (healthColour(1 / MAX_PIPS, probe).getHex(SRGBColorSpace) !== DANGER.getHex(SRGBColorSpace)) {
    failures.push(`A bar at 1 of ${MAX_PIPS} pips is not the danger colour; one pip left has to look like one pip left.`);
  }

  // --- The field itself, which needs a canvas and nothing else. No renderer, no
  // GPU: a `CanvasTexture` is not uploaded until something draws it.
  if (typeof document === 'undefined') return failures;

  const field = new NameplateField();
  try {
    const camera = { matrixWorld: new Matrix4() };
    // Looking down -Z from the origin, which is the identity -- so the camera's
    // right is +X and its up is +Y, and a plate's quads land in a plane this
    // check can reason about.
    camera.matrixWorld.identity();

    // --- Cache reuse. The same name is the same row and does not redraw.
    const first = field.slotFor('Bazza');
    const drawsAfterFirst = field.redraws;
    const again = field.slotFor('Bazza');
    if (again !== first || again.row !== first.row) {
      failures.push('Asking for the same name twice returned two different atlas rows.');
    }
    if (field.redraws !== drawsAfterFirst) {
      failures.push('Asking for a cached name rasterised it again; the atlas would re-upload every frame.');
    }
    const other = field.slotFor('Shazza');
    if (other.row === first.row) {
      failures.push('Two different names were given the same atlas row.');
    }
    if (first.widthPx <= 0 || first.widthPx > ATLAS_WIDTH) {
      failures.push(`A rasterised name measured ${first.widthPx} px in a ${ATLAS_WIDTH} px row.`);
    }
    // Every slot filled, then one more: the eviction path has to keep working
    // rather than throwing, because a busy server churns names all evening.
    for (let i = 0; i < NAME_SLOTS + 4; i++) field.slotFor(`Filler ${i}`);
    if (field.slotFor('Filler 0').row < 1 || field.slotFor('Filler 0').row > NAME_SLOTS) {
      failures.push('Eviction handed out a row outside the atlas.');
    }

    // --- No plate for the local player.
    field.begin(camera);
    field.add({ id: 7, name: 'Me', health: 3, headX: 0, headY: 0, headZ: -5, down: false }, 7);
    field.end();
    if (field.live !== 0) {
      failures.push(`The local player was given ${field.live} plate(s); they have the HUD.`);
    }

    // --- One remote, at a readable distance. Five quads, and the winding of
    // every one of them faces the camera.
    field.begin(camera);
    field.add({ id: 8, name: 'Davo', health: 2, headX: 0, headY: 0, headZ: -10, down: false }, 7);
    field.end();
    if (field.live !== 1) failures.push(`A remote at 10 m got ${field.live} plates, not 1.`);
    const drawn = field.mesh.geometry.drawRange.count / INDICES_PER_QUAD;
    if (drawn !== QUADS_PER_PLATE) {
      failures.push(`One plate drew ${drawn} quads, not ${QUADS_PER_PLATE}.`);
    }
    const winding = checkWinding(field, drawn);
    if (winding) failures.push(winding);

    // --- Range. Nothing past the fade, everything inside it.
    field.begin(camera);
    field.add({ id: 9, name: 'Macca', health: 3, headX: 0, headY: 0, headZ: -(FADE_OUT + 5), down: false }, 7);
    field.end();
    if (field.live !== 0) failures.push(`A player past ${FADE_OUT} m still got a plate.`);

    // --- Budget. More players than the buffers hold must drop, not overflow.
    field.begin(camera);
    for (let i = 0; i < MAX_PLATES + 6; i++) {
      field.add({ id: 100 + i, name: `Bot ${i}`, health: 3, headX: i * 0.5, headY: 0, headZ: -12, down: false }, 7);
    }
    field.end();
    if (field.live > MAX_PLATES) {
      failures.push(`${field.live} plates were written into buffers sized for ${MAX_PLATES}.`);
    }
    if (field.dropped !== 6) {
      failures.push(`${MAX_PLATES + 6} plates over a ${MAX_PLATES} budget dropped ${field.dropped}, not 6.`);
    }

    // --- The bar actually drains. The fill quad's width has to fall with health.
    const widths: number[] = [];
    for (const health of [3, 2, 1, 0]) {
      field.begin(camera);
      field.add({ id: 11, name: 'Bluey', health, headX: 0, headY: 0, headZ: -10, down: false }, 7);
      field.end();
      widths.push(fillWidth(field));
    }
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] >= widths[i - 1]) {
        failures.push(`The bar did not shrink between ${4 - i} and ${3 - i} pips: ${widths[i - 1]} then ${widths[i]}.`);
        break;
      }
    }
    if (Math.abs(widths[0] - BAR_WIDTH) > 1e-4) {
      failures.push(`A full bar is ${widths[0]} m wide, not ${BAR_WIDTH}.`);
    }
    if (widths[3] > 1e-6) failures.push(`An empty bar is still ${widths[3]} m wide.`);
  } finally {
    field.dispose();
  }

  return failures;
}

/** The fill quad is quad 1 of the plate. Its width in metres, off the buffer. */
function fillWidth(field: NameplateField): number {
  const pos = field.mesh.geometry.getAttribute('position');
  // Vertices 4 and 5 are the fill's bottom-left and bottom-right.
  return Math.abs(pos.getX(5) - pos.getX(4));
}

/**
 * Every drawn quad must wind counter-clockwise as seen from the camera, or a
 * single-sided material draws nothing at all.
 *
 * With the identity camera matrix the eye looks down -Z, so a front-facing
 * triangle's geometric normal points at +Z.
 */
function checkWinding(field: NameplateField, quads: number): string | null {
  const pos = field.mesh.geometry.getAttribute('position');
  for (let q = 0; q < quads; q++) {
    const b = q * VERTS_PER_QUAD;
    const ax = pos.getX(b + 1) - pos.getX(b);
    const ay = pos.getY(b + 1) - pos.getY(b);
    const bx = pos.getX(b + 3) - pos.getX(b);
    const by = pos.getY(b + 3) - pos.getY(b);
    // The z of the cross product of two edges lying in the XY plane.
    const cross = ax * by - ay * bx;
    // A degenerate quad -- an empty bar's fill, an absent name -- has no
    // winding, and that is allowed. Anything with area has to face the right way.
    if (Math.abs(cross) < 1e-9) continue;
    if (cross < 0) return `Plate quad ${q} is wound away from the camera; a single-sided plate would be invisible.`;
  }
  return null;
}
