"""Tile emission: glTF geometry, the facade parameter buffer, and collision.

One tile produces up to nine files:

  tiles/<tx>_<tz>.glb          geometry, merged by material
  tiles/<tx>_<tz>.params.bin   per-building facade parameters, 16 floats each
  tiles/<tx>_<tz>.terr.bin     terrain post grid, 17 x 17 float32
  tiles/<tx>_<tz>.veg.bin      tree instances, 20 bytes each
  tiles/<tx>_<tz>.cars.bin     parked car instances, 16 bytes each
  tiles/<tx>_<tz>.power.bin    power poles, 20 bytes each, plus wire spans
  tiles/<tx>_<tz>.furn.bin     wheelie bins, street-name posts, traffic signals
  tiles/<tx>_<tz>.pow.bin      spec 8.3's powerups, 16 bytes each
  tiles/<tx>_<tz>.names.bin    named street centrelines, for the map readout
  tiles/<tx>_<tz>.water.bin    the water surface over this tile, as a mesh
  collision/<tx>_<tz>.bin      simplified prisms, for the server

Plus five files that belong to no tile at all and are written once for the whole
build -- `far.bin` and `far-terrain.bin`, the always-resident far layer (see
`emit_far` at the bottom of this module), `far-water.bin`, the harbour at the
scale the horizon needs it (see `emit_water`), `suburbs.json`, the suburb
label nodes the readout names a place from (see `write_suburbs`), and
`street-names.bin`, every tile's named centrelines repacked into one file for
the big map (see `write_street_name_bundle`).

The five instance sidecars, the names sidecar and the water sidecar are written
only when the tile has something in them, and deleted when it does not, so a
tile that loses its last tree, its last car, its last pole, its last bin, its
last named street or its last square metre of harbour in a rebuild cannot leave
a stale file behind for the client to load.

Vertex positions are tile-local metres, so a tile 15 km out is as precise as one
at the origin -- the tile's world offset lives in the index and is applied by the
client as a node translation.

Collision is emitted separately and is always the simplified prism, per spec
section 5. The server loads these directly and never sees a render mesh.
"""

from __future__ import annotations

import json
import math
import struct
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pygltflib as gl

from . import (
    config,
    contact,
    creeks,
    decks,
    fences,
    furniture,
    lanes,
    mesh,
    meshpack,
    parking,
    power,
    powerups,
    streets,
    vegetation,
    water,
)
from .merge import Building

COMPONENT_FLOAT = 5126
COMPONENT_UINT = 5125
COMPONENT_UBYTE = 5121
TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY = 34963

# The worst reconstruction error `meshpack` produced anywhere in this process's
# tiles, in metres and degrees. Module state rather than a return value because
# `write_glb` is called from a worker loop whose signature is load-bearing in
# four places, and because the question this answers -- "how far did the whole
# *build* move?" -- is not a question about one tile. `cli.py` reads it into the
# index's `geometry` block, which is where a rebuild can be audited against the
# claim that the drift is invisible.
PACK_ERROR = {"position_m": 0.0, "uv_m": 0.0, "normal_deg": 0.0}


def _note_pack_error(worst: dict[str, float]) -> None:
    for key, value in worst.items():
        PACK_ERROR[key] = max(PACK_ERROR[key], value)

# `.furn.bin`'s header. The only versioned sidecar in the build, and see
# `write_furniture` for why this one earned a header when the other five did
# not: its post record changed shape rather than growing, so a v1 file and a v2
# file cannot be told apart by length. ASCII 'FURN' little-endian.
#
# **Must match `FURN_MAGIC` and `FURN_VERSION` in
# `client/src/world/furniture.ts`.**
FURN_MAGIC = 0x4E525546
FURN_VERSION = 2

# `.water.bin`'s header, and `far-water.bin`'s -- one format, written twice, at
# two scales. ASCII 'WATR' little-endian.
#
# Versioned from the first byte, unlike the five instance sidecars: this one
# carries a *mesh*, so its record is already variable-length and there is no
# length check that could stand in for a version. See `write_water`.
#
# **Must match `WATER_MAGIC` and `WATER_VERSION` in
# `client/src/world/water.ts`.**
WATER_MAGIC = 0x52544157
WATER_VERSION = 1

# `.lanes.bin`'s header. ASCII 'LANE' little-endian, and versioned from the
# first byte for `write_water`'s reason -- it carries two variable-length blocks
# and no length check could stand in for a version.
#
# **Must match `LANES_MAGIC` and `LANES_VERSION` in
# `client/src/game/traffic.ts`.**
LANES_MAGIC = lanes.LANES_MAGIC
LANES_VERSION = lanes.LANES_VERSION


@dataclass
class TileResult:
    key: str
    # Building rings **in the collision payload**, which is what the index ships
    # as `b`. Not `len(buildings)`: a footprint that degenerated is not in the
    # payload and is not a wall, and both authorities subtract this number from
    # the payload's count word to find the decks. See `write_collision`.
    buildings: int
    triangles: int
    glb_bytes: int
    params_bytes: int
    collision_bytes: int
    bounds: tuple[float, float, float, float]  # world x/z min/max
    height_max: float
    trees: int = 0
    cars: int = 0
    poles: int = 0
    # Wire spans whose midpoint falls in this tile. Tracked separately from the
    # poles because the two are not the same set: a span belongs to the tile
    # holding its midpoint and its poles may both be in the tile next door, so a
    # tile can carry spans and no poles at all. The client's fetch test is the
    # union of the two -- see `write_index`.
    spans: int = 0
    # Street furniture standing in this tile: wheelie bins, street-name posts and
    # traffic signal heads. One count per kind rather than a total, because they
    # are three different instanced meshes on the client and a total would hide
    # which of them a tile actually has -- but the client's fetch test is the
    # union, since all three share `.furn.bin`.
    bins: int = 0
    posts: int = 0
    signals: int = 0
    # Spec 8.3's powerups standing in this tile -- station entrances and cafes,
    # one count rather than one per kind. Unlike the furniture's three, the two
    # kinds here share a sidecar *and* a client module and a tile that has one
    # kind and not the other needs no separate decision, so the fetch test and
    # the build decision are the same number.
    powerups: int = 0
    # Named street centreline runs in this tile's `.names.bin`, and what the file
    # costs. The count is the client's fetch test; the bytes are here because
    # this is the one sidecar whose size is a function of how much *street*
    # crosses a tile rather than how many objects stand on it, so it is the one
    # the build report has to be able to add up.
    street_names: int = 0
    names_bytes: int = 0
    # This tile's water surface, in `.water.bin`. The vertex count is the
    # client's fetch test -- like every other count here -- and the triangle
    # count is what the frame pays for it. `water_y` is the level of the sheet
    # with the most area on this tile, and it is the one number in this record
    # that gameplay reads: the wading rule is derived from it on both the client
    # and the server. See `client/src/world/wading.ts`.
    water_verts: int = 0
    water_tris: int = 0
    water_bytes: int = 0
    water_y: float = 0.0
    water_area: float = 0.0
    # This tile's `.lanes.bin`: the drivable street network as reusable
    # geometry, and the traffic timetable on it. Three counts and a size, for
    # the same reason the furniture has three: they are different things sharing
    # one sidecar and a total would hide which of them a tile actually has. The
    # client's fetch test is the union of the first two -- a tile with ways and
    # no routes is a cul-de-sac suburb, which is common, and a pedestrians pass
    # will want its footpath geometry even where no car drives.
    #
    # `lane_cars` is not in the file at all: it is the number of cars *live* on
    # this tile's routes at any instant, summed off the timetable, and it is here
    # so a build report can state the city's traffic density without decoding
    # 228 sidecars.
    lane_ways: int = 0
    lane_routes: int = 0
    lane_cars: int = 0
    lanes_bytes: int = 0
    # Ground height range over the tile, metres above the datum. Reported so a
    # build can be checked for relief without opening a sidecar.
    ground_min: float = 0.0
    ground_max: float = 0.0


def _accessor_min_max(arr: np.ndarray, components: int) -> tuple[list[float], list[float]]:
    m = arr.reshape(-1, components)
    return m.min(axis=0).tolist(), m.max(axis=0).tolist()


def _attribute(
    values: list[float], components: int, vertices: int, slot: str, name: str
) -> np.ndarray | None:
    """One optional vertex attribute column, checked against the vertex count.

    Empty means the slot does not carry this attribute at all, which is a
    decision `mesh.MeshBuffers.add_surface` records per slot. Any other length
    mismatch is a slot whose vertices were added two different ways, which glTF
    does not check and which the client would read straight off the end of, so
    it is refused here rather than shipped.
    """
    if not values:
        return None
    if len(values) != vertices * components:
        raise ValueError(
            f"slot '{slot}' has {len(values) // components} {name} values for"
            f" {vertices} vertices. Every vertex in a slot must be added the same"
            f" way -- see `mesh.MeshBuffers.add_surface`."
        )
    return np.asarray(values, dtype=np.float32)


def write_glb(
    path: Path,
    slots: dict[str, mesh.MeshBuffers],
) -> tuple[int, int]:
    """Write one GLB containing a mesh primitive per material slot.

    Returns (bytes written, triangle count). Building primitives carry the custom
    `_BLDIDX` attribute, which is the index into the tile's parameter buffer --
    this is what lets a single draw call render thousands of buildings that each
    have their own facade grammar. Street primitives have no building and omit it;
    the client's attribute fix-up is a no-op when it is absent.

    Three attributes beyond POSITION are optional and every one of them is
    omitted rather than filled with a constant, because a column of zeroes over
    a million vertices is a megabyte the player downloads to ignore:

      NORMAL, TEXCOORD_0   absent on the contact skirt, which is drawn unlit and
                           untextured -- 20 bytes a vertex over 816,352 of them,
                           which is 16.3 MB of the inner ring
      COLOR_0              present only on the contact skirt, whose whole shading
                           is one baked alpha ramp. Written as normalised
                           unsigned bytes, not floats: the ramp runs 0 to 140 of
                           255 and u8 resolves every step of it, so float32 would
                           be another 9.8 MB spent on precision the gradient
                           cannot use.

    A slot that fills an attribute for some of its vertices and not others would
    produce a primitive whose accessors disagree about how many vertices there
    are, which glTF does not check and the client would read straight off the
    end of. `_attribute` raises instead.

    **Every column here is packed by `sydney.meshpack`** -- quantised per axis
    where it can be, narrowed where it must stay exact, and delta-coded before
    it is written. That module carries the whole argument and the measurements;
    what matters at this call site is that the *shape* of the file is unchanged
    (one buffer, one node, one primitive per material slot, no interleaving) and
    that `client/src/world/tile-decode.ts` is the other half of the format.
    """
    blob = bytearray()
    views: list[gl.BufferView] = []
    accessors: list[gl.Accessor] = []
    primitives: list[gl.Primitive] = []
    triangles = 0
    worst = {"position_m": 0.0, "uv_m": 0.0, "normal_deg": 0.0}

    def push(data: bytes, target: int | None) -> int:
        # glTF requires accessor-aligned buffer views; 4 bytes covers float and
        # uint32, the only component types used here.
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(data)
        views.append(gl.BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target))
        return len(views) - 1

    def add_packed(packed: meshpack.Packed, target: int, gauge: str | None = None) -> int:
        """One packed column as a glTF accessor, plus its dequantisation.

        `min`/`max` are written only for POSITION, which is the one accessor the
        spec requires them on. Dropping them everywhere else is worth doing
        rather than tidy: they are six full-precision floats per accessor
        against a JSON chunk that is now a fifth of the file, and nothing --
        neither `parseTileGlb` nor `GLTFLoader` on the path this client uses --
        reads them.
        """
        if gauge is not None:
            worst[gauge] = max(worst[gauge], packed.max_error)
        view = push(packed.data.tobytes(), target)
        accessor = gl.Accessor(
            bufferView=view,
            componentType=packed.component_type,
            count=len(packed.data) // packed.components,
            type=packed.type_str,
            normalized=packed.normalized,
        )
        if target == TARGET_ARRAY_BUFFER and packed.type_str == "VEC3" and gauge == "position_m":
            lo, hi = _accessor_min_max(packed.data, packed.components)
            accessor.min, accessor.max = lo, hi
        if packed.extras is not None:
            accessor.extras = packed.extras
        accessors.append(accessor)
        return len(accessors) - 1

    for material_name, buf in slots.items():
        if not buf.indices:
            continue
        pos = np.asarray(buf.positions, dtype=np.float32)
        idx = np.asarray(buf.indices, dtype=np.uint32)
        vertices = len(pos) // 3

        nrm = _attribute(buf.normals, 3, vertices, material_name, "NORMAL")
        uv = _attribute(buf.uvs, 2, vertices, material_name, "TEXCOORD_0")
        col = _attribute(buf.colours, 4, vertices, material_name, "COLOR_0")

        attrs = gl.Attributes(
            POSITION=add_packed(meshpack.pack_positions(pos), TARGET_ARRAY_BUFFER, "position_m"),
        )
        if nrm is not None:
            attrs.NORMAL = add_packed(
                meshpack.pack_normals(nrm), TARGET_ARRAY_BUFFER, "normal_deg"
            )
        if uv is not None:
            attrs.TEXCOORD_0 = add_packed(meshpack.pack_uvs(uv), TARGET_ARRAY_BUFFER, "uv_m")
        if col is not None:
            # Rounded rather than truncated, so 0.55 stores as 140/255 = 0.549
            # and not as 139. Already one byte a component, so `meshpack` leaves
            # it alone -- there is nothing left in it to take out.
            attrs.COLOR_0 = add_packed(
                meshpack.Packed(
                    np.rint(np.clip(col, 0.0, 1.0) * 255.0).astype(np.uint8),
                    meshpack.COMPONENT_UBYTE,
                    "VEC4",
                    4,
                    True,
                    None,
                    0.0,
                ),
                TARGET_ARRAY_BUFFER,
            )
        if buf.building_index:
            # pygltflib models custom attributes as plain extra fields on Attributes.
            bidx = np.asarray(buf.building_index, dtype=np.float32)
            setattr(
                attrs,
                "_BLDIDX",
                add_packed(meshpack.pack_building_index(bidx), TARGET_ARRAY_BUFFER),
            )

        primitives.append(
            gl.Primitive(
                attributes=attrs,
                indices=add_packed(meshpack.pack_indices(idx), TARGET_ELEMENT_ARRAY),
                material=mesh.MATERIAL_INDEX.get(material_name, 0),
                mode=4,  # TRIANGLES
            )
        )
        triangles += len(idx) // 3

    if not primitives:
        return 0, 0

    _note_pack_error(worst)

    # Materials are named placeholders; the client substitutes its own facade
    # node material per slot and only needs the name to know which is which.
    materials = [gl.Material(name=m, doubleSided=False) for m in mesh.MATERIALS]

    doc = gl.GLTF2(
        asset=gl.Asset(version="2.0", generator="sydney-pipeline"),
        scene=0,
        scenes=[gl.Scene(nodes=[0])],
        nodes=[gl.Node(mesh=0)],
        meshes=[gl.Mesh(primitives=primitives)],
        materials=materials,
        accessors=accessors,
        bufferViews=views,
        buffers=[gl.Buffer(byteLength=len(blob))],
        # Declared, not required. `KHR_mesh_quantization` is what makes an
        # integer POSITION legitimate glTF; `SYD_mesh_pack` flags the delta
        # filter, which is nobody's extension but ours. Neither goes in
        # `extensionsRequired`, because a required extension it does not know
        # makes `GLTFLoader` refuse the file -- and `verifyTileGlbParse` compares
        # `parseTileGlb` against `GLTFLoader` on a real tile at boot. See
        # `meshpack`'s header.
        extensionsUsed=["KHR_mesh_quantization", "SYD_mesh_pack"],
    )
    doc.set_binary_blob(bytes(blob))
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save_binary(str(path))
    return path.stat().st_size, triangles


def write_landmarks(path: Path, marks: list) -> dict:
    """`world/landmarks.glb`: the three hero landmarks, one node each.

    A single file for the whole world, loaded once beside `far.bin` and never
    evicted, and it belongs to no tile for a reason that is not the far layer's.
    The far layer is a stand-in that the streamer *takes away* when the real
    thing arrives; these have no real thing behind them and no distance at which
    they should stop drawing. The bridge is visible from Alexandria, the tower
    from every ridge in the extent, and a landmark that streams is a landmark
    that pops out of the skyline as you walk away from it.

    One glTF node per landmark, carrying the landmark's own anchor as a
    translation, and one primitive per material under it. The vertex positions
    are therefore metres from the landmark's own centre -- 600 m at the widest,
    on the bridge -- rather than metres from Town Hall, which keeps float32
    resolution at a millimetre where a world-space buffer would be at a
    centimetre by the time it reached Milsons Point. It also means the audit can
    read a height straight out of a POSITION accessor without walking the node
    graph, because the node translation carries no y.

    Materials are `landmarks.LANDMARK_MATERIALS`, named in the file, and **not**
    `mesh.MATERIALS` -- see that module's header for why the landmark set has its
    own namespace rather than five appended slots.
    """
    from . import landmarks as lm

    blob = bytearray()
    views: list[gl.BufferView] = []
    accessors: list[gl.Accessor] = []
    meshes: list[gl.Mesh] = []
    nodes: list[gl.Node] = []
    triangles = 0

    def push(data: bytes, target: int | None) -> int:
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(data)
        views.append(gl.BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target))
        return len(views) - 1

    def accessor(arr: np.ndarray, comp: int, kind: str, components: int, target: int) -> int:
        view = push(arr.tobytes(), target)
        lo, hi = _accessor_min_max(arr, components)
        accessors.append(
            gl.Accessor(
                bufferView=view, componentType=comp, count=len(arr) // components,
                type=kind, min=lo, max=hi,
            )
        )
        return len(accessors) - 1

    for mark in marks:
        primitives: list[gl.Primitive] = []
        for material, part in mark.parts.items():
            if not part.indices:
                continue
            pos = np.asarray(part.positions, dtype=np.float32)
            nrm = np.asarray(part.normals, dtype=np.float32)
            uv = np.asarray(part.uvs, dtype=np.float32)
            idx = np.asarray(part.indices, dtype=np.uint32)
            attrs = gl.Attributes(
                POSITION=accessor(pos, COMPONENT_FLOAT, "VEC3", 3, TARGET_ARRAY_BUFFER),
                NORMAL=accessor(nrm, COMPONENT_FLOAT, "VEC3", 3, TARGET_ARRAY_BUFFER),
                TEXCOORD_0=accessor(uv, COMPONENT_FLOAT, "VEC2", 2, TARGET_ARRAY_BUFFER),
            )
            primitives.append(
                gl.Primitive(
                    attributes=attrs,
                    indices=accessor(idx, COMPONENT_UINT, "SCALAR", 1, TARGET_ELEMENT_ARRAY),
                    material=lm.LANDMARK_MATERIAL_INDEX[material],
                    mode=4,
                )
            )
            triangles += len(idx) // 3
        if not primitives:
            continue
        meshes.append(gl.Mesh(primitives=primitives, name=mark.name))
        # ENU -> world on the node, the same flip `_Builder.w` applies to the
        # vertices: x is east, z is -north, and y is absolute so it stays zero.
        nodes.append(
            gl.Node(
                mesh=len(meshes) - 1,
                name=mark.name,
                translation=[float(mark.anchor_enu[0]), 0.0, float(-mark.anchor_enu[1])],
            )
        )

    if not nodes:
        return {"count": 0, "triangles": 0, "bytes": 0}

    doc = gl.GLTF2(
        asset=gl.Asset(version="2.0", generator="sydney-pipeline/landmarks"),
        scene=0,
        scenes=[gl.Scene(nodes=list(range(len(nodes))))],
        nodes=nodes,
        meshes=meshes,
        materials=[gl.Material(name=m, doubleSided=False) for m in lm.LANDMARK_MATERIALS],
        accessors=accessors,
        bufferViews=views,
        buffers=[gl.Buffer(byteLength=len(blob))],
    )
    doc.set_binary_blob(bytes(blob))
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save_binary(str(path))
    return {
        "count": len(nodes),
        "triangles": triangles,
        "vertices": sum(m.vertices for m in marks),
        "bytes": path.stat().st_size,
    }


def write_params(path: Path, params: list[list[float]]) -> int:
    """Per-building facade parameters as a flat float32 array.

    Uploaded client-side as an RGBA32F data texture of width 4 and height
    len(params); a vertex fetches its own row using `_BLDIDX`.
    """
    arr = np.asarray(params, dtype=np.float32).reshape(-1)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(arr.tobytes())
    return len(arr) * 4


#: The most vertices one prism may carry. The format's count word is a `u16`,
#: but `client/src/player/collision.ts` walks every vertex of every prism in the
#: cell on each query, so this is a cost bound rather than a format one.
COLLISION_MAX_VERTS = 255


def collision_ring(ring: np.ndarray) -> np.ndarray | None:
    """The plan ring one building's collision prism is built from.

    **The drawn footprint, unsimplified**, and the change of mind is worth the
    paragraph because the code said the opposite for a year:

    > Simplify hard -- collision wants the fewest planes that still stop a
    > player at the wall. A 1 m tolerance is invisible at walking speed.

    It is not invisible, because Douglas-Peucker does not only move a wall --
    where a footprint is re-entrant it **bridges the notch**, and the collision
    polygon then fills an alcove the mesh draws as open. That is solid the
    player is stopped by with nothing drawn there, which is the report
    *"random invisible walls that slow me down, no pattern"*. Measured over all
    1,299,318 footprints in this build:

    | rule | solid added | footprints | worst | ring vertices |
    |---|---:|---:|---:|---:|
    | `simplify(0.9, preserve_topology=False)` | 324,912 m2 | 155,186 | 583.5 m2 | 7,030,828 |
    | `simplify(0.9, preserve_topology=True)`  | 324,674 m2 | 155,158 | 583.5 m2 | 7,031,058 |
    | `simplify(0.3, preserve_topology=True)`  |  27,980 m2 |  53,353 | 129.1 m2 | 7,458,449 |
    | the drawn ring                           |       0 m2 |       0 |   0.0 m2 | 7,631,044 |

    **`preserve_topology=True` fixes nothing** -- 324,674 against 324,912 -- and
    that is the one result here that overturns the obvious diagnosis. The flag
    stops the simplifier producing an *invalid* polygon; it does not stop a
    valid one swallowing a courtyard. What was doing the damage was the
    tolerance, and the honest end of reducing a tolerance until the error is
    small is to stop introducing the error.

    So the ring is not simplified at all, and the invariant is by construction
    rather than by threshold: **the collision polygon IS the drawn polygon**,
    so there is nothing for the two to disagree about. The standoff it removes
    is 0.49 m at the median over the 113,489 footprints that had one, 0.74 m at
    p90 and 1.03 m at worst.

    The price is 7,631,044 ring vertices against 7,030,828, **8.5%**, and it is
    small because the median footprint is a 4-vertex box that Douglas-Peucker
    never touched. Only 5 footprints in the whole build exceed
    `COLLISION_MAX_VERTS`, and those are the one case that still has to be
    reduced -- reduced by a rule that cannot add, see below.
    """
    from shapely.geometry import Polygon

    if len(ring) < 3:
        return None
    if len(ring) <= COLLISION_MAX_VERTS:
        return ring

    # The five footprints that cannot be carried whole. Truncating the ring --
    # which is what the old code did after simplifying -- closes the polygon
    # early across whatever it cut off, and that is the same defect at 200 m
    # instead of at 0.9. Simplify until it fits, then **intersect with the
    # drawn footprint**, so whatever the reduction does it can only ever remove
    # solid and never add it.
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon":
        return None
    for tol in (0.1, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0):
        simple = poly.simplify(tol, preserve_topology=True)
        if simple.is_empty or simple.geom_type != "Polygon":
            continue
        clipped = simple.intersection(poly)
        if clipped.is_empty:
            continue
        if clipped.geom_type != "Polygon":
            clipped = max(clipped.geoms, key=lambda g: g.area)
        pts = mesh._ring_open(np.asarray(clipped.exterior.coords))
        if 3 <= len(pts) <= COLLISION_MAX_VERTS:
            return pts
    # Nothing reduced it. Keep the first 255 vertices rather than emit nothing,
    # and it is the one place in this function where the collision can stand
    # where nothing is drawn. Zero footprints reach it on this build.
    return ring[:COLLISION_MAX_VERTS]


def write_collision(
    path: Path,
    buildings: list[Building],
    origin: tuple[float, float],
    bases: list[float] | None = None,
    extra: list = (),
) -> tuple[int, int]:
    """Convex-ish prism collision, tile-local, little-endian. **Format v2.**

        u32  building count
        per building:
          f32  height          metres, floor to roof
          f32  base            metres, the pad this building stands on
          u16  vertex count
          f32[2 * n]  x, z pairs, tile-local metres

    The prism occupies [base, base + height]. `base` is v2's only addition and it
    arrived with terrain: before it every building stood on y = 0 and the roof
    height and the roof *elevation* were the same number, which they now are not.

    `extra` is `landmarks.Prism` records -- the Harbour Bridge's deck and
    parapets, the Opera House podium, the tower's stalk -- appended to the same
    array in the same format, **and it is deliberately not a second section of
    the file**. The count word covers them, the server parses them without
    knowing they exist, and the format is byte-identical to what shipped before:
    a landmark prism is a prism, and the only thing that distinguishes the
    bridge deck from a warehouse roof is that its `base` is 45 m up, which v2
    has expressed since terrain arrived. That is the whole reason the deck is
    walkable end to end without a protocol change -- `CollisionWorld.roofHeight`
    already stands a player on any prism top they are above.

    There is no version word in the file and deliberately so -- adding one would
    change the header the server already parses to no purpose, because the two
    ends of this format are the pipeline and `client/src/player/collision.ts` and
    they ship together. What guards it instead is that a v1 payload read as v2
    misparses on the very first building and reports absurd vertex counts rather
    than subtly wrong heights. **A build that changes this format must re-emit
    every tile** (`--retile`), which is what `--stage inner --retile` is for.

    Deliberately not derived from the render mesh: the render mesh gains window
    reveals and balconies inside 80 m, and colliding against those would be both
    expensive and worse to play against.

    ---------------------------------------------------------------------------
    RETURNS `(bytes_written, building_rings_emitted)`, AND THE SECOND HALF IS NOT
    A CONVENIENCE.

    The index records a per-tile `b` and **both authorities subtract it from the
    payload's own count word to find the structures**: `write_collision` emits
    the `extra` rings first and the buildings after, so the first `total - b`
    records are the decks and the landmark volumes, and that subtraction is the
    entire provenance `CollisionWorld.addTile` has for `Prism.structural`. See
    that function's `buildingCount` argument, and `world/invisible-walls.ts` for
    the positional split written out at length.

    `b` used to be `len(buildings)` -- the footprints the tile was *offered*.
    This function does not emit all of them: `collision_ring` returns None for a
    ring that degenerates to fewer than three points, and that one is dropped
    here, correctly, because the count word has to be the number actually
    written. The two numbers are therefore not the same number, and the gap goes
    straight into the subtraction: with `k` rings dropped and `S` structures,
    `total - b` is `S - k`, so the **last `k` structures on that tile are handed
    to both authorities as buildings**. A deck marked a building is a deck whose
    soffit `resolve` stops honouring -- it goes solid from the ground up, and the
    viaduct a player is meant to walk under becomes a wall they cannot see
    through the deck over their head. The failure is silent in both directions
    and there is no second source to catch it with.

    So the caller records *this* number as `b` and the subtraction is exact by
    construction. Measured over the shipped bake before the change: **0 of 18,113
    tiles had a dropped ring** (`total < b` never occurs and `collision_ring`
    reports zero footprints reaching its last fallback), so this fixes a defect
    with no members today rather than one in the field -- which is the reason to
    fix it now, while the count that proves it is still zero. It needs a retile
    to reach the shipped index; nothing about the payload format changes.
    """
    oe, on = origin
    # Landmark rings are prepared before the count word is written, because the
    # count has to be the number actually emitted: a ring that degenerates to two
    # points is dropped here rather than after the header has already promised it.
    landmark_rings = []
    for p in extra:
        ring = np.asarray(p.ring, dtype=np.float64)
        if len(ring) > 1 and np.allclose(ring[0], ring[-1]):
            ring = ring[:-1]
        if len(ring) >= 3:
            landmark_rings.append((float(p.height), float(p.base), ring[:255]))

    # And the building rings on the same terms, for the same reason: a footprint
    # that degenerates to two points is dropped, and the count word has to be
    # the number actually emitted rather than the number offered. The old code
    # promised `len(buildings)` and then `continue`d past the empty ones, which
    # left the server parsing a prism out of the next building's header.
    building_rings = []
    for i, b in enumerate(buildings):
        # THE COLLISION POLYGON IS THE DRAWN POLYGON. There is no simplify call
        # here and there must not be one: a tolerance that moves a wall also
        # bridges a re-entrant corner, and the collision then fills an alcove
        # the mesh draws as open. `preserve_topology=True` is a placebo against
        # it -- it recovers 238 m2 of 324,912 -- and the vertex saving a
        # tolerance buys is 8.5% on a build whose median footprint is a
        # four-vertex box that Douglas-Peucker never touched. See
        # `collision_ring` for the whole table before re-adding one.
        pts = collision_ring(mesh._ring_open(b.ring))
        if pts is None:
            continue
        building_rings.append((float(b.height), 0.0 if bases is None else float(bases[i]), pts))

    out = bytearray(struct.pack("<I", len(building_rings) + len(landmark_rings)))
    for height, base, ring in landmark_rings:
        out += struct.pack("<ffH", height, base, len(ring))
        for e, n in ring:
            out += struct.pack("<ff", float(e - oe), float(-(n - on)))
    for height, base, pts in building_rings:
        out += struct.pack("<ffH", height, base, len(pts))
        for e, n in pts:
            out += struct.pack("<ff", float(e - oe), float(-(n - on)))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))
    return len(out), len(building_rings)


def write_terrain(path: Path, grid: np.ndarray) -> int:
    """One tile's ground, as a post grid. Little-endian float32, no header.

        f32[(N + 1) * (N + 1)]   heights, metres above the datum

    N is `config.TERRAIN_GRID`; the client reads it from `index.json` rather than
    repeating the constant. Row-major, **row 0 is the tile's northern edge** and
    column 0 its western one -- rows advance southward, which is the direction
    the renderer's +Z points, so the client walks this array straight into a grid
    mesh without transposing anything.

    No header at all, and that is a decision rather than an omission: the length
    is fixed by N, so a truncated or stale file is caught by a byte-length check
    on the client with nothing to disagree about. 1,156 bytes a tile.

    Posts are shared with the neighbouring tiles, not merely coincident: they are
    read out of one global lattice in `terrain.py`, so two tiles' shared edge is
    bit-identical and the seam between their meshes cannot open. The skirt the
    client hangs off each tile edge is belt and braces over that, not the fix.
    """
    arr = np.ascontiguousarray(grid, dtype="<f4")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(arr.tobytes())
    return arr.nbytes


def write_vegetation(path: Path, trees: list[vegetation.Tree], origin: tuple[float, float]) -> int:
    """Tree instances, tile-local, little-endian.

        u32  tree count
        per tree:
          f32  x, f32 z    tile-local metres, renderer axes (z = -north)
          f32  height      metres, ground to the top of the canopy
          f32  canopyRadius
          u8   species     index into `vegetation.SPECIES_*`
          u8   seed        yaw, hue jitter and lobe wobble on the client
          u16  pad         to a 20-byte stride

    A sidecar rather than glTF nodes, and deliberately: 400 instances would be
    400 nodes in the scene graph and 400 draw calls, where this is six
    InstancedMesh sets. The explicit pad keeps the stride a multiple of four so
    the client can read it with a DataView and fixed offsets rather than
    tracking alignment.

    Returns bytes written; deletes the file and returns 0 when there are no
    trees, so a stale sidecar can never outlive the tile that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not trees:
        path.unlink(missing_ok=True)
        return 0
    oe, on = origin
    out = bytearray(struct.pack("<I", len(trees)))
    for t in trees:
        out += struct.pack(
            "<ffffBBH",
            float(t.east - oe),
            float(-(t.north - on)),
            float(t.height),
            float(t.canopy_radius),
            int(t.species) & 0xFF,
            int(t.seed) & 0xFF,
            0,
        )
    path.write_bytes(bytes(out))
    return len(out)


def write_parking(path: Path, cars: list[parking.Car], origin: tuple[float, float]) -> int:
    """Parked car instances, tile-local, little-endian.

        u32  car count
        per car:
          f32  x, f32 z    tile-local metres, renderer axes (z = -north)
          f32  heading     radians, applied as the instance's Y rotation
          u8   body        index into `parking.SEDAN` .. `parking.VAN`
          u8   colour      index into the client's paint palette
          u16  seed        per-car size and tone jitter on the client

    16 bytes a car against the vegetation sidecar's 20, and the same reasoning
    behind both: a tile's hundred cars are five `InstancedMesh` sets, not a
    hundred scene-graph nodes. The stride is a multiple of four so the client can
    read it with a `DataView` at fixed offsets.

    No size, no colour and no per-car geometry travel in this file. Everything
    but the position, the heading and two table indices is derived on the client
    from `seed`, which is what keeps a 20,000-car world under 320 kB.

    Returns bytes written; deletes the file and returns 0 when there are no cars,
    so a stale sidecar can never outlive the tile that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cars:
        path.unlink(missing_ok=True)
        return 0
    oe, on = origin
    out = bytearray(struct.pack("<I", len(cars)))
    for c in cars:
        out += struct.pack(
            "<fffBBH",
            float(c.east - oe),
            float(-(c.north - on)),
            float(c.heading),
            int(c.body) & 0xFF,
            int(c.colour) & 0xFF,
            int(c.seed) & 0xFFFF,
        )
    path.write_bytes(bytes(out))
    return len(out)


def write_power(path: Path, tile: power.TilePower, origin: tuple[float, float]) -> int:
    """Power poles and wire spans, little-endian. Two blocks, one file.

        u32  pole count
        per pole (20 bytes):
          f32  x, f32 z    tile-local metres, renderer axes (z = -north)
          f32  groundY     **absolute** metres above the datum, terrain-sampled
          f32  heightM     9.5-11.5, ground to the top of the shaft
          u8   kind        `power.STANDARD` | `power.TRANSFORMER`
          u8   tiltSeed    up to ~1.5 degrees of lean, applied on the client
          u16  pad         to a 20-byte stride
        u32  wire count
        per wire (24 bytes):
          f32  ax, f32 ay, f32 az
          f32  bx, f32 by, f32 bz

    Three things about this format are decisions rather than mechanics.

    **`groundY` is absolute and every other height in the file is too.** The
    client positions a tile's group at y = 0 and its terrain sidecar already
    holds absolute heights, so an absolute y here needs no bias and, more to the
    point, lets a wire endpoint stand over the *neighbouring* tile's ground
    without either tile having to know the other's offset. It also saves the
    client a bilinear lookup per pole, which is why the pipeline samples it at
    all rather than letting the client do what it does for a tree.

    **Wire endpoints are absolute in y but tile-local in x and z, and a span
    belongs to the tile containing its midpoint.** So one endpoint of a
    cross-seam span is routinely outside [0, TILE_SIZE) -- by up to half a span,
    30 m. That is the convention that stops a seam dropping or doubling a span,
    and `power.py`'s module docstring argues it out; the client must not clamp
    or cull on those coordinates.

    **One line per pole pair carries two conductors.** The client offsets two
    catenaries by +/-0.35 m along the crossarm axis, which it derives as the
    plan-perpendicular of the span itself. Nothing about the second strand is in
    this file, because anything that were could disagree with the first.

    Returns bytes written; deletes the file and returns 0 when the tile carries
    neither a pole nor a span, so a stale sidecar can never outlive the tile that
    produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if tile.is_empty():
        path.unlink(missing_ok=True)
        return 0
    oe, on = origin
    out = bytearray(struct.pack("<I", len(tile.poles)))
    for p in tile.poles:
        out += struct.pack(
            "<ffffBBH",
            float(p.east - oe),
            float(-(p.north - on)),
            float(p.ground_y),
            float(p.height),
            int(p.kind) & 0xFF,
            int(p.tilt_seed) & 0xFF,
            0,
        )
    out += struct.pack("<I", len(tile.spans))
    for s in tile.spans:
        out += struct.pack(
            "<ffffff",
            float(s.a_east - oe),
            float(s.a_y),
            float(-(s.a_north - on)),
            float(s.b_east - oe),
            float(s.b_y),
            float(-(s.b_north - on)),
        )
    path.write_bytes(bytes(out))
    return len(out)


def write_furniture(
    path: Path, tile: furniture.TileFurniture, origin: tuple[float, float]
) -> int:
    """Wheelie bins, street-name posts and traffic signals. Three blocks, one file.

        u32  magic       `FURN_MAGIC`, ASCII 'FURN' little-endian
        u32  version     `FURN_VERSION`
        u32  bin count
        per bin (20 bytes):
          f32  x, f32 z    tile-local metres, renderer axes (z = -north)
          f32  groundY     **absolute** metres, the top of the footpath paving
          f32  yaw         radians, the instance's Y rotation; see below
          u8   lid         `furniture.LID_RED` | `LID_YELLOW` | `LID_GREEN`
          u8   pad x 3     to a 20-byte stride
        u32  post count
        per post (16 bytes + a variable blade record each, **variable**):
          f32  x, f32 z, f32 groundY
          u8   bladeCount  1..`furniture.MAX_BLADES`
          u8   style       `furniture.STYLE_COS_GREEN` | `STYLE_RMS_WHITE`
          u8   pad x 2
          per blade:
            f32  yaw       parallel to the street this blade names
            u8   nameLen   bytes of UTF-8 following, 0..`furniture.MAX_NAME_CHARS`
            u8   name x nameLen    the legend, natural case, already abbreviated
        u32  signal count
        per signal (20 bytes):
          f32  x, f32 z, f32 groundY
          f32  yaw         radians; the head faces *inward*, across the junction
          u8   lit         `furniture.LAMP_RED` | `LAMP_AMBER` | `LAMP_GREEN`
          u8   pad x 3

    **Version 2, and the header is new in it.** Version 1 had no header at all --
    it opened on the bin count, like every other sidecar in the build -- and it
    carried no legend and no style. Adding both changed the shape of the post
    record rather than extending it, so a v1 file cannot be read as a v2 one and
    the two have to be told apart. The magic is what does that: it is 1.3
    billion read as a u32, which no bin count will ever be, so a decoder can
    recognise a headerless v1 file by the absence of it and fall back. The
    client does exactly that, and a v1 file comes out as blank green blades --
    which is what it was.

    Every yaw here is an **ENU bearing written unchanged**, and that is correct
    rather than a missing conversion -- `parking.ParkingNetwork._heading` works
    it out in full and the answer is that the two are the same number. World axes
    are x = east, z = -north, a Y rotation of `t` sends local +X to world
    `(cos t, 0, -sin t)`, and an ENU direction `(fe, fn)` is world `(fe, 0,
    -fn)`; equating them gives `t = atan2(fn, fe)` with no flip anywhere. So the
    client builds each of these three with its **facing along local +X** and
    applies the yaw directly:

      * a bin faces the road, so its wheels and lid hinge are at the back, on the
        property side -- which is where the council asks for them and, more to
        the point, is what makes the lid read as a lid from the street;
      * a blade lies along its own street, so local +X is the blade's length;
      * a signal head faces the middle of the intersection.

    Five things about this format are decisions rather than mechanics.

    **The post record is the only variable-stride record in the build**, and the
    decoder has to walk it rather than index it. That is the price of not
    padding every post out to the maximum blade count -- which today would cost
    nothing, because a post is only emitted at a junction of two *named* streets
    and so always carries exactly two blades. The format does not assume that,
    because the thing most likely to change here is the rule that produces it: a
    named street meeting an unnamed lane is a one-blade corner in life, and
    admitting those later must not be a format change.

    **The legend is a raw string per blade rather than an index into a per-tile
    string table**, and that is a deliberate refusal of the obvious compression.
    A tile holds 13 posts at the median, so its blades name at most 26 streets
    and usually fewer than 20 distinct ones; a table would save perhaps 150
    bytes on a 1.2 kB block and would cost the decoder a second pass and the
    format a fourth block. The whole ring's furniture sidecars are a fifth of a
    megabyte. There is nothing here worth compressing, and the client
    deduplicates anyway -- it caches one canvas texture per distinct *(name,
    style)* across the whole world, which is the deduplication that actually
    matters, and it would do that whether or not the file was deduplicated too.

    **The style is per post, not per blade**, because both blades on one corner
    belong to the same council by construction. Writing it per blade would make
    a two-tone corner representable, and a two-tone corner is not a thing.

    **`groundY` is the footpath, not the terrain.** `power.write_power` writes
    the terrain height under a pole, because a pole's butt is genuinely below the
    paving. Everything in this file stands *on* the footpath, so the pipeline
    adds `streets.FOOTPATH_Y` once, here-ish -- in `furniture._footpath_y` -- and
    the client adds nothing. 15 cm is exactly enough to be seen: a bin sunk to
    its axle reads as rubbish rather than as a bin.

    **Absolute y, like the power sidecar and unlike the trees and the cars.** The
    client positions a tile's group at y = 0 and its terrain sidecar already
    holds absolute heights, so this needs no bias -- and it saves the client a
    bilinear lookup per instance, which is the same trade `write_power` makes and
    for the same reason: these things are placed against the kerb, and the kerb
    was drawn against the pipeline's terrain rather than the client's sampling of
    it.

    **Nothing about a blade's colour or a lamp's colour is in this file** beyond
    the one index. The two blade palettes, the three lamp tones and the bin lid
    palette all live in `client/src/world/furniture.ts`, which is where every
    other palette in the build lives, and a byte here that repeated any of them
    would be a byte that could disagree. `style` is an index into that table for
    the same reason `lid` and `lit` are: it says *which* Sydney blade this is,
    not what colour it comes out.

    Returns bytes written; deletes the file and returns 0 when the tile carries
    none of the three, so a stale sidecar can never outlive the tile that
    produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if tile.is_empty():
        path.unlink(missing_ok=True)
        return 0
    oe, on = origin
    out = bytearray(struct.pack("<II", FURN_MAGIC, FURN_VERSION))
    out += struct.pack("<I", len(tile.bins))
    for b in tile.bins:
        out += struct.pack(
            "<ffffBBBB",
            float(b.east - oe),
            float(-(b.north - on)),
            float(b.ground_y),
            float(b.yaw),
            int(b.lid) & 0xFF,
            0,
            0,
            0,
        )
    out += struct.pack("<I", len(tile.posts))
    for p in tile.posts:
        out += struct.pack(
            "<fffBBBB",
            float(p.east - oe),
            float(-(p.north - on)),
            float(p.ground_y),
            len(p.blade_yaws) & 0xFF,
            int(p.style) & 0xFF,
            0,
            0,
        )
        for k, yaw in enumerate(p.blade_yaws):
            # `MAX_NAME_CHARS` counts *characters* and this length counts bytes,
            # so a 24-character name could in principle encode to 96 of them --
            # still nowhere near the u8's 255, which is why this drops rather
            # than truncates on the impossible case. Truncating UTF-8 by bytes
            # can cut a character in half, and half a character is a decoder
            # exception rather than a short name.
            raw = (p.names[k] if k < len(p.names) else "").encode("utf-8")
            if len(raw) > 255:
                raw = b""
            out += struct.pack("<fB", float(yaw), len(raw))
            out += raw
    out += struct.pack("<I", len(tile.signals))
    for s in tile.signals:
        out += struct.pack(
            "<ffffBBBB",
            float(s.east - oe),
            float(-(s.north - on)),
            float(s.ground_y),
            float(s.yaw),
            int(s.lit) & 0xFF,
            0,
            0,
            0,
        )
    path.write_bytes(bytes(out))
    return len(out)


def write_powerups(
    path: Path, tile: powerups.TilePowerups, origin: tuple[float, float]
) -> int:
    """Spec 8.3's powerups. One block, little-endian.

        u32  count
        per point (16 bytes):
          f32  x, f32 z    tile-local metres, renderer axes (z = -north)
          f32  groundY     **absolute** metres, the top of the footpath paving
          u8   kind        `powerups.TRAINING` | `powerups.FLAT_WHITE`
          u8   pad x 3     to a 16-byte stride

    The smallest record in the build, and it is worth saying what is *not* in
    it. There is no radius, no duration, no multiplier, no respawn time and no
    icon selection beyond the one kind byte -- every number in spec 8.3 lives in
    `client/src/game/powerups.ts` beside the combat constants. A byte here that
    repeated one of them would be a byte that could disagree, which is the same
    call `write_furniture` makes about the bin palette and `write_power` about
    the conductor colour.

    There is also no identity. A powerup's state -- taken, respawning, active --
    is per *session* and lives in the client's `PowerupField`, keyed by tile and
    index, and the sidecar is the immutable half. A server adopting this reads
    exactly the same file and keys its own authoritative state the same way.

    **Absolute y, like the power and furniture sidecars and unlike the trees and
    the cars**, for the reason `write_furniture` gives at length: the client
    positions a tile's group at y = 0, and these things are placed against
    paving the pipeline drew against the pipeline's own terrain. It is the
    *footpath* height rather than the terrain -- `powerups._footpath_y` adds
    `streets.FOOTPATH_Y` once -- because a point snapped clear of a building
    stands on the concrete.

    Returns bytes written; deletes the file and returns 0 when the tile carries
    none, so a stale sidecar can never outlive the tile that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if tile.is_empty():
        path.unlink(missing_ok=True)
        return 0
    oe, on = origin
    out = bytearray(struct.pack("<I", len(tile.points)))
    for p in tile.points:
        out += struct.pack(
            "<fffBBBB",
            float(p.east - oe),
            float(-(p.north - on)),
            float(p.ground_y),
            int(p.kind) & 0xFF,
            0,
            0,
            0,
        )
    path.write_bytes(bytes(out))
    return len(out)


def write_street_names(
    path: Path, segments: list[streets.NamedSegment], origin: tuple[float, float]
) -> tuple[int, int]:
    """Named street centrelines. A string table and a run of polylines.

        u8   name count
        per name:
          u8   byte length of the UTF-8 that follows
          u8   name x length      the **full** display form, e.g. 'King Street'
        u16  segment count
        per segment (**variable**):
          u8   nameIdx            into the table above
          u8   point count        2..`streets.MAX_SEGMENT_POINTS`
          per point (8 bytes):
            f32  x, f32 z         tile-local metres, renderer axes (z = -north)

    The only sidecar in the build a player never sees the geometry of. It exists
    so the client can answer "which street am I on" *mid-block*, which nothing
    shipped before it could: the furniture blades carry names, but a blade stands
    at a junction and names one of the two streets crossing there, so halfway
    down a block the nearest blade is a hundred metres off and as likely to name
    the cross street. See `client/src/game/locator.ts`.

    Four things here are decisions rather than mechanics.

    **The names are not abbreviated, and this is the one place in the build that
    is true.** `furniture._blade_text` shortens 'King Street' to 'King St'
    because no plate in Australia is lettered otherwise, and the blade sidecar
    carries the shortened form. A readout is prose rather than signage -- 'King
    Street, Newtown' is how the address is written -- so the long form is what is
    shipped, and the client abbreviates for itself in the one case where it has
    to fit two names on one line. Shortening here would make that impossible: 'St'
    cannot be expanded back, because Sydney has a Sussex Street and a St Johns
    Road.

    **A string table, where the blade sidecar deliberately refuses one.** The
    argument that settled it there -- 13 posts a tile, 26 legends, 150 bytes
    saved -- inverts here. A named way crosses this tile as several clipped runs
    and the arterials cross it as many, so a table of 40-odd names is referenced
    by 100-odd segments; the table is what keeps the file a couple of kilobytes
    instead of five, and unlike the blades there is no per-name texture on the
    client whose cache would deduplicate it anyway.

    **Both counts are sized to what they count and not alike.** The names take a
    u8 because a tile with 255 distinct street names does not exist at 500 m; the
    segments take a u16 because the clip in `StreetNetwork.named_segments`
    multiplies -- a way that leaves the tile and comes back is two records, and
    the margin makes that routine at every corner. `streets.MAX_TILE_NAMES` and
    `MAX_SEGMENT_POINTS` are enforced there rather than trusted here.

    **Tile-local, like every other sidecar, and with no y at all.** A readout is
    a question about the ground plan; the street's height is the terrain's answer
    and is already in `.terr.bin`. Two floats a point rather than three is a
    quarter off the file for a number nothing would read.

    Returns **(runs written, bytes)**, where every other writer here returns
    bytes alone -- and the difference is load-bearing rather than a style slip.
    The index carries this sidecar's record count as the client's fetch test,
    and this is the only writer in the module that can drop a record its caller
    handed it: the two guards below refuse a name that will not fit the format.
    Taking the count from `len(segments)` instead would let the index and the
    file disagree by however many were dropped, silently, and only on the tile
    where it happened. Every other sidecar's count comes off the network object
    that produced it and cannot drift.

    Deletes the file and returns (0, 0) for a tile with no named street on it,
    so a stale sidecar can never outlive the tile that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not segments:
        path.unlink(missing_ok=True)
        return 0, 0

    order: list[str] = []
    index: dict[str, int] = {}
    kept: list[tuple[int, np.ndarray]] = []
    for seg in segments:
        idx = index.get(seg.name)
        if idx is None:
            raw = seg.name.encode("utf-8")
            # A name whose UTF-8 does not fit the u8 length is dropped whole
            # rather than cut: truncating UTF-8 by bytes can halve a character,
            # and half a character is a decoder exception rather than a short
            # name. Nothing in the extent is close -- the longest is 34 bytes.
            if not raw or len(raw) > 255 or len(order) >= streets.MAX_TILE_NAMES:
                continue
            idx = len(order)
            index[seg.name] = idx
            order.append(seg.name)
        kept.append((idx, seg.points))
    if not kept:
        path.unlink(missing_ok=True)
        return 0, 0

    oe, on = origin
    out = bytearray(struct.pack("<B", len(order)))
    for name in order:
        raw = name.encode("utf-8")
        out += struct.pack("<B", len(raw))
        out += raw
    out += struct.pack("<H", len(kept))
    for idx, pts in kept:
        out += struct.pack("<BB", idx, len(pts))
        for east, north in pts:
            out += struct.pack("<ff", float(east - oe), float(-(north - on)))
    path.write_bytes(bytes(out))
    return len(kept), len(out)


# --- The street-name bundle ---------------------------------------------------

# `SNBD`, read as a little-endian u32. The header of `world/street-names.bin`.
NAME_BUNDLE_MAGIC = 0x44424E53
NAME_BUNDLE_VERSION = 1
# Fixed header: magic, version, names, tiles, runs, points, table bytes, index
# width. Eight u32s, so every block after it starts 4-byte aligned.
NAME_BUNDLE_HEADER = 32


def _read_street_names(path: Path) -> tuple[list[str], list[tuple[int, int, bytes]]] | None:
    """Read one `.names.bin` back into its table and its runs.

    The inverse of `write_street_names`, and deliberately the *only* way the
    bundle below gets its geometry: the bundle is a repack of the sidecars
    rather than a second emission from the street network. That is what makes
    the two incapable of disagreeing -- the map and the in-world blades read
    the same points, to the bit -- and it is also what lets the bundle be
    rebuilt from a world already on disk without re-tiling anything.

    Each run comes back as `(name index, point count, raw point bytes)`, the
    point bytes untouched: they are already tile-local little-endian float32
    pairs, which is exactly what the bundle stores, so the coordinates make the
    trip from one file to the other without passing through a float at all.

    Returns None for a file that is missing or does not parse, which the caller
    treats as a tile with no names -- the same answer the client's decoder
    gives, and a hole in the map's labels rather than a failed build.
    """
    try:
        b = path.read_bytes()
    except OSError:
        return None
    if len(b) < 3:
        return None
    o = 0
    count = b[o]
    o += 1
    names: list[str] = []
    for _ in range(count):
        if o >= len(b):
            return None
        n = b[o]
        o += 1
        if o + n > len(b):
            return None
        names.append(b[o : o + n].decode("utf-8", "replace"))
        o += n
    if not names or o + 2 > len(b):
        return None
    (runs_n,) = struct.unpack_from("<H", b, o)
    o += 2
    runs: list[tuple[int, int, bytes]] = []
    for _ in range(runs_n):
        if o + 2 > len(b):
            break
        idx, pts = b[o], b[o + 1]
        o += 2
        need = pts * 8
        if o + need > len(b):
            break
        # A name index past the table is dropped rather than clamped, exactly as
        # `decodeStreetNames` drops it: clamping would put a piece of some other
        # street on the map under the wrong name.
        if idx < len(names) and pts >= 2:
            runs.append((idx, pts, b[o : o + need]))
        o += need
    return names, runs


def write_street_name_bundle(
    path: Path,
    entries: list[tuple[str, float, float]],
    tile_dir: Path,
) -> dict:
    """Every tile's named centrelines, in one file, for the big map.

        u32  magic          `NAME_BUNDLE_MAGIC`, ASCII 'SNBD' little-endian
        u32  version        `NAME_BUNDLE_VERSION`
        u32  name count
        u32  tile count     tiles with at least one run; not the whole build
        u32  run count      across every tile
        u32  point count    across every run
        u32  table bytes    the string table's length, padded to 4
        u32  index width    2 or 4, the bytes a run's name index takes
        -- string table, `name count` entries:
          u16  byte length of the UTF-8 that follows
          u8   name x length     the **full** display form, e.g. 'King Street'
          ...padded with zeroes to a 4-byte boundary
        -- u32 x tile count     runs in each tile, in index order
        -- f32 x 2 x tile count each tile's world origin: (minX, minZ + size)
        -- idx x run count      each run's name, tile order then run order
                                ...padded with zeroes to a 4-byte boundary
        -- u8  x run count      each run's point count
                                ...padded with zeroes to a 4-byte boundary
        -- f32 x 2 x point count tile-local metres, renderer axes, run order

    ---------------------------------------------------------------------------
    WHY THIS EXISTS. The per-tile `.names.bin` sidecars are right for what they
    were written for -- `game/locator.ts` and the blade legends want the tile
    they are standing on and nothing else, and they get it with the tile. The
    big map wants *the whole city at once*, and it was getting it by fetching
    every one of them: 357 requests on the first press of `M` at this stage, and
    a projected ~2,000 at 15 km. That is a request count rather than a byte
    count -- half a megabyte in total -- and a request count is the thing a CDN
    edge, an HTTP/2 window and a phone radio all charge for separately.

    So this is a **packaging change and nothing else**. The sidecars stay,
    byte-for-byte, and this file is assembled by reading them back (see
    `_read_street_names`). Nothing about what the map draws changes, which is
    the acceptance bar the client's `verifyBigMap` holds it to.

    ---------------------------------------------------------------------------
    THE THREE DECISIONS IN THE LAYOUT.

    **One string table for the build, where the sidecars have one per tile.**
    An arterial crosses forty tiles and pays for its name in all forty; across
    the build the 18,788 runs quote 2,870 distinct names, and the per-tile
    tables spend 92 kB restating them. Deduplicated they are 46 kB. It is also
    what lets the run's name reference shrink -- a u8 index into a 40-name tile
    table becomes a u16 into a build-wide one, and the file still comes out
    smaller than the sum of its parts.

    **Structure of arrays, not an array of structures.** The counts, the name
    indices and the points are three contiguous blocks rather than interleaved
    per run, for two reasons: the client makes one typed-array view over each
    instead of walking a `DataView` 18,788 times, and a block of little-endian
    float32 pairs next to another block of little-endian float32 pairs is what
    a compressor can find structure in. Raw, this is 486 kB against the
    sidecars' 534; brotli'd -- which is what jsDelivr serves and what the
    origin's own sidecars carry -- it is 266 kB against 296.

    **Tile-local points and a per-tile origin, rather than world metres.** The
    obvious packing writes the points already in world coordinates and drops the
    origins. It is rejected because it would quietly move every label: the
    client's existing path computes a world point as `float32(float32(local) +
    origin)` and a run's bounds as `double(local) + origin`, and a pipeline that
    folded the origin in at float64 and then rounded once would disagree with
    both in the last few bits. Shipping the same tile-local float32 the sidecar
    ships, plus the same origin the client already applies, makes the arrays the
    client ends up holding **bit-identical** to the ones it holds today -- so
    the chains, the importance ranking and the placement cannot drift, and the
    equivalence is a fact about the format rather than a tolerance in a test.

    ---------------------------------------------------------------------------
    `entries` is `(key, originX, originZ)` per tile **in the order `index.json`
    lists them**, which is sorted by key. The order is load-bearing in one small
    way: the client interns names in the order it first meets them, and the name
    index is the last tie-break when two streets rank equal for a label. Pinning
    it here replaces an order that used to depend on which of ten concurrent
    fetches landed first.

    Returns the `index.json` contract, or a contract with `runs: 0` and no file
    when the build has no named street in it at all -- the client reads that the
    same way it reads a missing block, and falls back to the sidecars.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    names: list[str] = []
    name_index: dict[str, int] = {}
    tile_runs: list[int] = []
    tile_origins: list[tuple[float, float]] = []
    run_names: list[int] = []
    run_points: list[int] = []
    points = bytearray()

    for key, origin_x, origin_z in entries:
        parsed = _read_street_names(tile_dir / f"{key}.names.bin")
        if parsed is None:
            continue
        table, runs = parsed
        if not runs:
            continue
        ids = []
        for name in table:
            got = name_index.get(name)
            if got is None:
                got = len(names)
                name_index[name] = got
                names.append(name)
            ids.append(got)
        for idx, count, raw in runs:
            run_names.append(ids[idx])
            run_points.append(count)
            points += raw
        tile_runs.append(len(runs))
        tile_origins.append((origin_x, origin_z))

    if not run_names:
        path.unlink(missing_ok=True)
        return {"runs": 0, "names": 0, "tiles": 0, "points": 0, "bytes": 0}

    table = bytearray()
    for name in names:
        raw = name.encode("utf-8")
        table += struct.pack("<H", len(raw))
        table += raw
    table += b"\0" * (-len(table) % 4)

    # Two bytes while the build's name table fits in one, four when it does not.
    # At 5.3 km there are 2,870 names and at 35 km there will be a hundred
    # thousand-odd, so this is a real switch rather than a hypothetical -- and it
    # is in the header rather than implied by the version, so a client reads
    # either without knowing which stage it is looking at.
    idx_width = 2 if len(names) <= 0xFFFF else 4
    total_points = sum(run_points)

    out = bytearray(
        struct.pack(
            "<IIIIIIII",
            NAME_BUNDLE_MAGIC,
            NAME_BUNDLE_VERSION,
            len(names),
            len(tile_runs),
            len(run_names),
            total_points,
            len(table),
            idx_width,
        )
    )
    out += table
    out += np.asarray(tile_runs, dtype="<u4").tobytes()
    out += np.asarray(tile_origins, dtype="<f4").tobytes()
    out += np.asarray(run_names, dtype="<u2" if idx_width == 2 else "<u4").tobytes()
    out += b"\0" * (-len(out) % 4)
    out += np.asarray(run_points, dtype="<u1").tobytes()
    out += b"\0" * (-len(out) % 4)
    out += points
    path.write_bytes(bytes(out))
    return {
        "path": path.name,
        "format": NAME_BUNDLE_VERSION,
        "runs": len(run_names),
        "names": len(names),
        "tiles": len(tile_runs),
        "points": total_points,
        "bytes": len(out),
    }


def _pack_water(sheets: list, origin: tuple[float, float] | None) -> bytes:
    """The bytes of a water payload, near or far. See `write_water`."""
    oe, on = origin if origin is not None else (0.0, 0.0)
    out = bytearray(struct.pack("<III", WATER_MAGIC, WATER_VERSION, len(sheets)))
    for sheet in sheets:
        verts = np.asarray(sheet.verts, dtype=np.float64)
        depth = np.asarray(sheet.depth, dtype=np.float64)
        tris = np.asarray(sheet.tris, dtype=np.uint32).reshape(-1, 3)
        out += struct.pack("<fII", float(sheet.surface), len(verts), len(tris) * 3)
        block = np.empty((len(verts), 3), dtype="<f4")
        block[:, 0] = verts[:, 0] - oe
        # ENU north -> renderer z. The one conversion in this file, and the same
        # one every other sidecar makes.
        block[:, 1] = -(verts[:, 1] - on)
        block[:, 2] = depth
        out += block.tobytes()
        out += np.ascontiguousarray(tris.ravel(), dtype="<u4").tobytes()
    return bytes(out)


def write_lanes(path: Path, tile: lanes.TileLanes, origin: tuple[float, float]) -> tuple[int, int, int]:
    """The drivable street network and the traffic timetable on it.

        u32  magic         `LANES_MAGIC`, ASCII 'LANE' little-endian
        u32  version       `LANES_VERSION`
        u32  way count
        u32  route count

        per way (16-byte header, then 12 bytes a point):
          u32  osmId          OSM way id truncated to 32 bits, 0 when unknown
          u8   klass          index into `lanes.LANE_CLASSES`
          u8   flags          bit 0: one-way
          u16  point count
          f32  halfWidth      centreline to kerb, metres
          f32  footpathWidth  the paved band beyond the kerb, 0 where none
          per point:
            f32  x, f32 y, f32 z

        per route (16-byte header, 24-byte park block, then 16 bytes a point):
          u32  rid            stable route id; the hash seed for its cars
          u8   klass
          u8   flags          bit 0: a near bay is assigned
                              bit 1: a far bay is assigned
          u16  point count
          f32  headway        seconds between departures
          f32  phase          seconds, this route's offset into the headway
          f32  parkT0         route-time the car waits at in the near bay
          f32  offX0, offZ0   near bay centre minus the lane point at parkT0
          f32  parkT1         route-time the car comes to rest at in the far bay
          f32  offX1, offZ1   far bay centre minus the lane point at parkT1
          per point:
            f32  x, f32 y, f32 z
            f32  t            cumulative seconds from the route's start

    x and z are tile-local metres in renderer axes (z = -north) exactly as every
    other instance sidecar's are; **y is absolute**, on `write_power`'s reasoning
    -- the client puts a tile's group at y = 0, the running surface here may be a
    bridge deck fifty metres over the tile's own terrain, and a route routinely
    crosses into the next tile where this tile's ground means nothing.

    Four things about this file are decisions rather than mechanics.

    **The route polyline is already in the left-hand lane.** Nothing at runtime
    offsets anything: the geometry in the routes block is where a car's centre
    actually goes, so the client and the server cannot disagree about which side
    of the road Australia drives on. `lanes._offset_left` is the single place
    that sign exists, and `verifyTraffic` asserts it from the other end.

    **Each point carries a *time*, not an arc length.** Speed caps, corner
    slowdowns and the wait at a red light are all already folded into `t`, which
    turns `position(tick)` into a binary search and a lerp -- no integration, no
    square roots, no transcendentals, and therefore bit-identical on V8 and
    JavaScriptCore. `lanes.py`'s header argues it out; `game/footy.ts`'s
    determinism rules are what it is arguing from.

    **A route belongs to the tile holding its first point and is written whole**,
    so its later points routinely fall outside [0, TILE_SIZE) -- by up to
    `lanes.MAX_ROUTE_M`. That is `write_power`'s wire-span convention and it is
    here for the same reason: a car has to be able to drive across a seam. The
    client must not clamp or cull on these coordinates.

    **The park block is a claim, not a hint.** `bays.py` arbitrates every route
    end against the static fleet in `.cars.bin` and against every other route's
    claims, in one global pass, and writes the winner here. The client and the
    server *read* it; neither derives anything. Before v2 both derived a bay from
    the ways block at decode time, which put a schedule car on top of a parked
    one 654 times in a 360-sample sweep of the inner 1.5 km and put two routes in
    one bay 1,163 times -- not because the derivation was wrong but because a
    per-tile function cannot see the other claimants. The offsets are **deltas
    from the lane point**, in the same renderer axes as the points, so they carry
    no origin and mean the same thing whatever tile the route is written into.

    **The ways block is not read by the traffic at all.** It is the street
    network as reusable geometry -- centreline, solved height, kerb-to-kerb half
    width and the footpath band beside it -- so that a pass which wants people
    walking the footpaths can derive them as
    `centreline +/- (halfWidth + KERB_WIDTH + footpathWidth/2)` from a file that
    already exists, instead of adding a second traversal of the same OSM ways
    with a second set of width constants that can drift from `streets.py`. The
    widths written here are read out of `streets.py` at build time for exactly
    that reason. Unlike a route, a way span **is** clipped to its own tile.

    Returns (ways, routes, bytes); deletes the file and returns zeroes for a tile
    with no drivable street on it, so a stale sidecar can never outlive the tile
    that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if tile.is_empty():
        path.unlink(missing_ok=True)
        return 0, 0, 0

    oe, on = origin
    out = bytearray(
        struct.pack("<IIII", LANES_MAGIC, LANES_VERSION, len(tile.ways), len(tile.routes))
    )
    for w in tile.ways:
        out += struct.pack(
            "<IBBHff",
            int(w.osm_id) & 0xFFFFFFFF,
            lanes.class_index(w.highway),
            1 if w.oneway else 0,
            len(w.pts) & 0xFFFF,
            float(w.half_width),
            float(w.footpath_width),
        )
        for (e, n), y in zip(w.pts, w.y):
            out += struct.pack("<fff", float(e - oe), float(y), float(-(n - on)))
    for r in tile.routes:
        bay0 = getattr(r, "bay0", None)
        bay1 = getattr(r, "bay1", None)
        duration = float(r.t[-1]) if len(r.t) else 0.0
        flags = (1 if bay0 is not None else 0) | (2 if bay1 is not None else 0)
        out += struct.pack(
            "<IBBHff",
            int(r.rid) & 0xFFFFFFFF,
            lanes.class_index(r.highway),
            flags,
            len(r.pts) & 0xFFFF,
            float(r.headway),
            float(r.phase),
        )
        # An unassigned end still writes a well-formed record: `parkT0 = 0` and
        # `parkT1 = duration` are the degenerate bay at the route's own end with
        # no lateral offset, which is what the client falls back to anyway. A
        # NaN or a sentinel here would reach the binary search in `poseCar`, and
        # a NaN in a binary search is a car in the wrong place rather than a
        # decode failure anybody notices.
        out += struct.pack(
            "<ffffff",
            float(bay0.t) if bay0 is not None else 0.0,
            # ENU east is renderer x; ENU north is renderer -z. The same flip
            # every point in this file gets, applied to a delta, so no origin.
            float(bay0.off_e) if bay0 is not None else 0.0,
            float(-bay0.off_n) if bay0 is not None else 0.0,
            float(bay1.t) if bay1 is not None else duration,
            float(bay1.off_e) if bay1 is not None else 0.0,
            float(-bay1.off_n) if bay1 is not None else 0.0,
        )
        for (e, n), y, t in zip(r.pts, r.y, r.t):
            out += struct.pack("<ffff", float(e - oe), float(y), float(-(n - on)), float(t))

    path.write_bytes(bytes(out))
    return len(tile.ways), len(tile.routes), len(out)


def write_water(path: Path, sheets: list, origin: tuple[float, float]) -> tuple[int, int, int]:
    """One tile's water surface. A mesh sidecar, little-endian.

        u32  magic       `WATER_MAGIC`, ASCII 'WATR' little-endian
        u32  version     `WATER_VERSION`
        u32  sheet count
        per sheet:
          f32  surfaceY   **absolute** metres above the datum, this sheet's level
          u32  vertex count
          u32  index count
          per vertex (12 bytes):
            f32  x, f32 z   tile-local metres, renderer axes (z = -north)
            f32  depth      metres of water over the bed at this vertex
          u32[index count]  triangle indices into this sheet's own vertices

    Returns (vertices, triangles, bytes); deletes the file and returns zeroes for
    a tile with no water on it, so a stale sidecar can never outlive the tile
    that produced it.

    Five things here are decisions rather than mechanics.

    **There is no y in the vertex record, and the sheet's own `surfaceY` is
    absolute.** Water is flat by definition -- that is what makes it read as
    water -- so a per-vertex height would be three bytes of a number that is the
    same for the whole sheet and one more place for it to disagree with itself.
    Absolute rather than tile-local for `write_power`'s reason: the client puts a
    tile's group at y = 0, so an absolute height needs no bias, and the sea does
    not know where a tile boundary is.

    **Several sheets per tile, not one.** A tile is 500 m and Sydney has ponds in
    parks 30 m above the harbour they drain toward; one surface per tile would
    put Busbys Pond at sea level or Rushcutters Bay in the treetops. In practice
    every tile in this extent carries exactly one -- the split is between tiles,
    not inside them -- and the format does not assume that, because the thing
    most likely to change is which polygons are admitted.

    **Depth is a vertex attribute and it interpolates exactly.** Every triangle
    written here lies inside a single terrain facet (`water.tile_sheets` cuts
    them there), the facet is planar, so `surface - ground` is linear across it
    and three corners determine it everywhere between. The client has no way to
    sample the terrain in a fragment and would otherwise have to be handed a
    height texture to tint a shoreline with.

    **Indices are u32 and per sheet.** A full-water tile is 1,549 vertices, so a
    u16 would do twice over -- and would need a split rule the day a tile carried
    a shoreline with more detail than one. Per sheet rather than per file so the
    client can build one mesh per surface level without rebasing anything.

    **The whole sheet is emitted even where a building stands on it.** Nothing in
    the extent does; a wharf is a `man_made=pier` and is not in this file's
    source. Stated because the obvious next question is whether the water is cut
    against the footprints, and the answer is that it is not and should not be --
    a pier stands *over* water and the sea goes under it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not sheets:
        path.unlink(missing_ok=True)
        return 0, 0, 0
    payload = _pack_water(sheets, origin)
    path.write_bytes(payload)
    return (
        sum(len(s.verts) for s in sheets),
        sum(len(np.asarray(s.tris).reshape(-1, 3)) for s in sheets),
        len(payload),
    )


def write_far_water(path: Path, sheets: list) -> dict:
    """The whole extent's tidal water, as one always-resident sheet.

    Byte-for-byte `write_water`'s format -- same magic, same version, same
    reader on the client -- with one difference that is not in the bytes:
    **the coordinates are world metres rather than tile-local**, exactly as
    `write_far` ships world coordinates for the same reason. This file arrives
    with no tile and therefore with no node translation to be relative to.

    It is what fills the harbour where there is no tile at all, which is most of
    Port Jackson: a tile is emitted only where there is something to stand on,
    and 52 of the 176 tiles water touches have nothing. It also carries the water
    past the streaming radius, which is the whole reason the harbour reads from a
    lookout.

    `water.FAR_SINK_M` has already been taken off each sheet's surface by
    `water.far_sheets`, so a tile's own water always wins where the two overlap.
    """
    payload = _pack_water(sheets, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return {
        "sheets": len(sheets),
        "vertices": sum(len(s.verts) for s in sheets),
        "triangles": sum(len(np.asarray(s.tris).reshape(-1, 3)) for s in sheets),
        "bytes": len(payload),
    }


def write_suburbs(path: Path, places: list) -> tuple[int, int]:
    """Every suburb and neighbourhood node in the build, as one world-wide file.

        [{"name": "Newtown", "x": -2639.3, "z": 3076.3}, ...]

    JSON rather than a binary sidecar, and belonging to no tile, for the same
    two reasons: it is 55 records for the whole inner ring at about 2 kB, and it
    is fetched once beside `index.json` and never evicted. A format that saved
    a kilobyte here would cost a decoder on the client and buy nothing.

    **World metres, not ENU and not tile-local.** Every other file in the build
    is tile-local because it is geometry a tile owns; this is a lookup table the
    client holds against a world-space player position, so the conversion
    happens here, once, rather than 55 times per query on the client. World
    axes, so `z = -north` -- the same flip every sidecar makes.

    Sorted by name so two builds of the same extent produce byte-identical
    files, which is what makes a diff of this directory mean something.

    Returns (records written, bytes).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [
        {
            "name": p.name,
            "x": round(float(p.east), 1),
            "z": round(float(-p.north), 1),
        }
        for p in sorted(places, key=lambda p: (p.name, p.osm_id))
    ]
    blob = json.dumps(payload)
    path.write_text(blob)
    return len(payload), len(blob)


def _pad_and_skirt(terrain, b: Building) -> tuple[float, float]:
    """Where this building's pad sits, and how far its walls run below it.

    The pad is the ground at the footprint CENTROID -- see `build_tile`, which
    argues for a levelled pad over a draped footprint and is right. The skirt is
    the exact answer over the footprint's *boundary*, which is where a gap would
    be seen: `terrain.densify` puts a vertex at every crossing of a terrain facet
    edge, and the ground is planar between two consecutive crossings, so the
    lowest point under the wall is one of them. A dip in the middle of a
    footprint is not this function's problem -- there is no wall there.

    THE PAD IS LOWERED WHERE THE SKIRT CANNOT REACH, and that is the one thing
    here that is not simply the measurement. `mesh.WALL_SKIRT_MAX` caps the
    buried wall at eight metres, for the good reason its own note gives: past
    that the tail is one mis-segmented footprint spanning a hillside rather than
    a real undercroft. But capping the skirt without moving the pad does not
    make the hole smaller -- it *is* the hole. Sixteen buildings in the inner
    ring, up to 19.8 m of drop, stood with daylight under their walls and their
    collision prism starting at the pad, so the player walked underneath the
    building and looked up into it.
    """
    pad = float(terrain.sample(*b.centroid))
    ring = mesh._ring_open(b.ring)
    if len(ring) < 3:
        return pad, mesh.WALL_SKIRT
    walk = terrain.densify(np.vstack((ring, ring[:1])))
    low = float(np.min(terrain.sample(walk[:, 0], walk[:, 1])))
    # Half a metre of margin over the measured drop, so a wall that only just
    # reaches is not resting on the exact edge of a float comparison. The pad
    # comes down by whatever that margin still leaves outside the cap, which on
    # a footprint the cap already covered is nothing at all.
    pad = min(pad, low + mesh.WALL_SKIRT_MAX - 0.5)
    drop = pad - low
    return pad, float(min(max(drop + 0.5, mesh.WALL_SKIRT), mesh.WALL_SKIRT_MAX))


def build_tile(
    tile_key: str,
    buildings: list[Building],
    street_network: streets.StreetNetwork | None = None,
    veg_network: vegetation.VegetationNetwork | None = None,
    parking_network: parking.ParkingNetwork | None = None,
    power_network: power.PowerNetwork | None = None,
    furniture_network: furniture.FurnitureNetwork | None = None,
    powerup_network: powerups.PowerupNetwork | None = None,
    awning_network: mesh.AwningNetwork | None = None,
    door_network: mesh.DoorNetwork | None = None,
    fence_network: fences.FenceNetwork | None = None,
    terrain=None,
    landmark_prisms: list | None = None,
    deck_network: decks.DeckNetwork | None = None,
    lane_network: lanes.LaneNetwork | None = None,
) -> TileResult | None:
    """Emit every artefact for one tile.

    Returns None only when the tile is genuinely empty -- no buildings, no
    streets *and* no park grass. A tile at the extent edge often has a road
    running through it and nothing built on it yet, and dropping those left
    visible gaps in the road network exactly where the world ends; the same is
    now true of a tile that is nothing but the middle of a park.
    """
    tx, tz = (int(v) for v in tile_key.split("_"))
    # Tile-local origin is the tile's south-west corner in ENU.
    origin = (tx * config.TILE_SIZE, tz * config.TILE_SIZE)

    slots: dict[str, mesh.MeshBuffers] = defaultdict(mesh.MeshBuffers)
    params: list[list[float]] = []

    # One pad per building, taken at the footprint centroid. Deliberately *not*
    # draped: a real building sits on a levelled pad, so a slope is answered by
    # cutting into the ground on the high side and by the buried skirt in
    # `mesh.build_walls` on the low side. Draping the footprint instead would
    # tilt every wall in the inner west, which is far more wrong and far more
    # visible than a pad that daylight-cuts.
    bases = [0.0] * len(buildings)
    skirts = [mesh.WALL_SKIRT] * len(buildings)
    if terrain is not None:
        for i, b in enumerate(buildings):
            bases[i], skirts[i] = _pad_and_skirt(terrain, b)

    # And the structures that do not start at the ground: bridges, elevated
    # walkways, anything OSM gave a `min_height`. `elevated.py` has already
    # decided how far over its own pad each one's underside sits and has taken
    # the same distance off its height, so the prism is [pad + base, roof] and
    # the player walks under it. Added here rather than folded into the pad
    # above because a pad is a measurement of the ground and this is not -- see
    # `merge.Building.base_height`.
    #
    # The skirt goes too, and has to: a skirt is the buried tail that stops
    # daylight showing under a wall on sloping ground, and on a structure that
    # is *meant* to have daylight under it, it is a metre and a half of wall
    # hanging below the soffit into the road.
    for i, b in enumerate(buildings):
        if b.base_height > 0.0:
            bases[i] += b.base_height
            skirts[i] = 0.0

    for i, b in enumerate(buildings):
        # An elevated structure gets no ground-level dressing. Each of the four
        # passes below assumes the wall it is decorating meets the footpath, and
        # on a bridge deck five metres up every one of them is nonsense in a
        # different way: a contact shadow on pavement the wall never touches, a
        # footpath awning cantilevered over the middle of a road, a front door
        # onto thin air, a garden fence around a span. The roof is the one
        # per-building emitter that still makes sense and is left alone.
        grounded = b.base_height <= 0.0
        wall_slot = slots[b.material]
        mesh.build_walls(wall_slot, b, i, origin, bases[i], skirts[i])
        roof_material = mesh.ROOF_MATERIAL.get(b.archetype, "roof_steel")
        # The roof takes the whole slot table because its trim is not all roof
        # material -- fascia, parapet capping and chimneys land in three other
        # slots that already exist. It hands back the one number only it knows,
        # the roof rectangle's half-width, which the parameter record carries so
        # the shader can eventually locate the ridge; see `mesh.facade_params`.
        roof_half_short = mesh.build_roof(slots, b, i, origin, bases[i], roof_material)
        # The footpath awning, on the street-facing edges only -- which is a
        # question about the road network, so this one takes the network rather
        # than the slot table alone. Spec 6.3's ground-floor override and 7.7's
        # "continuous cantilevered awnings"; see `mesh.AwningNetwork`.
        if awning_network is not None and grounded:
            awning_network.emit(slots, b, i, origin, bases[i])
        # The front door, spec 6.3's "Openings". Emits no geometry at all -- it
        # hands back one number, where the door stands along this building's own
        # walls, which the shader draws from. It takes the street network for the
        # same reason the awning does and asks it the same question through the
        # same test; see `mesh.DoorNetwork`.
        door_u = (
            mesh.DOOR_NONE
            if (door_network is None or not grounded)
            else door_network.place(b)
        )
        # The front fence, on the property line rather than on the building --
        # which is why it is the only per-building emitter here that takes the
        # terrain: everything else in this loop stands on the pad, and a fence
        # three metres out in the garden stands on the ground. It takes `door_u`
        # so the gate lines up with the way in. See `fences.py`.
        if fence_network is not None and grounded:
            fence_network.emit(slots, b, i, origin, door_u, terrain)
        params.append(
            mesh.facade_params(b, mesh.facade_seed(b.id, i), roof_half_short, door_u)
        )

    # The contact skirt, from the same footprints and in the same pass. It takes
    # no `base` and wants none: a pad daylight-cuts into a slope, so the line
    # where wall visibly meets ground is the terrain at both ends of a building
    # and the pad at neither. See `contact.py`.
    #
    # Filtered rather than given a base, and the filter is the point: a raised
    # structure has no line where wall meets ground, so there is nothing for the
    # skirt to be the shadow *of*. Left in, it painted a bridge-shaped stain on
    # the road surface underneath the span.
    contact.emit([b for b in buildings if b.base_height <= 0.0], slots, origin, terrain)

    if street_network is not None:
        street_network.emit(tile_key, slots, origin, terrain)
    # The elevated roads, after the ground ones and into the same two slots: a
    # deck's running surface is `road_asphalt` and its structure is
    # `footpath_concrete`, so a viaduct costs no material slot and therefore no
    # client change at all. See `decks.py`'s header for why that trade was taken.
    deck_prisms: list = []
    if deck_network is not None:
        deck_network.emit(tile_key, slots, origin)
        deck_prisms = deck_network.prisms(tile_key)
    # After the streets, because the grass has the carriageway cut out of it and
    # asks `street_network` for the same tile's surfaces to do it -- which is
    # free, since that call is memoised on its last key.
    if veg_network is not None:
        veg_network.emit_surface(tile_key, slots, origin, terrain)

    glb_path = config.TILE_DIR / f"{tile_key}.glb"
    glb_bytes, triangles = write_glb(glb_path, slots)
    if glb_bytes == 0:
        return None

    # The ground itself. Written after the geometry check, because a tile with no
    # geometry is not emitted at all and a terrain sidecar for one would be a
    # file the index never mentions and nothing ever fetches.
    ground = (
        np.zeros((config.TERRAIN_GRID + 1, config.TERRAIN_GRID + 1), dtype=np.float32)
        if terrain is None
        else terrain.grid_for_tile(tile_key)
    )
    write_terrain(config.TILE_DIR / f"{tile_key}.terr.bin", ground)

    trees = veg_network.instances(tile_key) if veg_network is not None else []
    write_vegetation(config.TILE_DIR / f"{tile_key}.veg.bin", trees, origin)

    # Cars are visual only. They are deliberately absent from `write_collision`
    # below: the collision payload is the building prisms and nothing else, the
    # server never sees a render mesh, and whether a parked car is solid is a
    # gameplay decision this pass has no business making. See spec section 5.
    cars = parking_network.instances(tile_key) if parking_network is not None else []
    write_parking(config.TILE_DIR / f"{tile_key}.cars.bin", cars, origin)

    # Poles and wires, on the same terms as the cars: visual only, no collision.
    # A pole is a 0.32 m cylinder in the middle of a footpath and is exactly the
    # kind of thing a melee player should be able to dodge behind, so it is a
    # real candidate for the collision payload later -- but the payload is the
    # building prisms today and adding to it is a format change and a server
    # change, which is spec section 5's business and not this pass's.
    lines = (
        power_network.instances(tile_key) if power_network is not None else power.TilePower()
    )
    write_power(config.TILE_DIR / f"{tile_key}.power.bin", lines, origin)

    # Street furniture, on the same terms again: visual only, no collision. A
    # wheelie bin is the one thing in this file a melee player would expect to be
    # able to knock over, and making it so needs both a dynamic-object payload
    # the server does not have and a decision nobody has made -- so it is the
    # same follow-up the poles and the parked cars are already waiting on.
    props = (
        furniture_network.instances(tile_key)
        if furniture_network is not None
        else furniture.TileFurniture()
    )
    write_furniture(config.TILE_DIR / f"{tile_key}.furn.bin", props, origin)

    # Spec 8.3's powerups, on the same terms again: visual and gameplay only, no
    # collision. A floating icon you walk *through* is what the spec asks for --
    # "touch a station entrance" -- so unlike the poles and the bins this is the
    # one instanced thing in the build that must never enter the collision
    # payload, rather than one that is waiting for a decision.
    picks = (
        powerup_network.instances(tile_key)
        if powerup_network is not None
        else powerups.TilePowerups()
    )
    write_powerups(config.TILE_DIR / f"{tile_key}.pow.bin", picks, origin)

    # The named centrelines. The one sidecar here that carries no instances and
    # draws nothing: it is what lets the client name the street under the player
    # mid-block, which the furniture blades cannot -- a blade stands at a
    # junction. See `write_street_names` and `client/src/game/locator.ts`.
    named = (
        street_network.named_segments(tile_key) if street_network is not None else []
    )
    named_runs, names_bytes = write_street_names(
        config.TILE_DIR / f"{tile_key}.names.bin", named, origin
    )

    # The lane graph and the traffic on it. Emits nothing to any material slot
    # and draws nothing at all: like `.names.bin` it is a data sidecar, and
    # unlike every instance sidecar above it the thing it describes is not a
    # *place* but a *timetable*. See `write_lanes`, and `lanes.py` for why a
    # moving car costs no bandwidth.
    tile_lanes = (
        lane_network.instances(tile_key) if lane_network is not None else lanes.TileLanes()
    )
    lane_ways, lane_routes, lanes_bytes = write_lanes(
        config.TILE_DIR / f"{tile_key}.lanes.bin", tile_lanes, origin
    )

    # The water. Read off the terrain rather than passed in, because the polygons
    # that decide where the sheets go are the same polygons that decided where
    # the bed went -- `water.conform` cut it inside `Terrain.load`, and two
    # sources for where the harbour is would be one too many.
    sheets = (
        water.tile_sheets(terrain.water, tile_key, terrain)
        if terrain is not None and getattr(terrain, "water", None) is not None
        else []
    )
    # The creeks, on the same terms and into the same sidecar. Attached to the
    # terrain by `cmd_build` *after* the solve rather than inside `Terrain.load`,
    # because the whole point of the module is that it does not move the ground --
    # see `creeks.py`'s header on why it is not in the terrain cache key. A tile
    # with no creek on it queries an r-tree and gets nothing back.
    #
    # **Kept in their own list, and the reason is the wading rule below.** A tile
    # carries one water level for gameplay -- `wy`, the level of its largest sheet
    # -- and `world/wading.ts` states the invariant that makes that sound: a tile
    # has at most one body of water on it, so one number describes all of it. A
    # creek breaks that outright. Its sheets are dozens of 10 m reaches at dozens
    # of levels, none of them the tile's water, and the largest of them would set a
    # tile-wide level from a puddle -- so a player standing in the gully the creek
    # has *already run down*, ten metres below the reach that happened to win,
    # would be ten metres under water on dry ground and unable to move.
    #
    # So creeks are drawn and never waded. That costs nothing worth having: a
    # reach is `creeks.CREEK_STAND_M` deep at its deepest, which is 40 cm, and
    # ankle-deep water that slows you slightly is the one part of this the player
    # would never notice missing.
    creek_sheets = (
        creeks.tile_sheets(getattr(terrain, "creeks", None), tile_key, terrain)
        if terrain is not None
        else []
    )
    water_verts, water_tris, water_bytes = write_water(
        config.TILE_DIR / f"{tile_key}.water.bin", sheets + creek_sheets, origin
    )
    # The level of the sheet with the most area on this tile. One number for a
    # tile that may carry several, because what reads it is the wading rule and a
    # player is in one body of water at a time -- see `TileResult.water_y`.
    water_area = 0.0
    water_y = 0.0
    for sheet in sheets:
        area = float(_sheet_area(sheet))
        if area > water_area:
            water_area = area
            water_y = float(sheet.surface)

    params_bytes = write_params(config.TILE_DIR / f"{tile_key}.params.bin", params)
    # The landmark volumes go in with the buildings, not beside them: the deck of
    # the Harbour Bridge crosses six tiles and each one carries the segments whose
    # centre lands on it, so walking the deck is walking off one tile's prisms and
    # onto the next's -- exactly as walking a street is. See
    # `landmarks.prisms_by_tile`.
    # The deck volumes go in beside the landmark ones and in the same format --
    # a plan ring and `[base, base + height]` -- because that is what a deck is
    # and the Harbour Bridge's own has been written this way since terrain
    # arrived. See `decks.DeckNetwork.prisms`.
    # `collision_buildings` rather than `len(buildings)`, and the difference is
    # the whole of `Prism.structural`: the index's `b` is subtracted from the
    # payload's count word on both authorities to find the decks, so it has to be
    # the number of building rings the payload actually carries and not the
    # number this pass was offered. See `write_collision`'s return contract.
    collision_bytes, collision_buildings = write_collision(
        config.COLLISION_DIR / f"{tile_key}.bin",
        buildings,
        origin,
        bases,
        list(landmark_prisms or ()) + deck_prisms,
    )

    # The tallest thing standing on this tile, and a deck counts. The client
    # sizes its cull box from this number, and a tile that is nothing but harbour
    # and the Western Distributor has no building to size it from -- so without
    # the deck the viaduct vanishes the moment the player is not standing on it.
    # An elevated structure's top is its soffit *plus* its own height, so the
    # base has to be in this number: a footbridge 5 m up is 5 m taller than its
    # prism, and a cull box sized from the prism alone would pop it out of frame
    # the moment the player is not standing under it -- the same failure the
    # decks below already had to be added for.
    height_max = max((b.height + b.base_height for b in buildings), default=0.0)
    if deck_network is not None:
        height_max = max(height_max, deck_network.height_max(tile_key))

    # World-space bounds. The renderer's Z axis points south, so a tile at
    # tz = +1 sits at negative world Z.
    wx0 = tx * config.TILE_SIZE
    wz1 = -(tz * config.TILE_SIZE)
    wz0 = wz1 - config.TILE_SIZE
    return TileResult(
        key=tile_key,
        buildings=collision_buildings,
        triangles=triangles,
        glb_bytes=glb_bytes,
        params_bytes=params_bytes,
        collision_bytes=collision_bytes,
        bounds=(wx0, wz0, wx0 + config.TILE_SIZE, wz1),
        height_max=height_max,
        trees=len(trees),
        cars=len(cars),
        poles=len(lines.poles),
        spans=len(lines.spans),
        bins=len(props.bins),
        posts=len(props.posts),
        signals=len(props.signals),
        powerups=len(picks.points),
        street_names=named_runs,
        names_bytes=names_bytes,
        water_verts=water_verts,
        water_tris=water_tris,
        water_bytes=water_bytes,
        water_y=water_y,
        water_area=water_area,
        lane_ways=lane_ways,
        lane_routes=lane_routes,
        lane_cars=sum(r.live for r in tile_lanes.routes),
        lanes_bytes=lanes_bytes,
        ground_min=float(ground.min()),
        ground_max=float(ground.max()),
    )


def _sheet_area(sheet) -> float:
    """Plan area of one triangulated sheet, m2.

    Summed off the triangles rather than asked of a polygon, because by this
    point there is no polygon: `water.tile_sheets` has already cut the clip
    against the terrain's facets and triangulated it. Twice the signed area of
    each triangle, absolute -- the winding is CCW in ENU by construction, but
    taking the absolute value means a sheet that ever came back the other way
    round reports its size rather than its negation.
    """
    v = np.asarray(sheet.verts, dtype=np.float64)
    t = np.asarray(sheet.tris, dtype=np.int64).reshape(-1, 3)
    if len(t) == 0:
        return 0.0
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    return float(np.abs(cross).sum() * 0.5)


def write_index(
    results: list[TileResult],
    stage: str,
    radius_m: float,
    terrain=None,
    far: dict | None = None,
    water_contract: dict | None = None,
    landmark_contract: dict | None = None,
    lanes_contract: dict | None = None,
    street_names_contract: dict | None = None,
    regions_contract: dict | None = None,
) -> Path:
    """The spatial index the client streams against.

    A flat list rather than a nested quadtree: at 500 m tiles even the 35 km
    stage is ~15,000 entries, which is a 1 MB JSON the client can hold entirely
    and cull against with a linear pass in well under a millisecond. A quadtree
    would be premature here and harder to extend in place.
    """
    payload = {
        # 3: every tile carries a terrain sidecar, buildings stand on a pad
        # rather than on y = 0, and the collision payload gained a per-building
        # base. All three arrived together and none is separable, so they share
        # one number.
        "version": 3,
        # When this index was written, epoch seconds -- the build stamp, and the
        # only field here that is about the *run* rather than about the world.
        #
        # It exists so the world can be served with a one-year immutable cache
        # without a retile stranding a player on a mixture of two builds. Tiles
        # are not content-addressed: `5_-1.glb` is a grid coordinate, and a
        # re-run writes different bytes under the same name, so a long cache on
        # the path alone is a seam through the middle of the map that no reload
        # can clear. The client appends this as `?v=` to every asset it fetches
        # (see `client/src/world/version.ts`), which changes every URL on every
        # build and makes the cache miss exactly once, everywhere, on its own.
        #
        # Written on every run rather than only when a tile changed, and that is
        # deliberate: `_emit_far`, the suburb table and the street-name sidecars
        # can all move without a single tile being re-emitted, and a stamp that
        # only advanced with the tiles would serve one of those stale for a year.
        # The cost of being wrong the other way is one re-download of a world
        # that was rebuilt, which is what a rebuild is.
        "built": int(time.time()),
        "stage": stage,
        "radius_m": radius_m,
        "tile_size": config.TILE_SIZE,
        "origin": {"lat": config.ORIGIN_LAT, "lon": config.ORIGIN_LON, "crs": config.CRS_PROJECTED},
        "sun": {"lat": config.SUN_LAT, "lon": config.SUN_LON, "timezone": config.TIMEZONE},
        # The ground contract, so the client repeats none of these constants.
        #
        # `datum_ahd` is the elevation the world's y = 0 sits at, and it is the
        # one number here that is not used for rendering: it is what turns a
        # world height back into a real one when checking the build against a
        # map. `sea_level_y` is derived from it and *is* used -- it is where the
        # far plane beyond tile coverage goes, which is the one place the world
        # has to state where the water is.
        "terrain": {
            "grid": config.TERRAIN_GRID,
            "post_m": config.TILE_SIZE / config.TERRAIN_GRID,
            "datum_ahd": round(terrain.base_elevation, 3) if terrain is not None else 0.0,
            "sea_level_y": round(-terrain.base_elevation, 3) if terrain is not None else 0.0,
        },
        "materials": list(mesh.MATERIALS),
        "archetypes": list(mesh.ARCHETYPES if hasattr(mesh, "ARCHETYPES") else []),
        "params_stride": mesh.PARAMS_STRIDE,
        # The far layer's contract. Absent on an index written before the far
        # layer existed, and the client treats absence as "there is no far
        # layer" rather than defaulting anything -- unlike `terrain` above,
        # there is no sensible stand-in for a city on the horizon.
        **({"far": far} if far is not None else {}),
        # The water contract. Absent means this world has no water at all, and
        # the client treats absence the way it treats a missing far layer --
        # nothing is fetched and nothing is drawn -- rather than defaulting a sea
        # level, because an index written before this pass describes a world
        # whose harbour is dry ground and drawing water on it would put a sheet
        # through the middle of Barangaroo.
        **({"water": water_contract} if water_contract is not None else {}),
        # The landmark set's contract, on the far layer's terms: absent means
        # this world has no `landmarks.glb` and the client fetches nothing. A
        # world built before this pass has three generic extrusions where the
        # Harbour Bridge, the Opera House and Sydney Tower should be, and it
        # still loads -- which is the same promise every optional block above
        # makes and the reason none of them has a default.
        **({"landmarks": landmark_contract} if landmark_contract is not None else {}),
        # The traffic contract, on the same terms as every optional block above:
        # absent means this world has no lane graph, the client fetches no
        # `.lanes.bin` and no car moves -- which is exactly what a world built
        # before this pass is, and it still loads. What it carries is the two
        # numbers gameplay cannot derive from a single tile (`hz`, the rate the
        # timetable is denominated in, and `epoch_ms`, the instant tick zero
        # sits at) plus the totals a build report and the audit read.
        **({"lanes": lanes_contract} if lanes_contract is not None else {}),
        # The big map's street-name bundle, on the same terms as every optional
        # block above: absent means this world has no `street-names.bin`, and
        # the client falls back to fetching the per-tile `.names.bin` sidecars
        # one by one -- which is exactly what it did before this file existed
        # and what a world built by an older pipeline still gets. The block is
        # also omitted on a build whose bundle came out empty, so "present"
        # always means "there is a file worth one request". See
        # `write_street_name_bundle` and `client/src/mapatlas.ts`.
        **(
            {"street_names": street_names_contract}
            if street_names_contract and street_names_contract.get("runs")
            else {}
        ),
        # How this build's vertex attributes are packed, and how far that moved
        # the city. `pack` is the format version and the client refuses one it
        # does not know; the three errors are the *measured* worst case over
        # every primitive in the build, and they are in the index rather than in
        # a build log because the claim they support -- that the drift is
        # cosmetic and below anything the eye or the collision can see -- is one
        # a later build could quietly break. See `sydney.meshpack`.
        "geometry": {
            "pack": meshpack.PACK_VERSION,
            "max_position_error_mm": round(PACK_ERROR["position_m"] * 1000.0, 3),
            "max_uv_error_mm": round(PACK_ERROR["uv_m"] * 1000.0, 3),
            "max_normal_error_deg": round(PACK_ERROR["normal_deg"], 4),
        },
        # The streaming bundles. Absent means this world has no `regions/` and
        # the client fetches every tile file one by one -- which is exactly what
        # it did before this pass and what a world built by an older pipeline
        # still gets, on the same terms as every optional block above. See
        # `sydney.regions` and `client/src/world/regions.ts`.
        **(
            {"regions": regions_contract}
            if regions_contract and regions_contract.get("count")
            else {}
        ),
        "tiles": [
            {
                "key": r.key,
                "b": r.buildings,
                "t": r.triangles,
                "bounds": [round(v, 1) for v in r.bounds],
                "hmax": round(r.height_max, 1),
                "size": r.glb_bytes,
                # Tree count. The client reads it to decide whether to fetch the
                # sidecar at all, so a tile with no trees costs no request --
                # which is most of them, and 404s are not free on a cold cache.
                "v": r.trees,
                # Parked car count, for exactly the same reason. A park tile or a
                # motorway tile has none and never asks for the file.
                "c": r.cars,
                # Power poles, and wire spans owned by this tile. Two numbers
                # rather than one because they are not the same set: a span is
                # filed under the tile holding its midpoint, so a tile can own a
                # span with both its poles next door. The client fetches
                # `.power.bin` when *either* is non-zero, and a test on the poles
                # alone would silently drop those spans at every seam.
                "p": r.poles,
                "w": r.spans,
                # Street furniture, three counts sharing one sidecar. The client
                # fetches `.furn.bin` when any of them is non-zero, and it needs
                # all three separately anyway to decide which instanced meshes to
                # build -- a tile with signals and no bins is common, since the
                # signalised crossings are on the arterials the bins avoid.
                "fb": r.bins,
                "fp": r.posts,
                "fs": r.signals,
                # Spec 8.3's powerups in this tile's `.pow.bin`. One number,
                # unlike the furniture's three, because the two kinds share a
                # client module as well as a sidecar -- the fetch test and the
                # "does this tile build anything" test are the same question.
                "pw": r.powerups,
                # Named centreline runs in this tile's `.names.bin`. The client's
                # fetch test, like every count above it -- and unlike them it is
                # non-zero on very nearly every tile in the build, because a tile
                # with no named street on it is a park or the harbour.
                "sn": r.street_names,
                # This tile's water. `wv` is the vertex count and is the client's
                # fetch test, like every count above it; `wy` is the surface
                # level of the largest sheet on the tile and is the one field in
                # this record **gameplay** reads -- both the client and the Bun
                # server derive the wading rule from it, which is what lets them
                # agree without a protocol change. See `world/wading.ts`.
                #
                # Both are omitted on a dry tile rather than written as zero, and
                # that is not tidiness: `wy` is a world height and zero is a
                # perfectly plausible one -- 71 m above the datum's own ground --
                # so a dry tile carrying `wy: 0` would be a tile claiming a lake
                # at eye level over Surry Hills. Absent means no water, which is
                # the same contract `v`, `c` and `pw` have.
                #
                # **And the two are gated on different things, which the creeks
                # made necessary.** `wv` is the client's fetch test and must count
                # every vertex in the sidecar, creeks included, or a tile with a
                # creek on it and no harbour never asks for its own water. `wy` is
                # the *wading* level and creeks are deliberately not in it -- see
                # `build_tile`, where the creek sheets are kept out of the area
                # comparison for a whole paragraph's worth of reason. So on a
                # creek-only tile `water_verts` is thousands and `water_area` is
                # zero, and gating `wy` on the vertex count would have written
                # `wy: 0` on 11,959 of this world's tiles: a lake at 71 m AHD over
                # four fifths of Sydney, and every player standing under it
                # rejected by the deep-entry rule on dry ground. The paragraph
                # above describes that exact failure for a dry tile; the creeks
                # are how a *wet* one gets it.
                **({"wv": r.water_verts} if r.water_verts else {}),
                **({"wy": round(r.water_y, 3)} if r.water_area > 0.0 else {}),
                # This tile's `.lanes.bin`. `lw` is the way-span count and `lr`
                # the route count, and the client's fetch test is the union --
                # a tile can carry streets with no traffic scheduled on them
                # (a cul-de-sac suburb, which is common) and the ways block is
                # wanted there anyway. Both omitted on a tile with no drivable
                # street on it, which is the same contract `v`, `c` and `pw`
                # have.
                **({"lw": r.lane_ways, "lr": r.lane_routes} if r.lanes_bytes else {}),
                # Ground range over the tile, [min, max] metres. The client sizes
                # this tile's cull box from the sidecar it loads anyway; this is
                # here so a build can be audited for relief -- and for a flat
                # world regressing to a pancake -- without opening 220 files.
                "g": [round(r.ground_min, 1), round(r.ground_max, 1)],
            }
            for r in sorted(results, key=lambda r: r.key)
        ],
        "totals": {
            "tiles": len(results),
            "buildings": sum(r.buildings for r in results),
            "trees": sum(r.trees for r in results),
            "cars": sum(r.cars for r in results),
            "poles": sum(r.poles for r in results),
            "spans": sum(r.spans for r in results),
            "bins": sum(r.bins for r in results),
            "name_posts": sum(r.posts for r in results),
            "signals": sum(r.signals for r in results),
            "powerups": sum(r.powerups for r in results),
            "street_names": sum(r.street_names for r in results),
            "water_tiles": sum(1 for r in results if r.water_verts),
            "water_triangles": sum(r.water_tris for r in results),
            "water_bytes": sum(r.water_bytes for r in results),
            "triangles": sum(r.triangles for r in results),
            "glb_bytes": sum(r.glb_bytes for r in results),
            "params_bytes": sum(r.params_bytes for r in results),
            "collision_bytes": sum(r.collision_bytes for r in results),
            "names_bytes": sum(r.names_bytes for r in results),
        },
    }
    config.INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.INDEX_PATH.write_text(json.dumps(payload))
    return config.INDEX_PATH


# --- The far layer ------------------------------------------------------------
#
# Everything above this line is per tile and is streamed. This is the opposite:
# two files for the whole build, loaded once beside `index.json` and never
# evicted, describing every significant building in the extent as a single
# oriented box and the whole extent's ground as one coarse heightfield.
#
# It exists because the streaming radius is a *hole in the world*, not a horizon.
# Past 1,800 m the pipeline's output simply stops: from Alexandria the CBD tower
# cluster -- which is 4 km away and 260 m tall, and is the single most
# recognisable thing about Sydney -- is not drawn at all, and the fabric ends in
# a hard edge with bare ground beyond it. Spec 3.2's LOD table calls the 2 km+
# band an "impostor / merged block silhouette"; a box per building is the honest
# first cut at that, and it is what makes the city run to the horizon.
#
# The design rests on one property, and the whole of this section's history is
# the story of getting it to actually hold: **a slab must never cover ground its
# own building does not**. Where that holds, a slab inside the streamed radius is
# inside the real walls, the depth buffer hides it, and there is nothing to
# manage. Where it fails, the failure is not subtle -- it is a flat unlit box
# standing across a street at eye level with no collision on it, which the player
# walks through and sees.
#
# It used to be attempted with a *bounding rectangle shrunk 3%*, and that could
# not hold, because a footprint does not fill its own rectangle. The Oxford Hotel
# in Darlinghurst is perfectly convex and fills 72% of its minimum rotated
# rectangle; the concavity shrink below is exactly 1.0 on a convex polygon, by
# design, so nothing was taken off it and the slab stood across Oxford Street.
# Measured over 40 tiles by `cli.cmd_carriageway_audit`, the rectangles put
# 35,818 m2 of flat wall on the carriageway -- 2.79% of the asphalt in the
# sample.
#
# The plan is now the footprint's **convex hull**, simplified and inset, and the
# property is restored by construction rather than by a shrink chosen to make an
# average look acceptable: on a convex footprint the hull *is* the footprint, so
# the slab is inside the real walls exactly. See `_slab_plan`.

# What earns a slab. Below both of these a building does not read at range: a
# 6 m house 2 km away is 0.17 degrees tall and lands inside the ground haze,
# where all it can contribute is speckle. Height wins for the towers and the
# walk-ups; area wins for the warehouses and the big-box retail that are wide,
# flat and still very much part of the skyline of a suburb.
FAR_MIN_HEIGHT = 10.0
FAR_MIN_AREA = 400.0

# How far every slab face is pulled in off the wall it stands behind, metres.
#
# A **metric** inset, not the old 1.5%-per-side proportional one, and the change
# of kind is the point. What this has to clear is a wall plane: the hull of a
# convex footprint runs exactly along its walls, so with no inset at all the slab
# face would be *coplanar* with a facade, which z-fights over a whole building.
# The distance that has to be cleared is a distance, and it does not get smaller
# because the building is small -- 1.5% of a 10 m terrace was 15 cm, which is
# under the depth buffer's own resolution at 500 m and under the width of the
# mortar course it was hiding behind.
#
# 0.4 m is comfortably over that and comfortably under anything visible at the
# ranges a slab is *seen* at: at the 1,800 m streaming radius it is 0.013 degrees,
# a fortieth of a pixel at 1080p and a 75-degree field.
FAR_INSET = 0.4

# The most plan vertices a slab may have, and the whole of the triangle budget.
#
# A hull prism is `2n` vertices and `3n - 2` triangles against a box's 20 and 10,
# so the cost of this feature is set here and nowhere else. Measured over the
# 12,779 footprints that earn a slab, the convex hull has a *median of 5*
# vertices and a mean of 5.9 -- Sydney's building stock is overwhelmingly
# rectangles and near-rectangles -- and only 651 of them (5.1%) have more than
# ten. So the cap is paid by one building in twenty and buys a hard ceiling of
# 28 triangles a slab; the layer lands at 187,981 triangles, against the boxes'
# 127,780 and a budget of a million -- and on *fewer* vertices than the boxes,
# 142,358 against 255,560, because a prism shares its ring between the walls that
# meet on it and the cap that fans off it where a box repeated every corner four
# times to carry normals nothing reads.
#
# Simplification is Douglas-Peucker on the *hull*, which is the one place it is
# safe: dropping a vertex from a convex ring leaves a convex ring, and one that
# is strictly *inside* the ring it came from. It can therefore only ever take
# area off a slab, never add it, so the containment argument this whole section
# rests on survives it untouched.
FAR_MAX_PLAN_VERTS = 10

# The concavity match, kept from the rectangle era with its floor and its reason.
#
# The hull fixes the *convex* case exactly and cannot fix the concave one: a hull
# around an L covers the notch by definition, and that is now the only spill left
# in the layer. So each plan is still scaled by `sqrt(footprint area / hull area)`
# -- 1.0 on a convex footprint, which is why the Oxford Hotel and every CBD tower
# keep their full width -- and the scaling is now about the **footprint centroid**
# rather than a box centre, which sits in an L's mass rather than in its notch.
#
# That centroid choice was rejected in the rectangle era for a specific reason
# that no longer exists: it moved the slab out of its own bounding rectangle, and
# the rectangle was the containment proof. The proof is now the hull, and a convex
# set scaled by s <= 1 about any interior point stays inside itself -- so the
# centroid is free to be the better point.
#
# The floor is for a long thin diagonal sliver whose convexity collapses; under
# 1% of the kept set reaches it.
FAR_AREA_MATCH_FLOOR = 0.6

# How far the slab's bottom is buried below whichever surface is lower, the real
# terrain or the far terrain. Two metres of burial is what stops a slab standing
# on a visible sliver of its own base where the coarse far ground happens to run
# below the real one.
FAR_BURY = 2.0

# Ceiling on the far terrain's post count along one edge.
#
# The grid is always resident and always drawn, so this is a triangle budget
# rather than an accuracy target: 257 posts is 131,072 triangles in one draw
# call, which is a fifth of a dense spawn view and costs no fetch, no eviction
# and no shadow pass. The *spacing* is then whatever the extent needs -- 62.5 m
# at the 4 km stage, 125 m at 15 km, 250 m at 35 km -- and it is always a whole
# multiple of the terrain lattice's own 31.25 m so every far post lands exactly
# on a real one.
FAR_MAX_POSTS = 257

# Margin added to the measured worst-case overshoot when sinking the far terrain.
FAR_SINK_MARGIN = 0.5

# `far.bin`'s magic and its format version. Both are checked by the client, and
# a mismatch on either means "no far layer" rather than a misread one -- see
# `write_far` for the layout and `client/src/world/far.ts` for the parser.
#
# Version 2 is the hull plan. Version 1 was the oriented box: seven floats and
# two bytes per slab at a fixed 32-byte stride, with no plan vertices and no tile
# grouping in the file at all.
FAR_MAGIC = 0x53524146  # b"FARS", little-endian
FAR_VERSION = 2

# Bytes per fixed-size record in `far.bin`. The plan vertices are variable and
# live in their own block; these are the two tables that index it.
FAR_GROUP_STRIDE = 16
FAR_SLAB_STRIDE = 16


def _slab_plan(ring: np.ndarray) -> np.ndarray | None:
    """Footprint -> the convex plan the far layer extrudes, or None.

    Returns an (n, 2) array of ENU (east, north) vertices, wound **anticlockwise**
    like every exterior ring in this pipeline, open (no repeated first point).

    Three operations, in this order, and each one can only ever remove area:

      1. **Convex hull.** This is the whole fix. A bounding rectangle covers
         ground the building does not for two unrelated reasons -- the footprint's
         own concavity, and the corners it merely chamfers off the box -- and the
         second one is invisible to any shrink keyed on area, because a chamfered
         tower is convex and a shrink that respects convexity leaves it alone.
         Taking the hull removes it by construction: on a convex footprint the
         hull *is* the footprint, so the plan is the building's own walls and
         there is no spill to shrink away. The Oxford Hotel, Darlinghurst -- the
         case that opened this -- is convex, fills 72% of its rectangle, and comes
         out of here as its own outline.

      2. **Simplify to `FAR_MAX_PLAN_VERTS`.** Douglas-Peucker on a convex ring
         drops vertices and never invents them, so the result stays convex and
         stays inside. The tolerance is searched rather than fixed, because a
         tolerance that reduces a 40-vertex curved tower to ten would flatten a
         12-vertex terrace into a triangle.

      3. **The concavity match, then the inset.** See `FAR_AREA_MATCH_FLOOR` and
         `FAR_INSET`. The scale is about the *footprint* centroid, which is the
         point in an L's mass rather than in its notch, and a convex plan scaled
         about an interior point stays inside itself.

    None for a degenerate ring, or for one the inset eats entirely -- both of
    which mean "this building gets no slab", which is the right answer for a
    footprint under a metre across.
    """
    from shapely.affinity import scale as affine_scale
    from shapely.geometry import Point, Polygon
    from shapely.geometry.polygon import orient

    if len(ring) < 3:
        return None
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.area <= 0.0 or poly.geom_type != "Polygon":
        return None

    hull = poly.convex_hull
    if hull.geom_type != "Polygon" or hull.area <= 0.0:
        return None

    # Simplify by doubling the tolerance until the ring fits, starting well under
    # anything that could matter. Bounded rather than `while True`: a ring that is
    # still over the cap at 8 m is not a building shape and is better shipped a
    # little over budget than looped on.
    plan = hull
    tol = 0.25
    for _ in range(6):
        if len(plan.exterior.coords) - 1 <= FAR_MAX_PLAN_VERTS:
            break
        simple = hull.simplify(tol)
        if simple.geom_type == "Polygon" and simple.area > 0.0:
            plan = simple
        tol *= 2.0

    # The concavity match. `min(..., 1.0)` because a repaired footprint can come
    # back a hair larger than the hull it was measured against.
    convexity = min(poly.area / hull.area, 1.0)
    scale = max(math.sqrt(convexity), FAR_AREA_MATCH_FLOOR)
    if scale < 1.0:
        # The pivot has to be *inside the plan* for the containment argument to
        # hold. The footprint centroid is inside the hull always and inside the
        # simplified hull in practice; where a simplification has cut past it,
        # the plan's own centroid is inside by convexity.
        pivot = poly.centroid
        if not plan.contains(Point(pivot.x, pivot.y)):
            pivot = plan.centroid
        plan = affine_scale(plan, xfact=scale, yfact=scale, origin=(pivot.x, pivot.y))

    # And the inset, as a real offset rather than a proportion -- see `FAR_INSET`.
    # A negative buffer on a convex polygon is exact and stays convex; it can
    # empty a small one, which is the one case this returns None for.
    inset = plan.buffer(-FAR_INSET, join_style=2)
    if inset.geom_type == "Polygon" and not inset.is_empty and inset.area > 1.0:
        plan = inset
    else:
        # Too small to inset by 0.4 m and still be a building. Fall back to the
        # proportional shrink the box era used, which cannot empty a polygon --
        # the face is then closer to the wall than the depth buffer likes, on a
        # building whose whole plan is under 2 m across.
        c = plan.centroid
        plan = affine_scale(plan, xfact=0.97, yfact=0.97, origin=(c.x, c.y))

    pts = np.asarray(orient(plan, 1.0).exterior.coords)[:-1]
    if len(pts) < 3:
        return None
    return _strictly_convex_f32(pts)


def _strictly_convex_f32(pts: np.ndarray) -> np.ndarray | None:
    """Round a plan ring to float32 and drop every vertex that is not a corner.

    **The rounding comes first, and that is the entire point of the function.**
    `far.bin` ships float32, the client fans each cap from vertex 0 and takes the
    winding as given, and a fan is only correct on a ring that is convex *in the
    arithmetic doing the fanning*. Two hull vertices 8 cm apart on a 300 m-long
    building are collinear to within a float32 ulp at that distance, so a ring
    that is convex in float64 can come back with a reflex corner once written --
    measured over the inner ring, 14 corners across 12,778 slabs, worst case
    0.0033 m2 of area. Each one is a cap triangle wound the wrong way, which the
    GPU back-face culls: a hole in a roof, four hundredths of a square millimetre
    across, and nothing anywhere says so.

    So the ring is rounded and then pruned until every corner turns strictly
    left, which is convexity in the shipped precision by construction rather than
    within a tolerance nobody can name. It removes 7 vertices from the whole
    build; it is here for the guarantee, not the saving.

    Anticlockwise in ENU throughout -- `orient` has already been applied, and a
    left turn is what that means.
    """
    ring = [tuple(p) for p in np.asarray(pts, dtype=np.float32).astype(np.float64)]
    changed = True
    while changed and len(ring) > 3:
        changed = False
        for i in range(len(ring)):
            a = ring[i - 1]
            b = ring[i]
            c = ring[(i + 1) % len(ring)]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 0.0:
                del ring[i]
                changed = True
                break
    if len(ring) < 3:
        return None
    # A triangle that survived the loop only because the loop stops at three, and
    # is still degenerate, is not a building.
    a, b, c = ring[0], ring[1], ring[2]
    if len(ring) == 3 and (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0.0:
        return None
    return np.ascontiguousarray(ring, dtype=np.float64)


def build_far_terrain(terrain) -> tuple[np.ndarray, float, float, float]:
    """The whole extent's ground as one coarse grid, and the sink it needs.

    Returns (grid, post_m, half_extent_m, sink_m). The grid is row-major with
    **row 0 the northern edge**, which is `write_terrain`'s convention and the
    client's, so the same mesh builder walks both without transposing.

    Posts are a whole stride of the terrain lattice, never an interpolation of
    it: the coarse surface therefore passes exactly through real terrain posts
    and can only disagree with the streamed tiles *between* them.

    `sink_m` is measured, not chosen, and it is the number the whole arrangement
    turns on. The far ground has to lose to a streamed tile's ground everywhere
    the two overlap, or a coarse facet pokes up through the real one and the
    player sees a 60 m triangle of the wrong hill in the middle of a street. How
    far it has to be pushed down is exactly the worst amount by which the coarse
    surface stands above the real one, and that is a property of this extent's
    relief at this spacing -- so it is evaluated here, over every lattice post,
    against the same triangulated interpolation the client renders, and shipped
    in `index.json` rather than guessed at and hard-coded.
    """
    from .terrain import Terrain, _Lattice

    lat = terrain._lat
    reach = -lat.p0  # posts from the centre to the lattice edge
    # The smallest whole-lattice stride that keeps the grid inside the budget.
    # Doubling rather than stepping keeps every coarser grid a subset of every
    # finer one, so a stage that grows the extent cannot shift a post.
    stride = 2
    while (2 * reach) // stride + 1 > FAR_MAX_POSTS:
        stride *= 2
    posts = (2 * reach) // stride + 1
    post_m = lat.spacing * stride
    half = reach * lat.spacing

    # North-ascending, matching `_Lattice`, then flipped for the file.
    coarse = np.ascontiguousarray(lat.heights[::stride, ::stride], dtype=np.float32)
    assert coarse.shape == (posts, posts), (coarse.shape, posts)

    # The rendered coarse surface, evaluated by the same code that defines the
    # real one -- `Terrain.sample` implements the NW->SE diagonal split that
    # `terrain.write_terrain`, `client/src/world/terrain.ts` and this grid all
    # share, so wrapping the coarse posts in a Terrain gives the exact surface
    # the GPU will rasterise rather than a bilinear approximation of it.
    coarse_field = Terrain(
        _Lattice(coarse, -(posts // 2), -(posts // 2), post_m), terrain.base_elevation, {}
    )

    # Overshoot at every real post *that a tile could be standing on*. The far
    # grid agrees exactly at its own posts, so the worst case is always in the
    # middle of a coarse cell, and sampling the finer lattice is what finds it.
    #
    # --- WHY THIS IS MASKED TO A DISC AND DID NOT USED TO BE -----------------
    #
    # The sink exists for exactly one reason, stated above: the coarse ground
    # must lose to a streamed tile's ground *everywhere the two overlap*. The
    # lattice is a square and the build is a disc, so the two overlap on the
    # disc and nowhere else -- past it there is no tile, and the coarse surface
    # is not competing with the real one, it *is* the only one. Overshoot out
    # there cannot produce the artefact this number is paid to prevent.
    #
    # Measuring it over the whole square was harmless while the square was
    # small: at 19.3 km its corners are 27 km out, over the same coastal plain
    # as everything else. At 60 km the corners are 85.6 km out, in the Blue
    # Mountains, and they were setting the number for the entire world -- 250 m
    # of sink measured over the square against 165 m over the disc, i.e. 85 m
    # of the horizon's drop was being charged by ground no tile will ever be
    # emitted on and no player can stand within 25 km of.
    #
    # The radius is recovered from the lattice rather than threaded through
    # three call sites, by inverting `Terrain.load`'s own reach formula; the
    # assert is what keeps that inversion honest if the formula moves. One tile
    # diagonal of margin, because `tiles_within_radius` keeps a tile whose
    # *nearest corner* is inside the radius, so tile ground runs that far past
    # it.
    assert reach % config.TERRAIN_GRID == 0, reach
    covered = (reach // config.TERRAIN_GRID - 1) * config.TILE_SIZE
    covered += config.TILE_SIZE * math.sqrt(2.0)

    idx = np.arange(-reach, reach + 1, dtype=np.float64) * lat.spacing
    # Chunked over rows: at 60 km the square is 3,873^2 = 15.0 M posts, and
    # sampling it in one call is several gigabytes of float64 temporaries.
    overshoot = 0.0
    for i in range(0, len(idx), 128):
        rows = idx[i : i + 128]
        east = np.repeat(idx[None, :], len(rows), axis=0).ravel()
        north = np.repeat(rows[:, None], len(idx), axis=1).ravel()
        inside = (east * east + north * north) <= covered * covered
        if not inside.any():
            continue
        east, north = east[inside], north[inside]
        delta = coarse_field.sample(east, north) - terrain.sample(east, north)
        overshoot = max(overshoot, float(delta.max()))
    sink = round(max(overshoot, 0.0) + FAR_SINK_MARGIN, 2)

    # Row 0 north: `_Lattice` stores north ascending with the row index, and the
    # file (like every `.terr.bin`) runs rows southward.
    return np.ascontiguousarray(coarse[::-1], dtype=np.float32), post_m, half, sink


def write_far_terrain(path: Path, grid: np.ndarray) -> int:
    """The far ground, little-endian float32, no header.

        f32[posts * posts]   metres above the datum, row 0 the northern edge

    Same no-header argument as `write_terrain`: the length is fixed by the post
    count in `index.json`, so a stale or truncated file is caught by a byte
    check with nothing to disagree about.
    """
    arr = np.ascontiguousarray(grid, dtype="<f4")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(arr.tobytes())
    return arr.nbytes


#: How many points each far-cover cell is sampled at, per side.
#:
#: **Six, because the field it writes into has 31 steps in it.** Four would be
#: 16 samples and a 6.25% quantisation of the coverage fraction, against the
#: byte's own 3.2% -- the sampler would be the coarser of the two and the five
#: bits `cover.ts` spends on the fraction would be buying nothing. 36 samples is
#: 2.8%, just under the byte, which is where a sampler should sit.
#:
#: The cost of being right about it is nothing: 243 x 243 posts x 36 is 2.1
#: million point-in-polygon queries, done as 243 bulk STRtree calls, and the
#: whole 60 km world comes out in about fifteen seconds. An exact polygon clip
#: per cell would be minutes for an answer nobody can see the difference in at
#: two kilometres.
#:
#: What it does **not** buy is small features: a mangrove reach of a hectare and
#: a half inside a 25 ha cell is under one sample either way, and the Badu
#: mangroves at Homebush read as bare on this grid. That is correct rather than
#: a defect -- at 2 km a hectare and a half subtends about two pixels -- and the
#: near field draws them properly from 1.8 km in.
FAR_COVER_SAMPLES = 6


def build_far_cover(greens: list, posts: int, post_m: float, half: float) -> np.ndarray:
    """What grows on each far-terrain post, as one byte.

        bits 7..5   the cover class, `vegetation.COVER_CODE`, 0 for nothing
        bits 4..0   how much of the cell that class covers, 0..31

    Row 0 is the northern edge and the layout is `far-terrain.bin`'s exactly, so
    the client reads the two with one index. See `client/src/world/cover.ts` for
    the whole argument; the short of it is that the horizon is this heightfield
    wearing `ground.ts`'s dirt material, that material has never known what grows
    on the ground it paints, and past the streaming radius that is the entire
    reason a national park reads brown.

    **The dominant class rather than the best-ranked one**, and that is the one
    place this disagrees with `vegetation.surfaces`. On the ground the rank
    settles an overlap because two materials cannot occupy the same square metre;
    over a 500 m cell there is no overlap to settle -- there is a mixture, and
    the honest answer to "what colour is this quarter square kilometre" is
    whichever class holds most of it. A national park with a golf course in one
    corner is forest at this resolution, and the rank would have said golf.
    """
    from shapely import STRtree
    from shapely.geometry import Point

    from . import vegetation

    grid = np.zeros((posts, posts), dtype=np.uint8)
    if not greens:
        return grid

    tree = STRtree([g.polygon for g in greens])
    codes = np.asarray(
        [vegetation.COVER_CODE.get(g.cover, 0) for g in greens], dtype=np.uint8
    )

    k = FAR_COVER_SAMPLES
    step = post_m / k
    # Row by row: 243 rows of 243 posts x 16 samples is 3,888 points a row, which
    # is one bulk query and a few megabytes, against 945,000 points and several
    # hundred megabytes of index pairs in one go.
    for r in range(posts):
        north = half - r * post_m
        pts = []
        for c in range(posts):
            east = -half + c * post_m
            for sy in range(k):
                for sx in range(k):
                    pts.append(
                        Point(
                            east + (sx + 0.5 - k / 2.0) * step,
                            north + (sy + 0.5 - k / 2.0) * step,
                        )
                    )
        pairs = tree.query(np.asarray(pts, dtype=object), predicate="within")
        if pairs.size == 0:
            continue
        # One count per (post, class). `pairs` is (2, n) -- point index, polygon
        # index -- so a point inside three overlapping polygons contributes to
        # three classes, which is what a mixture is and is why the winner is
        # taken by count rather than by rank.
        hits = np.zeros((posts, 8), dtype=np.int32)
        post_of = pairs[0] // (k * k)
        np.add.at(hits, (post_of, codes[pairs[1]]), 1)
        hits[:, 0] = 0
        best = hits.argmax(axis=1)
        count = hits.max(axis=1)
        # A class that covers every sample is 31/31; the fraction is clamped to at
        # least 1 wherever anything was found at all, so a cell with one sample in
        # a reserve is faintly green rather than silently bare.
        steps = np.clip(np.rint(count / (k * k) * vegetation.COVER_STEPS), 0, 31).astype(np.uint8)
        steps[(count > 0) & (steps == 0)] = 1
        grid[r] = np.where(count > 0, (best.astype(np.uint8) << 5) | steps, 0)
    return grid


def write_far_cover(path: Path, grid: np.ndarray) -> int:
    """The far cover channel, one u8 per post, no header.

    Same no-header argument as `write_far_terrain`: the length is fixed by the
    post count in `index.json`, so a stale or truncated file is caught by a byte
    check with nothing to disagree about -- and the client does exactly that
    check before it builds the attribute.
    """
    arr = np.ascontiguousarray(grid, dtype=np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(arr.tobytes())
    return arr.nbytes


def write_far(path: Path, buildings: list[Building], terrain, floor) -> dict:
    """Every significant building in the extent as one convex prism.

        u32  magic       `FAR_MAGIC`
        u32  version     `FAR_VERSION`
        u32  slab count
        u32  plan vertex count, over the whole file
        u32  group count

        per group (16 bytes), one per tile that owns a slab, ascending by key:
          i32  tx, tz      the tile's grid coordinates; the key is f"{tx}_{tz}"
          u32  first slab  index of its first slab
          u32  slab count

        per slab (16 bytes), grouped by tile:
          f32  baseY       world y of the prism's bottom
          f32  height      the prism's own height, not the building's
          u32  first vert  index into the plan vertex block
          u8   vert count  3 .. FAR_MAX_PLAN_VERTS
          u8   material    index into `mesh.MATERIALS`
          u8   archetype   index into `attributes.ARCHETYPES`
          u8   reserved

        per plan vertex (8 bytes):
          f32  x, z        **world** metres -- x = east, z = -north

    **World coordinates, not ENU and not tile-local**, and this is the one place
    in the pipeline that ships them. Every other sidecar is tile-local because it
    arrives with a tile that carries a node translation; this file arrives with
    nothing, so the client would otherwise have to know the axis convention to
    use it -- and a north/south flip applied in one place and not the other is a
    bug that looks like a plausible city built backwards.

    The plan ring is wound **clockwise in world (x, z)**, which is what an
    anticlockwise ENU ring becomes under `z = -north`: the reflection flips the
    sense, and it flips it back exactly where the renderer needs it. A ring that
    is clockwise in (x, z) fans into an upward-facing cap and extrudes into
    outward-facing walls under three's default counter-clockwise front face, with
    no sign to remember at either end.

    **The groups are the whole reason this file knows about tiles.** A slab is
    the low-detail stand-in for a building that the streamer will eventually load
    the real version of, and the client has to be able to take it away at that
    moment -- so the file arrives already partitioned by the unit residency is
    decided in. The key is the building's own `b.tile`, not a bucket recomputed
    from the slab's centre, so a slab and the mesh it hides inside can never be
    filed under different tiles.

    `height` is the slab's extent rather than the building's, and the two differ
    by the burial. The top is placed where a 2 m-sunk slab would put it, at
    `terrain + height - FAR_BURY`, so the silhouette is right to within 2 m at
    every distance; the *bottom* then goes 2 m under whichever of the real
    terrain and the far terrain is lower, so a slab can never be caught standing
    on a sliver of air where the coarse ground runs below the real one. Both
    facts live in this one record because both ends of the prism have to be
    decided by something that can see both surfaces, which is here and nowhere
    else -- and sinking the bottom rather than the whole prism is what keeps the
    burial free: a slab that was simply lowered would lose its own roofline.

    `floor` answers "where is the far ground under this point", already sunk.
    """
    arch_index = {name: i for i, name in enumerate(mesh.ARCHETYPES)}

    # Slab records and plan vertices, accumulated per tile so the groups come out
    # contiguous with no second pass over the geometry.
    by_tile: dict[str, list[tuple[bytes, np.ndarray]]] = defaultdict(list)
    for b in buildings:
        if b.height < FAR_MIN_HEIGHT and b.area < FAR_MIN_AREA:
            continue
        # An elevated structure gets no far slab at all, and the reason is this
        # layer's own invariant: a slab is drawn on the argument that it is
        # *inside* the building it stands for, so a wrong silhouette is hidden
        # by the real walls the moment the tile arrives. A prism that starts 5 m
        # up has nothing at ground level for a slab to hide inside -- the slab
        # would be the only thing there, a solid block sitting on a road at
        # exactly the distance the player cannot yet see it is wrong. Sinking or
        # raising it instead would cost this record a base it does not carry;
        # omitting it costs a footbridge nobody can resolve at 2 km.
        if b.base_height > 0.0:
            continue
        plan = _slab_plan(b.ring)
        if plan is None:
            continue
        # The pad is taken at the **footprint centroid**, not at the plan's
        # centre, and the two are different points on anything that is not
        # symmetrical. `build_tile` pads the real building at `b.centroid`, so a
        # slab padded anywhere else would stand at a different height from the
        # building it is hiding inside -- measured over the inner ring that is
        # up to 3.8 m of disagreement, which on a shallow roof is the whole eave.
        ground = float(terrain.sample(*b.centroid))
        top = ground + float(b.height) - FAR_BURY
        base = min(ground, float(floor(*b.centroid))) - FAR_BURY
        height = top - base
        # A slab whose top is under the ground draws nothing and costs a draw.
        # That is not hypothetical: the area arm of the filter admits big flat
        # things the height resolver gave a metre or two -- car park decks,
        # awnings mapped as buildings -- and burying the top of a 1 m building
        # puts it a metre below the street it stands on.
        if height <= 0.0 or top <= ground:
            continue
        by_tile[b.tile].append(
            (
                struct.pack(
                    "<ffIBBBB",
                    base,
                    height,
                    0,  # first vertex, patched below once the block is laid out
                    len(plan),
                    mesh.MATERIAL_INDEX.get(b.material, 0) & 0xFF,
                    arch_index.get(b.archetype, 0) & 0xFF,
                    0,
                ),
                plan,
            )
        )

    def tile_order(key: str) -> tuple[int, int]:
        tx, tz = key.split("_")
        return int(tx), int(tz)

    groups = bytearray()
    slabs = bytearray()
    verts = bytearray()
    slab_count = vert_count = 0
    for key in sorted(by_tile, key=tile_order):
        tx, tz = tile_order(key)
        entries = by_tile[key]
        groups += struct.pack("<iiII", tx, tz, slab_count, len(entries))
        for record, plan in entries:
            slabs += record[:8] + struct.pack("<I", vert_count) + record[12:]
            # ENU (east, north) -> world (x, z). The sign is the only conversion
            # in this file and it is the same one the record's `baseY` does not
            # need; see the winding note above for what it does to the ring.
            for east, north in plan:
                verts += struct.pack("<ff", float(east), float(-north))
            vert_count += len(plan)
            slab_count += 1

    header = struct.pack(
        "<IIIII", FAR_MAGIC, FAR_VERSION, slab_count, vert_count, len(by_tile)
    )
    payload = header + bytes(groups) + bytes(slabs) + bytes(verts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return {
        "count": slab_count,
        "plan_verts": vert_count,
        "groups": len(by_tile),
        "bytes": len(payload),
        # `2n` vertices and `3n - 2` triangles a prism: `n` walls of two, and a
        # cap fanned off the top ring it already has. Reported because it is the
        # number this pass spends and the one a reviewer will ask for.
        "triangles": 3 * vert_count - 2 * slab_count,
        "vertices": 2 * vert_count,
    }


def emit_water(terrain) -> dict | None:
    """Write `far-water.bin` and return the contract `index.json` carries.

    `None` when the terrain carries no water field at all, which is what a build
    with `conform_water=False` produces -- and `None` is what makes the index
    omit the contract entirely, so the client draws nothing rather than drawing a
    sea somewhere it was never measured.

    Every number here is either measured from the field or is a constant
    `water.py` owns, and none of them is repeated on the client: the surface
    level, the depth the bed was cut to and the sink under the far sheet are all
    facts about *this build* that the client has to be told rather than agree
    about in advance.
    """
    field = getattr(terrain, "water", None)
    if field is None or field.is_empty():
        return None

    sheets = water.far_sheets(field, terrain)
    far = write_far_water(config.OUT_ROOT / "far-water.bin", sheets)
    tidal = [lvl for lvl in field.levels if lvl.tidal]
    return {
        "version": WATER_VERSION,
        # Where 0 m AHD sits in world y, and therefore where every tidal sheet
        # in the build is. The same number `terrain.sea_level_y` carries, and
        # deliberately so -- it is one datum with two readers, not two data.
        "surface_y": round(field.sea_level_y + water.SURFACE_AHD, 3),
        "depth_m": water.OPEN_DEPTH_M,
        "pond_depth_m": water.POND_DEPTH_M,
        "shore_clearance_m": water.SHORE_CLEARANCE_M,
        "area_m2": round(field.area, 1),
        "tidal_area_m2": round(sum(lvl.geom.area for lvl in tidal), 1),
        "bodies": len(field.bodies),
        "levels": len(field.levels),
        "far": {**far, "sink_m": water.FAR_SINK_M, "cell_m": water.FAR_CELL_M},
    }


def emit_far(buildings: list[Building], terrain) -> dict:
    """Write both far-layer files and return the contract `index.json` carries.

    One unit of work: the slabs cannot be placed until the far terrain exists,
    because a slab's floor is the lower of the two surfaces and one of them is
    the file being written here.
    """
    grid, post_m, half, sink = build_far_terrain(terrain)
    terr_bytes = write_far_terrain(config.OUT_ROOT / "far-terrain.bin", grid)

    # The same coarse surface the client will render, for the slab floors. Built
    # from the north-ascending view of the grid, which is what `_Lattice` wants.
    from .terrain import Terrain, _Lattice

    posts = grid.shape[0]
    coarse_field = Terrain(
        _Lattice(np.ascontiguousarray(grid[::-1]), -(posts // 2), -(posts // 2), post_m),
        terrain.base_elevation,
        {},
    )

    def floor(east, north):
        return coarse_field.sample(east, north) - sink

    slabs = write_far(config.OUT_ROOT / "far.bin", buildings, terrain, floor)
    return {
        **slabs,
        "version": FAR_VERSION,
        "min_height_m": FAR_MIN_HEIGHT,
        "min_area_m2": FAR_MIN_AREA,
        # The three plan operations, reported separately because they answer
        # three different questions: the vertex cap is the triangle budget, the
        # inset is what keeps a slab face off the wall plane it would otherwise
        # z-fight, and the concavity match is what stops a hull claiming the
        # ground inside an L that is sky.
        "max_plan_verts": FAR_MAX_PLAN_VERTS,
        "inset_m": FAR_INSET,
        "concavity_floor": FAR_AREA_MATCH_FLOOR,
        "terrain": {
            "posts": posts,
            "post_m": post_m,
            "half_extent_m": half,
            # How far the coarse ground is pushed under the real one, metres.
            # Measured per build -- see `build_far_terrain`.
            "sink_m": sink,
            "bytes": terr_bytes,
        },
    }
