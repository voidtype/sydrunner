"""Cache the solved terrain, keyed on everything it is a function of.

WHY THIS EXISTS. `Terrain.load` is the head of every build. It samples the DEM,
then `roadgrade.solve`/`conform`, `water.conform` and `pads.conform` pull the
~3.7M-post lattice onto the road network, cut the harbour bed and level the
stated pads -- a global solve that takes the better part of three hours and
peaks near a 16 GB machine's ceiling. It is
recomputed from scratch on every build, and yet the solved lattice is a **pure
function** of the DEM, the OSM extract and the code that solves them -- none of
which a vegetation, deck, fence, furniture or overpass round touches. The
bushland retile spent three of its eight hours rebuilding a lattice that came
out bit-identical to the one already on disk (verified 236/236 tiles). This
gives that time back.

WHAT IS CACHED. The whole solved `Terrain` object -- conformed heights, the road
surface and the water sheets -- pickled. Not the pre-conform heights: the
expense *is* the conform and the water pass, both of which run inside
`Terrain.load`, and the object `tiles.build_tile` later reads for its water
sheets is the post-solve one. A numpy/shapely pickle round-trip is exact, so a
warm build's `Terrain` is bit-identical to a cold one's and every tile emitted
from it is byte-identical -- which is the gate this change lives or dies by.

THE KEY, AND WHY IT IS PARANOID. The key hashes exactly the inputs the solved
lattice depends on:

  * the load arguments (`radius_m`, `zoom`, the three conform flags);
  * the OSM extract, by full content hash -- a re-pull changes the roads and the
    water and must miss;
  * the DEM tiles for this zoom, by a (name, size, mtime) signature -- terrarium
    PNGs are immutable once fetched, so this is a sufficient and cheap proxy;
  * the **source of every module that shapes the lattice** -- `terrain`,
    `roadgrade`, `water`, `pads`, `landmarks`, `rail`, `geo`, `config`, and the
    OSM reader -- so that a changed constant or a changed algorithm invalidates
    the cache even though no data moved. The last three are the third conform
    pass's price and `_CODE_FILES` argues for paying it.

The bias is absolute: over-invalidation costs one recompute; a stale hit would
silently ship a world built on the wrong ground and corrupt every round after
it. So the code hash is coarse on purpose (a comment change busts it), the
unpickle is guarded (any failure falls back to a fresh solve), and
`--no-terrain-cache` / `SYDNEY_NO_TERRAIN_CACHE` force a recompute. A hit or a
recompute is always printed, so a build's provenance is never a guess.
"""

from __future__ import annotations

import hashlib
import os
import pickle
import time

from . import config
from .terrain import TERRARIUM_ZOOM, Terrain

# The modules whose code decides what the lattice is. Hashing their source is how
# a changed constant or algorithm invalidates a cache that no data change would.
# Paths are relative to this file's directory.
#
# `pads.py`, `landmarks.py` and `rail.py` joined the list when the third conform
# pass did, and the last two are expensive company: `rail.py` is under constant
# change and a rail-only edit that cannot move a lattice post now costs a fresh
# solve anyway. That is the bias this header already states, taken at face value
# -- `pads.py` reads a station's platform polygons out of `rail.read_rail` and a
# landmark's footprint out of `landmarks.read_anchors`, so a change to either
# reader *can* move the ground, and there is no way to hash "only the part that
# can" that does not go stale the first time somebody refactors across it. One
# recompute is the price; a stale hit is the world on the wrong ground.
#
# `bareearth.py` joined it with the fourth pass. It is the cheapest member of the
# list to hash and the most dangerous to leave out: it runs *first*, so a changed
# constant there moves the ground the road solve is then run on, and a stale hit
# would be a whole conformed lattice built on an argument that has since changed.
_CODE_FILES = (
    "terrain.py",
    "bareearth.py",
    "roadgrade.py",
    "water.py",
    "pads.py",
    "landmarks.py",
    "rail.py",
    "geo.py",
    "config.py",
    "sources/osm.py",
)

_CACHE_SUBDIR = "terrain-solve"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_hash(path: str) -> str:
    with open(path, "rb") as f:
        return _sha(f.read())


def _dem_signature(zoom: int) -> str:
    """A cheap, sufficient fingerprint of the DEM tiles for this zoom.

    Terrarium PNGs are content-addressed by (zoom, x, y) and never rewritten, so
    the set of files and their sizes is a faithful proxy for the DEM without
    reading 18 MB of PNG. mtime is folded in so a re-fetch that happened to land
    the same size still misses.
    """
    root = config.CACHE_DIR / "terrarium" / str(zoom)
    if not root.is_dir():
        return "no-dem"
    parts = []
    for name in sorted(os.listdir(root)):
        st = (root / name).stat()
        parts.append(f"{name}:{st.st_size}:{int(st.st_mtime)}")
    return _sha("\n".join(parts).encode())


def _code_signature() -> str:
    here = os.path.dirname(__file__)
    return _sha(
        b"\n".join(_file_hash(os.path.join(here, rel)).encode() for rel in _CODE_FILES)
    )


def _key(
    radius_m: float,
    zoom: int,
    conform_roads: bool,
    conform_water: bool,
    conform_pads: bool,
    bare_earth: bool,
) -> str:
    pbf = config.CACHE_DIR / "sydney.osm.pbf"
    pbf_hash = _file_hash(str(pbf)) if pbf.exists() else "no-pbf"
    payload = "|".join(
        [
            "v1",
            f"radius={radius_m:.3f}",
            f"zoom={zoom}",
            f"roads={int(conform_roads)}",
            f"water={int(conform_water)}",
            f"pads={int(conform_pads)}",
            f"bare={int(bare_earth)}",
            f"pbf={pbf_hash}",
            f"dem={_dem_signature(zoom)}",
            f"code={_code_signature()}",
        ]
    )
    return _sha(payload.encode())


def _disabled() -> bool:
    return os.environ.get("SYDNEY_NO_TERRAIN_CACHE", "") not in ("", "0")


def load(
    radius_m: float,
    zoom: int = TERRARIUM_ZOOM,
    conform_roads: bool = True,
    conform_water: bool = True,
    conform_pads: bool = True,
    bare_earth: bool = True,
    use_cache: bool = True,
) -> Terrain:
    """`Terrain.load` with a solved-lattice cache in front of it.

    A drop-in for `Terrain.load(radius_m, ...)`. On a key hit it unpickles the
    solved `Terrain` in seconds; on a miss, a disabled cache, or any unpickle
    failure it solves fresh and writes the cache. Always prints which happened.
    """
    if not use_cache or _disabled():
        print("  terrain cache: off, solving fresh")
        return Terrain.load(
            radius_m, zoom, conform_roads, conform_water, conform_pads, bare_earth
        )

    key = _key(radius_m, zoom, conform_roads, conform_water, conform_pads, bare_earth)
    cache_dir = config.CACHE_DIR / _CACHE_SUBDIR
    path = cache_dir / f"{key}.pkl"

    if path.exists():
        try:
            t0 = time.time()
            with open(path, "rb") as f:
                terrain = pickle.load(f)
            print(f"  terrain cache: HIT {key[:12]} ({time.time() - t0:.1f}s to load)")
            return terrain
        except Exception as err:  # noqa: BLE001 -- a bad cache must never stop a build
            print(f"  terrain cache: hit {key[:12]} but unpickle failed ({err}); solving fresh")

    print(f"  terrain cache: MISS {key[:12]}, solving fresh")
    terrain = Terrain.load(
        radius_m, zoom, conform_roads, conform_water, conform_pads, bare_earth
    )
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".pkl.tmp")
        with open(tmp, "wb") as f:
            pickle.dump(terrain, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)  # atomic: a reader never sees a half-written cache
        print(f"  terrain cache: wrote {key[:12]} ({path.stat().st_size / 1e6:.0f} MB)")
    except Exception as err:  # noqa: BLE001 -- failing to cache must never fail the build
        print(f"  terrain cache: could not write {key[:12]} ({err}); build continues")
    return terrain
