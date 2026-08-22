/**
 * The yellow `!` over the head of somebody with a job for you, and the `?` over
 * somebody waiting to take one back.
 *
 * The owner's words, and the whole brief: *"all quests should be on a strict
 * per level register, and show up as yellow exclamation mark above where the
 * quest is given"*. The register is the phone's (`client/src/dialog.ts`) and the
 * rung is the model's (`game/questmodel.ts`); this file is the half that stands
 * in the street.
 *
 * The `?` was not asked for by name and is here anyway, because it is the same
 * mechanism and the pair is one idea rather than two: WoW taught a generation
 * that `!` means *there is something here* and `?` means *come back and get
 * paid*, and shipping the first without the second would be a game that tells
 * you where to start a job and nothing at all about where to finish it.
 *
 * ---------------------------------------------------------------------------
 * ONE RULE, AND THIS FILE DOES NOT OWN IT
 *
 * `questmodel.markerFor` decides. It is pure, three-free, and it is the *same*
 * function reading the *same* `choiceRefusal` that the dialog panel greys its
 * buttons with -- so a mark and the conversation under it cannot disagree.
 * That was the one design constraint on this feature: a `!` over an NPC whose
 * every button is greyed out is worse than no `!` at all, because the player
 * has already crossed Sydney by the time they find out.
 *
 * What this file owns is *where* and *how big*, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * ONE MESH, ONE MATERIAL, ONE DRAW CALL -- AND NO TEXTURE
 *
 * `world/nameplates.ts`'s arrangement, for its reasons, which are not re-argued
 * here: a material is a WebGPU pipeline, a pipeline compiled on the frame an
 * object first appears is a hitch at the worst possible moment, and a dynamic
 * geometry rewritten on the CPU is cheaper than the matrix maths an instanced
 * path would need to do anyway, because a billboard is recomputed per frame
 * either way.
 *
 * The one place this departs from the plate field is that there is **no canvas
 * atlas**. A plate has to draw arbitrary player names and so must raster text;
 * a marker draws exactly two glyphs, forever, and two glyphs are cheaper as
 * geometry than as a texture. `BANG` and `QUERY` below are lists of quads in a
 * unit em-box, stroked out of a polyline, and the whole feature is therefore:
 *
 *   - **buildable without a `document`**, which is what lets
 *     `bun run client/src/perf-harness.ts --coverage` construct this field and
 *     audit its warm-up part against the mesh it actually draws. The plate
 *     field and the sun button are both on that audit's "cannot reach" list
 *     precisely because they build a `CanvasTexture` in their constructors.
 *   - free of a 2 MB atlas upload and of any mip/anisotropy question.
 *
 * Twenty-two quads is the worst case for one marker (eleven for the `?`, twice
 * over for the outline), twelve markers is the cap, so the buffers are 264
 * quads -- 1,056 vertices rewritten per frame at a full dozen givers on screen,
 * which is less than half of what a sixteen-player nameplate field writes.
 *
 * ---------------------------------------------------------------------------
 * OCCLUDED, WHICH IS THE OPPOSITE OF WHAT THE PLATES DO
 *
 * `depthTest` is **on** here and off there, and the difference is not an
 * oversight in one of the two files -- it is the same question answered for two
 * different jobs.
 *
 * A nameplate is combat information: knowing that Shazza is on two pips behind
 * the Queen Victoria Building is the read that feature exists to give, and
 * sixteen of them is a bounded number of things to draw through a wall. A quest
 * marker is **wayfinding**, there are hundreds of givers once the content pool
 * lands, and a CBD block seen through its own buildings would be a picket fence
 * of exclamation marks over the skyline pointing at nothing you can walk to.
 * Occluded, a marker means "that one, over there, and you can see where" --
 * which is the sentence a marker is for.
 *
 * `depthWrite` is off, as it is on every diegetic overlay in this renderer: it
 * is signage, not a surface. The outline pass is drawn immediately before the
 * face for the same reason -- with alpha blending and no depth write, later
 * simply wins, and there is no z-fighting to arrange.
 *
 * Nothing casts. A translucent unlit quad in the sun's depth pass would put a
 * hard rectangle of shadow on the footpath under every quest giver.
 *
 * ---------------------------------------------------------------------------
 * TWO CLOCKS
 *
 * The **billboard** is rewritten every frame, because a marker whose facing lags
 * a mouse turn by a quarter-second reads as broken. The **decision** -- who is
 * in range, what the ground height under them is, and what `markerFor` says --
 * runs at `RESCAN_HZ`, which is 4, and that is a cost argument rather than a
 * taste one: `markerFor` walks an NPC's whole dialog tree through
 * `choiceRefusal`, and doing that for every giver in range on every frame of a
 * 120 Hz session would be thousands of string comparisons a frame to notice
 * something that changes when a quest is accepted. `client/src/dialog.ts` runs
 * its own prompt sweep on exactly this clock and says the same thing about it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE HEAD IS, WHEN THERE IS NO HEAD
 *
 * A dialog NPC in a content pack is an `(x, z)` and a radius. Nothing in this
 * client draws a body for one yet -- Denise is a conversation and a prompt at a
 * coordinate in Redfern, not a figure -- so the marker is placed at the ground
 * height under that coordinate plus a person's height, and for now it is the
 * only thing in the world that says a giver is standing there at all. That is a
 * gap this feature happens to paper over and not one it should be trusted to
 * fix: when somebody gives the givers bodies, the height here should come off
 * the rig's head bone the way `main.ts` feeds the plate field.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  FrontSide,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';

import { FIGURE_HEIGHT } from '../player/animation.ts';
import {
  markerFor,
  parseDialogPack,
  parseQuestPack,
  questView,
  type DialogNpc,
  type PlayerFacts,
  type QuestMarker,
  type QuestView,
} from '../game/questmodel.ts';
import type { WarmupPart } from './warmup.ts';

// --- Sizes and distances, in world metres ---------------------------------------

/**
 * How far a marker is worth drawing. The brief's number.
 *
 * A hundred and fifty metres is about two Sydney blocks, which is the distance
 * at which "there is something over there" is still an invitation rather than a
 * map. Past it the marker is gone entirely rather than dimmed to nothing,
 * because the cost that matters is the decision behind it and not the quads.
 */
export const MARKER_RANGE_M = 150;

/** Full strength to here, then a smooth ramp to nothing at `MARKER_RANGE_M`. */
export const FADE_FULL_M = 110;

/**
 * The em box, in metres, before the distance scale.
 *
 * 0.85 m is about the height of a person's head and shoulders, which is the
 * size that reads as "a sign over somebody" rather than as a prop of its own.
 */
export const GLYPH_EM_M = 0.85;

/** How far over the ground the glyph's baseline floats. */
const MARKER_LIFT_M = FIGURE_HEIGHT + 0.62;

/** How far the bob travels, and how fast. Slow, because it is not an alarm. */
const BOB_M = 0.085;
const BOB_HZ = 0.55;

/**
 * The apparent-size clamp, on `nameplates.plateScale`'s argument and with its
 * shape: inside `SCALE_FROM` the glyph is its honest size, and beyond it grows
 * sub-linearly so a marker two blocks away is smaller on screen than one at
 * arm's length -- which is the depth cue -- without shrinking to a pixel.
 */
const SCALE_FROM = 22;
const SCALE_POWER = 0.75;
const SCALE_MAX = 6;

/** How many markers may be on screen at once. See the header's arithmetic. */
export const MAX_MARKERS = 12;

/** How often the decision runs. The billboard runs every frame; see the header. */
export const RESCAN_HZ = 4;

// --- The two glyphs -------------------------------------------------------------

/**
 * Gold, and the same gold for both marks.
 *
 * The owner asked for yellow and WoW's pair is yellow twice over: the glyph is
 * the difference, not the hue, and two colours would be a second thing to learn
 * for a distinction the shape already makes at any distance the mark is legible
 * at.
 */
const FACE_COLOUR = { r: 1, g: 0.82, b: 0.16 };

/**
 * And a near-black halo behind it, which is not decoration.
 *
 * Sydney at 3 pm is the brightest surface this game has and a gold glyph against
 * a white-rendered wall in full sun has no edge at all. `nameplates.BAR_BORDER`
 * makes the identical argument about its own dark margin; this is that idea for
 * a shape rather than a bar, and it costs one more copy of the same quads.
 */
const OUTLINE_COLOUR = { r: 0.05, g: 0.04, b: 0.02 };
const OUTLINE_ALPHA = 0.78;
/** How much bigger the halo is than the face. Uniform, about the glyph origin. */
const OUTLINE_GROW = 1.17;

/** One quad, as four (x, y) corners in em units: bottom-left, BR, TR, TL. */
type Quad = readonly number[];

/** An axis-aligned rectangle, wound counter-clockwise. */
function rect(x0: number, y0: number, x1: number, y1: number): Quad {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/**
 * A polyline given a thickness: one quad per segment.
 *
 * The left-hand perpendicular is used for every segment, which is what makes
 * the winding **consistently counter-clockwise whichever way the line runs** --
 * and that is load-bearing rather than tidy, because the material is
 * single-sided (`nameplates` measured what `DoubleSide` plus `transparent`
 * costs in this renderer: two passes and two pipelines) and a quad wound the
 * other way would simply not be drawn.
 *
 * The joints are left as overlapping corners rather than mitred. At the sizes
 * this draws at the overlap is sub-pixel, and a mitre would be twenty lines of
 * arithmetic in service of a glyph nobody reads from closer than three metres.
 */
function stroke(points: readonly (readonly [number, number])[], halfWidth: number): Quad[] {
  const out: Quad[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) continue;
    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    out.push([ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny, ax + nx, ay + ny]);
  }
  return out;
}

/** Points along a circular arc, `fromDeg` to `toDeg`, in `segments` steps. */
function arcPoints(
  cx: number,
  cy: number,
  radius: number,
  fromDeg: number,
  toDeg: number,
  segments: number,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / segments) * Math.PI) / 180;
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return out;
}

/**
 * The exclamation mark: a tapered stem and a dot. Two quads.
 *
 * Tapered rather than a rectangle because a bar of even width reads as a
 * pillar; every `!` anybody has ever seen is wider at the top.
 */
const BANG: readonly Quad[] = [
  [-0.09, -0.04, 0.09, -0.04, 0.13, 0.5, -0.13, 0.5],
  rect(-0.12, -0.44, 0.12, -0.19),
];

/**
 * The question mark: a hook, a tail and a dot. Eleven quads.
 *
 * One polyline -- 230 degrees of arc around a centre a little above the middle,
 * then two segments falling away to the left -- stroked at a constant width, so
 * the shape is described once and the thickness is one number to change.
 */
const QUERY: readonly Quad[] = [
  ...stroke(
    [...arcPoints(0, 0.235, 0.18, 200, -30, 8), [0.104, 0.055], [0, -0.02]],
    0.085,
  ),
  rect(-0.11, -0.44, 0.11, -0.19),
];

/** Both, twice over for the halo. The buffers are sized on this. */
const MAX_QUADS_PER_MARKER = 2 * Math.max(BANG.length, QUERY.length);

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

// --- Pure maths, so the check can reach it ---------------------------------------

/** Marker opacity at a distance. 1 near, 0 past the range, smooth between. */
export function markerAlpha(distance: number): number {
  if (distance <= FADE_FULL_M) return 1;
  if (distance >= MARKER_RANGE_M) return 0;
  const t = (distance - FADE_FULL_M) / (MARKER_RANGE_M - FADE_FULL_M);
  return 1 - t * t * (3 - 2 * t);
}

/** World-space scale multiplier at a distance. See `SCALE_FROM`. */
export function markerScale(distance: number): number {
  if (distance <= SCALE_FROM) return 1;
  return Math.min(SCALE_MAX, Math.pow(distance / SCALE_FROM, SCALE_POWER));
}

/**
 * A stable per-NPC phase offset, so a street of givers does not bob in unison.
 *
 * A cheap string hash rather than an index, because the index of an NPC in the
 * bundle changes the moment somebody edits a content file and every marker in
 * Sydney would re-phase on a publish.
 */
export function bobPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 628) / 100;
}

// --- What the field is told ------------------------------------------------------

/**
 * Everything the field reads, supplied by `main.ts` as closures.
 *
 * `DialogSource`'s arrangement, one file over, and for its reason: this object
 * reaches into nothing and the one file that knows where the player is, what
 * the ground is doing and what the server last said is the one that assembles
 * it. Every method here is called on the **rescan beat only** -- four times a
 * second, not per frame -- which is what makes it safe for `view()` to build an
 * index and `facts()` to build a `Set`.
 */
export interface QuestMarkerSource {
  npcs(): readonly DialogNpc[];
  view(): QuestView;
  facts(): PlayerFacts;
  /** Ground height under a point. `main.ts`'s `wildGround`, never `groundHeightAt`. */
  groundAt(x: number, z: number): number;
}

/** One mark, resolved. Held between rescans and billboarded every frame. */
interface LiveMarker {
  kind: QuestMarker;
  x: number;
  y: number;
  z: number;
  phase: number;
}

export class QuestMarkerField {
  readonly mesh: Mesh;
  readonly material: MeshBasicNodeMaterial;

  /** How many marks were drawn last frame. Read by `sydney.quests` in `main.ts`. */
  live = 0;
  /** Givers in range that did not fit the cap. A number that should stay at 0. */
  dropped = 0;

  private readonly position: Float32Array;
  private readonly colour: Float32Array;
  private readonly positionAttr: BufferAttribute;
  private readonly colourAttr: BufferAttribute;
  private quads = 0;

  private readonly markers: LiveMarker[] = [];
  private sinceRescan = Infinity;
  private clock = 0;

  private readonly camPos = { x: 0, y: 0, z: 0 };
  private readonly camRight = { x: 1, y: 0, z: 0 };
  private readonly camUp = { x: 0, y: 1, z: 0 };

  constructor() {
    const verts = MAX_MARKERS * MAX_QUADS_PER_MARKER * VERTS_PER_QUAD;
    this.position = new Float32Array(verts * 3);
    this.colour = new Float32Array(verts * 4);
    this.positionAttr = new BufferAttribute(this.position, 3);
    this.colourAttr = new BufferAttribute(this.colour, 4);
    this.positionAttr.setUsage(DynamicDrawUsage);
    this.colourAttr.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.name = 'quest_markers';
    geometry.setAttribute('position', this.positionAttr);
    // Four components: the fade and the halo's own opacity both live in the
    // alpha and both vary per quad. `NodeMaterial` multiplies a vec4 `color`
    // attribute into the diffuse whole -- the plate field leans on the same
    // thing, and it is why there is no shader of ours anywhere in this file.
    geometry.setAttribute('color', this.colourAttr);
    const index = new Uint16Array(MAX_MARKERS * MAX_QUADS_PER_MARKER * INDICES_PER_QUAD);
    for (let q = 0; q < MAX_MARKERS * MAX_QUADS_PER_MARKER; q++) {
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
    material.name = 'quest_marker';
    // No `colorNode`: white times the per-vertex tint is the whole graph, which
    // is what having no texture buys.
    material.vertexColors = true;
    material.transparent = true;
    // **Occluded.** The header argues this against the plate field's opposite.
    material.depthTest = true;
    material.depthWrite = false;
    material.side = FrontSide;
    material.fog = false;
    material.toneMapped = false;
    this.material = material;

    const mesh = new Mesh(geometry, material);
    mesh.name = 'quest_markers';
    // One geometry spanning the whole city has no useful bounding sphere, and
    // the field is one draw call of at most 528 triangles.
    mesh.frustumCulled = false;
    // Under the nameplates (12) and over the world's own transparents: a plate
    // is the last thing composited and a marker is the second last.
    mesh.renderOrder = 11;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;
  }

  /**
   * One frame. The billboard always; the decision on the rescan beat.
   *
   * `camera` is read for its world matrix only, and is typed structurally so
   * the check can drive this with a bare `Matrix4` and no renderer.
   */
  update(dt: number, camera: { matrixWorld: Matrix4 }, source: QuestMarkerSource): void {
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
    this.clock += dt;

    this.sinceRescan += dt;
    if (this.sinceRescan >= 1 / RESCAN_HZ) {
      this.sinceRescan = 0;
      this.rescan(source);
    }
    this.write();
  }

  /**
   * Who gets a mark, and where their head is. Four times a second.
   *
   * The range test comes **before** `markerFor`, which is the whole of the cost
   * argument: the distance is two subtractions and a compare, and the decision
   * behind it is a walk of a dialog tree. With hundreds of givers in a content
   * pool, the cheap test is what keeps this off the profile.
   */
  private rescan(source: QuestMarkerSource): void {
    this.markers.length = 0;
    this.dropped = 0;
    const npcs = source.npcs();
    if (npcs.length === 0) return;
    // Built once per rescan rather than per NPC: `view()` indexes the whole
    // bundle and `facts()` builds a `Set` of the story flags.
    const view = source.view();
    const facts = source.facts();
    const range2 = MARKER_RANGE_M * MARKER_RANGE_M;
    for (const npc of npcs) {
      const dx = npc.x - this.camPos.x;
      const dz = npc.z - this.camPos.z;
      if (dx * dx + dz * dz > range2) continue;
      const kind = markerFor(npc, facts, view);
      if (kind === 'none') continue;
      if (this.markers.length >= MAX_MARKERS) {
        this.dropped++;
        continue;
      }
      this.markers.push({
        kind,
        x: npc.x,
        y: source.groundAt(npc.x, npc.z) + MARKER_LIFT_M,
        z: npc.z,
        phase: bobPhase(npc.id),
      });
    }
  }

  /** Every live marker's quads, into the buffers, in camera space. */
  private write(): void {
    this.quads = 0;
    this.live = 0;
    for (const marker of this.markers) {
      const dx = marker.x - this.camPos.x;
      const dy = marker.y - this.camPos.y;
      const dz = marker.z - this.camPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const alpha = markerAlpha(distance);
      if (alpha <= 0) continue;
      const glyph = marker.kind === 'turnin' ? QUERY : BANG;
      const scale = markerScale(distance) * GLYPH_EM_M;
      const bob = Math.sin(this.clock * BOB_HZ * Math.PI * 2 + marker.phase) * BOB_M;
      const y = marker.y + bob;
      // The halo first and the face over it. No depth write, so painter's order
      // is the whole of the arrangement -- see the header.
      this.writeGlyph(glyph, marker.x, y, marker.z, scale * OUTLINE_GROW, OUTLINE_COLOUR, alpha * OUTLINE_ALPHA);
      this.writeGlyph(glyph, marker.x, y, marker.z, scale, FACE_COLOUR, alpha);
      this.live++;
    }
    this.mesh.geometry.setDrawRange(0, this.quads * INDICES_PER_QUAD);
    this.positionAttr.needsUpdate = true;
    this.colourAttr.needsUpdate = true;
  }

  private writeGlyph(
    glyph: readonly Quad[],
    x: number,
    y: number,
    z: number,
    scale: number,
    tint: { r: number; g: number; b: number },
    alpha: number,
  ): void {
    for (const quad of glyph) {
      const base = this.quads * VERTS_PER_QUAD;
      for (let c = 0; c < VERTS_PER_QUAD; c++) {
        const gx = quad[c * 2] * scale;
        const gy = quad[c * 2 + 1] * scale;
        const p = (base + c) * 3;
        this.position[p] = x + this.camRight.x * gx + this.camUp.x * gy;
        this.position[p + 1] = y + this.camRight.y * gx + this.camUp.y * gy;
        this.position[p + 2] = z + this.camRight.z * gx + this.camUp.z * gy;
        const k = (base + c) * 4;
        this.colour[k] = tint.r;
        this.colour[k + 1] = tint.g;
        this.colour[k + 2] = tint.b;
        this.colour[k + 3] = alpha;
      }
      this.quads++;
    }
  }

  /** Give the buffers back. Nothing else here allocates GPU memory. */
  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }

  /**
   * The boot warm-up entry, and this field is the same textbook case the door
   * marker is.
   *
   * The geometry is empty until a giver is in range and the mesh is added to the
   * scene from `main.ts`'s quest block, thousands of lines below the boot pass.
   * An empty geometry still carries the attribute *layout* the pipeline is keyed
   * on (`getGeometryCacheKey` reads names and item sizes and nothing about the
   * contents), so handing over the real geometry and the real material warms
   * exactly the pipeline the game will draw with -- which is what
   * `perf-harness --coverage` checks, and why the flags below are copied from
   * the mesh rather than written out from memory.
   */
  warmupParts(): WarmupPart[] {
    return [
      {
        geometry: this.mesh.geometry,
        material: this.material,
        casts: this.mesh.castShadow,
        receives: [this.mesh.receiveShadow],
      },
    ];
  }
}

// --- The self-check ----------------------------------------------------------------

/**
 * What can be wrong here without anything throwing, and every one of these is
 * invisible in a screenshot of a street with no quest giver on it.
 *
 *   - **A quad wound the wrong way** draws nothing at all against a
 *     single-sided material, and the marker is simply absent. `stroke` builds
 *     its perpendicular the same way for every segment precisely so this cannot
 *     happen; the assertion is what keeps that true after somebody edits a
 *     glyph.
 *   - **A glyph outside its em box** is a mark whose halo is clipped by the
 *     buffer's arithmetic rather than by anything visible.
 *   - **The two glyphs being the same** would be a `?` that says `!`, which is
 *     the one thing a player reads these for.
 *   - **The cap not holding** is a write past the end of a `Float32Array`,
 *     which in a typed array is silent.
 *   - **The warm-up part disagreeing with the mesh** is the exact defect
 *     `perf-harness --coverage` exists for, asserted here as well because this
 *     check runs in the browser where the real renderer is.
 */
export function verifyQuestMarkers(): string[] {
  const failures: string[] = [];

  // --- The glyphs, as data.
  if (BANG.length < 2) failures.push('The exclamation mark has fewer than two quads; it has no dot.');
  if (QUERY.length <= BANG.length) failures.push('The question mark is no more complex than the exclamation mark.');
  for (const [name, glyph] of [['!', BANG], ['?', QUERY]] as Array<[string, readonly Quad[]]>) {
    for (let q = 0; q < glyph.length; q++) {
      const quad = glyph[q];
      if (quad.length !== 8) {
        failures.push(`Glyph ${name} quad ${q} has ${quad.length} numbers, not four corners.`);
        continue;
      }
      // Counter-clockwise in the (right, up) plane, or a single-sided material
      // draws nothing. The z of the cross product of two edges.
      const ax = quad[2] - quad[0];
      const ay = quad[3] - quad[1];
      const bx = quad[6] - quad[0];
      const by = quad[7] - quad[1];
      if (ax * by - ay * bx <= 0) {
        failures.push(`Glyph ${name} quad ${q} is wound away from the camera; it would not be drawn at all.`);
      }
      for (let c = 0; c < 8; c++) {
        if (Math.abs(quad[c]) > 0.55) failures.push(`Glyph ${name} quad ${q} reaches ${quad[c]}, outside the em box.`);
      }
    }
  }

  // --- The distance curves.
  if (markerAlpha(0) !== 1 || markerAlpha(FADE_FULL_M) !== 1) failures.push('A marker is not solid inside the fade.');
  if (markerAlpha(MARKER_RANGE_M) !== 0 || markerAlpha(MARKER_RANGE_M + 50) !== 0) {
    failures.push(`A marker is still drawn past ${MARKER_RANGE_M} m.`);
  }
  if (markerAlpha(130) <= 0 || markerAlpha(130) >= 1) failures.push('The fade between the two distances is not a ramp.');
  if (markerScale(5) !== 1) failures.push('A marker at arm’s length is not its honest size.');
  if (markerScale(MARKER_RANGE_M) <= 1) failures.push('A marker at 150 m is not scaled up at all; it would be a speck.');
  // Bigger in world space and *smaller* on screen, which is the depth cue. Both
  // halves matter: a marker that grew to a constant apparent size would read as
  // a HUD element pasted over the city.
  if (markerScale(MARKER_RANGE_M) / MARKER_RANGE_M >= markerScale(SCALE_FROM) / SCALE_FROM) {
    failures.push('A distant marker is not smaller on screen than a near one; it would read as a HUD element.');
  }
  if (bobPhase('a') === bobPhase('b')) failures.push('Two givers bob in unison; the phase is not derived from the id.');
  if (bobPhase('centrelink-clerk') !== bobPhase('centrelink-clerk')) failures.push('The bob phase is not stable per id.');

  // --- The field itself, driven with a bare matrix and no renderer.
  {
    const field = new QuestMarkerField();
    /** A giver with one takeable job on rung 1, through the real parser. */
    const giver = (id: string, x: number, z: number): DialogNpc =>
      parseDialogPack(
        {
          npcs: [
            {
              id,
              x,
              z,
              radius: 5,
              nodes: [{ id: 'hello', line: 'gday', choices: [{ text: 'the job', accept: 'j' }] }],
            },
          ],
        },
        'fixture',
      ).value.npcs[0];
    const quests = parseQuestPack(
      { quests: [{ id: 'j', giver: 'a', level: 1, steps: [{ kind: 'ko', count: 1 }] }] },
      'fixture',
    ).value.quests;
    const facts: PlayerFacts = { level: 1, faction: '', story: new Set(), cash: 0 };
    const source = (npcs: DialogNpc[]): QuestMarkerSource => ({
      npcs: () => npcs,
      view: () => questView(quests, {}),
      facts: () => facts,
      groundAt: () => 0,
    });
    const camera = { matrixWorld: new Matrix4() };
    // With no npcs at all -- the state every session starts in, before
    // `/content` has answered -- nothing is drawn and nothing throws.
    field.update(1, camera, source([]));
    if (field.live !== 0) failures.push(`An empty bundle drew ${field.live} markers.`);
    if (field.mesh.geometry.drawRange.count !== 0) failures.push('An empty field left a draw range behind.');

    // One giver, in range, with a job on this rung: a mark, and a draw range.
    field.update(1, camera, source([giver('a', 10, 0)]));
    if (field.live !== 1) failures.push(`One giver with a takeable job drew ${field.live} marks.`);
    if (field.mesh.geometry.drawRange.count !== BANG.length * INDICES_PER_QUAD * 2) {
      failures.push(`A single "!" drew ${field.mesh.geometry.drawRange.count} indices; it is two quads and a halo.`);
    }
    // And out of range it is gone entirely rather than drawn at nothing.
    field.update(1, camera, source([giver('a', MARKER_RANGE_M + 40, 0)]));
    if (field.live !== 0) failures.push(`A giver ${MARKER_RANGE_M + 40} m away still drew a mark.`);

    // The cap, and the counter that says it was reached. A buffer overrun in a
    // typed array is silent, which is why this is asserted rather than trusted.
    const crowd: DialogNpc[] = [];
    for (let i = 0; i < MAX_MARKERS + 8; i++) crowd.push(giver(`n${i}`, i * 2 + 4, 0));
    field.update(1, camera, source(crowd));
    if (field.live > MAX_MARKERS) failures.push(`${field.live} markers were written into buffers sized for ${MAX_MARKERS}.`);
    if (field.dropped !== 8) failures.push(`${MAX_MARKERS + 8} givers over a ${MAX_MARKERS} cap dropped ${field.dropped}, not 8.`);

    // The warm-up part must describe the mesh it stands in for. `perf-harness
    // --coverage` asserts the same thing against the real scene graph.
    const parts = field.warmupParts();
    if (parts.length !== 1) failures.push(`The marker field offers ${parts.length} warm-up parts, not one.`);
    const part = parts[0];
    if (part && part.geometry !== field.mesh.geometry) failures.push('The warm-up part is not the geometry the field draws.');
    if (part && part.material !== field.material) failures.push('The warm-up part is not the material the field draws.');
    if (part && part.casts !== field.mesh.castShadow) failures.push('The warm-up part disagrees with the mesh about casting.');
    if (part && part.receives?.[0] !== field.mesh.receiveShadow) {
      failures.push('The warm-up part disagrees with the mesh about receiving.');
    }
    if (field.mesh.castShadow) failures.push('A marker casts a shadow; there would be a rectangle on the footpath.');
    if (!field.material.transparent || field.material.depthWrite) failures.push('The marker material writes depth.');
    if (!field.material.depthTest) failures.push('The marker material does not depth-test; the CBD would be a picket fence.');

    field.dispose();
  }

  return failures;
}
