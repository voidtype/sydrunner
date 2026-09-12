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

Since 2026-09-10 the clamp inside the first half is **one-sided where the sign
of the error is known**, which is the `--- The sign of the error ---` block and
RAIL-VERTICAL.md section 3e. In one sentence: the projection used to average a
downward answer with an upward one, that average handed 59% of every metre
`shoreline.py` took off the foreshore straight back to it through a tie chain,
and the average is only right when nobody knows which way the error goes.

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

# --- The sign of the error ----------------------------------------------------
#
# **`_lipschitz` used to average a downward projection with an upward one, and
# the docstring's own justification -- "both legal answers and the truth is
# between them" -- is a statement about an error of unknown sign. This error has
# a sign.** `OPENING_M`'s note two hundred lines above says it in five words,
# *contamination is always upward*; so does `bareearth.BUILT_COEFF`'s; so does
# `shoreline.py`'s `np.minimum(natural, ...)`, which is a pass that may lower the
# ground and may never raise it.
#
# What the average cost was measured by the round that built `shoreline.py`, at
# the one place the truth is written down. The shore pass takes **11.48 m** off
# the Quay promenade and the build kept **5.63** -- median kept/written 0.41
# over every station on dry land it wrote more than a metre to. The mechanism is
# exactly the average: the shore comes down eleven metres, the CBD three hundred
# metres away stays at fifty, the `CROSS_GRADE` tie chain between them is
# violated, `low` pulls the CBD down, `high` pulls the shore back up, and the
# average splits an error that is **entirely the CBD's** evenly between the two.
# The solved street nearest east 140 north 820 went 31.31 -> 25.63 m AHD and
# ended up standing twenty metres above its own ground. RAIL-VERTICAL.md section
# 3d records all of it and names the fix as this module's.
#
# **The fix is not a global switch to the downward projection.** `low` alone is
# `TIE_RADIUS_M`'s table read at a cap of zero: it shaves every real crest twice,
# because a genuine Sydney ridge tied to a street in the valley is a violation
# too and the downward answer is to cut the ridge. The average is *right* on a
# sandstone headland, where nobody knows which side the error is on. So the
# operator is one-sided **per post**, and the thing that decides is not a
# classification but the measurement the passes before it already made:
#
#     lambda = 0.5 + 0.5 * confidence          confidence in [0, 1]
#     h      = relax_down( lambda * low + (1 - lambda) * high )
#
# with `confidence = 0` giving back the old average exactly and `confidence = 1`
# giving the downward answer at that post. **The final downward relax is what
# does the work and it is the whole trick.** A mixture taken post by post is not
# feasible -- a node that took `low` beside one that took `high` can be further
# apart than the budget allows -- so it is projected once more, downward, onto
# the constraint set. That projection can only lower, so a post whose height is
# already known pulls its neighbours **down along the grade limit** instead of
# being pulled up to meet them, which is the sentence this whole block exists to
# make true. It also means the confidence only has to be right at the post that
# knows something: the contaminated neighbour needs no opinion of its own, it is
# brought down by feasibility.
#
# Two properties fall out and both are asserted by `roadgrade-sign-check.py`:
#
#   * `low <= new <= old`, post by post. The one-sided answer is sandwiched
#     between the fully downward projection and the average this replaces, so
#     **nothing anywhere in the city is ever raised by this change** and the
#     worst case is the global switch the evidence declined to take.
#   * with no evidence anywhere the result is the old average **bit for bit**,
#     by an early return rather than by an argument about floating point. That
#     is `Terrain.load(one_sided=False)`, and it is a named flag in
#     `terraincache`'s key rather than a monkeypatch, for the reason
#     RAIL-VERTICAL.md section 3c gives about the other five.
#
# **What it buys, on the 5.3 km ring**, every pass on, against the symmetric
# projection this replaces. `roadgrade-sign-check.py` prints all of it:
#
#     the Quay promenade (E140 N820)   26.42 -> 15.18 m AHD   (~2.5 in life)
#     Circular Quay's station node     30.56 -> 20.36
#     median kept / written             0.41 -> 1.13
#     posts the road pass raised            0, largest rise 0.000000 m
#     profile grade p95 / max          7.97% -> 8.63% / 15.000% -> 15.000%
#     `road-grade-audit` over 15%      0.026% -> 0.017% of carriageway segments
#     the Kings Cross escarpment's relief  40.14 -> 40.07 m
#     five inland controls, 0.9 to 3.2 km from water    +0.0000 every one
#     past 1 km from tidal water       61 posts moved, the deepest by 0.054 m
#
# The last three lines are the ones that say this is not a global switch wearing
# a per-post disguise. The `road-grade-audit` line is the gate section 3d named
# and it comes out *better*, which it should: a street that has been allowed to
# fall to its own shore is a street the lattice has less trouble holding.
#
# --- What counts as evidence, and how much ------------------------------------
#
# Three things are known before the solve reads its first profile, and the two
# that survived are the two that are measurements rather than labels.
#
# **(1) Metres an earlier pass already took off this post.** `Terrain.load`
# snapshots the lattice before `bareearth` and diffs it after `shoreline`, so
# this is every early pass's write at once and a sixth pass would join it for
# free. It is the strongest signal there is: a post the shore rule pulled down
# eleven metres is a post whose height came from a *rule* and not from the DSM,
# and handing half of it back to a tie chain is the defect this block is about.
#
# **(2) The deconvolution's own `built_drop`**, which is `bareearth`'s estimator
# -- *how much building is the DSM looking at here*, per post, continuous,
# metres. `shoreline.conform` rasterises it over its band and reports it here
# rather than anyone computing it twice; where nobody has rasterised it, it is
# zero and says nothing. It earns its place over (1) at the posts where the shore
# rule agreed the ground was built on and then found nothing to correct, which
# are trusted-low and carry a zero write.
#
# **(3) Water adjacency, which is *not* independent evidence and does not get a
# term.** The tempting rule -- a post at the waterline is low, because the sea is
# at zero -- is false in this extent: North Head, the Gap and Dover Heights are
# eighty-metre cliffs standing at a mapped tidal waterline, and `shoreline.py`'s
# built-mass floor exists precisely because a pull toward the water flattens real
# rock. So the shore weight enters as a **shape on (2)** and not as a term of its
# own: near the water, where the correction a shore rule is allowed to make is
# largest, the built mass is believed most, and the belief goes to zero at the
# same reach the shore rule's own weight does. That is what keeps this operator
# from putting a step at 250 m that `shoreline.py` went to some trouble not to.
#
# The two constants are the metres at which each measurement is believed
# completely. Both are ramps from zero rather than thresholds, for rule 1 of
# RAIL-VERTICAL.md: a threshold is a classification wearing a number.
#
# **And the first thing the sweep says is that neither of them is a tuning
# knob.** Every row below is a full 5.3 km solve; the columns are the Quay
# transect (`shoreline-check.py`'s three named stations), the Kings Cross ridge
# over Woolloomooloo -- which is `TIE_RADIUS_M`'s own watch-point, and the
# `relief` between them is the landform a downward projection would flatten --
# Town Hall, and how many of the 137,780 solved nodes the one-sidedness lowered.
# Nothing in the sweep put a single edge over `MAX_GRADE`.
#
#  corrected  built |  N860   N820   N780 | ridge valley relief | Town Hall | lowered
#        off    off | 12.16  26.42  28.27 | 46.91   6.77  40.14 |     69.62 |       0
#        4.0     12 |  7.09  15.18  16.65 | 46.20   5.64  40.56 |     68.48 |  15,186
#        2.0     12 |  7.09  15.18  16.65 | 45.93   5.11  40.83 |     68.48 |  16,377
#  >     1.5     12 |  7.09  15.18  16.65 | 45.16   5.10  40.07 |     68.48 |  17,004
#        1.0     12 |  7.09  15.18  16.65 | 45.15   5.10  40.05 |     68.48 |  17,465
#        0.5     12 |  7.09  15.18  16.65 | 45.11   5.10  40.01 |     68.48 |  17,898
#        1.5    off |  7.09  15.18  16.65 | 45.16   5.10  40.07 |     68.48 |  16,994
#        off     12 |  8.32  17.74  19.29 | 46.91   6.48  40.42 |     69.62 |  13,352
#
# **The Quay column does not move at all across a factor of eight**, and neither
# does Town Hall, and the escarpment's relief stays inside 0.8 m of where it
# started on every row including the ones this operator is not on. What decides
# the answer is that a post has *some* confidence, not how fast the confidence
# saturates -- which is what you would expect of an operator whose work is done
# by a downward relax that either binds or does not. So these two numbers are
# chosen to mean something rather than to buy something, and if that ever stops
# being true this table is where it will show.
#
# `SIGN_CORRECTED_M` is **1.5 m**: the metres of correction at which an earlier
# pass's write stops being the tail of its own feather. The shore pass's write is
# p50 0.30 and p95 4.31 m over this ring, so 1.5 puts the median post it touched
# at 20% -- believed a little -- and everything past about p80 at full. The rows
# either side of it are the two things a wrong answer would look like and neither
# happens: at 0.5 the extra 900 nodes buy 0.05 m of anything, and at 4.0 the
# 1,800 nodes given up buy 0.5 m of ridge that the relief column says was never
# in danger.
#
# `SIGN_BUILT_M` is **12.0 m**, and it is `bareearth.py`'s calibration row read
# as a confidence rather than as a correction: Town Hall's built mass is 16.17 m
# and Chatswood's 12.73, both places the DSM is unarguably reading a roof, and
# Centennial Park's is **1.21 m** -- the negative control, which that module's
# header calls "the neighbouring streets bleeding in through the Gaussian's own
# tail". At 12 m the control lands at confidence 0.10, a five per cent shift
# toward the downward answer on ground with no building on it, and section 5 of
# the check measures what that is worth at Centennial Park: **zero to the
# millimetre**, because the park is 971 m from mapped water and no chain of ties
# at `CROSS_GRADE` over `TIE_RADIUS_M` reaches it from anything that moved.
#
# **The built term is doing almost nothing today and that is stated rather than
# hidden.** The `1.5 / off` row is the whole operator with it switched off and it
# is identical to `1.5 / 12` in every column, 16,994 nodes against 17,004 -- ten.
# It is subsumed, not redundant, and the two rows that show the difference are
# `off / 12`, where the built mass on its own is a working signal that takes the
# Quay from 26.42 to 17.74 and lowers 13,352 nodes with no help from anyone's
# write; and the day the city-wide deconvolution `terrain.py` has been asking for
# since it was written finally lands, when `built` will be the only one of the
# two that is nonzero in the middle of the CBD. Varying it 6 / 12 / 24 changes
# nothing at all while `corrected` is on, which is the same sentence again.
SIGN_CORRECTED_M = 1.5
SIGN_BUILT_M = 12.0

# --- The bound on the projection ----------------------------------------------
#
# **The block above is right about the sign and silent about the size, and the
# silence is what the round-three world was billed for.** `relax_down` is a
# fixpoint of `h_i <- min(h_i, h_j + limit)` and nothing in it remembers where a
# violation came from: a post the shore rule pulled down eleven metres is
# believed, and then every post tied to it is pulled to the grade limit, and then
# every post tied to *those*, out to `MAX_SWEEPS` -- four kilometres of road --
# with no term anywhere that says how much evidence is being spent. The sentence
# the block above exists to make true, *a post whose height is already known
# pulls its neighbours down along the grade limit*, is missing its second half:
# **by how much.**
#
# What it cost, measured on the round-three 60 km world against round two:
# 11,095 terrain tiles differ and the deepest drops are not the harbour at all.
#
#   Coledale / Scarborough, the Illawarra coast     up to 27.1 m, 200+ posts/tile
#   Manly                                                     18.6 m
#   Kirribilli                                                14.2 m
#   Brooklyn and the Hawkesbury villages                     8 - 10 m
#   Penrith on the Nepean                                      8.7 m
#   Cronulla                                                   6.8 m
#
# Every one of them is the same shape: a village on a headland or an escarpment,
# a corrected waterline a hundred metres below it, and a tie chain between the
# two. The Illawarra ones are the proof that this is a defect and not a strong
# opinion -- Coledale sits on the escarpment above the sea with **no towers in
# it**, so the DSM there is reading real ground and `bareearth`'s own estimator
# says so, and the projection took eighteen metres off the median post of a tile
# anyway. The CBD's twenty metres and the Quay's ten are the intended result and
# always were; what separates them from Coledale is not distance from water, it
# is whether anybody measured anything that would pay for the drop.
#
# **So the operator gains the term it was missing: a budget, in metres.**
#
#     budget_i  = BOUND_TOL_M + max( built_i , max_j ( metres_j - BOUND_DECAY * d_ij ) )
#     floor_i   = sym_i - budget_i
#     out       = relax_down( max( mixture , relax_up( min(floor, h) ) ) )
#
# In words, and it is the brief read back: *a trusted post may pull a neighbour
# down by no more than the evidence it carries -- its own correction, decaying
# along the run, or the neighbour's own built mass -- and never past that below
# the answer the symmetric projection would have given.*
#
# **The floor is relative to `sym` and that is the one design decision here.**
# An absolute floor -- "never below this post's bare-earth estimate" -- is the
# tempting form and it is wrong, because a road is allowed to cut into a hill:
# the grade clamp takes a crest down by whatever 15% costs it and that is a
# cutting, not an error. `sym` is the answer this module gave before it learned
# about signs, so a floor at `sym - budget` binds on **exactly** the thing this
# budget is about -- how far the one-sidedness took a node past where the
# even-handed operator would have left it -- and is inert everywhere else. On a
# steep street inland with no evidence within reach the budget is `BOUND_TOL_M`,
# the answer is `sym` already, and the floor never touches it.
#
# **Three properties, and the third is why nothing above this line changes.**
#
#   * `low <= out <= sym`, node by node, **still**. `floor <= sym - BOUND_TOL_M`
#     and `sym` is feasible, so `relax_up(min(floor, h)) <= relax_up(sym) = sym`;
#     the mixture is already `<= sym`; and a downward relax of something `<= sym`
#     is `<= sym`. So `roadgrade-sign-check.py`'s gate is untouched and §3e's
#     headline -- *nothing in Sydney is ever raised by this change* -- still
#     holds word for word. The bound spends the one-sidedness back toward the
#     average and can never spend past it.
#   * `out` obeys every budget exactly. `relax_up(min(floor, h))` is feasible by
#     construction and `<=` the mixture's own relax input, so the final downward
#     relax is a projection of a feasible-bounded field and the fixpoint is
#     reached the same way it always was.
#   * with no evidence anywhere it is the symmetric answer bit for bit, by the
#     same early return, because a budget with nothing in it is not consulted.
#
# **`min(floor, h)` is not a detail.** A floor may stop a node falling; it may
# never lift one. Clamping the floor to the node's own height before the upward
# relax is what makes that true, and it is also what makes `out <= high` provable
# without an argument about which stage of the solve `h` is.
#
# --- The two constants --------------------------------------------------------
#
# **These two are knobs, and saying so is the point.** `SIGN_CORRECTED_M`'s sweep
# one screen above found that its constants were not -- the Quay did not move
# across a factor of eight -- because that operator's work is done by a relax
# that either binds or does not. This one is different and the sweep says so in
# the first two rows it prints. Every row below is a full 5.3 km solve, one-sided,
# shore on. The columns are the Quay transect at N820 and Circular Quay's station
# ground -- the two numbers §3e bought and this block may not give back --
# Kirribilli, which is the one instance of the regression inside this ring, Town
# Hall, the Kings Cross pair, and how many nodes the floor bound directly. The
# `off` row is `BOUND_TOL_M` at a billion, which is this operator switched off,
# and it reproduces §3e's published column exactly.
#
#  decay  tol |  N820  Quay stn | Kirribilli | Town Hall | ridge  'Loo | bound
#   0.05  off | 15.18     20.36 |     65.18  |     68.48 | 45.16  5.10 |     0
# >  0.05 2.0 | 15.36     20.63 |     74.29  |     69.62 | 46.72  5.13 |   401
#   0.05  1.0 | 15.95     21.02 |     74.66  |     69.62 | 46.87  5.18 | 1,087
#   0.05  4.0 | 15.18     20.36 |     72.29  |     69.61 | 46.33  5.10 |    20
#   0.02  2.0 | 15.18     20.36 |     69.21  |     69.12 | 45.81  5.10 |     0
#   0.10  2.0 | 22.64     26.10 |     74.29  |     69.62 | 46.72  5.14 |   690
#
#             the symmetric answer, for reference, is 26.42 / 30.56 / 74.47 /
#             69.62 / 46.91 / 6.77.
#
# **`BOUND_DECAY` is 0.05 metres of budget per metre of run, and the two rows
# either side of it are the two ways to be wrong.** At **0.10** the budget dies
# in half the distance and the Quay goes back to 22.64 -- the bound has started
# eating the correction it was supposed to protect, because the CBD ground that
# depends on the shore's evidence is further from it than the evidence now
# travels. At **0.02** the budget reaches 575 m, further than anything in this
# pipeline has measured anything, and Kirribilli only comes back to 69.21 of the
# 74.47 it should. The right answer is fixed by the one distance that is already
# a constant here: an 11.5 m correction -- the shore pass's write at the Quay --
# carries **230 m at 0.05**, which is `SHORE_REACH_M`. *Evidence reaches exactly
# as far past the band as the band is wide.* It is also `OPENING_M`'s note on how
# wide DSM contamination actually is, *"a tower's footprint in a 60 m-smoothed
# DEM is 150-250 m across"*, read as a distance instead of as a filter length.
#
# `BOUND_TOL_M` is **2.0 m**: what a node may lose with no evidence at all, which
# is the slack between the smoothed profile the floor is built on and the
# projection that is about to move it. `solve`'s own `drop_p95` on the 60 km
# world is 1.95 m and `conform`'s `moved_p95` is the same order, so two metres is
# this module's own noise floor rather than a number chosen to buy a result. The
# rows either side cost what a tolerance costs and nothing surprising: **4.0**
# leaves the Quay untouched to the centimetre and gives up two metres of
# Kirribilli, **1.0** takes the last half-metre of Kirribilli and costs the Quay
# 0.77 m. The middle row's cost at the Quay is **0.18 m on an eleven-metre
# correction**, which is the trade this constant exists to make.
#
# **And the Kings Cross escarpment gets safer, not more dangerous.** The relief
# between the ridge and the Woolloomooloo floor is 40.14 m symmetric and 40.06
# unbounded; bounded it is **41.59**, because Woolloomooloo is inside the shore
# band and keeps its evidence while the ridge above it stops paying for a
# correction nobody measured up there. A bound whose whole job is to stop the
# projection flattening landform should move that number the way this one does.
BOUND_DECAY = 0.05
BOUND_TOL_M = 2.0


class GroundEvidence:
    """How well the ground under each lattice post is already known, 0 to 1.

    One float32 array on the lattice's own grid, accumulated by `Terrain.load`
    and the passes that run before the solve, read once per station by `solve`
    and dropped. It is deliberately **not** kept on `Terrain`: it is an input to
    one solve and not a property of the ground, and `terraincache` pickles that
    object.

    Each contributor calls one method and the array takes the **maximum**,
    because the three views are three views of one fact and evidence at one of
    them is evidence. Nothing here subtracts confidence: a pass that knows
    nothing about a post writes nothing to it.

    **Three arrays and not one, since `--- The bound on the projection ---`.**
    The confidence says which way the error goes and is what `lambda` is built
    from; the other two are the same measurements kept in **metres**, because a
    budget is a size and a confidence has thrown the size away. Nothing new is
    computed for them -- they are the arguments these methods were already being
    handed, stored instead of normalised and dropped:

      * `m`, metres of downward evidence at this post -- the strongest of what an
        earlier pass took off it and what the deconvolution says is standing on
        it, weighted by the shore's own reach exactly as the confidence is. This
        is what a chain spends as it travels.
      * `b`, the deconvolution's built mass **unweighted**, which is this post's
        own answer to "how far below what the DSM says could the ground be". It
        is not shore-weighted because it is not being read as a belief about the
        sign here, it is being read as a number of metres of building.
    """

    def __init__(self, shape: tuple[int, int], p0: int, q0: int, spacing: float) -> None:
        self.w = np.zeros(shape, dtype=np.float32)
        self.m = np.zeros(shape, dtype=np.float32)
        self.b = np.zeros(shape, dtype=np.float32)
        self.p0 = p0
        self.q0 = q0
        self.spacing = spacing

    def corrected(self, metres: np.ndarray) -> None:
        """Metres an earlier pass already took off each post. See (1) above."""
        raw = np.asarray(metres, dtype=np.float32).reshape(self.w.shape)
        term = np.clip(raw / np.float32(SIGN_CORRECTED_M), 0.0, 1.0)
        np.maximum(self.w, term, out=self.w)
        np.maximum(self.m, np.maximum(raw, np.float32(0.0)), out=self.m)

    def built(self, where: np.ndarray, metres: np.ndarray, shore_weight: np.ndarray) -> None:
        """`bareearth`'s deconvolution at a subset of posts. See (2) and (3).

        `where` is a flat boolean mask over the lattice and the two arrays are
        that mask's population, in its order -- which is the shape
        `shoreline.conform` already has its band in, so nothing is re-derived to
        report it.
        """
        # float32 throughout and one temporary at a time: at 60 km the band is
        # eight million posts, so a float64 intermediate per line would be the
        # difference between this pass fitting in the head's budget and not.
        bd = np.clip(np.asarray(metres, dtype=np.float32), np.float32(0.0), None)
        w = np.asarray(shore_weight, dtype=np.float32)
        idx = np.flatnonzero(np.asarray(where).reshape(-1))
        flat = self.b.reshape(-1)
        flat[idx] = np.maximum(flat[idx], bd)
        term = np.clip(bd / np.float32(SIGN_BUILT_M), np.float32(0.0), np.float32(1.0))
        term *= w
        flat = self.w.reshape(-1)
        flat[idx] = np.maximum(flat[idx], term)
        term = bd
        term *= w
        flat = self.m.reshape(-1)
        flat[idx] = np.maximum(flat[idx], term)

    def at(self, east, north) -> np.ndarray:
        """The confidence at arbitrary ENU points, bilinear off the post grid.

        The same interpolation `Terrain.sample` uses, for the obvious reason: a
        station reads its confidence from the same four posts it reads its
        ground from, so the two cannot disagree about which cell it is in.
        """
        return np.clip(self._sample(self.w, east, north), 0.0, 1.0)

    def metres_at(self, east, north) -> np.ndarray:
        """Metres of downward evidence at arbitrary ENU points. See `m`."""
        return np.clip(self._sample(self.m, east, north), 0.0, None)

    def built_at(self, east, north) -> np.ndarray:
        """The deconvolved built mass at arbitrary ENU points. See `b`."""
        return np.clip(self._sample(self.b, east, north), 0.0, None)

    def _sample(self, grid: np.ndarray, east, north) -> np.ndarray:
        from .terrain import _bilinear

        x = np.asarray(east, dtype=np.float64) / self.spacing - self.p0
        y = np.asarray(north, dtype=np.float64) / self.spacing - self.q0
        return np.asarray(_bilinear(grid, x, y), dtype=np.float64)

    @property
    def any(self) -> bool:
        return bool((self.w > 0.0).any())

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


def solve(
    sample,
    radius_m: float,
    roads: list[osm.OsmRoad] | None = None,
    evidence: GroundEvidence | None = None,
) -> RoadSurface:
    """Solve one elevation profile for every street in the extent.

    `sample(east, north)` is the natural ground -- `Terrain.sample` against the
    unconformed lattice. Passed in rather than imported so this module never
    depends on the thing that is about to consume it.

    `evidence` is what the passes that ran before this one know about the sign
    of the DSM's error, post by post; `None` restores the symmetric projection
    exactly. See the `--- The sign of the error ---` block.
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
    # One confidence per node, the strongest of its arms': a junction where one
    # street runs down to a corrected shore and the other comes off the
    # contaminated plateau is a junction that knows something, and the arm that
    # knows it is the one to believe. Zero everywhere when no pass ran before
    # this one, which is the `None` that gives the old operator back.
    station_conf = (
        np.zeros(len(pts)) if evidence is None else evidence.at(pts[:, 0], pts[:, 1])
    )
    node_conf = np.zeros(n_nodes)
    np.maximum.at(node_conf, node_of, station_conf)
    # The same measurements again, in metres this time, because a budget is a
    # size and `node_conf` has thrown the size away. See `--- The bound on the
    # projection ---`. A junction takes the strongest of its arms' for the reason
    # the confidence does: the arm that knows something is the one to believe.
    node_m = np.zeros(n_nodes)
    node_b = np.zeros(n_nodes)
    if evidence is not None:
        np.maximum.at(node_m, node_of, evidence.metres_at(pts[:, 0], pts[:, 1]))
        np.maximum.at(node_b, node_of, evidence.built_at(pts[:, 0], pts[:, 1]))

    smoothed = _smooth(obs, edges, edge_len)
    ties, tie_len = _ties(pts, way_of, node_of, n_nodes)
    both = np.vstack((edges, ties))
    both_len = np.concatenate((edge_len, tie_len))
    soft_limit = np.concatenate((TARGET_GRADE * edge_len, CROSS_GRADE * tie_len))
    hard_limit = np.concatenate((MAX_GRADE * edge_len, CROSS_GRADE * tie_len))
    # The budget travels the same graph the pull does -- road edges and plan ties
    # together -- because a pull that reaches through a tie is a pull that has to
    # pay through one. `None` when no pass ran before this one, which is the same
    # `None` that gives the old symmetric operator back.
    budget = None
    if evidence is not None:
        budget = BOUND_TOL_M + _allowance(node_m, both, both_len, node_b)
    # The soft pull is one-sided too, and has to be: it is a partial step toward
    # the 10% set and a step that splits the error evenly is exactly the thing
    # the hard projection below would then have to undo. It is bounded too, and
    # for the same reason -- 70% of an unbounded step is still unbounded.
    bound: dict = {}
    h = smoothed + SOFT_PULL * (
        _lipschitz(smoothed, both, soft_limit, node_conf, budget, bound) - smoothed
    )
    h_sym, h = _projections(h, both, hard_limit, node_conf, budget, bound)

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
        # What the one-sidedness was worth, node by node, against the symmetric
        # answer this replaces. Never negative -- `_projections` guarantees
        # `out <= sym` -- so a positive maximum here is the whole of the change
        # and a zero one means the evidence never reached a node that mattered.
        # `0 lowered` is `A zero counter means untested`, not a clean bill.
        sign_nodes=int((node_conf > 0.0).sum()),
        sign_trusted=int((node_conf >= 0.5).sum()),
        sign_lowered=int((h_sym - h > 1e-9).sum()),
        sign_p95=float(np.percentile(h_sym - h, 95)),
        sign_max=float((h_sym - h).max()),
        # What the budget was worth -- **a count of causes, not of consequences,**
        # and the distinction is the same one the block above makes about
        # confidence. The floor binds at the handful of nodes that have something
        # to say, and the final downward relax then carries the lift along the
        # chain exactly as it carries the pull: 401 nodes bound on the 5.3 km
        # ring and Kirribilli, which is not one of them, came back 9.11 m.
        # `0 bound` is `A zero counter means untested`, not a clean bill.
        bound_budget_p50=float(np.percentile(budget, 50)) if budget is not None else 0.0,
        bound_budget_p95=float(np.percentile(budget, 95)) if budget is not None else 0.0,
        bound_nodes=int(bound.get("held", 0)),
        bound_p95=float(bound.get("held_p95", 0.0)),
        bound_max=float(bound.get("held_max", 0.0)),
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


def _allowance(
    metres: np.ndarray, edges: np.ndarray, length: np.ndarray, own: np.ndarray
) -> np.ndarray:
    """How many metres of downward pull the evidence justifies at each node.

    `metres` is what each node measured itself -- a correction an earlier pass
    wrote, or the built mass standing on it -- and `own` is the node's own
    deconvolved built mass, which needs no chain because it is already about
    this node. The chain is a max-plus relaxation on the same graph the budgets
    run on, spending `BOUND_DECAY` metres of allowance per metre travelled:

        a_i = max( own_i , max_j ( metres_j - BOUND_DECAY * d_ij ) )

    which is a shortest-path problem read upside down, and the same sweep as
    `_projections.relax` for the same reason -- a violation propagates one edge
    a sweep, the fixpoint does not depend on the order the edges are taken in,
    and `MAX_SWEEPS` is the longest shadow either of them may cast.
    """
    a = np.maximum(np.asarray(metres, dtype=np.float64), 0.0)
    i, j = edges[:, 0], edges[:, 1]
    cost = BOUND_DECAY * np.asarray(length, dtype=np.float64)
    for _ in range(MAX_SWEEPS):
        before = a.sum()
        np.maximum.at(a, j, a[i] - cost)
        np.maximum.at(a, i, a[j] - cost)
        if a.sum() == before:
            break
    return np.maximum(a, np.maximum(np.asarray(own, dtype=np.float64), 0.0))


def _projections(
    h: np.ndarray,
    edges: np.ndarray,
    limit: np.ndarray,
    prefer_low: np.ndarray | None,
    budget: np.ndarray | None = None,
    report: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """(the symmetric answer, the one-sided one) for one budget.

    `low` relaxes `h_i <- min(h_i, h_j + limit)` to a fixpoint, which is the
    largest function obeying every budget that lies *below* h; `high` does the
    mirror image and is the smallest one above. Both obey the budgets, so their
    average does too -- the constraint set is convex -- and averaging is what
    keeps a clamped crest from being shaved twice: cutting a spike down (low)
    and filling the valleys either side of it up (high) are both legal answers
    **when the truth is between them.**

    `prefer_low` is a per-node confidence in [0, 1] that it is not: that the
    error at this node is known to be upward, or that its height was written by
    a rule rather than read off a surface model. It slides the mixture from the
    average toward `low`, and the mixture is then projected down once more,
    because a mixture taken node by node is not itself feasible. The **`--- The
    sign of the error ---` block above is the argument** and it is not repeated
    here; what belongs here is the arithmetic:

        lambda = 0.5 + 0.5 * confidence
        out    = relax( lambda * low + (1 - lambda) * high , down )

    With no confidence anywhere the mixture *is* the average, which is already
    feasible, so the extra relax would be a no-op -- and it is skipped rather
    than trusted to be one, so the old behaviour is returned bit for bit and the
    check can assert that instead of arguing about ulps.

    `budget` is how many metres below `sym` each node may be taken, which is the
    size the arithmetic above has no term for -- `--- The bound on the
    projection ---` is the argument and the shape is one more relax:

        floor = sym - budget
        out   = relax( max( mixture , relax( min(floor, h) , up ) ) , down )

    `min(floor, h)` because a floor may stop a node falling and may never lift
    one; the upward relax because a floor taken node by node is no more feasible
    than a mixture is, and the smallest feasible field above it is what a
    neighbour actually owes.

    `low <= out <= sym`, node by node, with or without a budget: `out` is a relax
    of something pointwise >= `low`, and `relax` is monotone with `low` feasible,
    so it can never fall below it; the mixture is pointwise <= the average; and
    `floor <= sym` with `sym` feasible gives `relax(floor, up) <= sym`, so the
    downward relax is applied to something that is `<= sym` either way.

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

    low = relax(h, 1.0)
    high = relax(h, -1.0)
    sym = 0.5 * (low + high)
    if prefer_low is None or not (prefer_low > 0.0).any():
        return sym, sym
    lam = 0.5 + 0.5 * np.clip(prefer_low, 0.0, 1.0)
    mix = lam * low + (1.0 - lam) * high
    if budget is None:
        return sym, relax(mix, 1.0)
    room = np.maximum(np.asarray(budget, dtype=np.float64), 0.0)
    floor = relax(np.minimum(sym - room, h), -1.0)
    if report is not None:
        # What the floor was worth, exactly and for nothing: the metres it held
        # the mixture up by, before the last relax spreads them. Read here rather
        # than by running the whole chain again without a budget -- that costs
        # six more relaxes on a 3 M-node graph and buys a number this one already
        # tells. `held` is the honest counter: nodes the floor actually bound.
        # Accumulated and not overwritten: `solve` runs this twice, the soft pull
        # and the hard projection, and the budget binds at each. A dict that took
        # only the last of them would report zero for a solve whose whole bound
        # was spent softening the 10% step -- which is the `0.02 / 2.0` row of the
        # block's sweep, where the hard stage binds nothing and Kirribilli moves
        # four metres anyway.
        lift = np.maximum(floor - mix, 0.0)
        report["held"] = report.get("held", 0) + int((lift > 1e-9).sum())
        report["held_p95"] = max(report.get("held_p95", 0.0), float(np.percentile(lift, 95)))
        report["held_max"] = max(report.get("held_max", 0.0),
                                 float(lift.max()) if lift.size else 0.0)
    return sym, relax(np.maximum(mix, floor), 1.0)


def _lipschitz(
    h: np.ndarray,
    edges: np.ndarray,
    limit: np.ndarray,
    prefer_low: np.ndarray | None = None,
    budget: np.ndarray | None = None,
    report: dict | None = None,
) -> np.ndarray:
    """The nearest profile that respects every edge's height budget."""
    return _projections(h, edges, limit, prefer_low, budget, report)[1]


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
