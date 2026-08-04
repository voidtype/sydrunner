#!/bin/sh
# Publish client/public/world as a GitHub release, so players stream the city
# from GitHub's CDN instead of the origin box.
#
# WHY. oxford-tractor is a 1 GB Binary Lane box with a 20 GB/month transfer cap.
# A single first visit pulls ~200 MB of precompressed city, so the cap is about
# a hundred first visits a month — the site falls over from being played. GitHub
# serves release assets from objects.githubusercontent.com with no documented
# bandwidth cap, CORS wide open, and a global edge. Origin egress after the flip
# is index.json, the JS bundle and the WebSocket: kilobytes per player.
#
# WHAT GOES UP. Every file under client/public/world, gzip -9, originals kept.
# Release assets live in a flat namespace — there are no folders — so the path
# separator is encoded as a double underscore and the client reverses it:
#
#     tiles/-5_9.glb      ->  tiles__-5_9.glb.gz
#     collision/-5_9.bin  ->  collision__-5_9.bin.gz
#     suburbs.json        ->  suburbs.json.gz
#
# `client/src/world/cdn.ts` owns the other half of that mapping, and its
# `verifyCdn` round-trips this exact encoding. If you change the separator here,
# change it there.
#
# index.json IS uploaded, for completeness — a release should be a whole world,
# not a world minus its manifest. But the client always reads index.json from
# the origin, because it is the mutable pivot that names the version everything
# else is cached under (see client/src/world/version.ts). Serving it from a
# release would pin the client to the release it is already looking at.
#
# WHY THERE ARE EIGHT RELEASES AND NOT ONE. **GitHub allows 1000 assets per
# release** ("file_count limited to 1000 assets per release"), and the inner ring
# alone is 3,928 files. So the world is sharded across eight releases:
#
#     world-<built>-s0 .. world-<built>-s7
#
# The shard is FNV-1a(asset name) mod 8, which puts 485-496 files in each — even
# enough that no shard is near the cap, with room for a world 2x this size before
# the shard count has to change. A *structural* split (tiles here, collision
# there) would have been simpler to read and useless: `tiles/` on its own is
# 3,550 files.
#
# The client computes the same hash in `client/src/world/cdn.ts` and therefore
# needs no manifest — a tile's release is a pure function of its own name. Both
# implementations are FNV-1a 32-bit over the ASCII asset name **including the
# `.gz`**, and `verifyCdn` pins six known answers from this script so the two
# cannot drift apart silently.
#
# <built> is the pipeline stamp in index.json — the same integer the client puts
# in `?v=`. So the releases a client wants are a pure function of the index it
# just read, with no lookup and no config.
#
# Usage:  scripts/publish-world-release.sh [--dry-run]
# Re-runs are safe: --clobber overwrites assets in place.

set -eu

REPO="voidtype/sydrunner"
WORLD="$(cd "$(dirname "$0")/../client/public/world" && pwd)"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1

command -v gh >/dev/null || { echo "gh not installed" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not installed" >&2; exit 1; }
[ -f "$WORLD/index.json" ] || { echo "no index.json in $WORLD" >&2; exit 1; }

BUILT=$(jq -r '.built // empty' "$WORLD/index.json")
[ -n "$BUILT" ] || { echo "index.json has no 'built' stamp — rebuild the world" >&2; exit 1; }

# Shards. Must equal SHARDS in client/src/world/cdn.ts, and changing it changes
# every asset's release — so it is a re-upload of the whole world, not a tweak.
SHARDS=8

# Staging lives outside the repo. It is a full gzipped copy of the world (~190
# MB) and is deliberately not cleaned up: a re-run after a failed upload then
# costs nothing but the upload.
STAGE="${SYDNEY_RELEASE_STAGE:-${TMPDIR:-/tmp}/sydney-world-$BUILT}"
mkdir -p "$STAGE"

echo "world  $WORLD"
echo "built  $BUILT  ->  tags world-$BUILT-s0 .. world-$BUILT-s$((SHARDS - 1))"
echo "stage  $STAGE"

# ---------------------------------------------------------------------------
# Compress. Flatten the path, gzip -9, skip anything already newer than source
# so an interrupted run resumes. -P 8 on a 10-core Mac: ~3900 files in ~90 s.
echo "compressing..."
export SYD_WORLD="$WORLD" SYD_STAGE="$STAGE"
( cd "$WORLD" && find . -type f ! -name '.*' -print ) |
  sed 's|^\./||' |
  xargs -P 8 -I{} sh -c '
    rel="{}"
    flat=$(printf "%s" "$rel" | sed "s|/|__|g")
    out="$SYD_STAGE/$flat.gz"
    [ -e "$out" ] && [ "$out" -nt "$SYD_WORLD/$rel" ] && exit 0
    gzip -9 -c "$SYD_WORLD/$rel" > "$out"
  '

COUNT=$(find "$STAGE" -type f -name '*.gz' | wc -l | tr -d ' ')
BYTES=$(find "$STAGE" -type f -name '*.gz' -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')
RAW=$(find "$WORLD" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')

if [ -n "$DRY" ]; then
  echo "dry run: $COUNT assets, $((BYTES / 1048576)) MB gz (from $((RAW / 1048576)) MB raw)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Sort the staged assets into shard lists. FNV-1a over the asset name, which is
# the same arithmetic `shardOf` does in client/src/world/cdn.ts.
echo "sharding..."
python3 - "$STAGE" "$SHARDS" <<'PY'
import os, sys
stage, shards = sys.argv[1], int(sys.argv[2])
lists = [open(os.path.join(stage, f".shard{s}.list"), "w") for s in range(shards)]
for name in sorted(os.listdir(stage)):
    if not name.endswith(".gz"):
        continue
    h = 0x811C9DC5
    for b in name.encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    lists[h % shards].write(os.path.join(stage, name) + "\n")
for f in lists:
    f.close()
PY

# ---------------------------------------------------------------------------
# One release per shard. Created once; re-runs upload into the existing one.
# Uploads go in batches of 50 -- gh takes many files per call, which amortises
# the API round-trip, and a batch that fails is cheap to retry.
export SYD_REPO="$REPO"
TOTAL=0
S=0
while [ "$S" -lt "$SHARDS" ]; do
  TAG="world-$BUILT-s$S"
  LIST="$STAGE/.shard$S.list"
  N=$(wc -l < "$LIST" | tr -d ' ')

  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "$TAG exists — uploading into it ($N assets)"
  else
    gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "\
Shard $S of $SHARDS — processed world data for SYDNEY, pipeline build \`$BUILT\`.

$N gzipped assets, fetched directly by the game client. The world is split
across \`world-$BUILT-s0\` .. \`world-$BUILT-s$((SHARDS - 1))\` because GitHub
allows 1000 assets per release and this world is $COUNT files. An asset's shard
is FNV-1a(name) mod $SHARDS; the client computes it and needs no manifest. See
\`client/src/world/cdn.ts\`.

Asset names are the world-relative path with \`/\` encoded as \`__\`, e.g.
\`tiles/-5_9.glb\` is \`tiles__-5_9.glb.gz\`.

**Attribution.** A processed derivative of map data © OpenStreetMap contributors
(ODbL), Microsoft Building Footprints (ODbL), and AWS Terrain Tiles (Mapzen
terrarium). Redistributed under [ODbL](https://opendatacommons.org/licenses/odbl/)."
  fi

  export SYD_TAG="$TAG"
  tr '\n' '\0' < "$LIST" |
    xargs -0 -n 50 sh -c '
      gh release upload "$SYD_TAG" --repo "$SYD_REPO" --clobber "$@" >/dev/null 2>&1 ||
        gh release upload "$SYD_TAG" --repo "$SYD_REPO" --clobber "$@" >&2
      printf "."
    ' _
  echo

  REMOTE=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets | length')
  echo "  $TAG: $REMOTE/$N"
  [ "$REMOTE" = "$N" ] || echo "WARNING: $TAG has $REMOTE of $N — re-run to fill gaps" >&2
  TOTAL=$((TOTAL + REMOTE))
  S=$((S + 1))
done

echo
echo "releases world-$BUILT-s0 .. world-$BUILT-s$((SHARDS - 1))"
echo "assets   $TOTAL uploaded (staged $COUNT)"
echo "bytes    $BYTES ($((BYTES / 1048576)) MB gz, from $((RAW / 1048576)) MB raw)"
echo "url      https://github.com/$REPO/releases/download/world-$BUILT-s<shard>/<name>.gz"
[ "$TOTAL" = "$COUNT" ] || echo "WARNING: total != staged — re-run to fill gaps" >&2
