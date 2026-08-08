/**
 * What a rave looks like: the rig, the lasers, the haze, and forty people
 * covered in glow sticks.
 *
 * `game/rave.ts` is the half with no pictures in it — which sites are live
 * tonight, what is playing, where everybody is standing — and this is the half
 * that costs frame time. The division is `game/pedestrians.ts` and
 * `world/people.ts`'s, in the same words: the schedule is free and the figures
 * are not.
 *
 * The bar this file is written against is one sentence from the brief:
 * *"walking over a rise in Sydney Park at 2am and seeing lasers stabbing through
 * haze over a crowd of glowing figures, with bass arriving before the light
 * does, should be the best moment in the game."*
 *
 * ---------------------------------------------------------------------------
 * 1. NOT ONE `PointLight`. NOT ONE. AND THAT IS THE WHOLE ARCHITECTURE.
 *
 * `world/nightlights.ts` states the rule and the reason at length and it applies
 * here with more force than anywhere else in the project, because a rave is
 * *made of lights*: `LightsNode.customCacheKey` in three's WebGPU backend hashes
 * `light.id` and `light.castShadow` for **every light on the render list**, so
 * the set of lights in the scene is part of every material's cache key. A rave
 * that added a `PointLight` per PAR can — or even one, when the player arrived —
 * would rebuild and recompile *every pipeline in the scene*, synchronously,
 * inside the frame it happened. Sixteen fixtures at a site you can walk into
 * from any direction is the single most expensive version of that bug this
 * codebase could have shipped.
 *
 * So the real light count is unchanged at three, forever, and every coloured
 * thing here is **additive geometry**. That is the same argument
 * `world/bike.ts` makes for its beacons and `world/nightlights.ts` for a city of
 * five thousand lamps, and it is worth restating because it is *why this feature
 * is affordable at all*: the frame is tone-mapped at `calibration.EXPOSURE`
 * through `NeutralToneMapping`, so a night yard arrives at the blend at a few
 * hundredths of scene-linear. Adding one unit of magenta to that is not a tint,
 * it is a **light source**, and it costs one blend.
 *
 * ---------------------------------------------------------------------------
 * 2. THE PIPELINE BUDGET, WHICH IS THE OTHER WAY THIS FEATURE COULD RUIN THE
 *    GAME AND WHICH IS WHY THERE ARE EXACTLY TWELVE INSTANCED SETS.
 *
 * Three appends `object.uuid` to the node-builder cache key for anything
 * instanced (`getMaterialCacheKey`, unconditionally — see `world/warmup.ts`), so
 * **an `InstancedMesh` is a pipeline**, one each, and no boot-time stand-in can
 * warm one. The only thing that can is compiling the real object, which
 * `main.ts`'s scene pass does over the whole scene before the first frame is
 * issued.
 *
 * That makes the set count a budget rather than a style choice, and it is what
 * every consolidation below is for:
 *
 *   - The **lamp faces are inside the beam geometry** rather than a set of their
 *     own, exactly as `world/bike.ts` puts the glow at the foot of its beam.
 *   - The **strobe is the haze set**, driven white and hot for two frames,
 *     rather than a seventeenth mesh that is invisible 98% of the time.
 *   - **Every structural member in the world is one unit box**: the truss, the
 *     uprights, the speaker boxes, the booth, the pallets, the generator and the
 *     drums are one geometry drawn with a non-uniform instance scale. One
 *     pipeline for the entire physical rig.
 *   - The **ground pool is the foot of the beam**, not a disc.
 *
 * Twelve: beams, lasers, haze, glow, structure, litter, and the six pedestrian
 * impostor parts. Plus one ordinary mesh, the booth's LED banner, which *is*
 * warmable by a stand-in and is in `raveWarmupParts`.
 *
 * ---------------------------------------------------------------------------
 * 3. NO SHADER GRAPH. NOT ONE LINE OF TSL.
 *
 * Every colour here is `instanceColor`, and every brightness — the night gate,
 * the stage envelope, the beat, the per-fixture fade — is *folded into that
 * colour before it is written*. `NodeMaterial.setupDiffuseColor` already
 * multiplies the material colour by the geometry's `color` attribute and then by
 * `instanceColor`, so a beam's gradient (vertex, greyscale) times its hue
 * (instance) arrives through two built-in multiplies and no generated code at
 * all. `world/people.ts` relies on the same two multiplies for its kits and says
 * so.
 *
 * The consequence worth stating: there is **no uniform to keep in sync with the
 * sky**, no `time` node, and no per-frame material mutation. A material that is
 * never touched after construction cannot invalidate a pipeline, which given
 * section 2 is the property that matters most.
 *
 * ---------------------------------------------------------------------------
 * 4. HOW YOU FIND ONE, WHICH IS THE FEATURE.
 *
 * Three ranges, and they are the three stages of arriving:
 *
 *   - `BEAM_RANGE` (900 m). Four of the ten fixtures are **sky beams**: long,
 *     near-vertical, slow. They are the only part of a rave drawn at that
 *     distance and they are drawn *hot*, because at 900 m a beam is four pixels
 *     wide and four pixels of saturated magenta over a black roofline is a
 *     thing a player will walk toward without being told to. `world/bike.ts`
 *     made this exact measurement for its 72 m lime column and the numbers here
 *     are its numbers, moved for a coloured background instead of a sky.
 *   - `RIG_RANGE` (340 m). The crowd beams, the lasers, the haze, the structure.
 *     This is where it stops being a light on the horizon and becomes a place.
 *   - `CROWD_RANGE` (220 m) and `CROWD_RIG_RANGE` (44 m). The people, then the
 *     eight of them who get a skeleton.
 *
 * The audio does the other half and it does it *first*: `game/audio.ts` opens a
 * low-pass as you approach, so the bass genuinely arrives before the light does.
 * That ordering is not an accident of the ranges — it is the point of them.
 *
 * ---------------------------------------------------------------------------
 * 5. THE CROWD IS THE PEDESTRIAN RIG, DRESSED FOR IT.
 *
 * The same `PedestrianAssets` geometry, the same material, the same seven kits,
 * the same `CharacterActor` near tier — there is no second character system
 * here, which is the relationship `world/streetlife.ts` and `world/police.ts`
 * already have with `player/character.ts` and is why an attendee can be batted
 * through the code path a player is.
 *
 * What is added is **one instanced set of glow**: two glow sticks at the hands,
 * an EL-wire loop round the torso and a soft halo, per attendee, in one of six
 * colours, moving with them because it is composed onto the same transform. A
 * crowd of forty then reads from two hundred metres as a *field of drifting
 * lights* rather than as forty dark shapes, which is the thing the brief asked
 * for and is also — usefully — the cheapest possible way to make a crowd legible
 * in a scene with no lights in it.
 *
 * They dance by being driven from outside rather than by a new clip.
 * `player/bat.ts` set that precedent in as many words — *reach in from outside
 * and use the public surface* — and it applies here: a dancer is a
 * `CharacterActor` fed a bobbing position, a swaying yaw and a small speed, all
 * derived from `rave.beatAt`, which is shared. So the crowd is in time with the
 * music on every screen at once and no clip was added to a file three other
 * features depend on.
 *
 * ---------------------------------------------------------------------------
 * 6. WHAT IS NOT HERE.
 *
 * **No shadows.** Nothing in this file casts one except the physical structure,
 * and that only so the speaker stack left behind in the morning sits on the
 * ground rather than floating over it. The sun is down while the rig is running,
 * so a caster would be a depth pass for nothing; and an additive surface in a
 * depth pass is a black rectangle, which is the classic way a glow becomes a
 * hole.
 *
 * **No occlusion of the sound.** The low-pass is a function of distance and of
 * the site's own kind, not of what is between you and the booth. A real
 * occlusion test is a ray per frame into the collision world and the thing it
 * would buy — the mix dulling when you step behind a shed — is smaller than what
 * it costs, because the beams have already told you where the rig is.
 *
 * **No smoke machine puffs, no video wall, no crowd chatter.** Each is a system;
 * the three that were kept — beams, lasers, haze — are the three that make the
 * screenshot.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';

import { CharacterActor, COLOURWAYS, type CharacterAssets } from '../player/character.ts';
import { PedestrianAssets } from './people.ts';
import { warmupGeometry, type WarmupPart } from './warmup.ts';
import {
  ATTENDEE_CAP,
  GLOW_COLOUR_COUNT,
  PALETTE_COUNT,
  RAVE_STAGE,
  SITE_KIND,
  attendeeAt,
  barAt,
  beatAt,
  boothPosition,
  createAttendeePose,
  danceBob,
  deckTitle,
  liveRaves,
  raveNight,
  raveState,
  setPosition,
  venueBpm,
  type AttendeePose,
  type RaveSolid,
  type RaveVenue,
  type RecordBag,
  type SetPosition,
} from '../game/rave.ts';

type Rgb = readonly [number, number, number];

// --- Ranges and capacities --------------------------------------------------------

/**
 * How far a sky beam is drawn, metres. See section 4.
 *
 * 900 against `world/bike.ts`'s 400 for a beacon of similar height, and the
 * difference is what the two are *for*. A share bike's beam has to be findable
 * from the next few streets; a rave's has to be findable from a hill on the
 * other side of the suburb, because that is how a player learns that there is
 * one on at all. At 900 m a 55 m column is 3.5 degrees of a 72-degree field —
 * about 50 pixels tall and 4 wide at 1080p — which is a legible stripe.
 *
 * The cost of the range is one instanced draw of at most `BEAM_CAPACITY` and
 * nothing else: the crowd, the haze, the lasers and the structure are all gated
 * far tighter, so a rave on the horizon is four quads.
 */
export const BEAM_RANGE = 900;
/** The rig proper: crowd beams, lasers, haze, structure. */
export const RIG_RANGE = 340;
/** The crowd, as impostors. `world/people.ts`' own `IMPOSTOR_RADIUS` plus a touch. */
export const CROWD_RANGE = 220;
/**
 * Inside this an attendee is eligible for a real skinned body, metres.
 *
 * 44, where the street's tier hands over at 55 (`people.RIG_TAKE`), and lower on
 * purpose: a rave crowd is *dense*, so the same radius would put sixty people
 * inside it and there are eight bodies. Below 44 the nearest eight are reliably
 * the ones within arm's reach, which is where a skeleton is the difference
 * between a person and a silhouette.
 */
export const CROWD_RIG_RANGE = 44;
/** Hysteresis, `people.RIG_KEEP`'s reason exactly: a figure at the edge must not flip. */
const CROWD_RIG_KEEP = 58;

/**
 * How many raves are drawn at once. Three.
 *
 * Not a visibility limit — it is a *fill* limit, and the number comes from the
 * geometry of the city rather than from a budget. `MAX_LIVE` is six across
 * 19.3 km; the chance that four of them are inside 900 m of one another is
 * essentially zero, and three covers the one case that is real, which is
 * standing between the two Sydney Gateway viaducts with Sydney Park behind you.
 */
const MAX_DRAWN_VENUES = 3;

/** Light fixtures on one rig, and how many of them point at the sky. */
const FIXTURES: number = 10;
const SKY_FIXTURES = 4;
/** Laser projectors on one rig. */
const LASERS: number = 3;
/** Haze slabs over one dancefloor. */
const HAZE_SLABS = 5;
/** Structural members in one rig, and pieces of litter left the next morning. */
const STRUCTURE_PIECES = 34;
const LITTER_PIECES = 30;

const BEAM_CAPACITY = FIXTURES * MAX_DRAWN_VENUES;
const LASER_CAPACITY = LASERS * MAX_DRAWN_VENUES;
const HAZE_CAPACITY = HAZE_SLABS * MAX_DRAWN_VENUES;
const STRUCTURE_CAPACITY = STRUCTURE_PIECES * MAX_DRAWN_VENUES;
const LITTER_CAPACITY = LITTER_PIECES * MAX_DRAWN_VENUES;
/**
 * How many attendees are drawn across every rave in view at once.
 *
 * `ATTENDEE_CAP` is 64 at one site and two sites can be inside `CROWD_RANGE` of
 * each other, so 150 is the honest ceiling and it is under `people.ts`'s own 220
 * for the whole city's pedestrians. Past it the far raves simply stop adding
 * people, nearest first — the same graceful failure the crowd has.
 */
const ATTENDEE_CAPACITY = 150;
/** How many attendees get a skeleton. Eight; see `CROWD_RIG_RANGE`. */
export const CROWD_RIG_CAPACITY = 8;

// --- Colour ------------------------------------------------------------------------

/**
 * The four palettes, **linear**, three hues each.
 *
 * The *ratios* are what matter here; the absolute level is `SKY_BEAM_DRIVE`'s,
 * which is where the real constraint is written down. Every one of these has one
 * channel at about 1.2 and the others at a few per cent, so one number scales the
 * whole table without any hue moving relative to another -- which is what made
 * re-levelling this feature three times a matter of editing one constant rather
 * than twelve triples.
 *
 * The four are not four random triples. They are four *looks*:
 *
 *   0. **Magenta / cyan / white.** The default warehouse rig, and the one that
 *      reads best against a corrugated shed at 300 m.
 *   1. **Amber / deep red / green.** A bush doof. Warm, and the only palette
 *      whose brightest hue is not blue, which matters under a tree canopy where
 *      everything else is already blue-black.
 *   2. **Ultraviolet / lime / white.** The one that makes the glow sticks read,
 *      because a violet wash on a night scene is nearly invisible on its own and
 *      is entirely visible on the things it is lighting.
 *   3. **Cyan / blue / magenta.** Cold, and the right one under a concrete
 *      soffit where the bounce is grey.
 *
 * ---------------------------------------------------------------------------
 * **THEY ARE NEARLY MONOCHROMATIC ON PURPOSE, AND THE FIRST CUT WAS NOT.**
 *
 * The version of this table that was written before anybody looked at it kept
 * 8-12% of the off-channels in every hue -- magenta at (1.25, 0.09, 0.85), lime
 * at (0.55, 1.20, 0.08) -- on the reasoning that a real lantern's gel is not a
 * laser line. That is true of the *gel* and false of what arrives at the eye:
 * three overlapping beam planes add three times every channel **in sRGB** (see
 * `SKY_BEAM_DRIVE`), and a hue that starts at 46% saturation ends at 20%. Twelve
 * fixtures of that read as a rig with white lanterns in it, which is exactly
 * what came out.
 *
 * So the off-channels are now a few per cent, and the one genuinely white entry
 * is in palette 2 and is deliberate -- **open white is a real look on a real
 * rig**, and having exactly one fixture in twelve running open is what stops the
 * rest reading as a colour wheel. `verifyRaveKit` bounds the brightest channel
 * from both ends; nothing bounds the saturation, because the white entry would
 * fail it.
 */
const PALETTES: ReadonlyArray<readonly Rgb[]> = [
  [[1.20, 0.04, 0.72], [0.03, 1.00, 1.20], [0.08, 0.18, 1.22]],
  [[1.22, 0.40, 0.02], [1.18, 0.02, 0.05], [0.04, 1.16, 0.16]],
  [[0.48, 0.05, 1.25], [0.38, 1.20, 0.03], [0.92, 0.88, 1.02]],
  [[0.03, 1.05, 1.24], [0.06, 0.22, 1.26], [1.16, 0.04, 0.66]],
];

/**
 * What a laser is made of. Hotter and narrower in hue than a beam.
 *
 * A laser is a *line*, three or four pixels wide at any range anyone sees one,
 * and the whole reason it reads as a laser rather than as a thin beam is that it
 * is nearly monochromatic and nearly clipping. So a blade's two crossed planes
 * are driven to just over 1 in sRGB where they cross — **deliberately clipped**,
 * because a blown core with coloured edges is exactly what a laser looks like —
 * where a beam's three planes are held just under it. That is the one place in
 * this file where saturating the output is the intended result rather than the
 * failure mode, and `SKY_BEAM_DRIVE` sets out the arithmetic both are measured
 * in.
 */
const LASER_GAIN = 0.26;

/**
 * How hard a beam is driven, as a multiplier on its palette hue.
 *
 * ---------------------------------------------------------------------------
 * **AN ADDITIVE SURFACE IN THIS RENDERER BLENDS IN sRGB, NOT IN SCENE-LINEAR,
 * AND EVERY NUMBER IN THIS FILE IS DECIDED BY THAT.**
 *
 * It is the single most consequential fact about the whole feature and it took
 * three passes of looking at a rave rendered entirely in white to find it, so it
 * is written down here in full.
 *
 * Three's WebGPU backend applies tone mapping and the output colour-space
 * transform **inside each material's fragment shader** (`NodeMaterial`'s output
 * chain), not in a post pass over the finished frame. The blend hardware
 * therefore runs *after* both: what `AdditiveBlending` adds is not two
 * radiometric quantities, it is two **display values**. Three overlapping beam
 * planes at an sRGB 0.55 each do not sum to a slightly brighter colour — they
 * sum to 1.65 and clip to white, in every channel that was non-zero.
 *
 * That inverts the intuition this file was written with. Reasoning in
 * scene-linear says "the tone curve desaturates past 3, so stay under it"; the
 * truth is that **the tone curve has already been applied** and the only budget
 * that matters is that *N* overlapping surfaces must sum to under 1 in sRGB. For
 * a three-plane beam that is about 0.33 each, which is a scene-linear value of
 * roughly 0.145 through `EXPOSURE`, which for a hue whose brightest channel is
 * 1.2 is a drive of **0.12**.
 *
 * So these are an order of magnitude below what a first-principles argument from
 * `world/bike.ts` produces — and the bike is not wrong, it is *solving a
 * different problem*: a lime beacon has one dominant channel and is meant to go
 * near-white-green at its core against a daylit sky, and its own comment says
 * so. A rave has to stay magenta, which means each plane has to leave room for
 * the two behind it.
 *
 * 0.20 for the sky beams and 0.15 for the crowd ones. The flanks of a beam,
 * where only one plane covers, land near sRGB 0.35 — a soft coloured shaft — and
 * the core, where all three cross, lands just under 1 with the hue intact. The
 * sky beams run slightly hotter because they are four pixels wide at 900 m and
 * nothing else about them is negotiable; see `BEAM_RANGE`.
 */
const SKY_BEAM_DRIVE = 0.20;
const CROWD_BEAM_DRIVE = 0.15;

/**
 * How bright an attendee's glow sticks are, on top of the per-person swing.
 *
 * `SKY_BEAM_DRIVE`'s arithmetic again, with a different overlap count: the
 * sticks and the loop are single surfaces and the halo is two crossed planes, so
 * the budget is looser than a beam's — but forty people standing close together
 * is forty haloes overlapping in screen space at the back of a crowd, which is
 * the case that clips. 0.45 keeps a stick reading as a hot dot in somebody's
 * hand and a crowd of them reading as a field of separate lights rather than as
 * one white smear.
 */
const GLOW_DRIVE = 0.62;

/**
 * How bright a strobe frame is, over the whole haze volume.
 *
 * A fifth of what it started at, for `SKY_BEAM_DRIVE`'s reason and then some:
 * five stacked discs up to 90 m across, all at once, is the largest additive
 * area this feature ever draws, and at 0.5 it did not read as a strobe -- it
 * read as the frame being replaced by a white rectangle. 0.14 across five slabs
 * is 0.7 summed at the centre, which against a night street is a hard flash and
 * against the beams already in it is the beams *disappearing into* the flash,
 * which is exactly what a xenon tube does to a room.
 */
const STROBE_DRIVE = 0.09;

/**
 * How dim a haze slab is, how far across, and how low the lowest one sits.
 *
 * **All three of these were wrong on the first pass in the same way, and it is
 * the most useful thing this file learned by being looked at.** The slabs were
 * 90 m across, starting 0.7 m off the ground, at 0.045 of a palette hue — and
 * standing on the dancefloor put the camera *inside* a stack of five horizontal
 * discs each of which filled the upper half of the frame with a flat grey sheet.
 * It did not read as haze. It read as the sky having been replaced.
 *
 * The mistake was treating them as the volumetric effect. **They are not**: the
 * beams are already volumes -- crossed planes with a gradient is a shaft of
 * light through air, which is the whole of the additive-planes idiom -- and what
 * the slabs add is the *milkiness the beams pass through*, which is a term you
 * are supposed to notice only where a beam crosses it.
 *
 * So: 22 m across rather than 90, which puts them over the dancefloor instead of
 * over the player; **2.4 m up rather than 0.7**, so a person walks *under* the
 * stack and sees it as a lit ceiling of air rather than through the middle of
 * it; and 0.012, which against a sky beam's 2.6 core is a two-hundredth --
 * invisible alone and clearly visible as the thing the beam brightens.
 */
const HAZE_DRIVE = 0.011;
const HAZE_MAX_RADIUS = 22;
const HAZE_FLOOR = 2.4;

/**
 * The six colours an attendee can be wearing, **linear**.
 *
 * Glow-stick colours, which is a real and short list: they are chemiluminescent
 * and there are about six dyes. Green is over-represented because it always is —
 * it is the brightest per unit of dye and it is what comes in the packet of a
 * hundred.
 */
const GLOW_COLOURS: readonly Rgb[] = [
  [0.18, 1.35, 0.22],   // green, and there are more of these than anything else
  [0.18, 1.30, 0.30],   // green again, a touch yellower
  [1.15, 0.22, 0.55],   // pink
  [0.15, 0.55, 1.30],   // blue
  [1.25, 0.75, 0.08],   // orange
  [0.85, 0.20, 1.20],   // violet
];

/**
 * How bright the house lights are when the police arrive, **linear**, and why
 * they are white.
 *
 * The single most legible thing that can happen at a rave is the house lights
 * coming up. It is not a fade and it is not a colour: it is flat, white,
 * unflattering work light, and every person in the room knows instantly what it
 * means. `game/rave.ts` publishes `RAVE_STAGE.BUSTED` rather than a low
 * intensity precisely so this can be a *different* look rather than a dimmer
 * one.
 */
const HOUSE_LIGHT: Rgb = [1.0, 0.98, 0.92];

/** The work light during load-in and pack-up. A single warm site lamp. */
const WORK_LIGHT: Rgb = [1.2, 0.85, 0.42];

// --- Geometry -----------------------------------------------------------------------

/** Accumulates triangles into one indexed geometry with a colour per vertex. */
class Builder {
  readonly position: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  vertex(x: number, y: number, z: number, c: number): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.colour.push(c, c, c);
    return i;
  }

  /**
   * A quad, wound **both ways**.
   *
   * `world/bike.ts`'s trick and its argument: an additive surface has no back,
   * so writing both windings into one geometry lets the material stay
   * `FrontSide` — which halves nothing and costs nothing, but means the same
   * material can be shared with things that genuinely are one-sided, and means
   * a driver's back-face cull still throws away half the triangles of every
   * plane that is edge-on.
   */
  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
    this.index.push(a, c, b, a, d, c);
  }

  /** A quad, one winding only. For anything lit, where a back face is a bug. */
  face(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  build(name: string, normals: boolean): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colour), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    if (normals) g.computeVertexNormals();
    else {
      // Additive geometry is never lit and never in a depth pass, so a normal is
      // dead weight in the vertex buffer -- but `RenderObject.getGeometryCacheKey`
      // reads the attribute *names*, so leaving it off is also what keeps these
      // geometries keying differently from the lit ones and sharing nothing they
      // should not.
    }
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The beam: a tapered column of crossed planes standing on +Y, with the lamp's
 * own face glowing at the foot.
 *
 * Three planes at 60 degrees, which is `world/bike.ts`'s finding and its
 * reasoning: two cross at 90 and go nearly edge-on twice per half turn, three
 * never leave a gap, and the additive sum of the projected widths swings 1.73 to
 * 2.73 of one plane's across a full turn — a soft flicker that reads as a beam
 * breathing rather than as a fault, and which here is *desirable*, because a
 * moving head genuinely does flare and thin as it sweeps past you.
 *
 * Unit length along +Y so the instance matrix can scale it: `scale.y` is the
 * throw and `scale.x = scale.z` is the width, which fixes the taper ratio at
 * `BEAM_W1 / BEAM_W0` for every fixture. That is not a compromise — a real
 * lantern's beam angle is a property of the lantern, so every fixture on one
 * truss flaring by the same ratio is correct.
 *
 * ---------------------------------------------------------------------------
 * THE GRADIENT IS FRONT-LOADED AND BOTH ENDS REACH EXACTLY ZERO, and both of
 * those are lessons this project has already paid for once.
 *
 * `bike.BEAM_STOPS` records the first: under `NeutralToneMapping` a gently
 * ramped brightness compresses at the top, so 0.78 and 1.0 land within a few
 * sRGB steps and the whole visible gradient crams into the last quarter — a hard
 * edge, not a fade. So the brightness is spent early, where the curve is still
 * steep.
 *
 * The zero at the tip is what stops a beam being a bar ruled across the sky with
 * a visible top; the zero at the foot is subtler and matters more here than it
 * did for the bike, because a player *stands under this one*. A plane's foot is
 * a straight cut, and at any brightness above zero you can read the three
 * rectangles the column is made of from directly beneath it. Ramping from
 * nothing over the first two per cent puts that cut where an additive blend
 * cannot show it, and the lamp face below fills the hole.
 */
const BEAM_W0 = 0.5;
const BEAM_W1 = 1.15;
const BEAM_PLANES = 3;
const BEAM_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.02, 0.55],
  [0.07, 1],
  [0.24, 0.74],
  [0.52, 0.44],
  [0.8, 0.18],
  [1, 0],
];

function buildBeam(): BufferGeometry {
  const m = new Builder();
  for (let p = 0; p < BEAM_PLANES; p++) {
    const a = (p * Math.PI) / BEAM_PLANES;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let prevL = -1;
    let prevR = -1;
    for (const [t, b] of BEAM_STOPS) {
      const w = BEAM_W0 + (BEAM_W1 - BEAM_W0) * t;
      const l = m.vertex(-dx * w, t, -dz * w, b);
      const r = m.vertex(dx * w, t, dz * w, b);
      if (prevL >= 0) m.quad(prevL, prevR, r, l);
      prevL = l;
      prevR = r;
    }
  }
  // The lamp face: two crossed quads at the foot, small and at full brightness,
  // so the light reads as coming *out of a fixture* from any angle. This is the
  // set `world/bike.ts` would have called the glow disc; folding it in here is
  // one instanced set the frame does not pay for. See section 2.
  const FACE = 0.42;
  for (let p = 0; p < 2; p++) {
    const a = (p * Math.PI) / 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const bl = m.vertex(-dx * FACE, -FACE * 0.5, -dz * FACE, 0);
    const br = m.vertex(dx * FACE, -FACE * 0.5, dz * FACE, 0);
    const tr = m.vertex(dx * FACE, FACE * 0.7, dz * FACE, 0.35);
    const tl = m.vertex(-dx * FACE, FACE * 0.7, -dz * FACE, 0.35);
    // A bright core across the middle rather than a flat card, so the face has a
    // hot centre and a soft edge with four vertices instead of a texture.
    const cl = m.vertex(-dx * FACE * 0.35, 0, -dz * FACE * 0.35, 1.35);
    const cr = m.vertex(dx * FACE * 0.35, 0, dz * FACE * 0.35, 1.35);
    m.quad(bl, br, cr, cl);
    m.quad(cl, cr, tr, tl);
  }
  return m.build('rave:beam', false);
}

/**
 * The laser fan: eleven blades from one point, spread across an arc.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAN AND NOT A BEAM WITH A DIFFERENT COLOUR.
 *
 * A laser at a rave is never one line. It is a *fan* — a single beam swept by a
 * mirror faster than the eye can follow, which the eye therefore integrates into
 * a sheet of separate rays — and the reason it is the thing people photograph is
 * that the rays are individually thin and collectively wide. That is a shape,
 * not a colour, and it cannot be got by tinting a beam.
 *
 * Eleven blades over 70 degrees. Odd, so there is a blade on the axis; eleven
 * rather than seven because the gap between rays at the far end is what makes it
 * read as a fan rather than as a grille, and at 40 m a 7-degree gap is 4.9 m,
 * which is a person's width times three. Each blade is two crossed quads for
 * `buildBeam`'s reason at a quarter of the count, because a blade seen edge-on
 * is a laser that flickers off.
 *
 * The blades **taper to a point at the apex and hold their width to the tip**,
 * which is the opposite of the beam and is correct: a beam diverges because the
 * lantern's optics diverge, and a laser does not diverge at all — what widens
 * with distance in a real fan is the *spacing*, which the geometry already does.
 */
const LASER_BLADES: number = 9;
const LASER_ARC = 0.42; // radians of half-spread, so 48 degrees across
const LASER_HALF_WIDTH = 0.0013;

function buildLaser(): BufferGeometry {
  const m = new Builder();
  for (let b = 0; b < LASER_BLADES; b++) {
    const a = LASER_BLADES === 1 ? 0 : (b / (LASER_BLADES - 1) - 0.5) * 2 * LASER_ARC;
    // The blade's direction, in the local XY plane, radiating from the origin.
    const ux = Math.sin(a);
    const uy = Math.cos(a);
    // Two crossed quads about that direction: one in the fan's plane, one
    // perpendicular to it.
    for (let plane = 0; plane < 2; plane++) {
      // Perpendicular within the fan's plane, or straight out of it.
      const px = plane === 0 ? uy : 0;
      const py = plane === 0 ? -ux : 0;
      const pz = plane === 0 ? 0 : 1;
      const w = LASER_HALF_WIDTH;
      const apex = m.vertex(0, 0, 0, 1.4);
      const l1 = m.vertex(ux * 0.12 - px * w, uy * 0.12 - py * w, -pz * w, 1.2);
      const r1 = m.vertex(ux * 0.12 + px * w, uy * 0.12 + py * w, pz * w, 1.2);
      const l2 = m.vertex(ux * 0.88 - px * w, uy * 0.88 - py * w, -pz * w, 0.68);
      const r2 = m.vertex(ux * 0.88 + px * w, uy * 0.88 + py * w, pz * w, 0.68);
      // The last stop is exactly zero, which under an additive blend is what an
      // end is. A ray that stopped at 0.3 would be a line with a cut across it.
      const tip = m.vertex(ux, uy, 0, 0);
      m.index.push(apex, l1, r1, apex, r1, l1);
      m.quad(l1, r1, r2, l2);
      m.index.push(l2, r2, tip, l2, tip, r2);
    }
  }
  return m.build('rave:laser', false);
}

/**
 * A haze slab: a horizontal disc, bright at the middle, zero at the rim.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HAZE IS ACTUALLY FOR, AND IT IS NOT THE HAZE.
 *
 * The beams above are *already* the volumetric effect — crossed planes with a
 * gradient are a shaft of light through air, which is what the whole
 * additive-planes idiom buys. What they are not is *connected to the ground*.
 * A beam sweeping across a dancefloor with nothing between it and the dirt is a
 * clean triangle of light hanging in a vacuum, and the tell is that the air
 * around it is empty.
 *
 * So: five soft discs at head height and above, very dim, slowly counter-
 * rotating, sitting *through* the beams. The beams pass into them and the sum is
 * brighter where a beam is inside a slab, which is exactly the milkiness a
 * hazer produces and which no amount of work on the beam alone can fake. It is
 * five draws.
 *
 * They are also what the **strobe** is made of. A strobe is not a light, it is
 * the whole volume of the room going white for eight milliseconds, and driving
 * these five discs to `HOUSE_LIGHT` for two frames is precisely that, for no
 * extra set. See section 2.
 *
 * Sixteen segments: at the sizes these are drawn a disc's silhouette is never
 * seen — the rim is at zero — so segments buy nothing but the gradient's
 * smoothness, and sixteen is where a radial ramp stops showing facets.
 */
const HAZE_SEGMENTS = 16;

function buildHaze(): BufferGeometry {
  const m = new Builder();
  const centre = m.vertex(0, 0, 0, 1);
  // A middle ring at half radius holds most of the brightness out from the
  // centre, so the slab reads as a body of air rather than as a hotspot with a
  // long tail -- `bike.GLOW_FALLOFF`'s lesson about where a gradient is spent.
  const mid: number[] = [];
  const rim: number[] = [];
  for (let s = 0; s < HAZE_SEGMENTS; s++) {
    const a = (s / HAZE_SEGMENTS) * Math.PI * 2;
    mid.push(m.vertex(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5, 0.62));
    rim.push(m.vertex(Math.cos(a), 0, Math.sin(a), 0));
  }
  for (let s = 0; s < HAZE_SEGMENTS; s++) {
    const n = (s + 1) % HAZE_SEGMENTS;
    m.index.push(centre, mid[s], mid[n], centre, mid[n], mid[s]);
    m.quad(mid[s], rim[s], rim[n], mid[n]);
  }
  return m.build('rave:haze', false);
}

/**
 * What an attendee is wearing: two glow sticks, an EL-wire loop and a halo.
 *
 * Built in the **figure's own frame**, origin at the feet and facing -Z, which
 * is `world/people.ts`' convention — so one instance transform per attendee puts
 * all of it on the right body, yawed the right way, bobbing with them. That is
 * the whole trick: the glow is not a separate system that has to be told where
 * everybody is, it is a second thing drawn at the same matrix.
 *
 * Three components, and each is doing a different job at a different distance:
 *
 *   - **The sticks**, at the hands. Two small crossed bars at `HAND_Y`. These
 *     are what read *close up* — the thing you can see somebody holding.
 *   - **The loop**, a thin ring round the chest. This is what reads at twenty
 *     metres: a ring is the one shape that stays the same width whichever way
 *     the body is turned, so a crowd of them does not flicker as people move.
 *   - **The halo**, a soft crossed pair of quads over the torso at a tenth of
 *     the brightness. This is what reads at *two hundred*, where the sticks and
 *     the loop are each under a pixel and would alias into a sparkle. It is the
 *     component that turns forty people into a field of light.
 */
const HAND_Y = 0.95;
const CHEST_Y = 1.16;

function buildGlow(): BufferGeometry {
  const m = new Builder();

  // The sticks: a 16 cm bar at each hand, crossed so it never disappears.
  for (const side of [-1, 1]) {
    for (let plane = 0; plane < 2; plane++) {
      const dx = plane === 0 ? 0.02 : 0;
      const dz = plane === 0 ? 0 : 0.02;
      const x = side * 0.2;
      const a = m.vertex(x - dx, HAND_Y - 0.09, -dz, 0.2);
      const b = m.vertex(x + dx, HAND_Y - 0.09, dz, 0.2);
      const c = m.vertex(x + dx, HAND_Y + 0.09, dz, 1.5);
      const d = m.vertex(x - dx, HAND_Y + 0.09, -dz, 1.5);
      m.quad(a, b, c, d);
    }
  }

  // The loop: a 12-sided ring round the chest, 1 cm of section, so it is a wire
  // and not a hoop.
  const RING_R = 0.2;
  const RING_SEG = 12;
  {
    const lower: number[] = [];
    const upper: number[] = [];
    for (let s = 0; s < RING_SEG; s++) {
      const a = (s / RING_SEG) * Math.PI * 2;
      lower.push(m.vertex(Math.cos(a) * RING_R, CHEST_Y - 0.012, Math.sin(a) * RING_R * 0.62, 1.25));
      upper.push(m.vertex(Math.cos(a) * RING_R, CHEST_Y + 0.012, Math.sin(a) * RING_R * 0.62, 1.25));
    }
    for (let s = 0; s < RING_SEG; s++) {
      const n = (s + 1) % RING_SEG;
      m.quad(lower[s], lower[n], upper[n], upper[s]);
    }
  }

  // The halo: the long-range component. Dim, wide, and crossed.
  for (let plane = 0; plane < 2; plane++) {
    const dx = plane === 0 ? 0.42 : 0;
    const dz = plane === 0 ? 0 : 0.42;
    const a = m.vertex(-dx, CHEST_Y - 0.5, -dz, 0);
    const b = m.vertex(dx, CHEST_Y - 0.5, dz, 0);
    const c = m.vertex(dx, CHEST_Y + 0.5, dz, 0);
    const d = m.vertex(-dx, CHEST_Y + 0.5, -dz, 0);
    const l = m.vertex(-dx * 0.4, CHEST_Y, -dz * 0.4, 0.3);
    const r = m.vertex(dx * 0.4, CHEST_Y, dz * 0.4, 0.3);
    m.quad(a, b, r, l);
    m.quad(l, r, c, d);
  }

  return m.build('rave:glow', false);
}

/**
 * The unit box every physical thing in the rig is made of. See section 2.
 *
 * One geometry, 1 m on a side, centred on its own origin — so a scale of
 * `(0.9, 0.55, 0.6)` is a speaker box and one of `(11, 0.16, 0.16)` is the
 * truss's top chord. Flat-shaded and indexed, `world/cars.ts`' argument: baking
 * face normals into a non-indexed geometry triples the vertex count for an
 * identical image.
 */
function buildBox(): BufferGeometry {
  const m = new Builder();
  const corners: ReadonlyArray<readonly [number, number, number]> = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const faces: ReadonlyArray<readonly [number, number, number, number]> = [
    [4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4],
  ];
  const idx: number[] = [];
  for (const [x, y, z] of corners) idx.push(m.vertex(x * 0.5, y * 0.5, z * 0.5, 1));
  for (const [a, b, c, d] of faces) m.face(idx[a], idx[b], idx[c], idx[d]);
  return m.build('rave:structure', true);
}

/**
 * One piece of the morning after: a flat quad lying on the ground.
 *
 * A unit square in XZ, one-sided and facing up, because nobody sees the
 * underside of a flattened can. Instanced small and rotated it is a bottle, a
 * can, a flyer or a cable tie; instanced large and dark it is the scorch where
 * somebody burned a pallet.
 */
function buildLitter(): BufferGeometry {
  const m = new Builder();
  const a = m.vertex(-0.5, 0, -0.5, 1);
  const b = m.vertex(0.5, 0, -0.5, 1);
  const c = m.vertex(0.5, 0, 0.5, 1);
  const d = m.vertex(-0.5, 0, 0.5, 1);
  m.face(a, d, c, b);
  return m.build('rave:litter', true);
}

/** The booth's banner: a unit quad in XY with UVs, for the canvas texture. */
function buildBanner(): BufferGeometry {
  const g = new BufferGeometry();
  g.name = 'rave:banner';
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
  );
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.computeBoundingSphere();
  return g;
}

// --- The assets --------------------------------------------------------------------

/** The banner's canvas, in pixels. One row of text, wide. */
const BANNER_W = 512;
const BANNER_H = 96;

/**
 * Every geometry and material a rave is drawn with. Built once, at boot, before
 * the warm-up. Six materials and seven geometries for the whole feature.
 */
export class RaveAssets {
  /** Additive, shared by the beams, the lasers, the haze and the glow. */
  readonly emissive: MeshBasicNodeMaterial;
  /** Lit. The truss, the boxes, the pallets, and the litter. */
  readonly solid: MeshStandardNodeMaterial;
  /** The banner's own, because it is the one thing here with a texture. */
  readonly bannerMaterial: MeshBasicNodeMaterial;

  readonly beam: BufferGeometry;
  readonly laser: BufferGeometry;
  readonly haze: BufferGeometry;
  readonly glow: BufferGeometry;
  readonly box: BufferGeometry;
  readonly litter: BufferGeometry;
  readonly banner: BufferGeometry;

  readonly bannerCanvas: HTMLCanvasElement | null;
  readonly bannerTexture: CanvasTexture | null;
  private readonly bannerCtx: CanvasRenderingContext2D | null;
  private bannerText = '';

  /** Triangles in one rig at full draw. Reported by the diagnostics line. */
  readonly triangles: number;

  constructor() {
    this.beam = buildBeam();
    this.laser = buildLaser();
    this.haze = buildHaze();
    this.glow = buildGlow();
    this.box = buildBox();
    this.litter = buildLitter();
    this.banner = buildBanner();

    // --- The additive material. See section 3: no colour node, no TSL, nothing
    // touched after construction. `NodeMaterial` multiplies material colour by
    // the vertex colour and then by `instanceColor` on its own, which is the
    // gradient times the hue and is the whole shader.
    const emissive = new MeshBasicNodeMaterial();
    emissive.name = 'rave:emissive';
    emissive.vertexColors = true;
    emissive.color = new Color(1, 1, 1);
    emissive.transparent = true;
    emissive.blending = AdditiveBlending;
    // Off, so a beam never occludes the beam behind it, never occludes the
    // crowd standing in it, and never leaves a hole where a dancer walks
    // through one. `world/bike.ts` argues this at length and the argument is
    // stronger here, where sixteen of these overlap by design.
    emissive.depthWrite = false;
    // **On**, and this is the one real decision in the material. Off is
    // tempting -- it guarantees a beam is never hidden -- and it is wrong three
    // times over, all of which `world/bike.ts` measured: it draws every beam
    // through the terrain, so a rave behind a hill paints magenta up the face of
    // the hill; it draws them through the road you are standing on; and sixteen
    // of them composited over everything is a wash on the whole frame rather
    // than a findable object. On, the shed in front of the rig clips the bottom
    // of the beam and the top stands clear over the roofline, which **is** the
    // read the whole feature depends on.
    emissive.depthTest = true;
    emissive.side = FrontSide;
    emissive.fog = false;
    this.emissive = emissive;

    // --- The lit material. At night this is a silhouette lit by the player's
    // torch and by nothing else, which is exactly right: walking up to a rave
    // and finding a stack of speakers in your torch beam is the moment the
    // thing stops being a light show and becomes an object.
    const solid = new MeshStandardNodeMaterial();
    solid.name = 'rave:structure';
    solid.vertexColors = true;
    solid.color = new Color(1, 1, 1);
    // Powder-coated steel and painted ply. Not as matte as foliage, nowhere near
    // car paint.
    solid.roughness = 0.72;
    solid.metalness = 0.05;
    solid.flatShading = true;
    this.solid = solid;

    // --- The banner. A canvas texture rather than the nameplate atlas, and the
    // reason is that they are different problems: `world/nameplates.ts` holds
    // sixteen names that change independently and therefore needs an atlas with
    // slot management, and this is **one line of text that changes when the
    // record does**. One 512x96 canvas, redrawn on a mix -- five or six times a
    // night -- is a few hundred microseconds and no bookkeeping at all.
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (canvas) {
      canvas.width = BANNER_W;
      canvas.height = BANNER_H;
    }
    this.bannerCanvas = canvas;
    this.bannerCtx = canvas ? canvas.getContext('2d') : null;
    const texture = canvas ? new CanvasTexture(canvas) : null;
    if (texture) {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 4;
    }
    this.bannerTexture = texture;

    const bannerMaterial = new MeshBasicNodeMaterial();
    bannerMaterial.name = 'rave:banner';
    if (texture) bannerMaterial.map = texture;
    bannerMaterial.transparent = true;
    bannerMaterial.blending = AdditiveBlending;
    bannerMaterial.depthWrite = false;
    // Both sides: the banner faces the crowd, and a player who walks round the
    // back of the booth should see it through the ply rather than see nothing.
    // A one-sided banner is the classic "the sign disappeared" bug.
    bannerMaterial.side = DoubleSide;
    bannerMaterial.fog = false;
    this.bannerMaterial = bannerMaterial;
    this.setBanner('');

    const tris = (g: BufferGeometry): number => (g.getIndex()?.count ?? 0) / 3;
    this.triangles =
      tris(this.beam) * FIXTURES +
      tris(this.laser) * LASERS +
      tris(this.haze) * HAZE_SLABS +
      tris(this.box) * STRUCTURE_PIECES;
  }

  /**
   * Draw the decks' line, if it has changed.
   *
   * Guarded on the text rather than called unconditionally, because the cost of
   * this is not the drawing — it is `texture.needsUpdate`, which re-uploads
   * 192 kB. Once per mix is nothing; sixty times a second is a streaming stall
   * that would look like the network. `world/nameplates.ts` documents the same
   * trap from the other side.
   */
  setBanner(text: string): void {
    if (text === this.bannerText) return;
    this.bannerText = text;
    const ctx = this.bannerCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, BANNER_W, BANNER_H);
    if (text.length === 0) {
      if (this.bannerTexture) this.bannerTexture.needsUpdate = true;
      return;
    }
    // An LED strip: a dark bar, a scanline grid, and the text knocked out in the
    // amber every cheap dot-matrix sign in the world uses. Additive, so the dark
    // bar contributes nothing and only the lit dots are seen -- which is what a
    // real one looks like at night and is why the material blends this way.
    ctx.font = `600 ${Math.round(BANNER_H * 0.52)}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = BANNER_H * 0.52;
    // Shrink to fit rather than clip: a long title is a real case (the user's
    // own filenames are short, but "Artist — Title" is not) and a clipped one
    // reads as a bug in the sign rather than as a long name.
    while (size > 12 && ctx.measureText(text).width > BANNER_W - 40) {
      size -= 2;
      ctx.font = `600 ${Math.round(size)}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    }
    ctx.fillStyle = 'rgba(255, 176, 54, 1)';
    ctx.fillText(text, BANNER_W / 2, BANNER_H / 2);
    // The scanlines, cut *out* of what was just drawn, so the text is made of
    // rows of dots rather than of strokes. Two pixels on, one off.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let y = 0; y < BANNER_H; y += 3) ctx.fillRect(0, y, BANNER_W, 1);
    ctx.globalCompositeOperation = 'source-over';
    if (this.bannerTexture) this.bannerTexture.needsUpdate = true;
  }
}

/**
 * What the boot warm-up can compile, which is the banner and nothing else.
 *
 * Everything else in this file is an `InstancedMesh` and **cannot be warmed by a
 * stand-in at all** — three keys an instanced draw on `object.uuid`, so a
 * throwaway mesh compiles a pipeline nothing ever draws. The twelve real sets
 * are covered by `main.ts`'s scene pass, which walks the actual scene before the
 * first frame; they are in the scene from boot and `frustumCulled = false`, which
 * is what makes that walk reach them. See `world/warmup.ts` and section 2 above.
 *
 * The banner is genuinely ordinary and would genuinely compile on the frame a
 * player first walked within `RIG_RANGE` of a rave, which is the frame it is
 * least affordable.
 */
export function raveWarmupParts(assets: RaveAssets): WarmupPart[] {
  return [
    {
      geometry: warmupGeometry({ uv: true }),
      material: assets.bannerMaterial,
      owned: true,
      casts: false,
      receives: [false],
    },
  ];
}

// --- The rig's layout ----------------------------------------------------------------

/** How high the truss stands over the dancefloor, and how wide, metres. */
const TRUSS_HEIGHT = 5.2;
/**
 * Under a viaduct the truss is **low**, because there is a concrete soffit
 * overhead and a 5.2 m goalpost would be inside it.
 *
 * 3.4 m clears a person with a metre to spare and is under every road deck's
 * soffit in the city — the decks round solves them at their touchdowns and the
 * lowest urban overbridge clearance in NSW is 4.3 m. The consequence is not a
 * compromise, it is the *character* of an under-bridge rave: the beams have
 * nowhere to go but sideways, so they rake across the crowd and splash on the
 * piers instead of standing up into the sky. It is why a bridge rave looks
 * different from a park one, and it costs one constant.
 */
const TRUSS_HEIGHT_SPAN = 3.4;
const TRUSS_HALF_WIDTH = 5.5;

/** Where the sky beams throw to and how wide, metres. See `BEAM_RANGE`. */
const SKY_BEAM_LENGTH = 62;
const SKY_BEAM_WIDTH = 0.85;
/**
 * And the ones that sweep the crowd. Short, narrow, fast.
 *
 * Narrow rather than wide, which is the opposite of the first cut and is the
 * lesson of looking at it: a 2.6 m wedge raking a crowd is not a light, it is a
 * *wall* passing through people, and forty metres of it reads as a white slab
 * lying across the yard. 1.4 m across at the tip is a lantern, and it is what
 * lets six of them cross without the middle of the rig going solid.
 */
const CROWD_BEAM_WIDTH = 0.62;

/**
 * How far a crowd fixture throws at most, metres.
 *
 * A moving head raking a dancefloor is aimed at the dancefloor, and a
 * dancefloor is thirty metres across. The first cut scaled the throw at 1.9x the
 * crowd's depth, which at Sydney Park is 78 m of beam thrown at a 41 m crowd --
 * so two thirds of every crowd beam was a white streak leaving the site and
 * lying across the suburb behind it. The cap is what keeps the light *on the
 * party*.
 */
const CROWD_BEAM_MAX_THROW = 34;

/** How far a laser fan throws, as a multiple of the crowd's depth. */
const LASER_REACH = 1.25;

/**
 * How far the scanner rolls the fan either side of level, radians.
 *
 * 0.62 rather than the 1.15 it started at, and the number is decided by the
 * ground rather than by taste: the fan is 48 degrees across, so its lower edge
 * sits `LASER_ARC + roll` below the throw axis, and past about 0.85 rad of that
 * the outer rays are pointing into the dirt twenty metres in front of the rig.
 * They are depth-tested, so what a player actually saw was rays that vanished
 * halfway along — which reads as the laser flickering rather than as it
 * scanning. 0.62 keeps the whole sheet in the air through the entire sweep.
 */
const LASER_ROLL = 0.62;

/**
 * How far above level the fan is thrown, radians.
 *
 * **Barely up, and the sign is the whole of it.** The first cut threw the fan
 * *down* at -0.16 on the reasoning that the light should land on the crowd; what
 * that produced was a projector aimed squarely at the face of anybody standing
 * at the back of it, filling half the frame with rays converging on the camera.
 * A real fan goes **over** the crowd -- it is mounted above head height and
 * thrown level, and what you see is the sheet passing above you, which is the
 * shot everybody has of a laser and is the one worth having.
 *
 * 0.03 rad from a 4.5 m hang is 6.4 m up at 60 m out: over the tallest person at
 * the back of the biggest crowd, with the whole sweep still inside the site.
 */
const LASER_TILT = 0.03;

// --- The renderer ---------------------------------------------------------------------

/** What one frame needs to know. Everything is the caller's; nothing is stored. */
export interface RaveFrame {
  /** Wall clock with the sky's own scrub applied. See `rave.raveNight`. */
  nowMs: number;
  /** Frame delta, seconds. Only the skinned dancers read it. */
  dt: number;
  /** The player. */
  x: number;
  z: number;
  /** `skyClock().night`: 0 in daylight, 1 once night has arrived. */
  night: number;
  /** Terrain height, never a roof. `main.ts`'s `wildGround`. */
  ground: (x: number, z: number) => number;
  /** Is there a building here? `main.ts`'s collision query, or null. */
  solid: RaveSolid;
  /** The record bag, for the banner. */
  bag: RecordBag;
}

/** What the audio, the HUD and the big map need to know about the nearest rave. */
export interface NearestRave {
  readonly venue: RaveVenue;
  /** Metres, horizontal, from the player to the booth. */
  readonly distance: number;
  /** Where the booth is, so the mixer can pan and the map can pin. */
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** What it is doing right now. `game/rave.ts`'s own state. */
  readonly stage: number;
  readonly playing: boolean;
  readonly bpm: number;
  readonly position: SetPosition;
  readonly title: string;
  /** True while the police are shutting it down; `main.ts` barks on the edge. */
  readonly busted: boolean;
}

interface DrawnVenue {
  venue: RaveVenue;
  distance: number;
  boothX: number;
  boothZ: number;
  groundY: number;
}

interface RigSlot {
  actor: CharacterActor;
  /** Which attendee index of which site, or -1. */
  key: number;
  kit: number;
}

const _matrix = /*#__PURE__*/ new Matrix4();
const _position = /*#__PURE__*/ new Vector3();
const _scale = /*#__PURE__*/ new Vector3(1, 1, 1);
const _quaternion = /*#__PURE__*/ new Quaternion();
const _aim = /*#__PURE__*/ new Vector3();
const _colour = /*#__PURE__*/ new Color();
/** Handed to `setColorAt` once per set at construction; see the note there. */
const _white = /*#__PURE__*/ new Color(1, 1, 1);
const _up = /*#__PURE__*/ new Vector3(0, 1, 0);
const _feet = { x: 0, y: 0, z: 0 };
const _booth = { x: 0, z: 0 };

/**
 * One venue's crowd, solved once. See `RaveWorld.layoutFor` for why this exists
 * and what keeps it from being a stale-data bug.
 *
 * A structure of arrays rather than an array of records, `PedestrianCrowd`'s own
 * choice and for its reason: reading one field of sixty-four people touches one
 * contiguous run of memory, and building it allocates nine typed arrays once per
 * site rather than sixty-four objects every two seconds.
 */
interface CrowdLayout {
  night: number;
  /** Which frame it was solved on, for the refresh. */
  built: number;
  x: Float64Array;
  z: Float64Array;
  dx: Float64Array;
  dz: Float64Array;
  front: Float64Array;
  kit: Int32Array;
  glow: Int32Array;
  phase: Float64Array;
  ok: Uint8Array;
}

/**
 * How often a crowd layout is re-solved, in frames.
 *
 * Two seconds at 60 Hz. The layout is a pure function of the site and the night
 * *and of what the collision world knows*, and the last of those grows as tiles
 * stream in -- so a crowd solved the instant a site came into range was solved
 * against a world with no buildings in it. Re-solving on a slow clock is what
 * makes the cache correct rather than merely fast; see `layoutFor`.
 */
const LAYOUT_REFRESH = 120;

/**
 * Everything a rave draws, for every rave in view, in one object.
 *
 * `update` allocates nothing. The pose record, the drawn-venue list and the rig
 * slots are all built once and mutated, which is `PedestrianCrowd`'s own rule
 * and matters more here because this runs beside it.
 */
export class RaveWorld {
  /** Add every one of these to the scene, at boot, and never remove them. */
  readonly meshes: InstancedMesh[] = [];
  /** And these: the eight skinned dancers. */
  readonly rigs: CharacterActor[] = [];
  /** And this: the booth's LED banner. */
  readonly banner: Mesh;

  /** The nearest live rave, or null. Read by the mixer, the HUD and the map. */
  nearest: NearestRave | null = null;
  /** How many raves were filled this frame, and how many people in them. */
  drawn = 0;
  attendeesDrawn = 0;
  rigged = 0;
  beamsDrawn = 0;
  /** How long the whole update took, milliseconds. The number to watch. */
  costMs = 0;

  private readonly assets: RaveAssets;
  private readonly beams: InstancedMesh;
  private readonly lasers: InstancedMesh;
  private readonly hazes: InstancedMesh;
  private readonly glows: InstancedMesh;
  private readonly structures: InstancedMesh;
  private readonly litters: InstancedMesh;
  /** Six parts, in `world/people.ts`' own order. */
  private readonly peds: InstancedMesh[] = [];

  private readonly counts = [0, 0, 0, 0, 0, 0];
  private readonly kitGeometries: readonly BufferGeometry[];
  private readonly slots: RigSlot[] = [];
  private readonly drawnVenues: DrawnVenue[] = [];
  private readonly pose: AttendeePose = createAttendeePose();
  /** Ground under each drawn venue, cached by site id. See `groundFor`. */
  private readonly groundCache = new Map<number, number>();
  /** Where everybody is standing, cached by site id. See `layoutFor`. */
  private readonly layouts = new Map<number, CrowdLayout>();
  /** Frames drawn, the clock both caches age against. */
  private frames = 0;

  private nBeam = 0;
  private nLaser = 0;
  private nHaze = 0;
  private nGlow = 0;
  private nStructure = 0;
  private nLitter = 0;

  constructor(assets: RaveAssets, ped: PedestrianAssets, characters: CharacterAssets) {
    this.assets = assets;
    this.kitGeometries = characters.geometries;

    const make = (
      name: string,
      geometry: BufferGeometry,
      material: MeshBasicNodeMaterial | MeshStandardNodeMaterial,
      capacity: number,
      casts: boolean,
    ): InstancedMesh => {
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = name;
      mesh.count = 0;
      // Culled by range in the fill loop rather than by the frustum, which is
      // every instanced set in this project's rule: the bounding sphere of a set
      // whose contents change every frame would have to be recomputed every
      // frame, and a distance test the fill loop already does is free.
      mesh.frustumCulled = false;
      mesh.castShadow = casts;
      mesh.receiveShadow = casts;
      // Never owned by a tile and never freed by an eviction. A distinct flag
      // from `userData.pedestrians` so a change to the streamer's eviction can
      // not silently release these buffers.
      mesh.userData.rave = true;
      // ----------------------------------------------------------------------
      // **Allocate `instanceColor` NOW, in the constructor, before anything has
      // been compiled. This one line is the difference between a rave in colour
      // and a rave in white, and it cost three passes of retuning palettes that
      // were never being read.**
      //
      // `NodeMaterial.setupDiffuseColor` folds the per-instance tint into the
      // graph only `if ( object.instanceColor )` — it is a decision taken **when
      // the node graph is built**, not per frame. `InstancedMesh` creates that
      // attribute lazily, on the first `setColorAt`, and `main.ts`'s scene pass
      // compiles every instanced set in the world *before the first frame is
      // issued* precisely so nothing compiles during play. So a set whose
      // colours are written in `update` is compiled with `instanceColor === null`
      // and gets a shader that multiplies by the material colour and the vertex
      // colour and **silently drops the instance one forever**.
      //
      // The failure is completely invisible from the code: every colour in this
      // file is computed correctly, written correctly, and uploaded correctly to
      // a buffer nothing samples. What it looks like is a rig whose palettes are
      // all slightly wrong, which is exactly the kind of thing somebody spends an
      // afternoon retuning.
      //
      // One `setColorAt` in the constructor allocates the attribute (three fills
      // it with ones), so the graph is built with the multiply in it. It also
      // removes the *other* half of the trap: if three ever rebuilt the graph on
      // the frame the attribute appeared, that would be a pipeline compiled
      // inside a rendered frame, which is the one thing `PipelineWatch` exists to
      // forbid.
      mesh.setColorAt(0, _white);
      this.meshes.push(mesh);
      return mesh;
    };

    this.beams = make('rave_beams', assets.beam, assets.emissive, BEAM_CAPACITY, false);
    this.lasers = make('rave_lasers', assets.laser, assets.emissive, LASER_CAPACITY, false);
    this.hazes = make('rave_haze', assets.haze, assets.emissive, HAZE_CAPACITY, false);
    this.glows = make('rave_glow', assets.glow, assets.emissive, ATTENDEE_CAPACITY, false);
    this.structures = make('rave_structure', assets.box, assets.solid, STRUCTURE_CAPACITY, true);
    this.litters = make('rave_litter', assets.litter, assets.solid, LITTER_CAPACITY, false);

    for (const [name, geometry] of [
      ['torso', ped.torso], ['bare', ped.bare],
      ['shorts_l', ped.shorts], ['shin_l', ped.shin],
      ['shorts_r', ped.shorts], ['shin_r', ped.shin],
    ] as Array<[string, BufferGeometry]>) {
      this.peds.push(make(`rave_attendee_${name}`, geometry, ped.material, ATTENDEE_CAPACITY, true));
    }

    for (let i = 0; i < CROWD_RIG_CAPACITY; i++) {
      const actor = new CharacterActor(characters, i % COLOURWAYS.length);
      actor.mesh.name = `character:raver:${i}`;
      actor.mesh.visible = false;
      this.rigs.push(actor);
      this.slots.push({ actor, key: -1, kit: i % COLOURWAYS.length });
    }

    this.banner = new Mesh(assets.banner, assets.bannerMaterial);
    this.banner.name = 'rave_banner';
    this.banner.frustumCulled = false;
    this.banner.visible = false;
    this.banner.castShadow = false;
    this.banner.receiveShadow = false;
  }

  /**
   * Fill every buffer for this frame.
   *
   * The order matters in exactly one place: the drawn set is chosen first, so
   * everything after it is a loop over at most three venues and no test is
   * repeated. Everything else is independent.
   */
  update(frame: RaveFrame): void {
    const at = performance.now();
    this.nBeam = this.nLaser = this.nHaze = this.nGlow = this.nStructure = this.nLitter = 0;
    for (let p = 0; p < 6; p++) this.counts[p] = 0;
    this.attendeesDrawn = 0;
    this.nearest = null;

    this.chooseVenues(frame);

    for (const drawn of this.drawnVenues) {
      const state = raveState(drawn.venue, frame.nowMs);
      if (state.stage === RAVE_STAGE.GONE && state.litter <= 0) continue;

      // The night gate. Every emissive thing below is multiplied by this, and it
      // is `sky/cycle.ts`'s own darkness rather than a second ramp -- the same
      // number the street lamps, the lit windows and the torch already share.
      // Belt to `game/rave.ts`'s brace: even if the two clocks were rotated
      // apart, this makes the failure "a rave that is present and unlit" rather
      // than lasers over Alexandria at lunchtime. See section 6 of that file.
      const gate = frame.night;

      if (state.litter > 0) this.fillLitter(drawn, state.litter, frame);
      if (state.stage === RAVE_STAGE.GONE) {
        // The morning after, and the whole reason it is worth a branch: what is
        // left is not *nothing*. The truss came down but **one stack of speakers
        // is still standing in the middle of a yard at eleven in the morning**,
        // because whoever was bringing the truck has not turned up. It is the
        // detail the brief asked for by name and it costs one flag through a
        // function that already exists.
        this.fillStructure(drawn, RAVE_STAGE.GONE);
        continue;
      }

      this.fillStructure(drawn, state.stage);
      if (gate > 0.02) {
        this.fillRig(drawn, state, frame, gate);
      }
      if (drawn.distance < CROWD_RANGE) this.fillCrowd(drawn, state, frame, gate);
    }

    this.assign(frame);
    this.poseRigs(frame);
    this.flush();
    this.updateBanner(frame);

    this.drawn = this.drawnVenues.length;
    this.beamsDrawn = this.nBeam;
    this.costMs = performance.now() - at;
  }

  // --- Choosing what to draw --------------------------------------------------------

  /**
   * The nearest `MAX_DRAWN_VENUES` live raves inside `BEAM_RANGE`, and the
   * nearest one of all published for the mixer.
   *
   * An insertion sort over a list that is at most six long and is usually one.
   * `Array.prototype.sort` would allocate a comparator closure per frame for an
   * answer that is nearly always a single element.
   */
  private chooseVenues(frame: RaveFrame): void {
    this.drawnVenues.length = 0;
    const { index } = raveNight(frame.nowMs);
    const venues = liveRaves(index);
    const booth = { x: 0, z: 0 };

    for (const venue of venues) {
      boothPosition(venue, booth);
      const dx = booth.x - frame.x;
      const dz = booth.z - frame.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > BEAM_RANGE) continue;

      const groundY = this.groundFor(venue, booth.x, booth.z, frame);
      const entry: DrawnVenue = { venue, distance, boothX: booth.x, boothZ: booth.z, groundY };
      let at = this.drawnVenues.length;
      while (at > 0 && this.drawnVenues[at - 1].distance > distance) at--;
      this.drawnVenues.splice(at, 0, entry);
      if (this.drawnVenues.length > MAX_DRAWN_VENUES) this.drawnVenues.length = MAX_DRAWN_VENUES;
    }

    const first = this.drawnVenues[0];
    if (!first) return;
    const state = raveState(first.venue, frame.nowMs);
    if (state.stage === RAVE_STAGE.GONE) return;
    const position = setPosition(first.venue, frame.bag, frame.nowMs);
    this.nearest = {
      venue: first.venue,
      distance: first.distance,
      x: first.boothX,
      z: first.boothZ,
      y: first.groundY,
      stage: state.stage,
      playing: state.playing,
      bpm: venueBpm(first.venue, frame.bag, position),
      position,
      title: deckTitle(frame.bag, position),
      busted: state.stage === RAVE_STAGE.BUSTED,
    };
  }

  /**
   * How high the ground is under a venue, cached.
   *
   * A rave site is a *clear circle* — a truck apron, a clearing, a void under a
   * deck — so it is flat to within a step, and one sample at the booth is the
   * right answer for the whole of it. The cache exists because it is not: the
   * streamer may not have that tile yet, in which case `ground` answers the
   * player's last known height, and taking that as gospel would leave a whole
   * rig floating when the terrain arrived. So a sample is kept only once it is
   * finite and the tile is resident, and re-taken every `GROUND_RESAMPLE` frames
   * until it settles.
   */
  private groundFor(venue: RaveVenue, x: number, z: number, frame: RaveFrame): number {
    const cached = this.groundCache.get(venue.site.id);
    if (cached !== undefined && this.groundSettled % GROUND_RESAMPLE !== 0) return cached;
    const sampled = frame.ground(x, z);
    if (Number.isFinite(sampled)) {
      this.groundCache.set(venue.site.id, sampled);
      return sampled;
    }
    return cached ?? sampled;
  }

  private groundSettled = 0;

  /**
   * Where everybody at this venue is standing, solved once and kept.
   *
   * ---------------------------------------------------------------------------
   * **THIS IS THE ONLY REAL PERFORMANCE DECISION IN THE FILE, AND IT WAS FOUND
   * BY MEASURING RATHER THAN BY THINKING.**
   *
   * `game/rave.attendeeAt` offers each attendee up to four hashed positions and
   * takes the first that is not inside a building, which is what stops forty
   * people standing in the shipping container in the middle of a yard. That test
   * is `collision.roofHeight`, and calling it *per attendee per frame* costs
   * what a collision query costs: measured at **3.1 ms a frame** with 39 people
   * in view at Sydney Park, against a 0.39 ms budget for the whole night
   * lighting system. It was, by a factor of eight, the most expensive thing this
   * feature did.
   *
   * The fix is the observation the whole feature is built on: **a crowd's layout
   * is a pure function of the site and the night.** It does not change between
   * frames, so solving it every frame is solving the same problem 3,600 times a
   * minute. Solved once on arrival, it costs nothing at all.
   *
   * Three things make the cache honest rather than a stale-data bug:
   *
   *   - It is keyed on the **night** as well as the site, so a rave that runs
   *     past dusk into a second evening re-solves rather than inheriting
   *     yesterday's crowd.
   *   - It is re-solved every `LAYOUT_REFRESH` frames, because `solid` is not
   *     actually constant: the collision world fills in as tiles stream, so a
   *     layout solved the instant a site came into range was solved against a
   *     world with no buildings in it. Two seconds is fast enough that nobody
   *     watches a figure step out of a wall and slow enough that the query cost
   *     is a rounding error.
   *   - The **scatter is not baked in**. A bust pushes the crowd radially away
   *     from the booth, which is a transform of the cached position rather than
   *     a different layout — so the one part of this that genuinely changes every
   *     frame is the one part that is still computed every frame.
   */
  private layoutFor(venue: RaveVenue, drawn: DrawnVenue, frame: RaveFrame): CrowdLayout {
    let layout = this.layouts.get(venue.site.id);
    if (layout && layout.night === venue.night && this.frames - layout.built < LAYOUT_REFRESH) return layout;
    if (!layout) {
      layout = {
        night: venue.night,
        built: this.frames,
        x: new Float64Array(ATTENDEE_CAP),
        z: new Float64Array(ATTENDEE_CAP),
        dx: new Float64Array(ATTENDEE_CAP),
        dz: new Float64Array(ATTENDEE_CAP),
        front: new Float64Array(ATTENDEE_CAP),
        kit: new Int32Array(ATTENDEE_CAP),
        glow: new Int32Array(ATTENDEE_CAP),
        phase: new Float64Array(ATTENDEE_CAP),
        ok: new Uint8Array(ATTENDEE_CAP),
      };
      this.layouts.set(venue.site.id, layout);
    }
    layout.night = venue.night;
    layout.built = this.frames;
    // The whole cap rather than the night's crowd, because the morning-after
    // litter reads the even indices of this same table -- see `fillLitter` --
    // and because a crowd that grows through the doors would otherwise re-solve
    // every time somebody arrived.
    for (let i = 0; i < ATTENDEE_CAP; i++) {
      const ok = attendeeAt(venue, i, drawn.groundY, 0, frame.solid, this.pose);
      layout.ok[i] = ok ? 1 : 0;
      if (!ok) continue;
      layout.x[i] = this.pose.x;
      layout.z[i] = this.pose.z;
      layout.dx[i] = this.pose.dx;
      layout.dz[i] = this.pose.dz;
      layout.front[i] = this.pose.front;
      layout.kit[i] = this.pose.kit;
      layout.glow[i] = this.pose.glow;
      layout.phase[i] = this.pose.phase;
    }
    return layout;
  }

  /**
   * Read attendee `i` out of a cached layout into the shared pose, pushed out by
   * the scatter. Returns false if that attendee had nowhere to stand.
   *
   * The scatter is applied here rather than baked into the cache for the reason
   * `layoutFor` gives: it is the one part of a crowd that changes between frames,
   * and it is a radial push away from the booth, which is two multiplies.
   */
  private poseFrom(layout: CrowdLayout, i: number, venue: RaveVenue, scatter: number): boolean {
    if (layout.ok[i] === 0) return false;
    const p = this.pose;
    p.dx = layout.dx[i];
    p.dz = layout.dz[i];
    p.front = layout.front[i];
    p.kit = layout.kit[i];
    p.glow = layout.glow[i];
    p.phase = layout.phase[i];
    if (scatter <= 0) {
      p.x = layout.x[i];
      p.z = layout.z[i];
      return true;
    }
    boothPosition(venue, _booth);
    const ox = layout.x[i] - _booth.x;
    const oz = layout.z[i] - _booth.z;
    const len = Math.hypot(ox, oz);
    if (len < 1e-4) {
      p.x = layout.x[i];
      p.z = layout.z[i];
      return true;
    }
    p.x = layout.x[i] + (ox / len) * scatter;
    p.z = layout.z[i] + (oz / len) * scatter;
    // Walking out is walking *away*, so they turn their back on the booth. It is
    // the one frame of animation the bust needs and it is a sign flip.
    p.dx = ox / len;
    p.dz = oz / len;
    return true;
  }

  // --- The rig ----------------------------------------------------------------------

  /**
   * Beams, lasers and haze. The part that makes the picture.
   *
   * Everything in here is a function of `beat`, which is
   * `game/rave.beatAt(now, bpm)` and is therefore the *same number on every
   * screen at once*. Two players standing in this crowd are watching the same
   * fixture point the same way at the same instant, and neither of them sent
   * anything.
   */
  private fillRig(drawn: DrawnVenue, state: ReturnType<typeof raveState>, frame: RaveFrame, gate: number): void {
    const venue = drawn.venue;
    const bpm = this.nearest?.venue === venue ? this.nearest.bpm : venue.bpm;
    const beat = beatAt(frame.nowMs, bpm);
    const bar = barAt(frame.nowMs, bpm);
    const palette = PALETTES[venue.palette % PALETTE_COUNT];
    const busted = state.stage === RAVE_STAGE.BUSTED;
    const working = state.stage === RAVE_STAGE.LOADIN || state.stage === RAVE_STAGE.PACKUP;
    const spanSite = venue.site.kind === SITE_KIND.SPAN;
    const trussY = spanSite ? TRUSS_HEIGHT_SPAN : TRUSS_HEIGHT;

    const s = Math.sin(venue.bearing);
    const c = Math.cos(venue.bearing);
    // The truss's own axes: `forward` points from the booth into the crowd,
    // `right` runs along the truss.
    const fx = s;
    const fz = c;
    const rx = c;
    const rz = -s;

    const level = state.intensity * gate;

    // --- The fixtures.
    for (let f = 0; f < FIXTURES; f++) {
      if (this.nBeam >= BEAM_CAPACITY) break;
      const sky = f < SKY_FIXTURES;
      // Only the sky beams survive past `RIG_RANGE`. That is the whole long-range
      // read: from six hundred metres a rave is four columns over a roofline.
      if (!sky && drawn.distance > RIG_RANGE) continue;
      // A work light during load-in and pack-up: one fixture, warm, pointed
      // down at the ground where the crew are. Not a light show -- a site lamp.
      if (working && f !== 0) continue;

      // Where the lantern hangs. The sky fixtures are on the top chord, spread
      // wide; the crowd fixtures are on the two uprights, lower, because that is
      // where a real rig puts the ones that have to rake across people.
      const across = FIXTURES === 1 ? 0 : ((f % 5) / 4 - 0.5) * 2 * TRUSS_HALF_WIDTH;
      const hang = sky ? trussY : trussY * 0.72;
      const px = drawn.boothX + rx * across;
      const pz = drawn.boothZ + rz * across;

      // The aim. Two sines at rates that never line back up, so ten fixtures on
      // one truss are never all pointing the same way -- which is the single
      // thing that would give away that they are one loop.
      //
      // Half of them **snap on the beat** instead of sweeping, which is what a
      // real desk does: `Math.floor(beat)` quantises the phase, so those
      // fixtures hold a position for a beat and jump. A rig where everything
      // sweeps continuously reads as a screensaver.
      const snap = (f & 1) === 1;
      const clock = snap ? Math.floor(beat * 2) * 0.5 : beat;
      const rate = 0.11 + (f % 7) * 0.037;
      const phase = f * 2.399;
      const pan = Math.sin(clock * Math.PI * 2 * rate + phase) * (sky ? 0.34 : 0.58);
      const tiltBase = sky ? (spanSite ? 0.55 : 1.32) : -0.42;
      const tilt = tiltBase + Math.sin(clock * Math.PI * 2 * rate * 0.61 + phase * 1.7) * (sky ? 0.2 : 0.3);

      // Aim = forward, panned about Y, then tilted up.
      const cp = Math.cos(pan);
      const sp = Math.sin(pan);
      const ax = fx * cp + rx * sp;
      const az = fz * cp + rz * sp;
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      _aim.set(ax * ct, st, az * ct).normalize();
      _quaternion.setFromUnitVectors(_up, _aim);

      const length = sky
        ? SKY_BEAM_LENGTH * (spanSite ? 0.42 : 1)
        : Math.min(CROWD_BEAM_MAX_THROW, Math.max(12, venue.depth * 1.15));
      const width = sky ? SKY_BEAM_WIDTH : CROWD_BEAM_WIDTH;
      _position.set(px, drawn.groundY + hang, pz);
      _scale.set(width, length, width);
      _matrix.compose(_position, _quaternion, _scale);

      // The colour. A hue per fixture, rotating on the bar, which is how a
      // lighting desk actually runs: colour changes land on musical boundaries
      // and movement does not.
      let tint: Rgb;
      let brightness: number;
      if (busted) {
        tint = HOUSE_LIGHT;
        brightness = 1;
      } else if (working) {
        tint = WORK_LIGHT;
        brightness = 0.55;
      } else {
        tint = palette[(f + Math.floor(bar)) % palette.length];
        // A gentle breath on the beat, and a hard gate on a hashed sixth of the
        // fixtures so the rig is not uniformly lit -- a real one always has a
        // couple of lanterns out of the chase.
        const beatFrac = beat - Math.floor(beat);
        const pulse = 0.72 + 0.28 * (1 - beatFrac) * (1 - beatFrac);
        brightness = pulse * (((f * 7 + Math.floor(bar)) % 6) === 0 ? 0.25 : 1);
      }
      // Sky beams run hotter, and it is the same trade `world/bike.ts` made for
      // exactly the same reason: a 62 m column seen at 900 m is four pixels, and
      // four pixels have to be saturated to be findable. A crowd beam is metres
      // across at ten metres away and would be a white wall at the same value.
      const drive = level * brightness * (sky ? SKY_BEAM_DRIVE : CROWD_BEAM_DRIVE);
      this.writeInstance(this.beams, this.nBeam++, _matrix, tint, drive);
    }

    if (drawn.distance > RIG_RANGE) return;

    // --- The lasers. Not during load-in, and not once the police are in.
    if (!working && !busted) {
      for (let l = 0; l < LASERS; l++) {
        if (this.nLaser >= LASER_CAPACITY) break;
        // Lasers are not on all the time. A real rig fires them in sections --
        // the drop, the breakdown -- and a laser that never stops is a laser
        // nobody looks at. Eight bars on, eight off, hashed per projector so the
        // four are not one switch.
        const section = Math.floor(bar / 8) + l * 3;
        if (((section * 2654435761) >>> 0) % 5 < 2) continue;

        const across = (LASERS === 1 ? 0 : (l / (LASERS - 1)) - 0.5) * 2 * TRUSS_HALF_WIDTH * 0.85;
        const px = drawn.boothX + rx * across;
        const pz = drawn.boothZ + rz * across;
        // The fan's own roll about its throw axis, so it scans from horizontal
        // to vertical and back. This is the motion that reads as a laser rather
        // than as a fixed grille, and it runs at a quarter of the beat so it is
        // slow enough to follow.
        const roll = Math.sin(beat * Math.PI * 0.5 + l * 1.9) * LASER_ROLL;
        const tilt = LASER_TILT + Math.sin(beat * Math.PI * 0.17 + l) * 0.05;

        // Aim down the bearing, tilted slightly down over the crowd.
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        _aim.set(fx * ct, st, fz * ct).normalize();
        _quaternion.setFromUnitVectors(_up, _aim);
        // The roll is applied *after* the aim and **about the throw axis**,
        // which is what a scanner's mirror does: the fan is a sheet, and rolling
        // the sheet about the direction it is thrown in sweeps it from
        // horizontal to vertical. Composed rather than baked into the geometry so
        // four projectors can be at four roll angles from one geometry.
        //
        // Local **Y**, and the axis is the whole of this line. The fan spreads in
        // its own XY plane and throws along +Y; rolling about local Z -- which
        // the first cut of this did -- rotates the spread *within* that plane,
        // which does not sweep a sheet at all. It sprays eleven rays in eleven
        // directions and the result is a sea urchin, which is exactly what it
        // looked like.
        _rollQuat.set(0, Math.sin(roll * 0.5), 0, Math.cos(roll * 0.5));
        _quaternion.multiply(_rollQuat);

        const reach = venue.depth * LASER_REACH;
        _position.set(px, drawn.groundY + trussY * 0.86, pz);
        _scale.set(reach, reach, reach);
        _matrix.compose(_position, _quaternion, _scale);
        const tint = palette[(l + 1 + Math.floor(bar / 4)) % palette.length];
        this.writeInstance(this.lasers, this.nLaser++, _matrix, tint, level * LASER_GAIN);
      }
    }

    // --- The haze, and the strobe, which are the same five discs. See `buildHaze`.
    //
    // The strobe is a *section* rather than a permanent tick: one bar in five,
    // hashed off the bar number, the whole volume flashes on every half beat for
    // the first 5% of it. That is short enough to read as a xenon tube and long
    // enough to survive a 60 Hz frame, and putting it on a section means the
    // room is not strobing continuously, which is both correct and merciful.
    const strobeSection = !working && !busted && ((Math.floor(bar) * 2246822519) >>> 0) % 5 === 0;
    const half = beat * 2;
    const strobe = strobeSection && half - Math.floor(half) < 0.11 ? 1 : 0;
    const hazeRadius = Math.min(HAZE_MAX_RADIUS, Math.max(9, venue.depth * 0.55));
    for (let h = 0; h < HAZE_SLABS; h++) {
      if (this.nHaze >= HAZE_CAPACITY) break;
      const u = h / (HAZE_SLABS - 1);
      const y = drawn.groundY + HAZE_FLOOR + u * (spanSite ? 0.9 : 5.0);
      // Counter-rotating, slowly, so the slabs never sit on top of one another
      // and the sum breathes. A single rate would beat against the fixtures'.
      const spin = frame.nowMs * 0.00002 * (h % 2 === 0 ? 1 : -1) + h;
      _quaternion.set(0, Math.sin(spin * 0.5), 0, Math.cos(spin * 0.5));
      _position.set(
        drawn.boothX + fx * venue.depth * 0.55,
        y,
        drawn.boothZ + fz * venue.depth * 0.55,
      );
      const r = hazeRadius * (0.75 + u * 0.45);
      _scale.set(r, 1, r);
      _matrix.compose(_position, _quaternion, _scale);
      if (strobe > 0) {
        this.writeInstance(this.hazes, this.nHaze++, _matrix, HOUSE_LIGHT, gate * STROBE_DRIVE);
      } else {
        const tint = busted ? HOUSE_LIGHT : working ? WORK_LIGHT : palette[h % palette.length];
        this.writeInstance(this.hazes, this.nHaze++, _matrix, tint, level * HAZE_DRIVE);
      }
    }
  }

  /**
   * The physical rig: the truss, the stacks, the booth, the pallets, the
   * generator. Every one of them the same unit box. See section 2.
   *
   * Laid out in the venue's own frame — `forward` into the crowd, `right` along
   * the truss — so the whole thing rotates with the bearing and, under a
   * viaduct, is automatically laid out along the deck.
   */
  private fillStructure(drawn: DrawnVenue, stage: number): void {
    if (drawn.distance > RIG_RANGE) return;
    const venue = drawn.venue;
    const spanSite = venue.site.kind === SITE_KIND.SPAN;
    const trussY = spanSite ? TRUSS_HEIGHT_SPAN : TRUSS_HEIGHT;
    const s = Math.sin(venue.bearing);
    const c = Math.cos(venue.bearing);
    const yaw = Math.atan2(s, c);
    _quaternion.set(0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5));

    // Local (right, up, forward) -> world, at the booth.
    const place = (right: number, up: number, forward: number, sx: number, sy: number, sz: number, tint: Rgb): void => {
      if (this.nStructure >= STRUCTURE_CAPACITY) return;
      _position.set(
        drawn.boothX + c * right + s * forward,
        drawn.groundY + up,
        drawn.boothZ - s * right + c * forward,
      );
      _scale.set(sx, sy, sz);
      _matrix.compose(_position, _quaternion, _scale);
      this.writeInstance(this.structures, this.nStructure++, _matrix, tint, 1);
    };

    // The truss: two uprights and a top chord, in scaffold grey. A goalpost
    // rather than a box truss because a box truss is four chords and sixteen
    // diagonals, and at these distances the silhouette of a goalpost with
    // lanterns hanging off it is the whole of what reads.
    // What is still standing. Pack-up has taken the truss down; the morning
    // after has taken almost everything, and what is left is the one stack
    // nobody came back for and the pallets somebody was sitting on.
    const packedUp = stage === RAVE_STAGE.PACKUP || stage === RAVE_STAGE.GONE;
    const abandoned = stage === RAVE_STAGE.GONE;
    if (!packedUp) {
      place(-TRUSS_HALF_WIDTH, trussY * 0.5, 0, 0.16, trussY, 0.16, SCAFFOLD);
      place(TRUSS_HALF_WIDTH, trussY * 0.5, 0, 0.16, trussY, 0.16, SCAFFOLD);
      place(0, trussY, 0, TRUSS_HALF_WIDTH * 2 + 0.16, 0.18, 0.18, SCAFFOLD);
      // Two diagonals, which is what stops a goalpost reading as a doorway.
      place(-TRUSS_HALF_WIDTH * 0.55, trussY * 0.86, 0, TRUSS_HALF_WIDTH * 0.9, 0.1, 0.1, SCAFFOLD);
      place(TRUSS_HALF_WIDTH * 0.55, trussY * 0.86, 0, TRUSS_HALF_WIDTH * 0.9, 0.1, 0.1, SCAFFOLD);
    }

    // The stacks. Three boxes a side, and the top one angled would be nicer and
    // is not worth a second geometry; what makes a speaker stack read is that it
    // is a *column of identical black boxes taller than a person*.
    for (const side of [-1, 1]) {
      // Half of it went in the first van load. One stack left, and it is the
      // *left* one every time rather than a hashed one, because a rave is packed
      // down from the same end it was built from.
      if (abandoned && side === 1) continue;
      const x = side * (TRUSS_HALF_WIDTH - 0.9);
      for (let b = 0; b < 3; b++) {
        place(x, 0.42 + b * 0.84, -0.4, 1.05, 0.8, 0.78, SPEAKER);
      }
      // The sub, on the ground, wider than the tops. This is the box the bass
      // you heard from three streets away came out of.
      place(x, 0.36, 0.55, 1.35, 0.7, 1.05, SPEAKER);
    }

    // The booth: a trestle with a cloth over it, and the decks on top. Gone by
    // morning -- the records went home in somebody's arms before anything else
    // did, which is true of every rave that has ever happened.
    if (!abandoned) {
      place(0, 0.48, -0.3, 2.4, 0.95, 0.9, BOOTH);
      place(0, 1.0, -0.3, 2.2, 0.09, 0.72, DECK);
      // The generator, off to one side and behind everything, because that is
      // where you put the thing that is making the noise you do not want.
      place(-TRUSS_HALF_WIDTH - 2.2, 0.45, -1.8, 1.6, 0.9, 0.9, GENERATOR);
    }

    // A stack of pallets somebody is sitting on, and a wheelie bin. Two objects,
    // eight instances, and they are the difference between a stage and a place
    // where people are.
    for (let p = 0; p < 4; p++) {
      place(TRUSS_HALF_WIDTH + 2.4, 0.08 + p * 0.15, 1.2, 1.2, 0.14, 1.0, PALLET);
    }
    place(TRUSS_HALF_WIDTH + 1.2, 0.55, 3.6, 0.62, 1.1, 0.58, BIN);

    // Under a viaduct: the piers are the venue's walls and somebody has leaned
    // the spare gear against one. Two crates, only here, because this is the one
    // site kind with a wall to lean things on.
    if (spanSite) {
      place(-TRUSS_HALF_WIDTH - 0.6, 0.3, 2.6, 0.9, 0.6, 0.7, PALLET);
      place(-TRUSS_HALF_WIDTH - 0.6, 0.85, 2.6, 0.7, 0.5, 0.6, PALLET);
    }
  }

  /**
   * The morning after: bottles, cans, flyers, cable ties, and a scorch mark.
   *
   * *"does the site show evidence the morning after — litter, a scorched pallet,
   * a stack of speakers still being packed? that costs almost nothing and is
   * exactly the kind of detail that makes a world feel inhabited."* It costs one
   * instanced set of flat quads and it is the only part of this feature a player
   * can find in daylight, which makes it the part that tells them the rest of it
   * exists.
   *
   * Placed with the same hash the crowd is, so **the rubbish is where the crowd
   * was**: densest in front of the booth, thinning to the back. That is one line
   * and it is the whole difference between litter and confetti.
   */
  private fillLitter(drawn: DrawnVenue, amount: number, frame: RaveFrame): void {
    if (drawn.distance > RIG_RANGE) return;
    const venue = drawn.venue;
    const layout = this.layoutFor(venue, drawn, frame);
    const n = Math.min(LITTER_PIECES, Math.round(LITTER_PIECES * amount));
    for (let i = 0; i < n; i++) {
      if (this.nLitter >= LITTER_CAPACITY) break;
      // The crowd's own layout, so the mess is where the people were. `solid` is
      // passed through, so nothing ends up inside the container it was thrown
      // behind.
      if (!this.poseFrom(layout, i * 2, venue, 0)) continue;
      const spin = this.pose.phase * Math.PI * 2;
      _quaternion.set(0, Math.sin(spin * 0.5), 0, Math.cos(spin * 0.5));
      // 2 cm off the ground: enough to beat z-fighting with the terrain at this
      // range, small enough that nothing floats.
      _position.set(this.pose.x, drawn.groundY + 0.02, this.pose.z);
      const size = 0.12 + this.pose.front * 0.16;
      _scale.set(size, 1, size * 2.4);
      _matrix.compose(_position, _quaternion, _scale);
      this.writeInstance(this.litters, this.nLitter++, _matrix, LITTER_COLOURS[this.pose.glow % LITTER_COLOURS.length], 1);
    }
    // And the scorch: one big dark patch where the pallet fire was, in front of
    // the booth and to one side of it, which is where you would light one.
    if (this.nLitter < LITTER_CAPACITY) {
      const s = Math.sin(venue.bearing);
      const c = Math.cos(venue.bearing);
      _quaternion.set(0, 0, 0, 1);
      _position.set(
        drawn.boothX + s * venue.depth * 1.15 + c * 4,
        drawn.groundY + 0.015,
        drawn.boothZ + c * venue.depth * 1.15 - s * 4,
      );
      _scale.set(3.2, 1, 3.2);
      _matrix.compose(_position, _quaternion, _scale);
      this.writeInstance(this.litters, this.nLitter++, _matrix, SCORCH, amount);
    }
  }

  // --- The crowd ---------------------------------------------------------------------

  /**
   * Everybody at this rave, as impostors, plus their glow.
   *
   * The impostor is `world/people.ts`' figure drawn from this file's own
   * instance buffers — same geometry, same material, same six parts, same three
   * matrix composes per person. What differs is only the pose: a pedestrian
   * walks along a band and a raver stands in a wedge and bounces, so the legs
   * splay a little rather than swinging and the whole body rides `danceBob`.
   *
   * The glow is written from **the same loop and the same transform**, which is
   * the property that matters: a body and its glow sticks cannot get out of step,
   * because there is no second pass in which they could.
   */
  private fillCrowd(drawn: DrawnVenue, state: ReturnType<typeof raveState>, frame: RaveFrame, gate: number): void {
    const venue = drawn.venue;
    const bpm = this.nearest?.venue === venue ? this.nearest.bpm : venue.bpm;
    const beat = beatAt(frame.nowMs, bpm);
    const present = Math.min(ATTENDEE_CAP, Math.round(venue.attendees * state.crowd));
    const busted = state.stage === RAVE_STAGE.BUSTED;
    const layout = this.layoutFor(venue, drawn, frame);

    for (let i = 0; i < present; i++) {
      if (this.attendeesDrawn >= ATTENDEE_CAPACITY) break;
      if (!this.poseFrom(layout, i, venue, state.scatter)) continue;

      const dx = this.pose.x - frame.x;
      const dz = this.pose.z - frame.z;
      const d2 = dx * dx + dz * dz;
      // The near tier takes them instead; see `assign`. Recorded rather than
      // skipped so the glow still draws -- a dancer close enough for a skeleton
      // is close enough that the glow sticks in their hands are the point.
      const rigged = d2 < CROWD_RIG_KEEP * CROWD_RIG_KEEP && this.claimRig(venue.site.id, i, d2);

      const groundY = drawn.groundY;
      const bob = busted ? 0 : danceBob(beat, this.pose);
      const y = groundY + bob;

      // The yaw, from the pose's unit facing, with no `Math.atan2` -- the same
      // half-angle trick `world/people.ts` uses and for the same reason: this
      // runs on every figure in every crowd on every frame.
      const cc = -this.pose.dz;
      const ss = -this.pose.dx;
      const w2 = (1 + cc) * 0.5;
      if (w2 > 1e-12) {
        const w = Math.sqrt(w2);
        _quaternion.set(0, ss / (2 * w), 0, w);
      } else {
        _quaternion.set(0, 1, 0, 0);
      }
      // A sway on top of the yaw. Dancing is a *twist*, not a bounce, and this
      // is the term that makes forty people read as dancing rather than as forty
      // people on pogo sticks. Hard at the front, gentle at the back.
      if (!busted) {
        const sway = Math.sin(beat * Math.PI + this.pose.phase * 6.28) * 0.26 * (0.3 + this.pose.front * 0.7);
        _sway.set(0, Math.sin(sway * 0.5), 0, Math.cos(sway * 0.5));
        _quaternion.multiply(_sway);
      }

      // The glow, always, whichever tier the body is on.
      if (gate > 0.02 && this.nGlow < ATTENDEE_CAPACITY) {
        _position.set(this.pose.x, y, this.pose.z);
        _scale.set(1, 1, 1);
        _matrix.compose(_position, _quaternion, _scale);
        // Everybody's glow breathes at their own rate -- a glow stick does not,
        // but an arm holding one does, and the swing is what a crowd of them
        // looks like. Plus a hashed fifth who are not wearing any, because a
        // crowd where *everybody* is lit up is a promotional photograph.
        const dark = ((this.pose.glow * 5 + i) % 7) === 0;
        const swing = 0.72 + 0.28 * Math.sin(beat * Math.PI * 2 + this.pose.phase * 12.9);
        this.writeInstance(
          this.glows,
          this.nGlow++,
          _matrix,
          GLOW_COLOURS[this.pose.glow % GLOW_COLOUR_COUNT],
          dark ? 0 : gate * swing * GLOW_DRIVE * (0.55 + this.pose.front * 0.45),
        );
      }

      if (rigged) continue;

      _position.set(this.pose.x, y, this.pose.z);
      _scale.set(1, 1, 1);
      _matrix.compose(_position, _quaternion, _scale);
      const kit = COLOURWAYS[this.pose.kit] ?? COLOURWAYS[0];
      const n = this.attendeesDrawn;
      this.writePed(0, n, _matrix, kit.singlet);
      this.writePed(1, n, _matrix, kit.skin);

      // The legs. A raver's feet are planted and their knees give -- so the two
      // legs splay by a small fixed amount rather than swinging in antiphase,
      // which is the one visible difference between this and a walker at the
      // same distance. One `Math.sin` for the give, shared by both legs.
      const give = busted ? 0.3 : 0.06 + 0.1 * Math.sin(beat * Math.PI * 2 - this.pose.phase * 6.28);
      const ss2 = Math.sin(give * 0.5);
      const cs2 = Math.cos(give * 0.5);
      for (let leg = 0; leg < 2; leg++) {
        const sign = leg === 0 ? 1 : -1;
        _sway.set(0, 0, ss2 * sign, cs2);
        _legQuat.copy(_quaternion).multiply(_sway);
        _hip.set(sign * PED_LEG_X, PED_HIP_Y, 0).applyQuaternion(_quaternion);
        _position.set(this.pose.x + _hip.x, y + _hip.y, this.pose.z + _hip.z);
        _matrix.compose(_position, _legQuat, _scale);
        this.writePed(2 + leg * 2, n, _matrix, kit.shorts);
        this.writePed(3 + leg * 2, n, _matrix, kit.skin);
      }
      this.attendeesDrawn = n + 1;
    }
  }

  /** Which attendees the eight skinned bodies are on, this frame. */
  private readonly claimed: Array<{ site: number; index: number; d2: number }> = [];

  /**
   * Offer a rig slot to an attendee, keeping the eight nearest.
   *
   * A running eight-element insertion rather than a sort, on
   * `PedestrianCrowd.assign`'s argument: eight times a few hundred comparisons
   * is cheaper than a sort of the whole crowd, allocates nothing, and never
   * reorders equal distances differently between frames.
   */
  private claimRig(site: number, index: number, d2: number): boolean {
    const list = this.claimed;
    if (list.length < CROWD_RIG_CAPACITY) {
      let at = list.length;
      while (at > 0 && list[at - 1].d2 > d2) at--;
      list.splice(at, 0, { site, index, d2 });
      return true;
    }
    if (d2 >= list[list.length - 1].d2) return false;
    let at = CROWD_RIG_CAPACITY - 1;
    while (at > 0 && list[at - 1].d2 > d2) at--;
    list.pop();
    list.splice(at, 0, { site, index, d2 });
    return true;
  }

  /**
   * Hand the claimed attendees a skinned body, keeping the ones already on one.
   *
   * `PedestrianCrowd.assign`'s two passes and its hysteresis, with one addition:
   * **slot 0 is the DJ**, whenever a booth is inside `CROWD_RIG_RANGE`. A rave
   * with nobody behind the decks is a sound system, and there is exactly one
   * person at a rave whose absence is unmissable.
   */
  private assign(frame: RaveFrame): void {
    const list = this.claimed;
    // The DJ takes the first slot outright, as attendee index -1 of the nearest
    // venue, so the pool's own hysteresis carries them exactly as it does anyone
    // else and there is no second lifecycle.
    const near = this.drawnVenues[0];
    let djKey = -1;
    if (near && near.distance < CROWD_RIG_RANGE * 1.6) {
      const state = raveState(near.venue, frame.nowMs);
      if (state.stage !== RAVE_STAGE.GONE && state.stage !== RAVE_STAGE.BUSTED) {
        djKey = attendeeKey(near.venue.site.id, DJ_INDEX);
      }
    }

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.key < 0) continue;
      if (slot.key === djKey) continue;
      let held = false;
      for (const c of list) {
        if (attendeeKey(c.site, c.index) === slot.key) { held = true; break; }
      }
      if (!held) {
        slot.key = -1;
        slot.actor.mesh.visible = false;
      }
    }

    if (djKey >= 0) {
      let has = false;
      for (const slot of this.slots) if (slot.key === djKey) { has = true; break; }
      if (!has) {
        const free = this.slots.find((s) => s.key < 0);
        if (free) { free.key = djKey; free.actor.mesh.visible = true; }
      }
    }

    for (const c of list) {
      const key = attendeeKey(c.site, c.index);
      let has = false;
      for (const slot of this.slots) if (slot.key === key) { has = true; break; }
      if (has) continue;
      const free = this.slots.find((s) => s.key < 0);
      if (!free) break;
      free.key = key;
      free.actor.mesh.visible = true;
    }
    list.length = 0;
  }

  /**
   * Drive the eight bodies through the public animation API.
   *
   * No new clip, `player/bat.ts`'s rule: reach in from outside. A dancer is fed
   * a position that bobs on the shared beat, a yaw that sways on it, and a
   * `speed` just under the walk threshold — which keeps the rig's idle drift
   * alive without putting it into a walk cycle. Feeding a real speed here was
   * the first thing tried and it produced eight people marching on the spot.
   */
  private poseRigs(frame: RaveFrame): void {
    let rigged = 0;
    for (const slot of this.slots) {
      if (slot.key < 0) continue;
      const site = slot.key >>> KEY_SHIFT;
      const index = (slot.key & KEY_MASK) - KEY_BIAS;
      const drawn = this.drawnVenues.find((d) => d.venue.site.id === site);
      if (!drawn) { slot.key = -1; slot.actor.mesh.visible = false; continue; }
      const venue = drawn.venue;
      const state = raveState(venue, frame.nowMs);
      const bpm = this.nearest?.venue === venue ? this.nearest.bpm : venue.bpm;
      const beat = beatAt(frame.nowMs, bpm);

      let x: number;
      let z: number;
      let yaw: number;
      let bob: number;
      let hard: number;

      if (index === DJ_INDEX) {
        // Behind the decks, facing the crowd, and nodding rather than dancing --
        // which is what somebody working looks like, and is the detail that
        // makes the figure read as *the DJ* rather than as one more raver who
        // happens to be standing at the front.
        const s = Math.sin(venue.bearing);
        const c = Math.cos(venue.bearing);
        x = drawn.boothX - s * 1.35;
        z = drawn.boothZ - c * 1.35;
        yaw = Math.atan2(s, c);
        bob = Math.max(0, Math.sin(beat * Math.PI * 2)) * 0.055;
        hard = 0.35;
      } else {
        if (!this.poseFrom(this.layoutFor(venue, drawn, frame), index, venue, state.scatter)) {
          slot.key = -1;
          slot.actor.mesh.visible = false;
          continue;
        }
        x = this.pose.x;
        z = this.pose.z;
        yaw = Math.atan2(-this.pose.dx, -this.pose.dz);
        bob = danceBob(beat, this.pose);
        hard = 0.3 + this.pose.front * 0.7;
        yaw += Math.sin(beat * Math.PI + this.pose.phase * 6.28) * 0.3 * hard;
      }

      // The kit, reconciled by swapping the geometry -- `PedestrianCrowd.assign`'s
      // own trick, and it works for the same reason: all seven of
      // `CharacterAssets`' geometries share position, normal, skinIndex and
      // skinWeight and differ only in their colour attribute.
      const kit = index === DJ_INDEX ? DJ_KIT : this.pose.kit;
      if (kit !== slot.kit) {
        slot.actor.mesh.geometry = this.kitGeometries[kit] ?? this.kitGeometries[0];
        slot.kit = kit;
      }

      _feet.x = x;
      _feet.y = drawn.groundY + bob;
      _feet.z = z;
      slot.actor.update(frame.dt, {
        position: _feet,
        yaw,
        // Under `PINNED_WALK_SPEED`, deliberately: it keeps the idle's drift
        // running and never crosses into the walk clip. The dance is the bob and
        // the sway, both of which are on the shared beat; the clip is only there
        // so the figure is breathing.
        speed: state.stage === RAVE_STAGE.BUSTED ? 1.6 : 0.35 * hard,
        onGround: true,
      });
      rigged++;
    }
    this.rigged = rigged;
  }

  // --- The banner ------------------------------------------------------------------------

  /**
   * The decks' readout, on the front of the booth, facing the crowd.
   *
   * Diegetic rather than a HUD line, which was the brief's own word, and drawn
   * for the **nearest venue only**: it is a 1.9 m sign and it is illegible past
   * about forty metres, so a second one would be a texture upload for something
   * nobody can read. That is also why the whole thing is one mesh rather than an
   * instanced set — one sign, one draw, one canvas.
   */
  private updateBanner(frame: RaveFrame): void {
    const near = this.nearest;
    if (!near || near.distance > BANNER_RANGE || frame.night < 0.05) {
      this.banner.visible = false;
      return;
    }
    const venue = near.venue;
    const spanSite = venue.site.kind === SITE_KIND.SPAN;
    const s = Math.sin(venue.bearing);
    const c = Math.cos(venue.bearing);
    this.assets.setBanner(near.busted ? 'PARTY OVER' : near.title);
    this.banner.position.set(near.x + s * 0.5, near.y + (spanSite ? 1.28 : 1.4), near.z + c * 0.5);
    this.banner.rotation.set(0, Math.atan2(s, c), 0);
    this.banner.scale.set(2.1, 0.39, 1);
    this.banner.visible = true;
  }

  // --- Buffer plumbing -------------------------------------------------------------------

  /**
   * One instance: a matrix, a hue and a brightness, with the brightness folded
   * into the colour. See section 3 — this is the whole of the shading model.
   */
  private writeInstance(mesh: InstancedMesh, i: number, matrix: Matrix4, tint: Rgb, drive: number): void {
    mesh.setMatrixAt(i, matrix);
    // `setRGB` with no colour space argument writes in the **working** space,
    // which is linear -- these are radiometric multipliers, not swatches, and
    // `world/nightlights.ts` states the same thing for the same reason.
    _colour.setRGB(tint[0] * drive, tint[1] * drive, tint[2] * drive);
    mesh.setColorAt(i, _colour);
  }

  private writePed(part: number, n: number, matrix: Matrix4, tint: Rgb): void {
    const mesh = this.peds[part];
    mesh.setMatrixAt(n, matrix);
    _colour.setRGB(tint[0], tint[1], tint[2]);
    mesh.setColorAt(n, _colour);
    this.counts[part] = n + 1;
  }

  /** Publish the counts and mark the buffers dirty. Once a frame, per set. */
  private flush(): void {
    this.groundSettled++;
    this.frames++;
    const upload = (mesh: InstancedMesh, count: number): void => {
      // Only upload what changed. A region of the buffer nobody is drawing does
      // not have to be correct -- `PedestrianCrowd.fillImpostors`' rule.
      if (count > 0 || mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = count;
    };
    upload(this.beams, this.nBeam);
    upload(this.lasers, this.nLaser);
    upload(this.hazes, this.nHaze);
    upload(this.glows, this.nGlow);
    upload(this.structures, this.nStructure);
    upload(this.litters, this.nLitter);
    for (let p = 0; p < 6; p++) upload(this.peds[p], this.counts[p]);
  }

  /**
   * Release the instance buffers. **Not the geometry or the material**, which
   * are `RaveAssets`' and are shared by every rave in the city — the same trap
   * `streamer.dispose` documents at length.
   */
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
  }
}

/** How near the booth its sign is legible, metres. See `updateBanner`. */
const BANNER_RANGE = 46;

/** How often the ground under a venue is re-sampled, in frames. See `groundFor`. */
const GROUND_RESAMPLE = 30;

/**
 * The attendee index the DJ occupies. Negative, so it can never collide with a
 * real attendee, and biased into the key by `KEY_BIAS`.
 */
const DJ_INDEX = -1;
/** Which of the seven kits the DJ wears. Black on black, obviously. */
const DJ_KIT = 1;

/**
 * A (site, attendee) pair as one integer, for the rig pool's identity.
 *
 * `PedestrianCrowd` gets away with a bare key because a pedestrian's own key is
 * globally unique; an attendee index is only unique within its site, so the two
 * are packed. 448 sites needs 9 bits and `ATTENDEE_CAP` plus the DJ needs 7, so
 * this fits in 16 with room for both tables to double.
 */
const KEY_SHIFT = 8;
const KEY_MASK = 0xff;
const KEY_BIAS = 8;

function attendeeKey(site: number, index: number): number {
  return (site << KEY_SHIFT) | ((index + KEY_BIAS) & KEY_MASK);
}

/** The impostor's hip, restated from `world/people.ts`. `verifyRaveKit` checks it. */
const PED_HIP_Y = 0.815;
const PED_LEG_X = 0.085;

// --- The palette of things that are not lights ---------------------------------------

/** Galvanised scaffold, linear. Bright enough to catch a torch beam. */
const SCAFFOLD: Rgb = [0.42, 0.44, 0.46];
/** Speaker boxes: black paint over ply, with the grille cloth darker still. */
const SPEAKER: Rgb = [0.05, 0.05, 0.055];
/** The booth's cloth. Somebody's black bedsheet gaffered to a trestle. */
const BOOTH: Rgb = [0.07, 0.065, 0.07];
/** The deck plinth, in the silver every flight case in the world is. */
const DECK: Rgb = [0.5, 0.51, 0.53];
/** A yellow site generator, because they are always yellow. */
const GENERATOR: Rgb = [0.42, 0.34, 0.06];
/** Timber pallets, weathered grey-brown. */
const PALLET: Rgb = [0.24, 0.19, 0.13];
/** A council wheelie bin, in the red every general-waste lid in Sydney is. */
const BIN: Rgb = [0.28, 0.05, 0.045];

/**
 * What is on the ground the next morning, linear.
 *
 * Six colours because there are six things on the ground after a party and
 * everybody can name them: a green stubby, a brown one, a silver can, a flyer,
 * a black cable tie and a plastic cup. Indexed by the attendee's own glow colour
 * so it is stable across a whole day rather than shuffling every frame.
 */
const LITTER_COLOURS: readonly Rgb[] = [
  [0.03, 0.09, 0.035],
  [0.09, 0.05, 0.02],
  [0.36, 0.37, 0.38],
  [0.42, 0.4, 0.36],
  [0.02, 0.02, 0.022],
  [0.3, 0.3, 0.32],
];

/** Where the pallet fire was. Nearly black, and a little wider than it was hot. */
const SCORCH: Rgb = [0.012, 0.011, 0.01];

const _sway = /*#__PURE__*/ new Quaternion();
const _rollQuat = /*#__PURE__*/ new Quaternion();
const _legQuat = /*#__PURE__*/ new Quaternion();
const _hip = /*#__PURE__*/ new Vector3();

// --- Self-check -----------------------------------------------------------------------

/**
 * What the *kit* gets wrong in a way that renders.
 *
 * `game/rave.verifyRaves` is the rules half; this is the half about the objects,
 * and it is here on `world/people.ts`' and `world/bike.ts`' criterion: every one
 * of these failures draws something plausible from at least one angle.
 *
 * A beam whose gradient does not reach zero at the tip is a coloured bar ruled
 * across the sky with a visible top, which from the ground looks like a beam. A
 * beam whose foot is not at the origin points from the wrong place and the error
 * is a metre, which nobody notices until they stand under it. A laser fan wound
 * one way only vanishes from half the angles it is seen from — and it is
 * *additive*, so what you get is not a black shape but simply nothing, which
 * reads as the laser having been switched off. An impostor whose hip constant has
 * drifted from `world/people.ts`' scissors its legs through its body at exactly
 * the distance the crowd is densest. And a material with `depthWrite` on turns
 * every beam into a hole in the crowd behind it.
 */
export function verifyRaveKit(assets: RaveAssets = new RaveAssets()): string[] {
  const failures: string[] = [];

  // --- The material contract. Four flags, and every one of them has a distinct
  // and plausible-looking failure. See section 1 and the material's own comments.
  const e = assets.emissive;
  if (e.blending !== AdditiveBlending) failures.push('The rave material is not additive; every beam would be a solid coloured slab.');
  if (e.depthWrite !== false) failures.push('The rave material writes depth; each beam would punch a hole in the crowd behind it.');
  if (e.depthTest !== true) failures.push('The rave material does not depth-test; beams would be painted up the face of every hill between the player and the site.');
  if (!e.transparent) failures.push('The rave material is not transparent, so it never reaches the blend the additive path needs.');
  if (e.fog !== false) failures.push('The rave material is fogged; a beam would fade to the fog colour rather than to nothing.');
  if (!e.vertexColors) failures.push('The rave material ignores vertex colour, so every gradient in this file is discarded.');
  if (assets.solid.vertexColors !== true) failures.push('The structure material ignores vertex colour.');

  // --- The beam. Both ends of the gradient, and the foot at the origin.
  {
    const first = BEAM_STOPS[0];
    const last = BEAM_STOPS[BEAM_STOPS.length - 1];
    if (first[1] !== 0) failures.push(`The beam's foot is at brightness ${first[1]}; the cut across the bottom of the three planes would be visible from underneath.`);
    if (last[1] !== 0) failures.push(`The beam's tip is at brightness ${last[1]}; it would be a bar ruled across the sky with a top on it.`);
    if (first[0] !== 0 || last[0] !== 1) failures.push('The beam gradient does not span its own unit length.');
    let peak = 0;
    let peakAt = 0;
    for (const [t, b] of BEAM_STOPS) if (b > peak) { peak = b; peakAt = t; }
    if (peakAt > 0.25) failures.push(`The beam's peak is ${peakAt} of the way up; under NeutralToneMapping a gradient spent late is a hard edge, not a fade.`);

    const pos = assets.beam.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
      maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    if (maxY !== 1) failures.push(`The beam geometry is ${maxY} long rather than 1; every instance scale in this file is a throw distance and would be wrong by that factor.`);
    if (minY < -0.4) failures.push(`The beam geometry reaches ${minY.toFixed(2)} below its own origin; the lamp face would hang below the truss.`);
    if (maxR > BEAM_W1 + 1e-6) failures.push(`The beam is ${maxR.toFixed(2)} wide against a stated tip half-width of ${BEAM_W1}.`);
  }

  // --- Both windings, on the three geometries that are additive planes. An
  // additive surface has no back, so a one-sided one is a light that switches
  // off when you walk round it.
  for (const [name, geometry] of [
    ['beam', assets.beam], ['laser', assets.laser], ['haze', assets.haze], ['glow', assets.glow],
  ] as Array<[string, BufferGeometry]>) {
    const idx = geometry.getIndex();
    if (!idx) { failures.push(`The rave ${name} geometry is not indexed.`); continue; }
    const seen = new Map<string, number>();
    let unpaired = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const key = `${a},${b},${c}`;
      const flip = `${a},${c},${b}`;
      if ((seen.get(flip) ?? 0) > 0) seen.set(flip, (seen.get(flip) ?? 0) - 1);
      else seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const n of seen.values()) unpaired += n;
    if (unpaired > 0) {
      failures.push(
        `${unpaired} of the ${idx.count / 3} triangles in the rave ${name} have no opposite winding; that ` +
          'surface is invisible from one side, and being additive it goes to nothing rather than to black.',
      );
    }
  }

  // --- The laser: thin, and reaching exactly one unit so the instance scale is
  // a throw distance.
  {
    const pos = assets.laser.getAttribute('position');
    let maxLen = 0;
    let maxZ = 0;
    for (let i = 0; i < pos.count; i++) {
      maxLen = Math.max(maxLen, Math.hypot(pos.getX(i), pos.getY(i)));
      maxZ = Math.max(maxZ, Math.abs(pos.getZ(i)));
    }
    if (Math.abs(maxLen - 1) > 0.02) failures.push(`The laser fan reaches ${maxLen.toFixed(3)} rather than 1; its instance scale is a throw distance.`);
    if (maxZ > LASER_HALF_WIDTH * 1.01) failures.push(`The laser fan is ${maxZ.toFixed(3)} thick out of its own plane; it should be a fan, not a cone.`);
    if (LASER_BLADES % 2 === 0) failures.push(`The laser fan has ${LASER_BLADES} blades, an even number, so there is no ray on the axis.`);
  }

  // --- The haze: a disc that is bright in the middle and exactly zero at the
  // rim. A rim above zero is a visible circle hanging in the air, which is the
  // one thing haze must never be.
  {
    const pos = assets.haze.getAttribute('position');
    const col = assets.haze.getAttribute('color');
    let rimMax = 0;
    let centre = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r > 0.99) rimMax = Math.max(rimMax, col.getX(i));
      if (r < 1e-6) centre = Math.max(centre, col.getX(i));
    }
    if (rimMax > 1e-6) failures.push(`The haze disc's rim is at ${rimMax}; it would read as a visible circle in the air.`);
    if (centre < 0.9) failures.push('The haze disc has no bright centre.');
  }

  // --- The glow, against the figure it is worn by. A loop at the wrong height
  // is an EL wire round somebody's knees.
  {
    const pos = assets.glow.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    if (minY < 0.3) failures.push(`The attendee glow reaches ${minY.toFixed(2)} m, which is below the knee; it is worn, not dropped.`);
    if (maxY > 1.85) failures.push(`The attendee glow reaches ${maxY.toFixed(2)} m, over the top of a 1.7 m figure's head.`);
    if (GLOW_COLOURS.length !== GLOW_COLOUR_COUNT) {
      failures.push(
        `There are ${GLOW_COLOURS.length} glow colours here and game/rave.ts hashes over ` +
          `${GLOW_COLOUR_COUNT}; some attendees would index off the end of the palette.`,
      );
    }
  }

  // --- The impostor's proportions, against `world/people.ts`. Checked, not
  // shared: this file poses that figure's parts and a drift is a scissored leg.
  {
    const shorts = new PedestrianAssets().shorts;
    const pos = shorts.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    if (Math.abs(maxY) > 1e-6) failures.push(`The pedestrian shorts pivot at y = ${maxY}; this file rotates them about 0.`);
    if (Math.abs(PED_HIP_Y - 0.815) > 1e-9) failures.push('The rave crowd\'s hip constant has drifted from world/people.ts.');
    if (Math.abs(PED_LEG_X - 0.085) > 1e-9) failures.push('The rave crowd\'s leg spacing has drifted from world/people.ts.');
  }

  // --- The palettes. A hue past the tone curve's shoulder is a white stripe.
  for (let p = 0; p < PALETTES.length; p++) {
    for (const hue of PALETTES[p]) {
      const peak = Math.max(hue[0], hue[1], hue[2]);
      if (peak > 1.45) {
        failures.push(
          `Palette ${p} has a channel at ${peak}; three overlapping beam planes put that past ` +
            "NeutralToneMapping's desaturation shoulder and the beam's core goes white.",
        );
      }
      if (peak < 0.6) failures.push(`Palette ${p} has a hue whose brightest channel is only ${peak}; it would not read at range.`);
    }
  }
  if (PALETTES.length !== PALETTE_COUNT) {
    failures.push(`There are ${PALETTES.length} palettes here and game/rave.ts hashes over ${PALETTE_COUNT}.`);
  }

  // --- The capacities, against the rules file's own. A capacity under the cap
  // is a crowd that silently stops at 63 people.
  if (ATTENDEE_CAPACITY < ATTENDEE_CAP) {
    failures.push(`The attendee buffers hold ${ATTENDEE_CAPACITY} and one rave alone can have ${ATTENDEE_CAP}.`);
  }
  if (BEAM_CAPACITY < FIXTURES) failures.push('The beam buffer cannot hold one rig.');
  if (CROWD_RIG_KEEP <= CROWD_RIG_RANGE) failures.push('The rave rig hysteresis band is empty; dancers would flicker between tiers.');
  if (BEAM_RANGE <= RIG_RANGE) failures.push('The beam range is not beyond the rig range, so a rave has no long-range read at all.');
  if (RIG_RANGE <= CROWD_RANGE) failures.push('The rig is drawn no further than the crowd, so people would appear before the lights they are standing under.');
  if (TRUSS_HEIGHT_SPAN >= 4.3) {
    failures.push(
      `The under-bridge truss is ${TRUSS_HEIGHT_SPAN} m, at or over the 4.3 m minimum overbridge clearance; ` +
        'it would stand inside the deck soffit.',
    );
  }

  // --- The key packing, which is silent and total when it is wrong: two
  // attendees at two sites sharing a key means one rig pops between them.
  {
    const seen = new Set<number>();
    let collisions = 0;
    for (let site = 0; site < 512; site += 7) {
      for (let i = DJ_INDEX; i < ATTENDEE_CAP; i++) {
        const key = attendeeKey(site, i);
        if (seen.has(key)) collisions++;
        seen.add(key);
      }
    }
    if (collisions > 0) failures.push(`${collisions} (site, attendee) pairs share a rig key; bodies would pop between dancers.`);
    if (attendeeKey(300, DJ_INDEX) === attendeeKey(300, 0)) failures.push('The DJ shares a key with attendee 0.');
  }

  return failures;
}
