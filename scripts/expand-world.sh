#!/bin/sh
# Expand (or contract) the built world to a new radius, end to end.
#
#     scripts/expand-world.sh 19300                 # rebuild "middle" at 19.3 km
#     scripts/expand-world.sh 19300 --stage inner   # a different stage
#     scripts/expand-world.sh 19300 --no-publish    # build and audit only
#
# This is the sequence that was run by hand for the 5.3 km and 15.3 km builds,
# written down because it has three steps whose *order* matters and two failure
# modes that cost an hour each when you find them late:
#
#   - **The source extract has to reach.** `data/cache/sydney.osm.pbf` is a clip,
#     not the planet. The 52 km scoping pass found it stops 35 km west — so a
#     build at that radius would have run for hours and produced a world with no
#     buildings past Parramatta, and nothing would have said so. The pre-flight
#     below refuses instead.
#   - **The building table is cached in the ledger.** Widening the radius without
#     `--rebuild` silently reuses the *old* building set: the tile count grows,
#     the building count does not, and the new ring gets streets and no houses.
#     That happened once. `--rebuild --retile` is not optional here and is not
#     offered as a flag.
#
# What it does NOT do, deliberately:
#
#   - **It does not re-bake the anchor tables.** Police stations, pubs, parks and
#     the per-suburb crime/booze weights are hand-curated TypeScript, and the
#     weights are taste rather than data (see `game/factions.ts`). A script that
#     invented them would be a script that quietly filled your city with
#     plausible lies. It warns instead, and names the files.
#   - **It does not deploy.** Publishing to the CDN is one thing; putting a new
#     client in front of players is another, and DEPLOY.md owns that. The last
#     line prints the remaining commands.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RADIUS=${1:-}
STAGE=middle
PUBLISH=yes

[ -n "$RADIUS" ] || { echo "usage: $0 <radius_m> [--stage <name>] [--no-publish]" >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
  case $1 in
    --stage) STAGE=$2; shift 2 ;;
    --no-publish) PUBLISH=no; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case $RADIUS in
  ''|*[!0-9]*) echo "radius must be whole metres, got '$RADIUS'" >&2; exit 2 ;;
esac
[ "$RADIUS" -ge 1000 ] && [ "$RADIUS" -le 60000 ] || {
  echo "radius $RADIUS m is outside 1-60 km; refusing" >&2; exit 2; }

cd "$ROOT/pipeline"
export PYTHONPATH="$ROOT/pipeline"

echo "== pre-flight"
# Does the OSM extract actually cover this radius, and is there disk for it?
# Both questions are cheap here and expensive an hour into a build.
uv run python - "$RADIUS" "$STAGE" <<'PY'
import sys, math, shutil
import pyogrio
from sydney import config, geo
from sydney.sources import osm

radius, stage = float(sys.argv[1]), sys.argv[2]
if stage not in config.STAGE_BY_NAME:
    sys.exit(f"no stage named {stage!r}; have {', '.join(config.STAGE_BY_NAME)}")

want = geo.bbox_geodetic_for_radius(radius)          # (min_lon, min_lat, max_lon, max_lat)

# A PBF need not carry a header bbox, and a clipped one very often does not.
# GDAL will not invent one: `fast_total_bounds` comes back False and
# `total_bounds` comes back **None**, which this line used to subscript --
# so the guard protecting an eight-hour build died with a TypeError on the
# perfectly ordinary input of a fresh clip. Scan for the bounds instead; it is
# about four seconds on a 73 MB extract.
have = pyogrio.read_info(str(osm.PBF_PATH), layer="lines")["total_bounds"]
if have is None:
    b = pyogrio.read_bounds(str(osm.PBF_PATH), layer="lines")[1]
    have = (float(b[0].min()), float(b[1].min()), float(b[2].max()), float(b[3].max()))
    print(f"  extract {osm.PBF_PATH.name} carries no header bbox; scanned for it")
print(f"  extract {osm.PBF_PATH.name}: lon {have[0]:.3f}..{have[2]:.3f}  lat {have[1]:.3f}..{have[3]:.3f}")
print(f"  need for {radius/1000:.1f} km:  lon {want[0]:.3f}..{want[2]:.3f}  lat {want[1]:.3f}..{want[3]:.3f}")

# A shortfall only matters where there is land to miss, and that is a question
# with an empirical answer rather than a judgement call: read a strip just
# INSIDE the extract's own edge. If the last two kilometres of data the extract
# does hold contain no roads and no buildings, then the edge is already out past
# the built-up world -- open ocean, or bush -- and extending further adds
# nothing the game would have drawn. If that strip has streets in it, the clip
# ran through a suburb and the missing ring really would come out empty.
KM = 111.0  # per degree of latitude; longitude is corrected below


def built_features(bbox):
    """Roads and buildings in a box — the only two things a clip can cut through
    that this build would have drawn. Coastline ways and water polygons are
    *expected* at an offshore boundary and say nothing about missing city, so
    counting all features would report the sea as evidence of land."""
    # The project's own reader, not `read_dataframe`: this venv has pyogrio
    # without geopandas, which is deliberate (see pipeline/pyproject.toml), and
    # `_read_layer` is what every other reader in the pipeline goes through.
    try:
        _, line_tags = osm._read_layer(osm.PBF_PATH, "lines", bbox)
        _, poly_tags = osm._read_layer(osm.PBF_PATH, "multipolygons", bbox)
    except Exception:
        return None               # unreadable is not evidence of emptiness
    roads = sum(1 for t in line_tags if t.get("highway"))
    builds = sum(1 for t in poly_tags if t.get("building"))
    return roads, builds


lon_km = KM * math.cos(math.radians(config.ORIGIN_LAT))
# ~500 m, and thin on purpose. The question is not "is there land near the
# edge" -- Sydney's coast runs close to the eastern clip and Long Reef sits
# inside two kilometres of it -- but "did the clip cut *through* anything".
# A boundary standing in empty space was drawn offshore, and what lies beyond
# it is the sea. A boundary with a street running into it was drawn through a
# suburb, and beyond it is a suburb this build would render as bare terrain.
inset = 0.005
sides = [
    ("west", want[0] < have[0] - 1e-9, (have[0], want[1], have[0] + inset, want[3]),
     abs(want[0] - have[0]) * lon_km),
    ("east", want[2] > have[2] + 1e-9, (have[2] - inset, want[1], have[2], want[3]),
     abs(want[2] - have[2]) * lon_km),
    ("south", want[1] < have[1] - 1e-9, (want[0], have[1], want[2], have[1] + inset),
     abs(want[1] - have[1]) * KM),
    ("north", want[3] > have[3] + 1e-9, (want[0], have[3] - inset, want[2], have[3]),
     abs(want[3] - have[3]) * KM),
]

blocking, benign = [], []
for name, is_short, strip, km_short in sides:
    if not is_short:
        continue
    counts = built_features(strip)
    gap = f"{name} by {km_short:.0f} km"
    if counts == (0, 0):
        benign.append(gap)
    else:
        blocking.append(f"{gap} ({counts[0]} roads, {counts[1]} buildings at the clip)"
                        if counts else f"{gap} (could not read the edge)")

for gap in benign:
    print(f"\n  extract stops short {gap}, but its own edge there carries no road")
    print("  and no building -- the clip was drawn offshore, so what lies beyond")
    print("  it is water. Nothing the build would have rendered is missing.")
if blocking:
    print("\n  the OSM extract does not reach this radius: " + ", ".join(blocking))
    print("  There is mapped data right up to the clip on that side, so the new")
    print("  ring would come out with terrain and no city. Fetch a wider extract")
    print("  (Geofabrik australia-oceania, clipped) before building.")
    sys.exit(1)

# The test above is negative -- it can only object. That was enough while the
# bounds came from the header, which a clipper writes tight around what it kept.
# A *scanned* bound is a different animal: one ferry route, power line or
# boundary way running to Cape York puts the extract's nominal edge 2,000 km out
# while the city data stops at Parramatta, and every shortfall test then passes
# vacuously. So ask the positive question too, and print the answer rather than
# judging it -- is there a city at the far edge of the radius being built?
print("\n  coverage at the edge of the requested radius:")
for name, strip in (
    ("west", (want[0], want[1], want[0] + inset, want[3])),
    ("east", (want[2] - inset, want[1], want[2], want[3])),
    ("south", (want[0], want[1], want[2], want[1] + inset)),
    ("north", (want[0], want[3] - inset, want[2], want[3])),
):
    counts = built_features(strip)
    if counts is None:
        print(f"    {name:5} unreadable")
    else:
        print(f"    {name:5} {counts[0]:>6,} roads  {counts[1]:>7,} buildings")

# Rough disk: the shipped 15.3 km world is 2.9 GB of tiles + region bundles, and
# it scales with area. Free space is checked against three copies, because the
# vite build and the precompress sidecars each make one.
grew = (radius / 15_300.0) ** 2
est = 2.9 * grew
free = shutil.disk_usage(config.OUT_ROOT.parent).free / 1e9
print(f"\n  estimated world {est:.1f} GB; free here {free:.0f} GB "
      f"(a deploy wants about {est * 2.4:.0f} GB all up)")
if free < est * 2.4:
    sys.exit("  not enough disk for the build plus its dist copy and sidecars")
PY

echo
echo "== setting stage '$STAGE' to $RADIUS m"
uv run python - "$RADIUS" "$STAGE" <<'PY'
import re, sys, pathlib
radius, stage = int(sys.argv[1]), sys.argv[2]
path = pathlib.Path("sydney/config.py")
src = path.read_text()
pattern = re.compile(rf'(Stage\(\s*\d+\s*,\s*"{re.escape(stage)}"\s*,\s*)([\d_]+)')
match = pattern.search(src)
if not match:
    sys.exit(f"could not find the {stage!r} Stage line in config.py")
was = int(match.group(2).replace("_", ""))
if was == radius:
    print(f"  already {radius} m, unchanged")
else:
    path.write_text(pattern.sub(lambda m: f"{m.group(1)}{radius:_}", src, count=1))
    print(f"  {was:_} -> {radius:_} m")
PY

echo
echo "== building (rebuild + retile: the radius moved, so the building table must too)"
START=$(date +%s)
uv run python -m sydney build --stage "$STAGE" --rebuild --retile
echo "  build took $(( ($(date +%s) - START) / 60 )) min"

echo
# The segments. A pure repack of what the build just wrote -- no retile, a
# second or two -- producing `root.json` and `world/hexes/<id>.{json,names.bin,
# far.bin}`, which is what a segmented client boots from and what
# `publish-world-r2.sh --hex` uploads a piece at a time. It runs on every build
# because the manifests are derived from `index.json`: a world rebuilt without
# it would serve last build's tile lists against this build's tiles, and every
# hexagon's `?v=` would name geometry that had moved. See `sydney/hexes.py`.
echo "== segmenting into hexagons"
uv run python -m sydney hex-pack

echo
echo "== audits"
FAILED=""
for audit in winding-audit road-grade-audit carriageway-audit vegetation-audit \
             water-audit landmark-audit lane-audit; do
  if uv run python -m sydney "$audit" > /tmp/sydney-audit.log 2>&1; then
    printf '  %-20s pass\n' "$audit"
  else
    code=$?
    # Three-valued on purpose: 1 is a verdict, 2 is "this audit could not tell
    # you" (a crash, an unreadable format). They are not the same news.
    case $code in
      2) printf '  %-20s UNRESOLVED — it could not read the world\n' "$audit" ;;
      *) printf '  %-20s FAIL\n' "$audit" ;;
    esac
    tail -3 /tmp/sydney-audit.log | sed 's/^/      /'
    FAILED="$FAILED $audit"
  fi
done
[ -z "$FAILED" ] || { echo; echo "audits failed:$FAILED — not publishing"; exit 1; }

echo
if [ "$PUBLISH" = yes ]; then
  echo "== publishing to the CDN"
  sh "$ROOT/scripts/publish-world.sh"
else
  echo "== skipping publish (--no-publish)"
fi

echo
echo "== done. Still to do, in this order:"
echo "   1. re-bake the anchor tables for the new ring — they are curated by hand"
echo "      and everything past the OLD radius currently has no police stations,"
echo "      no pubs, no parks and no suburb weights:"
echo "        client/src/game/factions.ts    police stations + beat weights"
echo "        client/src/game/streetlife.ts  pubs, suburb crime/booze weights"
echo "        client/src/game/wildlife.ts    park discs for the turkeys"
echo "   2. npm run typecheck && bun run server/integration-check.ts"
echo "   3. npm run build && scripts/precompress-dist.sh"
echo "   4. the rsync + restart in DEPLOY.md"
