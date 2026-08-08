"""Hexagonal segments: the unit the world is built, published and streamed in.

`EXPANSION.md` is the argument; this module is the arithmetic. The short of it:
at 60 km the world is ~20 GB and every whole-world artefact -- the index, the
street-name bundle, the far skyline -- grows linearly with the map and is
fetched before the player has moved. The world therefore becomes **segments**,
and a segment is a hexagon.

---------------------------------------------------------------------------
WHY A HEXAGON, and why not the concentric rings that were the obvious answer.

A ring's area grows as r^2, so the 42-60 km ring is ~8,000 tiles against the
core's 3,187: the units get *bigger* the further out you go, which is the exact
opposite of the user's "not all at once". Hexagons are equal-area by
construction, so every build, every upload and every player download is the same
size wherever it is.

Three properties then earn their place, and all three are used by name below:

  * **Six equidistant neighbours.** A square grid has neighbours at 1 and at
    sqrt(2), so a prefetch radius either over-fetches the diagonals or
    under-fetches them. Every neighbour of a hex is `sqrt(3) * R` away
    (`NEIGHBOUR_SPACING`), which makes "load the ring around me" one rule rather
    than a tuned constant.
  * **No corner convergence.** Rings all meet at the origin, so the busiest part
    of the map is where the boundaries are thinnest. Hexes tile uniformly.
  * **Boundaries that are not circles.** A ring boundary is a curve every tile
    near it straddles. A hex boundary is six straight lines, and a 500 m tile is
    assigned to a hex **by its centre**, so assignment is total and unambiguous:
    every tile lands in exactly one hex, and no tile lands in two.

---------------------------------------------------------------------------
THE GRID. Flat-top hexes on an axial (q, r) lattice in **ENU metres** -- east
and north, the frame `index.json`'s tile bounds are already written in. No H3
and no dependency: the world has a Cartesian origin and this is thirty lines.

    centre(q, r) = ( 1.5 * R * q ,  sqrt(3) * R * (q/2 + r) )

`CIRCUMRADIUS_M` is 6,000: 93.5 km^2, ~374 emitted tiles in a fully built hex,
small enough to build in under an hour and upload in minutes, big enough that
the 60 km disc needs ~121 of them rather than thousands.

---------------------------------------------------------------------------
THE IDS ARE THE POINT, and they are the one thing here that must never change.

`h-01+01` is axial (q=-1, r=+1), signed and zero-padded so it sorts, greps and
reads the same everywhere: a filename, an R2 prefix, a client cache key and a
log line. Two digits reach +/-99 hexes, which is +/-891 km.

The id is a pure function of `(tile centre, CIRCUMRADIUS_M)` and of nothing
else. It does not know the world's radius, how many tiles were emitted, or which
of its neighbours exist -- so **growing the world cannot renumber a hex**. A
client that cached `h-01+01` against the 19.3 km build is still looking at the
same 93.5 km^2 of Sydney after the 60 km build lands, which is what makes an
incremental publish possible at all. `verifyHexes` on the client and the
`hex arithmetic` block in `server/integration-check.ts` both hold that property
down explicitly.
"""

from __future__ import annotations

import json
import math
import re
import struct
from collections import defaultdict
from pathlib import Path

# --- The grid ----------------------------------------------------------------

#: Centre-to-vertex, metres. See the module docstring for why 6 km.
CIRCUMRADIUS_M = 6_000.0

#: Bumped when the layout of a hex manifest or the root index changes. The
#: client refuses a version it does not know rather than reading a future one.
HEX_VERSION = 1

_SQRT3 = math.sqrt(3.0)

#: Centre-to-centre for all six neighbours. The number the client's approach
#: rule is sized against; see `client/src/world/hexes.ts`.
NEIGHBOUR_SPACING_M = _SQRT3 * CIRCUMRADIUS_M

_ID_RE = re.compile(r"^h([+-]\d\d)([+-]\d\d)$")


def hex_id(q: int, r: int) -> str:
    """`h-01+01`. Signed, zero-padded, sortable, and stable for ever."""
    return f"h{q:+03d}{r:+03d}"


def parse_hex_id(hid: str) -> tuple[int, int]:
    """The inverse of `hex_id`. Raises on anything that is not one."""
    m = _ID_RE.match(hid)
    if m is None:
        raise ValueError(f"not a hex id: {hid!r}")
    return int(m.group(1)), int(m.group(2))


def axial_of(east: float, north: float, radius: float = CIRCUMRADIUS_M) -> tuple[int, int]:
    """Which hex a point is in. Flat-top pixel-to-hex, then a cube round.

    The cube round is the part that makes assignment *total*: the fractional
    axial coordinate is lifted to cube space, all three components are rounded,
    and the one that moved furthest is recomputed from the other two so the
    constraint `x + y + z == 0` is restored exactly. Every point in the plane
    therefore lands on exactly one hex, including the points on a boundary --
    which is why a tile is assigned by its centre and never by its bounds.
    """
    fq = (2.0 / 3.0) * east / radius
    fr = (-east / 3.0 + _SQRT3 / 3.0 * north) / radius
    fs = -fq - fr
    q, r, s = round(fq), round(fr), round(fs)
    dq, dr, ds = abs(q - fq), abs(r - fr), abs(s - fs)
    if dq > dr and dq > ds:
        q = -r - s
    elif dr > ds:
        r = -q - s
    return int(q), int(r)


def centre_of(q: int, r: int, radius: float = CIRCUMRADIUS_M) -> tuple[float, float]:
    """The hex's centre in ENU metres, `(east, north)`."""
    return (1.5 * radius * q, _SQRT3 * radius * (q / 2.0 + r))


def corners_of(q: int, r: int, radius: float = CIRCUMRADIUS_M) -> list[tuple[float, float]]:
    """The six vertices, anticlockwise from due east. Flat-top, so corner 0 is
    the one on the +east axis and there is a vertex rather than an edge there."""
    cx, cn = centre_of(q, r, radius)
    return [
        (cx + radius * math.cos(math.pi / 3.0 * i), cn + radius * math.sin(math.pi / 3.0 * i))
        for i in range(6)
    ]


def bounds_of(q: int, r: int, radius: float = CIRCUMRADIUS_M) -> list[float]:
    """The hexagon's axis-aligned box, `[minE, minN, maxE, maxN]`.

    Shipped in the root index so the client can reject a hex on four compares
    before it does any hexagon arithmetic at all -- the same shape as a region
    bundle's `bounds`. It is the *box*, not the hexagon, and it overlaps its
    neighbours' boxes; nothing is assigned from it.
    """
    cx, cn = centre_of(q, r, radius)
    apothem = _SQRT3 / 2.0 * radius
    return [
        round(cx - radius, 3),
        round(cn - apothem, 3),
        round(cx + radius, 3),
        round(cn + apothem, 3),
    ]


def tile_centre(entry: dict) -> tuple[float, float]:
    """A tile's centre in ENU metres, from its `index.json` bounds.

    `bounds` is `[minE, minN, maxE, maxN]` -- north-positive, which is *not* the
    renderer's frame. Read off the bounds rather than recomputed from the key so
    there is one statement of the tile grid in this file and it is the index's.
    """
    b = entry["bounds"]
    return ((float(b[0]) + float(b[2])) / 2.0, (float(b[1]) + float(b[3])) / 2.0)


def assign(entries: list[dict], radius: float = CIRCUMRADIUS_M) -> dict[str, list[dict]]:
    """Every entry filed under exactly one hex id, by its centre.

    Works for tiles and for region bundles alike -- both carry `key` and
    `bounds` in the same frame, which is the whole reason a region needs no
    concept of its own here. Hexes sit *above* regions: a region is a square
    kilometre of tile payloads, a hex is the manifest that says those regions
    exist at all.
    """
    out: dict[str, list[dict]] = defaultdict(list)
    for entry in entries:
        east, north = tile_centre(entry)
        q, r = axial_of(east, north, radius)
        out[hex_id(q, r)].append(entry)
    return dict(out)


# --- far.bin, re-sliced ------------------------------------------------------

_FAR_MAGIC = 0x53524146  # b"FARS"
_FAR_HEADER = 20
_FAR_GROUP = 16
_FAR_SLAB = 16
_FAR_VERT = 8


def split_far(payload: bytes, hex_of_tile: dict[str, str]) -> dict[str, bytes]:
    """`far.bin`, cut into one file per hex, with nothing re-derived.

    The format already carries the only thing this needs: it is **grouped by
    tile**, ascending by key, because a slab has to be taken off screen the
    moment the streamer loads the real building inside it. So a per-hex far file
    is a selection of whole groups plus a renumbering of the two indices that
    point into the arrays behind them -- `first slab` and `first vert`. No
    geometry is recomputed, no float is touched, and a slab's bytes in
    `h-01+01.far.bin` are the same bytes it had in `far.bin`.

    A tile with no entry in `hex_of_tile` is one the index does not list, which
    is not a state a coherent build can be in; it is dropped rather than filed
    under a guess, and `cmd_hex_pack` reports the count.

    See `tiles.write_far` for the layout and `client/src/world/far.ts` for the
    reader. Both are unchanged: a per-hex far file is an ordinary `far.bin`
    holding a subset of the city.
    """
    if len(payload) < _FAR_HEADER:
        return {}
    magic, version, slab_count, vert_count, group_count = struct.unpack_from("<IIIII", payload, 0)
    if magic != _FAR_MAGIC:
        raise ValueError("far.bin has the wrong magic")

    groups_at = _FAR_HEADER
    slabs_at = groups_at + group_count * _FAR_GROUP
    verts_at = slabs_at + slab_count * _FAR_SLAB
    end = verts_at + vert_count * _FAR_VERT
    if len(payload) < end:
        raise ValueError("far.bin is truncated")

    picked: dict[str, list[tuple[int, int, int, int]]] = defaultdict(list)
    for g in range(group_count):
        tx, tz, first, count = struct.unpack_from("<iiII", payload, groups_at + g * _FAR_GROUP)
        hid = hex_of_tile.get(f"{tx}_{tz}")
        if hid is None:
            continue
        picked[hid].append((tx, tz, first, count))

    out: dict[str, bytes] = {}
    for hid, groups in picked.items():
        groups.sort(key=lambda g: (g[0], g[1]))
        new_groups = bytearray()
        new_slabs = bytearray()
        new_verts = bytearray()
        slab_n = vert_n = 0
        for tx, tz, first, count in groups:
            new_groups += struct.pack("<iiII", tx, tz, slab_n, count)
            for i in range(first, first + count):
                at = slabs_at + i * _FAR_SLAB
                base_y, height, fv, nverts = struct.unpack_from("<ffIB", payload, at)
                # The record is copied verbatim apart from `first vert`, which is
                # an offset into an array this file is rebuilding. Bytes 12..16
                # -- vert count, material, archetype, reserved -- ride along
                # untouched, so a future field added there survives this pass.
                new_slabs += payload[at : at + 8]
                new_slabs += struct.pack("<I", vert_n)
                new_slabs += payload[at + 12 : at + 16]
                new_verts += payload[verts_at + fv * _FAR_VERT : verts_at + (fv + nverts) * _FAR_VERT]
                vert_n += nverts
                slab_n += 1
        out[hid] = (
            struct.pack("<IIIII", _FAR_MAGIC, version, slab_n, vert_n, len(groups))
            + bytes(new_groups)
            + bytes(new_slabs)
            + bytes(new_verts)
        )
    return out


def far_stats(payload: bytes) -> dict:
    """Slab, vertex and triangle counts for one far payload, for the contract."""
    _, _, slabs, verts, groups = struct.unpack_from("<IIIII", payload, 0)
    return {
        "count": slabs,
        "plan_verts": verts,
        "groups": groups,
        "bytes": len(payload),
        "triangles": 3 * verts - 2 * slabs,
        "vertices": 2 * verts,
    }


# --- The root index ----------------------------------------------------------

#: Keys lifted out of `index.json` into the per-hex manifests. Everything else
#: is small, whole-world and describes the build rather than the map, so it
#: stays in the root index where the client reads it once.
SEGMENTED_KEYS = ("tiles",)


def root_index(index: dict, hexes: list[dict], contract: dict) -> dict:
    """`root.json`: `index.json` with the two linear-in-the-map lists taken out.

    **A new file rather than a smaller `index.json`**, and that is the decision
    that keeps this round cheap. `index.json` is read off the disk by
    `server/world.ts`, by seven of the pipeline's audits and by every check in
    `server/integration-check.ts` that wants to know what was built; making it
    segmented would drag the authoritative simulation into a round that is meant
    to be about distribution. So it stays exactly as it is, is still published,
    and is still what an older client loads. `root.json` is what a segmented
    client boots from, and a client that cannot find one falls back to
    `index.json` and loads the world the way it always did.

    `regions.list` goes with `tiles`: it is 852 entries and ~90 kB today, it
    grows with the map exactly as the tile list does, and a region is a square
    kilometre inside exactly one hex. The `regions` *contract* -- version,
    directory, tile count per side, trigger distance -- stays here, because the
    client has to know those before it has any hex at all.
    """
    root = {k: v for k, v in index.items() if k not in SEGMENTED_KEYS}
    regions = index.get("regions")
    if isinstance(regions, dict):
        root["regions"] = {k: v for k, v in regions.items() if k != "list"}
    root["hexes"] = {**contract, "list": hexes}
    return root


def write_json(path: Path, payload: dict) -> int:
    """One JSON file, compact, and the byte count it came to."""
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, separators=(",", ":"))
    path.write_text(raw)
    return len(raw)
