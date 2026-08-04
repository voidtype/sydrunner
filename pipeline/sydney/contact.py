"""The contact shadow where a wall meets the ground: a baked AO skirt.

Every building in the world was standing on the ground the way a sticker stands
on a page. The geometry was right -- the wall reached the ground, the ground
reached the wall -- and it still read as pasted on, because in life the last
metre before a wall is *darker* than the pavement beyond it and here it was
exactly the same tone. Three separate things put it there: the wall and the
ground occlude each other's sky, dirt and leaf litter collect in the angle
between them, and the small overhangs every building has -- a sill course, a
damp-proof step, a bit of render -- throw a permanent shadow into it. None of
them is subtle and none of them was present.

So this module emits, per footprint, a flat ribbon of geometry hugging the
ground around the outside of the wall, black, and translucent on a gradient
baked into vertex alpha: `CONTACT_ALPHA` against the wall, nothing by
`CONTACT_WIDTH` out. It is the cheapest grounding cue in rendering and there is
no cheaper one available here -- a shader-side distance to the nearest building
would need an SDF nobody builds, baking the darkening into the ground meshes
themselves cannot work because the terrain posts are 31 m apart and the street
vertices are dense only along the kerb, and screen-space AO is a post pass this
project has deliberately never had.

---------------------------------------------------------------------------
Four decisions carry the module.

**The offset is computed per vertex, not by `shapely.buffer`.** A buffer is the
obvious way to get the outer boundary and it is the wrong one here: it returns a
ring with its own vertex count -- more at round joins, fewer where it dissolves
a notch -- and no correspondence at all to the ring that went in. A ribbon needs
*pairs*, so a buffered outer ring would have to be re-associated with the inner
one by nearest point, which is both expensive and exactly the kind of thing that
is 99.9% right. Offsetting each vertex along its own angle bisector is four
lines, gives the pairing by construction, and puts the mitre limit -- the one
thing a buffer would otherwise be doing for us -- in plain sight.

**Which way is out was measured here first, and is now guaranteed upstream.**
The obvious `outward = right of travel, because footprint rings are wound
counter-clockwise` was false in this data: over the 33,844 merged buildings the
ledger holds, 18,371 rings were counter-clockwise in ENU and 15,473 clockwise,
and assuming either one puts the skirt of nearly half the city *underneath* the
building, where it is invisible and where nothing in the output would ever say
so. This module was the only one that noticed. `merge.orient_footprint` now
normalises every ring at construction -- the same three lines, moved to the one
place that can make them an invariant instead of a local defence -- and the
reversal in `_outward_ring` is what is left of the original: a no-op that costs
nothing, kept because the failure it guards is silence.

The ribbon that comes out of it is wound **up-facing**, which is what lets
`contact.ts` draw it single-sided. See the note on `side` there.

**The skirt drapes at one height for every surface it crosses, and the height is
above the footpath.** A skirt is 0.9 m wide and the surfaces it can cross in
that distance are at four different clearances over the same terrain: bare
ground at 0, park grass at 0.01, carriageway at 0.02, kerb top and footpath at
0.15. Choosing per point is not available -- and would not help if it were,
because `streets.py` subtracts the buildings out of the footpath band, so the
footpath's own boundary *is* the footprint boundary wherever a building fronts a
street, and a containment test on the skirt's inner edge would be a coin flip on
float noise. A single height therefore has to clear the tallest of them, so it
is `FOOTPATH_Y + 0.02` -- the same 2 cm clearance the carriageway is given over
the terrain, over the layer that matters, because a street-facing wall is where
this cue is worth the most and burying it under 15 cm of concrete there would
lose the whole feature on the buildings the player is closest to.

The price is that over bare ground -- back gardens, side setbacks, the interiors
of blocks -- the ribbon floats 17 cm. That is bounded and it is bounded in the
harmless direction, because the ribbon's *inner* edge lies in the wall plane:
the ray from any eye through that edge hits the wall at the edge's own height,
so the float can never open a gap between the darkening and the wall. All it
does is carry the dark end of the gradient up the bottom 17 cm of the wall,
which is the same band `facade.ts`'s plinth toe darkens for the same reason.
Floating is why the ribbon needs the depth bias in `contact.ts` rather than a
larger clearance: 2 cm over the footpath quantises away past ~180 m, and a
transparent surface that loses the depth test does not z-fight, it disappears.

**It follows the terrain, not the pad.** A building sits on one level pad taken
at its centroid, so on a slope the wall daylight-cuts into the hill on the high
side and is buried by `mesh.WALL_SKIRT` on the low one -- which means the line
where wall visibly meets ground is the *terrain*, at both ends, and not the pad
at either. The ring is densified at every terrain facet crossing first, the same
call and the same lattice `_emit_kerb_face` uses, so between two consecutive
skirt vertices the ground is planar and the 17 cm is the 17 cm it keeps.
"""

from __future__ import annotations

import numpy as np

from . import mesh, streets

SLOT_CONTACT = "contact_ao"

# How far the darkening reaches out from the wall, metres. Chosen against what
# it is standing in for rather than by eye: the wall occludes half the sky
# directly against it and its contribution falls off with the angle it subtends,
# which is down to a quarter by about a metre out on a two-storey wall. Wider
# than this and the band starts reading as a painted border rather than as
# shadow; narrower and it disappears at any distance where the whole building is
# in frame, which is where the grounding cue is needed most.
CONTACT_WIDTH = 0.9

# Opacity of the black ribbon against the wall, falling linearly to zero at
# `CONTACT_WIDTH`. Half is what the geometry says -- a wall takes half the
# hemisphere away from the ground touching it -- and the small excess is the
# dirt and the overhang shadow, which are real and are not occlusion.
CONTACT_ALPHA = 0.55

# Clearance above the terrain. See the third decision in the header: it is the
# footpath's own height plus the clearance the carriageway gets over the ground,
# written as a sum so it tracks if the paving ever moves rather than being a
# constant that quietly stops clearing it.
CONTACT_Y = streets.FOOTPATH_Y + 0.02

# Footprints below this get no skirt. Sheds, garages, carports and the ML
# segmentation's smaller mistakes: 2.0% of the merged set, all of it under a
# 4.5 m square, none of it a building whose base anyone looks at, and every one
# of them a ring's worth of ribbon in the middle of a back garden.
MIN_FOOTPRINT_AREA = 20.0

# Cap on how far a mitre may run past `CONTACT_WIDTH` at a sharp corner, as a
# ratio. Shapely's `mitre_limit` means the same thing and this is deliberately
# tighter than its default of 5: at 2.0 a corner has to be sharper than 60
# degrees before it is truncated at all, and the spike an uncapped mitre puts on
# a 10-degree corner is 11 m long -- a black spear across the footpath, from one
# bad OSM vertex.
MITRE_LIMIT = 2.0

# Two densified vertices closer than this are the same vertex. `terrain.densify`
# only inserts crossings strictly inside a segment, but two different lattice
# families can cross within a hair of each other, and a zero-length segment has
# no normal.
MIN_SEGMENT = 1e-3


def emit(
    buildings: list,
    slots: dict[str, mesh.MeshBuffers],
    origin: tuple[float, float],
    terrain=None,
) -> None:
    """Add every skirt-worthy building in this tile to the contact slot.

    Deliberately not clipped to the tile. A skirt overhangs its tile's bounds by
    at most `CONTACT_WIDTH`, which is less than the buildings themselves already
    do -- a footprint belongs to the tile its centroid is in and its walls cross
    the line freely -- so clipping would buy nothing and would cost the seam a
    pair of tiles' ribbons butting exactly.

    Skirts of neighbouring buildings are likewise left to overlap. Two walls a
    metre apart each darken the metre between them and the two blends compound
    to about 0.42, which is what a gap that narrow between two buildings
    actually looks like; unioning them would cost the per-vertex gradient that
    is the whole effect, to fix something that is not wrong.
    """
    if not buildings:
        return
    buf = slots[SLOT_CONTACT]
    # No building owns any of this geometry: it is shading, not a facade, and it
    # reads no parameter record. Same contract as the street slots.
    buf.building_indexed = False
    oe, on = origin
    for b in buildings:
        ring = _outward_ring(b.ring)
        if ring is None:
            continue
        pts = _walk(ring, terrain)
        if pts is None:
            continue
        _add_ribbon(buf, pts, oe, on, terrain)


# --- Geometry ----------------------------------------------------------------


def _outward_ring(ring: np.ndarray) -> np.ndarray | None:
    """The footprint's outer ring if it is worth a skirt, counter-clockwise.

    This is where the fix that eventually became `merge.orient_footprint` was
    first written: normalising the winding is what lets the offset below take
    the outward side of an edge as the right of travel and be right about it for
    every building rather than for the 54% that happened to arrive that way.
    `Building` now carries that as an invariant, so the reversal here is a no-op
    -- kept, because the shoelace is being computed for the area test anyway and
    a ribbon whose winding is wrong is *silently invisible* rather than wrong,
    which is the one failure mode worth two lines of belt and braces.

    The test that still does work is the area one: the shoelace sum is twice the
    area, so the sheds are dropped off the same three lines.

    Only the exterior ring. A footprint's interior rings are courtyards, and
    `mesh.build_walls` extrudes no wall around one -- there is nothing in there
    for a skirt to sit against.
    """
    r = mesh._ring_open(np.asarray(ring, dtype=np.float64))
    if len(r) < 3:
        return None
    twice_area = mesh.twice_signed_area(r)
    if abs(twice_area) * 0.5 < MIN_FOOTPRINT_AREA:
        return None
    return r if twice_area > 0.0 else r[::-1]


def _walk(ring: np.ndarray, terrain) -> np.ndarray | None:
    """The ring with a vertex at every terrain facet crossing, in ENU.

    `terrain.densify` on the *closed* ring and then reopened, exactly as
    `streets._emit_kerb_face` does it: the two are the same problem -- a strip
    standing on a ring that has to follow a piecewise-planar ground -- and using
    the same lattice is what keeps the skirt from cutting into the hill that the
    road beside it follows.
    """
    if terrain is not None:
        ring = mesh._ring_open(terrain.densify(np.vstack((ring, ring[:1]))))
    # Drop repeats before the normals are taken, not after: a zero-length
    # segment has no direction and would poison both of its neighbours' bisectors.
    step = np.roll(ring, -1, axis=0) - ring
    ring = ring[np.hypot(step[:, 0], step[:, 1]) > MIN_SEGMENT]
    return ring if len(ring) >= 3 else None


def _outer(pts: np.ndarray) -> np.ndarray:
    """Each ring vertex pushed `CONTACT_WIDTH` outward along its angle bisector.

    A point at distance d from both adjacent edge lines is `p + b * d / (1 + c)`
    where `b` is the sum of the two unit outward normals and `c` their dot
    product -- so the extension past d is `sqrt(2 / (1 + c))`, which is 1 on a
    straight run and diverges as the corner closes on itself. That divergence is
    the whole reason for `MITRE_LIMIT`: past it the offset is truncated along
    the same bisector, which bevels the corner instead of spearing it.

    Reflex corners -- the inside of an L, the slot between two wings -- take the
    same formula and can cross their own neighbours when the notch is narrower
    than twice the width. What that produces is a small bow-tie of doubled
    alpha at the bottom of a crevice, which is both rare and closer to right
    than the alternative, so it is left alone.
    """
    step = np.roll(pts, -1, axis=0) - pts
    length = np.hypot(step[:, 0], step[:, 1])[:, None]
    # Outward is the right of travel, which is what the CCW normalisation in
    # `_outward_ring` bought: ENU right of (de, dn) is (dn, -de).
    edge_n = np.column_stack((step[:, 1], -step[:, 0])) / length
    prev_n = np.roll(edge_n, 1, axis=0)

    bisector = prev_n + edge_n
    mag = np.hypot(bisector[:, 0], bisector[:, 1])
    c = np.einsum("ij,ij->i", prev_n, edge_n)
    # `mag` is only zero when the ring doubles exactly back on itself, where
    # there is no outward direction at all; the outgoing edge's normal is the
    # arbitrary-but-finite answer and it keeps the strip closed.
    unit = np.where(mag[:, None] > 1e-9, bisector / np.where(mag > 1e-9, mag, 1.0)[:, None], edge_n)
    extension = np.minimum(np.sqrt(2.0 / np.maximum(1.0 + c, 1e-6)), MITRE_LIMIT)
    return pts + unit * (CONTACT_WIDTH * extension)[:, None]


def _add_ribbon(buf: mesh.MeshBuffers, pts: np.ndarray, oe: float, on: float, terrain) -> None:
    """One closed quad strip: inner rail on the footprint, outer rail out in the
    open, both draped on the ground at `CONTACT_Y`.

    Every vertex is sampled independently rather than the outer rail borrowing
    the inner one's height. It costs a second `terrain.sample` per vertex and it
    is what keeps the ribbon flat on a slope: 0.9 m across a 1:7 fall is 13 cm,
    which is most of the clearance the whole thing is standing on.
    """
    outer = _outer(pts)
    n = len(pts)
    rail = np.vstack((pts, outer))
    ground = streets._ground(terrain, rail[:, 0], rail[:, 1], len(rail))
    pos = np.column_stack((rail[:, 0] - oe, ground + CONTACT_Y, -(rail[:, 1] - on)))

    # Black at every vertex; only the alpha carries anything. RGB is stored
    # rather than implied because glTF's COLOR_0 is a vec4 or a vec3 and a vec3
    # would mean no alpha at all.
    colours = np.zeros((2 * n, 4))
    colours[:n, 3] = CONTACT_ALPHA

    i = np.arange(n)
    j = (i + 1) % n
    tris = np.concatenate(
        (
            np.column_stack((i, i + n, j + n)),
            np.column_stack((i, j + n, j)),
        )
    )
    buf.add_surface(pos, None, None, tris, colours=colours)
