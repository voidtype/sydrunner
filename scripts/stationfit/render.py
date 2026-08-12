#!/usr/bin/env python3
"""Render a station CAD JSON to PNG in the page frame (PDF points, y up),
optionally with fitted OSM platform rectangles drawn back onto the page.

Verification tool: the fit is only trustworthy if the OSM rectangles land on
the CAD platforms when you look at them.
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CAD = ROOT / "data" / "scratch" / "stationcad"


def load(slug):
    # No flip: scripts/stationcad.py writes texts and paths in the same y-up
    # PDF page space. See its COORDINATE SPACE note.
    d = json.loads((CAD / f"{slug}.json").read_text())
    mb = d["source"]["media_box"]
    d["_H"], d["_W"] = mb[3] - mb[1], mb[2] - mb[0]
    return d


def render(slug, out, box=None, px=2200, overlay=None, marks=None):
    d = load(slug)
    if box is None:
        xs = [q[0] for p in d["paths"] for q in p["points"]]
        ys = [q[1] for p in d["paths"] for q in p["points"]]
        box = (min(xs), min(ys), max(xs), max(ys))
    x0, y0, x1, y1 = box
    pad = 0.02 * max(x1 - x0, y1 - y0)
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    sc = px / max(x1 - x0, 1e-6)
    W = int((x1 - x0) * sc); Hp = int((y1 - y0) * sc)
    img = Image.new("RGB", (max(W, 1), max(Hp, 1)), "white")
    dr = ImageDraw.Draw(img)
    T = lambda q: ((q[0] - x0) * sc, (y1 - q[1]) * sc)
    for p in d["paths"]:
        pts = [T(q) for q in p["points"]]
        if len(pts) >= 2:
            dr.line(pts, fill=(170, 170, 170), width=1)
    for t in d["texts"]:
        q = T((t["x"], t["y"]))
        if -50 < q[0] < W + 50 and -50 < q[1] < Hp + 50:
            dr.text((q[0], q[1]), t["text"][:22], fill=(0, 110, 0))
    for grp, col in (overlay or []):
        for poly in grp:
            pts = [T(q) for q in poly]
            dr.line(pts + [pts[0]], fill=col, width=3)
    for (q, col, lab) in (marks or []):
        p = T(q)
        dr.ellipse([p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5], outline=col, width=2)
        if lab:
            dr.text((p[0] + 7, p[1] - 6), lab, fill=col)
    img.save(out)
    return out


if __name__ == "__main__":
    slug = sys.argv[1]
    out = sys.argv[2]
    box = None
    if len(sys.argv) > 3:
        box = tuple(float(v) for v in sys.argv[3].split(","))
    print(render(slug, out, box))
