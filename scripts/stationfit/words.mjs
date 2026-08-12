// Recovering label trains from drawings whose text was converted to outlines.
//
// 111 of the 273 sheets carry no text objects at all -- the lettering is
// geometry. No OCR is needed to use it: a word is a cluster of small glyph
// paths, and "PLATFORM n" is recognisable from its glyph count and its
// aspect alone. Identity comes from OSM, by arrangement, in fit.mjs.
import { dominantAxis } from './cadgeom.mjs';

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

const bgap = (a, b) => Math.hypot(Math.max(0, Math.max(a[0] - b[2], b[0] - a[2])),
                                  Math.max(0, Math.max(a[1] - b[3], b[1] - a[3])));

function unionFind(n) {
  const p = new Int32Array(n).map((_, i) => i);
  const f = (i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  return { f, u: (a, b) => { const x = f(a), y = f(b); if (x !== y) p[x] = y; } };
}

function obbOf(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let ax, ay;
  if (Math.abs(sxy) > 1e-9) { ax = l1 - syy; ay = sxy; } else if (sxx >= syy) { ax = 1; ay = 0; } else { ax = 0; ay = 1; }
  const n = Math.hypot(ax, ay) || 1; ax /= n; ay /= n;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const a = dx * ax + dy * ay, b = -dx * ay + dy * ax;
    if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  return { cx: cx + ax * (a0 + a1) / 2 - ay * (b0 + b1) / 2,
           cy: cy + ay * (a0 + a1) / 2 + ax * (b0 + b1) / 2,
           ux: ax, uy: ay, len: a1 - a0, hgt: b1 - b0 };
}

/** The lettering sizes worth trying, most populous first.
 *  The drawings letter at one or two sizes; which one is the platform lettering
 *  is not knowable up front, so it is searched over and settled by the fit. */
export function glyphSizes(doc, max = 4) {
  const hist = new Map();
  for (const p of doc.paths) {
    if (p.points.length < 3) continue;
    const bb = bboxOf(p.points);
    const m = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    if (m < 1.0 || m > 9) continue;          // below 1 pt it is hatching, not a letter
    const k = Math.round(m * 4) / 4;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  return [...hist.entries()].filter(([, n]) => n >= 20)
    .sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

/** Clusters of small multi-point paths = words of outlined lettering, at one
 *  nominated lettering size. */
export function words(doc, opts = {}) {
  const gh = opts.glyphHeight;
  if (!gh) return [];
  const cand = [];
  for (const p of doc.paths) {
    if (p.points.length < 3) continue;
    const bb = bboxOf(p.points);
    const m = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    if (m < 0.45 * gh || m > 2.2 * gh) continue;
    cand.push({ bb, pts: p.points });
  }
  if (cand.length < 8) return [];
  const eps = Math.max(0.35, 0.85 * gh);

  // grid-bucket the candidates so the pairwise join stays linear-ish
  const cell = Math.max(eps * 2, 1);
  const grid = new Map();
  cand.forEach((c, i) => {
    const gx0 = Math.floor(c.bb[0] / cell), gy0 = Math.floor(c.bb[1] / cell);
    const gx1 = Math.floor(c.bb[2] / cell), gy1 = Math.floor(c.bb[3] / cell);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = `${gx},${gy}`; (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
  });
  const uf = unionFind(cand.length);
  for (const [k, ids] of grid) {
    const [gx, gy] = k.split(',').map(Number);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const o = grid.get(`${gx + dx},${gy + dy}`); if (o) near.push(...o);
    }
    for (const i of ids) for (const j of near) {
      if (i >= j) continue;
      if (bgap(cand[i].bb, cand[j].bb) <= eps) uf.u(i, j);
    }
  }
  const groups = new Map();
  cand.forEach((c, i) => { const r = uf.f(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); });

  const out = [];
  for (const ids of groups.values()) {
    if (ids.length < 4) continue;                 // a word, not a fitting symbol
    const pts = [];
    for (const i of ids) pts.push(...cand[i].pts);
    const o = obbOf(pts);
    if (o.hgt < 0.4 * gh || o.hgt > 4 * gh) continue;
    out.push({ ...o, glyphs: ids.length, aspect: o.len / Math.max(o.hgt, 1e-6) });
  }
  return { words: out, glyphHeight: gh };
}

function cluster1d(items, key, gap) {
  const s = [...items].sort((a, b) => key(a) - key(b));
  const g = []; let cur = [];
  for (const it of s) {
    if (cur.length && key(it) - key(cur[cur.length - 1]) > gap) { g.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) g.push(cur);
  return g;
}

/** Trains of long words repeated along the corridor -- the "PLATFORM n"
 *  lettering, without knowing which n. */
export function wordTrains(doc, opts = {}) {
  const r = words(doc, { glyphHeight: opts.glyphHeight });
  if (!r || !r.words) return { trains: [], axis: null, words: [] };
  const ax = opts.axis || dominantAxis(doc.paths) || { ux: 1, uy: 0 };
  const gh = r.glyphHeight;
  // "PLATFORM n" is 9 glyph groups (letters with counters split further, so
  // allow a generous range) and roughly 6-13 times as long as it is tall.
  const cands = r.words.filter((w) => {
    if (Math.abs(w.ux * ax.ux + w.uy * ax.uy) < Math.cos(28 * Math.PI / 180)) return false;
    return w.aspect >= 4 && w.aspect <= 16 && w.glyphs >= 6 && w.glyphs <= 26
      && w.len > 3.5 * gh;
  });
  if (cands.length < 2) return { trains: [], axis: ax, words: r.words };
  // the words of one platform share a perpendicular offset
  const perp = (w) => -w.cx * ax.uy + w.cy * ax.ux;
  const groups = cluster1d(cands, perp, Math.max(2.2 * gh, 3));
  const trains = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    let cx = 0, cy = 0; for (const w of g) { cx += w.cx; cy += w.cy; }
    cx /= g.length; cy /= g.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const w of g) { const dx = w.cx - cx, dy = w.cy - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
    let ux, uy;
    if (Math.abs(sxy) > 1e-9) { ux = l1 - syy; uy = sxy; } else { ux = ax.ux; uy = ax.uy; }
    const n = Math.hypot(ux, uy) || 1; ux /= n; uy /= n;
    if (ux * ax.ux + uy * ax.uy < 0) { ux = -ux; uy = -uy; }
    // the word origin is its left end in reading order, matching the text case
    const ends = g.map((w) => [w.cx - w.ux * w.len / 2 * Math.sign(w.ux * ux + w.uy * uy),
                               w.cy - w.uy * w.len / 2 * Math.sign(w.ux * ux + w.uy * uy)]);
    const al = ends.map((p) => (p[0] - cx) * ux + (p[1] - cy) * uy);
    const a0 = Math.min(...al), a1 = Math.max(...al);
    trains.push({
      ref: null, n: g.length, ux, uy, cx, cy, a0, a1, span: a1 - a0,
      x0: cx + ux * a0, y0: cy + uy * a0, x1: cx + ux * a1, y1: cy + uy * a1,
      perp: (-cx * ax.uy + cy * ax.ux),
      pts: ends,
    });
  }
  return { trains, axis: ax, glyphHeight: gh, words: r.words };
}
