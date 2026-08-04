"""Street furniture: wheelie bins, street-name blades and traffic signals.

Spec 7.7 lists five things beyond the awnings and the kerbing that are already
in. Three of them are here, chosen for recognition per triangle in exactly the
sense spec 7.2 uses about the power lines -- each is a *sign* that this is
Sydney rather than a generic western city, and none of them costs more than a
few dozen triangles:

  * **Red, yellow and green wheelie bins**, in ones and twos against the kerb in
    front of houses. The three-stream 240 L bin is Australian domestic
    infrastructure and the lid colour scheme is national. Nothing else this
    cheap says "somebody lives here" -- an empty footpath is a render, and a
    footpath with two bins on it is a street on a Tuesday morning.
  * **AS 1742 street-name blades**, at named corners, carrying **the actual
    street name**. The name is written into the sidecar and drawn into a canvas
    texture by the client at run time; the pipeline's job is to decide the text
    and which of the two Sydney house styles the corner wears. See "Blades" and
    "Two styles" below.
  * **Traffic signals**, black three-lamp heads with the yellow-bordered backing
    board, at the intersections OSM says are signalised.

Architecturally this is `power.py` again, which is `parking.py` again, which is
`vegetation.py` again: one network built for the whole run, per-tile emission, a
binary sidecar, and client-side instanced geometry streamed and disposed with
the tile. Anything that reads oddly here is worth checking against `power.py`
first -- the kerb-line placement, the shift-don't-drop keep-outs, the per-tile
cap and the deterministic hashing are all lifted from it wholesale.

---------------------------------------------------------------------------
**Bins.** Placed along both kerbs of the residential classes, every 25-45 m,
where there is a house behind the footpath to have put them there.

Two things about them are decisions rather than mechanics.

*Bin day is a property of the street, not of the house.* The obvious rule --
roll a die at each candidate position -- produces an even stipple of bins over
the whole suburb, which is the failure `parking.py` measures at length for
parked cars and it is worse here, because bin collection is genuinely
correlated: a council collects a whole zone on one weekday, so a street either
has bins out or it does not. So the roll is per *way* (`BIN_DAY_RATE`) and the
positions on a bin-day street are then filled densely (`BIN_PUT_OUT_RATE`). The
net rate lands near the third of positions a per-position roll would have given,
and what you walk past is a street of bins and then three streets without.

*The recycling stream is a property of the street too.* Yellow and green are on
alternating fortnights across a whole collection zone, so a street on its yellow
week has yellow bins out and no green ones. The cluster is therefore red plus
*that street's* recycling colour, with an occasional household putting out both
-- which is what produces the odd three-bin cluster in a row of twos.

*A bin stands exactly where a pole does.* `BIN_KERB_SETBACK` puts a bin's centre
0.55 m behind the kerb face and `power.KERB_SETBACK` puts a pole's at 0.55 m
too, so the two are on the same line *by construction* and `CLEAR_OF_POLE` is
purely a test of how close they are along the street. That is the same shape of
arithmetic `power.CLEAR_OF_TREE` documents, and it has the same consequence: the
test fires often, so `_place` shifts the cluster along the kerb before it gives
up on it.

---------------------------------------------------------------------------
**Blades and signals both hang off one thing: a junction.**

OSM gives centrelines, not intersections, so junctions are derived. Three
observations shape how:

  1. *A way end is not a junction.* OSM splits a way wherever the name, the
     speed limit or the bridge status changes, so a third of way ends are
     mid-block continuations. What separates the two is the number of directions
     a street leaves in: a continuation has two, an L-bend has two, a T has
     three and a cross has four. `MIN_LEGS` is 3.
  2. *A junction is not always a way end.* A street that OSM did **not** split at
     a side road contributes no endpoint there at all. So the legs are counted
     from every centreline passing within `JUNCTION_REACH` of the point, with a
     way passing *through* contributing two legs and a way ending there one.
     Without this, every T-junction on an unsplit through street is invisible.
  3. *A divided road is one intersection and several way ends.* Two carriageways
     8 m apart produce two junction points; merged at `JUNCTION_MERGE` they
     produce one post. 6,752 raw junctions in the inner ring become 5,906.

---------------------------------------------------------------------------
**Where the blade post goes: the NE corner, and it is not arbitrary.**

A junction has three or four footpath corners and this puts one post on one of
them. "The corner with the widest footpath" is the intuitive rule and it is a
worse one: it needs a footpath width per leg, it ties on the very common case of
two legs of the same class, and the tie-break would then be arbitrary anyway.

The corners are ranked by `east + north` and the first clear one wins -- the
north-east corner. Two reasons, and the second is the real one:

  * It is a pure function of the junction geometry, so it cannot disagree with
    itself between runs or between tiles.
  * **The sun is in the north.** Sydney is at -33.9 degrees and the sun transits
    north of the zenith every day of the year, so the north-east corner of an
    intersection is the one lit from mid-morning to mid-afternoon. A green blade
    with a white border reads as a green blade with a white border in sun; the
    same blade on the shaded south-west corner is a dark rectangle. This whole
    feature is colour and proportion at fifty metres, and putting it where the
    light is doubles the distance it survives to.

---------------------------------------------------------------------------
**Where the signals go, and which lamp is lit.**

The source is OSM's own `highway=traffic_signals` nodes, which turn out to be
mapped thoroughly -- 1,547 of them in the inner ring. They are mapped **per
approach**, at the stop line, 10-20 m back from the middle of the intersection,
so they are clustered (`SIGNAL_LINK`) and each cluster's centroid attached to
the nearest derived junction. That gives 386 signalised intersections, against
the 130 that a rule based purely on road class -- "both ways tertiary or larger"
-- would have found. The class rule is not used at all: it misses two thirds of
the signals in the city, because Sydney signalises plenty of residential
crossings and leaves plenty of tertiary ones on give-way.

A head stands at each footpath corner, facing **inward**, up to four. Inward is
the far-side display -- the one a driver actually reads, on the opposite side of
the intersection -- and it is also the only single rule that looks right from
every approach at once: from any leg you see two heads facing you across the
junction and the backs of two more on your own side, which is what a signalised
intersection looks like.

*Which lamp is lit is not a per-pole coin toss*, and this is the one place this
module departs from what was asked for. A hash per head puts green on four
corners of the same intersection about one time in six, and an intersection
showing green on all four approaches is not a static approximation of a signal
-- it is a signal that is visibly wrong. The real constraint is free: opposite
approaches share a phase. So the junction picks a *reference axis* (its
highest-class leg), each head works out which approach it serves -- the leg most
nearly opposite the corner it stands on -- and shows green if that leg lies on
the reference axis and red if it crosses it. On a four-way that is two green and
two red; on a T it is two green along the through street and one red on the
stem. `AMBER_RATE` of junctions have their green phase on amber instead, which
is the change interval and costs nothing.

There is still no cycling: the lamp is baked at build time and a signal never
changes. Making them run needs a shared clock and a per-junction phase offset in
the sidecar, and it is a follow-up named in the README rather than smuggled in
here.

---------------------------------------------------------------------------
**Two blade styles, and the line between them is a radius.**

Photographs of two Sydney corners settle this. A blade on Sydney Park Road at
St Peters is a **white plate with black uppercase legend and a thin black
border** -- the older RMS/RTA pattern, which is what most of the inner south and
inner west still carries. A blade on York Street in the CBD is a **dark bottle
green plate with white legend, a white border line and the City of Sydney
crest** -- the council's own pattern, which stops at the council's own boundary.

So the style is a property of the *local government area*, not of the road
class, and the pipeline has no LGA polygon. What it has is the ENU origin, which
is Town Hall, in the middle of the City of Sydney LGA. `COS_LGA_RADIUS` is a
circle about that origin sized to the LGA's own extent, and it gets the call
right for the CBD, Ultimo, Pyrmont, Surry Hills, Darlinghurst and Woolloomooloo
-- and wrong at the edges, in Newtown and Waterloo, which are genuinely in the
City of Sydney and fall outside the circle. A real boundary is a follow-up worth
one polygon; a radius is what makes the two styles both *appear*, which is the
whole of what the reference photographs are asking for.

**The text is decided here and drawn there.** `_blade_text` abbreviates the road
type the way every Australian blade does -- "Sydney Park Road" is signed SYDNEY
PARK RD, never in full -- and truncates at `MAX_NAME_CHARS`. Case is left alone,
because the sidecar's name is also the only street-name string the client has
and a map readout wants "Sydney Park Rd"; the blade renderer uppercases it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

from . import config, power, streets, vegetation
from .merge import Building

# One function, one winding convention. `streets._emit_kerb_face`,
# `vegetation._verge_point`, `parking._bay_point` and `power._place` all agree
# about which side of a street they are on because they all go through this, and
# a second copy here would be a fifth chance to disagree.
from .power import _offset_point
from .sources import osm

# The same SplitMix64 the trees, the cars and the poles are placed with,
# imported rather than copied for the reason `parking.py` gives: two copies of a
# hash drift, and every determinism argument in the pipeline rests on this being
# one function. The constants mixed in below keep this module's streams
# independent of the other four.
from .vegetation import _hash, _osm_int, _unit

# --- Bin lid colours ----------------------------------------------------------
# The u8 written into the sidecar. APPEND ONLY -- the client keys its geometry
# table off these integers, exactly as it does for tree species, car bodies and
# pole kinds.

LID_RED = 0  # general waste, weekly
LID_YELLOW = 1  # commingled recycling
LID_GREEN = 2  # garden organics

LID_COUNT = 3

LID_NAME = {LID_RED: "red", LID_YELLOW: "yellow", LID_GREEN: "green"}

# --- Signal lamps -------------------------------------------------------------

LAMP_RED = 0
LAMP_AMBER = 1
LAMP_GREEN = 2

LAMP_COUNT = 3

LAMP_NAME = {LAMP_RED: "red", LAMP_AMBER: "amber", LAMP_GREEN: "green"}

# --- Bins: where they go ------------------------------------------------------

# Classes whose kerbs get bins. The residential distribution network again, and
# for once the list barely matters: the frontage test below is what actually
# decides, since a bin is put out by a *house* and this is only asking which
# kerbs are worth walking. `service` is excluded on the same argument
# `power.POLE_CLASSES` makes -- a laneway's bins go out on the street the house
# is addressed on, not in the lane behind it -- and `secondary` and above are
# excluded because an arterial's frontage is shops, and a shop's waste goes into
# a trade bin in a service yard.
BIN_CLASSES = {"residential", "unclassified", "living_street", "tertiary"}

# Nominal pitch along the kerb, and the jitter either side, so clusters come out
# at 25-45 m. That is a house frontage or two: an inner-west terrace is 5-6 m
# wide, a Federation block 12-15 m, so this is one cluster per three or four
# houses, which is what `BIN_PUT_OUT_RATE` below is really expressing.
BIN_SPACING = 35.0
BIN_SPACING_JITTER = 10.0

# Share of bin-class ways whose collection day is *today*, and share of the
# candidate positions on such a way that actually have a cluster.
#
# Two rolls rather than one, and see the module docstring: bin day is a property
# of the street. A council runs one collection zone a weekday, so about a fifth
# of the city's streets have bins out on any given morning; 0.35 is deliberately
# over that, because a fifth means walking four blocks between bins and the
# feature stops paying for itself. The product, 0.28, is close to the third of
# positions a single per-position roll would have used, and what it buys is that
# the third is *clustered by street* instead of stippled evenly over the suburb.
BIN_DAY_RATE = 0.35
BIN_PUT_OUT_RATE = 0.80

# How far behind the kerb face a bin's centre stands.
#
# The kerb face is at `half_width` and its exposed top runs to `half_width +
# KERB_WIDTH`, so 0.4 m past that puts the bin's centre 0.55 m off the face and
# its road-side edge at 0.18 m -- just over the kerb top, hard against the edge,
# which is where a bin has to be for a side-lift truck to reach it and where
# every bin in the city is on collection morning.
#
# It is also exactly where `power.KERB_SETBACK` puts a pole. That is not a
# collision waiting to happen, it is the reason `CLEAR_OF_POLE` is written the
# way it is -- see the module docstring.
BIN_KERB_SETBACK = 0.4

# The 240 L MGB, metres: width across the lid, depth front to back, height to
# the closed lid. **These three must match `client/src/world/furniture.ts`**,
# which builds the geometry, because `BIN_PITCH` below is derived from the width
# and a cluster would otherwise either overlap or gap.
BIN_WIDTH = 0.58
BIN_DEPTH = 0.74
BIN_HEIGHT = 1.07

# Centre-to-centre spacing of bins within a cluster: the body plus a 10 cm gap.
# Bins put out together are nearly touching, because whoever wheeled them out
# wheeled them out one after the other.
BIN_PITCH = BIN_WIDTH + 0.10

# Cluster size. Red is always present -- it is the weekly general waste bin and
# it goes out every collection day without exception. The street's own recycling
# stream joins it most of the time, and occasionally the *other* stream comes out
# too, which is the household that missed last fortnight.
BIN_RECYCLING_RATE = 0.75
BIN_BOTH_STREAMS_RATE = 0.15

# Share of bin-day streets on their yellow (commingled) week rather than their
# green (garden organics) week. Yellow leads because commingled collection is
# more frequent than garden organics across the inner-city councils, and because
# a good half of the inner west has no garden to fill a green bin with.
BIN_YELLOW_RATE = 0.60

# How far a bin may be turned off square to the kerb. Nobody lines a bin up, and
# a row of them at exactly 90 degrees is the same tell as a dead-vertical power
# pole: it reads as CAD. 14 degrees is enough to see and not enough to look
# knocked over.
BIN_YAW_JITTER = math.radians(14.0)

# --- Bins: keep-outs ----------------------------------------------------------

# No bin within this of a junction. Corner splays and sight lines, and the same
# constant every other module in the pipeline measures from the junction node --
# smaller than `power.CLEAR_OF_JUNCTION` because a 1.07 m bin blocks nothing a
# driver needs to see and a 10 m pole does.
CLEAR_OF_JUNCTION = 6.0

# Clearance from a power pole and from a tree trunk, centre to centre.
#
# A pole stands at `half_width + KERB_WIDTH + 0.4` and a bin at exactly the same
# offset, so this is a pure along-the-street test: it fires whenever a pole is
# within 1.2 m of where the cluster wanted to be. A tree is 0.6 m further out
# (`vegetation.VERGE_OFFSET` is 1.0 against this 0.4), so the tree test has that
# much slack across the footpath and fires less.
#
# 1.2 m is the bin's own half-width plus the pole's radius plus room to open the
# lid. Anything larger starts deleting clusters on well-planted streets, which
# is what `_place`'s shift is here to avoid.
CLEAR_OF_POLE = 1.2
CLEAR_OF_TREE = 1.2

# Clearance from a building footprint, for the case where an overstated road
# width puts the footpath inside a wall. Small for the reason
# `power.CLEAR_OF_BUILDING` gives, and smaller still: a bin against a shopfront
# is not merely normal, it is where they are put.
CLEAR_OF_BUILDING = 0.5

# How far along the kerb `_place` may shift a cluster, and the steps it tries in
# order. Shorter than `power.SHIFT_STEPS` because a bin cluster has no chain to
# keep continuous -- if it cannot be placed the street simply has one fewer
# household with its bins out, which is not a visible failure the way a hole in a
# pole line is. It shifts anyway, because it costs four spatial queries and
# recovers most of the losses.
SHIFT_STEPS: tuple[float, ...] = (0.0, 1.5, -1.5, 3.0, -3.0)

# --- Bins: the frontage test --------------------------------------------------

# Archetypes that put bins on the kerb. Houses and walk-ups: everything with a
# household behind it and a footpath in front of it.
#
# `retail_strip` and `modern_infill` are deliberately out. A shop's waste goes
# into a trade bin in a service yard or a rear lane, and an apartment block's
# goes into a bin room -- what appears on the kerb outside either is a 660 L or
# 1100 L trade bin on four castors, which is different furniture with different
# proportions and is a follow-up.
FRONTAGE_ARCHETYPES = frozenset({"terrace", "federation", "walkup", "brick_veneer"})

# How far behind the bin a qualifying house may stand. Generous, and it is
# asking "is this a residential street" rather than "whose bin is this": a
# terrace's wall is 3-5 m off the kerb, a Federation house 8-12 m with a garden,
# and a walk-up can be 20 m back behind a forecourt.
FRONTAGE_REACH = 25.0

# --- Junctions ----------------------------------------------------------------

# Grid that way endpoints are bucketed on before clustering, metres. Two ends of
# the same OSM node land on identical coordinates -- `simplify` preserves
# endpoints exactly -- so this only has to absorb the case where two ways were
# digitised to *nearly* the same point.
JUNCTION_SNAP = 1.0

# How close a centreline must pass to a candidate point to count as touching it.
# The through-street case in the module docstring: a way OSM did not split at the
# side road has no endpoint here, so it has to be found by proximity.
JUNCTION_REACH = 2.5

# Leg bearings within this of each other are the same leg. Absorbs the two
# halves of a way that bends slightly at the node, and the several centrelines of
# a dual carriageway leaving in parallel.
LEG_MERGE_DEG = 22.0

# How far along a leg its bearing is measured. Long enough to ignore the
# digitising noise in the first metre of a centreline, short enough that a curved
# approach still reports the direction it arrives from.
LEG_TANGENT = 5.0

# Legs a point needs before it is an intersection rather than a continuation or a
# bend. See observation 1 in the module docstring.
MIN_LEGS = 3

# Junction points closer than this are one intersection. A dual carriageway, a
# staggered crossroads and a slip lane all produce several; merged, they produce
# one post and one set of signal heads.
JUNCTION_MERGE = 12.0

# Classes whose legs count towards `MIN_LEGS`. `service` is excluded and that
# exclusion is doing real work: a driveway joining a mid-block way split turns a
# two-leg continuation into a three-leg "junction", and if the way happens to
# change name there -- which is exactly why OSM split it -- the result is a
# street-name post in the middle of a block. Lane *names* are still read; it is
# only the count that ignores them.
JUNCTION_LEG_CLASSES = frozenset(osm.STREET_CLASSES) - {"service"}

# --- Street-name blades -------------------------------------------------------

# Blades per post. Two is what an Australian corner carries: one for each street,
# mounted at right angles on the same post. A junction of three named streets
# exists and is rare, and the third blade is dropped rather than modelled --
# three blades on one post needs a taller post and a different bracket.
MAX_BLADES = 2

# Distance from the *kerb corner* to the post, along the corner's bisector.
# 1.5 m puts it on the footpath clear of the kerb ramp and inside the 3 m paved
# band that `streets.FOOTPATH_WIDTH_DEFAULT` lays down.
BLADE_CORNER_SETBACK = 1.5

# Half-angle floor for a corner, degrees. The distance to a corner goes as
# `1 / sin(half-angle)`, so a 15-degree fork would fling the post 25 m down the
# street. Clamped here and again by `MAX_CORNER_DISTANCE`.
MIN_CORNER_HALF_ANGLE = 25.0

# Ceiling on how far from the junction node a corner may be. A wide dual
# carriageway genuinely puts its corner 15 m out; anything past this is an acute
# fork the bisector has no useful answer for.
MAX_CORNER_DISTANCE = 16.0

# Blade dimensions, metres, and the height of its centre above the footpath.
# **Must match `client/src/world/furniture.ts`.** 2.4 m is the standard mounting
# height -- above a pedestrian's head, below the awning line.
#
# 0.9 x 0.20 rather than the 0.9 x 0.15 this started at, and the reason is
# arithmetic rather than taste. The blade now carries a legend, and a legend has
# to survive to a distance somebody would read it from. At the client's 72
# degree vertical field of view, an object of height `h` at distance `d` covers
# `h / (2 d tan 36) * H` pixels of a render `H` pixels tall; at 1440p with the
# 0.75 render scale that is 1080. A 0.15 m blade at 10 m is 11.1 px *in total*,
# so its capitals -- about 0.69 of the plate on a real blade -- are 7.6 px, and
# 7-8 px is where uppercase stops being read and starts being guessed at. 0.20 m
# puts the plate at 14.9 px and the capitals at 10.2, which clears it. 900 x 200
# is a real Australian blade size and is the one used where the legend is long,
# so this is a size change rather than an exaggeration.
BLADE_LENGTH = 0.9
BLADE_HEIGHT = 0.20
BLADE_MOUNT_Y = 2.4

# --- Blade styles -------------------------------------------------------------
#
# The u8 written per post into the sidecar. APPEND ONLY, on the same terms as
# `LID_*` and `LAMP_*`: the client keys its palette off these integers.

STYLE_COS_GREEN = 0  # City of Sydney: bottle green field, white legend
STYLE_RMS_WHITE = 1  # the older RMS pattern: white field, black legend

STYLE_COUNT = 2

STYLE_NAME = {STYLE_COS_GREEN: "City of Sydney green", STYLE_RMS_WHITE: "RMS white"}

# Radius about the ENU origin (Town Hall) inside which a corner is signed in the
# City of Sydney's own green. See the module docstring: this stands in for the
# LGA boundary, which the pipeline does not have.
#
# The City of Sydney LGA runs roughly from Rushcutters Bay to Glebe and from
# Millers Point to Green Square -- about 6 km on its long axis and 3 on its
# short. A circle cannot be both, and the failure modes are not symmetric: a
# green blade in Newtown is a blade a Sydney player would not blink at, and a
# white blade on George Street is one they would. So the radius is set to the
# LGA's *short* half-axis rather than its long one, which keeps the whole CBD,
# Ultimo, Pyrmont, Surry Hills, Darlinghurst and Woolloomooloo green and lets
# the far ends of the LGA read as inner-suburban.
COS_LGA_RADIUS = 2500.0

# Characters of street name kept for the blade. The sidecar length-prefixes the
# name with a u8, so the hard ceiling is 255 bytes; this is far under it and is
# set by what fits on a 900 mm plate rather than by the format. Post-
# abbreviation, 24 characters covers every name in the inner ring bar a handful
# of compound ones -- see the build report, which counts what this trims.
MAX_NAME_CHARS = 24

# The road-type abbreviations an Australian blade uses. Applied to the last word
# of the name only, so "Broadway" and "Missenden Road" both come out right, and
# case-insensitively so OSM's occasional "ROAD" is caught.
#
# This is signage practice rather than a data cleanup: no blade in the country
# is lettered "Sydney Park Road". Left out on purpose are the types that are not
# abbreviated on a blade -- Broadway, Circus, Mall, Row, Wharf -- and every name
# that is a single word, which is handled by the guard in `_blade_text`.
_ROAD_TYPE_ABBREV: dict[str, str] = {
    "street": "St",
    "road": "Rd",
    "avenue": "Ave",
    "lane": "Ln",
    "place": "Pl",
    "drive": "Dr",
    "court": "Ct",
    "crescent": "Cres",
    "parade": "Pde",
    "terrace": "Tce",
    "highway": "Hwy",
    "boulevard": "Bvd",
    "boulevarde": "Bvd",
    "circuit": "Cct",
    "close": "Cl",
    "esplanade": "Esp",
    "grove": "Gr",
    "square": "Sq",
    "parkway": "Pwy",
    "walk": "Wk",
    "gardens": "Gdns",
    "expressway": "Xwy",
    "freeway": "Fwy",
    "motorway": "Mwy",
    "roadway": "Rdwy",
    "cycleway": "Cwy",
    "distributor": "Dist",
    "tunnel": "Tnl",
}

# Words that may trail the road type, and what a blade calls them. A name
# ending in one of these has its *type* one word further back -- "Alfred Street
# North", "Macquarie Street Offramp" -- so `_blade_text` peels these off before
# it looks for the type, and puts them back after.
#
# The peel matters more than the abbreviation. Without it the widest legends in
# the extent are all motorway ramps at twice the width of a plate, because their
# type word is never the last one and so never shortens; with it they come down
# by a third. They are still the widest, which is honest -- an on-ramp does not
# have a street blade in life, and the fact that OSM gives it a name is not
# something this module should pretend to fix by inventing an abbreviation.
_NAME_SUFFIX_ABBREV: dict[str, str] = {
    "north": "Nth",
    "south": "Sth",
    "east": "East",
    "west": "West",
    "onramp": "On",
    "offramp": "Off",
    # "Off Ramp" as two words, which OSM has as often as one. Peeled innermost
    # first, so "Street Off Ramp" gives back "St Off Ramp" rather than losing the
    # order -- and the pair then collapses no further, which is right: "Off" on
    # its own is not a name.
    "ramp": "Ramp",
    "on": "On",
    "off": "Off",
    "extension": "Ext",
    "overpass": "Ovps",
    "underpass": "Unps",
}

# --- Traffic signals ----------------------------------------------------------

# Single-link radius for clustering mapped `highway=traffic_signals` nodes into
# one intersection. The nodes sit at stop lines 10-20 m either side of the
# middle, so this has to reach across the whole intersection: at 25 m the inner
# ring splits into 556 clusters, at 35 into 445, at 45 into 397 -- and the knee
# is at 35, past which it starts joining a signalised crossroads to the mid-block
# pedestrian signal fifty metres up the road.
SIGNAL_LINK = 35.0

# How far a signal cluster's centroid may be from a derived junction and still
# be that junction's. The centroid of four stop lines lands within 5 m of the
# middle at p50 and 39 m at p90 -- the tail being T-junctions where the stop
# lines are all on one side -- so this is set past the p90.
SIGNAL_TO_JUNCTION = 30.0

# Heads per intersection. Four is the whole of a normal crossroads; a five-way
# gets four and its fifth approach reads off one of them, which is what a real
# five-way does too.
MAX_SIGNAL_HEADS = 4

# Distance from the kerb corner to the signal pole. Much closer in than the
# blade post: a signal stands at the kerb where it can be seen down the
# approach, not back against the property line.
SIGNAL_CORNER_SETBACK = 0.55

# Signal pole height and the head's dimensions, metres. **Must match
# `client/src/world/furniture.ts`.**
SIGNAL_POLE_HEIGHT = 4.2
SIGNAL_HEAD_WIDTH = 0.30
SIGNAL_HEAD_HEIGHT = 0.90

# Half-angle either side of the reference axis within which a leg is on the
# green phase. 45 degrees splits a four-way exactly and puts an oblique fifth
# leg with whichever pair it is closer to.
PHASE_HALF_ANGLE = 45.0

# Share of signalised junctions showing amber instead of green -- the change
# interval, which a real intersection spends 4 of every 60 seconds in. Set above
# that because an amber signal is the most legible of the three at a glance and
# a city with none of them looks like it only has two aspects.
AMBER_RATE = 0.08

# --- Budget -------------------------------------------------------------------

# Per-tile ceilings, here for the reason `power.MAX_POLES_PER_TILE` is: a silent
# 900-instance tile is a frame spike nobody would attribute to this file. All
# three are set well clear of the measured distribution rather than near it, and
# the build warns if any of them fires.
MAX_BINS_PER_TILE = 300
MAX_POSTS_PER_TILE = 90
MAX_SIGNALS_PER_TILE = 60

# Ways within this of a tile's bounds can put a bin inside it. Must exceed the
# widest offset any way produces -- half of `streets.MAX_ROAD_WIDTH` plus the
# kerb and the setback -- plus a cluster's own half length.
SELECT_MARGIN = 30.0


@dataclass
class Bin:
    """One wheelie bin, in ENU metres."""

    east: float
    north: float
    # Terrain height under the bin, plus the footpath's own clearance: a bin
    # stands *on* the paving, not in the ground the paving is over. Sampled here
    # so the client repeats no lookup, on the same argument `power.Pole` makes.
    ground_y: float
    # ENU bearing of the direction the bin faces, which is the road. Written to
    # the sidecar unchanged, because an ENU bearing *is* the renderer's Y
    # rotation for geometry built facing local +X -- `parking._heading` works
    # that out in full and `tiles.write_furniture` restates it.
    yaw: float
    lid: int


@dataclass
class NamePost:
    """One street-name post and the one or two blades it carries."""

    east: float
    north: float
    ground_y: float
    # One yaw per blade, radians, each parallel to the street it names.
    blade_yaws: list[float]
    # The legend on each blade, in the same order as `blade_yaws`: already
    # abbreviated and truncated by `_blade_text`, and written straight into the
    # sidecar for the client to rasterise. Natural case, not uppercase -- see the
    # module docstring.
    names: list[str] = field(default_factory=list)
    # `STYLE_COS_GREEN` or `STYLE_RMS_WHITE`, for the whole post. Both blades on
    # one post are always the same style, because they are the same council's.
    style: int = STYLE_COS_GREEN


@dataclass
class Signal:
    """One three-lamp signal head on its pole, at one corner of an intersection."""

    east: float
    north: float
    ground_y: float
    # Radians. The head faces *inward*, across the intersection, which is the
    # far-side display -- see the module docstring.
    yaw: float
    lit: int


@dataclass
class TileFurniture:
    """One tile's share of all three."""

    bins: list[Bin] = field(default_factory=list)
    posts: list[NamePost] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.bins and not self.posts and not self.signals


@dataclass
class _Junction:
    """A derived intersection: where it is, and what leaves it."""

    east: float
    north: float
    # (bearing, way index) per distinct leg, sorted by bearing. The bearing points
    # *away* from the junction.
    legs: list[tuple[float, int]]


class FurnitureNetwork:
    """Every bin, name post and signal in the extent, indexed for tile queries.

    Built once per run, after `PowerNetwork`, because a bin has to clear a pole
    and querying that per tile would rebuild the pole run for every tile the
    street touches. It queries the street, vegetation and power networks
    read-only and adds nothing to any of them.
    """

    def __init__(
        self,
        street_network: streets.StreetNetwork,
        veg_network: vegetation.VegetationNetwork,
        power_network: power.PowerNetwork,
        buildings: list[Building],
        signal_nodes: list[osm.OsmPoi],
        terrain=None,
    ) -> None:
        self._streets = street_network
        self._veg = veg_network
        self._power = power_network
        self._terrain = terrain
        self._bin_cache: dict[int, list[Bin]] = {}

        self.stats: dict[str, int] = {
            "bin_ways_considered": 0,
            "bin_ways_collected": 0,
            "bin_candidates": 0,
            "bin_clusters": 0,
            "bin_shifted": 0,
            "drop_frontage": 0,
            "drop_junction": 0,
            "drop_pole": 0,
            "drop_tree": 0,
            "drop_building": 0,
            "drop_bin_cap": 0,
            "junction_points": 0,
            "junctions": 0,
            "junctions_merged": 0,
            "post_no_name": 0,
            "post_one_name": 0,
            "post_no_corner": 0,
            "blades_dropped": 0,
            "names_truncated": 0,
            "names_abbreviated": 0,
            "signal_nodes": len(signal_nodes),
            "signal_clusters": 0,
            "signal_orphan": 0,
            "signal_junctions": 0,
            "drop_post_cap": 0,
            "drop_signal_cap": 0,
        }

        # Residential footprints, indexed on their own. `StreetNetwork` already
        # holds every footprint and exposes `buildings_near`, but it has thrown
        # the archetype away by then -- and the archetype is the whole test.
        self._frontage = [
            poly
            for b in buildings
            if b.archetype in FRONTAGE_ARCHETYPES
            for poly in (streets._footprint(b),)
            if poly is not None
        ]
        self._frontage_tree = STRtree(self._frontage) if self._frontage else None

        # Junction proxies for the bin keep-out. The same construction
        # `power.PowerNetwork` uses and with the same caveat: it over-reports,
        # because a way also splits where the name changes, and over-reporting
        # costs a shifted bin where under-reporting puts one in a corner splay.
        ends: list[Point] = []
        for i, r in enumerate(street_network.roads):
            if r.is_foot:
                continue
            coords = list(street_network.centreline(i).coords)
            if len(coords) >= 2:
                ends.append(Point(coords[0]))
                ends.append(Point(coords[-1]))
        self._junction_proxies = STRtree(ends) if ends else None

        # The real junctions, and everything that hangs off them. Built once and
        # bucketed by tile rather than regenerated per way: unlike a bin, a post
        # belongs to exactly one intersection and an intersection to exactly one
        # tile, so there is nothing to cache per way and nothing to deduplicate.
        junctions = self._build_junctions()
        signalised = self._attach_signals(junctions, signal_nodes)
        self._posts_by_tile: dict[str, list[NamePost]] = {}
        self._signals_by_tile: dict[str, list[Signal]] = {}
        self._place_junction_furniture(junctions, signalised)

        # Tallied over what is actually emitted, so the report describes the
        # world rather than what was proposed.
        self.emitted_bins = 0
        self.emitted_posts = 0
        self.emitted_blades = 0
        self.emitted_signals = 0
        self.lid_counts = [0] * LID_COUNT
        self.lamp_counts = [0] * LAMP_COUNT
        self.cluster_sizes: dict[int, int] = {}
        # Posts by style, and the set of distinct legends actually emitted. The
        # second is the one number the client's texture cache is sized against --
        # it builds one canvas per unique (name, style) -- so the build reports
        # it rather than leaving it to be discovered as a memory figure.
        self.style_counts = [0] * STYLE_COUNT
        self.unique_names: set[tuple[str, int]] = set()
        self.name_chars_max = 0

    # --- Tile coverage --------------------------------------------------------

    def tile_keys(self) -> set[str]:
        """Tiles a post or a signal puts something into.

        Deliberately not every tile this module can reach: a tile with a street
        in it is already in `streets.tile_keys()`, and the bins are all on
        streets. An intersection is on a street too, so in practice this is a
        subset -- it is here so that a future junction source off the street
        network cannot silently lose its tile.
        """
        return set(self._posts_by_tile) | set(self._signals_by_tile)

    def instances(self, tile_key: str) -> TileFurniture:
        """Everything standing inside one tile."""
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        region = box(e0, n0, e1, n1).buffer(SELECT_MARGIN)

        def inside(east: float, north: float) -> bool:
            # Half-open on the upper edge, so an object exactly on a tile line
            # lands in one tile and not in both.
            return e0 <= east < e1 and n0 <= north < n1

        bins: list[Bin] = []
        for i in self._streets.ways_near(region):
            bins.extend(b for b in self._bins_on_way(i) if inside(b.east, b.north))

        # Ordered before anything greedy runs over it, so a cap cannot depend on
        # which way `ways_near` happened to return first.
        bins.sort(key=lambda b: (b.east, b.north))
        posts = sorted(self._posts_by_tile.get(tile_key, ()), key=lambda p: (p.east, p.north))
        signals = sorted(self._signals_by_tile.get(tile_key, ()), key=lambda s: (s.east, s.north))

        bins = self._cap(bins, MAX_BINS_PER_TILE, "drop_bin_cap")
        posts = self._cap(posts, MAX_POSTS_PER_TILE, "drop_post_cap")
        signals = self._cap(signals, MAX_SIGNALS_PER_TILE, "drop_signal_cap")

        out = TileFurniture(bins, posts, signals)
        self._tally(out)
        return out

    def _cap(self, items: list, limit: int, stat: str) -> list:
        """Hold a tile under a ceiling, thinning by hashed rank.

        By rank rather than by list order, so a tile over budget loses an even
        spread rather than one corner of itself -- the same argument
        `power._cap` makes. The hash is over the position, which is stable.
        """
        if len(items) <= limit:
            return items
        self.stats[stat] += len(items) - limit
        keyed = sorted(items, key=lambda o: _hash(int(o.east * 100), int(o.north * 100), 0xF0E))
        return sorted(keyed[:limit], key=lambda o: (o.east, o.north))

    def _tally(self, out: TileFurniture) -> None:
        self.emitted_bins += len(out.bins)
        self.emitted_posts += len(out.posts)
        self.emitted_signals += len(out.signals)
        for b in out.bins:
            self.lid_counts[b.lid] += 1
        for p in out.posts:
            self.emitted_blades += len(p.blade_yaws)
            self.style_counts[p.style] += 1
            for name in p.names:
                self.unique_names.add((name, p.style))
                self.name_chars_max = max(self.name_chars_max, len(name))
        for s in out.signals:
            self.lamp_counts[s.lit] += 1

    # --- Bins -----------------------------------------------------------------

    def _bins_on_way(self, i: int) -> list[Bin]:
        cached = self._bin_cache.get(i)
        if cached is not None:
            return cached
        out = self._build_bins_on_way(i)
        self._bin_cache[i] = out
        return out

    def _build_bins_on_way(self, i: int) -> list[Bin]:
        """Every bin along one way, both kerbs."""
        road = self._streets.roads[i]
        # No house fronts a bridge, so no bin is put out on one -- and since
        # `decks.py` took the bridge ways off the ground there is no footpath
        # under a viaduct to stand one on. See `streets.DECK_EDGE`.
        if road.is_foot or road.bridge or road.highway not in BIN_CLASSES:
            return []

        way_id = _osm_int(road.osm_id)
        # Bin day, for the whole street. See the module docstring: this is the
        # roll that makes bins read as streets rather than as stipple.
        if _unit(_hash(way_id, 0xB1D), 0) >= BIN_DAY_RATE:
            return []
        self.stats["bin_ways_considered"] += 1

        line = self._streets.centreline(i)
        length = line.length
        if length < 2.0 * CLEAR_OF_JUNCTION + BIN_SPACING:
            return []
        half = self._streets.half_width(i)
        if half < power.MIN_HALF_WIDTH:
            return []
        # Which recycling stream is out this week, for the whole street.
        recycling = LID_YELLOW if _unit(_hash(way_id, 0xB1D), 1) < BIN_YELLOW_RATE else LID_GREEN

        offset = half + streets.KERB_WIDTH + BIN_KERB_SETBACK
        out: list[Bin] = []
        for side in (1, -1):
            # A hashed phase per side, so the two kerbs of one street do not put
            # their clusters exactly opposite each other -- which they never are,
            # because the houses either side are not aligned.
            s = CLEAR_OF_JUNCTION + _unit(_hash(way_id, side, 0xB1D5), 2) * BIN_SPACING
            while s < length - CLEAR_OF_JUNCTION:
                h = _hash(way_id, side, int(s * 100.0), 0xB15)
                self.stats["bin_candidates"] += 1
                if _unit(h, 0) < BIN_PUT_OUT_RATE:
                    out.extend(self._place(line, s, offset * side, h, recycling))
                s += BIN_SPACING + (_unit(h, 1) - 0.5) * 2.0 * BIN_SPACING_JITTER
        if out:
            self.stats["bin_ways_collected"] += 1
        return out

    def _place(
        self, line: LineString, s: float, offset: float, h: int, recycling: int
    ) -> list[Bin]:
        """One cluster at `s` along the kerb, shifted along it if something is there.

        The shift is `power._place`'s, minus the argument about chain continuity:
        a cluster that cannot be placed is one household that did not put its
        bins out, which is invisible. It shifts anyway because the queries are
        already paid for and it recovers most of what the pole keep-out costs.

        Every draw that gives the cluster its identity -- how many bins, which
        colours, the yaw jitter -- comes off `h`, which is hashed from the
        *nominal* distance, so a cluster that moves 1.5 m to miss a pole is the
        same cluster rather than a different one.
        """
        nominal = _offset_point(line, s, offset)
        if nominal is None:
            self.stats["drop_junction"] += 1
            return []
        # Hoisted out of the shift loop, and it is the only test that can be:
        # "is there a house behind this footpath" reaches 25 m and cannot change
        # over a 3 m shift, where every other keep-out is about an object a metre
        # away. It is also the most selective test on the list -- most candidates
        # that fail, fail here -- so answering it once and first is what keeps
        # the other three off four fifths of the tertiary network.
        if not self._has_frontage(Point(*nominal)):
            self.stats["drop_frontage"] += 1
            return []

        lids = self._compose(h, recycling)
        # The cluster's own length along the kerb, so the shift and the keep-outs
        # test the whole of it rather than its centre.
        span = (len(lids) - 1) * BIN_PITCH

        reason: str | None = None
        for k, delta in enumerate(SHIFT_STEPS):
            pos = _offset_point(line, s + delta, offset)
            if pos is None:
                continue
            blocked = self._blocked_at(pos[0], pos[1], span)
            if blocked is None:
                if k:
                    self.stats["bin_shifted"] += 1
                self.stats["bin_clusters"] += 1
                self.cluster_sizes[len(lids)] = self.cluster_sizes.get(len(lids), 0) + 1
                return self._emit_cluster(line, s + delta, offset, lids, h)
            if reason is None:
                reason = blocked
        self.stats[reason or "drop_junction"] += 1
        return []

    def _compose(self, h: int, recycling: int) -> list[int]:
        """Which bins are in this cluster, in the order they stand along the kerb.

        Red always, the street's recycling stream usually, the other stream
        occasionally. The order is rotated by the hash rather than fixed, because
        a suburb of clusters all reading red-then-yellow left to right is the
        same tell as a dead-vertical pole.
        """
        lids = [LID_RED]
        if _unit(h, 2) < BIN_RECYCLING_RATE:
            lids.append(recycling)
        if _unit(h, 3) < BIN_BOTH_STREAMS_RATE:
            lids.append(LID_GREEN if recycling == LID_YELLOW else LID_YELLOW)
        rot = int(_unit(h, 4) * len(lids))
        return lids[rot:] + lids[:rot]

    def _emit_cluster(
        self, line: LineString, s: float, offset: float, lids: list[int], h: int
    ) -> list[Bin]:
        """Lay the cluster out along the kerb, centred on `s`."""
        out: list[Bin] = []
        first = -(len(lids) - 1) * 0.5 * BIN_PITCH
        for n, lid in enumerate(lids):
            pos = _offset_point(line, s + first + n * BIN_PITCH, offset)
            if pos is None:
                continue
            east, north = pos
            # The bin faces the road: its depth axis runs across the footpath, so
            # the 0.58 m face is what is seen from the street and the wheels and
            # the lid hinge are at the back against the property. The sign
            # follows the kerb -- a positive offset is left of travel, so the
            # road is a right angle *clockwise* from the way's bearing, and the
            # other kerb is the mirror. Without the sign every bin on one side of
            # every street in the city faces the fence.
            bearing = _street_bearing(line, s + first + n * BIN_PITCH)
            yaw = bearing - math.copysign(math.pi / 2, offset)
            yaw += (_unit(h, 5 + n) - 0.5) * 2.0 * BIN_YAW_JITTER
            out.append(
                Bin(
                    east=east,
                    north=north,
                    ground_y=self._footpath_y(east, north),
                    yaw=yaw,
                    lid=lid,
                )
            )
        return out

    def _blocked_at(self, east: float, north: float, span: float) -> str | None:
        """The first keep-out this cluster fails, or `None` if it is clear.

        `span` is the cluster's length along the kerb; every radius below is
        widened by half of it, so a three-bin cluster is tested as the 1.4 m
        object it is rather than as its centre point.

        Ordered cheapest and most selective first, exactly as
        `power._blocked_at` is. The frontage test is not here at all -- it is
        hoisted into `_place`, because it is the one test a shift cannot change.
        """
        p = Point(east, north)
        half = span * 0.5
        if self._junction_proxies is not None and len(
            self._junction_proxies.query(p.buffer(CLEAR_OF_JUNCTION + half))
        ):
            return "drop_junction"
        reach = CLEAR_OF_POLE + half
        for pole in self._power.poles_near(p.buffer(reach)):
            if (pole.east - east) ** 2 + (pole.north - north) ** 2 < reach * reach:
                return "drop_pole"
        reach = CLEAR_OF_TREE + half
        for t in self._veg.trees_near(p.buffer(reach)):
            if (t.east - east) ** 2 + (t.north - north) ** 2 < reach * reach:
                return "drop_tree"
        reach = CLEAR_OF_BUILDING + half
        for poly in self._streets.buildings_near(p.buffer(reach)):
            if poly.distance(p) < reach:
                return "drop_building"
        return None

    def _has_frontage(self, p: Point) -> bool:
        """Is there a house behind this stretch of footpath?"""
        if self._frontage_tree is None:
            return False
        region = p.buffer(FRONTAGE_REACH)
        for j in self._frontage_tree.query(region):
            if self._frontage[int(j)].distance(p) <= FRONTAGE_REACH:
                return True
        return False

    # --- Junctions ------------------------------------------------------------

    def _build_junctions(self) -> list[_Junction]:
        """Derive every intersection in the extent from the way network.

        Three passes, one per observation in the module docstring: bucket the way
        endpoints to get candidate points, count the *directions* a street leaves
        each in, then merge points that are one intersection.
        """
        s = JUNCTION_SNAP
        buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for i, road in enumerate(self._streets.roads):
            if road.is_foot:
                continue
            coords = list(self._streets.centreline(i).coords)
            if len(coords) < 2:
                continue
            for x, y in (coords[0], coords[-1]):
                buckets.setdefault((round(x / s), round(y / s)), []).append((x, y))

        raw: list[_Junction] = []
        for pts in buckets.values():
            east = sum(p[0] for p in pts) / len(pts)
            north = sum(p[1] for p in pts) / len(pts)
            self.stats["junction_points"] += 1
            legs = self._legs_at(east, north)
            if len(legs) < MIN_LEGS:
                continue
            raw.append(_Junction(east, north, legs))
        self.stats["junctions"] = len(raw)
        return self._merge_junctions(raw)

    def _legs_at(self, east: float, north: float) -> list[tuple[float, int]]:
        """Distinct directions a street leaves this point in, sorted by bearing.

        A way ending here contributes one leg; a way passing *through* -- which
        OSM leaves unsplit often enough to matter -- contributes two. Bearings
        within `LEG_MERGE_DEG` collapse into one leg, keeping the highest-class
        way of the group, so a dual carriageway's two centrelines are one leg and
        the leg is the arterial rather than whichever half came back first.
        """
        p = Point(east, north)
        found: list[tuple[float, int]] = []
        for j in self._streets.ways_near(p.buffer(JUNCTION_REACH)):
            road = self._streets.roads[j]
            if road.is_foot or road.highway not in JUNCTION_LEG_CLASSES:
                continue
            line = self._streets.centreline(j)
            if line.distance(p) > JUNCTION_REACH:
                continue
            s = line.project(p)
            if s < line.length - 1.0:
                q = line.interpolate(min(s + LEG_TANGENT, line.length))
                found.append((math.atan2(q.y - north, q.x - east), j))
            if s > 1.0:
                q = line.interpolate(max(s - LEG_TANGENT, 0.0))
                found.append((math.atan2(q.y - north, q.x - east), j))

        merged: list[tuple[float, int]] = []
        for bearing, j in sorted(found):
            for k, (b0, j0) in enumerate(merged):
                if abs(_wrap(bearing - b0)) < math.radians(LEG_MERGE_DEG):
                    if _class_rank(self._streets.roads[j].highway) > _class_rank(
                        self._streets.roads[j0].highway
                    ):
                        merged[k] = (b0, j)
                    break
            else:
                merged.append((bearing, j))
        merged.sort()
        return merged

    def _merge_junctions(self, raw: list[_Junction]) -> list[_Junction]:
        """Collapse junction points within `JUNCTION_MERGE` into one intersection.

        Single-link, and the survivor is the one with the most legs -- on a
        divided road that is the point where the side street meets the near
        carriageway, which is where the corner actually is.
        """
        if not raw:
            return []
        pts = [Point(j.east, j.north) for j in raw]
        tree = STRtree(pts)
        seen: set[int] = set()
        out: list[_Junction] = []
        for i in range(len(raw)):
            if i in seen:
                continue
            group = [i]
            seen.add(i)
            stack = [i]
            while stack:
                a = stack.pop()
                for h in tree.query(pts[a].buffer(JUNCTION_MERGE)):
                    h = int(h)
                    if h not in seen and pts[h].distance(pts[a]) <= JUNCTION_MERGE:
                        seen.add(h)
                        group.append(h)
                        stack.append(h)
            if len(group) > 1:
                self.stats["junctions_merged"] += len(group) - 1
            best = max(group, key=lambda k: (len(raw[k].legs), raw[k].east, raw[k].north))
            out.append(raw[best])
        return out

    def _attach_signals(
        self, junctions: list[_Junction], nodes: list[osm.OsmPoi]
    ) -> set[int]:
        """Which junctions are signalised, from OSM's own nodes.

        Clustered first, because the tag is mapped per approach -- see
        `osm.read_pois`. Returns indices into `junctions`.
        """
        if not nodes or not junctions:
            return set()
        pts = [Point(n.east, n.north) for n in nodes]
        tree = STRtree(pts)
        seen: set[int] = set()
        centroids: list[tuple[float, float]] = []
        for i in range(len(nodes)):
            if i in seen:
                continue
            group = [i]
            seen.add(i)
            stack = [i]
            while stack:
                a = stack.pop()
                for h in tree.query(pts[a].buffer(SIGNAL_LINK)):
                    h = int(h)
                    if h not in seen and pts[h].distance(pts[a]) <= SIGNAL_LINK:
                        seen.add(h)
                        group.append(h)
                        stack.append(h)
            centroids.append(
                (
                    sum(nodes[k].east for k in group) / len(group),
                    sum(nodes[k].north for k in group) / len(group),
                )
            )
        self.stats["signal_clusters"] = len(centroids)

        jpts = [Point(j.east, j.north) for j in junctions]
        jtree = STRtree(jpts)
        out: set[int] = set()
        for east, north in centroids:
            p = Point(east, north)
            best, best_d = -1, SIGNAL_TO_JUNCTION
            for h in jtree.query(p.buffer(SIGNAL_TO_JUNCTION)):
                d = jpts[int(h)].distance(p)
                if d < best_d:
                    best_d, best = d, int(h)
            if best < 0:
                # A signal with no three-leg junction near it: a mid-block
                # pedestrian crossing, which is real and is different furniture
                # -- two heads facing the approaches and no intersection at all.
                # Counted rather than forced onto the nearest corner.
                self.stats["signal_orphan"] += 1
                continue
            out.add(best)
        self.stats["signal_junctions"] = len(out)
        return out

    def _place_junction_furniture(
        self, junctions: list[_Junction], signalised: set[int]
    ) -> None:
        """Put a name post and, where warranted, signal heads on every junction."""
        for index, j in enumerate(junctions):
            corners = _corners(j, [self._streets.half_width(w) for _, w in j.legs])
            if not corners:
                self.stats["post_no_corner"] += 1
                continue
            self._place_post(j, corners)
            if index in signalised:
                self._place_signals(j, corners)

    def _place_post(self, j: _Junction, corners: list[tuple[float, float]]) -> None:
        """One street-name post, on the north-east-most clear corner.

        See the module docstring for why north-east. Ranked rather than picked,
        so a corner occupied by a building falls through to the next best one
        instead of losing the post -- 22% of inner-city corners have a building
        hard on the property line and a blade post inside a shopfront is worse
        than one on the opposite corner.
        """
        names: list[str] = []
        yaws: list[float] = []
        for bearing, way in j.legs:
            raw = self._streets.roads[way].name
            if not raw:
                continue
            # Deduplicated on the *signed* text rather than on the OSM name, so
            # a corner where OSM has "Botany Road" on one leg and "Botany Rd" on
            # the other -- which happens, because the two halves were digitised
            # by different mappers -- gets one blade and not two identical ones.
            name = self._blade_text(raw)
            if not name or name in names:
                continue
            names.append(name)
            # The blade is parallel to the street it names. The leg bearing is
            # that street's direction, and a blade reads the same either way
            # along it, so no fold is needed.
            yaws.append(bearing)
        if not names:
            self.stats["post_no_name"] += 1
            return
        if len(names) < 2:
            # One name is a way split, a bend, or a street meeting an unnamed
            # lane -- not an intersection of named streets, which is what spec
            # 7.7's blades mark.
            self.stats["post_one_name"] += 1
            return
        if len(names) > MAX_BLADES:
            self.stats["blades_dropped"] += len(names) - MAX_BLADES
            names, yaws = names[:MAX_BLADES], yaws[:MAX_BLADES]

        ranked = sorted(corners, key=lambda c: -(math.cos(c[0]) + math.sin(c[0])))
        for corner in ranked:
            east, north = _corner_point(j, corner, BLADE_CORNER_SETBACK)
            p = Point(east, north)
            clear = True
            for poly in self._streets.buildings_near(p.buffer(0.4)):
                if poly.distance(p) < 0.4:
                    clear = False
                    break
            if not clear:
                continue
            post = NamePost(
                east=east,
                north=north,
                ground_y=self._footpath_y(east, north),
                blade_yaws=yaws,
                names=names,
                # Measured from the *junction* rather than from the corner the
                # post ended up on, so the four corners of one intersection can
                # never disagree about which council they are in.
                style=(
                    STYLE_COS_GREEN
                    if math.hypot(j.east, j.north) <= COS_LGA_RADIUS
                    else STYLE_RMS_WHITE
                ),
            )
            self._posts_by_tile.setdefault(_tile_key_of(east, north), []).append(post)
            return
        self.stats["post_no_corner"] += 1

    def _blade_text(self, name: str) -> str:
        """The legend a blade actually carries, from an OSM `name` tag.

        Three things happen and all three are signage practice rather than data
        hygiene. Whitespace is collapsed, because an OSM name with a double space
        would rasterise with a hole in it. The road type is abbreviated, because
        no blade in Australia is lettered "Sydney Park Road". And the result is
        cut to `MAX_NAME_CHARS`, because the sidecar length-prefixes it with a
        u8 and, long before that matters, because a 900 mm plate runs out.

        The type is not always the last word -- "Alfred Street North" and
        "Macquarie Street Offramp" both bury it -- so trailing modifiers are
        peeled off first and put back after. Without that, every motorway ramp
        in the extent keeps its unabbreviated "Street" or "Freeway" and comes
        out about twice the width of a plate.

        Abbreviation is refused on what is left being a single word, which is
        what keeps Broadway from being signed "Broadwk".
        """
        words = name.split()
        if not words:
            return ""
        # Peel the trailing modifiers, innermost last, so "Street North Offramp"
        # -- which OSM does produce -- gives back both of them in order.
        tail: list[str] = []
        while len(words) > 1:
            short = _NAME_SUFFIX_ABBREV.get(words[-1].lower())
            if short is None:
                break
            tail.insert(0, short)
            words.pop()
        if len(words) > 1:
            short = _ROAD_TYPE_ABBREV.get(words[-1].lower())
            if short is not None:
                words[-1] = short
                self.stats["names_abbreviated"] += 1
        text = " ".join(words + tail)
        if len(text) > MAX_NAME_CHARS:
            text = text[:MAX_NAME_CHARS].rstrip()
            self.stats["names_truncated"] += 1
        return text

    def _place_signals(self, j: _Junction, corners: list[tuple[float, float]]) -> None:
        """A three-lamp head at each corner, facing inward, phased in pairs.

        The phase is the whole of the module docstring's argument about not
        rolling a die per head: the reference axis is the junction's
        highest-class leg, a head shows green when the approach it serves lies on
        that axis, and red when it crosses it.
        """
        reference = max(j.legs, key=lambda leg: _class_rank(self._streets.roads[leg[1]].highway))[0]
        h = _hash(int(j.east * 100), int(j.north * 100), 0x516)
        green = LAMP_AMBER if _unit(h, 0) < AMBER_RATE else LAMP_GREEN

        for corner in corners[:MAX_SIGNAL_HEADS]:
            bearing = corner[0]
            east, north = _corner_point(j, corner, SIGNAL_CORNER_SETBACK)
            # The approach this far-side head serves: the leg most nearly
            # opposite the corner it stands on.
            approach = min(
                j.legs, key=lambda leg: abs(_wrap(leg[0] - (bearing + math.pi)))
            )[0]
            # Folded to a line, because a street's two halves leave the junction
            # 180 degrees apart and are one street on one phase.
            off_axis = abs(_wrap(2.0 * (approach - reference))) * 0.5
            lit = green if off_axis <= math.radians(PHASE_HALF_ANGLE) else LAMP_RED
            signal = Signal(
                east=east,
                north=north,
                ground_y=self._footpath_y(east, north),
                # Inward: the head looks back at the middle of the intersection.
                yaw=bearing + math.pi,
                lit=lit,
            )
            self._signals_by_tile.setdefault(_tile_key_of(east, north), []).append(signal)

    # --- Ground ---------------------------------------------------------------

    def _footpath_y(self, east: float, north: float) -> float:
        """Absolute y of the paved surface these things stand on.

        `streets.FOOTPATH_Y` above the terrain, not the terrain itself, and that
        is the one place this differs from `power.Pole.ground_y`. A pole is set
        in a hole and its butt is genuinely below the paving; a bin, a post and a
        signal all stand *on* the footpath, and 15 cm is exactly enough to be
        seen -- a bin sunk to its axle reads as rubbish rather than as a bin.
        """
        ground = 0.0 if self._terrain is None else float(self._terrain.sample(east, north))
        return ground + streets.FOOTPATH_Y


# --- Helpers ------------------------------------------------------------------

# Road classes in ascending order of importance, for picking which way a merged
# leg is named after and which leg sets a signalised junction's phase axis.
_CLASS_ORDER = (
    "service",
    "living_street",
    "unclassified",
    "residential",
    "tertiary_link",
    "tertiary",
    "secondary_link",
    "secondary",
    "primary_link",
    "primary",
    "trunk_link",
    "trunk",
    "motorway_link",
    "motorway",
)


def _class_rank(highway: str) -> int:
    try:
        return _CLASS_ORDER.index(highway)
    except ValueError:
        return -1


def _wrap(angle: float) -> float:
    """An angle folded into (-pi, pi]."""
    return math.atan2(math.sin(angle), math.cos(angle))


def _corners(j: _Junction, half_widths: list[float]) -> list[tuple[float, float]]:
    """The footpath corners of one junction, as (outward bearing, kerb distance).

    A corner is the wedge between two angularly adjacent legs. It lies on the
    bisector, at the distance where the bisector clears the wider of the two
    carriageways and its kerb: the perpendicular distance from a point `d` along
    a bisector to a leg at half-angle `a` is `d * sin(a)`, so `d = (half_width +
    KERB_WIDTH) / sin(a)`.

    The exact answer is the intersection of the two offset kerb lines, which
    differs from this whenever the two half-widths differ. The bisector errs
    *outward* -- further onto the footpath -- which is the safe direction: a
    blade post a little deeper into the footpath is a blade post, and one a
    little short of the kerb line is standing in the road.

    The setback is *not* included, because the same corner carries a blade post
    at 1.5 m back from it and a signal head at 0.55 m; see `_corner_point`.

    Returned sorted by bearing, so consecutive corners are adjacent around the
    intersection -- which is what makes a signalised crossroads' diagonal pairs
    land on the same phase.
    """
    legs = j.legs
    n = len(legs)
    out: list[tuple[float, float]] = []
    for k in range(n):
        b0 = legs[k][0]
        b1 = legs[(k + 1) % n][0]
        sweep = _wrap(b1 - b0)
        if sweep <= 0.0:
            sweep += 2.0 * math.pi
        # Clamped, because `1 / sin(a)` runs away on an acute fork and would put
        # the post twenty metres down the street it is supposed to name.
        half_angle = max(sweep * 0.5, math.radians(MIN_CORNER_HALF_ANGLE))
        widest = max(half_widths[k], half_widths[(k + 1) % n])
        out.append((b0 + sweep * 0.5, (widest + streets.KERB_WIDTH) / math.sin(half_angle)))
    return out


def _corner_point(
    j: _Junction, corner: tuple[float, float], setback: float
) -> tuple[float, float]:
    """One corner, `setback` metres back from the kerb line along its bisector."""
    bearing, base = corner
    d = min(base + setback, MAX_CORNER_DISTANCE)
    return (j.east + math.cos(bearing) * d, j.north + math.sin(bearing) * d)


def _street_bearing(line: LineString, s: float) -> float:
    """The direction of travel along `line` at distance `s`, radians in ENU."""
    a = line.interpolate(max(s - 0.5, 0.0))
    b = line.interpolate(min(s + 0.5, line.length))
    return math.atan2(b.y - a.y, b.x - a.x)


def _tile_key_of(east: float, north: float) -> str:
    s = config.TILE_SIZE
    return f"{math.floor(east / s)}_{math.floor(north / s)}"


def load_signal_nodes(radius_m: float) -> list[osm.OsmPoi]:
    """Every surveyed `highway=traffic_signals` node in the extent.

    `osm.read_pois` extracts them, so this is a filter and not a new source --
    the same shape as `power.load_mapped_poles`. Note that these are per
    *approach*, not per intersection; `FurnitureNetwork` clusters them.
    """
    return [p for p in osm.read_pois(radius_m) if p.kind == "traffic_signals"]
