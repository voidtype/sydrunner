/**
 * The platform indicator: the next train, and the ones after it.
 *
 * The owner, on a platform: *"Can you also put train timetable up? that way we
 * can see the time -- a couple of reference photos for how they look on city
 * rail -- the names of the suburbs slowly scroll over time."* The photos are
 * the twin-screen Sydney Trains PIDS in its cream housing under a canopy:
 * left screen *Following services* with two rows, right screen *Next service*
 * with the line badge, the destination, the platform, "8 cars / All Stops",
 * and the stopping pattern scrolling up one station at a time.
 *
 * This draws that on one canvas and hangs it on one plane. **One board for the
 * whole city**, re-hung over whichever station the player is nearest, because
 * a board is only readable from a platform and a body is on one platform at a
 * time. That is the whole of the performance argument: one 1024 x 384 canvas
 * redrawn twice a second, one mesh, one material, no per-station geometry in
 * the tiles and nothing for the streamer to carry.
 *
 * What it says comes from `rail.nextArrivals` -- the same function the boarding
 * prompt and the HUD's arrivals read -- so the board and the train agree to the
 * second. The stopping pattern is the direction's calling stops after this
 * one, read off `dir.stops`, which is why an express reads as an express.
 *
 * ## Where it hangs
 *
 * At the station's site (`RailStation.siteX/siteZ`, the mean of its calling
 * anchors -- the one point the bake vouches is on the platforms rather than at
 * the OSM node 126 m away), 2.7 m over the deck, its face square across the
 * platform so a body walking along it reads it head-on, as in the photo. It
 * turns to face whichever end the player is at: a plane has one front, and a
 * mirrored timetable is worse than none.
 *
 * ## What is checked
 *
 * The content -- rows, stops, scroll position, the "Now / 4 min" text -- is
 * pure and `verifyPids` holds it against a fixture bake. The canvas is not:
 * there is no 2D context under bun, and the board is one of the things the
 * owner's eyes judge.
 */

import {
  CanvasTexture,
  FrontSide,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three/webgpu';
import { PLATFORM_TOP_M } from '../game/riding.ts';
import { nextArrivals, type RailBake, type RailDirection, type RailStation } from '../game/rail.ts';

/** How far from a station's site the board is hung and drawn. */
export const PIDS_RANGE_M = 110;
/** Board face over the platform deck, metres. */
export const PIDS_HEIGHT_M = 2.7;
/** Canvas pixels, and the plane they map to in metres. 2.4 m x 0.9 m at 3.75 px/mm-ish. */
export const PIDS_PX_W = 1024;
export const PIDS_PX_H = 384;
export const PIDS_W_M = 2.4;
export const PIDS_H_M = 0.9;
/** How often the canvas is redrawn while a board is in range. */
export const PIDS_REDRAW_S = 0.5;
/** Stopping-pattern lines visible at once, and seconds each one holds before the list steps up. */
export const PIDS_STOP_LINES = 6;
export const PIDS_SCROLL_S = 1.6;
/** Under this many seconds away the board says "Now" rather than "0 min". */
export const PIDS_NOW_S = 45;

export interface BoardRow {
  /** The line's badge: `T1`, `M1`. */
  id: string;
  colour: number;
  towards: string;
  /** Seconds until it arrives at this station. */
  inSeconds: number;
  /** Calling stops after this one, in order. */
  stops: string[];
  metro: boolean;
}

/** The calling stops after `station` on `dir`, in order. Empty if it does not call there. */
export function stopsAfter(dir: RailDirection, station: string): string[] {
  const out: string[] = [];
  let past = false;
  for (const s of dir.stops) {
    if (!s.calls) continue;
    if (past) out.push(s.name);
    else if (s.name === station) past = true;
  }
  return out;
}

/** The board's three rows: next service first. */
export function boardRows(bake: RailBake, station: string, t: number): BoardRow[] {
  return nextArrivals(bake, station, t, 3).map((a) => ({
    id: a.line.id,
    colour: a.line.colour,
    towards: a.towards,
    inSeconds: a.inSeconds,
    stops: stopsAfter(a.dir, station),
    metro: a.line.metro,
  }));
}

/** "Now", or whole minutes rounded up, the way the real board counts. */
export function departsText(inSeconds: number): string {
  if (inSeconds < PIDS_NOW_S) return 'Now';
  return `${Math.ceil(inSeconds / 60)} min`;
}

/**
 * Which stop is at the top of the window at time `t`. A list that fits does
 * not move; a longer one steps up one line every `PIDS_SCROLL_S` and wraps.
 */
export function scrollOffset(t: number, count: number, visible = PIDS_STOP_LINES, period = PIDS_SCROLL_S): number {
  if (count <= visible) return 0;
  const step = Math.floor(t / period);
  return ((step % count) + count) % count;
}

/** The nearest station with a site inside `PIDS_RANGE_M`, or null. */
export function nearestSite(stations: readonly RailStation[], x: number, z: number, range = PIDS_RANGE_M): RailStation | null {
  let best: RailStation | null = null;
  let bestD2 = range * range;
  for (const st of stations) {
    if (!Number.isFinite(st.siteX) || !Number.isFinite(st.siteZ)) continue;
    const dx = st.siteX - x;
    const dz = st.siteZ - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = st;
    }
  }
  return best;
}

/**
 * The board's yaw about +y, so its front faces the player.
 *
 * A `PlaneGeometry` faces +z. The board's normal is the platform's own
 * heading, or its reverse, whichever has the player in front of it; the yaw
 * that turns +z onto a unit `(nx, nz)` is `atan2(nx, nz)`.
 */
export function boardYaw(dx: number, dz: number, toPlayerX: number, toPlayerZ: number): number {
  const sign = dx * toPlayerX + dz * toPlayerZ >= 0 ? 1 : -1;
  return Math.atan2(dx * sign, dz * sign);
}

const CREAM = '#e9e4d6';
const BEZEL = '#161616';
const SCREEN = '#f4f4f2';
const INK = '#1a1a1a';
const MUTED = '#5a5a5a';
const CHIP = '#2b2b2b';

export class Pids {
  readonly mesh: Mesh;
  /** The station the board is hung over, for the frame line and the check. */
  station: string | null = null;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly texture: CanvasTexture | null;
  private lastDraw = -Infinity;

  constructor(private readonly bake: RailBake, private readonly clock: () => string) {
    const material = new MeshBasicNodeMaterial();
    material.name = 'pids_board';
    material.side = FrontSide;
    material.fog = false;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = PIDS_PX_W;
      canvas.height = PIDS_PX_H;
      this.canvas = canvas;
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = 4;
      this.texture = texture;
      material.map = texture;
    } else {
      this.canvas = null;
      this.texture = null;
    }
    const mesh = new Mesh(new PlaneGeometry(PIDS_W_M, PIDS_H_M), material);
    mesh.name = 'pids_board';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noShadow = true;
    mesh.visible = false;
    this.mesh = mesh;
  }

  /** Once a frame. `t` is rail seconds; `now` is wall seconds for the scroll and redraw clocks. */
  update(x: number, z: number, t: number, now: number): void {
    const st = nearestSite(this.bake.stations, x, z);
    if (st === null) {
      this.station = null;
      this.mesh.visible = false;
      return;
    }
    this.station = st.name;
    const m = this.mesh;
    m.position.set(st.siteX, st.siteY + PLATFORM_TOP_M + PIDS_HEIGHT_M, st.siteZ);
    m.rotation.set(0, boardYaw(st.siteDx, st.siteDz, x - st.siteX, z - st.siteZ), 0);
    m.visible = true;
    if (now - this.lastDraw < PIDS_REDRAW_S) return;
    this.lastDraw = now;
    this.draw(st.name, t, now);
  }

  private draw(station: string, t: number, now: number): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const W = PIDS_PX_W;
    const H = PIDS_PX_H;
    const rows = boardRows(this.bake, station, t);

    // The housing, the bezel, two screens.
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = BEZEL;
    ctx.fillRect(28, 28, W - 56, H - 56);
    const gap = 16;
    const sw = (W - 56 - 24 - gap) / 2;
    const sh = H - 56 - 24;
    const lx = 28 + 12;
    const rx = lx + sw + gap;
    const sy = 28 + 12;
    ctx.fillStyle = SCREEN;
    ctx.fillRect(lx, sy, sw, sh);
    ctx.fillRect(rx, sy, sw, sh);

    const badge = (bx: number, by: number, size: number, row: BoardRow): void => {
      ctx.fillStyle = `#${row.colour.toString(16).padStart(6, '0')}`;
      const r = size * 0.18;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + size, by, bx + size, by + size, r);
      ctx.arcTo(bx + size, by + size, bx, by + size, r);
      ctx.arcTo(bx, by + size, bx, by, r);
      ctx.arcTo(bx, by, bx + size, by, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(size * 0.58)}px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.id, bx + size / 2, by + size / 2 + 1);
    };
    const chip = (cx: number, cy: number, text: string): number => {
      ctx.font = '600 15px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
      const w = ctx.measureText(text).width + 18;
      ctx.fillStyle = CHIP;
      ctx.fillRect(cx, cy, w, 22);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx + 9, cy + 12);
      return w;
    };
    const font = (weight: number, px: number): void => {
      ctx.font = `${weight} ${px}px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
    };

    // --- Left screen: the clock, and the two services after the next.
    ctx.fillStyle = MUTED;
    font(500, 20);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Following services', lx + 16, sy + 12);
    ctx.textAlign = 'right';
    ctx.fillText(this.clock(), lx + sw - 16, sy + 12);
    const following = rows.slice(1, 3);
    for (let i = 0; i < 2; i++) {
      const ry = sy + 44 + i * 130;
      const row = following[i];
      if (row === undefined) continue;
      badge(lx + 16, ry + 6, 40, row);
      ctx.fillStyle = INK;
      font(700, 34);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(row.towards, lx + 68, ry, sw - 200);
      let cx = lx + 68;
      cx += chip(cx, ry + 48, row.metro ? '6 cars' : '8 cars') + 8;
      chip(cx, ry + 48, row.stops.length <= 6 ? 'Limited Stops' : 'All Stops');
      ctx.fillStyle = MUTED;
      font(500, 16);
      ctx.textAlign = 'right';
      ctx.fillText('Departs', lx + sw - 16, ry + 2);
      ctx.fillStyle = INK;
      font(700, 30);
      ctx.fillText(departsText(row.inSeconds), lx + sw - 16, ry + 22);
      if (i === 0) {
        ctx.fillStyle = '#d8d8d4';
        ctx.fillRect(lx + 16, ry + 112, sw - 32, 2);
      }
    }

    // --- Right screen: the next service and where it stops.
    ctx.fillStyle = MUTED;
    font(500, 20);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Next service', rx + 16, sy + 12);
    const next = rows[0];
    if (next === undefined) {
      ctx.fillStyle = INK;
      font(600, 28);
      ctx.fillText('No services', rx + 16, sy + 60);
    } else {
      badge(rx + 16, sy + 46, 48, next);
      ctx.fillStyle = INK;
      font(700, 40);
      ctx.fillText(next.towards, rx + 76, sy + 44, sw - 220);
      ctx.fillStyle = MUTED;
      font(500, 16);
      ctx.textAlign = 'right';
      ctx.fillText('Departs', rx + sw - 16, sy + 44);
      ctx.fillStyle = INK;
      font(700, 34);
      ctx.fillText(departsText(next.inSeconds), rx + sw - 16, sy + 64);
      let cx = rx + sw - 16 - 180;
      cx += chip(cx, sy + 108, next.metro ? '6 cars' : '8 cars') + 8;
      chip(cx, sy + 108, next.stops.length <= 6 ? 'Limited Stops' : 'All Stops');
      // The stopping pattern, one line stepping up every PIDS_SCROLL_S.
      const stops = next.stops;
      const top = scrollOffset(now, stops.length);
      ctx.fillStyle = INK;
      font(500, 26);
      ctx.textAlign = 'left';
      const listY = sy + 104;
      const lineH = 32;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx + 12, listY, sw - 220, PIDS_STOP_LINES * lineH + 4);
      ctx.clip();
      for (let i = 0; i < Math.min(PIDS_STOP_LINES, stops.length); i++) {
        const name = stops[(top + i) % stops.length];
        ctx.fillText(name, rx + 16, listY + i * lineH, sw - 230);
      }
      ctx.restore();
    }

    if (this.texture !== null) this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
    this.mesh.geometry.dispose();
  }
}

export function verifyPids(): string[] {
  const failures: string[] = [];
  // A fixture: one line, two directions, three calling stops and one the train runs through.
  const stops = (names: string[], skip: string) => names.map((name, i) => ({ name, s: i * 1000, calls: name !== skip }));
  const dir = (index: number, names: string[]) => ({
    index, label: `${names[0]} -> ${names[names.length - 1]}`, offset: 0, duration: 400, lengthM: 4000,
    vertexOff: 0, vertexCount: 0, phaseOff: 0, phaseCount: 0, minX: 0, maxX: 0, minZ: 0, maxZ: 0,
    stops: stops(names, 'Erskineville'), arrivals: [0, 100, 200, 300], blocks: [], line: 0,
  });
  const line = { id: 'T8', name: 'Airport & South', colour: 0x00954c, metro: false, period: 120,
    dirs: [dir(0, ['Macarthur', 'Wolli Creek', 'Erskineville', 'Green Square', 'Central']),
           dir(1, ['Central', 'Green Square', 'Erskineville', 'Wolli Creek', 'Macarthur'])] };
  const bake = { lines: [line], stations: [] } as unknown as RailBake;

  // --- Stops after: calling stops only, in order, none for a station not on the line.
  {
    const after = stopsAfter(line.dirs[0] as unknown as RailDirection, 'Wolli Creek');
    if (after.join(',') !== 'Green Square,Central') failures.push(`stops after Wolli Creek read [${after.join(', ')}]; Erskineville does not call.`);
    if (stopsAfter(line.dirs[0] as unknown as RailDirection, 'Central').length !== 0) failures.push('the terminus has stops after it.');
    if (stopsAfter(line.dirs[0] as unknown as RailDirection, 'Bondi').length !== 0) failures.push('a station off the line has stops after it.');
  }

  // --- Rows: soonest first, towards the terminus, with its own stops.
  {
    const rows = boardRows(bake, 'Green Square', 0);
    // Two directions, two services each in the window: three rows fill the board.
    if (rows.length !== 3) failures.push(`${rows.length} rows on a two-direction station; the board holds three.`);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].inSeconds < rows[i - 1].inSeconds) failures.push('rows are not in arrival order.');
    }
    const toCentral = rows.find((r) => r.towards === 'Central');
    if (toCentral === undefined) failures.push('no row towards Central.');
    else if (toCentral.stops.join(',') !== 'Central') failures.push(`the Central row stops at [${toCentral.stops.join(', ')}].`);
    if (rows.some((r) => r.id !== 'T8' || r.colour !== 0x00954c)) failures.push('a row lost its line badge.');
    if (boardRows(bake, 'Bondi', 0).length !== 0) failures.push('a station on no line has rows.');
  }

  // --- Departs text and the scroll.
  {
    if (departsText(10) !== 'Now') failures.push(`10 s away reads "${departsText(10)}".`);
    if (departsText(PIDS_NOW_S) !== '1 min') failures.push(`${PIDS_NOW_S} s away reads "${departsText(PIDS_NOW_S)}".`);
    if (departsText(200) !== '4 min') failures.push(`200 s away reads "${departsText(200)}"; the board rounds up.`);
    if (scrollOffset(1000, 4) !== 0) failures.push('a list that fits scrolls.');
    const a = scrollOffset(0, 10);
    const b = scrollOffset(PIDS_SCROLL_S, 10);
    if (a !== 0 || b !== 1) failures.push(`the scroll steps ${a} then ${b}; one line a period was expected.`);
    if (scrollOffset(PIDS_SCROLL_S * 10, 10) !== 0) failures.push('the scroll does not wrap.');
    if (scrollOffset(PIDS_SCROLL_S * 23.5, 10) !== 3) failures.push('the scroll drifted off its period.');
  }

  // --- Nearest site, and the face turning to the player.
  {
    const st = (name: string, x: number, z: number) => ({ name, siteX: x, siteZ: z, siteY: 0, siteDx: 1, siteDz: 0 }) as unknown as RailStation;
    const stations = [st('A', 0, 0), st('B', 300, 0), st('C', Number.NaN, 0)];
    if (nearestSite(stations, 40, 10)?.name !== 'A') failures.push('the nearest site is not A.');
    if (nearestSite(stations, 250, 0)?.name !== 'B') failures.push('the nearest site is not B.');
    if (nearestSite(stations, 150, 0) !== null) failures.push('a player 150 m from both sites got a board.');
    const front = boardYaw(1, 0, 10, 0);
    const back = boardYaw(1, 0, -10, 0);
    if (Math.abs(front - Math.PI / 2) > 1e-6) failures.push(`a player ahead along +x gets yaw ${front.toFixed(3)}; pi/2 turns +z onto +x.`);
    if (Math.abs(Math.abs(back) - Math.PI / 2) > 1e-6 || Math.sign(back) === Math.sign(front)) {
      failures.push(`a player behind gets yaw ${back.toFixed(3)}; the face should turn round.`);
    }
  }

  // --- The class builds without a document, and hides with no station near.
  {
    const board = new Pids(bake, () => '15:23');
    board.update(5000, 5000, 0, 0);
    if (board.mesh.visible) failures.push('a board with no station in range is visible.');
    if (board.station !== null) failures.push('a board with no station in range names one.');
    board.dispose();
  }
  return failures;
}
