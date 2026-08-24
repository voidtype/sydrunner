"""Region bundles: the world's per-tile files, repacked so a walk costs
requests in the tens rather than the thousands.

---------------------------------------------------------------------------
THE PROBLEM IS THE REQUEST COUNT, and it is a separate problem from the byte
count that `meshpack` solves. A tile is up to **twelve** files:

    tiles/<k>.glb  .params.bin  .terr.bin  .veg.bin  .power.bin  .furn.bin
                   .pow.bin  .names.bin  .water.bin  .cars.bin  .lanes.bin
    collision/<k>.bin

and `TileStreamer` loads on an **1,800 m radius**, which is 41 tiles standing
still and a couple of hundred over a short walk. A player who crosses a
kilometre of Surry Hills makes something like 1,500 HTTP requests, every one of
them a round trip to a CDN edge, four at a time. On a good connection that is
latency the player experiences as the city arriving in a slow ripple; on a bad
one it is the dominant cost of playing at all, and it gets four times worse at
the 15 km stage.

A region is `TILES_PER_SIDE` x `TILES_PER_SIDE` tiles written as one file with
an index at the front. The client fetches it when the player comes within
trigger distance, slices the members out of the buffer and serves them to the
existing per-tile pipeline from memory. Nothing downstream of the fetch knows
regions exist -- see `client/src/world/regions.ts`, which hangs off the one
entry point in `cdn.ts` that every world asset already goes through.

---------------------------------------------------------------------------
WHY 2x2 AND NOT 4x4, which was the obvious prior. Measured against the real
inner ring with `meshpack`'s sizes:

    2x2 (1.0 km)   110 regions   p50  2.40 MB   p95  5.63 MB   max  6.92 MB
    3x3 (1.5 km)    51 regions   p50  5.40 MB   p95 11.83 MB   max 13.31 MB
    4x4 (2.0 km)    32 regions   p50  8.00 MB   p95 19.54 MB   max 21.56 MB

**jsDelivr does not serve a file over 20 MB.** 4x4 puts the densest CBD region
over that line *today*, before the 15 km stage adds anything, and a region that
404s is a square kilometre of city that only loads through the per-tile
fallback -- which works, and which is exactly the bandwidth this was meant to
remove. 3x3 clears the limit but only by a third, on a build whose CBD is
already the worst case it will ever have.

2x2 leaves the largest region in the world at a third of the limit, which is
the headroom a stage that quadruples the tile count needs. It costs requests
against 3x3 -- ~19 regions overlap the 1,800 m load disc rather than ~11 -- and
19 requests against 1,500 is not a trade worth agonising over.

---------------------------------------------------------------------------
WHAT IS IN A REGION: **every file on disk belonging to its tiles**, enumerated
by globbing rather than by a hardcoded list of extensions. That is deliberate.
Sidecars come and go with pipeline passes -- a tile loses its last tree and its
`.veg.bin` is deleted -- and a hardcoded list is a list that silently stops
bundling whatever was added last, with no symptom except the request count
creeping back up. Globbing means a region is by construction the tiles it
covers, whatever those turn out to be made of.

Collision is in here too, and it is the one member the client asks for on a
*different* radius (420 m, from `main.ts`) than the geometry. It is 12 kB a
tile against a region's megabytes, and having it already in memory when the
player walks into range is what keeps collision and geometry arriving together
-- which is the whole subject of `world/invisible-walls.ts`.

---------------------------------------------------------------------------
DUPLICATION IS ON PURPOSE. The per-tile files stay on disk exactly as they
were. The Bun server reads four of them straight off the filesystem, the origin
serves all of them, and `cdn.ts`'s per-asset fallback needs them to exist on
the CDN as well -- a region that fails must degrade to the world loading
slowly, never to the world not loading. The cost is that the published tree is
roughly twice the size of the world; with `meshpack` in front of it that is
still smaller than the tree this build replaces.

---------------------------------------------------------------------------
THE FILE FORMAT. Little-endian throughout, and read by `regions.ts`:

    u32  magic        'SYDR'
    u32  version      REGION_VERSION
    u32  entryCount
    u32  nameBytes    length of the name table
    entryCount x {
      u32 nameOffset  byte offset into the name table
      u32 dataOffset  byte offset from the start of the file
      u32 dataLength
    }
    name table        NUL-terminated UTF-8, world-relative paths, padded to 4
    payload           each member 4-byte aligned

Paths are stored **exactly as the client asks for them** -- `tiles/-5_9.glb`,
`collision/-5_9.bin` -- so the lookup is a map hit on the string the call site
already built, with no second naming convention to keep in sync. Entries are
sorted by path so a rebuild of an unchanged world produces an identical file.
"""

from __future__ import annotations

import concurrent.futures
import multiprocessing
import os
import shutil
import struct
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from . import config

#: 'SYDR', little-endian. **Must match `REGION_MAGIC` in
#: `client/src/world/regions.ts`.**
REGION_MAGIC = 0x52445953
REGION_VERSION = 1

#: Tiles per region edge. See the header for the measurement that chose 2 over
#: the 4 this started as. At `config.TILE_SIZE` = 500 m a region is 1 km square.
TILES_PER_SIDE = 2

#: How close the player has to get, in metres, before a region is fetched.
#:
#: **Not 500 m**, which was the ask, because `TileStreamer.loadRadius` is
#: 1,800 m: a region triggered at 500 m would be triggered 1,300 m *after* its
#: tiles were already being fetched one by one, and would save nothing at all.
#: The trigger has to sit *outside* the load radius, by enough lead time for the
#: bundle to land before its nearest tile is wanted.
#:
#: The lead is 400 m, which at the fastest travel in the game -- the tuned
#: e-bike, 39.4 m/s -- is **10.2 seconds**. The p95 region is 5.42 MB raw and
#: 1.73 MB over the wire once jsDelivr brotli-compresses it (measured at 3.13x
#: over the built bundles), so p95 makes its deadline on **1.4 Mbit/s** and the
#: largest region in the build on 2.2 Mbit/s.
#:
#: Both numbers are comfortably under the connection the traverse needs anyway:
#: at 39.4 m/s the player consumes 0.142 km2 a second across the 3.6 km-wide
#: load disc, and the world is 2.5 MB a square kilometre, so **2.9 Mbit/s is the
#: floor for travelling at that speed at all** -- with or without bundles. The
#: trigger only has to absorb latency and burstiness on top of that, and 10.2 s
#: is four times what it takes.
#:
#: Pushed no further because the cost of the trigger is over-fetch, and it is
#: quadratic. Measured over a fixed 1 km walk with the real load radius:
#:
#:     per-tile        613 requests   58.2 MB
#:     1,900 m          21 requests   76.9 MB    2.5 s of lead -- too tight
#:     2,000 m          22 requests   77.5 MB    5.1 s
#:     2,200 m          25 requests   87.0 MB    10.2 s  <-- this
#:     2,500 m          28 requests   99.2 MB    17.8 s
#:
#: The over-fetch is real -- 87 MB against the 58 MB the walk strictly needs --
#: but it is bytes the player is about to want if they keep moving, and against
#: the *world this replaces* it is still a reduction: the same walk cost 128 MB
#: before `meshpack`.
#:
#: `world/invisible-walls.ts` is the instrument that says whether any of this is
#: right, and `world/regions.ts` keeps a per-tile fast path inside 600 m so that
#: the ground under the player is never gated behind a bundle even when it is.
TRIGGER_M = 2200.0

#: Refuse to publish a region larger than this. jsDelivr's hard limit is 20 MB
#: and a file over it is not served at all, so this is a build failure rather
#: than a warning: a silently unfetchable region is a square kilometre of city
#: that falls back to a thousand requests, which is the exact thing this module
#: exists to prevent, and it would show up as nothing but a slow first visit.
MAX_REGION_BYTES = 16 * 1024 * 1024

REGION_DIR = config.OUT_ROOT / "regions"


@dataclass(frozen=True)
class RegionSummary:
    key: str
    bounds: tuple[float, float, float, float]
    tiles: int
    entries: int
    size: int


def region_key(tile_key: str) -> str:
    """The region a tile belongs to. Floor division, so it is right for the
    negative half of the grid -- `-1 // 2` is -1, which is the region left of
    the origin, where `int(-1 / 2)` would be 0 and would put tiles from both
    sides of Town Hall in the same file."""
    tx, tz = (int(v) for v in tile_key.split("_"))
    return f"{tx // TILES_PER_SIDE}_{tz // TILES_PER_SIDE}"


def _members(tile_key: str) -> list[tuple[str, Path]]:
    """Every file on disk belonging to one tile, as (world-relative path, file).

    Globbed rather than listed. `tiles/<k>.*` catches the sidecars that exist
    and silently skips the ones this tile has none of, which is most of them for
    most tiles, and it keeps working when a pass adds a sidecar or takes one
    away without anybody remembering to come back here.
    """
    found: list[tuple[str, Path]] = []
    for path in sorted(config.TILE_DIR.glob(f"{tile_key}.*")):
        if path.is_file():
            found.append((f"tiles/{path.name}", path))
    collision = config.COLLISION_DIR / f"{tile_key}.bin"
    if collision.is_file():
        found.append((f"collision/{tile_key}.bin", collision))
    return found


def _pack(entries: list[tuple[str, Path]]) -> bytes:
    """One region file. See the format in this module's header."""
    entries = sorted(entries, key=lambda e: e[0])

    names = bytearray()
    name_offsets: list[int] = []
    for path, _ in entries:
        name_offsets.append(len(names))
        names.extend(path.encode("utf-8"))
        names.append(0)
    while len(names) % 4:
        names.append(0)

    header = 16 + len(entries) * 12
    payload = bytearray()
    table = bytearray()
    base = header + len(names)
    for (_, source), name_offset in zip(entries, name_offsets, strict=True):
        while len(payload) % 4:
            payload.append(0)
        data = source.read_bytes()
        table.extend(struct.pack("<III", name_offset, base + len(payload), len(data)))
        payload.extend(data)

    out = bytearray()
    out.extend(struct.pack("<IIII", REGION_MAGIC, REGION_VERSION, len(entries), len(names)))
    out.extend(table)
    out.extend(names)
    out.extend(payload)
    return bytes(out)


def _pack_region(work: tuple[str, list[str], dict[str, list[float]]]) -> "RegionSummary | None":
    """Pack one region's tiles into its bundle and return its summary. Runs in a
    forked worker or inline; identical bytes either way -- it reads its members in
    the same sorted order and writes only `REGION_DIR/<key>.bin`."""
    key, tiles_sorted, bounds = work
    members: list[tuple[str, Path]] = []
    min_x = min_z = float("inf")
    max_x = max_z = float("-inf")
    for tile in tiles_sorted:
        members.extend(_members(tile))
        b = bounds[tile]
        min_x, min_z = min(min_x, b[0]), min(min_z, b[1])
        max_x, max_z = max(max_x, b[2]), max(max_z, b[3])
    if not members:
        return None
    blob = _pack(members)
    (REGION_DIR / f"{key}.bin").write_bytes(blob)
    return RegionSummary(
        key=key,
        bounds=(min_x, min_z, max_x, max_z),
        tiles=len(tiles_sorted),
        entries=len(members),
        size=len(blob),
    )


def _region_jobs(n_regions: int) -> int:
    """Workers for the region pack. `SYDNEY_REGION_JOBS` overrides; default is all
    but one core. Never more than there are regions, and 1 (serial) when there is
    nothing to gain."""
    env = os.environ.get("SYDNEY_REGION_JOBS", "")
    if env:
        return max(1, min(int(env), n_regions))
    if n_regions <= 1 or not hasattr(os, "fork"):
        return 1
    return min(max(1, (os.cpu_count() or 2) - 1), n_regions)


def emit(tile_keys: list[str], bounds_by_key: dict[str, list[float]], on_start=None, on_progress=None) -> dict:
    """Write every region for this build and return the index contract.

    The directory is wiped first. A region is named for a grid cell, not for its
    contents, so a rebuild that drops a tile would otherwise leave a region file
    on disk describing a world that no longer exists -- and unlike a stale tile,
    which the index simply stops mentioning, a stale region would still be
    fetched and would still hand out the bytes it holds.
    """
    if REGION_DIR.exists():
        shutil.rmtree(REGION_DIR)
    REGION_DIR.mkdir(parents=True, exist_ok=True)

    grouped: dict[str, list[str]] = defaultdict(list)
    for key in tile_keys:
        grouped[region_key(key)].append(key)

    # One work item per region: its member tile keys and their bounds. A region
    # reads only its own tiles' files and writes only its own bundle, so packing
    # them is independent -- the same one-per-core shape as the tile emit, and
    # byte-identical to the serial pack for the same reason. The payload is tiny
    # (keys and bounds), so there is nothing to share by fork; a plain pool does.
    work = [
        (key, sorted(grouped[key]), {t: bounds_by_key[t] for t in grouped[key]})
        for key in sorted(grouped)
    ]

    if on_start is not None:
        on_start(len(work))
    jobs = _region_jobs(len(work))
    packed: list = []
    if jobs > 1:
        ctx = multiprocessing.get_context("fork")
        with concurrent.futures.ProcessPoolExecutor(max_workers=jobs, mp_context=ctx) as pool:
            for r in concurrent.futures.as_completed(pool.submit(_pack_region, w) for w in work):
                packed.append(r.result())
                if on_progress is not None:
                    on_progress()
    else:
        for w in work:
            packed.append(_pack_region(w))
            if on_progress is not None:
                on_progress()

    summaries: list[RegionSummary] = [s for s in packed if s is not None]
    summaries.sort(key=lambda s: s.key)  # pool order is nondeterministic; the contract is not
    oversize = [
        f"{s.key} ({s.size / 1024**2:.1f} MB)" for s in summaries if s.size > MAX_REGION_BYTES
    ]

    if oversize:
        raise ValueError(
            f"{len(oversize)} region(s) over {MAX_REGION_BYTES / 1024**2:.0f} MB: "
            f"{', '.join(oversize)}. jsDelivr will not serve them and the client will "
            f"fall back to per-tile requests for that whole square. Lower "
            f"`regions.TILES_PER_SIDE`."
        )

    return {
        "version": REGION_VERSION,
        "dir": "regions",
        "tiles_per_side": TILES_PER_SIDE,
        "size_m": TILES_PER_SIDE * config.TILE_SIZE,
        "trigger_m": TRIGGER_M,
        "count": len(summaries),
        "bytes": sum(s.size for s in summaries),
        "max_bytes": max((s.size for s in summaries), default=0),
        "list": [
            {
                "key": s.key,
                "bounds": [round(v, 1) for v in s.bounds],
                "n": s.entries,
                "size": s.size,
            }
            for s in summaries
        ],
    }
