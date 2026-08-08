"""Unify the two footprint sources into one non-overlapping building set.

Why this module exists: the spec makes Microsoft the footprint source and OSM the
attribute source. The measured data says that split produces a hole exactly where
the game is most likely to be played. Within 500 m of the CBD origin, Microsoft's
ML segmentation finds 71 buildings; OSM finds 393, with real heights on the
towers. Microsoft's advantage is the opposite end of the extent -- it covers
suburban sprawl that no one has hand-mapped.

So the rule is: OSM footprint wins wherever one exists, Microsoft fills the gaps.
Overlap is detected geometrically rather than by ID, because the two datasets
share no identifiers.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import geo
from .sources import msbuildings, osm

# A Microsoft footprint is considered a duplicate of the OSM mapping if its
# centroid falls inside an OSM polygon, or if OSM polygons **together** cover
# more than this fraction of the Microsoft polygon's area. The centroid test
# alone misses the common case where OSM maps a terrace row as one polygon and
# Microsoft splits it per house; the area test catches those.
#
# "Together" is doing real work and it is the correction to this module's first
# version, which measured the overlap against one OSM polygon at a time. That
# reading is exactly right for the case the paragraph above describes -- OSM
# coarse, Microsoft fine -- and it fails completely in the mirror image of it,
# which is the one the inner suburbs are full of: an ML segmentation that
# swallows a whole block of terraces into one 5,000 m^2 blob. Each of the thirty
# OSM houses under it covers 2% of the blob, no single test ever reaches 35%,
# the blob's centroid lands in a courtyard or a laneway rather than inside any
# one house -- so it was kept, laid on top of thirty hand-mapped buildings and
# extruded to a featureless twelve-metre box lying across the street.
#
# 193 of the 17,421 Microsoft footprints in the inner ring were being kept that
# way, the largest 13,278 m^2 with 22 OSM buildings and 85% of its own area
# already mapped underneath it. Unioning the candidates before measuring is the
# whole fix; the threshold is unchanged, because the threshold was never the
# thing that was wrong.
OVERLAP_FRACTION = 0.35

# Separates a row's id from the index of one house cut out of it by `rows.py`.
# Lives here because this module owns the id format -- the `o`/`m` namespacing
# below is the other half of the same contract -- and because both `rows` (which
# writes these ids) and `attributes` (which asks whether a building is one house
# of a row) need it without either importing the other.
#
# It must be a character no source id can contain, so an id can be taken apart
# unambiguously, and it must survive a round trip through the `buildings` table
# and `mesh.facade_seed`. `#` satisfies both; note that it is *not* hex, which is
# why `mesh.facade_seed` cannot simply parse the id's tail.
ROW_SLICE_SEP = "#"


@dataclass
class Building:
    """One building, source-agnostic, ready for attribute inference.

    THE WINDING INVARIANT, and it is the load-bearing thing about this class.
    `ring` is wound **counter-clockwise in ENU** and every hole **clockwise**,
    normalised by `orient_footprint` at construction, on both source paths and
    on the round trip back out of the `buildings` table. Nothing downstream may
    assume otherwise and nothing downstream has to measure it.

    Why the invariant lives here rather than in each consumer: the outward side
    of a wall is the right of travel *only* for a known winding, and this data
    does not have one -- 18,371 of the merged set's rings arrive
    counter-clockwise and 15,473 clockwise, because Microsoft's loader forces
    its own (`sources/msbuildings.parse_partition`) and OSM's does not. Every
    consumer that needed "which way is out" was therefore either measuring it
    again (`contact._outward_ring`, `mesh._ccw_ring`, `DoorNetwork._prepare`) or
    quietly getting it wrong, and `mesh.build_walls` was the one that got it
    wrong: it emitted a winding and a normal that are exact negatives, so on
    every building one of the two was inverted and *which* one depended on the
    ring. Measured over five tiles before this went in, 61% of buildings had
    every wall triangle facing inward. Normalising once here is what makes
    "outward is the right of travel" true by construction rather than by
    measurement repeated in five places.
    """

    id: str
    source: str  # 'osm' | 'ms'
    ring: np.ndarray  # (N, 2) ENU metres, counter-clockwise
    holes: list[np.ndarray] = field(default_factory=list)  # each clockwise
    area: float = 0.0
    centroid: tuple[float, float] = (0.0, 0.0)

    # Attributes as found in source data. None means "not stated", which is
    # different from a value the classifier inferred later.
    osm_id: str | None = None
    name: str | None = None
    building_type: str | None = None
    levels: int | None = None
    stated_height: float | None = None
    ms_height: float | None = None
    material: str | None = None
    colour: str | None = None
    roof_shape: str | None = None
    roof_material: str | None = None
    start_date: str | None = None
    heritage: bool = False
    amenity: str | None = None
    shop: str | None = None

    # What the source said about the structure not starting at the ground, and
    # about it being a bridge. Carried raw and undecided, because the decision
    # needs the terrain and the road network and neither exists at ingest --
    # see `elevated.py`, which is the only reader of all five.
    min_height: float | None = None
    min_level: int | None = None
    bridge: bool = False
    man_made: str | None = None
    layer: int = 0

    # Filled by attributes.py
    height: float = 0.0
    height_source: str = ""
    archetype: str = ""
    retail: bool = False
    roof_form: str = ""

    # Filled by elevated.py: metres from this building's pad to the underside of
    # its prism. Zero for everything that stands on the ground, which is all but
    # a few dozen structures in the extent.
    #
    # It is *not* a world y and deliberately not one: the pad is measured at
    # emission by `tiles._pad_and_skirt` against a terrain this class knows
    # nothing about, so a base held as an absolute height would be a second
    # answer to "where is the ground here" that could disagree with the first.
    # `height` means the prism's own height once this is non-zero -- roof minus
    # soffit, not roof minus ground -- which is exactly what
    # `tiles.write_collision` documents its height word to be.
    base_height: float = 0.0

    @property
    def tile(self) -> str:
        return geo.tile_for_enu(*self.centroid).key

    @property
    def row_slice(self) -> bool:
        """One house cut out of a terrace row mapped as a single polygon.

        Derived from the id rather than carried as a field so it survives the
        round trip through the `buildings` table for free -- a `--retile` without
        a `--rebuild` reads the table back and would otherwise lose it.
        """
        return ROW_SLICE_SEP in self.id


def twice_signed_area(ring: np.ndarray) -> float:
    """The shoelace sum of a ring in ENU. Positive is counter-clockwise.

    Twice the area rather than the area, because every caller wants either the
    sign or a comparison against a threshold and neither needs the halving.
    Correct on a closed ring as well as an open one -- the repeated closing
    vertex contributes a zero cross term.
    """
    r = np.asarray(ring, dtype=np.float64)
    if len(r) < 3:
        return 0.0
    x, y = r[:, 0], r[:, 1]
    return float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def orient_footprint(
    ring: np.ndarray, holes: list[np.ndarray] | None = None
) -> tuple[np.ndarray, list[np.ndarray]]:
    """A footprint wound to the `Building` invariant: exterior CCW, holes CW.

    THE one place the project decides which way a footprint goes round, and it
    is deliberately a reversal rather than a re-projection: a reversed ring has
    exactly the same vertices in the same positions, so nothing that has already
    been measured off it -- area, centroid, the oriented rectangle, the row
    slicer's cut positions -- can move by a millimetre. Only the *order*
    changes, and order is the only thing the invariant is about.

    Holes go the other way because that is what every polygon library, glTF and
    the ear clipper all mean by a hole, and because it makes the sign of
    `twice_signed_area` a direct test of "is this an outer boundary".

    Idempotent, so it is safe on the `buildings` table's round trip as well as
    on freshly read source geometry.
    """
    r = np.asarray(ring, dtype=np.float64)
    if twice_signed_area(r) < 0.0:
        r = r[::-1]
    out: list[np.ndarray] = []
    for h in holes or ():
        hh = np.asarray(h, dtype=np.float64)
        if twice_signed_area(hh) > 0.0:
            hh = hh[::-1]
        out.append(hh)
    return r, out


def _from_osm(b: osm.OsmBuilding) -> Building:
    ring, holes = orient_footprint(b.ring, b.holes)
    return Building(
        # Namespaced so an OSM way id can never collide with a Microsoft
        # geometry hash, and so the facade seed is stable per source.
        id=f"o{b.osm_id}",
        source="osm",
        ring=ring,
        holes=holes,
        area=b.area,
        centroid=b.centroid,
        osm_id=b.osm_id,
        name=b.name,
        building_type=b.building,
        levels=b.levels,
        stated_height=b.height,
        material=b.material,
        colour=b.colour,
        roof_shape=b.roof_shape,
        roof_material=b.roof_material,
        start_date=b.start_date,
        heritage=b.heritage,
        amenity=b.amenity,
        shop=b.shop,
        min_height=b.min_height,
        min_level=b.min_level,
        bridge=b.bridge,
        man_made=b.man_made,
        layer=b.layer,
    )


def _from_ms(f: msbuildings.Footprint) -> Building:
    # `parse_partition` already forces these counter-clockwise. Run through the
    # same call anyway rather than trusting a second module to keep doing it:
    # it is one shoelace on a ring that is already right, and the invariant is
    # stated in one place instead of two.
    ring, _ = orient_footprint(f.ring)
    return Building(
        id=f"m{f.id}",
        source="ms",
        ring=ring,
        area=f.area,
        centroid=f.centroid,
        ms_height=f.ms_height,
    )


def merge(
    osm_buildings: list[osm.OsmBuilding], ms_footprints: list[msbuildings.Footprint]
) -> tuple[list[Building], dict[str, int]]:
    """OSM first, then Microsoft footprints that do not duplicate an OSM one."""
    out = [_from_osm(b) for b in osm_buildings]

    osm_polys = [Polygon(b.ring, b.holes) for b in osm_buildings]
    valid = [(p if p.is_valid else p.buffer(0)) for p in osm_polys]
    tree = STRtree(valid)

    dropped = 0
    dropped_by_union = 0
    for f in ms_footprints:
        cand = tree.query(Polygon(f.ring).envelope)
        if len(cand):
            ms_poly = Polygon(f.ring)
            if not ms_poly.is_valid:
                ms_poly = ms_poly.buffer(0)
            hit = False
            union_hit = False
            for i in cand:
                other = valid[i]
                if other.is_empty:
                    continue
                if other.contains(ms_poly.centroid):
                    hit = True
                    break
                inter = ms_poly.intersection(other).area
                if ms_poly.area > 0 and inter / ms_poly.area > OVERLAP_FRACTION:
                    hit = True
                    break
            if not hit and ms_poly.area > 0:
                # The blob case. Unioned rather than summed: the OSM polygons
                # under one footprint are neighbours and touch, and summing
                # their intersections double-counts every shared party wall.
                near = [valid[i] for i in cand if not valid[i].is_empty]
                covered = ms_poly.intersection(unary_union(near)).area if near else 0.0
                if covered / ms_poly.area > OVERLAP_FRACTION:
                    hit = union_hit = True
            if hit:
                dropped += 1
                dropped_by_union += union_hit
                continue
        out.append(_from_ms(f))

    stats = {
        "osm": len(osm_buildings),
        "ms_input": len(ms_footprints),
        "ms_dropped_as_duplicate": dropped,
        # Called out separately because it is the count that says whether the
        # ML blobs are being caught -- it went 0 -> 193 when the union test
        # went in, and a build where it returns to 0 has lost the test.
        "ms_dropped_as_blob": dropped_by_union,
        "ms_kept": len(ms_footprints) - dropped,
        "total": len(out),
    }
    return out, stats


def store(con: sqlite3.Connection, buildings: list[Building]) -> int:
    """Replace the buildings table with this set.

    A full replace rather than an upsert: the merge decision depends on the whole
    input, so a partial update could leave a Microsoft footprint standing inside
    an OSM building added later. The table is a derived artefact and rebuilding
    it from cached sources takes under a minute.

    Rings go out in the order they are held in, so the winding invariant on
    `Building` survives the round trip. The 1 cm rounding below cannot change
    the order and therefore cannot change the winding -- but it *can* collapse a
    sliver to zero area, so `cli._read_buildings_table` re-orients on the way
    back in rather than assuming. `orient_footprint` is idempotent, so that
    costs one shoelace per building on a `--retile`.
    """
    con.execute("DELETE FROM buildings")
    rows = [
        (
            b.id,
            b.tile,
            b.centroid[0],
            b.centroid[1],
            b.area,
            b.height or None,
            b.height_source or None,
            b.levels,
            b.roof_form or None,
            b.archetype or None,
            b.material,
            int(b.retail),
            b.start_date,
            json.dumps(
                {
                    "ring": [[round(x, 2), round(y, 2)] for x, y in b.ring],
                    "holes": [[[round(x, 2), round(y, 2)] for x, y in h] for h in b.holes],
                    "source": b.source,
                    "name": b.name,
                    "type": b.building_type,
                    # The elevation tags ride here rather than in columns of
                    # their own, on the same terms `source`, `name` and `type`
                    # already do: they are read by exactly one pass, they are
                    # never queried, and adding four columns to a 470,000-row
                    # table for tags that fewer than 3,000 rows carry is a
                    # migration for nothing. Written only when present, so the
                    # blob is unchanged for every building that has none.
                    **({"min_height": b.min_height} if b.min_height is not None else {}),
                    **({"min_level": b.min_level} if b.min_level else {}),
                    **({"bridge": True} if b.bridge else {}),
                    **({"man_made": b.man_made} if b.man_made else {}),
                    **({"layer": b.layer} if b.layer else {}),
                }
            ),
        )
        for b in buildings
    ]
    con.executemany(
        "INSERT OR REPLACE INTO buildings"
        " (id, tile, east, north, area, height, height_source, levels, roof_form,"
        "  archetype, material, retail, start_date, geometry)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    return len(rows)
