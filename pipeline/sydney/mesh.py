"""Building massing meshes and the per-building facade parameters.

The central design point from spec section 3.3 and 6.4: facade detail lives in the
*material*, not the mesh. A building here is walls plus a roof form and nothing
else -- no window geometry, no balconies, no sills. What makes it read as a real
facade is a UV parameterisation carried on the wall vertices plus a small
per-building parameter record that the shader uses to construct the window grid
and its parallax depth.

That is what makes uniform quality across a million buildings affordable: a
terrace in Marrickville costs the same 30 triangles as one in Surry Hills.

UV convention on wall quads, and it matters:
    u = metres travelled along the facade from the start of the wall run
    v = metres above ground
Both in *world metres*, not normalised. The shader derives floor lines and bay
lines by taking modulo against the building's floor height and bay width, so a
2.4 m terrace bay and a 1.5 m curtain-wall bay come out correctly from the same
shader with no per-building mesh differences.

`v` is measured from the building's **own** ground, not from world zero. Since
terrain arrived, `base_y` moves a building's geometry up onto its pad while every
number the facade grammar reads stays relative -- so a terrace on the Surry Hills
ridge and one in Alexandria 40 m below it are the same 30 triangles with the same
parameter record, and the shader never learns that terrain exists.
"""

from __future__ import annotations

import math
import zlib
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import mapbox_earcut
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient

from .attributes import ARCHETYPES, MATERIAL_MIX
from .merge import ROW_SLICE_SEP, Building, twice_signed_area

if TYPE_CHECKING:  # `streets` imports this module, so the runtime edge runs one way only.
    from .streets import StreetNetwork

# Roof pitch by form, degrees. Terracotta tile in Sydney sits around 22 degrees;
# corrugated steel is shallower.
ROOF_PITCH = {
    "hip": 22.0,
    "gable": 24.0,
    "skillion": 8.0,
    "sawtooth": 28.0,
}

# Parapet height above the top slab on flat commercial roofs. Small, but it is
# the difference between a roof that reads as a building and one that reads as a
# cut-off box.
PARAPET_HEIGHT = 0.9

# --- Roofline trim ------------------------------------------------------------
#
# Every roofline in this build used to terminate in a razor edge: the roof plane
# stopped exactly on the wall line, a parapet stopped in a bare top edge, and a
# city of pre-war housing had no chimneys at all. Those are small elements and
# they are the ones that decide whether a low-rise roofscape reads as *built* or
# as *extruded* -- a roof with no eave has no shadow under it, and a shadow line
# along an eave is worth more at 100 m than anything happening on the roof
# surface itself.
#
# All of it is geometry rather than shader work, and it has to be. The previous
# roofs pass established that the ridge, the barge boards and the hip lines were
# out of reach of the fragment shader because `half_short` -- the one number that
# locates the ridge in the roof's own UV space -- never reached it (see the long
# comment above `finishRoof` in `client/src/world/facade.ts`). A ridge is a
# geometric seam between two quads that never share a fragment; nothing local to
# a fragment says "the roof peaks here". So it is triangles.
#
# What it costs, measured over the inner ring's 33,844 buildings: see the
# per-element notes below. The total is +1.4 M triangles on a 3.11 M base, and
# the two mitigations that keep it there are stated where they are taken.

# How far a pitched roof oversails its walls. 450 mm is the Sydney suburban
# norm -- enough to throw a real shadow band across the top of the facade, short
# enough that neighbouring houses on 900 mm setbacks do not interpenetrate.
# Applied to *both* rect axes, so a gable gets its verge overhang out of the
# same number.
EAVE_OVERHANG = 0.45

# The fascia board closing the eave edge, and by implication the gutter hung off
# it. One depth for both: a 180 mm fascia with a quad gutter on it is about
# 300 mm of painted timber and metal, and at the distance an eave is read the
# two are one line. Given `render_painted` rather than a slot of its own --
# nine facade pipelines already compile and a tenth for 180 mm of board is not a
# trade anyone would take.
FASCIA_DEPTH = 0.18
FASCIA_MATERIAL = "render_painted"

# Ridge and hip capping: half-width and how far it stands proud of the planes it
# sits on. 120 mm of cover at 60 mm proud is a terracotta ridge roll or a steel
# ridge cap within a few millimetres, and both read through the existing roof
# shaders without a new material.
RIDGE_CAP_HALF = 0.06
RIDGE_CAP_PROUD = 0.06

# The capping band along the top of a parapet -- the crisp top line every Sydney
# terrace, retail strip and interwar block has, and the thing whose absence made
# them read as boxes cut off with a knife.
#
# Two quads a segment, not three: the band's top *falls inward* to meet the roof
# deck rather than running flat with a separate return down to it. A real
# capping does fall inward, and over 250 mm the fall is invisible from the street
# either way -- but the third quad would cost another 306k triangles over the
# inner ring, on 153,000 ring segments. This is the larger of the two budget
# mitigations named above.
PARAPET_CAP_WIDTH = 0.25
PARAPET_CAP_HEIGHT = 0.09

# Chimneys. A 550 x 850 mm shaft is a two-flue brick chimney in plan; the rise is
# drawn per building because a roofscape of identical chimneys is worse than
# none. The cap is a corbel -- a frustum flaring 60 mm over 80 mm -- rather than
# an overhanging box, which is both what brick actually does and the only way to
# get a cap lip without leaving a 60 mm slot of sky between the cap and the shaft.
CHIMNEY_ACROSS = 0.55
CHIMNEY_ALONG = 0.85
CHIMNEY_RISE = (0.9, 1.4)
CHIMNEY_CAP_HEIGHT = 0.08
CHIMNEY_CAP_CORBEL = 0.06
# How far the shaft is sunk below the roof surface it stands on. Only has to beat
# the fall of the planes across the shaft's own width -- 275 mm at a 22 degree
# pitch is 111 mm -- and costs nothing, since the shaft is the same four quads
# whatever its length.
CHIMNEY_SINK = 0.30
# Brick, and not necessarily the wall's brick: a chimney rebuilt once in eighty
# years is a different batch, and a contrasting one is commoner than a match.
CHIMNEY_BRICKS = ("brick_red", "brick_cream")
# Which archetypes get one, and what share of them. Terraces and Federation
# houses are the pre-war stock that was built with fireplaces in every room;
# interwar flats mostly were not, and 30% is what is left of the ones that were.
CHIMNEY_SHARE = {"terrace": 1.0, "federation": 1.0, "interwar_apartment": 0.30}
# A terrace row gets *one* chimney per house, on the party wall, and misses some
# -- a solid run of them reads as a comb. 70% is what leaves gaps without
# breaking the rhythm, which is the signature this exists for.
CHIMNEY_ROW_SHARE = 0.70

# Above this height none of the above is emitted. Eaves, ridge caps and chimneys
# are eye-level silhouette detail on low-rise stock; a tower reads by its
# massing and its glazing and pays nothing for trim it is too far up to show.
# Over the inner ring this excludes 219 flat-roofed buildings and exactly one
# pitched one, so it is a guard for the outer stages rather than a saving here.
TRIM_MAX_HEIGHT = 60.0

# Trim that lands in a *wall* material slot carries a `v` measured from just
# above the building's head, not its true height above the pad, and that is
# deliberate. `v` is what the facade shader divides into storeys, and a fascia is
# not a storey: at any v below `b.height` the window field can and does open --
# a brick-veneer house with a 2.0 m redistributed floor height puts a window head
# at 2.3 m of a 2.0 m storey, so a fascia hung 180 mm under the eave lands inside
# an opening and comes back with glazing painted on it. At or above `b.height`,
# `withinBuilding` forces the field to -1 and no opening is ever drawn. The 50 mm
# is float32 slack on `aboveGround / floorHeight`, which lands exactly on the
# storey boundary and must not fall the wrong side of it.
TRIM_V_CLEARANCE = 0.05

# --- Clipping the roof frame back onto the building ---------------------------
#
# A pitched roof is built on the footprint's minimum-area rectangle -- see
# `build_roof`, which argues the case and is right about the near-rectangular
# majority it was written for. It is wrong, and spectacularly wrong, about the
# rest. An L, a U, a T or a deep-notched warehouse plan has a minimum rectangle
# far larger than the building inside it, and every square metre of the
# difference is roof plane hanging over open ground.
#
# Measured over the inner ring before this went in: of 12,626 pitched roofs,
# 3,132 (24.8%) had roof standing more than 4 m clear of any wall beneath it and
# 1,201 more than 8 m, 1.74 million m2 of it in total, worst case 83 m of
# oversail on a sawtooth warehouse whose 2,072 m2 footprint sits inside a
# 4,522 m2 rectangle. That is not an eave. It is a flat slab at roof height with
# no wall under it, no collision prism under it -- `tiles.write_collision` uses
# the true footprint, so the player walks straight through the space -- and, on
# a `FrontSide` material, no underside either: from below it is a hole in the
# sky and from anywhere at eave level or above it is a black slab across the
# street. Both are what players reported.
#
# The rectangle is kept, because everything it is actually good for is still
# right: it fixes the ridge direction, the pitch, and the `u`/`v` frame the roof
# shader reads. What changes is that it now supplies only the roof's HEIGHT
# FIELD, and the roof SURFACE is clipped to the footprint grown by its own eave.
# The roof then follows the building's plan and oversails it by exactly the
# overhang, which is what a roof does.
#
# Clipping opens a second hole that has to be closed in the same pass. Where the
# footprint cuts across the slope -- the inner corner of an L, every long side
# of a sawtooth -- the roof edge sits ABOVE the wall head, and the gap between
# them is open to the roof void. `_roof_closure` walls it, which is what a verge
# or a gable end is; on the sawtooth it is the riser the form was missing
# outright (see the note in `build_roof`, which recorded the teeth as coplanar
# strips with no risers at all).
#
# Buildings whose rectangle is a fair description of their plan take the
# original path untouched, so most of the city is unchanged geometry.
# `ROOF_OVERSAIL_TOL` is where "fair" stops: one metre is inside what a real
# verge reaches past a wall and well inside the 450 mm eave plus the slack in a
# footprint's own corners, and it leaves 54% of pitched roofs on the old path.
ROOF_OVERSAIL_TOL = 1.0

# Clipped pieces smaller than this are dropped rather than emitted: GEOS returns
# hairline slivers along a shared edge and a 3 cm2 triangle is three vertices
# that can only ever z-fight with the piece next to it.
ROOF_PIECE_MIN_AREA = 0.05

# --- Footpath awnings ---------------------------------------------------------
#
# Spec 6.3's ground-floor override asks for a "continuous awning at 3.2 m" and
# spec 7.7 for "continuous cantilevered awnings over the footpath on every retail
# strip". Until now the only thing standing in for either was a painted band on
# the wall, which is a *picture* of an awning: it throws no shadow, it has no
# underside, and the footpath below it is lit exactly like the middle of the
# road. An awning is the one piece of Sydney street furniture that changes the
# light at eye level, and that is why it is geometry.
#
# Why they are continuous and why that is the whole point: these are not
# per-building canopies with gaps between them. A shopping strip's awnings are
# built to the property line on both sides and butt into their neighbours, so a
# block reads as one shaded colonnade running the length of the street. Nothing
# here tries to join them -- each building emits the full length of its own
# street edge and adjacency does the rest, which is both cheaper and exactly
# right.
#
# Ten triangles a run, which is fewer than the fifteen this was budgeted at, and
# the saving is structural rather than a corner cut: the fascia is as deep as the
# slab is thick, so the awning is a closed box with no lip to return and no
# interior face. See `_awning_run`.

# Clearance under the soffit. 3.2 m is the spec's number and it is also the
# Sydney norm -- high enough to clear a delivery pallet jack, low enough that the
# shopfront above it is hidden from across the street, which is why the signage
# goes on the fascia rather than on the wall.
AWNING_HEIGHT = 3.2

# How far the canopy cantilevers out over the footpath. 2.6 m covers a 3 m
# footpath to within the gutter, which is what a Sydney awning does -- it stops
# at the kerb line, not short of it, because the point is to keep the rain off
# the shopper and not off the shop.
AWNING_PROJECTION = 2.6

# ...and the pull-back where there is no footpath to cover. A service lane gets
# 1.5 m of paving and a living street 2.5 m (see `streets.FOOTPATH_WIDTH`), so a
# 2.6 m canopy on either would hang over the carriageway.
AWNING_PROJECTION_TIGHT = 1.2

# The kerb distance below which the pull-back applies. Deliberately NOT 3.0,
# which is `streets.FOOTPATH_WIDTH_DEFAULT` and therefore the modal frontage in
# the city: a threshold sitting exactly on the mode would be decided by
# centreline noise on half the retail strips in Sydney and half of King Street
# would come out with a stumpy awning for no visible reason. At 2.8 the nominal
# 3 m footpath comfortably takes the full projection and only the classes that
# really are narrow -- service at 1.5, living_street at 2.5 -- pull back.
AWNING_TIGHT_KERB = 2.8

# How far the kerb can be and still count as "this edge fronts a street".
# Generous on purpose: a retail building set back behind a wide footpath or a
# service road still has an awning in life, and the direction test below is what
# actually does the discriminating.
AWNING_MAX_KERB = 9.0

# How nearly the road has to lie in front of the wall rather than off to the
# side, as the cosine of the angle between the wall's outward normal and the
# direction to the nearest point on the carriageway. 0.64 is a 50 degree cone.
#
# This is the test that keeps awnings off party walls, and it is not optional --
# see `AwningNetwork._kerb_distance` for why a distance test alone passes every
# internal wall of a terrace row.
AWNING_FACING_MIN = 0.64

# Classes that are a carriageway but not a shopping street. Measured over the
# four densest retail tiles in the inner ring before this went in: `service` --
# OSM's class for laneways and driveways -- was qualifying 201 of 1,026 runs and
# 2,527 of 11,774 metres, which is a fifth of the whole feature hung on the BACK
# walls of shops.
#
# A Sydney shop's rear wall on a lane has a loading hood at most, never the 2.6 m
# signage awning this module builds, and two of them across a 3 m lane very
# nearly touch. It is also the same call `parking.py` and `power.py` already make
# from their own directions -- neither parks a car nor stands a pole on a
# laneway -- and the same one `streets.FOOTPATH_WIDTH` makes when it gives a
# service way 1.5 m of paving and calls it "a strip, not a promenade".
#
# What it costs: an arcade or a pedestrianised way mapped as `service` loses its
# awning. That is a handful of addresses against a fifth of the feature.
AWNING_EXCLUDE_CLASSES = frozenset({"service"})

# How far past the qualifying kerb distance to look for a carriageway at all.
# Must exceed the widest half-carriageway a way can produce, or a wall fronting a
# six-lane road would find no way to measure against and lose its awning.
#
# Expressed as a margin rather than as an absolute radius because two features
# now ask the same question at two different distances -- an awning qualifies at
# 9 m and a front door at 15 -- and a fixed radius would silently stop covering
# the wider of them. `_street_ahead` adds this to whatever kerb limit it is
# given, so the relationship holds by construction instead of by a comment.
STREET_PROBE_MARGIN = 23.0
AWNING_SEARCH_RADIUS = AWNING_MAX_KERB + STREET_PROBE_MARGIN

# The slab: top face, soffit, and the fascia standing between them on the outer
# edge. One number for the thickness and the fascia depth because they are the
# same edge seen from the side -- 450 mm is a deep signage fascia and a plausible
# suspended slab, and keeping them equal is what makes the run a closed box.
AWNING_SLAB = 0.45

# Edges shorter than this get nothing. Below about two metres an awning is a
# porch hood rather than a shopfront canopy, and on a chamfered corner or a bay
# window it is four triangles of clutter at eye level.
AWNING_MIN_EDGE = 2.2

# Below this the building has no room for a shopfront and an awning both, and
# the 0.75x clamp would put the soffit at head height.
AWNING_MIN_BUILDING_HEIGHT = 3.6

# Under this, the soffit drops to 0.75 of the building height rather than sitting
# at AWNING_HEIGHT, so a single-storey shop keeps some wall above its awning
# instead of wearing it as a hat.
AWNING_SHORT_BUILDING = 4.3

# How far the neighbour-collision probe is held off the wall. Its only job is to
# stop the probe reporting the building's own footprint, and 150 mm does that
# while leaving a re-entrant wing of the SAME building still detected -- which is
# correct, because a canopy that would run into the other half of an L-shaped
# building is just as blocked as one that would run into next door's.
AWNING_PROBE_INSET = 0.15

# Overlap that counts as blocked. A hairline touch along a shared boundary is
# not an obstruction; half a square metre of another building under the canopy
# is.
AWNING_BLOCK_AREA = 0.5

# Which archetypes carry one. The rule is "is this a shop with a footpath in
# front of it", which excludes the two classes that are retail-tagged often
# enough to matter and have no awning in life: a warehouse (a roller door opens
# straight onto the lane) and a detached house running a shop out of the front
# room. `b.retail` is required as well, so this set is a filter on that flag
# rather than a source of awnings in its own right.
AWNING_ARCHETYPES = frozenset(
    {"retail_strip", "terrace", "walkup", "interwar_apartment", "modern_infill", "brutalist"}
)

# The top face goes on the roof slot, not on the `corrugated_steel` WALL slot,
# and that is the single most consequential material decision in this pass --
# see the block comment above `AwningNetwork.emit` for the whole argument.
AWNING_TOP_MATERIAL = "roof_steel"
AWNING_SLOT = "awning_fascia"

# Awnings enter no collision volume. The payload is the building prisms and
# nothing else (see `tiles.write_collision`), so a player can jump through a
# canopy today. Recorded as a gameplay follow-up rather than fixed here: whether
# a melee player can stand on an awning is a design decision, and the answer
# changes the payload format, which is a server change.

# --- Front doors --------------------------------------------------------------
#
# Spec 6.3's last line, and until now the only line of the grammar with nothing
# behind it: "Openings. Front door placed on the street-facing edge, at the bay
# nearest the footprint centroid." Every building in the city had windows and no
# way in, which is the kind of absence nobody names and everybody feels -- a
# terrace row reads as a row of *houses* because of the repeating door-window
# rhythm at street level, and without the door it is a wall with holes in it.
#
# The door is one number: where it stands, as a `u` in the same perimeter
# accumulation `build_walls` writes onto the wall quads. Everything else about it
# -- its width, its head height, whether it takes a fanlight, what colour it is
# painted -- the shader already has, out of the retail flag, the archetype index
# and the seed. So this costs one float in the parameter record and no geometry
# at all, which is the same trade the whole facade is built on.
#
# WHY THE `u` HAS TO COME OUT OF `build_walls`' OWN WALK and not from a fresh
# one: `build_walls` skips segments under `WALL_MIN_SEG` and accumulates `u` only
# over the ones it emits, so a ring with a 30 mm noise vertex in it produces a
# different `u` at every later corner than a naive re-walk would. A door placed
# by the second walk lands metres away from where it was aimed on exactly the
# footprints that carry those vertices -- which is most real OSM terraces. The
# two share `_wall_runs` so they cannot disagree.

# Leaf width. A Sydney front door is 820-870 mm of door in a 900 mm opening;
# 1.0 m is that opening plus its jamb linings. A shop is wider because it is a
# public entrance and usually a pair of glazed leaves.
DOOR_WIDTH = 1.0
DOOR_WIDTH_RETAIL = 1.3

# The architrave standing round the opening. 90 mm is a lambs-tongue architrave
# and it is also, deliberately, the same order as the 78 mm sash stile the window
# joinery already draws -- the two are the same trade and the same paint, and a
# door surround wider than that reads as a portal rather than as a doorway.
DOOR_ARCHITRAVE = 0.09

# Below this a building has no room for a door at all. 2.2 m is a head height
# plus a threshold, and what it actually excludes is the tail of the height
# resolver: sheds, awnings mapped as buildings, and car park decks the area arm
# of the classifier admitted at a metre or two.
DOOR_MIN_HEIGHT = 2.2

# Which archetypes get nothing, and why each is on the list rather than a general
# rule: a warehouse's opening is a roller door, which is a different object with a
# different module and its own pass; a tower and a brutalist office present a
# glazed lobby at street level, which the shopfront override already draws far
# better than a 1 m painted leaf would.
DOOR_EXCLUDE_ARCHETYPES = frozenset({"warehouse", "tower", "brutalist"})

# ...and the same argument from the material side. `curtain_wall` is drawn by a
# pipeline with no wall in it -- no plinth, no joint courses, no marks -- so a
# recessed timber leaf on one would be a painted rectangle floating on glass.
DOOR_EXCLUDE_MATERIALS = frozenset({"curtain_wall"})

# How far the kerb can be and still count as "this edge fronts a street", for a
# door. More than double the awning's 9 m and for a reason the awning does not
# have: an awning is over a footpath and stops being one the moment the building
# is set back off it, where a front door is a front door at any setback.
#
# 20 m is not a taste figure. Sweeping it over the inner ring's 30,177
# door-bearing buildings, the share left with no street-facing edge at all runs
# 14.8% at 12 m, 10.4% at 15 and 7.0% at 20, and -- the property that makes the
# sweep safe to read -- the edge a building *already* chose never moves as the
# limit rises. The pick is the nearest qualifying street, so extending the reach
# can only admit buildings that had none; it can never re-decide one that did.
# Measured directly: zero of 24,574 changed edge between 15 m and 40 m.
#
# So the only thing the limit trades is "a door on the wall facing the street
# 18 m away" against "a door on the longest wall, which on a terrace slice is a
# party wall". 20 m clears a federation house behind a deep front garden and a
# walk-up behind its lawn, and stops well short of the far side of a city block.
# As with the awning, the direction test is what actually discriminates -- see
# `_street_ahead`.
DOOR_MAX_KERB = 20.0

# The classes that are a carriageway but not, normally, an address -- and this
# is the one place the doors part company with the awnings.
#
# `AWNING_EXCLUDE_CLASSES` drops OSM's `service` outright, and for an awning that
# is right: a shop's rear wall on a lane has a loading hood at most. The first
# version of this pass borrowed the rule and it was wrong, visibly and at scale.
# 2,504 terraces in the inner ring -- 23% of them -- came back with no
# street-facing edge at all and fell through to the rear-lot path, and the
# footprints say plainly why: their front elevations stand two to four metres off
# a way OSM tags `service`, dead ahead at a cosine over 0.97. The Rocks, Millers
# Point, the small courts off Paddington and Surry Hills. A lane there is not the
# back of the property, it *is* the address.
#
# So the door search is two-tier rather than one filtered pass: a proper street
# wins if the building fronts one, and only a building that fronts no street at
# all is allowed to take its lane. That ordering is what stops a terrace with a
# 6 m frontage and a 3 m rear lane getting its front door out the back, which is
# what simply deleting the exclusion would have done. Measured over the ring:
# 84.8% of doors land on a street, 8.3% on a lane, 7.0% rear-lot.
DOOR_EXCLUDE_CLASSES = AWNING_EXCLUDE_CLASSES
DOOR_LANE_CLASSES: frozenset[str] = frozenset()

# The sentinel written into the parameter record for "this building has no door".
# Negative rather than zero, because zero is a perfectly good door position --
# the first vertex of the ring -- and a shader reading zero as "none" would
# delete the door off every building whose front edge happens to be the one the
# footprint starts on.
DOOR_NONE = -1.0

# Segments shorter than this are skipped by `build_walls` -- a wall quad 30 mm
# wide is not a wall, and real OSM footprints carry these (see `_dedupe_ring`).
# Hoisted out of the loop because the door placement has to skip exactly the same
# ones or its `u` lands somewhere else on the building.
WALL_MIN_SEG = 0.05

# How far the walls run *below* the pad, metres: a floor and a ceiling on a
# buried skirt whose real depth is decided per building by `tiles.build_tile`.
#
# It exists because of a decision made one level up: a building sits on one flat
# pad taken at its footprint centroid, because real buildings sit on levelled
# pads and a tilted building is far worse than a pad that daylight-cuts into a
# slope. The consequence is that downhill the ground falls away from the pad and
# the bottom of the wall parts company with it -- a hole you can see the sky
# through, which is why this is geometry rather than a shader trick.
#
# Measured over the inner ring: the ground drops 0.58 m below the pad at the
# median footprint corner, 1.76 m at p90 and 4.53 m at p99, with a worst case of
# 18.9 m under a mis-segmented block spanning a whole hillside. A fixed 1.5 m
# skirt closes 86% of footprints outright, which is a hole under one building in
# seven -- so the depth follows the footprint instead, and 1.5 m is only the
# floor it never goes below. That costs nothing: the same eight vertices, moved.
#
# The ceiling is there because the tail is pathological rather than
# architectural. Eight metres of buried wall is a genuine Sydney undercroft on a
# steep site; nineteen is one bad footprint, and following it would put a
# nineteen-metre blank wall in the middle of a suburb.
#
# What the ceiling used to do, and no longer does, is leave the hole. Capping the
# skirt at eight metres under a pad that stands nineteen above the ground is not
# a smaller hole; it is the same hole with a shorter wall in front of it, and on
# the sixteen buildings past the cap the player walked underneath the building
# and looked up into it -- the collision prism starts at the pad, so there was
# nothing there either. `tiles._pad_and_skirt` now brings the PAD down to meet
# the cap on exactly those sixteen and leaves the other 33,828 where they were.
WALL_SKIRT = 1.5
WALL_SKIRT_MAX = 8.0

# The skirt carries negative `v`, which the facade shader already handles the way
# this wants: `storeyCoord` puts anything at or below zero on the ground storey,
# `windowField` finds no opening below the sill so no window is ever drawn on it,
# and the plinth and soiling terms bottom out -- a dark masonry base, which is
# what the bottom of a wall cut into a slope looks like.

# Materials get their own merged mesh per tile (spec section 5: "merge by
# material"). This fixes the slot order so the client can map a mesh to a
# material without a lookup table per tile.
#
# APPEND ONLY, and it is worth being exact about which files that protects,
# because the note that used to stand here named the wrong one. A material index
# is written into two shipped artefacts and neither is self-describing:
#
#   * the glTF primitive's `material` field (`tiles.write_glb`), against a
#     material list the client maps positionally onto `facade.MATERIALS`;
#   * one byte per slab in the far layer's sidecar (`tiles.write_far_slabs`),
#     which `far.ts` indexes straight into its own `FAR_TINT` table.
#
# Inserting a slot anywhere but the end repaints the entire city with the wrong
# material and nothing in the output says so. (The facade *parameter record* used
# to carry a third copy, which is what the old note named; texel 2 slot 3 now
# carries the front door's position instead -- see `facade_params`.)
MATERIALS = (
    "brick_red",
    "brick_cream",
    "brick_brown",
    "sandstone",
    "concrete_precast",
    "curtain_wall",
    "corrugated_steel",
    "render_painted",
    "fibro",
    "roof_terracotta",
    "roof_steel",
    # Street surfaces (spec 7.3's "blue-metal road with sandstone kerbing",
    # 7.7's footpaths). Built by `streets.py`, not from any building.
    "road_asphalt",
    "footpath_concrete",
    "kerb_sandstone",
    # Park and verge grass (spec 7.5). Built by `vegetation.py`, not from any
    # building, and appended here rather than filed next to the other ground
    # surfaces above for the reason stated in capitals two paragraphs up: the
    # street slots' indices are already baked into every shipped parameter
    # record, and inserting ahead of them repaints the city.
    "park_grass",
    # The baked contact-occlusion skirt around every footprint. Built by
    # `contact.py`; the only slot in the world that is translucent, and the only
    # one that carries COLOR_0. Appended for the same reason as everything above
    # it, and it is the last slot for a second reason of its own: it is the only
    # one whose geometry is drawn *over* another slot's, so anything appended
    # after it is a surface that has to decide where it sits relative to a
    # ribbon that already sits on top of the ground.
    "contact_ao",
    # The signage fascia and soffit of a footpath awning -- `build_awning`
    # below. Its own slot rather than a wall material because it is the one
    # surface in the world whose colour is per *shop* rather than per building:
    # a retail strip's awnings merge into one continuous run across several
    # buildings and are then painted in shopfront-width blocks that have nothing
    # to do with where one title ends and the next begins. That is a hash of
    # world position, not a parameter-record fetch, so this slot carries no
    # `_BLDIDX` at all and reads no atlas.
    #
    # Appended after `contact_ao` despite that slot's note above, and it is safe
    # for the reason the note gives: an awning is 3.2 m up and shares no plan
    # area with a ribbon lying on the ground.
    "awning_fascia",
    # The three front-fence styles -- `fences.py`. THREE SLOTS AND NOT ONE, and
    # the reason is that a slot is the only channel this build has for telling
    # the client something per *primitive* without a parameter fetch.
    #
    # A fence's style is per building, like the paint: a street where every house
    # took the same fence is a housing estate, and one where the style changes
    # every 8 m down a single frontage is not a fence at all. The pipeline is the
    # only thing that knows where one building's fence ends, so the pipeline has
    # to make the choice -- and having made it, the cheapest way to say so is to
    # put the geometry in a different bucket. The alternative, a world-position
    # hash in the shader the way `awning_fascia` picks its signage colour, is
    # exactly the thing that changes mid-run, and on a fence that is a masonry
    # wall turning into a picket fence halfway along a garden.
    #
    # `fence_masonry` is a solid 0.75 m wall, opaque. The two open styles carry a
    # picket mask in their colour node's alpha and are alpha-tested, so the
    # garden shows through between the bars; they differ in pitch, duty and paint
    # and share one factory in `world/fences.ts`.
    #
    # NOT a wall slot for the masonry, and that is the decision this module is
    # most likely to be second-guessed on -- see `fences.MASONRY_SLOT_NOTE`.
    "fence_masonry",
    "fence_iron",
    "fence_timber",
)
MATERIAL_INDEX = {m: i for i, m in enumerate(MATERIALS)}

# The one place the two halves of the material system can be checked against each
# other, and it costs an import-time set difference.
#
# `attributes.MATERIAL_MIX` names slots as strings; a typo there does not raise
# anywhere -- `MATERIAL_INDEX.get(b.material, 0)` below silently returns brick_red
# and `tiles.build_tile` silently opens a mesh slot nothing ever reads. The
# symptom is a share of one archetype quietly reverting to red brick, which is
# indistinguishable from the distribution being wrong on purpose. This says so
# instead. It lives here rather than in `attributes` because `attributes` cannot
# import this module -- the dependency runs the other way.
_UNKNOWN = {
    m for mix in MATERIAL_MIX.values() for m, _ in mix
} - set(MATERIALS)
if _UNKNOWN:
    raise ValueError(
        f"attributes.MATERIAL_MIX draws materials that are not slots: {sorted(_UNKNOWN)}."
        f" Add them to MATERIALS above (append only) or fix the spelling."
    )

# Roof surfaces take their own material, chosen by era/type rather than by the
# wall material -- spec section 7.4 is emphatic that roofs carry enormous screen
# area and must be right.
ROOF_MATERIAL = {
    "terrace": "roof_steel",
    "federation": "roof_terracotta",
    "interwar_apartment": "roof_terracotta",
    "walkup": "roof_steel",
    "brutalist": "concrete_precast",
    "tower": "concrete_precast",
    "warehouse": "roof_steel",
    "brick_veneer": "roof_terracotta",
    "retail_strip": "roof_steel",
    "modern_infill": "concrete_precast",
}

# Per-building parameter record, 16 floats, uploaded to the client as a data
# texture (4 x RGBA32F texels per building). Order is load-bearing -- the WGSL
# side indexes these by name in `facade.ts`.
PARAMS_STRIDE = 16


@dataclass
class MeshBuffers:
    """Accumulating vertex/index arrays for one material slot."""

    positions: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    uvs: list[float] = field(default_factory=list)
    building_index: list[float] = field(default_factory=list)
    # Per-vertex RGBA in 0-1, written out as glTF COLOR_0. Empty on every slot
    # but `contact_ao`, which is the only geometry in the world whose shading is
    # baked rather than computed -- see `contact.py`. `tiles.write_glb` omits the
    # attribute entirely when this is empty, so no other slot pays a byte for it.
    colours: list[float] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    # Street surfaces belong to no building and read no facade parameters, so
    # they leave `_BLDIDX` off the primitive entirely rather than carrying a
    # column of zeroes -- four bytes a vertex over a million street vertices.
    building_indexed: bool = True

    def vertex_count(self) -> int:
        return len(self.positions) // 3

    def add_quad(
        self,
        a: tuple[float, float, float],
        b: tuple[float, float, float],
        c: tuple[float, float, float],
        d: tuple[float, float, float],
        normal: tuple[float, float, float],
        uv: tuple[tuple[float, float], ...],
        bidx: int,
    ) -> None:
        base = self.vertex_count()
        for p, t in zip((a, b, c, d), uv):
            self.positions.extend(p)
            self.normals.extend(normal)
            self.uvs.extend(t)
            if self.building_indexed:
                self.building_index.append(float(bidx))
        self.indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))

    def add_triangle_soup(
        self,
        verts: np.ndarray,  # (N, 3)
        normal: tuple[float, float, float],
        tris: np.ndarray,  # (M, 3) indices into verts
        bidx: int,
        uv_scale: float = 1.0,
    ) -> None:
        base = self.vertex_count()
        for p in verts:
            self.positions.extend((float(p[0]), float(p[1]), float(p[2])))
            self.normals.extend(normal)
            # Roof and cap surfaces use planar XZ UVs in metres, which is what
            # tile and corrugation patterns need.
            self.uvs.extend((float(p[0]) * uv_scale, float(p[2]) * uv_scale))
            if self.building_indexed:
                self.building_index.append(float(bidx))
        self.indices.extend((tris.ravel() + base).tolist())

    def add_surface(
        self,
        verts: np.ndarray,  # (N, 3) positions
        normals: np.ndarray | None,  # (N, 3), or None on an unlit slot
        uvs: np.ndarray | None,  # (N, 2), or None on an untextured slot
        tris: np.ndarray,  # (M, 3) indices into verts
        bidx: int = 0,
        colours: np.ndarray | None = None,  # (N, 4) RGBA in 0-1
    ) -> None:
        """Append a fully-formed vertex set.

        The general entry point, for geometry whose normals and UVs are not
        derivable from position the way a building's are -- street surfaces
        carry world-metre UVs so their patterns survive a tile boundary, and a
        kerb face carries a different normal at every vertex.

        `normals` and `uvs` are nullable because the contact skirt reads
        neither: it is drawn by an unlit material with no texture on it, so a
        normal and a UV would be 20 bytes a vertex of attributes nothing
        samples, over 816,352 vertices -- the largest triangle count in the
        build. Leaving them off takes that slot from 39.2 MB to 22.9 MB over the
        inner ring, and 28 bytes a vertex against every other slot's 40 to 44.

        Whichever way a slot is called, it must be called the same way every
        time -- `tiles.write_glb` refuses a slot whose attributes are of unequal
        length rather than emitting a primitive the client would read off the
        end of.
        """
        base = self.vertex_count()
        self.positions.extend(np.asarray(verts, dtype=np.float64).ravel().tolist())
        if normals is not None:
            self.normals.extend(np.asarray(normals, dtype=np.float64).ravel().tolist())
        if uvs is not None:
            self.uvs.extend(np.asarray(uvs, dtype=np.float64).ravel().tolist())
        if colours is not None:
            self.colours.extend(np.asarray(colours, dtype=np.float64).ravel().tolist())
        if self.building_indexed:
            self.building_index.extend([float(bidx)] * len(verts))
        self.indices.extend((np.asarray(tris).ravel() + base).tolist())


def _triangulate(ring: np.ndarray, holes: list[np.ndarray]) -> np.ndarray:
    """Ear-clip a polygon with holes into triangles. Returns (M, 3) indices.

    THE RINGS ARE ORIENTED FIRST, and that is what makes every flat surface in
    the build face upward by construction. earcut emits its triangles in the
    orientation of the ring it was given, and in ENU-to-renderer terms a
    counter-clockwise ring comes out with a `+y` right-hand normal -- so the
    exterior CCW / holes CW convention `merge.orient_footprint` states for
    footprints is the same convention that gets a roof cap, a carriageway and a
    park lawn shaded and culled the right way round.

    It matters here rather than only in the callers because half of them are not
    footprints: `streets._emit_flat` hands this the exterior of whatever GEOS
    produced from a union, a buffer or an intersection, and GEOS makes no
    promise at all about which way that goes round. Measured before this went
    in, `footpath_concrete` came out 99.5% agreeing with its own normals -- the
    missing half-percent being whole polygons triangulated upside down, which is
    a patch of footpath that vanishes under back-face culling.
    """
    # earcut wants one flat vertex array plus the exclusive end offset of each ring.
    rings = [_oriented_ring(ring, True)]
    rings.extend(_oriented_ring(h, False) for h in holes)
    # A closed ring repeats its first point; earcut must not see the duplicate.
    rings = [r[:-1] if len(r) > 3 and np.allclose(r[0], r[-1]) else r for r in rings]
    verts = np.concatenate(rings, axis=0)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tris = mapbox_earcut.triangulate_float64(verts, ends)
    return np.asarray(tris, dtype=np.int64).reshape(-1, 3), verts


def winding_agreement(
    positions: np.ndarray,
    normals: np.ndarray,
    indices: np.ndarray,
    quantum: np.ndarray | None = None,
) -> tuple[int, int, int]:
    """(agreeing, inside out, tested) over one primitive's triangles.

    TWO FAILURE COLUMNS, NOT ONE, because a smooth-shaded face and an inverted
    one are different objects and only the second is a bug this can fix.

      agreeing   the face's own right-hand normal points the same way as the
                 mean of its three vertex normals, which is the direction the
                 interpolated normal takes over the middle of the face.
      inside out the face disagrees with ALL THREE of its vertex normals. There
                 is then no point on it that is shaded front-side: it is lit
                 from behind everywhere and culled from the side you can see.
                 This is the number that has to be zero.

    The gap between them is a crease sharper than the smoothing across it can
    carry -- one vertex normal has swung past the face plane while the others
    have not. Only `kerb_sandstone` can produce it, because it is the one slot
    that shares vertices between faces on purpose (a 13 cm strip reads the same
    either way and sharing halves its vertex count), and it does so twice in the
    inner ring's 4.13 M triangles, at carriageway rings that double back on
    themselves. Every other slot here is flat-shaded -- each face owns its own
    three or four vertices and writes one normal on all of them -- so the mean
    IS that normal and the two columns say exactly the same thing.

    WHY THIS EXISTS AT ALL. A triangle carries two independent statements about
    which way it faces: the right-hand normal of its vertex order, which is what
    the rasteriser culls on, and the NORMAL attribute, which is what the shader
    lights on. Nothing in glTF, in three or in this pipeline ever compared them,
    so a build in which two thirds of the city's walls disagreed ran for months
    and still rendered a plausible Sydney -- an inside-out extrusion does not
    leave a hole, it shows you the inside of its own back wall.

    A triangle THINNER THAN ONE QUANTUM of its own coordinates is counted in
    neither column, and that criterion is **the precision of the stored geometry
    rather than a threshold anyone chose**. The ear clipper leaves slivers along
    every cut `streets._conform` makes against a terrain facet, and a sliver
    whose shortest altitude is a fraction of the grid its own vertices sit on
    has a cross product composed *entirely* of the rounding in those vertices.
    Its winding is not wrong, it is absent -- there is no orientation there to
    agree or disagree with.

    WHICH QUANTUM depends on how the caller came by its positions, and that is
    why it is an argument rather than a constant in here:

      * `quantum=None` -- the pipeline's own float32 buffers, which is what
        `slot_winding_agreement` passes. Tile-local coordinates out to 500 m,
        where an ulp is about 30 microns, taken per triangle at the coarsest
        coordinate that triangle carries.
      * a per-axis array -- geometry read back out of a shipped GLB, whose
        POSITION accessor `meshpack` quantised onto a lattice of 7 to 11 mm.
        **That is three hundred times coarser than the float32 ulp, and it is
        the whole of why this argument exists.** For the first weeks after the
        pack shipped, `cmd_winding_audit` could not read a packed tile at all;
        when it could, it was still measuring against the ulp, and every sliver
        whose two ends the quantiser had nudged onto opposite sides of its own
        centreline read as a real triangle with a real, meaningless normal.

    The bound is derived, not fitted. A vertex snapped to a lattice of step `s`
    moves at most `|s|/2`, and a point and the line it is measured against can
    move that far in opposite senses, so a genuinely degenerate triangle can
    show an altitude of at most one cell diagonal `|s|` and no more.

    The separation this produces is not marginal, which is what makes it safe to
    apply rather than a way of massaging the number. Measured over 120 tiles of
    the 15.3 km build -- 2.17 M triangles -- every one of the 9,317 triangles
    that disagreed with all three of its vertex normals sat *below* that bound,
    the worst at 0.787 of a cell, while the population of triangles at large
    sits at 11 cells at p25 and 23 at p50. The filter therefore removes one
    population entirely (1.38% of the triangles that have a normal) and leaves
    the other untouched, with **no disagreement of any size above the line
    anywhere in the sample**. An inside-out *wall* -- the failure this command
    was written for, where `build_walls` inverted two thirds of the city -- is
    metres across and thousands of cells wide, and no quantum of any plausible
    size hides one.

    The shortest altitude rather than the area, because these are slivers: a
    triangle five metres long and four microns wide has an area that reads as
    small on any scale you like, and what actually decides whether its normal
    means anything is the width.

    Two callers, one implementation: `slot_winding_agreement` below reads the
    buffers as the pipeline builds them, and `cli.cmd_winding_audit` reads the
    accessors back out of the shipped GLBs. The second is the one that counts --
    it is a check rather than a second opinion from the same witness -- and it
    is only trustworthy because it runs the same arithmetic.
    """
    pos = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    nrm = np.asarray(normals, dtype=np.float64).reshape(-1, 3)
    idx = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    if len(idx) == 0 or len(nrm) != len(pos):
        return 0, 0, 0
    a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    face = np.cross(b - a, c - a)
    twice_area = np.linalg.norm(face, axis=1)
    corners = (nrm[idx[:, 0]], nrm[idx[:, 1]], nrm[idx[:, 2]])
    n = (corners[0] + corners[1] + corners[2]) / 3.0

    longest = np.maximum(
        np.maximum(np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1)),
        np.linalg.norm(a - c, axis=1),
    )
    altitude = np.divide(twice_area, longest, out=np.zeros_like(twice_area), where=longest > 0.0)
    # The float32 quantum at this triangle's own distance from the tile origin.
    # `np.spacing` of the largest coordinate any of its three vertices carries,
    # which is where its own rounding is coarsest.
    step = np.spacing(
        np.abs(np.stack((a, b, c))).max(axis=(0, 2)).astype(np.float32)
    ).astype(np.float64)
    if quantum is not None:
        # One cell diagonal of the lattice the positions were stored on. The
        # float32 ulp stays as the floor rather than being replaced: it is the
        # precision of the arithmetic done *here*, and it is what a primitive
        # that kept its float32 column is limited by.
        step = np.maximum(step, float(np.linalg.norm(np.asarray(quantum, dtype=np.float64))))

    live = (altitude > step) & (np.linalg.norm(n, axis=1) > 1e-9)
    if not live.any():
        return 0, 0, 0
    f = face[live]
    agree = np.einsum("ij,ij->i", f, n[live]) > 0.0
    inverted = np.ones(len(f), dtype=bool)
    for corner in corners:
        inverted &= np.einsum("ij,ij->i", f, corner[live]) <= 0.0
    return int(agree.sum()), int(inverted.sum()), int(live.sum())


def slot_winding_agreement(slots: dict[str, MeshBuffers]) -> dict[str, tuple[int, int, int]]:
    """`winding_agreement` per material slot, for a tile's buffers as built.

    Slots with no NORMAL at all -- `contact_ao` is the only one -- report
    (0, 0, 0) and are shown as having nothing to disagree with, which is the
    truth: their winding is checked against the direction they are meant to face
    instead, and for the skirt that check lives in `contact._outward_ring`.
    """
    out: dict[str, tuple[int, int, int]] = {}
    for name, buf in slots.items():
        if not buf.indices:
            continue
        out[name] = winding_agreement(buf.positions, buf.normals, buf.indices)
    return out


def _oriented_ring(ring: np.ndarray, exterior: bool) -> np.ndarray:
    """One ring wound the way `_triangulate` needs it: CCW outside, CW inside."""
    r = np.asarray(ring, dtype=np.float64)
    if len(r) < 3:
        return r
    ccw = twice_signed_area(r) > 0.0
    return r if ccw == exterior else r[::-1]


def _ring_open(ring: np.ndarray) -> np.ndarray:
    """Ring without the duplicated closing vertex."""
    r = np.asarray(ring, dtype=np.float64)
    return r[:-1] if len(r) > 2 and np.allclose(r[0], r[-1]) else r


def facade_seed(building_id: str, fallback: int) -> int:
    """The per-building number that drives every randomised thing in the shader.

    Reads the id's last eight characters as hex, which is what it has always
    done: OSM ids are decimal digits and Microsoft ids are a blake2b hex digest,
    so both parse, and the spec's requirement that windows never shift between
    builds means that arithmetic cannot be changed for a building that already
    has one.

    Row slices are the exception, and the reason this is a function rather than
    an expression at the call site. `rows.py` gives one house of a row an id like
    `o409035064#7`, whose tail is not hex -- and the bare `int(..., 16)` this
    replaces did not fail gracefully on that, it raised and took the whole tile
    emission with it. CRC-32 over the full id gives those a seed that is stable
    across rebuilds for the same reason `attributes._stable_seed` is, without
    touching the number any existing building gets.

    `fallback` covers ids of eight characters or fewer, where there is no tail to
    read; callers pass the building's index within its tile.
    """
    if len(building_id) <= 8:
        return fallback
    try:
        return int(building_id[-8:], 16)
    except ValueError:
        return zlib.crc32(building_id.encode("utf-8"))


def facade_params(
    b: Building,
    seed: int,
    roof_half_short: float = 0.0,
    door_u: float = DOOR_NONE,
) -> list[float]:
    """The 16-float parameter record the facade shader reads.

    Everything the grammar in spec section 6.3 decides that does not need to be
    geometry: floor division, bay division, window placement, ground-floor
    override, openings, glazing character.

    `roof_half_short` comes back out of `build_roof`, which is the only place it
    is known, and fills what used to be a documented spare. See the comment on
    texel 3 below for what it means and why it is here.

    `door_u` comes out of `DoorNetwork.place`, and it took the last genuinely
    spare float in the record. See the comment on texel 2 below.
    """
    a = ARCHETYPES[b.archetype]

    # Floor division. Round to a whole number of storeys, then redistribute so
    # the floors divide the height exactly -- otherwise the top floor is short
    # and the window grid visibly drifts out of step near the roof.
    eave = max(b.height - (PARAPET_HEIGHT if a.roof_form in ("flat", "parapet") else 0.0), 2.4)
    ground = min(a.ground_floor_height, eave)
    upper_levels = max(int(round((eave - ground) / a.floor_height)), 0)
    floor_h = (eave - ground) / upper_levels if upper_levels else a.floor_height

    return [
        # texel 0: floor and bay division
        ground,                      # ground storey height, metres
        floor_h,                     # upper storey height, metres
        float(upper_levels + 1),     # total storeys
        a.bay_width,
        # texel 1: window placement within a bay
        a.window_width_ratio,
        a.sill_height,
        a.head_height,
        a.reveal_depth,
        # texel 2: identity and treatment
        float(seed & 0xFFFF),        # deterministic per-building, from the ID
        1.0 if b.retail else 0.0,    # ground-floor shopfront override
        # Slot 3, which held the material index and now holds the front door's
        # position -- metres along the perimeter, in `_wall_runs`' accumulation,
        # or DOOR_NONE for a building that gets none.
        #
        # It is the one float in this record that was GENUINELY spare, and the
        # argument is structural rather than "nothing reads it yet". A fragment's
        # material is the *pipeline it is compiled into*: `createFacadeMaterial`
        # is called once per slot with the slot's own albedo, roughness and
        # branch set baked in at graph-build time, so a shader that read a
        # material index out of a texel could not do anything with it that it had
        # not already done at compile time. It could never be needed here.
        #
        # The two places the build really does need a material index both carry
        # their own and neither goes through this record: the glTF primitive's
        # `material` field (`tiles.write_glb`) and the far layer's per-slab byte
        # (`tiles.write_far_slabs`). So this cost nothing to take.
        #
        # WHY NOT A LONGER RECORD. `PARAMS_STRIDE` 16 is four RGBA32F texels, and
        # `params-atlas.ts` packs buildings linearly into a 2048-texel row
        # *because* 4 divides 2048 -- that is what keeps a building's texels off a
        # row boundary and the shader's index arithmetic down to a mask and a
        # shift. Five texels divides no power of two, so a 20-float record forces
        # either an integer division per fetch or a jump to eight texels, which
        # doubles both the atlas and every `.params.bin` in the build to carry one
        # number. Taking a float that can never be read was the cheaper trade by
        # a wide margin.
        door_u,
        float(list(ARCHETYPES).index(b.archetype)),
        # texel 3: reserved for the LiDAR/roof pass and glazing character
        eave,
        b.height,
        _glazing_reflectivity(b.archetype),
        # Slot 4, which was a documented spare and is now the roof's half-width.
        #
        # It is exactly the number `finishRoof` in `client/src/world/facade.ts`
        # says it cannot do without: on a hip or gable the pitched slopes carry
        # `v` in metres up the fall line from the eave, so the RIDGE sits at this
        # value and nothing else in the shader could locate it. Same number, half
        # the `v` range, on a skillion or sawtooth pane.
        #
        # It is the half-width of the roof rectangle *including the eave
        # overhang*, because that is where the ridge is once the planes oversail
        # the walls, and locating the ridge is the whole purpose. 0.0 means there
        # is no pitched surface on this building at all -- a flat or parapet
        # form, or a footprint too degenerate for an oriented rectangle -- and a
        # shader that reads this must treat 0.0 as "no ridge" rather than as a
        # ridge at the eave.
        #
        # Landed as data only. Nothing in the shader reads it yet; that is the
        # roofs pass's own follow-up and this is the pipeline half of it.
        roof_half_short,
    ]


def _glazing_reflectivity(archetype: str) -> float:
    """How mirror-like the glass is. Spec section 7.3 wants the CBD's blue-green
    curtain wall highly reflective and everything older much less so."""
    return {
        "tower": 0.92,
        "modern_infill": 0.55,
        "brutalist": 0.35,
        "retail_strip": 0.45,
    }.get(archetype, 0.18)


def build_walls(
    buf: MeshBuffers,
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    base_y: float = 0.0,
    skirt: float = WALL_SKIRT,
) -> None:
    """Extrude the footprint into wall quads with metric UVs.

    `u` accumulates along the perimeter so a wall run's window rhythm is
    continuous around a corner, which is how real bay division behaves.

    `base_y` is the building's pad -- the ground height at its centroid, baked
    into the geometry rather than applied as a node transform, because the tile
    is one merged mesh per material and there is no per-building node to
    transform. The walls run from `base_y - skirt` to `base_y + height` while
    `v` still runs from `-skirt` to `height`, so the facade grammar is measured
    from this building's own ground and never learns where that is.

    ---------------------------------------------------------------------------
    WHICH WAY IS OUT, in full, because this is where the project got it wrong.

    1. `b.ring` is counter-clockwise in ENU. That is `Building`'s invariant, set
       once by `merge.orient_footprint`, and this function is entitled to it --
       it does not measure the winding and must not. Interior is on the LEFT of
       travel, so outward is the RIGHT of travel, and the ENU right of a
       direction `(de, dn)` is `(dn, -de)`.

    2. ENU to renderer is `x = east, y = up, z = -north` (`config.py`). Read as
       a map on 3-space, `(e, n, u) -> (e, u, -n)` is a **rotation** -- a -90
       degree turn about x, determinant +1 -- so it preserves handedness and a
       cross product survives it untouched. What it does *not* preserve is the
       2D plan map `(e, n) -> (x, z)`, whose determinant is -1: plotted on a
       page with x right and z up, every footprint comes out mirrored. Both are
       true, and only the first governs a normal. That is exactly the trap here
       -- reasoning about "the z flip reverses the winding" on the plan gives
       the opposite sign to reasoning about it in 3-space, and 3-space is right.

    3. An edge `(de, dn)` becomes `(dx, dz) = (de, -dn)`, so `de = dx` and
       `dn = -dz`. A displacement `(oe, on)` in ENU becomes `(oe, -on)` in the
       renderer's x/z, and outward is `(oe, on) = (dn, -de)`, so:

           outward = (dn, -(-de)) = (-dz, dx),  normalised by the edge length.

    4. The quad below is emitted bottom-p0, bottom-p1, top-p1, top-p0, and
       `add_quad` indexes it (0,1,2)(0,2,3). The first triangle's right-hand
       normal is therefore

           (b-a) x (c-a) = (dx, 0, dz) x (dx, h, dz) = (-dz*h, 0, dx*h),  h > 0

       which is the same vector as step 3. So the winding and the stored normal
       are one derivation, agreeing **by construction** -- not by an `_add_face`
       style test-and-reverse, and not by a pass afterwards.

    What was here before stored `(dz, 0, -dx)`, the exact negative, against that
    same winding. On a counter-clockwise ring the geometry faced out and the
    shading normal pointed into the building; on a clockwise one -- which is
    what 46% of the rings were, before the invariant -- the normal came out
    right and every wall triangle faced inward, so back-face culling removed the
    near walls of 61% of the city and left you looking at the inside of its back
    walls. `sydney winding-audit` is what stops that returning silently.
    """
    ring = _ring_open(b.ring)
    if len(ring) < 3:
        return
    oe, on = origin
    a = ARCHETYPES[b.archetype]
    eave = max(b.height - (PARAPET_HEIGHT if a.roof_form in ("flat", "parapet") else 0.0), 2.4)
    top = b.height  # walls run to the parapet where there is one
    foot = -skirt

    for u, seg, p0, p1 in _wall_runs(ring):
        e0, n0 = float(p0[0]), float(p0[1])
        e1, n1 = float(p1[0]), float(p1[1])
        # ENU -> renderer: x = east, z = -north.
        x0, z0 = e0 - oe, -(n0 - on)
        x1, z1 = e1 - oe, -(n1 - on)
        dx, dz = x1 - x0, z1 - z0
        # Outward, from the counter-clockwise ENU ring. Step 3 of the chain in
        # the docstring; step 4 is that the quad below winds to this same vector.
        nx, nz = -dz / seg, dx / seg
        buf.add_quad(
            (x0, base_y + foot, z0),
            (x1, base_y + foot, z1),
            (x1, base_y + top, z1),
            (x0, base_y + top, z0),
            (nx, 0.0, nz),
            ((u, foot), (u + seg, foot), (u + seg, top), (u, top)),
            bidx,
        )
    _ = eave


def _wall_runs(ring: np.ndarray) -> Iterator[tuple[float, float, np.ndarray, np.ndarray]]:
    """The perimeter walk, as `(u at the edge's start, edge length, p0, p1)`.

    THE definition of `u` for this project. Every wall quad's UV comes out of
    here, and so does the front door's position, which is why it is a generator
    rather than three lines inlined in `build_walls`: a door is placed as a `u`
    in this accumulation, so any difference between how the two walk the ring is
    a door that is not where the shader draws it.

    The skip is the whole reason that matters. `u` advances only over segments
    long enough to emit, so a footprint carrying a 30 mm noise vertex -- which is
    most hand-mapped OSM terraces -- accumulates a *shorter* perimeter than its
    coordinates suggest, and every edge after the noise sits at a different `u`
    than a naive walk would put it at.

    Points are the ring's own ENU rows, not renderer coordinates: the length of
    an edge is the same either way, and the door's street test wants ENU.
    """
    n = len(ring)
    u = 0.0
    for i in range(n):
        p0 = ring[i]
        p1 = ring[(i + 1) % n]
        seg = math.hypot(float(p1[0] - p0[0]), float(p1[1] - p0[1]))
        if seg < WALL_MIN_SEG:
            continue
        yield u, seg, p0, p1
        u += seg


# --- Roof clipping ------------------------------------------------------------
#
# Four small helpers, all of them working in ENU plan and all of them taking the
# roof's height field as a callable so that the same code serves a skillion, a
# sawtooth tooth, a hip slope and a hip end without knowing which it has. See
# ROOF_OVERSAIL_TOL above for why any of this exists.


def _footprint_poly(ring: np.ndarray) -> Polygon | None:
    """The footprint as a valid shapely polygon, or None if it is not one."""
    if len(ring) < 3:
        return None
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon":
        return None
    return poly


def _frame_oversails(poly: Polygon, rect_poly: Polygon, tol: float) -> bool:
    """Does the roof rectangle reach more than `tol` metres past the footprint?

    Asked as a covering test rather than as a distance, because the distance is
    the thing that is easy to get wrong here. The obvious version -- walk the
    vertices of `rect_poly.difference(poly)` and take the farthest from the
    footprint -- reads 0.23 m on a Federation house whose rectangle stands 6.4 m
    clear of it, because the uncovered region there is a long crescent hugging
    the plan and every VERTEX of a crescent is near the thing it hugs. The point
    that is farthest from a polygon is generally in the middle of a region, not
    at a corner of one.

    Dilating the footprint by `tol` and asking whether anything of the rectangle
    is left over is the same question with no sampling in it: a point survives
    the difference exactly when it is more than `tol` from the building.
    """
    over = rect_poly.difference(poly.buffer(tol))
    # A sliver is what a rectangle that oversails by 1.0000001 m leaves, and
    # flipping a whole roof's construction on that is a coin toss dressed as a
    # threshold. Quarter of a square metre is below anything visible and well
    # above what GEOS rounds into existence along a shared edge.
    return (not over.is_empty) and over.area > 0.25


def _clip_piece(
    buf: MeshBuffers,
    region,
    cover: Polygon,
    height,
    uv,
    normal: tuple[float, float, float],
    bidx: int,
    origin: tuple[float, float],
) -> None:
    """Emit one planar roof piece, clipped to `cover`.

    `region` is the piece's plan polygon in the rectangle's own subdivision --
    a whole rectangle for a skillion, a strip for a sawtooth tooth, a trapezoid
    for a hip slope, a triangle for a hip end. `height` and `uv` evaluate the
    piece's plane at any ENU point, so the clipped boundary carries exactly the
    heights and texture coordinates the unclipped quad would have had there;
    nothing is approximated by the clip.

    The winding needs no enforcement here the way `_add_face` needs it: earcut
    emits in the orientation of the ring it is given and `_triangulate` orients
    that ring counter-clockwise, which is +y in the renderer -- the same route
    `flat_cap` takes, and the same reason it can state its normal outright.
    """
    oe, on = origin
    part = region if isinstance(region, Polygon) else Polygon(np.asarray(region))
    if not part.is_valid:
        part = part.buffer(0)
    if part.is_empty:
        return
    clipped = part.intersection(cover)
    if clipped.is_empty:
        return
    for g in getattr(clipped, "geoms", [clipped]):
        if g.geom_type != "Polygon" or g.area < ROOF_PIECE_MIN_AREA:
            continue
        ring = np.asarray(g.exterior.coords, dtype=np.float64)
        holes = [np.asarray(h.coords, dtype=np.float64) for h in g.interiors]
        tris, verts2d = _triangulate(ring, holes)
        if len(tris) == 0:
            continue
        ys = np.asarray([height(p) for p in verts2d], dtype=np.float64)
        verts = np.column_stack((verts2d[:, 0] - oe, ys, -(verts2d[:, 1] - on)))
        uvs = np.asarray([uv(p) for p in verts2d], dtype=np.float64)
        normals = np.tile(np.asarray(normal, dtype=np.float64), (len(verts), 1))
        buf.add_surface(verts, normals, uvs, tris, bidx)


def _cover_boundary(cover: Polygon) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """The clipped roof's outer edge as (p0, p1, outward) segments in ENU.

    Counter-clockwise, so the interior is on the left of travel and outward is
    the right of it. Interior rings are not walked: a courtyard's roof edge is a
    surface this function's callers do not build, and giving it a fascia would
    hang trim on a hole.
    """
    ring = np.asarray(orient(cover, 1.0).exterior.coords, dtype=np.float64)
    out = []
    for i in range(len(ring) - 1):
        p0, p1 = ring[i], ring[i + 1]
        d = p1 - p0
        run = float(np.hypot(d[0], d[1]))
        if run < WALL_MIN_SEG:
            continue
        out.append((p0, p1, np.array([d[1], -d[0]]) / run))
    return out


def _roof_closure(
    buf: MeshBuffers,
    edges,
    height,
    wall_head: float,
    bidx: int,
    origin: tuple[float, float],
) -> None:
    """Wall the gap between the wall head and a roof edge that sits above it.

    On a rectangular plan there is no gap: the roof meets the wall line exactly
    at the wall head all the way round, which is what makes the unclipped path
    safe without this. Clip the roof to an L and the inner corner cuts across
    the slope halfway up it, leaving the roof void open to the street through a
    surface that is single-sided and therefore not even visible from inside --
    a hole you can see the sky through. The same is true, and always has been,
    along both long sides of a sawtooth, whose teeth were emitted as bare
    coplanar strips with no risers under them.

    Emitted into the roof's own slot, which is where `build_roof` already puts a
    gable end for the same reason: it is the roof's closure, not the wall's, and
    on a terracotta roof it reads as the verge tile it would be.
    """
    oe, on = origin

    def world(p2, y):
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    for p0, p1, outward in edges:
        y0 = height(p0)
        y1 = height(p1)
        if max(y0, y1) <= wall_head + 0.01:
            continue
        # Clamp to the wall head rather than dropping the segment: a boundary
        # that crosses the ridge has one end above the head and one below, and
        # the closure has to stop where the roof meets the wall, not vanish.
        a = world(p0, min(y0, wall_head))
        bb = world(p1, min(y1, wall_head))
        c = world(p1, max(y1, wall_head))
        d = world(p0, max(y0, wall_head))
        _add_face(
            buf,
            (a, bb, c, d),
            ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)),
            _enu_dir(outward),
            bidx,
        )


def _clip_line(cover: Polygon, p0: np.ndarray, p1: np.ndarray) -> list[tuple[float, float]]:
    """Which parameter intervals of the segment p0->p1 lie inside `cover`.

    Used for ridge and hip capping, which is a stick rather than a surface and
    would otherwise be left hanging in the air over the part of the rectangle
    the roof no longer occupies.
    """
    run = float(np.hypot(*(p1 - p0)))
    if run < 0.25:
        return []
    seg = LineString([tuple(p0), tuple(p1)])
    inside = seg.intersection(cover)
    if inside.is_empty:
        return []
    out = []
    for g in getattr(inside, "geoms", [inside]):
        if g.geom_type != "LineString" or g.length < 0.25:
            continue
        cs = np.asarray(g.coords, dtype=np.float64)
        ts = [float(np.dot(c - p0, p1 - p0)) / (run * run) for c in (cs[0], cs[-1])]
        out.append((min(ts), max(ts)))
    return out


def build_roof(
    slots: dict[str, MeshBuffers],
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    base_y: float = 0.0,
    roof_material: str = "roof_steel",
) -> float:
    """Cap the building with its roof form, `base_y` metres up on its pad.

    Pitched forms are built against the footprint's minimum-area rectangle rather
    than the true polygon. Detached houses -- which is what pitched roofs are for
    here -- are near-rectangular in overwhelming majority, and the alternative
    (a straight skeleton over an arbitrary polygon) costs far more than the
    difference is worth at the distances these are seen from.

    Takes the whole slot table rather than one buffer, because a roof is no
    longer one material. The planes and their ridge capping are the roof's own;
    the fascia is painted timber, the parapet capping is painted render or
    precast, and a chimney is brick -- four slots that all already exist, none of
    which is the roof's. Passing the table is what lets the rectangle frame be
    solved once and used by all of them.

    Returns the roof rectangle's half-width, which is `facade_params`' texel 3
    slot 4 and is documented there. 0.0 where there is no pitched surface.
    """
    buf = slots[roof_material]
    oe, on = origin
    form = b.roof_form
    ring = _ring_open(b.ring)
    if len(ring) < 3:
        return 0.0
    eaves_y = base_y + b.height
    # Trim is eye-level silhouette detail; see TRIM_MAX_HEIGHT.
    trim = b.height <= TRIM_MAX_HEIGHT

    def world(p2: np.ndarray, y: float) -> tuple[float, float, float]:
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    def flat_cap() -> None:
        # Up-facing by construction: `_triangulate` orients its rings, and a
        # counter-clockwise ENU ring ear-clips to triangles whose right-hand
        # normal is +y once east/north become x/-z. So the (0, 1, 0) below is
        # the winding's own normal and not an assertion over the top of it.
        tris, verts2d = _triangulate(b.ring, b.holes)
        verts = np.column_stack(
            (verts2d[:, 0] - oe, np.full(len(verts2d), eaves_y), -(verts2d[:, 1] - on))
        )
        buf.add_triangle_soup(verts, (0.0, 1.0, 0.0), tris, bidx)

    # Pitched: work in the oriented rectangle's frame.
    rect = None
    if form not in ("flat", "parapet") and len(ring) >= 4:
        rect = _oriented_rect(ring)

    if rect is None:
        flat_cap()
        if trim:
            # Only a form that is *meant* to be flat gets a capping band. A
            # pitched form that fell through to here did so because its footprint
            # was degenerate, and putting a terrace's parapet capping on it would
            # advertise the fallback rather than hide it.
            if form in ("flat", "parapet"):
                _parapet_cap(slots, b, bidx, origin, base_y)
            _chimneys(slots, b, bidx, origin, base_y, None, None, _footprint_poly(ring))
        return 0.0

    centre, axis_long, axis_short, half_long, half_short = rect
    pitch = math.radians(ROOF_PITCH.get(form, 22.0))
    rise = min(half_short * math.tan(pitch), 6.0)

    # The eave overhang is taken by growing the rectangle before any plane is
    # built, so the planes oversail the walls on all four sides for nothing --
    # the same quads, moved. An overhang added as separate strips afterwards
    # would have cost eight more triangles a house and left a seam along every
    # eave for the shader to disagree with itself across.
    #
    # The ridge does not move. It is the EAVE that drops, by the overhang times
    # the plane's own fall, so the pitch is unchanged and the plane still passes
    # through the wall line at exactly the height it used to end there. That
    # property is what lets a gable's end triangle stay where it was -- see below
    # -- and it is why the overhang is applied to the geometry rather than to the
    # height.
    #
    # Sawtooth takes none of it. Its teeth are emitted as coplanar strips of one
    # skillion plane, so there is one eave in that geometry rather than one per
    # tooth, and trim built against the wrong shape is worse than none.
    #
    # The risers ARE emitted now, and by `_roof_closure` rather than here. They
    # used to be recorded as missing and skipped; the clip that stops the teeth
    # oversailing the walls needs the identical surface -- a wall from the head
    # up to a roof edge standing above it -- so one emitter serves both and the
    # sawtooth stops being a skillion with a comment on it.
    overhang = EAVE_OVERHANG if (trim and form in ("hip", "gable", "skillion")) else 0.0
    hl = half_long + overhang
    hs = half_short + overhang

    base = eaves_y
    apex = base + rise

    # Does this footprint fill its own rectangle? See ROOF_OVERSAIL_TOL. Where it
    # does, `cover` stays None and every emitter below takes the path it always
    # took; where it does not, `cover` is the footprint grown by the eave and the
    # roof is clipped to it.
    #
    # A sawtooth is clipped unconditionally, and the reason is the closure rather
    # than the oversail: its long sides are open from the wall head to the pane
    # on every warehouse in the build, rectangular or not. On a plan that really
    # is a rectangle the clip itself is a no-op -- `cover` and the frame are the
    # same polygon -- so this costs those buildings the intersection and nothing
    # else.
    foot = _footprint_poly(ring)
    cover = None
    if foot is not None:
        rect_poly = Polygon(
            [
                centre - axis_long * half_long - axis_short * half_short,
                centre + axis_long * half_long - axis_short * half_short,
                centre + axis_long * half_long + axis_short * half_short,
                centre - axis_long * half_long + axis_short * half_short,
            ]
        )
        if form == "sawtooth" or _frame_oversails(foot, rect_poly, ROOF_OVERSAIL_TOL):
            grown = foot if overhang <= 0.0 else foot.buffer(
                overhang, join_style=2, mitre_limit=2.0
            )
            if grown.geom_type == "Polygon" and not grown.is_empty:
                cover = grown

    def along(p2) -> float:
        """The point's offset along the rectangle's long axis, metres."""
        return float(np.dot(np.asarray(p2, dtype=np.float64) - centre, axis_long))

    def across(p2) -> float:
        """The same across the short axis -- 0 on the ridge line."""
        return float(np.dot(np.asarray(p2, dtype=np.float64) - centre, axis_short))

    if form == "skillion":
        # One plane, high edge on the long axis' positive-short side. `rise` is
        # measured over half the width but applied across all of it, so the
        # plane's real fall is half the nominal pitch; the overhang has to use
        # the real one or the eave would drop twice as far as the roof falls.
        fall = rise / (2.0 * half_short) if half_short > 1e-6 else 0.0
        low = base - overhang * fall
        high = base + rise + overhang * fall
        c0 = centre - axis_long * hl - axis_short * hs
        c1 = centre + axis_long * hl - axis_short * hs
        c2 = centre + axis_long * hl + axis_short * hs
        c3 = centre - axis_long * hl + axis_short * hs
        # `_add_face`, not `add_quad`, on every roof plane below. The corner
        # order here comes out of `_oriented_rect`, whose axis signs are
        # inherited from whichever vertex shapely started its minimum rectangle
        # at -- arbitrary between two buildings and therefore not something a
        # normal can be derived from. `_plane_normal` answers "which way is up",
        # which is the right answer for a roof; `_add_face` is what makes the
        # winding follow it. Before this the two were independent coin flips and
        # the pitched slots read 83-88% agreement.
        normal = _plane_normal(world(c0, low), world(c1, low), world(c2, high))

        def skillion_y(p2) -> float:
            return low + (across(p2) + hs) / (2.0 * hs) * (high - low)

        def skillion_uv(p2):
            return (along(p2) + hl, across(p2) + hs)

        if cover is None:
            _add_face(
                buf,
                (world(c0, low), world(c1, low), world(c2, high), world(c3, high)),
                ((0.0, 0.0), (2 * hl, 0.0), (2 * hl, 2 * hs), (0.0, 2 * hs)),
                normal,
                bidx,
            )
            if overhang:
                _eave_trim(
                    slots, b, bidx, origin,
                    [
                        (c0, low, c1, low, -axis_short, True),
                        (c2, high, c3, high, axis_short, True),
                        (c1, low, c2, high, axis_long, True),
                        (c3, high, c0, low, -axis_long, True),
                    ],
                    overhang,
                )
        else:
            _clip_piece(
                buf, (c0, c1, c2, c3), cover,
                skillion_y, skillion_uv, normal, bidx, origin,
            )
            edges = _cover_boundary(cover)
            _roof_closure(buf, edges, skillion_y, eaves_y, bidx, origin)
            if overhang:
                _eave_trim(
                    slots, b, bidx, origin,
                    [
                        (p0, skillion_y(p0), p1, skillion_y(p1), out, True)
                        for p0, p1, out in edges
                    ],
                    overhang,
                )
        # A skillion has no ridge, so a chimney stands on the plane's mid-line at
        # the plane's own mid height. Three buildings in the inner ring are a
        # chimney archetype carrying an OSM `roof:shape` of skillion, and without
        # this they would take the flat placement and stand at the wall head --
        # half buried on the high side and floating on the low.
        _chimneys(
            slots, b, bidx, origin, base_y, rect,
            (centre - axis_long * hl, centre + axis_long * hl, (low + high) * 0.5),
            foot,
        )
        return hs

    if form == "sawtooth":
        # Repeating teeth across the long axis -- the warehouse signature.
        teeth = max(2, min(int((2 * half_long) // 9.0), 12))
        step = (2 * half_long) / teeth

        def sawtooth_y(p2) -> float:
            if half_short <= 1e-6:
                return base
            return base + (across(p2) + half_short) / (2.0 * half_short) * rise

        for t in range(teeth):
            l0 = -half_long + t * step
            l1 = l0 + step
            a0 = centre + axis_long * l0 - axis_short * half_short
            a1 = centre + axis_long * l1 - axis_short * half_short
            b1 = centre + axis_long * l1 + axis_short * half_short
            b0 = centre + axis_long * l0 + axis_short * half_short
            normal = _plane_normal(world(a0, base), world(a1, base), world(b1, apex))
            if cover is None:
                _add_face(
                    buf,
                    (world(a0, base), world(a1, base), world(b1, apex), world(b0, apex)),
                    ((0.0, 0.0), (step, 0.0), (step, 2 * half_short), (0.0, 2 * half_short)),
                    normal,
                    bidx,
                )
            else:
                # `u` restarts at each tooth, exactly as the quad's own corner
                # UVs did, so a clipped tooth reads the same corrugation the
                # whole one did rather than a run that carries across the teeth.
                _clip_piece(
                    buf, (a0, a1, b1, b0), cover, sawtooth_y,
                    (lambda p2, _l0=l0: (along(p2) - _l0, across(p2) + half_short)),
                    normal, bidx, origin,
                )
        if cover is not None:
            # The risers. One wall from the head up to the pane, all the way
            # round -- which on a rectangular warehouse is the two long sides and
            # nothing else, since the low side's pane meets the head exactly.
            _roof_closure(buf, _cover_boundary(cover), sawtooth_y, eaves_y, bidx, origin)
        return half_short

    # hip / gable: ridge along the long axis, at mid-short.
    ridge0 = centre - axis_long * (hl if form == "gable" else hl * 0.55)
    ridge1 = centre + axis_long * (hl if form == "gable" else hl * 0.55)
    e00 = centre - axis_long * hl - axis_short * hs
    e01 = centre + axis_long * hl - axis_short * hs
    e11 = centre + axis_long * hl + axis_short * hs
    e10 = centre - axis_long * hl + axis_short * hs

    # Where the eave sits once the planes oversail. `fall` is the plane's rise
    # over its run, measured on the wall rectangle so the clamp on `rise` cannot
    # make the overhang steeper than the roof it hangs off.
    fall = rise / half_short if half_short > 1e-6 else 0.0
    base = eaves_y - overhang * fall

    # The height field the rectangle defines, stated once and read by the clipped
    # surface, its closure and its trim alike. A slope falls from the ridge by
    # `fall` per metre out; a hip end falls the same total over the shorter run
    # from the ridge end to the rectangle's end.
    ridge_half_long = float(abs(np.dot(ridge1 - centre, axis_long)))
    hip_run = max(hl - ridge_half_long, 1e-6)
    hip_fall = (apex - base) / hip_run

    def slope_y(p2) -> float:
        return apex - abs(across(p2)) * fall

    def slope_uv(p2):
        return (along(p2) + hl, hs - abs(across(p2)))

    def hip_y(p2) -> float:
        return base + (hl - abs(along(p2))) * hip_fall

    def planar_uv(p2):
        return (float(p2[0]) - oe, -(float(p2[1]) - on))

    def roof_y(p2) -> float:
        """The whole roof, whichever plane covers this point.

        A hip end governs where it is steeper than the slope beside it, which is
        exactly where the two planes cross -- so the lower of the two is the
        surface, and no wedge test is needed to find out which.
        """
        if form != "hip":
            return slope_y(p2)
        return min(slope_y(p2), hip_y(p2))

    # Two main slopes. `v` still starts at 0 on the eave, which every eave-keyed
    # effect in `finishRoof` depends on; it now ends at `hs` rather than
    # `half_short`, which is the number returned to the parameter record.
    for near, far, r0, r1 in ((e00, e01, ridge0, ridge1), (e11, e10, ridge1, ridge0)):
        normal = _plane_normal(world(near, base), world(far, base), world(r1, apex))
        if cover is None:
            _add_face(
                buf,
                (world(near, base), world(far, base), world(r1, apex), world(r0, apex)),
                ((0.0, 0.0), (2 * hl, 0.0), (2 * hl, hs), (0.0, hs)),
                normal,
                bidx,
            )
        else:
            _clip_piece(
                buf, (near, far, r1, r0), cover,
                slope_y, slope_uv, normal, bidx, origin,
            )

    if cover is not None and form == "hip":
        # The hip ends, on the same terms: the triangle they occupied in the
        # rectangle, clipped, with planar world-XZ UVs as before.
        for corner_a, corner_b, ridge in ((e01, e11, ridge1), (e10, e00, ridge0)):
            normal = _plane_normal(
                world(corner_a, base), world(corner_b, base), world(ridge, apex)
            )
            _clip_piece(
                buf, (corner_a, corner_b, ridge), cover,
                hip_y, planar_uv, normal, bidx, origin,
            )
    elif cover is not None:
        # A gable's end wall is not emitted on this path. It stood on the wall
        # rectangle's end, which on a plan that needed clipping is out over open
        # ground; `_roof_closure` below walls the roof's real end instead, which
        # is where the building actually stops.
        pass
    elif form == "hip":
        # Two triangular hip ends. Part of the roof surface, so they oversail
        # with everything else. `_add_tri` rather than `add_triangle_soup`, and
        # the UVs are written out because that is what the soup was deriving:
        # planar world XZ in metres, which is what the tile and corrugation
        # patterns are keyed to.
        for corner_a, corner_b, ridge in ((e01, e11, ridge1), (e10, e00, ridge0)):
            va = world(corner_a, base)
            vb = world(corner_b, base)
            vr = world(ridge, apex)
            _add_tri(
                buf,
                (va, vb, vr),
                ((va[0], va[2]), (vb[0], vb[2]), (vr[0], vr[2])),
                _plane_normal(va, vb, vr),
                bidx,
            )
    else:
        # Gable ends: vertical triangles closing the wall up to the ridge, and
        # they stay on the WALL rectangle at the WALL top while the planes above
        # them oversail. That is what a gable is -- the end wall stops at the
        # wall line and the roof runs past it -- and the plane still passes
        # through the triangle's own corners, because the overhang was taken out
        # of the eave rather than out of the pitch.
        g01 = centre + axis_long * half_long - axis_short * half_short
        g11 = centre + axis_long * half_long + axis_short * half_short
        g00 = centre - axis_long * half_long - axis_short * half_short
        g10 = centre - axis_long * half_long + axis_short * half_short
        # A gable end is the one surface in this function that is VERTICAL, and
        # `_plane_normal` cannot serve it: that helper forces the y component
        # non-negative, which picks a side for a sloping plane and picks nothing
        # for an upright one -- on a face whose true normal has y = 0 the guard
        # never fires and the answer is whatever the arbitrary corner order gave.
        # The gable ends stand at the two ends of the long axis, so their
        # outward direction is the long axis itself and is known exactly.
        for corner_a, corner_b, ridge, facing in (
            (g01, g11, ridge1, axis_long),
            (g10, g00, ridge0, -axis_long),
        ):
            va = world(corner_a, eaves_y)
            vb = world(corner_b, eaves_y)
            vr = world(ridge, apex)
            _add_tri(
                buf,
                (va, vb, vr),
                ((va[0], va[2]), (vb[0], vb[2]), (vr[0], vr[2])),
                _enu_dir(facing),
                bidx,
            )

    if cover is not None:
        edges = _cover_boundary(cover)
        # The verge. Everywhere the clipped roof edge stands above the wall head
        # -- every inner corner of an L, and the whole end of a clipped gable.
        _roof_closure(buf, edges, roof_y, eaves_y, bidx, origin)
        if trim:
            if overhang:
                # One boxed eave all the way round, at whatever height the roof
                # reaches on each segment. A gable's raked verge is not
                # distinguished here the way it is below: after clipping there is
                # no rectangle end to rake against, and a boxed eave that follows
                # the real edge is both simpler and closer to the truth than a
                # barge board on a line the building does not have.
                _eave_trim(
                    slots, b, bidx, origin,
                    [
                        (p0, roof_y(p0), p1, roof_y(p1), out, True)
                        for p0, p1, out in edges
                    ],
                    overhang,
                )
            _ridge_caps(
                buf, bidx, origin, form, centre, axis_long, axis_short,
                hl, hs, ridge0, ridge1, apex, base, fall, cover,
            )
            _chimneys(slots, b, bidx, origin, base_y, rect, (ridge0, ridge1, apex), foot)
        return hs

    if trim:
        if overhang:
            if form == "hip":
                # Four horizontal eaves, all at the same height.
                _eave_trim(
                    slots, b, bidx, origin,
                    [
                        (e00, base, e01, base, -axis_short, True),
                        (e01, base, e11, base, axis_long, True),
                        (e11, base, e10, base, axis_short, True),
                        (e10, base, e00, base, -axis_long, True),
                    ],
                    overhang,
                )
            else:
                # Two horizontal eaves plus four raked barge boards, and no
                # soffit on the rake: a barge board on a closed verge *is* the
                # closure, so the eight triangles a raked soffit would cost buy
                # nothing that is ever seen.
                _eave_trim(
                    slots, b, bidx, origin,
                    [
                        (e00, base, e01, base, -axis_short, True),
                        (e11, base, e10, base, axis_short, True),
                        (e01, base, ridge1, apex, axis_long, False),
                        (ridge1, apex, e11, base, axis_long, False),
                        (e10, base, ridge0, apex, -axis_long, False),
                        (ridge0, apex, e00, base, -axis_long, False),
                    ],
                    overhang,
                )
        _ridge_caps(buf, bidx, origin, form, centre, axis_long, axis_short,
                    hl, hs, ridge0, ridge1, apex, base, fall)
        _chimneys(slots, b, bidx, origin, base_y, rect, (ridge0, ridge1, apex), foot)

    return hs


# --- Trim primitives ----------------------------------------------------------
#
# Everything below emits its faces with the winding and the stored normal
# AGREEING -- the triangle's own (b-a) x (c-a) points the same way as the normal
# it carries. `_add_face` enforces it rather than trusting the caller, because
# these faces are built in the oriented rectangle's frame and shapely's corner
# order decides the sign of that frame, so a caller cannot know.
#
# `build_walls` reaches the same place by the other route, and the difference is
# worth keeping in view. There the outward direction is *derived* -- from a
# footprint whose winding `merge.orient_footprint` guarantees -- and the quad is
# written in the order that derivation implies, so nothing has to be tested.
# Here there is nothing to derive from: these faces are built in the oriented
# rectangle's frame, whose axis signs come from whichever corner shapely started
# at, so the normal is stated and the winding is made to follow it. Derive where
# you can, enforce where you cannot; what is not available is what this build
# did until the winding pass, which was neither.


def _enu_dir(v2) -> tuple[float, float, float]:
    """An ENU (east, north) direction as a renderer normal. x = east, z = -north."""
    return (float(v2[0]), 0.0, float(-v2[1]))


def _turn(a, b, c, normal) -> float:
    """How strongly the triangle `a, b, c` winds toward `normal`. Sign is what
    matters; the magnitude is twice the area times the cosine between them."""
    return float(np.dot(np.cross(np.subtract(b, a), np.subtract(c, a)), normal))


def _add_face(buf: MeshBuffers, pts, uvs, normal, bidx: int) -> None:
    """One quad, wound to agree with `normal`, reversing the order if it does not.

    BOTH HALVES ARE CHECKED, not just the first, and the difference is not
    theoretical: `add_quad` splits (a, b, c, d) into (a, b, c) and (a, c, d),
    and on a self-crossing quad those two wind opposite ways. The mitred inner
    edge of a parapet capping produces exactly that at a spike corner -- the
    bisector offset carries one inner vertex past its neighbour and the quad
    ties itself in a bow -- and testing the first triangle alone left 44 of the
    inner ring's `render_painted` triangles inside out, at 60 cm2 each. Rare
    and small, and neither is a reason for an emitter that claims to enforce
    something to enforce it on half its output.

    So: reverse if the pair as a whole faces the wrong way, and then, if the two
    halves still disagree with each other, give up on the quad and emit two
    triangles that are each individually right. The split costs two vertices and
    happens on a few dozen faces in the build.
    """
    a, b, c, d = pts
    if _turn(a, b, c, normal) + _turn(a, c, d, normal) < 0.0:
        b, d = d, b
        uvs = (uvs[0], uvs[3], uvs[2], uvs[1])
    if _turn(a, b, c, normal) < 0.0 or _turn(a, c, d, normal) < 0.0:
        _add_tri(buf, (a, b, c), (uvs[0], uvs[1], uvs[2]), normal, bidx)
        _add_tri(buf, (a, c, d), (uvs[0], uvs[2], uvs[3]), normal, bidx)
        return
    buf.add_quad(a, b, c, d, normal, uvs, bidx)


def _add_tri(buf: MeshBuffers, pts, uvs, normal, bidx: int) -> None:
    """One triangle, on the same terms as `_add_face`."""
    a, b, c = pts
    turn = np.cross(np.subtract(b, a), np.subtract(c, a))
    if float(np.dot(turn, normal)) < 0.0:
        # The UVs follow the points they belong to. Swapping the first and third
        # vertices swaps the first and third UVs -- it used to rotate the last
        # two instead, which is a different permutation and gave all three
        # vertices somebody else's coordinate. It was invisible while the only
        # caller was `_ridge_prism`, whose end triangle carries two identical
        # UVs on a 120 mm face; it is not invisible on a hip end, whose UVs are
        # world metres and carry the tile courses.
        a, c = c, a
        uvs = (uvs[2], uvs[1], uvs[0])
    buf.add_surface(
        np.asarray([a, b, c], dtype=np.float64),
        np.asarray([normal, normal, normal], dtype=np.float64),
        np.asarray(uvs, dtype=np.float64),
        np.asarray([[0, 1, 2]]),
        bidx,
    )


def _down_normal(a, b, c) -> tuple[float, float, float]:
    """`_plane_normal` turned over, for a soffit -- the one surface here that
    faces the ground."""
    n = _plane_normal(a, b, c)
    return (-n[0], -n[1], -n[2])


def _ccw_ring(ring: np.ndarray) -> np.ndarray:
    """The ring wound counter-clockwise in ENU, so "outward" is well defined.

    A no-op on any ring that came off a `Building`, and kept for exactly two
    reasons. It is the entry point for the rings that did *not* -- an oriented
    rectangle's corners, a shapely overlay result -- and it is the assertion that
    the callers below (`_parapet_cap`, `AwningNetwork.emit`) are relying on the
    invariant rather than on luck: reading `_ccw_ring` at a call site says which
    winding that code needs, where reading nothing says only that nobody thought
    about it.
    """
    return _oriented_ring(ring, True)


def _dedupe_ring(ring: np.ndarray, tol: float = 0.05) -> np.ndarray:
    """The ring with runs of near-coincident vertices collapsed to one.

    `build_walls` gets away with skipping short segments one at a time because a
    wall quad only needs its own two ends. The capping band cannot: its inner
    edge is mitred off the *adjacent* edges' directions, and the direction of a
    40 mm edge is noise. Real footprints carry these -- the first inner-ring
    terrace slice inspected repeated its opening vertex twice.
    """
    r = np.asarray(ring, dtype=np.float64)
    if len(r) < 3:
        return r
    keep = [r[0]]
    for p in r[1:]:
        if math.hypot(*(p - keep[-1])) >= tol:
            keep.append(p)
    while len(keep) > 3 and math.hypot(*(keep[-1] - keep[0])) < tol:
        keep.pop()
    return np.asarray(keep)


def _canonical_axis(axis: np.ndarray) -> np.ndarray:
    """`axis` with its sign fixed by direction rather than by corner order.

    `_oriented_rect` inherits the sign of both axes from whichever corner shapely
    happened to start the rectangle at, which is stable for one footprint but
    arbitrary between two. That is invisible everywhere else and fatal here: the
    chimneys of a terrace row are placed from this frame, every slice of a row
    shares the row's orientation, and a sign that flips between slices would put
    the chimneys alternately at the front and the back of the houses instead of
    in the line down the party walls that is the whole point of them.

    Pointing it into the northern half-plane -- eastern, on an exactly east-west
    axis -- is a total order on directions and costs one comparison.
    """
    if axis[1] < -1e-9 or (abs(axis[1]) <= 1e-9 and axis[0] < 0.0):
        return -axis
    return axis


# Named streams for `_roll`. Every randomised decision about roofline trim draws
# from its own, so that changing how often a chimney is doubled cannot also move
# every chimney on the roof.
_S_CHIMNEY_PRESENT = 1
_S_CHIMNEY_COUNT = 2
_S_CHIMNEY_ALONG = 3
_S_CHIMNEY_RISE = 4
_S_CHIMNEY_BRICK = 5
_S_CHIMNEY_MATCH = 6


def _roll(building_id: str, stream: int) -> float:
    """A stable 0-1 draw for one building on one named stream.

    CRC-32 over the whole id and then the splitmix32 finaliser, which is the
    construction `attributes._stable_seed` and `attributes._uniform` use together
    and is duplicated here rather than reached into, because those are private to
    a module this one only imports the public surface of.

    The finaliser is not optional and this is the second time the project has had
    to learn it. A CRC is linear over GF(2), so over ids that differ by a
    character -- which is exactly what a terrace row is, `o409035064#0` through
    `o409035064#23` -- a bare threshold against the raw register produces
    structure rather than noise. It shows up as *regularity*, which is the
    failure that matters here: across the 364 real inner-ring rows of six or more
    houses, the raw CRC put its chimneys in a comb with a longest run of 2.98
    houses on average and 6 at worst, where an independent 70% draw over rows
    that length gives 4.00 and 12. A row of chimneys with a gap every third house
    is a fence, not a roofline. Through splitmix the share comes out at 0.696
    over 4,184 slices and the runs come out at the Bernoulli figures.

    Deliberately not a function of `facade_seed`. That number goes to the shader
    and drives the per-building value tint and paint colour; a chimney drawn from
    it would correlate "has a chimney" with "is a pale house", which is the kind
    of pattern that is invisible until it is pointed out and then cannot be
    unseen.
    """
    x = (zlib.crc32(building_id.encode("utf-8")) ^ (stream * 0x9E3779B1)) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x7FEB352D) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x846CA68B) & 0xFFFFFFFF
    x ^= x >> 16
    return x / 4_294_967_296.0


def _eave_trim(
    slots: dict[str, MeshBuffers],
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    edges,
    overhang: float,
) -> None:
    """Fascia, barge boards and soffit around an oversailing roof.

    `edges` are `(p0, y0, p1, y1, outward, soffit)` in ENU, walked in any order:
    the fascia hangs `FASCIA_DEPTH` under the roof edge on the outward side, and
    where `soffit` is set the underside of the overhang is closed by a flat quad
    running back to the wall line. A raked edge -- a gable's verge -- passes
    `soffit=False`; the barge board is the closure there.

    Sixteen triangles a house, on every pitched form: four fascia quads and four
    soffits on a hip or a skillion, two of each plus four barge boards on a
    gable.
    """
    buf = slots[FASCIA_MATERIAL]
    oe, on = origin
    v_lo = b.height + TRIM_V_CLEARANCE
    v_hi = v_lo + FASCIA_DEPTH
    u = 0.0

    def world(p2, y):
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    for p0, y0, p1, y1, outward, soffit in edges:
        run = float(np.hypot(*(np.asarray(p1) - np.asarray(p0))))
        if run < 0.05:
            continue
        u1 = u + run
        top0, top1 = world(p0, y0), world(p1, y1)
        bot0, bot1 = world(p0, y0 - FASCIA_DEPTH), world(p1, y1 - FASCIA_DEPTH)
        _add_face(
            buf,
            (bot0, bot1, top1, top0),
            ((u, v_lo), (u1, v_lo), (u1, v_hi), (u, v_hi)),
            _enu_dir(outward),
            bidx,
        )
        if soffit:
            # Back to the wall line, at the fascia's own bottom -- which is below
            # the wall head by the fascia depth plus the eave's drop, so the
            # inner edge is buried in the wall rather than meeting it exactly.
            # That is what a boxed eave does, and it is the only version of this
            # that cannot leave a slot of sky at the junction.
            q0 = np.asarray(p0) - np.asarray(outward) * overhang
            q1 = np.asarray(p1) - np.asarray(outward) * overhang
            in0, in1 = world(q0, y0 - FASCIA_DEPTH), world(q1, y1 - FASCIA_DEPTH)
            _add_face(
                buf,
                (bot0, bot1, in1, in0),
                ((u, v_lo), (u1, v_lo), (u1, v_lo + overhang), (u, v_lo + overhang)),
                _down_normal(bot0, bot1, in1),
                bidx,
            )
        u = u1


def _ridge_prism(
    buf: MeshBuffers,
    bidx: int,
    origin: tuple[float, float],
    p0, y0, p1, y1,
    perp: np.ndarray,
    drop: float,
    uv0: tuple[float, float],
    uv1: tuple[float, float],
    closed: bool,
) -> None:
    """A capping roll along one ridge or hip line: a thin triangular prism.

    Six triangles closed, four open. The base corners are dropped by `drop` so
    they sit *inside* the planes the cap straddles -- over-sinking a cap is
    invisible and under-sinking it leaves a hairline of sky along the one edge
    of the roof the eye goes to first.

    `uv0`/`uv1` are the roof's own (u, v) at the two apex ends, so the cap
    continues the sheet columns and tile courses of the planes either side rather
    than starting a pattern of its own.
    """
    oe, on = origin

    def world(p2, y):
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    half = RIDGE_CAP_HALF
    v_drop = RIDGE_CAP_HALF + RIDGE_CAP_PROUD
    a_apex = world(p0, y0 + RIDGE_CAP_PROUD)
    b_apex = world(p1, y1 + RIDGE_CAP_PROUD)
    uv_a, uv_b = uv0, uv1
    uv_a_base = (uv0[0], uv0[1] - v_drop)
    uv_b_base = (uv1[0], uv1[1] - v_drop)

    for sign in (-1.0, 1.0):
        a_base = world(np.asarray(p0) + perp * (half * sign), y0 - drop)
        b_base = world(np.asarray(p1) + perp * (half * sign), y1 - drop)
        _add_face(
            buf,
            (a_base, b_base, b_apex, a_apex),
            (uv_a_base, uv_b_base, uv_b, uv_a),
            _plane_normal(a_base, b_base, b_apex),
            bidx,
        )

    if not closed:
        return
    # The two ends. Their normals run along the ridge, so `_plane_normal` -- which
    # forces the y component non-negative -- cannot pick the side for them.
    line = np.asarray(p1, dtype=np.float64) - np.asarray(p0, dtype=np.float64)
    length = float(np.hypot(*line))
    if length < 1e-6:
        return
    line = line / length
    for p, y, uv, uv_base, facing in (
        (p0, y0, uv_a, uv_a_base, -line),
        (p1, y1, uv_b, uv_b_base, line),
    ):
        left = world(np.asarray(p) - perp * half, y - drop)
        right = world(np.asarray(p) + perp * half, y - drop)
        top = world(p, y + RIDGE_CAP_PROUD)
        _add_tri(buf, (left, right, top), (uv_base, uv_base, uv), _enu_dir(facing), bidx)


def _ridge_caps(
    buf: MeshBuffers,
    bidx: int,
    origin: tuple[float, float],
    form: str,
    centre: np.ndarray,
    axis_long: np.ndarray,
    axis_short: np.ndarray,
    hl: float,
    hs: float,
    ridge0: np.ndarray,
    ridge1: np.ndarray,
    apex: float,
    base: float,
    fall: float,
    cover=None,
) -> None:
    """The ridge, and on a hip the four hip lines as well.

    Six triangles for the ridge; four more for each hip line, left open at both
    ends because a hip line terminates against the ridge cap at the top and dies
    into the gutter at the bottom, and neither end is ever seen. Twenty-two
    triangles for a hip roof, six for a gable -- inside the thirty the budget
    allowed for the pair, which is what decided the hip lines were worth having.
    They are the diagonals that make a hip roof read as a hip roof, and a
    terracotta roll along them is the single most recognisable thing on a
    Federation roofscape.

    `cover` is the clipped roof's plan, or None where the roof was not clipped.
    A capping is a stick sitting on a surface, so where the surface stopped the
    stick has to as well -- an unclipped ridge over a clipped roof is a 40 m
    terracotta roll standing in mid-air, which is the artefact this pass exists
    to remove rather than a smaller version of it.
    """
    drop = RIDGE_CAP_HALF * max(fall, 0.35)

    def run_cap(p0, y0, p1, y1, perp, uv0, uv1, closed) -> None:
        """One capping run, split into whatever parts of it the roof still has."""
        p0 = np.asarray(p0, dtype=np.float64)
        p1 = np.asarray(p1, dtype=np.float64)
        spans = [(0.0, 1.0)] if cover is None else _clip_line(cover, p0, p1)
        for t0, t1 in spans:
            q0 = p0 + (p1 - p0) * t0
            q1 = p0 + (p1 - p0) * t1
            _ridge_prism(
                buf, bidx, origin,
                q0, y0 + (y1 - y0) * t0, q1, y0 + (y1 - y0) * t1,
                perp, drop,
                (uv0[0] + (uv1[0] - uv0[0]) * t0, uv0[1] + (uv1[1] - uv0[1]) * t0),
                (uv0[0] + (uv1[0] - uv0[0]) * t1, uv0[1] + (uv1[1] - uv0[1]) * t1),
                closed=closed and t0 <= 0.0 and t1 >= 1.0,
            )

    # `u` on the slopes runs 0 .. 2*hl along the long axis, so a point at long
    # offset s is at u = s + hl. The ridge sits at v = hs by construction.
    ridge_half = float(np.hypot(*(ridge1 - ridge0))) * 0.5
    run_cap(
        ridge0, apex, ridge1, apex, axis_short,
        (hl - ridge_half, hs), (hl + ridge_half, hs), True,
    )

    if form != "hip":
        return

    for corner_sign_long, corner_sign_short, ridge in (
        (-1.0, -1.0, ridge0), (-1.0, 1.0, ridge0),
        (1.0, -1.0, ridge1), (1.0, 1.0, ridge1),
    ):
        corner = centre + axis_long * (hl * corner_sign_long) + axis_short * (hs * corner_sign_short)
        line = np.asarray(ridge, dtype=np.float64) - corner
        run = float(np.hypot(*line))
        if run < 0.5:
            continue
        perp = np.array([-line[1], line[0]]) / run
        # u along the hip line from the eave, v the roof's own -- 0 at the eave
        # and hs at the ridge, so the eave-keyed effects in `finishRoof` find the
        # bottom of a hip cap exactly where they find the bottom of the plane.
        run_cap(corner, base, ridge, apex, perp, (0.0, 0.0), (run, hs), False)


def _parapet_cap(
    slots: dict[str, MeshBuffers],
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    base_y: float,
) -> None:
    """The capping band along the top of a parapet, following the footprint ring.

    Two quads a segment: an outer face standing `PARAPET_CAP_HEIGHT` above the
    wall head, and a top that falls `PARAPET_CAP_WIDTH` inward to land exactly on
    the roof deck. Flush with the wall rather than oversailing it -- the deck is
    already at the wall head, so the capping is the only thing standing above it
    and it does not need to project to be read.

    The inner edge is MITRED, at the cost of about ten lines. Offsetting each
    segment on its own normal is the obvious version and it is wrong at every
    corner: on a right-angled one the inner end of a segment's top face lands
    exactly on the *next* wall, so two neighbouring segments' inner edges never
    meet and each convex corner of every parapet in the city loses a
    0.25 x 0.25 m square of capping while each concave one grows an overlapping
    fold. Measured on a real terrace slice before the mitre went in: 10 of 16
    inner vertices sat on the footprint line rather than 0.25 m inside it.
    Offsetting each *vertex* along its angle bisector instead makes the two
    meet exactly, and costs one dot product a corner.

    Material by archetype, not by wall: painted render on the brick and rendered
    stock, precast on the concrete archetypes, which is what `ROOF_MATERIAL`
    already says about the same three classes.
    """
    concrete = ROOF_MATERIAL.get(b.archetype) == "concrete_precast" or b.material == "concrete_precast"
    buf = slots["concrete_precast" if concrete else "render_painted"]
    ring = _dedupe_ring(_ccw_ring(_ring_open(b.ring)))
    n = len(ring)
    if n < 3:
        return
    oe, on = origin
    top = base_y + b.height
    v_lo = b.height + TRIM_V_CLEARANCE
    v_hi = v_lo + PARAPET_CAP_HEIGHT

    def world(p2, y):
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    # Per edge: length, and the outward normal, which on a counter-clockwise ring
    # is the right of travel.
    delta = np.roll(ring, -1, axis=0) - ring
    length = np.hypot(delta[:, 0], delta[:, 1])
    # `_dedupe_ring` cannot collapse below three vertices, so a triangle whose
    # last vertex sits on its first survives it and would divide by zero here.
    if float(length.min()) < 1e-6:
        return
    outward = np.column_stack((delta[:, 1], -delta[:, 0])) / length[:, None]

    # Per vertex: the bisector offset of the inner edge. `prev` is the edge
    # arriving at this vertex, `here` the one leaving it.
    prev, here = -np.roll(outward, 1, axis=0), -outward
    denom = 1.0 + (prev * here).sum(axis=1)
    # A near-reversal makes the bisector shoot off to infinity; there is no mitre
    # to be had on a spike, so fall back to the plain offset and let that corner
    # keep the notch it would have had anyway.
    spike = denom < 0.2
    mitre = np.where(spike[:, None], here, (prev + here) / np.where(spike, 1.0, denom)[:, None])
    inner = ring + mitre * PARAPET_CAP_WIDTH

    u = 0.0
    for i in range(n):
        j = (i + 1) % n
        u1 = u + float(length[i])
        lo0, lo1 = world(ring[i], top), world(ring[j], top)
        hi0, hi1 = world(ring[i], top + PARAPET_CAP_HEIGHT), world(ring[j], top + PARAPET_CAP_HEIGHT)
        in0, in1 = world(inner[i], top), world(inner[j], top)
        _add_face(
            buf,
            (lo0, lo1, hi1, hi0),
            ((u, v_lo), (u1, v_lo), (u1, v_hi), (u, v_hi)),
            _enu_dir(outward[i]),
            bidx,
        )
        _add_face(
            buf,
            (hi0, hi1, in1, in0),
            ((u, v_hi), (u1, v_hi), (u1, v_lo), (u, v_lo)),
            _plane_normal(hi0, hi1, in1),
            bidx,
        )
        u = u1


def _chimneys(
    slots: dict[str, MeshBuffers],
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    base_y: float,
    rect,
    ridge,
    foot=None,
) -> None:
    """One or two brick chimneys, placed in the oriented rectangle's frame.

    Placement is the whole of it. On a pitched roof they straddle the ridge at a
    quarter to two fifths along, which is where a chimney serving the rooms
    behind the front two actually comes out. On a parapet form they stand against
    a party wall in the rear half of the footprint, and on a terrace ROW SLICE
    there is at most one, on a canonically-chosen side -- so the slices of one
    row put theirs in a line down the party walls at four or five metre centres,
    which is the roofline a Sydney terrace street has and the reason chimneys are
    in this pass at all.

    Eighteen triangles each: four for the shaft, four for the corbelled cap and
    one for its top.

    `foot` is the footprint polygon, passed only where the roof was clipped to
    it. The placement above is in the RECTANGLE's frame, so on a plan that does
    not fill its rectangle a chimney can be sited over open ground -- a brick
    box standing in mid-air beside the house, which is the same defect as the
    roof slab and looks worse for being small and obviously solid. Where `foot`
    is given, a chimney outside it is dropped rather than moved: the placement
    rule is about where a flue comes out relative to the plan's length, and a
    chimney shoved to the nearest point that happens to be inside is not that
    rule's answer to anything.
    """
    share = CHIMNEY_SHARE.get(b.archetype)
    if share is None or b.height > TRIM_MAX_HEIGHT:
        return
    if b.row_slice:
        # One per house and gaps in the run: see CHIMNEY_ROW_SHARE.
        if _roll(b.id, _S_CHIMNEY_PRESENT) > share * CHIMNEY_ROW_SHARE:
            return
        count = 1
    else:
        if _roll(b.id, _S_CHIMNEY_PRESENT) > share:
            return
        count = 2 if _roll(b.id, _S_CHIMNEY_COUNT) < 0.30 else 1

    if rect is None:
        rect = _oriented_rect(_ring_open(b.ring))
        if rect is None:
            return
    centre, axis_long, axis_short, half_long, half_short = rect
    axis_long = _canonical_axis(axis_long)
    axis_short = _canonical_axis(axis_short)

    material = _chimney_material(b)
    # 0.9 to 1.4 m, drawn once per building rather than once per chimney: two
    # flues off one house came out of one bricklayer's day and they match.
    rise = CHIMNEY_RISE[0] + _roll(b.id, _S_CHIMNEY_RISE) * (CHIMNEY_RISE[1] - CHIMNEY_RISE[0])
    # How far along the footprint the chimney stands, a quarter to two fifths.
    #
    # A row slice draws this from its PARENT's id -- everything before the `#` --
    # so every house in one row puts its chimney at the same depth. That is the
    # difference between a line of chimneys down a terrace street and a line that
    # wanders half a metre back and forth, and the wander is the tell that they
    # were placed by a machine. The heights still vary per house, which is what a
    # real row does.
    along_id = b.id.split(ROW_SLICE_SEP)[0] if b.row_slice else b.id
    frac = 0.25 + _roll(along_id, _S_CHIMNEY_ALONG) * 0.15

    def standing(pos: np.ndarray) -> bool:
        return foot is None or foot.contains(Point(float(pos[0]), float(pos[1])))

    if ridge is not None:
        ridge0, ridge1, apex = ridge
        start, end = (ridge0, ridge1) if float(np.dot(ridge1 - ridge0, axis_long)) > 0 else (ridge1, ridge0)
        span = np.asarray(end, dtype=np.float64) - np.asarray(start, dtype=np.float64)
        for k in range(count):
            f = frac if k == 0 else 1.0 - frac
            pos = np.asarray(start, dtype=np.float64) + span * f
            if not standing(pos):
                continue
            _chimney_box(slots, material, b, bidx, origin, pos, axis_long, axis_short, apex, rise)
        return

    # Flat or parapet: against a party wall, in the rear half. Clear of the
    # capping band as well as of the wall, or the two would interpenetrate on
    # every terrace in the row.
    inset = max(half_short - (CHIMNEY_ACROSS * 0.5 + PARAPET_CAP_WIDTH + 0.10), 0.0)
    deck = base_y + b.height
    for k in range(count):
        side = 1.0 if k == 0 else -1.0
        pos = centre + axis_long * (frac * half_long) + axis_short * (side * inset)
        if not standing(pos):
            continue
        _chimney_box(slots, material, b, bidx, origin, pos, axis_long, axis_short, deck, rise)


def _chimney_material(b: Building) -> str:
    """Which brick. Two thirds of the time the wall's own, where the wall is
    brick at all; the rest is the other one, because a chimney rebuilt once in
    eighty years is a different batch and a contrast is commoner than a match."""
    if b.material in CHIMNEY_BRICKS and _roll(b.id, _S_CHIMNEY_MATCH) < 0.65:
        return b.material
    return CHIMNEY_BRICKS[0] if _roll(b.id, _S_CHIMNEY_BRICK) < 0.62 else CHIMNEY_BRICKS[1]


def _chimney_box(
    slots: dict[str, MeshBuffers],
    material: str,
    b: Building,
    bidx: int,
    origin: tuple[float, float],
    pos: np.ndarray,
    along: np.ndarray,
    across: np.ndarray,
    roof_y: float,
    rise: float,
) -> None:
    """One shaft plus its corbelled cap, sunk into the roof it stands on."""
    buf = slots[material]
    oe, on = origin
    ha, hc = CHIMNEY_ALONG * 0.5, CHIMNEY_ACROSS * 0.5
    y0 = roof_y - CHIMNEY_SINK
    y1 = roof_y + rise
    y2 = y1 + CHIMNEY_CAP_HEIGHT

    def world(p2, y):
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    def corners(a: float, c: float) -> list[np.ndarray]:
        return [
            pos - along * a - across * c,
            pos + along * a - across * c,
            pos + along * a + across * c,
            pos - along * a + across * c,
        ]

    shaft = corners(ha, hc)
    lip = corners(ha + CHIMNEY_CAP_CORBEL, hc + CHIMNEY_CAP_CORBEL)
    # Which way each face looks, independent of the frame's handedness.
    outward = (-across, along, across, -along)

    # `v` starts just above the wall head -- see TRIM_V_CLEARANCE -- and then
    # advances in real metres, so the 86 mm brick courses the facade shader draws
    # come out at 86 mm on the chimney.
    v0 = b.height + TRIM_V_CLEARANCE
    v1 = v0 + (y1 - y0)
    v2 = v1 + CHIMNEY_CAP_HEIGHT
    u = 0.0
    for k in range(4):
        p0, p1 = shaft[k], shaft[(k + 1) % 4]
        t0, t1 = lip[k], lip[(k + 1) % 4]
        run = float(np.hypot(*(p1 - p0)))
        u1 = u + run
        _add_face(
            buf,
            (world(p0, y0), world(p1, y0), world(p1, y1), world(p0, y1)),
            ((u, v0), (u1, v0), (u1, v1), (u, v1)),
            _enu_dir(outward[k]),
            bidx,
        )
        # The cap flares outward, so its faces lean and `_plane_normal` picks the
        # right one for them -- an outward-leaning face has a normal with a
        # positive y component and that is the only one it can be.
        face = (world(p0, y1), world(p1, y1), world(t1, y2), world(t0, y2))
        _add_face(
            buf, face, ((u, v1), (u1, v1), (u1, v2), (u, v2)),
            _plane_normal(*face[:3]), bidx,
        )
        u = u1
    _add_face(
        buf,
        (world(lip[0], y2), world(lip[1], y2), world(lip[2], y2), world(lip[3], y2)),
        ((0.0, v2), (CHIMNEY_ALONG, v2), (CHIMNEY_ALONG, v2 + CHIMNEY_ACROSS), (0.0, v2 + CHIMNEY_ACROSS)),
        (0.0, 1.0, 0.0),
        bidx,
    )


# --- Footpath awnings ---------------------------------------------------------


def _street_ahead(
    streets: StreetNetwork,
    mid: np.ndarray,
    outward: np.ndarray,
    max_kerb: float,
    exclude: frozenset[str],
) -> float | None:
    """Metres from this wall to the nearest kerb face in front of it, or None.

    The answer two of the three callers want. `_street_ahead_way` below is the
    implementation and the third caller's entry point; this is the same result
    with the way index dropped.
    """
    hit = _street_ahead_way(streets, mid, outward, max_kerb, exclude)
    return None if hit is None else hit[0]


def _street_ahead_way(
    streets: StreetNetwork,
    mid: np.ndarray,
    outward: np.ndarray,
    max_kerb: float,
    exclude: frozenset[str],
) -> tuple[float, int] | None:
    """`(metres to the nearest kerb face IN FRONT of this wall, which way)`, or None.

    "Does this edge front a street" -- the question three features now ask and
    only the street network can answer. Shared rather than copied because the
    second of the two tests below is subtle, it is the one that carries the whole
    result, and a second copy of it would drift.

    The way index is returned because the third caller needs more from the answer
    than a distance. `fences.py` stands its fence at the *property line*, which is
    the far side of the footpath, and how wide that footpath is depends on the
    class of the way this found -- a laneway's 1.5 m against a street's 3.0. That
    is `streets.footpath_width(i)`, and there is no way to ask it without knowing
    which `i` won.

    Two tests, and the second is the one that does the work. The first is just
    proximity: `centreline.distance - half_width` is the gap between the wall and
    the edge of the carriageway, which is the footpath an awning covers and the
    setback a front path crosses.

    The second is *facing*, and without it a mid-row terrace grows an awning --
    and a front door -- on its party walls. The street in front of a 12 m deep
    terrace is closer to the middle of its side wall than 9 m is, so proximity
    alone passes every internal wall in the row; what separates them is that the
    road lies at 90 degrees to a party wall's outward normal and dead ahead of
    the front wall's. `AWNING_FACING_MIN` is a 50 degree cone, which is wide
    enough for a corner splay taking its awning off the cross street at 45 and
    far too narrow for anything perpendicular. The doors take the same cone: a
    front door and an awning are answering the same question about the same
    wall, and a building with an awning on one edge and its door on another
    would be a shop you enter round the side.
    """
    probe = Point(float(mid[0]), float(mid[1]))
    best: tuple[float, int] | None = None
    for i in streets.ways_near(probe.buffer(max_kerb + STREET_PROBE_MARGIN)):
        road = streets.roads[i]
        # A footway is not a carriageway, and a class the street module gives no
        # paved band -- every motorway and every link -- has no footpath in front
        # of it and no address on it. Asked of the network rather than restated
        # here: `streets.py` owns that table and this module cannot import it.
        if road.is_foot or streets.footpath_width(i) <= 0.0:
            continue
        if road.highway in exclude:
            continue
        line = streets.centreline(i)
        gap = float(line.distance(probe))
        kerb = gap - streets.half_width(i)
        if kerb >= max_kerb:
            continue
        if gap < 1e-6:
            continue
        # The foot of the perpendicular from this wall to the centreline --
        # `nearest_points` without the import.
        foot = line.interpolate(line.project(probe))
        to_road = np.array([foot.x - mid[0], foot.y - mid[1]])
        if float(np.dot(to_road, outward)) < AWNING_FACING_MIN * gap:
            continue
        if best is None or kerb < best[0]:
            best = (kerb, i)
    return best


class AwningNetwork:
    """Which wall edges front a street, and the awning that hangs off them.

    Threaded from `cli.cmd_build` through `tiles.build_tile` exactly the way the
    street, vegetation, parking and power networks are, and for the same reason
    they are: "does this edge face a carriageway" is a question only the street
    network can answer, and the alternative -- re-reading the OSM extract once
    per building -- is 33,844 reads of a 130 MB file.

    Holds the tally as it goes. Awnings are the kind of feature where the
    interesting number is not how many were emitted but how many candidates each
    guard removed, because every guard here is protecting against a canopy in a
    place a canopy cannot be, and a guard that never fires is a guard that is
    wrong.
    """

    def __init__(self, street_network: StreetNetwork) -> None:
        self._streets = street_network
        self.stats: Counter[str] = Counter()

    def emit(
        self,
        slots: dict[str, MeshBuffers],
        b: Building,
        bidx: int,
        origin: tuple[float, float],
        base_y: float,
    ) -> None:
        """Hang an awning on every street-facing edge of one building.

        MATERIALS, and this is the decision the pass turns on.

        The **top** goes on `roof_steel`, not on the `corrugated_steel` wall
        slot it was specified against, because the corrugation everyone means
        when they say "a painted steel awning roof" is not in that slot. Ribs,
        762 mm per-sheet value variation, fixing rows, zinc dulling and the
        gutter line all live in `facade.finishSteelRoof`, which serves
        `roof_steel` alone; `corrugated_steel` is a *wall* pipeline whose only
        cladding-specific term is the rust runs. An awning roof is a flat sheet
        roof over a footpath, so it takes the roof shader, and it takes it with
        the UVs that make the shader's own geometry land correctly -- see
        `_awning_run` for why v is measured from the outer edge inward.

        The **soffit** goes on the new `awning_fascia` slot rather than on
        `render_painted`, and that is the other half of the same investigation.
        The wall pipelines key everything off `v` as height above the pad, so a
        soffit has two ways to go and both are bad:

          * wall-metric UVs put the soffit at v = 3.2 on a retail building whose
            ground storey is 4.2 m tall, which is INSIDE the shopfront opening
            (sill 0.35, head 3.45). It would grow plate glass on the underside
            of every awning in Sydney.
          * world-XZ UVs put v at tile-local Z, which is negative, so the window
            field never opens -- this is the trick the flat roof caps already
            use and `facade.flatRoofNode` documents. But the plinth curve, the
            contact toe and the soiling gradient all bottom out down there and
            multiply to 0.503, so the soffit would arrive at half the albedo of
            the wall beside it for no reason anyone chose, plus a 300 mm stripe
            wherever local Z crossed a course line. `concrete_precast` is no
            better: its normal gate is `smoothstep(0.55, 0.80, normalWorld.y)`
            and a soffit's normal is (0, -1, 0), so it fails the gate and falls
            straight through to the same wall path in grey.

        The new slot is being compiled for the fascia regardless, and inside it
        a soffit and a fascia are told apart by their normals exactly, so the
        soffit costs nothing extra and gets a tone somebody picked.
        """
        if not b.retail or b.archetype not in AWNING_ARCHETYPES:
            return
        self.stats["candidates"] += 1
        if b.height < AWNING_MIN_BUILDING_HEIGHT:
            self.stats["drop_low_building"] += 1
            return

        # Counter-clockwise so "outward" is the right of travel, which
        # `Building`'s invariant already guarantees -- the call is kept because
        # it says at the call site which winding the loop below depends on --
        # and deduped because a 40 mm edge has no meaningful direction to test a
        # street against. Same two calls, same reasons, as `_parapet_cap`.
        ring = _dedupe_ring(_ccw_ring(_ring_open(b.ring)))
        n = len(ring)
        if n < 3:
            return

        # A short building wears its awning as a hat otherwise. 0.75 of the
        # height keeps a strip of wall above the fascia at every size, and the
        # two branches meet within 2 cm at the threshold so nothing pops.
        soffit = AWNING_HEIGHT if b.height >= AWNING_SHORT_BUILDING else b.height * 0.75

        u = 0.0
        runs = 0
        for i in range(n):
            p0, p1 = ring[i], ring[(i + 1) % n]
            d = p1 - p0
            run = float(np.hypot(d[0], d[1]))
            if run < 1e-6:
                continue
            if run < AWNING_MIN_EDGE:
                self.stats["drop_short_edge"] += 1
                continue
            self.stats["edges"] += 1
            outward = np.array([d[1], -d[0]]) / run
            kerb = self._kerb_distance((p0 + p1) * 0.5, outward)
            if kerb is None:
                self.stats["drop_no_street"] += 1
                continue
            projection = (
                AWNING_PROJECTION if kerb >= AWNING_TIGHT_KERB else AWNING_PROJECTION_TIGHT
            )
            if self._blocked(p0, p1, outward, projection):
                self.stats["drop_neighbour"] += 1
                continue
            # Counted after the neighbour test, not before it: a run that never
            # gets emitted is not a run that got pulled back.
            if projection < AWNING_PROJECTION:
                self.stats["pulled_back"] += 1
            _awning_run(
                slots, bidx, origin, p0, p1, outward, run, u, base_y + soffit, projection
            )
            # `u` advances only over edges that were actually emitted, so two
            # runs meeting at a corner continue one sheet rhythm instead of
            # restarting it -- and a rejected edge in between does not leave a
            # gap in the count that would shift every sheet after it.
            u += run
            runs += 1

        self.stats["runs"] += runs
        self.stats["metres"] += round(u)
        if runs:
            self.stats["buildings"] += 1

    def _kerb_distance(self, mid: np.ndarray, outward: np.ndarray) -> float | None:
        """Metres from this wall to the nearest kerb face in front of it, or None.

        The test itself is `_street_ahead` below, which the front doors share.
        What is awning-specific is only the qualifying distance: an awning is a
        canopy over a footpath, so it stops being one the moment the building is
        set back off it, which is what `AWNING_MAX_KERB` is.
        """
        return _street_ahead(
            self._streets, mid, outward, AWNING_MAX_KERB, AWNING_EXCLUDE_CLASSES
        )

    def _blocked(
        self, p0: np.ndarray, p1: np.ndarray, outward: np.ndarray, projection: float
    ) -> bool:
        """Would this canopy run into a building?

        The probe is held `AWNING_PROBE_INSET` off the wall, and that one offset
        is the whole of the self-exclusion: the building's own footprint is
        behind the wall line, so a rectangle starting 150 mm in front of it
        cannot report itself. What the offset deliberately does NOT exclude is
        the *other wing* of a re-entrant footprint -- an L-shaped shop whose
        canopy would run into its own return is blocked, which is correct and
        which an identity test would have got wrong.

        The neighbours this really fires on are across a lane: a 2.6 m canopy on
        a 3 m service lane reaches within 400 mm of the building opposite, and
        two of them reach past each other.
        """
        probe = Polygon(
            [
                p0 + outward * AWNING_PROBE_INSET,
                p1 + outward * AWNING_PROBE_INSET,
                p1 + outward * projection,
                p0 + outward * projection,
            ]
        )
        if probe.is_empty or not probe.is_valid:
            return False
        return any(
            poly.intersection(probe).area > AWNING_BLOCK_AREA
            for poly in self._streets.buildings_near(probe)
        )


def _awning_run(
    slots: dict[str, MeshBuffers],
    bidx: int,
    origin: tuple[float, float],
    p0: np.ndarray,
    p1: np.ndarray,
    outward: np.ndarray,
    run: float,
    u0: float,
    soffit_y: float,
    projection: float,
) -> None:
    """One continuous awning over one wall edge: ten triangles, closed.

    A box open only at the wall: top, soffit, fascia, and a cap at each end. No
    lip return and no interior face, because `AWNING_SLAB` is both the slab's
    thickness and the fascia's depth -- one edge seen from the side.

    NO POSTS. A Sydney awning is cantilevered off the facade, usually on steel
    tie rods back up to the wall above; the rods are real and are skipped, at
    this budget, because two 30 mm rods per shop would cost more triangles than
    the entire awning.

    UVs, which are where the material decisions land:

      top      u along the run, v measured from the OUTER edge INWARD. That is
               backwards from every other surface here and it is deliberate:
               `facade.finishSteelRoof` puts its gutter line at v in [0.06,
               0.30] and its rain-wash gradient over v in [0.15, 2.6], both
               measured from the eave. An awning's eave is its outer edge and
               its 2.6 m projection is exactly that gradient's span, so writing
               v this way puts the shader's gutter under the fascia and its wash
               where the water actually runs. Sheets are 762 mm columns in u, so
               they run out from the wall to the fascia, which is how an awning
               is sheeted.

               One caveat, inherited rather than introduced: `finishRoof`
               separates roof planes from caps by testing whether uv equals
               local XZ, so a fragment where u happens to equal local x AND v
               happens to equal local z is misclassified. v is in [0, 2.6] and
               local z is in [-500, 0], so that needs an awning in the northmost
               2.6 m of a tile whose run also starts on the tile's west edge, and
               even then it is a 1 cm locus. The hip end triangles already live
               with the same coincidence.

      soffit   u along the run, v measured OUT from the wall. Never touches a
               wall pipeline, so it carries no height and cannot grow a window.
      fascia   u along the run, v from 0 at the bottom to AWNING_SLAB at the top
               -- a clean coordinate for the lettering band the client draws
               across it.
      caps     u out from the wall, v up the slab.
    """
    oe, on = origin
    top_y = soffit_y + AWNING_SLAB
    u1 = u0 + run
    q0 = p0 + outward * projection
    q1 = p1 + outward * projection

    def world(p2, y: float) -> tuple[float, float, float]:
        return (float(p2[0] - oe), float(y), float(-(p2[1] - on)))

    top = slots[AWNING_TOP_MATERIAL]
    fascia = slots[AWNING_SLOT]
    # The slot reads no parameter record -- its colour is a hash of world
    # position, per shop rather than per building -- so it carries no `_BLDIDX`.
    # Set before the first vertex lands in it, which is here by construction.
    fascia.building_indexed = False

    _add_face(
        top,
        (world(p0, top_y), world(p1, top_y), world(q1, top_y), world(q0, top_y)),
        ((u0, projection), (u1, projection), (u1, 0.0), (u0, 0.0)),
        (0.0, 1.0, 0.0),
        bidx,
    )
    _add_face(
        fascia,
        (world(p0, soffit_y), world(p1, soffit_y), world(q1, soffit_y), world(q0, soffit_y)),
        ((u0, 0.0), (u1, 0.0), (u1, projection), (u0, projection)),
        (0.0, -1.0, 0.0),
        bidx,
    )
    _add_face(
        fascia,
        (world(q0, soffit_y), world(q1, soffit_y), world(q1, top_y), world(q0, top_y)),
        ((u0, 0.0), (u1, 0.0), (u1, AWNING_SLAB), (u0, AWNING_SLAB)),
        _enu_dir(outward),
        bidx,
    )

    # The ends. Coincident with the neighbour's where two awnings butt, which is
    # a hidden face at 0.45 x 2.6 and the price of the runs being independent;
    # a real strip has a joint line there anyway.
    along = (p1 - p0) / run
    for p, q, facing in ((p0, q0, -along), (p1, q1, along)):
        _add_face(
            fascia,
            (world(p, soffit_y), world(q, soffit_y), world(q, top_y), world(p, top_y)),
            ((0.0, 0.0), (projection, 0.0), (projection, AWNING_SLAB), (0.0, AWNING_SLAB)),
            _enu_dir(facing),
            bidx,
        )


@dataclass(frozen=True)
class FrontEdge:
    """The wall a building is addressed on, and everything about it two features
    now need.

    `u0` and `seg` are in `_wall_runs`' own accumulation, which is the *only*
    definition of `u` in this project -- so a door placed at `u0 + t` and a fence
    gate aligned to that same `u` are talking about the same metre of the same
    wall by construction rather than by two walks agreeing.

    `way` is which street this edge is addressed on, and it is here because a
    distance is not enough for everything that asks. `fences.py` stands its fence
    at the far side of the footpath, and how wide that is depends on the class of
    the way -- so the answer has to name it.
    """

    u0: float
    seg: float
    p0: np.ndarray
    p1: np.ndarray
    #: Unit outward normal of the edge in ENU, sign already resolved against this
    #: footprint's winding. The one thing here nobody should re-derive: about a
    #: third of Sydney's rings arrive clockwise and getting it backwards points
    #: every fence and every door into the back garden.
    outward: np.ndarray
    #: Metres from the middle of the edge to the edge of the carriageway.
    kerb: float
    #: Index into `StreetNetwork.roads`.
    way: int


class DoorNetwork:
    """Where each building's front door stands, as a `u` along its own walls.

    Spec 6.3: "Openings. Front door placed on the street-facing edge, at the bay
    nearest the footprint centroid." Both halves of that sentence are load
    bearing and both are here: `_street_ahead` answers the first and the bay
    snap below answers the second.

    Not a network in the graph sense -- neither is `AwningNetwork` -- but built
    and threaded exactly like one, because it asks the street network the same
    question about the same walls and it wants the same per-guard tally. Every
    guard here removes a building from a feature that is otherwise universal, so
    the interesting number is not how many doors were placed but how many were
    withheld and by which rule.

    Emits NOTHING. The whole feature is one float in the parameter record; the
    door is drawn by the facade shader as a wall-plane feature, the same way the
    window joinery is. See `facade_params` texel 2 slot 3, and `doorNode` in
    `client/src/world/facade.ts`.
    """

    def __init__(self, street_network: StreetNetwork | None) -> None:
        self._streets = street_network
        self.stats: Counter[str] = Counter()

    def place(self, b: Building) -> float:
        """This building's door position, or `DOOR_NONE`."""
        self.stats["buildings"] += 1
        if b.archetype in DOOR_EXCLUDE_ARCHETYPES:
            self.stats["drop_archetype"] += 1
            return DOOR_NONE
        if b.material in DOOR_EXCLUDE_MATERIALS:
            self.stats["drop_curtain_wall"] += 1
            return DOOR_NONE
        if b.height < DOOR_MIN_HEIGHT:
            self.stats["drop_low_building"] += 1
            return DOOR_NONE

        runs = self._prepare(b)
        if runs is None:
            self.stats["drop_degenerate"] += 1
            return DOOR_NONE

        # A proper street first, and only then a lane -- see DOOR_EXCLUDE_CLASSES
        # for why one filtered pass is not enough and what the two tiers are
        # worth. The second pass only runs for a building that fronts no street
        # at all, which is 15% of them.
        best = self._facing_edge(runs, DOOR_EXCLUDE_CLASSES)
        if best is not None:
            self.stats["street_edge"] += 1
        else:
            best = self._facing_edge(runs, DOOR_LANE_CLASSES)
            if best is not None:
                self.stats["lane_edge"] += 1

        if best is not None:
            u0, seg, p0, p1 = best.u0, best.seg, best.p0, best.p1
        else:
            # Rear-lot: nothing this footprint presents faces a carriageway
            # inside 20 m. The longest edge is the fallback the spec's own
            # fall-through implies -- it is the elevation with the most wall to
            # put a door in -- and its failure mode is stated rather than hidden:
            # on a terrace slice the longest edge is a party wall, so a rear-lot
            # terrace gets its door on the wall it shares with next door. That is
            # wrong and it is rare (see the tally `cli._report_doors` prints);
            # fixing it properly needs a party-wall test, which is a neighbour
            # query per edge and its own pass.
            self.stats["fallback_longest"] += 1
            u0, seg, p0, p1 = max(runs, key=lambda r: r[1])

        # The centroid's projection onto that edge, clamped to it: the point on
        # the front wall the plan is centred behind, which is where a front door
        # goes on everything from a terrace to a shop.
        along = (p1 - p0) / seg
        c = np.asarray(b.centroid, dtype=np.float64)
        t = float(np.clip(np.dot(c - p0, along), 0.0, seg))
        u_proj = u0 + t

        # ...snapped to the bay it lands in. The shader divides `u` into bays as
        # `floor(u / bayWidth)` and centres its opening at `(bay + 0.5) *
        # bayWidth`, so a door at that same centre lands exactly on the window it
        # is replacing -- which is what lets one span suppress the other cleanly
        # instead of leaving slivers of glazing either side of the leaf.
        bay = ARCHETYPES[b.archetype].bay_width
        half = 0.5 * (DOOR_WIDTH_RETAIL if b.retail else DOOR_WIDTH) + DOOR_ARCHITRAVE
        if seg < 2.0 * half:
            self.stats["drop_short_edge"] += 1
            return DOOR_NONE
        # The bays whose centres leave the whole door on this edge. Indices
        # rather than distances, so the answer is still a bay centre after the
        # clamp -- clamping the position instead would slide the door off the
        # bay and put the slivers back.
        k_lo = math.ceil((u0 + half) / bay - 0.5 - 1e-9)
        k_hi = math.floor((u0 + seg - half) / bay - 0.5 + 1e-9)
        if k_lo > k_hi:
            # An edge wide enough for the door but with no bay centre inside it.
            # Centre the door on the edge; the window it overlaps is suppressed
            # by span rather than by bay, so what this costs is at worst a narrow
            # strip of glazing beside the architrave on one building.
            self.stats["off_bay"] += 1
            self.stats["doors"] += 1
            return u0 + seg * 0.5
        k = min(max(math.floor(u_proj / bay), k_lo), k_hi)
        self.stats["doors"] += 1
        if not k_lo <= math.floor(u_proj / bay) <= k_hi:
            self.stats["bay_clamped"] += 1
        return (k + 0.5) * bay

    def front_edge(self, b: Building) -> FrontEdge | None:
        """The street-facing wall of one building, for anything else that needs it.

        THE POINT OF THIS BEING PUBLIC is that a front fence's gate has to line
        up with the front door, and there is exactly one way to guarantee that:
        one object decides which wall the building is addressed on and both
        features take the answer. A second implementation of the rule below --
        nearest qualifying carriageway, longer edge breaks a tie -- would agree
        on almost every building and disagree on the corner blocks, which is
        where a gate opening onto the side street would be most obvious.

        The street tier only, with no lane fallback and no rear-lot longest-edge
        fallback. Those exist in `place` because a building has to have a door
        somewhere; nothing else that asks this question wants an answer that was
        invented for want of a street. See `fences.FENCE_EXCLUDE_CLASSES`.
        """
        runs = self._prepare(b)
        if runs is None:
            return None
        return self._facing_edge(runs, DOOR_EXCLUDE_CLASSES)

    def _prepare(
        self, b: Building
    ) -> list[tuple[float, float, np.ndarray, np.ndarray]] | None:
        """This footprint's wall runs, in `build_walls`' own order, or None.

        The ring is taken as it stands rather than re-oriented, and both halves
        of that matter. It must not be re-ordered, because `u` is accumulated
        along it and a door is a `u` -- reversing the ring renumbers every edge.
        And it does not need to be, because `Building`'s invariant already has it
        counter-clockwise, so the outward side of an edge is the right of travel
        on every footprint. This used to measure the winding per building and
        negate the normal on the clockwise ones; getting that backwards puts
        every door on a party wall, which is why it is now one invariant instead
        of one test per consumer.
        """
        ring = _ring_open(b.ring)
        if len(ring) < 3:
            return None
        runs = list(_wall_runs(ring))
        return runs or None

    def _facing_edge(
        self,
        runs: list[tuple[float, float, np.ndarray, np.ndarray]],
        exclude: frozenset[str],
    ) -> FrontEdge | None:
        """The wall edge this building is addressed on, or None.

        NEAREST QUALIFYING CARRIAGEWAY WINS, and a longer edge breaks a tie. Not
        the longest qualifying edge, which is the obvious alternative and is
        wrong on the archetype this feature exists for: a corner terrace's 12 m
        side wall qualifies off the cross street and its 5 m front wall off the
        street it is addressed on, so "longest" would put the door round the side
        of every corner house in the inner west.

        The choice being "nearest" is also what makes `DOOR_MAX_KERB` safe to
        raise: a wider reach can only admit an edge further away than the one
        already chosen, so it never re-decides a building that had an answer.
        """
        if self._streets is None:
            return None
        best_key: tuple[float, float] | None = None
        best: FrontEdge | None = None
        for u0, seg, p0, p1 in runs:
            d = p1 - p0
            # ENU right of travel, which is outward on a counter-clockwise ring.
            outward = np.array([d[1], -d[0]]) / seg
            hit = _street_ahead_way(
                self._streets, (p0 + p1) * 0.5, outward, DOOR_MAX_KERB, exclude
            )
            if hit is None:
                continue
            kerb, way = hit
            key = (kerb, -seg)
            if best_key is None or key < best_key:
                best_key = key
                best = FrontEdge(u0, seg, p0, p1, outward, kerb, way)
        return best


def _plane_normal(a, b, c) -> tuple[float, float, float]:
    u = np.subtract(b, a)
    v = np.subtract(c, a)
    n = np.cross(u, v)
    ln = float(np.linalg.norm(n))
    if ln < 1e-9:
        return (0.0, 1.0, 0.0)
    n = n / ln
    if n[1] < 0:
        n = -n
    return (float(n[0]), float(n[1]), float(n[2]))


def _oriented_rect(ring: np.ndarray):
    """(centre, long axis unit, short axis unit, half long, half short) in ENU."""
    from shapely.geometry import Polygon

    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon":
        return None
    rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon":
        return None
    p = np.asarray(rect.exterior.coords)[:4]
    e0 = p[1] - p[0]
    e1 = p[2] - p[1]
    l0, l1 = float(np.linalg.norm(e0)), float(np.linalg.norm(e1))
    if min(l0, l1) < 0.5:
        return None
    if l0 >= l1:
        long_v, short_v, half_long, half_short = e0 / l0, e1 / l1, l0 / 2, l1 / 2
    else:
        long_v, short_v, half_long, half_short = e1 / l1, e0 / l0, l1 / 2, l0 / 2
    centre = p.mean(axis=0)
    return centre, long_v, short_v, half_long, half_short
