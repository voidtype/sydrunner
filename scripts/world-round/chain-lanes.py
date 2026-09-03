#!/usr/bin/env python3
"""Join the chunks of every lane chain in a shipped world into one car. Lanes v2 -> v3.

`lanes.py`'s `_chunks` cuts a chain of edges longer than 800 m into routes that
share a vertex, and until lanes v3 each cut was a route end: a car pulled into
a bay, sat out the residency and went, while the next route's car appeared in
a bay a few metres on. `lanes._chain` now mends that at bake time. This does
the same to the world that already shipped, from the files alone, so the fix
does not wait for a retile: every `tiles/*.lanes.bin` is read, every route end
is filed by its world position, the pairs that meet exactly are joined into
chains, and every file is rewritten as v3 -- the links of a chain sharing the
head's rid, the chain's longest headway, a phase that is the head's plus the
durations before, joint flags on the shared ends, and the head's centre as
the crowd's one sample point.

Deterministic: the pairing at a shared point takes the smallest rid on each
side, so the same files give the same chains on any machine, and the client's
`decodeLanes` needs no neighbour to agree with the server. See the client's
`game/traffic.ts`, "A ROUTE IS A LINK IN A CHAIN".

    python3 scripts/world-round/chain-lanes.py --world client/public/world [--dry-run] [--snapshot DIR]

Writes every lane sidecar, then stamps `lanes.version = 3` and a fresh `built`
into index.json and root.json, so every client refetches (the tiles are
served immutable under `?v=<built>`). `--snapshot` copies the v2 files first.
"""
import argparse
import json
import math
import shutil
import struct
import sys
import time
from pathlib import Path

import numpy as np


def up32(value: float, floor: float) -> float:
    """`value` as the file will store it (f32), rounded *up* past `floor`.

    A link's phase is the head's plus the durations before it, summed in f64;
    stored to nearest in f32 it can land a hair before the car in front has
    reached the joint, and for that hair the same car is posed on both links at
    once -- a pair `integration-check` counts as two cars inside each other.
    Rounded up, the links meet with a gap of at most one f32 step, which no
    frame ever lands in.
    """
    v = np.float32(value)
    while float(v) < floor:
        v = np.nextafter(v, np.float32(np.inf))
    return float(v)

MAGIC = 0x454E414C
OLD_VERSION = 2
NEW_VERSION = 3


def read_tile(buf: bytes):
    magic, version, n_ways, n_routes = struct.unpack_from("<IIII", buf, 0)
    if magic != MAGIC:
        raise ValueError("bad magic")
    o = 16
    ways = []
    for _ in range(n_ways):
        hdr = buf[o : o + 16]
        _, _, _, n, _, _ = struct.unpack_from("<IBBHff", buf, o)
        o += 16
        pts = buf[o : o + n * 12]
        o += n * 12
        ways.append((hdr, pts))
    routes = []
    for _ in range(n_routes):
        rid, klass, flags, n, headway, phase = struct.unpack_from("<IBBHff", buf, o)
        o += 16
        park = buf[o : o + 24]
        o += 24
        chain = None
        if version >= 3:
            chain = struct.unpack_from("<fff", buf, o)
            o += 12
        rec = struct.unpack_from("<" + "ffff" * n, buf, o)
        o += n * 16
        pts = [(rec[i * 4], rec[i * 4 + 1], rec[i * 4 + 2], rec[i * 4 + 3]) for i in range(n)]
        routes.append({"rid": rid, "klass": klass, "flags": flags, "n": n, "headway": headway,
                       "phase": phase, "park": park, "chain": chain, "pts": pts})
    if o != len(buf):
        raise ValueError(f"{len(buf) - o} trailing bytes")
    return version, ways, routes


def write_tile(ways, routes) -> bytes:
    out = bytearray(struct.pack("<IIII", MAGIC, NEW_VERSION, len(ways), len(routes)))
    for hdr, pts in ways:
        out += hdr
        out += pts
    for r in routes:
        out += struct.pack("<IBBHff", r["rid"], r["klass"], r["flags"], r["n"], r["headway"], r["phase"])
        out += r["park"]
        out += struct.pack("<fff", r["chain"][0], r["chain"][1], r["chain"][2])
        for x, y, z, t in r["pts"]:
            out += struct.pack("<ffff", x, y, z, t)
    return bytes(out)


def key_of(x: float, z: float) -> tuple[int, int]:
    return (round(x * 100), round(z * 100))


def continues(a, b) -> bool:
    if a["klass"] != b["klass"]:
        return False
    ax = a["wpts"][-1][0] - a["wpts"][-2][0]
    az = a["wpts"][-1][1] - a["wpts"][-2][1]
    bx = b["wpts"][1][0] - b["wpts"][0][0]
    bz = b["wpts"][1][1] - b["wpts"][0][1]
    la = math.hypot(ax, az)
    lb = math.hypot(bx, bz)
    if la < 1e-6 or lb < 1e-6:
        return True
    return (ax * bx + az * bz) / (la * lb) > 0.2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default="client/public/world")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--snapshot", default="")
    args = ap.parse_args()
    world = Path(args.world)
    index = json.loads((world / "index.json").read_text())
    tile_size = float(index["tile_size"])
    bounds = {t["key"]: t["bounds"] for t in index["tiles"]}
    tiles = {}
    n_v3 = 0
    for path in sorted((world / "tiles").glob("*.lanes.bin")):
        key = path.name[: -len(".lanes.bin")]
        b = bounds.get(key)
        if b is None:
            print(f"no index entry for {key}", file=sys.stderr)
            continue
        version, ways, routes = read_tile(path.read_bytes())
        if version >= 3:
            n_v3 += 1
        ox, oz = b[0], b[1] + tile_size
        for r in routes:
            r["wpts"] = [(x + ox, z + oz) for x, _, z, _ in r["pts"]]
            r["origin"] = (ox, oz)
            r["duration"] = r["pts"][-1][3]
            r["key"] = key
            # The longest stationary run: a red light is the same vertex
            # twice with time between. Measured the way the client measures it.
            longest = 0.0
            start = 0
            pts = r["pts"]
            for i in range(1, len(pts)):
                dx = pts[i][0] - pts[start][0]
                dz = pts[i][2] - pts[start][2]
                if dx * dx + dz * dz > 0.25 * 0.25:
                    start = i
                    continue
                longest = max(longest, pts[i][3] - pts[start][3])
            r["longest"] = longest
        tiles[key] = (path, ways, routes)
    all_routes = [r for _, _, routes in tiles.values() for r in routes]
    print(f"{len(tiles)} lane tiles, {len(all_routes)} routes, {n_v3} already v3")

    # --- File the ends, pair them, chain them.
    starts: dict[tuple[int, int], list] = {}
    ends: dict[tuple[int, int], list] = {}
    for r in all_routes:
        r["prev"] = None
        r["next"] = None
        starts.setdefault(key_of(*r["wpts"][0]), []).append(r)
        ends.setdefault(key_of(*r["wpts"][-1]), []).append(r)
    pairs = 0
    for k, enders in ends.items():
        starters = starts.get(k)
        if not starters:
            continue
        enders = sorted(enders, key=lambda r: (r["rid"], r["key"]))
        starters = sorted(starters, key=lambda r: (r["rid"], r["key"]))
        for a in enders:
            if a["next"] is not None:
                continue
            for b in starters:
                if b["prev"] is not None or b is a or not continues(a, b):
                    continue
                # never a loop
                h = a
                loop = False
                while h["prev"] is not None:
                    h = h["prev"]
                    if h is b:
                        loop = True
                        break
                if loop:
                    continue
                a["next"] = b
                b["prev"] = a
                pairs += 1
                break
    chains = 0
    links = 0
    longest = 0
    for r in all_routes:
        if r["prev"] is not None:
            continue
        run = []
        q = r
        while q is not None:
            run.append(q)
            q = q["next"]
        # every route, chained or not, gets its chain point
        if len(run) == 1:
            cx = sum(p[0] for p in r["wpts"]) / len(r["wpts"])
            cz = sum(p[1] for p in r["wpts"]) / len(r["wpts"])
            r["chain"] = (cx - r["origin"][0], cz - r["origin"][1], 0.0)
            r["flags"] &= 3
            continue
        chains += 1
        links += len(run)
        longest = max(longest, len(run))
        head = run[0]
        headway = max(q["headway"] for q in run)
        dwell = max(q["longest"] for q in run)
        cx = sum(p[0] for p in head["wpts"]) / len(head["wpts"])
        cz = sum(p[1] for p in head["wpts"]) / len(head["wpts"])
        phase = head["phase"]
        for i, q in enumerate(run):
            q["rid"] = head["rid"]
            q["headway"] = headway
            q["phase"] = up32(phase, phase)
            flags = q["flags"] & 3
            if i > 0:
                flags = (flags & ~1) | 4
            if i < len(run) - 1:
                flags = (flags & ~2) | 8
            q["flags"] = flags
            q["chain"] = (cx - q["origin"][0], cz - q["origin"][1], dwell)
            phase = q["phase"] + q["duration"]
    print(f"{pairs} joints, {chains} chains of {links} links (longest {longest}); "
          f"{len(all_routes) - links} routes stand alone")
    if args.dry_run:
        return 0

    if args.snapshot:
        snap = Path(args.snapshot)
        snap.mkdir(parents=True, exist_ok=True)
        for path, _, _ in tiles.values():
            shutil.copy2(path, snap / path.name)
        shutil.copy2(world / "index.json", snap / "index.json")
        if (world / "root.json").exists():
            shutil.copy2(world / "root.json", snap / "root.json")
        print(f"snapshot of {len(tiles)} files in {snap}")
    written = 0
    for path, ways, routes in tiles.values():
        path.write_bytes(write_tile(ways, routes))
        written += 1
    built = int(time.time())
    index["built"] = built
    index.setdefault("lanes", {})["version"] = NEW_VERSION
    (world / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    root_path = world / "root.json"
    if root_path.exists():
        root = json.loads(root_path.read_text())
        root["built"] = built
        root_path.write_text(json.dumps(root, separators=(",", ":")))
    print(f"wrote {written} lane tiles as v3; built {built}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
