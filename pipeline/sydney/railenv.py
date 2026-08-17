"""Where the railway is, in plan, for the passes that have to keep out of it.

Two rules in the build need the same answer and neither can derive it:

  * a building whose footprint overlaps a **station** is deleted at bake time
    (`STATIONS.md` step 4, and the owner's *"blanket delete please"*);
  * a tree standing in the **corridor** is deleted, because the carve takes the
    ground out from under it and leaves it hanging over a trench.

They are one question asked at two scales, so they are answered here once. The
alternative -- each pass buffering the track for itself -- is the defect
`STATIONS.md` spends 1,800 lines on: two descriptions of one boundary, kept in
step by diligence.

---------------------------------------------------------------------------
**Nothing in this module decides where the railway is.** Every coordinate comes
out of `data/scratch/rail/`, which `sydney rail-bake` wrote, and specifically
out of the **direction polylines** -- the same array `client/src/world/rail-cut.RailCut`
is built from and `rail.corridor_paving` samples. That is deliberate and it is
the whole reason this module reads a bake rather than the OSM extract:

> `world/rail-cut.RailCut` is built from the direction polylines in the bake and
> from nothing else: sampling the graph would file paving against track the
> client never carves, and worse, could miss track it does.
>                                                    -- `rail.corridor_paving`

A keep-out measured off the graph would keep trees out of sidings the client
never carves and let them stand in track it does. So the envelope is measured
off the thing that carves.

---------------------------------------------------------------------------
THE ORDERING, WHICH IS A REAL COUPLING AND IS STATED RATHER THAN HIDDEN.

The build reads a bake, and the bake reads the build -- `rail.py` measures the
undercroft and the station box against the world's buildings. That is a cycle,
and it is survivable for one reason worth writing down: **the envelope is plan
geometry over OSM track and OSM platforms, and neither moves when a building is
deleted.** The bake's *heights* change (a demolished station building changes no
railhead, but the undercroft measurement reads footprints); its plan does not.

So the order is: build with the bake you have, then re-bake. If the two ever
disagree about the plan, `station-clear-audit` says so -- it re-reads the shipped
world against the current bake and fails on a building still standing in an
envelope.

---------------------------------------------------------------------------
NO BAKE, NO KEEP-OUT, AND IT SAYS SO. Absent `rail.bin` this module returns an
empty envelope and the caller prints that it did. `corridor_paving` set that
precedent for exactly this reason: a build that quietly skips a keep-out ships
the defect back and the output says nothing at all.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from . import config

# --- Where the bake is ---------------------------------------------------------

RAIL_DIR = config.SCRATCH_DIR / "rail"
BAKE_PATH = RAIL_DIR / "rail.bin"
STATIONS_PATH = RAIL_DIR / "stations.json"

# ASCII 'RAIL' little-endian. **Must match `MAGIC` in `rail.write_bake` and
# `client/src/game/rail.ts`.**
BAKE_MAGIC = 0x4C494152

# The order the arrays are written in, from `rail.write_bake`. Restated rather
# than imported because `rail.py` is 6,700 lines and importing it to read six
# offsets would drag the whole timetable solver into every build.
BAKE_ARRAYS = (
    "vertices", "cum", "phases", "stanchions", "stanchionKinds",
    "vertexFlags", "vertexClearance", "paving",
)

# `rail.SPAN_TUNNEL`. A bore has no surface expression -- RAIL-VERTICAL.md §3.1,
# *"tunnel=yes wins outright ... nothing carves, no surface expression"* -- so a
# tree over one is a tree in a park and a building over one is a building.
SPAN_TUNNEL = 1


# --- The two half-widths, restated on this project's usual terms ----------------
#
# Both live in `client/src/world/rail-cut.ts` and are restated here rather than
# imported, for the reason `rail.PAVING_HALF_M` gives: a constant imported from
# the module under description could not be noticed changing. `rail-cut-consistency`
# in `station-clear-audit` asserts these against the TypeScript source, so a
# restatement that drifts is caught rather than trusted.

#: `rail-cut.CUT_HALF_WIDTH` -- the plain corridor away from a station.
CUT_HALF_WIDTH = 5.4

#: `rail-cut.STATION_HALF_WIDTH` -- what the carve flares to at a platform.
STATION_HALF_WIDTH = 9.4

#: `rail-geo.FENCE_OFFSET`. The boundary fence stands here, and the ground under
#: a fence is the outermost thing the railway owns, so it is the outer bound of
#: the tree keep-out. Wider than `CUT_HALF_WIDTH` on purpose: a tree between the
#: fence and the rim is a tree inside the railway's own fence.
FENCE_OFFSET = 6.4

# How far past the station box a track segment still counts as *through* this
# station, metres. The box's own half length plus a margin, so a platform that
# curves out of its box takes the track with it.
STATION_REACH_PAD_M = 20.0

# How finely a track segment is cut before it is clipped to the station reach.
# The bake's direction polylines run about 40 m a vertex and up to 200, so
# buffering a whole segment because one end is near a station hangs most of a
# block off the end of a 200 m platform.
SEGMENT_STEP_M = 4.0


def _pad8(n: int) -> int:
    return (8 - (n % 8)) % 8


@dataclass
class StationEnvelope:
    """One station's plan footprint, and whether it has one at all."""

    name: str
    poly: Polygon
    #: 'surface' | 'elevated' | 'underground', from the bake.
    vertical: str

    @property
    def surface(self) -> bool:
        """Does this station exist where a building stands?

        A bore does not. Town Hall's box is a volume between the platform and
        the footpath over it, and a building at the footpath stands on its
        **ceiling** -- so a plan test against the box deletes the Queen Victoria
        Building for standing over the Metro. Measured: 204 of 1,745 buildings
        the plan test removes are over a bore, and they are the QVB (20),
        Gadigal (18), Bridge Street (14) and Martin Place.
        """
        return self.vertical != "underground"


@dataclass
class RailEnvelope:
    """The railway in plan: station footprints, and the corridor between them."""

    stations: list[StationEnvelope] = field(default_factory=list)
    #: Buffered non-tunnel track, at `FENCE_OFFSET`. The tree keep-out.
    corridor: list[Polygon] = field(default_factory=list)
    #: Track kilometres the envelope was built from, for the build report.
    track_km: float = 0.0
    #: Empty when there is no bake to read.
    loaded: bool = False

    def __post_init__(self) -> None:
        surface = [s for s in self.stations if s.surface]
        self._station_polys = [s.poly for s in surface]
        self._station_names = [s.name for s in surface]
        self._station_tree = STRtree(self._station_polys) if self._station_polys else None
        self._corridor_tree = STRtree(self.corridor) if self.corridor else None
        self._corridor_prepared = [prep(p) for p in self.corridor]

    # --- Rule 1: the blanket delete -------------------------------------------

    def station_hit(self, poly: Polygon) -> str | None:
        """Which station's envelope this footprint overlaps, if any.

        The station's name rather than a bare bool, because the build reports
        the delete by station and a count with no names is a number nobody can
        check against a map.
        """
        if self._station_tree is None or poly.is_empty:
            return None
        for i in self._station_tree.query(poly):
            i = int(i)
            if self._station_polys[i].intersects(poly):
                return self._station_names[i]
        return None

    # --- Rule 3: the tree keep-out ---------------------------------------------

    def in_corridor(self, east: float, north: float) -> bool:
        """Does a trunk at this ENU position stand inside the railway?

        Takes ENU because every caller in `vegetation.py` is in ENU, and
        converts here -- one conversion in one place rather than a frame
        question at four call sites. `geo.enu_to_world` is the identity on east
        and negates north.
        """
        if self._corridor_tree is None:
            return False
        p = Point(east, -north)
        for i in self._corridor_tree.query(p):
            if self._corridor_prepared[int(i)].intersects(p):
                return True
        return False


def _rect(x: float, z: float, ux: float, uz: float, half_len: float, half_wid: float) -> Polygon:
    """A rotated rectangle in world x/z, from a centre, a unit axis and two halves."""
    n = math.hypot(ux, uz)
    if n < 1e-9:
        ux, uz, n = 1.0, 0.0, 1.0
    a = np.array([ux / n, uz / n])
    p = np.array([-a[1], a[0]])
    c = np.array([x, z])
    return Polygon([
        c + a * half_len + p * half_wid,
        c + a * half_len - p * half_wid,
        c - a * half_len - p * half_wid,
        c - a * half_len + p * half_wid,
    ])


def load_bake(path: Path | None = None) -> dict | None:
    """`rail.bin`'s JSON block plus its arrays, or None when there is no bake.

    The Python reader of a format whose one definition is `rail.write_bake`.
    `scripts/stationfit/railbin.py` is the other and predates this one; they
    decode the same bytes the same way, and the reason there are two is that
    nothing under `scripts/` may be imported by the pipeline package.
    """
    p = path or BAKE_PATH
    if not p.exists():
        return None
    buf = p.read_bytes()
    magic, _version, json_len = struct.unpack_from("<III", buf, 0)
    if magic != BAKE_MAGIC:
        raise ValueError(f"{p} is not a rail bake: magic 0x{magic:x}")
    meta = json.loads(buf[16:16 + json_len].decode("utf-8"))
    off = 16 + json_len
    off += _pad8(off)
    arrays: dict[str, np.ndarray] = {}
    for name in BAKE_ARRAYS:
        spec = meta["buffers"].get(name)
        if spec is None:
            continue
        nbytes = spec["count"] * spec["itemBytes"]
        if name in ("stanchionKinds", "vertexFlags"):
            dt: type = np.uint8
        elif spec["itemBytes"] == 4:
            dt = np.float32
        else:
            dt = np.float64
        arrays[name] = np.frombuffer(buf, dtype=dt, count=spec["count"], offset=off)
        off += nbytes + _pad8(nbytes)
    meta["arrays"] = arrays
    return meta


def track_polylines(bake: dict) -> list[tuple[np.ndarray, np.ndarray]]:
    """Every direction polyline as `(xz, flags)`, world frame."""
    v = bake["arrays"]["vertices"].reshape(-1, 3)
    fl = bake["arrays"]["vertexFlags"]
    out: list[tuple[np.ndarray, np.ndarray]] = []
    for ln in bake["lines"]:
        for d in ln["dirs"]:
            o, c = d["vertexOff"], d["vertexCount"]
            if c < 2:
                continue
            out.append((
                np.asarray(v[o:o + c][:, [0, 2]], dtype=np.float64),
                np.asarray(fl[o:o + c]),
            ))
    return out


def _open_segments(tracks) -> list[tuple[float, float, float, float]]:
    """Every non-tunnel track segment, world frame."""
    segs: list[tuple[float, float, float, float]] = []
    for xz, flags in tracks:
        for i in range(len(xz) - 1):
            if (int(flags[i]) | int(flags[i + 1])) & SPAN_TUNNEL:
                continue
            ax, az = float(xz[i][0]), float(xz[i][1])
            bx, bz = float(xz[i + 1][0]), float(xz[i + 1][1])
            if math.hypot(bx - ax, bz - az) < 1e-6:
                continue
            segs.append((ax, az, bx, bz))
    return segs


def _station_poly(st: dict, segs, reach_pad: float) -> Polygon | None:
    """One station's plan envelope: its decks, its track and its box."""
    parts: list[Polygon] = []

    # 1. The platform decks. OSM surveyed these -- a real position, a real
    #    length and a real orientation -- and `rail.RailPlatform` measured each
    #    as a minimum-area rotated rectangle. Nothing here re-derives them.
    for f in st["faces"]:
        parts.append(_rect(f["x"], f["z"], f["ux"], f["uz"], f["halfLength"], f["halfWidth"]))

    sx, sz = st["siteX"], st["siteZ"]
    reach = st["boxHalfLength"] + reach_pad

    # 2. `STATION_HALF_WIDTH` about each track through the station. A SEGMENT
    #    joins when the segment is within reach, never when the polyline's index
    #    range spans the station: a city-circle direction passes Central twice,
    #    and taking every segment between the two passes buffered nine
    #    kilometres of railway into one station's envelope. Measured before the
    #    clip, Newtown's envelope reached 644 m up the line into Macdonaldtown's.
    for ax, az, bx, bz in segs:
        if (min(ax, bx) - reach > sx or max(ax, bx) + reach < sx
                or min(az, bz) - reach > sz or max(az, bz) + reach < sz):
            continue
        seg = LineString([(ax, az), (bx, bz)])
        if seg.length > SEGMENT_STEP_M:
            n = int(seg.length / SEGMENT_STEP_M) + 1
            keep = []
            for k in range(n + 1):
                p = seg.interpolate(k / n, normalized=True)
                if math.hypot(p.x - sx, p.y - sz) <= reach:
                    keep.append((p.x, p.y))
            if len(keep) < 2:
                continue
            seg = LineString(keep)
        elif math.hypot((ax + bx) / 2 - sx, (az + bz) / 2 - sz) > reach:
            continue
        parts.append(seg.buffer(STATION_HALF_WIDTH, cap_style=2))

    # 3. The box, which is the volume a body may legitimately be inside and is
    #    therefore the volume a building may not. `rail.STATION_BOX_HALF_WIDTH_M`
    #    is 16 m -- wider than the carve, because a box has to be wider than the
    #    hole it is in -- and the length is the platform's own plus a concourse
    #    margin at each end. Read off the bake rather than restated.
    parts.append(_rect(sx, sz, st["siteDx"], st["siteDz"],
                       st["boxHalfLength"], st["boxHalfWidth"]))

    if not parts:
        return None
    poly = unary_union(parts)
    if poly.is_empty:
        return None
    if poly.geom_type != "Polygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly


def load(log=print, path: Path | None = None) -> RailEnvelope:
    """Read the bake and build both envelopes, or say why there are none."""
    bake = load_bake(path)
    stations_path = (path.parent if path else RAIL_DIR) / "stations.json"
    if bake is None or not stations_path.exists():
        log(f"  rail envelope: NO BAKE at {BAKE_PATH}, so no building is deleted off a "
            f"station and no tree is kept out of the corridor. Run `sydney rail-bake` "
            f"first or this build ships both defects back")
        return RailEnvelope(loaded=False)

    tracks = track_polylines(bake)
    segs = _open_segments(tracks)
    km = sum(math.hypot(b - a, d - c) for a, c, b, d in segs) / 1000.0

    rows = json.loads(stations_path.read_text())
    stations: list[StationEnvelope] = []
    for st in rows:
        poly = _station_poly(st, segs, STATION_REACH_PAD_M)
        if poly is None or poly.is_empty:
            continue
        stations.append(StationEnvelope(st["name"], poly, st.get("vertical", "unknown")))

    corridor = [
        LineString([(a, c), (b, d)]).buffer(FENCE_OFFSET, cap_style=2)
        for a, c, b, d in segs
    ]

    env = RailEnvelope(stations=stations, corridor=corridor, track_km=km, loaded=True)
    surface = sum(1 for s in stations if s.surface)
    log(f"  rail envelope: {len(stations):,} stations ({surface:,} with a surface "
        f"expression), {km:,.0f} km of non-tunnel track buffered at "
        f"{FENCE_OFFSET:.1f} m for the tree keep-out")
    return env
