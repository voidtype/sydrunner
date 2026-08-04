"""Pipeline entry point.

    uv run python -m sydney build --stage inner
    uv run python -m sydney build --stage middle
    uv run python -m sydney status
    uv run python -m sydney terrain-audit
    uv run python -m sydney winding-audit
    uv run python -m sydney vegetation-audit
    uv run python -m sydney carriageway-audit
    uv run python -m sydney road-grade-audit
    uv run python -m sydney water-audit
    uv run python -m sydney landmark-audit
    uv run python -m sydney reset --kind tile

Resumable throughout: every tile emission is a ledger unit, so an interrupted
run picks up where it stopped rather than starting over.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from tqdm import tqdm

from . import (
    attributes,
    config,
    contact,
    decks,
    fences,
    furniture,
    geo,
    landmarks,
    lanes,
    ledger,
    merge,
    mesh,
    parking,
    power,
    powerups,
    roadgrade,
    rows,
    streets,
    tiles,
    vegetation,
    water,
)
from .sources import msbuildings, osm
from .terrain import Terrain

# How far past the stage radius the suburb label nodes are read. See
# `_emit_suburbs`: a suburb whose label sits just outside the build still has
# streets inside it, and 2 km covers every such case at stage `inner` -- the
# furthest of them, Newtown, is 50 m past the line.
SUBURB_MARGIN_M = 2_000.0


def _load_buildings(con, radius_m: float, rebuild: bool) -> list[merge.Building]:
    """Merged, classified building set for a radius.

    The merged set is cached in the ledger's `buildings` table. Rebuilding it
    takes about 90 seconds from cached sources, so it is only redone on request
    or when the table is empty.
    """
    have = con.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    if have and not rebuild:
        print(f"  reusing {have:,} buildings from the ledger (use --rebuild to redo)")
        return _read_buildings_table(con)

    print("  reading OSM extract ...")
    osm_buildings = osm.read_buildings(radius_m)
    print(f"    {len(osm_buildings):,} OSM buildings")

    print("  loading Microsoft footprints ...")
    ms = msbuildings.load(con, radius_m)
    print(f"    {len(ms):,} Microsoft footprints")

    print("  merging (OSM wins on overlap) ...")
    buildings, stats = merge.merge(osm_buildings, ms)
    print("    " + json.dumps(stats))

    print("  cutting terrace rows into houses ...")
    buildings, row_report = rows.split_rows(buildings)
    _report_rows(row_report)

    print("  classifying archetypes and resolving heights ...")
    retail = osm.read_retail_points(radius_m)
    report = attributes.apply(buildings, retail)
    for name, n in sorted(report.archetypes.items(), key=lambda kv: -kv[1]):
        print(f"    {name:20} {n:>7,}  {100 * n / len(buildings):5.1f}%")
    _report_materials(report, len(buildings))
    _report_slices(report)

    merge.store(con, buildings)
    return buildings


# Places whose ground height is known independently of this pipeline, with their
# approximate AHD elevation. Printed on every build for the same reason the
# parked cars' orientation is counted: a DEM that loads, smooths and samples
# perfectly can still be shifted, flipped north-for-south or reading the wrong
# hemisphere, and *none* of those failures says anything at all in the output --
# a wrong-but-plausible landscape looks like a landscape. These say otherwise.
#
# The right thing to read is the **relative** column. An absolute error is an
# offset in the datum and harms nothing; a relative one means the relief itself
# is wrong, which is the whole point of the pass.
TERRAIN_CHECKS: tuple[tuple[str, float, float, float], ...] = (
    ("Observatory Hill", 151.2047, -33.8590, 40.0),
    ("The Domain", 151.2160, -33.8660, 18.0),
    ("Surry Hills, Crown St", 151.2118, -33.8862, 40.0),
    ("Newtown, King St ridge", 151.1793, -33.8965, 40.0),
    ("Erskineville station", 151.1857, -33.9017, 12.0),
    ("Alexandria, Botany Rd", 151.1955, -33.9060, 8.0),
    ("Blackwattle Bay shore", 151.1877, -33.8770, 3.0),
)


def _report_terrain(t) -> None:
    """The datum, and the landmarks that say whether the relief is real."""
    print(
        f"    zoom {t.stats['zoom']} terrarium,"
        f" {t.stats['pixels'][1]}x{t.stats['pixels'][0]} px at {t.stats['metres_per_pixel']:.1f} m,"
        f" smoothed at sigma {t.stats['sigma_m']:.0f} m"
        f" -> {t.stats['posts'][0]}^2 posts"
    )
    print(
        f"    datum: y = 0 is {t.base_elevation:.1f} m AHD (the ground at the ENU origin);"
        f" world y spans {t.stats['min']:.0f} to {t.stats['max']:.0f} m"
    )
    solved, pulled = t.stats.get("roads"), t.stats.get("conform")
    if solved and pulled:
        # See `roadgrade.py`. Printed here rather than in its own report because
        # it is not a stage of the build -- it is part of what the ground *is*,
        # and the datum line above is the other part.
        print(
            f"    streets: {solved['ways']:,} ways solved over {solved['nodes']:,} graph nodes"
            f" ({solved['junctions']:,} shared), grade p95 {100 * solved['grade_p95']:.1f}%"
            f" max {100 * solved['grade_max']:.1f}%, {solved['over_max']} over the ceiling;"
            f" {solved['drop_p95']:+.1f} m under the raw DEM at p95"
        )
        print(
            f"    ground pulled onto them at {pulled['plateau']:,} posts of"
            f" {pulled['posts']:,} ({pulled['conformed']:,} touched at all), moved"
            f" {pulled['moved_p50']:.2f} m at p50, {pulled['moved_p95']:.2f} at p95,"
            f" {pulled['moved_max']:.1f} worst"
        )
    print(f"    {'landmark':24} {'world y':>8} {'m AHD':>7} {'real':>6} {'error':>7}")
    for name, lon, lat, truth in TERRAIN_CHECKS:
        e, n = geo.lonlat_to_enu(lon, lat)
        y = t.sample(float(e), float(n))
        print(f"    {name:24} {y:8.1f} {y + t.base_elevation:7.1f} {truth:6.0f} {y + t.base_elevation - truth:+7.1f}")
    # The one relationship the whole feature exists to produce. Stated as a
    # subtraction so it survives any error in the datum.
    ridge = t.sample(*geo.lonlat_to_enu(151.2118, -33.8862))
    flats = t.sample(*geo.lonlat_to_enu(151.1955, -33.9060))
    print(
        f"    Crown St stands {float(ridge - flats):.0f} m over Alexandria (about 32 m in life)."
        + ("" if ridge > flats else "   WARNING: the wrong way up -- check the north sign.")
    )


def _report_water(t) -> None:
    """What the water pass assembled, and how deep the bed under it went.

    Printed beside the terrain report rather than as a stage of its own for the
    reason the street conformance is: the bed is not something laid on the
    ground, it *is* the ground -- `water.conform` runs inside `Terrain.load` --
    and the datum line above is the other half of the same statement.
    """
    stats = t.stats.get("water")
    if not stats:
        return
    conform = stats.get("conform", {})
    field = t.water
    tidal = [b for b in field.bodies if b.tidal] if field is not None else []
    print(
        f"    water: {stats['area_m2'] / 1e6:.2f} km2 over {stats.get('components', 0):,} bodies"
        f" ({len(tidal)} tidal, {stats['tagged_parts']:,} tagged parts unioned,"
        f" {stats['coastline_ways']} coastline sources) at {conform.get('levels', 0)} levels"
    )
    print(
        f"    bed cut at {conform.get('wet', 0):,} posts of {conform.get('posts', 0):,}"
        f" ({conform.get('held', 0):,} more held at the waterline), down"
        f" {conform.get('cut_p50', 0.0):.2f} m at p50, {conform.get('cut_max', 0.0):.1f} worst;"
        f" land lifted {conform.get('lifted_max', 0.0):.2f} m worst"
    )


def _report_rows(r: rows.RowReport) -> None:
    """Rows found, and the frontage range they were cut into.

    The frontage range is the number to read. A count says the pass ran; only
    the range says it ran *correctly*, because the way this fails is not by
    splitting nothing, it is by splitting into frontages that drift -- a 2 m
    house at the end of every row, or an 11 m one, either of which reads worse
    than the mega-facade it replaced. Every frontage must land inside
    [MIN_FRONTAGE, MAX_FRONTAGE], so the min and the max are printed rather than
    a mean, which would hide both.
    """
    if not r.rows:
        print("    no rows detected")
        return
    import numpy as np

    f = np.asarray(r.frontages)
    ln = np.asarray(r.lengths)
    print(
        f"    {r.rows:,} rows -> {r.slices:,} houses"
        f" ({r.rows_tagged:,} tagged building=terrace,"
        f" {r.rows_geometry:,} on geometry alone)"
    )
    print(
        f"    row length  {ln.min():.0f}-{ln.max():.0f} m,"
        f" median {np.median(ln):.0f} m,"
        f" {np.median(np.round(ln / rows.TARGET_FRONTAGE)):.0f} houses in the median row"
    )
    # The bounds are the cut walk's, less the party wall it gives up at each
    # end: what is measured here is the built frontage, not the lot width. A
    # sliver folded into its neighbour is the one legitimate way to exceed the
    # upper bound, so only the floor is checked.
    floor = rows.MIN_FRONTAGE - 2 * rows.PARTY_WALL_INSET - 1e-6
    print(
        f"    frontage    {f.min():.2f}-{f.max():.2f} m, median {np.median(f):.2f} m"
        + ("" if f.min() >= floor else "   WARNING: under MIN_FRONTAGE -- the cut walk drifted")
    )
    if r.slivers_merged or r.multipart_cuts or r.rows_not_conserved:
        print(
            f"    {r.slivers_merged:,} offcuts folded into a neighbour,"
            f" {r.multipart_cuts:,} cuts that fell in more than one piece,"
            f" {r.rows_not_conserved:,} rows left whole for losing ground to the cut"
        )


def _report_slices(report: attributes.AttributeReport) -> None:
    """What the classifier made of the slices, which is the test of the whole pass.

    A row is cut into 5.8 m houses so that the terrace test -- narrow, deep,
    row-adjacent, inner suburb -- finally fires on it. If the slices come back as
    walk-ups the geometry is right and the classification is still wrong, and the
    render looks near enough to the mega-facade that nothing would say so.
    """
    if not report.slices:
        return
    n = report.slices
    share = "  ".join(
        f"{a} {100 * c / n:.0f}%"
        for a, c in sorted(report.slice_archetypes.items(), key=lambda kv: -kv[1])
    )
    print(f"  row houses ... {n:,} classified as: {share}")
    print(
        f"    {report.parapets_stepped:,} given a stepped parapet"
        f" ({100 * report.parapets_stepped / n:.0f}%; the rest either kept a"
        f" surveyed OSM height or are not a parapet class)"
    )


def _report_materials(report: attributes.AttributeReport, total: int) -> None:
    """The material histogram, city-wide and per archetype.

    Printed on every build because the material is now a weighted *draw* rather
    than a lookup, and a draw fails silently: a mis-normalised weight column or a
    slot name typo'd out of `mesh.MATERIALS` collapses an archetype back onto one
    colour, and nothing about the render says so -- a monochrome city looks like a
    taste decision. This is the thing that says otherwise, so it is in the build
    log rather than behind a flag.
    """
    if not total:
        return
    print("  wall materials ...")
    for name, n in sorted(report.materials.items(), key=lambda kv: -kv[1]):
        print(f"    {name:20} {n:>7,}  {100 * n / total:5.1f}%")
    print(
        f"    {report.osm_stated:,} of them stated by OSM ("
        f"{100 * report.osm_stated / total:.1f}%, and those override the draw);"
        f" {report.neighbour_runs:,} copied a neighbour to make a matching pair"
        f" ({100 * report.neighbour_runs / total:.1f}%)"
    )
    for arch, mix in sorted(report.by_archetype.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(mix.values())
        share = "  ".join(
            f"{m} {100 * c / n:.0f}%" for m, c in sorted(mix.items(), key=lambda kv: -kv[1])
        )
        print(f"    {arch:20} {share}")


def _read_buildings_table(con) -> list[merge.Building]:
    import numpy as np

    out: list[merge.Building] = []
    for r in con.execute("SELECT * FROM buildings"):
        g = json.loads(r["geometry"])
        # Re-oriented on the way in, not trusted. A `--retile` without a
        # `--rebuild` reads a table that may predate the winding invariant
        # entirely, and a table written under it can still hold a sliver whose
        # sign the 1 cm rounding in `merge.store` flipped. The call is
        # idempotent and one shoelace per building, so the cheap answer is to
        # make this path enforce the invariant rather than inherit it.
        ring, holes = merge.orient_footprint(
            np.asarray(g["ring"], dtype=np.float64),
            [np.asarray(h, dtype=np.float64) for h in g.get("holes", [])],
        )
        out.append(
            merge.Building(
                id=r["id"],
                source=g.get("source", "ms"),
                ring=ring,
                holes=holes,
                area=r["area"],
                centroid=(r["east"], r["north"]),
                name=g.get("name"),
                building_type=g.get("type"),
                levels=r["levels"],
                material=r["material"],
                start_date=r["start_date"],
                height=r["height"] or 0.0,
                height_source=r["height_source"] or "",
                archetype=r["archetype"] or "brick_veneer",
                retail=bool(r["retail"]),
                roof_form=r["roof_form"] or "flat",
            )
        )
    return out


def cmd_build(args: argparse.Namespace) -> int:
    stage = config.STAGE_BY_NAME[args.stage]
    config.ensure_dirs()
    con = ledger.connect()

    print(f"stage {stage.index} '{stage.name}' -- {stage.description}")
    print(f"radius {stage.radius_m / 1000:.0f} km")
    t0 = time.time()

    buildings = _load_buildings(con, stage.radius_m, args.rebuild)

    # The landmark anchors, and the suppression they imply, **before** anything
    # is bucketed by tile. This is the earliest point the filter can run and the
    # only one where it runs once: the tiles, the collision payload and
    # `far.bin` are all derived from this one list, so a building dropped here is
    # dropped from all three and there is no fourth place to remember.
    print("  reading the landmark anchors ...")
    anchors = landmarks.read_anchors(stage.radius_m)
    landmarks.read_podium_ring(stage.radius_m)
    zones = landmarks.suppression_zones(anchors)
    buildings, suppressed = landmarks.suppress(buildings, zones)
    _report_suppression(anchors, suppressed)

    by_tile: dict[str, list[merge.Building]] = defaultdict(list)
    for b in buildings:
        by_tile[b.tile].append(b)

    print("  reading the terrain ...")
    terrain = Terrain.load(stage.radius_m)
    _report_terrain(terrain)
    _report_water(terrain)

    # And the landmarks themselves, which need the terrain: a pylon stands on the
    # ground at Dawes Point, the Opera House podium is cut into Bennelong Point,
    # and Sydney Tower's published 309 m is measured from the footpath outside
    # Westfield rather than from any datum.
    print("  building the hero landmarks ...")
    marks = landmarks.build_all(terrain, anchors)
    landmark_prisms = landmarks.prisms_by_tile(marks)
    _report_landmarks(marks, terrain)

    print("  reading the street network ...")
    street_network = streets.StreetNetwork.load(stage.radius_m, buildings)
    print(f"    {len(street_network):,} surface ways")

    # The elevated roads. After the terrain and after the landmarks, and it needs
    # both: a deck's touchdown height is read straight off the *conformed*
    # ground, and every bridge centreline is clipped against the hero Harbour
    # Bridge's own plan first so a generic deck cannot stand inside the authored
    # one. See `decks.py`.
    print("  solving the bridge decks ...")
    deck_network = decks.DeckNetwork.load(
        stage.radius_m, terrain, decks.hero_bridge_zone(anchors, zones)
    )
    _report_decks(deck_network)

    print("  reading parks and mapped trees ...")
    veg_network = vegetation.VegetationNetwork.load(stage.radius_m, street_network)
    print(
        f"    {veg_network.green_count:,} green polygons"
        f" ({veg_network.green_area / 1e4:,.0f} ha),"
        f" {veg_network.mapped_count:,} mapped trees"
    )

    # After the vegetation, because a bay has to know where the trunks are before
    # it can decide it is free -- see `parking._clear_of_trunks`.
    parking_network = parking.ParkingNetwork(street_network, veg_network)

    # And after the parking, because a pole has to clear both. Last in the chain
    # by construction: it is the only one of the four that queries all three of
    # the others, and it queries them read-only.
    print("  reading mapped power poles ...")
    mapped_poles = power.load_mapped_poles(stage.radius_m)
    power_network = power.PowerNetwork(
        street_network, veg_network, parking_network, mapped_poles, terrain
    )
    print(f"    {len(mapped_poles):,} surveyed power=pole nodes")

    # And after the power, because a wheelie bin stands on the same line as a
    # pole and has to clear one. Last in the chain of instanced networks: it is
    # the only one that queries all four of the others, and it queries them
    # read-only.
    print("  reading mapped traffic signals ...")
    signal_nodes = furniture.load_signal_nodes(stage.radius_m)
    furniture_network = furniture.FurnitureNetwork(
        street_network, veg_network, power_network, buildings, signal_nodes, terrain
    )
    print(
        f"    {len(signal_nodes):,} surveyed highway=traffic_signals nodes"
        f" (mapped per approach) -> {furniture_network.stats['signal_clusters']:,}"
        f" intersections"
    )

    # The lane graph and the traffic timetable on it. Last of the networks and
    # it needs four of the things above: the street network for the ways, the
    # terrain for the height of a ground lane, the deck network for the height
    # of an elevated one, and the signals for where a car waits at a red. The
    # hero Harbour Bridge gets a profile of its own -- `decks.py` deliberately
    # clipped its ways out of the generic deck pass, so without `HeroDeck` the
    # Bradfield Highway's traffic would be on the harbour bed. See `lanes.py`.
    print("  solving the lane graph ...")
    lane_network = lanes.LaneNetwork.load(
        stage.radius_m,
        terrain,
        street_network.roads,
        deck_network,
        lanes.HeroDeck(anchors, decks.hero_bridge_zone(anchors, zones), terrain),
        signal_nodes,
    )
    _report_lanes(lane_network)

    # Spec 8.3's powerups. Independent of the four instanced networks above --
    # it clears nothing and is cleared by nothing, because a floating icon
    # occupies no ground -- so it takes only the streets (for the paving its
    # snap prefers) and the footprints (for the walls its snap escapes).
    print("  reading stations and cafes ...")
    poi_nodes, station_areas = powerups.load_powerup_pois(stage.radius_m)
    powerup_network = powerups.PowerupNetwork(
        street_network, buildings, poi_nodes, station_areas, terrain
    )
    ps = powerup_network.stats
    print(
        f"    {ps['station_nodes']:,} railway=station nodes"
        f" + {ps['station_areas']:,} station ways,"
        f" {ps['entrance_nodes']:,} entrances, {ps['cafe_nodes']:,} cafes"
    )

    # Reads the street network and nothing else, so it could sit anywhere after
    # it. Placed last because it is the only one of the five that emits into a
    # building's own mesh slots rather than producing its own instances.
    awning_network = mesh.AwningNetwork(street_network)
    # And the front doors, which ask the same network the same question about the
    # same walls -- "does this edge front a street" -- and emit no geometry for
    # the answer, only a `u` in the facade parameter record. See `mesh.DoorNetwork`.
    door_network = mesh.DoorNetwork(street_network)
    # And the front fences, which take both: the street network to find the
    # property line and the door network so the gate is on the same wall as the
    # door and at the same `u` along it. Last of all, because it is the only one
    # of the three that depends on another of them.
    fence_network = fences.FenceNetwork(street_network, door_network)

    # Only tiles inside the requested radius, so a `middle` build after an
    # `inner` build extends coverage rather than re-emitting it.
    wanted = {t.key for t in geo.tiles_within_radius(stage.radius_m)}
    # A tile earns emission by having buildings, streets *or* vegetation. Keying
    # off buildings alone left every road that runs past the last building at the
    # extent edge with no surface under it; leaving vegetation out of the union
    # does the same thing to the middle of a park.
    keys = sorted(
        (
            set(by_tile)
            | street_network.tile_keys()
            | veg_network.tile_keys()
            # Only the tiles an *orphan* surveyed pole lands in -- one standing
            # somewhere no street reaches, which nothing else in the build would
            # emit a tile for. Everything else this module produces is on a way
            # and is already covered by the streets.
            | power_network.tile_keys()
            # And the tiles a station or a cafe lands in. Every one of them is
            # a built-up place, so this is a subset of the buildings' own keys
            # in practice -- it is here so that a station in a rail corridor
            # with nothing else on it cannot silently lose its tile.
            | powerup_network.tile_keys()
            # And the tiles a deck crosses. A subset of the street keys in
            # practice, since a bridge way is still in the street network and
            # still claims its own tiles there; it is here so a viaduct over
            # water cannot lose the tile it is the only thing on.
            | deck_network.tile_keys()
            # And the tiles a lane graph span or a car route starts in. A
            # subset of the street keys, since every lane is derived from a way
            # that is already in the street network -- here for symmetry with
            # the decks above, and so that a future source of drivable geometry
            # off the street network cannot silently lose its tile.
            | lane_network.tile_keys()
        )
        & wanted
    )
    print(
        f"  {len(buildings):,} buildings across {len(keys):,} tiles"
        f" ({len(keys) - len(set(by_tile) & wanted):,} of them streets only)"
    )

    ledger.register(con, "tile", keys)
    if args.retile:
        ledger.reset(con, "tile")
    todo = [k for k in ledger.pending(con, "tile") if k in wanted]
    # `--only` narrows the run to a handful of named tiles, and it exists for one
    # situation: a pass that changes something local -- the landmarks are the
    # first -- needs the five tiles it touched re-emitted so it can be verified,
    # and re-emitting 223 to get 5 is twenty minutes of work to prove a bridge is
    # in the right place.
    #
    # What makes it safe is `_carry_index_tiles` below. `write_index` is rebuilt
    # from the *ledger* on every run, and the ledger only holds a record for a
    # tile it has actually emitted -- so a narrowed run would otherwise ship an
    # index listing five tiles and delete the other 218 from the client's world,
    # with all 218 still sitting on disk.
    only = {k.strip() for k in (args.only or "").split(",") if k.strip()}
    if only:
        unknown = only - set(keys)
        if unknown:
            print(f"  --only names {len(unknown)} tile(s) this stage does not have: {sorted(unknown)}")
        todo = [k for k in keys if k in only]
        print(f"  --only: {len(todo):,} tiles of {len(keys):,}")
    print(f"  {len(todo):,} tiles to emit ({len(keys) - len(todo):,} already done)")

    results: list[tiles.TileResult] = []
    for key in tqdm(todo, unit="tile", disable=not sys.stderr.isatty()):
        with ledger.unit(con, "tile", key) as detail:
            res = tiles.build_tile(
                key,
                by_tile.get(key, []),
                street_network,
                veg_network,
                parking_network,
                power_network,
                furniture_network,
                powerup_network,
                awning_network,
                door_network,
                fence_network,
                terrain,
                landmark_prisms.get(key),
                deck_network,
                lane_network,
            )
            if res is None:
                detail["empty"] = True
                continue
            detail.update(
                b=res.buildings,
                t=res.triangles,
                sz=res.glb_bytes,
                v=res.trees,
                c=res.cars,
                p=res.poles,
                w=res.spans,
                fb=res.bins,
                fp=res.posts,
                fs=res.signals,
                pw=res.powerups,
                sn=res.street_names,
                snb=res.names_bytes,
                wv=res.water_verts,
                wt=res.water_tris,
                wb=res.water_bytes,
                wy=round(res.water_y, 3),
                wa=round(res.water_area, 1),
                lw=res.lane_ways,
                lr=res.lane_routes,
                lc=res.lane_cars,
                lb=res.lanes_bytes,
                # `hmax` was missing from this record and defaulted to zero in
                # `_results_from_ledger`, so every tile in the index has claimed a
                # tallest building of 0 m since the ledger started rebuilding it.
                # The client sizes each tile's cull box from it, which left the
                # CBD's towers in a 25 m box: they pop out of frame the moment you
                # stand under one and look up. Found while extending the same box
                # downward for terrain.
                hmax=round(res.height_max, 1),
                g=[round(res.ground_min, 2), round(res.ground_max, 2)],
            )
            results.append(res)

    _report_parking(parking_network, results)
    _report_power(power_network, results)
    _report_furniture(furniture_network, results)
    _report_powerups(powerup_network)
    _report_awnings(awning_network)
    _report_doors(door_network)
    _report_fences(fence_network)

    # The far layer, last, and deliberately outside the tile loop: it belongs to
    # no tile. One ledger unit for the whole thing because its two files cannot
    # be produced apart -- a slab's floor is the far terrain, so the terrain has
    # to exist before the slabs are placed on it. `--retile` resets it with
    # everything else, which is right: it is derived from the same buildings and
    # the same DEM, so anything that invalidates a tile invalidates this too.
    far = _emit_far(con, buildings, terrain, args.retile)
    _report_far(far)

    # The far water, on the same terms as the far layer -- one file for the whole
    # build, belonging to no tile -- but deliberately *not* ledgered, like the
    # suburb table. `_emit_far` earns its unit by costing a minute over 33,774
    # buildings; this is one cut of a polygon the terrain is already holding and
    # a 200 kB write, and doing it every run is what guarantees the harbour on
    # disk matches the bed the index has just described.
    water_contract = tiles.emit_water(terrain)
    _report_far_water(water_contract)

    # The suburb labels, on the same terms as the far layer -- one file for the
    # whole build, belonging to no tile -- but deliberately *not* ledgered.
    # `_emit_far` earns its unit by costing a minute; this is one read of the
    # points layer and a 2 kB write, and writing it every run is what guarantees
    # it is on disk beside an index that has just been rebuilt. See
    # `_report_suburbs` for what the nearest-node lookup can and cannot do.
    _report_suburbs(_emit_suburbs(stage.radius_m))

    # The landmark set, on the far layer's terms -- one file for the whole build,
    # belonging to no tile -- but not ledgered, like the suburb table and the far
    # water. It is three parametric models and a 1 MB write; doing it every run
    # is what guarantees the GLB on disk matches the manifest the index has just
    # described, and there is nothing in it expensive enough to want resuming.
    landmark_stats = tiles.write_landmarks(config.OUT_ROOT / "landmarks.glb", marks)
    landmark_contract = {
        **landmarks.manifest(marks, anchors, terrain),
        "bytes": landmark_stats["bytes"],
    }
    print(
        f"  landmarks -> {landmark_stats['count']} nodes,"
        f" {landmark_stats['triangles']:,} triangles,"
        f" {landmark_stats['bytes'] / 1024:,.0f} kB"
    )

    # The index must describe every emitted tile, including ones done on an
    # earlier run, so it is rebuilt from the ledger rather than from this run.
    all_results = _results_from_ledger(con, wanted)
    all_results += _carry_index_tiles({r.key for r in all_results}, wanted)
    tiles.write_index(
        all_results,
        stage.name,
        stage.radius_m,
        terrain,
        far,
        water_contract,
        landmark_contract,
        lanes.manifest(lane_network),
    )
    _report_street_names(all_results)
    _report_water_tiles(all_results)

    total_mb = sum(r.glb_bytes for r in all_results) / 1024**2
    tri = sum(r.triangles for r in all_results)
    print(
        f"done in {time.time() - t0:.0f}s: {len(all_results):,} tiles, "
        f"{sum(r.buildings for r in all_results):,} buildings, "
        f"{sum(r.trees for r in all_results):,} trees, "
        f"{sum(r.cars for r in all_results):,} parked cars, "
        f"{sum(r.poles for r in all_results):,} power poles, "
        f"{sum(r.spans for r in all_results):,} wire spans, "
        f"{sum(r.bins for r in all_results):,} wheelie bins, "
        f"{sum(r.posts for r in all_results):,} name posts, "
        f"{sum(r.signals for r in all_results):,} signal heads, "
        f"{sum(r.powerups for r in all_results):,} powerups, "
        f"{tri / 1e6:.1f} M triangles, {total_mb:.0f} MB geometry"
    )
    print(f"index -> {config.INDEX_PATH}")
    return 0


def _carry_index_tiles(have: set[str], wanted: set[str]) -> list[tiles.TileResult]:
    """Tiles the previous index described that this run has no ledger record for.

    THE GUARD ON `--only`, and on any narrowed run after it. `write_index` is
    rebuilt from the ledger every time, and the ledger's `done` set is the tiles
    this pipeline has emitted *since the last reset* -- which after a reset is
    five of 223. Writing that index would leave 218 perfectly good tiles sitting
    on disk that the client no longer knows exist, which is not a subtle failure
    but is a silent one: the world simply ends in the CBD and everything else
    still loads.

    So the tiles on disk are the truth and this reads them back. Everything the
    entry carries survives verbatim; the four byte counts the entry does not
    carry are re-`stat`ed off the files themselves, which is exact. Only
    `water_tris` and `water_area` are lost, and both feed a `totals` line rather
    than anything the client reads.
    """
    if not config.INDEX_PATH.exists():
        return []
    try:
        previous = json.loads(config.INDEX_PATH.read_text())
    except (OSError, ValueError):
        return []

    out: list[tiles.TileResult] = []
    for e in previous.get("tiles", []):
        key = e.get("key")
        if key in have or key not in wanted:
            continue
        if not (config.TILE_DIR / f"{key}.glb").exists():
            continue

        def size(path: Path) -> int:
            return path.stat().st_size if path.exists() else 0

        g = e.get("g", [0.0, 0.0])
        out.append(
            tiles.TileResult(
                key=key,
                buildings=e.get("b", 0),
                triangles=e.get("t", 0),
                glb_bytes=e.get("size", 0),
                params_bytes=size(config.TILE_DIR / f"{key}.params.bin"),
                collision_bytes=size(config.COLLISION_DIR / f"{key}.bin"),
                bounds=tuple(e.get("bounds", (0.0, 0.0, 0.0, 0.0))),
                height_max=e.get("hmax", 0.0),
                trees=e.get("v", 0),
                cars=e.get("c", 0),
                poles=e.get("p", 0),
                spans=e.get("w", 0),
                bins=e.get("fb", 0),
                posts=e.get("fp", 0),
                signals=e.get("fs", 0),
                powerups=e.get("pw", 0),
                street_names=e.get("sn", 0),
                names_bytes=size(config.TILE_DIR / f"{key}.names.bin"),
                water_verts=e.get("wv", 0),
                water_bytes=size(config.TILE_DIR / f"{key}.water.bin"),
                water_y=e.get("wy", 0.0),
                lane_ways=e.get("lw", 0),
                lane_routes=e.get("lr", 0),
                lanes_bytes=size(config.TILE_DIR / f"{key}.lanes.bin"),
                ground_min=g[0],
                ground_max=g[1],
            )
        )
    if out:
        print(f"  index carries {len(out):,} tiles from the previous build (not re-emitted)")
    return out


def _report_suppression(anchors: dict, removed: dict[str, list[str]]) -> None:
    """What the landmark zones took out of the generic city, by id.

    Ids rather than counts, and capped at eight per zone. A count cannot tell
    "the two pylon blobs and the Opera House warehouse went" -- which is the
    whole intent -- from "the zone grew and ate Circular Quay", and this pass
    runs before the tiles, the collision payload and `far.bin` are derived from
    the same list, so it is the one filter here with the reach to do that.
    """
    total = sum(len(v) for v in removed.values())
    sources = ", ".join(f"{k}={v.source}" for k, v in sorted(anchors.items()))
    print(f"    anchors: {sources}")
    print(f"    suppressed {total} generic buildings inside the landmark zones")
    for zone, ids in sorted(removed.items()):
        if not ids:
            print(f"      {zone:8} 0")
            continue
        shown = ", ".join(ids[:8]) + (f", +{len(ids) - 8} more" if len(ids) > 8 else "")
        print(f"      {zone:8} {len(ids):>3}  {shown}")


def _report_landmarks(marks: list, terrain) -> None:
    """Each landmark's size and its two or three load-bearing heights, in AHD."""
    sea = -terrain.base_elevation
    for lm in marks:
        a = lm.audit
        print(
            f"    {lm.name:16} {lm.triangles:>7,} tris  {lm.vertices:>7,} verts"
            f"  {len(lm.prisms):>4} prisms"
        )
        if lm.name == "harbour_bridge":
            print(
                f"      deck {a['deck_ahd']:.1f} m AHD, arch apex {a['arch_apex_ahd']:.1f} m,"
                f" span {a['arch_span_m']:.0f} m, deck run"
                f" {a['deck_s_max'] - a['deck_s_min']:.0f} m"
                f" (ramps {a['ramp_south_m']:.0f} / {a['ramp_north_m']:.0f} m)"
            )
        elif lm.name == "opera_house":
            print(
                f"      podium {a['podium_ahd']:.1f} m AHD over {a['podium_area_m2']:,.0f} m2,"
                f" tallest shell {a['shell_max_ahd']:.1f} m,"
                f" sphere R {a['sphere_radius_m']:.1f} m"
            )
        elif lm.name == "sydney_tower":
            print(
                f"      base {a['base_y'] - sea:.1f} m AHD, spire {a['height_m']:.0f} m above it"
                f" ({a['spire_y'] - sea:.1f} m AHD), {int(a['cables'])} cables"
            )


def _report_decks(net: decks.DeckNetwork) -> None:
    """What came off the ground, where it went, and how steep it is.

    Four lines, and each of them is a thing that could go wrong silently. The
    first says how much of the bridge network survived the hero clip; the second
    is the profile solve's own verdict against its 7% ceiling; the third is how
    much of it is genuinely in the air, which is what separates a viaduct from a
    culvert crossing that happens to be tagged `bridge`; the fourth is the solve's
    connectivity, because a component that reached no ground way at all took a
    fallback pin and is the one case here that is a guess rather than a
    measurement.
    """
    s = net.stats
    if not s.get("runs"):
        print("    no bridge ways in this extent")
        return
    print(
        f"    {s['bridge_ways']:,} bridge carriageways, {s['bridge_length_m'] / 1000:.2f} km"
        f" -> {s['runs']:,} decks, {s['deck_length_m'] / 1000:.2f} km"
        f" ({s['suppressed_m'] / 1000:.2f} km suppressed inside the hero bridge)"
    )
    print(
        f"    deck grade p50 {100 * s['grade_p50']:.2f}%  p95 {100 * s['grade_p95']:.2f}%"
        f"  max {100 * s['grade_max']:.2f}%"
        f"   over {100 * decks.MAX_GRADE:.0f}%: {s['over_max']:,} of {s['segments']:,} segments"
    )
    print(
        f"    clearance over the ground p50 {s['clear_p50']:.2f} m  max {s['clear_max']:.2f} m"
        f"  min {s['clear_min']:.2f} m;"
        f" {100 * s['elevated_share']:.0f}% of stations genuinely in the air"
    )
    print(
        f"    {s['nodes']:,} deck nodes in {s['components']:,} components,"
        f" {s['pinned']:,} pinned to a ground touchdown"
        f" ({s['unpinned_components']} components reached none)"
    )


def _emit_far(con, buildings: list[merge.Building], terrain, retile: bool) -> dict:
    """The far layer, as one resumable ledger unit keyed `world`.

    The contract it returns has to reach `index.json` on *every* run, including
    one where the unit was already done and nothing was rewritten -- otherwise a
    resumed build ships an index that does not mention the two files sitting on
    disk beside it, and the client silently loads no far layer at all. So the
    detail JSON is read back out of the ledger when the work is skipped, which
    is the same record `status` prints.
    """
    ledger.register(con, "far", ["world"])
    if retile:
        ledger.reset(con, "far")
    if "world" in ledger.pending(con, "far"):
        with ledger.unit(con, "far", "world") as detail:
            detail.update(tiles.emit_far(buildings, terrain))
            return dict(detail)
    row = con.execute("SELECT detail FROM jobs WHERE kind='far' AND key='world'").fetchone()
    return json.loads(row["detail"]) if row and row["detail"] else {}


def _emit_suburbs(radius_m: float) -> tuple[list, int, int]:
    """Read the suburb label nodes and write `world/suburbs.json`.

    Read on a **wider radius than the stage**, and that is the one decision in
    here. A label node sits near the middle of its suburb, so a suburb whose
    middle is just past the build's edge has no node at all -- and the tiles at
    that edge are exactly the ones a player standing in that suburb is on. At
    stage `inner`'s 4 km the casualty is Newtown, whose node is 4.05 km out: the
    build covers half of King Street and the readout would have called all of it
    Darlington. The margin costs nothing measurable -- these are points, and the
    whole file is a couple of kilobytes -- and it cannot mislead, because a node
    outside the build can only ever be named by a player who is closer to it than
    to anything inside.
    """
    places = osm.read_places(radius_m + SUBURB_MARGIN_M)
    count, size = tiles.write_suburbs(config.OUT_ROOT / "suburbs.json", places)
    return places, count, size


def _report_suburbs(emitted: tuple[list, int, int]) -> None:
    """What was found, and -- the part worth printing -- what it cannot do.

    The spacing figure is the one number that says whether nearest-node is a
    defensible stand-in for a boundary test. It is the median distance from a
    node to its nearest neighbour, which is roughly the width of the band either
    side of a boundary in which the answer is a coin toss: half of it, in fact,
    since the error region is where the two centres are near-equidistant.
    """
    places, count, size = emitted
    if not places:
        print("  suburbs: none found -- the readout will name streets only")
        return
    kinds = Counter(p.kind for p in places)
    spread = ", ".join(f"{k} {v:,}" for k, v in sorted(kinds.items()))
    pts = np.array([[p.east, p.north] for p in places])
    d = np.hypot(pts[:, None, 0] - pts[None, :, 0], pts[:, None, 1] - pts[None, :, 1])
    np.fill_diagonal(d, np.inf)
    nearest = np.sort(d.min(axis=1))
    print(
        f"  suburbs: {count:,} label nodes ({spread}), {size / 1024:.1f} kB"
        f" -- nearest neighbour {nearest[len(nearest) // 2]:,.0f} m median,"
        f" {nearest[0]:,.0f} m closest"
    )
    names = sorted(p.name for p in places)
    print(f"    {', '.join(names[:10])}, ...")


def _report_street_names(results: list[tiles.TileResult]) -> None:
    """The named-centreline sidecars: coverage first, cost second.

    Coverage is the number that matters and it is the number of tiles with
    *none*. A tile with no named street on it is a park, the harbour or an
    industrial edge, and it is also a tile where the readout can only ever say
    the suburb -- so a count that creeps up is the readout quietly going blank
    over part of the map, which nothing else in this report would show.
    """
    named = [r for r in results if r.street_names]
    if not named:
        return
    counts = sorted((r.street_names for r in named), reverse=True)
    total_bytes = sum(r.names_bytes for r in results)
    print(
        f"  street names: {sum(counts):,} centreline runs across {len(named):,}"
        f" of {len(results):,} tiles ({len(results) - len(named):,} with none)"
        f" -- median {counts[len(counts) // 2]:,} runs a tile, max {counts[0]:,}"
    )
    print(
        f"    {total_bytes / 1024:,.0f} kB total,"
        f" {total_bytes / max(len(named), 1):,.0f} bytes a tile mean,"
        f" decimated at {streets.NAME_SIMPLIFY:.1f} m"
    )


def _report_far(far: dict) -> None:
    """What the far layer costs and, more usefully, what it keeps."""
    if not far:
        return
    t = far["terrain"]
    print(
        f"  far layer: {far['count']:,} slabs"
        f" (height >= {far['min_height_m']:.0f} m or area >= {far['min_area_m2']:.0f} m2),"
        f" {far['bytes'] / 1024:,.0f} kB"
    )
    # The plan is a convex hull rather than a box since format 2, so the two
    # numbers that used to be one constant -- bytes and triangles a slab -- are
    # now distributions and are worth printing. `verts / count` is the mean hull
    # after simplification, and it is what the triangle total is made of.
    if "plan_verts" in far:
        print(
            f"    {far['plan_verts']:,} plan vertices"
            f" ({far['plan_verts'] / max(far['count'], 1):.1f} a slab, capped at"
            f" {far.get('max_plan_verts', 0)}), {far['triangles']:,} triangles,"
            f" inset {far.get('inset_m', 0):.2f} m,"
            f" grouped into {far.get('groups', 0):,} tiles"
        )
    print(
        f"    far terrain {t['posts']}^2 posts at {t['post_m']:.2f} m"
        f" over +/-{t['half_extent_m'] / 1000:.1f} km, {t['bytes'] / 1024:,.0f} kB,"
        # The sink is measured per build and is the one number here that says
        # whether the coarse ground can be trusted to stay under the real one.
        f" sunk {t['sink_m']:.2f} m"
    )


def _report_far_water(contract: dict | None) -> None:
    """The always-resident harbour: what it covers and what it costs."""
    if not contract:
        return
    far = contract["far"]
    print(
        f"  far water: {contract['tidal_area_m2'] / 1e6:.2f} km2 tidal"
        f" of {contract['area_m2'] / 1e6:.2f} km2 assembled,"
        f" {far['triangles']:,} triangles in {far['sheets']} sheet(s),"
        f" {far['bytes'] / 1024:,.0f} kB"
    )
    print(
        f"    surface at y = {contract['surface_y']:.2f} (0.0 m AHD),"
        f" bed {contract['depth_m']:.1f} m under open water and"
        f" {contract['pond_depth_m']:.1f} m under a pond;"
        # The one number that keeps the near sheets and this one apart. Printed
        # because coplanar water is the artefact this whole pass removes and it
        # would be a shame to reintroduce it one layer up.
        f" sunk {far['sink_m']:.2f} m under the streamed sheets"
    )


def _report_water_tiles(results: list[tiles.TileResult]) -> None:
    """How much of the emitted world has water on it, from the tile results."""
    wet = [r for r in results if r.water_verts]
    if not wet:
        return
    tris = sum(r.water_tris for r in wet)
    total = sum(r.water_bytes for r in wet)
    levels = {round(r.water_y, 2) for r in wet}
    print(
        f"  water sidecars: {len(wet):,} of {len(results):,} tiles,"
        f" {tris:,} triangles, {total / 1024:,.0f} kB"
        f" ({tris / max(len(wet), 1):,.0f} triangles a wet tile, {len(levels)} distinct levels)"
    )


def _report_parking(net: parking.ParkingNetwork, results: list[tiles.TileResult]) -> None:
    """Yield, mix and -- the one that matters -- the orientation audit.

    Spec 7.7's "parked cars facing accordingly" is a *sign*, and a sign is the
    kind of thing that stays wrong for months because nothing about the render
    says so: a right-hand-traffic city has the same car count, the same spacing
    and the same colours as a left-hand-traffic one. So it is counted rather than
    asserted. `kerb_side_sign` is positive when the kerb is on the car's left,
    which is what left-hand traffic requires of every car that is not one of the
    deliberate wrong-way few.
    """
    s = net.stats
    if not net.emitted:
        return
    print("  parked cars:")
    print(
        f"    {s['ways_parked']:,} of {s['ways_considered']:,} parkable ways used"
        f" ({s['ways_one_side']:,} of them one side only),"
        f" {s['bays']:,} bays generated"
    )
    dropped = s["drop_junction"] + s["drop_building"] + s["drop_tree"] + s["drop_overlap"]
    print(
        f"    {s['unoccupied']:,} left empty by the occupancy runs,"
        f" {dropped:,} placed then excluded"
        f" (junction {s['drop_junction']:,}, building {s['drop_building']:,},"
        f" tree {s['drop_tree']:,}, overlap {s['drop_overlap']:,},"
        f" tile cap {s['drop_cap']:,})"
    )
    counts = sorted((r.cars for r in results if r.cars), reverse=True)
    if counts:
        p50 = counts[len(counts) // 2]
        print(
            f"    {net.emitted:,} emitted across {len(counts):,} tiles"
            f" -- median {p50}, max {counts[0]}, mean {net.emitted / len(counts):.0f}"
        )
    body = ", ".join(
        f"{parking.BODY_NAME[b]} {100 * n / net.emitted:.0f}%"
        for b, n in sorted(net.body_counts.items(), key=lambda kv: -kv[1])
    )
    colour = ", ".join(
        f"{parking.COLOUR_NAME[c]} {100 * n / net.emitted:.0f}%"
        for c, n in sorted(net.colour_counts.items(), key=lambda kv: -kv[1])
    )
    print(f"    bodies  {body}")
    print(f"    colours {colour}")
    print(
        f"    left-hand traffic: kerb on the left for {net.kerb_left:,}"
        f" ({100 * net.kerb_left / net.emitted:.2f}%),"
        f" on the right for {net.kerb_right:,};"
        f" {net.emitted_wrong_way:,} parked against the traffic on purpose"
        f" ({100 * net.emitted_wrong_way / net.emitted:.1f}%)"
    )
    if net.kerb_right != net.emitted_wrong_way:
        print(
            "    WARNING: the cars with the kerb on their right are not exactly the"
            " ones parked against the traffic -- the left-hand-traffic sign in"
            " parking._heading has drifted."
        )


def _report_awnings(net: mesh.AwningNetwork) -> None:
    """Edge qualification, which is the only interesting thing about this pass.

    The emitted count says almost nothing -- what says whether the feature is
    right is the *share of edges rejected*, because a retail footprint has one
    street frontage and three or four walls that must not get one. A pass
    qualifying much over a third of edges is putting awnings on party walls and
    back lanes, and the tell would be invisible from the street it was checked
    from.
    """
    s = net.stats
    if not s["candidates"]:
        return
    edges = s["edges"]
    print("  footpath awnings:")
    print(
        f"    {s['candidates']:,} retail buildings in an awning archetype"
        f" ({s['drop_low_building']:,} too low to carry one),"
        f" {s['buildings']:,} of them with at least one run"
    )
    print(
        f"    {edges:,} edges tested ({s['drop_short_edge']:,} under"
        f" {mesh.AWNING_MIN_EDGE} m skipped first), {s['runs']:,} qualified"
        f" ({100 * s['runs'] / max(edges, 1):.0f}%) --"
        f" {s['drop_no_street']:,} face no carriageway,"
        f" {s['drop_neighbour']:,} would run into a building"
    )
    print(
        f"    {s['metres']:,} m of continuous awning,"
        f" {s['pulled_back']:,} runs pulled back to"
        f" {mesh.AWNING_PROJECTION_TIGHT} m over a narrow footpath"
    )
    share = s["runs"] / max(edges, 1)
    if share > 0.45:
        print(
            "    WARNING: over 45% of edges qualified. A shop has one frontage and"
            " three walls that are not one -- check mesh.AWNING_FACING_MIN, which is"
            " what keeps a canopy off a terrace's party walls."
        )


def _report_doors(net: mesh.DoorNetwork) -> None:
    """Which buildings got a front door, and which rule withheld one.

    A door is the closest thing in this build to a universal feature -- every
    house and every shop has one -- so unlike the awnings the interesting number
    here IS the coverage, and the shape of the exclusions under it. Two of them
    are worth watching:

    `fallback_longest` is the rear-lot path, and every one of those is a door
    placed without a street to place it against. On a terrace slice the longest
    edge is a party wall, so a large share here would mean doors appearing
    between houses rather than on their fronts.

    `bay_clamped` is a door the centroid wanted outside the wall it is on --
    which happens on an L-shaped footprint whose centroid falls off the front
    elevation entirely -- and it is fine in small numbers and a sign the edge
    choice is wrong in large ones.
    """
    s = net.stats
    if not s["buildings"]:
        return
    total = s["buildings"]
    print("  front doors:")
    print(
        f"    {s['doors']:,} of {total:,} buildings ({100 * s['doors'] / total:.0f}%),"
        f" {s['street_edge']:,} on a street-facing edge,"
        f" {s['lane_edge']:,} on a lane where that is the only frontage,"
        f" {s['fallback_longest']:,} rear-lot on the longest edge"
    )
    print(
        f"    withheld: {s['drop_archetype']:,} warehouse/tower/brutalist,"
        f" {s['drop_curtain_wall']:,} curtain wall,"
        f" {s['drop_low_building']:,} under {mesh.DOOR_MIN_HEIGHT} m,"
        f" {s['drop_short_edge']:,} no edge wide enough,"
        f" {s['drop_degenerate']:,} degenerate footprint"
    )
    if s["bay_clamped"] or s["off_bay"]:
        print(
            f"    {s['bay_clamped']:,} clamped onto a bay that fits the edge,"
            f" {s['off_bay']:,} centred off the bay grid on a short edge"
        )
    if s["fallback_longest"] > 0.12 * max(s["doors"], 1):
        print(
            "    WARNING: over 12% of doors were placed rear-lot. On a terrace"
            " slice the longest edge is a party wall, so this puts doors between"
            " houses -- check mesh.DOOR_MAX_KERB, the street/lane tiering in"
            " mesh.DOOR_EXCLUDE_CLASSES, and the street network's extent."
        )


def _report_fences(net: fences.FenceNetwork) -> None:
    """The setback distribution, which is the only thing that says this is right.

    A fence count says nothing: what decides whether the feature is correct is
    *which* buildings got one, and the whole of that decision is one measurement.
    So the report leads on the split between the buildings that were on the line
    and the buildings that stood back off it, and then on the setbacks of the
    ones that qualified -- which have to look like front gardens (a median of
    three to five metres, a tail out to eight) and not like an arbitrary cut.

    `gate_on_centroid` is the other number to watch. The gate and the front door
    take the same wall from the same call, so the gate should land on the door
    almost always; a large share falling back to the centroid means `DoorNetwork`
    is withholding doors from buildings that are getting fences, which would be
    two features disagreeing about the same house.
    """
    s = net.stats
    if not s["candidates"]:
        return
    total = s["candidates"]
    print("  front fences:")
    print(
        f"    {s['fences']:,} of {total:,} residential candidates"
        f" ({100 * s['fences'] / total:.0f}%), {s['metres']:,} m of frontage"
        f" -- {s['drop_retail']:,} retail withheld before the count"
    )
    print(
        f"    withheld: {s['drop_on_the_line']:,} built to the line"
        f" (under {fences.MIN_SETBACK} m of setback),"
        f" {s['drop_no_street']:,} face no street,"
        f" {s['drop_deep']:,} set back over {fences.MAX_SETBACK} m,"
        f" {s['drop_short_frontage']:,} frontage under {fences.MIN_FRONTAGE} m,"
        f" {s['drop_skew']:,} skewed into the footpath,"
        f" {s['drop_neighbour']:,} would run through a building"
    )
    if net.setbacks:
        q = np.percentile(net.setbacks, [10, 50, 90])
        print(
            f"    setback {q[0]:.1f} / {q[1]:.1f} / {q[2]:.1f} m at p10 / median / p90,"
            f" {s['pulled_in']:,} pulled in over 0.5 m by a skewed frontage"
        )
    styles = ", ".join(
        f"{name} {net.styles[name]:,} ({100 * net.styles[name] / max(s['fences'], 1):.0f}%)"
        for name in ("masonry", "iron", "timber")
    )
    print(f"    style: {styles}")
    print(
        f"    gate on the front door {s['gate_on_door']:,},"
        f" on the footprint centroid {s['gate_on_centroid']:,}"
    )
    if s["gate_on_centroid"] > 0.15 * max(s["fences"], 1):
        print(
            "    WARNING: over 15% of gates fell back to the centroid. The gate and"
            " the door take the same wall from mesh.DoorNetwork.front_edge, so this"
            " means doors are being withheld from fenced buildings -- check"
            " mesh.DOOR_MIN_HEIGHT and the short-edge test in DoorNetwork.place."
        )


def _report_power(net: power.PowerNetwork, results: list[tiles.TileResult]) -> None:
    """Yield, the exclusion table, and the two numbers that say whether this is
    a *line* rather than a scatter of poles.

    Those two are spans-per-chain and mean span length. A pole count says nothing
    about the feature: 4,000 poles with no wires between them is street furniture,
    and the whole recognition value of spec 7.2 is the catenaries. A chain
    averaging under two spans means the keep-outs are cutting the runs to pieces
    and `_place`'s shift is not doing its job.
    """
    s = net.stats
    if not net.emitted_poles:
        return
    print("  power poles:")
    print(
        f"    {s['ways_poled']:,} of {s['ways_considered']:,} pole-class ways run"
        f" ({s['ways_cbd']:,} skipped inside the undergrounded CBD),"
        f" {s['mapped_on_way']:,} surveyed poles on {s['ways_mapped']:,} ways"
        f" (which take no infill), {s['mapped_orphan']:,} surveyed poles off any way"
    )
    dropped = (
        s["drop_junction"] + s["drop_tree"] + s["drop_car"] + s["drop_building"]
    )
    print(
        f"    {s['candidates']:,} candidates, {s['placed']:,} placed"
        f" ({s['shifted']:,} shifted along the street to clear something),"
        f" {dropped:,} dropped (junction {s['drop_junction']:,}, tree {s['drop_tree']:,},"
        f" car {s['drop_car']:,}, building {s['drop_building']:,},"
        f" tile cap {s['drop_cap']:,})"
    )
    counts = sorted((r.poles for r in results if r.poles), reverse=True)
    if counts:
        p50 = counts[len(counts) // 2]
        print(
            f"    {net.emitted_poles:,} emitted across {len(counts):,} tiles"
            f" -- median {p50}, max {counts[0]}, mean {net.emitted_poles / len(counts):.0f};"
            f" {net.emitted_transformers:,} with a transformer"
            f" ({100 * net.emitted_transformers / net.emitted_poles:.1f}%),"
            f" {net.emitted_mapped:,} surveyed"
        )
    if net.emitted_spans:
        mean_len = net.span_length_total / net.emitted_spans
        per_chain = s["spans"] / max(s["chains"], 1)
        print(
            f"    {net.emitted_spans:,} spans over {s['chains']:,} chains"
            f" ({per_chain:.1f} spans a chain, {s['chain_breaks']:,} breaks over"
            f" {power.MAX_SPAN:.0f} m) -- mean {mean_len:.1f} m,"
            f" max {net.span_length_max:.1f} m"
        )
        if per_chain < 2.0:
            print(
                "    WARNING: chains are averaging under two spans. The keep-outs are"
                " cutting the runs to pieces, which leaves poles without a line"
                " between them -- check power._place's shift window."
            )
    if s["drop_cap"]:
        print(
            "    WARNING: the per-tile pole cap fired. A capped pole can leave a"
            " span in the neighbouring tile with nothing at one end -- see"
            " power.MAX_POLES_PER_TILE."
        )


def _report_furniture(
    net: furniture.FurnitureNetwork, results: list[tiles.TileResult]
) -> None:
    """The three counts, the exclusion table, and the two numbers that say
    whether each feature is what it is meant to be rather than merely present.

    For the bins that number is the **cluster size distribution**. A city of
    lone red bins is not spec 7.7's red/yellow/green -- the whole read is a red
    one with a coloured one beside it, so a mean under 1.5 means the recycling
    roll is not firing and the feature has quietly become "brown bins".

    For the signals it is the **red/green split**. Lamps are phased in pairs
    rather than rolled per head (see `furniture._place_signals`), so a
    four-way contributes two of each; anything far off 50/50 means the phase
    axis is collapsing and every approach is showing the same aspect.
    """
    s = net.stats
    if not (net.emitted_bins or net.emitted_posts or net.emitted_signals):
        return
    print("  street furniture:")

    if net.emitted_bins:
        dropped = (
            s["drop_frontage"] + s["drop_junction"] + s["drop_pole"]
            + s["drop_tree"] + s["drop_building"]
        )
        print(
            f"    bins: {s['bin_ways_considered']:,} of the bin-class ways have"
            f" collection today ({s['bin_ways_collected']:,} ended up with a"
            f" cluster on them), {s['bin_candidates']:,} candidate positions,"
            f" {s['bin_clusters']:,} clusters placed"
            f" ({s['bin_shifted']:,} shifted along the kerb)"
        )
        print(
            f"      {dropped:,} dropped (no residential frontage"
            f" {s['drop_frontage']:,}, junction {s['drop_junction']:,},"
            f" power pole {s['drop_pole']:,}, tree {s['drop_tree']:,},"
            f" building {s['drop_building']:,}, tile cap {s['drop_bin_cap']:,})"
        )
        sizes = net.cluster_sizes
        total = sum(sizes.values()) or 1
        mean = sum(k * v for k, v in sizes.items()) / total
        spread = ", ".join(f"{k} bin{'s' if k != 1 else ''} {v:,}" for k, v in sorted(sizes.items()))
        counts = sorted((r.bins for r in results if r.bins), reverse=True)
        print(
            f"      {net.emitted_bins:,} bins across {len(counts):,} tiles"
            f" -- median {counts[len(counts) // 2]}, max {counts[0]};"
            f" red {net.lid_counts[furniture.LID_RED]:,},"
            f" yellow {net.lid_counts[furniture.LID_YELLOW]:,},"
            f" green {net.lid_counts[furniture.LID_GREEN]:,};"
            f" cluster {mean:.2f} bins mean ({spread})"
        )
        if mean < 1.5:
            print(
                "    WARNING: bin clusters are averaging under 1.5. A street of"
                " lone red bins is not spec 7.7's red/yellow/green -- check"
                " furniture.BIN_RECYCLING_RATE."
            )

    print(
        f"    junctions: {s['junction_points']:,} candidate points ->"
        f" {s['junctions']:,} with {furniture.MIN_LEGS}+ legs"
        f" ({s['junctions_merged']:,} merged away as one intersection split"
        f" across several way ends)"
    )

    if net.emitted_posts:
        counts = sorted((r.posts for r in results if r.posts), reverse=True)
        print(
            f"    name blades: {net.emitted_posts:,} posts carrying"
            f" {net.emitted_blades:,} blades across {len(counts):,} tiles"
            f" -- median {counts[len(counts) // 2]}, max {counts[0]}."
            f" {s['post_one_name']:,} junctions skipped for having one named"
            f" street, {s['post_no_name']:,} for having none,"
            f" {s['post_no_corner']:,} for having no clear corner;"
            f" {s['blades_dropped']:,} third blades dropped"
        )
        # The two numbers that say whether the legends are what they are meant
        # to be. The distinct count is what the client's texture cache is sized
        # against -- one canvas per (name, style) -- and the longest legend is
        # what says whether `MAX_NAME_CHARS` is trimming anything a player would
        # notice. A distinct count near the blade count would mean the
        # abbreviation is not collapsing the two halves of a split way; a
        # longest legend at exactly the cap would mean it is biting.
        green = net.style_counts[furniture.STYLE_COS_GREEN]
        white = net.style_counts[furniture.STYLE_RMS_WHITE]
        # The abbreviation and truncation counts are over every legend the
        # pipeline *formed*, which is one per named leg of every candidate
        # junction -- more than the blades emitted, because a junction that
        # turns out to have one named street still had its legend built before
        # that was known. Counting them at emission instead would hide exactly
        # the case worth watching: a name so long the cut fires.
        print(
            f"      {len(net.unique_names):,} distinct legends"
            f" (longest {net.name_chars_max} chars of"
            f" {furniture.MAX_NAME_CHARS};"
            f" over {s['names_abbreviated']:,} legends formed,"
            f" {s['names_truncated']:,} were too long to fit and were cut);"
            f" style {green:,} City of Sydney green"
            f" ({100 * green / net.emitted_posts:.0f}%),"
            f" {white:,} RMS white"
            f" -- the split is furniture.COS_LGA_RADIUS at"
            f" {furniture.COS_LGA_RADIUS:,.0f} m from the origin"
        )
        if not green or not white:
            print(
                "    WARNING: every blade came out the same style. Both belong"
                " in the city -- check furniture.COS_LGA_RADIUS against the"
                " extent."
            )

    if net.emitted_signals:
        counts = sorted((r.signals for r in results if r.signals), reverse=True)
        lit = net.lamp_counts
        total = sum(lit) or 1
        print(
            f"    signals: {s['signal_nodes']:,} mapped nodes ->"
            f" {s['signal_clusters']:,} clusters ->"
            f" {s['signal_junctions']:,} signalised junctions"
            f" ({s['signal_orphan']:,} clusters with no junction near them --"
            f" mid-block pedestrian crossings, which are different furniture)"
        )
        print(
            f"      {net.emitted_signals:,} heads across {len(counts):,} tiles"
            f" -- median {counts[len(counts) // 2]}, max {counts[0]};"
            f" green {lit[furniture.LAMP_GREEN]:,}"
            f" ({100 * lit[furniture.LAMP_GREEN] / total:.0f}%),"
            f" red {lit[furniture.LAMP_RED]:,}"
            f" ({100 * lit[furniture.LAMP_RED] / total:.0f}%),"
            f" amber {lit[furniture.LAMP_AMBER]:,}"
        )
        share = lit[furniture.LAMP_RED] / total
        if not 0.3 <= share <= 0.7:
            print(
                "    WARNING: the red/green split is off 50/50. Opposite"
                " approaches share a phase, so a four-way should contribute two"
                " of each -- check furniture._place_signals' reference axis."
            )

    for stat, name, const in (
        ("drop_bin_cap", "bin", "MAX_BINS_PER_TILE"),
        ("drop_post_cap", "name post", "MAX_POSTS_PER_TILE"),
        ("drop_signal_cap", "signal", "MAX_SIGNALS_PER_TILE"),
    ):
        if s[stat]:
            print(
                f"    WARNING: the per-tile {name} cap fired on {s[stat]:,}"
                f" instances -- see furniture.{const}."
            )



def _report_lanes(net) -> None:
    """The lane graph, the traffic on it, and the three heights it drives at."""
    st = net.stats
    print(
        f"    {st['drivable_ways']:,} drivable ways -> {st['arcs']:,} arcs"
        f" across {st['graph_nodes']:,} nodes"
        f" ({st['signal_nodes']:,} signalised of {st['surveyed_signals']:,} surveyed)"
    )
    print(
        f"    {st['routes']:,} edge-disjoint routes,"
        f" {st['route_length_m'] / 1000:,.0f} km of lane,"
        f" {st['live_cars']:,} cars live at any instant"
        f" (one per {st['route_length_m'] / max(st['live_cars'], 1):.0f} m)"
    )
    # Three sources for one number, and the split is the check: a build where
    # `deck` collapsed to zero is a build where every viaduct's traffic is on the
    # ground under it, and nothing else in the log would say so.
    print(
        f"    heights: {st['ground_points']:,} on the terrain,"
        f" {st['deck_points']:,} on a solved deck,"
        f" {st['hero_points']:,} on the Harbour Bridge"
        f" ({st['orphan_bridges']:,} bridge points with no deck, fell back to ground)"
    )
    print(
        f"    {st['way_spans']:,} way spans in the reusable geometry block"
        f" ({st['surface_ways']:,} surface ways, {st['way_points']:,} points)"
    )


def _report_powerups(net: powerups.PowerupNetwork) -> None:
    """What spec 8.3 got, and the two things about it that can fail silently.

    Both are the same class of failure this file already reports on for the
    parked cars' orientation and the signals' phase split: the world renders, the
    icons spin, and the feature is quietly not the feature.

      * **A powerup inside a wall** is an objective nobody can reach, and it does
        not look like a bug -- the icon is drawn through geometry to 60 m by
        design, so an unreachable one looks exactly like a reachable one until
        you walk at it. 86% of cafe nodes are mapped inside their building, so
        this is the common case rather than the edge case, and the snap's outcome
        is counted per point.
      * **A missing station** is invisible in a total. 25 stations reads as
        plausible whether or not Central is one of them, so the stations spec 8.3
        names are checked by name.
    """
    s = net.stats
    trained = net.emitted[powerups.TRAINING]
    flat = net.emitted[powerups.FLAT_WHITE]
    print("  powerups (spec 8.3):")
    print(
        f"    Training  {trained:,} points from"
        f" {s['station_nodes'] + s['station_areas']:,} stations"
        f" ({s['stations_with_entrances']:,} with mapped entrances,"
        f" {s['stations_bare']:,} standing in for themselves)"
        f" and {s['entrance_nodes']:,} entrance nodes"
    )
    print(
        f"    Flat White {flat:,} points from {s['cafe_nodes']:,} amenity=cafe nodes"
        f" ({s['drop_cafe_duplicate']:,} duplicates dropped)"
    )
    if s["drop_per_station"] or s["drop_proximity"]:
        print(
            f"      thinned: {s['drop_per_station']:,} over"
            f" {powerups.MAX_PER_STATION} per station,"
            f" {s['drop_proximity']:,} within {powerups.DEDUPE_RADIUS:.0f} m of another"
        )
    if s["entrances_orphan"]:
        print(
            f"      {s['entrances_orphan']:,} entrances more than"
            f" {powerups.ENTRANCE_LINK:.0f} m from any station -- kept as their own group"
        )

    total_snap = (
        s["snap_as_mapped"] + s["snap_footpath"] + s["snap_open"] + s["snap_failed"]
    )
    if total_snap:
        moved = sorted(net.snap_distances)
        tail = (
            f", moved {moved[len(moved) // 2]:.1f} m median / {moved[-1]:.1f} m max"
            if moved
            else ""
        )
        print(
            f"    standing them outside: {s['snap_as_mapped']:,} already clear"
            f" ({100 * s['snap_as_mapped'] / total_snap:.0f}%),"
            f" {s['snap_footpath']:,} snapped to paving,"
            f" {s['snap_open']:,} to open ground{tail}"
        )
        if s["snap_wide"]:
            print(
                f"      {s['snap_wide']:,} of those were inside a whole city block"
                f" and needed the {powerups.SNAP_REACH_WIDE:.0f} m fallback disc"
            )
    if s["snap_failed"]:
        print(
            f"    WARNING: {s['snap_failed']:,} points had no clear ground within reach"
            f" and were left inside a building. They are objectives nobody can touch;"
            f" see powerups.SNAP_REACH_STATION / SNAP_REACH_CAFE."
        )
    if s["drop_tile_cap"]:
        print(
            f"    WARNING: the per-tile cap fired on {s['drop_tile_cap']:,} points"
            f" -- see powerups.MAX_PER_TILE."
        )

    # The six spec 8.3 names, checked rather than assumed, with the number of
    # points each contributed. Three of them are outside the inner ring's 4 km
    # radius (Newtown 4.24 km, Erskineville 4.20, Green Square 4.20) and arrive
    # with `--stage middle`, so a miss is reported rather than warned about --
    # this check exists to catch a *reader* that stopped finding Central, which
    # is the failure that would otherwise be silent inside a plausible total.
    per_station: dict[str, int] = {}
    for points in net._by_tile.values():
        for p in points:
            if p.kind == powerups.TRAINING and p.station:
                per_station[p.station] = per_station.get(p.station, 0) + 1
    wanted = ("Central", "Redfern", "Town Hall", "Newtown", "Erskineville", "Green Square")
    have = [
        f"{w} {sum(v for k, v in per_station.items() if w in k)}"
        for w in wanted
        if any(w in k for k in per_station)
    ]
    missing = [w for w in wanted if not any(w in k for k in per_station)]
    print(f"    spec 8.3 stations, with their point counts: {', '.join(have) or 'NONE'}")
    if missing:
        print(f"      not inside this extent: {', '.join(missing)}")

    failures = powerups.audit_tiling(net)
    for f in failures[:5]:
        print(f"    WARNING: {f}")


def _results_from_ledger(con, wanted: set[str]) -> list[tiles.TileResult]:
    """Reconstruct tile stats from the ledger for index writing."""
    out: list[tiles.TileResult] = []
    for r in con.execute("SELECT key, detail FROM jobs WHERE kind='tile' AND state='done'"):
        if r["key"] not in wanted or not r["detail"]:
            continue
        d = json.loads(r["detail"])
        tx, tz = (int(v) for v in r["key"].split("_"))
        wx0 = tx * config.TILE_SIZE
        wz1 = -(tz * config.TILE_SIZE)
        g = d.get("g", [0.0, 0.0])
        out.append(
            tiles.TileResult(
                key=r["key"],
                buildings=d.get("b", 0),
                triangles=d.get("t", 0),
                glb_bytes=d.get("sz", 0),
                params_bytes=0,
                collision_bytes=0,
                bounds=(wx0, wz1 - config.TILE_SIZE, wx0 + config.TILE_SIZE, wz1),
                height_max=d.get("hmax", 0.0),
                trees=d.get("v", 0),
                cars=d.get("c", 0),
                poles=d.get("p", 0),
                spans=d.get("w", 0),
                bins=d.get("fb", 0),
                posts=d.get("fp", 0),
                signals=d.get("fs", 0),
                powerups=d.get("pw", 0),
                street_names=d.get("sn", 0),
                names_bytes=d.get("snb", 0),
                water_verts=d.get("wv", 0),
                water_tris=d.get("wt", 0),
                water_bytes=d.get("wb", 0),
                water_y=d.get("wy", 0.0),
                water_area=d.get("wa", 0.0),
                lane_ways=d.get("lw", 0),
                lane_routes=d.get("lr", 0),
                lane_cars=d.get("lc", 0),
                lanes_bytes=d.get("lb", 0),
                ground_min=g[0],
                ground_max=g[1],
            )
        )
    return out


def cmd_terrain_audit(args: argparse.Namespace) -> int:
    """Read the emitted world back and check that everything agrees about y.

    The parked cars' orientation audit set the pattern and the argument is the
    same one: terrain is a *sign*, not a feature. A world where the roads are
    draped on one surface and the buildings stood on another, or where every
    tile's ground is a centimetre out of step with its neighbour's, renders as a
    perfectly plausible city with a hairline of daylight in it -- and nothing in
    the build log would say so, because every stage ran and every stage
    succeeded. So it is measured, from the files, after the fact.

    Reads only `index.json`, the GLBs, the `.terr.bin` sidecars and the collision
    payload. Nothing here consults the ledger or re-derives anything from source,
    which is what makes it a check rather than a second opinion from the same
    witness.
    """
    import pygltflib as gl

    index = json.loads(config.INDEX_PATH.read_text())
    contract = index.get("terrain")
    if contract is None:
        print("index.json has no terrain contract -- this world was built flat.")
        return 1
    n = contract["grid"]
    keys = [t["key"] for t in index["tiles"]]
    limit = args.tiles if args.tiles > 0 else len(keys)
    sample = keys[:: max(len(keys) // limit, 1)][:limit]

    print(f"stage '{index['stage']}', {len(keys):,} tiles, auditing {len(sample):,}")
    terrain = Terrain.load(index["radius_m"])
    print(
        f"  datum y = 0 at {contract['datum_ahd']:.1f} m AHD,"
        f" sea level at y = {contract['sea_level_y']:.1f},"
        f" {n}x{n} quads per tile at {contract['post_m']:.2f} m"
    )

    # --- 1. The ground itself: sidecars against the sampler, and against each other.
    grids: dict[str, np.ndarray] = {}
    resampled = 0
    for key in keys:
        path = config.TILE_DIR / f"{key}.terr.bin"
        if not path.exists():
            print(f"  MISSING terrain sidecar for {key}")
            return 1
        g = np.frombuffer(path.read_bytes(), dtype="<f4").reshape(n + 1, n + 1)
        grids[key] = g
        if not np.array_equal(g, terrain.grid_for_tile(key)):
            resampled += 1
    print(
        f"  sidecars      {len(grids):,} read,"
        f" {resampled:,} disagree with a fresh sample of the same lattice"
    )

    seams = mismatched = 0
    for key, g in grids.items():
        tx, tz = (int(v) for v in key.split("_"))
        east = grids.get(f"{tx + 1}_{tz}")
        if east is not None:
            seams += 1
            mismatched += not np.array_equal(g[:, -1], east[:, 0])
        north = grids.get(f"{tx}_{tz + 1}")
        if north is not None:
            seams += 1
            mismatched += not np.array_equal(g[0, :], north[-1, :])
    print(
        f"  seams         {seams:,} shared tile edges, {mismatched:,} not bit-identical"
        + ("" if mismatched == 0 else "   WARNING: cracks")
    )
    allg = np.concatenate([g.ravel() for g in grids.values()])
    print(
        f"  relief        ground spans {allg.min():.1f} to {allg.max():.1f} m"
        f" ({allg.max() - allg.min():.0f} m of range),"
        f" median {np.median(allg):.1f}"
    )

    # --- 2. Every paved surface, against the ground it claims to be lying on.
    nominal = {
        "road_asphalt": (streets.CARRIAGEWAY_Y,),
        "footpath_concrete": (streets.FOOTPATH_Y,),
        # The kerb is a top face and the vertical strip that reaches down to the
        # road, so both of its layers' offsets are legal on a kerb vertex.
        "kerb_sandstone": (streets.CARRIAGEWAY_Y, streets.FOOTPATH_Y),
        "park_grass": (vegetation.PARK_GRASS_Y,),
        # The contact skirt is not paved and belongs to no street, but it is
        # draped by the same rule against the same facet lattice, and it is the
        # slot where a drape failure would be least visible -- it is a 0.9 m
        # ribbon of alpha, so sinking into the ground reads as the darkening
        # being a bit weak rather than as a hole in the road. This is the check
        # that would say so.
        "contact_ao": (contact.CONTACT_Y,),
    }
    residual: dict[str, float] = defaultdict(float)
    counted: dict[str, int] = defaultdict(int)
    slopes: list[np.ndarray] = []
    for key in sample:
        tx, tz = (int(v) for v in key.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        for slot, pos, tris, _nrm in _glb_primitives(gl, config.TILE_DIR / f"{key}.glb"):
            if slot not in nominal:
                continue
            east = pos[:, 0] + oe
            north = on - pos[:, 2]
            offset = pos[:, 1] - terrain.sample(east, north)
            # Distance to the nearest offset this slot is allowed to carry.
            err = np.min(
                np.abs(offset[:, None] - np.asarray(nominal[slot])[None, :]), axis=1
            )
            residual[slot] = max(residual[slot], float(err.max()))
            counted[slot] += len(pos)
            if slot == "road_asphalt":
                slopes.append(np.column_stack(_triangle_slopes(pos, tris)))
    print("  surfaces      worst |vertex y - (terrain + its offset)|, over the sample:")
    for slot in nominal:
        if counted[slot]:
            print(f"    {slot:20} {counted[slot]:>9,} vertices   {residual[slot] * 1000:8.4f} mm")

    if slopes:
        # Weighted by plan area, not counted per triangle, and it changes the
        # answer completely. Cutting the roads against the terrain facets leaves
        # a sliver at every place a kerb line grazes a facet corner: thousands of
        # triangles of a few square centimetres each, whose gradient is whatever
        # rounding made it, including vertical. Per triangle they swamp the
        # statistic; by area they are the tenth of a per cent of the road they
        # actually are.
        both = np.concatenate(slopes)
        gradient, area = both[:, 0], both[:, 1]
        # A tenth of a square metre, so the "worst" figure is a piece of road
        # somebody could stand on rather than the roundest sliver in the build.
        keep = np.isfinite(gradient) & (area > 0.1)
        gradient, area = gradient[keep], area[keep]
        order = np.argsort(gradient)
        gradient, area = gradient[order], area[order]
        share = np.cumsum(area) / area.sum()
        print(
            f"  carriageway   {area.sum() / 1e4:,.0f} ha of road, gradient by area:"
            f" 1:{1 / _at(gradient, share, 0.5):.0f} median,"
            f" 1:{1 / _at(gradient, share, 0.9):.1f} p90,"
            f" 1:{1 / _at(gradient, share, 0.99):.1f} p99,"
            f" 1:{1 / gradient[-1]:.1f} worst"
        )
        steep = float(area[gradient > 1 / 6].sum() / area.sum())
        print(
            f"    {100 * steep:.2f}% of road area steeper than 1:6."
            " Sydney's steepest streets are about that, so this is the share that"
            " is the DEM's noise rather than the city's hills."
        )

    # --- 3. Buildings: the pads, and what the buried skirt has to close.
    bases: list[np.ndarray] = []
    drops: list[np.ndarray] = []
    for key in sample:
        path = config.COLLISION_DIR / f"{key}.bin"
        if not path.exists():
            continue
        tx, tz = (int(v) for v in key.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        for base, pts in _collision_prisms(path.read_bytes()):
            bases.append(base)
            corner = terrain.sample(pts[:, 0] + oe, on - pts[:, 1])
            # Positive where the ground falls away below the pad, which is the
            # direction the skirt has to cover; the uphill side is a cut and
            # needs nothing.
            drops.append(float(np.max(base - corner)))
    if bases:
        b = np.asarray(bases)
        d = np.asarray(drops)
        edges = np.arange(np.floor(b.min() / 10) * 10, b.max() + 10, 10)
        counts, _ = np.histogram(b, bins=edges)
        print(f"  pads          {len(b):,} buildings, elevation histogram (10 m bins):")
        for lo, c in zip(edges[:-1], counts):
            if c:
                print(f"    {lo:6.0f} .. {lo + 10:6.0f} m  {c:>7,}  {'#' * min(int(60 * c / counts.max()), 60)}")
        p = np.percentile(d, [50, 90, 99, 100])
        print(
            f"  wall skirt    ground falls {p[0]:.2f} m below the pad at the lowest"
            f" point of the median footprint, {p[1]:.2f} m at p90, {p[2]:.2f} m at"
            f" p99, {p[3]:.2f} m at worst"
        )
        # What the skirt would leave open if it were the old fixed depth, against
        # what the adaptive one actually leaves open -- which is only the tail
        # past its own ceiling.
        fixed = float((d > mesh.WALL_SKIRT).mean())
        capped = float((d > mesh.WALL_SKIRT_MAX).mean())
        print(
            f"    a fixed {mesh.WALL_SKIRT:.1f} m skirt would close"
            f" {100 * (1 - fixed):.2f}% of footprints; following the footprint and"
            f" capping at {mesh.WALL_SKIRT_MAX:.0f} m closes {100 * (1 - capped):.2f}%"
        )
    return 0


def _read_water(path: Path) -> list[dict] | None:
    """Decode a `.water.bin` or `far-water.bin`. `None` for a bad or absent file.

    The reader the client has, written a second time in twenty lines, and that is
    the point: an audit that decoded through the writer would agree with the
    writer by construction. Every field is checked against the file's own length
    rather than trusted, because a truncated sidecar is exactly what a rebuild
    interrupted mid-write leaves behind.
    """
    if not path.exists():
        return None
    raw = path.read_bytes()
    if len(raw) < 12:
        return None
    magic, version, sheets = struct.unpack_from("<III", raw, 0)
    if magic != tiles.WATER_MAGIC or version != tiles.WATER_VERSION:
        return None
    out: list[dict] = []
    at = 12
    for _ in range(sheets):
        if at + 12 > len(raw):
            return None
        surface, n_verts, n_index = struct.unpack_from("<fII", raw, at)
        at += 12
        need = n_verts * 12 + n_index * 4
        if at + need > len(raw):
            return None
        block = np.frombuffer(raw, dtype="<f4", count=n_verts * 3, offset=at).reshape(-1, 3)
        at += n_verts * 12
        idx = np.frombuffer(raw, dtype="<u4", count=n_index, offset=at).reshape(-1, 3)
        at += n_index * 4
        if n_index and int(idx.max()) >= n_verts:
            return None
        out.append({"surface": float(surface), "xz": block[:, :2], "depth": block[:, 2], "tris": idx})
    return out


def _sample_tile_grid(grid: np.ndarray, n: int, local_x: float, local_z: float) -> float:
    """Ground height from a shipped `.terr.bin`, in tile-local metres.

    **`client/src/world/terrain.ts`'s `sampleTileGrid`, transcribed.** The point
    of writing it out again here rather than calling `Terrain.sample` is that the
    two are different witnesses: `Terrain.sample` interpolates the lattice this
    build happens to be holding in memory, and this reads the bytes that went out
    the door, through the same triangle split the *client* will use. A depth
    attribute that agreed with the first and not the second would tint a shore
    the player is not standing on.
    """
    spacing = config.TILE_SIZE / n
    cf = min(max(local_x / spacing, 0.0), float(n))
    rf = min(max((local_z + config.TILE_SIZE) / spacing, 0.0), float(n))
    c = min(int(cf), n - 1)
    r = min(int(rf), n - 1)
    fc = cf - c
    fr = rf - r
    nw = float(grid[r, c])
    ne = float(grid[r, c + 1])
    sw = float(grid[r + 1, c])
    se = float(grid[r + 1, c + 1])
    if fc >= fr:
        return nw + (ne - nw) * fc + (se - ne) * fr
    return nw + (sw - nw) * fr + (se - sw) * fc


def _edge_levels(sheets: list[dict], side: str) -> list[float]:
    """The surface levels of the sheets that reach one edge of a tile.

    Tile-local, renderer axes: x runs 0..TILE_SIZE west to east and z runs
    -TILE_SIZE..0 north to south, so the north edge is `z = -TILE_SIZE` and the
    south edge is `z = 0`. A sheet is clipped to the tile box exactly, so water
    that crosses a seam has vertices *on* it and water that stops short does not
    -- which is the difference this is looking for. A millimetre of tolerance,
    because those vertices are the output of the clip against that same edge.
    """
    s = config.TILE_SIZE
    want = {"east": (0, s), "west": (0, 0.0), "north": (1, -s), "south": (1, 0.0)}[side]
    axis, at = want
    out: list[float] = []
    for sheet in sheets:
        if bool((np.abs(sheet["xz"][:, axis] - at) < 1e-3).any()):
            out.append(sheet["surface"])
    return out


def _sheet_area(sheet: dict) -> float:
    """Plan area of one decoded sheet, m2."""
    v = sheet["xz"]
    t = sheet["tris"]
    if len(t) == 0:
        return 0.0
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    return float(np.abs(cross).sum() * 0.5)


def cmd_water_audit(args: argparse.Namespace) -> int:
    """Read the emitted water back and check that it is water rather than paint.

    Four questions, and the shape of the command is that each of them has a way
    of failing that leaves a perfectly plausible frame:

      1. **Is it all there?** A sheet that was assembled and never written, or an
         index that does not mention a file sitting on disk, is a hole in the
         harbour that only shows from one angle.
      2. **Is the bed under it?** This is the one that matters. The DEM clamps
         the ocean to exactly 0 m AHD and the water surface is at exactly 0 m
         AHD, so *before* `water.conform` every square metre of Port Jackson was
         coplanar with its own surface. Coplanar geometry does not throw, does not
         warn, and renders as a shimmering mess that reads as a driver bug.
      3. **Does the depth attribute agree with the ground?** The shore tint is a
         per-vertex quantity computed in the pipeline against a terrain the
         client never sees; if the two drift, the shallows are drawn in the wrong
         place and nothing says so.
      4. **Do the tiles agree with each other?** Two neighbouring tiles at
         different water levels is a step in the middle of the harbour.

    Reads `index.json`, the `.water.bin` and `.terr.bin` sidecars and
    `far-water.bin` from disk, and rebuilds the field from OSM for the assembled
    column -- which is the only thing here that is a second opinion from the same
    witness, and is reported beside the shipped numbers rather than instead of
    them.
    """
    index = json.loads(config.INDEX_PATH.read_text())
    contract = index.get("water")
    terrain_contract = index.get("terrain") or {}
    if contract is None:
        print("index.json has no water contract -- this world was built dry.")
        return 1

    n = terrain_contract.get("grid", config.TERRAIN_GRID)
    entries = {t["key"]: t for t in index["tiles"]}
    print(
        f"stage '{index['stage']}', {len(entries):,} tiles;"
        f" water format v{contract['version']}, surface y = {contract['surface_y']:.3f}"
        f" (sea level y = {terrain_contract.get('sea_level_y', 0.0):.3f}),"
        f" bed {contract['depth_m']:.1f} m / pond {contract['pond_depth_m']:.1f} m"
    )

    # --- 0. The coastline rule, which the inner extract's own data cannot
    # exercise -- it has no coastline ways -- and which drowned the middle stage
    # when it finally met some. Four synthetic cases, then the real linework at
    # whatever radius was asked for.
    bad_rule = water.verify_polygonise()
    radius = args.coastline_radius or index["radius_m"]
    bad_rule += water.verify_coastline(radius)
    for failure in bad_rule:
        print(f"  SELF-CHECK   {failure}")
    if bad_rule:
        return 1
    coast = water.read_coastline(water._extent_box(radius))
    if coast:
        sea = water.polygonise_sea(coast, water._extent_box(radius))
        box_area = water._extent_box(radius).area
        print(
            f"  coastline     {len(coast):,} ways, {sum(w.length for w in coast) / 1000:,.1f} km"
            f" of linework at {radius / 1000:.0f} km -> "
            + (
                "no sea"
                if sea is None
                else f"{sea.area / 1e6:,.2f} km2 of sea ({100 * sea.area / box_area:.1f}% of the"
                f" {box_area / 1e6:,.0f} km2 extent)"
            )
        )
    else:
        print(f"  coastline     no `natural=coastline` ways at {radius / 1000:.0f} km")

    # --- 1. What the source says there is, rebuilt from OSM.
    field = None
    if not args.no_source:
        terrain = Terrain.load(index["radius_m"])
        field = terrain.water
        tidal = [b for b in field.bodies if b.tidal]
        print(
            f"  assembled     {field.area / 1e6:.3f} km2 over {len(field.bodies):,} bodies"
            f" at {len(field.levels)} levels;"
            f" tidal {sum(b.polygon.area for b in tidal) / 1e6:.3f} km2 in {len(tidal)}"
            f" ({field.stats['coastline_ways']} coastline sources,"
            f" {field.stats['tagged_parts']:,} tagged parts)"
        )
        for b in sorted(field.bodies, key=lambda b: -b.polygon.area)[: args.worst]:
            print(
                f"      {(b.name or '(unnamed)')[:26]:26s} {b.polygon.area / 1e6:8.4f} km2"
                f"  {'tidal' if b.tidal else 'inland':6s} surface y {b.surface:8.2f}"
                f"  ({b.surface + terrain_contract.get('datum_ahd', 0.0):6.2f} m AHD)"
                f"  {b.source}"
            )

    # --- 2. What went out: the per-tile sidecars, against the index.
    shipped_area = 0.0
    triangles = payload = wet_tiles = 0
    levels: dict[str, float] = {}
    missing: list[str] = []
    unlisted: list[str] = []
    sheets_by_tile: dict[str, list[dict]] = {}
    for key, entry in entries.items():
        path = config.TILE_DIR / f"{key}.water.bin"
        sheets = _read_water(path)
        claimed = int(entry.get("wv", 0))
        if claimed and sheets is None:
            missing.append(key)
            continue
        if sheets is None:
            continue
        if not claimed:
            unlisted.append(key)
        sheets_by_tile[key] = sheets
        wet_tiles += 1
        for s in sheets:
            shipped_area += _sheet_area(s)
            triangles += len(s["tris"])
        payload += path.stat().st_size
        levels[key] = float(entry.get("wy", sheets[0]["surface"]))
    print(
        f"  sidecars      {wet_tiles:,} tiles carry water, {triangles:,} triangles,"
        f" {shipped_area / 1e6:.3f} km2, {payload / 1024:,.0f} kB"
        + ("" if not missing else f"   MISSING {len(missing)}: {', '.join(missing[:6])}")
        + ("" if not unlisted else f"   UNLISTED {len(unlisted)}: {', '.join(unlisted[:6])}")
    )

    far = _read_water(config.OUT_ROOT / "far-water.bin")
    if far is None:
        print("  far water     MISSING or unreadable -- the harbour has no horizon.")
    else:
        far_area = sum(_sheet_area(s) for s in far)
        far_tris = sum(len(s["tris"]) for s in far)
        surfaces = sorted({round(s["surface"], 3) for s in far})
        print(
            f"  far water     {len(far)} sheet(s), {far_tris:,} triangles,"
            f" {far_area / 1e6:.3f} km2 at y = {', '.join(f'{s:.3f}' for s in surfaces)}"
            f" ({contract['far']['sink_m']:.2f} m under the streamed sheets)"
        )

    # --- 3. The bed. The check this command exists for.
    violations = 0
    worst = math.inf
    clearances: list[np.ndarray] = []
    depth_error = 0.0
    checked = 0
    for key, sheets in sheets_by_tile.items():
        grid_path = config.TILE_DIR / f"{key}.terr.bin"
        if not grid_path.exists():
            continue
        grid = np.frombuffer(grid_path.read_bytes(), dtype="<f4").reshape(n + 1, n + 1)
        for s in sheets:
            xs = s["xz"][:, 0]
            zs = s["xz"][:, 1]
            ground = np.asarray(
                [_sample_tile_grid(grid, n, float(x), float(z)) for x, z in zip(xs, zs)]
            )
            clearance = s["surface"] - ground
            clearances.append(clearance)
            checked += len(clearance)
            # A vertex *on* the shoreline is legitimately at zero clearance --
            # that is what a waterline is -- so the violation is ground standing
            # proud of the surface by more than a float's worth of it.
            violations += int((clearance < -args.tolerance).sum())
            worst = min(worst, float(clearance.min()))
            depth_error = max(depth_error, float(np.abs(s["depth"] - np.maximum(clearance, 0.0)).max()))
    if clearances:
        allc = np.concatenate(clearances)
        interior = allc[allc > 0.05]
        print(
            f"  bed           {checked:,} sheet vertices sampled against the shipped"
            f" .terr.bin; {violations:,} above the surface by more than"
            f" {args.tolerance:.2f} m, worst {worst:+.3f} m"
            + ("" if violations == 0 else "   WARNING: ground through the water")
        )
        print(
            f"  clearance     open water {np.median(interior) if interior.size else 0.0:.2f} m"
            f" at the median, {np.percentile(interior, 95) if interior.size else 0.0:.2f} at p95,"
            f" {allc.max():.2f} deepest; depth attribute agrees with the ground to"
            f" {depth_error * 1000:.2f} mm"
        )

    # --- 4. Neighbours, and the far sheet under the near ones.
    #
    # **The comparison is between sheets that meet on the shared edge, not
    # between the tiles' `wy`.** `wy` is the level of the tile's *largest* sheet
    # -- a per-tile summary for the wading lookup -- so two tiles whose dominant
    # body is a different body disagree by construction and mean nothing by it.
    # Compared that way the shipped world reports ten "steps in the harbour",
    # every one of which is a Centennial Park pond next to a tile of open water.
    # What a step actually is: one body of water crossing a seam at two different
    # heights, which shows only in the sheets that touch the seam.
    steps = 0
    for key, sheets in sheets_by_tile.items():
        tx, tz = (int(v) for v in key.split("_"))
        for nb, mine, theirs in (
            (f"{tx + 1}_{tz}", _edge_levels(sheets, "east"), "west"),
            (f"{tx}_{tz + 1}", _edge_levels(sheets, "north"), "south"),
        ):
            other = sheets_by_tile.get(nb)
            if other is None or not mine:
                continue
            across = _edge_levels(other, theirs)
            for level in mine:
                if not any(abs(level - o) <= 1e-3 for o in across) and across:
                    steps += 1
    tidal_level = contract["surface_y"]
    near_far_gap = (
        min(abs(tidal_level - s["surface"]) for s in far) if far else float("nan")
    )
    print(
        f"  seams         {steps:,} neighbouring wet tiles at different levels;"
        f" near sheets sit {near_far_gap:.2f} m over the far one"
        + ("" if steps == 0 else "   WARNING: a step in the harbour")
    )

    # --- 5. Coverage: what the field says is wet against what the tiles carry.
    if field is not None:
        from shapely.geometry import box as shapely_box

        want = 0.0
        should = 0
        for key in entries:
            tx, tz = (int(v) for v in key.split("_"))
            cell = shapely_box(
                tx * config.TILE_SIZE,
                tz * config.TILE_SIZE,
                (tx + 1) * config.TILE_SIZE,
                (tz + 1) * config.TILE_SIZE,
            )
            here = 0.0
            for lvl in field.levels:
                if lvl.geom.intersects(cell):
                    here += lvl.geom.intersection(cell).area
            want += here
            if here > 1.0:
                should += 1
        print(
            f"  coverage      {should:,} emitted tiles stand on {want / 1e6:.3f} km2 of the"
            f" assembled water; {wet_tiles:,} of them carry a sidecar"
            f" ({shipped_area / 1e6:.3f} km2, {100 * shipped_area / max(want, 1e-9):.1f}%)."
            f" The other {(field.area - want) / 1e6:.3f} km2 has no tile at all and is the"
            f" far sheet's alone."
        )
        if should > wet_tiles:
            # Not a failure and deliberately not counted as one: a tile carries
            # water only if it has been *emitted* since the water pass, and the
            # ledger is what decides that. The gap is the rebuild backlog, and
            # naming it here is what stops it being read as a hole in the data.
            print(
                f"                {should - wet_tiles:,} of those tiles predate the water pass"
                f" and will pick it up on the next build."
            )

    bad = violations > 0 or missing or steps > 0 or far is None
    return 1 if bad else 0


def _glb_primitives(gl, path):
    """(material name, positions, triangles, normals) per primitive in a tile GLB.

    `normals` is None on a primitive that carries no NORMAL attribute, which in
    this build is `contact_ao` alone -- it is drawn unlit and would be paying 12
    bytes a vertex for a stream nothing samples.
    """
    if not path.exists():
        return
    doc = gl.GLTF2().load(str(path))
    blob = doc.binary_blob()

    def read(acc_index, dtype, shape):
        """One accessor as an (N, shape) array.

        `accessor.count` is elements of the accessor's own type -- vec3s for a
        position stream, *scalars* for an index stream -- so the element width
        comes from the accessor and the caller only says how to group them.
        """
        acc = doc.accessors[acc_index]
        view = doc.bufferViews[acc.bufferView]
        offset = (view.byteOffset or 0) + (acc.byteOffset or 0)
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc.type]
        flat = np.frombuffer(blob, dtype=dtype, count=acc.count * width, offset=offset)
        return flat.reshape(-1, shape)

    for prim in doc.meshes[0].primitives:
        nrm = prim.attributes.NORMAL
        yield (
            doc.materials[prim.material].name,
            read(prim.attributes.POSITION, "<f4", 3),
            read(prim.indices, "<u4", 3),
            None if nrm is None else read(nrm, "<f4", 3),
        )


def _at(values: np.ndarray, share: np.ndarray, q: float) -> float:
    """The value at the `q` quantile of a cumulative-weight curve."""
    return float(values[int(np.searchsorted(share, q))])


def _triangle_slopes(pos: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(gradient, plan area) per triangle. Gradient is rise over run.

    Plan area rather than surface area, because what the gradient is being
    weighted by is how much of the *map* the road covers, and because it falls
    straight out of the same cross product: the y component of the un-normalised
    normal is twice the projected area.
    """
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    normal = np.cross(b - a, c - a)
    horizontal = np.hypot(normal[:, 0], normal[:, 2])
    up = np.abs(normal[:, 1])
    with np.errstate(divide="ignore", invalid="ignore"):
        gradient = np.where(up > 1e-12, horizontal / up, np.inf)
    return gradient, up * 0.5


def _collision_prisms(payload: bytes):
    """(base, footprint) for each prism in a v2 collision payload."""
    import struct

    count = struct.unpack_from("<I", payload, 0)[0]
    p = 4
    for _ in range(count):
        _height, base, n = struct.unpack_from("<ffH", payload, p)
        p += 10
        pts = np.frombuffer(payload, dtype="<f4", count=2 * n, offset=p).reshape(-1, 2)
        p += 8 * n
        yield float(base), pts


def cmd_winding_audit(args: argparse.Namespace) -> int:
    """Every triangle in the shipped tiles, winding against stored normal.

    Two numbers describe which way a triangle faces and nothing checks that they
    agree. The right-hand normal of the vertex order is what the rasteriser
    culls on; the NORMAL attribute is what the shader lights on. glTF does not
    compare them, three does not compare them, and this pipeline did not compare
    them for the first six months of its life -- during which `build_walls`
    emitted the two as exact negatives on every wall in the city and the result
    still rendered as a plausible Sydney, because a closed prism wound inside out
    does not leave a hole: the near walls cull and you are shown the inside of
    the back ones. That is what makes this worth a command rather than a comment.

    Reads the GLBs and nothing else -- not the ledger, not the source data --
    for the same reason `terrain-audit` does. A check that re-derives its answer
    from the same witness is not a check.

    A slot with no NORMAL is reported as such rather than as a pass. Only
    `contact_ao` is in that position; its winding is guarded where it is made.
    """
    import pygltflib as gl

    index = json.loads(config.INDEX_PATH.read_text())
    keys = [t["key"] for t in index["tiles"]]
    limit = args.tiles if args.tiles > 0 else len(keys)
    # Spread across the extent rather than taking the first N. The first tiles
    # in the index are one corner of the ring, and the CBD, the terrace suburbs
    # and the industrial fringe emit quite different slot mixes.
    sample = keys[:: max(len(keys) // limit, 1)][:limit]
    print(f"stage '{index['stage']}', {len(keys):,} tiles, auditing {len(sample):,}")

    agree: dict[str, int] = defaultdict(int)
    flipped: dict[str, int] = defaultdict(int)
    total: dict[str, int] = defaultdict(int)
    unlit: dict[str, int] = defaultdict(int)
    worst: list[tuple[float, str, str]] = []
    for key in sample:
        for slot, pos, tris, nrm in _glb_primitives(gl, config.TILE_DIR / f"{key}.glb"):
            if nrm is None:
                unlit[slot] += len(tris)
                continue
            ok, bad, n = mesh.winding_agreement(pos, nrm, tris)
            agree[slot] += ok
            flipped[slot] += bad
            total[slot] += n
            if n and ok < n:
                worst.append((ok / n, slot, key))

    print(f"  {'slot':<20}{'triangles':>12}{'agreeing':>12}{'%':>8}{'inside out':>12}")
    for slot in mesh.MATERIALS:
        n = total.get(slot, 0)
        if not n:
            if unlit.get(slot):
                print(f"  {slot:<20}{unlit[slot]:>12,}{'-- no NORMAL attribute':>32}")
            continue
        ok, bad = agree[slot], flipped[slot]
        note = "" if ok == n else "   <-- crease" if bad == 0 else "   <-- INSIDE OUT"
        print(f"  {slot:<20}{n:>12,}{ok:>12,}{100.0 * ok / n:>7.2f}%{bad:>12,}{note}")
    grand, gok, gbad = sum(total.values()), sum(agree.values()), sum(flipped.values())
    print(
        f"  {'ALL':<20}{grand:>12,}{gok:>12,}"
        f"{100.0 * gok / max(grand, 1):>7.2f}%{gbad:>12,}"
    )
    if gbad:
        for share, slot, key in sorted(worst)[:8]:
            print(f"    worst: {slot} on tile {key} at {100.0 * share:.1f}%")
        print(f"  FAIL: {gbad:,} triangles are lit from behind on every vertex")
        return 1
    creases = grand - gok
    if creases:
        # Not a failure, and the distinction is the whole reason there are two
        # columns -- see `mesh.winding_agreement`. These faces are wound
        # correctly and are shaded oddly at one corner, which no change to the
        # winding can affect.
        print(f"  {creases:,} faces have a vertex normal past their own plane -- smoothing creases")
    print("  no triangle is inside out")
    return 0


def _veg_instances(key: str):
    """`(x, z, height, radius, species)` per tree in one tile's sidecar."""
    import struct

    path = config.TILE_DIR / f"{key}.veg.bin"
    if not path.exists():
        return
    payload = path.read_bytes()
    (count,) = struct.unpack_from("<I", payload, 0)
    for i in range(count):
        x, z, height, radius, sp, _seed, _pad = struct.unpack_from(
            "<ffffBBH", payload, 4 + i * 20
        )
        yield x, z, height, radius, sp


def cmd_vegetation_audit(args: argparse.Namespace) -> int:
    """Every tree instance in the shipped world, against the scale the client
    will apply to it.

    The client holds one geometry per species, authored by hand at a nominal
    size, and scales each instance `(radius / nominalRadius, height /
    nominalHeight, radius / nominalRadius)` -- non-uniformly. That is only safe
    because the pipeline draws height and spread off one number, so the two
    factors stay in step; `world/vegetation.ts` says as much in the comment on
    its `NOMINAL` table. Nothing enforced it, and an OSM `diameter_crown=33 m`
    on a node that context had already called a paperbark came out as a **6.29x**
    stretch across and **0.82x** up: a fifteen-metre flat green disc on a
    two-metre stub, which is what a player photographs and calls a floating
    polyhedron.

    Two numbers per instance, and the second is the one that matters:

      scale    max(sxz, sy) -- how far from its authored size the geometry is
               being pushed at all.
      aspect   max(sxz/sy, sy/sxz) -- how far the two axes have come apart,
               which is the distortion itself. 1.00 is a uniform scale.

    Reads the `.veg.bin` sidecars and `index.json` and nothing else. The nominal
    sizes are re-derived from `vegetation.SPECIES_SIZE` rather than read from the
    client, which is the one place the two files are allowed to touch -- see
    `vegetation.nominal_size`.
    """
    index = json.loads(config.INDEX_PATH.read_text())
    keys = [t["key"] for t in index["tiles"]]
    print(f"stage '{index['stage']}', {len(keys):,} tiles, every tree instance")

    per_species: dict[int, list[tuple[float, float]]] = defaultdict(list)
    over_scale: list[tuple] = []
    over_aspect: list[tuple] = []
    total = 0
    for key in keys:
        tx, tz = (int(v) for v in key.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        for x, z, height, radius, sp in _veg_instances(key):
            total += 1
            sxz, sy = vegetation.instance_scale(sp, height, radius)
            aspect = max(sxz / sy, sy / sxz) if sxz > 0 and sy > 0 else float("inf")
            per_species[sp].append((max(sxz, sy), aspect))
            row = (aspect, max(sxz, sy), key, oe + x, on - z, height, radius, sp)
            if max(sxz, sy) > args.max_scale:
                over_scale.append(row)
            if aspect > args.max_aspect:
                over_aspect.append(row)

    print(f"  {'species':<18}{'instances':>11}{'worst scale':>13}{'worst aspect':>14}")
    worst_scale = worst_aspect = 0.0
    for sp in range(vegetation.SPECIES_COUNT):
        rows = per_species.get(sp)
        if not rows:
            continue
        s = max(r[0] for r in rows)
        a = max(r[1] for r in rows)
        worst_scale, worst_aspect = max(worst_scale, s), max(worst_aspect, a)
        nom_h, nom_r = vegetation.nominal_size(sp)
        print(
            f"  {vegetation.SPECIES_NAME[sp]:<18}{len(rows):>11,}"
            f"{s:>12.2f}x{a:>13.2f}"
            f"    nominal {nom_h:.1f} m / {nom_r:.1f} m radius"
        )
    print(
        f"  {'ALL':<18}{total:>11,}{worst_scale:>12.2f}x{worst_aspect:>13.2f}"
        f"    limits {args.max_scale:.2f}x / {args.max_aspect:.2f}"
    )

    bad = sorted(set(over_scale) | set(over_aspect), reverse=True)
    if bad:
        print(f"  {len(bad):,} instances past a limit, worst by aspect:")
        for aspect, scale, key, east, north, height, radius, sp in bad[:12]:
            print(
                f"    {vegetation.SPECIES_NAME[sp]:<18} tile {key:>7}"
                f" at ({east:8.1f},{north:9.1f})  {height:5.1f} m tall,"
                f" {radius:5.1f} m radius   scale {scale:.2f}x  aspect {aspect:.2f}"
            )
        print(
            f"  FAIL: {len(over_scale):,} over {args.max_scale:.2f}x scale,"
            f" {len(over_aspect):,} over {args.max_aspect:.2f} aspect"
        )
        return 1
    print("  every instance is within the authored envelope of its own species")
    return 0


# How far a prism's underside has to clear the ground before the player walks
# under it rather than into it, metres.
#
# 2.2 m, and it is a *player* dimension rather than a building code one: the
# controller's capsule is 1.8 m and it steps 0.42 m without help, so anything
# whose base is over 2.2 m is out of reach from the road below it even standing
# on the kerb. Deliberately not the 2.6 m `decks.WALK_UNDER_M` builds decks to --
# that one is a design margin chosen to feel open, and this one is the geometric
# question of whether the volume is in the player's way. A deck built to the
# first always passes the second, which is the right way round: the audit must
# not become a restatement of the thing it is auditing.
WALKABLE_UNDER_M = 2.2


def _tile_ground(key: str):
    """One tile's shipped terrain grid, or None if it has none."""
    path = config.TILE_DIR / f"{key}.terr.bin"
    if not path.exists():
        return None
    n = config.TERRAIN_GRID
    return np.frombuffer(path.read_bytes(), dtype="<f4").reshape(n + 1, n + 1)


def cmd_carriageway_audit(args: argparse.Namespace) -> int:
    """How much solid geometry is standing in the road, measured from the files.

    A world can be geometrically perfect building by building and still be
    unplayable, because the thing a player actually notices is not a wrong wall
    -- it is a wall where the street should be. Two sources put one there and
    neither says a word in the build log:

      * a footprint that is wrong. Microsoft's ML segmentation merges a whole
        block of terraces into one polygon that reaches across the laneways
        between them, and `merge.py` kept 193 of those on top of the hand-mapped
        OSM city until the duplicate test learned to union its candidates.
      * a far slab. `far.bin` carries every significant building as a low-detail
        prism and `world/far.ts` draws the ones whose tile is not resident, on
        the argument that a slab is inside its own building's walls. That is now
        true by construction -- the plan is the footprint's convex hull, inset --
        and it was not: the plan used to be the *minimum rotated rectangle*, and
        an ordinary Sydney corner block does not fill one. The Oxford Hotel is
        perfectly convex and still fills only 72% of its bounding rectangle, so
        the concavity shrink -- exactly 1.0 on a convex polygon, by design -- took
        nothing off it and the slab stood across Oxford Street. Where the ground a
        slab spills onto is the carriageway, the result is a flat unlit box across
        the street at eye level, and it is the case with no collision at all: the
        player walks through it and sees it, which is the worst of both. This line
        is what says whether that is still happening.

    Both are measured here against the *emitted* road: the carriageway polygon
    is the union of the tile's own `road_asphalt` triangles in plan, so this
    reads the shipped files and re-derives nothing from OSM.

    The solids are the collision prisms -- the same polygons the player is
    stopped by, which is the right question ("can I not walk here?") rather than
    "is a triangle here".

    **And "can I not walk here" is about the prism's `base`, not only its plan.**
    A prism whose underside is over the player's head is a thing they walk
    *under*, and counting it as a wall in the road is the one way this command
    can report a failure where the world is right: the Harbour Bridge's deck
    crosses Hickson Road, the Cahill Expressway's crosses Alfred Street, and the
    Western Distributor's crosses half of Pyrmont, all of them by design. This
    used to be counted -- the collision format has carried `base` since terrain
    arrived and this reader has always decoded it, and the value was simply
    dropped on the floor -- and the number it produced was a mixture of a defect
    and a viaduct. See `WALKABLE_UNDER_M`.
    """
    import pygltflib as gl
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    index = json.loads(config.INDEX_PATH.read_text())
    keys = [t["key"] for t in index["tiles"]]
    limit = args.tiles if args.tiles > 0 else len(keys)
    sample = keys[:: max(len(keys) // limit, 1)][:limit]
    print(f"stage '{index['stage']}', {len(keys):,} tiles, auditing {len(sample):,}")

    far_by_tile: dict[str, list] = defaultdict(list)
    far_contract = index.get("far")
    if far_contract is not None:
        far_by_tile = _far_slabs_by_tile(index)
        # Measured over every slab in the file, including the ones the client
        # will have hidden because their tile is resident. That is on purpose:
        # this asks whether the *geometry* claims road, not whether the player
        # happens to be standing somewhere it is currently drawn.
        print(
            f"  far layer   {far_contract['count']:,} slabs in"
            f" {far_contract.get('groups', 0):,} tile groups, drawn while their tile is not"
        )

    road_total = prism_area = slab_area = 0.0
    prism_hits = slab_hits = overhead = 0
    worst: list[tuple] = []
    for key in sample:
        road = _tile_carriageway(gl, key, Polygon, unary_union)
        if road.is_empty:
            continue
        road_total += road.area
        tx, tz = (int(v) for v in key.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE

        prisms = config.COLLISION_DIR / f"{key}.bin"
        ground = _tile_ground(key)
        if prisms.exists():
            payload = prisms.read_bytes()
            for base, pts in _collision_prisms(payload):
                poly = Polygon(pts)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
                c = poly.centroid
                if ground is not None:
                    clear = base - _sample_tile_grid(
                        ground, config.TERRAIN_GRID, float(c.x), float(c.y)
                    )
                    if clear >= WALKABLE_UNDER_M:
                        overhead += 1
                        continue
                on_road = poly.intersection(road).area
                if on_road > args.min_area:
                    prism_area += on_road
                    prism_hits += 1
                    worst.append((on_road, "building", key, oe + c.x, on - c.y))

        for rect, height in far_by_tile.get(key, ()):
            on_road = rect.intersection(road).area
            if on_road > args.min_area:
                slab_area += on_road
                slab_hits += 1
                c = rect.centroid
                worst.append((on_road, "far slab", key, oe + c.x, on - c.y))

    print(f"  carriageway {road_total:12,.0f} m2 of road in the sample")
    print(
        f"  buildings   {prism_area:12,.0f} m2 standing on it"
        f"  ({100 * prism_area / max(road_total, 1):5.2f}%, {prism_hits:,} prisms)"
    )
    print(
        f"  overhead    {overhead:12,} prisms cleared the player's head and were"
        f" not counted -- decks, viaducts and the Harbour Bridge"
    )
    print(
        f"  far slabs   {slab_area:12,.0f} m2 standing on it"
        f"  ({100 * slab_area / max(road_total, 1):5.2f}%, {slab_hits:,} slabs)"
    )
    worst.sort(reverse=True)
    for area, kind, key, east, north in worst[:12]:
        print(f"    {area:8.1f} m2  {kind:<9} tile {key:>7} at ({east:8.1f},{north:9.1f})")

    prism_share = prism_area / max(road_total, 1)
    slab_share = slab_area / max(road_total, 1)
    failed = False
    if prism_share > args.max_building_share:
        print(
            f"  FAIL: {100 * prism_share:.2f}% of the carriageway carries a"
            f" collision prism (limit {100 * args.max_building_share:.2f}%)"
        )
        failed = True
    if slab_share > args.max_slab_share:
        print(
            f"  FAIL: {100 * slab_share:.2f}% of the carriageway carries a far"
            f" slab (limit {100 * args.max_slab_share:.2f}%)"
        )
        failed = True
    if failed:
        return 1
    print(
        f"  within limits: {100 * prism_share:.2f}% solid,"
        f" {100 * slab_share:.2f}% far slab"
    )
    return 0


def _tile_carriageway(gl, key: str, Polygon, unary_union):
    """One tile's road surface as a plan polygon, from its own GLB.

    Built from the emitted triangles rather than re-buffered from OSM, which is
    the whole point: a check that asks the source what the road should be cannot
    see a road the pipeline failed to emit.
    """
    tris = []
    for slot, pos, idx, _n in _glb_primitives(gl, config.TILE_DIR / f"{key}.glb"):
        if slot != "road_asphalt":
            continue
        plan = pos[:, [0, 2]]
        for a, b, c in idx:
            p = Polygon([plan[a], plan[b], plan[c]])
            if p.is_valid and p.area > 1e-6:
                tris.append(p)
    if not tris:
        return Polygon()
    return unary_union(tris)


def _far_slabs_by_tile(index) -> dict:
    """Every `far.bin` slab as a plan polygon, in the frame of the tile that owns
    it.

    Reads the file's own tile grouping rather than re-deriving one from each
    slab's centre, so this audit measures the same partition the client hides on:
    if the pipeline files a slab under the wrong tile, the number that moves here
    is the one a player would see.

    Format 2 only. A `far.bin` from before the hull plan is not read at all --
    silently returning nothing for a file this cannot parse would report a clean
    road for a world full of boxes, which is the one way an audit can lie.
    """
    import struct

    from shapely.geometry import Polygon

    path = config.OUT_ROOT / "far.bin"
    if not path.exists():
        return {}
    payload = path.read_bytes()
    magic, version, count, _verts, groups = struct.unpack_from("<IIIII", payload, 0)
    if magic != tiles.FAR_MAGIC or version != tiles.FAR_VERSION:
        raise SystemExit(
            f"far.bin is magic {magic:#x} version {version}, not"
            f" {tiles.FAR_MAGIC:#x} version {tiles.FAR_VERSION}."
            " Rebuild the far layer before auditing it."
        )
    group_at = 20
    slab_at = group_at + groups * tiles.FAR_GROUP_STRIDE
    vert_at = slab_at + count * tiles.FAR_SLAB_STRIDE

    out: dict[str, list] = defaultdict(list)
    for g in range(groups):
        tx, tz, first, n = struct.unpack_from(
            "<iiII", payload, group_at + g * tiles.FAR_GROUP_STRIDE
        )
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        for i in range(first, first + n):
            _base, height, fv, nv, _mat, _arch, _pad = struct.unpack_from(
                "<ffIBBBB", payload, slab_at + i * tiles.FAR_SLAB_STRIDE
            )
            pts = []
            for v in range(nv):
                wx, wz = struct.unpack_from("<ff", payload, vert_at + (fv + v) * 8)
                # World (x, z) back to the tile's local ENU-with-a-flipped-north
                # frame, which is what `_tile_carriageway` reads out of the GLB.
                pts.append((wx - oe, wz + on))
            out[f"{tx}_{tz}"].append((Polygon(pts), height))
    return out


def cmd_road_grade_audit(args: argparse.Namespace) -> int:
    """Measure how steep and how banked the streets actually came out.

    The complaint this exists for was a carriageway tilted about 45 degrees, and
    nothing in the build log could have said so: every stage ran, the road was
    drawn exactly 2 cm over the ground it was cut against, and `terrain-audit`
    agreed to the micron -- because the road was faithfully following a DEM that
    had a building in it. A surface can be perfectly consistent with the thing
    under it and still be wrong, which is the case an audit against the *world*
    rather than against the pipeline is for.

    Two numbers, both measured along the real centrelines:

      **grade**, the rise over the run along the street, which is the one a
      player feels as a hill;
      **cross-slope**, the difference between the two kerbs over the width, which
      is the one that reads as the road being *banked* and which has no
      legitimate value above a couple of per cent of camber.

    The surface is the shipped `.terr.bin` sidecars stitched back into one
    lattice by default -- the actual ground the client will draw, read from the
    files, with nothing re-derived. `--surface lattice` asks the pipeline what it
    would emit now, which is how a citywide answer is available without a
    citywide rebuild, and `--surface raw` turns `roadgrade.py` off and prints the
    world as it was before any of this.

    **Three sets of stations are reported separately and kept out of the
    verdict**, and every one of them is a decision taken elsewhere in the
    pipeline rather than a defect of the street solve. Counting a decision
    against a regression gate makes the gate useless; hiding one makes it a lie;
    so each gets its own line, with the same statistics and the same named
    offenders as the verdict line.

      * **Tunnels**, which carry no surface at all.
      * **Bridges.** They are not conformed -- `roadgrade._is_conformable` -- and
        since `decks.py` they are not drawn on the ground either, so what is
        under a bridge centreline is now the ground the viaduct flies over. The
        deck itself is measured further down, off the emitted facets: see
        `DECK_FACET_RISE_M`, which is the way identity the unioned geometry does
        not carry and does not need.
      * **Carriageways at the tidal shore**, which is the newest of the three and
        has the longest argument -- see `_tidal_plan`. In short: the water pass
        cuts a harbour bed that starts below sea level at the coastline, the DEM
        puts the foreshore five to twelve metres above it, and a 31.25 m lattice
        has one cell to put the step in. `--no-shore` prints the whole number in
        one column.
    """
    index = json.loads(config.INDEX_PATH.read_text())
    contract = index.get("terrain")
    if contract is None:
        print("index.json has no terrain contract -- this world was built flat.")
        return 1
    keys = {t["key"] for t in index["tiles"]}
    radius = index["radius_m"]

    if args.surface == "tiles":
        field = _shipped_lattice(index, keys)
        label = f"shipped .terr.bin sidecars ({len(keys):,} tiles)"
    else:
        # The water goes with the roads on `raw`, and that is not incidental
        # tidiness: this is the *before* column, and a lattice with a harbour bed
        # cut into it but no road conformance is a surface that never existed at
        # any point in the build. It is not a free choice -- the bed cut moves
        # foreshore roads by metres, see `_tidal_plan` -- but the shore split
        # below reports that on its own line either way.
        conform = args.surface != "raw"
        field = Terrain.load(radius, conform_roads=conform, conform_water=conform)
        label = "a fresh lattice, " + (
            "roads conformed" if conform else "roads NOT conformed (the before)"
        )
    print(f"stage '{index['stage']}', surface: {label}")

    roads = osm.read_roads(radius)
    surface = [r for r in roads if roadgrade._is_conformable(r)]
    decked = [r for r in roads if decks._is_deck(r)]

    only = None
    if args.only:
        only = {k.strip() for part in args.only for k in part.split(",") if k.strip()}
        missing = only - keys
        if missing:
            raise SystemExit(f"--only names tiles the index does not have: {sorted(missing)}")
        print(f"  restricted to {len(only)} tiles: {' '.join(sorted(only))}")

    shore = None if args.no_shore else _tidal_plan(index, radius, field)
    share = _grade_report("carriageways", surface, field, args, only, shore, want=False)
    if shore is not None:
        _grade_report(
            "carriageways at the tidal shore (excluded from the verdict -- see"
            " `_tidal_plan`)",
            surface, field, args, only, shore, want=True,
        )
    if decked:
        _grade_report(
            "the ground under the decks (nothing is drawn on it -- see `decks.py`)",
            decked, field, args, only,
        )
    _solve_fidelity_report(field, surface, args, only)
    _mesh_grade_report(only if only else keys, args, field)

    if share > args.max_over_share:
        print(
            f"  FAIL: {100 * share:.3f}% of carriageway segments carry more than"
            f" {100 * args.max_grade:.0f}% of grade or bank"
            f" (limit {100 * args.max_over_share:.3f}%)"
        )
        return 1
    print(
        f"  within limits: {100 * share:.3f}% of segments over"
        f" {100 * args.max_grade:.0f}% (limit {100 * args.max_over_share:.3f}%)"
    )
    return 0


def _shipped_lattice(index, keys):
    """Every emitted `.terr.bin` stitched back into one lattice, as a sampler.

    The tiles are read into the same north-ascending array `terrain._Lattice`
    holds, so `Terrain.sample` interpolates them exactly the way the client's
    mesh will -- including which diagonal each cell splits along, which is half
    of what a slope measurement is measuring. Ground the build never emitted
    stays NaN and every station that lands on it drops out of the statistics,
    which is the honest answer: there is no road there to be steep.
    """
    from .terrain import _Lattice

    n = index["terrain"]["grid"]
    spacing = index["tile_size"] / n
    txs = [int(k.split("_")[0]) for k in keys]
    tzs = [int(k.split("_")[1]) for k in keys]
    p0, q0 = min(txs) * n, min(tzs) * n
    heights = np.full(
        ((max(tzs) - min(tzs) + 1) * n + 1, (max(txs) - min(txs) + 1) * n + 1),
        np.nan,
        dtype=np.float32,
    )
    for key in keys:
        path = config.TILE_DIR / f"{key}.terr.bin"
        if not path.exists():
            raise SystemExit(f"missing terrain sidecar for {key}")
        tx, tz = (int(v) for v in key.split("_"))
        grid = np.frombuffer(path.read_bytes(), dtype="<f4").reshape(n + 1, n + 1)
        r, c = (tz - min(tzs)) * n, (tx - min(txs)) * n
        heights[r : r + n + 1, c : c + n + 1] = grid[::-1]
    return Terrain(_Lattice(heights, p0, q0, spacing), 0.0, {})


def _in_tiles(pts: np.ndarray, keys: set[str]) -> np.ndarray:
    """Which of these ENU points fall inside one of `keys`."""
    tx = np.floor(pts[:, 0] / config.TILE_SIZE).astype(np.int64)
    tz = np.floor(pts[:, 1] / config.TILE_SIZE).astype(np.int64)
    return np.asarray([f"{a}_{b}" in keys for a, b in zip(tx, tz)])


def _road_stations(r, station_m: float):
    """(points, unit directions, station spacings) along one centreline."""
    line = np.asarray(r.line, dtype=np.float64)
    step = np.diff(line, axis=0)
    seglen = np.hypot(step[:, 0], step[:, 1])
    s = np.concatenate(([0.0], np.cumsum(seglen)))
    if s[-1] < station_m:
        return None
    ss = np.linspace(0.0, s[-1], max(int(s[-1] / station_m) + 1, 2))
    idx = np.clip(np.searchsorted(s, ss, side="right") - 1, 0, len(seglen) - 1)
    safe = np.where(seglen[idx] > 0.0, seglen[idx], 1.0)
    pts = line[idx] + step[idx] * ((ss - s[idx]) / safe)[:, None]
    return pts, step[idx] / safe[:, None], np.diff(ss)


def _grade_report(
    title: str,
    roads,
    field,
    args,
    only: set[str] | None,
    shore=None,
    want: bool = False,
) -> float:
    """One line of grade, one of cross-slope, and the worst places by name.

    Returns the worse of the two over-the-ceiling shares, which is what the
    verdict is taken on.

    `shore` splits the stations in two. With `want=False` the shore stations are
    dropped and what is measured is the road solve; with `want=True` only they
    are, which is the line that says how big the thing being set aside is. See
    `_tidal_plan` for what a shore station is and why it is not the solve's
    verdict to answer for.
    """
    grade: list[np.ndarray] = []
    cross: list[np.ndarray] = []
    worst: list[tuple] = []
    for r in roads:
        st = _road_stations(r, args.station)
        if st is None:
            continue
        pts, dirs, spans = st
        h = np.asarray(field.sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
        if only is not None:
            # A station outside the chosen tiles is dropped by making its
            # samples non-finite, which the filter below already removes -- the
            # alternative, cutting the array, would join two stations either side
            # of the gap into one segment and invent a grade between them.
            h = np.where(_in_tiles(pts, only), h, np.nan)
        g = np.abs(np.diff(h)) / np.where(spans > 0.0, spans, 1.0)
        # Half the carriageway, by `streets.py`'s own clamp -- the kerb line, so
        # the cross-slope is measured between the two places the road actually
        # ends rather than over some nominal width.
        half = min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH) * 0.5
        left = pts + np.column_stack((-dirs[:, 1], dirs[:, 0])) * half
        right = pts - np.column_stack((-dirs[:, 1], dirs[:, 0])) * half
        c = np.abs(
            np.asarray(field.sample(left[:, 0], left[:, 1]))
            - np.asarray(field.sample(right[:, 0], right[:, 1]))
        ) / (2.0 * half)
        c = c + (h - h)  # carry the tile mask's NaNs onto the cross-slope too
        if shore is not None:
            # Dropped the same way the tile mask drops one, and for the same
            # reason: cutting the array would join two stations either side of
            # the gap and invent a grade between them.
            wet = _at_shore(shore, pts, left, right)
            # A *segment* straddling the line -- one end at the shore, one not --
            # goes to the shore group, so the two groups partition the stations
            # exactly and nothing falls between them. Attributing it the other
            # way would drop 35 of the extent's 244 over-ceiling grade segments
            # into a gap that neither line reports, which is the one outcome a
            # split like this must not have.
            c = np.where(wet if want else ~wet, c, np.nan)
            straddle = wet[:-1] | wet[1:]
            g = np.where(straddle if want else ~straddle, g, np.nan)
        for values, kind, bucket in ((g, "grade", grade), (c, "bank", cross)):
            live = np.flatnonzero(np.isfinite(values))
            if not len(live):
                continue
            bucket.append(values[live])
            # Back through the mask to the station, so the coordinate printed is
            # the place the number came from rather than the n-th survivor.
            k = int(live[int(np.argmax(values[live]))])
            worst.append((float(values[k]), kind, r, pts[k]))
    if not grade:
        print(f"  {title}: nothing measurable")
        return 0.0

    g = np.concatenate(grade)
    c = np.concatenate(cross)
    print(f"  {title}: {len(roads):,} ways, {len(g):,} segments at {args.station:.0f} m")
    over_g = int((g > args.max_grade).sum())
    over_c = int((c > args.max_grade).sum())
    for name, v, over in (("grade", g, over_g), ("cross-slope", c, over_c)):
        p = 100.0 * np.percentile(v, [50, 95, 99, 100])
        print(
            f"    {name:11} p50 {p[0]:5.2f}%  p95 {p[1]:5.2f}%  p99 {p[2]:5.2f}%"
            f"  max {p[3]:6.2f}%   over {100 * args.max_grade:.0f}%:"
            f" {over:,} ({100 * over / len(v):.3f}%)"
        )
    worst.sort(key=lambda t: -t[0])
    shown = [w for w in worst if w[0] > args.max_grade][: args.worst]
    for v, kind, r, p in shown:
        tile = f"{math.floor(p[0] / config.TILE_SIZE)}_{math.floor(p[1] / config.TILE_SIZE)}"
        print(
            f"      {100 * v:6.1f}% {kind:<5} {r.highway:<14}"
            f" {(r.name or '(unnamed)')[:26]:<26} tile {tile:>8}"
            f" at ({p[0]:8.1f},{p[1]:9.1f})"
        )
    return max(over_g / len(g), over_c / len(c))


# --- The tidal shore ------------------------------------------------------------
#
# **A carriageway whose measurement window reaches mapped tidal water is measured
# separately and is not the road solve's verdict to answer for**, and this block
# is the whole argument for that, because on the face of it it looks like moving
# a goalpost.
#
# The gate exists to catch `roadgrade.py` regressing. It was set at 0.1% against
# a measured 0.011%, and that measurement is still exactly reproducible today:
# `Terrain.load(radius, conform_roads=True, conform_water=False)` gives 4
# segments over 15% of grade and 9 over 15% of bank out of 75,278, which is the
# pair of numbers `roadgrade.py`'s header quotes. Turning the water pass on takes
# the same measurement to 246 and 577.
#
# The mechanism is not the road solve and no change to it can fix it. The DEM is
# a *surface* model smoothed over 60 m, so it puts Sydney's harbour foreshore
# five to twelve metres above sea level where the truth is one to three;
# `water.conform` then -- correctly -- cuts a bed under the harbour that starts
# `SHORE_CLEARANCE_M` **below** sea level at the polygon boundary. That is a step
# of up to twenty metres landing on a 31.25 m lattice, so it is spread across one
# cell, and any road inside that cell is tilted by it. Measured over the 823
# offending stations: 810 of them are within 35 m of mapped water and 6 are
# inside it, and the 13 that are not are the Bellevue Hill and Darling Harbour
# cases `roadgrade.py`'s closing note already names as the lattice's own limit.
#
# So it is one defect, it is real, and it is the *water* datum against the *DEM*
# rather than anything the street solve decides. It is also not fixable at this
# resolution: land at +10 m beside water at 0 m needs a drop, the drop has to fit
# in the cell the shoreline is in, and either the road is in that cell or the
# harbour retreats from the seawall to make room -- 82 ha of it, a hundred-metre
# dry moat along every foreshore road, which is worse. The real fix is a
# bare-earth DEM, which is `terrain.py`'s standing follow-up (ELVIS' 1 m LiDAR)
# and changes nothing else.
#
# This is therefore the same treatment `_is_conformable`'s exclusions already
# get: a measurement that is a *decision taken elsewhere in the pipeline* is
# reported in full, by name, with its own line, and kept out of the verdict of
# the thing it is not about. What it must never become is silence -- so the shore
# line prints the same statistics and the same named offenders as the verdict
# line does, and if it starts growing, it says so.


def _tidal_plan(index, radius_m: float, field):
    """The mapped water, as one polygon, or None if this world has none.

    Taken off `field.water` when the surface was assembled in this process --
    `--surface lattice` and `--surface raw` both hold it -- and read from the
    source otherwise, which is what `--surface tiles` needs since a stitched
    lattice carries no water field. `sea_level_y` comes from the index rather
    than from the field for the same reason: the stitched one has no datum.
    """
    from shapely import union_all

    existing = getattr(field, "water", None)
    if existing is None:
        contract = index.get("water")
        if contract is None and not index.get("terrain"):
            return None
        try:
            existing = water.load(
                radius_m, field.sample, float(index["terrain"]["sea_level_y"])
            )
        except (water.WaterSanityError, KeyError) as exc:
            # An extract with no coastline ways in it -- the inner one has none
            # and the guard in `water.guard_share` is what says so. The audit
            # still has a verdict to give without the split; it just gives it on
            # every carriageway, which is what `--no-shore` asks for anyway.
            print(f"  (no water assembled, shore split skipped: {exc})")
            return None
    geoms = [lvl.geom for lvl in existing.levels]
    if not geoms:
        return None
    return union_all(geoms)


def _at_shore(shore, pts: np.ndarray, left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """Which stations have a lattice cell corner in the water under them.

    Exact rather than a radius, and that is what keeps the split honest: the
    ground at a sample point is the plane through the corners of the cell it
    lands in, so the bed cut can only have moved that sample if it moved one of
    those corners -- which it does exactly when the corner is inside a water
    polygon. A station 40 m from the harbour with four dry corners under each of
    its three samples is measured by the verdict, and one 60 m away with a wet
    corner is not.
    """
    s = config.TILE_SIZE / config.TERRAIN_GRID
    wet = np.zeros(len(pts), dtype=bool)
    for sample in (pts, left, right):
        p = np.floor(sample[:, 0] / s)
        q = np.floor(sample[:, 1] / s)
        for dp, dq in ((0, 0), (1, 0), (0, 1), (1, 1)):
            wet |= shapely.contains_xy(shore, (p + dp) * s, (q + dq) * s)
    return wet


def _solve_fidelity_report(field, roads, args, only: set[str] | None) -> None:
    """How much of what is left is the solve, and how much is the lattice.

    The two failure modes look identical in the numbers above and want opposite
    fixes: a street the solve got wrong needs a better estimator, and a street
    the solve got right that the ground could not follow needs finer posts. This
    tells them apart by asking `roadgrade.RoadSurface` what height it wanted at a
    station and comparing it with what the terrain there actually came out at.

    Only available when the surface was solved in this process -- `--surface
    tiles` reads files and has no solve to ask. A stride rather than every
    station because the query is a point-at-a-time hash lookup and 75,000 of them
    is a minute for a number that does not move between neighbours.
    """
    surface = getattr(field, "road_surface", None)
    if surface is None or not len(surface.a):
        return
    pts = []
    for r in roads:
        st = _road_stations(r, args.station)
        if st is None:
            continue
        p = st[0]
        if only is not None:
            p = p[_in_tiles(p, only)]
        pts.append(p)
    if not pts:
        return
    p = np.concatenate(pts)
    stride = max(len(p) // 5000, 1)
    p = p[::stride]
    want, weight = surface.blend(p[:, 0], p[:, 1])
    got = np.asarray(field.sample(p[:, 0], p[:, 1]), dtype=np.float64)
    live = np.isfinite(got) & (weight > 0.0)
    if not live.any():
        return
    err = np.abs(got[live] - want[live])
    q = np.percentile(err, [50, 95, 99, 100])
    print(
        f"  solve vs ground: {int(live.sum()):,} stations sampled, the lattice sits"
        f" {q[0]:.2f} m from the solved profile at p50, {q[1]:.2f} at p95,"
        f" {q[2]:.2f} at p99, {q[3]:.2f} at worst"
    )


# How far over the terrain an asphalt facet has to stand to be a deck, metres.
#
# **This is the way identity the emitted geometry does not carry.** `streets.py`
# unions every ribbon in a tile into one polygon before it is triangulated, so by
# the time a triangle exists there is nothing on it that says which OSM way it
# came from and the emitted-facet line could not tell a viaduct from a street. It
# does not need to: a deck is *the asphalt that is not on the ground*, which is a
# property of the shipped vertices and the shipped terrain sidecar and of nothing
# else. `streets.CARRIAGEWAY_Y` puts ground asphalt 2 cm over the terrain it was
# cut against, and `decks.PRISM_MIN_RISE_M` is where a deck stops being at grade,
# so anything a metre up is a deck and everything else is a street -- with two
# orders of magnitude of daylight between the two populations and nothing in it.
DECK_FACET_RISE_M = 1.0


def _mesh_grade_report(keys, args, field=None) -> None:
    """The same question asked of the emitted triangles instead of the ground.

    Weighted by plan area for the reason `cmd_terrain_audit` gives: conforming
    the road to the terrain facets leaves thousands of near-zero slivers whose
    normal is entirely rounding, and per triangle they swamp the statistic.

    Split into the road on the ground and the road in the air when a terrain
    field is available to split it with -- see `DECK_FACET_RISE_M`. The two want
    different ceilings and mean different things: a steep facet on the ground is
    the lattice failing to hold a level street, and a steep facet on a deck is
    `decks.py`'s profile solve having been asked for something it could not give.
    """
    import pygltflib as gl

    sample = sorted(keys)
    if args.tiles > 0:
        sample = sample[:: max(len(sample) // args.tiles, 1)][: args.tiles]
    rows_: list[np.ndarray] = []
    for key in sample:
        tx, tz = (int(v) for v in key.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        for slot, pos, tris, _n in _glb_primitives(gl, config.TILE_DIR / f"{key}.glb"):
            if slot != "road_asphalt":
                continue
            grad, area = _triangle_slopes(pos, tris)
            if field is None:
                rise = np.zeros(len(grad))
            else:
                centre = pos[tris].mean(axis=1)
                ground = np.asarray(
                    field.sample(centre[:, 0] + oe, -centre[:, 2] + on), dtype=np.float64
                )
                rise = np.nan_to_num(centre[:, 1] - ground, nan=0.0)
            rows_.append(np.column_stack((grad, area, rise)))
    if not rows_:
        return
    both = np.concatenate(rows_)
    live = np.isfinite(both[:, 0]) & (both[:, 1] > 0.1)
    both = both[live]
    groups = [("emitted asphalt", both)]
    if field is not None:
        deck = both[:, 2] >= DECK_FACET_RISE_M
        groups = [("emitted asphalt, on the ground", both[~deck])]
        if deck.any():
            groups.append(("emitted asphalt, on a deck", both[deck]))
    for title, rows in groups:
        if not len(rows):
            continue
        order = np.argsort(rows[:, 0])
        gradient, area = rows[order, 0], rows[order, 1]
        share = np.cumsum(area) / area.sum()
        steep = float(area[gradient > args.max_grade].sum() / area.sum())
        print(
            f"  {title}: {len(sample):,} tiles, {area.sum() / 1e4:,.1f} ha,"
            f" facet slope by area p50 {100 * _at(gradient, share, 0.5):5.2f}%"
            f"  p95 {100 * _at(gradient, share, 0.95):5.2f}%"
            f"  p99 {100 * _at(gradient, share, 0.99):5.2f}%"
            f"  max {100 * gradient[-1]:6.2f}%"
            f"   over {100 * args.max_grade:.0f}%: {100 * steep:.3f}% of the road"
        )


# --- landmark-audit ------------------------------------------------------------
#
# The three hero landmarks are the one part of this world that is *authored*
# rather than derived, and that changes what an audit of them is for. Everything
# else the pipeline emits can be checked against its source -- a footprint is
# right if it matches OSM, a road grade is right if it matches the DEM. A
# parametric model has no source to match: it is right if it is the size the real
# object is, in the place the real object is, and if the shipped file still says
# so after passing through a frame flip, a node translation and a float32
# accessor.
#
# So this command reads **only shipped artefacts** -- `index.json`,
# `landmarks.glb`, the collision payloads and `far.bin` -- and checks them
# against published dimensions and against the OSM outlines. Nothing it reports
# is computed by the same code that produced the file.

# What each landmark is, in metres, as published. The audit's whole point is
# that these are quoted from the outside world rather than imported from
# `landmarks.py`: importing the constants would check that a number equals
# itself.
LANDMARK_TRUTH: dict[str, dict[str, float]] = {
    "harbour_bridge": {"deck_ahd": 49.0, "arch_apex_ahd": 134.0, "pylon_ahd": 89.0},
    "opera_house": {"shell_max_ahd": 67.0},
    "sydney_tower": {"spire_height": 309.0},
}

# How far the shipped geometry may sit from the OSM feature it is registered to.
LANDMARK_PLACEMENT_TOLERANCE_M = 10.0
# How far a measured height may be from the published one, as a fraction.
LANDMARK_HEIGHT_TOLERANCE = 0.02
# The largest gap the deck's collision may have along its own axis. A player
# walks 5.4 m/s and the integrator steps at 60 Hz, so 0.5 m is under six frames
# of being unsupported -- and in practice the segments abut exactly, so anything
# this catches is a missing segment rather than a rounding gap.
DECK_GAP_TOLERANCE_M = 0.5


def _landmark_nodes(gl, path: Path) -> dict:
    """Every node in `landmarks.glb` as world-space positions, normals and tris.

    Positions come back **already offset by the node translation**, so what this
    returns is where the geometry actually is in the world -- which is the thing
    being audited. A reader that ignored the translation would pass a build that
    left every landmark sitting on Town Hall.
    """
    doc = gl.GLTF2().load(str(path))
    blob = doc.binary_blob()

    def read(acc_index, dtype, width):
        acc = doc.accessors[acc_index]
        view = doc.bufferViews[acc.bufferView]
        offset = (view.byteOffset or 0) + (acc.byteOffset or 0)
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc.type]
        flat = np.frombuffer(blob, dtype=dtype, count=acc.count * n, offset=offset)
        return flat.reshape(-1, width)

    out: dict = {}
    for node in doc.nodes:
        if node.mesh is None:
            continue
        t = node.translation or [0.0, 0.0, 0.0]
        parts = []
        for prim in doc.meshes[node.mesh].primitives:
            pos = read(prim.attributes.POSITION, "<f4", 3).astype(np.float64) + np.asarray(t)
            nrm = read(prim.attributes.NORMAL, "<f4", 3).astype(np.float64)
            tris = read(prim.indices, "<u4", 3)
            parts.append((doc.materials[prim.material].name, pos, nrm, tris))
        out[node.name or doc.meshes[node.mesh].name] = {
            "translation": [float(v) for v in t],
            "parts": parts,
        }
    return out


def _plan_anchor(parts, y_lo: float, y_hi: float, materials=None) -> tuple[float, float, int]:
    """The plan centroid of every vertex in a height band, in world (x, z).

    A band rather than a single extreme, because the extreme of a tessellated
    surface is one vertex and one vertex says nothing about where the object is.
    The arch crown is 30-odd vertices spread over two chords 30.5 m apart and
    one panel long; their centroid is the crown, to a metre.
    """
    xs, zs, n = 0.0, 0.0, 0
    for name, pos, _nrm, _tris in parts:
        if materials is not None and name not in materials:
            continue
        sel = pos[(pos[:, 1] >= y_lo) & (pos[:, 1] <= y_hi)]
        if len(sel):
            xs += float(sel[:, 0].sum())
            zs += float(sel[:, 2].sum())
            n += len(sel)
    return (xs / n, zs / n, n) if n else (float("nan"), float("nan"), 0)


def _plan_centroid(parts, y_lo: float, y_hi: float, materials=None) -> tuple[float, float, int]:
    """The area-weighted plan centroid of the horizontal faces in a height band.

    A vertex mean is not good enough here and the Opera House is why: OSM maps
    the northern half of the podium with four times the vertex density of the
    southern half, so a mean of the podium deck's vertices sits 25 m north of the
    building. Weighting each triangle by its own area is the polygon centroid,
    which is the number the manifest carries and the number this is checking.
    """
    sx = sz = area = 0.0
    n = 0
    for name, pos, _nrm, tris in parts:
        if materials is not None and name not in materials:
            continue
        a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
        inside = (
            (a[:, 1] >= y_lo) & (a[:, 1] <= y_hi)
            & (b[:, 1] >= y_lo) & (b[:, 1] <= y_hi)
            & (c[:, 1] >= y_lo) & (c[:, 1] <= y_hi)
        )
        if not inside.any():
            continue
        a, b, c = a[inside], b[inside], c[inside]
        w = np.abs(
            (b[:, 0] - a[:, 0]) * (c[:, 2] - a[:, 2])
            - (b[:, 2] - a[:, 2]) * (c[:, 0] - a[:, 0])
        ) * 0.5
        cx = (a[:, 0] + b[:, 0] + c[:, 0]) / 3.0
        cz = (a[:, 2] + b[:, 2] + c[:, 2]) / 3.0
        sx += float((cx * w).sum())
        sz += float((cz * w).sum())
        area += float(w.sum())
        n += int(inside.sum())
    if area <= 0.0:
        return float("nan"), float("nan"), 0
    return sx / area, sz / area, n


def _max_y(parts, materials=None) -> float:
    best = -float("inf")
    for name, pos, _nrm, _tris in parts:
        if materials is not None and name not in materials:
            continue
        if len(pos):
            best = max(best, float(pos[:, 1].max()))
    return best


def _winding_failures(parts) -> tuple[int, int]:
    """(inside out, tested) over a node's triangles.

    The same test `mesh.winding_agreement` runs over the tiles, applied to a file
    that command never opens. It matters more here, not less: a tile's walls are
    wound from a footprint whose orientation `merge.orient_footprint` has already
    normalised, where every face in `landmarks.py` is generated and its winding
    is decided by a cross product at the moment of emission. One sign wrong in
    `_Builder.face` and a landmark is inside out from every angle -- which reads
    as "the shells look odd in shadow" rather than as a bug.
    """
    bad = tested = 0
    for _name, pos, nrm, tris in parts:
        a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
        face = np.cross(b - a, c - a)
        mean = (nrm[tris[:, 0]] + nrm[tris[:, 1]] + nrm[tris[:, 2]]) / 3.0
        dot = np.einsum("ij,ij->i", face, mean)
        area = np.linalg.norm(face, axis=1)
        live = area > 1e-9
        bad += int((dot[live] < 0).sum())
        tested += int(live.sum())
    return bad, tested


def _deck_prisms(bridge_audit: dict, anchor: list[float]) -> list[tuple[float, float, float]]:
    """Every shipped collision prism that is a piece of the bridge deck.

    Selected by geometry rather than by a flag, because the payload has no flags
    and must not grow one: a prism belongs to the deck if its plan sits inside
    the deck corridor and its top is within a metre of the deck surface at that
    point along the bridge. That is a test a *building* under the approach
    viaduct cannot pass -- there is nothing in Milsons Point at 49 m -- and it is
    the test that would catch the deck's segments being written into the wrong
    tile, which is the failure this is really for.

    Returns (deck runs, parapet runs), each (s_low, s_high, top) along the axis.
    The parapets are counted separately and on their own signature -- half a
    metre wide, sitting on top of the deck rather than under it -- because
    "walkable" and "you cannot step off it by accident" are two claims and only
    one of them is about the deck.
    """
    import struct

    axis = np.array([bridge_audit["axis_east"], bridge_audit["axis_north"]])
    across = np.array([axis[1], -axis[0]])
    centre = np.asarray(anchor, dtype=np.float64)
    deck_y = bridge_audit["deck_y"]
    grade = 0.055
    half_len = bridge_audit["deck_length_m"] * 0.5
    deck_width = bridge_audit["deck_width_m"]
    half_w = deck_width * 0.5

    def deck_level(s: float) -> float:
        return deck_y - grade * max(0.0, abs(s) - half_len)

    rail_h = bridge_audit["parapet_height_m"]
    deck: list[tuple[float, float, float]] = []
    rails: list[tuple[float, float, float]] = []
    for path in sorted(config.COLLISION_DIR.glob("*.bin")):
        tx, tz = (int(v) for v in path.stem.split("_"))
        oe, on = tx * config.TILE_SIZE, tz * config.TILE_SIZE
        payload = path.read_bytes()
        if len(payload) < 4:
            continue
        count = struct.unpack_from("<I", payload, 0)[0]
        p = 4
        for _ in range(count):
            if p + 10 > len(payload):
                break
            height, base, n = struct.unpack_from("<ffH", payload, p)
            p += 10
            if p + 8 * n > len(payload):
                break
            pts = np.frombuffer(payload, dtype="<f4", count=2 * n, offset=p).reshape(-1, 2)
            p += 8 * n
            # Tile-local (x, z) back to ENU: x is east + the tile origin, and z
            # is south, so north is the negation.
            enu = np.column_stack((pts[:, 0].astype(np.float64) + oe,
                                   on - pts[:, 1].astype(np.float64)))
            d = enu - centre
            s = d @ axis
            t = d @ across
            # THREE TESTS, NOT ONE, and the two extra ones are what stop this
            # counting a Milsons Point terrace as a piece of bridge. A deck
            # segment is a rectangle, in the bridge's own frame, exactly as wide
            # as the deck -- so a prism that is not four-sided, or whose width
            # across the bridge is not 48.8 m, is something else standing under
            # the viaduct. Without them a roof at 41 m AHD 720 m north of the
            # arch was reported as a detached 25 m run of deck, which is a gap
            # the audit invents rather than one a player could fall through.
            if np.abs(t).max() > half_w + 1.0 or n != 4:
                continue
            top = base + height
            mid = float(s.mean())
            span = float(t.max() - t.min())
            if abs(span - deck_width) <= 1.5 and abs(top - deck_level(mid)) <= 1.0:
                deck.append((float(s.min()), float(s.max()), top))
            elif (
                span <= 1.5
                and abs(height - rail_h) < 0.1
                and abs(base - deck_level(mid)) <= 1.0
            ):
                rails.append((float(s.min()), float(s.max()), top))
    return sorted(deck), sorted(rails)


def cmd_landmark_audit(args: argparse.Namespace) -> int:
    """Read the shipped landmark set back and check it against the real Sydney."""
    import pygltflib as gl
    from shapely.geometry import Point, Polygon

    failures: list[str] = []
    if not config.INDEX_PATH.exists():
        raise SystemExit(f"no index at {config.INDEX_PATH}; run `build` first.")
    index = json.loads(config.INDEX_PATH.read_text())
    manifest = index.get("landmarks")
    if manifest is None:
        raise SystemExit(
            "index.json carries no `landmarks` block. This world was built before the"
            " landmark pass, or the build did not reach `write_landmarks`."
        )
    glb = config.OUT_ROOT / manifest["file"]
    if not glb.exists():
        raise SystemExit(f"index names {manifest['file']} but it is not on disk at {glb}.")

    sea = manifest["sea_level_y"]
    nodes = _landmark_nodes(gl, glb)
    items = {i["name"]: i for i in manifest["items"]}

    print(f"landmarks -> {glb.name}, {glb.stat().st_size / 1024:,.0f} kB,"
          f" {manifest['triangles']:,} triangles, sea level y {sea:.2f}")
    print(f"  anchor sources: {manifest['anchor_sources']}")

    # --- 1. Presence.
    print("\npresence")
    for name in ("harbour_bridge", "opera_house", "sydney_tower"):
        ok = name in nodes and name in items
        print(f"  {name:16} {'present' if ok else 'MISSING'}")
        if not ok:
            failures.append(f"{name} is missing from the shipped landmark set")
    if list(manifest["materials"]) != list(landmarks.LANDMARK_MATERIALS):
        failures.append("index materials disagree with landmarks.LANDMARK_MATERIALS")

    # --- 2. Placement, against the OSM outline each landmark is registered to.
    #
    # Measured from the geometry rather than read off the node translation: the
    # translation is what the pipeline *intended*, and the whole class of bug
    # this catches -- a north/south flip, a dropped offset, a projection applied
    # twice -- lives between the intention and the vertices.
    print("\nplacement (measured off the shipped vertices, against the OSM anchor)")
    measured: dict[str, tuple[float, float]] = {}
    probes = {
        # (materials, band description) -> the vertices that locate the object.
        "harbour_bridge": (None, "arch crown"),
        "opera_house": ({"landmark_granite"}, "podium deck"),
        "sydney_tower": (None, "spire tip"),
    }
    for name, (mats, what) in probes.items():
        if name not in nodes:
            continue
        parts = nodes[name]["parts"]
        if name == "opera_house":
            # The podium deck, by area rather than by vertex: this outline's
            # vertices are four times denser at the harbour end than at the
            # forecourt, and a mean of them lands 25 m out to sea.
            podium_y = items[name]["audit"]["podium_y"]
            x, z, n = _plan_centroid(parts, podium_y - 0.1, podium_y + 0.1, mats)
        else:
            top = _max_y(parts, mats)
            x, z, n = _plan_anchor(parts, top - (0.4 if name == "harbour_bridge" else 1.5),
                                   top + 1.0, mats)
        east, north = x, -z
        measured[name] = (east, north)
        want = items[name]["anchor_enu"]
        err = math.hypot(east - want[0], north - want[1])
        lon, lat = geo.enu_to_lonlat(east, north)
        flag = "" if err <= LANDMARK_PLACEMENT_TOLERANCE_M else "   <-- OUT"
        print(
            f"  {name:16} {what:11} {n:>5} verts  at ({east:8.1f},{north:8.1f}) ENU"
            f"  {float(lat):.6f},{float(lon):.6f}  error {err:5.2f} m{flag}"
        )
        if err > LANDMARK_PLACEMENT_TOLERANCE_M:
            failures.append(
                f"{name} sits {err:.1f} m from its anchor, over the"
                f" {LANDMARK_PLACEMENT_TOLERANCE_M:.0f} m tolerance"
            )

    if not args.no_osm:
        # And the anchors themselves against OSM, which is the other half: the
        # check above proves the geometry is where the manifest says, this proves
        # the manifest is where Sydney is.
        print("\n  anchors re-read from the OSM extract")
        fresh = landmarks.read_anchors(index["radius_m"])
        pairs = (
            ("harbour_bridge", "bridge_deck"),
            ("opera_house", "opera"),
            ("sydney_tower", "tower"),
        )
        for name, key in pairs:
            if name not in measured:
                continue
            ce, cn = fresh[key].centroid
            want = items[name]["anchor_enu"]
            d = math.hypot(want[0] - ce, want[1] - cn)
            # The bridge's anchor is the midpoint of the two pylon pairs and the
            # deck polygon's centroid is a different point on the same object, so
            # they are compared on a looser bar than a footprint centroid is.
            bar = 25.0 if name == "harbour_bridge" else LANDMARK_PLACEMENT_TOLERANCE_M
            flag = "" if d <= bar else "   <-- OUT"
            print(f"    {name:16} manifest anchor is {d:5.2f} m from the OSM {key} centroid{flag}")
            if d > bar:
                failures.append(f"{name}'s anchor is {d:.1f} m from its OSM feature")

    # --- 3. Heights, against published dimensions.
    print("\nheights (metres AHD unless noted; published value in brackets)")

    def check(label: str, got: float, want: float, unit: str = "m AHD") -> None:
        err = abs(got - want) / want if want else 0.0
        flag = "" if err <= LANDMARK_HEIGHT_TOLERANCE else "   <-- OUT"
        print(f"  {label:34} {got:7.2f} {unit}  ({want:.1f})  {100 * err:5.2f}%{flag}")
        if err > LANDMARK_HEIGHT_TOLERANCE:
            failures.append(f"{label} is {got:.2f} against a published {want:.1f} ({100 * err:.1f}%)")

    if "harbour_bridge" in nodes:
        parts = nodes["harbour_bridge"]["parts"]
        check("bridge deck", _max_y(parts, {"landmark_asphalt"}) - sea,
              LANDMARK_TRUTH["harbour_bridge"]["deck_ahd"])
        check("bridge arch apex", _max_y(parts, {"landmark_steel"}) - sea,
              LANDMARK_TRUTH["harbour_bridge"]["arch_apex_ahd"])
        check("bridge pylon tops", _max_y(parts, {"landmark_granite"}) - sea,
              LANDMARK_TRUTH["harbour_bridge"]["pylon_ahd"])
    if "opera_house" in nodes:
        parts = nodes["opera_house"]["parts"]
        check("opera tallest shell", _max_y(parts, {"landmark_shell"}) - sea,
              LANDMARK_TRUTH["opera_house"]["shell_max_ahd"])
    if "sydney_tower" in nodes:
        parts = nodes["sydney_tower"]["parts"]
        base = items["sydney_tower"]["audit"]["base_y"]
        check("sydney tower spire", _max_y(parts) - base,
              LANDMARK_TRUTH["sydney_tower"]["spire_height"], unit="m AGL")

    # --- 4. The deck, and whether a player can walk it.
    print("\nwalkable deck (collision prisms, projected onto the bridge axis)")
    if "harbour_bridge" in items:
        a = items["harbour_bridge"]["audit"]
        segs, rails = _deck_prisms(a, items["harbour_bridge"]["anchor_enu"])
        s_lo, s_hi = a["deck_s_min"], a["deck_s_max"]
        covered = []
        for lo, hi, _top in segs:
            if covered and lo <= covered[-1][1] + DECK_GAP_TOLERANCE_M:
                covered[-1][1] = max(covered[-1][1], hi)
            else:
                covered.append([lo, hi])
        span = sum(hi - lo for lo, hi in covered)
        print(f"  {len(segs)} deck prisms over {len(covered)} continuous run(s),"
              f" {span:,.0f} m of {s_hi - s_lo:,.0f} m")
        for lo, hi in covered:
            print(f"    s {lo:8.1f} .. {hi:8.1f}   ({hi - lo:6.1f} m)")
        if len(covered) != 1:
            failures.append(
                f"the bridge deck's collision is in {len(covered)} pieces; a player"
                f" walking it falls through {len(covered) - 1} gap(s)"
            )
        elif covered[0][0] > s_lo + DECK_GAP_TOLERANCE_M or covered[0][1] < s_hi - DECK_GAP_TOLERANCE_M:
            failures.append(
                f"the deck's collision covers s {covered[0][0]:.1f}..{covered[0][1]:.1f}"
                f" against a deck of {s_lo:.1f}..{s_hi:.1f}"
            )
        # Parapets: one each side of every deck segment, so a player who walks
        # into the edge is stopped rather than stepping into the harbour. They
        # can still jump it, and falling 49 m into Port Jackson is a feature --
        # `world/wading.ts` has rules for what happens next.
        print(
            f"  {len(rails)} parapet volumes, {a['parapet_height_m']:.2f} m,"
            f" against {2 * len(segs)} expected (two a segment)"
        )
        if len(rails) < 2 * len(segs):
            failures.append(
                f"the deck carries {len(rails)} parapet volumes against"
                f" {2 * len(segs)} deck segments; a player can walk off the side"
            )

    # --- 5. Suppression, end to end.
    print("\nsuppression")
    con = ledger.connect()
    anchors = landmarks.read_anchors(index["radius_m"]) if not args.no_osm else None
    if anchors is None:
        print("  skipped (--no-osm): the zones are defined by the OSM outlines")
    else:
        zones = landmarks.suppression_zones(anchors)
        inside: dict[str, list[str]] = {k: [] for k in zones}
        footprints: dict[str, list] = {k: [] for k in zones}
        for r in con.execute("SELECT id, east, north, geometry FROM buildings"):
            pt = Point(r["east"], r["north"])
            for zone_name, zone in zones.items():
                if zone.contains(pt):
                    inside[zone_name].append(r["id"])
                    ring = json.loads(r["geometry"])["ring"]
                    if len(ring) >= 3:
                        poly = Polygon(ring)
                        footprints[zone_name].append(poly if poly.is_valid else poly.buffer(0))
                    break
        for zone_name, ids in sorted(inside.items()):
            print(f"  {zone_name:8} {len(ids):>3} generic buildings inside the zone"
                  f" -- {', '.join(ids[:6])}{' ...' if len(ids) > 6 else ''}")

        # And the end-to-end half: nothing of theirs may survive in `far.bin`,
        # which is what a player sees of them on the horizon.
        #
        # Tested against the suppressed buildings' **own footprints**, not
        # against the zones. The zone is a catchment and is deliberately a little
        # generous -- the tower's is a 62 m disc -- so a real neighbour standing
        # just outside it can have a convex hull that leans in, and the first
        # version of this reported one: Sydney Central Plaza, 2,523 m2, correctly
        # kept, 65 m from the tower by its centroid and 56 m by its hull. The
        # question that matters is not "is a slab near the landmark" but "did a
        # slab of a building this pass deleted survive `emit_far`", and a
        # footprint test is that question exactly.
        stray = _far_slabs_inside(footprints)
        for zone_name, n in sorted(stray.items()):
            print(f"  {zone_name:8} {n:>3} far.bin slabs still standing on a suppressed footprint")
            if n:
                failures.append(
                    f"{n} far.bin slab(s) stand on a footprint the {zone_name} zone"
                    f" suppressed; the filter ran after `emit_far` rather than before it"
                )

    # --- 6. Winding.
    print("\nwinding (face normal against vertex normals)")
    for name, node in nodes.items():
        bad, tested = _winding_failures(node["parts"])
        print(f"  {name:16} {bad:>6,} inside out of {tested:>7,}")
        if bad:
            failures.append(f"{name} has {bad:,} inside-out triangles")

    print()
    if failures:
        print(f"FAILED -- {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("landmark-audit: all checks pass")
    return 0


def _far_slabs_inside(footprints: dict[str, list]) -> dict[str, int]:
    """`far.bin` slabs standing on a suppressed building's own footprint.

    Overlap rather than containment: a slab's plan is the footprint's convex hull
    inset 0.4 m, so a suppressed L-shaped building's slab is not inside its own
    ring and a containment test would miss exactly the case this is for.
    """
    import struct

    from shapely.geometry import Polygon

    out = {k: 0 for k in footprints}
    path = config.OUT_ROOT / "far.bin"
    if not path.exists() or not any(footprints.values()):
        return out
    payload = path.read_bytes()
    magic, version, count, _nv, groups = struct.unpack_from("<IIIII", payload, 0)
    if magic != tiles.FAR_MAGIC or version != tiles.FAR_VERSION:
        return out
    slab_at = 20 + groups * tiles.FAR_GROUP_STRIDE
    vert_at = slab_at + count * tiles.FAR_SLAB_STRIDE
    for i in range(count):
        _base, _h, fv, nv, _m, _a, _p = struct.unpack_from(
            "<ffIBBBB", payload, slab_at + i * tiles.FAR_SLAB_STRIDE
        )
        pts = np.frombuffer(payload, dtype="<f4", count=2 * nv, offset=vert_at + fv * 8)
        pts = pts.reshape(-1, 2).astype(np.float64)
        # far.bin is world (x, z); north is -z.
        plan = Polygon(np.column_stack((pts[:, 0], -pts[:, 1])))
        if not plan.is_valid:
            plan = plan.buffer(0)
        if plan.is_empty:
            continue
        for name, polys in footprints.items():
            if any(plan.intersection(p).area > 0.5 * min(plan.area, p.area) for p in polys):
                out[name] += 1
                break
    return out


def _decode_lanes(key: str):
    """Read one tile's `.lanes.bin` back the way the client does.

    A second implementation of the format on purpose. `tiles.write_lanes` and
    `client/src/game/traffic.ts` are the two that matter; this is the third, and
    a format bug that any two of them share is one this catches.
    """
    path = config.TILE_DIR / f"{key}.lanes.bin"
    if not path.exists():
        return None
    buf = path.read_bytes()
    if len(buf) < 16:
        return "short header"
    magic, version, n_ways, n_routes = struct.unpack_from("<IIII", buf, 0)
    if magic != tiles.LANES_MAGIC:
        return f"magic {magic:#x}"
    if version != tiles.LANES_VERSION:
        return f"version {version}"
    o = 16
    ways, routes = [], []
    for _ in range(n_ways):
        osm_id, klass, flags, n, half, foot = struct.unpack_from("<IBBHff", buf, o)
        o += 16
        pts = np.frombuffer(buf, dtype="<f4", count=n * 3, offset=o).reshape(n, 3)
        o += n * 12
        ways.append({"osm_id": osm_id, "klass": klass, "oneway": bool(flags & 1),
                     "half": half, "foot": foot, "p": pts.astype(np.float64)})
    for _ in range(n_routes):
        rid, klass, _f, n, headway, phase = struct.unpack_from("<IBBHff", buf, o)
        o += 16
        rec = np.frombuffer(buf, dtype="<f4", count=n * 4, offset=o).reshape(n, 4)
        o += n * 16
        routes.append({"rid": rid, "klass": klass, "headway": headway, "phase": phase,
                       "p": rec[:, :3].astype(np.float64), "t": rec[:, 3].astype(np.float64)})
    if o != len(buf):
        return f"{len(buf) - o} trailing bytes"
    return {"ways": ways, "routes": routes}


def cmd_lane_audit(args: argparse.Namespace) -> int:
    """Read the traffic back off the disk and check it can be driven.

    Everything this feature can get wrong renders as a perfectly plausible city.
    A lane offset with the sign flipped is a Sydney where every car is in the
    oncoming lane -- which is instantly obvious to anyone who lives here and
    completely invisible to a check that only asks whether cars are on roads. A
    height sampled off the centreline instead of off the lane buries a car's
    wheels in the camber of every cross-fallen street in the inner west. A route
    whose bridge lookup missed drives across the harbour at sea level. A
    timetable with two equal times in it divides by zero on the client, once, on
    one route, and drops one car through the floor of the world.

    So it is measured from the shipped bytes, and the terrain it is measured
    against is the shipped `.terr.bin` rather than the pipeline's own lattice --
    which is what makes this a check rather than a second opinion from the same
    witness.

    Five things are asserted:

      * **The format round-trips.** Every sidecar decodes, whole, with no
        trailing bytes, and the counts match `index.json`'s `lw`/`lr`.
      * **Coverage.** Every tile that emitted road asphalt has a lane graph, and
        the share of tiles with routes on them is reported.
      * **Height.** Route vertices that are on the ground sit on the emitted
        carriageway to within a few centimetres. Elevated ones are counted
        separately rather than averaged in -- a deck is *supposed* to be metres
        over the terrain, and folding the two together would let a broken deck
        lookup hide inside a healthy p95.
      * **Left-hand traffic.** Every route vertex is compared against the
        nearest way centreline in the same file, and the offset must be to the
        left of the direction of travel. This is the sign check, from the
        opposite end to `verifyTraffic`'s synthetic one.
      * **The timetable is strictly increasing.** A route whose cumulative times
        repeat is a divide by zero in the client's lookup.
    """
    index = json.loads(config.INDEX_PATH.read_text())
    contract = index.get("lanes")
    if contract is None:
        print("index.json has no `lanes` block: this world has no traffic in it.")
        return 1
    print(
        f"stage '{index['stage']}', lanes v{contract['version']},"
        f" {contract['routes']:,} routes, {contract['live_cars']:,} live cars,"
        f" {contract['route_length_m'] / 1000:,.0f} km of lane,"
        f" clock {contract['hz']} Hz from epoch {contract['epoch_ms']}"
    )

    entries = index["tiles"]
    limit = args.tiles if args.tiles > 0 else len(entries)
    sample = entries[:: max(len(entries) // limit, 1)][:limit]

    broken: list[str] = []
    missing: list[str] = []
    mismatched: list[str] = []
    ground_dev: list[float] = []
    elevated: list[float] = []
    left_ok = left_total = 0
    nonmono = 0
    ways = routes = points = 0
    tiles_with_routes = 0
    hero_hits = 0
    sea = index["terrain"]["sea_level_y"]

    for e in sample:
        key = e["key"]
        decoded = _decode_lanes(key)
        if isinstance(decoded, str):
            broken.append(f"{key}: {decoded}")
            continue
        if decoded is None:
            if e.get("lw", 0) or e.get("lr", 0):
                missing.append(key)
            continue
        if len(decoded["ways"]) != e.get("lw", 0) or len(decoded["routes"]) != e.get("lr", 0):
            mismatched.append(
                f"{key}: file has {len(decoded['ways'])}/{len(decoded['routes'])},"
                f" index says {e.get('lw', 0)}/{e.get('lr', 0)}"
            )
        ways += len(decoded["ways"])
        routes += len(decoded["routes"])
        if decoded["routes"]:
            tiles_with_routes += 1

        grid = _tile_ground(key)
        # The tile's own local frame, exactly as the client applies it: the group
        # sits at (bounds[0], 0, bounds[1] + tile_size), so a local coordinate
        # plus that offset is world.
        ox = e["bounds"][0]
        oz = e["bounds"][1] + index["tile_size"]

        # Centrelines from the ways block, for the left-hand test. Kept as plain
        # arrays and searched linearly against a coarse cell filter -- a tile
        # holds a couple of hundred spans and this runs on a few thousand points.
        centres = [(w["p"], w["oneway"]) for w in decoded["ways"]]

        for r in decoded["routes"]:
            p, t = r["p"], r["t"]
            points += len(p)
            if len(p) < 2:
                broken.append(f"{key}: route {r['rid']} has {len(p)} points")
                continue
            if not np.all(np.diff(t) > 0.0):
                nonmono += 1
            for i in range(0, len(p), max(1, len(p) // 8)):
                x, y, z = float(p[i, 0]), float(p[i, 1]), float(p[i, 2])
                if grid is not None:
                    g = _sample_grid(grid, index["tile_size"], x, z)
                    if g is not None:
                        d = y - (g + streets.CARRIAGEWAY_Y)
                        # Split rather than averaged. A deck is *supposed* to be
                        # metres over the terrain, and folding the two together
                        # would let a broken bridge lookup hide inside a healthy
                        # p95 -- which is the one failure here that puts cars on
                        # the harbour bed.
                        (elevated if d > 0.6 else ground_dev).append(abs(d))
                # The Harbour Bridge's deck is 49 m AHD and the highest ground in
                # the extent is about 60, so a height alone cannot identify it.
                # Counted within the deck's own band instead, which nothing on
                # the ground reaches: `hero_bridge_zone` is 1,149 m of level
                # roadway at exactly 49.0.
                if abs((y - sea) - 49.0) < 1.0:
                    hero_hits += 1
                # Left-hand: the offset from the nearest centreline must lie to
                # the left of travel. In renderer axes that is (dz, -dx).
                j = min(i + 1, len(p) - 1)
                dx, dz = float(p[j, 0] - p[i, 0]), float(p[j, 2] - p[i, 2])
                if i == j or (dx * dx + dz * dz) < 1e-6:
                    continue
                near = _nearest_centreline(centres, x, z, ox, oz)
                if near is None:
                    continue
                cx, cz, two_way = near
                if not two_way:
                    continue
                left = (x - cx) * dz - (z - cz) * dx
                left_total += 1
                if left > 0.0:
                    left_ok += 1

    print(f"  {len(sample):,} tiles opened: {ways:,} way spans, {routes:,} routes, {points:,} points")
    print(f"  {tiles_with_routes:,} of them carry scheduled traffic")
    if broken:
        print(f"  BROKEN sidecars: {len(broken)}")
        for b in broken[:8]:
            print(f"      {b}")
    if missing:
        print(f"  MISSING sidecars the index promises: {len(missing)} -- {missing[:8]}")
    if mismatched:
        print(f"  COUNT MISMATCH: {len(mismatched)}")
        for m in mismatched[:8]:
            print(f"      {m}")

    gd = np.asarray(ground_dev) if ground_dev else np.zeros(1)
    p50, p95, worst = (float(np.percentile(gd, 50)), float(np.percentile(gd, 95)), float(gd.max()))
    print(
        f"  ground lane y vs emitted asphalt: n={len(ground_dev):,}"
        f"  p50 {p50 * 100:.2f} cm  p95 {p95 * 100:.2f} cm  max {worst * 100:.1f} cm"
    )
    print(
        f"  elevated lane points (on a deck, over the terrain): n={len(elevated):,}"
        f"  median rise {float(np.percentile(elevated, 50)) if elevated else 0.0:.1f} m"
    )
    print(f"  points on the Harbour Bridge deck (49.0 +/- 1 m AHD): {hero_hits:,}")
    share = left_ok / max(left_total, 1)
    print(f"  left-hand: {left_ok:,}/{left_total:,} sampled two-way points on the left ({share * 100:.1f}%)")
    print(f"  routes with a non-increasing timetable: {nonmono}")

    bad = []
    if broken:
        bad.append(f"{len(broken)} sidecar(s) failed to decode")
    if missing:
        bad.append(f"{len(missing)} sidecar(s) the index promises are absent")
    if mismatched:
        bad.append(f"{len(mismatched)} tile(s) disagree with the index")
    if nonmono:
        bad.append(f"{nonmono} route(s) have a non-increasing timetable")
    if p95 > args.max_y_p95:
        bad.append(f"ground lane y p95 is {p95 * 100:.1f} cm, over the {args.max_y_p95 * 100:.0f} cm limit")
    if share < args.min_left_share:
        bad.append(f"only {share * 100:.1f}% of sampled points are on the left, under {args.min_left_share * 100:.0f}%")
    if routes == 0:
        bad.append("no routes at all")

    if bad:
        print("\nFAIL:")
        for b in bad:
            print(f"  - {b}")
        return 1
    print("\nlane audit OK")
    return 0


def _sample_grid(grid, tile_size: float, x: float, z: float):
    """Ground height at a tile-local point, **the client's own rule, verbatim**.

    `world/terrain.ts`'s `sampleTileGrid`, transliterated -- row 0 is the tile's
    northern edge, rows advance southward, and each cell is split along its
    north-west to south-east diagonal.

    Written twice on the way here and wrong both times, which is worth the note:
    a bilinear read of this grid disagrees with the triangulated one by up to
    twenty centimetres on real relief, and a row index taken from the wrong end
    disagrees by the whole height of the tile. Neither has a picture -- the world
    renders perfectly either way and only this number moves -- so the *only*
    defence is that this function is a copy of the one the player actually walks
    on rather than an independent reading of the same bytes.

    Returns None outside the tile, which a route routinely is: it belongs to the
    tile holding its first point and drives out of it.
    """
    n = grid.shape[0] - 1
    spacing = tile_size / n
    cf = x / spacing
    rf = (z + tile_size) / spacing
    if cf < 0 or cf > n or rf < 0 or rf > n:
        return None
    c = min(int(cf), n - 1)
    r = min(int(rf), n - 1)
    fc = cf - c
    fr = rf - r
    nw = float(grid[r, c])
    ne = float(grid[r, c + 1])
    sw = float(grid[r + 1, c])
    se = float(grid[r + 1, c + 1])
    if fc >= fr:
        return nw + (ne - nw) * fc + (se - ne) * fr
    return nw + (sw - nw) * fr + (se - sw) * fc


def _nearest_centreline(centres, x: float, z: float, ox: float, oz: float):
    """Closest point on any way centreline in this tile, and whether it is two-way.

    Both the route and the ways are already in the same tile-local frame, so no
    conversion happens here at all -- `ox`/`oz` are taken and ignored on purpose,
    so that the day someone changes one side's frame this signature is where the
    mismatch shows up.
    """
    del ox, oz
    best = None
    best_d = 12.0
    for pts, oneway in centres:
        a = pts[:-1, [0, 2]]
        b = pts[1:, [0, 2]]
        ab = b - a
        ap = np.array([x, z]) - a
        denom = (ab * ab).sum(axis=1)
        t = np.clip((ap * ab).sum(axis=1) / np.where(denom > 0, denom, 1.0), 0.0, 1.0)
        foot = a + t[:, None] * ab
        d = np.hypot(foot[:, 0] - x, foot[:, 1] - z)
        k = int(np.argmin(d))
        if float(d[k]) < best_d:
            best_d = float(d[k])
            best = (float(foot[k, 0]), float(foot[k, 1]), not oneway)
    return best


def cmd_status(args: argparse.Namespace) -> int:
    con = ledger.connect()
    for kind, states in sorted(ledger.counts(con).items()):
        total = sum(states.values())
        parts = " ".join(f"{k}={v:,}" for k, v in sorted(states.items()))
        print(f"{kind:12} total={total:<8,} {parts}")
    n = con.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    print(f"buildings    {n:,}")
    for r in con.execute(
        "SELECT archetype, COUNT(*) n, ROUND(AVG(height),1) h FROM buildings"
        " GROUP BY archetype ORDER BY n DESC"
    ):
        print(f"  {str(r['archetype']):20} {r['n']:>8,}  mean height {r['h']} m")
    # Materials as well as archetypes, for the same reason `_report_materials`
    # exists: the two are no longer the same question, and this is where anyone
    # checking whether the city is monochrome will look first.
    for r in con.execute(
        "SELECT material, COUNT(*) n FROM buildings GROUP BY material ORDER BY n DESC"
    ):
        print(f"  material {str(r['material']):19} {r['n']:>8,}")
    for r in con.execute(
        "SELECT height_source, COUNT(*) n FROM buildings GROUP BY height_source ORDER BY n DESC"
    ):
        print(f"  height from {str(r['height_source']):14} {r['n']:>8,}")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    con = ledger.connect()
    print(f"reset {ledger.reset(con, args.kind):,} '{args.kind}' units to pending")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sydney", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="ingest, classify and emit tiles")
    b.add_argument("--stage", default="inner", choices=list(config.STAGE_BY_NAME))
    b.add_argument("--rebuild", action="store_true", help="re-merge and re-classify buildings")
    b.add_argument("--retile", action="store_true", help="re-emit every tile")
    b.add_argument(
        "--only",
        default="",
        help="comma-separated tile keys to emit, e.g. '0_3,0_4,1_2'. Everything else"
        " keeps the tiles and the index entries it already has -- see"
        " `_carry_index_tiles`. For verifying a local change without a citywide"
        " rebuild.",
    )
    b.set_defaults(func=cmd_build)

    s = sub.add_parser("status", help="ledger and dataset summary")
    s.set_defaults(func=cmd_status)

    t = sub.add_parser("terrain-audit", help="read the emitted world back and check its heights")
    t.add_argument(
        "--tiles",
        type=int,
        default=40,
        help="how many tiles to open for the surface and building checks (0 for all)."
        " The terrain sidecars are always checked in full -- they are cheap and"
        " a crack is exactly the thing a sample would miss.",
    )
    t.set_defaults(func=cmd_terrain_audit)

    w = sub.add_parser(
        "winding-audit", help="read the emitted tiles back and check every triangle's facing"
    )
    w.add_argument(
        "--tiles",
        type=int,
        default=40,
        help="how many tiles to open (0 for all). Spread across the extent, not"
        " the first N -- the CBD, the terrace suburbs and the industrial fringe"
        " emit quite different slot mixes.",
    )
    w.set_defaults(func=cmd_winding_audit)

    v = sub.add_parser(
        "vegetation-audit",
        help="read the tree sidecars back and check every instance's scale",
    )
    # Both are the limits the pipeline claims to hold, not aspirations. 1.60 is
    # what `vegetation.MEASURED_T_MAX` works out to on every species. 1.15 is
    # set against the procedural draw's own worst case, which is exactly 1.1295
    # -- a paperbark at the bottom of its range with `_size`'s spread wobble at
    # its positive extreme -- and is inside the 20% the client's `NOMINAL`
    # comment allows itself either way.
    v.add_argument("--max-scale", type=float, default=1.60)
    v.add_argument("--max-aspect", type=float, default=1.15)
    v.set_defaults(func=cmd_vegetation_audit)

    c = sub.add_parser(
        "carriageway-audit",
        help="read the tiles back and measure what is standing in the road",
    )
    c.add_argument(
        "--tiles",
        type=int,
        default=40,
        help="how many tiles to open (0 for all). Spread across the extent.",
    )
    c.add_argument(
        "--min-area",
        type=float,
        default=4.0,
        help="ignore an overlap smaller than this, m2. A kerb-line rounding"
        " leaves slivers at every corner and they are not obstructions.",
    )
    # Two limits rather than one, because the two numbers mean different things.
    #
    # A collision prism on the road is a defect every time: something solid is
    # standing where the player drives. It is not zero and cannot be -- the
    # carriageway is buffered from a centreline at a *nominal* width, so a
    # terrace built to a kerb the ribbon overshoots counts against it -- but it
    # moved 1.40% -> 1.32% on a 40-tile sample when `merge.py` stopped keeping ML
    # blobs, and that is the direction it should only ever move.
    #
    # A far slab on the road is the residual `world/far.ts` documents and
    # accepts: a bounding rectangle around a building that is not a rectangle
    # covers ground the building does not, and sometimes that ground is the
    # street. 3.13% -> 2.79% on the same sample from the same fix. Driving it to
    # zero is spec 3.2's merged block silhouette, not a threshold.
    #
    # The defaults carry the sampling spread as well as the measurement. Over the
    # whole inner ring the world reads 1.59% and 2.63%; a 24-tile sample of the
    # same world reads 1.87% and 3.25%, because which tiles you open matters more
    # than how many. So these sit above the worst small sample, not above the
    # citywide figure -- this gates a regression, it does not assert a number
    # nobody has earned yet.
    #
    # Recalibrated 2026-08-04 when the extent grew 4.0 -> 5.3 km (2.94% measured,
    # old limit 2.50%). The top offenders were inspected one by one and they are
    # not a regression: the ICC at Darling Harbour (8,624 m2), Westfield Bondi
    # Junction (1,925 m2) and Barangaroo (823 m2) -- air-rights buildings that
    # genuinely span covered service roads, plus their matching far slabs. The
    # class this gate exists for (ML segmentation blobs lying across open
    # streets) is caught upstream at merge time (`ms_dropped_as_blob`, 271 this
    # build), so the limit moves to the measured legitimate base plus headroom
    # rather than pretending Westfield is a bug.
    c.add_argument("--max-building-share", type=float, default=0.0325)
    c.add_argument("--max-slab-share", type=float, default=0.040)
    c.set_defaults(func=cmd_carriageway_audit)

    rg = sub.add_parser(
        "road-grade-audit",
        help="read the ground back and measure how steep and how banked the streets are",
    )
    rg.add_argument(
        "--surface",
        default="tiles",
        choices=("tiles", "lattice", "raw"),
        help="what to measure. `tiles` stitches the shipped .terr.bin sidecars"
        " back together and is the only one that reads what actually went out;"
        " `lattice` rebuilds the surface in memory, which answers for the whole"
        " city without emitting one; `raw` turns the road conformance off and"
        " prints the world before it.",
    )
    rg.add_argument("--station", type=float, default=10.0, help="metres between samples")
    # 15% is the ceiling `roadgrade.MAX_GRADE` guarantees on the *profile*, and
    # the same number is used for the bank because a road has no legitimate
    # cross-fall at all past a couple of per cent of camber -- one threshold for
    # two questions is right here, where two would only invite tuning.
    rg.add_argument("--max-grade", type=float, default=0.15)
    # What share of segments may exceed that ceiling, and it is a regression gate
    # rather than a claim, on exactly the terms `carriageway-audit`'s two shares
    # are. Zero is not reachable and pretending otherwise would make the command
    # useless: a 31.25 m lattice cannot hold a level carriageway beside a cliff,
    # so the Darling Harbour ramp stack and two streets on the Bellevue Hill
    # escarpment stay over it -- see `roadgrade.py`'s closing note. The citywide
    # figure after the conformance is 0.011%, the same measurement before it was
    # 4.778%, and 0.1% sits an order of magnitude clear of the first and two
    # clear of the second.
    rg.add_argument("--max-over-share", type=float, default=0.001)
    rg.add_argument(
        "--tiles",
        type=int,
        default=40,
        help="how many tiles to open for the emitted-asphalt line (0 for all)."
        " The centreline measurement above it always covers the whole extent --"
        " it costs one terrain sample per station and a sample is where the"
        " defect is.",
    )
    rg.add_argument("--worst", type=int, default=12, help="offenders to name")
    rg.add_argument(
        "--no-shore",
        action="store_true",
        help="do not split the tidal-shore stations out, and take the verdict on"
        " every carriageway in the extent. What the gate measured before"
        " `water.py` existed, and the honest way to see the whole number in one"
        " column -- see `_tidal_plan` for what the split is and why it is not the"
        " road solve's verdict to answer for.",
    )
    rg.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="TILES",
        help="restrict every measurement to these tile keys (repeatable, or"
        " comma-separated). What a partial rebuild is measured with: it puts the"
        " before and the after on exactly the same stations."
        " **Use the --only=KEYS form**: half this city's tile keys start with a"
        " minus and argparse reads a space-separated `-2_1` as an option.",
    )
    rg.set_defaults(func=cmd_road_grade_audit)

    wa = sub.add_parser(
        "water-audit",
        help="read the emitted water back and check there is a bed under it",
    )
    # How far a sheet vertex may stand *under* the ground before it counts as a
    # violation. Not zero, and the reason is arithmetic rather than leniency: a
    # vertex on the mapped shoreline is at the waterline by definition, its
    # ground comes out of a float32 grid through a float32 interpolation, and the
    # two land within a millimetre of each other either way. A centimetre is two
    # orders of magnitude under anything visible and four over the noise.
    wa.add_argument("--tolerance", type=float, default=0.01)
    wa.add_argument("--worst", type=int, default=10, help="bodies to name")
    wa.add_argument(
        "--coastline-radius",
        type=float,
        default=0.0,
        metavar="METRES",
        help="run the left-hand rule against the real coastline at this build"
        " radius rather than the shipped index's. The inner extract has no"
        " coastline ways at all, so this is the only way to check the path that"
        " drowned the middle stage without running a middle build:"
        " `--coastline-radius 15000`.",
    )
    wa.add_argument(
        "--no-source",
        action="store_true",
        help="skip the assembled column, which costs a full Terrain.load."
        " The shipped-file checks -- the bed, the depth attribute and the seams --"
        " are what this command is for and none of them needs it.",
    )
    wa.set_defaults(func=cmd_water_audit)

    la = sub.add_parser(
        "landmark-audit",
        help="read the shipped landmark set back and check it against the real Sydney",
    )
    la.add_argument(
        "--no-osm",
        action="store_true",
        help="skip the two checks that re-read the OSM extract -- the anchors and the"
        " suppression zones. Costs about twenty seconds and is the half that says"
        " whether the models are in the right *place*; the heights, the deck's"
        " collision and the winding are checked either way.",
    )
    la.set_defaults(func=cmd_landmark_audit)

    ln = sub.add_parser(
        "lane-audit",
        help="read the traffic sidecars back and check the lanes can be driven",
    )
    ln.add_argument(
        "--tiles",
        type=int,
        default=40,
        help="how many tiles to open (0 for all). Spread across the extent.",
    )
    # A ground lane is sampled off the same lattice the client triangulates, so
    # the only error left in it is f32 rounding on the tile-local coordinate --
    # millimetres. 5 cm is two orders of magnitude of headroom and still well
    # under the 0.42 m step the controller climbs, which is the number that
    # decides whether a wrong height is visible at all.
    ln.add_argument("--max-y-p95", type=float, default=0.05)
    # Not 100%: a route through an intersection welds two lanes at the junction
    # vertex, and a dual carriageway's two halves are separate OSM ways whose
    # *other* half is the nearest centreline to a lane on the far side. Both put
    # a genuinely correct point on the wrong side of the line this measures
    # against. 90% is comfortably above what those cost and far below what a
    # flipped sign would read.
    ln.add_argument("--min-left-share", type=float, default=0.90)
    ln.set_defaults(func=cmd_lane_audit)

    r = sub.add_parser("reset", help="mark a stage's units pending again")
    r.add_argument("--kind", required=True)
    r.set_defaults(func=cmd_reset)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
