// Reading the station CAD JSON as geometry in one consistent page frame.
//
// There is only one page frame to read it in: `scripts/stationcad.py` writes
// texts and paths alike in native PDF page space, x right and y UP from the
// MediaBox bottom-left. It did not always -- until 2026-08-12 the paths came
// straight out of pdfplumber's display space, y down, and this file flipped
// them on the way in. The flip now lives in the extractor, which is the one
// place that knows what pdfplumber handed it, and this file just reads.
import fs from 'node:fs';

export function loadDoc(path) {
  const d = JSON.parse(fs.readFileSync(path, 'utf8'));
  const mb = d.source.media_box;
  const paths = d.paths.map((p) => ({
    kind: p.kind, stroke: p.stroke, fill: p.fill, linewidth: p.linewidth,
    points: p.points,
  }));
  return { slug: d.station.slug, name: d.station.name, H: mb[3] - mb[1], W: mb[2] - mb[0], texts: d.texts, paths };
}

export const seglen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polylen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += seglen(pts[i - 1], pts[i]);
  return s;
}

// Length-weighted dominant direction of the drawing's segments, taken mod 180
// via the doubled-angle trick. Rail drawings are overwhelmingly made of
// corridor-parallel line work -- rails, sleepers' bounding rails, platform
// copings, canopy edges, fences -- so this recovers the corridor axis.
export function dominantAxis(paths, opts = {}) {
  const minLen = opts.minLen ?? 3;
  let sx = 0, sy = 0, tot = 0;
  for (const p of paths) {
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1], b = p.points[i];
      const L = seglen(a, b);
      if (L < minLen) continue;
      const th = Math.atan2(b[1] - a[1], b[0] - a[0]) * 2;
      sx += Math.cos(th) * L; sy += Math.sin(th) * L; tot += L;
    }
  }
  if (!tot) return null;
  const th = Math.atan2(sy, sx) / 2;
  return { ux: Math.cos(th), uy: Math.sin(th), strength: Math.hypot(sx, sy) / tot, total: tot };
}

// Long, near-straight chains running within `tolDeg` of the axis. A platform
// coping is one of these; so is a rail, a fence and a canopy edge.
export function axisChains(paths, ux, uy, opts = {}) {
  const minLen = opts.minLen ?? 25;
  const tolDeg = opts.tolDeg ?? 22;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const out = [];
  for (const p of paths) {
    if (!p.stroke && !p.fill) continue;
    if (p.points.length < 2) continue;
    // split at direction breaks so an L-shaped path contributes its long leg
    let run = [p.points[0]];
    const flush = () => {
      if (run.length >= 2) {
        const L = polylen(run);
        if (L >= minLen) {
          const a = run[0], b = run[run.length - 1];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const dl = Math.hypot(dx, dy) || 1;
          const c = Math.abs((dx / dl) * ux + (dy / dl) * uy);
          if (c >= cosTol && dl > 0.85 * L) {
            let ca = 0, cb = 0; for (const q of run) { ca += q[0]; cb += q[1]; }
            ca /= run.length; cb /= run.length;
            const t = run.map((q) => (q[0] - ca) * ux + (q[1] - ca * 0) * 0);
            const along = run.map((q) => q[0] * ux + q[1] * uy);
            const perp = run.map((q) => -q[0] * uy + q[1] * ux);
            out.push({
              points: run.slice(), len: L,
              a0: Math.min(...along), a1: Math.max(...along),
              v: perp.reduce((s, x) => s + x, 0) / perp.length,
              vmin: Math.min(...perp), vmax: Math.max(...perp),
              linewidth: p.linewidth, kind: p.kind,
            });
          }
        }
      }
      run = [];
    };
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1], b = p.points[i];
      if (seglen(a, b) < 1e-6) continue;
      if (run.length >= 2) {
        const pv = run[run.length - 1], pp = run[run.length - 2];
        const d1 = Math.atan2(pv[1] - pp[1], pv[0] - pp[0]);
        const d2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        let dd = Math.abs(d2 - d1); if (dd > Math.PI) dd = 2 * Math.PI - dd;
        if (dd > 0.35) { flush(); run = [a]; }
      }
      if (!run.length) run = [a];
      run.push(b);
    }
    flush();
  }
  return out;
}
