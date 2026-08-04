"""Grade-constrained street elevations, and the ground that follows them.

A road in this world was whatever the DEM said. That is wrong in a way nothing
else in the build is wrong, because a street is the one surface a player looks
straight down at for the whole session and the one surface whose real-world
shape they know without being told: streets are flat across their width and
gentle along their length, everywhere, always. Measured before this module
existed, over the inner ring's 10,202 surface carriageways sampled every 10 m --
75,278 segments:

    along-grade     p50  2.63%   p95 10.52%   p99 16.26%   max 39.36%
    cross-slope     p50  3.46%   p95 14.79%   p99 20.96%   max 42.46%

1,049 segments steeper than 15% and 4,033 carrying more than 15% of *bank*.
Sydney's steepest streets are about 15% and none of them is banked at all, so
essentially all of that is error -- and a facet carrying 39% of grade and 42% of
bank at once is tilted 30 degrees out of level, which is the carriageway the
report came in about. Over the same 75,278 segments, afterwards:

    along-grade     p50  2.11%   p95  7.72%   p99  9.70%   max 18.68%   4 over
    cross-slope     p50  2.30%   p95  7.86%   p99  9.42%   max 17.04%   9 over

`sydney road-grade-audit` is what measures both columns, from the files.

**The cause is not noise and cannot be filtered.** Terrarium at zoom 13 is a
*surface* model: in dense areas it is looking at the tops of the buildings, and
`terrain.py`'s header already records that the CBD reads ~40 m high because of
it. A 30 m tower footprint in the DEM sitting beside a strip of true ground puts
a 30 m step across 31 m of lattice, which is a 45 degree facet, and the road that
drapes over it is 45 degrees too. No amount of smoothing removes it -- the
contaminated patches are the size of city blocks -- and the fix therefore cannot
be a better filter. It has to be a different source of truth for where a road is.

---------------------------------------------------------------------------
So the order of authority is inverted: **the streets decide, and the ground
follows them.** Two halves, and each has its own section below.

  1. `solve` reads the street centrelines, samples the terrain robustly along
     them, and solves one elevation per node of the whole street *graph* under a
     hard grade clamp. Cross streets share a node, so they share its height.

  2. `conform` pulls the terrain lattice onto that surface under every road
     corridor, with a feather band back to natural ground beyond it.

The second half is why this is a module and not a flag on `streets.py`. The road
mesh is draped on the terrain (`streets._emit_flat` cuts it against the terrain's
own facets and lifts it 2 cm), so a road cannot be flattened on its own without
either floating over the ground or sinking into it. Moving the *ground* is what
makes the road flat, and it takes the kerbs, the footpath, the contact skirt, the
building pads, the collision prisms, the parked cars, the powerups and the far
terrain with it for free -- every one of them reads `Terrain.sample`.

**It is applied to the global lattice, once, inside `Terrain.load`.** That is the
whole of the tile-independence and seam argument: there is only one surface, two
tiles sharing an edge read the same lattice elements as they always did, and no
tile has ever been able to see a road that another tile conformed differently
because no tile does the conforming. Nothing about the tile format, the sidecar
or the client changes; `.terr.bin` is the same 1,156 bytes of the same grid.

---------------------------------------------------------------------------
**What this deliberately does not fix**, so nobody has to rediscover it.

*A 31.25 m lattice cannot hold a level 12 m road beside a cliff.* The cell a
carriageway sits in has corners 44 m away, so if the ground has to fall ten
metres inside that distance, some of the fall lands on the road. Everything the
`CROSS_GRADE` block is about is choosing how much of that to allow, and the
thirteen segments left over the ceiling are the places where the answer is "some"
-- the stacked ramps of the Darling Harbour interchange, and two streets on the
Bellevue Hill escarpment where Sydney really is that steep. A finer lattice is
the only actual fix and it is a format change.

*Bridge decks get worse, not better.* They are drawn on the ground and are not
conformed, so once the ground around them moves they stand out further: the
Cahill Expressway ramps at Circular Quay are 783 m2 of asphalt at about 50%,
which is 0.28% of the road in the CBD tiles and every square metre of it under a
viaduct that should not be on the ground at all. That is the landmark pass.

*The datum drifts by a couple of metres.* `terrain.BASE_ELEVATION` is sampled
from the DEM before any of this runs, so world y = 0 is still the DEM's ground at
Town Hall and the *conformed* ground there is now 2.7 m below it. Nothing depends
on the difference -- everything stands on `Terrain.sample` -- and leaving the
datum where it is keeps `index.json`'s `datum_ahd` meaning what it always meant.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from . import config
from .sources import osm


# --- What counts as a road ----------------------------------------------------
#
# The same set `streets.StreetNetwork.load` draws a carriageway for -- surface
# ways only -- minus two classes.
#
# **Footways are out.** A park path is 2 m wide and often *is* a stair; levelling
# a 55 m corridor of Sydney Park around one would flatten the park to make a
# goat track comfortable. They keep draping on whatever the ground does, which is
# what a path does in life.
#
# **Bridges are out**, per the same reasoning in reverse: a bridge deck is not on
# the ground and its elevation is not a statement about the ground under it.
# Conforming to one would drag the terrain up into the Anzac Bridge's deck and
# fill the bay under it. 277 ways in the inner ring carry `bridge`, 24.5 km in
# total, and the short ones cost nothing to leave out -- the median is 31.6 m,
# far inside the reach of the approach ways either side, so a culvert crossing is
# conformed by its neighbours anyway. What stays natural is the 66 ways over
# 100 m, which is exactly the set that should. Their decks are a landmark problem
# and not this one; `cli.cmd_road_grade_audit` reports them separately rather
# than pretending they passed.
def _is_conformable(r: osm.OsmRoad) -> bool:
    return r.layer >= 0 and not r.tunnel and not r.bridge and not r.is_foot


# --- Sampling the ground ------------------------------------------------------

# Stations along a centreline, metres. Half the lattice spacing, so the profile
# resolves everything the surface it is going to become can hold.
STATION_M = 10.0

# The robust base signal is a **local plane fit with a low-quantile residual**,
# over a disc of this radius. See `_robust_profile` for why it is a plane fit and
# not simply the low quantile of the raw samples.
PROBE_RADIUS_M = 40.0
PROBE_RINGS = ((0.5, 8), (1.0, 16))  # (radius fraction, points) plus the centre
PROBE_QUANTILE = 0.25

# Length of the one-dimensional grey-scale opening along each centreline, metres.
# An opening with a flat structuring element passes a linear ramp EXACTLY and
# removes any positive excursion narrower than the element, which is precisely
# the shape of the error: contamination is always upward and a tower's footprint
# in a 60 m-smoothed DEM is 150-250 m across, while a hill is not. The cost is
# that a genuine crest is shaved by about (curvature * L^2 / 8) -- 0.75 m on a
# street cresting a real Sydney ridge at 100 m, which the smoother below would
# have taken anyway.
OPENING_M = 100.0

# --- The solve ----------------------------------------------------------------

# Smoothing length of the graph low-pass, metres. Chosen against the lattice
# rather than against the road: 45 m is a little over one post spacing, so the
# profile cannot ask the surface for a feature the surface cannot represent, and
# a 31 m facet never has to carry a bend.
SMOOTH_LEN_M = 45.0

# The two grades. `TARGET` is pulled toward and `MAX` is guaranteed: the solve
# projects onto the 10% set at `SOFT_PULL` strength and then onto the 15% set
# completely, so 15% is a property of the output rather than a hope about it.
#
# 15% is Sydney's real ceiling. There is no public street in the extent steeper
# than about 1:6.5, and the ones that come close -- the Argyle Cut approaches,
# Womerah Avenue, the Glebe Point ridge -- are famous for it.
TARGET_GRADE = 0.10
MAX_GRADE = 0.15
SOFT_PULL = 0.7

# --- Streets that are near each other but not connected -----------------------
#
# A grade clamp along the network is not enough, and the first cut of this module
# proved it: solving each connected path under a 15% ceiling still left 325
# segments over 15% and 1,086 over 15% of *bank* once the terrain followed. Every
# one of them was two streets close together in plan whose solved elevations
# disagreed -- Hickson Road under the Millers Point escarpment against Kent
# Street on top of it, the Western Distributor ramps stacked over Darling
# Harbour, the Barangaroo laneways beside 40 m of tower contamination. Nothing
# in the graph connects them within hundreds of metres, so the clamp allowed the
# difference, and then the conformance had to build the cliff between them --
# through the carriageways, because a 31 m lattice has nowhere else to put it.
#
# So the constraint is not on the road, it is on the **ground**: two points of
# the street network `TIE_RADIUS_M` apart in plan may not differ in height by
# more than `CROSS_GRADE` times that distance, however far apart they are along
# the network. `TIE_RADIUS_M` is the conformance's own reach, which is exactly
# the statement "if two roads can pull on the same lattice post, they have to
# agree about it".
#
# **`CROSS_GRADE` is the one number in this module that is a trade rather than a
# derivation, and it is 10% because that is where the curve turns.** A tie is a
# Lipschitz constraint and Lipschitz constraints are transitive, so a cap on what
# two streets 40 m apart may disagree about is also, through a chain of them, a
# cap on how fast the whole city may rise. Tightening it removes banked road and
# flattens real landform, in that order, and both were measured -- over the same
# 75,278 segments, against the height the raw DEM gives four landmarks:
#
#   cap    over 15% grade   over 15% bank   road vs DEM p95   Kings Cross   'Loo
#   none          1,049           4,033              --            54.0      6.7
#   25%             202             928            2.49 m          51.7      6.9
#   15%             128             230            2.90 m          51.4      6.9
#   12%              58              58            3.38 m          51.6      7.0
# > 10%              14              12            4.76 m          50.7      7.0
#    8%               2               4            6.87 m          49.2      8.1
#    6%               1               0           10.13 m          45.7     11.5
#
# The Kings Cross escarpment is the thing to watch, because it is the steepest
# piece of ground in the extent that a street runs along the top of: 25 m of drop
# into Woolloomooloo in about 60 m, which is what the McElhone Stairs are for.
# Down to 10% it costs 3 m of it and the valley floor does not move at all. At 6%
# the escarpment is gone -- the top has come down 8 m and the valley has come UP
# 5 -- which is a different city, and it buys twelve segments.
TIE_RADIUS_M = 75.0
CROSS_GRADE = 0.10
# Candidate neighbours examined per station. Its own way supplies about fifteen
# of them inside the radius, so this leaves room for three or four other streets,
# which is as many as ever reach one point of the network.
TIE_NEIGHBOURS = 32

# Sweeps allowed for each Lipschitz projection. A violation propagates one edge a
# sweep, so this is the longest shadow the clamp can cast: 400 stations is 4 km
# of road, which is longer than any continuous run in the extent.
MAX_SWEEPS = 400

# --- The conformance ----------------------------------------------------------

# Beyond the kerb and the footpath, metres. The verge that is part of the street
# even though nothing is paved on it.
CORRIDOR_MARGIN_M = 2.0

# **The plateau reaches one lattice cell diagonal past the corridor, and that is
# the load-bearing number in this module.**
#
# The terrain is only defined at 31.25 m posts; what the player walks on is the
# linear interpolation between them. So flattening only the posts that lie *on*
# the road achieves nothing: a cell containing carriageway has corners up to
# 31.25 * sqrt(2) = 44.19 m away, and if one of those corners keeps a
# contaminated DEM height then the facet the road is cut against still tilts, no
# matter how carefully the road's own posts were set. Every corner of every cell
# the carriageway touches has to be road-driven, which puts the plateau at
# corridor + 44.19 m -- about 55 m for an ordinary street.
#
# That is a lot of ground, and it is deliberate. In a terrace suburb it means the
# ground between two streets is an interpolation of their two levels, which is
# what ground between two streets actually is; in the CBD it means the DEM's
# tower plateaus survive only where nothing drives past them.
LATTICE_REACH_M = math.sqrt(2.0) * config.TILE_SIZE / config.TERRAIN_GRID

# The blend back to natural ground past the plateau, metres. Smoothstep, so the
# surface is C1 at both ends of the band and the seam between conformed and
# natural terrain has no crease in it.
FEATHER_M = 20.0

# --- Which road wins ----------------------------------------------------------
#
# Inside the plateau the height comes from the roads rather than the DEM, and
# where several roads reach the same post they are averaged by
#
#     weight = feather_weight / (max(distance, FLAT_CORE_M)^2 + SOFTEN_M^2)
#
# The two constants are what keep the carriageway level, and both are there for a
# reason the obvious version gets wrong.
#
# **`FLAT_CORE_M` is the floor under the distance**, and without it a plain
# inverse-square weighting builds a *crown*: the field is pinned to the road's
# own height on the centreline and drifts toward the neighbours away from it, so
# the road is a ridge and both kerbs fall away from the crest. Flooring the
# distance at 25 m makes the road's own weight constant across the whole corridor
# and the flanking posts, so what is left of the cross-fall is only the slow
# variation of the *distant* roads' weights -- 0.8% of bank for 4 m of relief
# across an 80 m block, against 5% for the unfloored version.
#
# **`SOFTEN_M` keeps the weight finite** so two ways of a dual carriageway, or
# the four arms of an intersection, average rather than fight over a post.
#
# **`OMEGA_POWER` is 2, meaning an inverse FOURTH power of distance, and the
# obvious inverse square is measurably wrong.** The weight is summed over
# *segments*, and a road is a line of them: integrating an inverse-square point
# weight along a straight line at perpendicular distance D gives pi/D, so a whole
# street a long way off carries only inverse-LINEAR weight and a crowd of them
# outvotes the one you are standing on. Measured in the Darling Harbour
# interchange, where a dozen ramps are within 50 m of each other, the inverse
# square put the ground 7.8 m away from the solved height of the ramp directly
# underfoot. An inverse fourth integrates to a line weight of 3/(4 D^3), which
# holds the nearest street at about ten to one against anything 45 m away.
OMEGA_POWER = 2
FLAT_CORE_M = 25.0
SOFTEN_M = 4.0


# --- The solved surface -------------------------------------------------------


@dataclass
class RoadSurface:
    """The solved street network as a height field over the plan.

    Stored as one flat run of station-to-station segments -- ends, end heights
    and reach -- rather than as ways, because every consumer asks the same
    question of it ("how high is the road near this point, and how much does it
    own the point") and none of them cares which way the answer came from.
    """

    a: np.ndarray  # (M, 2) segment start, ENU metres
    b: np.ndarray  # (M, 2) segment end
    ha: np.ndarray  # (M,) solved elevation at `a`, metres above the datum
    hb: np.ndarray  # (M,) at `b`
    plateau: np.ndarray  # (M,) full-weight radius
    stats: dict
    _bins: dict | None = None

    @property
    def reach(self) -> np.ndarray:
        """Where a segment's influence has fallen to nothing."""
        return self.plateau + FEATHER_M

    def _index(self) -> tuple[dict, float]:
        """A uniform bucket grid over the segments, built once on demand.

        `conform` needs no index at all -- it walks the segments and writes to
        the posts near each one -- so this exists only for `blend`, which asks
        the opposite question for the audit. A hash grid rather than an R-tree
        because the cell can be the largest reach in the build, which makes the
        lookup exactly nine buckets with no tree to descend.
        """
        if self._bins is None:
            cell = float(self.reach.max())
            buckets: dict[tuple[int, int], list[int]] = {}
            lo = np.minimum(self.a, self.b) / cell
            hi = np.maximum(self.a, self.b) / cell
            for k in range(len(self.a)):
                for cx in range(math.floor(lo[k, 0]), math.floor(hi[k, 0]) + 1):
                    for cy in range(math.floor(lo[k, 1]), math.floor(hi[k, 1]) + 1):
                        buckets.setdefault((cx, cy), []).append(k)
            self._bins = {"cell": cell, "buckets": {k: np.asarray(v) for k, v in buckets.items()}}
        return self._bins["buckets"], self._bins["cell"]

    def blend(self, east, north) -> tuple[np.ndarray, np.ndarray]:
        """(road height, weight) at arbitrary ENU points.

        The same field `conform` stamps onto the lattice, evaluated point by
        point -- for the audit, which has to be able to ask what the solve
        thought without going through a rebuilt tile to find out.
        """
        buckets, cell = self._index()
        e = np.asarray(east, dtype=np.float64).ravel()
        n = np.asarray(north, dtype=np.float64).ravel()
        h_out = np.zeros(len(e))
        w_out = np.zeros(len(e))
        cx = np.floor(e / cell).astype(np.int64)
        cy = np.floor(n / cell).astype(np.int64)
        for k in range(len(e)):
            near = [
                buckets[(cx[k] + dx, cy[k] + dy)]
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                if (cx[k] + dx, cy[k] + dy) in buckets
            ]
            if not near:
                continue
            idx = np.concatenate(near)
            d, h = _segment_distance_height(
                e[k], n[k], self.a[idx], self.b[idx], self.ha[idx], self.hb[idx]
            )
            w = _feather(d, self.reach[idx])
            if not (w > 0.0).any():
                continue
            omega = _omega(w, d)
            h_out[k] = float((omega * h).sum() / omega.sum())
            w_out[k] = float(w.max())
        return h_out, w_out


def _feather(d: np.ndarray, reach: np.ndarray) -> np.ndarray:
    """Smoothstep from 1 inside the plateau to 0 at `reach`."""
    u = np.clip((reach - d) / FEATHER_M, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def _omega(w: np.ndarray, d: np.ndarray) -> np.ndarray:
    """How strongly a segment claims a point. See the `FLAT_CORE_M` block."""
    core = np.maximum(d, FLAT_CORE_M)
    return w / (core * core + SOFTEN_M * SOFTEN_M) ** OMEGA_POWER


def _segment_distance_height(px, py, a, b, ha, hb):
    """Distance from points to segments, and the road height at the foot of it.

    Broadcasting, not looping: `px`/`py` and `a`/`b` are shaped so that the
    result is (points, segments) or (segments, stencil) depending on the caller.
    `t` is clamped to the segment, so past a way's last station the height is
    that station's -- a flat cap, matching the flat cap `streets._ribbon` puts on
    the surface itself.
    """
    abx = b[..., 0] - a[..., 0]
    aby = b[..., 1] - a[..., 1]
    apx = px - a[..., 0]
    apy = py - a[..., 1]
    denom = abx * abx + aby * aby
    # `np.where` rather than `np.divide(..., where=)`: the two operands are
    # broadcast against each other here (a column of posts against a row of
    # them), so there is no single output shape to hand the masked form.
    t = np.clip((apx * abx + apy * aby) / np.where(denom > 0.0, denom, 1.0), 0.0, 1.0)
    dx = apx - t * abx
    dy = apy - t * aby
    return np.hypot(dx, dy), ha + t * (hb - ha)


# --- Half one: the profile solve ----------------------------------------------


def solve(sample, radius_m: float, roads: list[osm.OsmRoad] | None = None) -> RoadSurface:
    """Solve one elevation profile for every street in the extent.

    `sample(east, north)` is the natural ground -- `Terrain.sample` against the
    unconformed lattice. Passed in rather than imported so this module never
    depends on the thing that is about to consume it.
    """
    if roads is None:
        roads = osm.read_roads(radius_m)
    kept = [r for r in roads if _is_conformable(r)]

    ways, corridors = _prepare(kept)
    if not ways:
        empty = np.zeros((0, 2))
        return RoadSurface(empty, empty, np.zeros(0), np.zeros(0), np.zeros(0), {"ways": 0})

    pts, way_of, node_of, edges, edge_len, n_nodes = _graph(ways)
    natural = np.asarray(sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
    z = _robust_profile(sample, pts, ways, way_of)

    # One observation per node: a junction is sampled once per arm and the arms
    # disagree by whatever the opening did to each of them, so they are averaged
    # before the solve rather than fought over inside it.
    obs = np.bincount(node_of, weights=z, minlength=n_nodes)
    hits = np.bincount(node_of, minlength=n_nodes)
    obs /= np.maximum(hits, 1)

    # The smoothing runs on the road graph alone -- it is a filter along a
    # street, and a street's neighbour has nothing to say about it. The clamp
    # runs on the road graph plus the plan ties, because that one is a statement
    # about the ground and the ground is shared. See `TIE_RADIUS_M`.
    h = _smooth(obs, edges, edge_len)
    ties, tie_len = _ties(pts, way_of, node_of, n_nodes)
    both = np.vstack((edges, ties))
    soft_limit = np.concatenate((TARGET_GRADE * edge_len, CROSS_GRADE * tie_len))
    hard_limit = np.concatenate((MAX_GRADE * edge_len, CROSS_GRADE * tie_len))
    h = h + SOFT_PULL * (_lipschitz(h, both, soft_limit) - h)
    h = _lipschitz(h, both, hard_limit)

    station_h = h[node_of]
    surface = _segments(ways, corridors, pts, way_of, station_h)

    grade = np.abs(h[edges[:, 1]] - h[edges[:, 0]]) / np.maximum(edge_len, 1e-6)
    surface.stats.update(
        ways=len(ways),
        stations=len(pts),
        nodes=int(n_nodes),
        junctions=int((hits > 1).sum()),
        grade_p50=float(np.percentile(grade, 50)),
        grade_p95=float(np.percentile(grade, 95)),
        grade_max=float(grade.max()),
        over_max=int((grade > MAX_GRADE + 1e-9).sum()),
        # How far the solved road ended up from the raw DEM under it. Reported
        # because it is the number that says whether this is a correction or a
        # rewrite: a metre or two is the tower contamination coming off, and ten
        # would mean the estimator had lost the city.
        drop_p50=float(np.percentile(natural - station_h, 50)),
        drop_p95=float(np.percentile(natural - station_h, 95)),
    )
    return surface


def _prepare(roads: list[osm.OsmRoad]) -> tuple[list[np.ndarray], list[float]]:
    """Centrelines worth solving, and how wide a corridor each one owns.

    The corridor is `streets.py`'s own arithmetic -- half the clamped
    carriageway, the kerb, the class's footpath band -- read from that module so
    the two cannot drift apart, plus a margin for the verge.
    """
    from . import streets  # local: `streets` pulls in the mesh builder.

    ways: list[np.ndarray] = []
    corridors: list[float] = []
    for r in roads:
        line = np.asarray(r.line, dtype=np.float64)
        if len(line) < 2:
            continue
        step = np.hypot(*np.diff(line, axis=0).T)
        if step.sum() < STATION_M:
            continue
        half = min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH) * 0.5
        foot = streets.FOOTPATH_WIDTH.get(r.highway, streets.FOOTPATH_WIDTH_DEFAULT)
        ways.append(line)
        corridors.append(half + streets.KERB_WIDTH + foot + CORRIDOR_MARGIN_M)
    return ways, corridors


def _graph(ways: list[np.ndarray]):
    """Stations along every way, wired into one node graph.

    Two ways that meet share the OSM node they meet at, and a shared node is the
    same geodetic coordinate projected by the same transform, so it is the same
    float twice -- keying on the rounded coordinate finds it exactly rather than
    within a tolerance. **This is what makes cross streets agree**: a junction is
    one unknown in the solve, so both streets read the same height out of it and
    neither can arrive at a crossing a metre above the other.

    Stations are every `STATION_M` along the way *plus* every junction vertex,
    so a T-junction into the middle of a way lands on a station rather than
    between two of them.
    """
    seen: dict[tuple[int, int], int] = {}
    for line in ways:
        for key in {_key(p) for p in line}:
            seen[key] = seen.get(key, 0) + 1

    pts: list[np.ndarray] = []
    way_of: list[np.ndarray] = []
    node_of: list[int] = []
    edges: list[tuple[int, int]] = []
    edge_len: list[float] = []
    node_id: dict[tuple[int, int], int] = {}
    n_nodes = 0

    for wi, line in enumerate(ways):
        step = np.hypot(*np.diff(line, axis=0).T)
        s = np.concatenate(([0.0], np.cumsum(step)))
        total = s[-1]
        # Uniform stations, then the junction vertices folded in and anything
        # that collides with one dropped -- two stations 1 cm apart would be a
        # 1 cm edge, which the smoother's 1/len^2 weight would treat as a weld.
        want = list(np.linspace(0.0, total, max(round(total / STATION_M) + 1, 2)))
        junctions = {}
        for k, p in enumerate(line):
            key = _key(p)
            if seen.get(key, 0) > 1 or k in (0, len(line) - 1):
                want.append(float(s[k]))
                junctions[round(float(s[k]), 6)] = key
        want.sort()
        keep = [want[0]]
        for v in want[1:]:
            if v - keep[-1] > 1.0:
                keep.append(v)
            elif round(v, 6) in junctions:
                keep[-1] = v  # a junction always wins the slot it lands in
        ss = np.asarray(keep)

        idx = np.clip(np.searchsorted(s, ss, side="right") - 1, 0, len(step) - 1)
        frac = (ss - s[idx]) / np.where(step[idx] > 0.0, step[idx], 1.0)
        p = line[idx] + (line[idx + 1] - line[idx]) * frac[:, None]

        first = len(node_of)
        for k, sv in enumerate(ss):
            key = junctions.get(round(float(sv), 6))
            if key is None:
                node_of.append(n_nodes)
                n_nodes += 1
            else:
                nid = node_id.get(key)
                if nid is None:
                    nid = node_id[key] = n_nodes
                    n_nodes += 1
                node_of.append(nid)
        for k in range(len(ss) - 1):
            i, j = node_of[first + k], node_of[first + k + 1]
            if i == j:
                continue
            edges.append((i, j))
            edge_len.append(float(ss[k + 1] - ss[k]))

        pts.append(p)
        way_of.append(np.full(len(ss), wi, dtype=np.int64))

    return (
        np.concatenate(pts),
        np.concatenate(way_of),
        np.asarray(node_of, dtype=np.int64),
        np.asarray(edges, dtype=np.int64).reshape(-1, 2),
        np.asarray(edge_len, dtype=np.float64),
        n_nodes,
    )


def _key(p) -> tuple[int, int]:
    """A vertex's identity, to the millimetre."""
    return (round(float(p[0]) * 1000.0), round(float(p[1]) * 1000.0))


def _robust_profile(sample, pts: np.ndarray, ways, way_of: np.ndarray) -> np.ndarray:
    """The ground under a street, with the buildings taken back out of it.

    **A local plane fit with a low-quantile residual**, and the plane is what
    makes it usable. The obvious estimator -- the low quantile of the DEM in a
    neighbourhood, which is right in principle because contamination is only ever
    upward -- has a bias that disqualifies it: on a uniform 8% hillside the 25th
    percentile over a 40 m disc sits 2 m *below* the centre, so every road on a
    slope would be cut two metres into it. Fitting a plane first and taking the
    quantile of the RESIDUAL removes the bias exactly, because the residual of a
    plane is zero however steep the plane is. What survives the quantile is only
    the part of the neighbourhood that is not a slope, which is the buildings.

    Then a one-dimensional opening along the way, which is the same argument in
    the other axis: the disc cannot see a spike wider than itself, and a row of
    towers along a street is exactly that. See `OPENING_M`.
    """
    offsets = [(0.0, 0.0)]
    for frac, count in PROBE_RINGS:
        r = PROBE_RADIUS_M * frac
        for k in range(count):
            a = 2.0 * math.pi * k / count
            offsets.append((r * math.cos(a), r * math.sin(a)))
    off = np.asarray(offsets)

    # The design matrix is the same for every station -- the probe pattern does
    # not move -- so the least-squares solve is one precomputed 3xK matrix
    # multiply for the whole city rather than a fit per station.
    design = np.column_stack((np.ones(len(off)), off[:, 0], off[:, 1]))
    pinv = np.linalg.pinv(design)

    z = np.empty((len(pts), len(off)))
    for k, (dx, dy) in enumerate(offsets):
        z[:, k] = sample(pts[:, 0] + dx, pts[:, 1] + dy)
    coef = z @ pinv.T
    residual = z - coef @ design.T
    base = coef[:, 0] + np.quantile(residual, PROBE_QUANTILE, axis=1)

    if OPENING_M <= 0.0:
        return base
    width = max(round(OPENING_M / STATION_M), 1)
    out = base.copy()
    starts = np.searchsorted(way_of, np.arange(len(ways)), side="left")
    ends = np.searchsorted(way_of, np.arange(len(ways)), side="right")
    for lo, hi in zip(starts, ends):
        if hi - lo >= 3:
            out[lo:hi] = ndimage.grey_opening(base[lo:hi], size=width, mode="nearest")
    return out


def _smooth(obs: np.ndarray, edges: np.ndarray, edge_len: np.ndarray) -> np.ndarray:
    """Low-pass the observations over the graph.

    Minimises `sum (h - z)^2 + sum_edges (SMOOTH_LEN_M / len)^2 (h_j - h_i)^2`,
    which on a straight run is the standard first-difference smoother with a
    decay length of `SMOOTH_LEN_M` and at a junction is the thing a per-way
    filter cannot be: all arms pulling on one unknown.

    Solved by conjugate gradients rather than a factorisation. The matrix is
    symmetric positive definite with a condition number around 4 * lambda, so it
    converges in a few dozen iterations at any city size, it never materialises a
    fill-in the extent could not hold, and -- since the iteration is a fixed
    sequence of dot products on a fixed input -- it returns the same floats every
    run, which the rest of this module's determinism rests on.
    """
    n = len(obs)
    weight = (SMOOTH_LEN_M / np.maximum(edge_len, 1e-6)) ** 2
    i, j = edges[:, 0], edges[:, 1]

    diag = 1.0 + np.bincount(i, weights=weight, minlength=n) + np.bincount(
        j, weights=weight, minlength=n
    )

    def matvec(x: np.ndarray) -> np.ndarray:
        flow = weight * (x[i] - x[j])
        return (
            x
            + np.bincount(i, weights=flow, minlength=n)
            - np.bincount(j, weights=flow, minlength=n)
        )

    b = obs
    x = obs.copy()
    r = b - matvec(x)
    m = 1.0 / diag  # Jacobi preconditioner
    zr = m * r
    p = zr.copy()
    rz = float(r @ zr)
    for _ in range(500):
        if rz <= 1e-12 * len(obs):
            break
        ap = matvec(p)
        alpha = rz / float(p @ ap)
        x += alpha * p
        r -= alpha * ap
        zr = m * r
        rz_next = float(r @ zr)
        p = zr + (rz_next / rz) * p
        rz = rz_next
    return x


def _ties(pts: np.ndarray, way_of: np.ndarray, node_of: np.ndarray, n_nodes: int):
    """Edges between stations that are near each other but on different ways.

    See the `TIE_RADIUS_M` block for what they are for. A k-nearest query rather
    than an all-pairs one inside the radius: in the CBD a station has upward of
    forty neighbours within 75 m and thirty-odd of them are the next stations
    along its own way, which carry no information the road edges do not already
    have. Taking the nearest `TIE_NEIGHBOURS` and keeping the ones from other
    ways gets every distinct street that reaches the point, at a twentieth of
    the pairs.
    """
    from scipy.spatial import cKDTree

    tree = cKDTree(pts)
    dist, idx = tree.query(pts, k=min(TIE_NEIGHBOURS, len(pts)), distance_upper_bound=TIE_RADIUS_M)
    src = np.repeat(np.arange(len(pts)), idx.shape[1])
    dst = idx.ravel()
    d = dist.ravel()
    live = np.isfinite(d) & (dst < len(pts))
    src, dst, d = src[live], dst[live], d[live]
    live = way_of[src] != way_of[dst]
    src, dst, d = src[live], dst[live], d[live]

    a = node_of[src]
    b = node_of[dst]
    live = a != b
    a, b, d = a[live], b[live], d[live]
    # One edge per node pair, keeping the shortest sighting of it: the same two
    # streets are seen by several station pairs and the tightest is the binding
    # one. Sorting the pair first makes (i, j) and (j, i) the same edge.
    lo = np.minimum(a, b)
    hi = np.maximum(a, b)
    order = np.lexsort((d, hi, lo))
    lo, hi, d = lo[order], hi[order], d[order]
    first = np.ones(len(lo), dtype=bool)
    first[1:] = (lo[1:] != lo[:-1]) | (hi[1:] != hi[:-1])
    return np.column_stack((lo[first], hi[first])), np.maximum(d[first], 1.0)


def _lipschitz(h: np.ndarray, edges: np.ndarray, limit: np.ndarray) -> np.ndarray:
    """The nearest profile that respects every edge's height budget.

    Two one-sided projections and their average. `low` relaxes
    `h_i <- min(h_i, h_j + limit)` to a fixpoint, which is the largest function
    obeying every budget that lies *below* h; `high` does the mirror image and is
    the smallest one above. Both obey the budgets, so their average does too --
    the constraint set is convex -- and averaging is what keeps a clamped crest
    from being shaved twice: cutting a spike down (low) and filling the valleys
    either side of it up (high) are both legal answers and the truth is between
    them.

    The fixpoint does not depend on the order the edges are relaxed in, so
    neither does the result.
    """
    i, j = edges[:, 0], edges[:, 1]

    def relax(x: np.ndarray, sign: float) -> np.ndarray:
        out = (sign * x).copy()
        for _ in range(MAX_SWEEPS):
            before = out.sum()
            np.minimum.at(out, j, out[i] + limit)
            np.minimum.at(out, i, out[j] + limit)
            if out.sum() == before:
                break
        return sign * out

    return 0.5 * (relax(h, 1.0) + relax(h, -1.0))


def _segments(ways, corridors, pts, way_of, station_h) -> RoadSurface:
    """The solved stations, rewritten as the segment run `RoadSurface` wants."""
    starts = np.searchsorted(way_of, np.arange(len(ways)), side="left")
    ends = np.searchsorted(way_of, np.arange(len(ways)), side="right")
    keep = np.ones(len(pts), dtype=bool)
    keep[ends - 1] = False  # no segment leaves a way's last station
    a = pts[keep]
    b = pts[np.roll(keep, 1)]
    ha = station_h[keep]
    hb = station_h[np.roll(keep, 1)]
    plateau = np.repeat(
        np.asarray(corridors) + LATTICE_REACH_M, (ends - starts) - 1
    )
    return RoadSurface(a=a, b=b, ha=ha, hb=hb, plateau=plateau, stats={})


# --- Half two: the conformance ------------------------------------------------

# Diffusion passes over the road field once it is on the lattice, and how far
# each one moves a post toward its neighbours.
#
# The field is evaluated at each post independently, so what each post sees of
# the streets around it changes a little from post to post -- and the road under
# it is only sampled every 31.25 m, so a third of a metre of that jitter is 1% of
# grade the profile never asked for. Measured along Arthur Street in Rose Bay,
# whose solved profile runs at a smooth 12.0%, the unrelaxed lattice delivered
# 16.3%: the profile was right and the sampling of it was not.
#
# Two passes at 0.5 is a kernel one post wide -- under a single facet -- so it
# removes what varies from post to post and leaves what the road is doing. It
# also spreads the terrace step between two streets at different levels over
# three posts instead of one, which is the other half of what it buys: at a
# 10% cross-network cap it takes the segments over 15% of grade from 14 to 4 and
# the ones over 15% of bank from 12 to 9. Four passes and eight were measured and
# neither is better -- past one facet the diffusion starts pulling the terrace
# step back ACROSS the road it was keeping off, and p95 of the bank goes up.
#
# **Only posts the roads reached take part**, and a post outside the field is not
# a zero but an absence: the average is over the live neighbours only, which is a
# Neumann edge and leaves the feather band to do the blending it already does.
RELAX_PASSES = 2
RELAX_RATE = 0.5


def _relax_field(road: np.ndarray, live: np.ndarray, q_n: int, p_n: int) -> np.ndarray:
    """Diffuse the road field over the lattice. See `RELAX_PASSES`."""
    if RELAX_PASSES <= 0:
        return road
    grid = road.reshape(q_n, p_n).copy()
    mask = live.reshape(q_n, p_n)
    val = np.where(mask, grid, 0.0)
    for _ in range(RELAX_PASSES):
        acc = np.zeros_like(grid)
        cnt = np.zeros_like(grid)
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            acc += np.roll(val, shift, axis=axis)
            cnt += np.roll(mask.astype(np.float64), shift, axis=axis)
        # `np.roll` wraps, which would let the north edge of the lattice average
        # against the south one. The lattice is a whole tile wider than the build
        # radius on every side and no road reaches its border, so the wrapped
        # neighbours are dead in `mask` and contribute nothing -- but the rows are
        # zeroed anyway rather than relying on that holding at some future radius.
        cnt[0, :] = cnt[-1, :] = cnt[:, 0] = cnt[:, -1] = 0.0
        moved = np.divide(acc, cnt, out=grid.copy(), where=cnt > 0.0)
        grid = np.where(mask & (cnt > 0.0), grid + RELAX_RATE * (moved - grid), grid)
        val = np.where(mask, grid, 0.0)
    return grid.ravel()


def conform(heights: np.ndarray, p0: int, q0: int, spacing: float, surface: RoadSurface) -> dict:
    """Pull the terrain lattice onto the solved road surface, in place.

    `heights[qi, pi]` is the post at east `(p0 + pi) * spacing`, north
    `(q0 + qi) * spacing` -- `terrain._Lattice`'s own layout, taken apart here so
    this module needs nothing from that one.

    Segment-major with a fixed stencil: each segment writes to the few posts
    inside its reach rather than each post searching for segments, which turns
    the whole thing into one vectorised gather-scatter with no spatial index at
    all. The scatter is `np.add.at` and `np.maximum.at` over a segment order that
    is fixed by the way list, so two runs accumulate the same floats in the same
    order and the surface is bit-reproducible.
    """
    if len(surface.a) == 0:
        return {"posts": 0, "conformed": 0}

    q_n, p_n = heights.shape
    reach = surface.reach
    lo_p = np.floor(np.minimum(surface.a[:, 0], surface.b[:, 0]) / spacing - p0 - reach / spacing)
    hi_p = np.ceil(np.maximum(surface.a[:, 0], surface.b[:, 0]) / spacing - p0 + reach / spacing)
    lo_q = np.floor(np.minimum(surface.a[:, 1], surface.b[:, 1]) / spacing - q0 - reach / spacing)
    hi_q = np.ceil(np.maximum(surface.a[:, 1], surface.b[:, 1]) / spacing - q0 + reach / spacing)
    span = int(max((hi_p - lo_p).max(), (hi_q - lo_q).max())) + 1
    lo_p = lo_p.astype(np.int64)
    lo_q = lo_q.astype(np.int64)

    num = np.zeros(heights.size)
    den = np.zeros(heights.size)
    wmax = np.zeros(heights.size)
    step = np.arange(span)

    # Chunked so the (segments x stencil x stencil) working set stays inside a
    # few tens of megabytes whatever the extent.
    chunk = max(1, 2_000_000 // (span * span))
    for lo in range(0, len(surface.a), chunk):
        hi = min(lo + chunk, len(surface.a))
        pi = lo_p[lo:hi, None, None] + step[None, :, None]
        qi = lo_q[lo:hi, None, None] + step[None, None, :]
        inside = (pi >= 0) & (pi < p_n) & (qi >= 0) & (qi < q_n)
        east = (pi + p0) * spacing
        north = (qi + q0) * spacing
        d, h = _segment_distance_height(
            east, north,
            surface.a[lo:hi, None, None, :], surface.b[lo:hi, None, None, :],
            surface.ha[lo:hi, None, None], surface.hb[lo:hi, None, None],
        )
        w = _feather(d, reach[lo:hi, None, None])
        live = inside & (w > 0.0)
        if not live.any():
            continue
        flat = (np.clip(qi, 0, q_n - 1) * p_n + np.clip(pi, 0, p_n - 1))[live]
        w = w[live]
        omega = _omega(w, d[live])
        num += np.bincount(flat, weights=omega * h[live], minlength=heights.size)
        den += np.bincount(flat, weights=omega, minlength=heights.size)
        np.maximum.at(wmax, flat, w)

    road = _relax_field(
        np.divide(num, den, out=np.zeros_like(num), where=den > 0.0), den > 0.0, q_n, p_n
    )
    natural = heights.astype(np.float64).ravel()
    blended = natural + wmax * (road - natural)
    moved = np.abs(blended - natural)
    heights[:] = blended.reshape(heights.shape).astype(heights.dtype)
    return {
        "posts": int(heights.size),
        "conformed": int((wmax > 0.0).sum()),
        "plateau": int((wmax >= 1.0).sum()),
        "moved_p50": float(np.percentile(moved[wmax > 0.0], 50)) if (wmax > 0).any() else 0.0,
        "moved_p95": float(np.percentile(moved[wmax > 0.0], 95)) if (wmax > 0).any() else 0.0,
        "moved_max": float(moved.max()),
    }
