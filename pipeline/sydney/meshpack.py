"""Vertex attribute packing: how a tile's geometry is made small on the wire.

---------------------------------------------------------------------------
WHY. Measured over the inner ring on 2026-08-06, the world was 613 MB and
**585.8 MB of it was tile GLB geometry** -- 96%. Everything else put together
(params, lanes, water, vegetation, names, collision, terrain) is 27 MB. The
15 km stage multiplies that by roughly four. Geometry is not *a* problem with
the download size, it is the whole of it, and inside the geometry the split was:

    POSITION    182.5 MB  30.1%     float32 x3
    NORMAL      165.9 MB  27.4%     float32 x3
    TEXCOORD_0  110.6 MB  18.2%     float32 x2   (metric UVs -- see facade.ts)
    INDEX       108.7 MB  17.9%     uint32
    _BLDIDX      33.1 MB   5.5%     float32
    COLOR_0       5.5 MB   0.9%     uint8, already small

Four of those five columns are float32 holding values that do not need 24 bits
of mantissa, and one is a uint32 index into a buffer that has never had more
than 33,441 vertices in it. This module is the arithmetic that says so.

---------------------------------------------------------------------------
WHAT IT DOES, and why each choice rather than the obvious alternative.

**Quantise, per primitive, per axis.** A primitive's own bounding box is
divided into 65,535 steps on each axis independently. Per *primitive* rather
than per tile because a road slab's y range is twenty metres where the tile's
is three hundred, and per *axis* because x and z span the tile while y usually
does not. Measured over the real world that gives:

    horizontal quantum   p50 6.9 mm   p95 8.0 mm   worst 9.6 mm
    vertical   quantum   p50 0.3 mm   p95 0.9 mm   worst 4.4 mm

so the worst positional error anywhere in the city is under 5 mm, and the
worst *vertical* error -- the one that could z-fight a road against its kerb --
is a fifth of a millimetre on a typical slab. Collision is a separate file and
does not move at all, so this is cosmetic drift and nothing else.

**Delta-code along the vertex axis, before compression.** This is the single
biggest win on the wire and it costs one prefix sum. jsDelivr brotli-compresses
on the fly, so what matters is not the raw column but how compressible it is,
and consecutive vertices of a building are near neighbours -- their quantised
coordinates differ by a few hundred out of 65,535, which is one byte of entropy
instead of two. Measured over thirteen real tiles:

    original float32                 19.24 MB raw   3.714 MB brotli
    quantised                         8.46 MB raw   2.309 MB brotli   (br 1.61x)
    quantised + byte-plane shuffle    8.46 MB raw   2.616 MB brotli   (br 1.42x)
    quantised + delta                 8.46 MB raw   1.885 MB brotli   (br 1.97x)
    quantised + shuffle + delta       8.46 MB raw   2.153 MB brotli   (br 1.72x)

Over the whole rebuilt inner ring that lands at **614.3 MB of tile geometry
down to 273.6 MB, 2.25x**, and on a fixed 42-tile sample compressed the way the
CDN compresses it, **16.9 MB down to 9.3 MB, 1.82x on the wire**.

The byte-plane shuffle -- the classic HDF5/blosc filter, and the obvious thing
to reach for -- makes it *worse*, because brotli's match finder already handles
the stride and de-interleaving destroys the locality delta coding depends on.
It was measured and thrown away; the row is kept here so nobody measures it
twice.

**Normals to int8, not octahedral.** Octahedral in two bytes would be another
33% off the normal column, but it needs a decode with a branch and a fold per
vertex where int8 needs a multiply. The source normals are *exactly* unit
length (checked over all 13.8 M of them) and int8 reconstructs them to within
**0.385 degrees** worst case across the entire world. There is no lighting in
this client that can show a third of a degree.

**`_BLDIDX` is not quantised; it is narrowed.** It is an index into the facade
parameter atlas and a value that is off by one is a building drawn with another
building's window grammar. The largest index anywhere in the build is 769, so
it is stored as a uint16 and expanded back to the *exact* same float32 the
pipeline wrote. Nothing about it is approximate, and `verifyStreaming` asserts
that separately from everything else.

**Indices narrow to uint16 where they fit.** Every primitive in the build fits
(worst is 33,441), but the writer checks rather than assumes, because the check
is one comparison and the failure mode of assuming is a corrupt tile.

---------------------------------------------------------------------------
WHY NOT MESHOPT OR DRACO. Both beat this on ratio. Both also mean a decoder
riding along -- meshopt's is small, Draco's is ~200 kB of WASM -- and this
client deliberately deleted `GLTFLoader` from the tile path in favour of the
sixty-line `parseTileGlb`, because the general case was what made a Windows
laptop hitch. Reintroducing a decoder to save bytes on a budget whose whole
point is the *time* spent decoding is the wrong trade. What is here decodes in
one multiply-add per component with no allocation beyond the output array, and
it is undone in `client/src/world/tile-decode.ts` -- that file and this one are
the two halves of one format and must move together.

---------------------------------------------------------------------------
THE WIRE FORMAT is still GLB, and still the same deliberately narrow GLB
`write_glb` has always emitted. Quantised attributes are ordinary glTF integer
accessors; the dequantisation lives in `accessor.extras`, which is legal glTF
that every loader ignores:

    {"q": [ox, oy, oz, sx, sy, sz], "d": 1}   quantised float attribute
    {"i": 1, "d": 1}                          integer widened to float, exact
    {"d": 1}                                  delta filter only (indices)

`KHR_mesh_quantization` is declared in `extensionsUsed` because that is what
makes an integer POSITION legitimate, and `SYD_mesh_pack` beside it because the
delta filter is nobody's extension but ours. **Neither is in
`extensionsRequired`**, and that is deliberate rather than sloppy: a required
extension `GLTFLoader` does not know makes it refuse the file outright, and
`streamer.verifyTileGlbParse` compares `parseTileGlb` against `GLTFLoader` on a
real tile at boot. Keeping the file loadable by the stock loader is what keeps
that check alive.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# --- The contract, shared with the client -----------------------------------

#: Bumped whenever the meaning of a stored byte changes. Travels in `index.json`
#: as `geometry.pack`, and `client/src/world/tile-decode.ts` refuses a version
#: it does not know -- a tile decoded by the wrong rules is a city of noise, and
#: failing loudly is the only readable symptom of that.
PACK_VERSION = 1

COMPONENT_BYTE = 5120
COMPONENT_UBYTE = 5121
COMPONENT_SHORT = 5122
COMPONENT_USHORT = 5123
COMPONENT_UINT = 5125
COMPONENT_FLOAT = 5126

#: Quantisation steps. 65,535 rather than 65,536 so that the top of the range is
#: representable exactly -- a vertex on a primitive's own bounding box reproduces
#: to the float it started as, which matters at a tile seam where two tiles'
#: geometry has to meet.
STEPS = 65535.0

#: A quantum coarser than this, in metres, and the attribute is left as float32.
#: Position never trips it -- the largest primitive extent in the build is 628 m,
#: which is a 9.6 mm quantum -- and it exists so that a future tile with a freak
#: extent degrades to "bigger file" rather than to "visibly wrong".
POSITION_MAX_QUANTUM_M = 0.05

#: The same guard for metric UVs, tighter because the facade shader's window
#: grid is denominated in them. Measured over the world the per-primitive UV
#: span is p50 197 m / p95 549 m -- a 3 mm and 8 mm quantum -- but a handful of
#: long kerb runs accumulate `u` to 5.4 km, and those keep their float32.
UV_MAX_QUANTUM_M = 0.02


@dataclass(frozen=True)
class Packed:
    """One attribute column, ready to become a glTF accessor.

    `data` is what goes in the buffer -- already narrowed, already delta-coded.
    `extras` is what the client needs to undo that, or None when the column is
    stored as-is and there is nothing to undo.
    """

    data: np.ndarray
    component_type: int
    type_str: str
    components: int
    normalized: bool
    extras: dict | None
    #: Worst reconstruction error over this column, in the column's own units
    #: (metres for position and UV, degrees for normals, 0 for the exact ones).
    max_error: float


_TYPE_STR = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}


def delta_encode(values: np.ndarray, components: int) -> np.ndarray:
    """Replace each element with its difference from the previous one.

    Per *component*: for a VEC3 column the x of vertex i is stored against the x
    of vertex i-1, never against its own z. Modular by construction -- the
    subtraction is done wide and truncated back to the stored width -- so the
    client's `(acc + d) & mask` reverses it exactly whatever the sign.

    Returns a new array; the caller's is untouched.
    """
    rows = values.reshape(-1, components)
    if len(rows) < 2:
        return values
    wide = rows.astype(np.int64)
    out = rows.copy()
    out[1:] = (wide[1:] - wide[:-1]).astype(rows.dtype)
    return out.reshape(-1)


def _quantise(values: np.ndarray, components: int, max_quantum: float) -> Packed | None:
    """Per-axis uint16 quantisation of a float column, or None if too coarse."""
    rows = np.asarray(values, dtype=np.float32).reshape(-1, components)
    lo = rows.min(axis=0).astype(np.float64)
    hi = rows.max(axis=0).astype(np.float64)
    span = hi - lo
    if float(span.max()) / STEPS > max_quantum:
        return None
    # A degenerate axis -- every vertex at the same height, which is most road
    # slabs -- gets scale 1 rather than 0, so the client's multiply reproduces
    # the offset exactly instead of producing 0 * inf.
    scale = np.where(span > 0.0, span / STEPS, 1.0)
    codes = np.rint((rows.astype(np.float64) - lo) / scale).astype(np.uint16)
    error = float(np.abs(codes.astype(np.float64) * scale + lo - rows.astype(np.float64)).max())
    return Packed(
        data=delta_encode(codes.reshape(-1), components),
        component_type=COMPONENT_USHORT,
        type_str=_TYPE_STR[components],
        components=components,
        normalized=False,
        # Floats, written at full precision: they are six numbers per accessor
        # against tens of thousands of vertices, and rounding them would put the
        # error back that the 16 bits were spent removing.
        extras={"q": [*lo.tolist(), *scale.tolist()], "d": 1},
        max_error=error,
    )


def pack_positions(positions: np.ndarray) -> Packed:
    """Tile-local metres to uint16, per axis, delta-coded."""
    packed = _quantise(positions, 3, POSITION_MAX_QUANTUM_M)
    if packed is not None:
        return packed
    arr = np.asarray(positions, dtype=np.float32)
    return Packed(arr, COMPONENT_FLOAT, "VEC3", 3, False, None, 0.0)


def pack_normals(normals: np.ndarray) -> Packed:
    """Unit normals to normalized int8.

    Not delta-coded: one byte per component leaves nothing for a delta to
    remove, and the measurement above shows it costs more than it saves.

    A zero-length normal -- 13,648 of the build's 13.8 M, from degenerate source
    triangles -- stores as (0,0,0) and comes back as (0,0,0). It is preserved
    rather than repaired, because inventing a direction for a triangle that has
    none would be this module deciding how the city is lit.
    """
    rows = np.asarray(normals, dtype=np.float32).reshape(-1, 3).astype(np.float64)
    length = np.linalg.norm(rows, axis=1, keepdims=True)
    unit = np.divide(rows, length, out=np.zeros_like(rows), where=length > 1e-9)
    codes = np.rint(np.clip(unit, -1.0, 1.0) * 127.0).astype(np.int8)

    back = codes.astype(np.float64) / 127.0
    back_len = np.linalg.norm(back, axis=1, keepdims=True)
    back = np.divide(back, back_len, out=np.zeros_like(back), where=back_len > 1e-9)
    live = (length > 1e-9).reshape(-1)
    error = 0.0
    if live.any():
        dot = np.clip((back[live] * unit[live]).sum(axis=1), -1.0, 1.0)
        error = float(np.degrees(np.arccos(dot)).max())
    return Packed(codes.reshape(-1), COMPONENT_BYTE, "VEC3", 3, True, None, error)


def pack_uvs(uvs: np.ndarray) -> Packed:
    """Metric UVs to uint16 per axis, delta-coded -- unless the span is absurd.

    The facade shader reads these as metres (u along the facade, v up it), so
    the quantum is a real distance and `UV_MAX_QUANTUM_M` is the whole of the
    precision argument. A primitive that cannot meet it keeps float32 and costs
    what it always cost.
    """
    packed = _quantise(uvs, 2, UV_MAX_QUANTUM_M)
    if packed is not None:
        return packed
    arr = np.asarray(uvs, dtype=np.float32)
    return Packed(arr, COMPONENT_FLOAT, "VEC2", 2, False, None, 0.0)


def pack_building_index(indices: np.ndarray) -> Packed:
    """The facade parameter index: narrowed, never quantised.

    **Exactness is the point.** This is a row number in the parameter atlas, and
    a value one off draws a terrace house with a tower's window grammar. Every
    value in the build is a small non-negative integer -- the largest is 769 --
    so uint16 holds it and the client widens it back to bit-identical float32.
    A build that somehow produced a larger index keeps float32 rather than
    wrapping, because wrapping would be silent.
    """
    arr = np.asarray(indices, dtype=np.float32)
    whole = np.rint(arr)
    if np.any(np.abs(arr - whole) > 0) or arr.min() < 0 or arr.max() > 65535:
        return Packed(arr, COMPONENT_FLOAT, "SCALAR", 1, False, None, 0.0)
    codes = whole.astype(np.uint16)
    return Packed(
        delta_encode(codes, 1), COMPONENT_USHORT, "SCALAR", 1, False, {"i": 1, "d": 1}, 0.0
    )


def pack_indices(indices: np.ndarray) -> Packed:
    """Triangle indices: uint16 where they fit, delta-coded either way.

    Lossless, both halves. Delta coding an index buffer is the oldest trick
    here and the one that pays most per line -- indices within a triangle strip
    of a building wall are within a few of each other, so the deltas are tiny
    and signed, and brotli eats them.
    """
    arr = np.asarray(indices, dtype=np.uint32)
    if arr.size and int(arr.max()) < 65536:
        return Packed(
            delta_encode(arr.astype(np.uint16), 1),
            COMPONENT_USHORT,
            "SCALAR",
            1,
            False,
            {"d": 1},
            0.0,
        )
    return Packed(delta_encode(arr, 1), COMPONENT_UINT, "SCALAR", 1, False, {"d": 1}, 0.0)


# --- The other half, for the pipeline's own check ----------------------------


def unpack(packed: Packed) -> np.ndarray:
    """Reverse `pack_*`, exactly as `tile-decode.ts` does it.

    Here so `write_glb` can assert what it just wrote before the file leaves the
    process. A round trip that is only ever checked in the browser is a round
    trip whose failures are found by players.
    """
    data = packed.data
    extras = packed.extras or {}
    if extras.get("d"):
        rows = data.reshape(-1, packed.components).astype(np.int64)
        acc = np.cumsum(rows, axis=0)
        bits = data.dtype.itemsize * 8
        data = (acc & ((1 << bits) - 1)).astype(data.dtype).reshape(-1)
    if "q" in extras:
        n = packed.components
        offset = np.asarray(extras["q"][:n], dtype=np.float64)
        scale = np.asarray(extras["q"][n:], dtype=np.float64)
        return (data.reshape(-1, n).astype(np.float64) * scale + offset).astype(np.float32)
    if extras.get("i"):
        return data.astype(np.float32)
    if packed.normalized and data.dtype == np.int8:
        back = data.reshape(-1, packed.components).astype(np.float64) / 127.0
        length = np.linalg.norm(back, axis=1, keepdims=True)
        return np.divide(back, length, out=np.zeros_like(back), where=length > 1e-9).astype(
            np.float32
        )
    return data
