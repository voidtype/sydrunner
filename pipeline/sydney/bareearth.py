"""The one place the DSM is asked what is *underneath* what it can see.

`pads.py` rule 1 says the ground under a bridge-tagged station is the adjacent
solved street. That is the right authority and it bought +0.7 m at Chatswood,
and then it stopped, because of a thing the rule could not have known: **the
streets around Chatswood are on the same contaminated plateau as the station.**
Measured on the 9.5 km solve, at the station node E-2763 N7863:

    raw DSM drape          42.82        the surface as terrarium gives it
    roads + water          41.05        the street solve, which already
                                        low-quantiles and opens the profile
    as it ships (rule 1)   40.85        the station pad, on those streets

A metre and a half between the raw surface and three passes of correction, over
a station whose platforms the rail solve puts at 39.75 and whose clearance is
therefore **-3.58 m**: the deck is under the ground it stands on.
RAIL-VERTICAL.md section 3a measured that and named the cause in one sentence --
"the DEM is a *surface* model and the 43 m plateau over the platform is the
interchange development sitting on it" -- and then said the last three metres
were a terrain question. This module is that question answered.

---------------------------------------------------------------------------
## What is on disk, and which of the three answers it allows

The brief offered three, and the data chooses between them rather than taste.

**(a) A bare-earth DEM beside the surface one.** There is not one. `data/cache`
holds exactly one elevation source, `terrarium/13/*.png` -- the Mapzen terrain
tiles `terrain.py` documents -- and its own header calls it a surface model and
lists ELVIS' 1 m LiDAR as a standing follow-up that has not arrived. There is no
second raster to sample. Option (a) is not available, and saying so is not a
guess: it is `ls`.

**(c) A stated pad, from OSM `ele` or from `level`.** Measured over every
feature within 260 m of the three bridge-tagged stations in the extract:
**zero** carry `ele`. 453 carry `level`, and `level` is ordinal, not metric --
worse, Chatswood's two platform polygons are tagged `level=0` with the
interchange concourse below them at `level=-1`, so the tag says the platforms
are at the reference level and the ground is under *them*. Read as metres that
is the error, not the fix. Option (c) has nothing to state.

**(b) DSM minus the buildings.** Available, and this is what ships -- but not
in the form the brief sketched, and the difference is the whole finding.

## Masking the footprints out and refilling does nothing, measured

The sketch was: mask every footprint's DSM cells, fill inward from the unmasked
ring, smooth. Implemented and measured over a 1.4 km window on Chatswood, at
the station node:

    smoothed DSM                                113.67 m
    footprints masked, ring-filled, smoothed    113.97 m     +0.31 m

**The wrong way, by a third of a metre.** The reason is in the raw pixels, and
it is not subtle: over the 800 m square around the platforms the raw terrarium
median inside a footprint of 1500 m2 or more is **100.00 m** and outside every
footprint it is **104.00 m**. Roofs are not higher than the open ground here.
Terrarium at zoom 13 is 15.87 m a pixel and Chatswood's buildings are 20-60 m
across, so a roof never gets a pixel to itself; what the raster holds is already
a blend, and masking a blended cell and interpolating from its blended
neighbours recovers the blend. The same measurement in the CBD, where the
buildings are 150-250 m across, gives roof 45 m against open 28 m -- a **+17 m**
signal -- so the estimator is not broken, it is *out of resolution* at a
suburban centre. A rule proven on the CBD and shipped for Chatswood would have
been a rule proven on the one place it works.

## So the DSM is not masked, it is *deconvolved*

The model that does hold at both resolutions is the one `terrain.py`'s own
follow-up note proposes and nobody had built: the smoothed surface is the
smoothed bare ground plus the smoothed built mass,

    DSM(x) = G_sigma * ( bare + coverage(x) * height(x) )

and since `G_sigma` is linear, the built term can be subtracted at the same
resolution it was added at. `coverage * height` is rasterised from the footprints
the pipeline already reads -- OSM's, which carry `height` or `building:levels`
for the buildings that matter here -- convolved with the *same* 60 m Gaussian
`terrain._load_dem` uses, and taken off. No mask, no hole to fill, no dependence
on a roof owning a pixel: a 40 m building covering a quarter of a pixel
contributes a quarter of 40 m to that pixel, which is exactly what the blending
did to it on the way in.

Measured, at the same three probes:

    Chatswood station     DSM 113.67   built 12.73   bare 100.94    (-12.73)
    Town Hall (origin)    DSM  71.07   built 16.17   bare  54.90    (-16.17)
    Centennial Park       DSM  27.01   built  1.21   bare  25.81    ( -1.21)

The middle row is the calibration and it is the reason `BUILT_COEFF` is 1.0 and
not something tuned. `terrain.py`'s header records that the CBD reads about 40 m
high against a true ~28 m AHD; this takes 16 m of that off. It **under**-corrects
by a factor of about two and a half in the one place the truth is written down,
which is the side of the error a subtraction from the ground has to be on. A
coefficient chosen to close the CBD gap would be a coefficient fitted to one
point and it would dig holes everywhere else. And the third row is the negative
control the whole idea needs: over a park with no footprints in it the
correction is 1.21 m of the neighbouring streets bleeding in through the
Gaussian's own tail, and nothing else.

## Where it is allowed to run, and the floor under it

**Only inside a bridge-tagged station's zone**, which is `pads.bridge_station_zones`
-- one definition of that extent, read by this module and by rule 1, so a change
to what counts as a bridge-tagged station cannot move one and not the other --
**unioned with every building footprint that intersects it**, because half a
building's ground corrected and the other half not is a step through a wall.
Plateau, one-cell smoothstep feather, `pads.conform` doing the writing: the same
shape as rule 1 and the same gate, which is that no post outside the stated zone
plus one cell may move by a millimetre.

**And it may not take off more than there is roof over the platforms.** That is
`roof_cap`, it is the load-bearing bound in this module, and the measurement
that put it there is Circular Quay: the deconvolution is *right* about the Quay
and unusable. It wants 15.6 m off, because the CBD's towers really are in the
60 m Gaussian's tail there -- but the Quay's ground in this world stands 35 m
over its own harbour, and the wharves, the Cahill viaduct, the Opera House and
the bridge have all been built to that. A rule about a station's platforms is
not allowed to be the thing that discovers a thirty-metre error in the CBD. So
the subtraction is floored at `natural - roof_cap`, where `roof_cap` is the
coverage-weighted height of the non-railway buildings standing over the
station's own decks. Chatswood's decks are 47% covered by 26 m of `retail` and
the cap is 12.12 m, which does not bind; Circular Quay's are covered by
`building=train_station` awnings and nothing else, so its cap is 0.00 m and the
rule declines the station outright. **A station is allowed to be as wrong as the
roof over it, and no more.**

**And it may not dig below the ground around it.** `FLOOR_RING_M` metres outside
the zone the surface is whatever it was; the corrected ground inside is clamped
never to fall below the minimum of the *smoothed DSM* over that ring. One
mis-tagged `height=200` on a shed cannot therefore crater a station -- the worst
it can do is take the pad down to the lowest real ground its own neighbourhood
has, which is a bounded, visible, checkable failure instead of a hole. At
Chatswood the clamp does not bind: the ring's minimum is well under the
corrected pad.

## When it runs, and why that is before everything

Last in `Terrain.load` is where a pad goes; **first** is where this goes, before
`roadgrade.solve` has read a single profile. Rule 1's answer is the *solved
street*, and a street solved on a contaminated surface is a contaminated answer
-- which is precisely why rule 1 stalled at +0.7 m. Correcting the lattice first
means the streets through the station's own zone are solved on ground that has
had the shopping centre taken off it, and rule 1 then has something true to pull
the station onto.

That ordering has a cost the gate has to be honest about, and it is measured
rather than hoped: the road solve is a graph low-pass followed by two Lipschitz
projections, so a post moved inside the zone can move a *road* node outside it,
and `roadgrade.conform` then reaches `LATTICE_REACH_M + FEATHER_M` past that
road's corridor. `bare-earth-check.py` measures exactly how far that carries and
prints it; the zone-plus-one-cell assertion is made against the direct write and
the road solve's own shadow is reported beside it as its own number.
"""

from __future__ import annotations

import math

import numpy as np
import requests
import shapely
from scipy import ndimage
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import config, geo, pads, terrain

# --- The constants, each with the measurement that chose it --------------------

# How much of the rasterised built mass to take off. **One**, meaning the model
# is believed at face value and nothing is fitted. The header's Town Hall row is
# the argument: the one place the true ground is written down, this recovers
# about 40% of the known error, so the subtraction is conservative everywhere and
# a coefficient tuned to close that gap would be tuned on a single point.
BUILT_COEFF = 1.0

# Sub-samples per DSM pixel per axis when rasterising coverage. A terrarium pixel
# is 15.87 m and Sydney's buildings are 8-60 m across, so 4x4 resolves a footprint
# to about a sixteenth of a pixel -- finer than the 1 m quantisation of the source
# it is being subtracted from, and 16 point-in-polygon tests per pixel rather than
# 64.
SUBSAMPLE = 4

# Fetch and convolve this far past a zone, metres. Three sigma of the smoothing
# kernel plus a lattice cell, for `terrain.FETCH_MARGIN_M`'s reason exactly: the
# corrected surface inside the zone must be filtered against real data on every
# side, not against an edge-clamped repeat of the zone's own edge.
WINDOW_MARGIN_M = 3.0 * terrain.SMOOTH_SIGMA_M + config.TILE_SIZE / config.TERRAIN_GRID

# The ring the floor clamp is measured over, metres past the zone. 200 m is far
# enough to be off any one station's own built plateau and near enough to still
# be the same landform -- at Chatswood it reaches the railway either side of the
# platforms and stops short of the Pacific Highway ridge, which is the same
# argument `pads.STREET_SEARCH_M` makes for 150 m.
FLOOR_RING_M = 200.0

# Storey height where a footprint states `building:levels` but not `height`.
# `attributes.py` carries a per-archetype table for the facade grammar; this is
# deliberately not that table, because what is wanted here is one number that
# cannot be wrong by much over a whole zone rather than the right number for one
# building. 3.3 m is `attributes._classify`'s own fallback.
STOREY_M = 3.3

# Height for a footprint that states neither. Two storeys: the modal Sydney
# building, and the direction that under-corrects -- 72% of the extract's OSM
# footprints state nothing, and almost all of them are houses.
UNSTATED_M = 6.0

# `building` values that are the railway's own structure rather than something
# built on top of it. A platform canopy is not a development over a station: it
# is the station, and the DSM at 15.87 m a pixel cannot see it anyway. The list
# matters because it is what decides `roof_cap`, and `roof_cap` is what stops
# this rule from restructuring a precinct -- see the header.
RAILWAY_STRUCTURE = frozenset({"train_station", "roof", "canopy", "shelter", "bridge"})


def _height(b) -> float:
    """One footprint's height in metres, from what OSM states about it."""
    if b.height:
        return float(b.height)
    if b.levels:
        return float(b.levels) * STOREY_M
    return UNSTATED_M


def roof_cap(decks, footprints, heights, kinds) -> float:
    """Metres of building standing over a station's own platform decks.

    **This is the bound on the whole rule and the reason it is safe.** The claim
    the pass makes is that the DSM over a bridge-tagged station is reading the
    development built on top of the platforms; so the pass may not take off more
    than there is development on top of the platforms. Coverage-weighted over
    the decks themselves -- `pads.StationZone.decks`, the rectangles before the
    44 m margin -- because a shopping centre beside a station is not a shopping
    centre over it.

    Measured over the three bridge-tagged stations in the 9.5 km extract, and
    the three answers are the argument:

        Chatswood        3,092 m2 of deck, 47% of it under 26 m of `retail`
                         (the Interchange), cap **12.12 m**
        Circular Quay    every polygon over the decks is `building=train_station`
                         -- the Cahill viaduct's own awnings -- cap **0.00 m**
        Milsons Point    one `building=yes` the size of the deck and a `roof`
                         over it: the platform canopy, cap **6.00 m**

    Without it the deconvolution is right and unusable: at Circular Quay it
    wants 15.6 m off the ground, because the estimator is correctly reporting
    that the CBD's towers are in the 60 m Gaussian's tail there. They are. But
    the ground under the Quay in this world is 35 m over its own harbour and
    every wharf, viaduct and hero landmark on it has been built to that, so a
    rule about a station's platforms may not be the thing that discovers it. The
    cap says: **a station is allowed to be as wrong as the roof over it, and no
    more.**
    """
    if not decks or not len(footprints):
        return 0.0
    total = float(sum(d.area for d in decks))
    if total <= 0.0:
        return 0.0
    tree = STRtree(list(footprints))
    mass = 0.0
    for deck in decks:
        for k in tree.query(deck, predicate="intersects"):
            k = int(k)
            if kinds[k] in RAILWAY_STRUCTURE:
                continue
            area = footprints[k].intersection(deck).area
            if area > 1.0:
                mass += area * float(heights[k])
    return mass / total


# --- The window ----------------------------------------------------------------


def _fetch_raw(bounds: tuple[float, float, float, float], zoom: int):
    """The *unsmoothed* terrarium mosaic covering an ENU box, and its pixel origin.

    `terrain._load_dem` smooths in place and hands back a raster the size of the
    whole build; this wants the raw pixels over a couple of hectares, so it goes
    to `terrain._fetch_tile` -- the same disk cache, the same decode -- rather
    than asking that function for something it does not offer. Nothing is
    downloaded that a build has not already fetched.
    """
    e0, n0, e1, n1 = bounds
    lon, lat = geo.enu_to_lonlat(
        np.array([e0, e1, e0, e1], dtype=np.float64),
        np.array([n1, n1, n0, n0], dtype=np.float64),
    )
    px, py = terrain._lonlat_to_pixel(lon, lat, zoom)
    x0, y0 = int(math.floor(px.min())) - 2, int(math.floor(py.min())) - 2
    x1, y1 = int(math.ceil(px.max())) + 2, int(math.ceil(py.max())) + 2
    tx0, ty0 = x0 // terrain.TERRARIUM_PIXELS, y0 // terrain.TERRARIUM_PIXELS
    tx1, ty1 = x1 // terrain.TERRARIUM_PIXELS, y1 // terrain.TERRARIUM_PIXELS
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    p = terrain.TERRARIUM_PIXELS
    raw = np.empty((ny * p, nx * p), dtype=np.float32)
    with requests.Session() as session:
        session.headers["User-Agent"] = "sydney-pipeline (github.com/sydney; bareearth.py)"
        for j in range(ny):
            for i in range(nx):
                raw[j * p : (j + 1) * p, i * p : (i + 1) * p] = terrain._fetch_tile(
                    session, zoom, tx0 + i, ty0 + j
                )
    np.maximum(raw, terrain.SEA_LEVEL, out=raw)
    return raw, (tx0 * p, ty0 * p)


def _pixel_enu(shape: tuple[int, int], origin_px: tuple[float, float], zoom: int, sub: int):
    """ENU coordinates of every sub-sample centre in a raster window.

    The inverse of `terrain._lonlat_to_pixel`, written out here because that
    function only goes one way and this is the only caller that needs the other.
    """
    h, w = shape
    step = 1.0 / sub
    xx, yy = np.meshgrid(
        np.arange(w * sub) * step + 0.5 * step, np.arange(h * sub) * step + 0.5 * step
    )
    n = float(terrain.TERRARIUM_PIXELS << zoom)
    lon = (xx + origin_px[0]) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * (yy + origin_px[1]) / n))))
    east, north = geo.lonlat_to_enu(lon.ravel(), lat.ravel())
    return east.reshape(lon.shape), north.reshape(lon.shape)


def built_mass(raw_shape, origin_px, zoom: int, footprints, heights) -> np.ndarray:
    """Coverage-weighted building height on the DSM's own pixel grid, metres.

    Coverage rather than a mask: a pixel a quarter covered by a 40 m building
    carries 10 m of built mass, because that is what a quarter of a 40 m roof
    did to the pixel when the source averaged over it. `SUBSAMPLE` decides how
    finely coverage is resolved and the maximum -- not the sum -- is taken where
    footprints overlap, so a `building:part` mapped over its own outline counts
    once.
    """
    east, north = _pixel_enu(raw_shape, origin_px, zoom, SUBSAMPLE)
    mass = np.zeros(east.size, dtype=np.float64)
    if len(footprints):
        pts = shapely.points(east.ravel(), north.ravel())
        pi, bi = STRtree(footprints).query(pts, predicate="intersects")
        if len(pi):
            np.maximum.at(mass, pi, np.asarray(heights, dtype=np.float64)[bi])
    h, w = raw_shape
    return mass.reshape(h, SUBSAMPLE, w, SUBSAMPLE).mean(axis=(1, 3))


# --- The corrected surface -----------------------------------------------------


class _BareField:
    """How many metres come off each post, and what the lattice reads there.

    **A drop, not a height, and the distinction is worth a paragraph.** The
    obvious shape is to hand `pads.conform` the corrected surface as an absolute
    target. It is wrong by about 0.2 m and always in the same way: the corrected
    raster is re-smoothed over this module's own window, while the lattice holds
    `_load_dem`'s smoothing of the whole extent, and `mode="nearest"` over
    different windows is not the same operator. Measured at Circular Quay, that
    disagreement is 0.18 m -- so a pass that had nothing to correct would still
    have moved the ground by a fifth of a metre, and the gate would have been
    proving that a rounding error stayed inside its zone. As a *subtraction* off
    what the lattice already says, a zero correction is exactly zero.
    """

    def __init__(self, drop, origin_px, zoom, sample, floor_world):
        self.drop = drop
        self.origin_px = origin_px
        self.zoom = zoom
        self.sample = sample
        self.floor_world = floor_world

    def __call__(self, east: np.ndarray, north: np.ndarray) -> np.ndarray:
        lon, lat = geo.enu_to_lonlat(
            np.asarray(east, dtype=np.float64), np.asarray(north, dtype=np.float64)
        )
        px, py = terrain._lonlat_to_pixel(lon, lat, self.zoom)
        d = np.asarray(
            terrain._bilinear(self.drop, px - self.origin_px[0], py - self.origin_px[1]),
            dtype=np.float64,
        )
        natural = np.asarray(self.sample(east, north), dtype=np.float64)
        return np.maximum(natural - d, self.floor_world)


def bare_field(zone: BaseGeometry, footprints, heights, zoom, base, cap, sample) -> _BareField:
    """The correction over one zone, as a callable in world metres.

    Three steps and the middle one is the whole idea: fetch the raw pixels over
    the zone plus `WINDOW_MARGIN_M`; take `BUILT_COEFF` times the built mass off
    them *before* smoothing, because that is the order the source added it in;
    smooth with `terrain.SMOOTH_SIGMA_M` exactly as `_load_dem` does, so the
    correction and the ground it is taken off are the same filter's output and
    the feather has no kink in it to hide.

    What comes out is the **difference** between the two smoothings, clipped to
    `[0, cap]`: never negative, because this rule takes buildings off the ground
    and does not put hills on it; never more than the roof over the platforms.

    The floor is measured on the **uncorrected** smoothed surface over a ring
    `FLOOR_RING_M` outside the zone -- ground this rule is not touching and
    therefore cannot argue itself down.
    """
    e0, n0, e1, n1 = zone.bounds
    m = WINDOW_MARGIN_M + FLOOR_RING_M
    raw, origin_px = _fetch_raw((e0 - m, n0 - m, e1 + m, n1 + m), zoom)
    mass = built_mass(raw.shape, origin_px, zoom, footprints, heights)
    sigma = terrain.SMOOTH_SIGMA_M / terrain._metres_per_pixel(config.ORIGIN_LAT, zoom)
    natural = ndimage.gaussian_filter(raw.astype(np.float64), sigma, mode="nearest")
    corrected = ndimage.gaussian_filter(
        raw.astype(np.float64) - BUILT_COEFF * mass, sigma, mode="nearest"
    )
    drop = np.clip(natural - corrected, 0.0, cap)

    # The floor: the lowest natural ground in the ring around the zone. Sampled
    # on the ring rather than over the whole window so that a window corner two
    # valleys away cannot licence a crater here.
    east, north = _pixel_enu(raw.shape, origin_px, zoom, 1)
    ring = zone.buffer(FLOOR_RING_M).difference(zone)
    on_ring = shapely.intersects(shapely.points(east.ravel(), north.ravel()), ring)
    floor = float(natural.ravel()[on_ring].min()) if on_ring.any() else float(natural.min())
    field = _BareField(drop, origin_px, zoom, sample, floor - base)
    field.floor = floor
    field.cap = cap
    return field


# --- The pass ------------------------------------------------------------------


def station_pads(radius_m: float, base_elevation: float, zoom: int, sample) -> list[pads.Pad]:
    """One `pads.Pad` per bridge-tagged station, targeting bare earth.

    The zone is `pads.bridge_station_zones` -- rule 1's own extent, so the two
    rules cannot disagree about which stations they are -- **unioned with every
    building footprint that intersects it**, per the brief and for the obvious
    reason: correcting the ground under half a shopping centre and leaving the
    other half on its roof puts a five metre step through the middle of it.

    Returns an empty list where there is no station to fire on, quietly. A rule
    about bridge-tagged stations has nothing to say about an extract without
    one, and the check is what notices a rule that fired on nothing.
    """
    zones = pads.bridge_station_zones(radius_m)
    if not zones:
        return []
    from .sources import osm

    buildings = osm.read_buildings(radius_m)
    polys = [Polygon(b.ring) for b in buildings]
    heights = [_height(b) for b in buildings]
    kinds = [b.building or "" for b in buildings]
    tree = STRtree(polys)

    out: list[pads.Pad] = []
    for sz in zones:
        touching = [int(k) for k in tree.query(sz.zone, predicate="intersects")]
        cap = roof_cap(
            sz.decks,
            [polys[k] for k in touching],
            [heights[k] for k in touching],
            [kinds[k] for k in touching],
        )
        if cap <= 0.0:
            # Nothing but the railway's own structure stands over these
            # platforms, so this rule has nothing to say about them. Recorded as
            # a zone with no pad rather than skipped in silence: a station that
            # drops out here is a station whose ground is still the DSM's, and
            # the check prints the line.
            continue
        grown = unary_union([sz.zone] + [polys[k] for k in touching])
        # The window's footprints are every polygon near it, not only the ones
        # inside the zone: the built mass 150 m away is what the 60 m Gaussian
        # carried into the middle, so leaving it out would take off the local
        # buildings and none of the bleed.
        near = [int(k) for k in
                tree.query(grown.buffer(WINDOW_MARGIN_M + FLOOR_RING_M), predicate="intersects")]
        field = bare_field(
            grown,
            [polys[k] for k in near],
            [heights[k] for k in near],
            zoom,
            base_elevation,
            cap,
            sample,
        )
        out.append(
            pads.Pad(
                name=sz.name,
                kind="bare-earth",
                zone=grown,
                target=field,
                note={
                    **sz.note,
                    "roof_cap_m": round(cap, 2),
                    "footprints_absorbed": len(touching),
                    "footprints_in_window": len(near),
                    "floor_ahd": round(field.floor, 2),
                    "floor_world": round(field.floor - base_elevation, 2),
                },
            )
        )
    return out


def skipped_zones(radius_m: float) -> list[tuple[str, float]]:
    """The bridge-tagged stations this rule declines, and their cap.

    Cheap enough to recompute and worth printing: a rule that fires on one of
    three stations should say which two it left alone and why, or the day one of
    them stops being left alone is a day nobody notices.
    """
    from .sources import osm

    zones = pads.bridge_station_zones(radius_m)
    if not zones:
        return []
    buildings = osm.read_buildings(radius_m)
    polys = [Polygon(b.ring) for b in buildings]
    tree = STRtree(polys)
    out = []
    for sz in zones:
        k = [int(i) for i in tree.query(sz.zone, predicate="intersects")]
        cap = roof_cap(sz.decks, [polys[i] for i in k], [_height(buildings[i]) for i in k],
                       [buildings[i].building or "" for i in k])
        out.append((sz.name, cap))
    return out
