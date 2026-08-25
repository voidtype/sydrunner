#!/usr/bin/env bash
# Upload a list of changed world keys to R2 with wrangler, N at a time.
#
# The driver `upload-one.sh` never had: it takes the key list on stdin or as a
# file, runs `upload-one.sh` in parallel, retries the failures once, and refuses
# to exit 0 with anything still failing. `scripts/publish-world-r2.sh` is still
# the preferred path when the S3 token works -- rclone syncs by checksum and is
# an order of magnitude faster. This is the road when that token has been rolled
# and the only credential left is the wrangler OAuth login, which was the case on
# 2026-08-25.
#
# The key list comes from `cdn-diff.py`, which compares local content against the
# ETag the CDN serves, so "changed" means changed by bytes rather than by mtime.
#
# Usage:
#   WORLD=client/public/world scripts/world-round/upload-changed.sh changed.txt [jobs]
#
# Pivots (index.json, root.json) are NOT uploaded here: they carry a different
# Cache-Control and must go last, after the payload they describe. See DEPLOY.md.
set -u
LIST="${1:?usage: upload-changed.sh <key-list> [jobs]}"
JOBS="${2:-8}"
WORLD="${WORLD:-client/public/world}"
export WORLD
HERE="$(cd "$(dirname "$0")" && pwd)"

run_round() {
  local list="$1" results="$2"
  : > "$results"
  export RESULTS="$results"
  # `xargs -P` rather than a job-control loop: it keeps exactly N in flight and
  # does not leave orphans when this script is interrupted.
  grep -vE '^(index|root)\.json$' "$list" | xargs -P "$JOBS" -I{} "$HERE/upload-one.sh" {}
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

total=$(grep -vcE '^(index|root)\.json$' "$LIST" || true)
echo "uploading $total objects, $JOBS at a time"
run_round "$LIST" "$TMP/r1"
grep '^FAIL ' "$TMP/r1" | cut -d' ' -f2- > "$TMP/failed1" || true
n1=$(wc -l < "$TMP/failed1" | tr -d ' ')
echo "  round 1: $(grep -c '^OK ' "$TMP/r1" || true) ok, $n1 failed"

if [ "$n1" -gt 0 ]; then
  echo "  retrying $n1"
  run_round "$TMP/failed1" "$TMP/r2"
  grep '^FAIL ' "$TMP/r2" | cut -d' ' -f2- > "$TMP/failed2" || true
  n2=$(wc -l < "$TMP/failed2" | tr -d ' ')
  echo "  round 2: $(grep -c '^OK ' "$TMP/r2" || true) ok, $n2 failed"
  if [ "$n2" -gt 0 ]; then
    echo "STILL FAILING:"; sed 's/^/  /' "$TMP/failed2"
    exit 1
  fi
fi
echo "all $total objects uploaded"
