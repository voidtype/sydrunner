#!/usr/bin/env python3
"""Draw the fitted OSM platform rectangles back onto the CAD sheet.

The residual is a number; this is the picture. A fit is only believable when
the OSM rectangles sit on the drawn platforms.
"""
from __future__ import annotations
import json, sys, subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import render, load

ROOT = Path(__file__).resolve().parents[2]
CAD = ROOT / "data" / "scratch" / "stationcad"
RAIL = ROOT / "data" / "scratch" / "rail" / "rail.json"


def inv(A, t):
    (a, b), (c, d) = A
    det = a * d - b * c
    Ai = [[d / det, -b / det], [-c / det, a / det]]
    ti = [-(Ai[0][0] * t[0] + Ai[0][1] * t[1]), -(Ai[1][0] * t[0] + Ai[1][1] * t[1])]
    return Ai, ti


def main(slug, out):
    fit = json.loads((CAD / "fit.json").read_text())
    rec = next(r for r in fit["stations"] if r["slug"] == slug)
    A, t = rec["transform"]["a"], rec["transform"]["t"]
    Ai, ti = inv(A, t)
    W = lambda p: (Ai[0][0] * p[0] + Ai[0][1] * p[1] + ti[0], Ai[1][0] * p[0] + Ai[1][1] * p[1] + ti[1])

    rail = json.loads(RAIL.read_text())
    st = next(s for s in rail["stations"] if s["name"] == rec["station"])
    polys = []
    for f in st.get("faces", []):
        ux, uz, hl, hw = f["ux"], f["uz"], f["halfLength"], f["halfWidth"]
        corners = []
        for sa, sp in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x = f["x"] + ux * sa * hl - uz * sp * hw
            z = f["z"] + uz * sa * hl + ux * sp * hw
            corners.append(W((x, z)))
        polys.append(corners)
    marks = []
    bl = CAD / "buildings.json"
    if bl.exists():
        b = json.loads(bl.read_text()).get(rec["station"], [])
        for poly in b[:12]:
            ring = [W(p) for p in poly["ring"]]
            polys.append(ring)
    d = load(slug)
    xs = [q[0] for p in d["paths"] for q in p["points"]]
    ys = [q[1] for p in d["paths"] for q in p["points"]]
    box = (min(xs), min(ys), max(xs), max(ys))
    render(slug, out, box=box, px=2400,
           overlay=[(polys[:len(st.get('faces', []))], (220, 0, 0)), (polys[len(st.get('faces', [])):], (0, 80, 220))],
           marks=marks)
    print(out, "rms", rec["residual"]["rmsM"], "scale", rec["transform"]["scaleMPerPt"])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
