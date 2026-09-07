"""The carriageway keep-out: nothing this pipeline places may stand in a road.

WHY THIS EXISTS, AND WHY IT IS NOT IN THE PLACERS. `server/clash-check.ts` found
14,562 poles, bins, name posts and signal heads standing inside a live
carriageway, and the same audit proved that none of them is a placer's mistake
about *its own* street. Every one of these objects is set at
`half_width + streets.KERB_WIDTH + setback` off the centreline of the way it
belongs to, `lanes._split_by_tile` and `streets._half_width` compute the identical
`0.5 * clamp(width)`, and so a same-way offender is not expressible. The proof is
in the audit's own kind table: `furniture.BIN_CLASSES` is
`{residential, unclassified, living_street, tertiary}` and bins were reported
standing in `primary` and `service` carriageways, which their own placer will not
put a bin on. Every one of them is inside a **different** way's road -- at a
junction, in a slip lane, or on a street OSM has mapped twice.

That is a fact about the *network*, not about any one way, and no amount of
teaching `furniture._blocked_at` and `power._blocked_at` about kerbs can find it:
each of those runs while walking one way and has no cheap way to know that the
verge it is standing on is the far kerb of the road behind it. So this is shaped
like `landmarks.suppress` instead -- one filter over the whole emitted lane graph,
applied to items that have already been placed, exactly as `suppress` filters the
merged building list rather than teaching every producer about landmarks.

WHAT IT IS SWEPT FROM. `lanes.LaneNetwork`'s `WaySpan`s, which are the same
polylines and the same `half_width` that go into `<key>.lanes.bin` -- so the road
this keeps out of is the road the client draws, the road traffic drives on, and
the road the audit convicts against. Not the street network's paved surfaces:
those are a *rendered* band with kerbs and footpaths in them, and a keep-out from
them would delete every bin in the city for standing on the footpath, which is
where a bin goes.

**The predicate is `clash-check.onCarriageway`'s, deliberately term for term.**
Each span is buffered by `half_width - KERB_INSET_M` with flat caps and mitred
joins, which is the union of the per-segment quads that audit sweeps; each item
is the axis-aligned square of its own drawn half-extent, which is the plan shape
that audit clips. A filter written to a looser rule would leave a residue the
audit still names and a tighter one would start deleting furniture off the kerb,
and neither is worth the guess when the number to match is written down.

WHAT IT COSTS, WHICH IS A WIRE AND NOT A POLE. A dropped pole takes its two spans
with it and `power._build_spans_on_way` re-chains the run across the gap, so a
suppressed pole leaves a longer span rather than a hole -- unless the new gap is
over `power.MAX_SPAN`, in which case the chain breaks there, which is what a real
line does when a pole is missing. Nothing else in the build reads these objects.

WHAT IT DELIBERATELY DOES NOT TOUCH. `power.poles_near`, which `furniture.py`
queries to keep a bin clear of a pole, still returns the unfiltered run. That is
the same choice `power._cap` already documents in as many words -- *"it can return
a pole that `instances` will go on to drop. That is the conservative direction for
a keep-out and it is also the stable one"* -- and it means a bin's fate does not
depend on whether the pole beside it happened to be standing in a slip lane.
"""

from __future__ import annotations

import math

import shapely
from shapely.geometry import LineString, box
from shapely.strtree import STRtree

# How far inside a carriageway's edge an object has to stand before it is in the
# road rather than on the line that says where the road stops, metres.
#
# `server/clash-check.ts`' `KERB_INSET_M`, mirrored, and it must stay mirrored:
# the whole point of this module is that what it removes is exactly what that
# audit convicts. Its reasoning is worth restating rather than pointing at. The
# lane half width is centreline to kerb and these objects stand *at* the kerb by
# design, so a test on the bare edge would convict every pole in the city on
# quantisation alone; 0.4 m is over the widest of their own radii -- a 240 L
# bin's half-diagonal is 0.47 m and it is meant to be hard against the kerb top,
# not straddling it -- and far under a lane width.
KERB_INSET_M = 0.4

# The drawn plan half-extent of each kind, metres.
#
# `clash-check.FURNITURE_SPEC`, mirrored on the same terms it is mirrored there:
# these are the client's own geometry constants, restated for a reader that
# cannot import the module that builds the mesh. The bin's 0.47 is the half
# diagonal of `furniture.BIN_WIDTH` x `furniture.BIN_DEPTH`, and `verify` asserts
# that rather than leaving it to rot -- the other three have no counterpart in
# `pipeline/` to check against. If any of them drifts, this keeps a name post out
# of the road by three centimetres too much or too little and nothing else: the
# inset above is an order of magnitude larger than every one of them.
HALF_EXTENT_M: dict[str, float] = {
    "pole": 0.16,  # world/power.ts, SHAFT_RADIUS_BUTT
    "bin": 0.47,  # half of hypot(BIN_WIDTH, BIN_DEPTH)
    "post": 0.0325,
    "signal": 0.07,
}


class KeepOut:
    """Every metre of carriageway in the extent, as one query.

    Built from a `lanes.LaneNetwork` after the lane graph is solved and handed to
    the two placers before any tile is emitted. `blocks` is the whole interface;
    `stats` is what the build prints.
    """

    def __init__(self, lane_network) -> None:
        self.stats: dict[str, int] = {
            "spans": 0,
            "drop_pole": 0,
            "drop_bin": 0,
            "drop_post": 0,
            "drop_signal": 0,
        }
        polys = []
        for key in lane_network.tile_keys():
            for w in lane_network.instances(key).ways:
                half = w.half_width - KERB_INSET_M
                if half <= 0.0 or len(w.pts) < 2:
                    continue
                line = LineString(w.pts)
                if line.length <= 0.0:
                    continue
                # Flat caps and mitred joins: the union of `clash-check.segQuad`'s
                # per-segment rectangles, which is the shape that audit sweeps.
                # A round cap would reach `half` past the end of a span, and a
                # span ends on a tile line, so it would keep out of ground the
                # neighbouring span already accounts for.
                polys.append(line.buffer(half, cap_style=2, join_style=2))
        self.stats["spans"] = len(polys)
        self._polys = polys
        self._tree = STRtree(polys) if polys else None
        if self._tree is not None:
            for p in polys:
                shapely.prepare(p)

    def blocks(self, east: float, north: float, kind: str) -> bool:
        """Is a `kind` standing here inside a carriageway?

        The item is its own axis-aligned square rather than a point, because that
        is the plan shape `clash-check` clips against the road and because a
        point test would miss a bin whose lid is over the kerb by 20 cm.
        """
        if self._tree is None:
            return False
        r = HALF_EXTENT_M[kind]
        shape = box(east - r, north - r, east + r, north + r)
        for i in self._tree.query(shape):
            if shapely.intersects(self._polys[i], shape):
                return True
        return False

    def filter(self, items: list, kind: str) -> list:
        """Everything in `items` that is not standing in a road. Tallied by kind."""
        if self._tree is None:
            return items
        keep = [o for o in items if not self.blocks(o.east, o.north, kind)]
        self.stats[f"drop_{kind}"] += len(items) - len(keep)
        return keep


def report(keep_out: KeepOut | None, results) -> str:
    """One line for the build log, counted off the tiles rather than off `stats`.

    **`stats` is a lie in the parent process and this is why it is not read
    here.** `cli.build` emits on a `fork` pool, so every `filter` call in the
    tile loop increments a counter in a child that is then thrown away, and this
    line printed `0 items dropped` over a run that had in fact dropped exactly
    the forty-two items the audit convicted. A zero that means "the sweep never
    ran" and a zero that means "the sweep found nothing" are the same zero, and
    the second is the failure this whole module exists to make impossible.

    So the drops come home the way every other per-tile number comes home --
    `tiles.TileResult` -- and `stats` is left to the one figure that *is* the
    parent's, which is how much carriageway was swept. `--only` narrows this to
    the tiles emitted on this run, which is right: it is a report on the emit.
    """
    if keep_out is None:
        return "  carriageway keep-out: not built"
    dropped = sum(r.carriageway_dropped for r in results)
    return (
        f"  carriageway keep-out: {dropped:,} placed items dropped for standing in a road,"
        f" over {keep_out.stats['spans']:,} swept carriageway spans"
        f" and {len(results):,} tiles emitted"
    )


def verify() -> list[str]:
    """The control: a synthetic road, an object on it, and one beside it.

    `cli.cmd_station_clear_audit`'s rule -- a filter that only ever removes
    proves nothing, and one that removes nothing at all is indistinguishable
    from one that is not running. So this drops both cases through the real
    predicate: a bin in the middle of a 12 m carriageway must be named, and a bin
    0.1 m outside its kerb must not, which is the same pair `clash-check`'s own
    `FURNITURE_ON_ROAD` control asserts and with the same numbers.
    """
    import numpy as np

    bad: list[str] = []

    class _Span:
        half_width = 6.0
        pts = np.asarray([[-50.0, 0.0], [50.0, 0.0]])

    class _Net:
        def tile_keys(self):
            return {"0_0"}

        def instances(self, key):
            class _T:
                ways = [_Span()]

            return _T()

    k = KeepOut(_Net())
    if not k.blocks(0.0, 0.0, "bin"):
        bad.append("carriageway: a bin in the middle of a 12 m road is not blocked; the sweep is broken")
    # 6.0 - 0.4 inset = 5.6 m of kept-out half width, and a bin reaches 0.47 m,
    # so 6.1 m off the centreline is 0.03 m clear of it.
    if k.blocks(0.0, 6.1, "bin"):
        bad.append(
            f"carriageway: a bin 0.1 m outside the kerb is blocked; KERB_INSET_M is {KERB_INSET_M} and does nothing"
        )
    if not k.blocks(0.0, 5.5, "post"):
        bad.append("carriageway: a name post 0.5 m inside the kerb is not blocked")
    if k.stats["spans"] != 1:
        bad.append(f"carriageway: a one-way network swept {k.stats['spans']} spans")

    from . import furniture

    want = 0.5 * math.hypot(furniture.BIN_WIDTH, furniture.BIN_DEPTH)
    if abs(HALF_EXTENT_M["bin"] - want) > 0.005:
        bad.append(
            f"carriageway: the bin's half extent is {HALF_EXTENT_M['bin']} m and the body it is"
            f" drawn from is {want:.3f} m across the diagonal"
        )
    return bad
