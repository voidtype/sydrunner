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

AND OSM WINS AGAINST ITSELF TOO, which is the half of that sentence this module
did not implement for a long time and `server/clash-check.ts` costed at 4,850
overlapping pairs and 687,629 m2 of shared footprint. Two of the three ways a
building ends up drawn twice were never tested:

  * **OSM against OSM.** `merge` took the OSM list whole -- literally
    `out = [_from_osm(b) for b in osm_buildings]` -- so the one source that is
    hand-mapped by thousands of people, and therefore the one where the same
    warehouse gets drawn twice by two of them, was the one nothing checked. The
    top of that audit's table was *exact* duplicates: `61,572 m2 shared of
    61,572 m2`, twice. `_dedupe_osm` is that test, at the same fraction.
  * **A Microsoft blob measured against its own area.** The union test below was
    written for an ML segmentation that swallows a block of terraces, and it
    fixed *what* is measured while leaving *what it is measured against*: a
    3,017 m2 blob over seven hand-mapped 50 m2 terraces is 14% covered and
    survived, and shipped lying across all seven. Measured against the smaller
    of the two sides it does not. `SWALLOW_FLOOR` is what keeps that sentence
    from deleting a real warehouse for having a mapped kiosk inside it.

Both are the same threshold, `OVERLAP_FRACTION`, on the same argument, and both
have a control in `verify` that convicts the duplicate *and* excuses the party
wall -- because a filter over the building list is the one thing in this pass
that can quietly delete the city, and its report is a count.
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

# The floor under the swallow test: how much of a Microsoft footprint has to be
# hand-mapped before OSM is allowed to delete the whole thing.
#
# THE CASE THIS EXISTS TO REFUSE. `merge`'s swallow test drops a footprint when
# the OSM under it is mostly inside it, measured on the OSM side -- which is
# right for an ML blob laid over a block of terraces and catastrophic without a
# floor, because a genuine 3,000 m2 warehouse with one hand-mapped 20 m2 kiosk
# inside it satisfies "the OSM under it is 100% covered" just as completely. A
# ratio alone cannot separate the two; how much of the footprint OSM actually
# accounts for can.
#
# A tenth, and it is measured rather than guessed. Every footprint the swallow
# test catches over the 60 km carries between 14% and 35% of its own area in
# hand-mapped buildings that are mostly inside it -- these are blobs two to five
# times what is under them, not a hundred times -- so a tenth clears every real
# case and still refuses a footprint that is 99% unexplained ground. Under this
# line the ML footprint is the only thing saying a building is there at all, and
# deleting it costs the world a building rather than an overlap.
SWALLOW_FLOOR = 0.10

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


def _detail(b: Building) -> int:
    """How much this mapping actually says about the building.

    The tie-breaker when one footprint has been drawn twice, and the only
    defensible one: neither copy is from a better *source* -- they are both OSM
    -- so the one to keep is the one a player gets more of. A stated height or a
    level count changes the building's own shape; a name, a material, a colour, a
    roof shape and an amenity all reach `attributes.apply` and change what it is
    made of. `building=yes` is not a statement and does not count.
    """
    return sum(
        1
        for v in (
            b.name,
            b.stated_height,
            b.levels,
            b.building_type if b.building_type not in (None, "yes") else None,
            b.material,
            b.colour,
            b.roof_shape,
            b.roof_material,
            b.amenity,
            b.shop,
            b.start_date,
            True if b.heritage else None,
        )
        if v is not None
    )


def _dedupe_osm(out: list[Building]) -> tuple[list[int], dict[str, int]]:
    """The indices of `out` that survive: one of every duplicated pair goes.

    Indices rather than the buildings themselves so `merge` can drop the same
    entries out of the raw `osm_buildings` list in lockstep -- the two lists are
    parallel, and an id is not a key here: nothing guarantees OSM hands back two
    distinct polygons with distinct way ids.

    ---------------------------------------------------------------------------
    **Nothing in this build compared OSM against OSM, and 4,850 overlapping pairs
    is what that cost.** `merge` below deduplicates Microsoft against OSM with a
    unioned 35% overlap test and then takes the OSM list whole -- the line was
    `out = [_from_osm(b) for b in osm_buildings]`, unconditionally -- so the one
    source that is hand-mapped by thousands of people, and therefore the one
    source where the same warehouse gets drawn twice by two of them, was the one
    nothing checked. `server/clash-check.ts` found the top of that table to be
    *exact* duplicates: `61,572 m2 shared of 61,572 m2`, twice; `11,456 of
    11,456`; `9,807 of 9,807`. One footprint, extruded twice, z-fighting with
    itself for the whole height of the building.

    So this is the test that module already has, turned on its own OSM input, at
    the same `OVERLAP_FRACTION`. **Pairwise and not unioned**, which is the one
    place it deliberately differs: the union form exists for an ML blob laid over
    a block of hand-mapped terraces, and its mirror image in OSM -- a mapped
    block outline over the houses inside it -- is a case where dropping the big
    polygon and dropping the small ones are both defensible and the pipeline has
    no way to tell which the mapper meant. A pair that shares more than a third
    of the smaller of the two is not that case; it is one building drawn twice.

    WHICH ONE GOES. `_detail`, then area, then the id -- in that order, and the
    order matters. Source cannot decide it here, and "keep the first" would make
    the world a function of the order libgdal hands back a multipolygon layer.

    WHAT IT LEAVES ALONE. A bridge. `elevated.py` turns a `bridge` way into a
    structural prism with air under it, so a deck over a building is
    `DECK_IN_BUILDING` -- a different row of that audit and a different fix --
    and collapsing the two into one footprint here would delete a viaduct for
    crossing a warehouse.
    """
    polys = [Polygon(b.ring, b.holes) for b in out]
    valid = [(p if p.is_valid else p.buffer(0)) for p in polys]
    tree = STRtree(valid)

    # Largest first, then by id: a deterministic walk, so the pair's loser does
    # not depend on the order the source layer was read in.
    order = sorted(range(len(out)), key=lambda i: (-out[i].area, out[i].id))
    dropped: set[int] = set()
    exact = 0
    for i in order:
        if i in dropped:
            continue
        a = valid[i]
        if a.is_empty or out[i].bridge:
            continue
        for j in tree.query(a.envelope):
            j = int(j)
            if j == i or j in dropped or valid[j].is_empty or out[j].bridge:
                continue
            smaller = min(a.area, valid[j].area)
            if smaller <= 0.0:
                continue
            shared = a.intersection(valid[j]).area
            if shared <= smaller * OVERLAP_FRACTION:
                continue
            if shared >= smaller * 0.999:
                exact += 1
            loser = j if _rank(out[i]) >= _rank(out[j]) else i
            dropped.add(loser)
            if loser == i:
                break
    keep = [k for k in range(len(out)) if k not in dropped]
    return keep, {
        "osm_dropped_as_duplicate": len(dropped),
        # Called out separately for the same reason `ms_dropped_as_blob` is: it
        # is the count that says the top of the audit's table went, and a build
        # where it returns to 0 has lost the test.
        "osm_dropped_exact": exact,
    }


def _rank(b: Building) -> tuple[int, float, str]:
    """Higher wins the pair. See `_dedupe_osm`."""
    return (_detail(b), b.area, b.id)


def verify() -> list[str]:
    """The control on `_dedupe_osm`: what it must drop, and what it must not.

    A filter over the building list is the one place in this pass that can
    quietly delete the city -- `landmarks.suppress` says the same about itself --
    and its report is a count, which cannot tell "the duplicates went" from "the
    terraces went". So both cases go through the real function: a footprint drawn
    twice must lose one copy and the copy kept must be the one that says more,
    and a terrace row's party wall must survive, in both orders.
    """
    import numpy as np

    def mk(i: int, ring, **kw) -> Building:
        r = np.asarray(ring, dtype=float)
        return Building(id=f"o{i}", source="osm", ring=r, area=Polygon(r).area, **kw)

    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    # Sharing the long edge and nothing else, which is what a terrace row is.
    neighbour = [(10.0, 0.0), (20.0, 0.0), (20.0, 10.0), (10.0, 10.0)]
    bad: list[str] = []

    rich = mk(1, square, name="Marrickville Metro", levels=3)
    bare = mk(2, square)
    for pair, label in (([rich, bare], "rich first"), ([bare, rich], "bare first")):
        keep, stats = _dedupe_osm(pair)
        if len(keep) != 1:
            bad.append(f"merge: a footprint drawn twice survives twice ({label})")
        elif pair[keep[0]].name != "Marrickville Metro":
            bad.append(f"merge: the copy with a name and a level count is the one dropped ({label})")
        if stats["osm_dropped_exact"] != 1:
            bad.append(f"merge: an exact duplicate is not counted as one ({label})")

    keep, _ = _dedupe_osm([mk(1, square), mk(2, neighbour)])
    if len(keep) != 2:
        bad.append(
            f"merge: two footprints sharing a party wall are deduplicated;"
            f" OVERLAP_FRACTION is {OVERLAP_FRACTION} and the count is terraces"
        )

    deck = mk(2, square)
    deck.bridge = True
    if len(_dedupe_osm([mk(1, square), deck])[0]) != 2:
        bad.append("merge: a bridge over a building is deduplicated against it")

    bad += _verify_swallow()
    return bad


def _verify_swallow() -> list[str]:
    """The control on the Microsoft side: the blob goes, the neighbour stays.

    Griffin Street in miniature. A 40 x 40 m ML footprint with four 10 x 10 m
    hand-mapped houses under it is 25% covered, which is under
    `OVERLAP_FRACTION` on its own area and 100% of theirs, and it is the case
    that shipped. Two more go through beside it, because a filter that could
    only ever convict would prove nothing: the same blob with one house clipping
    its corner, which is two buildings that touch and not one drawn twice; and
    the same blob with a single 4 x 4 m shed inside it, which is 100% of the OSM
    and 1% of the footprint -- the warehouse-and-kiosk case `SWALLOW_FLOOR`
    exists for, and the one where deleting the blob costs the world a building.
    """
    import numpy as np

    class _Ms:
        def __init__(self, ring, ident):
            self.ring = np.asarray(ring, dtype=float)
            self.id = ident
            self.area = Polygon(self.ring).area
            self.centroid = tuple(Polygon(self.ring).centroid.coords)[0]
            self.ms_height = None

    class _Osm:
        def __init__(self, ring, ident):
            self.ring = np.asarray(ring, dtype=float)
            self.holes: list = []
            self.osm_id = str(ident)
            self.area = Polygon(self.ring).area
            self.centroid = tuple(Polygon(self.ring).centroid.coords)[0]
            for a in (
                "name building levels height material colour roof_shape roof_material"
                " start_date amenity shop min_height min_level man_made"
            ).split():
                setattr(self, a, None)
            self.heritage = False
            self.bridge = False
            self.layer = 0

    def sq(x, y, w):
        return [(x, y), (x + w, y), (x + w, y + w), (x, y + w)]

    blob = _Ms(sq(0, 0, 40), "blob")
    # Four houses inside it, apart from each other: 400 m2 of the blob's 1,600.
    houses = [
        _Osm(sq(2, 2, 10), 1), _Osm(sq(26, 2, 10), 2),
        _Osm(sq(2, 26, 10), 3), _Osm(sq(26, 26, 10), 4),
    ]
    bad: list[str] = []
    out, stats = merge(houses, [blob])
    if stats["ms_dropped_as_swallow"] != 1:
        bad.append(
            "merge: an ML blob covering four hand-mapped houses whole is kept;"
            f" it is {100 * 400 / 1600:.0f}% of its own area and 100% of theirs"
        )
    if any(b.source == "ms" for b in out):
        bad.append("merge: the blob survived the swallow test")

    # Crown Street: one hand-mapped block mostly under a footprint three times
    # its size, with an untouched neighbour whose bounding box reaches the
    # footprint and whose only job here is to inflate a union denominator. It is
    # the case the first version of this test let through, so it is the case with
    # a control on it.
    # 256 m2 of the footprint's 1,600 -- 16%, under `OVERLAP_FRACTION` on the
    # footprint's own area and over `SWALLOW_FLOOR` -- and clear of the
    # footprint's centroid, so neither test above can reach it. The neighbour is
    # 900 m2 that touches nothing: unioned in, the covered share falls to 22% and
    # the footprint survives, which is what Crown Street did.
    blob = _Ms(sq(0, 0, 40), "blob")
    block = _Osm(sq(2, 2, 16), 7)
    away = _Osm(sq(41, 30, 30), 8)
    out, stats = merge([block, away], [blob])
    if stats["ms_dropped_as_swallow"] != 1:
        bad.append(
            "merge: a footprint sitting whole on a hand-mapped block is kept because an"
            " untouched neighbour joined the denominator -- ask it per polygon, not of the union"
        )
    if any(b.source == "ms" for b in out):
        bad.append("merge: the Crown Street footprint survived")

    # And the two that must survive. First the neighbour, clipping the corner.
    out, stats = merge([_Osm(sq(-7.5, -7.5, 10), 5)], [_Ms(sq(0, 0, 40), "blob")])
    if stats["ms_dropped_as_duplicate"] != 0:
        bad.append(
            "merge: a footprint a neighbour clips the corner of is deduplicated;"
            f" OVERLAP_FRACTION is {OVERLAP_FRACTION} and the Microsoft set is being deleted"
        )
    # Then the warehouse with a kiosk in it: 16 m2 of hand mapping, 1% of the
    # footprint, and the footprint is the only thing that says the warehouse is
    # there. 100% of the OSM is inside it and it must survive anyway.
    out, stats = merge([_Osm(sq(4, 4, 4), 6)], [_Ms(sq(0, 0, 40), "blob")])
    if stats["ms_dropped_as_duplicate"] != 0:
        bad.append(
            "merge: a footprint with one small mapped building inside it is deleted;"
            f" SWALLOW_FLOOR is {SWALLOW_FLOOR} and does nothing"
        )
    if not any(b.source == "ms" for b in out):
        bad.append("merge: the warehouse went with its kiosk")
    return bad


def merge(
    osm_buildings: list[osm.OsmBuilding], ms_footprints: list[msbuildings.Footprint]
) -> tuple[list[Building], dict[str, int]]:
    """OSM first -- deduplicated against itself -- then Microsoft's gaps."""
    osm_all = [_from_osm(b) for b in osm_buildings]
    kept, osm_stats = _dedupe_osm(osm_all)
    out = [osm_all[i] for i in kept]
    # In lockstep, so the Microsoft pass below measures itself against the OSM
    # set that is actually going into the world. A duplicate left in the tree
    # here would keep on suppressing the Microsoft footprint under it after the
    # OSM copy it duplicates had already been dropped.
    osm_buildings = [osm_buildings[i] for i in kept]

    osm_polys = [Polygon(b.ring, b.holes) for b in osm_buildings]
    valid = [(p if p.is_valid else p.buffer(0)) for p in osm_polys]
    tree = STRtree(valid)

    dropped = 0
    dropped_by_union = 0
    dropped_by_swallow = 0
    for f in ms_footprints:
        cand = tree.query(Polygon(f.ring).envelope)
        if len(cand):
            ms_poly = Polygon(f.ring)
            if not ms_poly.is_valid:
                ms_poly = ms_poly.buffer(0)
            hit = False
            union_hit = False
            swallow_hit = False
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
                # ...and the swallow case, which is the half of that the union
                # test above still cannot see however it is unioned.
                #
                # A 3,017 m2 ML blob laid over seven hand-mapped 50 m2 terraces on
                # Griffin Street is 14% covered, so it passed every test above and
                # shipped, lying across all seven -- the exact failure this
                # module's header describes and believed the union had closed. It
                # had not: the union fixed *what* is measured and left *what it is
                # measured against*, and against its own area a blob can always be
                # big enough to survive. The rule this module states is "OSM
                # footprint wins wherever one exists", and a footprint that
                # swallows a hand-mapped building is not filling a gap.
                #
                # **Asked per OSM polygon and not of the union**, which is the
                # correction to the first version of this test and is not a
                # nicety: `near` is everything whose *envelope* meets the
                # footprint's, so an untouched neighbour twenty metres away joins
                # the union and inflates the denominator. On Crown Street that
                # left a 1,472 m2 footprint sitting on 89% of a 247 m2 brutalist
                # block, still convicted by `clash-check` after the sweep had run.
                # So a polygon counts as swallowed when *it* is mostly inside the
                # footprint, and the footprint goes when the ones that are add up
                # to a real share of it -- the union only of what is genuinely
                # underneath. Over the 60 km this drops **1,228** footprints of
                # 1,157,238 -- the tail, not the suburbs -- against 692 when the
                # denominator was the whole union.
                #
                # `SWALLOW_FLOOR` is that share, and it is what stops the same
                # sentence deleting a real warehouse for having one mapped kiosk
                # in it; see that constant.
                if not hit:
                    swallowed = [
                        o for o in near
                        if ms_poly.intersection(o).area > OVERLAP_FRACTION * o.area
                    ]
                    if swallowed:
                        under = ms_poly.intersection(unary_union(swallowed)).area
                        if under / ms_poly.area >= SWALLOW_FLOOR:
                            hit = swallow_hit = True
            if hit:
                dropped += 1
                dropped_by_union += union_hit
                dropped_by_swallow += swallow_hit
                continue
        out.append(_from_ms(f))

    stats = {
        "osm_input": len(osm_all),
        **osm_stats,
        "osm": len(osm_buildings),
        "ms_input": len(ms_footprints),
        "ms_dropped_as_duplicate": dropped,
        # Called out separately because it is the count that says whether the
        # ML blobs are being caught -- it went 0 -> 193 when the union test
        # went in, and a build where it returns to 0 has lost the test.
        "ms_dropped_as_blob": dropped_by_union,
        # And the other half of the blob case: the footprint bigger than what it
        # covers, caught on the OSM side of the fraction rather than its own.
        # Counted apart from `ms_dropped_as_blob` for the same reason that one is
        # counted apart from the total, and a build where it returns to 0 has
        # lost the test. 1,228 over the 60 km, against 1,748 caught on the
        # footprint's own side.
        "ms_dropped_as_swallow": dropped_by_swallow,
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
