// North-arrow symbol detector for the TfNSW station CAD corpus.
// The drawings carry no *textual* north annotation, but every one of them that
// was drawn from the standard template carries the CAD block: a small circle
// with an inscribed two-tone needle. The needle's tip is north.
import fs from 'node:fs';

const V = (a, b) => [b[0] - a[0], b[1] - a[1]];
const len = (v) => Math.hypot(v[0], v[1]);

export function obb(points) {
  let cx = 0, cy = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; }
  cx /= points.length; cy /= points.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  let ax, ay;
  if (Math.abs(sxy) > 1e-12) { ax = l1 - syy; ay = sxy; }
  else if (sxx >= syy) { ax = 1; ay = 0; } else { ax = 0; ay = 1; }
  const n = Math.hypot(ax, ay) || 1; ax /= n; ay /= n;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of points) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const a = dx * ax + dy * ay, b = -dx * ay + dy * ax;
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  return { cx, cy, ax, ay, long: a1 - a0, short: b1 - b0, a0, a1, b0, b1 };
}

// A shaft candidate: a filled sliver, long and thin.
function shaftCandidates(paths) {
  const out = [];
  for (const p of paths) {
    if (!p.fill) continue;
    if (p.points.length < 3 || p.points.length > 6) continue;
    const o = obb(p.points);
    if (o.long < 5 || o.long > 60) continue;
    if (o.short > o.long * 0.22) continue;
    out.push(o);
  }
  return out;
}

export function detectNorth(doc) {
  if (!doc || !Array.isArray(doc.paths)) return [];
  const cands = shaftCandidates(doc.paths);
  // cluster shafts that sit on top of each other (the needle is drawn as two
  // half-slivers, one per tone)
  const used = new Array(cands.length).fill(false);
  const found = [];
  for (let i = 0; i < cands.length; i++) {
    if (used[i]) continue;
    const group = [i]; used[i] = true;
    for (let j = i + 1; j < cands.length; j++) {
      if (used[j]) continue;
      const a = cands[i], b = cands[j];
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > 0.35 * a.long) continue;
      if (Math.abs(a.long - b.long) > 0.3 * a.long) continue;
      if (Math.abs(a.ax * b.ax + a.ay * b.ay) < 0.95) continue;
      group.push(j); used[j] = true;
    }
    if (group.length < 2) continue;              // the needle is two-tone
    const g = group.map((k) => cands[k]);
    const cx = g.reduce((s, o) => s + o.cx, 0) / g.length;
    const cy = g.reduce((s, o) => s + o.cy, 0) / g.length;
    let ax = g[0].ax, ay = g[0].ay;
    const L = g.reduce((s, o) => s + o.long, 0) / g.length;

    // Everything drawn inside the symbol's disc.
    const R = L * 0.85;
    const local = [];
    for (const p of doc.paths) {
      let all = true;
      for (const q of p.points) if (Math.hypot(q[0] - cx, q[1] - cy) > R) { all = false; break; }
      if (all && p.points.length) local.push(p);
    }
    if (local.length < 4) continue;

    // The enclosing circle: a closed path whose vertices are equidistant from
    // the centre. Its presence is what separates a north point from a random
    // pair of slivers (a hatch, an arrowhead on a dimension line).
    let ring = null;
    for (const p of local) {
      if (p.points.length < 4 || p.points.length > 40) continue;
      const r = p.points.map((q) => Math.hypot(q[0] - cx, q[1] - cy));
      const mr = r.reduce((a, b) => a + b, 0) / r.length;
      if (mr < L * 0.4) continue;
      const dev = Math.max(...r.map((v) => Math.abs(v - mr))) / mr;
      if (dev < 0.18) { ring = mr; break; }
    }
    if (ring === null) continue;

    // Which end is the head? The head is wide, the tail is the bare shaft.
    const pts = [];
    for (const p of local) for (const q of p.points) pts.push(q);
    let amin = Infinity, amax = -Infinity;
    for (const q of pts) {
      const a = (q[0] - cx) * ax + (q[1] - cy) * ay;
      if (a < amin) amin = a; if (a > amax) amax = a;
    }
    const span = amax - amin;
    let wPos = 0, wNeg = 0;
    for (const q of pts) {
      const a = (q[0] - cx) * ax + (q[1] - cy) * ay;
      const b = Math.abs(-(q[0] - cx) * ay + (q[1] - cy) * ax);
      if (a > amin + 0.62 * span) wPos = Math.max(wPos, b);
      if (a < amin + 0.38 * span) wNeg = Math.max(wNeg, b);
    }
    if (Math.abs(wPos - wNeg) < 0.25 * Math.max(wPos, wNeg)) continue; // ambiguous
    if (wNeg > wPos) { ax = -ax; ay = -ay; }
    found.push({ cx, cy, nx: ax, ny: ay, size: L, ring, widthRatio: Math.max(wPos, wNeg) / Math.min(wPos, wNeg) });
  }
  return found;
}

export function northBearing(doc) {
  const f = detectNorth(doc);
  if (!f.length) return null;
  // agreement across instances is the confidence
  let sx = 0, sy = 0;
  for (const a of f) { sx += a.nx; sy += a.ny; }
  const n = Math.hypot(sx, sy) / f.length;
  sx /= f.length * (n || 1); sy /= f.length * (n || 1);
  let worst = 0;
  for (const a of f) worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, a.nx * sx + a.ny * sy))) * 180 / Math.PI);
  return { nx: sx, ny: sy, count: f.length, agree: n, worstDeg: worst, instances: f };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'data/scratch/stationcad';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json' && f !== 'fit.json');
  let hit = 0; const rows = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    const r = northBearing(doc);
    if (r) { hit++; rows.push([f.replace('.json',''), r.count, (Math.atan2(r.nx, r.ny) * 180 / Math.PI).toFixed(2), r.worstDeg.toFixed(2)]); }
    else rows.push([f.replace('.json',''), 0, '-', '-']);
  }
  console.log(`north arrow found in ${hit}/${files.length}`);
  const bearings = rows.filter((r) => r[1] > 0).map((r) => Number(r[2]));
  const hist = {};
  for (const b of bearings) { const k = Math.round(b / 5) * 5; hist[k] = (hist[k] || 0) + 1; }
  console.log('bearing histogram (deg CW of page-up):', JSON.stringify(hist));
  const bad = rows.filter((r) => r[1] > 0 && Number(r[3]) > 3);
  console.log('disagreeing instances:', bad.length, bad.slice(0, 20));
  console.log('missing:', rows.filter((r) => r[1] === 0).map((r) => r[0]).slice(0, 40));
}
