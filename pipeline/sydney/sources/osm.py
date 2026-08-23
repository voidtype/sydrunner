"""OpenStreetMap ingest from a Geofabrik/BBBike .osm.pbf extract.

The spec assigns OSM the role of *attribute* source, with Microsoft supplying
footprints. Measured against the real data that split does not hold: Microsoft's
ML footprints thin out badly in dense high-rise, leaving only 71 buildings
within 500 m of the CBD origin where there should be several hundred. OSM's
Sydney CBD coverage is hand-mapped and excellent.

So OSM is used as both:
  * a footprint source that takes precedence wherever it has a polygon, since a
    hand-mapped outline beats an ML-segmented one and carries real attributes;
  * the attribute source for everything (levels, material, roof shape, era),
    plus roads, retail frontage, stations and cafes.

Microsoft then fills the suburban sprawl OSM has not covered. Overlap is
resolved geometrically in `merge.py`.

Read via GDAL's OSM driver through pyogrio's raw interface, which returns numpy
arrays and WKB without needing pandas or geopandas.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from shapely.geometry.base import BaseGeometry

from .. import config, geo

PBF_PATH = config.CACHE_DIR / "sydney.osm.pbf"

# GDAL's OSM driver promotes a fixed set of tags to real columns and dumps the
# rest into an hstore-encoded `other_tags` string. These are the ones the facade
# grammar and gameplay actually need out of that blob.
WANTED_TAGS = (
    "building:levels",
    "building:material",
    "building:colour",
    "building:part",
    "roof:shape",
    "roof:material",
    "roof:levels",
    "roof:colour",
    "height",
    # The two tags that say a structure does not start at the ground. See
    # `OsmBuilding.min_height` for what they mean and why the pipeline was
    # silently wrong without them.
    "min_height",
    "building:min_level",
    "start_date",
    "heritage",
    "layer",
    # `bridge` on an *area* rather than on a way. A way tagged `bridge` feeds
    # `decks.py`; an area tagged `bridge` is a structure, and until now it went
    # down the building path and was extruded from the ground like a warehouse.
    "bridge",
    "man_made",
    "name",
)

_HSTORE_PAIR = re.compile(r'"((?:[^"\\]|\\.)*)"\s*=>\s*"((?:[^"\\]|\\.)*)"')


def parse_other_tags(blob: str | None) -> dict[str, str]:
    """Decode GDAL's hstore `other_tags` field.

    Values may contain escaped quotes, so this is a regex over quoted pairs
    rather than a naive split on commas.
    """
    if not blob:
        return {}
    return {
        k.replace('\\"', '"').replace("\\\\", "\\"): v.replace('\\"', '"').replace("\\\\", "\\")
        for k, v in _HSTORE_PAIR.findall(blob)
    }


# --- Reading ------------------------------------------------------------------


def _read_layer(
    path: Path, layer: str, bbox: tuple[float, float, float, float]
) -> tuple[list[BaseGeometry], list[dict[str, Any]]]:
    """Read one OSM layer, spatially filtered, as shapely geometries + tag dicts.

    Which tags GDAL promotes to real columns differs by layer -- `points` has no
    amenity/railway/power column at all, while `multipolygons` does -- and the
    remainder arrive hstore-encoded in `other_tags`. Callers should not have to
    care, so the two are merged into one flat dict here, with promoted columns
    winning over the hstore blob.
    """
    from pyogrio.raw import read

    meta, _, geometry, fields = read(
        path,
        layer=layer,
        bbox=bbox,
        # The OSM driver's interleaved reading has to be off for a spatial
        # filter to be applied reliably.
        INTERLEAVED_READING="NO",
    )
    if geometry is None or len(geometry) == 0:
        return [], []

    geoms = list(shapely.from_wkb(geometry))
    names = list(meta["fields"])
    attrs: list[dict[str, Any]] = []
    for row in zip(*fields):
        promoted = {
            n: (v.item() if isinstance(v, np.generic) else v)
            for n, v in zip(names, row)
            if v is not None and v != ""
        }
        merged = parse_other_tags(promoted.pop("other_tags", None))
        merged.update(promoted)
        attrs.append(merged)
    return geoms, attrs


def _project(geom: BaseGeometry) -> BaseGeometry:
    """Reproject a geodetic shapely geometry into the local ENU frame."""
    return shapely.transform(
        geom,
        lambda pts: np.column_stack(geo.lonlat_to_enu(pts[:, 0], pts[:, 1])),
    )


def _within_radius(geom: BaseGeometry, radius_m: float) -> bool:
    cx, cy = geom.centroid.x, geom.centroid.y
    return cx * cx + cy * cy <= radius_m * radius_m


# --- Buildings ----------------------------------------------------------------


@dataclass
class OsmBuilding:
    osm_id: str
    ring: np.ndarray
    holes: list[np.ndarray]
    area: float
    centroid: tuple[float, float]
    building: str | None
    name: str | None
    levels: int | None
    height: float | None
    material: str | None
    colour: str | None
    roof_shape: str | None
    roof_material: str | None
    start_date: str | None
    heritage: bool
    amenity: str | None
    shop: str | None

    # --- Where the structure *starts* -----------------------------------------
    #
    # `min_height` is the underside of the built volume in metres above the
    # ground, and `building:min_level` is the same statement counted in storeys.
    # OSM's own wiki calls them "the bottom of the building part"; the pair is
    # how a mapper says *this thing is in the air*. They are what a pedestrian
    # overbridge, a skybridge between two towers, an elevated walkway and a
    # building on stilts all have in common, and every one of them is a hole in
    # the road network if it is drawn from the ground up.
    #
    # Neither tag existed anywhere in this pipeline before, which is why a
    # `building=bridge` over Military Road came out as a solid prism from the
    # asphalt to the parapet -- a wall across a trunk road that the player
    # cannot pass and that no audit had anything to say about.
    min_height: float | None = None
    min_level: int | None = None

    # --- Whether the polygon claims to be a bridge -----------------------------
    #
    # Three ways OSM says it, all of them seen in this extract:
    #   `building=bridge`   the building-shaped span itself (14 in the extent)
    #   `bridge=yes|...`    the same statement made as a property (1)
    #   `man_made=bridge`   the structure outline, usually without `building`
    #                       at all (44) -- it only reaches here when a mapper
    #                       has *also* put a `building` tag on it.
    # `layer` is kept beside them because on its own it means nothing about
    # elevation -- see `elevated.py` for why it is only ever corroboration.
    bridge: bool = False
    man_made: str | None = None
    layer: int = 0


def _as_int(v: str | None) -> int | None:
    """OSM numeric tags are user-entered: '3', '3.5', '3;4', 'ground' all occur."""
    if not v:
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(v))
    if not m:
        return None
    n = int(round(float(m.group(1))))
    return n if 0 < n <= 200 else None


def _as_float(v: str | None) -> float | None:
    if not v:
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(v))
    if not m:
        return None
    f = float(m.group(1))
    return f if 0 < f <= 600 else None


# Feet and inches still appear in OSM height tags, and `min_height` is no
# exception: the wiki blesses `12'6"` alongside `3.8`. Rare here -- this extract
# has none -- but a silently mis-parsed imperial value is a structure at four
# times its stated height, so the conversion is a line rather than a hope.
_FEET_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*\")?\s*$")
_METRES_PER_FOOT = 0.3048


def _as_metres(v: str | None) -> float | None:
    """A vertical OSM tag in metres, parsed defensively. None if unusable.

    Deliberately not `_as_float`. That one rejects zero, because a building with
    no levels and no height is a building with no data -- but `min_height=0` is
    a *statement*, and the statement is "this thing does start at the ground".
    Folding it into None would be harmless today and would quietly become wrong
    the moment anything downstream treats None as "unknown, go and guess".

    Accepts the four forms the tag is actually written in: a bare number, a
    number with a unit suffix (`7 m`, `12.5 metres`), and feet-and-inches. A
    value outside a plausible range for a *structure's underside* is refused
    rather than clamped -- 600 m is taller than anything in the southern
    hemisphere, and a negative one is a basement, which this pipeline has no
    representation for and must not silently invert into a raised prism.
    """
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    ft = _FEET_RE.match(s)
    if ft:
        feet = float(ft.group(1)) + (float(ft.group(2) or 0.0) / 12.0)
        m = feet * _METRES_PER_FOOT
    else:
        num = re.match(r"\s*(-?\d+(?:\.\d+)?)", s)
        if not num:
            return None
        m = float(num.group(1))
        # `7 m`, `7m`, `7 metres` are all the same number; anything else after
        # the digits is a unit this parser does not know, and guessing at it is
        # how a 7-foot clearance becomes a 7-metre one.
        tail = s[num.end():].strip().lower().rstrip(".")
        if tail and tail not in ("m", "metre", "metres", "meter", "meters"):
            return None
    return m if 0.0 <= m <= 600.0 else None


def _as_layer(v: str | None) -> int:
    """OSM `layer`, where the sign carries the meaning: -1 is underground.

    Parsed separately from `_as_int`, which rejects anything non-positive
    because levels and lane counts must be. Reusing it here silently turned
    every tunnel in the extent into a surface road at layer 0 -- the Cross City
    and Eastern Distributor tunnels included, which is 1,437 ways of motorway
    ploughing through blocks that have no road on them at all.
    """
    if not v:
        return 0
    m = re.match(r"\s*(-?\d+)", str(v))
    return int(m.group(1)) if m else 0


def read_buildings(radius_m: float, path: Path = PBF_PATH) -> list[OsmBuilding]:
    """Every OSM polygon tagged `building` inside the radius, with attributes."""
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "multipolygons", bbox)

    out: list[OsmBuilding] = []
    for geom, a in zip(geoms, attrs):
        if not a.get("building") or a["building"] in ("no",):
            continue
        # `building:part` polygons describe pieces of a building already mapped
        # by its outline; including them would double-wall the CBD towers.
        if a.get("building:part") == "yes" and a["building"] == "yes":
            continue

        proj = _project(geom)
        # A multipolygon building is almost always one outline plus courtyards;
        # take the largest part and keep its holes.
        polys = list(proj.geoms) if proj.geom_type == "MultiPolygon" else [proj]
        poly = max(polys, key=lambda p: p.area)
        if poly.is_empty or poly.area < 8.0 or not _within_radius(poly, radius_m):
            continue

        out.append(
            OsmBuilding(
                osm_id=str(a.get("osm_way_id") or a.get("osm_id") or ""),
                ring=np.asarray(poly.exterior.coords),
                holes=[np.asarray(h.coords) for h in poly.interiors],
                area=float(poly.area),
                centroid=(float(poly.centroid.x), float(poly.centroid.y)),
                building=a.get("building"),
                name=a.get("name"),
                levels=_as_int(a.get("building:levels")),
                height=_as_float(a.get("height")),
                material=a.get("building:material"),
                colour=a.get("building:colour"),
                roof_shape=a.get("roof:shape"),
                roof_material=a.get("roof:material"),
                start_date=a.get("start_date"),
                heritage=any(k.startswith("heritage") for k in a),
                amenity=a.get("amenity"),
                shop=a.get("shop"),
                # Read but not acted on here. Whether a structure is in the air
                # is a question about the terrain and the road under it, and
                # neither is available at ingest -- `elevated.py` decides, once
                # both exist. See `OsmBuilding` for what each tag means.
                min_height=_as_metres(a.get("min_height")),
                min_level=_as_int(a.get("building:min_level")),
                bridge=a.get("bridge") in ("yes", "viaduct", "aqueduct", "boardwalk"),
                man_made=a.get("man_made"),
                layer=_as_layer(a.get("layer")),
            )
        )
    return out


# --- Roads --------------------------------------------------------------------

# Classes that get a kerb, a footpath and (in the inner suburbs) power poles.
STREET_CLASSES = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified", "living_street", "service",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}
FOOT_CLASSES = {"footway", "path", "pedestrian", "steps", "cycleway"}

# Approximate carriageway width by class, metres. Used for the road ribbon and
# to offset the kerb line that power poles and awnings sit on.
ROAD_WIDTH = {
    "motorway": 14.0, "trunk": 12.0, "primary": 11.0, "secondary": 10.0,
    "tertiary": 9.0, "residential": 7.5, "unclassified": 7.0,
    "living_street": 6.0, "service": 5.0,
}


@dataclass
class OsmRoad:
    osm_id: str
    line: np.ndarray  # (N, 2) ENU metres
    highway: str
    name: str | None
    lanes: int | None
    oneway: bool
    width: float
    is_foot: bool
    layer: int
    # `tunnel` and a negative `layer` disagree often enough to be worth both:
    # plenty of tunnelled ways carry one tag and not the other.
    tunnel: bool = False
    # `oneway=-1`: one-way *against* the way's digitised direction. `oneway`
    # above folds it in, because every consumer before `lanes.py` only ever
    # asked whether a way carries traffic both ways. Traffic has to know which
    # way the one way points, and a car driving up the Cahill Expressway
    # backwards is the kind of error that looks like a physics bug.
    oneway_reverse: bool = False
    # A deck, not ground. Read for `roadgrade.py`, which must not pull the
    # terrain up into the Anzac Bridge or down under an overpass; the surface
    # layers deliberately ignore it and keep drawing the deck on the ground,
    # which is the landmark pass's business rather than this field's.
    bridge: bool = False


def read_roads(radius_m: float, path: Path = PBF_PATH) -> list[OsmRoad]:
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "lines", bbox)

    out: list[OsmRoad] = []
    for geom, a in zip(geoms, attrs):
        hw = a.get("highway")
        if not hw or (hw not in STREET_CLASSES and hw not in FOOT_CLASSES):
            continue
        proj = _project(geom)
        lines = list(proj.geoms) if proj.geom_type == "MultiLineString" else [proj]
        for ln in lines:
            if ln.is_empty or ln.length < 2.0:
                continue
            coords = np.asarray(ln.coords)
            if not (np.hypot(coords[:, 0], coords[:, 1]) <= radius_m).any():
                continue
            out.append(
                OsmRoad(
                    osm_id=str(a.get("osm_id") or ""),
                    line=coords,
                    highway=hw,
                    name=a.get("name") or None,
                    lanes=_as_int(a.get("lanes")),
                    oneway=a.get("oneway") in ("yes", "1", "-1"),
                    oneway_reverse=a.get("oneway") == "-1",
                    width=_as_float(a.get("width")) or ROAD_WIDTH.get(hw, 3.0),
                    is_foot=hw in FOOT_CLASSES,
                    layer=_as_layer(a.get("layer")),
                    # `building_passage` is deliberately not a tunnel: it is an
                    # archway through a building, at grade, and the footpath
                    # layer already subtracts the building over it.
                    tunnel=a.get("tunnel") in ("yes", "passage"),
                    # Anything that carries the road over something else.
                    # `viaduct` is 57 of the extent's 277 and is the same thing
                    # for this purpose -- the light rail viaduct and the
                    # Cahill Expressway are not statements about the ground.
                    bridge=a.get("bridge") in ("yes", "viaduct", "aqueduct", "boardwalk"),
                )
            )
    return out


# --- Points of interest -------------------------------------------------------


@dataclass
class OsmPoi:
    osm_id: str
    east: float
    north: float
    kind: str  # 'station' | 'station_entrance' | 'cafe' | 'pub' | 'pole' | 'traffic_signals'
    name: str | None
    tags: dict[str, str] = field(default_factory=dict)


def read_pois(radius_m: float, path: Path = PBF_PATH) -> list[OsmPoi]:
    """Station entrances, cafes, power poles and signals -- the gameplay and prop layer.

    Stations and cafes are the two powerups in spec section 8.3; poles are the
    highest recognition-per-triangle feature in section 7.2; traffic signals are
    spec 7.7's street furniture.

    `highway=traffic_signals` is unlike every other kind here in that OSM maps it
    **per approach** rather than per intersection -- a four-way signalised
    crossing carries four nodes, one at each stop line, typically 10-20 m back
    from the middle. So this returns 1,547 nodes over the inner ring for about
    390 real intersections, and the caller has to cluster them. `furniture.py`
    does; nothing else should assume one node means one signal.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "points", bbox)

    out: list[OsmPoi] = []
    for geom, a in zip(geoms, attrs):
        kind: str | None = None
        if a.get("railway") == "station":
            kind = "station"
        elif a.get("railway") in ("subway_entrance", "train_station_entrance"):
            kind = "station_entrance"
        elif a.get("amenity") == "cafe":
            kind = "cafe"
        elif a.get("amenity") == "pub":
            kind = "pub"
        elif a.get("power") == "pole":
            kind = "pole"
        # `highway` is one of the columns GDAL promotes on the `points` layer, so
        # this reads a real field rather than the hstore blob -- which is why it
        # costs nothing to have gone unused until now.
        elif a.get("highway") == "traffic_signals":
            kind = "traffic_signals"
        if kind is None:
            continue

        proj = _project(geom)
        if not _within_radius(proj, radius_m):
            continue
        out.append(
            OsmPoi(
                osm_id=str(a.get("osm_id") or ""),
                east=float(proj.x),
                north=float(proj.y),
                kind=kind,
                name=a.get("name"),
            )
        )
    return out


def read_station_areas(radius_m: float, path: Path = PBF_PATH) -> list[OsmPoi]:
    """Stations mapped as a closed *way* rather than as a node, as centroids.

    This exists because `read_pois` alone misses every heavy-rail station spec
    8.3 name-checks. Central, Redfern, Museum and St James are closed ways
    tagged `railway=station`, and GDAL's OSM driver leaves them in the `lines`
    layer -- `railway` is not one of the keys its default `osmconf.ini` treats as
    area-forming, so they never become multipolygons and a reader that only
    looks at `points` and `multipolygons` sees neither the ring nor a node. The
    22 nodes `read_pois` does return over the inner ring are the light rail, the
    Metro and the North Shore line; the platforms of a suburban station are
    `railway=stop` nodes, one per platform, which is a different object again.

    The centroid of a station ring lands *inside* the concourse, which is a
    building -- `powerups._free_point` is what stands it back out on the
    footpath, and this reader deliberately does not: where the station is is a
    fact about Sydney and where you can stand is a question about the geometry,
    and mixing the two here would put a snap radius in the OSM layer.

    Open ways are skipped rather than centroided. A `railway=station` on an open
    line is a mapping error or a corridor, and the centroid of a corridor is a
    point in the middle of the track.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "lines", bbox)

    out: list[OsmPoi] = []
    for geom, a in zip(geoms, attrs):
        if a.get("railway") != "station":
            continue
        if geom.geom_type != "LineString" or not geom.is_closed:
            continue
        proj = _project(geom)
        centre = proj.centroid
        if not _within_radius(centre, radius_m):
            continue
        out.append(
            OsmPoi(
                osm_id=str(a.get("osm_id") or ""),
                east=float(centre.x),
                north=float(centre.y),
                kind="station",
                # `station=light_rail | subway | None` distinguishes the three
                # networks. Carried rather than filtered on: spec 8.3 says "train
                # stations" and every one of these is one, and a Metro entrance
                # is as much a contested objective as a Sydney Trains one.
                name=a.get("name"),
                tags={"geometry": "way", "station": str(a.get("station") or "")},
            )
        )
    return out


# --- Places -------------------------------------------------------------------

# The three `place` values that name a piece of inner Sydney.
#
# `suburb` is the one that matters and is the one an address is written with.
# The other two are in because Sydney's OSM uses them for places a player would
# name the same way: Chinatown, Thai Town and Koreatown are `neighbourhood`, as
# are Wynyard and Victoria Cross, and dropping them would leave a player
# standing in Chinatown told they are in Haymarket. `quarter` is the same
# category one rung finer and OSM has none of it in the inner ring today -- it
# is here so that the day someone adds one it is picked up rather than being a
# code change.
#
# `town` joined them when the world reached 19.3 km, and Manly is why: OSM tags
# it `place=town` rather than `place=suburb`, so the locator called it Manly Vale
# and `/tp manly` drove you to Manly Vale -- the matcher answering correctly from
# a table that did not contain the place. Sydney's metropolitan area absorbed a
# ring of what were once separate towns (Manly, Parramatta, Liverpool) and OSM
# still records that history in the tag; a game whose map is the real city has to
# read it. There is exactly one `town` inside 19.3 km, which is the size of the
# risk.
#
# Deliberately *not* here: `locality` (23 nodes in the inner bbox), which OSM
# uses for unbuilt features -- headlands, bays, wharves and rail junctions -- and
# `city`, which is the single node for Sydney itself and would win the nearest
# test across half the CBD.
PLACE_KINDS = ("suburb", "neighbourhood", "quarter", "town")


@dataclass
class OsmPlace:
    osm_id: str
    east: float
    north: float
    kind: str  # one of `PLACE_KINDS`
    name: str


def read_places(radius_m: float, path: Path = PBF_PATH) -> list[OsmPlace]:
    """Suburb and neighbourhood *nodes* inside the radius, in ENU metres.

    A node rather than a boundary, and that is the whole of what this can and
    cannot do. OSM does carry suburb polygons for Sydney -- as `boundary=
    administrative, admin_level=10` relations -- and they are the real answer to
    "which suburb is this point in". They are also relations of hundreds of way
    members that GDAL's OSM driver does not assemble into the `multipolygons`
    layer without a config change, and the client would then need a
    point-in-polygon test over a payload two orders of magnitude larger than
    this one.

    The node is the label anchor a renderer draws the suburb's name at, which is
    roughly its centre of mass, and Sydney's inner suburbs are 1-2 km apart. So
    nearest-node is right in the middle of a suburb and wrong in a band along
    every boundary, where it names whichever centre happens to be closer rather
    than which side of the line you are on. `client/src/game/locator.ts` says the
    same thing from the other end and is where a boundary payload would land if
    this is ever not good enough.

    Read from `points` only: a suburb mapped as a way is its boundary, and this
    reader deliberately does not centroid one -- that would mix a label position
    with a derived one and make the same list carry two different meanings.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "points", bbox)

    out: list[OsmPlace] = []
    for geom, a in zip(geoms, attrs):
        kind = a.get("place")
        if kind not in PLACE_KINDS:
            continue
        name = (a.get("name") or "").strip()
        # A place with no name is a place that cannot be read out. There are
        # none in the extent; the guard is here because the whole record is the
        # name.
        if not name:
            continue
        proj = _project(geom)
        if not _within_radius(proj, radius_m):
            continue
        out.append(
            OsmPlace(
                osm_id=str(a.get("osm_id") or ""),
                east=float(proj.x),
                north=float(proj.y),
                kind=str(kind),
                name=name,
            )
        )
    return out


# --- Green space --------------------------------------------------------------

# Every polygon that is vegetation of some kind, and **what kind**, because they
# are not one thing and the whole defect this table was rewritten to fix was
# treating the four that were read as one and the nine that were not as nothing.
#
# The old comment here said `natural=wood` and `natural=scrub` "want their own
# surface and their own dense tree scatter, which is a project of its own". This
# is that project. Counted over the 60 km extract, clipped to the emitted world
# box, the tags that were never read carry **2,917 km2 of ground** against the
# 272 km2 that were -- Lane Cove National Park, Ku-ring-gai Chase, the Royal, the
# Georges River mangroves and every coastal heath in the map, all of it drawn as
# the same bare dry dirt as a car park:
#
#     natural=wood            7,393 polys   2,233 km2
#     landcover=trees           199         1,643
#     boundary=protected_area   127         1,587
#     leisure=nature_reserve    361         1,037
#     natural=grassland         811            53   (read today, as mown)
#     landuse=meadow            566            52
#     natural=wetland         1,027            43
#     leisure=golf_course       113            40
#     landuse=forest            161            37
#     natural=scrub           2,752            28
#     natural=heath             270             6
#
# ---------------------------------------------------------------------------
# THE COVER CLASS, and why it is not a boolean.
#
# A national park, a golf course, a mangrove reach, a sandstone heath and a
# scrubby road reserve are five different surfaces carrying five different
# scatters, and the one thing they share is that none of them is a lawn. So a
# polygon carries a **cover class** rather than a `plantable` flag, and
# `vegetation.py` reads the class for its surface slot, its stem density, its
# species mix and whether the instances are trees at all.
#
#   mown     someone mows or grazes it: parks, gardens, ovals, playgrounds,
#            council grass, cemeteries, grassland. Today's read, unchanged.
#   rough    unmown grass with trees standing in it: golf, meadow, orchard,
#            nursery. Open, and open on purpose.
#   forest   a closed-ish eucalypt canopy: wood, forest, landcover=trees, and
#            the two administrative tags below.
#   scrub    shrub-dominated regrowth with the odd mallee gum over it.
#   heath    the sandstone plateau and the clifftops: a continuous 0.3-1.5 m
#            shrub layer and **no trees at all**.
#   wetland  estuarine mud, saltmarsh and mangrove. Not grass, not bush floor,
#            and the one green polygon in Sydney that is not green.
#
# ---------------------------------------------------------------------------
# THE RANK, which is how an overlap is settled, and it is settled by
# SPECIFICITY rather than by area, by iteration order or by which tag GDAL
# happens to promote to a column.
#
# The overlaps are not rare and they are not accidental. Lane Cove National Park
# is `boundary=protected_area` **and** `leisure=nature_reserve` **and**
# `natural=wood`, and inside those three there are mown picnic lawns, a mangrove
# reach on the river and heath on the ridges. An administrative boundary is a
# statement about who owns the ground, not about what grows on it, so it must be
# the **weakest** claim in the table; a mower is the strongest, because somebody
# went out there with one. Between them the order runs from the most specific
# botanical claim to the least:
#
#     0  pitch, playground     a playing surface. Beats the park it sits in.
#     1  mown                  a lawn. Beats everything below it.
#     2  wetland               a hydrological claim; nothing else can be true
#                              of tidal mud.
#     3  heath                 the mapper said explicitly: not wood, not scrub.
#     4  scrub
#     5  rough                 a golf course inside a reserve is a golf course;
#                              a meadow inside a wood is a clearing.
#     6  forest, tagged        `natural=wood` is a claim about the trees.
#     7  forest, administrative  `protected_area` is a claim about the fence.
#
# Two places read this. `read_green` settles it **per polygon**, because one way
# routinely carries three of these keys at once. `vegetation.py` settles it
# **between polygons** -- the surface by subtracting every higher-ranked class
# out of each lower one, so no two slots draw over the same ground, and the
# scatter by refusing a stem that lands inside a better-ranked polygon.
#
# `leisure=swimming_pool` is still excluded for the obvious reason and is still
# the single most common `leisure` value in the extent, at 6,622.

COVER_MOWN = "mown"
COVER_ROUGH = "rough"
COVER_FOREST = "forest"
COVER_SCRUB = "scrub"
COVER_HEATH = "heath"
COVER_WETLAND = "wetland"

#: Every cover class, weakest rank last. The order is the tie-break order and
#: `vegetation.py` walks it directly, so it is data rather than documentation.
COVER_CLASSES = (
    COVER_MOWN,
    COVER_WETLAND,
    COVER_HEATH,
    COVER_SCRUB,
    COVER_ROUGH,
    COVER_FOREST,
)

#: `(key, value) -> (cover, rank)`. Lower rank wins. See the essay above.
GREEN_COVER: dict[tuple[str, str], tuple[str, int]] = {
    # Rank 0 -- a playing surface, which beats the park it stands in.
    ("leisure", "pitch"): (COVER_MOWN, 0),
    ("leisure", "playground"): (COVER_MOWN, 0),
    # Rank 1 -- mown or grazed. Exactly the set that was read before this
    # rewrite, so every tile in the shipped world that had grass still has the
    # same grass in the same place.
    ("leisure", "park"): (COVER_MOWN, 1),
    ("leisure", "garden"): (COVER_MOWN, 1),
    ("landuse", "grass"): (COVER_MOWN, 1),
    ("landuse", "recreation_ground"): (COVER_MOWN, 1),
    ("landuse", "village_green"): (COVER_MOWN, 1),
    ("landuse", "cemetery"): (COVER_MOWN, 1),
    ("natural", "grassland"): (COVER_MOWN, 1),
    # New at rank 1 and small: 12 commons and 130 `landcover=grass` scraps,
    # which are the same thing under a key the read never looked at.
    ("leisure", "common"): (COVER_MOWN, 1),
    ("landcover", "grass"): (COVER_MOWN, 1),
    # Rank 2 -- water in the ground.
    ("natural", "wetland"): (COVER_WETLAND, 2),
    # Rank 3, 4 -- the shrub layers, heath first because a mapper who wrote
    # `heath` over ground someone else called `wood` is correcting them.
    ("natural", "heath"): (COVER_HEATH, 3),
    ("natural", "scrub"): (COVER_SCRUB, 4),
    ("natural", "shrubbery"): (COVER_SCRUB, 4),
    # Rank 5 -- managed open ground with trees standing in it.
    ("leisure", "golf_course"): (COVER_ROUGH, 5),
    ("landuse", "meadow"): (COVER_ROUGH, 5),
    ("landuse", "orchard"): (COVER_ROUGH, 5),
    ("landuse", "plant_nursery"): (COVER_ROUGH, 5),
    # Rank 6 -- somebody looked at the trees.
    ("natural", "wood"): (COVER_FOREST, 6),
    ("landuse", "forest"): (COVER_FOREST, 6),
    ("landcover", "trees"): (COVER_FOREST, 6),
    # Rank 7 -- somebody drew a fence. `landuse=conservation` is one polygon in
    # the extent and belongs with these two rather than with the wood: it is a
    # zoning tag.
    ("leisure", "nature_reserve"): (COVER_FOREST, 7),
    ("boundary", "protected_area"): (COVER_FOREST, 7),
    ("landuse", "conservation"): (COVER_FOREST, 7),
}

#: The keys `read_green` looks at, derived so a key added above cannot be
#: forgotten here.
GREEN_KEYS = tuple(dict.fromkeys(k for k, _ in GREEN_COVER))

# A rank names exactly one cover class, and two things downstream depend on it:
# `vegetation.surfaces` groups a tile's green by rank and reads the class off the
# group, and `canopy-audit` does the same independently. Both would silently
# paint one class in another's material the day two classes shared a rank, so the
# table says so at import instead. Costs a dict comprehension once.
_RANK_COVER: dict[int, str] = {}
for _tag, (_cover, _rank) in GREEN_COVER.items():
    if _RANK_COVER.setdefault(_rank, _cover) != _cover:
        raise AssertionError(
            f"rank {_rank} names both {_RANK_COVER[_rank]!r} and {_cover!r} in GREEN_COVER;"
            " a rank must name exactly one cover class -- see vegetation.surfaces"
        )
del _tag, _cover, _rank

# Kept for the two callers outside this module that name them, and derived from
# the table rather than repeated, so the two cannot drift.
GREEN_LEISURE = {v for (k, v) in GREEN_COVER if k == "leisure"}
GREEN_LANDUSE = {v for (k, v) in GREEN_COVER if k == "landuse"}
GREEN_NATURAL = {v for (k, v) in GREEN_COVER if k == "natural"}

# Below this a polygon is a planter box or a traffic island, and the vertices it
# costs are worth more than the two square metres of green it draws.
#
# Applied to `mown` only. A 40 m2 floor over bushland would drop 40% of the
# `natural=scrub` polygons in the extent -- they are road-reserve regrowth and
# gully slivers, they are genuinely that small, and dropping them puts bare dirt
# stripes through otherwise continuous bush. Bushland's floor is `MIN_BUSH_AREA`,
# low enough to keep those and high enough to refuse a digitising artefact.
MIN_GREEN_AREA = 40.0
MIN_BUSH_AREA = 8.0

#: A cover class that is a `boundary=` tag has no `landuse` or `natural` of its
#: own to be caught by the roof-garden test, and does not need one.
_ROOF_KEYS = ("leisure", "landuse", "natural", "landcover")


@dataclass
class OsmGreen:
    osm_id: str
    polygon: BaseGeometry  # shapely Polygon in ENU metres
    kind: str  # the tag value that selected it, e.g. 'park', 'wood'
    # A park proper takes specimen trees; a sports pitch and a playground must
    # stay clear, and the scatter reads that off this rather than off `kind` so
    # the rule is stated once.
    plantable: bool
    # What grows here, and how strong the claim is. See `GREEN_COVER`. Both are
    # decided per polygon at the read; the *spatial* half of the same rule --
    # which class wins where two polygons overlap on the ground -- is
    # `vegetation.py`'s, because it needs the geometry of every neighbour.
    cover: str = COVER_MOWN
    rank: int = 1


# A pitch is a playing surface and a playground is soft-fall and equipment.
# Both are green underfoot and neither has trees standing in the middle of it.
_UNPLANTABLE = {"pitch", "playground"}


def classify_green(a: dict[str, Any]) -> tuple[str, str, int] | None:
    """`(kind, cover, rank)` for one tag dict, or `None` if it is not green.

    The lowest rank any of its tags carries wins -- so a way tagged
    `boundary=protected_area` + `natural=wood` is forest by the wood (rank 6)
    rather than by the boundary (rank 7), and one that adds `leisure=park` over
    the top of both is mown (rank 1). Pure, and exported, because
    `canopy-audit` has to be able to ask the same question of the same tags
    without re-reading the file.
    """
    best: tuple[str, str, int] | None = None
    for key in GREEN_KEYS:
        value = a.get(key)
        if not value:
            continue
        hit = GREEN_COVER.get((key, str(value)))
        if hit is None:
            continue
        cover, rank = hit
        if best is None or rank < best[2]:
            best = (str(value), cover, rank)
    return best


def read_green(radius_m: float, path: Path = PBF_PATH) -> list[OsmGreen]:
    """Every vegetated polygon inside the radius, classified, in ENU metres.

    Multipolygons are kept part by part rather than reduced to their largest
    ring the way a building is: a park with an island in the middle of a pond is
    one relation with several outer rings, and taking only the biggest would drop
    most of the Botanic Gardens. It matters far more now than it did: a national
    park is one relation with dozens of outer rings and the largest of them is
    not the park.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "multipolygons", bbox)

    out: list[OsmGreen] = []
    for geom, a in zip(geoms, attrs):
        hit = classify_green(a)
        if hit is None:
            continue
        kind, cover, rank = hit
        # A roof garden is tagged on the building outline. Painting grass at
        # ground level under the whole footprint is the one way this read can
        # produce a lawn inside a tower.
        if a.get("building"):
            continue

        floor = MIN_GREEN_AREA if cover == COVER_MOWN else MIN_BUSH_AREA
        proj = _project(geom)
        if proj.is_empty:
            continue
        for poly in proj.geoms if proj.geom_type == "MultiPolygon" else [proj]:
            if poly.geom_type != "Polygon" or poly.area < floor:
                continue
            if not _within_radius(poly, radius_m):
                continue
            out.append(
                OsmGreen(
                    osm_id=str(a.get("osm_way_id") or a.get("osm_id") or ""),
                    polygon=poly,
                    kind=kind,
                    plantable=kind not in _UNPLANTABLE,
                    cover=cover,
                    rank=rank,
                )
            )
    return out


# --- Mapped trees --------------------------------------------------------------

# Tags a `natural=tree` node can carry its identity in, most specific first.
# Sydney's inner suburbs have ~12,000 mapped trees but only a few dozen state a
# species, so this is a bonus path and never the main one -- the great majority
# fall through to context assignment in `vegetation.py`.
_TAXON_KEYS = ("species", "genus", "taxon", "species:en", "taxon:en", "genus:en")


@dataclass
class OsmTree:
    osm_id: str
    east: float
    north: float
    # Lower-cased botanical or common name, whichever was tagged. Empty when the
    # node is a bare `natural=tree`, which is the overwhelming majority.
    taxon: str
    # `height` and `diameter_crown` are tagged on a few dozen specimens in the
    # Botanic Gardens and the Domain, and those few dozen are exactly the trees
    # a player walks up to. Metres; `None` when untagged **or when the value is
    # not a length a tree can have** -- see `_as_tree_metres`.
    height: float | None
    crown_diameter: float | None


# A tree's tagged size, in metres, or `None`.
#
# `_as_float` exists for building heights and admits anything up to 600 m, which
# on a `natural=tree` node is not a permissive bound -- it is no bound at all. It
# passed `diameter_crown=40` straight through to `vegetation.py`, which clamped
# it at a 22 m radius and handed a 44 m canopy to whatever species context had
# already chosen. Two of those are the "giant floating polyhedra" the vegetation
# pass shipped.
#
# The ceiling here is the *unit* check and nothing more: past it the number is a
# circumference in centimetres, a building height copied into the wrong node, or
# a typo, and there is no reading of it that is a tree. The botanical judgement
# -- which species can carry a 33 m crown, and how far past its own range -- is
# `vegetation.py`'s and stays there.
TREE_MAX_METRES = 120.0


def _as_tree_metres(v: str | None) -> float | None:
    f = _as_float(v)
    return f if f is not None and f <= TREE_MAX_METRES else None


def read_trees(radius_m: float, path: Path = PBF_PATH) -> list[OsmTree]:
    """Every `natural=tree` node inside the radius.

    Read from `points` rather than from any of the polygon layers: a mapped tree
    is always a node, and the tree *rows* on `lines` (`natural=tree_row`, 169 of
    them here) are deliberately left for later -- they need spacing inferred
    along a way, which is the procedural street-tree path with a different input,
    not a different kind of point.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "points", bbox)

    out: list[OsmTree] = []
    for geom, a in zip(geoms, attrs):
        if a.get("natural") != "tree":
            continue
        proj = _project(geom)
        if not _within_radius(proj, radius_m):
            continue
        taxon = ""
        for key in _TAXON_KEYS:
            v = a.get(key)
            if v:
                taxon = str(v).strip().lower()
                break
        out.append(
            OsmTree(
                osm_id=str(a.get("osm_id") or ""),
                east=float(proj.x),
                north=float(proj.y),
                taxon=taxon,
                # Crown diameter is user-entered and half of it carries a unit
                # suffix ('30 m', '25m'), which `_as_float` already tolerates.
                # `circumference` is deliberately not read: it is the trunk
                # girth, and reading it as a crown is how a street tree ends up
                # with a forty-metre canopy.
                height=_as_tree_metres(a.get("height")),
                crown_diameter=_as_tree_metres(a.get("diameter_crown")),
            )
        )
    return out


# --- Retail frontage ----------------------------------------------------------

# Tags that mark a street as a retail strip. The spec singles out the ground
# floor shopfront override as the single highest-value rule in the grammar, so
# getting this set right matters more than it looks.
RETAIL_AMENITIES = {"cafe", "restaurant", "fast_food", "pub", "bar", "bank", "pharmacy", "post_office"}


def read_retail_points(radius_m: float, path: Path = PBF_PATH) -> np.ndarray:
    """(N, 2) ENU positions of shops and retail amenities.

    A building whose street-facing edge is near a cluster of these gets the
    shopfront ground-floor treatment. Derived from actual retail presence rather
    than from street classification, because Sydney's retail strips sit on
    residential-classed roads as often as not.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    pts: list[tuple[float, float]] = []
    for layer in ("points", "multipolygons"):
        geoms, attrs = _read_layer(path, layer, bbox)
        for geom, a in zip(geoms, attrs):
            if not (a.get("shop") or a.get("amenity") in RETAIL_AMENITIES):
                continue
            proj = _project(geom)
            if not _within_radius(proj, radius_m):
                continue
            c = proj.centroid
            pts.append((float(c.x), float(c.y)))
    return np.asarray(pts, dtype=np.float64) if pts else np.zeros((0, 2))


# --- Cache --------------------------------------------------------------------


def cache_path(name: str, radius_m: float) -> Path:
    return config.CACHE_DIR / f"osm-{name}-{int(radius_m)}.json"


def write_cache(name: str, radius_m: float, payload: Any) -> Path:
    p = cache_path(name, radius_m)
    p.write_text(json.dumps(payload))
    return p
