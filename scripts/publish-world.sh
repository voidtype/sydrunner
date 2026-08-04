#!/bin/sh
# Publish client/public/world to the data repo, so players stream the city from
# jsDelivr's CDN instead of the origin box.
#
# WHY. oxford-tractor is a 1 GB Binary Lane box with a 20 GB/month transfer cap.
# A first visit pulls ~175 MB of city, so the cap is about a hundred first visits
# a month — the site breaks by being played. The world is 3,928 immutable files,
# identical for every player and already versioned, which makes it a static asset
# problem; this moves it to someone else's bandwidth.
#
# WHY NOT GITHUB RELEASES, which is where this started. **Release assets carry no
# CORS header.** A download redirects to release-assets.githubusercontent.com,
# whose 200 has no `access-control-allow-origin` at all, so a browser fetch fails
# and `{mode:'no-cors'}` returns an unreadable opaque response. Releases are also
# capped at 1000 assets and rate-limit hard on bulk upload. jsDelivr serves the
# git tree with `access-control-allow-origin: *` and a year-long immutable cache,
# and a git push is not subject to the REST API rate limit.
#
# WHY THE FILES ARE NOT GZIPPED, which is the one surprise here. jsDelivr
# brotli-compresses on the fly, and measured against a real tile it beats a
# pre-gzipped copy — because the browser negotiates br where a `.gz` file can
# only be served as opaque bytes:
#
#     tiles/-10_-1.glb   raw 1,921,940   br 540,716   .gz 597,683   (br 9.5% less)
#
# GLB is 97% of the world by bytes, so storing raw saves ~17 MB of a ~192 MB
# first visit. It also deletes a whole layer of client code: no
# `DecompressionStream`, no feature detection, no engine that cannot inflate —
# `Content-Encoding` is the browser's job and it is transparent to `fetch`. The
# files also arrive with honest content types (`model/gltf-binary`).
#
# ONE COMMIT, EVER. The branch is rebuilt from scratch each publish, so it always
# holds exactly one commit and the repo never accumulates history — a world
# rebuild would otherwise add ~600 MB to it forever. Old builds survive as tags,
# and only the last two are kept: a client on an older index lives for one
# session, and two builds is ~400 MB of repo.
#
# THE REF IS A COMMIT SHA, not the tag. jsDelivr caches `@<sha>` immutably and
# forever, where a tag is a moving target it has to revalidate. The SHA is
# stamped into the ORIGIN's index.json as `cdn.ref` — see `stamp` below.
#
# Usage:  scripts/publish-world.sh [--dry-run]

set -eu

DATA_REPO="voidtype/sydrunner-world"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="$ROOT/client/public/world"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1

command -v git >/dev/null || { echo "git not installed" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not installed" >&2; exit 1; }
[ -f "$WORLD/index.json" ] || { echo "no index.json in $WORLD" >&2; exit 1; }

BUILT=$(jq -r '.built // empty' "$WORLD/index.json")
[ -n "$BUILT" ] || { echo "index.json has no 'built' stamp — rebuild the world" >&2; exit 1; }
TAG="world-$BUILT"

WORK="${SYDNEY_PUBLISH_WORK:-${TMPDIR:-/tmp}/sydney-world-pub-$BUILT}"
FILES=$(find "$WORLD" -type f ! -name '.*' | wc -l | tr -d ' ')
BYTES=$(find "$WORLD" -type f ! -name '.*' -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')

echo "world   $WORLD"
echo "built   $BUILT  ->  tag $TAG"
echo "files   $FILES  ($((BYTES / 1048576)) MB raw)"
echo "repo    $DATA_REPO"

if [ -n "$DRY" ]; then
  echo "dry run: would publish $FILES files to $DATA_REPO and tag $TAG"
  exit 0
fi

# ---------------------------------------------------------------------------
# Build the tree. A fresh `git init` rather than `checkout --orphan`, because
# "one commit" is then true by construction instead of by discipline.
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
git init -q -b main
git config user.name "voidtype"
git config user.email "voidtype@users.noreply.github.com"

echo "copying world..."
# Real paths, no flattening: this is a git tree, so `tiles/-5_9.glb` is just
# `tiles/-5_9.glb` and the client's URL builder is a concatenation.
rsync -a --exclude '.*' "$WORLD/" "$WORK/"

cat > "$WORK/README.md" <<EOF
# SYDNEY — world data

Processed world data for [SYDNEY](https://github.com/voidtype/sydrunner), a
browser-based multiplayer FPS set in a geometrically accurate Greater Sydney.
This repository is the distribution point for that build's city: $FILES files of
glTF tiles, collision, terrain, street names and water, streamed directly by the
game client from jsDelivr. It holds exactly one commit — each publish rebuilds
the branch — and old builds survive only as tags. Nothing here is hand-authored;
everything is emitted by the pipeline in the main repository.

Build \`$BUILT\`.

## Attribution

This data is a **processed derivative** (reprojected to EPSG:7856, merged,
simplified and tiled) of the following sources, redistributed under
[ODbL](https://opendatacommons.org/licenses/odbl/):

- **Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors**, available under the
  [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
  The primary source for buildings, roads, water, parks, landmarks and streets.
- **Building footprints** are partly
  [Microsoft Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints)
  (ODbL), used to fill gaps outside the OSM-complete inner ring.
- **Terrain** derives from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen \`terrarium\`); see its
  [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
  for the per-source list.

If you redistribute this data you must carry the same attribution and share
alike under ODbL.
EOF

echo "committing $FILES files..."
git add -A
git commit -q -m "world $BUILT

Pipeline build $BUILT: $FILES files, $((BYTES / 1048576)) MB.
A processed derivative of OpenStreetMap (ODbL), Microsoft Building
Footprints (ODbL) and AWS Terrain Tiles. See README.md."

SHA=$(git rev-parse HEAD)

echo "pushing (~$((BYTES / 1048576)) MB raw, git packs it)..."
git remote add origin "https://github.com/$DATA_REPO.git"
git push -q --force origin main
git tag -f "$TAG" >/dev/null
git push -q --force origin "refs/tags/$TAG"

# ---------------------------------------------------------------------------
# Prune. Keep the newest two build tags; a client holding an older index lives
# for one session, and every kept tag pins another ~200 MB of objects.
echo "pruning old tags..."
# `head -n -2` is GNU-only; macOS ships BSD head, so the count is explicit.
KEEP=2
ALL=$(git ls-remote --tags origin 'world-*' 2>/dev/null |
        sed 's|.*refs/tags/||' | grep -v '\^{}' | sort -t- -k2 -n)
N=$(printf '%s\n' "$ALL" | grep -c . || true)
OLD=""
[ "$N" -gt "$KEEP" ] && OLD=$(printf '%s\n' "$ALL" | head -n $((N - KEEP)))
for t in $OLD; do
  echo "  dropping $t"
  git push -q --delete origin "refs/tags/$t" || true
done

# ---------------------------------------------------------------------------
# Stamp the origin's index.json with the ref the client should use.
#
# Deliberately NOT stamped into the copy that was just committed: the ref *is*
# the hash of that commit, so putting it inside would change it. index.json is
# the mutable pivot the client always reads from the origin anyway — see
# client/src/world/version.ts — which is exactly what makes this the right place
# to put a pointer at immutable data.
#
# `vite build` copies public/ into dist/, so stamping public/ is enough for any
# future build; dist/ is stamped too when it exists, so an already-built tree
# does not need rebuilding before the next rsync.
stamp() {
  [ -f "$1" ] || return 0
  python3 - "$1" "$SHA" "$DATA_REPO" <<'PY'
import json, sys
path, ref, repo = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    index = json.load(f)
index["cdn"] = {"ref": ref, "repo": repo}
with open(path, "w") as f:
    json.dump(index, f, separators=(", ", ": "))
PY
  echo "  stamped $1"
}
echo "stamping index.json..."
stamp "$WORLD/index.json"
stamp "$ROOT/client/dist/world/index.json"

echo
echo "repo    https://github.com/$DATA_REPO"
echo "ref     $SHA"
echo "tag     $TAG"
echo "files   $FILES ($BYTES bytes raw)"
echo "url     https://cdn.jsdelivr.net/gh/$DATA_REPO@$SHA/<path>"
