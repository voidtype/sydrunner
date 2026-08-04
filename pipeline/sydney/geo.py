"""Projection, the local ENU frame, and tile addressing.

The only place in the pipeline that touches lat/lng. Everything downstream
consumes local ENU metres.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from pyproj import Transformer

from . import config

# --- Projection --------------------------------------------------------------


@lru_cache(maxsize=None)
def _to_projected() -> Transformer:
    return Transformer.from_crs(config.CRS_GEODETIC, config.CRS_PROJECTED, always_xy=True)


@lru_cache(maxsize=None)
def _to_geodetic() -> Transformer:
    return Transformer.from_crs(config.CRS_PROJECTED, config.CRS_GEODETIC, always_xy=True)


@lru_cache(maxsize=1)
def origin_projected() -> tuple[float, float]:
    """The ENU origin as MGA2020 Zone 56 easting/northing."""
    return _to_projected().transform(config.ORIGIN_LON, config.ORIGIN_LAT)


def lonlat_to_enu(lon, lat):
    """Geodetic -> local ENU metres. Returns (east, north), array-preserving.

    North is returned as-is here rather than negated; the flip to the renderer's
    +Z-is-south convention happens once, in `enu_to_world`, so that all
    geometric reasoning in the pipeline stays in a conventional east/north frame.
    """
    east, north = _to_projected().transform(lon, lat)
    ox, oy = origin_projected()
    return np.asarray(east) - ox, np.asarray(north) - oy


def enu_to_lonlat(east, north):
    """Local ENU metres -> geodetic. Used by debug tooling and OSM lookups."""
    ox, oy = origin_projected()
    return _to_geodetic().transform(np.asarray(east) + ox, np.asarray(north) + oy)


def enu_to_world(east, north):
    """ENU (east, north) -> renderer (x, z). Y is height and handled separately.

    Three.js is Y-up right-handed with north at -Z, so world Z = -north.
    """
    return east, -np.asarray(north)


def bbox_geodetic_for_radius(radius_m: float) -> tuple[float, float, float, float]:
    """A (min_lon, min_lat, max_lon, max_lat) box enclosing a radius about the origin.

    Deliberately a touch generous -- it is a fetch filter, not a clip, and the
    precise radius test is applied later in projected metres.
    """
    lat_deg = radius_m / 111_320.0
    lon_deg = radius_m / (111_320.0 * math.cos(math.radians(config.ORIGIN_LAT)))
    return (
        config.ORIGIN_LON - lon_deg,
        config.ORIGIN_LAT - lat_deg,
        config.ORIGIN_LON + lon_deg,
        config.ORIGIN_LAT + lat_deg,
    )


# --- Tile addressing ---------------------------------------------------------


@dataclass(frozen=True, order=True)
class TileId:
    """A tile on the fixed ENU grid.

    Indices are signed and centred on the origin: tile (0, 0) has its
    south-west corner at the ENU origin. The grid is infinite in principle,
    which is what lets coverage be extended outward later without renumbering
    anything that already exists.
    """

    tx: int
    tz: int

    @property
    def key(self) -> str:
        return f"{self.tx}_{self.tz}"

    @property
    def bounds_enu(self) -> tuple[float, float, float, float]:
        """(min_east, min_north, max_east, max_north) in local ENU metres."""
        s = config.TILE_SIZE
        return (self.tx * s, self.tz * s, (self.tx + 1) * s, (self.tz + 1) * s)

    @property
    def centre_enu(self) -> tuple[float, float]:
        e0, n0, e1, n1 = self.bounds_enu
        return ((e0 + e1) * 0.5, (n0 + n1) * 0.5)

    def distance_from_origin(self) -> float:
        """Metres from the ENU origin to the nearest point of this tile.

        Nearest rather than centre, so a tile that merely clips the radius is
        still included.
        """
        e0, n0, e1, n1 = self.bounds_enu
        dx = 0.0 if e0 <= 0.0 <= e1 else min(abs(e0), abs(e1))
        dz = 0.0 if n0 <= 0.0 <= n1 else min(abs(n0), abs(n1))
        return math.hypot(dx, dz)


def tile_for_enu(east: float, north: float) -> TileId:
    s = config.TILE_SIZE
    return TileId(math.floor(east / s), math.floor(north / s))


def tiles_within_radius(radius_m: float) -> list[TileId]:
    """Every tile whose extent intersects a disc of `radius_m` about the origin."""
    s = config.TILE_SIZE
    reach = int(math.ceil(radius_m / s)) + 1
    out = [
        t
        for tx in range(-reach, reach + 1)
        for tz in range(-reach, reach + 1)
        if (t := TileId(tx, tz)).distance_from_origin() <= radius_m
    ]
    return sorted(out)


# --- Bing/Microsoft quadkeys -------------------------------------------------
# The Microsoft footprint dataset is partitioned by level-9 quadkey, so fetching
# only Sydney means knowing which quadkeys Sydney touches.


def lonlat_to_tile_xy(lon: float, lat: float, level: int) -> tuple[int, int]:
    """Web-Mercator tile indices at `level` for a geodetic point."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    n = 1 << level
    x = int((lon + 180.0) / 360.0 * n)
    sin_lat = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_xy_to_quadkey(x: int, y: int, level: int) -> str:
    digits = []
    for i in range(level, 0, -1):
        bit = 1 << (i - 1)
        d = 0
        if x & bit:
            d += 1
        if y & bit:
            d += 2
        digits.append(str(d))
    return "".join(digits)


def quadkeys_for_bbox(
    bbox: tuple[float, float, float, float], level: int = 9
) -> list[str]:
    """Every level-`level` quadkey covering a geodetic bbox."""
    min_lon, min_lat, max_lon, max_lat = bbox
    x0, y0 = lonlat_to_tile_xy(min_lon, max_lat, level)  # NW corner
    x1, y1 = lonlat_to_tile_xy(max_lon, min_lat, level)  # SE corner
    return [
        tile_xy_to_quadkey(x, y, level)
        for x in range(min(x0, x1), max(x0, x1) + 1)
        for y in range(min(y0, y1), max(y0, y1) + 1)
    ]
