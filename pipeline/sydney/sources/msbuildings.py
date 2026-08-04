"""Microsoft Australia building footprints -- the primary footprint source.

The dataset is 11 M polygons for Australia, partitioned by level-9 quadkey as
gzipped GeoJSON-lines. Greater Sydney touches only two partitions, so ingest is
cheap: stream each one, keep what falls inside the build radius, drop the rest.

The 2026 release also carries an ML-estimated `height` per polygon. It is used
only as a last-resort height and is treated with suspicion -- see `height.py`.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import sqlite3
from dataclasses import dataclass

import numpy as np
import requests
from shapely.geometry import Polygon

from .. import config, geo, ledger

LINKS_URL = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
REGION = "Australia"
QUADKEY_LEVEL = 9

# Footprints below this are sheds, carports and ML noise. Keeping them would
# triple the building count for no visual gain and they break the archetype
# classifier's area-based signals.
MIN_AREA_M2 = 12.0

# Above this a "building" is almost always a mis-segmented block or a stadium
# roof spanning several structures. Kept, but flagged for the classifier.
LARGE_AREA_M2 = 20_000.0


@dataclass
class Footprint:
    id: str
    ring: np.ndarray  # (N, 2) local ENU metres, closed, counter-clockwise
    area: float
    centroid: tuple[float, float]
    ms_height: float | None


def _links(session: requests.Session) -> dict[str, str]:
    """quadkey -> download URL for the Australian partitions, cached on disk."""
    cached = config.CACHE_DIR / "ms-dataset-links.csv"
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        resp = session.get(LINKS_URL, timeout=180)
        resp.raise_for_status()
        cached.write_bytes(resp.content)

    out: dict[str, str] = {}
    with cached.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if row["Location"] == REGION:
                out[row["QuadKey"]] = row["Url"]
    return out


def quadkeys_for_stage(radius_m: float) -> list[str]:
    return geo.quadkeys_for_bbox(geo.bbox_geodetic_for_radius(radius_m), QUADKEY_LEVEL)


def _stable_id(east: float, north: float, area: float) -> str:
    """A building ID that is identical across rebuilds.

    Derived from geometry rather than row order, because the facade grammar
    seeds its per-window randomisation from this and the spec requires that
    windows never shift between builds. Centroid is quantised to 10 cm, which is
    far finer than the spacing between distinct buildings.
    """
    payload = f"{east:.1f}:{north:.1f}:{area:.1f}"
    return hashlib.blake2b(payload.encode(), digest_size=8).hexdigest()


def _download(session: requests.Session, quadkey: str, url: str) -> bytes:
    """Fetch a partition, caching it. These are tens of MB, worth keeping."""
    cached = config.CACHE_DIR / f"ms-footprints-{quadkey}.csv.gz"
    if cached.exists() and cached.stat().st_size > 0:
        return cached.read_bytes()
    with session.get(url, timeout=600, stream=True) as resp:
        resp.raise_for_status()
        buf = bytearray()
        for chunk in resp.iter_content(1 << 20):
            buf.extend(chunk)
    cached.write_bytes(buf)
    return bytes(buf)


def parse_partition(raw: bytes, radius_m: float) -> list[Footprint]:
    """Decode one partition, keeping only footprints inside the build radius.

    Projection is the expensive step, so it is done once for all vertices of all
    candidate polygons as a single vectorised call rather than per polygon.
    """
    # Cheap geodetic pre-filter first: a bbox test on raw lat/lng discards the
    # overwhelming majority of a partition without any projection work.
    min_lon, min_lat, max_lon, max_lat = geo.bbox_geodetic_for_radius(radius_m)

    rings_ll: list[np.ndarray] = []
    heights: list[float | None] = []

    with gzip.open(io.BytesIO(raw), "rt") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            gtype = feat["geometry"]["type"]
            coords = feat["geometry"]["coordinates"]
            # A handful of records are MultiPolygon; take the largest part, since
            # the extra parts are invariably slivers from the segmentation.
            parts = [coords[0]] if gtype == "Polygon" else [p[0] for p in coords]
            for part in parts:
                ring = np.asarray(part, dtype=np.float64)
                lon_c, lat_c = ring[:, 0].mean(), ring[:, 1].mean()
                if not (min_lon <= lon_c <= max_lon and min_lat <= lat_c <= max_lat):
                    continue
                rings_ll.append(ring)
                h = feat.get("properties", {}).get("height")
                heights.append(float(h) if h is not None and h > 0 else None)

    if not rings_ll:
        return []

    # One projection call for every vertex of every surviving polygon.
    lengths = np.fromiter((len(r) for r in rings_ll), dtype=np.int64, count=len(rings_ll))
    flat = np.concatenate(rings_ll, axis=0)
    east, north = geo.lonlat_to_enu(flat[:, 0], flat[:, 1])
    offsets = np.concatenate(([0], np.cumsum(lengths)))

    out: list[Footprint] = []
    for i, ms_height in enumerate(heights):
        ring = np.column_stack((east[offsets[i] : offsets[i + 1]], north[offsets[i] : offsets[i + 1]]))
        cx, cy = float(ring[:, 0].mean()), float(ring[:, 1].mean())
        if cx * cx + cy * cy > radius_m * radius_m:
            continue  # precise radius test, now in metres
        poly = Polygon(ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
            if poly.is_empty or poly.geom_type != "Polygon":
                continue
            ring = np.asarray(poly.exterior.coords)
        area = float(poly.area)
        if area < MIN_AREA_M2:
            continue
        # Consistent winding lets the mesher assume a fixed normal direction.
        if _signed_area(ring) < 0:
            ring = ring[::-1]
        cent = poly.centroid
        out.append(
            Footprint(
                id=_stable_id(cent.x, cent.y, area),
                ring=ring,
                area=area,
                centroid=(float(cent.x), float(cent.y)),
                ms_height=ms_height,
            )
        )
    return out


def _signed_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def load(con: sqlite3.Connection, radius_m: float) -> list[Footprint]:
    """Download (once, cached) and return every footprint within `radius_m`.

    The ledger tracks the downloads, which are the expensive and interruptible
    part. Deciding which of these footprints survive is `merge.py`'s job -- OSM
    wins wherever it has a polygon -- so nothing is written to the buildings
    table from here.
    """
    session = requests.Session()
    links = _links(session)
    quadkeys = [q for q in quadkeys_for_stage(radius_m) if q in links]
    ledger.register(con, "footprints", quadkeys)

    out: list[Footprint] = []
    for qk in quadkeys:
        # The download is ledgered; the parse is cheap enough to redo every run
        # and it has to happen anyway for quadkeys fetched on a previous run.
        with ledger.unit(con, "footprints", qk) as detail:
            raw = _download(session, qk, links[qk])
            fps = parse_partition(raw, radius_m)
            detail["kept"] = len(fps)
            detail["empty"] = not fps
            out.extend(fps)
    return out
