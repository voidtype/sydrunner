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
 *
 * **Somebody did.** `world/giverbodies.ts` stands them up -- a pooled rig in one
 * of the crowd's own seven kits, on the same range and the same beat as this
 * field -- and `QuestMarkerSource.headY` is the hook that paragraph asked for.
 * When it answers, the mark hangs off `BONE.HEAD` through
 * `game/giverbodies.markYFromHeadBone`; when it does not -- a giver too far for
 * a body, or a session where the pool is full -- the old ground arithmetic still
 * serves, and the two are arranged to agree to a millimetre for a figure in the
 * bind pose so a body appearing under a mark does not move it. The clearance
 * itself now lives in `game/giverbodies.MARK_CLEARANCE_M`, which is the one
 * place both halves can read it.
 *
 * ---------------------------------------------------------------------------
 * ONE MARK IS ALLOWED TO SHOUT, AND THE CONTENT FILE DECIDES WHICH
 *
 * `DESIGN.md` rule 6 is that the city does not shout, and everything above is
 * that rule: one gold, two glyphs, 150 m, and a marker that means "that one,
 * over there" rather than "look at me". The one case it cannot serve is the
 * **first** one -- a player at level 1 standing in Sydney Park who has never
 * seen a `!` and does not know there is anything to walk toward. Ten givers on
 * a rung at 150 m each is 0.016% of this city; the ordinary rule is a reward for
 * already being in the right place, and there is no right place yet.
 *
 * So a `DialogNpc` may carry `"marker": "hero"` (`questmodel.NPC_MARKER`) and
 * one does: the Ladmaster, in the park, in sight of the spawn. It changes three
 * numbers and **no geometry** -- same two quads, same halo, same buffers, same
 * single draw call, so a hero costs exactly what an ordinary mark costs:
 *
 *   - `HERO_RANGE_M` / `HERO_FADE_FULL_M` instead of the ordinary pair, so it is
 *     seen from four hundred metres rather than a hundred and fifty;
 *   - `HERO_SCALE` on the whole apparent-size curve, so it is two and a half
 *     times the glyph at every distance and still shrinks with range;
 *   - **the cap prefers it.** `MAX_MARKERS` is twelve and a hero displaces an
 *     ordinary mark rather than being dropped by one, because the whole reason
 *     a hero exists is that the player has not been told anything yet.
 *
 * It is content-driven rather than a special case for this npc id, which is the
 * only part of it worth defending: the next hero quest -- the act 3 door, the
 * first faction handler somebody has to find -- gets one by editing a JSON file
 * on github.com, which is what `server/quests.ts`'s whole publish path is for.
 * What it must **not** become is a field a hundred pool givers set. There is
 * exactly one in `content/` today.
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
  HEAD_BONE_HEIGHT,
  MARK_CLEARANCE_M,
  giverHash,
  markYFromGround,
  markYFromHeadBone,
} from '../game/giverbodies.ts';
import { GIVER_GOLD } from '../game/givermap.ts';
import {
  NPC_MARKER,
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
 * And the hero's own two, which are the answer to an arithmetic problem rather
 * than a taste one.
 *
 * A player spawns in Sydney Park at level 1 with nothing in the world to walk
 * toward. Ten givers on a rung, each visible inside 150 m, is about 0.7 km^2 of
 * a 4,528 km^2 city -- 0.016% -- so the ordinary marker is a *reward for already
 * being in the right place*, which is exactly the right rule for the ninety-nine
 * quests a player finds after they know what a quest is, and no use at all for
 * the one that tells them.
 *
 * A `'hero'` npc (`questmodel.NPC_MARKER`) is seen from 400 m and drawn at
 * `HERO_SCALE`. Four hundred metres is chosen against the spawn: the dither disc
 * is 100 m (`game/spawn.SPAWN_DITHER_RADIUS`) and the Ladmaster stands 45 m from
 * its centre, so the worst case a player can be handed is 145 m and the mark is
 * comfortably in frame from anywhere in the disc with room for somebody who
 * wandered. It is not larger because the mark is **depth tested** like every
 * other one -- see the header -- so a hero across the city is behind a building,
 * and a range that reached further would only add marks nobody can see.
 */
export const HERO_RANGE_M = 400;
export const HERO_FADE_FULL_M = 340;

/**
 * How much bigger a hero's `!` is. Deliberately unmissable.
 *
 * 2.6 rather than 2 because the apparent-size clamp is already shrinking a
 * distant mark sub-linearly (`markerScale`), so a hero at 145 m has to beat both
 * the distance and the ordinary marks beside it. At arm's length it is a 2.2 m
 * glyph, which is absurd and correct: this is the one marker in the game whose
 * job is to be seen by somebody who does not yet know that markers exist.
 */
export const HERO_SCALE = 2.6;

/**
 * The em box, in metres, before the distance scale.
 *
 * 0.85 m is about the height of a person's head and shoulders, which is the
 * size that reads as "a sign over somebody" rather than as a prop of its own.
 */
export const GLYPH_EM_M = 0.85;

/**
 * How far over the ground the glyph's baseline floats, when there is no body.
 *
 * `FIGURE_HEIGHT + 0.62`, as it always was, with the `0.62` now named in
 * `game/giverbodies.ts` so the head-bone path can add the identical clearance to
 * the identical crown. `markYFromGround` is this expression; it is kept as a
 * constant as well because the buffer arithmetic in the header quotes it.
 */
const MARKER_LIFT_M = FIGURE_HEIGHT + MARK_CLEARANCE_M;

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
 *
 * **The literal moved and the argument did not.** It is now
 * `game/givermap.GIVER_GOLD`, because the compass and the big map draw the same
 * `!` in the same gold and neither may import this module -- they are 2D canvas
 * overlays and this file imports `three/webgpu` -- and because the check that
 * ties the two together runs in the Bun server's boot list, where there is no
 * renderer at all. One triple, three readers, and the reasoning stays here
 * where it was made. See `game/givermap.ts`'s header.
 */
const FACE_COLOUR = GIVER_GOLD;

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

/**
 * How far a mark of this loudness is worth drawing, and where its fade starts.
 *
 * One function rather than two constants read at four call sites, because the
 * range test in `rescan` and the fade in `write` have to agree about the same
 * pair or a hero mark is either culled while still solid or drawn at zero alpha
 * for 250 m of nothing.
 */
export function markerReach(hero: boolean): { full: number; range: number } {
  return hero ? { full: HERO_FADE_FULL_M, range: HERO_RANGE_M } : { full: FADE_FULL_M, range: MARKER_RANGE_M };
}

/** Marker opacity at a distance. 1 near, 0 past the range, smooth between. */
export function markerAlpha(distance: number, hero = false): number {
  const { full, range } = markerReach(hero);
  if (distance <= full) return 1;
  if (distance >= range) return 0;
  const t = (distance - full) / (range - full);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * World-space scale multiplier at a distance. See `SCALE_FROM`.
 *
 * `hero` multiplies the whole curve rather than raising the floor, which is the
 * difference between "a big marker" and "a marker that is big at every
 * distance": the sub-linear growth is the depth cue, and a hero that flattened
 * it would read as a HUD element pasted over Sydney -- which is the one thing
 * `verifyQuestMarkers` has always refused, and now refuses for both sizes.
 */
export function markerScale(distance: number, hero = false): number {
  const grown = distance <= SCALE_FROM ? 1 : Math.min(SCALE_MAX, Math.pow(distance / SCALE_FROM, SCALE_POWER));
  return hero ? grown * HERO_SCALE : grown;
}

/**
 * A stable per-NPC phase offset, so a street of givers does not bob in unison.
 *
 * A cheap string hash rather than an index, because the index of an NPC in the
 * bundle changes the moment somebody edits a content file and every marker in
 * Sydney would re-phase on a publish.
 *
 * The hash itself now lives in `game/giverbodies.giverHash`, which is the same
 * FNV-1a this function has always had, moved to the three-free side because the
 * bodies under these marks need it too -- the mark's bob and the giver's kit and
 * her place in the idle cycle are one person's number rather than three. The
 * arithmetic below is untouched, so no marker in Sydney re-phased.
 */
export function bobPhase(id: string): number {
  return (giverHash(id) % 628) / 100;
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
  /**
   * The world y of this giver's **head bone**, if somebody is drawing her a
   * body, and `null` otherwise. `world/giverbodies.GiverBodyField.headY`.
   *
   * Optional, and that is not laziness: this field predates the bodies, the
   * check below drives it with no body field at all, and a mark over a giver too
   * far away for a rig has to keep working. When it answers, the mark hangs off
   * the rig; when it does not, the ground arithmetic serves. The header says why
   * the two agree.
   */
  headY?(id: string): number | null;
}

/** One mark, resolved. Held between rescans and billboarded every frame. */
interface LiveMarker {
  kind: QuestMarker;
  x: number;
  y: number;
  z: number;
  phase: number;
  /** `DialogNpc.marker === 'hero'`. Decides the reach, the size and the cap. */
  hero: boolean;
}

export class QuestMarkerField {
  readonly mesh: Mesh;
  readonly material: MeshBasicNodeMaterial;

  /** How many marks were drawn last frame. For the check, and for a console poke. */
  live = 0;
  /**
   * How many decisions this field has taken. **The 4 Hz beat, made readable.**
   *
   * `world/giverbodies.ts` draws the bodies under these marks on the same range,
   * the same cap and -- because of this counter -- literally the same clock: it
   * re-decides when this number changes rather than keeping a second
   * accumulator that would drift a frame either side of this one. A counter
   * rather than a callback for `FactionField.events`' reason: this object has no
   * business knowing that anything else exists.
   */
  beats = 0;
  /**
   * Givers in range with something to say who did not fit the cap.
   *
   * A number that should stay at zero and is worth having anyway: twelve was
   * chosen against a content pool nobody has written yet, and the day a CBD
   * block holds fifteen givers this is the only thing that would say so.
   */
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
    this.beats++;
    const npcs = source.npcs();
    if (npcs.length === 0) return;
    // Built once per rescan rather than per NPC: `view()` indexes the whole
    // bundle and `facts()` builds a `Set` of the story flags.
    const view = source.view();
    const facts = source.facts();
    const range2 = MARKER_RANGE_M * MARKER_RANGE_M;
    const heroRange2 = HERO_RANGE_M * HERO_RANGE_M;
    for (const npc of npcs) {
      const hero = npc.marker === NPC_MARKER.HERO;
      const dx = npc.x - this.camPos.x;
      const dz = npc.z - this.camPos.z;
      // The cheap test first, as it always was, but with the hero's own reach.
      // A string compare per giver is one more comparison in front of a
      // multiply; `markerFor` behind it is a walk of a dialog tree.
      if (dx * dx + dz * dz > (hero ? heroRange2 : range2)) continue;
      const kind = markerFor(npc, facts, view);
      if (kind === 'none') continue;
      if (this.markers.length >= MAX_MARKERS) {
        /*
         * **A hero mark is never the one the cap drops.**
         *
         * Twelve is sized against a content pool nobody had written when it was
         * chosen, and a hero exists precisely because the player has not been
         * told anything yet -- so a tutorial that loses a coin toss with the
         * eleventh pool giver on a CBD block is a tutorial that sometimes does
         * not happen, on a machine where nothing looks wrong. The eviction is a
         * linear scan of at most twelve, on a 4 Hz beat, in the branch that only
         * runs when the cap is already reached.
         */
        const victim = hero ? this.markers.findIndex((m) => !m.hero) : -1;
        if (victim < 0) {
          this.dropped++;
          continue;
        }
        this.markers.splice(victim, 1);
        this.dropped++;
      }
      // **Off the head when there is a head.** See the header's last section:
      // `headY` answers for a giver `world/giverbodies.ts` is drawing, and the
      // crown offset plus the clearance is `markYFromHeadBone`. Otherwise the
      // ground, plus a person, plus the same clearance -- and for a figure
      // standing in the bind pose the two are the same number, so a body
      // arriving under a mark does not move it.
      const head = source.headY?.(npc.id) ?? null;
      this.markers.push({
        kind,
        x: npc.x,
        y: head === null ? markYFromGround(source.groundAt(npc.x, npc.z)) : markYFromHeadBone(head),
        z: npc.z,
        phase: bobPhase(npc.id),
        hero,
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
      const alpha = markerAlpha(distance, marker.hero);
      if (alpha <= 0) continue;
      const glyph = marker.kind === 'turnin' ? QUERY : BANG;
      const scale = markerScale(distance, marker.hero) * GLYPH_EM_M;
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

  /**
   * The baseline height of the nth live mark, or `null`.
   *
   * For the check, and for a console poke. The height is the one thing about a
   * mark that a screenshot cannot settle -- a mark 45 cm too low over a giver is
   * a mark over a giver -- so it is worth being able to read the number.
   */
  markerHeight(index: number): number | null {
    const marker = this.markers[index];
    return marker === undefined ? null : marker.y;
  }

  /**
   * Is the nth live mark a hero's? For the check, and for a console poke.
   *
   * The cap's preference is the one thing about this feature that is invisible
   * in every screenshot that is not the exact screenshot where it went wrong --
   * a hero dropped by a crowd looks like a hero who has nothing to give -- so
   * the answer is worth being able to read.
   */
  markerIsHero(index: number): boolean | null {
    const marker = this.markers[index];
    return marker === undefined ? null : marker.hero;
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

  // --- The hero mark: the reach, the size, and the cap that must prefer it.
  //
  // Every one of these is silent. A hero that reaches no further than an
  // ordinary mark is a tutorial nobody finds; a hero at the ordinary size is a
  // marker in a park with nothing to distinguish it; a hero that grew to a
  // *constant* apparent size is a HUD element pasted over Sydney, which is the
  // failure `markerScale` has always been written against; and a hero the cap
  // drops is the first thirty seconds of the game not happening, on a CBD block,
  // sometimes.
  if (markerAlpha(MARKER_RANGE_M + 10, true) <= 0) failures.push('A hero mark is invisible past the ordinary range.');
  if (markerAlpha(HERO_FADE_FULL_M, true) !== 1) failures.push('A hero mark is not solid inside its own fade.');
  if (markerAlpha(HERO_RANGE_M, true) !== 0 || markerAlpha(HERO_RANGE_M + 50, true) !== 0) {
    failures.push(`A hero mark is still drawn past ${HERO_RANGE_M} m.`);
  }
  if (markerAlpha(HERO_RANGE_M - 20, true) <= 0 || markerAlpha(HERO_RANGE_M - 20, true) >= 1) {
    failures.push('The hero fade between its two distances is not a ramp.');
  }
  if (markerScale(5, true) <= markerScale(5)) failures.push('A hero mark at arm’s length is no bigger than an ordinary one.');
  if (Math.abs(markerScale(5, true) - HERO_SCALE) > 1e-9) {
    failures.push(`A hero mark inside the scale floor is ${markerScale(5, true)}x, not ${HERO_SCALE}x.`);
  }
  // Bigger in world space and still smaller on screen with distance: the depth
  // cue has to survive the multiplier or the hero reads as an overlay.
  if (markerScale(HERO_RANGE_M, true) / HERO_RANGE_M >= markerScale(SCALE_FROM, true) / SCALE_FROM) {
    failures.push('A distant hero mark is not smaller on screen than a near one; it would read as a HUD element.');
  }
  if (markerReach(true).range <= markerReach(false).range) failures.push('The hero reach is not longer than the ordinary one.');

  {
    const field = new QuestMarkerField();
    const npcOf = (id: string, x: number, z: number, hero: boolean): DialogNpc =>
      parseDialogPack(
        {
          npcs: [
            {
              id,
              x,
              z,
              radius: 5,
              marker: hero ? 'hero' : '',
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

    // A hero two hundred metres out is drawn where an ordinary giver is gone.
    field.update(1, camera, source([npcOf('ordinary', 200, 0, false)]));
    if (field.live !== 0) failures.push('An ordinary giver 200 m away drew a mark.');
    field.update(1, camera, source([npcOf('lad', 200, 0, true)]));
    if (field.live !== 1) failures.push(`A hero 200 m away drew ${field.live} marks.`);
    if (field.markerIsHero(0) !== true) failures.push('The field did not record the mark as a hero’s.');
    // And a hero past its own reach is gone entirely rather than drawn at nothing.
    field.update(1, camera, source([npcOf('lad', HERO_RANGE_M + 40, 0, true)]));
    if (field.live !== 0) failures.push(`A hero ${HERO_RANGE_M + 40} m away still drew a mark.`);

    // The same two quads and the same halo. A hero that grew the glyph would
    // silently need bigger buffers, which in a typed array is a corrupt frame.
    field.update(1, camera, source([npcOf('lad', 10, 0, true)]));
    if (field.mesh.geometry.drawRange.count !== BANG.length * INDICES_PER_QUAD * 2) {
      failures.push(`A hero "!" drew ${field.mesh.geometry.drawRange.count} indices; it is the same two quads and a halo.`);
    }

    /*
     * **The cap prefers the hero**, which is the assertion the whole feature
     * rests on and the one nothing else would catch. Twelve ordinary givers are
     * offered first, so the naive loop is already full by the time the hero is
     * reached and would drop him.
     */
    const crowd: DialogNpc[] = [];
    for (let i = 0; i < MAX_MARKERS + 4; i++) crowd.push(npcOf(`n${i}`, i * 2 + 4, 0, false));
    crowd.push(npcOf('lad', 60, 0, true));
    field.update(1, camera, source(crowd));
    if (field.live > MAX_MARKERS) failures.push(`${field.live} markers were written into buffers sized for ${MAX_MARKERS}.`);
    let heroes = 0;
    for (let i = 0; i < MAX_MARKERS; i++) if (field.markerIsHero(i) === true) heroes++;
    if (heroes !== 1) failures.push(`A hero behind ${MAX_MARKERS + 4} ordinary givers was dropped by the cap.`);
    field.dispose();
  }

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

    // The beat, which `world/giverbodies.ts` now runs its own decision off. A
    // counter that did not move would freeze every giver's body at whatever it
    // was on the first frame, and nothing about the marks would look wrong.
    const firstBeat = field.beats;
    if (firstBeat === 0) failures.push('The marker field took a decision without counting a beat.');
    field.update(1, camera, source([]));
    if (field.beats !== firstBeat + 1) failures.push('The rescan beat does not advance on an empty bundle.');

    // One giver, in range, with a job on this rung: a mark, and a draw range.
    field.update(1, camera, source([giver('a', 10, 0)]));
    if (field.live !== 1) failures.push(`One giver with a takeable job drew ${field.live} marks.`);
    if (field.mesh.geometry.drawRange.count !== BANG.length * INDICES_PER_QUAD * 2) {
      failures.push(`A single "!" drew ${field.mesh.geometry.drawRange.count} indices; it is two quads and a halo.`);
    }
    // And out of range it is gone entirely rather than drawn at nothing.
    field.update(1, camera, source([giver('a', MARKER_RANGE_M + 40, 0)]));
    if (field.live !== 0) failures.push(`A giver ${MARKER_RANGE_M + 40} m away still drew a mark.`);

    // --- The head, which is what `world/giverbodies.ts` was written for.
    //
    // Three things, and all three are silent: the two heights disagreeing puts a
    // visible step in every mark on the beat a body appears under it; the hook
    // being ignored leaves the whole feature doing nothing; and the crown offset
    // being forgotten puts the mark 45 cm low, which on a screenshot of one
    // giver simply looks like a design decision.
    {
      const g = 4.25;
      const ground = 12.0;
      // `markYFromGround` is the constant this file has always used, restated
      // through the shared clearance. If those two ever part, the fallback path
      // and the header's arithmetic are describing different marks.
      if (Math.abs(markYFromGround(ground) - (ground + MARKER_LIFT_M)) > 1e-9) {
        failures.push('The ground fallback no longer matches this file’s own lift.');
      }
      const withBody: QuestMarkerSource = {
        ...source([giver('a', 10, 0)]),
        groundAt: () => g,
        // A figure standing on `g` in the bind pose.
        headY: () => g + HEAD_BONE_HEIGHT,
      };
      field.update(1, camera, withBody);
      if (field.live !== 1) failures.push('A giver with a body drew no mark.');
      const posed = field.markerHeight(0);
      if (posed === null) failures.push('The field kept no marker to read a height off.');
      else if (Math.abs(posed - markYFromGround(g)) > 1e-6) {
        failures.push(
          `A mark over a body sits at ${posed.toFixed(3)} m and over bare ground at ` +
            `${markYFromGround(g).toFixed(3)} m; it would jump when she appears.`,
        );
      }
      // A head that moves takes the mark with it, and by the same amount.
      const dropped: QuestMarkerSource = { ...withBody, headY: () => g + HEAD_BONE_HEIGHT - 0.5 };
      field.update(1, camera, dropped);
      const after = field.markerHeight(0);
      if (posed !== null && after !== null && Math.abs(posed - after - 0.5) > 1e-6) {
        failures.push(`A head 0.5 m lower moved the mark by ${(posed - after).toFixed(3)} m.`);
      }
    }

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
