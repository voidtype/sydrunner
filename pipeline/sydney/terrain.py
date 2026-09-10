"""Ground elevation: the DEM, the datum, and the surface everything else sits on.

The world was a pancake. Sydney is not: Surry Hills stands 40 m over Alexandria,
Newtown's King Street runs along a ridge, and the ground falls away to nothing at
Blackwattle Bay. A flat city reads as a test grid no matter how good the facades
are, so this module produces one number -- ground height at a point -- and every
other module in the pipeline drapes onto it.

**Source: AWS Terrain Tiles, Mapzen terrarium encoding.** Free, no key, no auth,
plain HTTPS, and cached on disk like every other source:

    https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
    elevation = (R * 256 + G + B / 256) - 32768   metres

Zoom 13 is 15.9 m a pixel at Sydney's latitude, so the whole 15 km extent is
about sixty 256-pixel PNGs -- a few megabytes, fetched once.

ELVIS' 1 m LiDAR DEM is the real answer and it has no API (see the README). When
it arrives, **only `_load_dem` has to change**: everything downstream consumes
`Terrain.sample`, the lattice below is resampled from whatever the DEM gives, and
a finer source would let `SMOOTH_SIGMA_M` come down to near zero. Nothing about
the tile format, the sidecar, or the client depends on the source resolution.

---------------------------------------------------------------------------
Three decisions carry the module.

**Smoothing is a 60 m Gaussian, not the 3x3 box this started as, and the number
was measured.** Terrarium over a city is a *surface* model, not a bare-earth one:
the returns come off roofs. Raw, the inner ring's post-to-post gradient is 1:11.5
at the median and 1:4.7 at p90, which is not terrain -- it is the edges of
buildings, and a street draped on it climbs and drops a storey a block. A 3x3 box
(one pass, 48 m of support at this pixel size) moves p90 to 1:4.9, which is to
say it does nothing: building blocks are 60-150 m across, not 30.

A Gaussian is the width that separates the two signals, because attenuation is
exp(-2 pi^2 sigma^2 / lambda^2) and the two live a decade apart in wavelength.
Sigma was then chosen against the thing that has to come out right, which is the
gradient of the roads -- sampled every 10 m along all 89,049 points of the inner
ring's centrelines, since roads run in the gaps between the buildings where this
DEM is at its worst:

    sigma     median     p90     p99   over 1:6   Obs Hill   Blackwattle   relief
      raw*   1: 14.5   1: 5.8  1: 3.1     10.9%      37.2 m         9.2 m   40.4 m
      45 m   1: 16.1   1: 6.6  1: 3.7      7.8%      35.7 m        10.6 m   40.2 m
    > 60 m   1: 17.7   1: 7.3  1: 4.3      5.4%      34.4 m        11.9 m   39.7 m
      75 m   1: 19.1   1: 8.0  1: 4.9      3.4%      33.2 m        13.2 m   39.1 m
      95 m   1: 21.1   1: 8.9  1: 5.5      1.7%      31.5 m        14.6 m   38.2 m
    (* sigma 30 m, the least that removes single-pixel noise at all.)
    Observatory Hill is 40 m in life, Blackwattle Bay's shore about 3 m, and the
    relief column is Crown Street over Alexandria, about 32 m in life.

Two things decide it. The **relief this module exists to deliver is free**: it
moves 2 m across the whole range, so nothing in the choice is a trade against the
hills. What sigma actually trades is road noise against the coastline, and 60 m
is the knee: it halves the share of road steeper than 1:6 against sigma 45, puts
p90 at 1:7.3 -- which is about the steepest Sydney really gets -- and gives up
1.3 m at the shore to do it. Past there the returns flatten and the losses do
not: 75 m costs another 1.3 m of shoreline and starts eating Observatory Hill,
which is a real 250 m landform and not noise.

The coastline is the cost either way, and it is worth naming. A Gaussian does not
know where the water is, so it pulls the shore up by averaging the hill behind
it. That is the right way round for this world: nothing is rendered on the water,
and every street in the extent is on land.

**The datum is the origin's own ground.** `BASE_ELEVATION` is the smoothed
elevation at the ENU origin, and every sample has it subtracted, so world y is
metres above the ground at Town Hall rather than metres above AHD. That keeps the
existing spawn heights, eye height and jump arcs meaningful, and keeps the whole
world inside +/-100 m of zero instead of sitting on a 30 m pedestal.

It reads high -- around 70 m against a true ~28 m AHD -- for the same reason the
raw gradients do: the CBD is 1.5 km of 200 m towers and the DEM is looking at the
tops of them. That is an *offset*, and an offset is the one error a datum cannot
be hurt by: every relative height in the world is correct, and a bare-earth DEM
would move this number without moving anything else. The CBD's own contamination
is not an offset and is not fixed here -- see the follow-up note at the bottom.

**The lattice is the surface, and it is global.** Heights are precomputed on one
lattice of `config.TERRAIN_GRID` posts per tile, aligned to the ENU origin, and
`sample` interpolates *that* rather than the DEM. Two consequences, both of them
the point:

  * Two tiles that share an edge read the same lattice elements, so their shared
    posts are bit-identical by construction rather than by two computations
    agreeing. Cracks between tiles are impossible, not merely unlikely.
  * `sample` returns exactly what the client's terrain mesh draws, down to which
    diagonal each cell is split along. A street vertex placed at
    `sample(...) + 0.02` is 2 cm above the rendered ground and not 2 cm above a
    DEM the renderer has never seen, so it can neither sink into a valley nor
    float over a ridge.

**And the streets are levelled into the lattice before anyone sees it.** The last
step of `load` hands the lattice to `roadgrade.py`, which solves a grade-limited
elevation for every street in the extent and then pulls the ground onto it under
every road corridor. It is not a filter and it is not optional for a shipped
world: the follow-up note at the bottom of this file explains why a surface
model cannot say where a road is, and that module is the answer to it. Read it
before changing anything here -- the smoothing sigma, the post spacing and the
datum below are all inputs to it.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import numpy as np
import requests
from PIL import Image
from scipy import ndimage

from . import config, geo

# --- Source ------------------------------------------------------------------

TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# 15.9 m a pixel at latitude 33.87 south. Zoom 14 is 8 m and four times the
# download for detail this smoothing throws away again; zoom 12 is 32 m, which is
# coarser than the lattice this feeds.
TERRARIUM_ZOOM = 13
TERRARIUM_PIXELS = 256

# Standard deviation of the pre-sampling Gaussian, metres. See the header for the
# measured table this comes out of.
SMOOTH_SIGMA_M = 60.0

# How far past the build radius to fetch and smooth. Three sigma of the kernel
# plus a tile, so the lattice's outermost post is filtered against real data
# rather than against an edge-clamped repeat of itself.
FETCH_MARGIN_M = 3.0 * SMOOTH_SIGMA_M + config.TILE_SIZE

# Terrarium encodes ocean as a small negative number rather than as no-data.
# Clamped up rather than kept, because what the encoding means there is "no
# soundings", not "the bed is 40 cm down": it is a land DEM and the harbour is
# simply outside it.
#
# The clamp is therefore the *datum* for the water rather than a bed, and it used
# to be the end of the story -- nothing was drawn on the harbour at all. It no
# longer is: `water.py` cuts a real bed under every mapped body after this,
# because a surface clamped to exactly 0 m AHD is coplanar with a water plane at
# 0 m AHD, and twenty square kilometres of z-fight is not a seascape.
SEA_LEVEL = 0.0

EARTH_RADIUS = 6378137.0


def post_spacing() -> float:
    """Metres between lattice posts. 500 / 16 = 31.25, exactly representable."""
    return config.TILE_SIZE / config.TERRAIN_GRID


# --- Web Mercator ------------------------------------------------------------
# `geo.lonlat_to_tile_xy` already does this at integer resolution for Microsoft's
# quadkeys. Terrarium needs sub-pixel positions, so the fractional form lives
# here rather than being bolted onto that one.


def _lonlat_to_pixel(lon, lat, zoom: int):
    """Geodetic -> global Web Mercator pixel coordinates at `zoom`."""
    n = float(TERRARIUM_PIXELS << zoom)
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    s = np.sin(np.radians(np.clip(np.asarray(lat), -85.05112878, 85.05112878)))
    y = (0.5 - np.log((1.0 + s) / (1.0 - s)) / (4.0 * math.pi)) * n
    return x, y


def _metres_per_pixel(lat: float, zoom: int) -> float:
    circumference = 2.0 * math.pi * EARTH_RADIUS * math.cos(math.radians(lat))
    return circumference / float(TERRARIUM_PIXELS << zoom)


# --- Download and decode -----------------------------------------------------


def _cache_path(zoom: int, tx: int, ty: int):
    return config.CACHE_DIR / "terrarium" / str(zoom) / f"{tx}_{ty}.png"


def _fetch_tile(session: requests.Session, zoom: int, tx: int, ty: int) -> np.ndarray:
    """One 256x256 terrarium tile as metres, cached on disk.

    A tile that 404s comes back as sea rather than raising. The extent's bounding
    box is a rectangle and the dataset's coverage is not, so asking for a tile
    that is entirely ocean is a normal thing to do, not an error.
    """
    path = _cache_path(zoom, tx, ty)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        resp = session.get(TERRARIUM_URL.format(z=zoom, x=tx, y=ty), timeout=120)
        if resp.status_code == 404:
            return np.full((TERRARIUM_PIXELS, TERRARIUM_PIXELS), SEA_LEVEL, dtype=np.float32)
        resp.raise_for_status()
        path.write_bytes(resp.content)

    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return rgb[:, :, 0] * 256.0 + rgb[:, :, 1] + rgb[:, :, 2] / 256.0 - 32768.0


# --- The terrain -------------------------------------------------------------


@dataclass(frozen=True)
class _Lattice:
    """Precomputed heights on the global post grid, in metres above the datum.

    `heights[qi, pi]` is the post at ENU east = (p0 + pi) * spacing,
    north = (q0 + qi) * spacing. Stored north-ascending with `qi`, which is the
    pipeline's ENU convention; `grid_for_tile` is what flips it into the
    renderer's north-to-south row order.
    """

    heights: np.ndarray  # (Q, P) float32
    p0: int
    q0: int
    spacing: float


class Terrain:
    """Ground height over the build extent.

    Construct with `Terrain.load(radius_m)`. Every consumer wants `sample`.
    """

    def __init__(self, lattice: _Lattice, base_elevation: float, dem_stats: dict) -> None:
        self._lat = lattice
        self.base_elevation = base_elevation
        self.stats = dem_stats
        # The solved street network this surface was conformed to, when it was.
        # Nothing in the build reads it -- the roads are already *in* the lattice
        # by the time anything drapes on it -- but the audit needs to be able to
        # ask what the solve wanted as well as what the ground ended up doing.
        self.road_surface = None
        # The water this surface has a bed cut in for, when it has. Unlike the
        # road surface above, this one *is* read by the build: `tiles.build_tile`
        # asks it for the sheets to draw, because the polygons that decided where
        # the bed went are the same polygons the water is drawn on. Two sources
        # for where the harbour is would be one too many.
        self.water = None
        # The stated pads this surface was levelled under, when it was: one
        # `pads.PadRecord` each, carrying the water-clipped geometry the pass
        # wrote inside and the height it wrote. Two readers, and they are the
        # only two. `terrain-rules-check.py`'s gate asks for the geometry,
        # because a check that rebuilds the zones is checking a different rule
        # from the one that ran; and `landmarks.stated_pad` asks for the height,
        # because a landmark levelled to a pad must build on that pad and not on
        # a re-reading of it through one cell of harbour. Everything else in the
        # build wants `sample`, where the pads already are.
        self.pads = []
        # The bare-earth zones this surface had the built mass taken off, when it
        # did: one `pads.PadRecord` each, from `bareearth.station_pads`. Kept
        # apart from `self.pads` rather than folded into it, because that list
        # has two named readers and one of them -- `landmarks.stated_pad` --
        # looks a record up by *name*, and a bare-earth zone carries the same
        # name as the rule 1 pad over it. Only `bare-earth-check.py`'s gate reads
        # this one; everything in the build wants `sample`, where the correction
        # already is.
        self.bare_earth = []
        # The shoreline pass's record, when it ran: one `shoreline.ShoreRecord`,
        # carrying the mapped tidal water the band was measured from and the two
        # constants that shaped it. Kept apart from the two lists above for the
        # same reason they are kept apart from each other -- it is not a pad, it
        # has no name to look up, and its one reader is `shoreline-check.py`'s
        # gate, which has to test the geometry the pass used rather than a
        # reconstruction of it. Everything in the build wants `sample`.
        self.shore = []

    # --- Construction --------------------------------------------------------

    @classmethod
    def load(
        cls,
        radius_m: float,
        zoom: int = TERRARIUM_ZOOM,
        conform_roads: bool = True,
        conform_water: bool = True,
        conform_pads: bool = True,
        bare_earth: bool = True,
        shoreline: bool = True,
        one_sided: bool = True,
    ) -> Terrain:
        """The extent's ground, with the streets levelled into it.

        `conform_roads` is on for everything that ships. It is the second half of
        `roadgrade.py`: the DEM is a surface model and cannot say where a road
        is, so the streets are solved under a grade clamp and the lattice is
        pulled onto them under every corridor. **It happens here, on the one
        global lattice, exactly once** -- which is what keeps it independent of
        tile order and keeps two tiles' shared edge posts the same elements of
        the same array they have always been.

        Pass `False` to see the raw draped surface. Only the audit does, and only
        to print the before column.

        `conform_water` is the same arrangement one step later and is on for
        everything that ships too. The DEM clamps the ocean to exactly 0 m AHD,
        so without it the harbour's ground is *coplanar* with the water surface
        over twenty square kilometres; `water.conform` cuts a bed under every
        mapped body and holds the land at the waterline around it. It runs after
        the roads and therefore wins under a water polygon.

        **That precedence has a measured cost and it used to be stated here as
        free.** The claim was that no surface road is legitimately under a water
        polygon, which is true of the *centrelines* and irrelevant: a road's
        conformance plateau reaches `roadgrade.LATTICE_REACH_M` past its own
        corridor, so a foreshore street owns lattice posts out in the harbour,
        and the bed cut takes them from `natural` to `SHORE_CLEARANCE_M` below
        sea level in one step. The DEM's 60 m smoothing puts that foreshore five
        to twelve metres up where the truth is one to three, so the step is large
        and a 31.25 m lattice has one cell to spread it over. Measured with
        `road-grade-audit`, over 75,278 carriageway segments: with the roads
        conformed and this off, 4 segments carry more than 15% of grade and 9
        more than 15% of bank; with it on, 246 and 577, and 810 of the 823 are
        within 35 m of mapped water.

        It is still the right precedence -- the alternative is dry ground under
        the harbour -- and the real fix is a bare-earth DEM, which is this
        module's standing follow-up and moves nothing else. Until then
        `road-grade-audit` reports the shore stations on their own line rather
        than either hiding them or blaming `roadgrade.py` for them; see
        `cli._tidal_plan`.

        `conform_pads` is the third and last pass and is on for everything that
        ships. `pads.py` is `roadgrade.py`'s argument carried to the two places
        where what the DSM is reading is not beside the thing but on top of it:
        the interchange roof over a bridge-tagged station's platforms, and the
        cliff the DEM runs through a hero landmark's own footprint. It runs
        **after** the water and may not undo it -- every zone is clipped against
        the mapped water first -- and its plateau is a stated extent with a one
        cell feather, which is what lets `terrain-rules-check.py` assert that
        nothing outside those extents moved by a millimetre. Read `pads.py`'s
        header before changing the order of these three.

        `bare_earth` is the fourth pass and it runs **first**, before the road
        solve rather than after the water. `bareearth.py` argues the whole of it;
        the ordering is the half that belongs here. Rule 1 levels a bridge-tagged
        station onto the *solved streets* beside it, and at Chatswood those
        streets stand on the same contaminated plateau the station does -- so the
        authority rule 1 defers to has to be corrected before it is consulted,
        which means before `roadgrade.solve` reads its first profile. That makes
        it the one pass whose write the road solve can carry outside its own
        zone: it moves ground a street is solved on, and a grade-clamped graph
        propagates. `bare-earth-check.py` measures how far rather than assuming
        it is zero. Pass `False` for the surface as it was before this rule,
        which is the "off" column of every number that module reports.

        `shoreline` is the fifth pass and runs **second**, immediately after the
        bare-earth one and still before the road solve. `shoreline.py` argues the
        whole of it; the ordering is the half that belongs here, and it is the
        pass above it making the same argument for a second reason. The largest
        single term in the Quay's thirty-metre error is `roadgrade.solve` --
        eleven metres of it, because a grade-clamped street network cannot fall
        from a 40 m CBD to the harbour in the three hundred metres it has -- so a
        shore correction applied *after* the roads would leave the lattice under
        its own carriageways. Corrected before, the streets are solved on ground
        that has a shore in it. It runs after `bare_earth` rather than before
        because that pass floors its own correction at the smoothed DSM over a
        200 m ring, and a ring measured on already-lowered ground would clamp a
        station straight back up; in this order each reads a surface the other
        has finished with. Its write can therefore be carried outside its own
        band by the road solve exactly as the bare-earth pass's can, and
        `shoreline-check.py` measures that shadow rather than asserting it away.

        `one_sided` is **not a sixth pass.** It is the one operator choice inside
        the road solve that can be turned off, and it is a named argument for the
        reason section 3c of RAIL-VERTICAL.md gives about the other five: a check
        needs a before column, and a knob that is not an argument gets turned
        with a monkeypatch behind a cache that cannot see it. On, the Lipschitz
        projection in `roadgrade.py` is one-sided wherever the passes above have
        measured that the DSM's error here is upward -- see that module's
        `--- The sign of the error ---` block. Off, it is the symmetric average,
        which is what shipped until 2026-09-10 and what the ground under every
        street in this city was solved with until then. Only
        `roadgrade-sign-check.py` and `road-grade-audit --surface raw` pass
        `False`.
        """
        dem, origin_px, mpp = cls._load_dem(radius_m, zoom)

        # The datum, taken before the shift so it can be reported as AHD-ish.
        base = float(_bilinear(dem, *_offset_px(origin_px, *_lonlat_to_pixel(
            config.ORIGIN_LON, config.ORIGIN_LAT, zoom))))

        spacing = post_spacing()
        # Posts must cover every tile the build will emit. `tiles_within_radius`
        # keeps a tile whose *nearest corner* is inside the radius, so the reach
        # is one whole tile beyond the radius, and one post beyond that so an
        # interpolation exactly on the last post has a cell to sit in.
        reach = int(math.ceil(radius_m / config.TILE_SIZE) + 1) * config.TERRAIN_GRID
        idx = np.arange(-reach, reach + 1, dtype=np.float64)
        east = (idx * spacing)[None, :].repeat(len(idx), axis=0)
        north = (idx * spacing)[:, None].repeat(len(idx), axis=1)

        lon, lat = geo.enu_to_lonlat(east.ravel(), north.ravel())
        px, py = _lonlat_to_pixel(lon, lat, zoom)
        cx, cy = _offset_px(origin_px, px, py)
        heights = _bilinear(dem, cx, cy).reshape(east.shape).astype(np.float32) - np.float32(base)

        stats = {
            "zoom": zoom,
            "pixels": dem.shape,
            "metres_per_pixel": mpp,
            "sigma_m": SMOOTH_SIGMA_M,
            "posts": heights.shape,
            "min": float(heights.min()),
            "max": float(heights.max()),
        }
        # The DEM mosaic (~270 MB at 60 km) is dead the moment the lattice is
        # sampled off it: `stats["pixels"]` above is its last reader, and the
        # conform and water passes below draw on `field.sample` -- the lattice --
        # not the raster. Freeing it here rather than at return hands the ~270 MB
        # back before the conform allocates its own arrays, which is the one place
        # the head's memory is worth trimming on a machine that solves it at all.
        # It cannot change a byte: `heights` is already final. See the cache in
        # `terraincache`, which is what stops this solve running most rounds.
        del dem
        field = cls(_Lattice(heights, -reach, -reach, spacing), base, stats)

        # What the passes below are about to learn about the sign of the DSM's
        # error here, for the road solve to project with. One float32 array on
        # this lattice's own grid, alive only until `solve` has read it -- it is
        # an input to one solve and not a property of the ground, and this object
        # is what `terraincache` pickles. `roadgrade.GroundEvidence` argues the
        # whole of it; what belongs here is the `before` snapshot, and it is
        # taken across *both* early passes rather than inside either, so that a
        # sixth pass that lowers the ground before the solve is believed for
        # free and nobody has to remember to wire it in.
        evidence = None
        before = None
        if one_sided and (bare_earth or shoreline):
            from . import roadgrade as roadgrade_module

            evidence = roadgrade_module.GroundEvidence(
                heights.shape, -reach, -reach, spacing
            )
            before = heights.copy()
        if bare_earth:
            # First, and reading nothing this build has computed: the correction
            # is a function of the raw terrarium pixels and the OSM footprints
            # over them, so it is available before any solve and has to be
            # applied before the one that would otherwise inherit the error. It
            # is written with `pads.conform` -- same plateau, same one-cell
            # smoothstep, same `PadRecord` -- because a rule that can name the
            # ground it is allowed to touch should be made to, and that machinery
            # is what makes the naming checkable. No water is passed: the water
            # has not been read yet and does not need to be, because
            # `water.conform` runs *after* this and wins on every post it owns.
            from . import bareearth
            from . import pads as pads_module

            # `field.sample` and not the raster: the correction is a subtraction
            # off what the lattice already says, so a zone with nothing to
            # correct moves nothing at all rather than by the difference between
            # two windowings of the same Gaussian. `_BareField` argues it.
            zones = bareearth.station_pads(radius_m, base, zoom, field.sample)
            stats["bare_earth"] = pads_module.conform(
                heights, -reach, -reach, spacing, zones, None, field.bare_earth
            )
            stats["min"] = float(heights.min())
            stats["max"] = float(heights.max())
        if shoreline:
            # Second, and still before the road solve. It reads `field.sample`
            # for the same reason the pass above it does -- the correction is a
            # subtraction off what the lattice already says, so a shore with
            # nothing to correct moves nothing at all rather than by the
            # difference between two windowings of the same Gaussian -- and it
            # reads the mapped water through its own `water.load`, because the
            # build's own water is not read until after the roads and hoisting
            # that read would move every pond in the extent. `shoreline.py`'s
            # `tidal_geometry` states the trade.
            from . import shoreline as shore_module

            stats["shoreline"] = shore_module.conform(
                heights, -reach, -reach, spacing, radius_m, base, zoom,
                field.sample, field.shore, evidence,
            )
            stats["min"] = float(heights.min())
            stats["max"] = float(heights.max())
        if evidence is not None:
            # Every metre the two passes above took off, in one diff. Taken here
            # rather than reported by each pass because it is a property of the
            # lattice and not of either rule, and because a diff cannot forget a
            # pass the way a report can.
            evidence.corrected(before - heights)
            del before
        if conform_roads:
            # The solve reads the *unconformed* surface through `field.sample`
            # and the conformance then writes back into the same array, so the
            # roads are solved against the ground as the DEM gave it and the
            # ground is moved once, afterwards. Doing it in that order is what
            # stops the surface being a function of itself.
            from . import roadgrade

            surface = roadgrade.solve(field.sample, radius_m, evidence=evidence)
            stats["roads"] = surface.stats
            stats["conform"] = roadgrade.conform(heights, -reach, -reach, spacing, surface)
            stats["min"] = float(heights.min())
            stats["max"] = float(heights.max())
            field.road_surface = surface
        # The evidence has been read and is a lattice-sized float32 array; the
        # water pass below allocates its own and this is the one place in the
        # head worth handing memory back, exactly as the DEM's `del` above is.
        evidence = None
        if conform_water:
            # Read against the surface as the roads left it, and written back
            # into the same array afterwards -- the same order, for the same
            # reason, as the road pass above: a body's own shore level is
            # measured on ground that is not yet a function of this decision.
            from . import water as water_module

            field.water = water_module.load(radius_m, field.sample, -base)
            stats["water"] = field.water.stats
            stats["water"]["conform"] = water_module.conform(
                heights, -reach, -reach, spacing, field.water
            )
            stats["water"]["area_m2"] = field.water.area
            stats["min"] = float(heights.min())
            stats["max"] = float(heights.max())
        if conform_pads:
            # Last, and reading the surface the first two passes left: a station
            # pad is the *solved street*, which does not exist until the road
            # pass has run, and a landmark's base is `terrain.sample` at its own
            # centroid, which is the number `build_*` will ask for later. Both
            # are therefore functions of ground that is already final, and this
            # pass is the only one that moves it afterwards -- which is what
            # stops the surface being a function of itself. The pad the model
            # then builds on is the one recorded here, not a re-sample; see
            # `landmarks.stated_pad` for the 3.82 m that distinction is worth at
            # Luna Park's entrance.
            from . import pads as pads_module

            zones = pads_module.station_pads(radius_m, field.road_surface)
            zones += pads_module.landmark_pads(radius_m, field.sample)
            stats["pads"] = pads_module.conform(
                heights, -reach, -reach, spacing, zones, field.water, field.pads
            )
            stats["min"] = float(heights.min())
            stats["max"] = float(heights.max())
        return field

    @staticmethod
    def _load_dem(radius_m: float, zoom: int) -> tuple[np.ndarray, tuple[float, float], float]:
        """Mosaic, clamp and smooth the terrarium tiles covering the extent.

        The one function a finer DEM replaces. Returns the raster in metres, the
        global pixel coordinate of its (0, 0) corner, and its ground sample
        distance -- nothing above this line knows or cares that it came from
        256-pixel PNGs on a Mercator grid.
        """
        bbox = geo.bbox_geodetic_for_radius(radius_m + FETCH_MARGIN_M)
        min_lon, min_lat, max_lon, max_lat = bbox
        # North is smaller y in Mercator, so the raster's top-left is (min_lon, max_lat).
        x0, y0 = _lonlat_to_pixel(min_lon, max_lat, zoom)
        x1, y1 = _lonlat_to_pixel(max_lon, min_lat, zoom)
        tx0, ty0 = int(x0) // TERRARIUM_PIXELS, int(y0) // TERRARIUM_PIXELS
        tx1, ty1 = int(x1) // TERRARIUM_PIXELS, int(y1) // TERRARIUM_PIXELS

        nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
        dem = np.empty((ny * TERRARIUM_PIXELS, nx * TERRARIUM_PIXELS), dtype=np.float32)
        with requests.Session() as session:
            session.headers["User-Agent"] = "sydney-pipeline (github.com/sydney; terrain.py)"
            for j in range(ny):
                for i in range(nx):
                    dem[
                        j * TERRARIUM_PIXELS : (j + 1) * TERRARIUM_PIXELS,
                        i * TERRARIUM_PIXELS : (i + 1) * TERRARIUM_PIXELS,
                    ] = _fetch_tile(session, zoom, tx0 + i, ty0 + j)

        np.maximum(dem, SEA_LEVEL, out=dem)
        mpp = _metres_per_pixel(config.ORIGIN_LAT, zoom)
        if SMOOTH_SIGMA_M > 0.0:
            # `nearest` rather than `reflect`: the mosaic is fetched with a margin
            # wider than the kernel, so what is clamped here is never sampled.
            dem = ndimage.gaussian_filter(dem, SMOOTH_SIGMA_M / mpp, mode="nearest")
        return dem, (tx0 * TERRARIUM_PIXELS, ty0 * TERRARIUM_PIXELS), mpp

    # --- Sampling ------------------------------------------------------------

    def sample(self, east, north):
        """Ground height at an ENU point, metres above the datum. Array-preserving.

        This is the *rendered* surface, not the DEM: the lattice interpolated
        exactly the way the client triangulates it, so a vertex placed here lands
        on the ground the player sees rather than near it. Each cell is split
        along its north-west to south-east diagonal -- stated once here, repeated
        in `tiles.write_terrain`'s format note, and matched in the client's
        `terrain.ts`. Change one and all three must change together.
        """
        lat = self._lat
        s = lat.spacing
        # Cell coordinates, with the row axis running *south* so it matches the
        # sidecar and the client. `qf` counts posts north of q0, `rf` counts them
        # southward from the top of the lattice.
        pf = np.asarray(east, dtype=np.float64) / s - lat.p0
        rf = (lat.heights.shape[0] - 1) - (np.asarray(north, dtype=np.float64) / s - lat.q0)

        max_c = lat.heights.shape[1] - 2
        max_r = lat.heights.shape[0] - 2
        c = np.clip(np.floor(pf), 0, max_c).astype(np.int64)
        r = np.clip(np.floor(rf), 0, max_r).astype(np.int64)
        fc = np.clip(pf - c, 0.0, 1.0)
        fr = np.clip(rf - r, 0.0, 1.0)

        # Rows of `heights` ascend with north, so a southward row index reads
        # backwards through it. Precomputing the flipped view would double the
        # memory for a subtraction.
        top = lat.heights.shape[0] - 1
        h_nw = lat.heights[top - r, c]
        h_ne = lat.heights[top - r, c + 1]
        h_sw = lat.heights[top - r - 1, c]
        h_se = lat.heights[top - r - 1, c + 1]

        # The diagonal runs NW -> SE, so it is the line fr == fc. Above it (fc
        # larger) the triangle is NW/NE/SE; below it, NW/SE/SW. Both expressions
        # agree on the diagonal itself, so there is no seam to get wrong.
        upper = fc >= fr
        h = np.where(
            upper,
            h_nw + (h_ne - h_nw) * fc + (h_se - h_ne) * fr,
            h_nw + (h_sw - h_nw) * fr + (h_se - h_sw) * fc,
        )
        return float(h) if np.isscalar(east) or np.ndim(east) == 0 else h

    def slope(self, east, north):
        """Ground gradient at an ENU point as (dh/deast, dh/dnorth). Array-preserving.

        A central difference over one post spacing rather than the exact
        derivative of `sample`, and the difference matters: `sample` is piecewise
        linear, so its true gradient is a staircase that jumps at every cell
        boundary and would give a draped road a visible facet line every 31 m.
        Differencing over a whole post smooths that out, and it is the same span
        the client differences its own grid over, so a road and the ground under
        it end up with the same normal.
        """
        s = self._lat.spacing
        e = np.asarray(east, dtype=np.float64)
        n = np.asarray(north, dtype=np.float64)
        de = (self.sample(e + s, n) - self.sample(e - s, n)) / (2.0 * s)
        dn = (self.sample(e, n + s) - self.sample(e, n - s)) / (2.0 * s)
        return de, dn

    @property
    def spacing(self) -> float:
        """Metres between lattice posts."""
        return self._lat.spacing

    def facets(self, bounds: tuple[float, float, float, float]) -> list:
        """The rendered ground's flat pieces overlapping an ENU bounding box.

        The surface `sample` interpolates is piecewise *planar*, not smooth: two
        triangles per lattice cell, split NW to SE. Anything that has to lie on
        the ground without sinking into it -- every paved surface in `streets.py`
        -- is cut against these first, and then each piece is exactly parallel to
        the ground beneath it and the offset it is given is the offset it keeps.

        Measured against the alternatives on six inner-ring tiles, cutting the
        carriageway this way costs 8,728 triangles where the uncut version costs
        3,966 and a uniform 32 m edge cap costs 18,960 -- and it is the only one
        of the three whose worst-case error is zero rather than 1.15 m and 17.4 m
        respectively. Buying exactness for 2.2x is the easiest trade in the
        pipeline.

        The lattice is three families of parallel lines and it is worth seeing
        why, because it is what makes the cut cheap and the pieces well-shaped:
        east = kS, north = kS, and -- since every cell's diagonal runs from
        (p, q+1) to (p+1, q) -- east + north = kS.
        """
        from shapely.geometry import Polygon

        s = self._lat.spacing
        e0, n0, e1, n1 = bounds
        out = []
        for p in range(math.floor(e0 / s), math.ceil(e1 / s)):
            for q in range(math.floor(n0 / s), math.ceil(n1 / s)):
                sw = (p * s, q * s)
                nw = (p * s, (q + 1) * s)
                ne = ((p + 1) * s, (q + 1) * s)
                se = ((p + 1) * s, q * s)
                out.append(Polygon((nw, se, ne)))  # the north-east half
                out.append(Polygon((nw, sw, se)))  # the south-west half
        return out

    def densify(self, coords: np.ndarray) -> np.ndarray:
        """Insert a vertex wherever a polyline crosses a facet boundary.

        The one-dimensional form of `facets`, for the geometry that is a line
        rather than a surface -- the kerb face. Between two consecutive vertices
        the ground is now planar, so the strip standing on this ring follows it
        exactly, and the crossings it inserts are the same ones the surface cut
        puts in the carriageway's own boundary, so the two stay welded.
        """
        s = self._lat.spacing
        pts = np.asarray(coords, dtype=np.float64)
        out = [pts[0]]
        for a, b in itertools.pairwise(pts):
            ts: list[float] = []
            for fa, fb in (
                (a[0], b[0]),
                (a[1], b[1]),
                (a[0] + a[1], b[0] + b[1]),
            ):
                if fa == fb:
                    continue
                lo, hi = (fa, fb) if fa < fb else (fb, fa)
                for k in range(math.floor(lo / s) + 1, math.ceil(hi / s)):
                    t = (k * s - fa) / (fb - fa)
                    # Strictly interior: a crossing that lands on an existing
                    # vertex is already there, and emitting it again would put a
                    # zero-length segment into the strip.
                    if 1e-9 < t < 1.0 - 1e-9:
                        ts.append(t)
            for t in sorted(ts):
                out.append(a + (b - a) * t)
            out.append(b)
        return np.asarray(out, dtype=np.float64)

    def grid_for_tile(self, tile_key: str) -> np.ndarray:
        """One tile's (N+1) x (N+1) post grid, float32, in sidecar order.

        Row 0 is the tile's **northern** edge and row N its southern one; column 0
        is its western edge. That is row-major north-to-south, west-to-east --
        the order the client walks to build its grid mesh, where rows advance
        along +Z and +Z is south.
        """
        tx, tz = (int(v) for v in tile_key.split("_"))
        n = config.TERRAIN_GRID
        lat = self._lat
        c0 = tx * n - lat.p0
        q0 = tz * n - lat.q0
        # North-to-south rows: read the lattice's north-ascending rows backwards.
        rows = lat.heights[q0 : q0 + n + 1, c0 : c0 + n + 1][::-1, :]
        if rows.shape != (n + 1, n + 1):
            raise IndexError(
                f"tile {tile_key} falls outside the terrain lattice"
                f" ({rows.shape} posts, wanted {(n + 1, n + 1)}). Widen `reach` in Terrain.load."
            )
        # A contiguous copy: the slice is a strided view of the lattice and
        # `tobytes` on it would be a transpose away from what the client reads.
        return np.ascontiguousarray(rows, dtype=np.float32)


def _offset_px(origin_px: tuple[float, float], px, py):
    return px - origin_px[0], py - origin_px[1]


def _bilinear(grid: np.ndarray, x, y):
    """Bilinear sample of a raster at fractional pixel coordinates.

    `ndimage.map_coordinates` with `order=1` does exactly this and is what was
    used to choose the smoothing; it is written out here because the call site
    wants (x, y) rather than (row, col) and because this is the one place the
    whole world's heights come from.
    """
    x = np.clip(np.asarray(x, dtype=np.float64), 0.0, grid.shape[1] - 1.0000001)
    y = np.clip(np.asarray(y, dtype=np.float64), 0.0, grid.shape[0] - 1.0000001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    a = grid[y0, x0]
    b = grid[y0, x0 + 1]
    c = grid[y0 + 1, x0]
    d = grid[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


# ---------------------------------------------------------------------------
# Follow-up, recorded here because this is where anyone chasing it will look.
#
# The CBD sits ~40 m high because terrarium is a surface model and the CBD is a
# forest of towers. Smoothing cannot fix it -- the contaminated patch is 1.5 km
# across, wider than any kernel that leaves a landform standing -- and a
# morphological opening cannot either: measured at radii from 32 m to 160 m it
# takes the CBD from 64 m to 53 m and Observatory Hill, which is a real hill,
# from 34 m to 24 m. It removes the wrong thing.
#
# Two real fixes, in order of cost. Bare-earth LiDAR (ELVIS, milestone 2) makes
# the question disappear. Failing that, the pipeline already knows every building
# footprint and height in the extent, so a DSM-minus-buildings correction --
# rasterise the footprints, subtract a coverage-weighted height, hole-fill from
# the unbuilt ground around each block -- is tractable and needs no new source.
# Both are their own pass. Neither changes anything below `_load_dem`.
#
# UPDATE 2026-09-10: the second one is built, in `bareearth.py`, and is the
# `bare_earth` pass above. Two corrections to the sketch, both measured there:
# the hole-fill is not needed and does not work (at 15.87 m a pixel a suburban
# roof never owns a pixel, so masking a blend and filling from blends recovers
# the blend -- it moved Chatswood 0.31 m the wrong way), and the subtraction is
# the whole method on its own, because the smoothing is linear. It is applied
# **only inside bridge-tagged station zones** and bounded by the roof over the
# platforms, deliberately: unbounded it wants 15.6 m off Circular Quay, which is
# the CBD error this note is about and not a thing a station rule gets to fix.
# Applying it city-wide is still the follow-up; what exists is the narrowest
# version that answers RAIL-VERTICAL.md section 3a.
#
# UPDATE 2026-09-10, later the same day: the *second* narrowest version is built
# too, in `shoreline.py`, and it is the `shoreline` pass above. Same estimator,
# a different bound: inside a 250 m band along mapped tidal water the ground is
# pulled toward the water and floored at this deconvolution, so a foreshore the
# DSM reads as a wharf shed comes down and a foreshore that is real rock does
# not. It removes 5.63 m of the Quay's 29.56 m error and RAIL-VERTICAL.md
# section 3d has every term of the rest -- including the one that is not the
# DEM's at all: `roadgrade._lipschitz` averaged a downward projection with an
# upward one and so handed back 59% of anything taken off a shore that is tied to
# a CBD still reading 40 to 55 m. The city-wide pass this note has always asked
# for is still the follow-up, and section 3d's reach sweep is what it is worth.
#
# UPDATE 2026-09-10, later still: that last term is fixed, in `roadgrade.py`'s
# `--- The sign of the error ---` block and RAIL-VERTICAL.md section 3e. The
# projection is now one-sided wherever an earlier pass has *measured* that the
# error here is upward, so a corrected shore pulls the streets behind it down
# along the grade limit instead of being pulled up to meet them. It does not
# make this note obsolete: it decides how much of a correction survives, and it
# has no correction of its own to make in the middle of the CBD, where nothing
# has yet told the ground anything.
#
# UPDATE: the *worst* consequence of it has since been dealt with separately, and
# it is worth being clear about which. The contamination made the roads unusable
# -- a tower footprint next to true ground is a 45 degree facet and the road drapes
# straight over it -- so `roadgrade.py` stopped asking the DEM where the roads are
# and started telling the DEM. The offset above is untouched and so is the ground
# in the middle of a block; what is fixed is every corridor a player walks down.
# A bare-earth DEM would still be worth having and would still change nothing
# below `_load_dem`.
# ---------------------------------------------------------------------------
