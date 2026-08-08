#!/bin/sh
# Shared by both publish scripts: refresh the compressed copies of a file that
# was just rewritten in place.
#
# WHY THIS EXISTS. Caddy serves `file_server { precompressed zstd br }`, so a
# request advertising `accept-encoding: zstd` -- every current Chromium and
# Firefox -- is answered from `<file>.zst` and never touches `<file>`. Both
# publish scripts stamp the cdn block into `index.json` and `root.json` *after*
# `precompress-dist.sh` has run, because the whole point of stamping `dist/` is
# to avoid a rebuild. So the sidecars are older than the file they shadow on
# every single publish, and the origin ends up handing curl the new CDN pointer
# and real players the old one.
#
# That is not hypothetical: it shipped once. Eight `curl` fetches of
# `/world/root.json` returned the R2 base and four `fetch()` calls returned the
# jsDelivr ref, from the same URL, with different etags -- curl does not ask for
# zstd and a browser does. Players would have kept streaming from jsDelivr,
# where the hexagon manifests do not exist at all (404), silently falling back
# to the whole 851 kB index.
#
# Only extensions that already exist are regenerated. A file with no sidecar is
# served as identity bytes and needs nothing.

restamp_sidecars() {
  for _ext in zst br; do
    [ -f "$1.$_ext" ] || continue
    case $_ext in
      zst) zstd -19 -T1 -q -f "$1" -o "$1.$_ext" ;;
      br)  brotli -q 9 -f "$1" -o "$1.$_ext" ;;
    esac
    echo "    recompressed $(basename "$1").$_ext"
  done
}
