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
 * ---------------------------------------------------------------------------
 * THE SAMPLER, AND THE LIE THIS SHEET USED TO TELL.
 *
 * Until 2026-09 this file had no texture sampler in it. It read the atlas
 * **once per vertex**, averaged a triangle's three corners into one colour and
 * flat-filled the triangle with it -- and every essay written against that
 * behaviour was an essay about the sheet rather than about a car. Two of them
 * were expensive:
 *
 *   - `scripts/build-police-car.mjs` subdivided its shell from 800 triangles to
 *     2,700 and cut extra rings either side of every Battenburg column boundary,
 *     purely so a chequer cell would be bigger than a triangle. It still could
 *     not work. A cell is 0.39 x 0.13 m and the letters of "POLICE" have a
 *     4 cm stroke; no tessellation a 5 m car can afford resolves a 4 cm stroke,
 *     so the livery this project authored a whole script to paint came out as
 *     pale blue smears and the word came out as nothing.
 *   - `toyota_hiace_2020.glb` is a photo-textured van -- headlamps, grille,
 *     wheel arches, glass, all in its map -- drawn here as a featureless block,
 *     because a vertex sits on a UV island's *edge* and a van has 1,132 of
 *     them. The model was blamed for years of being "a slab". It is not.
 *
 * So the rasteriser now interpolates UV (and the `_PAINT` mask) across the
 * triangle with the barycentric weights it was already computing for the depth
 * test, and samples the atlas per fragment -- which is what the shader in
 * `carlod.materialFor` does, one texture fetch inside `Fn`. The projection here
 * is orthographic, so affine interpolation of UV is exact and no perspective
 * divide is owed. It costs one texel fetch per covered pixel and it is the
 * difference between a picture of the cars and a picture of their triangles.
 *
 *   node scripts/render-car-sheet.mjs [--out path] [--only a.glb,b.glb] [--px N]
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
/**
 * `--px N`: how wide one view is, in pixels. 320 is the whole-fleet sheet, where
 * what is being judged is the silhouette, the nose direction and the paint; a
 * livery is judged at 1200, on one car, with `--only`.
 *
 * It scales the cell rather than the sheet, so the geometry the rasteriser walks
 * is unchanged and only the sampling gets finer -- which is the point: reading
 * "POLICE" off a door needs pixels on the door, not a bigger PNG of the same
 * twelve.
 */
const pxArg = args.indexOf('--px');
const CELL_W = pxArg >= 0 ? Math.max(64, Math.round(Number(args[pxArg + 1]))) : 320;

const W = CELL_W, H = Math.round(CELL_W * 190 / 320);
/** Four cars a row on the fleet sheet; fewer when `--only` asked for fewer, so a one-car sheet is one car wide and not a quarter of a picture. */
let COLS = 4;
/** The paint every painted surface takes on the sheet: a mid blue, so a painted headlight is obvious. */
const PAINT = [0.18, 0.36, 0.78];
const VIEWS = [{ cam: [1, 0.55, 0.75] }, { cam: [-1, 0.55, 0.75] }];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

/*
 * --- The manifest against the directory, before a pixel is drawn.
 *
 * The sheet reads the *directory*, because what it is for is looking at what
 * ships. The game reads the *manifest*, and the two are only the same list
 * while somebody keeps them so. Both ways round are faults and neither shows
 * up in a picture:
 *
 *   - a manifest row whose `.glb` is gone is a hole in a body class's pool --
 *     `carlod` keeps the slot, so the modulus is right and the cars that hash
 *     to it silently draw as boxes forever;
 *   - a `.glb` the manifest does not name is a file nobody drew, downloaded by
 *     nobody, sitting in the build.
 *
 * This is the only place both lists exist outside the browser, so it is where
 * they are compared. A missing file is fatal; a stray one is a warning,
 * because dropping a new model in before writing its row is how the manifest
 * gets written.
 */
{
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const onDisk = new Set(fs.readdirSync(DIR).filter((f) => f.endsWith('.glb')));
  const named = new Set(manifest.map((e) => e.file));
  const missing = manifest.filter((e) => !onDisk.has(e.file)).map((e) => e.file);
  const stray = [...onDisk].filter((f) => !named.has(f));
  const unlabelled = manifest.filter((e) => typeof e.label !== 'string' || e.label.trim() === '').map((e) => e.file);
  if (missing.length > 0) {
    console.error(`manifest.json names ${missing.length} file(s) that are not on disk: ${missing.join(', ')}`);
    console.error('Every one is a hole in its body class\'s pool: the cars that hash to it draw as boxes.');
    process.exit(1);
  }
  if (unlabelled.length > 0) {
    console.error(`manifest.json has no label for: ${unlabelled.join(', ')}. Getting into one would say nothing.`);
    process.exit(1);
  }
  if (stray.length > 0) console.warn(`not in manifest.json (never drawn, never fetched): ${stray.join(', ')}`);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb') && (ONLY === null || ONLY.has(f))).sort();
COLS = Math.min(COLS, Math.max(1, files.length));
const rows = Math.ceil(files.length / COLS);
const sheetW = COLS * W * 2, sheetH = rows * H;
const sheet = Buffer.alloc(sheetW * sheetH * 3, 40);

/**
 * sRGB byte to linear, as a 256-entry table.
 *
 * A glTF base colour texture is sRGB-encoded and three decodes it on the way
 * into the shader; every other input here (the base colour factor, `COLOR_0`)
 * is already linear, and the write-out at the bottom of this file encodes back
 * with a `sqrt`. Reading the byte as if it were linear -- which is what this did
 * until 2026-09 -- therefore brightened every texel by its own square root, and
 * the effect is worst on the saturated mid-tones: `nsw_police.glb`'s navy
 * chequer came out a pale cornflower and nobody could tell whether the fault was
 * in the palette, in `world/cars.LIVERY_CHEQUER_BLUE` or in the picture.
 */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

async function texelsOf(mat) {
  const tex = mat?.getBaseColorTexture();
  if (!tex || !tex.getImage()) return null;
  const { data, info } = await sharp(Buffer.from(tex.getImage())).raw().removeAlpha().toBuffer({ resolveWithObject: true });
  const linear = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) linear[i] = SRGB_TO_LINEAR[data[i]];
  return { data: linear, w: info.width, h: info.height };
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
      // Per vertex: world position, the *untextured* colour (base factor times
      // any `COLOR_0`), the atlas coordinate and the paint mask. The texel is
      // deliberately not folded in here -- it is fetched per fragment below,
      // which is the whole of what this rasteriser learned in 2026-09.
      const w = new Array(n), col = new Array(n), tc = new Array(n), pm = new Float32Array(n);
      const v = [0, 0, 0], t = [0, 0], c = [1, 1, 1];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        w[i] = [x, y, z];
        bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.min(bb[2], z), Math.max(bb[3], x), Math.max(bb[4], y), Math.max(bb[5], z)];
        let r = base[0], g = base[1], b = base[2];
        if (col0) { col0.getElement(i, c); r *= c[0]; g *= c[1]; b *= c[2]; }
        col[i] = [r, g, b];
        if (tx && uv) { uv.getElement(i, t); tc[i] = [t[0], t[1]]; } else tc[i] = null;
        pm[i] = paint ? paint.getScalar(i) : 1;
      }
      const cnt = idx ? idx.getCount() : n;
      for (let k = 0; k < cnt; k += 3) {
        let ia = idx ? idx.getScalar(k) : k, ib = idx ? idx.getScalar(k + 1) : k + 1, ic = idx ? idx.getScalar(k + 2) : k + 2;
        if (det < 0) { const s = ib; ib = ic; ic = s; }
        tris.push({
          a: w[ia], b: w[ib], c: w[ic],
          ca: col[ia], cb: col[ib], cc: col[ic],
          ta: tc[ia], tb: tc[ib], tc: tc[ic],
          pa: pm[ia], pb: pm[ib], pc: pm[ic],
          tex: tx,
        });
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
          // --- The fragment. `w0/w1/w2` weight A/B/C; the projection is
          // orthographic, so these are the true surface barycentrics and no
          // perspective divide is owed.
          let r = w0 * tr.ca[0] + w1 * tr.cb[0] + w2 * tr.cc[0];
          let g = w0 * tr.ca[1] + w1 * tr.cb[1] + w2 * tr.cc[1];
          let b = w0 * tr.ca[2] + w1 * tr.cb[2] + w2 * tr.cc[2];
          if (tr.tex && tr.ta && tr.tb && tr.tc) {
            const tu = w0 * tr.ta[0] + w1 * tr.tb[0] + w2 * tr.tc[0];
            const tv = w0 * tr.ta[1] + w1 * tr.tb[1] + w2 * tr.tc[1];
            const tex = tr.tex;
            const sx = ((Math.floor(tu * tex.w) % tex.w) + tex.w) % tex.w;
            const sy = ((Math.floor(tv * tex.h) % tex.h) + tex.h) % tex.h;
            const to = (sy * tex.w + sx) * 3;
            r *= tex.data[to]; g *= tex.data[to + 1]; b *= tex.data[to + 2];
          }
          const mask = w0 * tr.pa + w1 * tr.pb + w2 * tr.pc;
          if (MASK) {
            const on = mask > 0.5;
            img[o * 3] = (on ? 0.9 : 0.85) * lam;
            img[o * 3 + 1] = (on ? 0.9 : 0.15) * lam;
            img[o * 3 + 2] = (on ? 0.9 : 0.1) * lam;
            continue;
          }
          // `carlod`'s rule: value under the paint's hue where the mask is on.
          const value = Math.max(r, g, b);
          img[o * 3] = (r + (PAINT[0] * value - r) * mask) * lam;
          img[o * 3 + 1] = (g + (PAINT[1] * value - g) * mask) * lam;
          img[o * 3 + 2] = (b + (PAINT[2] * value - b) * mask) * lam;
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
