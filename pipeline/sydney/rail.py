"""The rail service core: graph, lines, distance-time curves, block phases.

TRAINS.md is the plan of record and this module is its phase-2 half -- the
*service*, not the geometry. Nothing here emits a triangle. What it emits is the
one artefact every later round needs and none of them can re-derive cheaply:

    a rail graph in world ENU metres, ten stopping patterns pathed end to end
    through it, a closed-form distance-time curve per line per direction, and a
    set of integer phase offsets proved to keep every train out of every other
    train's block section.

------------------------------------------------------------------------------
WHY THE TIMETABLE IS SOLVED HERE AND NOT POLICED AT RUNTIME

A train that brakes for another train is a train whose position is no longer a
pure function of the clock, and the moment that is true the server has to stream
train positions, `poseTrain` stops being `poseCar`'s twin, and riding one stops
being free. So the collision question is answered once, at bake time, over the
whole 120 s cycle, by brute force -- and then re-answered by two independent
readers (`rail-audit` here, `checkRail` in `server/integration-check.ts`) that
share no code. The bays/hex precedent: never trust one implementation of an
invariant.

------------------------------------------------------------------------------
WHAT THE RELATIONS LAYER ACTUALLY GAVE US

TRAINS.md flagged the risk that GDAL's `multilinestrings` layer would not carry
`route=train` relations through the clip. It does -- 94 of them, refs `T1`..`T9`
and the two Metro relations among them. What it does **not** carry is the thing a
timetable actually needs: the ordered member list with `stop`/`platform` roles.
GDAL merges a relation into bare linework and drops the roles, so there is no
station *sequence* to read, only a corridor.

That is still worth a great deal, and this module uses it for exactly what it is
good for: the corridor is a soft cost preference on the graph and the chooser of
*which platform track* a line's station anchor sits on. The sequences themselves
are hand-curated below in `LINES`, which TRAINS.md sanctioned as the fallback and
which the timetable needed anyway.

------------------------------------------------------------------------------
THE VERTICAL IS TAG-DERIVED, THE HEIGHT IS SOLVED

Whether a station is underground is a fact in the extract -- `tunnel=yes` on the
ways that reach it -- and it is read, never guessed. The *height* of the track is
solved: raw heights come off the terrain with a per-class offset (tunnels below,
viaducts above), then a symmetric grade projection pulls the profile onto the
3.3% ruling gradient a railway is allowed. It is the one place here that invents
a number, and `rail-audit` prints how far it had to move things.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import time
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import config, geo
from .sources.osm import PBF_PATH, _as_layer, _project, _read_layer, _within_radius

# --- The physics, all of it -----------------------------------------------------
#
# TRAINS.md section 0 argues these numbers and the user approved them. They are
# repeated in `client/src/game/rail.ts` only as a cross-check; the baked curve is
# the contract, not these.

ACCEL = 1.0  # m/s^2, close to real EMU tractive performance
BRAKE = 1.1  # m/s^2, service brake rather than emergency
V_LOCAL = 36.1  # m/s = 130 km/h between adjacent stops
V_EXPRESS = 44.4  # m/s = 160 km/h where the run between stops earns it
EXPRESS_MIN_M = 2500.0  # a leg shorter than this never reaches express speed anyway
DWELL_S = 15.0  # doors open the whole of it -- the user's "15 sec"

BASE_PERIOD_S = 120  # per direction. The user's "every min a train can come".
DEGRADED_PERIOD_S = 180  # what an unsolvable trunk costs, reported not hidden

BLOCK_TARGET_M = 400.0  # junction-aligned block sections
SEP_S = 20.0  # two trains in one block must be this far apart in time
SEP_JUNCTION_S = 8.0  # ...or this, through a junction block

MAX_GRADIENT = 0.033  # the ruling gradient a Sydney railway is built to

# Vertical offsets applied to the terrain before the grade projection, metres.
TUNNEL_DEPTH = 16.0
BRIDGE_RISE = 7.0
CUTTING_DROP = 4.0
EMBANKMENT_RISE = 4.0

# Overhead wiring. Sydney's 1500 V DC catenary is on masts at roughly this
# spacing; a portal gantry replaces the cantilever where the corridor is wide.
STANCHION_SPACING_M = 60.0
PORTAL_MIN_TRACKS = 3  # >2 parallel tracks gets a gantry rather than a cantilever
PARALLEL_TRACK_M = 12.0  # how far sideways to look for a neighbouring track

# 2026-01-01T00:00:00Z, the same instant `traffic.ts` counts from. Shared by
# value rather than by import: the two systems must agree about when "now" is
# and neither may drag the other's module into its process.
RAIL_EPOCH_MS = 1767225600000

BAKE_VERSION = 1
RAIL_MAGIC = 0x4C494152  # 'RAIL' little-endian

OUT_DIR = config.DATA_ROOT / "scratch" / "rail"

# Three-valued exit, `cli.py`'s convention.
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_UNRESOLVED = 2


# --- Reading the extract --------------------------------------------------------


@dataclass
class RailWay:
    """One `railway=rail|subway` way, projected, with the tags that matter."""

    osm_id: str
    line: np.ndarray  # (N, 2) ENU metres
    kind: str  # 'rail' | 'subway'
    name: str | None
    tunnel: bool
    bridge: bool
    cutting: bool
    embankment: bool
    layer: int
    electrified: str | None
    gauge: str | None
    usage: str | None  # 'main' | 'branch' | 'industrial' | ...
    service: str | None  # 'yard' | 'siding' | 'spur' | 'crossover'
    tracks: int  # `tracks=*` where mapped, else 1


@dataclass
class RailStation:
    """A station, from a node or a closed way, with its platforms attached."""

    osm_id: str
    name: str
    east: float
    north: float
    kind: str  # 'subway' | 'light_rail' | '' (heavy rail)
    platforms: int = 0
    platform_area: float = 0.0
    # Filled in by `classify_vertical`.
    vertical: str = "unknown"  # 'surface' | 'elevated' | 'underground'
    ways_near: int = 0
    tunnel_share: float = 0.0
    bridge_share: float = 0.0
    ground_y: float = 0.0
    track_y: float = 0.0
    # Metres of terrain over the platform. See `classify_vertical`.
    depth: float = 0.0
    # Tunnel share of the track at this station's own level within
    # `STATION_APPROACH_RADIUS_M`, and whether it was what decided the verdict.
    approach_share: float = 0.0
    approach_ways: int = 0
    promoted: bool = False
    # A light-rail stop whose nearest track was somebody else's tunnel.
    orphaned: bool = False


# `railway=platform` also appears on the `lines` layer as an open way; only the
# polygons are counted here, which is what TRAINS.md measured (650).
def read_rail(radius_m: float, path: Path = PBF_PATH, kinds: tuple[str, ...] = ("rail", "subway")):
    """Rail ways, station nodes/areas and platform polygons, all in ENU metres.

    One pass per GDAL layer rather than one per feature class -- the `lines`
    layer alone is half a million features over the 60 km clip and reading it
    twice costs more than everything else here put together.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)

    ways: list[RailWay] = []
    station_rows: list[tuple[str, str, float, float, str]] = []

    geoms, attrs = _read_layer(path, "lines", bbox)
    for geom, a in zip(geoms, attrs):
        rw = a.get("railway")
        if rw == "station":
            # Sydney's big stations are closed ways; GDAL leaves them here
            # because `railway` is not area-forming in its default osmconf.
            if geom.geom_type != "LineString" or not geom.is_closed:
                continue
            c = _project(geom).centroid
            if not _within_radius(c, radius_m):
                continue
            name = (a.get("name") or "").strip()
            if name:
                station_rows.append(
                    (str(a.get("osm_id") or ""), name, float(c.x), float(c.y),
                     str(a.get("station") or ""))
                )
            continue
        if rw not in kinds:
            continue
        proj = _project(geom)
        parts = list(proj.geoms) if proj.geom_type == "MultiLineString" else [proj]
        for ln in parts:
            if ln.is_empty or ln.length < 1.0:
                continue
            coords = np.asarray(ln.coords, dtype=np.float64)
            if not (np.hypot(coords[:, 0], coords[:, 1]) <= radius_m).any():
                continue
            ways.append(
                RailWay(
                    osm_id=str(a.get("osm_id") or ""),
                    line=coords,
                    kind=str(rw),
                    name=a.get("name") or None,
                    tunnel=a.get("tunnel") in ("yes", "building_passage", "passage", "culvert"),
                    bridge=a.get("bridge") in ("yes", "viaduct", "aqueduct"),
                    cutting=a.get("cutting") in ("yes", "left", "right", "both"),
                    embankment=a.get("embankment") in ("yes", "left", "right", "both"),
                    layer=_as_layer(a.get("layer")),
                    electrified=a.get("electrified") or None,
                    gauge=a.get("gauge") or None,
                    usage=a.get("usage") or None,
                    service=a.get("service") or None,
                    tracks=_small_int(a.get("tracks"), 1),
                )
            )

    geoms, attrs = _read_layer(path, "points", bbox)
    for geom, a in zip(geoms, attrs):
        if a.get("railway") != "station":
            continue
        p = _project(geom)
        if not _within_radius(p, radius_m):
            continue
        name = (a.get("name") or "").strip()
        if not name:
            continue
        station_rows.append(
            (str(a.get("osm_id") or ""), name, float(p.x), float(p.y), str(a.get("station") or ""))
        )

    platforms: list[tuple[float, float, float]] = []  # east, north, area
    geoms, attrs = _read_layer(path, "multipolygons", bbox)
    for geom, a in zip(geoms, attrs):
        rw = a.get("railway")
        if rw == "station":
            # The third place a station hides. GDAL promotes a `railway=station`
            # ring to `multipolygons` when it also carries an area-forming tag,
            # and leaves it on `lines` when it does not -- so a reader that
            # checks only one of them loses whichever stations happen to be
            # mapped the other way. Killara, Leppington and Olympic Park are
            # exactly those three, and all three are on lines this service runs.
            proj = _project(geom)
            if proj.is_empty:
                continue
            c = proj.centroid
            if not _within_radius(c, radius_m):
                continue
            name = (a.get("name") or "").strip()
            if name:
                station_rows.append(
                    (str(a.get("osm_way_id") or a.get("osm_id") or ""), name,
                     float(c.x), float(c.y), str(a.get("station") or ""))
                )
            continue
        if rw != "platform":
            continue
        proj = _project(geom)
        if proj.is_empty:
            continue
        c = proj.centroid
        if not _within_radius(c, radius_m):
            continue
        platforms.append((float(c.x), float(c.y), float(proj.area)))

    stations = _dedupe_stations(station_rows)
    _attach_platforms(stations, platforms)
    return ways, stations, platforms


def _small_int(v: Any, default: int) -> int:
    try:
        n = int(str(v).split(";")[0].strip())
    except (TypeError, ValueError):
        return default
    return n if 0 < n <= 40 else default


# Two objects for one station -- a node inside the concourse and the ring around
# it -- is the normal mapping in Sydney, and both are read above because neither
# alone covers the network (Central, Museum and St James have no node at all;
# most suburban stations have no ring). Merged on name within this radius: two
# `Redfern`s 40 m apart are one station, and the two `Central`s at opposite ends
# of a 400 m concourse still are.
STATION_MERGE_M = 450.0


def _dedupe_stations(rows: Sequence[tuple[str, str, float, float, str]]) -> list[RailStation]:
    by_name: dict[str, list[tuple[str, str, float, float, str]]] = defaultdict(list)
    for r in rows:
        by_name[r[1]].append(r)

    out: list[RailStation] = []
    for name, group in by_name.items():
        clusters: list[list[tuple[str, str, float, float, str]]] = []
        for r in group:
            for c in clusters:
                if math.hypot(c[0][2] - r[2], c[0][3] - r[3]) <= STATION_MERGE_M:
                    c.append(r)
                    break
            else:
                clusters.append([r])
        for c in clusters:
            # The *way* centroid is the better centre when there is one -- it is
            # the middle of the whole station rather than wherever a mapper put
            # the node -- so it sorts first and wins the id.
            c.sort(key=lambda r: (0 if len(r[0]) and r[4] != "" else 1))
            east = sum(r[2] for r in c) / len(c)
            north = sum(r[3] for r in c) / len(c)
            kind = next((r[4] for r in c if r[4]), "")
            out.append(
                RailStation(osm_id=c[0][0], name=name, east=east, north=north, kind=kind)
            )
    out.sort(key=lambda s: (s.name, round(s.east, 1)))
    return out


PLATFORM_RADIUS_M = 260.0


def _attach_platforms(stations: list[RailStation], platforms: Sequence[tuple[float, float, float]]):
    if not stations or not platforms:
        return
    from scipy.spatial import cKDTree

    tree = cKDTree(np.array([[s.east, s.north] for s in stations]))
    pts = np.array([[p[0], p[1]] for p in platforms])
    d, i = tree.query(pts, distance_upper_bound=PLATFORM_RADIUS_M)
    for k, (dist, idx) in enumerate(zip(d, i)):
        if not np.isfinite(dist):
            continue
        stations[idx].platforms += 1
        stations[idx].platform_area += platforms[k][2]


# --- The graph ------------------------------------------------------------------


@dataclass
class RailGraph:
    """A topological graph of the rail network in ENU metres.

    Nodes are welded on quantised coordinates. Two ways that share an OSM node
    project to bit-identical ENU, so the quantisation is a guard rather than a
    heuristic; 1 mm is far below any real track separation and far above any
    projection wobble.
    """

    xy: np.ndarray  # (N, 2) ENU
    y: np.ndarray  # (N,) height, filled by `solve_heights`
    edges: np.ndarray  # (E, 2) node indices
    length: np.ndarray  # (E,) metres
    way_of: np.ndarray  # (E,) index into `ways`
    ways: list[RailWay]
    adj: list[list[int]] = field(default_factory=list)  # node -> edge indices

    @property
    def n_nodes(self) -> int:
        return int(self.xy.shape[0])

    @property
    def n_edges(self) -> int:
        return int(self.edges.shape[0])


WELD_MM = 1000.0  # 1/WELD_MM metres of quantisation; 1 mm

# --- Why the graph is densified, which is not a cosmetic decision ----------------
#
# A tunnel is mapped as a handful of very long straight segments -- the City
# Circle between Museum and St James is two vertices and 700 m -- while a curve
# on the surface has a vertex every few metres. Three things break on that:
#
#   * a station's candidate anchors are "the nodes within 400 m", and at St James
#     the City Circle contributes almost none of them while the Eastern Suburbs
#     and Metro tunnels passing overhead contribute plenty. The router then picks
#     a platform on the wrong railway and the leg has no path. Observed exactly
#     that at St James and at Punchbowl.
#   * a block section cannot be shorter than an edge, so a 1.9 km segment is a
#     1.9 km block, and a block that long makes the separation constraint claim
#     a whole suburb is occupied.
#   * the runtime polyline is what a train is drawn along, and a 700 m straight
#     through a curved tunnel is visible from inside the train.
#
# 120 m costs about 40% more nodes and fixes all three.
SEGMENT_MAX_M = 120.0


def build_graph(ways: Sequence[RailWay]) -> RailGraph:
    index: dict[tuple[int, int], int] = {}
    xs: list[float] = []
    ys: list[float] = []
    eu: list[int] = []
    ev: list[int] = []
    el: list[float] = []
    ew: list[int] = []

    def node(e: float, n: float) -> int:
        key = (round(e * WELD_MM), round(n * WELD_MM))
        got = index.get(key)
        if got is None:
            got = len(xs)
            index[key] = got
            xs.append(e)
            ys.append(n)
        return got

    for wi, w in enumerate(ways):
        prev = node(float(w.line[0, 0]), float(w.line[0, 1]))
        for k in range(1, w.line.shape[0]):
            e1, n1 = float(w.line[k, 0]), float(w.line[k, 1])
            e0, n0 = xs[prev], ys[prev]
            span = math.hypot(e1 - e0, n1 - n0)
            if span < 1e-9:
                continue
            # Interior points only; the way's own vertices are welded by value
            # and must stay bit-identical so two ways sharing a node still share
            # it. `parts` is a function of the geometry alone, so two runs of the
            # pipeline cut the same segment in the same places.
            parts = max(1, math.ceil(span / SEGMENT_MAX_M))
            for p in range(1, parts + 1):
                if p == parts:
                    cur = node(e1, n1)
                else:
                    f = p / parts
                    cur = node(e0 + (e1 - e0) * f, n0 + (n1 - n0) * f)
                if cur == prev:
                    continue
                eu.append(prev)
                ev.append(cur)
                el.append(math.hypot(xs[cur] - xs[prev], ys[cur] - ys[prev]))
                ew.append(wi)
                prev = cur

    g = RailGraph(
        xy=np.column_stack([np.array(xs), np.array(ys)]),
        y=np.zeros(len(xs)),
        edges=np.column_stack([np.array(eu, dtype=np.int64), np.array(ev, dtype=np.int64)]),
        length=np.array(el),
        way_of=np.array(ew, dtype=np.int64),
        ways=list(ways),
    )
    g.adj = [[] for _ in range(g.n_nodes)]
    for ei in range(g.n_edges):
        g.adj[int(g.edges[ei, 0])].append(ei)
        g.adj[int(g.edges[ei, 1])].append(ei)
    return g


def components(g: RailGraph) -> np.ndarray:
    """Connected-component label per node, by union-find over the edge list."""
    parent = np.arange(g.n_nodes)

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for u, v in g.edges:
        ru, rv = find(int(u)), find(int(v))
        if ru != rv:
            parent[ru] = rv
    return np.array([find(i) for i in range(g.n_nodes)])


# --- Heights --------------------------------------------------------------------


def raw_heights(g: RailGraph, terrain) -> np.ndarray:
    """Terrain, offset per structure class. The input to the grade projection."""
    ground = np.zeros(g.n_nodes)
    if terrain is not None:
        ground = np.asarray(
            terrain.sample(g.xy[:, 0], g.xy[:, 1]), dtype=np.float64
        ).reshape(-1)

    # A node inherits the most emphatic class of the edges that touch it: a
    # portal node touches one tunnel edge and one surface edge and belongs to
    # neither, so it takes the mean of the two offsets and the projection
    # smooths the rest.
    off_sum = np.zeros(g.n_nodes)
    off_n = np.zeros(g.n_nodes)
    for ei in range(g.n_edges):
        w = g.ways[int(g.way_of[ei])]
        if w.tunnel:
            o = -TUNNEL_DEPTH
        elif w.bridge:
            o = BRIDGE_RISE
        elif w.cutting:
            o = -CUTTING_DROP
        elif w.embankment:
            o = EMBANKMENT_RISE
        elif w.layer < 0:
            # Under something, but not tunnelled: a cutting beneath a road
            # bridge. Sixteen metres down would be a tunnel; four is a cutting.
            o = -CUTTING_DROP
        elif w.layer > 0:
            o = EMBANKMENT_RISE
        else:
            o = 0.0
        u, v = int(g.edges[ei, 0]), int(g.edges[ei, 1])
        off_sum[u] += o
        off_n[u] += 1
        off_sum[v] += o
        off_n[v] += 1
    off = np.where(off_n > 0, off_sum / np.maximum(off_n, 1), 0.0)
    return ground + off, ground


def _cone(g: RailGraph, y0: np.ndarray, sign: float) -> np.ndarray:
    """The grade-feasible envelope of `y0`: min over m of (y0[m] + c * dist(m, n)).

    A multi-source Dijkstra where every node starts at its own raw height and
    edges cost `MAX_GRADIENT * length`. The result satisfies the gradient limit
    everywhere by the triangle inequality, in one pass, exactly -- which is the
    reason it replaced a Gauss-Seidel relaxation that was still 39% steep after
    six hundred sweeps. Diffusion is the wrong tool for a constraint whose
    reach is a kilometre.

    `sign` flips it into the upper envelope, which only fills; the caller
    averages the two.
    """
    import heapq

    y = (sign * y0).astype(np.float64).copy()
    heap = [(float(y[i]), int(i)) for i in range(g.n_nodes)]
    heapq.heapify(heap)
    done = np.zeros(g.n_nodes, dtype=bool)
    cost = g.length * MAX_GRADIENT
    while heap:
        val, n = heapq.heappop(heap)
        if done[n] or val > y[n] + 1e-12:
            continue
        done[n] = True
        for ei in g.adj[n]:
            u, v = int(g.edges[ei, 0]), int(g.edges[ei, 1])
            m = v if u == n else u
            cand = val + float(cost[ei])
            if cand < y[m] - 1e-12:
                y[m] = cand
                heapq.heappush(heap, (cand, m))
    return sign * y


def solve_heights(g: RailGraph, y_raw: np.ndarray) -> tuple[np.ndarray, dict]:
    """Project the raw profile onto the ruling gradient, symmetrically.

    The lower envelope only cuts, and an envelope that only cuts drags a
    viaduct's approaches down into the river it crosses. The upper envelope only
    fills, and buries the cutting. The **average of the two** is what ships, and
    it is feasible for a reason worth stating: the set of grade-legal profiles
    is convex -- it is an intersection of half-spaces, one pair per edge -- so
    the midpoint of two members is a member.
    """
    lo = _cone(g, y_raw, 1.0)
    hi = _cone(g, y_raw, -1.0)
    y = 0.5 * (lo + hi)
    u, v = g.edges[:, 0], g.edges[:, 1]
    raw_grade = np.abs(y_raw[u] - y_raw[v]) / np.maximum(g.length, 1e-6)
    grade = np.abs(y[u] - y[v]) / np.maximum(g.length, 1e-6)
    return y, {
        "worst_grade_before": float(raw_grade.max()) if g.n_edges else 0.0,
        "worst_grade_after": float(grade.max()) if g.n_edges else 0.0,
        "moved_p95_m": float(np.percentile(np.abs(y - y_raw), 95)) if g.n_nodes else 0.0,
        "moved_max_m": float(np.max(np.abs(y - y_raw))) if g.n_nodes else 0.0,
        "iterations": 2,
    }


# Bit flags in `Direction.flags`, mirrored in `client/src/game/rail.ts`.
SPAN_TUNNEL = 1
SPAN_BRIDGE = 2
SPAN_CUTTING = 4
SPAN_EMBANKMENT = 8
SPAN_ELECTRIFIED = 16
SPAN_SUBWAY = 32


def span_flags(g: RailGraph, edge_seq: Sequence[int]) -> np.ndarray:
    """One byte per polyline vertex: what the track it arrives on is built as."""
    out = np.zeros(len(edge_seq) + 1, dtype=np.uint8)
    for i, ei in enumerate(edge_seq):
        if ei < 0:
            continue
        w = g.ways[int(g.way_of[ei])]
        f = 0
        if w.tunnel:
            f |= SPAN_TUNNEL
        if w.bridge:
            f |= SPAN_BRIDGE
        if w.cutting:
            f |= SPAN_CUTTING
        if w.embankment:
            f |= SPAN_EMBANKMENT
        if w.electrified not in (None, "no"):
            f |= SPAN_ELECTRIFIED
        if w.kind == "subway":
            f |= SPAN_SUBWAY
        out[i + 1] = f
    if len(out) > 1:
        out[0] = out[1]
    return out


# --- The ten lines --------------------------------------------------------------
#
# Hand-curated, because the relations do not carry an ordered stop list through
# GDAL (see the module header). `*` on a name means the line runs *through* the
# station without stopping -- it is still a waypoint, because a waypoint is what
# keeps the shortest path on the real corridor rather than through a freight
# yard, and it is still a station in the vertical-profile table.
#
# Deviations from TRAINS.md's table, both deliberate and both reported by
# `rail-audit`:
#   * T9 is modelled via Strathfield/Eastwood, which is the real Northern Line.
#     TRAINS.md says "via Gordon", which is T1's route; taking it literally would
#     leave Meadowbank -- one of the audit's own hand-asserted stations -- with
#     no service at all.
#   * T2/T3/T8/T9 terminate by running the City Circle and back to Central, so
#     "City Circle" is a real loop in the path rather than a stub.

LINE_SPECS: list[dict[str, Any]] = [
    {
        "id": "T1",
        "name": "North Shore & Western",
        "relation_ref": "T1",
        "colour": 0xF99D1C,
        "stations": [
            "Emu Plains", "Penrith", "Kingswood*", "Werrington*", "St Marys",
            "Mount Druitt*", "Rooty Hill*", "Doonside*", "Blacktown", "Seven Hills",
            "Toongabbie*", "Pendle Hill*", "Wentworthville*", "Westmead", "Parramatta",
            "Harris Park*", "Granville", "Clyde*", "Auburn*", "Lidcombe", "Strathfield",
            "Burwood*", "Redfern", "Central", "Town Hall", "Wynyard", "Milsons Point",
            "North Sydney", "Waverton", "Wollstonecraft", "St Leonards", "Artarmon",
            "Chatswood", "Roseville*", "Lindfield*", "Killara*", "Gordon", "Pymble*",
            "Turramurra", "Warrawee*", "Wahroonga*", "Waitara*", "Hornsby",
            "Asquith*", "Mount Colah*", "Mount Kuring-gai*", "Berowra",
        ],
    },
    {
        "id": "T2",
        "name": "Inner West & Leppington",
        "relation_ref": "T2",
        "colour": 0x0098CD,
        "stations": [
            "Leppington", "Edmondson Park", "Glenfield", "Casula", "Liverpool",
            "Warwick Farm", "Cabramatta", "Canley Vale", "Fairfield", "Yennora",
            "Guildford", "Merrylands", "Granville", "Clyde", "Auburn", "Lidcombe",
            "Flemington", "Homebush", "Strathfield", "Burwood", "Croydon", "Ashfield",
            "Summer Hill", "Lewisham", "Petersham", "Stanmore", "Newtown",
            "Macdonaldtown", "Redfern", "Central", "Town Hall", "Wynyard",
            "Circular Quay", "St James", "Museum", "Central",
        ],
    },
    {
        # --- The one line the extract overruled -------------------------------
        #
        # TRAINS.md has T3 as "Liverpool <-> City Circle **via Bankstown**",
        # which is the pre-conversion network. In this extract the whole of
        # Sydenham -- Marrickville -- Dulwich Hill -- Hurlstone Park -- Canterbury
        # -- Campsie -- Belmore -- Lakemba -- Wiley Park -- Punchbowl -- Bankstown
        # is tagged `railway=subway` and sits in a **different connected
        # component** from the heavy-rail network: OSM has already recorded the
        # Metro Southwest conversion. Routing T3 over it produced six "no path"
        # legs, which is the data telling the truth.
        #
        # So T3 runs its real current route -- Liverpool to the City Circle via
        # Regents Park -- and the Bankstown stations move to M1, where the rails
        # now are. Reported by `rail-audit`; see `LINE_NOTES`.
        "id": "T3",
        "name": "Liverpool & Inner West",
        "relation_ref": "T3",
        "colour": 0xF37021,
        "stations": [
            "Liverpool", "Warwick Farm", "Cabramatta", "Carramar", "Villawood",
            "Leightonfield", "Chester Hill", "Sefton", "Birrong", "Regents Park",
            "Berala", "Lidcombe", "Flemington*", "Homebush*", "Strathfield",
            "Burwood", "Croydon", "Ashfield", "Summer Hill", "Lewisham",
            "Petersham", "Stanmore", "Newtown", "Macdonaldtown", "Redfern",
            "Central",
        ],
    },
    {
        "id": "T4",
        "name": "Eastern Suburbs & Illawarra",
        "relation_ref": "T4",
        "colour": 0x005AA3,
        "stations": [
            "Waterfall", "Heathcote", "Engadine", "Loftus", "Sutherland", "Jannali",
            "Como", "Oatley", "Mortdale", "Penshurst", "Hurstville",
            "Allawah*", "Carlton*", "Kogarah*", "Rockdale*", "Banksia*", "Arncliffe*",
            "Wolli Creek*", "Tempe*", "Sydenham", "St Peters", "Erskineville",
            # **Not** via Town Hall. The Eastern Suburbs Railway leaves from
            # Central's platforms 24/25 and runs straight to Martin Place; Town
            # Hall is on the City Circle, a different pair of tracks. Putting it
            # in the sequence sent the router out to Town Hall and back, which
            # made T4 revisit twenty blocks near Redfern -- and a service that
            # passes the same rail twice conflicts with its own next departure.
            # `rail-audit`'s separation sweep is what found it.
            "Redfern", "Central", "Martin Place", "Kings Cross",
            "Edgecliff", "Bondi Junction",
        ],
    },
    {
        "id": "T5",
        "name": "Cumberland",
        "relation_ref": "T5",
        "colour": 0xC4258F,
        "stations": [
            "Richmond", "East Richmond", "Clarendon", "Windsor", "Mulgrave",
            "Vineyard", "Riverstone", "Schofields", "Quakers Hill", "Marayong",
            "Blacktown", "Seven Hills", "Toongabbie", "Pendle Hill", "Wentworthville",
            "Westmead", "Parramatta", "Harris Park", "Merrylands", "Guildford",
            "Yennora", "Fairfield", "Canley Vale", "Cabramatta", "Warwick Farm",
            "Liverpool", "Casula", "Glenfield", "Edmondson Park", "Leppington",
        ],
    },
    {
        "id": "T6",
        "name": "Lidcombe & Bankstown",
        "relation_ref": "T6",
        "colour": 0x7D3F98,
        "stations": [
            "Lidcombe", "Berala", "Regents Park", "Birrong", "Yagoona", "Bankstown",
        ],
    },
    {
        "id": "T7",
        "name": "Olympic Park",
        "relation_ref": "T7",
        "colour": 0x6F818E,
        "stations": ["Lidcombe", "Olympic Park"],
    },
    {
        "id": "T8",
        "name": "Airport & South",
        "relation_ref": "T8",
        "colour": 0x00954C,
        "stations": [
            "Macarthur", "Campbelltown", "Leumeah", "Minto", "Ingleburn",
            "Macquarie Fields", "Glenfield", "Holsworthy", "East Hills", "Panania",
            "Revesby", "Padstow*", "Riverwood*", "Narwee*", "Beverly Hills*",
            "Kingsgrove*", "Bexley North*", "Bardwell Park*", "Turrella*",
            "Wolli Creek", "International Airport", "Domestic Airport", "Mascot",
            "Green Square", "Central", "Town Hall", "Wynyard", "Circular Quay",
            "St James", "Museum", "Central",
        ],
    },
    {
        "id": "T9",
        "name": "Northern",
        "relation_ref": "T9",
        "colour": 0xD11F2F,
        "stations": [
            "Hornsby", "Normanhurst", "Thornleigh", "Pennant Hills", "Beecroft",
            "Cheltenham", "Epping", "Eastwood", "Denistone", "West Ryde",
            "Meadowbank", "Rhodes", "Concord West", "North Strathfield",
            "Strathfield", "Burwood*", "Redfern", "Central",
        ],
    },
    {
        "id": "M1",
        "name": "Metro North West & Bankstown",
        "relation_ref": "M1",
        "relation_names": ("Sydney Metro City & Southwest", "Sydney Metro Northwest"),
        "colour": 0x168388,
        "metro": True,
        "stations": [
            "Tallawong", "Rouse Hill", "Kellyville", "Bella Vista", "Norwest",
            "Hills Showground", "Castle Hill", "Cherrybrook", "Epping",
            "Macquarie University", "Macquarie Park", "North Ryde", "Chatswood",
            "Crows Nest", "Victoria Cross", "Barangaroo", "Martin Place", "Gadigal",
            "Central", "Waterloo", "Sydenham",
            # The Southwest, which is where the old T3 Bankstown line went. See
            # the note on T3: in this extract these are `railway=subway` and are
            # wired to the Metro, not to the heavy-rail network.
            "Marrickville", "Dulwich Hill", "Hurlstone Park", "Canterbury",
            "Campsie", "Belmore", "Lakemba", "Wiley Park", "Punchbowl",
            "Bankstown",
        ],
    },
]

# Where the model and TRAINS.md's table differ, and why. Printed verbatim by
# `rail-audit` so a deviation can never become folklore.
LINE_NOTES: list[str] = [
    (
        "T3 runs Liverpool -> City via Regents Park, not via Bankstown: the whole "
        "Sydenham--Bankstown corridor is tagged railway=subway in this extract and "
        "is a separate connected component. The Metro conversion is already in OSM."
    ),
    (
        "M1 therefore carries the ten Bankstown-line stations, which is where the "
        "rails actually are, and runs Tallawong -> Bankstown rather than stopping "
        "at Sydenham."
    ),
    (
        "T9 is modelled via Strathfield/Eastwood -- the real Northern Line -- rather "
        "than TRAINS.md's 'via Gordon', which is T1's route and would leave "
        "Meadowbank (one of the audit's own hand-asserted stations) with no service."
    ),
    (
        "T3 and T9 terminate at Central rather than looping the City Circle. Two "
        "tracks cannot carry four lines: a station block is held for ~50 s and needs "
        "20 s of clearance either side, so one track tops out near one train per "
        "75 s. T2 and T8 loop it; the solver's period ladder does the rest."
    ),
]


@dataclass
class Stop:
    name: str
    stops: bool
    station: RailStation | None = None
    node: int = -1
    s: float = 0.0  # arc-length along the routed path
    cands: list[int] = field(default_factory=list)  # every platform track it could use


@dataclass
class Direction:
    index: int  # 0 = as listed, 1 = reversed
    label: str
    nodes: list[int]
    xyz: np.ndarray  # (N, 3) world x, y, z
    cum: np.ndarray  # (N,) arc-length metres
    edge_seq: list[int]  # edge index per polyline span, -1 for a station weld
    stops: list[Stop]
    # Per vertex, the structure of the span that arrives at it. The geometry
    # round needs to know where to put a tunnel tube and where to put a viaduct
    # deck, and it must not have to re-derive that from the extract: it would be
    # re-deriving it against a graph it does not have, and any disagreement puts
    # a portal somewhere the train does not pass through one.
    flags: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.uint8))
    phases: list[tuple[float, float, float, float]] = field(default_factory=list)
    duration: float = 0.0
    period: int = BASE_PERIOD_S
    offset: int = 0
    blocks: list[tuple[int, float, float]] = field(default_factory=list)
    arrivals: list[float] = field(default_factory=list)  # t at each stopping station


@dataclass
class Line:
    id: str
    name: str
    colour: int
    metro: bool
    dirs: list[Direction]
    missing: list[str] = field(default_factory=list)


# --- Corridors from the relations -----------------------------------------------


def read_corridors(radius_m: float, path: Path = PBF_PATH) -> dict[str, np.ndarray]:
    """Sampled points along each `route=train` relation's linework, by ref.

    All GDAL gives is merged linework with the member roles gone, so this is not
    a stopping pattern and is not used as one. It is a *corridor*: a cheap
    nearest-point test that tells the router which of six parallel tracks
    through Strathfield belongs to the line it is routing.
    """
    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = _read_layer(path, "multilinestrings", bbox)
    by_key: dict[str, list[np.ndarray]] = defaultdict(list)
    for geom, a in zip(geoms, attrs):
        if a.get("route") not in ("train", "railway"):
            continue
        ref = (a.get("ref") or "").strip()
        name = (a.get("name") or "").strip()
        keys = [k for k in (ref, name) if k]
        if not keys:
            continue
        proj = _project(geom)
        parts = list(proj.geoms) if proj.geom_type == "MultiLineString" else [proj]
        pts = []
        for ln in parts:
            if ln.is_empty or ln.length < 1.0:
                continue
            n = max(2, int(ln.length / 20.0) + 1)
            d = np.linspace(0.0, ln.length, n)
            pts.append(np.array([[p.x, p.y] for p in (ln.interpolate(x) for x in d)]))
        if not pts:
            continue
        arr = np.vstack(pts)
        for k in keys:
            by_key[k].append(arr)
    return {k: np.vstack(v) for k, v in by_key.items()}


def corridor_for(spec: dict, corridors: dict[str, np.ndarray]) -> np.ndarray | None:
    keys: list[str] = []
    if spec.get("relation_names"):
        keys.extend(spec["relation_names"])
    else:
        keys.append(spec["relation_ref"])
    got = [corridors[k] for k in keys if k in corridors]
    return np.vstack(got) if got else None


# --- Routing ---------------------------------------------------------------------

CORRIDOR_M = 40.0  # how near the relation's linework counts as "on the line"

# --- Why every one of these penalties is small ------------------------------------
#
# They are *preferences between parallel rails*, not detour budgets, and the
# first draft got that wrong in a way worth recording: at a x6 corridor penalty
# and a x9 opposite-direction penalty the router happily took a nine-kilometre
# excursion through a freight yard to avoid a hundred metres of the other
# direction's track, and T1 came out at 218 km against a real 95. Two parallel
# tracks are within a metre of the same length, so a 1.5x preference picks the
# right one every time, and no preference here is ever worth a real detour.
CORRIDOR_PENALTY = 1.8  # cost multiplier for leaving the line's own relation
SERVICE_PENALTY = 2.2  # yards, sidings, spurs and crossovers
OPPOSITE_PENALTY = 2.2  # an edge the other direction already took
# ...and a mild aversion to rails somebody else is already on. Central has six
# through tracks and the Harbour Bridge four; a router with no opinion puts every
# line on the same pair, and then the block solver is asked to fit five services
# through one 400 m section on a 120 s cycle, which is not a scheduling problem
# but an arithmetic impossibility. Small on purpose -- a parallel track is the
# same length, so 0.4 per existing user is plenty to prefer an empty one and
# never enough to buy a detour.
SPREAD_PENALTY = 1.0
SPREAD_CAP = 2.6  # ...but never enough to buy a detour
# A suburban set does not run down a Metro tunnel and a Metro set does not run
# to Penrith. `railway=subway` separates the two networks perfectly in this
# extract -- 4,554 subway edges, every one of them in the Metro's own connected
# component, and 37,566 rail edges, every one of them not -- so the rule is a
# tag test rather than a component test and stays correct if the two ever touch.
# It cost a real bug to find: T2's Central and Museum both have Metro tunnel
# nodes within 400 m, the router started on the Metro because that hop was
# cheaper, and then found no St James on it.
WRONG_NETWORK_PENALTY = 50.0
ANCHOR_RADIUS_M = 400.0  # how far from a station centre to look for its track
ANCHOR_CANDIDATES = 24  # how many of them to keep as alternatives


def _edge_costs(
    g: RailGraph,
    corridor: np.ndarray | None,
    avoid: np.ndarray | None,
    uses: np.ndarray | None = None,
    metro: bool = False,
) -> np.ndarray:
    mid = 0.5 * (g.xy[g.edges[:, 0]] + g.xy[g.edges[:, 1]])
    cost = g.length.astype(np.float64).copy()
    cost = np.maximum(cost, 0.05)

    svc = np.array(
        [1.0 if g.ways[int(w)].service is None else SERVICE_PENALTY for w in g.way_of]
    )
    cost = cost * svc

    want = "subway" if metro else "rail"
    net = np.array(
        [1.0 if g.ways[int(w)].kind == want else WRONG_NETWORK_PENALTY for w in g.way_of]
    )
    cost = cost * net

    if corridor is not None and len(corridor):
        from scipy.spatial import cKDTree

        d, _ = cKDTree(corridor).query(mid, distance_upper_bound=CORRIDOR_M)
        cost = cost * np.where(np.isfinite(d), 1.0, CORRIDOR_PENALTY)
    if avoid is not None:
        cost = cost * np.where(avoid, OPPOSITE_PENALTY, 1.0)
    if uses is not None:
        cost = cost * np.minimum(1.0 + SPREAD_PENALTY * uses, SPREAD_CAP)
    return cost


def _csr(g: RailGraph, cost: np.ndarray):
    from scipy.sparse import csr_matrix

    n = g.n_nodes
    u = np.concatenate([g.edges[:, 0], g.edges[:, 1]])
    v = np.concatenate([g.edges[:, 1], g.edges[:, 0]])
    w = np.concatenate([cost, cost])
    return csr_matrix((w, (u, v)), shape=(n, n))


def _candidates(
    g: RailGraph,
    station: RailStation,
    corridor: np.ndarray | None,
    node_tree,
) -> list[int]:
    """Every graph node this line could plausibly call at, nearest first.

    A *list* rather than a single anchor, and that is not a refinement -- it is
    what makes the router work at all. A station is many parallel tracks and the
    network is 199 connected components (the Metro alone is three of them), so
    picking one node up front and hoping means picking, at Chatswood, the Metro
    platform for a T1 service and then discovering there is no path from it to
    Roseville. The first draft did exactly that and lost Central->Town Hall.

    The relation corridor still gets first refusal, because it is the one thing
    that knows *which* of six tracks through Strathfield the line uses; it just
    no longer gets the last word.
    """
    idx = node_tree.query_ball_point([station.east, station.north], ANCHOR_RADIUS_M)
    if not idx:
        _, i = node_tree.query([station.east, station.north])
        return [int(i)]
    cand = np.asarray(sorted(idx), dtype=np.int64)
    pts = g.xy[cand]
    d = np.hypot(pts[:, 0] - station.east, pts[:, 1] - station.north)
    on = np.zeros(len(cand), dtype=bool)
    if corridor is not None and len(corridor):
        from scipy.spatial import cKDTree

        dc, _ = cKDTree(corridor).query(pts, distance_upper_bound=CORRIDOR_M)
        on = np.isfinite(dc)
    # Corridor members first, then everything else, each by distance. Ties broken
    # on the node index so the order is a function of the data and not of a sort
    # that happened to be unstable.
    order = sorted(range(len(cand)), key=lambda i: (0 if on[i] else 1, d[i], int(cand[i])))
    return [int(cand[i]) for i in order[:ANCHOR_CANDIDATES]]


def route_direction(
    g: RailGraph,
    stops: list[Stop],
    cost: np.ndarray,
    csr,
) -> tuple[list[int], list[int], list[str]]:
    """Path the line stop by stop, choosing each station's platform as it goes.

    One Dijkstra per leg from wherever the previous leg ended, then the cheapest
    *reachable* candidate at the next station wins. Choosing the platform during
    the walk rather than before it is what keeps the route inside one connected
    component without ever having to reason about components.
    """
    from scipy.sparse.csgraph import dijkstra

    edge_by_pair: dict[tuple[int, int], int] = {}
    for ei in range(g.n_edges):
        a, b = int(g.edges[ei, 0]), int(g.edges[ei, 1])
        key = (a, b) if a < b else (b, a)
        prev = edge_by_pair.get(key)
        if prev is None or cost[ei] < cost[prev]:
            edge_by_pair[key] = ei

    # The first station's platform is chosen by looking one leg ahead, so a
    # terminus does not commit the whole line to a siding.
    start = stops[0].cands[0]
    if len(stops) > 1:
        best = None
        for c in stops[0].cands:
            dist = dijkstra(csr, indices=c)
            reach = [(dist[t], t) for t in stops[1].cands if np.isfinite(dist[t])]
            if not reach:
                continue
            cheap = min(reach)[0]
            if best is None or cheap < best[0]:
                best = (cheap, c)
        if best is not None:
            start = best[1]
    stops[0].node = start

    nodes: list[int] = [start]
    edge_seq: list[int] = []
    gaps: list[str] = []
    cur = start

    for k in range(1, len(stops)):
        dist, pred = dijkstra(csr, indices=cur, return_predecessors=True)
        reach = [(float(dist[t]), int(t)) for t in stops[k].cands if np.isfinite(dist[t])]
        if not reach:
            gaps.append(f"{stops[k-1].name}->{stops[k].name}: no path from any platform")
            target = stops[k].cands[0]
            stops[k].node = target
            nodes.append(target)
            edge_seq.append(-1)
            cur = target
            continue
        target = min(reach)[1]
        stops[k].node = target
        chain = [target]
        walk = target
        while walk != cur:
            walk = int(pred[walk])
            if walk < 0:
                break
            chain.append(walk)
        chain.reverse()
        for j in range(1, len(chain)):
            p, q = chain[j - 1], chain[j]
            key = (p, q) if p < q else (q, p)
            edge_seq.append(edge_by_pair.get(key, -1))
            nodes.append(q)
        cur = target
    return nodes, edge_seq, gaps


def _polyline(g: RailGraph, nodes: Sequence[int]) -> tuple[np.ndarray, np.ndarray]:
    """World-frame (x, y, z) per node and cumulative arc-length.

    `geo.enu_to_world` is the one place the north/-Z flip happens; going through
    it rather than writing `-north` here is what keeps the sign checkable in one
    place. `rail-audit` asserts it against Circular Quay, which is north of the
    origin and must therefore land at negative z.
    """
    idx = np.asarray(nodes, dtype=np.int64)
    e = g.xy[idx, 0]
    n = g.xy[idx, 1]
    x, z = geo.enu_to_world(e, n)
    y = g.y[idx]
    xyz = np.column_stack([np.asarray(x), y, np.asarray(z)])
    d = np.hypot(np.diff(xyz[:, 0]), np.diff(xyz[:, 2]))
    cum = np.concatenate([[0.0], np.cumsum(d)])
    return xyz, cum


def build_lines(
    g: RailGraph,
    stations: Sequence[RailStation],
    corridors: dict[str, np.ndarray],
    specs: Sequence[dict] = LINE_SPECS,
    log=print,
) -> list[Line]:
    """Path all ten lines, both directions, through the graph.

    Direction 1 is routed *after* every direction 0 and with a heavy penalty on
    every edge direction 0 used. That single ordering is what makes the two
    directions take the up and the down road of a double-track railway rather
    than both taking the same rails and meeting head-on -- and it is global
    rather than per line, so two lines sharing a trunk agree about which pair is
    which. Where the railway really is single track the penalty simply loses,
    the two directions share, and the block solver has to earn its keep.
    """
    from scipy.spatial import cKDTree

    by_name = {s.name: s for s in stations}
    node_tree = cKDTree(g.xy)

    prepared: list[tuple[dict, np.ndarray | None, list[Stop]]] = []
    for spec in specs:
        corridor = corridor_for(spec, corridors)
        stops: list[Stop] = []
        missing: list[str] = []
        for raw in spec["stations"]:
            calls = not raw.endswith("*")
            name = raw.rstrip("*")
            st = by_name.get(name)
            if st is None:
                missing.append(name)
                continue
            stops.append(Stop(name=name, stops=calls, station=st,
                              cands=_candidates(g, st, corridor, node_tree)))
        if missing:
            log(f"  {spec['id']}: {len(missing)} station(s) not in the extract: {', '.join(missing)}")
        prepared.append((spec, corridor, stops))
        spec["_missing"] = missing

    used0 = np.zeros(g.n_edges, dtype=bool)
    # Spread pressure is counted **per direction**. A down train has no reason
    # to avoid the rails the up trains are on -- it is already avoiding them,
    # for a different reason and with a different penalty -- and folding the two
    # counts together made the second direction of every line look twice as
    # crowded as it was.
    uses = [np.zeros(g.n_edges, dtype=np.float64), np.zeros(g.n_edges, dtype=np.float64)]
    lines: list[Line] = []

    for direction in (0, 1):
        for li, (spec, corridor, stops) in enumerate(prepared):
            src = stops if direction == 0 else list(reversed(stops))
            # Fresh Stop records per direction: the router chooses the platform
            # as it walks and writes it back, and the two directions must not
            # share that choice -- the whole point is that they take different
            # rails.
            seq = [
                Stop(name=s.name, stops=s.stops, station=s.station, cands=list(s.cands))
                for s in src
            ]
            cost = _edge_costs(
                g, corridor, used0 if direction == 1 else None, uses[direction],
                metro=bool(spec.get("metro")),
            )
            csr = _csr(g, cost)
            nodes, edge_seq, gaps = route_direction(g, seq, cost, csr)
            for ei in edge_seq:
                if ei >= 0:
                    uses[direction][ei] += 1.0
                    if direction == 0:
                        used0[ei] = True
            xyz, cum = _polyline(g, nodes)
            # Where each stop lands along the path. The anchor node appears in
            # `nodes` at least once; the *last* occurrence for the leg that
            # arrives there is the right one on a route that loops (the City
            # Circle passes Central twice).
            stop_s: list[float] = []
            cursor = 0
            for st in seq:
                found = -1
                for j in range(cursor, len(nodes)):
                    if nodes[j] == st.node:
                        found = j
                        break
                if found < 0:
                    found = min(cursor, len(nodes) - 1)
                cursor = found
                stop_s.append(float(cum[found]))
            out_stops = [
                Stop(name=st.name, stops=st.stops, station=st.station, node=st.node, s=s)
                for st, s in zip(seq, stop_s)
            ]
            label = f"{seq[0].name} -> {seq[-1].name}" if seq else "?"
            d = Direction(index=direction, label=label, nodes=nodes, xyz=xyz, cum=cum,
                          edge_seq=edge_seq, stops=out_stops,
                          flags=span_flags(g, edge_seq))
            d.gaps = gaps  # type: ignore[attr-defined]
            if direction == 0:
                lines.append(
                    Line(id=spec["id"], name=spec["name"], colour=int(spec["colour"]),
                         metro=bool(spec.get("metro")), dirs=[d],
                         missing=list(spec.get("_missing") or []))
                )
            else:
                lines[li].dirs.append(d)
    return lines


# --- Distance-time curves --------------------------------------------------------
#
# A phase is `(t0, s0, v0, a)` and the whole evaluator is
#
#     dt = t - t0;  s = s0 + v0*dt + 0.5*a*dt*dt
#
# which is three multiplies and two adds of IEEE doubles and nothing else. No
# trig, no `Math.pow`, no `Math.hypot`; `Math.sqrt` appears once at runtime, to
# normalise a heading, exactly as `poseCar` does. That is the whole determinism
# argument and `checkRail` asserts it bit for bit across two module instances.


def leg_profile(length: float, v_max: float) -> list[tuple[float, float, float]]:
    """(duration, accel, v_entry) triples for one stop-to-stop leg.

    Accelerate at `ACCEL`, cruise, brake at `BRAKE`. If the leg is too short to
    reach `v_max` the profile is triangular and the peak is
    `sqrt(2*L*a*b/(a+b))`, which is the closed-form answer rather than a search.
    """
    if length <= 1e-6:
        return []
    d_acc = v_max * v_max / (2.0 * ACCEL)
    d_brk = v_max * v_max / (2.0 * BRAKE)
    if d_acc + d_brk <= length:
        cruise = length - d_acc - d_brk
        return [
            (v_max / ACCEL, ACCEL, 0.0),
            (cruise / v_max, 0.0, v_max),
            (v_max / BRAKE, -BRAKE, v_max),
        ]
    peak = math.sqrt(2.0 * length * ACCEL * BRAKE / (ACCEL + BRAKE))
    return [(peak / ACCEL, ACCEL, 0.0), (peak / BRAKE, -BRAKE, peak)]


def build_curve(d: Direction) -> None:
    """Fill `d.phases`, `d.duration` and `d.arrivals` from the stop list.

    Passed stations get no dwell and do not break the leg -- that is what makes
    an express segment express. The cruise speed for a leg is `V_EXPRESS` when
    the run between two *stopping* stations is at least `EXPRESS_MIN_M`, which
    is TRAINS.md's rule stated once.
    """
    calls = [s for s in d.stops if s.stops]
    if len(calls) < 2:
        calls = [d.stops[0], d.stops[-1]] if len(d.stops) >= 2 else []
    phases: list[tuple[float, float, float, float]] = []
    arrivals: list[float] = []
    t = 0.0
    s = calls[0].s if calls else 0.0
    total = float(d.cum[-1]) if len(d.cum) else 0.0

    # The path may start or end a little before/after the first/last call
    # (an anchor sits mid-platform). Absorb it into the first and last leg by
    # running the curve over the whole polyline.
    s = 0.0
    boundaries = [0.0] + [c.s for c in calls[1:-1]] + [total]
    arrivals.append(0.0)
    for k in range(1, len(boundaries)):
        leg = boundaries[k] - boundaries[k - 1]
        leg = max(leg, 0.0)
        v = V_EXPRESS if leg >= EXPRESS_MIN_M else V_LOCAL
        for dur, a, v0 in leg_profile(leg, v):
            phases.append((t, s, v0, a))
            s += v0 * dur + 0.5 * a * dur * dur
            t += dur
        # Snap out the accumulated floating error so the last phase ends exactly
        # on the boundary; a curve that overruns its polyline is a train past
        # the buffers.
        s = boundaries[k]
        arrivals.append(t)
        if k < len(boundaries) - 1:
            phases.append((t, s, 0.0, 0.0))
            t += DWELL_S
    phases.append((t, s, 0.0, 0.0))  # the terminating rest, so lookup never falls off
    d.phases = phases
    d.duration = t
    d.arrivals = arrivals


def eval_curve(phases: Sequence[tuple[float, float, float, float]], t: float) -> tuple[float, float]:
    """(s, v) at age `t`. The Python twin of the TypeScript evaluator."""
    if not phases:
        return 0.0, 0.0
    lo, hi = 0, len(phases) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if phases[mid][0] <= t:
            lo = mid
        else:
            hi = mid - 1
    t0, s0, v0, a = phases[lo]
    dt = t - t0
    dt = max(dt, 0.0)
    return s0 + v0 * dt + 0.5 * a * dt * dt, v0 + a * dt


def curve_time_at(phases: Sequence[tuple[float, float, float, float]], s_target: float) -> float:
    """The age at which the curve first reaches `s_target`. Inverse of `eval_curve`.

    Closed form per phase -- one quadratic root -- rather than a search, because
    the block solver asks for it a few hundred thousand times and because a
    search would put a tolerance in the middle of a safety invariant.
    """
    for i, (t0, s0, v0, a) in enumerate(phases):
        t1 = phases[i + 1][0] if i + 1 < len(phases) else float("inf")
        dur = t1 - t0
        s_end = s0 + v0 * dur + 0.5 * a * dur * dur if math.isfinite(dur) else float("inf")
        if s_target > s_end + 1e-9:
            continue
        if s_target <= s0:
            return t0
        if abs(a) < 1e-12:
            if v0 <= 1e-12:
                continue
            return t0 + (s_target - s0) / v0
        disc = v0 * v0 + 2.0 * a * (s_target - s0)
        if disc < 0.0:
            continue
        dt = (-v0 + math.sqrt(disc)) / a
        if dt < 0.0:
            dt = (-v0 - math.sqrt(disc)) / a
        if dt < -1e-9:
            continue
        return t0 + max(dt, 0.0)
    return phases[-1][0] if phases else 0.0


# --- Block sections ---------------------------------------------------------------


@dataclass
class BlockSet:
    of_edge: dict[int, int]  # graph edge index -> block id
    junction: list[bool]  # per block
    length: list[float]  # per block, metres
    count: int
    # How many rails the block's centreline stands for. See `_track_counts`:
    # this is the difference between "two trains on one rail" and "two trains
    # passing each other on a double-track railway", and OSM does not say it.
    tracks: list[int] = field(default_factory=list)
    dirvec: list[tuple[float, float]] = field(default_factory=list)

    def key(self, block: int, slot: int) -> int:
        """The thing a train actually occupies: a rail, not a corridor.

        `slot` is which way the service runs through the block, and it is part
        of the key **everywhere**, not only where `tracks` says two. That is a
        decision with a consequence, so state it plainly:

          * The claim this bake proves is "no two trains occupy the same *rail*
            within 20 s", not "the same corridor". Opposite directions passing
            at speed is what a double-track railway is for, and the geometry
            round draws both rails and offsets each direction onto its own.
          * Every passenger corridor inside the disc is double track in reality
            except the Richmond branch north of Riverstone. Modelling that one
            as double is a simplification, it is drawn as double either way, and
            `rail-audit` names the blocks where it applies.
          * Merging routes are *not* let off: two lines converging onto one rail
            run through the block in the same direction, get the same slot, and
            conflict exactly as they should.
        """
        return block * 2 + slot


def cut_blocks(g: RailGraph, lines: Sequence[Line], target_m: float = BLOCK_TARGET_M) -> BlockSet:
    """Cut every edge any line uses into ~400 m junction-aligned sections.

    The cut is over the *graph*, not over any one line's path, and that is the
    whole point: two lines on the same rails must land in the same block or the
    separation constraint has nothing to bind. Chains are walked between nodes
    whose degree in the used sub-graph is not two -- that is what "junction
    aligned" means -- and each chain is then divided into as near-equal pieces
    of at most `target_m` as it has room for.
    """
    used: set[int] = set()
    for ln in lines:
        for d in ln.dirs:
            for ei in d.edge_seq:
                if ei >= 0:
                    used.add(ei)

    deg: dict[int, int] = defaultdict(int)
    inc: dict[int, list[int]] = defaultdict(list)
    for ei in used:
        u, v = int(g.edges[ei, 0]), int(g.edges[ei, 1])
        deg[u] += 1
        deg[v] += 1
        inc[u].append(ei)
        inc[v].append(ei)

    of_edge: dict[int, int] = {}
    junction: list[bool] = []
    length: list[float] = []
    seen: set[int] = set()

    def other(ei: int, n: int) -> int:
        u, v = int(g.edges[ei, 0]), int(g.edges[ei, 1])
        return v if u == n else u

    # Walk every chain from a non-degree-2 node; anything left over is a closed
    # loop of degree-2 nodes and is walked from an arbitrary member afterwards.
    starts = [n for n, dg in deg.items() if dg != 2]
    chains: list[tuple[list[int], bool, bool]] = []
    for n0 in starts:
        for e0 in inc[n0]:
            if e0 in seen:
                continue
            chain = [e0]
            seen.add(e0)
            cur = other(e0, n0)
            while deg[cur] == 2:
                nxt = [e for e in inc[cur] if e not in seen]
                if not nxt:
                    break
                e = nxt[0]
                seen.add(e)
                chain.append(e)
                cur = other(e, cur)
            chains.append((chain, deg[n0] > 2, deg[cur] > 2))
    for ei in used:
        if ei in seen:
            continue
        chain = [ei]
        seen.add(ei)
        cur = other(ei, int(g.edges[ei, 0]))
        while deg[cur] == 2:
            nxt = [e for e in inc[cur] if e not in seen]
            if not nxt:
                break
            e = nxt[0]
            seen.add(e)
            chain.append(e)
            cur = other(e, cur)
        chains.append((chain, False, False))

    for chain, j0, j1 in chains:
        total = float(sum(g.length[e] for e in chain))
        pieces = max(1, math.ceil(total / target_m))
        step = total / pieces
        acc = 0.0
        bid = len(junction)
        junction.append(j0)
        length.append(0.0)
        for k, e in enumerate(chain):
            of_edge[e] = bid
            length[bid] += float(g.length[e])
            acc += float(g.length[e])
            if acc >= step - 1e-9 and k < len(chain) - 1:
                acc = 0.0
                bid = len(junction)
                junction.append(False)
                length.append(0.0)
        if j1:
            junction[bid] = True

    bs = BlockSet(of_edge=of_edge, junction=junction, length=length, count=len(junction))
    _track_counts(g, bs)
    return bs


# How near a companion rail has to be, and how nearly parallel, to count.
PARALLEL_FIND_M = 30.0  # wide enough to see across a six-track corridor
PARALLEL_MIN_M = 2.5   # closer than this across-track and it is the same rail
PARALLEL_ALONG_M = 10.0  # further than this along-track and it is the next block
PARALLEL_COS = 0.94  # within ~20 degrees


def _track_counts(g: RailGraph, bs: BlockSet) -> None:
    """How many rails each block's centreline represents.

    OSM's Sydney rail has **no `tracks=*` tag anywhere in this extract** -- all
    5,484 ways are untagged -- so the number has to be inferred, and getting it
    wrong is not cosmetic. The Lidcombe--Bankstown branch is drawn as a single
    way, so the router put both directions on it, so the block solver saw two
    trains meeting head-on in nine consecutive sections and correctly concluded
    that no timetable exists. The branch is double track. The way is a
    *centreline*, not a rail.

    The signal that distinguishes the two cases is whether the block has a
    companion running beside it: where OSM maps per track, every rail has a
    parallel neighbour ten metres away, and where it maps per corridor, it does
    not. So:

        a block with a parallel companion is one rail;
        a block without one stands for the whole double-track corridor.

    A single-track branch line is then modelled as double track, which is the
    error this makes. It is the safe direction -- it under-states conflict on
    lines that in this network are freight spurs nobody runs a service on -- and
    the count is baked, so the geometry round draws what the solver assumed.
    """
    from scipy.spatial import cKDTree

    edges_of: dict[int, list[int]] = defaultdict(list)
    for ei, b in bs.of_edge.items():
        edges_of[b].append(ei)

    used = sorted(bs.of_edge)
    if not used:
        bs.tracks = [1] * bs.count
        bs.dirvec = [(1.0, 0.0)] * bs.count
        return
    idx = np.asarray(used, dtype=np.int64)
    p0 = g.xy[g.edges[idx, 0]]
    p1 = g.xy[g.edges[idx, 1]]
    mid = 0.5 * (p0 + p1)
    vec = p1 - p0
    norm = np.maximum(np.hypot(vec[:, 0], vec[:, 1]), 1e-9)
    unit = vec / norm[:, None]
    blk = np.array([bs.of_edge[e] for e in used], dtype=np.int64)
    tree = cKDTree(mid)

    tracks = [2] * bs.count
    dirvec = [(1.0, 0.0)] * bs.count
    for b in range(bs.count):
        rows = np.flatnonzero(blk == b)
        if rows.size == 0:
            tracks[b] = 1
            continue
        dirvec[b] = (float(unit[rows[0], 0]), float(unit[rows[0], 1]))
        # Three samples along the block rather than one: a block that runs into
        # a station throat has a companion at one end and not at the other.
        picks = rows[:: max(1, rows.size // 3)][:3]
        best = 0
        for r in picks:
            seen_blocks: set[int] = set()
            for other in tree.query_ball_point(mid[r], PARALLEL_FIND_M):
                if blk[other] == b:
                    continue
                if abs(float(np.dot(unit[r], unit[other]))) < PARALLEL_COS:
                    continue
                # Beside, not ahead. The block in front is collinear and within
                # a few metres at every block boundary, so a bare radius test
                # calls every block in a chain its own companion and the whole
                # network comes out single track. Split the offset into its
                # along-track and across-track parts and demand the second.
                delta = mid[other] - mid[r]
                along = abs(float(delta[0] * unit[r, 0] + delta[1] * unit[r, 1]))
                perp = abs(float(delta[0] * unit[r, 1] - delta[1] * unit[r, 0]))
                if PARALLEL_MIN_M <= perp <= PARALLEL_FIND_M and along <= PARALLEL_ALONG_M:
                    seen_blocks.add(int(blk[other]))
            best = max(best, len(seen_blocks))
        # Per-track mapping: this rail plus everyone beside it. No neighbour at
        # all: the way is the corridor, and a Sydney passenger corridor is two.
        # The count is what decides a cantilever mast from a portal gantry, so
        # it is worth more than a boolean.
        tracks[b] = 1 + best if best else 2
    bs.tracks = tracks
    bs.dirvec = dirvec


def map_blocks(d: Direction, g: RailGraph, blocks: BlockSet) -> None:
    """The arc-length range over which this direction is inside each block, and on which rail.

    The rail -- `slot` -- is which way round the service traverses the block,
    measured against the block's own direction vector. On a corridor mapped as
    one centreline that is the difference between the up road and the down road,
    and it is the whole reason two trains passing at speed near Regents Park is
    not a collision.
    """
    runs: list[tuple[int, float, float, int]] = []
    cur = -1
    s0 = 0.0
    slot = 0
    for i, ei in enumerate(d.edge_seq):
        b = blocks.of_edge.get(ei, -1) if ei >= 0 else -1
        a = float(d.cum[i])
        z = float(d.cum[i + 1])
        if b != cur:
            if cur >= 0:
                runs.append((cur, s0, a, slot))
            cur = b
            s0 = a
            if b >= 0:
                dx = float(d.xyz[i + 1, 0] - d.xyz[i, 0])
                dz = float(d.xyz[i + 1, 2] - d.xyz[i, 2])
                # `dirvec` is in ENU (east, north) and the polyline is in world
                # (x, z = -north), so the north component is negated back here
                # rather than anywhere else.
                bx, bn = blocks.dirvec[b]
                slot = 0 if (dx * bx + (-dz) * bn) >= 0.0 else 1
        if i == len(d.edge_seq) - 1 and cur >= 0:
            runs.append((cur, s0, z, slot))
    d.blocks = runs


def occupancy(d: Direction, blocks: BlockSet) -> list[tuple[int, float, float]]:
    """(rail key, t_enter, t_exit) for this direction's single trip, from t=0.

    Keyed on the *rail*, via `BlockSet.key`, not on the block: a double-track
    corridor holds two trains at once and always has.
    """
    out: list[tuple[int, float, float]] = []
    for b, s0, s1, slot in d.blocks:
        t0 = curve_time_at(d.phases, s0)
        t1 = curve_time_at(d.phases, s1)
        if t1 < t0:
            t0, t1 = t1, t0
        out.append((blocks.key(b, slot), t0, t1))
    return out


# --- The phase solver ---------------------------------------------------------------
#
# THE CONSTRAINT IS A FUNCTION OF ONE NUMBER, WHICH IS WHY THIS IS FAST.
#
# Two services conflict in a block if some repeat of one's occupancy window lands
# within the separation margin of some repeat of the other's. Both repeat on
# their own period, so on the common cycle the *only* thing the answer depends on
# is `phase_i - phase_j`. So each pair of services gets one boolean array over
# the cycle -- the deltas that are forbidden -- built once, and the search after
# that is an array lookup rather than an interval sweep. The whole solve is
# milliseconds, which is what lets the period ladder retry as often as it needs.

# --- Why the ladder is harmonic ---------------------------------------------------
#
# Two services sharing a rail conflict unless `gcd(Pa, Pb)` exceeds the width of
# their combined occupancy -- about 150 s for a pair of station blocks. That is
# not a heuristic, it falls straight out of `_forbidden`: the reachable relative
# offsets are the multiples of the gcd, and if they are closer together than the
# forbidden window is wide, every one of them is inside it.
#
# So 240 s came out of the ladder. It looks like a helpful middle rung and it is
# a trap: gcd(180, 240) is 60 and gcd(240, 360) is 120, both under the window, so
# admitting one 240 s line made every line that shares a rail with it
# unschedulable and the solve collapsed to "no assignment" with 41,704
# violations. 120/180/360 has gcd 180 between its top two, which is the pair a
# busy trunk actually settles on.
PERIOD_LADDER = (120, 180, 360)

# The backtracker is complete but the space is 360^20, so a hopeless instance
# would run until the heat death rather than reporting. A budget turns "no
# solution" and "no solution I could find in a second" into the same, honest,
# reported outcome: the line that is jamming gets a longer period and the whole
# thing is tried again.
SEARCH_BUDGET = 400_000


def _lcm(a: int, b: int) -> int:
    return a * b // math.gcd(a, b)


def self_conflicts(
    occ: Sequence[tuple[int, float, float]], period: int, blocks: BlockSet
) -> tuple[int, str]:
    """Whether successive trips of one direction clear each other.

    TRAINS.md claims this is safe by construction -- uniform period, uniform
    curve, successive trips are time-translates that never converge -- and the
    claim is true of the *train* and false of the *rail*. Two ways it fails, and
    the second is the one that bit:

      1. A rail held for longer than `period - separation` is a rail the train
         behind wants while it is still there. A station block holds one for
         about fifty seconds.
      2. **A rail the service passes twice.** T2 and T8 run the City Circle, so
         they enter the same rail near Central at minute two and again at minute
         fifty-five -- and one trip's second visit can land on the next trip's
         first. No offset can fix that, because both trains belong to the same
         service and there is no offset between them. The pairwise solver never
         sees it: it only compares *different* services.
    """
    bad = 0
    example = ""
    worst = 0.0
    by_rail: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for k, t0, t1 in occ:
        by_rail[k].append((t0, t1))
    for k, runs in by_rail.items():
        sep = SEP_JUNCTION_S if blocks.junction[k // 2] else SEP_S
        for i, (a0, a1) in enumerate(runs):
            held = (a1 - a0) + sep
            if held >= period:
                bad += 1
                if held > worst:
                    worst = held
                    example = (f"block {k // 2} held {a1 - a0:.1f} s + {sep:.0f} s "
                               f"clearance against a {period} s period")
            for j, (b0, b1) in enumerate(runs):
                if j == i:
                    continue
                # Does some repeat of visit j land inside visit i's clearance?
                lo = b0 - a1 - sep
                hi = b1 - a0 + sep
                if hi - lo >= period:
                    bad += 1
                    example = example or (
                        f"block {k // 2} is visited twice and the two visits cover "
                        f"the whole {period} s period"
                    )
                    continue
                base = -period * math.floor(-lo / period)
                if lo < base < hi:
                    bad += 1
                    if not example:
                        example = (
                            f"block {k // 2} is visited twice, {b0 - a0:.0f} s apart, "
                            f"and the gap is a multiple of the {period} s period"
                        )
    return bad, example


def _forbidden(
    occ_a: Sequence[tuple[int, float, float]],
    occ_b: Sequence[tuple[int, float, float]],
    period_a: int,
    period_b: int,
    cycle: int,
    blocks: BlockSet,
) -> tuple[np.ndarray, dict[int, str]]:
    """Which values of `phase_a - phase_b` put the two services in one block.

    Derivation, once, because the modular arithmetic is the whole thing. Service
    A holds block `b` over `[a0, a1] + k*Pa` and B over `[b0, b1] + m*Pb`. Grow
    A's window by the separation margin at each end. They touch iff

        a0 + delta - sep  <  b1 + g   and   a1 + delta + sep  >  b0 + g

    for some `g` in `{m*Pb - k*Pa}`, which modulo the common cycle is exactly the
    multiples of `gcd(Pa, Pb)`. So the forbidden set is one open interval,
    stamped at every multiple of the gcd around the cycle.
    """
    forbid = np.zeros(cycle, dtype=bool)
    why: dict[int, str] = {}
    by_rail: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for k, t0, t1 in occ_b:
        by_rail[k].append((t0, t1))
    step = math.gcd(period_a, period_b)
    offsets = list(range(0, cycle, step))
    for k, a0, a1 in occ_a:
        rows = by_rail.get(k)
        if not rows:
            continue
        b = k // 2
        sep = SEP_JUNCTION_S if blocks.junction[b] else SEP_S
        for b0, b1 in rows:
            lo = b0 - a1 - sep
            hi = b1 - a0 + sep
            if hi - lo >= cycle:
                forbid[:] = True
                why.setdefault(0, f"block {b} is held right around the {cycle} s cycle")
                continue
            for g in offsets:
                s = lo + g
                e = hi + g
                i0 = math.floor(s) + 1
                i1 = math.ceil(e) - 1
                if i1 < i0:
                    continue
                for v in range(i0, i1 + 1):
                    d = v % cycle
                    if not forbid[d]:
                        forbid[d] = True
                        why.setdefault(
                            d,
                            f"block {b}{' (junction)' if blocks.junction[b] else ''}, "
                            f"{blocks.length[b]:.0f} m",
                        )
    return forbid, why


def _attempt(
    units: Sequence[tuple[int, Line, Direction]],
    occ: Sequence[Sequence[tuple[int, float, float]]],
    blocks: BlockSet,
    periods: dict[str, int],
) -> tuple[list[int] | None, int, dict]:
    """Try one set of periods. Returns (phases or None, cycle, why-it-failed).

    Three gates in increasing cost, and the order is the point: a capacity
    overflow and a pair with no clear offset are both *arithmetic*, and finding
    them by search would cost a thousand times as much and would name the wrong
    line when it did.
    """
    for _, ln, d in units:
        d.period = periods[ln.id]
    cycle = 1
    for p in periods.values():
        cycle = _lcm(cycle, p)

    # --- Gate zero: a service against its own next departure.
    #
    # This lives here, and not only in the ladder that sets the floor, because
    # the ladder now comes back *down* -- and a period that was rejected for
    # self-clearance on the way up must stay rejected on the way down. It did
    # not, and the cost was 94 separation violations in the audit's own sweep
    # against a solver that reported success: T4 revisits one rail 424 s into
    # its run, 180 s does not clear it, and the re-tighten pass handed 180 s
    # back after the floor had correctly rejected it.
    for i, (_, ln, d) in enumerate(units):
        bad, ex = self_conflicts(occ[i], periods[ln.id], blocks)
        if bad:
            return None, cycle, {"kind": "self", "line": ln.id, "where": ex}

    load, share = _pressure(occ, units, blocks)
    if load:
        worst = max(load, key=lambda k: load[k])
        if load[worst] > 1.0:
            return None, cycle, {
                "kind": "capacity",
                "rail": worst,
                "load": load[worst],
                "lines": share[worst],
            }

    forbid: dict[tuple[int, int], np.ndarray] = {}
    whys: dict[tuple[int, int], dict[int, str]] = {}
    for i in range(len(units)):
        for j in range(i + 1, len(units)):
            f, w = _forbidden(
                occ[i], occ[j], units[i][2].period, units[j][2].period, cycle, blocks
            )
            if f.any():
                forbid[(i, j)] = f
                whys[(i, j)] = w
            if f.all():
                return None, cycle, {
                    "kind": "no-offset",
                    "a": units[i][1].id,
                    "b": units[j][1].id,
                    "where": next(iter(w.values()), "a shared block"),
                }

    rev = (-np.arange(cycle)) % cycle
    pair: dict[tuple[int, int], np.ndarray] = {}
    for (i, j), f in forbid.items():
        pair[(i, j)] = f
        pair[(j, i)] = f[rev]
    neigh: dict[int, list[int]] = defaultdict(list)
    for i, j in pair:
        neigh[i].append(j)

    tight = [0] * len(units)
    for (i, j), f in forbid.items():
        n = int(f.sum())
        tight[i] += n
        tight[j] += n
    order = sorted(range(len(units)), key=lambda i: (-tight[i], i))

    assigned: dict[int, int] = {}
    budget = [SEARCH_BUDGET]

    def feasible(i: int, phase: int) -> bool:
        budget[0] -= 1
        for j, pj in assigned.items():
            f = pair.get((i, j))
            if f is not None and f[(phase - pj) % cycle]:
                return False
        return True

    def search(k: int) -> bool:
        if k == len(order) or budget[0] <= 0:
            return k == len(order)
        i = order[k]
        for phase in range(units[i][2].period):
            if budget[0] <= 0:
                return False
            if feasible(i, phase):
                assigned[i] = phase
                if search(k + 1):
                    return True
                del assigned[i]
        return False

    if search(0):
        return [assigned[i] for i in range(len(units))], cycle, {}

    # --- The repair search. Twenty variables and sixty constraints is a tiny
    #     CSP by size and a nasty one by shape: the forbidden sets are wide, so
    #     chronological backtracking spends its whole budget re-deriving that
    #     the *first* variable it fixed was the problem. Min-conflicts does not
    #     care which variable was fixed first. Deterministically seeded, because
    #     a bake that solves a different timetable each run is not a bake.
    repaired = _repair(units, pair, neigh, cycle, len(units))
    if repaired is not None:
        return repaired, cycle, {}

    ranked = sorted(load, key=lambda k: -load[k]) if load else []
    for k in ranked:
        if len(share[k]) > 1:
            return None, cycle, {"kind": "search", "rail": k, "lines": share[k]}
    return None, cycle, {"kind": "search", "rail": -1, "lines": {}}


def solve_phases(lines: Sequence[Line], blocks: BlockSet, log=print) -> dict:
    """An integer phase per line-direction, or a longer period for whoever needs one.

    Solved per *direction* rather than per line, which is strictly more freedom
    than TRAINS.md asked for and costs nothing: a line's two directions are on
    different rails wherever the railway is double track, so tying them to one
    offset would only invent constraints. The *period* stays per line, because a
    line whose two directions ran at different frequencies is not a timetable
    anybody could read.

    The ladder goes up until something fits and then **comes back down**: a
    greedy climb reaches a feasible timetable and has no idea how much of it was
    necessary, and the difference between "T1 every 3 minutes" and "T1 every 6"
    is the difference between the feature the user asked for and a curiosity.
    """
    units: list[tuple[int, Line, Direction]] = []
    for li, ln in enumerate(lines):
        for d in ln.dirs:
            units.append((li, ln, d))
    occ = [occupancy(d, blocks) for _, _, d in units]

    periods: dict[str, int] = {ln.id: BASE_PERIOD_S for ln in lines}
    degraded: dict[str, str] = {}
    attempts: list[str] = []

    def self_clean(lid: str, period: int) -> str | None:
        for i, (_, ln, _d) in enumerate(units):
            if ln.id != lid:
                continue
            bad, ex = self_conflicts(occ[i], period, blocks)
            if bad:
                return ex
        return None

    def next_period(lid: str, cur: int) -> int | None:
        """The next rung up that the line can actually run at.

        Rungs are *skipped*, not just climbed: a service that revisits a rail
        424 s into its run conflicts with itself at every period that divides
        424 -- 120 and 180 and 360 all do, and 240 does not -- so the ladder is
        not monotone in feasibility and walking it one step at a time gets
        stuck on a rung it has already been told is impossible.
        """
        for p in PERIOD_LADDER:
            if p > cur and self_clean(lid, p) is None:
                return p
        return None

    # --- 1. Self-clearance sets the floor. A line whose own trains cannot
    #        follow each other has no phase offset that will save it.
    for lid in list(periods):
        ex = self_clean(lid, periods[lid])
        if ex is None:
            continue
        nxt = next_period(lid, periods[lid])
        if nxt is None:
            log(f"  WARNING: {lid} cannot self-clear at any period on the ladder: {ex}")
            continue
        degraded[lid] = f"self-clearance: {ex}"
        attempts.append(f"{lid} {periods[lid]} s -> {nxt} s ({ex})")
        periods[lid] = nxt

    def blame(why: dict) -> str | None:
        """Which line to lengthen, given why the attempt failed."""
        if why.get("kind") == "self":
            names = [why["line"]]
        elif why.get("kind") == "no-offset":
            names = [why["a"], why["b"]]
        elif why.get("lines"):
            names = sorted(why["lines"], key=lambda k: -why["lines"][k])
        else:
            names = sorted(periods)
        for nm in names:
            if periods[nm] < PERIOD_LADDER[-1]:
                return nm
        return None

    phases: list[int] | None = None
    cycle = BASE_PERIOD_S
    for _ in range(8 * len(lines)):
        phases, cycle, why = _attempt(units, occ, blocks, periods)
        if phases is not None:
            break
        pick = blame(why)
        if pick is None:
            break
        nxt = next_period(pick, periods[pick])
        if nxt is None:
            break
        if why.get("kind") == "self":
            note = f"it cannot clear its own next departure -- {why['where']}"
        elif why.get("kind") == "capacity":
            note = (f"rail {why['rail']} on block {why['rail'] // 2} is "
                    f"{100 * why['load']:.0f}% subscribed by {'/'.join(sorted(why['lines']))}")
        elif why.get("kind") == "no-offset":
            note = f"no offset clears {why['a']} against {why['b']} -- {why['where']}"
        else:
            note = "no set of offsets fits; it is the heaviest user of the busiest shared rail"
        attempts.append(f"{pick} {periods[pick]} s -> {nxt} s ({note})")
        degraded[pick] = note
        periods[pick] = nxt

    # --- 2. Back down the ladder. Every line, cheapest first, gets one attempt
    #        at every shorter period that is still above its self-clearance
    #        floor. Cheap -- an attempt that cannot work fails on arithmetic
    #        before it ever searches -- and it is the difference between an
    #        honest answer and a pessimistic one.
    recovered: list[str] = []
    if phases is not None:
        improving = True
        while improving:
            improving = False
            for lid in sorted(periods, key=lambda k: -periods[k]):
                lower = [p for p in PERIOD_LADDER if p < periods[lid]]
                for p in sorted(lower, reverse=True):
                    if self_clean(lid, p) is not None:
                        continue
                    trial = dict(periods)
                    trial[lid] = p
                    got, cyc, _ = _attempt(units, occ, blocks, trial)
                    if got is not None:
                        recovered.append(f"{lid} {periods[lid]} s -> {p} s")
                        periods, phases, cycle = trial, got, cyc
                        if p == BASE_PERIOD_S:
                            degraded.pop(lid, None)
                        improving = True
                        break

    for _, ln, d in units:
        d.period = periods[ln.id]
    if phases is not None:
        for i, ph in enumerate(phases):
            units[i][2].offset = int(ph)

    return {
        "solved": phases is not None,
        "cycle_s": cycle,
        "periods": dict(periods),
        "degraded": degraded,
        "attempts": attempts,
        "recovered": recovered,
        **_shared_stats(occ),
    }


def _shared_stats(occ: Sequence[Sequence[tuple[int, float, float]]]) -> dict:
    seen: dict[int, int] = defaultdict(int)
    for o in occ:
        for k, _, _ in o:
            seen[k] += 1
    return {
        "rails_used": len(seen),
        "rails_shared": int(sum(1 for n in seen.values() if n > 1)),
        "busiest_rail_services": max(seen.values()) if seen else 0,
    }


def _pressure(
    occ: Sequence[Sequence[tuple[int, float, float]]],
    units: Sequence[tuple[int, Line, Direction]],
    blocks: BlockSet,
) -> tuple[dict[int, float], dict[int, dict[str, float]]]:
    """How much of the cycle each block is already spoken for, and by whom.

    The necessary condition, stated once: a block that is held for `h` seconds
    and needs `sep` seconds of clearance consumes `(h + sep) / period` of every
    cycle for each service that wants it. Sum over services; above 1.0 there is
    no assignment of offsets, and no amount of searching will find one.
    """
    load: dict[int, float] = defaultdict(float)
    share: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for i, o in enumerate(occ):
        lid = units[i][1].id
        period = float(units[i][2].period)
        for k, t0, t1 in o:
            sep = SEP_JUNCTION_S if blocks.junction[k // 2] else SEP_S
            f = (t1 - t0 + sep) / period
            load[k] += f
            share[k][lid] += f
    return dict(load), {b: dict(v) for b, v in share.items()}


REPAIR_ROUNDS = 30
REPAIR_STEPS = 2500
REPAIR_SEED = 0x5DA1


def _repair(
    units: Sequence[tuple[int, Line, Direction]],
    pair: dict[tuple[int, int], np.ndarray],
    neigh: dict[int, list[int]],
    cycle: int,
    n: int,
) -> list[int] | None:
    """Min-conflicts over the phase assignment. Returns a solution or None.

    The cost of a candidate phase for service `i` is read straight off the
    neighbours' arrays -- `np.roll(f_ij, phase_j)` is the conflict count as a
    function of `phase_i` -- so choosing the best phase for one service is a
    handful of numpy adds over a 360-element array rather than a loop over
    every rail it shares. Seeded from a constant: two runs of the bake must
    produce the same timetable or nothing downstream can be compared.
    """
    import random

    rng = random.Random(REPAIR_SEED)
    periods = [units[i][2].period for i in range(n)]

    def cost_curve(i: int, assign: Sequence[int]) -> np.ndarray:
        c = np.zeros(cycle, dtype=np.int32)
        for j in neigh[i]:
            c += np.roll(pair[(i, j)], assign[j]).astype(np.int32)
        return c

    def conflict(i: int, j: int, assign: Sequence[int]) -> int:
        return int(pair[(i, j)][(assign[i] - assign[j]) % cycle])

    for _ in range(REPAIR_ROUNDS):
        assign = [rng.randrange(periods[i]) for i in range(n)]
        # Kept incrementally. Recomputing every service's conflict count on
        # every step is what made the first draft of this take minutes: it is
        # 380 array reads per step to maintain and 7,600 to rebuild.
        cost = [sum(conflict(i, j, assign) for j in neigh[i]) for i in range(n)]
        for _ in range(REPAIR_STEPS):
            bad = [i for i in range(n) if cost[i] > 0]
            if not bad:
                return assign
            i = rng.choice(bad)
            c = cost_curve(i, assign)[: periods[i]]
            best = int(c.min())
            options = np.flatnonzero(c == best)
            assign[i] = int(options[rng.randrange(len(options))])
            cost[i] = sum(conflict(i, j, assign) for j in neigh[i])
            for j in neigh[i]:
                cost[j] = sum(conflict(j, k, assign) for k in neigh[j])
    return None


# --- Vertical profile per station -------------------------------------------------


# 180 m was the first guess and it made Kingsgrove underground: the East Hills
# line dives into the Kingsgrove tunnel a hundred metres past the platform, so a
# radius that generous reads the tunnel mouth as the station. A station's
# vertical class is a fact about its *platforms*, so the window is the length of
# a platform and a little more.
STATION_WAY_RADIUS_M = 85.0

# --- And the window that catches what the one above cannot -------------------------
#
# 85 m is a platform, and inside a station box that is exactly the problem: OSM
# maps the *running tunnels* either side of a Metro station with `tunnel=yes` and
# very often leaves the platform-level ways inside the box untagged, because the
# box is a building rather than a tunnel. So the tunnel share measured over a
# platform's length comes out near zero at a station that is twenty metres
# underground -- Cherrybrook reads 0.13 with every metre of track for a
# kilometre either side of it in tunnel.
#
# The approach window is the fix, and it is deliberately three things at once:
#   * **wide** (260 m), so it reaches past the box to the running tunnels;
#   * **level-banded**, so it counts only track at the station's own height --
#     without this Central Chalmers Street would still be measured against the
#     great train shed fifteen metres above it, and Wolli Creek against the
#     Airport Line tunnel that dives under its platforms;
#   * **promotion only**. It can make a station underground and can never make
#     one surface, so every verdict the 85 m rule got right is untouched.
STATION_APPROACH_RADIUS_M = 260.0
APPROACH_LEVEL_BAND_M = 6.0
# How far under the DEM a platform has to be before the approach window is even
# consulted. Kingsgrove -- the hand-asserted case that made the radius 85 m in
# the first place -- sits 4.3 m down in its cutting and stays comfortably below
# this, and so does every real cutting on the Bankstown line.
UNDERGROUND_MIN_DEPTH_M = 8.0
# How much track a side needs before its vote counts. A terminus and a station at
# the edge of the 60 km clip both have a side with nothing in it, and an empty
# side must not read as "open sky that way".
APPROACH_MIN_SIDE_M = 60.0


def classify_vertical(
    g: RailGraph, stations: Sequence[RailStation], terrain=None
) -> None:
    """surface / elevated / underground per station, read off the ways that reach it.

    TRAINS.md's requirement in one function: *"the under/over question is
    answered by the data, per way -- no hand-modelling of vertical profiles"*.
    So this counts the edges within `STATION_WAY_RADIUS_M`, weighted by length,
    and asks what they are tagged. A `layer` below zero counts as tunnel and a
    layer above zero as bridge, because plenty of Sydney's tunnelled ways carry
    one tag and not the other -- `sources/osm.py` makes the same point about
    roads.

    The threshold is a majority of the track length, not a majority of the ways:
    a station with fourteen short tunnel ways and one long surface approach is
    underground, and counting ways would say the opposite.
    """
    from scipy.spatial import cKDTree

    if not stations:
        return
    mid = 0.5 * (g.xy[g.edges[:, 0]] + g.xy[g.edges[:, 1]])
    tree = cKDTree(mid)
    for st in stations:
        idx = tree.query_ball_point([st.east, st.north], STATION_WAY_RADIUS_M)
        if not idx:
            st.vertical = "unknown"
            continue
        tun = bri = tot = 0.0
        for ei in idx:
            w = g.ways[int(g.way_of[ei])]
            L = float(g.length[ei])
            tot += L
            # `tunnel` and `bridge`, and **not** `layer`. `sources/osm.py` says
            # the same thing about roads and it is truer here: Kingsgrove's four
            # ways are `layer=-1` with no tunnel tag, because the station sits in
            # a cutting under two road bridges, and reading the layer made a
            # famous at-grade station underground.
            if w.tunnel:
                tun += L
            elif w.bridge:
                bri += L
        st.ways_near = len(idx)
        st.tunnel_share = tun / tot if tot else 0.0
        st.bridge_share = bri / tot if tot else 0.0
        if terrain is not None:
            st.ground_y = float(terrain.sample(st.east, st.north))
        near = min(idx, key=lambda e: (mid[e][0] - st.east) ** 2 + (mid[e][1] - st.north) ** 2)
        st.track_y = float(0.5 * (g.y[int(g.edges[near, 0])] + g.y[int(g.edges[near, 1])]))
        st.depth = st.ground_y - st.track_y

        if st.tunnel_share >= 0.5:
            st.vertical = "underground"
        elif st.bridge_share >= 0.5:
            st.vertical = "elevated"
        else:
            st.vertical = "surface"

        # --- A light-rail stop standing over somebody else's tunnel.
        #
        # This bake reads `railway=rail|subway` and no light rail at all, so a
        # `station=light_rail` node has no track of its own here. `track_y` above
        # takes the nearest edge in *plan*, and for a stop on the surface over a
        # Metro box the nearest edge in plan is the Metro, fifteen metres down --
        # which is how "Central Chalmers Street", a light rail stop on the
        # footpath outside Central, ended up with its platforms baked at the
        # height of the tunnel underneath it. It is not an underground station and
        # it is not a station this bake models: it is a stop whose track is
        # missing, and the honest answer is to put it back on the street and say
        # its class is unknown.
        # `tunnel_share < 0.5` is what keeps this off Town Hall, Wynyard and the
        # QVB, all three of which carry `station=light_rail` on the node that won
        # the name and all three of which are genuinely underground heavy-rail or
        # Metro stations. There the whole 85 m neighbourhood is tunnel, so the
        # nearest edge is not passing under the stop -- it *is* the stop. At
        # Central Chalmers Street only a fifth of it is, because the rest is the
        # Central train shed at grade fifteen metres above.
        if (
            st.kind == "light_rail"
            and st.tunnel_share < 0.5
            and st.depth >= UNDERGROUND_MIN_DEPTH_M
            and g.ways[int(g.way_of[near])].tunnel
        ):
            st.vertical = "unknown"
            st.track_y = st.ground_y
            st.depth = 0.0
            st.orphaned = True
            continue

        # --- The approach window. Promotion only; see the constants above.
        #
        # **Tunnel on both sides, and that is the whole rule.** A share taken over
        # the window as a whole cannot tell a station in a box from a station in a
        # cutting that happens to sit beside a portal, and Sydney has both within
        # a kilometre of each other: Cherrybrook is a box with tunnel running away
        # from it in both directions, and Wolli Creek is an open cutting with the
        # Airport Line diving under it at one end. Measured over the whole window
        # those score 0.68 and 0.59, which no threshold separates honestly. Split
        # by side they score (tunnel, tunnel) and (tunnel, open), which is not a
        # close call at all -- and it is the same thing a person means when they
        # say a station is underground: you cannot see daylight either way down
        # the platform.
        if st.vertical == "underground" or st.depth < UNDERGROUND_MIN_DEPTH_M:
            continue
        # The local track direction, from the same nearest edge `track_y` came
        # from, so "which side" is measured along the railway rather than along
        # the compass.
        ax, an = g.xy[int(g.edges[near, 0])]
        bx, bn = g.xy[int(g.edges[near, 1])]
        ux, un = float(bx - ax), float(bn - an)
        norm = math.hypot(ux, un) or 1.0
        ux, un = ux / norm, un / norm

        wide = tree.query_ball_point([st.east, st.north], STATION_APPROACH_RADIUS_M)
        # [behind, ahead], each (tunnelled metres, total metres).
        halves = [[0.0, 0.0], [0.0, 0.0]]
        for ei in wide:
            ey = 0.5 * (g.y[int(g.edges[ei, 0])] + g.y[int(g.edges[ei, 1])])
            if abs(ey - st.track_y) > APPROACH_LEVEL_BAND_M:
                continue
            side = 1 if (mid[ei][0] - st.east) * ux + (mid[ei][1] - st.north) * un >= 0 else 0
            L = float(g.length[ei])
            halves[side][1] += L
            if g.ways[int(g.way_of[ei])].tunnel:
                halves[side][0] += L
        tot_all = halves[0][1] + halves[1][1]
        st.approach_share = (halves[0][0] + halves[1][0]) / tot_all if tot_all else 0.0
        st.approach_ways = len(wide)
        # Every side that has enough track in it to have an opinion must agree.
        # `APPROACH_MIN_SIDE_M` is there for a terminus and for a station at the
        # edge of the extract, where one side is simply not in the data and a
        # missing half must not be read as a vote against.
        votes = [
            tun / tot >= 0.5
            for tun, tot in halves
            if tot >= APPROACH_MIN_SIDE_M
        ]
        if votes and all(votes):
            st.vertical = "underground"
            st.promoted = True


# --- Overhead power, staged for the geometry round ---------------------------------


@dataclass
class Stanchion:
    x: float
    y: float  # base, metres; the mast height is the geometry round's business
    z: float
    dx: float  # unit direction along the track, world frame
    dz: float
    kind: int  # 0 = cantilever left, 1 = cantilever right, 2 = portal gantry


def place_stanchions(g: RailGraph, blocks: BlockSet) -> list[Stanchion]:
    """Where the catenary masts go, baked now so the geometry round need not re-derive.

    The user asked for overhead power explicitly and it is cheap to answer here
    and expensive to answer later: the spacing wants arc length along a track,
    the cantilever side wants to know which side the corridor's other rails are
    on, and a portal gantry wants the track count -- all three of which this
    module has already computed and a mesh pass would have to rebuild.

    Only electrified track gets masts. 4,440 of the extract's ways carry
    `electrified=contact_line` and 709 say `electrified=no`; the diesel-only
    freight spurs and the heritage lines are the ones that come out bare, which
    is correct.
    """
    out: list[Stanchion] = []
    by_block: dict[int, list[int]] = defaultdict(list)
    for ei, b in blocks.of_edge.items():
        by_block[b].append(ei)

    for b, eis in by_block.items():
        # Walk the block's edges in graph order; spacing is arc length, so the
        # residual carries from one edge to the next and masts do not bunch at
        # every vertex.
        eis = sorted(eis)
        carry = 0.0
        portal = blocks.tracks[b] >= PORTAL_MIN_TRACKS
        side = 0
        for k, ei in enumerate(eis):
            w = g.ways[int(g.way_of[ei])]
            if w.electrified in (None, "no"):
                continue
            u, v = int(g.edges[ei, 0]), int(g.edges[ei, 1])
            ex, en = g.xy[u]
            fx, fn = g.xy[v]
            L = float(g.length[ei])
            if L < 1e-6:
                continue
            ux, un = (fx - ex) / L, (fn - en) / L
            wx, wz = geo.enu_to_world(np.array([ex]), np.array([en]))
            dxw, dzw = geo.enu_to_world(np.array([ux]), np.array([un]))
            t = STANCHION_SPACING_M - carry
            while t <= L:
                out.append(
                    Stanchion(
                        x=float(wx[0] + dxw[0] * t),
                        y=float(g.y[u] + (g.y[v] - g.y[u]) * (t / L)),
                        z=float(wz[0] + dzw[0] * t),
                        dx=float(dxw[0]),
                        dz=float(dzw[0]),
                        kind=2 if portal else side,
                    )
                )
                side ^= 1
                t += STANCHION_SPACING_M
            carry = (carry + L) % STANCHION_SPACING_M
    return out


# --- The bake ---------------------------------------------------------------------
#
# One file, `rail.bin`: a header, a JSON block that describes the structure, and
# the heavy arrays after it at eight-byte aligned offsets. The split is not
# aesthetic. The JSON is the part a human reads and a diff shows; the arrays are
# the part whose *bits* must survive the trip into two JavaScript engines, and
# f32 and f64 both widen into a double exactly, so a `Float64Array` view over
# this file gives Bun and V8 the same numbers rather than nearly the same ones.
#
# Staged into `data/scratch/rail/` and deliberately **not** into the world
# directory. Nothing here is a world asset yet; the geometry round is what
# earns a place in `client/public/world`.


def _pad8(n: int) -> int:
    return (8 - (n % 8)) % 8


def write_bake(
    out_dir: Path,
    g: RailGraph,
    lines: Sequence[Line],
    stations: Sequence[RailStation],
    blocks: BlockSet,
    stanchions: Sequence[Stanchion],
    solve: dict,
    meta: dict,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)

    verts: list[np.ndarray] = []
    cums: list[np.ndarray] = []
    flags: list[np.ndarray] = []
    phases: list[float] = []
    jlines = []
    v_off = 0
    p_off = 0
    for ln in lines:
        jdirs = []
        for d in ln.dirs:
            xyz = np.asarray(d.xyz, dtype=np.float32)
            cum = np.asarray(d.cum, dtype=np.float64)
            verts.append(xyz.reshape(-1))
            cums.append(cum)
            fl = np.asarray(d.flags, dtype=np.uint8)
            if fl.size != xyz.shape[0]:
                fl = np.zeros(xyz.shape[0], dtype=np.uint8)
            flags.append(fl)
            n = int(xyz.shape[0])
            ph = list(d.phases)
            for t0, s0, v0, a in ph:
                phases.extend((float(t0), float(s0), float(v0), float(a)))
            jdirs.append(
                {
                    "index": d.index,
                    "label": d.label,
                    "offset": int(d.offset),
                    "duration": float(d.duration),
                    "lengthM": float(cum[-1]) if n else 0.0,
                    "vertexOff": v_off,
                    "vertexCount": n,
                    "phaseOff": p_off,
                    "phaseCount": len(ph),
                    "minX": float(xyz[:, 0].min()) if n else 0.0,
                    "maxX": float(xyz[:, 0].max()) if n else 0.0,
                    "minZ": float(xyz[:, 2].min()) if n else 0.0,
                    "maxZ": float(xyz[:, 2].max()) if n else 0.0,
                    "stops": [
                        {
                            "name": s.name,
                            "s": float(s.s),
                            "calls": bool(s.stops),
                        }
                        for s in d.stops
                    ],
                    "arrivals": [float(a) for a in d.arrivals],
                    "blocks": [[int(b), float(s0), float(s1), int(sl)] for b, s0, s1, sl in d.blocks],
                    "gaps": list(getattr(d, "gaps", [])),
                }
            )
            v_off += n
            p_off += len(ph)
        jlines.append(
            {
                "id": ln.id,
                "name": ln.name,
                "colour": ln.colour,
                "metro": ln.metro,
                "period": int(ln.dirs[0].period) if ln.dirs else BASE_PERIOD_S,
                "missing": ln.missing,
                "dirs": jdirs,
            }
        )

    vert_arr = np.concatenate(verts) if verts else np.zeros(0, dtype=np.float32)
    cum_arr = np.concatenate(cums) if cums else np.zeros(0, dtype=np.float64)
    flag_arr = np.concatenate(flags) if flags else np.zeros(0, dtype=np.uint8)
    ph_arr = np.asarray(phases, dtype=np.float64)
    st_arr = np.asarray(
        [[s.x, s.y, s.z, s.dx, s.dz] for s in stanchions], dtype=np.float32
    ).reshape(-1)
    st_kind = np.asarray([s.kind for s in stanchions], dtype=np.uint8)

    jstations = [
        {
            "name": s.name,
            "x": float(geo.enu_to_world(np.array([s.east]), np.array([s.north]))[0][0]),
            "z": float(geo.enu_to_world(np.array([s.east]), np.array([s.north]))[1][0]),
            "trackY": float(s.track_y),
            "groundY": float(s.ground_y),
            "vertical": s.vertical,
            "depth": s.depth,
            "approachShare": s.approach_share,
            "approachWays": s.approach_ways,
            "promoted": s.promoted,
            "orphaned": s.orphaned,
            "kind": s.kind,
            "platforms": int(s.platforms),
            "tunnelShare": round(float(s.tunnel_share), 4),
            "bridgeShare": round(float(s.bridge_share), 4),
        }
        for s in stations
    ]

    header = {
        "version": BAKE_VERSION,
        "epochMs": RAIL_EPOCH_MS,
        "generated": int(time.time()),
        "physics": {
            "accel": ACCEL, "brake": BRAKE, "vLocal": V_LOCAL, "vExpress": V_EXPRESS,
            "expressMinM": EXPRESS_MIN_M, "dwell": DWELL_S,
            "blockTargetM": BLOCK_TARGET_M, "sepS": SEP_S, "sepJunctionS": SEP_JUNCTION_S,
            "maxGradient": MAX_GRADIENT,
        },
        "solve": {k: v for k, v in solve.items() if k != "degraded"},
        "degraded": solve.get("degraded", {}),
        "spanFlags": {
            "tunnel": SPAN_TUNNEL, "bridge": SPAN_BRIDGE, "cutting": SPAN_CUTTING,
            "embankment": SPAN_EMBANKMENT, "electrified": SPAN_ELECTRIFIED,
            "subway": SPAN_SUBWAY,
        },
        "notes": LINE_NOTES,
        "meta": meta,
        "lines": jlines,
        "stations": jstations,
        "blocks": {
            "count": blocks.count,
            "length": [round(float(x), 2) for x in blocks.length],
            "junction": [bool(x) for x in blocks.junction],
            "tracks": [int(x) for x in blocks.tracks],
        },
        "buffers": {},
    }

    # --- Where each array starts is *derived*, not recorded ---------------------
    #
    # The obvious layout puts byte offsets in the JSON, which makes the JSON's
    # own length depend on numbers that depend on the JSON's own length. The
    # first draft solved that by writing it three times and hoping the digit
    # count settled. This does not have the problem: the JSON carries element
    # *counts*, the arrays are written in one fixed order at eight-byte
    # alignment, and both the writer below and `rail.ts`'s decoder walk the same
    # rule to the same offsets. There is nothing to keep in sync but the order.
    ARRAYS = (
        ("vertices", vert_arr),
        ("cum", cum_arr),
        ("phases", ph_arr),
        ("stanchions", st_arr),
        ("stanchionKinds", st_kind),
        ("vertexFlags", flag_arr),
    )
    header["buffers"] = {
        name: {"count": int(arr.size), "itemBytes": int(arr.itemsize)}
        for name, arr in ARRAYS
    }
    header["buffers"]["order"] = [name for name, _ in ARRAYS]
    payload = json.dumps(header, separators=(",", ":")).encode("utf-8")

    buf = bytearray()
    buf += struct.pack("<IIII", RAIL_MAGIC, BAKE_VERSION, len(payload), 0)
    buf += payload
    buf += b"\0" * _pad8(len(buf))
    for _, arr in ARRAYS:
        buf += arr.tobytes()
        buf += b"\0" * _pad8(len(buf))

    bin_path = out_dir / "rail.bin"
    bin_path.write_bytes(bytes(buf))
    (out_dir / "rail.json").write_text(json.dumps(header, indent=1))
    (out_dir / "stations.json").write_text(json.dumps(jstations, indent=1))
    (out_dir / "phases.json").write_text(
        json.dumps(
            {
                "epochMs": RAIL_EPOCH_MS,
                "cycleS": solve.get("cycle_s"),
                "lines": {
                    ln.id: {
                        "period": ln.dirs[0].period,
                        "offsets": [d.offset for d in ln.dirs],
                        "labels": [d.label for d in ln.dirs],
                    }
                    for ln in lines
                },
                "degraded": solve.get("degraded", {}),
                "attempts": solve.get("attempts", []),
                "recovered": solve.get("recovered", []),
            },
            indent=1,
        )
    )
    (out_dir / "graph.json").write_text(
        json.dumps(
            {
                "nodes": g.n_nodes,
                "edges": g.n_edges,
                "ways": len(g.ways),
                "blocks": blocks.count,
                "stanchions": len(stanchions),
                "segmentMaxM": SEGMENT_MAX_M,
            },
            indent=1,
        )
    )
    return {"bytes": len(buf), "path": str(bin_path), "json_bytes": len(payload)}


# --- Building the whole thing ------------------------------------------------------


def build_all(radius_m: float, log=print, terrain=True) -> dict:
    """Read, graph, route, curve, block, solve, stanchion. Everything but writing."""
    t0 = time.time()
    ways, stations, platforms = read_rail(radius_m)
    corridors = read_corridors(radius_m)
    log(
        f"  read {len(ways)} rail/subway ways, {len(stations)} stations, "
        f"{len(platforms)} platform polygons, {len(corridors)} route relations "
        f"({time.time() - t0:.1f}s)"
    )

    g = build_graph(ways)
    comp = components(g)
    uniq, counts = np.unique(comp, return_counts=True)
    log(f"  graph {g.n_nodes} nodes, {g.n_edges} edges, {len(uniq)} components "
        f"(largest {counts.max()})")

    field = None
    ground_note = "no terrain sampled; every height is relative to the datum"
    if terrain:
        try:
            from .terrain import Terrain

            field = Terrain.load(radius_m, conform_roads=False, conform_water=False)
            ground_note = (
                f"terrarium DEM, unconformed (datum y=0 is {field.base_elevation:.1f} m AHD). "
                "It is a *surface* model, so CBD ground reads high by roughly a "
                "building; the vertical class of a station is read off tags, never "
                "off this."
            )
        except Exception as exc:  # noqa: BLE001 -- reported, not swallowed
            ground_note = f"terrain unavailable ({exc.__class__.__name__}: {exc})"
            log(f"  terrain: {ground_note}")
    y_raw, _ground = raw_heights(g, field)
    g.y, hstats = solve_heights(g, y_raw)
    log(f"  heights: worst grade {100 * hstats['worst_grade_before']:.1f}% raw -> "
        f"{100 * hstats['worst_grade_after']:.2f}% after the envelope solve, "
        f"moved p95 {hstats['moved_p95_m']:.2f} m")

    lines = build_lines(g, stations, corridors, log=log)
    for ln in lines:
        for d in ln.dirs:
            build_curve(d)
    blocks = cut_blocks(g, lines)
    for ln in lines:
        for d in ln.dirs:
            map_blocks(d, g, blocks)
    wide = sum(1 for t in blocks.tracks if t >= PORTAL_MIN_TRACKS)
    log(f"  blocks: {blocks.count} sections, {sum(blocks.junction)} junction-aligned, "
        f"mean {np.mean(blocks.length):.0f} m, longest {max(blocks.length):.0f} m; "
        f"corridor width {min(blocks.tracks)}-{max(blocks.tracks)} tracks, "
        f"{wide} of them wider than a pair")

    solve = solve_phases(lines, blocks, log=log)
    classify_vertical(g, stations, field)
    stanchions = place_stanchions(g, blocks)
    log(f"  overhead: {len(stanchions)} stanchions "
        f"({sum(1 for s in stanchions if s.kind == 2)} portal gantries)")

    return {
        "graph": g,
        "lines": lines,
        "stations": stations,
        "platforms": platforms,
        "blocks": blocks,
        "stanchions": stanchions,
        "solve": solve,
        "heights": hstats,
        "ground_note": ground_note,
        "ways": ways,
        "seconds": time.time() - t0,
    }


# --- The audit ----------------------------------------------------------------------
#
# Hand-asserted stations, from TRAINS.md section 4 and the brief. Getting one of
# these wrong is a regression that *names itself*, which is the whole reason a
# table of famous cases sits beside a general check.

HAND_ASSERTED: list[tuple[str, str, str]] = [
    ("Town Hall", "underground", "City Circle, 15/15 ways tunnelled"),
    ("Wynyard", "underground", "City Circle"),
    ("St James", "underground", "City Circle"),
    ("Museum", "underground", "City Circle"),
    ("Circular Quay", "elevated", "the viaduct over Alfred Street"),
    ("Central", "surface", "the great train shed is at grade"),
    ("Kingsgrove", "surface", "at grade, in a cutting"),
    ("Martin Place", "underground", "Eastern Suburbs Railway"),
    ("Kings Cross", "underground", "Eastern Suburbs Railway"),
    ("Bondi Junction", "underground", "Eastern Suburbs Railway"),
    ("Milsons Point", "elevated", "the Harbour Bridge approach"),
    ("Meadowbank", "surface", "the bridge approach is beside it, not under it"),
]


def audit(radius_m: float, built: dict | None = None, log=print) -> int:
    """Continuity, gradient, the vertical-profile table, and the separation sweep."""
    failures: list[str] = []
    notes: list[str] = []

    def check(ok: bool, msg: str) -> None:
        log(("  PASS  " if ok else "  FAIL  ") + msg)
        if not ok:
            failures.append(msg)

    b = built if built is not None else build_all(radius_m, log=log)
    g, lines, stations = b["graph"], b["lines"], b["stations"]
    blocks, solve = b["blocks"], b["solve"]

    log("")
    log("--- 1. Continuity: every line paths end to end")
    for ln in lines:
        for d in ln.dirs:
            gaps = list(getattr(d, "gaps", []))
            check(
                not gaps and len(d.nodes) > 1,
                f"{ln.id} {'up' if d.index else 'down'} {d.label}: "
                f"{d.cum[-1] / 1000:.2f} km, {len(d.nodes)} vertices, "
                f"{sum(s.stops for s in d.stops)} calls of {len(d.stops)} stations"
                + (f" -- {len(gaps)} GAP(S): {gaps[0]}" if gaps else ""),
            )
        if ln.missing:
            notes.append(f"{ln.id}: {len(ln.missing)} station(s) absent from the extract: "
                         f"{', '.join(ln.missing)}")

    log("")
    log("--- 2. The frame: world z is -north, checked against a station we know")
    quay = next((s for s in stations if s.name == "Circular Quay"), None)
    central = next((s for s in stations if s.name == "Central"), None)
    if quay is None or central is None:
        raise AuditUnresolved("Circular Quay or Central is not in the extract")
    _qx, qz = geo.enu_to_world(np.array([quay.east]), np.array([quay.north]))
    _cx, cz = geo.enu_to_world(np.array([central.east]), np.array([central.north]))
    check(
        float(qz[0]) < 0.0 and float(cz[0]) > 0.0 and float(qz[0]) < float(cz[0]),
        f"Circular Quay is north of the origin and lands at z={float(qz[0]):.0f}; "
        f"Central is south and lands at z={float(cz[0]):.0f}",
    )

    log("")
    log("--- 3. Gradient: no solved profile steeper than the ruling 3.3%")
    u, v = g.edges[:, 0], g.edges[:, 1]
    grade = np.abs(g.y[u] - g.y[v]) / np.maximum(g.length, 1e-6)
    worst = float(grade.max()) if g.n_edges else 0.0
    check(
        worst <= MAX_GRADIENT + 1e-6,
        f"worst solved gradient is {100 * worst:.3f}% against a {100 * MAX_GRADIENT:.1f}% "
        f"limit; the raw profile was {100 * b['heights']['worst_grade_before']:.1f}% "
        f"and the projection moved the track a median-of-the-tail {b['heights']['moved_p95_m']:.2f} m",
    )
    log(f"  note: ground came from {b['ground_note']}")

    log("")
    log("--- 4. Vertical profile, from the tags, for every station on a line")
    on_line = {s.name for ln in lines for d in ln.dirs for s in d.stops}
    by_name = {s.name: s for s in stations}
    tally = defaultdict(int)
    for nm in sorted(on_line):
        st = by_name.get(nm)
        if st is None:
            continue
        tally[st.vertical] += 1
    log(f"  {tally['surface']} surface, {tally['elevated']} elevated, "
        f"{tally['underground']} underground, {tally['unknown']} unknown "
        f"({len(on_line)} stations on a modelled line, {len(stations)} in the extract)")

    # The full table, every station on a line. The brief asks for all of it and
    # it is worth all of it: `surface` is the default and the interesting rows
    # are the ones that are not, but a table that only prints the exceptions
    # cannot show that a station has silently *stopped* being one.
    log("")
    log(f"  {'station':<26} {'verdict':<12} {'tunnel':>7} {'bridge':>7} {'ways':>5} "
        f"{'track y':>8} {'ground y':>9} {'below':>7}")
    odd: list[str] = []
    for nm in sorted(on_line):
        st = by_name.get(nm)
        if st is None:
            continue
        below = st.ground_y - st.track_y
        mark = " *" if st.vertical != "surface" else "  "
        log(f"  {nm:<26} {st.vertical:<12}{mark}{st.tunnel_share:6.2f} {st.bridge_share:7.2f} "
            f"{st.ways_near:5d} {st.track_y:8.1f} {st.ground_y:9.1f} {below:7.1f}")
        if st.vertical != "surface":
            odd.append(f"{nm} ({st.vertical})")
    log(f"  {len(odd)} station(s) are not at grade: {', '.join(odd)}")
    log("")
    log(f"  {'station':<22} {'verdict':<12} {'expected':<12} {'tunnel':>7} {'bridge':>7} "
        f"{'track y':>8} {'ground y':>9}")
    for nm, want, why in HAND_ASSERTED:
        st = by_name.get(nm)
        if st is None:
            check(False, f"{nm}: not in the extract at all")
            continue
        ok = st.vertical == want
        log(f"  {nm:<22} {st.vertical:<12} {want:<12} {st.tunnel_share:7.2f} "
            f"{st.bridge_share:7.2f} {st.track_y:8.1f} {st.ground_y:9.1f}   {why}")
        check(ok, f"{nm} is {st.vertical} as expected" if ok
              else f"{nm} came out {st.vertical}, expected {want} ({why})")

    log("")
    log("--- 5. The full-cycle separation sweep, simulated at 10 Hz")
    cycle = int(solve.get("cycle_s") or BASE_PERIOD_S)
    viol, samples, closest = separation_sweep(lines, blocks, cycle, hz=10)
    check(
        solve.get("solved", False),
        f"the phase solver reached an assignment (cycle {cycle} s, "
        f"{solve.get('rails_shared', 0)} shared rails of {solve.get('rails_used', 0)})",
    )
    check(
        viol == 0,
        f"{samples} sampled (train, rail) occupancies over the whole {cycle} s cycle and "
        f"{viol} violation(s); the closest any two trains came to sharing a rail was "
        f"{closest:.1f} s against a {SEP_S:.0f} s rule",
    )

    log("")
    log("--- 6. What the service actually is")
    log(f"  {'line':<5} {'period':>7} {'phase d/u':>11} {'km down':>8} {'km up':>7} "
        f"{'calls':>6} {'express':>8} {'run':>7}")
    for ln in lines:
        d0, d1 = ln.dirs[0], ln.dirs[1]
        expr = _express_legs(d0)
        log(f"  {ln.id:<5} {ln.dirs[0].period:>6}s {d0.offset:>5}/{d1.offset:<5} "
            f"{d0.cum[-1] / 1000:8.2f} {d1.cum[-1] / 1000:7.2f} "
            f"{sum(s.stops for s in d0.stops):6d} {expr:8d} {d0.duration / 60:6.1f}m")
    degraded = solve.get("degraded", {})
    if degraded:
        log("")
        log("  DEGRADED, and this is the whole of it:")
        for lid, why in sorted(degraded.items()):
            log(f"    {lid} runs at {next(l for l in lines if l.id == lid).dirs[0].period} s "
                f"rather than {BASE_PERIOD_S} s -- {why}")
    for n in LINE_NOTES:
        log(f"  note: {n}")
    for n in notes:
        log(f"  note: {n}")

    log("")
    if failures:
        log(f"{len(failures)} CHECK(S) FAILED:")
        for f in failures:
            log(f"  - {f}")
        return EXIT_FAIL
    log("ALL RAIL CHECKS PASSED")
    return EXIT_PASS


class AuditUnresolved(RuntimeError):
    """The audit could not reach a verdict. `cli.py` has the same idea."""


def _express_legs(d: Direction) -> int:
    calls = [s for s in d.stops if s.stops]
    total = float(d.cum[-1])
    bounds = [0.0] + [c.s for c in calls[1:-1]] + [total]
    return sum(1 for k in range(1, len(bounds)) if bounds[k] - bounds[k - 1] >= EXPRESS_MIN_M)


def separation_sweep(
    lines: Sequence[Line], blocks: BlockSet, cycle: int, hz: int = 10
) -> tuple[int, int, float]:
    """Simulate every train over the whole cycle and watch every rail.

    Not the same computation as the solver's: the solver reasons about intervals
    in closed form, and this walks the clock at 10 Hz and asks where each train
    actually is, through the same evaluator the runtime will use. Two ways of
    being right, and `checkRail` in the integration suite is a third, from the
    TypeScript decoder. TRAINS.md's rule about never trusting one implementation
    of an invariant.

    Vectorised per (direction, trip) rather than looped per sample: the naive
    form is 2.2 million Python iterations, each doing two binary searches, and
    an audit nobody will wait for is an audit nobody runs.
    """
    ts = np.arange(round(cycle * hz), dtype=np.float64) / hz
    rails: list[np.ndarray] = []
    times: list[np.ndarray] = []
    trips: list[np.ndarray] = []

    for li, ln in enumerate(lines):
        for d in ln.dirs:
            if not d.phases or not d.blocks:
                continue
            ph = np.asarray(d.phases, dtype=np.float64)
            pt, ps, pv, pa = ph[:, 0], ph[:, 1], ph[:, 2], ph[:, 3]
            bs = np.asarray([r[1] for r in d.blocks], dtype=np.float64)
            be = np.asarray([r[2] for r in d.blocks], dtype=np.float64)
            bk = np.asarray([blocks.key(r[0], r[3]) for r in d.blocks], dtype=np.int64)
            period = d.period
            span = math.ceil(d.duration / period) + 1
            for j in range(span + 1):
                k = np.floor((ts - d.offset) / period) - j
                age = ts - d.offset - k * period
                live = (age >= 0.0) & (age <= d.duration)
                if not live.any():
                    continue
                a = age[live]
                i = np.searchsorted(pt, a, side="right") - 1
                np.clip(i, 0, len(pt) - 1, out=i)
                dt = a - pt[i]
                sv = ps[i] + pv[i] * dt + 0.5 * pa[i] * dt * dt
                bi = np.searchsorted(bs, sv, side="right") - 1
                ok = (bi >= 0) & (bi < len(bs))
                bi = np.clip(bi, 0, max(len(bs) - 1, 0))
                ok &= sv <= be[bi]
                if not ok.any():
                    continue
                rails.append(bk[bi][ok])
                times.append(ts[live][ok])
                # A trip's identity, stable across the sweep: line, direction and
                # which departure it is. Two samples of one train must never look
                # like two trains.
                trips.append(
                    (li * 2 + d.index) * 100_000 + (k[live][ok].astype(np.int64) % 100_000)
                )

    if not rails:
        return 0, 0, 0.0
    rail = np.concatenate(rails)
    time_ = np.concatenate(times)
    trip = np.concatenate(trips)
    order = np.lexsort((time_, rail))
    rail, time_, trip = rail[order], time_[order], trip[order]

    same_rail = rail[1:] == rail[:-1]
    changed = trip[1:] != trip[:-1]
    edge = same_rail & changed
    gaps = time_[1:][edge] - time_[:-1][edge]
    sep = np.where(
        np.asarray([blocks.junction[int(r) // 2] for r in rail[1:][edge]], dtype=bool),
        SEP_JUNCTION_S,
        SEP_S,
    )
    viol = int(np.count_nonzero(gaps < sep))
    closest = float(gaps.min()) if gaps.size else 0.0
    return viol, int(rail.size), closest


def _rail_at(d: Direction, blocks: BlockSet, s: float) -> int:
    for b, s0, s1, slot in d.blocks:
        if s0 <= s <= s1:
            return blocks.key(b, slot)
    return -1


# --- Commands -----------------------------------------------------------------------
#
# Two subcommands, reachable two ways: `python -m sydney rail-bake` (registered in
# `cli.py` with a lazy import, so nothing here can break the build command's
# import path) and `python -m sydney.rail bake`, which needs no registration at
# all. The second exists because a 60 km world build was running while this was
# written and a broken import in `cli.py` would have cost it its resume.


def cmd_rail_bake(args: argparse.Namespace) -> int:
    radius = float(getattr(args, "radius", 0) or config.STAGE_BY_NAME["middle"].radius_m)
    out = Path(getattr(args, "out", "") or OUT_DIR)
    print(f"rail-bake: {radius / 1000:.0f} km, writing to {out}")
    b = build_all(radius, terrain=not getattr(args, "no_terrain", False))
    info = write_bake(
        out, b["graph"], b["lines"], b["stations"], b["blocks"], b["stanchions"],
        b["solve"],
        {"radius_m": radius, "ground": b["ground_note"], "seconds": round(b["seconds"], 1)},
    )
    total = sum(p.stat().st_size for p in out.glob("*") if p.is_file())
    print(f"  wrote {info['bytes'] / 1024:.1f} kB of rail.bin "
          f"({info['json_bytes'] / 1024:.1f} kB of it JSON) and "
          f"{total / 1024:.1f} kB in {out} altogether")
    return EXIT_PASS


def cmd_rail_audit(args: argparse.Namespace) -> int:
    radius = float(getattr(args, "radius", 0) or config.STAGE_BY_NAME["middle"].radius_m)
    print(f"rail-audit: {radius / 1000:.0f} km")
    try:
        b = build_all(radius, terrain=not getattr(args, "no_terrain", False))
        return audit(radius, b)
    except AuditUnresolved as exc:
        print(f"\n  UNRESOLVED: rail-audit could not reach a verdict -- {exc}")
        return EXIT_UNRESOLVED
    except KeyboardInterrupt:
        raise
    except Exception:  # noqa: BLE001 -- see cli.py's `_audit` for the argument
        import traceback

        traceback.print_exc()
        print("\n  UNRESOLVED: rail-audit crashed before reaching a verdict.")
        return EXIT_UNRESOLVED


def add_arguments(p: argparse.ArgumentParser) -> argparse.ArgumentParser:
    p.add_argument("--radius", type=float, default=None,
                   help="metres of extract to read. Defaults to the middle stage (60 km).")
    p.add_argument("--out", default=None, help=f"output directory (default {OUT_DIR})")
    p.add_argument("--no-terrain", action="store_true",
                   help="skip the DEM; every height comes out relative to the datum")
    return p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sydney.rail", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    add_arguments(sub.add_parser("bake", help="write data/scratch/rail")).set_defaults(
        func=cmd_rail_bake
    )
    add_arguments(sub.add_parser("audit", help="check the rail service core")).set_defaults(
        func=cmd_rail_audit
    )
    args = ap.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
