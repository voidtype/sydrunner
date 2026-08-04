/**
 * The rotating minimap: a figure-ground plan of the city, player-centred.
 *
 * A corner overlay beside `hud.ts` rather than anything in the scene -- it is
 * 2D canvas over the WebGPU surface, on the same terms the pips, the vignette
 * and the reticle already are. It draws buildings as solid figure on dark
 * ground, rotates so that where the player is looking is up, and marks spec
 * 8.3's live powerups and everyone who can punch you.
 *
 * ---------------------------------------------------------------------------
 * The roads are drawn by not drawing them, and that is the whole design.
 *
 * The obvious minimap wants a street network and this client does not have one.
 * Streets exist in the build as *geometry* -- a unioned carriageway, a kerb and
 * a footpath band, triangulated into each tile's GLB behind three material
 * slots, in tile-local space, cut against the terrain facets. Nothing on this
 * side of the wire knows a centreline from a driveway, and recovering one would
 * mean re-projecting a few hundred thousand triangles per redraw to find the
 * edges of a shape the pipeline had and threw away.
 *
 * What the client *does* have, already decoded and already in world metres, is
 * every building footprint -- because collision needs them. And a plan of solid
 * buildings on dark ground leaves the street network as the void between them,
 * which is how a printed street map of a dense city reads and is exactly the
 * figure-ground trick Nolli's plan of Rome is famous for. Sydney's inner ring is
 * terrace rows and perimeter blocks, which is the densest possible case for it:
 * the built mass is continuous and the gaps between the masses *are* the
 * streets, the laneways and the parks. So this file draws footprints and stops,
 * and the map reads as a street map without one street in it.
 *
 * That also means parks are simply ground -- no fill of their own. It costs a
 * distinction (a park and a car park look alike) and it buys the only two
 * sources this file needs being sources it already has.
 *
 * **Water is the one exception, and it earns it.** The figure-ground read works
 * because the void between the masses is street; the harbour is void on that
 * measure and reads as an enormous plaza, which is the single most misleading
 * thing this map could say to a player deciding where to run. It also arrived
 * with a source that costs nothing to use: the water sheets are already decoded
 * and already in world metres for the renderer, so a fill is a second path over
 * data the client is holding either way. See `setWaterSource`.
 *
 * ---------------------------------------------------------------------------
 * Why the collision prisms rather than the render meshes.
 *
 * Spec section 5's rule is that collision is always the *simplified* prism, and
 * that simplification is what makes this cheap: the payload is one closed
 * world-space polygon per building at a vertex count a physics query can afford,
 * which is also the vertex count a 210 px map can resolve. `main.ts` keeps them
 * for 420 m around the player, on a radius set by how far a player can reach
 * rather than by how far the renderer draws -- so at this map's 160 m the answer
 * is complete by a factor of 2.6 and can never be waiting on a fetch. The
 * meshes, by contrast, are per tile and per material slot, indexed, in
 * tile-local space, and would have to be de-duplicated across nine slots that
 * all contain pieces of the same building.
 *
 * ---------------------------------------------------------------------------
 * Fifteen hertz, and one path with one fill.
 *
 * Canvas 2D is main-thread rasterisation sharing a frame with the renderer's
 * submit, so the cost of this is paid in the same 16.7 ms everything else is.
 * Two decisions keep it small.
 *
 * **It redraws at 15 Hz rather than per frame.** The most a player can move
 * between redraws is a sprint at 8.2 m/s over 1/15 s, which is 0.55 m, which at
 * this map's 0.65 px/m is a third of a pixel. There is no frame in which the
 * difference is visible, and it is four times less work at 60 fps and eight at
 * 120.
 *
 * **Every footprint is a subpath of one path, filled once.** A fill per building
 * is a rasteriser setup and a composite per building, and -- the part that is a
 * *correctness* argument rather than a speed one -- it double-darkens wherever
 * two footprints touch, because 0.30 over 0.30 composites to 0.51. A terrace row
 * is thirty party walls, so the naive version draws a row of houses as a row of
 * bright seams. One path filled once with the nonzero rule composites the union
 * at a single alpha, and a terrace row reads as the single mass it actually is.
 *
 * No stroke, for the same two reasons at once: an outline is a second pass over
 * every edge, and at 0.65 px/m the outline of a 6 m terrace *is* the terrace.
 *
 * ---------------------------------------------------------------------------
 * What it actually costs, measured against the shipped payload.
 *
 * The number to have in mind before reading any of the above as premature is
 * that **a redraw touches about 190 footprints, not a few thousand**. The 420 m
 * ring `main.ts` keeps loaded holds 3,287 prisms at the spawn; this map's disc
 * is a sixteenth of that ring's area and sees 83 at the emptiest viewpoint, 189
 * at the median and 230 at the worst, for 611 / 1,110 / 1,401 vertices -- 6.1
 * points a footprint, which is what "collision is the simplified prism" buys.
 * Those figures are from the densest tile in the built extent, which is also
 * where the game spawns: tile `1_-3` at (750, 1250), 542 buildings. The CBD
 * proper is *thinner* than that on this measure and not denser, because a tower
 * district is a few large footprints where a terrace suburb is hundreds of
 * small ones.
 *
 * The query and the path build together run at **0.014 ms median and 0.017 ms
 * at the worst viewpoint**, of which `prismsWithin` is 0.010. That is the half
 * this file can be held responsible for; the rasteriser's half is the browser's
 * and is what `stats()` reports, because the only honest measurement of it is
 * on the real canvas backend in the real frame. Against the 1.5 ms budget in
 * `stats().budgetMs` there is room for the fill to be two orders of magnitude
 * more expensive than the code that feeds it.
 *
 * The decimation this was expected to need -- every second vertex -- is
 * therefore not in, and should not go in without a measurement saying so: at
 * six points a footprint, dropping every second one turns a rectangle into a
 * triangle.
 *
 * ---------------------------------------------------------------------------
 * `ctx.rotate(yaw)` -- the player's own yaw, not its negative.
 *
 * Worth deriving, because both signs produce a map that turns and only one
 * produces a map that turns the right way.
 *
 * The controller's convention is that yaw 0 faces -Z and forward is
 * `(-sin y, -cos y)` in (x, z). Plot a world offset `(dx, dz)` straight into
 * canvas space as `(dx, dz)` and apply `rotate(t)`, and the canvas puts it at
 * `(dx cos t - dz sin t, dx sin t + dz cos t)`. Substituting the forward vector
 * at `t = y` gives `(-sin y cos y + cos y sin y, -sin y sin y - cos y cos y)` =
 * `(0, -1)`: straight up the screen, at every yaw. So `t = y`, and the world's
 * z axis goes into the canvas's y axis unnegated even though north is -Z --
 * which looks wrong and is not. Canvas y runs *down*, so the two negations
 * cancel and north lands at the top when the player faces north.
 *
 * ---------------------------------------------------------------------------
 * The buildings ride the canvas transform; the markers do not.
 *
 * A few thousand vertices go through `translate/rotate/scale` because the path
 * builder has to transform every point anyway and doing it in the matrix is
 * free. The two dozen markers have their rotation done in JS instead, and the
 * reason is that they are sized in *pixels*: a 3 px dot drawn inside
 * `scale(0.65, 0.65)` is a 4.6 m dot, so every marker on the map would change
 * size the day the radius does. Markers are tens of items and the maths is four
 * multiplies each.
 *
 * ---------------------------------------------------------------------------
 * There is no terrain in it, deliberately.
 *
 * The city stands on a real DEM -- Crown Street is 40 m over Alexandria -- and
 * none of that is here. This is a *plan*: an orthographic slice with no relief
 * shading, no contour, no height tint, and a building on a ridge drawn exactly
 * like one in a hollow. Two reasons. A footprint is 2D and its prism carries one
 * pad height, so any relief would have to come from the terrain grids as a
 * second sampled source and a second per-redraw loop. And a rotating 160 m map
 * is read for *shape* -- which street, which corner, which way round the block
 * -- and every scheme for putting height on it (hillshade, banding, tinting the
 * fill by base) spends contrast that the figure-ground read needs. The one thing
 * lost is that a wall you cannot climb and a wall you can look flat and the same
 * here; the world itself is where that is answered.
 *
 * ---------------------------------------------------------------------------
 * The one piece of text, and why it is not on the map.
 *
 * A figure-ground plan has no labels in it, and the reason is the same one that
 * makes the plan work at all: the streets here are the *void* between the
 * buildings, so lettering a street means writing into the only part of the
 * picture that carries the shape. At 0.65 px/m a street name spans a block.
 *
 * So the naming happens in a strip *under* the disc -- `#locator` in
 * `index.html` -- a DOM element this class owns but does not compute. What goes
 * in it is `game/locator.ts`'s business, which projects the player onto the
 * street centrelines twice a second; all this file does is hold the reference
 * and write it when the text actually changes.
 *
 * ---------------------------------------------------------------------------
 * This map is permanent, and `M` belongs to the other one.
 *
 * It used to be toggled: `M` hid the disc and the strip together, and the
 * argument was that a player who did not want a map should not pay for one. That
 * was the wrong thing to spend the key on, and `bigmap.ts` is what took it.
 *
 * The two maps are not the same object with two sizes. This one is a *compass*
 * -- 160 m, rotating, always on, read at a glance mid-fight, with the street you
 * are standing on written under it. The big one is a north-up city map up to
 * nine kilometres across that covers the game while it is open. A key that
 * dismisses the second is essential, because it is in the way; a key that
 * dismisses the first takes away the only thing on the screen a player
 * continuously navigates by, to save a redraw that costs 0.017 ms.
 *
 * So the toggle is gone rather than merely unbound. What replaced it is
 * `collect`, which hands the big map this one's marker sources so the two can
 * never disagree about what is in the world.
 */

import type { CollisionWorld, Prism } from './player/collision.ts';

/**
 * What a marker can be.
 *
 * A closed union rather than a free string, so a typo in a provider is a
 * compile error rather than an invisible dot -- and it is closed at three
 * because three is what exists. A remote player, when the net layer arrives,
 * is a `combatant`: it is drawn from the same path, in the same red, with the
 * same heading tick, because from the map's point of view a remote and the
 * aggressor dummy are the same object -- someone else who can hit you.
 */
export type MarkerKind = 'training' | 'flat-white' | 'combatant';

/**
 * One thing on the map, in world metres.
 *
 * `yaw` is the controller's own convention -- 0 faces -Z -- and is optional
 * because most markers have no heading. A powerup is a point; a combatant has a
 * front, and which way they are facing is the single most useful bit about them
 * on a map of a melee game.
 */
export interface Marker {
  x: number;
  z: number;
  kind: MarkerKind;
  yaw?: number;
}

/**
 * Where a provider puts its markers.
 *
 * A sink rather than a returned array, and the difference is one that shows up
 * at 15 Hz forever: an array means every provider allocates a fresh array and a
 * fresh record per marker on every redraw, and each of them separately gets the
 * radius cull right. With a sink the records come out of one pool this file
 * owns and reuses, the cull happens once in `mark` for every provider at once,
 * and a provider is a `for` loop with no allocation in it at all.
 */
export interface MarkerSink {
  /** World metres. A marker outside the map's radius is dropped here, silently. */
  mark(x: number, z: number, kind: MarkerKind, yaw?: number): void;
}

/**
 * Anything that can put markers on the map.
 *
 * Called once per redraw with the map's centre and radius, so a provider with a
 * spatial index of its own can use them; the two registered today just filter
 * with `mark`'s own cull. This is the seam the net layer plugs into -- a remote
 * player list becomes a minimap feature in one `addMarkerSource` call and no
 * change to this file.
 */
export type MarkerSource = (
  sink: MarkerSink,
  centreX: number,
  centreZ: number,
  radius: number,
) => void;

/**
 * Where the water is: flat `x, z, x, z, ...` triangle soups in world metres,
 * three points a triangle, appended to the caller's array.
 *
 * A sink array rather than a returned one, on `MarkerSource`'s terms and
 * `CollisionWorld.prismsWithin`'s: this runs on a clock forever and nothing in
 * the redraw path may allocate. The arrays handed back are the streamer's own
 * and must not be mutated -- they are live until the tile is evicted, which is
 * exactly the lifetime this needs.
 */
export type WaterSource = (
  centreX: number,
  centreZ: number,
  radius: number,
  out: Float32Array[],
) => Float32Array[];

// --- The numbers --------------------------------------------------------------

/**
 * How much world the map shows, centre to rim, in metres.
 *
 * Set from the two things it has to serve at once and they nearly agree. A
 * Sydney inner-suburb block is 80-120 m on a side, so 160 m is two to four
 * blocks of context -- enough to see the corner you are running toward and the
 * one after it. And spec 8.3's icons are drawn through geometry to 60 m, so a
 * radius under that would only ever show powerups you could already see; 160 m
 * puts the next two or three cafes on the map before they are visible, which is
 * the entire reason to mark them.
 */
const RADIUS_M = 160;

/** Redraws a second. See the header for why this is not the frame rate. */
const REDRAW_HZ = 15;
const REDRAW_DT = 1 / REDRAW_HZ;

/**
 * The figure, in the HUD's one colour at the alpha that makes it read as mass.
 *
 * `rgba(207,226,242,...)` is the debug overlay's text and the border on the
 * pips, so the map is not a new colour in the interface. The 0.30 is against
 * the 55% dark the element's own background carries: the buildings land a little
 * over a third of the way from the ground to the interface's white, which is
 * enough separation to read a block shape at a glance and little enough that the
 * markers -- the only things on here a player acts on -- are unambiguously in
 * front of it.
 */
const BUILDING_FILL = 'rgba(207,226,242,0.30)';

/**
 * The water, at half the figure's alpha and pulled hard toward blue.
 *
 * It has to sit **between** the ground and the buildings and it has to do it by
 * hue rather than by brightness, because the one thing this map must not lose is
 * the figure-ground contrast the whole design rests on. At 0.16 over the
 * element's 55% dark the harbour lands about a fifth of the way to the
 * interface's white -- readable as a distinct region, and still clearly behind
 * a building at 0.30.
 *
 * Blue rather than the interface's one pale tone because it is the only place on
 * this map where the *thing* has a colour everybody already knows. Everything
 * else here is deliberately monochrome; water is the exception that makes a
 * glance at a harbour-front map instant.
 */
const WATER_FILL = 'rgba(96,158,214,0.16)';

/**
 * The two powerup tints, from `world/powerups.ts`'s `TINTS` so the dot and the
 * icon it stands for are the same colour.
 *
 * Gold for Training and cream for Flat White, and that pair was chosen in the
 * world for separation by hue as well as by brightness -- which matters more
 * here than there, because a 3 px dot has no shape at all to fall back on.
 */
const TRAINING_DOT = 'rgb(255,184,41)';
const FLAT_WHITE_DOT = 'rgb(247,237,209)';

/**
 * The combatants, in the interface's only red.
 *
 * `#f0a9a0` is the last health pip and a fatal error and nothing else, which is
 * the argument for reusing it rather than against: in this HUD red means the
 * thing that is about to hurt you, and a red dot on the map is someone who can.
 */
const COMBATANT_DOT = '#f0a9a0';

/** The player. The only pure white on the map, because it is the only thing that is always there. */
const PLAYER_FILL = 'rgba(255,255,255,0.92)';
/** North, at the rim. Dimmer than the figure -- it is orientation, not content. */
const NORTH_INK = 'rgba(207,226,242,0.62)';

/** Marker radii in *pixels*, which is why they are not inside the map transform. */
const POWERUP_DOT_R = 3;
const COMBATANT_DOT_R = 3.5;
/** How far a combatant's heading tick reaches past their dot, in pixels. */
const HEADING_TICK = 5;

const TAU = Math.PI * 2;

/** Ring of recent redraw costs, in milliseconds. Four seconds of them at 15 Hz. */
const TIMING_SAMPLES = 60;

export class Minimap implements MarkerSink {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly collision: CollisionWorld;
  private readonly sources: MarkerSource[] = [];
  /**
   * The street/suburb strip under the disc, or null where the page has none.
   *
   * Optional so this class still constructs against an older `index.html` --
   * and so a test can build a map with no DOM under it at all, which is the
   * same reason the marker sources are registered rather than imported.
   */
  private readonly readout: HTMLElement | null;
  /** Last text written. The write is skipped when it has not changed. */
  private readoutText = '';

  /** CSS pixels across the drawing surface -- the element's *content* box. */
  private readonly size: number;
  private readonly dpr: number;
  /** Pixels per world metre. */
  private readonly scale: number;

  /** Reused across redraws; both grow to their high-water mark and stay there. */
  private readonly prisms: Prism[] = [];
  private readonly pool: Marker[] = [];
  private markerCount = 0;
  /** Where the water is, or null before `main.ts` says. See `setWaterSource`. */
  private waterSource: WaterSource | null = null;
  /** Reused across redraws, like `prisms`; grows to its high-water mark and stays. */
  private readonly waterPlans: Float32Array[] = [];

  /** Where `mark` culls against, set at the top of each redraw. */
  private centreX = 0;
  private centreZ = 0;
  private radius2 = RADIUS_M * RADIUS_M;

  private clock = 0;

  // --- The dev counter. See `stats`.
  private readonly timings = new Float32Array(TIMING_SAMPLES);
  private timingCursor = 0;
  private redraws = 0;
  private lastMs = 0;
  private lastPrisms = 0;
  private lastVertices = 0;
  private lastMarkers = 0;
  /** Water triangles filled by the last redraw. See `setWaterSource`. */
  private waterTriangles = 0;

  constructor(
    canvas: HTMLCanvasElement,
    collision: CollisionWorld,
    readout: HTMLElement | null = null,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('The minimap canvas would not give a 2D context.');
    this.ctx = ctx;
    this.collision = collision;
    this.readout = readout;

    // Measured rather than written down, because the element is `border-box`
    // with a rim: the CSS says 210 and the drawing surface is 206, and a
    // bitmap sized to the wrong one of those is a map that is permanently
    // half a pixel soft. `clientWidth` is the content box and is the number
    // that matters -- which is also why widening the rim from 1 px to 2 needed
    // no change here and would have needed two if the 208 had been written
    // down. The fallback is the border-box figure minus today's rim, and is
    // only ever reached on an element that has not been laid out.
    this.size = canvas.clientWidth || canvas.offsetWidth || 206;
    // The same cap `main.ts` puts on the renderer's pixel ratio. A 3x phone
    // display would otherwise triple the fill cost of the one thing here that
    // is rasterised on the CPU.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = this.size / 2 / RADIUS_M;

    canvas.width = Math.round(this.size * this.dpr);
    canvas.height = Math.round(this.size * this.dpr);
  }

  /**
   * Register a provider. Called in registration order on every redraw.
   *
   * Nothing here checks for duplicates: a caller that registers the same source
   * twice gets its markers drawn twice, which is a caller bug and is visible.
   */
  addMarkerSource(source: MarkerSource): void {
    this.sources.push(source);
  }

  /**
   * Where the water is, as world-space triangle soups.
   *
   * A setter rather than a constructor argument, and a *single* source rather
   * than the marker sources' list, because there is exactly one thing in this
   * client that knows where the water is and it is built after the map --
   * `TileStreamer.waterPlansNear`, which fills the caller's array and allocates
   * nothing. Null until `main.ts` supplies one, and null is a working
   * configuration: it is what a world with no water in it draws.
   *
   * The soups are triangles rather than outlines, which is what makes this cheap
   * enough to do at all: recovering an outline from a triangulation means
   * finding the edges that appear once, per tile, per redraw. Filled as one path
   * with the nonzero rule, a triangulated polygon composites at a single alpha
   * exactly as its outline would -- which is the same argument the footprints
   * make about a terrace row's party walls, and the reason both are one fill.
   */
  setWaterSource(source: WaterSource): void {
    this.waterSource = source;
  }

  /** `MarkerSink`. Culls to the map's radius so no provider has to. */
  mark(x: number, z: number, kind: MarkerKind, yaw?: number): void {
    const dx = x - this.centreX;
    const dz = z - this.centreZ;
    if (dx * dx + dz * dz > this.radius2) return;
    let m = this.pool[this.markerCount];
    if (m === undefined) {
      m = { x: 0, z: 0, kind: 'combatant', yaw: undefined };
      this.pool.push(m);
    }
    m.x = x;
    m.z = z;
    m.kind = kind;
    m.yaw = yaw;
    this.markerCount++;
  }

  /**
   * Run every registered source into somebody else's sink.
   *
   * The seam `bigmap.ts` borrows rather than duplicating. `main.ts` registers
   * three sources on this class -- the live powerups, the local combatants and
   * the remote players -- and the big map wants exactly the same three at a
   * different scale. Re-registering them there would be the same three closures
   * written twice in the same file, drifting apart the first time one of them
   * changed, and the failure mode of the drift is the two maps disagreeing about
   * what is in the world.
   *
   * The centre and radius are passed straight through, so a source with a
   * spatial index of its own can still use them; the cull is the *sink's*, which
   * is what lets the big map cull to a square view where this one culls to a
   * disc. See `MarkerSource`.
   */
  collect(sink: MarkerSink, centreX: number, centreZ: number, radius: number): void {
    for (let i = 0; i < this.sources.length; i++) this.sources[i](sink, centreX, centreZ, radius);
  }

  /**
   * Put a line in the strip under the map.
   *
   * Guarded on the text having changed, which matters more than it looks:
   * assigning `textContent` invalidates layout for the element whether or not
   * the string differs, and this is called every frame by a caller that
   * recomputes it twice a second. The guard turns 60 layout invalidations a
   * second into about one every few seconds -- one per corner, in practice.
   *
   * Deliberately `textContent` and never `innerHTML`. The string is built from
   * OSM `name` tags, which are arbitrary user-entered text arriving over the
   * wire; there is no markup in a street name and this is the one line of the
   * interface where the world's own data reaches the DOM.
   */
  setReadout(text: string): void {
    if (text === this.readoutText || this.readout === null) return;
    this.readoutText = text;
    this.readout.textContent = text;
  }

  /**
   * Called every frame; redraws on its own clock.
   *
   * The clock resets to zero rather than subtracting the interval, so a frame
   * that arrives late delays one redraw instead of queueing a catch-up burst --
   * this is a picture of the present and there is nothing to catch up on.
   */
  update(dt: number, x: number, z: number, yaw: number): void {
    this.clock += dt;
    if (this.clock < REDRAW_DT) return;
    this.clock = 0;
    this.draw(x, z, yaw);
  }

  private draw(px: number, pz: number, yaw: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const size = this.size;
    const half = size / 2;

    // Everything below is in CSS pixels; the device ratio is the base transform
    // and is never composed with again.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    ctx.save();
    // The circle. The element's `border-radius` clips the bitmap too, so this is
    // belt and braces -- but it is also what keeps a footprint in the corner of
    // the query square from being rasterised at all, which is the cheaper half.
    ctx.beginPath();
    ctx.arc(half, half, half, 0, TAU);
    ctx.clip();

    // --- The water, under everything. One path, one fill, nonzero -- so a
    // triangulated bay composites at a single alpha exactly as its outline
    // would, which is the same reason the footprints below are one path.
    let waterTriangles = 0;
    if (this.waterSource !== null) {
      const plans = this.waterSource(px, pz, RADIUS_M, this.waterPlans);
      if (plans.length > 0) {
        ctx.save();
        ctx.translate(half, half);
        ctx.rotate(yaw);
        ctx.scale(this.scale, this.scale);
        ctx.beginPath();
        for (let p = 0; p < plans.length; p++) {
          const t = plans[p];
          for (let i = 0; i + 5 < t.length; i += 6) {
            ctx.moveTo(t[i] - px, t[i + 1] - pz);
            ctx.lineTo(t[i + 2] - px, t[i + 3] - pz);
            ctx.lineTo(t[i + 4] - px, t[i + 5] - pz);
            ctx.closePath();
            waterTriangles++;
          }
        }
        // Out of the transform before filling, exactly as the figure below does
        // it: canvas transforms each point as it is added, not at fill time.
        ctx.restore();
        ctx.fillStyle = WATER_FILL;
        ctx.fill();
      }
    }
    this.waterTriangles = waterTriangles;

    // --- The figure.
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(yaw);
    ctx.scale(this.scale, this.scale);

    const prisms = this.collision.prismsWithin(px, pz, RADIUS_M, this.prisms);
    let vertices = 0;
    ctx.beginPath();
    for (let i = 0; i < prisms.length; i++) {
      const pts = prisms[i].points;
      const n = pts.length;
      // Two points is a line and has no area; the payload should not contain
      // one, and a degenerate subpath in a shared path is not worth the risk.
      if (n < 6) continue;
      ctx.moveTo(pts[0] - px, pts[1] - pz);
      for (let v = 2; v < n; v += 2) ctx.lineTo(pts[v] - px, pts[v + 1] - pz);
      ctx.closePath();
      vertices += n >> 1;
    }
    // Out of the map transform *before* filling, and it is safe: canvas
    // transforms each path point as it is added, not at fill time. So the path
    // keeps the rotation and the fill is set up in plain pixels.
    ctx.restore();
    ctx.fillStyle = BUILDING_FILL;
    ctx.fill();

    // --- The markers. Pulled fresh every redraw: a powerup that respawned or a
    // dummy that moved is a provider's business and never this file's cache.
    this.centreX = px;
    this.centreZ = pz;
    this.markerCount = 0;
    for (let i = 0; i < this.sources.length; i++) {
      this.sources[i](this, px, pz, RADIUS_M);
    }

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let kind: MarkerKind | '' = '';
    let ink = COMBATANT_DOT;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < this.markerCount; i++) {
      const m = this.pool[i];
      const dx = m.x - px;
      const dz = m.z - pz;
      const sx = half + (dx * cos - dz * sin) * this.scale;
      const sy = half + (dx * sin + dz * cos) * this.scale;

      // One style write per *run* of like markers rather than one per marker.
      // It saves little on the powerups, which arrive in sidecar order with the
      // two kinds interleaved, and everything on the combatants, which are one
      // run -- and it costs a string compare either way.
      if (m.kind !== kind) {
        kind = m.kind;
        ink =
          m.kind === 'training'
            ? TRAINING_DOT
            : m.kind === 'flat-white'
              ? FLAT_WHITE_DOT
              : COMBATANT_DOT;
        ctx.fillStyle = ink;
        // The tick takes the marker's own colour rather than the combatant red
        // it is only ever drawn in today, so a future kind with a heading is not
        // a red tick on a gold dot.
        ctx.strokeStyle = ink;
      }

      const r = m.kind === 'combatant' ? COMBATANT_DOT_R : POWERUP_DOT_R;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fill();

      if (m.yaw !== undefined) {
        // Forward is `(-sin, -cos)` in world (x, z) -- the controller's, not a
        // second convention -- turned into screen by the same rotation the
        // positions took. A tick drawn from the raw yaw would point correctly
        // only while the player happened to be facing north.
        const fx = -Math.sin(m.yaw);
        const fz = -Math.cos(m.yaw);
        const tx = fx * cos - fz * sin;
        const ty = fx * sin + fz * cos;
        ctx.beginPath();
        ctx.moveTo(sx + tx * r, sy + ty * r);
        ctx.lineTo(sx + tx * (r + HEADING_TICK), sy + ty * (r + HEADING_TICK));
        ctx.stroke();
      }
    }

    // --- The player: a wedge at dead centre pointing up the screen, always.
    // It never moves and never turns, which is the entire proposition of a
    // rotating map -- the world turns around you rather than you around it.
    ctx.fillStyle = PLAYER_FILL;
    ctx.beginPath();
    ctx.moveTo(half, half - 7);
    ctx.lineTo(half + 4.5, half + 5);
    ctx.lineTo(half, half + 2.5);
    ctx.lineTo(half - 4.5, half + 5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // --- North.
    //
    // Drawn after the clip is released, so the arrowhead can meet the rim
    // exactly rather than being antialiased against the clip's own edge; the
    // element's `border-radius` is what actually bounds the bitmap.
    //
    // The counter-rotation: world north is (0, -1) in (x, z), which the map's
    // own rotation puts at `(sin yaw, -cos yaw)` on screen. The marker rides
    // that around the rim while the letter itself stays upright, because a
    // rotating "N" is a letter you have to read twice.
    const nx = half + sin * (half - 15);
    const ny = half - cos * (half - 15);
    ctx.fillStyle = NORTH_INK;
    ctx.beginPath();
    ctx.moveTo(half + sin * (half - 4), half - cos * (half - 4));
    ctx.lineTo(half + sin * (half - 11) + cos * 3.5, half - cos * (half - 11) + sin * 3.5);
    ctx.lineTo(half + sin * (half - 11) - cos * 3.5, half - cos * (half - 11) - sin * 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);

    const ms = performance.now() - t0;
    this.lastMs = ms;
    this.lastPrisms = prisms.length;
    this.lastVertices = vertices;
    this.lastMarkers = this.markerCount;
    this.timings[this.timingCursor] = ms;
    this.timingCursor = (this.timingCursor + 1) % TIMING_SAMPLES;
    this.redraws++;
  }

  /**
   * What the last redraw cost and what it drew, for `window.sydney.minimap`.
   *
   * The measurement is in the module rather than in a harness because the only
   * honest version of it runs against the real thing: the real prism count at
   * the real spawn, on the real canvas backend, composited into the real frame.
   * A bench that fed it synthetic polygons would be measuring a bench.
   *
   * Median and p95 rather than a mean, on the same argument `main.ts` makes
   * about the frame time: the interesting figure is the typical redraw, and one
   * hitch while a tile's prisms arrive should not be able to move it. Both are
   * over the last four seconds.
   */
  stats(): {
    visible: boolean;
    mapKey: string;
    readout: string;
    hz: number;
    redraws: number;
    prisms: number;
    vertices: number;
    markers: number;
    waterTriangles: number;
    lastMs: number;
    medianMs: number;
    p95Ms: number;
    budgetMs: number;
    radiusM: number;
    sizePx: number;
    dpr: number;
    sources: number;
  } {
    const n = Math.min(this.redraws, TIMING_SAMPLES);
    const sorted = Array.from(this.timings.subarray(0, n)).sort((a, b) => a - b);
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      // Always. The disc and the strip under it are permanent as of the pass
      // that gave `M` to the big map -- the field and the toggle behind this are
      // gone, and the key is reported so a console session can see which map it
      // belongs to now. See the header.
      visible: true,
      mapKey: 'M opens the big map; this one is permanent',
      // The last line handed to the strip. Reported here as well as in
      // `locator.stats()` because this is the end of the pipe: a readout that
      // is right in the locator and blank on screen is a missing `#locator`
      // element, and this is the only number that separates the two.
      readout: this.readoutText,
      hz: REDRAW_HZ,
      redraws: this.redraws,
      prisms: this.lastPrisms,
      vertices: this.lastVertices,
      markers: this.lastMarkers,
      // The water fill's own size, kept apart from `vertices` because the two
      // are different shapes of work: a footprint is a handful of points and a
      // sheet is a triangulation, so a redraw on the harbour draws more
      // triangles than the whole rest of the map and it should be visible which
      // half a slow redraw came from.
      waterTriangles: this.waterTriangles,
      lastMs: round(this.lastMs),
      medianMs: n ? round(sorted[n >> 1]) : 0,
      p95Ms: n ? round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]) : 0,
      // What this is allowed to cost. A redraw at 15 Hz spending 1.5 ms is 2.2%
      // of a second of wall clock, against a 60 fps budget of 16.7 ms a frame.
      budgetMs: 1.5,
      radiusM: RADIUS_M,
      sizePx: this.size,
      dpr: this.dpr,
      sources: this.sources.length,
    };
  }
}
