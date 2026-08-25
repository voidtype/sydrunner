"""Creeks: the 1,300 km of waterway OSM draws as lines and this world never had.

`water.py` admits **polygons** -- `natural=water` and the sea polygonised out of
`natural=coastline` -- and that is the right source for everything with an area:
the harbour, the bays, Busbys Pond. It is also, by construction, blind to the
entire drainage network above the tideline, because a 3 m creek is not mapped as
a polygon anywhere in the world. Measured over this extent's `lines` layer:

    stream    2,499 ways   1,046 km      drain   1,776 ways   255 km
    river       203 ways     255 km      canal      36 ways    11 km
    ditch        69 ways      12 km

Sydney is a drowned river valley and its suburbs are a comb of creek gullies.
Leaving all of it out meant Cooks River above Tempe, Duck River, Powells Creek,
Wolli Creek, Lane Cove River above Fig Tree Bridge and every gully in the
national park were dry ground you walked across without noticing. That is the
top-voted item on the in-game suggestion board, and it is the correct thing to
have voted for.

---------------------------------------------------------------------------
WHY THIS IS ITS OWN MODULE AND NOT SIX LINES IN `water.py`.

Two reasons, and the second is the load-bearing one.

**The shapes are different.** A water body is a polygon with a level; a creek is
a centreline with a width and a *slope*. Everything below -- the reach split, the
per-reach level, the subtraction against the polygons that already exist -- is
about turning the second into the first, and none of it is water.py's business.

**`water.py` is in the terrain cache key and this must not be.**
`terraincache._CODE_FILES` hashes `terrain.py`, `roadgrade.py`, `water.py`,
`geo.py`, `config.py` and `sources/osm.py`, because each of those decides where
the lattice ends up. Editing any of them re-solves the whole 60 km lattice.
Creeks deliberately **do not move the ground** (see the next section), so they
have no business invalidating a solve that would come out byte-identical -- and a
new module that imports `water` rather than editing it keeps that promise
structurally rather than by remembering. The OSM read is done here through
`osm._read_layer` for exactly the same reason.

---------------------------------------------------------------------------
THE ONE REAL DECISION: THE GROUND DOES NOT MOVE, SO THE WATER STEPS.

`water.conform` pulls the terrain lattice down under every water polygon so the
harbour has a bed. The obvious thing to do here is the same thing, and it is
wrong twice over. The lattice is 31.25 m and a creek is 3 m wide, so conforming
one would gouge a 31 m trench for a 3 m stream -- and it would move terrain,
which means a fresh solve, a fresh set of `.terr.bin` bytes and a world publish
whose byte-diff is meaningless.

So a creek is drawn **on the ground it found**, and the price is paid in the
other currency: a flat sheet cannot follow a slope, so the creek is cut into
short reaches and each reach is its own flat sheet at its own level. Which is
precisely the case `tiles.write_water` already documents as the reason its format
carries a level per sheet rather than one per file:

    "Several sheets per tile, not one... In practice every tile in this extent
    carries exactly one -- the split is between tiles, not inside them -- and the
    format does not assume that, because the thing most likely to change is which
    polygons are admitted."

This is that change. The format needed nothing.

**Reach length falls straight out of the stand.** A reach's surface sits
`CREEK_STAND_M` above the *lowest* ground along it, and `water._wet_pieces` then
clips the sheet to where the ground is actually below that surface -- which is
what makes the drawn edge the ground's own waterline rather than a mapped line.
So a reach is fully drawn only while the ground rises less than the stand across
it: at `REACH_M` = 10 m and a 3% creek grade that is 30 cm against a 40 cm stand,
and the ribbon is continuous. Double the reach and every creek becomes a dashed
line of puddles. This pair of numbers is the whole geometry of the feature and
neither may be moved without the other.

What the player sees is water standing up to 40 cm deep in the bottom of the
gully, narrowing where the gully narrows, ending where the bank rises -- and a
step of a few centimetres every 10 m, which is what a creek running over a rock
bar looks like and is under the wave amplitude anyway.

**Flow direction is deliberately not enforced.** OSM draws waterways downstream,
so a running minimum along the way would guarantee water never runs uphill. It
would also clip away every reach where a 31.25 m DEM disagrees with a 3 m creek
about which end is lower, which is most of the flat ones, and it would turn the
suburban network into gaps. A reach that stands 4 cm higher than the one below it
over 10 m is invisible; a missing 200 m of Powells Creek is not.

---------------------------------------------------------------------------
WHAT IS EXCLUDED, AND WHY EACH.

  * **Anything underground** -- `tunnel=*`, or a negative `layer`. 583 of the
    stream ways and 791 of the drain ways are piped, which in this city means
    exactly what it says: the stormwater network under the suburbs. Drawing it
    would put water inside the ground, and the culvert tags are also what keeps a
    creek from being drawn across the road that bridges it.
  * **`waterway=flowline`** -- an import artefact that traces the centreline of a
    lake that is already a polygon. Drawing it would put a creek down the middle
    of a lake.
  * **Everything that is not a channel**: weirs, dams, locks, docks, fish passes,
    access points and floating barriers are point or line *furniture* on a
    waterway, not the waterway.
  * **Anything already covered by a `water.py` polygon.** The wide rivers are
    mapped both ways -- Parramatta River has a centreline *and* an area -- so
    every ribbon is subtracted against the existing water before it is used, and
    what survives is only the reach above where the polygon gives out. This is
    also what stops a creek being drawn on top of the harbour it drains into.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any

import numpy as np
import shapely
import shapely.ops
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from . import config, water
from .sources import osm

# --- What counts as a creek ----------------------------------------------------

# The channel kinds, with the width to use when the way does not carry one.
#
# These are drawn widths, not hydrology. `river` is the narrow upper reach of
# something whose wide part is already a polygon and has been subtracted away, so
# it is nothing like the Parramatta at Gladesville. `drain` is Sydney's concrete
# stormwater channel -- Johnstons Creek, Powells Creek, the Alexandra Canal
# feeders -- which is a real, visible, walkable piece of the city and is the
# single biggest thing this adds inside the inner ring.
CHANNEL_WIDTH_M = {
    "river": 12.0,
    "canal": 8.0,
    "drain": 4.0,
    "stream": 3.0,
    "ditch": 1.5,
}

# The widest a `width` tag is believed. Beyond this it is a polygon's job.
MAX_WIDTH_M = 40.0
# The narrowest ribbon worth a triangle. Below the terrain's own facet cut there
# is nothing to see and a great deal to triangulate.
MIN_WIDTH_M = 1.0

# How far a reach's surface stands above the lowest ground along it, metres.
#
# The deepest the water can be, and the amount of bank the ground may rise before
# `water._wet_pieces` cuts the sheet off. See the header: this and `REACH_M` are
# one decision. 40 cm is a creek you would wade rather than swim, which is what
# almost every one of these is.
CREEK_STAND_M = 0.40

# The length of one flat reach, metres. See the header.
REACH_M = 10.0

# How finely the ground is sampled along a reach to find its lowest point.
PROFILE_STEP_M = 2.0

# The least a piece may be, m2, before it is dropped rather than triangulated.
MIN_PIECE_M2 = 0.25

# Ways shorter than this are furniture, not channels.
MIN_WAY_M = 15.0


@dataclass
class CreekReach:
    """One flat run of creek: a ribbon polygon and the level it sits at."""

    polygon: Polygon
    surface: float  # metres above the datum
    kind: str
    name: str


@dataclass
class CreekField:
    """The extent's creeks, indexed for the per-tile cut."""

    reaches: list[CreekReach]
    tree: STRtree | None
    stats: dict = dc_field(default_factory=dict)

    def is_empty(self) -> bool:
        return not self.reaches


# --- Reading -------------------------------------------------------------------


@dataclass
class CreekWay:
    line: np.ndarray  # (N, 2) ENU metres
    kind: str
    width: float
    name: str


def _as_layer(v: Any) -> int:
    try:
        return int(str(v).split(";")[0])
    except (TypeError, ValueError):
        return 0


def read_ways(radius_m: float, path: Path = osm.PBF_PATH) -> list[CreekWay]:
    """Every drawable waterway centreline in the extent, in ENU metres."""
    bbox = osm.geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = osm._read_layer(path, "lines", bbox)

    out: list[CreekWay] = []
    for geom, a in zip(geoms, attrs):
        kind = a.get("waterway")
        if kind not in CHANNEL_WIDTH_M:
            continue
        # Underground, in either of the two ways OSM says it.
        if a.get("tunnel") not in (None, "", "no") or _as_layer(a.get("layer")) < 0:
            continue
        width = osm._as_float(a.get("width")) or CHANNEL_WIDTH_M[kind]
        width = min(max(width, MIN_WIDTH_M), MAX_WIDTH_M)
        proj = osm._project(geom)
        lines = list(proj.geoms) if proj.geom_type == "MultiLineString" else [proj]
        for ln in lines:
            if ln.is_empty or ln.length < MIN_WAY_M:
                continue
            coords = np.asarray(ln.coords)[:, :2]
            if not (np.hypot(coords[:, 0], coords[:, 1]) <= radius_m).any():
                continue
            out.append(
                CreekWay(line=coords, kind=kind, width=float(width), name=a.get("name") or "")
            )
    return out


# --- Building ------------------------------------------------------------------


def _reaches_of(line: LineString) -> list[LineString]:
    """Cut a centreline into `REACH_M` pieces, the last one absorbed rather than
    left as a stub -- a 30 cm reach is a sheet whose triangulation costs more than
    it draws."""
    total = line.length
    if total <= REACH_M * 1.5:
        return [line]
    n = max(1, int(round(total / REACH_M)))
    step = total / n
    out: list[LineString] = []
    for i in range(n):
        a, b = i * step, (i + 1) * step
        piece = shapely.ops.substring(line, a, b)
        if piece.geom_type == "LineString" and piece.length > 0.5:
            out.append(piece)
    return out


def _chainage(line: np.ndarray) -> np.ndarray:
    """Cumulative length along a polyline, starting at zero."""
    seg = np.hypot(*np.diff(line, axis=0).T)
    return np.concatenate(([0.0], np.cumsum(seg)))


def _points_at(line: np.ndarray, chain: np.ndarray, at: np.ndarray) -> np.ndarray:
    """Points along a polyline at given chainages, vectorised.

    `LineString.interpolate` in a Python loop is what this replaces, and it is not
    a micro-optimisation: the extent has 1,300 km of waterway, which is 130,000
    reaches and about 800,000 sample points, and one shapely call each is minutes
    of a build spent walking a list.
    """
    i = np.clip(np.searchsorted(chain, at, side="right") - 1, 0, len(chain) - 2)
    span = np.maximum(chain[i + 1] - chain[i], 1e-9)
    t = ((at - chain[i]) / span)[:, None]
    return line[i] + (line[i + 1] - line[i]) * t


def _reach_plan(total: float) -> tuple[int, float, int]:
    """How a way of this length is cut: reach count, reach length, samples each.

    The last reach is absorbed rather than left as a stub -- a 30 cm reach is a
    sheet whose triangulation costs more than it draws -- so the cut is `n` equal
    pieces rather than `floor` pieces and a remainder.
    """
    n = 1 if total <= REACH_M * 1.5 else max(1, int(round(total / REACH_M)))
    step = total / n
    per = max(2, int(math.ceil(step / PROFILE_STEP_M)) + 1)
    return n, step, per


def _reach_levels(line: np.ndarray, chain: np.ndarray, sample) -> tuple[np.ndarray, float, int]:
    """Every reach's surface along one way, in **one** terrain lookup.

    A reach sits `CREEK_STAND_M` above the *lowest* ground along it rather than
    the mean, and that is the choice the geometry turns on: taking the mean would
    put half of every reach above its own water, and `water._wet_pieces` would
    then clip that half away. The low end is the end the water is at.
    """
    total = float(chain[-1])
    n, step, per = _reach_plan(total)
    at = (np.arange(n)[:, None] * step + np.linspace(0.0, step, per)[None, :]).ravel()
    pts = _points_at(line, chain, at)
    h = np.asarray(sample(pts[:, 0], pts[:, 1]), dtype=np.float64).reshape(n, per)
    return h.min(axis=1) + CREEK_STAND_M, step, per


def load(
    radius_m: float,
    sample,
    water_field: water.WaterField | None = None,
    path: Path = osm.PBF_PATH,
) -> CreekField:
    """Read the waterway network and turn it into flat reaches on the found ground.

    `sample` is `Terrain.sample` **after** every conform has run, which is the only
    order that works: a creek is drawn on the ground the player walks on, and the
    ground the player walks on is the one the roads and the harbour already moved.
    """
    ways = read_ways(radius_m, path)

    # What the polygons already cover, as one r-tree. Subtracted **once per way**
    # rather than once per reach, which is the difference between a minute and an
    # hour: a way is 200 m of creek and 20 reaches, the water it runs into is the
    # same water for all of them, and `union_all` over the hits is the expensive
    # call in this module.
    existing: list[BaseGeometry] = []
    if water_field is not None:
        existing = [lvl.geom for lvl in water_field.levels]
    exist_tree = STRtree(existing) if existing else None

    reaches: list[CreekReach] = []
    dropped_covered = 0
    dropped_empty = 0
    by_kind: dict[str, int] = {}
    length_m = 0.0

    for way in ways:
        line = way.line
        chain = _chainage(line)
        total = float(chain[-1])
        if total < MIN_WAY_M:
            continue
        half = way.width * 0.5

        # The water this way runs into, or None. Three filters in increasing cost,
        # and the order is the point: almost every stream in this extent is a
        # gully in the hills that never meets a mapped polygon at all, and the
        # expensive operation here -- differencing 20 reach ribbons against the
        # union of the harbour -- must not be reached by one of those. The r-tree
        # query is a bounding box and the harbour's box is most of Sydney, so a
        # real `intersects` between the query and the union is what actually
        # decides it, and it is paid once per way rather than once per reach.
        cover: BaseGeometry | None = None
        if exist_tree is not None:
            whole = LineString(line).buffer(half, cap_style=2, join_style=1)
            hits = exist_tree.query(whole)
            if len(hits) > 0:
                merged = shapely.union_all([existing[int(i)] for i in hits])
                if merged.intersects(whole):
                    cover = merged
                    shapely.prepare(cover)

        # Every reach's sample points in one array, so the terrain is asked once
        # per way instead of once per reach. `Terrain.sample` is a vectorised
        # bilinear lookup and the cost is almost entirely the call.
        surfaces, step, per = _reach_levels(line, chain, sample)
        n_reach = len(surfaces)

        for k in range(n_reach):
            piece = LineString(_points_at(line, chain, np.linspace(k * step, (k + 1) * step, per)))
            ribbon = piece.buffer(half, cap_style=2, join_style=1)
            if ribbon.is_empty:
                dropped_empty += 1
                continue
            if cover is not None:
                ribbon = ribbon.difference(cover)
                if ribbon.is_empty:
                    dropped_covered += 1
                    continue
            parts = water._parts(ribbon, MIN_PIECE_M2)
            if not parts:
                dropped_empty += 1
                continue
            for part in parts:
                reaches.append(
                    CreekReach(
                        polygon=part,
                        surface=float(surfaces[k]),
                        kind=way.kind,
                        name=way.name,
                    )
                )
            by_kind[way.kind] = by_kind.get(way.kind, 0) + 1
            length_m += step

    tree = STRtree([r.polygon for r in reaches]) if reaches else None
    stats = {
        "ways": len(ways),
        "reaches": len(reaches),
        "length_km": round(length_m / 1000.0, 1),
        "area_m2": round(float(sum(r.polygon.area for r in reaches)), 1),
        "by_kind": by_kind,
        "dropped_covered": dropped_covered,
        "dropped_empty": dropped_empty,
        "stand_m": CREEK_STAND_M,
        "reach_m": REACH_M,
    }
    return CreekField(reaches=reaches, tree=tree, stats=stats)


# --- Emitting ------------------------------------------------------------------


def tile_sheets(field: CreekField | None, tile_key: str, terrain) -> list[water.WaterSheet]:
    """One tile's creeks, as `WaterSheet`s the water sidecar already knows how to
    write and the water material already knows how to draw.

    The same three cuts `water.tile_sheets` makes, in the same order and through
    the same functions: to the tile, to the terrain's facets, and to the ground
    that is actually under the surface. The last of those is what gives a creek a
    bank -- `water._wet_pieces` keeps only the half-plane where the facet's own
    plane is below this reach's level, so the drawn edge is the waterline the
    player can see rather than the ribbon this module buffered.
    """
    if field is None or field.tree is None:
        return []
    tx, tz = (int(v) for v in tile_key.split("_"))
    s = config.TILE_SIZE
    cell = box(tx * s, tz * s, (tx + 1) * s, (tz + 1) * s)

    out: list[water.WaterSheet] = []
    for idx in field.tree.query(cell):
        reach = field.reaches[int(idx)]
        clipped = reach.polygon.intersection(cell)
        if clipped.is_empty:
            continue
        pieces: list[Polygon] = []
        for part in water._parts(clipped, MIN_PIECE_M2):
            pieces.extend(water._wet_pieces(part, terrain, reach.surface))
        sheet = water._sheet_from_pieces(reach.surface, pieces, terrain.sample)
        if sheet is not None and sheet.triangles:
            out.append(sheet)
    return out


# --- Self-check ----------------------------------------------------------------


def verify_creeks() -> list[str]:
    """The invariants that are cheap to state and expensive to discover.

    Runs on made-up geometry and a made-up ground, so it costs milliseconds and
    needs neither the extract nor a solve.
    """
    failures: list[str] = []

    # The stand and the reach are one decision: a reach must be short enough that
    # a plausible creek grade does not climb out of its own sheet. See the header.
    grade = 0.03
    if REACH_M * grade >= CREEK_STAND_M:
        failures.append(
            f"a {REACH_M:.0f} m reach at {grade:.0%} rises {REACH_M * grade:.2f} m against a"
            f" {CREEK_STAND_M:.2f} m stand, so every creek is drawn as a dashed line of puddles"
        )
    # And the stand must clear the depth-buffer margin the clip trims at, or every
    # reach is cut away to nothing by the thing that is supposed to shape it.
    if CREEK_STAND_M <= water.MIN_DRAWN_DEPTH_M * 2:
        failures.append(
            f"the stand {CREEK_STAND_M} m is inside water.MIN_DRAWN_DEPTH_M"
            f" {water.MIN_DRAWN_DEPTH_M} m, so nothing survives the clip"
        )

    # A flat ground at zero: every reach along it stands at exactly the stand.
    line = np.asarray([[0.0, 0.0], [100.0, 0.0]])
    chain = _chainage(line)
    flat = lambda e, n: np.zeros(np.shape(e))  # noqa: E731
    levels, step, per = _reach_levels(line, chain, flat)
    if not np.allclose(levels, CREEK_STAND_M):
        failures.append(f"a reach on flat ground stands at {levels[:3]}, not {CREEK_STAND_M}")

    # A ground that falls away: each reach takes its own *lowest* point, not the
    # mean, because the alternative leaves the upper half of every reach above its
    # own water and `water._wet_pieces` clips it away.
    ramp = lambda e, n: -np.asarray(e, dtype=np.float64) * 0.03  # noqa: E731
    levels, step, per = _reach_levels(line, chain, ramp)
    want = -0.03 * (np.arange(len(levels)) + 1) * step + CREEK_STAND_M
    if not np.allclose(levels, want):
        failures.append("a reach on a 3% fall does not stand at its own low end")
    if not np.all(np.diff(levels) < 0):
        failures.append("reaches down a constant fall do not descend, so the creek runs uphill")

    # The cut is a partition: the reaches tile the way with no gap and no overlap.
    n, step, _ = _reach_plan(100.0)
    if abs(n * step - 100.0) > 1e-9:
        failures.append("the reach cut does not preserve the length of the way")
    if n < 2:
        failures.append("a 100 m way came back as one reach, so the reach cut is not running")
    if _reach_plan(12.0)[0] != 1:
        failures.append("a 12 m way was split, which triangulates more than it draws")

    # The vectorised walk along a polyline must land where `interpolate` would,
    # including across a vertex -- it replaced `LineString.interpolate` for speed
    # and a chainage lookup off by one segment is a creek drawn beside its gully.
    bent = np.asarray([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]])
    bchain = _chainage(bent)
    got = _points_at(bent, bchain, np.asarray([0.0, 5.0, 10.0, 15.0, 20.0]))
    want_pts = np.asarray([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]], dtype=np.float64)
    if not np.allclose(got, want_pts):
        failures.append(f"_points_at walked off the line: {got.tolist()}")

    # Widths: a tagged one is believed inside the clamp and ignored outside it.
    for kind, w in CHANNEL_WIDTH_M.items():
        if not (MIN_WIDTH_M <= w <= MAX_WIDTH_M):
            failures.append(f"the default width for {kind} is outside the clamp")

    # `flowline` is the artefact that would draw a creek down the middle of a lake.
    if "flowline" in CHANNEL_WIDTH_M:
        failures.append("waterway=flowline is admitted; it traces lakes that are already polygons")

    return failures
