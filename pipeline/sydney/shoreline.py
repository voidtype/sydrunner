"""The one place the DSM is asked how high a shore is allowed to be.

`water.py` cuts a bed under every mapped body and then **holds the land at the
waterline** -- and the hold is a `np.maximum`. It can raise a post to sea level
and it can never lower one, because it was written against the failure it could
see: dry ground *under* the sea. The opposite failure was there the whole time
and nothing in the pipeline was looking at it. Measured on the 5.3 km ring, on
a transect down the middle of Sydney Cove at east 140:

    N   the ground, as it ships (m AHD)      in life
    900   -1.46                                 --    inside Sydney Cove; the
                                                      bed `water.conform` cut
    860   14.80                                ~2.5   the Quay promenade
    820   32.06                                ~2.5   behind the seawall
    780   33.96                                ~4     Alfred Street
    680   43.14                                ~6     under the Cahill deck,
                                                      which is itself ~20

**Thirty metres.** RAIL-VERTICAL.md section 3c named it -- *"the Quay's ground
in this build stands 35 m over its own harbour"* -- and left it, because the rule
that had found it was a rule about a station's platforms and a station rule is
not allowed to restructure a precinct. This module is the rule that is allowed
to, because it is a rule about the shore.

---------------------------------------------------------------------------
## Where the thirty metres comes from, in the order it is added

Measured post by post on the same transect at east 140, north 820 -- the Quay
promenade, thirty-two metres behind the waterline, ~2.5 m AHD in life:

    raw terrarium pixel                          12.50 m AHD    +10.0
    the 60 m Gaussian                            17.81           +5.3
    `bareearth`, roof-capped at 0.45 m           17.37           -0.45
    `roadgrade.solve` + `conform`                28.50          +11.1
    `water.conform`                              28.50           0.00
    `pads.station_pads` (rule 1, Circular Quay)  32.06           +3.6

Four of those five are worth a sentence each, because between them they are the
answer to "which of these is wrong".

**(a) The tile itself is wrong, by about ten metres, and it is the largest
single term.** The raw 15.87 m terrarium pixel over the promenade reads 12.50 m
and its neighbours over the wharves read 9 to 15. There is no promenade in this
DSM: at that ground sample distance the Quay's own block, the Cahill deck, the
ferry terminal roofs and the AMP building are the ground. This is not a
smoothing artefact and no kernel removes it.

**(b) The Gaussian adds five metres more, not fifteen.** 12.50 raw against
17.81 smoothed is what the CBD's towers are worth at the Quay through a 60 m
kernel, and it is the smaller half of the DSM's error rather than the larger.
`terrain.py`'s own note is right that the contaminated patch is 1.5 km across
and wider than any kernel that leaves a landform standing; what it did not say
is that the patch *reaches the water*, because the last block of it is built to
the harbour's edge.

**(c) The water conform does not pull the promenade down, and could not.** Its
`hold` term is `np.maximum(out, hold)` with `hold` at sea level, so on a post
already 28 m up it is a no-op -- 0.00 m on this transect, at north 840 which is
12.8 m from the waterline and well inside `water.FEATHER_OUT_M`. That is not a
bug in `water.py`. A one-sided hold is the correct shape for the question that
module asks. It is the wrong shape for this one, and this is the other side.

**(d) `roof_cap` is right to refuse, and refusing is what left the hole.**
`bareearth`'s deconvolution wants 15.6 m off the Quay and RAIL-VERTICAL.md
section 3b caps it at 0.45 m -- the coverage-weighted height of the buildings
over Circular Quay's own platform decks, which are `building=train_station`
awnings. That cap is correct *for a station rule*: a station may be as wrong as
the roof over it and no more. It is the wrong bound for a shore, because what is
wrong at the Quay is not the roof over the platforms, it is the shore.

**And the largest term is not the DSM at all.** `roadgrade.solve` adds eleven
metres. The street network is solved under a grade clamp from ground that stands
at 40 to 55 m AHD across the CBD, so the solved profile cannot fall to the
harbour in the three hundred metres it has, and `roadgrade.conform` then pulls
the lattice onto it. The CBD's contamination is *delivered* to the foreshore by
the road solve, and rule 1 then reads those streets and adds 3.6 m more on top
at Circular Quay. That is why this pass runs **before** the road solve and not
after it: `bareearth.py`'s ordering argument, word for word -- the authority has
to be corrected before it is consulted.

---------------------------------------------------------------------------
## The rule

> **A shore may not stand higher over the water than a shore stands, and it may
> not be pulled down by more than there is building on it.**
>
> Within `SHORE_REACH_M` of mapped **tidal** water, the lattice is pulled toward
> `SURFACE_AHD + PROMENADE_AHD` by a weight that is one at the waterline and
> zero at the reach; and the result is floored at the smoothed DSM with the
> built mass deconvolved out of it. Never upward. Never past that floor.

    d   = metres to the nearest mapped tidal waterline, zero inside it
    u   = clip(d / SHORE_REACH_M, 0, 1)
    w   = 1 - (3u^2 - 2u^3)
    new = min( natural,
               max( natural + w * ((sea + PROMENADE_AHD) - natural),
                    natural - built_drop ) )

**Both halves are load-bearing and each one's failure mode is the other's
reason.** The pull alone flattens every real rock shelf on the harbour: at Mrs
Macquaries Point the natural ground reaches 4.58 m AHD *at the waterline* and
6.78 m ten metres in, and a pull to 3.0 m takes 1.6 and 3.7 m of real sandstone
off. The floor alone is `bareearth`'s estimator unbounded, which section 3b
already measured as right and unusable. Together:

    probe                             d(water)  natural    new     move
    Quay promenade (E140 N820)            32     17.81    6.34   -11.48
    Kirribilli (E400 N2480)              183     35.39   32.99    -2.40
    Dawes Point / The Rocks (E-60 N1440)  38     15.99   13.72    -2.26
    Balmain East headland                  0      8.94    8.71    -0.23
    Mrs Macquaries Pt, at the waterline    0      4.58    4.58     0.00
    Mrs Macquaries Pt, 10 m in            11      6.78    6.78     0.00
    Centennial Park (no water, control)  971     52.76   52.76     0.00

The discriminator is not a classification and not a footprint mask -- it is a
measurement, per post, continuous: **how much building is the DSM looking at
here.** A headland has none and the floor collapses onto `natural`, so the pass
declines it outright. A quay is covered in it. That is rule 1 of
RAIL-VERTICAL.md read for the ground instead of for the railway: measure the
relationship, do not classify it.

**Why the built mass rather than "outside any building footprint".** The brief
that asked for this pass offered a footprint mask, and `bareearth.py` already
recorded why a mask is the wrong instrument: half a building's ground corrected
and the other half not is a step through a wall, and at 15.87 m a pixel no roof
owns a pixel anyway. The deconvolution has no polygon boundary to step across
and no hole to fill. It also gives the *right* answer at a place a mask gets
exactly backwards -- the Quay promenade itself, which carries no footprint and
is nonetheless thirty metres wrong, because the mass the Gaussian carried onto
it belongs to the block behind.

**Why there is no step at the reach.** At `d = SHORE_REACH_M`, `w` is zero, so
the pull term is `natural` and the `max` against `natural - built_drop` returns
`natural` -- the pass writes nothing, by construction rather than by a feather.
That is what buys the freedom to have no reach *feather* at all: `pads.py`'s one
cell would be a 27% ramp here, because at the Quay the correction is still ten
metres deep two hundred metres inland and a rule that stops abruptly there
leaves a cliff. What it costs instead is grade *inside* the band, and that is
measured rather than argued: `shoreline-check.py` section 4 prints the extra
gradient this pass puts into the lattice, p50/p95/max. At 250 m it is p95 1.86%
and max 14.94% over the 8,557 cells that got steeper, in a band whose p95 grade
was already 19.98%.

---------------------------------------------------------------------------
## What it does not buy, which is most of it, and where the rest went

**The pass writes 11.48 m at the Quay promenade and the build keeps 5.63.** That
is not a rounding loss and it is the finding this round turned up, so it is
stated here rather than discovered again later. Measured on the transect, dry
land only, over every station the pass wrote more than a metre to: the median
**kept / written is 0.41**.

The mechanism is `roadgrade._lipschitz`, and its own docstring is the argument
against it:

> *"cutting a spike down (low) and filling the valleys either side of it up
> (high) are both legal answers and the truth is between them"*

It returns the average of a downward projection and an upward one. That is the
right operator for an error of unknown sign. **This error has a sign.**
`roadgrade.OPENING_M`'s note says so two hundred lines earlier -- *"contamination
is always upward"* -- and so does `bareearth.BUILT_COEFF`'s, and so does this
module's own `np.minimum(natural, ...)`. So when the shore comes down eleven
metres and the CBD three hundred metres away stays at fifty, the `CROSS_GRADE`
tie chain is violated, the low projection pulls the CBD down, the high
projection pulls the shore back up, and the average splits an error that is
entirely the CBD's evenly between the two. Measured at the Quay: the solved
street nearest east 140 north 820 goes 31.31 -> 25.63 m AHD, a 5.68 m fall for
an 11.5 m correction, and it stands 20 m above its own ground.

**So this pass is necessary and it is not sufficient**, and the two things that
would finish it are both already named in other files' headers:

  * **the city-wide deconvolution** -- `terrain.py`'s standing follow-up and
    `bareearth.py`'s ("applying it city-wide is still the follow-up; what exists
    is the narrowest version"). `SHORE_REACH_M`'s table is what it is worth:
    at a 900 m reach this rule *becomes* that pass and takes eleven metres off
    Town Hall, which is roughly the error `terrain.py` records there.
  * **a Lipschitz projection that knows its error has a sign.** One-sided where
    the observation is a surface model over a city, symmetric elsewhere. That is
    a change to every street in Sydney and it belongs to whoever owns
    `roadgrade.py`, with `road-grade-audit` as its gate.

**The last few metres at the Quay, even before the road solve takes its half.**
The pass's own write comes out at 6.34 m AHD on the promenade against 2.5 in
life, because the built-mass floor binds there and it is the conservative bound
on purpose. That remainder is `BUILT_COEFF`'s -- `bareearth.py`'s header says the
estimator under-corrects by about two and a half at the one place the truth is
written down, and 1.0 is the side of that a subtraction from the ground has to
be on.

**The deck of anything.** A viaduct in the rail bake is
`terrain.sample(...) + rail.BRIDGE_RISE` -- an offset from the ground beneath
it, not a structure on its own piers -- so every metre this pass takes off the
Quay, the Cahill's deck gives up too, and only what the 3.3% grade cone pulls
back from approaches that did not move survives. RAIL-VERTICAL.md sections 3b
and 3c both end on that sentence and it is still true. The clearance arithmetic
is in section 3d.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import shapely
from scipy import ndimage
from shapely.geometry.base import BaseGeometry

from . import bareearth, config, geo, terrain

# --- The constants, each with the measurement that chose it --------------------

# How far inland the rule reaches, metres.
#
# **This is the one free parameter and it is a scope choice, not a physical
# one.** The built-mass floor is the active constraint at 87% of the posts this
# pass writes, so what the reach decides is not how the rule behaves but how much
# of the city it is allowed to behave on. Swept on the 5.3 km ring with every
# other pass on, four reaches against the two things that matter -- the Quay's
# ground, and how far the correction spills into a CBD this rule is not about:
#
#   reach   Quay promenade   Alfred St   Sydney Tower   Town Hall   Centennial Pk
#           (E140 N820)      (N780)      base_y         ground      (control)
#    off        32.06         33.96          71.89        70.21        51.85
#   250 m       26.42         28.27          70.00        69.62        51.85
#   400 m       24.43         26.08          69.87        69.57        51.85
#   600 m       17.23         18.74          69.22        69.45        51.85
#   900 m       14.30         15.30          57.78        58.91        51.82
#             (~2.5 in life) (~4 in life)
#
# The 900 m row is not this rule. It is `terrain.py`'s standing follow-up -- the
# city-wide deconvolution -- arriving under a shore rule's name, and it takes
# eleven metres off Town Hall, which is the one place in the extent where the
# truth is written down and where an eleven-metre move deserves its own round and
# its own gate rather than being a side effect of a reach.
#
# 250 m is where every post the rule writes can still be called a shore. It buys
# the least of the four and it is the only one of the four whose blast radius is
# a sentence: the deepest thing it touches is the block behind the seawall. 600 m
# is the tempting row and it is the one to take *next*, with the CBD's landmarks
# gated at 20 km first -- Sydney Tower moves 2.7 m in that row, and this round
# cannot run the audit that would clear it.
#
# What it costs in gradient, which is the other thing a reach trades and the only
# thing this can get wrong that nothing else in the build would catch: measured
# at 250 m over the 8,557 lattice cells in the band that got steeper, p50 0.12%,
# p95 1.86%, max 14.94% -- against a band whose p95 grade was already 19.98%.
SHORE_REACH_M = 250.0

# The height a promenade stands over the water it fronts, metres AHD.
#
# Three in life at Circular Quay and three to four at the Opera House forecourt,
# which is the pair of numbers this whole pass exists for. It is also clear of
# both numbers `water.py` owns: `SHORE_CLEARANCE_M` is 0.4 and `TIDAL_MARGIN_M`
# is 2.0, so a post pulled to a promenade never lands inside the band that
# module decides tidality in and the two rules cannot argue.
PROMENADE_AHD = 3.0

# --- The record ---------------------------------------------------------------


@dataclass(frozen=True)
class ShoreRecord:
    """What the pass was, once the heights are written.

    Kept on `Terrain.shore` for the same reason `pads.PadRecord` is kept on
    `Terrain.pads`: the gate has to test the geometry the pass *used*, not a
    reconstruction of it. `shoreline-check.py` is the only reader; everything in
    the build wants `sample`, where the correction already is.
    """

    geom: BaseGeometry  # the mapped tidal water the band is measured from
    reach_m: float
    promenade_ahd: float
    stats: dict


# --- The two fields -----------------------------------------------------------


def tidal_geometry(radius_m: float, sample, sea_level_y: float) -> BaseGeometry | None:
    """Every mapped **tidal** body in the extent, as one geometry.

    Read through `water.load`, which is the one reader of the coastline and the
    OSM water polygons in this pipeline, and then filtered to `lvl.tidal`. Ponds
    are excluded and that is the same distinction `water.conform` draws for its
    own hold: a pond is held up by its own bank and the land downhill of it is
    legitimately below its surface, so a rule that pulls ground toward a water
    level has nothing to say about one.

    **This costs a second `water.load`, and the cost is stated rather than
    hidden.** The build already runs one, after the road solve, and that is the
    field `water.conform` cuts the bed with. This pass runs *before* the road
    solve and therefore cannot have it. Hoisting the single load earlier was the
    alternative and it was refused: a pond's surface is `BODY_QUANTILE` of the
    terrain inside it, so reading the water before the roads would move every
    pond in the world to answer a question about the harbour. Two reads of the
    same file is the cheaper mistake. Measured at 5.3 km: 7.4 s.
    """
    from . import water as water_module

    field = water_module.load(radius_m, sample, sea_level_y)
    tidal = [lvl.geom for lvl in field.levels if lvl.tidal]
    if not tidal:
        return None
    geom = shapely.union_all(tidal)
    return None if geom.is_empty else geom


def built_drop(radius_m: float, zoom: int, geom: BaseGeometry, band_m: float):
    """`bareearth`'s deconvolution, over the band along a shore. Metres, ≥ 0.

    The same three steps and the same functions -- `bareearth._fetch_raw`,
    `bareearth.built_mass`, `terrain.SMOOTH_SIGMA_M` -- so there is one estimator
    in this pipeline and not two that agree today. What differs is only the
    window: `bareearth` takes a couple of hectares around a station and this
    takes a strip along a hundred and fifty kilometres of coastline.

    **The built mass is rasterised only on the pixels inside the band**, and
    that restriction is the whole reason this is affordable. `built_mass` costs
    `SUBSAMPLE**2` point-in-polygon tests a pixel; over the whole 5.3 km extent
    that is 16.8 M points, and over a 60 km one it is a billion. Inside the
    band it is 315,407 pixels at 5.3 km -- 30% of the extent, because at this
    radius almost everything is near the harbour -- and 5.0 M subsample tests,
    which run in two seconds. The *smoothing* is over the whole window either
    way, and has to be: a 60 m Gaussian reads 180 m past its own support, so a
    band-shaped raster smoothed in isolation would be filtered against its own
    clamped edge and the correction at the band's inner lip would be wrong by
    the built mass just outside it. Zero outside the band is the right fill and
    not a compromise: it is what "no building here" means to this estimator, and
    everything within `WINDOW_MARGIN_M` of the band that does carry mass is
    inside the band, because the band is grown by that margin before the mask
    is taken.

    Returns `(drop, origin_px)` -- the raster and its global pixel origin, ready
    for `terrain._bilinear`.
    """
    from . import water as water_module
    from .sources import osm

    m = bareearth.WINDOW_MARGIN_M
    raw, origin_px = bareearth._fetch_raw(
        (-radius_m - m, -radius_m - m, radius_m + m, radius_m + m), zoom
    )
    east, north = bareearth._pixel_enu(raw.shape, origin_px, zoom, 1)
    dist = water_module._shore_distance(
        shapely.points(east.ravel(), north.ravel()), geom.boundary, band_m + m, True
    )
    near = np.isfinite(dist).reshape(raw.shape)
    near |= shapely.contains_xy(geom, east, north)

    buildings = osm.read_buildings(radius_m)
    polys = [shapely.Polygon(b.ring) for b in buildings]
    heights = np.array([bareearth._height(b) for b in buildings], dtype=np.float64)

    mass = np.zeros(raw.shape, dtype=np.float32)
    rows, cols = np.where(near)
    if len(rows) and polys:
        sub = bareearth.SUBSAMPLE
        off = (np.arange(sub) + 0.5) / sub
        du, dv = np.meshgrid(off, off)
        n_tot = float(terrain.TERRARIUM_PIXELS << zoom)
        xx = cols[:, None, None] + du[None, :, :]
        yy = rows[:, None, None] + dv[None, :, :]
        lon = (xx + origin_px[0]) / n_tot * 360.0 - 180.0
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * (yy + origin_px[1]) / n_tot))))
        se, sn = geo.lonlat_to_enu(lon.ravel(), lat.ravel())
        flat = np.zeros(se.size, dtype=np.float64)
        pi, bi = shapely.STRtree(polys).query(shapely.points(se, sn), predicate="intersects")
        if len(pi):
            np.maximum.at(flat, pi, heights[bi])
        mass[rows, cols] = flat.reshape(len(rows), sub * sub).mean(axis=1).astype(np.float32)

    sigma = terrain.SMOOTH_SIGMA_M / terrain._metres_per_pixel(config.ORIGIN_LAT, zoom)
    natural = ndimage.gaussian_filter(raw, sigma, mode="nearest")
    corrected = ndimage.gaussian_filter(raw - bareearth.BUILT_COEFF * mass, sigma, mode="nearest")
    drop = np.clip(natural - corrected, 0.0, None)
    return drop, origin_px, int(near.sum()), float(drop.max())


# --- The pass ------------------------------------------------------------------


def weight(dist: np.ndarray, reach_m: float) -> np.ndarray:
    """One at the waterline, zero at the reach, smoothstep between.

    `1 - smoothstep(u)` rather than `1 - u`, for `water.conform`'s reason at its
    own feather: a linear weight is C0 and puts a crease along the band's inner
    and outer lips, and there is nothing else in this pass to hide one behind.
    """
    u = np.clip(dist / reach_m, 0.0, 1.0)
    return 1.0 - (u * u * (3.0 - 2.0 * u))


def conform(
    heights: np.ndarray,
    p0: int,
    q0: int,
    spacing: float,
    radius_m: float,
    base_elevation: float,
    zoom: int,
    sample,
    record: list,
) -> dict:
    """Pull the shore down to the water it fronts. In place.

    `heights[qi, pi]` is the post at east `(p0 + pi) * spacing`, north
    `(q0 + qi) * spacing` -- `terrain._Lattice`'s layout, taken apart here so
    this module needs nothing from that one, exactly as `roadgrade.conform` and
    `water.conform` do.

    Post-major and vectorised over the whole lattice at once, which is
    `water.conform`'s shape and right for the same reason: the geometry is a
    handful of very large polygons and the posts are millions. The distance is
    `water._shore_distance` unchanged -- an STRtree over the boundary's parts,
    `+inf` past the reach -- so a post outside the band pays a logarithmic query
    and nothing else, and the two modules cannot disagree about how far from the
    water a post is.
    """
    sea = -base_elevation
    geom = tidal_geometry(radius_m, sample, sea)
    if geom is None:
        return {"posts": int(heights.size), "moved": 0, "skipped": "no tidal water"}

    q_n, p_n = heights.shape
    east = (np.arange(p_n) + p0) * spacing
    north = (np.arange(q_n) + q0) * spacing
    grid_e = np.repeat(east[None, :], q_n, axis=0).ravel()
    grid_n = np.repeat(north[:, None], p_n, axis=1).ravel()

    from . import water as water_module

    dist = water_module._shore_distance(
        shapely.points(grid_e, grid_n), geom.boundary, SHORE_REACH_M, True
    )
    # Inside the water is distance zero, not distance-to-boundary: a post under
    # a wharf that the DSM reads at twelve metres is as wrong as the promenade
    # beside it, and `water.conform` will cut its bed afterwards either way.
    dist = np.where(shapely.contains_xy(geom, grid_e, grid_n), 0.0, dist)
    band = np.isfinite(dist)
    if not band.any():
        return {"posts": int(heights.size), "moved": 0, "skipped": "no post near tidal water"}

    drop_r, origin_px, band_px, drop_max = built_drop(radius_m, zoom, geom, SHORE_REACH_M)
    lon, lat = geo.enu_to_lonlat(grid_e[band], grid_n[band])
    px, py = terrain._lonlat_to_pixel(lon, lat, zoom)
    bd = np.asarray(
        terrain._bilinear(drop_r, px - origin_px[0], py - origin_px[1]), dtype=np.float64
    )

    flat = heights.reshape(-1).astype(np.float64)
    natural = flat[band]
    w = weight(dist[band], SHORE_REACH_M)
    pulled = natural + w * ((sea + PROMENADE_AHD) - natural)
    new = np.minimum(natural, np.maximum(pulled, natural - bd))

    moved = natural - new
    flat[band] = new
    heights[:] = flat.reshape(heights.shape).astype(heights.dtype)

    hit = moved > 0.0
    stats = {
        "posts": int(heights.size),
        "in_band": int(band.sum()),
        "moved": int(hit.sum()),
        "p50": float(np.percentile(moved[hit], 50)) if hit.any() else 0.0,
        "p95": float(np.percentile(moved[hit], 95)) if hit.any() else 0.0,
        "max": float(moved.max()) if moved.size else 0.0,
        "pull_bound": int((hit & (new >= natural - bd - 1e-9) & (new <= pulled + 1e-9)).sum()),
        "floor_bound": int((hit & (new > pulled + 1e-9)).sum()),
        "band_pixels": int(band_px),
        "built_drop_max": round(drop_max, 3),
        "reach_m": SHORE_REACH_M,
        "promenade_ahd": PROMENADE_AHD,
    }
    record.append(ShoreRecord(geom, SHORE_REACH_M, PROMENADE_AHD, dict(stats)))
    return stats
