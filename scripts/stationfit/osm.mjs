// The OSM side: station platform faces from the rail bake, grouped into slabs.
import fs from 'node:fs';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ALIAS = new Map(Object.entries({
  'mt-colah': 'mount-colah',
  'mt-druitt': 'mount-druitt',
  'mt-kuring-gai': 'mount-kuring-gai',
  'blacktown-platforms-1-2': 'blacktown',
  'blacktown-platforms-3-7': 'blacktown',
}));

export function loadStations(path = 'data/scratch/rail/rail.json') {
  const rail = JSON.parse(fs.readFileSync(path, 'utf8'));
  const by = new Map();
  for (const s of rail.stations) by.set(slugify(s.name.replace(/ Station$/i, '')), s);
  return { rail, by };
}

export function stationFor(by, slug) {
  return by.get(slug) ?? by.get(ALIAS.get(slug) ?? '') ?? null;
}

// Two OSM polygons that overlap across the track and run parallel are the same
// physical slab -- an island mapped once per platform number, which OSM does
// inconsistently (at Allawah the two halves of each island overlap by metres).
// Fitting to face centres would then be fitting to a mapping artefact, so the
// faces are merged into slabs first and the slab is what carries geometry.
export function slabsOf(st) {
  const faces = (st.faces || []).filter((f) => f.halfLength > 5);
  const used = new Array(faces.length).fill(false);
  const slabs = [];
  for (let i = 0; i < faces.length; i++) {
    if (used[i]) continue;
    const group = [i]; used[i] = true;
    for (let j = i + 1; j < faces.length; j++) {
      if (used[j]) continue;
      const a = faces[i], b = faces[j];
      if (Math.abs(a.ux * b.ux + a.uz * b.uz) < 0.985) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const perp = Math.abs(-dx * a.uz + dz * a.ux);
      const along = Math.abs(dx * a.ux + dz * a.uz);
      if (perp > a.halfWidth + b.halfWidth + 1.0) continue;   // not the same slab
      if (along > Math.max(a.halfLength, b.halfLength) * 0.6) continue;
      group.push(j); used[j] = true;
    }
    const g = group.map((k) => faces[k]);
    // slab frame from the longest member
    const m = g.reduce((p, q) => (q.halfLength > p.halfLength ? q : p));
    let a0 = Infinity, a1 = -Infinity, p0 = Infinity, p1 = -Infinity;
    for (const f of g) {
      for (const sa of [-f.halfLength, f.halfLength]) {
        for (const sp of [-f.halfWidth, f.halfWidth]) {
          const x = f.x + f.ux * sa - f.uz * sp;
          const z = f.z + f.uz * sa + f.ux * sp;
          const dx = x - m.x, dz = z - m.z;
          const A = dx * m.ux + dz * m.uz, P = -dx * m.uz + dz * m.ux;
          if (A < a0) a0 = A; if (A > a1) a1 = A;
          if (P < p0) p0 = P; if (P > p1) p1 = P;
        }
      }
    }
    const ca = (a0 + a1) / 2, cp = (p0 + p1) / 2;
    slabs.push({
      refs: [...new Set(g.flatMap((f) => f.refs || []))].sort((x, y) => x - y),
      x: m.x + m.ux * ca - m.uz * cp,
      z: m.z + m.uz * ca + m.ux * cp,
      ux: m.ux, uz: m.uz,
      halfLength: (a1 - a0) / 2,
      halfWidth: (p1 - p0) / 2,
      island: g.some((f) => f.island),
      nFaces: g.length,
      osmIds: g.map((f) => f.osmId),
    });
  }
  return slabs;
}
