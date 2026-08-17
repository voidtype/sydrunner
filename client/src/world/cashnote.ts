/**
 * The pile of money on the pavement: a fanned stack of Australian fifties that
 * turns, lifts and vanishes.
 *
 * *"as its ausie make it look like aussie $50s"*. What was there before was a
 * stubby gold cylinder -- 30 cm across, 7 cm tall, emissive -- and its own
 * comment in `money.ts` said what it was for: *"what it has to do is read as
 * something on the ground worth walking to from the far side of a street"*. It
 * did that and nothing else, and the instruction is that the nothing else is
 * now the point.
 *
 * ---------------------------------------------------------------------------
 * ONE DRAW A PILE, AND WHY THE FAN IS BAKED
 *
 * There can be `cash.MAX_BUNDLES` -- 48 -- piles in a room at once, and each is
 * two to five notes. The obvious build is a `Group` per pile with a note mesh
 * per note in it: 240 objects, 240 draws, and 240 world matrices composed every
 * frame for an object that is a rectangle on the ground.
 *
 * So the **fan is baked into the geometry**. There are four geometries -- two,
 * three, four and five notes -- each a single indexed buffer with the notes
 * already laid out at their offsets and angles, and a pile picks the one its
 * amount asks for (`cashnote.noteCount`). One mesh, one draw, one matrix. The
 * cost is four geometries instead of one, which is 288 triangles of vertex
 * buffer in total and is less than a single tree.
 *
 * That is `world/bike.ts`'s instancing argument arriving at a different answer
 * for a good reason: a bike fleet is thousands of identical objects and wants
 * one instanced draw; a cash pile is at most 48 objects in *four* shapes, and
 * instancing four variants would mean four instanced meshes and a per-frame
 * re-pack of which pile is in which. Forty-eight ordinary draws is cheaper than
 * the bookkeeping.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NOTE IS A TEXTURE AND NOT GEOMETRY
 *
 * Everything else in this project is generated geometry with vertex colours --
 * the bat, the figure, the football, the bike -- and the header of each of them
 * argues that there is no asset pipeline for a downloaded mesh to enter. A note
 * is the one object where that argument points the other way: it is *flat*, and
 * everything that makes it a fifty rather than a yellow rectangle is printing.
 * Drawing a numeral out of triangles would be a hundred triangles a glyph on an
 * object 15 cm long.
 *
 * The texture is drawn on a canvas at boot from `game/cashnote.noteOps()` --
 * one 256 x 111 sheet, 111 kB of VRAM, shared by every note in the game -- and
 * the *design* lives in that three-free module rather than here, so
 * `verifyCashDrops` can assert the note has a window in it without a GPU. This
 * file's job is to be the hand holding the pen.
 *
 * ---------------------------------------------------------------------------
 * THE LIFT
 *
 * A bundle that leaves the server's list has either been collected or has timed
 * out, and **nothing on the wire says which**: `WalletFrame.bundles` is the
 * whole state and a collected pile is simply absent from the next frame. Rather
 * than adding a byte to say so, a pile that disappears is animated the same way
 * either time -- it rises 0.9 m over 400 ms, spins up and fades out.
 *
 * That is honest for both cases and it is the *right* picture for both: money
 * you picked up went up, and money that expired blew away. The alternative --
 * a pile that simply stops being drawn on one frame -- is the thing that makes
 * a pickup feel like it did not happen, which is the single most common
 * complaint about collectibles in any game.
 *
 * The fade is on **opacity with a transparent material**, which this project
 * usually refuses (a transparent object needs a sort key and cannot write
 * depth). It is affordable here for a specific reason: at most a handful of
 * piles are mid-lift at once, they are small, they are above the ground rather
 * than intersecting it, and each one is transparent for 400 ms. The resting
 * piles -- which is all of them nearly all of the time -- are opaque and in the
 * ordinary depth pass. See `LIFT_SECONDS`.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Mesh,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
  type Object3D,
  type Texture,
} from 'three/webgpu';

import {
  NOTE_HEIGHT_M,
  NOTE_LENGTH_M,
  NOTE_TEXTURE_H,
  NOTE_TEXTURE_W,
  NOTE_THICKNESS_M,
  noteCount,
  noteOps,
  type NoteOp,
} from '../game/cashnote.ts';

// --- The sheet ------------------------------------------------------------------

/**
 * Paint `game/cashnote.noteOps()` onto a canvas and hand back a texture.
 *
 * The only place in this workstream that touches a `CanvasRenderingContext2D`,
 * and it is a straight interpreter over the op list -- no design decisions and
 * no numbers of its own beyond the two the canvas API needs (the font stack and
 * the letter spacing). Everything a reviewer would want to argue about is in
 * the op list, where a check can reach it.
 *
 * The font is a **system stack rather than a webfont**, on `hud.ts`'s standing
 * rule about type in this project: a webfont is a network request that can
 * fail, and the failure mode is a note whose numeral is drawn in whatever the
 * browser fell back to -- at a different width, so the "50" runs off the end.
 * A heavy grotesque is what a banknote numeral is, and every platform has one.
 */
function drawNote(): Texture | null {
  // `document` rather than `OffscreenCanvas`, which would be the tidier call and
  // is not universally available in the browsers this project supports; and the
  // whole function is guarded so that a headless import of this module (a check,
  // a bundler's analysis pass) does not throw on `document`.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = NOTE_TEXTURE_W;
  canvas.height = NOTE_TEXTURE_H;
  const c = canvas.getContext('2d');
  if (c === null) return null;

  for (const op of noteOps()) paintOp(c, op);

  const texture = new CanvasTexture(canvas);
  texture.name = 'aud50';
  // The ops are authored as sRGB hex strings -- they are colours somebody
  // picked by eye -- so the sampler has to be told, or every note in the city
  // is drawn at the linear value of its sRGB number and comes out washed out.
  // Same declaration `world/facade.ts` makes about its atlases.
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function paintOp(c: CanvasRenderingContext2D, op: NoteOp): void {
  c.fillStyle = op.colour;
  if (op.op === 'fill') {
    c.beginPath();
    // `roundRect` where it exists, a plain rectangle where it does not. The
    // radius is a nicety on a 33 px feature and losing it on an old browser is
    // a squarer window, not a missing one -- so this degrades rather than
    // guarding the whole draw.
    if (op.radius > 0 && typeof c.roundRect === 'function') c.roundRect(op.x, op.y, op.w, op.h, op.radius);
    else c.rect(op.x, op.y, op.w, op.h);
    c.fill();
    return;
  }
  c.font = `${op.weight} ${op.px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  c.textAlign = op.align === 'centre' ? 'center' : op.align;
  // `alphabetic` would put the op's `y` on the baseline, which makes every
  // placement in the op list a number somebody had to work out from a font
  // metric. `middle` makes `y` the vertical centre of the glyphs, which is what
  // the op list's fractions of the sheet's height obviously mean.
  c.textBaseline = 'middle';
  // Letter spacing on the word only, and set through the property rather than
  // by drawing glyph by glyph: AUSTRALIA on a banknote is tracked out, and
  // `letterSpacing` is supported everywhere WebGPU is. Reset after, because the
  // context is shared with the ops after this one.
  const tracked = op.text.length > 4;
  if (tracked) c.letterSpacing = `${Math.round(op.px * 0.14)}px`;
  c.fillText(op.text, op.x, op.y);
  if (tracked) c.letterSpacing = '0px';
}

// --- The fan --------------------------------------------------------------------

/**
 * How far the notes in a fan are pushed apart, and how far they are turned.
 *
 * The stack is fanned about its **left edge**, so the notes splay like a hand of
 * cards dropped on the ground rather than sitting in a neat brick. A brick is
 * what a bank hands you; what falls out of somebody's pocket is a mess, and the
 * mess is also what makes the pile legible from above -- five aligned notes are
 * one note with a thick edge.
 *
 * The angles are small (7 degrees a note, so a five-note fan opens 28) because
 * a wide fan at this size stops reading as a stack and starts reading as
 * scattered litter. The lift per note is `NOTE_THICKNESS_M` plus a hair, which
 * is what keeps the depth buffer from having an opinion about which of two
 * coplanar notes is on top.
 */
const FAN_YAW_STEP = 0.12;
const FAN_SLIDE = 0.012;
const FAN_RISE = NOTE_THICKNESS_M * 2.2;

/**
 * One flat note as a slab, appended to the buffers, rotated `yaw` about the
 * origin and offset.
 *
 * Twelve triangles: the two faces that carry the print and the four edges that
 * carry the paper's colour. The edges are 0.6 mm and would be invisible except
 * at a grazing angle, where their absence is a note you can see through -- so
 * they are built rather than saved.
 *
 * The UVs put the whole sheet on both large faces, and the edges get a single
 * pixel out of the middle of the gold ground rather than a stretched copy of
 * the print. `world/bike.ts` does the same with its instanced decals.
 */
function slab(
  out: { position: number[]; normal: number[]; uv: number[]; index: number[] },
  yaw: number,
  ox: number,
  oy: number,
  oz: number,
): void {
  const hx = NOTE_LENGTH_M / 2;
  const hz = NOTE_HEIGHT_M / 2;
  const hy = NOTE_THICKNESS_M / 2;
  const s = Math.sin(yaw);
  const co = Math.cos(yaw);
  // Local (x, y, z) into world, with the note lying in the XZ plane.
  const px = (x: number, z: number): number => ox + x * co - z * s;
  const pz = (x: number, z: number): number => oz + x * s + z * co;

  const quad = (
    corners: ReadonlyArray<readonly [number, number, number]>,
    normal: readonly [number, number, number],
    uvs: ReadonlyArray<readonly [number, number]>,
  ): void => {
    const base = out.position.length / 3;
    const nx = normal[0] * co - normal[2] * s;
    const nz = normal[0] * s + normal[2] * co;
    for (let i = 0; i < 4; i++) {
      const [x, y, z] = corners[i];
      out.position.push(px(x, z), oy + y, pz(x, z));
      out.normal.push(nx, normal[1], nz);
      out.uv.push(uvs[i][0], uvs[i][1]);
    }
    out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // The print, face up. Wound counter-clockwise seen from +Y, which with z
  // running *down* the page in this project's frame means the corner order
  // below -- the same trap `bat.cap` documents.
  quad(
    [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]],
    [0, 1, 0],
    [[0, 1], [1, 1], [1, 0], [0, 0]],
  );
  // And face down, so a note that has landed the other way up is still a note.
  quad(
    [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]],
    [0, -1, 0],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
  );
  // The four edges, all sampling one spot in the gold ground.
  const edgeUv: ReadonlyArray<readonly [number, number]> = [[0.5, 0.02], [0.52, 0.02], [0.52, 0.04], [0.5, 0.04]];
  quad([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1], edgeUv);
  quad([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1], edgeUv);
  quad([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0], edgeUv);
  quad([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0], edgeUv);
}

/** A fan of `n` notes, as one indexed geometry centred on the ground at the origin. */
function buildFan(n: number): BufferGeometry {
  const out = { position: [] as number[], normal: [] as number[], uv: [] as number[], index: [] as number[] };
  for (let i = 0; i < n; i++) {
    // Centred on the middle note, so the pile's origin is the middle of the pile
    // rather than the bottom note -- which is what makes the slow turn in
    // `update` spin the stack about itself instead of swinging it around a
    // corner of itself.
    const k = i - (n - 1) / 2;
    slab(out, k * FAN_YAW_STEP, k * FAN_SLIDE, NOTE_THICKNESS_M / 2 + i * FAN_RISE, k * FAN_SLIDE * 0.35);
  }
  const geometry = new BufferGeometry();
  geometry.name = `aud50-fan-${n}`;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(out.position), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(out.normal), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(out.uv), 2));
  geometry.setIndex(new BufferAttribute(new Uint16Array(out.index), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The smallest and largest fan `game/cashnote.noteCount` can ask for. */
const MIN_NOTES = 2;
const MAX_NOTES = 5;

/**
 * One texture, one material and four geometries, for every pile in the game.
 *
 * `player/bat.BatAssets`' contract exactly, including the consequence for
 * teardown: a pile must never dispose any of this, because every other pile is
 * drawing it.
 */
export class CashNoteAssets {
  /** Indexed by note count, so `fans[3]` is the three-note fan. 0 and 1 are unused. */
  readonly fans: readonly (BufferGeometry | null)[];
  readonly material: MeshStandardNodeMaterial;
  readonly texture: Texture | null;
  readonly triangles: number;

  constructor() {
    const fans: Array<BufferGeometry | null> = [null, null];
    let triangles = 0;
    for (let n = MIN_NOTES; n <= MAX_NOTES; n++) {
      const geometry = buildFan(n);
      triangles += (geometry.getIndex()?.count ?? 0) / 3;
      fans.push(geometry);
    }
    this.fans = fans;
    this.triangles = triangles;

    this.texture = drawNote();
    const material = new MeshStandardNodeMaterial();
    material.name = 'aud50';
    if (this.texture !== null) material.map = this.texture;
    // Paper. Nearly matte and not at all metallic -- polymer has a very slight
    // sheen and nothing more, and a note with any metalness reads as foil.
    material.roughness = 0.78;
    material.metalness = 0;
    // **Lit and not emissive**, which is a change from the cylinder this
    // replaces: that was emissive at 0.35 so a pile in a laneway at night was
    // findable. A glowing banknote is a prop from a different game, and the
    // findability is bought back by the shape instead -- a fan is five times the
    // silhouette of a puck, and the beacon that actually matters at range is the
    // marker on both maps, which is `money.ts`'s and unchanged.
    material.emissiveIntensity = 0;
    // Transparent for the lift. See the header: the resting state is `opacity: 1`
    // and one material is shared, so this is set per *mesh* through a cloned
    // material only for the handful that are mid-lift -- see `LiftState`.
    material.transparent = false;
    this.material = material;
  }

  /** Torn down with the scene, and only then. */
  dispose(): void {
    for (const f of this.fans) f?.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}

// --- The piles in the street -------------------------------------------------------

/** How long a vanishing pile takes to rise and fade, seconds, and how far it goes. */
const LIFT_SECONDS = 0.4;
const LIFT_HEIGHT = 0.9;
/** Radians a second a resting pile turns. Slow: this is a hint, not a spinner. */
const SPIN_RATE = 0.6;

/** One pile the renderer is tracking. */
interface Pile {
  mesh: Mesh;
  /** Which fan is on it, so a pile whose amount changed can be re-shaped. */
  notes: number;
  /** Seconds into the lift, or -1 while the pile is still on the server's list. */
  liftT: number;
  /** Where it was when it vanished, so the lift starts from the right place. */
  x: number;
  y: number;
  z: number;
  /** Its own turn, so two piles side by side are not in lockstep. */
  spin: number;
}

/**
 * Every cash pile on the ground, drawn from the wallet frame.
 *
 * **Keyed by bundle id rather than by index into the frame's array**, which is
 * the one structural difference from the pool this replaces. `cash.tickBundles`
 * *compacts* its list when a bundle is collected, so the array index of every
 * pile after it shifts by one -- with an index-keyed pool that is a pile
 * teleporting across the street on the frame somebody else picked one up, and
 * it is invisible unless two piles are on screen at once. It is also what makes
 * the lift possible at all: knowing that *this* pile went away requires knowing
 * which pile it was.
 *
 * The cost is a `Map` walk a frame over at most 48 entries plus however many are
 * mid-lift, against an array index. Both are nothing; the correctness is not.
 */
export class CashNotePiles {
  private readonly piles = new Map<number, Pile>();
  /** Ids seen this frame, reused rather than allocated. See `update`. */
  private readonly live = new Set<number>();
  private clock = 0;

  constructor(
    private readonly scene: Object3D,
    readonly assets: CashNoteAssets = new CashNoteAssets(),
  ) {}

  /**
   * Draw the piles the server is reporting, and lift the ones that have gone.
   *
   * `dt` is the **frame** delta and not the fixed step, on `money.frame`'s own
   * rule: the pickup is the server's and is a plan distance, so nothing here can
   * affect it, and a spin that ran on the simulation step would judder on a
   * display that is not 60 Hz.
   */
  update(dt: number, bundles: ReadonlyArray<{ id: number; x: number; y: number; z: number; amount: number }>): void {
    this.clock += dt;
    this.live.clear();

    for (const b of bundles) {
      this.live.add(b.id);
      let pile = this.piles.get(b.id);
      const notes = clampNotes(noteCount(b.amount));
      if (pile === undefined) {
        const mesh = new Mesh(this.assets.fans[notes] ?? undefined, this.assets.material);
        mesh.name = 'cash-notes';
        mesh.castShadow = true;
        // Not receiving, and deliberately: a 0.6 mm slab lying on a footpath
        // that also receives the footpath's own shadow acquires a hard edge from
        // its own shadow map texel, which at this size is most of the note. The
        // cylinder this replaces made the same call.
        mesh.receiveShadow = false;
        this.scene.add(mesh);
        // The spin phase is the **id** and not the clock, so a pile is at the
        // same angle on every client that can see it -- cosmetic, but two
        // players describing "the one by the bins" should be describing the same
        // picture. `money.ts`'s cylinder did this and it is kept.
        pile = { mesh, notes, liftT: -1, x: b.x, y: b.y, z: b.z, spin: b.id };
        this.piles.set(b.id, pile);
      } else if (pile.notes !== notes) {
        // Reachable: nothing on the wire says a bundle's amount is immutable and
        // a future pass may well merge two piles. Swapping the geometry is one
        // assignment and the alternative is a pile whose thickness lies.
        pile.notes = notes;
        pile.mesh.geometry = this.assets.fans[notes] ?? pile.mesh.geometry;
      }
      // Still on the list, so it is resting -- and if it was mid-lift (a pile
      // that flickered out of one frame's message and back into the next, which
      // a dropped delta can do) it comes back down rather than continuing to
      // rise. Restoring the material is what un-fades it.
      if (pile.liftT >= 0) {
        pile.liftT = -1;
        pile.mesh.material = this.assets.material;
      }
      pile.x = b.x;
      pile.y = b.y;
      pile.z = b.z;
      pile.mesh.visible = true;
      pile.mesh.position.set(b.x, b.y, b.z);
      pile.mesh.rotation.y = this.clock * SPIN_RATE + pile.spin;
    }

    // Anything not in this frame's list has gone: start or continue its lift,
    // and delete it when it is over.
    for (const [id, pile] of this.piles) {
      if (this.live.has(id)) continue;
      if (pile.liftT < 0) {
        pile.liftT = 0;
        // A clone per lifting pile, which is the one allocation this class
        // makes and is why the resting piles are left on the shared opaque
        // material: a handful of transparent materials for 400 ms each is a
        // handful of pipeline variants three has already compiled (the shared
        // one differs only in a uniform), where making *every* pile transparent
        // would put 48 sorted objects in the blend pass permanently.
        const fading = this.assets.material.clone();
        fading.transparent = true;
        fading.depthWrite = false;
        pile.mesh.material = fading;
      }
      pile.liftT += dt;
      const t = pile.liftT / LIFT_SECONDS;
      if (t >= 1) {
        this.scene.remove(pile.mesh);
        (pile.mesh.material as MeshStandardNodeMaterial).dispose();
        this.piles.delete(id);
        continue;
      }
      // Out-cubic on the rise so the pile leaves quickly and settles at the top,
      // and a linear fade so it is genuinely gone by the end rather than
      // lingering at 10% -- the two curves differ on purpose, which is what
      // makes the money look thrown rather than deflated.
      const rise = 1 - Math.pow(1 - t, 3);
      pile.mesh.position.set(pile.x, pile.y + LIFT_HEIGHT * rise, pile.z);
      // Spinning up as it goes, five times the resting rate, which is the whole
      // of the "somebody grabbed that" read.
      pile.mesh.rotation.y = this.clock * SPIN_RATE + pile.spin + t * 5;
      (pile.mesh.material as MeshStandardNodeMaterial).opacity = 1 - t;
    }
  }

  /** How many piles are being drawn, lifts included. For checks and the debug line. */
  get count(): number {
    return this.piles.size;
  }

  dispose(): void {
    for (const pile of this.piles.values()) {
      this.scene.remove(pile.mesh);
      if (pile.mesh.material !== this.assets.material) (pile.mesh.material as MeshStandardNodeMaterial).dispose();
    }
    this.piles.clear();
    this.assets.dispose();
  }
}

function clampNotes(n: number): number {
  return n < MIN_NOTES ? MIN_NOTES : n > MAX_NOTES ? MAX_NOTES : Math.round(n);
}
