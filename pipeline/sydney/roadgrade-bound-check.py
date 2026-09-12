"""The gate on the bound: prove it on the lattice the regression was measured on.

`roadgrade-sign-check.py` is this file's immediate sibling and its subject is the
operator's *sign*; this file's subject is the operator's *size*. The two are one
argument in two halves and the halves are gated separately for a reason the
shape of the failure gives: the sign was provable on the 5.3 km ring, because the
Quay is in it and the Quay is where the truth is written down. **The size was
not, and that is why it shipped.** Coledale is fifty-three kilometres south of
Town Hall, Brooklyn forty north, Penrith forty-five west; the ring that proved
the sign contains none of them, every number in §3e is true, and the round-three
world still came out with eighteen metres off the median post of a tile on the
Illawarra escarpment.

So this check is a **lattice diff at the world's own radius**, and it is the only
kind of proof the defect admits. `roadgrade.TIE_RADIUS_M`'s block already says
why: a tie chain is transitive and reaches the whole city, so an operator that
fires through one has no extent and no scoped ring can contain its consequences.
What can be asserted instead is a **budget per place** -- and the place is a
3 km cell, which is six tiles on a side and the scale at which "a village came
down" is a statement rather than an anecdote.

    no cell further than `HARBOUR_BAND_M` from Circular Quay may drop more than
    `CELL_BUDGET_M` against round two.

The exemption is not a fudge and it is stated here rather than buried: the CBD's
twenty metres and the Quay's ten **are the intended result**, they are what §3d
and §3e were for, and an assertion that convicted them would be an assertion
against the last two rounds. Everything outside that band is ground nobody has
claimed a correction for, and the whole of this round is the sentence that ground
may not be moved by a chain that cannot pay for it.

Four sections:

  1. **The arithmetic**, on random graphs, where `low <= out <= sym`, feasibility,
     `out >= the unbounded answer`, and the two bit-for-bit identities can be
     checked exhaustively for the price of nothing and a counter-example is one
     seed away. This is the section that runs at any radius and in a second.
  2. **The named places** -- the six the regression was reported at and the Quay
     -- with round two, round three and now, side by side.
  3. **The cells**, which is the assertion. Deepest drop and posts past
     `DEEP_M` per 3 km cell, the worst twenty printed, every cell outside the
     band tested.
  4. **The Quay's gain**, which this round may not give back: the transect at
     east 140 and Circular Quay's station ground, against round three, inside
     `QUAY_BUDGET_M`.

RUN IT:

    cd pipeline
    PYTHONPATH=. uv run python sydney/roadgrade-bound-check.py --arithmetic-only
    PYTHONPATH=. uv run python sydney/roadgrade-bound-check.py \
        --before <round-two key> --after <round-three key>

The second form **solves a 60 km lattice** if the shared cache does not already
hold one for these sources -- half an hour and eight and a half gigabytes, which
is the machine's ceiling and the reason `CLAUDE.md` rations it. It goes into
`data/cache/terrain-solve` under the key the committed sources produce, through
`terraincache` like every other solve, so the next reader of these sources hits
it instead of paying for it again. Nothing here writes a tile or touches
`client/public/world`.
"""

from __future__ import annotations

import argparse
import pickle
import sys
import time

import numpy as np

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from sydney import config, roadgrade, terraincache

PASS, FAIL = "PASS", "FAIL"

# The round the regression is measured against and the round it is measured in.
# Defaults rather than requirements, so the file still runs when somebody has
# rebuilt either of them; both are overridable on the command line.
ROUND_TWO = "863ff654a3fa11fdc0cef7c2829442dfe6045503707ee1d585ad9182a3ae4fc0"
ROUND_THREE = "344f4eb7f3eb0b79fe94c677632238d86c227b190c5a052c457db4bb35219252"

# The cell, and the two numbers the assertion is made of.
#
# `CELL_M` is 3 km because that is the scale a suburb is: six tiles on a side,
# 9,216 lattice posts, enough that a single post on a headland cannot carry a
# verdict and small enough that Coledale and Scarborough are not averaged in
# with the escarpment behind them.
#
# `CELL_BUDGET_M` is 8 m, which is the number the regression report chose and it
# sits where a fence should: the deepest thing that is *right* outside the
# harbour is the shore pass's own write, whose 60 km p95 is 1.38 m and whose
# whole-extent max is 18.73 m at a wharf; and the eleven cells this check
# convicts round three on run from 8.14 to 27.13 m. Eight metres is above every
# correction anybody has argued for out there and below every drop anybody has
# complained about, with the shallowest conviction 0.14 m clear of it -- which is
# tight, and is the fence being honest about how close the two populations are
# rather than a margin being claimed.
#
# `DEEP_M` is only a counter and asserts nothing: how many posts in a cell moved
# by more than a storey, which is what makes a drop a place rather than a post.
CELL_M = 3000.0
CELL_BUDGET_M = 8.0
DEEP_M = 5.0

# Circular Quay, and how far the intended correction is allowed to reach. The
# band is the CBD, Millers Point, Barangaroo, Woolloomooloo and the two north
# shore points -- every place §3d and §3e argued about -- and nothing else.
QUAY_E, QUAY_N = 140.0, 820.0
HARBOUR_BAND_M = 3000.0

# What section 4 will not give back, metres. §3e bought Circular Quay's station
# ground 30.56 -> 20.36 and the transect at N820 26.42 -> 15.18; this round is a
# bound on a projection and not a revision of either, so it may move them by the
# width of a lattice facet and no more.
QUAY_BUDGET_M = 2.0

# The places the regression was reported at, **by tile**, because a tile is what
# the terrain byte-diff counts and a tile is how the report named them. The three
# the report gave only as suburbs are here as the deepest tile in each of their
# regions, found by scanning the round-three diff rather than by geocoding a
# name: `-98_27` is Penrith on the Nepean, `-10_-42` is Cronulla, `10_71` is
# Brooklyn on the Hawkesbury.
#
# **Two of them are much shallower than the report said and that is recorded
# here rather than quietly dropped.** Penrith's deepest post moved 2.26 m and
# Cronulla's 3.46 m between these two rounds, against the 8.7 and 6.8 the report
# quoted. Both lattice and shipped `.terr.bin` agree on the smaller numbers, so
# the two big ones were measured against something else. They stay in the table
# because they are the right places to watch and because a check that silently
# renamed its own controls would be worthless.
NAMED_TILES = {
    "Coledale": [(-48, -95), (-49, -95), (-48, -94), (-49, -94), (-47, -95)],
    "Manly": [(15, 32), (15, 31), (16, 31), (14, 31)],
    "Brooklyn": [(10, 71)],
    "Kirribilli": [(-1, 6)],
    "Cronulla": [(-10, -42)],
    "Penrith": [(-98, 27)],
}


def _load_key(key: str):
    path = config.CACHE_DIR / "terrain-solve" / f"{key}.pkl"
    if not path.exists():
        raise SystemExit(f"{FAIL} no cache entry {key[:12]} at {path}")
    t0 = time.time()
    with open(path, "rb") as f:
        field = pickle.load(f)
    print(f"   loaded {key[:12]} in {time.time() - t0:.0f}s")
    return field


def _grid(field):
    """Heights in m AHD, and the ENU of every post, all on the lattice's shape."""
    lat = field._lat
    q_n, p_n = lat.heights.shape
    east = (np.arange(p_n) + lat.p0) * lat.spacing
    north = (np.arange(q_n) + lat.q0) * lat.spacing
    return (
        lat.heights.astype(np.float64) + field.base_elevation,
        np.repeat(east[None, :], q_n, axis=0),
        np.repeat(north[:, None], p_n, axis=1),
    )


# --- 1. The arithmetic ---------------------------------------------------------


def section_arithmetic() -> list[str]:
    """Everything `--- The bound on the projection ---` claims, on small graphs.

    The four properties are the block's own three plus the one this round adds,
    and the fourth is the one that makes the other three worth having: the bound
    may only ever hand height **back** toward the symmetric answer. A bound that
    could also take height away would be a second operator wearing a fence's
    name.
    """
    print("\n1. THE ARITHMETIC -- the bounded projection, on random graphs")
    rng = np.random.default_rng(20260912)
    bad: dict[str, int] = {}
    for _ in range(300):
        n = int(rng.integers(8, 120))
        h = rng.normal(0.0, 30.0, n)
        edges = [(k, k + 1) for k in range(n - 1)]
        for _ in range(int(rng.integers(0, n // 2 + 1))):
            a, b = int(rng.integers(0, n)), int(rng.integers(0, n))
            if a != b:
                edges.append((min(a, b), max(a, b)))
        e = np.asarray(edges, dtype=np.int64)
        limit = rng.uniform(0.3, 4.0, len(e))
        conf = np.clip(rng.uniform(-0.4, 1.4, n), 0.0, 1.0)
        conf[rng.uniform(0.0, 1.0, n) < 0.5] = 0.0
        budget = roadgrade.BOUND_TOL_M + np.where(
            rng.uniform(0, 1, n) < 0.5, rng.uniform(0.0, 20.0, n), 0.0
        )

        sym, out = roadgrade._projections(h, e, limit, conf, budget)
        low = roadgrade._projections(h, e, limit, np.ones(n))[1]
        free = roadgrade._projections(h, e, limit, conf)[1]

        def note(k: str) -> None:
            bad[k] = bad.get(k, 0) + 1

        if float((np.abs(out[e[:, 1]] - out[e[:, 0]]) - limit).max()) > 1e-9:
            note("an edge is over its budget")
        if (out > sym + 1e-9).any():
            note("a node was raised above the symmetric answer")
        if (out < low - 1e-9).any():
            note("a node fell below the downward projection")
        if (out < free - 1e-9).any():
            note("the bound took height away instead of handing it back")
        z = roadgrade._projections(h, e, limit, np.zeros(n), budget)
        if not np.array_equal(z[0], z[1]):
            note("a zero confidence field is not the old answer")
        if not np.array_equal(roadgrade._projections(h, e, limit, conf, None)[1], free):
            note("no budget is not the unbounded answer")

    # The allowance, on a path, where the answer can be written down: ten metres
    # of evidence at one end, a hundred metres a step, plus a node with built
    # mass of its own that owes nothing to any chain.
    n = 8
    e = np.column_stack((np.arange(n - 1), np.arange(1, n)))
    m = np.zeros(n)
    m[0] = 10.0
    own = np.zeros(n)
    own[6] = 4.0
    a = roadgrade._allowance(m, e, np.full(n - 1, 100.0), own)
    want = np.array([10.0, 5.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0])
    reach = 10.0 / roadgrade.BOUND_DECAY
    print(f"   the allowance along a path, 100 m a step: {np.round(a, 2).tolist()}")
    print(f"   ten metres of evidence reaches {reach:.0f} m at BOUND_DECAY "
          f"{roadgrade.BOUND_DECAY}, and a node's own built mass stands without a chain")
    fails: list[str] = []
    if not np.allclose(a, want):
        fails.append(f"{FAIL} the allowance is not {want.tolist()}")
    if bad:
        for k, v in sorted(bad.items()):
            print(f"     {FAIL} {k}: {v} of 300")
        fails.append(f"{FAIL} the bounded projection broke its arithmetic on "
                     f"{sum(bad.values())} of 300 random graphs")
    else:
        print("   300 graphs: every edge inside its budget, low <= out <= sym everywhere,")
        print("   out >= the unbounded one-sided answer everywhere, and both of the")
        print(f"   {PASS} bit-for-bit identities -- zero confidence, and no budget")
    return fails


# --- 2. The named places -------------------------------------------------------


def _cells(h, E, N, ref):
    """Per `CELL_M` cell: deepest drop against `ref`, and posts past `DEEP_M`."""
    d = h - ref
    ci = np.floor(E / CELL_M).astype(np.int64)
    cj = np.floor(N / CELL_M).astype(np.int64)
    i0, j0 = ci.min(), cj.min()
    w, hgt = int(ci.max() - i0 + 1), int(cj.max() - j0 + 1)
    flat = (cj - j0) * w + (ci - i0)
    n = w * hgt
    deepest = np.zeros(n)
    np.minimum.at(deepest, flat.ravel(), d.ravel())
    deep = np.bincount(flat.ravel(), weights=(d < -DEEP_M).ravel().astype(np.float64),
                       minlength=n)
    centre_e = (np.arange(n) % w + i0 + 0.5) * CELL_M
    centre_n = (np.arange(n) // w + j0 + 0.5) * CELL_M
    live = np.bincount(flat.ravel(), minlength=n) > 0
    return deepest, deep.astype(np.int64), centre_e, centre_n, live


def section_places(h2, h3, hn, E, N) -> list[str]:
    print("\n2. THE NAMED PLACES -- m AHD, median over the tile, and the deepest post")
    print(f"   {'place':16s} {'tile/at':>14} {'round 2':>9} {'round 3':>9} {'now':>9}"
          f" {'3 vs 2':>8} {'now vs 2':>9} {'deepest':>8}")
    rows = []
    for name, tiles in NAMED_TILES.items():
        for tx, tz in tiles:
            m = ((E >= tx * 500) & (E < (tx + 1) * 500)
                 & (N >= tz * 500) & (N < (tz + 1) * 500))
            rows.append((name, f"{tx}_{tz}", m))
    m = (np.abs(E - QUAY_E) <= 250.0) & (np.abs(N - QUAY_N) <= 250.0)
    rows.append(("the Quay", "E0.1 N0.8", m))

    for name, where, m in rows:
        if not m.any():
            print(f"   {name:16s} {where:>14}   -- outside this lattice")
            continue
        a, b, c = np.median(h2[m]), np.median(h3[m]), np.median(hn[m])
        worst = float((hn[m] - h2[m]).min())
        print(f"   {name:16s} {where:>14} {a:9.2f} {b:9.2f} {c:9.2f}"
              f" {b - a:8.2f} {c - a:9.2f} {worst:8.2f}")
    return []


# --- 3. The cells, which is the assertion --------------------------------------


def section_cells(h2, h3, hn, E, N) -> list[str]:
    print(f"\n3. THE CELLS -- {CELL_M / 1000:.0f} km cells, against round two")
    d3, n3, ce, cn, live = _cells(h3, E, N, h2)
    dn, nn, _, _, _ = _cells(hn, E, N, h2)
    far = np.hypot(ce - QUAY_E, cn - QUAY_N) > HARBOUR_BAND_M
    print(f"   {int(live.sum()):,} live cells, {int((live & far).sum()):,} of them further "
          f"than {HARBOUR_BAND_M / 1000:.0f} km from the Quay")
    print(f"\n   {'cell centre':>18} {'km from Quay':>13} | {'round 3 deep':>12} "
          f"{'>5 m':>7} | {'now deep':>9} {'>5 m':>7}")
    order = np.argsort(d3)
    for k in order[:20]:
        if not live[k]:
            continue
        print(f"   E{ce[k] / 1000:+7.1f} N{cn[k] / 1000:+7.1f} "
              f"{np.hypot(ce[k] - QUAY_E, cn[k] - QUAY_N) / 1000:13.1f} |"
              f" {d3[k]:12.2f} {n3[k]:7,} | {dn[k]:9.2f} {nn[k]:7,}"
              f"{'   (harbour band)' if not far[k] else ''}")

    fails: list[str] = []
    over = np.flatnonzero(live & far & (dn < -CELL_BUDGET_M))
    was = np.flatnonzero(live & far & (d3 < -CELL_BUDGET_M))
    print(f"\n   cells outside the band past {CELL_BUDGET_M:.0f} m: "
          f"round three {len(was):,}, now {len(over):,}")
    if len(over):
        for k in over[np.argsort(dn[over])][:10]:
            print(f"     {FAIL} E{ce[k] / 1000:+7.1f} N{cn[k] / 1000:+7.1f} "
                  f"is {np.hypot(ce[k] - QUAY_E, cn[k] - QUAY_N) / 1000:.1f} km out "
                  f"and dropped {dn[k]:.2f} m")
        fails.append(f"{FAIL} {len(over):,} cells outside the harbour band dropped more "
                     f"than {CELL_BUDGET_M:.0f} m")
    else:
        print(f"   {PASS} no cell further than {HARBOUR_BAND_M / 1000:.0f} km from the "
              f"Quay drops more than {CELL_BUDGET_M:.0f} m")
    d = hn - h2
    print(f"   whole lattice against round two: {int((d < -1e-6).sum()):,} posts down, "
          f"deepest {d.min():.2f} m; round three was {int((h3 - h2 < -1e-6).sum()):,} "
          f"down, deepest {(h3 - h2).min():.2f} m")
    return fails


# --- 4. The Quay's gain --------------------------------------------------------


def section_quay(radius_m: float, h3, hn, E, N, three, now) -> list[str]:
    print("\n4. THE QUAY'S GAIN -- what this round may not give back (m AHD)")
    fails: list[str] = []
    print(f"   {'N':>6} {'round 3':>9} {'now':>9} {'delta':>7}   in life")
    truth = {860: "~2.5, the promenade", 820: "~2.5, behind the seawall",
             780: "~4, Alfred Street", 700: "~6", 680: "~6, under the Cahill deck"}
    for n, life in truth.items():
        m = (np.abs(E - QUAY_E) <= 20.0) & (np.abs(N - n) <= 20.0)
        if not m.any():
            continue
        a, b = float(np.median(h3[m])), float(np.median(hn[m]))
        flag = "" if abs(b - a) <= QUAY_BUDGET_M else f"  {FAIL}"
        print(f"   {n:6d} {a:9.2f} {b:9.2f} {b - a:7.2f}   {life}{flag}")
        if abs(b - a) > QUAY_BUDGET_M:
            fails.append(f"{FAIL} the Quay transect at N {n} moved {b - a:+.2f} m, more "
                         f"than {QUAY_BUDGET_M:.1f} m")

    from sydney import pads

    zones = [z for z in pads.bridge_station_zones(radius_m) if "Circular" in z.name]
    if zones:
        e, n = float(zones[0].note["east"]), float(zones[0].note["north"])
        a = float(np.asarray(three.sample(e, n))) + three.base_elevation
        b = float(np.asarray(now.sample(e, n))) + now.base_elevation
        print(f"\n   Circular Quay's station ground, E {e:.1f} N {n:.1f}: "
              f"{a:.2f} -> {b:.2f} m AHD ({b - a:+.2f})")
        print("   RAIL-VERTICAL 3e took it 30.56 -> 20.36 and this round is a bound on a")
        print("   projection, not a revision of that.")
        if abs(b - a) > QUAY_BUDGET_M:
            fails.append(f"{FAIL} Circular Quay's station ground moved {b - a:+.2f} m, "
                         f"more than {QUAY_BUDGET_M:.1f} m")
    st = now.stats.get("roads") or {}
    if st:
        print(f"\n   the solve: budget p50 {st.get('bound_budget_p50', 0):.2f} "
              f"p95 {st.get('bound_budget_p95', 0):.2f} m; the floor bound "
              f"{st.get('bound_nodes', 0):,} nodes directly, by up to "
              f"{st.get('bound_max', 0):.3f} m -- a count of causes, not of")
        print("   consequences: the lift then travels the chain the way the pull does,")
        print("   which is what section 2's places measure.")
        print(f"   one-sidedness lowered {st.get('sign_lowered', 0):,} nodes, "
              f"max {st.get('sign_max', 0):.3f} m; profile grade max "
              f"{100 * st.get('grade_max', 0):.3f}%, over MAX_GRADE {st.get('over_max', 0)}")
        if st.get("bound_nodes", 0) == 0:
            fails.append(f"{FAIL} the floor held no node at all -- a zero counter means "
                         "the path never ran, not that it ran clean")
        if st.get("grade_max", 0.0) > roadgrade.MAX_GRADE + 1e-9:
            fails.append(f"{FAIL} the solve broke MAX_GRADE at "
                         f"{100 * st['grade_max']:.2f}%")
    return fails


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--radius", type=float, default=60000.0)
    ap.add_argument("--before", default=ROUND_TWO, help="round two's cache key")
    ap.add_argument("--after", default=ROUND_THREE, help="round three's cache key")
    ap.add_argument("--arithmetic-only", action="store_true",
                    help="section 1 only; no lattice, no solve")
    ap.add_argument("--now", default=None,
                    help="read the lattice under test from this cache key instead of "
                         "solving one. For re-reading an archived round, and for "
                         "proving this file's own tables against a solve that already "
                         "exists rather than by spending half an hour on one.")
    args = ap.parse_args(argv)

    print(f"roadgrade-bound-check: BOUND_DECAY {roadgrade.BOUND_DECAY} m/m, "
          f"BOUND_TOL_M {roadgrade.BOUND_TOL_M} m")
    fails = section_arithmetic()
    if args.arithmetic_only:
        print("\n" + "=" * 78)
        if fails:
            for f in fails:
                print(f)
            return 1
        print(f"{PASS}: the arithmetic. Run without --arithmetic-only for the lattice.")
        return 0

    print(f"\n   the two rounds, and this one at {args.radius / 1000:.0f} km ...")
    two = _load_key(args.before)
    three = _load_key(args.after)
    t0 = time.time()
    now = _load_key(args.now) if args.now else terraincache.load(args.radius)
    print(f"   the solve under test is ready in {time.time() - t0:.0f}s")

    h2, E, N = _grid(two)
    h3, _, _ = _grid(three)
    hn, _, _ = _grid(now)
    if h2.shape != h3.shape or h2.shape != hn.shape:
        raise SystemExit(f"{FAIL} the three lattices are different shapes: "
                         f"{h2.shape} {h3.shape} {hn.shape}")

    fails += section_places(h2, h3, hn, E, N)
    fails += section_cells(h2, h3, hn, E, N)
    fails += section_quay(args.radius, h3, hn, E, N, three, now)

    print("\n" + "=" * 78)
    if fails:
        for f in fails:
            print(f)
        print(f"{FAIL}: {len(fails)} failure(s)")
        return 1
    print(f"{PASS}: the projection is bounded by the evidence it carries; no cell")
    print("       outside the harbour band drops more than the budget; the Quay kept")
    print("       what the sign bought it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
