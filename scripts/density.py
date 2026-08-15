#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
#     "numpy>=2.1",
#     "scipy>=1.14",
#     "shapely>=2.0",
#     "pyproj>=3.6",
# ]
# ///
"""Turn ABS resident population into the crowd field the game reads at runtime.

Standalone, idempotent, resumable, in `scripts/stationcad.py`'s mould. It talks
to nothing under `pipeline/`; it writes a cache under `data/cache/` and one
generated TypeScript module under `client/src/game/`.

    uv run scripts/density.py fetch     # ABS SA1 polygons + 2021 persons -> cache
    uv run scripts/density.py build     # rasterise, fit the curve, emit the .ts
    uv run scripts/density.py report    # the multiplier at named places
    uv run scripts/density.py all       # the three in order

`fetch` writes one JSON file per 2,000-feature page under
`data/cache/abs-sa1-pages/` and merges them into
`data/cache/abs-sa1-population.geojson` only when every page is present, so an
interrupted run resumes at the page it died on and a completed run re-does
nothing. `--force` re-fetches.

---------------------------------------------------------------------------
THE SOURCE, AND WHY THIS ONE

The player asked for "density stats from nsw govt". The NSW CKAN catalogue
(`data.nsw.gov.au`) republishes plenty of things *by* SA2 but publishes no
population-density layer of its own; what it points at, transitively, is the
ABS. So this goes to the ABS directly, and to the finest geography that ships
the count and the boundary in one queryable layer:

    geo.abs.gov.au/arcgis/rest/services/Hosted/ABS_2021_Census_G01_SA1

An ArcGIS FeatureServer, no login, no key, GeoJSON out, 12,003 SA1s inside the
Sydney box. G01 is the 2021 Census "Selected Person Characteristics" table and
`tot_p_p` is its total-persons cell. `area_albers_sqkm` travels with it, which
matters: an SA1's *density* is its count over its own area, and using the
raster cell's area instead would smear a 200-person SA1 that happens to include
half a national park across the whole park.

The alternative was the Mesh Block layer (`ASGS2021/MB`), which is finer but
ships geometry only -- the counts live in a separate spreadsheet release. An SA1
is 200-800 people, which in Redfern is a block and a half and in Dural is a
couple of square kilometres, and that is already finer than the 500 m cell this
produces.

---------------------------------------------------------------------------
RESIDENTS ARE NOT THE ONLY REASON A STREET IS BUSY, WHICH IS WHY THIS BLURS

A raw SA1 density field has holes exactly where the game most needs people:
Hyde Park has no residents, Port Botany has no residents, and the block of the
CBD that is all office towers has almost none. Read literally, that field
empties Martin Place.

So the raster is a **catchment**, not a parcel lookup: population is spread
over each SA1's polygon at 100 m, summed into 500 m cells, and then Gaussian
blurred at `BLUR_SIGMA_M`. What comes out of a cell is "how many people live
within about a kilometre of here", which is both the honest reading of a
smoothed census and the thing that actually predicts how busy a footpath is.
Hyde Park inherits Darlinghurst. Dural inherits Dural.

Road class does the rest of the work for traffic, and that half lives in
`client/src/game/density.ts` rather than here -- it is a gameplay opinion, not
a fact about the census.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import requests
import shapely
from pyproj import Transformer
from scipy.ndimage import gaussian_filter
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "data" / "cache"
PAGE_DIR = CACHE_DIR / "abs-sa1-pages"
GEOJSON_PATH = CACHE_DIR / "abs-sa1-population.geojson"
RASTER_PATH = CACHE_DIR / "abs-sa1-density-grid.npy"
TS_PATH = REPO_ROOT / "client" / "src" / "game" / "density-data.ts"

SERVICE = (
    "https://geo.abs.gov.au/arcgis/rest/services/Hosted/"
    "ABS_2021_Census_G01_SA1/FeatureServer/0/query"
)
PAGE_SIZE = 2000
USER_AGENT = (
    "sydrunner-density-builder/1.0 (mechanical data extraction; "
    "contact via github.com/voidtype)"
)

# --- The world frame. Restated from pipeline/sydney/{config,geo}.py rather than
# imported, because this script is standalone and `uv run --script` resolves its
# own deps. The three numbers below are the contract; if they ever disagree with
# the pipeline the emitted grid is offset from the city and `verifyDensity`'s
# named-place assertions in density.ts are what notice.
ORIGIN_LAT = -33.8688
ORIGIN_LON = 151.2093
CRS_PROJECTED = "EPSG:7856"  # MGA2020 Zone 56

# --- The grid. 500 m cells, matching `config.TILE_SIZE`, over a half-extent that
# clears the 60,500 m terrain lattice. 248 x 248 = 61,504 bytes, which base64s to
# 82 KB of source and gzips to a fraction of that.
CELL_M = 500.0
HALF_EXTENT_M = 62000.0
GRID = int(round(2 * HALF_EXTENT_M / CELL_M))  # 248
SUB = 5  # 100 m sub-sampling inside each cell when spreading an SA1's people

# How far a street's crowd is drawn from. See the header.
BLUR_SIGMA_M = 750.0

# The player's two numbers. The busiest place gets 1.2x today's uniform rate and
# Dural gets 0.05x of that -- a 24:1 spread. Mirrored in density.ts, which is
# where the runtime reads them; asserted equal by `verifyDensity`.
MUL_MIN = 0.05
MUL_MAX = 1.2

# Where the top of the curve is pinned, as a percentile of the populated cells.
# Not the 100th: the maximum of a smoothed census is one cell of Zetland towers,
# and pinning 1.2x to a single cell spends most of the range reaching it. See
# `fit_curve`.
PIN_HI_PCT = 99.5

# Places the report prints, in world metres (x = east of Town Hall, z = south).
# Lifted verbatim out of `game/streetlife.SUBURBS`, which projected them through
# the same origin from the same OSM extract, so a disagreement between these
# numbers and the raster is a disagreement about the world frame and not about
# the census. Dural's row is load-bearing rather than decorative -- `fit_curve`
# pins the bottom of the curve to it.
NAMED_PLACES: list[tuple[str, float, float]] = [
    ("Sydney CBD (Town Hall)", 35.7, -3.9),
    ("Haymarket", -423.9, 1409.6),
    ("Surry Hills", 97.9, 1741.3),
    ("Pyrmont", -1566.0, 73.4),
    ("Redfern", -440.5, 2703.8),
    ("Newtown", -2639.3, 3076.3),
    ("Bondi Junction", 3822.1, 2619.0),
    ("Mosman", 3165.2, -4055.6),
    ("Chatswood", -2719.4, -7946.2),
    ("Manly", 7146.6, -8064.7),
    ("Parramatta", -18749.1, -5638.4),
    ("Hornsby", -10394.0, -18092.6),
    ("Liverpool", -26125.1, 6152.3),
    ("Blacktown", -28492.8, -9980.1),
    ("Castle Hill", -19015.4, -14854.0),
    ("Penrith", -47948.9, -12089.7),
    ("Galston", -14033.1, -24254.1),
    ("Dural", -15230.7, -20051.7),
    ("Middle Dural", -18206.6, -25231.5),
    ("Glenorie", -18959.9, -29241.5),
    ("Wisemans Ferry", -21640.0, -52112.1),
]

# The place the player named as the floor. Its own row above is the anchor.
PIN_LO_PLACE = "Dural"


# --- Step 1: fetch ------------------------------------------------------------


def _bbox() -> tuple[float, float, float, float]:
    """A geodetic box that encloses the grid, generously. A filter, not a clip."""
    lat_deg = HALF_EXTENT_M / 111_320.0
    lon_deg = HALF_EXTENT_M / (111_320.0 * math.cos(math.radians(ORIGIN_LAT)))
    return (
        ORIGIN_LON - lon_deg,
        ORIGIN_LAT - lat_deg,
        ORIGIN_LON + lon_deg,
        ORIGIN_LAT + lat_deg,
    )


def _query(session: requests.Session, params: dict, timeout: int = 180) -> dict:
    """One call, with three tries. The ABS server is fine but not fast."""
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = session.get(SERVICE, params=params, timeout=timeout)
            r.raise_for_status()
            body = r.json()
            if "error" in body:
                raise RuntimeError(f"ABS returned an error: {body['error']}")
            return body
        except Exception as exc:  # noqa: BLE001 -- retried, then re-raised
            last = exc
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"three attempts failed: {last}")


def cmd_fetch(force: bool) -> None:
    if GEOJSON_PATH.exists() and not force:
        n = len(json.loads(GEOJSON_PATH.read_text())["features"])
        print(f"fetch: {GEOJSON_PATH.relative_to(REPO_ROOT)} already has {n} SA1s; skipping")
        return
    if force and PAGE_DIR.exists():
        shutil.rmtree(PAGE_DIR)
    PAGE_DIR.mkdir(parents=True, exist_ok=True)

    minx, miny, maxx, maxy = _bbox()
    spatial = {
        "geometry": f"{minx},{miny},{maxx},{maxy}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "where": "1=1",
    }
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    total = int(_query(session, {**spatial, "returnCountOnly": "true", "f": "json"})["count"])
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    print(f"fetch: {total} SA1s intersect the box, {pages} pages of {PAGE_SIZE}")

    for page in range(pages):
        out = PAGE_DIR / f"page-{page:04d}.geojson"
        if out.exists() and out.stat().st_size > 0:
            print(f"  page {page + 1}/{pages}: cached")
            continue
        body = _query(
            session,
            {
                **spatial,
                "outFields": "sa1_code_2021,sa2_name_2021,tot_p_p,area_albers_sqkm",
                "returnGeometry": "true",
                # ~50 m of simplification. An SA1 boundary follows streets and
                # creeks; this is well under the 100 m the raster samples at.
                "maxAllowableOffset": "0.0005",
                "geometryPrecision": "5",
                "outSR": "4326",
                "orderByFields": "sa1_code_2021",
                "resultOffset": str(page * PAGE_SIZE),
                "resultRecordCount": str(PAGE_SIZE),
                "f": "geojson",
            },
        )
        feats = body.get("features", [])
        if not feats:
            raise RuntimeError(f"page {page} came back empty; expected up to {PAGE_SIZE}")
        tmp = out.with_suffix(".part")
        tmp.write_text(json.dumps(body))
        tmp.rename(out)
        print(f"  page {page + 1}/{pages}: {len(feats)} SA1s, {out.stat().st_size // 1024} KB")

    merged: list[dict] = []
    for page in range(pages):
        merged.extend(json.loads((PAGE_DIR / f"page-{page:04d}.geojson").read_text())["features"])
    if len(merged) != total:
        raise RuntimeError(f"merged {len(merged)} features, the server counted {total}")
    GEOJSON_PATH.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "_source": SERVICE,
                "_fetched": time.strftime("%Y-%m-%d"),
                "_licence": "CC-BY 4.0, Australian Bureau of Statistics",
                "features": merged,
            }
        )
    )
    print(f"fetch: wrote {len(merged)} SA1s to {GEOJSON_PATH.relative_to(REPO_ROOT)}")


# --- Step 2: rasterise --------------------------------------------------------


def _to_world(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Geodetic -> renderer metres. `geo.lonlat_to_enu` then `geo.enu_to_world`."""
    fwd = Transformer.from_crs("EPSG:4326", CRS_PROJECTED, always_xy=True)
    ox, oy = fwd.transform(ORIGIN_LON, ORIGIN_LAT)
    east, north = fwd.transform(lon, lat)
    return np.asarray(east) - ox, -(np.asarray(north) - oy)


def rasterise(force: bool = False) -> np.ndarray:
    """Residents per square kilometre on the 500 m grid, catchment-smoothed.

    Cached to `.npy` beside the GeoJSON, because the point-in-polygon pass is
    the only slow step here and the curve above it wants iterating on.
    """
    if RASTER_PATH.exists() and not force:
        return np.load(RASTER_PATH)
    doc = json.loads(GEOJSON_PATH.read_text())
    feats = doc["features"]
    print(f"build: {len(feats)} SA1s")

    sub_n = GRID * SUB
    sub_cell = CELL_M / SUB
    pop = np.zeros((sub_n, sub_n), dtype=np.float64)
    # Which sub-cells are inside *any* SA1 -- i.e. which are land the census
    # counted at all. The blur below is normalised by this, and without it every
    # waterfront suburb is diluted by the harbour: a 750 m Gaussian centred on
    # Circular Quay draws half its weight from open water, and the CBD comes out
    # thinner than Newtown, which it is not.
    land = np.zeros((sub_n, sub_n), dtype=bool)

    placed = 0
    dropped_outside = 0
    tiny = 0
    for f in feats:
        persons = f["properties"].get("tot_p_p") or 0
        geom = f.get("geometry")
        if geom is None:
            continue
        poly = shape(geom)
        if poly.is_empty:
            continue
        # Project the ring coordinates once, then rebuild in world metres. The
        # transform is affine-ish at this scale but not affine, so it has to be
        # applied to the vertices rather than to the bounding box.
        poly = _project_polygon(poly)
        minx, minz, maxx, maxz = poly.bounds
        if maxx < -HALF_EXTENT_M or minx > HALF_EXTENT_M:
            dropped_outside += 1
            continue
        if maxz < -HALF_EXTENT_M or minz > HALF_EXTENT_M:
            dropped_outside += 1
            continue

        i0 = max(0, int((minx + HALF_EXTENT_M) // sub_cell))
        i1 = min(sub_n - 1, int((maxx + HALF_EXTENT_M) // sub_cell))
        k0 = max(0, int((minz + HALF_EXTENT_M) // sub_cell))
        k1 = min(sub_n - 1, int((maxz + HALF_EXTENT_M) // sub_cell))

        ix = np.arange(i0, i1 + 1)
        kz = np.arange(k0, k1 + 1)
        cx = -HALF_EXTENT_M + (ix + 0.5) * sub_cell
        cz = -HALF_EXTENT_M + (kz + 0.5) * sub_cell
        gx, gz = np.meshgrid(cx, cz, indexing="ij")
        flat_x = gx.ravel()
        flat_z = gz.ravel()

        hit = np.flatnonzero(shapely.contains_xy(poly, flat_x, flat_z))
        if hit.size == 0:
            # An SA1 smaller than 100 m across -- a CBD tower block. Put all of
            # its people in the sub-cell holding its representative point rather
            # than losing them, which is the difference between the CBD reading
            # as the densest place in the state and reading as a hole.
            rp = poly.representative_point()
            i = int((rp.x + HALF_EXTENT_M) // sub_cell)
            k = int((rp.y + HALF_EXTENT_M) // sub_cell)
            if 0 <= i < sub_n and 0 <= k < sub_n:
                pop[i, k] += persons
                land[i, k] = True
                tiny += 1
            continue
        ii = (hit // len(kz)) + i0
        kk = (hit % len(kz)) + k0
        land[ii, kk] = True
        if persons > 0:
            np.add.at(pop, (ii, kk), persons / hit.size)
            placed += 1

    print(f"build: {placed} populated SA1s rasterised, {tiny} too small to sample, "
          f"{dropped_outside} outside the grid")

    # Sub-cells -> cells.
    cells = pop.reshape(GRID, SUB, GRID, SUB).sum(axis=(1, 3))
    cover = land.reshape(GRID, SUB, GRID, SUB).sum(axis=(1, 3)) / (SUB * SUB)
    print(f"build: {cells.sum():,.0f} people over {(cover > 0).sum():,} land cells")

    # The catchment: a Gaussian over the people, divided by the same Gaussian
    # over the land, so what comes out is residents per square kilometre *of
    # land within about a kilometre* rather than per square kilometre of map.
    # Cells with essentially no land in reach -- the middle of the harbour, the
    # ocean, the corners of the square outside the census extract -- are left at
    # zero rather than divided by a rounding error.
    sigma_cells = BLUR_SIGMA_M / CELL_M
    num = gaussian_filter(cells, sigma=sigma_cells, mode="constant", cval=0.0)
    den = gaussian_filter(cover, sigma=sigma_cells, mode="constant", cval=0.0)
    out = np.zeros_like(num)
    ok = den > 0.02
    out[ok] = num[ok] / den[ok] / (CELL_M * CELL_M / 1e6)  # people per km^2
    np.save(RASTER_PATH, out)
    return out


def _project_polygon(poly):
    """Reproject a lon/lat (multi)polygon into renderer metres."""
    from shapely.geometry import MultiPolygon, Polygon

    def ring(coords):
        arr = np.asarray(coords, dtype=np.float64)
        x, z = _to_world(arr[:, 0], arr[:, 1])
        return np.column_stack([x, z])

    def one(p: Polygon) -> Polygon:
        return Polygon(ring(p.exterior.coords), [ring(i.coords) for i in p.interiors])

    if poly.geom_type == "Polygon":
        return one(poly)
    return MultiPolygon([one(p) for p in poly.geoms])


# --- Step 3: the curve --------------------------------------------------------


def fit_curve(density: np.ndarray) -> tuple[float, float, float]:
    """Fit the power law. Returns `(d_hi, d_lo, gamma)`.

    THE SHAPE. The mapping is a power law in density -- a straight line in
    log-log -- and that choice is the whole point of this function. Resident
    density inside 60 km of Town Hall spans four orders of magnitude, from
    single figures per square kilometre on the Hawkesbury to twenty thousand in
    Zetland. Map that linearly onto [0.05, 1.2] and every suburb from Ryde to
    Penrith lands inside the bottom two per cent of the range: not "Dural feels
    like Redfern" but its mirror image, where everything that is not the CBD is
    identically dead. A power law compresses the ratio instead of the
    difference, which is how the eye reads a crowd anyway.

        m(d) = MUL_MAX * (d / d_hi) ** gamma,   clamped to [MUL_MIN, MUL_MAX]

    THE TWO ANCHORS, AND WHY THEY ARE NOT BOTH PERCENTILES.

    `d_hi` is the 99.5th percentile of the populated cells -- the busiest real
    place rather than the single busiest cell.

    `d_lo` is **Dural**, read off this raster at the coordinates
    `game/streetlife.SUBURBS` holds for it. The player's brief did not name a
    percentile for the bottom, it named a suburb: 5% of the maximum "in places
    like Dural". Pinning to a percentile instead put the floor on a Gaussian
    tail cell in the middle of Ku-ring-gai Chase, four orders of magnitude below
    Dural, and the exponent that stretched to reach it (0.24) flattened
    everything above Hornsby into a single indistinguishable 1.2x. Pinning to
    the named place is both what was asked for and the only anchor in the brief
    that is a fact about Sydney rather than about the shape of a histogram.

    Everything below Dural -- bushland, the harbour, the odd empty industrial
    cell -- clamps to `MUL_MIN`, which is correct: 0.05x is the floor, and there
    is nothing meaningfully emptier than Dural that also has streets on it.
    """
    pos = density[density > 0]
    d_hi = float(np.percentile(pos, PIN_HI_PCT))
    x, z = next((x, z) for n, x, z in NAMED_PLACES if n == PIN_LO_PLACE)
    d_lo = float(sample(density, x, z))
    if not (0 < d_lo < d_hi):
        raise RuntimeError(f"the {PIN_LO_PLACE} anchor read {d_lo}/km^2 against a top of {d_hi}")
    gamma = math.log(MUL_MAX / MUL_MIN) / math.log(d_hi / d_lo)
    return d_hi, d_lo, gamma


def multiplier(density: np.ndarray, d_hi: float, gamma: float) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        m = MUL_MAX * np.power(np.maximum(density, 0.0) / d_hi, gamma)
    m = np.where(np.isfinite(m), m, MUL_MIN)
    return np.clip(m, MUL_MIN, MUL_MAX)


def to_bytes(mul: np.ndarray) -> np.ndarray:
    """Quantise to the geometric rank density.ts reads back.

    The byte is not the multiplier scaled -- it is `log(m/MIN) / log(MAX/MIN)`
    over 255 steps, so every step is the same *ratio* (1.25%) rather than the
    same amount. At the bottom of the range that is the difference between 20
    usable levels and 250 of them, and the bottom of the range is where Dural
    lives.
    """
    u = np.log(mul / MUL_MIN) / math.log(MUL_MAX / MUL_MIN)
    return np.clip(np.rint(u * 255.0), 0, 255).astype(np.uint8)


def sample(grid: np.ndarray, x: float, z: float):
    """Nearest-cell read, for the report. density.ts interpolates; this does not."""
    i = int((x + HALF_EXTENT_M) // CELL_M)
    k = int((z + HALF_EXTENT_M) // CELL_M)
    i = min(max(i, 0), GRID - 1)
    k = min(max(k, 0), GRID - 1)
    return grid[i, k]


def cmd_build(force: bool = False) -> None:
    if not GEOJSON_PATH.exists():
        sys.exit("build: no cache. Run `uv run scripts/density.py fetch` first.")
    density = rasterise(force)
    d_hi, d_lo, gamma = fit_curve(density)
    mul = multiplier(density, d_hi, gamma)
    packed = to_bytes(mul)

    # Row-major, x-major: index = ix * GRID + iz, matching density.ts.
    blob = base64.b64encode(packed.tobytes()).decode("ascii")
    lines = [blob[i : i + 116] for i in range(0, len(blob), 116)]
    body = "\n  '".join(f"{ln}' +" for ln in lines)

    pos = density[density > 0]
    header = f"""/**
 * The crowd field, as 248 x 248 bytes of geometric rank. GENERATED -- do not edit.
 *
 * Written by `scripts/density.py build` from ABS 2021 Census G01 resident counts
 * on ASGS 2021 SA1 boundaries, rasterised at 100 m, summed to {CELL_M:.0f} m cells and
 * blurred with a {BLUR_SIGMA_M:.0f} m Gaussian so that a cell reads "people living within
 * about a kilometre", not "people living on this block". See that script's
 * header for the source and for why it blurs.
 *
 * The byte is a **rank**, not a multiplier: `m = MIN * (MAX/MIN) ** (b / 255)`.
 * `game/density.ts` owns that arithmetic and is the only thing that should read
 * this file. Keeping the curve there and the geography here means the shape can
 * be retuned without a refetch, and means the two ends cannot disagree about
 * what a byte means.
 *
 * Fit, at build time, over the {pos.size:,} populated cells:
 *
 *     residents/km^2   min {pos.min():,.2f}   median {np.median(pos):,.0f}   max {pos.max():,.0f}
 *     top pin          {PIN_HI_PCT}th percentile = {d_hi:,.0f}/km^2 -> {MUL_MAX}x
 *     bottom pin       {PIN_LO_PLACE} = {d_lo:,.0f}/km^2 -> {MUL_MIN}x
 *     exponent         m = {MUL_MAX} * (d / {d_hi:,.0f}) ** {gamma:.4f}
 */
"""
    ts = (
        header
        + "\nexport const DENSITY_PACKED =\n  '"
        + body[:-2]
        + ";\n"
        + f"\n/** The percentile the curve pinned {MUL_MAX}x to, residents/km^2. Provenance only. */\n"
        + f"export const DENSITY_PIN_HI = {d_hi:.1f};\n"
        + "\n/** The exponent of the power law. Provenance only; the bytes already carry it. */\n"
        + f"export const DENSITY_GAMMA = {gamma:.6f};\n"
    )
    TS_PATH.write_text(ts)
    print(f"build: wrote {TS_PATH.relative_to(REPO_ROOT)}, {len(blob) / 1024:.0f} KB of base64")
    print(f"build: gamma {gamma:.4f}, pinned {MUL_MAX}x at {d_hi:,.0f}/km^2")

    # Round-trip, here as well as in density.ts, so a bad quantisation is caught
    # before anything imports it.
    back = MUL_MIN * (MUL_MAX / MUL_MIN) ** (packed.astype(np.float64) / 255.0)
    err = np.abs(back - mul) / mul
    print(f"build: quantisation error max {err.max() * 100:.2f}%")
    _report(density, mul)


def _report(density: np.ndarray, mul: np.ndarray) -> None:
    print()
    print(f"  {'place':<26}{'residents/km2':>15}{'multiplier':>13}{'vs today':>11}")
    for name, x, z in NAMED_PLACES:
        d = sample(density, x, z)
        m = sample(mul, x, z)
        print(f"  {name:<26}{d:>15,.0f}{m:>13.3f}{m:>10.2f}x")
    print()


def cmd_report() -> None:
    if not GEOJSON_PATH.exists():
        sys.exit("report: no cache. Run fetch first.")
    density = rasterise()
    d_hi, _d_lo, gamma = fit_curve(density)
    _report(density, multiplier(density, d_hi, gamma))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("step", choices=["fetch", "build", "report", "all"])
    ap.add_argument("--force", action="store_true", help="re-fetch and re-rasterise")
    a = ap.parse_args()
    if a.step in ("fetch", "all"):
        cmd_fetch(a.force)
    if a.step in ("build", "all"):
        cmd_build(a.force)
    if a.step == "report":
        cmd_report()


if __name__ == "__main__":
    main()
