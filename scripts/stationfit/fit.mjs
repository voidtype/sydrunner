#!/usr/bin/env node
// Phase 0b: georeference the station CAD corpus.
//
// Solves, per station, the similarity transform taking CAD page coordinates to
// SYDNEY world coordinates -- rotation, uniform scale, translation, mirror --
// by putting the drawing's platform lettering against the OSM platform
// rectangles the rail bake already measured, and checking the answer against
// the station building footprint, which is an independent anchor.
//
// Idempotent and resumable: same inputs, same fit.json; `--only <slug>`
// refits one station in place.
//
// Two things about the corpus that this file depends on, both measured:
//
//  * `scripts/stationcad.py` writes texts and paths in ONE space: PDF page
//    points, y up from the MediaBox bottom-left. (Before 2026-08-12 it wrote
//    two, and cadgeom.loadDoc did the flip. The extractor does it now.)
//  * The drawings letter each platform repeatedly along its length, and the
//    extent of that lettering tracks the platform slab to within a few per
//    cent. That is what makes a two-platform station fittable at all.
import fs from 'node:fs';
import path from 'node:path';
import { loadDoc, dominantAxis } from './cadgeom.mjs';
import { labelTrains } from './labels.mjs';
import { wordTrains, glyphSizes } from './words.mjs';
import { loadStations, stationFor, slabsOf } from './osm.mjs';
import { umeyama, apply, residuals } from './similarity.mjs';
import { northBearing } from './northarrow.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CAD = path.join(ROOT, 'data', 'scratch', 'stationcad');
const OUT = path.join(CAD, 'fit.json');
const SKIP = new Set(['summary.json', 'fit.json', 'buildings.json', 'extract_failures.json']);

// --- gates -------------------------------------------------------------------
// A platform is ~10 m wide, a station building ~10 m deep and a staircase ~3 m.
// A fit whose error approaches half a platform width cannot be trusted to put a
// structure on the right side of the track, so the accept gate sits well inside
// that: 8 m RMS, and no single correspondence worse than 16 m.
const RMS_HIGH = 4.0;
const RMS_ACCEPT = 8.0;
const WORST_ACCEPT = 16.0;
const AMBIGUITY_MIN = 1.5;      // the runner-up placement must be this much worse
const BUILDING_DECIDES = 25.0;  // m of along-corridor separation to call it
const BUILDING_CORROBORATE = 45.0;
const SCALE_RANGE = [0.10, 2.00];
// Every sheet is one station fitted to one page, so the scale is per-station --
// but the *coverage*, the length of railway the sheet spans, is a drafting
// habit and is not. Across the fits the platforms decide on their own it sits
// at 486 m with a 10-90 range of 407-596 m, so a candidate implying a sheet
// covering 200 m or 1.6 km has mismatched something.
const COVERAGE_M = [300, 900];

// A plan is drawn looking down at the ground; it is never a mirror image,
// because the lettering would read backwards. So the handedness of the
// page->world map is a property of the corpus, not of the station: page y up
// is north-ish and world z is south, which makes the map orientation-REVERSING
// (det A < 0, `reflect: true` in the Umeyama parametrisation) for every sheet.
//
// This is not assumed. Fitting all four combinations of end-pairing and
// handedness, 17 of the 20 stations whose platforms decide the question on
// their own came out orientation-reversing, and the three that did not were
// all within 1.6x of their rival -- i.e. undecided. Imposing it removes the
// one real ambiguity platform rectangles leave: a platform has no
// distinguishable ends, so end-for-end reversal plus a reflection is a
// near-perfect fit at almost every station.
const PLAN_IS_UNMIRRORED = true;

// --- small geometry ----------------------------------------------------------

function pcaLine(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let ux, uy;
  if (Math.abs(sxy) > 1e-9) { ux = l1 - syy; uy = sxy; } else if (sxx >= syy) { ux = 1; uy = 0; } else { ux = 0; uy = 1; }
  const n = Math.hypot(ux, uy) || 1;
  return { cx, cy, ux: ux / n, uy: uy / n };
}

function trainFromPoints(pts, axis) {
  const f = pcaLine(pts);
  let { ux, uy } = f;
  if (ux * axis.ux + uy * axis.uy < 0) { ux = -ux; uy = -uy; }
  const al = pts.map((p) => (p[0] - f.cx) * ux + (p[1] - f.cy) * uy);
  const a0 = Math.min(...al), a1 = Math.max(...al);
  return {
    n: pts.length, ux, uy, cx: f.cx, cy: f.cy, span: a1 - a0,
    e0: [f.cx + ux * a0, f.cy + uy * a0],
    e1: [f.cx + ux * a1, f.cy + uy * a1],
    perp: -f.cx * axis.uy + f.cy * axis.ux,
    pts,
  };
}

const canonU = (o, r) => (o.ux * r.ux + o.uz * r.uz < 0 ? { ux: -o.ux, uz: -o.uz } : { ux: o.ux, uz: o.uz });

function endsOf(o, r, half) {
  const u = canonU(o, r);
  return [[o.x - u.ux * half, o.z - u.uz * half], [o.x + u.ux * half, o.z + u.uz * half]];
}

// --- correspondence sets -----------------------------------------------------

/** Contiguous, order-preserving assignments of CAD trains to OSM slabs: a slab
 *  may take one train per platform number it carries, or none, and surplus
 *  trains (street names, "NIGHT SAFE AREA") may be left over. */
function enumerateMaps(nTrains, slabs, cap = 20000) {
  const out = []; const acc = new Array(slabs.length).fill(null); let count = 0;
  (function rec(si, ti) {
    if (count > cap) return;
    if (si === slabs.length) { out.push(acc.slice()); count++; return; }
    const maxK = Math.min(2, Math.max(1, (slabs[si].refs || []).length || 1));
    for (let start = ti; start < nTrains; start++) {
      for (let k = 1; k <= maxK && start + k <= nTrains; k++) {
        acc[si] = []; for (let j = 0; j < k; j++) acc[si].push(start + j);
        rec(si + 1, start + k);
      }
    }
    acc[si] = null;
    rec(si + 1, ti);
  })(0, 0);
  return out;
}

function groupsFor(map, trains, targets, axis, ref0) {
  const groups = [];
  for (let i = 0; i < targets.length; i++) {
    const ids = map[i];
    if (!ids || !ids.length) continue;
    const all = [];
    for (const j of ids) all.push(...trains[j].pts);
    if (all.length < 2) continue;
    const t = trainFromPoints(all, axis);
    const o = targets[i];
    groups.push({
      cad: [t.e0, t.e1],
      osm: endsOf(o, ref0, o.halfLength),
      refs: o.refs, cadSpan: t.span, osmLength: 2 * o.halfLength, trains: ids,
    });
  }
  return groups;
}

function solve(groups, alongFlip, reflect, pageW) {
  const pts = [], qts = [];
  for (const g of groups) {
    pts.push(g.cad[0], g.cad[1]);
    if (alongFlip > 0) qts.push(g.osm[0], g.osm[1]); else qts.push(g.osm[1], g.osm[0]);
  }
  if (pts.length < 2) return null;
  const T = umeyama(pts, qts, reflect);
  if (!T || T.scale < SCALE_RANGE[0] || T.scale > SCALE_RANGE[1]) return null;
  const cov = pageW * T.scale;
  if (cov < COVERAGE_M[0] || cov > COVERAGE_M[1]) return null;
  const r = pts.length >= 4 ? residuals(T, pts, qts) : { errs: [], rms: 0, worst: 0 };
  return { T, r, groups, alongFlip, reflect, nPoints: pts.length };
}

// --- the independent anchor: the station building ----------------------------

const BUILDING_WORDS = /^(STATION|STATION BUILDING|BOOKING|BOOKING OFFICE|BO|OFFICE|WAITING|WAITING ROOM|WR|TOILET|TOILETS|WC|MALE|FEMALE|TVM|NIGHTSAFE|NIGHT SAFE AREA|NIGHTSAFE AREA|SHOP|KIOSK|STORE|STORE ROOM|CONCOURSE|FOYER|SM|LMR|STATION ENTRY|ENTRY)$/;
const NOT_A_STATION = /substation|signal|zone|works|depot|shed/i;

function cadBuildingAnchor(doc) {
  const pts = [];
  for (const t of doc.texts) {
    const s = t.text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (BUILDING_WORDS.test(s)) pts.push([t.x, t.y]);
  }
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
  const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  return { p: [xs[xs.length >> 1], ys[ys.length >> 1]], n: pts.length };
}

function osmBuildingAnchor(list) {
  if (!list || !list.length) return null;
  const named = list.filter((b) => (b.building === 'train_station'
    || (b.name && /\bstation\b/i.test(b.name))) && !NOT_A_STATION.test(b.name || '') && b.dist < 80);
  const pool = named.length ? named : list.filter((b) => b.dist < 45 && b.area > 20 && !NOT_A_STATION.test(b.name || ''));
  if (!pool.length) return null;
  let bx = 0, bz = 0, w = 0;
  for (const b of pool) {
    const cx = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length;
    const cz = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
    bx += cx * b.area; bz += cz * b.area; w += b.area;
  }
  return { p: [bx / w, bz / w], n: pool.length, tagged: named.length > 0 };
}

// --- choosing between placements ---------------------------------------------

/** Two candidates are rivals only if they would put the drawing somewhere
 *  materially different. Shuffling one platform's correspondence by a metre is
 *  not a rival placement, it is the same answer computed slightly differently,
 *  and treating it as a rival would reject every station that has more than one
 *  way of reading its lettering. */
function materiallyDifferent(a, b) {
  const dt = Math.hypot(a.T.t[0] - b.T.t[0], a.T.t[1] - b.T.t[1]);
  const ds = Math.abs(a.T.scale - b.T.scale) / a.T.scale;
  const ua = [a.T.A[0][0], a.T.A[1][0]], ub = [b.T.A[0][0], b.T.A[1][0]];
  const cos = (ua[0] * ub[0] + ua[1] * ub[1]) / (Math.hypot(...ua) * Math.hypot(...ub));
  const dth = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  return dt > 25 || ds > 0.08 || dth > 5;
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const { by } = loadStations(path.join(ROOT, 'data', 'scratch', 'rail', 'rail.json'));
  const bpath = path.join(CAD, 'buildings.json');
  const buildings = fs.existsSync(bpath) ? JSON.parse(fs.readFileSync(bpath, 'utf8')) : {};

  const files = fs.readdirSync(CAD).filter((f) => f.endsWith('.json') && !SKIP.has(f));
  const records = [];
  for (const f of files) {
    const slug = f.replace('.json', '');
    if (only && slug !== only) continue;
    const rec = { slug, accept: false, confidence: 'rejected', reason: null };
    let doc;
    try { doc = loadDoc(path.join(CAD, f)); } catch (e) { rec.reason = 'unreadable: ' + e.message; records.push(rec); continue; }
    rec.name = doc.name;
    const st = stationFor(by, slug);
    if (!st) { rec.reason = 'not in the rail bake -- outside the 60 km world extent, or renamed'; records.push(rec); continue; }
    rec.station = st.name;
    const slabsRaw = slabsOf(st);
    if (!slabsRaw.length) { rec.reason = 'station carries no measured platform polygon'; records.push(rec); continue; }

    // --- CAD lettering -> trains
    const dom = dominantAxis(doc.paths) || { ux: 1, uy: 0 };
    let outlineSizes = [], outlineSets = [];
    const textT = labelTrains(doc);
    const nText = textT.trains.filter((t) => t.n >= 3).length;
    let source, rawTrains;
    if (nText >= 1) {
      source = 'text';
      rawTrains = textT.trains.filter((t) => t.n >= 2 && t.span > 20)
        .map((t) => ({ ...trainFromPoints(t.pts, dom), ref: t.ref }));
    } else {
      source = 'outline';
      // no text objects at all: the lettering is geometry. Every plausible
      // lettering size is tried and the fit decides which one was the
      // platform lettering -- a nuisance parameter, settled by evidence.
      outlineSizes = glyphSizes(doc);
      rawTrains = [];
      for (const gh of outlineSizes) {
        const ts = wordTrains(doc, { axis: dom, glyphHeight: gh }).trains
          .filter((t) => t.n >= 2 && t.span > 40).map((t) => ({ ...trainFromPoints(t.pts, dom), gh }));
        if (ts.length >= 2) outlineSets.push(ts);
      }
      rawTrains = outlineSets.length ? outlineSets[0] : [];
    }
    rec.source = source;
    rec.cadTrains = rawTrains.length;
    if (source === 'outline') rec.letteringSizesTried = outlineSizes;
    rec.osmSlabs = slabsRaw.length;
    rec.osmRefs = slabsRaw.flatMap((s) => s.refs);
    if (source === 'text') rec.cadRefs = [...new Set(rawTrains.map((t) => t.ref))].sort((a, b) => a - b);
    if (!rawTrains.length) { rec.reason = 'no platform lettering recovered from the drawing'; records.push(rec); continue; }

    // refine the corridor axis from the trains themselves
    let sx = 0, sy = 0;
    for (const t of rawTrains) { const th = Math.atan2(t.uy, t.ux) * 2; sx += Math.cos(th) * t.span; sy += Math.sin(th) * t.span; }
    const ath = Math.atan2(sy, sx) / 2;
    const axis = { ux: Math.cos(ath), uy: Math.sin(ath) };
    const norm = (list) => list.map((t) => ({ ...trainFromPoints(t.pts, axis), ref: t.ref, gh: t.gh }))
      .sort((a, b) => a.perp - b.perp).slice(0, 12);
    const trains = norm(rawTrains);
    const trainSets = source === 'outline' ? outlineSets.map(norm) : [trains];

    // --- OSM targets, ordered across the corridor
    const ref0 = slabsRaw[0];
    const perpOf = (o) => -o.x * ref0.uz + o.z * ref0.ux;
    const slabs = [...slabsRaw].sort((a, b) => perpOf(a) - perpOf(b));
    // a lone island is the one case where the individual faces carry more than
    // the slab does: they are what tells the two sides of it apart
    const faces = (st.faces || []).filter((ff) => ff.halfLength > 5)
      .map((ff) => ({ ...ff, refs: ff.refs || [] })).sort((a, b) => perpOf(a) - perpOf(b));
    const useFaces = slabs.length === 1 && faces.length >= 2;
    const targets = useFaces ? faces : slabs;
    rec.targets = useFaces ? 'faces' : 'slabs';

    // --- hypotheses
    const hyps = [];   // the plan convention: orientation-reversing
    const alt = [];    // the mirrored reading, kept only to report on it
    if (source === 'text') {
      const map = targets.map((s) => {
        const ids = trains.map((t, i) => [t, i]).filter(([t]) => (s.refs || []).includes(t.ref)).map(([, i]) => i);
        return ids.length ? ids : null;
      });
      const groups = groupsFor(map, trains, targets, axis, ref0);
      for (const af of [1, -1]) for (const rf of [true, false]) {
        const h = solve(groups, af, rf, doc.W); if (h) (rf ? hyps : alt).push(h);
      }
    } else {
      for (const trainSet of trainSets) {
      const trains = trainSet;
      for (const order of [1, -1]) {
        const ts = order > 0 ? targets : [...targets].reverse();
        for (const m of enumerateMaps(trains.length, ts)) {
          if (m.filter((x) => x && x.length).length < 2) continue;
          const groups = groupsFor(m, trains, ts, axis, ref0);
          if (groups.length < 2) continue;
          for (const af of [1, -1]) for (const rf of [true, false]) {
            const h = solve(groups, af, rf, doc.W); if (h) { h.gh = trains[0] && trains[0].gh; (rf ? hyps : alt).push(h); }
          }
        }
      }
      }
    }
    if (!hyps.length) { rec.reason = 'no admissible correspondence set'; records.push(rec); continue; }
    alt.sort((a, b) => a.r.rms - b.r.rms);

    // --- the building anchor, evaluated for every placement
    const cb = cadBuildingAnchor(doc);
    const ob = osmBuildingAnchor(buildings[st.name]);
    const corridor = canonU(ref0, ref0);
    const buildingErr = (h) => {
      if (!cb || !ob) return null;
      const w = apply(h.T, cb.p);
      const dx = w[0] - ob.p[0], dz = w[1] - ob.p[1];
      return { along: Math.abs(dx * corridor.ux + dz * corridor.uz), perp: Math.abs(-dx * corridor.uz + dz * corridor.ux), total: Math.hypot(dx, dz) };
    };

    // --- collapse to distinct placements, best first
    hyps.sort((a, b) => a.r.rms - b.r.rms);
    let best = hyps[0];
    const rival = hyps.find((h) => materiallyDifferent(h, best)) || null;
    const ratio = rival && best.r.rms > 1e-6 ? rival.r.rms / best.r.rms : null;
    let resolvedBy = 'residual';
    let ambiguous = false;
    if (rival && (ratio === null || ratio < AMBIGUITY_MIN)) {
      // With handedness fixed by the plan convention, the surviving rival is a
      // 180-degree rotation of the sheet: right corridor, wrong end, and
      // therefore wrong side. Nothing in a platform rectangle can tell them
      // apart, so the building has to.
      // the platform rectangles cannot tell these apart -- a platform has no
      // distinguishable ends and, mirrored, an island layout maps onto itself.
      const eb = buildingErr(best), er = buildingErr(rival);
      if (eb && er && Math.abs(eb.total - er.total) > BUILDING_DECIDES) {
        if (er.total < eb.total) { best = rival; }
        resolvedBy = 'building';
      } else {
        ambiguous = true;
      }
    }

    rec.matchedSlabs = best.groups.length;
    rec.correspondences = best.groups.map((g) => ({
      refs: g.refs, cadSpanPt: +g.cadSpan.toFixed(1), osmLengthM: +g.osmLength.toFixed(1),
      lengthRatio: +((g.cadSpan * best.T.scale) / g.osmLength).toFixed(3),
    }));
    if (best.gh) rec.letteringSizePt = best.gh;
    rec.transform = {
      a: best.T.A.map((r) => r.map((v) => +v.toFixed(6))),
      t: best.T.t.map((v) => +v.toFixed(3)),
      scaleMPerPt: +best.T.scale.toFixed(5),
      mirror: !best.T.reflect,
    };
    const up = [best.T.A[0][1], best.T.A[1][1]];
    rec.transform.pageUpBearingDeg = +(((Math.atan2(up[0], -up[1]) * 180) / Math.PI + 360) % 360).toFixed(2);
    rec.nPoints = best.nPoints;
    rec.residual = { rmsM: +best.r.rms.toFixed(2), worstM: +best.r.worst.toFixed(2), points: best.nPoints, determined: best.nPoints < 4 };
    rec.rivalRmsM = rival ? +rival.r.rms.toFixed(2) : null;
    rec.ambiguityRatio = ratio === null ? null : +ratio.toFixed(2);
    rec.resolvedBy = resolvedBy;
    if (alt.length) {
      rec.mirroredAlternativeRmsM = +alt[0].r.rms.toFixed(2);
      // a sheet that only fits mirrored is a sheet this method has misread
      if (best.r.rms > 1e-6 && alt[0].r.rms < best.r.rms / 2) rec.mirrorSuspect = true;
    }

    // page region over which this transform means anything: several sheets draw
    // the same station twice (a concourse view above the platform view), and
    // only the fitted view maps to the world
    {
      const [[a, b], [c, d]] = best.T.A; const det = a * d - b * c;
      const Ai = [[d / det, -b / det], [-c / det, a / det]];
      const inv = (q) => { const x = q[0] - best.T.t[0], z = q[1] - best.T.t[1]; return [Ai[0][0] * x + Ai[0][1] * z, Ai[1][0] * x + Ai[1][1] * z]; };
      const pts = [];
      for (const g of best.groups) for (const e of g.osm) pts.push(inv(e));
      const m = 45 / best.T.scale;
      rec.validRegionPt = [
        +(Math.min(...pts.map((p) => p[0])) - m).toFixed(1), +(Math.min(...pts.map((p) => p[1])) - m).toFixed(1),
        +(Math.max(...pts.map((p) => p[0])) + m).toFixed(1), +(Math.max(...pts.map((p) => p[1])) + m).toFixed(1)];
    }

    rec.pageCoverageM = Math.round(doc.W * best.T.scale);

    // Every platform the station has must land on the sheet, not only the ones
    // the fit used. A correspondence set can be internally consistent and still
    // be the wrong reading of the drawing; the platforms it did not use are the
    // held-out data that catches it.
    {
      const [[a, b], [c, d]] = best.T.A; const det = a * d - b * c;
      const Ai = [[d / det, -b / det], [-c / det, a / det]];
      const inv = (q) => { const x = q[0] - best.T.t[0], z = q[1] - best.T.t[1]; return [Ai[0][0] * x + Ai[0][1] * z, Ai[1][0] * x + Ai[1][1] * z]; };
      let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
      for (const pp of doc.paths) for (const q of pp.points) {
        if (q[0] < cx0) cx0 = q[0]; if (q[0] > cx1) cx1 = q[0];
        if (q[1] < cy0) cy0 = q[1]; if (q[1] > cy1) cy1 = q[1];
      }
      let worstOff = 0;
      for (const o of slabsRaw) {
        for (const e of endsOf(o, ref0, o.halfLength * 0.9)) {
          const q = inv(e);
          const dx = Math.max(cx0 - q[0], 0, q[0] - cx1), dy = Math.max(cy0 - q[1], 0, q[1] - cy1);
          worstOff = Math.max(worstOff, Math.hypot(dx, dy) * best.T.scale);
        }
      }
      rec.offSheetM = +worstOff.toFixed(1);
    }
    const eb = buildingErr(best);
    if (eb) rec.buildingCheck = { cadTexts: cb.n, osmFootprints: ob.n, stationTagged: ob.tagged, offsetM: +eb.total.toFixed(1), alongM: +eb.along.toFixed(1), perpM: +eb.perp.toFixed(1) };

    const nb = northBearing(doc);
    if (nb && nb.count >= 2 && nb.worstDeg < 4) {
      const arrow = ((Math.atan2(nb.nx, nb.ny) * 180) / Math.PI + 360) % 360;
      let dd = (rec.transform.pageUpBearingDeg - ((360 - arrow) % 360)) % 360;
      if (dd > 180) dd -= 360; if (dd < -180) dd += 360;
      rec.northArrow = { instances: nb.count, deltaDeg: +dd.toFixed(2) };
    }

    if (source === 'text' && rec.cadRefs) {
      const miss = rec.osmRefs.filter((r) => !rec.cadRefs.includes(r));
      const extra = rec.cadRefs.filter((r) => !rec.osmRefs.includes(r));
      if (miss.length || extra.length) rec.refMismatch = { osmOnly: miss, cadOnly: extra };
    }

    // --- gate
    const bad = [];
    if (rec.residual.determined) {
      // two correspondences determine the transform and leave nothing over, so
      // there is no residual to read: only the building can corroborate it
      if (!eb || eb.total > BUILDING_CORROBORATE) bad.push('exactly determined (one platform) and not corroborated by the station building');
    } else {
      if (best.r.rms > RMS_ACCEPT) bad.push(`RMS ${best.r.rms.toFixed(1)} m over ${RMS_ACCEPT} m`);
      if (best.r.worst > WORST_ACCEPT) bad.push(`worst ${best.r.worst.toFixed(1)} m over ${WORST_ACCEPT} m`);
    }
    if (ambiguous) bad.push(`ambiguous: a second placement fits within ${ratio === null ? '1' : ratio.toFixed(2)}x and nothing independent separates them`);
    // The north point is reported, never gated on. The block is only found on
    // 3 of 273 sheets, and where it is found it is drawn to about +/-15 deg --
    // at Allawah the platforms fix the rotation to 0.8 m RMS with the runner-up
    // 24x worse, and the needle still reads 16 deg off. It is decoration.
    // The drawn platform must be the length OSM says it is. This is the one
    // check that is independent of the fit: the scale comes out of the
    // least-squares solve, and if the lettering the fit leaned on were the
    // wrong lettering, the implied length would not match.
    for (const c of rec.correspondences) {
      if (c.lengthRatio < 0.85 || c.lengthRatio > 1.18) {
        bad.push(`platform ${c.refs.join('/')} comes out ${Math.round(c.lengthRatio * 100)}% of its OSM length`);
      }
    }
    if (rec.offSheetM > 60) bad.push(`a platform the fit did not use lands ${rec.offSheetM} m off the sheet`);
    // Arrangement matching has no identity to check itself against, so it is
    // held to every platform being accounted for. Lidcombe is why: two of its
    // three platforms matched at 3.1 m RMS on a reading that was one band out,
    // and the drawn platforms and the fitted rectangles visibly diverge.
    if (source === 'outline' && rec.matchedSlabs < rec.osmSlabs) {
      bad.push(`arrangement matched only ${rec.matchedSlabs} of ${rec.osmSlabs} platforms, which leaves the reading unchecked`);
    }
    if (rec.mirrorSuspect) bad.push(`only fits as a mirror image (${rec.mirroredAlternativeRmsM} m against ${best.r.rms.toFixed(1)} m), which a plan cannot be`);
    if (rec.refMismatch && rec.refMismatch.osmOnly.length && rec.matchedSlabs < 2) bad.push('platform numbering disagrees between CAD and OSM');

    rec.accept = bad.length === 0;
    rec.reason = bad.length ? bad.join('; ') : null;
    // Confidence is about how much the fit had left over to check itself with,
    // not only how small the residual came out.
    rec.confidence = !rec.accept ? 'rejected'
      : rec.residual.determined ? 'determined'
      : (best.r.rms <= 2.5 && rec.nPoints >= 4 && (rec.ambiguityRatio ?? 99) >= 3) ? 'high'
      : best.r.rms <= RMS_HIGH ? 'good' : 'fair';
    records.push(rec);
  }

  records.sort((a, b) => a.slug.localeCompare(b.slug));
  const payload = {
    generated: new Date().toISOString(),
    frame: 'world = A * p + t, with p the CAD page point in PDF points, x right and y UP from the MediaBox bottom-left; world x east, z south (metres). Everything scripts/stationcad.py writes -- texts and paths alike -- is already in that page space; no flip is needed anywhere.',
    gates: { RMS_HIGH, RMS_ACCEPT, WORST_ACCEPT, AMBIGUITY_MIN, BUILDING_DECIDES, BUILDING_CORROBORATE, SCALE_RANGE },
    counts: { total: records.length, accepted: records.filter((r) => r.accept).length, rejected: records.filter((r) => !r.accept).length },
    stations: records,
  };
  if (only && fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const merged = [...prev.stations.filter((r) => r.slug !== only), ...records].sort((a, b) => a.slug.localeCompare(b.slug));
    prev.stations = merged; prev.generated = payload.generated;
    prev.counts = { total: merged.length, accepted: merged.filter((r) => r.accept).length, rejected: merged.filter((r) => !r.accept).length };
    fs.writeFileSync(OUT, JSON.stringify(prev, null, 1));
    console.log(JSON.stringify(prev.counts));
  } else {
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
    console.log(JSON.stringify(payload.counts));
  }
}

main();
