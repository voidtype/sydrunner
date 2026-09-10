"""The gate on `shoreline.py`: prove the shore pass on a scoped solve.

`bare-earth-check.py` is this file's older sibling and `terrain-rules-check.py`
is theirs; between them they argue the philosophy and it is not repeated here. A
pass that moves the ground ships on an assertion, and the assertion is:

    every post the pass writes is within `SHORE_REACH_M` of mapped tidal water
    plus one cell, and nothing else in the ring moves by a millimetre.

**That assertion is made on a pass-only diff and not on the shipped one**, and
the distinction is this check's whole shape. The pass runs *before*
`roadgrade.solve`, deliberately, because the largest single term in the Quay's
error is the road solve itself. So there are four lattices, not two:

  * `pre` off / on -- every later pass off, the shore pass the only difference.
    Their diff **is** the pass's write, and section 1 asserts on it exactly.
  * shipped off / on -- every pass on. Their diff is the write plus the road
    solve's shadow, and section 1 measures both populations rather than
    asserting on either.

Seven sections:

  1. **The gate.** The pass-only diff, asserted inside the band plus one cell;
     then the shipped diff, split into the direct write and the shadow.
  2. **The Quay transect.** East 140, north 1200 down to 560 -- the middle of
     Sydney Cove, over the promenade and the ferry wharves, across Alfred
     Street to the Cahill viaduct -- off, on, and what is there in life.
  3. **What the road solve gives back.** When this file was written it was the
     finding the round turned up and the reason section 2 was not a bigger
     table: `roadgrade._lipschitz` averaged a downward projection with an upward
     one, the DSM's error is only ever upward, and a tie chain handed roughly
     half of whatever this pass took off the shore back to the CBD -- median
     kept/written **0.41**. That is fixed, in `roadgrade.py`'s one-sided
     projection and RAIL-VERTICAL.md section 3e, and the section stays because
     the measurement is the one that would notice it coming back. It now reads
     **1.13**, and past one it has stopped meaning "how much survives" and
     started meaning "what a corrected shore is worth", because the correction
     now propagates inland along the grade limit instead of stopping at the
     band. `roadgrade-sign-check.py` is that operator's own gate.
  4. **The grade this puts into the lattice.** The pass has no reach feather --
     it terminates because its weight reaches zero -- and what that trades is
     gradient inside the band.
  5. **The shore, everywhere else.** Six probes that are not the Quay: three
     real rock shelves the rule must decline, two built foreshores it should
     take, one control inland.
  6. **The heroes**, built on both lattices and diffed.
  7. **Circular Quay's clearance**, from the station's own ground. The rail bake
     needs 20 km (see `bare-earth-check.py`'s header); below that this section
     prints the arithmetic and says so.

RUN IT:

    cd pipeline
    PYTHONPATH=. uv run python sydney/shoreline-check.py                 # 5.3 km
    PYTHONPATH=. uv run python sydney/shoreline-check.py --radius 20000  # + the bake

Nothing here writes a tile, touches `client/public/world`, or runs a 60 km
anything. The solves land in the ordinary `terraincache` directory, keyed on the
`shoreline` flag like every other input, so the off solve and the on solve are
two entries and neither can be mistaken for the other.
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np
import shapely

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from sydney import shoreline, terraincache
from sydney.terrain import post_spacing

PASS, FAIL = "PASS", "FAIL"

# The transect: down the middle of Sydney Cove, over the Quay promenade and the
# ferry wharves, across Alfred Street, to the Cahill Expressway viaduct. East 140
# is the line; the northings are the stations along it.
QUAY_EAST = 140.0
QUAY_NORTHS = np.arange(1200.0, 559.0, -20.0)

# What is actually there, metres AHD. Sparse on purpose: five places where the
# answer is known, not a curve fitted through a guess. Nothing inside Sydney
# Cove is listed -- the ground there is `water.conform`'s bed and the truth
# about it is a depth, not a height.
QUAY_TRUTH = {
    860: (2.5, "the Quay promenade"),
    820: (2.5, "the promenade, behind the seawall"),
    780: (4.0, "Alfred Street"),
    700: (6.0, "Alfred St / Loftus St, rising"),
    680: (6.0, "under the Cahill deck; the deck itself ~20"),
}

# Probes that are not the Quay. `expect` is the sign the rule must have there,
# and it is an assertion in section 5.
PROBES = [
    ("Mrs Macquaries Point, at the waterline", 1130.0, 1090.0, "decline"),
    ("Mrs Macquaries Point, 10 m in", 1130.0, 1060.0, "decline"),
    ("Balmain East headland", -1750.0, 1420.0, "decline"),
    ("Centennial Park (no water, no buildings)", 2600.0, -1500.0, "decline"),
    ("Dawes Point / The Rocks", -60.0, 1440.0, "take"),
    ("Kirribilli, 180 m in", 400.0, 2480.0, "take"),
]

HEROES = ("opera_house", "harbour_bridge", "luna_park", "sydney_tower")


def _stat(v: np.ndarray) -> str:
    if not v.size:
        return "none"
    return (f"n {v.size:,}  p50 {np.percentile(v, 50):6.3f}  "
            f"p95 {np.percentile(v, 95):6.3f}  max {v.max():6.3f} m")


def _posts(field) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
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


def _in_band(east, north, rec, cell) -> np.ndarray:
    shapely.prepare(rec.geom)
    return shapely.dwithin(shapely.points(east, north), rec.geom, rec.reach_m + cell)


# --- 1. The gate ---------------------------------------------------------------


def section_gate(pre_off, pre_on, off, on) -> list[str]:
    print("\n1. THE GATE")
    fails: list[str] = []
    rec = pre_on.shore[0] if pre_on.shore else None
    if rec is None:
        return [f"{FAIL} the shoreline pass left no record on the terrain"]
    cell = post_spacing()
    print(f"   band: within {rec.reach_m:.0f} m of {rec.geom.area / 1e6:.2f} km2 of mapped "
          f"tidal water; promenade {rec.promenade_ahd:.1f} m AHD")

    h0, east, north = _posts(pre_off)
    h1, _, _ = _posts(pre_on)
    d = h1 - h0
    moved = d != 0.0
    band = _in_band(east[moved], north[moved], rec, cell)
    print(f"\n   the pass's own write ({int(moved.sum()):,} of {h0.size:,} posts, "
          f"{100.0 * moved.mean():.2f}%):")
    print(f"     {_stat(np.abs(d[moved]))}")
    print(f"     bounded by the built mass {rec.stats['floor_bound']:,}, "
          f"by the pull {rec.stats['pull_bound']:,}")
    outside = int((~band).sum())
    up = int((d[moved] > 0).sum())
    if outside:
        far = shapely.distance(
            shapely.points(east[moved][~band], north[moved][~band]), rec.geom
        )
        fails.append(f"{FAIL} {outside:,} posts written outside the band + one cell, "
                     f"furthest {far.max():.0f} m")
    else:
        print(f"     {PASS} every one of them is inside the band + one cell "
              f"({rec.reach_m:.0f} + {cell:.2f} m)")
    if up:
        fails.append(f"{FAIL} {up:,} posts were raised; this pass may only lower")
    else:
        print(f"     {PASS} not one post was raised")

    h0, east, north = _posts(off)
    h1, _, _ = _posts(on)
    d = h1 - h0
    moved = d != 0.0
    band = _in_band(east[moved], north[moved], rec, cell)
    print(f"\n   the shipped diff -- every pass on, the shore pass the only change "
          f"({int(moved.sum()):,} posts, {100.0 * moved.mean():.2f}%):")
    print(f"     all of it:                 {_stat(np.abs(d[moved]))}")
    print(f"     inside the band + one cell: {_stat(np.abs(d[moved])[band])}")
    print(f"     the road solve's shadow:    {_stat(np.abs(d[moved])[~band])}")
    if (~band).any():
        far = shapely.distance(
            shapely.points(east[moved][~band], north[moved][~band]), rec.geom
        )
        big = np.abs(d[moved])[~band] > 1.0
        print(f"     the shadow reaches {far.max():.0f} m from the water; "
              f"{int(big.sum()):,} of it is over a metre "
              f"(furthest of those {far[big].max() if big.any() else 0:.0f} m)")
    return fails


# --- 2. The Quay transect ------------------------------------------------------


def section_transect(off, on) -> tuple[list[str], np.ndarray, np.ndarray]:
    print("\n2. THE QUAY TRANSECT -- east 140, Sydney Cove to the Cahill (m AHD)")
    base = on.base_elevation
    e = np.full_like(QUAY_NORTHS, QUAY_EAST)
    g_off = np.asarray(off.sample(e, QUAY_NORTHS), dtype=float) + base
    g_on = np.asarray(on.sample(e, QUAY_NORTHS), dtype=float) + base
    rec = on.shore[0] if on.shore else None
    dist = (shapely.distance(shapely.points(e, QUAY_NORTHS), rec.geom.boundary)
            if rec else np.full(len(e), np.nan))
    wet = shapely.contains_xy(rec.geom, e, QUAY_NORTHS) if rec else np.zeros(len(e), bool)

    print("      N  d(water)      off       on     move | in life")
    for i, n in enumerate(QUAY_NORTHS):
        truth = QUAY_TRUTH.get(int(n))
        note = f"{truth[0]:5.1f}  {truth[1]}" if truth else ""
        mark = "WET" if wet[i] else f"{dist[i]:6.0f}"
        print(f"  {n:5.0f}  {mark:>8}  {g_off[i]:7.2f}  {g_on[i]:7.2f}  "
              f"{g_on[i] - g_off[i]:+7.2f} | {note}")

    fails: list[str] = []
    print("\n   against what is there:")
    for n, (truth, label) in sorted(QUAY_TRUTH.items(), reverse=True):
        i = int(np.argmin(np.abs(QUAY_NORTHS - n)))
        before, after = g_off[i] - truth, g_on[i] - truth
        better = abs(after) < abs(before)
        print(f"     N {n}: error {before:+6.2f} -> {after:+6.2f} m against {truth:4.1f} "
              f"({label}) -- {'closer' if better else 'NOT closer'}")
        if not better:
            fails.append(f"{FAIL} the transect at N {n} did not get closer to {truth:.1f} m AHD")
    return fails, g_off, g_on


# --- 3. What the road solve gives back -----------------------------------------


def section_giveback(pre_off, pre_on, on, g_off, g_on) -> list[str]:
    print("\n3. WHAT THE ROAD SOLVE GIVES BACK")
    print("   `roadgrade._lipschitz` used to average a downward projection with an")
    print("   upward one -- 'cutting a spike down and filling the valleys either side")
    print("   of it up are both legal answers and the truth is between them'. The DSM's")
    print("   error is only ever upward (`roadgrade.OPENING_M`'s own note says so), so a")
    print("   tie chain at CROSS_GRADE handed roughly half of whatever this pass took")
    print("   off the shore straight back to the CBD: median kept/written 0.41.")
    print("   It is one-sided now -- see that module's `--- The sign of the error ---`")
    print("   block and RAIL-VERTICAL 3e -- and this is where it would show up coming")
    print("   back. Past 1.00 the ratio has stopped meaning 'how much survives'.")
    b = pre_on.base_elevation
    e = np.full_like(QUAY_NORTHS, QUAY_EAST)
    p_off = np.asarray(pre_off.sample(e, QUAY_NORTHS), dtype=float) + b
    p_on = np.asarray(pre_on.sample(e, QUAY_NORTHS), dtype=float) + b
    # Only dry land, and only where the pass wrote something worth a ratio. A
    # post inside Sydney Cove is cut to `water.conform`'s bed either way, so its
    # write is subsumed rather than given back, and a post the pass barely
    # touched has a ratio made of the road solve's shadow and nothing else.
    rec = on.shore[0] if on.shore else None
    wet = (shapely.contains_xy(rec.geom, e, QUAY_NORTHS)
           if rec else np.zeros(len(e), dtype=bool))
    print("\n      N   the pass wrote   the build kept   kept / wrote")
    keeps = []
    for i, n in enumerate(QUAY_NORTHS):
        wrote = p_on[i] - p_off[i]
        kept = g_on[i] - g_off[i]
        if wet[i] or wrote > -1.0:
            continue
        keeps.append(kept / wrote)
        print(f"  {n:5.0f}  {wrote:+14.2f}  {kept:+15.2f}   {kept / wrote:12.2f}")
    if keeps:
        print(f"\n   median kept / written, on dry land the pass wrote over a metre to: "
              f"{np.median(keeps):.2f}")
        print("   What is left is in the middle of the CBD, where this rule does not reach,")
        print("   nothing has corrected the ground, and the DSM still reads 40 to 55 m. One")
        print("   follow-up now, in `terrain.py`'s own words and still standing: the")
        print("   city-wide deconvolution. The projection's half is done.")
    return []


# --- 4. The grade -------------------------------------------------------------


def section_grade(off, on) -> list[str]:
    print("\n4. THE GRADE THIS PUTS INTO THE LATTICE")
    cell = post_spacing()
    rec = on.shore[0] if on.shore else None
    if rec is None:
        return [f"{FAIL} no shore record"]
    lat = on._lat
    q_n, p_n = lat.heights.shape
    east = np.repeat(((np.arange(p_n) + lat.p0) * lat.spacing)[None, :-1], q_n, axis=0).ravel()
    north = np.repeat(((np.arange(q_n) + lat.q0) * lat.spacing)[:, None], p_n - 1, axis=1).ravel()
    band = _in_band(east, north, rec, cell)

    grades = {}
    for label, field in (("off", off), ("on", on)):
        g = np.abs(np.diff(field._lat.heights.astype(np.float64), axis=1)).ravel()[band] / cell
        grades[label] = g
        print(f"   {label:3s}  east-west grade in the band:  p50 {100 * np.percentile(g, 50):5.2f}%  "
              f"p95 {100 * np.percentile(g, 95):5.2f}%  max {100 * g.max():6.2f}%")
    delta = grades["on"] - grades["off"]
    worse = delta[delta > 0]
    if worse.size:
        print(f"   extra grade where it is worse: {worse.size:,} cells, "
              f"p50 {100 * np.percentile(worse, 50):5.2f}%  "
              f"p95 {100 * np.percentile(worse, 95):5.2f}%  max {100 * worse.max():6.2f}%")
    else:
        print("   nothing in the band got steeper")
    return []


# --- 5. Everywhere else --------------------------------------------------------


def section_probes(pre_off, pre_on) -> list[str]:
    print("\n5. THE SHORE, EVERYWHERE ELSE -- the pass's own write, before the roads")
    base = pre_on.base_elevation
    rec = pre_on.shore[0] if pre_on.shore else None
    fails: list[str] = []
    print("   probe                                      d(water)     off      on     move  expect")
    for label, e, n, expect in PROBES:
        a = pre_off.sample(e, n) + base
        b = pre_on.sample(e, n) + base
        d = shapely.distance(shapely.Point(e, n), rec.geom) if rec else float("nan")
        print(f"   {label:42s} {d:8.1f} {a:7.2f} {b:7.2f} {b - a:+7.2f}  {expect}")
        if expect == "decline" and (a - b) > 0.50:
            fails.append(f"{FAIL} {label}: the rule took {a - b:.2f} m off ground with "
                         "no building on it")
        if expect == "take" and (a - b) < 0.10:
            fails.append(f"{FAIL} {label}: the rule declined a built foreshore")
    if not fails:
        print(f"   {PASS} every probe is on the side the built-mass floor puts it")
    return fails


# --- 6. The heroes -------------------------------------------------------------


def section_heroes(radius_m: float, off, on) -> list[str]:
    print("\n6. THE HEROES")
    from sydney import landmarks

    anchors = landmarks.read_anchors(min(radius_m, 4000.0))
    try:
        before = {m.name: m.audit for m in landmarks.build_all(off, anchors)}
        after = {m.name: m.audit for m in landmarks.build_all(on, anchors)}
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
    # ceremonial stairs, neither of which appears in the audit block.
    ring = np.asarray(
        shapely.Polygon(anchors["opera"].ring).buffer(0).simplify(1.2).exterior.coords
    )
    for label, field in (("off", off), ("on", on)):
        sea = -field.base_elevation
        g = float(min(field.sample(ring[:, 0], ring[:, 1])))
        riser = (sea + landmarks.OPERA_PODIUM_TOP_AHD - (g + 1.0)) / landmarks.OPERA_STAIR_STEPS
        print(f"   opera podium, {label:3s}: founded on min(ground over the plan) "
              f"{g + field.base_elevation:6.2f} m AHD; top {landmarks.OPERA_PODIUM_TOP_AHD:.1f} AHD "
              f"(stated, cannot move); stair riser {riser:+.3f} m over "
              f"{landmarks.OPERA_STAIR_STEPS} treads")

    # The bridge's four founded points, which are not in its audit block either:
    # the two arch-pin abutments (`min(ground, bearing - 6)`) and the two ramp-end
    # abutments (`ground(s_end + 6) - 3`). Both are `terrain.sample` at a stated
    # station along the bridge's own axis, so this reads them the same way
    # `build_bridge` does rather than re-deriving the frame.
    centre, along, _across = landmarks._bridge_frame(anchors)
    half_span = landmarks.BRIDGE_ARCH_SPAN * 0.5
    half_len = landmarks.BRIDGE_TOTAL_LENGTH * 0.5
    for label, field in (("off", off), ("on", on)):
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
        print(f"   bridge abutments, {label:3s}: " + "  ".join(row) + "  m AHD")
    return []


# --- 7. Circular Quay's clearance ----------------------------------------------


def section_clearance(radius_m: float, off, on) -> list[str]:
    print("\n7. CIRCULAR QUAY'S CLEARANCE")
    from sydney import pads, rail

    zones = [z for z in pads.bridge_station_zones(radius_m) if "Circular" in z.name]
    if not zones:
        print("   Circular Quay is not a bridge-tagged station in this extract.")
        return []
    z = zones[0]
    e, n = float(z.note["east"]), float(z.note["north"])
    base = on.base_elevation
    g_off, g_on = off.sample(e, n) + base, on.sample(e, n) + base
    drop = g_off - g_on
    print(f"   the station node is E {e:.1f} N {n:.1f}")
    print(f"   ground there: {g_off:7.2f} -> {g_on:7.2f} m AHD  ({-drop:+.2f} m)")
    print("   RAIL-VERTICAL 3c records the shipped 20 km bake at groundY -33.84 (world) "
          f"= {-33.84 + base:.2f} AHD, clearance -6.74 m, conflict recorded.")
    print("   `rail.raw_heights` gives a bridge node `terrain.sample(...) + BRIDGE_RISE`,")
    print(f"   BRIDGE_RISE is {rail.BRIDGE_RISE:.1f} m, so the deck follows the ground down and")
    print("   only what the 3.3% grade projection pulls back from approaches that did not")
    print("   move survives. Chatswood measured that exchange rate at 0.38 (3b).")
    lo, hi = drop * 0.38, drop
    print(f"   so {drop:.2f} m of ground here is worth between {lo:+.2f} and {hi:+.2f} m of")
    print(f"   clearance: -6.74 -> {-6.74 + lo:+.2f} .. {-6.74 + hi:+.2f} m.")
    if -6.74 + hi < 0.0:
        print("   Neither end clears the deck. The conflict RAIL-VERTICAL 3c says must not be")
        print("   edited away stays recorded, and it stays right: the ground is still wrong,")
        print("   by less. Section 3 says where the rest of it went.")

    if radius_m < 20000.0:
        print("\n   The rail bake needs 20 km (see `bare-earth-check.py`'s header);")
        print("   re-run with --radius 20000 for the measured clearance rather than this band.")
        return []
    for label, field in (("off", off), ("on", on)):
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--radius", type=float, default=5300.0)
    args = ap.parse_args(argv)
    r = args.radius

    print(f"shoreline-check: {r / 1000:.1f} km ring, "
          f"reach {shoreline.SHORE_REACH_M:.0f} m, promenade {shoreline.PROMENADE_AHD:.1f} m AHD")
    t0 = time.time()
    bare = {"conform_roads": False, "conform_water": False, "conform_pads": False}
    print("\n  the pass-only pair (every later pass off) ...")
    pre_off = terraincache.load(r, shoreline=False, **bare)
    pre_on = terraincache.load(r, shoreline=True, **bare)
    print("  the shipped pair (every pass on) ...")
    off = terraincache.load(r, shoreline=False)
    on = terraincache.load(r, shoreline=True)
    print(f"  four lattices ready in {time.time() - t0:.0f}s")

    fails: list[str] = []
    fails += section_gate(pre_off, pre_on, off, on)
    t_fails, g_off, g_on = section_transect(off, on)
    fails += t_fails
    fails += section_giveback(pre_off, pre_on, on, g_off, g_on)
    fails += section_grade(off, on)
    fails += section_probes(pre_off, pre_on)
    fails += section_heroes(r, off, on)
    fails += section_clearance(r, off, on)

    print("\n" + "=" * 78)
    if fails:
        for f in fails:
            print(f)
        print(f"{FAIL}: {len(fails)} failure(s)")
        return 1
    print(f"{PASS}: every post the pass writes is inside its band and none was raised;")
    print("       the Quay is closer to the water; no unbuilt ground moved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
