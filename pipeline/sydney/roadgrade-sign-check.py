"""The gate on the one-sided Lipschitz projection: prove it on a scoped solve.

`shoreline-check.py` is this file's immediate sibling and its section 3 is this
file's brief. It measured that the shore pass writes **11.48 m** at the Quay
promenade and the build kept **5.63** -- median kept/written 0.41 -- and named
the mechanism as `roadgrade._lipschitz` averaging a downward projection with an
upward one when the error it is averaging over has a sign. It reads 1.13 now,
and that section is where it would show up going back. `bare-earth-check.py`
and `terrain-rules-check.py` argue the philosophy of a check like this one
between them and it is not repeated here.

**What this file has to prove is different from what those three prove**, and
the difference decides its shape. Those are gates on *passes*: a pass writes
inside a stated extent and the assertion is that nothing outside it moved by a
millimetre. This is a gate on an **operator**, and an operator that fires
wherever a tie chain reaches has no extent -- the chain is transitive and it
reaches the whole city, which `roadgrade.TIE_RADIUS_M`'s own block says in as
many words. So there is no containment assertion to make here and it would be
dishonest to invent one. What is assertable instead is the operator's own
arithmetic, and it is stronger than an extent:

    low <= new <= old,  node by node, everywhere, always.

`new` is sandwiched between the fully downward projection -- the global switch
the evidence declined to take -- and the symmetric average it replaces. So
**nothing in Sydney is ever raised by this change**, the worst case is bounded
by an operator whose behaviour `TIE_RADIUS_M`'s table already measured, and the
question the check actually has to answer is not "did it stay inside" but "did
it come down where the ground is known and leave the escarpment alone".
Sections 1 and 5 are those two halves.

Eight sections:

  1. **The gate.** The operator's arithmetic three ways: on random graphs, where
     every property can be checked exhaustively for the price of nothing; on the
     road pass alone, which is where "nothing was raised" is a statement about
     this operator rather than about `water.py` and `pads.py`; and on the
     shipped lattice, where the handful of posts that do come out higher are
     named and their cause printed beside them.
  2. **The Quay transect**, east 140, and the number this round exists to move:
     kept / written, under the old operator and the new one. Four shipped
     lattices, because that ratio is a difference of differences and both
     halves have to be measured under the same projection.
  3. **What came down, and where.** The lattice diff by distance from mapped
     tidal water, with the deepest posts named.
  4. **The grade**, in the shore band and city-wide, on the solved profile and
     on the lattice. `MAX_GRADE` is a guarantee, and this is where it is read
     back off the output instead of trusted.
  5. **The escarpment, and everywhere else.** The Kings Cross ridge over
     Woolloomooloo, which is `TIE_RADIUS_M`'s own watch-point -- asserted on the
     **relief** between them and not on either height, because a tie chain is
     transitive and ground near a corrected shore is supposed to move -- and
     five inland controls, which are where "did not move" can honestly be
     asserted and where it comes out at zero.
  6. **The heroes**, built on both lattices and diffed.
  7. **Circular Quay's station ground**, and what the clearance becomes.
  8. **`road-grade-audit` on the scoped solve** -- the centreline half of
     `cli.cmd_road_grade_audit`, run through that command's own functions
     against a lattice this process solved. The emitted-facet half reads tiles
     and this round builds none; that is one printed line rather than a quiet
     skip, for the reason `_mesh_grade_report` itself gives.

RUN IT:

    cd pipeline
    PYTHONPATH=. uv run python sydney/roadgrade-sign-check.py                 # 5.3 km
    PYTHONPATH=. uv run python sydney/roadgrade-sign-check.py --radius 20000  # + the bake

Nothing here writes a tile, touches `client/public/world`, or runs a 60 km
anything. The solves land in the ordinary `terraincache` directory, keyed on the
`one_sided` flag like every other input, so the symmetric solve and the
one-sided one are two entries and neither can be mistaken for the other. Point
`SYDNEY_DATA_ROOT` at a scratch tree to keep four fresh lattices out of a shared
cache while a world round is building.
"""

from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import shapely

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from sydney import config, roadgrade, terraincache
from sydney.terrain import post_spacing

PASS, FAIL = "PASS", "FAIL"

# The transect, unchanged from `shoreline-check.py` so the two files' tables can
# be read against each other line for line.
QUAY_EAST = 140.0
QUAY_NORTHS = np.arange(1200.0, 559.0, -20.0)
QUAY_TRUTH = {
    860: (2.5, "the Quay promenade"),
    820: (2.5, "the promenade, behind the seawall"),
    780: (4.0, "Alfred Street"),
    700: (6.0, "Alfred St / Loftus St, rising"),
    680: (6.0, "under the Cahill deck; the deck itself ~20"),
}

# --- The escarpment ------------------------------------------------------------
#
# **This is the pair `roadgrade.TIE_RADIUS_M`'s own table watches**, and it is the
# reason this operator is per-post rather than a global switch to the downward
# projection. The Kings Cross ridge stands over Woolloomooloo -- the steepest
# piece of ground in the extent that a street runs along the top of, and what the
# McElhone Stairs are for. A downward projection applied everywhere cuts the top
# off it, because a ridge tied to a valley through the plan ties is a violation
# too and cutting the ridge is one of the two legal answers. That table measured
# what tightening `CROSS_GRADE` costs here: at an 8% cap the top comes down 1.5 m,
# and at 6% "the escarpment is gone -- the top has come down 8 m and the valley
# has come UP 5".
#
# **What is asserted is the relief and not the two heights**, and the distinction
# is this file's whole point. The two heights are allowed to move: the shore rule
# has corrected the Woolloomooloo foreshore two hundred metres north of the
# valley probe, and a Lipschitz chain is transitive by construction -- the
# `TIE_RADIUS_M` block says so in as many words -- so ground with no evidence of
# its own still comes down when a neighbour it is tied to does. That is the
# operator working, not leaking. What must survive is the **landform**: the ridge
# may not be flattened onto the valley.
#
# The ridge probe is the highest ground in the Kings Cross window on the shipped
# symmetric lattice; the valley probe is Woolloomooloo's floor, which reads 6.77
# and is the `'Loo` column of that same table.
RIDGE = ("Kings Cross, the top of the ridge", 1450.0, -375.0)
VALLEY = ("Woolloomooloo, the valley floor below it", 1019.5, -93.2)

# How much of the escarpment's relief may go, metres. A metre is a third of what
# `TIE_RADIUS_M`'s table calls the first sign of damage (1.5 m off the top at an
# 8% cap) and a sixth of what it calls the escarpment being gone. Measured here:
# 0.08 m, so this fence sits an order of magnitude clear of the result and would
# convict a change that started flattening landform.
RELIEF_BUDGET_M = 1.0

# --- The probes ----------------------------------------------------------------
#
# `shoreline-check.py`'s own probes, in ENU, so the two files report the same
# places, plus five inland ones that are only interesting to this file.
#
# `hold` is an **assertion** and it is only made where it can honestly be made:
# ground far enough from any corrected post that no chain of ties at
# `CROSS_GRADE` over `TIE_RADIUS_M` reaches it. Centennial Park is 971 m from
# mapped water with no footprints in it, which is `bareearth.py`'s own negative
# control; the other four are 0.9 to 3.2 km inland and between them they are the
# southern half of the ring. Every one of them comes out at **+0.0000**, so this
# is a fence with nothing behind it rather than a fence with a margin -- which is
# the shape a control should have.
#
# Everything else is `measure`: a number printed with what is there in life
# beside it, and no verdict, because "did this ground move" is not a question
# with a right answer at a place the correction is meant to reach. Sydney Tower
# is not a probe here at all; its own pad is in section 6, measured the way
# `landmark-audit` measures it, and a hand-picked post near it would have said
# +0.000 and been read as though it meant the hero had not moved.
PROBES = [
    ("Town Hall, the ENU origin (~28 m AHD in life)", 0.0, 0.0, "measure"),
    ("Mrs Macquaries Point, at the waterline", 1130.0, 1090.0, "measure"),
    ("Balmain East headland", -1750.0, 1420.0, "measure"),
    ("Dawes Point / The Rocks", -60.0, 1440.0, "measure"),
    ("Kirribilli, 180 m in", 400.0, 2480.0, "measure"),
    ("Surry Hills", 700.0, -900.0, "hold"),
    ("Centennial Park (no water, no buildings)", 2600.0, -1500.0, "hold"),
    ("Randwick", 2900.0, -2600.0, "hold"),
    ("Alexandria / Erskineville", 400.0, -2900.0, "hold"),
    ("Sydney Park, St Peters", 100.0, -3600.0, "hold"),
]

HOLD_TOLERANCE_M = 0.01

# How far from mapped tidal water counts as inland, and what may move out there.
# See the end of section 3. Measured on the 5.3 km ring: 61 posts of 148,225 move
# at all past a kilometre, and the deepest by 0.054 m.
FAR_M = 1000.0
FAR_BUDGET_M = 0.50

HEROES = ("opera_house", "harbour_bridge", "luna_park", "sydney_tower")


def _stat(v: np.ndarray, unit: str = "m") -> str:
    if not v.size:
        return "none"
    return (f"n {v.size:,}  p50 {np.percentile(v, 50):6.3f}  "
            f"p95 {np.percentile(v, 95):6.3f}  max {v.max():6.3f} {unit}")


def _posts(field):
    """The lattice's heights and the ENU of every post, flattened."""
    lat = field._lat
    q_n, p_n = lat.heights.shape
    east = (np.arange(p_n) + lat.p0) * lat.spacing
    north = (np.arange(q_n) + lat.q0) * lat.spacing
    return (
        lat.heights.reshape(-1).astype(np.float64),
        np.repeat(east[None, :], q_n, axis=0).ravel(),
        np.repeat(north[:, None], p_n, axis=1).ravel(),
    )


def _ahd(field, east, north) -> np.ndarray:
    return np.asarray(field.sample(east, north), dtype=np.float64) + field.base_elevation


# --- 1. The gate ---------------------------------------------------------------


def section_gate(sym, one, sym_roads, one_roads) -> list[str]:
    print("\n1. THE GATE -- the operator's own arithmetic")
    fails: list[str] = []

    # (a) On random graphs, where every property can be checked directly and a
    #     counter-example is one seed away. This is the only place
    #     `low <= new <= sym` can be asserted *as stated*, because the city's
    #     `low` is never computed -- computing it would be a third solve for a
    #     bound the arithmetic already gives.
    print("\n   (a) the projection itself, on random graphs")
    rng = np.random.default_rng(20260910)
    bad = 0
    for trial in range(200):
        n = int(rng.integers(8, 120))
        h = rng.normal(0.0, 30.0, n)
        # A path plus a handful of chords: a street with ties reaching across it.
        edges = [(k, k + 1) for k in range(n - 1)]
        for _ in range(int(rng.integers(0, n // 2 + 1))):
            a, b = int(rng.integers(0, n)), int(rng.integers(0, n))
            if a != b:
                edges.append((min(a, b), max(a, b)))
        e = np.asarray(edges, dtype=np.int64)
        limit = rng.uniform(0.3, 4.0, len(e))
        conf = np.clip(rng.uniform(-0.4, 1.4, n), 0.0, 1.0)
        conf[rng.uniform(0.0, 1.0, n) < 0.5] = 0.0
        sym_h, new = roadgrade._projections(h, e, limit, conf)
        low = roadgrade._projections(h, e, limit, np.ones(n))[1]
        gap = float((np.abs(new[e[:, 1]] - new[e[:, 0]]) - limit).max())
        if gap > 1e-9:
            bad += 1
            print(f"     {FAIL} trial {trial}: an edge is over its budget by {gap:.3e}")
        if (new > sym_h + 1e-9).any():
            bad += 1
            print(f"     {FAIL} trial {trial}: a node was raised above the symmetric answer")
        if (new < low - 1e-9).any():
            bad += 1
            print(f"     {FAIL} trial {trial}: a node fell below the downward projection")
        zero = roadgrade._projections(h, e, limit, np.zeros(n))
        if not np.array_equal(zero[0], zero[1]):
            bad += 1
            print(f"     {FAIL} trial {trial}: a zero confidence field is not the old answer")
    if bad:
        fails.append(f"{FAIL} the projection broke its own arithmetic on {bad} random graphs")
    else:
        print("     200 graphs, every edge inside its budget, low <= new <= sym everywhere,")
        print(f"     {PASS} and a zero confidence field returns the symmetric answer bit for bit")

    # (b) On the city, and **on the road pass alone**, which is where the
    #     operator's guarantee actually lives. `water.conform` and `pads.conform`
    #     run after it and neither is monotone: the water hold is an
    #     `np.maximum` and a pond's own surface is `BODY_QUANTILE` of the terrain
    #     inside it, so lowering the ground under a pond lowers its level and a
    #     post in it can come out higher than it was. Asserting on the shipped
    #     lattice would be asserting that two other modules are monotone, which
    #     they are not and do not claim to be. So the assertion is made on the
    #     pair with the water and the pads off, and the shipped pair is measured
    #     beside it with the difference named.
    print("\n   (b) the road pass alone -- water and pads off, so this is the operator")
    r0, _, _ = _posts(sym_roads)
    r1, _, _ = _posts(one_roads)
    d = r1 - r0
    up = int((d > 1e-6).sum())
    down = int((d < -1e-6).sum())
    print(f"     {down:,} of {r0.size:,} posts came down ({100.0 * down / r0.size:.2f}%), "
          f"{up:,} went up; the largest rise is {max(float(d.max()), 0.0):.6f} m")
    if up:
        fails.append(f"{FAIL} {up:,} posts were raised by the road pass; this operator "
                     "may only lower")
    else:
        print(f"     {PASS} not one post in the extent was raised by the road pass")

    print("\n   (c) the two shipped lattices the rest of this file reads")
    h0, east, north = _posts(sym)
    h1, _, _ = _posts(one)
    d = h1 - h0
    up = np.flatnonzero(d > 1e-6)
    down = int((d < -1e-6).sum())
    print(f"     {down:,} of {h0.size:,} posts came down ({100.0 * down / h0.size:.2f}%), "
          f"{len(up):,} went up")
    if len(up):
        print(f"     the rises are the water hold and the stated pads, downstream: "
              f"max {d[up].max():.4f} m, at")
        for k in up[np.argsort(-d[up])][:4]:
            print(f"       +{d[k]:.4f} m at E {east[k]:9.1f} N {north[k]:9.1f}"
                  f"  (the road pass moved it {r1[k] - r0[k]:+.6f})")
        if float(d[up].max()) > 0.5:
            fails.append(f"{FAIL} a post rose {d[up].max():.3f} m in the shipped lattice; "
                         "that is more than a pond level or a pad can account for")

    for label, field in (("symmetric", sym), ("one-sided", one)):
        st = (field.stats.get("roads") or {})
        if not st:
            continue
        print(f"     {label:10s} solve: {st['ways']:,} ways, {st['nodes']:,} nodes,"
              f"  profile grade p50 {100 * st['grade_p50']:5.2f}%"
              f"  p95 {100 * st['grade_p95']:5.2f}%  max {100 * st['grade_max']:6.2f}%"
              f"  over MAX_GRADE {st['over_max']}")
        if st["grade_max"] > roadgrade.MAX_GRADE + 1e-9:
            fails.append(f"{FAIL} the {label} solve broke MAX_GRADE at "
                         f"{100 * st['grade_max']:.2f}%")
    st = (one.stats.get("roads") or {})
    if st and "sign_nodes" in st:
        print(f"     evidence reached {st['sign_nodes']:,} nodes, {st['sign_trusted']:,} of "
              f"them at confidence 0.5 or better")
        print(f"     nodes the one-sidedness lowered: {st['sign_lowered']:,}, "
              f"p95 {st['sign_p95']:.3f} m, max {st['sign_max']:.3f} m")
        if st["sign_lowered"] == 0:
            fails.append(f"{FAIL} the one-sided branch lowered no node at all -- a zero "
                         "counter means the path never ran, not that it ran clean")
    return fails


# --- 2. The Quay transect ------------------------------------------------------


def section_transect(pre_off, pre_on, sym_off, sym_on, one_off, one_on) -> list[str]:
    print("\n2. THE QUAY TRANSECT -- east 140, Sydney Cove to the Cahill (m AHD)")
    e = np.full_like(QUAY_NORTHS, QUAY_EAST)
    p_off = _ahd(pre_off, e, QUAY_NORTHS)
    p_on = _ahd(pre_on, e, QUAY_NORTHS)
    g_sym = _ahd(sym_on, e, QUAY_NORTHS)
    g_one = _ahd(one_on, e, QUAY_NORTHS)
    s_off = _ahd(sym_off, e, QUAY_NORTHS)
    o_off = _ahd(one_off, e, QUAY_NORTHS)

    rec = one_on.shore[0] if one_on.shore else None
    wet = shapely.contains_xy(rec.geom, e, QUAY_NORTHS) if rec else np.zeros(len(e), bool)
    dist = (shapely.distance(shapely.points(e, QUAY_NORTHS), rec.geom.boundary)
            if rec else np.full(len(e), np.nan))

    print("      N  d(water)  symmetric  one-sided     move | in life")
    for i, n in enumerate(QUAY_NORTHS):
        truth = QUAY_TRUTH.get(int(n))
        note = f"{truth[0]:5.1f}  {truth[1]}" if truth else ""
        mark = "WET" if wet[i] else f"{dist[i]:6.0f}"
        print(f"  {n:5.0f}  {mark:>8}  {g_sym[i]:9.2f}  {g_one[i]:9.2f}  "
              f"{g_one[i] - g_sym[i]:+7.2f} | {note}")

    fails: list[str] = []
    print("\n   against what is there:")
    for n, (truth, label) in sorted(QUAY_TRUTH.items(), reverse=True):
        i = int(np.argmin(np.abs(QUAY_NORTHS - n)))
        before, after = g_sym[i] - truth, g_one[i] - truth
        better = abs(after) < abs(before)
        print(f"     N {n}: error {before:+6.2f} -> {after:+6.2f} m against {truth:4.1f} "
              f"({label}) -- {'closer' if better else 'NOT closer'}")
        if not better:
            fails.append(f"{FAIL} the transect at N {n} did not get closer to {truth:.1f} m AHD")

    # **The number this round exists to move.** Same population as
    # `shoreline-check.py` section 3 -- dry land, and only stations the shore
    # pass wrote more than a metre to -- so the two medians are directly
    # comparable. `kept` is measured with the shore pass off and on under the
    # *same* projection, because a ratio between two different operators'
    # shipped heights would be measuring both changes at once.
    print("\n   what the build keeps of what the shore pass wrote:")
    print("      N   the pass wrote   sym kept   one kept   sym ratio   one ratio")
    ratios = []
    for i, n in enumerate(QUAY_NORTHS):
        wrote = p_on[i] - p_off[i]
        if wet[i] or wrote > -1.0:
            continue
        ks, ko = g_sym[i] - s_off[i], g_one[i] - o_off[i]
        ratios.append((ks / wrote, ko / wrote))
        print(f"  {n:5.0f}  {wrote:+14.2f}  {ks:+9.2f}  {ko:+9.2f}  "
              f"{ks / wrote:10.2f}  {ko / wrote:10.2f}")
    if ratios:
        r = np.asarray(ratios)
        m_sym, m_one = float(np.median(r[:, 0])), float(np.median(r[:, 1]))
        print("\n   median kept / written, on dry land the pass wrote over a metre to:")
        print(f"     symmetric {m_sym:.2f}   one-sided {m_one:.2f}"
              f"   ({m_one - m_sym:+.2f})")
        if m_one <= m_sym + 1e-9:
            fails.append(f"{FAIL} the one-sided projection kept no more of the shore pass's "
                         f"write than the symmetric one did ({m_one:.2f} vs {m_sym:.2f})")
    return fails


# --- 3. What came down, and where ----------------------------------------------


def section_where(sym, one) -> list[str]:
    print("\n3. WHAT CAME DOWN, AND WHERE")
    h0, east, north = _posts(sym)
    h1, _, _ = _posts(one)
    d = h0 - h1
    moved = d > 1e-6
    if not moved.any():
        return [f"{FAIL} the one-sided projection moved no post in the extent"]
    print(f"   the whole diff: {_stat(d[moved])}")

    rec = one.shore[0] if one.shore else None
    if rec is None:
        print("   no shore record on this lattice, so there is no band to sort by")
        return []
    shapely.prepare(rec.geom)
    dw = shapely.distance(shapely.points(east[moved], north[moved]), rec.geom)
    dv = d[moved]
    print(f"   by distance from mapped tidal water (the band is {rec.reach_m:.0f} m):")
    edges = [(0.0, 100.0), (100.0, 250.0), (250.0, 500.0), (500.0, 1000.0),
             (1000.0, float("inf"))]
    for lo, hi in edges:
        m = (dw >= lo) & (dw < hi)
        tag = f"{lo:6.0f} - {hi:6.0f} m" if math.isfinite(hi) else f"{lo:6.0f} m and out"
        print(f"     {tag:>20}  {_stat(dv[m])}")
    order = np.argsort(-dv)[:10]
    print("   the ten deepest posts:")
    for k in order:
        e, n = east[moved][k], north[moved][k]
        tile = f"{math.floor(e / config.TILE_SIZE)}_{math.floor(n / config.TILE_SIZE)}"
        print(f"     -{dv[k]:6.3f} m  at E {e:8.1f} N {n:9.1f}  tile {tile:>8}"
              f"  {dw[k]:6.0f} m from water")

    # **The nearest thing to an extent this operator has.** It cannot be given
    # one -- a tie chain is transitive and reaches the whole city -- so instead
    # of asserting where it stopped, the check measures how far it actually got
    # and fences that. `FAR_M` is four times the shore band, `FAR_BUDGET_M` is an
    # order of magnitude over the measurement, and both are regression gates on
    # exactly the terms `road-grade-audit`'s `--max-over-share` is.
    far = dw >= FAR_M
    worst = float(dv[far].max()) if far.any() else 0.0
    print(f"   past {FAR_M:.0f} m from mapped tidal water: {int(far.sum()):,} posts moved at "
          f"all, the deepest by {worst:.3f} m (budget {FAR_BUDGET_M:.2f} m)")
    if worst > FAR_BUDGET_M:
        return [(
            f"{FAIL} a post {FAR_M:.0f} m from any tidal water came down {worst:.3f} m;"
            " the correction is reaching further inland than this operator has"
            " evidence to reach"
        )]
    print(f"     {PASS} the correction stays where there is something to correct")
    return []


# --- 4. The grade --------------------------------------------------------------


def section_grade(sym, one) -> list[str]:
    print("\n4. THE GRADE THIS PUTS INTO THE LATTICE")
    fails: list[str] = []
    cell = post_spacing()
    rec = one.shore[0] if one.shore else None
    lat = one._lat
    q_n, p_n = lat.heights.shape
    east = np.repeat(((np.arange(p_n) + lat.p0) * lat.spacing)[None, :-1], q_n, axis=0).ravel()
    north = np.repeat(((np.arange(q_n) + lat.q0) * lat.spacing)[:, None], p_n - 1, axis=1).ravel()
    band = (shapely.dwithin(shapely.points(east, north), rec.geom, rec.reach_m + cell)
            if rec else np.zeros(len(east), dtype=bool))

    grades = {}
    for label, field in (("symmetric", sym), ("one-sided", one)):
        g = np.abs(np.diff(field._lat.heights.astype(np.float64), axis=1)).ravel() / cell
        grades[label] = g
        print(f"   {label:10s} east-west post gradient")
        print(f"       in the band: p50 {100 * np.percentile(g[band], 50):5.2f}%  "
              f"p95 {100 * np.percentile(g[band], 95):5.2f}%  "
              f"max {100 * g[band].max():6.2f}%")
        print(f"       city-wide:   p50 {100 * np.percentile(g, 50):5.2f}%  "
              f"p95 {100 * np.percentile(g, 95):5.2f}%  max {100 * g.max():6.2f}%")
    delta = grades["one-sided"] - grades["symmetric"]
    worse = delta[delta > 0]
    if worse.size:
        print(f"   extra grade where it is worse: {worse.size:,} cells, "
              f"p50 {100 * np.percentile(worse, 50):5.2f}%  "
              f"p95 {100 * np.percentile(worse, 95):5.2f}%  max {100 * worse.max():6.2f}%")
    else:
        print("   nothing in the lattice got steeper")

    # The lattice is a 31.25 m grid and `roadgrade.py`'s closing note already
    # says it cannot hold a level street beside a cliff, so `MAX_GRADE` is a
    # guarantee about the **solved profile** and not about the posts. That is
    # where it is read back.
    print("\n   MAX_GRADE is a guarantee about the solved profile; read back off it:")
    for label, field in (("symmetric", sym), ("one-sided", one)):
        st = (field.stats.get("roads") or {})
        if not st:
            continue
        ok = st["grade_max"] <= roadgrade.MAX_GRADE + 1e-9
        print(f"     {label:10s} max {100 * st['grade_max']:6.3f}% against "
              f"{100 * roadgrade.MAX_GRADE:.0f}% -- {PASS if ok else FAIL}"
              f"  ({st['over_max']} edges over)")
        if not ok:
            fails.append(f"{FAIL} the {label} profile exceeds MAX_GRADE")
    return fails


# --- 5. The escarpment, and everywhere else ------------------------------------


def section_probes(sym, one) -> list[str]:
    print("\n5. THE ESCARPMENT, AND EVERYWHERE ELSE (m AHD)")
    fails: list[str] = []
    print("   the pair `roadgrade.TIE_RADIUS_M`'s table watches. The two heights may")
    print("   move -- a tie chain is transitive and the shore two hundred metres north")
    print("   of the valley probe was corrected -- but the RELIEF may not go:")
    tops = []
    for label, e, n in (RIDGE, VALLEY):
        a, b = float(_ahd(sym, e, n)), float(_ahd(one, e, n))
        tops.append((a, b))
        print(f"     {label:44s} E {e:7.1f} N {n:8.1f}  {a:7.2f} -> {b:7.2f}  ({b - a:+.3f})")
    relief_sym = tops[0][0] - tops[1][0]
    relief_one = tops[0][1] - tops[1][1]
    lost = relief_sym - relief_one
    print(f"     the escarpment itself: {relief_sym:.2f} m of relief -> {relief_one:.2f} m "
          f"({-lost:+.3f}, budget {RELIEF_BUDGET_M:.1f} m)")
    if lost > RELIEF_BUDGET_M:
        fails.append(f"{FAIL} the Kings Cross escarpment lost {lost:.2f} m of relief, over "
                     f"the {RELIEF_BUDGET_M:.1f} m budget -- the operator is flattening "
                     "landform, which is what the per-post confidence exists to prevent")
    else:
        print(f"     {PASS} the landform survives")

    print("\n   probe                                         d(water)  symmetric  one-sided"
          "     move  expect")
    rec = one.shore[0] if one.shore else None
    for label, e, n, expect in PROBES:
        a, b = float(_ahd(sym, e, n)), float(_ahd(one, e, n))
        d = shapely.distance(shapely.Point(e, n), rec.geom) if rec else float("nan")
        print(f"   {label:45s} {d:8.1f} {a:10.2f} {b:10.2f} {b - a:+8.3f}  {expect}")
        if expect == "hold" and abs(b - a) > HOLD_TOLERANCE_M:
            fails.append(f"{FAIL} {label}: the operator moved ground no chain of ties can "
                         f"reach, by {b - a:+.3f} m")
    if not any(f.endswith("m") for f in fails):
        print(f"   {PASS} every `hold` probe is inside {HOLD_TOLERANCE_M * 100:.0f} cm")
    return fails


# --- 6. The heroes -------------------------------------------------------------


def section_heroes(radius_m: float, sym, one) -> list[str]:
    print("\n6. THE HEROES")
    from sydney import landmarks

    anchors = landmarks.read_anchors(min(radius_m, 4000.0))
    try:
        before = {m.name: m.audit for m in landmarks.build_all(sym, anchors)}
        after = {m.name: m.audit for m in landmarks.build_all(one, anchors)}
    except Exception as err:  # noqa: BLE001 -- a hero that will not build is not this gate
        print(f"   the landmark build did not run at this radius: {err!r}")
        return []

    for name in HEROES:
        if name not in before or name not in after:
            continue
        diffs = []
        for k, v in before[name].items():
            w = after[name].get(k)
            if isinstance(v, (int, float)) and isinstance(w, (int, float)) and abs(w - v) > 1e-6:
                diffs.append(f"{k} {v:.3f} -> {w:.3f} ({w - v:+.3f})")
        print(f"   {name:16s} {'identical to the millimetre' if not diffs else '; '.join(diffs)}")

    # The Opera House's podium is a stated AHD platform and cannot move; what can
    # move is the ground its podium prism is founded on and the riser of its
    # ceremonial stairs, neither of which appears in the audit block. Read the
    # same way `shoreline-check.py` reads it, so the two files' rows line up.
    ring = np.asarray(
        shapely.Polygon(anchors["opera"].ring).buffer(0).simplify(1.2).exterior.coords
    )
    for label, field in (("sym", sym), ("one", one)):
        sea = -field.base_elevation
        g = float(min(field.sample(ring[:, 0], ring[:, 1])))
        riser = (sea + landmarks.OPERA_PODIUM_TOP_AHD - (g + 1.0)) / landmarks.OPERA_STAIR_STEPS
        print(f"   opera podium, {label}: founded on min(ground over the plan) "
              f"{g + field.base_elevation:6.2f} m AHD; top {landmarks.OPERA_PODIUM_TOP_AHD:.1f} "
              f"AHD (stated, cannot move); stair riser {riser:+.3f} m over "
              f"{landmarks.OPERA_STAIR_STEPS} treads")

    centre, along, _across = landmarks._bridge_frame(anchors)
    half_span = landmarks.BRIDGE_ARCH_SPAN * 0.5
    half_len = landmarks.BRIDGE_TOTAL_LENGTH * 0.5
    for label, field in (("sym", sym), ("one", one)):
        b = field.base_elevation
        row = []
        for name, s in (
            ("arch pin S", -half_span),
            ("arch pin N", half_span),
            ("ramp foot S", -half_len - before["harbour_bridge"]["ramp_south_m"] - 6.0),
            ("ramp foot N", half_len + before["harbour_bridge"]["ramp_north_m"] + 6.0),
        ):
            e2 = centre[0] + along[0] * s
            n2 = centre[1] + along[1] * s
            row.append(f"{name} {float(field.sample(e2, n2)) + b:6.2f}")
        print(f"   bridge abutments, {label}: " + "  ".join(row) + "  m AHD")
    return []


# --- 7. Circular Quay's station ground -----------------------------------------


def section_clearance(radius_m: float, sym, one) -> list[str]:
    print("\n7. CIRCULAR QUAY'S STATION GROUND")
    from sydney import pads, rail

    zones = [z for z in pads.bridge_station_zones(radius_m) if "Circular" in z.name]
    if not zones:
        print("   Circular Quay is not a bridge-tagged station in this extract.")
        return []
    z = zones[0]
    e, n = float(z.note["east"]), float(z.note["north"])
    g_sym, g_one = float(_ahd(sym, e, n)), float(_ahd(one, e, n))
    drop = g_sym - g_one
    print(f"   the station node is E {e:.1f} N {n:.1f}")
    print(f"   ground there: {g_sym:7.2f} -> {g_one:7.2f} m AHD  ({-drop:+.2f} m)")
    print("   RAIL-VERTICAL 3c records the shipped 20 km bake at clearance -6.74 m and 3d")
    print("   takes it to -4.20 .. -0.06 on the shore pass alone. `rail.raw_heights` gives a")
    print(f"   bridge node `terrain.sample(...) + BRIDGE_RISE` and BRIDGE_RISE is "
          f"{rail.BRIDGE_RISE:.1f} m, so the")
    print("   deck follows the ground down and only what the 3.3% grade projection pulls")
    print("   back from approaches that did not move survives -- 0.38 in the dollar at")
    print("   Chatswood (3b). So on top of the shore pass's own move, this operator's")
    lo, hi = drop * 0.38, drop
    print(f"   {drop:.2f} m here is worth a further {lo:+.2f} .. {hi:+.2f} m of clearance.")

    if radius_m < 20000.0:
        print("\n   The rail bake needs 20 km (see `bare-earth-check.py`'s header);")
        print("   re-run with --radius 20000 for the measured clearance rather than this band.")
        return []
    for label, field in (("sym", sym), ("one", one)):
        t0 = time.time()
        try:
            b = rail.build_all(radius_m, log=lambda *_a, **_k: None, terrain=field)
        except IndexError as err:
            print(f"   the bake cannot run at this radius: {err!r}")
            return []
        st = next((s for s in b["stations"] if "Circular" in s.name), None)
        if st is None:
            print(f"   {label}: the bake has no Circular Quay record")
            continue
        print(f"   {label} ({time.time() - t0:.0f}s): "
              f"clearance {st.clearance:+.2f} [{st.clearance_lo:+.2f} .. {st.clearance_hi:+.2f}] "
              f"vertical {st.vertical} groundY {st.ground_y:.2f} trackY {st.track_y:.2f}")
    return []


# --- 8. road-grade-audit on the scoped solve -----------------------------------


def section_audit(radius_m: float, sym, one) -> list[str]:
    """`cmd_road_grade_audit`'s own centreline half, on a lattice we solved.

    Not a re-implementation: `_tidal_plan`, `_grade_report` and
    `_solve_fidelity_report` are imported from `cli.py` and called with the
    namespace that command builds, so the numbers printed here are the numbers
    that command prints. What is left out is `_mesh_grade_report`, which reads
    `road_asphalt` out of emitted GLBs -- there are no tiles in a scoped solve
    and that function is right to raise rather than go quiet, so it is named
    here instead of being swallowed.
    """
    print("\n8. ROAD-GRADE-AUDIT ON THE SCOPED SOLVE")
    from sydney import cli
    from sydney.sources import osm

    args = argparse.Namespace(station=10.0, max_grade=roadgrade.MAX_GRADE, worst=8,
                              max_over_share=0.001, tiles=0, no_shore=False, only=[])
    roads = osm.read_roads(radius_m)
    surface = [r for r in roads if roadgrade._is_conformable(r)]
    fails: list[str] = []
    for label, field in (("symmetric", sym), ("one-sided", one)):
        print(f"\n   --- {label} ---")
        shore = cli._tidal_plan({}, radius_m, field)
        share = cli._grade_report("carriageways", surface, field, args, None, shore, want=False)
        if shore is not None:
            cli._grade_report(
                "carriageways at the tidal shore (excluded from the verdict -- see"
                " `_tidal_plan`)",
                surface, field, args, None, shore, want=True,
            )
        cli._solve_fidelity_report(field, surface, args, None)
        verdict = "within limits" if share <= args.max_over_share else "FAIL"
        print(f"   {verdict}: {100 * share:.3f}% of segments over "
              f"{100 * args.max_grade:.0f}% (limit {100 * args.max_over_share:.3f}%)")
        if share > args.max_over_share:
            fails.append(f"{FAIL} the {label} surface puts {100 * share:.3f}% of carriageway "
                         f"segments over {100 * args.max_grade:.0f}%")
    print("\n   the emitted-facet half of this command reads `road_asphalt` out of the")
    print("   shipped GLBs and a scoped solve emits none, so it is not run here. It is")
    print("   `road-grade-audit --surface tiles` after a retile, and it is the half that")
    print("   would catch a deck rather than a street.")
    return fails


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--radius", type=float, default=5300.0)
    args = ap.parse_args(argv)
    r = args.radius

    print(f"roadgrade-sign-check: {r / 1000:.1f} km ring, "
          f"SIGN_CORRECTED_M {roadgrade.SIGN_CORRECTED_M:.1f} m, "
          f"SIGN_BUILT_M {roadgrade.SIGN_BUILT_M:.1f} m")
    t0 = time.time()
    bare = {"conform_roads": False, "conform_water": False, "conform_pads": False}
    print("\n  the shore pass's own write, before any road solve ...")
    pre_off = terraincache.load(r, shoreline=False, **bare)
    pre_on = terraincache.load(r, shoreline=True, **bare)
    print("  the four shipped lattices (shore off/on x symmetric/one-sided) ...")
    sym_off = terraincache.load(r, shoreline=False, one_sided=False)
    sym_on = terraincache.load(r, shoreline=True, one_sided=False)
    one_off = terraincache.load(r, shoreline=False, one_sided=True)
    one_on = terraincache.load(r, shoreline=True, one_sided=True)
    # The pair section 1 makes its assertion on. Water and pads off, because
    # neither of those two passes is monotone and the operator's guarantee is
    # about the operator. See section 1 (b).
    print("  the road pass alone, water and pads off ...")
    roads_only = {"conform_water": False, "conform_pads": False}
    sym_roads = terraincache.load(r, one_sided=False, **roads_only)
    one_roads = terraincache.load(r, one_sided=True, **roads_only)
    print(f"  eight lattices ready in {time.time() - t0:.0f}s")

    fails: list[str] = []
    fails += section_gate(sym_on, one_on, sym_roads, one_roads)
    fails += section_transect(pre_off, pre_on, sym_off, sym_on, one_off, one_on)
    fails += section_where(sym_on, one_on)
    fails += section_grade(sym_on, one_on)
    fails += section_probes(sym_on, one_on)
    fails += section_heroes(r, sym_on, one_on)
    fails += section_clearance(r, sym_on, one_on)
    fails += section_audit(r, sym_on, one_on)

    print("\n" + "=" * 78)
    if fails:
        for f in fails:
            print(f)
        print(f"{FAIL}: {len(fails)} failure(s)")
        return 1
    print(f"{PASS}: nothing in the extent was raised; the shore keeps more of what the")
    print("       pass wrote; the escarpment and the unevidenced ground did not move;")
    print("       MAX_GRADE is still a guarantee about the solved profile.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
