#!/usr/bin/env node
/**
 * The contact sheet: every shipped car, as the game draws it, for eyes.
 *
 * `scripts/prep-car-models.mjs` decides which way a car faces, what its paint
 * lands on and how its maps are packed, and every one of those is a thing a
 * number cannot check and a screenshot can -- which is why the 2026-09 round
 * shipped a bus, a garbage truck and a sedan driving backwards for a day: the
 * loader's yaw table and the prep's own turn disagreed, and nothing looked.
 * This renders each `client/public/cars/*.glb` twice, from off its +X end
 * (the nose, if the prep is right) and off its -X end, with the same rules
 * `world/carlod.ts` applies: the atlas texel times the vertex colour, the
 * painted surfaces (`_PAINT` = 1) taking a fixed paint as value under hue,
 * back faces drawn (the fleet material is two-sided). No browser, no GPU: a
 * scanline rasteriser over the glb's own triangles, so it runs in CI and in a
 * handoff. Writes `data/vehicles/car-sheet.png`; the cell order is printed.
 *
 *   node scripts/render-car-sheet.mjs [--out path] [--only a.glb,b.glb]
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'client/public/cars');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? args[outArg + 1] : path.join(ROOT, 'data/vehicles/car-sheet.png');
const onlyArg = args.indexOf('--only');
const ONLY = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(',')) : null;
/** `--mask`: draw the paint mask instead -- white where the paint lands, red where the authored colour stays. */
const MASK = args.includes('--mask');

const W = 320, H = 190, COLS = 4;
/** The paint every painted surface takes on the sheet: a mid blue, so a painted headlight is obvious. */
const PAINT = [0.18, 0.36, 0.78];
const VIEWS = [{ cam: [1, 0.55, 0.75] }, { cam: [-1, 0.55, 0.75] }];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb') && (ONLY === null || ONLY.has(f))).sort();
const rows = Math.ceil(files.length / COLS);
const sheetW = COLS * W * 2, sheetH = rows * H;
const sheet = Buffer.alloc(sheetW * sheetH * 3, 40);

async function texelsOf(mat) {
  const tex = mat?.getBaseColorTexture();
  if (!tex || !tex.getImage()) return null;
  const { data, info } = await sharp(Buffer.from(tex.getImage())).raw().removeAlpha().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

let cell = 0;
for (const f of files) {
  const doc = await io.read(path.join(DIR, f));
  const root = doc.getRoot();
  const tris = [];
  let bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const texCache = new Map();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    for (const p of mesh.listPrimitives()) {
      const mat = p.getMaterial();
      if (!texCache.has(mat)) texCache.set(mat, await texelsOf(mat));
      const tx = texCache.get(mat);
      const base = mat ? mat.getBaseColorFactor() : [1, 1, 1, 1];
      const pos = p.getAttribute('POSITION'), uv = p.getAttribute('TEXCOORD_0'), idx = p.getIndices();
      const col0 = p.getAttribute('COLOR_0'), paint = p.getAttribute('_PAINT');
      const n = pos.getCount();
      const w = new Array(n), col = new Array(n);
      const v = [0, 0, 0], t = [0, 0], c = [1, 1, 1];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        w[i] = [x, y, z];
        bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.min(bb[2], z), Math.max(bb[3], x), Math.max(bb[4], y), Math.max(bb[5], z)];
        let r = base[0], g = base[1], b = base[2];
        if (col0) { col0.getElement(i, c); r *= c[0]; g *= c[1]; b *= c[2]; }
        if (tx && uv) {
          uv.getElement(i, t);
          const px = ((Math.floor(t[0] * tx.w) % tx.w) + tx.w) % tx.w, py = ((Math.floor(t[1] * tx.h) % tx.h) + tx.h) % tx.h;
          const o = (py * tx.w + px) * 3;
          r *= tx.data[o] / 255; g *= tx.data[o + 1] / 255; b *= tx.data[o + 2] / 255;
        }
        const mask = paint ? paint.getScalar(i) : 1;
        // `carlod`'s rule: value under the paint's hue where the mask is on.
        const value = Math.max(r, g, b);
        col[i] = MASK
          ? (mask > 0.5 ? [0.9, 0.9, 0.9] : [0.85, 0.15, 0.1])
          : [r + (PAINT[0] * value - r) * mask, g + (PAINT[1] * value - g) * mask, b + (PAINT[2] * value - b) * mask];
      }
      const cnt = idx ? idx.getCount() : n;
      for (let k = 0; k < cnt; k += 3) {
        let ia = idx ? idx.getScalar(k) : k, ib = idx ? idx.getScalar(k + 1) : k + 1, ic = idx ? idx.getScalar(k + 2) : k + 2;
        if (det < 0) { const s = ib; ib = ic; ic = s; }
        tris.push({ a: w[ia], b: w[ib], c: w[ic], col: [(col[ia][0] + col[ib][0] + col[ic][0]) / 3, (col[ia][1] + col[ib][1] + col[ic][1]) / 3, (col[ia][2] + col[ib][2] + col[ic][2]) / 3] });
      }
    }
  }
  const cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2, cz = (bb[2] + bb[5]) / 2;
  const ext = Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
  for (let vi = 0; vi < VIEWS.length; vi++) {
    const cam = VIEWS[vi].cam;
    const cl = Math.hypot(...cam);
    const fwd = cam.map((q) => -q / cl);
    const right = [fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0];
    const rl = Math.hypot(...right);
    right[0] /= rl; right[1] /= rl; right[2] /= rl;
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const scale = (Math.min(W, H) * 0.9) / ext;
    const proj = (p) => { const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz; return [W / 2 + (x * right[0] + y * right[1] + z * right[2]) * scale, H / 2 - (x * up[0] + y * up[1] + z * up[2]) * scale, x * fwd[0] + y * fwd[1] + z * fwd[2]]; };
    const zb = new Float32Array(W * H).fill(Infinity);
    const img = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { img[i * 3] = 0.16; img[i * 3 + 1] = 0.17; img[i * 3 + 2] = 0.19; }
    const light = [0.4, 0.8, 0.45];
    const ll = Math.hypot(...light);
    light[0] /= ll; light[1] /= ll; light[2] /= ll;
    for (const tr of tris) {
      const A = proj(tr.a), B = proj(tr.b), C = proj(tr.c);
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (area === 0) continue;
      const flipped = area >= 0;
      const e1 = [tr.b[0] - tr.a[0], tr.b[1] - tr.a[1], tr.b[2] - tr.a[2]], e2 = [tr.c[0] - tr.a[0], tr.c[1] - tr.a[1], tr.c[2] - tr.a[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      const sgn = flipped ? -1 : 1;
      const lam = 0.35 + 0.65 * Math.max(0, (sgn * (nx * light[0] + ny * light[1] + nz * light[2])) / nl);
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
          img[o * 3] = tr.col[0] * lam;
          img[o * 3 + 1] = tr.col[1] * lam;
          img[o * 3 + 2] = tr.col[2] * lam;
        }
      }
    }
    const ox = (cell % COLS) * W * 2 + vi * W, oy = Math.floor(cell / COLS) * H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 3, d = ((oy + y) * sheetW + ox + x) * 3;
        sheet[d] = Math.min(255, Math.sqrt(Math.max(0, img[s])) * 255);
        sheet[d + 1] = Math.min(255, Math.sqrt(Math.max(0, img[s + 1])) * 255);
        sheet[d + 2] = Math.min(255, Math.sqrt(Math.max(0, img[s + 2])) * 255);
      }
    }
  }
  console.log(`${String(cell).padStart(2)}  ${f}`);
  cell++;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await sharp(sheet, { raw: { width: sheetW, height: sheetH, channels: 3 } }).png().toFile(OUT);
console.log(`wrote ${OUT} (${sheetW} x ${sheetH}); cells read left to right, top to bottom, +X end then -X end`);
