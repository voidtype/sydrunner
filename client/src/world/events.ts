/**
 * What an ambient event looks like: five instanced sets and no skeletons at all.
 *
 * The **rendering** half of `game/events.ts`, on `world/rave.ts`'s split: that
 * file decides what is happening and is compiled into the Bun server, and this
 * one draws it and imports three.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO RIG IN THIS FILE.
 *
 * `world/characters.ts` and `world/streetlife.ts` both hold a pool of
 * `CharacterActor`s -- real skinned meshes with seventeen bones -- because the
 * people they draw are people you stand next to and talk to. An event's cast is
 * not that. It is a queue you walk past, a crowd on the far side of a car park,
 * two blokes arguing on the other side of a Camry: **the thing you read is the
 * arrangement, not the joints**.
 *
 * `world/people.ts` measured exactly this and its number is inherited whole. At
 * 55 m a 1.7 m figure is 26 pixels tall; a swinging leg is five pixels of travel
 * and a knee is one. A trackwork queue is twenty-five figures, and twenty-five
 * skeletons at twenty-five draw calls for a joke about buses would cost more
 * frame time than the entire police force.
 *
 * So every body here is the far tier's trick without the far tier: one
 * `InstancedMesh`, one 40-triangle figure, one `Matrix4.compose` per person, and
 * `instanceColor` for the clothes. Twenty-five of them is one draw call and
 * twenty-five composes, which is under a tenth of a millisecond.
 *
 * The one thing that is lost is the walk cycle, and nothing in an event walks.
 * A queue that never moves, a crowd standing and filming, two drivers gesturing,
 * a dozen ibises: every single one of them is *stationary by design*, which is
 * the observation that makes this whole file cheap. The gesturing is a body lean
 * on a triangle wave, which is three multiplies.
 *
 * ---------------------------------------------------------------------------
 * FIVE SETS, AND WHY NOT ONE.
 *
 * `world/people.ts` splits its crowd into six sets for `instanceColor`'s sake --
 * the tint multiplies the whole object, so a figure in one set gets one colour.
 * The same wall is here and the split is by **object** rather than by body part,
 * because these objects are genuinely different things:
 *
 *   - `bodies`  a person. One colour: the top. At this distance the legs are a
 *               silhouette and the shirt is the person.
 *   - `cars`    a stopped car, and the hoon's. One colour: the paint.
 *   - `bins`    a kerbside bin, upright or over.
 *   - `signs`   an A-frame. Two of them exist in the whole city at once.
 *   - `birds`   an ibis. `world/wildlife.ts` has a better one and this is not
 *               it -- see `IBIS_NOTE`.
 *
 * Five draw calls for every event in view at once, which is the entire budget of
 * this feature.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { WarmupPart } from './warmup.ts';

import {
  CAST_ROLE,
  CAST_REACH,
  DONUT_RADIUS,
  EVENT_KIND,
  MAX_CAST,
  castOf,
  eventProgress,
  liveEventsAt,
  type CastMember,
  type EventSite,
} from '../game/events.ts';
import { dayAtTick } from '../game/characters.ts';
import { type PedestrianField } from '../game/pedestrians.ts';
import { trafficSeconds } from '../game/traffic.ts';
import { triangle } from '../game/streetlife.ts';

// --- Geometry -------------------------------------------------------------------------------

/** Triangle accumulator. `world/characters.Parts` without the rings. */
class Parts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

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

  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    colour: readonly [number, number, number],
  ): void {
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colour);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour);
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

/** White, so `instanceColor` is the only thing that decides what colour a thing is. */
const WHITE: readonly [number, number, number] = [1, 1, 1];
/** Everything on an object that is *not* tinted carries its own colour instead. */
const SKIN: readonly [number, number, number] = [0.48, 0.33, 0.24];
const DARK: readonly [number, number, number] = [0.05, 0.05, 0.055];
const GLASS: readonly [number, number, number] = [0.06, 0.08, 0.1];
const TYRE: readonly [number, number, number] = [0.02, 0.02, 0.022];
const HAZARD: readonly [number, number, number] = [0.9, 0.35, 0.02];
const BIN_LID: readonly [number, number, number] = [0.35, 0.03, 0.03];
const SIGN_FACE: readonly [number, number, number] = [0.75, 0.6, 0.05];
const SIGN_TEXT: readonly [number, number, number] = [0.04, 0.04, 0.045];
const IBIS_WHITE: readonly [number, number, number] = [0.68, 0.66, 0.6];
const IBIS_BLACK: readonly [number, number, number] = [0.03, 0.03, 0.035];

/**
 * A note kept where somebody will read it: **these are not `world/wildlife.ts`'s
 * ibises.**
 *
 * That file has a proper bird -- a body, a neck, a curved bill, five instanced
 * sets and a walk -- and this file draws a much cruder one. The reason is
 * ownership rather than laziness: `WildlifeFlock` draws the birds that
 * `game/wildlife.ts` places, from anchors that file owns, into pools sized
 * against its own budget. Feeding it a dozen positions from a different module
 * would mean either a second entry point into somebody else's renderer or an
 * event that competes with the parks for the wildlife's instance capacity.
 *
 * So bin night draws its own, and the honest statement is that at the range this
 * event is legible -- a kerb across the street -- a white body, a black head and
 * a down-curved bill is what an ibis is. Up close it is worse than the real one.
 * If the two are ever merged, this is the paragraph that says why they were not.
 */
export const IBIS_NOTE = 'see world/wildlife.ts for the real bird';

/** How many of each object can be on screen at once. Sizes the instanced sets. */
export const EVENT_BODY_CAPACITY = 96;
export const EVENT_CAR_CAPACITY = 12;
export const EVENT_PROP_CAPACITY = 24;
export const EVENT_BIRD_CAPACITY = 48;

/** How far an event is drawn, metres. `STREET_DRAW_RADIUS`, so the two agree. */
export const EVENT_DRAW_RADIUS = 150;

/**
 * Every piece of geometry an event draws, built once for the city.
 *
 * `CharacterKitAssets`' contract and its teardown rule: a scene must never
 * dispose these while another one is drawing them. There is exactly one
 * `EventScene` in the build, so in practice this is a formality -- it is written
 * down because the formality is what stops the second one being wrong.
 */
export class EventAssets {
  readonly body: BufferGeometry;
  readonly car: BufferGeometry;
  readonly bin: BufferGeometry;
  readonly sign: BufferGeometry;
  readonly bird: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;

  constructor() {
    // --- The figure. Forty triangles: legs, torso, head, and two arms that do
    // not move. `world/people.ts`'s impostor without the swinging legs, because
    // nothing in an event walks -- see the header.
    //
    // The torso is white so `instanceColor` can tint it; the head and hands are
    // skin and the legs are dark, both of which then get multiplied by the tint,
    // which is `world/people.ts`'s stated wall and the reason that file has six
    // sets. It is accepted here rather than worked around: an event's crowd in a
    // navy shirt gets slightly navy hands, and at forty metres the hands are two
    // pixels.
    const body = new Parts();
    body.box(0, 0.41, 0, 0.18, 0.41, 0.11, DARK); // legs, as one block
    body.box(0, 1.11, 0, 0.19, 0.29, 0.13, WHITE); // torso, tinted
    body.box(0, 1.53, 0, 0.11, 0.13, 0.11, SKIN); // head
    body.box(-0.245, 1.08, 0, 0.055, 0.26, 0.055, SKIN); // arms
    body.box(0.245, 1.08, 0, 0.055, 0.26, 0.055, SKIN);
    this.body = body.build('event-body');

    // --- The car. A 4.6 m hatch-ish box with a cabin, four tyres and two amber
    // hazard flashes at the corners. Deliberately not `world/cars.ts`' model:
    // that geometry is loaded from the world bake and is driven by the traffic
    // instancer, and reaching into it for a stationary prop would couple this
    // file to a decoder it has no business knowing about.
    const car = new Parts();
    car.box(0, 0.62, 0, 0.9, 0.32, 2.3, WHITE); // hull, tinted
    car.box(0, 1.05, -0.15, 0.78, 0.28, 1.25, GLASS); // cabin
    for (const [sx, sz] of [[-0.86, 1.55], [0.86, 1.55], [-0.86, -1.55], [0.86, -1.55]] as Array<[number, number]>) {
      car.box(sx, 0.31, sz, 0.09, 0.31, 0.31, TYRE);
    }
    car.box(-0.72, 0.72, 2.29, 0.14, 0.1, 0.03, HAZARD);
    car.box(0.72, 0.72, 2.29, 0.14, 0.1, 0.03, HAZARD);
    car.box(-0.72, 0.72, -2.29, 0.14, 0.1, 0.03, HAZARD);
    car.box(0.72, 0.72, -2.29, 0.14, 0.1, 0.03, HAZARD);
    this.car = car.build('event-car');

    // --- The bin. A tapered box is not worth the quads at this size, so it is a
    // box with a lid overhanging it, which is the silhouette.
    const bin = new Parts();
    bin.box(0, 0.52, 0, 0.29, 0.52, 0.24, WHITE);
    bin.box(0, 1.07, 0.02, 0.31, 0.04, 0.27, BIN_LID);
    this.bin = bin.build('event-bin');

    // --- The A-frame. Two leaning faces and a yellow front with three dark bars
    // on it, which at any distance reads as text on a sign and at no distance
    // reads as words -- there is no text rendering in this build outside the
    // HUD, and putting one here for five characters would be a font.
    const sign = new Parts();
    sign.quad([-0.36, 0, -0.22], [0.36, 0, -0.22], [0.3, 0.86, 0.02], [-0.3, 0.86, 0.02], SIGN_FACE);
    sign.quad([0.36, 0, 0.26], [-0.36, 0, 0.26], [-0.3, 0.86, 0.02], [0.3, 0.86, 0.02], SIGN_FACE);
    for (let i = 0; i < 3; i++) {
      const y = 0.28 + i * 0.18;
      const w = 0.24 - i * 0.03;
      sign.quad([-w, y, -0.16], [w, y, -0.16], [w, y + 0.055, -0.155], [-w, y + 0.055, -0.155], SIGN_TEXT);
    }
    this.sign = sign.build('event-sign');

    // --- The ibis. See `IBIS_NOTE`.
    const bird = new Parts();
    bird.box(0, 0.2, 0, 0.075, 0.075, 0.15, IBIS_WHITE); // body
    bird.box(0, 0.31, -0.09, 0.03, 0.09, 0.03, IBIS_BLACK); // neck
    bird.box(0, 0.36, -0.15, 0.025, 0.025, 0.075, IBIS_BLACK); // head and bill
    bird.box(-0.035, 0.09, 0.02, 0.012, 0.09, 0.012, IBIS_BLACK); // legs
    bird.box(0.035, 0.09, 0.02, 0.012, 0.09, 0.012, IBIS_BLACK);
    this.bird = bird.build('event-ibis');

    this.triangles =
      body.triangles + car.triangles + bin.triangles + sign.triangles + bird.triangles;

    const material = new MeshStandardNodeMaterial();
    material.name = 'events';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    material.roughness = 0.66;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }

  dispose(): void {
    for (const g of [this.body, this.car, this.bin, this.sign, this.bird]) g.dispose();
    this.material.dispose();
  }
}

// --- The colours a look byte picks ------------------------------------------------------------

/**
 * Eight shirt colours for the ambient crowd, and two of them are not shirts.
 *
 * Index 6 is the police navy and index 7 is a meth head's bare chest, so a
 * `CAST_ROLE.COP` and a `CAST_ROLE.JUNKIE` need no second set -- they are a body
 * with a fixed look byte. That saves two instanced meshes and it is the reason
 * the standoff's ambient tier costs the same as anybody standing on a footpath.
 *
 * Bit 7 of `look` is the trackwork drunk's flag (see `castOf`), and it maps to
 * the fluoro at index 5, which is a hi-vis vest at the end of a queue for a bus
 * that is not coming and is the single most Sydney object in this file.
 */
const CROWD_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.42, 0.44, 0.47],
  [0.13, 0.16, 0.3],
  [0.34, 0.16, 0.14],
  [0.16, 0.28, 0.2],
  [0.6, 0.58, 0.53],
  [0.72, 0.85, 0.05],
  [0.035, 0.05, 0.14],
  [0.4, 0.28, 0.21],
];

/** The Ranger and the Camry. Look 0 and 1 in `castOf`'s fender-bender. */
const CAR_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.06, 0.07, 0.075], // a black Ranger
  [0.55, 0.55, 0.57], // a silver Camry
  [0.22, 0.03, 0.03], // a red one, for the hoon
  [0.05, 0.06, 0.14],
];

// --- The scene ---------------------------------------------------------------------------------

/**
 * Every live event in view, drawn.
 *
 * `update` allocates nothing after the first frame. Not parented to a tile, on
 * `StreetCrowd`'s argument: an event straddles a tile boundary and is drawn as
 * one set for the whole visible world.
 */
export class EventScene {
  /** Add these to the scene. Five of them, forever. */
  readonly meshes: readonly InstancedMesh[];

  /** Diagnostics for the HUD. */
  sites = 0;
  drawn = 0;
  costMs = 0;

  /** The live sites this frame, for the map sources and the queue test. */
  readonly live: EventSite[] = [];

  private readonly bodies: InstancedMesh;
  private readonly cars: InstancedMesh;
  private readonly bins: InstancedMesh;
  private readonly signs: InstancedMesh;
  private readonly birds: InstancedMesh;

  private readonly cast: CastMember[] = [];
  private readonly matrix = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly tint = new Color();

  constructor(assets: EventAssets) {
    this.bodies = new InstancedMesh(assets.body, assets.material, EVENT_BODY_CAPACITY);
    this.cars = new InstancedMesh(assets.car, assets.material, EVENT_CAR_CAPACITY);
    this.bins = new InstancedMesh(assets.bin, assets.material, EVENT_PROP_CAPACITY);
    this.signs = new InstancedMesh(assets.sign, assets.material, EVENT_PROP_CAPACITY);
    this.birds = new InstancedMesh(assets.bird, assets.material, EVENT_BIRD_CAPACITY);
    this.meshes = [this.bodies, this.cars, this.bins, this.signs, this.birds];
    for (const m of this.meshes) {
      m.name = `events:${m.geometry.name}`;
      m.castShadow = true;
      m.receiveShadow = true;
      // `frustumCulled` stays on: unlike a prop hanging off a figure that is
      // already tested, these are world-space sets whose bounds genuinely change
      // and there is nothing else covering them.
      m.count = 0;
      m.instanceMatrix.setUsage(35048 /* DynamicDrawUsage */);
    }
  }

  /**
   * Draw whatever is happening within `EVENT_DRAW_RADIUS`.
   *
   * `tick` may be fractional -- `StreetCrowd.update`'s split, and it matters
   * more here than anywhere else in this feature because the hoon's car is
   * genuinely moving: resolved at 60 Hz and drawn at 144 it stutters visibly at
   * seven metres of radius.
   *
   * `groundAt` is the caller's composed ground query. `game/events.ts` returns
   * every cast member at `y = 0` deliberately -- see `CastMember` -- because the
   * authority and this renderer have two different terrain residency sets and a
   * height computed in the shared module would be wrong on one of them.
   */
  update(
    tick: number,
    x: number,
    z: number,
    groundAt: (x: number, z: number) => number,
    peds: PedestrianField | null = null,
  ): void {
    const at = performance.now();
    const day = dayAtTick(tick);
    const now = trafficSeconds(tick);
    liveEventsAt(
      Math.floor(tick),
      x - EVENT_DRAW_RADIUS,
      z - EVENT_DRAW_RADIUS,
      x + EVENT_DRAW_RADIUS,
      z + EVENT_DRAW_RADIUS,
      this.live,
      peds,
    );
    this.sites = this.live.length;

    let bodies = 0;
    let cars = 0;
    let bins = 0;
    let signs = 0;
    let birds = 0;

    for (const site of this.live) {
      const sdx = site.x - x;
      const sdz = site.z - z;
      // The site's own gate, widened by the cast's reach. A gate tighter than
      // the placement deletes the tail of a queue -- `CAST_REACH`'s header, and
      // `streetlife.METH_REACH`'s before it.
      const gate = EVENT_DRAW_RADIUS + CAST_REACH;
      if (sdx * sdx + sdz * sdz > gate * gate) continue;
      const progress = eventProgress(site, day.phase);
      if (progress < 0) continue;
      const n = castOf(site, Math.floor(tick), progress, this.cast);
      for (let i = 0; i < n; i++) {
        const m = this.cast[i];
        switch (m.role) {
          case CAST_ROLE.BODY:
          case CAST_ROLE.COP:
          case CAST_ROLE.JUNKIE: {
            if (bodies >= EVENT_BODY_CAPACITY) break;
            // The role picks the colour when it is not an ordinary body, which
            // is what lets a constable and a meth head be a body with a fixed
            // look byte. See `CROWD_COLOURS`.
            const look =
              m.role === CAST_ROLE.COP ? 6 : m.role === CAST_ROLE.JUNKIE ? 7 : (m.look & 0x80) !== 0 ? 5 : m.look & 7;
            // The gesture: a lean along the heading on a triangle wave, which is
            // three multiplies and is the only movement in the whole file. A
            // driver mid-argument leans in; a commuter in a queue shifts their
            // weight. Same code, different amplitude by role.
            const amp = m.role === CAST_ROLE.JUNKIE ? 0.09 : 0.05;
            const lean = triangle(now / 1.9 + m.phase) * amp;
            this.place(this.bodies, bodies, m.x, groundAt(m.x, m.z), m.z, m.dx, m.dz, lean, CROWD_COLOURS[look]);
            bodies++;
            break;
          }
          case CAST_ROLE.CAR: {
            if (cars >= EVENT_CAR_CAPACITY) break;
            this.place(this.cars, cars, m.x, groundAt(m.x, m.z), m.z, m.dx, m.dz, 0, CAR_COLOURS[m.look & 3]);
            cars++;
            break;
          }
          case CAST_ROLE.HOON: {
            if (cars >= EVENT_CAR_CAPACITY) break;
            // The donut, resolved here rather than in the shared module: the
            // renderer runs between ticks and this is the one thing in the
            // feature whose position changes fast enough to matter. `phase` is
            // where on the lap it is; the tangent is the heading, and the car is
            // therefore always sideways to the circle, which is what a donut is.
            const a = m.phase * Math.PI * 2;
            const cx = m.x + Math.cos(a) * DONUT_RADIUS;
            const cz = m.z + Math.sin(a) * DONUT_RADIUS;
            // Tangent, plus a fixed slip angle, because a car doing donuts is
            // not pointed where it is going. Thirty-five degrees of it.
            const tx = -Math.sin(a);
            const tz = Math.cos(a);
            const c = 0.82;
            const s = 0.57;
            this.place(this.cars, cars, cx, groundAt(cx, cz), cz, tx * c - tz * s, tz * c + tx * s, 0, CAR_COLOURS[2]);
            cars++;
            break;
          }
          case CAST_ROLE.BIN: {
            if (bins >= EVENT_PROP_CAPACITY) break;
            // Look bit 0 is "this one is over". A knocked bin is a quarter turn
            // about its own heading, which `place`'s `lean` argument already
            // does -- it is a rotation about the axis across the heading, and at
            // 1.5 radians that is a bin on its side.
            const over = (m.look & 1) === 1 ? 1.5 : 0;
            this.place(this.bins, bins, m.x, groundAt(m.x, m.z), m.z, m.dx, m.dz, over, [0.1, 0.11, 0.12]);
            bins++;
            break;
          }
          case CAST_ROLE.SIGN: {
            if (signs >= EVENT_PROP_CAPACITY) break;
            this.place(this.signs, signs, m.x, groundAt(m.x, m.z), m.z, m.dx, m.dz, 0, [1, 1, 1]);
            signs++;
            break;
          }
          case CAST_ROLE.IBIS: {
            if (birds >= EVENT_BIRD_CAPACITY) break;
            // A peck: the bird tips forward and back. Same triangle, bigger
            // amplitude, and it is the only reason twelve identical birds read
            // as a flock rather than as a decal.
            const peck = 0.35 + triangle(now / 0.7 + m.phase) * 0.35;
            this.place(this.birds, birds, m.x, groundAt(m.x, m.z), m.z, m.dx, m.dz, peck, [1, 1, 1]);
            birds++;
            break;
          }
        }
      }
    }

    this.bodies.count = bodies;
    this.cars.count = cars;
    this.bins.count = bins;
    this.signs.count = signs;
    this.birds.count = birds;
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.drawn = bodies + cars + bins + signs + birds;
    this.costMs = performance.now() - at;
  }

  /**
   * One instance: position, heading, a pitch, and a tint.
   *
   * The heading is a quaternion about +Y built from `(dx, dz)` with a single
   * `atan2`, which is the presentation-side transcendental
   * `game/factions.ts`'s rule explicitly permits -- nothing downstream of it
   * decides anything. The pitch is then a second quaternion about the object's
   * own +X, which is what a lean, a tipped bin and a pecking bird all are.
   */
  private place(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    pitch: number,
    tint: readonly [number, number, number],
  ): void {
    this.pos.set(x, y, z);
    this.up.set(0, 1, 0);
    this.quat.setFromAxisAngle(this.up, Math.atan2(-dx, -dz));
    if (pitch !== 0) {
      // About the object's local X, applied after the yaw, which is what
      // `Quaternion.multiply` with the axis-angle on the right does.
      const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch);
      this.quat.multiply(tilt);
    }
    this.matrix.compose(this.pos, this.quat, this.scale);
    mesh.setMatrixAt(index, this.matrix);
    this.tint.setRGB(tint[0], tint[1], tint[2]);
    mesh.setColorAt(index, this.tint);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.dispose();
    }
  }
}

/**
 * Are you standing in the trackwork queue, and for how long?
 *
 * The one interaction an event has with the player that is not "you hit
 * somebody", and it is entirely client-side -- there is nothing authoritative
 * about standing in a queue. Returns the site if the player is inside the
 * queue's footprint, and null otherwise; `main.ts` runs the twenty-second clock,
 * because a clock is state and this object is a renderer.
 *
 * The footprint is a capsule along the queue rather than a disc around the site:
 * the queue is twenty-two metres long and two wide, and a disc big enough to
 * contain it would fire when you were standing on the other side of the
 * forecourt.
 */
export function inTrackworkQueue(live: readonly EventSite[], x: number, z: number): EventSite | null {
  for (const site of live) {
    if (site.kind !== EVENT_KIND.TRACKWORK) continue;
    const dx = x - site.x;
    const dz = z - site.z;
    if (dx * dx + dz * dz > CAST_REACH * CAST_REACH) continue;
    return site;
  }
  return null;
}

// --- The self-check -----------------------------------------------------------------------------

/**
 * The look, checked for the ways it fails without throwing.
 *
 *   - **An instanced set too small for its cast** silently truncates, and the
 *     symptom is a trackwork queue whose last six people are missing -- which
 *     reads as a placement bug in a file that is not this one.
 *   - **Geometry below the ground plane** is a body sunk to its knees, and
 *     because every one of these objects is placed at the ground height, a
 *     figure whose feet are at -0.1 is a figure standing in the road surface at
 *     every single site.
 *   - **A prop wound inside out** is the failure `verifyPoliceKit` and
 *     `verifyStreetlifeKit` both exist for, and it costs a screenshot to find.
 *   - **A colour table shorter than its index mask** is an `undefined` handed to
 *     `Color.setRGB`, which produces a black object rather than a throw.
 */
export function verifyEventKit(assets: EventAssets): string[] {
  const failures: string[] = [];

  // The body capacity has to hold the biggest cast this feature can produce, in
  // the worst case of several events overlapping. `MAX_CAST` is 24 and the draw
  // radius can hold three or four sites; 96 is four full casts.
  if (EVENT_BODY_CAPACITY < MAX_CAST * 4) {
    failures.push(
      `The body set holds ${EVENT_BODY_CAPACITY} against a cast cap of ${MAX_CAST}; four overlapping events ` +
        'would silently lose the tail of one.',
    );
  }
  if (EVENT_BIRD_CAPACITY < 12) failures.push('The bird set cannot hold one bin night.');

  // --- Everything stands on the ground rather than in it. The one exception is
  // a bin lid overhang, which is above.
  for (const [name, g] of [
    ['body', assets.body], ['car', assets.car], ['bin', assets.bin], ['sign', assets.sign], ['bird', assets.bird],
  ] as Array<[string, BufferGeometry]>) {
    const pos = g.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minY < -0.01) {
      failures.push(`The ${name} reaches ${minY.toFixed(3)} m below its own origin, so it is drawn sunk into the road.`);
    }
    if (maxY <= 0.05) failures.push(`The ${name} is ${maxY.toFixed(3)} m tall, which is not an object.`);
  }
  // A person is a person's height, and a car is a car's. Both are asserted
  // because both are the kind of thing that is off by a factor of ten exactly
  // once and looks like a rendering bug rather than a typo.
  {
    const pos = assets.body.getAttribute('position');
    let maxY = 0;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    if (maxY < 1.55 || maxY > 1.85) failures.push(`The event figure is ${maxY.toFixed(2)} m tall; a person is 1.70.`);
  }
  {
    const pos = assets.car.getAttribute('position');
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const length = maxZ - minZ;
    if (length < 3.6 || length > 5.6) failures.push(`The event car is ${length.toFixed(2)} m long; a car is about 4.6.`);
  }

  // --- Winding, by signed volume about the centroid. `verifyCharacterKit`'s
  // test, and the sign is what says whether the triangles face out.
  for (const [name, g] of [['body', assets.body], ['car', assets.car], ['bin', assets.bin], ['bird', assets.bird]] as Array<
    [string, BufferGeometry]
  >) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    if (!idx) {
      failures.push(`The ${name} has no index buffer.`);
      continue;
    }
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
    let volume = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t);
      const b = idx.getX(t + 1);
      const c = idx.getX(t + 2);
      const ax = pos.getX(a) - cx, ay = pos.getY(a) - cy, az = pos.getZ(a) - cz;
      const bx = pos.getX(b) - cx, by = pos.getY(b) - cy, bz = pos.getZ(b) - cz;
      const gx = pos.getX(c) - cx, gy = pos.getY(c) - cy, gz = pos.getZ(c) - cz;
      volume += ax * (by * gz - bz * gy) - ay * (bx * gz - bz * gx) + az * (bx * gy - by * gx);
    }
    if (volume <= 0) {
      failures.push(`The ${name}'s signed volume is ${volume.toFixed(3)}; its triangles are wound inward.`);
    }
  }

  // --- The colour tables against the masks that index them.
  if (CROWD_COLOURS.length < 8) failures.push(`CROWD_COLOURS has ${CROWD_COLOURS.length} rows and is indexed by a 3-bit mask.`);
  if (CAR_COLOURS.length < 4) failures.push(`CAR_COLOURS has ${CAR_COLOURS.length} rows and is indexed by a 2-bit mask.`);
  for (const table of [CROWD_COLOURS, CAR_COLOURS]) {
    for (const c of table) {
      if (c.length !== 3 || c.some((v) => !(v >= 0 && v <= 1))) {
        failures.push('A colour table row is not three channels in [0, 1]; it would draw black.');
        break;
      }
    }
  }

  if (assets.triangles > 400) {
    failures.push(`The event kit is ${assets.triangles} triangles across five objects; that is a model, not a prop set.`);
  }

  return failures;
}

/** The geometries, for the warm-up pass. `characterWarmupParts`' contract. */
export function eventWarmupParts(assets: EventAssets): WarmupPart[] {
  return [assets.body, assets.car, assets.bin, assets.sign, assets.bird].map((geometry) => ({
    geometry,
    material: assets.material,
  }));
}
