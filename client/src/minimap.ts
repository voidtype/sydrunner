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
 *
 * ---------------------------------------------------------------------------
 * AND THEN IT MOVED ONTO THE PHONE, WHICH IS NOT THE SAME AS BEING TOGGLED.
 *
 * The paragraphs above argue that this disc must be permanent, and the argument
 * is still right about the thing it was made about: **a key** that dismissed the
 * compass would take navigation away mid-fight to save 0.017 ms, and no such key
 * exists now either.
 *
 * What decides it instead is what the player is **carrying**. The owner's line
 * was "maps should be accessible thru phone only", and the compass is a map. So
 * the disc is on the screen while the phone is in one of your two hands and not
 * otherwise -- which is a state the player chose on the number row, can see in
 * their own hands, and trades for something (a bat *and* a football is two
 * weapons and no map). That is a loadout decision rather than an interface
 * option, and it is the one shape of "the map can be off" this file's own
 * argument does not rule out.
 *
 * Mechanically it is one method, `setScale`, and everything it does is a class
 * on two elements plus an early return in `update`. The **size** is a CSS
 * transform rather than a second bitmap: this class derives `size`, `dpr` and
 * `scale` once in its constructor from the element's content box, so a genuinely
 * larger map would mean re-deriving all three and re-rasterising at a new pixel
 * density -- for a picture whose content is 30 px blocks and reads perfectly
 * well re-sampled. See `game/phone.MINIMAP_RAISED` for the number and
 * `index.html` for the two rules that consume it.
 */

import type { CollisionWorld, Prism } from './player/collision.ts';
import {
  HAZARD_FILL,
  hatchPattern,
  type HazardKind,
} from './world/invisible-walls.ts';
// The two team dots take the teams' own colours, from the one place they are
// written. A hex copied into this file would be a second owner of a colour that
// is also on a body, a nameplate pill and a stylesheet variable.
import { TEAM, TEAM_COLOUR } from './game/teams.ts';

/**
 * Whoever knows which prisms are solid-but-undrawn.
 *
 * Structural, like every other seam in this file, so the map does not import the
 * detector's class and a test can hand it a function. Null until `main.ts`
 * supplies one, and null is a working configuration -- it is the map this file
 * drew before the overlay existed.
 */
export type HazardSource = (prism: Prism) => HazardKind | null;

/**
 * What a marker can be.
 *
 * A closed union rather than a free string, so a typo in a provider is a
 * compile error rather than an invisible dot -- and it is closed at four
 * because four is what exists. A remote player, when the net layer arrives,
 * is a `combatant`: it is drawn from the same path, in the same red, with the
 * same heading tick, because from the map's point of view a remote and the
 * aggressor dummy are the same object -- someone else who can hit you.
 *
 * `bike` is an **unclaimed** lime e-bike, and the qualifier is the whole of it:
 * a bike somebody is riding is a moving object that belongs to them and a dot
 * for it would be a dot you cannot act on. The world half of the same signal is
 * `world/bike.ts`'s beam, gated on exactly the same test, so the column in the
 * street and the dot on the map go out together the instant somebody gets on.
 */
/**
 * `event` is an **ambient event** out of `game/events.ts` -- a fender-bender, a
 * bin night, a burnout -- and it is the only kind on this list that carries a
 * `label`.
 *
 * It behaves like `rave` and not like the other four: it is a place something is
 * happening rather than a thing you can pick up or hit, and like a rave it is
 * temporary. The difference from a rave is that a rave marker is a *memory* --
 * only sites you have been within earshot of are marked -- and an event marker
 * is a *report*: it is on the map because the schedule says it is on, and the
 * schedule is a pure function every client evaluates identically. There is no
 * information leak in that, because there is nothing to leak; the events are the
 * same for everybody and always were.
 */
export type MarkerKind =
  | 'training'
  | 'flat-white'
  | 'combatant'
  | 'bike'
  | 'rave'
  | 'event'
  /**
   * A Centrelink office. See `game/centrelink-data.ts`.
   *
   * A **place** rather than a thing, which is the category `rave` opened and
   * this one settles: a powerup is there or it is not, a combatant moves, and
   * an office is a fixed point on a map that is worth a hundred dollars once a
   * week. Drawn on the big map always and on the minimap inside 300 m, which is
   * further than anything else here -- because unlike a cafe, walking past one
   * without noticing costs you something.
   */
  | 'centrelink'
  /**
   * Where the SydRide passenger is, and where they are going.
   *
   * Two kinds rather than one with a flag, because the whole job of these two
   * dots is to be told apart at a glance while driving: the pickup is where you
   * are going *now* and the dropoff is where you are going *after*, and a map
   * that drew them in one colour would be a map you have to read.
   */
  | 'fare-pickup'
  | 'fare-dropoff'
  /**
   * A player who is on a side. See `game/teamlook.teamMarkerKind`.
   *
   * **Two kinds rather than a `combatant` with a colour argument**, and the
   * reason is this union's own header two paragraphs up: it is closed so that a
   * typo in a provider is a compile error rather than an invisible dot, and
   * `markerInk` is the one shared switch both maps read. Threading a colour
   * through `MarkerSink.mark` would have added a parameter to every provider in
   * the client -- powerups, bikes, raves, events, Centrelink, fares -- to serve
   * one of them.
   *
   * They keep the combatant's *size* and its heading tick, because that is what
   * they are: somebody who can hit you. What changes is the hue, which is the
   * single most useful thing a map of a two-team melee can tell you and is
   * exactly the read the body tint gives in the street.
   */
  | 'team-marita'
  | 'team-default';

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
  /**
   * A short name drawn beside the dot on the **big map only**, or undefined.
   *
   * The compass has no room for text and says so at length in its own header --
   * it refuses street labels for the same reason -- so this field is ignored
   * there. It exists because an event dot without a name is a dot: "there is
   * something at Erskineville" is not information a player can act on, and
   * "bin night" is.
   */
  label?: string;
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
  mark(x: number, z: number, kind: MarkerKind, yaw?: number, label?: string): void;
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

/**
 * The unclaimed e-bikes, in the bike's own lime.
 *
 * `#9BC53D` is `world/bike.LIME` written in sRGB -- the frame's paint, not the
 * glow's emission -- brought up a little for a 2.6 px dot, which is small enough
 * that a colour reads several steps darker than the same colour in a field.
 * Using the object's own colour is the entire reason this is legible without a
 * legend: the thing you are looking for in the street is bright yellow-green,
 * and so is the dot that says where it is.
 *
 * It clears the map's own palette on hue rather than on brightness, which is
 * what makes it safe against both grounds it is drawn over: the buildings are
 * the interface's one pale blue-white and the harbour is a desaturated blue, and
 * a yellow-green is the far side of the wheel from both. The powerups' gold is
 * the nearest neighbour and is separated the same way the world separates them
 * -- gold is orange-yellow, this is green-yellow, and at 3 px that is the
 * difference between a coffee and a bike.
 */
const BIKE_DOT = 'rgb(174,214,79)';

/** The player. The only pure white on the map, because it is the only thing that is always there. */
const PLAYER_FILL = 'rgba(255,255,255,0.92)';
/** North, at the rim. Dimmer than the figure -- it is orientation, not content. */
const NORTH_INK = 'rgba(207,226,242,0.62)';

/** Marker radii in *pixels*, which is why they are not inside the map transform. */
const POWERUP_DOT_R = 3;
const COMBATANT_DOT_R = 3.5;
/**
 * The bikes, a shade smaller than a powerup.
 *
 * A ranking rather than a taste: somebody who can hit you is the biggest dot, a
 * spec 8.3 objective is the middle one, and a bike is a convenience you take if
 * it is on your way. There are also up to a couple of dozen of them inside 160 m
 * in the inner suburbs against two or three powerups, and dots at the same size
 * would make the map read as being mostly about bikes.
 */
const BIKE_DOT_R = 2.6;
/** How far a combatant's heading tick reaches past their dot, in pixels. */
const HEADING_TICK = 5;

/**
 * What colour a marker is drawn in, for **both** maps.
 *
 * Exported and shared rather than written out twice, on `collect`'s own
 * argument: the two maps already draw one marker list, and the failure mode of
 * a second copy of this switch is the big map inventing a colour the compass
 * does not use -- which is a legend that changes when you press `M`. A pure
 * function of the kind, so `verifyBigMap` can assert the whole palette without a
 * canvas.
 */
export function markerInk(kind: MarkerKind): string {
  switch (kind) {
    case 'team-marita':
      return TEAM_COLOUR[TEAM.MARITA].css;
    case 'team-default':
      return TEAM_COLOUR[TEAM.DEFAULT].css;
    case 'training':
      return TRAINING_DOT;
    case 'flat-white':
      return FLAT_WHITE_DOT;
    case 'bike':
      return BIKE_DOT;
    case 'rave':
      return RAVE_DOT;
    case 'event':
      return EVENT_DOT;
    case 'centrelink':
      return CENTRELINK_DOT;
    case 'fare-pickup':
      return FARE_PICKUP_DOT;
    case 'fare-dropoff':
      return FARE_DROPOFF_DOT;
    default:
      return COMBATANT_DOT;
  }
}

/**
 * A rave you have heard, in the rig's own magenta.
 *
 * `world/rave.ts`'s first palette opens on a magenta and it is what the default
 * warehouse rig throws into the sky, so the same argument the bike's lime dot
 * makes applies exactly: the thing you are looking for out there is magenta, and
 * so is the dot that says where it was. It is also the one hue on this map that
 * is neither a person nor a coffee, which matters because a rave marker means
 * something categorically different from every other dot here -- it is not a
 * thing that is there *now*, it is a place you have been told about.
 *
 * **Only raves the player has actually been within earshot of are marked**, and
 * that is the whole design of this marker. A map that showed every live site
 * would be a quest list; a map that remembers the one whose bass you walked past
 * an hour ago is a map. See `main.ts`'s rave marker source.
 */
const RAVE_DOT = 'rgb(236,86,196)';

/**
 * An ambient event, in an amber that is nothing else on this map.
 *
 * The palette here is nearly full: gold is a powerup, white is a coffee, red is
 * somebody who can hit you, lime is a bike and magenta is a rave. Amber is the
 * one warm hue left, and it happens to be the right one anyway -- three of the
 * five events are literally lit by hazard lights, and `world/events.ts` draws
 * those in very nearly this colour. `verifyBigMap` asserts that no two markers
 * share an ink, which is what makes "nearly full" a checked claim rather than an
 * impression.
 */
const EVENT_DOT = 'rgb(240,150,40)';
/**
 * Centrelink, in the one colour money is drawn in anywhere in this interface.
 *
 * A muted gold rather than a bright one. The bike's lime and the rave's magenta
 * are both *the colour of the thing they point at* -- a lime frame, a magenta
 * rig -- and there is no such tie here: an office is a beige shopfront. So the
 * dot is tied to the **HUD's** money instead, which is the `$1,234` above the
 * pips, and the two being one colour is what makes the marker legible without a
 * legend. Dark enough that thirty-one of them across a 60 km map do not read as
 * a constellation.
 */
const CENTRELINK_DOT = 'rgb(214,178,96)';

/**
 * The fare's two ends: the pickup bright, the dropoff dimmer.
 *
 * The same hue, deliberately, because they are two ends of one job -- and two
 * different hues would be two things to learn. What separates them is value,
 * which is the one channel that survives being glanced at in peripheral vision
 * while driving: the bright one is where you are going now.
 */
const FARE_PICKUP_DOT = 'rgb(120,214,236)';
const FARE_DROPOFF_DOT = 'rgb(64,124,142)';

const TAU = Math.PI * 2;

/** Ring of recent redraw costs, in milliseconds. Four seconds of them at 15 Hz. */
const TIMING_SAMPLES = 60;

export class Minimap implements MarkerSink {
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * The element itself, kept as well as its context.
   *
   * For two things this class did not used to do: `setScale` toggles classes on
   * it, and `canvas` hands it out so `world/phone.ts` can use the same bitmap as
   * the handset's screen texture -- one rasterisation, drawn twice.
   */
  private readonly element: HTMLCanvasElement;
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
  /** Which prisms are invisible walls, or null before `main.ts` says. */
  private hazardSource: HazardSource | null = null;
  /**
   * One hatch per kind, built on first use and kept.
   *
   * Lazily rather than in the constructor because building one needs a second
   * canvas and a `createPattern`, and the overwhelmingly common case is a map
   * with no hazard on it at all -- a player standing in a built part of the city
   * with no viaduct nearby, which is most of a session.
   */
  private readonly hatches = new Map<HazardKind, CanvasPattern | null>();
  /** Footprints marked by the last redraw, by kind. See `stats`. */
  private hazardCounts: Record<HazardKind, number> = { unbuilt: 0, structure: 0 };
  /**
   * The hazard verdict per prism of the current redraw, parallel to `prisms`.
   *
   * Held so the source is asked once per prism rather than once per kind: the
   * fill is one path per kind and a naive version would run the query twice.
   * Reused and grown to the high-water mark, like everything else on this class.
   */
  private readonly prismKinds: Array<HazardKind | null> = [];

  /**
   * How large the disc is drawn, or 0 for not drawn at all. See `setScale`.
   *
   * **1 rather than 0 at construction**, and it is not a preference: the element
   * is measured in the constructor and a `display: none` element has a
   * `clientWidth` of zero, which would put this map on its 206 px fallback for
   * the whole session. So it starts laid out, and the first frame -- which runs
   * before anything is composited -- puts it where the player's hands say. See
   * `money.frame`, which pushes the scale every frame.
   */
  private scaleFactor = 1;

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
    this.element = canvas;
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
   * The bitmap this class rasterises into.
   *
   * Handed out for exactly one purpose: `world/phone.ts` wraps it in a
   * `CanvasTexture` so the handset's screen shows the map that is already being
   * drawn. One rasterisation, two surfaces -- which is the only version of "the
   * map is on the phone screen" that does not double the 15 Hz cost this file's
   * header spends four paragraphs justifying.
   *
   * The element and not the context, because a texture wants the element; and
   * read-only by convention, because a second writer would be a second thing
   * clearing it.
   */
  get canvas(): HTMLCanvasElement {
    return this.element;
  }

  /**
   * How large to draw the disc, or 0 to take it off the screen entirely.
   *
   * Pushed every frame by `money.frame` from `game/phone.minimapScale`, which is
   * where the rule lives; this method is only the consequence. A boolean compare
   * when nothing has changed, which is every frame but the two a number key
   * produces.
   *
   * **The locator strip goes with the disc**, both ways. "King Street, Newtown"
   * with no plan above it is a caption with no picture, and a strip that stayed
   * behind when the map left would sit against the top-right edge looking like a
   * label for the sky.
   *
   * A hidden map **stops redrawing**, which is the one part of this that is not
   * purely cosmetic: `update` returns before `draw`, so a player fighting with a
   * bat and a football pays nothing at all for a map they are not carrying --
   * no `prismsWithin`, no path build, no fill. That is the answer to the header's
   * old worry about what a toggle would save. It saves 0.017 ms and the point
   * was never the microseconds.
   */
  setScale(scale: number): void {
    if (scale === this.scaleFactor) return;
    const wasOff = this.scaleFactor <= 0;
    this.scaleFactor = scale;
    // Coming back on, redraw on the **next** frame rather than at the next tick
    // of the 15 Hz clock. The bitmap still holds whatever was on it when the
    // phone went away, which may be a different suburb entirely, and up to 66 ms
    // of a map of somewhere else is exactly the kind of wrong a player would
    // read as the map being broken. One redraw, on the frame a number key was
    // pressed.
    if (wasOff && scale > 0) this.clock = REDRAW_DT;
    const off = scale <= 0;
    // `raised` is a single class rather than an inline `transform`, so the two
    // elements' transforms -- the disc's scale and the strip's compensating
    // offset, which are one number in two places -- stay in `index.html` beside
    // the layout they are derived from.
    this.element.classList.toggle('mapoff', off);
    this.element.classList.toggle('raised', scale > 1);
    this.readout?.classList.toggle('mapoff', off);
    this.readout?.classList.toggle('raised', scale > 1);
  }

  /** Is the compass on the screen? For the console handle and the checks. */
  get shown(): boolean {
    return this.scaleFactor > 0;
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

  /**
   * Which footprints on this map are solid and undrawn. See
   * `world/invisible-walls.ts`.
   *
   * A setter on `setWaterSource`'s terms and for the same reason: there is
   * exactly one thing in this client that knows, and it is built after the map.
   *
   * The overlay is *over* the figure rather than instead of it, and that is the
   * whole reading of it. The footprints are drawn from the collision prisms, so
   * a building whose geometry has not arrived is already on this map -- the map
   * knows about it, because the map is drawn from the thing that stops you. What
   * the wash says is "and this one is not in the world yet", which is a
   * statement about the *difference* between the map and the window, and it only
   * means that if the shape is visibly still there underneath.
   */
  setHazardSource(source: HazardSource): void {
    this.hazardSource = source;
  }

  /**
   * The hatch for a kind, built once.
   *
   * `null` is cached as readily as a pattern: a context that would not make one
   * will not make one on the next redraw either, and retrying at 15 Hz forever
   * is the wrong answer to a headless canvas.
   */
  private hatch(kind: HazardKind): CanvasPattern | null {
    let pattern = this.hatches.get(kind);
    if (pattern === undefined) {
      pattern = hatchPattern(this.ctx, kind, this.dpr);
      this.hatches.set(kind, pattern);
    }
    return pattern;
  }

  /**
   * `MarkerSink`. Culls to the map's radius so no provider has to.
   *
   * `label` is accepted and **dropped**, which is the correct behaviour rather
   * than an omission: this map is a rotating figure-ground plan at 160 m and its
   * own header argues at length that it must not carry text. Accepting the
   * argument and ignoring it is what lets one provider feed both maps -- see
   * `Marker.label`.
   */
  mark(x: number, z: number, kind: MarkerKind, yaw?: number, label?: string): void {
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
    void label;
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
    // Not on the screen, not drawn. See `setScale`: the map is the phone's now,
    // and a player carrying a bat and a football is carrying no map -- so this
    // is the frame loop's cheapest possible answer rather than a redraw nobody
    // can see. The marker sources are unaffected: `collect` is a separate path
    // and the big map still reads them.
    if (this.scaleFactor <= 0) return;
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

    // --- The invisible walls, washed over the figure that is already there.
    //
    // One path per kind and one fill each, which is the footprints' own argument
    // taken as far as it goes: a per-footprint fill double-darkens every party
    // wall, and a hazard region in a terrace row is exactly where that would show
    // up worst. Two kinds means at most two fills, and the common case -- nothing
    // marked -- costs one pass over an array of nulls and no fill at all.
    this.hazardCounts.unbuilt = 0;
    this.hazardCounts.structure = 0;
    if (this.hazardSource !== null) {
      let marked = 0;
      for (let i = 0; i < prisms.length; i++) {
        const kind = this.hazardSource(prisms[i]);
        this.prismKinds[i] = kind;
        if (kind !== null) {
          this.hazardCounts[kind]++;
          marked++;
        }
      }
      if (marked > 0) {
        // The permanent one on top, because where a viaduct stands in a tile
        // that has not built yet both are true and the one that will still be
        // true in a second is the one to show.
        for (const kind of ['unbuilt', 'structure'] as const) {
          if (this.hazardCounts[kind] === 0) continue;
          ctx.save();
          ctx.translate(half, half);
          ctx.rotate(yaw);
          ctx.scale(this.scale, this.scale);
          ctx.beginPath();
          for (let i = 0; i < prisms.length; i++) {
            if (this.prismKinds[i] !== kind) continue;
            const pts = prisms[i].points;
            const n = pts.length;
            if (n < 6) continue;
            ctx.moveTo(pts[0] - px, pts[1] - pz);
            for (let v = 2; v < n; v += 2) ctx.lineTo(pts[v] - px, pts[v + 1] - pz);
            ctx.closePath();
          }
          // Out of the transform before filling, exactly as the figure above
          // does it -- and here it is load-bearing twice over, because the hatch
          // is a *pattern* and a pattern is transformed at fill time rather than
          // per point. Filling inside the map transform would rotate the hatch
          // with the world and scale it to metres.
          ctx.restore();
          ctx.fillStyle = HAZARD_FILL[kind];
          ctx.fill();
          const hatch = this.hatch(kind);
          if (hatch !== null) {
            ctx.fillStyle = hatch;
            ctx.fill();
          }
        }
      }
    }

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
        ink = markerInk(m.kind);
        ctx.fillStyle = ink;
        // The tick takes the marker's own colour rather than the combatant red
        // it is only ever drawn in today, so a future kind with a heading is not
        // a red tick on a gold dot.
        ctx.strokeStyle = ink;
      }

      // A teamed player is a combatant with a hue, so they take the combatant's
      // radius: the ranking this file sets out -- somebody who can hit you is the
      // biggest dot -- is about what a marker *is*, not about which side it is on.
      const combatant = m.kind === 'combatant' || m.kind === 'team-marita' || m.kind === 'team-default';
      const r = combatant ? COMBATANT_DOT_R : m.kind === 'bike' ? BIKE_DOT_R : POWERUP_DOT_R;
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
    /** 0 off, 1 in the corner, `MINIMAP_RAISED` with the phone up. */
    scale: number;
    mapKey: string;
    readout: string;
    hz: number;
    redraws: number;
    prisms: number;
    vertices: number;
    markers: number;
    waterTriangles: number;
    /**
     * Footprints on the disc that are solid and undrawn, by kind.
     *
     * On the readout because this overlay is the one thing on either map whose
     * *absence* is indistinguishable from it working: a map with no hazard on it
     * looks exactly like a map whose hazard source was never wired up. A
     * non-zero here after riding into cold city is what says the feature is
     * live. See `world/invisible-walls.ts`.
     */
    hazards: { unbuilt: number; structure: number };
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
      // Whether the phone is in a hand, which is the whole of what decides it
      // now. Reported rather than assumed because a compass that is off looks
      // exactly like a compass that is broken, and this is the one field that
      // tells the two apart from a console. See `setScale`.
      visible: this.shown,
      scale: this.scaleFactor,
      mapKey: 'M equips the phone and opens its map; the compass follows the phone',
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
      hazards: { unbuilt: this.hazardCounts.unbuilt, structure: this.hazardCounts.structure },
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
