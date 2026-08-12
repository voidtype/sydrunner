#!/usr/bin/env python3
"""Cache the OSM building footprints that sit on a station plot.

The second, independent anchor. Platform rectangles fix the corridor and the
along-track position; the station building fixes the plot. Where the two
disagree, that disagreement is the error estimate.

Read-only with respect to the pipeline: it imports the pipeline's own OSM
reader rather than reimplementing the projection, and writes only under
data/scratch/stationcad/.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

OUT = ROOT / "data" / "scratch" / "stationcad" / "buildings.json"
RAIL = ROOT / "data" / "scratch" / "rail" / "rail.json"

STATIONISH = {"train_station", "station", "transportation", "public_transport"}


def main():
    if OUT.exists():
        print(f"{OUT} exists, nothing to do")
        return
    from sydney.sources import osm as osm_src
    from sydney import geo

    rail = json.loads(RAIL.read_text())
    sites = [(s["name"], s.get("siteX", s["x"]), s.get("siteZ", s["z"])) for s in rail["stations"]]

    print("reading OSM buildings (60 km) ...", flush=True)
    bl = osm_src.read_buildings(60000.0)
    print(f"  {len(bl)} buildings", flush=True)

    out = {}
    for b in bl:
        ex, nn = b.centroid
        wx, wz = float(ex), float(-nn)
        stationish = (b.building in STATIONISH) or (b.name and "station" in b.name.lower())
        best = None
        for name, sx, sz in sites:
            d = ((wx - sx) ** 2 + (wz - sz) ** 2) ** 0.5
            if best is None or d < best[1]:
                best = (name, d)
        if best is None:
            continue
        name, d = best
        if not (d < 90.0 or (stationish and d < 300.0)):
            continue
        ring = [[float(x), float(-y)] for x, y in b.ring]      # ENU -> world (x, z)
        out.setdefault(name, []).append({
            "osmId": b.osm_id, "building": b.building, "name": b.name,
            "area": round(b.area, 1), "dist": round(d, 1),
            "stationish": bool(stationish),
            "ring": [[round(x, 2), round(z, 2)] for x, z in ring],
        })
    OUT.write_text(json.dumps(out))
    print(f"wrote {OUT}: {len(out)} stations, {sum(len(v) for v in out.values())} footprints")


if __name__ == "__main__":
    main()
