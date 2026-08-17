"""The front fence: the line between the footpath and the garden.

Every detached house and every setback terrace in this world rises straight out
of bare dirt. There is a footpath, and then there is a wall, and nothing at all
in between -- which is not what an Australian residential street looks like from
any angle. The threshold is the *whole* character of one: a 0.75 m rendered
masonry wall with a gap in it, or a wrought-iron palisade with a gate post, or
white timber pickets, standing three to eight metres in front of the house with
a garden behind. It is the layer that says a house is a house rather than a
massing block with windows on it, and it is the only element of a residential
frontage this build has never had.

So this module puts one on every residential building that stands back off its
street. It emits geometry -- unlike the front doors, which are a shader feature
because a door is a hole in a wall that already exists, where a fence is a
freestanding object with nothing to draw it on.

---------------------------------------------------------------------------
Five decisions carry the module.

**The fence stands at the property line, and the property line is derived rather
than guessed.** `streets.py` builds a footpath as a band `half_width +
footpath_width` either side of a centreline, with the kerb carved out of the
inner edge of it -- so the far side of the paving, which is where a title
boundary is, sits exactly `footpath_width` beyond the edge of the carriageway.
`mesh._street_ahead_way` measures the wall-to-carriageway gap and says which way
it found; subtracting that way's own `footpath_width` puts the fence on the line
without this module owning a single number about how wide a footpath is.

**Setback is the qualifying test, and it is what excludes the terraces without a
list.** A zero-lot Surry Hills terrace is built to the boundary: its front wall
*is* the property line, there is no garden, and a fence in front of it would
stand in the middle of the footpath. That is not a class of building to be
enumerated, it is a measurement -- `MIN_SETBACK` of it -- and the same
measurement admits the Paddington terraces that do have a 3 m front garden and
a palisade fence, which any archetype-based rule would have got wrong in both
directions. Retail is excluded outright and that one *is* a rule: a shopfront
sits on the line by definition and no amount of setback makes a fence in front
of a shop correct.

**The style is per building, like the paint, and that is why there are three
slots.** `attributes.MATERIAL_MIX` exists because 6,973 of 6,982 terraces coming
out the same red made whole streets read as one flat tone; a street where every
house has the same fence has exactly that failure in a different material. But a
fence is also a *continuous run* of 6 to 20 m, so the variation cannot come from
a world-position hash in the shader the way `awning_fascia`'s signage colour
does -- that lattice changes colour every 8 m, which on a fascia is a shopfront
and on a fence is a masonry wall turning into pickets halfway along a garden.
The pipeline is the only thing that knows where one building's frontage ends, so
the pipeline chooses, and a material slot is how it says so without a parameter
fetch. See `MASONRY_SLOT_NOTE` for the other half of that argument.

**The gate is a gap, and the gap is aligned to the front door.** A fence with no
way through it is a wall, and a gate that does not line up with the path to the
door is worse than no gate -- it is a fence that has been placed by something
that has never seen the house. `DoorNetwork` already resolved which wall this
building is addressed on and where along it the door stands, so the gate takes
both: the same edge by construction (`DoorNetwork.front_edge` is what chooses it
for either feature) and the door's own `u` projected straight out to the fence
line. No gate leaf is emitted. A suburban front gate stands open, a closed one
is 6 triangles of hinge geometry nobody will look at, and the gap between two
posts is what reads.

**It follows the terrain, and only where the terrain bends.** The ground the
client draws is piecewise planar -- two triangles per 31.25 m lattice cell -- so
a straight fence panel between two consecutive facet crossings is exactly
parallel to the ground under it, and a subdivision finer than that buys nothing
at all. This is `streets.py`'s conforming argument and `contact.py`'s, applied
to a line: `terrain.densify` inserts a station at every crossing and the median
fence gets none, because a 12 m frontage inside one 31 m facet is one panel.
A uniform 2.5 m subdivision was the obvious alternative and it is four times the
triangles for zero improvement in a measurable quantity.

---------------------------------------------------------------------------
NO COLLISION, deliberately, and it is the same call `parking.py`, `power.py` and
`furniture.py` already made from their own directions: the payload is the
building prisms, and adding to it is a format change and a server change. Here
it is also a gameplay argument rather than only a scoping one -- 0.75 to 1.0 m
is vaultable, a melee game wants a player to be able to cut through a front
garden, and a city of waist-high fences you cannot cross is a city of corridors.
The follow-up worth naming is the opposite one: if fences ever *do* enter the
payload they should enter it as something you can jump, not as a wall.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from . import mesh, streets
from .merge import Building
from .streets import StreetNetwork

# --- Why the masonry fence is not on a wall slot ------------------------------

MASONRY_SLOT_NOTE = """
A 0.75 m masonry fence emitted on `brick_red` or `render_painted` would be the
cheapest possible implementation -- no new slot, no new shader, and the brick
and the mortar and the per-building tint all for free. It was checked against
what those pipelines actually draw at `v` in [0, 0.75], with this build's own
parameters, and it fails on three counts of which the first is fatal:

  * THE FRONT DOOR. `facade.doorNode` draws a 1.0 m opening from the threshold
    to a head at 2.1 m, at the `u` the parameter record names, on every building
    that has one -- which is 29,901 of 33,844. A fence carries its own `u`,
    metres along the fence, which has no relationship to the wall's; wherever
    the two happened to coincide the shader would paint a slice of that house's
    front door across its own front fence. There is no parameter setting that
    turns this off: the door is `DOOR_NONE` or it is drawn.

  * THE PLINTH AND THE CONTACT TOE. `smoothstep(0, 0.65)` and `smoothstep(0,
    0.4)` between them cover the entire height of a 0.75 m fence, so the whole
    object would render as one continuous darkening ramp -- the bottom of a wall
    with no wall above it, at 0.68 of the albedo at its base.

  * THE WINDOW BAND is the one that is actually safe, and only just, and only by
    accident. Ground-storey sills are 0.9 m on `terrace` and `walkup` and 1.0 m
    on `federation`, `interwar_apartment` and `brick_veneer`, so a 0.75 m fence
    clears the lowest of them by 150 mm. But `b.retail` swaps the whole
    ground-floor grammar for the shopfront override at sill 0.35 and head 3.45,
    and a corner-shop terrace is a `terrace` with `retail` set. Fences are
    withheld from retail buildings anyway, so nothing draws glazing on a fence
    today -- but "today" is doing the work in that sentence, and a coupling that
    survives only because of an unrelated exclusion elsewhere is exactly the kind
    that breaks in a year with no error message.

`fence_masonry` is therefore its own slot and its own small shader. It costs one
more pipeline, which is the cheapest thing in this file, and it buys a surface
whose whole grammar -- coping, render, a pier -- was chosen for a fence.
"""

# --- Slots --------------------------------------------------------------------

SLOT_MASONRY = "fence_masonry"
SLOT_IRON = "fence_iron"
SLOT_TIMBER = "fence_timber"

# --- Which buildings ----------------------------------------------------------

# The residential stock. `retail_strip`, `warehouse`, `tower`, `brutalist` and
# `modern_infill` are absent for four different reasons that come to the same
# thing: none of them has a front garden. A shop and a warehouse sit on the
# boundary, a tower has a plaza, and a post-2000 infill block has a driveway and
# a bin store behind a security gate, which is a different object.
FENCE_ARCHETYPES = frozenset(
    {"terrace", "federation", "interwar_apartment", "walkup", "brick_veneer"}
)

# How far the search for a street reaches, metres from the wall to the edge of
# the carriageway. The same number the front doors use, and for the same reason
# `DOOR_MAX_KERB` gives: the pick is the *nearest* qualifying street, so a wider
# reach can only admit a building that had no answer and can never re-decide one
# that did. It has to be this generous because a deep-setback interwar block on
# a wide arterial genuinely is 15 m off the kerb.
FENCE_MAX_KERB = mesh.DOOR_MAX_KERB

# Laneways are excluded and there is no second tier, which is where this departs
# from the front doors. A door has to go *somewhere* -- a house with no way into
# it is wrong in a way a house with no fence is not -- so `DoorNetwork` falls
# back to a lane and then to the longest edge. A fence has no such obligation:
# a building whose only frontage is a 3 m service lane is a rear-lot terrace or
# a warehouse dock, and neither has a front garden. Withholding is the right
# answer and it is free.
FENCE_EXCLUDE_CLASSES = mesh.DOOR_EXCLUDE_CLASSES

# The setback below which there is no fence, metres from the wall to the far
# side of the footpath.
#
# THIS IS THE TEST THAT SEPARATES A TERRACE FROM A HOUSE and it is a measurement
# rather than a list. A zero-lot terrace's front wall stands on the property
# line, so its setback is zero or a few centimetres of float noise; a Paddington
# terrace with a front garden measures 2 to 4 m and gets a palisade fence, which
# is exactly right and which no archetype rule would have produced. 1.2 m is
# below any real front garden and above the noise: the widest source of error
# here is that `_street_ahead_way` measures to a *simplified* centreline, and
# `SIMPLIFY_STREET` is 0.25 m.
MIN_SETBACK = 1.2

# ...and the ceiling. Past this the "front garden" is a car park, a school oval
# or a mis-segmented footprint whose wall is nowhere near the street it matched,
# and a fence 20 m out in a field is a wall in a field. Counted rather than
# silently clamped, because a large count here would mean the edge choice is
# picking the wrong street.
MAX_SETBACK = 9.0

# Frontages shorter than this get nothing. Below a gate's width plus a leaf
# either side there is no fence to draw, only a gate, and a 2 m frontage is a
# footprint fragment rather than a house. `AWNING_MIN_EDGE` is 2.2 for the
# equivalent reason.
MIN_FRONTAGE = 2.6

# The gap that is the gate, metres, and the shortest leaf worth leaving beside
# it. A 900 mm opening is the Australian domestic standard and it is also what
# `DOOR_WIDTH` implies -- a metre of door opening behind a gate you can walk
# through with it.
GATE_WIDTH = 0.9
GATE_MIN_LEAF = 0.35

# How far a fence sinks below the ground it stands on. The panel is drawn as a
# flat strip and the ground under it is planar between stations, so this is not
# closing a modelling gap -- it is closing the one the *renderer* opens, where a
# fence exactly on the ground z-fights the terrain along its whole base. 60 mm
# also buys the bottom rail somewhere to be.
SINK = 0.06

# A fence run is dropped if it would cross a neighbouring building. The probe is
# a thin band on the fence line rather than the whole setback rectangle: the
# rectangle is the front garden, which is empty by definition, and a probe over
# it fires on every re-entrant wing of the building's own footprint.
BLOCK_HALF_WIDTH = 0.25
BLOCK_AREA = 0.4

# Two stations closer than this are the same station. `terrain.densify` only
# inserts crossings strictly inside a segment, but two lattice families can cross
# within a hair of each other and a zero-length panel has no direction.
MIN_STATION = 1e-3

# Where a post's `u` lives, and this is the one number in this file that is also
# a number in `world/fences.ts`.
#
# A POST HAS TO BE TOLD APART FROM A PANEL AND THERE IS NOTHING ELSE TO TELL
# THEM APART BY. The two open styles are alpha-tested strips whose bars come out
# of `fract(u / pitch)`, and a post is 75 to 90 mm across -- smaller than one
# 110 mm picket pitch -- so a post drawn through that mask comes out with a hole
# in it, which is a fence post you can see through. Every other discriminator was
# checked and none of them exists: a post's four side faces carry exactly the
# normals a panel's two faces carry, its cap's normal is up and so is a masonry
# coping's, its `v` is the panel's `v`, and it shares the panel's slot because
# putting it in another one would give an iron fence masonry posts.
#
# So a post's `u` is written into a band no panel can reach. A panel's `u` starts
# at zero and only increases; a post's runs from -1.0 downwards. The client tests
# `u < -0.5`, which is half a metre of margin on both sides of a boundary that is
# exact in binary.
POST_U = -1.0


# --- Styles -------------------------------------------------------------------


@dataclass(frozen=True)
class Style:
    """One fence style: its slot, its height, and the posts that punctuate it."""

    name: str
    slot: str
    #: Metres above grade at the top of the panel, and the top of `v`.
    height: float
    #: Plan thickness of the panel. Zero on the two open styles, which are a
    #: single strip drawn from both sides -- a palisade IS zero thickness at any
    #: distance where you can see one, and giving it 40 mm would double its
    #: triangles to model a bar you cannot resolve.
    thickness: float
    #: The post at each end and each side of the gate, in plan and in rise above
    #: the panel.
    post_across: float
    post_along: float
    post_proud: float


# 0.75 m of solid wall, one brick thick with render on it. The commonest front
# fence in post-war Sydney by a wide margin and the one that reads at the
# greatest distance, because it is the only one of the three with a continuous
# sunlit face on it.
MASONRY = Style(
    name="masonry",
    slot=SLOT_MASONRY,
    height=0.75,
    thickness=0.23,
    # The pier is the 0.2 m wider one a rendered fence actually has -- a
    # brick-and-a-half pier on a one-brick wall -- and it is what stops the ends
    # of the wall reading as a cut.
    post_across=0.43,
    post_along=0.35,
    # Flush with the wall rather than proud, and that is a shader constraint made
    # into a virtue. The coping band in `world/fences.ts` is at a fixed height
    # above grade, because that is the only thing a strip's `v` can key off; a
    # pier standing 120 mm proud would take the cap 120 mm below its own top and
    # read as a wall with a light stripe across it. A pier level with the wall it
    # punctuates puts one continuous coping over both, which is what a rendered
    # fence with piers in it actually looks like -- the pier is read by being
    # 200 mm wider, not by being taller.
    post_proud=0.0,
)

# 0.9 m of wrought-iron palisade: two rails and the bars between them, drawn as
# one strip with the bars in the material. Federation and Victorian stock, and
# the style whose gaps do the most work -- what you see through a palisade is the
# garden, which is the whole reason the open styles are alpha-tested rather than
# painted with a stripe.
IRON = Style(
    name="iron",
    slot=SLOT_IRON,
    height=0.90,
    thickness=0.0,
    post_across=0.075,
    post_along=0.075,
    post_proud=0.06,
)

# A metre of white timber pickets. Interwar and post-war, and the one style whose
# paint is its entire identity: a picket fence that is not white is a fence.
TIMBER = Style(
    name="timber",
    slot=SLOT_TIMBER,
    height=1.00,
    thickness=0.0,
    post_across=0.09,
    post_along=0.09,
    post_proud=0.05,
)

STYLES = {s.name: s for s in (MASONRY, IRON, TIMBER)}

# What each archetype puts on its front boundary, as a weighted draw per
# building. The same construction and the same argument as
# `attributes.MATERIAL_MIX`: the mix is per building because each fence was built
# by a different owner in a different decade, and anything coarser reads as
# zoning.
#
# The two that carry the feature are `federation` and `brick_veneer`, and they
# are deliberately near-opposites. A Federation house is 1900-1915 stock and its
# original boundary is cast or wrought iron on a low masonry plinth, so iron
# leads; a brick-veneer house is 1955-1975 and its boundary is a rendered brick
# planter wall, so masonry leads and iron is the minority the previous owner put
# in. Getting those two the same way round would make every suburban street in
# the build read as one era.
#
# `terrace` here is the *setback* terrace only -- the zero-lot ones never reach
# this table -- which is Paddington, Glebe and Balmain, and those are palisade
# streets almost without exception. `walkup` and `interwar_apartment` lead
# masonry because a block of flats puts a rendered wall along its frontage with
# the letterboxes in it, and pickets on a block of flats would be wrong.
#
# Weights are normalised at draw time and all five sum to 1.
FENCE_STYLE_MIX: dict[str, tuple[tuple[str, float], ...]] = {
    "federation": (("iron", 0.45), ("masonry", 0.35), ("timber", 0.20)),
    "brick_veneer": (("masonry", 0.50), ("timber", 0.30), ("iron", 0.20)),
    "terrace": (("iron", 0.55), ("masonry", 0.30), ("timber", 0.15)),
    "walkup": (("masonry", 0.60), ("iron", 0.25), ("timber", 0.15)),
    "interwar_apartment": (("masonry", 0.55), ("iron", 0.35), ("timber", 0.10)),
}

# `mesh._roll`'s stream for the style draw. Its own number, so that changing how
# often a Federation house gets iron cannot also move a chimney.
_S_FENCE_STYLE = 21


# --- The network --------------------------------------------------------------


class FenceNetwork:
    """Which buildings get a front fence, where its line is, and what it is made of.

    Threaded from `cli.cmd_build` through `tiles.build_tile` the way the awning
    and door networks are, and for the same reason: "does this edge front a
    street, and how far back is it" is a question only the street network can
    answer. It takes the `DoorNetwork` as well rather than a second copy of the
    edge choice -- the gate has to be on the same wall as the door, and the only
    way to guarantee that is for one object to decide it.

    Holds the tally as it goes. Like the awnings, the interesting number here is
    not how many fences were emitted but how many candidates each guard removed,
    because the guard that matters -- `MIN_SETBACK` -- is standing between a
    front garden and a fence in the middle of a footpath.
    """

    def __init__(self, street_network: StreetNetwork, door_network: mesh.DoorNetwork) -> None:
        self._streets = street_network
        self._doors = door_network
        self.stats: Counter[str] = Counter()
        self.styles: Counter[str] = Counter()
        #: Setbacks of every emitted fence, for the build report's distribution.
        self.setbacks: list[float] = []

    def emit(
        self,
        slots: dict[str, mesh.MeshBuffers],
        b: Building,
        bidx: int,
        origin: tuple[float, float],
        door_u: float,
        terrain=None,
    ) -> None:
        """Stand a front fence off this building, if it has a front garden."""
        if b.archetype not in FENCE_ARCHETYPES:
            return
        # Retail never. A shopfront is on the boundary, and a corner shop in a
        # terrace row is a `terrace` with the retail flag on it -- so the flag is
        # the test, not the archetype.
        if b.retail:
            self.stats["drop_retail"] += 1
            return
        self.stats["candidates"] += 1

        front = self._doors.front_edge(b)
        if front is None:
            self.stats["drop_no_street"] += 1
            return

        middle, offset = self._property_line(front)
        if middle < MIN_SETBACK:
            # The zero-lot case, and the one this test exists for.
            self.stats["drop_on_the_line"] += 1
            return
        if offset < MIN_SETBACK:
            # Set back at the middle of the wall and on the line at one end of
            # it: a corner splay, or a street that bends past the house. Counted
            # apart from the zero-lot case rather than lumped in with it, because
            # the two say completely different things -- one is a terrace and one
            # is a measurement this module could be getting wrong.
            self.stats["drop_skew"] += 1
            return
        if middle > MAX_SETBACK:
            self.stats["drop_deep"] += 1
            return
        if front.seg < MIN_FRONTAGE:
            self.stats["drop_short_frontage"] += 1
            return

        a = front.p0 + front.outward * offset
        c = front.p1 + front.outward * offset
        if self._blocked(a, c):
            self.stats["drop_neighbour"] += 1
            return

        # Counted only once the fence is certainly emitted, the way `AwningNetwork`
        # counts `pulled_back` after its neighbour test: a fence that never got
        # emitted is not a fence that got pulled in.
        if offset < middle - 0.5:
            self.stats["pulled_in"] += 1

        style = _style_for(b)
        # Where the gate goes, as a distance along the fence from `a`. The door's
        # own `u` when the door landed on this edge, which is the overwhelming
        # majority -- both features chose this edge through the same call -- and
        # the footprint centroid's projection when it did not, which is where
        # `DoorNetwork` would have put the door had it placed one.
        if front.u0 <= door_u <= front.u0 + front.seg:
            gate = door_u - front.u0
            self.stats["gate_on_door"] += 1
        else:
            along = (front.p1 - front.p0) / front.seg
            centroid = np.asarray(b.centroid, dtype=np.float64)
            gate = float(np.clip(np.dot(centroid - front.p0, along), 0.0, front.seg))
            self.stats["gate_on_centroid"] += 1

        runs = self._clip_to_kerb(a, c)
        if not runs:
            self.stats["drop_all_in_road"] += 1
            return
        if len(runs) != 1 or runs[0][0] > MIN_STATION or runs[0][1] < front.seg - MIN_STATION:
            self.stats["clipped_at_a_road"] += 1

        run = c - a
        length = float(np.hypot(run[0], run[1]))
        for s0, s1 in runs:
            p = a + run * (s0 / length)
            q = a + run * (s1 / length)
            # The gate belongs to whichever surviving leaf contains it. A leaf
            # that does not contain it gets none rather than one at its own
            # midpoint: a second gateway onto a side street is a gate into
            # traffic, and the door it would be aligned with is round the
            # corner.
            g = gate - s0 if s0 <= gate <= s1 else -1.0
            _emit_fence(slots, style, p, q, front.outward, g, origin, terrain)
            self.stats["fences"] += 1
            self.stats["metres"] += round(s1 - s0)
            self.styles[style.name] += 1
        self.setbacks.append(offset)

    def _clip_to_kerb(self, a: np.ndarray, c: np.ndarray) -> list[tuple[float, float]]:
        """The parts of the fence line that are not in a carriageway.

        `(s0, s1)` pairs, metres along the line from `a`.

        THE DEFECT THIS EXISTS FOR. The property line is derived from **one**
        street -- the one `DoorNetwork.front_edge` chose, whose footpath width
        is subtracted in `_property_line` -- and a corner block fronts two. The
        setback that puts the fence a metre inside the kerb of its own street
        says nothing at all about the street running across the end of the
        frontage, so the fence marches straight over it. `checkPavedIntegrity`
        counted 6,231 front-fence triangles standing in a travelled way, more
        than 1.5 m inside its kerb, and named this module.

        `_property_line`'s existing three-sample minimum is the near miss that
        makes this look already-handled and is not: it measures against
        `front.way`'s own centreline at both ends of the wall, so it catches a
        wall skewed to *its own* street and cannot see a different one.

        Clipped rather than dropped, because the frontage either side of a
        corner is real and a house on a corner does have a fence. A leaf shorter
        than `MIN_FRONTAGE` is dropped -- a 40 cm stub of palisade beside a
        driveway is noise with two posts on it.
        """
        line = LineString([tuple(a), tuple(c)])
        roads = self._streets.carriageways_near(line)
        if not roads:
            return [(0.0, line.length)]
        blocked = unary_union(roads)
        keep = line.difference(blocked)
        if keep.is_empty:
            return []
        pieces = list(keep.geoms) if keep.geom_type == "MultiLineString" else [keep]
        out: list[tuple[float, float]] = []
        for piece in pieces:
            if piece.length < MIN_FRONTAGE:
                continue
            cs = list(piece.coords)
            s0 = line.project(Point(cs[0]))
            s1 = line.project(Point(cs[-1]))
            out.append((min(s0, s1), max(s0, s1)))
        out.sort()
        return out

    def _property_line(self, front: mesh.FrontEdge) -> tuple[float, float]:
        """`(setback at the middle of the wall, setback the fence is built at)`.

        `front.kerb` is the gap from the *middle* of the wall to the edge of the
        carriageway, and the footpath occupies the first `footpath_width` of it,
        so the boundary is what is left. That is the answer for a wall parallel to
        its street and it is wrong at both ends of a wall that is not -- a house
        on a corner splay, or on a street that bends past it, sits closer to the
        kerb at one end than the measurement at its midpoint says.

        So the same subtraction is done at both ends against the same way's own
        centreline, and the *smallest* of the three is what the fence is built
        at. A fence at a constant offset from a skewed wall runs diagonally
        across the footpath otherwise, which is the one failure of this feature
        that would be visible from a hundred metres.

        Both numbers come back because they answer different questions. The
        midpoint one is "is this a house with a front garden", which is what
        qualifies the building; the minimum is "where can the fence actually
        stand", which is a different thing and is allowed to be smaller.
        """
        footpath = self._streets.footpath_width(front.way)
        line = self._streets.centreline(front.way)
        edge = self._streets.half_width(front.way) + footpath
        middle = front.kerb - footpath
        ends = min(float(line.distance(_point(p))) - edge for p in (front.p0, front.p1))
        return middle, min(middle, ends)

    def _blocked(self, a: np.ndarray, c: np.ndarray) -> bool:
        """Would this fence run through a building?

        A thin band on the fence line, not the setback rectangle. The rectangle
        is the front garden and is empty by construction, so a probe over it
        would report the building's own returns and wings on every L-shaped
        footprint; a 0.5 m band on the line reports only what the fence would
        actually hit. What it really fires on is a footprint whose front wall
        matched a street across the top of a neighbour -- a mis-segmented block,
        or a house behind a shop -- and a garage or a bin store built forward of
        the house on the boundary itself.
        """
        d = c - a
        run = float(np.hypot(d[0], d[1]))
        if run < 1e-6:
            return True
        n = np.array([d[1], -d[0]]) / run * BLOCK_HALF_WIDTH
        probe = Polygon([a + n, c + n, c - n, a - n])
        if probe.is_empty or not probe.is_valid:
            return False
        return any(
            poly.intersection(probe).area > BLOCK_AREA
            for poly in self._streets.buildings_near(probe)
        )


def _style_for(b: Building) -> Style:
    """This building's fence style: one stable draw on its own id.

    Per building rather than per row, per block or per street, which is the same
    call `attributes.MATERIAL_MIX` makes about paint and for the same reason --
    a terrace row whose fences all match is a fence, not six fences.
    """
    mix = FENCE_STYLE_MIX[b.archetype]
    roll = mesh._roll(b.id, _S_FENCE_STYLE) * sum(w for _, w in mix)
    for name, weight in mix:
        roll -= weight
        if roll <= 0.0:
            return STYLES[name]
    return STYLES[mix[-1][0]]


# --- Geometry -----------------------------------------------------------------


def _point(p: np.ndarray) -> Point:
    return Point(float(p[0]), float(p[1]))


def _emit_fence(
    slots: dict[str, mesh.MeshBuffers],
    style: Style,
    a: np.ndarray,
    c: np.ndarray,
    outward: np.ndarray,
    gate: float,
    origin: tuple[float, float],
    terrain,
) -> None:
    """One building's fence: two panelled runs, a gap between them, two posts.

    `u` runs from zero at `a` and *continues across the gate*, so the picket
    rhythm on the far leaf is in step with the near one -- which is how a fence
    is built, because the pickets are set out along the whole boundary before the
    gate is cut into it.

    TWO POSTS AND NOT FOUR, and it is the one cost decision in this module worth
    stating. With a post at each end of the frontage as well, a fence came out at
    55 triangles of which the four posts were 40 -- 73% of the object spent on
    something that is not the line. A gate post earns its ten triangles: it is
    what makes a 900 mm gap read as a way in rather than as a panel somebody
    forgot. An end post does not. It stands on the side boundary, which on a
    terrace or a townhouse row is where the neighbour's fence butts into it and
    on a detached house is seen edge-on from the street behind a hedge or a
    driveway, and it is 75 mm across -- one pixel at 43 m through the footprint
    this build renders at. Dropping the pair takes the median fence from 55
    triangles to 33 and the inner ring's fence layer from about 44 MB to 26.
    """
    buf = slots[style.slot]
    # No building owns this geometry. It stands on the title boundary, not on the
    # house, it reads no parameter record, and its colour is a property of the
    # slot -- the same contract as the street surfaces and the awning fascia.
    buf.building_indexed = False

    d = c - a
    run = float(np.hypot(d[0], d[1]))
    if run < 1e-6:
        return
    along = d / run

    # The gate, held far enough off both ends to leave a leaf beside it. On a
    # frontage barely wider than the gate this puts the opening off-centre rather
    # than dropping it, which is what a builder does with the same constraint.
    half = GATE_WIDTH * 0.5
    lo = half + GATE_MIN_LEAF
    hi = run - half - GATE_MIN_LEAF
    if gate < 0.0:
        # No gate on this leaf. `FenceNetwork._clip_to_kerb` cut the frontage at
        # a side street and the way in is on the other piece; a second opening
        # here would be a garden gate onto a carriageway. One unbroken panel and
        # no posts, which is the same trade the header makes about end posts --
        # a post is only worth its ten triangles when it frames an opening.
        pieces = ((0.0, run),)
        posts = ()
    elif lo <= hi:
        gate = float(min(max(gate, lo), hi))
        pieces = ((0.0, gate - half), (gate + half, run))
        posts = (gate - half, gate + half)
    else:
        # Too narrow to hold a gate and a leaf. The whole frontage is the
        # opening: a 3 m garden with a 1 m house beside it, and two posts.
        pieces = ()
        posts = (0.0, run)

    for s0, s1 in pieces:
        if s1 - s0 < MIN_STATION:
            continue
        _panel(buf, style, a, along, outward, s0, s1, origin, terrain)
    for s in posts:
        _post(buf, style, a, along, outward, s, origin, terrain)


def _panel(
    buf: mesh.MeshBuffers,
    style: Style,
    a: np.ndarray,
    along: np.ndarray,
    outward: np.ndarray,
    s0: float,
    s1: float,
    origin: tuple[float, float],
    terrain,
) -> None:
    """One straight run of fence between two distances along the line.

    Stations come from `terrain.densify` and nowhere else -- see the fifth
    decision in the header. Between two consecutive ones the ground is a plane,
    so the panel's base follows it exactly and its top runs parallel to it, which
    is what a fence does: it is built in level panels off the ground, not to a
    single datum, and a fence whose top stayed flat over a 1:8 fall would climb
    out of its own posts.

    UVs are metres both ways: `u` along the fence from the start of the whole
    fence, `v` from grade. The picket mask is `fract(u / pitch)` in the shader,
    so `u` being metric and continuous is the entire interface -- and `v` being
    metric is what puts the rails at a height rather than at a fraction.
    """
    oe, on = origin
    pts = np.vstack((a + along * s0, a + along * s1))
    if terrain is not None:
        pts = terrain.densify(pts)
    step = np.diff(pts, axis=0)
    keep = np.concatenate(([True], np.hypot(step[:, 0], step[:, 1]) > MIN_STATION))
    pts = pts[keep]
    if len(pts) < 2:
        return

    ground = streets._ground(terrain, pts[:, 0], pts[:, 1], len(pts))
    # `u` is measured from the fence's own origin rather than from this panel's,
    # so the two leaves either side of a gate share one picket set-out.
    span = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    u = s0 + np.concatenate(([0.0], np.cumsum(span)))

    def world(p, y: float) -> tuple[float, float, float]:
        return (float(p[0] - oe), float(y), float(-(p[1] - on)))

    half = style.thickness * 0.5
    front_n = mesh._enu_dir(outward)
    back_n = mesh._enu_dir(-outward)
    top_n = (0.0, 1.0, 0.0)

    for i in range(len(pts) - 1):
        p, q = pts[i], pts[i + 1]
        y0, y1 = float(ground[i]), float(ground[i + 1])
        u0, u1 = float(u[i]), float(u[i + 1])
        pf, qf = p + outward * half, q + outward * half
        pb, qb = p - outward * half, q - outward * half

        mesh._add_face(
            buf,
            (
                world(pf, y0 - SINK),
                world(qf, y1 - SINK),
                world(qf, y1 + style.height),
                world(pf, y0 + style.height),
            ),
            ((u0, -SINK), (u1, -SINK), (u1, style.height), (u0, style.height)),
            front_n,
            0,
        )
        # The garden side, at the same `u` on the same physical metre, so a bar
        # seen from the street and the same bar seen from the garden are the same
        # bar. Getting this backwards puts the gaps of one face over the bars of
        # the other and the fence becomes opaque from every angle at once.
        mesh._add_face(
            buf,
            (
                world(pb, y0 - SINK),
                world(qb, y1 - SINK),
                world(qb, y1 + style.height),
                world(pb, y0 + style.height),
            ),
            ((u0, -SINK), (u1, -SINK), (u1, style.height), (u0, style.height)),
            back_n,
            0,
        )
        if style.thickness > 0.0:
            # The coping. Only the solid style has one -- an open fence's top
            # rail is drawn in the material, where a masonry wall's cap is a
            # surface with the sky on it and is the brightest thing about the
            # whole object.
            mesh._add_face(
                buf,
                (
                    world(pb, y0 + style.height),
                    world(qb, y1 + style.height),
                    world(qf, y1 + style.height),
                    world(pf, y0 + style.height),
                ),
                ((u0, 0.0), (u1, 0.0), (u1, style.thickness), (u0, style.thickness)),
                top_n,
                0,
            )

    # The two cut ends of a solid wall, so a run does not show its own inside
    # where the gate opens. The open styles need none: they have no inside.
    if style.thickness > 0.0:
        for idx, facing in ((0, -along), (len(pts) - 1, along)):
            p = pts[idx]
            y = float(ground[idx])
            pf, pb = p + outward * half, p - outward * half
            mesh._add_face(
                buf,
                (
                    world(pb, y - SINK),
                    world(pf, y - SINK),
                    world(pf, y + style.height),
                    world(pb, y + style.height),
                ),
                (
                    (0.0, -SINK),
                    (style.thickness, -SINK),
                    (style.thickness, style.height),
                    (0.0, style.height),
                ),
                mesh._enu_dir(facing),
                0,
            )


def _post(
    buf: mesh.MeshBuffers,
    style: Style,
    a: np.ndarray,
    along: np.ndarray,
    outward: np.ndarray,
    s: float,
    origin: tuple[float, float],
    terrain,
) -> None:
    """A post at one end of a run: four sides and a cap, no floor.

    Five faces rather than six because the sixth is underground. The cap is not
    optional in the same way: a post is 0.9 to 1.1 m tall and an eye is at 1.7,
    so you look *down* on every post in the city and a missing cap is a hole in
    it -- which is the failure `power.ts`'s inside-out box gets away with only
    because a crossarm is seen from below.

    `v` is metres above grade, exactly as on the panel, so the coping band of a
    masonry pier and the rail lines of an open post land at the heights they land
    at on the wall beside them. `u` is the post's own width offset into the
    `POST_U` band -- see that constant for why a post has to be distinguishable
    from a panel at all.
    """
    oe, on = origin
    centre = a + along * s
    y = float(streets._ground(terrain, centre[0:1], centre[1:2], 1)[0])
    top = y + style.height + style.post_proud

    ha = along * (style.post_along * 0.5)
    ho = outward * (style.post_across * 0.5)
    corners = (centre - ha - ho, centre + ha - ho, centre + ha + ho, centre - ha + ho)
    normals = (
        mesh._enu_dir(-outward),
        mesh._enu_dir(along),
        mesh._enu_dir(outward),
        mesh._enu_dir(-along),
    )

    def world(p, h: float) -> tuple[float, float, float]:
        return (float(p[0] - oe), float(h), float(-(p[1] - on)))

    for i in range(4):
        p, q = corners[i], corners[(i + 1) % 4]
        w = style.post_along if i % 2 else style.post_across
        mesh._add_face(
            buf,
            (world(p, y - SINK), world(q, y - SINK), world(q, top), world(p, top)),
            ((POST_U, -SINK), (POST_U - w, -SINK), (POST_U - w, top - y), (POST_U, top - y)),
            normals[i],
            0,
        )
    mesh._add_face(
        buf,
        tuple(world(p, top) for p in corners),
        (
            (POST_U, 0.0),
            (POST_U - style.post_along, 0.0),
            (POST_U - style.post_along, style.post_across),
            (POST_U, style.post_across),
        ),
        (0.0, 1.0, 0.0),
        0,
    )
