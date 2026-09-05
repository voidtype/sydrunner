"""The four hero landmarks, built parametrically to published dimensions.

Everything else in this pipeline is a *rule* applied to a dataset: a footprint is
extruded, a road is ribboned, a tree is scattered. That works because the city is
made of thousands of things nobody looks at twice. It fails completely on the
handful of objects the city is actually recognised by -- the Harbour Bridge
extruded from its OSM outline is a 49 m slab of asphalt lying on the water, the
Opera House is a 30 m warehouse blob, Sydney Tower is not in the world at all
(OSM tags it `man_made=tower` with no `building`, so `read_buildings` never sees
it), and Luna Park -- the one of the four a Sydneysider has actually *walked
into* -- comes out as a dozen cream warehouse boxes on the Milsons Point
foreshore with no face on any of them.

So these four are hand-authored, and this module is where the authoring lives.

WHY PARAMETRIC AND NOT A DOWNLOADED MESH. Three reasons and they all matter more
than the modelling time: a third-party mesh arrives with a licence this project
cannot audit; it arrives in its own frame and has to be registered to ours by eye,
where a parametric model lands on its OSM footprint by construction; and it
arrives in somebody else's art direction, where every number below is a published
dimension and every surface is one of the five materials the rest of the world
already reads correctly under `sky/calibration.ts`'s rig.

WHAT "PARAMETRIC" MUST NOT MEAN HERE. The whole complaint that produced this pass
is that the procedural city swallowed the landmarks, so a landmark that reads as
a nicer box has failed. The test each of the four has to pass is silhouette at a
kilometre: the bridge is a *trussed arch with four pylons*, the Opera House is
*spherical shells*, the tower is *a gold turret on a white stalk with a cable
fan*, and Luna Park is *a grinning face between two Art Deco towers with a wheel
behind it*. Every triangle below is spent on one of those four readings and the
detail that does not change the silhouette (rivets, mullions, cladding joints) is
deliberately absent.

LUNA PARK IS THE ONE READ AT TWO HUNDRED METRES, NOT AT A KILOMETRE, and that
changes where its triangles go. Nothing in the park is tall; what makes it
recognisable is a nine-metre painted face you stand in front of. So the face and
its two towers carry roughly a third of the model's triangles and the halls
behind them are boxes with roofs -- the opposite of the split the bridge wants,
and correct for the same reason: spend on the thing that carries the reading.

---------------------------------------------------------------------------
Frames, because there are three of them and mixing two is the one bug here that
would look like a plausible city.

  * **ENU** -- (east, north) metres from the Town Hall origin, `geo.py`'s frame,
    which is what every OSM anchor below is measured in.
  * **World** -- (x, y, z) = (east, up, -north), the renderer's frame. The flip
    happens exactly once, in `_Builder.w()`, and nowhere else in this file.
  * **AHD** -- real elevations, metres above the Australian Height Datum, which
    is what every published dimension in the constants below is quoted in.
    `world y = ahd - terrain.base_elevation`; sea level is `-base_elevation`,
    which in this build is -71.07. Every height constant here is AHD, converted
    once per landmark, so a reader can check a number against Wikipedia without
    doing arithmetic.

---------------------------------------------------------------------------
Materials are a **separate namespace** from `mesh.MATERIALS` and deliberately so.

`mesh.MATERIALS` is append-only because its indices are baked into every shipped
`.glb` primitive and into one byte per slab in `far.bin`. Appending five slots to
it for geometry that appears in neither file would grow `far.ts`'s `FAR_TINT`
table, add five facade pipelines to `TileStreamer`'s constructor that nothing
draws, and put five names in `index.json`'s `materials` list that no tile can
carry -- all to reuse a numbering the landmark GLB does not use. So
`LANDMARK_MATERIALS` below is its own list, written into `landmarks.glb`'s own
material block, and `client/src/world/landmarks.ts` maps it **by name**.
`mesh.MATERIALS` is untouched by this pass.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import mapbox_earcut
import numpy as np
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from . import geo

# --- Materials ---------------------------------------------------------------

# Five surfaces, one road, and four tins of paint. Small on purpose: every one of
# them is a *shared* instance on the client, so the whole of the landmark set is
# ten pipelines.
#
# Not append-only -- nothing indexes these positionally. The GLB names its
# materials and the client looks them up by name, which is affordable here
# precisely because there are ten of them rather than 33,651 buildings' worth.
# The **order still has to match** `client/src/world/landmarks.ts`, because
# `verifyLandmarks` compares the two lists as strings at boot: that check is not
# about rendering, it is about proving the world and the client came out of the
# same revision.
LANDMARK_MATERIALS = (
    # Painted structural steel. The bridge is "Harbour Grey", a warm mid grey
    # that photographs almost silver in full sun and near-black in the shade
    # under the deck -- which is most of what the rig will do to it.
    "landmark_steel",
    # Trachyte/granite facing. The four pylons, the bridge's abutments and
    # approach piers, and the Opera House podium, which is reconstituted granite
    # aggregate rather than the pink Hawkesbury sandstone of the CBD.
    "landmark_granite",
    # The shells: 1,056,006 Swedish-made off-white and matt-cream tiles in a
    # chevron pattern. Not white -- cream, and the chevron is what stops it
    # reading as a plastic dome. See `world/landmarks.ts` for the sheen.
    "landmark_shell",
    # The glazed mouths under the shells, the tower turret's windows, and the
    # dark soffits. Nearly black in reflection terms; the rig's sky does the
    # rest.
    "landmark_glass",
    # Gold anodised aluminium: the tower turret and nothing else in the world.
    "landmark_gold",
    # The bridge deck's running surface. Its own slot rather than the steel
    # because it is the one landmark surface a player stands on, and it has to
    # read as road from the deck rather than as painted steel.
    "landmark_asphalt",
    # --- Luna Park's paint box, and it is a *box* rather than one slot with a
    # vertex colour for a reason that is about the client: every material here is
    # one shared `MeshStandardNodeMaterial` instance, and adding a COLOR_0
    # attribute to carry four values would put a per-vertex stream on every
    # primitive in the file -- including the bridge's 34,000 vertices, which are
    # all one grey. Four flat materials cost four draw calls on one node and
    # nothing anywhere else.
    #
    # The four are the amusement-park palette of the 1930s and they are chosen as
    # a *set*: cream against three saturated primaries, which is what a
    # sideshow-alley paint job is, and what stops the halls reading as the same
    # render-painted boxes the suburb around them is made of.
    #
    # Cream rather than white. The face, the towers and the halls are painted a
    # warm off-white; a true white next to the red would blow out under the rig's
    # sun and read as plastic, the same trap the Opera House's tiles are cream to
    # avoid.
    "landmark_paint_white",
    # The lips, the trim bands, the turret roofs and half the rays. A deep
    # signwriter's red with a trace of orange in it, not a fire-engine red.
    "landmark_paint_red",
    # The other half of the rays, and Coney Island's bay panels. Ochre-leaning,
    # because a lemon yellow at this saturation reads as a warning sign.
    "landmark_paint_yellow",
    # The eyes, and the cornice above Coney Island's front. The one cool colour
    # in the park, and it is spent almost entirely on two 2 m discs -- which is
    # the point, because they are what the face is looking at you with.
    "landmark_paint_blue",
)
LANDMARK_MATERIAL_INDEX = {m: i for i, m in enumerate(LANDMARK_MATERIALS)}


# --- Published dimensions ------------------------------------------------------
#
# Every number in this block is a real measurement of a real object, in metres,
# elevations in AHD. They are grouped by landmark and named after what they are
# rather than after what the code does with them, so that a reviewer can check
# the model against a reference without reading any geometry.

# Sydney Harbour Bridge, opened 1932, Dorman Long & Co.
BRIDGE_ARCH_SPAN = 503.0  # bearing pin to bearing pin
BRIDGE_ARCH_CREST_AHD = 134.0  # top of the upper chord at the crown
BRIDGE_DECK_AHD = 49.0  # roadway, above mean sea level
BRIDGE_TOTAL_LENGTH = 1149.0  # including both approach viaducts
BRIDGE_DECK_WIDTH = 48.8
BRIDGE_PYLON_TOP_AHD = 89.0  # all four, granite-faced
BRIDGE_ARCH_TRUSS_GAUGE = 30.5  # centre to centre of the two arch planes
BRIDGE_CROWN_TRUSS_DEPTH = 18.3  # upper chord to lower chord at the crown
BRIDGE_BEARING_AHD = 8.0  # the pins, on their concrete skewbacks
BRIDGE_PANELS = 28  # hanger bays across the arch
# The boxed chord members, across the truss and through it. Module constants
# rather than locals because `_bridge_chords` has to know the depth: the
# published 134 m is the **top of the steel**, not the centreline of the top
# chord, so the curve is dropped half a chord to put the beam's top face there.
# Getting that wrong is 2.3 m -- 1.7% -- which is inside a casual eyeball and
# outside `landmark-audit`'s tolerance, which is what caught it.
BRIDGE_CHORD_WIDTH = 4.2
BRIDGE_CHORD_DEPTH = 4.6
# The lower chord rises more slowly than the upper one, which is what puts the
# truss's greatest depth off-centre where the real one carries it. 1.6 is the
# exponent that lands the maximum at 26.5 m around the 60% point with the crown
# held at the published 18.3 -- see `_bridge_chords`.
BRIDGE_LOWER_CHORD_EXPONENT = 1.6
BRIDGE_DECK_DEPTH = 3.6  # roadway slab to the underside of the deck box
BRIDGE_PARAPET_HEIGHT = 1.25
BRIDGE_PYLON_BASE = (17.5, 28.0)  # across the deck, along the deck
BRIDGE_PYLON_TOP = (15.2, 25.4)
# Where the four pylons stand, across the deck from the centreline. Derived from
# the OSM pylon-pair polygons, which are 66.4 m across and hold both pylons of a
# pair plus the roadway between them.
BRIDGE_PYLON_OFFSET = 24.7
# The approach ramps past the 1,149 m deck, which is where the Bradfield Highway
# has to come back to the ground. 5.5% is the steepest a road of this class runs
# at; the ramp stops early the moment the descending deck meets the terrain,
# which on the southern side it does, in The Rocks, at about 280 m.
BRIDGE_RAMP_GRADE = 0.055
BRIDGE_RAMP_MAX = 300.0

# Sydney Opera House, opened 1973, Jorn Utzon.
OPERA_SPHERE_RADIUS = 75.2  # Utzon's spherical solution: every shell is cut from
#                             one sphere of this radius, which is what made the
#                             shells buildable from repeated precast ribs.
OPERA_SHELL_MAX_AHD = 67.0  # the tallest shell, over the Concert Hall stage
OPERA_PODIUM_TOP_AHD = 16.0  # the concourse the shells spring from
OPERA_STAIR_RUN = 34.0  # the broad ceremonial stairs, on the southern approach
OPERA_STAIR_STEPS = 22
# How sharply each vault's ridge rises to its apex. Above 1 the two halves meet
# in a point rather than a dome -- see `_shell_surface.ridge_y`, which is where
# the whole silhouette is decided.
OPERA_RIDGE_EXPONENT = 1.7

# Sydney Tower, opened 1981, Donald Crone. Heights are above the **ground at its
# own base**, not AHD -- the published 309 m is a building height.
TOWER_TOTAL_HEIGHT = 309.0
TOWER_PODIUM_HEIGHT = 30.0  # the Centrepoint/Westfield retail podium
TOWER_SHAFT_RADIUS = 3.35  # 6.7 m concrete stalk
TOWER_TURRET_BOTTOM = 220.0
TOWER_TURRET_TOP = 265.0
TOWER_CABLES = 56
# The turret, as the stack of cone frusta it visibly is: (height above ground,
# radius). **A drum, not a lemon.** The first profile peaked at 12.5 m half way
# up and tapered both ways, which the landmark sheet showed for what it was: an
# olive on a stick. The operator's own fact sheet gives the turret as
# "approximately 31 metres" across, and the photograph on it gives the shape --
# a short conical skirt flaring out from the 6.7 m shaft, then a near-vertical
# glazed drum for the two restaurants and the deck (the 420 windows), leaning
# out a touch as it rises, then a stepped-in band for the plant and telecom
# levels, then the roof cone the spire stands on. The observation deck is at
# 250 m, inside the top of the drum.
TOWER_TURRET_PROFILE: tuple[tuple[float, float], ...] = (
    (220.0, 4.2),
    (224.0, 11.5),
    (228.0, 14.8),
    (250.5, 15.5),
    (252.5, 13.2),
    (258.0, 11.8),
    (262.0, 8.4),
    (265.0, 3.2),
)

# Luna Park Sydney, Milsons Point, opened 4 October 1935. Heights here are above
# **the park's own ground**, not AHD, and that is not laziness: the whole park is
# built on reclaimed flat at three or four metres above the harbour, and the DEM
# this world is solved from has no idea -- it runs the Milsons Point cliff
# straight through the site, from -3.5 m AHD at the water's edge to +25 m AHD
# eighty metres inland. Quoting a park building in AHD would be quoting it
# against a hillside that is not there. Every number below is therefore a height
# above the structure's own pad, which is the same convention `mesh.py` gives the
# 33,651 generic buildings.
LUNA_TOWER_HEIGHT = 26.0  # the two Art Deco entrance towers, 1930s, to the finial
LUNA_FACE_WIDTH = 9.0  # the Face itself, hung between them, facing the wharf
LUNA_WHEEL_HEIGHT = 35.0  # the Ferris Wheel, 24 gondolas
LUNA_WHEEL_GONDOLAS = 24
# The Face's surround. The nine metres above is the painted face; the rayed
# sunburst it is set into is half as wide again, and it is the sunburst that does
# the work at two hundred metres because it is the part with two colours in it.
LUNA_SUNBURST_RADIUS = 7.4
# How high the Face's centre sits above the entrance pad. Low enough that the
# mouth is the way in rather than a window, and high enough that the sunburst's
# eastern rays clear the DEM's bank -- which climbs five metres across the width
# of the entrance and would otherwise bury a quarter of the composition.
LUNA_FACE_CENTRE = 10.2

# What the generic pipeline currently makes of the park, as **measured off the
# shipped `buildings` table**, in metres above each footprint's own pad.
#
# This is here because of a sequencing fact rather than a modelling one. The
# world is refreshed landmark-only -- a 5.3 km terrain solve and a new
# `landmarks.glb`, no 60 km build -- so `suppression_zones` below does not take
# effect until the *next* full build, and until then the generic boxes for these
# footprints are still in the streamed tiles, standing inside the hero model. So
# every hall here is sized to **envelope** its box: eaves at or above the box's
# top (a hip roof does not contain the box's corners, so it is the eaves that
# have to clear it, not the ridge) and the footprint buffered outwards. The
# numbers are not guesses -- `attributes.resolve_height` classifies most of the
# park as `warehouse` and gives it twelve metres, which is why Crystal Palace has
# to be a thirteen-metre hall rather than the ten-metre one it really is.
LUNA_ENVELOPE_M = 0.3  # clearance past the generic box, every side and above
LUNA_GENERIC_TOPS: dict[str, float] = {
    "luna_gate_w": 11.5,
    "luna_gate_e": 11.5,
    "luna_gate_roof": 12.0,
    "luna_crystal_palace": 12.0,
    "luna_coney_island": 12.0,
    "luna_big_top": 12.0,
    "luna_big_top_annexe": 16.3,
    "luna_lounge": 7.3,
    "luna_administration": 6.3,
    "luna_helter_skelter": 11.5,
    "luna_carousel": 11.5,
}

# The halls, in metres above their own pads: (eaves, ridge). Every eaves figure
# clears `LUNA_GENERIC_TOPS` by `LUNA_ENVELOPE_M`; the ridge is the shape.
LUNA_CRYSTAL_EAVES, LUNA_CRYSTAL_RIDGE = 13.0, 17.4
LUNA_CRYSTAL_TURRET, LUNA_CRYSTAL_SPIRE = 14.6, 21.5
LUNA_CRYSTAL_BAYS = 13  # the thirteen bays of the two-storey hall
LUNA_CONEY_EAVES, LUNA_CONEY_RIDGE = 13.0, 16.6
LUNA_CONEY_BAYS = 12
LUNA_BIGTOP_EAVES, LUNA_BIGTOP_CROWN = 13.2, 18.4
LUNA_ANNEXE_EAVES, LUNA_ANNEXE_CROWN = 17.2, 19.8
LUNA_LOUNGE_EAVES, LUNA_LOUNGE_RIDGE = 8.2, 11.4
LUNA_ADMIN_TOP, LUNA_ADMIN_PARAPET = 7.2, 8.1
LUNA_ENTRANCE_TOP = 18.0  # the block the Face is hung on, over a 12 m OSM stub

# How far a landmark's walls run below their own pad, and it is the same argument
# `mesh.WALL_SKIRT` makes for the city: one flat pad per structure, because a
# tilted building is worse than a pad that cuts into a slope, and then enough
# buried wall that the ground never falls away from under it. Unlike `mesh`
# there is no ceiling on the depth here -- the park sits on a DEM cliff, Crystal
# Palace's footprint spans seventeen metres of it, and a capped skirt on that
# footprint is a hole a player can look up through.
LUNA_SKIRT_MIN = 1.5


# --- Suppression ---------------------------------------------------------------

# How far past each landmark's own outline a generic building is still considered
# to be standing inside it.
#
# Small, and it has to be: the Opera House's forecourt is a public square with
# real buildings 40 m away that belong in the world, and the tower's podium
# shares a party wall with half of Pitt Street Mall. This is "inside the
# landmark", not "near it" -- everything the zones actually remove is listed in
# the build report so a zone that has started eating the city says so.
SUPPRESS_MARGIN_M = 6.0


@dataclass(frozen=True)
class Anchor:
    """One OSM feature the landmarks are registered to.

    `ring` is the projected ENU outline and `centroid` its centre. Both are read
    from the extract at build time rather than written down here, so the models
    move if OSM's outline is corrected -- with the literal fallback below for the
    day a way id or a name changes and the read comes back empty.
    """

    name: str
    ring: np.ndarray  # (N, 2) ENU metres
    centroid: tuple[float, float]
    source: str  # 'osm' | 'fallback'


@dataclass(frozen=True)
class _AnchorQuery:
    """How one anchor is picked out of forty thousand multipolygons.

    Two selectors, and the second exists because Luna Park's entrance does not
    have the thing the first one needs.

      * **By name and tag** -- the original, and the right rule wherever the
        feature has a name. Matched on name and tag rather than on way id: an id
        is stable in practice and is exactly the thing that is not stable when a
        mapper splits a way.
      * **By tag, nearest to the fallback point** (`near_m` set, `name` None) --
        for a feature OSM leaves unnamed. The two entrance towers are a bare
        `historic=city_gate` each and the harbour promenade is a bare
        `man_made=pier`; there is nothing to match on but the tag and where the
        thing is. Nearest-to-the-fallback rather than first-found, because
        "first" is whatever order the extract happens to be in and there are two
        city gates and two piers inside the radius.

    `name` is compared with its runs of whitespace collapsed. OSM has the Luna
    Park big wheel as `Ferris  Wheel`, with two spaces, and a literal that
    reproduced the typo would break the day somebody fixed it.
    """

    key: str
    name: str | None
    tag: str
    value: str
    near_m: float | None = None


def _tidy(name: str) -> str:
    return " ".join(name.split())


_ANCHOR_QUERIES: tuple[_AnchorQuery, ...] = (
    _AnchorQuery("bridge_deck", "Sydney Harbour Bridge", "man_made", "bridge"),
    _AnchorQuery("bridge_pylons_s", "Sydney Harbour Bridge - South Pylons", "building", "yes"),
    _AnchorQuery("bridge_pylons_n", "Sydney Harbour Bridge - North Pylons", "building", "yes"),
    _AnchorQuery("opera", "Sydney Opera House", "building", "yes"),
    _AnchorQuery("tower", "Sydney Tower", "man_made", "tower"),
    # --- Luna Park. The entrance first, because it is the landmark.
    _AnchorQuery("luna_gate_w", None, "historic", "city_gate", near_m=60.0),
    _AnchorQuery("luna_gate_e", None, "historic", "city_gate", near_m=60.0),
    _AnchorQuery("luna_gate_roof", None, "building", "roof", near_m=12.0),
    _AnchorQuery("luna_crystal_palace", "Crystal Palace", "building", "yes"),
    _AnchorQuery("luna_coney_island", "Coney Island Funny Land", "building", "yes"),
    # Two polygons carry `name=Big Top`; they are the hall and its annexe, and
    # both are wanted, so they are selected by position rather than by name.
    _AnchorQuery("luna_big_top", "Big Top", "amenity", "events_venue", near_m=40.0),
    _AnchorQuery("luna_big_top_annexe", "Big Top", "amenity", "events_venue", near_m=40.0),
    _AnchorQuery("luna_ferris_wheel", "Ferris Wheel", "attraction", "big_wheel"),
    _AnchorQuery("luna_boardwalk", None, "man_made", "pier", near_m=60.0),
    _AnchorQuery("luna_carousel", "Carousel", "attraction", "amusement_ride"),
    _AnchorQuery("luna_helter_skelter", "Helter Skelter", "man_made", "tower"),
    _AnchorQuery("luna_lounge", "Luna Lounge", "amenity", "bar"),
    _AnchorQuery("luna_administration", "Administration", "building", "yes"),
)

# The measured centroids, as of the extract this was written against. Used when
# the OSM read finds nothing, so that a landmark can never silently vanish from
# the skyline because a mapper renamed a way -- it lands in the right place with
# a coarse outline and the build report says `fallback`. For a `near_m` query
# these are load-bearing rather than a fallback: they are the point the nearest
# match is measured from.
_ANCHOR_FALLBACK: dict[str, tuple[float, float]] = {
    "bridge_deck": (95.6, 1834.1),
    "bridge_pylons_s": (-31.2, 1581.4),
    "bridge_pylons_n": (222.0, 2086.5),
    "opera": (516.3, 1305.5),
    "tower": (-29.4, -188.6),
    "luna_gate_w": (75.9, 2190.4),
    "luna_gate_e": (89.0, 2191.8),
    "luna_gate_roof": (82.4, 2191.0),
    "luna_crystal_palace": (1.5, 2285.8),
    "luna_coney_island": (1.6, 2424.8),
    "luna_big_top": (36.2, 2321.0),
    "luna_big_top_annexe": (25.3, 2357.7),
    "luna_ferris_wheel": (33.9, 2235.8),
    "luna_boardwalk": (-11.7, 2321.6),
    "luna_carousel": (55.0, 2243.3),
    "luna_helter_skelter": (50.2, 2251.2),
    "luna_lounge": (54.8, 2214.0),
    "luna_administration": (64.2, 2281.5),
}


def read_anchors(radius_m: float = 4000.0) -> dict[str, Anchor]:
    """The OSM features the four landmarks are registered to.

    One pass over the `multipolygons` layer, which is the same read
    `osm.read_buildings` does and costs about the same. Deliberately not folded
    into that call: several of these are not buildings at all (the bridge deck is
    `man_made=bridge`, Sydney Tower carries no `building` tag -- which is
    precisely why it has never been in the world -- and Luna Park's wheel and
    promenade are an `attraction` and a `pier`), so a reader filtered to
    buildings could not return them.

    Each candidate is kept only if it **beats what is already held** for that
    key: nearer to the query's point for a `near_m` query, larger in plan for a
    named one. Both rules are there to make the answer independent of the order
    the extract happens to be in, which the previous first-match-wins rule was
    not -- and which mattered the moment Luna Park arrived with two city gates,
    two piers and two polygons called Big Top.
    """
    from .sources import osm

    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = osm._read_layer(osm.PBF_PATH, "multipolygons", bbox)

    found: dict[str, Anchor] = {}
    score: dict[str, float] = {}
    # A `near_m` key may not take the polygon a sibling key has already claimed:
    # the two entrance towers are the same tag 13 m apart, and without this both
    # would settle on whichever one is nearer to both fallbacks.
    claimed: dict[str, str] = {}
    for geom, a in zip(geoms, attrs):
        name = _tidy(a.get("name") or "")
        for q in _ANCHOR_QUERIES:
            if a.get(q.tag) != q.value:
                continue
            if q.name is not None and name != _tidy(q.name):
                continue
            proj = osm._project(geom)
            polys = list(proj.geoms) if proj.geom_type == "MultiPolygon" else [proj]
            poly = max(polys, key=lambda p: p.area)
            if poly.is_empty:
                continue
            c = poly.centroid
            here = (float(c.x), float(c.y))
            if q.near_m is not None:
                pe, pn = _ANCHOR_FALLBACK[q.key]
                rank = math.hypot(here[0] - pe, here[1] - pn)
                if rank > q.near_m:
                    continue
            else:
                rank = -float(poly.area)
            if q.key in score and score[q.key] <= rank:
                continue
            found[q.key] = Anchor(
                name=q.key,
                ring=np.asarray(poly.exterior.coords, dtype=np.float64),
                centroid=here,
                source="osm",
            )
            score[q.key] = rank

    # Sibling keys that landed on the same polygon: the loop above cannot see the
    # clash because it runs per feature, so it is resolved here, by letting the
    # key whose own fallback is nearer keep it and re-reading the other from its
    # fallback outline. In practice this never fires -- the two gates and the two
    # Big Top polygons each sit nearest their own point -- and it is here so that
    # a future double claim is a coarse anchor rather than two towers in one
    # place.
    for q in _ANCHOR_QUERIES:
        if q.near_m is None or q.key not in found:
            continue
        here = found[q.key].centroid
        owner = claimed.get(f"{here[0]:.2f},{here[1]:.2f}")
        if owner is None:
            claimed[f"{here[0]:.2f},{here[1]:.2f}"] = q.key
            continue
        loser = q.key if score[q.key] >= score[owner] else owner
        found.pop(loser)
        score.pop(loser)

    for q in _ANCHOR_QUERIES:
        if q.key not in found:
            e, n = _ANCHOR_FALLBACK[q.key]
            found[q.key] = Anchor(
                name=q.key,
                ring=np.asarray(
                    [(e - 20, n - 20), (e + 20, n - 20), (e + 20, n + 20), (e - 20, n + 20)],
                    dtype=np.float64,
                ),
                centroid=(e, n),
                source="fallback",
            )
    return found


def suppression_zones(anchors: dict[str, Anchor]) -> dict[str, Polygon | MultiPolygon]:
    """The plan area each landmark claims, as one shapely geometry per landmark.

    A generic building whose **centroid** falls inside one of these is dropped
    from the build entirely -- out of the tiles, out of the collision payload and
    out of `far.bin`, because all three are derived from the one building list
    that `cli.cmd_build` filters. The centroid rather than any overlap: a
    terrace on the far side of Macquarie Street clipping the Opera zone by a
    metre is a building, and dropping it would leave a hole in the street wall.

    The bridge zone is the two pylon pairs and the deck outline, unioned. It is
    deliberately **not** the whole 1,149 m corridor: the approach viaducts run
    over real streets in The Rocks and at Milsons Point, and the terraces under
    them are correct -- that is what an elevated approach looks like. What has to
    go is the two 89 m pylon blobs, which are the deck's own structure mapped as
    buildings and would otherwise stand inside the hero pylons.
    """
    zones: dict[str, Polygon | MultiPolygon] = {}

    bridge_parts = [
        Polygon(anchors[k].ring).buffer(SUPPRESS_MARGIN_M)
        for k in ("bridge_deck", "bridge_pylons_s", "bridge_pylons_n")
    ]
    merged = unary_union([p for p in bridge_parts if p.is_valid and not p.is_empty])
    zones["bridge"] = merged if merged.geom_type == "Polygon" else merged.convex_hull

    zones["opera"] = Polygon(anchors["opera"].ring).buffer(SUPPRESS_MARGIN_M)
    # The tower claims its own turret outline *and* the podium it stands on,
    # which is Westfield Sydney -- an 11,753 m2 retail box the pipeline gives
    # 14.7 m because OSM states four levels. The hero podium replaces it at the
    # 30 m the street actually sees. The disc is what catches the small ancillary
    # roofs mapped separately on top of it.
    zones["tower"] = unary_union(
        [
            Polygon(anchors["tower"].ring).buffer(SUPPRESS_MARGIN_M),
            _tower_podium_zone(anchors),
        ]
    )
    # Luna Park's zone is the union of the eleven outlines the hero model is
    # actually built on, and **not** the park's own `tourism=theme_park`
    # boundary, which is 25,146 m2 and reaches north-east over Milsons Point
    # station land and a row of apartment towers that belong in the world. The
    # rule here is the same one the other three zones follow -- "inside the
    # landmark", not "near it" -- and the consequence is that half a dozen small
    # unnamed ride enclosures inside the park survive the build. They should:
    # they are real sheds this model does not replace.
    #
    # It is therefore the one zone here that stays a **MultiPolygon**. The bridge
    # zone collapses to a hull because its three parts are one continuous
    # structure with a deck between them; eleven amusement-park sheds are not,
    # and a hull over them would swallow exactly the station land this paragraph
    # is about. `suppress` and `landmark-audit` both test with `.contains`, which
    # does not care.
    luna = [
        Polygon(anchors[k].ring).buffer(SUPPRESS_MARGIN_M)
        for k in LUNA_GENERIC_TOPS
        if k in anchors
    ]
    zones["luna_park"] = unary_union([p for p in luna if p.is_valid and not p.is_empty])
    return zones


def _tower_podium_zone(anchors: dict[str, Anchor]) -> Polygon:
    """The Centrepoint podium footprint, as a disc about the tower.

    A disc rather than Westfield's own ring, and the reason is that the ring is
    what is being *replaced*: the podium the landmark builds is cut from that
    outline, so a zone that is the outline itself would be exactly self-
    consistent and would say nothing about the half-dozen small roofs OSM maps
    separately on the same block. 62 m covers the podium and stops well short of
    the Strand Arcade and the GPO.
    """
    e, n = anchors["tower"].centroid
    return Polygon([(e + 62.0 * math.cos(t), n + 62.0 * math.sin(t))
                    for t in np.linspace(0, 2 * math.pi, 33)[:-1]])


# --- Geometry primitives -------------------------------------------------------


@dataclass
class Part:
    """One landmark material's accumulating buffers."""

    positions: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    uvs: list[float] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)

    def vertex_count(self) -> int:
        return len(self.positions) // 3

    @property
    def triangles(self) -> int:
        return len(self.indices) // 3


Vec3 = tuple[float, float, float]


def _norm(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else np.array([0.0, 1.0, 0.0])


def _emit_tri(part: Part, idx, pts, normals) -> None:
    """One triangle, wound to agree with its **own** shading normals.

    PER TRIANGLE, NOT PER QUAD, and that is the whole of this function.

    A quad on a doubly-curved surface is not planar, so its two triangles can
    have geometric normals a few degrees either side of the quad's -- and where
    the surface is nearly degenerate, which on the Opera House is the springing
    line of every vault, they can end up on opposite sides of it. Winding the
    quad as a unit then leaves one of its triangles facing away from the normals
    it is shaded by, which back-face culling removes and which reads as a hole in
    a shell that appears and disappears as you walk past it. Six of them survived
    a per-quad rule; `landmark-audit`'s winding pass is what found them.

    Comparing against the *mean of the three vertex normals* is deliberate and is
    the same test the audit applies -- and the same one `mesh.winding_agreement`
    applies to the city. It makes the invariant "a triangle faces the way it is
    shaded", which is what culling actually needs, rather than "a triangle faces
    the way its quad intended".
    """
    a, b, c = (np.asarray(p, dtype=np.float64) for p in pts)
    face = np.cross(b - a, c - a)
    if float(np.linalg.norm(face)) < 1e-9:
        return  # a sliver with no orientation at all; drawing it says nothing
    mean = sum(np.asarray(n, dtype=np.float64) for n in normals)
    if float(np.dot(face, mean)) >= 0.0:
        part.indices.extend(idx)
    else:
        part.indices.extend((idx[0], idx[2], idx[1]))


class _Builder:
    """Mesh accumulation for one landmark, in metres about its own anchor.

    Positions are **local world axes** -- x east, y up, z south -- offset by the
    anchor's plan position and by nothing vertically, so the GLB node carries
    `(anchor_east, 0, -anchor_north)` and every y in the buffers is a real world
    height. That is what lets `landmark-audit` read a height straight out of the
    shipped file and compare it against a published one without knowing anything
    about the node graph.

    WINDING IS COMPUTED, NEVER ASSUMED. Every face here goes through `face()`,
    which takes the outward normal as an argument and flips the triangle order
    when the ring's own right-hand normal disagrees with it. That is a shoelace
    per face and it is the reason this file has no "remember to wind this one
    backwards" comments in it: `mesh.build_walls` shipped 61% of the city facing
    inward for exactly the want of this, and the fix there was to normalise the
    input rather than to remember. Here there is no input to normalise -- the
    geometry is generated -- so the check is at the point of emission.
    """

    def __init__(self, anchor_enu: tuple[float, float]) -> None:
        self.ae, self.an = anchor_enu
        self.parts: dict[str, Part] = {}

    # -- frames

    def w(self, east: float, north: float, y: float) -> np.ndarray:
        """ENU + height -> local world. The one place the north/south flip happens."""
        return np.array([east - self.ae, y, -(north - self.an)], dtype=np.float64)

    def part(self, material: str) -> Part:
        p = self.parts.get(material)
        if p is None:
            p = self.parts[material] = Part()
        return p

    # -- primitives

    def face(self, material: str, pts, normal, uvs=None) -> None:
        """One convex planar polygon, fanned, wound to agree with `normal`."""
        v = [np.asarray(p, dtype=np.float64) for p in pts]
        if len(v) < 3:
            return
        n = _norm(np.asarray(normal, dtype=np.float64))
        # The polygon's own right-hand normal, from the largest triangle of the
        # fan rather than the first -- a fan's first triangle can be degenerate
        # on a shape whose first two edges are nearly colinear, and a degenerate
        # cross product would decide the winding by floating-point noise.
        best = None
        best_area = 0.0
        for i in range(1, len(v) - 1):
            c = np.cross(v[i] - v[0], v[i + 1] - v[0])
            a = float(np.linalg.norm(c))
            if a > best_area:
                best_area, best = a, c
        if best is None or best_area < 1e-12:
            return
        if float(np.dot(best, n)) < 0.0:
            v = v[::-1]
            if uvs is not None:
                uvs = list(uvs)[::-1]
        if uvs is None:
            uvs = _planar_uv(v, n)

        p = self.part(material)
        base = p.vertex_count()
        for pt, uv in zip(v, uvs):
            p.positions.extend((float(pt[0]), float(pt[1]), float(pt[2])))
            p.normals.extend((float(n[0]), float(n[1]), float(n[2])))
            p.uvs.extend((float(uv[0]), float(uv[1])))
        # Fanned per triangle rather than as a block, on `_emit_tri`'s argument:
        # a quad on a curved edge is not planar, and the fan's second triangle
        # can face the other way from the flat normal all four vertices carry.
        for i in range(1, len(v) - 1):
            _emit_tri(
                p,
                (base, base + i, base + i + 1),
                (v[0], v[i], v[i + 1]),
                (n, n, n),
            )

    def strip(self, material: str, row_a, row_b, outward=None, smooth: bool = True) -> None:
        """A quad strip between two equal-length polylines.

        `outward` is a per-vertex normal for `row_a`/`row_b` when the surface is
        curved and should shade smoothly -- the shells and the tower's frusta
        both want that, and both would read as facetted without it. When it is
        None the quads are flat-shaded from their own geometry.
        """
        a = [np.asarray(p, dtype=np.float64) for p in row_a]
        b = [np.asarray(p, dtype=np.float64) for p in row_b]
        if len(a) != len(b) or len(a) < 2:
            return
        if not smooth or outward is None:
            for i in range(len(a) - 1):
                quad = (a[i], a[i + 1], b[i + 1], b[i])
                n = np.cross(quad[1] - quad[0], quad[3] - quad[0])
                if float(np.linalg.norm(n)) < 1e-12:
                    continue
                self.face(material, quad, n)
            return

        # One normal per *column*, shared by both rows. That is the smoothing:
        # two adjacent strips hand the same vertex position two identical
        # normals, so the seam between them shades continuously and a 24-row
        # shell reads as a curved surface rather than as 24 facets.
        p = self.part(material)
        base = p.vertex_count()
        ns = [_norm(np.asarray(v, dtype=np.float64)) for v in outward]
        if len(ns) != len(a):
            raise ValueError(f"strip got {len(ns)} normals for {len(a)} columns")
        for row, vv in ((0, a), (1, b)):
            for i, pt in enumerate(vv):
                p.positions.extend((float(pt[0]), float(pt[1]), float(pt[2])))
                nn = ns[i]
                p.normals.extend((float(nn[0]), float(nn[1]), float(nn[2])))
                p.uvs.extend((i / max(len(a) - 1, 1), float(row)))
        m = len(a)
        for i in range(m - 1):
            a0, a1 = base + i, base + i + 1
            b0, b1 = base + m + i, base + m + i + 1
            _emit_tri(p, (a0, a1, b0), (a[i], a[i + 1], b[i]), (ns[i], ns[i + 1], ns[i]))
            _emit_tri(
                p, (a1, b1, b0), (a[i + 1], b[i + 1], b[i]), (ns[i + 1], ns[i + 1], ns[i])
            )

    def beam(
        self,
        material: str,
        p0,
        p1,
        width: float,
        depth: float,
        up: Vec3 = (0.0, 1.0, 0.0),
    ) -> None:
        """A boxed structural member from `p0` to `p1`. The truss's workhorse.

        `width` is across the member in the plane perpendicular to `up`, `depth`
        along `up`. Both ends are capped, because a chord seen end-on at the
        springing is a real silhouette and an open tube reads as a hole.
        """
        a = np.asarray(p0, dtype=np.float64)
        b = np.asarray(p1, dtype=np.float64)
        axis = b - a
        length = float(np.linalg.norm(axis))
        if length < 1e-6:
            return
        axis /= length
        u = np.asarray(up, dtype=np.float64)
        side = np.cross(axis, u)
        if float(np.linalg.norm(side)) < 1e-6:
            side = np.cross(axis, np.array([1.0, 0.0, 0.0]))
        side = _norm(side) * (width * 0.5)
        vert = _norm(np.cross(side, axis)) * (depth * 0.5)

        corners = [
            a - side - vert, a + side - vert, a + side + vert, a - side + vert,
            b - side - vert, b + side - vert, b + side + vert, b - side + vert,
        ]
        self.face(material, (corners[0], corners[1], corners[2], corners[3]), -axis)
        self.face(material, (corners[4], corners[5], corners[6], corners[7]), axis)
        self.face(material, (corners[0], corners[1], corners[5], corners[4]), -vert)
        self.face(material, (corners[3], corners[2], corners[6], corners[7]), vert)
        self.face(material, (corners[1], corners[2], corners[6], corners[5]), side)
        self.face(material, (corners[0], corners[3], corners[7], corners[4]), -side)

    def prism(
        self,
        material: str,
        ring_local_xz,
        y0: float,
        y1: float,
        cap_top: bool = True,
        cap_bottom: bool = False,
    ) -> None:
        """Extrude a plan ring between two levels. Walls always, caps on request.

        The ring is in **local world (x, z)** and may go round either way; the
        walls take their outward normal from the edge and the cap from the
        shoelace, so neither cares.
        """
        r = np.asarray(ring_local_xz, dtype=np.float64)
        if len(r) > 1 and np.allclose(r[0], r[-1]):
            r = r[:-1]
        if len(r) < 3:
            return
        # Shoelace in (x, z). Positive is clockwise seen from above in this frame
        # (z runs south), which is the sense that gives an upward cap.
        area2 = float(np.dot(r[:, 0], np.roll(r[:, 1], -1)) - np.dot(r[:, 1], np.roll(r[:, 0], -1)))
        ordered = r if area2 > 0 else r[::-1]
        for i in range(len(ordered)):
            x0, z0 = ordered[i]
            x1, z1 = ordered[(i + 1) % len(ordered)]
            edge = np.array([x1 - x0, 0.0, z1 - z0])
            outward = np.cross(np.array([0.0, 1.0, 0.0]), edge)
            self.face(
                material,
                (
                    (x0, y0, z0),
                    (x1, y0, z1),
                    (x1, y1, z1),
                    (x0, y1, z0),
                ),
                outward,
            )
        if cap_top:
            self.cap(material, ordered, y1, up=True)
        if cap_bottom:
            self.cap(material, ordered, y0, up=False)

    def cap(self, material: str, ring_local_xz, y: float, up: bool = True) -> None:
        """A horizontal lid over a plan ring, ear-clipped."""
        r = np.asarray(ring_local_xz, dtype=np.float64)
        if len(r) > 1 and np.allclose(r[0], r[-1]):
            r = r[:-1]
        if len(r) < 3:
            return
        tris = mapbox_earcut.triangulate_float64(r, np.array([len(r)], dtype=np.uint32))
        n = (0.0, 1.0, 0.0) if up else (0.0, -1.0, 0.0)
        idx = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
        for t in idx:
            self.face(material, [(r[i][0], y, r[i][1]) for i in t], n)

    def frustum(
        self,
        material: str,
        cx: float,
        cz: float,
        y0: float,
        y1: float,
        r0: float,
        r1: float,
        segments: int = 24,
        cap_top: bool = False,
        cap_bottom: bool = False,
    ) -> None:
        """A cone frustum about a vertical axis, smooth-shaded around."""
        ang = np.linspace(0.0, 2.0 * math.pi, segments + 1)
        slope = math.atan2(r0 - r1, max(y1 - y0, 1e-6))
        lower = [(cx + r0 * math.cos(t), y0, cz + r0 * math.sin(t)) for t in ang]
        upper = [(cx + r1 * math.cos(t), y1, cz + r1 * math.sin(t)) for t in ang]
        normals = [
            (
                math.cos(t) * math.cos(slope),
                math.sin(slope),
                math.sin(t) * math.cos(slope),
            )
            for t in ang
        ]
        self.strip(material, lower, upper, outward=normals)
        if cap_top:
            self.cap(material, [(u[0], u[2]) for u in upper[:-1]], y1, up=True)
        if cap_bottom:
            self.cap(material, [(u[0], u[2]) for u in lower[:-1]], y0, up=False)


def _planar_uv(pts: list[np.ndarray], n: np.ndarray) -> list[tuple[float, float]]:
    """Metre-scale planar UVs for a face, projected off its own dominant axis.

    Metres rather than 0..1: nothing here is textured from an atlas, and the
    materials that do use `uv` -- the shells' chevron, the deck's lane marking --
    want a world scale, so a 500 m deck and a 2 m parapet cap get the same
    pattern pitch instead of the parapet getting 250 of them.
    """
    a = np.abs(n)
    if a[1] >= a[0] and a[1] >= a[2]:
        return [(float(p[0]), float(p[2])) for p in pts]
    if a[0] >= a[2]:
        return [(float(p[2]), float(p[1])) for p in pts]
    return [(float(p[0]), float(p[1])) for p in pts]


# --- Landmarks -----------------------------------------------------------------


@dataclass
class Prism:
    """One collision volume, in ENU, for the tile that holds its centre.

    Deliberately the same shape as the payload `tiles.write_collision` already
    writes for a building -- a plan ring plus `[base, base + height]` -- because
    the format is what the Bun server parses and this pass has no business
    changing it. An elevated deck is expressible in it exactly: `base` at the
    deck's underside puts the volume over a player's head, and `top` is standable
    through `CollisionWorld.roofHeight`.
    """

    ring: np.ndarray  # (N, 2) ENU
    base: float  # world y
    height: float
    kind: str  # 'deck' | 'parapet' | 'pylon' | 'podium' | 'shell' | 'tower'

    @property
    def centroid(self) -> tuple[float, float]:
        r = self.ring
        return float(r[:, 0].mean()), float(r[:, 1].mean())

    @property
    def tile(self) -> str:
        return geo.tile_for_enu(*self.centroid).key


@dataclass
class Landmark:
    name: str
    anchor_enu: tuple[float, float]
    parts: dict[str, Part]
    prisms: list[Prism]
    audit: dict[str, float]

    @property
    def triangles(self) -> int:
        return sum(p.triangles for p in self.parts.values())

    @property
    def vertices(self) -> int:
        return sum(p.vertex_count() for p in self.parts.values())


# --- The Sydney Harbour Bridge -------------------------------------------------


def _bridge_frame(anchors: dict[str, Anchor]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centre, along, across) in ENU, from the two pylon-pair centroids.

    Taken from the pylons rather than from the deck polygon because the pylons
    are point-like -- two blobs 565 m apart -- where the deck outline is a long
    thin parallelogram whose principal axis is decided by which end OSM drew
    more carefully. The two agree to 0.2 degrees, which is the check.
    """
    s = np.asarray(anchors["bridge_pylons_s"].centroid, dtype=np.float64)
    n = np.asarray(anchors["bridge_pylons_n"].centroid, dtype=np.float64)
    centre = (s + n) * 0.5
    along = _norm2(n - s)
    across = np.array([along[1], -along[0]])
    return centre, along, across


def _norm2(v: np.ndarray) -> np.ndarray:
    d = float(np.hypot(v[0], v[1]))
    return v / d if d > 1e-9 else np.array([0.0, 1.0])


def _bridge_chords(sea: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The arch's two chord curves, as (s, upper y, lower y) node arrays.

    Both are parabolic in `s` and both terminate at the bearing pin, which is
    what a two-hinged arch is: the chords converge to a point at each end and
    there is no truss depth there at all. The *lower* chord takes an exponent
    above one, which pushes its rise outward and opens the truss to its greatest
    depth at about 60% of the half-span -- the shape the real arch has, and the
    reason its silhouette is not a plain crescent.
    """
    half = BRIDGE_ARCH_SPAN * 0.5
    s = np.linspace(-half, half, BRIDGE_PANELS + 1)
    u = s / half
    pin = sea + BRIDGE_BEARING_AHD
    # The chord's **centreline**, so that the top face of the boxed member lands
    # on the published crest. See `BRIDGE_CHORD_DEPTH`.
    top = sea + BRIDGE_ARCH_CREST_AHD - BRIDGE_CHORD_DEPTH * 0.5
    low_crown = top - BRIDGE_CROWN_TRUSS_DEPTH
    shape = np.clip(1.0 - u * u, 0.0, 1.0)
    upper = pin + (top - pin) * shape
    lower = pin + (low_crown - pin) * np.power(shape, BRIDGE_LOWER_CHORD_EXPONENT)
    return s, upper, lower


def build_bridge(anchors: dict[str, Anchor], terrain) -> Landmark:
    """The Harbour Bridge: two arch trusses, a walkable deck, four pylons.

    The order of construction is the order the real thing is read in from a
    kilometre away: the arch first, because it is the whole silhouette; then the
    deck it hangs, because that is what the player stands on; then the pylons,
    which are what make it Sydney's bridge rather than a bridge.
    """
    sea = -terrain.base_elevation
    centre, along, across = _bridge_frame(anchors)
    b = _Builder((float(centre[0]), float(centre[1])))

    def at(s: float, t: float, y: float) -> np.ndarray:
        """A point `s` along the bridge and `t` across it, at world height `y`."""
        e = centre[0] + along[0] * s + across[0] * t
        n = centre[1] + along[1] * s + across[1] * t
        return b.w(e, n, y)

    def enu(s: float, t: float) -> tuple[float, float]:
        return (
            float(centre[0] + along[0] * s + across[0] * t),
            float(centre[1] + along[1] * s + across[1] * t),
        )

    def ground(s: float, t: float = 0.0) -> float:
        e, n = enu(s, t)
        return float(terrain.sample(e, n))

    deck_y = sea + BRIDGE_DECK_AHD
    soffit = deck_y - BRIDGE_DECK_DEPTH
    half_w = BRIDGE_DECK_WIDTH * 0.5
    half_len = BRIDGE_TOTAL_LENGTH * 0.5
    gauge = BRIDGE_ARCH_TRUSS_GAUGE * 0.5

    prisms: list[Prism] = []

    # --- The arch.
    s_nodes, upper, lower = _bridge_chords(sea)
    chord_w, chord_d = BRIDGE_CHORD_WIDTH, BRIDGE_CHORD_DEPTH
    for side in (-gauge, gauge):
        for i in range(len(s_nodes) - 1):
            b.beam(
                "landmark_steel",
                at(s_nodes[i], side, upper[i]),
                at(s_nodes[i + 1], side, upper[i + 1]),
                chord_w, chord_d,
            )
            b.beam(
                "landmark_steel",
                at(s_nodes[i], side, lower[i]),
                at(s_nodes[i + 1], side, lower[i + 1]),
                chord_w, chord_d,
            )
        # Verticals and diagonals. The diagonal alternates direction panel by
        # panel, which is what a Warren web is and what stops the truss reading
        # as a ladder -- a ladder is the single most common way a bridge model
        # goes wrong at distance, because a repeated vertical aliases into a
        # picket fence and a zig-zag does not.
        for i in range(1, len(s_nodes) - 1):
            if upper[i] - lower[i] > 1.0:
                b.beam(
                    "landmark_steel",
                    at(s_nodes[i], side, lower[i]),
                    at(s_nodes[i], side, upper[i]),
                    2.4, 2.4,
                )
        for i in range(len(s_nodes) - 1):
            if i % 2 == 0:
                p0 = at(s_nodes[i], side, lower[i])
                p1 = at(s_nodes[i + 1], side, upper[i + 1])
            else:
                p0 = at(s_nodes[i], side, upper[i])
                p1 = at(s_nodes[i + 1], side, lower[i + 1])
            b.beam("landmark_steel", p0, p1, 1.9, 1.9)

    # Cross bracing between the two arch planes. Every second panel, and only
    # where the chord is clear of the deck -- a transverse strut at deck level is
    # a strut through the traffic.
    for i in range(0, len(s_nodes), 2):
        if upper[i] > deck_y + 4.0:
            b.beam(
                "landmark_steel",
                at(s_nodes[i], -gauge, upper[i]),
                at(s_nodes[i], gauge, upper[i]),
                2.6, 2.6,
            )
        if lower[i] > deck_y + 6.0:
            b.beam(
                "landmark_steel",
                at(s_nodes[i], -gauge, lower[i]),
                at(s_nodes[i], gauge, lower[i]),
                2.2, 2.2,
            )
    for i in range(0, len(s_nodes) - 2, 2):
        if min(upper[i], upper[i + 2]) > deck_y + 4.0:
            b.beam(
                "landmark_steel",
                at(s_nodes[i], -gauge, upper[i]),
                at(s_nodes[i + 2], gauge, upper[i + 2]),
                1.5, 1.5,
            )
            b.beam(
                "landmark_steel",
                at(s_nodes[i], gauge, upper[i]),
                at(s_nodes[i + 2], -gauge, upper[i + 2]),
                1.5, 1.5,
            )

    # Hangers, and the posts that replace them past the crossing point. The two
    # are the same member doing opposite jobs: inboard of |s| = 170 m the lower
    # chord is above the roadway and the deck hangs from it; outboard the chord
    # has dropped below and the deck stands on it.
    for i in range(1, len(s_nodes) - 1):
        for side in (-gauge, gauge):
            if lower[i] > deck_y + 2.0:
                b.beam(
                    "landmark_steel",
                    at(s_nodes[i], side, deck_y),
                    at(s_nodes[i], side, lower[i]),
                    1.2, 1.2,
                )
            elif lower[i] < soffit - 2.0:
                b.beam(
                    "landmark_steel",
                    at(s_nodes[i], side, lower[i]),
                    at(s_nodes[i], side, soffit),
                    2.2, 2.2,
                )

    # The skewbacks: the concrete blocks the pins bear on, which is where 39,000
    # tonnes of arch actually reaches the sandstone.
    for end in (-1.0, 1.0):
        s_pin = end * BRIDGE_ARCH_SPAN * 0.5
        g = min(ground(s_pin), sea + BRIDGE_BEARING_AHD - 6.0)
        ring = [
            (at(s_pin - 14.0 * end, -gauge - 7.0, 0.0)[0], at(s_pin - 14.0 * end, -gauge - 7.0, 0.0)[2]),
            (at(s_pin + 8.0 * end, -gauge - 7.0, 0.0)[0], at(s_pin + 8.0 * end, -gauge - 7.0, 0.0)[2]),
            (at(s_pin + 8.0 * end, gauge + 7.0, 0.0)[0], at(s_pin + 8.0 * end, gauge + 7.0, 0.0)[2]),
            (at(s_pin - 14.0 * end, gauge + 7.0, 0.0)[0], at(s_pin - 14.0 * end, gauge + 7.0, 0.0)[2]),
        ]
        b.prism("landmark_granite", ring, g - 4.0, sea + BRIDGE_BEARING_AHD + 1.5)

    # --- The deck, in three runs: the level 1,149 m, and a descending ramp off
    # each end. `_deck_run` emits the box, the parapets, the piers and the
    # collision segments for a run, so the level deck and the ramps differ only
    # in the level function handed to it.
    def level(_s: float) -> float:
        return deck_y

    _deck_run(b, at, enu, ground, prisms, -half_len, half_len, level, 25.0, soffit, half_w, sea)

    ramp_ends: dict[str, float] = {}
    ramp_clear: dict[str, float] = {}
    for end in (-1.0, 1.0):
        s0 = end * half_len
        run, clearance = _ramp_end(ground, s0, end, deck_y)
        side = "south" if end < 0 else "north"
        ramp_ends[side] = run
        ramp_clear[side] = clearance

        def ramp(s: float, _s0: float = s0) -> float:
            return deck_y - BRIDGE_RAMP_GRADE * abs(s - _s0)

        lo, hi = (s0 - run, s0) if end < 0 else (s0, s0 + run)
        _deck_run(b, at, enu, ground, prisms, lo, hi, ramp, 6.0, None, half_w, sea)

        # The abutment. Zero-height on the southern side, where the descending
        # deck genuinely does meet the ground in The Rocks; a real retaining wall
        # on the northern one, where it does not -- see `_ramp_end`.
        s_end = s0 + end * run
        y_end = ramp(s_end)
        b.prism(
            "landmark_granite",
            _rect_local(at, s_end + end * 6.0, 0.0, 14.0, BRIDGE_DECK_WIDTH + 4.0),
            ground(s_end + end * 6.0) - 3.0,
            y_end,
        )

    # --- The four pylons.
    pylon_s = []
    for key, sign in (("bridge_pylons_s", -1.0), ("bridge_pylons_n", 1.0)):
        c = np.asarray(anchors[key].centroid, dtype=np.float64) - centre
        pylon_s.append(float(np.dot(c, along)))
    for s_p in pylon_s:
        for t_p in (-BRIDGE_PYLON_OFFSET, BRIDGE_PYLON_OFFSET):
            g = ground(s_p, t_p)
            top = sea + BRIDGE_PYLON_TOP_AHD
            _pylon(b, at, s_p, t_p, g - 3.0, top)
            ring = _rect_enu(enu, s_p, t_p, BRIDGE_PYLON_BASE[1], BRIDGE_PYLON_BASE[0])
            prisms.append(Prism(ring, g - 3.0, top - (g - 3.0), "pylon"))

    audit = {
        "deck_y": deck_y,
        "deck_ahd": BRIDGE_DECK_AHD,
        # The top of the steel, which is what the published 134 m measures and
        # what the audit reads out of the shipped file.
        "arch_apex_y": float(upper.max()) + BRIDGE_CHORD_DEPTH * 0.5,
        "arch_apex_ahd": float(upper.max()) + BRIDGE_CHORD_DEPTH * 0.5 - sea,
        "arch_span_m": BRIDGE_ARCH_SPAN,
        "deck_length_m": BRIDGE_TOTAL_LENGTH,
        "ramp_south_m": ramp_ends["south"],
        "ramp_north_m": ramp_ends["north"],
        "ramp_south_clearance_m": ramp_clear["south"],
        "ramp_north_clearance_m": ramp_clear["north"],
        "pylon_top_ahd": BRIDGE_PYLON_TOP_AHD,
        "deck_s_min": -half_len - ramp_ends["south"],
        "deck_s_max": half_len + ramp_ends["north"],
        # The bridge frame, carried so `landmark-audit` can project a collision
        # prism onto the deck's own axis without re-reading OSM. An audit that
        # needed the source data to check the output would be checking the
        # pipeline against itself.
        "axis_east": float(along[0]),
        "axis_north": float(along[1]),
        "deck_width_m": BRIDGE_DECK_WIDTH,
        "parapet_height_m": BRIDGE_PARAPET_HEIGHT,
    }
    return Landmark("harbour_bridge", (float(centre[0]), float(centre[1])), b.parts, prisms, audit)


def _ramp_end(ground, s0: float, end: float, deck_y: float) -> tuple[float, float]:
    """Where the approach ramp stops, and how far it is still above the ground.

    Stepped rather than solved, because the terrain is a sampled lattice and the
    crossing is not analytic.

    THE TWO ENDS OF THIS BRIDGE DO DIFFERENT THINGS and the asymmetry is the
    terrain's, not a fudge. Southward the land climbs into The Rocks -- 21 m AHD
    at the abutment, 34 m 280 m further on -- so a deck descending at 5.5% meets
    it, and the ramp ends at grade. Northward the ground crosses the Milsons
    Point ridge at 36 m and then falls away toward Careening Cove, so a straight
    ramp never catches it; the real Bradfield Highway solves that by *curving*
    into the Warringah Freeway cutting, which is a road alignment problem rather
    than a landmark one.

    So the northern ramp stops at the point of closest approach -- the top of
    that ridge -- and `build_bridge` closes the remaining 8 m with a granite
    abutment. That is what the end of a bridge looks like, and it is honest about
    where this model stops: the approach roads themselves are the streets layer's
    business.

    Returns (run in metres, clearance still remaining at the end).
    """
    step = 5.0
    best_d, best_clear = step, float("inf")
    d = step
    while d <= BRIDGE_RAMP_MAX:
        s = s0 + end * d
        clear = (deck_y - BRIDGE_RAMP_GRADE * d) - ground(s)
        if clear <= 0.5:
            return d, 0.0
        if clear < best_clear:
            best_clear, best_d = clear, d
        d += step
    return best_d, best_clear


def _deck_run(
    b: _Builder,
    at,
    enu,
    ground,
    prisms: list[Prism],
    s_lo: float,
    s_hi: float,
    level,
    seg: float,
    soffit_flat: float | None,
    half_w: float,
    sea: float,
) -> None:
    """One continuous stretch of deck: box, parapets, supports, collision.

    `seg` is the segment length and it is the only thing that differs between
    the level deck and the ramps, for a reason that is gameplay rather than
    looks: a collision prism has one `base` and one `height`, so a sloping deck
    is a staircase and the step is `seg * grade`. `player/controller.ts` steps
    0.42 m, so at 5.5% the ramp segments have to be under 7.6 m or the player
    walks into an invisible wall on the way up. 6 m gives 0.33 m, and the prism
    top is taken at the segment's midpoint so the staircase straddles the visual
    surface instead of floating over it.
    """
    n = max(round((s_hi - s_lo) / seg), 1)
    edges = np.linspace(s_lo, s_hi, n + 1)

    for i in range(n):
        a, c = float(edges[i]), float(edges[i + 1])
        ya, yc = level(a), level(c)
        soffit_a = (soffit_flat if soffit_flat is not None else ya - BRIDGE_DECK_DEPTH)
        soffit_c = (soffit_flat if soffit_flat is not None else yc - BRIDGE_DECK_DEPTH)

        # Running surface.
        b.face(
            "landmark_asphalt",
            (at(a, -half_w, ya), at(c, -half_w, yc), at(c, half_w, yc), at(a, half_w, ya)),
            (0.0, 1.0, 0.0),
        )
        # Soffit and the two fascias.
        b.face(
            "landmark_steel",
            (at(a, -half_w, soffit_a), at(c, -half_w, soffit_c),
             at(c, half_w, soffit_c), at(a, half_w, soffit_a)),
            (0.0, -1.0, 0.0),
        )
        for t_edge in (-half_w, half_w):
            outward = at(a, t_edge * 2.0, 0.0) - at(a, 0.0, 0.0)
            b.face(
                "landmark_steel",
                (at(a, t_edge, soffit_a), at(c, t_edge, soffit_c),
                 at(c, t_edge, yc), at(a, t_edge, ya)),
                outward,
            )
            # Parapet: a solid rail the player cannot wander off, and one they
            # can still jump. Falling into the harbour from 49 m is a feature.
            for inner, outer in (
                (t_edge - math.copysign(0.45, t_edge), t_edge),
            ):
                b.face(
                    "landmark_steel",
                    (at(a, inner, ya), at(c, inner, yc),
                     at(c, inner, yc + BRIDGE_PARAPET_HEIGHT),
                     at(a, inner, ya + BRIDGE_PARAPET_HEIGHT)),
                    -outward,
                )
                b.face(
                    "landmark_steel",
                    (at(a, outer, ya), at(c, outer, yc),
                     at(c, outer, yc + BRIDGE_PARAPET_HEIGHT),
                     at(a, outer, ya + BRIDGE_PARAPET_HEIGHT)),
                    outward,
                )
                b.face(
                    "landmark_steel",
                    (at(a, inner, ya + BRIDGE_PARAPET_HEIGHT),
                     at(c, inner, yc + BRIDGE_PARAPET_HEIGHT),
                     at(c, outer, yc + BRIDGE_PARAPET_HEIGHT),
                     at(a, outer, ya + BRIDGE_PARAPET_HEIGHT)),
                    (0.0, 1.0, 0.0),
                )

        mid = (a + c) * 0.5
        y_mid = level(mid)
        soffit_mid = soffit_flat if soffit_flat is not None else y_mid - BRIDGE_DECK_DEPTH
        deck_ring = _rect_enu(enu, mid, 0.0, c - a, BRIDGE_DECK_WIDTH)
        prisms.append(Prism(deck_ring, soffit_mid, y_mid - soffit_mid, "deck"))
        for t_edge in (-half_w + 0.22, half_w - 0.22):
            prisms.append(
                Prism(
                    _rect_enu(enu, mid, t_edge, c - a, 0.5),
                    y_mid,
                    BRIDGE_PARAPET_HEIGHT,
                    "parapet",
                )
            )

    # Approach piers, on the stretches where the deck is genuinely in the air
    # over land. Skipped over the harbour, where the arch is carrying it, and
    # skipped where the ground has come up to within a few metres of the soffit.
    pier = s_lo + 30.0
    while pier < s_hi - 10.0:
        y = level(pier)
        s_ff = soffit_flat if soffit_flat is not None else y - BRIDGE_DECK_DEPTH
        g = ground(pier)
        if abs(pier) > BRIDGE_ARCH_SPAN * 0.5 + 10.0 and s_ff - g > 6.0 and g > sea + 1.0:
            for t_p in (-17.0, 17.0):
                b.prism(
                    "landmark_granite",
                    _rect_local(at, pier, t_p, 11.0, 9.0),
                    g - 2.0,
                    s_ff,
                )
        pier += 56.0


def _rect_local(at, s: float, t: float, along: float, across: float) -> list[tuple[float, float]]:
    """A plan rectangle about (s, t) in the bridge frame, as local (x, z)."""
    ha, hc = along * 0.5, across * 0.5
    return [
        (at(s - ha, t - hc, 0.0)[0], at(s - ha, t - hc, 0.0)[2]),
        (at(s + ha, t - hc, 0.0)[0], at(s + ha, t - hc, 0.0)[2]),
        (at(s + ha, t + hc, 0.0)[0], at(s + ha, t + hc, 0.0)[2]),
        (at(s - ha, t + hc, 0.0)[0], at(s - ha, t + hc, 0.0)[2]),
    ]


def _rect_enu(enu, s: float, t: float, along: float, across: float) -> np.ndarray:
    ha, hc = along * 0.5, across * 0.5
    return np.asarray(
        [
            enu(s - ha, t - hc),
            enu(s + ha, t - hc),
            enu(s + ha, t + hc),
            enu(s - ha, t + hc),
        ],
        dtype=np.float64,
    )


def _pylon(b: _Builder, at, s: float, t: float, y0: float, y1: float) -> None:
    """One granite pylon, tapered, with the cornice that gives it its cap.

    Four courses rather than a single taper: the real pylons step in twice on
    the way up and carry a heavy cornice, and a plain tapered box reads as a
    chimney. Three extra rings buys the whole difference.
    """
    courses = ((0.0, 1.0), (0.62, 0.93), (0.92, 0.86), (0.955, 0.98), (1.0, 0.95))
    prev = None
    for frac, scale in courses:
        y = y0 + (y1 - y0) * frac
        base_a = BRIDGE_PYLON_BASE[1] * scale
        base_c = BRIDGE_PYLON_BASE[0] * scale
        ring = _rect_local(at, s, t, base_a, base_c)
        if prev is not None:
            py, pring = prev
            for i in range(4):
                x0, z0 = pring[i]
                x1, z1 = pring[(i + 1) % 4]
                x2, z2 = ring[(i + 1) % 4]
                x3, z3 = ring[i]
                edge = np.array([x1 - x0, 0.0, z1 - z0])
                outward = np.cross(np.array([0.0, 1.0, 0.0]), edge)
                b.face(
                    "landmark_granite",
                    ((x0, py, z0), (x1, py, z1), (x2, y, z2), (x3, y, z3)),
                    outward,
                )
        prev = (y, ring)
    b.cap("landmark_granite", prev[1], prev[0], up=True)
    b.cap("landmark_granite", _rect_local(at, s, t, BRIDGE_PYLON_BASE[1], BRIDGE_PYLON_BASE[0]),
          y0, up=False)


# --- The Sydney Opera House ----------------------------------------------------


def _opera_frame(anchors: dict[str, Anchor]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centre, harbourward, across) in ENU, from the footprint's own long axis.

    Principal axis by second moment rather than a hard-coded bearing, so the
    building sits on Bennelong Point the way OSM has it rather than the way this
    file guessed. The sign is fixed by pointing it north: the shells face the
    harbour and the ceremonial stairs face the city, and getting that backwards
    would put the glass walls looking at Circular Quay.
    """
    ring = anchors["opera"].ring
    pts = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
    # The **polygon** centroid, not the mean of the vertices, and the difference
    # is 27 m on this outline: OSM maps the northern half of the podium with four
    # times the vertex density of the southern half, so a vertex mean is dragged
    # 27 m toward the harbour and the whole building would be registered there.
    # The axis is taken off the vertex spread, which is what SVD wants and what
    # the bias does not affect.
    centre = np.asarray(anchors["opera"].centroid, dtype=np.float64)
    d = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(d, full_matrices=False)
    axis = vt[0]
    if axis[1] < 0:
        axis = -axis
    across = np.array([axis[1], -axis[0]])
    return centre, axis, across


@dataclass(frozen=True)
class _Shell:
    """One vault: a ridge in the longitudinal plane, ribbed across to the podium.

    `tail`, `apex` and `mouth` are positions along the group's own axis, in
    metres, harbourward positive: where the vault springs off the podium at the
    back, where it peaks, and where it opens over the foyer. `half_width` is its
    reach either side at the mouth and `flare` how fast it gets there -- the
    vault is a point at the tail and full width at the mouth, which is the
    movement the whole building is read by.
    """

    tail: float
    apex: float
    mouth: float
    apex_ahd: float
    mouth_ahd: float
    half_width: float
    flare: float


def _rib(half_width: float, y_top: float, y_base: float, steps: int) -> np.ndarray:
    """One transverse rib: a pointed arch of two 75.2 m arcs. (steps+1, 2) as (across, y).

    UTZON'S RADIUS LIVES HERE, and it is worth being exact about where, because
    "the shells are cut from one sphere" is true of the building and is not the
    whole truth about how it was built. What the spherical solution actually
    bought -- after four years of failing to build the free-form shapes of the
    competition drawings -- was that **every rib in the building is an arc of the
    same circle**, so the whole roof could be cast from repeated segments of one
    formwork. That is the property this function has: each half of each arch is a
    circular arc of radius `OPERA_SPHERE_RADIUS`, whatever its span and rise.

    The earlier attempt here put the *surface* on the sphere instead, as a lune,
    and it is worth recording why that fails rather than leaving the next reader
    to rediscover it. A patch of a 75.2 m sphere that rises 51 m above the podium
    -- which is what the tallest shell does -- is forced by the sphere's own
    curvature to be about 140 m across in its long direction. Every version of it
    is therefore either a wall or, if narrowed to fit the site, a thin vertical
    fin: a blade about 6 m deep in profile, which renders as a tusk. Two rounds
    of that were built and looked at before this went in.

    The arch, on the other hand, is what the eye actually reads: a 75.2 m arc
    from the ridge down to the podium over a half-span of 20-30 m is nearly
    straight, bulging about 6 m off its own chord, and that faint outward bow is
    exactly the profile of the shells above the forecourt.
    """
    R = OPERA_SPHERE_RADIUS
    a = np.array([0.0, y_top])
    bpt = np.array([half_width, y_base])
    chord = bpt - a
    c = float(np.linalg.norm(chord))
    if c < 0.5 or c > 2 * R:
        # Degenerate: the vault's tail, where the rib has closed to a point. A
        # straight segment, and the floor of 0.5 m is not tidiness -- a 2 cm
        # chord on a 75.2 m circle subtends a fraction of a degree, and the arc
        # through it is numerically indistinguishable from the *major* arc, which
        # is a 150 m bulge. That is exactly the defect this floor was added for:
        # the tail rib of every vault came out as a 166 m fan over Bennelong
        # Point.
        return np.asarray(
            [
                [-half_width + 2.0 * half_width * i / steps,
                 y_base + (y_top - y_base) * (1.0 - abs(2.0 * i / steps - 1.0))]
                for i in range(steps + 1)
            ]
        )
    # The centre sits on the side that makes the arc bow outward and upward, so
    # the arch is convex the way an arch is rather than sagging like a cable.
    outward = _norm2(np.array([chord[1], -chord[0]]))
    if outward[0] < 0:
        outward = -outward
    mid = (a + bpt) * 0.5
    centre = mid - outward * math.sqrt(max(R * R - 0.25 * c * c, 0.0))
    ang0 = math.atan2(a[1] - centre[1], a[0] - centre[0])
    ang1 = math.atan2(bpt[1] - centre[1], bpt[0] - centre[0])
    # The **minor** arc, always, and it is wrapped rather than compared: every
    # chord has two arcs through it, and the naive "go the way that decreases the
    # angle" takes the major one whenever the two endpoints straddle the branch
    # cut of `atan2`. Wrapping the difference into (-pi, pi] can only ever pick
    # the arc under a half-turn, which for R = 75.2 m and a rib of at most 55 m
    # is always the one wanted.
    delta = (ang1 - ang0 + math.pi) % (2.0 * math.pi) - math.pi
    half = steps // 2
    right = np.asarray(
        [
            [centre[0] + R * math.cos(ang0 + delta * i / half),
             centre[1] + R * math.sin(ang0 + delta * i / half)]
            for i in range(half + 1)
        ]
    )
    left = right[1:][::-1] * np.array([-1.0, 1.0])
    return np.vstack((left, right))


def _shell_surface(
    b: _Builder,
    at,
    shell: _Shell,
    off_along: float,
    off_across: float,
    podium_y: float,
    sea: float,
    steps_t: int = 24,
    steps_s: int = 20,
) -> tuple[float, list[np.ndarray], list[np.ndarray]]:
    """Emit one vault. Returns (apex y, the mouth's arch, that arch's normals).

    The vault is a ridge with ribs hung off it, and both halves of that are
    chosen to produce one silhouette:

      * The **ridge** springs off the podium at the vault's tail, rises to the
        apex over the auditorium, and descends again to the mouth over the
        harbour-facing foyer. Two parabolic halves meeting at the apex with zero
        slope, so it is smooth there rather than kinked -- a kink at the top of
        the tallest shell is the one defect on this building that would be
        visible from Circular Quay.
      * The **width** is nothing at the tail and full at the mouth. That is what
        makes the vault come to a point where it lands on the podium at the back
        and stand fully open at the front, which is the shape, and it is why the
        shells read as sails rather than as barrels.

    Emitted twice, 0.55 m apart, outer in shell tile and inner in dark glazing:
    the underside of a shell is a place a player stands, and a single-sided
    surface seen from beneath is a hole in the sky. Normals are taken from the
    parametric derivatives rather than per quad, so a 24 x 20 tessellation of a
    60 m sail shades smoothly instead of reading as a fan of facets.
    """
    apex_y = sea + shell.apex_ahd
    mouth_y = sea + shell.mouth_ahd

    def ridge_y(a: float) -> float:
        """The ridge's height at position `a` along the group's axis.

        A CUSP AT THE APEX, and it is the single most load-bearing curve on this
        building. The obvious construction -- two parabolas meeting with zero
        slope -- is smooth at the top, and smooth at the top is a *dome*: the
        first version of this read as a row of clouds over Bennelong Point.
        Raising the exponent above one makes both halves approach the apex
        steeply and meet in a point, which is what makes the shells read as
        shells at four kilometres.
        """
        if a <= shell.apex:
            span = max(shell.apex - shell.tail, 1e-6)
            u = max((a - shell.tail) / span, 0.0)
            return podium_y + (apex_y - podium_y) * (u ** OPERA_RIDGE_EXPONENT)
        span = max(shell.mouth - shell.apex, 1e-6)
        u = min((shell.mouth - a) / span, 1.0)
        return mouth_y + (apex_y - mouth_y) * (max(u, 0.0) ** OPERA_RIDGE_EXPONENT)

    def width(a: float) -> float:
        u = (a - shell.tail) / max(shell.mouth - shell.tail, 1e-6)
        return shell.half_width * (max(u, 0.0) ** shell.flare)

    def surface(t: float, s: float) -> np.ndarray:
        """`t` runs tail to mouth, `s` runs -1 to 1 across the rib."""
        a = shell.tail + (shell.mouth - shell.tail) * t
        w = width(a)
        rib = _rib(max(w, 0.02), ridge_y(a), podium_y, steps_s)
        i = s * (len(rib) - 1) * 0.5 + (len(rib) - 1) * 0.5
        lo = min(int(i), len(rib) - 2)
        f = i - lo
        across, y = rib[lo] * (1 - f) + rib[lo + 1] * f
        return at(off_along + a, off_across + across, y)

    def normal(t: float, s: float) -> np.ndarray:
        h = 1e-3
        dt = surface(min(t + h, 1.0), s) - surface(max(t - h, 0.0), s)
        ds = surface(t, min(s + h, 1.0)) - surface(t, max(s - h, -1.0))
        n = np.cross(ds, dt)
        if float(np.linalg.norm(n)) < 1e-9:
            return np.array([0.0, 1.0, 0.0])
        n = _norm(n)
        return n if n[1] >= 0 else -n

    # The apex's own parameter is spliced into the sample list rather than left
    # to fall between two of them. It is not a nicety: at 24 uniform steps over a
    # 66 m vault the apex misses by up to 1.4 m of `t`, which on a ridge that
    # steep costs 1.7 m of height -- 2.5% of the published 67 m, and the audit's
    # tolerance is 2%. The tallest point of the Opera House is a number this
    # build is checked against, so it has to be a vertex.
    apex_t = (shell.apex - shell.tail) / max(shell.mouth - shell.tail, 1e-6)
    ts = sorted({i / steps_t for i in range(steps_t + 1)} | {round(apex_t, 6)})

    rows, norms = [], []
    for t in ts:
        row = [surface(t, -1.0 + 2.0 * j / steps_s) for j in range(steps_s + 1)]
        rn = [normal(t, -1.0 + 2.0 * j / steps_s) for j in range(steps_s + 1)]
        rows.append(row)
        norms.append(rn)

    for i in range(len(rows) - 1):
        b.strip("landmark_shell", rows[i], rows[i + 1], outward=norms[i])
        inner_a = [p - 0.55 * n for p, n in zip(rows[i], norms[i])]
        inner_b = [p - 0.55 * n for p, n in zip(rows[i + 1], norms[i + 1])]
        b.strip("landmark_glass", inner_b, inner_a, outward=[-n for n in norms[i]])
    # The rib edges at the mouth and the two springing lines, closed between the
    # outer and inner surfaces so the shell reads as 0.55 m of concrete rather
    # than as paper where a player looks straight at its edge.
    edge, edge_n = rows[-1], norms[-1]
    for j in range(len(edge) - 1):
        b.face(
            "landmark_shell",
            (edge[j], edge[j + 1], edge[j + 1] - 0.55 * edge_n[j + 1], edge[j] - 0.55 * edge_n[j]),
            edge[j] - rows[-2][j],
        )
    for j in (0, steps_s):
        for i in range(len(rows) - 1):
            b.face(
                "landmark_shell",
                (rows[i][j], rows[i + 1][j],
                 rows[i + 1][j] - 0.55 * norms[i + 1][j], rows[i][j] - 0.55 * norms[i][j]),
                rows[i][j] - rows[i][1 if j == 0 else steps_s - 1],
            )
    return apex_y, edge, edge_n


def build_opera(anchors: dict[str, Anchor], terrain) -> Landmark:
    """The Opera House: granite podium, ceremonial stairs, three shell groups."""
    sea = -terrain.base_elevation
    centre, along, across = _opera_frame(anchors)
    b = _Builder((float(centre[0]), float(centre[1])))
    podium_y = sea + OPERA_PODIUM_TOP_AHD

    def at(a_m: float, c_m: float, y: float) -> np.ndarray:
        e = centre[0] + along[0] * a_m + across[0] * c_m
        n = centre[1] + along[1] * a_m + across[1] * c_m
        return b.w(e, n, y)

    prisms: list[Prism] = []

    # --- The podium, from the real outline, simplified to the metre. The whole
    # of the building's plan registration is this ring; everything above it is
    # placed in the frame the ring defines.
    ring = anchors["opera"].ring
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    simple = poly.simplify(1.2, preserve_topology=True)
    plan = np.asarray(simple.exterior.coords, dtype=np.float64)
    if np.allclose(plan[0], plan[-1]):
        plan = plan[:-1]
    ground = float(min(terrain.sample(plan[:, 0], plan[:, 1])))
    local_plan = [(float(b.w(e, n, 0.0)[0]), float(b.w(e, n, 0.0)[2])) for e, n in plan]
    b.prism("landmark_granite", local_plan, ground - 3.0, podium_y, cap_top=True)
    prisms.append(Prism(plan, ground - 3.0, podium_y - (ground - 3.0), "podium"))

    # --- The broad ceremonial stairs, on the southern approach. 22 treads over
    # 34 m, which is the real run and the real riser -- they are shallow, and
    # being shallow is the point: they are a place to sit, not a way in.
    south = float(np.dot(plan - centre, along).min())
    stair_half = 40.0
    riser = (podium_y - (ground + 1.0)) / OPERA_STAIR_STEPS
    tread = OPERA_STAIR_RUN / OPERA_STAIR_STEPS
    for i in range(OPERA_STAIR_STEPS):
        y = ground + 1.0 + riser * (i + 1)
        a0 = south - OPERA_STAIR_RUN + tread * i
        a1 = a0 + tread
        b.face(
            "landmark_granite",
            (at(a0, -stair_half, y), at(a1, -stair_half, y),
             at(a1, stair_half, y), at(a0, stair_half, y)),
            (0.0, 1.0, 0.0),
        )
        b.face(
            "landmark_granite",
            (at(a0, -stair_half, y - riser), at(a0, stair_half, y - riser),
             at(a0, stair_half, y), at(a0, -stair_half, y)),
            at(a0 - 1.0, 0.0, 0.0) - at(a0, 0.0, 0.0),
        )
        # The cheek of the flight, one rectangle per tread rather than one
        # staircase polygon: the profile is re-entrant and every ear clipper in
        # the build wants a simple ring, where 22 overlapping coplanar rectangles
        # stack into exactly the same silhouette for the same number of
        # triangles. Without them the stairs are a set of floating slabs, which
        # is what they looked like from the forecourt.
        for cheek in (-stair_half, stair_half):
            outward = at(0.0, cheek * 2.0, 0.0) - at(0.0, 0.0, 0.0)
            b.face(
                "landmark_granite",
                (at(a0, cheek, ground - 2.0), at(a1, cheek, ground - 2.0),
                 at(a1, cheek, y), at(a0, cheek, y)),
                outward,
            )
    # And the riser at the very foot of the flight, so it meets the forecourt
    # with a face rather than an edge.
    b.face(
        "landmark_granite",
        (at(south - OPERA_STAIR_RUN, -stair_half, ground - 2.0),
         at(south - OPERA_STAIR_RUN, stair_half, ground - 2.0),
         at(south - OPERA_STAIR_RUN, stair_half, ground + 1.0 + riser),
         at(south - OPERA_STAIR_RUN, -stair_half, ground + 1.0 + riser)),
        at(south - OPERA_STAIR_RUN - 1.0, 0.0, 0.0) - at(south - OPERA_STAIR_RUN, 0.0, 0.0),
    )
    # One prism for the whole flight rather than 22: a stair the player can walk
    # up is a ramp with a 0.68 m riser, which `controller.step` cannot climb, and
    # 22 prisms would only make it 22 walls. The flight is a solid block and the
    # player walks up the podium's own edge -- which is what the stairs *are*.
    stair_mid = south - OPERA_STAIR_RUN * 0.5
    stair_ring = np.asarray(
        [
            centre + along * (south - OPERA_STAIR_RUN) + across * -stair_half,
            centre + along * south + across * -stair_half,
            centre + along * south + across * stair_half,
            centre + along * (south - OPERA_STAIR_RUN) + across * stair_half,
        ],
        dtype=np.float64,
    )
    # The stairs a body can climb. One prism the height of the flight is a
    # wall -- the owner: "i cant actually go up its stairs" -- because
    # `player/controller.STEP_HEIGHT` is 0.42 m. So the flight is a staircase
    # of shallow prisms, two per real riser, each a slab from the ground to
    # its own tread height and running from its own tread up to the podium:
    # stacked, they are the stair in section, and every rise is under a step.
    half_steps = OPERA_STAIR_STEPS * 2
    tread = OPERA_STAIR_RUN / half_steps
    for k in range(half_steps):
        top = ground + 1.0 + riser * (k + 1) / 2.0
        near = south - OPERA_STAIR_RUN + tread * k
        ring = np.asarray(
            [
                centre + along * near + across * -stair_half,
                centre + along * south + across * -stair_half,
                centre + along * south + across * stair_half,
                centre + along * near + across * stair_half,
            ],
            dtype=np.float64,
        )
        prisms.append(Prism(ring, ground - 1.0, top - (ground - 1.0), "podium"))
    del stair_mid

    # --- The shells. Three groups: the two auditoria side by side pointing
    # harbourward, and the restaurant to the south-east.
    #
    # Within a group the shells step *down* toward the harbour and their apexes
    # lean the same way, so the tallest sail stands over the stage at the back
    # and the smallest comes to a point over the northern foyer. That ordering
    # is what the silhouette is; reversed, the building reads as a row of tents.
    groups: tuple[tuple[str, float, float, tuple[_Shell, ...]], ...] = (
        # (name, across offset, along offset, shells)
        #
        # Nested rather than merely lined up: within a group each vault's tail
        # sits *under* the one behind it and its mouth stands proud of it, so
        # the group reads as one form breaking into three rather than as three
        # tents in a row. The tallest is the Concert Hall's, over the stage.
        (
            "concert_hall",
            -26.0,
            0.0,
            (
                _Shell(-56.0, -24.0, 10.0, OPERA_SHELL_MAX_AHD, 32.0, 25.0, 0.62),
                _Shell(-36.0, -2.0, 32.0, 53.0, 27.0, 23.0, 0.62),
                _Shell(-14.0, 20.0, 52.0, 39.0, 22.0, 20.0, 0.68),
            ),
        ),
        (
            "joan_sutherland",
            26.0,
            -20.0,
            (
                _Shell(-52.0, -22.0, 8.0, 58.0, 29.0, 23.0, 0.62),
                _Shell(-33.0, -2.0, 28.0, 47.0, 25.0, 21.0, 0.62),
                _Shell(-13.0, 17.0, 46.0, 35.0, 20.0, 18.0, 0.68),
            ),
        ),
        # The Bennelong Restaurant: one small vault to the south-east, about a
        # third the size of the halls'. It is the piece that stops the building
        # reading as a symmetrical pair, and it is the one a player standing on
        # the forecourt is closest to.
        (
            "bennelong",
            30.0,
            -62.0,
            (
                _Shell(-22.0, -6.0, 12.0, 32.0, 21.0, 15.0, 0.7),
                _Shell(-8.0, 6.0, 22.0, 25.0, 18.0, 13.0, 0.75),
            ),
        ),
    )

    shell_apex_max = -1e9
    for _name, off_c, off_a, shells in groups:
        mouth: tuple[list[np.ndarray], list[np.ndarray]] | None = None
        for shell in shells:
            apex_y, edge, edge_n = _shell_surface(b, at, shell, off_a, off_c, podium_y, sea)
            shell_apex_max = max(shell_apex_max, apex_y)
            mouth = (edge, edge_n)

        # The glazed mouth, hung off the frontmost vault's own rib rather than
        # guessed at. That is the difference between a glass wall that fits under
        # the shells and one that reads as a shopfront: the top of this surface
        # *is* the bottom edge of the shell, vertex for vertex, because it was
        # read off it.
        if mouth is not None:
            edge, _ = mouth
            base = [np.array([p[0], podium_y, p[2]]) for p in edge]
            b.strip("landmark_glass", base, list(edge), outward=None, smooth=False)

        # A coarse blocking volume per group. Coarse is right: the shells are not
        # climbable and nobody should be able to stand inside one, and a prism
        # per shell would be a staircase up the side of the Concert Hall.
        gc = centre + along * off_a + across * off_c
        lo = min(s.tail for s in shells) - 4.0
        hi = max(s.mouth for s in shells) + 4.0
        half_c = max(s.half_width for s in shells) + 2.0
        block = np.asarray(
            [
                gc + along * lo + across * -half_c,
                gc + along * hi + across * -half_c,
                gc + along * hi + across * half_c,
                gc + along * lo + across * half_c,
            ],
            dtype=np.float64,
        )
        prisms.append(
            Prism(block, podium_y, sea + max(s.apex_ahd for s in shells) - podium_y, "shell")
        )

    audit = {
        "podium_y": podium_y,
        "podium_ahd": OPERA_PODIUM_TOP_AHD,
        "shell_max_y": shell_apex_max,
        "shell_max_ahd": shell_apex_max - sea,
        "sphere_radius_m": OPERA_SPHERE_RADIUS,
        "podium_area_m2": float(simple.area),
    }
    return Landmark("opera_house", (float(centre[0]), float(centre[1])), b.parts, prisms, audit)


# --- Sydney Tower --------------------------------------------------------------


def build_tower(anchors: dict[str, Anchor], terrain) -> Landmark:
    """Sydney Tower: podium, white stalk, gold turret, spire, 56 cables.

    The one landmark of the four that is not in the world at all today, and the
    reason is a tagging accident rather than a modelling one: OSM carries it as
    `man_made=tower` with no `building` key, and `osm.read_buildings` filters on
    `building`. So the tallest structure in Sydney has never had a footprint in
    the buildings table, has never had a `far.bin` slab, and is missing from
    every horizon in the game.
    """
    e0, n0 = anchors["tower"].centroid
    b = _Builder((e0, n0))
    base_y = float(terrain.sample(e0, n0))
    prisms: list[Prism] = []

    # --- The podium. Cut from Westfield Sydney's own outline, which is the block
    # the tower stands on, and raised to the 30 m the street actually sees --
    # OSM states four levels and the pipeline believed it, which is why the
    # tallest thing in Sydney was standing on a 14.7 m box.
    podium_ring = _podium_ring(e0, n0)
    podium_top = base_y + TOWER_PODIUM_HEIGHT
    local = [(float(b.w(e, n, 0.0)[0]), float(b.w(e, n, 0.0)[2])) for e, n in podium_ring]
    b.prism("landmark_granite", local, base_y - 4.0, podium_top, cap_top=True)
    # A glazed band around the podium at street level, so a 30 m masonry box
    # does not read as a bunker from the footpath.
    inset = Polygon(podium_ring).buffer(-0.6)
    if inset.is_valid and not inset.is_empty and inset.geom_type == "Polygon":
        band = np.asarray(inset.exterior.coords, dtype=np.float64)[:-1]
        b.prism(
            "landmark_glass",
            [(float(b.w(e, n, 0.0)[0]), float(b.w(e, n, 0.0)[2])) for e, n in band],
            base_y + 18.0,
            base_y + 26.0,
            cap_top=False,
        )
    prisms.append(
        Prism(podium_ring, base_y - 4.0, TOWER_PODIUM_HEIGHT + 4.0, "podium")
    )

    # --- The stalk. Drawn from the podium roof rather than from the ground: the
    # 30 m below it is inside the podium and would be 24 hidden quads.
    turret_bottom = base_y + TOWER_TURRET_BOTTOM
    b.frustum(
        "landmark_shell", 0.0, 0.0, podium_top, turret_bottom,
        TOWER_SHAFT_RADIUS + 0.5, TOWER_SHAFT_RADIUS, segments=20,
    )
    # The stalk's collision, as an octagon rather than a circle: eight planes is
    # enough to stop a player at a 6.7 m cylinder and the prism test is per edge.
    prisms.append(
        Prism(
            _disc_enu(e0, n0, TOWER_SHAFT_RADIUS + 0.6, 8),
            podium_top,
            TOWER_TURRET_BOTTOM - TOWER_PODIUM_HEIGHT,
            "tower",
        )
    )

    # --- The gold turret, as the stack of frusta it visibly is.
    for (h0, r0), (h1, r1) in itertools.pairwise(TOWER_TURRET_PROFILE):
        b.frustum("landmark_gold", 0.0, 0.0, base_y + h0, base_y + h1, r0, r1, segments=32)
    b.cap("landmark_gold", _disc_local(TOWER_TURRET_PROFILE[0][1], 32), base_y + TOWER_TURRET_BOTTOM, up=False)
    # The observation band's glazing, recessed a little so it reads as a window
    # rather than as a stripe of paint.
    b.frustum("landmark_glass", 0.0, 0.0, base_y + 247.0, base_y + 250.6, 15.35, 15.45, segments=32)
    prisms.append(
        Prism(
            _disc_enu(e0, n0, 12.8, 10),
            base_y + TOWER_TURRET_BOTTOM,
            TOWER_TURRET_TOP - TOWER_TURRET_BOTTOM,
            "tower",
        )
    )

    # --- The spire, to the published 309 m.
    b.frustum("landmark_shell", 0.0, 0.0, base_y + TOWER_TURRET_TOP, base_y + 292.0, 2.0, 0.9, segments=12)
    b.frustum("landmark_steel", 0.0, 0.0, base_y + 292.0, base_y + TOWER_TOTAL_HEIGHT, 0.9, 0.22,
              segments=8, cap_top=True)

    # --- The 56 cables. Four anchor rings on the podium roof rather than one, so
    # the fan has depth from every bearing instead of collapsing to a cone
    # outline when seen square on.
    anchor_y = podium_top
    top_r = TOWER_TURRET_PROFILE[0][1] + 0.4
    for i in range(TOWER_CABLES):
        theta = 2.0 * math.pi * i / TOWER_CABLES
        radius = (30.0, 34.0, 38.0, 42.0)[i % 4]
        p0 = np.array([top_r * math.cos(theta), base_y + TOWER_TURRET_BOTTOM + 1.0, top_r * math.sin(theta)])
        p1 = np.array([radius * math.cos(theta), anchor_y, radius * math.sin(theta)])
        b.beam("landmark_steel", p0, p1, 0.22, 0.22)

    audit = {
        "base_y": base_y,
        "podium_top_y": podium_top,
        "spire_y": base_y + TOWER_TOTAL_HEIGHT,
        "height_m": TOWER_TOTAL_HEIGHT,
        "turret_bottom_y": turret_bottom,
        "turret_top_y": base_y + TOWER_TURRET_TOP,
        "cables": float(TOWER_CABLES),
    }
    return Landmark("sydney_tower", (e0, n0), b.parts, prisms, audit)


def _podium_ring(e0: float, n0: float) -> np.ndarray:
    """The tower podium's plan, from Westfield Sydney where OSM has it.

    Falls back to a 96 m square about the tower when `read_podium_ring` came back
    without it -- the podium is what the shaft stands on, and a tower rising out
    of bare footpath is a worse failure than a podium a few metres off its title
    boundary.
    """
    if _WESTFIELD_RING is not None:
        return _WESTFIELD_RING
    half = 48.0
    return np.asarray(
        [
            (e0 - half, n0 - half), (e0 + half, n0 - half),
            (e0 + half, n0 + half), (e0 - half, n0 + half),
        ],
        dtype=np.float64,
    )


# Filled by `read_podium_ring`, which the build calls once. Module-level because
# `build_tower` is pure geometry and should not be doing a 40,000-feature OSM
# read in the middle of itself.
_WESTFIELD_RING: np.ndarray | None = None


def read_podium_ring(radius_m: float = 4000.0) -> np.ndarray | None:
    """Westfield Sydney's outline, simplified, for the tower podium."""
    global _WESTFIELD_RING
    from .sources import osm

    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = osm._read_layer(osm.PBF_PATH, "multipolygons", bbox)
    for geom, a in zip(geoms, attrs):
        if (a.get("name") or "") != "Westfield Sydney" or not a.get("building"):
            continue
        proj = osm._project(geom)
        polys = list(proj.geoms) if proj.geom_type == "MultiPolygon" else [proj]
        poly = max(polys, key=lambda p: p.area)
        simple = poly.simplify(1.5, preserve_topology=True)
        r = np.asarray(simple.exterior.coords, dtype=np.float64)
        _WESTFIELD_RING = r[:-1] if np.allclose(r[0], r[-1]) else r
        return _WESTFIELD_RING
    return None


def _disc_local(radius: float, segments: int) -> list[tuple[float, float]]:
    return [
        (radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments))
        for i in range(segments)
    ]


def _disc_enu(e0: float, n0: float, radius: float, segments: int) -> np.ndarray:
    return np.asarray(
        [
            (e0 + radius * math.cos(2 * math.pi * i / segments),
             n0 + radius * math.sin(2 * math.pi * i / segments))
            for i in range(segments)
        ],
        dtype=np.float64,
    )


# --- Luna Park -----------------------------------------------------------------
#
# The other three landmarks are read from a kilometre away and are modelled to
# their silhouettes. Luna Park is read from the Milsons Point wharf, from the
# bridge deck and from the water off Lavender Bay -- two hundred metres, not two
# thousand -- and what is being recognised is not a shape but a *face*. So the
# triangles go on the face, and the halls behind it are what they are: painted
# sheds with roofs on.
#
# THE GROUND IS THE PROBLEM HERE AND IT IS WORTH NAMING BEFORE ANY GEOMETRY.
# The real park is flat, three or four metres above the harbour, on reclaimed
# land behind a seawall. This world's terrain is solved from a DEM that has the
# Milsons Point cliff running straight through the site: -3.5 m AHD at the
# water's edge and +25 m AHD eighty metres inland, a rise of nine and a half
# metres between the two entrance towers, which stand thirteen metres apart. The
# model cannot flatten that -- the terrain is baked, and the streets and the
# station above the park are solved against it, so a landmark that levelled its
# own ground would leave a cliff of daylight around itself.
#
# So the park is built the way the city around it is: one flat pad per structure
# at its own footprint centroid, walls run down past the lowest ground under that
# footprint so nothing can float, and where two structures have to *look* like a
# pair -- the entrance towers -- they share one pad and the uphill one buries its
# plinth rather than standing nine metres higher. Matched tops, buried plinth.


def _luna_grow(ring, by: float) -> np.ndarray:
    """A footprint pushed outwards, mitred, with its collinear noise removed.

    Mitred rather than rounded because these are all rectangular buildings and a
    rounded buffer puts sixteen vertices on every corner of a shed; simplified
    afterwards because OSM traces Crystal Palace with a vertex every two metres
    and a thirteen-bay wall does not need twenty-six of them.
    """
    poly = Polygon(np.asarray(ring, dtype=np.float64)).buffer(
        by, join_style=2, mitre_limit=2.0
    )
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    poly = poly.simplify(0.35, preserve_topology=True)
    r = np.asarray(poly.exterior.coords, dtype=np.float64)
    return r[:-1] if np.allclose(r[0], r[-1]) else r


def _luna_local(b: _Builder, ring) -> list[tuple[float, float]]:
    """An ENU ring in the builder's local (x, z). `w()` with the height dropped."""
    return [(float(e - b.ae), float(-(n - b.an))) for e, n in np.asarray(ring)]


def _luna_out(b: _Builder, direction) -> np.ndarray:
    """An ENU direction as a world-space vector, for `face`'s outward normal."""
    return np.array([float(direction[0]), 0.0, -float(direction[1])])


def _luna_pad(terrain, ring) -> tuple[float, float]:
    """`(pad, floor)` for one footprint: where it stands, and how deep it buries.

    The pad is the ground at the footprint's own centroid -- `mesh.WALL_SKIRT`'s
    convention, whose argument applies here word for word: a real building sits
    on a levelled pad, and a tilted hall is far worse than a pad that daylight-
    cuts into a slope. The floor is the lowest ground anywhere under the
    footprint, less a metre and a half, which is what closes the gap the pad
    opens on the downhill side. Unlike `mesh` there is no ceiling on that depth:
    Crystal Palace's footprint spans seventeen metres of the DEM's cliff, and a
    capped skirt on it is a hole a player can look up through.
    """
    poly = Polygon(np.asarray(ring, dtype=np.float64))
    c = poly.centroid
    pad = float(terrain.sample(float(c.x), float(c.y)))
    low = min(float(terrain.sample(float(e), float(n))) for e, n in np.asarray(ring))
    return pad, min(low, pad) - LUNA_SKIRT_MIN


def _luna_rect(ring):
    """`(corners, along, length, width, centre)` of a footprint's minimum rectangle.

    `corners` is rolled so that `corners[0] -> corners[1]` is always a long edge.
    Returns None when the rectangle is more than a third bigger than the
    footprint it encloses, which is this function saying *do not put a hip roof
    on me*: Crystal Palace, Coney Island and the Big Top are parallelograms whose
    rectangles fit within a per cent, where the Administration building is a bent
    L whose rectangle is nearly three times its area -- and a hip roof built on
    that would float over the yard next door.
    """
    poly = Polygon(np.asarray(ring, dtype=np.float64))
    rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon" or rect.area > 1.35 * poly.area:
        return None
    p = np.asarray(rect.exterior.coords, dtype=np.float64)[:-1]
    if len(p) != 4:
        return None
    e0, e1 = p[1] - p[0], p[2] - p[1]
    l0, l1 = float(np.linalg.norm(e0)), float(np.linalg.norm(e1))
    if l0 < l1:
        p = np.roll(p, -1, axis=0)
        e0, l0, l1 = e1, l1, l0
    return p, e0 / max(l0, 1e-9), l0, l1, p.mean(axis=0)


def _luna_roof_face(b: _Builder, material: str, pts) -> None:
    """One roof plane, wound to face upwards."""
    v = [np.asarray(q, dtype=np.float64) for q in pts]
    n = np.cross(v[1] - v[0], v[2] - v[0])
    if float(np.linalg.norm(n)) < 1e-9:
        return
    b.face(material, v, -n if n[1] < 0.0 else n)


def _luna_hip(b: _Builder, material: str, ring, y_eaves: float, y_ridge: float) -> None:
    """A hip roof: two trapezoids over the long walls, a triangle over each end.

    Built on the minimum rotated rectangle rather than on the footprint itself,
    which is a straight-skeleton problem this file has no business solving for
    six sheds -- and which would answer the same thing anyway, because every one
    of them is a parallelogram. A footprint that will not take a rectangle gets a
    flat lid instead, which is a roof form and not a failure.
    """
    fit = _luna_rect(ring)
    if fit is None:
        b.cap(material, _luna_local(b, _luna_grow(ring, 0.45)), y_eaves, up=True)
        return
    p, u, length, width, centre = fit
    half = max((length - width) * 0.5, 0.6)
    r0, r1 = centre - u * half, centre + u * half

    def at(q, y):
        return b.w(float(q[0]), float(q[1]), y)

    _luna_roof_face(b, material, (at(p[0], y_eaves), at(p[1], y_eaves),
                                  at(r1, y_ridge), at(r0, y_ridge)))
    _luna_roof_face(b, material, (at(p[2], y_eaves), at(p[3], y_eaves),
                                  at(r0, y_ridge), at(r1, y_ridge)))
    _luna_roof_face(b, material, (at(p[1], y_eaves), at(p[2], y_eaves), at(r1, y_ridge)))
    _luna_roof_face(b, material, (at(p[3], y_eaves), at(p[0], y_eaves), at(r0, y_ridge)))


def _luna_vault(b: _Builder, material: str, ring, y_eaves: float, y_crown: float,
                steps: int = 8) -> None:
    """A shallow segmental vault along a footprint's long axis. The Big Top's roof.

    A parabola rather than a circular arc, because the rise wanted here is a
    seventh of the span and a circular segment that shallow is indistinguishable
    from one -- and a parabola is two multiplies where an arc is a `sin`.

    The two gables are emitted with the vault's own axis as their outward normal
    rather than through `_luna_roof_face`, which decides winding by which way is
    up: a gable is vertical, its `n[1]` is zero, and the tie-break would be
    floating-point noise -- a gable culled away is a hole into the shed.
    """
    fit = _luna_rect(ring)
    if fit is None:
        b.cap(material, _luna_local(b, _luna_grow(ring, 0.45)), y_eaves, up=True)
        return
    _p, u, length, width, centre = fit
    across = np.array([-u[1], u[0]])
    rows = []
    for end in (-0.5, 0.5):
        row = []
        for k in range(steps + 1):
            t = -1.0 + 2.0 * k / steps
            q = centre + u * (length * end) + across * (width * 0.5 * t)
            row.append(b.w(float(q[0]), float(q[1]),
                           y_eaves + (y_crown - y_eaves) * (1.0 - t * t)))
        rows.append(row)
    b.strip(material, rows[0], rows[1])
    b.face(material, rows[0], _luna_out(b, -u))
    b.face(material, rows[1], _luna_out(b, u))


def _luna_bays(b: _Builder, material: str, p0, p1, centre, count: int,
               y0: float, y1: float, proud: float = 0.09, fill: float = 0.62) -> None:
    """`count` panels along one wall, stood `proud` of it. The bay rhythm.

    Panels rather than pilasters, and the reason is triangles: a panel is one
    quad where a pilaster is a six-sided box, and at the distance this park is
    read from the eye takes the *rhythm* either way. Thirteen bays on two storeys
    of Crystal Palace's two long walls is 104 triangles.
    """
    a, c = np.asarray(p0, dtype=np.float64), np.asarray(p1, dtype=np.float64)
    span = c - a
    length = float(np.linalg.norm(span))
    if length < 1e-6 or count < 1:
        return
    u = span / length
    out = np.array([u[1], -u[0]])
    if float(np.dot(out, (a + c) * 0.5 - np.asarray(centre, dtype=np.float64))) < 0.0:
        out = -out
    pitch = length / count
    normal = _luna_out(b, out)
    for i in range(count):
        lo = a + u * (pitch * (i + 0.5 - fill * 0.5)) + out * proud
        hi = a + u * (pitch * (i + 0.5 + fill * 0.5)) + out * proud
        b.face(
            material,
            (b.w(float(lo[0]), float(lo[1]), y0), b.w(float(hi[0]), float(hi[1]), y0),
             b.w(float(hi[0]), float(hi[1]), y1), b.w(float(lo[0]), float(lo[1]), y1)),
            normal,
        )


def _luna_hall(
    b: _Builder,
    terrain,
    ring,
    *,
    eaves: float,
    ridge: float,
    wall: str = "landmark_paint_white",
    roof: str = "landmark_steel",
    trim: str | None = "landmark_paint_red",
    bays: int = 0,
    bay_material: str = "landmark_glass",
    vault: bool = False,
) -> tuple[np.ndarray, float, float, float]:
    """One painted shed: walls on a pad, two trim bands, a roof, a bay rhythm.

    Returns `(grown ring, pad, lowest ground, eaves y)`, which is everything the
    caller needs to hang a collision prism and a set of corner pavilions off the
    same outline it just built.
    """
    grown = _luna_grow(ring, LUNA_ENVELOPE_M)
    pad, floor = _luna_pad(terrain, grown)
    y_eaves = pad + eaves
    b.prism(wall, _luna_local(b, grown), floor, y_eaves, cap_top=False)
    if vault:
        _luna_vault(b, roof, grown, y_eaves, pad + ridge)
    else:
        _luna_hip(b, roof, grown, y_eaves, pad + ridge)
    if trim is not None:
        # A string course between the two storeys and a cornice under the eaves.
        # Bands with a shadow under them rather than painted stripes, because
        # that is what stops a sixty-metre wall reading as a plane.
        band = _luna_local(b, _luna_grow(grown, 0.16))
        b.prism(trim, band, pad + eaves * 0.5 - 0.28, pad + eaves * 0.5 + 0.28, cap_top=False)
        b.prism(trim, band, y_eaves - 0.75, y_eaves, cap_top=False)
    if bays:
        fit = _luna_rect(grown)
        if fit is not None:
            p, _u, _l, _w, centre = fit
            for a0, a1 in ((p[0], p[1]), (p[2], p[3])):
                _luna_bays(b, bay_material, a0, a1, centre, bays,
                           pad + 1.2, pad + eaves * 0.5 - 0.5)
                _luna_bays(b, bay_material, a0, a1, centre, bays,
                           pad + eaves * 0.5 + 0.5, y_eaves - 1.15)
    return grown, pad, floor + LUNA_SKIRT_MIN, y_eaves


def _luna_prism(ring, base: float, top: float, kind: str) -> Prism:
    """A structure's collision volume: its own outline, from the ground to its top.

    From the **lowest ground under the footprint** rather than from the pad, and
    that is a deliberate departure from what `mesh` does for the generic city.
    A generic prism starts at the pad because a generic footprint spans half a
    metre of fall; Crystal Palace's spans seventeen, and a prism starting at its
    pad would leave a player able to walk in under the downhill wall and stand
    inside the hall looking up at the underside of nothing.
    """
    return Prism(np.asarray(ring, dtype=np.float64), base, max(top - base, 0.5), kind)


def _luna_face_frame(anchors: dict[str, Anchor]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """`(centre, right, outward)` in ENU for the entrance, from the two gate towers.

    Taken from the towers rather than from the canopy between them because the
    towers are point-like where the canopy is a 9 m strip -- and because the pair
    is what has to be square to the Face. The whole entrance is one composition,
    and a face rotated two degrees off its own towers is the kind of wrongness
    that has no name and is immediately visible.

    Outward is the gate line turned a quarter turn toward the **south**, which is
    Milsons Point wharf, which is where the queue is.
    """
    w = np.asarray(anchors["luna_gate_w"].centroid, dtype=np.float64)
    e = np.asarray(anchors["luna_gate_e"].centroid, dtype=np.float64)
    right = _norm2(e - w)
    outward = np.array([right[1], -right[0]])
    if outward[1] > 0.0:
        outward = -outward
    return (w + e) * 0.5, right, outward


# How far south of the gate line the Face stands. The west tower's outline
# reaches 2.9 m south of that line, so anything less than about 3.5 saws the coin
# in half on the tower it is supposed to hang between.
LUNA_FACE_STANDOFF = 3.6


def _luna_face(b: _Builder, anchors: dict[str, Anchor], pad: float) -> float:
    """The Face: a rayed coin with a grin on it, hung across the entrance block.

    Modelled as a **relief on a coin** rather than as a moulded head, and the
    argument is the Opera House chevron's: what carries at two hundred metres is
    the arrangement of flat colours, not the modelling. The real thing is painted
    sheet metal on a frame anyway.

    The stack, front to back, is nine layers deep and each is a couple of
    centimetres proud of the one behind it -- sunburst, face disc, eyes, irises,
    pupils, brows, lips, teeth and their gaps, and the dark of the mouth, which
    is the doorway and is why it is the darkest thing on the composition.

    Returns the y of the top of the surround, which is what the entrance block
    behind it has to reach.
    """
    centre, right, outward = _luna_face_frame(anchors)
    origin = centre + outward * LUNA_FACE_STANDOFF
    y0 = pad + LUNA_FACE_CENTRE
    r_axis = _luna_out(b, right)
    o_axis = _luna_out(b, outward)
    base = b.w(float(origin[0]), float(origin[1]), y0)

    def fp(u: float, v: float, o: float) -> np.ndarray:
        return base + r_axis * u + np.array([0.0, v, 0.0]) + o_axis * o

    def disc(material: str, cu: float, cv: float, o: float, radius: float,
             segments: int = 20, squash: float = 1.0) -> None:
        b.face(
            material,
            [fp(cu + radius * math.cos(2 * math.pi * i / segments),
                cv + radius * squash * math.sin(2 * math.pi * i / segments), o)
             for i in range(segments)],
            o_axis,
        )

    def panel(material: str, u0: float, u1: float, v0: float, v1: float, o: float) -> None:
        b.face(material, (fp(u0, v0, o), fp(u1, v0, o), fp(u1, v1, o), fp(u0, v1, o)), o_axis)

    # --- The sunburst, as a twelve-point star: 24 arc points on alternating
    # radii, fanned from the centre and painted a triangle at a time. A plain
    # two-tone disc reads as a pinwheel; the alternating radius is what makes
    # them rays, and the rays are what carry the object at range because they are
    # the part of it with two colours in it.
    rays, half = 24, 0.28
    arc_f, arc_b = [], []
    for i in range(rays):
        t = 2 * math.pi * i / rays
        rr = LUNA_SUNBURST_RADIUS if i % 2 == 0 else LUNA_SUNBURST_RADIUS * 0.68
        arc_f.append(fp(rr * math.cos(t), rr * math.sin(t), half))
        arc_b.append(fp(rr * math.cos(t), rr * math.sin(t), -half))
    hub = fp(0.0, 0.0, half)
    for i in range(rays):
        b.face(
            "landmark_paint_yellow" if i % 2 == 0 else "landmark_paint_red",
            (hub, arc_f[i], arc_f[(i + 1) % rays]),
            o_axis,
        )
    b.face("landmark_paint_white", arc_b, -o_axis)
    b.strip("landmark_paint_white", arc_b + [arc_b[0]], arc_f + [arc_f[0]])

    # --- The Face itself: the published nine metres across, cream, with a rim so
    # it stands off the sunburst rather than reading as paint on it.
    r_face = LUNA_FACE_WIDTH * 0.5
    o = half + 0.22
    rim_a = [fp(r_face * math.cos(2 * math.pi * i / 28),
                r_face * math.sin(2 * math.pi * i / 28), half) for i in range(28)]
    rim_b = [fp(r_face * math.cos(2 * math.pi * i / 28),
                r_face * math.sin(2 * math.pi * i / 28), o) for i in range(28)]
    b.strip("landmark_paint_white", rim_a + [rim_a[0]], rim_b + [rim_b[0]])
    b.face("landmark_paint_white", rim_b, o_axis)

    # --- Eyes: wide-set and high, which is most of why the thing reads as
    # cheerful rather than as a moon.
    for side in (-1.0, 1.0):
        disc("landmark_paint_white", side * 1.80, 1.45, o + 0.04, 1.15, 16)
        disc("landmark_paint_blue", side * 1.80, 1.45, o + 0.08, 0.74, 16)
        disc("landmark_glass", side * 1.80, 1.38, o + 0.12, 0.30, 12)
        panel("landmark_paint_red", side * 2.85, side * 0.80, 2.80, 3.20, o + 0.04)

    # --- The grin, and getting it to read as one took two looks at the sheet.
    #
    # The first pass built the mouth as an ellipse of teeth inside an ellipse of
    # lip, which came out *neutral at best*: an ellipse's upper edge is highest
    # in the middle and falls away at the corners, which is the shape of a frown,
    # and the face read as one shouting rather than one grinning. The second
    # pass tried to shave the top off that with a big cream lens -- and the
    # cream is the same paint as the teeth, so the lens and the teeth merged into
    # one white blob wider than the lips it was supposed to be inside.
    #
    # So the mouth is drawn as what it is: **three concentric arcs of one big
    # circle whose centre is up on the forehead**. Every boundary in it curves
    # the same way, downward in the middle and up at the corners, because they
    # are all struck from the same point -- which is the definition of a smile
    # and needs no cutting. Lips outside, teeth inside them, a dark band along
    # the bottom for the inside of the mouth, and seven radial gaps in the teeth
    # that fan with the arc instead of standing vertical.
    #
    # Each band is emitted as its own quads with the Face's own outward normal
    # rather than through `cap` or `face`: an annular sector is not convex, and
    # `face` fans its polygon from the first vertex, which on a crescent puts
    # half the triangles outside the shape.
    smile_c, smile_span = 3.05, 0.66

    def arc_band(material: str, r_in: float, r_out: float, span: float, depth: float,
                 steps: int = 14) -> None:
        for i in range(steps):
            t0 = -span + 2.0 * span * i / steps
            t1 = -span + 2.0 * span * (i + 1) / steps
            b.face(
                material,
                (fp(r_in * math.sin(t0), smile_c - r_in * math.cos(t0), depth),
                 fp(r_in * math.sin(t1), smile_c - r_in * math.cos(t1), depth),
                 fp(r_out * math.sin(t1), smile_c - r_out * math.cos(t1), depth),
                 fp(r_out * math.sin(t0), smile_c - r_out * math.cos(t0), depth)),
                o_axis,
            )

    arc_band("landmark_paint_red", 4.35, 6.20, smile_span, o + 0.04)
    arc_band("landmark_paint_white", 4.75, 5.72, smile_span * 0.93, o + 0.08, steps=12)
    arc_band("landmark_glass", 5.72, 6.00, smile_span * 0.93, o + 0.08, steps=12)
    for i in range(7):
        t = -smile_span * 0.80 + 2.0 * smile_span * 0.80 * (i + 0.5) / 7.0
        b.face(
            "landmark_paint_red",
            (fp(4.75 * math.sin(t - 0.014), smile_c - 4.75 * math.cos(t - 0.014), o + 0.12),
             fp(4.75 * math.sin(t + 0.014), smile_c - 4.75 * math.cos(t + 0.014), o + 0.12),
             fp(5.72 * math.sin(t + 0.014), smile_c - 5.72 * math.cos(t + 0.014), o + 0.12),
             fp(5.72 * math.sin(t - 0.014), smile_c - 5.72 * math.cos(t - 0.014), o + 0.12)),
            o_axis,
        )
    # A nose, one triangle of it: without one the eyes and the mouth are two
    # separate objects sitting on a plate.
    b.face("landmark_paint_red",
           (fp(0.0, 0.86, o + 0.06), fp(-0.62, -0.02, o + 0.06), fp(0.62, -0.02, o + 0.06)),
           o_axis)
    return y0 + LUNA_SUNBURST_RADIUS


def _luna_tower(b: _Builder, ring, floor: float, pad: float) -> None:
    """One entrance tower: a fluted shaft, a banded collar, a stepped crown, a finial.

    The 1935 towers are Chrysler in miniature -- a plain shaft, a collar, then
    setbacks stepping in to a mast -- and they are modelled as exactly that, on
    the gate's own OSM outline pushed out far enough to swallow the 11.5 m
    generic stub standing inside it.

    The finial is the one gold thing in the park, and that is two decisions at
    once: these towers really do carry a gilded tip, and `landmark-audit` needs a
    material that exists nowhere else in the node to measure the entrance's
    placement from. The wheel is taller than the towers and the Big Top's vault
    is close to them, so a probe on "the highest cream thing" would land
    somewhere else in the park.
    """
    local = _luna_local(b, _luna_grow(ring, LUNA_ENVELOPE_M + 0.25))
    centre = np.asarray(local, dtype=np.float64).mean(axis=0)
    top = pad + LUNA_TOWER_HEIGHT

    def scaled(f: float) -> list[tuple[float, float]]:
        return [(float(centre[0] + (x - centre[0]) * f), float(centre[1] + (z - centre[1]) * f))
                for x, z in local]

    # The shaft is in two stages, and where the lower one ends is not a
    # proportion of anything -- it is `LUNA_GENERIC_TOPS` plus clearance, because
    # below that line the tower has to stay full width to keep the 11.5 m OSM
    # stub inside it. Above it the tower is free to step in, and it does: the
    # first sheet had a tower as wide at sixteen metres as at its base standing
    # beside an entrance block nearly as tall, and the pair read as a gatehouse
    # rather than as a pair of towers.
    plinth_top = pad + LUNA_GENERIC_TOPS["luna_gate_w"] + LUNA_ENVELOPE_M
    shaft_top = pad + LUNA_TOWER_HEIGHT * 0.62
    b.prism("landmark_paint_white", local, floor, plinth_top, cap_top=False)
    b.prism("landmark_paint_red", scaled(1.08), plinth_top - 0.55, plinth_top, cap_top=False)
    shaft = scaled(0.76)
    b.prism("landmark_paint_white", shaft, plinth_top, shaft_top, cap_top=False)
    b.prism("landmark_paint_red", scaled(0.84), shaft_top, shaft_top + 1.0, cap_top=False)

    # Two flutes a face, on the upper shaft. Thin boxes rather than a shader
    # stripe, because the shadow down the side of one is the whole point of Art
    # Deco fluting.
    shaft_arr = np.asarray(shaft, dtype=np.float64)
    for i in range(len(shaft_arr)):
        a, c = shaft_arr[i], shaft_arr[(i + 1) % len(shaft_arr)]
        seg = c - a
        length = float(np.linalg.norm(seg))
        if length < 1.4:
            continue
        u = seg / length
        out = np.array([-u[1], u[0]])
        if float(np.dot(out, a + seg * 0.5 - centre)) < 0.0:
            out = -out
        for k in range(2):
            q = a + seg * (0.32 + 0.36 * k) + out * 0.10
            b.beam("landmark_paint_white",
                   np.array([q[0], plinth_top + 0.3, q[1]]),
                   np.array([q[0], shaft_top, q[1]]),
                   0.30, 0.26, up=(float(u[0]), 0.0, float(u[1])))

    # The crown: four setbacks off the upper shaft, each shorter than the one
    # below it, which is what makes a ziggurat read as tapering rather than as a
    # stack of boxes.
    y = shaft_top + 1.0
    span = (top - 2.6) - y
    for f, share in ((0.72, 0.30), (0.58, 0.25), (0.44, 0.21), (0.31, 0.16)):
        y1 = y + span * share
        b.prism("landmark_paint_white", scaled(f), y, y1, cap_top=True)
        y = y1
    cx, cz = float(centre[0]), float(centre[1])
    b.frustum("landmark_gold", cx, cz, y, top - 1.0, 0.34, 0.16, segments=8)
    b.frustum("landmark_gold", cx, cz, top - 1.0, top - 0.45, 0.16, 0.42, segments=10)
    b.frustum("landmark_gold", cx, cz, top - 0.45, top, 0.42, 0.05, segments=10, cap_bottom=True)


def _luna_wheel(b: _Builder, anchor: Anchor, terrain) -> list[Prism]:
    """The Ferris Wheel: two rims of chords on an axle, two A-frames, 24 gondolas.

    OSM maps the wheel as its 18 x 12 m fenced enclosure, which is the ground it
    stands on and not the circle it turns in -- a 35 m wheel is 31 m across and
    does not fit inside its own fence. So the enclosure gives the **plane**, from
    its long axis, and the published height gives the size.

    Chord beams rather than a tessellated ring: a Ferris wheel read against the
    sky is a polygon of straight members, and a smooth hoop is a fairground ride
    nobody ever built. The spokes are every second one for the same reason a
    photograph of a wheel has fewer spokes in it than the wheel does -- a full
    set at this scale is a grey disc.
    """
    fit = _luna_rect(anchor.ring)
    e0, n0 = anchor.centroid
    u = fit[1] if fit is not None else np.array([1.0, 0.0])
    across = np.array([-u[1], u[0]])
    pad = float(terrain.sample(e0, n0))
    clearance = 3.5  # the gondolas' swing under the rim
    radius = (LUNA_WHEEL_HEIGHT - clearance) * 0.5
    hub = pad + clearance + radius
    gauge = 3.2
    centre = np.array([e0, n0])

    def at(angle: float, r: float, side: float) -> np.ndarray:
        q = centre + across * (gauge * 0.5 * side)
        return b.w(float(q[0] + u[0] * r * math.cos(angle)),
                   float(q[1] + u[1] * r * math.cos(angle)),
                   hub + r * math.sin(angle))

    segs = LUNA_WHEEL_GONDOLAS
    for side in (-1.0, 1.0):
        for i in range(segs):
            a0, a1 = 2 * math.pi * i / segs, 2 * math.pi * (i + 1) / segs
            b.beam("landmark_steel", at(a0, radius, side), at(a1, radius, side), 0.45, 0.45)
            if i % 2 == 0:
                b.beam("landmark_steel", at(a0, radius, side), at(a0, 0.0, side), 0.22, 0.22)
    b.beam("landmark_steel", at(0.0, 0.0, -1.0), at(0.0, 0.0, 1.0), 1.1, 1.1)

    # The gondolas, hung just inside the rim so the wheel keeps its published
    # height at the top of the steel rather than at the top of a bucket.
    for i in range(segs):
        p = at(2 * math.pi * (i + 0.5) / segs, radius - 1.4, 0.0)
        b.beam("landmark_paint_red" if i % 2 else "landmark_paint_blue",
               p + np.array([0.0, 0.8, 0.0]), p - np.array([0.0, 0.8, 0.0]), 1.5, 1.5)

    prisms: list[Prism] = []
    for side in (-1.0, 1.0):
        foot = centre + across * (gauge * 0.5 * side)
        apex = b.w(float(foot[0]), float(foot[1]), hub)
        for lean in (-1.0, 1.0):
            q = foot + u * (radius * 0.55 * lean)
            ground = float(terrain.sample(float(q[0]), float(q[1])))
            b.beam("landmark_steel", b.w(float(q[0]), float(q[1]), ground - 1.0), apex, 0.9, 0.9)
            prisms.append(Prism(_disc_enu(float(q[0]), float(q[1]), 1.4, 8), ground, 4.0, "wheel"))
    return prisms


def _luna_pavilions(b: _Builder, ring, pad: float) -> None:
    """Crystal Palace's four corner pavilions and their steep pyramid caps.

    The hall's own reading is a long roof; the four turrets are what make it
    Crystal Palace rather than a shed, and over the Big Top from the north they
    are the only part of it visible at all.
    """
    fit = _luna_rect(ring)
    if fit is None:
        return
    p, u, _length, _width, centre = fit
    across = np.array([-u[1], u[0]])
    for corner in p:
        d = corner - centre
        seat = centre + u * (float(np.dot(d, u)) * 0.88) + across * (float(np.dot(d, across)) * 0.86)
        half = 2.9
        square = [
            (float(seat[0] + (u[0] * su + across[0] * sv) * half),
             float(seat[1] + (u[1] * su + across[1] * sv) * half))
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))
        ]
        b.prism("landmark_paint_white", _luna_local(b, square), pad + 1.0,
                pad + LUNA_CRYSTAL_TURRET, cap_top=False)
        apex = b.w(float(seat[0]), float(seat[1]), pad + LUNA_CRYSTAL_SPIRE)
        eave = [b.w(e, n, pad + LUNA_CRYSTAL_TURRET) for e, n in square]
        for i in range(4):
            _luna_roof_face(b, "landmark_paint_red", (eave[i], eave[(i + 1) % 4], apex))


def _luna_pediment(b: _Builder, ring, pad: float, eaves: float) -> None:
    """Coney Island's decorated front: a signboard gable over its southern wall.

    1935 sideshow architecture is a plain shed with a face on the street, and
    this is that face -- a raised parapet board with a blue roundel in it, stood
    proud of the wall so it throws a shadow down onto it.
    """
    fit = _luna_rect(ring)
    if fit is None:
        return
    p, u, length, _width, centre = fit
    edge = p[0:2] if (p[0][1] + p[1][1]) < (p[2][1] + p[3][1]) else p[2:4]
    mid = (edge[0] + edge[1]) * 0.5
    out = _norm2(mid - centre)
    half = min(length * 0.28, 11.0)
    y0, y1 = pad + eaves - 0.6, pad + eaves + 3.4
    board = [mid + u * half + out * 0.55, mid - u * half + out * 0.55]
    b.prism("landmark_paint_red",
            _luna_local(b, [board[0], board[1], board[1] - out * 0.7, board[0] - out * 0.7]),
            y0, y1, cap_top=True)
    seat = mid + out * 1.0
    cy = (y0 + y1) * 0.5
    b.face(
        "landmark_paint_blue",
        [b.w(float(seat[0] + u[0] * 1.45 * math.cos(2 * math.pi * i / 16)),
             float(seat[1] + u[1] * 1.45 * math.cos(2 * math.pi * i / 16)),
             cy + 1.45 * math.sin(2 * math.pi * i / 16)) for i in range(16)],
        _luna_out(b, out),
    )


def _luna_carousel(b: _Builder, anchor: Anchor, terrain) -> None:
    """The Carousel: a ring of poles on a plinth under a striped conical tent.

    Sized to the ride rather than to the 11.5 m box `attributes` guessed over it,
    which means that box is still there until the next full build and the
    carousel is inside it. That is the right way round -- a nine-metre carousel
    is correct forever where a twelve-metre one would be wrong forever -- and the
    suppression zone below takes the box away at the next build.
    """
    e0, n0 = anchor.centroid
    r = math.sqrt(max(Polygon(np.asarray(anchor.ring, dtype=np.float64)).area, 40.0) / math.pi)
    # The plinth is 16 m across and the bank under it falls four and a half
    # metres, so it is grounded off the ring rather than off the centre sample --
    # a `terrain.sample(centre) - 1.5` plinth floats three metres clear on its
    # western side, which the sheet showed and a centre sample cannot.
    pad, floor = _luna_pad(terrain, _disc_enu(e0, n0, r, 12))
    cx, cz = float(b.w(e0, n0, 0.0)[0]), float(b.w(e0, n0, 0.0)[2])
    b.frustum("landmark_granite", cx, cz, floor, pad + 0.9, r, r, segments=16, cap_top=True)
    for i in range(12):
        t = 2 * math.pi * i / 12
        q = (r * 0.86 * math.cos(t), r * 0.86 * math.sin(t))
        b.beam("landmark_paint_red" if i % 2 else "landmark_paint_white",
               b.w(e0 + q[0], n0 + q[1], pad + 0.9), b.w(e0 + q[0], n0 + q[1], pad + 4.6),
               0.24, 0.24)
    b.frustum("landmark_paint_red", cx, cz, pad + 4.6, pad + 5.4, r * 1.08, r * 1.02, segments=16)
    b.frustum("landmark_paint_yellow", cx, cz, pad + 5.4, pad + 8.6, r * 1.02, 0.6, segments=16)
    b.frustum("landmark_gold", cx, cz, pad + 8.6, pad + 9.4, 0.6, 0.08, segments=8, cap_bottom=True)


def _luna_helter_skelter(b: _Builder, anchor: Anchor, terrain) -> None:
    """The Helter Skelter: a banded drum with a conical cap.

    The one small ride tall enough to swallow its own generic stub, which is why
    it is here and the Volare, the Hair Raiser and the ride operator's hut are
    not: a nineteen-square-metre shed inside an 11.5 m box cannot be modelled
    truthfully and hidden at the same time.
    """
    e0, n0 = anchor.centroid
    pad, floor = _luna_pad(terrain, _disc_enu(e0, n0, 2.6, 8))
    cx, cz = float(b.w(e0, n0, 0.0)[0]), float(b.w(e0, n0, 0.0)[2])
    top = pad + 12.4
    b.frustum("landmark_paint_white", cx, cz, floor, top, 2.5, 2.3, segments=12)
    for k in range(4):
        y = pad + 1.6 + 2.7 * k
        b.frustum("landmark_paint_red", cx, cz, y, y + 0.9, 2.45, 2.38, segments=12)
    b.frustum("landmark_paint_red", cx, cz, top, top + 3.4, 2.7, 0.12, segments=12,
              cap_bottom=True)


def _luna_boardwalk(b: _Builder, anchor: Anchor, terrain) -> None:
    """The harbourside promenade: a timber deck on the ground, railed on the water side.

    The deck follows the terrain **per vertex** rather than sitting on one pad,
    and it is the one thing in the park that has to: it runs 260 m from the wharf
    round to Coney Island across twenty metres of the DEM's hillside, and a flat
    deck over that is either a wall or a trench. Where the ground is below the
    harbour -- which the DEM says it is for the western twenty metres of the
    promenade -- the deck rides at a fixed height over the water instead, which
    is what a pier is.

    The rail goes only on edges whose outward normal points away from the
    promenade's own centre, so it lands on the water side rather than down the
    middle of the midway. Timber in `landmark_granite`, which is the warm grey
    the palette has and which weathered hardwood decking is; a paint slot would
    have been a lie about a surface nobody paints.

    THE DECK IS TRIANGULATED ON A DENSIFIED RING AND THE RAIL ON THE COARSE ONE,
    and that split is the fix for what the first sheet showed. Ear-clipping a
    260 m band whose outline has a vertex every ten metres produces ears that
    are ten metres on a side, and a ten-metre triangle laid across ground that
    falls one in three is a slab tilted forty degrees out of the hillside -- the
    promenade came out as a heap of loose sheets. Inserting a vertex every three
    metres costs 170 triangles and makes every ear small enough to sit on the
    ground it is over. The rail wants the opposite: one beam per real corner, or
    the balustrade is four hundred boxes.
    """
    poly = Polygon(np.asarray(anchor.ring, dtype=np.float64)).simplify(0.6, preserve_topology=True)
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    ring = np.asarray(poly.exterior.coords, dtype=np.float64)[:-1]
    if len(ring) < 3:
        return
    sea = -float(terrain.base_elevation)

    def deck_y(e: float, n: float) -> float:
        return max(float(terrain.sample(e, n)), sea) + 0.35

    fine: list[np.ndarray] = []
    for i in range(len(ring)):
        a, c = ring[i], ring[(i + 1) % len(ring)]
        steps = max(int(float(np.linalg.norm(c - a)) // 3.0), 1)
        fine.extend(a + (c - a) * (j / steps) for j in range(steps))
    dense = np.asarray(fine, dtype=np.float64)
    # Each ear is emitted with **its own** geometric normal rather than with a
    # flat (0, 1, 0), and ears with no plan area at all are dropped. Both of
    # those are `landmark-audit`'s winding pass talking, and what it caught is
    # worth writing down because it looks like a rounding bug and is not.
    #
    # Ear-clipping a 260 m band produces a handful of ears whose three vertices
    # are nearly collinear *in plan* -- three points strung along one edge of the
    # promenade. They enclose no ground, so dropping them leaves no hole; but
    # they run up a 1-in-3 bank, so in three dimensions they are near-vertical
    # plates of up to sixty square metres. Handed a claimed normal of straight up
    # their winding is decided by a dot product of almost exactly zero, which
    # survives in float64 and flips when `write_landmarks` stores the positions
    # as float32 -- twenty-two triangles that were correct in memory and inside
    # out in the shipped file, invisible from one side.
    tris = mapbox_earcut.triangulate_float64(dense, np.array([len(dense)], dtype=np.uint32))
    for t in np.asarray(tris, dtype=np.int64).reshape(-1, 3):
        q = [dense[i] for i in t]
        plan = abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1])
                   - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0])) * 0.5
        if plan < 0.05:
            continue
        _luna_roof_face(
            b, "landmark_granite",
            [b.w(float(p[0]), float(p[1]), deck_y(float(p[0]), float(p[1]))) for p in q],
        )

    centre = ring.mean(axis=0)
    for i in range(len(ring)):
        a, c = ring[i], ring[(i + 1) % len(ring)]
        seg = c - a
        length = float(np.linalg.norm(seg))
        if length < 2.0:
            continue
        out = np.array([seg[1], -seg[0]]) / length
        if float(np.dot(out, (a + c) * 0.5 - centre)) <= 0.0:
            continue
        ya, yc = deck_y(float(a[0]), float(a[1])), deck_y(float(c[0]), float(c[1]))
        b.beam("landmark_steel",
               b.w(float(a[0]), float(a[1]), ya + 1.05),
               b.w(float(c[0]), float(c[1]), yc + 1.05), 0.12, 0.12)
        posts = max(int(length // 9.0), 1)
        for k in range(posts):
            q = a + seg * ((k + 0.5) / posts)
            y = deck_y(float(q[0]), float(q[1]))
            b.beam("landmark_steel", b.w(float(q[0]), float(q[1]), y),
                   b.w(float(q[0]), float(q[1]), y + 1.05), 0.1, 0.1)


def build_luna_park(anchors: dict[str, Anchor], terrain) -> Landmark:
    """Luna Park Sydney, 1935: the Face, its towers, and the park behind them.

    Registered to eleven OSM outlines rather than one, because the park is not
    one object -- it is a face, a wheel and half a dozen sheds inside a fence,
    and every one of them is mapped. The node's anchor is the canopy between the
    two entrance towers: the Face is what the name means, and it is what
    `landmark-audit` measures the placement from.

    THE ENTRANCE SHARES ONE PAD. Everything else in the park stands on the ground
    at its own centroid, city-fashion. The two towers cannot: the DEM puts nine
    and a half metres of hillside between them, so a pad each would give Sydney's
    most photographed pair of towers a nine-metre height difference. They take
    the lower pad instead, the uphill one buries its plinth, and the tops come
    out level -- which is the part a player can see.

    ENVELOPING, AND WHY THE HALLS ARE A STOREY TALLER THAN THEY ARE. This ships
    into a world refreshed landmark-only, so `suppression_zones` does not bite
    until the next full build and the generic OSM boxes for Crystal Palace, Coney
    Island, the Big Top, Luna Lounge, the Administration building, the two gate
    stubs and the canopy between them are all still in the streamed tiles. Each
    of those is twelve metres of `warehouse` archetype rather than the seven the
    two stated levels suggest, so every hall here is sized off
    `LUNA_GENERIC_TOPS` and swallows its box whole: eaves above the box's top --
    the *eaves*, because a hip roof does not contain the box's corners -- and the
    footprint pushed out `LUNA_ENVELOPE_M` on every side. The visible cost is a
    thirteen-metre Crystal Palace and a seventeen-metre entrance block, both a
    storey taller than life. After the next full build the boxes go and the sizes
    stay; correcting them then is one constant each. The Carousel is the one
    deliberate exception -- see `_luna_carousel`.
    """
    ce, cn = anchors["luna_gate_roof"].centroid
    b = _Builder((ce, cn))
    prisms: list[Prism] = []

    # --- The entrance: one pad for the pair, taken at the canopy between them.
    #
    # The canopy rather than either tower, and it is the *middle* of the three
    # readings for a reason that took a look at the sheet to find. Taking the
    # lower tower puts the pad at 10 m AHD, and the ground on the far side of the
    # entrance is at 19.5 -- so the Face, which hangs across both, had its whole
    # eastern half underground. Taking the higher one stands the western tower on
    # seventeen metres of plinth. The canopy's own ground is between the two, the
    # Face clears the bank at both ends, and the buried side is the uphill side,
    # which is what a cutting looks like.
    gate_w, gate_e = anchors["luna_gate_w"], anchors["luna_gate_e"]
    pad_w, floor_w = _luna_pad(terrain, gate_w.ring)
    pad_e, floor_e = _luna_pad(terrain, gate_e.ring)
    pad, roof_floor = _luna_pad(terrain, anchors["luna_gate_roof"].ring)
    floor = min(floor_w, floor_e, roof_floor)
    ground = floor + LUNA_SKIRT_MIN  # the lowest real ground under the entrance

    # The block the Face is hung on. Not the canopy's own outline extruded: the
    # coin has to stand clear of both towers' south faces, so the block is a
    # rectangle in the entrance's own frame -- wide enough to cover the canopy
    # stub, and reaching south exactly as far as the Face's mid-plane so that the
    # coin's front half stands out of it with no gap behind.
    centre, right, outward = _luna_face_frame(anchors)
    block = np.asarray(
        [centre + right * (su * 5.4) + outward * so
         for su, so in ((-1.0, -4.2), (1.0, -4.2), (1.0, LUNA_FACE_STANDOFF),
                        (-1.0, LUNA_FACE_STANDOFF))],
        dtype=np.float64,
    )
    entrance_top = pad + LUNA_ENTRANCE_TOP
    b.prism("landmark_paint_white", _luna_local(b, block), floor, entrance_top, cap_top=True)
    b.prism("landmark_paint_red", _luna_local(b, _luna_grow(block, 0.22)),
            entrance_top - 0.9, entrance_top, cap_top=False)
    # And the same band at the towers' first setback, so that the three parts of
    # the entrance read as one composition from the side, where the Face is edge
    # on and cannot do it.
    b.prism("landmark_paint_red", _luna_local(b, _luna_grow(block, 0.22)),
            pad + LUNA_GENERIC_TOPS["luna_gate_w"] + LUNA_ENVELOPE_M - 0.55,
            pad + LUNA_GENERIC_TOPS["luna_gate_w"] + LUNA_ENVELOPE_M, cap_top=False)
    prisms.append(_luna_prism(block, ground, entrance_top, "gate"))

    for gate in (gate_w, gate_e):
        _luna_tower(b, gate.ring, floor, pad)
        prisms.append(_luna_prism(_luna_grow(gate.ring, LUNA_ENVELOPE_M + 0.25), ground,
                                  pad + LUNA_TOWER_HEIGHT, "gate"))
    face_top = _luna_face(b, anchors, pad)

    # --- The halls.
    cp_ring, cp_pad, cp_ground, cp_eaves = _luna_hall(
        b, terrain, anchors["luna_crystal_palace"].ring,
        eaves=LUNA_CRYSTAL_EAVES, ridge=LUNA_CRYSTAL_RIDGE, bays=LUNA_CRYSTAL_BAYS,
    )
    _luna_pavilions(b, cp_ring, cp_pad)
    prisms.append(_luna_prism(cp_ring, cp_ground, cp_eaves, "hall"))

    co_ring, co_pad, co_ground, co_eaves = _luna_hall(
        b, terrain, anchors["luna_coney_island"].ring,
        eaves=LUNA_CONEY_EAVES, ridge=LUNA_CONEY_RIDGE, bays=LUNA_CONEY_BAYS,
        bay_material="landmark_paint_yellow", trim="landmark_paint_blue",
    )
    _luna_pediment(b, co_ring, co_pad, LUNA_CONEY_EAVES)
    prisms.append(_luna_prism(co_ring, co_ground, co_eaves, "hall"))

    bt_ring, _bt_pad, bt_ground, bt_eaves = _luna_hall(
        b, terrain, anchors["luna_big_top"].ring,
        eaves=LUNA_BIGTOP_EAVES, ridge=LUNA_BIGTOP_CROWN,
        wall="landmark_steel", roof="landmark_steel", vault=True,
    )
    prisms.append(_luna_prism(bt_ring, bt_ground, bt_eaves, "hall"))
    an_ring, _an_pad, an_ground, an_eaves = _luna_hall(
        b, terrain, anchors["luna_big_top_annexe"].ring,
        eaves=LUNA_ANNEXE_EAVES, ridge=LUNA_ANNEXE_CROWN,
        wall="landmark_steel", roof="landmark_steel", vault=True,
    )
    prisms.append(_luna_prism(an_ring, an_ground, an_eaves, "hall"))

    ll_ring, _ll_pad, ll_ground, ll_eaves = _luna_hall(
        b, terrain, anchors["luna_lounge"].ring,
        eaves=LUNA_LOUNGE_EAVES, ridge=LUNA_LOUNGE_RIDGE, bays=9,
    )
    prisms.append(_luna_prism(ll_ring, ll_ground, ll_eaves, "hall"))

    ad_ring, ad_pad, ad_ground, _ad_eaves = _luna_hall(
        b, terrain, anchors["luna_administration"].ring,
        eaves=LUNA_ADMIN_TOP, ridge=LUNA_ADMIN_PARAPET, bays=7,
    )
    b.prism("landmark_paint_red", _luna_local(b, _luna_grow(ad_ring, 0.18)),
            ad_pad + LUNA_ADMIN_TOP, ad_pad + LUNA_ADMIN_PARAPET, cap_top=False)
    prisms.append(_luna_prism(ad_ring, ad_ground, ad_pad + LUNA_ADMIN_PARAPET, "hall"))

    # --- The rides and the promenade.
    prisms.extend(_luna_wheel(b, anchors["luna_ferris_wheel"], terrain))
    _luna_carousel(b, anchors["luna_carousel"], terrain)
    _luna_helter_skelter(b, anchors["luna_helter_skelter"], terrain)
    _luna_boardwalk(b, anchors["luna_boardwalk"], terrain)

    audit = {
        "base_y": pad,
        "tower_height_m": LUNA_TOWER_HEIGHT,
        "tower_top_y": pad + LUNA_TOWER_HEIGHT,
        "face_width_m": LUNA_FACE_WIDTH,
        "face_centre_y": pad + LUNA_FACE_CENTRE,
        "face_top_y": face_top,
        "wheel_height_m": LUNA_WHEEL_HEIGHT,
        "entrance_top_y": entrance_top,
        "pad_spread_m": abs(pad_e - pad_w),
    }
    return Landmark("luna_park", (ce, cn), b.parts, prisms, audit)


# --- The build -----------------------------------------------------------------


def build_all(terrain, anchors: dict[str, Anchor] | None = None) -> list[Landmark]:
    """All four, in one pass, sharing one OSM read.

    Both reads are memoised on the caller's behalf rather than repeated: an OSM
    `multipolygons` pass over the inner ring is 40,290 features and five seconds,
    and `cli.cmd_build` has already done both by the time it gets here.
    """
    if anchors is None:
        anchors = read_anchors()
    if _WESTFIELD_RING is None:
        read_podium_ring()
    return [
        build_bridge(anchors, terrain),
        build_opera(anchors, terrain),
        build_tower(anchors, terrain),
        build_luna_park(anchors, terrain),
    ]


def manifest(landmarks: list[Landmark], anchors: dict[str, Anchor], terrain) -> dict:
    """What `index.json` carries about the landmark set.

    Small, and every field in it is something the client cannot derive: where the
    file is, which materials it names, and -- for the audit and the debug overlay
    -- where each landmark claims to be and how tall it claims to be. The client
    reads the placement fields for nothing at render time; `landmark-audit` reads
    them to check the shipped geometry against them, which is the point.
    """
    sea = -terrain.base_elevation
    out = {
        "version": 1,
        "file": "landmarks.glb",
        "materials": list(LANDMARK_MATERIALS),
        "sea_level_y": round(sea, 3),
        "items": [],
    }
    for lm in landmarks:
        lon, lat = geo.enu_to_lonlat(*lm.anchor_enu)
        out["items"].append(
            {
                "name": lm.name,
                "anchor_enu": [round(lm.anchor_enu[0], 3), round(lm.anchor_enu[1], 3)],
                "anchor_world": [round(lm.anchor_enu[0], 3), 0.0, round(-lm.anchor_enu[1], 3)],
                "lat": round(float(lat), 7),
                "lon": round(float(lon), 7),
                "triangles": lm.triangles,
                "vertices": lm.vertices,
                "prisms": len(lm.prisms),
                "audit": {k: round(v, 3) for k, v in lm.audit.items()},
            }
        )
    out["triangles"] = sum(lm.triangles for lm in landmarks)
    out["anchor_sources"] = {k: v.source for k, v in sorted(anchors.items())}
    return out


def prisms_by_tile(landmarks: list[Landmark]) -> dict[str, list[Prism]]:
    """Every landmark collision volume, filed under the tile holding its centre.

    Filed by centre rather than clipped to tile edges, and the deck segmentation
    is what makes that safe: a 25 m deck segment can overhang its tile by at most
    12.5 m, `CollisionWorld` indexes a prism by its own world bounding box, and
    `main.ts` fetches collision on a 420 m radius -- so a segment is always
    loaded well before a player can reach it. Clipping instead would put a seam
    down the middle of the deck at every tile boundary, which is four seams
    across the harbour.
    """
    out: dict[str, list[Prism]] = {}
    for lm in landmarks:
        for p in lm.prisms:
            out.setdefault(p.tile, []).append(p)
    return out


def suppress(buildings: list, zones: dict[str, Polygon | MultiPolygon]) -> tuple[list, dict[str, list[str]]]:
    """Drop every generic building standing inside a landmark.

    Returns the surviving list and, per zone, the ids removed -- the ids rather
    than a count, because the count alone cannot tell "the two pylon blobs went"
    from "half of Circular Quay went", and this is a filter that runs before the
    tiles, the collision payload *and* `far.bin` are derived. It is the one place
    in this pass that can quietly delete the city.
    """
    from shapely.geometry import Point

    removed: dict[str, list[str]] = {k: [] for k in zones}
    keep = []
    for b in buildings:
        pt = Point(b.centroid)
        hit = next((name for name, zone in zones.items() if zone.contains(pt)), None)
        if hit is None:
            keep.append(b)
        else:
            removed[hit].append(b.id)
    return keep, removed
