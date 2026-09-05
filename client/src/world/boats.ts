/**
 * The boats, drawn: four hulls built from boxes, one mesh per boat, posed each
 * frame from `game/boats.ts`.
 *
 * Parametric rather than downloaded, for `pipeline/sydney/landmarks.py`'s
 * reason: the thing has to look like *the* Sydney ferry -- the Freshwater's
 * double-ended green hull with the cream decks and the squat funnel -- and no
 * asset store has one under a licence this repo can carry. Boxes with vertex
 * colours, in the palette the ferries actually wear: Sydney Ferries green on
 * the hull and trim, cream on the superstructure, a dark band of windows.
 *
 * Forty-odd meshes at most and most of them culled by distance, so no
 * instancing: a ferry is 300 triangles and the harbour has thirty. `update`
 * costs one pose per boat per frame, which is a few thousand multiplies.
 *
 * ---------------------------------------------------------------------------
 * THE HULLS ARE BUILT FROM `game/boats.ts`'S TABLES, NOT FROM LITERALS HERE.
 *
 * Every `L` and `W` below is `BOAT_SIZE`'s, and the window bands are a loop over
 * `BOAT_WINDOW_ROWS` rather than four hand-written boxes. They used to be
 * literals and it cost nothing while this file was the only thing that knew what
 * shape a ferry is; `world/nightlights.BoatLights` is the second reader, and a
 * navigation light is a lamp *on a specific part of a specific hull*. The one
 * copy is what makes the green light land on the starboard bridge wing rather
 * than 30 cm outboard of it -- see `game/boats.ts`'s note on the same tables.
 *
 * The night lights themselves are **not** built here. They are additive sprites
 * on the shared `nightOpacity` uniform and they belong with every other one in
 * the city; what this file owes them is the pose it has already computed, handed
 * over through `lights` from inside the one loop that places the hulls, for
 * `world/cars.TrafficMovers`' reason exactly: a second pass that had to agree
 * with this one about where a ferry is, is how a set of nav lights ends up
 * sailing forty metres behind its own ship.
 */
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';

import {
  BOAT_KIND,
  BOAT_SIZE,
  BOAT_WINDOW_ROWS,
  bobAt,
  createBoatPose,
  ferries,
  ferryPose,
  tinnies,
  type BoatKind,
  type BoatPose,
} from '../game/boats.ts';
import type { BoatLightSink } from './nightlights.ts';

/** How far a ferry is drawn from the camera, and a tinnie. */
export const FERRY_DRAW_M = 4200;
export const TINNIE_DRAW_M = 1400;

interface Rgb { r: number; g: number; b: number }
const GREEN: Rgb = { r: 0.18, g: 0.38, b: 0.25 };
const CREAM: Rgb = { r: 0.93, g: 0.89, b: 0.80 };
const WINDOW: Rgb = { r: 0.12, g: 0.15, b: 0.19 };
const WHITE: Rgb = { r: 0.95, g: 0.96, b: 0.95 };
const ALLOY: Rgb = { r: 0.70, g: 0.72, b: 0.74 };
const DARK: Rgb = { r: 0.15, g: 0.15, b: 0.16 };
const DECK: Rgb = { r: 0.55, g: 0.50, b: 0.42 };

/** A box builder: local x is the bow, y up, z starboard. */
class Boxes {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  box(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, c: Rgb, shade = 1): void {
    const x0 = cx - lx / 2; const x1 = cx + lx / 2;
    const y0 = cy; const y1 = cy + ly;
    const z0 = cz - lz / 2; const z1 = cz + lz / 2;
    const quad = (a: number[], b: number[], c2: number[], d: number[], n: number[], k: number): void => {
      for (const v of [a, b, c2, a, c2, d]) this.pos.push(v[0], v[1], v[2]);
      for (let i = 0; i < 6; i++) { this.nor.push(n[0], n[1], n[2]); this.col.push(c.r * shade * k, c.g * shade * k, c.b * shade * k); }
    };
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], 1);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], [0, -1, 0], 0.5);
    quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [0, 0, 1], 0.9);
    quad([x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [0, 0, -1], 0.8);
    quad([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [1, 0, 0], 0.85);
    quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0], 0.85);
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    return g;
  }
}

/**
 * The saloon window bands, from the one table the night's glow is painted off.
 * See this file's header and `game/boats.BOAT_WINDOW_ROWS`.
 */
function windowBands(b: Boxes, kind: BoatKind): void {
  for (const row of BOAT_WINDOW_ROWS[kind]) b.box(row.x, row.y, 0, row.length, row.height, row.beam, WINDOW);
}

/** The Freshwater class: 70 m, double-ended, two decks, a funnel amidships. */
function freshwater(): BufferGeometry {
  const b = new Boxes();
  const { length: L, beam: W } = BOAT_SIZE[BOAT_KIND.FRESHWATER];
  // hull: a low green band at the waterline with tapered ends made of three steps
  b.box(0, -1.6, 0, L * 0.62, 2.6, W, GREEN);
  b.box(L * 0.36, -1.2, 0, L * 0.18, 2.2, W * 0.78, GREEN);
  b.box(-L * 0.36, -1.2, 0, L * 0.18, 2.2, W * 0.78, GREEN);
  b.box(L * 0.47, -0.8, 0, L * 0.06, 1.8, W * 0.5, GREEN);
  b.box(-L * 0.47, -0.8, 0, L * 0.06, 1.8, W * 0.5, GREEN);
  // main deck house, cream, with a window band
  b.box(0, 1.0, 0, L * 0.86, 0.35, W * 0.96, DECK);
  b.box(0, 1.35, 0, L * 0.80, 2.4, W * 0.9, CREAM);
  // upper deck, set in, with its window band and the open promenade ends
  b.box(0, 3.75, 0, L * 0.62, 0.3, W * 0.88, DECK);
  b.box(0, 4.05, 0, L * 0.52, 2.3, W * 0.78, CREAM);
  b.box(0, 6.35, 0, L * 0.66, 0.3, W * 0.9, CREAM);
  // wheelhouses at both ends, funnel, mast
  b.box(L * 0.30, 6.65, 0, 5, 2.2, W * 0.5, CREAM);
  b.box(-L * 0.30, 6.65, 0, 5, 2.2, W * 0.5, CREAM);
  b.box(0, 6.65, 0, 3.2, 3.4, 2.4, CREAM);
  b.box(0, 10.05, 0, 3.3, 0.6, 2.5, GREEN);
  b.box(0, 6.65, 0, 0.3, 6.5, 0.3, DARK);
  // green trim line along the main deck
  b.box(0, 3.7, 0, L * 0.80 + 0.06, 0.12, W * 0.9 + 0.06, GREEN);
  windowBands(b, BOAT_KIND.FRESHWATER);
  return b.geometry();
}

/** The inner-harbour ferry, the Emerald shape: 35 m, one wheelhouse forward. */
function harbour(): BufferGeometry {
  const b = new Boxes();
  const { length: L, beam: W } = BOAT_SIZE[BOAT_KIND.HARBOUR];
  b.box(0, -1.3, 0, L * 0.66, 2.1, W, GREEN);
  b.box(L * 0.40, -1.0, 0, L * 0.14, 1.8, W * 0.74, GREEN);
  b.box(-L * 0.39, -1.0, 0, L * 0.12, 1.8, W * 0.8, GREEN);
  b.box(L * 0.49, -0.6, 0, L * 0.05, 1.4, W * 0.4, GREEN);
  b.box(0, 0.8, 0, L * 0.9, 0.3, W * 0.96, DECK);
  b.box(-L * 0.05, 1.1, 0, L * 0.72, 2.3, W * 0.88, CREAM);
  b.box(-L * 0.05, 3.4, 0, L * 0.76, 0.25, W * 0.92, CREAM);
  b.box(L * 0.18, 3.65, 0, 6, 2.0, W * 0.6, CREAM);
  b.box(-L * 0.2, 3.65, 0, 2.2, 2.4, 1.8, GREEN);
  b.box(0, 3.35, 0, L * 0.72 + 0.06, 0.12, W * 0.88 + 0.06, GREEN);
  windowBands(b, BOAT_KIND.HARBOUR);
  return b.geometry();
}

/** The RiverCat: a white catamaran with the green band, 35 m. */
function rivercat(): BufferGeometry {
  const b = new Boxes();
  const { length: L, beam: W } = BOAT_SIZE[BOAT_KIND.RIVERCAT];
  for (const side of [-1, 1]) {
    b.box(0, -1.4, side * W * 0.34, L * 0.9, 2.0, W * 0.24, WHITE);
    b.box(L * 0.48, -1.0, side * W * 0.34, L * 0.06, 1.4, W * 0.16, WHITE);
  }
  b.box(0, 0.5, 0, L * 0.82, 0.5, W * 0.96, WHITE);
  b.box(-L * 0.02, 1.0, 0, L * 0.7, 2.2, W * 0.86, WHITE);
  b.box(-L * 0.02, 1.0, 0, L * 0.7 + 0.06, 0.35, W * 0.86 + 0.06, GREEN);
  b.box(-L * 0.02, 3.2, 0, L * 0.72, 0.25, W * 0.9, WHITE);
  b.box(L * 0.2, 3.45, 0, 5, 1.7, W * 0.5, WHITE);
  windowBands(b, BOAT_KIND.RIVERCAT);
  return b.geometry();
}

/** A 4.5 m aluminium tinnie with an outboard, docked. */
function tinnie(): BufferGeometry {
  const b = new Boxes();
  b.box(0, -0.35, 0, 3.6, 0.7, 1.7, ALLOY);
  b.box(2.05, -0.2, 0, 0.9, 0.5, 1.0, ALLOY);
  b.box(0, 0.35, 0, 3.7, 0.08, 1.8, ALLOY, 0.85);
  b.box(-0.6, 0.0, 0, 0.5, 0.45, 1.5, DECK);
  b.box(0.7, 0.0, 0, 0.5, 0.45, 1.5, DECK);
  b.box(-2.05, 0.0, 0, 0.5, 0.9, 0.5, DARK);
  return b.geometry();
}

/**
 * A jetski, with its rider: a 2.9 m hull in white with a red flank, the seat,
 * a handlebar post, and a crouched body in a black wetsuit. Boxes, like the
 * rest, at the same origin convention (x forward, y up from the waterline).
 */
function jetski(): BufferGeometry {
  const b = new Boxes();
  const WHITE: Rgb = { r: 0.92, g: 0.92, b: 0.9 };
  const RED: Rgb = { r: 0.8, g: 0.12, b: 0.1 };
  const WET: Rgb = { r: 0.08, g: 0.08, b: 0.1 };
  const SKIN: Rgb = { r: 0.72, g: 0.52, b: 0.4 };
  b.box(0, -0.3, 0, 2.9, 0.45, 1.05, WHITE);
  b.box(0.2, -0.32, 0, 2.2, 0.5, 1.12, RED, 0.95);
  b.box(0.9, 0.15, 0, 1.0, 0.3, 0.8, WHITE, 0.9);
  b.box(-0.4, 0.15, 0, 1.3, 0.32, 0.55, DARK);
  b.box(0.75, 0.45, 0, 0.12, 0.45, 0.12, DARK);
  b.box(0.75, 0.88, 0, 0.12, 0.08, 0.6, DARK);
  b.box(-0.35, 0.47, 0, 0.5, 0.55, 0.42, WET);
  b.box(-0.1, 0.6, 0, 0.3, 0.42, 0.34, WET, 0.9);
  b.box(-0.1, 1.02, 0, 0.24, 0.24, 0.22, SKIN);
  b.box(-0.5, 0.15, 0.28, 0.5, 0.4, 0.14, WET);
  b.box(-0.5, 0.15, -0.28, 0.5, 0.4, 0.14, WET);
  return b.geometry();
}

export class BoatFleet extends Group {
  private readonly material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
  private readonly geometries: Record<BoatKind, BufferGeometry>;
  private readonly ferryMeshes: Mesh[] = [];
  private readonly ferryList = ferries();
  private readonly tinnieMeshes: Mesh[] = [];
  private readonly tinnieList = tinnies();
  private readonly pose: BoatPose = createBoatPose();
  drawn = 0;
  /**
   * Where the navigation lights go, or null before `main.ts` has wired the night
   * rig -- and null forever in any check that drives this fleet without one.
   *
   * A field rather than a constructor argument for `TrafficMovers.lights`'
   * reason: this file has no business knowing what a sidelight is, and the day
   * path is one `begin()` returning false rather than a branch per boat.
   */
  lights: BoatLightSink | null = null;

  constructor() {
    super();
    this.name = 'boats';
    this.geometries = { 0: freshwater(), 1: harbour(), 2: rivercat(), 3: tinnie(), 4: jetski() };
    for (const f of this.ferryList) {
      const mesh = new Mesh(this.geometries[f.kind], this.material);
      mesh.frustumCulled = true;
      mesh.visible = false;
      mesh.name = `ferry-${f.route}-${f.index}`;
      this.ferryMeshes.push(mesh);
      this.add(mesh);
    }
    for (const t of this.tinnieList) {
      const mesh = new Mesh(this.geometries[BOAT_KIND.TINNIE], this.material);
      mesh.visible = false;
      mesh.position.set(t.x, 0, t.z);
      mesh.rotation.y = Math.atan2(-t.hz, t.hx);
      this.tinnieMeshes.push(mesh);
      this.add(mesh);
    }
  }

  /** Pose every boat for this instant, and draw the ones in range of the camera. */
  update(seconds: number, camX: number, camZ: number, seaY: number): void {
    let drawn = 0;
    const p = this.pose;
    // False by day, and then `add` is never reached. See `CarLightSink`.
    const lit = this.lights?.begin() ?? false;
    for (let i = 0; i < this.ferryList.length; i++) {
      const f = this.ferryList[i];
      ferryPose(f.r, f.index, seconds, p);
      const mesh = this.ferryMeshes[i];
      const dx = p.x - camX;
      const dz = p.z - camZ;
      if (dx * dx + dz * dz > FERRY_DRAW_M * FERRY_DRAW_M) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const y = seaY + 0.05 + (p.docked ? bobAt(seconds, f.index * 0.37) * 0.5 : 0);
      mesh.position.set(p.x, y, p.z);
      mesh.rotation.y = Math.atan2(-p.hz, p.hx);
      // The waterline this hull is riding at, not sea level: the lights are
      // bolted to the boat and a docked ferry bobs. Fed from inside this loop
      // rather than from a second walk -- see this file's header.
      if (lit) this.lights?.add(p, y);
      drawn++;
    }
    for (let i = 0; i < this.tinnieList.length; i++) {
      const t = this.tinnieList[i];
      const mesh = this.tinnieMeshes[i];
      const dx = t.x - camX;
      const dz = t.z - camZ;
      if (dx * dx + dz * dz > TINNIE_DRAW_M * TINNIE_DRAW_M) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.y = seaY + 0.1 + bobAt(seconds, t.phase);
      drawn++;
    }
    // The tinnies get **no** navigation lights, and that is the rule rather than
    // an omission: they are moored runabouts with nobody aboard, and a boat under
    // way is the only thing that shows red and green. A row of lit tinnies at a
    // bay wharf would say "three vessels are moving here" to anyone who reads
    // them, which is the one thing nav lights are for.
    if (lit) this.lights?.end();
    this.drawn = drawn;
  }
}
