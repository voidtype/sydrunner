#!/bin/sh
# Precompress everything in client/dist that a browser will fetch, so Caddy's
# `file_server { precompressed zstd br }` serves compressed bytes with zero
# per-request CPU. Run after `npm run build`, before the dist rsync (DEPLOY.md).
#
# Why both codecs: zstd is the best ratio the modern Chromium/Firefox line
# accepts; Safari takes brotli. Everyone else falls back to identity, which is
# just the original file. gzip sidecars are deliberately not generated — no
# current browser needs them over HTTPS once br exists.
#
# Measured on a representative tile GLB (2026-08-04): raw 1,921,940 B,
# zstd -19 422,342 B (4.55x), brotli -9 436,863 B (4.4x). The world is mostly
# tile GLBs, so this takes ~650 MB of first-visit streaming to roughly 200 MB.
#
# Sidecars are skipped when newer than their source, so re-runs after an
# incremental rebuild only touch what changed. `vite build` clears dist, which
# makes a full re-run after a full build the expected (and correct) cost.
#
# The path is passed as $1 rather than substituted into the command string,
# because macOS's xargs assembles the whole command line and -I{} overflows it
# on a large tree ("xargs: command line cannot be assembled, too long") while
# -n 1 keeps the line fixed no matter how many files there are.

set -eu
DIST="$(cd "$(dirname "$0")/../client/dist" && pwd)"

find "$DIST" -type f \
  \( -name '*.glb' -o -name '*.bin' -o -name '*.json' -o -name '*.js' \
     -o -name '*.css' -o -name '*.html' -o -name '*.wav' \) \
  -print0 |
xargs -0 -P 8 -n 1 sh -c 'f="$1"; [ -e "$f.zst" ] && [ "$f.zst" -nt "$f" ] || zstd -19 -T1 -q -f "$f" -o "$f.zst"; [ -e "$f.br" ] && [ "$f.br" -nt "$f" ] || brotli -q 9 -f "$f" -o "$f.br"' _

orig=$(find "$DIST" -type f ! -name '*.zst' ! -name '*.br' -exec stat -f%z {} + | awk '{s+=$1} END {print s}')
zst=$(find "$DIST" -type f -name '*.zst' -exec stat -f%z {} + | awk '{s+=$1} END {print s}')
echo "precompressed: $((orig / 1048576)) MB raw -> $((zst / 1048576)) MB zstd sidecars"
