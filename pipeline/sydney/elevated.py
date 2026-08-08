"""Structures that do not start at the ground: bridges, and the blobs that ate them.

THE BUG THIS MODULE EXISTS FOR. Every footprint in the build was extruded from
the terrain pad to its roof, because that is what a building is and nothing in
the pipeline had ever been told otherwise. `min_height` and `building:min_level`
-- OSM's two ways of saying "the underside of this thing is in the air" --
appeared zero times in the whole project, and neither did any test for whether a
footprint was lying across a road.

The visible result was a wall. A pedestrian overbridge at Spit Junction came out
as 6 m of solid warehouse across both carriageways of Military Road; the
footbridge over Longueville Road at Lane Cove came out as a 3 m brick box across
a primary road. Neither is a rendering artefact the player can shrug at -- they
are the road being closed, in a game whose whole verb is running down roads.

---------------------------------------------------------------------------
**Where the offending polygons actually come from, which was the surprise.**

Not from OSM's bridge tagging. The extract has 14 `building=bridge` polygons, 1
building with `bridge=yes` and 44 `man_made=bridge` areas, and *none of them* is
at either place the user reported. The polygons walling those two roads are
**Microsoft ML footprints**, which carry no tags at all:

  * `m696b26492b53328c` -- 268 m^2, Lane Cove. Its plan is the deck of OSM way
    22917347 (`highway=footway`, `bridge=yes`, `layer=1`), and 23 m of
    Longueville Road's centreline runs through it. Microsoft's segmentation saw
    a flat roof-shaped surface over the road and called it a building.
  * `m98a07f15dfdfbcbf` -- 3,838 m^2, Mosman. The Bridgepoint/Mosman Junction
    retail block *plus* the pedestrian span over Military Road, swallowed into
    one blob, lying 3 m from OSM ways 171360583 and 1507639952 (both
    `highway=footway`, `bridge=yes`, `layer=1`). 22 m of Military Road's two
    carriageway centrelines run through it.

So a tag-driven fix alone would have shipped and changed nothing at either
place. The rule has to be geometric as well, and the geometry has to be
corroborated, because "a road centreline runs through this polygon" is true of
1,650 of the 470,457 footprints in the ledger and the overwhelming majority of
those are a car-park ramp or a service driveway drawn through a real building --
Westfield Burwood, Macquarie Centre, the airport terminals. Carving a slot
through those would be a far worse bug than the one being fixed.

---------------------------------------------------------------------------
**The rule, stated once.**

A footprint is *over-road* when a **public** ground carriageway's centreline
runs through its interior for `SPAN_MIN_M` or more. Public is deliberately
`osm.STREET_CLASSES` minus `service`: a service way is the driveway, the loading
dock and the car-park aisle, and a building standing over one is the normal
case rather than the broken one.

A footprint is *bridge-corroborated* when OSM says a bridge is there:

  1. the polygon itself claims it -- `building=bridge`, `bridge=yes|viaduct|
     aqueduct|boardwalk`, or `man_made=bridge`; or
  2. the polygon carries `layer >= 1`; or
  3. the polygon lies within `BRIDGE_WAY_REACH_M` of an OSM **way** tagged
     `bridge` at `layer >= 1` -- which is the clause that catches the untagged
     Microsoft blobs, and it is evidence rather than inference: OSM has mapped a
     bridge, and this polygon is sitting on it.

Then, in order:

  * **Stated base.** `min_height`, or `building:min_level` times the storey
    height. Applied unconditionally -- no road test, no corroboration -- because
    it is not a guess, it is the mapper telling us. 7 buildings in the extract
    state `min_height` and 11 state `building:min_level`.
  * **Declared bridge** with no stated base: raised to a derived soffit.
  * **Over-road and corroborated**, no stated base, not declared: the polygon is
    either the crossing itself or a building with a crossing attached, and the
    two are told apart by cutting the road corridor out and looking at what is
    left. Under `BRIDGE_PLAN_SHARE` of the plan surviving, the polygon *is* the
    bridge and is raised whole; over it, the polygon is a building with an arm
    over the road, and the arm is cut off while the building stays on the
    ground. Westfield Chatswood over Anderson Street and Westfield Hurstville
    over Park Road are the second case and are exactly right to keep.
  * **Everything else** is grounded and untouched. In particular a building
    tagged `layer=1` that spans no road stays on the ground: `layer` is a
    drawing-order hint that suburban mappers put on carports and pergolas by the
    thousand, and on its own it means nothing about elevation. 2,748 buildings
    in the extract carry it.

**And what happens when it cannot be raised**, which is the case the two
reported spots actually are. A structure whose own roof is below the soffit its
underside would have to be has no honest prism in it, and the repair ladder at
the end of `_decide` takes three steps in order of how much it destroys:

  1. **cut** the road corridor out and keep the largest piece on the ground;
  2. **drop** it, but only where OSM has mapped a bridge here *and* the polygon
     is the crossing rather than a building with one attached;
  3. **leave it alone**, grounded and named in the report.

Both reported spots land on a different rung and both are right. The Mosman
blob keeps 89% of its plan once Military Road is taken out of it, so it is cut
and the retail block stays; the Lane Cove blob keeps 39% and its entire stated
height is 2.98 m, which cannot be a footbridge over a primary road, so it is
dropped. **A missing footbridge is invisible; a wall across Longueville Road is
the bug.** Dropping there is also what the rest of the pipeline already does
with footbridges -- `decks._is_deck` excludes `is_foot` ways on purpose, so the
pipeline has *already* decided a 2 m footbridge is not worth drawing, and this
agrees with it rather than inventing a second policy.

Step 2's second condition is what stops the ladder eating real buildings. On
this rule's first run over the extract it was about to delete a 42 m^2 building
named `Gatehouse` at Hunters Hill and a `building=corridor` at Killara, both
tagged `layer=1` by a mapper, both straddling a driveway, and neither with a
bridge mapped within a hundred metres. **A deletion needs OSM to have mapped a
bridge; `layer` alone may move a structure but never remove one.**

---------------------------------------------------------------------------
**What a raised prism must then not be given.** A base above the ground makes
several of the per-building dressing passes nonsense at once -- a contact shadow
where the wall meets a footpath it does not touch, a footpath awning 5 m up, a
front door onto thin air, a front fence around a bridge. Those exclusions are
applied at the one place that already loops over buildings with their bases in
hand, `tiles.build_tile`, and are listed there.

**What this module does not touch: road decks.** `decks.py` owns every way
tagged `bridge`, solves its profile against the conformed ground and emits it
with a girder, parapets and piers. Nothing here changes that, and the overlap is
deliberate in one direction only: where an ML blob has duplicated a deck
`decks.py` already builds, dropping the blob removes a duplicate rather than a
structure.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import decks, merge
from .sources import msbuildings, osm

# --- What counts as a road being spanned ---------------------------------------

# The carriageway classes a building may not stand on the ground across.
#
# `osm.STREET_CLASSES` minus `service`, and the subtraction is the single most
# load-bearing line in this module. Measured over the ledger's 470,457
# footprints: 1,650 have *some* ground carriageway centreline running through
# them, and only 218 have a public one. The other 1,432 are car-park ramps,
# loading docks and arcade driveways mapped through buildings that are entirely
# real, and a rule that touched them would carve slots through Westfield
# Burwood, Macquarie Centre, the ICC and both Sydney Airport terminals.
PUBLIC_CLASSES = osm.STREET_CLASSES - {"service"}

# How much of a public centreline must lie inside a footprint before it counts
# as spanning it, metres.
#
# A footprint whose corner clips a centreline by half a metre is a mapping
# offset, not a structure over a road. 3 m is under the narrowest thing that
# could be a real crossing and over anything float noise or a 1 cm-rounded ring
# can produce.
SPAN_MIN_M = 3.0

# How near an OSM way tagged `bridge` a footprint must lie to be corroborated by
# it, metres.
#
# A bridge way is a centreline and the structure carrying it is a few metres
# wide, so the test is "is this polygon on that bridge" rather than "does it
# touch it". 3 m is half a generous footbridge; wider started sweeping in the
# buildings either side of an overpass, which are ordinary buildings that happen
# to stand next to one.
BRIDGE_WAY_REACH_M = 3.0

# --- What a derived base is -----------------------------------------------------

# The soffit a bridge with no stated base is given over the ground, metres.
#
# AS 5100.1 sets 5.4 m as the minimum vertical clearance over a road for a new
# structure in NSW, and every overbridge in this extent was built to some
# version of it. It is deliberately well clear of `decks.WALK_UNDER_M` (2.6),
# which is the *collision* threshold at which this pipeline decides a prism is
# something the player walks under rather than onto: matching that number
# exactly would put every derived bridge on the knife edge of the rule the
# audit measures against, and a bridge is not a knife-edge case.
ROAD_CLEARANCE_M = 5.4

# The least a raised prism may be, roof to soffit, metres.
#
# `decks.py`'s own answer to "what is a bridge made of": a girder and the
# parapet standing on it. A structure whose stated roof leaves less than this
# above its derived soffit has not been measured, it has been guessed at by an
# ML height estimator that was looking at a road, and there is no prism in it
# worth floating.
MIN_RAISED_HEIGHT_M = decks.GIRDER_DEPTH_M + decks.PARAPET_HEIGHT_M

# The share of its own plan a footprint must keep, once the roads it spans are
# cut out of it, to still be a building rather than a bridge.
#
# Half. The two cases are not close together in this data and do not need a
# tuned threshold: the Lane Cove footbridge keeps 28% of its plan and the
# Mosman retail blob keeps 89%, Westfield Chatswood keeps 96%. Anything near
# the line is a small ML blob either way and both answers are defensible.
BRIDGE_PLAN_SHARE = 0.5

# A remnant smaller than this is not a building. `msbuildings`' own floor, so
# that a cut cannot leave behind something the ingest would have refused.
MIN_REMNANT_M2 = msbuildings.MIN_AREA_M2

# Storey height for `building:min_level`, metres.
#
# Deliberately the *same* number `attributes._floor_height_for` uses for the
# generic case rather than a second constant: `building:min_level=2` and
# `building:levels=2` are the same count of the same storeys, and a module that
# converted them at different rates would put a building's floor and its roof on
# two different scales.
LEVEL_HEIGHT_M = 3.2


# --- The report -----------------------------------------------------------------


@dataclass
class ElevatedReport:
    """What the pass did, in enough detail to argue with.

    Every list holds `(id, note)` rather than a count, because each of these
    outcomes is rare enough to name and each one is a building that has visibly
    changed. A build whose `dropped` list grows by fifty is a build that has
    deleted fifty structures and should be looked at.
    """

    stated: list[tuple[str, str]] = field(default_factory=list)
    declared: list[tuple[str, str]] = field(default_factory=list)
    raised: list[tuple[str, str]] = field(default_factory=list)
    cut: list[tuple[str, str]] = field(default_factory=list)
    dropped: list[tuple[str, str]] = field(default_factory=list)
    # Structures that could be neither lifted nor cut and that the pass refused
    # to delete, so they are on the ground exactly as they were. See the repair
    # ladder at the end of `_decide`.
    quirks: list[tuple[str, str]] = field(default_factory=list)
    # `examined` is every footprint; `candidates` the ones that survived the
    # cheap reject and had a polygon built; `spanning` and `corroborated` are
    # counted **within the candidates** and are deliberately not a census of the
    # world -- 1,650 footprints in the extract have some carriageway through
    # them and this pass never looks at most of them, by design.
    candidates: int = 0
    spanning: int = 0
    corroborated: int = 0
    examined: int = 0

    @property
    def changed(self) -> int:
        return len(self.stated) + len(self.declared) + len(self.raised) + len(self.cut)


# --- The pass -------------------------------------------------------------------


def resolve(
    buildings: list[merge.Building],
    roads: list[osm.OsmRoad],
    terrain,
) -> tuple[list[merge.Building], ElevatedReport]:
    """Give every elevated structure a base, and take the walls off the roads.

    Returns the surviving buildings and a report. Mutates the survivors in place
    -- `base_height`, and for a cut also `ring`, `holes`, `area` and `centroid`
    -- so the caller's other references to the same objects stay correct. The
    centroid matters and is the reason the caller must bucket by tile *after*
    this runs: `Building.tile` is derived from it, and cutting an arm off a
    footprint can move it across a tile line.

    Runs on every build, including a `--retile`, because it is derived rather
    than stored: the tags it reads ride in the `buildings` table's geometry blob
    and the decision is cheap to remake. What it must not do is run before the
    terrain exists, since a derived soffit is measured from the ground.
    """
    report = ElevatedReport()

    # The two spatial indexes this pass asks its questions of. Built once: the
    # per-building work below is a handful of tree queries and the trees are the
    # only expensive thing here.
    centre_lines: list[LineString] = []
    centre_half: list[float] = []
    for r in roads:
        if r.is_foot or r.tunnel or r.layer != 0 or r.bridge:
            continue
        if r.highway not in PUBLIC_CLASSES or len(r.line) < 2:
            continue
        centre_lines.append(LineString(r.line))
        centre_half.append(r.width * 0.5)
    centre_tree = STRtree(centre_lines) if centre_lines else None

    # Bridge *ways*, at layer 1 or above. The layer test is what keeps a culvert
    # crossing -- `bridge=yes` over a pipe, at grade, which is the median bridge
    # way in this extract -- from corroborating anything: nothing is in the air
    # over a culvert.
    bridge_plans = [
        LineString(r.line).buffer(BRIDGE_WAY_REACH_M)
        for r in roads
        if r.bridge and r.layer >= 1 and len(r.line) >= 2
    ]
    bridge_tree = STRtree(bridge_plans) if bridge_plans else None

    # THE CHEAP REJECT, and it is what makes this pass affordable over 470,457
    # footprints. Everything below `_decide` needs a shapely polygon and a pair
    # of tree queries per building, which at half a million buildings is minutes
    # of work to answer "no" about 99.4% of them.
    #
    # So the near-a-bridge-way test is done first, in bulk, and approximately:
    # one nearest-neighbour query from every centroid at once, kept when the
    # distance is inside the footprint's own half-diagonal. That is a strict
    # over-approximation -- a polygon that intersects a bridge plan always has a
    # centroid within its half-diagonal of it -- so the exact test that follows
    # can only ever remove candidates, never add them.
    near = _near_bridge_bulk(buildings, bridge_tree, bridge_plans)

    keep: list[merge.Building] = []
    for i, b in enumerate(buildings):
        report.examined += 1
        if _stated_base(b) is None and not _declared_bridge(b) and b.layer < 1 and not near[i]:
            keep.append(b)
            continue
        verdict = _decide(b, centre_tree, centre_lines, centre_half, bridge_tree, bridge_plans, terrain, report)
        if verdict is not None:
            keep.append(b)
    return keep, report


def _near_bridge_bulk(buildings, tree, plans) -> np.ndarray:
    """Which footprints are plausibly on a bridge way, by centroid and reach."""
    n = len(buildings)
    if tree is None or n == 0:
        return np.zeros(n, dtype=bool)
    cent = np.array([b.centroid for b in buildings], dtype=np.float64)
    reach = np.empty(n, dtype=np.float64)
    for i, b in enumerate(buildings):
        r = np.asarray(b.ring, dtype=np.float64)
        if len(r) < 3:
            reach[i] = 0.0
            continue
        span = r.max(axis=0) - r.min(axis=0)
        reach[i] = 0.5 * float(np.hypot(span[0], span[1]))
    idx, dist = tree.query_nearest(
        shapely.points(cent), all_matches=False, return_distance=True
    )
    out = np.zeros(n, dtype=bool)
    # `query_nearest` returns one column per input geometry it found a match
    # for; with `all_matches=False` that is a 1-D array of tree indices aligned
    # to the inputs it answered about, so the input index comes back in `idx`
    # only when the tree is non-empty for it. Guarded rather than assumed,
    # because the shape of this return has changed across shapely versions.
    if idx.ndim == 2:
        rows, _ = idx
        out[rows] = dist <= reach[rows]
    else:
        out[: len(idx)] = dist <= reach[: len(idx)]
    return out


def _decide(
    b: merge.Building,
    centre_tree,
    centre_lines,
    centre_half,
    bridge_tree,
    bridge_plans,
    terrain,
    report: ElevatedReport,
) -> merge.Building | None:
    """One footprint's outcome. None means drop it."""
    stated = _stated_base(b)
    declared = _declared_bridge(b)

    poly = _plan(b)
    if poly is None:
        return b

    near_bridge = _near_bridge_way(poly, bridge_tree, bridge_plans)
    corroborated = declared or b.layer >= 1 or near_bridge

    # WHAT MAY BE DELETED, as opposed to what may be moved. A drop needs OSM to
    # have actually mapped a bridge here -- the polygon claiming to be one, or a
    # bridge *way* lying on it. `layer >= 1` on its own never qualifies, and
    # that distinction is not theoretical: on the first run of this pass it was
    # about to delete a 42 m^2 building named `Gatehouse` at Hunters Hill and a
    # `building=corridor` at Killara, both tagged `layer=1` by a mapper, both
    # straddling a driveway, and neither with a bridge mapped within a hundred
    # metres. A gatehouse standing over its own drive is a real building doing
    # the thing gatehouses do. It keeps its `layer` and stays on the ground.
    mapped_bridge = bool(declared) or near_bridge

    spans, corridor = _spanned_roads(poly, centre_tree, centre_lines, centre_half)
    report.candidates += 1
    over_road = spans >= SPAN_MIN_M
    if over_road:
        report.spanning += 1
        if corroborated:
            report.corroborated += 1

    # ---- 1. The mapper told us where it starts. -------------------------------
    #
    # Unconditional, and the only branch that needs no geometry at all: a raised
    # walkway between two towers spans no road and is still in the air.
    if stated is not None and stated > 0.0:
        base = stated
        if over_road:
            # A stated base under the clearance floor, over a road, is a mapper
            # rounding down rather than a structure that low: nothing gets built
            # over a public carriageway with less headroom than the code
            # requires. Lifted rather than trusted, because the failure mode of
            # trusting it is the wall this module exists to remove.
            base = max(base, ROAD_CLEARANCE_M)
        source = "min_height" if b.min_height is not None else "building:min_level"
        if _lift(b, base, report.stated, f"base {base:.1f} m from {source}"):
            return b
        why = f"a {b.height:.1f} m roof cannot clear a {base:.1f} m soffit stated by {source}"

    # ---- 2. The polygon says it is a bridge and did not say how high. --------
    #
    # Derived whether or not it spans a road: a bridge over water or a rail
    # corridor is still a bridge, and there are 15 of these in the extent.
    elif declared:
        base = _derived_base(b, poly, terrain)
        if base is not None and _lift(b, base, report.declared, f"soffit {base:.1f} m; {declared}"):
            return b
        why = (
            f"{declared}, but a {b.height:.1f} m roof cannot clear"
            f" {'the derived soffit' if base is None else f'a {base:.1f} m soffit'}"
        )

    # ---- 3. Untagged, and over a public road with a crossing mapped on it. ---
    elif over_road and corroborated:
        remnant = _largest_remnant(poly, corridor)
        share = (remnant.area / poly.area) if poly.area > 0 else 0.0
        why = f"{spans:.0f} m of public carriageway inside, {share * 100:.0f}% of plan survives the cut"
        if share < BRIDGE_PLAN_SHARE:
            # The polygon *is* the crossing rather than a building with one
            # attached. Raise it whole if there is a prism to raise.
            base = _derived_base(b, poly, terrain)
            if base is not None and _lift(b, base, report.raised, f"soffit {base:.1f} m; {why}"):
                return b
            # And if there is not, and OSM has mapped a bridge here, it goes.
            #
            # This is the one place a drop is preferred to a cut, and the
            # difference between the two cases is what the polygon *is*. Cutting
            # a footbridge blob leaves two stubs of ML segmentation standing on
            # the footpaths at either landing -- 105 m^2 of 3 m brick box beside
            # Longueville Road, which is a second artefact rather than half a
            # repair. There is no building under this polygon to preserve; it is
            # a deck the segmenter mistook for a roof, and the pipeline does not
            # draw footbridges in the first place (`decks._is_deck` excludes
            # `is_foot` ways deliberately). A missing footbridge is invisible.
            if mapped_bridge:
                report.dropped.append((b.id, f"{why}; nothing under it but the span"))
                return None
    else:
        return b

    # ---- The repair, for everything that fell through the three branches. ----
    #
    # Reached only by a structure that should not be sitting on the ground and
    # cannot be lifted off it. In descending order of preference:
    #
    #   * **Cut.** Take the road corridor out of the plan and keep the largest
    #     piece, on the ground. This is the answer for a building with an arm
    #     over the road -- Westfield Chatswood over Anderson Street, the Mosman
    #     retail block over Military Road -- and also for the `layer=1`
    #     canopies and covered ways that turned out to be too low to lift: the
    #     road opens and the building stays, which beats both alternatives.
    #   * **Drop**, only if a bridge is actually mapped here. See `mapped_bridge`
    #     above for why `layer` alone is not enough to delete on.
    #   * **Leave it.** Grounded, unchanged, and named in the report. The pass
    #     refuses to guess rather than damaging something real.
    remnant = _largest_remnant(poly, corridor)
    if corridor is not None and remnant.area >= MIN_REMNANT_M2 and remnant.area < poly.area:
        _recut(b, remnant)
        report.cut.append((b.id, why))
        return b
    if mapped_bridge and over_road:
        report.dropped.append((b.id, why))
        return None
    report.quirks.append((b.id, why))
    return b


def _lift(b, base: float, bucket: list, why: str) -> bool:
    """Raise a prism to `base`. False when there is no prism left above it.

    The refusal is the interesting half. A structure whose roof is below the
    soffit it would need is not a structure that has been measured -- it is an
    ML height estimator that was looking at a road, or a `building:min_level=1`
    on a `building:levels=1` station canopy, which is a mapping convention
    ("one level tall, starting one level up") that OSM's schema reads as "zero
    levels tall". Floating a prism of negative thickness is not an option and
    neither is pretending; the caller decides what to do instead.
    """
    if b.height - base < MIN_RAISED_HEIGHT_M:
        return False
    b.base_height = base
    b.height -= base
    bucket.append((b.id, why))
    return True


def _derived_base(b, poly, terrain) -> float | None:
    """A soffit for a bridge that did not state one, metres over this pad.

    The ground is sampled at the footprint's **highest** point rather than at its
    centroid, because the clearance that matters is over the road, the road is
    usually in the low part of a crossing's plan and the abutments are the high
    part -- but a soffit is one number for the whole prism, so taking the
    maximum is what guarantees the underside clears everywhere rather than on
    average.

    `base_height` is measured from this building's own pad, because that is what
    `tiles.build_tile` adds it to. The clearance is measured from the highest
    ground under the plan, so the two are reconciled here and nowhere else.
    """
    if terrain is None:
        return None
    ground = _ground_max(poly, terrain)
    pad = _ground_at(b, terrain)
    if ground is None or pad is None:
        return None
    return (ground - pad) + ROAD_CLEARANCE_M


# --- The questions --------------------------------------------------------------


def _stated_base(b: merge.Building) -> float | None:
    """Metres above the ground the structure starts, if OSM said so.

    `min_height` wins over `building:min_level` where both are present, because
    it is the measurement and the other is a count converted by an assumption.
    """
    if b.min_height is not None:
        return float(b.min_height)
    if b.min_level:
        return float(b.min_level) * LEVEL_HEIGHT_M
    return None


def _declared_bridge(b: merge.Building) -> str | None:
    """The polygon's own claim to be a bridge, as a phrase for the report."""
    if b.building_type == "bridge":
        return "building=bridge"
    if b.bridge:
        return "bridge=* on the area"
    if b.man_made == "bridge":
        return "man_made=bridge"
    return None


def _plan(b: merge.Building) -> Polygon | None:
    try:
        poly = Polygon(b.ring, b.holes)
    except Exception:  # noqa: BLE001 -- a ring too short to be a polygon at all
        return None
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon" or poly.area <= 0.0:
        return None
    return poly


def _near_bridge_way(poly: Polygon, tree, plans) -> bool:
    if tree is None:
        return False
    return any(poly.intersects(plans[i]) for i in tree.query(poly))


def _spanned_roads(poly: Polygon, tree, lines, halves):
    """(metres of public centreline inside the plan, the corridor it implies).

    The *centreline* rather than a ribbon, and that is the whole test: a
    building beside a road always overlaps a buffered centreline and never
    contains one. The corridor handed back -- the same ways, buffered to their
    carriageway width -- is only ever used to cut, never to detect.
    """
    if tree is None:
        return 0.0, None
    total = 0.0
    corridors = []
    for i in tree.query(poly):
        line = lines[i]
        inside = poly.intersection(line)
        length = float(getattr(inside, "length", 0.0))
        if length < SPAN_MIN_M:
            continue
        total += length
        corridors.append(line.buffer(halves[i]))
    return total, (unary_union(corridors) if corridors else None)


def _largest_remnant(poly: Polygon, corridor):
    """What is left of a plan once the roads through it are taken out."""
    if corridor is None:
        return poly
    rest = poly.difference(corridor)
    if rest.is_empty:
        return Polygon()
    parts = list(rest.geoms) if hasattr(rest, "geoms") else [rest]
    parts = [p for p in parts if p.geom_type == "Polygon" and not p.is_empty]
    if not parts:
        return Polygon()
    return max(parts, key=lambda p: p.area)


def _recut(b: merge.Building, remnant: Polygon) -> None:
    """Replace a footprint with what survived the cut, invariants intact.

    Area and centroid are recomputed rather than left alone, and the centroid is
    the one that would bite: `Building.tile` is derived from it, so a building
    whose arm has been cut off can belong to a different tile than it did a line
    ago. The winding goes back through `merge.orient_footprint` for the same
    reason every other producer of a ring does -- shapely's `difference` makes no
    promise about which way round it hands the pieces back.
    """
    ring, holes = merge.orient_footprint(
        np.asarray(remnant.exterior.coords, dtype=np.float64),
        [np.asarray(h.coords, dtype=np.float64) for h in remnant.interiors],
    )
    b.ring = ring
    b.holes = holes
    b.area = float(remnant.area)
    b.centroid = (float(remnant.centroid.x), float(remnant.centroid.y))


def _ground_max(poly: Polygon, terrain) -> float | None:
    pts = np.asarray(poly.exterior.coords, dtype=np.float64)
    if len(pts) == 0:
        return None
    h = np.asarray(terrain.sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
    return float(np.nanmax(h)) if h.size and np.isfinite(h).any() else None


def _ground_at(b: merge.Building, terrain) -> float | None:
    """This building's pad, to `tiles._pad_and_skirt`'s first line.

    Deliberately the centroid sample and not a call into `tiles`, which would
    import the emitter into the classifier for one number. The difference is the
    deep-skirt clamp that function applies afterwards, and it can only ever move
    a pad *down* -- so a soffit derived here can only ever come out further above
    the real pad than intended, never below it, and erring high is the safe side
    of a clearance.
    """
    h = float(terrain.sample(*b.centroid))
    return h if np.isfinite(h) else None
