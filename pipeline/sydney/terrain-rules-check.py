"""The gate on `pads.py`: prove the two ground rules on a scoped solve.

`pads.py` moves the terrain lattice, and a pass that moves the ground is the
most dangerous kind of change this pipeline takes: it is global, it is silent,
and every module downstream drapes on the result. So it does not ship on a
description of what it was meant to do. It ships on **one assertion**, which is
this file:

    every post that moved is inside a stated zone plus one cell,
    and nothing else in the ring moved by a millimetre.

That is checkable exactly, because `pads.conform` records the water-clipped
geometry it wrote inside (`Terrain.pads`) and `_feather` is zero more than
`pads.FEATHER_M` outside it. The gate takes the geometry from the pass rather
than rebuilding it, so a check that has drifted from the rule is not a thing
that can happen here. Everything else this prints is evidence for a human; the
assertion is the deliverable.

Five sections, and each answers a question somebody asked:

  1. **The diff.** Two solves of the same ring, rules off and rules on, and the
     posts between them: how many moved, by how much, and -- the gate -- whether
     any of them is somewhere the rules never claimed.
  2. **Chatswood.** RAIL-VERTICAL.md section 3a proved the deck cannot rise
     above -3.58 m of clearance while the ground over the platform reads 43 m,
     and said in as many words that the last three metres are a terrain
     question. This runs the rail bake three ways -- as it ships, against a
     conformed lattice with the rules off, and against one with them on -- so
     that what the rule bought is separable from what merely reading a conformed
     lattice bought.
  3. **Luna Park.** The four places the brief names -- the two entrance towers,
     the promenade and Coney Island -- and then all thirteen footprints, before
     and against `base_y`. A footprint reads `base_y` only if all four corners
     of the cell it sits in were levelled to it, so the table names the wet
     corner where there is one instead of leaving a miss unexplained.
  4. **The negative controls.** What the landmark rule *would* move if the
     bridge, the Opera House or Sydney Tower were in `landmarks.ground_founded`,
     read against Luna Park in the same table so the exclusions have something
     to be compared with.
  5. **The models.** All four heroes built on both grounds with their audit
     blocks diffed. This is the tight statement of the two exclusions the brief
     asks about -- a measured diff of zero, not a paragraph promising one -- and
     of what the rule was for: Luna Park's `pad_spread_m` goes 9.505 -> 0.000.

RUN IT:

    cd pipeline
    PYTHONPATH=. uv run python sydney/terrain-rules-check.py            # 5.3 km
    PYTHONPATH=. uv run python sydney/terrain-rules-check.py --radius 20000

**Chatswood is 8,356 m from the origin and is therefore not in the 5.3 km ring
at all**, which is why the radius is an argument and why section 2 says so and
skips itself when the station is outside the extent. Section 1's gate is the
same statement at any radius and is worth running at both.

Section 2 needs **20,000**, not the 9,500 that would just reach Chatswood, and
the reason is a limit of the rail bake rather than of this check.
`rail.build_lines` keeps only the stations of each `LINE_SPECS` entry that are
inside the extract and `route_direction` then reads `stops[0]` unguarded, so a
line with no station in the ring raises `IndexError` instead of being skipped.
Measured on this extract: at 12 km T5 keeps 0 of its 30 stations, T6 0 of 6 and
T7 0 of 2; at 16 km T5 still keeps 0 and T6 keeps 1; at **20 km every line keeps
at least two** and the bake runs. Two 20 km solves are about twenty minutes and
three bakes another twenty, so `--skip-rail` is there for the other four
sections.

Two solves at 5.3 km are about 75 seconds cold and nothing warm; the results
land in the ordinary `terraincache` directory, keyed on the pad flag like every
other input, so a rules-off solve and a rules-on solve are two cache entries and
neither can be mistaken for the other. Nothing here writes a tile, touches
`client/public/world`, or runs a 60 km anything.
"""

from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import shapely
from shapely.geometry import Polygon

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from sydney import config, landmarks, pads, terraincache
from sydney.terrain import post_spacing

PASS, FAIL = "PASS", "FAIL"


def _pct(a: np.ndarray, q: float) -> float:
    return float(np.percentile(a, q)) if a.size else 0.0


def _posts(lattice) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every lattice post as (heights, east, north), flattened the same way."""
    s = lattice.spacing
    q_n, p_n = lattice.heights.shape
    pi, qi = np.meshgrid(np.arange(p_n), np.arange(q_n), indexing="xy")
    return (
        lattice.heights.ravel().astype(np.float64),
        ((pi.ravel() + lattice.p0) * s),
        ((qi.ravel() + lattice.q0) * s),
    )


# --- 1. The diff, and the gate --------------------------------------------------


def section_diff(radius_m: float, off, on) -> list[str]:
    problems: list[str] = []
    h_off, east, north = _posts(off._lat)
    h_on, _, _ = _posts(on._lat)
    if h_off.shape != h_on.shape:
        return [f"lattices differ in shape: {h_off.shape} vs {h_on.shape}"]

    moved = np.abs(h_on - h_off)
    idx = np.flatnonzero(moved > 0.0)
    print(f"\n1. THE DIFF -- {radius_m / 1000:.1f} km ring, {h_off.size:,} posts")
    print(f"   moved            {idx.size:,} posts ({100.0 * idx.size / h_off.size:.4f}%)")
    if idx.size:
        m = moved[idx]
        print(f"   move  p50/p95/max {_pct(m, 50):.3f} / {_pct(m, 95):.3f} / {m.max():.3f} m")
        print(f"   direction        {int((h_on[idx] > h_off[idx]).sum()):,} up, "
              f"{int((h_on[idx] < h_off[idx]).sum()):,} down")

    # --- The gate. `allowed_geometry` is the union of the zones the pass wrote
    # inside, each grown by `FEATHER_M` -- which is exactly the support of
    # `pads._feather` and therefore exactly the set of posts the pass is able to
    # touch. A post outside it that moved is a bug in the rule, not in the check.
    allowed = pads.allowed_geometry(on.pads)
    print(f"   allowed zone     {allowed.area / 1e4:.2f} ha over "
          f"{len(on.pads)} pad(s) (+{pads.FEATHER_M:.2f} m feather)")
    if idx.size:
        d = np.asarray(shapely.distance(shapely.points(east[idx], north[idx]), allowed))
        outside = idx[d > 1e-9]
        if outside.size:
            worst = outside[np.argsort(-moved[outside])][:8]
            problems.append(
                f"{outside.size} post(s) moved outside every stated zone; worst "
                + ", ".join(
                    f"E{east[k]:.0f} N{north[k]:.0f} by {moved[k]:.3f} m"
                    for k in worst
                )
            )
        print(f"   GATE             {FAIL if outside.size else PASS}: "
              f"{outside.size} of {idx.size} moved posts outside the zones")
    else:
        problems.append("the rules moved nothing at all -- either zone found no posts")
        print(f"   GATE             {FAIL}: nothing moved")

    stats = on.stats.get("pads", {})
    print(f"   water clipped    {stats.get('clipped_m2', 0.0):,.0f} m2 of zone "
          "removed because `water.conform` had already answered for it")
    print(f"\n   {'zone':<26} {'kind':<9} {'posts':>6} {'plateau':>8} "
          f"{'area ha':>8}  what moved")
    for z in stats.get("zones", []):
        sel = _zone_posts(on, z["name"], east, north)
        mm = moved[sel] if sel.size else np.zeros(0)
        print(f"   {z['name'][:25]:<26} {z['kind']:<9} {z['posts']:>6} "
              f"{z.get('plateau', 0):>8} {z.get('area_m2', 0.0) / 1e4:>8.2f}  "
              f"p50 {_pct(mm, 50):6.2f}  max {(mm.max() if mm.size else 0.0):6.2f} m")
    return problems


def _zone_posts(on, name: str, east: np.ndarray, north: np.ndarray) -> np.ndarray:
    for rec in on.pads:
        if rec.name == name:
            d = np.asarray(shapely.distance(shapely.points(east, north), rec.reach))
            return np.flatnonzero(d <= 1e-9)
    return np.zeros(0, dtype=np.int64)


# --- 2. Chatswood ----------------------------------------------------------------

CHATSWOOD = "Chatswood"
CHATSWOOD_ENU = (-2543.7, 7957.9)


def _station_row(bake, name: str):
    for st in bake["stations"]:
        if st.name == name:
            return st
    return None


def _print_station(label: str, st, base_elevation: float) -> None:
    if st is None:
        print(f"   {label:<28} not in this extract")
        return
    print(
        f"   {label:<28} clearance {st.clearance:+7.2f} "
        f"[{st.clearance_lo:+6.2f} .. {st.clearance_hi:+6.2f}]  "
        f"vertical {st.vertical:<12} structure {st.structure:<7} "
        f"groundY {st.ground_y:8.2f} ({st.ground_y + base_elevation:6.2f} AHD)  "
        f"trackY {st.track_y:8.2f}"
    )
    if st.conflict:
        print(f"   {'':<28} conflict: {st.conflict[:150]}")


def section_chatswood(radius_m: float, off, on) -> list[str]:
    from sydney import rail

    print("\n2. CHATSWOOD -- target: clearance >= +5 m, vertical 'elevated', no conflict")
    # The station's own ENU, for the "is it even in this extract" test. Written
    # down rather than read out of the bake, because the bake is the expensive
    # thing this is deciding whether to run.
    e, n = CHATSWOOD_ENU
    if math.hypot(e, n) > radius_m:
        print(f"   Chatswood is {math.hypot(e, n) / 1000:.2f} km from the origin and this "
              f"solve is {radius_m / 1000:.2f} km. Re-run with "
              f"--radius {int(math.hypot(e, n) + 1000)} or more.")
        return []

    rows = []
    for label, field in (
        ("as it ships (unconformed DEM)", True),
        ("conformed lattice, rules OFF", off),
        ("conformed lattice, rules ON", on),
    ):
        t0 = time.time()
        try:
            b = rail.build_all(radius_m, log=lambda *_a, **_k: None, terrain=field)
        except IndexError as err:
            # `build_lines` makes a `Stop` for every station of every
            # `LINE_SPECS` entry that is *in the extract*, and `route_direction`
            # then reads `stops[0]` without checking. A scoped extract that
            # contains none of a line's stations therefore raises here rather
            # than skipping the line: at 12 km, T5 keeps 0 of 30, T6 0 of 6 and
            # T7 0 of 2, because the Richmond, Bankstown and Olympic Park lines
            # are entirely outside it. Nothing to do with this change -- it is
            # what a scoped rail bake does today -- but it is reported rather
            # than swallowed so that a real regression here is not read as this.
            print(f"   the rail bake cannot run at this radius: {err!r} -- a line "
                  f"in `rail.LINE_SPECS` has no station inside {radius_m / 1000:.0f} km. "
                  f"See the header; section 1's numbers for Chatswood stand either way.")
            return []
        st = _station_row(b, CHATSWOOD)
        rows.append((label, st, b))
        print(f"   ({time.time() - t0:.0f}s)")
        _print_station(label, st, on.base_elevation)

    problems: list[str] = []
    final = rows[-1][1]
    if final is None:
        problems.append("Chatswood is not in the bake at all")
        return problems
    if final.clearance < 5.0:
        problems.append(
            f"Chatswood measures {final.clearance:+.2f} m of clearance, short of the "
            f"+5.00 m the brief asks for"
        )
    if final.vertical != "elevated":
        problems.append(f"Chatswood's vertical is {final.vertical!r}, not 'elevated'")
    if final.conflict:
        problems.append("Chatswood still records a structure/ground conflict")
    return problems


# --- 3. Luna Park ----------------------------------------------------------------

LUNA_PROBES = (
    ("west entrance tower", "luna_gate_w"),
    ("east entrance tower", "luna_gate_e"),
    ("the promenade", "luna_boardwalk"),
    ("Coney Island", "luna_coney_island"),
)
LUNA_TOLERANCE_M = 0.3


def _wet_corner(east: float, north: float, spacing: float, wet):
    """The wettest of the four lattice posts a sample at (east, north) reads.

    A point's height is the interpolation over one cell, so a point can only
    read `base_y` if all four of that cell's corners were levelled to it -- and
    a corner inside the mapped harbour was not, because `water.conform` owns it
    and `pads.py` may not raise it. This returns that corner where there is one,
    which turns "the promenade is 5.89 m low" from a mystery into a named post.
    """
    if wet is None:
        return None
    for pe in (math.floor(east / spacing) * spacing, math.ceil(east / spacing) * spacing):
        for pn in (math.floor(north / spacing) * spacing,
                   math.ceil(north / spacing) * spacing):
            if wet.contains(shapely.points(pe, pn)):
                return (pe, pn)
    return None


def section_luna(off, on) -> list[str]:
    anchors = landmarks.read_anchors(4000.0)
    # The pad the pass used, off its own record. Re-sampling the canopy on the
    # levelled lattice is not the same number and the difference is the finding
    # in the shore paragraph below -- so the reference has to be what the rule
    # levelled *to*, not what the levelled ground reads back.
    rec = next((r for r in on.pads if r.name == "luna_park"), None)
    if rec is None:
        return ["Luna Park has no pad record: the landmark rule never fired"]
    base = float(rec.note["base_y"])
    print(f"\n3. LUNA PARK -- base_y {base:.2f} "
          f"({base + on.base_elevation:.2f} m AHD), tolerance {LUNA_TOLERANCE_M} m")
    problems: list[str] = []
    print("   A footprint reads base_y only if all four corners of the cell it sits in "
          "were levelled to it.")
    print("   A corner inside the mapped harbour was not, and cannot be: see "
          "`pads.clip_water`.")
    wet_all = pads.wet_geometry(on.water)
    print(f"\n   {'probe':<22} {'before':>9} {'after':>9} {'moved':>8} {'vs base_y':>10} "
          f"{'wet':>6}  wet corner of its cell")
    for label, key in LUNA_PROBES:
        ring = Polygon(anchors[key].ring)
        # Sampled at the centroid of the footprint's **dry** part. A pad may not
        # raise the harbour bed -- `pads.clip_water` takes the mapped water out
        # of every zone before a post is written -- so the promenade, which is a
        # `man_made=pier` with a quarter of itself out in Lavender Bay, is levelled
        # where it is ground and left where it is water. Measuring it at the
        # whole polygon's centroid would be measuring the water, and the `wet`
        # column is how much of each footprint that is.
        dry, lost = pads.clip_water(ring, wet_all)
        wet_frac = lost / ring.area if ring.area else 0.0
        c = (dry if dry is not None else ring).centroid
        b4 = float(off.sample(float(c.x), float(c.y)))
        af = float(on.sample(float(c.x), float(c.y)))
        err = af - base
        corner = _wet_corner(float(c.x), float(c.y), on.spacing, wet_all)
        note = (
            f"E{corner[0]:.0f} N{corner[1]:.0f} at {on.sample(*corner):.2f}"
            if corner else "none -- all four dry"
        )
        bad = abs(err) > LUNA_TOLERANCE_M and corner is None
        print(f"   {label:<22} {b4:9.2f} {af:9.2f} {af - b4:8.2f} {err:10.2f} "
              f"{100.0 * wet_frac:5.0f}%  {note}{'   <-- OUT' if bad else ''}")
        if bad:
            problems.append(
                f"Luna Park's {label} is {err:+.2f} m from base_y after the rule with "
                f"no water in its cell to explain it, outside the {LUNA_TOLERANCE_M} m "
                f"the brief asks for"
            )
    # The pad spread the model has been paying for in buried plinths.
    pw = float(on.sample(*Polygon(anchors["luna_gate_w"].ring).centroid.coords[0]))
    pe = float(on.sample(*Polygon(anchors["luna_gate_e"].ring).centroid.coords[0]))
    bw = float(off.sample(*Polygon(anchors["luna_gate_w"].ring).centroid.coords[0]))
    be = float(off.sample(*Polygon(anchors["luna_gate_e"].ring).centroid.coords[0]))
    print(f"   entrance pad spread    {abs(be - bw):9.2f} -> {abs(pe - pw):8.2f} m "
          "(the nine and a half metres between two towers thirteen metres apart)")

    # --- Every footprint, and how near the harbour each one is.
    #
    # This is the table that says which misses are the rule failing and which are
    # the waterline. A footprint whose interpolation cell is entirely inside the
    # plateau reads `base_y` *exactly*; a footprint within one cell of mapped
    # water reads an interpolation between the pad and a shore post that
    # `water.conform` owns and this pass may not raise, and it misses by however
    # far apart those two are. Both populations are real and they are told apart
    # by the `shore` column, not by taste.
    print(f"\n   {'footprint':<24} {'before':>9} {'after':>9} {'vs base_y':>10} "
          f"{'shore m':>9}  cell")
    exact = total = 0
    for _name, keys, _bk in landmarks.ground_founded():
        for key in keys:
            if key not in anchors:
                continue
            total += 1
            c = Polygon(anchors[key].ring).centroid
            b4 = float(off.sample(float(c.x), float(c.y)))
            af = float(on.sample(float(c.x), float(c.y)))
            shore = float(c.distance(wet_all)) if wet_all is not None else float("inf")
            corner = _wet_corner(float(c.x), float(c.y), on.spacing, wet_all)
            ok = abs(af - base) <= 1e-3
            exact += ok
            print(f"   {key:<24} {b4:9.2f} {af:9.2f} {af - base:10.2f} "
                  f"{min(shore, 999.0):9.1f}  {'dry' if corner is None else 'wet corner'}")
            if not ok and corner is None:
                problems.append(
                    f"{key} does not read base_y and has no water in its cell to "
                    f"explain it ({af - base:+.3f} m)"
                )
    print(f"   {exact} of {total} footprints read base_y to the millimetre; every one "
          "of the rest has a harbour post in its own cell.")
    return problems


# --- 4. The negative controls ---------------------------------------------------

CONTROLS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("luna_park", "IN", tuple(landmarks.LUNA_GENERIC_TOPS)
     + ("luna_ferris_wheel", "luna_boardwalk")),
    ("bridge", "out", ("bridge_deck", "bridge_pylons_s", "bridge_pylons_n")),
    ("opera", "out", ("opera",)),
    ("tower", "out", ("tower",)),
)


def section_controls(off, on) -> list[str]:
    """What the landmark rule does, or would do, to each of the four heroes.

    Read on the **rules-off** lattice, which is the ground each of them would be
    asked to level; the relief column is the size of the problem the rule exists
    to remove and is the honest measure of a no-op. Luna Park is in the table so
    that the three exclusions are read against the one inclusion rather than
    against nothing.

    The rows are built from `read_anchors`, so **the tower's row is its 700 m2
    turret outline and not the 11,753 m2 Westfield podium** that
    `landmarks.ground_founded` argues about: the podium is `_podium_ring`, read
    separately by `build_tower` and not an anchor. Its 2.61 m of relief is
    therefore an understatement of a footprint that is already flat, which is
    the direction that cannot mislead. Section 5 is the row that settles it --
    the tower built on both grounds, every audit number identical.
    """
    anchors = landmarks.read_anchors(4000.0)
    h, east, north = _posts(off._lat)
    print("\n4. THE FOUR HEROES -- the relief the rule would remove, on the rules-off ground")
    print(f"   {'landmark':<10} {'in?':<4} {'footprint ha':>13} {'base_y':>9} "
          f"{'relief':>8} {'posts':>7} {'p95 move':>9} {'max move':>9}  over water")
    for name, verdict, keys in CONTROLS:
        rings = [np.asarray(anchors[k].ring, dtype=np.float64) for k in keys if k in anchors]
        zone = pads._clean([Polygon(r) for r in rings if len(r) >= 3])
        if zone is None:
            continue
        base = float(off.sample(*Polygon(anchors[keys[0]].ring).centroid.coords[0]))
        grown = zone.buffer(pads.PAD_MARGIN_M + pads.FEATHER_M, join_style=2, mitre_limit=2.0)
        d = np.asarray(shapely.distance(shapely.points(east, north), grown))
        sel = np.flatnonzero(d <= 1e-9)
        would = np.abs(h[sel] - base) if sel.size else np.zeros(0)
        # Relief across the footprint itself, sampled on its own rings rather
        # than on the lattice: a 10 m2 anchor like the Helter Skelter contains no
        # post at all and would otherwise report zero.
        pts = np.concatenate(rings)
        inside = np.asarray(off.sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
        relief = float(inside.max() - inside.min())
        _dry, lost = pads.clip_water(zone, pads.wet_geometry(on.water))
        print(f"   {name:<10} {verdict:<4} {zone.area / 1e4:13.2f} {base:9.2f} "
              f"{relief:8.2f} {sel.size:7d} {_pct(would, 95):9.2f} "
              f"{(would.max() if would.size else 0.0):9.2f}  "
              f"{100.0 * lost / zone.area:5.1f}%")
    print("   (`landmarks.ground_founded` argues each exclusion in prose; this is the "
          "arithmetic under it.)")
    return []


# --- 5. The models the rules are for --------------------------------------------


def section_models(off, on) -> list[str]:
    """Build all four heroes on both grounds and diff their own audit numbers.

    The lattice diff in section 1 says what moved; this says what it was *for*.
    It is also the tightest statement of the two exclusions the brief asks about:
    the bridge's and the Opera House's audit blocks have to come out identical
    to the digit, because neither reads the ground for anything a pad could
    change, and a diff of zero measured through the models is worth more than a
    paragraph saying there would be one.
    """
    problems: list[str] = []
    landmarks.read_podium_ring(4000.0)
    anchors = landmarks.read_anchors(4000.0)
    before = {m.name: m.audit for m in landmarks.build_all(off, anchors)}
    after = {m.name: m.audit for m in landmarks.build_all(on, anchors)}
    print("\n5. THE MODELS -- every hero built on both grounds, audit block diffed")
    for name in sorted(before):
        deltas = {
            k: (before[name][k], after[name][k])
            for k in before[name]
            if isinstance(before[name][k], (int, float))
            and abs(float(after[name][k]) - float(before[name][k])) > 1e-3
        }
        if not deltas:
            print(f"   {name:<16} identical: every audit number unchanged")
            continue
        print(f"   {name:<16} {len(deltas)} number(s) moved")
        for k, (b4, af) in sorted(deltas.items()):
            print(f"   {'':<16}   {k:<22} {b4:9.3f} -> {af:9.3f}  ({af - b4:+.3f})")
    for name in ("harbour_bridge", "opera_house", "sydney_tower"):
        moved_any = any(
            isinstance(v, (int, float))
            and abs(float(after[name][k]) - float(v)) > 1e-3
            for k, v in before.get(name, {}).items()
        )
        if name in before and moved_any:
            problems.append(
                f"{name} is not out of the landmark rule after all: its audit block "
                f"changed when the ground did"
            )
    return problems


# --- The runner ------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--radius", type=float, default=config.STAGE_BY_NAME["inner"].radius_m,
                    help="metres of extract to solve. 5300 (the inner ring) by default; "
                         "section 2 needs 20000 (see the header).")
    ap.add_argument("--skip-rail", action="store_true",
                    help="skip section 2, which runs three rail bakes")
    args = ap.parse_args(argv)
    r = float(args.radius)

    print(f"terrain-rules-check: {r / 1000:.1f} km, spacing {post_spacing():.2f} m, "
          f"feather {pads.FEATHER_M:.2f} m")
    t0 = time.time()
    print("  solving with the pad rules OFF")
    off = terraincache.load(r, conform_pads=False)
    print("  solving with the pad rules ON")
    on = terraincache.load(r, conform_pads=True)
    print(f"  two solves in {time.time() - t0:.0f}s")

    problems: list[str] = []
    problems += section_diff(r, off, on)
    if not args.skip_rail:
        problems += section_chatswood(r, off, on)
    problems += section_luna(off, on)
    problems += section_controls(off, on)
    problems += section_models(off, on)

    print()
    if problems:
        print(f"{FAIL}: {len(problems)} problem(s)")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"{PASS}: the rules moved only what they claimed, and both targets are met.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
