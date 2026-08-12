#!/usr/bin/env python3
"""Decode data/scratch/rail/rail.bin the way client/src/game/rail.ts does.

One definition, many readers: the buffer layout lives in `rail.ts`; this is the
Python reader of the same bytes, used by the Phase 0c track-centreline fit.
"""
from __future__ import annotations
import json, struct
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAIL = ROOT / "data" / "scratch" / "rail"
MAGIC = 0x4C494152
ORDER = ["vertices", "cum", "phases", "stanchions", "stanchionKinds",
         "vertexFlags", "vertexClearance"]


def _pad8(n: int) -> int:
    return (8 - (n % 8)) % 8


def load_bake(path: Path = None):
    buf = (path or (RAIL / "rail.bin")).read_bytes()
    magic, version, json_len = struct.unpack_from("<III", buf, 0)
    if magic != MAGIC:
        raise ValueError(f"rail.bin magic 0x{magic:x}")
    meta = json.loads(buf[16:16 + json_len].decode("utf-8"))
    off = 16 + json_len
    off += _pad8(off)
    arrays = {}
    for name in ORDER:
        spec = meta["buffers"][name]
        nbytes = spec["count"] * spec["itemBytes"]
        if name in ("stanchionKinds", "vertexFlags"):
            dt = np.uint8
        elif spec["itemBytes"] == 4:
            dt = np.float32
        else:
            dt = np.float64
        arrays[name] = np.frombuffer(buf, dtype=dt, count=spec["count"], offset=off)
        off += nbytes + _pad8(nbytes)
    meta["arrays"] = arrays
    return meta


def directions(bake):
    """Every (line, dir) polyline as an (N,3) xyz array plus its metadata."""
    v = bake["arrays"]["vertices"].reshape(-1, 3)
    out = []
    for ln in bake["lines"]:
        for d in ln["dirs"]:
            o, c = d["vertexOff"], d["vertexCount"]
            out.append({
                "line": ln["id"], "index": d["index"], "label": d["label"],
                "xyz": np.asarray(v[o:o + c], dtype=np.float64),
                "cum": np.asarray(bake["arrays"]["cum"][o:o + c], dtype=np.float64),
                "stops": d["stops"],
            })
    return out
