/**
 * The big map: `M`, and there is Sydney.
 *
 * A near-fullscreen panel over the game, north-up, drawn from the street
 * centrelines of the entire build -- suburb names at every zoom, street names at
 * the two close ones, the harbour, the three hero landmarks, and everyone who
 * can hit you. It is the second map in this client and it is deliberately not
 * the first one made bigger.
 *
 * ---------------------------------------------------------------------------
 * Two maps, because they answer two different questions.
 *
 * `minimap.ts` is a **rotating figure-ground plan at 160 m**. It is up all the
 * time, it turns with the player, and its whole job is *which corner am I
 * running toward* -- read at a glance, in a fight, with a hand on the movement
 * keys. Its header argues that a plan of solid buildings on dark ground reads as
 * a street map without a street in it, and at 160 m with the tiles resident it
 * is right.
 *
 * This is a **north-up city map at up to nine kilometres**. It answers *where is
 * Newtown from here*, and every one of the minimap's decisions is wrong for it:
 *
 *   * **North-up, not heading-up.** A map you stop to read is a map you orient
 *     yourself against, and every printed map of every city is north-up. The
 *     rotating version is for the map that is always on screen and never looked
 *     at directly; a nine-kilometre map that spun as you turned would be
 *     unreadable and, worse, unmemorable -- the thing a player builds over a
 *     session is a mental picture of the city, and it only forms if the picture
 *     is the same one every time.
 *   * **Roads drawn, not implied.** The figure-ground trick needs building
 *     footprints, and the client holds those for 420 m around the player and
 *     nowhere else, by design. At three kilometres there is nothing to imply the
 *     streets *with*. So this draws the centrelines themselves, out of the same
 *     name sidecars `game/locator.ts` reads -- see `mapatlas.ts` for why that is
 *     both available and cheap. The footprints come back at the closest zoom,
 *     where they exist and where they add the texture that tells a terrace
 *     suburb from a tower district.
 *   * **Lettered.** The minimap refuses labels for a good reason -- the streets
 *     there *are* the void between the buildings, and lettering the void fills
 *     the only part of the picture carrying the shape. Here the streets are
 *     lines, the space between them is empty, and a street map without street
 *     names is a diagram of a circuit board.
 *   * **It is not always on.** Every frame the map is closed costs zero: the
 *     panel is `display: none`, `update` returns on its first line, and the
 *     canvas is never touched. That is what buys it the right to cost a few
 *     milliseconds when it is open.
 *
 * `M` toggles this, and the minimap it took the key from is now permanent. That
 * trade is the right way round: the small map is the compass and the locator
 * strip under it is where you are, so it is the one thing a player navigates by
 * continuously -- and a key that hides your compass is a key nobody presses
 * twice. Whereas *this* has to be dismissable, because it covers the game.
 *
 * ---------------------------------------------------------------------------
 * Two canvases: the city is rendered once, the players every frame.
 *
 * A rebuild strokes about 30,000 points and rasterises fifty rotated labels,
 * which is a few milliseconds -- fine once, ruinous at 60 Hz. So everything that
 * only changes when the *view* changes goes into an offscreen canvas (water,
 * roads, footprints, every label, the chrome), and the live frame is a
 * `drawImage` of that plus the dots. The rebuild happens on open, on a zoom, on
 * a resize, when the atlas delivers more of the city, and when the player has
 * moved far enough to need re-centring -- and nothing else.
 *
 * **The map does not scroll under the player, it re-anchors.** The obvious
 * design keeps the player at the centre and slides the world, which means a
 * rebuild on every frame the player is moving, or a scrolled blit with a seam.
 * Instead the view is anchored where it was last built and the player marker
 * moves across it, until they pass `RECENTRE_FRACTION` of the way to the edge --
 * then it re-anchors on them and rebuilds once. At the closest zoom that is 175 m
 * of running per rebuild, or about twenty-five seconds at a sprint.
 *
 * The hidden benefit is the labels. Label placement is a greedy collision cull,
 * so a continuously scrolling map re-solves it every frame and names flicker in
 * and out as the solution changes under them. Anchoring makes the label set a
 * property of the *view* rather than of the frame, so it is stable for as long
 * as the player is looking at it, which is the entire time it is being read.
 *
 * ---------------------------------------------------------------------------
 * Three zooms, and what each is for.
 *
 * They are a ladder rather than a continuum because each rung is a different
 * *map*, with a different rule about what is on it -- and a pinch-zoom through
 * intermediate scales would spend the whole way between two rungs showing either
 * too much or too little:
 *
 *   * **neighbourhood, 1 km across.** Every street, named. Building footprints
 *     from the collision prisms, which reach 420 m and therefore cover it. This
 *     is the "which way to the corner shop" map.
 *   * **district, 3 km across.** Every street still drawn, the significant ones
 *     named. No footprints -- the prisms cover a fifth of it and a map with
 *     buildings in the middle and none at the edges would read as a city that
 *     stops. This is the "which way is Redfern" map.
 *   * **city, 9 km across.** The whole build. Arterials only, no street names,
 *     suburbs and landmarks. This is the "where am I in Sydney" map, and it is
 *     the one that makes a shape out of a session.
 *
 * See `ZOOMS` for the numbers and `mapatlas.ts`'s `importanceOf` for what
 * "significant" and "arterial" are measured with, given the sidecar carries no
 * road class at all.
 */

import type { CollisionWorld, Prism } from './player/collision.ts';
import { markerInk } from './minimap.ts';
import type { MarkerKind, MarkerSink } from './minimap.ts';
import {
  MapAtlas,
  longestStraight,
  type LabelLine,
  type MapLandmark,
  type RoadRun,
} from './mapatlas.ts';

/**
 * Whoever already knows where the powerups and the fighters are.
 *
 * Structural, and pointed at `Minimap` in practice: the small map already has
 * three marker sources registered by `main.ts`, and re-registering them here
 * would be the same three closures in the same file twice, drifting apart the
 * first time one of them changed. So this borrows the small map's list rather
 * than keeping one, which also guarantees the two maps can never disagree about
 * what is in the world.
 */
export interface MarkerCollector {
  collect(sink: MarkerSink, centreX: number, centreZ: number, radius: number): void;
}

/** Where the map is looking. Pure data, so the projection below is testable. */
export interface MapView {
  /** View centre, world metres. */
  cx: number;
  cz: number;
  /** Pixels per world metre. */
  scale: number;
  /** The square canvas's edge, in CSS pixels. */
  size: number;
}

/** One rung of the zoom ladder. */
interface Zoom {
  name: string;
  /** Centre to edge, world metres. The panel is square, so this is both axes. */
  halfM: number;
  /** Only draw a street whose name totals at least this, build-wide. 0 draws all. */
  roadFloor: number;
  /** Only *label* a street above this. `Infinity` labels none. */
  labelFloor: number;
  /** Draw building footprints from the collision prisms. */
  buildings: boolean;
  /** What the chrome calls the width of the view. */
  span: string;
}

/**
 * The ladder. Index 0 is closest; the wheel walks it.
 *
 * The floors are read off the build's own distribution of per-name street
 * length (`mapatlas.ts` documents it): the median name totals 228 m and the
 * ninth decile 1,035 m. So `400` at the district zoom keeps 575 of 1,967 names
 * -- everything anybody would call a street, dropping the service lanes and the
 * driveway stubs -- and `1000` at the city zoom keeps 201, which is the arterial
 * skeleton and reads as one at 0.09 px/m.
 *
 * `city.halfM` is 4,500 because that is exactly the build: the tiles run from
 * -4,500 to +4,500 on both axes, so this rung is the world and there is nothing
 * past it to zoom out to.
 */
const ZOOMS: Zoom[] = [
  { name: 'neighbourhood', halfM: 500, roadFloor: 0, labelFloor: 0, buildings: true, span: '1 km' },
  { name: 'district', halfM: 1500, roadFloor: 0, labelFloor: 400, buildings: false, span: '3 km' },
  { name: 'city', halfM: 4500, roadFloor: 1000, labelFloor: Infinity, buildings: false, span: '9 km' },
];

/**
 * Which rung the map opens on.
 *
 * The district, not the neighbourhood, and it is the one interface decision here
 * worth arguing. A player presses `M` because they want to know where something
 * *else* is -- if they wanted the next corner they would look at the minimap,
 * which is already on screen and already shows it. Three kilometres is the scale
 * at which the answer is usually "that way, past Redfern", and it is one wheel
 * click from either neighbour.
 */
const DEFAULT_ZOOM = 1;

/**
 * How far off centre the player may drift before the view re-anchors, as a
 * fraction of the half-extent. See the header.
 *
 * 0.35 rather than something closer to the edge because the re-anchor is a jump:
 * the whole picture moves at once, and it should happen while the player is
 * still comfortably inside the panel rather than as they are about to leave it.
 * At the closest zoom this is 175 m.
 */
const RECENTRE_FRACTION = 0.35;

/** Redraws a second while the panel is open. See `update`. */
const REDRAW_HZ = 30;
const REDRAW_DT = 1 / REDRAW_HZ;

// --- The ink ------------------------------------------------------------------
//
// Every colour here is already in this interface: the figure and the water are
// `minimap.ts`'s own constants, the label tones are `index.html`'s `#helpfull`
// and `#leaderboard` headings, and the red is the one red. A second map that
// introduced a palette would read as a second program.

/** Roads, at the two weights. Major is the same alpha the minimap gives buildings. */
const ROAD_MAJOR = 'rgba(207,226,242,0.52)';
const ROAD_MINOR = 'rgba(207,226,242,0.26)';
/** Above this build-wide length a name is drawn at the major weight. */
const MAJOR_M = 1200;
const ROAD_MAJOR_PX = 1.7;
const ROAD_MINOR_PX = 0.9;

/** Building footprints, dimmer than the minimap's 0.30: there is more of everything here. */
const BUILDING_FILL = 'rgba(207,226,242,0.22)';
/**
 * The harbour, in `minimap.ts`'s blue at a higher alpha than its 0.16.
 *
 * The colour is the same and the alpha cannot be, because the two are composited
 * over different grounds: the minimap's disc is 55% dark and this panel is 88%
 * (see `index.html` for why it had to be). The same 0.16 over the deeper ground
 * lands about a tenth of the way to the interface's white, which at the city
 * zoom made Blackwattle Bay indistinguishable from the space between two
 * suburbs. 0.24 puts it back where the small map has it -- readable as a
 * distinct region, still clearly behind a building at 0.22 and a road at 0.52.
 */
const WATER_FILL = 'rgba(96,158,214,0.24)';

/** Suburb names: the panel-heading tone, because that is what they are. */
const SUBURB_INK = 'rgba(191,211,229,0.92)';
/** Street names, a tone down -- the suburb is the heading and the street is the line. */
const STREET_INK = 'rgba(147,168,188,0.86)';
/** The landmarks and the chrome. */
const LANDMARK_INK = 'rgba(224,236,247,0.92)';
const CHROME_INK = 'rgba(127,149,171,0.9)';
const SCALE_INK = 'rgba(147,168,188,0.75)';

const PLAYER_FILL = 'rgba(255,255,255,0.95)';
/** The view cone. Barely there on purpose: it is orientation, not a claim about sight lines. */
const CONE_FILL = 'rgba(255,255,255,0.10)';
// The marker inks are not here. They live beside the marker kinds in
// `minimap.ts` and this file imports `markerInk`, because the two maps draw one
// marker list through one `collect` and a second copy of that switch is how the
// big map ends up with a colour the compass does not use.

/**
 * The dark ring every piece of text on this map is drawn over.
 *
 * A **stroked outline** rather than the HUD's usual `text-shadow`, and it is the
 * one place this map departs from the interface's own recipe. Two reasons, and
 * the second is the real one:
 *
 *   * A 9 px label sitting on a 1 px road needs contrast on *all* sides, and an
 *     offset shadow gives it on two. Every printed map letters over a halo.
 *   * `shadowBlur` costs a separate blur pass per `fillText`: 52 labels is
 *     1.03 ms against 0.07 ms for stroking the same 52 and filling them. Fifteen
 *     times, for a softer result.
 *
 * `#060a0d` at .85 is the dark ring on the minimap's rim, so this is not a new
 * colour either.
 */
const HALO = 'rgba(6,9,13,0.85)';
const HALO_PX = 2.5;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SUBURB_PX = 11;
const STREET_PX = 9;
const LANDMARK_PX = 9;
const CHROME_PX = 10;

/**
 * The most street names the map will draw at once.
 *
 * Not a performance number -- fifty rotated `fillText` calls is well under a
 * millisecond. It is a legibility number: past about fifty labels a map of this
 * size stops being a map with names on it and becomes a page of names with a map
 * behind it. The collision cull usually bites first at the closest zoom; this is
 * what bites in the empty quarters, where fifty labels would be drawn simply
 * because there was room.
 */
const MAX_STREET_LABELS = 52;

/**
 * How much longer than the label a street's straight run has to be, before the
 * label is allowed on it.
 *
 * A name lettered along a segment shorter than itself overhangs both ends and
 * reads as belonging to whatever it overhangs into. 1.15 is deliberately barely
 * over one -- the alternative is losing the name of every short street in the
 * inner city, which is most of the interesting ones.
 */
const LABEL_FIT = 1.15;

/** Padding around a label's box when testing it against the ones already placed. */
const LABEL_PAD = 2;

/** Marker sizes, in pixels -- which is why they are outside every transform. */
const PLAYER_R = 5.5;
const CONE_PX = 34;
const DOT_R = 3;
/**
 * The bikes, per zoom, indexed by `ZOOMS`.
 *
 * The only marker whose size moves with the zoom, and it moves because it is
 * the only one there are a hundred of. At the neighbourhood zoom a couple of
 * dozen bikes over 1 km is a sparse scatter and they take the minimap's own
 * 2.6 px; at the city zoom all 115 are on screen across 9 km, and 2.6 px dots
 * at that density stop being a hundred places you could pick up a bike and
 * become one lime cloud over the inner suburbs. 1.7 px keeps the constellation
 * -- which is genuinely useful, it is a map of where the bikes are -- while
 * leaving the powerups and the combatants unambiguously the larger marks.
 */
const BIKE_DOT_R = [2.6, 2.2, 1.7];
/** How far a marker's heading tick reaches past its dot, in pixels. */
const HEADING_TICK = 4.5;

const TAU = Math.PI * 2;

// --- The pure geometry --------------------------------------------------------
//
// Everything a wrong sign would break silently, kept out of the class so
// `verifyBigMap` can assert it without a canvas.

/**
 * World x to canvas x. North-up, so this is a scale and an offset and nothing
 * else -- there is no rotation anywhere in this file, which is the whole
 * difference from `minimap.ts`'s transform.
 */
export function projectX(view: MapView, x: number): number {
  return view.size / 2 + (x - view.cx) * view.scale;
}

/**
 * World z to canvas y, **unnegated**, and it is worth stating why since world
 * north is -Z and canvas y runs down.
 *
 * Two negations that cancel: a point north of centre has a smaller z, so
 * `z - cz` is negative, so it lands above centre on a y axis that increases
 * downward. North is up, east is right, and the map is the right way round with
 * no minus sign in it. The same cancellation `minimap.ts` derives for its
 * rotation, one step simpler because there is no rotation.
 */
export function projectY(view: MapView, z: number): number {
  return view.size / 2 + (z - view.cz) * view.scale;
}

/**
 * Fold a bearing into the half-turn text can be read in: `[-pi/2, pi/2)`.
 *
 * A label lettered along a street's own bearing is upside down for half of them,
 * because a street running west-to-east and one running east-to-west are the
 * same street and only one of the two directions reads. Adding pi flips the text
 * without moving the line it sits on, since the anchor is the segment's midpoint.
 *
 * The interval is closed at the bottom rather than the top so a *north-south*
 * street comes out at `-pi/2` and not `+pi/2`: the first letters text running
 * upward, which is how every map letters a vertical street, and the second
 * letters it running downward, which reads as mirrored to anyone who has ever
 * seen a map.
 */
export function readableAngle(angle: number): number {
  let a = angle;
  while (a >= Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

/** A placed label's screen footprint, axis-aligned. */
export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The axis-aligned box a rotated label covers.
 *
 * Deliberately the *bounding* box of the rotated rectangle rather than the
 * rectangle itself, which over-reserves space for a diagonal label by up to 40%.
 * That is the right way to be wrong here: the failure the cull exists to prevent
 * is two names crossing each other, which is unreadable, and the cost of being
 * conservative is a name dropped that would just have fitted. An exact
 * separating-axis test between rotated rectangles is four times the code to
 * recover a label the map has fifty of.
 */
export function labelBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angle: number,
): LabelBox {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const halfW = (width * c + height * s) / 2;
  const halfH = (width * s + height * c) / 2;
  return { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH };
}

/** Do two boxes touch, with `pad` pixels of clearance demanded around each? */
export function boxesOverlap(a: LabelBox, b: LabelBox, pad = 0): boolean {
  return !(
    a.x1 + pad < b.x0 ||
    a.x0 - pad > b.x1 ||
    a.y1 + pad < b.y0 ||
    a.y0 - pad > b.y1
  );
}

/**
 * Claim a box if it is free. Greedy, first-come -- so the *order* labels are
 * offered in is the whole of the priority scheme, and that order is sorted
 * rather than incidental. See `drawStreetLabels`.
 */
export function claimLabel(placed: LabelBox[], box: LabelBox, pad = LABEL_PAD): boolean {
  for (let i = 0; i < placed.length; i++) {
    if (boxesOverlap(placed[i], box, pad)) return false;
  }
  placed.push(box);
  return true;
}

/**
 * The scale bar's length in metres: 1, 2 or 5 times a power of ten, whichever
 * lands nearest a quarter of the panel without going over.
 *
 * A bar of "1,127 m" is a bar nobody can use. The 1-2-5 ladder is what every map
 * has used for a century, for the reason that those are the numbers a person can
 * multiply by eye.
 */
export function scaleBarMetres(maxMetres: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(maxMetres, 1))));
  for (const step of [5, 2, 1]) {
    if (pow * step <= maxMetres) return pow * step;
  }
  return pow;
}

/** One marker on the map, in world metres. Pooled; see `mark`. */
interface Dot {
  x: number;
  z: number;
  kind: MarkerKind;
  yaw: number | undefined;
}

export class BigMap implements MarkerSink {
  private readonly panel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The city, rendered once per view. See the header. */
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: CanvasRenderingContext2D;

  private readonly atlas: MapAtlas;
  private readonly collision: CollisionWorld;
  private readonly markers: MarkerCollector | null;

  private open = false;
  private zoomIndex = DEFAULT_ZOOM;
  /** CSS pixels across the square drawing surface, measured not assumed. */
  private size = 0;
  private dpr = 1;

  /** Where the last rebuild was centred. Not the player: see the header. */
  private centreX = 0;
  private centreZ = 0;
  /** Set by `toggle`, cleared by the first `update` that has a player position. */
  private needsAnchor = true;
  private layerDirty = true;
  /** The atlas revision the current layer was built from. */
  private drawnRevision = -1;

  private clock = 0;

  /** Reused across rebuilds; all of these grow to a high-water mark and stay. */
  private readonly prisms: Prism[] = [];
  private readonly roads: RoadRun[] = [];
  private readonly lines: LabelLine[] = [];
  private readonly pool: Dot[] = [];
  private dotCount = 0;
  /** The cull's live state during a marker pass, and the box it culls against. */
  private cullMinX = 0;
  private cullMinZ = 0;
  private cullMaxX = 0;
  private cullMaxZ = 0;

  private rebuilds = 0;
  private lastRebuildMs = 0;
  private lastRoads = 0;
  private lastRoadPoints = 0;
  private lastLabels = 0;
  private lastSuburbLabels = 0;
  private lastPrisms = 0;
  private lastFrameMs = 0;

  constructor(
    panel: HTMLElement,
    canvas: HTMLCanvasElement,
    atlas: MapAtlas,
    collision: CollisionWorld,
    markers: MarkerCollector | null = null,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('The map canvas would not give a 2D context.');
    this.panel = panel;
    this.canvas = canvas;
    this.ctx = ctx;
    this.atlas = atlas;
    this.collision = collision;
    this.markers = markers;

    const layer = document.createElement('canvas');
    const layerCtx = layer.getContext('2d', { alpha: true });
    if (!layerCtx) throw new Error('The map layer canvas would not give a 2D context.');
    this.layer = layer;
    this.layerCtx = layerCtx;

    // The same cap `main.ts` puts on the renderer's pixel ratio, for the same
    // reason `minimap.ts` states: a 3x display would otherwise triple the fill
    // cost of the one thing here rasterised on the CPU -- and this one is
    // fifteen times the area of that one.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // The panel is `display: none` until it is opened, so it has no layout and
    // `clientWidth` is 0 at construction. A `ResizeObserver` fires when it gains
    // a size, which is the frame it is shown -- and again on every window
    // resize, which is the other case that has to work. Measuring in `toggle`
    // instead would be one frame earlier and would still be 0: the style change
    // has not been laid out by the time the handler returns.
    new ResizeObserver(() => this.measure()).observe(canvas);

    // The wheel, bound on the window rather than the panel, because the panel is
    // `pointer-events: none` -- every overlay in this interface is, so that none
    // of them can swallow the click that recaptures the pointer lock. The
    // listener is not passive because it has to `preventDefault`: a wheel over a
    // page that has scroll anywhere would otherwise zoom the map *and* scroll.
    window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /** Is the panel up? Read by `main.ts` to decide what a key press meant. */
  get visible(): boolean {
    return this.open;
  }

  /** The rung the map is on, for the dev handle and the chrome. */
  get zoom(): string {
    return ZOOMS[this.zoomIndex].name;
  }

  /**
   * `M`. Opening starts the atlas load if it has not been started, which is the
   * only place in the client that ever does -- a player who never opens the map
   * never fetches a byte of it. See `MapAtlas.start` for why calling it every
   * time is correct rather than sloppy.
   */
  toggle(): void {
    this.setOpen(!this.open);
  }

  /**
   * Close, from anywhere and for any reason -- `Escape`, or another panel
   * wanting the screen. A no-op when it is already closed, so a caller never has
   * to check.
   */
  close(): void {
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.panel.classList.toggle('shown', open);
    if (!open) return;
    this.atlas.start();
    // Re-anchor on the player wherever they have got to since it was last
    // closed, and redraw on the next frame rather than a thirtieth of a second
    // later -- an empty panel for one frame is a flash.
    this.needsAnchor = true;
    this.layerDirty = true;
    this.clock = REDRAW_DT;
    this.measure();
  }

  /**
   * The wheel. One click, one rung -- and the clamp at both ends is deliberate
   * rather than a wrap: a map that jumped from the whole city to one block
   * because the wheel had one more click in it is a map you have lost your place
   * on.
   */
  private onWheel(e: WheelEvent): void {
    if (!this.open) return;
    e.preventDefault();
    if (e.deltaY === 0) return;
    const next = Math.min(
      ZOOMS.length - 1,
      Math.max(0, this.zoomIndex + (e.deltaY > 0 ? 1 : -1)),
    );
    if (next === this.zoomIndex) return;
    this.zoomIndex = next;
    // A zoom re-centres on the player. The alternative -- keeping the anchor and
    // zooming about it -- puts the player off centre at the new scale for no
    // reason, since there is no pan in this map for them to have chosen it with.
    this.needsAnchor = true;
    this.layerDirty = true;
    this.clock = REDRAW_DT;
  }

  /**
   * Measure the drawing surface and size both bitmaps to it.
   *
   * The *content* box, on `minimap.ts`'s own argument: the panel is border-box
   * with a rim, and a bitmap sized to the border-box figure is a map that is
   * permanently soft. A zero measurement is ignored rather than applied -- the
   * observer fires once with the element still hidden, and a 0x0 canvas cannot
   * be drawn into and does not recover on its own.
   */
  private measure(): void {
    const size = Math.floor(this.canvas.clientWidth);
    if (size <= 0 || size === this.size) return;
    this.size = size;
    const px = Math.round(size * this.dpr);
    this.canvas.width = px;
    this.canvas.height = px;
    this.layer.width = px;
    this.layer.height = px;
    this.layerDirty = true;
  }

  /** `MarkerSink`. Culls to the view box, so no provider has to know the zoom. */
  mark(x: number, z: number, kind: MarkerKind, yaw?: number): void {
    if (x < this.cullMinX || x > this.cullMaxX || z < this.cullMinZ || z > this.cullMaxZ) return;
    let d = this.pool[this.dotCount];
    if (d === undefined) {
      d = { x: 0, z: 0, kind: 'combatant', yaw: undefined };
      this.pool.push(d);
    }
    d.x = x;
    d.z = z;
    d.kind = kind;
    d.yaw = yaw;
    this.dotCount++;
  }

  /**
   * Called every frame; costs one comparison while the map is closed.
   *
   * That first line is the whole performance argument for this feature. A panel
   * that covers the game is a panel that is shut for 99% of a session, and
   * everything expensive in this file is behind it.
   */
  update(dt: number, x: number, z: number, yaw: number): void {
    if (!this.open) return;
    if (this.size <= 0) {
      // Still waiting on the first layout. Nothing to draw into yet.
      this.measure();
      return;
    }
    if (this.needsAnchor) {
      this.centreX = x;
      this.centreZ = z;
      this.needsAnchor = false;
      this.layerDirty = true;
    } else {
      // The re-anchor test, in world metres against the current half-extent.
      const half = ZOOMS[this.zoomIndex].halfM;
      const slack = half * RECENTRE_FRACTION;
      if (Math.abs(x - this.centreX) > slack || Math.abs(z - this.centreZ) > slack) {
        this.centreX = x;
        this.centreZ = z;
        this.layerDirty = true;
      }
    }
    // More of the city arrived. Rebuilding on the revision rather than on a
    // timer collapses a burst of tiles landing together into one rebuild.
    if (this.atlas.revision !== this.drawnRevision) this.layerDirty = true;

    this.clock += dt;
    if (this.clock < REDRAW_DT) return;
    this.clock = 0;
    this.draw(x, z, yaw);
  }

  /**
   * One line of text with a dark ring round it. See `HALO`.
   *
   * The stroke goes first and the fill over it, so the ring is behind the letter
   * rather than eating half its weight -- a 2.5 px pen centred on the glyph
   * outline puts 1.25 px inside it, and at 9 px that is most of a stem.
   */
  private static halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  private view(): MapView {
    const half = ZOOMS[this.zoomIndex].halfM;
    return {
      cx: this.centreX,
      cz: this.centreZ,
      scale: this.size / 2 / half,
      size: this.size,
    };
  }

  private draw(px: number, pz: number, yaw: number): void {
    const t0 = performance.now();
    const view = this.view();
    if (this.layerDirty) this.renderCity(view);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    // The city, as one blit. Drawn in CSS pixels against a bitmap that is
    // `dpr` times that, which is what the transform above is for.
    ctx.drawImage(this.layer, 0, 0, this.size, this.size);

    this.drawMarkers(ctx, view);
    this.drawPlayer(ctx, view, px, pz, yaw);
    if (!this.atlas.complete) this.drawLoading(ctx);

    this.lastFrameMs = performance.now() - t0;
  }

  // --- The city layer -----------------------------------------------------------

  private renderCity(view: MapView): void {
    const t0 = performance.now();
    const ctx = this.layerCtx;
    const zoom = ZOOMS[this.zoomIndex];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);

    this.drawWater(ctx, view);
    if (zoom.buildings) this.drawBuildings(ctx, view);
    else this.lastPrisms = 0;
    this.drawRoads(ctx, view, zoom);

    // Labels last and in priority order, because placement is greedy and the
    // order is the priority: the suburbs are what the map is *for* at every
    // zoom, the landmarks are the three things everybody navigates by, and the
    // street names fill what is left. See `claimLabel`.
    const placed: LabelBox[] = [];
    this.drawSuburbLabels(ctx, view, placed);
    this.drawLandmarks(ctx, view, placed);
    if (zoom.labelFloor !== Infinity) this.drawStreetLabels(ctx, view, zoom, placed);
    else this.lastLabels = 0;

    this.drawChrome(ctx, view, zoom);

    this.layerDirty = false;
    this.drawnRevision = this.atlas.revision;
    this.rebuilds++;
    this.lastRebuildMs = performance.now() - t0;
  }

  /**
   * The harbour: one path built once in world metres, filled through the canvas
   * transform. No loop, no per-redraw geometry, and no cull.
   *
   * This is the same projection every other layer here does in JavaScript, done
   * by the rasteriser instead -- and the reason it is worth the inconsistency is
   * measured: walking the 3,564 triangles into the context costs 25 ms, of which
   * essentially none is the rasterising (the figure is unchanged with the fill
   * removed, and unchanged again with the whole harbour off screen). It is the
   * ten thousand `moveTo`/`lineTo` calls. Filling the prebuilt path is 0.04 ms.
   *
   * The cull that would otherwise be needed disappears with it: there is nothing
   * to reject when the geometry is never touched. See `MapAtlas.waterShape`.
   */
  private drawWater(ctx: CanvasRenderingContext2D, view: MapView): void {
    const shape = this.atlas.waterPlan;
    if (shape === null) return;
    ctx.save();
    // Composed onto the device-ratio base the caller set, so this is the same
    // world-to-canvas map `projectX`/`projectY` compute, written as a matrix.
    ctx.translate(view.size / 2, view.size / 2);
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.cx, -view.cz);
    ctx.fillStyle = WATER_FILL;
    ctx.fill(shape);
    ctx.restore();
  }

  /**
   * Footprints, at the closest zoom only, from the collision prisms `main.ts`
   * keeps for 420 m around the player.
   *
   * One path filled once, on `minimap.ts`'s correctness argument rather than its
   * speed one: a fill per building double-darkens every party wall, so a terrace
   * row drawn the naive way is a row of bright seams instead of the single mass
   * it is.
   *
   * The query radius is the half-extent's diagonal, so the corners of a square
   * view are not empty -- and it is capped at the ring the prisms actually cover,
   * because asking for more does not produce more.
   */
  private drawBuildings(ctx: CanvasRenderingContext2D, view: MapView): void {
    const half = ZOOMS[this.zoomIndex].halfM;
    const prisms = this.collision.prismsWithin(
      this.centreX,
      this.centreZ,
      half * Math.SQRT2,
      this.prisms,
    );
    ctx.beginPath();
    for (let i = 0; i < prisms.length; i++) {
      const pts = prisms[i].points;
      if (pts.length < 6) continue;
      ctx.moveTo(projectX(view, pts[0]), projectY(view, pts[1]));
      for (let v = 2; v < pts.length; v += 2) {
        ctx.lineTo(projectX(view, pts[v]), projectY(view, pts[v + 1]));
      }
      ctx.closePath();
    }
    ctx.fillStyle = BUILDING_FILL;
    ctx.fill();
    this.lastPrisms = prisms.length;
  }

  /**
   * The street network, in two weights and two passes.
   *
   * Two passes rather than one stroke per run, and it is the same argument the
   * fills make: a `stroke` is a rasteriser setup, and 11,893 of them is 11,893
   * setups where two paths with 30,000 points between them is two. It also fixes
   * the drawing order for free -- every minor street is under every major one,
   * so an arterial is continuous where a lane meets it instead of being nibbled
   * by whichever happened to be drawn later.
   *
   * `round` joins and caps because at this scale a street is a 1 px line and a
   * mitred junction of three of them is a spike.
   */
  private drawRoads(ctx: CanvasRenderingContext2D, view: MapView, zoom: Zoom): void {
    const half = zoom.halfM;
    // A margin, so a run whose endpoints are both outside the view but which
    // crosses it is still drawn. Half the extent again is more than any single
    // decimated run spans.
    const pad = half * 0.5;
    const runs = this.atlas.roadsWithin(
      this.centreX - half - pad,
      this.centreZ - half - pad,
      this.centreX + half + pad,
      this.centreZ + half + pad,
      zoom.roadFloor,
      this.roads,
    );

    let points = 0;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      const major = pass === 1;
      ctx.beginPath();
      let drew = false;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (this.atlas.importanceOf(run.nameId) >= MAJOR_M !== major) continue;
        const pts = run.points;
        ctx.moveTo(projectX(view, pts[0]), projectY(view, pts[1]));
        for (let v = 2; v < pts.length; v += 2) {
          ctx.lineTo(projectX(view, pts[v]), projectY(view, pts[v + 1]));
        }
        points += pts.length >> 1;
        drew = true;
      }
      if (!drew) continue;
      ctx.strokeStyle = major ? ROAD_MAJOR : ROAD_MINOR;
      ctx.lineWidth = major ? ROAD_MAJOR_PX : ROAD_MINOR_PX;
      ctx.stroke();
    }
    this.lastRoads = runs.length;
    this.lastRoadPoints = points;
  }

  /**
   * Suburb names, at every zoom, in the letterspaced upper case that says
   * "district" rather than "street" without a legend having to.
   *
   * Placed first and therefore never dropped for a street name, which is the
   * priority the whole map is built around: at nine kilometres the suburbs *are*
   * the map, and at one kilometre they are still what tells you which of the
   * forty streets on screen you should be reading.
   */
  private drawSuburbLabels(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    placed: LabelBox[],
  ): void {
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    ctx.font = `${SUBURB_PX}px ${MONO}`;
    spaced.letterSpacing = '0.22em';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = SUBURB_INK;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.lineJoin = 'round';
    let drawn = 0;
    for (const s of this.atlas.suburbs) {
      const sx = projectX(view, s.x);
      const sy = projectY(view, s.z);
      if (sx < 0 || sx > this.size || sy < 0 || sy > this.size) continue;
      const text = s.name.toUpperCase();
      const box = labelBox(sx, sy, ctx.measureText(text).width, SUBURB_PX, 0);
      if (!claimLabel(placed, box)) continue;
      BigMap.halo(ctx, text, sx, sy);
      drawn++;
    }
    spaced.letterSpacing = '0px';
    this.lastSuburbLabels = drawn;
  }

  /**
   * The three hero landmarks, as a diamond and a name.
   *
   * A diamond rather than a dot because everything else on this map that is a
   * dot is a *person*, and the one thing a marker must never do is make a
   * building look like somebody standing in it. Their anchors are in
   * `index.json` and cost nothing to read -- see `MapAtlas.readLandmarks`.
   */
  private drawLandmarks(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    placed: LabelBox[],
  ): void {
    const marks: readonly MapLandmark[] = this.atlas.landmarks;
    if (marks.length === 0) return;
    ctx.font = `${LANDMARK_PX}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.lineJoin = 'round';
    for (const m of marks) {
      const sx = projectX(view, m.x);
      const sy = projectY(view, m.z);
      if (sx < -20 || sx > this.size + 20 || sy < -20 || sy > this.size + 20) continue;
      ctx.fillStyle = LANDMARK_INK;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 4);
      ctx.lineTo(sx + 4, sy);
      ctx.lineTo(sx, sy + 4);
      ctx.lineTo(sx - 4, sy);
      ctx.closePath();
      ctx.fill();
      const ty = sy + 12;
      const box = labelBox(sx, ty, ctx.measureText(m.name).width, LANDMARK_PX, 0);
      if (!claimLabel(placed, box)) continue;
      BigMap.halo(ctx, m.name, sx, ty);
    }
  }

  /**
   * Street names, lettered along the street.
   *
   * **One label per name, not per run.** OSM splits a street into a way per
   * block and the pipeline clips those to tiles, so Crown Street arrives as
   * eleven runs -- the same fact `game/locator.ts` has to reduce over to avoid
   * "cnr Crown St & Crown St", and here it would letter Crown Street eleven
   * times down one street. What is offered instead is one *chain* per continuous
   * length of the street (`MapAtlas.buildLabelLines`), and of the chains in view
   * the one with the longest straight stretch wins.
   *
   * **The order is the priority and the order is sorted**: by build-wide
   * importance, then by name, then by position, so the same view always produces
   * the same labels. Determinism matters more than it sounds -- the alternative
   * is a set that depends on tile arrival order, which means the map draws a
   * different fifty names the second time you open it in the same place.
   *
   * The abbreviated form is used -- 'King St' -- because a map is tight and
   * because the sidecar deliberately ships the full one so the client can
   * decide. `game/locator.ts` owns that table and does the same thing to fit two
   * names on one line.
   */
  private drawStreetLabels(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    zoom: Zoom,
    placed: LabelBox[],
  ): void {
    const half = zoom.halfM;
    const lines = this.atlas.labelLinesWithin(
      this.centreX - half,
      this.centreZ - half,
      this.centreX + half,
      this.centreZ + half,
      zoom.labelFloor,
      this.lines,
    );
    // The longest straight stretch per name that is in view. A street crosses
    // the panel as several chains -- either side of a park, or the two halves of
    // a fork -- and lettering each of them writes the same name down the map
    // three times.
    const best = new Map<number, LabelLine>();
    for (const line of lines) {
      const seen = best.get(line.nameId);
      if (seen === undefined || line.straight > seen.straight) best.set(line.nameId, line);
    }
    const candidates = Array.from(best.values());
    candidates.sort((a, b) => {
      const d = this.atlas.importanceOf(b.nameId) - this.atlas.importanceOf(a.nameId);
      if (d !== 0) return d;
      if (a.nameId !== b.nameId) return a.nameId - b.nameId;
      return a.x - b.x || a.z - b.z;
    });

    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    ctx.font = `${STREET_PX}px ${MONO}`;
    spaced.letterSpacing = '0.04em';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = STREET_INK;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.lineJoin = 'round';

    let drawn = 0;
    for (const line of candidates) {
      if (drawn >= MAX_STREET_LABELS) break;
      const sx = projectX(view, line.x);
      const sy = projectY(view, line.z);
      if (sx < 0 || sx > this.size || sy < 0 || sy > this.size) continue;
      const text = this.atlas.labelOf(line.nameId);
      const width = ctx.measureText(text).width;
      // The straight stretch has to be longer than the text that goes on it.
      if (line.straight * view.scale < width * LABEL_FIT) continue;
      const angle = readableAngle(line.angle);
      if (!claimLabel(placed, labelBox(sx, sy, width, STREET_PX, angle))) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      BigMap.halo(ctx, text, 0, 0);
      ctx.restore();
      drawn++;
    }
    spaced.letterSpacing = '0px';
    this.lastLabels = drawn;
  }

  /**
   * The frame around the picture: what this is, how far across it is, which way
   * is up, and how to get out.
   *
   * All four are on the canvas rather than in the DOM, which is a departure from
   * how every other panel in this interface is built and is worth one sentence:
   * the panel is a square whose size is `min(85vw, 85vh)`, and a DOM header
   * inside it would make the *canvas* non-square, which is the one thing a map
   * with a scale bar cannot be. Drawing it here keeps the drawing surface square
   * and the chrome in the same font and colours the rest of the HUD uses.
   */
  private drawChrome(ctx: CanvasRenderingContext2D, view: MapView, zoom: Zoom): void {
    const pad = 12;
    ctx.font = `${CHROME_PX}px ${MONO}`;
    ctx.fillStyle = CHROME_INK;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'top';

    ctx.textAlign = 'left';
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    spaced.letterSpacing = '0.38em';
    BigMap.halo(ctx, 'SYDNEY', pad, pad);
    spaced.letterSpacing = '0px';
    BigMap.halo(ctx, `${zoom.name} · ${zoom.span} across`, pad, pad + 16);

    // North, at the top right. A map that is north-up should say so once rather
    // than leave it to be inferred -- and the arrow is what makes the claim,
    // where the letter alone would read as a label for something.
    ctx.textAlign = 'center';
    const nx = this.size - pad - 6;
    ctx.beginPath();
    ctx.moveTo(nx, pad + 2);
    ctx.lineTo(nx + 4, pad + 11);
    ctx.lineTo(nx - 4, pad + 11);
    ctx.closePath();
    ctx.fillStyle = SCALE_INK;
    ctx.fill();
    ctx.fillStyle = CHROME_INK;
    BigMap.halo(ctx, 'N', nx, pad + 14);

    // The scale bar, bottom left. Its length is the honest one for the zoom --
    // see `scaleBarMetres` -- and the bar is drawn at exactly the pixels those
    // metres come to, so a player can lay it against the map and count.
    const metres = scaleBarMetres(view.size * 0.25 / view.scale);
    const barPx = metres * view.scale;
    const by = this.size - pad - 10;
    ctx.strokeStyle = SCALE_INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, by - 3);
    ctx.lineTo(pad, by + 3);
    ctx.moveTo(pad, by);
    ctx.lineTo(pad + barPx, by);
    ctx.moveTo(pad + barPx, by - 3);
    ctx.lineTo(pad + barPx, by + 3);
    ctx.stroke();
    ctx.fillStyle = SCALE_INK;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    BigMap.halo(ctx, metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, pad, by - 6);

    ctx.textAlign = 'right';
    ctx.fillStyle = CHROME_INK;
    BigMap.halo(ctx, 'wheel — zoom · m / esc — close', this.size - pad, this.size - pad);
  }

  // --- The live layer -----------------------------------------------------------

  private drawMarkers(ctx: CanvasRenderingContext2D, view: MapView): void {
    if (this.markers === null) return;
    const half = ZOOMS[this.zoomIndex].halfM;
    this.cullMinX = this.centreX - half;
    this.cullMaxX = this.centreX + half;
    this.cullMinZ = this.centreZ - half;
    this.cullMaxZ = this.centreZ + half;
    this.dotCount = 0;
    // The diagonal, so a source that culls on the radius it is handed does not
    // clip the corners of a square view. The box above is the real cull.
    this.markers.collect(this, this.centreX, this.centreZ, half * Math.SQRT2);

    let kind: MarkerKind | '' = '';
    ctx.lineWidth = 1.5;
    // Read once rather than per dot: at the city zoom this loop runs over 115
    // bikes and the radius is the same number for all of them.
    const bikeR = BIKE_DOT_R[this.zoomIndex] ?? BIKE_DOT_R[BIKE_DOT_R.length - 1];
    for (let i = 0; i < this.dotCount; i++) {
      const d = this.pool[i];
      const sx = projectX(view, d.x);
      const sy = projectY(view, d.z);
      // One style write per run of like markers, as `minimap.ts` does it, and
      // through the same shared switch so the two maps cannot drift apart.
      if (d.kind !== kind) {
        kind = d.kind;
        const ink = markerInk(d.kind);
        ctx.fillStyle = ink;
        ctx.strokeStyle = ink;
      }
      const r = d.kind === 'bike' ? bikeR : DOT_R;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fill();

      // Which way they are facing, where that is known -- the same tick the
      // minimap draws and for the same reason: on a map of a melee game, the
      // most useful thing about somebody else is which way they are looking.
      // Drawn in the marker's own colour rather than the combatant red, so a
      // future kind with a heading is not a red tick on a gold dot.
      if (d.yaw !== undefined) {
        const fx = -Math.sin(d.yaw);
        const fy = -Math.cos(d.yaw);
        ctx.beginPath();
        ctx.moveTo(sx + fx * r, sy + fy * r);
        ctx.lineTo(sx + fx * (r + HEADING_TICK), sy + fy * (r + HEADING_TICK));
        ctx.stroke();
      }
    }
  }

  /**
   * The player: a wedge pointing where they are looking, with a cone in front.
   *
   * Unlike the minimap's, this one is neither at the centre nor pointing up --
   * the map is north-up and anchored, so both the position and the heading carry
   * information. Forward is `(-sin yaw, -cos yaw)` in world (x, z), the
   * controller's own convention, and it goes straight onto the canvas because
   * the projection has no rotation in it: yaw 0 faces -Z, which is north, which
   * is up.
   */
  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    px: number,
    pz: number,
    yaw: number,
  ): void {
    const sx = projectX(view, px);
    const sy = projectY(view, pz);
    const fx = -Math.sin(yaw);
    const fy = -Math.cos(yaw);
    // The perpendicular, for the cone's two edges and the wedge's shoulders.
    const rx = -fy;
    const ry = fx;

    // A 60-degree cone: tan(30 deg) = 0.577 of the length, either side.
    const spread = CONE_PX * 0.577;
    ctx.fillStyle = CONE_FILL;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + fx * CONE_PX + rx * spread, sy + fy * CONE_PX + ry * spread);
    ctx.lineTo(sx + fx * CONE_PX - rx * spread, sy + fy * CONE_PX - ry * spread);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = PLAYER_FILL;
    ctx.beginPath();
    ctx.moveTo(sx + fx * PLAYER_R * 1.5, sy + fy * PLAYER_R * 1.5);
    ctx.lineTo(sx - fx * PLAYER_R + rx * PLAYER_R, sy - fy * PLAYER_R + ry * PLAYER_R);
    ctx.lineTo(sx - fx * PLAYER_R * 0.4, sy - fy * PLAYER_R * 0.4);
    ctx.lineTo(sx - fx * PLAYER_R - rx * PLAYER_R, sy - fy * PLAYER_R - ry * PLAYER_R);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * "loading street names", while the 213 sidecars come in.
   *
   * On the live layer rather than the city one so it can pulse without a
   * rebuild, and worded as a fact rather than a spinner: the map is *usable*
   * from the first frame -- the suburbs, the harbour and the landmarks are all
   * there in the first round trip -- and this says only that more names are
   * still arriving. A modal spinner over a working map would be a lie about
   * which of those two things is true.
   */
  private drawLoading(ctx: CanvasRenderingContext2D): void {
    const pct = Math.round(this.atlas.progress * 100);
    // A slow breath, not a blink: 0.55 to 0.95 over 1.6 s.
    const pulse = 0.75 + 0.2 * Math.sin(performance.now() / 255);
    ctx.font = `${CHROME_PX}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = `rgba(147,168,188,${pulse.toFixed(3)})`;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = HALO_PX;
    ctx.lineJoin = 'round';
    BigMap.halo(ctx, `loading street names… ${pct}%`, 12, this.size - 34);
  }

  /**
   * What the map is doing and what it cost, for `window.sydney.bigmap`.
   *
   * `rebuilds` is the number to watch: it should be one per open, one per wheel
   * click, and one per 175 m of running at the closest zoom. A rebuild count
   * climbing with the frame count means the re-anchor test or the revision
   * compare has come undone, and the symptom -- a map that is merely slow --
   * would otherwise be invisible.
   */
  stats(): {
    visible: boolean;
    zoom: string;
    spanM: number;
    centre: [number, number];
    sizePx: number;
    dpr: number;
    rebuilds: number;
    lastRebuildMs: number;
    lastFrameMs: number;
    hz: number;
    roads: number;
    roadPoints: number;
    prisms: number;
    streetLabels: number;
    suburbLabels: number;
    markers: number;
    atlas: ReturnType<MapAtlas['stats']>;
  } {
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      visible: this.open,
      zoom: ZOOMS[this.zoomIndex].name,
      spanM: ZOOMS[this.zoomIndex].halfM * 2,
      centre: [Math.round(this.centreX), Math.round(this.centreZ)],
      sizePx: this.size,
      dpr: this.dpr,
      rebuilds: this.rebuilds,
      lastRebuildMs: round(this.lastRebuildMs),
      lastFrameMs: round(this.lastFrameMs),
      hz: REDRAW_HZ,
      roads: this.lastRoads,
      roadPoints: this.lastRoadPoints,
      prisms: this.lastPrisms,
      streetLabels: this.lastLabels,
      suburbLabels: this.lastSuburbLabels,
      markers: this.dotCount,
      atlas: this.atlas.stats(),
    };
  }
}

// --- Self-check ---------------------------------------------------------------

/**
 * The map's arithmetic, against cases whose answers are known.
 *
 * On this project's criterion for what earns a self-check: every failure here is
 * silent. The map renders, nothing throws, and what comes out is a plausible
 * picture of a city -- it is simply mirrored, or upside down, or has forty names
 * stacked on one corner, and there is no frame that says so. Four specifically:
 *
 *   * **The projection's sign.** North is -Z and canvas y runs down, so the two
 *     negations cancel and the *correct* code has no minus sign in it -- which
 *     means the incorrect code looks equally reasonable and produces a map of
 *     Sydney reflected about the Parramatta River. A player would read it as
 *     "the map is wrong" and never as "the map is mirrored".
 *   * **The label flip.** Half of any city's streets run in the direction that
 *     letters text upside down. The fix is a half-turn and its interval is the
 *     part that is easy to get wrong: closed at the wrong end and every
 *     north-south street reads downward, which is mirrored rather than merely
 *     rotated.
 *   * **The collision cull's determinism.** Placement is greedy over a sorted
 *     list, and if the sort is not total -- two streets of identical length, say
 *     -- the same view produces a different set of names each time it is opened.
 *     That is invisible in any single screenshot and maddening in use.
 *   * **The importance measure.** It is the only thing standing in for a road
 *     class the sidecar does not carry, and if the totals do not accumulate
 *     across a name's runs then every street in the city ranks by whichever
 *     block happened to be longest, and the city zoom draws a random 200 streets.
 */
export function verifyBigMap(): string[] {
  const failures: string[] = [];
  const view: MapView = { cx: 0, cz: 0, scale: 0.1, size: 800 };

  // --- The shared palette. Both maps draw one marker list through `markerInk`,
  // so a kind with no branch of its own does not fail to draw -- it draws in
  // whatever the fallthrough is, which is the combatant red. A lime e-bike
  // rendered as "somebody who can hit you" is the exact failure that is
  // invisible in a screenshot and wrong in a fight.
  {
    const kinds: MarkerKind[] = ['training', 'flat-white', 'combatant', 'bike'];
    const seen = new Map<string, MarkerKind>();
    for (const kind of kinds) {
      const ink = markerInk(kind);
      const clash = seen.get(ink);
      if (clash !== undefined) {
        failures.push(`Markers '${kind}' and '${clash}' are both drawn in ${ink}; one of them has no branch of its own.`);
      }
      seen.set(ink, kind);
    }
    // And the bike's is a green, which is what ties the dot to the lime frame
    // and the lime beam it stands for. Parsed rather than string-compared, so
    // the check survives the colour being retuned and catches it being retuned
    // to something that is not a lime.
    const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(markerInk('bike'));
    if (rgb === null) {
      failures.push(`The bike marker is '${markerInk('bike')}', which this check cannot read as an rgb triple.`);
    } else {
      const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
      if (!(g > r && g > b * 1.4)) {
        failures.push(
          `The bike marker is rgb(${r}, ${g}, ${b}), which is not a lime. The dot's whole legibility is ` +
            `that it is the colour of the object it points at.`,
        );
      }
    }
    // The bikes shrink as the map widens, and there is a size for every zoom.
    if (BIKE_DOT_R.length !== ZOOMS.length) {
      failures.push(`${BIKE_DOT_R.length} bike dot sizes against ${ZOOMS.length} zooms; the widest would fall back.`);
    }
    for (let i = 1; i < BIKE_DOT_R.length; i++) {
      if (!(BIKE_DOT_R[i] < BIKE_DOT_R[i - 1])) {
        failures.push(
          `The bike dot is ${BIKE_DOT_R[i]} px at the ${ZOOMS[i].name} zoom against ${BIKE_DOT_R[i - 1]} at ` +
            `the one below. All 115 of them at full size across 9 km is one lime cloud, not a map.`,
        );
      }
    }
  }

  // --- North is up, east is right.
  {
    const north = projectY(view, -1000);
    const south = projectY(view, 1000);
    if (!(north < view.size / 2)) {
      failures.push(
        `A point 1 km north of centre (z = -1000) projected to y = ${north}, which is not above` +
          ` the centre line at ${view.size / 2}. World north is -Z and canvas y runs down; the` +
          ' two cancel and the projection must have no minus sign in it.',
      );
    }
    if (!(south > view.size / 2)) {
      failures.push(`A point 1 km south projected to y = ${south}, which is not below centre.`);
    }
    const east = projectX(view, 1000);
    if (!(east > view.size / 2)) {
      failures.push(`A point 1 km east projected to x = ${east}, which is not right of centre.`);
    }
    // And the scale is the scale: 1 km at 0.1 px/m is 100 px.
    if (Math.abs(east - view.size / 2 - 100) > 1e-6) {
      failures.push(`1 km at 0.1 px/m came out ${east - view.size / 2} px from centre, not 100.`);
    }
  }

  // --- No label is ever upside down, and a vertical one reads upward.
  {
    for (let deg = -350; deg <= 350; deg += 7) {
      const a = readableAngle((deg * Math.PI) / 180);
      if (!(a >= -Math.PI / 2 && a < Math.PI / 2)) {
        failures.push(
          `A street bearing ${deg} degrees produced a label angle of ${((a * 180) / Math.PI).toFixed(1)}` +
            ' degrees, outside the half-turn text can be read in.',
        );
        break;
      }
    }
    // A street running due south (bearing +90 degrees in (x, z)) must letter
    // upward, not downward -- which is the interval being half-open at the top.
    const southbound = readableAngle(Math.PI / 2);
    if (Math.abs(southbound + Math.PI / 2) > 1e-9) {
      failures.push(
        `A north-south street produced ${((southbound * 180) / Math.PI).toFixed(1)} degrees rather` +
          ' than -90. Lettered at +90 the text reads top to bottom, which is mirrored on every' +
          ' map anybody has seen.',
      );
    }
  }

  // --- The straight stretch: the piece of a street a name can lie along.
  {
    // A street that runs 200 m east, turns hard south for 60, then east again.
    // The stretch to letter is the first 200 m, and the *walked* length of the
    // whole thing (320 m) is emphatically not it.
    const bent = longestStraight(new Float32Array([0, 0, 200, 0, 200, 60, 260, 60]), 7);
    if (bent === null) {
      failures.push('A three-segment street produced no straight stretch at all.');
    } else {
      if (Math.abs(bent.straight - 200) > 1e-3) {
        failures.push(
          'The straight stretch of a street with a right-angle bend in it came out' +
            ` ${bent.straight.toFixed(1)} m rather than 200. A label longer than the straight part` +
            ' of a road is a label lettered around a corner.',
        );
      }
      if (Math.abs(bent.x - 100) > 1e-3 || Math.abs(bent.z) > 1e-3) {
        failures.push(
          `The label anchored at (${bent.x}, ${bent.z}) rather than the stretch's midpoint (100, 0).`,
        );
      }
      if (bent.nameId !== 7) failures.push('The straight stretch lost the name it belongs to.');
    }

    // A gentle curve: eight 100 m segments turning 5 degrees each. Every step is
    // inside the tolerance, and the whole is a bend through 40 degrees. This is
    // the case that fails if the tolerance is compared against the *previous*
    // segment rather than against the bearing the stretch opened with -- that
    // test passes forever and letters a name right round the bend.
    {
      const pts: number[] = [0, 0];
      let x = 0;
      let z = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i * 5 * Math.PI) / 180;
        x += Math.cos(a) * 100;
        z += Math.sin(a) * 100;
        pts.push(x, z);
      }
      const curve = longestStraight(Float32Array.from(pts), 0);
      if (curve === null) {
        failures.push('A gently curving street produced no straight stretch.');
      } else if (curve.straight > 320) {
        failures.push(
          `A street curving 5 degrees per 100 m yielded a ${curve.straight.toFixed(0)} m straight` +
            ' stretch. The tolerance is being measured against the previous segment rather than' +
            ' against the one the stretch started with.',
        );
      }
    }

    // Due west, which is where an unwrapped angle difference compares 179
    // degrees against -179 and breaks a straight street into two.
    {
      const west = longestStraight(new Float32Array([0, 0, -100, 0.4, -200, -0.4, -300, 0]), 0);
      if (west === null || west.straight < 290) {
        failures.push(
          'A straight westbound street came out as ' +
            (west === null ? 'nothing' : `${west.straight.toFixed(0)} m`) +
            ' rather than ~300 m. The bearing difference is not wrapped into [-pi, pi).',
        );
      }
    }

    if (longestStraight(new Float32Array([5, 5]), 0) !== null) {
      failures.push('A single point produced a straight stretch; it has no direction.');
    }
  }

  // --- Chaining: the runs OSM split a street into are lettered as one street.
  {
    const seg = (
      name: string,
      x0: number,
      z0: number,
      x1: number,
      z1: number,
    ): {
      name: string;
      points: Float32Array;
      minX: number;
      minZ: number;
      maxX: number;
      maxZ: number;
    } => ({
      name,
      points: new Float32Array([x0, z0, x1, z1]),
      minX: Math.min(x0, x1),
      minZ: Math.min(z0, z1),
      maxX: Math.max(x0, x1),
      maxZ: Math.max(z0, z1),
    });

    const atlas = new MapAtlas({ tile_size: 500, tiles: [] });
    atlas.addSegmentsForTest([
      // Four blocks of one street, delivered out of order and with two of them
      // written backwards -- which is what a way split plus a tile clip actually
      // produces, and what a chaining pass that assumed head-to-tail order would
      // silently drop half of.
      seg('Botany Road', 100, 0, 200, 0),
      seg('Botany Road', 400, 0, 300, 0),
      seg('Botany Road', 0, 0, 100, 0),
      seg('Botany Road', 300, 0, 200, 0),
    ]);
    const lines: LabelLine[] = [];
    atlas.labelLinesWithin(-1000, -1000, 1000, 1000, 0, lines);
    if (lines.length !== 1) {
      failures.push(
        `Four end-to-end blocks of one street produced ${lines.length} label lines rather than 1.` +
          ' Unchained, the map letters the same name once per block; chained wrongly, it letters' +
          ' it on a 100 m stub no name fits on.',
      );
    } else if (Math.abs(lines[0].straight - 400) > 1e-3) {
      failures.push(
        `The chained street's straight stretch is ${lines[0].straight.toFixed(1)} m rather than 400.` +
          ' This is the whole reason chaining exists: 11% of eligible names had a single run long' +
          ' enough to letter at the district zoom, and in a suburb of short blocks, none did.',
      );
    }

    // And two streets of the same name that do not touch stay two chains.
    const apart = new MapAtlas({ tile_size: 500, tiles: [] });
    apart.addSegmentsForTest([
      seg('Church Street', 0, 0, 100, 0),
      seg('Church Street', 3000, 0, 3100, 0),
    ]);
    const two: LabelLine[] = [];
    apart.labelLinesWithin(-10000, -10000, 10000, 10000, 0, two);
    if (two.length !== 2) {
      failures.push(
        `Two Church Streets 3 km apart came out as ${two.length} chains rather than 2. Joining` +
          ' them would letter the name in the empty ground between them.',
      );
    }
  }

  // --- The collision cull: overlapping labels are dropped, and it is stable.
  {
    const placed: LabelBox[] = [];
    const first = claimLabel(placed, labelBox(100, 100, 60, 10, 0));
    const overlapping = claimLabel(placed, labelBox(110, 102, 60, 10, 0));
    const clear = claimLabel(placed, labelBox(400, 400, 60, 10, 0));
    if (!first) failures.push('The first label was refused against an empty map.');
    if (overlapping) {
      failures.push(
        'A label overlapping one already placed was accepted. Two street names crossing each' +
          ' other is the one thing the cull exists to prevent.',
      );
    }
    if (!clear) failures.push('A label 300 px clear of everything was refused.');
    if (placed.length !== 2) {
      failures.push(`The cull kept ${placed.length} boxes where two were accepted.`);
    }
    // A rotated label reserves more than its own rectangle, and must still be
    // a box that contains its own text: 45 degrees on a 60x10 puts the corners
    // at (60+10)/2/sqrt(2) = 24.75 either way.
    const diagonal = labelBox(0, 0, 60, 10, Math.PI / 4);
    if (Math.abs(diagonal.x1 - 24.749) > 0.01 || Math.abs(diagonal.y1 - 24.749) > 0.01) {
      failures.push(
        `A 45-degree label's box came out ${diagonal.x1.toFixed(3)} x ${diagonal.y1.toFixed(3)}` +
          ' rather than 24.749 either way. The rotated bound is wrong, so diagonal names will' +
          ' either overlap or reserve the whole map.',
      );
    }
  }

  // --- Importance accumulates across a name's runs, which is the whole measure.
  {
    const atlas = new MapAtlas({ tile_size: 500, tiles: [] });
    const straight = (
      name: string,
      x0: number,
      z0: number,
      x1: number,
      z1: number,
    ): {
      name: string;
      points: Float32Array;
      minX: number;
      minZ: number;
      maxX: number;
      maxZ: number;
    } => ({
      name,
      points: new Float32Array([x0, z0, x1, z1]),
      minX: Math.min(x0, x1),
      minZ: Math.min(z0, z1),
      maxX: Math.max(x0, x1),
      maxZ: Math.max(z0, z1),
    });
    atlas.addSegmentsForTest([
      // One street delivered as three runs, the way OSM splits a street per
      // block and the pipeline clips it per tile: 300 m in total.
      straight('Crown Street', 0, 0, 0, 100),
      straight('Crown Street', 0, 100, 0, 200),
      straight('Crown Street', 0, 200, 0, 300),
      // And a laneway that is longer than any *one* of those runs.
      straight('Foley Lane', 50, 0, 50, 150),
    ]);
    const crown = atlas.importanceOf(0);
    const foley = atlas.importanceOf(1);
    if (Math.abs(crown - 300) > 1e-3) {
      failures.push(
        `Three 100 m runs of one street totalled ${crown} m rather than 300. Importance is the` +
          ' only stand-in for the road class the sidecar does not carry, and it only works if it' +
          ' accumulates across the runs OSM split the street into.',
      );
    }
    if (!(crown > foley)) {
      failures.push(
        `A 300 m street ranked below a ${foley} m laneway. The city zoom draws the top 200 names` +
          ' by this measure and would be drawing the wrong ones.',
      );
    }
    // And the box query rejects on bounds rather than on centres.
    const out: RoadRun[] = [];
    atlas.roadsWithin(-10, -10, 10, 10, 0, out);
    if (out.length !== 1) {
      failures.push(
        `A 20 m box at the origin caught ${out.length} runs where one run starts inside it.` +
          ' The reject is the run\'s own bounds against the box.',
      );
    }
    atlas.roadsWithin(-1000, -1000, 1000, 1000, 250, out);
    if (out.length !== 3) {
      failures.push(
        `An importance floor of 250 m kept ${out.length} runs where it should keep Crown Street's` +
          ' three and drop the lane.',
      );
    }
  }

  // --- The zoom ladder is a ladder, and the top of it is the build.
  {
    for (let i = 1; i < ZOOMS.length; i++) {
      if (!(ZOOMS[i].halfM > ZOOMS[i - 1].halfM)) {
        failures.push(`Zoom ${i} (${ZOOMS[i].name}) is not wider than the one before it.`);
      }
      if (ZOOMS[i].roadFloor < ZOOMS[i - 1].roadFloor) {
        failures.push(
          `Zoom ${i} (${ZOOMS[i].name}) draws *more* minor streets than the closer rung, which is` +
            ' the wrong way round: a wider view has less room, not more.',
        );
      }
    }
    if (DEFAULT_ZOOM < 0 || DEFAULT_ZOOM >= ZOOMS.length) {
      failures.push(`The default zoom index ${DEFAULT_ZOOM} is not a rung on the ladder.`);
    }
  }

  // --- The scale bar is a number a person can multiply by.
  {
    const cases: Array<[number, number]> = [
      [1127, 1000],
      [999, 500],
      [480, 200],
      [199, 100],
      [12, 10],
    ];
    for (const [given, want] of cases) {
      const got = scaleBarMetres(given);
      if (got !== want) {
        failures.push(`A scale bar with ${given} m of room came out ${got} m rather than ${want}.`);
      }
      if (got > given) {
        failures.push(`The scale bar (${got} m) is longer than the room it was given (${given} m).`);
      }
    }
  }

  return failures;
}
