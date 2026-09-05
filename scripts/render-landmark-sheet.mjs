#!/usr/bin/env node
/**
 * The landmark sheet: every hero landmark, as the game draws it, for eyes.
 *
 * `pipeline/sydney/landmarks.py` generates the Harbour Bridge, the Opera House,
 * Sydney Tower and Luna Park from published dimensions and OSM outlines, and
 * every one of those is a thing a number cannot check and a look can. The
 * audits in `index.json` say the spire is 309 m up; they cannot say the
 * turret is upside down, that the shells face the wrong way, or that a pylon
 * is floating a metre over its skewback. The owner's words were *"make tests
 * where you physically look at those so we have a framework for inconsistent
 * generations like this"* -- this is that framework, and it is
 * `scripts/render-car-sheet.mjs`'s method applied to the landmark file: a
 * scanline rasteriser over the GLB's own triangles, no browser, no GPU, so it
 * runs in a handoff and in CI.
 *
 * Each landmark gets a row of four cells: three-quarter from the south-east,
 * the south elevation, the east elevation, and the plan from above. The cell
 * is scaled to the landmark's own extent, and a bar in the corner says how
 * many metres that is, because the same cell holds a 1.1 km bridge and a 45 m
 * amusement-park face. Materials take the game's own tones from
 * `world/landmarks.ts`, so gold reads as gold and the shells read as white.
 *
 * Writes `data/landmarks/landmark-sheet.png`; the row order is printed.
 *
 *   node scripts/render-landmark-sheet.mjs [--glb path] [--out path] [--only a,b] [--px 640]
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const GLB = arg('--glb', path.join(ROOT, 'client/public/world/landmarks.glb'));
const OUT = arg('--out', path.join(ROOT, 'data/landmarks/landmark-sheet.png'));
const ONLY = args.includes('--only') ? new Set(arg('--only', '').split(',')) : null;
const W = Number(arg('--px', '640')), H = Math.round(W * 0.625);
/**
 * `--band y0,y1`: fit the cells to this slice of height (the GLB's own y,
 * metres) rather than to the whole landmark, so a 31 m turret on a 309 m tower
 * can be judged at more than fifty pixels. The plan view ignores it.
 */
const BAND = args.includes('--band') ? arg('--band', '').split(',').map(Number) : null;

/** The game's own tones, `world/landmarks.ts`. Linear, before the sheet's gamma. */
const TONES = {
  landmark_steel: [0.223, 0.229, 0.222],
  landmark_granite: [0.365, 0.331, 0.290],
  landmark_shell: [0.82, 0.80, 0.76],
  landmark_glass: [0.08, 0.085, 0.095],
  landmark_gold: [0.700, 0.478, 0.150],
  landmark_asphalt: [0.052, 0.055, 0.058],
  landmark_paint_red: [0.62, 0.08, 0.06],
  landmark_paint_yellow: [0.85, 0.62, 0.08],
  landmark_paint_blue: [0.08, 0.18, 0.55],
};
const UNKNOWN = [0.9, 0.1, 0.9];

/**
 * The views. `cam` is where the eye is relative to the landmark's centre, in
 * the GLB's frame (x east, y up, z south); the projection is orthographic, so
 * only the direction matters. The plan view has to name its own up vector,
 * because "up" on a plan is north and the cross product with (0,1,0) is zero.
 */
const VIEWS = [
  { name: 'three-quarter', cam: [1, 0.6, 1] },
  { name: 'south elevation', cam: [0, 0.08, 1] },
  { name: 'east elevation', cam: [1, 0.08, 0] },
  { name: 'plan', cam: [0, 1, 0.0001], up: [0, 0, -1] },
];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(GLB);
const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh() && (ONLY === null || ONLY.has(n.getName())));
const sheetW = VIEWS.length * W, sheetH = nodes.length * H;
const sheet = Buffer.alloc(sheetW * sheetH * 3, 40);

/** A 3x5 digit font for the scale bar, so the sheet needs no text library. */
const DIGITS = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], 'm': ['000', '000', '110', '111', '101'], ' ': ['000', '000', '000', '000', '000'],
};
function stamp(img, x0, y0, text, scale = 2) {
  let x = x0;
  for (const ch of text) {
    const g = DIGITS[ch] ?? DIGITS[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === '1') {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = x + c * scale + dx, py = y0 + r * scale + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const o = (py * W + px) * 3; img[o] = 1; img[o + 1] = 1; img[o + 2] = 1;
      }
    }
    x += 4 * scale;
  }
}

let row = 0;
for (const node of nodes) {
  const mesh = node.getMesh();
  const m = node.getWorldMatrix();
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const tris = [];
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const mats = new Map();
  for (const p of mesh.listPrimitives()) {
    const name = p.getMaterial()?.getName() ?? '';
    const tone = TONES[name] ?? UNKNOWN;
    const pos = p.getAttribute('POSITION'), idx = p.getIndices();
    const n = pos.getCount();
    const w = new Array(n);
    const v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, v);
      const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      w[i] = [x, y, z];
      bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.min(bb[2], z);
      bb[3] = Math.max(bb[3], x); bb[4] = Math.max(bb[4], y); bb[5] = Math.max(bb[5], z);
    }
    const cnt = idx ? idx.getCount() : n;
    mats.set(name, (mats.get(name) ?? 0) + cnt / 3);
    for (let k = 0; k < cnt; k += 3) {
      let ia = idx ? idx.getScalar(k) : k, ib = idx ? idx.getScalar(k + 1) : k + 1, ic = idx ? idx.getScalar(k + 2) : k + 2;
      if (det < 0) { const s = ib; ib = ic; ic = s; }
      tris.push({ a: w[ia], b: w[ib], c: w[ic], col: tone });
    }
  }
  const fit = BAND ? [bb[0], Math.max(bb[1], BAND[0]), bb[2], bb[3], Math.min(bb[4], BAND[1]), bb[5]] : bb;
  const cx = (fit[0] + fit[3]) / 2, cy = (fit[1] + fit[4]) / 2, cz = (fit[2] + fit[5]) / 2;
  const size = [fit[3] - fit[0], fit[4] - fit[1], fit[5] - fit[2]];

  for (let vi = 0; vi < VIEWS.length; vi++) {
    const { cam, up: upHint } = VIEWS[vi];
    const cl = Math.hypot(...cam);
    const fwd = cam.map((q) => -q / cl);
    const hint = upHint ?? [0, 1, 0];
    let right = [fwd[1] * hint[2] - fwd[2] * hint[1], fwd[2] * hint[0] - fwd[0] * hint[2], fwd[0] * hint[1] - fwd[1] * hint[0]];
    const rl = Math.hypot(...right) || 1;
    right = right.map((q) => q / rl);
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    // Fit the projected box, not the longest axis: a bridge seen end-on is
    // 49 m wide and 134 m tall and would otherwise be a sliver in a cell
    // scaled to its 1.1 km length.
    let ex = 0, ey = 0;
    if (BAND && upHint === undefined) {
      // Measure the band's own footprint from the triangles inside it.
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (const tr of tris) for (const p of [tr.a, tr.b, tr.c]) if (p[1] >= BAND[0] && p[1] <= BAND[1]) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[2]); bz1 = Math.max(bz1, p[2]); }
      if (bx0 < bx1) { size[0] = bx1 - bx0; size[2] = bz1 - bz0; }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * size[0] / 2, y = sy * size[1] / 2, z = sz * size[2] / 2;
      ex = Math.max(ex, Math.abs(x * right[0] + y * right[1] + z * right[2]));
      ey = Math.max(ey, Math.abs(x * up[0] + y * up[1] + z * up[2]));
    }
    const scale = Math.min((W * 0.92) / (2 * ex || 1), (H * 0.86) / (2 * ey || 1));
    const proj = (p) => { const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz; return [W / 2 + (x * right[0] + y * right[1] + z * right[2]) * scale, H / 2 - (x * up[0] + y * up[1] + z * up[2]) * scale, x * fwd[0] + y * fwd[1] + z * fwd[2]]; };
    const zb = new Float32Array(W * H).fill(Infinity);
    const img = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { img[i * 3] = 0.16; img[i * 3 + 1] = 0.17; img[i * 3 + 2] = 0.19; }
    // A ground line at the landmark's lowest point, so a floating base shows.
    const groundY = H / 2 - ((bb[1] - cy) * up[1] + 0) * scale;
    if (up[1] !== 0) for (let x = 0; x < W; x++) { const y = Math.round(groundY); if (y >= 0 && y < H) { const o = (y * W + x) * 3; img[o] = 0.3; img[o + 1] = 0.32; img[o + 2] = 0.26; } }
    const light = [0.4, 0.8, 0.45];
    const ll = Math.hypot(...light);
    light[0] /= ll; light[1] /= ll; light[2] /= ll;
    for (const tr of tris) {
      const A = proj(tr.a), B = proj(tr.b), C = proj(tr.c);
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (area === 0) continue;
      const e1 = [tr.b[0] - tr.a[0], tr.b[1] - tr.a[1], tr.b[2] - tr.a[2]], e2 = [tr.c[0] - tr.a[0], tr.c[1] - tr.a[1], tr.c[2] - tr.a[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      // Two-sided on purpose: the sheet is for catching a flipped face, and a
      // culled flipped face is a hole that reads as "nothing there".
      const lam = 0.3 + 0.7 * Math.abs((nx * light[0] + ny * light[1] + nz * light[2]) / nl);
      const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
          const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
          const o = y * W + x;
          if (z >= zb[o]) continue;
          zb[o] = z;
          img[o * 3] = tr.col[0] * lam; img[o * 3 + 1] = tr.col[1] * lam; img[o * 3 + 2] = tr.col[2] * lam;
        }
      }
    }
    // The scale bar: a round number of metres that fits a quarter of the cell.
    const want = (W / 4) / scale;
    const bar = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].reduce((best, q) => (q <= want ? q : best), 1);
    const bx = 12, by = H - 14;
    for (let x = bx; x < bx + bar * scale; x++) for (let y = by; y < by + 3; y++) { const o = (y * W + x) * 3; img[o] = 1; img[o + 1] = 1; img[o + 2] = 1; }
    stamp(img, bx, by - 14, `${bar}m`);
    const ox = vi * W, oy = row * H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 3, d = ((oy + y) * sheetW + ox + x) * 3;
      sheet[d] = Math.min(255, Math.sqrt(Math.max(0, img[s])) * 255);
      sheet[d + 1] = Math.min(255, Math.sqrt(Math.max(0, img[s + 1])) * 255);
      sheet[d + 2] = Math.min(255, Math.sqrt(Math.max(0, img[s + 2])) * 255);
    }
  }
  const matText = [...mats].map(([k, v]) => `${k.replace('landmark_', '')}:${v}`).join(' ');
  const unknown = [...mats.keys()].filter((k) => !(k in TONES));
  console.log(`${row}  ${node.getName().padEnd(16)} ${tris.length} tris  ${size.map((q) => q.toFixed(0)).join(' x ')} m  y ${bb[1].toFixed(1)}..${bb[4].toFixed(1)}  ${matText}${unknown.length ? `  UNKNOWN MATERIAL ${unknown.join(',')}` : ''}`);
  row++;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await sharp(sheet, { raw: { width: sheetW, height: sheetH, channels: 3 } }).png().toFile(OUT);
console.log(`wrote ${OUT} (${sheetW} x ${sheetH}); rows top to bottom as listed; cells: ${VIEWS.map((v) => v.name).join(' | ')}`);
