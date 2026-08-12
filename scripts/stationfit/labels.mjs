// Platform labels in the CAD, grouped into the slab they sit on.
//
// The drawings letter each platform repeatedly along its length at a regular
// pitch, so the labels for one platform number are a collinear point train
// whose extent tracks the slab. That is the property the fit leans on, and it
// is measured (see REPORT) rather than assumed.
import { dominantAxis } from './cadgeom.mjs';

const NORM = (s) => s.replace(/\s+/g, ' ').trim().toUpperCase();

export function platformLabels(doc) {
  const out = [];
  for (const t of doc.texts) {
    const s = NORM(t.text);
    const m = s.match(/^PLATFORM\s*\.?\s*(\d{1,2})$/) || s.match(/^PLATFORM(\d{1,2})$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1 && n <= 30)) continue;
    out.push({ ref: n, x: t.x, y: t.y, rot: t.rotation_deg, size: t.size });
  }
  return out;
}

// 1-D single-link clustering with a gap threshold.
function cluster1d(items, key, gap) {
  const s = [...items].sort((a, b) => key(a) - key(b));
  const groups = [];
  let cur = [];
  for (const it of s) {
    if (cur.length && key(it) - key(cur[cur.length - 1]) > gap) { groups.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function pca(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let ax, ay;
  if (Math.abs(sxy) > 1e-9) { ax = l1 - syy; ay = sxy; } else if (sxx >= syy) { ax = 1; ay = 0; } else { ax = 0; ay = 1; }
  const n = Math.hypot(ax, ay) || 1;
  return { cx, cy, ux: ax / n, uy: ay / n };
}

/** Per platform number: the dominant collinear train of labels, with its axis,
 *  along-extent and perpendicular offset, all in the normalised page frame. */
export function labelTrains(doc, opts = {}) {
  const gap = opts.gap ?? 14;
  const labs = platformLabels(doc);
  if (labs.length < 2) return { axis: null, trains: [] };
  const ax = dominantAxis(doc.paths) || { ux: 1, uy: 0 };
  const byRef = new Map();
  for (const l of labs) (byRef.get(l.ref) || byRef.set(l.ref, []).get(l.ref)).push(l);
  const trains = [];
  for (const [ref, pts] of byRef) {
    const perp = (p) => -p.x * ax.uy + p.y * ax.ux;
    const groups = cluster1d(pts, perp, gap);
    groups.sort((a, b) => b.length - a.length || 0);
    const g = groups[0];
    const others = groups.slice(1).reduce((s, x) => s + x.length, 0);
    const f = pca(g);
    // keep the axis pointing the same way for every train
    let { ux, uy } = f;
    if (ux * ax.ux + uy * ax.uy < 0) { ux = -ux; uy = -uy; }
    const al = g.map((p) => (p.x - f.cx) * ux + (p.y - f.cy) * uy);
    const pe = g.map((p) => -(p.x - f.cx) * uy + (p.y - f.cy) * ux);
    const a0 = Math.min(...al), a1 = Math.max(...al);
    const spread = Math.max(...pe.map(Math.abs));
    trains.push({
      ref, n: g.length, nDiscarded: others, ux, uy, cx: f.cx, cy: f.cy,
      a0, a1, span: a1 - a0, perpSpread: spread,
      x0: f.cx + ux * a0, y0: f.cy + uy * a0,
      x1: f.cx + ux * a1, y1: f.cy + uy * a1,
      pts: g.map((p) => [p.x, p.y]),
    });
  }
  trains.sort((a, b) => a.ref - b.ref);
  return { axis: ax, trains };
}
