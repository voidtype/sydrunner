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

# Which per-object uploader. `r2-put.sh` is a single curl against the R2 REST API
# using the **same** wrangler OAuth grant, and it is preferred for one measured
# reason: `upload-one.sh` spawns a node process per object, which held the
# 2026-08-26 round to about 5 objects a second at 16 slots, where curl does the
# same work with nothing resident. The wrangler path stays for a machine with no
# wrangler login file to read.
#
# The bearer is lifted out of wrangler's own config into a 0600 curl config, so
# it never appears in a command line where `ps` would show it to the machine.
R2_ACCOUNT="${R2_ACCOUNT:-b7f27f4a44cf2aea00155a84949b3879}"
R2_BUCKET="${R2_BUCKET:-sydrunner-world}"
export R2_ACCOUNT R2_BUCKET
WRANGLER_CFG="${WRANGLER_CFG:-$HOME/Library/Preferences/.wrangler/config/default.toml}"
PUTTER="$HERE/upload-one.sh"
if [ -f "$WRANGLER_CFG" ] && command -v curl >/dev/null 2>&1; then
  R2_CURL_CFG="$(mktemp)"
  chmod 600 "$R2_CURL_CFG"
  awk -F'"' '/^oauth_token/ {print "header = \"Authorization: Bearer " $2 "\""; exit}' "$WRANGLER_CFG" > "$R2_CURL_CFG"
  if [ -s "$R2_CURL_CFG" ]; then
    export R2_CURL_CFG
    PUTTER="$HERE/r2-put.sh"
  else
    rm -f "$R2_CURL_CFG"
  fi
fi
export PUTTER
echo "putter   $(basename "$PUTTER")"

run_round() {
  local list="$1" results="$2"
  : > "$results"
  export RESULTS="$results"
  # `xargs -P` rather than a job-control loop: it keeps exactly N in flight and
  # does not leave orphans when this script is interrupted.
  # Invoked through `bash` rather than as an executable, because a lost +x bit
  # made xargs print "Permission denied" per key and produced neither an OK nor a
  # FAIL line -- which the count below then read as "nothing failed".
  grep -vE '^(index|root)\.json$' "$list" | xargs -P "$JOBS" -I{} bash "$PUTTER" {}
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${R2_CURL_CFG:-}" ] && rm -f "$R2_CURL_CFG"' EXIT

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
# Counted against the input rather than against the absence of failures. The
# first version asserted "no FAIL lines", which is also true when nothing ran at
# all -- and that is exactly what happened the first time this was used.
ok=$(cat "$TMP"/r?  2>/dev/null | grep -c '^OK ' || true)
if [ "$ok" -ne "$total" ]; then
  echo "counted $ok OK against $total keys -- something did not run. Not declaring success."
  exit 1
fi
echo "all $total objects uploaded"
