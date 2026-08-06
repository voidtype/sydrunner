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

import json as _json
import struct as _struct
from dataclasses import dataclass, field
from pathlib import Path

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


# --- Reading a packed tile back ------------------------------------------------
#
# **Everything below this line is the inverse, and it exists because the audits
# went blind.** When the pack landed, `write_glb` started emitting delta-coded
# uint16 where it used to emit float32 and uint32, and the pipeline's own readers
# -- `cli._glb_primitives` and `cli._landmark_nodes` -- kept doing
# `np.frombuffer(blob, "<f4")` at the accessor's byte offset. That does not fail:
# it produces an array of the right length full of the wrong numbers, and the
# first thing downstream that indexes a vertex by a delta-coded index number
# throws an `IndexError` from inside `mesh.winding_agreement`, three frames away
# from the actual mistake, *after* the audit has already printed its header. Three
# of the seven audits died that way and their verdicts simply never appeared.
#
# So the rule this section encodes is: there is exactly one way for Python to read
# a tile GLB, it undoes the pack, and it refuses a file it was not written for.
#
# **The correctness standard is bit-identity with the client**, not "close
# enough". `client/src/world/tile-decode.ts` is what the player actually sees, so
# an audit that dequantises even one ulp differently is auditing a world that is
# not shipped. Every arithmetic choice below is therefore a transcription of that
# file rather than a re-derivation:
#
#   * the prefix sum is modular in the *stored* width, `& 0xffff` for uint16 and
#     `>>> 0` for uint32, so a column that wraps reconstructs without a case;
#   * the dequantisation is `code * scale + offset` in float64, in that order,
#     rounded to float32 once at the end -- `(code + offset/scale) * scale` is
#     algebraically the same and is not the same float;
#   * int8 normals are renormalised from the *stored integers*, `1/sqrt(x*x +
#     y*y + z*z)` then three multiplies, because the 1/127 the encoder divided by
#     cancels out of a renormalisation and dividing by it first would round twice;
#   * `COLOR_0` comes back as the stored bytes, which is what `parseTileGlb`
#     hands three.
#
# That equivalence was checked, not asserted: a real tile decoded through this
# module and through `tile-decode.ts` under Bun compares equal byte for byte on
# every attribute and every index buffer of all nineteen primitives.


class PackVersionError(RuntimeError):
    """A packed artefact written by rules this reader does not have.

    Raised rather than guessed at. The failure mode this replaces is the one that
    made this module necessary: bytes read under the wrong rules are not missing,
    they are *plausible*, and the audit that consumes them reports a number
    instead of a problem.
    """


#: The extras vocabulary of `PACK_VERSION`. A key outside this set means the
#: format grew a field while this reader was not looking, which is the same
#: situation as an unknown version number and gets the same refusal.
_EXTRAS_KEYS = frozenset({"q", "i", "d"})

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

#: `SYD_mesh_pack` in `extensionsUsed` is how a file says it carries the delta
#: filter. It is deliberately not in `extensionsRequired` -- see this module's
#: header -- so it is a statement about the bytes rather than a demand.
PACK_EXTENSION = "SYD_mesh_pack"

_COMPONENT_DTYPE = {
    COMPONENT_BYTE: np.dtype("<i1"),
    COMPONENT_UBYTE: np.dtype("<u1"),
    COMPONENT_SHORT: np.dtype("<i2"),
    COMPONENT_USHORT: np.dtype("<u2"),
    COMPONENT_UINT: np.dtype("<u4"),
    COMPONENT_FLOAT: np.dtype("<f4"),
}

_TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def require_pack_version(declared, *, source: str, reader: str = "this audit") -> int:
    """Refuse a pack version this reader was not written against.

    `declared` is `index.json`'s `geometry.pack`, or None for a world built
    before the pack existed -- which is a legitimate thing to read, because the
    accessors in it carry no `extras` and every branch below leaves them alone.

    The message names the version rather than the symptom on purpose. An unknown
    future version used to arrive as `IndexError: index 65538 is out of bounds`
    from inside a winding check, and the whole point of this function is that it
    is impossible to read that and know what happened.
    """
    if declared is None:
        return 0
    try:
        version = int(declared)
    except (TypeError, ValueError):
        raise PackVersionError(
            f"{reader} does not understand pack version {declared!r} ({source})."
        ) from None
    if version != PACK_VERSION:
        raise PackVersionError(
            f"{reader} does not understand pack version {version}."
            f" {source} declares it; this reader implements version {PACK_VERSION}."
            " `sydney/meshpack.py` and `client/src/world/tile-decode.ts` are the two"
            " halves of one format -- teach this reader the new rules before"
            " auditing a build written under them."
        )
    return version


def undo_delta(raw: np.ndarray, components: int) -> np.ndarray:
    """Modular prefix sum along the vertex axis, per component.

    The exact inverse of `delta_encode`, and modular in the stored width for the
    same reason it was: the encoder subtracted wide and truncated, so a negative
    step is stored as its two's complement and only the wrap brings it back.
    Masking once at the end rather than every step is the same arithmetic --
    addition modulo 2^n is associative -- and is one pass instead of n.
    """
    rows = raw.reshape(-1, components)
    if len(rows) < 2:
        return raw
    bits = raw.dtype.itemsize * 8
    acc = np.cumsum(rows.astype(np.int64), axis=0)
    return (acc & ((1 << bits) - 1)).astype(raw.dtype).reshape(-1)


def _unit_normals(raw: np.ndarray) -> np.ndarray:
    """int8 normals back to unit float32, exactly as `unpackNormals` does it.

    From the stored integers, not from `code / 127`: the scale cancels out of a
    renormalisation, so applying it first would be a rounding step that the
    client does not take. A zero normal stays zero -- 13,648 of the build's
    13.8 M, from degenerate source triangles -- because inventing a direction for
    a triangle that has none would be this reader deciding what the audit sees.
    """
    rows = raw.reshape(-1, 3).astype(np.float64)
    sq = (rows * rows).sum(axis=1)
    out = np.zeros_like(rows)
    live = sq > 0.0
    if live.any():
        out[live] = rows[live] * (1.0 / np.sqrt(sq[live]))[:, None]
    return out.astype(np.float32).reshape(-1)


def unpack_column(
    raw: np.ndarray, components: int, extras: dict | None = None, normalized: bool = False
) -> np.ndarray:
    """One stored accessor column back to what the pipeline put in.

    Flat in, flat out; the caller reshapes. Returns float32 for everything that
    was a float before it was packed, the stored integer dtype for an index
    buffer, and the stored bytes for `COLOR_0` -- which is the same set of types
    the pre-pack readers got out of `np.frombuffer`, so nothing downstream has to
    know the pack happened.
    """
    extras = extras or {}
    unknown = set(extras) - _EXTRAS_KEYS
    if unknown:
        raise PackVersionError(
            f"accessor extras carry {sorted(unknown)}, which pack version"
            f" {PACK_VERSION} has no meaning for. The format grew a field this"
            " reader does not implement."
        )
    if extras.get("d") == 1:
        raw = undo_delta(raw, components)

    q = extras.get("q")
    if q is not None:
        if len(q) != 2 * components:
            raise PackVersionError(
                f"accessor extras 'q' has {len(q)} numbers for a {components}-component"
                f" column; pack version {PACK_VERSION} writes offset then scale, per axis."
            )
        offset = np.asarray(q[:components], dtype=np.float64)
        scale = np.asarray(q[components:], dtype=np.float64)
        wide = raw.reshape(-1, components).astype(np.float64) * scale + offset
        return wide.astype(np.float32).reshape(-1)

    if extras.get("i") == 1:
        # `_BLDIDX`: an atlas row number, widened back to the bit-identical
        # float32 the pipeline wrote. Not approximate and never was.
        return raw.astype(np.float32)

    if normalized and raw.dtype == np.int8 and components == 3:
        return _unit_normals(raw)

    return raw


@dataclass(frozen=True)
class GlbPrimitive:
    """One primitive, unpacked. `material` is the slot name the pipeline gave it.

    `quanta` carries the per-axis step each attribute was quantised on, in the
    attribute's own units, or None where the column shipped as float32 and there
    is no step. **A reader that only hands back the values loses the one fact a
    geometric check needs about them**: a triangle narrower than the lattice its
    vertices were snapped to has an orientation composed entirely of that
    snapping, and nothing in the values themselves says how wide the lattice is.
    `mesh.winding_agreement` is where that matters -- see its `quantum`.
    """

    material: str
    attributes: dict[str, np.ndarray]
    indices: np.ndarray
    quanta: dict[str, np.ndarray | None]

    def attribute(self, semantic: str) -> np.ndarray | None:
        return self.attributes.get(semantic)

    def quantum(self, semantic: str) -> np.ndarray | None:
        """Per-axis quantisation step for one attribute, or None if it is float32."""
        return self.quanta.get(semantic)


@dataclass(frozen=True)
class GlbNode:
    """One glTF node and the primitives under it.

    `translation` matters for `landmarks.glb`, whose three nodes each carry their
    landmark's anchor; tile GLBs have a single node with no transform.
    """

    name: str
    translation: tuple[float, float, float]
    primitives: list[GlbPrimitive] = field(default_factory=list)


@dataclass(frozen=True)
class Glb:
    """A parsed GLB with every accessor already unpacked."""

    path: Path
    nodes: list[GlbNode]
    packed: bool

    @property
    def primitives(self) -> list[GlbPrimitive]:
        return [p for node in self.nodes for p in node.primitives]


def read_glb(path: Path | str) -> Glb:
    """Read a GLB this pipeline wrote, undoing the pack.

    The container parse is deliberately the same narrow one `parseTileGlb` does
    -- header, two chunks, no sparse accessors, no interleaving, one buffer --
    rather than a general glTF library, because the two files have to agree about
    what a tile *is* and a library's tolerance for shapes this pipeline never
    writes would hide a writer that started producing one.

    Every unsupported shape raises. An audit that skips a primitive it cannot
    read is an audit that reports a clean world because it looked at less of it.
    """
    path = Path(path)
    raw = path.read_bytes()
    if len(raw) < 12:
        raise ValueError(f"{path.name}: {len(raw)} bytes is not a GLB")
    magic, version, _length = _struct.unpack_from("<III", raw, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path.name}: magic {magic:#x}, not a GLB")
    if version != 2:
        raise ValueError(f"{path.name}: GLB version {version}, not 2")

    doc: dict | None = None
    blob: bytes | None = None
    at = 12
    while at + 8 <= len(raw):
        length, kind = _struct.unpack_from("<II", raw, at)
        body = at + 8
        if body + length > len(raw):
            raise ValueError(f"{path.name}: chunk runs past the file")
        if kind == CHUNK_JSON and doc is None:
            doc = _json.loads(raw[body : body + length])
        elif kind == CHUNK_BIN and blob is None:
            blob = raw[body : body + length]
        at = body + length + ((4 - (length % 4)) % 4)
    if doc is None:
        raise ValueError(f"{path.name}: no JSON chunk")
    if blob is None:
        raise ValueError(f"{path.name}: no BIN chunk")

    # Nothing this pipeline writes is in `extensionsRequired` -- see this
    # module's header for why -- so anything there is a writer that has moved on
    # without this reader, and reading the file anyway would be reading it under
    # rules it has explicitly said are not enough.
    required = [e for e in (doc.get("extensionsRequired") or []) if e != PACK_EXTENSION]
    if required:
        raise PackVersionError(
            f"{path.name} requires {required}, which this reader does not implement."
        )

    accessors = doc.get("accessors") or []
    views = doc.get("bufferViews") or []
    materials = [m.get("name", "") for m in doc.get("materials") or []]
    packed = PACK_EXTENSION in (doc.get("extensionsUsed") or [])

    def column(index: int) -> tuple[np.ndarray, int, np.ndarray | None]:
        acc = accessors[index]
        if acc.get("bufferView") is None:
            raise ValueError(f"{path.name}: accessor {index} has no bufferView")
        view = views[acc["bufferView"]]
        if view.get("byteStride"):
            raise ValueError(
                f"{path.name}: interleaved bufferView, which this pipeline never writes"
            )
        dtype = _COMPONENT_DTYPE.get(acc["componentType"])
        components = _TYPE_COMPONENTS.get(acc["type"])
        if dtype is None or components is None:
            raise ValueError(
                f"{path.name}: accessor {index} is {acc['type']}/{acc['componentType']}"
            )
        offset = (view.get("byteOffset") or 0) + (acc.get("byteOffset") or 0)
        stored = np.frombuffer(blob, dtype=dtype, count=acc["count"] * components, offset=offset)
        extras = acc.get("extras") or {}
        q = extras.get("q")
        return (
            unpack_column(stored, components, extras, bool(acc.get("normalized"))),
            components,
            None if q is None else np.asarray(q[components:], dtype=np.float64),
        )

    nodes: list[GlbNode] = []
    for node in doc.get("nodes") or []:
        if node.get("mesh") is None:
            continue
        mesh_doc = (doc.get("meshes") or [])[node["mesh"]]
        prims: list[GlbPrimitive] = []
        for prim in mesh_doc.get("primitives") or []:
            if prim.get("mode", 4) != 4:
                raise ValueError(f"{path.name}: primitive mode {prim.get('mode')}, not TRIANGLES")
            if prim.get("indices") is None:
                raise ValueError(f"{path.name}: non-indexed primitive")
            attributes: dict[str, np.ndarray] = {}
            quanta: dict[str, np.ndarray | None] = {}
            for semantic, acc_index in (prim.get("attributes") or {}).items():
                values, components, step = column(acc_index)
                attributes[semantic] = values.reshape(-1, components)
                quanta[semantic] = step
            indices, _, _ = column(prim["indices"])
            slot = prim.get("material")
            prims.append(
                GlbPrimitive(
                    material=materials[slot] if slot is not None and slot < len(materials) else "",
                    attributes=attributes,
                    indices=indices,
                    quanta=quanta,
                )
            )
        t = node.get("translation") or [0.0, 0.0, 0.0]
        nodes.append(
            GlbNode(
                name=node.get("name") or mesh_doc.get("name") or "",
                translation=(float(t[0]), float(t[1]), float(t[2])),
                primitives=prims,
            )
        )
    return Glb(path=path, nodes=nodes, packed=packed)


# --- The other half, for the pipeline's own check ----------------------------


def unpack(packed: Packed) -> np.ndarray:
    """Reverse `pack_*` on a column that has not been through a file yet.

    Here so `write_glb` can assert what it just wrote before the file leaves the
    process. A round trip that is only ever checked in the browser is a round
    trip whose failures are found by players.

    One implementation, not two: this is `unpack_column` with the column's
    description taken off the `Packed` rather than off a glTF accessor, so a
    change to the arithmetic cannot land in the in-process check and miss the
    file reader, or the other way round.
    """
    return unpack_column(
        packed.data, packed.components, packed.extras, packed.normalized
    ).reshape(-1, packed.components)
