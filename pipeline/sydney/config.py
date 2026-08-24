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
# metres from this point.
#
# This used to say the origin-shift "keeps the whole playable world inside
# +/-40 km". At the final 60 km radius it does not: the terrain lattice reaches
# +/-60,500 m and the far-ground sheet is drawn to its corners, 85.6 km out. The
# claim the number was standing in for still holds, so state that instead --
# a float32's ulp at 60,500 m is 60_500 * 2**-23 ~= 7.2 mm, against 4.8 mm at
# 40 km. Both are an order of magnitude under anything the renderer resolves,
# and the ratio is linear, so there is no radius inside this project's reach
# where the shift stops being enough.
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
#
# --- THE LADDER TERMINATED AT STAGE 2, AND THAT IS WHY 3 AND 4 READ ODDLY -----
#
# `middle` is now 60,000: the final radius. It therefore passed `outer` (35,000)
# and caught `horizon` (60,000), and a ladder whose second rung is above its
# third is worth explaining rather than quietly re-sorting.
#
# **Nothing reads `outer` or `horizon`.** That was checked before they were
# touched, and it is the fact that makes this a naming problem rather than a
# behavioural one. Across the whole pipeline the only consumers of this tuple
# are `STAGE_BY_NAME` (the `--stage` choices, and `cli.build` taking the named
# stage's `radius_m`) and one default in `cli.clearance_audit`, which falls back
# to `STAGES[1]` -- `middle` -- when neither `--radius` nor the index supplies
# one. Grep confirms 35_000 and this 60_000 appear nowhere else in
# `pipeline/sydney/`. So they were never gates; they were a plan.
#
# The things one might reasonably assume they gate are all governed elsewhere,
# and none of them moved with this build:
#
#   * far-slab carry distance -- `cli.FAR_CUT_M`, 20 km, frozen, and mirrored in
#     the hex contract as `far_cut_m`. A policy cut, not a physical one: it is
#     what stops a 60 km build holding ~20 MB of Penrith rooflines for the
#     session. See `client/src/world/far.ts`.
#   * far-terrain extent -- derived, not declared. `Terrain.load` sets
#     `reach = (ceil(radius_m / TILE_SIZE) + 1) * TERRAIN_GRID`, so the sheet's
#     half-extent follows the built radius on its own: 20,000 m at 19.3 km,
#     60,500 m here. Nothing had to be widened by hand.
#   * the sky ring -- there is no such thing; the horizon is `far-terrain.bin`
#     plus `far-water.bin` plus fog, which `main.ts` closes at 9 km.
#
# They are kept rather than deleted because `--stage` is a CLI contract and
# because the spec's four names are how section 3.3 is discussed. They are set
# to the final radius because the alternative -- pushing them outward
# proportionally, to 108 km and 186 km -- would be inventing rings that cannot
# be built: the OSM extract is clipped at 60 km, `scripts/expand-world.sh`
# refuses anything above 60,000, and the user has called the radius final. A
# number no build can reach is worse than a number that repeats one.
STAGES: tuple[Stage, ...] = (
    # 5,300 rather than the original 4,000: the user's spawn point is Sydney
    # Park (5,064 m from origin at the pin) and the whole park plus a 100 m
    # dither disc and a working margin must be playable tiles, not far scenery.
    Stage(1, "inner", 5_300, "Sydney LGA + inner ring, out to Sydney Park"),
    # The full-detail world, and now the whole of it. This rung has been 15,300
    # ("another 10 km in each direction" from the inner ring), then 19,300, and
    # is now 60,000 -- Town Hall to Penrith, which is the radius the user has
    # called final. Everything inside it is built to the same detail; there is
    # no reduced-quality outer band, which is what collapsed stages 3 and 4 into
    # this one. `scripts/expand-world.sh` rewrites this number in place, so edit
    # it there rather than here.
    Stage(2, "middle", 60_000, "the built world: Penrith to the coast, Hornsby to Sutherland"),
    # Reached by stage 2 rather than built separately -- see the note above.
    Stage(3, "outer", 60_000, "Parramatta, Bankstown, Hornsby, Sutherland, Manly -- inside stage 2"),
    Stage(4, "horizon", 60_000, "the extract's own edge; stage 2 builds it at full detail"),
)

STAGE_BY_NAME = {s.name: s for s in STAGES}

# --- Paths -------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]

# Working data lives outside the client so a wipe never touches source. All of
# it is disposable and regenerable; none of it is committed.
DATA_ROOT = Path(os.environ.get("SYDNEY_DATA_ROOT", REPO_ROOT / "data"))
CACHE_DIR = DATA_ROOT / "cache"  # downloaded source data, kept
SCRATCH_DIR = DATA_ROOT / "scratch"  # LAZ tiles etc, deleted after extraction
LEDGER_PATH = Path(os.environ.get("SYDNEY_LEDGER", str(DATA_ROOT / "ledger.sqlite")))

# Pipeline output, served statically to the client. `SYDNEY_WORLD_OUT` redirects
# it -- for an isolated or experimental build that must not touch the world the
# client is served from (the byte-for-byte A/B that proves a parallel emit is
# identical to a serial one, say). Mirrors SYDNEY_DATA_ROOT above; defaults to
# the real path so a normal build is unchanged.
OUT_ROOT = Path(os.environ.get("SYDNEY_WORLD_OUT", str(REPO_ROOT / "client" / "public" / "world")))
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
