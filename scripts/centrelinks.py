#!/usr/bin/env python3
"""Every Centrelink / Services Australia service centre in the extent, as a TS table.

Emits `client/src/game/centrelink-data.ts`: a frozen array of `{id, name, x, z}`
in world metres, which is the whole of what the game knows about where you can
claim. Run it by hand when the extract moves; nothing in the build calls it.

    cd pipeline && uv run python ../scripts/centrelinks.py

---------------------------------------------------------------------------
WHY THIS IS A SCRIPT AND A CHECKED-IN TABLE RATHER THAN A PIPELINE STAGE

Every other point feature in this project -- the powerups, the furniture, the
bikes -- rides a per-tile binary sidecar, because there are hundreds of
thousands of them and they are drawn by geometry that streams in and out with
the tile. There are **fifty-odd** Centrelinks in Greater Sydney. A sidecar for
fifty points would be fifty points that the *server* could not see until a
client happened to load the tile they are on, and the server is the side that
adjudicates a claim -- so the table has to be resident on both ends at boot,
which is exactly what a checked-in TS module is and exactly what a sidecar is
not. `game/teleport.ts`'s destination list makes the same call for the same
reason, at the same order of magnitude.

The consequence, stated so it is not discovered: **the table only changes when
somebody runs this.** A Centrelink that opens in Marsden Park next year is not
in the game until then. At fifty points and a government office's rate of
churn, that is the right trade.

---------------------------------------------------------------------------
WHAT COUNTS AS A CENTRELINK, AND WHY THE FILTER IS THREE CLAUSES

Services Australia's shopfronts are mapped inconsistently, which is the whole
difficulty. In this extract they appear as:

  * `amenity=social_facility` + `operator=Centrelink`, the tidy case;
  * `office=government` + `government=social_security` (or `welfare`), which is
    the tagging wiki's recommendation and is what the newer edits use;
  * and a great many that carry **nothing but a name** -- "Centrelink Bondi
    Junction", "Services Australia Parramatta" -- hung off a shop or an office
    node with no operator tag at all.

So the filter is a union of the three, and the name test is the one that finds
the most. It is deliberately a substring match on a lower-cased name rather
than a regex with word boundaries: "Medicare/Centrelink Service Centre" and
"Services Australia Access Point" both have to land, and neither is a form
anybody would predict.

**Access points and agents are kept.** A rural transaction centre with a
Services Australia terminal in it is, for this game's purposes, a place you can
claim -- and excluding them would thin the outer suburbs, which is exactly
where the drive to one is the interesting part.

Both nodes and closed ways are read, on `pipeline/sydney/powerups.py`'s own
finding about stations: a suburban shopfront is usually a node and a
purpose-built office is usually a building polygon, and reading only one layer
silently loses half of them. A polygon contributes its centroid.

---------------------------------------------------------------------------
DEDUPLICATION, AND WHY IT IS 60 m

One office is frequently mapped twice -- a node for the shopfront and a
polygon for the building it is in -- and occasionally three times when a
Medicare counter inside the same room is its own node. Two claim points 8 m
apart would be two claims, which is the one thing the seven-day timer exists to
prevent. So any point within `DEDUPE_M` of one already kept is dropped, keeping
whichever was seen first (nodes are read first, and a shopfront node sits on
the footpath where the player will actually be standing; a building centroid is
in the middle of the floor plate and can be behind a wall).

60 m is a long way for a duplicate and a short way for two real offices: the
closest genuine pair in Greater Sydney is several kilometres apart.

---------------------------------------------------------------------------
THE MANUAL BACKSTOP

`MANUAL` below is a list of the well-known offices with hand-looked-up
coordinates, and every one of them is emitted with `source: 'manual'` **only if
the extract did not already supply something within `DEDUPE_M` of it**. It
exists because an extract cut to a bbox, or an extract from a week when
somebody had retagged half of them, must not be able to produce a game with
four Centrelinks in it. If OSM has the office, OSM wins -- its position is
surveyed and these are read off a map.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

# Run from `pipeline/` under `uv run`, where `sydney` is the project package.
# Appended rather than inserted so a real installation wins over this.
sys.path.append(str(Path(__file__).resolve().parents[1] / "pipeline"))

from sydney import config, geo  # noqa: E402
from sydney.sources import osm  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "client" / "src" / "game" / "centrelink-data.ts"

# The whole extent. `config.STAGES[-1]` is the 60 km radius the world is built
# at, so the table covers exactly the city that exists.
RADIUS_M = config.STAGES[-1].radius_m

DEDUPE_M = 60.0
# The radius the hand-looked-up backstop is suppressed within. Two orders of
# magnitude looser than `DEDUPE_M` and deliberately so: a coordinate read off a
# map is good to a block, an OSM node is surveyed, and the failure this number
# prevents is *two claim points for one office* three hundred metres apart --
# which is two claims a week from one building and defeats the whole timer. The
# nearest two genuinely distinct offices in Greater Sydney are kilometres apart,
# so there is no real pair this can swallow.
MANUAL_DEDUPE_M = 500.0

GOV_HINTS = ("social_security", "welfare", "social_welfare")

# Keys whose presence means this node is a piece of transport or utility
# infrastructure and not a shopfront, whatever it is called.
#
# This list is the single most important line in the filter, and it was written
# against real false positives rather than imagined ones. Without it the table
# picks up the bus stops **named after** the office they are outside --
# "Centrelink, Broughton St", "Murray St opp Centrelink" -- which are two extra
# claim points on the far side of a road from the real one, and every NDB tower
# and radio transmitter in the basin, because they are operated by
# *Airservices* Australia and that string contains "services australia".
INFRASTRUCTURE_KEYS = (
    "highway", "railway", "public_transport", "aeroway", "power",
    "man_made", "natural", "waterway", "aerialway", "barrier",
)

# Accepted only at the **front** of a name, which is what separates the real
# thing from the three companies in this extent that end with the same two
# words: "Disability Services Australia", "Master Services Australia" and
# "Mobile Computer Services Australia" are all a business whose name happens to
# finish the way the agency's begins.
NAME_PREFIXES = ("centrelink", "services australia", "medicare/centrelink", "medicare and centrelink")


@dataclass
class Office:
    name: str
    x: float
    z: float
    source: str


def _wanted(tags: dict[str, str]) -> bool:
    if any(k in tags for k in INFRASTRUCTURE_KEYS):
        return False
    name = (tags.get("name") or "").lower().strip()
    if any(name.startswith(p) for p in NAME_PREFIXES):
        return True
    # A name that mentions the office somewhere other than the front is kept
    # only when a tag agrees it is one -- "Marrickville Metro Centrelink" is
    # real and "the cafe opposite Centrelink" is not.
    if "centrelink" in name and (
        tags.get("office") == "government" or tags.get("amenity") == "social_facility"
    ):
        return True
    operator = (tags.get("operator") or "").lower().strip()
    if operator.startswith("centrelink") or operator.startswith("services australia"):
        return True
    if tags.get("office") == "government" and tags.get("government") in GOV_HINTS:
        return True
    return False


def _title(tags: dict[str, str]) -> str:
    raw = (tags.get("name") or "").strip()
    if not raw:
        raw = "Centrelink"
    # "Centrelink Bondi Junction" reads better on a phone screen than the
    # bureaucratic long form, and the prefix is redundant beside a $ marker.
    for prefix in ("Services Australia - ", "Services Australia — ", "Services Australia "):
        if raw.startswith(prefix):
            raw = "Centrelink " + raw[len(prefix):]
            break
    return raw[:40]


def _keep(out: list[Office], candidate: Office, within: float = DEDUPE_M) -> None:
    for existing in out:
        if (existing.x - candidate.x) ** 2 + (existing.z - candidate.z) ** 2 < within**2:
            return
    out.append(candidate)


# Looked up by hand, lon/lat, WGS84. See the header: emitted only where the
# extract has nothing within `DEDUPE_M`.
MANUAL: tuple[tuple[str, float, float], ...] = (
    ("Centrelink Redfern", 151.1988, -33.8925),
    ("Centrelink Marrickville", 151.1553, -33.9114),
    ("Centrelink Leichhardt", 151.1567, -33.8836),
    ("Centrelink Bondi Junction", 151.2496, -33.8912),
    ("Centrelink Parramatta", 151.0043, -33.8158),
    ("Centrelink Blacktown", 150.9083, -33.7690),
    ("Centrelink Liverpool", 150.9240, -33.9243),
    ("Centrelink Bankstown", 151.0345, -33.9179),
    ("Centrelink Campsie", 151.1029, -33.9124),
    ("Centrelink Chatswood", 151.1810, -33.7967),
    ("Centrelink Hurstville", 151.1027, -33.9676),
    ("Centrelink Mount Druitt", 150.8180, -33.7690),
    ("Centrelink Penrith", 150.6940, -33.7511),
    ("Centrelink Campbelltown", 150.8140, -34.0650),
    ("Centrelink Hornsby", 151.0990, -33.7040),
    ("Centrelink Burwood", 151.1040, -33.8776),
    ("Centrelink Auburn", 151.0330, -33.8494),
    ("Centrelink Rockdale", 151.1373, -33.9522),
)


def main() -> int:
    bbox = geo.bbox_geodetic_for_radius(RADIUS_M)
    found: list[Office] = []

    # Nodes first -- a shopfront node is on the footpath, which is where the
    # player stands. See the header's note on dedupe order.
    for layer in ("points", "multipolygons"):
        geoms, attrs = osm._read_layer(osm.PBF_PATH, layer, bbox)
        for geom, tags in zip(geoms, attrs):
            if not _wanted(tags):
                continue
            point = geom if geom.geom_type == "Point" else geom.centroid
            east, north = geo.lonlat_to_enu(point.x, point.y)
            if (east * east + north * north) ** 0.5 > RADIUS_M:
                continue
            x, z = geo.enu_to_world(east, north)
            _keep(found, Office(_title(tags), float(x), float(z), "osm"))

    from_osm = len(found)

    for name, lon, lat in MANUAL:
        east, north = geo.lonlat_to_enu(lon, lat)
        x, z = geo.enu_to_world(east, north)
        _keep(found, Office(name, float(x), float(z), "manual"), MANUAL_DEDUPE_M)

    # A stable order, north to south then west to east, so a re-run with the
    # same data produces a byte-identical file and the diff is the change.
    found.sort(key=lambda o: (round(o.z, 1), round(o.x, 1)))

    rows = []
    for i, o in enumerate(found):
        ident = f"cl{i:03d}"
        name = o.name.replace("\\", "\\\\").replace("'", "\\'")
        rows.append(
            f"  {{ id: '{ident}', name: '{name}', x: {o.x:.1f}, z: {o.z:.1f}, "
            f"source: '{o.source}' }},"
        )

    body = HEADER.format(
        count=len(found),
        from_osm=from_osm,
        manual=len(found) - from_osm,
        radius=int(RADIUS_M),
        rows="\n".join(rows),
    )
    OUT.write_text(body, encoding="utf-8")
    print(f"{len(found)} offices ({from_osm} from OSM, {len(found) - from_osm} manual) -> {OUT}")
    return 0


HEADER = '''/**
 * Every Centrelink in Greater Sydney, at the coordinates OSM has for it.
 *
 * **Generated by `scripts/centrelinks.py`. Do not edit by hand** -- the next
 * run overwrites it, and the position of a government office is a fact about
 * Sydney rather than a decision this repo gets to make. {count} offices within
 * {radius} m of Town Hall: {from_osm} read out of the OSM extract and {manual}
 * from the script's hand-looked-up backstop, which fills in only where the
 * extract had nothing within 60 m. See the script's header for the tag filter,
 * the deduplication rule and why this is a checked-in table rather than a
 * per-tile sidecar like every other point feature in the project.
 *
 * `x` is east metres and `z` is south metres from the Town Hall origin, which
 * is the same frame everything else in `game/` speaks. There is deliberately no
 * `y`: the ground under a claim point is queried at runtime on whichever end is
 * asking, because the server's `groundFor` and the client's composed ground
 * query are the one pair of things in this project that must agree, and a baked
 * height would be a third opinion.
 *
 * Imported by `game/cash.ts` (the claim rule), by the phone's Centrelink app,
 * and by both maps' markers. Three-free, so the server reads the same table.
 */

/** One service centre. `source` is provenance and nothing reads it but a check. */
export interface CentrelinkOffice {{
  /** Stable for the life of the table; what a claim record is keyed on. */
  readonly id: string;
  readonly name: string;
  /** World metres, east and south of Town Hall. */
  readonly x: number;
  readonly z: number;
  readonly source: 'osm' | 'manual';
}}

export const CENTRELINKS: readonly CentrelinkOffice[] = [
{rows}
];
'''


if __name__ == "__main__":
    raise SystemExit(main())
