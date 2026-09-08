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
 *   node scripts/render-car-sheet.mjs [--out path] [--only a.glb,b.glb] [--pbr]
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
 * `--pbr`: put the clearcoat on, so the sky reflection that ships in the game can
 * be looked at without a browser.
 *
 * `client/src/sky/reflection.ts` adds a Fresnel-weighted reflection of an
 * analytic sky to every car, and the thing it does that a number cannot judge is
 * the *silhouette*: how much sky lands on a grazing facet, whether a low-poly
 * flank turns into a mirror, whether the fleet reads as painted or as chrome.
 * That is a picture, and this is the place this project takes pictures.
 *
 * The arithmetic below is the same arithmetic as `sky/reflection.ts` -- see
 * `SHEET_REFERENCE` there for why it exists twice and how the two are kept
 * honest. `assertReflectionMatches` refuses to draw if they have drifted.
 */
const PBR = args.includes('--pbr');

const W = 320, H = 190, COLS = 4;
/** The paint every painted surface takes on the sheet: a mid blue, so a painted headlight is obvious. */
const PAINT = [0.18, 0.36, 0.78];
const VIEWS = [{ cam: [1, 0.55, 0.75] }, { cam: [-1, 0.55, 0.75] }];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

/* ---------------------------------------------------------------------------
 * THE CLEARCOAT, SECOND COPY.
 *
 * Every constant and every line here is `client/src/sky/reflection.ts`, restated
 * because this file is `.mjs` running under a bare `node` in a handoff and that
 * one is TypeScript. `SHEET_REFERENCE` in that file holds the three probes
 * below; if a constant moves there and not here, `verifyReflection` fails in
 * both boot lists *and* this script refuses to draw. Neither copy can be edited
 * alone and get away with it, which is the most a duplication like this can be
 * asked to promise.
 *
 * The environment is the reference instant -- 3 pm on 15 February -- because the
 * sheet has one fixed light and no clock: two runs of it must differ only where
 * a model differs.
 * ------------------------------------------------------------------------- */
const COAT_F0 = 0.03, COAT_MAX = 0.5, COAT_POWER = 5;
const HORIZON_LOW = -0.12, HORIZON_HIGH = 0.3;
const ENV = {
  zenith: [0.680544, 0.99246, 1.4178],
  horizon: [2.236382, 2.520226, 2.907285],
  ground: [0.28356, 0.233937, 0.163047],
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
const coatFresnel = (nDotV) => {
  const c = 1 - (nDotV < 0 ? 0 : nDotV > 1 ? 1 : nDotV);
  return COAT_F0 + (COAT_MAX - COAT_F0) * Math.pow(c, COAT_POWER);
};
const envRadiance = (dirY) => {
  const t = dirY <= 0
    ? smooth01((dirY - HORIZON_LOW) / (0 - HORIZON_LOW))
    : smooth01(dirY / HORIZON_HIGH);
  const [a, b] = dirY <= 0 ? [ENV.ground, ENV.horizon] : [ENV.horizon, ENV.zenith];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
};
/**
 * The sheet is not tone mapped and its whites live at 1.0, while the game's
 * environment is in scene-linear radiance where the horizon band is 2.5. One
 * scalar, set so the horizon lands at the sheet's white: the *shape* of the
 * gradient and the whole of the Fresnel are what this picture is for, and the
 * absolute level is `calibration.ts`'s business and is checked there.
 */
const SHEET_SKY = 1 / luma(ENV.horizon);

/*
 * The three probes `sky/reflection.ts` publishes as `SHEET_REFERENCE`. If these
 * disagree, one of the two copies has been edited and the picture would be of a
 * car the game does not draw -- which is worse than no picture, because somebody
 * would believe it.
 */
{
  const want = [
    { nDotV: 1.0, dirY: 1.0, fresnel: 0.03, radiance: 0.956856 },
    { nDotV: 0.5, dirY: 0.0, fresnel: 0.044688, radiance: 2.487826 },
    { nDotV: 0.1, dirY: -1.0, fresnel: 0.30753, radiance: 0.239369 },
  ];
  for (const row of want) {
    const f = coatFresnel(row.nDotV), r = luma(envRadiance(row.dirY));
    if (Math.abs(f - row.fresnel) > 1e-5 || Math.abs(r - row.radiance) > 1e-4) {
      console.error(
        `the clearcoat in this script has drifted from client/src/sky/reflection.ts:\n` +
          `  at N.V ${row.nDotV}, y ${row.dirY}: F ${f.toFixed(6)} (want ${row.fresnel}), ` +
          `radiance ${r.toFixed(6)} (want ${row.radiance})\n` +
          `  SHEET_REFERENCE and SHEET_ENV in that file are the other half of this check. Update both.`,
      );
      process.exit(1);
    }
  }
}

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
      /*
       * The clearcoat, per face. Flat-shaded like the game's own fleet
       * (`cars.ts` sets `flatShading = true`), so a face normal is the whole
       * story and this can live out here rather than per pixel.
       *
       * The camera is orthographic here, so the view ray is the camera forward
       * for every pixel -- which is the one simplification this picture makes
       * against the shader, and it costs nothing at a 320-pixel cell.
       */
      let shade = [tr.col[0] * lam, tr.col[1] * lam, tr.col[2] * lam];
      if (PBR) {
        const n = [(sgn * nx) / nl, (sgn * ny) / nl, (sgn * nz) / nl];
        const vdn = fwd[0] * n[0] + fwd[1] * n[1] + fwd[2] * n[2];
        const f = coatFresnel(-vdn);
        // reflect(view, normal), and only its y is read: the dome has no azimuth.
        const ry = fwd[1] - 2 * vdn * n[1];
        const e = envRadiance(ry);
        shade = [
          shade[0] * (1 - f) + e[0] * SHEET_SKY * f,
          shade[1] * (1 - f) + e[1] * SHEET_SKY * f,
          shade[2] * (1 - f) + e[2] * SHEET_SKY * f,
        ];
      }
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
          img[o * 3] = shade[0];
          img[o * 3 + 1] = shade[1];
          img[o * 3 + 2] = shade[2];
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
