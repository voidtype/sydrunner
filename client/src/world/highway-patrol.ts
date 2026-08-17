/**
 * What the top of the heat ladder looks like: a patrol car with a light bar, a
 * random breath test across the road, and a spotlight from a helicopter that
 * does not exist.
 *
 * The **rendering** half of `game/heat.ts`. That file decides where a patrol car
 * is, when an RBT appears and who Polair is looking at, and it is compiled into
 * the Bun server; this one draws all three and imports three. `world/police.ts`
 * against `game/factions.ts`, restated, and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THE CAR IS BUILT HERE RATHER THAN LOADED FROM `public/cars`.
 *
 * There are twenty-nine `.glb` car models on disk and one of them is literally
 * `police_kenney.glb`, so the obvious build is to load it. This does not, and
 * the reason is ownership rather than taste.
 *
 * `world/carlod.ts` owns every one of those files. It fetches the manifest,
 * merges each scene into **one** geometry with the node transforms baked and
 * every material collapsed to a vertex colour, holds them in per-body pools
 * whose *order is a contract*, and draws them as `InstancedMesh`es out of a
 * claim ledger. None of that machinery is exported and none of it is shaped for
 * a single hero object: `CarModelFleet` is a lookup-driven near-field fleet, and
 * asking it for "one car at this position, please" would mean either reaching
 * into its pools or copying its merge. The first is a second owner for that
 * file's invariants; the second is two hundred lines of glTF flattening in a
 * file about police.
 *
 * So the patrol car is **procedural**, out of the same little `Parts`
 * accumulator `world/police.ts` builds its cap and band with -- a white
 * Commodore-shaped body, a dark glasshouse, four wheels, and the blue-and-white
 * Sillitoe flank stripe that makes it a *marked* car from further away than the
 * shape does. Two hundred and forty triangles, no fetch, no manifest, no
 * failure mode where the pursuit arrives as an invisible car because a CDN
 * 404'd. It reads as a box car at 10 m and reads as a police car at 60, which
 * is the distance that matters: a patrol car you can see from a block away is
 * the whole point of a 3-star response.
 *
 * The **light bar** was always going to be built here whatever the body was --
 * see section 2 -- and once the light bar is procedural the body being
 * procedural too is what makes them one object with one material and one draw.
 *
 * ---------------------------------------------------------------------------
 * 2. THE LIGHT BAR, AND WHY IT IS TWO MESHES RATHER THAN A SHADER.
 *
 * The bar alternates: red one side, blue the other, swapping about twice a
 * second. Three ways to do that and only one of them is free.
 *
 * A **shader** on an emissive material would mean a node graph with a time
 * uniform, which is a pipeline of its own and something `PipelineWatch` would
 * have to be told about. A **per-frame colour write** would mean touching a
 * material every frame for every car in view. What this does instead is build
 * *both* halves as two meshes of one unlit material and toggle `visible` --
 * which is free, is in no pipeline cache key at all (see `world/nightlights.ts`
 * section 2, which states exactly that rule and the one exception to it: a
 * **light** must never be parented to something whose visibility is toggled,
 * and nothing here is), and gives the hard on/off flash a strobe actually has
 * rather than the sine a shader would tempt somebody into.
 *
 * The lenses are `MeshBasicNodeMaterial`: unlit, so they are the same red at
 * midnight as at noon, which is what a lamp is and is the treatment
 * `world/nightlights.ts` gives every other emissive sprite in this build.
 *
 * ---------------------------------------------------------------------------
 * 3. THE RBT IS ONE MESH FOR ONE ACTOR.
 *
 * `game/heat.ts` puts a single `NPC_KIND.RBT` actor at the site and two
 * ordinary `POLICE` actors beside it. This file draws the actor as a parked car
 * *plus eight witches' hats laid across the road*, all in one geometry, because
 * the cones are a pure function of the site's position and heading and putting
 * eight more actors on the wire to say what one position implies would be 144
 * bytes a snapshot for a traffic cone.
 *
 * The two officers are not drawn here at all. They are real promoted `POLICE`
 * actors, so `world/police.PoliceSquad` -- which already draws every officer in
 * the city -- draws them with no new case and no second rig pool, and a player
 * can hit them, which is the difference between an officer and a bollard.
 *
 * ---------------------------------------------------------------------------
 * 4. POLAIR *WAS* A LIGHT AND A SOUND. IT IS A HELICOPTER NOW, AND THIS SECTION
 *    IS THE ARGUMENT THAT CHANGED.
 *
 * This section used to say: a modelled helicopter is a mesh, a rotor animation, a
 * flight path, a collision exemption and an actor on the wire, and it would be on
 * screen for four seconds at a time because it is above you and you are looking
 * forward -- so Polair is one `SpotLight` 140 m up aimed at the wanted player,
 * with a little lag and a slow sway, plus a disc of light on the road.
 *
 * Four of those five objections were about *cost*, and every one of them was
 * answered by `game/polair.ts` rather than argued with. The flight path is a pure
 * function of `(playerId, tick)` and 240 bytes of position history. The mesh is
 * 268 triangles of procedural boxes, built in this file beside the patrol car's
 * 240, with no fetch and no manifest. There is no collision exemption because
 * nothing in this build asks a helicopter 200 m up about prisms. And there is
 * **still nothing on the wire** -- not one byte -- because both ends compute the
 * same orbit from the same shared clock, which is exactly what `game/traffic.ts`
 * does for eight thousand cars.
 *
 * The fifth objection -- that it is above you and you are looking forward -- was
 * the real one, and it was answered by moving the machine. It is not above you
 * any more. It is **behind you and to one side**, 180-260 m up on a 90-160 m
 * orbit centred on where you were three seconds ago, which puts it at 20-45
 * degrees of elevation: high, but inside the top of a normal field of view when
 * you turn to look at what is chasing you. See `game/polair.ts` section 1.
 *
 * So what this file now draws for the fifth rung is:
 *
 *   - a **dim body**: fuselage, boom, fin, skids, a glasshouse and a spinning
 *     rotor disc, lit by the same standard material the patrol car uses, so at
 *     250 m it is a dark shape against the sky rather than a gap in it;
 *   - **three nav lights**: a red port lamp, a green starboard lamp -- both
 *     steady, because position lights are -- and a white anti-collision strobe
 *     double-flashing on a fixed 1.05 s. The strobes are the thing you actually
 *     *find* it by, and they are the whole of its read by day;
 *   - the **searchlight**: a 7 degree `SpotLight` at 40% of the old intensity
 *     from nearly twice the height, aimed where `polairPose` says it is looking
 *     -- which is the player only during a lock and a figure-of-eight around
 *     where they were the rest of the time;
 *   - a **visible beam**, as an additive cone from the airframe to the ground,
 *     which is what makes the searchlight readable at all now that it is dim and
 *     far. Faded out by day, when a shaft of light in sunlight is a plastic
 *     tube; the body and the strobes carry the daylight read instead;
 *   - the **ground pool**, which now follows the *beam* rather than the player,
 *     so watching the circle of light slide past your feet and come back is the
 *     feature;
 *   - and one **muzzle flash, one puff of grit and one delayed report** per
 *     round, drawn off the same pure shot schedule the authority rolls against.
 *
 * The light is still created once in the constructor and lives in the scene for
 * the session at intensity 0, which is `NightLights`' rule verbatim: a light
 * toggled with `visible` drops off the render list and recompiles the scene. Every
 * *mesh* in here is toggled freely, which costs nothing -- that same file states
 * the distinction.
 *
 * ---------------------------------------------------------------------------
 * 5. WHAT THIS FILE IS TOLD, AND BY WHOM.
 *
 * The fleet takes `update(field, dt, x, z)`. The actor list is whatever `main.ts`
 * has -- `net.actors` online, `FactionField` offline, both iterables of
 * `NpcActor`, which is the same shape `PoliceSquad` and `npcHitTest` already take
 * and is why there is no adapter type anywhere in this feature.
 *
 * Polair takes a **`PolairView` the caller owns and mutates**, rather than the
 * eight positional arguments the growing feature wanted. That is not tidiness: it
 * is `main.ts`' merge surface. Five agents edit that file at once and the rule is
 * one small contiguous block per concern, so the block is a record built once
 * beside the constructor and a handful of field writes in the frame loop -- and
 * the day Polair needs a ninth input, this file changes and `main.ts` does not.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  SpotLight,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import { NPC_KIND, type NpcActor } from '../game/factions.ts';
import { HEAT_MAX } from '../game/heat.ts';
// The orbit, the beam schedule and the shot schedule. Three-free, shared with
// the authority, and the reason nothing about the helicopter is on the wire: this
// file recomputes the identical pose the server rolled the marksman's shot
// against. See that file's header, section 3.
import {
  POLAIR_ALTITUDE_MAX_M,
  POLAIR_ALTITUDE_MIN_M,
  POLAIR_CONE_DEG,
  POLAIR_INTENSITY,
  POLAIR_MISS_MAX_M,
  POLAIR_MISS_MIN_M,
  POLAIR_ROUND_SPEED,
  POLAIR_SOUND_SPEED,
  POLAIR_STROBE_FLASH_S,
  POLAIR_STROBE_PERIOD_S,
  POLAIR_STROBE_SECOND_S,
  POLAIR_ALTITUDE_MIN_M as POLAIR_ALT_MIN,
  POLAIR_FLICKER,
  POLAIR_LOCK_CYCLE_TICKS,
  PolairTrail,
  createPolairPose,
  polairCycle,
  polairMiss,
  polairPose,
  polairShotFired,
  polairShotTick,
} from '../game/polair.ts';

// --- Colours, linear ---------------------------------------------------------------

/**
 * The body. **White, and brighter than any painted car in the traffic.**
 *
 * `world/cars.ts`' palette tops out well under this, deliberately: a highway
 * patrol Commodore is the whitest thing on the road and that is most of how you
 * pick it out of a lane of Camrys at 80 m. 0.86 rather than 1.0 so it still has
 * somewhere to go under direct sun and does not clip to a flat silhouette.
 */
const BODY_WHITE: readonly [number, number, number] = [0.86, 0.87, 0.88];
/** The glasshouse. Dark, and slightly blue, like every other pane in this build. */
const GLASS: readonly [number, number, number] = [0.035, 0.045, 0.06];
/** Tyres and the sills. Not black: nothing in this world is black. */
const RUBBER: readonly [number, number, number] = [0.025, 0.025, 0.028];
/** The Sillitoe flank, in `world/police.ts`' own two colours. */
const CHEQUER_LIGHT: readonly [number, number, number] = [0.82, 0.85, 0.88];
const CHEQUER_BLUE: readonly [number, number, number] = [0.05, 0.14, 0.44];
/** The bar's housing, and the two lenses. The lenses are unlit; see section 2. */
const BAR_HOUSING: readonly [number, number, number] = [0.03, 0.03, 0.035];
const LENS_RED: readonly [number, number, number] = [1.0, 0.06, 0.05];
const LENS_BLUE: readonly [number, number, number] = [0.06, 0.2, 1.0];
/** A witches' hat. Traffic orange over a black base. */
const CONE_ORANGE: readonly [number, number, number] = [0.95, 0.18, 0.02];
const CONE_BASE: readonly [number, number, number] = [0.03, 0.03, 0.03];

/**
 * The airframe. **Dark, and darker than anything else this file draws.**
 *
 * The real Polair fleet is white and blue, and painting this one white was the
 * first thing tried. It was wrong for a reason worth writing down: at 250 m,
 * against a night sky, a white body is a bright blob that reads as a lens flare
 * or a moon, and against a *daylit* sky it is invisible because the sky is
 * brighter still. A dark body is a **silhouette** in both -- a hole in the sky by
 * day and a shape occluding stars by night -- which is what a helicopter at that
 * range actually looks like from the ground, and it is what lets the three nav
 * lights be the thing you find it by. The blue is 0.06 rather than flat grey so
 * it sits in the same family as the patrol car's glasshouse.
 */
const HELI_BODY: readonly [number, number, number] = [0.055, 0.06, 0.075];
/** The glasshouse, and the rotor disc's smear. Both darker again. */
const HELI_GLASS: readonly [number, number, number] = [0.02, 0.025, 0.035];
const ROTOR_SMEAR: readonly [number, number, number] = [0.10, 0.11, 0.13];
/** Port red, starboard green, and the white anti-collision strobe. Unlit lamps. */
const NAV_RED: readonly [number, number, number] = [1.0, 0.05, 0.03];
const NAV_GREEN: readonly [number, number, number] = [0.05, 1.0, 0.12];
const NAV_WHITE: readonly [number, number, number] = [1.0, 0.98, 0.92];

// --- The helicopter's dimensions, metres -------------------------------------------

/**
 * An EC135 -- which is what the real Polair flies -- is 12.2 m over the tail with
 * a 10.2 m rotor and stands 3.5 m. These are those, rounded.
 *
 * Built at **true scale** rather than exaggerated, and the temptation to scale it
 * up was real: 12 m at 250 m subtends about three degrees, which sounds like
 * nothing. It is not nothing -- three degrees is a sixtieth of a 1080p screen's
 * height, sixty-odd pixels -- and a helicopter drawn at twice life size reads
 * instantly as *close and small* rather than as far and big, which would undo the
 * whole "much further" the orbit was moved for.
 */
const HELI_LENGTH = 9.2;
const HELI_WIDTH = 1.9;
const HELI_HEIGHT = 1.8;
/** The tail boom's length past the cabin, and the rotor's radius. */
const HELI_BOOM = 3.4;
const ROTOR_RADIUS = 5.1;
/** How fast the main rotor turns, radians a second. 395 rpm, which is an EC135's. */
export const ROTOR_RATE = 41;

// --- The car's dimensions, metres --------------------------------------------------

/**
 * A VF Commodore is 4.97 x 1.90 x 1.47. These are those, rounded, and they are
 * the numbers the *hit* radius in `game/heat.ts` is set against -- see
 * `PATROL_HIT_M` there, which is half this length plus a body.
 */
const CAR_LENGTH = 4.9;
const CAR_WIDTH = 1.9;
const CAR_HEIGHT = 1.45;
/** Where the glasshouse starts and stops along the body, as fractions of length. */
const CABIN_FRONT = 0.12;
const CABIN_BACK = 0.62;
/** Wheel radius, and how far in from the flank they sit. */
const WHEEL_R = 0.34;
const WHEEL_INSET = 0.06;

/** The light bar. Slim, wide, and it sits on the roof rather than in it. */
const BAR_WIDTH = 1.15;
const BAR_DEPTH = 0.24;
const BAR_HEIGHT = 0.13;

/** A witches' hat: 0.45 m of orange over a 0.36 m base, which is the real thing. */
const CONE_HEIGHT = 0.45;
const CONE_BASE_HALF = 0.18;
/** How many hats an RBT lays out, and how far apart across the road. */
export const RBT_CONES = 8;
export const RBT_CONE_PITCH = 1.6;

// --- Geometry accumulator ----------------------------------------------------------

/**
 * The same little accumulator `world/police.Parts` is, copied rather than
 * imported for the reason that one is copied from `world/birds.ts`: it is
 * thirty lines, it is not a shared abstraction anybody maintains, and a
 * `world/parts.ts` that four renderers imported would be a file whose winding
 * rules had to serve a cap, a seagull, a bottle and a car at once.
 *
 * The winding is the whole of what `verifyHighwayPatrol` checks about the
 * geometry, because a quad wound the other way is invisible from the side you
 * are looking at and perfectly solid from the side you are not -- which on a
 * car body reads as z-fighting rather than as a backwards triangle.
 */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];
  /**
   * Quads `facing` could not orient: degenerate ones, whose two edges are
   * parallel and whose cross product is therefore zero, so there is no winding
   * that faces anywhere.
   *
   * Counted rather than thrown, and reported by `verifyHighwayPatrol` at boot,
   * because a degenerate quad is not an error at build time -- it draws as
   * nothing, which is precisely the failure this project's checks exist for. A
   * body assembled from constants that happened to collapse (a wheel inset
   * wider than the car, a cabin whose front is behind its back) would produce
   * a car with a face quietly missing and no exception anywhere.
   */
  degenerate = 0;

  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: readonly [number, number, number],
  ): void {
    const base = this.position.length / 3;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (const p of [a, b, c, d]) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(nx, ny, nz);
      this.colour.push(colour[0], colour[1], colour[2]);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * One quad, emitted in whichever winding makes it face the way you said.
   *
   * **The winding is derived rather than typed out**, and that is a deliberate
   * departure from `world/police.Parts`, which hand-winds its cap and band and
   * spends a paragraph on getting the ring's direction right. That works for
   * two shapes. This file has a body, a glasshouse, a roof panel, sills, four
   * wheels, a light bar, two lens halves, eight cone bases and thirty-two cone
   * faces -- and a hand-wound quad is a coin flip that only shows up as a
   * *hole in one flank, visible from the kerb and from nowhere else*.
   *
   * The first cut of this file did type them out and got 124 of the body's 256
   * vertices backwards, which `verifyHighwayPatrol` caught at boot -- so the
   * check works, and the right answer to a check that keeps catching you is to
   * make the mistake unrepresentable. You say which way is out; this picks the
   * order. It costs a dot product per quad, at build time, once.
   */
  facing(
    outward: readonly [number, number, number],
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: readonly [number, number, number],
  ): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const dot = nx * outward[0] + ny * outward[1] + nz * outward[2];
    // Zero in both windings: the quad has no plane, so it faces nowhere and
    // will draw as nothing. Counted; see `degenerate`.
    if (nx * nx + ny * ny + nz * nz < 1e-12) this.degenerate++;
    if (dot >= 0) this.quad(a, b, c, d, colour);
    else this.quad(d, c, b, a, colour);
  }

  /** An axis-aligned box, outward on all six faces. See `facing`. */
  box(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    colour: readonly [number, number, number],
  ): void {
    this.facing([0, 1, 0], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], colour);
    this.facing([0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour);
    this.facing([0, 0, -1], [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], colour);
    this.facing([0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour);
    this.facing([1, 0, 0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], colour);
    this.facing([-1, 0, 0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour);
  }

  /**
   * A flat horizontal disc at height `y`, as a fan of `sides` quads about the
   * origin. Used for the Polair ground pool and for the rotor's smear.
   *
   * A fan rather than a quad because a **square** of light on the road reads as a
   * projected texture that failed to load, and the pool is the whole of this
   * feature's daylight presentation. The two apex corners are the same point,
   * which keeps the index layout uniform at four vertices a face -- see `cone`,
   * which does the same thing for the same reason.
   */
  fan(y: number, radius: number, sides: number, colour: readonly [number, number, number]): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      this.facing(
        [0, 1, 0],
        [0, y, 0],
        [Math.sin(a0) * radius, y, Math.cos(a0) * radius],
        [Math.sin(a1) * radius, y, Math.cos(a1) * radius],
        [0, y, 0],
        colour,
      );
    }
  }

  /**
   * An open cone: apex at the origin, opening along **-Z**, base a unit circle at
   * `z = -1`. No cap. The searchlight's visible shaft.
   *
   * -Z and unit length so that placing it is one `lookAt` and one non-uniform
   * scale, which is exactly the trick `world/police.Tracers` plays with its
   * one-metre box -- and it works for the same reason: `Object3D.lookAt` aims the
   * local -Z axis at the point you give it.
   */
  shell(sides: number, colour: readonly [number, number, number]): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = Math.sin(a0);
      const y0 = Math.cos(a0);
      const x1 = Math.sin(a1);
      const y1 = Math.cos(a1);
      // Outward is the mid-edge's own radial. The material is double-sided, so
      // the winding decides the normal rather than the visibility -- but a
      // consistent one keeps `verifyOutward` meaningful if anybody ever probes it.
      this.facing(
        [(x0 + x1) / 2, (y0 + y1) / 2, 0],
        [0, 0, 0], [x0, y0, -1], [x1, y1, -1], [0, 0, 0],
        colour,
      );
    }
  }

  /** A square pyramid on the ground plane, apex up. A witches' hat. */
  cone(cx: number, cz: number, half: number, height: number, colour: readonly [number, number, number]): void {
    const corners: Array<[number, number]> = [
      [cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      // Outward is the edge's own midpoint away from the axis. Apex twice, so
      // it is still a quad and the index layout stays uniform.
      this.facing(
        [(ax + bx) / 2 - cx, 0.3, (az + bz) / 2 - cz],
        [ax, 0, az], [bx, 0, bz], [cx, height, cz], [cx, height, cz],
        colour,
      );
    }
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colour), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    g.computeBoundingSphere();
    return g;
  }

  get triangles(): number {
    return this.index.length / 3;
  }
}

/**
 * A marked sedan, built about its own centre with **-Z as the nose**.
 *
 * -Z is forward everywhere in this project -- `player/controller.ts`'s movement
 * basis, `world/people.ts`' figures and `world/cars.ts`' boxes all agree -- so a
 * body built any other way would need a yaw correction at every draw and would
 * be a bug the first time somebody forgot one.
 */
function buildBody(): Parts {
  const p = new Parts();
  const hw = CAR_WIDTH / 2;
  const hl = CAR_LENGTH / 2;
  const sill = WHEEL_R * 0.55;
  const waist = CAR_HEIGHT * 0.52;

  // The lower body, from the sills to the waistline.
  p.box(-hw, sill, -hl, hw, waist, hl, BODY_WHITE);
  // The glasshouse, inset and darker, from the waist to the roof.
  const gw = hw * 0.88;
  p.box(-gw, waist, -hl + CAR_LENGTH * CABIN_FRONT, gw, CAR_HEIGHT, -hl + CAR_LENGTH * CABIN_BACK, GLASS);
  // A white roof panel over it, so the cabin is not a black slab from above --
  // which is the only angle a player in third person actually sees it from.
  p.box(
    -gw, CAR_HEIGHT - 0.03, -hl + CAR_LENGTH * (CABIN_FRONT + 0.06),
    gw, CAR_HEIGHT, -hl + CAR_LENGTH * (CABIN_BACK - 0.06),
    BODY_WHITE,
  );
  // The sills, which are what stop the body floating over its wheels.
  p.box(-hw * 0.96, 0.06, -hl * 0.92, hw * 0.96, sill, hl * 0.92, RUBBER);

  // Four wheels, as boxes. A cylinder is 12 quads a wheel for a shape that is
  // 0.34 m across and is under the car; `world/cars.ts` makes the same call.
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const cx = side * (hw - WHEEL_INSET);
      const cz = end * hl * 0.62;
      p.box(
        cx - 0.11 * side - (side < 0 ? 0.11 : 0), 0.02, cz - WHEEL_R,
        cx + 0.11 * side + (side > 0 ? 0.11 : 0), WHEEL_R * 1.6, cz + WHEEL_R,
        RUBBER,
      );
    }
  }

  // The Sillitoe flank: alternating squares along the waistline, both sides,
  // proud of the body by a centimetre so it cannot z-fight with it.
  const cells = 8;
  const cellLen = (CAR_LENGTH * 0.78) / cells;
  const y0 = waist - 0.30;
  const y1 = waist - 0.06;
  for (let i = 0; i < cells; i++) {
    const z0 = -CAR_LENGTH * 0.39 + i * cellLen;
    const z1 = z0 + cellLen;
    const c = i & 1 ? CHEQUER_BLUE : CHEQUER_LIGHT;
    p.facing([1, 0, 0], [hw + 0.01, y0, z0], [hw + 0.01, y0, z1], [hw + 0.01, y1, z1], [hw + 0.01, y1, z0], c);
    p.facing([-1, 0, 0], [-hw - 0.01, y0, z0], [-hw - 0.01, y0, z1], [-hw - 0.01, y1, z1], [-hw - 0.01, y1, z0], c);
  }
  return p;
}

/** The bar's housing: the dark plinth the two lenses sit in. */
function buildBarHousing(): Parts {
  const p = new Parts();
  const roofZ = -CAR_LENGTH / 2 + CAR_LENGTH * ((CABIN_FRONT + CABIN_BACK) / 2);
  p.box(
    -BAR_WIDTH / 2, CAR_HEIGHT, roofZ - BAR_DEPTH / 2,
    BAR_WIDTH / 2, CAR_HEIGHT + 0.045, roofZ + BAR_DEPTH / 2,
    BAR_HOUSING,
  );
  return p;
}

/**
 * One half of the light bar's lenses, `side` being -1 or +1 across the car.
 *
 * Two geometries rather than one with a colour attribute, because the strobe is
 * a `visible` toggle and a toggle needs two objects. See section 2.
 */
function buildLens(side: number, colour: readonly [number, number, number]): Parts {
  const p = new Parts();
  const roofZ = -CAR_LENGTH / 2 + CAR_LENGTH * ((CABIN_FRONT + CABIN_BACK) / 2);
  const x0 = side < 0 ? -BAR_WIDTH / 2 : 0.02;
  const x1 = side < 0 ? -0.02 : BAR_WIDTH / 2;
  p.box(
    x0, CAR_HEIGHT + 0.045, roofZ - BAR_DEPTH / 2 + 0.02,
    x1, CAR_HEIGHT + 0.045 + BAR_HEIGHT, roofZ + BAR_DEPTH / 2 - 0.02,
    colour,
  );
  return p;
}

/**
 * The RBT's furniture: the same car, parked, plus a line of witches' hats laid
 * **across** the site's heading.
 *
 * The site actor's heading is the *road's* direction -- `game/heat.placeRbt`
 * takes it off the lane polyline rather than off the player, because a road that
 * crosses your path at an angle still has to be blocked along its own width. So
 * the cones run along local X here (which is across the car) and the car sits
 * skewed at the end of them, which is exactly how one of these is set up on a
 * real arterial: the car half-blocking a lane and the hats funnelling into it.
 */
function buildRbtProps(): Parts {
  const p = new Parts();
  const span = (RBT_CONES - 1) * RBT_CONE_PITCH;
  for (let i = 0; i < RBT_CONES; i++) {
    const x = -span / 2 + i * RBT_CONE_PITCH;
    // A black base disc under each hat, so it does not appear to float on a
    // cambered road. Two triangles' worth and it is the thing that sells them.
    p.box(x - CONE_BASE_HALF, 0, -CONE_BASE_HALF, x + CONE_BASE_HALF, 0.04, CONE_BASE_HALF, CONE_BASE);
    p.cone(x, 0, CONE_BASE_HALF * 0.82, CONE_HEIGHT, CONE_ORANGE);
  }
  return p;
}

/**
 * The airframe, built about the rotor hub with **-Z as the nose**.
 *
 * -Z forward for the reason `buildBody` states: every body in this project is
 * built nose-along -Z, so `placeByHeading`'s `atan2(-dx, -dz)` works on all of
 * them and nobody has to remember a per-object correction. The **origin is the
 * hub** rather than the skids, because the thing that has to be placed accurately
 * is where the beam comes from and where the machine rotates about, and a
 * helicopter 200 m up is never seen resting on anything.
 *
 * Nine boxes. Every one of them is a box on purpose: at three degrees of arc a
 * rounded fuselage and a boxy one are the same handful of dark pixels, and the
 * silhouette -- long, low, with a thin boom and a fin -- is the entire read.
 */
function buildHeliBody(): Parts {
  const p = new Parts();
  const hw = HELI_WIDTH / 2;
  // The cabin, hung below the hub: a helicopter's mass is under its rotor.
  const cabinFront = -HELI_LENGTH * 0.42;
  const cabinBack = HELI_LENGTH * 0.14;
  p.box(-hw, -HELI_HEIGHT, cabinFront, hw, 0.12, cabinBack, HELI_BODY);
  // The glasshouse: the front third of the cabin, inset, and much darker. It is
  // what makes the nose read as a nose rather than as the blunt end of a box.
  p.box(
    -hw * 0.86, -HELI_HEIGHT * 0.86, cabinFront + 0.05,
    hw * 0.86, -HELI_HEIGHT * 0.18, cabinFront + HELI_LENGTH * 0.20,
    HELI_GLASS,
  );
  // The hub fairing, so the rotor is not a disc floating over a gap.
  p.box(-0.42, 0.12, -0.5, 0.42, 0.46, 0.5, HELI_BODY);
  // The tail boom, thin, and the fin and stabiliser at the end of it. The fin is
  // the single most recognisable part of a helicopter's outline from below.
  p.box(-0.22, -0.34, cabinBack, 0.22, 0.1, cabinBack + HELI_BOOM, HELI_BODY);
  p.box(-0.07, -0.2, cabinBack + HELI_BOOM - 0.5, 0.07, 1.25, cabinBack + HELI_BOOM, HELI_BODY);
  p.box(-1.0, -0.16, cabinBack + HELI_BOOM - 0.75, 1.0, -0.04, cabinBack + HELI_BOOM - 0.45, HELI_BODY);
  // Skids: two rails and two struts a side, as one box each. Under the machine
  // and almost never seen, and they are the difference between a helicopter and
  // a hovering brick when it does bank.
  for (const side of [-1, 1]) {
    const x = side * hw * 0.92;
    p.box(x - 0.07, -HELI_HEIGHT - 0.62, cabinFront + 0.3, x + 0.07, -HELI_HEIGHT - 0.48, cabinBack - 0.2, HELI_BODY);
    p.box(x - 0.06, -HELI_HEIGHT - 0.5, cabinFront + 0.8, x + 0.06, -HELI_HEIGHT + 0.02, cabinFront + 0.92, HELI_BODY);
  }
  return p;
}

/**
 * The main rotor, as a flat disc at hub height, and the tail rotor as a smaller
 * one standing on end.
 *
 * A **disc, not blades**, and the choice is about what a spinning rotor actually
 * looks like: past a couple of hundred rpm the eye integrates the blades into a
 * translucent smear, and four modelled blades rotated at 41 rad/s on a 60 Hz
 * display would strobe and read as two blades turning slowly backwards. The disc
 * is rotated anyway -- at `ROTOR_RATE` -- because the faint radial banding in the
 * fan's own triangulation is enough to make it read as *turning* without ever
 * being a countable blade.
 *
 * Additive and faint, on `discMaterial`'s own settings, so it lightens the sky
 * behind it rather than being a grey plate.
 */
function buildRotorDisc(): Parts {
  const p = new Parts();
  p.fan(0, ROTOR_RADIUS, 20, ROTOR_SMEAR);
  return p;
}

/** One nav lamp: a 24 cm cube at the origin, positioned by its own mesh. */
function buildNavLamp(colour: readonly [number, number, number]): Parts {
  const p = new Parts();
  p.box(-0.12, -0.12, -0.12, 0.12, 0.12, 0.12, colour);
  return p;
}

/** The searchlight's visible shaft. Apex at the origin, opening along -Z. */
function buildBeamCone(): Parts {
  const p = new Parts();
  p.shell(18, [1, 1, 1]);
  return p;
}

// --- Assets --------------------------------------------------------------------------

/**
 * Every geometry and material this feature draws with, built once and shared.
 *
 * `world/police.PoliceAssets`' contract with the same consequence for teardown:
 * a fleet must never dispose these, because every other patrol car is drawing
 * them.
 */
export class HighwayPatrolAssets {
  readonly body: BufferGeometry;
  readonly barHousing: BufferGeometry;
  readonly lensLeftRed: BufferGeometry;
  readonly lensRightBlue: BufferGeometry;
  readonly lensLeftBlue: BufferGeometry;
  readonly lensRightRed: BufferGeometry;
  readonly rbtProps: BufferGeometry;
  /** Lit, vertex-coloured, flat-shaded. `PoliceAssets.material`'s settings. */
  readonly material: MeshStandardNodeMaterial;
  /** Unlit, for the lenses and the Polair disc. A lamp is the same at midnight. */
  readonly lamp: MeshBasicNodeMaterial;
  readonly discMaterial: MeshBasicNodeMaterial;
  readonly disc: BufferGeometry;
  // --- Polair's airframe. See section 4.
  readonly heliBody: BufferGeometry;
  readonly rotorDisc: BufferGeometry;
  readonly navRed: BufferGeometry;
  readonly navGreen: BufferGeometry;
  readonly navWhite: BufferGeometry;
  readonly beamCone: BufferGeometry;
  /**
   * The two additive materials the beam and the rotor smear share, and the one
   * the muzzle flash and the grit puff share.
   *
   * Separate instances rather than one, because each is written every frame with a
   * *different* opacity -- the beam's tracks the flicker, the rotor's is constant,
   * the puff's is a decay -- and a shared material would mean whichever wrote last
   * won. `Polair` holds them by their concrete type for the same reason
   * `discMaterial` is held that way; see there.
   */
  readonly beamMaterial: MeshBasicNodeMaterial;
  readonly rotorMaterial: MeshBasicNodeMaterial;
  readonly flashMaterial: MeshBasicNodeMaterial;
  readonly puffMaterial: MeshBasicNodeMaterial;
  /** How many triangles the whole Polair airframe is. `verifyHighwayPatrol` caps it. */
  readonly heliTriangles: number;
  readonly triangles: number;
  /** Quads that could not be oriented at build. Must be zero; see `Parts.degenerate`. */
  readonly degenerate: number;

  constructor() {
    const body = buildBody();
    const housing = buildBarHousing();
    const rbt = buildRbtProps();
    this.body = body.build('patrol-body');
    this.barHousing = housing.build('patrol-bar');
    // Four lens geometries for two strobe phases: red left / blue right, and
    // then the other way round. Two `visible` toggles a flash, and a lens that
    // is off is genuinely not drawn rather than drawn dark -- which matters,
    // because an unlit material has no shading and a "dark" lens would be a
    // flat maroon rectangle rather than an absence.
    this.lensLeftRed = buildLens(-1, LENS_RED).build('patrol-lens-lr');
    this.lensRightBlue = buildLens(1, LENS_BLUE).build('patrol-lens-rb');
    this.lensLeftBlue = buildLens(-1, LENS_BLUE).build('patrol-lens-lb');
    this.lensRightRed = buildLens(1, LENS_RED).build('patrol-lens-rr');
    this.rbtProps = rbt.build('rbt-props');

    // The Polair ground disc: a flat fan, unlit and additive, laid a few
    // centimetres over whatever it lands on. A fan rather than a quad because a
    // square of light on the road would read as a projected texture missing its
    // texture, and the whole point of the disc is that it works **by day**,
    // when there is no visible cone above it.
    // Unit radius; the mesh is scaled to the cone's footprint at update.
    const disc = new Parts();
    disc.fan(0, 1, 24, [1, 1, 1]);
    this.disc = disc.build('polair-disc');

    // --- Polair's airframe, its rotor, its three lamps and its beam.
    const heli = buildHeliBody();
    const rotor = buildRotorDisc();
    const red = buildNavLamp(NAV_RED);
    const green = buildNavLamp(NAV_GREEN);
    const white = buildNavLamp(NAV_WHITE);
    const beam = buildBeamCone();
    this.heliBody = heli.build('polair-body');
    this.rotorDisc = rotor.build('polair-rotor');
    this.navRed = red.build('polair-nav-red');
    this.navGreen = green.build('polair-nav-green');
    this.navWhite = white.build('polair-nav-white');
    this.beamCone = beam.build('polair-beam');
    // The beam shaft counts too. It is a light effect rather than part of the
    // airframe, and it is inside the budget anyway -- but the budget exists to stop
    // somebody deciding the helicopter deserves a proper model, and "the cone does
    // not count" is exactly the loophole that argument would take.
    this.heliTriangles = heli.triangles + rotor.triangles + beam.triangles
      + red.triangles + green.triangles + white.triangles;

    const material = new MeshStandardNodeMaterial();
    material.name = 'highway-patrol';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.42;
    material.metalness = 0.15;
    material.flatShading = true;
    this.material = material;

    const lamp = new MeshBasicNodeMaterial();
    lamp.name = 'highway-patrol-lamp';
    lamp.vertexColors = true;
    lamp.color = new Color(1, 1, 1);
    lamp.toneMapped = false;
    this.lamp = lamp;

    const discMaterial = new MeshBasicNodeMaterial();
    discMaterial.name = 'polair-disc';
    discMaterial.vertexColors = true;
    discMaterial.color = new Color(1, 1, 0.94);
    discMaterial.transparent = true;
    discMaterial.opacity = 0;
    discMaterial.depthWrite = false;
    discMaterial.blending = AdditiveBlending;
    discMaterial.side = DoubleSide;
    discMaterial.toneMapped = false;
    this.discMaterial = discMaterial;

    // The beam, the rotor smear, the muzzle flash and the grit puff: four more of
    // exactly the same additive unlit material, each with its own opacity written
    // per frame. See the field docs for why they are not one object.
    this.beamMaterial = additive('polair-beam', 0.94, 0.96, 1.0);
    this.rotorMaterial = additive('polair-rotor', 0.5, 0.55, 0.62);
    this.flashMaterial = additive('polair-flash', 1.0, 0.86, 0.6);
    // Grit off bitumen: warm grey rather than white, so it reads as dust kicked up
    // and not as a second little searchlight on the road.
    this.puffMaterial = additive('polair-puff', 0.72, 0.68, 0.6);

    this.triangles = body.triangles + housing.triangles + rbt.triangles + this.heliTriangles;
    this.degenerate = body.degenerate + housing.degenerate + rbt.degenerate + disc.degenerate
      + heli.degenerate + rotor.degenerate + beam.degenerate;
  }
}

/**
 * One additive, unlit, non-depth-writing material.
 *
 * Factored out because there are now four of them and the settings are a *set*:
 * every one of `transparent`, `depthWrite`, `blending`, `side` and `toneMapped`
 * has to be right or the object either occludes what is behind it, disappears
 * behind glass, or gets graded by the tone mapper into a grey smudge -- and four
 * hand-copied blocks is four chances to leave one out. `world/nightlights.ts`
 * makes the same consolidation for its sprites.
 */
function additive(name: string, r: number, g: number, b: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = name;
  m.vertexColors = true;
  m.color = new Color(r, g, b);
  m.transparent = true;
  m.opacity = 0;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.side = DoubleSide;
  m.toneMapped = false;
  return m;
}

// --- The fleet --------------------------------------------------------------------------

/**
 * How many patrol cars and RBTs are held.
 *
 * A **frame** budget, not the wire's, exactly as `police.SQUAD_CAPACITY` is:
 * `factions.MAX_ACTORS` bounds what crosses the network and this bounds what is
 * drawn. Four and two, because `game/heat.PATROL_CARS_PER_SUSPECT` is one and a
 * player is only ever given one RBT at a time -- so these are only reachable in
 * a room where several people are simultaneously at 3 and 4 stars, and the
 * honest answer to the fifth car in view is that you have bigger problems.
 */
export const PATROL_CAPACITY = 4;
export const RBT_CAPACITY = 2;
/** How far these are drawn, metres. `police.POLICE_DRAW_RADIUS`, and for its reason. */
export const PATROL_DRAW_RADIUS = 260;

/** The strobe, in seconds per half-cycle. Twice a second, which is what a bar does. */
export const STROBE_PERIOD = 0.25;

/** One pooled car: a body, a bar, and the four lenses two of which are on. */
interface CarSlot {
  group: Object3D;
  lensLeftRed: Mesh;
  lensRightBlue: Mesh;
  lensLeftBlue: Mesh;
  lensRightRed: Mesh;
}

/**
 * Every patrol car and RBT in view, as pooled meshes.
 *
 * `update` allocates nothing. Not parented to a tile, on `PoliceSquad`'s own
 * argument: a patrol car crosses a tile boundary every few seconds and the fleet
 * is drawn as one set for the whole visible world.
 */
export class HighwayPatrolFleet {
  /** Add these to the scene. */
  readonly group = new Object3D();

  /** Drawn last update. Read by the HUD's police line. */
  cars = 0;
  rbts = 0;

  private readonly carSlots: CarSlot[] = [];
  private readonly rbtSlots: Object3D[] = [];
  private clock = 0;

  constructor(assets: HighwayPatrolAssets) {
    this.group.name = 'highway-patrol';
    for (let i = 0; i < PATROL_CAPACITY; i++) {
      const group = new Object3D();
      group.name = `patrol:${i}`;
      group.visible = false;
      const body = new Mesh(assets.body, assets.material);
      body.castShadow = true;
      body.receiveShadow = false;
      const bar = new Mesh(assets.barHousing, assets.material);
      bar.castShadow = true;
      const slot: CarSlot = {
        group,
        lensLeftRed: new Mesh(assets.lensLeftRed, assets.lamp),
        lensRightBlue: new Mesh(assets.lensRightBlue, assets.lamp),
        lensLeftBlue: new Mesh(assets.lensLeftBlue, assets.lamp),
        lensRightRed: new Mesh(assets.lensRightRed, assets.lamp),
      };
      group.add(body, bar, slot.lensLeftRed, slot.lensRightBlue, slot.lensLeftBlue, slot.lensRightRed);
      this.carSlots.push(slot);
      this.group.add(group);
    }
    for (let i = 0; i < RBT_CAPACITY; i++) {
      const group = new Object3D();
      group.name = `rbt:${i}`;
      group.visible = false;
      const props = new Mesh(assets.rbtProps, assets.material);
      props.castShadow = true;
      props.receiveShadow = false;
      // The RBT's own car, parked skewed across the end of the cone line. The
      // 0.35 rad is a car pulled up at an angle rather than parked neatly, which
      // is what a breath test on an arterial looks like and is one number.
      const car = new Mesh(assets.body, assets.material);
      car.castShadow = true;
      car.position.set((RBT_CONES * RBT_CONE_PITCH) / 2 + 1.6, 0, 1.4);
      car.rotation.y = 0.35;
      const bar = new Mesh(assets.barHousing, assets.material);
      bar.position.copy(car.position);
      bar.rotation.y = car.rotation.y;
      const lens = new Mesh(assets.lensLeftRed, assets.lamp);
      lens.position.copy(car.position);
      lens.rotation.y = car.rotation.y;
      const lens2 = new Mesh(assets.lensRightBlue, assets.lamp);
      lens2.position.copy(car.position);
      lens2.rotation.y = car.rotation.y;
      group.add(props, car, bar, lens, lens2);
      this.rbtSlots.push(group);
      this.group.add(group);
    }
  }

  /**
   * Place every patrol car and RBT in view.
   *
   * `field` is whatever the caller has -- `net.actors` online, `FactionField`
   * offline. `dt` drives the strobe and nothing else; the *positions* come from
   * the authority, which is `main.ts`' rule about every actor in this project.
   */
  update(field: { actors: Iterable<NpcActor> }, dt: number, x: number, z: number): void {
    this.clock += dt;
    // A hard alternation rather than a wave. See section 2.
    const phase = Math.floor(this.clock / STROBE_PERIOD) & 1;
    const r2 = PATROL_DRAW_RADIUS * PATROL_DRAW_RADIUS;

    let cars = 0;
    let rbts = 0;
    for (const a of field.actors) {
      const isCar = a.kind === NPC_KIND.HIGHWAY_PATROL;
      const isRbt = a.kind === NPC_KIND.RBT;
      if (!isCar && !isRbt) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (isCar) {
        if (cars >= PATROL_CAPACITY) continue;
        const slot = this.carSlots[cars++];
        slot.group.visible = true;
        placeByHeading(slot.group, a);
        slot.lensLeftRed.visible = phase === 0;
        slot.lensRightBlue.visible = phase === 0;
        slot.lensLeftBlue.visible = phase === 1;
        slot.lensRightRed.visible = phase === 1;
      } else {
        if (rbts >= RBT_CAPACITY) continue;
        const group = this.rbtSlots[rbts++];
        group.visible = true;
        placeByHeading(group, a);
      }
    }
    for (let i = cars; i < this.carSlots.length; i++) this.carSlots[i].group.visible = false;
    for (let i = rbts; i < this.rbtSlots.length; i++) this.rbtSlots[i].visible = false;
    this.cars = cars;
    this.rbts = rbts;
  }
}

/**
 * Put an object at an actor's feet, facing the actor's heading.
 *
 * `atan2` and nothing else: the actor carries a unit `(dx, dz)` because
 * `game/factions.ts`'s rule 5 keeps angles off anything that crosses the wire,
 * and turning that pair into the yaw a renderer wants is exactly the one place
 * that file permits the call -- see its `encodeSnapshot` note. Bodies are built
 * nose-along -Z, which is `Math.atan2(-dx, -dz)`.
 */
function placeByHeading(obj: Object3D, a: NpcActor): void {
  obj.position.set(a.x, a.y, a.z);
  obj.rotation.y = Math.atan2(-a.dx, -a.dz);
}

// --- Polair ------------------------------------------------------------------------------

/**
 * How long the beam takes to come up and go down, seconds.
 *
 * Longer than the old 0.8 -- a searchlight from 250 m is a machine arriving on
 * station rather than a switch being flicked, and the fade is also what covers
 * the first second of the orbit, during which the trail is still back-filled with
 * one point and the machine is flying a circle around where you were standing
 * when it appeared. See `polair.PolairTrail.push`.
 */
export const POLAIR_FADE = 1.4;

/**
 * How strong the ground pool, the beam shaft and the rotor smear are.
 *
 * The pool is a **third** rather than the old sixth, and the beam shaft is new,
 * because the `SpotLight` itself now delivers about a fifth of the light it used
 * to -- forty per cent of the intensity from nearly twice the height. Something
 * had to take up the slack or "dimmer and further" would have meant "gone", and
 * the honest place to put it is the two additive objects that cost nothing and
 * are not lighting anything: a pool of light on the road and a visible shaft of
 * air. Those are what a searchlight looks like in a photograph; the `SpotLight` is
 * what it does to the things it lands on.
 */
export const POLAIR_DISC_OPACITY = 0.32;
export const POLAIR_BEAM_OPACITY = 0.085;
export const POLAIR_ROTOR_OPACITY = 0.10;

/** The muzzle flash's life, seconds, and the grit puff's. Both very short. */
export const POLAIR_FLASH_S = 0.07;
export const POLAIR_PUFF_S = 0.5;
/** How wide the grit puff spreads by the end of its life, metres. */
export const POLAIR_PUFF_R = 1.5;

/**
 * Where the three nav lamps sit on the airframe, local metres, and where the
 * searchlight comes out of it.
 *
 * Port red and starboard green on the cabin flanks and the white anti-collision
 * strobe on top of the fin, which is where they are on a real one -- and the fin
 * matters, because it is the highest point and therefore the lamp that stays
 * visible when the machine banks away from you.
 */
const NAV_PORT: readonly [number, number, number] = [-HELI_WIDTH / 2 - 0.06, -HELI_HEIGHT * 0.55, -HELI_LENGTH * 0.3];
const NAV_STARBOARD: readonly [number, number, number] = [HELI_WIDTH / 2 + 0.06, -HELI_HEIGHT * 0.55, -HELI_LENGTH * 0.3];
const NAV_TAIL: readonly [number, number, number] = [0, 1.34, HELI_LENGTH * 0.14 + HELI_BOOM - 0.25];
/** The searchlight's gimbal, under the nose. Vertical offset only; see `update`. */
const LAMP_DROP = 1.6;

/**
 * The searchlight's own falloff.
 *
 * `decay` stays at the old build's 1.1 rather than going to a physical 2, and the
 * reason is worth stating because 1.1 looks like a mistake: at 250 m an
 * inverse-square light needs six figures of intensity to put anything at all on
 * the road, and this feature has just been told to be *dimmer*. 1.1 is the
 * compromise the old build already made from 140 m and it has to hold at 250.
 *
 * `distance` is the cutoff, and it must clear the longest slant the orbit can
 * produce -- otherwise the beam simply stops in mid-air on the far side of the
 * ellipse, which reads as the light failing rather than as a range limit.
 */
const LIGHT_DECAY = 1.1;
const LIGHT_DISTANCE = POLAIR_ALTITUDE_MAX_M * 1.7;

/**
 * What the frame loop tells `Polair.update`.
 *
 * A record the caller builds once and mutates, rather than eight positional
 * arguments, for the reason section 5 gives: `main.ts` is edited by five agents
 * at once and this keeps the frame-loop block to a handful of field writes that
 * never has to change again.
 */
export interface PolairView {
  /** The shared wall-clock tick. `traffic.trafficTick(Date.now())`, as everywhere. */
  tick: number;
  /** Frame delta, seconds. Drives the fade, the rotor and the shot timers only. */
  dt: number;
  /** True while the local player is at the top rung. */
  on: boolean;
  /**
   * Whose helicopter this is -- the id **the authority knows them by**, which is
   * `net.id` online and the offline combatant's id otherwise.
   *
   * Every deterministic choice about the orbit, the lock schedule and the scatter
   * is hashed off this, so a client that passed its own local id online would draw
   * a machine flying a different circle from the one the server shot at it with.
   */
  playerId: number;
  /** Where the player is, and the ground under them. */
  x: number;
  y: number;
  z: number;
  groundY: number;
  /** 0 in daylight, 1 after dark. `SkyClock.night`; see `update` for what it gates. */
  night: number;
  /** The ground under an arbitrary point, for the beam's pool and the grit puff. */
  groundAt(x: number, z: number): number;
  /**
   * Slide a point out of whatever it is inside, or undefined for a caller with no
   * collision world.
   *
   * Used once per round, to keep a missed shot's puff of grit out of the inside of
   * a terrace: the scatter is resolved from the player's own feet toward the
   * impact point, which is the same `CollisionWorld.resolve` a patrol car takes a
   * corner with. Optional because a browser in its first second has no prisms and
   * a puff against a wall is not worth a branch anywhere else.
   */
  resolve?(fromX: number, fromZ: number, toX: number, toZ: number, radius: number, y: number): { x: number; z: number };
  /** The round striking the ground `distance` metres from the player. */
  impact(distance: number): void;
  /** And the report of the shot, `slant` metres away, once the sound has arrived. */
  report(slant: number): void;
}

/** A `PolairView` with its three hooks bound and its numbers at rest. */
export function createPolairView(
  groundAt: (x: number, z: number) => number,
  impact: (distance: number) => void,
  report: (slant: number) => void,
  resolve?: PolairView['resolve'],
): PolairView {
  return {
    tick: 0, dt: 0, on: false, playerId: 0,
    x: 0, y: 0, z: 0, groundY: 0, night: 0,
    groundAt, resolve, impact, report,
  };
}

/**
 * The helicopter, its searchlight, its strobes and the rounds it misses with.
 *
 * The `SpotLight` is created once in the constructor and **never removed and
 * never made invisible** -- `world/nightlights.NightLights` states the rule and
 * the reason: a light whose `visible` is toggled drops off the render list and
 * recompiles the scene the next time it comes back. The intensity is the only
 * thing that moves, which is the same arrangement the torch has. Every *mesh* in
 * here is toggled freely, which that file also states is free.
 *
 * Everything about where the machine is comes from `game/polair.polairPose`, which
 * the authority calls with the identical arguments. What this class adds on top is
 * the three things a pure function cannot have: a fade, a rotor that keeps
 * turning between ticks, and two countdowns for a bullet and its noise.
 */
export class Polair {
  readonly light: SpotLight;
  /** Everything drawn. Add this to the scene once; nothing here is per-tile. */
  readonly group = new Object3D();

  /** The airframe, rotated to its heading. The rotor spins inside it. */
  private readonly body = new Object3D();
  private readonly rotor: Mesh;
  private readonly navPort: Mesh;
  private readonly navStarboard: Mesh;
  private readonly navTail: Mesh;
  private readonly beam: Mesh;
  private readonly pool: Mesh;
  private readonly flash: Mesh;
  private readonly puff: Mesh;

  /**
   * The four additive materials, held by their concrete type.
   *
   * `Mesh.material` is `Material | Material[]` and every one of these has its
   * opacity written each frame, so reading them back off the meshes would be a
   * cast per frame per object -- and a cast is exactly the thing that stops being
   * true the day somebody gives one of them a second material slot.
   * `discMaterial`'s own note, four times over.
   */
  private readonly poolMaterial: MeshBasicNodeMaterial;
  private readonly beamMaterial: MeshBasicNodeMaterial;
  private readonly rotorMaterial: MeshBasicNodeMaterial;
  private readonly flashMaterial: MeshBasicNodeMaterial;
  private readonly puffMaterial: MeshBasicNodeMaterial;

  /** Where the target has been, for the orbit to lag behind. Reset per pursuit. */
  private trail = new PolairTrail();
  private readonly pose = createPolairPose();
  private readonly scatter = { x: 0, z: 0, distance: 0 };

  private level = 0;
  private clock = 0;
  /** Which lock cycle's round has already been drawn. -1 for none. */
  private firedCycle = -1;
  /** Seconds until the round strikes, until its noise arrives, and the two lives. */
  private strikeIn = 0;
  private reportIn = 0;
  private flashLife = 0;
  private puffLife = 0;
  /** The pending round's slant, and where it is going to land. */
  private shotSlant = 0;
  private shotX = 0;
  private shotY = 0;
  private shotZ = 0;
  private shotMiss = 0;
  /** Last frame's slant, for the rotor's doppler. */
  private lastSlant = 0;
  private closingRate = 0;

  /** True while the beam is up. The HUD and the audio read it. */
  get on(): boolean {
    return this.level > 0.01;
  }

  /** 0..1, for the rotor's mix. */
  get intensity(): number {
    return this.level;
  }

  /** Metres to the airframe, for the rotor's distance model. */
  get slant(): number {
    return this.pose.slant;
  }

  /** Metres a second the airframe is closing at, positive inbound. The doppler. */
  get closing(): number {
    return this.closingRate;
  }

  /** 0..1 round the lap, which is what the rotor's stereo pan follows. */
  get orbitPhase(): number {
    return this.pose.orbitPhase;
  }

  /** True while the searchlight is holding the player. The HUD could say so. */
  get locked(): boolean {
    return this.pose.locked && this.level > 0.5;
  }

  constructor(scene: Object3D, assets: HighwayPatrolAssets) {
    this.group.name = 'polair';

    const light = new SpotLight(0xffffff, 0);
    light.name = 'polair-light';
    light.angle = (POLAIR_CONE_DEG * Math.PI) / 180;
    // A hard edge, near enough. A police searchlight is a well-collimated beam
    // and the soft-edged version reads as a torch held very far away.
    light.penumbra = 0.25;
    light.distance = LIGHT_DISTANCE;
    light.decay = LIGHT_DECAY;
    // Never. See `NightLights`' torch: a second shadow map is a second full depth
    // pass from a direction that moves every frame, and the sun's rig is tuned for
    // exactly one caster.
    light.castShadow = false;
    this.light = light;
    // Both the light and its target go in the scene, because a `SpotLight` aims at
    // an `Object3D` and one that is not in the graph never has its world matrix
    // updated -- so the beam would point wherever the target's *local* transform
    // happened to leave it. `NightLights` adds its torch's target for the identical
    // reason.
    scene.add(light);
    scene.add(light.target);

    // --- The airframe. One lit mesh, one additive rotor, three unlit lamps.
    const hull = new Mesh(assets.heliBody, assets.material);
    hull.name = 'polair-hull';
    // Nothing up there casts. A shadow from 250 m through the sun's cascade would
    // be a few pixels of noise on the road for a full extra pass over the airframe.
    hull.castShadow = false;
    hull.receiveShadow = false;
    this.rotor = new Mesh(assets.rotorDisc, assets.rotorMaterial);
    this.rotor.name = 'polair-rotor';
    this.rotor.position.y = 0.5;
    this.navPort = new Mesh(assets.navRed, assets.lamp);
    this.navStarboard = new Mesh(assets.navGreen, assets.lamp);
    this.navTail = new Mesh(assets.navWhite, assets.lamp);
    // Named, and the names are a **contract**: `verifyPolairRig` finds these by
    // name to assert where they end up, because the alternative is exposing eight
    // meshes as public fields so a check can read them -- which would be an API
    // that exists only to be tested. `world/police.ts` names its rigs the same way.
    this.navPort.name = 'polair-nav-red';
    this.navStarboard.name = 'polair-nav-green';
    this.navTail.name = 'polair-nav-white';
    this.navPort.position.set(NAV_PORT[0], NAV_PORT[1], NAV_PORT[2]);
    this.navStarboard.position.set(NAV_STARBOARD[0], NAV_STARBOARD[1], NAV_STARBOARD[2]);
    this.navTail.position.set(NAV_TAIL[0], NAV_TAIL[1], NAV_TAIL[2]);
    this.body.name = 'polair-body';
    this.body.visible = false;
    this.body.add(hull, this.rotor, this.navPort, this.navStarboard, this.navTail);
    this.group.add(this.body);

    // --- The visible shaft, the pool on the road, and the two one-shots. All
    // unparented from the body, because the beam does not point where the nose
    // does and a flash on the ground is not on the airframe at all.
    this.beam = new Mesh(assets.beamCone, assets.beamMaterial);
    this.beam.name = 'polair-shaft';
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.pool = new Mesh(assets.disc, assets.discMaterial);
    this.pool.name = 'polair-pool';
    this.pool.frustumCulled = false;
    this.pool.visible = false;
    this.flash = new Mesh(assets.navWhite, assets.flashMaterial);
    this.flash.name = 'polair-flash';
    this.flash.frustumCulled = false;
    this.flash.visible = false;
    this.flash.scale.setScalar(3.2);
    this.puff = new Mesh(assets.disc, assets.puffMaterial);
    this.puff.name = 'polair-puff';
    this.puff.frustumCulled = false;
    this.puff.visible = false;
    for (const m of [this.beam, this.pool, this.flash, this.puff]) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
    this.group.add(this.beam, this.pool, this.flash, this.puff);

    this.poolMaterial = assets.discMaterial;
    this.beamMaterial = assets.beamMaterial;
    this.rotorMaterial = assets.rotorMaterial;
    this.flashMaterial = assets.flashMaterial;
    this.puffMaterial = assets.puffMaterial;
    scene.add(this.group);
  }

  /**
   * Fly the machine, aim the light, and draw whatever it has just fired.
   *
   * The order is fixed and each step depends on the one before:
   *
   *   1. **The fade**, because everything below scales by it and a level of zero
   *      is the early return that costs a stood-down room nothing.
   *   2. **The trail and the pose**, which is the only place in this file that
   *      decides where anything is.
   *   3. **The airframe**, its rotor and its strobes -- the part that has a read
   *      by day.
   *   4. **The light, the shaft and the pool**, which are night-weighted.
   *   5. **The round**: has one just left, and have its two arrivals come due.
   */
  update(view: PolairView): void {
    const dt = view.dt;
    this.clock += dt;

    // --- 1. The fade.
    const want = view.on ? 1 : 0;
    const rate = POLAIR_FADE > 0 ? dt / POLAIR_FADE : 1;
    // The rising edge is where a pursuit **begins**, and the trail is replaced
    // there rather than being carried over. A trail left from a chase ten minutes
    // ago holds a position on the other side of the harbour, and the first lap
    // would be flown around it -- which is the class of failure that renders
    // perfectly and looks like the helicopter spawning in the wrong suburb.
    if (view.on && this.level <= 0.001) this.trail = new PolairTrail();
    this.level += Math.max(-rate, Math.min(rate, want - this.level));
    if (this.level < 0) this.level = 0;
    if (this.level > 1) this.level = 1;

    if (this.level <= 0.001 && this.flashLife <= 0 && this.puffLife <= 0) {
      this.stand();
      return;
    }

    // --- 2. Where it is. The identical call the authority makes; see the header.
    this.trail.push(view.tick, view.x, view.y, view.z);
    polairPose(view.playerId, view.tick, view.x, view.y, view.z, this.trail, this.pose);
    // The doppler, as a smoothed rate. Smoothed because the frame delta is not the
    // tick and a raw difference over a 4 ms frame is mostly quantisation noise;
    // a quarter-second constant is well under the time the orbit takes to turn.
    if (this.lastSlant > 0 && dt > 0) {
      const raw = (this.lastSlant - this.pose.slant) / dt;
      const k = Math.min(1, dt / 0.25);
      this.closingRate += (raw - this.closingRate) * k;
    }
    this.lastSlant = this.pose.slant;

    // --- 3. The airframe. Placed nose-along its heading exactly as a patrol car
    // is, because it is built along -Z for that reason -- see `placeByHeading`.
    this.body.visible = true;
    this.body.position.set(this.pose.x, this.pose.y, this.pose.z);
    this.body.rotation.y = Math.atan2(-this.pose.dx, -this.pose.dz);
    // A slight bank into the turn. One number, and it is what stops the machine
    // reading as a model on a wire: a helicopter holding a circle is tilted.
    this.body.rotation.z = 0.18;
    this.rotor.rotation.y += ROTOR_RATE * dt;
    this.rotorMaterial.opacity = POLAIR_ROTOR_OPACITY * this.level;

    // The nav lamps. Red and green **steady**, because position lights are; the
    // white anti-collision strobe double-flashing on its own fixed period, which
    // is the one clock in this feature that does not wander. See
    // `polair.POLAIR_STROBE_PERIOD_S`.
    const lit = this.level > 0.15;
    this.navPort.visible = lit;
    this.navStarboard.visible = lit;
    const strobe = this.clock % POLAIR_STROBE_PERIOD_S;
    this.navTail.visible = lit
      && (strobe < POLAIR_STROBE_FLASH_S
        || (strobe >= POLAIR_STROBE_SECOND_S && strobe < POLAIR_STROBE_SECOND_S + POLAIR_STROBE_FLASH_S));

    // --- 4. The light, the shaft and the pool, all aimed at the beam's point
    // rather than at the player. That is the whole feature: during a lock they
    // are the same place, and the rest of the time you watch the circle hunt.
    const bx = this.pose.beamX;
    const bz = this.pose.beamZ;
    const by = view.groundAt(bx, bz);
    const lampY = this.pose.y - LAMP_DROP;
    this.light.position.set(this.pose.x, lampY, this.pose.z);
    this.light.target.position.set(bx, by, bz);
    this.light.target.updateMatrixWorld();
    this.light.intensity = POLAIR_INTENSITY * this.level * this.pose.flicker;

    // The shaft's length is the real distance from the lamp to the ground it is
    // landing on, so the cone ends exactly where the pool is however the terrain
    // under the beam rises. `tan` is fine here: presentation, once a frame, and
    // nothing compares it -- `game/polair.ts` owns everything that is compared.
    const sx = bx - this.pose.x;
    const sy = by - lampY;
    const sz = bz - this.pose.z;
    const reach = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const spread = reach * Math.tan(this.light.angle);
    this.beam.visible = view.night > 0.02;
    if (this.beam.visible) {
      this.beam.position.set(this.pose.x, lampY, this.pose.z);
      this.beam.lookAt(bx, by, bz);
      this.beam.scale.set(spread, spread, reach);
      // Night-gated, and hard. A visible shaft of light in daylight is a plastic
      // tube -- there is not enough contrast against a lit sky for the additive
      // blend to read as anything but a smear on the lens.
      this.beamMaterial.opacity = POLAIR_BEAM_OPACITY * this.level * this.pose.flicker * view.night;
    }
    this.pool.visible = true;
    this.pool.position.set(bx, by + 0.06, bz);
    this.pool.scale.set(spread, 1, spread);
    // The pool is **not** night-gated, and that is the one thing the old build got
    // right about daylight: a circle of light on the road is legible at noon, and
    // with the cone gone it is half of what tells a player they are being looked
    // for. Weighted up a little after dark rather than switched on.
    this.poolMaterial.opacity = POLAIR_DISC_OPACITY * this.level * this.pose.flicker * (0.45 + 0.55 * view.night);

    // --- 5. The round. `polairShotTick` is the exact tick it leaves on, which is
    // asked as a *level* rather than watched as an edge: the frame loop may see a
    // shared tick twice on a 144 Hz display or skip one entirely under load, and a
    // rising-edge test would then either double the shot or lose it. One round per
    // lock cycle, and the cycle is the guard.
    const cycle = polairCycle(view.tick);
    if (view.on && this.level > 0.5 && this.firedCycle !== cycle) {
      const at = polairShotTick(view.playerId, cycle);
      // `polairShotFired` asked at the round's **own** tick rather than at this
      // frame's, which is what makes this the identical question the authority
      // answers: it is the one that also applies the cooldown and the only-while-
      // locked rule, and asking it about `view.tick` would be asking about a tick
      // the frame loop may have arrived at late. A round is drawn once per lock
      // cycle and the cycle is the guard.
      if (view.tick >= at && view.tick - at < 60 && polairShotFired(view.playerId, at)) {
        this.firedCycle = cycle;
        this.fire(view);
      }
    }
    this.drawRound(view, dt);
  }

  /**
   * A round leaves the airframe: the flash now, the strike and the report later.
   *
   * The scatter, the two flight times and the impact point are all
   * `game/polair.ts`'s -- the same functions and the same seed the authority used
   * -- so this draws the shot the server rolled rather than an unrelated one that
   * happens to look similar. The **outcome** is not computed here at all: if it
   * landed, the pip arrives as damage through the ordinary path and the player
   * sees their own blood flash at the same instant as the grit. See that file's
   * header, section 3, for why that is the honest split.
   */
  private fire(view: PolairView): void {
    polairMiss(view.playerId, polairCycle(view.tick), view.x, view.z, this.scatter);
    let ix = this.scatter.x;
    let iz = this.scatter.z;
    // Out of whatever it is inside, from the player's own feet outward, so a
    // round that would have struck the inside of a terrace strikes its face.
    if (view.resolve) {
      const clear = view.resolve(view.x, view.z, ix, iz, 0.2, view.groundY + 0.4);
      ix = clear.x;
      iz = clear.z;
    }
    this.shotX = ix;
    this.shotZ = iz;
    this.shotY = view.groundAt(ix, iz);
    const dx = ix - view.x;
    const dz = iz - view.z;
    this.shotMiss = Math.sqrt(dx * dx + dz * dz);
    this.shotSlant = this.pose.slant;
    this.strikeIn = this.shotSlant / POLAIR_ROUND_SPEED;
    this.reportIn = this.shotSlant / POLAIR_SOUND_SPEED;
    // The flash is the one thing that is not delayed, because light is. It is the
    // whole tell: a player who is looking at the machine when it fires sees the
    // muzzle a third of a second before the round lands near them.
    this.flashLife = POLAIR_FLASH_S;
  }

  /** The flash, the strike and the report, on their own clocks. */
  private drawRound(view: PolairView, dt: number): void {
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.visible = this.flashLife > 0;
      this.flash.position.set(this.pose.x, this.pose.y - LAMP_DROP * 0.6, this.pose.z);
      this.flashMaterial.opacity = Math.max(0, this.flashLife / POLAIR_FLASH_S);
    } else if (this.flash.visible) {
      this.flash.visible = false;
    }

    if (this.strikeIn > 0) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = 0;
        this.puffLife = POLAIR_PUFF_S;
        // The round on bitumen, at the metres it actually landed at. `gunshot`'s
        // own curve is right for it: a crack with a body and a slapback off the
        // buildings, which is what a rifle round striking a road at four metres
        // sounds like -- and reusing it means there is one impact in this build
        // rather than two that were tuned on different days.
        view.impact(this.shotMiss);
      }
    }
    if (this.puffLife > 0) {
      this.puffLife -= dt;
      const t = Math.max(0, this.puffLife / POLAIR_PUFF_S);
      this.puff.visible = t > 0;
      // Spreading as it fades, which is what a spray of grit does and is also
      // what stops it reading as a decal switching off.
      const r = POLAIR_PUFF_R * (1.15 - t * 0.85);
      this.puff.position.set(this.shotX, this.shotY + 0.05, this.shotZ);
      this.puff.scale.set(r, 1, r);
      this.puffMaterial.opacity = 0.5 * t * t;
    } else if (this.puff.visible) {
      this.puff.visible = false;
    }

    if (this.reportIn > 0) {
      this.reportIn -= dt;
      if (this.reportIn <= 0) {
        this.reportIn = 0;
        view.report(this.shotSlant);
      }
    }
  }

  /** Stand everything down. Idempotent, and what a room with nobody wanted runs. */
  private stand(): void {
    this.light.intensity = 0;
    // Parked far under the terrain rather than at the origin, which is a real
    // place in this world: somebody standing at Town Hall with an idle searchlight
    // at their feet would see a phantom.
    this.light.position.set(0, -1000, 0);
    this.body.visible = false;
    this.beam.visible = false;
    this.pool.visible = false;
    this.flash.visible = false;
    this.puff.visible = false;
    this.poolMaterial.opacity = 0;
    this.beamMaterial.opacity = 0;
    this.rotorMaterial.opacity = 0;
    this.flashMaterial.opacity = 0;
    this.puffMaterial.opacity = 0;
    this.firedCycle = -1;
    this.strikeIn = 0;
    this.reportIn = 0;
    this.flashLife = 0;
    this.puffLife = 0;
    this.lastSlant = 0;
    this.closingRate = 0;
  }
}

// --- The check ---------------------------------------------------------------------------

/**
 * Boot self-check, on this project's usual criterion: does every way it breaks
 * still *render*, and render something plausible?
 *
 * Every failure below does.
 *
 *   - A **quad wound the other way** is a car with a hole in one flank, visible
 *     only from the kerb, which reads as z-fighting rather than as geometry.
 *     Checked as `world/police.verifyPoliceKit` checks it: every face normal of
 *     a closed box has to point away from the box's own centre.
 *   - A **light bar with no lenses lit in either phase** is a marked car with a
 *     dark plinth on the roof, which reads as the strobe being unimplemented
 *     rather than as four geometries being wrong.
 *   - A **cone line narrower than the roads it blocks** is an RBT you drive
 *     round, which reads as the roadblock not working. The span is checked
 *     against `game/heat.RBT_LINE_HALF_M`, which is the *evasion* test's own
 *     half-width, because those two numbers describing different widths is a
 *     player driving through a gap and not being charged for it.
 *   - A **Polair cone that does not reach the ground** is a searchlight lighting
 *     nothing, at noon and at midnight alike, with no error anywhere.
 *   - And a **body built nose-first along +Z** is every patrol car in Sydney
 *     driving backwards, which at a distance reads as a reversing car.
 */
export function verifyHighwayPatrol(assets?: HighwayPatrolAssets): string[] {
  const failures: string[] = [];

  // --- The geometry, if it has been built.
  if (assets) {
    if (assets.triangles <= 0) {
      failures.push('The highway patrol kit has no triangles in it; a pursuit would arrive as an invisible car.');
    }
    // The body's own extent, which is what the hit radius in `game/heat.ts` is
    // set against. A body that grew past it would be a car that visibly passes
    // through people.
    assets.body.computeBoundingBox();
    const box = assets.body.boundingBox;
    if (box) {
      const len = box.max.z - box.min.z;
      const wide = box.max.x - box.min.x;
      if (Math.abs(len - CAR_LENGTH) > 0.35) {
        failures.push(`The patrol body is ${len.toFixed(2)} m long and the constants say ${CAR_LENGTH}.`);
      }
      if (wide > len) {
        failures.push(
          `The patrol body is ${wide.toFixed(2)} m across and ${len.toFixed(2)} m long, so it is built ` +
            'facing sideways. Every car in the city would drive crabwise.',
        );
      }
      if (box.min.y < -0.01) failures.push('The patrol body reaches below its own origin; it would sink into the road.');
    }
    // Every quad in this file went through `Parts.facing`, which derives its
    // winding from a stated outward direction -- so what is left to check is
    // that none of them was *unorientable*. See `Parts.degenerate`.
    if (assets.degenerate > 0) {
      failures.push(
        `${assets.degenerate} quads of the highway patrol kit collapsed to a line and face nowhere. ` +
          'They draw as nothing, so the car has holes in it that no exception reports.',
      );
    }
    // Both phases have to light something, or the bar is a dark plinth.
    for (const [name, g] of [
      ['red left', assets.lensLeftRed], ['blue right', assets.lensRightBlue],
      ['blue left', assets.lensLeftBlue], ['red right', assets.lensRightRed],
    ] as const) {
      const count = g.getIndex()?.count ?? 0;
      if (count <= 0) failures.push(`The ${name} lens has no triangles; that half of the strobe is dark.`);
    }
    // And the two phases must not be the same colour, which is a bar that
    // flashes white and reads as a fault light.
    const a = firstColour(assets.lensLeftRed);
    const b = firstColour(assets.lensLeftBlue);
    if (a !== null && b !== null && a[0] === b[0] && a[2] === b[2]) {
      failures.push('Both phases of the light bar are the same colour on the same side; it would not read as a strobe.');
    }
    // The disc has to be a disc rather than a point.
    assets.disc.computeBoundingBox();
    const d = assets.disc.boundingBox;
    if (d && d.max.x - d.min.x < 1.9) {
      failures.push('The Polair ground disc is smaller than its own unit radius; it is scaled at draw and would vanish.');
    }

    // --- Polair's airframe, which is new in this pass and has its own three ways
    //     of failing while rendering.
    if (assets.heliTriangles <= 0) {
      failures.push('The Polair airframe has no triangles; the fifth rung would be a beam out of an empty sky.');
    }
    // The brief's budget. It is not about the GPU -- 400 triangles is nothing --
    // it is about somebody deciding the helicopter deserves a model and quietly
    // putting a thousand-triangle one in a file whose whole argument is that a
    // silhouette at 250 m is enough.
    if (assets.heliTriangles > 400) {
      failures.push(
        `The Polair airframe is ${assets.heliTriangles} triangles against a stated budget of 400. At three ` +
          'degrees of arc nothing past a silhouette is visible, so the extra geometry is paid for and unseen.',
      );
    }
    assets.heliBody.computeBoundingBox();
    const h = assets.heliBody.boundingBox;
    if (h) {
      const len = h.max.z - h.min.z;
      const wide = h.max.x - h.min.x;
      if (!(len > wide * 1.8)) {
        failures.push(
          `The airframe is ${len.toFixed(1)} m long and ${wide.toFixed(1)} m across. A helicopter's whole read ` +
            'from below is a long thin body with a boom; anything squarer than that is a drone.',
        );
      }
      // The origin is the rotor hub, so the machine hangs *below* it. A body built
      // above its own origin would put the skids at the altitude the orbit states
      // and the rotor five metres higher, and the searchlight -- which is offset
      // down from the origin -- would come out of the roof.
      if (h.min.y > -1) {
        failures.push(
          'The Polair airframe does not extend below its own origin. The origin is the rotor hub by ' +
            'contract, so the searchlight would be emitted from above the rotor.',
        );
      }
    }
    // The beam shaft is a unit cone opening along -Z, which is what makes placing
    // it one `lookAt` and one scale. A cone built along +Z points at the sky.
    assets.beamCone.computeBoundingBox();
    const bc = assets.beamCone.boundingBox;
    if (bc && !(bc.min.z < -0.9 && bc.max.z <= 1e-6)) {
      failures.push(
        `The Polair beam cone spans z ${bc?.min.z.toFixed(2)}..${bc?.max.z.toFixed(2)} and must be a unit ` +
          'cone from 0 to -1. Built the other way it would be aimed at the sky, which from the ground is ' +
          'no beam at all rather than a wrong one.',
      );
    }
    // The three lamps have to be three different colours, or the position lights
    // are decoration and the machine has no orientation from below.
    {
      const red = firstColour(assets.navRed);
      const green = firstColour(assets.navGreen);
      const white = firstColour(assets.navWhite);
      if (red && green && white) {
        if (!(red[0] > red[1] && green[1] > green[0] && white[0] > 0.8 && white[1] > 0.8)) {
          failures.push(
            'The Polair nav lamps are not red, green and white. Port and starboard are how a viewer on the ' +
              'ground tells which way it is flying, and three lamps the same colour is three dots.',
          );
        }
      } else {
        failures.push('One of the Polair nav lamps has no vertex colour.');
      }
    }
  }

  // --- `Parts.facing` itself, against a single convex box, where "outward" and
  //     "away from the centroid" genuinely mean the same thing.
  //
  // The compound body cannot be checked this way and the first cut of this file
  // tried: a wheel sits at the corner of the car, so its *inner* face correctly
  // points back toward the body's centre, and 44 of 256 vertices failed a test
  // that was asking the wrong question. What is actually being asserted is that
  // the orientation helper works -- and a box is where that claim is true.
  {
    const probe = new Parts();
    probe.box(-1, -2, -3, 4, 5, 6, [1, 1, 1]);
    failures.push(...verifyOutward(probe.build('probe'), 'orientation probe box'));
    if (probe.degenerate !== 0) failures.push('A well-formed box produced a degenerate quad.');
    if (probe.triangles !== 12) failures.push(`A box built ${probe.triangles} triangles rather than 12.`);
  }

  // --- The RBT's geometry, as a relation rather than as a number. The cone line
  //     has to be at least as wide as the evasion test's own half-width either
  //     side, or there is a gap you can drive through and not be charged for.
  {
    const half = ((RBT_CONES - 1) * RBT_CONE_PITCH) / 2;
    if (RBT_CONES < 4) failures.push(`An RBT lays ${RBT_CONES} witches' hats; that is a driveway, not a roadblock.`);
    if (half < 5) {
      failures.push(
        `The cone line reaches ${half.toFixed(1)} m either side of the site and a two-lane road is about 7. ` +
          'The hats would sit in one lane and the RBT would read as an abandoned traffic job.',
      );
    }
  }

  // --- Polair's presentation numbers. The *geometry and schedule* are checked by
  //     `game/polair.verifyPolair`, which runs on both ends; what is left here is
  //     the handful of constants only a renderer reads.
  {
    // The pool the cone actually lands, at the two ends of the altitude range.
    // Both have to be a circle of light on a road: under 5 m across is a laser
    // pointer, over 120 is a floodlit street.
    const near = POLAIR_ALTITUDE_MIN_M * Math.tan((POLAIR_CONE_DEG * Math.PI) / 180);
    const far = POLAIR_ALTITUDE_MAX_M * Math.tan((POLAIR_CONE_DEG * Math.PI) / 180);
    if (!(near > 5 && far < 120)) {
      failures.push(
        `Polair's cone lands a ${near.toFixed(0)}..${far.toFixed(0)} m pool from ` +
          `${POLAIR_ALTITUDE_MIN_M}..${POLAIR_ALTITUDE_MAX_M} m up. Under 5 m it is a laser pointer and over ` +
          '120 it is daylight.',
      );
    }
    // The light has to be able to reach the ground from the far side of the orbit.
    // A `distance` under the longest slant makes the beam stop in mid-air, which
    // reads as the searchlight failing rather than as a range limit.
    if (LIGHT_DISTANCE < POLAIR_ALTITUDE_MAX_M * 1.3) {
      failures.push(
        `The searchlight's cutoff is ${LIGHT_DISTANCE.toFixed(0)} m and the machine flies at up to ` +
          `${POLAIR_ALTITUDE_MAX_M} m plus its orbit radius out. The beam would end before the road does.`,
      );
    }
    if (POLAIR_FADE <= 0) failures.push('The Polair beam has no fade; the searchlight would appear in one frame.');
    // The three additive layers. All three at zero is a searchlight nobody can
    // see now that the `SpotLight` itself is a fifth as strong; any of them past a
    // half is a white sheet over the street.
    for (const [name, v] of [
      ['ground pool', POLAIR_DISC_OPACITY],
      ['beam shaft', POLAIR_BEAM_OPACITY],
      ['rotor smear', POLAIR_ROTOR_OPACITY],
    ] as const) {
      if (!(v > 0.01 && v < 0.5)) {
        failures.push(
          `Polair's ${name} draws at ${v} opacity. Under 0.01 it is invisible and this build has moved the ` +
            'searchlight far enough away that these three are most of what a player sees; past 0.5 an ' +
            'additive layer is a white sheet.',
        );
      }
    }
    if (!(POLAIR_FLASH_S > 0 && POLAIR_FLASH_S < 0.25)) {
      failures.push(`The muzzle flash lasts ${POLAIR_FLASH_S} s; past a quarter of a second it is a lamp.`);
    }
    if (!(POLAIR_PUFF_S > 0.1 && POLAIR_PUFF_R > 0.3)) {
      failures.push('The grit puff has no life or no size; a missed round would land silently and invisibly.');
    }
    // The puff must be smaller than the **closest** a round lands, or a miss at the
    // minimum scatter distance covers the player's own feet and reads as a hit that
    // did no damage -- which is worse than no feedback, because it teaches the
    // wrong thing about a mechanic whose whole point is that it misses.
    if (POLAIR_PUFF_R >= POLAIR_MISS_MIN_M) {
      failures.push(
        `The grit puff spreads to ${POLAIR_PUFF_R} m and the nearest a round lands is ${POLAIR_MISS_MIN_M} m, ` +
          'so the closest misses would engulf the player and read as hits that did nothing.',
      );
    }
    if (!(ROTOR_RATE > 10)) failures.push('The rotor barely turns; a helicopter with a still rotor is a model.');
  }

  // --- The strobe.
  if (!(STROBE_PERIOD > 0.05 && STROBE_PERIOD < 1)) {
    failures.push(
      `The light bar alternates every ${STROBE_PERIOD} s. Faster than 0.05 is a flicker nobody can look at ` +
        'and slower than 1 is a lamp that is sometimes red.',
    );
  }

  // --- And the contract with the ladder: this file draws two kinds and both
  //     have to be the ones `game/heat.ts` promotes.
  {
    // Read through an array rather than compared as two literals, so the
    // compiler cannot constant-fold the check away -- which is exactly how a
    // check like this goes quietly true and stops covering anything. Two kinds
    // sharing a byte would draw every roadblock as a moving car.
    const kinds = [NPC_KIND.HIGHWAY_PATROL, NPC_KIND.RBT, NPC_KIND.POLICE] as number[];
    if (new Set(kinds).size !== kinds.length) {
      failures.push('The patrol car, the RBT and the police do not have three distinct kind bytes.');
    }
  }
  if (HEAT_MAX < 5) {
    failures.push(`The ladder tops out at ${HEAT_MAX} stars and Polair is the fifth rung; it would be unreachable.`);
  }

  // The waves the beam used to be made of are `game/polair.ts`'s now, and so are
  // their checks -- `verifyPolair` asserts the triangle's endpoints, its period
  // and the unit circle built out of it. There is no arithmetic left in this file
  // that two processes both evaluate, which is the point of the split.

  // --- And the rig, driven. Three minutes of frames with a real `Polair` in a
  //     real (if empty) scene graph. Only when the assets exist, because it needs
  //     geometry to build the meshes out of.
  if (assets) failures.push(...verifyPolairRig(assets));

  return failures;
}

/**
 * Three minutes of frames through a real `Polair`, with nothing but an `Object3D`
 * behind it.
 *
 * This is the closest thing to acceptance this feature can have without a pair of
 * eyes, and it exists because **every interesting failure in the class above is a
 * placement, not an arithmetic**: `game/polair.verifyPolair` proves the orbit is
 * where it says it is, and none of that helps if the light is left at
 * `y = -1000`, or the pool is parented to the player instead of the beam, or the
 * shot's two callbacks fire on every frame of a lock instead of once.
 *
 * Three's `Object3D`, `Mesh` and `SpotLight` are plain arithmetic over matrices
 * and need no GPU, which is what makes this runnable at boot rather than in a
 * browser harness. What it deliberately cannot check is anything that only a
 * rasteriser knows -- whether an additive cone at 0.085 opacity is actually
 * visible against a night sky is a question for the owner's eyes, and it is stated
 * as such in this workstream's report rather than faked here.
 */
function verifyPolairRig(assets: HighwayPatrolAssets): string[] {
  const failures: string[] = [];
  const scene = new Object3D();
  const rig = new Polair(scene, assets);
  let impacts = 0;
  let reports = 0;
  let lastImpact = 0;
  const view = createPolairView(() => 0, (d) => { impacts++; lastImpact = d; }, () => { reports++; });
  view.playerId = 5;
  view.night = 1;
  view.dt = 1 / 60;

  const first = 4_000_000;
  const settle = 180;
  const frames = 3 * 60 * 60;
  let peakIntensity = 0;
  let minLampHeight = Infinity;
  let maxLampHeight = 0;
  let poolAwayFromPlayer = 0;
  let poolOnPlayer = 0;
  let strobeFrames = 0;
  let bodyHidden = 0;
  let worstShaft = 0;

  // Found once. `getObjectByName` walks the graph, and doing it per frame would
  // make this check's own cost the thing somebody notices about it.
  const pool = scene.getObjectByName('polair-pool');
  const beam = scene.getObjectByName('polair-shaft');
  const body = scene.getObjectByName('polair-body');
  const tail = scene.getObjectByName('polair-nav-white');
  if (!pool || !beam || !body || !tail) {
    return ['One of Polair\'s meshes is not in the scene graph under the name this check expects.'];
  }

  for (let i = 0; i < frames; i++) {
    view.tick = first + i;
    // Wanted for all but the **last two and a half seconds**, and that tail is what
    // makes the round count below deterministic rather than a coin flip: a report
    // arrives 0.73 s after the round that caused it, so a shot fired in the final
    // second would have an impact inside the window and its report outside it. The
    // tail lets every pending timer flush while the fade runs out.
    view.on = i < frames - 150;
    // A jog east. The ground is flat at zero, which is what `groundAt` returns.
    view.x = 40 + i * 0.08;
    view.y = 0;
    view.z = -60;
    view.groundY = 0;
    rig.update(view);
    // Everything before the settle is the fade coming up, during which the rig
    // will not fire and the light is at a fraction of its peak. Counters are zeroed
    // rather than gated, so a round drawn while the beam was rising is not counted
    // against a window that does not include it.
    if (i === settle) {
      impacts = 0;
      reports = 0;
    }
    // Nothing is measured before the settle or during the stand-down tail: in the
    // first the beam is still rising, and in the second the lamp is deliberately
    // parked a kilometre under the terrain, which would fail every bound below.
    if (i < settle || !view.on) continue;

    peakIntensity = Math.max(peakIntensity, rig.light.intensity);
    minLampHeight = Math.min(minLampHeight, rig.light.position.y);
    maxLampHeight = Math.max(maxLampHeight, rig.light.position.y);
    // The pool has to sit under the beam. During a lock that is the player, and
    // the rest of the time it must not be -- a pool that never left the player
    // would be the old build with a helicopter drawn beside it.
    if (!body.visible) bodyHidden++;
    if (tail.visible) strobeFrames++;
    const off = Math.hypot(pool.position.x - view.x, pool.position.z - view.z);
    if (off < 0.001) poolOnPlayer++;
    else if (off > 5) poolAwayFromPlayer++;
    // The shaft has to end where the pool is: its length is scaled along the
    // direction `lookAt` gave it, so the two agreeing is the whole of "the beam
    // reaches the ground".
    const reach = Math.hypot(
      pool.position.x - beam.position.x,
      pool.position.y - 0.06 - beam.position.y,
      pool.position.z - beam.position.z,
    );
    worstShaft = Math.max(worstShaft, Math.abs(beam.scale.z - reach));
  }

  // --- The light itself.
  const ceiling = POLAIR_INTENSITY * (1 + POLAIR_FLICKER) + 1e-6;
  if (!(peakIntensity > 0 && peakIntensity <= ceiling)) {
    failures.push(
      `The searchlight peaked at ${peakIntensity.toFixed(0)} against a ceiling of ${ceiling.toFixed(0)}. ` +
        'At zero the beam never came up at all; above it the flicker is multiplying rather than modulating.',
    );
  }
  if (minLampHeight < POLAIR_ALT_MIN - LAMP_DROP - 1 || maxLampHeight > POLAIR_ALTITUDE_MAX_M) {
    failures.push(
      `The lamp flew at ${minLampHeight.toFixed(0)}..${maxLampHeight.toFixed(0)} m and the orbit says ` +
        `${POLAIR_ALT_MIN}..${POLAIR_ALTITUDE_MAX_M} less the gimbal drop. The light is not on the airframe.`,
    );
  }
  if (bodyHidden > 0) {
    failures.push(`The airframe was invisible for ${bodyHidden} frames of a live pursuit.`);
  }
  if (worstShaft > 0.01) {
    failures.push(
      `The visible beam's length and the ground pool disagree by ${worstShaft.toFixed(2)} m. The shaft would ` +
        'either stop in mid-air above the pool or punch through the road past it.',
    );
  }

  // --- The pool, which is the feature. Both branches have to happen.
  if (poolOnPlayer === 0) {
    failures.push('The searchlight never once landed on the player, over three minutes. A lock does nothing.');
  }
  if (poolAwayFromPlayer === 0) {
    failures.push(
      'The searchlight never left the player. That is the old build -- a beam welded to the suspect -- with ' +
        'a helicopter drawn beside it, which is the exact complaint this workstream exists to answer.',
    );
  }

  // --- The strobe's duty, measured off the meshes rather than off the constants.
  {
    const want = (POLAIR_STROBE_FLASH_S * 2) / POLAIR_STROBE_PERIOD_S;
    const got = strobeFrames / (frames - settle - 150);
    if (Math.abs(got - want) > 0.03) {
      failures.push(
        `The anti-collision strobe was lit ${(got * 100).toFixed(1)}% of the time and its constants say ` +
          `${(want * 100).toFixed(1)}%. The double flash is not being drawn on the period it claims.`,
      );
    }
  }

  // --- The rounds. Exactly one impact and one report per lock cycle in the
  //     window, and the impact's distance inside the scatter's own range.
  {
    let want = 0;
    for (
      let cycle = polairCycle(first) - 1;
      cycle <= polairCycle(first + frames) + 1;
      cycle++
    ) {
      const at = polairShotTick(5, cycle);
      // The rig will not fire before the fade has reached a half, which is 42
      // frames -- inside the settle window, so a round scheduled there is simply
      // not counted on either side.
      if (at < first + settle || at >= first + frames - 150) continue;
      if (polairShotFired(5, at)) want++;
    }
    if (want === 0) {
      failures.push(
        `No round was scheduled in three minutes with a lock cycle of ${POLAIR_LOCK_CYCLE_TICKS} ticks; ` +
          'this check is not exercising the marksman at all.',
      );
    }
    if (impacts !== want || reports !== want) {
      failures.push(
        `Polair drew ${impacts} strikes and ${reports} reports for ${want} scheduled rounds. More means the ` +
          'per-cycle guard is not holding and every frame of a lock fires; fewer means the round is being ' +
          'missed when the frame loop steps over its tick.',
      );
    }
    if (impacts > 0 && !(lastImpact >= POLAIR_MISS_MIN_M - 1e-6 && lastImpact <= POLAIR_MISS_MAX_M + 1e-6)) {
      failures.push(
        `A round struck ${lastImpact.toFixed(2)} m from the player and the scatter is ` +
          `${POLAIR_MISS_MIN_M}..${POLAIR_MISS_MAX_M} m. The impact the audio is told about is not the one ` +
          'the puff was drawn at.',
      );
    }
  }

  // --- And standing down. Two seconds of `on: false` has to put the light out,
  //     which is the one state a room spends almost all of its time in.
  for (let i = 0; i < 180; i++) {
    view.tick = first + frames + i;
    view.on = false;
    rig.update(view);
  }
  if (rig.light.intensity !== 0 || rig.on) {
    failures.push(
      `Three seconds after standing down the searchlight is still at ${rig.light.intensity.toFixed(0)}. ` +
        'A 100 kW lamp left running over an unwanted player is a phantom in the sky nobody can explain.',
    );
  }

  return failures;
}

/** Every face normal of a closed solid points away from its own centroid. */
function verifyOutward(geometry: BufferGeometry, what: string): string[] {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  if (!pos || !nrm) return [`The ${what} has no positions or no normals.`];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += pos.getX(i);
    cy += pos.getY(i);
    cz += pos.getZ(i);
  }
  cx /= pos.count;
  cy /= pos.count;
  cz /= pos.count;
  let inverted = 0;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dy = pos.getY(i) - cy;
    const dz = pos.getZ(i) - cz;
    const dot = dx * nrm.getX(i) + dy * nrm.getY(i) + dz * nrm.getZ(i);
    // Exact, because this is only ever asked of a **single convex solid** --
    // see the call site. On a compound body the question is meaningless: a
    // wheel at the corner of a car has an inner face that correctly points back
    // at the car's centre.
    if (dot < -1e-6) inverted++;
  }
  if (inverted > 0) {
    return [
      `${inverted} of the ${what}'s ${pos.count} vertices have a normal pointing into the solid. ` +
        'Those faces are invisible from outside and solid from inside, which reads as z-fighting.',
    ];
  }
  return [];
}

/** The first vertex colour of a geometry, for the strobe's two-phase check. */
function firstColour(geometry: BufferGeometry): [number, number, number] | null {
  const c = geometry.getAttribute('color');
  if (!c || c.count === 0) return null;
  return [c.getX(0), c.getY(0), c.getZ(0)];
}

/**
 * The pipelines this feature needs compiled before a player can be at 3 stars.
 *
 * `world/police.policeWarmupParts`' contract: the boot warm-up draws one of
 * everything off-screen so the first patrol car does not cost a shader compile
 * in the middle of a pursuit -- which is the one moment in the session where a
 * 200 ms hitch is unambiguously the game's fault.
 */
export function highwayPatrolWarmupParts(assets: HighwayPatrolAssets): WarmupPart[] {
  return [
    { geometry: assets.body, material: assets.material },
    { geometry: assets.barHousing, material: assets.material },
    { geometry: assets.lensLeftRed, material: assets.lamp },
    { geometry: assets.rbtProps, material: assets.material },
    { geometry: assets.disc, material: assets.discMaterial },
    // And Polair's five, on the same terms. The fifth rung arrives all at once --
    // a body, a rotor, three lamps, a shaft and a pool in the same frame -- so it
    // is the worst possible moment in a session to be compiling anything, and it
    // is the one moment a player is certain to be paying attention.
    { geometry: assets.heliBody, material: assets.material },
    { geometry: assets.rotorDisc, material: assets.rotorMaterial },
    { geometry: assets.navRed, material: assets.lamp },
    { geometry: assets.beamCone, material: assets.beamMaterial },
    { geometry: assets.disc, material: assets.puffMaterial },
    { geometry: assets.navWhite, material: assets.flashMaterial },
  ];
}
