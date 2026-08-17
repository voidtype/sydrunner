#!/usr/bin/env bash
# Upload one world file to R2 via wrangler (remote). Appends OK/FAIL to results.
# Usage: upload-one.sh <path-relative-to-world-dir>
#
# WHAT THIS IS. The per-object half of a partial retile's R2 publish: the driver
# loops the changed tile ids and calls this once per file, in parallel, so a
# 382-tile round pushes only the files that changed and not the 5.7 GB of
# unchanged region bundles beside them. Used for the 2026-08-17 station round
# (382 tiles, 36 hexagons); promoted from data/scratch/station-round/ so the
# next partial retile does not rediscover it.
#
# `--remote` is mandatory: without it wrangler writes to a local simulated bucket
# and reports success having sent nothing. Prove one object landed with
# `curl -sI https://world.3rp.uk/<key>` before running the bulk.
#
# `scripts/publish-world-r2.sh` is preferred when the S3 token works: it uploads
# a whole hexagon with rclone (size-and-mtime aware, so the unchanged region
# bundles are skipped by the uploader rather than by this loop) and it is the
# path DEPLOY.md's runbook names. This script is the fallback for the one file
# that rclone would not touch.
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
key="$1"
case "$key" in
  *.glb) ct="model/gltf-binary" ;;
  *.json) ct="application/json" ;;
  *.bin) ct="application/octet-stream" ;;
  *) ct="application/octet-stream" ;;
esac
if npx --yes wrangler@latest r2 object put "sydrunner-world/$key" --file "$WORLD/$key" --remote --content-type "$ct" --cache-control "public, max-age=31536000, immutable" >/dev/null 2>&1; then
  echo "OK $key" >> "$RESULTS"
else
  echo "FAIL $key" >> "$RESULTS"
fi
