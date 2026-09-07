"""Two places where the DSM is not the authority on where the ground is.

`terrain.py` says the lattice is the surface and everything drapes on it, and
`roadgrade.py` already carved out the first exception to that: a surface model
cannot say where a *road* is, because in a city it is looking at the roofs
beside the road, so the streets decide and the ground follows them. This module
is the same argument twice more, for two places where the roofs the DSM is
reading are not beside the thing but **on top of it**.

    1. **Under a bridge-tagged station, the ground is the street.**
       At Chatswood terrarium reads the interchange development at 43 m AHD
       over platforms whose concourse is at street level and whose decks are six
       to eight metres over that. The rail solver measured the bill in
       RAIL-VERTICAL.md section 3a: the deck cannot rise above about -3.6 m of
       clearance while the ground says 43 m, and the last three metres are "a
       terrain question ... not a height-solve one". This is that question
       answered. Inside the platform extent the lattice conforms to the
       **solved street heights** -- the same `roadgrade` surface that already
       decides the ground everywhere a car drives -- and not to the DSM.

    2. **Under a hero landmark's footprint, the ground is the landmark's base.**
       Luna Park's site is flat, three or four metres over the harbour, on
       reclaimed land behind a seawall. This world's DEM runs the Milsons Point
       cliff straight through it: 27.4 m of relief across the thirteen
       footprints, 9.5 m of it between two entrance towers standing thirteen
       metres apart. `landmarks.py` has been paying for that in plinths and
       daylight cuts and says so in its own header ("the model cannot flatten
       that -- the terrain is baked"). It is no longer baked before the landmark
       is heard from: the footprint the model stands on is levelled to the pad
       the model stands at, and `pad_spread_m` goes 9.50 -> 0.00.

---------------------------------------------------------------------------
THE SHAPE IS `roadgrade.conform`'S, DELIBERATELY.

A zone, a target height over it, a plateau where the target wins outright and a
smoothstep feather back to natural ground outside it, all stamped onto the one
global lattice inside `Terrain.load` exactly once. Two tiles sharing an edge
read the same lattice elements they always did; no tile does any conforming; the
sidecar format does not change. Everything `roadgrade.py`'s header argues about
tile independence and seams applies here word for word and is not repeated.

Three things are this module's own.

**The feather is one post spacing, and that is what makes the pass auditable.**
`roadgrade` reaches a cell diagonal past its corridor because a road is a thing
you look straight down at and every corner of every cell it touches has to be
road-driven. A pad is not that: it is a *stated* extent with an edge, and the
useful property of a stated extent is that you can check nothing outside it
moved. So the plateau is the zone, the feather is `terrain.post_spacing()`
metres, and the consequence is a gate rather than a hope --
`terrain-rules-check.py` asserts that every post this pass moves lies within
`FEATHER_M` of one of the zones, and nothing else in the ring moves by a
millimetre. A rule that can name the ground it is allowed to touch should be
made to.

**The precedence is roads, then water, then pads, and the water is not
negotiable.** This runs last, and it still may not raise the harbour bed: every
zone is clipped against `water.conform`'s own polygons -- the plateau **and the
feather band**, which is a distinction that cost a measured mistake and is
written up in `clip_water`. A landmark's pad is a claim about the ground it
stands on and not about where the shoreline is, and Luna Park's promenade -- a
`man_made=pier` lying entirely inside the mapped harbour -- is exactly the
polygon that would otherwise have put fourteen metres of dry land into Lavender
Bay. `stats["clipped_m2"]` says how much zone that costs; at Luna Park and
Circular Quay together it is 27,857 m2.

**A landmark is opted in by name, in `landmarks.ground_founded`, with a reason
each way.** The tempting inference -- "the model takes `base_y` from
`terrain.sample`" -- is true of Sydney Tower as well, whose pad is Westfield's
block in the middle of the CBD and whose ground `roadgrade.py` is already the
authority on; and the bridge and the Opera House work in `sea + <n> AHD`
throughout, so neither has a `base_y` for this to pull to. All three are out,
their exclusions are argued where the list is, and `terrain-rules-check.py`
section 5 proves the no-op the only way worth proving it: it builds all four
heroes on both grounds and diffs their audit blocks, and the bridge's, the
Opera House's and the tower's come out identical to the millimetre.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field as dc_field

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from . import config, roadgrade

# --- The zones -----------------------------------------------------------------

# How far past a stated outline the pad still owns the ground, metres.
# `roadgrade.LATTICE_REACH_M`, and for its reason exactly -- it is the one
# load-bearing number in that module and it is load-bearing here for the same
# arithmetic. The lattice is only defined at 31.25 m posts and what the player
# stands on is the interpolation between them, so pulling only the posts that lie
# *inside* a footprint achieves nothing: a cell containing footprint has corners
# up to 31.25 * sqrt(2) = 44.19 m away, and one corner left at the DSM's roof
# height tilts the whole facet the footprint stands on. Measured on Luna Park
# with the margin at zero, the promenade came out 1.09 m off `base_y` and Coney
# Island 0.44 m off, with every post the rule owned sitting exactly at the pad --
# the error was entirely interpolation from corners the rule had not claimed.
# With the margin at 44.19 m every corner of every cell the footprint touches is
# pad-driven and the ground inside the footprint is `base_y` exactly, not nearly.
PAD_MARGIN_M = roadgrade.LATTICE_REACH_M
STATION_MARGIN_M = PAD_MARGIN_M

# The blend back to natural ground outside a zone, metres. One post spacing --
# see the header: the plateau is the stated zone and the feather is exactly one
# cell, so "nothing outside the zone plus one cell moved" is a check and not a
# hope. Smoothstep, so there is no crease at either end of the band.
FEATHER_M = config.TILE_SIZE / config.TERRAIN_GRID

# How far from a post the street network is still "the street outside this
# station", metres. Chatswood's platforms have Victoria Avenue over one end and
# Railway Street beside the other; 150 m reaches both and stops short of the
# Pacific Highway ridge. Grown by doubling if a zone finds nothing at all, so a
# station in a paddock still gets an answer rather than an exception.
STREET_SEARCH_M = 150.0
STREET_SEARCH_MAX_M = 600.0


@dataclass
class Pad:
    """One stated extent of ground, and the height it is stated to be at.

    `target(east, north)` returns the height for arrays of posts, so a pad whose
    answer is one number (a landmark) and a pad whose answer is a field (a
    station over its streets) are the same object to `conform`.
    """

    name: str
    kind: str  # 'station' | 'landmark'
    zone: BaseGeometry
    target: Callable[[np.ndarray, np.ndarray], np.ndarray]
    note: dict = dc_field(default_factory=dict)


@dataclass(frozen=True)
class PadRecord:
    """What a pad was, once the heights are written and the field is spent.

    `Pad` holds a closure over a KD-tree of half a million road segments and is
    therefore neither small nor picklable; `terraincache` pickles the whole
    `Terrain`, so what hangs off it afterwards has to be the *record* -- the
    water-clipped zone the pass actually wrote inside, its name and its numbers.
    That is also exactly what the gate needs: the geometry that was used, not a
    reconstruction of it.
    """

    name: str
    kind: str
    zone: BaseGeometry  # the plateau: water-clipped, pulled outright
    reach: BaseGeometry  # every post the pad could touch: the plateau + feather, less water
    note: dict


def _clean(geoms: list[BaseGeometry]) -> BaseGeometry | None:
    live = [g for g in geoms if g is not None and not g.is_empty and g.is_valid]
    if not live:
        return None
    merged = unary_union(live)
    return None if merged.is_empty else merged


def wet_geometry(water) -> BaseGeometry | None:
    """Every mapped water body as one geometry, or None where there is none."""
    if water is None or water.is_empty():
        return None
    return _clean([lvl.geom for lvl in water.levels])


def clip_water(zone: BaseGeometry, wet: BaseGeometry | None) -> tuple[BaseGeometry | None, float]:
    """A zone with the mapped water taken out of it, and the area that cost.

    See the header: this pass runs after `water.conform` and may not undo it.

    **This has to be applied to the feather band and not only to the plateau**,
    and getting that wrong once is why it is spelt out here. With the plateau
    clipped and the feather left alone, Luna Park's sheds reached 31 m past the
    waterline at four fifths weight and stood fourteen metres of dry ground on a
    tidal body whose surface is 3.5 m below it -- an island in Lavender Bay, out
    of a rule about a theme park's forecourt. `conform` therefore cuts the water
    out of the plateau **and** out of the band around it, and writes only inside
    what is left: `PadRecord.reach`, which is the geometry the gate then tests
    against.

    Takes the water as one prepared geometry rather than as a `WaterField`, so
    that a caller with several zones unions the bodies once instead of once a
    zone; `wet_geometry` is what prepares it.
    """
    if wet is None:
        return zone, 0.0
    dry = zone.difference(wet)
    lost = float(zone.area - dry.area)
    return (None if dry.is_empty else dry), lost


# --- Rule one: the ground under a bridge-tagged station ------------------------


def _platform_rect(p) -> Polygon:
    """A `rail.RailPlatform`'s own rotated rectangle, back as a polygon.

    The reader already measured the deck in the frame it was drawn in
    (`rail._platform_axis`) and threw the corners away because nothing until now
    wanted them. Rebuilding them from the axis is exact, not an approximation:
    the four numbers are the rectangle.
    """
    u = np.array([p.ux, p.un], dtype=np.float64)
    v = np.array([-p.un, p.ux], dtype=np.float64)
    c = np.array([p.east, p.north], dtype=np.float64)
    return Polygon(
        [
            c + u * p.half_length + v * p.half_width,
            c + u * p.half_length - v * p.half_width,
            c - u * p.half_length - v * p.half_width,
            c - u * p.half_length + v * p.half_width,
        ]
    )


def _street_target(surface: roadgrade.RoadSurface) -> Callable:
    """The solved street network's height, extended into a zone the roads miss.

    `RoadSurface.blend` is the same field with `roadgrade`'s feather on it, which
    is zero more than `FEATHER_M` past a corridor -- and the whole point of a
    station pad is that the ground *inside* it is the street's even though no
    street is drawn through the concourse. So the feather is held at one and the
    weighting is `roadgrade._omega` unchanged: the nearest street wins about ten
    to one against anything 45 m further off, which is what keeps a station
    beside a ramp interchange on the street it fronts rather than on the mean of
    the twelve around it.
    """
    from scipy.spatial import cKDTree

    mid = 0.5 * (surface.a + surface.b)
    tree = cKDTree(mid)

    def target(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        out = np.zeros(len(east), dtype=np.float64)
        for k in range(len(east)):
            r = STREET_SEARCH_M
            idx: list[int] = []
            while not idx and r <= STREET_SEARCH_MAX_M:
                idx = tree.query_ball_point([east[k], north[k]], r)
                r *= 2.0
            if not idx:
                out[k] = np.nan
                continue
            sel = np.asarray(sorted(idx))
            d, h = roadgrade._segment_distance_height(
                east[k], north[k], surface.a[sel], surface.b[sel],
                surface.ha[sel], surface.hb[sel],
            )
            omega = roadgrade._omega(np.ones_like(d), d)
            out[k] = float((omega * h).sum() / omega.sum())
        return out

    return target


def station_pads(radius_m: float, surface: roadgrade.RoadSurface | None) -> list[Pad]:
    """Rule one's zones: every bridge-tagged station's platform extent.

    `structure` here is exactly `rail.classify_vertical`'s -- the length-weighted
    tunnel/bridge share of the track within `rail.STATION_WAY_RADIUS_M` -- and it
    is computable *here*, before any height exists, because it is a question
    about OSM tags and nothing else. That is RAIL-VERTICAL.md section 3 read
    forwards: OSM is the authority on what the structure is, so the structure is
    known before the ground is solved, and it is the ground that has to be told.

    A station with no platform polygon is skipped, and skipped quietly: a rule
    about a platform extent cannot fire on a station that has not got one, and
    the alternative -- a rectangle guessed around the station node -- is how a
    shopping-centre roof becomes a 200 m plateau in the wrong place and at the
    wrong angle. In the 12 km extract this loses nothing: every bridge-tagged
    station in it (Chatswood, Circular Quay, Milsons Point) is mapped with its
    decks.
    """
    if surface is None:
        return []
    from . import rail

    ways, stations, platforms, _entrances = rail.read_rail(radius_m)
    if not stations or not ways:
        return []

    # The same length-weighted share `classify_vertical` takes, over way
    # segments rather than graph edges -- there is no graph yet and there does
    # not need to be one, because the quantity is metres of tagged track near a
    # point and a way's own vertices measure that exactly.
    seg_mid: list[np.ndarray] = []
    seg_len: list[float] = []
    seg_kind: list[int] = []  # 0 open, 1 tunnel, 2 bridge
    for w in ways:
        line = np.asarray(w.line, dtype=np.float64)
        if len(line) < 2:
            continue
        d = np.hypot(*(line[1:] - line[:-1]).T)
        seg_mid.append(0.5 * (line[1:] + line[:-1]))
        seg_len.append(d)
        seg_kind.append(np.full(len(d), 1 if w.tunnel else 2 if w.bridge else 0))
    if not seg_mid:
        return []
    mid = np.concatenate(seg_mid)
    length = np.concatenate(seg_len)
    kind = np.concatenate(seg_kind)

    from scipy.spatial import cKDTree

    tree = cKDTree(mid)
    target = _street_target(surface)
    pads: list[Pad] = []
    for st in stations:
        idx = tree.query_ball_point([st.east, st.north], rail.STATION_WAY_RADIUS_M)
        if not idx:
            continue
        sel = np.asarray(sorted(idx))
        tot = float(length[sel].sum())
        if tot <= 0.0:
            continue
        tun = float(length[sel][kind[sel] == 1].sum()) / tot
        bri = float(length[sel][kind[sel] == 2].sum()) / tot
        if tun >= 0.5 or bri < 0.5:
            continue  # tunnel wins outright; anything else is not a deck
        rects = [_platform_rect(platforms[k]) for k in st.faces]
        zone = _clean([r.buffer(STATION_MARGIN_M, join_style=2, mitre_limit=2.0)
                       for r in rects])
        if zone is None:
            continue
        pads.append(
            Pad(
                name=st.name,
                kind="station",
                zone=zone,
                target=target,
                note={
                    "bridge_share": round(bri, 3),
                    "tunnel_share": round(tun, 3),
                    "platforms": len(rects),
                    "platform_length_m": round(st.platform_length, 1),
                    "east": round(st.east, 1),
                    "north": round(st.north, 1),
                },
            )
        )
    return pads


# --- Rule two: the ground under a hero landmark's footprint --------------------


def _level_target(base: float) -> Callable:
    """One height everywhere. A landmark's pad, as `Pad.target` wants it."""

    def target(east: np.ndarray, _north: np.ndarray) -> np.ndarray:
        return np.full(len(east), base, dtype=np.float64)

    return target


def landmark_pads(radius_m: float, sample) -> list[Pad]:
    """Rule two's zones: the footprints of every ground-founded hero landmark.

    `landmarks.ground_founded` says which those are and why. The base is read
    off the lattice as it stands -- after the road and water passes, before this
    one -- at the centroid of the landmark's stated base key, which is the same
    expression `build_*` has always used.

    **And then it is written down, because reading it back is not the same
    question.** A footprint samples `base_y` exactly only when all four corners
    of its own cell were levelled to it, and at Luna Park six of thirteen have a
    mapped-harbour post in their cell that `water.conform` owns and this pass may
    not raise -- the entrance canopy among them, which reads 3.82 m low. So the
    number goes into `PadRecord.note["base_y"]` and `landmarks.stated_pad` hands
    it back to the model unchanged. One expression, two readers; the alternative
    is two answers and an entrance built four metres under its own halls.
    """
    from . import landmarks

    # 4 km is `read_anchors`' own default and covers all four heroes; a wider
    # read is forty thousand more multipolygons for features that are all inside
    # Circular Quay.
    anchors = landmarks.read_anchors(min(radius_m, 4000.0))
    pads: list[Pad] = []
    for name, keys, base_key in landmarks.ground_founded():
        rings = [np.asarray(anchors[k].ring, dtype=np.float64) for k in keys if k in anchors]
        if not rings or base_key not in anchors:
            continue
        base = float(sample(*Polygon(anchors[base_key].ring).centroid.coords[0]))
        zone = _clean(
            [Polygon(r).buffer(PAD_MARGIN_M, join_style=2, mitre_limit=2.0)
             for r in rings if len(r) >= 3]
        )
        if zone is None:
            continue
        pads.append(
            Pad(
                name=name,
                kind="landmark",
                zone=zone,
                target=_level_target(base),
                note={
                    # Unrounded, deliberately: `landmarks.stated_pad` hands this
                    # exact float back to the model, and a pad rounded here and
                    # a lattice levelled to the full value is a half-millimetre
                    # of disagreement for nothing.
                    "base_y": base,
                    "footprints": len(rings),
                    "area_m2": round(float(zone.area), 1),
                },
            )
        )
    return pads


# --- The conformance -----------------------------------------------------------


def _feather(d: np.ndarray) -> np.ndarray:
    """Smoothstep from 1 on the zone boundary to 0 `FEATHER_M` outside it."""
    u = np.clip((FEATHER_M - d) / FEATHER_M, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def conform(
    heights: np.ndarray, p0: int, q0: int, spacing: float, pads: list[Pad], water=None,
    records: list | None = None,
) -> dict:
    """Pull the terrain lattice onto the stated pads, in place.

    `heights[qi, pi]` is the post at east `(p0 + pi) * spacing`, north
    `(q0 + qi) * spacing` -- `terrain._Lattice`'s layout taken apart here so this
    module needs nothing from that one, exactly as `roadgrade.conform` does.

    Post-major over a small candidate set rather than segment-major over a
    stencil: a pad is a handful of polygons covering a few hundred posts, so the
    honest thing is to walk the posts near each zone and ask shapely how far
    each one is from it. Where two pads overlap a post they are averaged by
    feather weight, and the post is then blended from natural ground toward that
    average by the largest of the weights -- the same two-stage arrangement
    `roadgrade.conform` uses, and for the same reason: the average decides
    *what* height, the maximum decides *how much of it*.

    `records`, when given, is appended with one `PadRecord` per zone actually
    written -- the water-clipped geometry, which is what the gate has to test
    against and what `Terrain.pads` carries forward.
    """
    stats: dict = {"pads": 0, "posts": 0, "conformed": 0, "clipped_m2": 0.0, "zones": []}
    if not pads:
        return stats

    q_n, p_n = heights.shape
    num = np.zeros(heights.size)
    den = np.zeros(heights.size)
    wmax = np.zeros(heights.size)
    natural = heights.astype(np.float64).ravel()
    wet = wet_geometry(water)

    for pad in pads:
        zone, lost = clip_water(pad.zone, wet)
        stats["clipped_m2"] += lost
        if zone is None:
            stats["zones"].append(
                {"name": pad.name, "kind": pad.kind, "posts": 0,
                 "note": {**pad.note, "dropped": "entirely inside mapped water"}}
            )
            continue
        e0, n0, e1, n1 = zone.bounds
        lo_p = max(math.floor(e0 / spacing - p0 - FEATHER_M / spacing), 0)
        hi_p = min(math.ceil(e1 / spacing - p0 + FEATHER_M / spacing), p_n - 1)
        lo_q = max(math.floor(n0 / spacing - q0 - FEATHER_M / spacing), 0)
        hi_q = min(math.ceil(n1 / spacing - q0 + FEATHER_M / spacing), q_n - 1)
        if hi_p < lo_p or hi_q < lo_q:
            continue
        pi, qi = np.meshgrid(
            np.arange(lo_p, hi_p + 1), np.arange(lo_q, hi_q + 1), indexing="xy"
        )
        pi, qi = pi.ravel(), qi.ravel()
        east = (pi + p0) * spacing
        north = (qi + q0) * spacing

        # The plateau plus its feather, with the water taken out of the whole
        # band and not only out of the middle of it -- see `clip_water`. The
        # geometry is built here rather than the weight masked afterwards so
        # that `PadRecord.reach` and the posts actually written are the same
        # statement, which is what the gate in `terrain-rules-check.py` tests.
        reach = zone.buffer(FEATHER_M, join_style=2, mitre_limit=2.0)
        if wet is not None:
            reach = reach.difference(wet)
        if reach.is_empty:
            continue
        pts = shapely.points(east, north)
        d = np.asarray(shapely.distance(pts, zone), dtype=np.float64)
        w = np.where(shapely.intersects(pts, reach), _feather(d), 0.0)
        live = w > 0.0
        if not live.any():
            stats["zones"].append(
                {"name": pad.name, "kind": pad.kind, "posts": 0, "note": pad.note}
            )
            continue
        h = np.asarray(pad.target(east[live], north[live]), dtype=np.float64)
        ok = np.isfinite(h)
        flat = (qi[live] * p_n + pi[live])[ok]
        wl = w[live][ok]
        np.add.at(num, flat, wl * h[ok])
        np.add.at(den, flat, wl)
        np.maximum.at(wmax, flat, wl)
        stats["pads"] += 1
        if records is not None:
            records.append(PadRecord(pad.name, pad.kind, zone, reach, dict(pad.note)))
        stats["zones"].append(
            {
                "name": pad.name,
                "kind": pad.kind,
                "posts": int(ok.sum()),
                "plateau": int((wl >= 1.0).sum()),
                "area_m2": round(float(zone.area), 1),
                "note": pad.note,
            }
        )

    if not (wmax > 0.0).any():
        stats["posts"] = int(heights.size)
        return stats

    pulled = np.divide(num, den, out=natural.copy(), where=den > 0.0)
    blended = natural + wmax * (pulled - natural)
    moved = np.abs(blended - natural)
    heights[:] = blended.reshape(heights.shape).astype(heights.dtype)
    touched = moved > 0.0
    stats.update(
        {
            "posts": int(heights.size),
            "conformed": int((wmax > 0.0).sum()),
            "plateau": int((wmax >= 1.0).sum()),
            "moved": int(touched.sum()),
            "moved_p50": float(np.percentile(moved[touched], 50)) if touched.any() else 0.0,
            "moved_p95": float(np.percentile(moved[touched], 95)) if touched.any() else 0.0,
            "moved_max": float(moved.max()),
            "clipped_m2": round(stats["clipped_m2"], 1),
        }
    )
    return stats


def allowed_geometry(records) -> BaseGeometry:
    """Every post this pass was allowed to move, as one geometry.

    The union of `PadRecord.reach` -- each written plateau grown by `FEATHER_M`
    and then cut against the water -- which is the exact set of points at which
    this pass can write anything at all. The gate in
    `terrain-rules-check.py` asserts that no post outside it moved, and it takes
    the geometry from `Terrain.pads` -- what the pass wrote -- rather than
    rebuilding it, so a check that has drifted from the rule is not a thing that
    can happen here.
    """
    merged = _clean([r.reach for r in records])
    return merged if merged is not None else MultiPolygon([])
