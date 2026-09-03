"""Elevated road decks: the bridges and viaducts, taken off the ground.

Every way OSM tags `bridge` or `viaduct` was, until this module, drawn as
ordinary asphalt draped on the terrain. `roadgrade.py` had already -- correctly
-- excluded them from the street-elevation solve, on the grounds that a deck's
height is not a statement about the ground under it; but nothing then took them
off the ground, so the exclusion only made them worse. The measured result over
the inner ring, from `road-grade-audit`:

    bridges   grade  p50 2.96%  p95 11.41%  p99 32.57%  max 52.58%
              bank   p50 2.62%  p95 11.20%  p99 39.14%  max 44.73%

-- which is the Western Distributor banked at 43% across Darling Harbour, the
Cahill Expressway climbing a 52% cliff out of Circular Quay, and 783 m2 of
asphalt lying on the water under the Anzac Bridge approach. None of those is a
road with an error in it. They are roads drawn in the wrong place.

So this module does the other half: it takes the bridge ways out of
`streets.py`'s ground union (see `StreetNetwork._build_surfaces`) and rebuilds
them as **decks** -- a ribbon at its own solved elevation, with a girder, solid
parapets, piers to the ground, and collision that a player can stand on and walk
under.

---------------------------------------------------------------------------
**Where the elevation comes from: the graph already knows.**

A bridge does not need a new source of truth, because the thing that decides its
height is where it lands. A bridge way's end nodes are shared -- as exact
coordinates, the same float twice, `roadgrade._graph`'s argument -- with the
ground ways it joins, and those ways have a solved elevation that the terrain
has already been conformed onto. So a touchdown is not estimated; it is *read*,
as `terrain.sample(node) + streets.CARRIAGEWAY_Y`, which is exactly the height
the ground asphalt is drawn at. **A deck therefore meets the road at both ends
with no lip at all**, and that continuity is the one property in this module
worth more than any other -- a 2 cm step at 12 m/s is a stumble the player
cannot see the cause of.

Between the touchdowns the profile is solved rather than interpolated, because
the interesting cases are not single spans. 120 of the 264 bridge carriageways in
the inner ring touch no ground way at either end: the Western Distributor's ramp
stack and the Cahill Expressway are *chains* of bridge ways, kilometres long,
whose only contact with the ground is at the far ends. So the bridge ways are
wired into their own graph -- one node per shared coordinate, exactly as the
street solve does it -- and every free node is solved by

  1. a weighted harmonic interpolation from the pinned touchdowns, which on a
     straight chain is a straight grade between them and on a branch hanging off
     one is flat at the junction's height, which is what a ramp gore is;
  2. a lift so no deck is under the ground it flies over, **and no deck is on
     top of the road it flies over** -- see the next section, which is the
     whole of why this module was opened a second time;
  3. a two-sided Lipschitz projection at `MAX_GRADE`, pins held, which is
     `roadgrade._lipschitz`'s machinery at a tighter ceiling -- 7% rather than
     15%, because a structure is graded to a design standard where a street is
     graded to whatever the hill does.

The pins are not moved by any of the three. Where a touchdown genuinely demands
more than 7% -- a short ramp off a high viaduct -- the clamp gives way and the
touchdown wins, which is the right way round.

---------------------------------------------------------------------------
**THE SECOND BUG, AND THE RULE THAT REPLACES THE ONE THAT CAUSED IT.**

The owner, on a screenshot of the St Peters interchange:

  > *"not sure what we meant to do when over passes are ON the road"*

A four-lane elevated ramp lying flat on the terrain with 2 m of concrete
standing up out of the grass along both edges; ambient cars driving the deck at
the same height as the cars on the street beside it; and Canal Road running
straight into the parapet and stopping. Measured over the shipped 60 km bake,
from `.lanes.bin` alone -- **1,685 places where two carriageways cross in plan
without sharing a node, which is the definition of a grade separation, and the
median clearance between them is 0.14 m.** 1,586 of them give less than the
4.5 m a truck needs. It is the Western Motorway (82 crossings), the Warringah
Freeway (71), the Westlink M7 (59), the M5 (55) -- every motorway in Sydney,
sitting on every street it is supposed to fly over.

**The cause is the list above, at step 2, and it is one word wide.** The floor
was `ground + CARRIAGEWAY_Y`: a deck may not be under *the terrain*. Nothing in
this module had ever heard of the road the deck is crossing. So a flyover whose
ramps touch down at grade a few hundred metres either side gets a harmonic
interpolation that is a straight line at ground level, a floor that lifts it two
centimetres clear of the grass, and a parapet as soon as that reaches 0.8 m. The
deck is drawn exactly where the solve put it, which is on top of the road.

This is `RAIL-VERTICAL.md` §1 in road clothing, and it fails for the identical
reason the buried stations did: **a relationship that was never measured cannot
be got right by the label at either end of it.** `bridge=yes` was read, believed,
and then used to decide *what to build* rather than *how high to build it*, and
the DEM -- which is a surface model and already contains the deck's own top, see
`roadgrade.py`'s header -- was left as the only vote on the vertical.

So the rule, stated once:

  **A deck's height over a road it crosses is not a fact about the terrain. It
  is the crossed road's own solved surface, plus the girder, plus
  `MIN_ROAD_CLEARANCE_M`.**

  Where OSM's topology and the heightfield disagree about whether there is
  room, the topology wins: two public carriageways whose centrelines cross and
  which **share no node** are grade-separated, whatever the DEM makes of the
  ground between them. That is not an inference -- a crossing without a
  junction is a statement that you cannot turn from one into the other, and the
  only way that is true is if one is over the other.

`_crossing_demand` is the rule. It finds every place a deck run's centreline
crosses a public ground carriageway's, reads the crossed road's surface as
`terrain.sample(foot) + streets.CARRIAGEWAY_Y` -- the same expression the
touchdown pin uses, so the deck and the road it clears agree about the road by
construction -- and returns, per deck node, the height that clears it. The
alternating floor/clamp loop then carries it exactly as it already carried the
ground floor, which is why the demand is a *floor* and not a solve of its own:
it is one more thing a station may not be below, and the loop was already the
machinery for that.

Four qualifications, each of which is a decision rather than a mechanic.

**Public only.** `service` is out, on `elevated.py`'s rule and for its reason:
a service way is a driveway, a loading dock and a car-park aisle, and lifting a
bridge six metres to clear one would be a worse bug than the one being fixed.
321 of the 1,685 cross a service way and they keep whatever the ground gives
them.

**A touchdown is not a crossing.** Where the deck way and the road share an OSM
node -- the same coordinate, `_key`'s millimetre rule -- the deck is *joining*
that road, not flying over it, and the demand is suppressed within
`TOUCHDOWN_EXEMPT_M` of the shared node. Without it every ramp gore in the city
would be asked to stand six metres over the road it merges into.

**The reach is the plan overlap, not the crossing point.** A road is up to 20 m
wide and a deck crosses it at a skew, so the stations that have to clear it are
every one within `hw_deck + hw_road` of the crossing -- the ones whose ribbon is
actually over the road's. Lifting only the two that bracket the intersection
would leave the parapet down on the kerb.

**Deck over deck is the same rule with the lower deck's live height.** 39 of the
1,685 cross another bridge rather than a street -- the stacked ramps at St
Peters and Darling Harbour -- and there OSM's `layer` says which is upper. The
demand is recomputed from the current profile each round of the loop instead of
once at the start, which is all that coupling costs at this size.

**What this does not do is move the ground.** It does not have to, and that is
worth saying because the reflex from `rail-cut.ts` is the opposite: a deck
raised without the ground under it lowered is a floating slab with a cliff. Here
the ground under the crossing is already the crossing road's own conformed
surface -- `roadgrade.conform` put it there and excluded the bridge from the
solve precisely so it would stay there -- so raising the deck opens the gap
rather than cutting one. What it *does* change is who owns the surface: a deck
six metres up is no longer paving that carries the ground, and
`client/src/world/road-deck.ts` had been treating every lane way as if it were.
`DECK_CARRIES_GROUND_M` on that side is the other half of this seam.

---------------------------------------------------------------------------
**What is suppressed, and why the Harbour Bridge is not here.**

`landmarks.py` builds the Harbour Bridge by hand, deck included, and its deck is
already walkable collision. The OSM ways for the Bradfield Highway and the Cahill
approach run straight down the middle of it, so a generic deck built from them
would stand inside the hero one -- two decks, z-fighting, at 49 m over the
harbour. Every bridge centreline is therefore **clipped** against the hero
bridge's plan footprint before anything else happens, and the parts outside it
survive. Clipped rather than dropped whole: `Bradfield Highway` is a 1,147 m way
of which 605 m is the hero's, and the 542 m of approach viaduct at Milsons Point
is a real elevated road that nothing else would draw.

---------------------------------------------------------------------------
**Materials, and why no slot was appended.** The running surface is
`road_asphalt` and everything structural is `footpath_concrete` -- both already
street slots, both already `building_indexed = False`. A `deck_concrete` slot
would have been nicer to look at and would have cost a lockstep change to
`client/src/world/streamer.ts`'s shared-material map and to `far.ts`'s
`FAR_TINT` length guard, which is import-time fatal if it is missed. A girder
soffit in footpath concrete reads as formwork; that is a trade worth taking to
leave the client untouched.

**Collision is the format that already shipped.** A deck segment is a
`landmarks.Prism` -- a plan ring and `[base, base + height]` -- which is what
`tiles.write_collision` has written since terrain arrived and what the Harbour
Bridge's own deck is made of. `base` at the soffit puts the volume over a
player's head so they walk under it; the top is standable through
`CollisionWorld.roofHeight`. Nothing about the payload changes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from . import geo, streets
from .sources import osm

# --- The profile solve ---------------------------------------------------------

# Stations along a deck, metres. Half `roadgrade.STATION_M`, and it is the
# collision that sets it rather than the geometry: a prism has one `base` and one
# `height`, so a sloping deck is a staircase whose step is `station * grade`.
# `player/controller.ts` steps 0.42 m without help, so at the 7% ceiling below a
# 6 m station gives a 0.42 m step exactly at the worst case and less everywhere
# else. `landmarks._deck_run` picked the same number for the same reason.
STATION_M = 6.0

# The tallest step a prism may present to the thing walking or driving up it.
#
# `STATION_M` above is the *design* answer to this and it is only correct while
# the grade clamp holds: 6 m at the 7% ceiling is a 0.42 m step, which is exactly
# what a body climbs. But the ceiling is a ceiling on the **free** nodes -- the
# header says so, twice, and means it: "Where a touchdown genuinely demands more
# than 7% ... the clamp gives way and the touchdown wins, which is the right way
# round." It is the right way round for the *profile*. Nothing then re-asked what
# it had done to the *staircase*.
#
# Measured over the shipped 60 km solve, 29,519 deck segments:
#
#     step   p50 0.135 m   p95 0.611 m   max 17.93 m
#     over the 0.47 m a body can climb:  3,829 segments (12.97%) on 843 runs
#
# 13% of every bridge in Sydney was a wall. `CollisionWorld.solidFor`'s first
# clause is `feetY >= prism.top - 0.05` and the caller adds `driving.NOSE_STEP` =
# 0.42, so a step over 0.47 m is not a bump: the body stops, and a *car* stops
# with the full crash penalty `driving.ts` describes -- two thirds of its speed
# and a crash's damage every cooldown for as long as the geometry keeps passing
# under the bonnet. The owner's report was "i cant actually drive onto this
# bridge", from Epping, and Epping Road's ramp is 3.19 m of step in the list this
# number came out of.
#
# 0.35 rather than 0.47, because the allowance is not headroom to spend: the
# 0.42 the caller adds is measured from *unlifted* feet and a car's nose probe
# meets the step at whatever pitch the last one left it at. A quarter of the
# budget in hand is the difference between "climbs it" and "climbs it from here".
MAX_STEP_M = 0.35

# Above this grade a segment is a cliff in the solve rather than a ramp sampled
# too coarsely, and subdividing it makes a finer staircase up the same cliff.
#
# 20% is chosen where the population splits rather than from a standard: of the
# 3,829 over-steps measured above, 3,676 are under 20% -- real ramps, badly
# sampled, and fixed exactly by the restation -- and 153 are over it, which is
# 0.5% of the network and is a bad touchdown somewhere. Sydney's steepest public
# street is about 15%, so nothing at 20% is a road.
CLIFF_GRADE = 0.20

# The grade ceiling on a solved deck.
#
# 7% rather than the streets' 15%, because the two are different objects: a
# street is graded to whatever the hill does and Sydney's hills reach 1:6.5, and
# a structure is graded to a design standard. Austroads' desirable maximum for a
# motorway grade is 6% and the Cahill Expressway's own ramps are about 5.5%,
# which is the number `landmarks.py` builds the Harbour Bridge's approaches at.
#
# It is a ceiling on the *free* nodes only. A touchdown is a measurement and is
# never moved to satisfy it -- see the header.
MAX_GRADE = 0.07

# Sweeps allowed for the Lipschitz projection. A violation propagates one edge a
# sweep; the longest bridge chain in the extent is the Western Distributor's, at
# about 3 km, which is 500 stations.
MAX_SWEEPS = 600

# Iterations of the harmonic solve. It is a conjugate gradient on a graph
# Laplacian of a few thousand nodes, which converges in tens; the cap is a
# guard rather than a budget.
MAX_CG = 400

# Rounds of "lift clear of the ground, then clamp the grade". See `_solve`.
FLOOR_ROUNDS = 3

# --- The crossing rule ---------------------------------------------------------

# How much room a deck must leave over a road it crosses, metres, measured to
# the **soffit** and not to the running surface -- the girder is added on top of
# it, because what a truck hits is the underside.
#
# 5.0 m is Sydney's number. TfNSW's standard vertical clearance over a road is
# 5.3 m for a new structure and 4.6 m is the absolute floor a heavy vehicle
# route is signposted at; the overbridges actually built through the 1960s
# motorway program sit between the two. Taking the lower of the two design
# numbers rather than the higher is deliberate: this is a *floor* that the
# solve will meet exactly wherever the terrain gives it nothing for free, so
# every centimetre of it is a centimetre the approach ramps have to climb, and
# a game where the M5 stands 5.3 m over every side street rather than 5.0 m is
# not a better game.
#
# It is stated to the soffit and not to the deck for the same reason
# `WALK_UNDER_M` is: the two numbers have to be comparable, and a clearance
# measured to the top of the slab is a clearance that gets smaller when someone
# makes the girder deeper.
# **7.0 since the 2026-09 round**, up from 5.0. The owner, having driven
# under a few: *"in general bridges and stuff are too low give them like 2
# more meters off the ground"*. 5.0 was Austroads' minimum and read as a
# ceiling in a game whose camera sits over the roof; two metres more is the
# difference between ducking and driving. Where the geometry cannot give it
# -- a stub pinned at both ends -- `_pin_ceiling` still wins, exactly as
# before, and the shortfall is reported rather than faked.
MIN_ROAD_CLEARANCE_M = 7.0

# The grade a deck may climb **away from a touchdown** to reach a clearance.
#
# `MAX_GRADE` is 7% because a structure is graded to a design standard. This is
# the other question, and it only comes up because of the crossing rule: when a
# flyover has to be six metres up and its touchdown is forty metres away, how
# much of the ceiling does the clearance get to spend? The touchdown itself
# never moves -- `_pin_ceiling` is where the precedence is argued -- so this is
# purely a trade between how much road is open underneath and how steep the ramp
# over it is.
#
# **It is 10%, and the number is measured rather than chosen.** Over the inner
# 8 km, 391 places where a deck crosses a public carriageway, against the deck
# grades of the same solve:
#
#   ramp   crossings under 4.5 m   median clearance   grade p95   grade max
#  no cap           0                    6.00 m          7.01%      149.3%
#    35%           42                    6.00 m         21.65%       78.1%
#    20%           92                    6.00 m         18.48%       74.2%
#    15%          121                    6.00 m         15.00%       63.1%
#    12%          152                    5.94 m         12.00%       54.5%
# > 10%           172                    5.17 m         10.00%       39.9%
#     7%           217                    3.68 m          7.00%       39.9%
#  no rule         336                    0.34 m          6.36%       39.9%
#
# -- the last row being the bake as it shipped, with no crossing rule at all.
#
# 10% is where the last column stops moving. Everything at or under it leaves
# the steepest deck in the extent exactly where it already was -- 39.9% on New
# Link Road, which is a pre-existing run this rule never touches -- so the fix
# cannot be blamed for a cliff it did not build. 12% buys twenty more crossings
# and a 54% segment, which is a wall the player launches off; that is the wrong
# side of the trade in a game whose verb is running down roads.
#
# It is also `roadgrade.TARGET_GRADE`, which is the grade the street solve is
# pulled toward, and Austroads' absolute maximum for a ramp. The agreement is a
# coincidence worth naming rather than an argument: a ramp climbing at what
# Sydney's steeper streets climb at is a ramp nobody files a report about.
#
# The 172 that are still short are not a tolerance and are not silent. They are
# stubs -- a 16 m OSM way tagged `bridge` between two ways that are not, at the
# Cahill onramp and its like -- where the structure in the world is longer than
# the structure in the data, and no grade allowance recovers a ramp that has no
# length to climb in. `RAIL-VERTICAL.md` §6 is the precedent for naming a
# resolution limit and moving on; the real fix is the approach embankments
# becoming decks, which is a round of its own.
TOUCHDOWN_RAMP_GRADE = 0.10

# How near a node the deck way and the crossed road share the demand is dropped,
# metres.
#
# A shared node is a touchdown or a ramp gore -- the deck is *joining* that road
# there, and joining it at its own level is the one property this module values
# above all others (see the header on the 2 cm lip). 25 m is four stations,
# which is enough that the Lipschitz clamp can carry the profile away from the
# junction without the pin fighting the demand, and short enough that a viaduct
# which touches down on a street at one end and flies over the same street
# 300 m later still has to clear it at the second place.
TOUCHDOWN_EXEMPT_M = 25.0

# The road classes a deck does **not** have to clear. `elevated.py`'s "public"
# rule, restated here rather than imported so the two can be seen to be the same
# decision: a service way is the driveway, the loading dock and the car-park
# aisle, and a bridge standing on one is the normal case rather than the broken
# one. 321 of the extent's 1,685 grade separations cross one of these.
PRIVATE_CLASSES = frozenset({"service"})

# Plan cell for the road index the crossing search runs against, metres.
# Sized at the largest reach any one query has -- a 30 m road half width plus a
# 20 m deck half width plus a station -- so a lookup is exactly nine cells.
CROSS_CELL_M = 64.0

# --- The structure -------------------------------------------------------------

# How far the deck's structural edge stands outside the carriageway it carries,
# metres. A bridge is wider than its traffic lanes -- the barrier, the kerb and
# the edge beam all live out here -- and without it the parapet would stand on
# the outside lane.
EDGE_MARGIN_M = 0.6

# The girder, metres deep. A real box girder under a 12 m urban viaduct is 1.2 to
# 1.8 m; this is the shallow end of that because the number that matters is the
# *soffit*, and a deeper girder eats the clearance a player walks under.
GIRDER_DEPTH_M = 1.0

# How far the soffit may sink below the ground before it is clamped up, metres.
#
# A bridge way at grade -- a culvert crossing, which is what the median 33 m
# bridge way in this extent is -- would otherwise bury a metre of fascia in the
# terrain to draw nothing. Clamped here it becomes a 25 cm edge beam, which is
# what the parapet of an at-grade crossing looks like.
GIRDER_BURY_M = 0.25

# The parapet: a solid barrier the player cannot walk off and can still jump.
PARAPET_HEIGHT_M = 1.05
PARAPET_THICK_M = 0.40

# The clearance under the deck below which no parapet is drawn, metres.
#
# The point at which a "bridge" stops being a structure and becomes a piece of
# road over a pipe. Drawing a barrier down both sides of a 30 m culvert crossing
# in a suburban street puts a wall across every driveway on it.
PARAPET_MIN_CLEARANCE_M = 0.8

# How far along the deck the parapet takes to reach its full height once the
# clearance allows one, metres. A barrier that begins as a 1.05 m wall at one
# station is a step the eye reads as a mistake at the foot of every ramp --
# the owner's "transitions to ramps should not have edges like this, should
# be smooth". Grown over eight metres from the deck's own top, it reads as
# the barrier a real approach has: low at the gore, full on the span.
PARAPET_RAMP_M = 8.0

# Piers: how far apart, how big, and the clearance under which none is drawn.
#
# 30 m is a plausible span for a concrete viaduct and is what the Western
# Distributor actually uses through Darling Harbour. Piers stand in water quite
# happily and are meant to -- most of that viaduct's do.
PIER_SPACING_M = 30.0
PIER_ALONG_M = 1.8
PIER_ACROSS_M = 2.6
PIER_MIN_CLEARANCE_M = 2.5
# How far a pier is sunk below the ground so it never stands on a visible sliver
# of its own base where the terrain facet under it tilts.
PIER_BURY_M = 1.5

# --- Collision -----------------------------------------------------------------

# The rise over the ground at which a deck earns a collision prism, metres.
#
# Under it the terrain is already the floor and a prism 2 cm over it would be a
# volume that does nothing. Over it the player has to be stood on the deck rather
# than on the ground beneath it.
PRISM_MIN_RISE_M = 0.35

# The clearance at which the prism's base lifts off the ground, metres.
#
# Below this the prism runs from the ground up, which makes the touchdown ramp a
# solid embankment the player walks up continuously; above it the base is the
# soffit and the player walks *under* the deck. 2.6 m clears a 1.8 m player with
# room to jump, and the transition is continuous because the two forms share the
# same top.
WALK_UNDER_M = 2.6

# --- Suppression ---------------------------------------------------------------

# How far past the hero bridge's own plan a generic deck is still suppressed.
SUPPRESS_MARGIN_M = 8.0

# Runs shorter than this, left over after the hero clip, are dropped: a 4 m stub
# of viaduct is two triangles and a collision prism describing nothing.
MIN_RUN_M = 8.0

SLOT_DECK = "road_asphalt"
SLOT_STRUCTURE = "footpath_concrete"


def _restation_steep(run: "DeckRun", terrain) -> "DeckRun":
    """Insert stations along any segment whose step is taller than a body climbs.

    ---------------------------------------------------------------------------
    **This does not move one millimetre of the drawn deck, and that is the whole
    reason it is the right fix.**

    The profile is piecewise linear between stations -- `_solve` produces one
    height per station and everything downstream, the ribbon and the prisms
    alike, joins them with straight lines. So a station placed *on* an existing
    segment at the height that segment already has at that chainage is a point
    the surface already passed through. The deck is identical afterwards. What
    changes is only how finely the collision staircase samples it, which is the
    thing that was wrong.

    The alternative was to re-solve steep runs at a finer `STATION_M`, and it is
    worse in the way that matters here: re-solving moves the surface, so a fix
    for the 3,676 segments that are a fine ramp badly sampled would also have
    quietly redrawn every bridge in the city. This changes the collision and
    nothing else, which is a change that can be reasoned about.

    `ground` is **resampled** rather than interpolated, because it is the real
    terrain under the new station and it is what the clearance, the parapet test
    and the pier bases are read from -- interpolating it would put a pier's foot
    in the air over a gully wall. `deck_y` is interpolated, because interpolating
    it is the definition of the surface.

    What this cannot fix is a segment whose *profile* is a cliff rather than a
    ramp: 153 segments of 29,519 come out of the solve steeper than 20%, and
    subdividing one of those produces a finer staircase up the same cliff.
    `DeckNetwork.load` counts them and the build reports them, because a number
    that is reported is a number somebody can go and look at, and a cliff is a
    bad touchdown rather than a bad sampling.
    """
    y = run.deck_y
    if len(y) < 2:
        return run
    d = np.abs(np.diff(y))
    if not (d > MAX_STEP_M).any():
        return run

    # How many pieces each segment is cut into. One means untouched.
    cuts = np.maximum(np.ceil(d / MAX_STEP_M).astype(np.int64), 1)
    pts: list[np.ndarray] = []
    deck: list[float] = []
    for i, n in enumerate(cuts):
        a, b = run.pts[i], run.pts[i + 1]
        for k in range(n):
            t = k / n
            pts.append(a + (b - a) * t)
            deck.append(float(y[i] + (y[i + 1] - y[i]) * t))
    pts.append(run.pts[-1])
    deck.append(float(y[-1]))

    p = np.asarray(pts, dtype=np.float64)
    ground = np.asarray(terrain.sample(p[:, 0], p[:, 1]), dtype=np.float64)
    return DeckRun(
        road=run.road,
        pts=p,
        deck_y=np.asarray(deck, dtype=np.float64),
        ground=ground,
        half_width=run.half_width,
    )


@dataclass
class DeckRun:
    """One continuous elevated run, solved and stationed.

    A *run* rather than a way: the hero clip can cut one OSM way into two pieces
    either side of the Harbour Bridge, and each piece is its own ribbon.
    """

    road: osm.OsmRoad
    pts: np.ndarray  # (N, 2) station centres, ENU
    deck_y: np.ndarray  # (N,) running surface, world metres
    ground: np.ndarray  # (N,) terrain under each station
    half_width: float  # to the structural edge, not the traffic lane
    # The per-station left-of-travel normals, memoised. See `_mitred_ring`: the
    # collision rings and the drawn edges are built from the same array, and
    # `prisms` asks for it once per segment, so recomputing it there would be a
    # `_frames` call per six metres of viaduct in the extent.
    _left: np.ndarray | None = field(default=None, repr=False, compare=False)

    @property
    def frames(self) -> np.ndarray:
        """`_frames(self.pts)`, computed once."""
        if self._left is None:
            object.__setattr__(self, "_left", _frames(self.pts))
        return self._left

    @property
    def length(self) -> float:
        return float(np.hypot(*np.diff(self.pts, axis=0).T).sum())

    @property
    def clearance(self) -> np.ndarray:
        return self.deck_y - self.ground


class DeckNetwork:
    """Every bridge carriageway in the extent, as a solved elevated deck."""

    def __init__(self, runs: list[DeckRun], stats: dict, crossings: list[dict] | None = None) -> None:
        self.runs = runs
        self.stats = stats
        # Every place a deck flies over a public carriageway, with the clearance
        # the solve gave it. Kept rather than summarised away because it is the
        # only pre-retile view of the thing the bake exists to fix -- a 25-hour
        # retile is not something to start on a percentile. `cli._report_decks`
        # prints the summary and the worst of them every build.
        self.crossings = crossings or []
        self._by_tile: dict[str, list[tuple[DeckRun, int, int]]] | None = None

    # --- Construction ---------------------------------------------------------

    @classmethod
    def load(
        cls,
        radius_m: float,
        terrain,
        suppress: Polygon | None = None,
        roads: list[osm.OsmRoad] | None = None,
    ) -> DeckNetwork:
        """Solve every bridge way in the extent against the conformed ground.

        `terrain` must be the *conformed* lattice -- the one `Terrain.load`
        returns and every other module reads -- because the touchdown heights are
        read straight off it and a deck solved against the raw DEM would land a
        couple of metres away from the asphalt it is supposed to meet.
        """
        if roads is None:
            roads = osm.read_roads(radius_m)
        bridges = [r for r in roads if _is_deck(r)]
        ground_nodes = {
            _key(p)
            for r in roads
            if _is_ground_carriageway(r)
            for p in r.line
        }

        clipped: list[tuple[osm.OsmRoad, np.ndarray]] = []
        suppressed_m = 0.0
        for r in bridges:
            line = LineString(r.line)
            if suppress is not None and suppress.intersects(line):
                inside = line.intersection(suppress)
                suppressed_m += float(getattr(inside, "length", 0.0))
                outside = line.difference(suppress)
            else:
                outside = line
            for piece in _linestrings(outside):
                pts = np.asarray(piece.coords, dtype=np.float64)
                if len(pts) >= 2 and piece.length >= MIN_RUN_M:
                    clipped.append((r, pts))

        runs, solve_stats, crossings = _solve(
            clipped,
            ground_nodes,
            terrain,
            [r for r in roads if _is_ground_carriageway(r) and r.highway not in PRIVATE_CLASSES],
        )
        # After the solve and before anything reads a station, because everything
        # that reads one -- the ribbon, the prisms, the piers, the tile index --
        # reads the same array and must see one stationing. See `_restation_steep`
        # and `MAX_STEP_M`: the profile is untouched, the staircase is not.
        cliffs = 0
        restationed = 0
        # The grade population is read *here*, off the solved stationing, and kept
        # for the stats below. Subdividing preserves every segment's slope exactly
        # but replaces one steep segment with several, so measuring the grade
        # afterwards would report a distribution reweighted by the fix rather than
        # the profile the solve produced -- and the profile is what the grade
        # percentiles are a statement about.
        grade_pop: list[np.ndarray] = []
        for i, run in enumerate(runs):
            if len(run.deck_y) < 2:
                continue
            step = np.abs(np.diff(run.deck_y))
            seg = np.maximum(np.hypot(*np.diff(run.pts, axis=0).T), 1e-6)
            grade_pop.append(step / seg)
            cliffs += int(((step > MAX_STEP_M) & (step / seg > CLIFF_GRADE)).sum())
            if (step > MAX_STEP_M).any():
                runs[i] = _restation_steep(run, terrain)
                restationed += 1
        stats = {
            "restationed_runs": restationed,
            "cliff_segments": cliffs,
            "bridge_ways": len(bridges),
            "bridge_length_m": sum(
                float(np.hypot(*np.diff(r.line, axis=0).T).sum()) for r in bridges
            ),
            "suppressed_m": suppressed_m,
            "runs": len(runs),
            "deck_length_m": sum(r.length for r in runs),
            **solve_stats,
        }
        if runs:
            grade = np.concatenate(grade_pop) if grade_pop else np.zeros(1)
            clear = np.concatenate([r.clearance for r in runs])
            step = np.concatenate([np.abs(np.diff(r.deck_y)) for r in runs if len(r.pts) > 1])
            stats.update(
                step_p50=float(np.percentile(step, 50)),
                step_p95=float(np.percentile(step, 95)),
                step_max=float(step.max()),
                over_step=int((step > MAX_STEP_M).sum()),
                stations=int(len(step)),
                grade_p50=float(np.percentile(grade, 50)),
                grade_p95=float(np.percentile(grade, 95)),
                grade_max=float(grade.max()),
                over_max=int((grade > MAX_GRADE + 1e-6).sum()),
                segments=len(grade),
                clear_p50=float(np.percentile(clear, 50)),
                clear_max=float(clear.max()),
                clear_min=float(clear.min()),
                elevated_share=float((clear > PARAPET_MIN_CLEARANCE_M).mean()),
            )
        return cls(runs, stats, crossings)

    def __len__(self) -> int:
        return len(self.runs)

    # --- Tile coverage --------------------------------------------------------

    def _index(self) -> dict[str, list[tuple[DeckRun, int, int]]]:
        """Segments grouped by the tile holding their midpoint, in run order.

        A segment belongs to one tile and one only, which is the same rule
        `landmarks.prisms_by_tile` uses for the Harbour Bridge's deck and is what
        makes walking a viaduct across a seam walking off one tile's prisms and
        onto the next's. The value is a list of `(run, first, last)` station
        spans so a tile can emit each of its pieces as one welded strip rather
        than as a pile of loose quads.
        """
        if self._by_tile is not None:
            return self._by_tile
        out: dict[str, list[tuple[DeckRun, int, int]]] = {}
        for run in self.runs:
            mid = 0.5 * (run.pts[:-1] + run.pts[1:])
            keys = [geo.tile_for_enu(float(e), float(n)).key for e, n in mid]
            start = 0
            for k in range(1, len(keys) + 1):
                if k == len(keys) or keys[k] != keys[start]:
                    out.setdefault(keys[start], []).append((run, start, k))
                    start = k
        self._by_tile = out
        return out

    def tile_keys(self) -> set[str]:
        return set(self._index())

    def height_max(self, tile_key: str) -> float:
        """How far this tile's tallest deck stands over the ground under it.

        A *height*, not a world y, because that is what `TileResult.height_max`
        means everywhere else -- it is a building's storey height, and the client
        sizes each tile's cull box from it against the tile's own ground range.
        A tile that is nothing but harbour and a viaduct has no building at all,
        so without this the Western Distributor over Darling Harbour is culled
        the moment the player is not standing on it.
        """
        spans = self._index().get(tile_key)
        if not spans:
            return 0.0
        return max(
            float(run.clearance[lo : hi + 1].max()) + PARAPET_HEIGHT_M for run, lo, hi in spans
        )

    # --- Collision ------------------------------------------------------------

    def prisms(self, tile_key: str) -> list:
        """This tile's deck and parapet volumes, as `landmarks.Prism` records.

        One prism per segment, its top at the segment's midpoint, which is what
        makes a sloping deck a staircase the player can walk -- see `STATION_M`
        for why 6 m is the step. A segment lying on the ground gets none at all:
        the terrain is already the floor there, and a volume 2 cm over it would
        do nothing but cost bytes.

        **The base is the soffit only where there is room to walk under it.**
        Below `WALK_UNDER_M` of headroom the prism runs from just under the
        ground instead, which turns the touchdown ramp into a solid embankment --
        and that is a continuity requirement rather than a nicety: a prism whose
        base is over the player's head is one they walk *under*, so a ramp that
        switched to a floating deck at 1 m of clearance would be a road the
        player falls through for its first ten metres. The two forms share the
        same top, so the transition is seamless.
        """
        from .landmarks import Prism

        out: list = []
        for run, lo, hi in self._index().get(tile_key, []):
            hw = run.half_width
            left = run.frames
            for i in range(lo, hi):
                rise = max(run.clearance[i], run.clearance[i + 1])
                if rise < PRISM_MIN_RISE_M:
                    continue
                top = 0.5 * (run.deck_y[i] + run.deck_y[i + 1])
                ground = 0.5 * (run.ground[i] + run.ground[i + 1])
                soffit = top - GIRDER_DEPTH_M
                base = soffit if soffit - ground >= WALK_UNDER_M else ground - 0.5
                ring = _mitred_ring(run.pts, left, i, hw)
                out.append(Prism(ring, float(base), float(top - base), "deck"))
                if min(run.clearance[i], run.clearance[i + 1]) >= PARAPET_MIN_CLEARANCE_M:
                    for side in (1.0, -1.0):
                        off = side * (hw - PARAPET_THICK_M * 0.5)
                        out.append(
                            Prism(
                                _mitred_ring(
                                    run.pts, left, i, PARAPET_THICK_M * 0.5, offset=off
                                ),
                                float(top),
                                PARAPET_HEIGHT_M,
                                "parapet",
                            )
                        )
        return out

    # --- Emission -------------------------------------------------------------

    def emit(self, tile_key: str, slots: dict, origin: tuple[float, float]) -> None:
        """Tessellate this tile's share of every deck crossing it.

        Takes no terrain, unlike `streets.StreetNetwork.emit`, and the absence is
        the point: a deck is the one paved surface in the build that is *not*
        draped, so there is nothing to cut against the terrain's facets and no
        clearance to keep over them. Its height came out of the solve and the
        ground under it is only ever consulted for where to stop a pier.
        """
        spans = self._index().get(tile_key)
        if not spans:
            return
        for slot in (SLOT_DECK, SLOT_STRUCTURE):
            slots[slot].building_indexed = False
        for run, lo, hi in spans:
            _emit_run(slots, run, lo, hi, origin)


# --- Selection -----------------------------------------------------------------


def _is_deck(r: osm.OsmRoad) -> bool:
    """A carriageway carried over something else.

    Footways are out, and the omission is deliberate rather than an oversight: a
    footbridge is 2 m wide, there are 670 of them in the inner ring against 264
    carriageways, and a deck with a girder and piers under a park footbridge is
    more wrong than the draped ribbon it would replace. They keep draping, which
    is what `roadgrade.py` decided about footways for its own reasons.

    Tunnelled and below-ground ways are out because they carry no surface at all
    -- `streets.StreetNetwork.load` has always dropped them.
    """
    return r.bridge and not r.is_foot and not r.tunnel and r.layer >= 0


def _is_ground_carriageway(r: osm.OsmRoad) -> bool:
    """A way whose elevation the terrain has been conformed onto.

    Exactly `roadgrade._is_conformable`, restated here rather than imported so
    the two can be seen to be the same set: these are the ways whose solved
    height the ground already carries, which is what makes a touchdown readable
    off `terrain.sample` instead of estimated.
    """
    return r.layer >= 0 and not r.tunnel and not r.bridge and not r.is_foot


def _key(p) -> tuple[int, int]:
    """A vertex's identity, to the millimetre -- `roadgrade._key`'s rule.

    Two ways that meet share the OSM node they meet at, and a shared node is the
    same geodetic coordinate through the same transform, so it is the same float
    twice. Rounding finds it exactly rather than within a tolerance.
    """
    return (round(float(p[0]) * 1000.0), round(float(p[1]) * 1000.0))


def _linestrings(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        out: list[LineString] = []
        for part in geom.geoms:
            out.extend(_linestrings(part))
        return out
    return []


def hero_bridge_zone(anchors: dict, zones: dict) -> Polygon:
    """The plan the Harbour Bridge's own deck occupies, as one polygon.

    `landmarks.suppression_zones`' bridge zone is the two pylon pairs and the OSM
    deck outline, and it is deliberately *not* the whole corridor -- its job is
    to stop a generic building standing inside a pylon, and the terraces under
    the approach viaducts are real. That is the wrong shape for this: the hero
    model builds `BRIDGE_TOTAL_LENGTH` of deck, 1,149 m including both approach
    viaducts, and every metre of it would have a generic deck inside it.

    So the zone is unioned with the hero deck's own footprint, taken from the
    same frame `landmarks.build_bridge` builds it in -- the two pylon centroids
    -- so the two cannot drift apart.
    """
    from . import landmarks as lm

    centre, along, across = lm._bridge_frame(anchors)
    half_len = lm.BRIDGE_TOTAL_LENGTH * 0.5
    half_w = lm.BRIDGE_DECK_WIDTH * 0.5 + SUPPRESS_MARGIN_M
    corners = [
        centre + along * s + across * t
        for s, t in ((-half_len, -half_w), (half_len, -half_w), (half_len, half_w), (-half_len, half_w))
    ]
    merged = unary_union([Polygon(corners), zones["bridge"]])
    return merged if merged.geom_type == "Polygon" else merged.convex_hull


# --- The solve -----------------------------------------------------------------


def _solve(clipped, ground_nodes: set, terrain, ground_roads) -> tuple[list[DeckRun], dict, list[dict]]:
    """Station every run, wire them into one graph, and solve the profile.

    `ground_roads` is the public surface carriageway set the crossing rule is
    measured against -- see `_crossing_demand` and the header. It is passed in
    rather than re-read because `DeckNetwork.load` already holds the extract and
    a second `read_roads` here would be a second set of `OsmRoad` objects
    describing the same ways, which is the mistake `lanes._HeightField`'s
    comment exists to stop coming back.
    """
    if not clipped:
        return [], {"nodes": 0, "pinned": 0, "components": 0, "unpinned_components": 0}, []

    # Which vertices are junctions, so a station always lands on one: a way
    # ending in the middle of another way has to be one unknown, not two.
    seen: dict[tuple[int, int], int] = {}
    for _, pts in clipped:
        for k in {_key(p) for p in pts}:
            seen[k] = seen.get(k, 0) + 1

    node_id: dict[tuple[int, int], int] = {}
    stations: list[np.ndarray] = []
    node_of: list[np.ndarray] = []
    edges: list[tuple[int, int]] = []
    edge_len: list[float] = []
    n_nodes = 0

    for _, pts in clipped:
        ss, sp = _stations(pts, seen, ground_nodes)
        ids = np.empty(len(sp), dtype=np.int64)
        for k, p in enumerate(sp):
            key = _key(p)
            # Only a *shared* coordinate is a shared unknown. A uniform station
            # in the middle of a span is unique to its own run by construction,
            # and keying it would weld two viaducts that happen to cross in plan.
            if seen.get(key, 0) > 1 or key in ground_nodes:
                nid = node_id.get(key)
                if nid is None:
                    nid = node_id[key] = n_nodes
                    n_nodes += 1
            else:
                nid = n_nodes
                n_nodes += 1
            ids[k] = nid
        for k in range(len(sp) - 1):
            if ids[k] != ids[k + 1]:
                edges.append((int(ids[k]), int(ids[k + 1])))
                edge_len.append(float(ss[k + 1] - ss[k]))
        stations.append(sp)
        node_of.append(ids)

    edge = np.asarray(edges, dtype=np.int64).reshape(-1, 2)
    elen = np.maximum(np.asarray(edge_len, dtype=np.float64), 1e-3)

    pos = np.zeros((n_nodes, 2))
    for sp, ids in zip(stations, node_of):
        pos[ids] = sp
    ground = np.asarray(terrain.sample(pos[:, 0], pos[:, 1]), dtype=np.float64)

    pinned = np.zeros(n_nodes, dtype=bool)
    for key, nid in node_id.items():
        if key in ground_nodes:
            pinned[nid] = True
    h = ground + streets.CARRIAGEWAY_Y

    comps, n_comp, unpinned = _components(edge, n_nodes, pinned)
    # A component that reaches no ground way at all -- a ramp whose only other
    # end is a tunnel portal, or a viaduct cut by the extent edge. Its dangling
    # ends are pinned to the ground instead, which is where a ramp does in fact
    # go; a component with no dangling end either (a closed loop of viaduct, of
    # which there are none here) takes its lowest node.
    if unpinned:
        degree = np.bincount(edge.ravel(), minlength=n_nodes)
        for c in unpinned:
            members = np.flatnonzero(comps == c)
            ends = members[degree[members] <= 1]
            pinned[ends if len(ends) else members[np.argmin(ground[members])]] = True

    # What the roads underneath demand, before anything is solved: a height per
    # node that clears every public carriageway that node's ribbon stands over.
    # See the header. Computed once because the ground roads do not move; the
    # deck-over-deck half of it does move and is recomputed inside the loop.
    demand, over_deck, cross_stats, crossings = _crossing_demand(
        clipped, stations, node_of, ground_roads, terrain, n_nodes
    )

    # Harmonic first, then the floor and the clamp **alternately**, ending on the
    # floor. The order is not cosmetic and the single pass it replaces was wrong:
    # the Lipschitz projection lowers nodes, so lifting a dipped span clear of
    # the ground and then clamping put five viaducts back under it -- up to
    # 1.14 m on the Cahill's 417 m run, which is a buried deck with a hole in the
    # road over it, since `streets.py` has already stopped drawing ground asphalt
    # there. Alternating converges in two rounds and the third is the guard;
    # what is left over after the last floor is the terrain's own grade under a
    # deck that is lying on it, which is a crossing at grade and not a defect.
    #
    # **The crossing demand rides in the same floor**, which is the whole reason
    # it was written as a height rather than as a solve of its own: the loop
    # already knew how to hold a lower bound against a grade clamp, and a second
    # solve would have been a second opinion about where the deck is.
    h = _harmonic(h, edge, elen, pinned)
    free = ~pinned
    ground_floor = ground + streets.CARRIAGEWAY_Y
    lim = MAX_GRADE * elen
    # What the touchdowns and `TOUCHDOWN_RAMP_GRADE` between them will allow.
    # Computed once, from the pinned heights, which never move. See
    # `_pin_ceiling` for the precedence it enforces: pin, then grade, then
    # clearance -- and note that the ramp grade is the *looser* of the two
    # ceilings in this function on purpose. `MAX_GRADE` is what a free stretch
    # of structure is graded to; this is what a stretch pinned at one end may
    # spend to get out of the road.
    ceiling = _pin_ceiling(h, edge, TOUCHDOWN_RAMP_GRADE * elen, pinned)

    def _floor(profile: np.ndarray) -> np.ndarray:
        """Everything a node may not be below, this round.

        **The ceiling is applied on both sides of the roll-out, and the second
        one is not redundant.** `_demand_envelope` spreads a demand outward at
        7% while `_pin_ceiling` decays at `TOUCHDOWN_RAMP_GRADE` -- so between a
        crossing and a touchdown near it the envelope falls away more slowly
        than the ceiling does and arrives at the pin's neighbour six metres
        high, which is the 119% cliff the first version of this shipped into the
        measurement. Capping only the demand caps the wrong end of the roll-out.
        """
        want = np.minimum(
            np.maximum(demand, _stacked_demand(profile, over_deck, n_nodes)), ceiling
        )
        rolled = np.minimum(_demand_envelope(want, edge, lim), ceiling)
        return np.maximum(ground_floor, rolled)

    for _ in range(FLOOR_ROUNDS):
        floor = _floor(h)
        h[free] = np.maximum(h[free], floor[free])
        h = _lipschitz(h, edge, lim, pinned)
    h[free] = np.maximum(h[free], _floor(h)[free])

    # How much of the demand the pins refused. A crossing a few metres from a
    # touchdown is a genuine contradiction -- the ramp has no length to climb in
    # -- and it is *reported* rather than asserted, because the pin is a
    # measurement and the demand is a rule, and the rule does not get to move
    # the asphalt it is measured against. `server/overpass-clearance-check.ts`
    # counts the same places from the shipped bytes; this is the same number
    # seen from the solve's side, and if they ever disagree one of them is
    # asking a different question.
    want = np.maximum(demand, _stacked_demand(h, over_deck, n_nodes))
    short = np.isfinite(want) & (h < want - 1e-3)
    cross_stats["demand_unmet"] = int(short.sum())
    cross_stats["demand_unmet_max_m"] = float((want - h)[short].max()) if short.any() else 0.0

    # What each crossing actually got. The deck's own solved height at the
    # crossing, against the road's surface under it -- both read the way the
    # shipped check reads them, so the two numbers are comparable across the
    # retile that carries this work to players.
    for c in crossings:
        c["deck_y"] = float(h[c["a"]] + c["t"] * (h[c["b"]] - h[c["a"]]))
        c["clear"] = c["deck_y"] - c["road_y"]
    if crossings:
        cl = np.asarray([c["clear"] for c in crossings])
        cross_stats.update(
            cross_clear_p05=float(np.percentile(cl, 5)),
            cross_clear_p50=float(np.percentile(cl, 50)),
            cross_under_min=int((cl < MIN_ROAD_CLEARANCE_M).sum()),
        )

    runs: list[DeckRun] = []
    for (road, _), sp, ids in zip(clipped, stations, node_of):
        if len(sp) < 2:
            continue
        runs.append(
            DeckRun(
                road=road,
                pts=sp,
                deck_y=h[ids].copy(),
                ground=ground[ids].copy(),
                half_width=_half_width(road),
            )
        )
    return (
        runs,
        {
            "nodes": int(n_nodes),
            "pinned": int(pinned.sum()),
            "components": int(n_comp),
            "unpinned_components": len(unpinned),
            **cross_stats,
        },
        crossings,
    )


# --- The crossing demand ---------------------------------------------------------


def _road_half_width(r: osm.OsmRoad) -> float:
    """Half the ribbon `streets.py` draws for a ground way, metres.

    `_half_width` without the edge beam, and read out of `streets.py` for the
    same reason that one is: the road a deck has to clear is as wide as the road
    that is drawn, and a second set of width constants here would drift.
    """
    return min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH) * 0.5


def _cross_point(a0, a1, b0, b1):
    """Where two plan segments cross, as `(t, u)` along each, or `None`.

    The bare parametric solve with no tolerance on either end, which is what the
    rule wants: a crossing that only happens if the segments are extended is a
    crossing that does not happen. Parallel segments return `None` rather than
    an interval -- two carriageways that lie along each other are not a grade
    separation, they are a dual carriageway, and neither owes the other room.
    """
    rx, rz = a1[0] - a0[0], a1[1] - a0[1]
    sx, sz = b1[0] - b0[0], b1[1] - b0[1]
    den = rx * sz - rz * sx
    if abs(den) < 1e-12:
        return None
    qx, qz = b0[0] - a0[0], b0[1] - a0[1]
    t = (qx * sz - qz * sx) / den
    u = (qx * rz - qz * rx) / den
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return t, u
    return None


def _foot(p, a, b):
    """The point on segment `a`-`b` nearest `p`, clamped to the segment."""
    abx, abz = b[0] - a[0], b[1] - a[1]
    den = abx * abx + abz * abz
    if den <= 0.0:
        return a[0], a[1]
    t = min(1.0, max(0.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / den))
    return a[0] + t * abx, a[1] + t * abz


def _cells(x0, z0, x1, z1, cell: float):
    """Every index cell a segment's bounding box touches."""
    for cx in range(math.floor(min(x0, x1) / cell), math.floor(max(x0, x1) / cell) + 1):
        for cz in range(math.floor(min(z0, z1) / cell), math.floor(max(z0, z1) / cell) + 1):
            yield cx, cz


# How many stations either side of a crossing are examined for the reach.
#
# The reach is `hw_deck + hw_road`, at most about 35 m for the widest pair in
# the extent, and a station is `STATION_M` = 6 m -- so six stations covers it and
# eight is the guard. A window rather than a scan of the whole run because a
# 3 km viaduct has 500 stations and every one of its crossings would otherwise
# walk all of them.
_REACH_STATIONS = 8


def _crossing_demand(clipped, stations, node_of, ground_roads, terrain, n_nodes):
    """Per deck node, the height that clears the roads it stands over.

    Returns `(demand, over_deck, stats)`. `demand` is `-inf` where nothing is
    crossed, so it composes with the ground floor by `np.maximum` and costs
    nothing where there is no crossing -- which is 97% of the nodes in the
    build. `over_deck` is the deck-over-deck half, kept as a list of
    `(upper node ids, lower node a, lower node b, t)` because the lower deck's
    height is not known until the loop has run; see `_stacked_demand`.

    **The predicate is the one `server/overpass-clearance-check.ts` uses**, and
    that identity is deliberate rather than convenient: the check reads the
    shipped `.lanes.bin` and asks whether two carriageways cross in plan without
    sharing a node, and if this pass answered a different question the two could
    both be right while the world stayed broken.
    """
    demand = np.full(n_nodes, -np.inf)
    over_deck: list[tuple[np.ndarray, int, int, float]] = []
    stats = {"cross_roads": 0, "cross_stacked": 0, "cross_nodes": 0}
    # One record per crossing, so the solve can report what it *achieved* rather
    # than only what it asked for. `server/overpass-clearance-check.ts` measures
    # the same thing from the shipped bytes; this is the same number seen before
    # the tiles are written, which is the only way to know whether a retile is
    # worth starting. See `DeckNetwork.crossings`.
    found: list[dict] = []

    # The deck stations' own occupancy, so the road index is built over the
    # handful of cells a deck can reach rather than over the whole city. 3,023
    # bridge ways against 410,405 road ways is the ratio this is exploiting.
    occupied: set[tuple[int, int]] = set()
    for sp in stations:
        for e, n in sp:
            for c in _cells(e - 40.0, n - 40.0, e + 40.0, n + 40.0, CROSS_CELL_M):
                occupied.add(c)

    # The road index: public ground carriageways only, and only their segments
    # that fall in a cell some deck could reach.
    road_bins: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for j, r in enumerate(ground_roads):
        line = r.line
        for i in range(len(line) - 1):
            for c in _cells(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1], CROSS_CELL_M):
                if c in occupied:
                    road_bins.setdefault(c, []).append((j, i))
    road_keys = [frozenset(_key(p) for p in r.line) for r in ground_roads]
    road_hw = [_road_half_width(r) for r in ground_roads]

    # The deck index, for the stacked half. Keyed the same way, over the runs.
    deck_bins: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for ri, sp in enumerate(stations):
        for i in range(len(sp) - 1):
            for c in _cells(sp[i][0], sp[i][1], sp[i + 1][0], sp[i + 1][1], CROSS_CELL_M):
                deck_bins.setdefault(c, []).append((ri, i))

    # (node id, foot point) pairs, gathered and sampled in one batch at the end:
    # `terrain.sample` on a million-post lattice is vectorised and calling it per
    # crossing was measured at two orders of magnitude slower than calling it
    # once.
    want_nodes: list[int] = []
    want_pts: list[tuple[float, float]] = []

    for ri, ((road, _), sp, ids) in enumerate(zip(clipped, stations, node_of)):
        hw_d = _half_width(road)
        deck_keys = frozenset(_key(p) for p in road.line)
        seen_pairs: set[tuple[int, int]] = set()
        for i in range(len(sp) - 1):
            a0, a1 = sp[i], sp[i + 1]
            cand: set[tuple[int, int]] = set()
            for c in _cells(a0[0], a0[1], a1[0], a1[1], CROSS_CELL_M):
                for dx in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        cand.update(road_bins.get((c[0] + dx, c[1] + dz), ()))
            for j, k in cand:
                r = ground_roads[j]
                hit = _cross_point(a0, a1, r.line[k], r.line[k + 1])
                if hit is None:
                    continue
                t, _u = hit
                px = a0[0] + t * (a1[0] - a0[0])
                pz = a0[1] + t * (a1[1] - a0[1])
                # A touchdown is not a crossing. The shared node is looked up by
                # coordinate, `_key`'s millimetre rule, so this is the same
                # identity `_solve` welds the graph with.
                shared = deck_keys & road_keys[j]
                if shared and any(
                    (px - q[0] / 1000.0) ** 2 + (pz - q[1] / 1000.0) ** 2
                    <= TOUCHDOWN_EXEMPT_M * TOUCHDOWN_EXEMPT_M
                    for q in shared
                ):
                    continue
                if (j, k) not in seen_pairs:
                    seen_pairs.add((j, k))
                    stats["cross_roads"] += 1
                found.append(
                    {
                        "e": float(px),
                        "n": float(pz),
                        "a": int(ids[i]),
                        "b": int(ids[i + 1]),
                        "t": float(t),
                        "under": r.name,
                        "under_class": r.highway,
                        "over": road.name or road.osm_id,
                        "foot": _foot((px, pz), r.line[k], r.line[k + 1]),
                    }
                )
                reach = hw_d + road_hw[j]
                lo = max(0, i - _REACH_STATIONS)
                hi = min(len(sp), i + _REACH_STATIONS + 2)
                for s in range(lo, hi):
                    dx = sp[s][0] - px
                    dz = sp[s][1] - pz
                    if dx * dx + dz * dz > reach * reach:
                        continue
                    want_nodes.append(int(ids[s]))
                    want_pts.append(_foot(sp[s], r.line[k], r.line[k + 1]))

        # --- the stacked half ------------------------------------------------
        #
        # Only where OSM's `layer` says which deck is upper. Two decks at the
        # same layer that cross in plan are a mapping oddity -- a ramp drawn
        # through its own flyover -- and inventing a winner would be this
        # module deciding something OSM is the authority on. See RAIL-VERTICAL
        # §3: OSM says what the structure is, and it is the only thing that can.
        for i in range(len(sp) - 1):
            a0, a1 = sp[i], sp[i + 1]
            cand2: set[tuple[int, int]] = set()
            for c in _cells(a0[0], a0[1], a1[0], a1[1], CROSS_CELL_M):
                for dx in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        cand2.update(deck_bins.get((c[0] + dx, c[1] + dz), ()))
            for rj, k in cand2:
                if rj == ri:
                    continue
                other = clipped[rj][0]
                if other.layer <= road.layer:
                    continue
                # `road` is the LOWER deck here, so the demand goes on `other`.
                osp = stations[rj]
                hit = _cross_point(a0, a1, osp[k], osp[k + 1])
                if hit is None:
                    continue
                t, u = hit
                px = a0[0] + t * (a1[0] - a0[0])
                pz = a0[1] + t * (a1[1] - a0[1])
                if frozenset(_key(p) for p in other.line) & deck_keys:
                    continue
                reach = _half_width(other) + hw_d
                lo = max(0, k - _REACH_STATIONS)
                hi = min(len(osp), k + _REACH_STATIONS + 2)
                up = [
                    int(node_of[rj][s])
                    for s in range(lo, hi)
                    if (osp[s][0] - px) ** 2 + (osp[s][1] - pz) ** 2 <= reach * reach
                ]
                if not up:
                    continue
                over_deck.append((np.asarray(up, dtype=np.int64), int(ids[i]), int(ids[i + 1]), t))
                stats["cross_stacked"] += 1

    if want_nodes:
        pts = np.asarray(want_pts, dtype=np.float64)
        under = np.asarray(terrain.sample(pts[:, 0], pts[:, 1]), dtype=np.float64).reshape(-1)
        need = under + streets.CARRIAGEWAY_Y + MIN_ROAD_CLEARANCE_M + GIRDER_DEPTH_M
        np.maximum.at(demand, np.asarray(want_nodes, dtype=np.int64), need)
    if found:
        fp = np.asarray([c["foot"] for c in found], dtype=np.float64)
        fy = np.asarray(terrain.sample(fp[:, 0], fp[:, 1]), dtype=np.float64).reshape(-1)
        for c, y in zip(found, fy):
            c["road_y"] = float(y) + streets.CARRIAGEWAY_Y
            del c["foot"]
    stats["cross_nodes"] = int(np.isfinite(demand).sum())
    return demand, over_deck, stats, found


def _pin_ceiling(h: np.ndarray, edge: np.ndarray, limit: np.ndarray, pinned: np.ndarray) -> np.ndarray:
    """How high the touchdowns and the grade ceiling will let a node be.

        ceiling(n) = min over pinned p of ( h(p) + TOUCHDOWN_RAMP_GRADE * dist(p, n) )

    ---------------------------------------------------------------------------
    **The precedence this function is, written down once, because all three of
    the things it arbitrates are things this module calls non-negotiable
    elsewhere.**

      1. **A touchdown wins.** It is a measurement of where the ground asphalt
         is, and the whole of `_lipschitz`'s docstring is about not moving it.
      2. **The grade ceiling wins next.** A deck that climbs 100% is not a
         steep bridge, it is a wall the player launches off; measured over the
         inner 8 km, asking for clearance without this cap produced 178
         segments over 25% and 39 over 100%, every one of them six metres of
         rise inside a single six-metre station next to a pin.
      3. **The clearance gives.** It is the newest rule and the only one of the
         three that is a *want* rather than a fact -- and where a ramp touches
         down twenty metres from the road it crosses, OSM is describing a
         structure that does not fit in the space OSM says it occupies. The
         shortfall is counted (`demand_unmet`) and named by
         `server/overpass-clearance-check.ts` rather than papered over.

    So the demand is capped here before it is rolled out by
    `_demand_envelope`, and the two together leave a profile that always obeys
    the touchdowns and the ceiling and clears everything it has room to clear.

    A component with no pin in it gets `inf` and is uncapped, which is right: it
    has no measurement to contradict.
    """
    ceil = np.where(pinned, h, np.inf)
    if len(edge) == 0:
        return ceil
    i, j = edge[:, 0], edge[:, 1]
    for _ in range(MAX_SWEEPS):
        before = ceil[np.isfinite(ceil)].sum(), int(np.isfinite(ceil).sum())
        np.minimum.at(ceil, j, ceil[i] + limit)
        np.minimum.at(ceil, i, ceil[j] + limit)
        if (ceil[np.isfinite(ceil)].sum(), int(np.isfinite(ceil).sum())) == before:
            break
    return ceil


def _demand_envelope(demand: np.ndarray, edge: np.ndarray, limit: np.ndarray) -> np.ndarray:
    """The gentlest profile that meets every demand: the demand, rolled out at 7%.

    ---------------------------------------------------------------------------
    **This function is the difference between a ramp and a cliff, and the first
    cut of the crossing rule did not have it.** The demand is a step -- six
    metres at the four stations over the road and nothing at the fifth -- and
    handing a step to the alternating loop does not smooth it: `_lipschitz`
    averages a downward projection with an upward one, so it *lowers the peak*
    as much as it raises the shoulder, and the floor at the end of the round
    puts the peak straight back. Measured over the inner 8 km, that solve
    produced a maximum deck grade of **229%** against 40% before the rule, with
    725 of 7,578 segments over the 7% ceiling. A vertical wall in a motorway is
    not a better bug than a motorway lying in the street.

    So the demand is made grade-feasible *before* it becomes a floor. This is
    the standard lower envelope under a Lipschitz condition,

        env(n) = max over demanded d of ( demand(d) - MAX_GRADE * dist(d, n) )

    computed as a min-plus relaxation over the deck graph -- which is the same
    sweep `_lipschitz` runs, one-sided and outward instead of two-sided and
    inward. Its output already obeys the ceiling everywhere, so the clamp that
    follows has nothing to pull down and the demand survives the round.

    `-inf` means "no demand here" and propagates as itself, so a graph with no
    crossing in it costs one sweep and returns unchanged.

    Convergence is bounded by the reach of the tallest demand rather than by
    `MAX_SWEEPS`: six metres at 7% is 86 m, which is fourteen stations, so the
    early exit fires long before the cap. The cap is the guard, as it is above.
    """
    env = demand.copy()
    if len(edge) == 0 or not np.isfinite(env).any():
        return env
    i, j = edge[:, 0], edge[:, 1]
    for _ in range(MAX_SWEEPS):
        before = env[np.isfinite(env)].sum(), int(np.isfinite(env).sum())
        np.maximum.at(env, j, env[i] - limit)
        np.maximum.at(env, i, env[j] - limit)
        if (env[np.isfinite(env)].sum(), int(np.isfinite(env).sum())) == before:
            break
    return env


def _stacked_demand(h: np.ndarray, over_deck: list, n_nodes: int) -> np.ndarray:
    """What the decks underneath demand, at the profile's *current* height.

    Recomputed every round rather than pinned once, which is what makes a
    three-level interchange settle: the middle deck rises off the street, and
    the top one then rises off the middle. At 39 crossings in the whole extent
    the cost of doing it inside the loop is nothing, and doing it outside would
    have stacked the top deck on where the middle one started.
    """
    out = np.full(n_nodes, -np.inf)
    for up, a, b, t in over_deck:
        low = h[a] + t * (h[b] - h[a])
        np.maximum.at(out, up, low + MIN_ROAD_CLEARANCE_M + GIRDER_DEPTH_M)
    return out


def _half_width(r: osm.OsmRoad) -> float:
    """Half the structure, metres -- the carriageway plus its edge beam.

    The carriageway half is `streets.py`'s own clamp, read from that module so
    the deck and the ground road it meets are the same width at the touchdown
    and the seam between them is a seam rather than a step sideways.
    """
    lane = min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH) * 0.5
    return lane + EDGE_MARGIN_M


def _stations(pts: np.ndarray, seen: dict, ground_nodes: set) -> tuple[np.ndarray, np.ndarray]:
    """Uniform stations along a run, with every junction vertex folded in.

    `roadgrade._graph`'s rule, and for its reason: a T-junction into the middle
    of a way has to land *on* a station or the two ways cannot share an unknown.
    A junction always wins the slot it lands in, and a uniform station within a
    metre of one is dropped -- a 1 cm edge would be a weld the smoother cannot
    tell from a real one.
    """
    step = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate(([0.0], np.cumsum(step)))
    total = float(s[-1])
    want = list(np.linspace(0.0, total, max(round(total / STATION_M) + 1, 2)))
    forced: dict[float, bool] = {}
    for k, p in enumerate(pts):
        key = _key(p)
        if seen.get(key, 0) > 1 or key in ground_nodes or k in (0, len(pts) - 1):
            want.append(float(s[k]))
            forced[round(float(s[k]), 6)] = True
    want.sort()
    keep = [want[0]]
    for v in want[1:]:
        if v - keep[-1] > 1.0:
            keep.append(v)
        elif round(v, 6) in forced:
            keep[-1] = v
    ss = np.asarray(keep)
    idx = np.clip(np.searchsorted(s, ss, side="right") - 1, 0, len(step) - 1)
    frac = (ss - s[idx]) / np.where(step[idx] > 0.0, step[idx], 1.0)
    return ss, pts[idx] + (pts[idx + 1] - pts[idx]) * frac[:, None]


def _components(edge: np.ndarray, n: int, pinned: np.ndarray):
    """Connected components of the deck graph, and which of them hold no pin."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    if len(edge) == 0:
        return np.arange(n), n, [c for c in range(n) if not pinned[c]]
    g = coo_matrix(
        (np.ones(len(edge)), (edge[:, 0], edge[:, 1])), shape=(n, n)
    )
    n_comp, labels = connected_components(g, directed=False)
    has_pin = np.zeros(n_comp, dtype=bool)
    np.logical_or.at(has_pin, labels, pinned)
    return labels, n_comp, [int(c) for c in np.flatnonzero(~has_pin)]


def _harmonic(h: np.ndarray, edge: np.ndarray, elen: np.ndarray, pinned: np.ndarray) -> np.ndarray:
    """Interpolate the free nodes from the pinned ones over the graph.

    Minimises `sum_edges (h_j - h_i)^2 / len` with the pinned values held, which
    on a straight chain between two touchdowns is a constant grade and on a
    branch hanging off one is flat at the junction's height. That second case is
    the one worth naming: a ramp gore where three bridge ways meet and only the
    trunk reaches the ground gets the trunk's height across the whole gore, which
    is what a gore is -- one surface, not three.

    Conjugate gradients on the free block, with the same argument
    `roadgrade._smooth` makes for it: the operator is symmetric positive definite
    once a component holds a pin, it never materialises a fill-in, and a fixed
    sequence of dot products on a fixed input returns the same floats every run.
    """
    free = ~pinned
    if not free.any() or len(edge) == 0:
        return h
    w = 1.0 / elen
    i, j = edge[:, 0], edge[:, 1]
    n = len(h)

    def lap(x: np.ndarray) -> np.ndarray:
        flow = w * (x[i] - x[j])
        return np.bincount(i, weights=flow, minlength=n) - np.bincount(
            j, weights=flow, minlength=n
        )

    fixed = np.where(pinned, h, 0.0)
    b = -lap(fixed)[free]
    diag = (np.bincount(i, weights=w, minlength=n) + np.bincount(j, weights=w, minlength=n))[free]
    diag = np.where(diag > 0.0, diag, 1.0)

    def matvec(xf: np.ndarray) -> np.ndarray:
        full = np.zeros(n)
        full[free] = xf
        return lap(full)[free]

    x = h[free].copy()
    r = b - matvec(x)
    m = 1.0 / diag
    zr = m * r
    p = zr.copy()
    rz = float(r @ zr)
    for _ in range(MAX_CG):
        if rz <= 1e-14 * max(len(b), 1):
            break
        ap = matvec(p)
        denom = float(p @ ap)
        if abs(denom) < 1e-300:
            break
        alpha = rz / denom
        x += alpha * p
        r -= alpha * ap
        zr = m * r
        rz_next = float(r @ zr)
        p = zr + (rz_next / rz) * p
        rz = rz_next
    out = h.copy()
    out[free] = x
    return out


def _lipschitz(
    h: np.ndarray, edge: np.ndarray, limit: np.ndarray, pinned: np.ndarray
) -> np.ndarray:
    """The nearest profile obeying every edge's height budget, pins held fixed.

    `roadgrade._lipschitz`'s two one-sided projections and their average, with
    one difference that is the whole reason this is not a call into that module:
    **the pinned nodes are restored after every sweep.** A touchdown is a
    measurement of where the ground asphalt is, and a projection that moved it to
    satisfy a grade ceiling would buy a gentler ramp with a step at the bottom of
    it -- which is the one defect a player can feel and cannot see.

    So the budget is honoured everywhere it can be and gives way at a touchdown
    that genuinely demands more, which is the right way round: the Cahill
    Expressway's ramps really do climb 5.5% out of a portal that really is where
    it is.
    """
    if len(edge) == 0:
        return h
    i, j = edge[:, 0], edge[:, 1]
    hold = h[pinned]

    def relax(sign: float) -> np.ndarray:
        out = (sign * h).copy()
        held = sign * hold
        for _ in range(MAX_SWEEPS):
            before = out.sum()
            np.minimum.at(out, j, out[i] + limit)
            np.minimum.at(out, i, out[j] + limit)
            out[pinned] = held
            if out.sum() == before:
                break
        return sign * out

    return 0.5 * (relax(1.0) + relax(-1.0))


# --- Geometry ------------------------------------------------------------------


def _mitred_ring(
    pts: np.ndarray, left: np.ndarray, i: int, half: float, offset: float = 0.0
) -> np.ndarray:
    """The plan rectangle a segment's **drawn** geometry occupies, in ENU.

    ---------------------------------------------------------------------------
    **THE COLLISION POLYGON IS THE DRAWN POLYGON**, which is `tiles.write_collision`'s
    contract in its own capitals, and until this function existed a deck broke
    it on every curve.

    `_emit_run` builds each edge from `_frames`' **per-station** normal, which is
    the average of the two segments meeting there -- the mitre, and the whole
    reason it is averaged is written in `_frames`: without it "the ribbon's
    edges step sideways by the width of the deck times the turn angle" at every
    bend. `prisms` built its rings from `_segment_ring`, which uses the
    **segment's own** normal. The two agree exactly on a straight run and part
    company on a curve by `offset * theta`, where theta is the turn at the
    station -- so on a tight ramp with a 5.6 m half width and 7 degrees of turn
    per station, the solid is **0.85 m** from the barrier the player can see.
    Measured on the shipped bake at the Warringah Freeway onramp at Cammeray
    (370.6, -4584.3): the parapet prism's four corners had their nearest drawn
    vertex 0.67, 0.79, 0.85 and 0.71 m away, and not one deck-slot vertex fell
    inside the ring at all. `server/undrawn-solids-check.ts` reported 17 of
    these network-wide and read them as parapets that were never drawn; they
    were drawn, 0.8 m to the left.

    A parapet is the case that shows up because its ring is 0.40 m across and
    the whole ring misses. The **deck** ring misses by the same 0.8 m and does
    not show up, because an 11 m ring still overlaps the geometry -- which is
    worse, not better: it is 0.8 m of solid off the edge of a viaduct with
    nothing drawn under it, and 0.8 m of drawn deck on the other edge with
    nothing solid.

    So both come from here, and there is one frame in the module.
    """
    a, b = pts[i], pts[i + 1]
    la, lb = left[i], left[i + 1]
    return np.asarray(
        [
            a + la * (offset - half),
            b + lb * (offset - half),
            b + lb * (offset + half),
            a + la * (offset + half),
        ],
        dtype=np.float64,
    )


def _segment_ring(a: np.ndarray, b: np.ndarray, half: float, offset: float = 0.0) -> np.ndarray:
    """A plan rectangle covering one segment, `2 * half` wide, in ENU.

    `offset` slides it across the deck, which is what puts a parapet's volume on
    the edge rather than down the middle.

    **Not for anything that also gets drawn** -- see `_mitred_ring`, which is
    what the collision rings use now. This one survives for `_emit_piers`, where
    the same ring is both the volume and the geometry so there is nothing to
    disagree with.
    """
    d = b - a
    n = float(np.hypot(d[0], d[1]))
    u = d / n if n > 1e-9 else np.array([1.0, 0.0])
    left = np.array([-u[1], u[0]])
    c = left * offset
    return np.asarray(
        [
            a + c - left * half,
            b + c - left * half,
            b + c + left * half,
            a + c + left * half,
        ],
        dtype=np.float64,
    )


def _frames(pts: np.ndarray) -> np.ndarray:
    """Unit left-of-travel plan normals at each station.

    Averaged across the two segments meeting at a station, so the ribbon's edges
    are continuous through a bend instead of stepping sideways by the width of
    the deck times the turn angle.
    """
    d = np.diff(pts, axis=0)
    n = np.hypot(d[:, 0], d[:, 1])
    u = d / np.where(n[:, None] > 1e-9, n[:, None], 1.0)
    acc = np.zeros_like(pts)
    acc[:-1] += u
    acc[1:] += u
    m = np.hypot(acc[:, 0], acc[:, 1])
    u = acc / np.where(m[:, None] > 1e-9, m[:, None], 1.0)
    return np.column_stack((-u[:, 1], u[:, 0]))


def _w(e: float, n: float, y: float, origin: tuple[float, float]) -> np.ndarray:
    """ENU + height -> the renderer's frame. x = east, y = up, z = -north."""
    return np.array([e - origin[0], y, -(n - origin[1])])


def _quad(buf, p0, p1, p2, p3, normal, origin) -> None:
    """One planar quad, wound so its face agrees with `normal`.

    The winding is *derived* rather than asserted: the cross product of the first
    two edges is tested against the intended normal and the ring reversed if they
    disagree. Every face in this module is built from a frame that flips sign
    with the direction of travel and with which side of the deck it is on, and
    working each of those out by hand is how a hole appears in one viaduct out of
    forty with nothing in the output to say so. `winding-audit` checks the
    result; this is what makes it pass by construction.

    UVs are in **world** metres, not tile-local, which is `streets._world_uv`'s
    convention and is load-bearing for the same reason: a deck's asphalt has to
    run in step with the asphalt it meets at the touchdown, and 500 m is not a
    whole number of lane markings. A vertical face takes its second coordinate
    from height, so the formwork joints on a fascia stay level.
    """
    pts = [np.asarray(p, dtype=np.float64) for p in (p0, p1, p2, p3)]
    nrm = np.asarray(normal, dtype=np.float64)
    mag = float(np.linalg.norm(nrm))
    if mag < 1e-12:
        return
    nrm = nrm / mag
    face = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    if float(face @ nrm) < 0.0:
        pts = pts[::-1]
    verts = np.asarray(pts)
    wx = verts[:, 0] + origin[0]
    wz = verts[:, 2] - origin[1]
    if abs(nrm[1]) > 0.7:
        uv = np.column_stack((wx, wz))
    else:
        uv = np.column_stack((wx + wz, verts[:, 1]))
    buf.add_surface(verts, np.tile(nrm, (4, 1)), uv, np.asarray([[0, 1, 2], [0, 2, 3]]))


def _box(buf, ring: np.ndarray, base: float, top: float, origin) -> None:
    """A vertical prism from a plan ring -- the piers, and nothing else."""
    n = len(ring)
    centre = ring.mean(axis=0)
    for k in range(n):
        a, b = ring[k], ring[(k + 1) % n]
        mid = 0.5 * (a + b)
        out = mid - centre
        _quad(
            buf,
            _w(a[0], a[1], base, origin),
            _w(b[0], b[1], base, origin),
            _w(b[0], b[1], top, origin),
            _w(a[0], a[1], top, origin),
            (out[0], 0.0, -out[1]),
            origin,
        )


def _emit_run(slots, run: DeckRun, lo: int, hi: int, origin) -> None:
    """One tile's share of one deck: surface, girder, parapets and piers."""
    deck = slots[SLOT_DECK]
    struct = slots[SLOT_STRUCTURE]
    pts = run.pts
    left = run.frames
    hw = run.half_width
    dy = run.deck_y
    clear = run.clearance
    # The soffit, clamped so an at-grade crossing draws an edge beam instead of
    # burying a metre of girder in the terrain. See `GIRDER_BURY_M`.
    soffit = np.maximum(
        dy - GIRDER_DEPTH_M, np.minimum(run.ground - GIRDER_BURY_M, dy - 0.05)
    )

    def edge_pt(i: int, side: float, y: float) -> np.ndarray:
        p = pts[i] + left[i] * (side * hw)
        return _w(p[0], p[1], y, origin)

    # The parapet's height per station: zero where the deck is a piece of road
    # over a pipe, full on the span, and grown between the two over
    # `PARAPET_RAMP_M` from whichever end of a barrier run is nearer. See
    # that constant.
    n_st = len(dy)
    allowed = np.array([clear[k] >= PARAPET_MIN_CLEARANCE_M for k in range(n_st)], dtype=bool)
    step = np.hypot(*np.diff(pts, axis=0).T) if n_st > 1 else np.zeros(0)
    chain = np.concatenate(([0.0], np.cumsum(step)))
    para = np.zeros(n_st)
    k = 0
    while k < n_st:
        if not allowed[k]:
            k += 1
            continue
        k2 = k
        while k2 + 1 < n_st and allowed[k2 + 1]:
            k2 += 1
        c0 = chain[k]
        c1 = chain[k2]
        for m in range(k, k2 + 1):
            grow = min((chain[m] - c0) / PARAPET_RAMP_M, (c1 - chain[m]) / PARAPET_RAMP_M, 1.0)
            # A short barrier run grows to what its length allows and no
            # further; a run under two ramps' worth peaks in the middle.
            para[m] = PARAPET_HEIGHT_M * max(0.0, grow)
        k = k2 + 1

    for i in range(lo, hi):
        j = i + 1
        # Running surface, up.
        _quad(
            deck,
            edge_pt(i, -1.0, dy[i]), edge_pt(j, -1.0, dy[j]),
            edge_pt(j, 1.0, dy[j]), edge_pt(i, 1.0, dy[i]),
            (0.0, 1.0, 0.0), origin,
        )
        # Soffit, down.
        _quad(
            struct,
            edge_pt(i, -1.0, soffit[i]), edge_pt(j, -1.0, soffit[j]),
            edge_pt(j, 1.0, soffit[j]), edge_pt(i, 1.0, soffit[i]),
            (0.0, -1.0, 0.0), origin,
        )
        # The two fascias.
        for side in (1.0, -1.0):
            out = left[i] * side
            _quad(
                struct,
                edge_pt(i, side, soffit[i]), edge_pt(j, side, soffit[j]),
                edge_pt(j, side, dy[j]), edge_pt(i, side, dy[i]),
                (out[0], 0.0, -out[1]), origin,
            )
        if para[i] <= 0.01 and para[j] <= 0.01:
            continue
        # Parapets: a solid barrier standing on the deck's own edge, at the
        # height `para` grew it to. Three faces -- outer, inner and cap -- and
        # no end caps, because consecutive segments abut and a barrier run's
        # two ends have grown down to nothing.
        for side in (1.0, -1.0):
            out = left[i] * side
            outer = side * hw
            inner = side * (hw - PARAPET_THICK_M)
            for off, nrm in ((outer, out), (inner, -out)):
                _quad(
                    struct,
                    edge_pt(i, off / hw, dy[i]), edge_pt(j, off / hw, dy[j]),
                    edge_pt(j, off / hw, dy[j] + para[j]),
                    edge_pt(i, off / hw, dy[i] + para[i]),
                    (nrm[0], 0.0, -nrm[1]), origin,
                )
            _quad(
                struct,
                edge_pt(i, inner / hw, dy[i] + para[i]),
                edge_pt(j, inner / hw, dy[j] + para[j]),
                edge_pt(j, outer / hw, dy[j] + para[j]),
                edge_pt(i, outer / hw, dy[i] + para[i]),
                (0.0, 1.0, 0.0), origin,
            )

    _emit_piers(struct, run, lo, hi, soffit, origin)


def _emit_piers(struct, run: DeckRun, lo: int, hi: int, soffit, origin) -> None:
    """Rectangular piers to the ground, on the stations that carry one.

    Placed on stations rather than at a fixed chainage so a pier is always under
    a solved height rather than under an interpolation of two, and only where the
    soffit genuinely clears the ground -- a pier under an at-grade crossing is a
    block of concrete standing in the road.

    Piers stand **in water** wherever the deck does, and that is correct rather
    than tolerated: the Western Distributor's viaduct through Darling Harbour is
    carried on piers in the bay, and so is every other bridge in this extent that
    crosses one.
    """
    pts = run.pts
    step = np.hypot(*np.diff(pts, axis=0).T)
    chain = np.concatenate(([0.0], np.cumsum(step)))
    every = max(round(PIER_SPACING_M / STATION_M), 1)
    for i in range(lo, hi + 1):
        if i == 0 or i == len(pts) - 1:
            continue
        if round(float(chain[i]) / STATION_M) % every:
            continue
        if soffit[i] - run.ground[i] < PIER_MIN_CLEARANCE_M:
            continue
        ring = _segment_ring(
            pts[i] - _along(pts, i) * PIER_ALONG_M * 0.5,
            pts[i] + _along(pts, i) * PIER_ALONG_M * 0.5,
            PIER_ACROSS_M * 0.5,
        )
        _box(struct, ring, float(run.ground[i] - PIER_BURY_M), float(soffit[i]), origin)


def _along(pts: np.ndarray, i: int) -> np.ndarray:
    d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
    n = float(np.hypot(d[0], d[1]))
    return d / n if n > 1e-9 else np.array([1.0, 0.0])


def verify_decks() -> list[str]:
    """The restation's one claim, and the reason it is the fix rather than a fix.

    `_restation_steep` is allowed to change the collision staircase and nothing
    else. If it moved the surface it would be redrawing every steep bridge in
    Sydney as a side effect of making them climbable, and the way that failure
    presents is a deck that is fine everywhere the check looked and 20 cm out
    where it did not -- which is exactly the class of thing a self-check exists
    for and eyes do not.

    So: build a run whose profile is a ramp too steep for 6 m stations, restation
    it, and assert the surface is the same surface -- every original station still
    there at its original height, every inserted one exactly on the line between
    its neighbours, the plan length unchanged -- and that the steps are now inside
    the budget. Made-up geometry and a made-up ground, so it costs microseconds.
    """
    failures: list[str] = []

    # A 60 m ramp at 20%: 10 stations of 6 m, each a 1.2 m step. Nothing climbs it.
    n = 11
    pts = np.column_stack((np.linspace(0.0, 60.0, n), np.zeros(n)))
    deck = np.linspace(0.0, 12.0, n)
    ground = np.zeros(n)

    class _Flat:
        @staticmethod
        def sample(e, north):
            return np.zeros(np.shape(e))

    run = DeckRun(road=None, pts=pts, deck_y=deck, ground=ground, half_width=5.0)
    out = _restation_steep(run, _Flat)

    step = np.abs(np.diff(out.deck_y))
    if step.size and step.max() > MAX_STEP_M + 1e-9:
        failures.append(
            f"the restation left a {step.max():.3f} m step against a {MAX_STEP_M} m budget"
        )
    if len(out.pts) <= len(pts):
        failures.append("the restation inserted no stations into a 20% ramp")

    # The surface, sampled by chainage against the original profile. This is the
    # claim: interpolating a piecewise-linear profile at points on its own
    # segments reproduces it exactly.
    def _profile(p, y, at):
        chain = np.concatenate(([0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))))
        return np.interp(at, chain, y)

    probe = np.linspace(0.0, 60.0, 601)
    before = _profile(pts, deck, probe)
    after = _profile(out.pts, out.deck_y, probe)
    if not np.allclose(before, after, atol=1e-9):
        worst = float(np.abs(before - after).max())
        failures.append(f"the restation moved the drawn deck by up to {worst:.4f} m")

    # Every original station survives, in place. A restation that resampled the
    # run uniformly would pass the profile test above and fail this one, and it
    # would have thrown away the solved touchdown pins to do it.
    for i in range(n):
        j = int(np.argmin(np.abs(out.pts[:, 0] - pts[i, 0])))
        if abs(out.pts[j, 0] - pts[i, 0]) > 1e-9 or abs(out.deck_y[j] - deck[i]) > 1e-9:
            failures.append(f"the restation lost the solved station at chainage {pts[i, 0]:.1f}")
            break

    plan_before = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    plan_after = float(np.hypot(*np.diff(out.pts, axis=0).T).sum())
    if abs(plan_before - plan_after) > 1e-9:
        failures.append(f"the restation changed the plan length: {plan_before} -> {plan_after}")

    # A run that is gentle everywhere except one segment. The uniform ramp above
    # cannot tell "cut the steep segment" apart from "cut every segment by the
    # worst ratio", and the second is what a deck with one bad touchdown and 200 m
    # of flat viaduct behind it would get -- forty times the prisms for the flat
    # part, to fix six metres of it.
    mixed_pts = np.column_stack((np.linspace(0.0, 60.0, n), np.zeros(n)))
    mixed_y = np.zeros(n)
    mixed_y[5:] = 2.0  # one 2 m step in the middle, flat either side
    mixed = _restation_steep(
        DeckRun(road=None, pts=mixed_pts, deck_y=mixed_y, ground=ground, half_width=5.0),
        _Flat,
    )
    if np.abs(np.diff(mixed.deck_y)).max() > MAX_STEP_M + 1e-9:
        failures.append("the restation left the one steep segment of a mixed run over budget")
    want_most = n + int(np.ceil(2.0 / MAX_STEP_M)) - 1
    if len(mixed.pts) > want_most:
        failures.append(
            f"a run with one steep segment came back with {len(mixed.pts)} stations, not"
            f" {want_most}: the whole run was subdivided to fix six metres of it"
        )

    # A gentle run is returned untouched -- identity, not a rebuild, because a
    # rebuild would resample `ground` for 176 km of deck to no purpose.
    easy = DeckRun(
        road=None,
        pts=pts,
        deck_y=np.linspace(0.0, 1.0, n),
        ground=ground,
        half_width=5.0,
    )
    if _restation_steep(easy, _Flat) is not easy:
        failures.append("a deck already inside the step budget was rebuilt anyway")

    # And the two numbers this all rests on, against the collision they are for.
    # `driving.NOSE_STEP` is 0.42 and `CollisionWorld.solidFor` gives 0.05 more.
    if MAX_STEP_M >= 0.42 + 0.05:
        failures.append(
            f"MAX_STEP_M {MAX_STEP_M} is not under the 0.47 m a body climbs, so the"
            " budget does not buy anything"
        )
    # The budget is *deliberately* tighter than the station design -- 6 m at the 7%
    # ceiling steps 0.42 m and the budget is 0.35 -- so a deck at the ceiling is
    # restationed on purpose and that is not the thing to check for. What would be
    # a mistake is a budget so tight that the restation stops being a repair for
    # steep runs and becomes a blanket resampling of all 176 km: at a third of the
    # ceiling step, every deck in the city is subdivided to buy nothing.
    if MAX_STEP_M * 3 < STATION_M * MAX_GRADE:
        failures.append(
            f"MAX_STEP_M {MAX_STEP_M} is under a third of a {STATION_M} m station at"
            f" the {MAX_GRADE:.0%} ceiling ({STATION_M * MAX_GRADE:.2f} m), so this is"
            " no longer a repair for steep runs -- it resamples the whole network"
        )
    return failures
