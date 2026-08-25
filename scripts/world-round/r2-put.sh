#!/usr/bin/env bash
# Upload one world file to R2 over the REST API. Appends OK/FAIL to $RESULTS.
# Usage: r2-put.sh <path-relative-to-$WORLD>
#
# WHY NOT WRANGLER. `upload-one.sh` spawns a node process per object, which is
# about 2.3 s each and -- far worse -- makes parallelism expensive, because each
# slot is a whole node runtime. Measured on the 2026-08-26 round it managed about
# 5 objects a second at 16 slots. This is a single curl per object: 1.1 s each
# serially and nothing to keep resident, so it parallelises to whatever the link
# takes. It uses the **same credential** wrangler does, so it needs no S3 token.
#
# TWO THINGS THAT ARE NOT OBVIOUS AND ARE BOTH LOAD-BEARING.
#
# *`Cache-Control` must be sent explicitly.* The REST PUT does not inherit it and
# does not default it -- an object uploaded without the header is served with no
# `cache-control` at all, which for a world addressed by an immutable `?v=` is a
# revalidation on every asset of every visit. Found by putting one object without
# it and reading the header back off the CDN.
#
# *The bearer never goes on a command line.* `curl -H "Authorization: ..."` puts
# the token in argv, where `ps` shows it to every process on the machine. It goes
# in a 0600 config file instead, and `$R2_CURL_CFG` names it.
set -u
key="$1"
case "$key" in
  *.glb)  ct="model/gltf-binary" ;;
  *.json) ct="application/json" ;;
  *)      ct="application/octet-stream" ;;
esac
# Pivots are re-read on every boot and must never be cached; everything else is
# addressed by `?v=<built>` and is immutable for a year. See DEPLOY.md.
case "$key" in
  index.json|root.json) cc="no-cache" ;;
  *)                    cc="public, max-age=31536000, immutable" ;;
esac
# The key is one path segment of the REST route, so its slashes are encoded.
# Nothing else in this world's key space needs it -- every key is letters,
# digits and `+ - _ . /` (`tiles/-101_19.water.bin`, `hexes/h+00+00.json`), and
# `+` is literal in a path segment rather than a space. Done with a shell
# substitution rather than a python one-liner because this runs once per object
# and a process per object is what the wrangler path was replaced for.
enc="${key//\//%2F}"
out=$(curl -s --config "$R2_CURL_CFG" -X PUT \
        -H "Content-Type: $ct" -H "Cache-Control: $cc" \
        --data-binary "@$WORLD/$key" \
        "https://api.cloudflare.com/client/v4/accounts/$R2_ACCOUNT/r2/buckets/$R2_BUCKET/objects/$enc")
case "$out" in
  *'"success":true'*) echo "OK $key" >> "$RESULTS" ;;
  *)                  echo "FAIL $key" >> "$RESULTS" ;;
esac
