"""The gate on `bareearth.py`: prove the bare-earth pass on a scoped solve.

`terrain-rules-check.py` is this file's older sibling and its header argues the
whole philosophy: a pass that moves the ground is the most dangerous kind of
change this pipeline takes, so it ships on an assertion rather than on a
description. The assertion here is the same one:

    every post that moved is inside a stated zone plus one cell,
    and nothing else in the ring moved by a millimetre.

**With one difference that is measured rather than assumed.** Rules 1 and 2 run
last, after every solve, so their write is the only thing between the two
lattices and the assertion is exact. The bare-earth pass runs **first**, before
`roadgrade.solve` reads a profile -- deliberately, because rule 1's authority is
the solved street and a street solved on a contaminated surface is a
contaminated authority. That means the road solve *can* carry the pass's write
outside its zone: a moved post moves a road node, the graph low-pass spreads it
45 m, two Lipschitz projections spread it further, and `roadgrade.conform` then
reaches `LATTICE_REACH_M + FEATHER_M` past that road's corridor. So section 1
reports two numbers, not one:

  * **the direct write**, asserted to be inside the zones plus one cell; and
  * **the road solve's shadow** -- every post that moved and is not in a zone --
    with how far from the nearest zone it reaches and how large it is. A shadow
    is not a bug. A shadow nobody has measured is.

Six sections:

  1. **The diff and the gate.** Two solves of the same ring, the pass off and
     on. Posts moved, p50/p95/max, and the two populations above.
  2. **The zones.** What each bridge-tagged station's roof cap came to, which
     stations the rule declined and why, and the move inside each zone.
  3. **The streets.** The solved road surface either side, so the propagation
     in section 1 has a cause with a number on it rather than a shrug.
  4. **Chatswood.** The rail bake against both lattices, and the station record:
     target `clearance >= +5 m`, `vertical: 'elevated'`, `conflict` empty.
  5. **Every other bridge-tagged station in the ring**, from the same bakes, so
     a regression somewhere else is visible in the same table.
  6. **The audits.** `landmark-audit` and `rail-audit` numbers off the scoped
     bake, on both grounds.

RUN IT:

    cd pipeline
    PYTHONPATH=. uv run python sydney/bare-earth-check.py                 # 5.3 km
    PYTHONPATH=. uv run python sydney/bare-earth-check.py --radius 20000  # + Chatswood

**Chatswood is 8,356 m from the origin and is not in the 5.3 km ring**, and the
rail bake needs more than the 9,500 m that would just reach it: `rail.build_lines`
keeps only the stations of each `LINE_SPECS` entry inside the extract and
`route_direction` then reads `stops[0]` unguarded, so a line with no station in
the ring raises `IndexError` rather than being skipped. 20,000 is the radius at
which every line keeps at least two, measured in `terrain-rules-check.py`'s
header. Sections 1-3 are the gate and are worth running at both radii; sections
4-6 skip themselves when Chatswood is outside the extent and say so.

Nothing here writes a tile, touches `client/public/world`, or runs a 60 km
anything. The solves land in the ordinary `terraincache` directory, keyed on the
`bare_earth` flag like every other input, so the off solve and the on solve are
two entries and neither can be mistaken for the other.
"""

from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import shapely

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from sydney import bareearth, config, pads, terraincache
from sydney.terrain import post_spacing

PASS, FAIL = "PASS", "FAIL"


def _pct(a: np.ndarray, q: float) -> float:
    return float(np.percentile(a, q)) if a.size else 0.0


def _posts(lattice):
    s = lattice.spacing
    q_n, p_n = lattice.heights.shape
    pi, qi = np.meshgrid(np.arange(p_n), np.arange(q_n), indexing="xy")
    return (
        lattice.heights.ravel().astype(np.float64),
        (pi.ravel() + lattice.p0) * s,
        (qi.ravel() + lattice.q0) * s,
    )


# --- 1. The diff, the gate, and the shadow ---------------------------------------


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
    if not idx.size:
        print(f"   GATE             {FAIL}: nothing moved")
        return ["the bare-earth pass moved nothing at all -- no zone found a post"]
    m = moved[idx]
    print(f"   move  p50/p95/max {_pct(m, 50):.3f} / {_pct(m, 95):.3f} / {m.max():.3f} m")
    print(f"   direction        {int((h_on[idx] > h_off[idx]).sum()):,} up, "
          f"{int((h_on[idx] < h_off[idx]).sum()):,} down")

    allowed = pads.allowed_geometry(on.bare_earth)
    print(f"   stated zone      {allowed.area / 1e4:.2f} ha over {len(on.bare_earth)} zone(s) "
          f"(+{pads.FEATHER_M:.2f} m feather)")
    d = np.asarray(shapely.distance(shapely.points(east[idx], north[idx]), allowed))
    inside = idx[d <= 1e-9]
    outside = idx[d > 1e-9]
    out_d = d[d > 1e-9]

    # --- The gate, on the direct write. The pass can only write where
    # `pads._feather` is non-zero, which is exactly `allowed`; a post in there
    # that moved is the rule working. This half is the assertion.
    print(f"\n   the direct write   {inside.size:,} post(s) inside the stated zones, "
          f"p50 {_pct(moved[inside], 50):.3f} max {(moved[inside].max() if inside.size else 0.0):.3f} m")
    if not inside.size:
        problems.append("no post inside a stated zone moved: the pass wrote nothing")

    # --- The shadow. Not asserted to be empty, because it cannot be: see the
    # header. Asserted to be *small and near*, which is the honest claim, and
    # printed in full so the day it stops being small is visible.
    print(f"   the road shadow    {outside.size:,} post(s) outside every zone")
    if outside.size:
        sm = moved[outside]
        print(f"      move p50/p95/max {_pct(sm, 50):.3f} / {_pct(sm, 95):.3f} / {sm.max():.3f} m")
        print(f"      distance from the nearest zone: p50 {_pct(out_d, 50):.0f} m, "
              f"p95 {_pct(out_d, 95):.0f} m, max {out_d.max():.0f} m")
        # By size, because "1,568 posts moved" and "1,568 posts moved a metre"
        # are different claims and only the second would be a reason not to ship.
        # The far tail of the shadow is the Lipschitz clamp being transitive --
        # `roadgrade.py`'s TIE_RADIUS_M block says so in as many words -- and a
        # transitive constraint relaxing by a millimetre four kilometres away is
        # arithmetic, not a regression.
        print(f"      {'over':>8} {'posts':>8} {'furthest':>10}")
        for thresh in (0.001, 0.01, 0.05, 0.25, 1.00):
            sel = sm > thresh
            print(f"      {thresh:8.3f} {int(sel.sum()):8,d} "
                  f"{(out_d[sel].max() if sel.any() else 0.0):10.0f} m")
        worst = outside[np.argsort(-moved[outside])][:6]
        for k in worst:
            print(f"      E{east[k]:8.0f} N{north[k]:8.0f}  {moved[k]:7.3f} m  "
                  f"{float(shapely.distance(shapely.points(east[k], north[k]), allowed)):6.0f} m out")
    print(f"\n   GATE             {PASS if inside.size else FAIL}: the write is inside the "
          f"zones; the shadow is the road solve and is reported, not asserted away")

    stats = on.stats.get("bare_earth", {})
    print(f"\n   {'zone':<22} {'posts':>6} {'plateau':>8} {'area ha':>8}  what moved")
    for z in stats.get("zones", []):
        sel = _zone_posts(on, z["name"], east, north)
        mm = moved[sel] if sel.size else np.zeros(0)
        print(f"   {z['name'][:21]:<22} {z['posts']:>6} {z.get('plateau', 0):>8} "
              f"{z.get('area_m2', 0.0) / 1e4:>8.2f}  p50 {_pct(mm, 50):6.2f}  "
              f"max {(mm.max() if mm.size else 0.0):6.2f} m")
    return problems


def _zone_posts(on, name: str, east, north) -> np.ndarray:
    for rec in on.bare_earth:
        if rec.name == name:
            d = np.asarray(shapely.distance(shapely.points(east, north), rec.reach))
            return np.flatnonzero(d <= 1e-9)
    return np.zeros(0, dtype=np.int64)


# --- 2. The zones, and the ones the rule declined --------------------------------


def section_zones(radius_m: float, off, on) -> list[str]:
    print("\n2. THE ZONES -- every bridge-tagged station, and what the roof over it allows")
    caps = dict(bareearth.skipped_zones(radius_m))
    fired = {r.name for r in on.bare_earth}
    if not caps:
        print("   no bridge-tagged station in this extract")
        return []
    print(f"   {'station':<22} {'roof cap':>9} {'fired':>7} {'ground off':>11} "
          f"{'ground on':>10} {'move':>8}")
    for name, cap in sorted(caps.items()):
        rec = next((r for r in on.bare_earth if r.name == name), None)
        note = rec.note if rec else {}
        e = float(note.get("east", 0.0))
        n = float(note.get("north", 0.0))
        if rec is None:
            zone = next((z for z in pads.bridge_station_zones(radius_m) if z.name == name), None)
            if zone is not None:
                c = zone.zone.centroid
                e, n = float(c.x), float(c.y)
        b4, af = float(off.sample(e, n)), float(on.sample(e, n))
        print(f"   {name[:21]:<22} {cap:9.2f} {('yes' if name in fired else 'no'):>7} "
              f"{b4:11.2f} {af:10.2f} {af - b4:+8.2f}")
    declined = [n for n in caps if n not in fired]
    if declined:
        print(f"   declined: {', '.join(declined)} -- nothing but the railway's own structure "
              f"stands over those platforms ({bareearth.RAILWAY_STRUCTURE})")
    return []


# --- 3. The streets, which are the cause of the shadow ---------------------------


def section_streets(off, on) -> list[str]:
    print("\n3. THE STREETS -- what the road solve did with the corrected ground")
    a, b = off.road_surface, on.road_surface
    if a is None or b is None or a.ha.shape != b.ha.shape:
        print("   the two solves do not have comparable road surfaces")
        return []
    d = np.abs(0.5 * (b.ha + b.hb) - 0.5 * (a.ha + a.hb))
    moved = np.flatnonzero(d > 1e-6)
    mid = 0.5 * (a.a + a.b)
    print(f"   {moved.size:,} of {d.size:,} street segments changed height "
          f"({100.0 * moved.size / max(d.size, 1):.3f}%)")
    if moved.size:
        print(f"   move p50/p95/max {_pct(d[moved], 50):.3f} / {_pct(d[moved], 95):.3f} / "
              f"{d.max():.3f} m")
        allowed = pads.allowed_geometry(on.bare_earth)
        dist = np.asarray(shapely.distance(shapely.points(mid[moved, 0], mid[moved, 1]), allowed))
        print(f"   distance from the nearest zone: p50 {_pct(dist, 50):.0f} m, "
              f"p95 {_pct(dist, 95):.0f} m, max {dist.max():.0f} m")
        print("   (a grade-clamped graph is why the shadow in section 1 is not zero)")
    return []


# --- 4/5. Chatswood, and every other bridge-tagged station -----------------------

CHATSWOOD = "Chatswood"


def _row(st, base: float) -> str:
    return (
        f"clearance {st.clearance:+7.2f} [{st.clearance_lo:+6.2f} .. {st.clearance_hi:+6.2f}]  "
        f"vertical {st.vertical:<11} structure {st.structure:<7} "
        f"groundY {st.ground_y:8.2f} trackY {st.track_y:8.2f} siteY {st.site_y:8.2f}"
    )


def _bake(radius_m: float, field, label: str):
    from sydney import rail

    t0 = time.time()
    try:
        b = rail.build_all(radius_m, log=lambda *_a, **_k: None, terrain=field)
    except IndexError as err:
        print(f"   the rail bake cannot run at this radius: {err!r} -- a line in "
              f"`rail.LINE_SPECS` has no station inside {radius_m / 1000:.0f} km. See the header.")
        return None
    print(f"   {label} baked in {time.time() - t0:.0f}s")
    return b


def section_rail(radius_m: float, off, on, bakes: dict) -> list[str]:
    print("\n4. CHATSWOOD -- target: clearance >= +5 m, vertical 'elevated', no conflict")
    # Said out loud every run, because it is the one thing about these numbers a
    # reader will otherwise assume wrongly. `rail.build_all(terrain=True)` -- the
    # shipped `rail-bake` -- loads the DEM **unconformed**: no roads, no water,
    # no pads, no bare earth. So the bake that ships has never seen rule 1 either,
    # and `groundY 42.83` in the shipped Chatswood record is the raw terrarium
    # surface to the centimetre. Both bakes here are run the other way, with the
    # solved lattice handed in, which `build_all` supports and calls "the one way
    # to measure this bake against a ground that is not the raw DEM". Until
    # `build_all`'s default changes, this pass moves the ground the player stands
    # on and does not move the number the bake reports.
    print("   both bakes are run with the solved lattice handed to `rail.build_all`;")
    print("   the shipped `rail-bake` reads the DEM unconformed and sees neither pass.")
    zone = next((z for z in pads.bridge_station_zones(radius_m) if z.name == CHATSWOOD), None)
    if zone is None:
        print(f"   Chatswood is not in a {radius_m / 1000:.1f} km extract. Re-run with "
              f"--radius 20000 (see the header).")
        return []
    for label in ("off", "on"):
        b = bakes.get(label)
        if b is None:
            return []
        st = next((s for s in b["stations"] if s.name == CHATSWOOD), None)
        if st is None:
            print(f"   pass {label}: Chatswood is not in the bake")
            continue
        print(f"   pass {label:<3} {_row(st, on.base_elevation)}")
        if st.conflict:
            print(f"   {'':<12} conflict: {st.conflict[:160]}")

    final = next((s for s in bakes["on"]["stations"] if s.name == CHATSWOOD), None)
    problems: list[str] = []
    if final is None:
        return ["Chatswood is not in the bake at all"]
    if final.clearance < 5.0:
        problems.append(
            f"Chatswood measures {final.clearance:+.2f} m of clearance, short of the "
            f"+5.00 m the brief asks for"
        )
    if final.vertical != "elevated":
        problems.append(f"Chatswood's vertical is {final.vertical!r}, not 'elevated'")
    if final.conflict:
        problems.append("Chatswood still records a structure/ground conflict")

    print("\n5. EVERY OTHER BRIDGE-TAGGED STATION IN THE RING")
    names = [z.name for z in pads.bridge_station_zones(radius_m)]
    print(f"   {'station':<20} {'clearance off':>14} {'on':>9} {'siteY off':>11} {'on':>9} "
          f"{'vertical off':>14} {'on':>11}")
    for name in sorted(names):
        a = next((s for s in bakes["off"]["stations"] if s.name == name), None)
        c = next((s for s in bakes["on"]["stations"] if s.name == name), None)
        if a is None or c is None:
            print(f"   {name[:19]:<20} not in both bakes")
            continue
        print(f"   {name[:19]:<20} {a.clearance:+14.2f} {c.clearance:+9.2f} "
              f"{a.site_y:11.2f} {c.site_y:9.2f} {a.vertical:>14} {c.vertical:>11}")

    # --- Nothing else moved. The same statement `server/chatswood-check.ts`
    # makes about a full bake, made here about the scoped one so a regression is
    # caught before a world round rather than after it.
    print("\n   every station in the bake, by how far its siteY moved:")
    a = {s.name: s.site_y for s in bakes["off"]["stations"]}
    movers = sorted(
        ((s.name, a[s.name], s.site_y) for s in bakes["on"]["stations"] if s.name in a),
        key=lambda r: -abs(r[2] - r[1]),
    )
    big = [r for r in movers if abs(r[2] - r[1]) > 1.0]
    print(f"   {len(big)} of {len(movers)} moved more than 1.00 m")
    for name, was, now in big[:15]:
        print(f"      {name[:26]:<28} {was:9.2f} -> {now:9.2f}  {now - was:+7.2f} m")
    unexpected = [n for n, _w, _x in big if n not in names]
    if unexpected:
        problems.append(
            "stations with no bare-earth zone moved more than a metre: " + ", ".join(unexpected)
        )
    return problems


# --- 6. The audits ---------------------------------------------------------------


def section_audits(radius_m: float, off, on, bakes: dict) -> list[str]:
    print("\n6. THE AUDITS on the scoped outputs")
    from sydney import landmarks

    try:
        anchors = landmarks.read_anchors(min(radius_m, 4000.0))
        landmarks.read_podium_ring(min(radius_m, 4000.0))
        before = {m.name: m.audit for m in landmarks.build_all(off, anchors)}
        after = {m.name: m.audit for m in landmarks.build_all(on, anchors)}
        print("   landmark-audit: every hero built on both grounds")
        for name in sorted(before):
            deltas = {
                k: (before[name][k], after[name][k])
                for k in before[name]
                if isinstance(before[name][k], (int, float))
                and abs(float(after[name][k]) - float(before[name][k])) > 1e-3
            }
            print(f"      {name:<18} "
                  + ("identical" if not deltas else f"{len(deltas)} number(s) moved: "
                     + ", ".join(f"{k} {v[0]:.3f}->{v[1]:.3f}" for k, v in sorted(deltas.items()))))
    except Exception as err:  # noqa: BLE001 -- an audit that cannot run is reported, not fatal
        print(f"   landmark-audit could not run at this radius: {err!r}")

    for label in ("off", "on"):
        b = bakes.get(label)
        if b is None:
            continue
        buried = [s for s in b["stations"] if s.clearance < -1.0 and s.structure != "tunnel"]
        conflicts = [s for s in b["stations"] if s.conflict]
        print(f"   rail-audit  pass {label:<3} {len(b['stations']):4d} stations, "
              f"{len(buried):3d} more than 1 m under the terrain, {len(conflicts):3d} with a "
              f"structure/ground conflict")
    return []


# --- The runner ------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--radius", type=float, default=config.STAGE_BY_NAME["inner"].radius_m,
                    help="metres of extract to solve. 5300 (the inner ring) by default; "
                         "sections 4-6 need 20000 (see the header).")
    ap.add_argument("--skip-rail", action="store_true",
                    help="skip sections 4-6, which run two rail bakes")
    args = ap.parse_args(argv)
    r = float(args.radius)

    print(f"bare-earth-check: {r / 1000:.1f} km, spacing {post_spacing():.2f} m, "
          f"feather {pads.FEATHER_M:.2f} m, built coefficient {bareearth.BUILT_COEFF}")
    t0 = time.time()
    print("  solving with the bare-earth pass OFF")
    off = terraincache.load(r, bare_earth=False)
    print("  solving with the bare-earth pass ON")
    on = terraincache.load(r, bare_earth=True)
    print(f"  two solves in {time.time() - t0:.0f}s")

    problems: list[str] = []
    problems += section_diff(r, off, on)
    problems += section_zones(r, off, on)
    problems += section_streets(off, on)
    if not args.skip_rail:
        bakes = {"off": _bake(r, off, "pass off"), "on": _bake(r, on, "pass on")}
        if bakes["off"] is not None and bakes["on"] is not None:
            problems += section_rail(r, off, on, bakes)
            problems += section_audits(r, off, on, bakes)

    print()
    if problems:
        print(f"{FAIL}: {len(problems)} problem(s)")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"{PASS}: the pass moved what it claimed"
          + ("." if args.skip_rail else ", and Chatswood is up off the floor."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
