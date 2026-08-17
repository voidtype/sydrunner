#!/usr/bin/env python3
"""Map a set of retiled tiles to the hexagons that contain them.

Reads a tile-id file (one tile id per line) and each hexagon manifest
`<hexes>/<id>.json` (each manifest lists its tiles). Prints, per hexagon, how
many of the tiles it holds, and flags any tile that appears in no manifest.

Generalised from the 2026-08-17 station round (382 tiles, 36 hexagons): the
round's list was `data/scratch/station-round/station-tiles.txt` and the manifests
were `client/public/world/hexes/`, both still the defaults here. Promoted from
`data/scratch/station-round/` so the next partial retile does not rediscover it.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TILES = ROOT / "data" / "scratch" / "station-round" / "station-tiles.txt"
DEFAULT_HEXES = ROOT / "client" / "public" / "world" / "hexes"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tiles", default=str(DEFAULT_TILES),
                    help="one tile id per line (default: the station round's station-tiles.txt)")
    ap.add_argument("--hexes", default=str(DEFAULT_HEXES),
                    help="directory of hexagon manifests (default: client/public/world/hexes)")
    args = ap.parse_args()

    tiles_file = Path(args.tiles)
    hexes = Path(args.hexes)

    tile_ids = [line.strip() for line in tiles_file.read_text().splitlines() if line.strip()]
    tile_set = set(tile_ids)
    print(f"tiles to place: {len(tile_ids)} (unique: {len(tile_set)})")

    # tile id -> list of hex ids that list it (a tile could in principle be in >1)
    tile_to_hex = defaultdict(list)
    hex_counts = {}
    manifests = 0
    for manifest_path in sorted(hexes.glob("*.json")):
        try:
            manifest = json.loads(manifest_path.read_text())
        except Exception as exc:  # noqa: BLE001
            print(f"WARN: cannot parse {manifest_path.name}: {exc}", file=sys.stderr)
            continue
        manifests += 1
        hex_id = manifest.get("id", manifest_path.stem)
        keys = [t["key"] for t in manifest.get("tiles", [])]
        held = [k for k in keys if k in tile_set]
        if held:
            hex_counts[hex_id] = len(held)
        for k in held:
            tile_to_hex[k].append(hex_id)

    covered = sum(1 for k in tile_set if k in tile_to_hex)
    uncovered = sorted(k for k in tile_set if k not in tile_to_hex)

    print(f"manifests scanned: {manifests}")
    print(f"hexagons holding >=1 of the {len(tile_set)} tiles: {len(hex_counts)}")
    print(f"tiles covered: {covered}/{len(tile_set)}")
    print()
    print("hex-id  count")
    for hex_id in sorted(hex_counts, key=lambda h: (-hex_counts[h], h)):
        print(f"{hex_id:10s}  {hex_counts[hex_id]}")

    print()
    total = sum(hex_counts.values())
    print(f"sum of per-hex counts (with multiplicity): {total}")

    if uncovered:
        print()
        print(f"UNCOVERED ({len(uncovered)}):")
        for k in uncovered:
            print(f"  {k}")
        return 1
    else:
        print(f"ALL {len(tile_set)} tiles are covered by at least one hexagon manifest.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
