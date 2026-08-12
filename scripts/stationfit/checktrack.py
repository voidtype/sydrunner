#!/usr/bin/env python3
"""Draw a Phase 0c track fit back onto the sheet, and look at it.

The residual is a number. This is the picture, and Phase 0b is why there is a
rule about it: Lidcombe passed at 3.1 m RMS on a reading one platform band out
and only the overlay caught it. An unrendered accept is not an accept.

  blue   baked track centrelines from rail.bin, inverse-mapped to the page
  red    OSM platform slabs, likewise -- these must land on drawn platforms
         and must NOT land on drawn sleepers
  faint  the drawing

    python3 scripts/stationfit/checktrack.py <slug> <out.png>
    python3 scripts/stationfit/checktrack.py --contact <out.png> [slugs...]
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from railbin import load_bake, directions          # noqa: E402
import trackgeom as tg                             # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CAD = ROOT / "data" / "scratch" / "stationcad"
FIT = CAD / "trackfit.json"


def _bake():
    b = load_bake()
    return directions(b), {tg.slugify(s["name"]): s for s in b["stations"]}


def overlay(slug: str, rec: dict, dirs, stations, px=2000, crop=True):
    A = np.array(rec["transform"]["a"], float)
    t = np.array(rec["transform"]["t"], float)
    Ai = np.linalg.inv(A)
    inv = lambda q: (np.asarray(q, float) - t) @ Ai.T

    st = stations.get(slug) or stations.get(tg.ALIAS.get(slug, ""))
    centre = np.array([st["x"], st["z"]], float)
    sheet = tg.load_sheet(slug)
    ax, ticks = tg.corridor_ticks(sheet)
    bbox = tg.drawn_bbox(sheet)

    tracks = []
    for d in dirs:
        p = d["xyz"][:, [0, 2]]
        m = np.hypot(p[:, 0] - centre[0], p[:, 1] - centre[1]) < 700
        if m.sum() < 2:
            continue
        idx = np.where(m)[0]
        for run in np.split(idx, np.where(np.diff(idx) != 1)[0] + 1):
            if len(run) >= 2:
                tracks.append(inv(p[run]))
    slabs = [inv(r) for r in tg.slab_rects(tg.slabs_of(st))]

    x0, y0, x1, y1 = bbox
    if crop:
        pts = np.vstack([q for q in slabs]) if slabs else np.zeros((0, 2))
        if len(pts):
            m = 60.0 / max(1e-6, rec["transform"]["scaleMPerPt"])
            x0 = max(x0, pts[:, 0].min() - m); x1 = min(x1, pts[:, 0].max() + m)
            y0 = max(y0, pts[:, 1].min() - m); y1 = min(y1, pts[:, 1].max() + m)
    if x1 <= x0 or y1 <= y0:
        x0, y0, x1, y1 = bbox
    sc = px / (x1 - x0)
    img = Image.new("RGB", (px, max(1, int((y1 - y0) * sc))), "white")
    dr = ImageDraw.Draw(img)
    T = lambda q: ((q[0] - x0) * sc, (y1 - q[1]) * sc)
    for p in sheet["paths"]:
        q = [T(v) for v in p["points"]]
        if len(q) >= 2:
            dr.line(q, fill=(178, 178, 178), width=1)
    for q in ticks:
        a = T(q)
        dr.ellipse([a[0] - 1.2, a[1] - 1.2, a[0] + 1.2, a[1] + 1.2], fill=(255, 160, 40))
    for tr in tracks:
        q = [T(v) for v in tr]
        if len(q) >= 2:
            dr.line(q, fill=(0, 90, 230), width=3)
    for s in slabs:
        q = [T(v) for v in s]
        dr.line(q + [q[0]], fill=(220, 0, 0), width=3)
    lab = (f"{slug}  {rec.get('confidence')}  rms {rec['railFit']['rmsM']} m  "
           f"cover {rec['railFit']['coveredFrac']}  scale {rec['transform']['scaleMPerPt']}  "
           f"flip x{rec['determinacy'].get('flipMargin')}  plat {rec['platformCheck']['worstRatio']}")
    dr.rectangle([0, 0, px, 26], fill=(255, 255, 255))
    dr.text((6, 8), lab, fill=(0, 0, 0))
    return img


def main():
    args = sys.argv[1:]
    fit = json.loads(FIT.read_text())
    by = {r["slug"]: r for r in fit["stations"]}
    dirs, stations = _bake()
    if args and args[0] == "--contact":
        out = args[1]
        slugs = args[2:] or [r["slug"] for r in fit["stations"] if r["accept"]]
        cols = 3
        tile_w = 900
        tiles = []
        for s in slugs:
            im = overlay(s, by[s], dirs, stations, px=tile_w)
            h = min(im.height, 520)
            tiles.append(im.crop((0, max(0, (im.height - h) // 2), tile_w,
                                  max(0, (im.height - h) // 2) + h)))
        rows = (len(tiles) + cols - 1) // cols
        th = max(t.height for t in tiles)
        sheet = Image.new("RGB", (cols * tile_w, rows * th), "white")
        for i, t in enumerate(tiles):
            sheet.paste(t, ((i % cols) * tile_w, (i // cols) * th))
        sheet.save(out)
        print(out, len(tiles), "tiles")
        return
    slug, out = args[0], args[1]
    overlay(slug, by[slug], dirs, stations).save(out)
    r = by[slug]
    print(out, "accept", r["accept"], "|", r.get("reason"))


if __name__ == "__main__":
    main()
