"""Global constants for the Sydney asset pipeline.

Everything spatial in this project passes through here. Two rules from the spec
that this module exists to enforce:

  * Work in MGA2020 Zone 56 (EPSG:7856), never raw lat/lng past the ingest
    boundary -- float32 precision in the engine will fail on 6-digit eastings.
  * Origin-shift into a local ENU frame centred on the CBD before anything is
    written to a tile.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# --- Coordinate reference systems -------------------------------------------

CRS_GEODETIC = "EPSG:4326"  # source data (Microsoft footprints, OSM)
CRS_PROJECTED = "EPSG:7856"  # MGA2020 Zone 56 -- metres, correct for Sydney

# The local ENU origin. Sydney CBD, near Town Hall. Every runtime coordinate is
# metres from this point, which keeps the whole playable world inside +/-40 km
# and therefore comfortably inside float32 precision.
ORIGIN_LAT = -33.8688
ORIGIN_LON = 151.2093

# Solar position needs the true geographic location, not the ENU origin, though
# at this scale they are the same thing. Kept separate so the intent is clear.
SUN_LAT = -33.87
SUN_LON = 151.21
TIMEZONE = "Australia/Sydney"

# --- World layout ------------------------------------------------------------

# Tile edge in metres. 500 m gives ~3,600 tiles over a 30 km square, which is a
# tractable number of files while keeping each tile's payload small enough that
# a single stall never costs more than a fraction of a second of streaming.
TILE_SIZE = 500.0

# Terrain posts per tile edge: 16 quads, 17 posts, 31.25 m apart. Both numbers
# are load-bearing and both are exact in binary, which is what makes two tiles'
# shared edge posts land on identical coordinates rather than nearly-identical
# ones -- see `terrain.py`.
#
# 31.25 m against a DEM smoothed at 45 m is a little finer than the source can
# actually resolve, which is the right side to err on: the grid costs 640
# triangles a tile and a coarser one would start cutting corners off real
# landforms. It is the same number in `terrain.py`, `tiles.py`'s sidecar and the
# client's `terrain.ts`, and it travels in `index.json` so the client reads it
# rather than repeating it.
TERRAIN_GRID = 16

# Runtime axis convention, stated once so nothing has to guess:
#   world X = +east, world Y = +up, world Z = +south (i.e. -north)
# This is Three.js' right-handed Y-up frame with north pointing at -Z.


@dataclass(frozen=True)
class Stage:
    """One step of the outward build from the CBD (spec section 3.3)."""

    index: int
    name: str
    radius_m: float
    description: str


# Build outward in this order. Ship at stage 2; the tile format must allow
# adding stage 3 later without rebuilding what already exists.
STAGES: tuple[Stage, ...] = (
    # 5,300 rather than the original 4,000: the user's spawn point is Sydney
    # Park (5,064 m from origin at the pin) and the whole park plus a 100 m
    # dither disc and a working margin must be playable tiles, not far scenery.
    Stage(1, "inner", 5_300, "Sydney LGA + inner ring, out to Sydney Park"),
    Stage(2, "middle", 15_000, "Marrickville, Bondi, Balmain, Randwick, North Sydney, Chatswood"),
    Stage(3, "outer", 35_000, "Parramatta, Bankstown, Hornsby, Sutherland, Manly"),
    Stage(4, "horizon", 60_000, "terrain and coastline only, buildings optional"),
)

STAGE_BY_NAME = {s.name: s for s in STAGES}

# --- Paths -------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]

# Working data lives outside the client so a wipe never touches source. All of
# it is disposable and regenerable; none of it is committed.
DATA_ROOT = Path(os.environ.get("SYDNEY_DATA_ROOT", REPO_ROOT / "data"))
CACHE_DIR = DATA_ROOT / "cache"  # downloaded source data, kept
SCRATCH_DIR = DATA_ROOT / "scratch"  # LAZ tiles etc, deleted after extraction
LEDGER_PATH = DATA_ROOT / "ledger.sqlite"

# Pipeline output, served statically to the client.
OUT_ROOT = REPO_ROOT / "client" / "public" / "world"
TILE_DIR = OUT_ROOT / "tiles"
INDEX_PATH = OUT_ROOT / "index.json"
COLLISION_DIR = OUT_ROOT / "collision"

# --- Disk discipline ---------------------------------------------------------

# The spec caps the working set at ~15 GB and says to enforce it in code rather
# than by convention. The scratch reaper (sydney.disk) checks against this.
SCRATCH_BUDGET_BYTES = 15 * 1024**3


def ensure_dirs() -> None:
    """Create every directory the pipeline writes into."""
    for d in (CACHE_DIR, SCRATCH_DIR, TILE_DIR, COLLISION_DIR):
        d.mkdir(parents=True, exist_ok=True)
